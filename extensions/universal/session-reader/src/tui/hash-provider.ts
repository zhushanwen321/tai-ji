import type { AutocompleteProvider, AutocompleteItem } from '@earendil-works/pi-tui'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'

/**
 * M4 TUI 层：# 引用补全（design §3.3 D-3/D-4 + §1 目标 4 + 附录 P-hash-trigger）。
 *
 * 数据源（2026-08-10 重构）：显示候选复用 pi 的 `SessionManager.listAll(cwdSessionDir)`——
 * 由 pi 维护文件解析、cwd 目录定位、session_info.name 提取、并发读，extension 只做
 * SessionInfo → AutocompleteItem 的 UI 映射。零自写扫描逻辑（一致性 > 品味）。
 *
 * **insertText 方案（完整 uuid）**：insertText = `#` + 完整 sessionId（36 字符 uuid v7）。
 * 完整 uuid 天然全局唯一，findSessions 的 `sessionId.includes(query)` 子串匹配对完整 uuid
 * 零碰撞（完整 uuid 是某 sessionId 的完整子串 = 唯一命中）。无需算唯一前缀、无需全局扫，
 * 一致性零维护（旧 LCP + 全局扫方案已删除）。用户历史 session 里手敲的短片段仍能 find
 *（子串匹配 + 碰撞时 F2 消歧兜底）。
 *
 * 分层：
 * - 纯逻辑（extractHashFragment / formatAge / toCandidate / provideHashCandidates）：
 *   cwdSessionDir 注入，可单测（造真实 session 文件让 listAll 真跑，不 mock）
 * - createHashAutocompleteProvider：pi-tui AutocompleteProvider 接口适配，组装在 index.ts
 *
 * design D-3：# 选中插入完整 uuid（#xxxxxxxx-xxxx-...），不插入名称。
 * design D-4：插入纯文本 # uuid，不展开——工具侧（tool-handler）剥 # 前缀后按子串匹配。
 */

/** # 补全默认返回上限（TUI 弹窗可读上限，design G6）。/session-pick 命令复用同一上限
 * （两入口同一可读上限，2026-09 双常量合一，session-command 不再自持 PICK_LIMIT）。 */
export const DEFAULT_LIMIT = 10
/**
 * description（预览/name）最大字符数。SessionInfo.firstMessage 是首消息全文（可能含
 * `<skill>` 注入全文，上千字符），预截断避免传超大字符串给 pi-tui。100 覆盖到 ~140 列
 * 终端的 description 区（= width − 主列固定32 − prefix2 − safety2）。
 */
const PREVIEW_MAX = 100

// formatAge 时间换算常数（design G4：对齐 /resume formatSessionDate 的单单位语义）
const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAYS_PER_WEEK = 7
const DAYS_PER_MONTH = 30
const DAYS_PER_YEAR = 365
/** formatAge 数字部分补零宽度（design G4：固定等宽 XXu） */
const AGE_NUM_DIGITS = 2

export interface AutocompleteCandidate {
  /** 显示文本（满宽 label）。`${age} ${预览/name}`，如 "01m 看看 pi-session-reader..." */
  label: string
  /** 插入编辑器，如 "#019e6c96-aaaa-bbbb-cccc-dddddddddddd"（design D-3：完整 uuid，非名称；不显示给用户看） */
  insertText: string
}

/**
 * 从光标前文本提取 # 片段。
 *
 * 匹配规则：行内 `#` 后跟 0+ 个十六进制/连字符字符（uuid 片段特征），且 `#` 位于 token
 * 边界（行首或非单词字符之后）——避免 `foo#bar`、`C#` 这类 hashtag/语言符号误触发。
 *
 * @param textBeforeCursor 光标前的当前行文本（provider wrapper 传 currentLine.slice(0, cursorCol)）
 * @returns 片段（不含 `#`，空串表示刚输入 `#`）；非 # 引用 → null（调用方据此委托下家 provider）
 */
