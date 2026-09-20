/**
 * MessageBus —— per-session 消息广播核心（wave:bus-core，D5 topic 三分类改造 wave:perf-w06）。
 *
 * 职责：维护每个 session 的环形缓冲（streamRing，仅 stream 类）+ 状态快照（stateSnapshot，
 * 仅 state 类）+ 订阅者集合（subscribers）。publish 按 topicOf(type) 三分类分流：
 * - state 类：分配 seq、写快照（同 key 覆盖）、不入 ring——last-value 语义，重连由快照恢复；
 * - stream 类：分配 seq、入 O(1) 环形缓冲（覆盖写）——可按 seq 回放；
 * - transient 类：不分配 seq、不入 ring、不写快照，直传订阅者——高频瞬时流（delta / terminal 输出），
 *   丢失可接受（routeInbound 对无 seq 消息直接 dispatch，core/coordination/subscription-state.ts evalSeqGap 分支 3）。
 *
 * gap 判定（R-03 裁决，wave:perf-w06）：**本模块不判定 gap**。旧实现 subscribe 返回的
 * `seqCounter > streamRing.length` gauge 是死代码（handler 用 `let gap = false` 覆盖丢弃，且
 * topic 分类后分子分母语义分裂——seqCounter 计 state+stream、ring 只存 stream——任何 state
 * 消息都会使该 gauge 恒真）。gap 只由 session-message-handler 的 `fromSeq < ring 最旧 seq`
 * 判定（基于 ring 拓扑，语义自洽）。
 *
 * 双向不变量（由 sessions 与 wsSubscriptions 两 Map 显式维护，测试覆盖）：
 *   ws ∈ sessions[sid].subscribers  ⟺  sid ∈ wsSubscriptions[ws]
 *
 * 不接线真实 WebSocket——BusClient 是最小契约（readyState + send），测试用 mock 注入。
 * seq 是 per-session 内部分配器，publish 时写入 ServerMessage.seq（protocol.ts 已定义可选字段），
 * 供 renderer routeInbound 做 gap 检测和去重。
 *
 * 字节预算（B7，memory-leak-remediation §3.3-B7 纯 A 方案）：条数有界（ringCapacity）之外补
 * 字节维度上限（ringBudgetBytes，默认 16MB/session，构造注入）——记账口径 = 实际入 ring 那份
 * 的字节数（截断档帧按 truncated 版计），超预算从最旧加速淘汰至回到预算内（下界 = 仅剩最新帧，
 * 允许瞬时超调）；stateSnapshot 纳入同款记账但仅观测（覆盖式当前值口径，超预算 warn 不驱逐）。
 * 单帧行为完全不变：wire≡ring 同一份（32MB 档既有截断照旧双写，8-32MB warn 档照旧双完整），
 * 不引入任何单帧截断/丢帧逻辑。
 *
 * 错误路径：
 * - ES1：clearSession 对不存在 session no-op（幂等）。
 * - ES2：unsubscribe / unsubscribeAll 对未订阅 ws no-op（幂等）。
 * - ES4：publish 广播时单个 ws.send 抛错——try/catch 兜底，单 ws 失败不影响其它 ws 与 publish 主流程。
 */
import type { ServerMessage } from '@taiji/shared'
import type { BusClient, SessionBusState, StreamRingBuffer } from './types.js'
import {
  type OutboundFrameGuardOptions,
  DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS,
  guardOutboundPushFrame,
} from './outbound-frame-registry.js'
import { getCrashJournal } from '../../infra/crash-journal.js'
// 组合根（index.ts）经本模块导入守卫默认值——省一条独立 import 行（index.ts max-lines 门禁），
// 阈值 SSOT 仍在 outbound-frame-registry（shared 常量的 registry 出口）。
export { DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS } from './outbound-frame-registry.js'

/**
 * 条件信号事件 → 崩溃台账（crash-forensics-and-watchdog §3.3 D1 写入点矩阵，u1e）。
 *
 * 出站守卫判定点与既有日志/守卫行为**同点双写**：告警档 → frame-truncated(warn-tier)、
 * 契约保持式截断档 → frame-truncated(trunc-tier)、注册表 miss（含替换后仍超限）→
 * registry-miss。守卫行为本身零改动（append 是 fire-and-forget 旁路，writer 未初始化时
 * no-op 单例、内部自吞异常——台账任何故障不反噬出站主链，D1 best-effort 语义）。
 * 事件是评估器条件 #1/#2 的数据源（附录 A）。
 */
