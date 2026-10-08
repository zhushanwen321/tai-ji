/**
 * xterm 终端配色主题（硬编码 hex）。
 *
 * 16 色 ANSI 调色板参考 Dracula / Gruvbox Dark 饱和度分布；核心色取值源自
 * v3 时代 tokens，与现行 v6 太极令牌（style.css）已脱钩——改 design tokens
 * 不会联动终端色。
 *
 * 为什么用 hex 字面量不用 CSS 变量：
 * canvas 渲染器读不了 var()（TerminalView.vue 注释），theme 必须写死。
 *
 * TODO: 后续升级方案 A 时加 lightTerminalTheme + watch(theme) 联动。
 */
import type { ITheme } from '@xterm/xterm'

export const darkTerminalTheme: ITheme = {
  /* ── 核心色 ──────────────────────────────────────────
     背景 #000：2026-08-14 裁决遵循 v6-drawer-tabs-demo——纯黑圆角块嵌在 drawer 深底
     （--surface 沉底内容层）上，黑块与深底的明度差即层次（替代旧 #1a1b1f 与容器 bg-black 混搭）。 */
  background: '#000000',
  foreground: '#f7f8fc',
  cursor: '#4f8ef7',
  cursorAccent: '#000000',    // block cursor 内文字色（= bg，反差可见）
  selectionBackground: 'rgba(79, 142, 247, 0.30)',
  selectionInactiveBackground: 'rgba(79, 142, 247, 0.15)',

  /* ── ANSI 16 色 ─────────────────────────────────────── */
  // 标准色（0-7）：色相分布取自 v3 时代状态色（与现行 v6 令牌已脱钩），饱和度参考 Dracula/Gruvbox
  black: '#000000',           // = background
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f5a524',          // ANSI xterm yellow（独立于 design token 体系）
  blue: '#4f8ef7',
  magenta: '#a78bfa',
  cyan: '#38bdf8',
  white: '#a8a8b5',           // 暗色下 white 视觉=灰

  // 亮色（8-15）：提亮一档，参考 Dracula/Gruvbox bright 变体
  brightBlack: '#6272a4',     // Dracula comment 色，常用于注释/弱文字
  brightRed: '#f87171',       // red +1 亮度档
  brightGreen: '#4ade80',     // green +1
  brightYellow: '#fbbf24',    // yellow +1
  brightBlue: '#60a5fa',      // blue +1
  brightMagenta: '#c084fc',   // magenta +1（Dracula 洋红方向偏移）
  brightCyan: '#67e8f9',      // cyan +1
  brightWhite: '#f7f8fc',     // = foreground（亮色下真正的白）
}
