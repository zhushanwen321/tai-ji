/**
 * Subagent 提取器 —— 从 session entry 列表派生 SubagentRecord[]。
 *
 * [W18] 本文件重构为 entry 扫描器：`scanSubagentEntries(entries)` 是 subagent 列表唯一派生
 * 函数，实时（entry_appended 失效 → get_entries 增量/全量拉取）与冷启动（磁盘 JSONL 全量
 * 解析 → getSubagents RPC）两条通路都调它（D4「实时与重开走同一份扫描代码」，模式 2 双
 * 管线消亡）。
 *
 * 数据来源优先级：
 * 1. **自描述 `subagent-record` entry（W16 v1，权威）**：pi-subagent-workflow 在 record 状态
 *    迁移点（register/archive/reportRecordTransition）经 pi.appendEntry 落完整快照（customType
 *    常量 = shared SUBAGENT_RECORD_CUSTOM_TYPE）。读取方无需逆向解析 toolCall/toolResult。
 * 2. **legacy 解析（降级兜底）**：无自描述 entry 命中（W16 改造前创建的旧 session）时走
 *    旧双管线的磁盘解析逻辑——从 toolCall/toolResult/bg-notify 配对重建。降级表现 = 旧
 *    session 数据滞后但可用（登记表 #8 标注）。
 *
 * legacy JSONL 中的 entry 模式（pi-subagent-workflow，仅 background 模式）：
 * 1. assistant message 含 toolCall{name:'subagent', arguments:{action:'start', startParam:{task, slug, agent?, model?, thinkingLevel?, fork?, worktree?, ...}}}
 * 2. toolResult message 含 content[0].text = JSON 字符串，解析后含：
 *    - background 模式：{action:'start', subagentId, sessionFile:null, bgResponse:{status:'running', message:'detached...'}}
 *    - list 模式：{action:'list', subagentId:null, sessionFile:null, listResponse:{running, items:[{subagentId, agent, status, sessionFile, model, totalTokens, duration}]}}
 * 3. custom_message customType:'subagent-bg-notify' 含 details:{id, status:'running'|'closed'（legacy 兼容 done/failed/cancelled）, agent, model, result, error, startedAt, endedAt, closedReason?, round?}
 *    （background 完成终态 / 对话模式轮次完成时注入，可用来更新状态）
 *
 * 2026-07-13 对齐 pi-subagent-workflow feat-ask-user-gui 分支：
 * - startParam 新增 slug（短标签），extractor 提取到 SubagentRecord.slug
 * - 移除 sync 模式分支（新版只有 background）
 * - 旧 session JSONL（startParam 无 slug）slug 兜底空串
 *
 * 2026-08-25 P5：分协议历史读取链（record.engine 路由 + ①reader ②journal ③outcome
 * 三级降级）独立到 ./subagent-engine-history.ts——本文件保持纯 entry 扫描器职责。
 *
 * 2026-09-02 dual-track-convergence D1：engineHandle 守卫收敛到 core
 * session-view-types.parseEngineHandle 单一实现（读写两侧共用），本地
 * projectEngineHandle 删除。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseJsonl } from '../../utils/jsonl.js'
import { getSubagentSessionDir } from '../../infra/pi/pi-paths.js'
import { isEnoent } from '../../utils/errors.js'
import { parseBgNotifyDetails, SUBAGENT_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
import { parseEngineHandle } from '@zhushanwen/subagent-core'
import { normalizeSubagentStatus } from './subagent-status.js'
import type { SubagentRecord, SubagentStatus, BgNotifyRecord } from '@xyz-agent/shared'

/** subagent toolCall 的 arguments 结构（start action） */
interface SubagentStartArgs {
  action: 'start'
  startParam: {
    agent?: string
    slug?: string
    task?: string
    model?: string
    thinkingLevel?: string
    fork?: boolean
    worktree?: boolean
    maxTurns?: number
    graceTurns?: number
    skillPath?: string
    appendSystemPrompt?: string[]
    cwd?: string
  }
}

/** subagent toolResult 的解析结构 */
interface SubagentToolResultData {
  action: string
  subagentId: string | null
  sessionFile: string | null
  bgResponse?: {
    status: string
    message?: string
  }
  listResponse?: {
    running: number
    items: Array<{
      subagentId: string
      agent?: string
      status?: string
      sessionFile?: string
      model?: string
      totalTokens?: number
      duration?: number
      /** L2 关闭原因（仅 status='closed' 的 item 有值，pi-subagent-workflow v4 A-6） */
      closedReason?: string
    }>
  }
}

