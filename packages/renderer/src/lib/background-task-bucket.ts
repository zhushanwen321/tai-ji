/**
 * background-task-bucket —— 后台命令列表的分桶 / 筛选 / 计数 / 状态 icon SSOT
 *（docs/architecture/background-task-sidebar-view.md §3.3 D10①，u-renderer-store）。
 *
 * 纯函数模块，零 Vue / 零 DOM 依赖。四方同源消费点（禁两处各写判定，D10① 纪律）：
 * - 列表过滤（BackgroundTaskListView，u-renderer-list）
 * - FilterBar 三桶计数（同上）
 * - L2 tab 角标点亮条件（badge = active 计数 > 0，D4④，u-renderer-list）
 * - item 状态 icon 色档（backgroundTaskStatusIcon，D10⑤，u-renderer-list / u-drawer）
 *
 * 分桶判据直接复用契约谓词 `isActiveBackgroundTaskState` / `isTerminalBackgroundTaskState`
 *（@xyz-agent/extension-protocol，D9 同源）：运行中桶 = running + killing（killing 是
 *「已发令待确认」的活跃瞬态，用户视角仍在终止流程中）；已结束桶 = exited（含
 * natural/timeout/killed）+ orphaned。
 *
 * 类型取自 shared 协议镜像（偏差登记 #6：shared/src/index.ts 未具名导出，走
 * ServerMessageMap 索引；镜像 ⇔ extension-protocol 契约的逐字段全等由 core transport api
 * domain（packages/core/src/transport/api/domains/background-task.ts）的
 * BackgroundTaskMirrorEqualsContract 编译期守卫，任一侧漂移即 tsc 红）。
 */
import {
  isActiveBackgroundTaskState,
  isTerminalBackgroundTaskState,
} from '@xyz-agent/extension-protocol'
import type { ServerMessageMap } from '@xyz-agent/shared'

/** 任务条目类型（shared 协议镜像，经 ServerMessageMap 索引取用——偏差登记 #6）。 */
export type BackgroundTaskEntry = ServerMessageMap['backgroundTask:updated']['tasks'][number]

/** 二级状态筛选值：运行中（默认）/ 已结束 / 全部（三桶 UI 中的「全部」= 不过滤，D10）。 */
export type BackgroundTaskFilterValue = 'active' | 'ended' | 'all'

/** 分桶结果（二桶；「全部」是筛选值不是桶——由 filterBackgroundTasks 的 'all' 分支承载）。 */
type BackgroundTaskBucketValue = Exclude<BackgroundTaskFilterValue, 'all'>

/** icon 文字后备的语义键（aria-label / icon title 的 i18n key 尾段，文案由 u-i18n-docs 落地；
 *  色档判定的同源产物，消费层禁止按 state/reason 二次判定）。 */
export type BackgroundTaskStatusKey = 'running' | 'killing' | 'orphaned' | 'killed' | 'succeeded' | 'failed'

/** 状态 icon 形态：running = accent 旋转环，其余 = 语义色圆点（D10⑤）。 */
export interface BackgroundTaskIconState {
  shape: 'spinner' | 'dot'
  tone: 'accent' | 'warn' | 'info' | 'dim' | 'success' | 'danger'
  statusKey: BackgroundTaskStatusKey
}

/**
 * 分桶判据：running/killing → 'active'；exited/orphaned → 'ended'。
 * 谓词复用契约（isActive/isTerminal），不在本模块重写状态枚举判定。
 */
export function backgroundTaskBucket(entry: BackgroundTaskEntry): BackgroundTaskBucketValue {
  return isActiveBackgroundTaskState(entry.state) ? 'active' : 'ended'
}

/** ended 桶排序键：结束时刻（epoch ms），缺省（防御：终态条目契约必有 endedAt）用 startedAt 兜底。 */
function endedAtMs(entry: BackgroundTaskEntry): number {
  return entry.endedAt ?? entry.startedAt
}

/**
 * 按筛选值过滤 + 排序（S1 验收口径，排序与过滤同源 SSOT）：
 * - 'active'：运行中桶（startedAt 升序，先发起在前）；
 * - 'ended'：已结束桶（endedAt 倒序，最近结束在前）；
 * - 'all'：运行中置顶（startedAt 升序）+ 已结束（endedAt 倒序）——分组可读性由消费层
 *   渲染分隔线，本函数只保证两段各自有序且 active 段在前（D10③）。
 */
export function filterBackgroundTasks(
  tasks: BackgroundTaskEntry[],
  filter: BackgroundTaskFilterValue,
): BackgroundTaskEntry[] {
  if (filter === 'active') {
    return tasks
      .filter((t) => backgroundTaskBucket(t) === 'active')
      .sort((a, b) => a.startedAt - b.startedAt)
  }
  const endedSorted = tasks
    .filter((t) => isTerminalBackgroundTaskState(t.state))
    .sort((a, b) => endedAtMs(b) - endedAtMs(a))
  if (filter === 'ended') return endedSorted
  // 'all'：active 置顶 + ended 倒序（active 段复用 active 桶排序）
  const activeSorted = tasks
    .filter((t) => isActiveBackgroundTaskState(t.state))
    .sort((a, b) => a.startedAt - b.startedAt)
  return [...activeSorted, ...endedSorted]
}

/** 三桶计数（FilterBar 计数预告 + L2 角标「运行中桶 > 0」同源派生，D4④/D10①）。 */
export function countBackgroundTasks(tasks: BackgroundTaskEntry[]): {
  active: number
  ended: number
  all: number
} {
  let active = 0
  let ended = 0
  for (const t of tasks) {
    if (isActiveBackgroundTaskState(t.state)) active += 1
    else if (isTerminalBackgroundTaskState(t.state)) ended += 1
  }
  return { active, ended, all: tasks.length }
}

/**
 * 状态 icon 色档判定（D10⑤，判定顺序固定——顺序即语义，改动须先改设计）：
 * 1. state 先分流：running → accent 旋转环 / killing → warn 点 / orphaned → info 点；
 * 2. exited 内 reason==='killed' 优先分流 dim 点（killed 的 exitCode 也是 null——
 *    SIGKILL 终止无退出码——若先判 exitCode 会误入 danger）；
 * 3. 其余 exitCode===0 ? success 点 : danger 点（`exitCode !== 0` 吸收 null：timeout 与
 *    外部手杀的 natural（exitCode=null）同为 danger 档，色档不区分 reason，差异由 drawer
 *    reason 行与 icon 文字后备（statusKey）承载）。
 */
export function backgroundTaskStatusIcon(entry: BackgroundTaskEntry): BackgroundTaskIconState {
  if (entry.state === 'running') return { shape: 'spinner', tone: 'accent', statusKey: 'running' }
  if (entry.state === 'killing') return { shape: 'dot', tone: 'warn', statusKey: 'killing' }
  if (entry.state === 'orphaned') return { shape: 'dot', tone: 'info', statusKey: 'orphaned' }
  if (entry.reason === 'killed') return { shape: 'dot', tone: 'dim', statusKey: 'killed' }
  return entry.exitCode === 0
    ? { shape: 'dot', tone: 'success', statusKey: 'succeeded' }
    : { shape: 'dot', tone: 'danger', statusKey: 'failed' }
}
