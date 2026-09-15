/**
 * ProviderPage wave4 测试（provider-dual-system-r2::provider-ui-by-kind）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/beforeEach/afterEach/vi，禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/provider/__tests__/ProviderPage.test.ts
 *
 * 覆盖 design TC1/TC4/TC5：
 *   - TC1（unit）：onToggleEnabled 走 config.toggleProviderEnabled（wave3 RPC），不再 setProvider({enabled})。
 *   - TC4 渲染 gate（manual 的自动化补充）：catalog provider 卡片渲染 + 展开编辑体存在 + kind 透传给 ProviderEditBody。
 *   - TC5（manual 的自动化补充）：删除按钮 testid/title 按差异收窄（catalog=移除/custom=删除）+ 确认弹窗文案。
 *
 * mock 策略（对齐 ProviderPage-import.spec.ts）：
 *   - vi.mock('@/api') 把 config 门面替成可控 mock（toggleProviderEnabled/removeProviderByKind/listBuiltinProviders + auth 事件订阅）
 *   - createPinia + setActivePinia 让 useQuotaStore / settingsStore 正常初始化
 *   - global.stubs 把 ProviderEditBody / ProviderQuickSetup 等 ui 包重组件 stub 掉，避免触发 useProviderEdit /
 *     useProviderOAuth 等重组件依赖（聚焦 ProviderPage 本身行为，子组件端到端验证留手工 TC4/TC5）
 *   - ConfirmDialog/OAuthDialog stub 掉避免 Teleport 污染 body
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@taiji/shared'

/** catalog provider fixture（wave2 聚合层已标 kind='catalog'） */
const CATALOG_P: ProviderInfo = {
  id: 'openai',
  name: 'OpenAI',
  apiKeySet: true,
  status: 'connected',
  enabled: true,
  models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
  kind: 'catalog',
  hasOverride: false,
}

/** custom provider fixture */
const CUSTOM_P: ProviderInfo = {
  id: 'my-custom',
  name: 'My Custom',
  apiKeySet: true,
  status: 'connected',
  enabled: true,
  models: [{ id: 'custom-model', name: 'Custom Model' }],
  kind: 'custom',
}

/** mock config 门面：toggleProviderEnabled / removeProviderByKind / listBuiltinProviders + auth 事件订阅 */
const configMock = vi.hoisted(() => ({
  listBuiltinProviders: vi.fn(() => Promise.resolve([])),
  // ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
  refreshProviderCatalogs: vi.fn(() => Promise.resolve({ refreshed: [], failed: [] })),
  toggleProviderEnabled: vi.fn(() => Promise.resolve()),
  removeProviderByKind: vi.fn(() => Promise.resolve()),
  // P2：默认 pill 设置默认模型 + 默认修复 toast 订阅
  setDefaultModel: vi.fn(() => Promise.resolve()),
  onDefaultsWithSource: vi.fn(() => () => {}),
  // B-1 编辑体 OAuth 接线：登录 flow + presence 查询 + authMethod 持久化
  setProvider: vi.fn(() => Promise.resolve()),
  oauthLogin: vi.fn(() => Promise.resolve({ started: false })),
  oauthCancel: vi.fn(() => Promise.resolve({ cancelled: false })),
  oauthLogout: vi.fn(() => Promise.resolve({ ok: true })),
  hasOAuth: vi.fn(() => Promise.resolve(false)),
  // 防止 useProviderOAuth onMounted 订阅 4 个 auth.* 事件缺方法报错
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
}))

vi.mock('@/api', () => ({
  config: configMock,
}))

import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import { Switch } from '@/components/ui/switch'
import { getSettingsStore } from '@taiji/core'
import { useToast } from '@/composables/useToast'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  configMock.toggleProviderEnabled.mockClear()
  configMock.removeProviderByKind.mockClear()
  configMock.setDefaultModel.mockClear()
  configMock.onDefaultsWithSource.mockClear()
  useToast().toasts.value = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** mount 辅助：providers + 全局 stub 掉 ui 重组件 + ConfirmDialog（避免 Teleport 污染） */
