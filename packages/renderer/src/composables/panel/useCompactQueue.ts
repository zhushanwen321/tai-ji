/**
 * useCompactQueue —— per-session defer 队列（compact-queued-messages W1 → session-occupancy
 * u4b / D4 泛化为 defer 语义）。
 *
 * **符号名保留说明**（C-proc-10 最小爆炸半径裁决）：useCompactQueue / CompactQueue /
 * QueuedMessage 被 core CompactQueueLike 契约（useChat/user-delivery）、composer-shell、
 * i18n 及 core/renderer 双方测试广泛引用（>10 处）——本单元只改用户可见
 * 语义（入队即 pending 气泡、撤销边界、flush 投递确认驱动），顶层符号与文件名保持不动；
 * 「defer 队列」术语的展示位由 pending 气泡 + i18n（panel.deferQueue.*）承接。
 * [u6b] 独立 badge 组件已移除（D7 展示统一）：队列可见性由 composer 上方 QueueBubble 的
 * defer 行承接展示与撤销（对话流内展示位已随 2.1 迁移拆除）。
 *
 * **双契约 seam 说明**：本文件的 CompactQueue / QueuedMessage 与 core 侧最小结构类型
 * CompactQueueLike（契约对端：packages/core/src/domain/chat/use-chat-types.ts）构成
 * 结构类型 seam——两端类型各自声明，经 deps.getCompactQueue 结构匹配对接，有意不合并
 * （core 不反向依赖 renderer 实现，仅以最小结构面约束实现方；任一侧扩展字段时需
 * 同步核对另一侧结构面）。
 *
 * 入队即显：未提交条目（mode === undefined）由 composer 上方 QueueBubble 的 defer 行渲染
 * （Hourglass icon + 占用分档 chip + × 撤销）；已提交条目本地行隐藏，承接面分通道：steer
 * 条目由 queue_update 镜像行承接、send 条目确认帧前暂不可见（echo 到达即 confirmDelivery
 * 转正常气泡入流）。撤销（remove）仅对未提交条目（mode === undefined）开放——已提交条目
 * 已进 pi 队列无法撤回。
 *
 * flush 语义（D5，u4b 重写——E2 整队保留重发语义退役）：
 * - **逐条提交**：队首经 core submitQueuedEntry 'send' 等价编排（挂 inflight 占位 +
 *   ensureStreamSubscription + chatApi.send 带 clientUuid=条目 id；不 appendUser——入流由
 *   pending 气泡承担），其余条目经 'steer' 等价编排（不挂占位、不 pushPending）。
 * - **提交判定（S1 per-entry）**：每 await 一条 RPC 后查该条是否触发 send.rejected（窗口
 *   订阅按 clientUuid 归属；WS FIFO 保证广播先于 reply）→ 未投递：条目留队首、停止提交
 *   后续、同步 decrementInflight 回滚该条占位（重试时重新挂——占位三态闭环：挂/收/回滚，
 *   回滚归 flush 侧、回收归 core ①、挂归 submitQueuedEntry）；RPC reject → 留队 + 回滚占位。
 * - **出队与气泡转态由确认帧驱动**：message_end(user) 经 core ①（FIFO 文本匹配）命中时调
 *   confirmDelivery——本侧出队 + appendUser 插入正常气泡（转态）。RPC resolve 只表示「已
 *   提交」（steer 仅入 pi 内存队列），flush 本身不再出队（部分失败只重发未投递条目，已
 *   提交在途条目不重发——flush 重入时按 mode 跳过）。
 *
 * 单例模式（对齐 useChat 模块级状态）：模块顶层缓存实例，首次 useCompactQueue() 调用
 * 时创建（App.vue setup 绑定 app 级 effect scope——防模块级 onScopeDispose 警告与过早
 * 反注册，保证 registerSessionCleanup 常驻；W5 deleteSession → triggerSessionCleanups
 * 时分区随 session 销毁）。所有公开方法显式接收 sid 并经 updateFor 操作分区——不依赖
 * 全局活跃 sid，兼容 split 多 panel。
 */
