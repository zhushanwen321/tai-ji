/**
 * server→client 出站帧大小守卫（crash-resilience §3.3 D3 / 实施计划 u4a-outbound-guard）。
 *
 * E3 事故（9/9 renderer OOM）的传输段防线：现网出站帧无上限（ws maxPayload 只管入站，
 * P-ws-oneway），巨帧直打内存紧张的 renderer。本模块实现 push 通路守卫：
 *
 * - **契约保持式截断**：超截断档（OUTBOUND_FRAME_TRUNCATE_BYTES，默认 32MB）的 session 级
 *   push 帧，消息类型不变，按「帧内字段路径注册表」把大字段原地替换为占位载荷（content 类
 *   整字段替换为 text block 数组——对齐 event-interpreter.ts:1054 hook 改写分支「保持 pi 持久化
 *   形态」权威先例；record 类类型保持替换；数组类单元素占位；字符串类占位文案），然后正常
 *   分配 seq、按 topic 三分类流转、广播——客户端收到截断版，ring 存截断版，断连回放与重
 *   订阅拉到的都是同一份截断版，seq 连续性 / gap 检测 / live≡reload 语义全部不被破坏。
 * - **miss 兜底**：注册表未覆盖该类型、或替换后仍超硬上限 → 调用方在 seq 分配前整条丢弃
 *   （该消息从未占用 seq，不触发 gap——D3 被否方案④「seq 分配后丢弃」会触发
 *   gap-重订阅失败死循环，见设计 D3 反例）。8MB 告警档先于截断档暴露 miss。
 * - **告警档**（OUTBOUND_FRAME_WARN_BYTES，默认 8MB）：写 warn 日志，不截断——哨兵定位
 *   （pi 上游自截失效时告警先于截断暴露）。
 * - **零抛错**：守卫自身 try/catch，任何异常放行原消息 + error 日志——防御设施不能成为
 *   新崩溃源。
 *
 * 不变式：本模块不 mutate 入参消息（沿路径不可变克隆替换）——publish 调用方（event-adapter /
 * interpreter 的 entry 对象）在帧构造后仍可能持有/复用同一对象（持久化权威在 pi 侧文件，
 * wire 截断不得污染调用方数据）。
 */
import type { ServerMessage } from '@taiji/shared'
import { OUTBOUND_FRAME_WARN_BYTES, OUTBOUND_FRAME_TRUNCATE_BYTES } from '@taiji/shared'
import { getCrashJournal } from '../../infra/crash-journal.js'

// ── 守卫阈值契约 ────────────────────────────────────────────────────

/**
 * 守卫可注入选项：阈值参数化（测试传小阈值走真实行为逻辑，生产路径用 shared 常量
 * 默认值——A10 阈值校准法同型的标准做法）+ session 文件路径解析器（占位文案填实路径）。
 */
export interface OutboundFrameGuardOptions {
  /** 告警档（生产默认 OUTBOUND_FRAME_WARN_BYTES = 8MB）。 */
  warnBytes: number
  /** 截断档（生产默认 OUTBOUND_FRAME_TRUNCATE_BYTES = 32MB）。 */
  truncateBytes: number
  /**
   * sessionId → session JSONL 文件路径（占位文案恢复指引用）。解析失败/未注入时占位文案
   * 退化为「（见 runtime 日志）」。实现抛错被守卫吞掉（返回 null 语义），不打断消息流转。
   * 组合根接线点：push 通路 = MessageBus 构造第二参；reply 通路 = server.setServices 的
   * replyGuardResolver（ServerMessageBroker replyGuard）——index.ts 两通路共用同一 resolver。
   */
  resolveSessionFilePath?: (sessionId: string) => string | null | undefined
}

/** 生产默认阈值：shared 常量（u-foundation SSOT）；不含 resolver（生产由组合根注入，见上）。 */
export const DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS: OutboundFrameGuardOptions = {
  warnBytes: OUTBOUND_FRAME_WARN_BYTES,
  truncateBytes: OUTBOUND_FRAME_TRUNCATE_BYTES,
}

