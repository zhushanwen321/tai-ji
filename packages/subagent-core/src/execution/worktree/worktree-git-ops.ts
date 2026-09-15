// src/execution/worktree/worktree-git-ops.ts
//
// worktree git 内核纯函数（sink 设计 U5 / D5 裁决全量）。
// 设计权威源：docs/design/subagent-core-sink-design.md（已删，git 可追溯） §3.3 D5 + 错误规格表
// collectWorktreePatch 两行 + §5.4 ⛔3。
//
// 提取源：execution/worktree-manager.ts（gitRunAsync / GitRunError / SAFE_ID_RE /
// collectPatch 的 add+diff 基线机制 / cleanup 三步容错 / create 的脏树校验）。
// 本模块是 git 语义新单源；worktree-manager.ts 的同语义内联实现待其收缩单元切换
// 消费（本单元领地约束不改提取源，两处短暂并存由各自测试锚定等价）。
//
// [D5 基线锚点抽象] collectWorktreePatch 的基线二选一注入：
//   - { kind: "commit" }      内存 baseCommit（core WorktreeHandle.baseCommit，本就
//     持久化于 worktrees.json 注册表——worktree-manager.ts create() 注册路径）
//   - { kind: "anchor-file" } 宿主持久锚点文件（zsw sidecar 语义，内容 = base commit）
//
// [⛔3 两条降级路径显式化]（不做 fail-fast——任务已完成的执行工作不应因 patch
// 收集作废；也不做纯静默——静默丢已提交改动使上层拿到残缺 patch 无法察觉）：
//   ① 锚点缺失/损坏 → 显著 warn + 降级裸 diff（仅未提交改动）+ patchIncomplete: true
//   ② add 步骤失败 → 非致命继续 diff（裸 diff）+ warn + patchIncomplete: true
// 降级裸 diff 以 HEAD 为基线：较 zsw 现状 `diff <base>` 多丢已提交改动，损失面差异
// 由 patchIncomplete 留痕判断（D5 原文裁决，非等值平移）。
//
// 目录布局与孤儿判定策略留宿主（D5）；per-repo 写命令串行队列是宿主/manager 编排
// 职责，不在纯内核复刻——git index.lock 冲突瞬时态正好落降级路径②，而非内核故障。

import { execFile } from "node:child_process";

import { buildOutboundChildEnv } from "@zhushanwen/subagent-engine-sdk";
import * as fs from "node:fs";

import { getLogger } from "../../core/logger.ts";
import { bestEffort } from "../assembly/best-effort.ts";
import { DirtyWorktreeError } from "../assembly/types.ts";

const logger = getLogger("subagents");

// 默认 git 命令超时（ms），对齐提取源 worktree-manager.ts
const GIT_TIMEOUT_MS = 30_000;

/**
 * gitRun 的包装错误：message 格式与提取源 gitRunAsync 逐字一致；exitCode/stderr/
 * timedOut 为诊断属性（P-errshape 实测 Node 24：execFile 的 err.stderr 为
 * undefined——stderr 在 callback 第三参；退出码在 err.code，数字时）。
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

// recordId 白名单：字母数字下划线短横线（防路径注入；与提取源 SAFE_ID_RE 同式）
export const SAFE_ID_RE = /^[\w-]+$/;

/** recordId 是否匹配安全白名单 `^[\w-]+$`。 */
export function isSafeId(id: string): boolean {
  return SAFE_ID_RE.test(id);
}

/**
 * 断言 recordId 匹配安全白名单，不合法抛 DirtyWorktreeError（与提取源 create()
 * 的拒绝语义一致，供 manager 收缩后无缝切换）。
 *
 * @throws DirtyWorktreeError（消息含白名单说明，可操作）
 */
export function assertSafeId(id: string, label = "recordId"): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new DirtyWorktreeError(
      `${label} contains unsafe characters: "${id}" (must match ^[\\w-]+$)`,
    );
  }
}

/**
 * dirty 谓词：`git status --porcelain` 输出 trim 后非空即脏树。
 * 提取源 create() 的内联判定（「消费点自行 trim」的干净文本消费点之一）。
 */
export function isTreeDirty(statusPorcelain: string): boolean {
  return statusPorcelain.trim().length > 0;
}

