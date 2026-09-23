import { readUiLocale } from '@zhushanwen/pi-llm-shared/ui-locale'

import { formatRelativeTime, formatSchedule } from './format.js'
import type { UiLocale } from './format.js'
import type { ScheduleSpec, ScheduledTask, TaskKind, TaskStatus } from './types.js'

export type { UiLocale } from './format.js'
export { readUiLocale }

/**
 * L2 extension 侧词典 + locale 读取接线（设计 §6.6 D6 / §7.1）。
 *
 * 语言归属原则（D6）：跨边界只走数据——renderer 是语言权威，进程只读派生态。
 * 读取器（readUiLocale + mtime+size 双键读缓存 + 降级）下沉在
 * `@zhushanwen/pi-llm-shared` 单一实现（@data-owner #39 注解随实现持有）；
 * 需求方（本包与 plan 的 i18n 层）经 import 消费，不再各自就地实现。
 *
 * 三个渲染入口按受众分工（设计 §6.9「双受众」）：
 * - `t(key, params)`：单条词典模板
 * - `renderResult(messageKey, params, locale)`：toast / 命令反馈（12+ 条命令反馈）
 * - `renderTaskLine(taskParams, locale)`：**命令变体**任务行（状态●/○ + id + name + 摘要 +
 *   相对时间 + 执行状态摘要），调用面 = list 行 / toast 内部组合，`renderResult` 内部复用、
 *   不重实现
 * - `renderTaskLineStatic(taskParams, locale)`：**widget 静态变体**（状态●/○ + id + name +
 *   静态调度描述，无任何 now 派生段），仅供 widget GUI body——两变体拆分是 scheduler
 *   widget 推送修正设计 D1-a 的渲染单点裁决：命令层是按需呈现面（保留相对时间），widget
 *   显示面静态化是指纹跳推的前置
 *
 * L4（模型可见的 tool result）**不**经本模块——`service.ts` 的 `message` 字段保留英文回退。
 */

export const DEFAULT_UI_LOCALE: UiLocale = 'en-US'

// ── messageKey ↔ params 判别联合（设计 §7.1：按 messageKey 分型的 locale-neutral 原始值）──
//
// 命名避开 `errorCode` 族（刚被 ext-simplify-08 删除）：语义 = 本地化键（呈现层查词典），
// **非**错误分类——成功/失败均可用同一字段。消费者 = commands/interaction 的 notify 路径
// （u-p2b 经 renderResult 接线）；`service.ts` 的 message 保留为 L4 英文回退。

/** 任务 id 参数（notFound / deleted / enabled / disabled / executed / notDispatched 共用）。 */
export interface TaskIdParams {
  id: string
}

/** 任务数上限参数。 */
export interface TaskLimitParams {
  max: number
}

/** 非法时间表达式参数。 */
export interface ScheduleInvalidParams {
  input: string
}

/**
 * 单任务 locale-neutral 原始值（create toast / list 行 / widget 共用形状）。
 *
 * 判别联合：调度规格按 `mode` **显式**分支（设计 r4 M1「禁 nullable 推断」）——
 * 不得靠 `intervalMs === undefined` / `cron === undefined` 推断类型；`kind`
 * （once / recurring）与 `mode`（interval / cron）是正交维度，两者均保留。
 */
export type TaskScheduleParams =
  | { mode: 'interval'; intervalMs: number }
  | { mode: 'cron'; cron: string }

export type TaskParams = TaskScheduleParams & {
  id: string
  name: string
  kind: TaskKind
  nextRunAt: number
  now: number
  expiresAt?: number
  /** 启用态（必填）：list 行首●/○由此派生（r5 追补：缺失会致停用任务被渲染成启用）。 */
  enabled: boolean
  /**
   * 执行状态摘要（可选；仅命令层 `task.list` 行尾消费，见 renderLastExecSummary）。
   * widget 静态变体**不消费**本字段：摘要不在 widget 指纹字段集内，进显示面会造出
   * 「显示已变、指纹未变」的冻结缺口（scheduler widget 推送修正设计 D1-a/被否③）；
   * 失败可见性补偿只进命令查询面（按需呈现，零推送成本）。
   */
  lastExec?: { lastStatus: TaskStatus; recentFailures: number }
}

