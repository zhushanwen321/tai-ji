/**
 * LLM 重试规则域（类型 + 校验 + 判定管线纯函数 SSOT，subagent-observability §3.3.12）。
 *
 * 四个消费方共用同一套语义（llm-retry / network-proxy 域同款纪律）：
 * - runtime 写侧：ext-config 落盘校验 + 合并视图（编译期基线 ⊕ 远程覆盖 ⊕ 用户自定义）；
 * - settings 展示与表单：内置预设展示 + 自定义规则编辑校验（SystemRetryRulesSection）；
 * - retry-rules extension（pi 孙进程）：message_end 判定管线。extension bundle 自包含
 *   不 import shared 运行时代码（network-proxy 同款惯例：结构类型本地声明 + 行为镜像
 *   锁定测试），本模块是匹配与判定语义 SSOT——复制体漂移时以本文件为准；
 * - pi-subagent-cli 失败分类侧（收尾边沿分类码表消费）：行为镜像复制体位于
 *   packages/pi-subagent-cli/src/retry-rules-classification.ts（自声明镜像 SSOT，
 *   output-collector.test.ts 锁行为一致）。
 *
 * 判定管线两层序（设计定稿，UC-23 走查缺陷修复）：
 *   第一层按 verdict 排除——non_retryable 规则优先于 retryable/conditional（先排除再放行，
 *   账户类错误永不误重试，不区分 source）；第二层同 verdict 内按 source 序
 *   custom > remote > builtin（用户显式意图压过热更新压过随发版基线），命中即断。
 *
 * 条目统一 schema = {匹配键, class, kind, verdict, waitHint 来源}（§3.3.12 简洁审定稿）：
 * 同一 provider 错误码事实一次登记覆盖两个消费方——收尾边沿失败分类读 class/kind/verdict
 * （§3.3.2 分类码表，分类侧与改写侧消费同一 ext-config 文件的 effectiveRules 段）、
 * message_end 改写判定读 verdict/match。
 *
 * 执行语义：retryable = 改写触发 pi 原生重试；non_retryable 与 conditional = 不改写
 * （conditional 单独成态仅为 settings 展示解释「为什么不自动重试」——等不到的人/账户
 * 动作 extension 做不了，恢复指引经轮应答传达）。改写文本追加 `[taiji-retry:` 标记
 * （探针硬约束：追加式非替换式，原文保留无信息丢失——§3.3.12 改写落盘约束）。
 */

import type { AssertMutuallyAssignable, FailureCause } from '@zhushanwen/subagent-engine-sdk'
import type { FailureCauseClass } from './subagent.js'

// ───────────────────────── 词表 ─────────────────────────

/** 规则裁决三态（verdict 字面统一下划线形态；执行语义见文件头注）。 */
export type RetryRuleVerdict = 'retryable' | 'non_retryable' | 'conditional'

export const RETRY_RULE_VERDICTS = ['retryable', 'non_retryable', 'conditional'] as const satisfies readonly RetryRuleVerdict[]

/** 规则出处（两层序第二层的排序键；custom > remote > builtin）。 */
export type RetryRuleSource = 'custom' | 'remote' | 'builtin'

/** HTTP 状态大类词表（httpStatusClass 标注字段的合法值域；4xx 客户端侧 / 5xx 服务端瞬态侧的常用码段——纯溯源/展示分组，判定函数结构上不消费）。 */
export const RETRY_RULE_HTTP_STATUS_CLASSES = {
  badRequest: 400,
  unauthorized: 401,
  paymentRequired: 402,
  forbidden: 403,
  failedDependency421: 421,
  tooManyRequests: 429,
  internalServerError: 500,
  badGateway: 502,
  serviceUnavailable: 503,
  gatewayTimeout: 504,
} as const

/** HTTP 状态大类（词表对象的值域推导，封闭枚举）。 */
export type RetryRuleHttpStatusClass = (typeof RETRY_RULE_HTTP_STATUS_CLASSES)[keyof typeof RETRY_RULE_HTTP_STATUS_CLASSES]

// ───────────────────────── 匹配通道 ─────────────────────────

/**
 * 单条匹配条件（对 errorMessage 文本；match[] 全部命中才算命中，AND 语义）。
 *
 * 双通道（message_end 只见 errorMessage 文本，结构化字段在 pi 适配层已展平）：
 * - pattern：对整条 errorMessage 做正则（i flag，pi 上游词表同款；带 ReDoS 防护）；
 * - jsonPath：从 errorMessage 提取首个 JSON 平衡片段，按点路径取值后比较
 *   （openai 兼容层 errorMessage 恒为 `"${status}: ${body-json}"` 拼法，body 内
 *   业务码可经 path 提取——§3.3.2 机读主通道的匹配侧表达）。
 */
