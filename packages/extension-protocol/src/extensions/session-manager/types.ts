/**
 * session-manager extension 的类型定义。
 *
 * 7 个 action 的请求 params 和结果类型，供 handler 和 extension 共用。
 * marker 检测后按 action 分发到对应 handler 分支。
 */
import type { SESSION_MANAGER_ACTIONS } from './marker.js'
import type { ChannelErrorResult } from '../../core/select-rpc.js'

/** session-manager 支持的 7 个 action（从 SESSION_MANAGER_ACTIONS 集合派生，值与类型同源） */
export type SessionManagerAction = (typeof SESSION_MANAGER_ACTIONS)[number]

/** 各 action 的请求参数映射 */
export interface SessionManagerParams {
  create: SessionManagerCreateParams
  send: SessionManagerSendParams
  history: SessionManagerHistoryParams
  status: SessionManagerStatusParams
  list: SessionManagerListParams
  abort: SessionManagerAbortParams
  watch: SessionManagerWatchParams
}

/** create action 参数 */
export interface SessionManagerCreateParams {
  /** session 工作目录 */
  cwd?: string
  /** session 标签 */
  label?: string
  /** 初始 prompt（可选；提供时 create 后立即注入——设计文档 §5.2 原子性决策） */
  prompt?: string
  /**
   * 完成通知债权的幂等键（optional，notify-once D2/D6）：extension 侧
   * `crypto.randomUUID()` 前缀 `sm-` 生成。缺省/畸形 → runtime 不 arm、
   * `willNotify:false`、零完成通知——兼容判据从版本二分改为字段有无。
   * 形态判定不在 params 守卫（畸形不构成 params 错误、动作照常执行），
   * 由 runtime 受理点消费 `isSessionManagerNotifyId` 作 arm 判据。
   */
  notifyId?: string
}

/** send action 参数 */
export interface SessionManagerSendParams {
  sessionId: string
  prompt: string
  /** 完成通知债权的幂等键（optional，语义同 create：缺省/畸形 → 不 arm + willNotify:false） */
  notifyId?: string
}

/** history action 参数 */
export interface SessionManagerHistoryParams {
  sessionId: string
  /** 截断尾部 turn 数（0 = 不截断） */
  tailTurns?: number
}

/** status action 参数 */
export interface SessionManagerStatusParams {
  sessionId: string
}

/** list action 参数（无字段：过滤由 handler 固化——spawnSource='agent' + 路由上下文父 id；Record<string, never> 结构性拒绝任何请求字段） */
export type SessionManagerListParams = Record<string, never>

/** abort action 参数 */
export interface SessionManagerAbortParams {
  sessionId: string
}

/**
 * watch action 参数（notify-once D2/D6）：通知债权的纯应答通道，**单键寻址**——
 * runtime 按 `(调用方 parentSid, notifyId)` 反查 claim，parentSid 取自调用方连接身份、
 * **协议面不定义不携带**（可推导字段免传，多余字段被守卫拒绝）。不传 timeout、
 * fire-and-forget 长挂 select；每 claim 单 watch 槽（新覆盖旧，runtime 只 respond 最新）。
 */
export interface SessionManagerWatchParams {
  /** 目标 claim/lifetime 的幂等键（`sm-` 前缀 UUID，形态自检见 isSessionManagerNotifyId） */
  notifyId: string
}

// ── params 运行时守卫（信任边界：params 来自 extension_ui_request，LLM 可控 JSON）──
// handler 侧 dispatch 前校验；非法 params 不再经 `as unknown as` 断言静默流入
// sessionService（曾以 undefined 流入 create 的 cwd/label/prompt）。

