/**
 * plan-quota-float 尺寸契约（SSOT）—— 浮层本体（PlanQuotaFloatPanel）宽度与宿主让位
 * gutter（Panel.vue panelStyle paddingLeft）的唯一数值来源。
 *
 * 消费方恰好两处且必须成对：浮层侧动态 style 定宽（left/width），宿主侧按收起态
 * 派生 gutter。改任一档宽度只改本文件，两侧同步（手抄配对会静默布局错位）。
 */

/** 浮层左缘偏移（原 left-3 = 12px）：浮层与 panel 左缘的间距 */
export const QUOTA_FLOAT_INSET_LEFT = 12

/** 展开态浮层宽度（原 w-[276px]）：标题行 + 全部套餐的三窗口用量清单 */
export const QUOTA_FLOAT_WIDTH_EXPANDED = 276

/** 收起态把手宽度（原 w-11 = 44px）：竖排文案 + 展开箭头 */
export const QUOTA_FLOAT_WIDTH_COLLAPSED = 44

/** 展开档右缘间距：与左缘对称（12px），浮层内容与消息列的呼吸空间 */
export const QUOTA_FLOAT_GAP_RIGHT_EXPANDED = 12

/** 收起档右缘间距：较展开档收窄（8px）——把手窄（44px），窄间距已够分隔，少占横向空间 */
export const QUOTA_FLOAT_GAP_RIGHT_COLLAPSED = 8

/** 展开档让位 gutter：12 + 276 + 12 = 300（消息列与 composer 同步左缩进量） */
export const QUOTA_FLOAT_GUTTER_EXPANDED =
  QUOTA_FLOAT_INSET_LEFT + QUOTA_FLOAT_WIDTH_EXPANDED + QUOTA_FLOAT_GAP_RIGHT_EXPANDED

/** 收起档让位 gutter：12 + 44 + 8 = 64 */
export const QUOTA_FLOAT_GUTTER_COLLAPSED =
  QUOTA_FLOAT_INSET_LEFT + QUOTA_FLOAT_WIDTH_COLLAPSED + QUOTA_FLOAT_GAP_RIGHT_COLLAPSED
