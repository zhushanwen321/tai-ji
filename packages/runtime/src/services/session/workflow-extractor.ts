/**
 * Workflow 提取器 —— 从 session entry 列表派生 WorkflowRunRecord[]。
 *
 * [W18] 本文件重构为 entry 扫描器：`scanWorkflowEntries(entries)` 是 workflow 列表唯一
 * 派生函数，实时（entry_appended 失效 → get_entries 增量/全量拉取）与冷启动（磁盘
 * JSONL 全量解析 → getWorkflows RPC）两条通路都调它（D4「实时与重开走同一份扫描代码」）。
 *
 * 数据来源优先级：
 * 1. **自描述 `workflow-record` entry（W17 v1，权威）**：pi-subagent-workflow 每次成功
 *    flush 同步 append 完整 RunSnapshot（customType 常量 = shared WORKFLOW_RECORD_CUSTOM_TYPE，
 *    data = {v:1, snapshot, updatedAt}）。同 runId 多条取最后一条（后者更新）。
 * 2. **legacy 解析（降级兜底）**：无自描述 entry 命中（W17 改造前创建的旧 session）时走
 *    workflow-state-link 指针 entry + state 文件读取。降级表现 = 数据滞后但可用（登记表
 *    #9 标注）。state 文件在 W17 后降级为纯性能缓存（读序 entry > state 文件 > 空）。
 *
 * agent call 对话流：trace[].sessionId 是 pi session ID（uuidv7），
 * SessionService.getAgentCallHistory 按 sessionId 全局查找 JSONL 文件
 * （scanPiSessions 扫所有 encodedCwd 子目录）。
 *
 * 参考扩展源码（[u1-move] core 切面抽至 packages/subagent-core，extension 侧留壳）：
 * - packages/subagent-core/src/orchestration/run-snapshot.ts（RunSnapshot 格式 + SNAPSHOT_VERSION 权威定义）
 * - extensions/universal/subagent-workflow/src/jsonl-run-store.ts（workflow-record entry data schema W17 v1 写点，快照 codec 留壳消费 core）
 * - packages/subagent-core/src/orchestration/models/workflow-run.ts（WorkflowRun 聚合根）
 * - packages/subagent-core/src/orchestration/models/types.ts（RunStatus/DoneReason/AgentResult）
 */

import { readFileSync, statSync } from 'node:fs'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'
import { WORKFLOW_RECORD_CUSTOM_TYPE, READ_PRECHECK_MAX_BYTES } from '@xyz-agent/shared'
import type {
  WorkflowRunRecord,
  WorkflowAgentCall,
  WorkflowDoneReason,
} from '@xyz-agent/shared'

/**
 * RunSnapshot 格式版本。版本不匹配跳过（D-5）。
 *
 * 注意：这是 SNAPSHOT_VERSION 的本地副本——跨包依赖方向不允许 runtime import
 * 其他包源码，只能复制字面量。权威源（[u1-move] 随 core 切面迁入 subagent-core）：
 * packages/subagent-core/src/orchestration/run-snapshot.ts 的 SNAPSHOT_VERSION
 * （export const，当前 'wf-run-v2'；extension 侧 jsonl-run-store.ts 留壳 import 消费）。
 * extension 升级格式时必须同步 bump 此处，否则版本守卫会把新快照全部判为不匹配跳过
 * （renderer WorkflowList 对新 run 显示为空）。
 */
const SNAPSHOT_VERSION = 'wf-run-v2'

/** workflow-state-link entry 的 data 结构（legacy） */
interface WorkflowStateLinkData {
  runId: string
  path: string
  updatedAt?: string
}

/** JSONL 中的 custom_message entry 结构（简化） */
interface JsonlCustomEntry {
  type: string
  customType?: string
  data?: unknown
}

/** RunSnapshot.state.budget 结构 */
interface SnapshotBudget {
  maxTokens?: number
  maxCost?: number
  maxTimeMs?: number
  usedTokens: number
  usedCost: number
  totalCallCount?: number
}

