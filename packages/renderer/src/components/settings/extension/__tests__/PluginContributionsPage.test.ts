/**
 * 插件贡献子页测试（wave plugin-settings-page，T3）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi，禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/extension/__tests__/PluginContributionsPage.test.ts
 *
 * 覆盖 design TC1/TC2：
 *   - TC1（SettingsModal 导航）：进入扩展 → 插件贡献子页 → PluginSettingsPage 渲染
 *     （plugin-settings-page testid 存在；contribution-unavailable 置灰项存在；
 *     builtin statusline/tasks 可见——DOM 断言，AGENTS.md 测试规范 §8 渲染 gate）。
 *   - TC2（provide 接线）：toContributionInfos 纯函数映射（available + 未注册挂载点置灰 + 原因），
 *     真实 ContributionRegistry + MountPointRegistry；组件测试 global.provide mock 数据源
 *     （贡献列表含 unavailable 项 → is-unavailable class + 原因文案渲染）。
 *
 * mock 策略（对齐 settings-modal-smoke.test.ts + ProviderPage.test.ts）：
 *   - vi.mock('@/api') 把 config/extension 门面替成可控 mock（ExtensionPage/InstallFlow 依赖）
 *   - vi.mock('@/api/domains/settings') 避免 electronAPI 缺失（chooseDirectory/SystemPage 依赖；
 *     settings 组件已收编走该 seam，不再直取 lib/ipc 原始模块）
 *   - providePlatform + provideSettingsTransport + pinia（SettingsModal 打开时刷新 providers）
 *   - global.provide 注入 SETTINGS_TOAST_KEY/USE_QUOTA_CONFIGURE_KEY/SETTINGS_CONFIG_API_KEY
 *   - global.stubs 把 LoadPaths/ExtensionInstallFlow/ExtensionList 重子组件 stub 掉（聚焦入口 + 子页）
 *   - global.provide PluginSettingsDataSourceKey mock 数据源（TC1/TC2 组件测试）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  providePlatform,
  provideSettingsTransport,
  __resetPlatformForTesting,
  __resetSettingsStoreForTesting,
  __resetSettingsTransportForTesting,
  ContributionRegistry,
  InternalEventBus,
  MountPointRegistry,
  type SettingsTransport,
} from '@taiji/core'
import {
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
  SETTINGS_CONFIG_API_KEY,
} from '@taiji/ui/features/settings'
import {
  PluginSettingsDataSourceKey,
  type PluginSettingsDataSource,
} from '@taiji/ui/extension-host'
import type { PluginInfo } from '@taiji/shared'

// @/api 门面 mock（对齐 settings-modal-smoke.test.ts + ExtensionPage 依赖的 extension 域）
vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: {
    listProviders: vi.fn(async () => ({ providers: [] })),
    // SettingsModal → ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
    refreshProviderCatalogs: vi.fn(async () => ({ refreshed: [], failed: [] })),
    setProvider: vi.fn(async () => undefined),
    setSkillDirs: vi.fn(async () => undefined),
    setAgentDirs: vi.fn(async () => undefined),
    setExtensionDirs: vi.fn(async () => undefined),
    discoverModels: vi.fn(async () => ({ success: true, models: [] })),
    onProviders: vi.fn(() => () => {}),
    onModels: vi.fn(() => () => {}),
    onSkills: vi.fn(() => () => {}),
    onAgents: vi.fn(() => () => {}),
    onExtensions: vi.fn(() => () => {}),
    onSkillDirs: vi.fn(() => () => {}),
    onAgentDirs: vi.fn(() => () => {}),
    onExtensionDirs: vi.fn(() => () => {}),
    onDefaults: vi.fn(() => () => {}),
    onDefaultsWithSource: vi.fn(() => () => {}),
    onSystemPrompt: vi.fn(() => () => {}),
    onTerminalConfig: vi.fn(() => () => {}),
    detectSources: vi.fn(async () => []),
    onAuthDeviceCode: vi.fn(() => () => {}),
    onAuthAuthUrl: vi.fn(() => () => {}),
    onAuthSuccess: vi.fn(() => () => {}),
    onAuthError: vi.fn(() => () => {}),
  },
  model: { onModels: vi.fn(() => () => {}) },
  extension: {
    onExtensions: vi.fn(() => () => {}),
    fetchRecommended: vi.fn(async () => []),
    install: vi.fn(async () => undefined),
    installDir: vi.fn(async () => ({ success: true, tempDir: '', candidates: [] })),
    installGitRepository: vi.fn(async () => ({ success: true, tempDir: '', candidates: [] })),
    finishInstall: vi.fn(async () => undefined),
    cancelInstall: vi.fn(async () => undefined),
  },
  settings: {
    listProviders: vi.fn(async () => ({ providers: [] })),
    onProviders: vi.fn(() => () => {}),
    onExtensions: vi.fn(() => () => {}),
    getAutoRenameEnabled: vi.fn(async () => ({ enabled: false })),
    setAutoRenameEnabled: vi.fn(async () => ({ enabled: false })),
  },
}))

// settings 域 seam mock（SystemPage/TerminalPage/LoadPaths chooseDirectory 依赖）
vi.mock('@/api/domains/settings', () => ({
  listSystemSounds: vi.fn(async () => ({ sounds: [] })),
  getProxyConfig: vi.fn(async () => ({})),
  setProxyConfig: vi.fn(async () => undefined),
  testProxy: vi.fn(async () => ({ success: true })),
  getDataDir: vi.fn(async () => undefined),
  chooseDirectory: vi.fn(async () => null),
  openUpdateManualDir: vi.fn(async () => ({ success: true })),
}))

import SettingsModal from '@/components/settings/SettingsModal.vue'
import PluginContributionsPage from '@/components/settings/extension/PluginContributionsPage.vue'
import { toContributionInfos } from '@/composables/shell/useExtensionHostBridge'
import { makeQuotaStateStub } from '@/__tests__/helpers/quota-state-stub'

/** 构造最小 SettingsTransport stub（订阅返回 noop 取消函数，请求返回空）。 */
function stubTransport(): SettingsTransport {
  const noopUnsub = (): void => {}
  return {
    listProviders: async () => ({ providers: [] }),
    listModels: async () => [],
    setProvider: async () => undefined,
    setScopedModels: async () => [],
    discoverModels: async () => ({ success: true, models: [] }),
    setSkillDirs: async () => undefined,
    setAgentDirs: async () => undefined,
    setExtensionDirs: async () => undefined,
    onProviders: () => noopUnsub,
    onModels: () => noopUnsub,
    onSkills: () => noopUnsub,
    onAgents: () => noopUnsub,
    onExtensions: () => noopUnsub,
    onSkillDirs: () => noopUnsub,
    onAgentDirs: () => noopUnsub,
    onExtensionDirs: () => noopUnsub,
    onDefaults: () => noopUnsub,
    onSystemPrompt: () => noopUnsub,
    onTerminalConfig: () => noopUnsub,
  }
}

