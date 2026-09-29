// @vitest-environment node

/**
 * settings-transport-adapter 测试（三支）：
 *
 * 1. 八元转发矩阵（装配不变量，u17 验收）：adapter import 源 = @/api 门面八元
 *    （config/model/extension/settings/quota/preset/usage/session，VITE_MOCK 感知），
 *    SettingsTransport 接口面逐方法转发门面对应导出。矩阵键 satisfies
 *    Record<keyof SettingsTransport, ...> 与接口同宽——接口新增/改名方法不进矩阵
 *    = 编译错，防回退 core/transport 直连、防新转发方法漏断言。逐方法断言三透传：
 *    转发目标（域.成员）、探针参数、返回值（请求 resolve 哨兵 / 订阅取消函数）。
 * 2. V8 mock 模式接回（u17 · 验收 V8）：VITE_MOCK=true 下 settings transport 返回
 *    mock fixture，不打真实 WS。
 * 3. discoverModels 模式感知 guard（S-13 补口，原版直 mock core transport 域；
 *    adapter 收编门面后改经 @/api config spy 断言，场景与断言语义不变）：
 *    discover 模式缺 baseUrl 短路 success:false 且不调 discoverModels（不做 silent
 *    cast）；test 模式透传不校验 baseUrl（端点回落链归 runtime）。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/settings-transport-adapter.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SettingsTransport, DiscoverModelsRequest } from '@taiji/core/domain/settings'
import type {
  LlmRetryConfig,
  PiLaunchPreset,
  ProviderId,
  ProviderSource,
  QuotaConfigurePayload,
  RenameMode,
  SetProviderData,
  SkillDirConfig,
  SystemPromptConfig,
  TerminalConfig,
} from '@taiji/shared'

/** 与被测 mock 域 fixture 的对照锚（composer-data MOCK_MODELS 首条） */
const MOCK_ANCHOR_MODEL_ID = 'claude-sonnet-4.5'

afterEach(() => {
  vi.doUnmock('@/api')
  vi.resetModules()
  vi.unstubAllEnvs()
})

