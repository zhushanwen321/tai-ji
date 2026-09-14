// ============================================================
// workflow 概览解析与渲染（w5 新增，纯逻辑零 IO）
// ============================================================
//
// 本文件消费 discovery/workflows.ts 的 readRunSnapshot（返 unknown 原始快照对象），
// 把 unknown 类型化为 WorkflowOverview（NEW v='wf-run-v1'/'wf-run-v2' / OLD 无 v 双格式分支），
// 再渲染为人类可读文本。零 IO：parseRunSnapshot/renderWorkflowOverview 喂 mock 即可单测
//（w5 TC-wf-core-pure-logic，对齐 session-reader core/* 纯逻辑约定）。
//
// 不 import @zhushanwen/pi-subagent-workflow 的 RunSnapshot 类型——跨包类型耦合会使上游
// 升版连带编译期影响本扩展；且上游类型只描述 NEW，OLD 仍需自处理（TC-wf-snapshot-version-union）。
// session-reader 作为纯读取者，按字段存在性 + v 标记分支做「结构化快照」式解析，与上游解耦。

import { isRecord } from '@zhushanwen/pi-ext-guards'

// ---- 类型守卫 helpers ----

/** unknown → string 收窄（非 string → undefined）。快照可选字符串字段的统一入口。 */
function strOr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** 字符串截断（超 max 加省略号）。step 行渲染用。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** step 行 call sessionId 显示截断长度（uuid 前缀段，LLM 可读）。 */
const SESSION_ID_PREVIEW_MAX = 12

// ---- 数据模型（对齐 m2 slice DM-WorkflowBudget/DM-WorkflowStep/DM-WorkflowOverview）----

/** wf-state budget 尽力提取（OLD budget 结构可能不全，缺字段 undefined）。 */
export interface WorkflowBudget {
  /** NEW state.budget.usedTokens / OLD budget.usedTokens */
  usedTokens?: number
  /** NEW state.budget.usedCost */
  usedCost?: number
  /** NEW state.budget.totalCallCount */
  totalCallCount?: number
  /** NEW state.budget.maxTokens */
  maxTokens?: number
  /** NEW state.budget.maxCost */
  maxCost?: number
  /** NEW state.budget.maxTimeMs */
  maxTimeMs?: number
}

/** workflow 单步（NEW call / OLD callCache entry）。 */
export interface WorkflowStep {
  /** NEW call.id / OLD callCache 顺序索引 */
  index: number
  /** NEW call.status / OLD 推测（有 sessionFile 或 content → 'done'，否则 'pending'） */
  status: 'pending' | 'running' | 'done'
  /** NEW call.opts.description */
  description?: string
  /** NEW call.opts.model */
  model?: string
  /** NEW call.attempts / OLD 无 → undefined */
  attempts?: number
  /** NEW call.result.durationMs / OLD value.result.durationMs */
  durationMs?: number
  /** call.sessionId 或 result.sessionId（LLM 跳 outline/detail 的 id 入口） */
  sessionId?: string
  /** call.sessionFile 或 result.sessionFile（LLM 跳 outline/detail 的绝对路径入口，OLD 多数为 undefined） */
  sessionFile?: string
}

/** workflow run 概览（parseRunSnapshot 输出 / renderWorkflowOverview 输入）。 */
export interface WorkflowOverview {
  /** WorkflowRef.runId 透传（与 family.workflows 对齐，不读 snapshot.runId 避免 OLD 不一致） */
  runId: string
  /** WorkflowRef.stateFile 透传 */
  stateFile: string
  /** NEW state.status / OLD 顶层 status */
  status: string
  /** details 格式标记（随 details.runs 透传给程序化消费方，文本渲染不读）。v2 读取面形状与 v1 一致（pi-subagent-workflow 8.x 一次性生命周期） */
  version: 'wf-run-v1' | 'wf-run-v2' | 'legacy'
  /** NEW spec.scriptName / spec.name / OLD name */
  script?: string
  /** NEW meta.startedAt / OLD startedAt（统一 string） */
  startedAt?: string
  /** NEW meta.completedAt */
  completedAt?: string
  /** NEW state.reason */
  reason?: string
  /** NEW state.error */
  error?: string
  budget: WorkflowBudget
  steps: WorkflowStep[]
}