/** bg-notify 单条记录复用 shared/message.ts 的 BgNotifyRecord（不再本地重复定义） */

/** [legacy] subagent toolCall startParam 的投影字段（按 toolCallId 索引） */
interface LegacySubagentToolCall {
  agent: string
  slug: string
  task: string
}

/** [legacy] listResponse item（background 模式状态更新，按 subagentId 索引） */
type LegacySubagentListItem = NonNullable<NonNullable<SubagentToolResultData['listResponse']>['items']>[number]

/** 自描述 entry 可选字符串字段守卫（typeof string ? 值 : undefined） */
function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** 自描述 entry 可选数值字段守卫（typeof number ? 值 : undefined） */
function optNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

/** 自描述 entry 可选布尔字段守卫（typeof boolean ? 值 : undefined） */
function optBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/**
 * origin 字面量守卫（H2 R3-1 修复：自描述投影透传 origin，renderer 侧栏计数 / 后台工作
 * 指示 / 列表桶按 `origin === 'workflow'` 负向过滤）。守卫语义对齐 core record-store.ts
 * readEntryOriginFields：仅认 'tool' | 'workflow' 字面量，非法值/缺省 → undefined =
 * "tool" 语义（存量 record 零迁移）。
 */
function projectOrigin(v: unknown): 'tool' | 'workflow' | undefined {
  return v === 'workflow' || v === 'tool' ? v : undefined
}

/** plain object 判定（LLM 可控的 JSON.parse 产物 shape 守卫用） */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * entry data.engineFallback → shared engineFallback（U1）。坏形状（非 plain object /
 * from/reason 非 string）不投影该字段——防御降级不抛，消费端按无 fallback 处理。
 */
function projectEngineFallback(v: unknown): { from: string; reason: string } | undefined {
  if (!isPlainRecord(v)) return undefined
  const from = optString(v.from)
  const reason = optString(v.reason)
  return from !== undefined && reason !== undefined ? { from, reason } : undefined
}

/**
 * entry data.engineHandle → shared engineHandle（U1）。守卫已收敛到 core 单一实现
 * parseEngineHandle（dual-track-convergence D1 双守卫收敛：此前本文件的
 * projectEngineHandle 与 subagent-engine-history 的 extractRecordEngineHandle 两份
 * guard 各自演进，收敛取本侧的严格语义——sessionRef 含非 string 值整体拒绝）：
 * - poolKey 缺失/非 string/空串 → 整个字段不投影（定位符不完整，读侧降级 outcome-only）
 * - sessionRef 非 plain object 或含非 string 值 → 整个字段不投影；键不枚举整体透传
 * - journalPath optString（可选）
 */

/** JSONL 中的 message entry 结构（简化） */
interface JsonlMessageEntry {
  type: string
  id?: string
  message?: {
    role?: string
    content?: unknown
    toolCallId?: string
    toolName?: string
  }
}

/** JSONL 中的 custom / custom_message entry 结构 */
interface JsonlCustomEntry {
  type: string
  customType?: string
  data?: unknown
  details?: unknown
  timestamp?: string
}

/**
 * [W18] entry 扫描器：从 entry 列表派生 SubagentRecord[]。
 *
 * 实时（session-service 增量拉取）与冷启动（getSubagents 磁盘全量）唯一共用派生函数：
 * 1. 先扫自描述 `subagent-record` entry（W16 v1 完整快照，同 id 后到覆盖——extension 在
 *    状态迁移点 append，后者更新）；命中（≥1 条有效）直接返回自描述派生列表。
 * 2. 无命中（W16 前创建的旧 session）→ legacy 解析兜底（toolCall/toolResult/bg-notify
 *    配对重建，数据滞后但可用）。
 *
 * entries 来源两种形态同构（pi SessionEntry 内存对象与 JSONL 行反序列化），type 判定
 * 'custom'（pi appendCustomEntry；workflow-extractor 实测注释同源）。
 */
export function scanSubagentEntries(entries: unknown[]): SubagentRecord[] {
  const selfDescribed = collectSelfDescribedSubagentRecords(entries)
  if (selfDescribed !== null) return selfDescribed
  return extractSubagentsFromEntriesLegacy(entries)
}

