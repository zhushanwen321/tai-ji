/**
 * ConfigService — facade for Provider/Skill/Agent/Preferences CRUD.
 *
 * Delegates Provider CRUD to IConfigStore (injected port; impl wraps pi's
 * models.json), Skill/Agent discovery to discovery.json SSOT + scanners
 * (ADR-0021 §1：强制目录 ∪ discovery 目录，按优先级合并去重).
 * Tool permissions are persisted to ~/.taiji/config.json (taiji own config).
 *
 * 重构说明（Phase 1 拆分）：本文件曾是 Config 域唯一 facade（1059 行，超 ESLint max-lines）。
 * 现已按职责拆到多个 config helper（provider / skill / agent / system-prompt / terminal /
 * app-config-store / worktree-config-helper / rename-session-config / smart-context-config，
 * 后两者与 ext-config-rmw 共享 RMW 基建自 worktree-config-helper 名实拆分迁入），本文件
 * 退化为构造 + appConfig IO + 单行委托桩，
 * 行为 / 签名 / import 路径零变化（复用 worktree-config-helper 验证的 accessors 注入模式）。
 * IConfigService 接口不动，现有测试不改动即全绿（行为零变化的证据）。
 */
import { homedir } from 'node:os'
import {
  type ProviderInfo,
  type BuiltinProviderTemplate,
  type SkillInfo,
  type AgentInfo,
  type ScannedSkillInfo,
  type ScannedAgentInfo,
  type SystemPromptConfig,
  type TerminalConfig,
  type SourceDetectResult,
  type ProviderSource,
  type ProviderImportPreview,
  type ProviderImportResult,
  type SkillDirConfig,
  type ProviderId,
  type LlmRetryConfig,
  type RenameMode,
} from '@taiji/shared'
import type { IConfigService } from '../interfaces.js'
import type { IConfigStore } from './ports/config.js'
import type { AuthStorage, CredentialWriter } from './auth/auth-storage.js'
import type { DirScopes } from './skill-dir-config.js'
import { detectSources as detectSourcesImpl, previewImport as previewImportImpl, applyImport as applyImportImpl } from './migration/index.js'
import {
  getWorktreeRootDir as getWorktreeRootDirImpl,
  setWorktreeRootDir as setWorktreeRootDirImpl,
  getSetupScript as getSetupScriptImpl,
  setSetupScript as setSetupScriptImpl,
  getBareSetupScript as getBareSetupScriptImpl,
  setBareSetupScript as setBareSetupScriptImpl,
  getTimeout as getTimeoutImpl,
  setTimeout as setTimeoutImpl,
  getDefaultBaseBranch as getDefaultBaseBranchImpl,
  setDefaultBaseBranch as setDefaultBaseBranchImpl,
} from './worktree-config-helper.js'
import {
  getAutoRenameEnabled as getAutoRenameEnabledImpl,
  setAutoRenameEnabled as setAutoRenameEnabledImpl,
  getRenameModel as getRenameModelImpl,
  setRenameModel as setRenameModelImpl,
  getRenameMode as getRenameModeImpl,
  setRenameMode as setRenameModeImpl,
} from './rename-session-config.js'
import {
  getSmartContextConfig as getSmartContextConfigImpl,
  setSmartContextEnabled as setSmartContextEnabledImpl,
  setSmartContextCompactModel as setSmartContextCompactModelImpl,
  setSmartContextThresholds as setSmartContextThresholdsImpl,
  setSmartContextExcludedModels as setSmartContextExcludedModelsImpl,
  type SmartContextConfigSnapshot,
} from './smart-context-config.js'
import { loadAppConfig as loadAppConfigImpl, saveAppConfig as saveAppConfigImpl } from './app-config-store.js'
import {
  getDefaultModel as getDefaultModelImpl,
  setDefaultModel as setDefaultModelImpl,
  listProviders as listProvidersImpl,
  listBuiltinProviders as listBuiltinProvidersImpl,
  checkEnvVars as checkEnvVarsImpl,
  getProvider as getProviderImpl,
  setProvider as setProviderImpl,
  toggleProviderEnabled as toggleProviderEnabledImpl,
  deleteProvider as deleteProviderImpl,
  removeProviderByKind as removeProviderByKindImpl,
  type ProviderExtrasServiceDeps,
  type SetProviderInput,
  type QuotaStateCleaner,
} from './provider-config-helper.js'
import {
  refreshProviderCatalogs as refreshProviderCatalogsImpl,
  type CatalogRefreshResult,
} from './provider-catalog-refresh.js'
import {
  loadSkills as loadSkillsImpl,
  saveSkills as saveSkillsImpl,
  upsertSkill as upsertSkillImpl,
  deleteSkill as deleteSkillImpl,
  scanSkills as scanSkillsImpl,
} from './skill-config-helper.js'
import {
  loadAgents as loadAgentsImpl,
  saveAgents as saveAgentsImpl,
  upsertAgent as upsertAgentImpl,
  deleteAgent as deleteAgentImpl,
  scanAgents as scanAgentsImpl,
} from './agent-config-helper.js'
import {
  getSystemPromptConfig as getSystemPromptConfigImpl,
  setSystemPromptConfig as setSystemPromptConfigImpl,
  getReplaceSystemPrompt as getReplaceSystemPromptImpl,
} from './system-prompt-config-helper.js'
import {
  getTerminalConfig as getTerminalConfigImpl,
  setTerminalConfig as setTerminalConfigImpl,
} from './terminal-config-helper.js'
import type { ILlmRetrySettings, LlmRetryConfigSnapshot } from './ports/llm-retry-settings.js'
import type { IProviderCredentialResolver } from './ports/provider-credential-resolver.js'

