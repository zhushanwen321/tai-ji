/**
 * Config 域 —— provider / skill / agent / defaults（请求 + 订阅 + 动作 混合）。
 *
 * 形态分类（契约见 .taiji-harness/2026-06-23-render-runtime-integration/contract.md §2.3）：
 * - 请求-响应：listProviders / scanSkills / scanAgents / discoverModels
 * - 订阅-推送：onProviders / onSkills / onAgents / onDefaults
 * - 动作-ack：setProvider / deleteProvider / setSkill / deleteSkill / setAgent / deleteAgent
 *
 * 动作触发后状态变更由对应订阅通道推回（单一数据源，避免竞态）。
 *
 * 依赖方向：command（请求/动作）+ events（订阅，走全局通道）。
 */
import type {
  ProviderInfo,
  SkillInfo,
  AgentInfo,
  ScannedSkillInfo,
  ScannedAgentInfo,
  SetProviderData,
  SkillDirConfig,
  SystemPromptConfig,
  TerminalConfig,
  LlmRetryConfig,
  SourceDetectResult,
  ProviderSource,
  BuiltinProviderTemplate,
  ProviderImportPreview,
  ProviderImportResult,
  SkillCacheInvalidatedPayload,
  ServerMessage,
  ProviderId,
  ConnectionTestResultRow,
} from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'
import * as events from '../events'