/**
 * 收集自描述 subagent-record entry（W16 v1）。
 *
 * data schema = extensions/universal/subagent-workflow/src/execution/record-entry.ts 的
 * SubagentRecordEntryData（v1；跨包依赖方向不允许 import extensions/ 源码，此处按
 * 防御式逐字段守卫消费——runtime 只取 shared SubagentRecord 投影需要的字段，
 * eventLog/displayItems 等扩展内部字段不进 runtime 契约）。
 *
 * @returns null = 无有效命中（走 legacy 兜底）；SubagentRecord[] = 命中（同 id 后到覆盖）。
 * 版本不认识的 entry 跳过并 warn（可观测，对齐 workflow-extractor R4 版本漂移语义）；
 * 全部无效视同无命中。
 */
function collectSelfDescribedSubagentRecords(entries: unknown[]): SubagentRecord[] | null {
  const records = new Map<string, SubagentRecord>()
  for (const entry of entries) {
    const record = parseSelfDescribedSubagentRecord(entry)
    if (record) records.set(record.subagentId, record)
  }
  return records.size > 0 ? Array.from(records.values()) : null
}

/**
 * 单条 entry → SubagentRecord（type/customType/data/版本/必填字段逐层守卫，坏 entry 返回
 * null）。同 id 后到覆盖（entry 顺序 = 时间顺序，extension 在状态迁移点 append，后者更新）。
 * 版本不认识的 entry warn（可观测，对齐 workflow-extractor R4 版本漂移语义）。
 */
function parseSelfDescribedSubagentRecord(entry: unknown): SubagentRecord | null {
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as JsonlCustomEntry
  if (e.type !== 'custom' || e.customType !== SUBAGENT_RECORD_CUSTOM_TYPE) return null
  const data = e.data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.v !== 1) {
    console.warn(
      `[subagent-extractor] subagent-record entry schema version '${String(d.v)}' unsupported (expected 1) — ` +
        `extension/runtime version skew, skip this entry. Fix: align schema with ` +
        `extensions/universal/subagent-workflow/src/execution/record-entry.ts (W16 v1).`,
    )
    return null
  }
  return projectSelfDescribedSubagentRecord(d)
}

/**
 * elapsedSeconds 派生：entry 无 duration 字段（extension 快照不含），从 startedAt/
 * endedAt 差值派生（与 legacy 的 listResponse.duration 同语义，秒）。
 */
function deriveElapsedSeconds(startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  return startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
    // eslint-disable-next-line no-magic-numbers -- 1000 = ms→s 换算常数，无语义歧义
    ? Math.round((endedAt - startedAt) / 1000)
    : undefined
}

/**
 * U1 engine 三字段条件投影：投影层只透传（engine 非空才投影），缺省=pi 由读侧
 * extractRecordEngine 映射（不在此填默认值）；engineFallback 坏形状字段级降级不抛
 * （undefined 不进字段）；engineHandle 守卫 = core parseEngineHandle 单一实现。
 */
function projectEngineSpreadFields(
  d: Record<string, unknown>,
): Pick<SubagentRecord, 'engine' | 'engineFallback' | 'engineHandle'> {
  const engineRaw = optString(d.engine)
  const engine = engineRaw !== undefined && engineRaw.length > 0 ? engineRaw : undefined
  const engineFallback = projectEngineFallback(d.engineFallback)
  const engineHandle = parseEngineHandle(d.engineHandle)
  return {
    ...(engine !== undefined ? { engine } : {}),
    ...(engineFallback !== undefined ? { engineFallback } : {}),
    ...(engineHandle !== undefined ? { engineHandle } : {}),
  }
}

/**
 * 已守卫版本的 entry data → SubagentRecord 投影（必填 id/status 守卫 + 可选字段逐个 typeof
 * 守卫缺省，与 legacy 路径同构）。runtime 只取 shared SubagentRecord 投影需要的字段
 * （eventLog/displayItems 等扩展内部字段不进 runtime 契约）；缺必填字段视为坏 entry 返回 null。
 */