/** RunSnapshot.state.trace[] 节点结构（RunSnapshot 序列化时 strip live 字段） */
interface SnapshotTraceNode {
  stepIndex: number
  agent: string
  task?: string
  model?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  phase?: string
  startedAt?: string
  completedAt?: string
  sessionId?: string
  result?: {
    content?: string
    usage?: {
      input?: number
      output?: number
      turns?: number
    }
    durationMs?: number
    error?: string
    sessionId?: string
  }
  error?: string
}

/** RunSnapshot 顶层结构（对齐扩展 jsonl-run-store.ts 的 v2 RunSnapshot interface） */
interface RunSnapshot {
  v: string
  runId: string
  spec: {
    scriptSource?: string
    args?: Record<string, unknown>
    scriptName: string
    slug?: string
    scriptPath?: string
    description?: string
  }
  state: {
    // v2 两态（wf-run-v2 随一次性生命周期收窄，paused 态已删除）；v1 三态快照被版本守卫跳过
    status: 'running' | 'done'
    reason?: WorkflowDoneReason
    budget: SnapshotBudget
    calls: unknown[]
    trace: SnapshotTraceNode[]
    errorLogs?: unknown[]
    error?: string
    scriptResult?: unknown
  }
  meta: {
    startedAt: string
    completedAt?: string
    workerErrorCount?: number
    scriptErrorCount?: number
  }
}

/**
 * [W18] entry 扫描器：从 entry 列表派生 WorkflowRunRecord[]。
 *
 * 实时（session-service 增量拉取）与冷启动（getWorkflows 磁盘全量）唯一共用派生函数：
 * 1. 先扫自描述 `workflow-record` entry（W17 v1：data = {v:1, snapshot, updatedAt}，完整
 *    RunSnapshot 内嵌，无需读 state 文件）；同 runId 多条取最后一条（后者更新）。命中
 *    （≥1 条有效）直接返回。
 * 2. 无命中（W17 前创建的旧 session）→ legacy 解析兜底（workflow-state-link 指针 +
 *    state 文件读取，数据滞后但可用）。
 *
 * entries 来源两种形态同构（pi SessionEntry 内存对象与 JSONL 行反序列化）。
 */
export function scanWorkflowEntries(entries: unknown[]): WorkflowRunRecord[] {
  const selfDescribed = collectSelfDescribedWorkflowRecords(entries)
  if (selfDescribed !== null) return selfDescribed
  return extractWorkflowsFromEntriesLegacy(entries)
}

/**
 * 收集自描述 workflow-record entry（W17 v1）。
 *
 * @returns null = 无有效命中（走 legacy 兜底）；WorkflowRunRecord[] = 命中。
 * entry 层 v 守卫（data.v !== 1 跳过 + warn）与 snapshot 层 v 守卫（mapValidatedSnapshot
 * 内 SNAPSHOT_VERSION）是两级独立版本（entry schema 演化 vs 快照格式演化，对齐 extension
 * 侧 WorkflowRecordEntryData 注释）。
 */
function collectSelfDescribedWorkflowRecords(entries: unknown[]): WorkflowRunRecord[] | null {
  const snapshots = new Map<string, RunSnapshot>()
  for (const entry of entries) {
    const snapshot = parseSelfDescribedWorkflowSnapshot(entry)
    if (snapshot) snapshots.set(snapshot.runId, snapshot)
  }
  if (snapshots.size === 0) return null
  const records: WorkflowRunRecord[] = []
  for (const [runId, snapshot] of snapshots) {
    // stateFilePath 空串：自描述 entry 路径无 state 文件概念（W17 后 state 文件降级为
    // 纯性能缓存，entry 内嵌完整快照）——消费方（详情面板路径展示）对空串隐藏即可
    const record = mapValidatedSnapshot(runId, snapshot, '')
    if (record) records.push(record)
  }
  return records
}

/**
 * 单条 entry → RunSnapshot（type/customType/data/版本/runId 存在性逐层守卫，坏 entry 返回
 * null）。同 runId 后出现的覆盖前面的（entry 顺序 = 时间顺序，后者更新）。
 */