// ── 请求-响应 ──
// runtime 请求-响应 reply 均为命名 envelope（settings-message-handler.ts），
// 此处统一解包对应字段，与 session.list 解包 `.groups` 同构。mock 门面有独立实现不受影响。
// scoped-model D7：reply 与 config.providers 广播同形（protocol.ts 'config.getProviders' 映射
// ServerMessageMap['config.providers']），scopedModels 透传给 refreshProviders 消费（[] 与 undefined 语义不同：
// [] = 空白名单，undefined = reply 未携带，由消费方守卫区分）。
export async function listProviders(): Promise<{ providers: ProviderInfo[]; scopedModels?: string[] }> {
  const reply = await command('config.getProviders', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return { providers: reply.providers, scopedModels: reply.scopedModels }
}

/**
 * 进入 Settings Provider 页时触发远程模型目录刷新（runtime 对列表内 catalog provider
 * 发 ETag 协商请求，fail-safe）。列表变更经 config.providers 广播推回（settings store
 * 常驻订阅），本调用只等 reply 不做状态管理。
 */
export async function refreshProviderCatalogs(): Promise<{
  refreshed: string[]
  failed: Array<{ providerId: string; reason: string }>
}> {
  const reply = await command('config.refreshProviderCatalogs', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return { refreshed: reply.refreshed, failed: reply.failed }
}

export async function scanSkills(sources: string[]): Promise<ScannedSkillInfo[]> {
  const reply = await command('config.scanSkills', { sources }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.skills
}

/**
 * W2 配套（cw-2026-07-21-scan-project-agents-skills）：按 session cwd 拉 project skill。
 * 调 runtime loadSkills(cwd) 扫描 <cwd>/.agents/skills + <cwd>/.taiji/skills 等已生效目录，
 * 返回 SkillInfo[]。与 scanSkills 区分：scanSkills 扫 sources 数组候选加入 discovery；
 * scanSessionSkills 扫某 cwd 的已生效项目 skill（按需拉取，不进全局 config.skills）。
 */
export async function scanSessionSkills(cwd: string): Promise<SkillInfo[]> {
  const reply = await command('config.scanSessionSkills', { cwd }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.skills
}

/**
 * W4（cw-2026-07-21-fix-ask-user-ime）：拉全局 skill（skillRegistry globalCache）。
 * landing 全局 slash 命令源走此 RPC（FR-5：不再走 settingsStore.skills 配置态扫描）。
 * runtime 端 skillRegistry.getGlobalSkills() 同步读启动期扫描缓存（watcher 自动刷新），零 RPC 开销。
 */
export async function getGlobalSkills(): Promise<SkillInfo[]> {
  const reply = await command('config.getGlobalSkills', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.skills
}

/**
 * W4：按 cwd 拉项目 skill（skillRegistry projectCache，首次扫描 + 挂 watcher，命中缓存零开销）。
 * 与 scanSessionSkills 区分：getProjectSkills 走 skillRegistry（带缓存 + 文件监听 W1 单例），
 * scanSessionSkills 直接调 configService.loadSkills(cwd)（无缓存无 watcher）。前端 useProjectSkills 已切到本 RPC。
 */
export async function getProjectSkills(cwd: string): Promise<SkillInfo[]> {
  const reply = await command('config.getProjectSkills', { cwd }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.skills
}

export async function scanAgents(sources: string[]): Promise<ScannedAgentInfo[]> {
  const reply = await command('config.scanAgents', { sources }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.agents
}

/**
 * 检测本机已安装的源 agent（W1：skill/agent 维度，cw-2026-07-26-migration-other-agents）。
 * 只读检测——后端仅统计文件数量，不读取文件内容（不提取 API key、不解析配置正文）。
 * reply config.sourcesDetected 形状 `{ sources: SourceDetectResult[] }`。
 */
export async function detectSources(): Promise<SourceDetectResult[]> {
  const reply = await command('config.detectSources', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.sources
}

/**
 * 列出内置 provider 模板（wave 2，无参只读）。reply config.builtinProviders 形状 `{ providers }`。
 * 数据源为 runtime import 的 generated JSON（37 个内置 provider，含 model 摘要与 auth 元信息）。
 */
export async function listBuiltinProviders(): Promise<BuiltinProviderTemplate[]> {
  const reply = await command('config.listBuiltinProviders', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.providers
}

/**
 * W2（cw-2026-07-26-migration-other-agents）：预览从源 agent 导入的 provider 列表。
 * runtime 解析源配置 → 脱敏 ProviderImportPreview（只 apiKeyExtracted 布尔，无 key 值）+ 缓存(5min TTL)。
 * reply config.providersPreviewed payload 是 `{ importId, preview }` 或 `{ error }`（command 不 reject，
 * 错误以 envelope 形式返回，由前端按 union 分支处理）。
 */
export async function previewImportProviders(
  source: ProviderSource,
): Promise<{ importId: string; preview: ProviderImportPreview } | { error: { code: string; message: string } }> {
  return command('config.previewImportProviders', { source }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * W2：应用选中的 provider 导入。runtime 从 preview-cache 取完整配置 → 逐个 upsertProvider → 删缓存。
 * reply config.providersImported payload 是 `{ result }` 或 `{ error }`（同上，错误以 envelope 返回）。
 */
export async function applyImportProviders(
  importId: string,
  selectedIds: string[],
): Promise<{ result: ProviderImportResult } | { error: { code: string; message: string } }> {
  return command('config.applyImportProviders', { importId, selectedIds }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** discoverModels 的响应载荷（config.discoveredModels reply，settings-message-handler） */
export interface DiscoveredModelsResult {
  models: Array<{ id: string; name?: string; contextWindow?: number }>
  success: boolean
  error?: string
  /** test 模式填（行形状 SSOT = shared ConnectionTestResultRow） */
  results?: ConnectionTestResultRow[]
}

export function discoverModels(req: {
  baseUrl: string
  apiKey?: string
  providerType?: string
  providerId?: string
  /** 缺省 'discover'（runtime 侧缺省语义；'test' 只需 providerId，端点回落归 runtime） */
  mode?: 'test' | 'discover'
}): Promise<DiscoveredModelsResult> {
  return command('config.discoverModels', req, RPC_BACKSTOP_TIMEOUT_MS)
}

// ── 订阅-推送（sendInitialState 主动推 + 运行时广播）──
export function onProviders(handler: (providers: ProviderInfo[], scopedModels?: string[]) => void): () => void {
  return events.onGlobalType('config.providers', (msg) => {
    handler(msg.payload.providers, msg.payload.scopedModels)
  })
}

export function onSkills(handler: (skills: SkillInfo[]) => void): () => void {
  return events.onGlobalType('config.skills', (msg) => {
    handler(msg.payload.skills)
  })
}

export function onAgents(handler: (agents: AgentInfo[]) => void): () => void {
  return events.onGlobalType('config.agents', (msg) => {
    handler(msg.payload.agents)
  })
}

export function onSkillDirs(handler: (dirs: SkillDirConfig[]) => void): () => void {
  return events.onGlobalType('config.skillDirs', (msg) => {
    handler(msg.payload.dirs)
  })
}

/**
 * 订阅 skill 缓存失效信号（landing useGlobalSkills/useProjectSkills 失效缓存重拉）。
 * 与 onSkills 区分：onSkills 推全量 skill 列表给 settingsStore（settings 弹窗用）；
 * onSkillCacheInvalidated 推失效信号给 landing composable（runtime 已重扫缓存，前端重拉即拿新值）。
 *
 * payload 与 shared protocol.ts 的 config.skillCacheInvalidated 一致：
 * - scope='global'：全局 skill 变动，所有 panel 刷全局缓存（cwd 缺省）
 * - scope='project'：项目 skill 变动，cwd 携带变更的项目根（前端按需路由）
 */
export function onSkillCacheInvalidated(
  handler: (payload: SkillCacheInvalidatedPayload) => void,
): () => void {
  return events.onGlobalType('config.skillCacheInvalidated', (msg) => {
    handler(msg.payload)
  })
}

export function onAgentDirs(handler: (dirs: SkillDirConfig[]) => void): () => void {
  return events.onGlobalType('config.agentDirs', (msg) => {
    handler(msg.payload.dirs)
  })
}

export function onExtensionDirs(handler: (dirs: SkillDirConfig[]) => void): () => void {
  return events.onGlobalType('config.extensionDirs', (msg) => {
    handler(msg.payload.dirs)
  })
}

export function onDefaults(handler: (defaultModel: string) => void): () => void {
  return events.onGlobalType('config.defaults', (msg) => {
    handler(msg.payload.defaultModel)
  })
}

/** 带 source 的 config.defaults 订阅（仅广播携带 source；reply 走 pending map 不进全局通道）。
 *  ProviderPage 用它区分「provider 变更后 runtime 自动修复默认模型」（source='provider-updated'/
 *  'provider-deleted' 等）与用户主动 config.setDefaultModel（source='default-set'）。
 *  source 用宽 string（shared 未导出 DefaultModelSource 联合类型，其成员均为 string 字面量，赋值兼容）。 */
export function onDefaultsWithSource(handler: (payload: { defaultModel: string; source?: string }) => void): () => void {
  return events.onGlobalType('config.defaults', (msg) => {
    handler({ defaultModel: msg.payload.defaultModel, source: msg.payload.source })
  })
}

// ── 动作-ack（状态变更由对应订阅通道推回）──
/**
 * 目录级管道写入（ADR-0021 §1）：覆盖 skill 加载路径配置（含 scope 的 SkillDirConfig[]，靠前覆盖靠后）。
 * v2 scope 穿越：整体透传 SkillDirConfig[]（不降维为 string[]），让用户显式 scope 决定加载归属与优先级。
 * 状态变更经 onSkills + onSkillDirs 订阅推回（后端 setSkillDirs 后广播）。
 */
export function setSkillDirs(dirs: SkillDirConfig[]): Promise<void> {
  return command('config.setSkillDirs', { dirs }, RPC_BACKSTOP_TIMEOUT_MS)
}

export function setAgentDirs(dirs: SkillDirConfig[]): Promise<void> {
  return command('config.setAgentDirs', { dirs }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 覆盖 extension 加载路径（Phase 4 目录级管道，v2 scope 穿越），语义同 setSkillDirs/setAgentDirs。
 *  reply 为 config.extensionDirs（广播），状态变更经 onExtensionDirs 订阅推回。 */
export function setExtensionDirs(dirs: SkillDirConfig[]): Promise<void> {
  return command('config.setExtensionDirs', { dirs }, RPC_BACKSTOP_TIMEOUT_MS)
}

export function setProvider(providerId: ProviderId, data: SetProviderData): Promise<void> {
  return command('config.setProvider', { providerId, ...data }, RPC_BACKSTOP_TIMEOUT_MS)
}

// W3 默认模型持久化：动作-ack，状态变更经 onDefaults 订阅推回（runtime 广播 config.defaults）。
export function setDefaultModel(provider: ProviderId, modelId: string): Promise<void> {
  return command('config.setDefaultModel', { provider, modelId }, RPC_BACKSTOP_TIMEOUT_MS)
}

// Scoped models 白名单设置（config.setScopedModels）。reply 回写后规范化结果（去重保序）。
export async function setScopedModels(models: string[]): Promise<string[]> {
  const reply = await command('config.setScopedModels', { models }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.scopedModels
}

export function deleteProvider(providerId: ProviderId): Promise<void> {
  return command('config.deleteProvider', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
}

// wave4 C1：provider 启用切换（写 enabledModels 白名单）。替代旧 setProvider({enabled}) 路径——
// wave3 停用 setProvider 的 provider 级 enabled 写入后，toggle 必须走此 RPC 才能持久化启用状态。
// reply config.providerUpdated；newDefault 经 onDefaults 订阅推回（broadcast 由 handler 发起）。
export function toggleProviderEnabled(providerId: ProviderId, enabled: boolean): Promise<void> {
  return command('config.toggleProviderEnabled', { providerId, enabled }, RPC_BACKSTOP_TIMEOUT_MS)
}

// wave4 IF3：按体系移除 provider。kind 来自 ProviderInfo.kind（wave2 聚合层标注）——
// catalog 清凭据（不删 pi 定义），custom 删条目。与 deleteProvider 区别：后者不分体系直接删条目
// （向后兼容保留），renderer 按 kind 调对应 RPC。reply config.providerUpdated。
export function removeProviderByKind(providerId: ProviderId, kind: 'catalog' | 'custom'): Promise<void> {
  return command('config.removeProviderByKind', { providerId, kind }, RPC_BACKSTOP_TIMEOUT_MS)
}

export function setSkill(skill: SkillInfo): Promise<void> {
  return command('config.setSkill', { skill }, RPC_BACKSTOP_TIMEOUT_MS)
}

export function deleteSkill(skillId: string): Promise<void> {
  return command('config.deleteSkill', { skillId }, RPC_BACKSTOP_TIMEOUT_MS)
}

export function setAgent(agent: AgentInfo): Promise<void> {
  return command('config.setAgent', { agent }, RPC_BACKSTOP_TIMEOUT_MS)
}

export function deleteAgent(agentId: string): Promise<void> {
  return command('config.deleteAgent', { agentId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** `{ config, corrupted? }` reply 归一（corrupted 缺省 = false），SystemPrompt/Terminal 两对 get/set 共用。 */
function toCorruptedConfig<T>(reply: { config: T, corrupted?: boolean }): { config: T, corrupted: boolean } {
  return { config: reply.config, corrupted: reply.corrupted ?? false }
}

// ── System prompt config（FR-4/FR-5）──
// settings-handler reply config.systemPrompt 形状 `{ config, corrupted? }`；
// setSystemPrompt 失败时走 sendError，command reject（前端 catch 提示）。

/** 读取系统提示词配置。corrupted=true 表示磁盘配置损坏已回退默认。 */
export async function getSystemPrompt(): Promise<{ config: SystemPromptConfig; corrupted: boolean }> {
  const reply = await command('config.getSystemPrompt', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return toCorruptedConfig(reply)
}

/** 保存系统提示词配置（replace + append）。失败时 runtime 返回 error envelope，command 会 reject。 */
export async function setSystemPrompt(config: SystemPromptConfig): Promise<{ config: SystemPromptConfig; corrupted: boolean }> {
  const reply = await command('config.setSystemPrompt', { config }, RPC_BACKSTOP_TIMEOUT_MS)
  return toCorruptedConfig(reply)
}

/** 订阅系统提示词配置广播（多 panel 同步）。 */
export function onSystemPrompt(handler: (config: SystemPromptConfig, corrupted: boolean) => void): () => void {
  return events.onGlobalType('config.systemPrompt', (msg) => {
    handler(msg.payload.config, msg.payload.corrupted ?? false)
  })
}

// ── Terminal config（Phase 6，复刻 SystemPromptConfig 范式）──
// settings-handler reply config.terminalConfig 形状 `{ config, corrupted? }`；
// setTerminalConfig 失败时走 sendError，command reject（前端 catch 提示）。

/** 读取终端配置。corrupted=true 表示磁盘配置损坏已回退默认。 */
export async function getTerminalConfig(): Promise<{ config: TerminalConfig; corrupted: boolean }> {
  const reply = await command('config.getTerminalConfig', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return toCorruptedConfig(reply)
}

/** 保存终端配置（shell/字体/scrollback/cursor/bell 等）。失败时 runtime 返回 error envelope，command 会 reject。 */
export async function setTerminalConfig(config: TerminalConfig): Promise<{ config: TerminalConfig; corrupted: boolean }> {
  const reply = await command('config.setTerminalConfig', { config }, RPC_BACKSTOP_TIMEOUT_MS)
  return toCorruptedConfig(reply)
}

/** 订阅终端配置广播（多 panel 同步）。 */
export function onTerminalConfig(handler: (config: TerminalConfig, corrupted: boolean) => void): () => void {
  return events.onGlobalType('config.terminalConfig', (msg) => {
    handler(msg.payload.config, msg.payload.corrupted ?? false)
  })
}

// ── LLM retry config（llm-retry-settings u3；契约见 shared protocol.ts config.retryConfig）──

/** 读取 LLM 重试配置。configured=false 表示文件无显式 retry 配置（config 为后端合并 pi 默认后的值）。 */
export async function getRetryConfig(): Promise<{ config: LlmRetryConfig; configured: boolean }> {
  return command('config.getRetryConfig', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 保存 LLM 重试配置（整体保存为显式按钮触发）。越界时 runtime 返回 error envelope，command 会 reject。 */
export async function setRetryConfig(config: LlmRetryConfig): Promise<{ config: LlmRetryConfig; configured: boolean }> {
  return command('config.setRetryConfig', { config }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 订阅 LLM 重试配置广播（多窗口同步，同 terminal 范式）。 */
export function onRetryConfig(handler: (payload: { config: LlmRetryConfig; configured: boolean }) => void): () => void {
  return events.onGlobalType('config.retryConfig', (msg) => {
    handler(msg.payload)
  })
}

// ── OAuth Login（路径 B · slice design I1/I2/I4）──
// RPC/事件契约见 shared protocol.ts（config.oauthLogin/oauthCancel reply + auth.* 事件）。
// 事件 payload 必带 providerId（前端按 providerId 路由，支持并发多 provider）；
// token 永不出现在 payload（脱敏红线）。payload 类型从 ServerMessage 派生，协议改动自动跟随。

/** auth.deviceCode 事件 payload（device flow 中间态：验证码 + 浏览器验证链接 + 倒计时参数） */
export type AuthDeviceCodePayload = ServerMessage<'auth.deviceCode'>['payload']
/** auth.authUrl 事件 payload（callback flow 中间态：授权 URL + 本地回调端口） */
export type AuthAuthUrlPayload = ServerMessage<'auth.authUrl'>['payload']
/** auth.success 事件 payload（授权成功，token 已写 auth.json） */
export type AuthSuccessPayload = ServerMessage<'auth.success'>['payload']
/** auth.error 事件 payload（授权失败原因） */
export type AuthErrorPayload = ServerMessage<'auth.error'>['payload']

/** 启动 OAuth flow（device/callback，按 provider 的 oauthConfig）。started=false + error 表示启动失败。 */
export function oauthLogin(providerId: string): Promise<{ started: boolean; error?: string }> {
  return command('config.oauthLogin', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 中止进行中的 OAuth flow（幂等：无进行中 flow 返回 cancelled:false 不报错）。 */
export function oauthCancel(providerId: string): Promise<{ cancelled: boolean }> {
  return command('config.oauthCancel', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 退出 OAuth 登录（B-1 场景 C）：移除 auth.json 中该 provider 的凭证（幂等；有进行中 flow 先中止）。
 *  ok=false + error 表示移除失败（error 由 runtime 透传，前端不自造文案）。 */
export function oauthLogout(providerId: string): Promise<{ ok: boolean; error?: string }> {
  return command('config.oauthLogout', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 查询 auth.json 是否已有该 provider 的 OAuth 凭据（MF-1：QuickSetup 重开时默认 oauth radio，
 *  防 env 盲保存触发 I9 清理静默删凭据）。只返回布尔——token 永不出现在协议中。 */
export async function hasOAuth(providerId: string): Promise<boolean> {
  const reply = await command('config.hasOAuth', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.hasOAuth
}

/** 批量检测环境变量是否已设置（I3，只返回布尔不返回值——env 值可能含凭证）。 */
export async function checkEnvVars(names: string[]): Promise<Record<string, boolean>> {
  const reply = await command('config.checkEnvVars', { names }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.results
}

/** 订阅 device flow 中间态（user_code / verification_uri / 倒计时）。返回取消函数。 */
export function onAuthDeviceCode(handler: (payload: AuthDeviceCodePayload) => void): () => void {
  return events.onGlobalType('auth.deviceCode', (msg) => {
    handler(msg.payload)
  })
}

/** 订阅 callback flow 中间态（授权 URL + 本地回调端口）。返回取消函数。 */
export function onAuthAuthUrl(handler: (payload: AuthAuthUrlPayload) => void): () => void {
  return events.onGlobalType('auth.authUrl', (msg) => {
    handler(msg.payload)
  })
}

/** 订阅授权成功（token 已写 auth.json）。返回取消函数。 */
export function onAuthSuccess(handler: (payload: AuthSuccessPayload) => void): () => void {
  return events.onGlobalType('auth.success', (msg) => {
    handler(msg.payload)
  })
}

/** 订阅授权失败（expired_token / access_denied / 端口占用 / 超时 / exchange 失败）。返回取消函数。 */
export function onAuthError(handler: (payload: AuthErrorPayload) => void): () => void {
  return events.onGlobalType('auth.error', (msg) => {
    handler(msg.payload)
  })
}
