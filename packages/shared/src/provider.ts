/**
 * Provider 机器标识品牌类型（design provider-arch-hardening §3.3 D2 / Phase 2）。
 *
 * 编译期拦截 id（小写机器标识如 `xiaomi-token-plan-cn`）与显示名（`name`，如 "Xiaomi Token Plan CN"）
 * 的混淆——两者同为 string，靠人工约定区分，曾导致 ModelSelectPopover 把 name 当 id 传给 pi
 * 致 "Model not found"（commit cd41254ba 局部修一处）。品牌类型编译期擦除，运行时行为零变化。
 *
 * 反序列化边界（settings.json `defaultProvider` / auth.json key / builtin-providers.json `id`）
 * 从磁盘读出是裸 string，用 `as ProviderId` 提升（design D5，先不加运行时 guard，P5 审查清单）。
 */
import type { QuotaCredentialSource } from './quota-types'

declare const __providerIdBrand: unique symbol
export type ProviderId = string & { readonly [__providerIdBrand]: true }

/**
 * Model 机器标识。暂不品牌化（混淆面低，保持 string）。
 */
export type ModelId = string

/**
 * 内置 provider 模板中的 model 摘要（DM3/IF2，wave 1 builtin-providers.json schema）。
 * 与 BuiltinProviderTemplate.models 元素结构严格对齐，前端/runtime/renderer 共用。
 *
 * 11 字段契约（design §4.2 / 附录 A.4，wave 2 扩展）：id/name/api/baseUrl/reasoning/input/
 * cost/contextWindow/maxTokens/thinkingLevelMap/compat。生成脚本（gen-builtin-providers.mjs）
 * 恒输出 11 键；thinkingLevelMap/compat 在 pi-ai model 无定义时置 null（不省略）。
 */
export interface BuiltinModelSummary {
  id: string
  name: string
  /**
   * 模型级协议（pi model.api）。optional：overlay 归一化不再用空串捏造缺省
   * （design catalog-provider-field-authority §3.3 D7），缺失 = 该模型无显式协议，
   * 由消费方按 pi 语义回落；快照条目恒有值，消费方须容忍缺省（旧消费方行为不变）。
   */
  api?: string
  baseUrl?: string
  reasoning: boolean
  input: string[]
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    /** 请求级分档定价（OpenAI 长上下文等），最高匹配阈值整单生效。 */
    tiers?: Array<{
      inputTokensAbove: number
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }>
  } | null
  contextWindow: number
  maxTokens?: number | null
  /** pi 思考档位映射：key 存在且 value≠null = 可用，value=null = 不支持。 */
  thinkingLevelMap?: Record<string, string | null> | null
  /** OpenAI 兼容协议覆写（forceAdaptiveThinking / supportsStrictMode 等）。 */
  compat?: Record<string, unknown> | null
}

/**
 * 内置 provider 模板（DM3/IF2，wave 1 builtin-providers.json schema）。
 * 由 config.listBuiltinProviders RPC 暴露给前端（wave 2）。
 * 可选字段（api/baseUrl/apiKeyName/oauthName/logoUrl）按 JSON 实际出现情况标注 optional。
 */
export interface BuiltinProviderTemplate {
  id: string
  name: string
  /**
   * 构建期 artifact：gen-builtin-providers.mjs 为对齐 provider 级单值 schema 捏造
   * （取 models[0].api 冒充 provider 协议）。禁止新代码消费——展示用 runtime 派生值
   * （ProviderInfo.api，design §3.3 D5）。
   */
  api?: string
  /**
   * 构建期 artifact：gen-builtin-providers.mjs 的 `provider.baseUrl ?? ''`（pi 无此字段时为空串）。
   * 禁止新代码消费——展示用 runtime 派生值（ProviderInfo.baseUrl，design §3.3 D5）。
   */
  baseUrl?: string
  authMode: 'api_key' | 'oauth' | 'both' | 'ambient'
  envVars: string[]
  oauthSupported: boolean
  apiKeyName?: string
  oauthName?: string
  modelCount: number
  models: BuiltinModelSummary[]
  logoUrl?: string
  /** OAuth flow 配置（prebuild 从 pi-ai dist/auth/oauth/*.js 提取，仅 oauthSupported provider 有值）。 */
  oauthConfig?: BuiltinOAuthConfig
}

