/**
 * useQuotaConfigure composable 单测（契约 v2，coding-plan-quota-config-ux §7.1/§7.2）。
 *
 * 覆盖（设计 §7.5 测试改动清单的 U4 行）：
 * ① readiness 齐备性矩阵（D1/D13）：未选类型 → ['type']；草稿类型未命中 QUOTA_PRESETS（历史数据）
 *    也 → ['type']（不静默按 api-key 分支放行）；cookie 类缺 cookie；
 *    api-key 类按 credentialSource 分流（provider 看 providerCredentialAvailable，
 *    exclusive 看「草稿 ∨ (¬typeChanged ∧ apiKeySet)」）；workspace 只看草稿
 * ② 凭证归属（D5）：savedFetcher undefined 不算类型已变；类型切换后旧凭证不计入齐备
 * ③ saveAndTest 的 payload 逐键构造（§7.2 细节 4）：cookie 空草稿 → typeChanged ? '' : undefined；
 *    apiKey 仅 exclusive 且草稿非空才传且永不 ''；workspace 必填永不 ''；credentialSource / enabled 恒传
 * ④ setEnabled（D4）：只发 { providerId, enabled }，零查询调用
 * ⑤ 去掩码（D7）：syncFromProvider 后 cookieInput / apiKeyInput 为空
 * ⑥ 同值选中类型不重置草稿（D5 细节 2 的值守卫）
 * ⑦ loadCached：data=null + reason 时保留失败态（D6 影响面表修正）
 * ⑧ configureError 走 i18n（D9）：quotaConfigureFail / quotaSaveAndTestFail
 * ⑨ §7.1 时序约定 1：payload 必须在 await 之前捕获（configure 期间广播重置草稿也不影响已提交值）
 *
 * mock 策略：vi.mock('@taiji/core/transport/api/domains/quota') 替换 RPC 层（composable 直连
 * domain，对齐 provider-edit-body-phase-b.test.ts）；pinia 提供 useQuotaStore。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-quota-configure.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { NormalizedQuotaRow, ProviderId, ProviderInfo, QuotaPreset } from '@taiji/shared'
import { QUOTA_PRESETS } from '@taiji/shared'

vi.mock('@taiji/core/transport/api/domains/quota', () => ({
  getCached: vi.fn(),
  fetchQuota: vi.fn(),
  refreshQuota: vi.fn(),
  configure: vi.fn(async () => ({ ok: true })),
}))

import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import { useQuotaConfigure } from '@/composables/features/model/useQuotaConfigure'

const P = (fetcher: string): QuotaPreset | undefined => QUOTA_PRESETS.find((p) => p.fetcher === fetcher)

const ZHIPU_PRESET = P('zhipu')
const KIMI_PRESET = P('kimi-coding')
const MIMO_PRESET = P('mimo')
const OPENCODE_PRESET = P('opencode-go')

const NONE_PRESET = ref<QuotaPreset | undefined>(undefined)

/** Provider fixture（默认 api-key 类、有 provider 凭据；quota 由各用例显式给出）。
 *  id 是 brand 类型（shared/provider.ts:14），fixture 用裸字符串提升（同 renderer 既有惯例）。 */
function provider(overrides: Partial<Omit<ProviderInfo, 'id'>> & { id?: string } = {}): ProviderInfo {
  const { id = 'p1', ...rest } = overrides
  return {
    name: 'Test Provider',
    api: 'openai-completions',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [],
    ...rest,
    id: id as ProviderId,
  } as ProviderInfo
}

/** 读取最近一次 configure 的 payload（逐键断言用；避免 toEqual 对 undefined 键的宽松处理掩盖 ''）。 */
function lastConfigurePayload() {
  return vi.mocked(quotaApi.configure).mock.calls[0]?.[0]
}

const mockRow: NormalizedQuotaRow = {
  label: 'Kimi Coding Plan',
  wins: [
    { pct: 24, used: 1204, limit: 5000, unit: 'requests', resetSec: 9005 },
    { pct: 41, resetSec: null },
    { pct: null, resetSec: null },
  ],
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: null })
  vi.mocked(quotaApi.fetchQuota).mockResolvedValue({ data: null, lastFetchAt: null })
  vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null })
  vi.mocked(quotaApi.configure).mockResolvedValue({ ok: true })
})

