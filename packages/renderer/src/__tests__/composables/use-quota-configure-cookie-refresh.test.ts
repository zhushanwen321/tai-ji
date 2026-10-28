/**
 * useQuotaConfigure cookie 自动续期手动入口测试（quota cookie 刷新 U3）。
 *
 * 覆盖 module 契约新增面（view.cookieRefresh + refreshCookie 动作）：
 * - available 矩阵：cookie 形态且 fetcher 在 QUOTA_REFRESH_TARGETS 在册且类型未变；
 *   api-key 类 / 不在册（opendesign）/ 类型草稿已切换（归属失效）均不渲染入口
 * - 成功流转：running 中间态 → ok 且 cookieWritten → result='ok' + 重跑 testQuery
 *   （transport.refreshQuota）
 * - 失败流转：ok:false → result='fail' + error 透传；草稿与既有测试结果不动；
 *   error 缺省走 i18n 兜底（注入 t 的 T: 前缀形态）
 * - 入口不可用时动作 no-op（不发 IPC）
 *
 * mock 策略：SettingsTransport seam 经 makeSettingsTransportStub 注入（与
 * settings-domain-bundle 同范式，零 vi.mock 模块图替换）；唯一 vi.mock =
 * '@/lib/ipc'（refreshQuotaCookie 为 renderer→main 的 Electron IPC 封装，测试无 preload）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-quota-configure-cookie-refresh.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { NormalizedQuotaRow, ProviderId, ProviderInfo, QuotaPreset } from '@taiji/shared'
import { QUOTA_PRESETS } from '@taiji/shared'
import { provideSettingsTransport, getSettingsStore } from '@taiji/core'
import type { QuotaConfigureModule, QuotaSnapshot } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'

const ipcRefresh = vi.hoisted(() => ({
  refreshQuotaCookie: vi.fn<(payload: { fetcherId: string; providerId: string }) => Promise<{ ok: boolean; cookieWritten: boolean; error?: string }>>(),
}))

vi.mock('@/lib/ipc', () => ({
  refreshQuotaCookie: ipcRefresh.refreshQuotaCookie,
}))

import { useQuotaConfigure } from '@/composables/features/settings/useQuotaConfigure'

const P = (fetcher: string): QuotaPreset | undefined => QUOTA_PRESETS.find((p) => p.fetcher === fetcher)

function provider(overrides: Partial<Omit<ProviderInfo, 'id'>> & { id?: string } = {}): ProviderInfo {
  const { id = 'p1', ...rest } = overrides
  return {
    name: 'Test Provider',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [],
    ...rest,
    id: id as ProviderId,
  } as ProviderInfo
}

/** module 装配（对齐 QuotaConfigureInputs；t 注入 fake 渲染 T:key 形态）。 */
function mountModule(
  providerInit: ProviderInfo,
  preset: QuotaPreset | undefined,
): { module: QuotaConfigureModule; provider: Ref<ProviderInfo | null> } {
  const providerRef = ref<ProviderInfo | null>(providerInit)
  const t = vi.fn<(key: string, params?: Record<string, unknown>) => string>((key) => `T:${key}`)
  const module = useQuotaConfigure({
    t,
    provider: providerRef,
    preset: ref(preset),
    providerOauthPresent: ref(false),
    providerApiKeyDraft: ref(''),
  })
  return { module, provider: providerRef }
}

const mockRow: NormalizedQuotaRow = {
  label: 'MiMo Coding Plan',
  wins: [
    { pct: 24, used: 1204, limit: 5000, unit: 'requests', resetSec: 9005 },
    { pct: null, resetSec: null },
    { pct: null, resetSec: null },
  ],
}