/**
 * OAuth 流程配置（slice design I7/C1）。
 * openrouter 为公开 PKCE flow：无 clientId（noClientId=true）+ 动态端口（callbackPort 缺省）。
 */
export interface BuiltinOAuthConfig {
  clientId: string
  noClientId?: boolean
  flow: 'device' | 'callback' | 'both'
  endpoints: {
    authorize?: string
    token?: string
    deviceCode?: string
    verify?: string
  }
  scopes: string[]
  callbackPort?: number
}

export type ProviderStatus = 'connected' | 'not_configured' | 'error'

/**
 * Provider 体系来源（DM1，wave1）。聚合层（listProviders）标注，renderer 据此收窄操作。
 *
 * - 'catalog'：定义来自 pi 二进制内置 catalog，凭据在 auth.json，models.json 可有 override
 * - 'custom'：定义全在 models.json（含 apiKey）
 */
export type ProviderKind = 'catalog' | 'custom'

export interface ProviderInfo {
  id: ProviderId
  name: string
  /**
   * 协议（design catalog-provider-field-authority §3.3 D5 派生语义，runtime 聚合层下发、
   * 前端零推导）：catalog = 按合并模型集派生——全模型同 api → 该值；混合协议 / 全空 → undefined
   * （前端展示「按模型分发」）。custom = provider 级定义值。
   */
  api?: string
  /**
   * 请求端点（同 D5）：catalog = 用户网关优先（override 非空 baseUrl 原值下发）；无网关时按
   * 合并模型集派生——全模型同值且非空 → 该值；混合 / 全空缺省 → undefined（前端分别展示
   * 「内置端点（按模型分发）」「内置目录未提供」）。custom = provider 级定义值。
   */
  baseUrl?: string
  apiKeySet: boolean
  /**
   * 认证方式（展示用，design §6.5）。由内置模板/导入/编辑流程标注。
   * 注意与 BuiltinProviderTemplate.authMode 语义区分：authMethod 描述「当前凭据形态」
   * （env_var = 已用 $ENV 引用），authMode 描述「provider 支持的认证能力全集」。
   */
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  headers?: Record<string, string>
  authHeader?: boolean
  status: ProviderStatus
  models: Array<{
    id: string
    name?: string
    api?: string
    baseUrl?: string
    reasoning?: boolean
    input?: Array<'text' | 'image'>
    contextWindow?: number
    maxTokens?: number
    thinkingLevelMap?: Record<string, string | null>
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    compat?: Record<string, unknown>
    /**
     * model 级自定义请求头（读侧透传，与 SetProviderData.models[].headers 写路径对称，
     * pi ModelDefinitionSchema 内字段）。runtime listProviders 聚合处从 models.json 条目
     * 透传；无此字段的模型缺省（向后兼容）。
     */
    headers?: Record<string, string>
    /** model 级启停（W2）。省略时默认 true，供 aggregateModels 过滤判断。 */
    enabled?: boolean
    /**
     * 条目来源标注（B-2 聚合层配合，design §3.6）：catalog provider 的混合模型列表区分
     * builtin catalog 副本条目与 models.json override 条目（同 id 被 override 覆盖的也标
     * 'override'——它已被用户定义覆盖）。custom provider 的模型全部是用户定义，不标（省略）。
     * optional 向后兼容（旧消费方无此字段行为不变）。
     */
    source?: 'builtin' | 'override'
    /**
     * 支持的思考档位（U5 能力注册表 view-ready 字段）：runtime 用 pi-ai 同源
     * getSupportedThinkingLevels 离线算好下发（reasoning 缺失/false → ['off']，
     * 与 pi 两级门控逐字节一致），renderer 零推导——档位 UI 直接消费，禁止前端
     * 再从 thinkingLevelMap 自算（影子推断是事故 B 根因之一）。缺省 = 未标注
     * （标注链路失败/版本错配时的过渡态），消费方经 normalizeSupportedLevels
     * 归一到默认五档——与 pi 两级门控可能不一致（reasoning:false 模型），仅作
     * 过渡兜底，正常链路不应命中。
     */
    supportedLevels?: string[]
  }>
  enabled?: boolean
  /** 体系来源，聚合层（listProviders）标注。renderer 据此收窄操作（移除文案/编辑限制）。见 DM2。 */
  kind?: ProviderKind
  /** catalog provider 是否有 models.json override 条目；custom 恒 undefined。renderer 据此判断「移除」会清掉什么。见 DM2。 */
  hasOverride?: boolean
  /** Coding Plan 额度查询配置（可选；未配置 = 不查额度）。 */
  quota?: {
    /**
     * 使用的 fetcher id（手动指定，匹配 QuotaPreset.fetcher / ProviderQuotaFetcher.id）。
     * 未设置时由 QuotaService 自动按 baseUrl/name 匹配 QUOTA_PRESETS。
     */
    fetcher?: string
    /** 是否启用额度查询。 */
    enabled: boolean
    /**
     * cookie 类 provider 的 cookie 是否已写入 runtime（布尔态，明文不入前端）。
     * api-key 类复用 ProviderInfo.apiKeySet，无需此字段。
     */
    cookieSet?: boolean
    /**
     * api-key 类 provider 是否有 Coding Plan 专属 API Key（明文存 secrets 目录，不写 models.json）。
     * 未设置/false = 复用 ProviderInfo.apiKey（provider 的 API Key）。
     */
    apiKeySet?: boolean
    /**
     * 凭证来源（D3，coding-plan-quota-config-ux §6.4）。未设置 = 按 resolveQuotaCredentialSource
     * 推断（兼容历史数据：apiKeySet=true → exclusive，否则 provider）。
     */
    credentialSource?: QuotaCredentialSource
    /**
     * 资源维度 fetcher（opencode）的 workspace 归一化地址（规范 URL，非凭证可明文回显）。
     * 未配置 = 查询返回 not_configured（D1-3，timeout-audit-hygiene-batch）。
     */
    workspace?: string
  }
}