/** 非空任务列表参数（list 行由 renderResult 单点拼装，命令层不得逐行拼）。 */
export interface TaskListParams {
  n: number
  tasks: TaskParams[]
  now: number
}

/** 空参数占位（`task.list.empty`）。 */
export type EmptyParams = Record<string, never>

/**
 * 命令层自有串参数（r4 S3 载体裁决）：与 service messageKey **同形 key + params**，
 * 统一走同一 `renderResult` 单入口，**不引入第二套结果类型**（`CommandReply`）。
 * 命令层自有输出（`Usage: …` / `Scheduler not initialized` / 无交互通道 / 表单通道错误 /
 * `/schedule` description）经 `ServiceResult.messageKey` 通道送达 notify（rpc/tui）或
 * throw（json/print）——两受众（L2 toast / L4 tool result）不串。
 */
export interface CommandMessageParamsMap {
  'usage.toggle': { keyword: 'on' | 'off' }
  'usage.rm': EmptyParams
  'usage.run': EmptyParams
  'usage.create': EmptyParams
  'command.notInitialized': EmptyParams
  'command.description': EmptyParams
  'no-interaction': EmptyParams
  'form.channelUnavailable': EmptyParams
  'form.protocolMismatch': EmptyParams
}

/** messageKey → params 形状映射（判别联合的单一登记处；新增键必须同步 RESULT_RENDERERS）。 */
export interface ServiceMessageParamsMap extends CommandMessageParamsMap {
  'task.created': TaskParams
  'task.list': TaskListParams
  'task.list.empty': EmptyParams
  'task.notFound': TaskIdParams
  'task.deleted': TaskIdParams
  'task.enabled': TaskIdParams
  'task.disabled': TaskIdParams
  'task.executed': TaskIdParams
  'task.notDispatched': TaskIdParams
  'task.limit': TaskLimitParams
  'schedule.invalid': ScheduleInvalidParams
}

export type ServiceMessageKey = keyof ServiceMessageParamsMap

/**
 * messageKey ↔ params 判别联合（key 与 params 形状的相关性集中在此）；
 * `service.ts` 的 ServiceResult 与本模块的 renderResult 共用，保证两端形状不漂移。
 */
export type ServiceMessage<K extends ServiceMessageKey = ServiceMessageKey> = {
  [P in K]: { messageKey: P; params: ServiceMessageParamsMap[P] }
}[K]

/**
 * messageKey 词表（机器化守卫用：`service.test.ts` 断言「词典 key 集合 ⊇ 本表 + tray.title」）。
 * RESULT_RENDERERS 的映射类型已提供编译期穷尽校验；本数组供测试与词典对账。
 */
export const SERVICE_MESSAGE_KEYS: readonly ServiceMessageKey[] = [
  'task.created',
  'task.list',
  'task.list.empty',
  'task.notFound',
  'task.deleted',
  'task.enabled',
  'task.disabled',
  'task.executed',
  'task.notDispatched',
  'task.limit',
  'schedule.invalid',
  // 命令层自有串（u-p2b 接线，与上面 service 键同形、同通道）
  'usage.toggle',
  'usage.rm',
  'usage.run',
  'usage.create',
  'command.notInitialized',
  'command.description',
  'no-interaction',
  'form.channelUnavailable',
  'form.protocolMismatch',
]

// ── ack 文案键（u-ack-fallback 单点）──
//
// ack 文案**不经** ServiceMessage 通道（设计 §3.3 D7）：它不是服务结果——`ack.confirm` 是
// 合成 assistant 行的正文，`ack.notPersisted*` 是同步/异步通知文案（一个键两阶段共用）。
// 故不做 messageKey↔params 判别联合，只以键常量露出：ack-notify.ts 消费常量而非字面量，
// 键名改动由编译期兜住（改词典键漏改消费侧曾是本仓高频漂移形态）。

