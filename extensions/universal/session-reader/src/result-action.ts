/**
 * result action（subagent-sync-collect U6：design subagent-sync-collect.md §3.1.3）。
 *
 * 从 tool-handler.ts 机械提取（max-lines 拆分轮）：纯移动零行为变更。纯函数 helper
 *（err/stripHash/requireStr/SESSION_ID_PREFIX_LEN）直接 import 自 handler-utils
 *（ext-simplify-04 E5 收敛：同包 helper 获取范式单一化）；resolveSessionId/disambiguate/
 * safeParse 仍为 tool-handler 文件私有且被其余 9 个 action 共用，不便搬移——经
 * {@link ResultActionDeps} 注入，入口分发处 per-call 构造（resolveSessionId 被信号包
 * liveSessionDir 的包装覆盖）。
 *
 * 设计来源：docs/design/subagent-sync-collect.md §3.1.3 ——
 *   session_read {"action":"result","session":"sa-aaa"}              // 单个
 *   session_read {"action":"result","session":"sa-aaa,sa-bbb,sa-ccc"} // 批量（≤10）
 *   → 每条返回该 subagent session 的最终 assistant 正文（与通知 record.result 同源），
 *     可选 limit 参数（默认 8000 字符/条，超出截断 + 提示读原文件）。
 * 定位复用既有发现机制（sa-xxx manifest 反查 / uuid 片段 / 路径），不新造目录或文件。
 */
import type { Entry, ParseResult } from './core/parser.js'
import { textBlockParts } from './core/render.js'
import type { MatchedSession } from './discovery/find.js'
import { listRecordManifests, type RecordManifest } from './discovery/subagents.js'
import { err, requireStr, SESSION_ID_PREFIX_LEN, stripHash } from './handler-utils.js'
import type { ResolveResult, SessionReadAction, SessionReadParams, ToolResult } from './tool-handler.js'

/** result 批量上限（design subagent-sync-collect §3.1.3：一次最多 10 个）。 */
const RESULT_MAX_BATCH = 10

/** result 单条默认字符上限（design §3.1.3：默认 8000 字符/条）。 */
const RESULT_DEFAULT_LIMIT = 8000

/** result 批量条目分隔符（与 notifier 批通知 "\n\n---\n\n" join 同款）。 */
const RESULT_BATCH_SEPARATOR = '\n\n---\n\n'

/** result action 对 tool-handler 文件私有 helper 的注入面（入口分发处 per-call 构造）。 */
export interface ResultActionDeps {
  resolveSessionId(
    rawSession: string | undefined,
    action: SessionReadAction,
    agentDir: string,
    source?: 'main' | 'subagent',
    /** S3：批量预取的 manifest 列表（避免逐 id 重复全量扫描）；单 id 不传。 */
    prefetchedManifests?: RecordManifest[],
  ): Promise<ResolveResult>
  disambiguate(query: string, candidates: MatchedSession[]): ToolResult
  safeParse(fileName: string): Promise<ParseResult>
}

/**
 * 从 assistant message content 提取纯 text（text 块顺序拼接）。
 *
 * 与 record 侧 text_delta 直累积同构：同一 message 内多个 text 块无分隔拼接
 *（流式 delta 逐段 append），thinking/toolCall 块不入 record.text，此处同样排除。
 *
 * [S7 code-simplify 登记] 本变体经 E11 归一到共享核 textBlockParts（core/render.ts，
 * 块 → string[]），join 语义留在本调用点。包内完整映射（共享核 1 + 特异 3）：
 * - 共享核 textBlockParts：白名单 type==='text' 取 text；本函数（'' join）/
 *   extract.ts extractContentText（'\n' join）/ find.ts extractTextFromContent
 *   （' ' join + 空返 undefined）三个纯 text 变体均为其组合调用
 * - 特异保留 3 个（filter 集不同，不可归一）：tool-handler.ts messageReadableText
 *   （thinking/toolCall 占位）、search-across.ts searchableText（JSON 兜底）、
 *   render.ts extractText（排除法——白名单与排除法在未知 type 块上不等价）
 *
 * 本变体的 '' 无分隔拼接是 A4 取回逐字节一致锁定的硬理由（对齐 record.result 的
 * 流式 delta 无分隔累积），不可与带分隔符的变体合并——差异是行为敏感点，勿「顺手统一」。
 */