// ── Service ─────────────────────────────────────────────────────

export class ConfigService implements IConfigService {
  constructor(
    private projectRoot: string,
    private configStore: IConfigStore,
    /**
     * auth.json 存储读取/清理能力（OAuth 路径 B）。
     * 不含 'set'——写入唯一经 credentialWriter（A1-4 收口）：
     * I9 清理①：setProvider 保存 apiKey 时清 auth.json oauth 凭据（both provider 切换凭据源）；
     * I8：deleteProvider 时同步清 auth.json（防 OAuth token 永久残留）。
     * 可选注入：未注入时两处清理 no-op（测试/无 OAuth 场景）。
     */
    private authStorage?: Pick<AuthStorage, 'remove' | 'hasOAuth' | 'hasOAuthSync' | 'hasCredentialSync' | 'listCredentialIds'>,
    /**
     * providers.json 存储全量能力（A1-5 写侧切换 + A1-3 读源切换 + scoped-model + 删除链）：
     * 写 setProvider 的 authMethod；listProviders 聚合读 authMethod/quota/modelStates（双读
     * 回退：providers.json 优先 + models.json 旧寄生字段兜底）；getScopedModelsSync/
     * modifyScopedModels 支撑顶层 scopedModels 读写；deleteProvider / removeProviderByKind
     * 删除链清 extras 与 scoped 残留（M5-05「清残留」不变式）。
     * 可选注入：未注入时 authMethod 丢弃 + warn（宁丢不写错位），聚合层 extras 恒空
     * （authMethod 退回推断、quota undefined），删除链 extras 清理 no-op，生产恒注入。
     * 能力分域见 provider-config-helper.ts 的 ProviderExtras* 类型注释。
     */
    private providerExtrasStore?: ProviderExtrasServiceDeps,
    /**
     * LLM 重试配置域 port（pi settings.json 的 retry 字段，设计 llm-retry-settings §3.4）。
     * infra 实现 PiRetrySettings 在组合根注入。可选注入：未注入时 get/set 抛错
     * （生产恒注入；既有测试不关心 retry 域可不传）。
     */
    private llmRetrySettings?: ILlmRetrySettings,
    /**
     * Provider 凭据解析唯一通道（D3 收口，链 5 消费点）：listProviders 的凭据判定经其批量
     * sync 版单次取（auth.json ∪ models.json）。M2fg 删降级后无回退——生产恒注入；参数保持
     * 可选只为不强迫与 provider 无关的测试构造点（terminal-config / streaming-idle 等 46 处）
     * 注入替身，listProviders / toggleProviderEnabled / removeProviderByKind 消费点经
     * resolver() 访问器显式守卫锁定恒注入前提（少参构造 + 调这三法 = 带恢复指引的 Error，
     * 属测试构造错误；不用 `!` 断言——那会把 undefined 静默传进必参，深处 TypeError 才暴露）。
     */
    private providerCredentialResolver?: IProviderCredentialResolver,
    /**
     * quota 副产物清理（D12/改动 5）：provider 删除链清 secrets/<pid>-{cookie,apikey}.txt
     * 明文 + 内存失败/节流标记 + 额度缓存条目。只在 extras 条目确认清除后执行（排序约束，
     * 防幽灵标记，见 provider-config-helper.cleanDeleteTail）。
     * 可选注入：未注入时该步 no-op（测试场景），生产恒注入——组合根经 setQuotaStateCleaner
     * 后置回填（QuotaService 依赖 ConfigService，构造期拿不到）。
     */
    private quotaStateCleaner?: QuotaStateCleaner,
  ) {}

