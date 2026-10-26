/**
 * subagent tee 翻译层（M3 relay-spawn-transport §3.3 D6 / §3.4.4；自 relay-tee.ts
 * 迁移改名——翻译逻辑行为不变，新增 degraded 显式降级标注）。
 *
 * 每个 raw mirror record 一个实例：镜像字节（引擎 fd3 的 stdout 原始行）→
 * event-adapter 纯翻译函数（PiEvent → PiTranslatedEvent[]，独立实例语义——不与主 pi
 * 会话的 adapter/interpreter 共享任何状态）→ entry 化提取 → WS 帧广播：
 *   ① session.subagentEntriesAppended {sessionId: mainSid, subagentId: recordId, entries}
 *      ——终态权威，前端虚拟分区喂 applyEntry（与主对话流 message.message_end /
 *      tool_call_* 帧的 entry 形态同构，live ≡ reload 构造性成立）；
 *   ② subagent.stream_chunk {sessionId: 虚拟分区 id, recordId, msgSeq, deltaSeq, delta}
 *      ——text_delta 增量内容推送（B2 subagent-stream-chunk §4.2：delta 原样转发，双序号
 *      标识拼合位置；msgSeq = per-record assistant 消息序号从 1 起、message_start 递进，
 *      deltaSeq = per-message 从 0 递增；transient 直传，断连即丢，失步/接入走
 *      session.getSubagentStreamState 拉取）；
 *   ③ subagent.stream_delta {lines: undefined, msgSeq} ——assistant 定稿清除信号（R 路径
 *      只产清除形态，不再携带 lines 全文；msgSeq 为 additive 字段，消费端据此置定稿水位；
 *      携带 lines 全文的形态余留 widget 通道 W 路径使用）。
 *
 * 状态查询入口 getStreamState()：同步读当前流三元组 (msgSeq, 已发 delta 数, textAccumulated)
 * 的只读派生视图（形状与 session.getSubagentStreamState reply payload 逐字段一致），供 RPC 层
 * 原样透传；不保留任何 delta 历史或切分边界索引（拉取语义 = 当前全量状态，非历史区间）。
 *
 * [M3 D6 degraded]：镜像 seq 空洞（写侧丢弃/丢失）由读取侧检测并调用
 * {@link SubagentTee.markDegraded}——此后停止发布 live entries/chunks（feed 变 no-op），
 * getStreamState 以 `degraded: true` 显式标注；reload 仍从 pi session/JSONL 恢复完整历史
 * （tee 是实时派生视图，不是第二份权威）。
 *
 * entry 原样透传（不在此层做内容截断）：image 块（toolResult content 的 base64）与
 * 输出文本的 live 可见性依赖完整透传，此前本层曾对 >256KB 的 toolResult 做整体替换
 * 截断——图片/文本/details 全部丢失且 reload 路径才恢复，与主会话 tool_call_end 帧
 * （无此层截断）形成通道水位劈叉。量级防护单点在下游出站检查
 * （outbound-frame-registry 已注册 session.subagentEntriesAppended：8MB 告警档 +
 * 32MB 契约保持式截断，与主会话帧同一防线）。
 *
 * 隔离范式（对齐 interpreter W1 per-event try-catch）：单事件（单行）翻译/提取/发布失败
 * 只丢弃该事件 + warn（含 recordId 与原始字节 tail），不连坐后续事件、不影响编排通路、
 * 不杀进程。连续 ≥TEE_MAX_CONSECUTIVE_FAILURES 失败 → 放弃该 record 的 tee 分支
 * （feed 变 no-op，drawer 降级快照 + reload 路径）。
 *
 * stderr 不进 tee（镜像通道只有 stdout）；record 结束/通道关闭由读取侧调 dispose
 * （行缓冲/累积文本/锚点缓存全释放）。
 */
import type { ServerMessage, ServerMessageMap } from '@taiji/shared'
import { subagentVirtualId } from '@taiji/shared'
import type { PiEntry, PiMessageEntry, PiToolCallEntryForm } from '@taiji/shared'
import { logger } from '../logger.js'
import { toErrorMessage } from '../../utils/errors.js'
import { translate } from '../pi/event-adapter.js'
import type { PiEvent } from '../pi/pi-protocol.js'
import type { PiTranslatedEvent } from '../../services/session/types.js'

/** 连续失败放弃阈值（§4.3：如 ≥50）。 */
export const TEE_MAX_CONSECUTIVE_FAILURES = 50

/** warn 日志里原始字节 tail 的长度上限（诊断够用即可，不刷屏）。 */
const TEE_LOG_TAIL_BYTES = 200

