/**
 * SettingsTransport —— settings 域 → transport 接入面（IF1）。
 *
 * core 域内只依赖本接口，不感知 WS/transport 实现。renderer 壳（W4）provide 时
 * 构造适配实现转发 @/api/domains；P1 transport 迁移完成后仅换实现为 core/transport
 * 直连，域内代码不动。
 *
 * [C3] settings 域 transport 访问收拢到单一 seam：settings 页（components/settings）与
 * settings composables（composables/features/settings）只经本接口访问 transport——
 * 禁止直连 `@/api` 门面、禁止深 import `@taiji/core/transport/**`。原先散落 6 处
 * 深 import（retry / smart-context / auto-rename / worktree / usage / subagent-engine）
 * 与 QuickSetup 的 `@/api` 直连全部收编为本接口方法；QuickSetup 保存与编辑体保存
 * 合流到同一 `setProvider`（quotaAutoEnabled reply 透传语义不变）。
 *
 * 两个 adapter 证明 seam 真实：real adapter（renderer settings-transport-adapter，
 * 转发 @/api/WS 命令）+ mock adapter（@/api 三元的 mock 轨，core/transport/mock）。
 *
 * 注入机制（C-W1-2）：仿 platform/port.ts 模块级单例模式——provideSettingsTransport
 * 注入、getSettingsTransport 注入前调用 fail-fast 抛错（防隐式 undefined）。
 *
 * 接口分组反映真实消费面（读 / 写 / 订阅 on*），签名与 api/domains 各域导出函数一一对齐
 * （mock 兼容硬约束：门面三元要求两侧同构）。唯二有意改名处：
 * - setProvider 保持早期 `id: string` 签名（core 消费面已按此调用，不churn）；
 * - 通用动词域（extension / preset / quota）加域前缀（toggleExtension 等），避免 80+ 方法的
 *   平铺接口出现 install/list/create 之类无归属裸名。
 */
import type {
  ProviderInfo,
  ModelInfo,
  SkillInfo,
  AgentInfo,
  ExtensionInfo,
  SkillDirConfig,
  SystemPromptConfig,
  TerminalConfig,
  SetProviderData,
  ConnectionTestResultRow,
  LlmRetryConfig,
  BuiltinProviderTemplate,
  ScannedSkillInfo,
  ScannedAgentInfo,
  SourceDetectResult,
  ProviderSource,
  ProviderImportPreview,
  ProviderImportResult,
  SkillCacheInvalidatedPayload,
  ServerMessage,
  ServerMessageMap,
  ProviderId,
  RenameMode,
  UsageStatsResult,
  PiLaunchPreset,
  NormalizedQuotaRow,
  QuotaConfigurePayload,
  QuotaFetchFailureReason,
  ExtensionDiscoveredPayload,
  RecommendedExtension,
} from '@taiji/shared'

/**
 * discoverModels 的请求载荷（与 api/domains/config.ts 的 discoverModels 签名 + shared 协议
 * `config.discoverModels` 字段对齐）。
 */
export interface DiscoverModelsRequest {
  /**
   * 请求端点。协议形状必填（shared/protocol.ts）：discover 模式必填；
   * test 模式由 runtime 忽略（端点回落链归 runtime），传 '' 占位。
   */
  baseUrl: string
  apiKey?: string
  providerType?: string
  providerId?: string
  /**
   * 模式分流（缺省 'discover'，向后兼容——runtime CLI 等旧调用方零改动）：
   * 'test' 只需 providerId（代表模型选择归 runtime，前端零推导，对齐 view-ready 原则）。
   */
  mode?: 'test' | 'discover'
}

/** discoverModels 的响应载荷（config.discoveredModels reply 形状）。 */
export interface DiscoverModelsResponse {
  success: boolean
  error?: string
  models?: Array<{ id: string; name?: string; contextWindow?: number }>
  /**
   * test 模式填：按协议分组的真实连接测试结果（每协议一条：代表模型 + 成败 + 失败原因）。
   * 旧 runtime 不下发该字段时保持 undefined——消费方降级为整体反馈行（无逐协议行）。
   * 行形状 SSOT = shared ConnectionTestResultRow。
   */
  results?: ConnectionTestResultRow[]
}

