/**
 * ProviderPage 测试合并产物（round5-h colocated 收尾，同被测对象 ProviderPage.vue 两来源节）。
 *
 * 来源（本目录，各包基名 describe，节内 hook/helper 随节下沉）：
 *   - ProviderPage.test.ts（TC1 toggle 走 wave3 RPC / TC4 渲染 gate / TC5 删除按钮收窄 /
 *     P2 默认 pill 与自动修复 toast / B-1 编辑体 OAuth 接线 / quotaAutoEnabled toast）
 *   - ProviderPage-plugin.test.ts（插件来源条目：S1 三来源菜单 / S5 负面 / S6 两区边界 /
 *     S17 状态展示与补齐 / 条目动作 / S15② 清单不可达兜底识别）
 *
 * 合并纪律：两文件对 '@/api' 的 mock 工厂同形（() => ({ config: configMock })），合并为
 * 单份 configMock（取主节版本，onAuthSuccess 带显式 handler 签名供 B-1 用例
 * mockImplementation 依赖）；两节各自的 mountPage/wrapper/beforeEach/afterEach 留在节内
 * describe 作用域（同名不同实现互不可见）。ProviderPage-import.spec.ts 因 '@/api' mock
 * 工厂与本簇不同，保持独立文件（同 spec 不同工厂互斥）。
 *
 * mock 策略：
 *   - vi.mock('@/api') 仅替 config 门面（toggleProviderEnabled/removeProviderByKind/
 *     listBuiltinProviders + auth 事件订阅）；plugin 域不经门面 mock——[C3] 插件来源
 *     通道经 provideSettingsTransport(makeSettingsTransportStub) seam 注入（节内 beforeEach）
 *   - createPinia + setActivePinia 让 useQuotaStore / settingsStore 正常初始化
 *   - 主节 global.stubs 把 ProviderEditBody / ProviderQuickSetup 等 ui 重组件 stub 掉
 *     （聚焦 ProviderPage 本身行为，子组件端到端验证留手工 TC4/TC5）；
 *     ConfirmDialog/OAuthDialog stub 掉避免 Teleport 污染 body
 *   - plugin 节 ViewHost 数据源经 VIEW_HOST_SOURCE_KEY 注入内存表；PluginProviderFlow
 *     以探针 stub 记录 open/focus（流程内部行为由 PluginProviderFlow.test.ts 覆盖）
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=settings npx vitest run src/components/settings/provider/__tests__/ProviderPage.test.ts（本文件登记在 domain-map.json settings 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ProviderInfo } from '@taiji/shared'
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import type { PluginEventPayload, PluginListAvailableReply } from '@taiji/shared'
import { VIEW_HOST_SOURCE_KEY, type ViewCacheEntry, type ViewHostSource } from '@taiji/ui/extension-host'
import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import {
  _resetPluginProviderSourceForTest,
  CREDENTIAL_STATUS_CHANNEL,
} from '@/components/settings/provider/PluginProviderSource'
import { Switch } from '@/components/ui/switch'
import { getSettingsStore, provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '@/__tests__/helpers/settings-transport-stub'
import { useToast } from '@/composables/useToast'

// ── mock 面（文件顶；工厂引用的 hoisted 变量与工厂同作用域）─────────────────

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
  setProvider: vi.fn(() => Promise.resolve({})),
  // QuickSetup 打开链（onTemplateSelect → oauth.checkEnv → config.checkEnvVars）
  checkEnvVars: vi.fn(() => Promise.resolve({})),
  oauthLogin: vi.fn(() => Promise.resolve({ started: false })),
  oauthCancel: vi.fn(() => Promise.resolve({ cancelled: false })),
  oauthLogout: vi.fn(() => Promise.resolve({ ok: true })),
  hasOAuth: vi.fn(() => Promise.resolve(false)),
  // 防止 useProviderOAuth onMounted 订阅 4 个 auth.* 事件缺方法报错；
  // onAuthSuccess 显式 handler 签名（B-1 用例 mockImplementation 依赖；宽字面量与
  // settings 页 harness 的同构段撞 fallow 克隆阈值，此处置异断链）
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn((h: (p: { providerId: string }) => void) => () => {}),
  onAuthError: vi.fn(() => () => {}),
}))

const pluginMock = vi.hoisted(() => ({
  listAvailablePlugins: vi.fn(),
  onPluginEvent: vi.fn(),
  invokePlugin: vi.fn(),
  sendPluginUiEvent: vi.fn(() => Promise.resolve()),
  preparePluginInstall: vi.fn(),
  confirmPluginInstall: vi.fn(),
  cancelPluginInstall: vi.fn(),
}))

vi.mock('@/api', () => ({
  config: configMock,
}))

/* ════════ 来源：ProviderPage.test.ts ════════ */

