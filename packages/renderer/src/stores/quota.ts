/**
 * Quota store —— coding-plan 额度数据的纯状态容器。
 *
 * 架构：与 settingsStore 同构——只持 state + 纯写入方法，由 composable（useQuotaQuery）喂数据。
 * 状态隔离：按 providerId 分区（byProvider Map），不同 provider 的额度互不干扰。
 * 并发保护：pending Set 记录正在查询的 providerId，composable 层防重复触发。
 *
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md §2.2.4
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md §5 Wave 4
 */
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import type { NormalizedQuotaRow } from '@xyz-agent/shared'

/** 单个 provider 的额度缓存条目。 */
export interface QuotaCacheEntry {
  /** 归一化额度数据。null = 尚未查询或查询失败无旧缓存。 */
  data: NormalizedQuotaRow | null
  /** 最后一次成功查询的 Unix 毫秒时间戳。null = 从未查询。 */
  lastFetchAt: number | null
  /** 最后一次查询的错误信息。null = 无错误（成功或从未查询）。非空 = 上次查询失败。 */
  error: string | null
}

export const useQuotaStore = defineStore('quota', () => {
  // ── State ──

  /** providerId → 额度缓存条目。 */
  const byProvider = reactive(new Map<string, QuotaCacheEntry>())

  /** 正在查询中的 providerId 集合（pending Set，防重复触发）。 */
  const pending = ref(new Set<string>())

  // ── Actions（纯写入；查询编排在 useQuotaQuery composable）──

  /**
   * 更新指定 provider 的额度缓存。
   * 成功查询后调用，写入 data + lastFetchAt，清空 error。
   */
  function setCache(providerId: string, data: NormalizedQuotaRow | null, lastFetchAt: number | null): void {
    byProvider.set(providerId, { data, lastFetchAt, error: null })
  }

  /**
   * 标记 provider 上次查询失败（保留旧 data，写入 error）。
   * useQuotaQuery 的 fetchQuota rejected 时调用。
   */
  function setError(providerId: string, error: string): void {
    const prev = byProvider.get(providerId)
    byProvider.set(providerId, {
      data: prev?.data ?? null,
      lastFetchAt: prev?.lastFetchAt ?? null,
      error,
    })
  }

  /**
   * 标记 provider 为查询中。
   * @returns 是否成功标记（false = 已在查询中，应跳过）。
   */
  function markPending(providerId: string): boolean {
    if (pending.value.has(providerId)) return false
    const next = new Set(pending.value)
    next.add(providerId)
    pending.value = next
    return true
  }

  /**
   * 取消 provider 的查询中标记。
   */
  function unmarkPending(providerId: string): void {
    const next = new Set(pending.value)
    next.delete(providerId)
    pending.value = next
  }

  /**
   * 获取指定 provider 的缓存条目。
   * @returns 缓存条目，或 undefined（无缓存）。
   */
  function getEntry(providerId: string): QuotaCacheEntry | undefined {
    return byProvider.get(providerId)
  }

  /**
   * 检查 provider 是否正在查询中。
   */
  function isPending(providerId: string): boolean {
    return pending.value.has(providerId)
  }

  /**
   * 清除指定 provider 的缓存（provider 删除或禁用额度查询时调用）。
   */
  function clearCache(providerId: string): void {
    byProvider.delete(providerId)
  }

  return {
    // state
    byProvider,
    pending,
    // actions
    setCache,
    setError,
    markPending,
    unmarkPending,
    getEntry,
    isPending,
    clearCache,
  }
})
