/**
 * applySystemToDom —— 把 SystemSettings 的外观偏好写入 DOM 槽位（data-* 属性）。
 *
 * 从 renderer stores/settings.ts 的 applySystemToDom 提取为 ui 包纯函数（W3 · TC2/IF2）。
 * core 零 DOM 铁律要求此逻辑下沉 ui（非 core），W4 壳侧 watch store.system.theme 调用本函数
 * + 挂/卸 matchMedia listener（theme=system 时 OS 深浅色实时切换）。
 *
 * 槽位（与 style.css 的 [data-theme] / [data-theme-preset] / [data-font-size] 规则对齐）：
 * - theme → <html data-theme>（:root 暗默认 / [data-theme=light] 亮色槽位）
 *   theme='system' 时按 prefers-color-scheme 解析为 light/dark（避免 CSS 再叠一层 media query，统一走 data-theme 单一通道）
 * - themePreset → <html data-theme-preset>（[data-theme-preset] 规则覆盖 --accent；cold-blue 与 :root 默认一致）
 * - fontSize → <html data-font-size>（[data-font-size] 规则调整基础字号，D17）
 * - fontScales → <html data-fs-sidebar/chat/drawer>（[data-fs-*] 规则映射 --font-scale-<region>，
 *   区域根节点 [data-fs-scope] 槽位重声明 --text-* 链实现分区缩放）
 * - locale → 经 deps.setLocale 注入（ui 不持有 i18n 全局实例，W4 壳传入真实 setLocale）
 *
 * SSR 守卫：typeof document === 'undefined' 时早返（不抛错），保证同构安全。
 */
import type { SystemSettings } from '@taiji/core'

export interface ApplySystemToDomDeps {
  /** i18n 实例的 locale 切换函数（W4 壳注入）。缺省不切换 locale。 */
  setLocale?: (locale: string) => void
}

/**
 * 解析 theme='system' 为具体 light/dark。
 * 抽出便于单测：不依赖 DOM 时可直接断言映射逻辑。
 */
export function resolveTheme(theme: SystemSettings['theme']): 'light' | 'dark' {
  if (theme !== 'system') return theme
  // matchMedia 可能在老环境/SSR 缺失，兜底暗色（与应用暗默认一致）
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * 把 SystemSettings 外观偏好同步到 DOM。纯副作用，无返回值。
 */
export function applySystemToDom(
  s: SystemSettings,
  deps?: ApplySystemToDomDeps,
): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement

  root.setAttribute('data-theme', resolveTheme(s.theme))

  // themePreset：缺省 cold-blue（与 DEFAULT_SYSTEM 一致，保证老数据无 themePreset 时回落）。
  root.setAttribute('data-theme-preset', s.themePreset ?? 'cold-blue')

  // fontSize：缺省 medium（D17，与 DEFAULT_SYSTEM 一致）。
  root.dataset.fontSize = s.fontSize ?? 'medium'

  // fontScales：分区字号档位，缺省 medium（×1）。档位→倍率映射在 renderer style.css [data-fs-*] 规则。
  root.dataset.fsSidebar = s.fontScales?.sidebar ?? 'medium'
  root.dataset.fsChat = s.fontScales?.chat ?? 'medium'
  root.dataset.fsDrawer = s.fontScales?.drawer ?? 'medium'

  if (s.locale && deps?.setLocale) {
    deps.setLocale(s.locale)
  }
}
