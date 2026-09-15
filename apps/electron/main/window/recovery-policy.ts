/**
 * renderer 崩溃自动恢复熔断计数器（crash-resilience §3.3 D2-③ / u3-renderer-recovery）。
 *
 * 设计语义（D2 原文）：render-process-gone 后按窗口自动 reload，熔断计数器以 windowId
 * 为键，60 秒滑动窗口内 ≤3 次；超限停自动 reload 改加载静态错误页（手动重试）；
 * 多窗口互不影响（T2 失败路径 / A3）。
 *
 * 关键取舍：
 * - **时间显式注入（nowMs 参数）而非方法内 Date.now()**：滑动窗口判定的唯一时钟源是
 *   调用方注入的 nowMs，单测无需 fake timers 即可精确构造窗口边界（本文件被 main 池
 *   vitest 收集，纯逻辑零 IO 零时钟依赖）
 * - **滑动窗口惰性衰减**：不挂 timer 主动清理，recordCrash 时剔除出窗旧记录——窗口内
 *   全部记录出窗后下一次崩溃自然回到 'reload'（「旧崩溃记录出窗后计数自然衰减恢复
 *   自动 reload」），无需显式恢复定时器；windowId 条目在 reset(windowId) 时移除
 *   （window-factory 在窗口 'closed' 时调用，防长寿进程 Map 泄漏）
 * - **多窗口隔离**：状态按 windowId 分桶（Map<string, number[]>），一个窗口熔断不改变
 *   其他窗口的判定（A3「另一窗口不受影响」的 main 侧语义）
 *
 * 消费者：window-factory.ts（render-process-gone 处理链）· test/recovery-policy.test.ts
 */

/** 单次崩溃的恢复决策：窗口内未超限继续自动 reload；超限改加载静态错误页。 */
export type RecoveryAction = 'reload' | 'show-error-page'

export interface RecoveryPolicyOptions {
  /** 滑动窗口宽度（毫秒），默认 60_000（设计 D2 定值）。 */
  windowMs?: number
  /** 窗口内允许自动 reload 的最大崩溃次数，默认 3（设计 D2「≤3 次」）。 */
  maxCrashesInWindow?: number
}

/** 默认滑动窗口 60 秒（设计 §3.3 D2 原文定值）。 */
export const DEFAULT_RECOVERY_WINDOW_MS = 60_000
/** 默认窗口内自动 reload 上限 3 次（设计 §3.3 D2 原文定值）。 */
export const DEFAULT_MAX_CRASHES_IN_WINDOW = 3

export class RecoveryPolicy {
  private readonly windowMs: number
  private readonly maxCrashesInWindow: number
  /** windowId → 窗口内崩溃时刻列表（升序无保证，判定时按窗口过滤）。 */
  private readonly crashesByWindow = new Map<string, number[]>()

  constructor(options: RecoveryPolicyOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_RECOVERY_WINDOW_MS
    this.maxCrashesInWindow = options.maxCrashesInWindow ?? DEFAULT_MAX_CRASHES_IN_WINDOW
  }

  /**
   * 记录一次崩溃并返回恢复决策。
   *
   * 窗口语义：保留 `nowMs - crashAt < windowMs` 的记录（恰好等于 windowMs 视为出窗，
   * 即窗口为左开右闭区间 (now-windowMs, now]）。记入本次后窗口内计数：
   * - ≤ maxCrashesInWindow → 'reload'（前 3 次自动恢复）
   * - > maxCrashesInWindow → 'show-error-page'（第 4 次起熔断；窗口持续内继续熔断，
   *   直至旧记录出窗计数自然衰减）
   *
   * @param windowId 窗口标识（window-factory 的 WindowManager id，熔断键）
   * @param nowMs 注入的当前时间（毫秒），唯一时钟源
   */
  recordCrash(windowId: string, nowMs: number): RecoveryAction {
    const existing = this.crashesByWindow.get(windowId) ?? []
    const inWindow = existing.filter((t) => nowMs - t < this.windowMs)
    inWindow.push(nowMs)
    this.crashesByWindow.set(windowId, inWindow)
    return inWindow.length > this.maxCrashesInWindow ? 'show-error-page' : 'reload'
  }

  /**
   * 清除某窗口的熔断计数（静态错误页「重试」成功导航回应用时调用——重置后该窗口
   * 重新获得完整自动 reload 预算；窗口 'closed' 时同样调用防 Map 泄漏）。
   */
  reset(windowId: string): void {
    this.crashesByWindow.delete(windowId)
  }
}
