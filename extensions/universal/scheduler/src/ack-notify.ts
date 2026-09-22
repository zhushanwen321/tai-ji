// ack 反馈：如实通知判定（dev-flow u-ack-fallback 单元）。
//
// 职责边界：本模块只做**纯判定**——给定落盘事实回答「要不要补发如实通知」，以及通知去重。
// 不做编排、不发通知、不碰文件系统：30s 写盘自检定时器、ctx.ui.notify 调用与 session
// 生命周期清理归 u-ack-turn 单元接线。
//
// 用户可见的失败形态只有两种（`AckNotifyReason`，见 types.ts）：覆写不可用（创建时同步）
// 与合成轮未启动（30s 自检后异步）。两者共用同一条 i18n 文案与同一级别——形态差异只影响
// **何时**发，而时机由调用点决定，故本模块不需要把时序编码进返回结构。
//
// 级别恒为 `warning`：`info` 级通知在后台会被 renderer 的 notify-toast 丢弃
// （`notify-toast.ts` 对非前台 session 的 info 不弹窗），用 `info` 等于静默撒谎。
//
// 反向撒谎禁令：e1/e2/e4/e5（真实模型已应答 ⇒ 任务其实已落盘）与 e8b（hybrid ⇒ 覆写照常
// 发生）一律不发「未写入」文案；e6（注销失败）与落盘无关，只在日志面登记。这些形态在
// 类型层就不可传入通知路径（`AckNotifyReason` 只含两种可通知形态）。

/**
 * 30s 写盘自检判定：只有「会话文件不存在 **且** 我们的 ack 轮从未启动」才判确实未落盘。
 *
 * 为什么必须带 `ackTurnStarted` 条件：慢速真实轮的应答可能跨过 30s 才落盘，此时
 * `ackTurnStarted` 已为 true 而文件尚不存在——「文件不存在」不构成未落盘证据，报了就误伤
 * 正常路径（30s 只是自检窗口，不是写盘的最后期限）。反之 ack 轮从未启动说明覆写没机会
 * 生效，文件又不存在 ⇒ 任务确实没写入，补发如实文案。
 */
export function shouldNotifyUnpersisted(input: {
  sessionFileExists: boolean
  ackTurnStarted: boolean
}): boolean {
  return !input.sessionFileExists && !input.ackTurnStarted
}

/**
 * 通知去重：同一 session 同一 taskId 只发一次。
 *
 * `key` 由调用方拼装（`${sessionFile}:${taskId}`）——本模块不持有 session/task 概念，
 * 保持纯判定。首次 `shouldNotify(key)` 返回 true 并记账，此后同键恒 false。
 * 去重是必需的：30s 自检与 session 边界两条通路可能对同一事实先后触发。
 * `clear()` 全清（session_start / session_shutdown 跨代隔离）。
 */
export function createAckNotifyDedup(): {
  shouldNotify(key: string): boolean
  clear(): void
} {
  const notified = new Set<string>()
  return {
    shouldNotify(key: string): boolean {
      if (notified.has(key)) return false
      notified.add(key)
      return true
    },
    clear(): void {
      notified.clear()
    },
  }
}
