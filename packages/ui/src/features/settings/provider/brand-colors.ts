/**
 * 内置 provider 品牌色映射（wave-picker-b，slice design T4/D4）。
 *
 * 对齐 demo `.logo-*` 色板（16 色）：品牌色是**品牌标识数据**（非 UI 语义色），
 * 经 inline style 绑定（不占 Tailwind 语义类，避免 no-hardcoded-colors 与 purge 问题）。
 *
 * 色板外 provider（21/37，logoUrl 字段 37/37 死字段无程序化来源）→ hash → 5 语义色
 * fallback（复用 ProviderTemplatePicker 的 AVATAR_CLASSES 机制），视觉稳定不炸色。
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

/** fallback 语义色集合（与 ProviderTemplatePicker AVATAR_CLASSES 同构，5 色循环）
 *  引用 design-tokens CSS 变量（var(--success) 等）：palette/主题切换时自动跟随，
 *  避免与 style.css :root 的 token 值逐字复制漂移（inline style 可用 var()）。 */
const FALLBACK_COLORS = [
  'var(--neutral-ico)',
  'var(--success)',
  'var(--warn)',
  'var(--danger)',
  'var(--info)',
] as const

/** 字符串 hash 乘数（稳定映射用） */
const HASH_MULTIPLIER = 31

/**
 * provider id → 品牌色或 hash fallback 语义色。
 * 纯函数：同 id 恒同结果（色板外 hash 稳定映射）。
 */
export function brandColor(id: string): string {
  const brand = BRAND_COLORS[id]
  if (brand) return brand
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * HASH_MULTIPLIER + id.charCodeAt(i)) >>> 0
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length]
}
