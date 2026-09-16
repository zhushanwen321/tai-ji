/**
 * resolve.ts —— GuiComponent → ResolvedRender 纯函数（IF1/DM1，AC2 承载件）。
 *
 * 职责：type 路由 + AnsiText 降级，把现有 GuiComponentRenderer.vue 的
 * resolved/resolvedProps 两个 computed 下沉为 core 纯函数（§7.2 core 职责）。
 * 零副作用零模块状态：customRegistry 参数注入（不调 inject），同输入同输出可纯单测。
 *
 * 四分支（IF1 contract）：
 *   1) builtin（card/columns/list-tree/progress-bar/stats-line/tab-bar）且 props 是对象
 *      → { type: 原type, props: 原props }（原样透传，不校验深度）
 *   2) custom 且 props.component 是 string 且已注册 → { type: 'custom', props: 原props }
 *      （ui 层用 props.component 查 CUSTOM_MAP）
 *   3) custom 未注册 / 未知 type / 脏数据 → { type: 'ansi-text', props: { content: JSON.stringify(...) } }
 *      （三类降级统一收敛，JSON 序列化保留结构化信息，§7.4 ANSI 兜底永留铁律）
 *   4) ansi-text 且 props.lines 是数组 → { type: 'ansi-text', props: { content: lines.join('\n') } }
 *      （与现有 GuiComponentRenderer join 语义一致，AnsiText 用 ansi_up 解析 ANSI 着色）
 *
 * 错误防护（ES1-3，AC2「无异常、无信息丢失」铁律）：
 *   - 输入防御：component 非对象 / type 非字符串 / props 非对象 → 不抛，降级
 *   - ansi-text 但 lines 非数组 → 走降级分支，不执行 lines.join
 *   - JSON.stringify 失败（循环引用 / BigInt）→ try/catch 兜底 '[unserializable component props]'
 *
 * 零运行时 vue：Component 仅为类型（import type 编译期擦除），产物零 vue（TC2 + clarify Q1 方案 a）。
 */
import type { Component } from 'vue'
import type { GuiComponent, GuiComponentType } from '@zhushanwen/extension-protocol'
import { isCustomRegistered } from './custom-registry'

/** resolve 输出——type 是最终渲染键（降级后恒为 'ansi-text'），props 已适配（降级时为 { content: string }） */
export interface ResolvedRender {
  type: GuiComponentType
  props: Record<string, unknown>
}

/** 已知 builtin type 集合（除 custom/ansi-text 的 7 个布局原语）。
 *  新增原语时四同步：extension-protocol 类型 + 此处 + ui 组件 + v6 视觉（§7.4）。 */
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'card', 'stats-line', 'progress-bar', 'list-tree', 'columns', 'tab-bar', 'group',
])

const JSON_INDENT = 2

/** ES3 兜底文案：序列化失败（循环引用/BigInt）时降级显示 */
const UNSERIALIZABLE_FALLBACK = '[unserializable component props]'

/**
 * 降级序列化 helper——不抛异常（ES1/ES3）。
 * 序列化对象选择：component 是对象时取 props（信息载体）；component 非对象时
 * 序列化 component 本身（JSON.stringify(null)='null' 不抛，undefined → String 兜底）。
 */
function serializeFallback(component: unknown): string {
  const target = component !== null && typeof component === 'object'
    ? (component as { props?: unknown }).props
    : component
  try {
    const s = JSON.stringify(target, null, JSON_INDENT)
    // JSON.stringify(undefined) 返回 undefined（非字符串），String 兜底保持 content: string 契约
    return s === undefined ? String(target) : s
  } catch {
    return UNSERIALIZABLE_FALLBACK
  }
}

/**
 * 解析 GuiComponent → ResolvedRender（type 路由 + AnsiText 降级）。
 * 纯函数：customRegistry 参数注入（缺省 undefined → 空表语义，custom 一律降级），
 * 零副作用（不调 inject、不读全局、不 mutate 入参），可纯单测。
 */
export function resolveComponent(
  component: unknown,
  customRegistry?: Readonly<Record<string, Component>>,
): ResolvedRender {
  // ES1：component 非对象（null/undefined/数字/字符串）→ 降级，不抛
  if (component === null || typeof component !== 'object') {
    return { type: 'ansi-text', props: { content: serializeFallback(component) } }
  }

  const { type, props } = component as GuiComponent

  // custom 类型：查注册表（w1 isCustomRegistered，空表语义）
  if (type === 'custom') {
    const name = (props as { component?: unknown } | null)?.component
    if (typeof name === 'string' && isCustomRegistered(customRegistry, name)) {
      return { type: 'custom', props: props as Record<string, unknown> }
    }
    // custom 未注册（或 component 非字符串）→ 降级
    return { type: 'ansi-text', props: { content: serializeFallback(component) } }
  }

  // ES1：type 非字符串 → 降级
  if (typeof type !== 'string') {
    return { type: 'ansi-text', props: { content: serializeFallback(component) } }
  }

  // ansi-text 特判：正常形状（lines 数组）→ join（分支 4）；否则走降级（ES2）
  if (type === 'ansi-text') {
    const lines = (props as { lines?: unknown } | null)?.lines
    if (Array.isArray(lines)) {
      return { type: 'ansi-text', props: { content: (lines as unknown[]).join('\n') } }
    }
    return { type: 'ansi-text', props: { content: serializeFallback(component) } }
  }

  // ES1：props 非对象 → 降级
  if (props === null || typeof props !== 'object') {
    return { type: 'ansi-text', props: { content: serializeFallback(component) } }
  }

  // 未知 type（协议外）→ 降级
  if (!BUILTIN_TYPES.has(type)) {
    return { type: 'ansi-text', props: { content: serializeFallback(component) } }
  }

  // 分支 1：builtin 原样透传
  return { type: type as GuiComponentType, props: props as Record<string, unknown> }
}
