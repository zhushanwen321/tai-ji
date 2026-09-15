/**
 * ProviderPage 渲染测试（W9 + W4 + R4 手风琴就地编辑）。
 *
 * 覆盖：
 *  - 首屏冒烟：providers=[] → 渲染「添加供应商」按钮 + 空状态。
 *  - R4：点击添加 → 不弹 Dialog，列表底部新建合成行并展开（provider-expand-body 渲染）。
 *  - R4：点击供应商名称 → 行内展开就地编辑体（无 Dialog teleport）。
 *  - U5（W4）：默认模型标记从 settingsStore.defaultModel 派生。
 *
 * mock 策略：
 *  - vi.mock('@/api') 替换 config 门面。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/settings/provider-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BuiltinProviderTemplate, ProviderInfo } from '@taiji/shared'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@taiji/core'

const configMock = vi.hoisted(() => ({
  onProviders: vi.fn(() => () => {}),
  // 门面签名 { providers, scopedModels }（settings-lifecycle 解构消费）；裸数组解构得 undefined
  listProviders: vi.fn(async () => ({ providers: [], scopedModels: undefined })),
  setProvider: vi.fn(async () => {}),
  deleteProvider: vi.fn(async () => {}),
  // wave4 C1/IF3：toggle 持久化走 toggleProviderEnabled（写 enabledModels 白名单），删除按 kind 走 removeProviderByKind
  toggleProviderEnabled: vi.fn(async () => {}),
  removeProviderByKind: vi.fn(async () => {}),
  testProvider: vi.fn(async () => ({ ok: true })),
  discoverModels: vi.fn(async () => ({ success: true, models: [] })),
  setDefaultModel: vi.fn(async () => {}),
  setScopedModels: vi.fn(async () => [] as string[]),
  // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
  onDefaultsWithSource: vi.fn(() => () => {}),
  // wave-quick-setup-c/wave-list-badge：OAuth + env 检测（useProviderOAuth onMounted 订阅）
  checkEnvVars: vi.fn(async () => ({})),
  oauthLogin: vi.fn(async () => ({ started: false, error: 'mock' })),
  oauthCancel: vi.fn(async () => ({ cancelled: false })),
  hasOAuth: vi.fn(async () => false),
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  listBuiltinProviders: vi.fn(async () => []),
  // ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
  refreshProviderCatalogs: vi.fn(async () => ({ refreshed: [], failed: [] })),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: configMock,
  default: { config: configMock },
}))

import ProviderPage from '@/components/settings/provider/ProviderPage.vue'

let wrapper: ReturnType<typeof mount> | null = null

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200_000, input: ['text', 'image'] },
      { id: 'claude-opus-4', name: 'Claude Opus 4', contextWindow: 200_000, input: ['text', 'image'] },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, input: ['text', 'image'] },
    ],
  },
]

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  configMock.setProvider.mockClear()
  configMock.deleteProvider.mockClear()
  configMock.toggleProviderEnabled.mockClear()
  configMock.removeProviderByKind.mockClear()
  configMock.setDefaultModel.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ProviderPage 首屏冒烟', () => {
  it('providers=[] → 渲染「添加供应商」按钮 + 空状态文案', async () => {
    wrapper = mount(ProviderPage, { props: { providers: [] } })
    await flushPromises()
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))
    expect(addBtn).toBeTruthy()
    expect(wrapper.text()).toContain('还没有供应商')
  })
})

describe('ProviderPage R4 手风琴就地编辑（取代 ProviderEditModal）', () => {
  it('点击「添加供应商」→ 菜单选「自定义」→ 列表底部新建合成行并展开就地编辑体', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()

    // 初始无展开体
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)

    // F2：入口聚合为「+ 添加供应商 ▾」菜单，先点 trigger 打开菜单，再点「自定义」条目
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))!
    await addBtn.trigger('click')
    await flushPromises()
    const customItem = document.body.querySelector<HTMLElement>('[data-testid="add-menu-custom"]')
    expect(customItem).toBeTruthy()
    customItem!.click()
    await flushPromises()

    // 合成行渲染 + 展开体渲染（就地编辑，非 Dialog teleport）
    const expandBody = wrapper.find('[data-testid="provider-expand-body"]')
    expect(expandBody.exists()).toBe(true)
    // 名称 input 存在（ProviderEditBody 首字段）
    expect(wrapper.find('[data-testid="provider-edit-name"]').exists()).toBe(true)
    // body 里不应出现 Dialog（无 [role="dialog"]）
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('点击供应商名称 → 行内展开就地编辑体（凭据字段可见，不弹 Dialog）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // 初始无展开
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)

    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()

    // 展开体渲染
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)
    // 凭据字段（名称 input）可见
    expect(wrapper.find('[data-testid="provider-edit-name"]').exists()).toBe(true)
    // 无 Dialog teleport
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('再次点击已展开供应商名称 → 收起展开体', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const name = wrapper.findAll('span').find((s) => s.text() === 'Anthropic')!
    await name.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)

    // 再次点击收起
    await name.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)
  })
})

describe('ProviderPage 默认模型从 settingsStore.defaultModel 派生（U5）', () => {
  it('U5: store.defaultModel 归属 provider → 行头显示「默认供应商」pill', async () => {
    getSettingsStore().defaultModel.value = 'anthropic/claude-sonnet-4'
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // anthropic 行头显示默认 pill（行头常驻，不需展开）
    expect(wrapper.text()).toContain('默认供应商')
  })

  it('U5b: 改 store.defaultModel 到 openai → 默认 pill 跟随切换到 openai 行', async () => {
    getSettingsStore().defaultModel.value = 'anthropic/claude-sonnet-4'
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()
    // 默认 pill 出现在 anthropic 行
    const cards = wrapper.findAll('[data-testid="provider-card"]')
    expect(cards[0]!.text()).toContain('默认供应商')

    // 切默认到 openai/gpt-4o
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    await wrapper.vm.$nextTick()
    await flushPromises()

    const cardsAfter = wrapper.findAll('[data-testid="provider-card"]')
    expect(cardsAfter[0]!.text()).not.toContain('默认供应商')
    expect(cardsAfter[1]!.text()).toContain('默认供应商')
  })
})

/**
 * W1 robustness pass：
 *  - U1（D4）：toggle enabled 失败时 actionError 经常驻 inline error 区域可见。
 *  - D14：删除 defaultModel 归属 provider 时前端兜底清空 defaultModel。
 */
