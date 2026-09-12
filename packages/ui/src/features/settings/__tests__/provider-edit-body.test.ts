/**
 * ProviderEditBody 组件级单测（ui 包 · PR #187 Gate-1.6 增量覆盖）。
 *
 * 覆盖验收标准（B-1 凭证区条件化 + B-2 模型区混合列表 + save payload）：
 * ① oauth 型 catalog provider：已登录状态区（relogin / logout 按钮、logout 点击上抛），
 *    隐藏 API key 输入；未登录态渲染登录入口
 * ② api_key 型：渲染 API key 输入，不渲染 OAuth 状态区
 * ③ 形态切换确认弹窗：oauth→api_key 与 api_key→oauth 双向（确认执行切换、取消不动凭证）；
 *    oauth→api_key 空 key 保存被守卫阻断
 * ④ 混合模型列表（catalog）：builtin 条目只读 + Built-in 徽章；override 条目可编辑/可删 +
 *    Custom 徽章；手动添加入口开放
 * ⑤ save payload：models 只含 override 条目（builtin id 不回传）+ authMethod 字段
 * ⑥ 添加模型表单 reasoning 思考开关（D4「GLM 思考等级被钳 off」事故修复面）：
 *    aria-label 可定位 + aria-checked 随点击翻转 + 翻转结果透传进 save payload
 *
 * 与 renderer 端 provider-edit-body-phase-b.test.ts 的差异（mock 层全部换 injection stub）：
 *  - USE_QUOTA_CONFIGURE_KEY provide 最小 stub 工厂（对齐 injection-keys.ts 的
 *    QuotaConfigureState 契约逐字段），零 renderer import（ui 包铁律）
 *  - SETTINGS_TOAST_KEY provide vi.fn stub（save 成功 toast 断言）
 *  - provideSettingsTransport / providePlatform（@xyz-agent/core 模块级单例注入，
 *    useProviderEdit 的 setProvider/discoverModels 经 transport spy 断言）
 *  - vue-i18n 经 vitest.setup mock（t() 返回 key）→ 全部文案断言用 i18n key / data-testid
 *
 * 测试模式：Dialog teleport 到 body，mount attachTo: document.body 后用
 * document.body.querySelector 查询（对齐 OAuthDialog.test.ts 模式）。
 * ModelListSection 不 stub（真实渲染）：B-2 徽章行 + 混合列表联动由本测试连带覆盖。
 *
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/provider-edit-body.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'
import type {
  ProviderInfo,
  ProviderId,
  SetProviderData,
  QuotaPreset,
  QuotaAuthKind,
  QuotaCredentialSource,
  QuotaFetchFailureReason,
  NormalizedQuotaRow,
} from '@xyz-agent/shared'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  __resetSettingsStoreForTesting,
  __resetSettingsTransportForTesting,
  type SettingsTransport,
  type DiscoverModelsResponse,
} from '@xyz-agent/core'
import ProviderEditBody from '../provider/ProviderEditBody.vue'
import {
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
  type SettingsToast,
  type QuotaConfigureState,
  type QuotaTestStatus,
  type ReadinessMissing,
} from '../injection-keys'

// ── fixture ──

/** oauth 型 catalog provider（凭证区显示 OAuth 状态；混合列表 builtin×2 + override×1） */
const OAUTH_P: ProviderInfo = {
  id: 'kimi-coding' as ProviderId,
  name: 'Kimi Coding',
  api: 'openai-completions',
  apiKeySet: true,
  authMethod: 'oauth',
  status: 'connected',
  kind: 'catalog',
  models: [
    { id: 'kimi-k2', name: 'Kimi K2', source: 'builtin' },
    { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', source: 'builtin' },
    { id: 'my-kimi-alias', name: 'My Kimi Alias', source: 'override' },
  ],
}

/** api_key 型 catalog provider（凭证区维持 API Key 输入；builtin×1 + override×1） */
const APIKEY_P: ProviderInfo = {
  id: 'zai-coding-cn' as ProviderId,
  name: 'Z.AI Coding CN',
  api: 'openai-completions',
  apiKeySet: true,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'catalog',
  models: [
    { id: 'glm-5.3', name: 'GLM 5.3', source: 'builtin' },
    { id: 'my-glm-alias', name: 'My GLM Alias', source: 'override' },
  ],
}

/** custom provider（非 catalog：模型区走单一可编辑列表，无 builtin 只读区） */
const CUSTOM_P: ProviderInfo = {
  id: 'my-openai' as ProviderId,
  name: 'My OpenAI',
  api: 'openai-completions',
  apiKeySet: false,
  status: 'connected',
  kind: 'custom',
  models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
}

// ── M4 fixture：catalog 派生展示四态（设计 D5；runtime 已按合并模型集派生下发）──

/** 混合协议 + 混合端点（opencode-go 形态）：runtime 派生 api/baseUrl 均 undefined */
const CATALOG_MIXED_P: ProviderInfo = {
  id: 'opencode-go' as ProviderId,
  name: 'OpenCode Go',
  apiKeySet: true,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'catalog',
  models: [
    { id: 'minimax-m3', name: 'MiniMax M3', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/zen/go', source: 'builtin' },
    { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', source: 'builtin' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', api: 'openai-responses', baseUrl: 'https://opencode.ai/zen/go/v1', source: 'builtin' },
  ],
}

/** 单协议 + 单端点（deepseek 形态）：派生 api/baseUrl 均为该单值 */
const CATALOG_UNIFORM_P: ProviderInfo = {
  id: 'deepseek' as ProviderId,
  name: 'DeepSeek',
  api: 'openai-completions',
  baseUrl: 'https://api.deepseek.com',
  apiKeySet: true,
  authMethod: 'api_key',
  status: 'connected',
  kind: 'catalog',
  models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', source: 'builtin' },
  ],
}

/** 端点全空（azure-openai-responses 形态）：baseUrl 派生 undefined、api 单值 */
const CATALOG_NO_ENDPOINT_P: ProviderInfo = {
  id: 'azure-openai-responses' as ProviderId,
  name: 'Azure OpenAI (Responses)',
  api: 'azure-openai-responses',
  apiKeySet: false,
  status: 'not_configured',
  kind: 'catalog',
  models: [
    { id: 'gpt-5', name: 'GPT-5', api: 'azure-openai-responses', source: 'builtin' },
  ],
}

/** 用户网关态：provider 级 baseUrl = 网关（override 非空 baseUrl，覆盖全部模型端点） */
const CATALOG_GATEWAY_URL = 'https://gw.corp.example/opencode'
const CATALOG_GATEWAY_P: ProviderInfo = {
  ...CATALOG_MIXED_P,
  baseUrl: CATALOG_GATEWAY_URL,
}

// ── injection stub（零 renderer import：契约对齐 injection-keys.ts）──

/** QuotaConfigureState 最小 stub：字段逐一对齐契约 v2（ProviderEditBody 解构后全量透传给 CodingPlanSection） */
function makeQuotaState(): QuotaConfigureState {
  return {
    fetcherId: ref<string | undefined>(undefined),
    fetcherOptions: [],
    enabled: ref(false),
    cookieInput: ref(''),
    apiKeyInput: ref(''),
    credentialSource: ref<QuotaCredentialSource>('provider'),
    providerCredentialAvailable: ref(false),
    quotaApiKeyConfigured: ref(false),
    providerCredentialPendingSave: ref(false),
    workspaceInput: ref(''),
    workspaceConfigured: ref(false),
    needsWorkspace: ref(false),
    readiness: ref<{ ready: boolean; missing: ReadinessMissing[] }>({ ready: false, missing: [] }),
    testStatus: ref<QuotaTestStatus>('idle'),
    testError: ref(''),
    quotaData: ref<NormalizedQuotaRow | null>(null),
    lastFetchAt: ref<number | null>(null),
    isCookieAuth: ref(false),
    authKinds: ref<readonly QuotaAuthKind[]>([]),
    testFailReason: ref<QuotaFetchFailureReason | null>(null),
    helpUrl: ref<string | undefined>(undefined),
    helpText: ref<string | undefined>(undefined),
    configuring: ref(false),
    configureError: ref(''),
    setEnabled: async () => {},
    saveAndTest: async () => {},
    reset: () => {},
  }
}

/** USE_QUOTA_CONFIGURE_KEY stub 工厂（vi.fn 包装供「注入被真实消费」断言） */
const quotaFactoryStub = vi.fn((_preset: Ref<QuotaPreset | undefined>, _providerRef: Ref<ProviderInfo | null>) => makeQuotaState())

const toastInfoSpy = vi.fn()
const toastStub: SettingsToast = {
  error: vi.fn(),
  info: toastInfoSpy,
  warning: vi.fn(),
}

// ── transport / platform stub（core 模块级单例注入）──

const setProviderSpy = vi.fn(async (_id: string, _data: SetProviderData) => undefined)
/** 显式标注返回类型：M4 场景 ⑨ 需按用例注入 results / error（类型推断会把返回值收窄成 models: never[]） */
const discoverModelsSpy = vi.fn(async (): Promise<DiscoverModelsResponse> => ({ success: true, models: [] }))

function makeTransport(): SettingsTransport {
  const noop = (): void => {}
  return {
    listProviders: vi.fn(async () => ({ providers: [] })),
    listModels: vi.fn(async () => []),
    setScopedModels: vi.fn(async () => [] as string[]),
    setProvider: setProviderSpy,
    discoverModels: discoverModelsSpy,
    setSkillDirs: vi.fn(async () => undefined),
    setAgentDirs: vi.fn(async () => undefined),
    setExtensionDirs: vi.fn(async () => undefined),
    onProviders: () => noop,
    onModels: () => noop,
    onSkills: () => noop,
    onAgents: () => noop,
    onExtensions: () => noop,
    onSkillDirs: () => noop,
    onAgentDirs: () => noop,
    onExtensionDirs: () => noop,
    onDefaults: () => noop,
    onSystemPrompt: () => noop,
    onTerminalConfig: () => noop,
  }
}

function inMemoryStorage() {
  const map = new Map<string, string>()
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => { map.set(k, v) },
    remove: async (k: string) => { map.delete(k) },
  }
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  __resetPlatformForTesting()
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
  providePlatform({
    kind: 'mock',
    storage: inMemoryStorage(),
    webSocket: { create: () => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }) },
  })
  provideSettingsTransport(makeTransport())
  setProviderSpy.mockClear()
  discoverModelsSpy.mockClear()
  quotaFactoryStub.mockClear()
  toastInfoSpy.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** mount ProviderEditBody（provide injection stub；attachTo 供 Dialog teleport 查询） */
