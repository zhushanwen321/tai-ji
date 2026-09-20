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

import { formatRelativeTime, truncate } from './format.js'
import type { UiLocale } from './format.js'
import { readUiLocale, renderTaskLine, t, toTaskParams } from './i18n.js'
import type { ScheduledTask } from './types.js'

/** widget 中任务名的最大显示宽度（列）。 */
const WIDGET_NAME_MAX_WIDTH = 20

/**
 * TUI 文本行（locale 显式传入供测试；生产路径由 `buildSchedulerWidgetContent` 经
 * `readUiLocale()` 解析后传入，再经 `setSchedulerWidget` 双模推送）。
 * 格式：[定时任务] 3 条 · check-build 4 分钟后 · [!] 1 条已逾期（en: [scheduler] 3 scheduled · …）
 *
 * 不接受 theme 参数：string[] 重载本身不提供 theme，着色交给 Pi 默认渲染。
 * overdue 用 [!] 纯文本标记（统一去 emoji）。
 */
export function renderSchedulerWidgetTui(tasks: ScheduledTask[], locale: UiLocale): string[] {
  if (tasks.length === 0) return []

  const now = Date.now()
  const enabled = tasks.filter(t => t.enabled)
  const overdue = enabled.filter(t => t.nextRunAt <= now)
  const upcoming = enabled
    .filter(t => t.nextRunAt > now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)

  const parts: string[] = []
  parts.push(t('widget.count', { n: enabled.length }, locale))

  if (upcoming.length > 0) {
    const next = upcoming[0]!
    parts.push(
      t(
        'widget.task',
        {
          name: truncate(next.name, WIDGET_NAME_MAX_WIDTH),
          relative: formatRelativeTime(next.nextRunAt, locale, now),
        },
        locale,
      ),
    )
  }

  if (overdue.length > 0) {
    parts.push(t('widget.overdue', { n: overdue.length }, locale))
  }

  return [t('widget.line', { title: t('widget.title', undefined, locale), parts: parts.join(' · ') }, locale)]
}

/**
 * GUI 臂结构化载荷（设计 §6.8 D8）：body = 逐任务 list-tree（行文本走 `renderTaskLine`
 * 单点），head 元数据由宿主壳层渲染——**标题由扩展自产**（`meta.title = t('tray.title')`），
 * 宿主零改动（三处渲染面：前两面 trim / `TrayAggregatePanel` nullish，非空标题均正确）。
 *
 * icon 点名 lucide key 'clock'（与设计 §6.8 一致）；badge = 启用任务数；status：
 * 有逾期 → failed / 有任务 → running / 空 → idle。刷新节拍 = runtime TICK_INTERVAL_MS
 * （切语言后 ≤30s 自愈，设计 §6.8 显式接受）。
 */
export function buildSchedulerWidgetGui(tasks: ScheduledTask[], locale: UiLocale): GuiRenderResult {
  const now = Date.now()
  const enabled = tasks.filter(t => t.enabled)
  const overdue = enabled.filter(t => t.nextRunAt <= now)

  return guiResult(
    guiComponent('list-tree', { items: buildSchedulerWidgetItems(tasks, locale, now) }),
    {
      title: t('tray.title', undefined, locale),
      status: widgetStatus(enabled.length, overdue.length),
      icon: 'clock',
      badge: String(enabled.length),
    },
  )
}

/** GUI body 逐任务行（复用 renderTaskLine 单点；导出供测试直接断言行文本）。 */
export function buildSchedulerWidgetItems(
  tasks: ScheduledTask[],
  locale: UiLocale,
  now: number = Date.now(),
): TreeItem[] {
  return tasks.map(task => ({ label: renderTaskLine(toTaskParams(task, now), locale), depth: 0 }))
}

function widgetStatus(enabledCount: number, overdueCount: number): WidgetMeta['status'] {
  if (overdueCount > 0) return 'failed'
  return enabledCount > 0 ? 'running' : 'idle'
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
 */
export function setSchedulerWidget(ctx: GuiContext, tasks: ScheduledTask[]): void {
  setWidgetDual(ctx, 'scheduler', buildSchedulerWidgetContent(tasks))
}
