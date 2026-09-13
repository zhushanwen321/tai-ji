// shared SubagentRecord 契约面测试（U8 / 永久会话模型 §3.2.8）：
//   - SUBAGENT_STATUS_ALL 全集含两态新词 idle（B3 编译锁的运行时镜像——编译锁拦
//     「联合扩值漏改元组」，本测试拦「元组值域与联合语义漂移」的回归方向）；
//   - projectSubagentExecutionStatus 旧六值 → 新两态映射（S8 旧数据只读兼容）；
//   - deriveClosedDisplay 既有三分色不回归（idle 扩值后 legacy 展示派生面不动）。

import { describe, expect, it } from 'vitest'

import {
  SUBAGENT_STATUS_ALL,
  deriveClosedDisplay,
  projectSubagentExecutionStatus,
  type SubagentStatus,
} from '../subagent'

describe('SUBAGENT_STATUS_ALL 全集（B3 运行时镜像）', () => {
  it('含两态新词 idle + legacy 六值（顺序：新词在前，legacy 随后）', () => {
    expect(SUBAGENT_STATUS_ALL).toEqual([
      'running',
      'idle',
      'done',
      'failed',
      'cancelled',
      'crashed',
      'closed',
    ])
  })

  it('全集无重复', () => {
    expect(new Set(SUBAGENT_STATUS_ALL).size).toBe(SUBAGENT_STATUS_ALL.length)
  })
})

describe('projectSubagentExecutionStatus（旧六值 → 新两态，S8 旧数据只读兼容）', () => {
  it('running → running（唯一「正在跑」形态）', () => {
    expect(projectSubagentExecutionStatus('running')).toBe('running')
  })

  it('idle 与 legacy 终态五值全部 → idle（不复活 spinner / 活跃计数）', () => {
    const settled: readonly SubagentStatus[] = ['idle', 'done', 'failed', 'cancelled', 'crashed', 'closed']
    for (const status of settled) {
      expect(projectSubagentExecutionStatus(status), status).toBe('idle')
    }
  })

  it('全集覆盖矩阵：SUBAGENT_STATUS_ALL 每值映射后必为两态之一', () => {
    for (const status of SUBAGENT_STATUS_ALL) {
      const mapped = projectSubagentExecutionStatus(status)
      expect(mapped === 'running' || mapped === 'idle', status).toBe(true)
    }
  })
})

describe('deriveClosedDisplay（legacy 终态三分色，扩值不回归）', () => {
  it('cancelled 优先 / gc+error → failed / 其余 → done', () => {
    expect(deriveClosedDisplay({ closedReason: 'cancelled', error: 'boom' })).toBe('cancelled')
    expect(deriveClosedDisplay({ closedReason: 'gc', error: 'boom' })).toBe('failed')
    expect(deriveClosedDisplay({ closedReason: 'gc' })).toBe('done')
    expect(deriveClosedDisplay({})).toBe('done')
  })
})