function mountBody(provider: ProviderInfo, props: Record<string, unknown> = {}): VueWrapper {
  return mount(ProviderEditBody, {
    props: { provider, oauthPresent: false, oauthSupported: true, ...props },
    attachTo: document.body,
    global: {
      provide: {
        [SETTINGS_TOAST_KEY]: toastStub,
        [USE_QUOTA_CONFIGURE_KEY]: quotaFactoryStub,
      },
    },
  })
}

/** body 内元素点击（portal Dialog 内容触发 Vue @click） */
function clickBody(selector: string): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  el.click()
}

/** save payload（setProvider 第 2 参；spy 参数已类型化，无需断言收窄） */
function savePayload(index = 0): SetProviderData {
  expect(setProviderSpy.mock.calls.length).toBeGreaterThan(index)
  return setProviderSpy.mock.calls[index]![1]
}

// ══ 场景 ①：oauth 型凭证区 ═════════════════════════════════════════════════

describe('凭证区条件化：oauth 型 provider', () => {
  it('已登录态：渲染 OAuth 状态区（已登录 + relogin / logout 按钮），隐藏 API key 输入；quota 工厂经注入消费', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-credential-oauth"]').exists()).toBe(true)
    const status = wrapper.find('[data-testid="oauth-status-loggedin"]')
    expect(status.exists()).toBe(true)
    // t() 返回 key（vitest.setup mock）→ 断言 i18n key 而非中文文案
    expect(status.text()).toContain('settings.providerEdit.credentialOauthLoggedIn')
    const relogin = wrapper.find('[data-testid="oauth-relogin-btn"]')
    expect(relogin.exists()).toBe(true)
    expect(relogin.text().trim()).toBe('settings.providerEdit.credentialOauthRelogin')
    expect(wrapper.find('[data-testid="oauth-logout-btn"]').exists()).toBe(true)
    // oauth 形态不渲染 apiKey 输入
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(false)
    // USE_QUOTA_CONFIGURE_KEY 注入被真实消费（非 noop fallback）
    expect(quotaFactoryStub).toHaveBeenCalledTimes(1)
  })

  it('logout 按钮可点击（B-1 场景 C：config.oauthLogout RPC 已落地）→ 上抛 oauth-logout', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    const logout = wrapper.find<HTMLButtonElement>('[data-testid="oauth-logout-btn"]')
    expect(logout.exists()).toBe(true)
    expect(logout.element.disabled).toBe(false)
    expect(logout.text().trim()).toBe('settings.providerEdit.credentialOauthLogout')

    await logout.trigger('click')
    expect(wrapper.emitted('oauthLogout')).toBeTruthy()
    expect(wrapper.emitted('oauthLogout')!.length).toBe(1)
  })

  it('未登录态（authMethod=oauth 但无凭据）：显示未登录状态 + 登录按钮（非 relogin）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: false })
    await flushPromises()

    const status = wrapper.find('[data-testid="oauth-status-not-loggedin"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain('settings.providerEdit.credentialOauthNotLoggedIn')
    const loginBtn = wrapper.find('[data-testid="oauth-relogin-btn"]')
    expect(loginBtn.exists()).toBe(true)
    expect(loginBtn.text().trim()).toBe('settings.providerEdit.credentialOauthLogin')
  })

  it('点 relogin 按钮 → 上抛 oauth-login（OAuth 状态机在父组件，ui 零 renderer import）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    await wrapper.find('[data-testid="oauth-relogin-btn"]').trigger('click')
    expect(wrapper.emitted('oauthLogin')).toBeTruthy()
    expect(wrapper.emitted('oauthLogin')!.length).toBe(1)
  })
})