// ── ① readiness 齐备性矩阵 ──────────────────────────────────────────────────
describe('readiness 齐备性矩阵（D1 / D13）', () => {
  it('未选类型 → missing [type]（UI 走 D8 分支，不渲染按钮）', async () => {
    const providerRef = ref<ProviderInfo | null>(provider({ quota: undefined }))
    const { readiness, fetcherId } = useQuotaConfigure(NONE_PRESET, providerRef)
    await Promise.resolve()

    expect(fetcherId.value).toBeUndefined()
    expect(readiness.value).toEqual({ ready: false, missing: ['type'] })
  })

  it('cookie 类：草稿空且未保存 cookie → missing [cookie]；填入草稿即齐备', async () => {
    const providerRef = ref<ProviderInfo | null>(provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo' } }))
    const { readiness, cookieInput } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    expect(readiness.value).toEqual({ ready: false, missing: ['cookie'] })

    cookieInput.value = 'session=abc'
    expect(readiness.value).toEqual({ ready: true, missing: [] })
  })

  it('cookie 类：已保存 cookie 且类型未变 → 齐备（密文取「草稿 ∨ 已保存」并集）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
    )
    const { readiness, cookieInput } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    expect(cookieInput.value).toBe('')
    expect(readiness.value).toEqual({ ready: true, missing: [] })
  })

  it('草稿类型不在 QUOTA_PRESETS（历史数据 / 手工编辑 providers.json）→ missing [type]，不静默按 api-key 放行', async () => {
    // 未知 fetcher 无法判定凭证形态（是否 cookie 类 / 是否需要 workspace）：旧行为是
    // isCookieAuth / needsWorkspace 双双落 false 后走 api-key 分支，provider 凭据可用时
    // readiness.ready=true → 放行一条带未知 fetcher 的 configure。按「类型缺失」处理（D8 同形态）。
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'legacy-p',
        apiKeySet: true,
        quota: { enabled: false, fetcher: 'legacy-unknown', apiKeySet: true },
      }),
    )
    const { readiness, fetcherId } = useQuotaConfigure(NONE_PRESET, providerRef)
    await Promise.resolve()

    expect(fetcherId.value).toBe('legacy-unknown')
    expect(readiness.value).toEqual({ ready: false, missing: ['type'] })

    // 重选一个有效预设类型 → 判定恢复常态（守卫不是「命中一次就永久卡死」）
    fetcherId.value = 'kimi-coding'
    expect(readiness.value.missing).not.toContain('type')
  })

  it('api-key 类 source=provider：看 providerCredentialAvailable（provider.apiKeySet）', async () => {
    const ready = useQuotaConfigure(
      ref(KIMI_PRESET),
      ref<ProviderInfo | null>(provider({ id: 'kimi-p', apiKeySet: true, quota: { enabled: false, fetcher: 'kimi-coding' } })),
    )
    await Promise.resolve()
    expect(ready.providerCredentialAvailable.value).toBe(true)
    expect(ready.readiness.value).toEqual({ ready: true, missing: [] })

    const missing = useQuotaConfigure(
      ref(KIMI_PRESET),
      ref<ProviderInfo | null>(provider({ id: 'kimi-p', apiKeySet: false, quota: { enabled: false, fetcher: 'kimi-coding' } })),
    )
    await Promise.resolve()
    expect(missing.providerCredentialAvailable.value).toBe(false)
    expect(missing.readiness.value).toEqual({ ready: false, missing: ['apiKey'] })
  })

  it('api-key 类 source=exclusive：已保存 apiKeySet 且类型未变 → 齐备；清空后仅草稿兜底', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
    )
    const { readiness, credentialSource, apiKeyInput, quotaApiKeyConfigured } = useQuotaConfigure(
      ref(ZHIPU_PRESET),
      providerRef,
    )
    await Promise.resolve()

    expect(credentialSource.value).toBe('exclusive')
    expect(quotaApiKeyConfigured.value).toBe(true)
    expect(readiness.value).toEqual({ ready: true, missing: [] })

    apiKeyInput.value = 'sk-draft'
    expect(readiness.value).toEqual({ ready: true, missing: [] })
  })

  it('cookie 类 fetcher（auth 不含 api-key）+ credentialSource=exclusive → 不走专属 Key 判定，仍按 cookie 齐备性', async () => {
    // §7 残留 11：exclusive 只对声明了 api-key 形态的 fetcher 适用。cookie 类即使磁盘上残留
    // credentialSource='exclusive'，判定也必须落回 cookie 分支（与 runtime 忽略 exclusive、
    // 按 auth 数组序解析一致），不得因「专属 Key 缺失」置灰（apiKeySet=false 也不会误报 apiKey）。
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'mimo-p',
        quota: { enabled: false, fetcher: 'mimo', credentialSource: 'exclusive', cookieSet: true },
      }),
    )
    const { readiness, authKinds } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    expect(authKinds.value).toEqual(['cookie'])
    expect(readiness.value).toEqual({ ready: true, missing: [] })

    // 无 cookie 且未保存 → 只报 cookie（不报 apiKey，证明 exclusive 未参与判定）
    const noCookieRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', credentialSource: 'exclusive' } }),
    )
    const noCookie = useQuotaConfigure(ref(MIMO_PRESET), noCookieRef)
    await Promise.resolve()
    expect(noCookie.readiness.value).toEqual({ ready: false, missing: ['cookie'] })
  })

  it('requiresWorkspace 只看草稿：已保存 workspace 不计入，清空即置灰（D13）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'oc-p',
        quota: {
          enabled: false,
          fetcher: 'opencode-go',
          cookieSet: true,
          workspace: 'https://opencode.ai/workspace/wrk_saved/go',
        },
      }),
    )
    const { readiness, workspaceInput } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    expect(workspaceInput.value).toBe('https://opencode.ai/workspace/wrk_saved/go')
    expect(readiness.value).toEqual({ ready: true, missing: [] })

    workspaceInput.value = ''
    // 磁盘上仍有 workspace，但判定只看草稿 —— 两个密文字段才是并集规则
    expect(readiness.value).toEqual({ ready: false, missing: ['workspace'] })
  })

  it('多个缺口按 cookie → workspace 顺序累积', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go' } }),
    )
    const { readiness } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    expect(readiness.value).toEqual({ ready: false, missing: ['cookie', 'workspace'] })
  })
})

