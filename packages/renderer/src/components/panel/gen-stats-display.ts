/**
 * gen-stats-display —— GenStats 触发器（底栏文本 chip）与两张指标卡（浮层内容）共用的显示纯函数。
 *
 * 为什么独立成模块（深模块纪律，防两处复制）：W3a 把 GenStatsTriggers 的两个 HoverCardContent
 * 拆成 GenStatsSpeedCard / GenStatsCacheCard 后，触发器与卡片要显示**同一口径**的归因文案、
 * 语义色分档与数值格式——协议漂移兜底（RD-2#7 未知 reason 的 default 分支）这类修复若存在
 * 两份拷贝，必然漏改一处产生口径漂移。故：三档阈值 / 归因 label / 数值格式收敛于此，
 * 触发器与卡片只各自保留「自己的布局 + 着色映射」。
 *
 * 零 vue 组件依赖（纯函数 + 类型），i18n 经参数注入（getDisplayLabel 同款注入范式）。
 */
import type { GenStatsCacheMiss } from '@taiji/shared'

/** 缓存命中率语义色三档阈值（设计 §3.1：≥80 success / 50–80 warn / <50 danger） */
export const CACHE_SUCCESS_THRESHOLD = 80
export const CACHE_WARN_THRESHOLD = 50

/** 缓存命中率的语义色档（neutral = 无值 / 归因态，非故障） */
export type CacheTier = 'success' | 'warn' | 'danger' | 'neutral'

/** 数值 → 语义色档（null = 无数据 → neutral；归因态由调用方强制 neutral） */
export function cacheTierOf(v: number | null | undefined): CacheTier {
  if (v == null) return 'neutral'
  if (v >= CACHE_SUCCESS_THRESHOLD) return 'success'
  if (v >= CACHE_WARN_THRESHOLD) return 'warn'
  return 'danger'
}

/** 档 → 前景色 token 工具类（触发器与卡片行共用；hover 变体只在触发器上拼接） */
export const CACHE_TIER_TEXT_CLASS: Record<CacheTier, string> = {
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
  neutral: 'text-neutral-dim',
}

/** 档 → 背景色 token 工具类（浮层 bar 用） */
export const CACHE_TIER_BG_CLASS: Record<CacheTier, string> = {
  success: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-neutral-dim',
}

/**
 * 归因 reason → 短文案（i18n；已知三值均为「预期内 miss，非故障」语义）。
 * t 用 `(key: string) => string` 最小签名（getDisplayLabel 同款先例，vue-i18n t 可赋值；
 * label 无插值参数）。
 * [RD-2#7] default：TS2366 只拦编译期，runtime 领先 renderer 的版本漂移会送来未知
 * reason——落通用「缓存未命中」文案 + warn（缺省会拿到 undefined 导致 chip 空白且无日志）。
 */
export function cacheMissLabel(reason: GenStatsCacheMiss['reason'], t: (key: string) => string): string {
  switch (reason) {
    case 'cold-start':
      return t('panel.context.genStatsCacheMissColdStart')
    case 'idle-expiry':
      return t('panel.context.genStatsCacheMissIdle')
    case 'context-rewrite':
      return t('panel.context.genStatsCacheMissCompaction')
    default:
      console.warn(`[gen-stats] 未知 cacheMiss reason：${String(reason)}（runtime 与 renderer 协议漂移？）`)
      return t('panel.context.genStatsCacheMissUnknown')
  }
}

/** 百分比统一显示：null →「—」，否则「N%」 */
export function cachePercentDisplay(v: number | null | undefined): string {
  return v == null ? '—' : `${v}%`
}

/** 速度统一显示：null →「—」，否则「N t/s」（触发器与浮层四行同口径） */
export function formatSpeed(v: number | null | undefined): string {
  return v == null ? '—' : `${v} t/s`
}