// ══ 场景 ②：api_key 型凭证区 ═══════════════════════════════════════════════

describe('凭证区条件化：api_key 型 provider', () => {
  it('渲染 API key 输入 + 「改用 OAuth」入口，不渲染 OAuth 状态区', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-credential-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="auth-switch-to-oauth"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-credential-oauth"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="oauth-status-loggedin"]').exists()).toBe(false)
  })

  it('oauth 能力未知（oauthSupported=false）→ 不渲染「改用 OAuth」入口', async () => {
    wrapper = mountBody(APIKEY_P, { oauthSupported: false })
    await flushPromises()

    expect(wrapper.find('[data-testid="auth-switch-to-oauth"]').exists()).toBe(false)
  })
})

// ══ 场景 ③：形态切换确认弹窗（I9 双凭据互斥）═══════════════════════════════

describe('形态切换：双向确认弹窗', () => {
  it('oauth→api_key：点「改用 API Key」→ 确认弹窗出现；取消 → 弹窗关闭且凭证区不变（取消不动凭证）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    await wrapper.find('[data-testid="auth-switch-to-apikey"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')
    expect(dialog).toBeTruthy()
    // t() 返回 key → 弹窗标题/描述断言 i18n key
    expect(dialog!.textContent).toContain('settings.providerEdit.switchToApiKeyConfirmTitle')
    expect(dialog!.textContent).toContain('settings.providerEdit.switchToApiKeyConfirmDesc')

    clickBody('[data-testid="auth-switch-cancel-btn"]')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')).toBeNull()
    // 取消不动凭证：仍 oauth 态（已登录 + 无 apiKey 输入），未触发保存
    expect(wrapper.find('[data-testid="oauth-status-loggedin"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(false)
    expect(setProviderSpy).not.toHaveBeenCalled()
  })

  it('确认 oauth→api_key：apiKey 输入 + save-bar 出现；空 key 保存被守卫阻断；填 key 保存 → payload authMethod=api_key + apiKey 覆写', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    await wrapper.find('[data-testid="auth-switch-to-apikey"]').trigger('click')
    await flushPromises()
    clickBody('[data-testid="auth-switch-confirm-btn"]')
    await flushPromises()

    // 切换后：apiKey 输入出现 + dirty（save-bar）
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)

    // 空 key 保存 → 守卫拦截（确认弹窗承诺退出 OAuth，空 key 会残留 OAuth 凭证）
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()
    expect(setProviderSpy).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="provider-save-bar"]').text()).toContain('composable.oauthSwitchNeedsKey')

    // 填 key 保存 → payload 正确 + toast 反馈 + 上抛 saved
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('sk-new-key')
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()
    expect(setProviderSpy).toHaveBeenCalledTimes(1)
    const payload = savePayload()
    expect(payload.authMethod).toBe('api_key')
    expect(payload.apiKey).toBe('sk-new-key')
    expect(toastInfoSpy).toHaveBeenCalledWith('settings.saved')
    expect(wrapper.emitted('saved')).toBeTruthy()
  })

  it('api_key→oauth：确认后上抛 oauth-login，本地凭证形态不变（flow 由父完成后持久化回推）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    await wrapper.find('[data-testid="auth-switch-to-oauth"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[data-testid="auth-switch-confirm-dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain('settings.providerEdit.switchToOauthConfirmTitle')
    expect(dialog!.textContent).toContain('settings.providerEdit.switchToOauthConfirmDesc')
    clickBody('[data-testid="auth-switch-confirm-btn"]')
    await flushPromises()

    expect(wrapper.emitted('oauthLogin')).toBeTruthy()
    // 本地凭证形态未变（仍 apiKey 输入），且未触发保存
    expect(wrapper.find('[data-testid="provider-edit-apikey"]').exists()).toBe(true)
    expect(setProviderSpy).not.toHaveBeenCalled()
  })
})

// ══ 场景 ④：混合模型列表（catalog）═════════════════════════════════════════

