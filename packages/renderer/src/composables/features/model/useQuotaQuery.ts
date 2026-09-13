/**
 * useQuotaQuery —— coding-plan 额度查询的 hover-enter 触发逻辑。
 *
 * 封装 hover 进入容量 chip 时的查询流程：
 * 1. 先调 getCached 即时填充（避免空白闪烁）
 * 2. 紧接着调 fetch 触发实际 HTTP 查询
 * 3. 返回后响应式刷新
 * 4. 并发保护：pending 期间复用 Promise，不重复触发
 * 5. provider 未配置额度查询 → 跳过
 * 6. 失败态写 error 到 store（UI 区分「从未查询」vs「查询失败」）：
 *    - RPC rejected（连接层错误）
 *    - fulfilled 但带 reason（A2-4 失败态契约：runtime 查询失败返回 data=null + reason，不抛错）
 *
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md §2.2.4
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md §5 Wave 4
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import type { NormalizedQuotaRow, QuotaFetchFailureReason } from '@xyz-agent/shared'
import i18n from '@/i18n'
import { useQuotaStore, type QuotaCacheEntry } from '@/stores/quota'
import * as quotaApi from '@xyz-agent/core/transport/api/domains/quota'

/** quota 失败 reason → panel.context 的 i18n key（简短原因，恢复指引长文案在 settings.providerEdit）。 */
const QUOTA_FAIL_REASON_KEYS: Record<QuotaFetchFailureReason, string> = {
  unauthorized: 'panel.context.quotaFailUnauthorized',
  network: 'panel.context.quotaFailNetwork',
  'no-subscription': 'panel.context.quotaFailNoSubscription',
  parse: 'panel.context.quotaFailParse',
  not_configured: 'panel.context.quotaFailNotConfigured',
  'no-credential': 'panel.context.quotaFailNoCredential',
}

// i18n.global.t 的类型窄化 cast（对齐 useChat/useConnection 的非 setup composable 模式）：
// vue-i18n 的 t 是复杂重载签名，这里只需无参 key 查询。
const t = i18n.global.t as (key: string) => string

/**
 * quota 失败 reason → 用户可读简短文案（写入 store.error，panel 显示「查询失败：{error}」）。
 * 供 useQuotaQuery 与 ContextCapacityPopover 的 refresh 路径共用。
 */
export function quotaFailReasonText(reason: QuotaFetchFailureReason): string {
  return t(QUOTA_FAIL_REASON_KEYS[reason])
}

/** 查询结果（composable 返回给消费方的响应式状态）。 */
export interface UseQuotaQueryResult {
  /** 当前 provider 的额度数据（响应式，store 变更后自动更新）。 */
  data: Ref<NormalizedQuotaRow | null>
  /** 最后一次成功查询的时间戳（Unix ms）。 */
  lastFetchAt: Ref<number | null>
  /** 最后一次查询的错误信息（非空 = 查询失败，UI 显失败提示）。 */
  error: Ref<string | null>
  /** 是否正在查询中。 */
  isPending: Ref<boolean>
  /** 触发 hover-enter 查询（受 10s throttle）。幂等：pending 期间重复调用无副作用。 */
  onHoverEnter: () => Promise<void>
}

/**
 * 创建针对特定 provider 的额度查询控制器。
 *
 * @param providerIdRef - 当前 provider ID 的响应式引用（session 切模型时变化）。
 *   null = 未命中 quota preset，不显示 coding-plan 区。
 * @returns 查询结果和触发方法。
 */
export function useQuotaQuery(providerIdRef: Ref<string | null>): UseQuotaQueryResult {
  const store = useQuotaStore()

  /** 当前 provider 的缓存条目（响应式）。 */
  const entry = computed<QuotaCacheEntry | undefined>(() => {
    const pid = providerIdRef.value
    return pid ? store.getEntry(pid) : undefined
  })

  /** 额度数据。无缓存时返回 null。 */
  const data = computed<NormalizedQuotaRow | null>(() => entry.value?.data ?? null)

  /** 最后查询时间。 */
  const lastFetchAt = computed<number | null>(() => entry.value?.lastFetchAt ?? null)

  /** 最后一次查询错误（null = 无错误或从未查询）。 */
  const error = computed<string | null>(() => entry.value?.error ?? null)

  /** 是否正在查询中。 */
  const isPending = computed<boolean>(() => {
    const pid = providerIdRef.value
    return pid ? store.isPending(pid) : false
  })

  /**
   * hover-enter 触发查询（受 10s throttle）。
   *
   * 流程：
   * 1. providerId 为空 → 跳过（未配置额度查询）
   * 2. 已在 pending → 跳过（并发保护）
   * 3. 先调 getCached 即时填充
   * 4. 调 fetch 触发查询：成功（无 reason）写入 store 清 error；失败态
   *    （带 reason 或 rejected）保留旧 data、写 error
   * 5. 查询完成取消 pending 标记
   */
  async function onHoverEnter(): Promise<void> {
    const pid = providerIdRef.value
    if (!pid) return
    if (!store.markPending(pid)) return // 并发保护：已在查询中

    try {
      const [cachedResult, fetchResult] = await Promise.allSettled([
        quotaApi.getCached(pid),
        quotaApi.fetchQuota(pid),
      ])

      // getCached 的结果：成功且 store 尚无数据时先用 cached 填充（避免 fetch 耗时期间空白）；
      // cached 带 reason（runtime 内存中有失败标记）时同步写 error（§3.4 失败态优先展示，旧 data 留 store）
      if (cachedResult.status === 'fulfilled') {
        const cached = cachedResult.value
        if (!store.getEntry(pid)) {
          store.setCache(pid, cached.data, cached.lastFetchAt)
          if (cached.reason) store.setError(pid, quotaFailReasonText(cached.reason))
        }
      }

      // fetch 的结果：无 reason = 成功，写最新值（清 error）；带 reason = 失败态（runtime
      // 不抛错，data=null + reason），保留旧 data、写 error 让 UI 显失败提示；
      // rejected（连接层错误）同样保留旧 data 写 error
      if (fetchResult.status === 'fulfilled') {
        if (fetchResult.value.reason) {
          store.setError(pid, quotaFailReasonText(fetchResult.value.reason))
        } else {
          store.setCache(pid, fetchResult.value.data, fetchResult.value.lastFetchAt)
        }
      } else {
        // fetchQuota rejected：保留旧缓存，写 error 让 UI 区分「从未查询」vs「查询失败」
        const msg = fetchResult.reason instanceof Error
          ? fetchResult.reason.message
          : String(fetchResult.reason ?? 'unknown error')
        store.setError(pid, msg)
      }
    } finally {
      store.unmarkPending(pid)
    }
  }

  return {
    data,
    lastFetchAt,
    error,
    isPending,
    onHoverEnter,
  }
}
