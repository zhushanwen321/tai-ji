// src/execution/worktree-manager.ts
//
// git worktree 生命周期管理：创建、清理、patch 回传、孤儿 reaper。
//
// 设计约束：
//   - gitRunAsync 是唯一 git 命令出口，统一超时/错误包装（旧同步 gitRun 已在 phase 2 删除）
//   - gitRunAsync 输出保真（不 trim）：diff stdout 直接落盘为 patch，裁掉尾换行会让
//     `git apply` 报 corrupt patch；需要干净文本的消费点（baseCommit/status 拼接）自行 trim
//   - recordId 白名单 `^[\w-]+$` 防止路径注入
//   - clean tree 前置校验防止创建脏 worktree
//   - checkout 放 os.tmpdir()（脱离 .git/），兼容普通 repo 与 bare+worktree 结构
//   - mainCwd 存入 handle，不靠路径反推
//   - scan 遍历全局注册表按 pid 死活判孤儿（绝不删有活进程的 worktree）
//   - Object.freeze 保证 WorktreeHandle 不可变
//
// [全局注册表重构] scan 不再依赖当前 cwd 是否 git repo，改为遍历
// WorktreeRegistry（<agentDir>/subagents/worktrees.json）。判据从终态 marker
// 状态机降为 pid 死活一条——进程崩溃无人写终态时也能正确回收。
//
// [D5b 对账] scan 末尾追加双向 diff（reconcileWithPhysical）：物理面（tmpdir
// checkout 目录 + git branch --list）与注册表互相对账——注册表条目丢失（锁前
// last-write-wins 遗留 / 锁降级窗口）或物理资源被外部清掉时收敛，注册表注释
// 声称的「tmpdir + 分支对账兜底」由此成为代码。

import { execFile } from "node:child_process";

import { buildOutboundChildEnv } from "@zhushanwen/subagent-engine-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { encodeCwd } from "./path-encoding.ts";
import type { PatchResult,WorktreeHandle } from "./types.ts";
import { DirtyWorktreeError } from "./types.ts";
import { bestEffort } from "./best-effort.ts";
import { getLogger } from "../core/logger.ts";
import { isProcessAlive, readAliveMarker } from "./alive-store.ts";
import { SPAWN_GRACE_MS,type WorktreeEntry,WorktreeRegistry } from "./worktree-registry.ts";

const logger = getLogger("subagents");

// recordId 白名单：字母数字下划线短横线
const SAFE_ID_RE = /^[\w-]+$/;

// 默认 git 命令超时（ms）
const GIT_TIMEOUT_MS = 30_000;

/** tmpdir 下的 worktree 根目录（与 create() 的路径拼装保持同源）。 */
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

/**
 * gitRunAsync 的包装错误：message 格式与旧同步 gitRun 逐字一致（下游
 * DirtyWorktreeError 判定与测试 toThrow 匹配零改动）；exitCode/stderr/timedOut
 * 为新增诊断属性（探针 P-errshape 实测 Node 24：execFile 的 err.stderr 为
 * undefined——stderr 在 callback 第三参；退出码在 err.code（数字））。
 */
export class GitRunError extends Error {
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly timedOut?: boolean;

  constructor(
    message: string,
    props: { exitCode?: number; stderr?: string; timedOut?: boolean },
  ) {
    super(message);
    this.name = "GitRunError";
    this.exitCode = props.exitCode;
    this.stderr = props.stderr;
    this.timedOut = props.timedOut;
  }
}

/**
 * 写类 git 命令判定（per-repo mutex 串行对象）。读类（status/rev-parse/diff/branch --list）
 * 无副作用不加锁——并发读 git 自身安全，P-lock 实测冲突仅是写窗口假设。
 */
function isWriteCommand(args: string[]): boolean {
  if (args[0] === "worktree") return args[1] === "add" || args[1] === "remove" || args[1] === "prune";
  if (args[0] === "branch") return args[1] === "-D";
  return args[0] === "add";
}

/**
 * 从 checkout 目录的 .git 指针文件推导主仓库路径（D5b 对账用）。
 * worktree 的 .git 是文本文件（`gitdir: <repo>/.git/worktrees/<branch>`），
 * 普通 repo（.git）与 bare+worktree（.bare）统一取 worktrees 段上两级。
 * 解析失败（文件缺失/格式异常/路径越界）返回 undefined——调用方按无主残留处置。
 */
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

