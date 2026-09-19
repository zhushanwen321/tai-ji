import { describe, expect, it } from 'vitest'
import {
  formatRelativeTime,
  formatSchedule,
  replayFoldEntries,
  TASK_ENTRY_TYPE,
  type ScheduledTask,
  type SchedulerEntryOp,
} from '../../index'

// ── scheduler 折叠器下沉 smoke（P7 验收③：两个消费方都能从包入口取符号）──
// 包入口（barrel）必须可取到全部下沉符号；折叠行为在此只做最小冒烟
// （逐行为覆盖在扩展侧 replay.test.ts / format.test.ts，P7 判据 = 扩展全量测试不改断言仍绿）。

describe('包入口导出 scheduler 下沉符号（barrel smoke）', () => {
  it('entry 契约常量与折叠器/格式化器可从包入口导入', () => {
    expect(TASK_ENTRY_TYPE).toBe('pi-scheduler:task')
    expect(typeof replayFoldEntries).toBe('function')
    expect(typeof formatSchedule).toBe('function')
    expect(typeof formatRelativeTime).toBe('function')
  })

  it('replayFoldEntries 纯函数可独立折叠（零 pi 依赖自足成立）', () => {
    const op: SchedulerEntryOp = {
      op: 'upsert',
      taskId: 'a1b2c3d4',
      ownerSessionFile: '/s/a.jsonl',
      task: {
        id: 'a1b2c3d4',
        name: 'check-build',
        prompt: 'check build',
        kind: 'recurring',
        schedule: { mode: 'interval', intervalMs: 1_800_000 },
        enabled: true,
        createdAt: 0,
        nextRunAt: 1_800_000,
        runCount: 0,
        history: [],
      },
    }
    const entries = [
      { type: 'message', data: {} },
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: op },
    ]
    const tasks = replayFoldEntries(entries, '/s/a.jsonl')
    expect(tasks.size).toBe(1)
    const task: ScheduledTask | undefined = tasks.get('a1b2c3d4')
    expect(task?.name).toBe('check-build')
    expect(task?.ownerSessionFile).toBe('/s/a.jsonl')
  })

  it('formatSchedule / formatRelativeTime 输出形状（interval every / once in / 相对时间）', () => {
    expect(formatSchedule({ mode: 'interval', intervalMs: 1_800_000 }, 'recurring')).toBe('every 30m')
    expect(formatSchedule({ mode: 'interval', intervalMs: 300_000 }, 'once')).toBe('once in 5m')
    expect(formatSchedule({ mode: 'cron', cronExpression: '*/10 * * * *' })).toBe('*/10 * * * *')
    expect(formatRelativeTime(60_000, 0)).toBe('in 1m')
    expect(formatRelativeTime(-3_600_000, 0)).toBe('1h ago')
    expect(formatRelativeTime(1_000, 0)).toBe('now')
  })
})