  /**
   * auth.json 凭据写通道（A1-4 收口）：setProvider 的 catalog apiKey 写入与
   * applyImportProviders 的凭据导入经此（AuthService.saveCredential），不再直接
   * 持有 authStorage.set。setter 注入：AuthService 依赖 configService
   * （listBuiltinProviders 取 oauthConfig），组合根在 AuthService 构造后回填——
   * 回填前无 RPC 处理（server.start 在全部装配后），无窗口期风险。
   * 未注入时 catalog apiKey 丢弃（宁丢不写错位，生产恒注入）。
   */
  private credentialWriter?: CredentialWriter

  setCredentialWriter(writer: CredentialWriter): void {
    this.credentialWriter = writer
  }

  /**
   * quota 副产物清理回填（D12/改动 5）：QuotaService 依赖 ConfigService（providerExists /
   * readExtrasWithFallback），构造在 configService 之后——组合根在 quotaService 构造后回填
   * （先例 setCredentialWriter）；回填前无 RPC 处理（server.start 在全部装配后），无窗口期。
   * 未注入时删除链的 quota 清理 no-op（可选注入语义）——漏回填不会编译报错而是静默失效。
   */
  setQuotaStateCleaner(cleaner: QuotaStateCleaner): void {
    this.quotaStateCleaner = cleaner
  }

  // ── Provider CRUD（委托 provider-config-helper）─────────────────

  /**
   * resolver 显式守卫访问器：可选构造参数 + 消费点统一断言。与 provider 无关的构造点
   * （skill-registry 局部实例只调 loadSkills 等）不经此路径不受影响；调到 provider 三方法
   * 而未注入 = 构造错误，报错指向恢复动作（注入 resolver / 改用 provider 无关实例），
   * 不做 `!` 断言把 undefined 静默传进必参。
   */
  private resolver(): IProviderCredentialResolver {
    if (!this.providerCredentialResolver) {
      throw new Error(
        '[config-service] providerCredentialResolver 未注入：listProviders / toggleProviderEnabled / removeProviderByKind 需要凭据解析唯一通道（D3）。恢复：在组合根构造 ConfigService 时注入 resolver；若调用点与 provider 无关，改用不触这三法的实例',
      )
    }
    return this.providerCredentialResolver
  }

  getDefaultModel(): { provider: ProviderId; modelId: string } | null {
    return getDefaultModelImpl(this.configStore)
  }

  setDefaultModel(provider: ProviderId, modelId: string): void {
    setDefaultModelImpl(this.configStore, provider, modelId)
  }