function projectSelfDescribedSubagentRecord(d: Record<string, unknown>): SubagentRecord | null {
  if (typeof d.id !== 'string' || typeof d.status !== 'string') return null
  const status = normalizeSubagentStatus(d.status)
  const startedAt = optNumber(d.startedAt)
  const endedAt = optNumber(d.endedAt)
  return {
    subagentId: d.id,
    sessionFile: optString(d.sessionFile) ?? null,
    agent: optString(d.agent) ?? 'general-purpose',
    slug: optString(d.slug) ?? '',
    task: optString(d.task) ?? '',
    status,
    // closedReason 仅 closed 终态投影（与 legacy 路径同构，防 running + closedReason 脏组合）
    closedReason: status === 'closed' ? optString(d.closedReason) : undefined,
    turns: optNumber(d.turns),
    totalTokens: optNumber(d.totalTokens),
    model: optString(d.model),
    thinkingLevel: optString(d.thinkingLevel),
    startedAt,
    endedAt,
    elapsedSeconds: deriveElapsedSeconds(startedAt, endedAt),
    error: optString(d.error),
    // 轮终结果文本（running-resumable 轮终信号）：entry v1 的轮终迁移写点
    // （reportRecordTransition ← finalize-round 的 doFinalizeRoundToIdle /
    // onRoundSettled）恒写非空——renderer hasRunning 据此排除轮终 running（review #8）。
    result: optString(d.result),
    // 执行态细分判据（residual-fixes）：chatMode 显式值（register 起写入；缺省 = v1 前
    // 存量 entry，消费端按保守方向处理）；resumable = 无活进程驱动的 running。
    chatMode: optBoolean(d.chatMode),
    resumable: optBoolean(d.resumable),
    // record 来源身份（H2 R3-1 修复）：'tool' | 'workflow' 字面量透传（缺省 undefined =
    // tool 语义）。此前投影白名单漏此字段 → renderer 过滤面 origin 恒 undefined，
    // workflow record 运行期虚亮 badge / 绑架 hasRunning / 混入 GUI 列表。
    origin: projectOrigin(d.origin),
    ...projectEngineSpreadFields(d),
  }
}

/**
 * 从主 session JSONL 文件提取 SubagentRecord[]（冷启动 / getSubagents RPC 路径）。
 *
 * 读取文件 → parseJsonl → scanSubagentEntries（与实时增量拉取同一份派生代码）。
 *
 * 读失败分级（renderer 侧栏 stale 守卫的契约前提）：
 * - 文件不存在（ENOENT）→ 返回空数组（合法边界：pi session 文件延迟写入，首条 assistant
 *   前 file 可能不存在——文件都没有必然无 subagent）。
 * - 其他读错误（EACCES / EISDIR 等）→ 原样上抛（RPC 报错，renderer catch 保留旧分区并
 *   显示重试态；降级 [] 会让 renderer 的空结果守卫把「读失败」与「真实删空」混淆）。
 * 文件存在但无 subagent 调用时返回空数组（真实删空语义）。
 */
export function extractSubagentsFromSessionFile(filePath: string): SubagentRecord[] {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }

  const entries = parseJsonl(content)
  return scanSubagentEntries(entries)
}

/**
 * [legacy] 旧双管线的磁盘解析逻辑（W18 前的 extractSubagentsFromSessionFile 主体）。
 *
 * 降级兜底：仅当 session 无自描述 subagent-record entry（W16 改造前创建）时被
 * scanSubagentEntries 调用。W16 前创建的存量 session 由此路径继续可见（不静默丢失）。
 */
function extractSubagentsFromEntriesLegacy(entries: unknown[]): SubagentRecord[] {
  // 提取主 session 的 cwd（首行 session entry），用于推导 subagent session 目录
  const mainCwd = findLegacyMainCwd(entries)

  // 收集 subagent toolCall（按 toolCallId 索引）
  const toolCalls = new Map<string, LegacySubagentToolCall>()
  // 收集 subagent toolResult（按 toolCallId 索引）
  const toolResults = new Map<string, SubagentToolResultData>()
  // 收集 bg-notify（按 subagentId 索引）。复用 shared 的 BgNotifyRecord 类型，
  // 解析逻辑统一走 parseBgNotifyDetails（正确处理 single + batch 两种形态）。
  const bgNotifies = new Map<string, BgNotifyRecord>()
  // 收集 list response 中的 items（background 模式状态更新）
  const listItems = new Map<string, LegacySubagentListItem>()

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as JsonlMessageEntry & JsonlCustomEntry

    // 处理 message entry（assistant toolCall + toolResult 解析）
    if (e.type === 'message' && e.message) {
      collectLegacyMessageEntry(e.message, toolCalls, toolResults)
    }

    // 处理 custom_message entry：找 subagent-bg-notify
    // 用 parseBgNotifyDetails 统一解析 single + batch 两种形态（pi notifier 滑动窗口 60s 合并），
    // 避免 batch 形态 {batch:true, items:[...]} 时 details.id 为 undefined 整批被丢弃。
    if (e.type === 'custom_message' && e.customType === 'subagent-bg-notify') {
      collectLegacyBgNotifies(e.details, bgNotifies)
    }
  }

  // 合并 toolResult 中的 listResponse items
  collectLegacyListItems(toolResults, listItems)

  // 构造 SubagentRecord[]（toolCall × toolResult 配对）
  return buildLegacySubagentRecords(toolCalls, toolResults, listItems, bgNotifies, mainCwd)
}