describe('ProviderPage W1 robustness', () => {
  it('U1: toggle enabled 失败 → 常驻 inline error 区域可见并含错误文案', async () => {
    configMock.toggleProviderEnabled.mockRejectedValueOnce(new Error('网络错误'))
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-action-error"]').exists()).toBe(false)

    const sw = wrapper.findAll('[role="switch"]')[0]
    await sw.trigger('click')
    await flushPromises()

    const err = wrapper.find('[data-testid="provider-action-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('网络错误')
  })

  it('D14: 删除 defaultModel 归属 provider → 前端清空 defaultModel', async () => {
    const store = getSettingsStore()
    store.defaultModel.value = 'anthropic/claude-sonnet-4'
    configMock.removeProviderByKind.mockResolvedValueOnce(undefined)
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const trashBtns = wrapper.findAll('button[title="删除供应商"]')
    await trashBtns[0]!.trigger('click')
    await flushPromises()

    const confirmBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('确认删除')) as HTMLButtonElement | undefined
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()
    await flushPromises()

    expect(configMock.removeProviderByKind).toHaveBeenCalledWith('anthropic', 'custom')
    expect(store.defaultModel.value).toBe('')
  })
})

describe('ProviderPage 认证徽章（wave-list-badge TC3）', () => {
  it('env_var → $ENV 徽章（info 色）；oauth → OAuth（warn 色）', async () => {
    const badgeProviders: ProviderInfo[] = [
      { id: 'a', name: 'A', apiKeySet: true, status: 'connected', authMethod: 'env_var', enabled: true, models: [] },
      { id: 'b', name: 'B', apiKeySet: false, status: 'connected', authMethod: 'oauth', enabled: true, models: [] },
    ]
    wrapper = mount(ProviderPage, {
      props: { providers: badgeProviders },
      attachTo: document.body,
    })
    await flushPromises()

    const badges = document.body.querySelectorAll('[data-testid="provider-auth-badge"]')
    expect(badges.length).toBe(2)
    // renderer vitest.setup 的 t 是真实翻译实例（返回翻译值），断言真实文案
    expect(badges[0]!.textContent).toBe('$ENV')
    expect(badges[1]!.textContent).toBe('OAuth')
    // env info 色 / oauth warn 色
    expect(badges[0]!.className).toContain('bg-info-soft')
    expect(badges[1]!.className).toContain('bg-warn-soft')
  })

  it('api_key 已设置 → API Key（中性色）；无凭据 → API Key（未设置）', async () => {
    const badgeProviders: ProviderInfo[] = [
      { id: 'a', name: 'A', apiKeySet: true, status: 'connected', authMethod: 'api_key', enabled: true, models: [] },
      { id: 'b', name: 'B', apiKeySet: false, status: 'not_configured', enabled: true, models: [] },
    ]
    wrapper = mount(ProviderPage, {
      props: { providers: badgeProviders },
      attachTo: document.body,
    })
    await flushPromises()

    const badges = document.body.querySelectorAll('[data-testid="provider-auth-badge"]')
    expect(badges[0]!.textContent).toBe('API Key')
    expect(badges[1]!.textContent).toBe('API Key（未设置）')
    // 中性色
    expect(badges[0]!.className).toContain('bg-surface-hover')
  })
})

