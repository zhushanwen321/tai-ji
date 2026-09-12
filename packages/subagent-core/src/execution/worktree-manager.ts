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
import { isProcessAlive } from "./alive-store.ts";
import { SPAWN_GRACE_MS,type WorktreeEntry,WorktreeRegistry } from "./worktree-registry.ts";
import { WorktreeReconciler, RECONCILE_SKIP_ESCALATION_CYCLES } from "./worktree-reconcile.ts";

// [U5] 对账子系统外移 worktree-reconcile.ts——阈值常量 re-export 保持既有消费方
//（worktree-reconcile-aging.test.ts）import 路径不变。
export { RECONCILE_SKIP_ESCALATION_CYCLES };

const logger = getLogger("subagents");

// recordId 白名单：字母数字下划线短横线
const SAFE_ID_RE = /^[\w-]+$/;

// 默认 git 命令超时（ms）
const GIT_TIMEOUT_MS = 30_000;

/** 分支名前缀（create() 生成 `pi-sub-<recordId>`）。 */
const BRANCH_PREFIX = "pi-sub-";

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
 * [U5 / §3.2.5 worktree 续聊重建] 重建结果三分（设计三失败形态的返回面；形态③
 * IO 错不走本联合——直接响亮 throw，调用方按工具错误面重试）。
 */
