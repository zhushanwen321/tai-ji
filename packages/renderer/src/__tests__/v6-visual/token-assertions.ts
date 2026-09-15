/**
 * W1 token 断言工具模块（IF1 定义层分支 + DM1 类型）。
 *
 * 三类断言中「CSS 变量定义存在性」的归位点（vitest 纯 JS 解析 style.css :root，
 * 不经 DOM 渲染）。组件消费层断言（computed style 取自 var()）因 happy-dom 不展开
 * var()（见 tokens.test.ts TC2 探测结论），归 scripts/token-consume-check.mjs
 * 的 chromium 轨，不在本模块。
 *
 * SSOT 变量名：docs/DESIGN.md §4（ADR-0018 归一命名）。
 * v3 style.css 与 v6 tokens.css 变量名几乎一致，仅值不同（D5），故本模块对
 * v3→v6 迁移都成立。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// DM1 类型
// ---------------------------------------------------------------------------

export interface TokenAssertion {
  /** 组件名（AppShell/Sidebar/Composer/MessageStream/SettingsModal） */
  component: string
  /** 定位组件根或代表元素的 CSS 选择器（如 '.app-shell' / '.composer-box'） */
  selector: string
  /** 断言的 computed style 属性（camelCase） */
  property: 'backgroundColor' | 'color' | 'borderRadius' | 'borderColor'
  /** 期望取自的 CSS 变量名（--bg/--neutral-fg/--accent/--border/--radius/--radius-lg 等） */
  expectedVar: string
}

export interface TokenAssertionResult {
  assertion: TokenAssertion
  /** expectedVar 是否在 :root 声明（定义层） */
  defined: boolean
  /** 消费层：组件 computed style 实际值（chromium 取） */
  actualValue: string
  /** 消费层：expectedVar 在 :root 的展开值 */
  expectedValue: string
  pass: boolean
  detail?: string
}

// ---------------------------------------------------------------------------
// A层断言套件入口（IF1 定义层分支）
// ---------------------------------------------------------------------------

/**
 * W1 核心变量清单（AC1）。覆盖 5 核心组件依赖的 color/background/border-radius
 * 取值变量 + shadcn 别名 --primary（=var(--accent)）。
 */
export const CORE_TOKENS = [
  '--bg',
  '--surface',
  '--neutral-fg',
  '--accent',
  '--border',
  '--radius-sm',
  '--radius',
  '--radius-lg',
] as const

/**
 * 解析 CSS 文本首个 `:root { ... }` 块内的 `--name: value` 声明。
 *
 * 非贪婪匹配到第一个 `}`（暗色默认块），不覆盖 `[data-theme=light]` /
 * `[data-accent=*]` 主题覆盖块（那些是值覆盖，变量名已由 :root 定义）。
 * 去 `/* *​/` 注释与首尾空白。
 *
 * @returns 变量名 → 值（trim 后）的映射；无 :root 块返回 {}。
 */
export function parseRootVars(cssText: string): Record<string, string> {
  const rootMatch = cssText.match(/:root\s*\{([\s\S]*?)\}/)
  if (!rootMatch) return {}
  const body = rootMatch[1]
  const vars: Record<string, string> = {}
  // 匹配 `--name: value`（value 到 `;` 或行尾，去注释）
  const declRe = /(--[a-zA-Z0-9-]+)\s*:\s*([^;}\n]+)/g
  let m: RegExpExecArray | null
  while ((m = declRe.exec(body)) !== null) {
    const name = m[1]
    const value = m[2].replace(/\/\*[\s\S]*?\*\//g, '').trim()
    vars[name] = value
  }
  return vars
}

/**
 * 读 style.css，返回每个必需变量的定义存在性（IF1 定义层入口）。
 *
 * @param requiredVars 必需的变量名清单（如 CORE_TOKENS）
 * @param cssPath style.css 路径（默认相对 cwd=packages/renderer 的 src/style.css）
 */
export function runTokenDefinitionsCheck(
  requiredVars: readonly string[],
  cssPath: string = resolve(process.cwd(), 'src/style.css'),
): { name: string; defined: boolean; value: string }[] {
  const css = readFileSync(cssPath, 'utf-8')
  const vars = parseRootVars(css)
  return requiredVars.map((name) => ({
    name,
    defined: name in vars && vars[name].length > 0,
    value: vars[name] ?? '',
  }))
}
