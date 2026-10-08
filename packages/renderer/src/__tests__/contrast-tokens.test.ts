/**
 * 对比度令牌阈值断言单测（ui-optimize-unified U3：阈值断言固化为永久单测）。
 *
 * 设计依据：.tmp/tech-design/ui-optimize-unified.md §4 场景 1③ —— 从 style.css
 * 读令牌值计算 WCAG 2.x 对比度比：正文（--neutral-fg 于对话流卡 --surface 上）
 * ≥ 12:1、工具行（--neutral-mid）4–6:1、元信息（--neutral-dim）≥ 2.8:1；
 * 另含场景 1① 的纯计算形态 bg 分层方向断言（§3.1 分层/镜像规则）。
 * 开发期脚本形态 = .tmp/tech-design/ui-optimize-unified/verify-contrast.mjs
 * （不入库），本文件为其入库单测投影，两处阈值须同批维护。
 *
 * 亮色族 dim 档裁决（U3 实施期）：场景 1③ 的 2.8 阈值锚定自暗色族 #5c5c5c
 * （实测 2.85）；亮色族现行 --neutral-dim #9d9b96 实测 ≈2.57，强加 2.8 会与
 * 决策 2「亮色族文字档维持现行值」冲突——故亮色族 dim 断言现行值锚定（防漂移）
 * 而非 2.8 阈值，改值须先改设计。场景 1③ 阈值全套断言于暗色族三主题。
 *
 * 行内 code 令牌（--md-code-bg/fg）对比断言（场景 2③ ≥ 4:1）随 A2 单元增补。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const styleCss = readFileSync(resolve(import.meta.dirname, '../style.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

const REQUIRED_TOKENS = [
  '--bg-stage',
  '--surface',
  '--bg-input',
  '--bg',
  '--bg-elevated',
  '--neutral-fg',
  '--neutral-mid',
  '--neutral-dim',
] as const

type TokenName = (typeof REQUIRED_TOKENS)[number]
type ThemeTokens = Record<TokenName, string>

/* 主题清单用字面量数组 + typeof 推导，不立 interface（单实现接口触发 oe-assert single-impl 拦截） */
const THEMES = [
  { id: 'xuan', label: '玄（暗·默认）', family: 'dark', chain: [':root'] },
  { id: 'hao', label: '皓（亮·默认）', family: 'light', chain: [':root', '[data-theme="light"]'] },
  { id: 'dailan', label: '黛蓝（暗）', family: 'dark', chain: [':root', ':root[data-theme-preset="dailan"]'] },
  { id: 'nuanmo', label: '暖墨（暗）', family: 'dark', chain: [':root', ':root[data-theme-preset="nuanmo"]'] },
  { id: 'qingmo', label: '青墨（亮）', family: 'light', chain: [':root', '[data-theme="light"]', '[data-theme="light"][data-theme-preset="qingmo"]'] },
  { id: 'zhuyin', label: '朱印（亮）', family: 'light', chain: [':root', '[data-theme="light"]', '[data-theme="light"][data-theme-preset="zhuyin"]'] },
]

/** 亮色族 dim 档现行值锚定（决策 2：亮色族文字档维持现行值） */
const LIGHT_DIM_ANCHOR = '#9d9b96'

function parseBlockVars(selector: string): Record<string, string> {
  const idx = styleCss.indexOf(selector)
  expect(idx, `style.css 未找到选择器块：${selector}`).toBeGreaterThanOrEqual(0)
  const open = styleCss.indexOf('{', idx)
  const close = styleCss.indexOf('}', open)
  const body = styleCss.slice(open + 1, close)
  const vars: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim()
  }
  return vars
}

function resolveThemeTokens(theme: Theme): ThemeTokens {
  const merged: Record<string, string> = {}
  for (const selector of theme.chain) {
    Object.assign(merged, parseBlockVars(selector))
  }
  const out = {} as ThemeTokens
  for (const name of REQUIRED_TOKENS) {
    const raw = merged[name]
    expect(raw, `主题 ${theme.id}（${theme.label}）缺 ${name} 声明`).toBeDefined()
    expect(raw, `主题 ${theme.id} 的 ${name} 非 hex 字面值：${raw}`).toMatch(/^#[0-9a-fA-F]{6}$/)
    out[name] = raw.toLowerCase()
  }
  return out
}

/** WCAG 2.x 相对亮度 */
function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2]
}

