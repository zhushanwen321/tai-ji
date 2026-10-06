/**
 * SettingsTransport 测试桩工厂（[C3] seam 收编后的测试适配面，core/renderer/ui 测试共用双）。
 *
 * 背景：settings 页 / settings composables 只经 SettingsTransport seam 访问 transport
 * （getSettingsTransport()，注入前 fail-fast）。测试不再 vi.mock @/api 门面或 core transport
 * 域（replace, don't layer——打 seam 而非路由链），统一用本工厂构造桩 + provideSettingsTransport
 * 注入。返回对象带 SettingsTransport 类型标注：契约新增/改名/删除成员时此处立即编译报错。
 *
 * 默认值为中性语义：请求/动作返回空值 ack、订阅返回 no-op 取消函数；用例按需 overrides
 * 注入自己的 vi.fn() 断言。
 *
 * 导出面：@taiji/core/testing（包内 __tests__ 亦可相对路径消费；renderer/ui 测试经包名）。
 */
import { vi } from 'vitest'
import type { SettingsTransport } from '../domain/settings/transport'

/**
 * 覆盖面签名：键集与实参表逐签名对齐（漏键/错键/实参错型即报错），返回值保持宽松——
 * 测试 vi.fn() 桩的返回形状常是宽化 mock（如 () => Promise<void> 顶替真实 reply 形状），
 * 返回强校验会把桩类型噪音当契约错误。实参表校验堵住「实参错型的假绿桩」（桩签名与
 * seam 方法对不上时编译期即红，而非测试静默通过）；契约漂移检测由下方
 * `const transport: SettingsTransport` 全量字面量承担（新 seam 方法缺失/改名在此报错）。
 */
export type SettingsTransportStubOverrides = {
  [K in keyof SettingsTransport]?: (...args: Parameters<SettingsTransport[K]>) => unknown
}

/** 订阅方法统一桩形（模块内共用）：一键产出「调用返回 no-op 取消函数」的独立 vi.fn
 *  （每键一实例，mock 调用记录按键隔离，断言互不串扰）。 */
function makeUnsubscribeStub() {
  return vi.fn((): () => void => () => {})
}

/** SettingsTransport 的订阅方法面（键集漂移由下方 Pick 标注报错——改名/删键即编译红）。 */
export type SettingsSubscriptionStubs = Pick<
  SettingsTransport,
  | 'onProviders' | 'onModels' | 'onSkills' | 'onAgents' | 'onExtensions'
  | 'onSkillDirs' | 'onAgentDirs' | 'onExtensionDirs' | 'onDefaults' | 'onDefaultsWithSource'
  | 'onSkillCacheInvalidated' | 'onSystemPrompt' | 'onTerminalConfig' | 'onRetryConfig'
  | 'onAuthDeviceCode' | 'onAuthAuthUrl' | 'onAuthSuccess' | 'onAuthError'
>

/**
 * 订阅段全量桩（单源导出）：SettingsTransport 订阅方法面一键取齐，每次调用产出全新
 * vi.fn 实例（无跨用例状态残留）。
 *
 * renderer/ui 侧 mock 需要同形状订阅段时 spread 本函数返回值
 * （`...makeSettingsSubscriptionStubs()`），不再逐键复刻 `vi.fn(() => () => {})`
 * 字面量——该字面量与外部 mock 的逐字重复正是克隆组来源。
 */
export function makeSettingsSubscriptionStubs(): SettingsSubscriptionStubs {
  return {
    onProviders: makeUnsubscribeStub(),
    onModels: makeUnsubscribeStub(),
    onSkills: makeUnsubscribeStub(),
    onAgents: makeUnsubscribeStub(),
    onExtensions: makeUnsubscribeStub(),
    onSkillDirs: makeUnsubscribeStub(),
    onAgentDirs: makeUnsubscribeStub(),
    onExtensionDirs: makeUnsubscribeStub(),
    onDefaults: makeUnsubscribeStub(),
    onDefaultsWithSource: makeUnsubscribeStub(),
    onSkillCacheInvalidated: makeUnsubscribeStub(),
    onSystemPrompt: makeUnsubscribeStub(),
    onTerminalConfig: makeUnsubscribeStub(),
    onRetryConfig: makeUnsubscribeStub(),
    onAuthDeviceCode: makeUnsubscribeStub(),
    onAuthAuthUrl: makeUnsubscribeStub(),
    onAuthSuccess: makeUnsubscribeStub(),
    onAuthError: makeUnsubscribeStub(),
  }
}