/** 合成确认行正文（合成 assistant 消息 body）。插值参数：`{name}`、`{schedule}`。 */
export const ACK_CONFIRM_KEY = 'ack.confirm'
/** 落盘失败如实文案（同步与异步共用同一键）。插值参数：`{name}`。 */
export const ACK_NOT_PERSISTED_KEY = 'ack.notPersisted'

// ── 词典（zh-CN / en-US，文案表见设计 §7.5）──

type Dictionary = Record<string, string>

const ZH_CN: Dictionary = {
  // 命令反馈（L2）
  'task.created': '已创建 {id}：{name} · {schedule} · 下次运行 {relative}',
  'task.list': '### 定时任务 {n} 条',
  'task.list.empty': '没有定时任务',
  'task.notFound': '任务 {id} 不存在',
  'task.deleted': '已验证删除 {id}',
  'task.enabled': '已启用 {id}',
  'task.disabled': '已停用 {id}',
  'task.executed': '任务 {id} 已执行',
  'task.notDispatched': '任务 {id} 未派发（已停用 / 触发受限 / 正在派发中）',
  'task.limit': '任务数已达上限（{max}），请先删除一个',
  'schedule.invalid': '无法解析的时间表达式：{input}',
  // 执行状态摘要（task.list 行尾；widget 静态面不带——scheduler widget 推送修正设计 D1）
  // 失败可见性优先裁决：窗口内有失败即失败形态（n = 近期失败计数），否则成功形态
  'task.lastOk': '上次: 成功',
  'task.lastFailures': '上次: 失败×{n}',

  // 命令层自有串（u-p2b 接线）
  'usage.toggle': '用法：/schedule {keyword} <id>',
  'usage.rm': '用法：/schedule rm <id>',
  'usage.run': '用法：/schedule run <id>',
  'usage.create': '用法：/schedule <时间> <提示词>',
  'command.notInitialized': '调度器未初始化：会话尚未启动',
  'command.description': '新建定时任务（打开表单）',

  // 错误文案
  'no-interaction': '当前模式无交互表单：请带参数创建，或让 agent 创建',
  'form.channelUnavailable': '表单通道不可用（宿主版本过旧）：请改用对话让 agent 创建',
  'form.protocolMismatch': '表单协议版本不匹配：请升级宿主或改用 agent 路径',

  // ack 确认轮（合成确认行 + 落盘失败如实文案）
  // 措辞边界：只承诺「写入会话文件」（本机制的唯一保证），不得写「已持久化 / 已保存到磁盘」
  // 之类存储级承诺——ack.notPersisted 是失败面，confirm 是成功面，两者都不越界。
  'ack.confirm': '已保存任务：{name}（{schedule}）。',
  'ack.notPersisted': '已创建任务 {name}，但未写入会话文件。在本会话说一句话即可保存。',

  // 托盘标题（扩展自产，宿主零改动）
  'tray.title': '定时任务',

  // TUI widget 文本行（静态面：任务名 + 静态调度描述，无相对时间/逾期段——D1 静态化）
  'widget.title': '定时任务',
  'widget.count': '{n} 条',
  'widget.task': '{name} {schedule}',
  'widget.line': '[{title}] {parts}',
}

