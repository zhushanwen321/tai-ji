/**
 * setTimeout delay 安全域校验（Shared 层，无 Pi 依赖）。
 *
 * Node 的 setTimeout 对超出 32 位有符号整数上限（2^31-1 = 2147483647）的 delay
 * 会把定时器置为 **1ms**（TimerOverflowWarning 路径，实测 setTimeout(fn, 3e9) 约
 * 3ms 触发）——语义完全反转：调用方想表达的「近乎不限时」变成立即触发。对 watchdog
 * / 预算计时器而言即「刚启动就误杀」。
 *
 * 本包三个 timer 挂载/解析入口（budgetTimeMs → lifecycle.scheduleTimeBudget、
 * TAIJI_SUBAGENT_SPAWN_WATCHDOG_MS → session-runner.resolveSpawnWatchdogMs、
 * idleTimeoutMs → lifecycle-manager.armIdleTimer）统一在值流入 setTimeout 前调
 * assertSafeTimerDelay fail-fast——不静默 clamp（clamp 把配置错误变成静默语义漂移，
 * 比崩溃更难排查；用户应显式决定 clamp 到多少）。
 *
 * 层归属：Shared（orchestration 与 execution 共用，先例 schema-jsonify.ts）。
 */

/** Node setTimeout delay 的安全上限（2^31 - 1，超出的 delay 被置 1ms 立即触发）。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 校验即将流入 setTimeout 的 delay 值在安全域内，越界 fail-fast。
 *
 * 错误信息含上限值与恢复指引（建议 clamp 后重试）——不静默 clamp：调用方须显式
 * 决定 clamp 目标值（语义归属调用方，helper 不替用户做语义决定）。
 *
 * [F-3 NaN 穿透修复] 非有限数（Number.isFinite 为 false：NaN / ±Infinity）同样
 * fail-fast——旧实现只挡 `> MAX`，NaN 的 `NaN > MAX` 为 false 静默放行，
 * setTimeout(fn, NaN) 被 Node 塌缩为 1ms 立即触发（语义反转：watchdog 刚启动就误杀）。
 * 错误消息区分「非有限值」与「超出上限」两种指引，恢复动作各自可达。
 *
 * @param ms 即将作为 setTimeout delay 的毫秒值（调用方保证已过 undefined/<=0 分流；
 *   本函数只防溢出域与非有限值，0/负值的「禁用/不限」语义由各入口自行处理）
 * @param source 值的来源标识（进错误信息，定位用，如 "budgetTimeMs" / env 名）
 * @throws Error 当 ms 非有限（NaN/±Infinity）或超出 MAX_TIMER_DELAY_MS
 */
export function assertSafeTimerDelay(ms: number, source: string): void {
  if (!Number.isFinite(ms)) {
    throw new Error(
      `[subagent-workflow] ${source} = ${ms} is not a finite number (NaN/±Infinity). ` +
        "Non-finite delays collapse to 1ms in Node setTimeout and fire immediately. " +
        "Recovery: fix the upstream computation that produced this value " +
        "(e.g. guard division/parse results before passing them in) and retry.",
    );
  }
  if (ms > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `[subagent-workflow] ${source} = ${ms} exceeds the Node setTimeout limit ` +
        `(${MAX_TIMER_DELAY_MS} ms = 2^31-1); larger delays silently collapse to 1ms and fire immediately. ` +
        `Recovery: clamp the value to <= ${MAX_TIMER_DELAY_MS} (e.g. omit the option for "unlimited" ` +
        `semantics, or clamp explicitly) and retry.`,
    );
  }
}