/** 构造全量 SettingsTransport 桩（逐方法中性默认 + 按需覆盖）。 */
export function makeSettingsTransportStub(overrides: SettingsTransportStubOverrides = {}): SettingsTransport {
  const transport: SettingsTransport = {
    // ── 读 ──
    listProviders: vi.fn(async () => ({ providers: [] })),
    listModels: vi.fn(async () => []),
    listBuiltinProviders: vi.fn(async () => []),
    detectSources: vi.fn(async () => []),
    refreshProviderCatalogs: vi.fn(async () => ({ refreshed: [], failed: [], corrupt: [] })),
    scanSkills: vi.fn(async () => []),
    scanAgents: vi.fn(async () => []),
    getGlobalSkills: vi.fn(async () => []),
    getProjectSkills: vi.fn(async () => []),
    previewImportProviders: vi.fn(async (source) => ({ importId: 'stub-import', preview: { source, providers: [] } })),
    discoverModels: vi.fn(async () => ({ success: true, models: [] })),
    hasOAuth: vi.fn(async () => false),
    checkEnvVars: vi.fn(async () => ({})),
    getSystemPrompt: vi.fn(async () => ({
      config: { version: 1, replace: { enabled: false, prompt: '' }, append: { enabled: false, prompt: '' } },
      corrupted: false,
    })),
    getTerminalConfig: vi.fn(async () => ({
      config: {
        version: 1,
        shell: '',
        shellArgs: [],
        fontSize: 12,
        fontFamily: '',
        scrollback: 1000,
        cursorStyle: 'block' as const,
        bell: false,
      },
      corrupted: false,
    })),
    getRetryConfig: vi.fn(async () => ({
      config: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
      configured: false,
    })),
    getWorktreeRootDir: vi.fn(async () => ({ dir: '' })),
    getSetupScript: vi.fn(async () => ({ script: '' })),
    getBareSetupScript: vi.fn(async () => ({ script: '' })),
    getWorktreeTimeout: vi.fn(async () => ({ timeout: 60 })),
    getDefaultBaseBranch: vi.fn(async () => ({ baseBranch: '' })),
    getAutoRenameEnabled: vi.fn(async () => ({ enabled: false })),
    getRenameMode: vi.fn(async () => ({ mode: 'first-stop' as const })),
    getRenameModel: vi.fn(async () => ({ model: '' })),
    getSmartContextConfig: vi.fn(async () => ({
      enabled: false,
      compactModel: '',
      reminderThresholds: [],
      excludedModels: [],
    })),
    getCodemodeEnabled: vi.fn(async () => ({ enabled: true, corruption: null })),
    getUsageStats: vi.fn(async () => ({ rows: [], scannedAt: 0, sessionCount: 0, skippedLines: 0 })),
    getSubagentEngineConfig: vi.fn(async () => ({ engines: ['pi'], defaultEngine: 'pi' })),
    getCachedQuota: vi.fn(async () => ({ data: null, lastFetchAt: null })),
    refreshQuota: vi.fn(async () => ({ data: null, lastFetchAt: null })),
    listPresets: vi.fn(async () => []),
    getDefaultPreset: vi.fn(async () => 'builtin:full'),
    fetchRecommendedExtensions: vi.fn(async () => []),

    // ── 写 ──
    setProvider: vi.fn(async () => ({})),
    setScopedModels: vi.fn(async (models: string[]): Promise<string[]> => models),
    setDefaultModel: vi.fn(async () => {}),
    toggleProviderEnabled: vi.fn(async () => {}),
    removeProviderByKind: vi.fn(async () => {}),
    setSkillDirs: vi.fn(async () => {}),
    setAgentDirs: vi.fn(async () => {}),
    setExtensionDirs: vi.fn(async () => {}),
    applyImportProviders: vi.fn(async () => ({ result: { source: 'pi' as const, imported: [], failedCount: 0 } })),
    setSystemPrompt: vi.fn(async (config) => ({ config, corrupted: false })),
    setTerminalConfig: vi.fn(async (config) => ({ config, corrupted: false })),
    setRetryConfig: vi.fn(async (config) => ({ config, configured: true })),
    setWorktreeRootDir: vi.fn(async (dir) => ({ dir })),
    setSetupScript: vi.fn(async (script) => ({ script })),
    setBareSetupScript: vi.fn(async (script) => ({ script })),
    setWorktreeTimeout: vi.fn(async (timeout) => ({ timeout })),
    setDefaultBaseBranch: vi.fn(async (baseBranch) => ({ baseBranch })),
    setAutoRenameEnabled: vi.fn(async (enabled) => ({ enabled })),
    setRenameMode: vi.fn(async (mode) => ({ mode })),
    setRenameModel: vi.fn(async (model) => ({ model })),
    setSmartContextEnabled: vi.fn(async (enabled) => ({ enabled })),
    setSmartContextCompactModel: vi.fn(async (model) => ({ model })),
    setSmartContextThresholds: vi.fn(async (thresholds) => ({ thresholds })),
    setSmartContextExcludedModels: vi.fn(async (models) => ({ models })),
    setCodemodeEnabled: vi.fn(async (enabled: boolean) => ({ ok: true as const, enabled })),
    setSubagentDefaultEngine: vi.fn(async (engineId) => ({ engineId })),
    oauthLogin: vi.fn(async () => ({ started: false, error: 'stub transport' })),
    oauthCancel: vi.fn(async () => ({ cancelled: false })),
    oauthLogout: vi.fn(async () => ({ ok: true })),
    configureQuota: vi.fn(async () => ({ ok: true })),
    setDefaultPreset: vi.fn(async () => {}),
    createPreset: vi.fn(async (preset) => preset),
    updatePreset: vi.fn(async (preset) => preset),
    removePreset: vi.fn(async () => {}),
    toggleExtension: vi.fn(async () => ({ extensions: [] })),
    installExtension: vi.fn(async () => {}),
    uninstallExtension: vi.fn(async () => {}),
    installExtensionDir: vi.fn(async () => ({ tempDir: '', candidates: [] })),
    installExtensionGitRepository: vi.fn(async () => ({ tempDir: '', candidates: [] })),
    finishExtensionInstall: vi.fn(async () => {}),
    cancelExtensionInstall: vi.fn(async () => {}),
    upgradeExtension: vi.fn(async () => {}),
    setExtensionAutoUpgrade: vi.fn(async () => {}),

    // ── 订阅（返回 no-op 取消函数）—— 订阅段单源 = makeSettingsSubscriptionStubs
    //    （键集漂移由其 Pick 标注 + 下方 SettingsTransport 标注双重报错）──
    ...makeSettingsSubscriptionStubs(),
  }
  return { ...transport, ...overrides } as SettingsTransport
}
