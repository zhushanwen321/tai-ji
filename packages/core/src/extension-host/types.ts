/**
 * types.ts —— ExtensionHost 层共享类型（DM3 InternalEvent union + payload 类型 + DM1 ContributionRecord）。
 *
 * 本文件是 core/src/extension-host/ 全部模块的类型集中定义处（headless，runtime 零依赖；
 * 唯一例外 = plugin headerAction 帧协议类型自 @taiji/shared type-only import——
 * wire 协议 SSOT 单点在 shared/protocol.ts，此处不持副本）。
 * 形状对齐 wave plan：IF2（InternalEvent union）/ DM3（payload 类型）/ DM1（ContributionRecord）/
 * s1 schema v2（PluginContributes，对齐 packages/plugin-sdk/src/types.ts 的 PluginContributes v2）。
 */
import type { HeaderActionUpdatePayload } from '@taiji/shared'

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

/** 权限审批终局（remote-use-mobile S5-V3 撤窗）。requestId 与开窗 permissionRequest
 *  广播同源；payload 缺 requestId（旧版广播）时消费端回退按 pluginId 匹配，故此处置空串。 */
export interface PermissionRequestResolved {
  pluginId: string
  requestId: string
  /** true 批准 / false 拒绝（含挂起期清理唤醒）——审计/展示用，不参与撤窗匹配 */
  approved: boolean
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

/** plugin headerAction 帧协议类型（AP-1）re-export——SSOT = @taiji/shared
 *  protocol（shared 不依赖 core，core→shared 为既有合法依赖边）。re-export 维持
 *  `@taiji/core` / `@taiji/core/extension-host` 出口面（index.ts `export * from './types'`）
 *  与既有消费方（message-bus-bridge）引用面不变。 */
export type { HeaderActionUpdatePayload }

/** core 内部事件 union（IF2）。消费端 on(kind, handler) 编译期类型安全。 */
export type InternalEvent =
  | { kind: 'plugin-status-bar-update'; sessionId?: string; items: StatusBarEntry[] }
  | { kind: 'plugin-status-set-update'; sessionId?: string; status: StatusSetEntry[] }
  | { kind: 'extension-status'; sessionId?: string; status: ExtensionStatusEntry }
  | { kind: 'plugin-permission-request'; sessionId?: string; request: PermissionRequest }
  | { kind: 'plugin-permission-request-resolved'; sessionId?: string; resolved: PermissionRequestResolved }
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
  | { kind: 'plugin:headerActionUpdate'; headerAction: HeaderActionUpdatePayload } // S→C 徽标更新帧（AP-1，u4a bridge 接线）
  | { kind: 'unregistered-mount-point'; pluginId: string; contributionId: string; expectedMountPoint: string }
  | { kind: 'error'; source: string; message: string }

// ── ContributionRecord（DM1）─────────────────────────────────────────

/**
 * contribution 类型（DM1）。headerAction 为 plugin-header-action-modal-points 新增点位（AP-1）。
 */
export type ContributionType =
  | 'view'
  | 'menu'
  | 'command'
  | 'statusBarItem'
  | 'slashCommand'
  | 'configuration'
  | 'headerAction'

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
  /** 声明原文存档：badge/tooltip/disabled 等可变字段经 plugin:headerActionUpdate 广播，声明侧只有静态形状；
   *  activation = 点击激活方式（声明驱动分派键，见 PluginContributesHeaderAction.activation）。 */
  headerAction?: { title: string; icon: string; commandId?: string; order?: number; activation?: 'scheduler-overlay' }
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

/** headerAction contribution（AP-1，composer 左簇按钮区）。icon 为 lucide 名字符串（宿主解析，插件不给 SVG）；
 *  badge/tooltip/disabled/hidden 等可变字段不在声明侧，经 api.ui.updateHeaderAction + plugin:headerActionUpdate 广播。 */
export interface PluginContributesHeaderAction {
  id: string
  title: string
  icon: string
  /**
   * 命令链命令 id（可选）。缺省（无 activation 且无 commandId）声明无法走命令链，
   * 渲染端不渲染；带 commandId 的缺省声明点击经 CommandRegistry.execute。
   * activation='scheduler-overlay' 声明无需 commandId——点击走 overlay 分派
   * （renderer 侧 openSchedulerTab），不经命令链。
   */
  commandId?: string
  /** 与内置按钮组的相对序；缺省追加在后 */
  order?: number
  /**
   * 点击激活方式（声明驱动分派，渲染端消费；core 不读此字段）。
   * 缺省 = 走 commandId 命令链（E13 可用性三态 + E3 点击 execute，需 commandId）；
   * 'scheduler-overlay' = 点击打开 workflow-viz overlay 的定时任务 tab（renderer 侧
   * openSchedulerTab，不经命令链）。
   * 与 PluginContributesView.activationEvent（view 激活时机事件）语义无关。
   */
  activation?: 'scheduler-overlay'
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