/** [legacy] 主 session 的 cwd 提取（首条 session entry，用于推导 subagent session 目录） */
function findLegacyMainCwd(entries: unknown[]): string | null {
  const sessionEntry = entries.find(
    (e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null && (e as { type?: string }).type === 'session',
  )
  return typeof sessionEntry?.cwd === 'string' ? sessionEntry.cwd : null
}

/** [legacy] message entry 分流：assistant 的 subagent toolCall 收集 + toolResult 解析 */
function collectLegacyMessageEntry(
  msg: NonNullable<JsonlMessageEntry['message']>,
  toolCalls: Map<string, LegacySubagentToolCall>,
  toolResults: Map<string, SubagentToolResultData>,
): void {
  const role = msg.role
  const content = msg.content

  // assistant message：找 subagent toolCall
  if (role === 'assistant' && Array.isArray(content)) {
    collectLegacyToolCalls(content, toolCalls)
  }

  // toolResult message：找 subagent toolResult
  if (role === 'toolResult' && msg.toolName === 'subagent' && msg.toolCallId) {
    const parsed = parseLegacyToolResultContent(msg.content)
    if (parsed) toolResults.set(msg.toolCallId, parsed)
  }
}

/** [legacy] assistant content blocks 中的 subagent start toolCall 收集（按 toolCallId 索引） */
function collectLegacyToolCalls(content: unknown[], toolCalls: Map<string, LegacySubagentToolCall>): void {
  for (const block of content) {
    const call = parseLegacyToolCallBlock(block)
    if (call) toolCalls.set(call.id, call.info)
  }
}

/**
 * [legacy] 单个 content block → subagent start toolCall（非命中返回 null）。
 * agent 兜底对齐 pi-subagent-workflow DEFAULT_AGENT_NAME。LLM 没传 agent 时 pi 实际启动的就是
 * general-purpose，不是"未知"。真实值会在 record 合并时被 notify.agent 覆盖（见 agent 优先级链）。
 */
function parseLegacyToolCallBlock(block: unknown): { id: string; info: LegacySubagentToolCall } | null {
  if (typeof block !== 'object' || block === null) return null
  const b = block as { type?: string; name?: string; id?: string; arguments?: unknown }
  if (b.type !== 'toolCall' || b.name !== 'subagent' || !b.id || typeof b.arguments !== 'object') return null
  // arguments 是 LLM 生成的 toolCall 参数（不可信源）——逐字段 shape 守卫后投影
  // （type-safety review：对齐自描述路径守卫风格，畸形字段缺省走下游 ?? 兜底）
  const args = projectSubagentStartArgs(b.arguments)
  if (!args) return null
  return {
    id: b.id,
    info: {
      agent: args.startParam.agent ?? 'general-purpose',
      slug: args.startParam.slug ?? '',
      task: args.startParam.task ?? '',
    },
  }
}

/**
 * [legacy] LLM 生成的 subagent toolCall arguments → 受控形状投影。
 * action 非 'start' 或 startParam 非 plain object 时返回 null（坏 block 跳过）；
 * startParam 内字段逐个 typeof 收窄（畸形值 undefined，下游 ?? 兜底）。
 */
function projectSubagentStartArgs(raw: unknown): SubagentStartArgs | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.action !== 'start') return null
  if (typeof r.startParam !== 'object' || r.startParam === null || Array.isArray(r.startParam)) return null
  const p = r.startParam as Record<string, unknown>
  return {
    action: 'start',
    startParam: {
      agent: optString(p.agent),
      slug: optString(p.slug),
      task: optString(p.task),
    },
  }
}