function parseSelfDescribedWorkflowSnapshot(entry: unknown): RunSnapshot | null {
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as JsonlCustomEntry
  if (e.type !== 'custom' || e.customType !== WORKFLOW_RECORD_CUSTOM_TYPE) return null
  const data = e.data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.v !== 1) {
    console.warn(
      `[workflow-extractor] workflow-record entry schema version '${String(d.v)}' unsupported (expected 1) — ` +
        `extension/runtime version skew, skip this entry. Fix: align schema with ` +
        `extensions/universal/subagent-workflow/src/jsonl-run-store.ts (W17 v1).`,
    )
    return null
  }
  const snapshot = d.snapshot
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const snap = snapshot as Record<string, unknown>
  // runId 存在性守卫（snapshot 内嵌完整 runId；无 runId 视为坏 entry 跳过）
  if (typeof snap.runId !== 'string' || snap.runId.length === 0) return null
  return snapshot as RunSnapshot
}

/** MB 换算常数（oversize 降级 warn 文案的体积展示，对齐 trace-sync BYTES_PER_MB） */
// eslint-disable-next-line no-magic-numbers -- 1MB = 1024 * 1024 bytes
const BYTES_PER_MB = 1024 * 1024

/**
 * extract*FromSessionFile 的结果形状：records + oversize 正交降级标志（与
 * subagent-extractor 的 SubagentFileExtraction 同范式，正交字段先例 = HistoryFileReadResult
 * {messages, truncated} / traceEntries source:'oversize'）。oversize = 主 session JSONL 超
 * READ_PRECHECK_MAX_BYTES（32MB），已降级返回空列表（G3 峰值治理）。
 */
export interface WorkflowFileExtraction {
  /** 派生 workflow 列表；oversize 时恒空数组（不做尾读部分提取，设计裁决同 subagent 侧） */
  records: WorkflowRunRecord[]
  /** 主 session JSONL 超预检阈值的降级标记（true = 未读文件，records 为降级空列表） */
  oversize: boolean
}

/**
 * 从主 session JSONL 文件提取 WorkflowRunRecord[]（冷启动 / getWorkflows RPC 路径）。
 *
 * 读取文件 → parseJsonl → scanWorkflowEntries（与实时增量拉取同一份派生代码）。
 *
 * 读失败分级（与 extractSubagentsFromSessionFile 同款，renderer 侧栏 stale 守卫的契约前提）：
 * ENOENT → 空数组（pi session 文件延迟写入的合法窗口）；其他读错误 → 原样上抛（RPC 报错，
 * renderer catch 保留旧分区 + 重试态，不与「真实删空」混淆）。无 workflow record 时返回空数组。
 *
 * [G3 / crash-resilience D5⑤] READ_PRECHECK 预检：statSync 大小 > READ_PRECHECK_MAX_BYTES
 * （32MB，与 session-file-utils 全量读预检同阈值同标尺）时不读全文，降级返回空列表 +
 * oversize 标记 + warn 留痕（对齐 trace-sync D5④ 的 oversize 降级范式）。预检 stat 失败
 * （含 ENOENT）走原读路径——错误分级语义由 readFileSync 路径原样承担，预检不引入新抛错。
 */
export function extractWorkflowsFromSessionFile(filePath: string): WorkflowFileExtraction {
  let fileSize = -1
  try {
    fileSize = statSync(filePath).size
  } catch {
    // 预检失败不改变错误契约：fall through 到读路径，由 readFileSync 产生原分级错误
    fileSize = -1
  }
  if (fileSize > READ_PRECHECK_MAX_BYTES) {
    console.warn(
      `[workflow-extractor] session file oversize ` +
      `(${(fileSize / BYTES_PER_MB).toFixed(1)} MB > ${(READ_PRECHECK_MAX_BYTES / BYTES_PER_MB).toFixed(0)} MB), ` +
      `skip workflow extraction (degraded to empty list): ${filePath}`,
    )
    return { records: [], oversize: true }
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) return { records: [], oversize: false }
    throw e
  }

  const entries = parseJsonl(content)
  return { records: scanWorkflowEntries(entries), oversize: false }
}

/**
 * [legacy] 旧双管线的磁盘解析逻辑（W18 前的 extractWorkflowsFromSessionFile 主体）。
 *
 * 降级兜底：仅当 session 无自描述 workflow-record entry（W17 改造前创建）时被
 * scanWorkflowEntries 调用。W17 前创建的存量 session（含 workflow-state-link entry +
 * state 文件）由此路径继续可见（不静默丢失）。
 */
