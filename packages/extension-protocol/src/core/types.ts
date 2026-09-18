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

// ── plan 审阅协议（submit-review select 通道；marker 常量见 core/markers.ts）──
//
// 与 ask-user 家族同构的「marker select + JSON payload」跨层契约：
// extension 序列化 payload 进 select options，runtime event-adapter 按 marker 分流，
// 前端审批条渲染并经 respond 回传 PlanReviewResponse。
// shared 侧 PlanStateView.docs 与 PlanDocMeta 同形（shared 是最底层包不能反向依赖
// 本包，同形状漂移由双端注释互指 + 投影链契约测试守卫）。

/**
 * 计划产物文档元数据——agent 调 register-doc 登记的一份产物。
 * version 由 extension 侧维护：修订后重写文档须重调 register-doc（version+1），
 * 前端凭 version 变化重拉 file.read 刷新渲染。
 */
export interface PlanDocMeta {
  /** 文件名（drawer L2 文档 tab 标题，不含目录） */
  fileName: string
  /** 文件绝对路径（前端 file.read RPC 带 sessionId 读取） */
  absPath: string
  /** 来源技能名（挂载 --skills 时产出该文档的技能；模板流程产出时为空串） */
  sourceSkill: string
  /** 修订版本，从 1 起，每次修订重登记 +1 */
  version: number
}

/**
 * submit-review 挂起审批时的 select payload（序列化为 options[0] JSON）。
 * extension 侧解析失败走 E5（logger.warn + tool result 报错提示重挂，垃圾数据不进对话流）。
 */
export interface PlanReviewRequest {
  docs: PlanDocMeta[]
}

/** 审批三键裁决。revise/explain 携带评论、approve 不携带（结构上不可混带）。 */
export type PlanReviewDecision = 'approve' | 'revise' | 'explain'

/** 用户对某文档划选段落的一条评论：quote 是划选引文（agent 定位段落用），comment 是评语。 */
export interface PlanReviewComment {
  quote: string
  comment: string
}

/**
 * 审批条 respond 回传（判别联合：approve 无评论字段，revise/explain 必带评论数组）。
 * extension 消费：approve → 走现状 complete 执行方式 select；revise → 评论清单以
 * 显式 deliverAs:'steer' 注入 + reviewState=revising；explain → 同款注入但不改 reviewState，
 * 重挂审批靠提示词纪律驱动 agent 重调 submit-review。
 */
export type PlanReviewResponse =
  | { decision: 'approve' }
  | { decision: 'revise'; comments: PlanReviewComment[] }
  | { decision: 'explain'; comments: PlanReviewComment[] }
