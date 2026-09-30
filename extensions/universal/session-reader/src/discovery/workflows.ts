import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseSessionContent, type Entry } from '@zhushanwen/session-core'
import type { SessionRef, WorkflowRef } from '../core/family.js'
import { extractSessionIdFromFilename } from './subagents.js'

// ============================================================
// workflow-record 发现链路（单档：v2 注册条目 recordPath 主源）
// ============================================================
//
// 本文件持有 workflow run 的发现与 sessionFile 提取逻辑（IO 适配层）：
// - resolveWorkflows：workflow-record v2 注册条目（`v === 2` ∧ `kind === 'registered'`
//   ∧ runId/recordPath 均非空 string）是唯一发现通道——recordPath 锚点语义 = record
//   流路径（[D16③]），指向 <runId>.record.jsonl（[D1] record 单源事件流），发现链读
//   record 流行自提 calls——sessionFile 取 agent-settled 帧 result 全文携带的
//   sessionFile（[D1] 载荷表：result 全文入事件，AgentResult 自带 sessionFile 字段
//   ——家族链数据源同 record 流，无第二承载位）；旧后缀锚点（.events.jsonl 形态）=
//   历史实体（[D1] 历史数据处置：旧两件不读）→ calls=[] 仅 run 存在性兜底。
//   历史格式条目（v1 全量快照 / workflow-state-link 指针）不识别、静默从发现链消失
//   （不拒读、不报错）——run 侧 v1 读面已删除（ADR-0095，同 record 侧裁决：项目未
//   上线无历史数据，不迁移不兼容）。
// - readRunSnapshot：读 wf-state 文件尾向找首个可解析行，返回原始对象（unknown，格式
//   收窄交 core 层）。唯一消费方 = tool-handler workflow 概览的快照链分支。
// - extractRecordStreamSessionFiles：[D16③] 从 record 事件流提 calls 的 sessionFile
//   （agent-settled 帧 result.sessionFile——活跃 run 与已收编 run 同源可用）。
// - sessionRefFromPath：sessionFile 路径 → SessionRef（命中 pathToRef 取完整，否则
//   文件名提取最小 ref）。
//
// 分层约定（w5 TC-wf-core-pure-logic）：IO 全在 discovery/，core/workflow.ts 的
// parseRunSnapshot/renderWorkflowOverview 是纯逻辑零 IO（喂 mock 可单测）。
// readRunSnapshot 返 unknown 不收窄——类型化是 core 层 parseRunSnapshot 的职责
// （TC-wf-snapshot-version-union）。
//
// extractSessionIdFromFilename 留在 subagents.ts（find.ts + 导出契约测试直接消费），
// 此处反向 import。

/**
 * 读 wf-state 文件，从尾向头找首个 trim 非空且 JSON.parse 成功的行，返回解析后的原始对象。
 *
 * 拆解自原 readWorkflowCallSessionFiles 的读行职责（w5 TC-wf-core-pure-logic）——
 * 读行（本函数，返 unknown）+ 类型化（core/workflow.ts 的 parseRunSnapshot，
 * C-readrunsnapshot-unknown）分层。
 *
 * 尾向回退策略（沿用原实现，ES-wf-snapshot-partial）：wf 文件是 rewrite 覆盖模式，读撞 rewrite
 * 中点时末行是半截 JSON（parse 失败）→ 试上一完整行；单行文件半行 → 全失败 → undefined。
 * 文件不存在/读失败/全行不可解析 → undefined（不抛错，调用方据此跳过该 run）。
 */
export async function readRunSnapshot(wfPath: string): Promise<unknown | undefined> {
  let content: string
  try {
    content = await readFile(wfPath, 'utf8')
  } catch {
    return undefined // wf 文件不存在/读失败 → undefined（不抛错）
  }
  const lines = content.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue
    try {
      return JSON.parse(lines[i])
    } catch {
      continue // 坏行（含 rewrite 中点半截 JSON），试上一行
    }
  }
  return undefined
}

