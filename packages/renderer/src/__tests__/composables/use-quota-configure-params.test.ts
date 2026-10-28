/**
 * useQuotaConfigure 用户维度参数归一化链测试（2026-10 param 泛化）。
 *
 * 覆盖 buildConfigurePayload 的本地拦截与归一化分流（D13：非法输入当场拦下、不发 RPC）：
 * - 必填 param 空草稿 → quotaParamRequired 拦截，configureQuota 不被调
 * - param 归一化失败（opencode workspace 非法值）→ quotaParamInvalid 拦截
 * - 合法裸 wrk_ id → 归一化成规范额度页 URL 进 configureQuota payload.params
 * - cookie 粘贴伪影（无 k=v 对）→ quotaCookieFormatInvalid 拦截
 *
 * 归一化实现 SSOT 在 shared（normalizeQuotaParamValue，与 runtime fetcher 同一函数）；
 * 本文件锁 renderer 壳层的分流与拦截接线。mock 策略与
 * use-quota-configure-cookie-refresh.test.ts 同范式：transport stub 注入 +
 * '@/lib/ipc' 模块 mock（测试无 preload）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-quota-configure-params.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { ProviderId, ProviderInfo, QuotaPreset } from '@taiji/shared'
import { QUOTA_PRESETS } from '@taiji/shared'
import { provideSettingsTransport, getSettingsStore } from '@taiji/core'
import type { QuotaConfigureModule, QuotaSnapshot } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'

vi.mock('@/lib/ipc', () => ({
  refreshQuotaCookie: vi.fn(),
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

/** opencode-go（cookie 形态 + 单必填 param workspaceUrl，normalize=opencode-workspace）。 */
function mountOpencode(): QuotaConfigureModule {
  const t = vi.fn<(key: string) => string>((key) => `T:${key}`)
  const module = useQuotaConfigure({
    t,
    provider: ref(provider({ quota: { enabled: true, fetcher: 'opencode-go', cookieSet: true } })),
    preset: ref(P('opencode-go')),
    providerOauthPresent: ref(false),
    providerApiKeyDraft: ref(''),
  })
  return module
}

const configureQuotaMock = vi.fn(async () => ({ ok: true }))

describe('useQuotaConfigure 用户维度参数归一化链（D13 本地拦截）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getSettingsStore().setQuotaPresets([...QUOTA_PRESETS])
    vi.clearAllMocks()
    provideSettingsTransport(makeSettingsTransportStub({
      getCachedQuota: vi.fn(async (): Promise<QuotaSnapshot> => ({ data: null, lastFetchAt: null })),
      configureQuota: configureQuotaMock,
    }))
  })

  it('必填 param 空草稿 → quotaParamRequired 拦截，不发 configureQuota', async () => {
    const module = mountOpencode()
    await flushPromises()
    module.draft.value.params = { workspaceUrl: '   ' }

    await module.saveAndTest()
    await flushPromises()

    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaParamRequired')
    expect(configureQuotaMock).not.toHaveBeenCalled()
  })

  it('param 归一化失败（非 URL 非 wrk_ id）→ quotaParamInvalid 拦截', async () => {
    const module = mountOpencode()
    await flushPromises()
    module.draft.value.params = { workspaceUrl: 'not a url' }

    await module.saveAndTest()
    await flushPromises()

    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaParamInvalid')
    expect(configureQuotaMock).not.toHaveBeenCalled()
  })

  it('合法裸 wrk_ id → 归一化为规范额度页 URL 进 payload.params（类型未变 cookie 保留既存）', async () => {
    const module = mountOpencode()
    await flushPromises()
    module.draft.value.params = { workspaceUrl: 'wrk_abc123' }

    await module.saveAndTest()
    await flushPromises()

    expect(module.view.value.configureError).toBe('')
    expect(configureQuotaMock).toHaveBeenCalledTimes(1)
    const payload = configureQuotaMock.mock.calls[0]![0] as { params?: Record<string, string>; cookie?: string }
    expect(payload.params).toEqual({ workspaceUrl: 'https://opencode.ai/workspace/wrk_abc123/go' })
    // 磁盘已配 cookie（cookieSet）且类型未变：cookie undefined = 保留既存（§7.2 构造表）
    expect(payload.cookie).toBeUndefined()
  })

  it('cookie 粘贴伪影（无 k=v 对）→ quotaCookieFormatInvalid 拦截，不发 configureQuota', async () => {
    const module = mountOpencode()
    await flushPromises()
    module.draft.value.cookie = ' ; ; '
    module.draft.value.params = { workspaceUrl: 'wrk_abc123' }

    await module.saveAndTest()
    await flushPromises()

    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaCookieFormatInvalid')
    expect(configureQuotaMock).not.toHaveBeenCalled()
  })
})