/** 远程模型目录刷新回包（refreshProviderCatalogs；failed 非空 = 目录可能过期）。 */
export interface ProviderCatalogsRefreshResult {
  refreshed: string[]
  failed: Array<{ providerId: string; reason: string }>
  /** RT-7#8：读到的损坏缓存源（'own' 自刷缓存 / 'pi' pi models-store），空数组 = 无损坏。 */
  corrupt?: Array<'own' | 'pi'>
  /** RT-7#8：刷新结果落盘失败（内存有效，下次进入页面重刷）。 */
  persistFailed?: boolean
}

/** OAuth 事件 payload（token 永不出现在 payload，脱敏红线）。 */
export type AuthDeviceCodePayload = ServerMessage<'auth.deviceCode'>['payload']
export type AuthAuthUrlPayload = ServerMessage<'auth.authUrl'>['payload']
export type AuthSuccessPayload = ServerMessage<'auth.success'>['payload']
export type AuthErrorPayload = ServerMessage<'auth.error'>['payload']

/** 额度查询快照（quota.getCached / quota.refresh 统一返回形状）。 */
export interface QuotaSnapshot {
  data: NormalizedQuotaRow | null
  lastFetchAt: number | null
  /**
   * 最近一次查询失败原因（A2-4，runtime reason 透传）：data=null 失败态出现；
   * getCached 在上次查询失败时携带（失败态渲染 + 「查看上次成功数据」归 Phase B）。
   */
  reason?: QuotaFetchFailureReason
}

/**
 * settings 域所需的最小 transport facade。
 * - 订阅函数（on*）返回取消函数（与现有 @/api on* 签名一致）。
 * - 请求函数与现有 api/domains 各域签名对齐（mock 兼容硬约束）。
 *
 * 分组 = 读（请求-响应）/ 写（动作-ack）/ 订阅（on*，返回取消函数）。
 */
export interface SettingsTransport {
  // ══════════════════════ 读（请求-响应）══════════════════════

  // ── provider / 模型 / 目录 ──
  /** providers 快照 + scoped models 白名单（reply 未携带 scopedModels 时为 undefined，消费方守卫不覆盖） */
  listProviders(): Promise<{ providers: ProviderInfo[]; scopedModels?: string[] }>
  /** 聚合模型列表主动拉取（对齐 listProviders，连接后兜底防订阅时序竞态） */
  listModels(): Promise<ModelInfo[]>
  /** 内置 provider 模板（QuickSetup 模板选择器数据源） */
  listBuiltinProviders(): Promise<BuiltinProviderTemplate[]>
  /** 检测本机已安装的源 agent（只读；不读文件内容、不提取凭据） */
  detectSources(): Promise<SourceDetectResult[]>
  /** 进入 Settings Provider 页触发远程模型目录刷新（fail-safe；failed 非空 → 目录可能过期） */
  refreshProviderCatalogs(): Promise<ProviderCatalogsRefreshResult>
  /** 按 sources 扫描 skill（加入 discovery） */
  scanSkills(sources: string[]): Promise<ScannedSkillInfo[]>
  /** 按 sources 扫描 agent */
  scanAgents(sources: string[]): Promise<ScannedAgentInfo[]>
  /** 全局 skill（skillRegistry globalCache，landing slash 命令源） */
  getGlobalSkills(): Promise<SkillInfo[]>
  /** 按 cwd 拉项目 skill（skillRegistry projectCache，带缓存 + watcher） */
  getProjectSkills(cwd: string): Promise<SkillInfo[]>
  /**
   * 预览从源 agent 导入的 provider（脱敏；错误以 envelope 返回，不 reject）。
   */
  previewImportProviders(
    source: ProviderSource,
  ): Promise<{ importId: string; preview: ProviderImportPreview } | { error: { code: string; message: string } }>
  /** 远程模型发现 + 连接测试（mode 分流，见 DiscoverModelsRequest） */
  discoverModels(req: DiscoverModelsRequest): Promise<DiscoverModelsResponse>
  /** query auth.json 是否已有该 provider 的 OAuth 凭据（只返回布尔——token 永不出协议） */
  hasOAuth(providerId: string): Promise<boolean>
  /** 批量检测环境变量是否已设置（只返回布尔不返回值——env 值可能含凭证） */
  checkEnvVars(names: string[]): Promise<Record<string, boolean>>

