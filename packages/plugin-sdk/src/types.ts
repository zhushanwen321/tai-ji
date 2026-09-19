/**
 * 插件系统契约类型 —— single source of truth（D28 方向反转，2026-09-05）。
 *
 * 本文件是 taiji 插件契约的权威定义：面向插件作者对外发布（第三方插件作者无需
 * 装整个 monorepo）；除 Bridge* 回包形状与 GUI 协议段定义源在
 * @zhushanwen/extension-protocol（见下方 D4 单源化说明）外无运行时依赖。
 *
 * 消费方（runtime 侧薄壳，保持其既有导入面不变）：
 *   packages/runtime/src/services/plugin-service/plugin-types.ts          （主域 + Bridge/AgentAPI/Tool 等）
 *   packages/runtime/src/services/plugin-service/plugin-types/hook-types.ts（Hook 域）
 *   descriptor / rpc 子域亦经本文件（SDK）re-export 消费，无本地副本。
 *
 * 修改契约：直接编辑本文件（对外类型名/结构零变化承诺——published API 兼容）。
 *
 * 历史：2026-09-05 前本文件由 packages/plugin-sdk/scripts/sync-types.sh 从
 * runtime 的 plugin-types 自动生成（runtime 为真相源的镜像方向）；D28 审计
 * 记录了当时的刻意重复理由。方向反转为「SDK 为 SSOT、runtime re-export」后
 * sync-types.sh 已删除（生成方向不再存在），依赖方向 = runtime → SDK 单向。
 * D4 单源化（ext-simplify-16）后 Bridge* 回包形状定义源上收
 * @zhushanwen/extension-protocol（唯一定义点，下方 re-export 消费），本文件
 * 不再零依赖，但除该类型依赖外仍无运行时依赖。
 */

// D4 单源化：Bridge* 回包形状唯一定义源 = @zhushanwen/extension-protocol。
// import 供本文件内 ToolExecuteHandler / update(guiTree) 等类型引用；export 保持既有
// `BridgeInterceptResponse`/`BridgeToolExecuteResponse` 导入面不变。
import type { BridgeInterceptResponse, BridgeToolExecuteResponse, GuiComponent } from '@zhushanwen/extension-protocol'

/**
 * GUI 渲染协议核心类型定义（单源化：定义源 = @zhushanwen/extension-protocol）。
 *
 * GuiComponent 是 pi Component { render(width): string[] } 的可序列化镜像。
 * extension 按 ctx.mode 分支：TUI 走原生 Component，RPC 走 GuiComponent（放进 details.__gui__）。
 *
 * 收敛说明（2026-09-17 ext-simplify-16 D4 同款）：本段曾是与
 * extension-protocol/src/core/types.ts 逐字手工镜像的 167 行副本（另有一套文本探针
 * 守卫测试）；依赖方向本就允许 plugin-sdk → extension-protocol（Bridge* 回包形状
 * 已如此），故改单行 re-export，镜像副本与守卫测试一并删除。导出名与类型面零变化
 * （published API 兼容承诺不变）。
 *
 * @see docs/architecture/extension-gui-protocol.md
 */

// 单源化 re-export：GUI 协议段唯一定义源 = @zhushanwen/extension-protocol。
// GuiComponent 另经上方 import 供本文件内后续类型引用（re-export 不引入本地作用域）。
export type {
  GuiComponent,
  GuiComponentType,
  GuiComponentProps,
  GuiRenderResult,
  WidgetMeta,
  StatItem,
  TreeItem,
  TreeItemIcon,
} from '@zhushanwen/extension-protocol'

export { PROTOCOL_VERSION } from '@zhushanwen/extension-protocol'

/**
 * 插件描述域类型（manifest/descriptor 契约面）
 *
 * 分层标注（IF2）：
 * - @stable — manifest/descriptor 解析契约（TaijiManifest/PluginDescriptor/PluginContributes）
 * - @internal — runtime 内部扫描态字段（PluginState 引用、compatibilityError）
 */

/** @stable — 插件来源：随应用分发的内置插件 或 用户安装的外部插件 */
export type PluginSource = 'built-in' | 'external'

/**
 * @stable — 插件 manifest（解析自 package.json 的 taijiPlugin 字段）。
 */
export interface TaijiManifest {
  manifestVersion: 1
  main: string
  activationEvents: string[]
  trustLevel?: 'trusted' | 'sandbox'
  permissions?: string[]
  contributes?: PluginContributes
  /** 插件来源，由 registry 扫描时自动设置，manifest 中声明无效 */
  source?: PluginSource
  /** 该插件依赖的其他插件 ID 列表 */
  extensionDependencies?: string[]
}

