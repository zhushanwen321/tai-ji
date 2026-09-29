// @vitest-environment node

/**
 * useQuotaConfigure（QuotaConfigure module 实现）接口级单测（契约 v2，coding-plan-quota-config-ux
 * §7.1/§7.2；C1 收拢后测试面 = core QuotaConfigureModule 接口）。
 *
 * interface is the test surface：全部用例只经 draft / view / test 三个透镜 + 3 个写动作打点，
 * 不窥内部 ref —— 契约收窄 / 内部重组不失效这些断言，正是「行为保持 refactor」的验收面。
 *
 * 覆盖（设计 §7.5 测试改动清单 + C1 新派生面）：
 * ① readiness 齐备性矩阵（D1/D13）：未选类型 → ['type']；草稿类型未命中 QUOTA_PRESETS（历史数据）
 *    也 → ['type']（不静默按 api-key 分支放行）；cookie 类缺 cookie；
 *    api-key 类按 credentialSource 分流（provider 看 providerAvailable，
 *    exclusive 看「草稿 ∨ (¬typeChanged ∧ apiKeySet)」）；workspace 只看草稿
 * ② 凭证归属（D5）：savedFetcher undefined 不算类型已变；类型切换后旧凭证不计入齐备
 * ③ saveAndTest 的 payload 逐键构造（§7.2 细节 4）：cookie 空草稿 → typeChanged ? '' : undefined；
 *    apiKey 仅 exclusive 且草稿非空才传且永不 ''；workspace 必填永不 ''；credentialSource / enabled 恒传
 * ④ setEnabled（D4）：只发 { providerId, enabled }，零查询调用
 * ⑤ 去掩码（D7）：syncFromProvider 后 cookie / apiKey 草稿为空
 * ⑥ 类型草稿写入（D5 细节 2）：同值短路 / 真变清凭证草稿 / 非字符串守卫
 * ⑦ loadCached：data=null + reason 时保留失败态（D6 影响面表修正）
 * ⑧ configureError 走 i18n（D9）：quotaConfigureFail / quotaSaveAndTestFail
 * ⑨ §7.1 时序约定 1：payload 必须在 await 之前捕获（configure 期间广播重置草稿也不影响已提交值）
 * ⑩ 收拢进 implementation 的派生面：失败原因归一（A2-4）/ providerWarning 分档（§7.4）/
 *    sourceHint 分档（D3）/ type.undetermined（D8）
 *
 * mock 策略：SettingsTransport seam 桩（[C3] 测试打 seam）替换 quota RPC 层（module 经 seam 消费，
 * 对齐 provider-edit-body-phase-b.test.ts）；pinia 提供 useQuotaStore。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-quota-configure.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { NormalizedQuotaRow, ProviderId, ProviderInfo, QuotaConfigurePayload, QuotaFetchFailureReason, QuotaPreset } from '@taiji/shared'
import { QUOTA_PRESETS } from '@taiji/shared'
import type { QuotaConfigureModule, QuotaFailureKind, QuotaSnapshot, Translate } from '@taiji/core'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'

// [C3] quota RPC 经 SettingsTransport seam 桩注入（getCachedQuota/configureQuota/refreshQuota
// 逐名映射到本 mock 集，替换原 domains/quota 模块 mock；断言面不变，仍打 quotaApi.*）。
// fetchQuota 不在 seam 方法面（useQuotaConfigure 结构上不可达），保留仅供「零查询调用」负向断言。
const quotaApi = vi.hoisted(() => ({
  getCached: vi.fn<(providerId: string) => Promise<QuotaSnapshot>>(),
  fetchQuota: vi.fn<(providerId: string) => Promise<QuotaSnapshot>>(),
  refreshQuota: vi.fn<(providerId: string) => Promise<QuotaSnapshot>>(),
  configure: vi.fn<(payload: QuotaConfigurePayload) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true })),
}))

import { useQuotaConfigure } from '@/composables/features/settings/useQuotaConfigure'

const P = (fetcher: string): QuotaPreset | undefined => QUOTA_PRESETS.find((p) => p.fetcher === fetcher)

const ZHIPU_PRESET = P('zhipu')
const KIMI_PRESET = P('kimi-coding')
const MIMO_PRESET = P('mimo')
const OPENCODE_PRESET = P('opencode-go')

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

/** module 装配（对齐 QuotaConfigureInputs）：返回实例 + provider ref（广播重置用例要换快照）。
 *  t 注入 fake（key 前缀 T: 渲染）：文案断言全部走「注入 t 的渲染值」，证明 i18n 出口来自
 *  注入而非模块级 cast（失败文案用例见 ⑧ describe 的显式打点断言）。 */
