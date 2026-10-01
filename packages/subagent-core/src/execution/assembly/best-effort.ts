// src/utils/best-effort.ts
//
// best-effort IO 清理的错误吞咽 helper。
//
// 用途：sidecar 写入 / worktree remove / alive marker 删除等次要 IO，失败不影响
// 主流程（session 已完成或正在收尾）。这类 catch 故意吞错——但 taste/no-silent-catch
// 规则禁止空 catch 或仅 console 的 catch。本 helper 提供一条「实质调用语句」让
// catch 合规，同时把错误记录到 debug/error 便于排查。
//
// 规则绕过原理：taste/no-silent-catch 仅检查 CatchClause 直接 body 是否为空或仅
// console 调用。本 helper 是普通函数调用（ExpressionStatement），既非空也非仅
// console，故合规。helper 函数体内部经共享 logger 路由（不裸 console）。

import { getLogger } from "../../core/logger.ts";

const logger = getLogger("subagents");

/** 错误日志级别。debug = 次要清理（默认）；error = 关键步骤但需继续后续清理。 */
export type BestEffortLevel = "debug" | "error";

/**
 * 吞咽 best-effort IO 的错误，按 level 经共享 logger 记录。
 *
 *   - debug（默认）：次要清理（sidecar/worktree/alive marker），失败属预期路径
 *   - error：关键步骤抛错但需继续后续清理（如 finalizeRecord 的 B9 链：completeLegacyClosed
 *     抛错后仍要执行 finalized/cleanup，错误需可见但不阻断）
 *
 * 错误对象优先取 message（避免打印巨大堆栈/对象），其他类型原样传入。
 */
export function bestEffort(err: unknown, context: string, level: BestEffortLevel = "debug"): void {
  const detail = err instanceof Error ? err.message : err;
  const msg = `[subagents] best-effort ${context} failed`;
  if (level === "error") {
    logger.error(msg, { detail });
  } else {
    logger.debug(msg, { detail });
  }
}

// ── [§1.4 (b)] pi 通知/条目通道 best-effort 执行 ────────────────────────────────
//
// core 不能 import `@zhushanwen/pi-ext-guards`（扩展侧包，core 消费方向非法）——
// stale 分诊在此建包内极小分类，标记值与 ext-guards 的 STALE_CTX_MARKER 同源同值
//（pi 语义断言 PS-30：会话替换后旧 runner 每个方法首行 assertActive 抛错，文案含
// "stale after session replacement"；探针随 pi 版本门禁重验，两侧值漂移会被
// ext-guards 的 pi-semantics-stale-ctx-wording 测试拦截）。

/** pi stale ctx 错误文案标记（PS-30，与 `@zhushanwen/pi-ext-guards` 的
 *  STALE_CTX_MARKER 同值；core 内极小副本，理由见上方块注释）。 */
export const PI_STALE_CTX_MARKER = "stale after session replacement";

/** 错误是否为 pi 会话替换后的 stale ctx 抛错（PS-30 文案分诊）。 */
export function isPiStaleCtxError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(PI_STALE_CTX_MARKER);
}

/** stale 类 warn 的进程级去重（「留痕一次即可，不刷屏」——替换窗内多调用点同因）。 */
let stalePiWarned = false;

function reportPiCallFailure(err: unknown, context: string): void {
  // 非 stale 失败 = 真实异常路径（不是设计内降级），每次留痕不吞。
  const detail = err instanceof Error ? err.message : String(err);
  logger.warn(`[subagents] best-effort pi call failed (${context}): ${detail}`);
}

/** stale 类留痕（warn 一次 + 进程级去重——「留痕一次即可，不刷屏」）。 */
function reportStalePiSkip(context: string): void {
  if (stalePiWarned) return;
  stalePiWarned = true;
  logger.warn(
    `[subagents] pi ctx stale after session replacement — best-effort pi call skipped (${context}); ` +
      "recovery: none required — the next session_start re-binds pi and later calls write normally " +
      "(further stale skips this process are silent)",
  );
}

/**
 * pi 通知/条目通道的 best-effort 执行：pi 不在场（null/undefined）→ no-op（与既有
 * 可选链语义一致）；调用抛错 → 分诊留痕（stale 类 warn 一次，其余 warn）且不冒泡
 * ——「stale pi 抛错不得升格为未处理 promise 拒绝」（pi rpc 模式无未处理拒绝处理器，
 * Node 默认 exit 1，见登记 §1.4）。
 *
 * 消费面 = notify-host / record-store / finalize-record / chat-rounds /
 * subagent-service 的 `pi?.` 调用点（通知面 + 条目面，全部属「失败不影响主流程判定」
 * 的旁路通道；record 终态/轮终的磁盘权威面走 journal/manifest，不经此通道）。
 *
 * `rethrowNonStale: true` 供「失败传播是设计契约、上游有自己的围栏与留痕」的写点
 * （recoverEntryOnlyOrphans 的纠偏 entry，record-access try/catch 吸收 + orphanJudged
 * 防重缓存语义依赖）：stale 类照吞（缺陷修复面），非 stale 原样上抛不吞真实异常。
 */
export function bestEffortPiCall<T>(
  pi: T | null | undefined,
  context: string,
  call: (pi: T) => void,
  opts: { rethrowNonStale?: boolean } = {},
): void {
  if (pi === null || pi === undefined) return;
  try {
    call(pi);
  } catch (err) {
    if (isPiStaleCtxError(err)) {
      reportStalePiSkip(context);
      return;
    }
    if (opts.rethrowNonStale) throw err;
    reportPiCallFailure(err, context);
  }
}
