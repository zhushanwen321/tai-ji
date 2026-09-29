/**
 * ProviderEditBody 契约 v2 接线测试（真实 useQuotaConfigure 驱动 DOM 与 RPC payload）。
 *
 * B-1 凭证区条件化 / B-2 模型区混合列表的组件契约由 @taiji/ui 包归属测试守护
 * （packages/ui/src/features/settings/__tests__/provider-edit-body.test.ts），本文件不再重复。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach/vi，禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/__tests__/settings/provider-edit-body-phase-b.test.ts
 *
 * mock 策略：
 *  - vue-i18n 全局 mock（vitest-i18n-setup.ts，t() 从 zh-CN 取值）
 *  - provideSettingsTransport 注入 spy transport（save 路径断言）
 *  - QUOTA_CONFIGURE_FACTORY_KEY provide 真实 useQuotaConfigure（'@taiji/core/transport/api/domains/quota' mock）
 *  - Dialog（形态切换确认）teleport 到 body：attachTo + document.body 查询（对齐 provider-builtin-ui 模式）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@taiji/shared'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  type SettingsTransport,
  type Translate,
  type QuotaConfigureFactoryInputs,
  provideSettingsStore,
  createSettingsStore,
} from '@taiji/core'
import {
  ProviderEditBody,
  SETTINGS_TOAST_KEY,
  QUOTA_CONFIGURE_FACTORY_KEY,
} from '@taiji/ui/features/settings'
import { useQuotaConfigure } from '@/composables/features/settings/useQuotaConfigure'
import { useToast } from '@/composables/useToast'
import i18n from '@/i18n'
import * as quotaApi from '@taiji/core/transport/api/domains/quota'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'

// [C3] useQuotaConfigure 经 SettingsTransport seam 消费 quota RPC——本域模块 mock 作为 seam 桩
// 函数源（getCachedQuota / configureQuota / refreshQuota 逐名映射，见 makeTransport）。
vi.mock('@taiji/core/transport/api/domains/quota', () => ({
  getCached: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  fetchQuota: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  refreshQuota: vi.fn(async () => ({ data: null, lastFetchAt: null })),
  configure: vi.fn(async () => ({ ok: true })),
}))

// ── 契约 v2 接线 fixture（U5-t2：真实 useQuotaConfigure 驱动 DOM）──

/** cookie 类 + 未保存 cookie：matchQuotaPreset 命中 mimo → readiness 缺 cookie（按钮应置灰） */
const MIMO_NO_COOKIE_P: ProviderInfo = {
  id: 'xiaomi-mimo',
  name: 'Xiaomi MiMo',
  api: 'openai-completions',
  apiKeySet: true,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'custom',
  baseUrl: 'https://platform.xiaomimimo.com',
  models: [{ id: 'mimo-v2', name: 'MiMo V2' }],
  quota: { fetcher: 'mimo', enabled: true },
}

/** api-key 类且 provider 侧有凭据：matchQuotaPreset 命中 zhipu → readiness 齐备（按钮可点） */
const ZHIPU_READY_P: ProviderInfo = {
  id: 'zhipu',
  name: 'Zhipu GLM',
  api: 'openai-completions',
  apiKeySet: true,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'catalog',
  baseUrl: 'https://open.bigmodel.cn/api',
  models: [{ id: 'glm-4', name: 'GLM-4.6', source: 'builtin' }],
  quota: { fetcher: 'zhipu', enabled: true },
}

/** api-key 类但 provider 侧无凭据：matchQuotaPreset 命中 zhipu → 凭证警示区可见（§7.4 两套文案） */
const ZHIPU_NO_KEY_P: ProviderInfo = {
  id: 'zhipu-nokey',
  name: 'Zhipu GLM',
  api: 'openai-completions',
  apiKeySet: false,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'catalog',
  baseUrl: 'https://open.bigmodel.cn/api',
  models: [{ id: 'glm-4', name: 'GLM-4.6', source: 'builtin' }],
  quota: { fetcher: 'zhipu', enabled: true },
}

// ── transport stub（save 路径 spy）──

const setProviderSpy = vi.fn(async () => undefined)

/** [C3] 共享 seam 桩工厂（全方法面中性默认）+ 本文件 spy/映射（保存 spy + quota RPC）。 */
function makeTransport(): SettingsTransport {
  return makeSettingsTransportStub({
    setProvider: setProviderSpy,
    getCachedQuota: quotaApi.getCached,
    refreshQuota: quotaApi.refreshQuota,
    configureQuota: quotaApi.configure,
  })
}

