/**
 * SettingsTransport adapter —— core settings 域 → transport 接入面（IF1）的 renderer 壳实现（W4）。
 *
 * core 域内只依赖 SettingsTransport 接口（transport.ts），不感知 WS/transport 实现。
 * 本 adapter 在 bootstrapSettingsCore provideSettingsTransport 时构造，逐方法转发
 * @/api 门面的 config/model/extension/settings/quota/preset/usage/session 八元导出——
 * 经门面即继承 VITE_MOCK mock/real 切换（mock 模式 settings 域走 core/transport/mock fixture，
 * 与全应用其它域一致；过度设计审计修复 u17，裁决 3）。real adapter（本文件）与
 * mock adapter（core/transport/mock 体系）共同证明 seam 真实——[C3] mock 侧已补齐
 * settings 字段读写 + usage 域，mock 模式全 seam 可用。
 *
 * 形态裁决（[C3] adapter 浅层收敛）：报告建议的「方法 → 命令/门面映射表 + 循环生成」在
 * 本接口形态下会损失类型安全（8 个门面签名异构，表驱动生成需跨型断言/any），按报告豁免
 * 条款保留逐方法显式转发（每行即一条映射，编译期与 SettingsTransport 逐签名配对）；
 * 接口分组（读/写/订阅）已反映真实消费面（transport.ts）。
 *
 * 签名对齐 core SettingsTransport 接口；mock 兼容硬约束（@/api 的 on* 订阅 / listProviders 等
 * 已就位，settings/quota/preset/usage/session 域 mock 与 real 同构）。
 */
import type { SettingsTransport, DiscoverModelsRequest, DiscoverModelsResponse } from '@taiji/core/domain/settings'
import type { ExtensionInfo, ProviderId } from '@taiji/shared'
import { config, model, extension, settings, quota, preset, usage, session } from '@/api'

/**
 * 构造 SettingsTransport 实现：逐方法转发 @/api 门面八元（VITE_MOCK 感知）。
 * 订阅函数（on*）返回取消函数；请求函数签名与 @/api 对齐。
 */
