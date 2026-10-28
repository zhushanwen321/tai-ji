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
 * 7. unauthorized 且 cookie 刷新目标在册时自动续期：调 main 隐藏窗口刷新器导出新
 *    cookie 串（main 不落盘），经 quota.configure 保存链由 runtime 单点落盘后 force
 *    重查一次（10 分钟冷却 + 在途去重，失败静默）
 *
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md §2.2.4
 * HANDOFF：.taiji-harness/coding-plan-quota/HANDOFF.md §5 Wave 4
 */
import { computed } from 'vue'
import type { Ref } from 'vue'
import type { NormalizedQuotaRow, ProviderInfo, QuotaFetchFailureReason } from '@taiji/shared'
import { getQuotaRefreshTarget, resolveQuotaFetcherId, resolveQuotaPresets } from '@taiji/shared'
import i18n from '@/i18n'
import { getSettingsStore, getSettingsTransport } from '@taiji/core'
import { createInflightDedup } from '@taiji/core/foundation/create-inflight-dedup'
import { refreshQuotaCookie } from '@/lib/ipc'
import { useQuotaStore, type QuotaCacheEntry } from '@/stores/quota'
import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import type { QuotaResult } from '@taiji/core/transport/api/domains/quota'

/** quota 失败 reason → panel.context 的 i18n key（简短原因，恢复指引长文案在 settings.providerEdit）。 */
const QUOTA_FAIL_REASON_KEYS: Record<QuotaFetchFailureReason, string> = {
  unauthorized: 'panel.context.quotaFailUnauthorized',
  network: 'panel.context.quotaFailNetwork',
  'no-subscription': 'panel.context.quotaFailNoSubscription',
  parse: 'panel.context.quotaFailParse',
  not_configured: 'panel.context.quotaFailNotConfigured',
  'no-credential': 'panel.context.quotaFailNoCredential',
  // 2026-10-18：粘贴格式无效（无 name=value 对）与「会话失效」分流，指引换复制路径。
  'cookie-invalid-format': 'panel.context.quotaFailCookieInvalidFormat',
  // RT-7#7：凭据文件读盘/锁失败（与「确实没有凭证」分流——runtime 日志带具体文件路径）
  'credential-unavailable': 'panel.context.quotaFailCredentialUnavailable',
  // RT-7#4：凭据形态不支持（! command / 未定义环境变量引用），发请求前拦截
  'credential-unsupported': 'panel.context.quotaFailCredentialUnsupported',
}

// i18n.global.t 的类型窄化 cast（对齐 useChat/useConnection 的非 setup composable 模式）：
// vue-i18n 的 t 是复杂重载签名，这里只需无参 key 查询。
const t = i18n.global.t as (key: string) => string

/**
 * quota 失败 reason → 用户可读简短文案（写入 store.error，panel 显示「查询失败：{error}」）。
 * 供 useQuotaQuery 与 ContextCapacityCard 的 refresh 路径共用。
 */
export function quotaFailReasonText(reason: QuotaFetchFailureReason): string {
  return t(QUOTA_FAIL_REASON_KEYS[reason])
}

// ── unauthorized 自动续期（hover 路径）───────────────────────────────────────

/**
 * 自动续期冷却（providerId → 上次触发时刻，模块级）。
 * 模块级而非 composable 级：同一 provider 会被多个 useQuotaQuery 实例查询
 * （容量卡 useQuotaDisplay + 浮层每 provider 项 PlanQuotaItem），实例级 Map 会让
 * 多实例各自触发一次刷新。触发即记账（失败也记）——刷新失败（如登录页超时）后
 * hover 仍会持续命中 unauthorized，不记账会每 15s 开一个隐藏窗口形成失败风暴。
 */
const COOKIE_REFRESH_COOLDOWN_MS = 600_000 // 10 分钟（10 × 60s）
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：续期冷却时刻表（防重触发登记，非展示数据）
const cookieRefreshLastTriggerAt = new Map<string, number>()

/**
 * 在途去重：续期期间（可达 15s~120s）同一 provider 不重复发起。createInflightDedup
 * 单点工具（C-data-18：禁手写 Map/Set + settle 清理的同构实现）——fn 仅首轮执行、
 * 在途触发复用同一 promise 后 void 丢弃，与「在途时新触发直接 return」的
 * fire-and-forget 语义等价，另获内建引用比对防误删与 unhandled rejection 防护。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：续期在途去重登记（并发去重，非展示数据）
const cookieRefreshDedup = createInflightDedup<void>()

/**
 * 解析 provider 的 cookie 刷新目标 fetcher（在册返回 fetcher id，否则 undefined）。
 * 两级判定（手动 quota.fetcher 在册优先，否则 preset 自动匹配）单源在 shared
 * resolveQuotaFetcherId——与 runtime QuotaService.getFetcherForProvider 同一规则
 * （presets 数据源两侧独立：前端 = RPC 下发副本空态回落基线，runtime = 现算合并视图）。
 * runtime 第三级（providerId 直查 fetcher 注册表）是「provider id 恰好等于 fetcher id」
 * 的兜底，前端展示链（resolveQuotaPresetLabel）同样未实现，此处保持同构不实现。
 * 解析结果再过刷新目标在册判定：cookie 类但不在册的 fetcher（如 opendesign）两级都
 * 不命中 → undefined，不触发。
 */
