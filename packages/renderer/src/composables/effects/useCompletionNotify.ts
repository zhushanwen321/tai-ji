/**
 * useCompletionNotify —— 后台 session 完成时提示音 + 未读标记。
 *
 * 挂钩 useConnection.ts routeInbound 的 message.complete 事件。
 * 为什么挂 routeInbound 而非 chat-message-effects：
 *   前端对 session 消息流的订阅是惰性的（ensureStreamSubscription 在首次 send 时建立）。
 *   挂在 chat-message-effects 会漏掉后台从未交互过的 session——
 *   恰恰是提示音最有价值的场景。routeInbound 是全局兜底层，已有 session.exited 先例。
 *
 * 触发条件：
 *   仅「后台完成」响（sid !== focusedSessionId || document.visibilityState !== 'visible'）
 *   background subagent/workflow 仍在跑时不响：守卫 hasBackgroundWork 提前 return。
 *     pi extension（pi-subagent-workflow）在 subagent 完成时用 triggerTurn:steer 续跑主 agent，
 *     最终 message.complete 到达时 background 已全 done、守卫放行——此刻才是 session 真正完成。
 *   stopReason: stop（成功）和 error（失败）都响，aborted 不响
 *   willRetry=true 不响（[retry-sound] pi auto-retry 中间失败，turn 未结束；也不标未读）——
 *     只有重试链终态（成功/重试用尽/不可重试错误）才响
 *   1s 防抖（多 session 同时完成只响一次）
 *   读取 settingsStore.system.completionSound 开关
 */
import { playSuccess, playError } from '@/composables/effects/useCompletionSound'
import { markUnread } from '@/composables/useSessionMarkers'
import { useBackgroundWork } from '@/composables/features/chat/useBackgroundWork'
import { getSettingsStore } from '@xyz-agent/core'

/** 上次播放提示音的时间戳（模块级，防抖用） */
let lastPlayTime = 0
const DEBOUNCE_MS = 1000

/**
 * 处理 session 完成事件。
 * 由 useConnection.ts routeInbound 在 message.complete 时调用。
 *
 * @param sessionId 完成的 session id
 * @param stopReason 停止原因：'stop'|'error'|'aborted'
 * @param focusedSessionId 当前焦点 session id
 * @param willRetry [retry-sound] pi auto-retry 中间失败标记（runtime 透传）：true = 本次 error
 *   是重试链中的中间失败，turn 未结束——静音且不标未读，等 pi 续跑后的终态 complete 再响。
 *   缺省/undefined（旧 runtime / 非重试终态）保持原行为。
 */
export function handleCompletion(
  sessionId: string,
  stopReason: string,
  focusedSessionId: string | null,
  willRetry?: boolean,
): void {
  // 1. 过滤 stopReason：aborted 不触发
  if (stopReason === 'aborted') return

  // 1.5 [retry-sound] pi auto-retry 中间失败不触发：error 后 pi 将自动重试（willRetry=true），
  //   此时响 error 音会在「失败→重试→成功」的 turn 里产生 error+success 双响，
  //   「3 次重试全失败」则连响 4 声 error（退避 2s/4s/8s，1s 防抖拦不住）。
  //   未读标记一并跳过：session 尚未真正结束，pi 续跑后的终态 complete 会重新走到这里。
  //   排序在 background work 守卫之前：重试窗口内不涉及 background work 判定，越早拦越好。
  if (willRetry === true) return

  // 2. background subagent/workflow 守卫：主 turn 结束但 background 任务仍在跑时不触发完成提示。
  // pi extension（pi-subagent-workflow）会在 subagent 完成时用 triggerTurn:steer 续跑主 agent，
  // 最终 message.complete 到达时 background 已全 done，此时守卫放行自然响。
  // 若此刻响，会在 subagent 还在跑时就误报「完成」（用户报告的 bug）。
  if (useBackgroundWork().hasBackgroundWork(sessionId)) return

  // 3. 判定后台完成：sid !== focusedSessionId 或页面不可见
  const isBackground = sessionId !== focusedSessionId || document.visibilityState !== 'visible'
  if (!isBackground) return

  // 4. 标记未读：能走到这里说明已通过 background work 守卫（session 真正完成），无论是否响铃都标记。
  //    守卫命中时上面已提前 return——此时 session 尚未真正完成，pi 会重触发 message.complete，故不标未读。
  markUnread(sessionId)

  // 5. 读取设置开关
  const settingsStore = getSettingsStore()
  if (settingsStore.system.value.completionSound === false) return

  // 6. 1s 防抖
  const now = Date.now()
  if (now - lastPlayTime < DEBOUNCE_MS) return
  lastPlayTime = now

  // 7. 播放提示音（读用户设置的 successSound/errorSound，空则用平台默认）
  const successName = settingsStore.system.value.successSound
  const errorName = settingsStore.system.value.errorSound
  if (stopReason === 'error') {
    void playError(errorName)
  } else {
    void playSuccess(successName)
  }
}

/**
 * useCompletionNotify composable（函数式封装）。
 * @param focusedSessionId 当前焦点 session id（Ref 或 getter）
 */
export function useCompletionNotify(focusedSessionId: () => string | null) {
  return {
    handleCompletion: (sessionId: string, stopReason: string, willRetry?: boolean) =>
      handleCompletion(sessionId, stopReason, focusedSessionId(), willRetry),
  }
}

/**
 * 测试专用：重置防抖状态。
 */
export function __resetDebounceForTest(): void {
  lastPlayTime = 0
}
