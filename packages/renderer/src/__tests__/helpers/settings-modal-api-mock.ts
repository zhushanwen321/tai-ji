/**
 * SettingsModal 挂载类测试共享的 '@/api' 门面 mock 工厂（settings-modal-smoke.test.ts 与
 * PluginContributionsPage.test.ts 两文件逐字重复段单源；范式同 update-card-mock——vi.mock
 * 注册留在测试文件，工厂经顶层 import 转发本 helper 导出）。
 *
 * 门面成员面 = SettingsModal 全页树（ProviderPage / SystemPage / TerminalPage /
 * SettingsResourcePage / ExtensionPage）mount 期的最小消费集：config 域订阅方法缺导出
 * 即 TypeError 崩 mount，各成员的存在理由见行内注释。
 *
 * extension 域是两消费方的差异点：基本面只有 onExtensions（SettingsModal 刷新 providers），
 * 扩展页测试经 extensionOverrides 追加 install 流 mock。
 *
 * vitest 按测试文件隔离模块图：每个测试文件经 vi.mock 工厂各自取一份新实例。
 */
import { vi } from 'vitest'

/** '@/api' 门面 mock 工厂（project/config/model/extension/settings 五组；extension 域差异经
 *  extensionOverrides 追加，基本面 onExtensions 恒在）。 */
export function settingsModalApiModule(extensionOverrides: Record<string, unknown> = {}) {
  return {
    project: {
      load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
      save: vi.fn().mockResolvedValue(undefined),
    },
    config: {
      listProviders: vi.fn(async () => ({ providers: [] })),
      // SettingsModal → ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
      refreshProviderCatalogs: vi.fn(async () => ({ refreshed: [], failed: [] })),
      setProvider: vi.fn(async () => ({})),
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
      // P2：ProviderPage 默认 pill + 默认修复 toast（缺则 TypeError 崩 mount）
      onDefaultsWithSource: vi.fn(() => () => {}),
      onSystemPrompt: vi.fn(() => () => {}),
      onTerminalConfig: vi.fn(() => () => {}),
      detectSources: vi.fn(async () => []),
      // wave-oauth：SettingsModal → ProviderPage → useProviderOAuth onMounted 订阅 4 个 auth.* 事件（缺则 TypeError 崩 mount）
      onAuthDeviceCode: vi.fn(() => () => {}),
      onAuthAuthUrl: vi.fn(() => () => {}),
      onAuthSuccess: vi.fn(() => () => {}),
      onAuthError: vi.fn(() => () => {}),
    },
    model: { onModels: vi.fn(() => () => {}) },
    extension: { onExtensions: vi.fn(() => () => {}), ...extensionOverrides },
    settings: {
      listProviders: vi.fn(async () => ({ providers: [] })),
      onProviders: vi.fn(() => () => {}),
      onExtensions: vi.fn(() => () => {}),
      getAutoRenameEnabled: vi.fn(async () => ({ enabled: false })),
      setAutoRenameEnabled: vi.fn(async () => ({ enabled: false })),
    },
  }
}