export function extractHashFragment(textBeforeCursor: string): string | null {
  const m = textBeforeCursor.match(/#([0-9a-f-]*)$/i)
  if (!m || m.index === undefined) return null
  // # 前必须是 token 边界：行首，或前一个字符非单词字符（空格/标点）
  if (m.index > 0) {
    const prev = textBeforeCursor[m.index - 1]
    if (/\w/.test(prev)) return null
  }
  return m[1]
}

/**
 * modified → 固定等宽的单单位时间（对齐用，design G4）。
 *
 * 格式：`now`（<1分钟）或 `XXu`（2位数字补零 + 1 位单位）。单位 m/h/d/w/M/y 全单字符，
 * 总宽 3 字符严格对齐（月用 `M` 区分分钟的 `m`）。对齐 pi `/resume` 的 formatSessionDate
 * 单单位语义，但补零到 2 位 + 压缩月单位以等宽（用户要求「保留2位数字+一位单位」）。
 */
export function formatAge(modified: Date | number, now: number = Date.now()): string {
  const ms = typeof modified === 'number' ? modified : modified.getTime()
  const diff = now - ms
  if (diff < MS_PER_MINUTE) return 'now'
  const mins = Math.floor(diff / MS_PER_MINUTE)
  if (mins < MINUTES_PER_HOUR) return `${String(mins).padStart(AGE_NUM_DIGITS, '0')}m`
  const hours = Math.floor(diff / MS_PER_HOUR)
  if (hours < HOURS_PER_DAY) return `${String(hours).padStart(AGE_NUM_DIGITS, '0')}h`
  const days = Math.floor(diff / MS_PER_DAY)
  if (days < DAYS_PER_WEEK) return `${String(days).padStart(AGE_NUM_DIGITS, '0')}d`
  if (days < DAYS_PER_MONTH) return `${String(Math.floor(days / DAYS_PER_WEEK)).padStart(AGE_NUM_DIGITS, '0')}w`
  if (days < DAYS_PER_YEAR) return `${String(Math.floor(days / DAYS_PER_MONTH)).padStart(AGE_NUM_DIGITS, '0')}M`
  return `${String(Math.floor(days / DAYS_PER_YEAR)).padStart(AGE_NUM_DIGITS, '0')}y`
}

/** 控制字符/换行 → 单空格（避免 description 带换行破坏 SelectList 单行渲染）。 */
function normalizeSingleLine(s: string | undefined): string {
  if (!s) return ''
  return s.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()
}

/** 按字符数截断（预览用，CJK 宽度边缘情况接受 pi-tui 最终裁剪更保守）。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/**
 * SessionInfo → AutocompleteCandidate（纯函数，可单测）。
 *
 * **绕过 pi-tui 主列固定32死约束的关键**：不设 description。SelectList.renderItem 在
 * description 为 undefined 时走 else 分支，把 label 当整行截到 width-4 满宽，**不应用主列
 * 固定32的分列逻辑**（select-list.js renderItem：`if (descriptionSingleLine && width>40)`
 * 分支才进主列逻辑，否则 label 满宽）。
 *
 * 映射：
 * - label = `${age} ${预览/name}`（如 "01m 看看 pi-session-reader..."）——满宽渲染，
 *   时间最左 + 1 空格 + 预览吃满，无 padding，不显示 uuid，不含 count（用户反馈）。
 * - description = undefined（不设）——触发上述满宽分支。
 * - insertText = `#${s.id}`（design D-3：完整 36 字符 uuid）。完整 uuid 天然全局唯一，
 *   findSessions 子串匹配零碰撞——无需算唯一前缀、无需全局扫。
 *
 * name 优先于 firstMessage（design G3）。不清洗 XML 标签（对齐 /resume）。只清洗控制字符/换行。
 *
 * @param now 计算 age 的基准时间（默认当前）
 */
export function toCandidate(s: SessionInfo, now: number = Date.now()): AutocompleteCandidate {
  const age = formatAge(s.modified, now)
  const text = truncate(normalizeSingleLine(s.name ?? s.firstMessage), PREVIEW_MAX) || '(无预览)'
  return {
    label: `${age} ${text}`,
    insertText: `#${s.id}`,
  }
}

/**
 * 核心逻辑：光标前文本 → # 引用候选（design §3.3 D-3 + 完整 uuid insertText）。
 *
 * **显示候选**：`SessionManager.listAll(cwdSessionDir)`——pi 返回当前 cwd 目录的全部
 * session（含 name/messageCount/firstMessage，已按 modified 倒序），per-cwd，快（~19ms）。
 *
 * **insertText**：始终完整 uuid（`#${s.id}`）。完整 uuid 天然全局唯一，findSessions
 * `sessionId.includes(query)` 子串匹配对完整 uuid 零碰撞。无需区分 fragment 空/非空、
 * 无需全局扫。
 *
 * @param input 光标前的文本（provider wrapper 传 currentLine.slice(0, cursorCol)）
 * @param cwdSessionDir 当前 session 的目录（ctx.sessionManager.getSessionDir()，含 encoded cwd）
 * @param opts.limit 返回上限（默认 10）
 * @returns 非 # 前缀 → null（委托下家 provider）；# 前缀 → 候选数组（无匹配为空数组，不抛）
 */
export async function provideHashCandidates(
  input: string,
  cwdSessionDir: string,
  opts?: { limit?: number },
): Promise<AutocompleteCandidate[] | null> {
  const fragment = extractHashFragment(input)
  if (fragment === null) return null
  // 目录未就绪（session_start 前的异常窗口）→ 返回空，绝不调 listAll('')——
  // pi 的 listAll 对空字符串 falsy 走默认全盘分支（3488 项 / ~8s），会让 # 弹窗卡死
  if (!cwdSessionDir) return []
  const limit = opts?.limit ?? DEFAULT_LIMIT
  const all = await SessionManager.listAll(cwdSessionDir)
  // uuid 片段非空 → id 子串过滤；空片段（刚输入 #）→ recent（listAll 已按 modified 倒序）
  const filtered = fragment === '' ? all : all.filter((s) => s.id.includes(fragment))
  const visible = filtered.slice(0, limit)
  return visible.map((s) => toCandidate(s))
}

/**
 * 创建 # autocomplete provider（实现 pi-tui AutocompleteProvider 接口）。
 *
 * 包装内置 current（CombinedAutocompleteProvider，处理 @ 文件 / / 命令 / 路径）：
 * - 非 # 前缀 → 显式委托 current.getSuggestions（addAutocompleteProvider 是 stack 模式，
 *   组合责任在 factory：return null 不会被 pi 自动 fallback，必须显式调 current）
 * - # 前缀有匹配 → 返回 session 候选
 * - # 前缀无匹配 → return null（不委托 current，避免它把 #xxx 当路径前缀返回文件建议）
 *
 * applyCompletion 把 `#fragment`（光标前已输入的片段）替换为完整 `#uuid`（选中项的完整 uuid）。
 */
export function createHashAutocompleteProvider(
  getCwdSessionDir: () => string,
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    triggerCharacters: ['#'],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      // 用户快速连续输入时，pi abort 上一次请求；早返回避免无谓 IO
      if (options.signal.aborted) return null
      const currentLine = lines[cursorLine] ?? ''
      const textBeforeCursor = currentLine.slice(0, cursorCol)
      const fragment = extractHashFragment(textBeforeCursor)
      // 非 # 前缀：委托内置 provider（@ 文件 / / 命令 / 路径补全）
      if (fragment === null) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options)
      }
      // # 前缀：查 session（getter 动态读当前 session 目录，resume 后自动跟随）
      const candidates = await provideHashCandidates(textBeforeCursor, getCwdSessionDir())
      if (options.signal.aborted) return null
      // provideHashCandidates 返回 null 仅在非 # 前缀（fragment===null），上面已拦截；
      // 此处 null 是 TS 收窄的防御性检查，逻辑上不触发
      if (candidates === null || candidates.length === 0) return null
      const items: AutocompleteItem[] = candidates.map((c) => ({
        value: c.insertText,
        label: c.label,
      }))
      // prefix = 光标前匹配到的整段（# 及片段），applyCompletion 据此定位替换区间
      return { items, prefix: `#${fragment}` }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      // 非 # item = 经本 provider 的 getSuggestions 转发的 current（内置 @ 文件 / / 命令 /
      // 路径）建议——pi-tui 实装（editor 持单一 autocompleteProvider，applyCompletion 直调
      // 最外层包装者，无按 suggestion source 的路由）决定了这些 item 的 apply 也回到本
      // provider，必须显式委托 current（组合责任在 factory，同 getSuggestions 的委托）
      if (!item.value.startsWith('#')) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
      }
      const currentLine = lines[cursorLine] ?? ''
      const before = currentLine.slice(0, cursorCol - prefix.length)
      const after = currentLine.slice(cursorCol)
      // 选中后自动补一个空格，让 #uuid 与后续输入隔开（LLM 解析时 uuid 片段与指令分离，
      // 避免 #uuid查看 连写被整体当作查询串）。仅当光标后已以空白开头时不重复加（行尾也补，
      // 用户选中后直接打字即产生间隔）；光标停在补的空格之后
      const spacer = /^\s/.test(after) ? '' : ' '
      const insert = item.value + spacer
      const newLine = before + insert + after
      const newLines = lines.slice()
      newLines[cursorLine] = newLine
      return { lines: newLines, cursorLine, cursorCol: before.length + insert.length }
    },
  }
}