import { reactive, ref } from 'vue'
import type { Ref } from 'vue'
import type { Segment, ServerMessage } from '@xyz-agent/shared'
import { segmentsToPrompt } from '@xyz-agent/shared'
import { setCompactQueueProviderForEffects, submitQueuedEntry } from '@xyz-agent/core'
import type { SubmitQueuedEntryDeps } from '@xyz-agent/core'
import { createInflightDedup } from '@xyz-agent/core/foundation/create-inflight-dedup'
import { chat as chatApi, session as sessionApi } from '@/api'
import * as events from '@xyz-agent/core/transport/api'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import { useSessionScopedState } from '@/composables/useSessionScopedState'

/** 待发消息条目（D1 继承自 slice；u4a 扩展提交通道标记 mode） */
export interface QueuedMessage {
  id: string
  /**
   * 展示文本（draft）：气泡 / queue_update 快照渲染统一用它（[defer segments 化 /
   * D-A1-1]）。富内容条目的 text ≠ 提交文本（segmentsToPrompt 序列化产物）——提交
   * 面走 segments/submitText。
   */
  text: string
  /**
   * [defer segments 化 / D-A1-1] 提交载荷：入队时快照的完整 Segment[]（image/skill/
   * file chip 等）。未传 segments 的 enqueue（重入队/旧调用方）包 `[{type:'text',text}]`
   * 单段——恒有值。flush 经 submitQueuedEntry 序列化 + 注入展开，与直发同款。
   */
  segments: Segment[]
  /**
   * [defer segments 化 / D-A1-1] 提交文本（= segmentsToPrompt(segments)），**提交时**
   * 写入（flush 侧算好后落条目）——core ①b 文本 FIFO 兜底的匹配源。send.rejected
   * 静默重入队路径入队即写（原文本即提交文本）。
   */
  submitText?: string
  /**
   * [session-occupancy u4a / D5.3] 提交通道标记（core CompactQueueEntrySnapshot.mode
   * 对齐）：flush 提交该条目时写入——队首 'send'、其余 'steer'（与提交顺序一致）；
   * undefined = 未提交。core message_end(user) ① 据此判定匹配资格（未提交条目的确认帧
   * 不可能存在，不参与 FIFO 匹配）与 send 占位回收（命中 send 条目才 decrementInflight）。
   * u4b 起同时是撤销边界判据（mode 已写 = 已提交，× 禁用）与 flush 重入跳过判据
   * （已提交在途条目不重发）。
   */
  mode?: 'send' | 'steer'
}

/** per-session 分区：待发消息数组（init 返回 reactive 容器，ADR-0049 响应式契约） */
interface CompactQueuePartition {
  messages: QueuedMessage[]
}