function appendFrameJournal(event: 'frame-truncated' | 'registry-miss', reason: string, sessionId: string, detail: Record<string, unknown>): void {
  getCrashJournal().append({
    layer: 'runtime',
    event,
    reason,
    sessionId,
    detailDigest: JSON.stringify(detail),
  })
}

/** streamRing 默认容量（O(1) 覆盖写环形缓冲）。 */
const DEFAULT_RING_CAPACITY = 1000

/**
 * B7 ring 字节预算默认值（16MB/session，设计值——A9 已按设计值通过，维持 16MB，校准遗留 = 无，见设计待验证检查点 3）。
 * 条数上限（1000 帧）之外补字节维度上限：大帧（截图 base64、大 toolResult）场景下字节才是
 * 主导维度，1000 帧 × 32MB 理论上限无界。超预算从最旧加速淘汰至回到预算内（驱逐下界 =
 * 仅剩最新帧，单帧 truncated ≤32MB > 16MB 时允许瞬时超调）。
 */
import { RING_BUDGET_BYTES } from '@taiji/shared'

/**
 * topic 三分类（02 文档 D5-1）。
 *
 * - state：last-value 状态，新订阅者必须立即拿到当前值（写 stateSnapshot）。
 *   例外：state-no-key 混合形态——登记为 state 但刻意不入快照（详见 STATE_TYPE_KEY_MAP
 *   注释块「例外登记」，现仅 session.subagentEntriesAppended 一例）。
 * - stream：可回放的消息型事件（入 streamRing，按 seq 回放）。
 * - transient：高频瞬时流，丢失可接受（不分配 seq、不入 ring、不写快照）。
 */
export type TopicKind = 'state' | 'stream' | 'transient'

/**
 * D5-1 topic 分类表：session 级 push 型 ServerMessageType → 三分类。
 *
 * 收录范围 = session 级 push 型消息全集（含 W07/W08 将接 bus 的 6 类，本表按文档全集一次填齐）。
 * 不收录：RPC reply 型（*.result、session.subscribe/history/renamed 等走 reply 通道，无 seq/ring 语义）
 * 与全局消息（config.*、app.info、plugin:statusBar* 等 payload 无 sessionId，走 broker.broadcast）。
 *
 * **未入表类型的 fallback = 'stream'（R-07 裁决）**：与改造前语义一致（所有 publish 都入 ring），
 * 是唯一不产生行为回归的默认——fallback 到 transient 会静默丢消息（不可回放），fallback 到
 * state 需要快照键。新增消息类型忘记入表时走 stream 最安全。
 */
