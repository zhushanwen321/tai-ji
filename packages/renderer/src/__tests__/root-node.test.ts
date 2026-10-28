// @vitest-environment node

/**
 * renderer 根域 node 纯逻辑测试合并文件（round6 测试提速，node 环境簇）。
 *
 * 本文件由以下六文件原样搬运合并（describe/it 名零改动；六源全为 node 环境——
 * fg5/contrast-tokens/state-tone-lock 原默认 happy-dom，节内仅 fs/pinia/纯函数，
 * node 下行为不变，实测绿灯）：
 * - src/__tests__/contrast-tokens.test.ts（style.css 令牌静态锁）
 * - src/__tests__/state-tone-lock.test.ts（tray 色调 SSOT 锁）
 * - src/__tests__/fg5-message-stream.test.ts（messageTurns 回归锁）
 * - src/__tests__/extension-upgrade.test.ts（extension 域 WS 消息契约）
 * - src/__tests__/session-renamed-sync.test.ts（session 推送 → store 同步）
 * - src/__tests__/new-task/workspace-store.test.ts（workspaceStore + sessionApi.create，
 *   既有两源合并产物）
 *
 * 共享 mock（extension-upgrade / session-renamed-sync / workspace-store 三节消费，
 * contrast/state-tone/fg5 节零消费）：
 * - core ws-client：transportMock.send 捕获消息返回 true
 * - core pending（源文件相对路径，须与 core 内 import 同模块 ID）：'pid-1' + envelope
 * - '@/api'：project（helpers/api-facade-mock 空载基座）+ workspace + chat（streamSubscribe
 *   回调捕获，helpers/stream-subscribe-mock）+ session.writeSegments 的并集工厂
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/root-node.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { textToSegments } from '@taiji/shared'
import type { SessionSummary, SessionGroup, RecentWorkspaceRecord } from '@taiji/shared'
// '@/api' mock 工厂解引用的 helper import 必须先于触发工厂执行的 import（useChat 链）求值
import { apiProjectMock } from './helpers/api-facade-mock'
import { makeStreamSubscribeMock } from './helpers/stream-subscribe-mock'

// 捕获 transport.send 收到的消息（含 payload 形状）。
// （send 返回 true = 消息已送出，符合 transport.send 的 boolean 契约：
// request.command 对 send false 会调 pending.reject 走 fast-fail）
const transportMock = vi.hoisted(() => {
  const sent: Array<{ type: string; id: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    send: vi.fn((msg: { type: string; id: string; payload: Record<string, unknown> }): boolean => {
      sent.push(msg)
      return true
    }),
  }
})

vi.mock('@taiji/core/transport/ws-client', () => ({ send: transportMock.send }))
// mock 目标 = core 源文件相对路径（须与 core 内相对 import 解析为同一模块 ID 才能拦截）
vi.mock('../../../core/src/transport/api/pending', () => ({
  RPC_BACKSTOP_TIMEOUT_MS: 65_000,
  createCommandId: vi.fn(() => 'pid-1'),
  register: vi.fn(() =>
    Promise.resolve({ session: { id: 's1', cwd: '/x', status: 'idle' } as SessionSummary }),
  ),
  reject: vi.fn(),
}))

// streamCbHolder：streamSubscribe 回调捕获容器（session-renamed-sync 节消费；
// vi.hoisted 工厂被 hoist 到 import 之前执行，不能引用 import 绑定——TDZ）
const streamCbHolder = vi.hoisted(() => ({ current: null as ((msg: { type: string; payload: Record<string, unknown> }) => void) | null }))

// '@/api' 并集工厂：project 域空载基座单源在 helpers/api-facade-mock（mount 链
// onMounted 消费 project.load）；streamSubscribe 捕获回调脚手架单源在
// helpers/stream-subscribe-mock；w5：useChat 薄包装 import session.writeSegments。
vi.mock('@/api', () => ({
  project: apiProjectMock(),
  chat: { send: vi.fn(), streamSubscribe: makeStreamSubscribeMock(streamCbHolder) },
  session: {
    writeSegments: vi.fn(() => Promise.resolve()),
  },
  workspace: { listRecent: vi.fn(), record: vi.fn(), defaultSessionDir: vi.fn(), setPinned: vi.fn() },
}))


// ══════════════ 源: src/__tests__/contrast-tokens.test.ts ══════════════
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
 * 对比锚定（R4 公式重验，2026-10-17 六主题 v2 后）：暗色族 ≈11.4–11.9:1 / 皓 10.65 / 青墨 10.62 / 朱印 10.50，
 * 六主题全部过统一 ≥4:1 线；旧「朱印 code-c 本色字 3.92:1」的 3.9 豁免随 R4 公式
 * 落地失效，后随 2026-10-10 裁决统一提升至 WCAG AA 4.5:1（见 CODE_CONTRAST_MIN）。
 *
 * 实底前景令牌（--accent-fg / --danger-fg / --success-fg 对各自实底）对比断言：
 * 六主题令牌契约的「实底必有前景令牌」规则的数值面固化。accent-fg / success-fg 为
 * 深字公式（color-mix(in oklch, 基色 12%, 深底)），按 WCAG AA 4.5:1 正文线断言；
 * danger-fg 为亮字（var(--neutral-fg)，2026-10-23 裁决：旧 12% 混深底公式产出暗红褐，
 * 红底暗红字视觉发闷，vision 真机验收三轮判 FAIL 后废弃），亮色族为 #ffffff 白字覆盖。
 * danger 实底（#bf6b6b 中明度）上任何亮字数学上过不了 4.5:1 正文线，实底短标签按钮按
 * WCAG 1.4.11 图形组件线 3:1 断言（对齐 destructive 按钮既有先例与 2026-10-23 已验收
 * 视觉）。success-fg 不随 danger 改亮字：--success 明度更高，亮字仅 2.18:1 连组件线都
 * 不过，深字公式 6.24:1 过正文线且无视觉投诉，保留原形态。
 * warn 不设 -fg（无实底用法，见 docs/DESIGN.md §4.4），不在断言范围。
 */

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

  it('元信息档 --neutral-dim 于侧栏 --bg 上对比 ≥ 2.8:1（暗色族三主题；2026-10-17 六主题 v2 把此前未被断言覆盖的侧边栏暗坑纳入守护）', () => {
    for (const theme of THEMES.filter((t) => t.family === 'dark')) {
      const t = tokensByTheme.get(theme.id)!
      const ratio = contrastRatio(t['--neutral-dim'], t['--bg'])
      expect(ratio, `${theme.label} ${t['--neutral-dim']} on ${t['--bg']} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(2.8)
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

  /** 六主题统一 ≥4:1 线（R4 公式重验，2026-10-17 六主题 v2 后：暗族 ≈11.4–11.9 / 皓 10.65 / 青墨 10.62 / 朱印 10.50）。
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

  /** 实底 -fg 原始声明 → linear sRGB 三元组。接受三种形态：hex 字面值（亮色族白字覆盖）、
   * color-mix(in oklch, var(--基色) N%, #hex) 公式（accent-fg 深字）、var(--neutral-fg)
   * 引用（danger-fg/success-fg 亮字，2026-10-23 裁决形态——引用值以当前主题实值代入，
   * 与浏览器 var 解析行为一致，由调用方传入该主题的 neutral-fg hex）。 */
  function solidFgToLinear(
    fgRaw: string,
    baseName: 'accent' | 'danger' | 'success',
    baseHex: string,
    themeNeutralFg: string,
  ): [number, number, number] {
    if (/^#[0-9a-fA-F]{6}$/.test(fgRaw)) return hexToLinearRgb(fgRaw)
    if (fgRaw === 'var(--neutral-fg)') return hexToLinearRgb(themeNeutralFg)
    const mix = fgRaw.match(
      new RegExp(`^color-mix\\(in oklch,\\s*var\\(--${baseName}\\)\\s*([\\d.]+)%,\\s*(#[0-9a-fA-F]{6})\\)$`),
    )
    expect(mix, `-fg 公式形态非 color-mix(in oklch, var(--${baseName}) N%, #hex) 或 var(--neutral-fg)：${fgRaw}`).not.toBeNull()
    return mixOklabToLinear(baseHex, Number(mix![1]) / 100, mix![2])
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

  it('实底 -fg 对各自底色对比：accent-fg / success-fg ≥4.5:1（AA 正文线，深字公式）；danger-fg ≥3:1（WCAG 1.4.11 图形组件线，亮字形态——2026-10-23 裁决：中明度 danger 实底上任何亮字数学上过不了 4.5:1，旧 12% 混深底暗字公式压线凑 AA 致视觉发闷已废弃，实底短标签按组件线断言，对齐 destructive 先例；success 底更亮、亮字仅 2.18:1 故保留深字公式不随改）', () => {
    const MIN_BY_BASE = { accent: 4.5, danger: 3.0, success: 4.5 } as const
    for (const theme of THEMES) {
      const raw = parseThemeRawVars(theme, ['--accent', '--accent-fg', '--danger', '--danger-fg', '--success', '--success-fg'])
      const neutralFg = tokensByTheme.get(theme.id)!['--neutral-fg']
      for (const name of ['accent', 'danger', 'success'] as const) {
        const baseHex = (raw[`--${name}`] ?? '').toLowerCase()
        expect(baseHex, `主题 ${theme.label} --${name} 非 hex 字面值：${raw[`--${name}`]}`).toMatch(/^#[0-9a-fA-F]{6}$/)
        const fgLinear = solidFgToLinear(raw[`--${name}-fg`] ?? '', name, baseHex, neutralFg)
        const ratio = contrastRatioLinear(fgLinear, hexToLinearRgb(baseHex))
        expect(ratio, `${theme.label} --${name}-fg on --${name}（${baseHex}）= ${ratio.toFixed(2)}:1 低于 ${MIN_BY_BASE[name]}:1`).toBeGreaterThanOrEqual(MIN_BY_BASE[name])
      }
    }
  })

  it('--danger-text（danger 78% 混 neutral-fg 提亮档）于浮层底 --bg 上对比 ≥4.5:1（六主题；套餐浮层窗口百分比小字消费点，环/条填充仍用 --danger 原色）', () => {
    for (const theme of THEMES) {
      const raw = parseThemeRawVars(theme, ['--danger-text', '--danger', '--neutral-fg', '--bg'])
      const fgRaw = (raw['--danger-text'] ?? '').trim()
      const mix = fgRaw.match(/^color-mix\(in oklch,\s*var\(--danger\)\s*([\d.]+)%,\s*var\(--neutral-fg\)\)$/)
      expect(
        mix,
        `主题 ${theme.label} --danger-text 形态非 color-mix(in oklch, var(--danger) N%, var(--neutral-fg))：${fgRaw}`,
      ).not.toBeNull()
      const danger = (raw['--danger'] ?? '').toLowerCase()
      const fg = (raw['--neutral-fg'] ?? '').toLowerCase()
      const bg = (raw['--bg'] ?? '').toLowerCase()
      expect(danger, `主题 ${theme.label} --danger 非 hex 字面值：${raw['--danger']}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(fg, `主题 ${theme.label} --neutral-fg 非 hex 字面值：${raw['--neutral-fg']}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(bg, `主题 ${theme.label} --bg 非 hex 字面值：${raw['--bg']}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      const fgLinear = mixOklabToLinear(danger, Number(mix![1]) / 100, fg)
      const ratio = contrastRatioLinear(fgLinear, hexToLinearRgb(bg))
      expect(ratio, `${theme.label} --danger-text on --bg（${bg}）= ${ratio.toFixed(2)}:1 低于 WCAG AA 4.5:1`).toBeGreaterThanOrEqual(4.5)
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


// ══════════════ 源: src/__tests__/state-tone-lock.test.ts ══════════════
// @vitest-environment node

/**
 * state-tone-lock —— 状态→色档映射全集锁测试（[W2 D8] UI 全集锁）。
 *
 * 锁的分工（锁本体在源码，本文件是全集锚 + 行为锚）：
 * - **编译层锁**：WORKFLOW_TONE_BY_OUTCOME / SUBAGENT_DOT_RULES 的 `satisfies
 *   Record<词表, …>`（词表扩值漏配 = 源码行编译红）。本文件下方 @ts-expect-error
 *   锚为「锁存在」的活性证明：
 *   词表外键索引必须编译红，映射锁被拆（键型放宽成索引签名）后该行变为
 *   「未使用的 @ts-expect-error」→ 类型检查红。
 * - **运行层锚（本文件，普通 vitest run 即验证）**：映射键域 ⊆ 词表快照（下方
 *   OUTCOME_SNAPSHOT——词表扩值而映射漏配时权威拦截是 satisfies 编译红，本文件
 *   快照比对为第二道）；四值 tone 三分行为（completed 绿 / failed 红 /
 *   cancelled+interrupted 同中性——用词区分由 shared WORKFLOW_RUN_OUTCOME_LABELS
 *   承载，文案断言段见「中文显示名词表单源」describe）；reopened 中性色修正锚。
 *
 * 运行：cd packages/renderer && pnpm vitest run src/__tests__/root-node.test.ts（state-tone-lock 节）
 */
import {
  SUBAGENT_STATUS_ALL,
  WORKFLOW_RUN_OUTCOME_LABELS,
  type SubagentRecord,
  type WorkflowRunOutcome,
  type WorkflowRunRecord,
} from '@taiji/shared'
import { SUBAGENT_DOT_RULES, subagentDotClass } from '@/lib/subagent-bucket'
import { WORKFLOW_TONE_BY_OUTCOME, workflowStatusLabel, workflowToneClass } from '@/components/panel/tray/tray-tone'

/**
 * WorkflowRunOutcome 词表快照（与 shared/src/workflow.ts 词表联合同步的本地锚）：
 * 词表真扩值时 satisfies 编译红先行；此处快照同步扩值后与映射键域比对即恢复双向覆盖。
 * [subagent-observability §3.3.8] partially_succeeded 第五值（u-foundation 落词表，
 * u8 同批同步本快照——u4 场景 2 GUI 呈现核对项承接独立档视觉定稿）。
 */
const OUTCOME_SNAPSHOT = ['done', 'failed', 'cancelled', 'time_limited', 'partially_succeeded'] as const satisfies readonly WorkflowRunOutcome[]

const sorted = (values: readonly string[]): string[] => [...values].sort()

function subagent(overrides: Partial<SubagentRecord> & { subagentId: string }): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'reviewer',
    slug: 'rv',
    task: 'review it',
    status: 'idle',
    ...overrides,
  }
}

function workflowRecord(outcome: WorkflowRunOutcome | undefined, status: 'running' | 'done' = 'done'): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'flow',
    status,
    startedAt: new Date(0).toISOString(),
    agentCalls: [],
    stateFilePath: '',
    outcome,
  }
}

describe('WORKFLOW_TONE_BY_OUTCOME 全集锁（[W2 D8] workflow tone 三分）', () => {
  it('映射键域 ≡ outcome 词表快照（词表扩值漏配 → satisfies 编译红；快照比对为第二道）', () => {
    expect(sorted(Object.keys(WORKFLOW_TONE_BY_OUTCOME))).toEqual(sorted(OUTCOME_SNAPSHOT))
  })

  it('四值三分行为（[D2] 后）：done 绿 / failed 红 / cancelled 与 time_limited 同落中性暗；[subagent-observability §3.3.8] partially_succeeded 独立档初值 = 中性暗（视觉定稿归 u4）', () => {
    expect(WORKFLOW_TONE_BY_OUTCOME.done).toBe('bg-success')
    expect(WORKFLOW_TONE_BY_OUTCOME.failed).toBe('bg-danger')
    expect(WORKFLOW_TONE_BY_OUTCOME.cancelled).toBe('bg-neutral-dim opacity-50')
    expect(WORKFLOW_TONE_BY_OUTCOME.time_limited).toBe('bg-neutral-dim opacity-50')
    expect(WORKFLOW_TONE_BY_OUTCOME.partially_succeeded).toBe('bg-neutral-dim opacity-50')
  })

  it('workflowToneClass：done 读 outcome 四值驱动，running 恒 accent（不读 reason）；[D2] interrupted 暂停态走中性暗专属条目', () => {
    expect(workflowToneClass(workflowRecord('done'))).toBe('bg-success')
    expect(workflowToneClass(workflowRecord('failed'))).toBe('bg-danger')
    expect(workflowToneClass(workflowRecord('cancelled'))).toBe('bg-neutral-dim opacity-50')
    expect(workflowToneClass(workflowRecord('time_limited'))).toBe('bg-neutral-dim opacity-50')
    expect(workflowToneClass(workflowRecord('failed', 'running'))).toBe('bg-accent')
    // [D2] status 三态 interrupted（暂停态，非终局）：中性暗（不占 accent / 不作成败断言）
    expect(workflowToneClass(workflowRecord(undefined, 'interrupted'))).toBe('bg-neutral-dim opacity-50')
  })

  it('workflowToneClass：done + outcome 缺省（v1 存量快照）→ 中性暗（数据缺口不作成败断言）', () => {
    expect(workflowToneClass(workflowRecord(undefined))).toBe('bg-neutral-dim opacity-50')
  })

  it('词表外键索引 = 编译红（全集锁活性锚；运行层无该键）', () => {
    // @ts-expect-error 词表外键不在映射键域（satisfies Record 锁——词表扩值漏配即此形态的编译红）
    expect(WORKFLOW_TONE_BY_OUTCOME['phantom' as string]).toBeUndefined()
  })
})

describe('中文显示名词表单源（[W2 D8] WORKFLOW_RUN_OUTCOME_LABELS 消费接线）', () => {
  it('逐值显示名断言（[D2] 后：成功/失败/已取消/已超时/部分成功——shared 常量为唯一权威，消费方零翻译）', () => {
    expect(WORKFLOW_RUN_OUTCOME_LABELS.done).toBe('成功')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.failed).toBe('失败')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.cancelled).toBe('已取消')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.time_limited).toBe('已超时')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.partially_succeeded).toBe('部分成功')
  })

  it('「已取消」（主动）与「已超时」（预算超时）禁混用锚：显示名两两互异（[subagent-observability §3.3.8] 扩第五值后同锚）', () => {
    const labels = Object.values(WORKFLOW_RUN_OUTCOME_LABELS)
    expect(sorted(labels)).toEqual(sorted(['成功', '失败', '已取消', '已超时', '部分成功']))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('workflowStatusLabel：done+outcome → 词表取名；running / interrupted / outcome 缺省 → undefined（不出 hover 文案）', () => {
    expect(workflowStatusLabel(workflowRecord('done'))).toBe('成功')
    expect(workflowStatusLabel(workflowRecord('failed'))).toBe('失败')
    expect(workflowStatusLabel(workflowRecord('cancelled'))).toBe('已取消')
    expect(workflowStatusLabel(workflowRecord('time_limited'))).toBe('已超时')
    expect(workflowStatusLabel(workflowRecord('failed', 'running'))).toBeUndefined()
    expect(workflowStatusLabel(workflowRecord(undefined))).toBeUndefined()
    // [D2] interrupted 暂停态非终局——不出终局 hover 文案（「已中断（可续跑）」显示归 status 徽标面）
    expect(workflowStatusLabel(workflowRecord(undefined, 'interrupted'))).toBeUndefined()
  })
})

describe('SUBAGENT_DOT_RULES 全集锁（[W2 D8] 状态点规则按 status 分组）', () => {
  it('分组键域 ≡ SubagentStatus 词表全集（词表扩值漏配 → 本断言红 + satisfies 编译红）', () => {
    expect(sorted(Object.keys(SUBAGENT_DOT_RULES))).toEqual(sorted(SUBAGENT_STATUS_ALL))
  })

  it('失败红先于完成绿兜底：running+failed 与 idle+failed 均红点（[subagent-observability u8] 迁移期回落分支——旧推断存储值 + legacy closed 注入族，新判据主锚在 subagent-bucket.test.ts 四形态）', () => {
    expect(subagentDotClass(subagent({ subagentId: 'r1', status: 'running', stopReason: 'failed' }))).toBe('bg-danger')
    expect(subagentDotClass(subagent({ subagentId: 'r2', status: 'idle', stopReason: 'failed' }))).toBe('bg-danger')
  })

  it('[subagent-observability u8] 失败红点新判据锚：lastRound.failure 主导（failure 非空且非 user.cancelled → 红；user.cancelled / 被接管 → 中性暗；stop 停因无失败分类 → 绿兜底）', () => {
    expect(subagentDotClass(subagent({ subagentId: 'n1', status: 'idle', lastRound: { engineStopReason: 'error', failure: { class: 'provider', kind: 'rate_limited', retryable: 'conditional', raw: 'rpm 101/100' } } }))).toBe('bg-danger')
    expect(subagentDotClass(subagent({ subagentId: 'n2', status: 'idle', lastRound: { engineStopReason: 'aborted', failure: { class: 'user', kind: 'cancelled', retryable: false, raw: 'user aborted' } } }))).toBe('bg-neutral-dim opacity-50')
    expect(subagentDotClass(subagent({ subagentId: 'n3', status: 'idle', lastRound: { promptDisposition: 'handled' } }))).toBe('bg-neutral-dim opacity-50')
    expect(subagentDotClass(subagent({ subagentId: 'n4', status: 'idle', lastRound: { engineStopReason: 'stop', result: 'ok' } }))).toBe('bg-success')
  })

  it('中断族中性暗：cancelled / interrupted / interrupted-by-restart / interrupted-by-parent', () => {
    for (const stopReason of ['cancelled', 'interrupted', 'interrupted-by-restart', 'interrupted-by-parent']) {
      expect(subagentDotClass(subagent({ subagentId: `i-${stopReason}`, status: 'idle', stopReason }))).toBe('bg-neutral-dim opacity-50')
    }
  })

  it('[W2 D8] reopened 中性色修正：idle+reopened 是「已重开待续」非成功 → 中性暗（原绿点兜底退役）', () => {
    expect(subagentDotClass(subagent({ subagentId: 'r3', status: 'idle', stopReason: 'reopened' }))).toBe('bg-neutral-dim opacity-50')
  })

  it('正常收尾绿兜底与 running 非死亡组合 accent 兜底', () => {
    expect(subagentDotClass(subagent({ subagentId: 'r4', status: 'idle' }))).toBe('bg-success')
    expect(subagentDotClass(subagent({ subagentId: 'r5', status: 'running', stopReason: 'cancelled' }))).toBe('bg-accent')
  })

  it('词表外 status 分组索引 = 编译红（全集锁活性锚；运行层无该组）', () => {
    // @ts-expect-error 词表外键不在规则表键域（satisfies Record 锁——词表扩值漏配即此形态的编译红）
    expect(SUBAGENT_DOT_RULES['phantom' as string]).toBeUndefined()
  })
})


// ══════════════ 源: src/__tests__/fg5-message-stream.test.ts ══════════════
// @vitest-environment node

/**
 * FG5 单测 —— message-stream 回合分组纯逻辑 + chat store 块类型扩展。
 *
 * 覆盖：
 * - groupTurns：扁平 messages → 回合（user 开启 + assistant 归入，纯文字无折叠条）
 * - countThinking/countToolCalls/hasFailedTool：badge 统计 + 失败检测
 * - chat store：thinking/tool_call 流式块追加、hydrate 历史注入、error 块
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/root-node.test.ts（fg5-message-stream 节）
 */
import {
  toRenderItems,
  countThinking,
  countToolCalls,
  hasFailedTool,
} from '@/composables/logic/messageTurns'
import { useChatStore } from '@/stores/chat'
import * as mockApi from '@taiji/core/transport/mock'
import type { MessageTurn } from '@/composables/logic/messageTurns'

const NOW = Date.now()

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: NOW }
}
function assistantMsg(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content, status: 'complete', timestamp: NOW, ...extra }
}
function systemMsg(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'system', content, status: 'complete', timestamp: NOW, ...extra }
}


/** groupTurns 无调用点的导出已删（审计候选 1）——测试用回合透镜 = toRenderItems 的 turn 项提取。 */
function groupTurns(messages: Message[]): MessageTurn[] {
  return toRenderItems(messages)
    .filter((i): i is { kind: 'turn'; turn: MessageTurn } => i.kind === 'turn')
    .map((i) => i.turn)
}

describe('FG5 groupTurns 回合分组', () => {
  it('user + assistant → 单回合（含 user 起点与 assistant 收尾）', () => {
    const turns = groupTurns([userMsg('u1', 'hi'), assistantMsg('a1', 'hello')])
    expect(turns).toHaveLength(1)
    expect(turns[0].user?.id).toBe('u1')
    expect(turns[0].assistants).toHaveLength(1)
    expect(turns[0].assistants[0].content).toBe('hello')
  })

  it('多 user 消息 → 每个 user 开启新回合', () => {
    const turns = groupTurns([
      userMsg('u1', 'q1'),
      assistantMsg('a1', 'r1'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0].user?.id).toBe('u1')
    expect(turns[1].user?.id).toBe('u2')
  })

  it('纯文字回合（无 thinking/tool）→ hasFoldable=false（无折叠条）', () => {
    const turns = groupTurns([userMsg('u1', 'q'), assistantMsg('a1', '纯文字回答')])
    expect(turns[0].hasFoldable).toBe(false)
  })

  it('含 toolCalls 的回合 → hasFoldable=true', () => {
    const turns = groupTurns([
      userMsg('u1', '读文件'),
      assistantMsg('a1', '已读', {
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'read',
            input: {},
            status: 'completed',
            startTime: NOW,
          },
        ],
      }),
    ])
    expect(turns[0].hasFoldable).toBe(true)
    expect(countToolCalls(turns[0])).toBe(1)
  })

  it('含 thinking 块 → countThinking 统计', () => {
    const turns = groupTurns([
      userMsg('u1', '思考'),
      assistantMsg('a1', '结论', {
        thinking: [{ id: 'th1', content: '推理过程', collapsed: true }],
      }),
    ])
    expect(turns[0].hasFoldable).toBe(true)
    expect(countThinking(turns[0])).toBe(1)
  })

  it('失败的 tool → hasFailedTool=true', () => {
    const turns = groupTurns([
      userMsg('u1', '提交'),
      assistantMsg('a1', '失败', {
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'bash',
            input: {},
            output: 'EBUSY',
            status: 'error',
            startTime: NOW,
          },
        ],
      }),
    ])
    expect(hasFailedTool(turns[0])).toBe(true)
  })

  it('最后一条 assistant streaming → isStreaming=true（其余 false）', () => {
    const turns = groupTurns([
      userMsg('u1', 'q1'),
      assistantMsg('a1', 'r1'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', '正在', { status: 'streaming' }),
    ])
    expect(turns[0].isStreaming).toBe(false)
    expect(turns[1].isStreaming).toBe(true)
  })

  // CW wave session-active-ssot T4：forceWorking（subagent 虚拟 session 强制 streaming 态）
  // 映射到最后一个 turn 的 isStreaming（重命名自 isWorking）。
  it('toRenderItems forceWorking=true → 最后一个 turn isStreaming=true（subagent 强制态）', () => {
    const items = toRenderItems(
      [
        userMsg('u1', 'q1'),
        assistantMsg('a1', 'r1', { status: 'complete' }), // status complete，靠 forceWorking 强制
      ],
      /* forceWorking */ true,
    )
    const turn = items[0]
    expect(turn.kind).toBe('turn')
    if (turn.kind === 'turn') {
      // forceWorking 让最后 turn 的 isStreaming=true，即便 status 非 streaming
      expect(turn.turn.isStreaming).toBe(true)
    }
  })

  it('首条 assistant 无前置 user → 自启回合（边缘情况）', () => {
    const turns = groupTurns([assistantMsg('a1', '无前置')])
    expect(turns).toHaveLength(1)
    expect(turns[0].user).toBeNull()
    expect(turns[0].assistants[0].id).toBe('a1')
  })

  // P2-1（WP-L3-08）：steer 续轮产生多 assistant 同回合，
  // Turn.vue 仅最后一条作收尾 summary，前序 content 折进 trace（isMidAssistant）。
  it('多 assistant 同回合（steer 续轮）→ 前序归入，末条作收尾', () => {
    const turns = groupTurns([
      userMsg('u1', '改一下登录'),
      assistantMsg('a1', '正在处理 schema…'), // steer 前的中间产出
      assistantMsg('a2', '已将 AuthService.login 改为 async。'), // 收尾
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0].assistants).toHaveLength(2)
    // Turn.vue 的 isMidAssistant(idx) = idx < length-1 → a1 是中间，a2 是收尾
    const last = turns[0].assistants[turns[0].assistants.length - 1]
    expect(last.id).toBe('a2')
    expect(last.content).toBe('已将 AuthService.login 改为 async。')
    // 收尾 summary 恒显（draft §4：收尾位固定不折叠）
    expect(turns[0].assistants[0].content).toBe('正在处理 schema…')
  })

  // W07-C：system 消息（compaction/branch）作独立项穿插，不归入 turn
  it('toRenderItems：system 消息穿插在 turn 之间，groupTurns 过滤掉 system', () => {
    const items = toRenderItems([
      userMsg('u1', 'q'),
      assistantMsg('a1', 'r'),
      systemMsg('s1', 'system notice'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    // 顺序：turn(u1+a1) → systemNotice(s1) → turn(u2+a2)
    expect(items.map((i) => i.kind)).toEqual(['turn', 'systemNotice', 'turn'])
    const sysItem = items[1]
    if (sysItem.kind !== 'systemNotice') throw new Error('expected systemNotice item')
    expect(sysItem.message.content).toBe('system notice')
    // groupTurns 过滤掉 system，只剩 2 个 turn
    const turns = groupTurns([
      userMsg('u1', 'q'),
      assistantMsg('a1', 'r'),
      systemMsg('s1', 'bash'),
      userMsg('u2', 'q2'),
      assistantMsg('a2', 'r2'),
    ])
    expect(turns).toHaveLength(2)
  })
})

describe('FG5 chat store 块类型扩展', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('hydrate 注入历史且标记（重复调用幂等）', () => {
    const store = useChatStore()
    const history = [userMsg('u1', '历史'), assistantMsg('a1', '历史回答')]
    store.hydrate('s1', history)
    store.hydrate('s1', history) // 重复不覆盖
    expect(store.isHydrated('s1')).toBe(true)
    expect(store.getMessages('s1')).toHaveLength(2)
  })

  it('hydrate 深拷贝：外部突变不污染 store', () => {
    const store = useChatStore()
    const history = [userMsg('u1', '原内容')]
    store.hydrate('s1', history)
    history[0].content = '改了'
    expect(store.getMessages('s1')[0].content).toBe('原内容')
  })

  it('applyMessageEvent 处理 thinking 块（start + delta）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.applyMessageEvent('sx', {
      type: 'message.thinking_start',
      payload: { sessionId: 'sx', thinkingId: 'th1' },
    })
    store.applyMessageEvent('sx', {
      type: 'message.thinking_delta',
      payload: { sessionId: 'sx', delta: '推理' },
    })
    const msgs = store.getMessages('sx')
    expect(msgs[0].thinking).toHaveLength(1)
    expect(msgs[0].thinking?.[0].content).toBe('推理')
  })

  it('applyMessageEvent 处理 tool_call 块（start + end）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.applyMessageEvent('sx', {
      type: 'message.tool_call_start',
      payload: { sessionId: 'sx', entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } },
    })
    store.applyMessageEvent('sx', {
      type: 'message.tool_call_end',
      payload: { sessionId: 'sx', entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 0 } } },
    })
    const msgs = store.getMessages('sx')
    expect(msgs[0].toolCalls).toHaveLength(1)
    expect(msgs[0].toolCalls?.[0].status).toBe('completed')
  })

  it('complete with stopReason:error → status:error（错误块）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.message_start',
      payload: { sessionId: 'sx', messageId: 'a1' },
    })
    store.applyMessageEvent('sx', {
      type: 'message.complete',
      payload: { sessionId: 'sx', stopReason: 'error' },
    })
    expect(store.getMessages('sx')[0].status).toBe('error')
  })

  // ── W05-A: 4 个新 case（纯字段）─────────────────────────────────

  it('thinking_end 给最后 ThinkingBlock 设 endTime', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', { type: 'message.thinking_start', payload: { sessionId: 'sx', thinkingId: 'th1' } })
    store.applyMessageEvent('sx', { type: 'message.thinking_delta', payload: { sessionId: 'sx', delta: '推理' } })
    expect(store.getMessages('sx')[0].thinking?.[0].endTime).toBeUndefined()
    store.applyMessageEvent('sx', { type: 'message.thinking_end', payload: { sessionId: 'sx' } })
    expect(store.getMessages('sx')[0].thinking?.[0].endTime).toBeTypeOf('number')
  })

  it('tool_call_update 更新 ToolCall.detail（对齐生产端，只读 detail）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', { type: 'message.tool_call_start', payload: { sessionId: 'sx', entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'bash', arguments: {}, timestamp: new Date(0).toISOString() } } })
    // string detail
    store.applyMessageEvent('sx', { type: 'message.tool_call_update', payload: { sessionId: 'sx', toolCallId: 'tc1', detail: '执行中…' } })
    expect(store.getMessages('sx')[0].toolCalls?.[0].detail).toBe('执行中…')
    // object detail
    store.applyMessageEvent('sx', { type: 'message.tool_call_update', payload: { sessionId: 'sx', toolCallId: 'tc1', detail: { progress: 50 } } })
    expect(store.getMessages('sx')[0].toolCalls?.[0].detail).toEqual({ progress: 50 })
  })

  it('complete.usage 不再回填消息（D3 规则 5 退役）；usage 由 message_end assistant 载荷承担', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', {
      type: 'message.complete',
      payload: { sessionId: 'sx', stopReason: 'complete', usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 } },
    })
    // 回合级 complete.usage 不再覆盖末位 assistant（定稿重建按每条消息的 entry 载荷写入，
    // 覆盖会把 turn 聚合值错误摊到单条消息——规则 5 退役锚）
    expect(store.getMessages('sx')[0].usage).toBeUndefined()
    // message_end(assistant) 帧载荷回填 usage（live 与 reload 同源同值，apply-entry-convert usageField）
    store.applyMessageEvent('sx', {
      type: 'message.message_end',
      payload: {
        sessionId: 'sx',
        messageId: 'a1',
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input: 120, output: 80 }, stopReason: 'stop', timestamp: 0 },
        },
      },
    } as never)
    expect(store.getMessages('sx')[0].usage).toEqual({ inputTokens: 120, outputTokens: 80 })
  })

  it('message.status 接收不崩（运行态，不改 Message.status）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', { type: 'message.status', payload: { sessionId: 'sx', status: 'steered', detail: '已转向' } })
    // status 仍是 streaming（message.status 是运行过程态，与 Message.status 正交）
    expect(store.getMessages('sx')[0].status).toBe('streaming')
  })

  // ── W06-B: store 级状态（retry/queue）───────────────────────────

  it('auto_retry_start 设置 retryState，auto_retry_end 清空', () => {
    const store = useChatStore()
    expect(store.getRetryState('sx')).toBeUndefined()
    store.applyMessageEvent('sx', {
      type: 'message.auto_retry_start',
      payload: { sessionId: 'sx', attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'timeout' },
    })
    expect(store.getRetryState('sx')).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 500, errorMessage: 'timeout' })
    store.applyMessageEvent('sx', {
      type: 'message.auto_retry_end',
      payload: { sessionId: 'sx', success: true, attempt: 2 },
    })
    expect(store.getRetryState('sx')).toBeUndefined()
  })

  /**
   * [u3c/u5a 退役] queue_update 全族用例（8 条：queueStates 置位/清空、drain 驱动 appendUser、
   * 重复文本/跨类型计数 diff、message_start 时序、retry/queue session 隔离）随投递所有权内核
   * 整体退役——设计 §3.1 删除范围 + §3.4+ 接管归属表：
   * - queue_update 帧降级为内核内部回执（u3b 删除 message.queue_update handler），不再直驱
   *   renderer UI，也不再写 store 快照分区（[u5a] 该分区已删除）/ 驱动 pendingBuffer 计数路径（pushPending/
   *   countDrained/drainN）；
   * - 投递入流改由「送达回执（message_end(user) 裸标记 id 精确匹配）+ reducer 通路」承担
   *   （替代计数 FIFO 文本匹配——重复文本/跨类型误配面从机制上消除）。
   * 覆盖去向：core chat __tests__/effect-types.test.ts 的 effects-delivery-receipt 合并节
   * （回执命中/幂等/direct 豁免）+ core chat __tests__/store-merged-merged.test.ts 的 useChat
   * 合并节（session.delivery 帧消费与 morph）+ renderer 队列区新用例（__tests__/panel/
   * session-trace/trace-inspector.test.ts 的 queue-bubble-s8 合并节 / __tests__/composables/
   * queue-detail-bundle.test.ts 的 use-queue-rows 合并节）。
   */
  it('queue_update 不再写 store（帧降级为内核内部回执：零快照、零 pendingBuffer 消费）', () => {
    const store = useChatStore()
    // [B1 退役] 前身 pushPending 预置已删（无暂存 API）——本用例只锁「帧零落点」结构性终态
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: ['继续'], followUp: ['下一步'] },
    })
    // 置位路径退役：帧到达不产生任何 store 落点（[u5a] queueStates 分区及其读 API 已删除，
    // 前身 getQueueState 断言随分区一并移除——无字段可查即结构性保证）
    // drain 路径退役：buffered 条目不再经 queue_update 差集入流（其入流由送达回执承担）
    store.applyMessageEvent('sx', {
      type: 'message.queue_update',
      payload: { sessionId: 'sx', steering: [] },
    })
    expect(store.getMessages('sx')).toHaveLength(0)
  })

  // ── W07-C: shared 类型扩展（compaction/branch 作 system 提示行）──

  it('compactionSummary 作 system 消息追加', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.compactionSummary',
      payload: { sessionId: 'sx', summary: '压缩完成', tokensBefore: 50000 },
    })
    const msg = store.getMessages('sx')[0]
    expect(msg.role).toBe('system')
    // [W6] compactionSummary 直插已 entry 化（与 replay 同路径）——compactionSummary 携带
    // timestamp（帧缺省时取当前时刻），与文件侧重放形态一致
    expect(msg.compactionSummary).toMatchObject({ summary: '压缩完成', tokensBefore: 50000 })
    expect(typeof msg.compactionSummary?.timestamp).toBe('number')
  })

  it('branchSummary 作 system 消息追加', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.branchSummary',
      payload: { sessionId: 'sx', summary: '新分支', fromId: 'msg-9' },
    })
    const msg = store.getMessages('sx')[0]
    expect(msg.role).toBe('system')
    // [D13 renderer-deepening] branchSummary 直插已 entry 化（与 replay 同路径）——
    // branchSummary 恒带 timestamp（帧缺省时取当前时刻），与文件侧重放形态一致；
    // content fallback 收敛 reducer 语义（summary 缺失 → 空串，原 'Branched' 占位消灭）
    expect(msg.content).toBe('新分支')
    expect(msg.branchSummary).toMatchObject({ summary: '新分支', fromId: 'msg-9' })
    expect(typeof msg.branchSummary?.timestamp).toBe('number')
  })

  it('mock getHistory 返回 fixture 全字段（G2-006 契约；[u6] 窗口契约三字段）', async () => {
    const s1 = await mockApi.chat.getHistory('s1')
    // N1 修复：getHistory 返回窗口契约（[u6] legacy historyTruncated 退役，truncated 唯一标志）
    expect(s1.truncated).toBe(false)
    expect(s1.messages.length).toBeGreaterThanOrEqual(2)
    // 含 user / assistant text / tool_call / 失败 tool
    const roles = s1.messages.map((m) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    const withTools = s1.messages.find((m) => (m.toolCalls?.length ?? 0) > 0)
    expect(withTools).toBeTruthy()
  })

  it('mock getHistory 空会话返回空数组', async () => {
    const s3 = await mockApi.chat.getHistory('s3')
    expect(s3.truncated).toBe(false)
    expect(s3.messages).toEqual([])
  })

  // ── W10: FileChanges 通道（applyFileChanges + message.file_changes case）──
  // ADR-0024 D5 重构：baseline diff，isFullSet 恒 true（每次 diff 都是全量结果，全集替换不增量合并）。

  it('message.file_changes accumulating 全集替换（baseline diff 每次 diff 是全量结果）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    // 第一次 diff：写了一个文件
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'src/a.ts', status: 'added', addLines: 10 }],
        changeSetStatus: 'accumulating', isFullSet: true,
      },
    })
    // 第二次 diff：写了两个文件（包含第一次的）—— isFullSet=true 全集替换
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [
          { filePath: 'src/a.ts', status: 'added', addLines: 10 },
          { filePath: 'src/b.ts', status: 'modified', addLines: 3, delLines: 1 },
        ],
        changeSetStatus: 'accumulating', isFullSet: true,
      },
    })
    const msg = store.getMessages('sx')[0]
    // 全集替换：最终结果是第二次的两条，不是增量合并
    expect(msg.fileChanges).toHaveLength(2)
    expect(msg.fileChanges?.map((c) => c.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('accumulating')
  })

  it('message.file_changes ready 全集替换（agent_end 最终对账）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    // accumulating（agent 还在跑）
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'old.ts', status: 'modified' }],
        changeSetStatus: 'accumulating', isFullSet: true,
      },
    })
    // ready 全集替换（agent_end 最终 diff 发现完全不同的文件集）
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'new1.ts', status: 'added' }, { filePath: 'new2.ts', status: 'deleted' }],
        changeSetStatus: 'ready', isFullSet: true,
      },
    })
    const msg = store.getMessages('sx')[0]
    expect(msg.fileChanges).toHaveLength(2)
    expect(msg.fileChanges?.map((c) => c.filePath).sort()).toEqual(['new1.ts', 'new2.ts'])
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('ready')
  })

  it('message.changeSetInvalidated 把该 session 的 changeSet 推 superseded（commit 后过期）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    // 先有一条 ready changeSet
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'src/a.ts', status: 'added', addLines: 10 }],
        changeSetStatus: 'ready', isFullSet: true,
      },
    })
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('ready')
    // git commit 成功 → runtime 广播 changeSetInvalidated
    store.applyMessageEvent('sx', {
      type: 'message.changeSetInvalidated',
      payload: { sessionId: 'sx', reason: 'committed' },
    })
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('superseded')
  })

  it('message.changeSetInvalidated 不覆盖已 resolved 的 changeSet（保留审查记录）', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', { type: 'message.message_start', payload: { sessionId: 'sx', messageId: 'a1' } })
    store.applyMessageEvent('sx', {
      type: 'message.file_changes',
      payload: {
        sessionId: 'sx', messageId: 'a1',
        fileChanges: [{ filePath: 'src/a.ts', status: 'added', addLines: 10 }],
        changeSetStatus: 'ready', isFullSet: true,
      },
    })
    // 用户已 accept（标 resolved）
    store.setChangeSetStatus('sx', 'a1', 'resolved')
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('resolved')
    // commit 后广播失效 —— resolved 不应被覆盖
    store.applyMessageEvent('sx', {
      type: 'message.changeSetInvalidated',
      payload: { sessionId: 'sx', reason: 'committed' },
    })
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('resolved')
  })

  it('setChangeSetStatus 驱动审查态（partially-reviewed/resolved）', () => {
    const store = useChatStore()
    store.setChangeSetStatus('sx', 'a1', 'partially-reviewed')
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('partially-reviewed')
    store.setChangeSetStatus('sx', 'a1', 'resolved')
    expect(store.getChangeSetStatus('sx', 'a1')).toBe('resolved')
  })

  // ── customStart（pi CustomMessage 注入，如 subagent-bg-notify）──
  it('customStart: subagent-bg-notify 单条 → system 消息 + customType + 原始 details 保留', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'subagent-bg-notify',
        content: 'Subagent "coder" (job-1) completed.',
        details: {
          id: 'job-1',
          status: 'done',
          agent: 'coder',
          model: 'claude-4.5',
          result: 'Done.',
          startedAt: 1000,
          endedAt: 13000,
        },
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].customType).toBe('subagent-bg-notify')
    // bgNotify 字段已删（§3.3.6），details 原始透传保留
    expect(msgs[0].details).toEqual({
      id: 'job-1',
      status: 'done',
      agent: 'coder',
      model: 'claude-4.5',
      result: 'Done.',
      startedAt: 1000,
      endedAt: 13000,
    })
  })

  it('customStart: 其他 customType → system 消息 + customType，无 details 透传外字段', () => {
    const store = useChatStore()
    store.applyMessageEvent('sx', {
      type: 'message.customStart',
      payload: {
        sessionId: 'sx',
        customType: 'other-extension',
        content: 'hello',
        details: { foo: 'bar' },
      },
    })
    const msgs = store.getMessages('sx')
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].customType).toBe('other-extension')
  })

  it('customStart 产出的 system 消息经 toRenderItems 穿插为独立项（不并入 turn）', () => {
    const store = useChatStore()
    // 先建一个 user turn
    store.applyMessageEvent('sx', { type: 'message.customStart', payload: { sessionId: 'sx', customType: 'x', content: '' } })
    const items = toRenderItems(store.getMessages('sx'))
    expect(items.map((i) => i.kind)).toEqual(['systemNotice'])
  })
})


// ══════════════ 源: src/__tests__/extension-upgrade.test.ts ══════════════
/**
 * extension domain upgrade / autoUpgrade 测试。
 *
 * TDD Red phase：验证 upgrade() 和 setAutoUpgrade() 发送正确的 WS 消息。
 */

// ws-client / pending mock 与 workspace-store 节共享（见文件头共享 mock 区）：
// transportMock.send 捕获消息并返回 true（boolean 契约），pending 默认工厂值
// 'pid-1' + envelope resolve；本节 beforeEach 覆写 createCommandId→'test-id'、
// register→undefined-resolve（本节不消费 reply envelope）。

import * as extension from '@taiji/core/transport/api/domains/extension'
import * as transport from '@taiji/core/transport/ws-client'
import * as pending from '../../../core/src/transport/api/pending'

describe('extension domain upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pending.createCommandId).mockReturnValue('test-id')
    vi.mocked(pending.register).mockReturnValue(Promise.resolve())
  })

  it('upgrade 发送 extension.upgrade 消息，payload 含 name', () => {
    extension.upgrade('my-extension')
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.upgrade',
      id: 'test-id',
      payload: { name: 'my-extension' },
    })
  })

  // （「upgrade 返回 pending promise」恒真用例已删：任何 request 封装都返回 Promise，
  //  不锁任何行为。）
})

describe('extension domain setAutoUpgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pending.createCommandId).mockReturnValue('test-id')
    vi.mocked(pending.register).mockReturnValue(Promise.resolve())
  })

  it('setAutoUpgrade 发送 extension.setAutoUpgrade 消息，payload 含 name 和 autoUpgrade', () => {
    extension.setAutoUpgrade('my-extension', true)
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.setAutoUpgrade',
      id: 'test-id',
      payload: { name: 'my-extension', autoUpgrade: true },
    })
  })

  it('setAutoUpgrade 禁用时发送 autoUpgrade=false', () => {
    extension.setAutoUpgrade('my-extension', false)
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension.setAutoUpgrade',
      id: 'test-id',
      payload: { name: 'my-extension', autoUpgrade: false },
    })
  })

  // （「setAutoUpgrade 返回 pending promise」恒真用例已删：同上。）
})


// ══════════════ 源: src/__tests__/session-renamed-sync.test.ts ══════════════
/**
 * session push → store 同步测试（renamed / state_changed / thinkingLevelSet 三类推送；
 * 原 session-state-changed-sync.test.ts 已并入本文件——同 SUT ensureStreamSubscription
 * switch 分支、逐字相同 mock 脚手架）。
 *
 * session.renamed（AGENTS.md 规则 #7 Session 隔离）：
 * 锁定 pi 改写 session 名（session_info_changed）经 runtime event-adapter 映射为
 * session.renamed 推送（payload { sessionId, name }），useChat 的 switch 消费后经
 * sessionStore.applySnapshot 同步侧栏 label。事故背景：tui-to-gui-mapping-audit.md:62
 * 标记 session_info_changed 未处理，useChat 的 switch 落到 default:break 丢弃。
 *
 * session.state_changed / session.thinkingLevelSet（W3；[W1 会话架构四层分离] 起写**状态层**）：
 * model.switch 后 runtime 广播 state_changed（modelId + thinkingLevel），Composer 工具条经
 * 状态层跟随；thinkingLevelSet 为独立窄更新通道。两者都不再经 sessionStore.applySnapshot
 * （列表成员资格不得成为状态写入判据——本文件反向锁定该不变量）。
 *
 * mock 策略：vi.hoisted + vi.mock('@/api')（chat.streamSubscribe 捕获回调，手动触发），
 * 真用 useSessionStore（验证 applySnapshot 落点）+ useChat（被测入口）。
 * 注：useChat streamSubscriptions 是模块级单例，同文件各用例 sid 必须唯一。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/root-node.test.ts（session-renamed-sync 节）
 */
// '@/api' mock 工厂解引用的 helper import 必须先于触发工厂执行的 import（useChat 链）求值
// mock 实例（工厂内创建）的清除入口：经 mock 后的 '@/api' 取引用（同 settings quota 域范式）
import { chat as apiChatMock } from '@/api'

type StreamCb = (msg: { type: string; payload: Record<string, unknown> }) => void

// '@/api' mock 与 workspace-store 节共享（见文件头共享 mock 区）——本节消费
// chat.streamSubscribe（回调捕获）与 session.writeSegments 两成员。
// streamCbHolder 已上提至文件头（共享工厂引用）。

import { useChat } from '@/composables/features/chat/useChat'
import { useSessionStore } from '@/stores/session'
import { useSessionLiveStateStore } from '@/stores/session-live-state'

beforeEach(() => {
  setActivePinia(createPinia())
  streamCbHolder.current = null
  vi.mocked(apiChatMock.streamSubscribe).mockClear()
})

/** 往 session store 填一个 session（按 cwd 归组） */
function seedSession(s: SessionSummary): void {
  const store = useSessionStore()
  const group: SessionGroup = { cwd: s.cwd, sessions: [s] }
  store.applySnapshot({ groups: [group] })
}

describe('session.renamed 事件 → store label 同步', () => {
  it('正常 session.renamed（sessionId+name）→ store 对应 session label 更新', async () => {
    seedSession({
      id: 's1',
      label: '旧名字',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
    })
    const chat = useChat()
    // send 触发 ensureStreamSubscription，注册回调（mock 捕获）
    await chat.send('s1', textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    // 模拟 runtime 推送 session.renamed
    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's1', name: 'pi 生成的新名字' } })

    const updated = useSessionStore().list.find((s) => s.id === 's1')
    expect(updated?.label).toBe('pi 生成的新名字')
  })

  it('payload.name 为空字符串 → 跳过，label 不被覆盖（防 pi 推空名覆盖用户 rename）', async () => {
    seedSession({
      id: 's2',
      label: '用户手动起的名',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
    })
    const chat = useChat()
    await chat.send('s2', textToSegments('触发订阅'))

    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's2', name: '' } })

    const updated = useSessionStore().list.find((s) => s.id === 's2')
    expect(updated?.label).toBe('用户手动起的名') // 保持原值，未被空名覆盖
  })

  it('payload.name 为 undefined → 跳过', async () => {
    seedSession({
      id: 's3',
      label: '原名',
      cwd: '/repo',
      status: 'idle',
      lastActiveAt: 100,
    })
    const chat = useChat()
    await chat.send('s3', textToSegments('触发订阅'))

    // event-adapter 对 event.name 为 undefined 时 payload.name 也为 undefined
    streamCbHolder.current!({ type: 'session.renamed', payload: { sessionId: 's3' } })

    const updated = useSessionStore().list.find((s) => s.id === 's3')
    expect(updated?.label).toBe('原名')
  })
})

describe('session.state_changed 事件 → 状态层同步（W1：不经导航列表）', () => {
  it('U14: 正常 state_changed（sessionId + modelId + thinkingLevel）→ 状态层更新', async () => {
    seedSession({
      id: 'sc-1', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100,
    })
    const chat = useChat()
    await chat.send('sc-1', textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 'sc-1',
        modelId: 'anthropic/claude-4',
        thinkingLevel: 'high',
      },
    })

    expect(useSessionLiveStateStore().liveStateOf('sc-1')).toEqual({
      modelId: 'anthropic/claude-4',
      thinkingLevel: 'high',
    })
    // 导航列表不承载状态字段（W3 起 SessionSummary 已无三字段，状态唯一权威 = 状态层，上面已断言）
    expect(useSessionStore().list.find((s) => s.id === 'sc-1')?.label).toBe('test')
  })

  it('thinkingLevel 为 undefined 时只更新 modelId，已缓存档位保留（字段级合并）', async () => {
    seedSession({
      id: 'sc-2', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100,
    })
    const liveStore = useSessionLiveStateStore()
    liveStore.applyLiveState('sc-2', { thinkingLevel: 'low' })
    const chat = useChat()
    await chat.send('sc-2', textToSegments('触发订阅'))

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 'sc-2',
        modelId: 'openai/gpt-4',
        thinkingLevel: undefined,
      },
    })

    expect(liveStore.liveStateOf('sc-2')).toEqual({ modelId: 'openai/gpt-4', thinkingLevel: 'low' })
  })

  it('[W1] 侧栏列表之外的会话 id（btw 线 session id）状态帧同样落地（无列表命中判据）', async () => {
    const vid = 'pi-line-sync' // 线 session id（W4a 后 = pi 真实 id）
    const chat = useChat()
    await chat.send(vid, textToSegments('触发订阅'))

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: { sessionId: vid, modelId: 'line/model', thinkingLevel: 'low' },
    })

    expect(useSessionLiveStateStore().liveStateOf(vid)).toEqual({
      modelId: 'line/model',
      thinkingLevel: 'low',
    })
    // 列表未新增该 id（导航视图不变）
    expect(useSessionStore().list.some((s) => s.id === vid)).toBe(false)
  })

  it('其他 session 的 state_changed 不影响当前 session（按 id 分区）', async () => {
    seedSession({
      id: 'sc-3', label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100,
    })
    const liveStore = useSessionLiveStateStore()
    liveStore.applyLiveState('sc-3', { modelId: 'original', thinkingLevel: 'max' })
    const chat = useChat()
    await chat.send('sc-3', textToSegments('触发订阅'))

    streamCbHolder.current!({
      type: 'session.state_changed',
      payload: {
        sessionId: 'other-session',
        modelId: 'should/not/apply',
        thinkingLevel: 'off',
      },
    })

    expect(liveStore.liveStateOf('sc-3')).toEqual({ modelId: 'original', thinkingLevel: 'max' })
  })
})

describe('session.thinkingLevelSet 事件 → 状态层 thinkingLevel 同步', () => {
  it('U-TLSet-1: payload 含 sessionId + level → 状态层更新 thinkingLevel', async () => {
    // 注：streamSubscriptions 是 useChat 模块级单例，跨用例复用 sid 会跳过订阅，故用唯一 sid。
    const sid = 'tlset-1'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100,
    })
    const liveStore = useSessionLiveStateStore()
    liveStore.applyLiveState(sid, { modelId: 'm', thinkingLevel: 'low' })
    const chat = useChat()
    await chat.send(sid, textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: sid, level: 'high' },
    })

    expect(liveStore.liveStateOf(sid)).toEqual({ modelId: 'm', thinkingLevel: 'high' })
    // 导航列表不写（W3 起 SessionSummary 已无 thinkingLevel，状态唯一权威 = 状态层）
    expect(useSessionStore().list.find((s) => s.id === sid)?.label).toBe('test')
  })

  it('U-TLSet-2: level 缺省时跳过更新', async () => {
    const sid = 'tlset-2'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100,
    })
    const chat = useChat()
    await chat.send(sid, textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: sid, level: undefined },
    })

    expect(useSessionLiveStateStore().liveStateOf(sid)).toBeUndefined()
    expect(useSessionStore().list.find((s) => s.id === sid)?.label).toBe('test')
  })

  it('U-TLSet-3: sessionId 缺省时跳过更新', async () => {
    const sid = 'tlset-3'
    seedSession({
      id: sid, label: 'test', cwd: '/repo', status: 'idle',
      lastActiveAt: 100,
    })
    const chat = useChat()
    await chat.send(sid, textToSegments('触发订阅'))
    expect(streamCbHolder.current).not.toBeNull()

    streamCbHolder.current!({
      type: 'session.thinkingLevelSet',
      payload: { sessionId: undefined, level: 'high' },
    })

    expect(useSessionLiveStateStore().liveStateOf(sid)).toBeUndefined()
    expect(useSessionStore().list.find((s) => s.id === sid)?.label).toBe('test')
  })
})


// ══════════════ 源: src/__tests__/new-task/workspace-store.test.ts ══════════════
// @vitest-environment node

/**
 * workspaceStore 单测 —— W3 前端改接 workspaceStore。
 *
 * 覆盖：
 * - T3.1: defaultCwd = records[0]?.cwd
 * - T3.2: records 空 → defaultCwd undefined
 * - T3.4: RPC reject 降级（records 置 [] 不抛）
 *
 * mock 策略：mock workspaceApi.listRecent 返回值。
 *
 * 单文件多源合并（2 源同装载簇，全 node 环境）：workspace-store（本节，最大源）+
 * session-api——mock 正交（本节 mock '@/api' 门面；session-api 节不 mock @/api，
 * 只 mock core ws-client 与 core pending 相对路径，core domains/session 真实实现
 * 不经门面），零冲突。各节以裸块隔离。
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/root-node.test.ts（workspace-store 节）
 */

import { useWorkspaceStore } from '@/stores/workspace'
import { workspace } from '@/api'

// ══════════ 来源：session-api.test.ts ══════════
// 其 ws-client / core pending mock 与 hoisted 常量在模块顶层（vi.mock 块内声明不被
// hoisting 提升，顶层 create import 期模块图已解析，块内 mock 会失效）
/**
 * sessionApi.create cwd 透传契约单测（#1，T1.1 配套 api 层片段）。
 *
 * 覆盖：
 * - create(cwd) → WS payload 含 cwd 字段（AC-1.1）
 * - create() 无参 → payload 不含 cwd 字段（runtime 回退 process.cwd()，AC-1.2 回归）
 * - create(cwd, label) → label 透传
 *
 * mock 策略：mock core ws-client（捕获 send payload）+ core pending 源文件相对路径
 * （返回可控 id/Promise），验证 session.create 消息 payload 形状。不 mock @/api
 * （直接测 domains/session 真实实现）。request 已下沉 core（tc u1），mock 目标须与
 * core 内相对 import 同一模块 ID 才能拦截。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/root-node.test.ts（session-api 节）
 */

import { create } from '@taiji/core/transport/api/domains/session'

describe('workspace 域 —— 源: src/__tests__/new-task/workspace-store.test.ts', () => {
beforeEach(() => {
  setActivePinia(createPinia())
  mockListRecent.mockReset()
  mockRecord.mockReset()
  mockDefaultSessionDir.mockReset()
  mockSetPinned.mockReset()
  // session-api 节共享复位（transport 清零）+ pending 默认工厂值再锚定
  // （extension 节 beforeEach 会覆写 createCommandId/register，跨节先后不串）
  transportMock.sent.length = 0
  transportMock.send.mockClear()
  vi.mocked(pending.createCommandId).mockReturnValue('pid-1')
  vi.mocked(pending.register).mockReturnValue(
    Promise.resolve({ session: { id: 's1', cwd: '/x', status: 'idle' } as SessionSummary }),
  )
})


// store 现经门面调 workspace.listRecent / workspace.record；mock 后此处即 vi.fn 实例
const mockListRecent = workspace.listRecent as unknown as ReturnType<typeof vi.fn>
const mockRecord = workspace.record as unknown as ReturnType<typeof vi.fn>
const mockDefaultSessionDir = workspace.defaultSessionDir as unknown as ReturnType<typeof vi.fn>
const mockSetPinned = workspace.setPinned as unknown as ReturnType<typeof vi.fn>

function mkRecord(cwd: string, lastUsedAt: number): RecentWorkspaceRecord {
  return { cwd, lastUsedAt, label: cwd.split('/').filter(Boolean).pop() ?? cwd }
}



describe('workspaceStore.load（T3.1 / T3.2）', () => {
  it('T3.1: defaultCwd = records[0]?.cwd（首条记录的 cwd）', async () => {
    mockListRecent.mockResolvedValue([
      mkRecord('/repo-a', 300),
      mkRecord('/repo-b', 200),
    ])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBe('/repo-a')
    expect(store.records).toHaveLength(2)
  })

  it('T3.2: records 空 → defaultCwd undefined', async () => {
    mockListRecent.mockResolvedValue([])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBeUndefined()
    expect(store.records).toEqual([])
  })
})

describe('workspaceStore.load 降级（T3.4）', () => {
  it('RPC reject → records 置 [] 不抛', async () => {
    mockListRecent.mockRejectedValue(new Error('RPC timeout'))
    const store = useWorkspaceStore()
    // 不抛
    await store.load()
    expect(store.records).toEqual([])
    expect(store.defaultCwd).toBeUndefined()
  })

  it('RD-3#4: RPC reject → 补 console.warn + loadError 标记（读失败 ≠ 无历史，可观测）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mockListRecent.mockRejectedValue(new Error('RPC timeout'))
      const store = useWorkspaceStore()
      await store.load()
      // AC-4.5 口径不变：records 置 [] 不抛、不阻断启动（不加错误条/重试）
      expect(store.records).toEqual([])
      // RD-3#4：留痕 + 标记，让「读失败」与「真无历史」在观测范围可分
      expect(store.loadError).toBe('RPC timeout')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[workspace] load failed'),
        'RPC timeout',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('RD-3#4: load 成功 → loadError 清空（失败标记不残留）', async () => {
    const store = useWorkspaceStore()
    mockListRecent.mockRejectedValueOnce(new Error('transient'))
    await store.load()
    expect(store.loadError).toBe('transient')

    mockListRecent.mockResolvedValueOnce([mkRecord('/repo-a', 300)])
    await store.load()
    expect(store.loadError).toBeNull()
    expect(store.records).toHaveLength(1)
  })
})

describe('workspaceStore.record（热更新）', () => {
  it('record(cwd) → 调 api.record 并用返回的最新 records 覆盖 store', async () => {
    const fresh = [mkRecord('/new', 400), mkRecord('/repo-a', 300)]
    mockRecord.mockResolvedValue(fresh)
    const store = useWorkspaceStore()
    await store.record('/new')
    expect(mockRecord).toHaveBeenCalledWith('/new')
    expect(store.records).toEqual(fresh)
    expect(store.defaultCwd).toBe('/new')
  })

  it('record RPC reject → 静默降级不抛（不阻断选目录流程）', async () => {
    mockRecord.mockRejectedValue(new Error('RPC timeout'))
    const store = useWorkspaceStore()
    // 不抛
    await store.record('/new')
  })

  it('record 空串 → noop 不调 api', async () => {
    const store = useWorkspaceStore()
    await store.record('')
    expect(mockRecord).not.toHaveBeenCalled()
  })
})

describe('defaultCwd pinned 过滤（pin 固定目录 wave）', () => {
  it('首条记录 pinned → defaultCwd 取第一条未 pinned 的 cwd（pinned 条目不参与默认 cwd）', async () => {
    const pinned = { ...mkRecord('/pinned', 500), pinned: true }
    mockListRecent.mockResolvedValue([pinned, mkRecord('/normal', 400)])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBe('/normal')
  })

  it('全部记录 pinned → defaultCwd undefined（无可用默认目录）', async () => {
    mockListRecent.mockResolvedValue([{ ...mkRecord('/pinned', 500), pinned: true }])
    const store = useWorkspaceStore()
    await store.load()
    expect(store.defaultCwd).toBeUndefined()
  })
})

describe('workspaceStore.loadDefaultSessionDir（默认会话目录）', () => {
  it('成功 → defaultSessionDir = RPC 返回目录（landing「默认会话」入口数据源）', async () => {
    mockDefaultSessionDir.mockResolvedValue('/data/defaultSession')
    const store = useWorkspaceStore()
    await store.loadDefaultSessionDir()
    expect(mockDefaultSessionDir).toHaveBeenCalledTimes(1)
    expect(store.defaultSessionDir).toBe('/data/defaultSession')
  })

  it('RPC reject → defaultSessionDir 置空串不抛（空串 = 入口隐藏，降级不阻断启动）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mockDefaultSessionDir.mockRejectedValue(new Error('RPC timeout'))
      const store = useWorkspaceStore()
      await store.loadDefaultSessionDir()
      expect(store.defaultSessionDir).toBe('')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('loadDefaultSessionDir failed'),
        expect.any(Error),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('workspaceStore.setPinned（pin/unpin）', () => {
  it('成功且未降级 → records 用回传列表热更新，返回 true', async () => {
    const fresh = [{ ...mkRecord('/pinned-a', 500), pinned: true }, mkRecord('/repo-a', 300)]
    mockSetPinned.mockResolvedValue({ records: fresh, degraded: false })
    const store = useWorkspaceStore()
    const ok = await store.setPinned('/pinned-a', true)
    expect(mockSetPinned).toHaveBeenCalledWith('/pinned-a', true)
    expect(ok).toBe(true)
    expect(store.records).toEqual(fresh)
  })

  it('成功但 degraded=true（超 pin 上限被拒）→ 返回 false，列表以 runtime 回传为准', async () => {
    const unchanged = [mkRecord('/repo-a', 300)]
    mockSetPinned.mockResolvedValue({ records: unchanged, degraded: true })
    const store = useWorkspaceStore()
    const ok = await store.setPinned('/pinned-a', true)
    expect(ok).toBe(false)
    expect(store.records).toEqual(unchanged)
  })

  it('RPC reject → 返回 false 且保留旧 records（stale 降级，与 record 同款不抛）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const stale = [mkRecord('/repo-a', 300)]
      mockSetPinned.mockRejectedValue(new Error('RPC timeout'))
      const store = useWorkspaceStore()
      store.records = stale
      const ok = await store.setPinned('/pinned-a', true)
      expect(ok).toBe(false)
      expect(store.records).toEqual(stale)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('setPinned failed'),
        expect.any(Error),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})


describe('sessionApi.create cwd 透传', () => {
  it('create(cwd) → payload 含 cwd 字段（AC-1.1）', async () => {
    await create('/repo')
    expect(transportMock.send).toHaveBeenCalledTimes(1)
    const msg = transportMock.sent[0]
    expect(msg.type).toBe('session.create')
    expect(msg.payload).toHaveProperty('cwd', '/repo')
  })

  it('create() 无参 → payload 不含 cwd 字段（AC-1.2 回归，runtime 回退）', async () => {
    await create()
    const msg = transportMock.sent[0]
    expect(msg.payload).not.toHaveProperty('cwd')
  })

  it('create(cwd, label) → label 透传，cwd 透传', async () => {
    await create('/repo', 'my-label')
    const msg = transportMock.sent[0]
    expect(msg.payload).toHaveProperty('cwd', '/repo')
    expect(msg.payload).toHaveProperty('label', 'my-label')
  })

  it('create() 无参 → label 也不强制写入（undefined 不写入键）', async () => {
    await create()
    const msg = transportMock.sent[0]
    // label 为 undefined 时同样不写入 payload 键，保持 payload 干净
    expect(msg.payload).not.toHaveProperty('label')
  })

  it('解包 reply envelope .session 返回 SessionSummary', async () => {
    const result = await create('/repo')
    expect(result).toMatchObject({ id: 's1', cwd: '/x', status: 'idle' })
  })
})
})