describe('混合模型列表：builtin 只读 + override 可编辑', () => {
  it('builtin 条目只读渲染（Built-in 徽章、无删除按钮）与 override 条目（Custom 徽章、可删）同时显示', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-models-mixed"]').exists()).toBe(true)
    // builtin 只读区：1 条（glm-5.3）+ 徽章 key 断言（t() 返回 key）
    const builtinSection = wrapper.find('[data-testid="provider-models-builtin"]')
    expect(builtinSection.exists()).toBe(true)
    const builtinRows = builtinSection.findAll('[data-testid="builtin-model-row"]')
    expect(builtinRows.length).toBe(1)
    expect(builtinRows[0].text()).toContain('glm-5.3')
    const builtinBadge = builtinSection.find('[data-testid="model-badge-builtin"]')
    expect(builtinBadge.exists()).toBe(true)
    expect(builtinBadge.text().trim()).toBe('settings.providerEdit.modelSourceBuiltin')

    // 编辑区（ModelListSection 真实渲染）：仅 override 条目 + Custom 徽章 + 可删
    const customBadges = wrapper.findAll('[data-testid="model-badge-custom"]')
    expect(customBadges.length).toBe(1)
    expect(customBadges[0].text().trim()).toBe('settings.providerEdit.modelSourceOverride')
    const removeButtons = wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]')
    expect(removeButtons.length).toBe(1)
    // 手动添加入口开放
    const addToggle = wrapper.findAll('button').find((b) => b.text().includes('settings.providerEdit.manualAdd'))
    expect(addToggle).toBeTruthy()
  })

  it('oauth 型 catalog：builtin×2 只读展示 + override×1 在编辑区（OAUTH_P fixture 冒烟）', async () => {
    wrapper = mountBody(OAUTH_P, { oauthPresent: true })
    await flushPromises()

    const builtinSection = wrapper.find('[data-testid="provider-models-builtin"]')
    expect(builtinSection.findAll('[data-testid="builtin-model-row"]').length).toBe(2)
    expect(builtinSection.findAll('[data-testid="model-badge-builtin"]').length).toBe(2)
    // 编辑区只含 override 条目（my-kimi-alias）
    expect(wrapper.findAll('[data-testid="model-badge-custom"]').length).toBe(1)
    expect(wrapper.text()).toContain('my-kimi-alias')
    // builtin id 不出现在编辑区删除按钮旁的行（编辑区 1 行 = my-kimi-alias）
    const removeButtons = wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]')
    expect(removeButtons.length).toBe(1)
  })

  it('custom provider（非 catalog）：单一可编辑模型列表，无 builtin 只读区', async () => {
    wrapper = mountBody(CUSTOM_P)
    await flushPromises()

    // v-else 分支：provider-models-editable + 全量条目可编辑（无 builtin 只读区/徽章）
    expect(wrapper.find('[data-testid="provider-models-editable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-models-mixed"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="provider-models-builtin"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="model-badge-builtin"]').exists()).toBe(false)
    const removeButtons = wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]')
    expect(removeButtons.length).toBe(1)
    expect(wrapper.text()).toContain('gpt-4o')
  })

  it('空名添加模型 → 守卫错误显示在 save-bar（addModel 抛错非静默）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // actionError 显示位在 save-bar 内（v-if="isDirty"），先改名称制造 dirty
    await wrapper.find('[data-testid="provider-edit-name"]').setValue('Renamed')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)

    // 打开手动添加表单 + 直接点添加（空名）
    const addToggle = wrapper.findAll('button').find((b) => b.text().includes('settings.providerEdit.manualAdd'))
    expect(addToggle).toBeTruthy()
    await addToggle!.trigger('click')
    await flushPromises()
    const addBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'settings.providerEdit.addBtn')
    expect(addBtn).toBeTruthy()
    await addBtn!.trigger('click')
    await flushPromises()

    // 错误显示在 save-bar（用户可见反馈，非静默吞）；编辑区行数不变（空名未入库）
    expect(wrapper.find('[data-testid="provider-save-bar"]').text()).toContain('composable.modelNameRequired')
    expect(wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]').length).toBe(1)
  })
})

// ══ 场景 ⑤：save payload（transport spy）═══════════════════════════════════

describe('save payload：models 只含 override + authMethod 字段', () => {
  it('添加自定义模型后保存 → models 含 override + 新条目、不含 builtin（builtin 不回传）；authMethod=api_key', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // 打开手动添加表单 + 填名（placeholder = i18n key，t() mock 返回 key）+ 添加
    const addToggle = wrapper.findAll('button').find((b) => b.text().includes('settings.providerEdit.manualAdd'))
    await addToggle!.trigger('click')
    await flushPromises()
    const nameInput = wrapper.find('input[placeholder="settings.providerEdit.modelNamePlaceholder"]')
    expect(nameInput.exists()).toBe(true)
    await nameInput.setValue('glm-5.4-preview')
    const addBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'settings.providerEdit.addBtn')
    await addBtn!.trigger('click')
    await flushPromises()

    // dirty → save-bar → 保存
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    const models = savePayload().models as Array<{ id: string }>
    const ids = models.map((m) => m.id)
    expect(ids).toContain('my-glm-alias') // 既有 override
    expect(ids).toContain('glm-5.4-preview') // 新增
    expect(ids).not.toContain('glm-5.3') // builtin 不回传
    expect(savePayload().authMethod).toBe('api_key')
    expect(toastInfoSpy).toHaveBeenCalledWith('settings.saved')
    expect(wrapper.emitted('saved')).toBeTruthy()
  })

  it('删除唯一 override 条目后保存 → payload models 为空数组（builtin 仍不回传）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    const removeButtons = wrapper.findAll('button[aria-label="settings.providerEdit.removeModel"]')
    expect(removeButtons.length).toBe(1)
    await removeButtons[0].trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    const models = savePayload().models as Array<{ id: string }>
    expect(models.map((m) => m.id)).toEqual([])
  })
})

// ══ 附加：dirty 上抛 + 测试连接（编排链路）══════════════════════════════════

describe('编排链路：dirty 上抛与测试连接', () => {
  it('dirty 状态上抛父组件：mount 即 emit(false)，编辑名称后 emit(true) + save-bar 出现', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    const emitted = wrapper.emitted('dirtyChange')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([false])

    await wrapper.find('[data-testid="provider-edit-name"]').setValue('Renamed Provider')
    await flushPromises()

    expect(wrapper.emitted('dirtyChange')!.at(-1)).toEqual([true])
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-save-bar"]').text()).toContain('settings.provider.unsavedBadge')

    // 取消按钮上抛 @cancel（父组件收起展开行）
    await wrapper.find('[data-testid="provider-cancel-btn"]').trigger('click')
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })

  it('测试连接：经 transport.discoverModels 探活，成功态渲染（用户可见反馈）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // 两个 secondary 按钮（测试连接 / 自动发现）取第一个
    const testBtn = wrapper.findAll('button').find((b) => b.text().includes('settings.providerEdit.testConnection'))
    expect(testBtn).toBeTruthy()
    await testBtn!.trigger('click')
    await flushPromises()

    expect(discoverModelsSpy).toHaveBeenCalledTimes(1)
    // 成功态用户可见（t(key, {count}) mock 会 append 命名参数值）
    expect(wrapper.text()).toContain('settings.providerEdit.testOk')
  })
})

// ══ 场景 ⑥：添加模型表单 reasoning 思考开关（D4 事故修复面）══════════════════

/**
 * ModelListSection 真实渲染（非 stub）中的 reasoning Switch（reka SwitchRoot →
 * button[role="switch"]）。三视角说明：
 * - 黑盒用户视角（主）：aria-label 可定位（AT accessible name）、aria-checked /
 *   data-state 随点击翻转（用户可见形态）、翻转结果经 addModel 落进 save payload
 *   （用户最终持久化数据，证明开关真实生效而非装饰）。
 * - 构建者白盒（佐证）：aria-checked 是 :model-value="deps.newModel.reasoning" 受控
 *   回流的渲染结果，断言它即等价断言 newModel.reasoning 翻转，未窥组件私有状态。
 * - 观察者形态：switch 的存在与状态变化全部经由 DOM 属性断言，无组件内部 spy。
 */