/**
 * 从 sessionFile 绝对路径反查 SessionRef。优先用已扫描的 pathToRef（含真实 id/cwd/stat）；
 * 找不到（文件 GC/路径迁移）返回 fileName-only 最小 SessionRef（不抛错）。
 */
function sessionRefFromPath(path: string, pathToRef: Map<string, SessionRef>): SessionRef {
  const existing = pathToRef.get(path)
  if (existing) return existing
  return {
    sessionId: extractSessionIdFromFilename(basename(path)),
    fileName: path,
    mtime: 0,
    sizeBytes: 0,
    cwd: '',
  }
}

// ============================================================
// workflow-record 条目契约（v2 注册条目判别——本地字面量 + 测试守卫漂移）
// ============================================================

/**
 * `workflow-record` custom entry 的 customType 值。
 *
 * 磁盘 JSONL 协议字符串（跨侧契约）：写侧单源 = subagent-core
 * workflow-record-entry.ts 的 WORKFLOW_RECORD_CUSTOM_TYPE。reader 生产依赖面不引
 * subagent-core（同 entry-anchor.ts 的协议字面量模式），两侧漂移由 workflow.test.ts
 * 的跨包断言守卫。
 */
const WORKFLOW_RECORD_CUSTOM_TYPE = 'workflow-record'

/** v2 条目 data 的认识版本（写侧 WORKFLOW_RECORD_ENTRY_VERSION 同值，W1 起 = 2）。 */
const WORKFLOW_RECORD_ENTRY_V2 = 2

/**
 * run record 流文件名尾段（`<runId>.record.jsonl`）。写侧 subagent-core
 * RUN_EVENTS_SUFFIX 同值（[D1] record 单源后缀）——v2 注册条目的
 * recordPath 锚点后缀判定用（新锚点直读 record 流；旧 `.events.jsonl` 锚点 =
 * 历史实体分流），本地持有 + 测试守卫漂移。
 */
export const RUN_RECORD_STREAM_SUFFIX = '.record.jsonl'

/** v2 注册条目收集结果（同 runId 后写覆盖前写；order = 条目在 session 文件中的首见序）。 */
interface RegisteredRecordPaths {
  byRunId: Map<string, string>
  order: string[]
}

/**
 * 单遍扫描 entries 收集 workflow-record v2 注册条目（纯收集，无 IO）：
 * `v === 2` ∧ `kind === 'registered'` ∧ runId/recordPath 均非空 string。终态条目
 * （kind === 'settled'）不携带 recordPath、不参与发现链，不收集。
 */
function collectRegisteredRecordPaths(entries: readonly Entry[]): RegisteredRecordPaths {
  const byRunId = new Map<string, string>()
  const order: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const data = e.data as Record<string, unknown> | undefined
    if (e.customType !== WORKFLOW_RECORD_CUSTOM_TYPE || data === undefined) continue
    if (data.v !== WORKFLOW_RECORD_ENTRY_V2 || data.kind !== 'registered') continue
    const runId = data.runId
    const recordPath = data.recordPath
    if (typeof runId !== 'string' || runId === '' || typeof recordPath !== 'string' || recordPath === '') {
      continue
    }
    if (!seen.has(runId)) {
      seen.add(runId)
      order.push(runId)
    }
    byRunId.set(runId, recordPath) // 后写覆盖前写（取最新锚点）
  }
  return { byRunId, order }
}

/**
 * [D16③] recordPath 后缀分流：`.record.jsonl` 锚点 = 新形态（record 流直读）；
 * 其余（含旧 `.events.jsonl` 锚点）= 历史实体（[D1] 历史数据处置——旧两件不读
 * 不写，历史 run 从发现链数据面退空即预期行为）。
 */
function isNewRecordStreamAnchor(recordPath: string): boolean {
  return recordPath.endsWith(RUN_RECORD_STREAM_SUFFIX)
}