  // ── system 设置项（system prompt / 终端 / LLM 重试）──
  /** 读取系统提示词配置（corrupted=true：磁盘损坏已回退默认） */
  getSystemPrompt(): Promise<{ config: SystemPromptConfig; corrupted: boolean }>
  /** 读取终端配置（corrupted 语义同 getSystemPrompt） */
  getTerminalConfig(): Promise<{ config: TerminalConfig; corrupted: boolean }>
  /** 读取 LLM 重试配置（configured=false：无显式 retry 配置，config 为合并 pi 默认后的值） */
  getRetryConfig(): Promise<{ config: LlmRetryConfig; configured: boolean }>

  // ── system 设置项（worktree / 自动重命名 / 智能上下文，reply 为协议 envelope 原样）──
  getWorktreeRootDir(): Promise<ServerMessageMap['config.worktreeRootDir']>
  getSetupScript(): Promise<ServerMessageMap['config.setupScript']>
  getBareSetupScript(): Promise<ServerMessageMap['config.bareSetupScript']>
  getWorktreeTimeout(): Promise<ServerMessageMap['config.worktreeTimeout']>
  getDefaultBaseBranch(): Promise<ServerMessageMap['config.defaultBaseBranch']>
  getAutoRenameEnabled(): Promise<ServerMessageMap['config.autoRenameEnabled']>
  getRenameMode(): Promise<ServerMessageMap['config.renameMode']>
  getRenameModel(): Promise<ServerMessageMap['config.renameModel']>
  /** 智能上下文压缩配置全量（compactModel 空串 = 未设置；thresholds 为 token 绝对数） */
  getSmartContextConfig(): Promise<ServerMessageMap['config.smartContextConfig']>

  // ── 用量 / 子代理引擎 ──
  /** 用量统计（session JSONL 扫描聚合） */
  getUsageStats(): Promise<UsageStatsResult>
  /** 子代理引擎清单 + 当前默认引擎 */
  getSubagentEngineConfig(): Promise<{ engines: string[]; defaultEngine: string }>

  // ── coding-plan 额度 ──
  /** 读缓存不发起请求（无缓存返回 { data: null, lastFetchAt: null }） */
  getCachedQuota(providerId: string): Promise<QuotaSnapshot>
  /** 强制刷新额度（绕过 throttle，Settings 测试查询按钮专用；失败态不抛错） */
  refreshQuota(providerId: string): Promise<QuotaSnapshot>

  // ── pi 启动预设 ──
  /** 全部预设（内置 + 自定义） */
  listPresets(): Promise<PiLaunchPreset[]>
  /** 全局默认预设 id（缺省 'builtin:full'） */
  getDefaultPreset(): Promise<string>

  // ── 扩展 ──
  /** 推荐扩展列表（含已安装状态） */
  fetchRecommendedExtensions(): Promise<Array<RecommendedExtension & { installed: boolean }>>

  // ══════════════════════ 写（动作-ack）══════════════════════

  // ── provider / 模型 / 目录 ──
  /**
   * 保存 provider（QuickSetup 保存与编辑体保存的唯一入口）。返回 quotaAutoEnabled
   * （新建分支自动开启 coding-plan 额度显示写成功），供调用方 toast。
   */
  setProvider(id: string, data: SetProviderData): Promise<{ quotaAutoEnabled?: boolean }>
  /** 设置 scoped models 白名单（provider/modelId 复合串数组，序=显示序；[]=清除），返回规范化结果 */
  setScopedModels(models: string[]): Promise<string[]>
  /** 设默认模型（状态经 onDefaults 广播推回，调用方无需本地乐观更新） */
  setDefaultModel(provider: ProviderId, modelId: string): Promise<void>
  /** provider 启用切换（wave4 C1：写 enabledModels 白名单） */
  toggleProviderEnabled(providerId: ProviderId, enabled: boolean): Promise<void>
  /** 按体系移除 provider（catalog 清凭据 / custom 删条目） */
  removeProviderByKind(providerId: ProviderId, kind: 'catalog' | 'custom'): Promise<void>
  /** 覆盖 skill 加载路径配置（v2 scope 穿越，靠前覆盖靠后） */
  setSkillDirs(dirs: SkillDirConfig[]): Promise<void>
  setAgentDirs(dirs: SkillDirConfig[]): Promise<void>
  setExtensionDirs(dirs: SkillDirConfig[]): Promise<void>
  /** 应用选中的 provider 导入（错误以 envelope 返回，不 reject） */
  applyImportProviders(
    importId: string,
    selectedIds: string[],
  ): Promise<{ result: ProviderImportResult } | { error: { code: string; message: string } }>