// ── publish 调用点大字段穷举表（u4a 交付物：静态穷举 + 每类型判定） ──────────
//
// 穷举方法：grep 全部 messageBus.publish 实际调用点（packages/runtime/src 下 40 处，
// 含 relay-tee / terminal-service / plugin-service 等「组合根注入 publish 包装」的间接
// 调用），按 wire 帧类型（shared protocol.ts ServerMessageMap）归类，判定帧内是否存在
// 无上界大字段（坐标系 = WS 帧内字段路径，非 runtime/renderer 内部归一化对象）。
//
// 【登记为大字段（8 条，写入下方 REGISTRY）】
//
// | wire 帧类型                        | 帧内大字段路径                          | 形态     | 生产点（实证） |
// |------------------------------------|-----------------------------------------|----------|----------------|
// | message.message_end                | payload.entry.message.content           | content  | infra/pi/event-adapter.ts:948（全部持久化 entry 的实时权威载体，live≡reload 协议层依据；图片 = content 数组内 Image block，entry 无独立 images 字段） |
// | message.tool_call_end              | payload.entry.message.content           | content  | services/session/event-interpreter.ts:1089（工具结果文本；与 message_end 双路下发，两帧都注册保帧间一致） |
// | message.tool_call_start            | payload.entry.arguments                 | record   | services/session/event-interpreter.ts:1032（write 类工具写入全文在 arguments，toolResult 只回小确认） |
// | session.traceEntryAppended         | payload.entries                         | array-entry | services/session/trace-sync.ts:363 / :434（pi entry JSON 逐条增量） |
// | session.subagentEntriesAppended    | payload.entries                         | array-entry | infra/relay/relay-tee.ts:120（穷举新发现——subagent entry 增量帧，与 traceEntryAppended 同构；subagent 历史是巨型 JSONL 高发源，设计 D5① 自证） |
// | subagent.stream_delta              | payload.lines                           | array-string | infra/relay/relay-tee.ts:172 / :190（lines = 累积全文 split('\n')；undefined = 终态清除，undefined 时帧小不触发守卫） |
// | message.bashResult                 | payload.output                          | string   | services/session/message-dispatcher.ts:1042 / :1115（穷举新发现——bash 终态帧的 output 全文；上游 pi bash RPC 自截是既有防线，本条目是其失效时的纵深） |
// | terminal.data                      | payload.data                            | string   | services/terminal/terminal-service.ts:113（穷举新发现——PTY 输出块，用户 cat 大文件可达 MB 级；transient 类，miss 丢弃无 gap 风险） |
//
// 【判定不登记（控制面 / 有界载荷，逐类留痕防复穷举）】
//
// - message.error / message.status / message.stream_error / send.rejected /
//   message.complete / message.message_start / message.customStart / message.tool_call_update：
//   短文本控制帧，payload 无无上界字段（dispatcher :236/:323/:348/:365/:375/:420/:438/:846 等全部实证为短文案）。
// - message.bashStart / message.queue_update / message.auto_retry_start|end /
//   message.changeSetInvalidated（server.ts:330）/ message.file_changes（diff 文件名列表）：
//   命令行 / 状态码 / 文件路径级载荷。
// - message.compactionSummary / message.branchSummary：LLM 生成摘要文本（KB 级）。
// - session.exited（session-service.ts:311 / dispatcher:488）：reason 含 stderr 尾部——pi
//   崩溃堆栈可 MB 级但 32MB 级极罕见，且 pi-crash log 已全量落盘（D6）；若真超限走 miss
//   整条丢弃 + error 日志（可观测），不登记。
// - session.occupancy / session.state_changed / context.update / session.commands /
//   session.subagents / session.workflowUpdate / session.stats_update / session.skillNotice /
//   session.planState（session-records.ts:545，PlanStateView = requirement 文本 + 产物文档/
//   挂载技能小清单；requirement 有界前提由 plan extension 写/读两侧 64KB 封顶保障——
//   extensions/universal/plan/src/state.ts capPlanRequirement）/ backgroundTask:updated /
//   terminal.alive / terminal.exit / terminal.ack /
//   subagent.directive：标量/小列表状态帧。
// - plugin:uiRequest（plugin-service.ts:206）/ plugin:viewUpdate（:291）：插件动态 payload
//   （dialog/html 字段无固定路径）——transient/stream 兜底覆盖（超限丢弃 + error 日志）。
// - extension:widget / widgetGui / status / notify / setEditorText：extension 上报小载荷。
//
// 【完备性维护】注册表 miss 由 8MB 告警档前置暴露（miss 消息必先打告警）+ drop error 日志；
// 新增 publish 点若引入新的大字段帧类型，必须同步登记本注册表（设计 D3 已接受代价 B：
// 任何一次 miss 类 error 日志出现即视为注册表维护流程失效，回查本穷举表）。
interface LargeFieldSpec {
  /** 帧内字段路径（从 ServerMessage 根起的 key 序列）。 */
  path: readonly string[]
  /** 占位替换形态（契约保持：类型不变、只换载荷）。 */
  kind: 'content' | 'record' | 'array-string' | 'array-entry' | 'string'
}