describe('settings-transport-adapter · @/api 门面八元全量转发矩阵（u17）', () => {
  /** 请求方法返回值哨兵（adapter 必须原样透传 resolve 值） */
  const REPLY = { probe: 'reply' }
  /** 订阅方法取消函数哨兵（adapter 必须原样透传返回的取消函数） */
  const OFF = (): void => {}
  /** 通用订阅 handler 探针（零参函数可赋任意 handler 签名） */
  const probeHandler = (): void => {}

  // ── 探针参数哨兵（值任意，只需类型合法；同一常量同时喂 call 与透传断言，防脱节）──
  const PROBE_PID = 'probe-provider' as ProviderId
  const PROBE_SOURCE: ProviderSource = 'pi'
  const PROBE_RENAME_MODE: RenameMode = 'first-stop'
  const PROBE_DIRS: SkillDirConfig[] = [{ path: 'probe/dir', enabled: true, scope: 'project' }]
  const PROBE_SYSTEM_PROMPT: SystemPromptConfig = {
    version: 1,
    replace: { enabled: true, prompt: 'probe' },
    append: { enabled: false, prompt: '' },
  }
  const PROBE_TERMINAL: TerminalConfig = {
    version: 1,
    shell: 'probe-shell',
    shellArgs: [],
    fontSize: 12,
    fontFamily: 'probe-font',
    scrollback: 100,
    cursorStyle: 'block',
    bell: false,
  }
  const PROBE_RETRY: LlmRetryConfig = { enabled: true, maxRetries: 1, baseDelayMs: 2 }
  const PROBE_QUOTA_PAYLOAD: QuotaConfigurePayload = { providerId: 'probe-provider', enabled: true }
  const PROBE_PRESET: PiLaunchPreset = {
    id: 'probe-preset',
    name: 'probe',
    builtin: false,
    order: 0,
    toolMode: 'all',
    extensionMode: 'all',
  }
  const PROBE_PROVIDER_DATA: SetProviderData = { name: 'probe', baseUrl: 'https://probe.example' }

  type FacadeDomain =
    | 'config'
    | 'model'
    | 'extension'
    | 'settings'
    | 'quota'
    | 'preset'
    | 'usage'
    | 'session'

  interface ForwardEntry {
    domain: FacadeDomain
    /** transport.<方法> 转发到的门面成员名 */
    facade: string
    /** 探针参数（与 call 收到的同一引用，用于透传断言） */
    args: readonly unknown[]
    call: (t: SettingsTransport) => unknown
  }

  /**
   * 矩阵条目工厂：args 元组绑定进 call 的 rest 探针——call 内联调用即编译期校验
   * （方法名拼错 / 参数个数或类型不符 = 编译错），运行期用同一 args 断言参数透传。
   */
  function fwd<A extends unknown[]>(
    domain: FacadeDomain,
    facade: string,
    args: A,
    call: (t: SettingsTransport, ...probe: A) => unknown,
  ): ForwardEntry {
    return { domain, facade, args, call: (t) => call(t, ...args) }
  }

  /**
   * 转发矩阵 = SettingsTransport 接口面的镜像文档。每条：transport.<方法> →
   * [门面域, 门面成员, 探针参数]，与 settings-transport-adapter.ts 逐行一一对应；
   * satisfies 键集与接口 keyof 同宽，adapter 新增转发而矩阵缺行 = 编译错。
   */
  const FORWARD_MATRIX = {
    // ════════════════ 读（请求-响应）════════════════
    listProviders: fwd('config', 'listProviders', [], (t) => t.listProviders()),
    listModels: fwd('model', 'listModels', [], (t) => t.listModels()),
    listBuiltinProviders: fwd('config', 'listBuiltinProviders', [], (t) => t.listBuiltinProviders()),
    detectSources: fwd('config', 'detectSources', [], (t) => t.detectSources()),
    refreshProviderCatalogs: fwd('config', 'refreshProviderCatalogs', [], (t) => t.refreshProviderCatalogs()),
    scanSkills: fwd('config', 'scanSkills', ['probe-skill-src'], (t, sources) => t.scanSkills(sources)),
    scanAgents: fwd('config', 'scanAgents', ['probe-agent-src'], (t, sources) => t.scanAgents(sources)),
    getGlobalSkills: fwd('config', 'getGlobalSkills', [], (t) => t.getGlobalSkills()),
    getProjectSkills: fwd('config', 'getProjectSkills', ['probe-cwd'], (t, cwd) => t.getProjectSkills(cwd)),
    previewImportProviders: fwd('config', 'previewImportProviders', [PROBE_SOURCE], (t, source) =>
      t.previewImportProviders(source),
    ),
    discoverModels: fwd(
      'config',
      'discoverModels',
      [{ baseUrl: 'https://probe.example', mode: 'discover' } as DiscoverModelsRequest],
      (t, req) => t.discoverModels(req),
    ),
    hasOAuth: fwd('config', 'hasOAuth', [PROBE_PID], (t, providerId) => t.hasOAuth(providerId)),
    checkEnvVars: fwd('config', 'checkEnvVars', [['PROBE_VAR']], (t, names) => t.checkEnvVars(names)),
    getSystemPrompt: fwd('config', 'getSystemPrompt', [], (t) => t.getSystemPrompt()),
    getTerminalConfig: fwd('config', 'getTerminalConfig', [], (t) => t.getTerminalConfig()),
    getRetryConfig: fwd('config', 'getRetryConfig', [], (t) => t.getRetryConfig()),
    getWorktreeRootDir: fwd('settings', 'getWorktreeRootDir', [], (t) => t.getWorktreeRootDir()),
    getSetupScript: fwd('settings', 'getSetupScript', [], (t) => t.getSetupScript()),
    getBareSetupScript: fwd('settings', 'getBareSetupScript', [], (t) => t.getBareSetupScript()),
    getWorktreeTimeout: fwd('settings', 'getWorktreeTimeout', [], (t) => t.getWorktreeTimeout()),
    getDefaultBaseBranch: fwd('settings', 'getDefaultBaseBranch', [], (t) => t.getDefaultBaseBranch()),
    getAutoRenameEnabled: fwd('settings', 'getAutoRenameEnabled', [], (t) => t.getAutoRenameEnabled()),
    getRenameMode: fwd('settings', 'getRenameMode', [], (t) => t.getRenameMode()),
    getRenameModel: fwd('settings', 'getRenameModel', [], (t) => t.getRenameModel()),
    getSmartContextConfig: fwd('settings', 'getSmartContextConfig', [], (t) => t.getSmartContextConfig()),
    getUsageStats: fwd('usage', 'getUsageStats', [], (t) => t.getUsageStats()),
    getSubagentEngineConfig: fwd('session', 'getSubagentEngineConfig', [], (t) => t.getSubagentEngineConfig()),
    getCachedQuota: fwd('quota', 'getCached', [PROBE_PID], (t, providerId) => t.getCachedQuota(providerId)),
    refreshQuota: fwd('quota', 'refreshQuota', [PROBE_PID], (t, providerId) => t.refreshQuota(providerId)),
    listPresets: fwd('preset', 'list', [], (t) => t.listPresets()),
    getDefaultPreset: fwd('preset', 'getDefault', [], (t) => t.getDefaultPreset()),
    fetchRecommendedExtensions: fwd('extension', 'fetchRecommended', [], (t) => t.fetchRecommendedExtensions()),

    // ════════════════ 写（动作-ack）════════════════
    setProvider: fwd('config', 'setProvider', [PROBE_PID, PROBE_PROVIDER_DATA], (t, id, data) =>
      t.setProvider(id, data),
    ),
    setScopedModels: fwd('config', 'setScopedModels', [['probe:scoped']], (t, models) => t.setScopedModels(models)),
    setDefaultModel: fwd('config', 'setDefaultModel', [PROBE_PID, 'probe-model'], (t, provider, modelId) =>
      t.setDefaultModel(provider, modelId),
    ),
    toggleProviderEnabled: fwd('config', 'toggleProviderEnabled', [PROBE_PID, true], (t, providerId, enabled) =>
      t.toggleProviderEnabled(providerId, enabled),
    ),
    removeProviderByKind: fwd('config', 'removeProviderByKind', [PROBE_PID, 'custom' as const], (t, providerId, kind) =>
      t.removeProviderByKind(providerId, kind),
    ),
    setSkillDirs: fwd('config', 'setSkillDirs', [PROBE_DIRS], (t, dirs) => t.setSkillDirs(dirs)),
    setAgentDirs: fwd('config', 'setAgentDirs', [PROBE_DIRS], (t, dirs) => t.setAgentDirs(dirs)),
    setExtensionDirs: fwd('config', 'setExtensionDirs', [PROBE_DIRS], (t, dirs) => t.setExtensionDirs(dirs)),
    applyImportProviders: fwd('config', 'applyImportProviders', ['probe-import', ['sel-1']], (t, importId, ids) =>
      t.applyImportProviders(importId, ids),
    ),
    setSystemPrompt: fwd('config', 'setSystemPrompt', [PROBE_SYSTEM_PROMPT], (t, cfg) => t.setSystemPrompt(cfg)),
    setTerminalConfig: fwd('config', 'setTerminalConfig', [PROBE_TERMINAL], (t, cfg) => t.setTerminalConfig(cfg)),
    setRetryConfig: fwd('config', 'setRetryConfig', [PROBE_RETRY], (t, cfg) => t.setRetryConfig(cfg)),
    setWorktreeRootDir: fwd('settings', 'setWorktreeRootDir', ['probe-root'], (t, dir) => t.setWorktreeRootDir(dir)),
    setSetupScript: fwd('settings', 'setSetupScript', ['probe-script'], (t, script) => t.setSetupScript(script)),
    setBareSetupScript: fwd('settings', 'setBareSetupScript', ['probe-script'], (t, script) =>
      t.setBareSetupScript(script),
    ),
    setWorktreeTimeout: fwd('settings', 'setWorktreeTimeout', [120], (t, timeout) => t.setWorktreeTimeout(timeout)),
    setDefaultBaseBranch: fwd('settings', 'setDefaultBaseBranch', ['probe-branch'], (t, branch) =>
      t.setDefaultBaseBranch(branch),
    ),
    setAutoRenameEnabled: fwd('settings', 'setAutoRenameEnabled', [true], (t, enabled) =>
      t.setAutoRenameEnabled(enabled),
    ),
    setRenameMode: fwd('settings', 'setRenameMode', [PROBE_RENAME_MODE], (t, mode) => t.setRenameMode(mode)),
    setRenameModel: fwd('settings', 'setRenameModel', ['probe-model'], (t, model) => t.setRenameModel(model)),
    setSmartContextEnabled: fwd('settings', 'setSmartContextEnabled', [true], (t, enabled) =>
      t.setSmartContextEnabled(enabled),
    ),
    setSmartContextCompactModel: fwd('settings', 'setSmartContextCompactModel', ['probe-model'], (t, model) =>
      t.setSmartContextCompactModel(model),
    ),
    setSmartContextThresholds: fwd('settings', 'setSmartContextThresholds', [[100, 200, 300]], (t, thresholds) =>
      t.setSmartContextThresholds(thresholds),
    ),
    setSmartContextExcludedModels: fwd('settings', 'setSmartContextExcludedModels', [['probe/excluded']], (t, models) =>
      t.setSmartContextExcludedModels(models),
    ),
    setSubagentDefaultEngine: fwd('session', 'setSubagentDefaultEngine', ['probe-engine'], (t, engineId) =>
      t.setSubagentDefaultEngine(engineId),
    ),
    oauthLogin: fwd('config', 'oauthLogin', [PROBE_PID], (t, providerId) => t.oauthLogin(providerId)),
    oauthCancel: fwd('config', 'oauthCancel', [PROBE_PID], (t, providerId) => t.oauthCancel(providerId)),
    oauthLogout: fwd('config', 'oauthLogout', [PROBE_PID], (t, providerId) => t.oauthLogout(providerId)),
    configureQuota: fwd('quota', 'configure', [PROBE_QUOTA_PAYLOAD], (t, payload) => t.configureQuota(payload)),
    setDefaultPreset: fwd('preset', 'setDefault', ['probe-preset'], (t, presetId) => t.setDefaultPreset(presetId)),
    createPreset: fwd('preset', 'create', [PROBE_PRESET], (t, preset) => t.createPreset(preset)),
    updatePreset: fwd('preset', 'update', [PROBE_PRESET], (t, preset) => t.updatePreset(preset)),
    removePreset: fwd('preset', 'remove', ['probe-preset'], (t, presetId) => t.removePreset(presetId)),
    toggleExtension: fwd('extension', 'toggle', ['probe-ext', true], (t, name, enabled) =>
      t.toggleExtension(name, enabled),
    ),
    installExtension: fwd('extension', 'install', ['probe-source'], (t, source) => t.installExtension(source)),
    uninstallExtension: fwd('extension', 'uninstall', ['probe-ext'], (t, name) => t.uninstallExtension(name)),
    installExtensionDir: fwd('extension', 'installDir', ['probe/dir'], (t, path) => t.installExtensionDir(path)),
    installExtensionGitRepository: fwd('extension', 'installGitRepository', ['https://probe.example/git'], (t, url) =>
      t.installExtensionGitRepository(url),
    ),
    finishExtensionInstall: fwd('extension', 'finishInstall', ['probe-temp', ['sel-1']], (t, tempDir, selected) =>
      t.finishExtensionInstall(tempDir, selected),
    ),
    cancelExtensionInstall: fwd('extension', 'cancelInstall', ['probe-temp'], (t, tempDir) =>
      t.cancelExtensionInstall(tempDir),
    ),
    upgradeExtension: fwd('extension', 'upgrade', ['probe-ext'], (t, name) => t.upgradeExtension(name)),
    setExtensionAutoUpgrade: fwd('extension', 'setAutoUpgrade', ['probe-ext', true], (t, name, enabled) =>
      t.setExtensionAutoUpgrade(name, enabled),
    ),

    // ════════════════ 订阅（返回取消函数）════════════════
    onProviders: fwd('config', 'onProviders', [probeHandler], (t, h) => t.onProviders(h)),
    onModels: fwd('model', 'onModels', [probeHandler], (t, h) => t.onModels(h)),
    onSkills: fwd('config', 'onSkills', [probeHandler], (t, h) => t.onSkills(h)),
    onAgents: fwd('config', 'onAgents', [probeHandler], (t, h) => t.onAgents(h)),
    onExtensions: fwd('extension', 'onExtensions', [probeHandler], (t, h) => t.onExtensions(h)),
    onSkillDirs: fwd('config', 'onSkillDirs', [probeHandler], (t, h) => t.onSkillDirs(h)),
    onAgentDirs: fwd('config', 'onAgentDirs', [probeHandler], (t, h) => t.onAgentDirs(h)),
    onExtensionDirs: fwd('config', 'onExtensionDirs', [probeHandler], (t, h) => t.onExtensionDirs(h)),
    onDefaults: fwd('config', 'onDefaults', [probeHandler], (t, h) => t.onDefaults(h)),
    onDefaultsWithSource: fwd('config', 'onDefaultsWithSource', [probeHandler], (t, h) => t.onDefaultsWithSource(h)),
    onSkillCacheInvalidated: fwd('config', 'onSkillCacheInvalidated', [probeHandler], (t, h) =>
      t.onSkillCacheInvalidated(h),
    ),
    onSystemPrompt: fwd('config', 'onSystemPrompt', [probeHandler], (t, h) => t.onSystemPrompt(h)),
    onTerminalConfig: fwd('config', 'onTerminalConfig', [probeHandler], (t, h) => t.onTerminalConfig(h)),
    onRetryConfig: fwd('config', 'onRetryConfig', [probeHandler], (t, h) => t.onRetryConfig(h)),
    onAuthDeviceCode: fwd('config', 'onAuthDeviceCode', [probeHandler], (t, h) => t.onAuthDeviceCode(h)),
    onAuthAuthUrl: fwd('config', 'onAuthAuthUrl', [probeHandler], (t, h) => t.onAuthAuthUrl(h)),
    onAuthSuccess: fwd('config', 'onAuthSuccess', [probeHandler], (t, h) => t.onAuthSuccess(h)),
    onAuthError: fwd('config', 'onAuthError', [probeHandler], (t, h) => t.onAuthError(h)),
  } satisfies Record<keyof SettingsTransport, ForwardEntry>

  it('SettingsTransport 接口面全量方法逐条转发：目标 = @/api 门面对应导出，参数与返回值原样透传（防回退 core/transport 直连）', async () => {
    // 每域一个 Proxy：任意成员访问都返回（并登记）同一个 spy——转发目标域.成员由此可观测。
    // 若矩阵行登记的 facade 与 adapter 实际访问的成员不符，登记的 spy 收不到调用 → 该行红；
    // 反向断言（registry 总数 = 矩阵条目数）再兜住「adapter 访问了矩阵之外的门面成员」。
    const registry = new Map<string, ReturnType<typeof vi.fn>>()
    const spyOf = (domain: FacadeDomain, facade: string): ReturnType<typeof vi.fn> => {
      const key = `${domain}.${facade}`
      const existing = registry.get(key)
      if (existing) return existing
      const spy = vi.fn()
      registry.set(key, spy)
      return spy
    }
    const domainProxy = (domain: FacadeDomain): Record<string, unknown> =>
      new Proxy(
        {},
        {
          get: (_target, prop) => (typeof prop === 'string' ? spyOf(domain, prop) : undefined),
        },
      )

    vi.resetModules()
    vi.doMock('@/api', () => ({
      config: domainProxy('config'),
      model: domainProxy('model'),
      extension: domainProxy('extension'),
      settings: domainProxy('settings'),
      quota: domainProxy('quota'),
      preset: domainProxy('preset'),
      usage: domainProxy('usage'),
      session: domainProxy('session'),
    }))
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    const transport = createSettingsTransport()

    for (const [method, entry] of Object.entries(FORWARD_MATRIX)) {
      const spy = spyOf(entry.domain, entry.facade)
      const isSubscription = method.startsWith('on')
      if (isSubscription) spy.mockReturnValue(OFF)
      else spy.mockResolvedValue(REPLY)

      const ret = entry.call(transport)

      expect(spy, `transport.${method} 必须恰好转发到 ${entry.domain}.${entry.facade} 一次`).toHaveBeenCalledTimes(1)
      if (isSubscription) {
        expect(ret, `transport.${method} 必须透传取消函数`).toBe(OFF)
      } else {
        expect(await ret, `transport.${method} 必须透传请求返回值`).toBe(REPLY)
      }
      if (method === 'onExtensions') {
        // 唯一非原样参数：adapter 包装 handler 做宽→窄 cast（见 adapter onExtensions 注释），只断言以函数调用
        expect(spy).toHaveBeenCalledWith(expect.any(Function))
      } else {
        expect(spy, `transport.${method} 参数必须原样透传`).toHaveBeenCalledWith(...entry.args)
      }
    }

    // 反向断言：adapter 没有矩阵之外的任何门面成员访问（registry 恰好登记矩阵条目数个 spy）
    expect(registry.size).toBe(Object.keys(FORWARD_MATRIX).length)

    // 同宽断言（运行期防线）：矩阵键集必须与 transport 实际转发面一致——adapter 新增转发
    // 方法而矩阵缺行 = 此处红。本测试文件未入 renderer typecheck-test 白名单，上方 satisfies
    // 编译期同宽暂不生效，以此断言兜底（typecheck 接入后两者互为冗余防线）。
    expect(Object.keys(FORWARD_MATRIX).sort()).toEqual(Object.keys(transport).sort())
  })
})