function mountPage(providers: ProviderInfo[]): ReturnType<typeof mount> {
  return mount(ProviderPage, {
    props: { providers },
    global: {
      stubs: {
        // ProviderEditBody stub：捕获 provider prop（验证 kind/oauth 接线透传），渲染标记 testid
        ProviderEditBody: {
          name: 'ProviderEditBody',
          props: ['provider', 'oauthPresent', 'oauthSupported'],
          emits: ['oauthLogin', 'oauthLogout'],
          template: `<div data-testid="provider-edit-body-stub">
            <span data-testid="stub-kind">{{ provider?.kind ?? "new" }}</span>
            <span data-testid="stub-oauth-present">{{ oauthPresent ? 'present' : 'absent' }}</span>
            <button data-testid="stub-oauth-login-btn" @click="$emit('oauthLogin')">login</button>
            <button data-testid="stub-oauth-logout-btn" @click="$emit('oauthLogout')">logout</button>
          </div>`,
        },
        ProviderImportMenu: { template: '<div />' },
        ProviderTemplatePicker: { template: '<div />' },
        ProviderImportPreviewDialog: { template: '<div />' },
        ProviderQuickSetup: { template: '<div />' },
        OAuthDialog: { template: '<div />' },
        ConfirmDialog: {
          name: 'ConfirmDialog',
          props: ['open', 'title', 'description', 'confirmText', 'cancelText', 'variant', 'loading'],
          emits: ['update:open', 'confirm'],
          template: '<div v-if="open" data-testid="confirm-dialog-stub"><span data-testid="dialog-title">{{ title }}</span><button data-testid="dialog-confirm" @click="$emit(\'confirm\')">ok</button></div>',
        },
      },
    },
  })
}

/** 找到指定 provider id 的 Switch 组件并触发 update:modelValue */
function emitToggle(providerId: string, enabled: boolean): void {
  const propsProviders = wrapper!.props('providers') as ProviderInfo[]
  const realIdx = propsProviders.findIndex(p => p.id === providerId)
  expect(realIdx).toBeGreaterThan(-1)
  const switches = wrapper!.findAllComponents(Switch)
  // Switch 按 renderList 顺序与 props.providers 对齐（NEW_ID 合成行无 Switch——v-if p.id !== NEW_ID）。
  // 非 NEW_ID 态下 renderList === props.providers，索引一致。
  expect(switches[realIdx]).toBeTruthy()
  void switches[realIdx].vm.$emit('update:modelValue', enabled)
}

// ══ TC1: onToggleEnabled 走 config.toggleProviderEnabled（wave3 RPC） ══════════════════

describe('TC1: onToggleEnabled 走 config.toggleProviderEnabled（不再 setProvider({enabled})）', () => {
  it('Switch toggle off → 调 config.toggleProviderEnabled(id, false)', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    emitToggle('openai', false)
    await flushPromises()

    expect(configMock.toggleProviderEnabled).toHaveBeenCalledWith('openai', false)
    expect(configMock.toggleProviderEnabled).toHaveBeenCalledTimes(1)
  })

  it('Switch toggle on → 调 config.toggleProviderEnabled(id, true)', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    emitToggle('openai', true)
    await flushPromises()

    expect(configMock.toggleProviderEnabled).toHaveBeenCalledWith('openai', true)
  })

  it('渲染 gate：provider-card + Switch 存在于 DOM（非纯内部断言）', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-card"]').exists()).toBe(true)
    expect(wrapper.findComponent(Switch).exists()).toBe(true)
  })

  it('防双击：toggling 中的 provider 再次 toggle 不重复调 RPC', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    // 第一次 toggle（同步进入 toggling 集合）
    emitToggle('openai', false)
    emitToggle('openai', true) // toggling.has('openai') === true，直接 return
    await flushPromises()

    expect(configMock.toggleProviderEnabled).toHaveBeenCalledTimes(1)
  })
})

// ══ TC4 渲染 gate: catalog provider 卡片 + 展开编辑体 + kind 透传 ══════════════════════

