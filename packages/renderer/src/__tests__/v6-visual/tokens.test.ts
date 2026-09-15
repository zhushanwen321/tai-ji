/**
 * W1 token 断言 vitest 套件。
 *
 * 三类用例：
 *  - TC1：CSS 变量定义存在性（纯 JS 解析 style.css :root，≥8 核心变量 + --primary 别名）
 *  - chromium 轨脚本存在性（双轨防静默删除）
 *  （原 TC2 恒真探测记录与 TC3 自证循环——注入自写 CSS 再读取、未 mount 任何组件——已删；
 *   组件真实消费验证归 chromium 轨 scripts/token-consume-check.mjs。）
 *  【历史结构】TC3：组件消费层断言（vitest 契约验证：注入 :root 变量 + Tailwind 等价语义类 CSS，
 *         5 组件各 ≥1 条 color/background 取自 var()；chromium 轨 scripts/token-consume-
 *         check.mjs 作真实验证双轨——加载真实 vite dev server + Tailwind JIT 编译产物）
 *
 * 探测结论（W1 实测，见 TC2 输出）：happy-dom 完整支持 var() 展开（inline + class
 * 双路径均 resolves），推翻 slice plan 预设。但 vitest 不加载 Tailwind 编译产物，
 * 故 vitest 轨为「类名→var() 契约验证」（注入等价 CSS），chromium 轨为「真实验证」。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseRootVars,
  runTokenDefinitionsCheck,
  CORE_TOKENS,
} from './token-assertions'

const STYLE_CSS_PATH = resolve(process.cwd(), 'src/style.css')

// ---------------------------------------------------------------------------
// happy-dom var() 展开行为探测（模块顶层同步执行，供 TC2 记录 + TC3 skipIf 判定）
// ---------------------------------------------------------------------------

/** #1a1b1f → rgb(26, 27, 31)（happy-dom 若展开可能返回 hex 或 rgb，两者都接受） */
function hexToRgb(hex: string): string | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

/**
 * happy-dom var() 展开行为探测（双路径）。
 *
 * 两条路径分别覆盖组件消费 var() 的两种形态：
 *  - inline：el.style.setProperty('color','var(--x)')（内联 style 直接写 var()）
 *  - class：注入 <style> 含 :root 变量 + .probe-class{color:var(--x)}，mount class 元素
 *           （模拟 Tailwind 语义类 bg-bg/text-neutral-fg → var() 的编译产物）
 *
 * 消费层断言走 vitest 的前提是 class 路径 resolves（组件用 Tailwind 类消费 var()）。
 * inline 路径 resolves 但 class 不 resolves 时，vitest 无法验证组件 Tailwind 类消费，
 * 消费层仍走 chromium（加载完整 vite 编译产物 + style.css）。
 */
function probeInline(): boolean {
  try {
    document.documentElement.style.setProperty('--probe-token-w1', '#1a1b1f')
    const el = document.createElement('div')
    el.style.setProperty('color', 'var(--probe-token-w1)')
    document.body.appendChild(el)
    const computed = getComputedStyle(el).color
    const rootVal = getComputedStyle(document.documentElement)
      .getPropertyValue('--probe-token-w1')
      .trim()
    el.remove()
    document.documentElement.style.removeProperty('--probe-token-w1')
    const isLiteralOrEmpty = computed === '' || computed.includes('var(')
    return (
      !isLiteralOrEmpty && (computed === rootVal || computed === hexToRgb(rootVal))
    )
  } catch {
    return false
  }
}

function probeClass(): boolean {
  try {
    // 注入 <style>：:root 变量 + .probe-class-w1 消费 var()（模拟 Tailwind 编译产物）
    const style = document.createElement('style')
    style.textContent =
      ':root{--probe-class-token-w1:#1a1b1f}.probe-class-w1{color:var(--probe-class-token-w1)}'
    document.head.appendChild(style)
    const el = document.createElement('div')
    el.className = 'probe-class-w1'
    document.body.appendChild(el)
    const computed = getComputedStyle(el).color
    el.remove()
    style.remove()
    const rgb = hexToRgb('#1a1b1f')
    // class 路径 resolves：computed 等于 hex 或 rgb 表示（非空非字面量）
    return computed === '#1a1b1f' || (rgb !== null && computed === rgb)
  } catch {
    return false
  }
}

