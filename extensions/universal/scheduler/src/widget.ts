import {
  guiComponent,
  guiResult,
  setWidgetDual,
  type DualWidgetContent,
  type GuiContext,
  type GuiRenderResult,
  type TreeItem,
  type WidgetMeta,
} from '@zhushanwen/extension-protocol'

import { formatSchedule, truncate } from './format.js'
import type { UiLocale } from './format.js'
import { readUiLocale, renderTaskLineStatic, t, toTaskParams } from './i18n.js'
import type { ScheduledTask } from './types.js'

/** widget 中任务名的最大显示宽度（列）。 */
const WIDGET_NAME_MAX_WIDTH = 20

/**
 * TUI 文本行（locale 显式传入供测试；生产路径由 `buildSchedulerWidgetContent` 经
 * `readUiLocale()` 解析后传入，再经 `setSchedulerWidget` 双模推送）。
 * 格式：[定时任务] 3 条 · check-build 每 5 分钟（en: [scheduler] 3 scheduled · …）
 *
 * 静态面契约（scheduler widget 推送修正设计 D1-a）：行内容只由任务集稳定字段 + locale
 * 派生，**无任何 now 参与的元素**——相对时间与「[!] n 条已逾期」标记已整体移除（时间流逝
 * 不是状态变化，静态面恒定是 index.ts 指纹跳推「无变化零推送」的前提）。
 * 「最近任务」= nextRunAt 升序首个**启用**任务、**不用 now 过滤**：若保留
 * `nextRunAt > now` 过滤，任务 dispatch 失败未推进 nextRunAt 时越过时间点后「最近任务」
 * 会切换——显示变化而指纹不变，重新引入冻结缺口（设计 D1-a 反例论证）。
 *
 * 不接受 theme 参数：string[] 重载本身不提供 theme，着色交给 Pi 默认渲染。
 */
export function renderSchedulerWidgetTui(tasks: ScheduledTask[], locale: UiLocale): string[] {
  if (tasks.length === 0) return []

  const enabled = tasks.filter(t => t.enabled)
  const parts: string[] = []
  parts.push(t('widget.count', { n: enabled.length }, locale))

  const next = [...enabled].sort((a, b) => a.nextRunAt - b.nextRunAt)[0]
  if (next) {
    parts.push(
      t(
        'widget.task',
        {
          name: truncate(next.name, WIDGET_NAME_MAX_WIDTH),
          schedule: formatSchedule(next.schedule, next.kind, locale),
        },
        locale,
      ),
    )
  }

  return [t('widget.line', { title: t('widget.title', undefined, locale), parts: parts.join(' · ') }, locale)]
}

/**
 * GUI 臂结构化载荷（设计 §6.8 D8）：body = 逐任务 list-tree（行文本走 `renderTaskLineStatic`
 * 静态变体单点），head 元数据由宿主壳层渲染——**标题由扩展自产**（`meta.title = t('tray.title')`），
 * 宿主零改动（三处渲染面：前两面 trim / `TrayAggregatePanel` nullish，非空标题均正确）。
 *
 * icon 点名 lucide key 'clock'（与设计 §6.8 一致）；badge = 启用任务数；status 两态 =
 * 有启用任务 running / 空 idle（D1-a：「有逾期 → failed」翻牌已移除——逾期是 now 派生
 * 显示，且 lastStatus 不在指纹字段集内）。刷新节拍 = 状态变化驱动 + 保活底线帧
 * （scheduler widget 推送修正设计 D1/D2）。
 */
export function buildSchedulerWidgetGui(tasks: ScheduledTask[], locale: UiLocale): GuiRenderResult {
  const enabledCount = tasks.filter(t => t.enabled).length

  return guiResult(
    guiComponent('list-tree', { items: buildSchedulerWidgetItems(tasks, locale) }),
    {
      title: t('tray.title', undefined, locale),
      status: widgetStatus(enabledCount),
      icon: 'clock',
      badge: String(enabledCount),
    },
  )
}

/**
 * GUI body 逐任务行（复用 renderTaskLineStatic 静态变体单点；导出供测试直接断言行文本）。
 * `now` 形参仅为满足 toTaskParams 的形状必填字段（命令变体的相对时间基准），静态变体
 * **不消费**它——保留形参以维持与命令投影同一形状来源，防双口径。
 */
export function buildSchedulerWidgetItems(
  tasks: ScheduledTask[],
  locale: UiLocale,
  now: number = Date.now(),
): TreeItem[] {
  return tasks.map(task => ({ label: renderTaskLineStatic(toTaskParams(task, now), locale), depth: 0 }))
}

function widgetStatus(enabledCount: number): WidgetMeta['status'] {
  return enabledCount > 0 ? 'running' : 'idle'
}

/**
 * 任务集稳定指纹（scheduler widget 推送修正设计 D1-b）：index.ts 的 refreshWidget 推送前
 * 对比本指纹，不变则跳过 setWidgetDual（推送与任务集状态变化同频，时间流逝零推送）。
 * rpc/tui 两模式同效（指纹在 setWidgetDual 之前判定）。
 *
 * **维护不变量：指纹字段集 ⊇ widget 显示决定因素全集。** widget 两臂的显示内容必须完全是
 * 本序列化字段集（id/name/schedule/kind/enabled/nextRunAt/locale）的纯函数——D1 静态化
 * 保证（P6：dispatch 失败四路径不推进 nextRunAt，now 派生显示元素会造出「显示已变而指纹
 * 不变」的冻结缺口）。**未来给 widget 行新增任何显示字段时，必须同步加入本序列化字段集**，
 * 否则冻结缺口静默回归。
 *
 * kind 显式入指纹：行文本含 `formatSchedule(spec, kind, locale)`，kind 是显示决定因素
 * （当前无 update op 不可变，by-construction 论证仍须显式闭合）；locale 显式入指纹：
 * 切语言一次推送自愈。
 */
export function computeTasksFingerprint(tasks: ScheduledTask[], locale: UiLocale): string {
  return JSON.stringify({
    locale,
    tasks: tasks.map(task => ({
      id: task.id,
      name: task.name,
      schedule: task.schedule,
      kind: task.kind,
      enabled: task.enabled,
      nextRunAt: task.nextRunAt,
    })),
  })
}

/**
 * 双模 widget 内容（GUI + TUI 两臂按值构造）：空任务 → undefined（setWidgetDual 的清屏分支）。
 * `setWidgetDual` 的模式分派单点在 @zhushanwen/extension-protocol（TUI 不触达 marker 编码）。
 */
export function buildSchedulerWidgetContent(
  tasks: ScheduledTask[],
  locale?: UiLocale,
): DualWidgetContent | undefined {
  if (tasks.length === 0) return undefined
  const resolved = locale ?? readUiLocale()
  return {
    gui: buildSchedulerWidgetGui(tasks, resolved),
    text: renderSchedulerWidgetTui(tasks, resolved),
  }
}

/**
 * 推送 scheduler widget（结构化 meta + TUI 双模）。index.ts 经本入口接线（u-p2b），
 * 调用方传 `ctx as GuiContext`（pi 的 ExtensionContext.ui.custom 与 GuiContext
 * 静态不完全兼容，先例见 todo/src/index.ts makeRefreshDisplay）。
 * 跳推/保活判定在 index.ts 的 refreshWidget（实例态存 factory 闭包），本入口保持无条件推送。
 */
export function setSchedulerWidget(ctx: GuiContext, tasks: ScheduledTask[]): void {
  setWidgetDual(ctx, 'scheduler', buildSchedulerWidgetContent(tasks))
}
