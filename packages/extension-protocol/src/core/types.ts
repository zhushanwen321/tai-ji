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