const TOPIC_TABLE: Readonly<Record<string, TopicKind>> = {
  // ── state 类：分配 seq、写快照（同 typeKey 覆盖）、不入 ring ──
  'session.commands': 'state',
  'context.update': 'state',
  'session.subagents': 'state',
  // plan 模式状态投影（plan 模式重设计 D1⑤）：last-value 单例状态——断连重连 / 切回
  // session 经 stateSnapshot 'plan' key 回放恢复。**必须入 STATE_TYPE_KEY_MAP**：
  // state 类但未映射 typeKey 的消息会走「不写快照」分支（stateTypeKey 返回 null），
  // 横幅/审批条在重连后将拿不到恢复帧（投影链六件套之一，缺则静默失效）。
  'session.planState': 'state',
  // E 方案（subagent-realtime-channel §4.3）：relay tee 产出的 subagent entry 增量帧。
  // state 类但刻意不进 STATE_TYPE_KEY_MAP——增量 entry 流不是 last-value 语义（快照
  // 覆盖会丢中间 entry），也不入 ring（subagent 长任务高频帧会冲刷主对话流的可回放
  // ring，制造主流 gap）。对账路径 = reducer 按 entry id 幂等 + 重开时 fetchAndInject
  // 快照（设计 §6.1-2「帧先于快照到达，reducer 幂等去重」）。
  'session.subagentEntriesAppended': 'state',
  'session.workflowUpdate': 'state',
  'session.state_changed': 'state',
  // occupancy（session-occupancy-send-closure P3）：占用三维快照。state topic last-value——
  // 断连重连 / 切回 session 经 stateSnapshot 回放恢复（G4），不依赖广播时序。
  'session.occupancy': 'state',
  // ── stream 类：分配 seq、入 ring（O(1) 覆盖写）──
  'message.message_start': 'stream',
  'message.complete': 'stream',
  'message.tool_call_start': 'stream',
  'message.tool_call_end': 'stream',
  'message.tool_call_update': 'stream',
  'message.error': 'stream',
  'message.status': 'stream',
  'send.rejected': 'stream',
  'message.bashStart': 'stream',
  'message.bashResult': 'stream',
  'message.compactionSummary': 'stream',
  'message.branchSummary': 'stream',
  'message.customStart': 'stream',
  'message.changeSetInvalidated': 'stream',
  'message.file_changes': 'stream',
  'message.auto_retry_start': 'stream',
  'message.auto_retry_end': 'stream',
  'message.queue_update': 'stream',
  'message.stream_error': 'stream',
  'session.compacting': 'stream',
  'session.compacted': 'stream',
  'session.exited': 'stream',
  // pi 崩溃自动恢复结果（crash-resilience D7，u8-pi-respawn）：一次性事件（非 last-value
  // 状态），stream 入 ring——断连重连 / 恢复后重订阅经回放补见恢复提示条（恢复发生时
  // renderer 订阅已被 bus.clearSession 清除，回放是提示条的主要送达通路）。
  'session.restored': 'stream',
  'session.restoreFailed': 'stream',
  'terminal.alive': 'stream',
  'terminal.exit': 'stream',
  'terminal.ack': 'stream',
  'plugin:uiRequest': 'stream',
  'extension.ui_request': 'stream',
  'extension:widget': 'stream',
  'extension:widgetGui': 'stream',
  'extension:status': 'stream',
  'extension:notify': 'stream',
  // extension:* 全族（event-adapter.ts setEditorText → session 级 push 型，W06-M1 补录）
  'extension:setEditorText': 'stream',
  // ── transient 类：不分配 seq、不入 ring、不写快照、直传 ──
  'message.text_delta': 'transient',
  'message.thinking_delta': 'transient',
  'message.thinking_start': 'transient',
  'message.thinking_end': 'transient',
  'subagent.stream_delta': 'transient',
  'terminal.data': 'transient',
  'message.stream_warn': 'transient',
  'plugin:viewUpdate': 'transient',
}

/**
 * topic 分类（D5-1）：查 TOPIC_TABLE，miss fallback = 'stream'（R-07）。
 *
 * @param type ServerMessage.type（wire 名，见 packages/shared/src/protocol.ts）
 */
export function topicOf(type: string): TopicKind {
  return TOPIC_TABLE[type] ?? 'stream'
}

/**
 * state topic 的 type → stateSnapshot typeKey 映射（D5-2，wave:perf-w06 补全修正）。
 *
 * 模块级常量（微项 3）：避免每次 publish 重建字面量对象。
 *
 * 修正记录（相对 wave:bus-core 占位版）：
 * - `session.workflowUpdate → 'workflows'`：原映射的 `session.workflows` 是 RPC reply 类型
 *   （getWorkflows 的 reply），运行时无 publish 点、快照键永远空（ADR-0055 3c）。改为映射有
 *   真实 publish 点的广播类型 `session.workflowUpdate`。workflow 全量数据仍靠 RPC loadWorkflows
 *   回流（ADR-0055 4a 现状，不在本设计范围改变）。
 * - 补 `session.state_changed → 'state_changed'`（修 ADR-0055 3b）：重连后 Composer 工具条
 *   从 stateSnapshot 恢复，而非回退 fallback 默认值。
 * - compactionSummary 保持不进快照（3d：靠 JSONL 持久化兜底，符合 AGENTS.md 关键规则 9）。
 *
 * 例外登记（state-no-key 混合形态）：`session.subagentEntriesAppended` 在 TOPIC_TABLE
 * 登记为 state 类，但刻意不在本表——无 typeKey、不入快照、不入 ring。理由：
 * ①增量 entry 流不是 last-value 语义（快照同 key 覆盖会丢中间 entry）；
 * ②subagent 长任务的高频帧若入 ring 会冲刷主对话流的可回放缓冲，制造主流 gap；
 * ③对账不靠快照/ring：renderer reducer 按 entry id 幂等去重 + 重开 session 时经
 * fetchAndInject 拉全量快照（设计 subagent-realtime-channel §6.1-2「帧先于快照到达，
 * reducer 幂等去重」）。TOPIC_TABLE 该行上方注释与此同源。
 */
