/**
 * session_read 各 action 的输出文本渲染（max-lines 拆分轮从 tool-handler.ts 机械
 * 提取，零行为变更）：错误面 message（ES1/ES2 + zcode 七码 + 开库/查询期错误映射）+
 * content 文本（find/outline/expand/detail/family）+ entry 可读文本 + F2 消歧与
 * find 零匹配的 ToolResult 包装。纯字符串/纯渲染函数，不触 fs（findNoMatch 的
 * roots 由调用方传入）。
 *
 * 导出面：SQLITE_DRIVER_UNSUPPORTED_MARK / ZCODE_DB_MISSING_MARK /
 * zcodeReadErrorMessage（测试契约锚消费方直接 import 本模块）。logger 用同名
 * getLogger('session-reader')——按名缓存单例，与 tool-handler 侧同一实例，
 * warn/error 落同一 appendEntry/文件日志通道。ToolResult 等公共类型留
 * tool-handler 定义，本模块 type import（同 doctor/extract 先例；运行时依赖方向
 * tool-handler → 本模块，无循环）。
 */
import { dirname } from 'node:path'
import { toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'
import {
  SqliteUnreadableError,
  ZcodeSchemaDriftError,
} from '@zhushanwen/zcode-session-source'
import type { Entry } from '@zhushanwen/session-core'
import type { MatchedSession } from './discovery/find.js'
import type { SessionRoot } from './discovery/roots.js'
import type { RecordManifest } from './discovery/subagents.js'
import { formatZcodeDbUnreadable } from './discovery/whitelist.js'
import {
  formatBytesMarker,
  type EntryBrief,
  type OutlineResult,
  type ToolResultSummaryEntry,
} from './core/render.js'
import type { Family } from './core/family.js'
import { SESSION_ID_PREFIX_LEN, rangeLabel } from './handler-utils.js'
import { formatNoMatch } from './no-match.js'
import type { ToolResult } from './tool-handler.js'

// 结构化日志通道（zcodeReadErrorMessage 的降级/TOCTOU warn）：getLogger 按名缓存
// 单例，与 tool-handler 侧调用取同一实例，appendEntry/文件日志行为不变。
const logger = getLogger('session-reader')

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** formatDate 日期段（月/日）补零宽度。 */
const DATE_FIELD_WIDTH = 2

function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(DATE_FIELD_WIDTH, '0')}-${String(
    d.getDate(),
  ).padStart(DATE_FIELD_WIDTH, '0')}`
}

/** shortCwd 保留的目录末段数。 */
const SHORT_CWD_SEGMENTS = 2

/** cwd 取末两段缩短显示（完整 cwd 在 details 里）。 */
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.slice(-SHORT_CWD_SEGMENTS).join('/')
}

/** ES1（SESSION_FILE_GC）：sa-id 恰 1 命中但 sessionFile 不存在（GC/未写入）。含 manifest 元数据 + 👉。 */
export function formatSessionGc(record: RecordManifest): string {
  return (
    `subagent "${record.id}" 的 session 文件不存在（可能已被 GC 或未写入）：\n` +
    `  rootSessionId: ${record.rootSessionId}\n` +
    `  agentName: ${record.agentName ?? '(未记录)'}\n` +
    `  sessionFile: ${record.sessionFile}\n` +
    `👉 改用 session_read { action:"family" } 查该 subagent 的后代，或换一个 completed subagent 重试。`
  )
}

/** ES2（SA_ID_NO_MATCH）：sa-id 无精确匹配（可能仍在运行 / 片段输入）。 */
export function formatSaIdNotFound(saId: string): string {
  return (
    `subagent "${saId}" 无匹配 record（若刚启动，record 可能尚未落盘）。` +
    `\n👉 用 session_read { action:"family" } 查活跃/已完成的 subagent；` +
    `若是片段输入，请用完整 sa- id 或 action:"find" 重试。`
  )
}

// ---------------------------------------------------------------------------
// zcode 错误面（U9，design §3.4 七码 + 👉 逐行；错误码标识入 message 供机器识别，
// 形态对齐 §3.1 失败路径示例 `[zcode_db_path_forbidden] …`）
// ---------------------------------------------------------------------------

/** `zcode_param_invalid`：sess_ 形态 id（无第一梯队直读入口，F14/D6）。 */
export function formatZcodeParamInvalid(id: string): string {
  return (
    `[zcode_param_invalid] "${id}" 是 zcode 会话 id 形态，本工具不接受（第一梯队无 sess-id 直读入口）。` +
    `\n👉 请使用 subagent 完成通知或 /subagents 面板里的 sa- id（形如 sa-xxx），换成完整 sa- id 重试。`
  )
}

/** `zcode_record_not_found`：manifest 缺位/残缺 ∧ entry 兜底未命中（§3.4 第 0 段末）。 */
export function formatZcodeRecordNotFound(): string {
  return (
    `[zcode_record_not_found] 该 subagent 记录不可达（未落盘 / 已被 GC / 或不属于当前会话——兜底只在当前会话内）。` +
    `\n👉 在它被派发的那个会话中读取；或用 session_read { action:"family" } 查其后代与关联；或换一个已完成的 subagent；` +
    `或确认输入为完整 sa- id（形如 \`sa-xxxx\`）后重试。`
  )
}

