/**
 * Settings and model configuration message handler mixin.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, DefaultModelSource, ProviderSource, SkillCacheScope, ProviderId } from '@xyz-agent/shared'
import type { IConfigService, ISessionService, IModelService, IAuthService } from '../interfaces.js'
import type { SkillRegistry } from '../services/skill-registry.js'
import { SCOPED_MODEL_REGEX } from '../services/provider-extras-store.js'
import { attachSupportedLevelsSafe } from './message-broker.js'
import { toErrorMessage } from '../utils/errors.js'
import type { MessageHandlerContext } from './message-context.js'
import { ConfigPreferencesMessageHandler } from './config-preferences-message-handler.js'
import type { IProviderCredentialResolver } from '../services/ports/provider-credential-resolver.js'
import type { IModelConnectionTester } from '../services/ports/model-connection-tester.js'
import { PROVIDER_CONNECTION_TEST_ERRORS } from '../services/model-service.js'
import type { ProviderConnectionTestOutcome, ProviderConnectionTestService } from '../services/model-service.js'

/** Interface for server methods needed by this handler */
export interface SettingsHandlerContext extends MessageHandlerContext {
  configService: IConfigService
  sessionService: ISessionService
  /**
   * modelService（IModelService）。测试连接的 per-model 编排面（M3a：
   * ProviderConnectionTestService.testProviderConnections）是可选交集——组合根注入的
   * ModelService 实现类具备该方法，测试替身可缺省（handler 走 test_unavailable 防御分支）。
   */
  modelService: IModelService & Partial<ProviderConnectionTestService>
  /** OAuth Login（路径 B）：config.oauthLogin/oauthCancel RPC 路由 + auth.* 事件由 AuthService 推 broadcast */
  authService: IAuthService
  /**
   * Provider 凭据解析唯一通道（D3 收口，链 2 消费点）。
   * 构造必需（M2fg 收口）：组合根装配注入（M2c），models.json 直查回退已删除。
   */
  providerCredentialResolver: IProviderCredentialResolver
  /**
   * 测试连接 HTTP 适配器（D-21 端口化：接口 SSOT 在 services/ports，infra 实现
   * ModelConnectionTester 由组合根构造注入——transport 不再 value import infra）。
   * 构造必需（恒注入形态，同 providerCredentialResolver）。
   */
  connectionTester: IModelConnectionTester
  /** W4：skillRegistry（全局 + 项目级 skill 缓存，带 watcher）。landing 全局 skill 经此拿 globalCache（FR-5）。 */
  skillRegistry: SkillRegistry
  projectRoot: string
  nextPushId(): string
  broadcast(msg: import('@xyz-agent/shared').ServerMessage): void
  broadcastProviderList(): void
  broadcastSkillList(): void
  broadcastSkillCacheInvalidated(scope: SkillCacheScope, cwd?: string): void
  broadcastAgentList(): void
  broadcastSkillDirs(): void
  broadcastAgentDirs(): void
  broadcastExtensionDirs(): void
}

/**
 * provider 增删后统一维护 defaultModel（design provider-arch-hardening §3.3 D3 / Phase 3）。
 *
 * 二选一：有 newDefault 直接用（不读盘）；无则 getDefaultModel 兜底（内部 findValidDefaultModel +
 * wasFixed:true 时写回 settings.json）。config.defaults 广播收敛在本 helper 内一次，消除 5 handler
 * 各自编排的遗漏根因（applyImportProviders 曾漏维护，commit cd41254ba 局部补）。
 *
 * broadcastProviderList 不在此收口（决策 D3：语义正交——provider 列表变更 vs defaultModel 对账；
 * 且 applyImport 只成功时广播、其它总广播，留各 handler 更清晰）。
 */
function reconcileDefaultModelAfterProviderChange(
  ctx: SettingsHandlerContext,
  source: DefaultModelSource,
  existingNewDefault?: { provider: ProviderId; modelId: string },
): void {
  const dm = existingNewDefault ?? ctx.configService.getDefaultModel()
  if (!dm) return
  // source 用 shared DefaultModelSource 联合的合法成员，按调用场景映射
  //（provider-updated=增改/启停/导入，provider-deleted=删除），由本参数的类型在调用点
  // 强制校验。ServerMessage 大联合实例化下 type/payload 联动约束仍缺失（broadcast 非
  // 泛型，无法在此钉死单一消息类型），但 source 参数已把非法字面量挡在编译期。
  ctx.broadcast({
    type: 'config.defaults',
    id: ctx.nextPushId(),
    payload: { defaultModel: `${dm.provider}/${dm.modelId}`, source },
  })
}

/**
 * config/model case 路由表类型：每个消息 type 映射到对应 case 处理器，msg 参数按
 * key 窄化（Extract 收窄与 switch narrowing 行为一致——见 shared protocol.ts 的
 * ClientMessage 派生注释）。case 处理器同步返回 boolean 或异步返回 Promise<boolean>
 * （与原 switch case 的同步/含 await 形态一一对应）。表驱动取代原 ~50 分支 switch：
 * 主函数只留「偏好组先行 + 查表 + 命中调用」，每个 case 体是独立私有 helper
 * （行为保持提取，复杂度债务偿还 W1）。
 */
type SettingsCaseRoutes = {
  [K in ClientMessageType]?: (msg: Extract<ClientMessage, { type: K }>, ws: WsType) => boolean | Promise<boolean>
}

export class SettingsMessageHandler {
  /** workspace 偏好组子 handler（worktree/streaming-idle/基分支 12 条简单转发，控本文件 max-lines） */
  private preferencesHandler: ConfigPreferencesMessageHandler

  constructor(private ctx: SettingsHandlerContext) {
    this.preferencesHandler = new ConfigPreferencesMessageHandler(ctx)
  }

