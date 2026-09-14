/**
 * 插件系统契约类型 —— single source of truth（D28 方向反转，2026-09-05）。
 *
 * 本文件是 xyz-agent 插件契约的权威定义：面向插件作者对外发布，刻意保持
 * 零依赖自包含（第三方插件作者无需装整个 monorepo）——Bridge* 回包形状定义源
 * 2026-09 D4 后上收协议包，本文件不再零依赖（见下方历史段）。
 *
 * 消费方（runtime 侧薄壳，保持其既有导入面不变）：
 *   packages/runtime/src/services/plugin-service/plugin-types.ts          （主域 + Bridge/AgentAPI/Tool 等）
 *   packages/runtime/src/services/plugin-service/plugin-types/hook-types.ts（Hook 域）
 *   descriptor / rpc 子域仍由 runtime 本地文件定义，与本文件同构（过渡形态）。
 *
 * 修改契约：直接编辑本文件（对外类型名/结构零变化承诺——published API 兼容）。
 *
 * 历史：2026-09-05 前本文件由 packages/plugin-sdk/scripts/sync-types.sh 从
 * runtime 的 plugin-types 自动生成（runtime 为真相源的镜像方向）；D28 审计
 * 记录了当时的刻意重复理由。方向反转为「SDK 为 SSOT、runtime re-export」后
 * sync-types.sh 已删除（生成方向不再存在），依赖方向 = runtime → SDK 单向。
 * D4 单源化（ext-simplify-16）后 Bridge* 回包形状定义源上收
 * @xyz-agent/extension-protocol（唯一定义点，下方 re-export 消费），本文件
 * 不再零依赖，但除该类型依赖外仍无运行时依赖。
 */

// D4 单源化：Bridge* 回包形状唯一定义源 = @xyz-agent/extension-protocol。
// import 供本文件内 ToolExecuteHandler 返回类型引用；export 保持既有
// `BridgeInterceptResponse`/`BridgeToolExecuteResponse` 导入面不变。
import type { BridgeInterceptResponse, BridgeToolExecuteResponse } from '@xyz-agent/extension-protocol'

/**
 * GUI 渲染协议核心类型定义。
 *
 * GuiComponent 是 pi Component { render(width): string[] } 的可序列化镜像。
 * extension 按 ctx.mode 分支：TUI 走原生 Component，RPC 走 GuiComponent（放进 details.__gui__）。
 *
 * GuiComponentProps 是类型路由的聚合点：通用布局原语 + extension 专属组件
 * 全部在此声明键值，子类型直接内联本文件（纯类型，无运行时逻辑）。
 *
 * @see docs/architecture/extension-gui-protocol.md
 */

// ── 协议版本 ──

export const PROTOCOL_VERSION = 1 as const

// ── 核心：GuiComponent ──

/**
 * GUI 渲染组件——pi Component 的可序列化镜像。
 *
 * pi:  Component { render(width): string[] }   ← ANSI 文本行
 * gui: GuiComponent = { type, props }           ← 结构化数据
 */
export interface GuiComponent<T extends GuiComponentType = GuiComponentType> {
  /** 组件类型，前端按此路由到 Vue 组件 */
  type: T
  /** 组件 props，类型由 type 决定 */
  props: GuiComponentProps[T]
}

export type GuiComponentType = keyof GuiComponentProps

// ── 组件 props 映射（聚合点：通用原语 + extension 专属）──

export interface GuiComponentProps {
  /** ANSI 文本兜底——保留原始 ANSI 序列，前端用 ansi_up 渲染 */
  'ansi-text': {
    lines: string[]
  }

  // ── 布局原语（替代 TUI ASCII 布局）──

  /** 卡片容器——替代 TUI 的 ┌─┐││└─┘ box 边框 */
  'card': {
    variant?: 'default' | 'elevated' | 'danger' | 'success'
    header?: GuiComponent | string
    body: GuiComponent[]
  }

  /** 统计行——替代 TUI 的 "N turns · Nk · Ns" */
  'stats-line': {
    items: StatItem[]
  }

  /** 进度条——替代 TUI 的 ████░░░░ */
  'progress-bar': {
    label?: string
    current: number
    total: number
    unit?: string
    severity?: 'ok' | 'warn' | 'danger'
  }

