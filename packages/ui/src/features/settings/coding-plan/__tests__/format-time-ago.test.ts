/**
 * formatQuotaTimeAgo 档位边界测试（S-16 补口）。
 *
 * 四档阈值边界（59/60min、23/24h 等）决定展示文案——分钟/小时的 `Math.floor(sec/60)`
 * 在边界值的档位漂移（59min 显示成「1 小时前」之类）此前无回归捕捉。
 *
 * 运行：cd packages/ui && npx vitest run src/features/settings/coding-plan/__tests__/format-time-ago.test.ts
 */
import { describe, it, expect } from 'vitest'
import { formatQuotaTimeAgo, MS_PER_SEC, SEC_PER_MIN, MIN_PER_HOUR, HOUR_PER_DAY } from '../format-time-ago'

const NOW = 1_000_000_000_000

/** stub 文案：把 key + n 压成可断言字符串。 */
const t = (key: string, { n }: { n: number }): string => `${key}|${n}`

function ago(seconds: number): number {
  return NOW - seconds * MS_PER_SEC
}

function fmt(seconds: number): string {
  return formatQuotaTimeAgo(ago(seconds), NOW, t)
}

describe('formatQuotaTimeAgo 档位边界', () => {
  it('59/60min 边界：59min → Minutes(59)，60min → Hours(1)', () => {
    const min = SEC_PER_MIN
    expect(fmt(59 * min)).toBe('settings.providerEdit.quotaTimeAgoMinutes|59')
    expect(fmt(60 * min)).toBe('settings.providerEdit.quotaTimeAgoHours|1')
  })

  it('23/24h 边界：23h → Hours(23)，24h → Days(1)', () => {
    const hourSec = MIN_PER_HOUR * SEC_PER_MIN
    expect(fmt(23 * hourSec)).toBe('settings.providerEdit.quotaTimeAgoHours|23')
    expect(fmt(24 * hourSec)).toBe('settings.providerEdit.quotaTimeAgoDays|1')
  })

  it('59/60s 边界：59s → Seconds(59)，60s → Minutes(1)', () => {
    expect(fmt(59)).toBe('settings.providerEdit.quotaTimeAgoSeconds|59')
    expect(fmt(60)).toBe('settings.providerEdit.quotaTimeAgoMinutes|1')
  })

  it('多天形态：1439min → Hours(23)，1440min → Days(1)，72h → Days 向下取整(3)', () => {
    const s = (m: number) => m * SEC_PER_MIN
    expect(fmt(s(1439))).toBe('settings.providerEdit.quotaTimeAgoHours|23')
    expect(fmt(s(1440))).toBe('settings.providerEdit.quotaTimeAgoDays|1')
    expect(fmt(s(3 * 1440))).toBe('settings.providerEdit.quotaTimeAgoDays|3')
  })

  it('常量导出与组件原值一致（换算基准防漂移）', () => {
    expect(MS_PER_SEC).toBe(1000)
    expect(SEC_PER_MIN).toBe(60)
    expect(MIN_PER_HOUR).toBe(60)
    expect(HOUR_PER_DAY).toBe(24)
  })
})
