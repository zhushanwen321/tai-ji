/**
 * Config 域 ports —— Provider/Skill/Agent 的 CRUD + 默认模型 + 配置目录。
 *
 * 🔒 三层架构：services 定义 port，infra/pi/pi-config-store.ts 实现。
 * pi 的协议类型（PiProviderConfig/PiModelDefinition）只存在于 infra 实现内部，
 * service 只见本文件定义的 ConfigProviderConfig / ConfigModelDefinition。
 */
import type { ScanSourceType, SkillDirConfig, ProviderId } from '@taiji/shared'
import type { DirScopes } from '../skill-dir-config.js'

/** service 侧的 provider 配置形状（pi-provider-store 的 PiProviderConfig 的 service 视图）。 */
export interface ConfigProviderConfig {
  name?: string
  apiKey?: string
  baseUrl?: string
  /** pi 的 api 标识（前端直接发送 pi 终值，runtime 透传，见 applyTypeTranslation）。 */
  api?: string
  /** 认证方式（寄生字段，仅存量数据兼容读）。A1 后权威存 config/providers.json（TaijiProviderStore）。 */
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  /** provider 级启停（W1）。省略时默认 true，与 infra PiProviderConfig 同构。 */
  enabled?: boolean
  models?: ConfigModelDefinition[]
  /**
   * Coding Plan 额度查询配置（寄生字段，仅存量数据兼容读）。
   * A1 后权威存 config/providers.json（TaijiProviderStore），listProviders 经双读回退
   * 映射到 ProviderInfo.quota。
   */
  quota?: {
    /** 用户手动指定的 fetcher id（省略时 QuotaService 自动按 baseUrl/name 匹配）。 */
    fetcher?: string
    /** 是否启用额度查询。 */
    enabled: boolean
    /** cookie 类 provider 的 cookie 是否已写入 secrets（布尔态）。 */
    cookieSet?: boolean
    /** api-key 类 provider 是否有专属 API Key（明文存 secrets，未设置/false 复用 provider.apiKey）。 */
    apiKeySet?: boolean
  }
}

/** service 侧的 model 定义形状。 */
export interface ConfigModelDefinition {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  /** model 级启停（W1）。省略时默认 true，与 infra PiModelDefinition 同构。 */
  enabled?: boolean
  input?: Array<'text' | 'image'>
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  /** model 级自定义请求头（pi ModelDefinitionSchema 内字段，B-4b 白名单）。 */
  headers?: Record<string, string>
  compat?: Record<string, unknown>
}

/** pi models.json 的 service 视图。 */
export interface ConfigModelsConfig {
  providers: Record<string, ConfigProviderConfig>
}

/** 默认模型引用。 */
export interface DefaultModelRef {
  provider: ProviderId
  modelId: string
}

/** upsertProvider 的返回（含可能的新默认模型）。 */
export interface UpsertProviderResult {
  newDefault?: DefaultModelRef
}

/** removeProvider 的返回。 */
export interface RemoveProviderResult {
  removed: boolean
  newDefault?: DefaultModelRef
}

/** listAgentFiles 的返回项。 */
export interface AgentFileEntry {
  name: string
  path: string
  content: string
  /**
   * 来源目录推断出的 source 类型（W1）：claude / agents / pi / custom。
   * infra 层（agent-crud）扫描时按 discovered 目录 inferSourceType 填充；
   * service 层 loadAgents 透传到 AgentInfo.sourceType，供 Settings 按 tab 过滤。
   * 可选 + 兜底 pi：向上兼容旧 entry 无此字段（inferSourceType 落空时）。
   */
  sourceType?: ScanSourceType
}

/**
 * 配置存储 port —— Provider/Skill/Agent 的 CRUD + 默认模型 + 配置目录。
 * 实现位于 infra/pi/pi-config-store.ts（封装 pi-provider-store/agent-crud/pi-paths + type 透传）。
 */
export interface IConfigStore {
  // ── 默认模型 ──
  getDefaultModel(): DefaultModelRef | null
  setDefaultModel(provider: ProviderId, modelId: string): void

  // ── enabledModels 白名单（wave2 DM3：provider 启用状态派生源）──
  /**
   * 读 settings.json.enabledModels（pi 白名单语义：空/undefined = 全可用）。
   * config-service.listProviders 经 deriveEnabled(id, getEnabledModels()) 派生每个
   * provider 的启用状态，替代旧实现读 models.json provider.enabled（F2）。
   */
  getEnabledModels(): string[]