  listProviders(): ProviderInfo[] {
    // 显式守卫 = 恒注入前提（组合根 index.ts 装配序测试锁定；M2fg 删降级后无回退）
    return listProvidersImpl(this.configStore, this.authStorage, this.providerExtrasStore, this.resolver())
  }

  /**
   * 远程模型目录按需刷新（settings-provider 页进入时触发）。
   * 刷新范围 = 当前聚合列表内的 catalog provider（有凭据/已配置的才会出现在列表里）。
   * 完成后调用方（settings-message-handler）负责 reply + broadcastProviderList。
   */
  async refreshProviderCatalogs(): Promise<CatalogRefreshResult> {
    const catalogIds = this.listProviders()
      .filter(p => p.kind === 'catalog')
      .map(p => p.id)
    return refreshProviderCatalogsImpl(catalogIds)
  }

  listBuiltinProviders(): BuiltinProviderTemplate[] {
    return listBuiltinProvidersImpl()
  }

  checkEnvVars(names: string[]): Record<string, boolean> {
    return checkEnvVarsImpl(names)
  }

  async setProvider(providerId: string, data: SetProviderInput): Promise<{ newDefault?: { provider: ProviderId; modelId: string } }> {
    return setProviderImpl(this.configStore, this.authStorage, this.providerExtrasStore, this.credentialWriter, providerId, data)
  }

  toggleProviderEnabled(providerId: string, enabled: boolean): { newDefault?: { provider: ProviderId; modelId: string } } {
    return toggleProviderEnabledImpl(this.configStore, this.authStorage, this.providerExtrasStore, this.resolver(), providerId, enabled)
  }