// ── ② 凭证归属（D5） ────────────────────────────────────────────────────────
describe('凭证归属 typeChanged（D5）', () => {
  it('savedFetcher undefined 不算类型已变（无既存归属可比）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: false, cookieSet: true } }),
    )
    const { fetcherId, readiness, saveAndTest } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    // 草稿类型来自自动匹配 preset；quota.fetcher 未保存过
    expect(fetcherId.value).toBe('mimo')
    expect(readiness.value).toEqual({ ready: true, missing: [] })

    await saveAndTest()

    // 若把 undefined 也算变更，这里会传 '' 制造一次用户从未请求的 cookie 清除
    expect(lastConfigurePayload()?.cookie).toBeUndefined()
  })

  it('类型切换后旧 cookie 归属失效：不计入齐备', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
    )
    const { fetcherId, readiness, workspaceInput, cookieInput } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    expect(readiness.value).toEqual({ ready: true, missing: [] })

    fetcherId.value = 'opencode-go'
    workspaceInput.value = 'wrk_abc'
    // 旧 MiMo cookie 不再算「已填」；workspace 草稿已填
    expect(readiness.value).toEqual({ ready: false, missing: ['cookie'] })

    cookieInput.value = 'opencode-session'
    expect(readiness.value).toEqual({ ready: true, missing: [] })
  })

  it('类型切换后旧专属 Key 归属失效（exclusive 来源）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
    )
    const { fetcherId, readiness, apiKeyInput } = useQuotaConfigure(ref(ZHIPU_PRESET), providerRef)
    await Promise.resolve()

    expect(readiness.value).toEqual({ ready: true, missing: [] })

    fetcherId.value = 'minimax'
    expect(readiness.value).toEqual({ ready: false, missing: ['apiKey'] })

    apiKeyInput.value = 'sk-new'
    expect(readiness.value).toEqual({ ready: true, missing: [] })
  })
})

