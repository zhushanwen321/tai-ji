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
 *   与 args 一致性校验在引擎侧读 record 原文全文字段，不经本通道）。
 * - readDag：record 首帧 run-created 的 scriptSource 原文（不截断——DAG 解析不经
 *   事件流截断通道，设计 §3.1-4）→ core parseWorkflowDag 纯函数 → WorkflowDag。
 *   runId 内存缓存仅缓存成功结果，失败不缓存（parse_failed 可重试，设计 §3.1-5）。
 *
 * 错误形态二分（两通道，renderer 侧归一）：
 * - 结构化错误臂（reply 正常返回 { runId, code, message }，不走 error envelope）：
 *   事件流闭集 = record_not_found（U2 冻结单码；路径白名单拒绝在该闭集下归并
 *   record_not_found + warn 留痕——「run 的 record 不可读」语义等价）；DAG 闭集 =
 *   parse_failed / no_script_source / record_not_found / path_rejected 四码全枚举。
 * - RPC 通道错误（throw → server 中央 catch → sendError）：非 ENOENT 的 fs 错误等
 *   暂时性失败（renderer 据此给重试按钮）。
 */
import { readFileSync } from 'node:fs'
import {
  parseWorkflowDag,
  type WorkflowRunEvent,
} from '@zhushanwen/subagent-core'
import {
  WORKFLOW_RUN_EVENT_TRUNCATE_BYTES,
  type WorkflowDag,
  type WorkflowDagReply,
  type WorkflowRunEventEntry,
  type WorkflowRunEventTruncatedField,
  type WorkflowRunEventsReply,
} from '@taiji/shared'
import { parseWorkflowRunEventFileLine } from './events-projection.js'
import { isEnoent } from '../../utils/errors.js'
import { isStrictlyUnder } from '../../utils/path-utils.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'

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
 */
function projectRunEventEntry(event: WorkflowRunEvent): WorkflowRunEventEntry {
  switch (event.type) {
    case 'run-created': {
      const truncatedFields: WorkflowRunEventTruncatedField[] = []
      const args = truncateJsonPayload(event.args, 'args', truncatedFields)
      const scriptSource = truncateTextPayload(event.scriptSource, 'scriptSource', truncatedFields)
      return {
        type: 'run-created',
        ...eventEnvelope(event),
        runId: event.runId,
        workflowName: event.workflowName,
        argsSummary: event.argsSummary,
        ...(args !== undefined ? { args } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(scriptSource !== undefined ? { scriptSource } : {}),
        ...(event.scriptPath !== undefined ? { scriptPath: event.scriptPath } : {}),
        ...(event.budgetTimeMs !== undefined ? { budgetTimeMs: event.budgetTimeMs } : {}),
        ...(event.budgetTokens !== undefined ? { budgetTokens: event.budgetTokens } : {}),
        ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
      }
    }
    case 'phase-started':
      return { type: 'phase-started', ...eventEnvelope(event), phase: event.phase }
    case 'agent-started': {
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
    case 'agent-retrying':
      return {
        type: 'agent-retrying',
        ...eventEnvelope(event),
        taskIndex: event.taskIndex,
        attempt: event.attempt,
        backoffMs: event.backoffMs,
        reason: event.reason,
      }
    case 'agent-settled': {
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
      return {
        type: 'run-resumed',
        ...eventEnvelope(event),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.host !== undefined ? { host: event.host } : {}),
        ...(event.budgetTimeMs !== undefined ? { budgetTimeMs: event.budgetTimeMs } : {}),
        ...(event.budgetTokens !== undefined ? { budgetTokens: event.budgetTokens } : {}),
      }
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

/**
 * record 读侧投影服务（SessionRecords 单实例持有——DAG 成功缓存随服务实例生命周期，
 * runId → WorkflowDag 仅缓存成功结果）。
 */
export class WorkflowRunEventsReader {
  /** runId → 成功 DAG（失败不缓存——parse_failed 重试可再解析，设计 §3.1-5）。 */
  private readonly dagCache = new Map<string, WorkflowDag>()

  /** 路径白名单守卫（复用 isStrictlyUnder(getPiAgentDir()) 先例——recordPath 是 session JSONL 提取物，不可信）。 */
  private isPathAllowed(recordPath: string): boolean {
    return isStrictlyUnder(getPiAgentDir(), recordPath)
  }

  /**
   * 单 run 事件流原文（大字段截断形态）。recordPath 缺席/白名单拒绝在结构化闭集
   * （U2 单码 record_not_found）下归并同一码 + warn 留痕——「run 的 record 不可读」
   * 语义等价（renderer 均显示静态指引，无重试）。
   */
  readRunEvents(runId: string, recordPath: string): WorkflowRunEventsReply {
    if (!this.isPathAllowed(recordPath)) {
      console.warn(
        `[workflow-run-events-reader] record path rejected by allowlist (runId=${runId}): ${recordPath}` +
          ' — returning record_not_found (structured closed set has no dedicated code)',
      )
      return { runId, code: 'record_not_found', message: 'workflow record path rejected by allowlist' }
    }
    const events = readRecordOrRecordNotFound(runId, recordPath)
    if (!events.ok) return { runId, code: events.code, message: events.message }
    return { runId, events: events.events.map(projectRunEventEntry) }
  }

  /**
   * 单 run DAG 静态蓝图（core parseWorkflowDag）。错误臂四码全枚举：
   * path_rejected（白名单拒绝，防御性）/ record_not_found（文件不存在）/
   * no_script_source（无 run-created 帧或旧格式行缺 scriptSource）/
   * parse_failed（解析器不支持语法——fail-fast 不产半个错误 DAG）。成功结果缓存。
   */
  readDag(runId: string, recordPath: string): WorkflowDagReply {
    const cached = this.dagCache.get(runId)
    if (cached !== undefined) return { runId, dag: cached }
    if (!this.isPathAllowed(recordPath)) {
      return { runId, code: 'path_rejected', message: `workflow record path rejected by allowlist: ${recordPath}` }
    }
    const events = readRecordOrRecordNotFound(runId, recordPath)
    if (!events.ok) return { runId, code: events.code, message: events.message }
    const created = events.events.find((event) => event.type === 'run-created')
    if (created === undefined || created.type !== 'run-created' || created.scriptSource === undefined) {
      return {
        runId,
        code: 'no_script_source',
        message: 'run record has no run-created scriptSource (legacy format before record single-source)',
      }
    }
    const parsed = parseWorkflowDag(created.scriptSource)
    if (!parsed.ok) {
      return { runId, code: 'parse_failed', message: parsed.message }
    }
    this.dagCache.set(runId, parsed.dag)
    return { runId, dag: parsed.dag }
  }
}