  /**
   * case 路由表：key 集合与原 switch case 一一对应。未知 type 查表落空返回 false
   * （由 server 发 unknown_type，同原 switch default 行为）。
   */
  private readonly routes: SettingsCaseRoutes = {
    'config.getProviders': (msg, ws) => this.handleConfigGetProviders(msg, ws),
    'config.refreshProviderCatalogs': (msg, ws) => this.handleConfigRefreshProviderCatalogs(msg, ws),
    'config.setProvider': (msg, ws) => this.handleConfigSetProvider(msg, ws),
    'config.deleteProvider': (msg, ws) => this.handleConfigDeleteProvider(msg, ws),
    'config.toggleProviderEnabled': (msg, ws) => this.handleConfigToggleProviderEnabled(msg, ws),
    'config.removeProviderByKind': (msg, ws) => this.handleConfigRemoveProviderByKind(msg, ws),
    'config.oauthLogin': (msg, ws) => this.handleConfigOauthLogin(msg, ws),
    'config.oauthCancel': (msg, ws) => this.handleConfigOauthCancel(msg, ws),
    'config.hasOAuth': (msg, ws) => this.handleConfigHasOAuth(msg, ws),
    'config.oauthLogout': (msg, ws) => this.handleConfigOauthLogout(msg, ws),
    'config.checkEnvVars': (msg, ws) => this.handleConfigCheckEnvVars(msg, ws),
    'config.setToolPermissions': (msg, ws) => this.handleConfigSetToolPermissions(msg, ws),
    'config.scanSkills': (msg, ws) => this.handleConfigScanSkills(msg, ws),
    'config.scanSessionSkills': (msg, ws) => this.handleConfigScanSessionSkills(msg, ws),
    'config.getGlobalSkills': (msg, ws) => this.handleConfigGetGlobalSkills(msg, ws),
    'config.getProjectSkills': (msg, ws) => this.handleConfigGetProjectSkills(msg, ws),
    'config.setSkillDirs': (msg, ws) => this.handleConfigSetSkillDirs(msg, ws),
    'config.setSkill': (msg, ws) => this.handleConfigSetSkill(msg, ws),
    'config.deleteSkill': (msg, ws) => this.handleConfigDeleteSkill(msg, ws),
    'config.scanAgents': (msg, ws) => this.handleConfigScanAgents(msg, ws),
    'config.detectSources': (msg, ws) => this.handleConfigDetectSources(msg, ws),
    'config.listBuiltinProviders': (msg, ws) => this.handleConfigListBuiltinProviders(msg, ws),
    'config.previewImportProviders': (msg, ws) => this.handleConfigPreviewImportProviders(msg, ws),
    'config.applyImportProviders': (msg, ws) => this.handleConfigApplyImportProviders(msg, ws),
    'config.setAgentDirs': (msg, ws) => this.handleConfigSetAgentDirs(msg, ws),
    'config.setAgent': (msg, ws) => this.handleConfigSetAgent(msg, ws),
    'config.setExtensionDirs': (msg, ws) => this.handleConfigSetExtensionDirs(msg, ws),
    'config.deleteAgent': (msg, ws) => this.handleConfigDeleteAgent(msg, ws),
    'config.discoverModels': (msg, ws) => this.handleDiscoverModels(msg, ws),
    'model.list': (msg, ws) => this.handleModelList(msg, ws),
    'model.switch': (msg, ws) => this.handleModelSwitch(msg, ws),
    'config.setDefaultModel': (msg, ws) => this.handleConfigSetDefaultModel(msg, ws),
    'config.getSystemPrompt': (msg, ws) => this.handleConfigGetSystemPrompt(msg, ws),
    'config.setSystemPrompt': (msg, ws) => this.handleConfigSetSystemPrompt(msg, ws),
    'config.getTerminalConfig': (msg, ws) => this.handleConfigGetTerminalConfig(msg, ws),
    'config.setTerminalConfig': (msg, ws) => this.handleConfigSetTerminalConfig(msg, ws),
    'config.getRetryConfig': (msg, ws) => this.handleConfigGetRetryConfig(msg, ws),
    'config.setRetryConfig': (msg, ws) => this.handleConfigSetRetryConfig(msg, ws),
    'session.setThinkingLevel': (msg, ws) => this.handleSessionSetThinkingLevel(msg, ws),
    'config.setAutoRenameEnabled': (msg, ws) => this.handleConfigSetAutoRenameEnabled(msg, ws),
    'config.getAutoRenameEnabled': (msg, ws) => this.handleConfigGetAutoRenameEnabled(msg, ws),
    'config.setRenameModel': (msg, ws) => this.handleConfigSetRenameModel(msg, ws),
    'config.getRenameModel': (msg, ws) => this.handleConfigGetRenameModel(msg, ws),
    'config.setRenameMode': (msg, ws) => this.handleConfigSetRenameMode(msg, ws),
    'config.getRenameMode': (msg, ws) => this.handleConfigGetRenameMode(msg, ws),
    'config.getSmartContextConfig': (msg, ws) => this.handleConfigGetSmartContextConfig(msg, ws),
    'config.setSmartContextEnabled': (msg, ws) => this.handleConfigSetSmartContextEnabled(msg, ws),
    'config.setSmartContextCompactModel': (msg, ws) => this.handleConfigSetSmartContextCompactModel(msg, ws),
    'config.setSmartContextThresholds': (msg, ws) => this.handleConfigSetSmartContextThresholds(msg, ws),
    'config.setSmartContextExcludedModels': (msg, ws) => this.handleConfigSetSmartContextExcludedModels(msg, ws),
    'config.setScopedModels': (msg, ws) => this.handleConfigSetScopedModels(msg, ws),
  }

  async handleSettingsMessage(msg: ClientMessage, ws: WsType): Promise<boolean> {
    // 偏好组先行（子 handler 未命中返回 false 继续本 switch——精确匹配无顺序依赖，行为等价）
    if (await this.preferencesHandler.handle(msg, ws)) return true
    // tool.approve / tool.deny / tool.always_allow：已删除的 no-op 占位。
    // 这些 type 此前只是 `return true` 以避免 unknown_type，但工具审批的实际路径是
    // pi 的 extension_ui_request（method:'confirm'）→ extension.ui_request/ui_response 流
    // （event-adapter 翻译，见 infra/pi/event-adapter.ts），「总是允许」由 config.setToolPermissions
    // 声明式 toolPermissions 配置覆盖。renderer 从不发送 tool.approve/deny/always_allow，
    // 无真实 handler。现在这些消息会落入下方查表落空 → return false → server 发 unknown_type，
    // 即对真正未知 type 的正确兜底行为。
    const handler = this.routes[msg.type]
    if (!handler) return false
    // 路由表 key 与 msg.type 字面量同源（上方 routes 逐 key 登记），查表命中即类型匹配；
    // TS 无法静态关联索引访问与 key（correlated types，microsoft/TypeScript#30581），
    // `as never` 是该不变式下的类型层收口，运行时分发行为与原 switch 完全一致
    //（未知 type 落空 → return false，同原 default 分支）。
    return handler(msg as never, ws)
  }

  // ── case handlers（原 switch case 体逐一提取；语句与注释原样保留，行为保持）──

