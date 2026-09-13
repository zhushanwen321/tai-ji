// src/core/session-context-resolver.ts
//
// resolveSessionContext 纯函数——解析 fork/worktree 意图，返回执行上下文。
// D-014: 零副作用，零 Pi import。只返回意图，不调 forkFrom/不创建 sessionDir。

import type { ResolvedSessionContext, SessionResolveInput } from "./types.ts";
import { ForkDepthExceededError } from "./types.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";

/**
 * fork 深度硬限。export 供 session-runner 注入 LLM env block 时引用同一常量，
 * 避免硬限（拦截）与展示（`N/10`）两处 10 漂移。
 *
 * 双层护栏（互补，共享本常量）：
 *   1. resolveSessionContext 的 fork 护栏（parentForkDepth >= MAX_FORK_DEPTH → 拒）：
 *      只计 fork 链（fork=true 才递增 parentForkDepth），控 session 体积（每层 createBranchedSession）。
 *   2. SubagentService.execute 入口的通用嵌套护栏（nestingDepth > MAX_FORK_DEPTH → 拒）：
 *      经 execCtxAls 计所有 subagent 嵌套（fork + 非 fork），更严——混合链
 *      （fork→非fork→fork）下 nestingDepth >= parentForkDepth，通用护栏先生效。
 * 两者均允许深度 0..MAX_FORK_DEPTH（共 MAX+1 层），第 MAX+1 层（深度=MAX+1）被拒。
 */
export const MAX_FORK_DEPTH = 10;

/**
 * 纯函数：解析 fork/worktree 意图 → 执行上下文。
 *
 * 只返回意图（shouldFork/forkSource/effectiveCwd/sessionDir），
 * 不调 forkFrom / 不创建 sessionDir / 不 git worktree add。
 *
 * @throws {ForkDepthExceededError} fork=true 且 parentForkDepth >= 10
 */
export function resolveSessionContext(input: SessionResolveInput): ResolvedSessionContext {
  const { fork, cwd, mainCwd, mainSessionFile, parentForkDepth, agentDir, worktreePath } =
    input;

  // fork 深度检查（D-007）
  if (fork && (parentForkDepth ?? 0) >= MAX_FORK_DEPTH) {
    throw new ForkDepthExceededError(
      `fork depth ${parentForkDepth ?? 0} >= ${MAX_FORK_DEPTH}, refusing to fork`,
    );
  }

  const shouldFork = fork === true;
  const forkSource = shouldFork ? mainSessionFile : undefined;

  // [MF#5] fork 显式请求但主 session 文件不可用（session_start 未缓存）时直接抛错，
  // 不静默降级到 from-scratch——否则用户显式 fork 却得到无继承 session，且无任何告警。
  if (shouldFork && !forkSource) {
    throw new Error(
      "fork requested but main session file is unavailable " +
        "(session_start did not cache it); cannot fork without a source session",
    );
  }

  // effectiveCwd: worktree 模式用 handle.path（真实 checkout，由调用方传入），
  // 否则用显式 cwd 或 mainCwd。worktreePath 与 worktree 标志同源（都来自 WorktreeHandle），
  // 不再靠 tmpdir 拼凑，保证 effectiveCwd 与实际 checkout 严格一致。
  const effectiveCwd = worktreePath ?? (cwd ?? mainCwd);

  // sessionDir 用 mainCwd 编码（D-004: 同一主 cwd 下所有 subagent 存同一目录）
  const sessionDir = getSubagentSessionDir(agentDir, mainCwd);

  return { shouldFork, forkSource, effectiveCwd, sessionDir };
}
