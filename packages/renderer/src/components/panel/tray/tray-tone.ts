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
import type { WorkflowRunRecord, WorkflowRunOutcome } from '@taiji/shared'

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

// ── workflow run 行 tone（[W2 D8] 三分 + 全集锁）─────────────────────────────
// 判据数据源 = 投影透传的 outcome 四值（WorkflowRunOutcome），不读 reason 字符串
// （翻译层）。三分裁决：completed→绿 / failed→红 / cancelled（用户主动）与
// interrupted（被动终局）同落中性暗——对齐 record 侧 INTERRUPTED_STOP_REASONS 的
// 中性灰现状，「同语义同色」构造性成立；cancelled 与 interrupted 的用词区分由
// workflowStatusLabel 的中文词表承载（禁混用）。

/**
 * outcome → tone 类名全集映射（全集锁载体）：`satisfies Record<WorkflowRunOutcome,
 * string>` 使词表扩值漏配 / 词表外多配都在本行编译红（vue-tsc 承载）。
 */
export const WORKFLOW_TONE_BY_OUTCOME = {
  completed: 'bg-success',
  failed: 'bg-danger',
  cancelled: 'bg-neutral-dim opacity-50',
  interrupted: 'bg-neutral-dim opacity-50',
} satisfies Record<WorkflowRunOutcome, string>

/** 中性暗档（cancel/interrupt 共用；与 record 侧中断族状态点同款类名） */
const NEUTRAL_TONE = 'bg-neutral-dim opacity-50'

/**
 * workflow run 行 tone（状态点与进度条同源）：
 * - 进行中 → accent（进度条/圆点同款）；
 * - done + outcome 四值 → 映射表取档；
 * - done + outcome 缺省（v1 存量快照无 journal outcome）→ 中性暗——数据缺口不作
 *   成功/失败断言（不误报红），对齐 W2 D2「存量帧读侧不映射」的保守方向。
 */
export function workflowToneClass(record: WorkflowRunRecord): string {
  if (record.status !== 'done') return 'bg-accent'
  return record.outcome === undefined ? NEUTRAL_TONE : WORKFLOW_TONE_BY_OUTCOME[record.outcome]
}

// 中文显示名（WORKFLOW_RUN_OUTCOME_LABELS）的 tray 文案消费位（workflow 行状态点
// hover title）待上游导出面补登记后接线：该常量已落 packages/shared/src/workflow.ts
// （[W2 D8]），但 shared 包根 index.ts 的 workflow 导出块只登记了 type 导出、运行时
// 常量（WORKFLOW_RUN_OUTCOME_ALL / WORKFLOW_RUN_OUTCOME_LABELS）未登记——index.ts
// 不在本单元领地内，接线（tray-tone import + workflowStatusLabel + 模板 title +
// state-tone-lock 文案断言段）随导出登记一并补齐。