export type RetryRuleMatch =
  | { kind: 'pattern'; pattern: string }
  | { kind: 'jsonPath'; path: string; operator: 'equals' | 'contains' | 'exists'; value?: string }

export type RetryRuleMatchOperator = 'equals' | 'contains' | 'exists'

export const RETRY_RULE_MATCH_OPERATORS = ['equals', 'contains', 'exists'] as const satisfies readonly RetryRuleMatchOperator[]

// ───────────────────────── kind 词表（分类侧消费域） ─────────────────────────

/**
 * per-class kind 合法值域（运行时校验域）。权威 = sdk
 * FAILURE_CAUSE_KINDS_BY_CLASS（@zhushanwen/subagent-engine-sdk contract-types）；
 * shared 对 sdk 仅 type-only 引用（发布边界纪律），本表是校验用值副本——漂移由
 * RETRY_RULE_KINDS_BY_CLASS_LOCK 编译锁双向拦截（sdk 判别联合扩值/改值而本表未同步
 * 即 tsc 红）。engine 透传族是 `engine_${string}` 开放前缀面（无闭合枚举）不进本表，
 * 校验走前缀形态判定（validateRetryRuleFields）。
 */
export const RETRY_RULE_KINDS_BY_CLASS = {
  provider: ['rate_limited', 'protocol_unsupported'],
  harness: ['turn_budget_exhausted', 'timeout'],
  agent: ['no_deliverable'],
  user: ['cancelled'],
} as const

/**
 * kind 词表编译锁（双向）：本表各 class 元组 ↔ sdk FailureCause 判别联合对应 kind 联合。
 * 导出面 = 锁消费锚（测试防删断言；sdk 侧 FAILURE_CAUSE_KIND_VOCAB_LOCK 同款先例）。
 */
export const RETRY_RULE_KINDS_BY_CLASS_LOCK: AssertMutuallyAssignable<
  {
    provider: (typeof RETRY_RULE_KINDS_BY_CLASS)['provider'][number]
    harness: (typeof RETRY_RULE_KINDS_BY_CLASS)['harness'][number]
    agent: (typeof RETRY_RULE_KINDS_BY_CLASS)['agent'][number]
    user: (typeof RETRY_RULE_KINDS_BY_CLASS)['user'][number]
  },
  {
    provider: Extract<FailureCause, { class: 'provider' }>['kind']
    harness: Extract<FailureCause, { class: 'harness' }>['kind']
    agent: Extract<FailureCause, { class: 'agent' }>['kind']
    user: Extract<FailureCause, { class: 'user' }>['kind']
  }
> = true

// ───────────────────────── 域常量（校验合法域，唯一依据） ─────────────────────────

export const RETRY_RULES_DOMAIN = {
  /** 正则源长度上限（ReDoS 防护第一道：长度封顶）。 */
  patternMaxLen: 200,
  /** id / name / path / value / waitHint 长度上限。 */
  idMaxLen: 64,
  nameMaxLen: 120,
  jsonPathMaxLen: 128,
  matchValueMaxLen: 256,
  waitHintMaxLen: 200,
  /** 单条规则 match 条件数上限。 */
  matchCountMax: 8,
  /** 用户自定义规则条数上限（判定为 message_end 全量扫描，条数封顶即成本封顶）。 */
  customRulesMax: 200,
  /** 匹配输入文本截断上限（超长 errorMessage 截断后匹配，封顶单次判定成本）。 */
  textMaxLen: 8192,
  /** HTTP 状态大类合法区间（httpStatusClass 标注字段的校验域；4xx/5xx 语义码段）。 */
  httpStatusClassMin: 400,
  httpStatusClassMax: 599,
} as const

// ───────────────────────── 条目类型 ─────────────────────────

/** 单条重试判定规则（统一条目 schema；class 值域与 FailureCause 分类同源）。 */
export interface RetryableErrorRule { // oe-exempt:20261026:framework:重试规则域契约类型，runtime 写侧 / settings 展示侧 / extension 判定侧多包消费，单实现为常态
  id: string
  /** 展示名（settings 预设列表行），如「智谱 1302 速率限制（HTTP 429）」。 */
  name: string
  verdict: RetryRuleVerdict
  match: RetryRuleMatch[]
  /** FailureCause 分类值（收尾边沿失败分类消费，§3.3.2 同源对齐；改写判定不消费）。 */
  class: FailureCauseClass
  /**
   * FailureCause kind 细分（可选——收尾边沿失败分类消费；缺省时分类侧按 class+verdict
   * 显式推导表落 kind）。值域 = {@link RETRY_RULE_KINDS_BY_CLASS} 该 class 的闭合面；
   * class="engine" 时走 `engine_${string}` 开放前缀面（校验见 validateRetryRuleFields）。
   */
  kind?: FailureCause['kind']
  /** 纯溯源标注，判定管线结构性不消费；settings 展示侧当前未消费（分组/检索能力未发生），保留为后续分组的声明位。 */
  httpStatusClass?: RetryRuleHttpStatusClass
  /** 展示/观测用等待提示（如「窗口重置后可重试」），不参与执行——实际退避归 pi 原生机制。 */
  waitHint?: string
  source: RetryRuleSource
}

