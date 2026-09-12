// src/execution/worktree-reconcile.ts
//
// worktree 物理面 ↔ 注册表双向对账（D5b）——自 worktree-manager.ts 按变化轴拆出
//（[U5] worktree-manager 收纳重建链后超 max-lines 限；对账是独立子系统：注册表与
// tmpdir checkout / 分支物理面的周期性收敛，与创建/清理/重建的生命周期动作正交）。
//
// 对账方向：
//   方向一（注册有 → 物理无）：条目的分支与 checkout 都不存在 → 移除幻影条目；
//   方向二（物理有 → 注册无）：无活 pid 判死清理 / 唯一对应自愈补写 / 多对应保守
//   跳过（PS-12 老化升级）。
//
// 判活信号 = <agentDir>/subagents/<enc>/sessions/*.alive 中存活 pid（session-runner
// first header 写入，崩溃残留不删）——「死活判据」的物理面来源。
//
// 失败语义：对账失败仅日志不抛（旁路维护路径不阻断 session_start / scan）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bestEffort } from "./best-effort.ts";
import { getLogger } from "../core/logger.ts";
import { isProcessAlive, readAliveMarker } from "./alive-store.ts";
import { type WorktreeEntry, type WorktreeRegistry, SPAWN_GRACE_MS } from "./worktree-registry.ts";

const logger = getLogger("subagents");

/** tmpdir 下的 worktree 根目录（与 create() 的路径拼装同源）。 */
const WORKTREE_TMP_ROOT = "pi-subagents";

/** 分支名前缀（create() 生成 `pi-sub-<recordId>`）。 */
const BRANCH_PREFIX = "pi-sub-";

/**
 * 对账「歧义跳过」的老化升级阈值（PS-12 措施⑤）：同一物理残留连续 N 轮 scan
 * 仍无法建立 branch↔pid 对应 → 升级为含磁盘路径与人工清理指引的强 warn，
 * 终结「仅周期性低信息 warn、有界资源永无终局」的滞留形态。导出供测试与
 * 运维文档对齐阈值。N 是周期数不是绝对时长——scan 由 session_start 触发，
 * 频率随使用节奏，按周期计数避免与时钟假设耦合。
 */
export const RECONCILE_SKIP_ESCALATION_CYCLES = 4;

/**
 * 物理面发现的 worktree（tmpdir checkout 目录存在，无论注册表是否登记）。
 * repo 从 checkout/.git 指针文件推导（普通 repo 与 bare+worktree 均覆盖）；
 * 推导失败（.git 文件缺失/损坏）时 undefined——checkout 视为无主残留。
 */
interface PhysicalWorktree {
  /** encodeCwd(mainCwd) 段名（checkout 路径中间层）。 */
  readonly enc: string;
  /** 分支名（checkout 目录名，= pi-sub-<recordId>）。 */
  readonly branch: string;
  /** checkout 绝对路径。 */
  readonly checkout: string;
  /** 推导出的主仓库路径（.git 指针解析失败则 undefined）。 */
  readonly repo?: string;
  /** checkout 目录 mtime（对账 SPAWN_GRACE 判据的 createdAt 近似）。 */
  readonly mtimeMs: number;
}

/** 对账器的协作面（WorktreeManager 注入：git 执行器 + 注册表 + agentDir）。 */
export interface WorktreeReconcilerDeps {
  /** git 命令执行器（manager.gitRunAsync 同一实例——写命令 per-repo mutex 共享）。 */
  readonly gitRunAsync: (args: string[], opts: { cwd: string; timeout?: number }) => Promise<string>;
  /** 全局注册表（与 manager 同一实例——add/remove 直接生效）。 */
  readonly registry: WorktreeRegistry;
  /** agentDir（<agentDir>/subagents/<enc>/sessions 下扫 .alive 活信号）。 */
  readonly agentDir: string;
}

