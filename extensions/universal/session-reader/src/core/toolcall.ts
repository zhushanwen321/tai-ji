/**
 * toolCall 提取与摘要的共享层（O1 工具概览 + O2/O3 toolResult 类型化摘要 + O4 extract 复用）。
 *
 * 数据源（probe 019e6c96 实测确认）：
 * - 工具调用在 assistant message.content 的 `{type:"toolCall", id, name, arguments}` block（519 个），
 *   message.toolCalls 顶层字段从未存在——v1 render.ts 读 toolCalls 恒返 [] 是 O1 要修的 bug。
 * - arguments 始终是 object（10 工具 100%）；string 形态做 JSON.parse 兜底（失败返 {}），防御历史/异类实现。
 * - toolResult.message 自带 toolName + toolCallId（515/515，全部匹配 toolCall.id），
 *   parser.ts 已 additive 透出这两个字段，O2/O3 据此精确关联取参数。
 */
import type { Entry } from './parser.js'

// ---------------------------------------------------------------------------
// 模块常量（参数摘要的截断宽度 / 换算基数）
// ---------------------------------------------------------------------------

/** bash 命令参数摘要截断字符数。 */
const BASH_CMD_MAX_CHARS = 60
/** subagent task 参数摘要截断字符数。 */
const SUBAGENT_TASK_MAX_CHARS = 40
/** 未知工具 arguments JSON 摘要截断字符数。 */
const ARGS_JSON_MAX_CHARS = 50
/** bytes→KB 换算基数（write content 的 KB 显示）。 */
const BYTES_PER_KB = 1024

/** 单次工具调用信息（从 assistant content 的 toolCall block 提取）。 */
export interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** 截断到 max 字符，超出加省略号（与 render.ts 的 truncate 同口径）。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** 路径最后一段（去尾部斜杠后取 basename）。 */
export function basename(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const idx = clean.lastIndexOf('/')
  return idx >= 0 ? clean.slice(idx + 1) : clean
}

/**
 * 把 toolCall block 的 arguments 归一化为 Record<string, unknown>。
 * - object（非数组、非 null）→ 原样用
 * - string → JSON.parse 兜底（parse 失败或结果非对象 → {}）
 * - 其他（number/boolean/null/undefined/数组）→ {}（实测 0%，纯防御）
 */
function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch (err) {
      // 非法 JSON 字符串 → 空对象兜底（实测 arguments 全为 object，此分支纯防御）；
      // 共享层保持零依赖（无 logger 可用），不留 void err 以外的语句
      void err
    }
  }
  return {}
}

/**
 * 从 entry.message.content 的 `{type:"toolCall"}` block 提取工具调用列表。
 *
 * content 是 unknown 做类型守卫；非数组或无 toolCall block 返 []。
 * 仅纳入 id + name 均为 string 的 block（O2 靠 id 关联 toolResult，O1 靠 name 聚合；
 * 缺 id 的块无法关联，缺 name 无法摘要，跳过——实测 0 缺失）。
 */
export function extractToolCalls(entry: Entry): ToolCallInfo[] {
  const msg = entry.message
  if (msg === undefined) return []
  const content = msg.content
  if (!Array.isArray(content)) return []
  const out: ToolCallInfo[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type !== 'toolCall') continue
    if (typeof b.id !== 'string' || typeof b.name !== 'string') continue
    out.push({ id: b.id, name: b.name, arguments: coerceArgs(b.arguments) })
  }
  return out
}

/** 取 args[k] 为 string，否则 undefined（参数缺失统一入口）。 */
function strArg(args: Record<string, unknown>, k: string): string | undefined {
  const v = args[k]
  return typeof v === 'string' ? v : undefined
}

/** 取 args[k] 为 number，否则 undefined。 */
function numArg(args: Record<string, unknown>, k: string): number | undefined {
  const v = args[k]
  return typeof v === 'number' ? v : undefined
}

// ---------------------------------------------------------------------------
// 各工具参数摘要 formatter（design §3.3 D1 表的表驱动形态，每个 case 体一个函数）
// ---------------------------------------------------------------------------

/** 单工具参数摘要 formatter：输入归一化后的 arguments，输出摘要串（参数缺失时优雅降级）。 */
type ArgsFormatter = (args: Record<string, unknown>) => string

function formatBashArgs(args: Record<string, unknown>): string {
  const cmd = strArg(args, 'command')
  return cmd !== undefined ? `bash: ${truncate(cmd, BASH_CMD_MAX_CHARS)}` : 'bash'
}

function formatReadArgs(args: Record<string, unknown>): string {
  const p = strArg(args, 'path')
  return p !== undefined ? `read: ${basename(p)}` : 'read'
}

