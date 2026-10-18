/**
 * 对比度令牌阈值断言单测（ui-optimize-unified U3：阈值断言固化为永久单测）。
 *
 * 设计依据：.tmp/tech-design/ui-optimize-unified.md §4 场景 1③ —— 从 style.css
 * 读令牌值计算 WCAG 2.x 对比度比：正文（--neutral-fg 于对话流卡 --surface 上）
 * ≥ 12:1、工具行（--neutral-mid）4–6:1、元信息（--neutral-dim）≥ 2.8:1；
 * 另含场景 1① 的纯计算形态 bg 分层方向断言（§3.1 分层/镜像规则）。
 * 开发期脚本形态 = .tmp/tech-design/ui-optimize-unified/verify-contrast.mjs
 * （不入库），本文件为其入库单测派生视图，两处阈值须同批维护。
 *
 * 亮色族 dim 档裁决（U3 实施期）：场景 1③ 的 2.8 阈值锚定自暗色族 #5c5c5c
 * （实测 2.85）；亮色族现行 --neutral-dim #9d9b96 实测 ≈2.57，强加 2.8 会与
 * 决策 2「亮色族文字档维持现行值」冲突——故亮色族 dim 断言现行值锚定（防漂移）
 * 而非 2.8 阈值，改值须先改设计。场景 1③ 阈值全套断言于暗色族三主题。
 *
 * 行内 code 令牌（--md-code-bg/fg）对比断言（场景 2③）已入库。R4 弱化终态（demo tokens.css
 * 同构）：--md-code-bg 为 color-mix(in oklch, var(--code-c) N%, transparent) 形态，
 * --md-code-fg 为 color-mix(in oklch, var(--neutral-fg) 85%, var(--code-c)) 形态
 * （demo 令牌名 --fg 在本仓映射为 --neutral-fg）。两者均不走 REQUIRED_TOKENS 的 hex
 * 断言范围，由本文件解析混合：底 = premultiplied alpha 的 sRGB 逐通道合成（与浏览器
 * 半透明背景合成公式一致）；字 = OKLab 三分量 lerp（color-mix(in oklch) 的浏览器
 * 混合空间，Björn Ottosson 线性空间矩阵），转 linear sRGB 算亮度。
 * 对比锚定（R4 公式重验）：暗色族 ≈13.1:1 / 皓 10.65 / 青墨 10.62 / 朱印 10.50，
 * 六主题全部过统一 ≥4:1 线；旧「朱印 code-c 本色字 3.92:1」的 3.9 豁免随 R4 公式
 * 落地失效，后随 2026-10-10 裁决统一提升至 WCAG AA 4.5:1（见 CODE_CONTRAST_MIN）。
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

type ThemeEntry = (typeof THEMES)[number]

/** color-mix 形态令牌的原始串解析（--accent/--md-code-* 不进 REQUIRED_TOKENS 的 hex 断言范围） */
function parseThemeRawVars(theme: ThemeEntry, names: readonly string[]): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const selector of theme.chain) {
    Object.assign(merged, parseBlockVars(selector))
  }
  const out: Record<string, string> = {}
  for (const name of names) {
    const raw = merged[name]
    expect(raw, `主题 ${theme.id}（${theme.label}）缺 ${name} 声明`).toBeDefined()
    out[name] = raw
  }
  return out
}

/** 半透明前景（accent + alpha）渲染于不透明底色上的 sRGB 逐通道合成（浏览器背景色合成公式） */
function compositeOver(accentHex: string, alpha: number, baseHex: string): string {
  const a = parseInt(accentHex.slice(1), 16)
  const b = parseInt(baseHex.slice(1), 16)
  const mix = (x: number, y: number) => Math.round(alpha * x + (1 - alpha) * y)
  const r = mix((a >> 16) & 255, (b >> 16) & 255)
  const g = mix((a >> 8) & 255, (b >> 8) & 255)
  const bch = mix(a & 255, b & 255)
  return `#${((r << 16) | (g << 8) | bch).toString(16).padStart(6, '0')}`
}