  // ── enabledModels 白名单写入（wave3：toggleProviderEnabled + 边界守卫）──
  /**
   * 设置 enabledModels 白名单（非空数组写回 settings.json.enabledModels）。
   * wave3 toggleProviderEnabled 在「重算后非空」分支调用（TC1/TC2）。
   */
  setEnabledModels(patterns: string[]): void
  /**
   * 删除 settings.json.enabledModels 字段（wave3 边界3 / CL2）。
   * pi 白名单语义空=全可用，写空数组语义反转故 delete 字段（belt-and-suspenders）。
   */
  clearEnabledModels(): void
  /**
   * 边界1（wave3 TC5 / C2）：若 enabledModels 非空，加 `<id>/*` 让新 provider 默认启用；
   * 空/undefined 时 no-op。importer applyImport / setProvider 新建 provider 时调用。
   */
  ensureProviderInWhitelist(providerId: string): void
  /**
   * 清除 enabledModels 白名单中某 provider 的残留 pattern（wave4 IF3 / C3）。
   * removeProviderByKind 两分支共用：filter `<id>/*` 与 `<id>/<model>` pattern；
   * 边界3(a) 重算空 → clearEnabledModels（delete 字段，CL2）。
   */
  cleanEnabledModelsResidue(providerId: string): void
  // 注：scopedModels 残留清理不经 IConfigStore——scopedModels 属 providers.json（TaijiProviderStore 域），
  // deleteProvider/removeProviderByKind 直接调 extrasStore.cleanScopedModelsResidue（scoped-model design §3.2）。

  // ── Provider CRUD ──
  readModels(): ConfigModelsConfig
  getProviderConfig(providerId: string): ConfigProviderConfig | undefined
  upsertProvider(providerId: string, merged: ConfigProviderConfig): UpsertProviderResult
  removeProvider(providerId: string): RemoveProviderResult
  /** 透传 provider type → pi api 标识（前端直接发 pi 终值，runtime 不再翻译别名）。 */
  applyTypeTranslation(type: string): string
  /**
   * pi 0.84.1 八字段全缺空壳判定（sanitizeInvalidProviders 与 provider-extras-migration
   * 共用的删除判据，权威实现在 infra/pi/pi-provider-repair）。port 化动机（round 1 review
   * arch-boundary S1）：migration 原 services → infra 直 import 加重三层泄漏，判定语义
   * 不应穿透到 services。ConfigProviderConfig 与 PiProviderConfig 结构同构，直接传入。
   */
  isInvalidProvider(config: ConfigProviderConfig): boolean

  // ── Skill paths（discovery.json v2 SSOT，ADR-0021 §1）──
  /** 读取 skill 合并路径（project ∪ global 去重，项目在前）。供 session-service pi 启动参数等消费。 */
  getSkillPaths(): string[]
  /** 读取 skill 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getSkillPathScopes(): DirScopes
  /** 覆盖 skill 路径（SkillDirConfig[] 带 scope，按 scope 分发写 projectPaths/globalPaths + 脏数据过滤）。写 discovery.json + 同步投影 settings.json。 */
  setSkillPaths(dirs: SkillDirConfig[]): void
  addSkillPath(dir: string): void
  removeSkillPath(dir: string): void
  /** 一次性迁移：settings.json.skills → discovery.json（首启用，幂等）。 */
  migrateSettingsSkillsToDiscovery(): void

  // ── Agent dirs（discovery.json v2 SSOT，ADR-0021 §1）──
  /** 读取 agent 合并路径（project ∪ global 去重，项目在前）。 */
  getAgentDirs(): string[]
  /** 读取 agent 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getAgentPathScopes(): DirScopes
  /** 覆盖 agent 路径（SkillDirConfig[] 带 scope，按 scope 分发 + 脏数据过滤）。写 discovery.json。 */
  setAgentDirs(dirs: SkillDirConfig[]): void

  // ── Extension dirs（discovery.json v2 SSOT，ADR-0021 §1）──
  /** 读取 extension 合并路径（project ∪ global 去重，项目在前）。 */
  getExtensionDirs(): string[]
  /** 读取 extension 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
  getExtensionPathScopes(): DirScopes
  /** 覆盖 extension 路径（SkillDirConfig[] 带 scope，按 scope 分发 + 脏数据过滤）。写 discovery.json。 */
  setExtensionDirs(dirs: SkillDirConfig[]): void

  // ── Agent files（强制目录 + discovery 多目录扫描）──
  /**
   * 扫描 agent .md 文件。
   * - 不带参：扫默认强制目录（向后兼容）。
   * - 带 dirs：扫多目录，同名按数组顺序去重（靠前覆盖靠后）。
   */
  listAgentFiles(dirs?: string[]): AgentFileEntry[]
  writeAgentFile(name: string, content: string): void
  deleteAgentFile(name: string): boolean

  // ── 配置目录 ──
  getConfigDir(): string
  /** pi agent 配置目录（<dataDir>/agent，settings.json/agents 所在地；extensions/npm 已迁 dataDir 根层）。 */
  getPiAgentDir(): string
}