/** 对账「歧义跳过」的 per-checkout 连续计数（老化判据）。
 *  key = checkout 绝对路径；每轮 reconcileWithPhysical 末尾收敛为「本轮实际
 *  进入歧义分支」的路径集（自愈/判死清理/注册表收编/物理消失的一律清零，
 *  见 scanOnce 尾部），条目数 ≤ 单轮歧义残留数，无泄漏面。内存态：进程重启后
 *  重新起数——老化是人工介入的提醒信号，不值得为此引入持久化状态。 */
export class WorktreeReconciler {
  private readonly deps: WorktreeReconcilerDeps;
  private readonly ambiguousSkipCycles = new Map<string, number>();

  constructor(deps: WorktreeReconcilerDeps) {
    this.deps = deps;
  }

  /** 双向对账单轮（manager.scan 周期调用）。全流程幂等、失败仅日志不抛。 */
  async scanOnce(): Promise<void> {
    // 物理面发现失败（tmpdir 不可读等）→ 放弃本轮对账（失败仅日志，不阻断）
    const physical = await this.discoverPhysicalWorktrees();
    const registered = this.deps.registry.load();
    const registeredBranches = new Set(registered.map((e) => e.branch));

    // ── 方向一：注册有 → 物理无 ──
    // repo 集合 = 注册表条目 repo ∪ 物理推导 repo，per repo 查物理分支全集。
    const repos = new Set<string>(registered.map((e) => e.repo));
    for (const pt of physical) {
      if (pt.repo) repos.add(pt.repo);
    }
    const branchesByRepo = await this.listPhysicalBranches(repos);
    await this.removePhantomRegistryEntries(registered, branchesByRepo);

    // ── 方向二：物理有 → 注册无 ──
    const orphans = physical.filter((pt) => !registeredBranches.has(pt.branch));
    const ambiguousNow = await this.reconcileUnregisteredWorktrees(orphans);

    // [PS-12 措施⑤] 老化计数收敛（「出现对应后清零」）：本轮未进入歧义跳过的
    // 路径——自愈补写 / 判死清理 / 注册表收编 / 物理消失——计数删除，重现时
    // 重新起数；升级 warn 因此只在「连续无对应」时出现，不因历史陈账误触发。
    for (const checkout of [...this.ambiguousSkipCycles.keys()]) {
      if (!ambiguousNow.has(checkout)) this.ambiguousSkipCycles.delete(checkout);
    }
  }

  /** 对账方向一（注册有 → 物理无）：条目的分支与 checkout 目录都已不存在 → 条目指向
   *  幻影资源 → 移除条目（纯清账，不删任何仍存在的资源，幂等安全）。 */
  private async removePhantomRegistryEntries(
    registered: WorktreeEntry[],
    branchesByRepo: Map<string, Set<string>>,
  ): Promise<void> {
    for (const entry of registered) {
      const branches = branchesByRepo.get(entry.repo);
      // repo 分支查询失败（get undefined）→ 保守跳过：视为物理存在，不动条目。
      if (branches === undefined) continue;
      const branchGone = !branches.has(entry.branch);
      const checkoutGone = !fs.existsSync(entry.checkout);
      if (branchGone && checkoutGone) {
        logger.warn("[worktree] reconcile: registry entry has no physical worktree/branch, removing entry", {
          branch: entry.branch,
          repo: entry.repo,
          pid: entry.pid,
        });
        await this.deps.registry.remove(entry.branch);
      }
    }
  }