// ── ③ saveAndTest payload 构造（§7.2 细节 4） ───────────────────────────────
describe('saveAndTest payload 构造（§7.2 细节 4）', () => {
  it('cookie 类：草稿空 + 类型未变 → cookie 缺省；fetcher / credentialSource / enabled 恒传', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
    )
    const { saveAndTest } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    await saveAndTest()

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(lastConfigurePayload()).toEqual({
      providerId: 'mimo-p',
      enabled: false,
      fetcher: 'mimo',
      credentialSource: 'provider',
      cookie: undefined,
      apiKey: undefined,
      workspace: undefined,
    })
  })

  it('cookie 类：草稿非空 → 传 trim 后的草稿', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
    )
    const { saveAndTest, cookieInput } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    cookieInput.value = '  session=abc  '
    await saveAndTest()

    expect(lastConfigurePayload()?.cookie).toBe('session=abc')
  })

  it('类型变更 + cookie 草稿空 → 传空串清除（归属失效无条件清除）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
    )
    const { fetcherId, saveAndTest } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    fetcherId.value = 'zhipu'
    await saveAndTest()

    expect(lastConfigurePayload()).toEqual({
      providerId: 'mimo-p',
      enabled: false,
      fetcher: 'zhipu',
      credentialSource: 'provider',
      cookie: '',
      apiKey: undefined,
      workspace: undefined,
    })
  })

  it('exclusive 来源：草稿非空 → 传 apiKey；enabled 跟随当前值恒传', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'zhipu-p',
        quota: { enabled: true, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
    )
    const { saveAndTest, apiKeyInput } = useQuotaConfigure(ref(ZHIPU_PRESET), providerRef)
    await Promise.resolve()

    apiKeyInput.value = ' sk-own '
    await saveAndTest()

    expect(lastConfigurePayload()).toEqual({
      providerId: 'zhipu-p',
      enabled: true,
      fetcher: 'zhipu',
      credentialSource: 'exclusive',
      cookie: undefined,
      apiKey: 'sk-own',
      workspace: undefined,
    })
  })

  it('exclusive 来源：草稿空 → apiKey 永不传空串（undefined 保留既存）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
    )
    const { saveAndTest, apiKeyInput } = useQuotaConfigure(ref(ZHIPU_PRESET), providerRef)
    await Promise.resolve()

    await saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()

    vi.mocked(quotaApi.configure).mockClear()
    apiKeyInput.value = '   '
    await saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()
  })

  it('source=provider 时即使草稿填了 apiKey 也不传（专属 Key 失效由来源表达，D3）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', credentialSource: 'provider' },
      }),
    )
    const { saveAndTest, apiKeyInput, readiness } = useQuotaConfigure(ref(ZHIPU_PRESET), providerRef)
    await Promise.resolve()

    apiKeyInput.value = 'sk-ignored'
    expect(readiness.value).toEqual({ ready: true, missing: [] })

    await saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()
  })

  it('workspace 必填：草稿非空 → 传归一化 URL（永不空串）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true } }),
    )
    const { saveAndTest, workspaceInput } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    workspaceInput.value = 'wrk_newid77'
    await saveAndTest()

    expect(lastConfigurePayload()).toEqual({
      providerId: 'oc-p',
      enabled: false,
      fetcher: 'opencode-go',
      credentialSource: 'provider',
      cookie: undefined,
      apiKey: undefined,
      workspace: 'https://opencode.ai/workspace/wrk_newid77/go',
    })
  })

  it('workspace 草稿空 → 本地拦截，不发 RPC（D13：不再有空串 = 清除通道）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'oc-p',
        quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true, workspace: 'https://opencode.ai/workspace/wrk_x/go' },
      }),
    )
    const { saveAndTest, workspaceInput, configureError } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    workspaceInput.value = ''
    await saveAndTest()

    expect(quotaApi.configure).not.toHaveBeenCalled()
    expect(configureError.value).toBe('请先输入 Workspace 地址')
  })

  it('非 requiresWorkspace 类型不传 workspace 键', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { saveAndTest } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    await saveAndTest()
    expect(lastConfigurePayload()?.workspace).toBeUndefined()
  })

  it('保存成功后清空密文草稿（不回显，D7）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
    )
    const { saveAndTest, apiKeyInput } = useQuotaConfigure(ref(ZHIPU_PRESET), providerRef)
    await Promise.resolve()

    apiKeyInput.value = 'sk-own'
    await saveAndTest()

    expect(apiKeyInput.value).toBe('')
  })

  it('落盘成功后触发一次查询（D2：保存并测试合一）', async () => {
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: mockRow, lastFetchAt: 2000 })
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { saveAndTest, testStatus, quotaData } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    await saveAndTest()

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(quotaApi.refreshQuota).toHaveBeenCalledWith('kimi-p')
    expect(testStatus.value).toBe('success')
    expect(quotaData.value).toEqual(mockRow)
  })

  it('落盘失败 → 不触发查询，失败态走 i18n', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '' })
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { saveAndTest, configureError } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    await saveAndTest()

    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
    expect(configureError.value).toBe('保存并测试失败')
  })

  it('payload 在 await 之前捕获：configure 期间 provider 广播重置草稿，提交的 fetcher 仍是调用时刻的草稿值', async () => {
    // 防的回归：payload 组装被移到 await 之后（§7.1 时序约定 1）。真实链路里 configure 成功后
    // runtime 广播 provider 列表 → watch(providerRef) → syncFromProvider 把草稿重置为磁盘态，
    // 此时再读草稿读到的是被重置后的值（用户选的类型丢失）。
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { fetcherId, saveAndTest } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    // 草稿：用户把类型从磁盘值 kimi-coding 改成 zhipu
    fetcherId.value = 'zhipu'

    // 调用期间改写 providerRef（新对象引用触发 watch → syncFromProvider 重置草稿）
    vi.mocked(quotaApi.configure).mockImplementation(async () => {
      providerRef.value = provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } })
      return { ok: true }
    })

    await saveAndTest()

    expect(lastConfigurePayload()?.fetcher).toBe('zhipu')
    // 反证：重置确实发生了（否则本用例空转 —— 草稿本来就还是 'zhipu'）
    expect(fetcherId.value).toBe('kimi-coding')
  })
})