/**
 * 帧内大字段路径注册表（上表 8 条）。key = wire 帧类型。
 * TOPIC_TABLE fallback='stream' 语义不受影响——守卫在 publish 入口（topicOf 流转之前）执行。
 */
const LARGE_FIELD_REGISTRY: Readonly<Record<string, readonly LargeFieldSpec[]>> = {
  'message.message_end': [{ path: ['payload', 'entry', 'message', 'content'], kind: 'content' }],
  'message.tool_call_end': [{ path: ['payload', 'entry', 'message', 'content'], kind: 'content' }],
  'message.tool_call_start': [{ path: ['payload', 'entry', 'arguments'], kind: 'record' }],
  'session.traceEntryAppended': [{ path: ['payload', 'entries'], kind: 'array-entry' }],
  'session.subagentEntriesAppended': [{ path: ['payload', 'entries'], kind: 'array-entry' }],
  'subagent.stream_delta': [{ path: ['payload', 'lines'], kind: 'array-string' }],
  'message.bashResult': [{ path: ['payload', 'output'], kind: 'string' }],
  'terminal.data': [{ path: ['payload', 'data'], kind: 'string' }],
}

// ── 占位载荷构造（契约保持式截断的替换形态） ────────────────────────

/** 字节数的 MB 展示（占位文案「内容过大（XX MB）」用）。 */
function formatMb(bytes: number): string {
  // eslint-disable-next-line no-magic-numbers -- MB 换算基数（1024²）非魔法数，与 shared 阈值常量的 8*1024*1024 形态一致
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 解析 session 文件路径：resolver 抛错/返回空一律退化为 null（占位「见 runtime 日志」），
 * 不得因拼路径打断消息流转。
 */
function resolvePathSafe(sessionId: string, opts: OutboundFrameGuardOptions): string | null {
  try {
    const p = opts.resolveSessionFilePath?.(sessionId)
    return typeof p === 'string' && p.length > 0 ? p : null
  } catch {
    return null
  }
}

/**
 * 截断占位文案（设计 T3 原文形态）。路径可得填实路径，不可得填「（见 runtime 日志）」。
 */
export function formatTruncationNote(originalBytes: number, sessionId: string, opts: OutboundFrameGuardOptions): string {
  const loc = resolvePathSafe(sessionId, opts) ?? '（见 runtime 日志）'
  return `内容过大（${formatMb(originalBytes)}）已在传输层截断，完整内容见 session 文件：${loc}`
}

/**
 * 占位 entry id 自增序号（进程内唯一）：同 session 两次截断帧各得独立 id，防 reducer 按
 * entry.id 把两条不同消息折叠成一条；'truncated-' 前缀与真实 pi entry id（uuidv7）及
 * reducer 派生 id（'e<N>'）命名空间均无碰撞。counter 不跨进程持久——ring/reducer 状态
 * 同为进程内存态，重启后各自重建，无跨重启同 id 折叠面。
 */
let placeholderEntrySeq = 0
function nextPlaceholderEntryId(): string {
  placeholderEntrySeq += 1
  return `truncated-${placeholderEntrySeq}-array-entry`
}

/**
 * 按字段形态构造占位载荷（类型保持）：
 * - content：整字段替换为 [{type:'text', text: 占位}]——block 数组结构合法，对齐
 *   event-interpreter.ts:1054 hook 改写先例（保持 pi 持久化形态，reducer 对 content 形态既有兼容）。
 * - record：{truncated, reason, originalBytes}——arguments 契约是 Record，谎报类型禁止。
 * - array-string / array-entry：单元素占位数组，元素形态与原元素同型
 *   （lines 的元素是 string → 占位字符串；entries 的元素是 PiEntry → 最小 PiMessageEntry 形态，
 *   带 entry.id（幂等消化锚点：reducer 按 entry.id 派生 Message.id / 幂等去重；ring 回放
 *   同对象同 id 天然幂等，同 session 多条截断帧靠自增 seq 互不折叠））。
 * - string：占位文案字符串本体。
 */
function buildPlaceholder(kind: LargeFieldSpec['kind'], originalBytes: number, sessionId: string, opts: OutboundFrameGuardOptions): unknown {
  const note = formatTruncationNote(originalBytes, sessionId, opts)
  switch (kind) {
    case 'content':
      return [{ type: 'text', text: note }]
    case 'record':
      return { truncated: true, reason: 'payload_too_large', originalBytes }
    case 'array-string':
      return [note]
    case 'array-entry':
      return [
        {
          id: nextPlaceholderEntryId(),
          type: 'message',
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: note }] },
        },
      ]
    case 'string':
      return note
  }
}

