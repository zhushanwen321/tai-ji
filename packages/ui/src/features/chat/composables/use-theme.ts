/**
 * getCurrentTheme —— 读取当前主题（w6 从 renderer composables/logic/mermaid.ts 抽出）。
 *
 * 纯 DOM 读取（document.documentElement data-theme 属性），无 renderer 依赖。
 * MermaidRenderer 用它决定 mermaid 渲染主题 + 监听主题变化触发重渲。
 */
export function getCurrentTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark'
  const attr = document.documentElement.getAttribute('data-theme')
  return attr === 'light' ? 'light' : 'dark'
}
