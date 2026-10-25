// ── Plugin 领域 DTO（runtime ↔ renderer 之间流转的插件相关 payload）──
// 迁移自 protocol.ts 第 3 块。protocol.ts 仅保留 type→payload 映射（SSOT），
// 领域形状归此处便于读者一查到底。

// ── contributes 契约（wire 侧形状，容器扩展点统一 §6.2）──────────────
//
// PluginInfo 是 config.plugins 广播的插件列表载荷，contributes 透传插件的界面贡献声明，
// renderer 据此注册容器位——此前该字段在 plugin-info-mapper 映射层被挑掉，插件声明到不了
// 渲染层（设计 §3.4 环节 3 断链）。本文件独立持有一份形状副本：shared 处于依赖拓扑最底层
//（plugin-sdk → shared、core → shared），不能反向 import 契约权威版。三版职责不同但字段集
// 必须一致——plugin-sdk 版（插件作者契约权威）、core 版（解析层）、本版（wire 载荷），
// 改任一侧须同批改其余两版（契约原子批义务，漂移会在 U4 mapper 透传赋值处暴露）。

/** 插件视图声明（wire 侧形状，与 plugin-sdk / core 两版 PluginContributesView 对齐）。 */
export interface PluginContributesView {
  id: string
  title: string
  view?: string
  /** 挂载点名：'sidebar.tab' | 'drawer.tab' | 'overlay.content' 等，开放字符串（壳注册制） */
  placement: string
  viewType?: 'gui' | 'webview' | 'tree'
  activationEvent?: string
  /** 图标名（lucide 名，宿主统一解析）；缺省 = 容器兜底图标 */
  icon?: string
  /** 排序权重（§6.16 序号契约：未声明排在内置项之后，同值按 pluginId 字典序决胜） */
  order?: number
  /** 空态文案（快照拉取完成仍无树时展示，插件自带；缺省 = 容器通用空态） */
  emptyState?: { text?: string; hint?: string }
  /** 会话归属（级联判据与进入范围）；缺省 'session' */
  scope?: 'session' | 'global'
}

/**
 * headerAction 点击激活方式（wire 侧形状，与 plugin-sdk / core 两版 HeaderActionActivation 对齐）。
 * 结构化联合 = 声明驱动的静态入口（命令链 / 浮层 / 抽屉导航）；'scheduler-overlay' 为迁移期
 * 兼容值（定时任务直开入口），下一版本删除。
 */
export type HeaderActionActivation =
  | { kind: 'command' }
  | { kind: 'overlay'; tabId: string; params?: Record<string, string | number | boolean> }
  | { kind: 'drawer'; tabId: string; params?: Record<string, string | number | boolean> }
  | 'scheduler-overlay'

/** 插件 headerAction 声明（wire 侧形状；badge/tooltip 等可变字段经运行时广播，不在声明侧）。 */
export interface PluginContributesHeaderAction {
  id: string
  title: string
  icon: string
  /** 命令链命令 id（可选）；带 commandId 的缺省声明点击经命令链执行 */
  commandId?: string
  /** 与内置按钮组的相对序；缺省追加在后 */
  order?: number
  /** 点击激活方式（声明驱动分派，渲染端消费）；缺省 = 走 commandId 命令链 */
  activation?: HeaderActionActivation
}

/** 插件菜单声明（wire 侧形状，按挂载点名分组）。 */
export interface PluginContributesMenu {
  'composer.toolbar'?: Array<{ command: string; when?: string; group?: string }>
  'sidebar.footer'?: Array<{ command: string; when?: string; group?: string }>
}

/** 插件命令声明（wire 侧形状）。 */
export interface PluginContributesCommand {
  command: string
  title: string
  category?: string
  keybinding?: string
  when?: string
  icon?: string
}

/** 插件配置声明（wire 侧形状，驱动设置页表单）。 */
export interface PluginContributesConfiguration {
  title?: string
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'array' | 'object'
      default?: unknown
      description?: string
      enum?: unknown[]
      enumDescriptions?: string[]
    }
  >
}

/** 插件贡献点声明（wire 侧形状，与 plugin-sdk / core 两版 PluginContributes 对齐）。 */
export interface PluginContributes {
  slashCommands?: Array<{ name: string; description: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  hooks?: string[]
  views?: PluginContributesView[]
  menus?: PluginContributesMenu
  commands?: PluginContributesCommand[]
  configuration?: PluginContributesConfiguration
  headerActions?: PluginContributesHeaderAction[]
}

export interface PluginInfo {
  pluginId: string
  version: string
  displayName: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  enabled: boolean
  /**
   * 界面贡献声明透传（容器扩展点统一 §6.2）：声明通路断链修复的主体字段——
   * 插件清单的 views/headerActions 等经本字段到达 renderer（此前恒缺失）。
   */
  contributes?: PluginContributes
}
