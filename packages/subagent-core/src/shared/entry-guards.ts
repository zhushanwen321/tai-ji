/**
 * 入口态 fail-fast 断言（Interface tool 层共用的两条入口契约）。
 *
 * 与 timer-delay.ts 的 assertSafeTimerDelay（内层防线）分层：本文件的两个断言跑在
 * **副作用链之前**——超上限的 time 值 / 超长 slug 永不进入 runWorkflow，错误带实际
 * 传入值与恢复指引（LLM 可据消息自纠）。schema 层（Type.Number 直通 / maxLength）
 * 是第一道关卡，本文件是调用方共享的运行时第二道：同一文案在两个 tool 各写一份会
 * 分叉，故收敛到 core 单点（findings g11a-F2）。
 *
 * 文案逐字与既有两处实现一致（行为契约，改动即换用户的纠错路径）。
 *
 * 层归属：Shared（无 Pi 依赖，仅 SLUG_MAX_LENGTH / MAX_TIMER_DELAY_MS 两个既有单源）。
 */

import { SLUG_MAX_LENGTH } from "../orchestration/models/types.ts";
import { MAX_TIMER_DELAY_MS } from "./timer-delay.ts";

/**
 * time 预算入口上界断言（tool 入口的 time 字段是 Type.Number 直通，无 schema 上界）。
 *
 * 超 setTimeout 安全域的值会穿透到 lifecycle 内层防线（assertSafeTimerDelay）——
 * 入口拦截让它永不进入副作用链。undefined = 未设预算（unlimited），放行。
 *
 * @throws Error 当 ms 超出 MAX_TIMER_DELAY_MS
 */
export function assertEntryTimeBudget(ms: number | undefined): void {
  if (ms !== undefined && ms > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `time budget ${ms} ms exceeds the maximum of ${MAX_TIMER_DELAY_MS} ms (~24.8 days). ` +
        `Retry with a smaller "time", or omit it for unlimited.`,
    );
  }
}

/**
 * slug 长度入口断言（schema maxLength 是第一道关卡，本函数是运行时第二道）。
 *
 * `examples` 由调用方给出（两个 tool 既有文案各自保留示例词——逐字不变），
 * 只影响文案尾巴，不影响判定。
 *
 * @throws Error 当 slug 非 undefined 且长度超出 SLUG_MAX_LENGTH
 */
export function assertSlugWithinLimit(
  slug: string | undefined,
  examples: readonly [string, string],
): void {
  if (slug !== undefined && slug.length > SLUG_MAX_LENGTH) {
    throw new Error(
      `slug exceeds ${SLUG_MAX_LENGTH} chars (got ${slug.length}). ` +
        `Shorten to a kebab-case label, e.g. "${examples[0]}", "${examples[1]}".`,
    );
  }
}