  /** 对账方向二（物理有 → 注册无）：按 enc 段（encodeCwd(mainCwd)）聚合，活信号 =
   *  <agentDir>/subagents/<enc>/sessions/*.alive 中存活的 pid（session-runner
   *  first header 时写入，崩溃残留不删）：
   *    - 无活 pid：残留判死，checkout mtime 超 SPAWN_GRACE_MS 才清（防误清另一
   *      进程 worktree add 完成到 registry.add 落盘之间的 create 窗口）；
   *    - 恰好 1 个活 pid 且恰好 1 个残留：补写回注册表（自愈——最常见的双 session
   *      并发覆盖丢条目场景，补写后回归标准 pid 判据路径）；
   *    - 多活 pid 或多残留无法建立 branch↔pid 对应：跳过 + warn——宁延迟勿误删；
   *      活体自身 cleanup 路径正常（registry.remove 幂等），死体等活 pid 全灭后
   *      下一周期收敛。
   *
   *  返回本轮实际进入「歧义跳过」的 checkout 路径集（PS-12 老化计数收敛依据，
   *  见 scanOnce 尾部）。 */
  private async reconcileUnregisteredWorktrees(orphans: PhysicalWorktree[]): Promise<Set<string>> {
    // 按 enc 段聚合处理（活信号以 enc 段为粒度——.alive 在 <enc>/sessions/ 下）
    const ambiguous = new Set<string>();
    const orphansByEnc = new Map<string, PhysicalWorktree[]>();
    for (const pt of orphans) {
      const list = orphansByEnc.get(pt.enc) ?? [];
      list.push(pt);
      orphansByEnc.set(pt.enc, list);
    }
    for (const [enc, list] of orphansByEnc) {
      await this.reconcileEncSegment(enc, list, ambiguous);
    }
    return ambiguous;
  }

  /** 单 enc 段的残留处置三分支：无活 pid 判死清理 / 唯一对应自愈补写 / 多对应保守跳过。 */
  private async reconcileEncSegment(
    enc: string,
    list: PhysicalWorktree[],
    ambiguous: Set<string>,
  ): Promise<void> {
    const alivePids = this.collectAlivePids(enc);
    if (alivePids.length === 0) {
      await this.cleanupDeadSegment(list);
      return;
    }
    if (alivePids.length === 1 && list.length === 1) {
      // 唯一活 pid ↔ 唯一残留：对应关系无歧义，自愈补写回注册表。
      // pid 若最终对应错误（理论上不该发生），后果是延迟清理而非误删（判活跳过）。
      const pt = list[0];
      logger.warn("[worktree] reconcile: unregistered physical worktree with one alive pid, re-registering (self-heal)", {
        branch: pt.branch,
        checkout: pt.checkout,
        repo: pt.repo,
        pid: alivePids[0],
      });
      await this.deps.registry.add({
        repo: pt.repo ?? path.dirname(pt.checkout),
        branch: pt.branch,
        checkout: pt.checkout,
        pid: alivePids[0],
        createdAt: pt.mtimeMs,
      });
      return;
    }
    // 多活 pid / 多残留：无法建立 branch↔pid 对应，保守跳过待下周期。
    // [PS-12 措施⑤] 保守跳过加老化：同一 checkout 连续 {@link
    // RECONCILE_SKIP_ESCALATION_CYCLES} 轮仍无对应 → 升级为含磁盘路径与人工
    // 清理指引的强 warn（有界资源泄漏不能永远停在低信息周期 warn 上）。计数
    // 清零由 scanOnce 统一编排——凡本轮未进入本分支的路径一律重置。
    let escalated = 0;
    for (const pt of list) {
      const cycles = (this.ambiguousSkipCycles.get(pt.checkout) ?? 0) + 1;
      this.ambiguousSkipCycles.set(pt.checkout, cycles);
      ambiguous.add(pt.checkout); // 本轮实际进入歧义跳过（老化收敛依据，见调用方）
      if (cycles < RECONCILE_SKIP_ESCALATION_CYCLES) continue;
      escalated++;
      // repo 未知（无主残留）时指引里用 <main-repo> 占位，data.repo 同步标注
      const repoHint = pt.repo ?? "<main-repo>";
      logger.warn(
        `[worktree] reconcile: unregistered physical worktree skipped for ${cycles} consecutive cycles ` +
          `(alive-pid mapping still ambiguous) — manual cleanup may be needed. ` +
          `Inspect: git -C ${repoHint} worktree list. ` +
          `If no live process owns it: git -C ${repoHint} worktree remove --force ${pt.checkout} && git -C ${repoHint} branch -D ${pt.branch}. ` +
          `Ownerless checkout (repo unknown, delete the directory directly): rm -rf ${pt.checkout}`,
        {
          branch: pt.branch,
          checkout: pt.checkout,
          repo: pt.repo,
          skippedCycles: cycles,
        },
      );
    }
    // 未达升级阈值的残留维持既有低信息聚合 warn（数量只含本周期未升级部分；
    // 全部升级时不再发本条，避免每周期双份噪音）
    if (escalated < list.length) {
      logger.warn("[worktree] reconcile: unregistered physical worktrees present but alive-pid mapping ambiguous, skipping this cycle", {
        enc,
        orphans: list.length - escalated,
        alivePids: alivePids.length,
      });
    }
  }