export interface ModelInfo {
  id: ModelId
  name: string
  providerId: ProviderId
  providerName: string
  api?: string
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  enabled?: boolean
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  /**
   * 目录级管道模型下恒为 true（目录在 = 启用，ADR-0021 §5）。
   * 前端不再渲染文件级开关；保留字段仅为兼容历史消费方，后续废弃。
   */
  enabled: boolean
  source: string
  triggers: string[]
  argumentHint?: string
  // UI 扩展字段（由后端下发或前端补充）
  sourcePath?: string
  sourceIcon?: string
  fileSize?: string
  tools?: string[]
  content?: string
  tag?: string
  /**
   * 生效标注（ADR-0021 §5）：同名多来源合并后，优先级最高（数组靠前）的那条标 true。
   * UI badge 链第一个标「生效」。
   */
  effective?: boolean
  /**
   * 同名多来源 badge 链（ADR-0021 §5）：每个来源一项，按优先级排序（强制 > 可选；可选内按 skillDirs 数组顺序）。
   * 单来源条目可省略；前端据此渲染多源覆盖可视化。
   */
  sources?: Array<{ source: string; sourcePath: string }>
}

export type ScanSourceType = 'pi' | 'claude' | 'agents' | 'custom'

/**
 * discovery.json schema v2（ADR-0021 §1）—— skill/agent/extension 加载路径的唯一真相源。
 * 位于 `<piAgentDir>/discovery.json`（<dataDir>/agent/discovery.json）。
 *
 * v2 嵌套结构：每个 kind 拆 projectPaths（项目级，跟随 cwd，可含相对路径如 .agents/skills）
 * 与 globalPaths（全局级，限绝对路径如 ~/.pi/agent/skills）。
 * 合并语义：resolveLoadPaths(cfg, kind) = dedupe([...cfg[kind].projectPaths, ...cfg[kind].globalPaths])，
 * 项目在前 = 项目优先级 > 全局（靠前覆盖靠后，§1.1 层 3）。
 *
 * 强制目录不进此文件（桥接层硬编码注入）。
 *
 * extension：用户勾选的外部 extension 扫描目录（P1 pi 原生 + P2 taiji + 自定义），
 * 复刻 pi 的 collectAutoExtensionEntries 扫描。npm 安装的 extension 不进此文件（走 settings.json packages[]）。
 *
 * 从 v1 迁移见 migrateDiscoveryV1ToV2（discovery-migrate.ts）。
 */
