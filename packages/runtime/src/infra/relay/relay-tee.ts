/**
 * relay tee 翻译层。
 *
 * 每个注册的 relay 子进程一个实例：child stdout 字节 → event-adapter 纯翻译函数
 * （PiEvent → PiTranslatedEvent[]，独立实例语义——不与主 pi 会话的 adapter/interpreter
 * 共享任何状态）→ entry 化提取 → 两种 WS 帧广播：
 *   ① session.subagentEntriesAppended {sessionId: mainSid, subagentId: recordId, entries}
 *      ——终态权威，前端虚拟分区喂 applyEntry（与主对话流 message.message_end /
 *      tool_call_* 帧的 entry 形态同构，live ≡ reload 构造性成立）；
 *   ② subagent.stream_delta ——text_delta 中间态打字机（续用既有帧，lines 是累积全文
 *      split('\n')，与 extension widget 通道 A-1 的 payload 语义逐字段一致，前端零感知
 *      切换；payload.sessionId 改为虚拟分区 id）。
 *
 * 隔离范式（对齐 interpreter W1 per-event try-catch）：单事件（单行）翻译/提取/发布失败
 * 只丢弃该事件 + warn（含 recordId 与原始字节 tail），不连坐后续事件、不影响编排通路
 * （转发分支在 registry，不经 tee）、不杀进程。连续 ≥TEE_MAX_CONSECUTIVE_FAILURES 失败
 * → 放弃该子进程的 tee 分支（feed 变 no-op，drawer 降级快照 + reload 腿）。
 *
 * stderr 不进 tee（只转发，registry 负责）；子进程 exit 由 registry 调 dispose 销毁
 * （行缓冲/累积文本/锚点缓存全释放）。
 */
import type { ServerMessage } from '@taiji/shared'
import { subagentVirtualId } from '@taiji/shared'
import type { PiEntry, PiMessageEntry, PiToolCallEntryForm } from '@taiji/shared'
import { translate } from '../pi/event-adapter.js'
import type { PiEvent } from '../pi/pi-protocol.js'
import type { PiTranslatedEvent } from '../../services/session/types.js'

/** 连续失败放弃阈值（§4.3：如 ≥50）。 */
export const TEE_MAX_CONSECUTIVE_FAILURES = 50

/** KB 换算常数（与 logger.ts 先例同款，消 magic number）。 */
const BYTES_PER_KB = 1024
/** tool result entry 截断阈值 KB 数（§10-3 缓解）。 */
const TEE_TOOL_RESULT_MAX_KB = 256
/** tool result entry 截断阈值（§10-3 缓解：超限只投截断摘要，完整内容留给 reload 腿）。 */
export const TEE_TOOL_RESULT_MAX_BYTES = TEE_TOOL_RESULT_MAX_KB * BYTES_PER_KB

/** warn 日志里原始字节 tail 的长度上限（诊断够用即可，不刷屏）。 */
const TEE_LOG_TAIL_BYTES = 200

export interface RelayTeeOptions {
  /** 主 session id（帧归属 + bus 路由键）。 */
  mainSessionId: string
  /** record id（虚拟分区第三段）。 */
  recordId: string
  /** WS 帧发布（组合根注入 messageBus.publish 的定向包装）。 */
  publish: (sessionId: string, msg: ServerMessage) => void
}

/** tee 侧轻量帧序状态（与 interpreter 的同名字段同构但独立持有，见类注释）。 */
interface TeeFrameState {
  /** 当前 assistant 消息翻译层 messageId（toolCall entry 挂载目标）。 */
  currentMessageId: string | undefined
  /** toolCallId → contentIndex 产出顺序锚点（pi toolcall_start，消费后删除）。 */
  toolCallContentIndex: Map<string, number>
  /** 当前 assistant 消息的 text 累积（stream_delta 的 lines 累积全文语义）。 */
  textAccumulated: string
}

export class RelayTee {
  /** 行缓冲（child stdout 是字节流，JSONL 行边界不保证与 read 边界对齐）。 */
  private lineBuffer = ''
  private state: TeeFrameState | null = {
    currentMessageId: undefined,
    toolCallContentIndex: new Map(),
    textAccumulated: '',
  }
  private consecutiveFailures = 0
  private _abandoned = false
  private readonly virtualId: string

