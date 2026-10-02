/**
 * bottom-drawer 域 barrel —— u-w1-core 实装（control/coordination/layout）落地。
 *
 * 消费面（u-w1-layout）装配义务：
 * - `bindBottomDrawerSessionId(computed(() => usePanelStore().focusedSessionId))`
 *   （bindDrawerSessionId 同款时机——renderer 装配模块顶层）；
 * - 开合：openBottomDrawer / closeBottomDrawer / toggleBottomDrawer + useBottomDrawerControl；
 * - 高度：useBottomDrawerLayout（触发 KV 预载）/ setBottomDrawerHeightPct（拖拽写侧 clamp）/
 *   resolveBottomDrawerDisplayPct（显示期 clamp，不写回）。
 */
export * from './types'
export {
  bindBottomDrawerSessionId,
  getBoundBottomDrawerSessionId,
  getBottomDrawerControlState,
  bottomDrawerControl,
  useBottomDrawerControl,
  _resetBottomDrawerControlForTest,
} from './control'
export {
  clampBottomDrawerHeightPct,
  resolveBottomDrawerDisplayPct,
  loadBottomDrawerHeightOnce,
  getBottomDrawerHeightPct,
  setBottomDrawerHeightPct,
  useBottomDrawerLayout,
  _resetBottomDrawerLayoutForTest,
} from './layout'
export {
  openBottomDrawer,
  closeBottomDrawer,
  toggleBottomDrawer,
  _resetBottomDrawerForTest,
} from './coordination'
