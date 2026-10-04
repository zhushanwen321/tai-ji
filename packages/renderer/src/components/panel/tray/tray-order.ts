/**
 * tray-order.ts —— 协议 widget 区排序纯函数（设计 docs/design/composer-task-tray.md——已删除，git 可追溯——
 * §3.3 D6「排序 = known-order + getViewIds 数组序」+ §3.4 终态数据流）。
 *
 * 排序语义（宿主契约，与 core `view-host-store.getViewIds` 的 JSDoc 同源）：
 * - **known-order 优先**：`['todo','goal']` 是裁决记录①定下的默认 widget 顺序，恒在前；
 * - **其余 key 按 `getViewIds(sessionId)` 返回的数组序追加在 goal 之后**：该数组序 =
 *   ViewHostStore 内部 Map 的**当前插入序（invalidate 后重注册移尾部）**——ECMAScript 规范
 *   语义：Map 迭代序 = 插入序；renderer 侧 reactive 包装不改迭代序（探针 P3 ✅）。
 *   即：widget 被清屏（`setWidget(key, undefined)` → invalidate 删键）后再注册，是新插入键 →
 *   落到尾部，不回原位。宿主不新增 seq 字段（D6：seq 是重建冗余派生态，且每次重推换 seq
 *   会让未知 key 起伏抖动，比 Map 原地保位更差）。
 * - known-order 内的 key 在输入中缺失即跳过（不产生幽灵条目）；输入重复 key 不在契约内
 *   （调用方传 `getViewIds` 产物 = Map 键集，天然去重）。
 *
 * 纯函数、零响应式依赖：响应式建链（`getViewIds` + `getView` 必须同 computed 调用路径，
 * 拆开即断链）由消费方承担，见 TrayWidgetButton.vue 头注「依赖追踪契约」。
 */

/** 托盘 widget 区前置顺序（裁决记录①：todo/goal 为默认 widget，恒排在未知 key 之前）。 */
export const TRAY_WIDGET_KNOWN_ORDER = ['todo', 'goal'] as const

/**
 * 托盘 widget 区排序：known-order 优先，其余按传入数组序（= ViewHostStore 当前插入序）
 * 追加在 known-order 之后。
 *
 * @param viewIds `getViewIds(sessionId)` 的返回数组（ViewHostStore 当前插入序）
 * @returns 排序后的 viewId 数组（新数组，不改入参）
 */
export function orderTrayWidgetIds(viewIds: readonly string[]): string[] {
  const known = new Set<string>(TRAY_WIDGET_KNOWN_ORDER)
  const ordered: string[] = []
  for (const key of TRAY_WIDGET_KNOWN_ORDER) {
    if (viewIds.includes(key)) ordered.push(key)
  }
  for (const viewId of viewIds) {
    if (!known.has(viewId)) ordered.push(viewId)
  }
  return ordered
}
