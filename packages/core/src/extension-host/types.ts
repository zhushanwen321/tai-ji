/**
 * types.ts —— ExtensionHost 层共享类型（DM3 InternalEvent union + payload 类型 + DM1 ContributionRecord）。
 *
 * 本文件是 core/src/extension-host/ 全部模块的类型集中定义处（headless，零 import 依赖）。
 * 形状对齐 wave plan：IF2（InternalEvent union）/ DM3（payload 类型）/ DM1（ContributionRecord）/
 * s1 schema v2（PluginContributes，对齐 packages/plugin-sdk/src/types.ts 的 PluginContributes v2）。
 */

// ── InternalEvent union（IF2）────────────────────────────────────────

/** 状态栏条目（IF2/DM3）。 */
export interface StatusBarEntry {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  alignment: 'left' | 'right'
  priority: number
  commandId?: string
  /** 作用域（W2 扩展，对齐 runtime StatusBarItem.scope + IF8 分流契约）。可选——旧消费方不带。 */
  scope?: 'per-session' | 'global'
  /** 所属 session（W2 扩展，对齐 runtime StatusBarItem.sessionId）。可选——global scope 项不带。 */
  sessionId?: string
}

/** statusSet 条目（IF2/DM3）。 */
export interface StatusSetEntry {
  id: string
  pluginId: string
  text: string
}

/** extension 状态条目（IF2/DM3）。 */
export interface ExtensionStatusEntry {
  pluginId: string
  status: string
  detail?: string
}

/** 权限请求（IF2/DM3）。runtime 一次可申请多个权限（插件 manifest.permissions 通常多个），
 *  数组完整透传，不收敛为单数。 */
export interface PermissionRequest {
  pluginId: string
  permissions: string[]
  requestId: string
}

/** 对话框请求（IF2/DM3，s4 消费渲染 companion-band）。 */
export interface DialogRequest {
  requestId: string
  pluginId: string
  kind: 'select' | 'confirm' | 'input'
  title?: string
  [payload: string]: unknown
}

/** widget 载荷（IF2/DM3）。guiTree 目前为 unknown[]，W4 ViewHostStore 消费时替换为
 *  @zhushanwen/extension-protocol 的 GuiComponent 类型（wave plan DM3 标注）。
 *  meta 为 widget 宿主元数据（v1.1 widgetGui wire 携带，wire 真值 unknown，
 *  ViewHostStore 消费时窄化为 WidgetMeta）。 */
export interface WidgetPayload {
  viewId: string
  pluginId: string
  guiTree: unknown[]
  meta?: unknown
}

/** 消息装饰（IF2/DM3）。 */
export interface MessageDecoration {
  messageId: string
  decoration: unknown
}

/** 插件状态枚举（IF2/DM3）。 */
export type PluginStatus = 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'

/** 通知载荷（IF2/DM3 未定形，W2 bridge 按 runtime 实际形状收窄）。 */
export interface NotificationPayload {
  pluginId: string
  message: string
  [key: string]: unknown
}

/** core 内部事件 union（IF2）。消费端 on(kind, handler) 编译期类型安全。 */
export type InternalEvent =
  | { kind: 'plugin-status-bar-update'; sessionId?: string; items: StatusBarEntry[] }
  | { kind: 'plugin-status-set-update'; sessionId?: string; status: StatusSetEntry[] }
  | { kind: 'extension-status'; sessionId?: string; status: ExtensionStatusEntry }
  | { kind: 'plugin-permission-request'; sessionId?: string; request: PermissionRequest }
  | { kind: 'plugin-crashed'; pluginId: string; error: string }
  | { kind: 'plugin-notification'; sessionId?: string; notification: NotificationPayload }
  | { kind: 'plugin-config-changed'; pluginId: string; config: unknown }
  | { kind: 'plugin-message-decoration'; sessionId?: string; decoration: MessageDecoration }
  | { kind: 'plugin-status-change'; pluginId: string; status: PluginStatus }
  | { kind: 'ui-request'; sessionId?: string; request: DialogRequest } // uiRequest + extension.ui_request 归一
  | { kind: 'extension-widget'; sessionId?: string; widget: WidgetPayload } // widget + widgetGui 归一
  | { kind: 'extension-notify'; sessionId?: string; notification: NotificationPayload }
  | { kind: 'requests-invalidated'; sessionId?: string; requestIds: string[]; reason: string } // 挂起 UI 请求失效广播（P2-2）
  | { kind: 'session-destroyed'; sessionId: string }
  | { kind: 'unregistered-mount-point'; pluginId: string; contributionId: string; expectedMountPoint: string }
  | { kind: 'error'; source: string; message: string }

