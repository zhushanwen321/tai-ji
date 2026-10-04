
/**
 * 会话状态图标 + 派生逻辑 re-export（R2 logic 层）。
 *
 * SessionItem（sidebar）、PanelHeader 共用同一 9 态 → 图标/颜色/动画映射，
 * 收敛到此避免多处复制粘贴漂移。语义色取自 design-tokens（CSS 变量），不硬编码十六进制色。
 *
 * deriveStatus（D6 → 方案 C 优化版 9 态）已迁 @taiji/core/domain/chat/derive-status.ts
 * （renderer-model M3，纯函数归 core 域）：本文件 re-export 转发，消费方 import 路径零改动。
 * DOT_CLASS / STATUS_ICON 等视觉映射（CSS 类属展示层）仍留 renderer（M3 §3.3.4）。
 */
import type { DerivedStatus } from '@taiji/core'
import type { SessionStatus } from '@taiji/shared'

export type { DerivedStatus }

/**
 * deriveStatus 纯函数（re-export 自 core，M3 搬迁）。
 * 签名与迁移前一致：
 * (sessionId, chat, isActive, isCompacting=false, hasBackgroundWork=false, metaStatus?, hasFormOverlayPending=false)
 */
export { deriveStatus } from '@taiji/core'

/**
 * 进程级 SessionStatus → 展示态 DerivedStatus（色语言 SSOT）。
 *
 * agent 派发的子会话通常未 hydrate，`deriveStatus` 对 status='active' 无消息会兜底 `done`
 * （见 core derive-status 的 terminalStatusWithoutMessages），无法表达运行中；托盘/侧栏
 * 需要展示态时以进程级真值为准，经此单一映射取 DOT_CLASS 色。
 *
 * active→streaming(accent) · error→error(danger) · stopped/dead→stopped(dim) ·
 * idle/done→done(绿)。
 */
export const DISPLAY_STATUS: Record<SessionStatus, DerivedStatus> = {
  active: 'streaming',
  idle: 'done',
  done: 'done',
  error: 'error',
  stopped: 'stopped',
  dead: 'stopped',
}

/**
 * 判据：session 是否「运行已完成」= 映射到绿点（done）态。
 *
 * 「绿点 = 运行已完成」的口径与侧栏/托盘的状态点色语言一致：DISPLAY_STATUS 映射到
 * `'done'` 的进程级 status（idle / done）即绿点，其余（active / error / stopped / dead）
 * 都算未完成。侧栏子会话徽标取 `!isSessionCompleted(status)` 汇总「未完成数」，故 error /
 * stopped / dead 子会话也会计入（判据是「非绿点」，不是「运行中」）。
 */
export function isSessionCompleted(status: SessionStatus): boolean {
  return DISPLAY_STATUS[status] === 'done'
}

/**
 * 状态点语义类：背景色（9 态）。
 * 活跃态在组件层改用语义图标 + 动画，圆点仅作为静态 fallback 等处的点状指示。
 */
export const DOT_CLASS: Record<DerivedStatus, string> = {
  streaming: 'bg-accent',
  pending: 'bg-accent',
  compacting: 'bg-accent',
  working: 'bg-accent',
  waiting: 'bg-warn',
  retrying: 'bg-warn',
  done: 'bg-success',
  stopped: 'bg-neutral-dim opacity-50',
  error: 'bg-danger',
}

/**
 * 状态 → 语义图标配置（方案 C 优化版 v3 + working）。
 * icon: lucide 图标名（与 @lucide/vue 导出同名）。
 * color: Tailwind 语义色类（text-*）。
 * animation: 动画类（'' 表示静态）。
 */
export const STATUS_ICON: Record<
  DerivedStatus,
  { icon: string; color: string; animation: string }
> = {
  streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' },
  pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-pulse-strong' },
  compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' },
  working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' },
  waiting: { icon: 'Wrench', color: 'text-warn', animation: '' },
  retrying: { icon: 'Zap', color: 'text-warn', animation: 'animate-pulse-strong' },
  done: { icon: 'CheckCircle2', color: 'text-success', animation: '' },
  stopped: { icon: 'Ban', color: 'text-neutral-mid', animation: '' },
  error: { icon: 'AlertCircle', color: 'text-danger', animation: '' },
}

/**
 * 取状态点 class（组件 dotClass computed 的纯函数等价物）。
 * 组件可直接 DOT_CLASS[status] 或经此 helper，二者等价；提供 helper 便于未来加 guard / fallback。
 */
export function statusDotClass(status: DerivedStatus): string {
  return DOT_CLASS[status]
}

/**
 * 活跃态用转菊花（Loader2 + animate-spin）替代脉冲圆点的旧行为已迁移到 STATUS_ICON。
 * 以下常量保留仅作向后兼容：历史组件若仍消费 shouldShowSpinner / spinnerTextClass，
 * 行为与旧态一致（running/waiting/working 显示 spinner）。
 * 新组件建议直接消费 STATUS_ICON。
 */
const SPINNER_STATUSES: ReadonlySet<DerivedStatus> = new Set(['streaming', 'waiting', 'working'])

export function shouldShowSpinner(status: DerivedStatus): boolean {
  return SPINNER_STATUSES.has(status)
}

/** spinner 图标色（streaming/working→accent 蓝，waiting→warning 橙） */
export const SPINNER_TEXT_CLASS: Record<'streaming' | 'waiting' | 'working', string> = {
  streaming: 'text-accent',
  waiting: 'text-warn',
  working: 'text-accent',
}

/** spinner 适用状态联合（用于类型收窄） */
export type SpinnerStatus = 'streaming' | 'waiting' | 'working'

/**
 * 类型守卫：status 是否为 spinner 适用状态（streaming / waiting）。
 * 收窄后可安全索引 SPINNER_TEXT_CLASS。
 */
export function isSpinnerStatus(status: DerivedStatus): status is SpinnerStatus {
  return SPINNER_STATUSES.has(status)
}

/**
 * 取 spinner 图标色 class（类型安全封装）。
 * isSpinnerStatus 收窄后安全索引 SPINNER_TEXT_CLASS，消除组件侧 `as` 断言。
 */
export function spinnerTextClass(status: DerivedStatus): string | null {
  return isSpinnerStatus(status) ? SPINNER_TEXT_CLASS[status] : null
}