/** oauth 能力的内置模板（B-1 QuickSetup OAuth 登录链路 fixture） */
const OAUTH_TEMPLATE: BuiltinProviderTemplate = {
  id: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  authMode: 'both',
  envVars: ['ANTHROPIC_API_KEY'],
  oauthSupported: true,
  modelCount: 3,
  models: [],
}

/** body 内 portal 元素点击（reka Portal teleport 到 body，Vue @click 原生冒泡生效） */
function clickBody(selector: string): void {
  const el = document.body.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`body 元素未找到: ${selector}`)
  el.click()
}

describe('ProviderPage QuickSetup OAuth 登录链路（B-1）', () => {
  it('选 oauth 模板 → QuickSetup 登录 → config.oauthLogin 启动 flow + OAuthDialog 打开 pending 态', async () => {
    configMock.listBuiltinProviders.mockResolvedValueOnce([OAUTH_TEMPLATE])
    configMock.oauthLogin.mockResolvedValueOnce({ started: true })
    wrapper = mount(ProviderPage, {
      props: { providers: [] },
      attachTo: document.body,
    })
    await flushPromises()

    // 入口：添加供应商 → 从内置模板 → 选 anthropic（portal 内容经 document.body 查询）
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加供应商'))!
    await addBtn.trigger('click')
    await flushPromises()
    clickBody('[data-testid="add-menu-builtin"]')
    await flushPromises()
    clickBody('[data-testid="provider-template-anthropic"]')
    await flushPromises()

    // QuickSetup 打开（anthropic 元信息可见）
    const quickSetup = document.body.querySelector('[data-testid="provider-quick-setup"]')
    expect(quickSetup).toBeTruthy()
    expect(quickSetup!.textContent).toContain('Anthropic')

    // 切 OAuth 凭据选项 → 登录按钮出现 → 点击（onQuickSetupOAuthLogin → startQuickSetupOauth）
    clickBody('[data-testid="auth-option-oauth"]')
    await flushPromises()
    const loginBtn = document.body.querySelector<HTMLElement>('[data-testid="oauth-login-button"]')
    expect(loginBtn).toBeTruthy()
    loginBtn!.click()
    await flushPromises()

    // 共享 oauth 状态机启动 flow（provider id = 模板 id）
    expect(configMock.oauthLogin).toHaveBeenCalledTimes(1)
    expect(configMock.oauthLogin).toHaveBeenCalledWith('anthropic')
    // OAuthDialog 打开 pending 态（portal 到 body；与 QuickSetup 共用同一状态机实例）
    expect(document.body.querySelector('[data-testid="oauth-dialog"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="oauth-pending"]')).toBeTruthy()
  })
})

