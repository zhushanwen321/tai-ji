/**
 * useQuotaQuery unauthorized 自动续期测试（quota cookie 刷新 U3）。
 *
 * 覆盖 hover 路径的自动触发链：
 * - unauthorized 且刷新目标在册 → 调 lib/ipc refreshQuotaCookie；成功（ok 且
 *   cookieWritten）后重查一次 fetchQuota 并以新结果写 store
 * - 10 分钟冷却（模块级，触发即记账：失败也占用冷却窗）+ 在途去重
 * - 续期失败 / ok 但未写入 → 静默（不重查、store 保留 unauthorized 展示）
 * - 非 unauthorized（network）/ 刷新目标不在册（opendesign、api-key 类）不触发
 * - 手动 fetcher 缺席时按 preset 自动匹配解析刷新目标（与 runtime 前两级同构）
 *
 * mock 策略：vi.mock quota RPC 域（getCached / fetchQuota）与 '@/lib/ipc'
 * （refreshQuotaCookie）；settings store 为 core 惰性单例，直接 setProviders /
 * setQuotaPresets 灌数（无 transport 依赖面）。冷却窗用 vi.useFakeTimers +
 * setSystemTime 推进墙钟（续期链自身无 setTimeout，微任务 flush 不受影响）。
 *
 * 冷却注册表是 useQuotaQuery 模块级状态，跨用例持久——各用例使用互不相同的
 * providerId，避免上一用例的冷却窗挡住下一用例（去重行为本身在用例内断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/quota-cookie-auto-refresh.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { NormalizedQuotaRow, ProviderId, ProviderInfo } from '@taiji/shared'
import { QUOTA_PRESETS } from '@taiji/shared'
import { getSettingsStore } from '@taiji/core'
import type { QuotaResult } from '@taiji/core/transport/api/domains/quota'

const quotaApi = vi.hoisted(() => ({
  getCached: vi.fn<(providerId: string) => Promise<QuotaResult>>(),
  fetchQuota: vi.fn<(providerId: string) => Promise<QuotaResult>>(),
}))

const ipcRefresh = vi.hoisted(() => ({
  refreshQuotaCookie: vi.fn<(payload: { fetcherId: string; providerId: string }) => Promise<{ ok: boolean; cookieWritten: boolean; error?: string }>>(),
}))

vi.mock('@taiji/core/transport/api/domains/quota', () => ({
  getCached: quotaApi.getCached,
  fetchQuota: quotaApi.fetchQuota,
}))

vi.mock('@/lib/ipc', () => ({
  refreshQuotaCookie: ipcRefresh.refreshQuotaCookie,
}))

vi.mock('@/i18n', () => ({
  setLocale: vi.fn(),
  // quotaFailReasonText 经 i18n.global.t 映射 reason 文案（mock 返回 key 本身）
  default: { global: { t: (key: string) => key } },
}))

import { useQuotaQuery } from '@/composables/features/model/useQuotaQuery'
import { useQuotaStore } from '@/stores/quota'

/** 成功额度行 fixture（重查后写入 store 的数据）。 */
const OK_ROW: NormalizedQuotaRow = {
  label: 'MiMo Coding Plan',
  wins: [
    { pct: 10, used: 100, limit: 1000, unit: 'requests', resetSec: 3600 },
    { pct: null, resetSec: null },
    { pct: null, resetSec: null },
  ],
}

/** 无缓存快照（getCached 默认返回）。 */
const EMPTY_CACHED: QuotaResult = { data: null, lastFetchAt: null }

/** unauthorized 失败快照（自动触发判据）。 */
const UNAUTHORIZED: QuotaResult = { data: null, lastFetchAt: null, reason: 'unauthorized' }

function providerInfo(overrides: Partial<Omit<ProviderInfo, 'id'>> & { id?: string } = {}): ProviderInfo {
  const { id = 'mimo-p', ...rest } = overrides
  return {
    name: 'Xiaomi MiMo',
    apiKeySet: true,
    status: 'connected',
    models: [],
    ...rest,
    id: id as ProviderId,
  } as ProviderInfo
}

/**
 * 装配：单例 store 灌 provider 与 presets 基线。makeQuery 用于同用例内第二个实例
 * （在途/冷却的跨实例去重正是被测行为；同一 provider 多个 useQuotaQuery 实例并存
 * 是生产形态——容量卡 useQuotaDisplay + 浮层 PlanQuotaItem）。
 */
function setup(provider: ProviderInfo) {
  const settings = getSettingsStore()
  settings.setProviders([provider])
  settings.setQuotaPresets([...QUOTA_PRESETS])
  const makeQuery = () => useQuotaQuery(ref(provider.id))
  return { q: makeQuery(), store: useQuotaStore(), makeQuery }
}

