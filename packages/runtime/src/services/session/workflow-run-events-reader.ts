/**
 * workflow record 读侧投影族（workflow-visualization U3，设计 §3.1-4 / §3.1-5）。
 *
 * 两个拉取 RPC 的 record 文件读取面（SessionRecords 经注册条目 recordPath 锚点委托
 * 到达；本模块只管「给路径读内容」，路径发现归 SessionRecords 的投影源）：
 * - readRunEvents：单 run 事件流原文行（WorkflowRunEventEntry 判别联合）。行解析
 *   复用 events-projection 的 parseWorkflowRunEventFileLine（与活体投影 tailer 同一
 *   解析原语 + 同一坏行宽容语义——禁新写解析，任务书红线）；大字段 2KB 截断
 *   （shared WORKFLOW_RUN_EVENT_TRUNCATE_BYTES 单源常量，四字段白名单）+ 每行
 *   truncatedFields 标注。截断载荷仅供展示（D12 防误用边界：resume 的 $ARGS 恢复
 *   与 args 一致性校验在引擎侧读 record 原文全文字段，不经本通道）。record 文件超
 *   READ_PRECHECK_MAX_BYTES（32MB，D5 预检族）时降级——不全文读取（worker-log 行数
 *   无上界 + workflowUpdate 信号 force 重拉会放大读面），events 恒空 + oversize
 *   标志（session.workflows RT-4#8 同款「不可用 ≠ 无数据」分形；DAG 通道豁免该预检
 *   ——成功结果 LRU 缓存内每 run 至多读一次，无信号级重复压力，接受单次全量读）。
 * - readDag：record 首帧 run-created 的 scriptSource 原文（不截断——DAG 解析不经
 *   事件流截断通道，设计 §3.1-4）→ core parseWorkflowDag 纯函数 → WorkflowDag。
 *   runId 内存缓存仅缓存成功结果，失败不缓存（parse_failed 可重试，设计 §3.1-5）；
 *   成功缓存带 LRU 上界 5（Map 插入序，命中刷序——对齐 renderer 侧事件流缓存
 *   WORKFLOW_RUN_EVENTS_LRU_LIMIT 量级，防进程级实例 runId 单调累积）。
 *
 * 错误形态二分（两通道，renderer 侧归一）：
 * - 结构化错误臂（reply 正常返回 { sessionId, runId, code, message }，不走 error envelope）：
 *   事件流闭集 = record_not_found（U2 冻结单码；路径白名单拒绝在该闭集下归并
 *   record_not_found + warn 留痕——「run 的 record 不可读」语义等价）；DAG 闭集 =
 *   parse_failed / no_script_source / record_not_found / path_rejected 四码全枚举。
 * - RPC 通道错误（throw → server 中央 catch → sendError）：非 ENOENT 的 fs 错误等
 *   暂时性失败（renderer 据此给重试按钮）。
 */
import { readFileSync, statSync } from 'node:fs'
import {
  parseWorkflowDag,
  type WorkflowDag as CoreWorkflowDag,
  type WorkflowDagEdge as CoreWorkflowDagEdge,
  type WorkflowDagEdgeKind as CoreWorkflowDagEdgeKind,
  type WorkflowDagLoop as CoreWorkflowDagLoop,
  type WorkflowDagNode as CoreWorkflowDagNode,
  type WorkflowDagNodeKind as CoreWorkflowDagNodeKind,
  type WorkflowDagParallelGroup as CoreWorkflowDagParallelGroup,
  type WorkflowDagPhase as CoreWorkflowDagPhase,
  type WorkflowRunEvent,
} from '@zhushanwen/subagent-core'
import type { AssertMutuallyAssignable } from '@zhushanwen/subagent-engine-sdk'
import {
  BYTES_PER_MB,
  READ_PRECHECK_MAX_BYTES,
  WORKFLOW_RUN_EVENT_TRUNCATE_BYTES,
  type WorkflowDag,
  type WorkflowDagEdge,
  type WorkflowDagEdgeKind,
  type WorkflowDagLoop,
  type WorkflowDagNode,
  type WorkflowDagNodeKind,
  type WorkflowDagParallelGroup,
  type WorkflowDagPhase,
  type WorkflowDagReply,
  type WorkflowRunEventEntry,
  type WorkflowRunEventTruncatedField,
  type WorkflowRunEventsReply,
} from '@taiji/shared'
import { parseWorkflowRunEventFileLine } from './events-projection.js'
import { isEnoent } from '../../utils/errors.js'
import { isStrictlyUnder } from '../../utils/path-utils.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'