/** WCAG 对比度比（明者在前） */
function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

const tokensByTheme = new Map<string, ThemeTokens>(THEMES.map((t) => [t.id, resolveThemeTokens(t)]))

describe('对比度令牌阈值（ui-optimize §4 场景 1③，宿主 = 对话流卡 --surface）', () => {
  it('六主题级联解析健全：断言面 8 令牌全部为 hex 字面值', () => {
    expect([...tokensByTheme.keys()].sort()).toEqual([...THEMES.map((t) => t.id)].sort())
  })

  it('正文档 --neutral-fg 对比 ≥ 12:1（六主题）', () => {
    for (const theme of THEMES) {
      const t = tokensByTheme.get(theme.id)!
      const ratio = contrastRatio(t['--neutral-fg'], t['--surface'])
      expect(ratio, `${theme.label} ${t['--neutral-fg']} on ${t['--surface']} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(12)
    }
  })

  it('工具行档 --neutral-mid 对比 ∈ [4, 6]:1（六主题）', () => {
    for (const theme of THEMES) {
      const t = tokensByTheme.get(theme.id)!
      const ratio = contrastRatio(t['--neutral-mid'], t['--surface'])
      expect(
        ratio,
        `${theme.label} ${t['--neutral-mid']} on ${t['--surface']} = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4)
      expect(ratio, `${theme.label} mid ${ratio.toFixed(2)}:1 越上界（mid 档语义 = 显著低于正文档）`).toBeLessThanOrEqual(6)
    }
  })

  it('元信息档 --neutral-dim 对比 ≥ 2.8:1（暗色族三主题）', () => {
    for (const theme of THEMES.filter((t) => t.family === 'dark')) {
      const t = tokensByTheme.get(theme.id)!
      const ratio = contrastRatio(t['--neutral-dim'], t['--surface'])
      expect(ratio, `${theme.label} ${t['--neutral-dim']} on ${t['--surface']} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(2.8)
    }
  })

  it('亮色族 --neutral-dim 维持现行值（决策 2 锚定；实测 ≈2.57 不适用暗色 2.8 阈值）', () => {
    for (const theme of THEMES.filter((t) => t.family === 'light')) {
      const t = tokensByTheme.get(theme.id)!
      expect(t['--neutral-dim'], `${theme.label} dim 漂离现行值（改值须先改 ui-optimize 决策 2）`).toBe(LIGHT_DIM_ANCHOR)
    }
  })
})

describe('bg 分层方向（场景 1① 纯计算形态，§3.1 分层/镜像规则）', () => {
  it('浮层档 --bg-elevated 亮于内容层 --surface（§3.1 明度自洽，射程 = 对话流域）', () => {
    for (const theme of THEMES) {
      const t = tokensByTheme.get(theme.id)!
      expect(
        relativeLuminance(t['--bg-elevated']),
        `${theme.label} L(${t['--bg-elevated']}) 应 > L(${t['--surface']})`,
      ).toBeGreaterThan(relativeLuminance(t['--surface']))
    }
  })

  it('内容层与框架层明度方向按族镜像：暗色族 bg 亮于 surface，亮色族 surface 亮于 bg', () => {
    for (const theme of THEMES) {
      const t = tokensByTheme.get(theme.id)!
      const lSurface = relativeLuminance(t['--surface'])
      const lBg = relativeLuminance(t['--bg'])
      if (theme.family === 'dark') {
        expect(lBg, `${theme.label} 框架层应亮于沉底内容层`).toBeGreaterThan(lSurface)
      } else {
        expect(lSurface, `${theme.label} 亮色镜像：内容层最亮`).toBeGreaterThan(lBg)
      }
    }
  })
})