  /** 列表树——替代 TUI 的 ⎿ ├─ └─ 缩进 */
  'list-tree': {
    items: TreeItem[]
    /** 行首显示弱化序号（1/2/3…，mono tabular-nums）。扁平有序清单用（todo）；
     *  自带编号的文本（goal criteria "1. xxx"）不要开，避免双重编号 */
    numbered?: boolean
  }

  /** 垂直组合容器——无视觉样式的透明分组。宿主壳层（WidgetArea）承担卡壳/head/折叠
   *  后，widget 内容需要多组件组合时的组合根（替代「无头 card」的语义滥用） */
  'group': {
    children: GuiComponent[]
  }

  /** 双列网格——替代 TUI 的 │ 列分隔 */
  'columns': {
    children: GuiComponent[]
    ratios?: number[]
  }

  /** 标签栏——替代 TUI 的 tab │ 分隔 */
  'tab-bar': {
    tabs: { label: string; active?: boolean; status?: 'done' | 'pending' }[]
  }

  /** 自定义组件——逃生口（仅限内置 extension 编译期注册） */
  'custom': {
    component: string
    props: Record<string, unknown>
  }
}

// ── tool result / message details 中 __gui__ 字段的完整类型 ──

export interface GuiRenderResult {
  /** 版本协商，前端检测，不认识降级 ansi-text */
  v: typeof PROTOCOL_VERSION
  component: GuiComponent
  /**
   * widget 宿主元数据（M17 对话流 widget 面板消费）：标题/状态点/进度计数由
   * 宿主壳层统一渲染成单一 head（含折叠交互），extension 不再用 card 原语
   * 的 header 表达这些（壳层 head 与 payload card header 双头重复的根因修复）。
   * 可选：不发时宿主 fallback 到 viewId 标题、无状态点/进度。
   */
  meta?: WidgetMeta
}

/** widget 宿主元数据——head 渲染契约（title + 状态点 + 进度 + 折叠 chevron）。 */
export interface WidgetMeta {
  /** head 标题（todo → "Todo"；goal → slug） */
  title: string
  /** head 状态点语义：running=accent / done=success / failed=danger / idle=neutral 弱点 */
  status?: 'running' | 'done' | 'failed' | 'idle'
  /** head 进度（mini bar + 计数文本）；progress-bar 原语从 body 移入 head 的承载 */
  progress?: {
    /** fill 比例 = current/total */
    current: number
    total: number
    /** 计数显示文本（head 空间有限，extension 全权格式化：todo "2/5"、goal "42%"）。
     *  缺省 `${current}/${total}` */
    label?: string
    /** fill 语义色（预算阈值映射）；缺省按 meta.status（done→success，否则 accent） */
    severity?: 'ok' | 'warn' | 'danger'
  }
}

// ── 布局原语子类型 ──

export interface StatItem {
  label?: string
  value: string
  severity?: 'ok' | 'warn' | 'danger'
  icon?: string
}

export interface TreeItem {
  icon?: TreeItemIcon
  label: string
  status?: 'running' | 'done' | 'failed'
  depth?: number
  children?: TreeItem[]
}
export type TreeItemIcon = 'arrow' | 'check' | 'cross' | 'circle' | 'dot' | 'pause' | 'branch'

/**
 * 插件描述域类型（manifest/descriptor 契约面）
 *
 * 分层标注（IF2）：
 * - @stable — manifest/descriptor 解析契约（XyzAgentManifest/PluginDescriptor/PluginContributes）
 * - @internal — runtime 内部扫描态字段（PluginState 引用、compatibilityError）
 */

/** @stable — 插件来源：随应用分发的内置插件 或 用户安装的外部插件 */
export type PluginSource = 'built-in' | 'external'

/**
 * @stable — 插件 manifest（解析自 package.json 的 xyzAgent 字段）。
 */