// ── WorkflowDag 族双侧等值编译锁（core ↔ shared 双向机器锁）──────────────────
//
// core（定义源）与 shared（u2 协议冻结面）的 WorkflowDag 族逐字段等值跟随、双侧
// 同 commit 同步（同步义务原文见 workflow-dag-parser.ts 头注释「类型跟随锚」段）——
// core 包不依赖 @taiji/shared，物理单源不允许。既有锁定只覆盖「shared 扩必选字段」
// 方向（本文件 reply 组装赋值点 typecheck 红）；core 侧扩**可选**字段时互赋值两
// 方向仍成立、此前无任何机器拦截——本锁补该方向：互赋值断言抓同名字段类型/可选性
// 漂移，keyof 键集断言抓单侧新增键（可选加键互赋值不红，只有键集锁能拦）。先例 =
// engine-sdk AssertMutuallyAssignable（protocol-closure 锁族）。直槽元组承载：断言
// 退化为 never 时对应槽的 true 赋值编译红（never 不被静默吞掉）。
type _DagFamilyBidirectionalLock = [
  AssertMutuallyAssignable<CoreWorkflowDag, WorkflowDag>,
  AssertMutuallyAssignable<keyof CoreWorkflowDag, keyof WorkflowDag>,
  AssertMutuallyAssignable<CoreWorkflowDagNode, WorkflowDagNode>,
  AssertMutuallyAssignable<keyof CoreWorkflowDagNode, keyof WorkflowDagNode>,
  AssertMutuallyAssignable<CoreWorkflowDagNodeKind, WorkflowDagNodeKind>,
  AssertMutuallyAssignable<CoreWorkflowDagEdge, WorkflowDagEdge>,
  AssertMutuallyAssignable<keyof CoreWorkflowDagEdge, keyof WorkflowDagEdge>,
  AssertMutuallyAssignable<CoreWorkflowDagEdgeKind, WorkflowDagEdgeKind>,
  AssertMutuallyAssignable<CoreWorkflowDagPhase, WorkflowDagPhase>,
  AssertMutuallyAssignable<keyof CoreWorkflowDagPhase, keyof WorkflowDagPhase>,
  AssertMutuallyAssignable<CoreWorkflowDagParallelGroup, WorkflowDagParallelGroup>,
  AssertMutuallyAssignable<keyof CoreWorkflowDagParallelGroup, keyof WorkflowDagParallelGroup>,
  AssertMutuallyAssignable<CoreWorkflowDagLoop, WorkflowDagLoop>,
  AssertMutuallyAssignable<keyof CoreWorkflowDagLoop, keyof WorkflowDagLoop>,
]
const _dagFamilyBidirectionalLock: _DagFamilyBidirectionalLock = [
  true, true, true, true, true, true, true,
  true, true, true, true, true, true, true,
]

/** record 文件读原语：全量读 + 逐行复用投影解析器（坏行宽容跳过计 warn——对齐活体 tailer 的 onSkippedLines 语义）。 */
function readWorkflowRecordFile(recordPath: string): WorkflowRunEvent[] {
  const content = readFileSync(recordPath, 'utf8')
  const events: WorkflowRunEvent[] = []
  let skipped = 0
  for (const line of content.split('\n')) {
    const event = parseWorkflowRunEventFileLine(line)
    if (event === undefined) {
      if (line.trim().length > 0) skipped += 1
      continue
    }
    events.push(event)
  }
  if (skipped > 0) {
    console.warn(`[workflow-run-events-reader] record stream skipped ${skipped} bad lines: ${recordPath}`)
  }
  return events
}

/** ENOENT → 结构化 record_not_found 裸码；其他 fs 错误上抛（通道错误）。错误臂由调用方按各自 reply 闭集组装。 */
function readRecordOrRecordNotFound(runId: string, recordPath: string): { ok: true; events: WorkflowRunEvent[] } | { ok: false; code: 'record_not_found'; message: string } {
  try {
    return { ok: true, events: readWorkflowRecordFile(recordPath) }
  } catch (e) {
    if (isEnoent(e)) {
      return {
        ok: false,
        code: 'record_not_found',
        message: `workflow record file not found (v1 run or retention expired): ${recordPath}`,
      }
    }
    throw e
  }
}