function inMemoryStorage() {
  const map = new Map<string, string>()
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v) },
    remove: async (k: string) => { map.delete(k) },
  }
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  __resetPlatformForTesting()
  provideSettingsStore(createSettingsStore())
  providePlatform({
    kind: 'mock',
    storage: inMemoryStorage(),
    webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
    ipc: null,
  })
  provideSettingsTransport(makeTransport())
  setProviderSpy.mockClear()
  vi.mocked(quotaApi.configure).mockClear()
  vi.mocked(quotaApi.refreshQuota).mockClear()
  vi.mocked(quotaApi.getCached).mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** mount ProviderEditBody（注入 quota 工厂 + toast；attachTo 供 Dialog teleport 查询） */
function mountBody(provider: ProviderInfo, props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ProviderEditBody, {
    props: { provider, oauthPresent: false, oauthSupported: true, ...props },
    attachTo: document.body,
    global: {
      provide: {
        [SETTINGS_TOAST_KEY]: useToast(),
        // 壳层同款包装：业务输入归 ProviderEditBody 物化点，t 由包装函数注入
        [QUOTA_CONFIGURE_FACTORY_KEY]: (inputs: QuotaConfigureFactoryInputs) =>
          useQuotaConfigure({ ...inputs, t: i18n.global.t as Translate }),
      },
    },
  })
}

// ══ 契约 v2 真实接线（U5-t2：注入真实 useQuotaConfigure，断言 DOM 与 RPC payload）══════════

/**
 * 覆盖设计条款（coding-plan-quota-config-ux §7.2 / D1 / D2 / D3 / D4）：
 * - D1：readiness 置灰随草稿实时变化（「填参数时立刻知道还差什么」）
 * - D4：拨开关只构造 { providerId, enabled }，零网络副作用（不偷偷落盘草稿、不发查询）
 * - D2：单按钮「保存并测试」= 先落盘（configure）再查询（refresh），顺序可证
 * - D3：凭证来源切换进 payload（credentialSource 恒传），专属 Key 草稿进 apiKey
 *
 * 三视角：用户可见 DOM（按钮 disabled / 字段级提示文案）+ RPC spy 白盒佐证。
 * 渲染器 i18n 未 mock（vitest-i18n-setup 真实 zh-CN）→ 文案断言中文，同时验证 21 个新 key 真实存在。
 */
