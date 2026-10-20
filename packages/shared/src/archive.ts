/**
 * session 归档域共享契约（session-archive 设计 §7 D3 簿记 schema + D5 RPC 消息，
 * 实施计划 u-foundation：类型 + 词表 + 解析校验的单一权威源）。
 *
 * 消费方三端：runtime ArchiveService（写/读簿记与三 RPC handler）、renderer 归档
 * 列表与摘要视图（ArchiveSummary / config.archives）、session-reader extension
 * （簿记收集器——bundle 隔离侧复制同语义实现时以本出口为准，同 network-proxy
 * 口径）。
 *
 * 消息类型字符串与 type→payload 映射的 protocol.ts 接线属 u-rpc-wiring 单元；
 * 本文件只承载 schema / 词表 / 纯函数与 payload 类型，供两端共同 import 防止
 * 裁量漂移（定位同 import-session.ts）。
 *
 * 纯类型/常量/纯函数模块（无 node 依赖），renderer barrel 安全。
 */
import type { SessionSummary } from './session'

// ── 簿记 status 词表（D9）────────────────────────────────────────────────────

/**
 * 簿记 status 词表（D3 schema status 行）。
 *
 * - 'staging'：已搬移、名称已入簿记，摘要/压缩未完成（D5 同步段骨架）。
 * - 'archived'：后台压缩任务已提交簿记终态。
 * - restoring 态**不在本词表**——它由簿记 rename 为 `.restoring` 后缀承载（D9
 *   「状态判定唯一权威 = 读磁盘」三态的第三态），status 字段值域只有两值，
 *   'restoring' 输入由 parseArchiveLedger 拒绝。
 */
export type ArchiveLedgerStatus = 'staging' | 'archived'

/** status 值全集（单测两态覆盖矩阵数据源）。 */
export const ARCHIVE_LEDGER_STATUSES = [
  'staging',
  'archived',
] as const satisfies readonly ArchiveLedgerStatus[]

/** 反向完备编译锁（范式同 crash-journal-schema）：联合扩值漏改元组时 tsc 红。 */
type _ArchiveLedgerStatusCoversAll = [ArchiveLedgerStatus] extends [
  (typeof ARCHIVE_LEDGER_STATUSES)[number],
]
  ? true
  : ['ArchiveLedgerStatus 扩值须同步 ARCHIVE_LEDGER_STATUSES 元组']

/** 编译锁消费点（导出以通过 noUnusedLocals；值恒 true 无运行期语义，类型承重）。 */
export const ARCHIVE_LEDGER_STATUS_COVERAGE_LOCK: [_ArchiveLedgerStatusCoversAll] = [true]

// ── 摘要形态（D4 算法产出，簿记 summary 字段）───────────────────────────────

/**
 * 单 turn 摘要条目（D4：turn 边界 = user message entry 开新 turn；compaction 等
 * 非 message entry 不参与摘要）。
 */
export interface ArchiveSummaryTurn { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  /**
   * 用户消息文本 = entry message.content 的 string 形态或 blocks 中 text 块拼接；
   * 纯图片/附件消息为空串（渲染层显示占位，D11）。
   */
  user: string
  /**
   * agent 文本 = 该 turn 内从后向前第一个非空 assistant text 块（多 assistant
   * entry 形态下取最终结论段）；整 turn 无文本（以工具调用结束）为 null——
   * 渲染层显示「摘要跳过该段」占位。
   */
  agent: string | null
}

/** 对话摘要（簿记 summary 字段形态；staging 期为 null，后台压缩任务补全）。 */
export interface ArchiveConversationSummary { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  turns: ArchiveSummaryTurn[]
}

// ── 簿记 schema（D3 `.archive.json` 明文 JSON 形态）──────────────────────────

