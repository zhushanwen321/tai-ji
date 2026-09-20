// ack 反馈：文案选择 + 失败分类 + 通知判定（dev-flow u-ack-fallback 单元）。
//
// 职责边界：本模块只做**纯分类/判定**——给定 ack 失败分类回答「要不要发通知、发哪条、什么
// 级别」。不做编排、不发通知、不碰文件系统：30s 写盘自检定时器、ctx.ui.notify 调用与
// session 生命周期清理归 u-ack-turn 单元接线。
//
// 反馈两阶段（设计 scheduler-command-path-persistence §3.3 D7）：
// - 同步（创建成功即发的既有「已创建 X」通知）不归本单元；
// - 「覆写不可用」（E8 无基座 / 显式禁用）在开窗之前就能确定 ⇒ 同步发如实文案
//   （`honest-sync`），不拖到 30s 自检；
// - 其余形态结果只有 30s 写盘自检才知道 ⇒ 仅当确实未落盘时异步补发（`honest-async`）。
//
// 级别恒为 `warning`：`info` 级通知在后台会被 renderer 的 notify-toast 丢弃
// （`notify-toast.ts` 对非前台 session 的 info 不弹窗），用 `info` 等于静默撒谎。
//
// 反向撒谎禁令：E1/E2/E4/E5（真实模型已应答 ⇒ 任务其实已落盘）与 E8b（hybrid ⇒ 覆写照常
// 发生）一律不发「未写入」文案；E6（注销失败）与落盘无关，只在日志面登记。

import { ACK_NOT_PERSISTED_KEY } from './i18n.js'
import type { AckFailureKind } from './types.js'

/**
 * 通知计划（本模块的导出契约）：
 * - `none`：不发用户可见通知（失败形态已在日志面登记，或任务其实已落盘）；
 * - `honest-sync`：开窗之前即确定的失败 ⇒ 调用方在创建反馈同一时点同步发；
 * - `honest-async`：结果待 30s 写盘自检 ⇒ 调用方仅在 `shouldNotifyUnpersisted` 为真时发。
 *
 * `messageKey` 是 i18n 词典键（来自 i18n.ts 常量，禁字面量），由调用方经 `t()` 渲染。
 */
export type AckNotifyPlan =
  | { kind: 'none' }
  | { kind: 'honest-sync'; messageKey: string; level: 'warning' }
  | { kind: 'honest-async'; messageKey: string; level: 'warning' }

/**
 * 失败分类 → 通知计划。`failure === null` = 正常路径（无失败）⇒ 不发通知。
 *
 * 分类逐条锚定设计错误规格（E1–E8b），`default` 是不可达兜底：新增 `AckFailureKind` 而漏
 * 分类时在此编译报错（`never` 赋值），而非静默落进 `none` 让新失败形态无声消失。
 */
export function planAckNotify(failure: AckFailureKind | null): AckNotifyPlan {
  switch (failure) {
    case null:
      return { kind: 'none' }

    case 'e8-no-base':
      // 覆写不可用在开窗之前即确定（会话 provider 无 builtin/config 基座）⇒ 同步如实告知。
      return { kind: 'honest-sync', messageKey: ACK_NOT_PERSISTED_KEY, level: 'warning' }

    case 'e3-no-turn':
      // 合成轮未启动 ⇒ 我们的覆写没机会生效，但用户可能同时在会话里说话而让真实轮写盘
      // ⇒ 先不报，等 30s 自检确认文件确实不存在后再补发。
      return { kind: 'honest-async', messageKey: ACK_NOT_PERSISTED_KEY, level: 'warning' }

    // 以下形态任务其实已落盘：E1/E2/E4/E5 = 真实模型已应答（provider 走的是真实轮），
    // E8b = hybrid 形态覆写照常发生 —— 发「未写入」即反向撒谎。
    case 'e1-register':
    case 'e2-not-hit':
    case 'e4-provider-error':
    case 'e5-interrupted':
    case 'e8b-hybrid':
      return { kind: 'none' }

    // 注销失败与落盘无关（任务早已写入）：登记在日志面即可，不打扰用户。
    case 'e6-unregister':
      return { kind: 'none' }

    default: {
      // exhaustive guard：8 种分类全覆盖，default 不可达；防御未来新增分类漏分类。
      const exhaustive: never = failure
      throw new Error(`planAckNotify: unhandled failure kind ${JSON.stringify(exhaustive)}`)
    }
  }
}

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
 * `key` 由调用方拼装（如 `${sessionId}:${taskId}`）——本模块不持有 session/task 概念，
 * 保持纯判定。首次 `shouldNotify(key)` 返回 true 并记账，此后同键恒 false；`clear(key)`
 * 用于该任务重试前允许再报，`clear()` 全清（session_shutdown / 跨代清理）。
 */
export function createAckNotifyDedup(): {
  shouldNotify(key: string): boolean
  clear(key?: string): void
} {
  const notified = new Set<string>()
  return {
    shouldNotify(key: string): boolean {
      if (notified.has(key)) return false
      notified.add(key)
      return true
    },
    clear(key?: string): void {
      if (key === undefined) notified.clear()
      else notified.delete(key)
    },
  }
}