  // scoped-model design §3.3 D7：reply 与广播（message-broker.buildProviderListMsgs）均含 scopedModels。
  // supportedLevels 同样两路同标（U5 接线）：本 ctx 无 appInfo，piVersion 缺省（registry 以
  // 逐模型签名兜底，缓存正确性不依赖该组分——见 model-capability.ts 头注）。
  private handleConfigGetProviders(msg: Extract<ClientMessage, { type: 'config.getProviders' }>, ws: WsType): boolean {
    this.ctx.reply(ws, msg.id, 'config.providers', {
      providers: attachSupportedLevelsSafe(this.ctx.modelService, this.ctx.configService.listProviders()),
      scopedModels: this.ctx.configService.getScopedModels(),
    })
    return true
  }

  private async handleConfigRefreshProviderCatalogs(msg: Extract<ClientMessage, { type: 'config.refreshProviderCatalogs' }>, ws: WsType): Promise<boolean> {
    // settings-provider 页进入时触发：远程模型目录 ETag 协商刷新（单请求 4s 超时，
    // 全部 fail-safe），完成后广播新列表（store 常驻订阅自动更新，renderer 零状态管理）。
    const result = await this.ctx.configService.refreshProviderCatalogs()
    this.ctx.reply(ws, msg.id, 'config.providerCatalogsRefreshed', result)
    this.ctx.broadcastProviderList()
    return true
  }