// ───────────────────────── ext-config 文件 schema ─────────────────────────

/**
 * retry-rules ext-config 文件单一权威 schema（<piAgentDir>/config/retry-rules-ext-config.json）。
 *
 * - customRules：用户自定义规则全量存储（settings round-trip 对象；extension 判定不直接消费）；
 * - effectiveRules：runtime 合并持久段（基线 ⊕ 远程 ⊕ custom 合并视图）——extension 判定
 *   唯一消费段（extension 不持有基线副本、不感知远程通道，合并权威在 runtime，单一数据源）。
 *   runtime 未落盘（裸 pi 场景）时为空 = 判定恒 no_rule_match = 不改写（pi 原生词表兜底，
 *   安全缺省）。
 */
export interface RetryRulesExtConfig { // oe-exempt:20261026:framework:ext-config 文件单一权威 schema，runtime 写侧 / settings 展示侧 / extension 读侧三端消费
  version: 1
  customRules: RetryableErrorRule[]
  effectiveRules: RetryableErrorRule[]
}

/** 默认配置：空规则集（判定不生效，pi 原生词表兜底——默认无行为变化）。 */
export const DEFAULT_RETRY_RULES_EXT_CONFIG: RetryRulesExtConfig = {
  version: 1,
  customRules: [],
  effectiveRules: [],
}

/** remote-config retry-rules 域 payload 形状（configs/remote/retry-rules.json）。 */
export interface RetryRulesRemoteConfig { // oe-exempt:20261026:framework:远程配置域 payload 契约，runtime 拉取 guard 与基线对账消费
  version: 1
  /** 远程覆盖层：同 id 覆盖基线 + 新 id 追加（quota-fetchers 域同款合并语义）；source 由读侧归一为 'remote'。 */
  rules: Omit<RetryableErrorRule, 'source'>[]
}

// ───────────────────────── 校验（错误信封，逐项收集不短路） ─────────────────────────

