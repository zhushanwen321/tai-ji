/**
 * 托盘条目 status → 色调/状态文案映射单点（TrayWidgetButton 的文字/图标色 +
 * TrayWidgetPanel 的状态点底色，同一输入两维度）。
 * [容器扩展点统一 §6.6/U9+U10] workflow run 行的 tone 与终态中文文案（WORKFLOW_TONE_BY_OUTCOME /
 * workflowToneClass / workflowStatusLabel）已随托盘 workflow 件迁移一并退役——宿主托盘行删，
 * 插件侧 widget 树承载状态表达（SUBAGENT_DOT_RULES 退役同款）。
 *
 * 用 Map 而非裸对象下标：status 来自 extension 推送，脏值（如 'constructor'）在裸对象下标下
 * 会取到原型链函数当 class 用（与 TrayWidgetButton 的 BUILTIN_WIDGET_ICONS 同一安全 fence）。
 * 两维度的 fallback 各自保留：文字缺省空串（继承按钮中性色）、底色缺省 bg-neutral-dim。
 */
import type { WidgetMeta } from '@zhushanwen/extension-protocol'

const WIDGET_TONE = new Map<WidgetMeta['status'], { text: string; dot: string }>([
  ['running', { text: 'text-accent', dot: 'bg-accent' }],
  ['done', { text: 'text-success', dot: 'bg-success' }],
  ['failed', { text: 'text-danger', dot: 'bg-danger' }],
  ['idle', { text: 'text-neutral-dim', dot: 'bg-neutral-dim' }],
])

/** status → 文字/图标色（未知/缺省 → ''：继承按钮中性色） */
export function widgetToneText(status: WidgetMeta['status'] | undefined): string {
  return (status === undefined ? undefined : WIDGET_TONE.get(status)?.text) ?? ''
}

/** status → 状态点/填充底色（未知/缺省 → bg-neutral-dim） */
export function widgetToneDot(status: WidgetMeta['status'] | undefined): string {
  return (status === undefined ? undefined : WIDGET_TONE.get(status)?.dot) ?? 'bg-neutral-dim'
}
