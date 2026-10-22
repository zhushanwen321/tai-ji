/**
 * 内置 provider 品牌色映射（wave-picker-b，slice design T4/D4）。
 *
 * 对齐 demo `.logo-*` 色板（16 色）：品牌色是**品牌标识数据**（非 UI 语义色），
 * 经 inline style 绑定（不占 Tailwind 语义类，避免 no-hardcoded-colors 与 purge 问题）。
 *
 * 色板外 provider（21/37，logoUrl 字段 37/37 死字段无程序化来源）→ hash → 5 语义色
 * 软底 fallback：软底 + 同色文字（badge 范式，与全包 `bg-*-soft text-*` 同语言）。
 * warn 在软底形态是 DESIGN.md §3.5.1 允许的四形态之一（圆点/软底/描边/文字色）——
 * 中间调黄配任何实底字都过不了 AA，故 fallback 一律不做实底。
 *
 * 新增 provider 时：若 demo/品牌有官方色，追加到 BRAND_COLORS 表（保持 16 色对齐 demo 基准）。
 */

/** 品牌色表：provider id → 品牌色 hex（对齐 demo .logo-*）。新增品牌色在此追加。 */
export const BRAND_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d97757',
  google: '#4285f4',
  deepseek: '#4d6bfe',
  groq: '#f55036',
  'github-copilot': '#24292e',
  openrouter: '#6366f1',
  xai: '#1a1a1a',
  mistral: '#ff7000',
  together: '#0f6fff',
  minimax: '#e8473b',
  zai: '#5b6eee',
  'amazon-bedrock': '#232f3e',
  'google-vertex': '#1a73e8',
  moonshotai: '#16181e',
  cerebras: '#e63329',
}

/** fallback 软底 token 集合（5 色循环：底 = color-mix 软底、字 = 同 token；neutral 档取 mid——
 *  小字母的可读档，ico 档对比不足） */
const FALLBACK_TOKENS = ['--neutral-mid', '--success', '--warn', '--danger', '--info'] as const

/** fallback 软底浓度（badge 软底族同档：warn-soft = 14%） */
const FALLBACK_SOFT_PERCENT = 14

/** 字符串 hash 乘数（稳定映射用） */
const HASH_MULTIPLIER = 31

/** WCAG 2.x 相对亮度公式的规范固定值（sRGB 线性化 + 通道权重，非业务魔数） */
const WCAG_LUMINANCE = {
  LINEAR_THRESHOLD: 0.03928,
  LINEAR_DIVISOR: 12.92,
  LINEAR_OFFSET: 0.055,
  LINEAR_SCALE: 1.055,
  GAMMA: 2.4,
  R: 0.2126,
  G: 0.7152,
  B: 0.0722,
} as const

const BYTE_MAX = 255

/** hex → 通道字节的高/中位移（0xRRGGBB：R 右移 16、G 右移 8） */
const CHANNEL_SHIFT = { R: 16, G: 8 } as const

/** 黑白前景对比度相等时的亮度阈值（白字对比 1.05/(L+0.05) = 黑字 (L+0.05)/0.05 的解） */
const FOREGROUND_FLIP_LUMINANCE = 0.179

/** WCAG 2.x 相对亮度（sRGB hex）——品牌底色的前景深浅判据 */
function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const w = WCAG_LUMINANCE
  const chan = [(n >> CHANNEL_SHIFT.R) & BYTE_MAX, (n >> CHANNEL_SHIFT.G) & BYTE_MAX, n & BYTE_MAX].map((c) => {
    const s = c / BYTE_MAX
    return s <= w.LINEAR_THRESHOLD ? s / w.LINEAR_DIVISOR : Math.pow((s + w.LINEAR_OFFSET) / w.LINEAR_SCALE, w.GAMMA)
  })
  return w.R * chan[0] + w.G * chan[1] + w.B * chan[2]
}

export type AvatarColors = { backgroundColor: string; color: string }

/**
 * provider id → 模板头像配色。
 * 品牌色底：前景黑白按对比度择优（白字对比 1.05/(L+0.05)、黑字 (L+0.05)/0.05，L=0.179 处相等；
 * 黑白是内容前景语义色，同 QR 码白底例外条款——品牌 hex 豁免 token 化，前景随底色亮度二选一）。
 * 色板外：语义 token 软底 + 同色文字，id hash 稳定映射（同 id 恒同结果）。
 */
export function brandAvatarColors(id: string): AvatarColors {
  const brand = BRAND_COLORS[id]
  if (brand) {
    const useDarkText = relativeLuminance(brand) > FOREGROUND_FLIP_LUMINANCE
    return { backgroundColor: brand, color: useDarkText ? '#000000' : '#ffffff' }
  }
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * HASH_MULTIPLIER + id.charCodeAt(i)) >>> 0
  const token = FALLBACK_TOKENS[h % FALLBACK_TOKENS.length]
  return {
    backgroundColor: `color-mix(in oklch, var(${token}) ${FALLBACK_SOFT_PERCENT}%, transparent)`,
    color: `var(${token})`,
  }
}