/** `zcode_anchor_missing`：engine==='zcode' 但锚不完整（旧版本产物 / 部分回填残余）。 */
export function formatZcodeAnchorMissing(saId: string): string {
  return (
    `[zcode_anchor_missing] subagent "${saId}" 的记录缺少 zcode 引擎定位符。` +
    `\n👉 会话可能由旧版本产出；用会话导入对话框导入后读取。`
  )
}

/** `zcode_session_not_found`：锚可解析、库可开、schema 兼容，但库内无该 session 行。 */
export function formatZcodeSessionNotFound(): string {
  return (
    `[zcode_session_not_found] 该 zcode 会话不在库中（已被 zcode GC，或锚已更新到新 session——每轮锚会更新）。` +
    `\n👉 用原 sa-id 重新发起读取；或用 session_read { action:"family" } 查其后代；或换一个已完成的 subagent。`
  )
}

/** `zcode_schema_drift` 的 message（观测版本区分归因，§3.4）。 */
function formatZcodeSchemaDrift(observed: string | undefined): string {
  return (
    `[zcode_schema_drift] zcode 会话库 schema 版本不兼容（observed: ${observed ?? 'unknown'}）。` +
    `\n👉 升级 taiji 到新版本，或用会话导入对话框。`
  )
}

/**
 * bun 驱动探测失败（§3.4 表第 8 行理论态）的 message：宿主既无 bun:sqlite 也无
 * node:sqlite——zcode action 整体降级为本错误面（fail-fast + 日志），pi 链路不受影响。
 * 错误码字面量为实施期命名（设计该行未定码名，形态对齐七码 `[zcode_*]` 惯例）。
 */
function formatZcodeHostUnsupported(detail: string): string {
  return (
    `[zcode_host_unsupported] 宿主运行时既无 bun:sqlite 也无 node:sqlite，zcode 会话读取不可用（理论态）。` +
    `\n👉 无需 agent 动作——升级到 node≥22.13 或使用 bun 宿主即可恢复；pi 会话读取不受影响。` +
    `\n(detail: ${detail})`
  )
}

/**
 * sqlite 驱动探测失败的消息特征（zcode-session-source sqlite-driver.ts 探测失败的
 * 错误消息契约；该包不导出专用错误子类，reader 侧按消息特征单列识别——跨包漂移
 * 由 zcode-routing.test.ts 的源文本契约测试守卫：sqlite-driver 源文不再含本子串即红）。
 * 导出面仅测试消费（契约锚 + 映射测试引用同值，禁测试内硬编码副本）。
 */
export const SQLITE_DRIVER_UNSUPPORTED_MARK = '不支持 node:sqlite'