/**
 * [legacy] toolResult message content → 解析结果（首个 text block 的 JSON）。
 * 无 text block / 非合法 JSON（如错误消息 "startParam is required"）返回 null 跳过该条。
 * parse 产物经 projectLegacyToolResultData 逐字段 shape 守卫（LLM toolResult 文本不可信）。
 */
function parseLegacyToolResultContent(content: unknown): SubagentToolResultData | null {
  if (!Array.isArray(content) || content.length === 0) return null
  const firstBlock = content[0] as { type?: string; text?: string }
  if (firstBlock?.type !== 'text' || typeof firstBlock.text !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(firstBlock.text)
  } catch {
    return null
  }
  return projectLegacyToolResultData(parsed)
}

/**
 * [legacy] toolResult 文本 JSON.parse 产物 → 受控形状投影。
 *
 * parse 成功≠形状正确（任意合法 JSON 值——string/number/array 都能 parse 成功），原实现
 * 裸断言会让畸形值透传：`sessionFile: number` 直达 SubagentRecord.sessionFile，下游
 * readFileSync 对非 string 会 throw。此处逐字段 typeof 收窄：非 plain object 整条丢弃
 * （返回 null）；出参 string 字段畸形归 null/''；listResponse items 元素级投影。
 */
function projectLegacyToolResultData(parsed: unknown): SubagentToolResultData | null {
  if (!isPlainRecord(parsed)) return null
  const bg = isPlainRecord(parsed.bgResponse)
    ? {
      status: optString(parsed.bgResponse.status) ?? '',
      ...(optString(parsed.bgResponse.message) !== undefined
        ? { message: optString(parsed.bgResponse.message) }
        : {}),
    }
    : undefined
  let listResponse: SubagentToolResultData['listResponse']
  if (isPlainRecord(parsed.listResponse)) {
    const list = parsed.listResponse
    const items = Array.isArray(list.items)
      ? list.items
        .filter(isPlainRecord)
        .map((item) => ({
          subagentId: optString(item.subagentId) ?? '',
          agent: optString(item.agent),
          status: optString(item.status),
          sessionFile: optString(item.sessionFile),
          model: optString(item.model),
          totalTokens: optNumber(item.totalTokens),
          duration: optNumber(item.duration),
          closedReason: optString(item.closedReason),
        }))
      : []
    listResponse = { running: optNumber(list.running) ?? 0, items }
  }
  return {
    action: optString(parsed.action) ?? '',
    subagentId: optString(parsed.subagentId) ?? null,
    sessionFile: optString(parsed.sessionFile) ?? null,
    ...(bg !== undefined ? { bgResponse: bg } : {}),
    ...(listResponse !== undefined ? { listResponse } : {}),
  }
}

/**
 * [legacy] subagent-bg-notify 收集（按 subagentId 索引）。
 * 同 id 后到的覆盖先到的（理论上同一 subagent 只 notify 一次）。
 */
function collectLegacyBgNotifies(details: unknown, bgNotifies: Map<string, BgNotifyRecord>): void {
  const parsed = parseBgNotifyDetails(details)
  if (!parsed) return
  const records: BgNotifyRecord[] = 'batch' in parsed ? parsed.items : [parsed]
  for (const record of records) {
    bgNotifies.set(record.id, record)
  }
}

/** [legacy] toolResult 的 listResponse items 合并（按 subagentId 索引，同 id 后到覆盖） */
function collectLegacyListItems(
  toolResults: Map<string, SubagentToolResultData>,
  listItems: Map<string, LegacySubagentListItem>,
): void {
  for (const tr of toolResults.values()) {
    const items = tr.listResponse?.items
    if (!items) continue
    for (const item of items) {
      if (item.subagentId) listItems.set(item.subagentId, item)
    }
  }
}

/**
 * [legacy] toolCall × toolResult 配对构造 SubagentRecord[]。
 * 仅 background 模式（pi-subagent-workflow 只有 background）——有 bgResponse 的配对才产出
 * 记录；同 subagentId 去重（首个配对胜出）。
 */
