import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseSessionContent, type Entry } from '@zhushanwen/session-core'
import type { SessionRef, WorkflowRef } from '../core/family.js'
import { extractSessionIdFromFilename } from './subagents.js'

// ============================================================
// workflow-state 发现链路（w5 从 subagents.ts 物理迁移，架构归位 SSOT §6.3）
// ============================================================
//
// 本文件持有 workflow run 的发现与 sessionFile 提取逻辑（IO 适配层）：
// - resolveWorkflows：三档发现链（按 runId 合并，高档条目在即用高档）——
//   ① v2 journalPath 主源（[D16③] 发现链重锚：journalPath 锚点语义 = record 流路径）：
//     workflow-record v2 注册条目的 journalPath 指向 <runId>.record.jsonl（[D1] record
//     单源事件流），发现链读 record 流行自提 calls——sessionFile 取 agent-settled 帧
//     result 全文携带的 sessionFile（[D1] 载荷表：result 全文入事件，AgentResult
//     自带 sessionFile 字段——家族链数据源同 record 流，无第二承载位）；旧后缀锚点
//     （.events.jsonl 形态）= 历史实体（[D1] 历史数据处置：旧两件不读）→ calls=[]
//     仅 run 存在性兜底；
//   ② v1 快照层：workflow-record v1 快照条目（W17~W1 期间创建的 run——快照是全量的，
//     直接从 snapshot.calls 提 sessionFile，家族链数据完整）；
//   ③ 旧指针 fallback：workflow-state-link 指针条目（W17 前的 run，照旧读 link 指向的
//     wf-state 文件）。
// - readRunSnapshot：读 wf-state 文件尾向找首个可解析行，返回原始对象（unknown，格式收窄交 core 层）。
// - extractCallSessionFiles：从快照对象提 calls 的 sessionFile 绝对路径数组（NEW/OLD 双格式）。
// - extractRecordStreamSessionFiles：[D16③] 从 record 事件流提 calls 的 sessionFile
//   （agent-settled 帧 result.sessionFile——活跃 run 与已收编 run 同源可用）。
// - sessionRefFromPath：sessionFile 路径 → SessionRef（命中 pathToRef 取完整，否则文件名提取最小 ref）。
//
// 分层约定（w5 TC-wf-core-pure-logic）：IO 全在 discovery/，core/workflow.ts 的
// parseRunSnapshot/renderWorkflowOverview 是纯逻辑零 IO（喂 mock 可单测）。readRunSnapshot 返
// unknown 不收窄——NEW/OLD 双格式的类型化是 core 层 parseRunSnapshot 的职责（TC-wf-snapshot-version-union）。
//
// extractSessionIdFromFilename 留在 subagents.ts（find.ts + 导出契约测试直接消费），此处反向 import。

/**
 * 从 wf-state 快照对象提取 calls[].sessionFile（绝对路径数组）。
 *
 * 两种格式（探查确认，本机 371 个 wf 文件）：
 * - NEW (v="wf-run-v1" 或 "wf-run-v2"，读取面形状一致)：state.calls[]，每项顶层
 *   .sessionFile（258 文件 / 1590 sessionFile）。v2 由 pi-subagent-workflow 8.x 一次性
 *   生命周期收敛引入（status 两态、无 pausedAt），calls[].sessionFile/result 保留
 * - OLD (无 v)：callCache[]=[{key,value}]，value.sessionFile（112 文件 / 0 sessionFile，旧 pi 不持久化）
 */
export function extractCallSessionFiles(snap: unknown): string[] {
  const out: string[] = []
  if (typeof snap !== 'object' || snap === null) return out
  const s = snap as Record<string, unknown>
  const isNew = isNewSnapshotFormat(s)
  const callsRaw = extractCallsRaw(s, isNew)
  if (!Array.isArray(callsRaw)) return out
  for (const c of callsRaw) {
    if (typeof c !== 'object' || c === null) continue
    const item = resolveCallItem(c as Record<string, unknown>, isNew)
    const sf = extractSessionFileFromItem(item)
    if (sf !== undefined) out.push(sf)
  }
  return out
}

/** 快照是否为 NEW 格式（v="wf-run-v1"/"wf-run-v2"，读取面形状一致） */
function isNewSnapshotFormat(s: Record<string, unknown>): boolean {
  return s.v === 'wf-run-v1' || s.v === 'wf-run-v2'
}

/** 按格式取 calls 原始集合：NEW 读 state.calls（state 守卫后取），OLD 读顶层 callCache */
function extractCallsRaw(s: Record<string, unknown>, isNew: boolean): unknown {
  if (isNew) {
    const state = s.state
    return typeof state === 'object' && state !== null
      ? (state as Record<string, unknown>).calls
      : undefined
  }
  return s.callCache
}

/**
 * 单条 call 归一为可取 sessionFile 的对象：
 * NEW: call 本身；OLD: {key, value}，取 value（value 非对象时回退 call 本身，容错脏数据）
 */
