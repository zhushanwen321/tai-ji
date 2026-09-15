/**
 * useTaijiThemes —— v6 太极主题系统（3 暗 + 3 亮）。
 *
 * 主题落地的两层机制：
 * 1. 数据层：SystemSettings (theme: light/dark/system + themePreset: string) → store.setSystem 持久化
 * 2. DOM 层：applySystemToDom 写 <html data-theme> + <html data-theme-preset>，
 *    style.css 的 [data-theme-preset="dailan"/"nuanmo"/"qingmo"/"zhuyin"] 规则覆盖 :root token。
 *
 * 太极主题映射（与 style.css 的 preset 规则严格对应）：
 * - 玄（暗·纯灰·默认）   → theme=dark,    preset=''       （:root 默认，无 preset 覆盖）
 * - 黛蓝（暗·依稀蓝相）  → theme=dark,    preset='dailan'
 * - 暖墨（暗·宣纸暖相）  → theme=dark,    preset='nuanmo'
 * - 皓（亮·宣纸墨黑）    → theme=light,   preset=''       （[data-theme=light] 默认，无 preset 覆盖）
 * - 青墨（亮·宣纸花青）  → theme=light,   preset='qingmo'
 * - 朱印（亮·宣纸朱砂）  → theme=light,   preset='zhuyin'
 *
 * themeSwatch 返回该主题的 4 个代表性色块（accent / fg / surface / bg），用于主题列表行的预览。
 * 取值来源：与 useTheme.ts THEMES 常量逐字对齐（.tmp/v6 真值源），不读运行时 CSS 变量（避免
 * 被页面内临时覆盖的 token 污染预览）。
 */
import type { SystemSettings } from '@taiji/core'

export interface TaijiTheme {
  /** 显示名（含性质后缀，与 demo useTheme.ts THEMES 的 key 一致） */
  label: string
  /** 短名（nav/badge 用，不含括号后缀） */
  shortName: string
  /** 对应 SystemSettings.theme（亮/暗） */
  theme: 'light' | 'dark'
  /** 对应 SystemSettings.themePreset（玄/皓 = ''，其余 4 主题各自 preset id） */
  preset: string
  /** 是否暗色族 */
  dark: boolean
  /** 预览色块：[accent, neutral-fg, surface, bg] */
  swatch: [string, string, string, string]
}

/** 6 太极主题（顺序：3 暗 + 3 亮，与 demo themeEntries 一致） */
export const TAIJI_THEMES: TaijiTheme[] = [
  {
    label: '太极 · 玄（暗 · 纯灰 · 默认）',
    shortName: '玄',
    theme: 'dark',
    preset: '',
    dark: true,
    swatch: ['#cfcfd4', '#dedee2', '#1f1f22', '#131316'],
  },
  {
    label: '太极 · 黛蓝（暗 · 依稀蓝相）',
    shortName: '黛蓝',
    theme: 'dark',
    preset: 'dailan',
    dark: true,
    swatch: ['#9ca9c9', '#dedfe5', '#1e1f25', '#121319'],
  },
  {
    label: '太极 · 暖墨（暗 · 宣纸暖相）',
    shortName: '暖墨',
    theme: 'dark',
    preset: 'nuanmo',
    dark: true,
    swatch: ['#cbc3b3', '#e2dfdb', '#221f1d', '#161413'],
  },
  {
    label: '太极 · 皓（亮 · 宣纸墨黑 · 默认）',
    shortName: '皓',
    theme: 'light',
    preset: '',
    dark: false,
    swatch: ['#36332f', '#2b2a28', '#f7f6f3', '#edebe8'],
  },
  {
    label: '太极 · 青墨（亮 · 宣纸花青）',
    shortName: '青墨',
    theme: 'light',
    preset: 'qingmo',
    dark: false,
    swatch: ['#3d6b6b', '#2b2a28', '#f7f6f3', '#edebe8'],
  },
  {
    label: '太极 · 朱印（亮 · 宣纸朱砂）',
    shortName: '朱印',
    theme: 'light',
    preset: 'zhuyin',
    dark: false,
    swatch: ['#9c4335', '#2b2a28', '#f7f6f3', '#edebe8'],
  },
]

/**
 * 从 SystemSettings 解析当前激活的太极主题。
 * theme='system' 时按 matchMedia 解析为 light/dark（与 applySystemToDom.resolveTheme 一致）。
 */
export function resolveTaijiTheme(s: SystemSettings): TaijiTheme {
  const resolvedTheme: 'light' | 'dark' =
    s.theme === 'system'
      ? typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : 'dark'
      : s.theme
  return (
    TAIJI_THEMES.find((t) => t.theme === resolvedTheme && t.preset === (s.themePreset ?? '')) ??
    TAIJI_THEMES.find((t) => t.theme === resolvedTheme && t.preset === '') ??
    TAIJI_THEMES[0]
  )
}