export function createSettingsTransport(): SettingsTransport {
  return {
    // ══════════════════════ 读（请求-响应）══════════════════════
    listProviders: () => config.listProviders(),
    listModels: () => model.listModels(),
    listBuiltinProviders: () => config.listBuiltinProviders(),
    detectSources: () => config.detectSources(),
    refreshProviderCatalogs: () => config.refreshProviderCatalogs(),
    scanSkills: (sources) => config.scanSkills(sources),
    scanAgents: (sources) => config.scanAgents(sources),
    getGlobalSkills: () => config.getGlobalSkills(),
    getProjectSkills: (cwd) => config.getProjectSkills(cwd),
    previewImportProviders: (source) => config.previewImportProviders(source),
    discoverModels: async (req: DiscoverModelsRequest): Promise<DiscoverModelsResponse> => {
      // core DiscoverModelsRequest 与 @/api config.discoverModels 字段已对齐（baseUrl 协议必填），
      // 此处只补协议缺省语义（mode 缺省 discover）后原样透传。
      // 模式感知 guard：discover 模式 baseUrl 缺失时短路返失败，不做 silent cast；
      // test 模式端点回落链（模型级 → provider 级 → catalog 网关）归 runtime，不校验 baseUrl。
      const mode = req.mode ?? 'discover'
      if (mode !== 'test' && !req.baseUrl) {
        return { success: false, error: 'baseUrl is required for model discovery' }
      }
      return config.discoverModels({ ...req, mode })
    },
    hasOAuth: (providerId) => config.hasOAuth(providerId),
    checkEnvVars: (names) => config.checkEnvVars(names),
    getSystemPrompt: () => config.getSystemPrompt(),
    getTerminalConfig: () => config.getTerminalConfig(),
    getRetryConfig: () => config.getRetryConfig(),
    getWorktreeRootDir: () => settings.getWorktreeRootDir(),
    getSetupScript: () => settings.getSetupScript(),
    getBareSetupScript: () => settings.getBareSetupScript(),
    getWorktreeTimeout: () => settings.getWorktreeTimeout(),
    getDefaultBaseBranch: () => settings.getDefaultBaseBranch(),
    getAutoRenameEnabled: () => settings.getAutoRenameEnabled(),
    getRenameMode: () => settings.getRenameMode(),
    getRenameModel: () => settings.getRenameModel(),
    getSmartContextConfig: () => settings.getSmartContextConfig(),
    getCodemodeEnabled: () => settings.getCodemodeEnabled(),
    getUsageStats: () => usage.getUsageStats(),
    getSubagentEngineConfig: () => session.getSubagentEngineConfig(),
    getCachedQuota: (providerId) => quota.getCached(providerId),
    refreshQuota: (providerId) => quota.refreshQuota(providerId),
    listPresets: () => preset.list(),
    getDefaultPreset: () => preset.getDefault(),
    fetchRecommendedExtensions: () => extension.fetchRecommended(),

    // ══════════════════════ 写（动作-ack）══════════════════════
    setProvider: (id, data) => config.setProvider(id as ProviderId, data),
    setScopedModels: (models) => config.setScopedModels(models),
    setDefaultModel: (provider, modelId) => config.setDefaultModel(provider, modelId),
    toggleProviderEnabled: (providerId, enabled) => config.toggleProviderEnabled(providerId, enabled),
    removeProviderByKind: (providerId, kind) => config.removeProviderByKind(providerId, kind),
    setSkillDirs: (dirs) => config.setSkillDirs(dirs),
    setAgentDirs: (dirs) => config.setAgentDirs(dirs),
    setExtensionDirs: (dirs) => config.setExtensionDirs(dirs),
    applyImportProviders: (importId, selectedIds) => config.applyImportProviders(importId, selectedIds),
    setSystemPrompt: (cfg) => config.setSystemPrompt(cfg),
    setTerminalConfig: (cfg) => config.setTerminalConfig(cfg),
    setRetryConfig: (cfg) => config.setRetryConfig(cfg),
    setWorktreeRootDir: (dir) => settings.setWorktreeRootDir(dir),
    setSetupScript: (script) => settings.setSetupScript(script),
    setBareSetupScript: (script) => settings.setBareSetupScript(script),
    setWorktreeTimeout: (timeout) => settings.setWorktreeTimeout(timeout),
    setDefaultBaseBranch: (baseBranch) => settings.setDefaultBaseBranch(baseBranch),
    setAutoRenameEnabled: (enabled) => settings.setAutoRenameEnabled(enabled),
    setRenameMode: (mode) => settings.setRenameMode(mode),
    setRenameModel: (model) => settings.setRenameModel(model),
    setSmartContextEnabled: (enabled) => settings.setSmartContextEnabled(enabled),
    setSmartContextCompactModel: (model) => settings.setSmartContextCompactModel(model),
    setSmartContextThresholds: (thresholds) => settings.setSmartContextThresholds(thresholds),
    setSmartContextExcludedModels: (models) => settings.setSmartContextExcludedModels(models),
    setCodemodeEnabled: (enabled) => settings.setCodemodeEnabled(enabled),
    setSubagentDefaultEngine: (engineId) => session.setSubagentDefaultEngine(engineId),
    oauthLogin: (providerId) => config.oauthLogin(providerId),
    oauthCancel: (providerId) => config.oauthCancel(providerId),
    oauthLogout: (providerId) => config.oauthLogout(providerId),
    configureQuota: (payload) => quota.configure(payload),
    setDefaultPreset: (presetId) => preset.setDefault(presetId),
    createPreset: (p) => preset.create(p),
    updatePreset: (p) => preset.update(p),
    removePreset: (presetId) => preset.remove(presetId),
    toggleExtension: (name, enabled) => extension.toggle(name, enabled),
    installExtension: (source) => extension.install(source),
    uninstallExtension: (name) => extension.uninstall(name),
    installExtensionDir: (path) => extension.installDir(path),
    installExtensionGitRepository: (url) => extension.installGitRepository(url),
    finishExtensionInstall: (tempDir, selected) => extension.finishInstall(tempDir, selected),
    cancelExtensionInstall: (tempDir) => extension.cancelInstall(tempDir),
    upgradeExtension: (name) => extension.upgrade(name),
    setExtensionAutoUpgrade: (name, enabled) => extension.setAutoUpgrade(name, enabled),

    // ══════════════════════ 订阅（返回取消函数）══════════════════════
    onProviders: (h) => config.onProviders(h),
    onModels: (h) => model.onModels(h),
    onSkills: (h) => config.onSkills(h),
    onAgents: (h) => config.onAgents(h),
    // mock 域 onExtensions 暂留宽类型 GlobalHandler<unknown>（mock/index.ts W08 登记），
    // real 域强类型 (e: ExtensionInfo[]) => void；包装层在 union 两侧均合法（参数更宽的
    // handler 对 real 亦兼容），cast 依据：mock fixture 与 real 广播同为 ExtensionInfo 形状。
    onExtensions: (h) => extension.onExtensions((data) => h(data as ExtensionInfo[])),
    onSkillDirs: (h) => config.onSkillDirs(h),
    onAgentDirs: (h) => config.onAgentDirs(h),
    onExtensionDirs: (h) => config.onExtensionDirs(h),
    onDefaults: (h) => config.onDefaults(h),
    onDefaultsWithSource: (h) => config.onDefaultsWithSource(h),
    onSkillCacheInvalidated: (h) => config.onSkillCacheInvalidated(h),
    onSystemPrompt: (h) => config.onSystemPrompt(h),
    onTerminalConfig: (h) => config.onTerminalConfig(h),
    onRetryConfig: (h) => config.onRetryConfig(h),
    onAuthDeviceCode: (h) => config.onAuthDeviceCode(h),
    onAuthAuthUrl: (h) => config.onAuthAuthUrl(h),
    onAuthSuccess: (h) => config.onAuthSuccess(h),
    onAuthError: (h) => config.onAuthError(h),
  }
}