  /** 无活 pid 段：残留判死清理——checkout mtime 超 SPAWN_GRACE_MS 才清（防误清另一
   *  进程 worktree add 完成到 registry.add 落盘之间的 create 窗口）。 */
  private async cleanupDeadSegment(list: PhysicalWorktree[]): Promise<void> {
    for (const pt of list) {
      const age = Date.now() - pt.mtimeMs;
      if (age <= SPAWN_GRACE_MS) continue; // create 窗口（worktree add 后 add 落盘前）
      logger.warn("[worktree] reconcile: unregistered physical worktree with no alive pid, cleaning up", {
        branch: pt.branch,
        checkout: pt.checkout,
        repo: pt.repo,
        ageMs: age,
      });
      await this.cleanupPhysical(pt);
    }
  }

  /**
   * 物理面发现：扫描 <tmpdir>/pi-subagents/<enc>/<pi-sub-*> checkout 目录。
   * repo 从 checkout/.git 指针文件推导（`gitdir: <repo>/.git/worktrees/<branch>`，
   * 普通 repo 与 bare+worktree（.bare/worktrees/...）统一取 worktrees 段上两级）；
   * 推导失败（残缺 checkout）repo=undefined，由调用方按无主残留处置。
   */
  private async discoverPhysicalWorktrees(): Promise<PhysicalWorktree[]> {
    const root = path.join(os.tmpdir(), WORKTREE_TMP_ROOT);
    let encDirs: string[];
    try {
      encDirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return []; // tmpdir 根不存在（从未创建过 worktree）→ 空物理面
    }

    const result: PhysicalWorktree[] = [];
    for (const enc of encDirs) {
      let branchDirs: string[];
      try {
        branchDirs = fs.readdirSync(path.join(root, enc), { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith(BRANCH_PREFIX))
          .map((d) => d.name);
      } catch {
        continue; // 单个 enc 段不可读：跳过该段（对账失败仅影响本段收敛）
      }
      for (const branch of branchDirs) {
        const checkout = path.join(root, enc, branch);
        try {
          const mtimeMs = fs.statSync(checkout).mtimeMs;
          result.push({ enc, branch, checkout, repo: resolveRepoFromCheckout(checkout), mtimeMs });
        } catch (err) {
          bestEffort(err, "physical worktree stat (reconcile)");
        }
      }
    }
    return result;
  }

  /**
   * per repo 查物理分支全集：`git -C <repo> branch --list 'pi-sub-*' --format=%(refname:short)`。
   * 读类命令不加写锁；单 repo 失败 → map 不含该 repo（get 返回 undefined），
   * 调用方据此保守跳过该 repo 的条目判定（防把「查询失败」误判成「分支不存在」）。
   */
  private async listPhysicalBranches(repos: Set<string>): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    for (const repo of repos) {
      try {
        const out = await this.deps.gitRunAsync(
          ["branch", "--list", `${BRANCH_PREFIX}*`, "--format=%(refname:short)"],
          { cwd: repo },
        );
        const branches = new Set(
          out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(BRANCH_PREFIX)),
        );
        map.set(repo, branches);
      } catch (err) {
        bestEffort(err, `git branch --list (reconcile, repo=${repo})`);
      }
    }
    return map;
  }

  /**
   * 收集 enc 段的活 pid：<agentDir>/subagents/<enc>/sessions/*.alive 中
   * readAliveMarker 解析成功且 isProcessAlive 的 pid（去重）。
   * 崩溃残留的 .alive（pid 已死）天然过滤掉——这正是「死活判据」的物理面来源。
   */
  private collectAlivePids(enc: string): number[] {
    const sessionsDir = path.join(this.deps.agentDir, "subagents", enc, "sessions");
    let files: string[];
    try {
      files = fs.readdirSync(sessionsDir);
    } catch {
      return []; // enc 段无 sessions 目录（该 repo 从未跑过 subagent）→ 无活信号
    }
    const pids = new Set<number>();
    for (const file of files) {
      if (!file.endsWith(".alive")) continue;
      const marker = readAliveMarker(path.join(sessionsDir, file.slice(0, -".alive".length)));
      if (marker && isProcessAlive(marker.pid)) {
        pids.add(marker.pid);
      }
    }
    return [...pids];
  }

  /**
   * 清理物理残留（D5b 方向二的死体处置）：worktree remove → prune → branch -D
   * → 目录 rm 兜底，四步各自 best-effort（幂等，失败仅日志）。
   * prune 必要性：checkout 目录已不存在的 worktree，remove 会失败且 branch -D
   * 被「used by worktree」拒绝——prune 清掉缺失目录的元数据后分支才可删。
   */
  private async cleanupPhysical(pt: PhysicalWorktree): Promise<void> {
    if (pt.repo) {
      try {
        await this.deps.gitRunAsync(["worktree", "remove", "--force", pt.checkout], { cwd: pt.repo });
      } catch (err) {
        bestEffort(err, "worktree remove (reconcile)");
      }
      try {
        await this.deps.gitRunAsync(["worktree", "prune"], { cwd: pt.repo });
      } catch (err) {
        bestEffort(err, "worktree prune (reconcile)");
      }
      try {
        await this.deps.gitRunAsync(["branch", "-D", pt.branch], { cwd: pt.repo });
      } catch (err) {
        bestEffort(err, "branch delete (reconcile)");
      }
    }
    // 目录兜底：repo 未知（无主残留）或 remove 失败（元数据损坏）时直接删目录。
    // 路径在 tmpdir/pi-subagents/<enc>/pi-sub-* 下，按设计只有本扩展创建，清理安全
    // （与 create() 的前置清理同一安全边界）。
    try {
      if (fs.existsSync(pt.checkout)) {
        fs.rmSync(pt.checkout, { recursive: true, force: true });
      }
    } catch (err) {
      bestEffort(err, "checkout dir rm (reconcile)");
    }
  }
}

/** 从 checkout 目录的 .git 指针文件推导主仓库路径（D5b 对账用）。
 * worktree 的 .git 是文本文件（`gitdir: <repo>/.git/worktrees/<branch>`），
 * 普通 repo（.git）与 bare+worktree（.bare）统一取 worktrees 段上两级。
 * 解析失败（文件缺失/格式异常/路径越界）返回 undefined——调用方按无主残留处置。 */
function resolveRepoFromCheckout(checkout: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(checkout, ".git"), "utf-8").trim();
    if (!raw.startsWith("gitdir:")) return undefined;
    const gitdir = raw.slice("gitdir:".length).trim();
    // gitdir = <repo>/.git/worktrees/<branch> → 上三级 = repo root
    // （bare 时 <ws>/.bare/worktrees/<br> → <ws>，git -C <bare> 操作合法）
    const worktreesDir = path.dirname(gitdir);
    if (path.basename(worktreesDir) !== "worktrees") return undefined;
    const gitRootDir = path.dirname(worktreesDir);
    return path.dirname(gitRootDir);
  } catch {
    return undefined;
  }
}
