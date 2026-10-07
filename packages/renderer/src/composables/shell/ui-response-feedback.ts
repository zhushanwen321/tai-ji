/**
 * 「回复未送达」统一提示（M1 环 3）：dialog/form 应答经 UiResponseTransport 未送达（WS 非
 * OPEN）时由壳层 toast——队列 headless 无 UI，可见反馈归壳层。FormOverlay 侧
 * useExtensionUI.respond 与 shell-adapters 工厂注入（notifyNotDelivered）共用本函数。
 *
 * 独立叶子模块：useExtensionUI → useExtensionHostBridge → shell-adapters 的注入链若反向
 * 持有会成环；壳层 toast + i18n 依赖（renderer 专属）也不进 @taiji/ui（双壳共享层无
 * `@/i18n` 可址，见 MarkdownEnv.copyLabel 注入同族论证）。
 */
import i18n from '@/i18n'
import { useToast } from '@/composables/useToast'

export function notifyUiResponseNotDelivered(sessionId?: string): void {
  const t = i18n.global.t as (key: string) => string
  useToast().error(t('extensionUI.responseNotDelivered'), sessionId ? { sessionId } : undefined)
}