function resolveCallItem(co: Record<string, unknown>, isNew: boolean): Record<string, unknown> {
  if (isNew) return co
  const value = co.value
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : co
}

/** 从归一后的 call 对象提 sessionFile：顶层优先，回退 result.sessionFile；均缺 → undefined */
function extractSessionFileFromItem(item: Record<string, unknown>): string | undefined {
  const sf = item.sessionFile
  if (typeof sf === 'string') return sf
  const result = item.result
  const sf2 =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>).sessionFile
      : undefined
  if (typeof sf2 === 'string') return sf2
  return undefined
}

/**
 * 读 wf-state 文件，从尾向头找首个 trim 非空且 JSON.parse 成功的行，返回解析后的原始对象。
 *
 * 拆解自原 readWorkflowCallSessionFiles 的读行职责（w5 TC-wf-core-pure-logic）——后者=读行+
 * 提 sessionFile 的胶水，迁移后由 readRunSnapshot（读行，返 unknown）+ extractCallSessionFiles
 * （提 sessionFile）组合替代。返回类型 unknown：IO 层不假设格式，类型收窄交 core/workflow.ts
 * 的 parseRunSnapshot（C-readrunsnapshot-unknown，TC-wf-snapshot-version-union）。
 *
 * 尾向回退策略（沿用原实现，ES-wf-snapshot-partial）：wf 文件是 rewrite 覆盖模式，读撞 rewrite
 * 中点时末行是半截 JSON（parse 失败）→ 试上一完整行；单行文件半行 → 全失败 → undefined。
 * 文件不存在/读失败/全行不可解析 → undefined（不抛错，调用方 resolveWorkflows 据此 calls=[]）。
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
// workflow-record 条目契约（三档发现链的条目判别——本地字面量 + 测试守卫漂移）
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

/** v2 条目 data 的认识版本词表（W1 起 = 2；写侧 WORKFLOW_RECORD_ENTRY_VERSION 同值）。 */
const WORKFLOW_RECORD_ENTRY_V2 = 2

/**
 * run record 流文件名尾段（`<runId>.record.jsonl`）。写侧 subagent-core
 * RUN_EVENT_JOURNAL_SUFFIX 同值（[D1] record 单源后缀）——v2 注册条目的
 * journalPath 锚点后缀判定用（新锚点直读 record 流；旧 `.events.jsonl` 锚点 =
 * 历史实体分流），本地持有 + 测试守卫漂移。
 */
export const RUN_RECORD_STREAM_SUFFIX = '.record.jsonl'

/** 单遍扫描 entries 的三档收集结果（档内同 runId 后写覆盖前写，跨档优先级见 resolveWorkflows）。 */
interface WorkflowEntryTiers {
  /** ① v2 注册条目：runId → journalPath 锚点（W1+ 的 run）。 */
  v2ByRunId: Map<string, string>
  /** ② v1 快照条目：runId → 全量快照对象（W17~W1 期间创建的 run）。 */
  v1ByRunId: Map<string, unknown>
  /** ③ 旧指针条目：runId → link path（W17 前的 run）。 */
  linkByRunId: Map<string, { runId: string; path: string }>
  /** runId 首见序（输出稳定序——条目在 session 文件中的出现顺序）。 */
  runIdOrder: string[]
}

/**
 * 单遍扫描 entries 按三档形态分桶（纯收集，无 IO）：
 * - workflow-record v2 注册条目：`v === 2` ∧ `kind === 'registered'` ∧ runId/journalPath
 *   均非空 string（终态条目不携带 journalPath，非发现链数据源，不收集）；
 * - workflow-record v1 快照条目：`v === 1` ∧ snapshot 为对象 ∧ `snapshot.runId` 为
 *   string（runId 在快照内——entry data 顶层无 runId 字段）；
 * - workflow-state-link 指针条目：现状判别。
 */
function collectWorkflowEntryTiers(entries: readonly Entry[]): WorkflowEntryTiers {
  const tiers: WorkflowEntryTiers = {
    v2ByRunId: new Map(),
    v1ByRunId: new Map(),
    linkByRunId: new Map(),
    runIdOrder: [],
  }
  const seen = new Set<string>()
  const noteRunId = (runId: string): void => {
    if (!seen.has(runId)) {
      seen.add(runId)
      tiers.runIdOrder.push(runId)
    }
  }
  for (const e of entries) {
    const data = e.data as Record<string, unknown> | undefined
    if (e.customType === WORKFLOW_RECORD_CUSTOM_TYPE && data !== undefined) {
      if (data.v === WORKFLOW_RECORD_ENTRY_V2 && data.kind === 'registered') {
        const runId = data.runId
        const journalPath = data.journalPath
        if (typeof runId === 'string' && runId !== '' && typeof journalPath === 'string' && journalPath !== '') {
          tiers.v2ByRunId.set(runId, journalPath)
          noteRunId(runId)
        }
      } else if (data.v === 1 && typeof data.snapshot === 'object' && data.snapshot !== null) {
        const snapshotRunId = (data.snapshot as Record<string, unknown>).runId
        if (typeof snapshotRunId === 'string' && snapshotRunId !== '') {
          tiers.v1ByRunId.set(snapshotRunId, data.snapshot)
          noteRunId(snapshotRunId)
        }
      }
      continue
    }
    if (e.customType === 'workflow-state-link') {
      const runId = data?.runId
      const path = data?.path
      if (typeof runId === 'string' && typeof path === 'string') {
        tiers.linkByRunId.set(runId, { runId, path }) // 后写覆盖前写（取最新 link）
        noteRunId(runId)
      }
    }
  }
  return tiers
}