describe('useQuotaConfigure cookie 自动续期手动入口', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // presets 合并视图灌编译期基线（与 settings-domain-bundle 同口径）
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    ipcRefresh.refreshQuotaCookie.mockResolvedValue({ ok: true, cookieWritten: true })
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: vi.fn(async (): Promise<QuotaSnapshot> => ({ data: null, lastFetchAt: null })),
      refreshQuota: vi.fn(async (): Promise<QuotaSnapshot> => ({ data: mockRow, lastFetchAt: 456 })),
      configureQuota: vi.fn(async () => ({ ok: true })),
    }))
  })

  // ── available 矩阵（入口渲染判据）─────────────────────────────────────

  it('mimo（cookie 形态 + 在册 + 类型未变）→ available=true', async () => {
    const { module } = mountModule(
      provider({ quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }),
      P('mimo'),
    )
    await flushPromises()
    expect(module.view.value.cookieRefresh.available).toBe(true)
  })

  it('api-key 类（kimi-coding）与不在册 cookie 类（opendesign）→ available=false', async () => {
    const kimi = mountModule(provider({ quota: { enabled: true, fetcher: 'kimi-coding' } }), P('kimi-coding'))
    await flushPromises()
    expect(kimi.module.view.value.cookieRefresh.available).toBe(false)

    const od = mountModule(
      provider({ quota: { enabled: true, fetcher: 'opendesign', cookieSet: true } }),
      P('opendesign'),
    )
    await flushPromises()
    expect(od.module.view.value.cookieRefresh.available).toBe(false)
  })

  it('类型草稿切换未保存（归属失效）→ available=false；从未保存类型（选好草稿）→ true', async () => {
    // 磁盘 fetcher=mimo，用户切到 opencode-go 未保存 → 刷新写回的 cookie 归属不明
    const switched = mountModule(
      provider({ quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }),
      P('mimo'),
    )
    switched.module.selectType('opencode-go')
    await flushPromises()
    expect(switched.module.view.value.cookieRefresh.available).toBe(false)

    // 从未保存过 quota（savedFetcher undefined）：选好 mimo 类型即可先续期登录
    const fresh = mountModule(provider({ quota: undefined }), P('mimo'))
    fresh.module.selectType('mimo')
    await flushPromises()
    expect(fresh.module.view.value.cookieRefresh.available).toBe(true)
  })

  // ── 状态流转 ──────────────────────────────────────────────────────────

  it('成功流转：running 中间态 → ok 且 cookieWritten → 重跑 testQuery → result 复位（「正在重新查询」不悬挂）', async () => {
    let releaseIpc: ((v: { ok: boolean; cookieWritten: boolean }) => void) | undefined
    ipcRefresh.refreshQuotaCookie.mockImplementation(
      () => new Promise((resolve) => {
        releaseIpc = resolve
      }),
    )
    const { module } = mountModule(
      provider({ quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }),
      P('mimo'),
    )
    await flushPromises()

    const pending = module.refreshCookie()
    await flushPromises()
    expect(module.view.value.cookieRefresh.running).toBe(true)
    expect(ipcRefresh.refreshQuotaCookie).toHaveBeenCalledWith({ fetcherId: 'mimo', providerId: 'p1' })

    releaseIpc?.({ ok: true, cookieWritten: true })
    await pending
    await flushPromises()

    expect(module.view.value.cookieRefresh.running).toBe(false)
    // 重查完成后 result 复位：查询结果由测试结果区呈现，「已续期，正在重新查询」不悬挂
    expect(module.view.value.cookieRefresh.result).toBeNull()
    expect(module.test.value.status).toBe('success')
    expect(module.test.value.row).toEqual(mockRow)
  })

  it('失败流转：ok:false → result=fail + error 透传；草稿与测试结果不动', async () => {
    ipcRefresh.refreshQuotaCookie.mockResolvedValue({ ok: false, cookieWritten: false, error: 'login timeout' })
    const { module } = mountModule(
      provider({ quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }),
      P('mimo'),
    )
    await flushPromises()
    module.draft.value.cookie = 'userPastedCookie=1'

    await module.refreshCookie()
    await flushPromises()

    expect(module.view.value.cookieRefresh.result).toBe('fail')
    expect(module.view.value.cookieRefresh.error).toBe('login timeout')
    // 失败不清空现有表单（用户已填输入保留），不触发重查
    expect(module.draft.value.cookie).toBe('userPastedCookie=1')
    expect(module.test.value.status).toBe('idle')
  })

  it('失败无 error 时走 i18n 兜底文案', async () => {
    ipcRefresh.refreshQuotaCookie.mockResolvedValue({ ok: false, cookieWritten: false })
    const { module } = mountModule(
      provider({ quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }),
      P('mimo'),
    )
    await flushPromises()

    await module.refreshCookie()
    await flushPromises()

    expect(module.view.value.cookieRefresh.error).toBe('T:settings.providerEdit.quotaCookieAutoRefreshFail')
  })

  it('入口不可用（不在册 fetcher）→ 动作 no-op，不发 IPC', async () => {
    const { module } = mountModule(
      provider({ quota: { enabled: true, fetcher: 'opendesign', cookieSet: true } }),
      P('opendesign'),
    )
    await flushPromises()

    await module.refreshCookie()
    expect(ipcRefresh.refreshQuotaCookie).not.toHaveBeenCalled()
    expect(module.view.value.cookieRefresh.result).toBeNull()
  })
})
