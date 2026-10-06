/**
 * journal 事件推送的类型定义（event-push-channel 协议面）。
 *
 * 契约两端：
 *   - 写侧（生产）：@zhushanwen/pi-subagent-workflow 壳层（src/host/journal-reporter.ts）
 *     监听 subagent-core 的 journal 落盘出口回调（notifyJournalAppended），经 select
 *     通道带回执推送；
 *   - 读侧（消费）：taiji runtime event-adapter 的 marker 路由分支 → journal-report-router
 *     → SessionEventProjection（applyJournalReport：seq 缺口判定 → 缺口触发本地补读 → fold）。
 *
 * 语义锚点（设计 §3.3）：推送报告只携带事件本体（事件信封自带 seq），不另设水位协商
 * ——消费方 per 文件持两个水位（字节偏移 = 补读起点、已折叠最大 seq = 去重判据），
 * 重复投递由域 fold 的 seq 单调检查构造性幂等。确认回执 = runtime 同步 fold 应用后
 * resolve（回执 = 「已应用」而非「已接收」）。
 */

/** journal 两域（单 marker 载荷判别字段——设计 §3.4 D2：两域推送方/接收方/通道语义同构，不拆双 marker）。 */
export type SubagentJournalDomain = 'run' | 'record'

/**
 * 单条 journal 事件（run 域 = run journal 行 / record 域 = record 事件行——域内
 * 词表校验归读侧与文件行同一解析器，本层只校验跨域共同信封）。
 */
export interface SubagentJournalEvent { // oe-exempt:20261003:framework:跨进程 marker 通道 wire 协议契约（形状守卫消费，协议类型先立）
  /** 事件类型（域词表成员资格由读侧按域校验）。 */
  type: string
  /** 事件时点（ms epoch；信封必填）。 */
  ts: number
  /**
   * journal 行序号（写入方 JsonlEventStream.append 统一分配）。缺省 = W1 前存量
   * 无 seq 行（设计 §3.3 兼容条款：无 seq 事件不参与缺口判定，fold 按状态机语义幂等）。
   */
  seq?: number
  /** 域内载荷字段原样透传（写侧 = 刚落盘的行对象，无二次塑形）。 */
  [key: string]: unknown
}

/**
 * 单帧 journal 事件报告（pi 进程 → runtime，经 select 通道，title = SUBAGENT_JOURNAL_MARKER，
 * options = [JSON.stringify(本形状)]）。单帧只覆盖一个文件（fileKey 单数——设计 §3.4：
 * fileKey = runId 或 sa-id；多文件积压由写侧按组逐帧发送）。
 */
export interface SubagentJournalReport { // oe-exempt:20261003:framework:跨进程 marker 通道 wire 协议契约（单帧报告形状，协议类型先立）
  /** 事件所属域（run / record 判别）。 */
  domain: SubagentJournalDomain
  /** 文件键：run 域 = runId，record 域 = record id（sa-id）。 */
  fileKey: string
  /** 本帧事件（写入序；写侧落盘提交点之后的增量批次）。 */
  events: SubagentJournalEvent[]
  /**
   * 上报所属 session（ctx.sessionManager.getSessionId()）。pi 延迟写入窗口内可能取
   * 不到——缺席时消费方按无法归属丢弃整帧（不 fold 不 ack），不视为协议错误
   * （归属权威 = 连接的 sessionId，本字段只作在场性判据——inflight 同款先例）。
   */
  sessionId?: string
  /** 产生时点（ms epoch，pi 进程内取值）。诊断/乱序排查用，消费方不依赖其单调性。 */
  emittedAt: number
}

/**
 * select 通道的确认回包（runtime event-adapter 处理完帧后 resolve 给 pi 侧的
 * JSON 字符串）。回执语义 = 「已应用」（runtime 同步完成 fold 应用后 resolve，
 * 设计 §3.4 D7 生效回执）——写侧非本字符串即未确认：首败 warn 留证 + 缓冲丢弃
 * 不重推（完整性由消费方 seq 缺口补读收敛，设计 §3.3 D5）。
 */
export const JOURNAL_REPORT_ACK = '{"ack":true}' as const

/** 运行时形状守卫（信任边界：帧内容来自 select 通道 payload，LLM/外部可控 JSON）。 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 单事件信封守卫：type 非空串、ts 有限数值、seq 缺省或正安全整数。 */
function isSubagentJournalEvent(v: unknown): v is SubagentJournalEvent {
  if (!isRecord(v)) return false
  if (typeof v.type !== 'string' || v.type === '') return false
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return false
  if (v.seq !== undefined && (typeof v.seq !== 'number' || !Number.isSafeInteger(v.seq) || v.seq < 1)) {
    return false
  }
  return true
}

/**
 * SubagentJournalReport 形状守卫：domain 落两域词表、fileKey 非空串、events 逐条
 * 过信封守卫、sessionId 缺席或 string。event-adapter 路由分支消费；非法帧返回
 * false（调用方丢弃，不 fold 不 ack）。
 */
export function isSubagentJournalReport(v: unknown): v is SubagentJournalReport {
  if (!isRecord(v)) return false
  if (v.domain !== 'run' && v.domain !== 'record') return false
  if (typeof v.fileKey !== 'string' || v.fileKey === '') return false
  if (!Array.isArray(v.events)) return false
  for (const event of v.events) {
    if (!isSubagentJournalEvent(event)) return false
  }
  if (typeof v.emittedAt !== 'number') return false
  if (v.sessionId !== undefined && typeof v.sessionId !== 'string') return false
  return true
}

/** 确认回包形状守卫（pi 侧 reporter 消费——非本字符串即未确认）。 */
export function isJournalReportAck(v: unknown): v is typeof JOURNAL_REPORT_ACK {
  return v === JOURNAL_REPORT_ACK
}
