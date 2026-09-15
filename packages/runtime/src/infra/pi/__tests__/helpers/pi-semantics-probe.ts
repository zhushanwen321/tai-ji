/**
 * pi-semantics 探针族共享装置（PS 条目静态守卫测试，源文件 = node_modules 实装 dist）。
 *
 * 从各 pi-semantics-*.test.ts 的逐字副本收敛为单源（locatePiCodingAgentDist ×6、
 * locatePiDist ×4、methodWindow 正则边界版 ×3、methodWindowUntil 显式下界版 ×2）。
 * 只抽装置：每 PS 条目的登记与独立复核边界仍留在各探针文件，不合并文件。
 * dist 不可达时各探针经 describe.skipIf 自行 skip（空集守卫先例：
 * pi-paths-config-dir-contract.test.ts——负断言前先验证提取器命中已知锚点）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * cwd 逐级上溯定位 @earendil-works/<pkg>/dist（sentinel 文件存在即命中；最多上溯 6 级）。
 * 版本权威源约定见 AGENTS.md「pi 语义断言的权威源 = node_modules 实装版」。
 */
export function locatePiDist(pkg: string, sentinel: string): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', pkg, 'dist')
    if (existsSync(join(candidate, sentinel))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** locatePiDist 的 pi-coding-agent 特化（config.js 哨兵）。 */
export function locatePiCodingAgentDist(): string | null {
  return locatePiDist('pi-coding-agent', 'config.js')
}

/**
 * 提取类方法窗口（正则边界版）：从方法头（4 空格缩进）到下一个同缩度方法/字段/文档注释声明。
 * 窗口为空 = 方法消失/改名，调用方须按「漂移」处理（fail 而非静默通过）。
 */
export function methodWindow(text: string, header: string): string {
  const start = text.indexOf(header)
  if (start === -1) return ''
  const rest = text.slice(start + header.length)
  const next = /\n    (?:async )?[A-Za-z_$][\w$]*[=(]|\n    \/\*\*/.exec(rest)
  return next ? rest.slice(0, next.index) : rest.slice(0, 4000)
}

/**
 * 提取类方法窗口（显式下界版）：header 起到 nextHeader 首次出现止（窗口含 header 本体），
 * 找不到下界时截 3000 字符兜底。与正则边界版（methodWindow）是两种语义，勿混用。
 */
export function methodWindowUntil(text: string, header: string, nextHeader: string): string {
  const start = text.indexOf(header)
  if (start === -1) return ''
  const end = text.indexOf(nextHeader, start)
  return end === -1 ? text.slice(start, start + 3000) : text.slice(start, end)
}