export interface CompactQueue {
  /**
   * 入队一条待发消息，返回含 crypto.randomUUID() id 的条目（updateFor push）。
   * [defer segments 化 / D-A1-1] segments = 入队快照的完整段（未传包 text 单段——纯文本
   * 等价形态）；submitText 仅 send.rejected 静默重入队路径传（原文本即提交文本），
   * 普通入队由 flush 提交时写入。
   */
  enqueue(sid: string, text: string, segments?: Segment[], submitText?: string): QueuedMessage
  /** 按 id 精确取消，未知 id no-op（不抛错）。撤销边界（D4）：仅未提交条目（mode === undefined）
   *  可撤；已提交条目（mode 已写）remove **no-op**——记账不变量下沉到 API 层（一致性审查
   *  R3-U2）：已提交条目已进 pi 队列无法撤回，强行移除会使 send 条目的 inflight 占位悬空、
   *  其确认帧经 core ① confirmDelivery 变未知 id（匹配作废，气泡永 pending）。UI 侧
   *  QueueBubble defer 行 ×（仅未提交条目渲染）是唯一撤销入口 */
  remove(sid: string, id: string): void
  /** 分区消息数（updateFor 内读 messages.length；调用方包进 computed 时依赖在 reactive 上建立） */
  count(sid: string): number
  /** 只读快照（返回副本，调用方修改不影响队列，UI 预览用） */
  peek(sid: string): QueuedMessage[]
  /** 是否有待发消息（count > 0） */
  hasPending(sid: string): boolean
  /**
   * [session-dead 结构性修复 D3] 整队回收：取出该 session 全部条目并清空分区，返回
   * 出队快照（副本）。forceQuit 编排专用——pi 已被杀，未提交条目的自动投递权被斩断
   * （L1 复活主腿），已提交在途条目（mode 已写）的确认帧也永不再来（进程消亡），
   * 一并回收，文本交还用户处置（回 Composer 草稿）。
   * 与 remove（单条撤销，已提交条目 no-op）、confirmDelivery（投递事实确认出队）
   * 语义不同，不可互替：本方法是「用户停止意图」对整队的强制回收（唯一允许动已提交
   * 条目的出口，前提 = 进程已死、在途记账不再有意义）。
   */
  drain(sid: string): QueuedMessage[]
  /**
   * [session-occupancy u4a / D5.3 ①] 投递确认出队 + 气泡转态（core CompactQueueLike.
   * confirmDelivery 契约）：message_end(user) 帧经 core effects/registry ① 命中本队列
   * 条目时调用——按 id 精确移除并返回 true（出队成功）；未知 id no-op 返回 false（core
   * 据此判匹配作废落回现有处理链）。出队成功即执行**转态**（u4b）：core ① 命中后帧消费
   * 终止（不 appendUser），正常气泡的唯一 overlay 插入点在此——appendUser 插入与 pi 落盘
   * entry 同文本的用户消息（重开 session 由 entry 重放恢复同一消息，live ≡ reload），
   * pending 气泡随条目出队消失。与 remove 的区别：remove 是用户撤销（未知 id 静默），
   * confirmDelivery 是投递事实确认（返回值参与 core 帧消费裁决），语义不同不合并。
   */
  confirmDelivery(sid: string, id: string): boolean
  /**
   * flush：逐条提交（投递确认驱动，D5）。
   * - 首个未提交条目（且队列无在途提交）走 send 通道，其余走 steer 通道（见 doFlush）。
   * - 已提交在途条目（mode 已写）跳过不重发（flush 重入场景——确认帧未到前 session.compacted
   *   再次触发）；await 窗口内被确认出队/用户撤销的条目跳过。
   * - 成功判定（S1 per-entry）：每条提交 await 后查该条 clientUuid 是否命中 send.rejected
   *   （或窗口内出现无 uuid 拒绝——按 FIFO 归属当前条）→ 未投递：条目留队、回滚占位、
   *   停止后续、返回 false（busy 类拒绝留队静默自愈，等下一次 occupancy idle 帧重投——
   *   调用方不 toast，A1）；RPC reject → 同上留队回滚，但原始错误上抛（传输级真错误，
   *   调用方 toast「发送失败: {原因}」——A1 分流，与 S1 静默自愈区分）。
   * - 全部提交成功 → 返回 true，但**不出队**（条目保持 mode 已写，等待 message_end(user)
   *   确认帧逐条出队 + 转态——E2「成功即清队」语义退役）。
   * - 并发（S2）：per-session in-flight 守卫，flush 进行中重复触发复用同一 promise。
   */
  flush(sid: string): Promise<boolean>
  /** 测试钩子：清空所有分区。生产代码禁止调用（对齐 useSessionScopedState._clearAllForTest 契约）。 */
  _clearAllForTest(): void
}

/** 模块级单例缓存（首次调用时创建，App.vue setup 绑定 app 级 scope） */
let queueInstance: CompactQueue | null = null

/**
 * 获取模块级单例。首次调用创建实例（内部 useSessionScopedState 的 onScopeDispose
 * 在调用方 effect scope 内注册——App.vue setup 是 app 级作用域，App 卸载前常驻）。
 * 后续调用复用同一实例。
 */
export function useCompactQueue(): CompactQueue {
  if (!queueInstance) {
    queueInstance = createCompactQueue()
  }
  return queueInstance
}

/**
 * submitQueuedEntry 的 renderer deps 组装（flush 调用时惰性构建——取新 toast 实例，
 * 对齐 features/chat/useChat.ts rendererSubDeps 惯例；pinia store 在应用启动后任意
 * 异步上下文可取，App.vue setup 创建单例时已 active）。
 */