// ── 沿路径不可变读/替换 ────────────────────────────────────────────

/** 按路径读字段值；任一级缺失/非对象返回 undefined（不抛错）。 */
function getFieldAlongPath(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** 沿路径不可变克隆替换（原对象零污染——沿路径每级 spread，其余分支共享引用）。 */
function replaceAlongPath(root: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path
  const base = root !== null && typeof root === 'object' ? (root as Record<string, unknown>) : {}
  return { ...base, [head]: replaceAlongPath(base[head], rest, value) }
}

/** UTF-8 字节数测量（wire 帧按 UTF-8 传输）。序列化失败返回 Number.MAX_SAFE_INTEGER（调用方按超限处理）。 */
function byteLenOf(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? Number.MAX_SAFE_INTEGER : Buffer.byteLength(text, 'utf8')
  } catch {
    // 循环引用等不可序列化载荷：按不可传输超大处理（由调用方 miss 兜底丢弃，不抛错）
    return Number.MAX_SAFE_INTEGER
  }
}

// ── push 通路守卫 ──────────────────────────────────────────────────

/**
 * 8MB 告警档哨兵日志（D3 已接受代价 B / A10④：miss 消息必然先打告警——告警档先于
 * 截断/丢弃档暴露，哨兵定位上游自截失效）。drop 分支在 error 前必经此行（含 type/sessionId/bytes，
 * 与 passthrough 告警同形态）。
 */
function warnLargePushFrame(type: string, sessionId: string, bytes: number): void {
  console.warn(`[outbound-frame-guard] large outbound push frame (warn): type=${type} sessionId=${sessionId} bytes=${bytes}`)
}

/** 守卫判定结果。 */
export type PushFrameGuardResult =
  | { action: 'passthrough'; message: ServerMessage; bytes: number }
  | {
      action: 'replaced'
      /** 截断版消息（新对象，入参零污染；调用方以其替代原消息走 seq 分配与流转）。 */
      message: ServerMessage
      bytesBefore: number
      bytesAfter: number
      /** 被替换的帧内字段路径（如 payload.entry.message.content）。 */
      fieldPaths: string[]
    }
  | { action: 'dropped'; bytes: number; dropReason: 'registry_miss' | 'still_oversize_after_truncate' }

/**
 * push 通路出站帧守卫（MessageBus.publish 内、wire 序列化后调用；drop 语义 =
 * 「seq 分配前整条丢弃」——调用方对 dropped 回滚 seq，外部可观察行为等价）。
 *
 * 为什么不是「seq 分配前直接调本函数」：w09 TC-V1 既有验收契约要求单条消息全程
 * JSON.stringify 恰好 1 次——守卫测量必须复用 publish 的广播序列化文本（wire 字节数），
 * 而该文本必须在 seq 写入后生成（wire 帧携带 seq）。故 seq 预写 + drop 回滚，同步单线程
 * 内无观察窗口，与「seq 分配前丢弃」可观察行为等价（不占 seq 不触发 gap）。
 *
 * 判定序（设计 D3 / 错误规格表「出站 push 超 32MB」与「push 注册表 miss」两行）：
 * 1. 帧序列化 ≤ 截断档 → passthrough（≤ 告警档零改动；> 告警档补 warn 哨兵日志）；
 * 2. > 截断档且注册表未覆盖该类型 → dropped(registry_miss)；
 * 3. > 截断档且注册字段自身 > 告警档 → 契约保持式替换该字段（字段 > 告警档是「该字段是
 *    超限主因」的判定线——未被替换的剩余字段每项 ≤ 告警档，注册表每类型单字段，替换后
 *    帧必然 ≤ 告警档 + 骨架 ≪ 截断档）；无字段可替换（超限来自未注册字段）→
 *    dropped(registry_miss)；
 * 4. 替换后重测仍 > 截断档 → dropped(still_oversize_after_truncate)。
 *
 * 零抛错：任何异常放行原消息 + error 日志（防御设施自身不能成为新崩溃源）。
 *
 * @param message 待发布消息（本函数不 mutate 入参）
 * @param sessionId 目标 session（占位文案路径解析 + 日志定位）
 * @param opts 阈值与路径解析器（生产默认 shared 常量）
 */