function buildLegacySubagentRecords(
  toolCalls: Map<string, LegacySubagentToolCall>,
  toolResults: Map<string, SubagentToolResultData>,
  listItems: Map<string, LegacySubagentListItem>,
  bgNotifies: Map<string, BgNotifyRecord>,
  mainCwd: string | null,
): SubagentRecord[] {
  const records: SubagentRecord[] = []
  const seenIds = new Set<string>()
  for (const [toolCallId, tc] of toolCalls) {
    const tr = toolResults.get(toolCallId)
    if (!tr?.bgResponse) continue
    const subagentId = tr.subagentId ?? 'unknown'
    if (seenIds.has(subagentId)) continue
    seenIds.add(subagentId)
    // 从 listResponse items 或 bg-notify 更新状态
    records.push(
      buildLegacySubagentRecord(subagentId, tc, tr, listItems.get(subagentId), bgNotifies.get(subagentId), mainCwd),
    )
  }
  return records
}

/** [legacy] 单条 background subagent → SubagentRecord（notify/listItem 双源回退链） */
function buildLegacySubagentRecord(
  subagentId: string,
  tc: LegacySubagentToolCall,
  tr: SubagentToolResultData,
  listItem: LegacySubagentListItem | undefined,
  notify: BgNotifyRecord | undefined,
  mainCwd: string | null,
): SubagentRecord {
  const status = resolveLegacySubagentStatus(notify, listItem)
  return {
    subagentId,
    // sessionFile 回退查找：listResponse/bg-notify 都不带 sessionFile 时，
    // 扫描 subagent session 目录用 startedAt 时间戳匹配最近的 JSONL 文件。
    sessionFile: resolveLegacySessionFile(listItem, tr, notify, mainCwd),
    // agent 优先级：bg-notify（pi 执行期真实值）> listResponse item > toolCall startParam（LLM 传的，兜底 general-purpose）
    agent: notify?.agent ?? listItem?.agent ?? tc.agent,
    slug: tc.slug,
    task: tc.task,
    status,
    model: notify?.model ?? listItem?.model,
    totalTokens: listItem?.totalTokens,
    elapsedSeconds: listItem?.duration,
    startedAt: notify?.startedAt,
    endedAt: notify?.endedAt,
    error: notify?.error,
    closedReason: resolveLegacyClosedReason(status, notify, listItem),
  }
}

/**
 * [legacy] status 归一：v4 起 notify.status 是两态枚举（running/closed，详见头部契约注释），
 * legacy 值 done/failed/cancelled 仅为历史 session 数据保留；走 normalizeSubagentStatus 统一
 * 兼容上游变体（completed/error/crashed 等）。notify 缺失时回落 listItem.status（[review 修复]
 * 删除原 `?? normalizeSubagentStatus(tr.bgResponse.status)` 右支——normalizeSubagentStatus 恒
 * 返回非空（falsy 输入回 'running'），?? 右支永不可达）。
 */
function resolveLegacySubagentStatus(
  notify: BgNotifyRecord | undefined,
  listItem: LegacySubagentListItem | undefined,
): SubagentStatus {
  return notify
    ? normalizeSubagentStatus(notify.status)
    : normalizeSubagentStatus(listItem?.status)
}

/**
 * [legacy] L2 关闭原因（v4 B-1）：bg-notify 与 list item 都可能携带，notify 优先（终态时点更晚）。
 * 仅 status === 'closed' 时投影，与实时路径（event-interpreter handleSubagentBgNotify）同构——
 * 最后一条 notify 为 running（轮次完成通知）时不从 listItem 兜底 closedReason，消除
 * running + closedReason 脏组合。
 */
function resolveLegacyClosedReason(
  status: SubagentStatus,
  notify: BgNotifyRecord | undefined,
  listItem: LegacySubagentListItem | undefined,
): string | undefined {
  return status === 'closed' ? (notify?.closedReason ?? listItem?.closedReason) : undefined
}

/** [legacy] sessionFile 三级回退：listItem → toolResult → startedAt 时间戳匹配目录扫描 */
function resolveLegacySessionFile(
  listItem: LegacySubagentListItem | undefined,
  tr: SubagentToolResultData,
  notify: BgNotifyRecord | undefined,
  mainCwd: string | null,
): string | null {
  let resolvedSessionFile = listItem?.sessionFile ?? tr.sessionFile ?? null
  if (!resolvedSessionFile && mainCwd) {
    resolvedSessionFile = findSubagentSessionFile(mainCwd, notify?.startedAt)
  }
  return resolvedSessionFile
}

