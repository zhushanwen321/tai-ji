/**
 * useQuotaQuery composable 单测。
 *
 * 覆盖 w4（Composer hover 合并浮层）的查询逻辑：
 * - onHoverEnter 先 cached 后 fetch
 * - 并发保护（pending 期间跳过重复调用）
 * - providerId 为 null 时跳过
 * - 数据写入 store 后 computed 自动响应式更新
 *
 * mock 策略：vi.mock('@taiji/core/transport/api/domains/quota') 替换 RPC 层，vi.mock('@/stores/quota') 替换 store。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-quota-query.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { NormalizedQuotaRow } from '@taiji/shared'

vi.mock('@taiji/core/transport/api/domains/quota', () => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
  configure: vi.fn(),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: {
    onProviders: vi.fn(() => () => {}),
    onSkills: vi.fn(() => () => {}),
    onAgents: vi.fn(() => () => {}),
    onSkillDirs: vi.fn(() => () => {}),
    onAgentDirs: vi.fn(() => () => {}),
    onExtensionDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
    onSystemPrompt: vi.fn(() => () => {}),
    onTerminalConfig: vi.fn(() => () => {}),
    getTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
    setTerminalConfig: vi.fn(async () => ({ config: { version: 1, shell: '', shellArgs: [], fontSize: 14, fontFamily: '', scrollback: 1000, cursorStyle: 'block' as const, bell: false }, corrupted: false })),
  },
  model: { onModels: vi.fn(() => () => {}) },
  extension: { onExtensions: vi.fn(() => () => {}) },
  settings: {
    getSystem: vi.fn(async () => ({ locale: 'zh-CN', theme: 'dark', themePreset: 'cold-blue' })),
    updateSystem: vi.fn(async () => {}),
  },
}))

vi.mock('@/i18n', () => ({
  setLocale: vi.fn(),
  // useQuotaQuery 的 quotaFailReasonText 经 i18n.global.t 映射 reason 文案（mock 返回 key 本身，断言用）
  default: { global: { t: (key: string) => key } },
}))

import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import { useQuotaQuery } from '@/composables/features/model/useQuotaQuery'
import { useQuotaStore } from '@/stores/quota'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

const mockRow: NormalizedQuotaRow = {
  label: '智谱 GLM Coding Plan',
  wins: [
    { pct: 68, resetSec: 4980 },
    { pct: 42, resetSec: 266400 },
    { pct: null, resetSec: null },
  ],
}

const mockCachedResult = { data: mockRow, lastFetchAt: 1000 }
const mockFetchResult = { data: { ...mockRow, wins: [{ pct: 72, resetSec: 3600 }, mockRow.wins[1], mockRow.wins[2]] }, lastFetchAt: 2000 }

describe('useQuotaQuery', () => {
  it('providerId 为 null → data 为 null，onHoverEnter 是 no-op', async () => {
    const providerIdRef = ref<string | null>(null)
    const { data, lastFetchAt, onHoverEnter } = useQuotaQuery(providerIdRef)

    expect(data.value).toBeNull()
    expect(lastFetchAt.value).toBeNull()

    await onHoverEnter()
    expect(quotaApi.getCached).not.toHaveBeenCalled()
    expect(quotaApi.fetchQuota).not.toHaveBeenCalled()
  })

  it('onHoverEnter：先调 getCached 再调 fetchQuota', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue(mockFetchResult)

    const providerIdRef = ref<string | null>('zhipu')
    const { data, lastFetchAt, onHoverEnter } = useQuotaQuery(providerIdRef)

    await onHoverEnter()

    expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')
    expect(quotaApi.fetchQuota).toHaveBeenCalledWith('zhipu')
    // fetch 的结果覆盖 cached 的结果
    expect(data.value).toEqual(mockFetchResult.data)
    expect(lastFetchAt.value).toBe(2000)
  })

  it('onHoverEnter：fetchQuota 失败时，如有 cached 结果则保留', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
    vi.mocked(quotaApi.fetchQuota).mockRejectedValue(new Error('network'))

    const providerIdRef = ref<string | null>('zhipu')
    const { data, lastFetchAt, onHoverEnter } = useQuotaQuery(providerIdRef)

    await onHoverEnter()

    // getCached 成功写入
    expect(data.value).toEqual(mockRow)
    expect(lastFetchAt.value).toBe(1000)
  })

  it('onHoverEnter：fetch fulfilled 但带 reason（A2-4 失败态契约）→ 保留旧 data + 写 error 文案', async () => {
    // 场景：store 已有旧缓存（此前成功过），本次 fetch 失败返回 data=null + reason（runtime 不抛错）
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000, reason: 'unauthorized' })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: 1000, reason: 'unauthorized' })

    const providerIdRef = ref<string | null>('zhipu')
    const { data, error, onHoverEnter } = useQuotaQuery(providerIdRef)

    await onHoverEnter()

    // 旧 data 不被 null 覆写（回归守卫：BL round1 #3）
    expect(data.value).toEqual(mockRow)
    // error 写入 reason 映射文案（i18n mock 返回 key 本身）
    expect(error.value).toBe('panel.context.quotaFailUnauthorized')
  })

  it('onHoverEnter：fetch fulfilled 无 reason → 成功路径写 data 清 error', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue(mockFetchResult)

    const providerIdRef = ref<string | null>('zhipu')
    const { data, error, onHoverEnter } = useQuotaQuery(providerIdRef)

    await onHoverEnter()

    expect(data.value).toEqual(mockFetchResult.data)
    expect(error.value).toBeNull()
  })

  it('onHoverEnter：getCached 初始填充带 reason（runtime 内存失败标记）→ 首屏即失败态而非空白', async () => {
    // 场景：store 无条目（renderer 重载），runtime 内存有失败标记且无缓存数据
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null, reason: 'network' })

    const providerIdRef = ref<string | null>('zhipu')
    const { data, error, onHoverEnter } = useQuotaQuery(providerIdRef)

    await onHoverEnter()

    expect(data.value).toBeNull()
    expect(error.value).toBe('panel.context.quotaFailNetwork')
  })

  it('onHoverEnter：并发保护——pending 期间重复调用被跳过', async () => {
    // 让 fetchQuota 挂起（不 resolve）
    let resolveFetch: (v: typeof mockFetchResult) => void
    const fetchPromise = new Promise<typeof mockFetchResult>((resolve) => {
      resolveFetch = resolve
    })
    vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
    vi.mocked(quotaApi.fetchQuota).mockReturnValue(fetchPromise)

    const providerIdRef = ref<string | null>('zhipu')
    const store = useQuotaStore()
    const { onHoverEnter } = useQuotaQuery(providerIdRef)

    // 第一次调用
    const p1 = onHoverEnter()
    // 第二次调用（pending 期间）
    const p2 = onHoverEnter()

    // 第二次应该是 no-op（同一 tick 内）
    expect(store.isPending('zhipu')).toBe(true)

    // 解析 fetch
    resolveFetch!(mockFetchResult)
    await Promise.all([p1, p2])

    // getCached 只被调一次（第二次被 pending 跳过）
    expect(quotaApi.getCached).toHaveBeenCalledTimes(1)
    expect(quotaApi.fetchQuota).toHaveBeenCalledTimes(1)
  })

  it('onHoverEnter：providerId 变化后使用新 ID', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue(mockFetchResult)

    const providerIdRef = ref<string | null>('zhipu')
    const { onHoverEnter } = useQuotaQuery(providerIdRef)

    await onHoverEnter()
    expect(quotaApi.getCached).toHaveBeenCalledWith('zhipu')

    // 切换 provider
    providerIdRef.value = 'kimi'
    vi.mocked(quotaApi.getCached).mockClear()
    vi.mocked(quotaApi.fetchQuota).mockClear()

    await onHoverEnter()
    expect(quotaApi.getCached).toHaveBeenCalledWith('kimi')
    expect(quotaApi.fetchQuota).toHaveBeenCalledWith('kimi')
  })

  it('data 是响应式：store 更新后 computed 自动刷新', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue(mockCachedResult)
    vi.mocked(quotaApi.fetchQuota).mockResolvedValue(mockFetchResult)

    const providerIdRef = ref<string | null>('zhipu')
    const { data, onHoverEnter } = useQuotaQuery(providerIdRef)

    expect(data.value).toBeNull()
    await onHoverEnter()
    expect(data.value).toEqual(mockFetchResult.data)
  })
})