export function guardOutboundPushFrame(
  message: ServerMessage,
  sessionId: string,
  opts: OutboundFrameGuardOptions = DEFAULT_OUTBOUND_FRAME_GUARD_OPTIONS,
): PushFrameGuardResult {
  try {
    const bytes = byteLenOf(message)
    if (bytes <= opts.truncateBytes) {
      if (bytes > opts.warnBytes) {
        warnLargePushFrame(message.type, sessionId, bytes)
      }
      return { action: 'passthrough', message, bytes }
    }

    const specs = LARGE_FIELD_REGISTRY[message.type]
    if (!specs || specs.length === 0) {
      warnLargePushFrame(message.type, sessionId, bytes)
      console.error(
        `[outbound-frame-guard] dropped oversize outbound push frame (registry miss — check LARGE_FIELD_REGISTRY exhaustive table): type=${message.type} sessionId=${sessionId} bytes=${bytes}`,
      )
      return { action: 'dropped', bytes, dropReason: 'registry_miss' }
    }

    let current: ServerMessage = message
    const fieldPaths: string[] = []
    for (const spec of specs) {
      const field = getFieldAlongPath(current, spec.path)
      if (field === undefined) continue
      const fieldBytes = byteLenOf(field)
      if (fieldBytes <= opts.warnBytes) continue
      current = replaceAlongPath(current, spec.path, buildPlaceholder(spec.kind, fieldBytes, sessionId, opts)) as ServerMessage
      fieldPaths.push(spec.path.join('.'))
    }
    if (fieldPaths.length === 0) {
      warnLargePushFrame(message.type, sessionId, bytes)
      console.error(
        `[outbound-frame-guard] dropped oversize outbound push frame (no registered field above warn threshold — oversize source not covered): type=${message.type} sessionId=${sessionId} bytes=${bytes}`,
      )
      return { action: 'dropped', bytes, dropReason: 'registry_miss' }
    }

    const bytesAfter = byteLenOf(current)
    if (bytesAfter > opts.truncateBytes) {
      warnLargePushFrame(message.type, sessionId, bytes)
      console.error(
        `[outbound-frame-guard] dropped oversize outbound push frame (still oversize after truncation): type=${message.type} sessionId=${sessionId} bytes=${bytes} bytesAfter=${bytesAfter}`,
      )
      return { action: 'dropped', bytes, dropReason: 'still_oversize_after_truncate' }
    }

    console.warn(
      `[outbound-frame-guard] truncated oversize outbound push frame: type=${message.type} sessionId=${sessionId} fields=${fieldPaths.join(',')} bytes=${bytes} bytesAfter=${bytesAfter}`,
    )
    return { action: 'replaced', message: current, bytesBefore: bytes, bytesAfter, fieldPaths }
  } catch (e) {
    console.error('[outbound-frame-guard] guard itself failed — passing original message through:', e)
    return { action: 'passthrough', message, bytes: -1 }
  }
}

// ── reply 通路守卫辅助（message-broker.reply 消费） ─────────────────

/**
 * reply 通路条件信号事件 → 崩溃台账（crash-forensics-and-watchdog §3.3 D1 写入点矩阵
 * 「message-broker reply 超限分支」，u1e）：告警档 → frame-truncated(warn-tier)、整帧
 * 替换 error envelope → frame-truncated(trunc-tier)。与既有日志/替换行为同点双写，
 * append 为 fire-and-forget（writer 未初始化 no-op 单例、内部自吞异常），不改变 reply
 * 守卫本身行为。reply 通路无注册表（整帧 envelope 替换），不产生 registry-miss。
 *
 * 归属注：本函数原在 transport/message-broker.ts，为避免 transport→infra 首条反向
 * import（三层方向 transport→services←infra）下移到本模块（services 引 infra 合法，
 * 与 message-bus.ts 同款 getCrashJournal import）。
 */
export function appendReplyFrameJournal(reason: 'warn-tier' | 'trunc-tier', type: string, sid: string | undefined, bytes: number): void {
  getCrashJournal().append({
    layer: 'runtime',
    event: 'frame-truncated',
    reason,
    sessionId: sid ?? null,
    detailDigest: JSON.stringify({ frameType: type, bytes, channel: 'reply' }),
  })
}

/**
 * reply 超限错误 envelope 的 message 文案（错误规格表「出站 reply 超 32MB」行：
 * 提示含「加载更早」分页入口与 session 文件路径）。
 */
export function formatReplyOversizeMessage(bytes: number, sessionId: string | undefined, opts: OutboundFrameGuardOptions): string {
  const loc = sessionId !== undefined ? (resolvePathSafe(sessionId, opts) ?? '（见 runtime 日志）') : '（见 runtime 日志）'
  return `该内容过大无法传输（${formatMb(bytes)}），请用「加载更早」分页查看，或查阅 session 文件：${loc}`
}