describe('TC4 渲染 gate: catalog provider 展开 → ProviderEditBody 收到 kind（透传供其收窄 models 编辑区）', () => {
  it('catalog provider 卡片渲染（含 Switch / 删除按钮 / models 计数）', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    const card = wrapper.find('[data-testid="provider-card"]')
    expect(card.exists()).toBe(true)
    expect(card.findComponent(Switch).exists()).toBe(true)
    // models 计数渲染（1 模型）
    expect(card.text()).toContain('1')
  })

  it('点击 provider 名称展开 → provider-expand-body 渲染 + ProviderEditBody 收到 kind="catalog"', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    // 点击名称触发 toggleExpand（role=button 的 span）
    const nameBtn = wrapper.find('[role="button"][aria-expanded="false"]')
    expect(nameBtn.exists()).toBe(true)
    await nameBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)
    // stub 渲染了 provider.kind（catalog）
    expect(wrapper.find('[data-testid="stub-kind"]').text()).toBe('catalog')
  })
})

// ══ TC5: 删除/移除按钮 testid/title + 确认弹窗文案按差异收窄 ════════════════════════════

describe('TC5: 删除/移除按钮 + 确认弹窗文案按 ProviderInfo.kind 收窄', () => {
  it('catalog provider → 删除按钮 testid=provider-remove-btn + title=移除', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    const removeBtn = wrapper.find('[data-testid="provider-remove-btn"]')
    expect(removeBtn.exists()).toBe(true)
    expect(removeBtn.attributes('title')).toBe('移除供应商')
    // custom 的 delete-btn 不应存在
    expect(wrapper.find('[data-testid="provider-delete-btn"]').exists()).toBe(false)
  })

  it('custom provider → 删除按钮 testid=provider-delete-btn + title=删除', async () => {
    wrapper = mountPage([CUSTOM_P])
    await flushPromises()

    const deleteBtn = wrapper.find('[data-testid="provider-delete-btn"]')
    expect(deleteBtn.exists()).toBe(true)
    expect(deleteBtn.attributes('title')).toBe('删除供应商')
    expect(wrapper.find('[data-testid="provider-remove-btn"]').exists()).toBe(false)
  })

  it('catalog 点击删除按钮 → 弹窗渲染移除文案', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-remove-btn"]').trigger('click')
    await flushPromises()

    const dialog = wrapper.find('[data-testid="confirm-dialog-stub"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.find('[data-testid="dialog-title"]').text()).toContain('移除')
  })

  it('custom 点击删除按钮 → 弹窗渲染删除文案', async () => {
    wrapper = mountPage([CUSTOM_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-delete-btn"]').trigger('click')
    await flushPromises()

    const dialog = wrapper.find('[data-testid="confirm-dialog-stub"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.find('[data-testid="dialog-title"]').text()).toContain('删除')
  })

  it('catalog 弹窗确认 → 调 removeProviderByKind(id, "catalog")', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-remove-btn"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(configMock.removeProviderByKind).toHaveBeenCalledWith('openai', 'catalog')
  })

  it('custom 弹窗确认 → 调 removeProviderByKind(id, "custom")', async () => {
    wrapper = mountPage([CUSTOM_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-delete-btn"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(configMock.removeProviderByKind).toHaveBeenCalledWith('my-custom', 'custom')
  })
})

// ══ P2: 默认 pill 可点击 → 弹模型选择 → setDefaultModel ═══════════════════════════

describe('P2: 默认 pill 可点击设默认模型（provider-default-pill）', () => {
  const MODELS = [
    { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai', providerName: 'OpenAI', enabled: true },
    { id: 'gpt-5', name: 'GPT-5', providerId: 'openai', providerName: 'OpenAI', enabled: true },
  ]

  it('默认 provider 行渲染可点击 pill（DOM 断言）', async () => {
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    const pill = wrapper.find('[data-testid="provider-default-pill"]')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain('默认供应商')
  })

  it('非默认 provider 行不渲染 pill', async () => {
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    wrapper = mountPage([CUSTOM_P])
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-default-pill"]').exists()).toBe(false)
  })

  it('点击 pill → 弹模型选择（仅当前 provider 模型）→ 点击模型 → config.setDefaultModel 被调', async () => {
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    getSettingsStore().models.value = MODELS
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    // pill 可点击：点击触发 popover 展开（reka Popover，内容 teleport 到 body）
    const pill = wrapper.find('[data-testid="provider-default-pill"]')
    expect(pill.attributes('title')).toBe('切换模型')
    await pill.trigger('click')
    await flushPromises()

    // 模型列表出现（providerFilter 限定当前 provider：openai 的两个模型）
    const bodyItems = Array.from(document.body.querySelectorAll('button')).map(b => b.textContent ?? '')
    expect(bodyItems.some(t => t.includes('GPT-4o'))).toBe(true)
    expect(bodyItems.some(t => t.includes('GPT-5'))).toBe(true)

    // 点击 GPT-5 → setDefaultModel('openai', 'gpt-5')
    const gpt5 = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.includes('GPT-5')) as HTMLButtonElement
    gpt5.click()
    await flushPromises()

    expect(configMock.setDefaultModel).toHaveBeenCalledTimes(1)
    expect(configMock.setDefaultModel).toHaveBeenCalledWith('openai', 'gpt-5')
  })

  it('setDefaultModel 失败 → actionError 常驻 error 区域可见', async () => {
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    getSettingsStore().models.value = MODELS
    configMock.setDefaultModel.mockRejectedValueOnce(new Error('设默认失败'))
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    await wrapper.find('[data-testid="provider-default-pill"]').trigger('click')
    await flushPromises()
    const gpt5 = Array.from(document.body.querySelectorAll('button')).find(b => b.textContent?.includes('GPT-5')) as HTMLButtonElement
    gpt5.click()
    await flushPromises()

    expect(wrapper.find('[data-testid="provider-action-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="provider-action-error"]').text()).toContain('设默认失败')
  })
})

// ══ P2: 默认模型自动修复 toast（provider 变更广播） ═══════════════════════════════

describe('P2: provider 变更后默认模型自动修复 → toast 提示', () => {
  it('导入/保存凭据后 runtime 广播默认修复（值变化）→ info toast 含模型', async () => {
    let defaultsHandler: ((p: { defaultModel: string; source?: string }) => void) | null = null
    configMock.onDefaultsWithSource.mockImplementation((h: (p: { defaultModel: string; source?: string }) => void) => {
      defaultsHandler = h
      return () => {}
    })
    getSettingsStore().defaultModel.value = ''
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    // 模拟 runtime 在凭据导入/保存后自动修复默认模型的 config.defaults 广播
    defaultsHandler!({ defaultModel: 'openai/gpt-4o', source: 'provider-updated' })
    await flushPromises()

    const toasts = useToast().toasts.value
    expect(toasts.some(t => t.type === 'info' && t.message.includes('默认模型已自动更新为 openai/gpt-4o'))).toBe(true)
  })

  it('默认模型未变化（值相同）→ 不 toast（避免 toggle 非默认 provider 误报）', async () => {
    let defaultsHandler: ((p: { defaultModel: string; source?: string }) => void) | null = null
    configMock.onDefaultsWithSource.mockImplementation((h: (p: { defaultModel: string; source?: string }) => void) => {
      defaultsHandler = h
      return () => {}
    })
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    defaultsHandler!({ defaultModel: 'openai/gpt-4o', source: 'provider-updated' })
    await flushPromises()

    expect(useToast().toasts.value).toHaveLength(0)
  })

  it('用户主动设置（source=default-set）→ 不 toast', async () => {
    let defaultsHandler: ((p: { defaultModel: string; source?: string }) => void) | null = null
    configMock.onDefaultsWithSource.mockImplementation((h: (p: { defaultModel: string; source?: string }) => void) => {
      defaultsHandler = h
      return () => {}
    })
    getSettingsStore().defaultModel.value = 'openai/gpt-4o'
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    defaultsHandler!({ defaultModel: 'openai/gpt-5', source: 'default-set' })
    await flushPromises()

    expect(useToast().toasts.value).toHaveLength(0)
  })
})

// ══ B-1: 编辑体 OAuth 接线（共享单实例 useProviderOAuth，无第二套 listener） ═══════════

/**
 * 覆盖 Phase B B-1 的 ProviderPage 侧接线：
 *  - 展开时刷新 OAuth presence（hasOAuth 查询，oauthSupported provider）
 *  - 编辑体 @oauth-login → oauth.login（config.oauthLogin RPC）
 *  - auth.success（编辑体来源）→ setProvider 持久化 authMethod='oauth' + presence 刷新
 * ProviderEditBody stub 只发事件（组件内部行为在 provider-edit-body-phase-b.test.ts 覆盖）。
 */
describe('B-1: 编辑体凭证区 OAuth 事件接线', () => {
  /** oauthSupported 模板（builtinProviders 命中 openai） */
  const OAUTH_TPL = {
    id: 'openai',
    name: 'OpenAI',
    authMode: 'both',
    envVars: ['OPENAI_API_KEY'],
    oauthSupported: true,
    modelCount: 1,
    models: [],
  }

  beforeEach(() => {
    configMock.listBuiltinProviders.mockReset()
    configMock.listBuiltinProviders.mockReturnValue(Promise.resolve([OAUTH_TPL]))
    configMock.setProvider.mockClear()
    configMock.oauthLogin.mockClear()
    configMock.hasOAuth.mockClear()
    configMock.onAuthSuccess.mockClear()
  })

  it('展开 oauthSupported provider → 刷新 OAuth presence（hasOAuth 查询）', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    const nameBtn = wrapper.find('[role="button"][aria-expanded="false"]')
    await nameBtn.trigger('click')
    await flushPromises()

    expect(configMock.hasOAuth).toHaveBeenCalledWith('openai')
  })

  it('编辑体 @oauth-login → oauth.login 启动 flow；auth.success → setProvider 持久化 authMethod=oauth', async () => {
    // 捕获 auth.success 订阅 handler（模拟 runtime 广播授权成功）
    let authSuccessHandler: ((p: { providerId: string }) => void) | null = null
    configMock.onAuthSuccess.mockImplementation((h: (p: { providerId: string }) => void) => {
      authSuccessHandler = h
      return () => {}
    })
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    // 展开编辑体 → 点登录按钮（stub emit oauthLogin）
    const nameBtn = wrapper.find('[role="button"][aria-expanded="false"]')
    await nameBtn.trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="stub-oauth-login-btn"]').trigger('click')
    await flushPromises()

    expect(configMock.oauthLogin).toHaveBeenCalledWith('openai')

    // 模拟 auth.success（token 已写 auth.json）→ 持久化 authMethod + presence 刷新
    authSuccessHandler!({ providerId: 'openai' })
    await flushPromises()

    // 防线⑤：OAuth 收尾只发 authMethod（不随行 name/type/baseUrl 快照 artifact）
    expect(configMock.setProvider).toHaveBeenCalledTimes(1)
    expect(configMock.setProvider).toHaveBeenCalledWith('openai', { authMethod: 'oauth' })
    const oauthPayload = configMock.setProvider.mock.calls[0]![1] as Record<string, unknown>
    expect(Object.keys(oauthPayload)).toEqual(['authMethod'])
    // presence 刷新（authMethod 切 oauth 后 hasOAuth 至少再查一次）
    expect(configMock.hasOAuth.mock.calls.filter((c) => c[0] === 'openai').length).toBeGreaterThanOrEqual(2)
  })

  it('编辑体 @oauth-logout（B-1 场景 C）→ config.oauthLogout 移除凭证 + presence 刷新（hasOAuth 重查）', async () => {
    wrapper = mountPage([CATALOG_P])
    await flushPromises()
    configMock.oauthLogout.mockClear()
    configMock.hasOAuth.mockClear()

    // 展开编辑体 → 点退出登录按钮（stub emit oauthLogout）
    const nameBtn = wrapper.find('[role="button"][aria-expanded="false"]')
    await nameBtn.trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="stub-oauth-logout-btn"]').trigger('click')
    await flushPromises()

    expect(configMock.oauthLogout).toHaveBeenCalledTimes(1)
    expect(configMock.oauthLogout).toHaveBeenCalledWith('openai')
    // presence 刷新（凭证区回「未登录」态的数据源）
    expect(configMock.hasOAuth).toHaveBeenCalledWith('openai')
  })

  it('QuickSetup 来源的 auth.success 不触发 authMethod 持久化（保持 QuickSetup 打开语义）', async () => {
    let authSuccessHandler: ((p: { providerId: string }) => void) | null = null
    configMock.onAuthSuccess.mockImplementation((h: (p: { providerId: string }) => void) => {
      authSuccessHandler = h
      return () => {}
    })
    wrapper = mountPage([CATALOG_P])
    await flushPromises()

    // 未经过编辑体登录（source 默认 quicksetup）→ auth.success 不持久化
    authSuccessHandler!({ providerId: 'openai' })
    await flushPromises()

    expect(configMock.setProvider).not.toHaveBeenCalled()
  })
})
