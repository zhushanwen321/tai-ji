/**
 * scheduler 创建确认的协议 helper（定制层）。
 *
 * scheduleCreateInteract() 是 schedule 工具在 RPC 模式下的确认交互入口。
 * TUI 模式下 extension 必须自行调 ctx.ui.custom()（ScheduleCreateComponent）。
 *
 * 走 select 通道 + marker（SCHEDULE_CREATE_MARKER），传输核与失败折叠复用
 * callMarkerRpc 原语（D8：判别结果而非抛错，cancelled/timeout/channel-error/
 * non-json 四态），折叠动作留调用方（execute 六步流）：
 * - cancelled / timeout → cancelled result（D5：取消不是错误，agent 不重试）
 * - channel-error → 禁用本会话 schedule 工具 + throw（§3.5 错误规格）
 * - non-json → 协议版本错配类故障
 *
 * 时间折叠单点（D2）：dateToOnceCron / onceCronToDate 一次性时刻 ↔ 一次性 cron
 * 互转，GUI（ScheduleCreateOverlay）与 TUI（ScheduleCreateComponent）共用本实现，
 * 禁止双端各写一份——时间语义漂移正是本协议要关闭的失败模式（F1）。
 * 时区语义：按本地墙钟时间（croner 对 cron 默认本地解释，datetime 控件与 TUI
 * 掩码编辑均产出本地墙钟时间）。
 */

import type { GuiContext } from '../../core/gui-context'
import { isGuiCapable } from '../../core/helpers'
import { callMarkerRpc } from '../../core/select-rpc'
import type { ScheduleDraft, ScheduleFormResult } from './types'
import { SCHEDULE_CREATE_MARKER } from './marker'

/** scheduleCreateInteract 的判别结果：成功收窄为 FormResult；失败按 callMarkerRpc 四态折叠 */
export type ScheduleCreateInteractResult =
  | { ok: true; result: ScheduleFormResult }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'channel-error' | 'non-json' }

export interface ScheduleCreateInteractOptions {
  /** 透传 select dialog：abort 后 pi 本地 resolve(undefined) → cancelled */
  signal?: AbortSignal
  /** 失败留痕注入（channel-error / non-json / 回包形状错），日志策略归调用方 */
  log?: (msg: string, detail?: object) => void
}

/**
 * scheduler 创建确认入口（RPC 模式专用）。
 *
 * RPC 模式：select 通道携带草稿数据，前端渲染确认弹框，回传 FormResult。
 * TUI 模式：抛错。extension 必须自行调 ctx.ui.custom()——返回 null 会与
 * 「用户取消」混淆，让 extension 误以为用户取消了。
 *
 * 确认交互不设墙钟超时（任务级正常路径无墙钟，AGENTS.md 超时默认原则）：
 * options 不提供 timeout 入口，timeout 态仅由「未 abort 的 undefined resolve」产生。
 */
export async function scheduleCreateInteract(
  ctx: GuiContext,
  draft: ScheduleDraft,
  options?: ScheduleCreateInteractOptions,
): Promise<ScheduleCreateInteractResult> {
  if (!(isGuiCapable(ctx) && ctx.ui?.select)) {
    // 非 RPC 模式不代劳 TUI 渲染（TUI Component 是 extension 特定的，helper 不代劳）。
    // 抛错而非返回判别失败——与 askUserInteract 先例同构。
    throw new Error(
      'scheduleCreateInteract() is only available in RPC mode. ' +
      'In TUI mode, use ctx.ui.custom() with your own Component directly.',
    )
  }
  const rpcResult = await callMarkerRpc(
    ctx,
    SCHEDULE_CREATE_MARKER,
    JSON.stringify(draft), // undefined 可选字段由 JSON.stringify 天然丢弃
    { signal: options?.signal, log: options?.log },
  )
  if (!rpcResult.ok) {
    return { ok: false, reason: rpcResult.reason }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rpcResult.value)
  } catch {
    // callMarkerRpc 已检测过 JSON 合法性，此处为防御性兜底，保持判别完备
    return { ok: false, reason: 'non-json' }
  }
  if (!isScheduleFormResult(parsed)) {
    // JSON 合法但非本协议形状 = 协议版本错配类故障，按 non-json 同折叠
    options?.log?.('schedule-create response is not a ScheduleFormResult', {
      responseHead: rpcResult.value.slice(0, RESPONSE_PREVIEW_LENGTH),
    })
    return { ok: false, reason: 'non-json' }
  }
  return { ok: true, result: parsed }
}

/** 形状错留痕里回包预览的截断长度（与 callMarkerRpc 的 RESPONSE_PREVIEW_LENGTH 同规范） */
const RESPONSE_PREVIEW_LENGTH = 200