export interface DiscoveryConfig {
  // eslint-disable-next-line no-magic-numbers -- schema 版本字面量（存量，无法提取常量）
  version: 2
  skill: { projectPaths: string[]; globalPaths: string[] }
  agent: { projectPaths: string[]; globalPaths: string[] }
  extension: { projectPaths: string[]; globalPaths: string[] }
}

/**
 * discovery.json schema v1（旧扁平结构，保留供迁移用）。
 * skillDirs / agentDirs / extensionDirs 是有序扁平数组，靠前覆盖靠后。
 * 读取 v1 时经 migrateDiscoveryV1ToV2 按路径特征归类（相对→project / 绝对→global）后升级为 v2。
 * 不再有新代码直接构造 v1；保留类型仅为 deserialize 兼容旧文件。
 */
export interface DiscoveryConfigV1 {
  version: 1
  skillDirs: string[]
  agentDirs: string[]
  extensionDirs: string[]
}

/**
 * UI 加载路径配置项（层 A）。
 * path: 目录路径（~/.pi/agent/skills 等）。
 * enabled: 是否进 discovery.json 数组（目录在 = 加载，ADR-0021 §5）。
 * scope: 路径归属（v2）——'project' 写入 cfg[kind].projectPaths，'global' 写入 cfg[kind].globalPaths。
 *   由生产端（UI/settings-message-handler）显式标注，消费端（skill-dirs.ts）直接读 scope 决定加载归属，
 *   不再按 isAbsolute 推断（方案 §2.5 路径 A 配套）。必填，强制所有生产端显式标注。
 * 排序由数组顺序承载（可拖排序），故 UI 侧是有序 SkillDirConfig[]。
 */
export interface SkillDirConfig {
  path: string
  enabled: boolean
  scope: 'project' | 'global'
}

export interface ScannedSkillInfo {
  id: string
  name: string
  description: string
  sourceType: ScanSourceType
  sourcePath: string
  triggers: string[]
  argumentHint?: string
  content: string
  fileSize?: string
  tools?: string[]
  alreadyImported: boolean
}

export interface ScannedAgentInfo {
  id: string
  name: string
  description: string
  sourceType: ScanSourceType
  sourcePath: string
  content: string
  icon?: string
  tools?: string[]
  alreadyImported: boolean
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  enabled: boolean
  modelStrategy: string
  icon?: string
  // UI 扩展字段（由后端下发或前端补充）
  source?: string
  sourceType?: string
  iconBg?: string
  type?: string
  tools?: string[]
  modelBind?: string
  modelTags?: { power?: string; efficient?: string; fast?: string }
  overrideParams?: boolean
  params?: { depth: number; width: number; tokens: number; rounds: number }
  content?: string
  /** 生效标注（ADR-0021 §5），语义同 SkillInfo.effective。 */
  effective?: boolean
  /** 同名多来源 badge 链（ADR-0021 §5），语义同 SkillInfo.sources。 */
  sources?: Array<{ source: string; sourcePath: string }>
}