  // ── system 设置项（system prompt / 终端 / LLM 重试）──
  /** 保存系统提示词配置（replace + append；失败 reject） */
  setSystemPrompt(config: SystemPromptConfig): Promise<{ config: SystemPromptConfig; corrupted: boolean }>
  /** 保存终端配置（失败 reject） */
  setTerminalConfig(config: TerminalConfig): Promise<{ config: TerminalConfig; corrupted: boolean }>
  /** 保存 LLM 重试配置（整体保存；越界 reject） */
  setRetryConfig(config: LlmRetryConfig): Promise<{ config: LlmRetryConfig; configured: boolean }>

  // ── system 设置项（worktree / 自动重命名 / 智能上下文）──
  setWorktreeRootDir(dir: string): Promise<ServerMessageMap['config.worktreeRootDir']>
  setSetupScript(script: string): Promise<ServerMessageMap['config.setupScript']>
  setBareSetupScript(script: string): Promise<ServerMessageMap['config.bareSetupScript']>
  /** worktree 创建超时（秒） */
  setWorktreeTimeout(timeout: number): Promise<ServerMessageMap['config.worktreeTimeout']>
  setDefaultBaseBranch(baseBranch: string): Promise<ServerMessageMap['config.defaultBaseBranch']>
  setAutoRenameEnabled(enabled: boolean): Promise<ServerMessageMap['config.autoRenameEnabled']>
  /** rename 触发模式（非法值由 runtime 侧归一为默认 first-stop） */
  setRenameMode(mode: RenameMode): Promise<ServerMessageMap['config.renameMode']>
  /** rename 标题生成模型（"provider/modelId"，空串 = 清除回未设置） */
  setRenameModel(model: string): Promise<ServerMessageMap['config.renameModel']>
  setSmartContextEnabled(enabled: boolean): Promise<ServerMessageMap['config.smartContextEnabled']>
  /** 压缩模型（"provider/modelId"，空串 = 跟随当前会话模型） */
  setSmartContextCompactModel(model: string): Promise<ServerMessageMap['config.smartContextCompactModel']>
  /** 3 档提醒阈值（token 绝对数，runtime 侧 clamp 升序 3 档） */
  setSmartContextThresholds(thresholds: number[]): Promise<ServerMessageMap['config.smartContextThresholds']>
  /** 排除模型列表（每条完整 provider/modelId，runtime 侧过滤去重） */
  setSmartContextExcludedModels(models: string[]): Promise<ServerMessageMap['config.smartContextExcludedModels']>

  // ── 子代理引擎 ──
  /** 设置全局默认子代理引擎（写 config.json，新 session 生效） */
  setSubagentDefaultEngine(engineId: string): Promise<{ engineId: string }>

  // ── OAuth ──
  /** 启动 OAuth flow（device/callback；started=false + error = 启动失败） */
  oauthLogin(providerId: string): Promise<{ started: boolean; error?: string }>
  /** 中止进行中的 OAuth flow（幂等） */
  oauthCancel(providerId: string): Promise<{ cancelled: boolean }>
  /** 退出登录：移除 auth.json 凭证（幂等；ok=false + error = 移除失败，error 由 runtime 透传） */
  oauthLogout(providerId: string): Promise<{ ok: boolean; error?: string }>

  // ── coding-plan 额度 ──
  /** 额度配置（整对象透传 payload；各可选键缺省 = 不变，enabled=false 不删缓存） */
  configureQuota(payload: QuotaConfigurePayload): Promise<{ ok: boolean; error?: string }>

  // ── pi 启动预设 ──
  /** 设全局默认预设（id 必须存在，否则抛错） */
  setDefaultPreset(presetId: string): Promise<void>
  /** 创建自定义预设（reply 为 runtime 补全后的权威态） */
  createPreset(preset: PiLaunchPreset): Promise<PiLaunchPreset>
  /** 更新预设（内置预设 name/id/builtin 不可改，runtime guard 拦截） */
  updatePreset(preset: PiLaunchPreset): Promise<PiLaunchPreset>
  /** 删除自定义预设（内置不可删） */
  removePreset(presetId: string): Promise<void>

