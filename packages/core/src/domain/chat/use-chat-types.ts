/**
 * useChat 的依赖注入契约与结构类型（自 useChat.ts 原样迁移，行为保持抽取）。
 *
 * 为什么独立文件：useChat.ts 触发 max-lines(500) lint 门禁，本文件全部为纯类型
 * 声明（零运行时代码），与实现体天然可分。消费方 import 路径不变——useChat.ts
 * re-export 全部类型，domain/chat/index.ts 与 __tests__ 的既有 `from './useChat'`
 * 消费零改动。
 */
import type { Segment, SessionViewSnapshot } from '@xyz-agent/shared'
import type { ChatApiPort, WriteSegmentsFn } from './api-port'
import type { ChatStoreInstance } from './store'

/**
 * CompactQueueLike —— useChat 消费 compactQueue 的最小结构类型（renderer useCompactQueue
 * 单例自动满足，经 deps.getCompactQueue 注入——session.compacted → flush 先例的既有模式）。
 *
 * 契约对端：packages/renderer/src/composables/panel/useCompactQueue.ts（CompactQueue /
 * QueuedMessage）——结构类型 seam，有意不合并：core 不反向依赖 renderer 实现，仅以本
 * 最小结构面约束实现方；任一侧扩展字段时需同步核对另一侧结构面。
 *
 * session-occupancy-send-closure（已删除，git 可追溯）D2 P1：send.rejected{reason:'compacting'} 兜底入队复用
 * compactQueue（enqueue）+ flush 重放来源消歧（peek 命中条目 id 即跳过重入队）。
 * [u4a / D5.3 ①] 扩展投递确认回调（confirmDelivery）与条目提交通道标记（mode）——
 * message_end(user) 三分支处理序 ①（defer 分区 FIFO 文本匹配）的 core 消费面。
 */
export interface CompactQueueEntrySnapshot {
  id: string
  text: string
  /**
   * [defer segments 化 / D-A1-1] 提交载荷（富内容段）。入队时写入：enqueue 路径快照的
   * Segment[]（image/skill/file chip 等）；send.rejected 重入队路径包 `[{type:'text',text}]`
   * 单段。renderer QueuedMessage.segments 恒有值，此处可选是防御（core mock/旧实现形态）。
   */
  segments?: Segment[]
  /**
   * [defer segments 化 / D-A1-1] 提交文本（= segmentsToPrompt(segments)），**提交时**写入
   * （flush 侧算好后落条目）。供 ①b 文本 FIFO 兜底匹配——富内容条目 draft（text）≠
   * 序列化文本，匹配源必须用提交时的真实落盘文本。undefined = 未提交/旧形态，消费方
   * 回退 text。
   */
  submitText?: string
  /**
   * [u4a / D5.3] 提交通道标记：flush 提交该条目时写入（队首 'send'、其余 'steer'——
   * 与 flush 的首条 send + 后续 steer 提交顺序一致）；undefined = 未提交（还没被任何
   * flush 提交过）。双消费：① 匹配资格判据（未提交条目不可能产生投递确认帧，若被同
   * 文本他帧误配出队 = 消息永不被投递即丢失）+ send 占位回收判据（命中 send 条目
   * decrementInflight 回收占位，steer 条目不挂占位不动计数）。
   */
  mode?: 'send' | 'steer'
}