/** 簿记公共字段（两态共享；字段语义见 D3 schema JSON 块）。 */
interface ArchiveLedgerBase {
  /** pi session id（JSONL 首行 header.id 口径，归档目录 assets/ 分区键）。 */
  sessionId: string
  /**
   * 会话名称：归档时从明文 JSONL 尾部 session_info 提取（extractSessionName
   * 尾读语义）。名称的唯一持久层在 JSONL 内部，压缩后免解压不可得，必须随簿记
   * 冗余（D3）；提取失败可为空串（渲染层按无名会话占位）。
   */
  name: string
  /** 原主文件名（`<ISO时间戳>_<uuid>.jsonl`）——恢复时还原命名；不含路径分隔符。 */
  originalFile: string
  /** 原工作目录绝对路径（恢复时按 encodeCwd 归位分桶）。 */
  cwd: string
  /** 归档时刻（ISO 8601，如 2026-10-20T12:34:56.789Z）。 */
  archivedAt: string
  /** 原主文件字节数。 */
  rawBytes: number
}

/** staging 态簿记（D5 同步段骨架：搬移完成，压缩/摘要未完成）。 */
export interface ArchiveLedgerStaging extends ArchiveLedgerBase { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  status: 'staging'
  /** 显式 null（骨架写入口径，D5 步骤 4）；压缩产物三字段（codec/compressedBytes/sha256）骨架不含。 */
  summary: null
}

/** archived 态簿记（后台压缩任务原子重写的终态，D5 后台任务段）。 */
export interface ArchiveLedgerArchived extends ArchiveLedgerBase { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  status: 'archived'
  /** 压缩编码标识（D2 现值 'zstd-3'；值域开放——schema 预留 codec 字段的已发生演进点，设计 §4）。 */
  codec: string
  /** 压缩体字节数（`<originalFile>.zst`，originalFile 已含 `.jsonl`）。 */
  compressedBytes: number
  /** 主文件压缩体 sha256（64 位小写 hex；恢复与 purge 引用枚举的消费前校验依据，D9 不变量 2）。 */
  sha256: string
  summary: ArchiveConversationSummary
}

/** 簿记对象（判别字段 status；磁盘唯一事实源，列表 = 扫描 `.archive.json` 派生，D9 不变量 3）。 */
export type ArchiveLedger = ArchiveLedgerStaging | ArchiveLedgerArchived

// ── 解析与校验（staging-archived 两态字段完备性）────────────────────────────

/** parseArchiveLedger 结果：失败为可读原因（调用方决定跳过或上报，不强制 try-catch）。 */
export type ArchiveLedgerParseResult =
  | { ok: true; ledger: ArchiveLedger }
  | { ok: false; error: string }

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

/** ISO 8601 时刻校验：日期时间形态前缀 + Date.parse 可解析（写入方恒 toISOString）。 */
function isIsoTimestamp(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))
}

function parseSummaryTurn(raw: unknown, index: number): ArchiveSummaryTurn | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `summary.turns[${index}] 必须为对象，实际 ${typeof raw}`
  }
  const user = (raw as Record<string, unknown>).user
  if (typeof user !== 'string') {
    return `summary.turns[${index}].user 必须为 string（纯图片/附件消息为空串），实际 ${typeof user}`
  }
  const agent = (raw as Record<string, unknown>).agent
  if (typeof agent !== 'string' && agent !== null) {
    return `summary.turns[${index}].agent 必须为 string 或 null（turn 无文本回复），实际 ${typeof agent}`
  }
  return { user, agent }
}

/**
 * 公共必填字段校验（两态共享）。返回 base 对象或错误消息字符串（调用方包成
 * { ok: false, error }）——顺序即报错优先级，与拆分前逐行 if 一致。
 */