  // ── 扩展 ──
  /** 切换扩展启用/禁用（reply 携带最新扩展列表快照） */
  toggleExtension(name: string, enabled: boolean): Promise<{ extensions: ExtensionInfo[] }>
  /** npm 包名直装（单步） */
  installExtension(source: string): Promise<void>
  uninstallExtension(name: string): Promise<void>
  /** 本地目录安装（多步第一步：返回候选） */
  installExtensionDir(path: string): Promise<ExtensionDiscoveredPayload>
  /** Git URL 安装（多步第一步：返回候选） */
  installExtensionGitRepository(url: string): Promise<ExtensionDiscoveredPayload>
  /** 完成安装（多步第二步：选中候选落 extensions/） */
  finishExtensionInstall(tempDir: string, selected: string[]): Promise<void>
  /** 放弃安装（清理 tempDir） */
  cancelExtensionInstall(tempDir: string): Promise<void>
  upgradeExtension(name: string): Promise<void>
  setExtensionAutoUpgrade(name: string, enabled: boolean): Promise<void>

  // ══════════════════════ 订阅（on*，返回取消函数）══════════════════════

  // ── provider / 模型 / 目录 ──
  onProviders(h: (p: ProviderInfo[], scopedModels?: string[]) => void): () => void
  /** 聚合模型列表（与 providers 同源，常驻订阅，model.onModels 对应） */
  onModels(h: (m: ModelInfo[]) => void): () => void
  onSkills(h: (s: SkillInfo[]) => void): () => void
  onAgents(h: (a: AgentInfo[]) => void): () => void
  onExtensions(h: (e: ExtensionInfo[]) => void): () => void
  onSkillDirs(h: (d: SkillDirConfig[]) => void): () => void
  onAgentDirs(h: (d: SkillDirConfig[]) => void): () => void
  onExtensionDirs(h: (d: SkillDirConfig[]) => void): () => void
  onDefaults(h: (m: string) => void): () => void
  /** 带 source 的 defaults 订阅（区分 runtime 自动修复默认模型与用户主动设置） */
  onDefaultsWithSource(h: (payload: { defaultModel: string; source?: string }) => void): () => void
  /** skill 缓存失效信号（scope='global' 全局重拉 / 'project' 按 cwd 路由） */
  onSkillCacheInvalidated(h: (payload: SkillCacheInvalidatedPayload) => void): () => void

  // ── system 设置项 ──
  onSystemPrompt(h: (cfg: SystemPromptConfig, corrupted: boolean) => void): () => void
  onTerminalConfig(h: (cfg: TerminalConfig, corrupted: boolean) => void): () => void
  /** LLM 重试配置广播（多窗口同步） */
  onRetryConfig(h: (payload: { config: LlmRetryConfig; configured: boolean }) => void): () => void

  // ── OAuth 事件 ──
  /** device flow 中间态（验证码 + 验证链接 + 倒计时） */
  onAuthDeviceCode(h: (payload: AuthDeviceCodePayload) => void): () => void
  /** callback flow 中间态（授权 URL + 本地回调端口） */
  onAuthAuthUrl(h: (payload: AuthAuthUrlPayload) => void): () => void
  /** 授权成功（token 已写 auth.json） */
  onAuthSuccess(h: (payload: AuthSuccessPayload) => void): () => void
  /** 授权失败 */
  onAuthError(h: (payload: AuthErrorPayload) => void): () => void
}

/**
 * SettingsTransport 注入点容器（可实例化 seam slot）。
 *
 * 生产用模块级 defaultSlot；测试需要「未注入态」时用 createSettingsTransportSlot()
 * 新建独立 slot 断言 fail-fast，不碰默认 slot（无 reset 后门，实例即隔离）。
 */
export interface SettingsTransportSlot {
  provide(transport: SettingsTransport): void
  /** 未注入时 fail-fast 抛错（防隐式 undefined）。 */
  get(): SettingsTransport
}

export function createSettingsTransportSlot(): SettingsTransportSlot {
  let current: SettingsTransport | null = null
  return {
    provide(transport: SettingsTransport): void {
      current = transport
    },
    get(): SettingsTransport {
      if (!current) {
        throw new Error(
          '[core/domain/settings] getSettingsTransport() called before provideSettingsTransport() — transport not injected',
        )
      }
      return current
    },
  }
}

const defaultSlot = createSettingsTransportSlot()

/** 壳 bootstrap / 测试注入 transport 适配实现（模块级单例）。 */
export function provideSettingsTransport(transport: SettingsTransport): void {
  defaultSlot.provide(transport)
}

/** 获取已注入的 transport。注入前调用 fail-fast 抛错（防隐式 undefined）。 */
export function getSettingsTransport(): SettingsTransport {
  return defaultSlot.get()
}