// ---- 解析 helpers（call/cache entry → WorkflowStep）----

/** 把 budget 原始对象收窄为 WorkflowBudget（各字段类型校验，非 number → undefined）。 */
function mapBudget(b: Record<string, unknown>): WorkflowBudget {
  return {
    usedTokens: typeof b.usedTokens === 'number' ? b.usedTokens : undefined,
    usedCost: typeof b.usedCost === 'number' ? b.usedCost : undefined,
    totalCallCount: typeof b.totalCallCount === 'number' ? b.totalCallCount : undefined,
    maxTokens: typeof b.maxTokens === 'number' ? b.maxTokens : undefined,
    maxCost: typeof b.maxCost === 'number' ? b.maxCost : undefined,
    maxTimeMs: typeof b.maxTimeMs === 'number' ? b.maxTimeMs : undefined,
  }
}

/** call.status 字符串收窄为合法三态（未知值 → 'pending'）。 */
function normalizeCallStatus(raw: string): WorkflowStep['status'] {
  return raw === 'done' || raw === 'running' || raw === 'pending' ? raw : 'pending'
}

/** 「顶层字段优先、result 回退」的 session 关联字段提取（NEW call 与 OLD value 共用形态）。 */
function pickSessionRefs(
  top: Record<string, unknown>,
  result: Record<string, unknown>,
): Pick<WorkflowStep, 'sessionId' | 'sessionFile'> {
  return {
    sessionId: strOr(top.sessionId) ?? strOr(result.sessionId),
    sessionFile: strOr(top.sessionFile) ?? strOr(result.sessionFile),
  }
}

/** NEW state.calls[] 单项 → WorkflowStep。sessionFile/sessionId 顶层优先回退 result。 */
function mapCallToStep(call: unknown, fallbackIndex: number): WorkflowStep {
  if (!isRecord(call)) return { index: fallbackIndex, status: 'pending' }
  const opts = isRecord(call.opts) ? call.opts : {}
  const result = isRecord(call.result) ? call.result : {}

  const index = typeof call.id === 'number' ? call.id : fallbackIndex
  const status = normalizeCallStatus(strOr(call.status) ?? '')
  const refs = pickSessionRefs(call, result)

  return {
    index,
    status,
    description: strOr(opts.description),
    model: strOr(opts.model),
    attempts: typeof call.attempts === 'number' ? call.attempts : undefined,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : undefined,
    sessionId: refs.sessionId,
    sessionFile: refs.sessionFile,
  }
}

/** OLD callCache[] 单项 {key, value} → WorkflowStep。status 推测，content 优先 result 回退 value。 */
function mapCacheEntryToStep(entry: unknown, index: number): WorkflowStep {
  if (!isRecord(entry)) return { index, status: 'pending' }
  const value = isRecord(entry.value) ? entry.value : {}
  const result = isRecord(value.result) ? value.result : {}

  // sessionFile/sessionId: value.sessionFile 或 value.result.sessionFile（OLD 多数缺失，探针 112 文件 0）
  const refs = pickSessionRefs(value, result)
  // content：真实 OLD 数据 value.content（wf-skip-ok）与测试 fixture value.result.content 并存，
  // 仅用于 status 推测（A4 死字段删除：contentPreview 已删，不再随 step 输出）
  const content = strOr(result.content) ?? strOr(value.content)
  // OLD 无 status 字段：有 sessionFile 或非空 content → done，否则 pending
  //（空 content 如 wf-skip-ok 的 '' 不算完成标志，对齐 TC-w5-parse-old expected status='pending'）
  const hasContent = content !== undefined && content.length > 0
  const status: WorkflowStep['status'] =
    refs.sessionFile !== undefined || hasContent ? 'done' : 'pending'

  return {
    index,
    status,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : undefined,
    sessionId: refs.sessionId,
    sessionFile: refs.sessionFile,
  }
}