/** mock 数据源：builtin statusline/tasks 插件 + 贡献可用性（statusbar/sidebar.tab 注册=可用，slash 未注册=置灰+原因）。 */
const PLUGINS: PluginInfo[] = [
  {
    pluginId: 'statusline',
    version: '1.0.0',
    displayName: 'statusline',
    description: '',
    status: 'active',
    trustLevel: 'trusted',
    enabled: true,
  },
  {
    pluginId: 'tasks',
    version: '1.0.0',
    displayName: 'tasks',
    description: '',
    status: 'active',
    trustLevel: 'trusted',
    enabled: true,
  },
]

function makeDataSource(): PluginSettingsDataSource {
  return {
    onPlugins: vi.fn((handler) => {
      handler(PLUGINS)
      return () => {}
    }),
    getContributions: vi.fn((pluginId: string) => {
      if (pluginId === 'statusline') {
        return [{ id: 'statusline', type: 'statusBarItem', available: true }]
      }
      if (pluginId === 'tasks') {
        return [
          { id: 'todo', type: 'view', available: true },
          { id: 'goal', type: 'view', available: true },
          { id: 'goal', type: 'slashCommand', available: false, reason: '挂载点 slash 未注册' },
        ]
      }
      return []
    }),
  }
}

/** 复用 settings-modal-smoke 的 ui 注入 key（ProviderPage/ExtensionPage 依赖）。 */
function settingsModalProvides() {
  return {
    [SETTINGS_TOAST_KEY as symbol]: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
    // 不再 `as symbol` 强转：保留 InjectionKey 类型；契约门由 makeQuotaStateStub 的
    // QuotaConfigureState 返回标注承担（v2 漏成员即编译错）。
    [USE_QUOTA_CONFIGURE_KEY]: () => makeQuotaStateStub(),
    [SETTINGS_CONFIG_API_KEY as symbol]: { detectSources: vi.fn(async () => []) },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetPlatformForTesting()
  __resetSettingsStoreForTesting()
  __resetSettingsTransportForTesting()
  providePlatform({
    kind: 'mock',
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    webSocket: {
      create: () => ({
        readyState: 0,
        send: () => {},
        close: () => {},
        onopen: null,
        onclose: null,
        onmessage: null,
        onerror: null,
      }),
    },
  })
  provideSettingsTransport(stubTransport())
})

