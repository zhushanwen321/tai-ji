/**
 * Settings and model configuration message handler mixin.
 * Extracted from RuntimeServer to reduce file size.
 *
 * 域拆分（源码简化 T6）：本文件保留共享 ctx 契约（SettingsHandlerContext）与 case
 * 路由表；case 体按业务域迁入同目录子 handler（先例：config-preferences-message-handler.ts
 * 同款 class + handle() switch 形态，未命中返回 false）。路由表每条委托到所属域子
 * handler 的 handle()——查表命中即域归属成立。域文件清单：
 *   - config-preferences-message-handler.ts      workspace 偏好组（worktree/streaming idle/基分支，链式先行）
 *   - provider-message-handler.ts                provider CRUD/目录刷新/环境检查/导入迁移/源检测
 *   - oauth-message-handler.ts                   provider OAuth 凭据
 *   - resources-message-handler.ts               skill/agent/extension 资源发现与目录
 *   - model-message-handler.ts                   模型列表/切换/默认值/scoped/thinking 档位/发现
 *   - tool-permissions-message-handler.ts        声明式工具权限
 *   - system-prompt-terminal-message-handler.ts  system prompt / terminal 配置
 *   - retry-config-message-handler.ts            LLM retry 配置
 *   - rename-config-message-handler.ts           会话自动重命名配置
 *   - smart-context-config-message-handler.ts    smart context 配置
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, SkillCacheScope } from '@xyz-agent/shared'
import type { IConfigService, ISessionService, IModelService, IAuthService } from '../interfaces.js'
import type { SkillRegistry } from '../services/skill-registry.js'
import type { MessageHandlerContext } from './message-context.js'
import { ConfigPreferencesMessageHandler } from './config-preferences-message-handler.js'
import { ProviderMessageHandler } from './provider-message-handler.js'
import { OauthMessageHandler } from './oauth-message-handler.js'
import { ResourcesMessageHandler } from './resources-message-handler.js'
import { ModelMessageHandler } from './model-message-handler.js'
import { ToolPermissionsMessageHandler } from './tool-permissions-message-handler.js'
import { SystemPromptTerminalMessageHandler } from './system-prompt-terminal-message-handler.js'
import { RetryConfigMessageHandler } from './retry-config-message-handler.js'
import { RenameConfigMessageHandler } from './rename-config-message-handler.js'
import { SmartContextConfigMessageHandler } from './smart-context-config-message-handler.js'
import type { IProviderCredentialResolver } from '../services/ports/provider-credential-resolver.js'
import type { IModelConnectionTester } from '../services/ports/model-connection-tester.js'
import type { ProviderConnectionTestService } from '../services/model-service.js'

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
 * config/model case 路由表类型：每个消息 type 映射到对应 case 处理器，msg 参数按
 * key 窄化（Extract 收窄与 switch narrowing 行为一致——见 shared protocol.ts 的
 * ClientMessage 派生注释）。case 处理器同步返回 boolean 或异步返回 Promise<boolean>。
 * 表驱动取代原 ~50 分支 switch：主函数只留「偏好组先行 + 查表 + 命中调用」，每个
 * case 体迁入所属域子 handler（行为保持提取，源码简化 T6）。
 */
type SettingsCaseRoutes = {
  [K in ClientMessageType]?: (msg: Extract<ClientMessage, { type: K }>, ws: WsType) => boolean | Promise<boolean>
}

export class SettingsMessageHandler {
  /** 域子 handler（构造期装配，全部消费同一 ctx；域清单见文件头注释） */
  private preferencesHandler: ConfigPreferencesMessageHandler
  private providerHandler: ProviderMessageHandler
  private oauthHandler: OauthMessageHandler
  private resourcesHandler: ResourcesMessageHandler
  private modelHandler: ModelMessageHandler
  private toolPermissionsHandler: ToolPermissionsMessageHandler
  private systemPromptTerminalHandler: SystemPromptTerminalMessageHandler
  private retryConfigHandler: RetryConfigMessageHandler
  private renameConfigHandler: RenameConfigMessageHandler
  private smartContextConfigHandler: SmartContextConfigMessageHandler

  constructor(private ctx: SettingsHandlerContext) {
    this.preferencesHandler = new ConfigPreferencesMessageHandler(ctx)
    this.providerHandler = new ProviderMessageHandler(ctx)
    this.oauthHandler = new OauthMessageHandler(ctx)
    this.resourcesHandler = new ResourcesMessageHandler(ctx)
    this.modelHandler = new ModelMessageHandler(ctx)
    this.toolPermissionsHandler = new ToolPermissionsMessageHandler(ctx)
    this.systemPromptTerminalHandler = new SystemPromptTerminalMessageHandler(ctx)
    this.retryConfigHandler = new RetryConfigMessageHandler(ctx)
    this.renameConfigHandler = new RenameConfigMessageHandler(ctx)
    this.smartContextConfigHandler = new SmartContextConfigMessageHandler(ctx)
  }