/** 帧发布端口（组合根注入 messageBus.publish 的定向包装）。 */
export type SubagentTeePublish = (sessionId: string, msg: ServerMessage) => void

export type SubagentTeeOptions = {
  /** 主 session id（帧归属 + bus 路由键）；M3 下 = control 通道的 rootSessionId。 */
  mainSessionId: string
  /** record id（虚拟分区第三段；镜像帧按 recordId 归属）。 */
  recordId: string
  /** WS 帧发布（组合根注入 messageBus.publish 的定向包装）。 */
  publish: SubagentTeePublish
}

/**
 * 流状态只读快照（getStreamState 返回形状，与 shared 协议 session.getSubagentStreamState
 * reply payload 逐字段一致——RPC 层路由到对应 tee 原样透传）。
 */
export type SubagentTeeStreamState = {
  /** 该 record 当前有进行中的 assistant 流（未开始/已定稿/已销毁 = false，此时其余字段恒 0/0/[]）。 */
  found: boolean
  /** 当前 assistant 消息序号（从 1 起，message_start 递进）。 */
  msgSeq: number
  /** 当前消息已含到第几条 delta（最后一条 chunk 的 deltaSeq；尚无 delta = -1）。 */
  lastDeltaSeq: number
  /** 当前消息累积全文（textAccumulated 的 split('\n') 形态，与旧 stream_delta payload 的 lines 同形）。 */
  lines: string[]
  /**
   * [M3 D6] 镜像降级标注（additive，缺省不出现）：seq 空洞/镜像丢弃 → true；此后
   * live 发布已停止，drawer 显式提示 reload 查看完整历史。非降级形态不带本字段
   * （既有消费方逐字段相等断言不破）。
   */
  degraded?: boolean
}

/** tee 侧轻量帧序状态（与 interpreter 的同名字段同构但独立持有，见类注释）。 */
type TeeFrameState = {
  /** 当前 assistant 消息翻译层 messageId（toolCall entry 挂载目标）。 */
  currentMessageId: string | undefined
  /** toolCallId → contentIndex 产出顺序锚点（pi toolcall_start，消费后删除）。 */
  toolCallContentIndex: Map<string, number>
  /** 当前 assistant 消息的 text 累积（chunk 流的拉取数据源，getStreamState lines 形态）。 */
  textAccumulated: string
  /** per-record assistant 消息序号（chunk.msgSeq，从 1 起——首条 message_start 递进到 1）。 */
  msgSeq: number
  /** 当前消息已发布 delta 条数（下一条 chunk 的 deltaSeq；per-message 从 0 递增）。 */
  deltaSeq: number
  /** 当前 assistant 消息进行中（message_start 已见、message_end 未到）——found 判据。 */
  inFlight: boolean
}

export class SubagentTee {
  /** 行缓冲（镜像帧是行级载荷，拼接后仍按 JSONL 行边界翻译）。 */
  private lineBuffer = ''
  private state: TeeFrameState | null = {
    currentMessageId: undefined,
    toolCallContentIndex: new Map(),
    textAccumulated: '',
    msgSeq: 0,
    deltaSeq: 0,
    inFlight: false,
  }
  private consecutiveFailures = 0
  private _abandoned = false
  private _degraded = false
  private readonly virtualId: string

  constructor(private readonly opts: SubagentTeeOptions) {
    // [btw-question D9③ / M1-a 键中段位约定] 虚拟键中段 = owner 会话的 piSessionId。
    // W4a 键统一后 opts.mainSessionId 本身就是 pi 真实会话 id（btw 线按 piId 注册、
    // bus 路由键 = piId）——旧的「btw vid 先 extract 再入键」翻译层删除，直接传参
    // （设计 §3.3.6 迁移表：2 处直接传参之一）。INVAR-1.1 值域断言（中段禁冒号）
    // 对 pi id 恒过。
    this.virtualId = subagentVirtualId(opts.mainSessionId, opts.recordId)
  }

  /** tee 分支是否已放弃（放弃后读取侧停止喂入，live 流降级快照 + reload 路径）。 */
  get abandoned(): boolean {
    return this._abandoned
  }

  /** 镜像是否已降级（M3 D6：seq 空洞/帧损坏 → 停止发布，状态查询带 degraded 标注）。 */
  get degraded(): boolean {
    return this._degraded
  }

  /**
   * [M3 D6] 标记降级：停止后续 live 发布（feed 变 no-op），getStreamState 带
   * `degraded: true`。幂等；不 dispose（状态快照保留给查询，reload 路径不受影响）。
   */
  markDegraded(): void {
    this._degraded = true
    this.lineBuffer = ''
  }

