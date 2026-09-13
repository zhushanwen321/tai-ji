/**
 * Extension GUI 渲染协议 helper 函数（通用层）。
 *
 * 设计原则：
 * - 零运行时依赖（不依赖 pi SDK）
 * - helpers 接受最小化的 ctx 结构（结构化类型），pi 的 ExtensionContext 天然满足
 * - extension 开发者只需调这些 helper，不需要了解底层编码细节
 */

import {
  type GuiComponent,
  type GuiComponentType,
  type GuiComponentProps,
  type GuiRenderResult,
  type WidgetMeta,
  PROTOCOL_VERSION,
} from './types'
import { GUI_WIDGET_MARKER } from './markers'
import type { GuiContext } from './gui-context'

// ── helper 函数 ──

/**
 * 检测当前环境是否支持 GUI 渲染（RPC 模式 = GUI 渲染通道有效）。
 * TUI/json/print 模式走 pi 原生渲染，不需要 GuiComponent。
 */
export function isGuiCapable(ctx: GuiContext): boolean {
  return ctx.mode === 'rpc'
}

/**
 * 构造 GuiRenderResult。当前主用途是 guiSetWidget 的载荷（M17 对话流 widget 面板）；
 * details.__gui__（tool result 通道）为遗留兼容路径，todo/goal 已不再使用。
 * stripUndefined 确保序列化不含 undefined（JSON.stringify 会丢弃 undefined 字段）。
 */
export function guiResult(component: GuiComponent, meta?: WidgetMeta): GuiRenderResult {
  const result: GuiRenderResult = {
    v: PROTOCOL_VERSION,
    component: stripUndefined(component) as GuiComponent,
  }
  if (meta !== undefined) result.meta = stripUndefined(meta) as WidgetMeta
  return result
}

/**
 * 构造 GuiComponent，带类型推断。
 * 类型参数 T 约束 props 到对应类型的 props 形状。
 */
export function guiComponent<T extends GuiComponentType>(
  type: T,
  props: GuiComponentProps[T]
): GuiComponent<T> {
  return { type, props }
}

/**
 * 设置 GUI widget。RPC 模式下用 marker 编码 GuiRenderResult JSON 进 string[]，
 * runtime event-adapter 检测 marker 解码为结构化 WS 帧（component + meta）。
 * 本函数无 isGui 守卫（仅查 ctx.ui?.setWidget 存在性），调用方需先判定
 * isGuiCapable(ctx)——TUI 模式误调会把 marker 编码行推给原生 widget 造成乱码。
 *
 * meta（标题/状态/进度）由宿主壳层渲染成统一 head；extension 不再用 card 原语
 * header 表达这些。传 undefined 清除 widget。
 */
export function guiSetWidget(
  ctx: GuiContext,
  key: string,
  result: GuiRenderResult | undefined
): void {
  if (!ctx.ui?.setWidget) return

  if (result) {
    const encoded = [GUI_WIDGET_MARKER + JSON.stringify(stripUndefined(result))]
    ctx.ui.setWidget(key, encoded)
  } else {
    ctx.ui.setWidget(key, undefined)
  }
}

/**
 * [守卫单点化——本约束的说明全仓只写这一处，调用方不得再各自复写]
 * 「isGuiCapable 外层判定不可省略，否则 TUI 误调 marker 乱码」：guiSetWidget 无
 * isGui 守卫（仅查 ctx.ui?.setWidget 存在性），TUI 模式误调会把 marker 编码行推
 * 给原生 widget 造成乱码。带双模内容的 widget 推送一律走 setWidgetDual，由本
 * helper 内化模式分派——消费方（todo/goal 及后续带 widget 的 extension）不再
 * 自持 isGui 判定与守卫注释。
 */

/** 双模 widget 内容：按值立即构造两侧（构造均为廉价纯函数，成本可忽略）。 */
export interface DualWidgetContent {
  /** RPC 模式经 marker 通道推送的 GUI 渲染结果（guiResult 产物）。 */
  gui: GuiRenderResult
  /** TUI/json/print 模式推送给 pi 原生渲染的文本行。 */
  text: string[]
}

/**
 * 双模 widget 推送（清屏/推送 × GUI/TUI 四分支的协议侧收敛，模式分派单点）：
 *  - content 为 undefined → 清屏 ctx.ui.setWidget(key, undefined)，模式无关
 *    （guiSetWidget 的清屏分支本就两臂同落 setWidget，判别是死分支）
 *  - 有内容 → isGuiCapable(ctx) ? guiSetWidget(gui) : setWidget(text)——TUI 分支
 *    推原生文本行，结构性不触达 marker（见上方守卫单点化说明）
 * hasUI 守卫留在调用方（goal FR-6.6 语义，本 helper 不感知）。
 */
export function setWidgetDual(
  ctx: GuiContext,
  key: string,
  content: DualWidgetContent | undefined
): void {
  if (!ctx.ui?.setWidget) return

  if (content === undefined) {
    ctx.ui.setWidget(key, undefined)
    return
  }
  if (isGuiCapable(ctx)) {
    guiSetWidget(ctx, key, content.gui)
  } else {
    ctx.ui.setWidget(key, content.text)
  }
}

/**
 * 从 details 中提取 GuiRenderResult。前端统一用此函数读取 __gui__，
 * 集中校验版本号，避免散落的 as 断言。
 */
export function extractGui(details: Record<string, unknown> | undefined): GuiRenderResult | undefined {
  const g = details?.__gui__
  if (
    g &&
    typeof g === 'object' &&
    'v' in g &&
    'component' in g &&
    (g as { v: unknown }).v === PROTOCOL_VERSION
  ) {
    return g as GuiRenderResult
  }
  return undefined
}

/**
 * 最小形状校验：判断 unknown 值是否为合法 GuiComponent（有 type 字符串 + props 对象）。
 * 用于 widgetGui marker 解码后防止异常结构进入渲染层。
 * 不校验 type 是否为已知值（GuiComponentRenderer 对未知 type 有 AnsiText 降级）。
 */
export function isGuiComponent(value: unknown): value is GuiComponent {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  // typeof null === 'object' 是 JS 陷阱，必须显式排除 props: null（否则下游渲染层访问 props 字段崩溃）
  return typeof obj.type === 'string'
    && obj.props !== null
    && obj.props !== undefined
    && typeof obj.props === 'object'
}

/**
 * v1.1 wire 格式校验：判断 unknown 值是否为合法 GuiRenderResult 信封
 * （v === PROTOCOL_VERSION + component 是合法 GuiComponent）。meta 可选不校验深度。
 * event-adapter 据此区分 v1.1 信封（解包 component + meta）与 v1 裸 component
 * （旧版 extension 发出的 wire 格式，兼容窗口内两种并存）。
 */
export function isGuiRenderResult(value: unknown): value is GuiRenderResult {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return obj.v === PROTOCOL_VERSION && isGuiComponent(obj.component)
}

// ── 内部工具 ──

/** 递归 strip undefined 字段，确保 JSON.stringify 产出干净的对象 */
export function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(stripUndefined) as T

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = typeof value === 'object' ? stripUndefined(value) : value
    }
  }
  return result as T
}