const STATE_TYPE_KEY_MAP: Readonly<Record<string, string>> = {
  'session.commands': 'commands',
  'context.update': 'context',
  'session.subagents': 'subagents',
  // plan 模式状态投影（plan 模式重设计 D1⑤）：typeKey 'plan' 与 TOPIC_TABLE 的 state
  // 登记配对——未入本表的 state 类消息永不写快照（stateTypeKey 返回 null），投影链静默失效。
  'session.planState': 'plan',
  'session.workflowUpdate': 'workflows',
  'session.state_changed': 'state_changed',
  // occupancy（session-occupancy-send-closure P3）：last-value 快照 key，重连/切回 session
  // 时 subscribe 返回的 stateSnapshot 含此帧，renderer sessionPhase 从快照恢复（G4）。
  // 写快照/回放对 stateSnapshot Map 的任意 key 自动生效，无需其他登记点。
  'session.occupancy': 'occupancy',
}

/**
 * 把 ServerMessage.type 映射到 stateSnapshot 的 typeKey——同 typeKey 的新消息覆盖旧（状态去重语义）。
 * 返回 null 表示该消息不是 state topic。
 *
 * @param message 待判定消息
 * @returns typeKey（写入 stateSnapshot 的 key）或 null（非 state topic）
 */
function stateTypeKey(message: ServerMessage): string | null {
  return STATE_TYPE_KEY_MAP[message.type] ?? null
}

/**
 * IMessageBus —— session 级发布抽象（wave:perf-w09，02 文档 D1-2 / ADR-0055 7d 接口收敛）。
 *
 * 与 IMessageBroker 构成两个正交的发布通道（「同一发布抽象」的对偶面）：
 * - IMessageBus.publish(sessionId, msg)：**定向**通道——seq/ring/snapshot + 只推订阅该 sid 的连接。
 *   所有 session 级 push 型消息（payload 带 sessionId）的唯一出口。
 * - IMessageBroker.broadcast(msg)：**全局**通道——盲推所有连接，只服务无 sessionId 的全局消息
 *   （config.*、app.info、plugin:statusBar* 等，见 02 文档 D5-1 排除清单）。
 *
 * 消费方（SessionService / MessageDispatcher / PluginService / handlers）依赖本接口而非
 * MessageBus 具体类，与 IMessageBroker 的注入模式对齐。
 */
export interface IMessageBus {
  /** 发布 session 级消息（topic 三分类分流，见实现注释）。 */
  publish(sessionId: string, message: ServerMessage): void
  /** 订阅 session（返回 ring/state 快照 + lastSeq，gap 判定在 handler）。 */
  subscribe(sessionId: string, ws: BusClient): { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number }
  /** 取消单个 session 订阅（幂等）。 */
  unsubscribe(sessionId: string, ws: BusClient): void
  /** 取消该 ws 的所有 session 订阅（连接断开时调用，幂等）。 */
  unsubscribeAll(ws: BusClient): void
  /** 清除整个 session 状态（session 销毁时调用，幂等）。 */
  clearSession(sessionId: string): void
}

/**
 * per-session 消息广播核心。
 *
 * 两个 Map 显式管理 session 与订阅者：
 * - sessions：sessionId → SessionBusState（ring + snapshot + subscribers）。
 * - wsSubscriptions：ws → Set<sessionId>（反查表，unsubscribeAll 用它一次清掉该 ws 的所有订阅）。
 *
 * ringCapacity 是 ring 上限，构造时固定（默认 1000）。
 */
export class MessageBus implements IMessageBus {
  /** sessionId → SessionBusState。 */
  private readonly sessions = new Map<string, SessionBusState>()
  /** ws → Set<sessionId>（反查表，双向不变量维护 + unsubscribeAll 用）。 */
  private readonly wsSubscriptions = new Map<BusClient, Set<string>>()
  /** ring 容量（构造时固定）。 */
  private readonly ringCapacity: number
  /** ring 字节预算（B7，构造时固定；超预算从最旧加速淘汰）。 */
  private readonly ringBudgetBytes: number

  /**
   * @param ringCapacity streamRing 容量上限，默认 1000。满时 publish 覆盖写最旧槽位（O(1)）。
   * @param guardOptions 出站帧守卫选项（u4a：阈值参数化——生产默认 shared 常量 8MB/32MB；
   *   测试注入小阈值走真实行为逻辑，A10 阈值校准法同型）。resolveSessionFilePath 组合根
   *   可选注入（占位文案填 session 文件实路径；未注入走「见 runtime 日志」占位）。
   * @param ringBudgetBytes per-session ring 字节预算（B7，默认 16MB；阈值参数化对齐
   *   guardOptions 范式——测试注入小预算走真实驱逐逻辑）。stateSnapshot 纳入同款预算
   *   但仅观测（超预算 warn 不驱逐）。
   */
  constructor(
    ringCapacity: number = DEFAULT_RING_CAPACITY,
    private readonly guardOptions: OutboundFrameGuardOptions = DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS,
    ringBudgetBytes: number = RING_BUDGET_BYTES,
  ) {
    this.ringCapacity = ringCapacity
    this.ringBudgetBytes = ringBudgetBytes
  }