describe('ProviderPage', () => {
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

  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    configMock.toggleProviderEnabled.mockClear()
    configMock.removeProviderByKind.mockClear()
    configMock.setDefaultModel.mockClear()
    configMock.onDefaultsWithSource.mockClear()
    useToast().toasts.value = []
    // [C3] config 门面调用经 SettingsTransport seam 桩注入（同名直映）
    provideSettingsTransport(makeSettingsTransportStub(configMock))
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
            emits: ['oauthLogin', 'oauthLogout', 'saved', 'cancel'],
            template: `<div data-testid="provider-edit-body-stub">
            <span data-testid="stub-kind">{{ provider?.kind ?? "new" }}</span>
            <span data-testid="stub-oauth-present">{{ oauthPresent === undefined ? 'unknown' : oauthPresent ? 'present' : 'absent' }}</span>
            <button data-testid="stub-oauth-login-btn" @click="$emit('oauthLogin')">login</button>
            <button data-testid="stub-oauth-logout-btn" @click="$emit('oauthLogout')">logout</button>
            <button data-testid="stub-saved-quota-on-btn" @click="$emit('saved', { wroteApiKey: false, quotaAutoEnabled: true })">save-quota-on</button>
            <button data-testid="stub-saved-btn" @click="$emit('saved', { wroteApiKey: false })">save</button>
            <button data-testid="stub-cancel-btn" @click="$emit('cancel')">cancel</button>
          </div>`,
          },
          ProviderImportMenu: { template: '<div />' },
          ProviderTemplatePicker: {
            name: 'ProviderTemplatePicker',
            props: ['providers'],
            emits: ['select', 'custom'],
            template: `<div><button data-testid="stub-template-select-btn" @click="$emit('select', { id: 'zai-coding-cn', name: 'Z.AI Coding CN', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', models: [], envVars: [] })">pick</button></div>`,
          },
          ProviderImportPreviewDialog: { template: '<div />' },
          ProviderQuickSetup: {
            name: 'ProviderQuickSetup',
            props: ['open', 'template', 'oauthAuthorized'],
            emits: ['save', 'cancel', 'oauthLogin'],
            template: `<div><button data-testid="stub-quicksetup-save-btn" @click="$emit('save', { providerId: 'zai-coding-cn', data: { name: 'Z.AI Coding CN', apiKey: 'sk-plain' } })">qs-save</button></div>`,
          },
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

  /** QuickSetup 全流程：挂空 providers 页 → 选模板 → 点 QuickSetup 保存（setProvider reply 由用例预置）。 */
  async function runQuickSetupFlow(): Promise<ReturnType<typeof mount>> {
    wrapper = mountPage([])
    await flushPromises()
    await wrapper.find('[data-testid="stub-template-select-btn"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="stub-quicksetup-save-btn"]').trigger('click')
    await flushPromises()
    return wrapper
  }

  /** 断言当前 toast 队列无 Coding Plan 额度提示（负例单源）。 */
  function expectNoCodingPlanToast(): void {
    expect(useToast().toasts.value.some(t => t.message.includes('Coding Plan'))).toBe(false)
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

    it('展开后 presence 查询未返回前 → 传 unknown（三态，不把未查询当无凭据）', async () => {
      // hasOAuth 挂起（不 resolve）：验证 ProviderPage 传 oauthPresenceStatus 而非 boolean 回退
      configMock.hasOAuth.mockReturnValueOnce(new Promise<boolean>(() => {}))
      wrapper = mountPage([CATALOG_P])
      await flushPromises()

      await wrapper.find('[role="button"][aria-expanded="false"]').trigger('click')
      await nextTick()

      expect(wrapper.find('[data-testid="stub-oauth-present"]').text()).toBe('unknown')
    })

    it('展开 oauthSupported provider → 刷新 OAuth presence（hasOAuth 查询）', async () => {
      wrapper = mountPage([CATALOG_P])
      await flushPromises()

      const nameBtn = wrapper.find('[role="button"][aria-expanded="false"]')
      await nameBtn.trigger('click')
      await flushPromises()

      expect(configMock.hasOAuth).toHaveBeenCalledWith('openai')
      // 查询返回 false → 显式 absent（三态的下游消费面）
      expect(wrapper.find('[data-testid="stub-oauth-present"]').text()).toBe('absent')
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

  // ══ 新增即默认同意：quotaAutoEnabled reply → toast 提示额度显示自动开启 ══════════════

  describe('新增即默认同意：setProvider 返回 quotaAutoEnabled → toast（用户可见 DOM 信号）', () => {
    it('QuickSetup 保存返回 quotaAutoEnabled → info toast 含 provider 名 + Coding Plan 提示', async () => {
      configMock.setProvider.mockResolvedValueOnce({ quotaAutoEnabled: true })
      wrapper = await runQuickSetupFlow()

      expect(configMock.setProvider).toHaveBeenCalledWith('zai-coding-cn', expect.objectContaining({ name: 'Z.AI Coding CN' }))
      const toasts = useToast().toasts.value
      expect(toasts.some(t => t.type === 'info' && t.message.includes('Coding Plan') && t.message.includes('Z.AI Coding CN'))).toBe(true)
    })

    it('QuickSetup 保存无 quotaAutoEnabled（env 占位 key 等）→ 不 toast 额度提示', async () => {
      configMock.setProvider.mockResolvedValueOnce({})
      wrapper = await runQuickSetupFlow()

      expectNoCodingPlanToast()
    })

    it('编辑体 @saved 带 quotaAutoEnabled → info toast 含 provider 名（展开行内保存）', async () => {
      wrapper = mountPage([CUSTOM_P])
      await flushPromises()
      await wrapper.find('[role="button"][aria-expanded="false"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="stub-saved-quota-on-btn"]').trigger('click')
      await flushPromises()

      const toasts = useToast().toasts.value
      expect(toasts.some(t => t.type === 'info' && t.message.includes('Coding Plan') && t.message.includes('My Custom'))).toBe(true)
    })

    it('编辑体 @saved 无 quotaAutoEnabled（编辑既有条目）→ 不 toast 额度提示', async () => {
      wrapper = mountPage([CUSTOM_P])
      await flushPromises()
      await wrapper.find('[role="button"][aria-expanded="false"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="stub-saved-btn"]').trigger('click')
      await flushPromises()
      expectNoCodingPlanToast()
    })

    it('编辑体 @cancel → 收起展开行（表单态随卸载丢弃，onBodyCancel）', async () => {
      wrapper = mountPage([CUSTOM_P])
      await flushPromises()
      await wrapper.find('[role="button"][aria-expanded="false"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(true)

      await wrapper.find('[data-testid="stub-cancel-btn"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="provider-expand-body"]').exists()).toBe(false)
    })
  })
})

/* ════════ 来源：ProviderPage-plugin.test.ts ════════ */

describe('ProviderPage-plugin', () => {
  const DETAIL_EXTRA_MOUNT = 'provider.detail-extra'

  const PLUGIN_ENTRY: PluginListAvailableReply['plugins'][number] = {
    packageName: '@zhushanwen/plugin-wool-trae',
    pluginId: 'wool-trae',
    displayName: 'Trae',
    pluginVersion: '1.3.0',
    family: { id: 'wool-trae', displayName: 'Trae', vendor: '字节', credentialSource: 'ide-extract', modelCount: 12 },
    installed: true,
    installedVersion: '1.2.0',
    updateAvailable: true,
  }

  const PLAIN_ENTRY: PluginListAvailableReply['plugins'][number] = {
    packageName: '@zhushanwen/plugin-other',
    pluginId: 'other-kit',
    displayName: 'Other Kit',
    pluginVersion: '1.0.0',
    installed: true,
  }

  /** 插件来源 provider 条目（凭据与模型由插件写入 models.json 后经 config.providers 帧下发） */
  const PLUGIN_PROVIDER: ProviderInfo = {
    id: 'wool-trae',
    name: 'Trae',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [{ id: 'deepseek-v4.1', name: 'DeepSeek V4.1' }],
    kind: 'custom',
  }

  /** 普通（非插件）provider 条目（S5 对照：无插件标记） */
  const PLAIN_PROVIDER: ProviderInfo = {
    id: 'openai',
    name: 'OpenAI',
    apiKeySet: true,
    status: 'connected',
    enabled: true,
    models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    kind: 'catalog',
  }

  /** 插件流程探针 stub：记录 open/focus（流程内部行为见 PluginProviderFlow.test.ts） */
  const FlowStub = defineComponent({
    name: 'PluginProviderFlow',
    props: {
      open: { type: Boolean, default: false },
      focus: { type: Object, default: undefined },
    },
    emits: ['update:open'],
    template: '<div data-testid="plugin-flow-stub" />',
  })

  const EDIT_BODY_STUB = defineComponent({
    name: 'ProviderEditBody',
    props: ['provider', 'oauthPresent', 'oauthSupported', 'quotaPresets'],
    emits: ['dirtyChange', 'saved', 'cancel', 'oauthLogin', 'oauthLogout'],
    template: '<div data-testid="provider-edit-body-stub" />',
  })

  /** 内存 ViewHost 数据源：detail-extra 挂载位返回插件树（S6 插件区内容） */
  const DETAIL_TREE: GuiComponent[] = [
    { type: 'list-tree', props: { items: [{ label: '消耗系数', value: '0.5x' }] } },
  ]

  /** 扩展区自举拉取 spy（ADR-0155：挂载位首次渲染须能主动拉取） */
  let refreshInScope: ReturnType<typeof vi.fn>

  function makeViewSource(): ViewHostSource {
    refreshInScope = vi.fn()
    return {
      getView: () => undefined,
      getViewIds: () => [],
      getViewInScope: (scope, viewId): ViewCacheEntry | undefined => {
        if (scope.kind !== 'global') return undefined
        if (scope.mountId !== DETAIL_EXTRA_MOUNT || viewId !== DETAIL_EXTRA_MOUNT) return undefined
        if (scope.pluginId !== 'wool-trae') return undefined
        return { viewId, pluginId: scope.pluginId, guiTree: DETAIL_TREE, updatedAt: 1 }
      },
      refreshViewInScope: (...args: Parameters<NonNullable<ViewHostSource['refreshViewInScope']>>) => refreshInScope(...args),
    }
  }

  let wrapper: ReturnType<typeof mount> | null = null
  let eventHandler: ((payload: PluginEventPayload) => void) | null = null

  function mountPage(providers: ProviderInfo[]): ReturnType<typeof mount> {
    return mount(ProviderPage, {
      props: { providers },
      global: {
        provide: { [VIEW_HOST_SOURCE_KEY as symbol]: makeViewSource() },
        stubs: {
          ProviderEditBody: EDIT_BODY_STUB,
          PluginProviderFlow: FlowStub,
          ProviderImportPreviewDialog: true,
          ProviderQuickSetup: true,
          OAuthDialog: true,
        },
      },
      attachTo: document.body,
    })
  }

  /** 展开指定 provider 行（点名称 → 手风琴展开） */
  async function expandRow(id: string): Promise<void> {
    const cards = wrapper!.findAll('[data-testid="provider-card"]')
    const card = cards.find((c) => c.text().includes(id === 'wool-trae' ? 'Trae' : 'OpenAI'))
    expect(card).toBeTruthy()
    await card!.find('span[role="button"]').trigger('click')
    await flushPromises()
    await nextTick()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    _resetPluginProviderSourceForTest()
    eventHandler = null
    pluginMock.listAvailablePlugins.mockReset().mockResolvedValue({ plugins: [PLUGIN_ENTRY, PLAIN_ENTRY] })
    pluginMock.onPluginEvent.mockReset().mockImplementation((h: (payload: PluginEventPayload) => void) => {
      eventHandler = h
      return () => {}
    })
    pluginMock.invokePlugin.mockReset().mockResolvedValue(null)
    // [C3] 插件来源通道经 SettingsTransport seam 注入（不 mock @/api 门面 plugin 域）
    provideSettingsTransport(makeSettingsTransportStub({
      ...configMock,
      listAvailablePlugins: pluginMock.listAvailablePlugins,
      onPluginEvent: pluginMock.onPluginEvent,
      invokePlugin: pluginMock.invokePlugin,
      sendPluginUiEvent: pluginMock.sendPluginUiEvent,
    }))
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  describe('S1：插件 Provider 是第三来源类型', () => {
    it('添加供应商菜单三项并列；点「插件 Provider」打开插件接入流程', async () => {
      wrapper = mountPage([])
      await flushPromises()

      const trigger = document.body.querySelector('[data-testid="provider-template-picker"]') as HTMLElement
      expect(trigger).not.toBeNull()
      trigger.click()
      await flushPromises()

      expect(document.body.querySelector('[data-testid="add-menu-builtin"]')).not.toBeNull()
      expect(document.body.querySelector('[data-testid="add-menu-custom"]')).not.toBeNull()
      const pluginItem = document.body.querySelector('[data-testid="add-menu-plugin"]') as HTMLElement
      expect(pluginItem).not.toBeNull()

      const flow = wrapper.findComponent(FlowStub)
      expect(flow.props('open')).toBe(false)

      pluginItem.click()
      await flushPromises()

      expect(wrapper.findComponent(FlowStub).props('open')).toBe(true)
      expect(wrapper.findComponent(FlowStub).props('focus')).toBeUndefined()
    })
  })

  describe('S5：未上报状态的插件条目无任何失效标记（负面）', () => {
    it('插件条目展开且 getStatus 返回 null → 无状态行；普通 provider 也无状态行', async () => {
      wrapper = mountPage([PLUGIN_PROVIDER, PLAIN_PROVIDER])
      await flushPromises()
      expect(pluginMock.listAvailablePlugins).toHaveBeenCalled()

      await expandRow('wool-trae')

      // 插件条目已识别（badge 可见）
      expect(wrapper.find('[data-testid="provider-plugin-badge"]').exists()).toBe(true)
      // 但未上报 → 状态行零 DOM
      expect(wrapper.find('[data-testid="provider-plugin-status"]').exists()).toBe(false)
      // 状态点保持默认（宿主不推断失效）：行头状态点不带 danger
      expect(wrapper.html()).not.toContain('bg-danger')
    })
  })

  describe('S6：条目两区边界（宿主区 + detail-extra 插件区）', () => {
    it('展开插件条目 → 宿主编辑区与插件渲染区同时存在，插件树渲染在扩展区内', async () => {
      wrapper = mountPage([PLUGIN_PROVIDER])
      await flushPromises()

      await expandRow('wool-trae')

      const expandBody = wrapper.find('[data-testid="provider-expand-body"]')
      expect(expandBody.exists()).toBe(true)
      // 宿主区
      expect(wrapper.find('[data-testid="provider-edit-body-stub"]').exists()).toBe(true)
      // 插件区（分隔 + 挂载位容器）
      const boundary = wrapper.find('[data-testid="provider-detail-extra-boundary"]')
      expect(boundary.exists()).toBe(true)
      // 插件推的真实数据树落在插件区内（两区不重叠）
      expect(boundary.text()).toContain('消耗系数')
      // 首次展开主动拉取（ADR-0155 拉为主：挂载位首次渲染不能只依赖推送）
      expect(refreshInScope).toHaveBeenCalledWith(
        { kind: 'global', mountId: DETAIL_EXTRA_MOUNT, pluginId: 'wool-trae' },
        DETAIL_EXTRA_MOUNT,
      )
      expect(wrapper.find('[data-testid="provider-edit-body-stub"]').text()).not.toContain('消耗系数')
      // 宿主常驻动作（D5 重新授权 + S26 更新插件）
      expect(wrapper.find('[data-testid="provider-reauthorize-btn"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="provider-update-plugin-btn"]').exists()).toBe(true)
    })
  })

  describe('S17：plugin:event 状态展示 + 重展开经 invoke getStatus 补齐', () => {
    it('上报失效 → 状态行显示文案；再报恢复 → 变化；重新展开 → getStatus 再拉一次', async () => {
      pluginMock.invokePlugin.mockResolvedValue({ state: 'invalid', message: '登录态已过期' })
      wrapper = mountPage([PLUGIN_PROVIDER])
      await flushPromises()

      // D5「页进入即拉」：清单到达后对已识别的插件条目拉一次已知状态
      expect(pluginMock.invokePlugin).toHaveBeenCalledWith('wool-trae', 'getStatus', { providerId: 'wool-trae' })
      const callsAfterEnter = pluginMock.invokePlugin.mock.calls.length

      await expandRow('wool-trae')

      // 展开再拉一次（拉为主；状态行渲染依据）+ 驱动扩展区树（getDetail——快照 store
      // 只存插件推送内容，无此驱动扩展区恒空）
      expect(pluginMock.invokePlugin).toHaveBeenCalledTimes(callsAfterEnter + 2)
      expect(pluginMock.invokePlugin).toHaveBeenCalledWith('wool-trae', 'getDetail', {})
      const status = wrapper.find('[data-testid="provider-plugin-status"]')
      expect(status.exists()).toBe(true)
      expect(status.text()).toContain('登录态已过期')

      // plugin:event 增量提示（推补充）：恢复态
      expect(eventHandler).not.toBeNull()
      eventHandler!({
        pluginId: 'wool-trae',
        channel: CREDENTIAL_STATUS_CHANNEL,
        payload: { providerId: 'wool-trae', state: 'valid' },
      })
      await nextTick()

      expect(wrapper.find('[data-testid="provider-plugin-status"]').text()).toContain('凭据可用')

      // 收起再展开 → 再次拉取补齐（推送丢失的收敛路径；getStatus + getDetail 各一次）
      const callsBefore = pluginMock.invokePlugin.mock.calls.length
      await expandRow('wool-trae') // 收起
      await expandRow('wool-trae') // 重新展开
      expect(pluginMock.invokePlugin).toHaveBeenCalledTimes(callsBefore + 2)
    })
  })

  describe('条目动作：重新授权 / 更新插件', () => {
    it('点重新授权 → 流程以 authorize 焦点打开；点更新插件 → 以 update 焦点打开', async () => {
      wrapper = mountPage([PLUGIN_PROVIDER])
      await flushPromises()
      await expandRow('wool-trae')

      await wrapper.find('[data-testid="provider-reauthorize-btn"]').trigger('click')
      await flushPromises()
      let flow = wrapper.findComponent(FlowStub)
      expect(flow.props('open')).toBe(true)
      expect(flow.props('focus')).toEqual({ pluginId: 'wool-trae', intent: 'authorize' })

      // 复位流程开关（父侧 v-model:open 回写）
      flow.vm.$emit('update:open', false)
      await nextTick()

      await wrapper.find('[data-testid="provider-update-plugin-btn"]').trigger('click')
      await flushPromises()
      flow = wrapper.findComponent(FlowStub)
      expect(flow.props('open')).toBe(true)
      expect(flow.props('focus')).toEqual({ pluginId: 'wool-trae', intent: 'update' })
    })

    it('非插件条目：无扩展区、无插件标记、无宿主动作', async () => {
      wrapper = mountPage([PLAIN_PROVIDER])
      await flushPromises()
      await expandRow('openai')

      expect(wrapper.find('[data-testid="provider-edit-body-stub"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="provider-plugin-badge"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="provider-detail-extra-boundary"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="provider-reauthorize-btn"]').exists()).toBe(false)
    })
  })

  describe('S15② 清单不可达：已装条目经 namespace 兜底识别（清单外第二识别源，F1-26）', () => {
    it('available=false 本地回退条目（无 family、带 namespace）→ 插件徽标 / 重新授权 / 扩展区可见', async () => {
      // 上线首日形态（R-3：v2-plugins.json 未发布 GitHub main，清单恒走无缓存失败分支）：
      // runtime 返回本地已装条目回退（installed=true + namespace），条目识别不依赖清单家族元数据
      pluginMock.listAvailablePlugins.mockResolvedValue({
        plugins: [
          {
            packageName: '@zhushanwen/plugin-wool-trae',
            pluginId: 'wool-trae',
            displayName: 'Trae',
            pluginVersion: '1.2.0',
            namespace: 'wool-trae',
            installed: true,
            installedVersion: '1.2.0',
          },
        ],
        available: false,
        stale: false,
        reason: 'network',
      })
      wrapper = mountPage([PLUGIN_PROVIDER])
      await flushPromises()
      await expandRow('wool-trae')

      expect(wrapper.find('[data-testid="provider-plugin-badge"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="provider-detail-extra-boundary"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="provider-reauthorize-btn"]').exists()).toBe(true)
      // 清单不可达 → 无清单版本基线，更新入口缺省（不猜测），重新授权常驻（D5）
      expect(wrapper.find('[data-testid="provider-update-plugin-btn"]').exists()).toBe(false)

      // 重新授权入口可用：带 focus 打开插件流程
      await wrapper.find('[data-testid="provider-reauthorize-btn"]').trigger('click')
      await flushPromises()
      const flow = wrapper.findComponent(FlowStub)
      expect(flow.props('open')).toBe(true)
      expect(flow.props('focus')).toEqual({ pluginId: 'wool-trae', intent: 'authorize' })
    })
  })
})