/**
 * git 命令执行器。stdout 保真返回（不 trim）：diff 输出原样落盘为 patch 文件，
 * 裁掉尾换行会产出 `git apply` 拒绝的 corrupt patch（worktree-manager.ts 头注释
 * 2026-08-16 门 4 实测）。需要干净文本的消费点自行 trim。
 *
 * maxBuffer（execFile stdout 上限）：不传 = Node execFile 缺省 1MB（1024 * 1024），
 * 超限以 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 失败（reject GitRunError）。大输出命令
 * （如批量重构的大 diff）由调用方显式提高，宿主建议 32 * 1024 * 1024（对齐旧 zsw
 * 宿主 GIT_MAX_BUFFER）。以条件展开实现而非 `maxBuffer: opts.maxBuffer` 直透：
 * Node 先铺缺省再展开 options，显式 undefined 会覆盖缺省为无界（实测探针），
 * 与「不传即 1MB 缺省」相悖。
 *
 * 失败 reject GitRunError。无 per-repo 写串行（编排职责留宿主，见文件头注释）。
 */
export function gitRun(
  args: string[],
  opts: { cwd: string; timeout?: number; maxBuffer?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? GIT_TIMEOUT_MS,
        ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
        encoding: "utf-8",
        // 出站卫生（R3 MF-C，impl-plan §2.12）：同 worktree-manager.ts gitRunAsync——
        // deny 键不进 git 子进程，git hooks 后代不再可能消费 deny 键。
        env: buildOutboundChildEnv({ parentEnv: process.env }),
      },
      (err, stdout, stderr) => {
        if (err) {
          const execErr = err as Error & { code?: unknown; killed?: boolean; signal?: string };
          reject(
            new GitRunError(`git ${args[0]} failed: ${execErr.message}`, {
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
}

// ============================================================
// collectWorktreePatch（D5 统一 add + diff 基线机制）
// ============================================================

/** patch 基线锚点抽象（D5）：内存 baseCommit 或宿主持久锚点文件，二选一注入。 */
export type PatchBaselineAnchor =
  | { readonly kind: "commit"; readonly baseCommit: string }
  | { readonly kind: "anchor-file"; readonly path: string };

export interface CollectWorktreePatchOptions {
  /** worktree checkout 目录（add / diff 的 cwd）。 */
  readonly worktreePath: string;
  /** patch 输出绝对路径（须在 worktree 之外——cleanup 不会删除）。 */
  readonly patchFile: string;
  /**
   * 基线锚点。anchor-file 形态的 path 须在 worktree 之外（同 patchFile 约束）：
   * 落在 worktree 内会被本机制的 `git add -A` 一并暂存、混入 diff 产物——patch
   * 被锚点文件自身污染（路径与内容进入 patch），且该形态无任何 warn 或
   * patchIncomplete 留痕（不在 ⛔3 降级规格内，属静默污染）。
   */
  readonly anchor: PatchBaselineAnchor;
  /** git 命令超时（ms），缺省 30_000。 */
  readonly timeout?: number;
  /**
   * execFile maxBuffer（字节）＝ diff 输出上限，缺省 1MB（1024 * 1024，Node execFile
   * 缺省）。超限即 GitRunError（先经 ⛔3① git 层触发降级 warn，降级裸 diff 同样
   * 超限后原样上抛——实测形态，见 worktree-git-ops.test.ts 大 diff 用例）。批量
   * 重构等大 diff 场景宿主建议 32 * 1024 * 1024（对齐旧 zsw 宿主 GIT_MAX_BUFFER）。
   * 仅透传至产生大输出的 diff 调用（`diff --cached` 与降级裸 diff）；`add -A`
   * 等小输出命令不透传。
   */
  readonly maxBuffer?: number;
}

/**
 * patch 收集结果。`patchIncomplete` 即 ⛔3 留痕载体：true 表示 patch 相对完整
 * 机制有已知损失（丢已提交改动 / 丢新文件），宿主透传至 record/summary 的责任
 * 在姊妹文档 V6。缺省（undefined）= 完整机制产物。
 */
export interface WorktreePatchResult {
  readonly patchFile: string;
  /** true = diff 非空且写盘成功；false = 空 diff（不写文件，避免悬空路径）。 */
  readonly written: boolean;
  readonly patchIncomplete?: boolean;
}

/**
 * 收集 worktree 改动为 patch（统一 add + diff 基线机制）。
 *
 * 完整形态：`git add -A`（暂存全部改动，含未跟踪新文件）→ `git diff --cached
 * <baseline>`（暂存区 vs 基线锚点）。旧形态 `git diff HEAD <base>` 是树 vs 树对比：
 * worktree HEAD 初始即 baseCommit，子 agent 不提交时 diff 恒空 → 改动丢失（提取源
 * collectPatch [MF#2] 注释）。
 *
 * ⛔3 降级路径（均非致命、显著 warn、patchIncomplete 留痕）：
 *   ① 锚点缺失（anchor-file 不存在/不可读）、损坏（内容空白，或内容不被 git 认）
 *      → 裸 diff HEAD（仅未提交改动，丢已提交改动）。
 *   ② add 失败（如索引锁冲突瞬时态）→ 裸 diff HEAD（untracked 新文件不进 patch）。
 *      按 D5 裁决以 HEAD 为基线重定义降级形态（非 zsw `diff <base>` 等值平移），
 *      损失面差异由 patchIncomplete 留痕判断。
 *
 * 写盘失败（磁盘满/权限）不在 ⛔3 降级规格内：环境级故障不与「空 diff written=false」
 * 混淆（否则宿主把磁盘故障当无改动，patch 静默丢失），原样上抛由宿主处置。
 */
export async function collectWorktreePatch(
  opts: CollectWorktreePatchOptions,
): Promise<WorktreePatchResult> {
  const { worktreePath, patchFile, anchor } = opts;
  let patchIncomplete = false;

  // ── 基线锚点解析（⛔3 路径①的读取层：缺失 / 不可读 / 空白）──
  let baseline: string | undefined;
  if (anchor.kind === "commit") {
    const commit = anchor.baseCommit.trim();
    if (commit.length === 0) {
      patchIncomplete = true;
      logger.warn(
        "[worktree-git-ops] patch baseline anchor commit is empty, degrading to bare diff (uncommitted changes only); patch marked incomplete",
        { worktreePath },
      );
    } else {
      baseline = commit;
    }
  } else {
    try {
      const commit = fs.readFileSync(anchor.path, "utf-8").trim();
      if (commit.length === 0) {
        patchIncomplete = true;
        logger.warn(
          "[worktree-git-ops] patch baseline anchor file is empty or blank, degrading to bare diff (uncommitted changes only); patch marked incomplete",
          { worktreePath, anchorFile: anchor.path },
        );
      } else {
        baseline = commit;
      }
    } catch (err) {
      patchIncomplete = true;
      logger.warn(
        "[worktree-git-ops] patch baseline anchor file missing or unreadable, degrading to bare diff (uncommitted changes only); patch marked incomplete",
        {
          worktreePath,
          anchorFile: anchor.path,
          detail: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  // ── git add -A（统一机制第一步；⛔3 路径②：失败非致命，继续 diff）──
  let addFailed = false;
  try {
    await gitRun(["add", "-A"], { cwd: worktreePath, timeout: opts.timeout });
  } catch (err) {
    addFailed = true;
    patchIncomplete = true;
    logger.warn(
      "[worktree-git-ops] git add -A failed, continuing with bare diff (tracked uncommitted changes only); patch marked incomplete",
      {
        worktreePath,
        detail: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // ── diff 基线机制 ──
  if (baseline !== undefined && !addFailed) {
    let diff: string;
    try {
      diff = await gitRun(["diff", "--cached", baseline], {
        cwd: worktreePath,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
      });
    } catch (err) {
      // ⛔3 路径①的 git 层：锚点内容不被 git 认（损坏形态二：文件在、内容非合法
      // commit）→ 同样降级裸 diff。裸 diff 再失败 = 真 git 故障，原样上抛。
      patchIncomplete = true;
      logger.warn(
        "[worktree-git-ops] patch baseline anchor rejected by git (corrupted?), degrading to bare diff (uncommitted changes only); patch marked incomplete",
        {
          worktreePath,
          baseline,
          detail: err instanceof Error ? err.message : String(err),
        },
      );
      diff = await gitRun(["diff", "HEAD"], {
        cwd: worktreePath,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
      });
      return finishPatch(diff, patchFile, patchIncomplete);
    }
    return finishPatch(diff, patchFile, patchIncomplete);
  }

  // 降级形态（⛔3①/②）：裸 diff HEAD，仅未提交改动（add 成功时含已暂存新文件；
  // add 失败时 untracked 新文件不进 patch——两条路径损失面不同，留痕同一标记）。
  const diff = await gitRun(["diff", "HEAD"], {
    cwd: worktreePath,
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
  });
  return finishPatch(diff, patchFile, patchIncomplete);
}

/** diff 出口收敛：空 diff 不写文件（written=false，避免悬空路径）；写盘失败上抛。 */
function finishPatch(
  diff: string,
  patchFile: string,
  patchIncomplete: boolean,
): WorktreePatchResult {
  if (diff.length === 0) {
    return {
      patchFile,
      written: false,
      ...(patchIncomplete ? { patchIncomplete: true } : {}),
    };
  }
  fs.writeFileSync(patchFile, diff, "utf-8");
  return {
    patchFile,
    written: true,
    ...(patchIncomplete ? { patchIncomplete: true } : {}),
  };
}

// ============================================================
// cleanupWorktree（三步容错清理）
// ============================================================

export interface CleanupWorktreeOptions {
  /** 主仓库根目录（git -C 目标）。 */
  readonly repo: string;
  /** worktree checkout 绝对路径。 */
  readonly worktreePath: string;
  /** 分支名。 */
  readonly branch: string;
  /** 第三步宿主钩子（如 worktrees.json 注册表移除）。注册表归宿主（D5 目录布局
   *  与孤儿判定留宿主），内核经回调解耦；抛错仅 warn 不阻断（三步各自容错）。 */
  readonly onRemoved?: () => Promise<void> | void;
  /** git 命令超时（ms），缺省 30_000。 */
  readonly timeout?: number;
}

/**
 * 清理 worktree：worktree remove --force → branch -D → onRemoved 宿主钩子。
 * 三步各自独立容错——任一步失败不阻断其余（如 remove 失败仍尝试 branch -D +
 * 宿主钩子），避免单步失败导致后续资源泄漏（提取源 cleanup 的容错结构）。
 * 前两步失败 debug 留痕（best-effort 惯例）；宿主钩子失败 warn（宿主态漂移值得
 * 显著，孤儿收敛兜底在宿主 reaper/对账）。本函数永不 reject。
 */
export async function cleanupWorktree(opts: CleanupWorktreeOptions): Promise<void> {
  try {
    await gitRun(["worktree", "remove", "--force", opts.worktreePath], {
      cwd: opts.repo,
      timeout: opts.timeout,
    });
  } catch (err) {
    bestEffort(err, "worktree remove (cleanup)");
  }

  try {
    await gitRun(["branch", "-D", opts.branch], {
      cwd: opts.repo,
      timeout: opts.timeout,
    });
  } catch (err) {
    bestEffort(err, "branch delete (cleanup)");
  }

  if (opts.onRemoved) {
    try {
      await opts.onRemoved();
    } catch (err) {
      logger.warn("[worktree-git-ops] cleanup onRemoved host hook failed (worktree/branch already cleaned)", {
        branch: opts.branch,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ============================================================
// listWorktreePorcelain（原始形态输出）
// ============================================================

export interface ListWorktreePorcelainOptions {
  /** 主仓库根目录（git -C 目标）。 */
  readonly repo: string;
  /** git 命令超时（ms），缺省 30_000。 */
  readonly timeout?: number;
}

/**
 * `git worktree list --porcelain` 原始 stdout 保真返回（不 trim / 不 split / 不
 * 逐行加工）。宿主 realpath 对账依赖原始行文（zsw 的 /var→/private/var 归账）。
 * 失败 reject GitRunError（读类命令失败 = 真故障，处置策略归宿主）。
 */
export async function listWorktreePorcelain(opts: ListWorktreePorcelainOptions): Promise<string> {
  return gitRun(["worktree", "list", "--porcelain"], { cwd: opts.repo, timeout: opts.timeout });
}
