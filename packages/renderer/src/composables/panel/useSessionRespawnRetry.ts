/**
 * useSessionRespawnRetry —— 恢复提示条「重试」按钮的手动恢复动作（从 MessageStream.vue 拆出）。
 *
 * [u8-pi-respawn] crash-resilience D7 熔断后 runtime 不再自动重连，用户侧唯一出口 = 提示条
 * 上的重试按钮：显式 session.restore RPC + 本地 revive 复位 dead 态。成功后 runtime 推
 * session.restored（走正常恢复链），失败 toast 指引——原实现内联在容器组件里，与虚拟列表
 * 定位/渲染无关，属「会话生命周期」关注点，故拆出。
 *
 * @param sessionId 当前 session id getter
 */
import { useI18n } from 'vue-i18n'
import { session as sessionApi } from '@/api'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'

export function useSessionRespawnRetry(sessionId: () => string) {
  const { t } = useI18n()

  async function onRespawnRetry(): Promise<void> {
    try {
      await sessionApi.restoreSession(sessionId())
      useSessionStore().revive(sessionId())
    } catch (e) {
      console.warn(`[MessageStream] manual respawn retry failed for session ${sessionId()}:`, e)
      useToast().error(t('panel.message.respawnRetryFailed'))
    }
  }

  return { onRespawnRetry }
}
