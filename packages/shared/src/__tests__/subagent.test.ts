// shared SubagentRecord 契约面测试（U8 / 永久会话模型 §3.2.8；[U6] 两态收窄重写）：
//   - SUBAGENT_STATUS_ALL 全集 = 两态（B3 编译锁的运行时镜像——编译锁拦「联合扩值
//     漏改元组」，本测试拦「元组值域与联合语义漂移」的回归方向）；
//   - deriveClosedDisplay 既有三分色不回归（U6 起消费方迁至 runtime 归一层，作为
//     closed → stopReason 派生映射的推导器）。

import { describe, expect, it } from 'vitest'

import {
  SUBAGENT_STATUS_ALL,
  deriveClosedDisplay,
  type SubagentStatus,
} from '../subagent'

describe('SUBAGENT_STATUS_ALL 全集（B3 运行时镜像）', () => {
  it('两态收窄终态：全集恰为 running + idle（legacy 值已从类型面删除，U6）', () => {
    expect(SUBAGENT_STATUS_ALL).toEqual(['running', 'idle'])
  })

  it('全集无重复', () => {
    expect(new Set(SUBAGENT_STATUS_ALL).size).toBe(SUBAGENT_STATUS_ALL.length)
  })

  it('类型面：SubagentStatus 两态词表外无成员（编译期收窄的运行时镜像断言）', () => {
    const all: readonly SubagentStatus[] = ['running', 'idle']
    expect(all).toEqual([...SUBAGENT_STATUS_ALL])
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
