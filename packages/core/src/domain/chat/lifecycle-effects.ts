/**
 * lifecycle-effects factory（remote-use 双壳统一化 D5）——session.exited / session.restored /
 * session.restoreFailed 的 core 最小语义单一归属。
 *
 * 背景（设计文档 §3.3 D5 / S6）：桌面 useMessageEffects 内嵌完整生命周期编排、移动壳
 * `effects: {}` 全弃（会话崩溃不 markDead、流式无人终结、无恢复提示无重订阅）。本 factory
 * 把「列表正确性 + 流式终结 + 恢复窗口」这些不属于面板族的最小语义抽成纯 core 依赖的
 * 原语集合，双壳各自叠装：桌面 useMessageEffects 在其上叠加壳专属扩展（extensionUIStore
 * 清理 / toast / 强杀分流 / respawn 过渡态回收），移动壳 bootstrap 直接注入 factory 产出。
 *
 * 语义清单（设计 §3.3 D5 采用段）：
 * - markSessionDead：markSessionError（流式终结或追加 error 消息，chat store 单一入口）
 *   + markDead（列表置灰）+ invalidateStreamSubscription（本地订阅簿记失效——服务端订阅
 *   已随 bus.clearSession 清除，不失效则 respawn 后 ensureStreamSubscription 被幂等守卫短路）。
 *   保序依据：错误消息 / dead 态等 UI 反馈先落地（useMessageEffects 既有契约）。
 * - openRestoreWindow：恢复窗口订阅——invalidate 之后立即重发 subscribeSession（幂等，
 *   fire-and-forget，失败 console.warn 由 WS 重连 resubscribeAll 兜底自愈）。这是 restored /
 *   restoreFailed live 送达的唯一通路：pi 死亡时 runtime 清掉订阅，恢复路径 publish 时
 *   无订阅者则 live 不达。归 factory 单一归属（壳不得绕行直调 subscribeSession）；
 *   是否进入恢复窗口（如桌面强杀分流）由壳决定调不调本原语。
 * - onSessionRestored：revive（dead → idle 复位）+ 恢复提示条（restored 形态）+ 重订阅
 *   （既恢复 live 订阅，也让后续重开/切换拿到完整回放）。
 * - onSessionRestoreFailed：willRetry=true 中间失败仅 log（重试由 runtime 自动续排，过渡态
 *   保持，不渲染提示条防闪烁）；willRetry=false 熔断写恢复提示条（restoreFailed 形态——
 *   「恢复失败可重新打开」重开出口由壳的 dead 分流承接）。
 *
 * 恢复提示条写入走 chat store appendRespawnNotice（liveOnly system 提示条，customType
 * 分支渲染），两形态文案经 notices 参数注入——core 不持有 i18n。
 *
 * 依赖方向：纯 core（chat store 动作面 + session store 动作面 + 订阅编排），零壳面
 * （无 toast / subagent / extensionUI）。deps 为结构类型，renderer 的 Pinia 包装 store
 * 与移动壳 store 实例均满足（方法闭包持原始 ref，pinia unwrap 不影响方法调用）。
 */
import type { ChatStoreInstance } from './store'
import type { PiRespawnNoticeVariant } from '@taiji/shared'
import { invalidateStreamSubscription } from './useChat'
import { subscribeSession } from '../../coordination/subscription-state'

/** session store 生命周期动作面（markDead 置灰 / revive 复位；createSessionStore 产物子集）。 */
export interface LifecycleSessionActions { // oe-exempt:20261003:framework:D5 设计裁决的 core factory 契约面——factory 即唯一实现点是设计形态，非待扩展口
  markDead(sessionId: string): void
  revive(sessionId: string): void
}

export interface LifecycleEffectsDeps { // oe-exempt:20261003:framework:D5 设计裁决的 core factory 契约面——factory 即唯一实现点是设计形态，非待扩展口
  /** chat store 动作面：markSessionError（session 级错误统一入口，含流式终结）+ appendRespawnNotice（恢复提示条写入点）。 */
  chat: Pick<ChatStoreInstance, 'markSessionError' | 'appendRespawnNotice'>
  session: LifecycleSessionActions
}

/** 恢复提示条两形态文案（壳注入——core 不持有 i18n）。 */
export interface LifecycleNoticeTexts { // oe-exempt:20261003:framework:D5 设计裁决的 core factory 契约面——factory 即唯一实现点是设计形态，非待扩展口
  restored: string
  restoreFailed: string
}

export interface LifecycleEffects { // oe-exempt:20261003:framework:D5 设计裁决的 core factory 契约面——factory 即唯一实现点是设计形态，非待扩展口
  /**
   * session.exited 的 core 序列：markSessionError（含流式终结 / error 消息追加）+ markDead
   * （列表置灰）+ 订阅簿记失效。壳扩展（弹窗分区清理 / toast / 强杀分流 / 过渡态）由调用方
   * 在本原语之后叠加。
   */
  markSessionDead(sessionId: string, reason: string): void
  /**
   * 恢复窗口订阅：立即重发 subscribeSession（幂等；fire-and-forget，失败 warn 链路自愈）。
   * 是否调用由壳裁决（桌面强杀分流不调）——调用即成为恢复后新 bus entry 的订阅者，
   * restored / restoreFailed / 恢复后首帧 live 可达。
   */
  openRestoreWindow(sessionId: string): void
  /** session.restored：revive + 恢复提示条（restored 形态）+ 重订阅。 */
  onSessionRestored(sessionId: string, payload: { attempts: number }): void
  /** session.restoreFailed：willRetry=true 中间失败仅 log；false 熔断写恢复失败提示条。 */
  onSessionRestoreFailed(
    sessionId: string,
    payload: { attempts: number; willRetry: boolean; reason: string },
  ): void
}

/** 恢复窗口 / 重订阅失败的统一 warn 前缀（core 域日志风格，对齐 [core/subscription-state]）。 */
const LOG_PREFIX = '[core/chat/lifecycle-effects]'

function resubscribe(sessionId: string, why: string): void {
  void subscribeSession(sessionId).catch((e: unknown) => {
    console.warn(`${LOG_PREFIX} ${why} failed for session ${sessionId}:`, e)
  })
}

function appendNotice(
  deps: LifecycleEffectsDeps,
  sessionId: string,
  variant: PiRespawnNoticeVariant,
  text: string,
): void {
  deps.chat.appendRespawnNotice(sessionId, variant, text)
}

export function createLifecycleEffects(deps: LifecycleEffectsDeps, notices: LifecycleNoticeTexts): LifecycleEffects {
  return {
    markSessionDead(sessionId, reason) {
      // 保序：错误消息 / dead 态 UI 反馈先落地，订阅簿记失效收尾（useMessageEffects 既有契约）
      deps.chat.markSessionError(sessionId, reason)
      deps.session.markDead(sessionId)
      invalidateStreamSubscription(sessionId)
    },

    openRestoreWindow(sessionId) {
      resubscribe(sessionId, 'restore-window subscribe')
    },

    onSessionRestored(sessionId, _payload) {
      deps.session.revive(sessionId)
      appendNotice(deps, sessionId, 'restored', notices.restored)
      resubscribe(sessionId, 're-subscribe after restore')
    },

    onSessionRestoreFailed(sessionId, payload) {
      if (payload.willRetry) {
        console.warn(`${LOG_PREFIX} auto restore failed (will retry) for session ${sessionId}:`, payload.reason)
        return
      }
      appendNotice(deps, sessionId, 'restoreFailed', notices.restoreFailed)
    },
  }
}