function parseArchiveLedgerBase(obj: Record<string, unknown>): ArchiveLedgerBase | string {
  if (!isNonEmptyString(obj.sessionId)) {
    return `sessionId 必须为非空 string，实际 ${typeof obj.sessionId}`
  }
  if (typeof obj.name !== 'string') {
    return `name 必须为 string（允许空串），实际 ${typeof obj.name}`
  }
  if (!isNonEmptyString(obj.originalFile)) {
    return `originalFile 必须为非空 string，实际 ${typeof obj.originalFile}`
  }
  if (/[/\\]/.test(obj.originalFile)) {
    return `originalFile 不得含路径分隔符（恢复时按文件名拼路径，防穿越），实际 "${obj.originalFile}"`
  }
  if (!isNonEmptyString(obj.cwd)) {
    return `cwd 必须为非空 string，实际 ${typeof obj.cwd}`
  }
  if (!isIsoTimestamp(obj.archivedAt)) {
    return `archivedAt 必须为 ISO 8601 时刻字符串，实际 ${JSON.stringify(obj.archivedAt)}`
  }
  if (!isNonNegativeInt(obj.rawBytes)) {
    return `rawBytes 必须为非负整数，实际 ${JSON.stringify(obj.rawBytes)}`
  }
  return {
    sessionId: obj.sessionId,
    name: obj.name,
    originalFile: obj.originalFile,
    cwd: obj.cwd,
    archivedAt: obj.archivedAt,
    rawBytes: obj.rawBytes,
  }
}

/** staging 态校验：骨架不含压缩产物字段 + summary 显式 null（D5 步骤 4 写入口径）。 */
function parseStagingLedger(obj: Record<string, unknown>, base: ArchiveLedgerBase): ArchiveLedgerParseResult {
  // hasOwnProperty.call 而非 Object.hasOwn：renderer 侧 vue-tsc 的 lib 是 ES2020，
  // Object.hasOwn 报 TS2550（同 message.ts asWorkflowDoneReason 先例）。
  for (const field of ['codec', 'compressedBytes', 'sha256'] as const) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      return { ok: false, error: `staging 态簿记不得携带压缩产物字段 ${field}（骨架不含，D5 步骤 4）` }
    }
  }
  if (!('summary' in obj) || obj.summary !== null) {
    return { ok: false, error: `staging 态 summary 必须为显式 null（骨架写入口径，D5 步骤 4），实际 ${JSON.stringify(obj.summary)}` }
  }
  return { ok: true, ledger: { ...base, status: 'staging', summary: null } }
}

/** archived 态校验：压缩产物三字段 + summary.turns 逐条形态。 */
function parseArchivedLedger(obj: Record<string, unknown>, base: ArchiveLedgerBase): ArchiveLedgerParseResult {
  if (!isNonEmptyString(obj.codec)) {
    return { ok: false, error: `archived 态 codec 必须为非空 string，实际 ${typeof obj.codec}` }
  }
  if (!isNonNegativeInt(obj.compressedBytes)) {
    return { ok: false, error: `archived 态 compressedBytes 必须为非负整数，实际 ${JSON.stringify(obj.compressedBytes)}` }
  }
  if (typeof obj.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(obj.sha256)) {
    return { ok: false, error: `archived 态 sha256 必须为 64 位小写 hex 字符串，实际 ${JSON.stringify(obj.sha256)}` }
  }
  const summary = obj.summary
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    return { ok: false, error: `archived 态 summary 必须为 { turns } 对象，实际 ${Array.isArray(summary) ? 'array' : typeof summary}` }
  }
  const turns = (summary as Record<string, unknown>).turns
  if (!Array.isArray(turns)) {
    return { ok: false, error: `archived 态 summary.turns 必须为数组，实际 ${typeof turns}` }
  }
  const parsedTurns: ArchiveSummaryTurn[] = []
  for (let i = 0; i < turns.length; i++) {
    const turn = parseSummaryTurn(turns[i], i)
    if (typeof turn === 'string') {
      return { ok: false, error: turn }
    }
    parsedTurns.push(turn)
  }
  return {
    ok: true,
    ledger: {
      ...base,
      status: 'archived',
      codec: obj.codec,
      compressedBytes: obj.compressedBytes,
      sha256: obj.sha256,
      summary: { turns: parsedTurns },
    },
  }
}