function mountModule(
  providerInit: ProviderInfo,
  opts: { preset?: QuotaPreset | undefined; oauthPresent?: boolean; providerApiKeyDraft?: string } = {},
): { module: QuotaConfigureModule; provider: Ref<ProviderInfo | null>; t: Translate } {
  const providerRef = ref<ProviderInfo | null>(providerInit)
  const t = vi.fn<(key: string, params?: Record<string, unknown>) => string>((key) => `T:${key}`)
  const module = useQuotaConfigure({
    t,
    provider: providerRef,
    preset: ref(opts.preset),
    providerOauthPresent: ref(opts.oauthPresent ?? false),
    providerApiKeyDraft: ref(opts.providerApiKeyDraft ?? ''),
  })
  return { module, provider: providerRef, t }
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
  provideSettingsTransport(makeSettingsTransportStub({
    getCachedQuota: quotaApi.getCached,
    refreshQuota: quotaApi.refreshQuota,
    configureQuota: quotaApi.configure,
  }))
})

// ── ① readiness 齐备性矩阵 ──────────────────────────────────────────────────
describe('readiness 齐备性矩阵（D1 / D13）', () => {
  it('未选类型 → missing [type] + type.undetermined（UI 走 D8 分支，不渲染按钮）', async () => {
    const { module } = mountModule(provider({ quota: undefined }))
    await Promise.resolve()

    expect(module.view.value.type.selected).toBeUndefined()
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['type'] })
    expect(module.view.value.type.undetermined).toBe(true)
  })

  it('cookie 类：草稿空且未保存 cookie → missing [cookie]；填入草稿即齐备', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo' } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['cookie'] })

    module.draft.value.cookie = 'session=abc'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })

  it('cookie 类：已保存 cookie 且类型未变 → 齐备（密文取「草稿 ∨ 已保存」并集）', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.cookie).toBe('')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })

  it('草稿类型不在 QUOTA_PRESETS（历史数据 / 手工编辑 providers.json）→ missing [type]，不静默按 api-key 放行', async () => {
    // 未知 fetcher 无法判定凭证形态（是否 cookie 类 / 是否需要 workspace）：旧行为是
    // isCookieAuth / needsWorkspace 双双落 false 后走 api-key 分支，provider 凭据可用时
    // readiness.ready=true → 放行一条带未知 fetcher 的 configure。按「类型缺失」处理（D8 同形态）。
    const { module } = mountModule(
      provider({
        id: 'legacy-p',
        apiKeySet: true,
        quota: { enabled: false, fetcher: 'legacy-unknown', apiKeySet: true },
      }),
    )
    await Promise.resolve()

    expect(module.view.value.type.selected).toBe('legacy-unknown')
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['type'] })

    // 重选一个有效预设类型 → 判定恢复常态（守卫不是「命中一次就永久卡死」）
    module.selectType('kimi-coding')
    expect(module.view.value.readiness.missing).not.toContain('type')
  })

  it('api-key 类 source=provider：看 providerAvailable（provider.apiKeySet）', async () => {
    const ready = mountModule(
      provider({ id: 'kimi-p', apiKeySet: true, quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()
    expect(ready.module.view.value.credential.providerAvailable).toBe(true)
    expect(ready.module.view.value.readiness).toEqual({ ready: true, missing: [] })

    const missing = mountModule(
      provider({ id: 'kimi-p', apiKeySet: false, quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()
    expect(missing.module.view.value.credential.providerAvailable).toBe(false)
    expect(missing.module.view.value.readiness).toEqual({ ready: false, missing: ['apiKey'] })
  })

  it('api-key 类 source=exclusive：已保存 apiKeySet 且类型未变 → 齐备；填草稿仍齐备', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.credentialSource).toBe('exclusive')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    module.draft.value.apiKey = 'sk-draft'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })

  it('cookie 类 fetcher（auth 不含 api-key）+ credentialSource=exclusive → 不走专属 Key 判定，仍按 cookie 齐备性', async () => {
    // §7 残留 11：exclusive 只对声明了 api-key 形态的 fetcher 适用。cookie 类即使磁盘上残留
    // credentialSource='exclusive'，判定也必须落回 cookie 分支（与 runtime 忽略 exclusive、
    // 按 auth 数组序解析一致），不得因「专属 Key 缺失」置灰（apiKeySet=false 也不会误报 apiKey）。
    const { module } = mountModule(
      provider({
        id: 'mimo-p',
        quota: { enabled: false, fetcher: 'mimo', credentialSource: 'exclusive', cookieSet: true },
      }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.credential.form).toBe('cookie')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    // 无 cookie 且未保存 → 只报 cookie（不报 apiKey，证明 exclusive 未参与判定）
    const noCookie = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', credentialSource: 'exclusive' } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()
    expect(noCookie.module.view.value.readiness).toEqual({ ready: false, missing: ['cookie'] })
  })

  it('requiresWorkspace 只看草稿：已保存 workspace 不计入，清空即置灰（D13）', async () => {
    const { module } = mountModule(
      provider({
        id: 'oc-p',
        quota: {
          enabled: false,
          fetcher: 'opencode-go',
          cookieSet: true,
          workspace: 'https://opencode.ai/workspace/wrk_saved/go',
        },
      }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.workspace).toBe('https://opencode.ai/workspace/wrk_saved/go')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    module.draft.value.workspace = ''
    // 磁盘上仍有 workspace，但判定只看草稿 —— 两个密文字段才是并集规则
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['workspace'] })
  })

  it('多个缺口按 cookie → workspace 顺序累积', async () => {
    const { module } = mountModule(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go' } }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['cookie', 'workspace'] })
  })
})

// ── ② 凭证归属（D5） ────────────────────────────────────────────────────────
describe('凭证归属 typeChanged（D5）', () => {
  it('savedFetcher undefined 不算类型已变（无既存归属可比）', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    // 草稿类型来自自动匹配 preset；quota.fetcher 未保存过
    expect(module.view.value.type.selected).toBe('mimo')
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    await module.saveAndTest()

    // 若把 undefined 也算变更，这里会传 '' 制造一次用户从未请求的 cookie 清除
    expect(lastConfigurePayload()?.cookie).toBeUndefined()
  })

  it('类型切换后旧 cookie 归属失效：不计入齐备', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    module.selectType('opencode-go')
    module.draft.value.workspace = 'wrk_abc'
    // 旧 MiMo cookie 不再算「已填」；workspace 草稿已填
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['cookie'] })

    module.draft.value.cookie = 'opencode-session'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })

  it('类型切换后旧专属 Key 归属失效（exclusive 来源）', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    module.selectType('minimax')
    expect(module.view.value.readiness).toEqual({ ready: false, missing: ['apiKey'] })

    module.draft.value.apiKey = 'sk-new'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })
  })
})

