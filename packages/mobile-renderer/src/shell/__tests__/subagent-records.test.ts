// subagent 记录分区（remote-use A9 / U15；D5 去留表 onSubagents 行）。
//
// 锁定两个验收条款：
//   1. onSubagents 消息写分区、读口按判据过滤——bootstrap effects.onSubagents 直挂
//      applySubagentRecords（写 per-session Map 分区，不可变替换）→ 读口消费
//      （idle 不计、轮收条已写（stopReason 在场）不计；runningSubagentRecordsOf 供
//      RunBand/ActivityScreen 计数，hasRunningSubagents 供 SessionsScreen working 态）。
//      呈现面断言在 features/__tests__/run-band.test.ts（M-10 升级后消费方）。
//   2. 接线位在壳扩展层非 factory 内——effects.onSubagents 与分区模块导出
//      applySubagentRecords 同源（直挂）；core lifecycle factory 产物不含 onSubagents
//      （factory 不含 subagent 语义，D5 去留表口径的机器断言）。
//
// 写分区语义 = 桌面 stores/subagent.ts applyRecords 的最小子集（分区范式：不可变整 Map 替换；
// 推送是权威数据，空数组照写——对齐桌面推送路径不经 strike 检查）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/shell/__tests__/subagent-records.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import {
  applySubagentRecords,
  hasRunningSubagents,
  runningSubagentRecordsOf,
  __testing as subagentRecordsTesting,
} from '../subagent-records'
import { __testing } from '../../bootstrap'
import { createLifecycleEffects } from '@taiji/core'
import { chatStore, sessionStore } from '../app-runtime'
import type { SubagentRecord } from '@taiji/shared'

function record(overrides: Partial<SubagentRecord> & { subagentId: string }): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'general-purpose',
    slug: '',
    task: 'demo task',
    status: 'idle',
    ...overrides,
  }
}

describe('subagent 记录分区（A9/U15）', () => {
  beforeEach(() => {
    // 模块级分区单例跨用例残留清零（__testing 先例：仅测试消费）
    subagentRecordsTesting.resetSubagentPartitionsForTest()
  })

  it('onSubagents 消息经壳 effects 写分区：推送后读口可见（全链路：回调 → 分区 → 读口）', () => {
    __testing.shellEffects.onSubagents?.('sid-live', [
      record({ subagentId: 'bg-1', slug: 'reviewer', status: 'running' }),
    ])

    expect(hasRunningSubagents('sid-live')).toBe(true)
    expect(runningSubagentRecordsOf('sid-live').map((r) => r.slug)).toEqual(['reviewer'])
  })

  it('推送是权威数据：同 sid 二次推送整体替换（跑完翻 idle → running 读口清空）', () => {
    applySubagentRecords('sid-replace', [
      record({ subagentId: 'bg-1', slug: 'worker', status: 'running' }),
    ])
    expect(runningSubagentRecordsOf('sid-replace')).toHaveLength(1)

    applySubagentRecords('sid-replace', [
      record({ subagentId: 'bg-1', slug: 'worker', status: 'idle', stopReason: 'completed' }),
    ])
    expect(runningSubagentRecordsOf('sid-replace')).toEqual([])
    expect(hasRunningSubagents('sid-replace')).toBe(false)
  })

  it('running 过滤：idle 记录不计入运行汇总（占用判据 = running 且无 stopReason）', () => {
    applySubagentRecords('sid-filter', [
      record({ subagentId: 'bg-1', slug: 'runner', status: 'running' }),
      record({ subagentId: 'bg-2', slug: 'finished', status: 'idle', stopReason: 'completed' }),
    ])

    const running = runningSubagentRecordsOf('sid-filter')
    expect(running.map((r) => r.slug)).toEqual(['runner'])
    expect(running.map((r) => r.slug)).not.toContain('finished')
  })

  it('轮收条已写（stopReason 在场）不算在跑（[subagent-observability §3.3.3⑦] 占用信号语义）；空数组推送同样非运行', () => {
    applySubagentRecords('sid-dead-running', [
      record({ subagentId: 'bg-1', slug: 'adopted', status: 'running', stopReason: 'failed' }),
    ])
    expect(hasRunningSubagents('sid-dead-running')).toBe(false)

    // 空数组推送（无 subagent 会话）同样非运行
    applySubagentRecords('sid-empty', [])
    expect(hasRunningSubagents('sid-empty')).toBe(false)
  })

  it('分区隔离：不同 session 各读各的分区', () => {
    applySubagentRecords('sid-a', [
      record({ subagentId: 'bg-1', slug: 'alpha', status: 'running' }),
    ])
    expect(hasRunningSubagents('sid-a')).toBe(true)
    expect(hasRunningSubagents('sid-b')).toBe(false)

    applySubagentRecords('sid-b', [
      record({ subagentId: 'bg-2', slug: 'beta', status: 'running' }),
    ])
    expect(runningSubagentRecordsOf('sid-b').map((r) => r.slug)).toEqual(['beta'])
    expect(runningSubagentRecordsOf('sid-a').map((r) => r.slug)).toEqual(['alpha'])
  })

  it('接线位在壳扩展层非 factory 内：effects.onSubagents 与分区模块导出同源直挂；factory 产物无 onSubagents', () => {
    // 直挂断言：bootstrap 壳 effects 的 onSubagents 就是分区模块导出的写入口（非包装非转接）
    expect(__testing.shellEffects.onSubagents).toBe(applySubagentRecords)

    // factory 不含 subagent 语义（D5 去留表）：createLifecycleEffects 产物键集无 onSubagents
    const factoryEffects = createLifecycleEffects(
      { chat: chatStore, session: sessionStore },
      { restored: 'r', restoreFailed: 'f' },
    )
    expect(Object.keys(factoryEffects)).not.toContain('onSubagents')
  })
})