/**
 * 解析并校验簿记 JSON（`JSON.parse` 产物或等价 unknown 输入）。
 *
 * 校验规则（staging-archived 两态字段完备性，u-foundation 验收条款）：
 * - 公共必填：sessionId / originalFile / cwd 非空 string；name 为 string（允许空串
 *   ——名称提取失败的合法形态）；archivedAt 为 ISO 8601 时刻；rawBytes 非负安全整数。
 * - status ∈ {'staging','archived'}（词表外一律拒绝——含 'restoring'，该态由
 *   `.restoring` 后缀承载，D9）。
 * - staging 态：summary 必须为显式 null，且不得携带压缩产物字段
 *   codec/compressedBytes/sha256（骨架不含，D3「簿记骨架不含明文校验值」）。
 * - archived 态：codec 非空 string、compressedBytes 非负安全整数、sha256 为 64 位
 *   小写 hex、summary 为 { turns: ArchiveSummaryTurn[] }。
 * - 未知顶层字段忽略（向前兼容：新版本簿记对旧版本消费方不致命；已知字段的
 *   类型/两态一致性仍严格拒绝——与「校验宽松」不同维度）。
 *
 * 结构 = 顶层形态门 + 公共字段（parseArchiveLedgerBase）+ 两态分派
 * （parseStagingLedger / parseArchivedLedger）——拆分只为单函数分支数受控，
 * 校验规则与报错文案逐条不变。
 */
export function parseArchiveLedger(raw: unknown): ArchiveLedgerParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `簿记必须为 JSON 对象，实际 ${Array.isArray(raw) ? 'array' : typeof raw}` }
  }
  const obj = raw as Record<string, unknown>

  const base = parseArchiveLedgerBase(obj)
  if (typeof base === 'string') {
    return { ok: false, error: base }
  }

  if (obj.status === 'staging') {
    return parseStagingLedger(obj, base)
  }
  if (obj.status === 'archived') {
    return parseArchivedLedger(obj, base)
  }
  return {
    ok: false,
    error: `status 必须为 staging|archived（restoring 态由 .restoring 后缀承载，不进词表），实际 ${JSON.stringify(obj.status)}`,
  }
}

// ── 归档列表条目 DTO（config.archives 响应元素）─────────────────────────────

/**
 * 归档列表条目（同 SessionSummary 先例的列表条目 DTO）：簿记解析产物 + projectId
 * 派生字段。
 *
 * project 归属**不冗余进簿记**（D3）：权威源是随迁的 `.project.json` 旁挂，runtime
 * 扫描归档目录时读旁挂回填 projectId（同 SessionScanner 第五读 sidecar 模式）。
 * 两态字段与 status 的一致性由 parseArchiveLedger 承载（staging 分支类型上即无
 * 压缩产物字段）。
 */
export type ArchiveSummary =
  | (ArchiveLedgerStaging & { projectId?: string })
  | (ArchiveLedgerArchived & { projectId?: string })

// ── RPC 错误码词表（D5 三门 + §5.2 失败路径）────────────────────────────────

/**
 * 归档域 RPC 错误码闭集（六值，字面量逐字对齐设计 D5 / §5.2 失败路径表；改码须
 * 先改设计再同步此处与 archive.test.ts 锚定集）。
 *
 * **失败通道**：三 RPC 的领域错误走统一 error envelope（code = 本词表值 +
 * message，sessionId 随 envelope 携带——同 ImportErrorCode / CompactErrorCode
 * 先例；impl-plan u-rpc-wiring 验收条款「错误码 envelope」）。renderer 按 code
 * 分流显示 §5.2 对应恢复指引文案。**闭集指领域码**：transport 层另有两个码不在
 * 本词表——archive_failed（handler 对词表外意外 throw 的归一兜底，杜绝 fs 系统码
 * 泄漏到 renderer）与 archive_unsupported（archiveService 未注入的防御码，生产组合
 * 根恒注入、仅测试最小 mock 可达）。值语义与触发 RPC：
 * - archive_generating：session.archive——会话生成中（isGenerating），前置三门
 *   之首（防 RPC 绕过前端禁用后杀 pi 丢尾部未落盘 entry）。
 * - archive_already_archived：session.archive——归档目录已存在该 sessionId 的
 *   簿记（前置三门之二）。
 * - archive_restore_conflict：session.unarchive——sessions/ 原路径已存在同名主
 *   文件（staging 与 archived 统一冲突检测，fs.rename 静默覆盖故检测前置；簿记
 *   归位，原件不动）。
 * - archive_corrupted：session.unarchive——压缩体 sha256 校验不匹配（簿记归位，
 *   原件不动，绝不半途删除）。
 * - archive_not_found：session.purgeArchive——簿记不存在（已恢复/已彻底删除/从未
 *   归档；簿记存在性门，拒绝时零副作用——封闭对已回场在场 session 的真删链）。
 * - archive_io_error：三 RPC 通用——磁盘写失败（目标目录不可写等）；session 状态
 *   以磁盘为准，启动自愈归位。
 */
