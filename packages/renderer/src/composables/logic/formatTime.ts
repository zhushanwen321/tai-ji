/**
 * 相对时间格式化（R2 logic 层，纯函数无副作用）。
 *
 * 规则：今天 HH:MM；昨天「昨天」；7 天内「N 天前」；更早「M 月 D 日」。
 * 复用点：SessionItem（sidebar）+ SessionCard（Overview）——同一信息原子、同一呈现。
 */
import i18n from '@/i18n'

const t = i18n.global.t

/** 1 天毫秒数（相对时间分桶阈值） */
const ONE_DAY = 86_400_000
/** 7 天内显「N 天前」上限（更早落「M 月 D 日」绝对日期） */
const RECENT_DAYS_LIMIT = 7
/** 时分补零宽度 */
const PAD_WIDTH = 2

/**
 * 把毫秒时间戳格式化为相对时间文案。
 * @param ts 毫秒时间戳
 */
export function formatRelativeTime(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const sameDay = now.toDateString() === date.toDateString()
  if (sameDay) {
    const h = String(date.getHours()).padStart(PAD_WIDTH, '0')
    const m = String(date.getMinutes()).padStart(PAD_WIDTH, '0')
    return `${h}:${m}`
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (yesterday.toDateString() === date.toDateString()) return t('composable.yesterday')
  const days = Math.floor((now.getTime() - ts) / ONE_DAY)
  if (days < RECENT_DAYS_LIMIT) return t('composable.daysAgo', { days })
  return t('composable.dateFormat', { month: date.getMonth() + 1, day: date.getDate() })
}
