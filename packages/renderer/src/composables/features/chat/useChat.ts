/**
 * useChat —— createUseChat 薄包装（P3 chat 域绞杀 w5）。
 *
 * [归位] useChat 业务编排逻辑（send/steer/followUp/abort/compact/bash/abortBash/
 * editAndResend/hydrateHistory/loadMoreHistory/disposeSession + ensureStreamSubscription
 * 会话级订阅编排 + session.* 跨 store 协调）已迁 @taiji/core/domain/chat/useChat.ts
 * 的 createUseChat factory（IF5/IF6 契约）。本文件仅做三件事：
 *
 * 1. useChat() = createUseChat(rendererDeps)：注入 renderer 侧依赖（chatApi/sessionApi/
 *    useChatStore/useSessionStore/useToast/i18n/useCompactQueue），20 个消费方零 import 改动
 *    （对齐 w4 createChatStore + defineStore wrapper 模式）。
 * 2. ensureStreamSubscription 同名包装：core 版加 deps 参数（TD5），本包装注入 renderer deps，
 *    3 个复用点（useForkActions/useSidebar/useSessionStreamSync）零改动。
 * 3. re-export resetChatModuleState（as alias core 的 resetChatModuleStateForTest）：
 *    旧测试（useChat.test.ts beforeEach）import 路径兼容。
 *
 * 历史：原文件 563 行（模块级 streamSubscriptions/historyTruncatedSessions + ensureStreamSubscription
 * + useChat() factory），w5 全部迁 core。core 保持模块级 Map（clarify Q1/TD2：对齐
 * coordination/subscription-state.ts ADR-0049 例外，不套 useSessionScopedState）。
 */
import {
  createUseChat,
  ensureStreamSubscription as coreEnsureStreamSubscription,
} from '@taiji/core'
import type {
  UseChatDeps,
  EnsureStreamSubDeps,
  ChatApiPort,
  ChatStoreInstance,
} from '@taiji/core'
import { resetChatModuleStateForTest as resetChatModuleState } from '@taiji/core'
import { chat as chatApi, session as sessionApi } from '@/api'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'

/**
 * ChatApiPort 实现：组装 api/domains/chat 的函数集（不需新 adapter 文件）。
 * 方法引用稳定（模块级函数），组装一次复用。
 */
const chatApiPort: ChatApiPort = {
  // 端口适配：ChatApiPort.send 无 images 概念（Cmd+V 富呈现通路绕过端口直调 api/domains/chat），
  // 发送编排链路（submitSegments）仅需 options.clientUuid（session-occupancy D2）透传。
  send: (sid, text, options) => chatApi.send(sid, text, undefined, options),
  // `@` 定向消息分流（U2b）：实现在 session 域（session.subagentAction RPC），经端口
  // 暴露给 core useChat 发送链路（ChatApiPort 注释）；mock 层 stub 已随 U5 就位。
  // 懒解引用（调用时才读 sessionApi.subagentAction）：部分测试 vi.mock session 域时
  // 未导出该方法，模块加载期解引用会炸 mock 的导出检查；定向发送才会真正触达。
  subagentAction: (sid, action, params) => sessionApi.subagentAction(sid, action, params),
  steer: chatApi.steer,
  followUp: chatApi.followUp,
  abort: chatApi.abort,
  compact: chatApi.compact,
  bash: chatApi.bash,
  abortBash: chatApi.abortBash,
  getHistory: chatApi.getHistory,
  streamSubscribe: chatApi.streamSubscribe,
}

/**
 * i18n.global.t 的类型窄化 cast：vue-i18n 的 t 是复杂重载签名，UseChatDeps.t 只需
 * `(key, params?) => string`。cast 保持调用方用法不变（t('composable.sendFailed', { msg })）。
 */
const tFn = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

/**
 * ensureStreamSubscription 模块级函数所需 renderer deps（TD5）。
 * 每次调用取新 toast 实例（避免 toast 状态陈旧），getCompactQueue 取单例。
 */
function rendererSubDeps(): EnsureStreamSubDeps {
  return {
    chatApi: chatApiPort,
    toast: useToast(),
    t: tFn,
    getCompactQueue: () => useCompactQueue(),
  }
}

/**
 * useChat —— chat 业务编排（renderer 薄包装）。
 * 20 个消费方（Composer/Panel/Sidebar/useNewTaskFlow/useForkActions/useSidebar 等）零改动。
 */
export function useChat() {
  return createUseChat({
    chatApi: chatApiPort,
    writeSegments: sessionApi.writeSegments,
    // [w5 类型鸿沟] useChatStore() 返回 pinia Store（defineStore 包装后 state ref 被解包 + 多 $state/
    // $patch 等），与 core ChatStoreInstance（createChatStore factory 产物 plain object）类型不兼容。
    // 运行时等价：pinia setup store 的 actions 原样保留 factory 方法（useChat 只调方法不碰 messages
    // ref，abortBash 经 store.markStreamingBashError 不需 raw ref）。cast 是 w4 factory+wrapper
    // 模式的固有后果（pinia 类型系统局限，非运行时风险）。
    getChatStore: () => useChatStore() as unknown as ChatStoreInstance,
    getSessionStore: () => useSessionStore(),
    toast: useToast(),
    t: tFn,
    getCompactQueue: () => useCompactQueue(),
  } satisfies UseChatDeps)
}

/**
 * ensureStreamSubscription —— renderer 同名包装（TD5）。
 *
 * core 版加 deps 参数（EnsureStreamSubDeps），本包装注入 renderer deps。
 * 3 个复用点（useForkActions/useSidebar/useSessionStreamSync）import 本函数零改动
 * （签名保持 (sid, chat, sessionStore)，内部调 core 版 + rendererSubDeps）。
 */
export function ensureStreamSubscription(
  sid: string,
  chat: ReturnType<typeof useChatStore>,
  sessionStore: ReturnType<typeof useSessionStore>,
): void {
  // chat cast 同 useChat() 内 getChatStore（pinia Store → ChatStoreInstance，运行时等价）。
  coreEnsureStreamSubscription(sid, chat as unknown as ChatStoreInstance, sessionStore, rendererSubDeps())
}

// re-export test reset（as 别名保持旧测试 beforeEach 兼容：resetChatModuleState()）。
// handoff「resetChatModuleState 删除（cleanup 取代）」精神：生产路径靠 disposeSession +
// triggerSessionCleanups 编排，本函数仅供测试隔离（TD3）。
export { resetChatModuleState }