/**
 * 时间戳匹配窗口（ms）。subagent JSONL 文件名含 ISO 时间戳，
 * 与 bg-notify.startedAt 的差值在此窗口内视为匹配。
 */
const TIMESTAMP_WINDOW_MS = 60_000

/**
 * 在 subagent session 目录中查找最匹配的 JSONL 文件。
 *
 * 当 background subagent 的 sessionFile 丢失（bg-notify 不带、无 listResponse）时，
 * 用 startedAt 时间戳匹配文件名中 ISO 时间戳最近的 .jsonl 文件。
 *
 * @param mainCwd 主 session 的 cwd（用于推导 subagent session 目录）
 * @param startedAt bg-notify 的 startedAt 时间戳（ms）。缺失时返回最近的文件。
 */
function findSubagentSessionFile(mainCwd: string, startedAt: number | undefined): string | null {
  const listing = listSubagentJsonlFiles(mainCwd)
  if (!listing) return null

  // 无 startedAt → 返回最近修改的文件
  if (startedAt === undefined) {
    return findLatestSubagentFile(listing.dir, listing.files)
  }

  // 有 startedAt → 匹配文件名 ISO 时间戳最近的文件
  return findTimestampMatchedSubagentFile(listing.dir, listing.files, startedAt)
}

/**
 * 列出 subagent session 目录下的候选 JSONL 文件（目录解析 + 存在性 + 列目录三步，任一失败
 * 返回 null）。fs 调用时序保持原样：getSubagentSessionDir → existsSync → readdirSync → filter。
 */
function listSubagentJsonlFiles(mainCwd: string): { dir: string; files: string[] } | null {
  let dir: string
  try {
    dir = getSubagentSessionDir(mainCwd)
  } catch {
    return null
  }
  if (!existsSync(dir)) return null

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.endsWith('.finalized'))
  } catch {
    return null
  }
  if (files.length === 0) return null

  return { dir, files }
}

/** 无 startedAt 兜底：返回最近修改（mtime 最大）的文件；全部 stat 失败返回 null。 */
function findLatestSubagentFile(dir: string, files: string[]): string | null {
  let latest: { file: string; mtime: number } | null = null
  for (const f of files) {
    try {
      const mtime = statSync(join(dir, f)).mtimeMs
      if (!latest || mtime > latest.mtime) latest = { file: f, mtime }
    // eslint-disable-next-line taste/no-silent-catch -- stat 失败（文件被并发删除等），跳过该文件
    } catch { /* skip unreadable file */ }
  }
  return latest ? join(dir, latest.file) : null
}

/** 有 startedAt：匹配文件名 ISO 时间戳最近且在 TIMESTAMP_WINDOW_MS 窗口内的文件。 */
function findTimestampMatchedSubagentFile(dir: string, files: string[], startedAt: number): string | null {
  const targetTime = startedAt
  let best: { file: string; diff: number } | null = null
  for (const f of files) {
    const fileTime = parseIsoFromFilename(f)
    if (fileTime === null) continue
    const diff = Math.abs(fileTime - targetTime)
    if (!best || diff < best.diff) best = { file: f, diff }
  }

  // 在窗口内才算匹配
  if (best && best.diff <= TIMESTAMP_WINDOW_MS) {
    return join(dir, best.file)
  }
  return null
}

/**
 * 从 subagent JSONL 文件名解析 ISO 时间戳为 ms。
 * 文件名格式：2026-07-12T17-09-01-293Z_<uuid>.jsonl
 */
function parseIsoFromFilename(filename: string): number | null {
  // 取 .jsonl 前的部分，按 _ 分割取第一段（ISO 时间戳部分）
  const tsPart = basename(filename, '.jsonl').split('_')[0]
  // 文件名的 ISO 时间戳用 - 替代了 :（文件系统安全），还原
  // 2026-07-12T17-09-01-293Z → 2026-07-12T17:09:01.293Z
  const match = tsPart.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/)
  if (!match) return null
  const [, y, mo, d, h, mi, s, ms] = match
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`
  const time = Date.parse(iso)
  return Number.isNaN(time) ? null : time
}

// 状态归一化已下沉至 ./subagent-status.ts 的 normalizeSubagentStatus（runtime 实时路径与磁盘路径共用，
// 避免两份手写实现漂移）。历史 bug：event-interpreter 的三元缺 completed/crashed 归一。