  /**
   * case 路由表：key 集合与原 switch case 一一对应，每条委托所属域子 handler 的
   * handle()（子 handler 内 switch 精确匹配自身 case——查表命中即域归属成立，handle
   * 必然命中返回 true）。未知 type 查表落空返回 false（由 server 发 unknown_type，
   * 同原 switch default 行为）。
   */
  private readonly routes: SettingsCaseRoutes = {
    // ── provider 域（provider-message-handler.ts）──
    'config.getProviders': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.refreshProviderCatalogs': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.setProvider': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.deleteProvider': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.toggleProviderEnabled': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.removeProviderByKind': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.checkEnvVars': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.detectSources': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.listBuiltinProviders': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.previewImportProviders': (msg, ws) => this.providerHandler.handle(msg, ws),
    'config.applyImportProviders': (msg, ws) => this.providerHandler.handle(msg, ws),
    // ── OAuth 域（oauth-message-handler.ts）──
    'config.oauthLogin': (msg, ws) => this.oauthHandler.handle(msg, ws),
    'config.oauthCancel': (msg, ws) => this.oauthHandler.handle(msg, ws),
    'config.hasOAuth': (msg, ws) => this.oauthHandler.handle(msg, ws),
    'config.oauthLogout': (msg, ws) => this.oauthHandler.handle(msg, ws),
    // ── 资源发现域（resources-message-handler.ts）──
    'config.scanSkills': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.scanSessionSkills': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.getGlobalSkills': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.getProjectSkills': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.setSkillDirs': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.setSkill': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.deleteSkill': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.scanAgents': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.setAgentDirs': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.setAgent': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.setExtensionDirs': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    'config.deleteAgent': (msg, ws) => this.resourcesHandler.handle(msg, ws),
    // ── 模型域（model-message-handler.ts）──
    'config.discoverModels': (msg, ws) => this.modelHandler.handle(msg, ws),
    'model.list': (msg, ws) => this.modelHandler.handle(msg, ws),
    'model.switch': (msg, ws) => this.modelHandler.handle(msg, ws),
    'config.setDefaultModel': (msg, ws) => this.modelHandler.handle(msg, ws),
    'session.setThinkingLevel': (msg, ws) => this.modelHandler.handle(msg, ws),
    'config.setScopedModels': (msg, ws) => this.modelHandler.handle(msg, ws),
    // ── 工具权限域（tool-permissions-message-handler.ts）──
    'config.setToolPermissions': (msg, ws) => this.toolPermissionsHandler.handle(msg, ws),
    // ── system prompt / terminal 域（system-prompt-terminal-message-handler.ts）──
    'config.getSystemPrompt': (msg, ws) => this.systemPromptTerminalHandler.handle(msg, ws),
    'config.setSystemPrompt': (msg, ws) => this.systemPromptTerminalHandler.handle(msg, ws),
    'config.getTerminalConfig': (msg, ws) => this.systemPromptTerminalHandler.handle(msg, ws),
    'config.setTerminalConfig': (msg, ws) => this.systemPromptTerminalHandler.handle(msg, ws),
    // ── LLM retry 域（retry-config-message-handler.ts）──
    'config.getRetryConfig': (msg, ws) => this.retryConfigHandler.handle(msg, ws),
    'config.setRetryConfig': (msg, ws) => this.retryConfigHandler.handle(msg, ws),
    // ── 重命名配置域（rename-config-message-handler.ts）──
    'config.setAutoRenameEnabled': (msg, ws) => this.renameConfigHandler.handle(msg, ws),
    'config.getAutoRenameEnabled': (msg, ws) => this.renameConfigHandler.handle(msg, ws),
    'config.setRenameModel': (msg, ws) => this.renameConfigHandler.handle(msg, ws),
    'config.getRenameModel': (msg, ws) => this.renameConfigHandler.handle(msg, ws),
    'config.setRenameMode': (msg, ws) => this.renameConfigHandler.handle(msg, ws),
    'config.getRenameMode': (msg, ws) => this.renameConfigHandler.handle(msg, ws),
    // ── smart context 域（smart-context-config-message-handler.ts）──
    'config.getSmartContextConfig': (msg, ws) => this.smartContextConfigHandler.handle(msg, ws),
    'config.setSmartContextEnabled': (msg, ws) => this.smartContextConfigHandler.handle(msg, ws),
    'config.setSmartContextCompactModel': (msg, ws) => this.smartContextConfigHandler.handle(msg, ws),
    'config.setSmartContextThresholds': (msg, ws) => this.smartContextConfigHandler.handle(msg, ws),
    'config.setSmartContextExcludedModels': (msg, ws) => this.smartContextConfigHandler.handle(msg, ws),
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
}