  /** 镜像字节入口（同一 record 的读取侧按到达顺序喂入；降级/放弃后为 no-op）。 */
  feed(bytes: Buffer): void {
    if (this._abandoned || this._degraded || this.state === null) return
    this.lineBuffer += bytes.toString('utf-8')
    // 仅处理完整行；残留尾部留缓冲等下一批字节
    let nl = this.lineBuffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.lineBuffer.slice(0, nl)
      this.lineBuffer = this.lineBuffer.slice(nl + 1)
      if (line.trim().length > 0) {
        this.handleLine(line)
        if (this._abandoned) return
      }
      nl = this.lineBuffer.indexOf('\n')
    }
  }

  /** 销毁实例（record 结束/通道关闭时读取侧调用）：缓冲全释放。幂等。 */
  dispose(): void {
    this.state = null
    this.lineBuffer = ''
  }

  /**
   * 流状态查询入口（B2 subagent-stream-chunk §4.2，session.getSubagentStreamState RPC 的
   * 数据源）：同步读当前流状态的只读派生视图，返回形状与 reply payload 逐字段一致——RPC 层
   * 原样透传，不再二次派生视图。
   *
   * - found = 有进行中的 assistant 流（message_start 已见且未 message_end）。未开始 /
   *   已定稿 / dispose 后 = false，其余字段按协议恒 0 / 0 / []；
   * - lastDeltaSeq = 当前消息已含到第几条 delta（最后一条 chunk 的 deltaSeq = 已发条数-1；
   *   尚无 delta = -1——消费端 expectedDeltaSeq 重置为 水位+1 = 0，首条 chunk 不被去重误丢）。
   * - degraded = [M3 D6] 镜像降级标注（仅在 true 时出现，additive）。
   *
   * 无锁：JS 事件循环单线程，与 feed 消费同一调用队列串行，读到的三字段出自同一状态刻度
   * （执行结构本身保证一致）。不保留任何 delta 历史或切分边界索引——拉取语义是「当前全量
   * 状态」，不是「历史区间」。
   */
  getStreamState(): SubagentTeeStreamState {
    const state = this.state
    if (state === null || !state.inFlight) {
      return this._degraded
        ? { found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [], degraded: true }
        : { found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] }
    }
    const snapshot: SubagentTeeStreamState = {
      found: true,
      msgSeq: state.msgSeq,
      lastDeltaSeq: state.deltaSeq - 1,
      lines: state.textAccumulated.split('\n'),
    }
    if (this._degraded) snapshot.degraded = true
    return snapshot
  }

  private handleLine(line: string): void {
    // W1 同款隔离边界：单事件（单行）失败只丢弃本事件。JSON.parse 失败（坏字节/半行）、
    // translate 抛错、entry 形态异常、publish 抛错都落这里——后续事件照常。
    try {
      const event = JSON.parse(line) as PiEvent
      if (typeof event !== 'object' || event === null || typeof event.type !== 'string') {
        throw new Error(`not a pi event object (type=${String((event as { type?: unknown }).type)})`)
      }
      const state = this.state!
      const entries: Array<PiEntry | PiToolCallEntryForm> = []
      const translated = translate(event, this.virtualId)
      for (const ev of translated) {
        this.consumeEvent(ev, state, entries)
      }
      if (entries.length > 0) {
        this.opts.publish(this.opts.mainSessionId, {
          type: 'session.subagentEntriesAppended',
          payload: {
            sessionId: this.opts.mainSessionId,
            subagentId: this.opts.recordId,
            entries,
          },
        })
      }
      this.consecutiveFailures = 0
    } catch (err: unknown) {
      this.consecutiveFailures += 1
      // 字节 tail：截原文而不是序列化异常对象，保留现场
      const tail = line.length > TEE_LOG_TAIL_BYTES ? `${line.slice(0, TEE_LOG_TAIL_BYTES)}…` : line
      logger.warn(
        `[subagent-tee] event dropped (isolated) recordId=${this.opts.recordId} consecutive=${this.consecutiveFailures} tail=${tail} ${toErrorMessage(err)}`,
      )
      if (this.consecutiveFailures >= TEE_MAX_CONSECUTIVE_FAILURES) {
        this._abandoned = true
        logger.warn(
          `[subagent-tee] abandoned after ${this.consecutiveFailures} consecutive failures recordId=${this.opts.recordId} — drawer degrades to snapshot/reload`,
        )
        this.dispose()
      }
    }
  }

  /**
   * 单个翻译事件消费：提取 entry 形态 / 维护 text 累积与锚点缓存。
   *
   * 只提取 GUI 可见载体（message_end 的 message entry、tool_execution_* 的 toolCall/
   * toolResult entry、text_delta 的打字机）；interpreter 的副作用类事件（diff/hook/
   * 回写/status 路由）对只读旁路无意义，全部跳过——tee 不回写任何 session 状态。
   */
  private consumeEvent(ev: PiTranslatedEvent, state: TeeFrameState, entries: Array<PiEntry | PiToolCallEntryForm>): void {
    switch (ev.kind) {
      case 'message': {
        const t = ev.message.type
        if (t === 'message.message_start') {
          // 新 assistant 消息：记录挂载目标 + 重置 text 累积（上一条的中间态已被其
          // message_end 的 entry 定稿取代）。B2 chunk 契约：消息边界推进——msgSeq 递进
          //（从 1 起）、deltaSeq 归零、流进入 in-flight。翻译层对 user/system/toolResult
          // 的 message_start 产 noop（event-adapter handleMessageStart），此处只见 assistant
          // turn，msgSeq 即 per-record assistant 消息序号。
          const messageId = (ev.message.payload as { messageId?: unknown }).messageId
          state.currentMessageId = typeof messageId === 'string' ? messageId : undefined
          state.textAccumulated = ''
          state.msgSeq += 1
          state.deltaSeq = 0
          state.inFlight = true
          return
        }
        if (t === 'message.text_delta') {
          const delta = (ev.message.payload as { delta?: unknown }).delta
          if (typeof delta !== 'string') return
          // B2：内容改走增量 chunk（delta 原样转发 + 双序号标识拼合位置）。R 路径不再产生
          // 携带 lines 全文的 stream_delta（该形态余留 W 路径产生端）。
          this.opts.publish(this.opts.mainSessionId, {
            type: 'subagent.stream_chunk',
            payload: {
              sessionId: this.virtualId,
              recordId: this.opts.recordId,
              msgSeq: state.msgSeq,
              deltaSeq: state.deltaSeq,
              delta,
            },
          })
          // publish 成功后才进累积与序号：保持不变量「textAccumulated = delta
          // 0..deltaSeq-1 拼接」——publish 抛错走 W1 单事件隔离丢弃时两者同步不含本条，
          // getStreamState 拉取回放不失配（孤儿 delta 不在 lines 里重复显示）。
          state.textAccumulated += delta
          state.deltaSeq += 1
          return
        }
        if (t === 'message.message_end') {
          const entry = (ev.message.payload as { entry?: unknown }).entry as PiMessageEntry | undefined
          if (entry === undefined) return
          entries.push(entry)
          const role = entry.message?.role
          if (role === 'assistant') {
            // assistant 定稿 → 清除打字机中间态（协议注释：lines undefined = 终态清除）。
            // B2 additive：payload 增 msgSeq（消费端据此置 sealedMsgSeq 定稿水位）；shared
            // 协议已登记 msgSeq?: number（additive）——本地交叉类型把可选收窄
            // 为必填，防清除帧漏带 msgSeq 时静默通过类型检查。
            state.inFlight = false
            const clearPayload: ServerMessageMap['subagent.stream_delta'] & { msgSeq: number } = {
              sessionId: this.virtualId,
              recordId: this.opts.recordId,
              lines: undefined,
              msgSeq: state.msgSeq,
            }
            this.opts.publish(this.opts.mainSessionId, {
              type: 'subagent.stream_delta',
              payload: clearPayload,
            })
            state.textAccumulated = ''
          }
          return
        }
        return
      }
      case 'tool-call-index':
        state.toolCallContentIndex.set(ev.toolCallId, ev.contentIndex)
        return
      case 'tool-call-start': {
        // 锚点补齐对齐 interpreter handleToolCallStart（无 hook——tee 是只读旁路，input 原样）
        const contentIndex = state.toolCallContentIndex.get(ev.toolCallId)
        if (contentIndex !== undefined) ev.entry.contentIndex = contentIndex
        if (state.currentMessageId !== undefined) ev.entry.messageId = state.currentMessageId
        state.toolCallContentIndex.delete(ev.toolCallId)
        entries.push(ev.entry)
        return
      }
      case 'tool-call-end':
        entries.push(ev.entry)
        return
      default:
        // turn-start/turn-end/status/hook/... 等：tee 不做编排副作用，entry 载体已在
        // message/tool-call 分支覆盖
        return
    }
  }
}