function extractWorkflowsFromEntriesLegacy(entries: unknown[]): WorkflowRunRecord[] {
  // 收集 workflow-state-link，按 runId 去重（保留最新 path）
  const links = new Map<string, string>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as JsonlCustomEntry
    // 真实 JSONL entry type 是 'custom'（不是 'custom_message'）。
    // custom_message 是 pi 推给前端的消息类型，JSONL 持久化层用 'custom' + customType 区分。
    // 实测验证（B 布局迁移前，旧布局 `~/.xyz-agent-dev/pi/sessions/` 时期的存量文件；历史证据不改写）：
    // workflow-state-link 条目 type 均为 'custom'。
    if (e.type !== 'custom' || e.customType !== 'workflow-state-link') continue
    const data = e.data as WorkflowStateLinkData | undefined
    if (!data?.runId || !data?.path) continue
    // 同 runId 后出现的覆盖前面的（JSONL 顺序 = 时间顺序，后者更新）
    links.set(data.runId, data.path)
  }

  if (links.size === 0) return []

  // 逐个读 state 文件，映射 RunSnapshot → WorkflowRunRecord
  const records: WorkflowRunRecord[] = []
  for (const [runId, stateFilePath] of links) {
    const record = readAndMapSnapshot(runId, stateFilePath)
    if (record) records.push(record)
  }

  return records
}

/**
 * 读 workflow-state 文件 + 映射为 WorkflowRunRecord（legacy 路径）。
 * 文件不存在 / 解析失败 / 版本不匹配 → 返回 null（跳过该 run）。
 */
function readAndMapSnapshot(runId: string, stateFilePath: string): WorkflowRunRecord | null {
  let content: string
  try {
    content = readFileSync(stateFilePath, 'utf-8')
  } catch {
    // state 文件不存在或不可读（已被清理 / 并发删除）
    return null
  }

  // rewrite mode：文件始终是最新单行快照。取最后一个非空行。
  const lines = content.split('\n').filter((l) => l.trim())
  const lastLine = lines[lines.length - 1]
  if (!lastLine) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    // JSON 解析失败（损坏的 state 文件）
    return null
  }

  return mapValidatedSnapshot(runId, parsed, stateFilePath)
}

/**
 * 已解析 snapshot（state 文件行 / workflow-record entry 内嵌）→ 结构校验 + 版本守卫 +
 * 映射 WorkflowRunRecord。坏结构 / 版本不匹配 → null（跳过该 run）。
 *
 * [W18] 自 legacy readAndMapSnapshot 抽出共用：state 文件路径（legacy）与自描述 entry
 * 路径（stateFilePath = ''）同守卫同映射，两路派生行为一致。
 */