/**
 * 单字段 UTF-8 字节截断：超限逐 code point 收缩到字节上限内（不切坏多字节字符——
 * 截断值经 WS JSON 传输，非法 UTF-8 序列会在序列化时变 U+FFFD）。阈值 = shared
 * WORKFLOW_RUN_EVENT_TRUNCATE_BYTES 单源（禁另立第二常量）。
 */
function truncateUtf8ByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let bytes = 0
  let end = 0
  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch, 'utf8')
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    end += ch.length
  }
  return { text: text.slice(0, end), truncated: true }
}

/** 截断 + 标注收集：被截断时把字段名记入 truncatedFields（本行标注清单，缺省不造键）。 */
function applyTruncation(
  text: string,
  field: WorkflowRunEventTruncatedField,
  truncatedFields: WorkflowRunEventTruncatedField[],
): string {
  const result = truncateUtf8ByBytes(text, WORKFLOW_RUN_EVENT_TRUNCATE_BYTES)
  if (result.truncated) truncatedFields.push(field)
  return result.text
}

/** 对象载荷 → 截断 JSON 文本（record JSON.parse 产物无循环引用，stringify 失败属异常形态随通道错误上抛）。 */
function truncateJsonPayload(
  value: Record<string, unknown> | undefined,
  field: WorkflowRunEventTruncatedField,
  truncatedFields: WorkflowRunEventTruncatedField[],
): string | undefined {
  if (value === undefined) return undefined
  return applyTruncation(JSON.stringify(value), field, truncatedFields)
}

/** 文本载荷 → 截断（缺省不造键）。 */
function truncateTextPayload(
  value: string | undefined,
  field: WorkflowRunEventTruncatedField,
  truncatedFields: WorkflowRunEventTruncatedField[],
): string | undefined {
  if (value === undefined) return undefined
  return applyTruncation(value, field, truncatedFields)
}

/** 事件信封（ts + 可选 seq；旧格式行 seq 缺失放行，消费方不得以 seq 存在性判数据新旧）。 */
function eventEnvelope(event: WorkflowRunEvent): Pick<WorkflowRunEventEntry, 'ts' | 'seq'> {
  return {
    ts: event.ts,
    ...(event.seq !== undefined ? { seq: event.seq } : {}),
  }
}

/**
 * core 事件 → shared 条目映射（逐成员载荷透传；input/result/scriptSource/args 四
 * 大字段按白名单截断并标注）。词表/字段形态跟随 core WorkflowRunEvent 联合与
 * shared WorkflowRunEventEntry u2 冻结契约（两端的覆盖编译锁守漂移）。
 * 按事件类型分派到独立投影函数（每型字段形态自成一族，拆开各自演化）。
 */
function projectRunEventEntry(event: WorkflowRunEvent): WorkflowRunEventEntry {
  switch (event.type) {
    case 'run-created':
      return projectRunCreated(event)
    case 'phase-started':
      return { type: 'phase-started', ...eventEnvelope(event), phase: event.phase }
    case 'agent-started':
      return projectAgentStarted(event)
    case 'agent-retrying':
      return {
        type: 'agent-retrying',
        ...eventEnvelope(event),
        taskIndex: event.taskIndex,
        attempt: event.attempt,
        backoffMs: event.backoffMs,
        reason: event.reason,
      }
    case 'agent-settled':
      return projectAgentSettled(event)
    case 'phase-settled':
      return { type: 'phase-settled', ...eventEnvelope(event), phase: event.phase }
    case 'run-interrupted':
      return {
        type: 'run-interrupted',
        ...eventEnvelope(event),
        ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
      }
    case 'run-resumed':
      return projectRunResumed(event)
    case 'run-settled':
      return {
        type: 'run-settled',
        ...eventEnvelope(event),
        outcome: event.outcome,
        ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        artifactsDir: event.artifactsDir,
      }
    case 'worker-log':
      return { type: 'worker-log', ...eventEnvelope(event), entry: event.entry }
  }
}

