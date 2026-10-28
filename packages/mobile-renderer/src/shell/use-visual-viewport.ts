// use-visual-viewport.ts —— 壳级键盘处理 hook（remote-use-mobile-v2 §6.16，B 级决策）。
//
// 职责：监听 window.visualViewport 的 resize/scroll，把可视区高度写入根节点 CSS 变量
// `--shell-viewport-h`——壳根以 `height: var(--shell-viewport-h, 100dvh)` 消费，键盘弹起时
// 输入条自然贴可视区下沿（iOS Safari 地址栏收缩 / 键盘顶起场景，静态满屏高不可靠的修复形态）。
//
// 注入可测：viewport 参数缺省取 window.visualViewport；测试注入假 viewport 对象驱动
// resize 事件断言变量值（验收条款 5 的注入形态）。
//
// 环境缺省：visualViewport 不存在（极老浏览器）→ 不接管（变量不写入，壳根回退 100dvh），
// 不抛错不告警——能力检测静默降级是该 hook 的正常路径分支，不是错误。
//
// 生命周期：事件解绑挂 onUnmounted（setup 上下文内调用）；非 setup 上下文（纯单测直呼）
// 跳过自动解绑，由调用方对返回的清理函数自行处置。

import { getCurrentInstance, onUnmounted } from 'vue'

/** 壳根可视区高度变量（App.vue 壳根消费；变量名 --shell-* 命名空间 = 壳内私有，不入 --m-* 共享层） */
export const SHELL_VIEWPORT_HEIGHT_VAR = '--shell-viewport-h'

/** window.visualViewport 的结构子集（注入可测的最小面） */
export interface VisualViewportLike {  // oe-exempt:20261026:framework:平台 port 契约（visualViewport 注入抽象，测试经假 viewport 驱动）
  height: number
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

/**
 * 启用可视区高度接管。返回清理函数（解绑监听；setup 上下文内已自动挂 onUnmounted，
 * 返回值供非 setup 调用方手动清理）。
 */
export function useVisualViewport(viewport?: VisualViewportLike | null): () => void {
  const vp: VisualViewportLike | null = viewport ?? window.visualViewport ?? null
  if (vp === null) return () => {}

  const apply = (): void => {
    document.documentElement.style.setProperty(SHELL_VIEWPORT_HEIGHT_VAR, `${vp.height}px`)
  }
  apply()
  vp.addEventListener('resize', apply)
  vp.addEventListener('scroll', apply)

  const cleanup = (): void => {
    vp.removeEventListener('resize', apply)
    vp.removeEventListener('scroll', apply)
    document.documentElement.style.removeProperty(SHELL_VIEWPORT_HEIGHT_VAR)
  }
  if (getCurrentInstance() !== null) onUnmounted(cleanup)
  return cleanup
}