// ---- parseRunSnapshot（unknown → WorkflowOverview | null）----

/** NEW 格式装配（v=wf-run-v1/v2）：state.* / meta.* / spec.* → WorkflowOverview。 */
function parseNewRunSnapshot(
  snapshot: Record<string, unknown>,
  v: 'wf-run-v1' | 'wf-run-v2',
  runId: string,
  stateFile: string,
): WorkflowOverview {
  const state = isRecord(snapshot.state) ? snapshot.state : {}
  const meta = isRecord(snapshot.meta) ? snapshot.meta : {}
  const spec = isRecord(snapshot.spec) ? snapshot.spec : {}
  const callsRaw = Array.isArray(state.calls) ? state.calls : []
  return {
    runId,
    stateFile,
    status: strOr(state.status) ?? '',
    version: v,
    script: strOr(spec.scriptName) ?? strOr(spec.name),
    startedAt: strOr(meta.startedAt),
    completedAt: strOr(meta.completedAt),
    reason: strOr(state.reason),
    error: strOr(state.error),
    budget: mapBudget(isRecord(state.budget) ? state.budget : {}),
    steps: callsRaw.map((c, i) => mapCallToStep(c, i)),
  }
}

/** OLD 格式装配（无 v）：顶层 status/name/startedAt/budget + callCache → WorkflowOverview。 */
function parseLegacyRunSnapshot(
  snapshot: Record<string, unknown>,
  runId: string,
  stateFile: string,
): WorkflowOverview {
  const callCacheRaw = Array.isArray(snapshot.callCache) ? snapshot.callCache : []
  return {
    runId,
    stateFile,
    status: strOr(snapshot.status) ?? '',
    version: 'legacy',
    script: strOr(snapshot.name),
    startedAt: strOr(snapshot.startedAt),
    budget: mapBudget(isRecord(snapshot.budget) ? snapshot.budget : {}),
    steps: callCacheRaw.map((c, i) => mapCacheEntryToStep(c, i)),
  }
}

/**
 * 把 readRunSnapshot 返回的原始快照对象类型化为 WorkflowOverview（纯逻辑零 IO）。
 *
 * 分支（C-parserunsnapshot-dualformat，TC-wf-snapshot-version-union）：
 * - 非对象 → null（调用方跳过，ES-wf-snapshot-unparseable）
 * - NEW (snapshot.v === 'wf-run-v1' 或 'wf-run-v2'，读取面形状一致)：state.* / meta.* / spec.*
 * - OLD (无 v，有 callCache 数组或顶层 status)：顶层 status/budget/startedAt + callCache
 * - 既非 NEW 也非 OLD → null（未来版本（如 wf-run-v3）/ 异构内容）
 *
 * runId/stateFile 透传参数（不读 snapshot.runId，保证与 family.workflows 一致，避免 OLD 顶层
 * runId 可信度低的不一致）。零 any（全程 typeof/Array.isArray/isRecord 守卫收窄）。
 */
export function parseRunSnapshot(
  snapshot: unknown,
  runId: string,
  stateFile: string,
): WorkflowOverview | null {
  if (!isRecord(snapshot)) return null

  // NEW 格式（v === 'wf-run-v1' || 'wf-run-v2'，v2 读取面形状兼容 v1）
  const v = snapshot.v
  if (v === 'wf-run-v1' || v === 'wf-run-v2') {
    return parseNewRunSnapshot(snapshot, v, runId, stateFile)
  }

  // OLD 格式（无 v，有 callCache 数组或顶层 status 字符串）
  if (Array.isArray(snapshot.callCache) || typeof snapshot.status === 'string') {
    return parseLegacyRunSnapshot(snapshot, runId, stateFile)
  }

  return null
}

// ---- renderWorkflowOverview（WorkflowOverview → 人类可读文本）----