describe('契约 v2 接线：readiness / setEnabled / saveAndTest（真实 composable）', () => {
  const SAVE_TEST = '[data-testid="quota-save-test-btn"]'

  /** 当前按钮的 disabled 态（用户可见形态） */
  function saveDisabled(): boolean {
    return wrapper!.find<HTMLButtonElement>(SAVE_TEST).element.disabled
  }

  it('D1：cookie 类未保存 cookie → 按钮置灰且提示「这里必须填」；输入草稿后按钮变亮、提示消失', async () => {
    wrapper = mountBody(MIMO_NO_COOKIE_P)
    await flushPromises()

    // 首屏：类型已选（mimo 命中 preset）→ 参数区渲染，但缺 cookie → 按钮不可点
    expect(wrapper.find(SAVE_TEST).exists()).toBe(true)
    expect(saveDisabled()).toBe(true)
    const hint = wrapper.find('[data-testid="quota-missing-cookie"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('这里必须填')

    // 用户粘贴 cookie（草稿）→ readiness 重算 → 置灰解除、字段提示消失（不需要先点按钮才报错）
    await wrapper.find('[data-testid="quota-cookie-input"]').setValue('raw-cookie-draft')
    await flushPromises()
    expect(saveDisabled()).toBe(false)
    expect(wrapper.find('[data-testid="quota-missing-cookie"]').exists()).toBe(false)
  })

  it('D4：拨开关 → configure 只收 { providerId, enabled }（草稿键一律缺省），且不发任何查询', async () => {
    const configureSpy = vi.mocked(quotaApi.configure)
    const refreshSpy = vi.mocked(quotaApi.refreshQuota)
    wrapper = mountBody(ZHIPU_READY_P)
    await flushPromises()

    // 开局（quota.enabled=true）只读缓存，不发 refresh
    expect(refreshSpy).not.toHaveBeenCalled()

    const sw = wrapper.find('[data-testid="quota-enabled-switch"]')
    expect(sw.exists()).toBe(true)
    await sw.trigger('click')
    await flushPromises()

    expect(configureSpy).toHaveBeenCalledTimes(1)
    const payload = configureSpy.mock.calls[0]![0] as Record<string, unknown>
    // 单键落盘：多出 fetcher / credentialSource / 凭证键即「拨开关偷偷落盘草稿」
    expect(Object.keys(payload).sort()).toEqual(['enabled', 'providerId'])
    expect(payload.providerId).toBe('zhipu')
    expect(payload.enabled).toBe(false)
    // D4 边界：开关零网络副作用
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('D2：点「保存并测试」→ 完整草稿 payload 落盘，成功后再 refresh（先落盘再查询，顺序可证）', async () => {
    const configureSpy = vi.mocked(quotaApi.configure)
    const refreshSpy = vi.mocked(quotaApi.refreshQuota)
    wrapper = mountBody(ZHIPU_READY_P)
    await flushPromises()

    expect(saveDisabled()).toBe(false)
    await wrapper.find(SAVE_TEST).trigger('click')
    await flushPromises()

    expect(configureSpy).toHaveBeenCalledTimes(1)
    const payload = configureSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.providerId).toBe('zhipu')
    expect(payload.enabled).toBe(true)
    expect(payload.fetcher).toBe('zhipu')
    // D3：来源恒传（幂等显式化磁盘字段）
    expect(payload.credentialSource).toBe('provider')
    // 未填的敏感字段不传值（cookie/apiKey undefined = 保留既存；workspace 非资源维度不传）
    expect(payload.workspace).toBeUndefined()
    expect(payload.apiKey).toBeUndefined()

    // 硬约束：runtime 从落盘读凭据 → configure 必须先于 refresh
    expect(refreshSpy).toHaveBeenCalledWith('zhipu')
    expect(configureSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      refreshSpy.mock.invocationCallOrder[0]!,
    )
  })

  it('D3：切「用专属 Key」并填 Key → payload.credentialSource=exclusive + apiKey=草稿（UI 说的就是 runtime 用的）', async () => {
    const configureSpy = vi.mocked(quotaApi.configure)
    wrapper = mountBody(ZHIPU_READY_P)
    await flushPromises()

    // 切来源 → 专属 Key 块出现，未填 Key 时按钮置灰（readiness 同步）
    await wrapper.find('[data-testid="quota-source-exclusive-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="quota-exclusive-key-block"]').exists()).toBe(true)
    expect(saveDisabled()).toBe(true)

    await wrapper.find('[data-testid="quota-apikey-input"]').setValue('sk-exclusive-draft')
    await flushPromises()
    expect(saveDisabled()).toBe(false)

    await wrapper.find(SAVE_TEST).trigger('click')
    await flushPromises()

    const payload = configureSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(payload.credentialSource).toBe('exclusive')
    expect(payload.apiKey).toBe('sk-exclusive-draft')
  })

  it('§7.4 跨区块时序：provider 表单填 API Key（未保存）→ 警示从「还没有」切「已填写，保存后即可查询」', async () => {
    wrapper = mountBody(ZHIPU_NO_KEY_P)
    await flushPromises()

    // 首屏：来源=provider 且 provider 侧无凭据 → 「还没有可用的 API Key」警示 + 按钮置灰
    const warn = () => wrapper!.find('[data-testid="quota-provider-credential-warning"]')
    expect(warn().exists()).toBe(true)
    expect(warn().text()).toContain('还没有可用的 API Key')
    expect(saveDisabled()).toBe(true)

    // 表单里填 Key（尚未保存 provider）→ carry-in 槽位（providerApiKeyDraft）驱动文案切换：
    // 用户可见差异 =「按钮灰但屏幕上明明填了 Key」的矛盾消除（指引先保存 provider）
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('sk-draft-key')
    await flushPromises()
    expect(warn().text()).toContain('已填写 API Key，保存 provider 配置后即可查询')
    expect(warn().text()).not.toContain('还没有可用的 API Key')
    expect(saveDisabled()).toBe(true) // runtime 仍读不到（provider 未保存），齐备性不变

    // 草稿清空（删除已输入内容）→ 文案退回「还没有」
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('')
    await flushPromises()
    expect(warn().text()).toContain('还没有可用的 API Key')
  })
})
