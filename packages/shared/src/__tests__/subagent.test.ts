// shared SubagentRecord 契约范围测试（U8 / 永久会话模型 §3.2.8；[U6] 两态收窄重写）：
//   - SUBAGENT_STATUS_ALL 全集 = 两态（B3 编译锁的运行时镜像——编译锁拦「联合扩值
//     漏改元组」，本测试拦「元组值域与联合语义漂移」的回归方向）；
//   - deriveClosedDisplay 既有三分色不回归（U6 起消费方迁至 runtime 归一层，作为
//     closed → stopReason 派生映射的推导器）；
//   - [W1 / D1] subagent-record v2 条目契约镜像（注册/终态两条小条目）：shared 侧
//     形状断言 + JSON round-trip——core 侧权威定义（record-entry.ts）与 shared 镜像
//     的同构漂移由本测试 + core record-entry-collect.test.ts 双侧互证把守。

import { describe, expect, it } from 'vitest'

import {
  SUBAGENT_STATUS_ALL,
  deriveClosedDisplay,
  type FailureCause,
  type SubagentLastRound,
  type SubagentRecord,
  type SubagentStatus,
} from '../subagent'

describe('SUBAGENT_STATUS_ALL 全集（B3 运行时镜像）', () => {
  it('两态收窄终态：全集恰为 running + idle（legacy 值已从类型范围删除，U6）', () => {
    expect(SUBAGENT_STATUS_ALL).toEqual(['running', 'idle'])
  })

  it('全集无重复', () => {
    expect(new Set(SUBAGENT_STATUS_ALL).size).toBe(SUBAGENT_STATUS_ALL.length)
  })

  it('类型范围：SubagentStatus 两态词表外无成员（编译期收窄的运行时镜像断言）', () => {
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

// ── [subagent-observability §3.3.3⑤(c) / plan-review F4] lastRound wire 契约 ──

describe('SubagentRecord.lastRound wire 契约（u-foundation F4——字段存在性 + re-export 类型可达）', () => {
  it('lastRound 字段在 shared 契约上可达（消费方数据自 shared 类型导出，防 mock 自造字段假绿）', () => {
    // 类型层验证：lastRound?: SubagentLastRound 在 SubagentRecord 上（编译期承载，
    // 运行时构造一次完整载荷证明形状可满足）。
    const lastRound: SubagentLastRound = {
      engineStopReason: 'error',
      failure: {
        class: 'provider',
        kind: 'rate_limited',
        retryable: 'conditional',
        retryAfterMs: 60_000,
        raw: '429: tier_limit_exceeded resets 18:00',
      },
      promptDisposition: 'handled',
      result: '',
      turns: 3,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0 },
      retryAttempts: 1,
      observations: ['deliverable predicate not satisfied'],
    }
    const record: SubagentRecord = {
      subagentId: 'bg-x',
      sessionFile: null,
      agent: 'general-purpose',
      slug: 'x',
      task: 't',
      status: 'idle',
      lastRound,
    }
    // wire 往返保真（跨进程载荷逐字序列化）。
    const wire = JSON.parse(JSON.stringify(record)) as SubagentRecord
    expect(wire.lastRound?.engineStopReason).toBe('error')
    expect(wire.lastRound?.failure?.class).toBe('provider')
    expect(wire.lastRound?.failure?.kind).toBe('rate_limited')
  })

  it('FailureCause 类型自 shared re-export 可达（sdk 权威的 type-only 通道——renderer 红点判据数据源）', () => {
    // 红点判据（红 = lastRound.failure 非空且非 user.cancelled）的判别输入形态：
    // failure 存在 + kind !== 'cancelled'。判据经函数形参表达——判据消费的 wire
    // 值是全类联合，字面常量会被 TS 按 class 判别立即收窄、对 provider 类产生
    // 无重叠误报。
    const isRedOf = (failure: FailureCause | undefined): boolean =>
      failure !== undefined && failure.kind !== 'cancelled'
    const userCancel: FailureCause = { class: 'user', kind: 'cancelled', retryable: false, raw: 'cancel' }
    expect(isRedOf(userCancel)).toBe(false)
    const providerFailure: FailureCause = {
      class: 'provider',
      kind: 'rate_limited',
      retryable: true,
      raw: 'r',
    }
    expect(isRedOf(providerFailure)).toBe(true)
  })

  it('被接管轮形态：engineStopReason 无值 + promptDisposition=handled + 无 failure（§3.3.1 第三形态的契约承载）', () => {
    const takenOver: SubagentLastRound = { promptDisposition: 'handled', result: '' }
    expect(takenOver.engineStopReason).toBeUndefined()
    expect(takenOver.failure).toBeUndefined()
    expect(takenOver.promptDisposition).toBe('handled')
  })
})