function resolveCookieRefreshFetcherId(provider: ProviderInfo): string | undefined {
  const fetcherId = resolveQuotaFetcherId(
    provider,
    resolveQuotaPresets(getSettingsStore().quotaPresets.value),
    (id) => getQuotaRefreshTarget(id) !== undefined,
  )
  // preset 命中但刷新目标不在册（如 opendesign）→ 不触发；手动级已在 hasFetcher 过滤
  return fetcherId !== undefined && getQuotaRefreshTarget(fetcherId) !== undefined ? fetcherId : undefined
}

/**
 * 单次 fetch 结果写入 store（成功清 error 写缓存 / 失败保留旧 data 写 error）。
 * onHoverEnter 主查询与续期成功后的重查共用同一写入口径。
 */
function applyFetchResult(
  store: ReturnType<typeof useQuotaStore>,
  pid: string,
  result: QuotaResult,
): void {
  if (result.reason) {
    store.setError(pid, quotaFailReasonText(result.reason))
  } else {
    store.setCache(pid, result.data, result.lastFetchAt)
  }
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
  /**
   * 触发 hover-enter 查询。幂等：pending 期间重复调用无副作用。
   * 节流不在本 composable：runtime QuotaService.fetch 对 10s 内重复 fetch 直接返回缓存。
   */
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
   * hover-enter 触发查询。本 composable 只做 pending 并发保护；10s 节流位于 runtime
   * QuotaService.fetch（10s 内重复 fetch 直接返回缓存），不在此层实现。
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
        applyFetchResult(store, pid, fetchResult.value)
        // unauthorized 自动续期：cookie 类且刷新目标在册时 fire-and-forget 触发（不占
        // pending 态——续期可达 15s~120s，占住会让容量 chip 长挂「查询中」）
        if (fetchResult.value.reason === 'unauthorized') {
          void attemptCookieRefresh(pid)
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

  /**
   * unauthorized 后的自动续期：调 main 隐藏窗口刷新器导出新 cookie 串（main 不落盘），
   * 成功（ok 且带串）才经 quota.configure 保存链由 runtime 单点落盘，随后 force 重查
   * 一次；失败静默（store 已写 unauthorized 文案，无需叠加噪音）。SSO 登录窗弹出场景
   * 由 main 侧处理（登录页停留转可见），renderer 不做任何窗口操作。
   */
  async function attemptCookieRefresh(pid: string): Promise<void> {
    const provider = getSettingsStore().providers.value.find((p) => p.id === pid)
    if (!provider) return
    const fetcherId = resolveCookieRefreshFetcherId(provider)
    if (!fetcherId) return
    if (cookieRefreshDedup.has(pid)) return
    const last = cookieRefreshLastTriggerAt.get(pid)
    if (last !== undefined && Date.now() - last < COOKIE_REFRESH_COOLDOWN_MS) return

    cookieRefreshLastTriggerAt.set(pid, Date.now())
    void cookieRefreshDedup
      .run(pid, () => runCookieRefresh(pid, provider.quota?.enabled ?? false, fetcherId))
      .promise
  }

  /**
   * 续期执行体（dedup 首轮发起时执行，永不 reject——异常归一进 catch 面的 debug 留痕，
   * 在途/冷却去重由 dedup 与冷却表承担）。
   */
  async function runCookieRefresh(pid: string, enabled: boolean, fetcherId: string): Promise<void> {
    try {
      const result = await refreshQuotaCookie({ fetcherId, providerId: pid })
      if (!(result.ok && result.cookie)) return
      // 单写方落盘（data-source-registry #66）：main 只导出串，保存走 quota.configure
      // 保存链——secrets 文件由 runtime QuotaService 进程内写入（权限 / 顺序与用户
      // 手贴保存同一条链），configure 成功即 cookieSet 落盘
      const saved = await getSettingsTransport().configureQuota({
        providerId: pid,
        enabled,
        cookie: result.cookie,
      })
      if (!saved.ok) {
        console.debug('[quota] cookie refresh save failed:', saved.error ?? 'unknown error')
        return
      }
      if (!store.markPending(pid)) {
        // 在途查询早于写盘发起、晚于写盘返回时，其 unauthorized 是旧 cookie 的真实
        // 结果——UI 停留失败态到下次 hover 才刷新，留痕便于观测
        console.debug('[quota] cookie refreshed while a fetch is pending; unauthorized state stays until next hover:', pid)
        return
      }
      try {
        // force 重查（refreshQuota）绕 10s 节流：触发续期的那次失败查询刚写过
        // lastFetchTime（runtime finishFetch 在非 force 路径的 unauthorized 失败出口
        // 也写时间戳），非 force 重查必然命中节流读回过期失败态
        const refetched = await quotaApi.refreshQuota(pid)
        applyFetchResult(store, pid, refetched)
      } catch (e) {
        store.setError(pid, e instanceof Error ? e.message : String(e ?? 'unknown error'))
      } finally {
        store.unmarkPending(pid)
      }
    } catch (e) {
      // IPC 通道层异常（通道缺席 / preload 旧版）：保留 unauthorized 展示（冷却已记账，
      // 触发即记，不会形成失败风暴），debug 级留痕便于排查通道装配问题
      console.debug('[quota] cookie refresh failed:', e instanceof Error ? e.message : e)
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