describe('添加模型表单：reasoning 思考开关（D4）', () => {
  /** i18n mock t() 返回 key 本身 → aria-label 即 key（switch 唯一，可全局定位） */
  const SW_SELECTOR = 'button[role="switch"][aria-label="settings.providerEdit.reasoningLabel"]'

  async function openAddForm(): Promise<void> {
    const addToggle = wrapper!.findAll('button').find((b) => b.text().includes('settings.providerEdit.manualAdd'))
    expect(addToggle).toBeTruthy()
    await addToggle!.trigger('click')
    await flushPromises()
  }

  it('表单渲染 reasoning 开关（accessible name 定位），点击后 aria-checked 翻转且可逆向', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()
    await openAddForm()

    // (a) 用户可见：开关渲染，出厂显式 boolean（newModel.reasoning 初始 true）
    const sw = wrapper.find(SW_SELECTOR)
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('aria-checked')).toBe('true')
    expect(sw.attributes('data-state')).toBe('checked')

    // (b) 点击翻转：aria-checked 变 false（DOM 可见形态，非仅内部状态）
    await sw.trigger('click')
    await flushPromises()
    expect(wrapper.find(SW_SELECTOR).attributes('aria-checked')).toBe('false')
    expect(wrapper.find(SW_SELECTOR).attributes('data-state')).toBe('unchecked')

    // 逆向再点击翻回 true（用户可显式关/开）
    await wrapper.find(SW_SELECTOR).trigger('click')
    await flushPromises()
    expect(wrapper.find(SW_SELECTOR).attributes('aria-checked')).toBe('true')
  })

  it('关掉 reasoning 后添加模型并保存 → payload 新条目 reasoning=false（开关真实生效）', async () => {
    wrapper = mountBody(APIKEY_P)
    await flushPromises()
    await openAddForm()

    // 关掉开关（出厂 true → false）
    const sw = wrapper.find(SW_SELECTOR)
    expect(sw.attributes('aria-checked')).toBe('true')
    await sw.trigger('click')
    await flushPromises()
    expect(wrapper.find(SW_SELECTOR).attributes('aria-checked')).toBe('false')

    // 填名 + 添加 + 保存（payload 链路对齐场景 ⑤ 既有模式）
    await wrapper.find('input[placeholder="settings.providerEdit.modelNamePlaceholder"]').setValue('glm-5.4-preview')
    const addBtn = wrapper.findAll('button').find((b) => b.text().trim() === 'settings.providerEdit.addBtn')
    await addBtn!.trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    // D4 契约：reasoning 显式 boolean 落盘（false 不被吞）——缺失会让 pi 把思考档钳回 off
    const models = savePayload().models as Array<{ id: string; reasoning?: boolean }>
    const added = models.find((m) => m.id === 'glm-5.4-preview')
    expect(added).toBeTruthy()
    expect(added!.reasoning).toBe(false)
  })
})

// ══ 场景 ⑦：Coding Plan 接线（契约 v2：workspace 回写 + R4 carry-in 槽位哨兵排除）══════

describe('quota 接线注入态（契约 v2 透传）', () => {
  it('CodingPlanSection 上抛 update:workspaceInput → 写回注入的 quotaWorkspaceInput ref', async () => {
    // 捕获注入的 quota state（ProviderEditBody 透传给 CodingPlanSection 的 workspace 真源）
    let state: QuotaConfigureState | undefined
    quotaFactoryStub.mockImplementationOnce(() => {
      state = makeQuotaState()
      return state
    })
    wrapper = mountBody(OAUTH_P)
    await flushPromises()

    // cookie 类 + 资源维度 fetcher → CodingPlanSection 渲染 workspace 块
    // （契约 v2：D8 要求类型已选才渲染参数区，故先给出 fetcherId）
    state!.fetcherId.value = 'opencode-go'
    state!.isCookieAuth.value = true
    state!.needsWorkspace.value = true
    await nextTick()
    const input = document.body.querySelector<HTMLInputElement>('[data-testid="quota-workspace-input"]')
    expect(input).toBeTruthy()

    input!.value = 'wrk_9'
    input!.dispatchEvent(new Event('input'))
    await nextTick()

    expect(state!.workspaceInput.value).toBe('wrk_9')
  })

  /**
   * R4（impl-plan §5）：providerCredentialPendingSave 是 carry-in 可写 ref，由 ProviderEditBody
   * 按 `form.apiKey !== '' && !== API_KEY_CLEAR_SENTINEL` 写入。判定式排除哨兵是必须的：
   * 用户点「清除」时 form.apiKey === '__CLEAR__'（非空但语义是无凭据），只用 `!== ''` 会让
   * UI 显示与事实相反的「已填写，保存后即可查询」（§7.4 两套文案）。
   */
  it('provider 表单填 API Key → pendingSave=true 且 UI 渲染「已填写，保存后即可查询」文案', async () => {
    let state: QuotaConfigureState | undefined
    quotaFactoryStub.mockImplementationOnce(() => {
      state = makeQuotaState()
      return state
    })
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // 注入态：选中 api-key 类类型、来源=provider、provider 侧无可用凭据 → 警告文案可见
    state!.fetcherId.value = 'zhipu'
    state!.credentialSource.value = 'provider'
    state!.providerCredentialAvailable.value = false
    await nextTick()
    // 草稿为空 → 「还没有可用的 API Key」
    expect(wrapper.text()).toContain('settings.providerEdit.quotaProviderCredentialMissing')
    expect(state!.providerCredentialPendingSave.value).toBe(false)

    // 表单里填 Key（尚未保存 provider）→ carry-in ref 翻转 + 文案切换（用户可见）
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('sk-draft-key')
    await flushPromises()
    expect(state!.providerCredentialPendingSave.value).toBe(true)
    expect(wrapper.text()).toContain('settings.providerEdit.quotaProviderCredentialPendingSave')
    expect(wrapper.text()).not.toContain('settings.providerEdit.quotaProviderCredentialMissing')
  })

  it('点「清除」写入 __CLEAR__ 哨兵 → pendingSave 回 false，文案退回「还没有可用的 API Key」', async () => {
    let state: QuotaConfigureState | undefined
    quotaFactoryStub.mockImplementationOnce(() => {
      state = makeQuotaState()
      return state
    })
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    state!.fetcherId.value = 'zhipu'
    state!.credentialSource.value = 'provider'
    state!.providerCredentialAvailable.value = false
    await wrapper.find('[data-testid="provider-edit-apikey"]').setValue('sk-draft-key')
    await flushPromises()
    expect(state!.providerCredentialPendingSave.value).toBe(true)

    // 清除按钮（provider.apiKeySet=true 时才渲染）→ form.apiKey = API_KEY_CLEAR_SENTINEL
    const clearBtn = wrapper.find('button[aria-label="settings.providerEdit.clearKey"]')
    expect(clearBtn.exists()).toBe(true)
    await clearBtn.trigger('click')
    await flushPromises()

    // 哨兵非空，但语义 = 无凭据：pendingSave 必须回 false，否则文案与事实相反
    expect(state!.providerCredentialPendingSave.value).toBe(false)
    expect(wrapper.text()).toContain('settings.providerEdit.quotaProviderCredentialMissing')
    expect(wrapper.text()).not.toContain('settings.providerEdit.quotaProviderCredentialPendingSave')
  })

  it('provider 表单草稿清空（删除已输入内容）→ pendingSave 回 false', async () => {
    let state: QuotaConfigureState | undefined
    quotaFactoryStub.mockImplementationOnce(() => {
      state = makeQuotaState()
      return state
    })
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    const input = wrapper.find('[data-testid="provider-edit-apikey"]')
    await input.setValue('sk-draft-key')
    await flushPromises()
    expect(state!.providerCredentialPendingSave.value).toBe(true)

    await input.setValue('')
    await flushPromises()
    expect(state!.providerCredentialPendingSave.value).toBe(false)
  })
})