/** run-created 条目：args/scriptSource 两大字段截断 + 可选元字段透传。 */
function projectRunCreated(event: Extract<WorkflowRunEvent, { type: 'run-created' }>): WorkflowRunEventEntry {
  const truncatedFields: WorkflowRunEventTruncatedField[] = []
  const args = truncateJsonPayload(event.args, 'args', truncatedFields)
  const scriptSource = truncateTextPayload(event.scriptSource, 'scriptSource', truncatedFields)
  return {
    type: 'run-created',
    ...eventEnvelope(event),
    runId: event.runId,
    workflowName: event.workflowName,
    // 读侧回退：早于 argsSummary 写侧字段的存量 run-created 行以 undefined 放行
    // （parseWorkflowRunEventFileLine 守卫面不含该字段）——回退空串对齐 shared 必填
    // 契约，防 reply JSON 序列化丢键后 renderer 渲染字面 undefined。
    argsSummary: event.argsSummary ?? '',
    ...(args !== undefined ? { args } : {}),
    ...(event.model !== undefined ? { model: event.model } : {}),
    ...(scriptSource !== undefined ? { scriptSource } : {}),
    ...(event.scriptPath !== undefined ? { scriptPath: event.scriptPath } : {}),
    ...(event.budgetTimeMs !== undefined ? { budgetTimeMs: event.budgetTimeMs } : {}),
    ...(event.budgetTokens !== undefined ? { budgetTokens: event.budgetTokens } : {}),
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
  }
}