/**
 * @stable — 插件 package.json 契约。
 */
export interface TaijiPackageJson {
  name: string
  version: string
  description?: string
  displayName?: string
  taijiPlugin: TaijiManifest
  engines?: { 'taiji'?: string }
}

// ── Descriptor（扫描后产出的完整描述）──────────────────────────

/**
 * @stable — 完整插件描述（扫描后产出，registry 对外契约面）。
 */
export interface PluginDescriptor {
  pluginId: string
  version: string
  displayName: string
  description: string
  main: string
  activationEvents: string[]
  trustLevel: 'trusted' | 'sandbox'
  status: PluginState
  contributes: PluginContributes
  permissions: string[]
  engines: { 'taiji': string }
  pluginPath: string
  /** 插件来源：built-in（随应用分发）或 external（用户安装） */
  source: PluginSource
  /** 该插件依赖的其他插件 ID 列表 */
  extensionDependencies: string[]
  /** 版本不兼容时的错误描述 */
  compatibilityError?: string
}

/**
 * @stable — 插件贡献点声明（contributes，schema v2）。
 */
export interface PluginContributes {
  slashCommands?: Array<{ name: string; description: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks?: string[]
  views?: PluginContributesView[]
  menus?: PluginContributesMenu
  commands?: PluginContributesCommand[]
  configuration?: PluginContributesConfiguration
  statusBarItems?: PluginContributesStatusBarItem[]
  headerActions?: PluginContributesHeaderAction[]
  modals?: PluginContributesModal[]
}

/**
 * @proposed — schema v2 views 声明（panels 演进产物，placement 为开放字符串——
 * 挂载点由壳注册）。
 */
export interface PluginContributesView {
  id: string
  title: string
  view?: string
  /** 挂载点名：'sidebar.tab' | 'panel.header' | 'composer.toolbar' | 'drawer.tab' | 'statusbar' 等，开放字符串（壳注册制） */
  placement: string
  viewType?: 'gui' | 'webview' | 'tree'
  activationEvent?: string
  initialVisibility?: 'visible' | 'hidden'
}

/**
 * @proposed — schema v2 menus 按挂载点名分组的命令菜单映射
 * （VSCode contribution points 风格）。键集不含 'panel.header'——该键自 schema 起无
 * 渲染端消费方（声明死通道，D3 删除），顶栏点位由 headerActions 承接。
 */
export interface PluginContributesMenu {
  'composer.toolbar'?: PluginMenuItem[]
  'sidebar.footer'?: PluginMenuItem[]
}

/** @proposed — 菜单项 */
export interface PluginMenuItem {
  command: string
  when?: string
  group?: string
}

/**
 * @proposed — schema v2 声明式命令表（与 api.commands.register 互补：
 * 声明提供元数据，register 提供 handler）。
 */
export interface PluginContributesCommand {
  command: string
  title: string
  category?: string
  keybinding?: string
  when?: string
  icon?: string
}

/**
 * @proposed — schema v2 JSON Schema 子集（VSCode configuration 风格），
 * 驱动设置页表单。
 */
export interface PluginContributesConfiguration {
  title?: string
  properties: Record<string, PluginConfigurationProperty>
}

/** @proposed — 配置属性定义 */
export interface PluginConfigurationProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  default?: unknown
  description?: string
  enum?: unknown[]
  enumDescriptions?: string[]
}

/**
 * @proposed — schema v2 status bar 贡献（旧三字段原样保留保证向后兼容，
 * 扩展字段全 optional）。
 */
export interface PluginContributesStatusBarItem {
  id: string
  text: string
  priority: number
  alignment?: 'left' | 'right'
  scope?: 'per-session' | 'global'
  commandId?: string
  tooltip?: string
}

/**
 * @proposed — panel header 按钮区贡献（icon 为 lucide 名字符串，宿主解析；
 * badge/tooltip/disabled 等可变字段经 api.ui.updateHeaderAction 运行时更新）。
 */
export interface PluginContributesHeaderAction {
  id: string
  title: string
  icon: string
  commandId: string
  /** 与内置按钮组的相对序；缺省追加在后 */
  order?: number
}

/**
 * @proposed — modal 弹层声明（只有 {id,title,width?}，无 commandId 字段——开层只有
 * api.ui.showModal 一条路，声明侧供枚举/置灰/默认元数据）。
 */