// ══ 场景 ⑧：M4 catalog 展示对齐 pi 真实语义（设计 D5/D7）════════════════════

/**
 * M4：catalog provider 的 provider 级字段展示改为「网关优先 + 模型集派生兜底」。
 *
 * 三视角：
 * - 黑盒用户视角（主）：类型不再是输入框而是只读派生文案（含协议分布）；端点是「自定义
 *   网关」可选框、框下标注当前派生端点态；custom 照旧可编辑。
 * - 构建者白盒（佐证）：保存 payload 的 baseUrl 语义（留空 = 显式空串 = 清除网关 / 非空 =
 *   设置网关）与 runtime 防线③ 一致——这是「展示 = 生效」的落盘侧证据。
 * - 观察者形态：全部经 DOM 与 payload 断言，无组件内部 spy。
 */
describe('M4 catalog 展示：类型只读派生 + 端点（自定义网关）', () => {
  /** 端点输入框（catalog 分支） */
  const ENDPOINT = '[data-testid="provider-edit-endpoint"]'
  const ENDPOINT_HINT = '[data-testid="provider-edit-endpoint-hint"]'

  it('混合协议 catalog：不渲染类型输入框，展示「按模型分发」+ 协议分布', async () => {
    wrapper = mountBody(CATALOG_MIXED_P)
    await flushPromises()

    // 用户可见：只读派生文案（非输入控件）
    const derived = wrapper.find('[data-testid="provider-edit-api-derived"]')
    expect(derived.exists()).toBe(true)
    const typeField = wrapper.find('[data-testid="provider-edit-type-field"]')
    expect(typeField.exists()).toBe(true)
    expect(typeField.find('input').exists()).toBe(false)
    expect(typeField.find('[role="combobox"]').exists()).toBe(false)

    // 文案：按模型分发（{distribution}）+ 三种协议各自出现
    expect(derived.text()).toContain('settings.providerEdit.apiMixedDetail')
    expect(derived.text()).toContain('settings.providerEdit.apiDistributionItem')
    expect(derived.text()).toContain('anthropic-messages')
    expect(derived.text()).toContain('openai-completions')
    expect(derived.text()).toContain('openai-responses')
  })

  it('单协议 catalog：展示该协议名（仍无类型输入框）', async () => {
    wrapper = mountBody(CATALOG_UNIFORM_P)
    await flushPromises()

    const derived = wrapper.find('[data-testid="provider-edit-api-derived"]')
    expect(derived.exists()).toBe(true)
    expect(derived.text()).toBe('openai-completions')
    expect(wrapper.find('[data-testid="provider-edit-type-field"] [role="combobox"]').exists()).toBe(false)
  })

  it('端点框留空：单端点 → 「内置端点」+ 派生 URL；混合 → 「内置端点（按模型分发）」；全空 → 「内置目录未提供」', async () => {
    wrapper = mountBody(CATALOG_UNIFORM_P)
    await flushPromises()
    // 单端点：标注内置端点并展示当前派生端点值（输入框本身留空）
    expect(wrapper.find(ENDPOINT_HINT).text()).toContain('settings.providerEdit.endpointBuiltin')
    expect(wrapper.find(ENDPOINT_HINT).text()).toContain('https://api.deepseek.com')
    expect((wrapper.find(ENDPOINT).element as HTMLInputElement).value).toBe('')

    wrapper.unmount()
    wrapper = mountBody(CATALOG_MIXED_P)
    await flushPromises()
    // 混合端点：按模型分发（无单值可展示）
    expect(wrapper.find(ENDPOINT_HINT).text()).toBe('settings.providerEdit.endpointBuiltinMixed')

    wrapper.unmount()
    wrapper = mountBody(CATALOG_NO_ENDPOINT_P)
    await flushPromises()
    // 全空：内置目录未提供
    expect(wrapper.find(ENDPOINT_HINT).text()).toBe('settings.providerEdit.endpointNotProvided')
  })

  it('端点框填值：标注「自定义网关：{url}（覆盖全部模型）」', async () => {
    wrapper = mountBody(CATALOG_MIXED_P)
    await flushPromises()

    await wrapper.find(ENDPOINT).setValue('https://mirror.example/opencode')
    await flushPromises()

    const hint = wrapper.find(ENDPOINT_HINT).text()
    expect(hint).toContain('settings.providerEdit.endpointGateway')
    expect(hint).toContain('https://mirror.example/opencode')
    expect(hint).toContain('settings.providerEdit.endpointGatewayCovers')
  })

  it('已设网关的 catalog：端点框回填网关值 + 网关标注；保存不改写该值', async () => {
    wrapper = mountBody(CATALOG_GATEWAY_P)
    await flushPromises()

    expect((wrapper.find(ENDPOINT).element as HTMLInputElement).value).toBe(CATALOG_GATEWAY_URL)
    expect(wrapper.find(ENDPOINT_HINT).text()).toContain('settings.providerEdit.endpointGateway')

    // 改一个无关字段（名称）后保存 → payload 仍带网关照旧下发
    await wrapper.find('[data-testid="provider-edit-name"]').setValue('OpenCode Go (corp)')
    await flushPromises()
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    expect(savePayload().baseUrl).toBe(CATALOG_GATEWAY_URL)
    // catalog 不带 type 键（防线①：协议是模型级属性）
    expect('type' in savePayload()).toBe(false)
  })

  it('端点无网关且未改动 → 保存 payload baseUrl 为空串（不回写 runtime 派生值，防线③ 清除语义）', async () => {
    wrapper = mountBody(CATALOG_UNIFORM_P)
    await flushPromises()

    // 改名称制造 dirty（端点框保持留空）
    await wrapper.find('[data-testid="provider-edit-name"]').setValue('DeepSeek 2')
    await flushPromises()
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    // 派生值 https://api.deepseek.com 不是用户网关——绝不能当网关写回（artifact 冻结）
    expect(savePayload().baseUrl).toBe('')
  })

  it('填网关后保存 → payload baseUrl = 用户输入（设置网关）', async () => {
    wrapper = mountBody(CATALOG_MIXED_P)
    await flushPromises()

    await wrapper.find(ENDPOINT).setValue('https://mirror.example/opencode')
    await flushPromises()
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    expect(savePayload().baseUrl).toBe('https://mirror.example/opencode')
  })

  it('清空已设网关 → 保存 payload baseUrl 为空串（清除网关，回退内置端点）', async () => {
    wrapper = mountBody(CATALOG_GATEWAY_P)
    await flushPromises()

    await wrapper.find(ENDPOINT).setValue('')
    await flushPromises()
    expect(wrapper.find(ENDPOINT_HINT).text()).toBe('settings.providerEdit.endpointBuiltinMixed')

    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    expect(savePayload().baseUrl).toBe('')
  })

  it('custom 回归：类型 Select 与 Base URL 输入框照旧可编辑，保存 payload 带 type 与 baseUrl', async () => {
    wrapper = mountBody(CUSTOM_P)
    await flushPromises()

    // 类型输入框存在（非 catalog 派生文案）、无端点框
    expect(wrapper.find('[data-testid="provider-edit-api-derived"]').exists()).toBe(false)
    expect(wrapper.find(ENDPOINT).exists()).toBe(false)
    const baseUrlInput = wrapper.find('input[placeholder="https://api.anthropic.com"]')
    expect(baseUrlInput.exists()).toBe(true)
    expect(wrapper.text()).toContain('settings.providerEdit.baseUrlKeepHint')

    await baseUrlInput.setValue('https://api.example.com/v1')
    await flushPromises()
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()

    expect(savePayload().type).toBe('openai-completions')
    expect(savePayload().baseUrl).toBe('https://api.example.com/v1')
  })

  it('切换 provider（网关 → 无网关）：端点框重置为空且不产生虚假 dirty', async () => {
    wrapper = mountBody(CATALOG_GATEWAY_P)
    await flushPromises()
    expect((wrapper.find(ENDPOINT).element as HTMLInputElement).value).toBe(CATALOG_GATEWAY_URL)
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(false)

    await wrapper.setProps({ provider: CATALOG_MIXED_P })
    await flushPromises()

    // 无网关 provider 的派生值（undefined）不回填输入框；草稿重置不得改写 form.baseUrl（否则假 dirty）
    expect((wrapper.find(ENDPOINT).element as HTMLInputElement).value).toBe('')
    expect(wrapper.find(ENDPOINT_HINT).text()).toBe('settings.providerEdit.endpointBuiltinMixed')
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(false)
    expect(wrapper.emitted('dirtyChange')!.at(-1)).toEqual([false])
  })
})

