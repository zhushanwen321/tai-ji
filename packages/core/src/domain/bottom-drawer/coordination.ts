/**
 * bottom-drawer 协同层 —— 模块级公开 API（display-containers §7.1 协调函数）。
 *
 * 协调函数（§7.1 明文）：openBottomDrawer() / closeBottomDrawer() / toggleBottomDrawer()。
 * 底抽屉本期只有 terminal 一种内容，**不预设 tab 枚举**（§7.1 YAGNI——第二种横向内容
 * 出现时再加，届时它才是「容器」而非「终端面板」）——故无 openXxxTab 语义。
 *
 * 分层（C4）：单向依赖 control.ts（bottomDrawerControl 原语 + getBottomDrawerControlState）
 * 与 layout.ts（全局高度值）。control/layout 不 import 本文件（防循环）。
 * heightPct 的读写与 clamp 见 layout.ts（setBottomDrawerHeightPct / useBottomDrawerLayout /
 * resolveBottomDrawerDisplayPct）。
 */
import {
  bottomDrawerControl,
  getBottomDrawerControlState,
  _resetBottomDrawerControlForTest,
} from './control'
import { _resetBottomDrawerLayoutForTest } from './layout'

/** 打开底抽屉（当前 session 分区；per-session 不持久化，§7.1） */
export function openBottomDrawer(): void {
  bottomDrawerControl.open()
}

/** 关闭底抽屉（当前 session 分区） */
export function closeBottomDrawer(): void {
  bottomDrawerControl.close()
}

/**
 * 切换底抽屉开合（`` ⌃` `` / StatusBar 终端按钮的统一落点，§5.1 规则 4）。
 * 浮层开着时照常切换（被遮罩盖住但状态变化——§5.1 规则 3 语义，编排层不拦截）。
 */
export function toggleBottomDrawer(): void {
  if (getBottomDrawerControlState().isOpen) closeBottomDrawer()
  else openBottomDrawer()
}

/**
 * 清空 bottom-drawer 域全部模块级状态（control 分区 + layout 内存/KV 生命周期）。
 * 测试隔离用；生产代码禁止调用。
 */
export function _resetBottomDrawerForTest(): void {
  _resetBottomDrawerControlForTest()
  _resetBottomDrawerLayoutForTest()
}