function mapValidatedSnapshot(runId: string, parsed: unknown, stateFilePath: string): WorkflowRunRecord | null {
  // [review 修复] 结构守卫：JSON.parse 对 "null" / "42" / '"str"' / '[]' 等合法 JSON
  // 产出 null / 非对象 / 缺 v 字段值，直接 as RunSnapshot 后 .v 访问会抛 TypeError
  // 而非走「跳过」路径——按坏行处理跳过（状态文件由本扩展生成，防御并发截断 / 外部覆写）。
  if (typeof parsed !== 'object' || parsed === null || !('v' in parsed)) return null

  // [review 修复 R3-S3] v 匹配后 mapSnapshotToRecord 还直接访问 state.trace /
  // spec.scriptName / meta.startedAt——形如 {"v":"wf-run-v2"} 的合法 JSON（截断写，
  // 缺三段或任一段为 null）在 v 守卫放行后仍抛 TypeError。三段须为非 null 对象，
  // 坏结构与上方一致走跳过路径（仅一层存在性；字段级缺省由 ?? 与值级守卫兜底，
  // 不做深度 schema 校验）。
  const body = parsed as Record<string, unknown>
  const isObj = (x: unknown): x is object => typeof x === 'object' && x !== null
  if (!isObj(body.state) || !isObj(body.spec) || !isObj(body.meta)) return null

  const snapshot = parsed as RunSnapshot

  // D-5 版本守卫：版本不匹配跳过（旧格式不向后兼容），判定先于结构校验——
  // 新格式快照结构可能已变（trace 改形等），先比版本才能把「版本漂移」与
  // 「同版本坏数据」区分开。
  // [review 修复 R4] 不再静默——pi-subagent-workflow 是 mandatory + autoUpgrade 扩展，
  // extension 先发版（npm-* tag 独立管线）而 app 未跟上时，版本守卫会把新 run 全部
  // 判为不匹配跳过（WorkflowList 对新 run 显示为空），无日志则该版本漂移不可观测。
  if (snapshot.v !== SNAPSHOT_VERSION) {
    console.warn(
      `[workflow-extractor] snapshot version '${String(snapshot.v)}' unsupported (expected '${SNAPSHOT_VERSION}') — ` +
        `extension/runtime version skew, skip run ${runId} (${stateFilePath || 'workflow-record entry'}). ` +
        `Fix: bump SNAPSHOT_VERSION in workflow-extractor.ts to match ` +
        `packages/subagent-core/src/orchestration/run-snapshot.ts (consumed via ` +
        `extensions/universal/subagent-workflow/src/jsonl-run-store.ts; see header comment).`,
    )
    return null
  }

  // [review 修复 R4] state.trace 是三段中唯一被直接解引用的字段（mapSnapshotToRecord
  // 的 .map 与 mapTraceNode 的 node.result 访问）——非数组真值（如 "trace":{}）时
  // ?? 只挡 null/undefined 不挡错型，.map 抛 TypeError 且 readAndMapSnapshot 无
  // per-item catch，一个坏 state 文件会让整个 session.getWorkflows RPC 回
  // handler_error（该 session 其余 run 一并不可见）。非数组与三段缺失同层：该 run
  // 按坏行跳过；数组内的 null 项在 mapSnapshotToRecord 过滤（项级隔离，不弃整个 run）。
  if (!Array.isArray((body.state as Record<string, unknown>).trace)) return null

  return mapSnapshotToRecord(snapshot, stateFilePath)
}

/** 映射 RunSnapshot → WorkflowRunRecord（含 trace → agentCalls 映射） */
function mapSnapshotToRecord(snapshot: RunSnapshot, stateFilePath: string): WorkflowRunRecord {
  // [review 修复 R4] trace 数组内的 null 项按坏项过滤（mapTraceNode 的 node.result
  // 访问对 null 项抛 TypeError）——保留其余合法项，run 本身不跳过（坏项隔离到项级，
  // 上方 Array.isArray 守卫已保证 trace 是数组，?? 仅为函数级防御保留）
  const agentCalls: WorkflowAgentCall[] = (snapshot.state.trace ?? [])
    .filter((node): node is SnapshotTraceNode => typeof node === 'object' && node !== null)
    .map(mapTraceNode)

  return {
    runId: snapshot.runId,
    scriptName: snapshot.spec.scriptName,
    slug: snapshot.spec.slug,
    description: snapshot.spec.description,
    // v2 两态直接赋值（是 WorkflowRunStatus 三态的子集，无需断言；
    // 'paused' 是 WorkflowRunStatus 的 legacy 读侧值，v2 快照不产出）
    status: snapshot.state.status,
    reason: snapshot.state.reason,
    startedAt: snapshot.meta.startedAt,
    completedAt: snapshot.meta.completedAt,
    usedTokens: snapshot.state.budget?.usedTokens,
    totalCallCount: snapshot.state.budget?.totalCallCount,
    agentCalls,
    stateFilePath,
  }
}

/** 映射单个 trace 节点 → WorkflowAgentCall */
function mapTraceNode(node: SnapshotTraceNode): WorkflowAgentCall {
  const usage = node.result?.usage
  return {
    id: node.stepIndex,
    agent: node.agent,
    phase: node.phase,
    status: node.status,
    model: node.model,
    sessionId: node.sessionId ?? node.result?.sessionId,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    durationMs: node.result?.durationMs,
    inputTokens: usage?.input,
    outputTokens: usage?.output,
    turns: usage?.turns,
    // 顶层 error 优先于 result.error（顶层 error 是 dispatchAgentCall 写的运行期错误）
    error: node.error ?? node.result?.error,
  }
}