// ══ 场景 ⑨：M3b 测试连接/发现接线（计划 D-17 集成缺口回归）════════════════════

/**
 * M3b 单元把 ProviderTestDiscoverSection 改成「按协议分组 + catalog 门控模型发现」并加了 4 个
 * 可选 props（providerKind/testResults/testError/providerBaseUrl），但宿主 ProviderEditBody 未接线，
 * 4 个 props 全走默认值——子组件级测试绿，应用级「模型发现」按钮对 catalog 仍渲染、测试结果拿不到
 * results（计划登记为 D-17）。本组断言**应用级**行为：mount 宿主组件、点宿主按钮、断言宿主 DOM，
 * 证明 props 真由 useProviderEdit 经 useCatalogDisplay().testDiscoverProps 接上，而非子组件默认值。
 *
 * 三视角：
 * - 黑盒用户视角（主）：catalog 编辑体内无「模型发现」按钮、custom 有；测试连接后按协议分组的结果
 *   行与失败指引出现在编辑体内；无可用模型时的指引文案按 provider 体系分叉。
 * - 构建者白盒（佐证）：结果数据由 transport.discoverModels 真实流经 useProviderEdit → props → DOM。
 * - 观察者形态：全部为 DOM 断言 + transport spy，不窥探组件内部状态。
 */
describe('M3b 接线：测试连接分组结果与模型发现门控（应用级）', () => {
  const DISCOVER_TEXT = 'settings.providerEdit.autoDiscover'
  const TEST_TEXT = 'settings.providerEdit.testConnection'

  /** 宿主编辑体内按文案（i18n key；t() mock 返回 key）查找按钮 */
  function findButton(text: string) {
    return wrapper!.findAll('button').find((b) => b.text().includes(text))
  }

  async function clickTest(): Promise<void> {
    const btn = findButton(TEST_TEXT)
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()
  }

  it('catalog provider：编辑体内不渲染「模型发现」按钮（catalog 门控经宿主接线生效）', async () => {
    wrapper = mountBody(CATALOG_MIXED_P)
    await flushPromises()

    expect(findButton(DISCOVER_TEXT)).toBeUndefined()
    // 门控只针对发现：测试连接按钮仍在
    expect(findButton(TEST_TEXT)).toBeTruthy()
  })

  it('custom provider：编辑体内渲染「模型发现」按钮（custom 发现语义保留）', async () => {
    wrapper = mountBody(CUSTOM_P)
    await flushPromises()

    expect(findButton(DISCOVER_TEXT)).toBeTruthy()
  })

  it('测试连接回多协议结果 → 编辑体内按协议分组渲染结果行 + 失败指引（testResults / providerBaseUrl 接线）', async () => {
    discoverModelsSpy.mockResolvedValueOnce({
      success: true,
      results: [
        { api: 'anthropic-messages', modelId: 'minimax-m3', ok: true },
        { api: 'openai-completions', modelId: 'qwen3.8-flash', ok: false, error: 'http_error|404|not found' },
      ],
    })
    // 网关态 fixture：生效端点 = provider.baseUrl（网关 override，非表单快照 artifact）
    wrapper = mountBody(CATALOG_GATEWAY_P)
    await flushPromises()
    await clickTest()

    const results = wrapper.find('[data-testid="provider-test-results"]')
    expect(results.exists()).toBe(true)
    // 标题 + 每协议一行 = 3 个直接子节点（未接线时 testResults 走默认 []，本区根本不渲染）
    expect(results.element.children.length).toBe(3)
    expect(results.text()).toContain('settings.providerEdit.testRowSuccess')
    expect(results.text()).toContain('anthropic-messages')
    expect(results.text()).toContain('settings.providerEdit.testRowHttpError')
    expect(results.text()).toContain('404')
    // 有分组结果时不渲染整体失败行
    expect(wrapper.find('[data-testid="provider-test-overall-error"]').exists()).toBe(false)

    // 失败指引的 {baseUrl} = 宿主下发的生效端点（默认 '' 时 mock 不 append，故此断言即接线证据）
    const hints = wrapper.find('[data-testid="provider-test-hints"]')
    expect(hints.exists()).toBe(true)
    expect(hints.text()).toContain('settings.providerEdit.testHintHttpError')
    expect(hints.text()).toContain(CATALOG_GATEWAY_URL)
  })

  it('测试连接整体失败（success=false）→ 编辑体内渲染整体失败原因 + 指引（testError 接线）', async () => {
    discoverModelsSpy.mockResolvedValueOnce({ success: false, error: 'no_api_key' })
    wrapper = mountBody(APIKEY_P)
    await flushPromises()
    await clickTest()

    const overall = wrapper.find('[data-testid="provider-test-overall-error"]')
    expect(overall.exists()).toBe(true)
    expect(overall.text()).toContain('settings.providerEdit.testNoApiKey')
    // 无分组结果（testResults 保持空）→ 整体指引按 testError 分类
    expect(wrapper.find('[data-testid="provider-test-results"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="provider-test-hints"]').text()).toContain('settings.providerEdit.testHintNoApiKey')
  })

  it('providerKind 接线：无可用模型失败指引按 catalog / custom 分叉', async () => {
    discoverModelsSpy.mockResolvedValueOnce({ success: false, error: 'no_models' })
    wrapper = mountBody(CATALOG_MIXED_P)
    await flushPromises()
    await clickTest()
    expect(wrapper.find('[data-testid="provider-test-hints"]').text()).toContain('settings.providerEdit.testHintNoModelsCatalog')

    wrapper.unmount()
    discoverModelsSpy.mockResolvedValueOnce({ success: false, error: 'no_models' })
    wrapper = mountBody(CUSTOM_P)
    await flushPromises()
    await clickTest()
    expect(wrapper.find('[data-testid="provider-test-hints"]').text()).toContain('settings.providerEdit.testHintNoModelsCustom')
  })
})