describe('useQuotaQuery unauthorized 自动续期', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers({ now: Date.now() })
    vi.clearAllMocks()
    quotaApi.getCached.mockResolvedValue(EMPTY_CACHED)
    ipcRefresh.refreshQuotaCookie.mockResolvedValue({ ok: true, cookieWritten: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('unauthorized + 在册 fetcher → 自动续期，成功后重查并以新数据写 store', async () => {
    quotaApi.fetchQuota
      .mockResolvedValueOnce(UNAUTHORIZED) // 首查失败
      .mockResolvedValueOnce({ data: OK_ROW, lastFetchAt: 123 }) // 续期后重查成功
    const { q, store } = setup(providerInfo({ id: 'mimo-ok', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }))

    await q.onHoverEnter()
    await flushPromises()

    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledTimes(1)
    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledWith({ fetcherId: 'mimo', providerId: 'mimo-ok' })
    expect(quotaApi.fetchQuota).toHaveBeenCalledTimes(2)
    expect(store.getEntry('mimo-ok')?.data).toEqual(OK_ROW)
    expect(q.error.value).toBeNull()
  })

  it('手动 fetcher 缺席时按 preset 自动匹配解析刷新目标', async () => {
    // name 命中 mimo preset（\bmimo\b），无手动 fetcher → 前两级解析落到自动匹配
    quotaApi.fetchQuota
      .mockResolvedValueOnce(UNAUTHORIZED)
      .mockResolvedValueOnce({ data: OK_ROW, lastFetchAt: 123 })
    const { q } = setup(providerInfo({ id: 'auto-p', name: 'mimo proxy', quota: { enabled: true } }))

    await q.onHoverEnter()
    await flushPromises()

    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledWith({ fetcherId: 'mimo', providerId: 'auto-p' })
    expect(q.data.value).toEqual(OK_ROW)
  })

  it('续期失败（ok:false）→ 静默：不重查、store 保留 unauthorized 展示', async () => {
    ipcRefresh.refreshQuotaCookie.mockResolvedValue({ ok: false, cookieWritten: false, error: 'login timeout' })
    quotaApi.fetchQuota.mockResolvedValue(UNAUTHORIZED)
    const { q, store } = setup(providerInfo({ id: 'mimo-fail', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }))

    await q.onHoverEnter()
    await flushPromises()

    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledTimes(1)
    expect(quotaApi.fetchQuota).toHaveBeenCalledTimes(1)
    expect(q.error.value).toBe('panel.context.quotaFailUnauthorized')
    expect(store.getEntry('mimo-fail')?.data).toBeNull()
  })

  it('ok 但 cookieWritten:false（cookie 未变化）→ 不重查', async () => {
    ipcRefresh.refreshQuotaCookie.mockResolvedValue({ ok: true, cookieWritten: false })
    quotaApi.fetchQuota.mockResolvedValue(UNAUTHORIZED)
    const { q } = setup(providerInfo({ id: 'mimo-nowrite', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }))

    await q.onHoverEnter()
    await flushPromises()

    expect(quotaApi.fetchQuota).toHaveBeenCalledTimes(1)
    expect(q.error.value).toBe('panel.context.quotaFailUnauthorized')
  })

  it('冷却 10 分钟：窗口内重复 unauthorized 不再触发，越窗恢复', async () => {
    quotaApi.fetchQuota.mockResolvedValue(UNAUTHORIZED)
    const { q, makeQuery } = setup(providerInfo({ id: 'mimo-cool', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }))

    await q.onHoverEnter()
    await flushPromises()
    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledTimes(1)

    // 冷却窗内第二次 hover（同模块第二实例，模拟容量卡与浮层并存）→ 不触发
    const second = makeQuery()
    await second.onHoverEnter()
    await flushPromises()
    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledTimes(1)

    // 推进 10 分钟 → 冷却越窗，再次 hover 触发
    vi.setSystemTime(Date.now() + 10 * 60 * 1000)
    await second.onHoverEnter()
    await flushPromises()
    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledTimes(2)
  })

  it('在途去重：续期 promise 未决期间重复 unauthorized 不重复发起', async () => {
    let releaseRefresh: ((v: { ok: boolean; cookieWritten: boolean }) => void) | undefined
    ipcRefresh.refreshQuotaCookie.mockImplementation(
      () => new Promise((resolve) => {
        releaseRefresh = resolve
      }),
    )
    quotaApi.fetchQuota.mockResolvedValue(UNAUTHORIZED)
    const { q, makeQuery } = setup(providerInfo({ id: 'mimo-inflight', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }))

    await q.onHoverEnter()
    await flushPromises()
    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledTimes(1)

    // 首次续期仍在途 → 第二次 hover 的 unauthorized 不再发起
    const second = makeQuery()
    await second.onHoverEnter()
    await flushPromises()
    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledTimes(1)

    releaseRefresh?.({ ok: false, cookieWritten: false })
    await flushPromises()
  })

  it('非 unauthorized 失败（network）不触发续期', async () => {
    quotaApi.fetchQuota.mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })
    const { q } = setup(providerInfo({ id: 'mimo-net', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }))

    await q.onHoverEnter()
    await flushPromises()

    expect(ipcRefresh.refreshQuotaCookie).not.toHaveBeenCalled()
    expect(q.error.value).toBe('panel.context.quotaFailNetwork')
  })

  it('cookie 类但不在册（opendesign）与 api-key 类（zhipu）不触发', async () => {
    const opendesign = providerInfo({
      id: 'od-p',
      name: 'OpenDesign',
      quota: { enabled: true, fetcher: 'opendesign', cookieSet: true },
    })
    const { q: od } = setup(opendesign)
    await od.onHoverEnter()
    await flushPromises()
    expect(ipcRefresh.refreshQuotaCookie).not.toHaveBeenCalled()

    const zhipu = providerInfo({
      id: 'zhipu-p',
      name: 'Zhipu GLM',
      quota: { enabled: true, fetcher: 'zhipu' },
    })
    // 上一用例的 fetchQuota mock 残留（network）：本用例要的是 unauthorized——
    // api-key 类拿到 unauthorized 也不触发续期（非 cookie 形态拦截）
    quotaApi.fetchQuota.mockResolvedValue(UNAUTHORIZED)
    const { q: zp } = setup(zhipu)
    await zp.onHoverEnter()
    await flushPromises()
    expect(ipcRefresh.refreshQuotaCookie).not.toHaveBeenCalled()
    expect(zp.error.value).toBe('panel.context.quotaFailUnauthorized')
  })
})