/**
 * 库文件缺失的消息特征（zcode-session-source sqlite-access.ts `openZcodeSessionDb`
 * 开头 existsSync 失败抛普通 Error「db 文件不存在：<dbPath>」的消息契约锚点）。该包
 * 不导出专用错误子类，reader 侧按消息特征单列识别——落 §3.4 第 4 行
 * `zcode_db_unreadable`（不误标 schema_drift）。生产路径上白名单闸
 * （assertZcodeDbPathAllowed 第 1 段）已先行拦掉绝大多数缺失，此处命中的是两段
 * existsSync 之间的 TOCTOU 理论窗口（闸通过后开库前文件被删）。跨包漂移由
 * zcode-routing.test.ts 的源文本契约测试守卫（SQLITE_DRIVER_UNSUPPORTED_MARK 同范式）。
 * 导出面仅测试消费（契约锚 + 映射测试引用同值，禁测试内硬编码副本）。
 */
export const ZCODE_DB_MISSING_MARK = 'db 文件不存在'

/**
 * 开库/查询期错误 → §3.4 错误面映射（SqliteUnreadableError / schema drift / 驱动探测失败 / 库缺失 / 其余）。
 * 导出面仅测试消费（L4 包装形态的映射契约直测，zcode-routing.test.ts）。
 */
export function zcodeReadErrorMessage(e: unknown, agentDir: string): string {
  if (e instanceof SqliteUnreadableError) {
    // 生产路径上驱动探测错误恒经 recovery L4 包装（recovery.ts：last failure 以字符串
    // 并入本错误 message，mark 随之存活）——instanceof 分支内先按 mark 二次判别，否则
    // host_unsupported 面不可达（恒误映射 db_unreadable，指引动作指向错误恢复路径）。
    if (e.message.includes(SQLITE_DRIVER_UNSUPPORTED_MARK)) {
      logger.warn('zcode sqlite driver unsupported in host runtime', { detail: e.message })
      return formatZcodeHostUnsupported(e.message)
    }
    // attempted 链进 detail 不进指引正文（§3.4 可观测性：attempted 与 message 供日志/排障）
    return formatZcodeDbUnreadable(dirname(agentDir), `(attempted: ${e.attempted.join(' → ')})`)
  }
  if (e instanceof ZcodeSchemaDriftError) {
    return formatZcodeSchemaDrift(e.observedVersion)
  }
  const message = toErrorMessage(e)
  // 驱动探测失败理论态单列（§3.4 第 8 行）：不与 schema 漂移混淆——指引动作不同
  // （环境恢复 vs 升级 taiji）。fail-fast + 结构化日志（理论态触发即留痕）。
  if (message.includes(SQLITE_DRIVER_UNSUPPORTED_MARK)) {
    logger.warn('zcode sqlite driver unsupported in host runtime', { detail: message })
    return formatZcodeHostUnsupported(message)
  }
  // 库文件缺失（openZcodeSessionDb 开头 existsSync 失败的 TOCTOU 窗口，§3.4 第 4 行）
  // 单列：落 db_unreadable（环境恢复指引），不与 schema 漂移混淆——归因与恢复动作不同
  if (message.includes(ZCODE_DB_MISSING_MARK)) {
    logger.warn('zcode session db missing at open (TOCTOU window)', { detail: message })
    return formatZcodeDbUnreadable(dirname(agentDir), `（${message}）`)
  }
  // 其余查询期错误（data 列 JSON 非法等 schema 漂移域——sqlite-access 不静默跳过，
  // 映射权在消费侧）→ schema_drift 语义
  return formatZcodeSchemaDrift(undefined) + `\n(detail: ${message})`
}

/** ES2（SA_ID_AMBIGUOUS）：sa-id 多 manifest 命中（数据异常，record.id 应唯一）。 */
export function formatSaIdAmbiguous(saId: string, records: RecordManifest[]): string {
  return (
    `subagent "${saId}" 匹配 ${records.length} 个 record（数据异常，record.id 应唯一）：\n` +
    records
      .map((r) => `  ${r.id} (root=${r.rootSessionId} file=${r.sessionFile})`)
      .join('\n') +
    `\n👉 用 session_read { action:"family" } 或完整 session uuid 重试。`
  )
}