/** agent-settled 帧的最小消费视图（record 流宽容解析只消费 taskIndex 与
 *  result.sessionFile 两字段，其余载荷不读取）。 */
interface AgentSettledSessionFileView {
  taskIndex: number
  result: { sessionFile: string }
}

/** [extractRecordStreamSessionFiles 守卫] 单帧是否为携带非空 result.sessionFile
 *  的 agent-settled 帧：逐字段 typeof 校验（type → taskIndex → result →
 *  sessionFile），不过关 = 宽容跳过（与 readRunSnapshot 同容忍度）。 */
function isAgentSettledSessionFileFrame(v: unknown): v is AgentSettledSessionFileView {
  if (typeof v !== 'object' || v === null) return false
  const rec = v as Record<string, unknown>
  if (rec.type !== 'agent-settled' || typeof rec.taskIndex !== 'number') return false
  const result: unknown = rec.result
  if (typeof result !== 'object' || result === null) return false
  const sessionFile: unknown = (result as Record<string, unknown>).sessionFile
  return typeof sessionFile === 'string' && sessionFile !== ''
}

/**
 * [D16③] record 事件流 → calls 的 sessionFile 绝对路径数组：逐行宽容解析
 * （跳过坏行/空行——与 readRunSnapshot 同容忍度），agent-settled 帧（含
 * result 全文）按 taskIndex 归位——首见生效（重试波多帧时终局帧 result 后到
 * 覆盖，与 fold 后到覆盖语义一致）。
 */
export function extractRecordStreamSessionFiles(content: string): string[] {
  const byIndex = new Map<number, string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // 坏行（截断行）跳过
    }
    if (!isAgentSettledSessionFileFrame(parsed)) continue
    byIndex.set(parsed.taskIndex, parsed.result.sessionFile)
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, sf]) => sf)
}

/**
 * 读目标 session 文件全文，从 workflow-record v2 注册条目构造 WorkflowRef[]
 * （单档发现链——v1 快照条目与 workflow-state-link 指针条目不再识别，历史 run
 * 从发现链数据面退空即预期行为，见 ADR-0095）。同一 runId 的多条目后写覆盖
 * （条目顺序 = 时间顺序，取最新锚点）。
 *
 * **签名与返回值结构（WorkflowRef[]{runId,stateFile,calls:SessionRef[]}）不变**
 * （C-resolveworkflows-signature，保 m1 已冻结交付的消费者）。stateFile = recordPath
 * 本身（record 流路径——[D16③] 锚点语义，D1 后 v2 条目携带的锚点即 record 事件流
 * 文件）；record 流直读提 calls（agent-settled.result.sessionFile），流被清理/
 * 不可读 → calls=[]（run 存在性兜底）。
 */
export async function resolveWorkflows(
  sessionId: string,
  sessionIdToPath: Map<string, string>,
  pathToRef: Map<string, SessionRef>,
): Promise<WorkflowRef[]> {
  const targetPath = sessionIdToPath.get(sessionId)
  if (!targetPath) return [] // 兜底（buildFamilyFromFs 已校验 sessionId 存在）
  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch {
    return []
  }
  const { entries } = parseSessionContent(content)
  const recordPaths = collectRegisteredRecordPaths(entries)
  const workflows: WorkflowRef[] = []
  for (const runId of recordPaths.order) {
    const recordPath = recordPaths.byRunId.get(runId)
    if (recordPath === undefined) continue
    let streamContent: string | undefined
    if (isNewRecordStreamAnchor(recordPath)) {
      try {
        streamContent = await readFile(recordPath, 'utf8')
      } catch {
        streamContent = undefined // 流被保留期清理/不可读 → calls=[]（run 存在性兜底）
      }
    }
    const sessionFiles = streamContent === undefined ? [] : extractRecordStreamSessionFiles(streamContent)
    workflows.push({
      runId,
      stateFile: recordPath,
      calls: sessionFiles.map((sf) => sessionRefFromPath(sf, pathToRef)),
    })
  }
  return workflows
}