  /**
   * 发布消息到 session：按 topicOf(type) 三分类分流（D5-1），三类都序列化一次并推给订阅者。
   *
   * 出站帧守卫（u4a，crash-resilience D3）：超截断档（guardOptions.truncateBytes）的 push
   * 帧按「契约保持式截断」替换大字段为占位载荷（消息类型不变，截断版占 seq 入 ring/写快照/
   * 直传——客户端、ring 回放、重订阅拿到**同一份截断版**，seq 连续性 / gap 检测 / live≡reload
   * 不被破坏）；注册表 miss 或截断后仍超限 → 整条丢弃 + **seq 回滚**（该消息从未占用 seq，
   * 不触发 gap——被否方案④「占 seq 后丢弃」会触发 gap-重订阅失败死循环）。
   *
   * 时序实现（w09 TC-V1 契约：单条消息全程 JSON.stringify 恰好 1 次，守卫不得对小消息
   * 额外序列化）：seq 写入 → 序列化（唯一一次）→ 守卫按 wire 字节数判定——小消息零额外
   * 开销直接广播；超限才进入守卫决策（其内部序列化仅罕见路径发生），drop 时 seq 回滚，
   * 外部可观察语义与「seq 分配前整条丢弃」等价（同步单线程内无观察窗口）。
   *
   * 分流语义：
   * - state：++seq 写 message.seq → 写 stateSnapshot（同 typeKey 覆盖）→ 不入 ring。
   * - stream：++seq 写 message.seq → ringPush（满则覆盖最旧，O(1)）。
   * - transient：不分配 seq（消息保持无 seq 字段——调用方构造 push 消息不得自带 seq）、
   *   不入 ring、不写快照，直接序列化推送。
   *
   * 广播（三类共用）：readyState===1（OPEN）的 ws 调 send(序列化文本)；单个 ws.send 抛错
   * try/catch 兜底（ES4），不影响其它 ws 与 publish 主流程。序列化失败（循环引用等不可
   * 序列化载荷）→ seq 回滚 + 丢弃 + error 日志（u4a 零抛错：守卫设施不成为新崩溃源；
   * 原行为向调用方冒泡 stringify 异常，守卫语义下收紧为有痕丢弃）。
   *
   * @param sessionId 目标 session
   * @param message 待发布消息（广播时 JSON.stringify；注意 state/stream 类会原地写入
   *   message.seq（mutate 入参），transient 类保持原样不写字段）
   */
  publish(sessionId: string, message: ServerMessage): void {
    const state = this.getOrCreateSession(sessionId)
    const topic = topicOf(message.type)
    const isTransient = topic === 'transient'
    // state / stream 共用统一 seq 计数器（R-03：保住「全序」不变量；state 消息带 seq 推进
    // 订阅方 lastSeq 基线，只是不入 ring）。seq 必须在序列化前写入（wire 帧携带 seq）。
    if (!isTransient) {
      state.seqCounter += 1
      message.seq = state.seqCounter
    }
    let payload: string
    try {
      payload = JSON.stringify(message)
    } catch (e) {
      this.rollbackSeq(state, message, isTransient)
      console.error('[message-bus] publish payload serialization failed — message dropped:', e)
      return
    }
    const bytes = Buffer.byteLength(payload, 'utf8')
    if (bytes > this.guardOptions.truncateBytes) {
      // u4a：超截断档 → 契约保持式截断 / miss 兜底。守卫零 mutate 入参（不可变克隆替换，
      // 克隆随 spread 携带已写入的 seq），ring/快照/广播统一存截断版。
      const guarded = guardOutboundPushFrame(message, sessionId, this.guardOptions)
      if (guarded.action === 'dropped') {
        // u1e（crash-forensics D1）：注册表 miss（含替换后仍超限）→ registry-miss 台账
        // 事件（reason 保留守卫 dropReason 原值区分两形态）。评估器条件 #2 出现即 tripped。
        appendFrameJournal('registry-miss', guarded.dropReason, sessionId, {
          frameType: message.type,
          bytes: guarded.bytes,
          channel: 'push',
          dropReason: guarded.dropReason,
        })
        this.rollbackSeq(state, message, isTransient)
        return
      }
      if (guarded.action === 'replaced') {
        // u1e（crash-forensics D1）：契约保持式截断 → frame-truncated(trunc-tier)。
        appendFrameJournal('frame-truncated', 'trunc-tier', sessionId, {
          frameType: message.type,
          bytesBefore: guarded.bytesBefore,
          bytesAfter: guarded.bytesAfter,
          fieldPaths: guarded.fieldPaths,
          channel: 'push',
        })
      }
      const truncated = guarded.message
      // B7 记账口径（R3）：截断档帧入 ring 的是 truncated 版另行序列化——记账须用实际入
      // ring 那份的字节数，不可复用外层截断前 bytes（否则高估占用致过早驱逐）。该序列化
      // 与广播共用同一次（truncatedJson 只 stringify 一回）。单帧行为不变：wire 与 ring
      // 仍是同一份截断版（预算驱逐只影响 ring 驻留，不新增任何截断/丢帧）。
      const truncatedJson = JSON.stringify(truncated)
      const truncatedBytes = Buffer.byteLength(truncatedJson, 'utf8')
      if (!isTransient) {
        // 截断版替代原消息占位：stream 入 ring、state 写快照——回放/重订阅拿到同一份截断版。
        if (topic === 'state') {
          const typeKey = stateTypeKey(truncated)
          if (typeKey !== null) {
            this.setStateSnapshotEntry(state, typeKey, truncated, truncatedBytes, sessionId)
          }
        } else {
          this.ringPush(state.streamRing, truncated, truncatedBytes)
        }
      }
      this.broadcastText(state.subscribers, truncatedJson)
      return
    }
    if (bytes > this.guardOptions.warnBytes) {
      // u4a 告警档（8MB 哨兵）：不截断，warn 暴露（上游自截失效时先于此档可见）。
      console.warn(`[outbound-frame-guard] large outbound push frame (warn): type=${message.type} sessionId=${sessionId} bytes=${bytes}`)
      // u1e（crash-forensics D1）：告警档 → frame-truncated(warn-tier) 台账事件（评估器
      // 条件 #1 数据源，附录 A「周均 >10 次」按此事件窗口计数）。
      appendFrameJournal('frame-truncated', 'warn-tier', sessionId, {
        frameType: message.type,
        bytes,
        channel: 'push',
      })
    }
    if (isTransient) {
      // transient：不占 seq、不进 ring、不写快照——高频流直传，丢失可接受
      // （routeInbound 对无 seq 消息直接 dispatch，不做 gap 检测）。
      this.broadcastText(state.subscribers, payload)
      return
    }
    if (topic === 'state') {
      // state：写快照（同 typeKey 覆盖，状态去重语义），不入 ring。字节记账（B7）仅观测。
      const typeKey = stateTypeKey(message)
      if (typeKey !== null) {
        this.setStateSnapshotEntry(state, typeKey, message, bytes, sessionId)
      }
    } else {
      // stream：入 O(1) 环形缓冲（满则覆盖最旧 + B7 字节记账/超预算加速淘汰）。
      this.ringPush(state.streamRing, message, bytes)
    }
    this.broadcastText(state.subscribers, payload)
  }