/** 消歧提示的 uuid 片段长度（比短显略长，引导输入更长片段消歧）。 */
const HINT_ID_PREFIX_LEN = 12

/** F2 多匹配消歧结果（不抛错，返回候选 + 👉）。 */
export function disambiguate(query: string, candidates: MatchedSession[]): ToolResult {
  const lines = candidates.map(
    (m, i) =>
      `  ${i + 1}. ${m.sessionId} · ${formatDate(m.mtime)}${m.firstMessagePreview ? ' · ' + m.firstMessagePreview : ''}`,
  )
  const hint =
    candidates[0] !== undefined
      ? `（如 ${candidates[0].sessionId.slice(0, HINT_ID_PREFIX_LEN)}）`
      : ''
  const text =
    `${candidates.length} 个匹配 "${query}"：\n${lines.join('\n')}\n` +
    `👉 用更长的 uuid 片段${hint}，或 action:"find" 加 cwd 过滤。`
  return { content: [{ type: 'text', text }], details: { ambiguous: true, candidates } }
}

// ---------------------------------------------------------------------------
// 文本渲染（content）
// ---------------------------------------------------------------------------

/**
 * find 分组渲染的单组数据（u10，design 2026-09-10 §6.7 子决策 2）。
 * main 组恒在 groups 首位（置顶），编号跨组连续。
 */
interface FindGroup {
  source: 'main' | 'subagent'
  /** 配额切片后实际展示的候选 */
  shown: MatchedSession[]
  /** 溢出：该组命中数 > shown.length（+1 探测；溢出时精确总数未知，只知更多） */
  overflow: boolean
}

/**
 * find 输出渲染（u10 分组版，design §5.1 形态 + §6.7 子决策 2/3 精确规格）：
 *
 * - 按 source 分组、main 段置顶（subagent 噪声不淹没目标），组头标注各组命中数，
 *   组内编号跨组连续（§5.1 示例：subagent 段从 main 段末尾续号）。
 * - 候选行打印完整 sessionId（废除 8 字符截断——agent 拿到截断 id 无法粘回做精确调用，
 *   §3.2 失败模式 D）。SESSION_ID_PREFIX_LEN 常量本体与 result 通路不动（§6.7 范围声明）。
 * - 每条 main 候选附一行可直接复制执行的 outline 调用串（↳，§6.7 子决策 3）；
 *   subagent 候选不附（噪声不配指针）。
 * - 候选行末段文本：标题优先（u11，name 来自 SessionManager.listAll，§5.1 形态
 *   「… · 福耀玻璃深度研究」），无标题回退首消息预览（现状行为）。
 * - truncated 按**合并总量**（命中总数 vs 实际输出数）计算，由调用方传入，此处只负责标注。
 * - subagent 段超配额折叠为一行展开提示（加 source:"subagent" 查看）；main 段溢出
 *   仅在组头标注（规格的折叠提示只针对 subagent）。
 */
export function formatFindContent(query: string, groups: FindGroup[], truncated: boolean): string {
  const shown = groups.flatMap((g) => g.shown)
  const head = `${shown.length} session(s) matched "${query}"${
    truncated ? ` (truncated, showing first ${shown.length})` : ''
  }`
  const lines: string[] = []
  let index = 0
  for (const g of groups) {
    lines.push('')
    if (g.overflow && g.shown.length === 0) {
      // main 占满配额、subagent 有命中但 0 条展示（§6.7：「subagent 段为 0 条仅显示计数」；
      // 命中总数须全量深读首条 user 才能精确计数，recent 形态下 IO 不可接受，只报有命中）
      lines.push(`${g.source}（有命中未显示——展示配额已被 main 占满）：`)
    } else if (g.overflow) {
      lines.push(`${g.source}（>${g.shown.length} 条命中，显示前 ${g.shown.length} 条）：`)
    } else {
      lines.push(`${g.source}（${g.shown.length} 条命中）：`)
    }
    for (const m of g.shown) {
      index += 1
      const parts = [`${index}. ${m.sessionId}`, formatDate(m.mtime)]
      if (m.cwd) parts.push(shortCwd(m.cwd))
      if (m.name) parts.push(m.name)
      else if (m.firstMessagePreview) parts.push(m.firstMessagePreview)
      lines.push(`  ${parts.join(' · ')}`)
      if (g.source === 'main') {
        lines.push(`     ↳ session_read { action:"outline", session:"${m.sessionId}" }`)
      }
    }
    if (g.overflow && g.source === 'subagent') {
      lines.push('  … 另有 subagent 命中未显示。👉 加 source:"subagent" 查看')
    }
  }
  return `${head}\n${lines.join('\n')}`
}