// ── ③ saveAndTest payload 构造（§7.2 细节 4） ───────────────────────────────
describe('saveAndTest payload 构造（§7.2 细节 4）', () => {
  it('cookie 类：草稿空 + 类型未变 → cookie 缺省；fetcher / credentialSource / enabled 恒传', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()

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
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    module.draft.value.cookie = '  session=abc  '
    await module.saveAndTest()

    expect(lastConfigurePayload()?.cookie).toBe('session=abc')
  })

  it('类型变更 + cookie 草稿空 → 传空串清除（归属失效无条件清除）', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    module.selectType('zhipu')
    await module.saveAndTest()

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
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: true, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    module.draft.value.apiKey = ' sk-own '
    await module.saveAndTest()

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
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()

    vi.mocked(quotaApi.configure).mockClear()
    module.draft.value.apiKey = '   '
    await module.saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()
  })

  it('source=provider 时即使草稿填了 apiKey 也不传（专属 Key 失效由来源表达，D3）', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', credentialSource: 'provider' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    module.draft.value.apiKey = 'sk-ignored'
    expect(module.view.value.readiness).toEqual({ ready: true, missing: [] })

    await module.saveAndTest()
    expect(lastConfigurePayload()?.apiKey).toBeUndefined()
  })

  it('workspace 必填：草稿非空 → 传归一化 URL（永不空串）', async () => {
    const { module } = mountModule(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true } }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    module.draft.value.workspace = 'wrk_newid77'
    await module.saveAndTest()

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
    const { module } = mountModule(
      provider({
        id: 'oc-p',
        quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true, workspace: 'https://opencode.ai/workspace/wrk_x/go' },
      }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    module.draft.value.workspace = ''
    await module.saveAndTest()

    expect(quotaApi.configure).not.toHaveBeenCalled()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaWorkspaceRequired')
  })

  it('非 requiresWorkspace 类型不传 workspace 键', async () => {
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()
    expect(lastConfigurePayload()?.workspace).toBeUndefined()
  })

  it('保存成功后清空密文草稿（不回显，D7）', async () => {
    const { module } = mountModule(
      provider({
        id: 'zhipu-p',
        quota: { enabled: false, fetcher: 'zhipu', apiKeySet: true, credentialSource: 'exclusive' },
      }),
      { preset: ZHIPU_PRESET },
    )
    await Promise.resolve()

    module.draft.value.apiKey = 'sk-own'
    await module.saveAndTest()

    expect(module.draft.value.apiKey).toBe('')
  })

  it('落盘成功后触发一次查询（D2：保存并测试合一）', async () => {
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: mockRow, lastFetchAt: 2000 })
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(quotaApi.refreshQuota).toHaveBeenCalledWith('kimi-p')
    expect(module.test.value.status).toBe('success')
    expect(module.test.value.row).toEqual(mockRow)
  })

  it('落盘失败 → 不触发查询，失败态走 i18n', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '' })
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()

    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaSaveAndTestFail')
  })

  it('payload 在 await 之前捕获：configure 期间 provider 广播重置草稿，提交的 fetcher 仍是调用时刻的草稿值', async () => {
    // 防的回归：payload 组装被移到 await 之后（§7.1 时序约定 1）。真实链路里 configure 成功后
    // runtime 广播 provider 列表 → watch(providerRef) → syncFromProvider 把草稿重置为磁盘态，
    // 此时再读草稿读到的是被重置后的值（用户选的类型丢失）。
    const { module, provider: providerRef } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    // 草稿：用户把类型从磁盘值 kimi-coding 改成 zhipu
    module.selectType('zhipu')

    // 调用期间改写 providerRef（新对象引用触发 watch → syncFromProvider 重置草稿）
    vi.mocked(quotaApi.configure).mockImplementation(async () => {
      providerRef.value = provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } })
      return { ok: true }
    })

    await module.saveAndTest()

    expect(lastConfigurePayload()?.fetcher).toBe('zhipu')
    // 反证：重置确实发生了（否则本用例空转 —— 草稿本来就还是 'zhipu'）
    expect(module.view.value.type.selected).toBe('kimi-coding')
  })
})