export type WorktreeRebuildOutcome =
  /** 重建成功（patch 已恢复或无 patch 可恢复）——handle 回填 record.worktreeHandle。 */
  | { kind: "rebuilt"; handle: WorktreeHandle }
  /**
   * 形态②：patch apply 冲突（归档期间分支已有新提交）——worktree 已重建为干净
   * 基线 + 原地续聊（transcript 仍有效，续聊资格判据不受工作区影响，不降级
   * reopen）；patchFile 留存供用户手动恢复（提示文案由调用方注入）。
   */
  | { kind: "conflict"; handle: WorktreeHandle; patchFile: string }
  /**
   * 形态①：patch 丢失或分支不存在（重建依据消亡）——降级为带历史重开
   * （同 §3.2.3 reopen 降级；调用方走摘要注入路径）。reason 供留痕。
   */
  | { kind: "degrade-reopen"; reason: string };

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
  // D5b 对账器（[U5] 组合实例——对账子系统外移 worktree-reconcile.ts，同一
  // registry + git 执行器共享，写命令 per-repo mutex 不分裂）。
  private readonly reconciler: WorktreeReconciler;

  constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.registry = new WorktreeRegistry(agentDir);
    this.reconciler = new WorktreeReconciler({
      gitRunAsync: (args, opts) => this.gitRunAsync(args, opts),
      registry: this.registry,
      agentDir,
    });
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
   * [U5 / §3.2.5 worktree 续聊重建] 归档续聊时 worktree 已按保留期回收 → 自动重建：
   * worktree add（checkout 记录的分支，分支名可由 recordId 推导 `pi-sub-<id>`）+
   * apply patch（恢复归档时落盘的未提交改动）→ 原地续聊（transcript 还在）。
   *
   * 三失败形态处置（设计写死）：
   *   ① patch 丢失（备份文件不在）或分支不存在 → 返回 degrade-reopen，调用方降级
   *      带历史重开（同 §3.2.3）；
   *   ② patch apply 冲突（归档期间分支有新提交）→ worktree 重建为干净基线 + 原地
   *      续聊（transcript 仍有效，续聊资格判据不受工作区影响）+ 返回 conflict 供
   *      调用方发用户可见提示（含 patch 备份路径）——不降级 reopen；
   *   ③ 重建自身 IO 错（git 命令失败、磁盘满等）→ GitRunError/DirtyWorktreeError
   *      响亮上抛（不静默回落，调用方按工具错误面重试）。
   *
   * repo 定位：worktree 注册表按 branch 反查（create/cleanup 登记的 repo 权威）。
   * 归档 cleanup 已移除注册表条目 → 反查落空 = 重建依据消亡，归形态①。
   *
   * 与 create() 的差异：checkout 已有分支（无 -b 新建）、主树脏不校验（重建不动
   * 主树工作区）、成功后补注册表条目（pid=0 占位——无子进程绑定，reaper 按宽限
   * 期后回收无主条目，续聊轮 spawn 后经 registerPid 补全）。
   *
   * @param recordId record id（分支名推导键，必须匹配 `^[\w-]+$`）
   * @param patchFile 归档时落盘的 patch 备份路径（record.patchFile；undefined = 无
   *        备份——干净基线重建）
   */
  async reconstruct(recordId: string, patchFile?: string): Promise<WorktreeRebuildOutcome> {
    if (!SAFE_ID_RE.test(recordId)) {
      // 形态③：非法 id 是编程错误，响亮（对齐 create 同判）。
      throw new DirtyWorktreeError(
        `recordId contains unsafe characters: "${recordId}" (must match ^[\\w-]+$)`,
      );
    }
    const branch = `${BRANCH_PREFIX}${recordId}`;
    const entry = this.registry.load().find((e) => e.branch === branch);
    if (entry === undefined) {
      // 形态①：注册表无条目（归档 cleanup 后的自然形态——cleanup 三步含注册表
      // 移除；reaper 回收同理）。repo 无从定位 = 重建依据消亡。
      return { kind: "degrade-reopen", reason: `worktree registry has no entry for ${branch}` };
    }
    const repo = entry.repo;
    // 分支存在性（形态①：分支已被外部删除）。
    try {
      await this.gitRunAsync(["rev-parse", "--verify", branch], { cwd: repo });
    } catch {
      return { kind: "degrade-reopen", reason: `branch ${branch} no longer exists in ${repo}` };
    }
    const worktreePath = entry.checkout;
    // 前置清理残留 checkout 目录（同 create——上次 remove 未删净 / 外部残留）。
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (cleanErr) {
        bestEffort(cleanErr, "pre-reconstruct checkout cleanup");
      }
    }
    const baseCommit = (await this.gitRunAsync(["rev-parse", branch], { cwd: repo })).trim();
    try {
      await this.gitRunAsync(["worktree", "add", worktreePath, branch], { cwd: repo });
    } catch {
      // checkout 元数据残留（目录被外部 rm 未 prune）→ prune 清元数据后重试一次；
      // 再失败 = 形态③（GitRunError 响亮上抛）。
      try {
        await this.gitRunAsync(["worktree", "prune"], { cwd: repo });
      } catch (pruneErr) {
        bestEffort(pruneErr, "worktree prune (reconstruct retry)");
      }
      await this.gitRunAsync(["worktree", "add", worktreePath, branch], { cwd: repo });
    }
    // 补注册表条目（pid=0 占位；add 成功后才登记，回滚对称 create MF#3——重建链
    // 后续失败不回滚 worktree/分支（分支是既有资产），仅注册表条目由 reaper 宽限
    // 期自然收敛，无需显式回滚）。
    await this.registry.add({
      repo,
      branch,
      checkout: worktreePath,
      pid: 0,
      createdAt: Date.now(),
    });
    // 软链 node_modules（复用主仓库依赖，同 create）。
    const mainNodeModules = path.join(repo, "node_modules");
    const worktreeNodeModules = path.join(worktreePath, "node_modules");
    if (fs.existsSync(mainNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      try {
        fs.symlinkSync(mainNodeModules, worktreeNodeModules);
      } catch (err) {
        bestEffort(err, "node_modules symlink (reconstruct)");
      }
    }
    const handle: WorktreeHandle = Object.freeze({
      path: worktreePath,
      branch,
      baseCommit,
      mainCwd: repo,
    });
    if (patchFile !== undefined) {
      if (!fs.existsSync(patchFile)) {
        // 形态①：patch 备份丢失（归档期被外部清理）——未提交改动不可恢复。
        return { kind: "degrade-reopen", reason: `patch backup file is gone: ${patchFile}` };
      }
      try {
        // --check 干跑探测可应用性：退出非 0 = 冲突/上下文不匹配（形态②）。
        await this.gitRunAsync(["apply", "--check", patchFile], { cwd: worktreePath });
      } catch {
        return { kind: "conflict", handle, patchFile };
      }
      // 实际应用（--check 已过，失败 = 形态③ IO 错响亮上抛）。
      await this.gitRunAsync(["apply", patchFile], { cwd: worktreePath });
    }
    return { kind: "rebuilt", handle };
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

    // D5b 双向对账（[U5] 迁 worktree-reconcile.ts 组合实例）
    await this.reconciler.scanOnce();
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
