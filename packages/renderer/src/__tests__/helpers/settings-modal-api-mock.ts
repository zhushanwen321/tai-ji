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
 * 公共段另以独立导出供轻量门面 mock（composables 单测只挂 project + 单差异域）复用：
 * emptyProjectApi（project 域底盘）与 subscriptionStubs（on* 订阅族）。
 *
 * vitest 按测试文件隔离模块图：每个测试文件经 vi.mock 工厂各自取一份新实例。
 */
import { vi } from 'vitest'

/** project 域最小 mock（空项目清单 + 空 activeProjectId；'@/api' 门面 mock 的公共底盘）。 */
export function emptyProjectApi() {
  return {
    load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    save: vi.fn().mockResolvedValue(undefined),
  }
}

/** on* 订阅成员族 stub（键列表 → { onX: vi.fn(() => () => {}) }：注册即返回 disposer 的
 *  no-op 订阅；'@/api' config 域订阅段在多文件门面 mock 间重复，收敛为键参数化单源）。 */
export function subscriptionStubs(keys: readonly string[]) {
  return Object.fromEntries(keys.map((k) => [k, vi.fn(() => () => {})]))
}

/** '@/api' 门面 mock 工厂（project/config/model/extension/settings 五组；extension 域差异经
 *  extensionOverrides 追加，基本面 onExtensions 恒在）。 */
export function settingsModalApiModule(extensionOverrides: Record<string, unknown> = {}) {
  return {
    project: emptyProjectApi(),
    config: {
      listProviders: vi.fn(async () => ({ providers: [] })),
      // SettingsModal → ProviderPage onMounted 按需刷新远程模型目录（缺则 unhandled rejection）
      refreshProviderCatalogs: vi.fn(async () => ({ refreshed: [], failed: [] })),
      setProvider: vi.fn(async () => ({})),
      setSkillDirs: vi.fn(async () => undefined),
      setAgentDirs: vi.fn(async () => undefined),
      setExtensionDirs: vi.fn(async () => undefined),
      discoverModels: vi.fn(async () => ({ success: true, models: [] })),
      detectSources: vi.fn(async () => []),
      // 订阅成员族：P2 的 onDefaultsWithSource 是 ProviderPage 默认 pill + 默认修复 toast
      // 依赖（缺则 TypeError 崩 mount）；wave-oauth 的 onAuth* 四键是 useProviderOAuth
      // onMounted 订阅依赖——任一订阅成员缺导出同样崩 mount
      ...subscriptionStubs([
        'onProviders', 'onModels', 'onSkills', 'onAgents', 'onExtensions',
        'onSkillDirs', 'onAgentDirs', 'onExtensionDirs', 'onDefaults',
        'onDefaultsWithSource', 'onSystemPrompt', 'onTerminalConfig',
        'onAuthDeviceCode', 'onAuthAuthUrl', 'onAuthSuccess', 'onAuthError',
      ]),
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
