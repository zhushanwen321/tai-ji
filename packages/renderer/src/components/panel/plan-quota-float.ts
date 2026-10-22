/**
 * plan-quota-float 尺寸契约（SSOT）—— 浮层本体（PlanQuotaFloatPanel）宽度与宿主
 * 自动收起阈值（Panel.vue ResizeObserver）的唯一数值来源。
 *
 * 浮层是纯 overlay（悬浮在对话流上方，不挤占消息列/composer 边距——宿主不设让位
 * gutter）；宽度档位只有浮层侧动态 style 消费。
 */
import type { InjectionKey, Ref } from 'vue'

/** 浮层左缘偏移（原 left-3 = 12px）：浮层与 panel 左缘的间距 */
export const QUOTA_FLOAT_INSET_LEFT = 12

/** 展开态浮层宽度（原 w-[276px]）：标题行 + 全部套餐的窗口用量清单 */
export const QUOTA_FLOAT_WIDTH_EXPANDED = 276

/** 收起态把手宽度（原 w-11 = 44px）：竖排文案 + 展开箭头 */
export const QUOTA_FLOAT_WIDTH_COLLAPSED = 44

/** 浮层展开时 panel 内剩余可读宽的下限：低于此值视为浮层遮盖占比过高（触发自动收起）。
 *  模块私有——仅用于下方 QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH 推导，无跨文件消费方。 */
const QUOTA_FLOAT_MIN_VISIBLE_CHAT_WIDTH = 432

/**
 * 浮层自动收起的 panel 总宽阈值（720）= 浮层悬浮遮盖区（inset 12 + 宽 276 = 288px）
 * + 剩余可读宽下限（432）。panel 总宽低于此值时遮盖占比过高（>40%），宿主强制收起
 * （把手档仅占 44px）；宽度恢复后自动展开（用户手动收起优先）。
 */
export const QUOTA_FLOAT_AUTO_COLLAPSE_PANEL_WIDTH =
  QUOTA_FLOAT_INSET_LEFT + QUOTA_FLOAT_WIDTH_EXPANDED + QUOTA_FLOAT_MIN_VISIBLE_CHAT_WIDTH

const QUOTA_FLOAT_REFRESH_PERIOD_MIN = 5
const SEC_PER_MIN = 60
const MS_PER_SEC = 1000

/**
 * 浮层定时统一刷新间隔（5min，2026-10-21 用户拍板）：浮层挂载期间每 5 分钟 bump 一次
 * 刷新 tick，全部套餐一起重查（收起态跳过——不可见期间的查询无人消费）。
 */
export const QUOTA_FLOAT_REFRESH_INTERVAL_MS =
  QUOTA_FLOAT_REFRESH_PERIOD_MIN * SEC_PER_MIN * MS_PER_SEC

/**
 * 浮层定时刷新通道（provide/inject）：宿主浮层的定时器 bump tick，各 PlanQuotaItem
 * watch tick 重新触发本项查询。走 tick 而非清缓存——旧数据保留到新数据到达，
 * 刷新过程无「—」占位闪烁。默认值仅供脱离浮层的独立挂载（单测）使用。
 */
export const QUOTA_FLOAT_REFRESH_TICK_KEY: InjectionKey<Ref<number>> = Symbol('plan-quota-refresh-tick')