function isRecord(v: unknown): v is Record<string, unknown> {
  // 排数组严版（canonical = ext-guards isRecord），与同包 plugin-bridge /
  // subagent-inflight 私有副本同款同义——六个 action 的 params schema 契约均为
  // JSON object（extension 侧 Type.Object），数组属畸形输入走守卫拒绝闭环
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

/**
 * notifyId 形态入站自检（notify-once D2/D6，廉价防御级校验）——协议面单一权威：
 * extension 侧 `crypto.randomUUID()` 前缀 `sm-` 生成、runtime 生成的 `lifetimeNotifyId`
 * 同形态**同本函数**（防 kind=lifetime 的 watch 被自检拒掉）。形状 = `sm-` + RFC4122
 * 十六进制 UUID（8-4-4-4-12，大小写不敏感），总长构造性钉死 39 字符——超长/截断/
 * 错前缀/非 UUID 体一律拒绝，无独立长度上限条款。
 *
 * 消费点：① watch params 守卫（拒绝即 error envelope）；② send/create 受理点 arm 判据
 * （缺省/畸形 → 不 arm + willNotify:false，动作本身照常执行——params 守卫刻意不查形态）。
 */
const NOTIFY_ID_PATTERN = /^sm-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isSessionManagerNotifyId(v: unknown): v is string {
  return typeof v === 'string' && NOTIFY_ID_PATTERN.test(v)
}

/** optional notifyId 的类型面校验（缺省放行；present 须为 string——非 string 属形状
 *  违规拒绝走 error envelope，字符串形态不符留给 arm 判据降级为 willNotify:false） */
function isOptionalNotifyId(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

function isSessionIdParams(v: unknown): boolean {
  return isRecord(v) && typeof v.sessionId === 'string'
}

/** create：字段可选 string + optional notifyId（类型面，sm- 形态判定归 arm 判据） */
export function isSessionManagerCreateParams(v: unknown): v is SessionManagerCreateParams {
  return (
    isRecord(v) &&
    isOptionalString(v.cwd) &&
    isOptionalString(v.label) &&
    isOptionalString(v.prompt) &&
    isOptionalNotifyId(v.notifyId)
  )
}

/** send：sessionId + prompt 必填，notifyId optional（类型面校验同 create） */
export function isSessionManagerSendParams(v: unknown): v is SessionManagerSendParams {
  return (
    isRecord(v) &&
    typeof v.sessionId === 'string' &&
    typeof v.prompt === 'string' &&
    isOptionalNotifyId(v.notifyId)
  )
}

/** history：sessionId 必填、tailTurns 可选 number */
export function isSessionManagerHistoryParams(v: unknown): v is SessionManagerHistoryParams {
  return (
    isRecord(v) &&
    typeof v.sessionId === 'string' &&
    (v.tailTurns === undefined || typeof v.tailTurns === 'number')
  )
}

/** status / abort：sessionId 必填 */
export function isSessionManagerStatusParams(v: unknown): v is SessionManagerStatusParams {
  return isSessionIdParams(v)
}

export function isSessionManagerAbortParams(v: unknown): v is SessionManagerAbortParams {
  return isSessionIdParams(v)
}

/** list：无参数（过滤由 handler 固化，params 不携带任何过滤字段） */
export function isSessionManagerListParams(v: unknown): v is SessionManagerListParams {
  return isRecord(v)
}

/**
 * watch：**封闭单键** `{notifyId}` 守卫（notify-once D2 形态入站自检）——
 * 空载荷 / 缺字段 / 夹带任何额外字段（如 parentSid：归属由 runtime 取连接身份，
 * 协议面不定义）/ notifyId 非 string / 形态不符（缺 `sm-` 前缀、非 UUID 体、超长）
 * → false → handler dispatch 抛错走 respond({error}) 错误闭环（error envelope）。
 * 形态函数与 lifetimeNotifyId 同一实现（防自检拒掉 runtime 生成的 lifetime watch）。
 */
export function isSessionManagerWatchParams(v: unknown): v is SessionManagerWatchParams {
  if (!isRecord(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === 'notifyId' && isSessionManagerNotifyId(v.notifyId)
}

/** create 结果 */
export interface SessionManagerCreateResult {
  sessionId: string
  status: 'created'
  modelId?: string
  /**
   * 完成通知债权是否已 arm（notify-once D6，LLM 契约面显式化）：create 无 prompt /
   * notifyId 缺省或畸形 → false（零完成通知）；true 时首次完成恰回一条通知。
   * 注意与 lifetimeNotifyId 正交——后者恒存在（死亡通知与债权无关）。
   */
  willNotify: boolean
  /**
   * runtime 在 handleCreate 自动 arm 的 lifetime（死亡）通知幂等键（notify-once D2/D5）：
   * create 成恒返回、`sm-` 同形态同校验；与 params.notifyId（claim 键）双键独立，
   * 杜绝撞幂等键。extension 据此注册 pending（register id = 本键）并开终身 watch。
   */
  lifetimeNotifyId: string
}

/**
 * send 结果（sd-u5 起）：消息已入队/已投递——目标 busy 时在下一 turn 边界注入。
 * 失败形状走 SessionManagerErrorResult（error + hint），不再出现旧的 {blocked, rejected}。
 */
export interface SessionManagerSendResult {
  queued: true
  /** 完成通知债权是否已 arm（notify-once D6）：notifyId 缺省/畸形 → false（零完成通知） */
  willNotify: boolean
}

/** history 结果 */
export interface SessionManagerHistoryResult {
  messages: unknown[]
  truncated: boolean
}

/** status 结果 */
export interface SessionManagerStatusResult {
  status: string
  modelId?: string
  /**
   * 「未送达结果」事实计数（notify-once D6/D7，非警示布尔）：orphaned 与
   * fulfilled-no-watch（TTL 清扫转入）两态的在册总数。天然无清除语义问题、无
   * cry-wolf；持久化二期补投时递减自洽。ownership 校验同其余按 sessionId 寻址的 action。
   */
  undeliveredResults: number
}

/** list 结果 */
export interface SessionManagerListResult {
  sessions: SessionManagerSessionSummary[]
  /** 「未送达结果」事实计数（语义同 status：发起方名下全量在册数） */
  undeliveredResults: number
}

/** list 返回的 session 摘要（精简版） */
export interface SessionManagerSessionSummary {
  id: string
  label: string
  cwd: string
  status: string
  spawnSource?: 'user' | 'agent'
  parentAgentSessionId?: string
}

/** abort 结果 */
export interface SessionManagerAbortResult {
  success: boolean
}

// ── watch respond 契约（notify-once D2/D3/D6） ──

/**
 * watch 应答 reason 词表（封闭 7 值）——与 pending-entries `mapReasonToStatus` 的
 * 4 个新 case 同词形（stopped→aborted、exited/deleted/orphaned→cancelled），
 * **不扩共享词表**：精确状态由通知正文与 `get_session_status` 承载。
 */
export type SessionManagerWatchReason =
  /** settle 兑现 / catch-up 快照（outcome 映射 completed/failed/stopped） */
  | 'completed'
  | 'failed'
  | 'stopped'
  /** 终局死亡（delete/forceQuit/不可恢复 crash；respawn 链静默不发声） */
  | 'exited'
  | 'deleted'
  /** 静默折叠（主 abort / 二次校验归属失效 / fail-closed 查无 claim / 旧 runtime 兼容象限） */
  | 'cancelled'
  /** orphan 吸收态（父 pi 死亡批量转移 / TTL 清扫 / respond 失败） */
  | 'orphaned'

const WATCH_REASON_SET: ReadonlySet<string> = new Set<SessionManagerWatchReason>([
  'completed',
  'failed',
  'stopped',
  'exited',
  'deleted',
  'cancelled',
  'orphaned',
])

/**
 * watch respond payload（notify-once D6，全 additive）——extension 侧 watch 响应的
 * 唯一权威形状。旧 runtime 象限 respond `null`（不识 watch action），由 extension
 * 折叠 cancelled——null 不在本类型内，消费方须同时处理。
 */
export interface SessionManagerWatchRespondPayload {
  /** 分拣键 (sessionId, reason) 的 reason 腿（D3 两层模型：cancelled/orphaned → 仅
   *  unregister；exited/deleted → 死亡新闻槽；completed/failed/stopped → 结果新闻） */
  reason: SessionManagerWatchReason
  /**
   * claim 所属子会话 id 回带——D3 槽键 (sessionId, deathSeq) / 分拣键 (sessionId,
   * reason) / D9 文案 `<sid>` 的唯一数据源（收口腿闭包仅有父 sid，缺此字段则同父
   * 多子 deathSeq 跨 child 碰撞）。claim 命中路径（settle/death/orphaned/二次校验）
   * 恒带；fail-closed（查无 claim）无 claim 可回带 → 缺席——该路径 reason 恒
   * 'cancelled'，extension 静默收口不消费 sessionId。
   */
  sessionId?: string
  /** death 批身份（per session 递增；同一死亡事件循环 respond 时 runtime 直供） */
  deathSeq?: number
  /** settle 批身份（per session 递增；批身份 = settleSeq/deathSeq——同批身份才合一条 record） */
  settleSeq?: number
  /** 本批兑现总笔数（同批每条应答携带同值）；death 侧 = 同 deathSeq 的 claim 数（D3 合批口径，runtime 直供，死亡/结果新闻正文消费 fulfills N） */
  fulfillsN?: number
  /** death 应答携带：exit 腿诊断数据通路复刻（400 字截尾沿用现值），extension 文案构造消费 */
  exitCode?: number | null
  stderrTail?: string
  /**
   * 会话文件绝对路径（additive optional，notify-once D9）：通知正文 `Full transcript:`
   * 指针行的唯一数据源（`~/.taiji/agent/sessions/.../<sid>.jsonl` 形态）。死亡/settle
   * 应答携带（正文构造消费）；fail-closed 等无 claim 应答不携（该路径静默无文案）。
   */
  sessionFilePath?: string
}

/**
 * watch respond payload 运行时守卫（extension 读侧不信任外部格式——AGENTS 关键规则 5）：
 * null（旧 runtime 象限）/ 非 record / reason 缺失、非 string 或词表外 / 可选 meta
 * 类型不符 → false（可选字段缺席一律放行——含 sessionFilePath）。消费方对 false 与
 * null 同路折叠静默 unregister（fail-safe：未知 reason 不得落 default 误标）。
 */
export function isSessionManagerWatchRespondPayload(
  v: unknown,
): v is SessionManagerWatchRespondPayload {
  if (!isRecord(v)) return false
  if (typeof v.reason !== 'string' || !WATCH_REASON_SET.has(v.reason)) return false
  if (v.sessionId !== undefined && typeof v.sessionId !== 'string') return false
  if (v.deathSeq !== undefined && typeof v.deathSeq !== 'number') return false
  if (v.settleSeq !== undefined && typeof v.settleSeq !== 'number') return false
  if (v.fulfillsN !== undefined && typeof v.fulfillsN !== 'number') return false
  if (v.exitCode !== undefined && v.exitCode !== null && typeof v.exitCode !== 'number') return false
  if (v.stderrTail !== undefined && typeof v.stderrTail !== 'string') return false
  if (v.sessionFilePath !== undefined && typeof v.sessionFilePath !== 'string') return false
  return true
}

/** 错误响应形状（send 同步失败时 = { error, hint }；create 已成功时另附 sessionId）。
 * D8 单源化：交集扩展 alias——error/hint 单源于 core 的 ChannelErrorResult，sessionId
 * 为本协议独有扩展（runtime session-manager-handler 活构造：create 已成功但后续步骤
 * 失败时附 sessionId + hint 恢复路径）。导出名与文件位置不变，public API 零破坏。 */
export type SessionManagerErrorResult = ChannelErrorResult & { sessionId?: string }