/**
 * outline 尾段（stats 摘要行 + truncated 提示）。E7/D3 行渲染统一：行主体 = result.lines
 *（renderOutline 返回的渲染行，预算度量与展示同一份），行格式知识只在 core/render.ts 的
 * formatLine 一处，tool-handler 不再重建行格式；本函数只拼 stats 尾段（skippedLines 由
 * doOutline 用 ParseResult 覆盖后再渲染）。doOutline/doExport 同一拼装
 * （`lines.join('\n')` + 本尾段），两 action 输出一致 by construction。
 */
export function formatOutlineTail(r: OutlineResult): string {
  const tail = [
    `${r.stats.totalTurns} turns · ${r.stats.totalEntries} entries · ~${r.tokenEstimate} tokens${
      r.stats.skippedLines > 0 ? ` · ${r.stats.skippedLines} skipped lines` : ''
    }`,
    r.truncated ? `[还有 ${r.truncated} 轮未显示，用 detail 的 turns 参数看指定 turn 范围]` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return tail
}

export function formatExpandText(turn: string, entries: EntryBrief[]): string {
  const lines = entries.map(
    (e) =>
      `  [${e.index}] ${e.type}${e.role ? '/' + e.role : ''} ${e.brief}${
        e.omittedBytes > 0 ? ' ' + formatBytesMarker(e.omittedBytes) : ''
      }`,
  )
  return `${turn}\n${lines.join('\n')}`
}

/** 从 message.content 提取可读文本（text/thinking 块；toolCall 留 name 占位）。 */
function messageReadableText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>
          if (o.type === 'text' && typeof o.text === 'string') return o.text
          if (o.type === 'thinking' && typeof o.thinking === 'string') return `[thinking] ${o.thinking}`
          if (o.type === 'toolCall')
            return `[toolCall: ${typeof o.name === 'string' ? o.name : '?'}]`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * ToolResultSummaryEntry 判别（Entry.type 是宽 string，TS 无法靠 === 判别联合，须显式谓词收窄）。
 */
export function isToolResultSummary(
  e: Entry | ToolResultSummaryEntry,
): e is ToolResultSummaryEntry {
  return e.type === 'toolResultSummary'
}

/**
 * 从 message.content 提取可读文本（text/thinking 块；toolCall 留 name 占位）。
 * v2 O3：接受 Entry | ToolResultSummaryEntry，toolResultSummary 返摘要文本（doExport full 用）。
 */
export function entryReadableText(e: Entry | ToolResultSummaryEntry): string {
  if (isToolResultSummary(e)) {
    return `${e.summary} (共 ${e.totalLines} 行，前 3 行：${e.headLines})`
  }
  const msg = e.message
  if (msg !== undefined) {
    if (msg.role === 'toolResult') return `[toolResult] ${messageReadableText(msg.content)}`
    return messageReadableText(msg.content)
  }
  if (e.type === 'compaction')
    return `[compaction] ${typeof e.summary === 'string' ? e.summary : JSON.stringify(e.summary ?? '')}`
  if (e.type === 'custom') return `[custom:${e.customType ?? '?'}]`
  return `[${e.type}]`
}

export function formatDetailText(
  range: { start: number; end: number },
  entries: Array<Entry | ToolResultSummaryEntry>,
): string {
  const head = `turns ${rangeLabel(range)} · ${entries.length} entries`
  const body = entries
    .map((e) => {
      if (isToolResultSummary(e)) {
        // v2 O3：摘要态渲染（summary + 头 3 行 + 看全文提示）
        return `---\ntoolResultSummary (${e.id.slice(0, SESSION_ID_PREFIX_LEN)})\n${e.summary}\n     │ 共 ${e.totalLines} 行，前 3 行：${e.headLines}\n     │ （+ includeToolResult:true 看全文）`
      }
      const role = e.message ? `/${e.message.role}` : ''
      return `---\n${e.type}${role} (${e.id.slice(0, SESSION_ID_PREFIX_LEN)})\n${entryReadableText(e)}`
    })
    .join('\n')
  return `${head}\n${body}`
}

/**
 * family subagents 行的 task 摘要截断宽度（D2②：LLM 判断「哪个 subagent 分支相关」所需
 * 的信息量，信息密度对齐 find 的 firstMessagePreview；探针 P4 输出量级锚点）。
 */
const FAMILY_TASK_RENDER_LIMIT = 60

/**
 * task → 单行摘要：压平空白（task 原文可含换行，换行会破坏 family 输出的行结构）后截断。
 */
function familyTaskSummary(task: string): string {
  const flat = task.replace(/\s+/g, ' ').trim()
  return flat.length <= FAMILY_TASK_RENDER_LIMIT ? flat : flat.slice(0, FAMILY_TASK_RENDER_LIMIT) + '…'
}

/**
 * subagents 行富字段展示（ext-simplify-04 D2②）：status 终态短标签 + agent 名 + task 摘要。
 * 富字段来自 manifest/identity 组装（SubagentRef，不经 enrichRefs——已删除）；孤儿
 *（cleanedUp）只标 [已清理]，不再展开摘要（已清理即终局，文件 GC 后无深读入口）。
 */
function formatSubagentLine(s: Family['subagents'][number]): string {
  const base = `  ${s.sessionId.slice(0, SESSION_ID_PREFIX_LEN)} root=${s.rootSessionId.slice(0, SESSION_ID_PREFIX_LEN)} slug=${s.slug}`
  if (s.cleanedUp) return `${base} [已清理]`
  const parts: string[] = []
  if (s.status) parts.push(`[${s.status}]`)
  if (s.agentName) parts.push(s.agentName)
  if (s.task) parts.push(`· ${familyTaskSummary(s.task)}`)
  return parts.length > 0 ? `${base} ${parts.join(' ')}` : base
}

export function formatFamilyText(f: Family): string {
  const lines: string[] = []
  lines.push(`root: ${f.root.sessionId} (${formatDate(f.root.mtime)})`)
  if (f.parents.length)
    lines.push(`parents: ${f.parents.map((p) => p.sessionId.slice(0, SESSION_ID_PREFIX_LEN)).join(', ')}`)
  if (f.forks.length)
    lines.push(`forks: ${f.forks.map((p) => p.sessionId.slice(0, SESSION_ID_PREFIX_LEN)).join(', ')}`)
  if (f.subagents.length)
    lines.push(`subagents:\n${f.subagents.map(formatSubagentLine).join('\n')}`)
  if (f.workflows.length)
    lines.push(
      `workflows:\n${f.workflows
        .map((w) => `  ${w.runId} (${w.calls.length} calls)`)
        .join('\n')}`,
    )
  return lines.join('\n')
}

/**
 * find 零匹配：F1 自检行（u9）。计数取本次实扫（无 options 恒实扫——根扫描无缓存，
 * doctor 缓存机已删除，ext-simplify-04 U3），完整信号包保证 [live] 根（最高优先级）
 * 计数可见。
 *
 * E1（ext-simplify-04 §3 D1）：roots 由 doFind 预解析传入——与匹配用同一次实扫
 * （调用方保证无 options），不再独立第三次全量扫盘。
 */
export function findNoMatch(query: string, roots: SessionRoot[]): ToolResult {
  return {
    content: [{ type: 'text', text: formatNoMatch(query, roots) }],
    details: { matches: [], truncated: false },
  }
}