export type ArchiveErrorCode =
  | 'archive_generating'
  | 'archive_already_archived'
  | 'archive_restore_conflict'
  | 'archive_corrupted'
  | 'archive_not_found'
  | 'archive_io_error'

/** 错误码值全集（handler 落码测试 / renderer 判别的锚定集，禁止手抄字面量）。 */
export const ARCHIVE_ERROR_CODES = [
  'archive_generating',
  'archive_already_archived',
  'archive_restore_conflict',
  'archive_corrupted',
  'archive_not_found',
  'archive_io_error',
] as const satisfies readonly ArchiveErrorCode[]

/** 反向完备编译锁（范式同上）。 */
type _ArchiveErrorCodeCoversAll = [ArchiveErrorCode] extends [
  (typeof ARCHIVE_ERROR_CODES)[number],
]
  ? true
  : ['ArchiveErrorCode 扩值须同步 ARCHIVE_ERROR_CODES 元组']

export const ARCHIVE_ERROR_CODE_COVERAGE_LOCK: [_ArchiveErrorCodeCoversAll] = [true]

// ── 三 RPC 消息 payload（D5；消息名接线在 protocol.ts，u-rpc-wiring 单元）────

/** session.archive 请求（D5 同步段：搬移 + 簿记骨架，目标百毫秒级——rename 同盘零拷贝 + 名称尾读）。 */
export interface SessionArchiveRequest { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  sessionId: string
}

/** session.archive reply（成功 ack；归档角标刷新走 config.sessions 广播帧携带的 archiveCount）。 */
export interface SessionArchiveReply { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  sessionId: string
}

/** session.unarchive 请求（解压回原路径，原 project 分组随旁挂自动还原）。 */
export interface SessionUnarchiveRequest { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  sessionId: string
}

/**
 * session.unarchive reply：返回恢复后的 SessionSummary（前端原项目组顶部高亮
 * 置顶，D5 步骤 7）。
 */
export interface SessionUnarchiveReply { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  sessionId: string
  session: SessionSummary
}

/** session.purgeArchive 请求（彻底删除 = delete 的归档态版本；全部步骤幂等）。 */
export interface SessionPurgeArchiveRequest { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  sessionId: string
}

/**
 * session.purgeArchive reply。
 *
 * keptSubagentsDir：cascade 引用枚举 keep-all 保守分支触发时携带（判据 =
 * referenceScan === 'failed'），值 = 保留的 subagents 目录绝对路径
 * （`<root>/<sessionId>/subagents/`，宁保留不误删）——前端 toast「已彻底删除；
 * 子代理记录因归档数据不可读已保守保留」+ 残留目录指引（D5 步骤 7，失败显式
 * 上报）。缺省 = 干净删除，无保留说明。
 */
export interface SessionPurgeArchiveReply { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  sessionId: string
  keptSubagentsDir?: string
}

/** config.archives 响应（归档列表拉取，拉为主——打开归档视图时调用，D5）。 */
export interface ConfigArchivesReply { // oe-exempt:20261020:framework:SDK 契约接口——跨进程/跨包协议载体，接口先立、单实现常态
  archives: ArchiveSummary[]
}
