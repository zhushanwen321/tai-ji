/**
 * useChat 的依赖注入契约与结构类型（自 useChat.ts 原样迁移，行为保持抽取）。
 *
 * 为什么独立文件：useChat.ts 触发 max-lines(500) lint 门禁，本文件全部为纯类型
 * 声明（零运行时代码），与实现体天然可分。消费方 import 路径不变——useChat.ts
 * re-export 全部类型，domain/chat/index.ts 与 __tests__ 的既有 `from './useChat'`
 * 消费零改动。
 */
import type { SessionViewSnapshot } from '@taiji/shared'
import type { ChatApiPort, WriteSegmentsFn } from './api-port'
import type { ChatStoreInstance } from './store'

/**
 * SessionStoreLike —— useChat 消费 session store 的最小结构类型。
 *
 * 不 import 整个 SessionStoreInstance（避免 core 内 chat→session 域强耦合 + 返回类型膨胀）。
 * useChat 只用 applySnapshot 的单 session 形态（session.renamed / state_changed /
 * thinkingLevelSet 三个广播驱动的跨 store 字段更新）+ revive（恢复窗口内新回合开始帧
 * 的过渡态收口——dead 复位，crash-resilience T4 回流修复）。结构性类型，
 * renderer useSessionStore() 返回值自动满足。
 */
export interface SessionStoreLike {
  applySnapshot(id: string, snapshot: SessionViewSnapshot): void
  /** dead → idle 复位（恢复窗口过渡态收口时与 chat store 收口同帧调用） */
  revive(id: string): void
}

/**
 * ensureStreamSubscription 模块级函数所需 deps 子集。
 *
 * ensureStreamSubscription 是模块级导出（forkSessionAsk/selectSession/session-stream-sync
 * 复用），无法闭包拿 createUseChat 的 deps，故独立定义所需子集。renderer 同名包装注入。
 */
export interface EnsureStreamSubDeps {
  /**
   * [u4b 收窄] handler 内 chatApi 的唯一用法是 streamSubscribe（ensureStreamSubscription
   * 是订阅建立入口，不做 RPC）。宽→窄收窄对既有消费方结构兼容（完整 ChatApiPort 满足
   * Pick 子集）。
   * [投递所有权内核 u3b] getCompactQueue 成员已随 defer flush/S1/timer/熔断退役摘除。
   */
  chatApi: Pick<ChatApiPort, 'streamSubscribe'>
  /**
   * [session-dead 第三环] error = 操作失败；warning = 需用户处置的信号（与 error 语义区分，
   * 壳侧 useToast().warning 对接）。
   */
  toast: { error: (msg: string) => void; warning: (msg: string) => void }
  t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * createUseChat factory 的依赖注入接口。
 *
 * - chatApi：chat 域后端唯一通道（IF6 ChatApiPort）
 * - writeSegments：写 segments.json sidecar（session 域 RPC，useChat 消费者）
 * - getChatStore/getSessionStore：getter 函数（延迟调用，规避 pinia/composable
 *   必须在 setup 上下文调用的约束；factory 调用时机与 store 实例化解耦）
 * - toast/t：壳层 UI/i18n 注入（core 不绑 toast/i18n 实现）
 * [投递所有权内核 u3b] getCompactQueue 成员已随 defer 队列状态机退役摘除。
 */
export interface UseChatDeps {
  chatApi: ChatApiPort
  writeSegments: WriteSegmentsFn
  getChatStore: () => ChatStoreInstance
  getSessionStore: () => SessionStoreLike
  /** [session-dead 第三环] warning 同 EnsureStreamSubDeps */
  toast: { error: (msg: string) => void; warning: (msg: string) => void }
  t: (key: string, params?: Record<string, unknown>) => string
  /**
   * [U5 消息撤回 D7] 撤回 reply 的草稿回填注入（壳层 composer 输入区能力）。optional：
   * 未注入时撤回成功链路跳过回填（重拉照做）——core 不绑 DOM，回填能力只能来自壳。
   * payload 仅 text：撤回回填走 composerInjection 单值文本通道（[MF-1-2] 注入 schema 无
   * segments 承载位）；chips 完整恢复通道 = 队列区 restoreToDraft（QueueRowsDeps.restoreDraft）。
   */
  restoreDraft?: (sessionId: string, payload: { text: string }) => void
}
