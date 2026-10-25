/**
 * PluginProviderFlow 测试（provider-plugin-access U6 / D1 / D2 / D3 / D5 / D8）。
 *
 * 覆盖验收项（任务书 u-provider-page）：
 *  - S1：菜单第三来源进入后三张家族卡（名称 / 厂商 / 授权方式 / 模型数）
 *  - S27：安装确认卡提交前全量展示 capabilities / readPaths——清单安装与包名直装两路径各一次
 *  - S7：text-input 输入经 plugin.uiEvent 回传（demo 插件树；值走 (pluginId, viewId, componentId, 'change', value)）
 *  - 取消不落盘：确认停点取消 → cancelPluginInstall（S27「未确认不发生安装落盘」）
 *
 * mock 策略：插件来源通道经 provideSettingsTransport(makeSettingsTransportStub) seam
 * 注入（[C3] 禁直连门面——不 mock @/api）；ViewHost 数据源经
 * VIEW_HOST_SOURCE_KEY 注入内存表（不打运输层）。Dialog 走 Teleport，断言经 document.body。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/settings/provider
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { GuiComponent } from '@zhushanwen/extension-protocol'
import type { PluginCatalogEntry, PluginListAvailableReply } from '@taiji/shared'
import { VIEW_HOST_SOURCE_KEY, type ViewCacheEntry, type ViewHostSource } from '@taiji/ui/extension-host'

const PLUGIN_AUTHORIZE_VIEW = 'provider.authorize'

const FAMILIES: PluginListAvailableReply['plugins'] = [
  {
    packageName: '@zhushanwen/plugin-wool-workbuddy',
    pluginId: 'wool-workbuddy',
    displayName: 'WorkBuddy',
    pluginVersion: '1.2.0',
    family: { id: 'wool-workbuddy', displayName: 'WorkBuddy', vendor: '腾讯', credentialSource: 'oauth', modelCount: 17 },
    capabilities: ['network.http', 'crypto'],
    readPaths: ['Library/Application Support/WorkBuddy'],
    installed: false,
  },
  {
    packageName: '@zhushanwen/plugin-wool-trae',
    pluginId: 'wool-trae',
    displayName: 'Trae',
    pluginVersion: '1.2.0',
    family: { id: 'wool-trae', displayName: 'Trae', vendor: '字节', credentialSource: 'ide-extract', modelCount: 12 },
    installed: true,
  },
  {
    packageName: '@zhushanwen/plugin-wool-qoder',
    pluginId: 'wool-qoder',
    displayName: 'Qoder',
    pluginVersion: '1.2.0',
    family: { id: 'wool-qoder', displayName: 'Qoder', vendor: '阿里', credentialSource: 'ide-extract', modelCount: 12 },
    installed: false,
  },
]

const pluginMock = vi.hoisted(() => ({
  listAvailablePlugins: vi.fn(),
  listPlugins: vi.fn(),
  togglePlugin: vi.fn(),
  onPluginCrashed: vi.fn(() => () => {}),
  preparePluginInstall: vi.fn(),
  confirmPluginInstall: vi.fn(),
  cancelPluginInstall: vi.fn(),
  clearPluginMountUi: vi.fn(),
  sendPluginUiEvent: vi.fn(),
  invokePlugin: vi.fn(),
  onPluginEvent: vi.fn(() => () => {}),
}))
const clearMountMock = pluginMock.clearPluginMountUi

import PluginProviderFlow from '@/components/settings/provider/PluginProviderFlow.vue'
import { _resetPluginProviderSourceForTest } from '@/components/settings/provider/PluginProviderSource'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '@/__tests__/helpers/settings-transport-stub'

/** 安装确认卡回包（runtime PluginInstallPreview 同构；manifest 即暂存解压物） */
function previewOf(entry: PluginCatalogEntry) {
  return {
    pluginId: entry.pluginId,
    packageName: entry.packageName,
    version: entry.pluginVersion,
    capabilities: entry.capabilities ?? [],
    readPaths: entry.readPaths ?? [],
    permissions: [],
    namespace: entry.family?.id,
  }
}