// ── ④ setEnabled（D4） ──────────────────────────────────────────────────────
describe('setEnabled 纯配置位（D4）', () => {
  it('只发 { providerId, enabled } 且零查询调用（草稿类型 / 来源不被偷偷落盘）', async () => {
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    // 草稿里制造未提交的类型选择：开关不得把它带出去
    module.selectType('mimo')
    await module.setEnabled(true)

    expect(quotaApi.configure).toHaveBeenCalledTimes(1)
    expect(vi.mocked(quotaApi.configure).mock.calls[0]![0]).toEqual({ providerId: 'kimi-p', enabled: true })
    expect(module.view.value.enabled).toBe(true)
    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
    expect(quotaApi.fetchQuota).not.toHaveBeenCalled()
    expect(quotaApi.getCached).not.toHaveBeenCalled()
  })

  it('关闭同样只发单字段；失败回滚开关并落 i18n 文案', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '' })
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await vi.waitFor(() => { expect(module.view.value.enabled).toBe(true) })

    await module.setEnabled(false)

    expect(vi.mocked(quotaApi.configure).mock.calls[0]![0]).toEqual({ providerId: 'kimi-p', enabled: false })
    expect(module.view.value.enabled).toBe(true) // 回滚
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaConfigureFail')
    expect(quotaApi.refreshQuota).not.toHaveBeenCalled()
  })

  it('transport 抛错 → 回滚开关并落 i18n 文案', async () => {
    vi.mocked(quotaApi.configure).mockRejectedValue(new Error('transport unavailable'))
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.setEnabled(true)

    expect(module.view.value.enabled).toBe(false)
    // 抛错路径沿用 message（诊断信息优先），非 i18n 默认串
    expect(module.view.value.configureError).toBe('transport unavailable')
  })
})

