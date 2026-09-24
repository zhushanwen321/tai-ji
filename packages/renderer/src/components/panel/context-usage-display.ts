/**
 * context-usage-display —— 上下文用量触发器（底栏 chip）与 ContextCapacityCard（浮层内容）
 * 共用的显示纯函数。
 *
 * 为什么独立成模块（防两处复制）：W3a 拆卡后格式化与分档逻辑存在两个消费方，
 * 「12K / 1.6M 的 K/M 制」与「>70% warn / >90% danger 的 bar 配色」若各写一份，
 * 后续调整口径必然漂移。零 vue 组件依赖，i18n 无关（纯数值格式化）。
 */

/** 用量分档阈值（<70 accent · 70–90 warning · >90 danger，与设计 §3 一致） */
export const USAGE_HIGH_THRESHOLD = 70
export const USAGE_DANGER_THRESHOLD = 90

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