/** 头行：`run: <runId> [status] (script?) started=<ISO> completed?=<ISO> reason?`。 */
function renderOverviewHead(overview: WorkflowOverview): string {
  const headParts = [`run: ${overview.runId}`, `[${overview.status}]`]
  if (overview.script) headParts.push(`(${overview.script})`)
  if (overview.startedAt) headParts.push(`started=${overview.startedAt}`)
  if (overview.completedAt) headParts.push(`completed=${overview.completedAt}`)
  if (overview.reason) headParts.push(`reason=${overview.reason}`)
  return headParts.join(' ')
}

/** budget max 段 `/ max=<tokens>tok $<cost> <timeMs>ms`（max 三字段全缺 → undefined 不拼）。 */
function renderBudgetMax(b: WorkflowBudget): string | undefined {
  const hasMax = b.maxTokens !== undefined || b.maxCost !== undefined || b.maxTimeMs !== undefined
  if (!hasMax) return undefined
  const maxParts: string[] = ['/ max=']
  if (b.maxTokens !== undefined) maxParts.push(`${b.maxTokens}tok`)
  if (b.maxCost !== undefined) maxParts.push(`$${b.maxCost}`)
  if (b.maxTimeMs !== undefined) maxParts.push(`${b.maxTimeMs}ms`)
  return maxParts.join('')
}

/** budget 行 `budget: used=<tokens>tok $<cost> calls=<n> / max=...`（缺省字段省略，不输出 undefined 字面量）。 */
function renderBudgetLine(b: WorkflowBudget): string {
  const budgetParts: string[] = ['budget:']
  if (b.usedTokens !== undefined) budgetParts.push(`used=${b.usedTokens}tok`)
  if (b.usedCost !== undefined) budgetParts.push(`$${b.usedCost}`)
  if (b.totalCallCount !== undefined) budgetParts.push(`calls=${b.totalCallCount}`)
  const maxPart = renderBudgetMax(b)
  if (maxPart !== undefined) budgetParts.push(maxPart)
  return budgetParts.join(' ')
}

/** steps 块单行；sessionFile 缺则标 `（无 sessionFile，OLD 格式未持久化）`（TC-wf-step-sessionfile-link）。 */
function renderStepLine(step: WorkflowStep): string {
  const stepParts = [`  #${step.index}`, `[${step.status}]`]
  if (step.description) stepParts.push(step.description)
  const tail: string[] = []
  if (step.model) tail.push(`model=${step.model}`)
  if (step.durationMs !== undefined) tail.push(`${step.durationMs}ms`)
  if (step.attempts !== undefined) tail.push(`attempts=${step.attempts}`)
  if (step.sessionId) tail.push(`call=${truncate(step.sessionId, SESSION_ID_PREVIEW_MAX)}`)
  let line = stepParts.join(' ')
  if (tail.length > 0) line += ' · ' + tail.join(' · ')
  if (step.sessionFile) {
    line += ' ' + step.sessionFile
  } else {
    line += ' （无 sessionFile，OLD 格式未持久化）'
  }
  return line
}

/**
 * 渲染 WorkflowOverview 为人类可读文本（纯逻辑零 IO）。
 *
 * 输出结构（IF-renderWorkflowOverview）：头行 → budget 行 → steps 块每行
 * （`  #<index> [status] <description> · model=<model> · <durationMs>ms · attempts=<n> ·
 * call=<sessionId截断> <sessionFile>`）→ error 行（如有 state.error）。
 *
 * 每个 step 的 call sessionId/sessionFile 是 LLM 跳 outline/detail 的入口（m0 resolveSessionId
 * 三形态：sessionId/绝对路径/sa-id 均可深读）。多 run 场景由 doWorkflow 循环拼接多段（w6）。
 */
export function renderWorkflowOverview(overview: WorkflowOverview): string {
  const lines: string[] = []
  lines.push(renderOverviewHead(overview))
  lines.push(renderBudgetLine(overview.budget))
  for (const step of overview.steps) lines.push(renderStepLine(step))
  if (overview.error) lines.push(`error: ${overview.error}`)
  return lines.join('\n')
}