export interface PluginContributesModal {
  id: string
  title: string
  width?: 'sm' | 'md' | 'lg'
}

// ── RPC 线协议类型（Wire Protocol）────────────────────────────────────
//
// RPC 层的线协议类型与错误码，无跨域依赖。

export interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: Record<string, unknown>
}

export interface RpcSuccessResponse {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface RpcErrorResponse {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params: Record<string, unknown>
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification

// ── Error Codes ──────────────────────────────────────────────────

/**
 * @stable — RPC 错误码常量，SDK 契约面。
 *
 * 经 Object.freeze 冻结：插件与 runtime 均不可在运行时修改错误码，
 * 保证错误判定（code 比较）的确定性。
 */
export const PluginRpcErrorCodes = Object.freeze({
  RPC_TIMEOUT: -32000,
  PERMISSION_DENIED: -32001,
  PLUGIN_NOT_FOUND: -32010,
  PLUGIN_NOT_ACTIVE: -32011,
  STORAGE_FULL: -32040,
  PAYLOAD_TOO_LARGE: -32021,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
} as const)

export type PluginRpcErrorCode = (typeof PluginRpcErrorCodes)[keyof typeof PluginRpcErrorCodes]

/**
 * Hook 类型（插件拦截/观察机制）
 *
 * 分层标注（IF2）：
 * - @proposed — Hook 机制整体为 Phase 2 扩展面（API 表面仍在演进）
 * - @internal — runtime 内部执行细节（HookResult 等主线程塑形）
 */

/**
 * @proposed — 可拦截的 hook 类型，插件可阻止或修改数据。
 */
export type InterceptorHookType =
  | 'onToolCall'
  | 'onSlashCommand'
  | 'onMessageSend'
  | 'onBeforeSendMessage'
  | 'onBeforeToolCall'
  | 'onBeforeAgentStart'
  | 'onAfterToolResult'

/**
 * @proposed — 只观察的 hook 类型，插件只能读取数据不能阻止。
 * onPiEvent 是泛型 observe 通道（D2-4）：事件名经 context 传给 handler，
 * 插件在 handler 内自行按事件名过滤。
 *
 * [HISTORICAL] Fix-6：曾含 'onMessage' | 'onSessionCreate' | 'onSessionDestroy' 三个
 * 字面量——无注册面（createHookApi 不暴露对应方法）、无调用面（event-interpreter /
 * bridge-interop 不以此 key 调 executeHooks），属死类型，已删除（2026-08-15 W02 审查）。
 */
export type ObserverHookType = 'onPiEvent'

/** @proposed — 所有 hook 类型 */
export type HookType = InterceptorHookType | ObserverHookType

/**
 * @proposed — 拦截器返回结果：允许/阻止/修改数据/注入消息。
 *
 * 三个语义域互不混淆（git `7a3797d0b` 版 plugin-intercept-injection §3.3-D1，文档已退役于
 * `fadd8b8b4`）：
 * - 阻止：proceed:false — runtime 侧终止后续插件 hook 链并留痕；当前 pi 集成不阻止
 *   agent turn（pi before_agent_start 无 block 槽位，turn 照常进行）
 * - 改写：modifiedData — 改写当前 hook 事件的 data（如 onAfterToolResult 改写工具输出），
 *   管线按「链上最后一个」覆盖语义透传（HookResult.transformedData）
 * - 注入：injectedMessages — 新增 LLM 上下文消息，跨插件累积拼接（非改写、非阻止）
 */
export interface InterceptorResult {
  /**
   * false = 终止后续插件 hook 链 + 留痕。诚实边界：pi 链路无 block 槽位，
   * blocked 回包不阻止 agent turn（turn 照常进行）。
   */
  proceed: boolean
  /** proceed:false 时的原因描述（留痕 / blocked 回包用） */
  reason?: string
  /** 改写语义：改写当前 hook 事件的 data（链上最后一个生效，非累积）。勿用于注入 */
  modifiedData?: unknown
  /**
   * 注入语义：向 LLM 上下文新增的消息文本。契约边界（D1）：仅 onBeforeAgentStart
   * （bridge intercept 链路）被消费；其他 intercept hookType 返回非空值类型合法但
   * 无运行时效果（管线 warn 留痕，作者应移除误用）。observe hook（onPiEvent）的
   * 响应在 Worker 侧丢弃，此处误用注入无任何运行时信号，仅靠本注释约束。
   */
  injectedMessages?: string[]
}

/**
 * @proposed — Hook 执行上下文。
 */
export interface HookContext {
  pluginId: string
  hookType: HookType
  data: unknown
  timestamp: number
  /** Phase 3: 从 event-adapter/index.ts 透传的额外上下文 */
  sessionId?: string
  content?: string
}

/**
 * @proposed — Hook 拦截器处理函数（可阻止或修改数据）。
 */
export type HookInterceptor = (context: HookContext) => Promise<InterceptorResult>

/**
 * @proposed — Hook 观察者处理函数（只能读取数据，不能阻止）。
 * 可选返回 InterceptorResult（proceed 恒为 true 语义，modifiedData 改写 output）——
 * onAfterToolResult 的 transform 语义经此回传（D2-3：Worker 响应携带 modifiedData，
 * 主线程 HookPipeline 映射为 HookResult.transformedData，消费侧 event-interpreter 读取）。
 */
export type HookObserver = (context: HookContext) => Promise<InterceptorResult | void>

/**
 * @proposed — PiEvent 处理函数。
 */
export type PiEventCallback = (eventName: string, data: unknown) => Promise<void>

/**
 * @internal — runtime 内部：Hook 通用返回结果（主线程塑形）。
 * injectedMessages 与 transformedData 语义分叉（git `7a3797d0b` 版 plugin-intercept-injection
 * §3.3-D2/D3，文档已退役于 `fadd8b8b4`）：
 * 前者为管线层逐插件形状校验后的合法条目跨插件累积拼接（priority 执行序），后者保持
 * 「链上最后一个」覆盖语义；消费方为 handleBridgeIntercept 的注入映射。
 */
export interface HookResult {
  blocked: boolean
  blockedBy?: string
  reason?: string
  transformedData?: unknown
  /** 注入语义（仅 onBeforeAgentStart 链路消费）：管线已校验的合法条目，跨插件累积 */
  injectedMessages?: string[]
}

/**
 * 插件系统内部类型定义
 *
 * 这些类型仅用于 runtime（主进程/Worker）内部的插件管理，
 * 不出现在前端↔runtime 的共享协议中。
 *
 * 分层标注（IF2）：
 * - @stable — 稳定契约面（Phase1AgentAPI 核心面 storage/notify/sessions、
 *   PermissionConstants、PluginRpcErrorCodes、Disposable、SessionInfo、PluginStateStorage）
 * - @experimental — 已显式降级的 API（events 插件间事件总线：未实现，调用即抛
 *   NOT_IMPLEMENTED；已移出稳定面）
 * - @proposed — 演进中 API（Phase2AgentAPI 扩展面 tools/hooks/config/sessionData/
 *   ui/agent/workspace、ToolRegistration、HookEntry、StatusBarItemOptions 等）
 * - @internal — runtime 内部塑形对象（WorkerHandle、PluginContext、Bridge* 等；
 *   BridgeSyncPayload 定义源在 @zhushanwen/extension-protocol，IPluginServiceDeps
 *   为 runtime 专属内部类型——两者均不在本 SDK 面）
 */

// ── Descriptor / Manifest 域 ───────────────────────────────────────
// 留痕（历史区段标记）：descriptor 域定义见本文件上方「插件描述域类型」段
// （SSOT）；runtime 侧 plugin-types.ts 经本文件 re-export 消费，无本地副本。
// ── Worker 类型 ─────────────────────────────────────────────────

/** @internal — runtime 内部：Worker 句柄，仅主进程 Worker 池使用 */
export interface WorkerHandle {
  workerId: string
  threadId: number
  trustLevel: 'trusted' | 'sandbox'
  pluginIds: string[]
  status: 'idle' | 'active' | 'crashed' | 'terminated'
  lastActiveAt: number
  memoryUsage?: number
}

/** @internal — runtime 内部：子进程句柄，仅 PluginHostProcess（fork 版）使用 */
export interface ProcessHandle {
  processId: string
  pid: number
  trustLevel: 'trusted' | 'sandbox'
  pluginIds: string[]
  status: 'active' | 'crashed' | 'terminated'
  lastActiveAt: number
}

// ── Activation 类型 ────────────────────────────────────────────

/** @internal — runtime 内部：插件激活事件（激活时机声明） */
export type ActivationEventType = 'onStartupFinished' | 'onSessionCreate' | 'onSlashCommand' | 'onToolCall'

/** @internal — runtime 内部：激活事件载荷 */
export interface ActivationEvent {
  type: ActivationEventType
  command?: string
  tool?: string
}

// ── Plugin Context（传递给插件 activate 函数的上下文）──────────

/** @internal — runtime 内部：插件 activate 上下文（不进 SDK 插件作者契约面） */
export interface PluginContext {
  readonly pluginId: string
  readonly pluginPath: string
  readonly globalState: PluginStateStorage
  readonly workspaceState: PluginStateStorage
  readonly api: Phase2AgentAPI
  readonly subscriptions: Disposable[]
}

/** @internal — runtime 内部：插件模块加载契约 */
export interface PluginModule {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

// ── AgentAPI 类型（Phase 1 最小集）───────────────────────────────
//
// TODO(keystone): Phase1AgentAPI / Phase2AgentAPI / SessionInfo 是「漏的拱顶石」——
// Phase2AgentAPI 跨域引用 ToolRegistration、HookInterceptor、PiEventCallback、
// StatusBarItemOptions，SessionInfo 又被 api/session-api 等消费。把它移到独立文件
// 只会搬运耦合、制造 import 纠缠，故本轮 P3 拆分刻意将其保留在此处。
// 待 tool/hook 域各自稳定、API 表面收敛后再独立。

/**
 * @stable — Phase 1 最小集 AgentAPI 核心面（storage/notify/sessions）。
 *
 * 此核心面是插件可依赖的稳定契约：storage（全局/工作区存储）、notify（通知）、
 * sessions（会话查询、消息发送与生命周期事件订阅）。events 面已降级为
 * @experimental（见下方 events 字段注释）。
 */
export interface Phase1AgentAPI {
  readonly storage: {
    readonly global: PluginStateStorage
    readonly workspace: PluginStateStorage
  }
  readonly notify: {
    info(message: string): Promise<void>
    warning(message: string): Promise<void>
    error(message: string): Promise<void>
  }
  readonly sessions: {
    list(): Promise<SessionInfo[]>
    get(id: string): Promise<SessionInfo | undefined>
    getActive(): Promise<SessionInfo | undefined>
    /**
     * [plugin-header-action-modal-points D6/u5b] 写路径回执：sessionId 必填（E15——缺省
     * 在 runtime 层拒绝 INVALID_SESSION_ID）；requireCommand 为写路径前置原子校验的命令名
     * （restore 后、busy 预检前校验，未命中拒发 reason:'command-missing'——命令串永不漏进模型）。
     * 回执 reason 词表：运行面分支只看 accepted，reason 是诊断/文案面。
     */
    sendMessage(params: {
      sessionId: string
      role: 'user' | 'system'
      content: string
      requireCommand?: string
    }): Promise<{ accepted: boolean; reason?: 'busy' | 'compacting' | 'bash' | 'command-missing' | 'hook-blocked' | 'error' }>
    /**
     * [AP-4/u2d] 条目镜像读：live only（无活跃 pi 进程抛 SESSION_NOT_ACTIVE），
     * customType 服务端精确过滤，sinceEntryId 游标增量。
     */
    readEntries(sessionId: string, opts: { customType: string; sinceEntryId?: string }): Promise<PluginSessionEntries>
    /** [AP-4/u2d] 状态查询（投影 {name, description?, source}）；会话未激活抛 SESSION_NOT_ACTIVE。 */
    getCommands(sessionId: string): Promise<Array<{ name: string; description?: string; source: string }>>
    onDidCreateSession(handler: (session: SessionInfo) => void): Disposable
    onDidDestroySession(handler: (session: SessionInfo) => void): Disposable
    /** [AP-4/u5b] 会话激活订阅：session.switch 成功（含 auto-restore）时投递（徽标/列表补拉触发源）。 */
    onDidActivateSession(handler: (session: SessionInfo) => void): Disposable
    /** [AP-4/u2d] entry 失效订阅：只发失效信号无 payload，收信号后 readEntries(sinceEntryId) 重拉。 */
    onEntriesInvalidated(
      sessionId: string,
      customType: string,
      handler: (sessionId: string, customType: string) => void,
    ): Disposable
  }
  /**
   * @experimental — 插件间事件总线**未实现**（plugin.event.* 通知全仓无生产方，
   * 曾是 SDK 稳定面上的死链路，2026-08 显式降级）。调用 events.on/emit 即抛
   * NOT_IMPLEMENTED（带 issue 指引）。等出现真实消费方再设计实现；订阅 session
   * 生命周期请用 api.sessions.onDidCreateSession / onDidDestroySession（已实现）。
   */
  readonly events: {
    on(event: string, handler: (data: unknown) => void): Disposable
    emit(event: string, data: unknown): void
  }
}

/**
 * @stable — 会话信息（sessions 面返回的稳定数据结构）。
 */
export interface SessionInfo {
  id: string
  label: string
  cwd: string
  // 与 shared/session.ts 的 SessionStatus 对齐（含 W4 新增的 'done'/'stopped' 终态）。
  status: 'active' | 'idle' | 'error' | 'dead' | 'done' | 'stopped'
  createdAt: number
  lastActiveAt: number
}

/**
 * @stable — [AP-2/u5b] plugin modal 关闭原因词表（单点闭集；宿主 dismiss / 切会话 /
 * 宿主浮层 / runtime replaced / 插件消失五类发起方共用）。
 */
export type PluginModalClosedReason =
  | 'dismissed'
  | 'session-switched'
  | 'host-overlay'
  | 'replaced'
  | 'plugin-gone'

// ── Storage 类型 ─────────────────────────────────────────────────

/**
 * @stable — [AP-4/u2d] 条目镜像投影：含 type/customType（共享折叠器 replayFoldEntries
 * 的首道守卫依赖这两个字段）；data 原样透传（域语义插件解）；pi 树结构噪声不出 runtime。
 */
export interface PluginSessionEntry {
  id: string
  timestamp: string
  type: 'custom'
  customType: string
  data: unknown
}

/**
 * @stable — [AP-4/u2d] readEntries 回包信封：sessionFile 供 fork 继承场景按
 * ownerSessionFile 折叠过滤；leafEntryId = 下次调用的 sinceEntryId（pi 无叶子时省略）。
 */
export interface PluginSessionEntries {
  sessionFile?: string
  entries: PluginSessionEntry[]
  leafEntryId?: string
}

/**
 * @stable — 键值存储接口（storage 面的稳定契约）。
 */
export interface PluginStateStorage {
  get<T>(key: string): Promise<T | undefined>
  get<T>(key: string, defaultValue: T): Promise<T>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

// ── Lifecycle 消息类型（Worker ↔ 主线程）────────────────────────

/** @internal — runtime 内部：Worker↔主线程 lifecycle 消息（宿主方向） */
export type HostToWorkerMessage =
  | { type: 'load'; pluginId: string; pluginPath: string; trustLevel?: 'trusted' | 'sandbox' }
  | { type: 'activate'; pluginId: string; pluginDir: string; event: ActivationEvent }
  | { type: 'deactivate'; pluginId: string }
  | { type: 'rpc'; response?: RpcResponse; notification?: RpcNotification; request?: RpcRequest }

/** @internal — runtime 内部：Worker↔主线程 lifecycle 消息（Worker 方向） */
export type WorkerToHostMessage =
  | { type: 'loaded'; pluginId: string }
  | { type: 'activated'; pluginId: string }
  | { type: 'deactivated'; pluginId: string }
  | { type: 'error'; pluginId: string; error: string }
  | { type: 'fatal_error'; error: string; stack?: string }
  | { type: 'rpc' } & (RpcRequest | RpcNotification)

// ── 通用类型 ─────────────────────────────────────────────────────

// Disposable 在本文件定义（SDK 为 SSOT，runtime 经 taiji-plugin-sdk re-export 消费）。
// @taiji/shared 无同名定义；本文件是对外发布契约面（除 Bridge* 回包形状经
// @zhushanwen/extension-protocol 外无依赖），无需跨包提升。
/**
 * @stable — 可释放资源契约（Disposable 是插件生命周期的基础设施）。
 */
export interface Disposable {
  dispose(): void
}

/** @internal — runtime 内部：权限字符串别名 */
export type PluginPermission = string

/** @internal — runtime 内部：插件生命周期状态机 */
export type PluginState = 'UNLOADED' | 'LOADING' | 'ACTIVATING' | 'ACTIVE' | 'DEACTIVATING' | 'CRASHED' | 'DEPS_MISSING'

// ── Permission Constants ─────────────────────────────────────────

/**
 * 插件权限常量，用于 PermissionChecker 的权限校验。
 *
 * @stable — 权限字符串是 SDK 契约面：插件声明 permissions 依赖这些字面量，
 * runtime 权限校验（PermissionChecker）依赖其确定性。经 Object.freeze 冻结，
 * 运行时修改会抛错（strict 模式）。
 */
export const PermissionConstants = Object.freeze({
  /** 允许注册自定义工具 */
  TOOLS_REGISTER: 'tools.register',
  /** 允许注册 hooks */
  HOOKS_REGISTER: 'hooks.register',
  /** 允许向 session 发送消息 */
  SESSIONS_SEND_MESSAGE: 'sessions.sendMessage',
  /** 允许读取 session 状态 */
  SESSIONS_READ_STATE: 'sessions.readState',
  /** 允许读写插件存储 */
  STORAGE_ACCESS: 'storage.access',
  /** 允许发送通知 */
  NOTIFY: 'notify',
} as const)

// @internal — runtime 内部塑形对象（Bridge* 回包形状），定义源在协议包（见文件头 D4 单源化）
export type { BridgeInterceptResponse, BridgeToolExecuteResponse }

// ── Bridge 类型（插件 Worker ↔ 主进程桥接）─────────────────────────

/** @internal — runtime 内部：主进程调用插件注册的工具 */
export interface BridgeToolExecuteRequest {
  type: 'bridge.tool.execute'
  toolName: string
  parameters: Record<string, unknown>
  sessionId?: string
  toolCallId?: string
}

/** @internal — runtime 内部：Worker 侧 tool 执行处理函数 */
export type ToolExecuteHandler = (params: {
  arguments: Record<string, unknown>
  sessionId?: string
  toolCallId?: string
}) => Promise<BridgeToolExecuteResponse>

// ── Phase 2: Tool 类型 ──────────────────────────────────────────────

/**
 * @proposed — 工具注册请求（Phase 2 扩展面，API 表面仍在演进）。
 */
export interface ToolRegistration {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * 工具执行超时声明（毫秒，D1 声明通道）：
   * - >0 — 该工具单次执行的时间上界；
   * - <=0 或 Infinity — 显式 opt-out（不限时）；
   * - 非法值（非 number / NaN）— 注册入口 fail-fast（INVALID_TIMEOUT_MS）；
   * - 缺省 — 回落 DEFAULT_TOOL_EXECUTE_TIMEOUT_MS（bridge-interop 默认兜底）。
   */
  timeoutMs?: number
  /** Worker 侧本地执行 handler，在 createToolApi 注册时存储 */
  execute?: ToolExecuteHandler
}

/** @internal — runtime 内部：工具注册表条目（主线程侧） */
export interface ToolEntry {
  pluginId: string
  handlerId: string
  schema: ToolRegistration
}

// ── Phase 2: Hook 注册表条目 ──────────────────────────────────────────

/**
 * @proposed — status bar item 选项（Phase 2 扩展面）。
 */
export interface StatusBarItemOptions {
  tooltip?: string
  commandId?: string
  priority?: number
  scope?: 'per-session' | 'global'
  sessionId?: string
}

/**
 * @proposed — UI dialog 超时选项（ctx.ui.showConfirm/showSelect/showInput 末位 opts，
 * timeout-plugin-service D2）。
 *
 * `timeout` 语义 = 从调用到拿到结果的最长全程等待（毫秒），**含串行排队时间**——
 * 排队也是插件在等，从请求方视角计时。缺省/非法值回落默认 30min（等人工裁决值）；
 * 无 opt-out（「等人工」不允许无界等待——串行队列 head-of-line 阻塞）。
 *
 * 到期行为 = 取消非替答：弹窗在前端撤回（plugin:uiRequestExpired 广播），本调用
 * reject `Error`（`code: 'UI_TIMEOUT'`），插件可 catch 后自行决策（重发提问 / 放弃
 * 操作）；超时不是用户的否定回答。
 */
export interface UiDialogOptions {
  /** 全程等待上界（毫秒，含排队）。>0 合法；缺省/非法回落默认 30min。 */
  timeout?: number
}

/** @internal — runtime 内部：Hook 注册表条目（主线程侧） */
export interface HookEntry {
  pluginId: string
  handlerId: string
  priority: number
}

// Hook 域类型在本文件 Hook 类型段落定义（SSOT）；runtime 侧
// plugin-types/hook-types.ts 经 taiji-plugin-sdk re-export 消费（薄壳）。

// ── Phase 2 AgentAPI（在 Phase 1 基础上增加 tools 和 hooks）─────────

/**
 * @proposed — Phase 2 AgentAPI 扩展面（tools/hooks/config/sessionData/ui/agent/
 * workspace/commands/views），在 Phase 1 核心面上叠加，API 表面仍在演进。
 */
export interface Phase2AgentAPI extends Phase1AgentAPI {
  readonly tools: {
    register(registration: ToolRegistration): Promise<string>
    unregister(toolKey: string): Promise<void>
  }
  readonly hooks: {
    onBeforeSendMessage(handler: HookInterceptor): Promise<Disposable>
    onBeforeToolCall(handler: HookInterceptor): Promise<Disposable>
    onBeforeAgentStart(handler: HookInterceptor): Promise<Disposable>
    onAfterToolResult(handler: HookObserver): Promise<Disposable>
    onPiEvent(eventName: string, handler: PiEventCallback): Promise<Disposable>
  }
  readonly config: {
    get(key: string): Promise<unknown>
    getAll(): Promise<Record<string, unknown>>
    set(key: string, value: unknown): Promise<void>
  }
  readonly sessionData: {
    get(sessionId: string, key: string): Promise<unknown>
    set(sessionId: string, key: string, value: unknown): Promise<void>
    delete(sessionId: string, key: string): Promise<void>
    keys(sessionId: string): Promise<string[]>
  }
  readonly ui: {
    /**
     * 弹窗类三方法（dialog）带末位 `opts`（UiDialogOptions.timeout，全程含排队，
     * 缺省 30min）；到期取消非替答：reject `UI_TIMEOUT` + 前端撤窗，可重发。
     * notify/updateStatusBarItem 纯展示类无等待语义，不设 opts。
     */
    showSelect(title: string, options: string[], opts?: UiDialogOptions): Promise<string | undefined>
    showConfirm(title: string, message: string, opts?: UiDialogOptions): Promise<boolean>
    showInput(title: string, defaultValue?: string, opts?: UiDialogOptions): Promise<string | undefined>
    notify(level: 'info' | 'warn' | 'error', message: string): Promise<void>
    updateStatusBarItem(id: string, text: string, options?: StatusBarItemOptions): Promise<void>
    /**
     * [AP-2/u5b] 开层：sessionId 必填（E15）；有 pending 插件对话框时 reject
     * MODAL_BLOCKED_BY_UI_REQUEST（E10）。开层后应立即 views.update 推内容（首帧空白 =
     * 一次 RPC 往返）。
     */
    showModal(modalId: string, opts: { sessionId: string; title?: string; width?: 'sm' | 'md' | 'lg' }): Promise<{ opened: true; epoch: number }>
    /** [AP-2/u5b] 插件自身关闭：走与宿主 dismiss 相同的 closed 路径；已关层 no-op。 */
    hideModal(modalId: string): Promise<{ closed: boolean }>
    /** [AP-1/u5b] headerAction 可变字段更新：sessionId 必填（徽标是 per-session 语义）；badge ≤4 字符由宿主截断。 */
    updateHeaderAction(id: string, opts: { sessionId: string; badge?: string; tooltip?: string; disabled?: boolean }): Promise<void>
    /** [AP-2/u5b] modal 被关闭（宿主 dismiss / 切会话 / 宿主浮层 / replaced / plugin-gone）的定向通知订阅。 */
    onModalClosed(handler: (event: { modalId: string; reason: PluginModalClosedReason }) => void): Disposable
  }
  readonly agent: {
    /** U6 回执：resolve 生效模型复合串（pi pattern 换模时 ≠ 请求值；降级路径空串） */
    setModel(model: string): Promise<string>
    getModel(): Promise<string>
    getThinkingLevel(): Promise<string>
    /** U6 回执：resolve 钳制后生效档（降级路径空串） */
    setThinkingLevel(level: string): Promise<string>
    getActiveTools(): Promise<string[]>
  }
  readonly workspace: {
    readonly rootPath: string
    readonly name: string
    findFiles(pattern: string): Promise<string[]>
  }
  readonly commands: {
    register(
      command: { id: string; title?: string; category?: string; keybinding?: string; when?: string },
      handler: (args?: unknown) => unknown | Promise<unknown>,
    ): Promise<Disposable>
    unregister(commandId: string): Promise<void>
  }
  readonly views: {
    /** [D1/u5b] sessionId 显式必填（E15）：内容绑打开时所在会话，runtime 按它定向投递。 */
    update(viewId: string, guiTree: GuiComponent[], opts: { sessionId: string }): Promise<void>
    listMountPoints(): Promise<string[]>
  }
}