  private async handleConfigSetProvider(msg: Extract<ClientMessage, { type: 'config.setProvider' }>, ws: WsType): Promise<boolean> {
    const { providerId, ...data } = msg.payload
    const setResult = await this.ctx.configService.setProvider(providerId, data as Parameters<IConfigService['setProvider']>[1])
    this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId })
    this.ctx.broadcastProviderList()
    reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-updated', setResult.newDefault)
    return true
  }

  private async handleConfigDeleteProvider(msg: Extract<ClientMessage, { type: 'config.deleteProvider' }>, ws: WsType): Promise<boolean> {
    const delResult = await this.ctx.configService.deleteProvider(msg.payload.providerId)
    this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId: msg.payload.providerId, deleted: true })
    this.ctx.broadcastProviderList()
    reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-deleted', delResult.newDefault)
    return true
  }

  private handleConfigToggleProviderEnabled(msg: Extract<ClientMessage, { type: 'config.toggleProviderEnabled' }>, ws: WsType): boolean {
    // wave4 C1：provider 启用切换走 toggleProviderEnabled（写 enabledModels 白名单），
    // 替代旧 setProvider({enabled})。reply config.providerUpdated + broadcastProviderList
    // （wave2 双源聚合 + deriveEnabled 派生新启用状态）+ newDefault 广播（边界2 default 重选）。
    const { providerId, enabled } = msg.payload
    const toggleResult = this.ctx.configService.toggleProviderEnabled(providerId, enabled)
    this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId })
    this.ctx.broadcastProviderList()
    reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-updated', toggleResult.newDefault)
    return true
  }

  private async handleConfigRemoveProviderByKind(msg: Extract<ClientMessage, { type: 'config.removeProviderByKind' }>, ws: WsType): Promise<boolean> {
    // wave4 IF3：按体系移除 provider。catalog 清凭据/override/残留（不删 pi 定义），
    // custom 删条目 + 清残留。reply config.providerUpdated + broadcastProviderList +
    // newDefault 广播（custom 分支 removeProvider 内 default 重选）。
    const { providerId, kind } = msg.payload
    const removeResult = await this.ctx.configService.removeProviderByKind(providerId, kind)
    this.ctx.reply(ws, msg.id, 'config.providerUpdated', { providerId, deleted: true })
    this.ctx.broadcastProviderList()
    reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-deleted', removeResult.newDefault)
    return true
  }

  private handleConfigOauthLogin(msg: Extract<ClientMessage, { type: 'config.oauthLogin' }>, ws: WsType): boolean {
    const result = this.ctx.authService.login(msg.payload.providerId)
    this.ctx.reply(ws, msg.id, 'config.oauthLoginReply', result.started
      ? { started: true }
      : { started: false, error: result.error })
    return true
  }

  private handleConfigOauthCancel(msg: Extract<ClientMessage, { type: 'config.oauthCancel' }>, ws: WsType): boolean {
    const result = this.ctx.authService.cancel(msg.payload.providerId)
    this.ctx.reply(ws, msg.id, 'config.oauthCancelReply', result)
    return true
  }

  private async handleConfigHasOAuth(msg: Extract<ClientMessage, { type: 'config.hasOAuth' }>, ws: WsType): Promise<boolean> {
    // MF-1：查询 auth.json 是否已有该 provider 的 oauth 凭据（QuickSetup 重开时据此默认
    // oauth radio，防 env 盲保存触发 I9 清理①静默删凭据）。只返回布尔——token 永不出现在协议中。
    const hasOAuth = await this.ctx.authService.hasOAuth(msg.payload.providerId)
    this.ctx.reply(ws, msg.id, 'config.hasOAuthReply', { hasOAuth })
    return true
  }

  private async handleConfigOauthLogout(msg: Extract<ClientMessage, { type: 'config.oauthLogout' }>, ws: WsType): Promise<boolean> {
    // B-1 场景 C：退出登录——移除 auth.json 中该 provider 的凭证（先中止进行中 flow）。
    // 幂等（无凭证 no-op）；失败转 ok:false + error（错误消息指向重试动作）。
    try {
      await this.ctx.authService.logout(msg.payload.providerId)
      this.ctx.reply(ws, msg.id, 'config.oauthLogoutReply', { ok: true })
    } catch (error) {
      this.ctx.reply(ws, msg.id, 'config.oauthLogoutReply', {
        ok: false,
        error: `退出登录失败（凭证可能仍在）：${toErrorMessage(error)}。请重试；持续失败请检查磁盘后重启应用`,
      })
    }
    return true
  }

  private handleConfigCheckEnvVars(msg: Extract<ClientMessage, { type: 'config.checkEnvVars' }>, ws: WsType): boolean {
    // I3 契约：names 必须是字符串数组，非法 payload → sendError invalid_payload（对齐 D10 错误 envelope）
    const names = msg.payload.names
    if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) {
      this.ctx.sendError(ws, 'invalid_payload', 'names 必须是字符串数组')
      return true
    }
    const results = this.ctx.configService.checkEnvVars(names)
    this.ctx.reply(ws, msg.id, 'config.envVarsChecked', { results })
    return true
  }

  private handleConfigSetToolPermissions(msg: Extract<ClientMessage, { type: 'config.setToolPermissions' }>, ws: WsType): boolean {
    this.ctx.configService.updateToolPermissions(msg.payload.permissions)
    this.ctx.reply(ws, msg.id, 'config.providerUpdated', { saved: true })
    return true
  }

  private handleConfigScanSkills(msg: Extract<ClientMessage, { type: 'config.scanSkills' }>, ws: WsType): boolean {
    const existingIds = new Set(this.ctx.configService.loadSkills(this.ctx.projectRoot).map(s => s.id))
    this.ctx.reply(ws, msg.id, 'config.scannedSkills', { skills: this.ctx.configService.scanSkills(msg.payload.sources, existingIds), success: true })
    // 修裂缝①：扫描后广播最新 skill 列表（与 set/delete 对称），让前端 onSkills 订阅推回
    this.ctx.broadcastSkillList()
    return true
  }

  private handleConfigScanSessionSkills(msg: Extract<ClientMessage, { type: 'config.scanSessionSkills' }>, ws: WsType): boolean {
    // W2（cw-2026-07-21-scan-project-agents-skills）：按 session cwd 拉 project skill。
    // 与 config.scanSkills 区分：scanSkills 扫 sources 数组候选加入 discovery + 广播全局；
    // scanSessionSkills 扫某 cwd 的 .agents/skills + .xyz-agent/skills 已生效目录，不广播
    // （按需 RPC，避免污染全局 config.skills，前端 useProjectSkills 按 cwd key 独立缓存）。
    const skills = this.ctx.configService.loadSkills(msg.payload.cwd)
    this.ctx.reply(ws, msg.id, 'config.sessionSkills', { skills })
    return true
  }

  private handleConfigGetGlobalSkills(msg: Extract<ClientMessage, { type: 'config.getGlobalSkills' }>, ws: WsType): boolean {
    // W4：返回 skillRegistry globalCache（启动期扫描 + watcher 自动刷新，同步读缓存零开销）。
    // landing 全局 skill 走此 RPC（FR-5：不再走 settingsStore.skills 配置态扫描）。
    const skills = this.ctx.skillRegistry.getGlobalSkills()
    this.ctx.reply(ws, msg.id, 'config.globalSkills', { skills })
    return true
  }

  private async handleConfigGetProjectSkills(msg: Extract<ClientMessage, { type: 'config.getProjectSkills' }>, ws: WsType): Promise<boolean> {
    // W4：按 cwd 拉项目 skill（skillRegistry projectCache，首次扫描 + 挂 watcher，命中缓存零开销）。
    // 与 config.scanSessionSkills 区分：getProjectSkills 走 skillRegistry（带缓存 + 文件监听 W1 单例），
    // scanSessionSkills 直接调 configService.loadSkills(cwd)（无缓存）。前端 useProjectSkills 已切到本 RPC。
    const skills = await this.ctx.skillRegistry.getProjectSkills(msg.payload.cwd)
    this.ctx.reply(ws, msg.id, 'config.projectSkills', { skills })
    return true
  }

  private handleConfigSetSkillDirs(msg: Extract<ClientMessage, { type: 'config.setSkillDirs' }>, ws: WsType): boolean {
    // ADR-0021 §1 目录级管道：覆盖 discovery.json.skillDirs（有序数组 = 优先级）
    this.ctx.configService.setSkillDirs(msg.payload.dirs)
    this.ctx.reply(ws, msg.id, 'config.skillDirs', { dirs: msg.payload.dirs })
    // 触发 SkillRegistry 重建（close 旧 watcher → 重扫 globalCache → 重挂 watcher 含新路径）+ 清 projectCache。
    // rebuildGlobal 内部 notifyGlobalChange → onChange → 广播 config.skillCacheInvalidated('global') + reloadOrchestrator。
    // 显式广播 ('project')——让前端 useProjectSkills 也失效重拉。
    //
    // Promise 链语义（W1 修正：原 `.then` 内 invalidate+broadcast 在 rebuild reject 时被整段跳过，
    // 与下方「失败不阻塞后续 invalidate/broadcast」注释不符——原写法 broadcast 在 `.then` 里，
    // reject 时前端收不到 project 失效信号、useProjectSkills 仍展示陈旧缓存）：
    //   - 成功：invalidateAllProjects（清 projectCache，globalCache 已由 rebuild 重扫）+ broadcast('project')
    //   - 失败：仅 broadcast('project')（让前端至少重拉一次；projectCache 暂不清——rebuild 失败时
    //     globalCache 可能损坏，invalidateAllProjects 此时意义不大且 reloadOrchestrator 可能已在处理错误，
    //     等下次成功 rebuild 再清；用户重试 settings 操作可恢复）。
    // broadcast 总是执行（无论 rebuild 成败都通知前端 project 失效），invalidate 只在成功时。
    // best-effort：失败只记日志，不阻塞 WS 消息处理（reply/broadcastSkillDirs 已立即返回）。
    void this.ctx.skillRegistry.rebuildGlobal()
      .then(() => {
        this.ctx.skillRegistry.invalidateAllProjects()
        this.ctx.broadcastSkillCacheInvalidated('project')
      })
      .catch((e: unknown) => {
        console.error('[settings-handler] skillRegistry.rebuildGlobal failed after setSkillDirs:', e)
        // rebuild 失败也广播失效，让前端至少重拉一次（projectCache 未清，前端拉到旧值——
        // 但比完全不通知好，用户重试 settings 操作可恢复）。
        this.ctx.broadcastSkillCacheInvalidated('project')
      })
    this.ctx.broadcastSkillDirs()
    this.ctx.broadcastSkillList()
    return true
  }

  private handleConfigSetSkill(msg: Extract<ClientMessage, { type: 'config.setSkill' }>, ws: WsType): boolean {
    // @deprecated ADR-0021 §5：保留兼容期，走 deprecated config-service 路径
    this.ctx.configService.upsertSkill(msg.payload.skill)
    this.ctx.reply(ws, msg.id, 'config.skillUpdated', { skill: msg.payload.skill, success: true })
    this.ctx.broadcastSkillList()
    return true
  }

  private handleConfigDeleteSkill(msg: Extract<ClientMessage, { type: 'config.deleteSkill' }>, ws: WsType): boolean {
    // @deprecated ADR-0021 §5：保留兼容期
    this.ctx.configService.deleteSkill(msg.payload.skillId)
    this.ctx.reply(ws, msg.id, 'config.skillDeleted', { skillId: msg.payload.skillId, success: true })
    this.ctx.broadcastSkillList()
    return true
  }

  private handleConfigScanAgents(msg: Extract<ClientMessage, { type: 'config.scanAgents' }>, ws: WsType): boolean {
    const existingIds = new Set(this.ctx.configService.loadAgents(this.ctx.projectRoot).map(a => a.id))
    this.ctx.reply(ws, msg.id, 'config.scannedAgents', { agents: this.ctx.configService.scanAgents(msg.payload.sources, existingIds), success: true })
    // 修裂缝①：扫描后广播最新 agent 列表
    this.ctx.broadcastAgentList()
    return true
  }

  private handleConfigDetectSources(msg: Extract<ClientMessage, { type: 'config.detectSources' }>, ws: WsType): boolean {
    // W1 迁移功能：检测本机其他 agent（Claude/Codex/Pi/ZCode）的 skill/agent 配置目录。
    // 只读检测（不读文件内容），reply 检测结果数组。无副作用，无需广播。
    const sources = this.ctx.configService.detectSources()
    this.ctx.reply(ws, msg.id, 'config.sourcesDetected', { sources })
    return true
  }

  private handleConfigListBuiltinProviders(msg: Extract<ClientMessage, { type: 'config.listBuiltinProviders' }>, ws: WsType): boolean {
    // wave 2：列出内置 provider 模板（import generated JSON，无参只读）。reply config.builtinProviders。
    this.ctx.reply(ws, msg.id, 'config.builtinProviders', { providers: this.ctx.configService.listBuiltinProviders() })
    return true
  }

  private handleConfigPreviewImportProviders(msg: Extract<ClientMessage, { type: 'config.previewImportProviders' }>, ws: WsType): boolean {
    // W2 迁移：Step1 预览从其他 agent 源导入的 provider 列表（脱敏，apiKey 不进前端）。
    // result 可能是 { importId, preview }（成功）或 { error }（源未安装等），reply 原样转发。
    // 前端按有无 error 字段判断成败。无广播（按需 RPC，apply 后才广播 provider 列表）。
    // W1：payload 字段校验——source 必须是已知 ProviderSource，否则 sendError。
    const source = msg.payload?.source
    const VALID_SOURCES: ProviderSource[] = ['pi', 'zcode', 'codex', 'claude']
    if (typeof source !== 'string' || !VALID_SOURCES.includes(source as ProviderSource)) {
      this.ctx.sendError(ws, 'invalid_payload', 'config.previewImportProviders requires a valid "source" (pi|zcode|codex|claude)', msg.id)
      return true
    }
    const result = this.ctx.configService.previewImportProviders(source as ProviderSource)
    this.ctx.reply(ws, msg.id, 'config.providersPreviewed', result)
    return true
  }

  private async handleConfigApplyImportProviders(msg: Extract<ClientMessage, { type: 'config.applyImportProviders' }>, ws: WsType): Promise<boolean> {
    // W2 迁移：Step2 应用导入（写 models.json）。result 可能是 { result }（成功）或 { error }（缓存过期等）。
    // apply 成功后广播 provider 列表（与 setProvider/deleteProvider 对称，让所有 panel 同步新增的 provider）。
    // W1：payload 字段校验——importId 必须是字符串，selectedIds 必须是字符串数组，否则 sendError。
    const importId = msg.payload?.importId
    const selectedIds = msg.payload?.selectedIds
    if (typeof importId !== 'string' || !importId.trim() ||
        !Array.isArray(selectedIds) || !selectedIds.every((id: unknown) => typeof id === 'string')) {
      this.ctx.sendError(ws, 'invalid_payload', 'config.applyImportProviders requires a non-empty "importId" string and "selectedIds" string array', msg.id)
      return true
    }
    const result = await this.ctx.configService.applyImportProviders(importId, selectedIds as string[])
    this.ctx.reply(ws, msg.id, 'config.providersImported', result)
    // 仅成功时广播（result 有 result 字段 = 成功；有 error 字段 = 失败，不广播）
    if ('result' in result) {
      this.ctx.broadcastProviderList()
      // 导入后重选 defaultModel：不传 newDefault → reconcile 自动走 getDefaultModel 兜底
      //（内部 findValidDefaultModel + wasFixed:true 时写回 settings.json）。
      reconcileDefaultModelAfterProviderChange(this.ctx, 'provider-updated')
      // D9（pi-evolution-consistency-and-project-switcher §3.3）：导入成功后 fire-and-forget
      // 刷新远程模型目录（overlay 通道）——导入的 catalog provider 此刻才进 listProviders，
      // 不刷则其模型列表停留在快照（「导入后模型列表不新鲜」的原始场景）。完成后广播新列表
      //（与 config.refreshProviderCatalogs case 的 refresh→broadcast 模式同构）；不阻塞导入
      // reply，失败仅日志（refresh 自身 4s 超时 fail-safe，导入主语义已成功，失败可重进页面重试）。
      void this.ctx.configService.refreshProviderCatalogs()
        .then(() => { this.ctx.broadcastProviderList() })
        .catch((e: unknown) => {
          console.warn('[settings-handler] applyImportProviders: provider catalog refresh failed:', e)
        })
    }
    return true
  }

  private handleConfigSetAgentDirs(msg: Extract<ClientMessage, { type: 'config.setAgentDirs' }>, ws: WsType): boolean {
    // ADR-0021 §1 目录级管道：覆盖 discovery.json.agentDirs（有序数组 = 优先级）
    this.ctx.configService.setAgentDirs(msg.payload.dirs)
    this.ctx.reply(ws, msg.id, 'config.agentDirs', { dirs: msg.payload.dirs })
    this.ctx.broadcastAgentList()
    this.ctx.broadcastAgentDirs()
    return true
  }

  private handleConfigSetAgent(msg: Extract<ClientMessage, { type: 'config.setAgent' }>, ws: WsType): boolean {
    // @deprecated ADR-0021 §5：保留兼容期
    this.ctx.configService.upsertAgent(msg.payload.agent)
    this.ctx.reply(ws, msg.id, 'config.agentUpdated', { agent: msg.payload.agent, success: true })
    this.ctx.broadcastAgentList()
    return true
  }

  private handleConfigSetExtensionDirs(msg: Extract<ClientMessage, { type: 'config.setExtensionDirs' }>, ws: WsType): boolean {
    // ADR-0021 §1 目录级管道：覆盖 discovery.json.extensionDirs（有序数组 = 优先级）
    this.ctx.configService.setExtensionDirs(msg.payload.dirs)
    this.ctx.reply(ws, msg.id, 'config.extensionDirs', { dirs: msg.payload.dirs })
    this.ctx.broadcastExtensionDirs()
    return true
  }

  private handleConfigDeleteAgent(msg: Extract<ClientMessage, { type: 'config.deleteAgent' }>, ws: WsType): boolean {
    // @deprecated ADR-0021 §5：保留兼容期
    this.ctx.configService.deleteAgent(msg.payload.agentId)
    this.ctx.reply(ws, msg.id, 'config.agentDeleted', { agentId: msg.payload.agentId, success: true })
    this.ctx.broadcastAgentList()
    return true
  }

  private handleModelList(msg: Extract<ClientMessage, { type: 'model.list' }>, ws: WsType): boolean {
    this.ctx.reply(ws, msg.id, 'model.list', { models: this.ctx.modelService.aggregateModels(this.ctx.configService.listProviders()) })
    return true
  }

  private async handleModelSwitch(msg: Extract<ClientMessage, { type: 'model.switch' }>, ws: WsType): Promise<boolean> {
    const { sessionId, provider, modelId } = msg.payload
    console.log(`[runtime] model.switch: sessionId=${sessionId}, provider=${provider}, modelId=${modelId}`)
    // C-pi-13 回执修型（U6）：reply 回传生效值——pi pattern 引擎可能把请求模型
    // 静默换成同族条目（事故 A 形态），switchModel 经 set→get_state 读回
    // 'provider/id' 复合串（请求 ≠ 生效），拆解回填保持 reply 协议形状；
    // 无 '/' 形态（无活跃进程早退等 fallback）按请求值回显（旧行为兜底）。
    const effectiveModel = await this.ctx.modelService.switchModel(sessionId, provider, modelId)
    const slash = effectiveModel.indexOf('/')
    this.ctx.reply(ws, msg.id, 'model.switched', {
      sessionId,
      provider: slash === -1 ? provider : effectiveModel.slice(0, slash),
      modelId: slash === -1 ? modelId : effectiveModel.slice(slash + 1),
    })
    return true
  }

  private handleConfigSetDefaultModel(msg: Extract<ClientMessage, { type: 'config.setDefaultModel' }>, ws: WsType): boolean {
    // W3 默认模型持久化：configService.setDefaultModel 已存在（写 settings.json）。
    // reply 回发起端（不带 source） + 广播给所有 panel（带 source='default-set'），与
    // setProvider/deleteProvider 的 newDefault 广播同构，让其它打开的设置面板同步默认模型下拉。
    // reply 与 broadcast 共用 ServerMessageMap['config.defaults'] 类型，source 为 optional。
    const { provider, modelId } = msg.payload
    this.ctx.configService.setDefaultModel(provider, modelId)
    this.ctx.reply(ws, msg.id, 'config.defaults', {
      defaultModel: `${provider}/${modelId}`,
    })
    this.ctx.broadcast({
      type: 'config.defaults',
      id: this.ctx.nextPushId(),
      payload: { defaultModel: `${provider}/${modelId}`, source: 'default-set' },
    })
    return true
  }

  private handleConfigGetSystemPrompt(msg: Extract<ClientMessage, { type: 'config.getSystemPrompt' }>, ws: WsType): boolean {
    // FR-6：读取 system-prompt 配置。corrupted 透传给前端（提示用户文件已损坏并重置）。
    const result = this.ctx.configService.getSystemPromptConfig()
    this.ctx.reply(ws, msg.id, 'config.systemPrompt', {
      config: result.config,
      corrupted: result.corrupted,
    })
    return true
  }

  private handleConfigSetSystemPrompt(msg: Extract<ClientMessage, { type: 'config.setSystemPrompt' }>, ws: WsType): boolean {
    // FR-6：写入 system-prompt 配置。失败（超长等）按 D10 错误信封回复，不广播；
    // 成功 reply + 广播 config.systemPrompt（corrupted=false）让所有 panel 同步。
    const { config } = msg.payload
    const result = this.ctx.configService.setSystemPromptConfig(config)
    if (!result.ok) {
      this.ctx.sendError(ws, 'set_system_prompt_failed', result.error ?? 'unknown error', msg.id)
      return true
    }
    this.ctx.reply(ws, msg.id, 'config.systemPrompt', { config, corrupted: false })
    this.ctx.broadcast({
      type: 'config.systemPrompt',
      id: this.ctx.nextPushId(),
      payload: { config, corrupted: false },
    })
    return true
  }

  private handleConfigGetTerminalConfig(msg: Extract<ClientMessage, { type: 'config.getTerminalConfig' }>, ws: WsType): boolean {
    // Phase 6：读取 terminal 配置。corrupted 透传给前端（提示用户文件已损坏并重置）。
    const result = this.ctx.configService.getTerminalConfig()
    this.ctx.reply(ws, msg.id, 'config.terminalConfig', {
      config: result.config,
      corrupted: result.corrupted,
    })
    return true
  }

  private handleConfigSetTerminalConfig(msg: Extract<ClientMessage, { type: 'config.setTerminalConfig' }>, ws: WsType): boolean {
    // Phase 6：写入 terminal 配置。失败（超范围等）按 D10 错误信封回复，不广播；
    // 成功 reply + 广播 config.terminalConfig（corrupted=false）让所有 panel 同步。
    const { config } = msg.payload
    const result = this.ctx.configService.setTerminalConfig(config)
    if (!result.ok) {
      this.ctx.sendError(ws, 'set_terminal_config_failed', result.error ?? 'unknown error', msg.id)
      return true
    }
    this.ctx.reply(ws, msg.id, 'config.terminalConfig', { config, corrupted: false })
    this.ctx.broadcast({
      type: 'config.terminalConfig',
      id: this.ctx.nextPushId(),
      payload: { config, corrupted: false },
    })
    return true
  }

  private handleConfigGetRetryConfig(msg: Extract<ClientMessage, { type: 'config.getRetryConfig' }>, ws: WsType): boolean {
    // llm-retry-settings：读 retry 域。缺省键已合并为 pi 默认值；configured 区分
    // 「显式配置」与「未配置（显示默认）」（D7），坏文件由 store schema guard 兜底。
    const result = this.ctx.configService.getRetryConfig()
    this.ctx.reply(ws, msg.id, 'config.retryConfig', result)
    return true
  }

  private handleConfigSetRetryConfig(msg: Extract<ClientMessage, { type: 'config.setRetryConfig' }>, ws: WsType): boolean {
    // llm-retry-settings：写 retry 域。校验失败（D8 越界）按 D10 错误信封回复，
    // 不广播不落盘；成功 reply + 广播 config.retryConfig（多窗口同步，同 terminal 范式）。
    // configured=true 的依据：mergeRetryConfig 无条件落盘顶层必填三键（enabled/maxRetries/
    // baseDelayMs），读侧键存在判定恒成立；provider 三键未设时被 patchKey 删除（= 采纳
    // pi 默认语义，未写入），不影响 configured 判定。
    const { config } = msg.payload
    const result = this.ctx.configService.setRetryConfig(config)
    if (!result.ok) {
      this.ctx.sendError(ws, 'set_retry_config_failed', result.error ?? 'unknown error', msg.id)
      return true
    }
    this.ctx.reply(ws, msg.id, 'config.retryConfig', { config, configured: true })
    this.ctx.broadcast({
      type: 'config.retryConfig',
      id: this.ctx.nextPushId(),
      payload: { config, configured: true },
    })
    return true
  }

  private async handleSessionSetThinkingLevel(msg: Extract<ClientMessage, { type: 'session.setThinkingLevel' }>, ws: WsType): Promise<boolean> {
    const { sessionId: sid, level } = msg.payload
    // P3（final gate）：reply 生效值而非请求值——pi 会钳制模型族不支持的档位
    //（mimo 族 max → high；钳制后 effective ≠ previous 时 pi 仍必发
    // thinking_level_changed 事件，isChanging=false 仅「值未变」场景——PS-04），
    // 回显请求值会污染前端 pending 确认
    const effective = await this.ctx.modelService.setThinkingLevel(sid as string, level as string)
    this.ctx.reply(ws, msg.id, 'session.thinkingLevelSet', { sessionId: sid, level: effective })
    return true
  }

  private handleConfigSetAutoRenameEnabled(msg: Extract<ClientMessage, { type: 'config.setAutoRenameEnabled' }>, ws: WsType): boolean {
    this.ctx.configService.setAutoRenameEnabled(msg.payload.enabled)
    this.ctx.reply(ws, msg.id, 'config.autoRenameEnabled', { enabled: this.ctx.configService.getAutoRenameEnabled() })
    return true
  }

  private handleConfigGetAutoRenameEnabled(msg: Extract<ClientMessage, { type: 'config.getAutoRenameEnabled' }>, ws: WsType): boolean {
    this.ctx.reply(ws, msg.id, 'config.autoRenameEnabled', { enabled: this.ctx.configService.getAutoRenameEnabled() })
    return true
  }

  private handleConfigSetRenameModel(msg: Extract<ClientMessage, { type: 'config.setRenameModel' }>, ws: WsType): boolean {
    this.ctx.configService.setRenameModel(msg.payload.model)
    this.ctx.reply(ws, msg.id, 'config.renameModel', { model: this.ctx.configService.getRenameModel() })
    return true
  }

  private handleConfigGetRenameModel(msg: Extract<ClientMessage, { type: 'config.getRenameModel' }>, ws: WsType): boolean {
    this.ctx.reply(ws, msg.id, 'config.renameModel', { model: this.ctx.configService.getRenameModel() })
    return true
  }

  // mode 非法值归一在 helper 层（与 setRenameModel 的归一纪律一致），reply 读回生效值。
  private handleConfigSetRenameMode(msg: Extract<ClientMessage, { type: 'config.setRenameMode' }>, ws: WsType): boolean {
    this.ctx.configService.setRenameMode(msg.payload.mode)
    this.ctx.reply(ws, msg.id, 'config.renameMode', { mode: this.ctx.configService.getRenameMode() })
    return true
  }

  private handleConfigGetRenameMode(msg: Extract<ClientMessage, { type: 'config.getRenameMode' }>, ws: WsType): boolean {
    this.ctx.reply(ws, msg.id, 'config.renameMode', { mode: this.ctx.configService.getRenameMode() })
    return true
  }

  private handleConfigGetSmartContextConfig(msg: Extract<ClientMessage, { type: 'config.getSmartContextConfig' }>, ws: WsType): boolean {
    this.ctx.reply(ws, msg.id, 'config.smartContextConfig', this.ctx.configService.getSmartContextConfig())
    return true
  }

  private handleConfigSetSmartContextEnabled(msg: Extract<ClientMessage, { type: 'config.setSmartContextEnabled' }>, ws: WsType): boolean {
    this.ctx.configService.setSmartContextEnabled(msg.payload.enabled)
    this.ctx.reply(ws, msg.id, 'config.smartContextEnabled', { enabled: this.ctx.configService.getSmartContextConfig().enabled })
    return true
  }

  private handleConfigSetSmartContextCompactModel(msg: Extract<ClientMessage, { type: 'config.setSmartContextCompactModel' }>, ws: WsType): boolean {
    this.ctx.configService.setSmartContextCompactModel(msg.payload.model)
    this.ctx.reply(ws, msg.id, 'config.smartContextCompactModel', { model: this.ctx.configService.getSmartContextConfig().compactModel })
    return true
  }

  private handleConfigSetSmartContextThresholds(msg: Extract<ClientMessage, { type: 'config.setSmartContextThresholds' }>, ws: WsType): boolean {
    this.ctx.configService.setSmartContextThresholds(msg.payload.thresholds)
    this.ctx.reply(ws, msg.id, 'config.smartContextThresholds', { thresholds: this.ctx.configService.getSmartContextConfig().reminderThresholds })
    return true
  }

  private handleConfigSetSmartContextExcludedModels(msg: Extract<ClientMessage, { type: 'config.setSmartContextExcludedModels' }>, ws: WsType): boolean {
    this.ctx.configService.setSmartContextExcludedModels(msg.payload.models)
    this.ctx.reply(ws, msg.id, 'config.smartContextExcludedModels', { models: this.ctx.configService.getSmartContextConfig().excludedModels })
    return true
  }

  private async handleConfigSetScopedModels(msg: Extract<ClientMessage, { type: 'config.setScopedModels' }>, ws: WsType): Promise<boolean> {
    const { models } = msg.payload
    // 格式校验：每条 ^[^/]+/.+$，非法整单拒绝
    if (!Array.isArray(models) || models.some(m => typeof m !== 'string')) {
      this.ctx.sendError(ws, 'invalid_payload', 'models 必须是字符串数组', msg.id)
      return true
    }
    // 格式契约与读侧 sanitize 单点（provider-extras-store SCOPED_MODEL_REGEX）
    const invalid = (models as string[]).filter(m => !SCOPED_MODEL_REGEX.test(m))
    if (invalid.length > 0) {
      this.ctx.sendError(ws, 'invalid_scoped_models', `以下模型格式非法（需 provider/modelId）：${invalid.join(', ')}`, msg.id)
      return true
    }
    // 去重保序（Set 迭代序 = 插入序）
    const deduped = [...new Set(models as string[])]
    // 写入（IConfigService.modifyScopedModels → XyzProviderStore RMW）
    const result = await this.ctx.configService.modifyScopedModels(() => deduped)
    const defaultSynced = this.syncDefaultToScopedModels(result)
    // 广播
    this.ctx.broadcastProviderList()
    if (defaultSynced) {
      this.ctx.broadcast({
        type: 'config.defaults',
        id: this.ctx.nextPushId(),
        payload: { defaultModel: result[0], source: 'default-set' },
      })
    }
    this.ctx.reply(ws, msg.id, 'config.scopedModels', { scopedModels: result })
    return true
  }

  /**
   * 列表非空且 scoped[0] ≠ 当前 default 时同步 default = scoped[0]（config.setScopedModels 编排步骤）。
   * 返回 defaultSynced：同步生效（含已是 default 的幂等情形）才广播 config.defaults；
   * 同步被跳过/失败时保留现有 default，不广播未落盘的假默认。
   */
  private syncDefaultToScopedModels(result: string[]): boolean {
    if (result.length === 0) return false
    const firstModel = result[0]
    try {
      const [provider, ...modelParts] = firstModel.split('/')
      const modelId = modelParts.join('/')
      // scoped[0] 的 provider 须在当前列表且未禁用：把禁用 provider 的模型写成
      // default 会被 getDefaultModel 内 findValidDefaultModel 随后冲掉（静默破坏
      // 「第一位即默认」），跳过同步、保留现有 default
      const providerInfo = this.ctx.configService.listProviders().find(p => p.id === provider)
      if (!providerInfo || providerInfo.enabled === false) {
        console.warn(`[settings-handler] setScopedModels: scoped[0] "${firstModel}" 的 provider 不可用（${providerInfo ? '已禁用' : '不在 providers 列表'}），跳过 default 同步，保留现有 default`)
        return false
      }
      const currentDefault = this.ctx.configService.getDefaultModel()
      if (!currentDefault || `${currentDefault.provider}/${currentDefault.modelId}` !== firstModel) {
        this.ctx.configService.setDefaultModel(provider, modelId)
      }
      return true
    } catch (err) {
      // best-effort 降级：scoped 白名单写入是主语义，default 同步失败（读 default/
      // 写 default 抛错）只 warn 不上抛——上抛会跳过广播与 reply，造成磁盘/前端/
      // 选择器三方状态撕裂（对齐 provider-config-helper cleanAuthCredential 惯例）
      console.warn(`[settings-handler] setScopedModels: default 同步到 "${firstModel}" 失败（scopedModels 已写入 ${result.length} 条），保留现有 default：`, err)
      return false
    }
  }

  private handleDiscoverModels(msg: Extract<ClientMessage, { type: 'config.discoverModels' }>, ws: WsType): boolean {
    const { baseUrl, apiKey, providerType, providerId, mode } = msg.payload
    // test 模式（D4）：按模型协议分组发真实最小请求——baseUrl / apiKey 忽略（凭据经 resolver
    // 唯一通道取，代表模型与端点回落链归 runtime）。缺省 / 'discover' 保持既有 GET /v1/models
    // 行为逐字节不变（CLI 与旧调用方零改动，向后兼容）。
    if (mode === 'test') return this.handleTestConnections(msg, ws, providerId)
    // 链 2（D3 收口）：payload 未带 apiKey 时经 resolver async 版解析（auth.json → models.json），
    // 修复「catalog 凭据只在 auth.json 时恒 miss」。
    const credentialPromise: Promise<string | undefined> = apiKey
      ? Promise.resolve(apiKey)
      : providerId
        ? this.resolveProviderApiKey(providerId)
        : Promise.resolve(undefined)
    // 错误文案翻译（ByteString / fetch failed → 中文）已下沉 model-service；
    // handler 只 reply service 返回的 models 或 error.message。
    credentialPromise
      .then((resolvedApiKey) => this.ctx.modelService.discoverModelsFromApi(baseUrl, resolvedApiKey, providerType))
      .then((models) => { this.ctx.reply(ws, msg.id, 'config.discoveredModels', { models, success: true }) })
      .catch((e: unknown) => {
        this.ctx.reply(ws, msg.id, 'config.discoveredModels', { models: [], success: false, error: toErrorMessage(e) })
      })
    return true
  }

  /**
   * test 模式编排：凭据经 resolver → modelService 发 per-协议真实最小请求 → reply results。
   * 行级失败（协议不支持 / 无 baseUrl / 无启用模型 / HTTP / 网络）不改变顶层 success，
   * 顶层 success:false 仅承载 provider 级失败 code（见 PROVIDER_CONNECTION_TEST_ERRORS）。
   */
  private handleTestConnections(
    msg: Extract<ClientMessage, { type: 'config.discoverModels' }>,
    ws: WsType,
    providerId: string | undefined,
  ): boolean {
    if (!providerId) {
      this.replyTestResult(ws, msg.id, { success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.providerNotFound })
      return true
    }
    // 交集类型的可选方法：解构后判函数（运行时守卫，替代对 IModelService 的强制断言）
    const testProviderConnections = this.ctx.modelService.testProviderConnections
    if (typeof testProviderConnections !== 'function') {
      this.replyTestResult(ws, msg.id, { success: false, error: PROVIDER_CONNECTION_TEST_ERRORS.testUnavailable })
      return true
    }
    this.resolveProviderApiKey(providerId)
      .then(apiKey => testProviderConnections.call(this.ctx.modelService, providerId, apiKey, this.ctx.connectionTester))
      .then(outcome => { this.replyTestResult(ws, msg.id, outcome) })
      .catch((e: unknown) => {
        this.replyTestResult(ws, msg.id, { success: false, error: toErrorMessage(e) })
      })
    return true
  }

  /** test 模式 reply 装配（成功带 results、失败带 provider 级 code；`models` 恒空——test 不发现模型）。 */
  private replyTestResult(ws: WsType, id: string | undefined, outcome: ProviderConnectionTestOutcome): void {
    this.ctx.reply(ws, id, 'config.discoveredModels', outcome.success
      ? { models: [], success: true, results: outcome.results }
      : { models: [], success: false, error: outcome.error, results: [] })
  }

  /** discover 凭据回查（链 2）：唯一通道（auth.json → models.json，ctx 构造必需注入）。 */
  private async resolveProviderApiKey(providerId: string): Promise<string | undefined> {
    const resolved = await this.ctx.providerCredentialResolver.resolveProviderCredential(providerId)
    return resolved?.key
  }
}
