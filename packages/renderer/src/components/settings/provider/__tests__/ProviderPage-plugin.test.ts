/**
 * ProviderPage 插件来源条目测试（provider-plugin-access U6 / D1 / D2 / D5 / D10）。
 *
 * 覆盖验收项（任务书 u-provider-page）：
 *  - S1：添加供应商菜单三项并列（内置模板 / 自定义 / 插件 Provider），选第三项打开插件流程
 *  - S5：插件未上报状态 → 条目内无任何失效标记（负面断言，宿主不猜测）
 *  - S6：条目两区边界——宿主区（ProviderEditBody）+ detail-extra 插件渲染区
 *  - S17：plugin:event 状态上报 → 状态点与文案变化；重新展开 → invoke getStatus 拉取补齐
 *  - 条目动作：重新授权 / 更新插件 → 打开插件流程并带 focus（直达目标段）
 *
 * mock 策略：插件来源通道经 provideSettingsTransport(makeSettingsTransportStub) seam
 * 注入（[C3] 禁直连门面——不 mock @/api 门面 plugin 域，见 :190 行内注释）；
 * vi.mock('@/api') 仅替 config 域（供非 seam 消费方）；ViewHost 数据源经
 * VIEW_HOST_SOURCE_KEY 注入内存表；PluginProviderFlow 以探针 stub 记录 open/focus
 * （流程内部行为由 PluginProviderFlow.test.ts 覆盖）。ProviderTemplatePicker 走真实组件
 * （S1 菜单断言对象）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/provider
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import type { PluginEventPayload, PluginListAvailableReply, ProviderInfo } from '@taiji/shared'
import { VIEW_HOST_SOURCE_KEY, type ViewCacheEntry, type ViewHostSource } from '@taiji/ui/extension-host'

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

const pluginMock = vi.hoisted(() => ({
  listAvailablePlugins: vi.fn(),
  onPluginEvent: vi.fn(),
  invokePlugin: vi.fn(),
  sendPluginUiEvent: vi.fn(() => Promise.resolve()),
  preparePluginInstall: vi.fn(),
  confirmPluginInstall: vi.fn(),
  cancelPluginInstall: vi.fn(),
}))

const configMock = vi.hoisted(() => ({
  listBuiltinProviders: vi.fn(() => Promise.resolve([])),
  refreshProviderCatalogs: vi.fn(() => Promise.resolve({ refreshed: [], failed: [] })),
  toggleProviderEnabled: vi.fn(() => Promise.resolve()),
  removeProviderByKind: vi.fn(() => Promise.resolve()),
  setDefaultModel: vi.fn(() => Promise.resolve()),
  onDefaultsWithSource: vi.fn(() => () => {}),
  setProvider: vi.fn(() => Promise.resolve({})),
  checkEnvVars: vi.fn(() => Promise.resolve({})),
  oauthLogin: vi.fn(() => Promise.resolve({ started: false })),
  oauthCancel: vi.fn(() => Promise.resolve({ cancelled: false })),
  oauthLogout: vi.fn(() => Promise.resolve({ ok: true })),
  hasOAuth: vi.fn(() => Promise.resolve(false)),
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
}))

vi.mock('@/api', () => ({
  config: configMock,
}))

import ProviderPage from '@/components/settings/provider/ProviderPage.vue'
import {
  _resetPluginProviderSourceForTest,
  CREDENTIAL_STATUS_CHANNEL,
} from '@/components/settings/provider/PluginProviderSource'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '@/__tests__/helpers/settings-transport-stub'

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