/**
 * 类型守卫：验证 unknown 是否为合法的 ScheduleDraft。
 * 用于 runtime event-adapter 判定 marker select 的 payload 是否为本协议 draft
 * （检测失败降级普通 select），以及前端从 runtime 透传值中安全收窄。
 * 字段白名单校验（与 isAskUserQuestion 同构）：可选字段校验类型，未知附加字段忽略。
 */
export function isScheduleDraft(value: unknown): value is ScheduleDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const d = value as Record<string, unknown>
  return (d.kind === 'once' || d.kind === 'recurring')
    && typeof d.schedule === 'string'
    && (d.model === undefined || typeof d.model === 'string')
    && typeof d.prompt === 'string'
    && (d.name === undefined || typeof d.name === 'string')
    && (d.expires === undefined || typeof d.expires === 'string')
    && Array.isArray(d.models)
    && d.models.every((m) => typeof m === 'string')
    && (d.currentModel === undefined || typeof d.currentModel === 'string')
}

/** 回传形状守卫（模块内消费：scheduleCreateInteract 收窄 parsed 回包） */
function isScheduleFormResult(value: unknown): value is ScheduleFormResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return r.action === 'create'
    && (r.kind === 'once' || r.kind === 'recurring')
    && typeof r.schedule === 'string'
    && (r.model === undefined || typeof r.model === 'string')
    && typeof r.prompt === 'string'
    && (r.name === undefined || typeof r.name === 'string')
    && (r.expires === undefined || typeof r.expires === 'string')
}

// ── 时间折叠单点（D2）：一次性时刻 ↔ 一次性 cron ──

/**
 * 本地墙钟时刻 → 一次性 cron（5 段 `分 时 日 月 *`）。
 *
 * 一次性 cron 语义：具体日 + 具体月 + 星期通配 → croner 天然只命中一次（S8/D2），
 * scheduler 现有 parseSchedule 直接接受，service 层零感知。
 */
export function dateToOnceCron(date: Date): string {
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
}

// 一次性 cron 固定 5 段（分 时 日 月 *），第 5 段为星期通配符
const ONCE_CRON_FIELD_COUNT = 5
// cron 各字段合法上/下界（分/时/日/月，与 croner 的标准 cron 语义一致）
const CRON_MINUTE_MAX = 59
const CRON_HOUR_MAX = 23
const CRON_DAY_MIN = 1
const CRON_DAY_MAX = 31
const CRON_MONTH_MIN = 1
const CRON_MONTH_MAX = 12
// 年份顺延上界：覆盖闰年周期（4 年）与 2100 类非闰世纪年跳变
const ONCE_CRON_MAX_YEAR_LOOKAHEAD = 8

/**
 * 一次性 cron（5 段 `分 时 日 月 *`）→ 本地墙钟时刻。
 *
 * cron 不含年份，还原为「下一次发生的该时刻」：以 now 为基准取当年，当年已过
 * 或该年不存在此日（如非闰年的 2/29——Date 构造对越界日静默滚动，解构回验字段
 * 一致性即「该年存在此日」判定）则向后顺延年份（至多 ONCE_CRON_MAX_YEAR_LOOKAHEAD
 * 年，覆盖闰年周期与 2100 类非闰世纪年跳变），供表单时间初值还原。
 *
 * 非 5 段 / 星期位非 * / 数字段含非数字或越界（分 0-59 / 时 0-23 / 日 1-31 /
 * 月 1-12）→ null（循环 cron 等非一次性形态不做时刻还原）。
 */
export function onceCronToDate(cron: string, now: Date = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== ONCE_CRON_FIELD_COUNT || parts[4] !== '*') return null
  const [minute, hour, day, month] = parts
  if (
    !/^\d+$/.test(minute) || !/^\d+$/.test(hour) ||
    !/^\d+$/.test(day) || !/^\d+$/.test(month)
  ) {
    return null
  }
  const m = Number(minute)
  const h = Number(hour)
  const d = Number(day)
  const mon = Number(month)
  if (
    m > CRON_MINUTE_MAX || h > CRON_HOUR_MAX ||
    d < CRON_DAY_MIN || d > CRON_DAY_MAX ||
    mon < CRON_MONTH_MIN || mon > CRON_MONTH_MAX
  ) return null
  const startYear = now.getFullYear()
  for (let year = startYear; year <= startYear + ONCE_CRON_MAX_YEAR_LOOKAHEAD; year++) {
    const candidate = new Date(year, mon - 1, d, h, m, 0, 0)
    if (candidate.getMonth() !== mon - 1 || candidate.getDate() !== d) continue
    if (candidate.getTime() >= now.getTime()) return candidate
  }
  return null
}