const EN_US: Dictionary = {
  // 命令反馈（L2）
  'task.created': 'Created {id}: {name} · {schedule} · next run {relative}',
  'task.list': '### Scheduled ({n})',
  'task.list.empty': 'No scheduled tasks',
  'task.notFound': 'Task {id} not found',
  'task.deleted': 'Task {id} deleted',
  'task.enabled': 'Task {id} enabled',
  'task.disabled': 'Task {id} disabled',
  'task.executed': 'Task {id} executed',
  'task.notDispatched': 'Task {id} not dispatched (disabled, rate-limited, or dispatch in flight)',
  'task.limit': 'Task limit reached ({max}) — delete one first',
  'schedule.invalid': 'Invalid schedule: {input}',
  // 执行状态摘要（task.list 行尾；措辞裁决同 zh 侧）
  'task.lastOk': 'last: ok',
  'task.lastFailures': 'last: failed×{n}',

  // 命令层自有串（u-p2b 接线）
  'usage.toggle': 'Usage: /schedule {keyword} <id>',
  'usage.rm': 'Usage: /schedule rm <id>',
  'usage.run': 'Usage: /schedule run <id>',
  'usage.create': 'Usage: /schedule <schedule> <prompt>',
  'command.notInitialized': 'Scheduler not initialized: session not started.',
  'command.description': 'Create a scheduled task (opens form)',

  // 错误文案
  'no-interaction': 'No interactive form in this mode — pass arguments or ask the agent',
  'form.channelUnavailable': 'Form channel unavailable (host too old) — ask the agent instead',
  'form.protocolMismatch': 'Form protocol mismatch — upgrade the host or use the agent path',

  // ack 确认轮（合成确认行 + 落盘失败如实文案）——措辞边界同 zh 侧
  'ack.confirm': 'Task saved: {name} ({schedule}).',
  'ack.notPersisted':
    'Created task {name}, but it was not written to the session file. Say anything in this session to save it.',

  // 托盘标题（扩展自产，宿主零改动）
  'tray.title': 'Scheduled tasks',

  // TUI widget 文本行（静态面：任务名 + 静态调度描述，无相对时间/逾期段——D1 静态化）
  'widget.title': 'scheduler',
  'widget.count': '{n} scheduled',
  'widget.task': '{name} {schedule}',
  'widget.line': '[{title}] {parts}',
}

const DICTIONARIES: Record<UiLocale, Dictionary> = {
  'zh-CN': ZH_CN,
  'en-US': EN_US,
}

/** 指定语言的词典 key 集合（测试用于 zh/en 双侧对齐 + 超集断言）。 */
export function dictionaryKeys(locale: UiLocale): string[] {
  return Object.keys(DICTIONARIES[locale])
}

// ── 模板渲染 ──

/**
 * 渲染词典模板。键缺失 → 回落 en 值 → 再回落键名本身（**禁返回空串**，设计 r4 S1）：
 * 所有经 `t()` 赋值的字段因此天然非空——防「空标题在 nullish 渲染面显示空白段头」
 * 从词典后门回潮（`meta.title` 依赖本保证）。占位符缺参时保留 `{name}` 原样（非空）。
 */
