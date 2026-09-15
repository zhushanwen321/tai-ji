/**
 * 额度查询时间相对格式化（S-16 从 CodingPlanSection.vue 提取为纯函数，边界可测）：
 * 秒/分/时/天四档阈值边界（59/60s、59/60min、23/24h）决定展示文案，提取动机即
 * 「四点断言不进组件挂载就能锁定」。
 */

export const MS_PER_SEC = 1000
export const SEC_PER_MIN = 60
export const MIN_PER_HOUR = 60
export const HOUR_PER_DAY = 24

/** i18n 文案的最小接口（组件侧传 vue-i18n 的 t，测试传 stub）。 */
type Translate = (key: string, params: { n: number }) => string

/**
 * 格式化时间戳为相对时间。
 * @param ts 目标时间戳（ms）
 * @param nowMs 当前时刻（ms，依赖注入替代 Date.now 直读）
 * @param t 文案函数（key 形态：settings.providerEdit.quotaTimeAgo{Seconds,Minutes,Hours,Days}）
 */
export function formatQuotaTimeAgo(ts: number, nowMs: number, t: Translate): string {
  const diff = nowMs - ts
  const sec = Math.floor(diff / MS_PER_SEC)
  if (sec < SEC_PER_MIN) return t('settings.providerEdit.quotaTimeAgoSeconds', { n: sec })
  const min = Math.floor(sec / SEC_PER_MIN)
  if (min < MIN_PER_HOUR) return t('settings.providerEdit.quotaTimeAgoMinutes', { n: min })
  const hr = Math.floor(min / MIN_PER_HOUR)
  if (hr < HOUR_PER_DAY) return t('settings.providerEdit.quotaTimeAgoHours', { n: hr })
  const day = Math.floor(hr / HOUR_PER_DAY)
  return t('settings.providerEdit.quotaTimeAgoDays', { n: day })
}