// ══ 场景 ⑩：R4 review 增量补口（coverage Gate 复跑实测 4 行未覆盖）════════════════════

/**
 * R4 补口（实测 uncovered 行）：custom 类型 Select 的 v-model handler、quota 事件透传
 * （update:fetcherId / update:credentialSource → 注入 ref 回写）、providerApi computed
 * （compat 编辑器展开时经 ModelListSection.resolveApi 惰性求值，isCatalog=false 走 form.api 分支）。
 * 三视角：黑盒 = 交互后用户可见状态 / payload；白盒 = 注入 state ref 回写断言（不窥组件内部）；
 * 观察者 = 全部 DOM / payload / 注入 stub 断言，无组件内部 spy。
 */
describe('R4 补口：类型 Select / quota 事件接线 / compat providerApi', () => {
  /** reka Select 交互（happy-dom 需显式 pointer 事件；同 renderer rename-model 测试模式） */
  async function pickSelectOption(triggerEl: HTMLElement, label: string): Promise<void> {
    triggerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    triggerEl.click()
    await flushPromises()
    const target = Array.from(document.body.querySelectorAll('[role="option"]'))
      .find((el): el is HTMLElement => (el.textContent ?? '').includes(label))
    expect(target).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
  }

  it('custom 类型 Select 可改：选 openai-responses → dirty → payload.type 跟随', async () => {
    wrapper = mountBody(CUSTOM_P)
    await flushPromises()

    const trigger = wrapper
      .find('[data-testid="provider-edit-type-field"] [role="combobox"]')
      .element as HTMLElement
    await pickSelectOption(trigger, 'settings.providerEdit.apiOpenaiResponses')

    // form.api 变更 → dirty（save-bar 出现）→ 保存 payload 携带新类型
    expect(wrapper.find('[data-testid="provider-save-bar"]').exists()).toBe(true)
    await wrapper.find('[data-testid="provider-save-btn"]').trigger('click')
    await flushPromises()
    expect(savePayload().type).toBe('openai-responses')
  })

  it('quota 类型下拉透传：CodingPlanSection 上抛 update:fetcherId → 注入 state.fetcherId 回写', async () => {
    let state: QuotaConfigureState | undefined
    quotaFactoryStub.mockImplementationOnce(() => {
      state = makeQuotaState()
      state.fetcherOptions = [
        { value: 'alpha', label: 'Alpha Plan' },
        { value: 'beta', label: 'Beta Plan' },
      ]
      return state
    })
    wrapper = mountBody(OAUTH_P)
    await flushPromises()

    // D8 类型未定态类型下拉也恒渲染；选中后事件经宿主 handler 回写注入 ref
    const trigger = wrapper.find('[data-testid="quota-type-select"]').element as HTMLElement
    await pickSelectOption(trigger, 'Beta Plan')

    expect(state!.fetcherId.value).toBe('beta')
  })

  it('quota 凭证来源透传：点 exclusive 项 → 注入 state.credentialSource 回写', async () => {
    let state: QuotaConfigureState | undefined
    quotaFactoryStub.mockImplementationOnce(() => {
      state = makeQuotaState()
      return state
    })
    wrapper = mountBody(APIKEY_P)
    await flushPromises()

    // D8 参数区渲染前置：类型已选 + api-key 类 + 来源可用（exclusive 项可点）
    state!.fetcherId.value = 'zhipu'
    state!.authKinds.value = ['api-key']
    state!.credentialSource.value = 'provider'
    state!.providerCredentialAvailable.value = true
    await nextTick()

    await wrapper.find('[data-testid="quota-source-exclusive-btn"]').trigger('click')
    expect(state!.credentialSource.value).toBe('exclusive')
  })

  it('compat 展开触发 providerApi 求值（custom：form.api 分支）→ CompatEditor 渲染', async () => {
    wrapper = mountBody(CUSTOM_P)
    await flushPromises()

    // 未展开时 compat 编辑器不渲染
    expect(wrapper.find('.compat-editor').exists()).toBe(false)

    const toggle = wrapper.find('button[aria-label="settings.compat.title"]')
    expect(toggle.exists()).toBe(true)
    await toggle.trigger('click')
    await flushPromises()

    // 用户可见：编辑器块 + 关键字段分组标签（字段集来自 resolveApi(m.api) →
    // providerApi（custom 走 form.api='openai-completions'）回落链）
    expect(wrapper.find('.compat-editor').exists()).toBe(true)
    expect(wrapper.find('.compat-editor').text()).toContain('settings.compat.essential')
  })
})