  constructor(private readonly opts: RelayTeeOptions) {
    this.virtualId = subagentVirtualId(opts.mainSessionId, opts.recordId)
  }

  /** tee 分支是否已放弃（放弃后 registry 停止喂入，转纯转发）。 */
  get abandoned(): boolean {
    return this._abandoned
  }

  /** child stdout 字节入口（与转发分支同一次读取顺序分发——registry 先转发再 tee）。 */
  feed(bytes: Buffer): void {
    if (this._abandoned || this.state === null) return
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

  /** 销毁实例（子进程 exit 时 registry 调用）：缓冲全释放。幂等。 */
  dispose(): void {
    this.state = null
    this.lineBuffer = ''
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
      console.warn(
        `[relay-tee] event dropped (isolated) recordId=${this.opts.recordId} consecutive=${this.consecutiveFailures} tail=${tail}`,
        err instanceof Error ? err.message : err,
      )
      if (this.consecutiveFailures >= TEE_MAX_CONSECUTIVE_FAILURES) {
        this._abandoned = true
        console.warn(
          `[relay-tee] abandoned after ${this.consecutiveFailures} consecutive failures recordId=${this.opts.recordId} — drawer degrades to snapshot/reload`,
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
          // message_end 的 entry 定稿取代）
          const messageId = (ev.message.payload as { messageId?: unknown }).messageId
          state.currentMessageId = typeof messageId === 'string' ? messageId : undefined
          state.textAccumulated = ''
          return
        }
        if (t === 'message.text_delta') {
          const delta = (ev.message.payload as { delta?: unknown }).delta
          if (typeof delta !== 'string') return
          state.textAccumulated += delta
          this.opts.publish(this.opts.mainSessionId, {
            type: 'subagent.stream_delta',
            payload: {
              sessionId: this.virtualId,
              recordId: this.opts.recordId,
              // A-1 帧语义：lines 是累积全文 split('\n')——前端「零感知切换」的字段级依据
              lines: state.textAccumulated.split('\n'),
            },
          })
          return
        }
        if (t === 'message.message_end') {
          const entry = (ev.message.payload as { entry?: unknown }).entry as PiMessageEntry | undefined
          if (entry === undefined) return
          entries.push(this.truncateToolResultIfNeeded(entry))
          const role = entry.message?.role
          if (role === 'assistant') {
            // assistant 定稿 → 清除打字机中间态（协议注释：lines undefined = 终态清除）
            this.opts.publish(this.opts.mainSessionId, {
              type: 'subagent.stream_delta',
              payload: { sessionId: this.virtualId, recordId: this.opts.recordId, lines: undefined },
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
        entries.push(this.truncateToolResultIfNeeded(ev.entry))
        return
      default:
        // turn-start/turn-end/status/hook/... 等：tee 不做编排副作用，entry 载体已在
        // message/tool-call 分支覆盖
        return
    }
  }

  /**
   * 大 payload 缓解（§10-3）：toolResult entry 序列化超阈值时只投截断摘要——完整内容
   * 留给 reload 腿（P5 直读 JSONL 有全量）。保留 toolCallId/toolName/isError/timestamp
   * 等结构字段（前端配对回填依赖），丢弃 content 大体与 details。
   */
  private truncateToolResultIfNeeded(entry: PiMessageEntry): PiMessageEntry {
    const role = entry.message?.role
    if (role !== 'toolResult') return entry
    let serialized: string
    try {
      serialized = JSON.stringify(entry)
    } catch {
      // 序列化失败（畸形 content 等）无法判大小，原样透传——下游 reducer 自有守卫
      return entry
    }
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf-8') <= TEE_TOOL_RESULT_MAX_BYTES) {
      return entry
    }
    const text =
      `[relay tee truncated] tool result ${Buffer.byteLength(serialized, 'utf-8')} bytes exceeds `
      + `${TEE_TOOL_RESULT_MAX_BYTES} limit — full content available via session reload`
    return {
      ...entry,
      message: {
        ...entry.message,
        content: [{ type: 'text', text }],
        details: undefined,
      },
    }
  }
}