  async deleteProvider(providerId: string): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }> {
    return deleteProviderImpl(this.configStore, this.authStorage, this.providerExtrasStore, providerId, this.quotaStateCleaner)
  }

  async removeProviderByKind(providerId: string, kind: 'catalog' | 'custom'): Promise<{ removed: boolean; newDefault?: { provider: ProviderId; modelId: string } }> {
    return removeProviderByKindImpl(this.configStore, this.authStorage, this.providerExtrasStore, this.resolver(), providerId, kind, this.quotaStateCleaner)
  }

  getProvider(providerId: string): { apiKey?: string; name?: string; type?: string; baseUrl?: string; models?: unknown[]; enabled?: boolean } | undefined {
    return getProviderImpl(this.configStore, providerId)
  }

  // ── Tool permissions (persisted to ~/.taiji/config.json) ───

  getPiAgentDir(): string {
    return this.configStore.getPiAgentDir()
  }

  getConfigDir(): string {
    return this.configStore.getConfigDir()
  }

  private loadAppConfig(): Record<string, unknown> {
    return loadAppConfigImpl(this.configStore.getConfigDir())
  }

  private saveAppConfig(config: Record<string, unknown>): void {
    saveAppConfigImpl(this.configStore.getConfigDir(), config)
  }

  updateToolPermissions(permissions: Record<string, string>): void {
    const config = this.loadAppConfig()
    config['toolPermissions'] = permissions
    this.saveAppConfig(config)
  }

  // ── Worktree / rename-session / smart-context config ──────────────
  // worktree 偏好委托 worktree-config-helper；auto-rename/rename 委托 rename-session-config；
  // smart-context 委托 smart-context-config（P1-7 名实拆分后各归其位）。
  // loadAppConfig / saveAppConfig 仍为 private，通过 appConfig() 暴露 accessors 注入。

  private appConfig(): { load(): Record<string, unknown>; save(config: Record<string, unknown>): void } {
    return {
      load: () => this.loadAppConfig(),
      save: c => this.saveAppConfig(c),
    }
  }

  getWorktreeRootDir(): string {
    return getWorktreeRootDirImpl(this.appConfig())
  }

  setWorktreeRootDir(dir: string): void {
    setWorktreeRootDirImpl(this.appConfig(), dir)
  }

  getSetupScript(): string {
    return getSetupScriptImpl(this.appConfig())
  }

  setSetupScript(script: string): void {
    setSetupScriptImpl(this.appConfig(), script)
  }

  getBareSetupScript(): string {
    return getBareSetupScriptImpl(this.appConfig())
  }

  setBareSetupScript(script: string): void {
    setBareSetupScriptImpl(this.appConfig(), script)
  }

  getTimeout(): number {
    return getTimeoutImpl(this.appConfig())
  }

  setTimeout(timeout: number): void {
    setTimeoutImpl(this.appConfig(), timeout)
  }

  getDefaultBaseBranch(): string {
    return getDefaultBaseBranchImpl(this.appConfig())
  }

  setDefaultBaseBranch(baseBranch: string): void {
    setDefaultBaseBranchImpl(this.appConfig(), baseBranch)
  }

  /** 读取 auto-rename 开关（标志文件存在=开，默认 false）。不经 appConfig（独立标志文件，非 config.json 字段）。 */
  getAutoRenameEnabled(): boolean {
    return getAutoRenameEnabledImpl()
  }

  /** 设置 auto-rename 开关（true 创建标志文件 / false 删除）。 */
  setAutoRenameEnabled(enabled: boolean): void {
    setAutoRenameEnabledImpl(enabled)
  }

  /** 读取 rename 标题生成模型（"provider/modelId"，未设置 = 空串；extension 配置文件，非 config.json 字段）。 */
  getRenameModel(): string {
    return getRenameModelImpl()
  }

  /** 设置 rename 标题生成模型（读改写 extension 配置文件的 model 字段，保留其他字段）。 */
  setRenameModel(model: string): void {
    setRenameModelImpl(model)
  }

  /** 读取 rename 触发模式（first-prompt/first-stop/agent-tool；extension 配置文件，缺失/非法回默认 first-stop）。 */
  getRenameMode(): RenameMode {
    return getRenameModeImpl()
  }

  /** 设置 rename 触发模式（读改写 extension 配置文件的 mode 字段，非法值归一默认，保留其他字段）。 */
  setRenameMode(mode: RenameMode): void {
    setRenameModeImpl(mode)
  }

  /** 读取智能上下文压缩配置快照（extension 配置文件，字段非法回退默认值）。 */
  getSmartContextConfig(): SmartContextConfigSnapshot {
    return getSmartContextConfigImpl()
  }

  /** 设置智能上下文压缩开关（读改写 extension 配置文件的 enabled 字段，保留其他字段）。 */
  setSmartContextEnabled(enabled: boolean): void {
    setSmartContextEnabledImpl(enabled)
  }

  /** 设置压缩模型（读改写 compactModel 字段；空串 = 跟随当前会话模型）。 */
  setSmartContextCompactModel(model: string): void {
    setSmartContextCompactModelImpl(model)
  }

  /** 设置 3 档提醒阈值（token 绝对数；clamp 升序 3 档，空回退默认）。 */
  setSmartContextThresholds(thresholds: number[]): void {
    setSmartContextThresholdsImpl(thresholds)
  }

  /** 设置排除模型列表（过滤无 "/" 条目去重后写入 excludedModels 字段）。 */
  setSmartContextExcludedModels(models: string[]): void {
    setSmartContextExcludedModelsImpl(models)
  }

  // ── Scoped Models（委托 provider-extras-store）──

  /**
   * 显式守卫 = 恒注入前提（组合根 index.ts 恒注入；构造参数非后置回填，无窗口期）。
   * 三个消费点（model-service / provider-message-handler / message-broker）全经组合根
   * 实例；与 provider 无关的局部实例（skill-registry）不触此法。静默返回 [] 会把
   * 「装配错误」伪装成「白名单为空」的合法状态广播出去，与 write 侧 modifyScopedModels
   * 的抛错语义也不对称——未注入即构造错误，报错指向恢复动作（同 resolver() 模式）。
   */
  getScopedModels(): string[] {
    if (!this.providerExtrasStore) {
      throw new Error(
        '[config-service] providerExtrasStore 未注入：getScopedModels 需要 providers.json 存储能力（scoped models 读）。恢复：在组合根构造 ConfigService 时注入 providerExtrasStore；若调用点与 provider 无关，改用不触此法的实例',
      )
    }
    return this.providerExtrasStore.getScopedModelsSync()
  }

  async modifyScopedModels(fn: (current: string[]) => string[]): Promise<string[]> {
    if (!this.providerExtrasStore) {
      throw new Error('[config-service] providerExtrasStore not available (scoped models write)')
    }
    return this.providerExtrasStore.modifyScopedModels(fn)
  }

  // ── Skill CRUD（委托 skill-config-helper）─────────────────────────

  loadSkills(projectRoot: string): SkillInfo[] {
    return loadSkillsImpl(this.configStore, projectRoot)
  }

  /** No-op: skills are discovered from discovery.json + forced dirs, not independently persisted. */
  saveSkills(projectRoot: string, skills: SkillInfo[]): void {
    saveSkillsImpl(projectRoot, skills)
  }

  /** @deprecated ADR-0021 §5 目录级管道：文件级注册已废弃，保留兼容期。新代码用 setSkillDirs。 */
  upsertSkill(skill: SkillInfo): void {
    upsertSkillImpl(this.configStore, skill)
  }

  /** @deprecated ADR-0021 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setSkillDirs。 */
  deleteSkill(skillId: string): void {
    deleteSkillImpl(this.configStore, this.projectRoot, skillId)
  }

  // ── Skill 加载路径（ADR-0021 §1 discovery.json v2 SSOT，单行委托 configStore）──

  setSkillDirs(dirs: SkillDirConfig[]): void {
    this.configStore.setSkillPaths(dirs)
  }

  getSkillDirs(): string[] {
    return this.configStore.getSkillPaths()
  }

  getSkillPathScopes(): DirScopes {
    return this.configStore.getSkillPathScopes()
  }

  getAgentDirs(): string[] {
    return this.configStore.getAgentDirs()
  }

  getAgentPathScopes(): DirScopes {
    return this.configStore.getAgentPathScopes()
  }

  setAgentDirs(dirs: SkillDirConfig[]): void {
    this.configStore.setAgentDirs(dirs)
  }

  getExtensionDirs(): string[] {
    return this.configStore.getExtensionDirs()
  }

  getExtensionPathScopes(): DirScopes {
    return this.configStore.getExtensionPathScopes()
  }

  setExtensionDirs(dirs: SkillDirConfig[]): void {
    this.configStore.setExtensionDirs(dirs)
  }

  migrateSettingsSkillsToDiscovery(): void {
    this.configStore.migrateSettingsSkillsToDiscovery()
  }

  // ── Agent CRUD（委托 agent-config-helper）────────────────────────

  loadAgents(projectRoot: string): AgentInfo[] {
    return loadAgentsImpl(this.configStore, projectRoot)
  }

  /** No-op: agents are discovered from discovery.json + forced dirs, not independently persisted. */
  saveAgents(projectRoot: string, agents: AgentInfo[]): void {
    saveAgentsImpl(projectRoot, agents)
  }

  /** @deprecated ADR-0021 §5 目录级管道：文件级写入已废弃，保留兼容期。新代码用 setAgentDirs。 */
  upsertAgent(agent: AgentInfo): void {
    upsertAgentImpl(this.configStore, agent)
  }

  /** @deprecated ADR-0021 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setAgentDirs。 */
  deleteAgent(agentId: string): void {
    deleteAgentImpl(this.configStore, agentId)
  }

  // ── Scanning（委托 scanner）──────────────────────────────────────

  scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[] {
    return scanSkillsImpl(sources, existingIds)
  }

  scanAgents(sources: string[], existingIds: Set<string>): ScannedAgentInfo[] {
    return scanAgentsImpl(sources, existingIds)
  }

  // ── 迁移源检测（W1，cw-2026-07-26-migration-other-agents）──
  // 只读检测本机其他 agent（Claude/Codex/Pi/ZCode）的 skill/agent 配置目录，
  // 返回每个源的安装状态 + 资源计数（不读文件内容）。详见 services/migration/source-detector.ts。
  detectSources(): SourceDetectResult[] {
    return detectSourcesImpl(process.env.HOME || homedir())
  }

  // ── Provider 导入（W2，cw-2026-07-26-migration-other-agents）──
  // preview→apply 两步数据流 + 内存缓存。安全红线（DM1）：apiKey 明文不进前端。
  // preview 返回脱敏数据（只 apiKeyExtracted 布尔），完整配置暂存 preview-cache（5min TTL）。
  // 实现委托 services/migration/provider-importer（与 detectSources 同模式：纯函数 + 直接读 pi-provider-store，
  // 对齐 quota-service 的 provider 级直访先例，不经 IConfigStore port）。

  previewImportProviders(source: ProviderSource): { importId: string; preview: ProviderImportPreview } | { error: { code: string; message: string } } {
    return previewImportImpl(source, process.env.HOME || homedir())
  }

  async applyImportProviders(importId: string, selectedIds: string[]): Promise<{ result: ProviderImportResult } | { error: { code: string; message: string } }> {
    // 第 4 参：providers.json 写通道——导入即默认同意的 coding-plan 额度显示自动开启
    // （api-key 类 preset + 明文 key 才写 quota.enabled；条件与写入语义见
    // provider-importer.matchAutoEnablePreset）。未注入（部分测试）时 importer 跳过写入。
    return applyImportImpl(importId, selectedIds, this.credentialWriter, this.providerExtrasStore)
  }

  // ── System prompt config（FR-6/FR-7，ADR-0044，委托 system-prompt-config-helper）──
  // 独立文件 system-prompt.json（不复用 config.json）：replace/append 两段提示词配置，
  // 插件读此文件热生效（replace 启动期注入、append 每轮 before_agent_start 注入）。

  getSystemPromptConfig(): { config: SystemPromptConfig; corrupted: boolean } {
    return getSystemPromptConfigImpl(this.configStore.getConfigDir())
  }

  setSystemPromptConfig(config: SystemPromptConfig): { ok: boolean; error?: string } {
    return setSystemPromptConfigImpl(this.configStore.getConfigDir(), config)
  }

  getReplaceSystemPrompt(): string | undefined {
    return getReplaceSystemPromptImpl(this.configStore.getConfigDir())
  }

  // ── Terminal config（Phase 6 settings，委托 terminal-config-helper）──
  // 独立文件 terminal.json（不复用 config.json）：shell/字体/scrollback 等终端偏好。
  // 仅对新 spawn 的 PTY 生效（已启动的 PTY 不动态切换 shell），由 TerminalService.resolveShell 读取。

  getTerminalConfig(): { config: TerminalConfig; corrupted: boolean } {
    return getTerminalConfigImpl(this.configStore.getConfigDir())
  }

  setTerminalConfig(config: TerminalConfig): { ok: boolean; error?: string } {
    return setTerminalConfigImpl(this.configStore.getConfigDir(), config)
  }

  // ── LLM retry config（llm-retry-settings 设计，单行委托注入 port）──
  // pi settings.json 的 retry 域：读写/校验/D3 merge 逻辑在 port 实现（PiRetrySettings）。

  getRetryConfig(): LlmRetryConfigSnapshot {
    if (!this.llmRetrySettings) {
      throw new Error('[config-service] llmRetrySettings not available (getRetryConfig)')
    }
    return this.llmRetrySettings.getRetryConfig()
  }

  setRetryConfig(config: LlmRetryConfig): { ok: boolean; error?: string } {
    if (!this.llmRetrySettings) {
      throw new Error('[config-service] llmRetrySettings not available (setRetryConfig)')
    }
    return this.llmRetrySettings.setRetryConfig(config)
  }
}
