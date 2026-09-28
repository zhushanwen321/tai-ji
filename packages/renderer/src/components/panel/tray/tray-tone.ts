/**
 * 托盘条目 status → 色调/状态文案映射单点（TrayWidgetButton 的文字/图标色 +
 * TrayWidgetPanel 的状态点底色，同一输入两维度；workflow run 行的 tone 与终态
 * 中文文案也在此单点——[W2 D8] 映射全集锁落点）。
 *
 * 用 Map 而非裸对象下标：status 来自 extension 推送，脏值（如 'constructor'）在裸对象下标下
 * 会取到原型链函数当 class 用（与 TrayWidgetButton 的 BUILTIN_WIDGET_ICONS 同一安全 fence）。
 * 两维度的 fallback 各自保留：文字缺省空串（继承按钮中性色）、底色缺省 bg-neutral-dim。
 */
import type { WidgetMeta } from '@zhushanwen/extension-protocol'
import { WORKFLOW_RUN_OUTCOME_LABELS, type WorkflowRunRecord, type WorkflowRunOutcome } from '@taiji/shared'

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

// ── workflow run 行 tone（[W2 D8] 三分 + 全集锁 → [D2] 词表更新）─────────────
// 判据数据源 = 投影透传的 outcome 四值（WorkflowRunOutcome），不读 reason 字符串
// （翻译层）。三分裁决：done→绿 / failed→红 / cancelled（用户主动）与
// time_limited（超时终局）同落中性暗——「同语义同色」构造性成立；用词区分由
// workflowStatusLabel 的中文词表承载（禁混用）。[D2] 中断语义已移出 outcome——
// status 三态 'interrupted'（暂停态）走 workflowToneClass 的进行中分支前置判定。

/**
 * outcome → tone 类名全集映射（全集锁载体）：`satisfies Record<WorkflowRunOutcome,
 * string>` 使词表扩值漏配 / 词表外多配都在本行编译红（vue-tsc 承载）。
 */
export const WORKFLOW_TONE_BY_OUTCOME = {
  done: 'bg-success',
  failed: 'bg-danger',
  cancelled: 'bg-neutral-dim opacity-50',
  time_limited: 'bg-neutral-dim opacity-50',
} satisfies Record<WorkflowRunOutcome, string>

/** 中性暗档（cancel/interrupt 共用；与 record 侧中断族状态点同款类名） */
const NEUTRAL_TONE = 'bg-neutral-dim opacity-50'

/**
 * workflow run 行 tone（状态点与进度条同源）：
 * - interrupted（[D2] 暂停态）→ 中性暗专属条目；
 * - 进行中 → accent（进度条/圆点同款）；
 * - done + outcome 四值 → 映射表取档；
 * - done + outcome 缺省（v1 存量快照无 journal outcome）→ 中性暗——数据缺口不作
 *   成功/失败断言（不误报红），对齐 W2 D2「存量帧读侧不映射」的保守方向。
 */
export function workflowToneClass(record: WorkflowRunRecord): string {
  // [D2] interrupted 暂停态（status 三态第三值）：专属中性暗色调条目承接——
  // 「已中断（可续跑）」非进行中（不占 accent）、非终局（不作成败断言）
  if (record.status === 'interrupted') return NEUTRAL_TONE
  if (record.status !== 'done') return 'bg-accent'
  return record.outcome === undefined ? NEUTRAL_TONE : WORKFLOW_TONE_BY_OUTCOME[record.outcome]
}

/**
 * workflow run 行的终态中文文案（[W2 D8] 状态中文显示名统一词表的 tray 消费位）：
 * done + outcome 四值 → shared WORKFLOW_RUN_OUTCOME_LABELS 单源取名（成功/失败/
 * 已取消/已中断——「已取消」（主动）与「已中断」（被动）禁混用由词表唯一承载）；
 * running（spinner 已表达进行中）与 done + outcome 缺省（v1 存量快照数据缺口）→
 * undefined（模板 :title 绑定 undefined = 不出 hover 文案，不发明词表外描述）。
 */
export function workflowStatusLabel(record: WorkflowRunRecord): string | undefined {
  if (record.status !== 'done' || record.outcome === undefined) return undefined
  return WORKFLOW_RUN_OUTCOME_LABELS[record.outcome]
}