function assistantMessageText(content: unknown): string {
  return textBlockParts(content).join('')
}

/**
 * 从 session entries 提取最终结果正文（与完成通知 record.result 同源，A4 逐字节一致的前置）。
 *
 * 同源语义（packages/subagent-core/src/execution/execution-record.ts getFullText，只读参考）：
 * record.result = AgentResult.text = getFullText(record) = 全部 assistant turn 文本
 * filter(非空，空白串按非空) join("\\n\\n")；pi 每 turn_end 对应一条 assistant message
 *（agent-session.js turn_end 携带 message），故文件侧重建 = 每条 assistant message 的
 * text 块顺序拼接 → 跨 message 非空过滤 join("\\n\\n")。
 *
 * 取「最后一条 user message 之后」的 assistant 文本：one-shot（单 user prompt，
 * collect:sync 的目标形态）与 join-all 逐字节一致；多轮 chatMode session 对齐
 * 「最终一轮输出」语义。
 *
 * 导出供单测白盒锁定同源重建规则（message 内 '' join / 跨 message '\n\n' join /
 * thinking 与 toolCall 排除 / 空 text 过滤 / 末 user 边界）。
 */
export function extractFinalAssistantText(entries: Entry[]): string {
  let lastUserIdx = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.message?.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  const texts: string[] = []
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e?.message?.role !== 'assistant') continue
    const text = assistantMessageText(e.message.content)
    if (text.length > 0) texts.push(text)
  }
  return texts.join('\n\n')
}

/** result 单条取回结果（单条 details 与批量 details.items 共用形状）。 */
interface ResultItem {
  /** 调用方原始输入（sa-id / uuid 片段 / 路径） */
  session: string
  /** 反查到的真实 session id（header id，非 sa- 占位） */
  sessionId: string
  /** session .jsonl 绝对路径（截断提示读原文件用） */
  sessionFile: string
  /** 全量正文字符数（截断前口径） */
  totalChars: number
  truncated: boolean
  /** 实际展示正文（截断后含尾提示；未截断时 = 全量正文） */
  text: string
}

/** result 截断尾提示（design §3.1.3：超出截断 + 提示读原文件）。 */
/** result 条目截断提示行。
 *
 * [S8 code-simplify 口径注] 本函数的 X = **保留**字符数（limit）；而 subagent-core
 * notifier.ts buildTruncationPointer 同模板的 X = **丢弃**字符数（total - kept）。
 * 两处措辞同构但口径相反（主 agent 会先后消费两种通知），统一字符串 = 行为变更，
 * 勿顺手改口径——读本行时先确认在消费哪一侧。
 * [C6] 英文去 emoji（对齐 notifier 指针行的纯英文形态，adversarial-review-fixes §3.4）。 */
function formatResultTruncation(
  raw: string,
  sessionFile: string,
  limit: number,
  totalChars: number,
): string {
  return (
    `\n\n[truncated ${limit} of ${totalChars} chars — ` +
    `full text: read ${sessionFile}, or session_read { action:"detail", session:"${raw}" }]`
  )
}

/**
 * result 的 limit 解析：缺省 8000；非有限数/非正数报错（schema 已限 Number，此处防御
 * + 可单测绕过 schema）。向下取整防小数 slice 语义模糊。
 */
function resolveResultLimit(raw: number | undefined): number {
  if (raw === undefined) return RESULT_DEFAULT_LIMIT
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `limit "${String(raw)}" 无效，需为正数。👉 传正整数重试（缺省 ${RESULT_DEFAULT_LIMIT} 字符/条）。`,
    )
  }
  return Math.floor(raw)
}

/**
 * result 的 session 列表解析：单 id 或逗号批量（≤10）。
 * 空条目（如 "sa-a," 或连续逗号）与超限均明确报错（含上限数字与 👉）。
 */