export interface XyzAgentManifest {
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
export interface XyzAgentPackageJson {
  name: string
  version: string
  description?: string
  displayName?: string
  xyzAgent: XyzAgentManifest
  engines?: { 'xyz-agent'?: string }
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
  engines: { 'xyz-agent': string }
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
 * （VSCode contribution points 风格）。
 */
export interface PluginContributesMenu {
  'composer.toolbar'?: PluginMenuItem[]
  'panel.header'?: PluginMenuItem[]
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

// ── RPC 线协议类型（Wire Protocol）────────────────────────────────────
//
// 本文件仅包含 RPC 层的线协议类型与错误码，无跨域依赖——是 plugin-types
// 拆分中最独立的一个域。

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
 * - @internal — runtime 内部执行细节（HookResult/HookBlockedResult 等主线程塑形）
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

/** @internal — runtime 内部：Hook 被阻止时的详细结果 */
export interface HookBlockedResult extends HookResult {
  blocked: true
  reason: string
}

// 本文件内部仍引用以下「已拆分」域的类型（lifecycle/bridge/agent-api 等
// 内联类型用到了它们），故在此 import 以供本地使用；对外仍通过文件末尾的
// `export ... from` 重导出，保证 `from './plugin-types.js'` 不破坏。
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
 * - @internal — runtime 内部塑形对象（WorkerHandle、PluginContext、Bridge* 等，
 *   其中 BridgeSyncPayload/IPluginServiceDeps 已在 sync 时从 SDK 剥离）
 */

// ── Descriptor / Manifest 域 ───────────────────────────────────────
// 已拆分到 ./plugin-types/descriptor-types.ts。此处 re-export 保持
// 现有 `from './plugin-types.js'` 导入不破坏（NON-BREAKING）。
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
    sendMessage(params: { sessionId?: string; role: 'user' | 'system'; content: string }): Promise<void>
    onDidCreateSession(handler: (session: SessionInfo) => void): Disposable
    onDidDestroySession(handler: (session: SessionInfo) => void): Disposable
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

// ── Storage 类型 ─────────────────────────────────────────────────

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

// ── RPC 线协议域 ──────────────────────────────────────────────────
// 已拆分到 ./plugin-types/rpc-protocol.ts。此处 re-export 保持
// 现有 `from './plugin-types.js'` 导入不破坏（NON-BREAKING）。
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

// D28: Disposable 与 plugin-sdk/src/types.ts 的定义重复。理论上应提升到
// @xyz-agent/shared 作 single source of truth，但 SDK 通过 sync-types.sh 从本文件
// 自动生成、且刻意保持零依赖（第三方插件作者无需装整个 monorepo）。若改 re-export
// 会让 sync 后的 SDK 引入 @xyz-agent/shared 依赖，破坏独立性。故保留独立定义——
// 这是有意的跨包契约重复，sync 脚本是它的「真相源」。
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

// ── RPC Error Codes 域 ────────────────────────────────────────────
// 已拆分到 ./plugin-types/rpc-protocol.ts。const 必须用 export-from 重导出。
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

/** @stable — 权限常量索引类型（随 PermissionConstants 冻结） */
export type PermissionConstant = (typeof PermissionConstants)[keyof typeof PermissionConstants]

// @internal — runtime 内部塑形对象（Bridge* 回包形状），定义源在协议包（见文件头 D4 单源化）
export type { BridgeInterceptResponse, BridgeToolExecuteResponse }

// ── Bridge 类型（插件 Worker ↔ 主进程桥接）─────────────────────────

/** @internal — runtime 内部：Bridge 连接状态 */
export interface BridgeState {
  pluginId: string
  connected: boolean
  lastSyncAt: number
}

/** @internal — runtime 内部：插件向主进程同步工具和 hooks 的请求 */
export interface BridgeSyncRequest {
  type: 'bridge.sync'
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks: HookType[]
}

/** @internal — runtime 内部：主进程响应 Bridge 同步的结果 */
export interface BridgeSyncResponse {
  success: boolean
  registeredTools: string[]
  registeredHooks: HookType[]
}

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

// HookInterceptor / HookObserver / PiEventCallback 已拆分到
// ./plugin-types/hook-types.ts，下方 re-export 块统一导出。

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
    update(viewId: string, guiTree: GuiComponent[]): Promise<void>
    listMountPoints(): Promise<string[]>
  }
}

/** @internal — runtime 内部：插件向后端请求前端 UI 弹窗 */
export interface PluginUIRequest {
  sessionId: string
  requestId: string
  method: 'confirm' | 'select' | 'input'
  title: string
  message?: string
  options?: string[]
}
