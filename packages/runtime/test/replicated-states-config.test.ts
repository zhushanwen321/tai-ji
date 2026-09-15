/**
 * replicated-states.config 快照投影定向测试（CRAP 靶子：projectSessionScalars /
 * fetchSnapshot(usage)）。
 *
 * 等价性测试（src/__tests__/equivalence/）覆盖实例接线与收敛链路（喂正常形态）；
 * 本文件专测 wire 投影层的畸形输入分级——协议异常（抛 WireSnapshotSchemaError →
 * 快照失败退避）与合法无值（{} 空快照 → merge 保持旧值）两类语义不得混淆：
 * - get_state 返回非对象 → 抛（协议异常）
 * - thinkingLevel/model 字段类型畸形 → 丢 key（'required' 归一后同样走协议异常）
 * - model.provider / model.id 空串 → 不组合出 '/x' 碎片 modelId
 * - get_session_stats 非对象 / contextUsage 缺失 → 抛；tokens=null → {}（compact 后
 *   合法无值）；percent 缺省 0 / 越界 clamp 100；contextWindow 畸形 → 0
 * - get_commands 非数组 → 抛
 *
 * 运行：cd packages/runtime && npx vitest run test/replicated-states-config.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  createCommandsStateConfig,
  createModelIdStateConfig,
  createThinkingLevelStateConfig,
  createUsageStateConfig,
} from '../src/services/session/replicated-states.config.js'
import { WireSnapshotSchemaError, normalizeWireSnapshot } from '../src/services/session/replicated-state.js'

describe('projectSessionScalars（get_state wire 投影，经 thinkingLevel/modelId 条目）', () => {
  const cfg = (state: unknown) =>
    createThinkingLevelStateConfig(() => Promise.resolve(state as Record<string, unknown> | undefined))

  it('state 非对象（undefined / null / string / number）→ 抛 WireSnapshotSchemaError（协议异常→退避）', async () => {
    for (const bad of [undefined, null, 'oops', 42]) {
      await expect(cfg(bad).fetchSnapshot()).rejects.toBeInstanceOf(WireSnapshotSchemaError)
    }
  })

  it('thinkingLevel 非 string → 丢 key → fetchSnapshot 空快照 + required 归一层抛协议异常', async () => {
    // fetchSnapshot 层职责：类型畸形丢 key（wire 归一前的投影，不做语义决策）
    await expect(cfg({ thinkingLevel: 7 }).fetchSnapshot()).resolves.toEqual({})
    await expect(cfg({}).fetchSnapshot()).resolves.toEqual({})
    // required 归一层职责：key 缺失 = 协议异常（ReplicatedState 按快照失败退避，不当字段不动）
    expect(() => normalizeWireSnapshot({}, { thinkingLevel: 'required' })).toThrow(WireSnapshotSchemaError)
  })

  it('thinkingLevel 合法 string → 快照透传', async () => {
    await expect(cfg({ thinkingLevel: 'high' }).fetchSnapshot()).resolves.toEqual({ thinkingLevel: 'high' })
  })
})

describe('projectSessionScalars：model 组合投影（modelId 条目）', () => {
  const cfg = (state: unknown) =>
    createModelIdStateConfig(() => Promise.resolve(state as Record<string, unknown> | undefined))

  it('model 对象 provider/id 均非空 string → 组合 provider/id', async () => {
    await expect(cfg({ model: { provider: 'test-provider', id: 'mimo' } }).fetchSnapshot())
      .resolves.toEqual({ modelId: 'test-provider/mimo' })
  })

  it('model 缺失 / 非对象 / 字段畸形 / 空串 → 不产 modelId（碎片不落 wire）+ required 归一层抛', async () => {
    for (const bad of [
      {}, // 无 model
      { model: 'not-object' },
      { model: null },
      { model: { provider: '', id: 'mimo' } }, // provider 空串：碎片 '/mimo' 不落 wire
      { model: { provider: 'p', id: '' } },
      { model: { provider: 1, id: 'mimo' } },
    ]) {
      await expect(cfg(bad).fetchSnapshot()).resolves.toEqual({})
    }
    expect(() => normalizeWireSnapshot({}, { modelId: 'required' })).toThrow(WireSnapshotSchemaError)
  })
})

describe('usage fetchSnapshot（get_session_stats contextUsage 投影）', () => {
  const cfg = (stats: unknown) =>
    createUsageStateConfig(() => Promise.resolve(stats as Record<string, unknown> | undefined))

  it('stats 非对象 / contextUsage 缺失或非对象 → 抛 WireSnapshotSchemaError（协议异常）', async () => {
    for (const bad of [undefined, null, 'x', { contextUsage: null }, { contextUsage: 'gone' }]) {
      await expect(cfg(bad).fetchSnapshot()).rejects.toBeInstanceOf(WireSnapshotSchemaError)
    }
  })

  it('tokens 非 number（null = pi compact 后无新 turn）→ 空快照 {}（合法无值，merge 保持旧值）', async () => {
    await expect(cfg({ contextUsage: { tokens: null } }).fetchSnapshot()).resolves.toEqual({})
    await expect(cfg({ contextUsage: {} }).fetchSnapshot()).resolves.toEqual({})
  })

  it('正常投影：tokens / contextWindow / percent 三字段（percent 缺省 0）', async () => {
    await expect(cfg({ contextUsage: { tokens: 1000, contextWindow: 10000, percent: 10 } }).fetchSnapshot())
      .resolves.toEqual({ inputTokens: 1000, contextLimit: 10000, usagePercent: 10 })
    await expect(cfg({ contextUsage: { tokens: 500, contextWindow: 8000 } }).fetchSnapshot())
      .resolves.toEqual({ inputTokens: 500, contextLimit: 8000, usagePercent: 0 })
  })

  it('percent 越界 clamp 100；contextWindow 非 number → 0（投影口径对齐 fetchContext）', async () => {
    await expect(cfg({ contextUsage: { tokens: 100, contextWindow: 200, percent: 250 } }).fetchSnapshot())
      .resolves.toEqual({ inputTokens: 100, contextLimit: 200, usagePercent: 100 })
    await expect(cfg({ contextUsage: { tokens: 100, contextWindow: 'big', percent: 3.6 } }).fetchSnapshot())
      .resolves.toEqual({ inputTokens: 100, contextLimit: 0, usagePercent: 4 })
  })
})

describe('commands fetchSnapshot（get_commands 数组包装）', () => {
  const cfg = (result: unknown) => createCommandsStateConfig(() => Promise.resolve(result))

  it('非数组返回（null / object / string）→ 抛 WireSnapshotSchemaError', async () => {
    for (const bad of [null, { commands: [] }, 'x']) {
      await expect(cfg(bad).fetchSnapshot()).rejects.toBeInstanceOf(WireSnapshotSchemaError)
    }
  })

  it('数组（含空数组）→ 包装 { commands }（空数组是合法态，整字段覆盖语义）', async () => {
    await expect(cfg([]).fetchSnapshot()).resolves.toEqual({ commands: [] })
    await expect(cfg([{ name: 'a' }, { name: 'b' }]).fetchSnapshot())
      .resolves.toEqual({ commands: [{ name: 'a' }, { name: 'b' }] })
  })
})
