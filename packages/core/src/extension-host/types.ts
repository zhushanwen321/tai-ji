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

/** plugin modal 关闭原因词表（AP-2 单点：宿主/插件/runtime 三类发起方共用此闭集）。 */
export type PluginModalClosedReason =
  | 'dismissed'
  | 'session-switched'
  | 'host-overlay'
  | 'replaced'
  | 'plugin-gone'

/** plugin modal 开合帧载荷（AP-2；kind='plugin:modalState'，S→C 全局广播 transient 帧）。
 *  payload = 调用参数原文（可缺省）——title/width 解析与 fallback 在 renderer（单一解析源）；
 *  sessionId 必带（AP-1/AP-2 必填契约，仅作 payload 归属信息，路由键 = 全局广播）。 */
export interface PluginModalStatePayload {
  pluginId: string
  modalId: string
  sessionId: string
  title?: string
  width?: 'sm' | 'md' | 'lg'
  state: 'open' | 'closed'
  /** 单调递增槽代数（同 (pluginId,modalId) 重复 open / replaced 均递增） */
  epoch: number
  /** state='closed' 时的关闭原因（PluginModalClosedReason 闭集） */
  reason?: PluginModalClosedReason
}

/** headerAction 运行时更新帧载荷（AP-1；kind='plugin:headerActionUpdate'，必带 sessionId）。
 *  渲染端按 (sessionId, headerActionId) 写入对应会话分区。 */
export interface HeaderActionUpdatePayload {
  pluginId: string
  headerActionId: string
  sessionId: string
  /** 徽标 ≤4 字符（宿主截断，全文进 tooltip） */
  badge?: string
  tooltip?: string
  disabled?: boolean
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
  | { kind: 'plugin:modalState'; modalState: PluginModalStatePayload } // S→C 开合帧（AP-2，u4a bridge 接线）
  | { kind: 'plugin:headerActionUpdate'; headerAction: HeaderActionUpdatePayload } // S→C 徽标更新帧（AP-1，u4a bridge 接线）
  | { kind: 'unregistered-mount-point'; pluginId: string; contributionId: string; expectedMountPoint: string }
  | { kind: 'error'; source: string; message: string }

// ── ContributionRecord（DM1）─────────────────────────────────────────

/** contribution 类型（DM1）。headerAction/modal 为 plugin-header-action-modal-points 新增点位（AP-1/AP-2）。 */
export type ContributionType =
  | 'view'
  | 'menu'
  | 'command'
  | 'statusBarItem'
  | 'slashCommand'
  | 'configuration'
  | 'headerAction'
  | 'modal'

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
  /** 声明原文存档：badge/tooltip/disabled 等可变字段经 plugin:headerActionUpdate 广播，声明侧只有静态形状 */
  headerAction?: { title: string; icon: string; commandId: string; order?: number }
  /** 声明原文存档（AP-2/D4：无 commandId 字段）——title/width 供 renderer fallback 读声明 */
  modal?: { title: string; width?: 'sm' | 'md' | 'lg' }
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

/** menu contribution（s1 DM2）。键集不含 'panel.header'——该键自 schema 起无渲染端消费方
 *  （声明死通道，D3 删除），顶栏点位由 headerActions 承接；composer.toolbar/sidebar.footer
 *  同为无消费键但与本点位无语义冲突，保留待规范清理另行裁决。 */
export interface PluginContributesMenu {
  'composer.toolbar'?: PluginMenuItem[]
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

/** headerAction contribution（AP-1，panel header 按钮区）。icon 为 lucide 名字符串（宿主解析，插件不给 SVG）；
 *  badge/tooltip/disabled 等可变字段不在声明侧，经 api.ui.updateHeaderAction + plugin:headerActionUpdate 广播。 */
export interface PluginContributesHeaderAction {
  id: string
  title: string
  icon: string
  commandId: string
  /** 与内置按钮组的相对序；缺省追加在后 */
  order?: number
}

/** modal contribution（AP-2/D4：声明只有 {id,title,width?}，无 commandId 字段——开层只有
 *  api.ui.showModal 一条路，声明侧供枚举/置灰/默认元数据）。 */
export interface PluginContributesModal {
  id: string
  title: string
  width?: 'sm' | 'md' | 'lg'
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
  headerActions?: PluginContributesHeaderAction[]
  modals?: PluginContributesModal[]
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
