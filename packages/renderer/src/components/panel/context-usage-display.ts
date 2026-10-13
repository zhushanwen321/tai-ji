/**
 * context-usage-display —— 上下文用量的显示纯函数（K/M 制格式化 + bar 配色分档）。
 *
 * 消费方：ContextCapacityCard（hover 指标聚合页的容量卡）与 ComposerCapacityBar
 * （composer 顶缘容量细条，ui-optimize 决策 6）。[HISTORICAL] 底栏容量触发器（chip）
 * 已随决策 6 平铺形态退役——原「触发器与浮层内容共用」的动机句随之收窄。
 *
 * 为什么独立成模块（防多处复制）：格式化与分档逻辑存在多个消费方，
 * 「12K / 1.6M 的 K/M 制」与两套 bar 配色分档若各写一份，后续调整口径必然漂移。
 * 零 vue 组件依赖，i18n 无关（纯数值格式化）。
 */

/** 用量分档阈值（<70 accent · 70–90 warning · >90 danger，与设计 §3 一致） */
export const USAGE_HIGH_THRESHOLD = 70
const USAGE_DANGER_THRESHOLD = 90

const K_THRESHOLD = 1000
const M_THRESHOLD = 1_000_000

/**
 * token 数 → 「K/M」格式：<K_THRESHOLD 显原数；≥K_THRESHOLD 显 K；≥M_THRESHOLD 显 M。
 */
export function formatTokens(n: number): string {
  if (n < K_THRESHOLD) return String(n)
  if (n < M_THRESHOLD) {
    const k = n / K_THRESHOLD
    return `${k.toFixed(1).replace(/\.0$/, '')}K`
  }
  const m = n / M_THRESHOLD
  return `${m.toFixed(1).replace(/\.0$/, '')}M`
}

/** 使用率 → bar 配色 token 工具类（分档：danger / warn / accent 渐变默认） */
export function usageBarClass(percent: number): string {
  if (percent > USAGE_DANGER_THRESHOLD) return 'bg-danger'
  if (percent > USAGE_HIGH_THRESHOLD) return 'bg-warn'
  return 'bg-gradient-to-r from-accent to-accent-hover'
}

/**
 * 容量细条（ui-optimize 决策 6 / N7：composer 顶缘 2px 余量指示条）两段告警色阶。
 * 仅告警显示（spec R2.3 / demo ComposerBar v-else-if contextPct>80）：≤80% 不渲染
 * （渲染门控在 ComposerCapacityBar，与本函数共用 CAPACITY_BAR_WARN_THRESHOLD）——
 * accent 常态条稀释告警语义，违背 accent 稀缺原则。与浮层卡内 bar（usageBarClass）
 * 阈值**不同**（80/95 vs 70/90）——细条是「余量将尽」的预警通道，只提醒不承载精确
 * 读数（数字在 hover 指标聚合页），阈值刻意后移降低打扰面。
 * 两套阈值并存是有意差异（业务含义不同），禁止合并；后续若裁决统一，两处同批改。
 */

/** 细条 warn 阈值（>80% 变 warn；同时是渲染门控阈值：≤80% 不渲染） */
export const CAPACITY_BAR_WARN_THRESHOLD = 80
/** 细条 danger 阈值（>95% 变 danger） */
export const CAPACITY_BAR_DANGER_THRESHOLD = 95

/** 使用率 → 细条配色 token 工具类（仅告警显示：>80% warn · >95% danger；≤80% 返回空——
 *  调用方按 >80% 门控不渲染，本分支兜底直调场景） */
export function capacityBarClass(percent: number): string {
  if (percent > CAPACITY_BAR_DANGER_THRESHOLD) return 'bg-danger'
  if (percent > CAPACITY_BAR_WARN_THRESHOLD) return 'bg-warn'
  return ''
}