function createSubmitEntryDeps(store: ReturnType<typeof useChatStore>, sessionStore: ReturnType<typeof useSessionStore>): SubmitQueuedEntryDeps {
  const tFn = i18n.global.t as (key: string, params?: Record<string, unknown>) => string
  return {
    // 端口适配（对齐 features/chat/useChat.ts chatApiPort.send）：renderer send 第三参是
    // images，clientUuid 在第四参 options——包一层防参数错位（ChatApiPort['send'] 三参）。
    chatApi: {
      send: (sessionId, promptText, options) => chatApi.send(sessionId, promptText, undefined, options),
      steer: chatApi.steer,
      streamSubscribe: chatApi.streamSubscribe,
    },
    // chat cast 同 features/chat/useChat.ts getChatStore（pinia Store → ChatStoreInstance，
    // 运行时等价——flush 只调 incrementInflight/decrementInflight/appendUser 方法）。
    chat: store as unknown as SubmitQueuedEntryDeps['chat'],
    // [defer segments 化 / D-A1-2] 富内容条目写 sidecar（deferEntryId key，reload 回填
    // badge）——与 features/chat/useChat.ts 的 writeSegments 注入同源（session 域 RPC）。
    writeSegments: sessionApi.writeSegments,
    sessionStore,
    toast: useToast(),
    t: tFn,
    getCompactQueue: () => queueInstance!,
  }
}