describe('TC1: Settings 导航到插件贡献子页 → PluginSettingsPage 渲染', () => {
  it('扩展 nav → 插件贡献入口 → 子页渲染 PluginSettingsPage（置灰项存在，builtin 可见）', async () => {
    const dataSource = makeDataSource()
    mount(SettingsModal, {
      props: { open: true },
      attachTo: document.body,
      global: {
        provide: {
          ...settingsModalProvides(),
          [PluginSettingsDataSourceKey as symbol]: dataSource,
        },
        stubs: {
          // 重子组件 stub：TC1 聚焦「入口 + 子页」，安装流/列表/加载路径不是本 wave 范围
          LoadPaths: { template: '<div />' },
          ExtensionInstallFlow: { template: '<div />' },
          ExtensionList: { template: '<div />' },
        },
      },
    })
    await flushPromises()

    // ① 进入扩展域
    const navExt = document.body.querySelector('[data-testid="settings-nav-extension"]') as HTMLElement
    expect(navExt).not.toBeNull()
    navExt.click()
    await flushPromises()
    // ExtensionPage 渲染（入口按钮存在）
    expect(document.body.querySelector('[data-testid="extension-contributions-entry"]')).not.toBeNull()

    // ② 导航到插件贡献子页
    const entry = document.body.querySelector('[data-testid="extension-contributions-entry"]') as HTMLElement
    entry.click()
    await flushPromises()

    // ③ 子页渲染 PluginSettingsPage（DOM 断言）
    expect(document.body.querySelector('[data-testid="plugin-settings-page"]')).not.toBeNull()
    // 数据源被消费：onPlugins 订阅 + getContributions 按插件查询
    expect(dataSource.onPlugins).toHaveBeenCalledTimes(1)
    expect(dataSource.getContributions).toHaveBeenCalledWith('statusline')
    expect(dataSource.getContributions).toHaveBeenCalledWith('tasks')
    // builtin statusline/tasks 可见
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('statusline')
    expect(bodyText).toContain('tasks')
    // 未注册挂载点（slash）置灰项存在 + 原因文案
    const grayed = document.body.querySelector('[data-testid="contribution-unavailable"]')
    expect(grayed).not.toBeNull()
    expect(grayed!.textContent).toContain('挂载点 slash 未注册')
  })
})

describe('TC2: provide 接线（toContributionInfos 映射 + 组件 global.provide mock）', () => {
  it('toContributionInfos：已注册挂载点 available=true，未注册 → false + 原因', () => {
    const bus = new InternalEventBus()
    const contributions = new ContributionRegistry(bus)
    contributions.registerBuiltin()
    const mounts = new MountPointRegistry()
    mounts.register('sidebar.tab')
    mounts.register('statusbar')

    const statuslineInfos = toContributionInfos(
      contributions.getContributions({ pluginId: 'statusline' }),
      mounts,
    )
    expect(statuslineInfos).toEqual([
      { id: 'statusline', type: 'statusBarItem', available: true, reason: undefined },
    ])

    const tasksInfos = toContributionInfos(
      contributions.getContributions({ pluginId: 'tasks' }),
      mounts,
    )
    // tasks: todo/goal view（sidebar.tab 注册 → 可用）+ goal/todo slashCommand（slash 未注册 → 置灰 + 原因）
    const viewInfos = tasksInfos.filter((i) => i.type === 'view')
    expect(viewInfos.every((i) => i.available)).toBe(true)
    const slashInfos = tasksInfos.filter((i) => i.type === 'slashCommand')
    expect(slashInfos.length).toBeGreaterThan(0)
    expect(slashInfos.every((i) => !i.available)).toBe(true)
    expect(slashInfos[0].reason).toContain('挂载点')
    expect(slashInfos[0].reason).toContain('未注册')
  })

  it('组件测试：global.provide mock 数据源 → 不可用贡献置灰（is-unavailable class + 原因文案）', async () => {
    const dataSource = makeDataSource()
    const wrapper = mount(PluginContributionsPage, {
      global: {
        provide: {
          [PluginSettingsDataSourceKey as symbol]: dataSource,
        },
      },
    })
    await flushPromises()

    // 子页头 + PluginSettingsPage 渲染
    expect(wrapper.find('[data-testid="plugin-settings-page"]').exists()).toBe(true)
    // builtin statusline/tasks 可见（插件卡片）
    expect(wrapper.text()).toContain('statusline')
    expect(wrapper.text()).toContain('tasks')
    // 置灰项：contribution-unavailable testid + is-unavailable class + 原因
    const grayed = wrapper.find('[data-testid="contribution-unavailable"]')
    expect(grayed.exists()).toBe(true)
    expect(grayed.classes()).toContain('is-unavailable')
    expect(grayed.text()).toContain('挂载点 slash 未注册')
    // 可用项正常展示（无置灰 class）
    const available = wrapper.find('[data-testid="contribution-item"]')
    expect(available.exists()).toBe(true)
    expect(available.classes()).not.toContain('is-unavailable')
    // 返回按钮存在（子页可回到扩展管理）
    expect(wrapper.find('[data-testid="plugin-contributions-back"]').exists()).toBe(true)
  })
})