export class WorktreeManager {
  // 全局注册表：跨 repo 记录所有活 worktree，reaper 遍历此表判孤儿。
  private readonly registry: WorktreeRegistry;
  // agentDir（<agentDir>/subagents/<enc>/sessions 下扫 .alive 活信号，D5b 对账用）
  private readonly agentDir: string;
  // per-repo 写命令串行队列：value = 队尾（已吞 rejection 的）Promise。
  // 入队形态 prev.catch(()=>{}).then(run)——后继只关心「自己已排队」，
  // 不继承前驱错误（否则 1 个 worktree add 失败会传染同 repo 后续全部写命令，
  // 替代旧同步版单线程天然全局串行的「各命令独立失败」语义）。
  private readonly writeQueues = new Map<string, Promise<void>>();
  // [PS-12 措施⑤] 对账歧义跳过的 per-checkout 连续计数（老化判据）。
  // key = checkout 绝对路径；每轮 reconcileWithPhysical 末尾收敛为「本轮实际
  // 进入歧义分支」的路径集（自愈/判死清理/注册表收编/物理消失的一律清零，
  // 见该方法尾部），条目数 ≤ 单轮歧义残留数，无泄漏面。内存态：进程重启后
  // 重新起数——老化是人工介入的提醒信号，不值得为此引入持久化状态。
  private readonly ambiguousSkipCycles = new Map<string, number>();

  constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.registry = new WorktreeRegistry(agentDir);
  }

  /**
   * 为子 agent 创建隔离 worktree。
   *
   * @param mainCwd 主仓库根目录
   * @param recordId 执行记录 ID（必须匹配 `^[\w-]+$`）
   * @returns 冻结的 WorktreeHandle
   */
  async create(mainCwd: string, recordId: string): Promise<WorktreeHandle> {
    if (!SAFE_ID_RE.test(recordId)) {
      throw new DirtyWorktreeError(
        `recordId contains unsafe characters: "${recordId}" (must match ^[\\w-]+$)`,
      );
    }

    // 脏树校验与 base commit 并行（读类无锁可并发）。allSettled 而非 all：
    // status 先 reject 时 all 会短路，rev-parse 的后续 rejection 无人处理 →
    // unhandledRejection。判定顺序固定：status 错误 → 脏树 → rev-parse 错误
    // （脏树语义不变：仍先于 worktree add，rev-parse 结果在脏树时被丢弃）。
    const [statusR, revR] = await Promise.allSettled([
      this.gitRunAsync(["status", "--porcelain"], { cwd: mainCwd }),
      this.gitRunAsync(["rev-parse", "HEAD"], { cwd: mainCwd }),
    ]);
    if (statusR.status === "rejected") throw statusR.reason;
    // 消费点自行 trim：gitRunAsync 返回原始 stdout（保真），status 输出以 \n 结尾
    const statusText = statusR.value.trim();
    if (statusText.length > 0) {
      throw new DirtyWorktreeError(
        `Working tree is dirty in ${mainCwd}:\n${statusText}`,
      );
    }
    if (revR.status === "rejected") throw revR.reason;
    // 消费点自行 trim：rev-parse 输出 "hash\n"，不 trim 会把换行带进后续 git args
    const baseCommit = revR.value.trim();

    const branch = `pi-sub-${recordId}`;
    // checkout 放 tmpdir，脱离 .git/ 目录结构。
    // 这样 git 自行把元数据注册到 <commonDir>/worktrees/<branch>/，
    // 普通repo（.git/worktrees）与 bare+worktree（.bare/worktrees）都能正确工作。
    // [MF3] 按 encodeCwd(mainCwd) 作用域——消除不同 repo / 不同 session 并发跑 sync
    // fork subagent 时落到同一 /tmp/pi-sub-run-1 的冲突（recordId 是 per-session 自增，无 repo 作用域）。
    const worktreePath = path.join(os.tmpdir(), "pi-subagents", encodeCwd(mainCwd), branch);

    // 前置清理残留 checkout 目录：上次 create 的 MF#3 回滚可能因目录非空未删干净 tmpdir，
    // 或跨进程竞态。路径在 tmpdir/pi-subagents/<enc>/<branch> 下，按设计只有本扩展创建，清理安全。
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (cleanErr) {
        bestEffort(cleanErr, "pre-create checkout cleanup");
      }
    }

    await this.gitRunAsync(["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
      cwd: mainCwd,
    });

    // 注册到全局表（pid=0 占位）。runSpawn 在 spawn() 返回后异步补 pid。
    // 放在 worktree add 成功后、symlink 前——确保只有真正创建了 worktree 才登记。
    await this.registry.add({
      repo: mainCwd,
      branch,
      checkout: worktreePath,
      pid: 0,
      createdAt: Date.now(),
    });

    // [MF#3] worktree+分支+注册表条目已落盘，后续步骤（symlink）抛错时必须全部回滚，
    // 否则 worktree+分支永久泄漏。create 后所有步骤包 try/catch。
    try {
      // 软链 node_modules（复用主仓库依赖）
      const mainNodeModules = path.join(mainCwd, "node_modules");
      const worktreeNodeModules = path.join(worktreePath, "node_modules");
      if (fs.existsSync(mainNodeModules) && !fs.existsSync(worktreeNodeModules)) {
        fs.symlinkSync(mainNodeModules, worktreeNodeModules);
      }

      return Object.freeze({
        path: worktreePath,
        branch,
        baseCommit,
        mainCwd,
      });
    } catch (err) {
      // 回滚已创建的 worktree+分支+注册表条目，best-effort 吞清理异常（原始 err 仍外抛）
      try {
        await this.gitRunAsync(["worktree", "remove", "--force", worktreePath], { cwd: mainCwd });
      } catch (cleanErr) {
        bestEffort(cleanErr, "worktree remove (create rollback MF#3)");
      }
      try {
        await this.gitRunAsync(["branch", "-D", branch], { cwd: mainCwd });
      } catch (cleanErr) {
        bestEffort(cleanErr, "branch delete (create rollback MF#3)");
      }
      await this.registry.remove(branch);
      throw err;
    }
  }

  /**
   * 注册子进程 pid（runSpawn spawn() 返回后调）。
   * create 时 pid 未知写 0 占位，子进程 spawn 返回后（child.pid 同步可得）由此补全。
   * reaper 据 pid 死活判孤儿，pid=0 条目用 SPAWN_GRACE 宽限。
   * sessionFile 可选补全：传入时填入 registry entry（reaper 据 pid 死活判孤儿，不读本字段；保留供诊断）。
   *
   * [D5a] async 化：pid 补全走跨进程锁内 RMW（互斥窗口消除 updatePid 与并发 add/remove
   * 的交错）。永不 reject（锁降级 + best-effort save 均内部兜底），调用方可安全
   * fire-and-forget（session-runner 的 stdout data 回调上下文）。
   */
  async registerPid(branch: string, pid: number, sessionFile?: string): Promise<void> {
    await this.registry.updatePid(branch, pid, sessionFile);
  }

  /**
   * 清理 worktree：git worktree remove --force + git branch -D + 注册表移除。
   * 三步各自独立 try/catch——任一步失败不阻断其余（如 remove 失败仍尝试 branch -D + 注册表移除），
   * 避免单步失败导致后续资源泄漏。
   *
   * @param handle 要清理的 worktree handle（含 mainCwd，不靠路径反推）
   */
  async cleanup(handle: WorktreeHandle): Promise<void> {
    try {
      await this.gitRunAsync(["worktree", "remove", "--force", handle.path], {
        cwd: handle.mainCwd,
      });
    } catch (err) {
      bestEffort(err, "worktree remove (cleanup)");
    }

    try {
      await this.gitRunAsync(["branch", "-D", handle.branch], {
        cwd: handle.mainCwd,
      });
    } catch (err) {
      bestEffort(err, "branch delete (cleanup)");
    }

    await this.registry.remove(handle.branch);
  }

  /**
   * 收集 worktree 的改动为 patch。
   *
   * [MF#3] patchFile 由调用方指定（写在 worktree 之外，避免被 cleanup 删除）。
   * [MF#2] 先 git add -A 暂存全部改动（含未跟踪新文件），再 git diff --cached baseCommit
   * 对比暂存区与 base commit。旧实现 `git diff HEAD baseCommit` 是树 vs 树对比：
   * worktree HEAD 初始即 baseCommit，子 agent 不提交时 HEAD 仍 == baseCommit → diff 恒空 → 改动丢失。
   *
   * @param handle worktree handle
   * @param patchFile patch 输出路径（须在 worktree 之外）
   * @returns patch 结果（patchFile 路径 + failed/written 标记）。
   *   written=true 仅当 diff 非空且写盘成功；空 diff 或写失败均 written=false，
   *   调用方据此回填 record.patchFile，避免悬空路径（`git apply` 不存在的文件）。
   */
  async collectPatch(handle: WorktreeHandle, patchFile: string): Promise<PatchResult> {
    // git add -A：暂存全部改动（含未跟踪新文件），使后续 --cached diff 能捕获新建文件
    try {
      await this.gitRunAsync(["add", "-A"], { cwd: handle.path });
    } catch (err) {
      // add 失败不致命：继续尝试 diff，最差得到部分 diff（仅已跟踪文件的改动）
      bestEffort(err, "git add -A (collectPatch)");
    }
    const diff = await this.gitRunAsync(
      ["diff", "--cached", handle.baseCommit],
      { cwd: handle.path },
    );

    if (diff.length === 0) {
      // 无改动：不写文件，written=false（与有改动写成功区分）
      return Object.freeze({ patchFile, failed: false, written: false });
    }

    try {
      fs.writeFileSync(patchFile, diff, "utf-8");
      return Object.freeze({ patchFile, failed: false, written: true });
    } catch {
      return Object.freeze({ patchFile, failed: true, written: false });
    }
  }

  /**
   * 扫描并清理 pi-sub-* 孤儿 worktree + 物理面对账（D5b）。
   *
   * 阶段一（既有）：遍历全局注册表（<agentDir>/subagents/worktrees.json），
   * 按 pid 死活判孤儿。不依赖当前 cwd 是否 git repo——注册表里记了 repo 路径，
   * 直接 git -C <repo> 跨 repo 清理。
   *
   * 判据（唯一不删条件 = 进程还活着）：
   *   pid > 0 且 isProcessAlive(pid)   → 跳过（活进程，绝不删）
   *   pid > 0 且进程已死                → 孤儿（正常退出未 cleanup / 崩溃残留）
   *   pid == 0 且超 SPAWN_GRACE_MS      → 孤儿（create 后崩溃，pid 永未补全）
   *   pid == 0 且未超宽限               → 跳过（可能正在 spawn）
   *
   * 阶段二（D5b）：物理面（tmpdir checkout + 分支）与注册表双向 diff 收敛——
   * 兑现 worktree-registry.ts 头注释声称的「tmpdir + 分支对账兜底」。全流程
   * 幂等、失败仅日志（对账失败不阻断 session_start）。
   */
  async scan(): Promise<void> {
    const entries = this.registry.load();
    const now = Date.now();

    // 逐孤儿串行 await（保持 for 循环串行语义，防止一次 reaper 打出 N 个并发 git）
    for (const entry of entries) {
      if (!this.isOrphan(entry, now)) {
        continue;
      }
      await this.cleanupOrphan(entry);
    }

    await this.reconcileWithPhysical();
  }

  /**
   * D5b 双向 diff 对账：物理面（tmpdir checkout 目录 + git branch --list）与
   * 注册表互查，收敛三类漂移（锁消灭交错主因后，本对账兜底条目丢失/文件损坏的长尾）。
   * 方向一/方向二的完整判据见 {@link removePhantomRegistryEntries} /
   * {@link reconcileUnregisteredWorktrees}。
   */
  private async reconcileWithPhysical(): Promise<void> {
    // 物理面发现失败（tmpdir 不可读等）→ 放弃本轮对账（失败仅日志，不阻断）
    const physical = await this.discoverPhysicalWorktrees();
    const registered = this.registry.load();
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
        await this.registry.remove(entry.branch);
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
   *  见 reconcileWithPhysical 尾部）。 */
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
      await this.registry.add({
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
    // 清零由 reconcileWithPhysical 统一编排——凡本轮未进入本分支的路径一律重置。
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
        const out = await this.gitRunAsync(
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
    const sessionsDir = path.join(this.agentDir, "subagents", enc, "sessions");
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
        await this.gitRunAsync(["worktree", "remove", "--force", pt.checkout], { cwd: pt.repo });
      } catch (err) {
        bestEffort(err, "worktree remove (reconcile)");
      }
      try {
        await this.gitRunAsync(["worktree", "prune"], { cwd: pt.repo });
      } catch (err) {
        bestEffort(err, "worktree prune (reconcile)");
      }
      try {
        await this.gitRunAsync(["branch", "-D", pt.branch], { cwd: pt.repo });
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

  /**
   * 判孤儿：pid 死活为主判据。pid=0 走 SPAWN_GRACE 宽限（create→spawn 窗口）。
   */
  private isOrphan(entry: WorktreeEntry, now: number): boolean {
    if (entry.pid === 0) {
      // create→spawn 窗口：超过宽限期仍未补 pid = create 后崩溃
      const expired = now - entry.createdAt > SPAWN_GRACE_MS;
      if (expired) {
        // [worktree-reaper-fix] pid=0 超宽限 = create 后 spawn 前崩溃（或补全链路再次断链）。
        // 正常路径 spawn 返回后 pid 已同步补全，此处不应命中活 worktree；命中即诊断信号，
        // 与 updatePid 写盘失败的 warn 日志呼应（补全失败可观测闭环）。
        logger.warn(
          "[worktree] orphan reaper: pid=0 entry exceeded SPAWN_GRACE_MS, treating as orphan",
          { branch: entry.branch, checkout: entry.checkout, createdAt: entry.createdAt, now },
        );
      }
      return expired;
    }
    return !isProcessAlive(entry.pid);
  }

  /** 清理单个孤儿条目：worktree remove + branch -D + 注册表移除，三步各自 best-effort。 */
  private async cleanupOrphan(entry: WorktreeEntry): Promise<void> {
    try {
      await this.gitRunAsync(["worktree", "remove", "--force", entry.checkout], { cwd: entry.repo });
    } catch (err) {
      bestEffort(err, "worktree remove (orphan reaper)");
    }
    try {
      await this.gitRunAsync(["branch", "-D", entry.branch], { cwd: entry.repo });
    } catch (err) {
      bestEffort(err, "branch delete (orphan reaper)");
    }
    await this.registry.remove(entry.branch);
  }

  // ============================================================
  // 内部工具
  // ============================================================

  /**
   * git 命令异步执行器。与 gitRun 同一超时/错误包装约定（message 格式逐字一致），
   * 差异仅在错误属性形态（GitRunError 挂 exitCode/stderr/timedOut）。
   * 写类命令经 per-repo mutex 串行（不依赖 git 锁实现细节 + 并发限流 + 行为确定性）。
   *
   * stdout 保真返回（不 trim）：collectPatch 把 diff 输出原样落盘为 patch 文件，
   * 裁掉尾换行会产出 `git apply` 拒绝的 corrupt patch（2026-08-16 门 4 实测）。
   * 需要干净文本的消费点（baseCommit / 脏树 status 拼接）自行 trim。
   */
  private async gitRunAsync(args: string[], opts: { cwd: string; timeout?: number }): Promise<string> {
    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          "git",
          args,
          {
            cwd: opts.cwd,
            timeout: opts.timeout ?? GIT_TIMEOUT_MS,
            encoding: "utf-8",
            // 出站卫生（R3 MF-C，impl-plan §2.12）：deny 键不进 git 子进程——
            // git hooks 等后代不再可能消费生命周期标志 / WS 令牌。SDK 版缺省
            // 全量继承父 env + deny 剥除，行为差异仅 deny 键剥除。
            env: buildOutboundChildEnv({ parentEnv: process.env }),
          },
          (err, stdout, stderr) => {
            if (err) {
              const execErr = err as Error & { code?: unknown; killed?: boolean; signal?: string };
              reject(
                new GitRunError(`git ${args[0]} failed: ${execErr.message}`, {
                  // P-errshape 实测：execFile 退出码在 err.code（数字时）；超时 killed+SIGTERM
                  exitCode: typeof execErr.code === "number" ? execErr.code : undefined,
                  stderr: typeof stderr === "string" ? stderr : undefined,
                  timedOut: execErr.killed === true && execErr.signal === "SIGTERM",
                }),
              );
              return;
            }
            resolve(stdout);
          },
        );
      });

    if (!isWriteCommand(args)) return run();
    // per-repo 队列：吞前驱 rejection 后接续本命令；队尾比对自清理防 Map 泄漏
    const repo = opts.cwd;
    const prev = this.writeQueues.get(repo) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    const tail: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueues.set(repo, tail);
    void tail.finally(() => {
      if (this.writeQueues.get(repo) === tail) this.writeQueues.delete(repo);
    });
    return next;
  }
}