  /**
   * seq 回滚（u4a drop/序列化失败路径）：seqCounter 退回 + 清除已写入的 message.seq——
   * 同步单线程内等价于「从未分配」，消息不占 seq 不触发 gap。transient 无 seq 可回滚。
   */
  private rollbackSeq(state: SessionBusState, message: ServerMessage, isTransient: boolean): void {
    if (isTransient) return
    state.seqCounter -= 1
    delete message.seq
  }

  /**
   * 订阅 session：加入 subscribers + 反查表，返回 ring 快照（按 seq 顺序）+ state 快照 + 最新 seq。
   *
   * gap 判定不在本模块（R-03）：由 session-message-handler 基于「fromSeq < ring 最旧 seq」判定。
   *
   * @param sessionId 目标 session
   * @param ws 订阅者（BusClient，满足 readyState + send 契约）
   * @returns snapshot/stateSnapshot 均为当前状态的浅拷贝；lastSeq 是当前 seqCounter
   */
  subscribe(sessionId: string, ws: BusClient): {
    snapshot: ServerMessage[]
    stateSnapshot: ServerMessage[]
    lastSeq: number
  } {
    const state = this.getOrCreateSession(sessionId)
    state.subscribers.add(ws)
    this.getOrCreateWsSubs(ws).add(sessionId)
    return {
      snapshot: this.exportRing(state.streamRing),
      stateSnapshot: [...state.stateSnapshot.values()],
      lastSeq: state.seqCounter,
    }
  }