function parseResultSessionList(raw: string | undefined): string[] {
  const trimmed = requireStr(raw, 'session', 'result')
  const ids = trimmed.split(',').map((s) => stripHash(s.trim()))
  if (ids.some((id) => id === '')) {
    throw err(
      `session 列表含空条目："${trimmed}"。👉 检查逗号分隔格式（如 "sa-aaa,sa-bbb"）重试。`,
    )
  }
  if (ids.length > RESULT_MAX_BATCH) {
    throw err(
      `批量取回 ${ids.length} 个 session 超上限：一次最多 ${RESULT_MAX_BATCH} 个。` +
        `\n👉 分批取回（每批 ≤${RESULT_MAX_BATCH} 个 id）。`,
    )
  }
  return ids
}

/**
 * result：取回 subagent session 的最终结果正文（design subagent-sync-collect §3.1.3）。
 *
 * 流程：逐 id 走 resolveSessionId 三形态反查（sa-xxx manifest 精确反查 / uuid 片段 /
 * 绝对路径，multi 走既有 disambiguate）→ safeParse → extractFinalAssistantText
 *（与通知 record.result 同源）→ limit 截断。定位零新机制，不新造目录或文件。
 *
 * content 形态：单 id = 纯正文（无包装，未截断时与 record.result 逐字节一致，A4 取回门）；
 * 批量 = 每条目 `[i/n] <原始id> (session <短id>)` 头行 + 正文，'\\n\\n---\\n\\n' join。
 *
 * 错误路径（明确报错不返空串）：id 无匹配（ES2/F1 风格）、manifest 有但文件不存在
 *（ES1：GC 或 pi session 延迟写入尚未 flush）、无 assistant 输出（运行中/未写正文）、
 * 批量超限 / 空条目 / limit 非法。
 */
export async function doResult(
  params: SessionReadParams,
  agentDir: string,
  deps: ResultActionDeps,
): Promise<ToolResult> {
  const ids = parseResultSessionList(params.session)
  const limit = resolveResultLimit(params.limit)
  // S3（code-simplify）：sa- 形态走 manifest 反查，逐 id 调用会重复全量扫 subagents/ 树
  //（N+1）——批量入口预取一次注入。uuid 片段/路径形态不经 manifest，不预取。
  const prefetchedManifests = ids.some((id) => id.startsWith('sa-'))
    ? await listRecordManifests(agentDir)
    : undefined
  const items: ResultItem[] = []
  for (const id of ids) {
    const resolved = await deps.resolveSessionId(id, 'result', agentDir, params.source, prefetchedManifests)
    if (resolved.kind === 'multi') return deps.disambiguate(resolved.query, resolved.candidates)
    const { entries } = await deps.safeParse(resolved.fileName)
    const text = extractFinalAssistantText(entries)
    if (text.length === 0) {
      throw err(
        `session "${id}" 尚无 assistant 输出（运行中或文件尚未 flush 完整）。` +
          `\n👉 稍后重试，或用 session_read { action:"outline", session:"${id}" } 看当前进度。`,
      )
    }
    const totalChars = text.length
    const truncated = totalChars > limit
    items.push({
      session: id,
      sessionId: resolved.sessionId,
      sessionFile: resolved.fileName,
      totalChars,
      truncated,
      text: truncated
        ? text.slice(0, limit) + formatResultTruncation(id, resolved.fileName, limit, totalChars)
        : text,
    })
  }
  if (items.length === 1) {
    const only = items[0]
    return {
      content: [{ type: 'text', text: only.text }],
      details: { ...only },
    }
  }
  const blocks = items.map(
    (it, i) =>
      `[${i + 1}/${items.length}] ${it.session} (session ${it.sessionId.slice(0, SESSION_ID_PREFIX_LEN)}…)\n${it.text}`,
  )
  return {
    content: [{ type: 'text', text: blocks.join(RESULT_BATCH_SEPARATOR) }],
    details: { count: items.length, items },
  }
}