// ── ④ setEnabled（D4） ──────────────────────────────────────────────────────
describe('setEnabled 纯配置位（D4）', () => {
  it('只发 { providerId, enabled } 且零查询调用（草稿类型 / 来源不被偷偷落盘）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { setEnabled, fetcherId, enabled } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    // 草稿里制造未提交的类型选择：开关不得把它带出去
    fetcherId.value = 'mimo'
    await setEnabled(true)

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(vi.mocked(quotaApi.configure).mock.calls[0]![0]).toEqual({ providerId: 'kimi-p', enabled: true })
    expect(enabled.value).toBe(true)
    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
    expect(quotaApi.fetchQuota).not.toHaveBeenCalled()
    expect(quotaApi.getCached).not.toHaveBeenCalled()
  })

  it('关闭同样只发单字段；失败回滚开关并落 i18n 文案', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '' })
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
    )
    const { setEnabled, enabled, configureError } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await vi.waitFor(() => { expect(enabled.value).toBe(true) })

    await setEnabled(false)

    expect(vi.mocked(quotaApi.configure).mock.calls[0]![0]).toEqual({ providerId: 'kimi-p', enabled: false })
    expect(enabled.value).toBe(true) // 回滚
    expect(configureError.value).toBe('额度查询配置保存失败')
    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
  })

  it('transport 抛错 → 回滚开关并落 i18n 文案', async () => {
    vi.mocked(quotaApi.configure).mockRejectedValue(new Error('transport unavailable'))
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { setEnabled, enabled, configureError } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    await setEnabled(true)

    expect(enabled.value).toBe(false)
    // 抛错路径沿用 message（诊断信息优先），非 i18n 默认串
    expect(configureError.value).toBe('transport unavailable')
  })
})