// ── ⑤ 去掩码（D7） ──────────────────────────────────────────────────────────
describe('去掩码（D7）', () => {
  it('syncFromProvider 后 cookie / 专属 Key 输入框为空（不回填掩码或密文）', async () => {
    const { module } = mountModule(
      provider({
        id: 'oc-p',
        apiKeySet: true,
        quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true, apiKeySet: true },
      }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    expect(module.draft.value.cookie).toBe('')
    expect(module.draft.value.apiKey).toBe('')
  })

  it('provider 快照更新（广播）重跑 syncFromProvider → 草稿被重置为磁盘态（已保存标记独立可见）', async () => {
    const { module, provider: providerRef } = mountModule(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go' } }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    module.draft.value.cookie = 'draft-cookie'
    providerRef.value = provider({
      id: 'oc-p',
      quota: {
        enabled: false,
        fetcher: 'opencode-go',
        cookieSet: true,
        workspace: 'https://opencode.ai/workspace/wrk_saved/go',
      },
    })

    await vi.waitFor(() => { expect(module.draft.value.workspace).toBe('https://opencode.ai/workspace/wrk_saved/go') })
    expect(module.draft.value.cookie).toBe('')
  })
})

// ── ⑥ 类型草稿写入（D5 细节 2） ─────────────────────────────────────────────
describe('类型草稿写入（D5 细节 2）', () => {
  it('同值选中不重置凭证草稿、不发 RPC（reka Select 同值也 emit）', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    module.draft.value.cookie = 'unsubmitted'
    module.selectType('mimo')

    expect(module.draft.value.cookie).toBe('unsubmitted')
    expect(quotaApi.configure).not.toHaveBeenCalled()
  })

  it('类型真变 → 清凭证草稿，但 Workspace 草稿保留（D13）', async () => {
    const { module } = mountModule(
      provider({
        id: 'oc-p',
        quota: {
          enabled: false,
          fetcher: 'opencode-go',
          cookieSet: true,
          workspace: 'https://opencode.ai/workspace/wrk_saved/go',
        },
      }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    module.draft.value.cookie = 'unsubmitted'
    module.selectType('mimo')

    expect(module.draft.value.cookie).toBe('')
    expect(module.draft.value.workspace).toBe('https://opencode.ai/workspace/wrk_saved/go')
    expect(quotaApi.configure).not.toHaveBeenCalled()
  })

  it('非字符串 payload 被守卫拦下（reka Select 宽联合类型；不许 String() 强转出 "undefined"）', async () => {
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: false, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )
    await Promise.resolve()

    module.draft.value.cookie = 'unsubmitted'
    module.selectType(undefined)
    module.selectType({ weird: true })

    expect(module.view.value.type.selected).toBe('mimo')
    expect(module.draft.value.cookie).toBe('unsubmitted')
  })
})

// ── ⑦ loadCached reason（D6 影响面表修正） ──────────────────────────────────
describe('loadCached reason 透传', () => {
  it('data=null 但带 reason → 整体呈失败态（不再丢成 idle）', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: null, lastFetchAt: 5000, reason: 'no-credential' })
    const { module } = mountModule(
      provider({ id: 'mimo-p', quota: { enabled: true, fetcher: 'mimo', cookieSet: true } }),
      { preset: MIMO_PRESET },
    )

    await vi.waitFor(() => { expect(module.test.value.status).toBe('error') })
    expect(module.test.value.failure).toEqual({ kind: 'no-credential', cookieAuth: true, message: '' })
    expect(module.test.value.row).toBeNull()
    expect(module.test.value.lastFetchAt).toBe(5000)
  })

  it('缓存携带 reason + 旧数据 → 失败态且旧数据保留（「查看上次成功数据」数据源）', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000, reason: 'unauthorized' })
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )

    await vi.waitFor(() => { expect(module.test.value.status).toBe('error') })
    expect(module.test.value.failure?.kind).toBe('unauthorized')
    expect(module.test.value.row).toEqual(mockRow)
  })

  it('缓存无 reason → success 态；provider 无 quota 配置 → idle 且不调 getCached', async () => {
    vi.mocked(quotaApi.getCached).mockResolvedValue({ data: mockRow, lastFetchAt: 1000 })
    const kimi = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: true, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await vi.waitFor(() => { expect(kimi.module.test.value.status).toBe('success') })
    expect(kimi.module.test.value.failure).toBeNull()

    vi.mocked(quotaApi.getCached).mockClear()
    const noQuota = mountModule(
      provider({ id: 'kimi-p', quota: undefined }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()
    expect(noQuota.module.test.value.status).toBe('idle')
    expect(quotaApi.getCached).not.toHaveBeenCalled()
  })
})