export interface CompactQueueLike {
  /**
   * flush 队列（逐条提交，D5）。返回值三态契约 [A1 收窄]：
   * - resolve true：全部条目提交编排完成；
   * - resolve false：S1 busy 类拒绝（条目留队，等下一次 occupancy idle 帧自动重投）——
   *   自愈路径，调用方不 toast；
   * - reject：RPC reject（传输级真错误，如 WS 断连）——调用方 toast「发送失败: {原因}」
   *   （设计 §3.5 错误规格表）。
   */
  flush: (sid: string) => Promise<boolean>
  /**
   * 入队一条待发消息，返回含 id 的条目（id 供 flush 提交时的 clientUuid 消歧，u4b 消费）。
   * [defer segments 化 / D-A1-1] segments 入队快照（富内容段）；未传时实现方包
   * `[{type:'text',text}]` 单段（纯文本条目等价形态）。submitText 仅 send.rejected
   * 静默重入队路径传（已序列化 promptText，原文本即提交文本）；普通入队路径的
   * submitText 由 flush 提交时写入。
   */
  enqueue: (
    sid: string,
    text: string,
    segments?: Segment[],
    submitText?: string,
  ) => { id: string; text: string }
  /** 只读快照（副本），兜底 handler 据此判定 rejected.clientUuid 是否命中已有条目；
   *  [u4a] message_end(user) ① 据此做 defer 分区 FIFO 文本匹配（按入队序，最早同文本优先） */
  peek: (sid: string) => ReadonlyArray<CompactQueueEntrySnapshot>
  /**
   * [u5b / D6] 队列非空判定（occupancy 全 idle 时 flush 触发条件的「且队列非空」半边）。
   * count>0 的布尔投影；实现方（renderer useCompactQueue）已有同签名方法。
   */
  hasPending: (sid: string) => boolean
  /**
   * [u4a / D5.3] 投递确认回调：message_end(user) ① 命中 defer 条目时由 core 调用。
   * 队列实现侧执行「标记确认 + 出队」（转态/pending 气泡收口归 u4b 消费条目 id）；
   * 按 id 精确出队，未知 id no-op 返回 false。返回 true = 出队成功，core 继续剔快照
   * 实例与回收 send 占位；false = 匹配作废，帧落 ②③ 现状链（不丢帧）。
   */
  confirmDelivery: (sid: string, id: string) => boolean
}

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
   * Pick 子集），u4b 的 submitQueuedEntry 依赖组装得以按实际用量窄化注入。
   */
  chatApi: Pick<ChatApiPort, 'streamSubscribe'>
  /**
   * [session-dead 第三环] error = 操作失败；warning = defer 重投连续失败达阈值的「可能卡死、
   * 需用户处置」信号（与 error 语义区分，壳侧 useToast().warning 对接）。
   */
  toast: { error: (msg: string) => void; warning: (msg: string) => void }
  t: (key: string, params?: Record<string, unknown>) => string
  getCompactQueue: () => CompactQueueLike
}

/**
 * [session-occupancy u4b / D5.1] submitQueuedEntry 的依赖注入（TD5 同款：模块级导出函数
 * 拿不到 createUseChat 闭包 deps，接收显式 deps 子集；renderer flush 侧组装）。
 */
export interface SubmitQueuedEntryDeps {
  /** send/steer/streamSubscribe：flush 逐条提交的全部 RPC 面（窄化注入，同上方收窄理由） */
  chatApi: Pick<ChatApiPort, 'send' | 'steer' | 'streamSubscribe'>
  /**
   * [defer segments 化 / D-A1-2] 写 segments.json sidecar（session.writeSegments RPC）——
   * 富内容条目（含非 text 段）提交时按 deferEntryId 写，重开 session 回填 badge。
   * fire-and-forget（失败 console.warn 不阻断，对齐 submitSegments 的 sidecar 写模式）。
   */
  writeSegments: WriteSegmentsFn
  /** chat store：send 通道挂 inflight 占位 + 透传 ensureStreamSubscription */
  chat: ChatStoreInstance
  sessionStore: SessionStoreLike
  /** [session-dead 第三环] 同 EnsureStreamSubDeps：本 deps 向 ensureStreamSubscription 透传 toast 端口 */
  toast: { error: (msg: string) => void; warning: (msg: string) => void }
  t: (key: string, params?: Record<string, unknown>) => string
  getCompactQueue: () => CompactQueueLike
}

/**
 * createUseChat factory 的依赖注入接口。
 *
 * - chatApi：chat 域后端唯一通道（IF6 ChatApiPort）
 * - writeSegments：写 segments.json sidecar（session 域 RPC，useChat 消费者）
 * - getChatStore/getSessionStore/getCompactQueue：getter 函数（延迟调用，规避 pinia/composable
 *   必须在 setup 上下文调用的约束；factory 调用时机与 store 实例化解耦）
 * - toast/t：壳层 UI/i18n 注入（core 不绑 toast/i18n 实现）
 */
export interface UseChatDeps {
  chatApi: ChatApiPort
  writeSegments: WriteSegmentsFn
  getChatStore: () => ChatStoreInstance
  getSessionStore: () => SessionStoreLike
  /** [session-dead 第三环] warning 同 EnsureStreamSubDeps（defer 重投熔断的行动信号） */
  toast: { error: (msg: string) => void; warning: (msg: string) => void }
  t: (key: string, params?: Record<string, unknown>) => string
  getCompactQueue: () => CompactQueueLike
}