/** 内存 ViewHost 数据源：按 scope（全局域 mountId + pluginId）返回固定树 */
function makeViewSource(tree: GuiComponent[]): ViewHostSource {
  return {
    getView: () => undefined,
    getViewIds: () => [],
    getViewInScope: (scope, viewId): ViewCacheEntry | undefined => {
      if (scope.kind !== 'global') return undefined
      if (scope.mountId !== PLUGIN_AUTHORIZE_VIEW || viewId !== PLUGIN_AUTHORIZE_VIEW) return undefined
      if (scope.pluginId !== 'wool-trae') return undefined
      return { viewId, pluginId: scope.pluginId, guiTree: tree, updatedAt: 1 }
    },
    refreshViewInScope: vi.fn(),
  }
}

let wrapper: ReturnType<typeof mount> | null = null

function mountFlow(options: { focus?: { pluginId: string; intent: 'authorize' | 'update' }; tree?: GuiComponent[] } = {}) {
  return mount(PluginProviderFlow, {
    props: { open: true, ...(options.focus !== undefined ? { focus: options.focus } : {}) },
    global: {
      provide: {
        [VIEW_HOST_SOURCE_KEY as symbol]: makeViewSource(options.tree ?? []),
      },
    },
    attachTo: document.body,
  })
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`)
}

function queryAll(testId: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll(`[data-testid="${testId}"]`))
}

beforeEach(() => {
  _resetPluginProviderSourceForTest()
  // [C3] 插件来源通道（清单 + 运行态/重启 + 两段式安装）经 SettingsTransport seam 注入
  //（不 mock @/api 门面）
  provideSettingsTransport(makeSettingsTransportStub({
    listAvailablePlugins: pluginMock.listAvailablePlugins,
    listPlugins: pluginMock.listPlugins,
    togglePlugin: pluginMock.togglePlugin,
    onPluginCrashed: pluginMock.onPluginCrashed,
    preparePluginInstall: pluginMock.preparePluginInstall,
    confirmPluginInstall: pluginMock.confirmPluginInstall,
    cancelPluginInstall: pluginMock.cancelPluginInstall,
    clearPluginMountUi: pluginMock.clearPluginMountUi,
    sendPluginUiEvent: pluginMock.sendPluginUiEvent,
    invokePlugin: pluginMock.invokePlugin,
    onPluginEvent: pluginMock.onPluginEvent,
  }))
  pluginMock.listAvailablePlugins.mockReset().mockImplementation(() => Promise.resolve({ plugins: FAMILIES }))
  // 插件运行态中性默认：Trae 已装且正常（家族卡崩溃标记判定源，S13）
  pluginMock.listPlugins.mockReset().mockImplementation(() => Promise.resolve([
    { pluginId: 'wool-trae', version: '1.2.0', displayName: 'Trae', description: '', status: 'active', trustLevel: 'sandbox', enabled: true },
  ]))
  pluginMock.togglePlugin.mockReset().mockResolvedValue([])
  pluginMock.preparePluginInstall.mockReset().mockImplementation((spec: string) => {
    const entry = FAMILIES.find((e) => e.packageName === spec || e.pluginId === spec)
    if (entry === undefined) return Promise.reject(new Error(`unknown package: ${spec}`))
    return Promise.resolve(previewOf(entry))
  })
  pluginMock.confirmPluginInstall.mockReset().mockResolvedValue({ success: true })
  pluginMock.cancelPluginInstall.mockReset().mockResolvedValue(undefined)
  pluginMock.clearPluginMountUi.mockReset().mockResolvedValue(undefined)
  pluginMock.sendPluginUiEvent.mockReset().mockResolvedValue(undefined)
  pluginMock.invokePlugin.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('PluginProviderFlow S1：家族卡（第三来源类型）', () => {
  it('清单三家族 → 三张家族卡（名称/厂商/授权方式/模型数）', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    const cards = queryAll('plugin-family-card')
    expect(cards).toHaveLength(3)
    const texts = cards.map((c) => c.textContent ?? '')
    expect(texts[0]).toContain('WorkBuddy')
    expect(texts[0]).toContain('腾讯')
    expect(texts[0]).toContain('需在浏览器授权')
    expect(texts[0]).toContain('17 个可用模型')
    expect(texts[1]).toContain('Trae')
    expect(texts[1]).toContain('字节')
    expect(texts[1]).toContain('读取本机登录态')
    expect(texts[2]).toContain('Qoder')
    expect(texts[2]).toContain('12 个可用模型')
    // 已安装家族显式徽标（区别于待安装的「需要先安装插件」提示）
    expect(queryAll('plugin-family-installed')).toHaveLength(1)
  })
})

describe('PluginProviderFlow S15 两态（R-2 wire 字段 available/stale 的 UI 消费）', () => {
  it('S15① stale=true → 「清单可能不是最新」提示条 + 重试（缓存清单仍可浏览）', async () => {
    pluginMock.listAvailablePlugins.mockResolvedValue({ plugins: FAMILIES, available: true, stale: true, reason: 'network' })
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    const stale = query('plugin-catalog-stale')
    expect(stale).not.toBeNull()
    expect(stale?.textContent).toContain('清单可能不是最新')
    // 缓存清单照常呈现
    expect(queryAll('plugin-family-card')).toHaveLength(3)
    // 提示条自带重试入口，可再次拉取
    const retryCalls = pluginMock.listAvailablePlugins.mock.calls.length
    query('plugin-catalog-stale-retry')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(pluginMock.listAvailablePlugins.mock.calls.length).toBeGreaterThan(retryCalls)
  })

  it('S15② available=false → 整页报错文案（与「缓存为空」区分）+ 重试', async () => {
    pluginMock.listAvailablePlugins.mockResolvedValue({ plugins: [], available: false, stale: false, reason: 'network' })
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    const error = query('plugin-catalog-error')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('插件清单不可达')
    expect(queryAll('plugin-family-card')).toHaveLength(0)
    expect(query('plugin-catalog-retry')).not.toBeNull()
  })

  it('available=true 且缓存清单为空 → 空态文案（不是报错态——两态可区分）', async () => {
    pluginMock.listAvailablePlugins.mockResolvedValue({ plugins: [], available: true, stale: false })
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    expect(query('plugin-catalog-error')).toBeNull()
    const empty = query('plugin-family-empty')
    expect(empty?.textContent).toContain('清单为空')
  })
})

describe('PluginProviderFlow S27：安装确认卡知情面（两路径）', () => {
  it('清单安装：点家族卡 → 确认卡全量展示 capabilities / readPaths，未确认不提交', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    // 第一张卡 = WorkBuddy（未安装 → 安装段）
    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()

    expect(pluginMock.preparePluginInstall).toHaveBeenCalledWith('@zhushanwen/plugin-wool-workbuddy')
    expect(pluginMock.confirmPluginInstall).not.toHaveBeenCalled()
    expect(query('plugin-install-confirm')).not.toBeNull()
    const caps = query('plugin-confirm-capabilities')
    expect(caps?.textContent).toContain('network.http')
    expect(caps?.textContent).toContain('crypto')
    const paths = query('plugin-confirm-read-paths')
    expect(paths?.textContent).toContain('Library/Application Support/WorkBuddy')
  })

  it('包名直装：输入包名 → 同一确认卡展示该包声明的 capabilities / readPaths', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    const input = query('plugin-direct-spec') as HTMLInputElement
    expect(input).not.toBeNull()
    input.value = '@zhushanwen/plugin-wool-workbuddy'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    query('plugin-direct-install-btn')?.click()
    await flushPromises()
    await nextTick()

    expect(pluginMock.preparePluginInstall).toHaveBeenCalledWith('@zhushanwen/plugin-wool-workbuddy')
    const caps = query('plugin-confirm-capabilities')
    expect(caps?.textContent).toContain('network.http')
    expect(query('plugin-confirm-read-paths')?.textContent).toContain('Library/Application Support/WorkBuddy')

    // 确认提交走同一 chain（confirm 后进入授权挂载位）
    query('plugin-install-confirm-btn')?.click()
    await flushPromises()
    await nextTick()
    expect(pluginMock.confirmPluginInstall).toHaveBeenCalledWith('wool-workbuddy')
    expect(query('plugin-authorize-container')).not.toBeNull()
  })

  it('取消确认停点 → cancelPluginInstall（未确认不发生安装落盘）', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()
    query('plugin-install-cancel')?.click()
    await flushPromises()
    await nextTick()

    expect(pluginMock.cancelPluginInstall).toHaveBeenCalledWith('wool-workbuddy')
    expect(pluginMock.confirmPluginInstall).not.toHaveBeenCalled()
    expect(queryAll('plugin-family-card')).toHaveLength(3)
  })
})

describe('PluginProviderFlow 授权视图渲染驱动（初始树生产者 = 插件 getAuthorizeView）', () => {
  it('focus 直达授权段（重新授权入口）→ invoke getAuthorizeView 驱动插件推初始树', async () => {
    wrapper = mountFlow({ focus: { pluginId: 'wool-trae', intent: 'authorize' } })
    await flushPromises()
    await nextTick()

    expect(query('plugin-authorize-container')).not.toBeNull()
    expect(pluginMock.invokePlugin).toHaveBeenCalledWith('wool-trae', 'getAuthorizeView', {})
  })

  it('家族卡点击已装家族 → 进入授权段并驱动 getAuthorizeView', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    // 第二张卡 = Trae（installed=true → 直接进授权段）
    queryAll('plugin-family-card')[1].click()
    await flushPromises()
    await nextTick()

    expect(query('plugin-authorize-container')).not.toBeNull()
    expect(pluginMock.invokePlugin).toHaveBeenCalledWith('wool-trae', 'getAuthorizeView', {})
  })

  it('安装确认成功 → 进入授权段并驱动 getAuthorizeView（activate 已随确认完成，命令通道就绪）', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    // 第一张卡 = WorkBuddy（未安装 → 安装确认卡）
    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()
    pluginMock.invokePlugin.mockClear()
    query('plugin-install-confirm-btn')?.click()
    await flushPromises()
    await nextTick()

    expect(query('plugin-authorize-container')).not.toBeNull()
    expect(pluginMock.invokePlugin).toHaveBeenCalledWith('wool-workbuddy', 'getAuthorizeView', {})
  })
})

describe('PluginProviderFlow S7：text-input 输入经 uiEvent 回传', () => {
  it('demo 插件树含 text-input → 输入值经 plugin.sendPluginUiEvent 回传（pluginId/viewId/componentId）', async () => {
    const tree: GuiComponent[] = [
      { type: 'text-input', props: { id: 'pat', label: '个人访问令牌' } },
    ]
    wrapper = mountFlow({ focus: { pluginId: 'wool-trae', intent: 'authorize' }, tree })
    await flushPromises()
    await nextTick()

    expect(query('plugin-authorize-container')).not.toBeNull()
    const field = query('gui-text-input-field-pat') as HTMLInputElement | null
    expect(field).not.toBeNull()
    expect(field?.disabled).toBe(false)

    field!.value = 'pat-123'
    field!.dispatchEvent(new Event('input'))
    await flushPromises()

    expect(pluginMock.sendPluginUiEvent).toHaveBeenCalledWith({
      pluginId: 'wool-trae',
      viewId: PLUGIN_AUTHORIZE_VIEW,
      componentId: 'pat',
      event: 'change',
      value: 'pat-123',
    })
    // 输入状态保持（宿主本地镜像，插件回推覆盖）
    expect((query('gui-text-input-field-pat') as HTMLInputElement).value).toBe('pat-123')
  })
})

/** S13 家族卡崩溃态（plugin.list status=crashed → 「插件已停止」+ 重启按钮）*/
function crashedPluginsList() {
  return [
    { pluginId: 'wool-trae', version: '1.2.0', displayName: 'Trae', description: '', status: 'crashed', trustLevel: 'sandbox', enabled: false },
  ]
}

describe('PluginProviderFlow S13：家族卡崩溃态（失败路径表「插件已停止」+ 重启）', () => {
  it('crashed 家族卡显示「插件已停止」标记 + 重启按钮（正常态家族卡零呈现）', async () => {
    pluginMock.listPlugins.mockImplementation(() => Promise.resolve(crashedPluginsList()))
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    const badges = queryAll('plugin-family-crashed-badge')
    const buttons = queryAll('plugin-family-restart-btn')
    expect(badges).toHaveLength(1)
    expect(buttons).toHaveLength(1)
    // 标记挂在 Trae（crashed）那张卡内；WorkBuddy/Qoder 未装未拉到运行态 → 零呈现
    const traeCard = queryAll('plugin-family-card').find((c) => (c.textContent ?? '').includes('Trae'))
    expect(traeCard?.contains(badges[0])).toBe(true)
    expect(traeCard?.contains(buttons[0])).toBe(true)
    expect(badges[0].textContent).toContain('插件已停止')
  })

  it('正常态（active）家族卡不渲染崩溃标记与重启按钮', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    expect(queryAll('plugin-family-crashed-badge')).toHaveLength(0)
    expect(queryAll('plugin-family-restart-btn')).toHaveLength(0)
  })

  it('plugin:crashed 广播增量标记（对话框开着时崩溃实时刷新，丢失由拉取收敛）', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()
    expect(queryAll('plugin-family-crashed-badge')).toHaveLength(0)

    // 取 ensureSubscribed 注册的 crashed handler 直接触发（增量提示链）
    const handler = pluginMock.onPluginCrashed.mock.calls.at(-1)?.[0] as (p: { pluginId: string }) => void
    expect(handler).toBeTypeOf('function')
    handler({ pluginId: 'wool-trae', error: 'Child process exited' })
    await nextTick()

    expect(queryAll('plugin-family-crashed-badge')).toHaveLength(1)
    expect(queryAll('plugin-family-restart-btn')).toHaveLength(1)
  })

  it('点重启 → plugin.toggle off 再 on（顺序序列），完成后以回包刷新家族卡（标记消失）', async () => {
    pluginMock.listPlugins.mockImplementation(() => Promise.resolve(crashedPluginsList()))
    // toggle 回包 = 重启后的最新列表（Trae 回 active）——回包即运行态缓存的刷新源
    pluginMock.togglePlugin.mockImplementation((_pluginId: string, enabled: boolean) =>
      Promise.resolve(enabled
        ? [{ pluginId: 'wool-trae', version: '1.2.0', displayName: 'Trae', description: '', status: 'active', trustLevel: 'sandbox', enabled: true }]
        : crashedPluginsList()))
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()
    expect(queryAll('plugin-family-restart-btn')).toHaveLength(1)

    query('plugin-family-restart-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    await nextTick()

    // off → on 顺序序列（设计失败路径表：plugin.toggle off/on，不自动重激活）
    expect(pluginMock.togglePlugin.mock.calls).toEqual([
      ['wool-trae', false],
      ['wool-trae', true],
    ])
    // 回包 status=active → 家族卡崩溃标记与重启按钮消失
    expect(queryAll('plugin-family-crashed-badge')).toHaveLength(0)
    expect(queryAll('plugin-family-restart-btn')).toHaveLength(0)
  })

  it('重启失败（toggle reject）→ family 段错误条呈现，不静默', async () => {
    pluginMock.listPlugins.mockImplementation(() => Promise.resolve(crashedPluginsList()))
    pluginMock.togglePlugin.mockRejectedValue(new Error('activation timeout'))
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    query('plugin-family-restart-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    await nextTick()

    const error = query('plugin-flow-error')
    expect(error).not.toBeNull()
    expect(error?.textContent).toContain('重启失败')
    // 失败后运行态未变（拉取态仍 crashed）→ 标记保留，可再试
    expect(queryAll('plugin-family-crashed-badge')).toHaveLength(1)
  })
})

describe('PluginProviderFlow U2 裁决①：离开授权段清挂载位快照分区（clearPluginMountUi）', () => {
  it('进入授权段后关闭对话框 → 清授权挂载位（防旧家族树残留进快照恢复源）', async () => {
    wrapper = mountFlow({ focus: { pluginId: 'wool-trae', intent: 'authorize' } })
    await flushPromises()
    await nextTick()
    expect(query('plugin-authorize-container')).not.toBeNull()
    expect(clearMountMock).not.toHaveBeenCalled()

    // Dialog 关闭（emit update:open(false) → watch → resetFlow：离开授权段 = 挂载位退役）
    await wrapper!.setProps({ open: false })
    await flushPromises()

    expect(clearMountMock).toHaveBeenCalledWith('provider.authorize')
  })

  it('未进过授权段（family/confirm 段关闭）→ 不清（挂载位无消费无陈旧）', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    await wrapper!.setProps({ open: false })
    await flushPromises()

    expect(clearMountMock).not.toHaveBeenCalled()
  })
})

describe('PluginProviderFlow focus 直达的分支路径（focus 缺失 / update 意图）', () => {
  it('focus 插件不在清单 → family 段错误条（focusMissing 文案），不进授权段不崩溃', async () => {
    wrapper = mountFlow({ focus: { pluginId: 'gone-plugin', intent: 'authorize' } })
    await flushPromises()
    await nextTick()

    const error = query('plugin-flow-error')
    expect(error?.textContent).toContain('目标插件不在清单中')
    expect(query('plugin-authorize-container')).toBeNull()
    expect(pluginMock.preparePluginInstall).not.toHaveBeenCalled()
  })

  it('focus intent=update（已装家族更新入口）→ 直达确认卡（更新意图文案 + prepare 该包）', async () => {
    wrapper = mountFlow({ focus: { pluginId: 'wool-workbuddy', intent: 'update' } })
    await flushPromises()
    await nextTick()

    expect(pluginMock.preparePluginInstall).toHaveBeenCalledWith('@zhushanwen/plugin-wool-workbuddy')
    const confirm = query('plugin-install-confirm')
    expect(confirm).not.toBeNull()
    expect(confirm?.textContent).toContain('将更新插件')
    expect(confirm?.textContent).toContain('@zhushanwen/plugin-wool-workbuddy')
  })

  it('Dialog 内部关闭请求（update:open）→ 原样上抛（父侧 v-model:open 消费）', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    // reka DialogRoot 的关闭请求（esc / 遮罩 / 关闭钮）→ Dialog 向上 emit → onDialogToggle 透传
    const dialog = wrapper.findComponent({ name: 'Dialog' })
    expect(dialog.exists()).toBe(true)
    dialog.vm.$emit('update:open', false)
    await nextTick()

    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })
})

describe('PluginProviderFlow 失败路径表（prepare/confirm/cancel/清理失败 + 通道未就绪）', () => {
  /** 捕获 console.warn（降级可见性断言用），返回恢复函数 */
  function spyWarn(): MockInstance {
    return vi.spyOn(console, 'warn').mockImplementation(() => {})
  }

  it('prepare reject（下载/校验/NAMESPACE_MISMATCH）→ family 段错误条呈现 message，不进确认卡', async () => {
    pluginMock.preparePluginInstall.mockRejectedValue(new Error('download failed'))
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()

    const error = query('plugin-flow-error')
    expect(error?.textContent).toContain('download failed')
    expect(query('plugin-install-confirm')).toBeNull()
  })

  it('确认提交失败（success=false）→ 确认卡错误条呈现 error 字段，停在确认停点', async () => {
    pluginMock.confirmPluginInstall.mockResolvedValue({ success: false, error: 'activation failed: entry missing' })
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()
    query('plugin-install-confirm-btn')?.click()
    await flushPromises()
    await nextTick()

    const error = query('plugin-install-error')
    expect(error?.textContent).toContain('activation failed: entry missing')
    // 停在确认卡（暂存保留可重试），未进入授权段
    expect(query('plugin-install-confirm')).not.toBeNull()
    expect(query('plugin-authorize-container')).toBeNull()
  })

  it('确认提交异常（reject）→ 确认卡错误条呈现异常 message', async () => {
    pluginMock.confirmPluginInstall.mockRejectedValue(new Error('rpc down'))
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()
    query('plugin-install-confirm-btn')?.click()
    await flushPromises()
    await nextTick()

    expect(query('plugin-install-error')?.textContent).toContain('rpc down')
  })

  it('取消清理失败 → warn 可见不阻断 UI（退回家族卡）', async () => {
    const warn = spyWarn()
    pluginMock.cancelPluginInstall.mockRejectedValue(new Error('cleanup failed'))
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()
    query('plugin-install-cancel')?.click()
    await flushPromises()
    await nextTick()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancelPluginInstall failed'), expect.any(Error))
    expect(queryAll('plugin-family-card')).toHaveLength(3)
    warn.mockRestore()
  })

  it('带未确认暂存关闭对话框 + cancelPluginInstall 失败 → warn 降级不阻断复位', async () => {
    const warn = spyWarn()
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()
    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()
    expect(query('plugin-install-confirm')).not.toBeNull()

    pluginMock.cancelPluginInstall.mockRejectedValue(new Error('cancel failed'))
    await wrapper!.setProps({ open: false })
    await flushPromises()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancelPluginInstall on close failed'), expect.any(Error))
    warn.mockRestore()
  })

  it('离开授权段清挂载位失败 → warn 降级不阻断关闭', async () => {
    const warn = spyWarn()
    pluginMock.clearPluginMountUi.mockRejectedValue(new Error('clear failed'))
    wrapper = mountFlow({ focus: { pluginId: 'wool-trae', intent: 'authorize' } })
    await flushPromises()
    await nextTick()
    expect(query('plugin-authorize-container')).not.toBeNull()

    await wrapper!.setProps({ open: false })
    await flushPromises()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clearPluginMountUi on authorize-exit failed'), expect.any(Error))
    warn.mockRestore()
  })

  it('安装通道未就绪（port null）→ 家族卡点击呈 channelUnavailable 降级，不进确认卡', async () => {
    // 缺省 stub 不挂安装三方法（optional 契约缺省 = 通道未就绪形态）
    provideSettingsTransport(makeSettingsTransportStub({
      listAvailablePlugins: pluginMock.listAvailablePlugins,
      listPlugins: pluginMock.listPlugins,
    }))
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()

    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()

    expect(query('plugin-flow-error')?.textContent).toContain('安装通道未就绪')
    expect(query('plugin-install-confirm')).toBeNull()
  })

  it('确认时通道失就绪（确认卡出现后 transport 切走）→ 确认点击呈 channelUnavailable', async () => {
    wrapper = mountFlow()
    await flushPromises()
    await nextTick()
    queryAll('plugin-family-card')[0].click()
    await flushPromises()
    await nextTick()
    expect(query('plugin-install-confirm')).not.toBeNull()

    // 确认卡在停点期间 runtime 重启/降级 → 端口收窄失败（每次点击时动态解析）
    provideSettingsTransport(makeSettingsTransportStub({
      listAvailablePlugins: pluginMock.listAvailablePlugins,
      listPlugins: pluginMock.listPlugins,
    }))
    query('plugin-install-confirm-btn')?.click()
    await flushPromises()
    await nextTick()

    expect(query('plugin-install-error')?.textContent).toContain('安装通道未就绪')
    expect(pluginMock.confirmPluginInstall).not.toHaveBeenCalled()
  })
})