// ── ⑤ 去掩码（D7） ──────────────────────────────────────────────────────────
describe('去掩码（D7）', () => {
  it('syncFromProvider 后 cookie / 专属 Key 输入框为空（不回填掩码或密文）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'oc-p',
        apiKeySet: true,
        quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true, apiKeySet: true },
      }),
    )
    const { cookieInput, apiKeyInput } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    expect(cookieInput.value).toBe('')
    expect(apiKeyInput.value).toBe('')
  })

  it('provider 快照更新（广播）重跑 syncFromProvider → 草稿被重置为磁盘态（已保存标记独立可见）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go' } }),
    )
    const { cookieInput, workspaceInput } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    cookieInput.value = 'draft-cookie'
    providerRef.value = provider({
      id: 'oc-p',
      quota: {
        enabled: false,
        fetcher: 'opencode-go',
        cookieSet: true,
        workspace: 'https://opencode.ai/workspace/wrk_saved/go',
      },
    })

    await vi.waitFor(() => { expect(workspaceInput.value).toBe('https://opencode.ai/workspace/wrk_saved/go') })
    expect(cookieInput.value).toBe('')
  })
})

// ── ⑥ 类型草稿同值短路（D5 细节 2） ─────────────────────────────────────────
describe('类型草稿写入（D5 细节 2）', () => {
  it('同值选中不重置凭证草稿、不发 RPC（reka Select 同值也 emit）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
    )
    const { fetcherId, cookieInput } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)
    await Promise.resolve()

    cookieInput.value = 'unsubmitted'
    fetcherId.value = 'mimo'

    expect(cookieInput.value).toBe('unsubmitted')
    expect(quotaApi.configure).not.toHaveBeenCalled()
  })

  it('类型真变 → 清凭证草稿，但 Workspace 草稿保留（D13）', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({
        id: 'oc-p',
        quota: {
          enabled: false,
          fetcher: 'opencode-go',
          cookieSet: true,
          workspace: 'https://opencode.ai/workspace/wrk_saved/go',
        },
      }),
    )
    const { fetcherId, cookieInput, workspaceInput } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    cookieInput.value = 'unsubmitted'
    fetcherId.value = 'mimo'

    expect(cookieInput.value).toBe('')
    expect(workspaceInput.value).toBe('https://opencode.ai/workspace/wrk_saved/go')
    expect(quotaApi.configure).not.toHaveBeenCalled()
  })
})

// ── ⑦ loadCached reason（D6 影响面表修正） ──────────────────────────────────
describe('loadCached reason 透传', () => {
  it('data=null 但带 reason → 整体呈失败态（不再丢成 idle）', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: 5000, reason: 'no-credential' })
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'mimo-p', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }),
    )
    const { testStatus, testFailReason, quotaData, lastFetchAt } = useQuotaConfigure(ref(MIMO_PRESET), providerRef)

    await vi.waitFor(() => { expect(testStatus.value).toBe('error') })
    expect(testFailReason.value).toBe('no-credential')
    expect(quotaData.value).toBeNull()
    expect(lastFetchAt.value).toBe(5000)
  })

  it('缓存携带 reason + 旧数据 → 失败态且旧数据保留（「查看上次成功数据」数据源）', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000, reason: 'unauthorized' })
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
    )
    const { testStatus, testFailReason, quotaData } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)

    await vi.waitFor(() => { expect(testStatus.value).toBe('error') })
    expect(testFailReason.value).toBe('unauthorized')
    expect(quotaData.value).toEqual(mockRow)
  })

  it('缓存无 reason → success 态；provider 无 quota 配置 → idle 且不调 getCached', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000 })
    const kimi = useQuotaConfigure(
      ref(KIMI_PRESET),
      ref<ProviderInfo | null>(provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } })),
    )
    await vi.waitFor(() => { expect(kimi.testStatus.value).toBe('success') })
    expect(kimi.testFailReason.value).toBeNull()

    vi.mocked(quotaApi.getCached).mockClear()
    const noQuota = useQuotaConfigure(
      ref(KIMI_PRESET),
      ref<ProviderInfo | null>(provider({ id: 'kimi-p', quota: undefined })),
    )
    await Promise.resolve()
    expect(noQuota.testStatus.value).toBe('idle')
    expect(quotaApi.getCached).not.toHaveBeenCalled()
  })
})

