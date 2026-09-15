/**
 * tool-handler 共享小工具（max-lines 拆分轮机械提取；ext-simplify-04 E5 扩充，零行为变更）。
 *
 * 从 tool-handler.ts「小工具」与「turn/turns 索引解析」段搬出：pad/err/turn 索引解析
 * 被留守的 tool-handler 与拆出的 search-across.ts / extract.ts 共同消费；
 * err 原属此列，E5 起同包 helper 获取范式单一化——result-action.ts 不再经
 * ResultActionDeps 注入 err/stripHash/requireStr/SESSION_ID_PREFIX_LEN，与本模块
 * 其他消费者一样直接 import。formatDate/shortCwd 仅 tool-handler 留守部分使用，不在此列。
 * requireStr 的 action 参数类型经 type import 取自 tool-handler.ts（编译期擦除，
 * 无运行时循环——与域模块对本模块「仅 type import」同一先例）。
 */
import type { SessionReadAction } from './tool-handler.js'

/** turn 索引显示宽度（T013 三位补零）。 */
const TURN_INDEX_WIDTH = 3

/** sessionId 列表行内的短显前缀长度。 */
export const SESSION_ID_PREFIX_LEN = 8

export const pad = (n: number): string => String(n).padStart(TURN_INDEX_WIDTH, '0')

/** 构造带 👉 恢复指引的 Error。契约：handler 直接 throw，execute 不 catch、原样传播给 pi；
 * pi 外层（pi-agent-core agent-loop.js executePreparedToolCall catch，:466-471）统一转
 * isError:true 的 error tool result——返回值上的 isError 字段会被丢弃（错误被标成功）。 */
export function err(message: string): Error {
  return new Error(message)
}

/** 剥 # 前缀（TUI `#e6c96` 引用 → 纯片段，design §3.3 D-3/D-4）。 */
export function stripHash(s: string): string {
  return s.replace(/^#+/, '')
}

/** F5 必填参数校验。 */
export function requireStr(
  val: string | undefined,
  name: string,
  action: SessionReadAction,
): string {
  if (val === undefined || val === null || val.trim() === '') {
    throw err(`action:"${action}" 需要参数 "${name}"。👉 补上 "${name}" 重试。`)
  }
  return val.trim()
}

// ---------------------------------------------------------------------------
// turn / turns 索引解析
// ---------------------------------------------------------------------------

const TURN_RE = /^T?(\d+)$/i

export function parseTurnIndex(raw: string): number {
  const m = raw.trim().match(TURN_RE)
  if (!m) {
    throw err(
      `turn "${raw}" 格式无效（应为 T013 或 013）。👉 用合法 turn 索引重试，或 outline 重看有效范围。`,
    )
  }
  return parseInt(m[1], 10)
}

/** turns 范围 "T013-T015" 的段数。 */
const TURNS_RANGE_PARTS = 2

export function parseTurnsRange(raw: string): { start: number; end: number } {
  const parts = raw.split('-').map((s) => s.trim())
  if (parts.length === 1) {
    const i = parseTurnIndex(parts[0])
    return { start: i, end: i }
  }
  if (parts.length === TURNS_RANGE_PARTS) {
    const start = parseTurnIndex(parts[0])
    const end = parseTurnIndex(parts[1])
    if (end < start) {
      throw err(
        `turns 范围 "${raw}" 起始大于结束。👉 检查范围格式（如 T013-T015）重试。`,
      )
    }
    return { start, end }
  }
  throw err(`turns "${raw}" 格式无效（应为 T013 或 T013-T015）。👉 用合法范围重试。`)
}

export function rangeLabel(r: { start: number; end: number }): string {
  return r.start === r.end ? `T${pad(r.start)}` : `T${pad(r.start)}-T${pad(r.end)}`
}
