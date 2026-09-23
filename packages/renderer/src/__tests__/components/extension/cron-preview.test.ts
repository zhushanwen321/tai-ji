/**
 * cron-preview.ts 纯函数单测（R1 评审补：段解析步进/周域英文名/非法分支此前零测试，
 * 预览引擎是 ScheduleForm 预览行唯一数据源）。
 *
 * cronNextRuns = 分钟步进穷举（上界 366 天）；解析是后端 croner 子集，本测试锁定
 * 前端子集语义：星形斜杠 n 步进、周域 MON-FRI 英文名归一、非法段返回 null（调用方降级提示）。
 */
import { describe, it, expect } from 'vitest'
import { cronNextRuns, parseDurationMs, PREVIEW_RUN_COUNT } from '@/components/extension/form/cron-preview'

describe('cron-preview · 段解析分支', () => {
  it('*/5 步进段：命中分钟全部 5 的倍数，相邻两次运行差 5 分钟（addStepValues 填充分支）', () => {
    const from = new Date('2026-09-20T10:02:00')
    const runs = cronNextRuns('*/5 * * * *', PREVIEW_RUN_COUNT, from)
    expect(runs).not.toBeNull()
    expect(runs).toHaveLength(PREVIEW_RUN_COUNT)
    expect(runs![0].getMinutes() % 5).toBe(0)
    for (let i = 1; i < runs!.length; i++) {
      expect(runs![i].getTime() - runs![i - 1].getTime()).toBe(5 * 60_000)
    }
  })

  it('周域英文名 MON-FRI：归一为数字 1-5，运行时刻全部落在工作日 09:00（normalizeDowSegment）', () => {
    // 起点 = 周日：MON-FRI 的首个命中是周一 09:00
    const from = new Date('2026-09-20T00:00:00')
    const runs = cronNextRuns('0 9 * * MON-FRI', 10, from)
    expect(runs).not.toBeNull()
    for (const d of runs!) {
      expect(d.getHours()).toBe(9)
      expect(d.getMinutes()).toBe(0)
      expect(d.getDay()).toBeGreaterThanOrEqual(1)
      expect(d.getDay()).toBeLessThanOrEqual(5)
    }
  })

  it('非法段 → null（步进 <1 / 数值越界），调用方降级提示不抛错', () => {
    expect(cronNextRuns('*/0 * * * *', 3, new Date())).toBeNull()
    expect(cronNextRuns('99 99 * * *', 3, new Date())).toBeNull()
  })
})

describe('cron-preview · parseDurationMs', () => {
  it('m/h/d/w 四单位换算 + 非法形态 null', () => {
    expect(parseDurationMs('90m')).toBe(90 * 60_000)
    expect(parseDurationMs('2h')).toBe(2 * 3_600_000)
    expect(parseDurationMs('3d')).toBe(3 * 86_400_000)
    expect(parseDurationMs('1w')).toBe(7 * 86_400_000)
    expect(parseDurationMs('bogus')).toBeNull()
    expect(parseDurationMs('')).toBeNull()
    expect(parseDurationMs('5x')).toBeNull()
  })
})
