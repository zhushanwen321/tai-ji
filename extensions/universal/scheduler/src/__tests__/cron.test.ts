// src/__tests__/cron.test.ts
//
// Cron 执行路径测试（M10a）。
// parsing.test.ts 现有测试只覆盖 duration/interval 路径，未覆盖 cron 分支。
// 此文件集中测 cron 相关导出：normalizeCronExpression / computeNextCronRunAt /
// computeNextCronRuns / parseSchedule(cron) / computeNextRuns(cron)。
//
// croner 是 dependencies + 静态 import（ext-simplify-08 D2），解析链同步化，
// cron 路径在此真实执行（无需 mock）。

import { describe, expect, it } from 'vitest'

import {
  computeNextCronRunAt,
  computeNextCronRuns,
  computeNextRuns,
  normalizeCronExpression,
  parseSchedule,
} from '../parsing.js'

describe('computeNextCronRunAt', () => {
  it('返回有效时间戳（> Date.now()）', async () => {
    const now = Date.now()
    const next = await computeNextCronRunAt('*/10 * * * *')
    expect(next).not.toBeUndefined()
    expect(next!).toBeGreaterThan(now)
  })

  it('非法表达式返回 undefined', async () => {
    const next = await computeNextCronRunAt('invalid expr')
    expect(next).toBeUndefined()
  })
})

describe('computeNextCronRuns', () => {
  it('返回 count 个递增时间戳', async () => {
    const from = Date.now()
    const runs = await computeNextCronRuns('*/10 * * * *', from, 3)
    expect(runs).toHaveLength(3)
    // 严格递增
    expect(runs[0]).toBeLessThan(runs[1]!)
    expect(runs[1]).toBeLessThan(runs[2]!)
    // 第一个应晚于 from
    expect(runs[0]).toBeGreaterThan(from)
  })

  it('每两次执行间隔约 10 分钟（600000ms ± 容差）', async () => {
    const from = Date.now()
    const runs = await computeNextCronRuns('*/10 * * * *', from, 3)
    const gap1 = runs[1]! - runs[0]!
    const gap2 = runs[2]! - runs[1]!
    // 10 分钟 = 600000ms，允许 ±2s 容差（cron 表达式按分钟边界对齐，间隔精确 10min）
    expect(gap1).toBeGreaterThanOrEqual(600000 - 2000)
    expect(gap1).toBeLessThanOrEqual(600000 + 2000)
    expect(gap2).toBeGreaterThanOrEqual(600000 - 2000)
    expect(gap2).toBeLessThanOrEqual(600000 + 2000)
  })
})

describe('parseSchedule (cron 分支)', () => {
  it('5 字段 cron 表达式补秒字段', async () => {
    const result = await parseSchedule('*/10 * * * *')
    expect(result).toEqual({ mode: 'cron', cronExpression: '0 */10 * * * *' })
  })

  it('工作日 9 点 cron 表达式返回 cron mode', async () => {
    const result = await parseSchedule('0 9 * * 1-5')
    expect(result).toBeDefined()
    expect(result!.mode).toBe('cron')
    expect(result!).toEqual({ mode: 'cron', cronExpression: '0 0 9 * * 1-5' })
  })

  it('含空格但非法的表达式返回 undefined', async () => {
    const result = await parseSchedule('invalid cron expr here')
    expect(result).toBeUndefined()
  })

  it('非法分钟值（99）返回 undefined（croner 拒绝）', async () => {
    const result = await parseSchedule('99 * * * *')
    expect(result).toBeUndefined()
  })
})

describe('normalizeCronExpression', () => {
  it('6 字段 cron 原样返回', () => {
    expect(normalizeCronExpression('0 9 * * 1-5 0')).toBe('0 9 * * 1-5 0')
  })

  it('2 字段返回 undefined', () => {
    expect(normalizeCronExpression('0 9')).toBeUndefined()
  })
})

describe('computeNextRuns (cron mode)', () => {
  it('返回 count 个递增时间戳', async () => {
    const from = Date.now()
    const spec = { mode: 'cron' as const, cronExpression: '*/10 * * * *' }
    const runs = await computeNextRuns(spec, from, 2)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toBeLessThan(runs[1]!)
    expect(runs[0]).toBeGreaterThan(from)
  })
})
