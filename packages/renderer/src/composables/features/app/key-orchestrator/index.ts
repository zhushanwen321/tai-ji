/**
 * 键盘栈序编排器 barrel（display-containers §6.7 Esc 唯一属主 / §7.5 快捷键接线）。
 *
 * 消费面装配义务（u-w1-keys）：
 * - AppShell 根 setup **首位**调用 useKeyOrchestrator()（§6.7 R4 顺序前提）；
 * - useCloseShortcut（IPC 桥）把 'shortcut' type='close'/'toggle-bottom-drawer' 派发到
 *   handleCmdWShortcut / handleToggleBottomDrawerShortcut；
 * - WorkflowVizOverlay（overlay 宿主）open 时 registerOverlayFocusTrapPanel(panel)、
 *   关闭/卸载时注销（Tab 陷阱目标，W2 随 OverlayShell 归位）。
 */
export { useKeyOrchestrator, handleCmdWShortcut, handleToggleBottomDrawerShortcut, _resetKeyOrchestratorForTest } from './orchestrator'
export { closeTopContainer } from './stack-order'
export { focusComposer } from './focus-composer'
export { registerOverlayFocusTrapPanel, getOverlayFocusTrapPanel, trapTabIntoOverlayPanel } from './overlay-focus-trap'
export { isImeComposing, startImeCompositionTracking } from './ime-composition'