  /**
   * 取消单个 session 订阅（幂等，ES2）。
   *
   * 从 sessions[sid].subscribers 与 wsSubscriptions[ws] 双向删除；
   * wsSubscriptions[ws] 集合空则 delete ws entry（防反查表累积空 Set）。
   *
   * @param sessionId 目标 session
   * @param ws 订阅者
   */
  unsubscribe(sessionId: string, ws: BusClient): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.subscribers.delete(ws)
    const subs = this.wsSubscriptions.get(ws)
    if (subs) {
      subs.delete(sessionId)
      if (subs.size === 0) {
        this.wsSubscriptions.delete(ws)
      }
    }
  }

  /**
   * 取消该 ws 的所有 session 订阅（连接断开时调用，幂等，ES2）。
   *
   * 遍历 wsSubscriptions[ws] 的全部 sid，逐个从 sessions[sid].subscribers 删除 ws；
   * 最后 delete wsSubscriptions[ws]。
   *
   * @param ws 订阅者
   */
  unsubscribeAll(ws: BusClient): void {
    const subs = this.wsSubscriptions.get(ws)
    if (!subs) return
    for (const sid of subs) {
      this.sessions.get(sid)?.subscribers.delete(ws)
    }
    this.wsSubscriptions.delete(ws)
  }

  /**
   * 清除整个 session 状态（session 销毁时调用，幂等，ES1）。
   *
   * 取 entry → 遍历其 subscribers 的每个 ws，从 wsSubscriptions[ws] 删除 sid
   * （集合空则 delete ws entry，维持反查表不累积空 Set）→ sessions.delete(sid)。
   *
   * @param sessionId 目标 session
   */
  clearSession(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    for (const ws of state.subscribers) {
      const subs = this.wsSubscriptions.get(ws)
      if (subs) {
        subs.delete(sessionId)
        if (subs.size === 0) {
          this.wsSubscriptions.delete(ws)
        }
      }
    }
    this.sessions.delete(sessionId)
  }

  /**
   * ring 写入（D5-3 O(1) 覆盖写 + B7 字节记账/超预算加速淘汰）：写入 (head + size) % capacity
   * 槽位；满时 head 前移（最旧元素被覆盖，同步扣减其字节）。无数组搬移，单条写入 O(1)。
   *
   * B7 记账：push 累计 frameBytes（实际入 ring 那份的字节——截断档帧是 truncated 版的
   * 序列化字节数）；容量覆盖写与预算驱逐淘汰时扣减。超预算（ringBudgetBytes，默认
   * 16MB）从最旧加速淘汰至回到预算内——ring 保持「最近 N 帧或 M 字节内」语义，
   * live 流量与 wire 行为不变（驱逐段回放静默缺失，切回 session 时 getHistory hydrate
   * 补齐，见设计代价四要素）。
   *
   * 驱逐下界（R4，影响 S4）：淘汰至「仅剩最新帧」即停、允许瞬时超调——单帧 truncated
   * ≤32MB > 16MB 预算时不误逐刚 push 帧也不死循环（循环条件 size > 1 结构性保证）。
   *
   * @param ring 目标环形缓冲
   * @param message 待写入消息（实际入 ring 的那份——截断档帧传 truncated 版）
   * @param frameBytes 实际入 ring 那份的序列化字节数（与 wire 同源，不可用截断前 bytes）
   */
  private ringPush(ring: StreamRingBuffer, message: ServerMessage, frameBytes: number): void {
    const cap = ring.buf.length
    // 容量 0 = 不保留 ring 历史（与旧 push/shift 实现在 capacity=0 下的行为等价），且避开 %0 NaN。
    if (cap === 0) return
    const pos = (ring.head + ring.size) % cap
    if (ring.size < cap) {
      ring.size += 1
    } else {
      // 满：写入位置即最旧元素位置，head 前移一格完成淘汰（+ 记账扣减被覆盖帧字节）。
      ring.bytes -= ring.slotBytes[pos]
      ring.head = (ring.head + 1) % cap
    }
    ring.buf[pos] = message
    ring.slotBytes[pos] = frameBytes
    ring.bytes += frameBytes
    // 超预算加速淘汰：从最旧起逐帧淘汰至回到预算内；下界 = 仅剩最新帧（size > 1），
    // 单帧自身超预算时瞬时超调驻留，不逐刚 push 帧不死循环。
    while (ring.bytes > this.ringBudgetBytes && ring.size > 1) {
      this.evictOldest(ring)
    }
  }

  /**
   * B7：淘汰最旧帧——引用置 undefined（释放驻留对象）+ 记账扣减 + head/size 前移。
   * 不触 seqCounter / subscribers：驱逐只影响 ring 驻留窗口，seq 连续性与 gap 判定
   * （handler 的 fromSeq < ring 最旧 seq）自动适应变短的窗口。
   */
  private evictOldest(ring: StreamRingBuffer): void {
    const cap = ring.buf.length
    ring.buf[ring.head] = undefined
    ring.bytes -= ring.slotBytes[ring.head]
    ring.slotBytes[ring.head] = 0
    ring.head = (ring.head + 1) % cap
    ring.size -= 1
  }

  /**
   * B7：stateSnapshot 写入 + 字节记账（**仅观测**，超预算 warn 不驱逐）。
   *
   * 覆盖式当前值口径：同 typeKey set 替换时按新值重计（差值语义），非累计求和——
   * 否则同 key 反复 set 会虚假推高水位触发假 warn。typeKey 集合固定（7 个，plan 模式
   * 重设计 D1⑤ 加员 'plan' 后），每次重算总和 O(7)。该 warn 同时作为回收态 state 快照的
   * 跟进信号（回收态 ring 驻留
   * 已有界、state 快照不受帽的 P3 语义维持——观测先行，对齐「看门狗不武装先观测」哲学）。
   */
  private setStateSnapshotEntry(
    state: SessionBusState,
    typeKey: string,
    message: ServerMessage,
    bytes: number,
    sessionId: string,
  ): void {
    state.stateSnapshot.set(typeKey, message)
    state.stateSnapshotBytes.set(typeKey, bytes)
    let total = 0
    for (const b of state.stateSnapshotBytes.values()) {
      total += b
    }
    if (total > this.ringBudgetBytes) {
      console.warn(
        `[message-bus] stateSnapshot bytes over budget (observe-only, no eviction): sessionId=${sessionId} typeKey=${typeKey} totalBytes=${total} budget=${this.ringBudgetBytes}`,
      )
    }
  }

  /**
   * ring 快照导出（D5-3）：按 seq 顺序（最旧 → 最新）从 head 起走 size 步的浅拷贝新数组。
   * 外部修改返回数组不影响 ring 内部（浅拷贝语义与旧版一致）。
   */
  private exportRing(ring: StreamRingBuffer): ServerMessage[] {
    const out: ServerMessage[] = new Array(ring.size)
    const cap = ring.buf.length
    for (let i = 0; i < ring.size; i++) {
      out[i] = ring.buf[(ring.head + i) % cap]!
    }
    return out
  }

  /**
   * 遍历推送订阅者（三类 topic 共用出口）。接收 publish 已序列化的文本（w09 TC-V1 契约：
   * 单条消息全程恰好 1 次 stringify——序列化在 publish 顶部完成，本方法不再 stringify）。
   * readyState!==1 跳过；单个 ws.send 抛错 ES4 兜底（不 rethrow，继续下一个 ws）。
   */
  private broadcastText(subscribers: Set<BusClient>, payload: string): void {
    for (const ws of subscribers) {
      if (ws.readyState !== 1) continue
      try {
        ws.send(payload)
      } catch (e) {
        // ES4：单个 ws.send 抛错（连接已断 / 内部异常）不应影响其它订阅者或 publish 主流程。
        console.warn('[message-bus] ws.send failed during publish:', e)
      }
    }
  }

  /**
   * lazy 创建 session 状态（首次 publish/subscribe 时建 entry）。
   * seqCounter 从 0 起（首次 publish 后变 1）；ring 是 ringCapacity 定长空缓冲。
   */
  private getOrCreateSession(sessionId: string): SessionBusState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        seqCounter: 0,
        streamRing: {
          buf: new Array(this.ringCapacity),
          head: 0,
          size: 0,
          bytes: 0,
          slotBytes: new Array(this.ringCapacity).fill(0),
        },
        stateSnapshot: new Map(),
        stateSnapshotBytes: new Map(),
        subscribers: new Set(),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * lazy 创建 wsSubscriptions[ws] 反查集合。
   */
  private getOrCreateWsSubs(ws: BusClient): Set<string> {
    let subs = this.wsSubscriptions.get(ws)
    if (!subs) {
      subs = new Set()
      this.wsSubscriptions.set(ws, subs)
    }
    return subs
  }
}