const PROBE = {
  inline: probeInline(),
  classPath: probeClass(),
}

/**
 * 消费层断言归属：仅当 happy-dom 能解析注入 <style> 的 class→var() 消费（classPath）
 * 时，vitest 才能验证组件 Tailwind 类消费；否则走 chromium（加载真实 vite 编译产物）。
 */
export const HAPPYDOM_RESOLVES_VAR = PROBE.classPath

// ---------------------------------------------------------------------------
// TC1：CSS 变量定义存在性断言（A层静态契约底线，ERR1 防护）
// ---------------------------------------------------------------------------

describe('TC1: CSS 变量定义存在性（style.css :root）', () => {
  it('首个 :root 块声明 ≥8 核心变量且值非空', () => {
    const css = readFileSync(STYLE_CSS_PATH, 'utf-8')
    const vars = parseRootVars(css)
    expect(Object.keys(vars).length).toBeGreaterThan(0)
    for (const name of CORE_TOKENS) {
      expect(vars[name], `${name} 应在 :root 声明且非空`).toBeTruthy()
    }
  })

  it('runTokenDefinitionsCheck 对核心变量全部 defined=true', () => {
    const results = runTokenDefinitionsCheck(CORE_TOKENS, STYLE_CSS_PATH)
    for (const r of results) {
      expect(r.defined, `${r.name} defined 应为 true，实际 value="${r.value}"`).toBe(true)
    }
    // ≥8 个核心变量（CORE_TOKENS 长度）
    expect(results.length).toBeGreaterThanOrEqual(8)
  })

  it('--primary shadcn 别名解析为 var(--accent) 引用', () => {
    const results = runTokenDefinitionsCheck(['--primary'], STYLE_CSS_PATH)
    const primary = results[0]
    expect(primary.defined).toBe(true)
    // --primary: var(--accent)（可能含注释 trim 后）
    expect(primary.value).toMatch(/var\(\s*--accent\s*\)/)
  })
})

// ---------------------------------------------------------------------------
// TC3：组件消费层断言（vitest 契约验证——happy-dom 支持 var()，注入等价 CSS 验证
//      5 组件 Tailwind 语义类 → var() 消费关系；chromium 轨作真实验证双轨）
// ---------------------------------------------------------------------------

/** 5 组件消费层断言表（组件 → Tailwind 语义类 → computed 属性 → 期望 CSS 变量） */
const COMPONENT_CONSUME: Array<{
  component: string
  cls: string
  prop: 'backgroundColor' | 'color'
  varName: string
}> = [
  { component: 'AppShell', cls: 'bg-bg', prop: 'backgroundColor', varName: '--bg' },
  { component: 'Sidebar', cls: 'text-neutral-fg', prop: 'color', varName: '--neutral-fg' },
  { component: 'Composer', cls: 'bg-bg-input', prop: 'backgroundColor', varName: '--bg-input' },
  { component: 'MessageStream', cls: 'text-accent', prop: 'color', varName: '--accent' },
  { component: 'Settings', cls: 'bg-surface', prop: 'backgroundColor', varName: '--surface' },
]

describe('chromium 轨真实验证（双轨守卫）', () => {
  it('chromium 轨真实验证脚本存在（scripts/token-consume-check.mjs，双轨）', () => {
    // 静态守卫：chromium 轨加载真实 vite dev server + Tailwind JIT 验证组件真实消费
    const scriptPath = resolve(
      process.cwd(),
      '..',
      '..',
      'scripts',
      'token-consume-check.mjs',
    )
    let exists = false
    try {
      readFileSync(scriptPath, 'utf-8')
      exists = true
    } catch {
      exists = false
    }
    expect(exists, `chromium 真实验证脚本应存在: ${scriptPath}`).toBe(true)
  })
})