function formatEditArgs(args: Record<string, unknown>): string {
  const p = strArg(args, 'path')
  const edits = args.edits
  const blocks = Array.isArray(edits) ? edits.length : undefined
  const head = p !== undefined ? `edit: ${basename(p)}` : 'edit'
  return blocks !== undefined ? `${head} (${blocks} blocks)` : head
}

function formatWriteArgs(args: Record<string, unknown>): string {
  const p = strArg(args, 'path')
  const c = strArg(args, 'content')
  const head = p !== undefined ? `write: ${basename(p)}` : 'write'
  if (c === undefined) return head
  // utf8 字节转 KB 取整；小文件至少 1KB（0KB 无信息量）
  const kb = Math.max(1, Math.round(Buffer.byteLength(c, 'utf8') / BYTES_PER_KB))
  return `${head} (${kb}KB)`
}

function formatSubagentArgs(args: Record<string, unknown>): string {
  const task = strArg(args, 'task')
  return task !== undefined ? `subagent: ${truncate(task, SUBAGENT_TASK_MAX_CHARS)}` : 'subagent'
}

function formatHeadArgs(args: Record<string, unknown>): string {
  const p = strArg(args, 'path')
  // limit 可能是 number 或 string（实测 number，防御 string）
  const lim: number | string | undefined = numArg(args, 'limit') ?? strArg(args, 'limit')
  const head = p !== undefined ? `head: ${basename(p)}` : 'head'
  return lim !== undefined ? `${head} (${lim})` : head
}

function formatTodoArgs(args: Record<string, unknown>): string {
  const action = strArg(args, 'action')
  if (action === undefined) return 'todo'
  // id 可能是 number（todo 列表 id）或 string
  const id = args.id
  const idStr =
    typeof id === 'string' ? id : typeof id === 'number' ? String(id) : undefined
  return idStr !== undefined ? `todo: ${action}(${idStr})` : `todo: ${action}`
}

function formatCwGateArgs(args: Record<string, unknown>): string {
  const phase = args.phase
  return phase !== undefined ? `cw-gate: phase=${String(phase)}` : 'cw-gate'
}

function formatCwInitArgs(args: Record<string, unknown>): string {
  const slug = strArg(args, 'slug')
  return slug !== undefined ? `cw-init: ${slug}` : 'cw-init'
}

/**
 * 未知工具 fallback（原 switch default）：arguments 非空 → name: <json 前50>；
 * 空对象 → 仅 name（{} 无信息量）。
 */
function formatUnknownTool(name: string, args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return name
  try {
    return `${name}: ${truncate(JSON.stringify(args), ARGS_JSON_MAX_CHARS)}`
  } catch {
    return name
  }
}

/**
 * 工具名 → 参数摘要 formatter 表（design §3.3 D1 表；phase-start 无参数维度恒返常量）。
 * 用 Map 而非普通对象：name 是外部输入（pi session JSONL 的 toolName），普通对象查表会
 * 命中 Object.prototype 上的键（如 "constructor"），导致把非函数当 formatter 调用；Map 只查自身键。
 */
const TOOL_SUMMARY_FORMATTERS: ReadonlyMap<string, ArgsFormatter> = new Map([
  ['bash', formatBashArgs],
  ['read', formatReadArgs],
  ['edit', formatEditArgs],
  ['write', formatWriteArgs],
  ['subagent', formatSubagentArgs],
  ['head', formatHeadArgs],
  ['todo', formatTodoArgs],
  ['coding-workflow-gate', formatCwGateArgs],
  ['coding-workflow-init', formatCwInitArgs],
  ['coding-workflow-phase-start', () => 'cw-phase-start'],
])

/**
 * 按工具类型把 ToolCallInfo 映射成参数摘要串（design §3.3 D1 表，表驱动分发）。
 *
 * 参数缺失时优雅降级（只输出工具名或省略对应维度）。未知工具（表落空）走
 * formatUnknownTool：带 arguments JSON 前 50 字；arguments 为空对象时省略 JSON
 * （`{}` 无信息量）。
 *
 * 单位口径：edit 的 blocks 是参数维度（edits 数组长度），write 的 KB 是参数维度（content 字节），
 * 这两者已含参数规模；O2/O3 的 toolResult 摘要在此基础再加结果规模时，bash/read 单独 append
 * 结果行数/KB（见 render.ts 的 formatToolResultSummary），避免与参数规模重复。
 */
export function formatToolCallSummary(tc: ToolCallInfo): string {
  const { name, arguments: args } = tc
  const formatter = TOOL_SUMMARY_FORMATTERS.get(name)
  return formatter !== undefined ? formatter(args) : formatUnknownTool(name, args)
}