// ── ContributionRecord（DM1）─────────────────────────────────────────

/** contribution 类型（DM1）。 */
export type ContributionType =
  | 'view'
  | 'menu'
  | 'command'
  | 'statusBarItem'
  | 'slashCommand'
  | 'configuration'

/**
 * 解析后 contribution 统一结构（DM1）。
 * placement 是路由键（'sidebar.tab'/'composer.toolbar'/'panel.header'/'statusbar'/'drawer.tab'/...，
 * 开放字符串，壳注册制 IF5）。available 是 routeAll 后的缓存（AC9 置灰依据）。
 */
export interface ContributionRecord {
  pluginId: string
  /** plugin 内唯一 */
  contributionId: string
  type: ContributionType
  placement: string
  /** 路由后置：挂载点已注册=true，未注册=false（AC9 置灰依据） */
  available: boolean
  // type 特定 payload（按 s1 schema v2）
  view?: { viewType: string; title: string; initialVisibility: 'visible' | 'hidden' }
  menu?: { group?: string; when?: string }
  command?: { title: string; category?: string; keybinding?: string; when?: string }
  statusBarItem?: { text: string; alignment: 'left' | 'right'; priority: number; scope: 'global' | 'per-session'; commandId?: string }
  slashCommand?: { name: string; description: string }
  configuration?: { properties: unknown }
}

// ── ViewContributionSummary（IF1，视图宿主消费的扁平视图摘要）───────────

/**
 * getViewsByPlacement 的返回形状（IF1）。
 * viewId=contributionId，title 缺省回退 contributionId，icon 显式 undefined（当前无图标源），
 * initialVisibility 取记录值（legacy panels 固定 'hidden'）。
 */
export interface ViewContributionSummary {
  viewId: string
  title: string
  icon?: string
  initialVisibility: 'visible' | 'hidden'
}

// ── core 版 PluginContributes v2（对齐 s1 schema v2）──────────────────

/** view contribution（s1 DM1）。 */
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

/** menu contribution（s1 DM2）。 */
export interface PluginContributesMenu {
  'composer.toolbar'?: PluginMenuItem[]
  'panel.header'?: PluginMenuItem[]
  'sidebar.footer'?: PluginMenuItem[]
}
export interface PluginMenuItem {
  command: string
  when?: string
  group?: string
}

/** command contribution（s1 DM3）。 */
export interface PluginContributesCommand {
  command: string
  title: string
  category?: string
  keybinding?: string
  when?: string
  icon?: string
}

/** configuration contribution（s1 DM4）。 */
export interface PluginContributesConfiguration {
  title?: string
  properties: Record<string, PluginConfigurationProperty>
}
export interface PluginConfigurationProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  default?: unknown
  description?: string
  enum?: unknown[]
  enumDescriptions?: string[]
}

/** statusBarItem contribution（s1 DM5）。 */
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
 * 插件 contributes 声明 v2（对齐 s1 schema v2 的 PluginContributes，见
 * packages/plugin-sdk/src/types.ts 同形状定义）。core 独立定义（D6 接口即契约，
 * 不 import plugin-sdk 包）。
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
 * legacy panels 字段（s1 已删）。若遇 legacy manifest 则映射为 view（deprecated alias，IF4 向后兼容契约）。
 * 形状为宽松占位（旧 panels 已无消费方，只保证可解析）。
 */
export interface LegacyPanelsEntry {
  id: string
  title?: string
  placement?: string
  [key: string]: unknown
}

/** external plugin descriptor（loadExternal 注入接口的输入，TC3）。 */
export interface PluginDescriptorLike {
  pluginId: string
  contributes?: PluginContributes
  /** legacy 兼容：旧 panels 字段映射为 view */
  panels?: LegacyPanelsEntry[]
}

/** builtin contribution 声明（builtin-contributions.ts 条目形状）。 */
export interface BuiltinContribution {
  pluginId: string
  contributes: PluginContributes
}