// ── ⑧ configureError 走 i18n（D9） ─────────────────────────────────────────
describe('configureError i18n（D9）', () => {
  it('saveAndTest 返回 ok:false 且带 error → 优先透传 error（跳过 i18n 兜底）', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: 'disk full' })
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { saveAndTest, configureError } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    await saveAndTest()
    expect(configureError.value).toBe('disk full')
  })

  it('saveAndTest 非 Error 抛错 → 兜底走 quotaSaveAndTestFail', async () => {
    vi.mocked(quotaApi.configure).mockRejectedValue('boom')
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { saveAndTest, configureError } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    await saveAndTest()
    expect(configureError.value).toBe('保存并测试失败')
  })

  it('workspace 非法输入 → i18n 文案且不发 RPC', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true } }),
    )
    const { saveAndTest, workspaceInput, configureError } = useQuotaConfigure(ref(OPENCODE_PRESET), providerRef)
    await Promise.resolve()

    workspaceInput.value = 'https://evil.example.com/workspace/wrk_x/go'
    await saveAndTest()

    expect(quotaApi.configure).not.toHaveBeenCalled()
    expect(configureError.value).toContain('Workspace 地址无效')
  })
})

// ── 既有回归：reset / testQuery reason / preset 派生 ────────────────────────
describe('既有回归（reset / reason 透传 / preset 派生）', () => {
  it('saveAndTest 内查询失败 → reason 透传 + lastFetchAt = 最近成功时间', async () => {
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: 5000, reason: 'network' })
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { saveAndTest, testStatus, testFailReason, testError, lastFetchAt } = useQuotaConfigure(
      ref(KIMI_PRESET),
      providerRef,
    )
    await Promise.resolve()

    await saveAndTest()

    expect(testStatus.value).toBe('error')
    expect(testFailReason.value).toBe('network')
    expect(lastFetchAt.value).toBe(5000)
    expect(testError.value).toBe('查询失败，请检查凭证')
  })

  it('查询抛错 → error 态 + testFailReason=null + 错误消息透传', async () => {
    vi.mocked(quotaApi.refreshQuota).mockRejectedValue(new Error('transport unavailable'))
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { saveAndTest, testStatus, testFailReason, testError } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    await saveAndTest()

    expect(testStatus.value).toBe('error')
    expect(testFailReason.value).toBeNull()
    expect(testError.value).toContain('transport unavailable')
  })

  it('失败态后 reset → idle + 失败痕迹清空', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: 1000, reason: 'unauthorized' })
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
    )
    const { reset, testStatus, testFailReason, quotaData } = useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await vi.waitFor(() => { expect(testStatus.value).toBe('error') })

    reset()

    expect(testStatus.value).toBe('idle')
    expect(testFailReason.value).toBeNull()
    expect(quotaData.value).toBeNull()
  })

  it('needsWorkspace / authKinds / workspaceConfigured 随草稿类型派生', async () => {
    const providerRef = ref<ProviderInfo | null>(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
    )
    const { needsWorkspace, authKinds, isCookieAuth, fetcherId, workspaceConfigured, workspaceInput } =
      useQuotaConfigure(ref(KIMI_PRESET), providerRef)
    await Promise.resolve()

    expect(fetcherId.value).toBe('kimi-coding')
    expect(authKinds.value).toEqual(['api-key', 'oauth'])
    expect(isCookieAuth.value).toBe(false)
    expect(needsWorkspace.value).toBe(false)

    fetcherId.value = 'opencode-go'
    expect(authKinds.value).toEqual(['cookie'])
    expect(isCookieAuth.value).toBe(true)
    expect(needsWorkspace.value).toBe(true)
    expect(workspaceConfigured.value).toBe(false)

    workspaceInput.value = 'https://opencode.ai/workspace/wrk_x/go'
    expect(workspaceConfigured.value).toBe(false) // 只看 provider 已保存值，草稿不算
  })
})