describe('settings-transport-adapter · V8 mock 模式接回（裁决 3）', () => {
  it('VITE_MOCK=true：settings 域方法解析到 mockApi（请求/订阅均返回 mock fixture，不打真实 WS）', async () => {
    vi.stubEnv('VITE_MOCK', 'true')
    vi.resetModules()
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    const transport = createSettingsTransport()

    // 请求通路：listModels / listProviders 返回 mock fixture 数据。
    // 证据力：real 域走 ws-client RPC，单测环境无 WS 连接必失败/挂起——能同步返回
    // fixture 即证明解析到了 mockApi（门面三元 isMock 分支生效）。
    const models = await transport.listModels()
    expect(models.map((m) => m.id)).toContain(MOCK_ANCHOR_MODEL_ID)

    const providersReply = await transport.listProviders()
    expect(providersReply.providers.length).toBeGreaterThan(0)
    expect(Array.isArray(providersReply.scopedModels)).toBe(true)

    // 订阅通路：onModels 注册后微任务收到 mock fixture 首推（makeMockSubscription 语义）
    const pushed: number[] = []
    const off = transport.onModels((models) => pushed.push(models.length))
    await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0))
    off()
  })
})

describe('settings-transport-adapter · discoverModels 模式感知 guard（S-13，经 @/api 门面 spy）', () => {
  async function makeTransportWithDiscoverSpy() {
    const discoverModels = vi.fn()
    vi.resetModules()
    vi.doMock('@/api', () => ({
      config: {
        listProviders: vi.fn(),
        setProvider: vi.fn(),
        setScopedModels: vi.fn(),
        discoverModels,
        setSkillDirs: vi.fn(),
        setAgentDirs: vi.fn(),
        setExtensionDirs: vi.fn(),
        onProviders: vi.fn(() => () => {}),
        onSkills: vi.fn(() => () => {}),
        onAgents: vi.fn(() => () => {}),
        onSkillDirs: vi.fn(() => () => {}),
        onAgentDirs: vi.fn(() => () => {}),
        onExtensionDirs: vi.fn(() => () => {}),
        onDefaults: vi.fn(() => () => {}),
        onSystemPrompt: vi.fn(() => () => {}),
        onTerminalConfig: vi.fn(() => () => {}),
      },
      model: { listModels: vi.fn(), onModels: vi.fn(() => () => {}) },
      extension: { onExtensions: vi.fn(() => () => {}) },
    }))
    const { createSettingsTransport } = await import('../settings-transport-adapter')
    return { transport: createSettingsTransport(), discoverModels }
  }

  it('discover 模式缺 baseUrl：短路返回 success:false 且不调 discoverModels', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    const reply = await transport.discoverModels({ mode: 'discover' })

    expect(reply).toEqual({ success: false, error: 'baseUrl is required for model discovery' })
    expect(discoverModels).not.toHaveBeenCalled()
  })

  it('mode 缺省按 discover 处理：缺 baseUrl 同样短路', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    const reply = await transport.discoverModels({})

    expect(reply.success).toBe(false)
    expect(discoverModels).not.toHaveBeenCalled()
  })

  it('test 模式缺 baseUrl：照常透传（端点回落链归 runtime，不校验 baseUrl）', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    discoverModels.mockResolvedValue({ success: true })
    const req = { mode: 'test' as const, providerId: 'p1' }
    const reply = await transport.discoverModels(req)

    expect(reply).toEqual({ success: true })
    expect(discoverModels).toHaveBeenCalledTimes(1)
    expect(discoverModels).toHaveBeenCalledWith({ ...req, mode: 'test' })
  })

  it('discover 模式带 baseUrl：正常透传（mode 缺省补全）', async () => {
    const { transport, discoverModels } = await makeTransportWithDiscoverSpy()
    discoverModels.mockResolvedValue({ success: true, models: [] })
    const reply = await transport.discoverModels({ baseUrl: 'https://api.example.com' })

    expect(reply).toEqual({ success: true, models: [] })
    expect(discoverModels).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com',
      mode: 'discover',
    })
  })
})
