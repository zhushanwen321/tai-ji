import { formatRelativeTime, truncate } from './format.js'
import type { ScheduledTask } from './types.js'

/** widget 中任务名的最大显示宽度（列）。 */
const WIDGET_NAME_MAX_WIDTH = 20

/**
 * 渲染 TUI status bar widget（string[]，配合 SDK setWidget 第一重载）。
 * 格式：[scheduler] 3 scheduled · check-build in 4m · 1 overdue
 *
 * 不接受 theme 参数：string[] 重载本身不提供 theme，着色交给 Pi 默认渲染。
 * overdue 用 [!] 纯文本标记（PR 已统一去 emoji）。
 */
export function renderSchedulerWidget(tasks: ScheduledTask[]): string[] {
  if (tasks.length === 0) return []

  const now = Date.now()
  const enabled = tasks.filter(t => t.enabled)
  const overdue = enabled.filter(t => t.nextRunAt <= now)
  const upcoming = enabled
    .filter(t => t.nextRunAt > now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)

  const parts: string[] = []
  parts.push(`${enabled.length} scheduled`)

  if (upcoming.length > 0) {
    const next = upcoming[0]!
    parts.push(`${truncate(next.name, WIDGET_NAME_MAX_WIDTH)} ${formatRelativeTime(next.nextRunAt)}`)
  }

  if (overdue.length > 0) {
    parts.push(`[!] ${overdue.length} overdue`)
  }

  return [`[scheduler] ${parts.join(' · ')}`]
}