// ── ⑧ configureError 走 i18n（D9） ─────────────────────────────────────────
describe('configureError i18n（D9）', () => {
  it('saveAndTest 返回 ok:false 且带 error → 优先透传 error（跳过 i18n 兜底）', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: 'disk full' })
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()
    expect(module.view.value.configureError).toBe('disk full')
  })

  it('saveAndTest 非 Error 抛错 → 兜底走 quotaSaveAndTestFail', async () => {
    vi.mocked(quotaApi.configure).mockRejectedValue('boom')
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaSaveAndTestFail')
  })

  it('workspace 非法输入 → i18n 文案且不发 RPC', async () => {
    const { module } = mountModule(
      provider({ id: 'oc-p', quota: { enabled: false, fetcher: 'opencode-go', cookieSet: true } }),
      { preset: OPENCODE_PRESET },
    )
    await Promise.resolve()

    module.draft.value.workspace = 'https://evil.example.com/workspace/wrk_x/go'
    await module.saveAndTest()

    expect(quotaApi.configure).not.toHaveBeenCalled()
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaWorkspaceInvalid')
  })

  it('失败文案经注入 t 渲染（i18n 出口来自入参注入，与 provider-edit deps.t 同范式）', async () => {
    vi.mocked(quotaApi.configure).mockResolvedValue({ ok: false, error: '' })
    const { module, t } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()

    expect(t).toHaveBeenCalledWith('settings.providerEdit.quotaSaveAndTestFail')
    expect(module.view.value.configureError).toBe('T:settings.providerEdit.quotaSaveAndTestFail')
  })
})

// ── ⑨ 既有回归：reason 透传 / preset 派生 ───────────────────────────────────
describe('既有回归（reason 透传 / preset 派生）', () => {
  it('saveAndTest 内查询失败 → failure 分档 + lastFetchAt = 最近成功时间', async () => {
    vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: 5000, reason: 'network' })
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()

    expect(module.test.value.status).toBe('error')
    expect(module.test.value.failure).toEqual({ kind: 'network', cookieAuth: false, message: 'T:settings.providerEdit.quotaTestFail' })
    expect(module.test.value.lastFetchAt).toBe(5000)
  })

  it('查询抛错 → error 态 + failure generic + 错误消息透传', async () => {
    vi.mocked(quotaApi.refreshQuota).mockRejectedValue(new Error('transport unavailable'))
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    await module.saveAndTest()

    expect(module.test.value.status).toBe('error')
    expect(module.test.value.failure).toEqual({ kind: 'generic', cookieAuth: false, message: 'transport unavailable' })
  })

  it('凭证形态 / workspace 需求随草稿类型派生（view.credential.form / view.workspace.required）', async () => {
    const { module } = mountModule(
      provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
      { preset: KIMI_PRESET },
    )
    await Promise.resolve()

    expect(module.view.value.type.selected).toBe('kimi-coding')
    expect(module.view.value.credential.form).toBe('apiKey')
    expect(module.view.value.credential.exclusiveApplicable).toBe(true)
    expect(module.view.value.workspace.required).toBe(false)

    module.selectType('opencode-go')
    expect(module.view.value.credential.form).toBe('cookie')
    expect(module.view.value.workspace.required).toBe(true)
  })
})

