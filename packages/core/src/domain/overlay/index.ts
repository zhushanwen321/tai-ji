/**
 * overlay 域 barrel —— u-w1-core 实装（state/coordination）落地。
 *
 * SSOT 声明（§7.1）：浮层开合态唯一权威在本域（state.ts 的 overlayState 单例）——
 * Esc 编排器（u-w1-keys）、AppShell 宿主、view 联动（W2）统一经
 * useOverlayControl / getOverlayControlState 读取；写入只经 openOverlay / closeOverlay。
 * renderer workflow-viz-overlay.ts 的 overlayOpen / overlayCurrent 模块级 ref 已退役。
 *
 * W2 已落位（u-w2-browser-mount）：coordination.ts 增 openBrowser(url, sessionId) +
 * closeBrowserOverlayForSession（会话删除级联 UI 关闭编排）。
 */
export * from './types'
export {
  getOverlayControlState,
  useOverlayControl,
  overlayControl,
  _resetOverlayControlForTest,
} from './state'
export {
  openOverlay,
  closeOverlay,
  openBrowser,
  closeBrowserOverlayForSession,
  _resetOverlayForTest,
} from './coordination'