/**
 * [D16③] journalPath 后缀分流：`.record.jsonl` 锚点 = 新形态（record 流直读）；
 * 其余（含旧 `.events.jsonl` 锚点）= 历史实体（[D1] 历史数据处置——旧两件不读
 * 不写，历史 run 从发现链数据面退空即预期行为）。
 */
function isNewRecordStreamAnchor(journalPath: string): boolean {
  return journalPath.endsWith(RUN_RECORD_STREAM_SUFFIX)
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
    if (typeof parsed !== 'object' || parsed === null) continue
    const rec = parsed as { type?: unknown; taskIndex?: unknown; result?: unknown }
    if (rec.type !== 'agent-settled' || typeof rec.taskIndex !== 'number') continue
    const result = rec.result
    if (typeof result !== 'object' || result === null) continue
    const sessionFile = (result as { sessionFile?: unknown }).sessionFile
    if (typeof sessionFile === 'string' && sessionFile !== '') {
      byIndex.set(rec.taskIndex, sessionFile)
    }
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, sf]) => sf)
}

/**
 * 读目标 session 文件全文，按三档发现链构造 WorkflowRef[]（D10 断链修复：W17 前/
 * W17~W1/W1+ 三类 run 全部有发现通道）。同一 runId 的多条目按 runId 去重取档内
 * 最新（后写覆盖）；跨档优先级 = v2 注册条目 > v1 快照条目 > 旧指针——一个 run 只
 * 以一种形态写条目（创建时点决定），跨档同 runId 是坏数据防御，高档在即用高档。
 *
 * **签名与返回值结构（WorkflowRef[]{runId,stateFile,calls:SessionRef[]}）完全不变**
 * （C-resolveworkflows-signature，保 m1 已冻结交付的消费者）。三档的 stateFile 语义：
 * - v2 档：journalPath 推导的 state 快照路径（窗口外文件已删 → readRunSnapshot
 *   undefined → calls=[]，run 存在性兜底——与旧链窗外行为同构）；
 * - v1 档：空串（v1 快照条目不携带 state 路径，快照数据直接从条目提 calls；概览
 *   消费面 readRunSnapshot('') 自然落「快照不可读」跳过，家族链 calls 不受影响）；
 * - 旧指针档：link 的 path（现状）。
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
  const tiers = collectWorkflowEntryTiers(entries)
  const workflows: WorkflowRef[] = []
  for (const runId of tiers.runIdOrder) {
    const journalPath = tiers.v2ByRunId.get(runId)
    if (journalPath !== undefined) {
      // ① v2 档（[D16③] 重锚）：journalPath = record 流路径——新后缀锚点直读流提
      // calls（agent-settled.result.sessionFile）；旧后缀锚点 = 历史实体（[D1]
      // 不读旧两件）→ calls=[] 仅 run 存在性兜底。
      let sessionFiles: string[] = []
      if (isNewRecordStreamAnchor(journalPath)) {
        let content: string | undefined
        try {
          content = await readFile(journalPath, 'utf8')
        } catch {
          content = undefined // 流被保留期清理/不可读 → calls=[]（run 存在性兜底）
        }
        sessionFiles = content === undefined ? [] : extractRecordStreamSessionFiles(content)
      }
      workflows.push({
        runId,
        stateFile: journalPath,
        calls: sessionFiles.map((sf) => sessionRefFromPath(sf, pathToRef)),
      })
      continue
    }
    const snapshot = tiers.v1ByRunId.get(runId)
    if (snapshot !== undefined) {
      // ② v1 快照档：快照全量在场，直接提 calls（W17~W1 中间档恢复）
      workflows.push({
        runId,
        stateFile: '',
        calls: extractCallSessionFiles(snapshot).map((sf) => sessionRefFromPath(sf, pathToRef)),
      })
      continue
    }
    // ③ 旧指针档：现状（link path → wf-state 文件）
    const link = tiers.linkByRunId.get(runId)
    if (link === undefined) continue
    const snap = await readRunSnapshot(link.path)
    const sessionFiles = snap === undefined ? [] : extractCallSessionFiles(snap)
    workflows.push({
      runId: link.runId,
      stateFile: link.path,
      calls: sessionFiles.map((sf) => sessionRefFromPath(sf, pathToRef)),
    })
  }
  return workflows
}
