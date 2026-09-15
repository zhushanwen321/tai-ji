/**
 * 括号平衡调用窗提取（测试基建共享 helper，源码简化 T11）。
 *
 * 守卫型测试用：从源码文本中提取「callee( 起至圆括号平衡闭合止」的完整调用块，
 * 供静态断言调用点传参形态。此前 create-derived-callers.test.ts（extractCallWindows）
 * 与 binding-registry-hydrate.test.ts（extractCallBlocks）各持一份同型实现，
 * 本 helper 按「两实现语义并集」统一：
 * - 字符串感知：跳过引号字符串字面量（' " `）与转义符，字符串内的括号不参与深度计数
 * - 未闭合抛错：maxLines 内未闭合视为源码格式异常，抛错带行号（失败要出声，不静默截断）
 * - 行数双保险：超 maxLines 行的未闭合扫描中断转抛错，防异常源码爆循环
 * - 嵌套不重复：闭合后从右括号之后继续匹配，嵌套调用不产生重叠窗口
 *
 * 仅服务测试（src/__tests__/），不入生产 bundle。
 */

/** 单个调用窗：锚点匹配信息 + 平衡闭合的完整调用文本。 */
export interface CallWindow {
  /** 锚点起始偏移（source 内字符索引） */
  index: number
  /** 锚点所在行号（1-based，报错定位用） */
  line: number
  /** 从锚点起至右括号闭合止的调用文本（含两端括号） */
  text: string
}

/** 未闭合判定上限（行）：以 ~120 字符/行估算字符距离，超限即抛错。 */
export const CALL_WINDOW_MAX_LINES = 40

/**
 * 提取 source 中每处 anchor（须含结尾 `(` 形态，如 /sessionService\.create\(/g）
 * 调用的文本窗口：自锚点 `(` 起做括号深度计数，归零即闭合。
 *
 * @param source 被扫描的源码文本
 * @param anchor 全局正则锚点（callee 名称 + `\\s*\\(` 形态；非 g 正则会自动补 g）
 * @param maxLines 未闭合抛错/中断的行数上限（默认 40）
 */
export function extractCallWindows(
  source: string,
  anchor: RegExp,
  maxLines: number = CALL_WINDOW_MAX_LINES,
): CallWindow[] {
  const windows: CallWindow[] = []
  const re = new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`)
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const line = source.slice(0, m.index).split('\n').length
    let depth = 1 // 锚点已消费 callee 后的 `(`，从其后一位起计数
    let end = -1
    let i = re.lastIndex
    while (i < source.length) {
      const ch = source[i]
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch
        i++
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++ // 跳过转义字符
          i++
        }
      } else if (ch === '(') {
        depth++
      } else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
      if (ch === '\n' && i - m.index > maxLines * 120) break // 双保险：行数估算防爆循环
      i++
    }
    if (end === -1) {
      throw new Error(
        `第 ${line} 行 ${anchor.source} 调用在 ${maxLines} 行内未闭合右括号，` +
        '静态扫描窗口提取失败——请检查该文件调用格式是否异常',
      )
    }
    windows.push({ index: m.index, line, text: source.slice(m.index, end + 1) })
    re.lastIndex = end + 1 // 嵌套调用不重复报告
  }
  return windows
}