describe('ProviderPage A6 e2e-mock: ScopedModelSection 挂载与交互链路', () => {
  it('A6: ProviderPage 渲染 ScopedModelSection 区域（组件挂载链路通）', async () => {
    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // ScopedModelSection 区域存在（mock 模式下 settingsStore.scopedModels 默认空数组）
    expect(wrapper.find('[data-testid="scoped-model-section"]').exists()).toBe(true)
    // 空状态提示可见
    expect(wrapper.find('[data-testid="scoped-empty"]').exists()).toBe(true)
    // 添加按钮存在
    expect(wrapper.find('[data-testid="scoped-add-btn"]').exists()).toBe(true)
  })

  it('A6: 预填 scopedModels → 行序渲染 → 上移 → config.setScopedModels 收到交换后的完整有序数组', async () => {
    const store = getSettingsStore()
    // useScopedModels 从 store（非 props）派生渲染项：预填 providers + scopedModels
    store.providers.value = PROVIDERS
    store.scopedModels.value = ['anthropic/claude-sonnet-4', 'openai/gpt-4o']
    configMock.setScopedModels.mockClear()

    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    // 行渲染顺序 = scopedModels 数组序
    const names = wrapper.findAll('[data-testid="scoped-model-name"]')
    expect(names.map((n) => n.text())).toEqual(['Claude Sonnet 4', 'GPT-4o'])
    expect(wrapper.find('[data-testid="scoped-empty"]').exists()).toBe(false)

    // 触发第二行（openai/gpt-4o）上移
    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    await rows[1].find('[data-testid="scoped-move-up"]').trigger('click')
    await flushPromises()

    // RPC 收到交换后的完整有序数组（乐观更新直传 store 值）
    expect(configMock.setScopedModels).toHaveBeenCalledTimes(1)
    expect(configMock.setScopedModels).toHaveBeenCalledWith(['openai/gpt-4o', 'anthropic/claude-sonnet-4'])
  })

  it('A6: scoped 操作 RPC 失败 → 回滚 + 常驻 inline error 可见（非静默）', async () => {
    const store = getSettingsStore()
    store.providers.value = PROVIDERS
    store.scopedModels.value = ['anthropic/claude-sonnet-4', 'openai/gpt-4o']
    configMock.setScopedModels.mockClear()
    configMock.setScopedModels.mockRejectedValueOnce(new Error('rpc down'))

    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    await rows[1].find('[data-testid="scoped-move-up"]').trigger('click')
    await flushPromises()

    // 常驻 inline error 区域显示错误信息
    const err = wrapper.find('[data-testid="provider-action-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('rpc down')
    // 乐观顺序已回滚
    const names = wrapper.findAll('[data-testid="scoped-model-name"]')
    expect(names.map((n) => n.text())).toEqual(['Claude Sonnet 4', 'GPT-4o'])
  })

  it('A6: 连点两次下移 → in-flight 期间第二次被忽略（防重入守卫，单次 RPC）', async () => {
    const store = getSettingsStore()
    store.providers.value = PROVIDERS
    // 3 项列表：同一元素（首行）连点两次 down，第二次时该行已处 idx1、down 本有效
    store.scopedModels.value = ['anthropic/claude-sonnet-4', 'anthropic/claude-opus-4', 'openai/gpt-4o']
    configMock.setScopedModels.mockClear()
    // 第一次 RPC 挂起（deferred），锁定 in-flight 窗口
    let resolveRpc: (v: string[]) => void = () => {}
    configMock.setScopedModels.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { resolveRpc = resolve }),
    )

    wrapper = mount(ProviderPage, {
      props: { providers: PROVIDERS },
      attachTo: document.body,
    })
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="scoped-row"]')
    const downBtn = rows[0].find('[data-testid="scoped-move-down"]')
    await downBtn.trigger('click') // claude-sonnet-4 idx0 → idx1（RPC pending，模块级 busy 置位）
    await downBtn.trigger('click') // 连点：无守卫会以含乐观值的快照二次 RPC；守卫 → 忽略
    resolveRpc(['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'openai/gpt-4o'])
    await flushPromises()

    // 仅第一次触发到达 RPC
    expect(configMock.setScopedModels).toHaveBeenCalledTimes(1)
    expect(configMock.setScopedModels).toHaveBeenCalledWith(['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'openai/gpt-4o'])
  })
})