/** agent-started 条目：input 大字段截断 + 定位字段透传。 */
function projectAgentStarted(event: Extract<WorkflowRunEvent, { type: 'agent-started' }>): WorkflowRunEventEntry {
  const truncatedFields: WorkflowRunEventTruncatedField[] = []
  const input = truncateTextPayload(event.input, 'input', truncatedFields)
  return {
    type: 'agent-started',
    ...eventEnvelope(event),
    taskIndex: event.taskIndex,
    agentName: event.agentName,
    attempt: event.attempt,
    ...(event.phase !== undefined ? { phase: event.phase } : {}),
    ...(event.memberRecordId !== undefined ? { memberRecordId: event.memberRecordId } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
  }
}

/** agent-settled 条目：result 大字段截断 + outcome/duration 透传。 */
function projectAgentSettled(event: Extract<WorkflowRunEvent, { type: 'agent-settled' }>): WorkflowRunEventEntry {
  const truncatedFields: WorkflowRunEventTruncatedField[] = []
  const result = truncateJsonPayload(event.result as unknown as Record<string, unknown> | undefined, 'result', truncatedFields)
  return {
    type: 'agent-settled',
    ...eventEnvelope(event),
    taskIndex: event.taskIndex,
    attempt: event.attempt,
    outcome: event.outcome,
    ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
    durationMs: event.durationMs,
    ...(event.stderrTeePath !== undefined ? { stderrTeePath: event.stderrTeePath } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
  }
}

/** run-resumed 条目：恢复上下文可选字段透传。 */
function projectRunResumed(event: Extract<WorkflowRunEvent, { type: 'run-resumed' }>): WorkflowRunEventEntry {
  return {
    type: 'run-resumed',
    ...eventEnvelope(event),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.host !== undefined ? { host: event.host } : {}),
    ...(event.budgetTimeMs !== undefined ? { budgetTimeMs: event.budgetTimeMs } : {}),
    ...(event.budgetTokens !== undefined ? { budgetTokens: event.budgetTokens } : {}),
  }
}

/**
 * record 读侧投影服务（SessionRecords 单实例持有——DAG 成功缓存随服务实例生命周期、
 * LRU 上界 5，runId → WorkflowDag 仅缓存成功结果）。sessionId 经参数透传进 reply 两臂
 * （协议恒带——C-comm-05 会话隔离），会话定界本身归 SessionRecords 的路径发现。
 */
export class WorkflowRunEventsReader {
  /**
   * runId → 成功 DAG（失败不缓存——parse_failed 重试可再解析，设计 §3.1-5）。LRU
   * 上界 5（Map 插入序实现：命中重插刷序、插入后超界逐出最旧键）——随服务实例
   * 存活、无会话定界清理点，上界防 runId 单调累积；量级对齐 renderer 侧同数据
   * 缓存 WORKFLOW_RUN_EVENTS_LRU_LIMIT = 5。
   */
  // eslint-disable-next-line no-magic-numbers -- LRU 上界是对齐 renderer 侧 WORKFLOW_RUN_EVENTS_LRU_LIMIT 的缓存容量定值，非可调魔数
  private static readonly DAG_CACHE_LIMIT = 5

  private readonly dagCache = new Map<string, WorkflowDag>()

  /** 缓存命中刷 LRU 序（重插到插入序末尾 = 最近使用）。 */
  private touchDagCache(runId: string, dag: WorkflowDag): void {
    this.dagCache.delete(runId)
    this.dagCache.set(runId, dag)
  }

  /** 缓存插入 + 超界逐出（Map 首键 = 最旧插入且未被命中刷序的条目）。 */
  private setDagCache(runId: string, dag: WorkflowDag): void {
    this.dagCache.set(runId, dag)
    while (this.dagCache.size > WorkflowRunEventsReader.DAG_CACHE_LIMIT) {
      const oldest = this.dagCache.keys().next().value
      if (oldest === undefined) break
      this.dagCache.delete(oldest)
    }
  }

  /** 路径白名单守卫（复用 isStrictlyUnder(getPiAgentDir()) 先例——recordPath 是 session JSONL 提取物，不可信）。 */
  private isPathAllowed(recordPath: string): boolean {
    return isStrictlyUnder(getPiAgentDir(), recordPath)
  }

  /**
   * 单 run 事件流原文（大字段截断形态）。recordPath 缺席/白名单拒绝在结构化闭集
   * （U2 单码 record_not_found）下归并同一码 + warn 留痕——「run 的 record 不可读」
   * 语义等价（renderer 均显示静态指引，无重试）。
   */
  readRunEvents(sessionId: string, runId: string, recordPath: string): WorkflowRunEventsReply {
    if (!this.isPathAllowed(recordPath)) {
      console.warn(
        `[workflow-run-events-reader] record path rejected by allowlist (runId=${runId}): ${recordPath}` +
          ' — returning record_not_found (structured closed set has no dedicated code)',
      )
      return { sessionId, runId, code: 'record_not_found', message: 'workflow record path rejected by allowlist' }
    }
    // oversize 预检（D5 预检族 / RT-4#8 降级形态）：statSync ENOENT 不在此判——继续
    // 走读取路径归 record_not_found；非 ENOENT stat 错误按通道错误上抛。
    let oversize = false
    try {
      oversize = statSync(recordPath).size > READ_PRECHECK_MAX_BYTES
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
    if (oversize) {
      console.warn(
        `[workflow-run-events-reader] record stream oversize (runId=${runId}, ` +
          `>${(READ_PRECHECK_MAX_BYTES / BYTES_PER_MB).toFixed(0)} MB), skip full read: ${recordPath}`,
      )
      return { sessionId, runId, events: [], oversize: true }
    }
    const events = readRecordOrRecordNotFound(runId, recordPath)
    if (!events.ok) return { sessionId, runId, code: events.code, message: events.message }
    return { sessionId, runId, events: events.events.map(projectRunEventEntry) }
  }

  /**
   * 单 run DAG 静态蓝图（core parseWorkflowDag）。错误臂四码全枚举：
   * path_rejected（白名单拒绝，防御性）/ record_not_found（文件不存在）/
   * no_script_source（无 run-created 帧或旧格式行缺 scriptSource）/
   * parse_failed（解析器不支持语法——fail-fast 不产半个错误 DAG）。成功结果缓存。
   */
  readDag(sessionId: string, runId: string, recordPath: string): WorkflowDagReply {
    const cached = this.dagCache.get(runId)
    if (cached !== undefined) {
      this.touchDagCache(runId, cached)
      return { sessionId, runId, dag: cached }
    }
    if (!this.isPathAllowed(recordPath)) {
      return { sessionId, runId, code: 'path_rejected', message: `workflow record path rejected by allowlist: ${recordPath}` }
    }
    const events = readRecordOrRecordNotFound(runId, recordPath)
    if (!events.ok) return { sessionId, runId, code: events.code, message: events.message }
    const created = events.events.find((event) => event.type === 'run-created')
    if (created === undefined || created.type !== 'run-created' || created.scriptSource === undefined) {
      return {
        sessionId,
        runId,
        code: 'no_script_source',
        message: 'run record has no run-created scriptSource (legacy format before record single-source)',
      }
    }
    const parsed = parseWorkflowDag(created.scriptSource)
    if (!parsed.ok) {
      return { sessionId, runId, code: 'parse_failed', message: parsed.message }
    }
    this.setDagCache(runId, parsed.dag)
    return { sessionId, runId, dag: parsed.dag }
  }
}