function createCompactQueue(): CompactQueue {
  // 常驻 null sid ref：公开方法全部显式接收 sid 并经 updateFor 操作分区，
  // 不使用 update()/current（无全局活跃 sid 概念）。
  const sidRef: Ref<string | null> = ref(null)
  const state = useSessionScopedState<CompactQueuePartition>(
    sidRef,
    () => reactive<CompactQueuePartition>({ messages: [] }),
  )

  function enqueue(sid: string, text: string, segments?: Segment[], submitText?: string): QueuedMessage {
    // [defer segments 化 / D-A1-1] segments 缺省包 text 单段：QueuedMessage.segments 恒有值
    //（纯文本条目的等价形态——flush 序列化 / 气泡徽标判定统一消费，无 undefined 分支）。
    const entry: QueuedMessage = {
      id: crypto.randomUUID(),
      text,
      segments: segments ?? [{ type: 'text', text }],
      submitText,
    }
    state.updateFor(sid, (p) => {
      p.messages.push(entry)
    })
    return entry
  }

  function remove(sid: string, id: string): void {
    state.updateFor(sid, (p) => {
      // 记账不变量下沉（R3-U2，接口 jsdoc 详注）：已提交条目（mode 已写）不可经 remove 撤除
      // ——inflight 占位 / confirmDelivery 确认通路以「条目在队」为前提。保留条件：id 不同，
      // 或 id 相同但已提交（no-op）。未知 id 时 filter 结果等同原数组（no-op，不抛错）。
      p.messages = p.messages.filter((m) => m.id !== id || m.mode !== undefined)
    })
  }

  /** [u4b] 写/清提交通道标记（live 条目存在才写——撤销/确认竞态下条目已出队则 no-op）；
   *  undefined = 未提交（未投递回滚——重试 flush 重新标记重提交） */
  function setEntryMode(sid: string, id: string, mode: 'send' | 'steer' | undefined): void {
    state.updateFor(sid, (p) => {
      const live = p.messages.find((m) => m.id === id)
      if (live) live.mode = mode
    })
  }

  /** [defer segments 化 / D-A1-1] 写提交文本（= segmentsToPrompt(segments)，flush 提交时
   *  写入；live 条目存在才写——竞态下条目已出队则 no-op）。core ①b 兜底匹配源。 */
  function setEntrySubmitText(sid: string, id: string, submitText: string): void {
    state.updateFor(sid, (p) => {
      const live = p.messages.find((m) => m.id === id)
      if (live) live.submitText = submitText
    })
  }

  /** [u4b] 读 live 条目（flush 循环内实时查——确认/撤销竞态下条目可能已出队） */
  function findLive(sid: string, id: string): QueuedMessage | undefined {
    let live: QueuedMessage | undefined
    state.updateFor(sid, (p) => {
      live = p.messages.find((m) => m.id === id)
    })
    return live
  }

  /** [u4a / D5.3 ①] 投递确认出队 + 转态：按 id 精确 splice，命中 true / 未知 id false（no-op） */
  function confirmDelivery(sid: string, id: string): boolean {
    let removed = false
    // 持有对象：闭包内赋值 + 外部成员访问——直接用 let 局部变量会被 TS 控制流窄化为
    // never（回调赋值对窄化不可见，原 deliveredText 模式未炸是 text 属性恰好接受 never）。
    const holder: { delivered: QueuedMessage | null } = { delivered: null }
    state.updateFor(sid, (p) => {
      const idx = p.messages.findIndex((m) => m.id === id)
      if (idx !== -1) {
        holder.delivered = { ...p.messages[idx]! }
        p.messages.splice(idx, 1)
        removed = true
      }
    })
    if (removed && holder.delivered !== null) {
      // 转态（u4b / D5.3 + defer segments 化 / D-A1-6）：core ① 命中后帧消费终止
      //（不 appendUser），正常气泡唯一插入点。appendUser 段源改 entry.segments——现状
      // 单 text 段（draft 文本）会把富内容条目的 chip badge 丢掉；segments 含完整结构化段
      //（image/skill/file），转态气泡与直发同形态（live ≡ reload：reload 侧 backfillSegments
      // 按 deferEntryId 回填同一 segments）。appendUser 是 overlay-only（不喂 reducer、
      // 不写 sidecar——store.ts:637），与 submitQueuedEntry 的 sidecar 写入互斥无双写。
      useChatStore().appendUser(sid, holder.delivered.segments)
    }
    return removed
  }

  function count(sid: string): number {
    let n = 0
    state.updateFor(sid, (p) => {
      n = p.messages.length
    })
    return n
  }

  function peek(sid: string): QueuedMessage[] {
    let snapshot: QueuedMessage[] = []
    state.updateFor(sid, (p) => {
      snapshot = p.messages.map((m) => ({ ...m }))
    })
    return snapshot
  }

  function hasPending(sid: string): boolean {
    return count(sid) > 0
  }

  /** [session-dead 结构性修复 D3] 整队回收（语义见接口 jsdoc）：快照取出 + 清空分区 */
  function drain(sid: string): QueuedMessage[] {
    let drained: QueuedMessage[] = []
    state.updateFor(sid, (p) => {
      drained = p.messages.map((m) => ({ ...m }))
      p.messages = []
    })
    return drained
  }

  // per-session in-flight 守卫（S2）：flush 进行中重复触发复用同一 promise，不重复发送。
  // 「同 key 复用 / settle 即清 / 引用比对防误删」生命周期收编于 createInflightDedup
  // （D9 共享原语，state-truth-sync §3.3）。
  const flushDedup = createInflightDedup<boolean>()

  function flush(sid: string): Promise<boolean> {
    return flushDedup.run(sid, () => doFlush(sid)).promise
  }

  async function doFlush(sid: string): Promise<boolean> {
    const snapshot = peek(sid)
    if (snapshot.length === 0) return true
    const store = useChatStore()
    const sessionStore = useSessionStore()
    // S1 per-entry：flush 窗口内订阅 send.rejected，按 clientUuid（= 条目 id，runtime 回带）
    // 归属到具体条目；无 uuid 的拒绝（旧 runtime / 异常帧）按 WS FIFO 归属「当前正在 await
    // 的条目」（基线计数差）。订阅仅存在于 flush 窗口，用户后续的 send.rejected 不影响判定。
    const rejectedUuids = new Set<string>()
    let uuidLessRejections = 0
    const unsub = events.on(sid, (msg: ServerMessage) => {
      if (msg.type !== 'send.rejected') return
      const uuid = (msg.payload as { clientUuid?: string }).clientUuid
      if (uuid) rejectedUuids.add(uuid)
      else uuidLessRejections += 1
    })
    try {
      // flush 前已存在在途提交（此前 flush 已提交未确认）→ 本轮全部走 steer：turn 已被
      // 之前的 send 启动，再发 send 会双 run 双投递。
      let sendChannelUsed = snapshot.some((m) => m.mode !== undefined)
      let uuidLessBase = uuidLessRejections
      const submitDeps = createSubmitEntryDeps(store, sessionStore)
      for (let i = 0; i < snapshot.length; i++) {
        const entry = snapshot[i]!
        // 实时查 live：确认帧到达/用户撤销已出队的条目跳过；已提交在途（mode 已写）跳过
        // 不重发（per-entry 记账——部分失败只重发未投递条目）。
        const live = findLive(sid, entry.id)
        if (!live || live.mode !== undefined) {
          uuidLessBase = uuidLessRejections
          continue
        }
        // 通道路由（D5.1 队首 send 语义的 flush 重入扩展）：本轮已有 send 提交或 turn 仍
        // 活跃（此前 send 启动的 run 在跑——含其确认帧已到、assistant 回复未收口的窗口）
        // → 全部 steer 并入当前 run，再发 send 会双 run 双投递；turn 不活跃 → 队首未提交
        // 条目走 send 启动新 run（对齐 useChat.send 的 B 策略 busy→steer 判据）。
        const channel: 'send' | 'steer' = (sendChannelUsed || store.isActive(sid)) ? 'steer' : 'send'
        // [defer segments 化 / D-A1-1] 提交时写 submitText（= segmentsToPrompt(segments)，
        // 幂等——重试重算同值）：core ①b 文本 FIFO 兜底的匹配源，须在确认帧可能到达前
        // 落条目（与 setEntryMode 同窗口，peek 快照对 ① 可见）。
        const submitText = live.submitText ?? segmentsToPrompt(live.segments)
        setEntrySubmitText(sid, entry.id, submitText)
        // 提交标记先于 RPC 写入：core ① 的匹配资格判据要求确认帧到达时 mode 已写；
        // 未投递路径（catch/S1）下方清除（重试重挂重标）。
        setEntryMode(sid, entry.id, channel)
        uuidLessBase = uuidLessRejections
        try {
          await submitQueuedEntry(sid, { id: entry.id, text: entry.text, segments: live.segments, submitText }, channel, submitDeps)
        } catch (e) {
          // RPC reject：消息未投出——留队 + 回滚占位（send 通道在 submitQueuedEntry 内挂的
          // inflight）+ 清提交标记 + 停止提交后续（后续条目依赖本条 send 注入的 run）。
          // [A1] 原始错误上抛（非 return false）：传输级真错误与 S1 busy 拒绝（下方留队
          // 静默自愈）分流——调用方（useChat occupancy handler）仅对上抛 toast「发送失败: {原因}」。
          if (channel === 'send') store.decrementInflight(sid, 1)
          setEntryMode(sid, entry.id, undefined)
          throw e
        }
        // S1 判定：WS FIFO（dispatcher 同步广播 → 同步 reply）保证 await 返回时本条的
        // rejected 已入集合/计数。触发 = 未实际投递：留队 + 回滚占位（重试时重挂）+ 清标记。
        if (rejectedUuids.has(entry.id) || uuidLessRejections > uuidLessBase) {
          if (channel === 'send') store.decrementInflight(sid, 1)
          setEntryMode(sid, entry.id, undefined)
          return false
        }
        if (channel === 'send') sendChannelUsed = true
      }
      // 全部提交成功：不出队（条目保持 mode 已写，等 message_end(user) 确认帧经 core ①
      // 逐条 confirmDelivery 出队 + 转态）。返回 true 仅表示提交编排完成。
      return true
    } finally {
      unsub()
    }
  }

  return { enqueue, remove, count, peek, hasPending, drain, confirmDelivery, flush, _clearAllForTest: state._clearAllForTest }
}

// [session-occupancy u4a / D5.3] 注册 defer 队列 provider（core effects/registry ① 的注入点）。
// 闭包惰性执行：首个 message_end(user) 帧处理时才调 useCompactQueue()——生产时序下单例
// 已由 App.vue setup 创建（app 级 effect scope，见上方单例注释），此处直接返回缓存实例。
// 未注册时 core ① 整体跳过（帧落现有处理链），注册失败方向安全。
setCompactQueueProviderForEffects(() => useCompactQueue())