export type RetryRulesValidationResult = { ok: true } | { ok: false; errors: string[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strWithin(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max
}

/**
 * 危险正则静态检测（ReDoS 防护）：
 * ① 源长度超上限；② 分组体内含量词且整组再跟量词的嵌套量词构造（`(.+)*`、`(?:a|b+)+`
 * 经典指数回溯形态）；③ 相邻区间量词（`{n,m}{k,}` 叠加回溯）。命中任一 = 危险。
 */
export function isDangerousRetryPattern(pattern: string): boolean {
  if (pattern.length > RETRY_RULES_DOMAIN.patternMaxLen) return true
  if (/\((?:[^()\\]|\\.)*[+*]\)[+*{]/.test(pattern)) return true
  if (/\{(?:\d+),(?:\d+)?\}\s*\{/.test(pattern)) return true
  return false
}

/** 匹配条件校验（pattern / jsonPath 双通道逐项收集）。 */
function collectMatchErrors(match: unknown, label: string): string[] {
  if (!Array.isArray(match)) {
    return [`${label} 必须是匹配条件列表，请至少添加一条匹配条件`]
  }
  if (match.length === 0) {
    return [`${label} 不能为空，请至少添加一条匹配条件`]
  }
  if (match.length > RETRY_RULES_DOMAIN.matchCountMax) {
    return [`${label} 条数超过上限 ${RETRY_RULES_DOMAIN.matchCountMax}，请合并条件`]
  }
  const errors: string[] = []
  for (let i = 0; i < match.length; i++) {
    const item = match[i]
    const at = `${label} 第 ${i + 1} 条`
    if (!isRecord(item)) {
      errors.push(`${at} 必须是对象，请重新编辑该匹配条件`)
      continue
    }
    if (item['kind'] === 'pattern') {
      const pattern = item['pattern']
      if (!strWithin(pattern, RETRY_RULES_DOMAIN.patternMaxLen)) {
        errors.push(`${at}（正则）为空或超过 ${RETRY_RULES_DOMAIN.patternMaxLen} 字符，请缩短正则表达式`)
        continue
      }
      if (isDangerousRetryPattern(pattern)) {
        errors.push(`${at}（正则）包含嵌套量词等高回溯构造，存在卡死风险，请简化正则（如用具体字符类替换 .+ 嵌套）`)
        continue
      }
      try {
        new RegExp(pattern, 'i')
      } catch {
        errors.push(`${at}（正则）语法无效，请修正后保存`)
      }
      continue
    }
    if (item['kind'] === 'jsonPath') {
      const path = item['path']
      const operator = item['operator']
      const value = item['value']
      if (!strWithin(path, RETRY_RULES_DOMAIN.jsonPathMaxLen) || /\s/.test(path)) {
        errors.push(`${at}（JSON 路径）为空、超过 ${RETRY_RULES_DOMAIN.jsonPathMaxLen} 字符或含空白，请填写如 error.code 的点路径`)
        continue
      }
      if (typeof operator !== 'string' || !RETRY_RULE_MATCH_OPERATORS.includes(operator as RetryRuleMatchOperator)) {
        errors.push(`${at}（JSON 路径）比较方式必须是 equals / contains / exists 之一`)
        continue
      }
      if (operator !== 'exists' && !strWithin(value, RETRY_RULES_DOMAIN.matchValueMaxLen)) {
        errors.push(`${at}（JSON 路径）比较值不能为空且不超过 ${RETRY_RULES_DOMAIN.matchValueMaxLen} 字符`)
      }
      continue
    }
    errors.push(`${at} 匹配通道必须是 pattern 或 jsonPath，请重新选择匹配方式`)
  }
  return errors
}

/**
 * kind 字段校验（值域闭合面按 class 归属判定）：
 * - class ∈ {@link RETRY_RULE_KINDS_BY_CLASS} 闭合面 → kind 必须 ∈ 该 class 词表；
 * - class="engine" → `engine_${string}` 开放前缀面（kind 必须以 engine_ 开头）；
 * - class 缺失或不在五值词表 → kind 不单独判值域（class 自身的错误已收集，避免双重报错
 *   让用户对着一条改不了的字段修）。
 * 文案含该 class 的合法值清单（错误 → 恢复动作闭环）。
 */
function collectKindErrors(kind: unknown, failureClass: unknown): string[] {
  if (kind === undefined) return []
  if (typeof kind !== 'string' || kind === '') {
    return [`失败分类细分（kind）必须是非空字符串: ${JSON.stringify(kind) ?? String(kind)}`]
  }
  if (failureClass === 'engine') {
    if (!kind.startsWith('engine_')) {
      return [`engine 类规则的 kind 必须以 engine_ 开头（如 engine_aborted）: ${kind}`]
    }
    return []
  }
  const allowed =
    typeof failureClass === 'string'
      ? RETRY_RULE_KINDS_BY_CLASS[failureClass as keyof typeof RETRY_RULE_KINDS_BY_CLASS]
      : undefined
  if (allowed === undefined) return []
  if (!(allowed as readonly string[]).includes(kind)) {
    return [
      `kind 必须是该分类的合法值之一（${allowed.join(' / ')}）: ${kind}——请修正 kind 或改选匹配的分类（class）`,
    ]
  }
  return []
}

/**
 * 单条规则校验（settings 自定义规则写侧、远程域 guard 与基线数据共用同一域）。
 * 错误逐项收集，文案面向用户且含修复动作（llm-retry / network-proxy 域同款）。
 * source 不在表单面（settings 固定写 custom / 远程读侧归一 remote），由组装方填。
 */
export function validateRetryRuleFields(rule: unknown): RetryRulesValidationResult {
  if (!isRecord(rule)) {
    return { ok: false, errors: [`重试规则必须是对象: ${JSON.stringify(rule) ?? String(rule)}`] }
  }
  const errors: string[] = []
  const { id, name, verdict, match, class: failureClass } = rule
  if (!strWithin(id, RETRY_RULES_DOMAIN.idMaxLen) || /\s/.test(id)) {
    errors.push(`规则 ID 为空、超过 ${RETRY_RULES_DOMAIN.idMaxLen} 字符或含空白，请填写如 zhipu-1302 的短标识`)
  }
  if (!strWithin(name, RETRY_RULES_DOMAIN.nameMaxLen)) {
    errors.push(`规则名称为空或超过 ${RETRY_RULES_DOMAIN.nameMaxLen} 字符，请填写简短名称`)
  }
  if (typeof verdict !== 'string' || !RETRY_RULE_VERDICTS.includes(verdict as RetryRuleVerdict)) {
    errors.push(`裁决必须是 retryable / non_retryable / conditional 之一: ${JSON.stringify(verdict) ?? String(verdict)}`)
  }
  if (typeof failureClass !== 'string') {
    errors.push('失败分类（class）不能为空，请选择该错误所属的分类')
  }
  errors.push(...collectKindErrors(rule['kind'], failureClass))
  errors.push(...collectMatchErrors(match, '匹配条件'))
  if (rule['httpStatusClass'] !== undefined) {
    const c = rule['httpStatusClass']
    const { httpStatusClassMin, httpStatusClassMax } = RETRY_RULES_DOMAIN
    if (typeof c !== 'number' || !Number.isInteger(c) || c < httpStatusClassMin || c > httpStatusClassMax) {
      errors.push(`HTTP 状态大类必须是 ${httpStatusClassMin}-${httpStatusClassMax} 的整数: ${JSON.stringify(c) ?? String(c)}`)
    }
  }
  if (rule['waitHint'] !== undefined && !strWithin(rule['waitHint'], RETRY_RULES_DOMAIN.waitHintMaxLen)) {
    errors.push(`等待提示为空或超过 ${RETRY_RULES_DOMAIN.waitHintMaxLen} 字符，请留空或填写简短提示`)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

/** 规则清单校验（数组 + 逐条 validateRetryRuleFields；id 重复拒绝——展示与覆盖语义都以 id 为键）。 */
export function validateRetryRuleList(rules: unknown, label: string): RetryRulesValidationResult {
  if (!Array.isArray(rules)) {
    return { ok: false, errors: [`${label} 必须是规则列表`] }
  }
  if (rules.length > RETRY_RULES_DOMAIN.customRulesMax) {
    return { ok: false, errors: [`${label} 条数超过上限 ${RETRY_RULES_DOMAIN.customRulesMax}，请删除不需要的规则`] }
  }
  const errors: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < rules.length; i++) {
    const result = validateRetryRuleFields(rules[i])
    if (!result.ok) errors.push(...result.errors.map((e) => `${label} 第 ${i + 1} 条：${e}`))
    const id = isRecord(rules[i]) ? rules[i]['id'] : undefined
    if (typeof id === 'string' && id !== '') {
      if (seen.has(id)) errors.push(`${label} 第 ${i + 1} 条：规则 ID「${id}」重复，请修改 ID`)
      seen.add(id)
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

/** ext-config 文件形状 guard（extension 读侧 normalize / runtime 读侧共用）。 */
export function isRetryRulesExtConfig(v: unknown): v is RetryRulesExtConfig {
  if (!isRecord(v) || v['version'] !== 1) return false
  if (!Array.isArray(v['customRules']) || !Array.isArray(v['effectiveRules'])) return false
  return (
    validateRetryRuleList(v['customRules'], 'customRules').ok &&
    validateRetryRuleList(v['effectiveRules'], 'effectiveRules').ok
  )
}

/** remote-config retry-rules 域 payload guard（整体拒用语义，quota-fetchers 域同款）。 */
export function isRetryRulesRemoteConfig(v: unknown): v is RetryRulesRemoteConfig {
  if (!isRecord(v) || v['version'] !== 1 || !Array.isArray(v['rules'])) return false
  return validateRetryRuleList(v['rules'], 'rules').ok
}

// ───────────────────────── 合并视图（纯函数） ─────────────────────────

/**
 * 合并视图：custom（用户层，置于前）+ 基线 ⊕ 远程（同 id 覆盖保留基线位置、覆盖值记
 * source 'remote'；新 id 追加到尾部，quota-fetchers 域同款合并语义）。
 * 判定管线按 source 两层序排序，不依赖本函数数组序；数组序只服务 settings 展示。
 */
export function mergeRetryRules(
  baseline: readonly RetryableErrorRule[],
  remote: readonly RetryableErrorRule[],
  custom: readonly RetryableErrorRule[],
): RetryableErrorRule[] {
  const remoteById = new Map(remote.map((r) => [r.id, r]))
  const mergedBuiltin: RetryableErrorRule[] = baseline.map((r) => remoteById.get(r.id) ?? r)
  const baselineIds = new Set(baseline.map((r) => r.id))
  const remoteAppended = remote.filter((r) => !baselineIds.has(r.id))
  return [...custom, ...mergedBuiltin, ...remoteAppended]
}

// ───────────────────────── 判定管线（纯函数，无 IO） ─────────────────────────

/** 判定结论：rewrite = 追加标记触发 pi 原生重试；keep = 不改写（reason 说明不动因）。 */
export type RetryRuleDecision =
  | { action: 'rewrite' }
  | { action: 'keep'; reason: 'empty_message' | 'non_retryable_hit' | 'conditional_hit' | 'no_rule_match' }

/** SOURCE 判定序（两层序第二层）：custom > remote > builtin。 */
const SOURCE_ORDER: readonly RetryRuleSource[] = ['custom', 'remote', 'builtin']

/** JSON 片段提取：errorMessage 中首个 `{` 起的括号平衡段（字符串字面量感知——引号内的括号不计深度）；无平衡段返回 null。 */
export function extractJsonSegment(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 点路径取值：`error.code` / `errors.0.type`（数字段 = 数组下标）；任一层缺失返回 undefined。 */
function readJsonPath(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 单条匹配条件判定（message 已截断）。 */
function matchesCondition(message: string, condition: RetryRuleMatch): boolean {
  if (condition.kind === 'pattern') {
    try {
      return new RegExp(condition.pattern, 'i').test(message)
    } catch {
      // 运行时兜底（校验层已拒非法源；携带数据通道归一化前的第三方便携形态）：无效源恒不命中
      return false
    }
  }
  const segment = extractJsonSegment(message)
  if (segment === null) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(segment)
  } catch {
    return false
  }
  const actual = readJsonPath(parsed, condition.path)
  if (condition.operator === 'exists') return actual !== undefined
  if (actual === undefined || actual === null) return false
  const actualText = typeof actual === 'string' ? actual : JSON.stringify(actual)
  if (condition.operator === 'equals') return actualText === condition.value
  return actualText.includes(condition.value ?? '')
}

/** 单条规则判定：match[] 全部命中才算命中（AND）。 */
export function matchRetryRule(message: string, rule: RetryableErrorRule): boolean {
  return rule.match.every((condition) => matchesCondition(message, condition))
}

/**
 * 判定管线（两层序，命中即断）：
 * ① 第一层按 verdict 排除——任意 source 的 non_retryable 规则命中 → keep（先排除再放行，
 *    用户可重试规则击穿账户类硬约束的方向被结构封死）；
 * ② 第二层同 verdict 内按 source 序 custom > remote > builtin，首个命中规则裁决：
 *    retryable → rewrite；conditional → keep（不改写，settings 展示解释为何不自动重试）；
 * ③ 全部未命中 → keep（pi 原生词表兜底，不改写）。
 */
export function evaluateRetryRules(message: string, rules: readonly RetryableErrorRule[]): RetryRuleDecision {
  if (message.trim() === '') return { action: 'keep', reason: 'empty_message' }
  const truncated = message.length > RETRY_RULES_DOMAIN.textMaxLen ? message.slice(0, RETRY_RULES_DOMAIN.textMaxLen) : message
  for (const rule of rules) {
    if (rule.verdict === 'non_retryable' && matchRetryRule(truncated, rule)) {
      return { action: 'keep', reason: 'non_retryable_hit' }
    }
  }
  for (const source of SOURCE_ORDER) {
    for (const rule of rules) {
      if (rule.source !== source) continue
      if (!matchRetryRule(truncated, rule)) continue
      if (rule.verdict === 'retryable') return { action: 'rewrite' }
      return { action: 'keep', reason: 'conditional_hit' }
    }
  }
  return { action: 'keep', reason: 'no_rule_match' }
}

// ───────────────────────── 改写标记（探针实证锚文本） ─────────────────────────

/**
 * 追加式改写标记（subagent-observability §3.3.12 改写落盘约束 + 探针实证）：
 * - 前缀 `[taiji-retry:` 是本机制触发重试的识别约定（观测侧按标记对账；pi 原生词表
 *   命中的重试无标记）；
 * - 锚文本 `rate limit 429 too many requests` 实测命中 pi-ai RETRYABLE 词表的
 *   `rate.?limit` / `429` / `too many requests` 三条，且不含 NON_RETRYABLE 词表任何成员
 *   （node_modules @earendil-works/pi-ai dist/utils/retry.js 1.0.0 实装核对）；
 * - 追加式非替换式：原 errorMessage 文本完整保留在前段（pi 会话记录持久化改写形态，
 *   无信息丢失）。
 */
export const RETRY_REWRITE_MARKER = ' [taiji-retry: rate limit 429 too many requests]'

/** 改写标记前缀（幂等判定用：已带标记的 errorMessage 不重复追加）。 */
export const RETRY_REWRITE_MARKER_PREFIX = '[taiji-retry:'

/** 追加式改写：原文保留 + 标记追加；已带标记时原样返回（幂等）。 */
export function appendRetryMarker(errorMessage: string): string {
  if (errorMessage.includes(RETRY_REWRITE_MARKER_PREFIX)) return errorMessage
  return `${errorMessage}${RETRY_REWRITE_MARKER}`
}

// ───────────────────────── 内置预设基线（实测锚点见头注） ─────────────────────────

/**
 * 编译期基线预设（随发版更新；远程覆盖通道 = configs/remote/retry-rules.json 热更新）。
 *
 * 实测锚点（错误码实测表固化——远程基线变更须对本表复核后 commit，复核义务锚点）：
 * - pi-ai 原生词表（node_modules @earendil-works/pi-ai dist/utils/retry.js 1.0.0）：
 *   RETRYABLE 命中 `rate.?limit` / `too many requests` / `429` / `5xx` 等；
 *   NON_RETRYABLE 命中 `insufficient_quota` / `out of budget` / `quota exceeded` /
 *   `billing` / `available balance` 等。
 * - 基线条目按消费角色分三类（复核时按类判断条目价值，勿按单一口径误删）：
 *   ① 分类登记档——匹配键命中时 errorMessage 文本必含 pi RETRYABLE 词表字面量
 *   （provider 行为保证：zhipu-1302/1305 = HTTP 429、generic-429/5xx、
 *   kimi-overloaded/kimi-rate-limit、kimi-504（"504" 为 pi 词表 5xx 段字面量）），
 *   pi 原生已判可重试，改写是冗余动作；条目的
 *   独立价值在分类登记（class/kind/verdict 供收尾边沿失败分类）与 settings 展示，
 *   删之即砍断 §3.3.12「一次登记覆盖两个消费方」的分类数据链；
 *   ② pi 词表不命中的改写键——pi 判定不了或判错方向的形态（zhipu 窗口/账户码族、
 *   tier-limit-window、generic-account-4xx、generic-rpm-limit、kimi-quota
 *   语义收窄档），改写判定依赖这些键生效；
 *   ③ 显式排除档——pi NON_RETRYABLE 词表已判 false 的形态（generic-quota-exhausted、
 *   opencode-subscription-limit），登记为第一层排除防用户自定义可重试规则击穿。
 * - 智谱 BigModel（openai 兼容，业务码走 body JSON）：1302/1305 瞬态限流可重试；
 *   1308/1310/1316/1317 限额重置窗口（conditional）；1113/1309/1311/1313-1321 账户/套餐
 *   动作（non_retryable——429 不全可重试硬约束的账户侧）。
 * - MiMo（无业务码）：429 频率类可重试（429 同时装额度耗尽且无业务码可分，登记混装
 *   风险 waitHint）；500/503 可重试；402/403 账户动作。
 * - Kimi（anthropic 信封 error.type）：engine_overloaded_error / rate_limit_reached_error
 *   可重试；exceeded_current_quota_error 账户动作；504 conditional。
 * - opencode 网关（pi NON_RETRYABLE 词表同源）：GoUsageLimitError / FreeUsageLimitError /
 *   Monthly usage limit reached = 订阅限额（pi 本就判 false，登记为显式排除档防用户规则
 *   误放行）。
 * - 通用兜底排除：insufficient_quota / out of budget / quota exceeded（配额/账单耗尽，
 *   与 pi NON_RETRYABLE 词表同语义——第一层排除档，防自定义可重试规则击穿）。
 */
export const RETRY_RULES_BASELINE: readonly RetryableErrorRule[] = [
  // ── 通用兜底排除档（第一层，优先命中）──
  {
    id: 'generic-quota-exhausted',
    name: '配额/账单耗尽（通用排除）',
    verdict: 'non_retryable',
    match: [{ kind: 'pattern', pattern: 'insufficient_quota|out of budget|quota exceeded' }],
    class: 'provider',
    source: 'builtin',
  },
  // ── 智谱 BigModel（openai 兼容，业务码走 body JSON error.code）──
  {
    id: 'zhipu-1302',
    name: '智谱 1302 速率限制（HTTP 429）',
    verdict: 'retryable',
    match: [{ kind: 'jsonPath', path: 'error.code', operator: 'equals', value: '1302' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '瞬时限流，等待后自动重发可恢复',
    source: 'builtin',
  },
  {
    id: 'zhipu-1305',
    name: '智谱 1305 速率限制（HTTP 429）',
    verdict: 'retryable',
    match: [{ kind: 'jsonPath', path: 'error.code', operator: 'equals', value: '1305' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '瞬时限流，等待后自动重发可恢复',
    source: 'builtin',
  },
  {
    id: 'zhipu-window-limit',
    name: '智谱 1308/1310/1316/1317 限额窗口',
    verdict: 'conditional',
    match: [{ kind: 'pattern', pattern: '"code"\\s*:\\s*"?(?:1308|1310|1316|1317)"?' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '等待错误信息中的限额重置时间后可恢复',
    source: 'builtin',
  },
  {
    id: 'zhipu-account-action',
    name: '智谱账户/套餐类（1113/1309/1311/1313 等）',
    verdict: 'non_retryable',
    match: [{ kind: 'pattern', pattern: '"code"\\s*:\\s*"?(?:1113|1118|1309|1311|131[3-9]|132[01])"?' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '需充值/续订/账户动作后恢复，重试无效',
    source: 'builtin',
  },
  {
    // 场景 1 基线条目（subagent-observability §4 场景 1：软限流死因穿透）：400 +
    // tier_limit_exceeded + resets 文本 = 限额窗口形态（非协议错误）——分类侧读本条
    // class/kind/verdict 产出 provider.rate_limited / conditional，retryAfterMs 由
    // 错误文本 resets 字样提取（文本兜底通道）。
    id: 'tier-limit-window',
    name: 'tier 限额窗口（tier_limit_exceeded）',
    verdict: 'conditional',
    match: [{ kind: 'pattern', pattern: 'tier_limit_exceeded' }],
    class: 'provider',
    kind: 'rate_limited',
    httpStatusClass: 400,
    waitHint: '等待错误信息中的限额重置时间（resets）后可恢复',
    source: 'builtin',
  },
  // ── 大类级兜底（判定点拿不到 provider 标识，provider 归属挂在预设分组注释而非规则字段）──
  {
    id: 'generic-429',
    name: 'HTTP 429 频率限制（MiMo 等无业务码 provider）',
    verdict: 'retryable',
    match: [{ kind: 'pattern', pattern: '\\b429\\b|too many requests' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '瞬时限流可重试；额度耗尽型 429（无业务码可分）重试至耗尽后按失败如实分类',
    source: 'builtin',
  },
  {
    id: 'generic-5xx',
    name: 'HTTP 5xx 服务端瞬态',
    verdict: 'retryable',
    match: [{ kind: 'pattern', pattern: '\\b(?:500|502|503)\\b' }],
    class: 'provider',
    httpStatusClass: 500,
    waitHint: '服务端瞬态故障，等待后自动重发可恢复',
    source: 'builtin',
  },
  {
    id: 'generic-account-4xx',
    name: 'HTTP 402/403/421 账户动作',
    verdict: 'non_retryable',
    match: [{ kind: 'pattern', pattern: '\\b(?:402|403|421)\\b' }],
    class: 'provider',
    httpStatusClass: 402,
    waitHint: '需充值或账户授权动作，重试无效',
    source: 'builtin',
  },
  // ── Kimi（anthropic 信封 error.type）──
  {
    id: 'kimi-overloaded',
    name: 'Kimi engine_overloaded_error',
    verdict: 'retryable',
    match: [{ kind: 'pattern', pattern: 'engine_overloaded_error' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '引擎过载，按退避等待后可恢复',
    source: 'builtin',
  },
  {
    id: 'kimi-rate-limit',
    name: 'Kimi rate_limit_reached_error',
    verdict: 'retryable',
    match: [{ kind: 'pattern', pattern: 'rate_limit_reached_error' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '并发/RPM/TPM 超限，降并发或等待后可恢复',
    source: 'builtin',
  },
  {
    id: 'kimi-quota',
    name: 'Kimi exceeded_current_quota_error',
    verdict: 'non_retryable',
    match: [{ kind: 'pattern', pattern: 'exceeded_current_quota_error' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '配额耗尽，需充值或升级套餐',
    source: 'builtin',
  },
  {
    id: 'kimi-504',
    name: 'Kimi 504 网关超时',
    verdict: 'conditional',
    match: [{ kind: 'pattern', pattern: '\\b504\\b' }],
    class: 'provider',
    httpStatusClass: 504,
    waitHint: '网关超时，部分形态需检查上游状态后重试',
    source: 'builtin',
  },
  // ── opencode 网关（订阅限额，pi NON_RETRYABLE 同源显式排除档）──
  {
    id: 'opencode-subscription-limit',
    name: 'opencode 订阅限额（Go/Free usage limit）',
    verdict: 'non_retryable',
    match: [{ kind: 'pattern', pattern: 'GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '订阅/账户限额，需等待周期重置或账户动作',
    source: 'builtin',
  },
  // ── 成员限流文本（探针实测 pi 词表 0 命中的高价值形态）──
  {
    // tier_limit_exceeded 单列（tier-limit-window 条目，conditional 语义）——本条只收
    // RPM 并发限流文本；判定序数组内先于它声明的 tier-limit-window 会先命中即断。
    id: 'generic-rpm-limit',
    name: 'RPM 并发限流文本（rpm limit exceeded）',
    verdict: 'retryable',
    match: [{ kind: 'pattern', pattern: 'rpm limit exceeded' }],
    class: 'provider',
    httpStatusClass: 429,
    waitHint: '瞬时限流，等待窗口重置后可恢复（错误文本含 resets 时间）',
    source: 'builtin',
  },
]