export function t(key: string, params?: Record<string, string | number>, locale?: UiLocale): string {
  const resolved = locale ?? readUiLocale()
  const template = DICTIONARIES[resolved][key] ?? DICTIONARIES[DEFAULT_UI_LOCALE][key] ?? key
  return interpolate(template, params)
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

// ── 形状投影 ──

/**
 * 执行状态摘要投影（ScheduledTask.history/lastStatus → TaskParams.lastExec 单点）：
 * recentFailures = history 定长窗口（HISTORY_LIMIT=20）内失败计数；无任何执行记录
 * （history 空且 lastStatus 缺）→ undefined = 行尾不显示摘要段。
 * 失败记账为进程内存态（失败 dispatch 无 jsonl op），跨 resume/重启后计数归零、
 * lastStatus 回落 success——已披露边界，见 scheduler widget 推送修正设计 D1 代价四要素。
 */
function toLastExec(task: ScheduledTask): TaskParams['lastExec'] {
  const recentFailures = task.history.filter(h => h.status === 'failed').length
  if (recentFailures === 0 && task.lastStatus === undefined) return undefined
  return { lastStatus: task.lastStatus ?? 'success', recentFailures }
}

/** ScheduledTask → locale-neutral TaskParams（service 与 widget 共用同一投影，防双口径）。 */
export function toTaskParams(task: ScheduledTask, now: number): TaskParams {
  const base = {
    id: task.id,
    name: task.name,
    kind: task.kind,
    nextRunAt: task.nextRunAt,
    now,
    expiresAt: task.expiresAt,
    enabled: task.enabled,
    // 摘要随投影携带；仅命令变体消费（widget 静态变体忽略——不在指纹字段集内）
    lastExec: toLastExec(task),
  }
  return task.schedule.mode === 'interval'
    ? { ...base, mode: 'interval', intervalMs: task.schedule.intervalMs }
    : { ...base, mode: 'cron', cron: task.schedule.cronExpression }
}

function toScheduleSpec(task: TaskParams): ScheduleSpec {
  // 显式按 mode 分支（设计 r4 M1）：不靠 intervalMs/cron 空值推断
  return task.mode === 'interval'
    ? { mode: 'interval', intervalMs: task.intervalMs }
    : { mode: 'cron', cronExpression: task.cron }
}

// ── 三个渲染入口 ──

/**
 * 执行状态摘要段（task.list 行尾，D1 失败可见性补偿；widget 静态面不带）。
 * 失败可见性优先：窗口内有失败即失败形态（`上次: 失败×n`，n = 近期失败计数——即使最近
 * 一次执行成功，窗口内存在失败也须让用户看见，否则静默失败不可发现与 G3 语义冲突）；
 * 无失败但有记录 → 成功形态；无任何记录 → 空串（行尾不追加段）。
 */
function renderLastExecSummary(lastExec: TaskParams['lastExec'], locale: UiLocale): string {
  if (!lastExec) return ''
  return lastExec.recentFailures > 0
    ? t('task.lastFailures', { n: lastExec.recentFailures }, locale)
    : t('task.lastOk', undefined, locale)
}

/**
 * **命令变体**任务行（list 行 / toast 内部组合共用口径；实现只此一处）：
 * `{状态} {id} {name} · {摘要} · {相对时间}[ · {执行状态摘要}]`——状态由 `enabled` 在
 * **代码**派生（r5 追补：不得把 ●/○ 做成词典固定字面量，否则停用任务本地化后会显示为
 * 启用）；摘要/相对时间走带 locale 的格式化器现算（params 只携带原始值）。
 * 相对时间**保留**：命令层是按需呈现面（用户主动触发，无推送放大成本），schedule tool
 * 的「next run time」承诺依赖它（scheduler widget 推送修正设计 D1-a）。
 */
export function renderTaskLine(taskParams: TaskParams, locale: UiLocale): string {
  const state = taskParams.enabled ? '●' : '○'
  const schedule = formatSchedule(toScheduleSpec(taskParams), taskParams.kind, locale)
  const relative = formatRelativeTime(taskParams.nextRunAt, locale, taskParams.now)
  const segments = [`${state} ${taskParams.id} ${taskParams.name}`, schedule, relative]
  const lastExecSummary = renderLastExecSummary(taskParams.lastExec, locale)
  if (lastExecSummary) segments.push(lastExecSummary)
  return segments.join(' · ')
}

/**
 * **widget 静态变体**任务行（仅供 widget GUI body，`buildSchedulerWidgetItems` 单点消费）：
 * `{状态} {id} {name} · {静态调度描述}`——无任何 now 派生段（相对时间/逾期标记/执行摘要
 * 都不进 widget 行），显示面 = f(稳定字段, locale)。这是 index.ts 任务集指纹跳推的完备性
 * 前提（D1-a）：now 派生元素会造出「显示已变而指纹不变」的冻结缺口（P6 反例基线）。
 */
export function renderTaskLineStatic(taskParams: TaskParams, locale: UiLocale): string {
  const state = taskParams.enabled ? '●' : '○'
  const schedule = formatSchedule(toScheduleSpec(taskParams), taskParams.kind, locale)
  return `${state} ${taskParams.id} ${taskParams.name} · ${schedule}`
}

function renderTaskCreated(params: TaskParams, locale: UiLocale): string {
  const schedule = formatSchedule(toScheduleSpec(params), params.kind, locale)
  const relative = formatRelativeTime(params.nextRunAt, locale, params.now)
  // id 必须入模板（r5 追补）：`rm <id>` 依赖它在人侧 toast 可见
  return t('task.created', { id: params.id, name: params.name, schedule, relative }, locale)
}

function renderTaskList(params: TaskListParams, locale: UiLocale): string {
  // list 在词典层单点拼装（设计 v6）：行格式化复用 renderTaskLine（命令变体），命令层不得逐行拼。
  // 执行状态摘要由 renderTaskLine 行尾追加（D1 失败可见性补偿）——task.created toast 不加
  // （e2e S18 断言锚定其全行文本，scheduler widget 推送修正设计宿主不变量）。
  const header = t('task.list', { n: params.n }, locale)
  return [header, ...params.tasks.map(task => renderTaskLine(task, locale))].join('\n')
}

type ResultRendererMap = {
  [K in ServiceMessageKey]: (params: ServiceMessageParamsMap[K], locale: UiLocale) => string
}

/** 映射类型提供编译期穷尽校验：新增 messageKey 而漏渲染器即报错。 */
const RESULT_RENDERERS: ResultRendererMap = {
  'task.created': renderTaskCreated,
  'task.list': renderTaskList,
  'task.list.empty': (_params, locale) => t('task.list.empty', undefined, locale),
  'task.notFound': (params, locale) => t('task.notFound', { id: params.id }, locale),
  'task.deleted': (params, locale) => t('task.deleted', { id: params.id }, locale),
  'task.enabled': (params, locale) => t('task.enabled', { id: params.id }, locale),
  'task.disabled': (params, locale) => t('task.disabled', { id: params.id }, locale),
  'task.executed': (params, locale) => t('task.executed', { id: params.id }, locale),
  'task.notDispatched': (params, locale) => t('task.notDispatched', { id: params.id }, locale),
  'task.limit': (params, locale) => t('task.limit', { max: params.max }, locale),
  'schedule.invalid': (params, locale) => t('schedule.invalid', { input: params.input }, locale),
  // 命令层自有串（u-p2b 接线）
  'usage.toggle': (params, locale) => t('usage.toggle', { keyword: params.keyword }, locale),
  'usage.rm': (_params, locale) => t('usage.rm', undefined, locale),
  'usage.run': (_params, locale) => t('usage.run', undefined, locale),
  'usage.create': (_params, locale) => t('usage.create', undefined, locale),
  'command.notInitialized': (_params, locale) => t('command.notInitialized', undefined, locale),
  'command.description': (_params, locale) => t('command.description', undefined, locale),
  'no-interaction': (_params, locale) => t('no-interaction', undefined, locale),
  'form.channelUnavailable': (_params, locale) => t('form.channelUnavailable', undefined, locale),
  'form.protocolMismatch': (_params, locale) => t('form.protocolMismatch', undefined, locale),
}

/** toast / 命令反馈渲染入口：按 messageKey 取渲染器，params 就地本地化（不携带英文串）。 */
export function renderResult<K extends ServiceMessageKey>(
  messageKey: K,
  params: ServiceMessageParamsMap[K],
  locale: UiLocale,
): string {
  return RESULT_RENDERERS[messageKey](params, locale)
}

/** ServiceResult 的最小可本地化形状（`service.ts` 的 `ServiceResult` 结构上满足）。 */
export type LocalizableResult = { message: string } & (
  | ServiceMessage
  | { messageKey?: undefined; params?: undefined }
)

/**
 * 结果 → L2 文本（commands / interaction 呈现层的单入口）：有 `messageKey` 走
 * `renderResult` 词典渲染（含命令层自有串）；未分类失败（无 key，如 `service.ts` 的
 * `id is required` / `toErrorMessage` catch-all）回落英文 `message`（设计 §6.9 已声明）。
 * 两受众不串：L4 tool result 直接用 `message`，不经本函数。
 */
export function renderResultText(result: LocalizableResult, locale: UiLocale): string {
  if (result.messageKey === undefined) return result.message
  return renderResult(result.messageKey, result.params, locale)
}