describe('对比度令牌阈值（ui-optimize §4 场景 1③，宿主 = 对话流卡 --surface）', () => {
  it('六主题级联解析健全：断言范围 8 令牌全部为 hex 字面值', () => {
    // 显式遍历断言（不依赖模块顶层构造期的校验副作用——那以文件级错误出现，不落在任何用例上）
    for (const theme of THEMES) {
      const t = tokensByTheme.get(theme.id)!
      for (const name of REQUIRED_TOKENS) {
        expect(t[name], `${theme.label} 的 ${name} 缺声明或非 hex 字面值：${t[name] ?? '<undefined>'}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
    }
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

describe('行内 code 对比（场景 2③，六主题；demo R4 弱化终态 = fg 主导混 code-c）', () => {
  const MD_CODE_MIX_RE = /^color-mix\(in oklch,\s*var\(--code-c\)\s*([\d.]+)%,\s*transparent\)$/
  const CODE_FG_MIX_RE = /^color-mix\(in oklch,\s*var\(--neutral-fg\)\s*([\d.]+)%,\s*var\(--code-c\)\)$/

  /** 六主题统一 ≥4:1 线（R4 公式重验：暗族 ≈13.1 / 皓 10.65 / 青墨 10.62 / 朱印 10.50）。
   * 旧「朱印 3.9 豁免」锚定的是旧公式（字色 = code-c 本色）下朱印 3.92:1——公式改 R4 后
   * 该前提失效，豁免废除（2026-10-10 裁决，本线提升至 WCAG AA 4.5）。 */
  // 2026-10-10 用户裁决：行内代码按实际可读性标准（WCAG AA 4.5:1 正文线）统一断言，
  // 不再按主题设差异化下限（旧朱印 3.9 豁免随 R4 公式 + 本线提升双重失效）。
  const CODE_CONTRAST_MIN: Record<(typeof THEMES)[number]['id'], number> = {
    xuan: 4.5,
    dailan: 4.5,
    nuanmo: 4.5,
    hao: 4.5,
    qingmo: 4.5,
    zhuyin: 4.5,
  }

  const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

  /** sRGB hex → OKLab（Björn Ottosson 线性空间矩阵，color-mix(in oklch) 的浏览器混合空间） */
  function hexToOklab(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => srgbToLinear(c / 255))
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ]
  }

  function oklabToLinear([L, a, b]: [number, number, number]): [number, number, number] {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b
    const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3]
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ]
  }

  /** color-mix(in oklch, A t%, B)：OKLab 三分量各自 lerp → linear sRGB
   * （亮度直接在 linear 空间计算，不经 hex 往返避免舍入漂移） */
  function mixOklabToLinear(hexA: string, t: number, hexB: string): [number, number, number] {
    const ka = hexToOklab(hexA)
    const kb = hexToOklab(hexB)
    return oklabToLinear([
      ka[0] * t + kb[0] * (1 - t),
      ka[1] * t + kb[1] * (1 - t),
      ka[2] * t + kb[2] * (1 - t),
    ])
  }

  function luminanceOfLinear([r, g, b]: [number, number, number]): number {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  function contrastRatioLinear(
    fg: [number, number, number],
    bg: [number, number, number],
  ): number {
    const l1 = luminanceOfLinear(fg)
    const l2 = luminanceOfLinear(bg)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }

  function hexToLinearRgb(hex: string): [number, number, number] {
    return [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [
      number,
      number,
      number,
    ]
  }

  it('--md-code-fg（neutral-fg 85% 混 code-c）于合成底（code-c N% 叠 surface）上对比 ≥4:1（六主题统一线）', () => {
    for (const theme of THEMES) {
      const raw = parseThemeRawVars(theme, ['--neutral-fg', '--code-c', '--md-code-bg', '--md-code-fg'])
      const fgRaw = (raw['--md-code-fg'] ?? '').trim()
      const fgMix = fgRaw.match(CODE_FG_MIX_RE)
      expect(
        fgMix,
        `主题 ${theme.label} --md-code-fg 形态非 color-mix(in oklch, var(--neutral-fg) N%, var(--code-c))：${fgRaw}`,
      ).not.toBeNull()
      const fg = (raw['--neutral-fg'] ?? '').toLowerCase()
      const code = (raw['--code-c'] ?? '').toLowerCase()
      expect(fg, `主题 ${theme.label} --neutral-fg 非 hex 字面值：${raw['--neutral-fg']}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(code, `主题 ${theme.label} --code-c 非 hex 字面值：${raw['--code-c']}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      const bgMix = (raw['--md-code-bg'] ?? '').match(MD_CODE_MIX_RE)
      expect(bgMix, `主题 ${theme.label} --md-code-bg 形态非 color-mix(code-c N%, transparent)：${raw['--md-code-bg']}`).not.toBeNull()
      const alpha = Number(bgMix![1]) / 100
      const surface = tokensByTheme.get(theme.id)!['--surface']
      const codeBg = compositeOver(code, alpha, surface)
      const fgLinear = mixOklabToLinear(fg, Number(fgMix![1]) / 100, code)
      const ratio = contrastRatioLinear(fgLinear, hexToLinearRgb(codeBg))
      const min = CODE_CONTRAST_MIN[theme.id]
      expect(ratio, `${theme.label} code ${fgRaw} on ${codeBg}（code-c ${bgMix![1]}% 叠 surface）= ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min)
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
