/**
 * bottom-drawer（底抽屉）域类型 —— display-containers §7.1 控制态粒度裁决的类型契约
 * （u-foundation：类型契约不实装行为，实装归 u-w1-core 的 state/coordination）。
 *
 * 粒度裁决（§7.1，对齐右抽屉先例）：
 * - isOpen = per-session 内存分区（useSessionScopedState Map 分区，ADR-0049），**不持久化**
 *   （右抽屉 isOpen 现状同样不持久化——刷新后底抽屉关闭）；
 * - heightPct = **全局布局值**，全局单键持久化（对齐宽度先例 `taiji:drawer-width`——姊妹容器
 *   同构尺寸值同粒度，避免「B 拖动覆盖 A 存储值」的语义未定义）；
 * - 拖拽 clamp 区间 15%–70%（默认 35%，实施期真机校准 §11-1）；显示期钳制不写回持久值。
 *
 * 底抽屉本期只有 terminal 一种内容，**不预设 tab 枚举**（§7.1 YAGNI——第二种横向内容出现时
 * 再加，届时它才是"容器"而非"终端面板"）。注册表条目见 drawer/registry.ts 的 BOTTOM_DRAWER_REGISTRY。
 */

/** per-session 开合控制态（内存分区，不持久化） */
export interface BottomDrawerControlState { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  isOpen: boolean
}

/** 全局布局尺寸值（全局单键持久化，与 per-session 开合态分粒度） */
export interface BottomDrawerLayoutState { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  /** 底抽屉高度百分比（拖拽 clamp 15%–70%，默认 35%；显示期钳制不写回持久值） */
  heightPct: number
}

/** heightPct 全局持久化单键（对齐 `taiji:drawer-width` 先例，姊妹容器同构尺寸值同粒度） */
export const BOTTOM_DRAWER_HEIGHT_KEY = 'taiji:bottom-drawer-height'

/** 拖拽 clamp 下限（%，§7.1 裁决值，实施期真机校准 §11-1） */
export const BOTTOM_DRAWER_HEIGHT_MIN_PCT = 15

/** 拖拽 clamp 上限（%，§7.1 裁决值） */
export const BOTTOM_DRAWER_HEIGHT_MAX_PCT = 70

/** 默认高度（%，§7.1 裁决值） */
export const BOTTOM_DRAWER_HEIGHT_DEFAULT_PCT = 35