// ── ⑩ 收拢进 implementation 的派生面（C1） ──────────────────────────────────
describe('派生面收拢（C1：失败归一 / 警示分档 / 来源提示 / 类型分层）', () => {
  it('失败原因归一：reason → 分档；无 reason / 未分类 reason → generic 带兜底消息', async () => {
    const reasonKind: Array<[QuotaFetchFailureReason, QuotaFailureKind]> = [
      ['unauthorized', 'unauthorized'],
      ['parse', 'parse'],
      ['not_configured', 'not-configured'],
      ['credential-unavailable', 'generic'],
    ]
    for (const [reason, kind] of reasonKind) {
      vi.mocked(quotaApi.refreshQuota).mockResolvedValue({ data: null, lastFetchAt: null, reason })
      const { module } = mountModule(
        provider({ id: 'kimi-p', quota: { enabled: false, fetcher: 'kimi-coding' } }),
        { preset: KIMI_PRESET },
      )
      await Promise.resolve()
      await module.saveAndTest()
      expect(module.test.value.failure?.kind, reason).toBe(kind)
    }
  })

  it('providerWarning 分档：表单草稿「已填未保存」→ pendingSave；空 → missing；有凭据 → null', async () => {
    // §7.4 判定输入是 provider 表单草稿（carry-in 槽位 providerApiKeyDraft）
    const pending = mountModule(
      provider({ id: 'zhipu-p', apiKeySet: false, quota: { enabled: false, fetcher: 'zhipu' } }),
      { preset: ZHIPU_PRESET, providerApiKeyDraft: 'sk-draft-key' },
    )
    await Promise.resolve()
    expect(pending.module.view.value.credential.providerWarning).toBe('pendingSave')

    const missing = mountModule(
      provider({ id: 'zhipu-p', apiKeySet: false, quota: { enabled: false, fetcher: 'zhipu' } }),
      { preset: ZHIPU_PRESET, providerApiKeyDraft: '' },
    )
    await Promise.resolve()
    expect(missing.module.view.value.credential.providerWarning).toBe('missing')

    const satisfied = mountModule(
      provider({ id: 'zhipu-p', apiKeySet: true, quota: { enabled: false, fetcher: 'zhipu' } }),
      { preset: ZHIPU_PRESET, providerApiKeyDraft: 'sk-draft-key' },
    )
    await Promise.resolve()
    expect(satisfied.module.view.value.credential.providerWarning).toBeNull()
  })

  it('清除哨兵 __CLEAR__ 非空但语义是无凭据 → pendingSave 判定排除（否则文案与事实相反）', async () => {
    const { module } = mountModule(
      provider({ id: 'zhipu-p', apiKeySet: false, quota: { enabled: false, fetcher: 'zhipu' } }),
      { preset: ZHIPU_PRESET, providerApiKeyDraft: '__CLEAR__' },
    )
    await Promise.resolve()

    expect(module.view.value.credential.providerWarning).toBe('missing')
  })

  it('来源提示分档：exclusive / Provider-OAuth 已登录 / Provider-API Key 三分支', async () => {
    const base = provider({ id: 'kimi-p', apiKeySet: true, quota: { enabled: false, fetcher: 'kimi-coding' } })

    const exclusive = mountModule(base, { preset: KIMI_PRESET })
    await Promise.resolve()
    exclusive.module.draft.value.credentialSource = 'exclusive'
    expect(exclusive.module.view.value.credential.sourceHint).toBe('exclusive')

    const oauth = mountModule(base, { preset: KIMI_PRESET, oauthPresent: true })
    await Promise.resolve()
    expect(oauth.module.view.value.credential.sourceHint).toBe('providerOauth')

    const apiKey = mountModule(base, { preset: KIMI_PRESET, oauthPresent: false })
    await Promise.resolve()
    expect(apiKey.module.view.value.credential.sourceHint).toBe('providerApiKey')
  })

  it('type.undetermined：草稿空 ∨ preset 未命中；help 随选中 fetcher 派生（无帮助 → null）', async () => {
    const { module } = mountModule(
      provider({ id: 'legacy-p', quota: { enabled: false, fetcher: 'legacy-unknown' } }),
      { preset: undefined },
    )
    await Promise.resolve()
    expect(module.view.value.type.undetermined).toBe(true)
    expect(module.view.value.help).toBeNull()

    module.selectType('opencode-go')
    expect(module.view.value.type.undetermined).toBe(false)
    expect(module.view.value.help?.url).toBe('https://opencode.ai/')
    expect(module.view.value.workspace.required).toBe(true)
  })
})
