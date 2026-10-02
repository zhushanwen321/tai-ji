/**
 * 容器栈序层级剥离（display-containers §5.1 规则 3 / §6.7 Esc 属主）。
 *
 * **固定层级序**（裁决：不按开序时间记账，状态模型不存开序）：Esc / ⌘W 沿同一层级序
 * 「浮层 → 底抽屉 → 右抽屉」逐层剥最外层（同层无多开）；⌘W 全关后才关窗（关窗动作在
 * 调用方——handleCmdWShortcut）。
 *
 * 开合态读点 = **动作时刻直读** core 三域 SSOT（§6.7 R4 时序前提：真实输入相邻按键跨宏
 * 任务，Vue flush 必先完成）：浮层 = core/domain/overlay（§7.1 单一权威）、底抽屉 =
 * core/domain/bottom-drawer、右抽屉 = core/domain/drawer。写入只经各域公开协调函数。
 *
 * 焦点契约（§6.7）：任一容器关闭后焦点回 composer（focusComposer）。
 */
import { closeOverlay, getOverlayControlState } from '@taiji/core/domain/overlay'
import { closeBottomDrawer, getBottomDrawerControlState } from '@taiji/core/domain/bottom-drawer'
import { closeDrawer, getDrawerControlState } from '@taiji/core/domain/drawer'
import { focusComposer } from './focus-composer'

/**
 * 剥最外层容器：层级序「浮层 → 底抽屉 → 右抽屉」取第一个开着的关闭并回 composer；
 * 全关态返回 false（⌘W 调用方据此关窗、Esc 不动作）。
 */
export function closeTopContainer(): boolean {
  if (getOverlayControlState().isOpen) {
    closeOverlay()
    focusComposer()
    return true
  }
  if (getBottomDrawerControlState().isOpen) {
    closeBottomDrawer()
    focusComposer()
    return true
  }
  if (getDrawerControlState().isOpen) {
    closeDrawer()
    focusComposer()
    return true
  }
  return false
}
