// @vitest-environment happy-dom

/**
 * useSubagentModel 单测（subagent-model-switch §7.1 入口层，U1 验收面——renderer 半边）。
 *
 * 覆盖（mock 宿主应答回执范式 + 标签读取规则四分支）：
 * - **禁乐观写**：api promise 未 resolve 前显示态零写入（应答到达才写状态）；
 * - 回执分流：chat 两型（effective → 生效值 / recorded → 覆盖意图）+ run 级聚合
 *   （switched → 成员生效值 / not-active·not-applicable → 成员覆盖意图 / 失败名单
 *   不写 + toast 分项）；
 * - 失败路径：RPC reject → 显示态零写入（标签读取规则分支③的构造性成立载体）+
 *   返回 undefined；
 * - resolveSubagentModelDisplay 四分支：① 回执生效值在场 → 实际生效值；④ 分叉态
 *   重载（无回执态 + 载荷最近生效值在场）→ 生效值承接、不回退覆盖意图值；② 已记账
 *   → 覆盖意图值 + 「用户覆盖中」标注；兜底 → 盖章值。
 *
 * 全 mock：@/api 门面 + vue-i18n + useToast（不发真实请求；单例回执态经
 * resetSubagentModelDisplayForTests 用例间隔离）。
 * 运行：cd packages/renderer && npx vitest run src/composables/features/subagent/__tests__/useSubagentModel.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock：@/api 门面（subagent.setModel 是唯一被消费的 RPC）────────────────
const apiMocks = vi.hoisted(() => ({ setModel: vi.fn() }))
vi.mock('@/api', () => ({ subagent: apiMocks }))

// ── mock：vue-i18n（t 回 key + params 序列化——文案断言用，登记归 i18n 文件）─
const i18nMocks = vi.hoisted(() => ({
  t: vi.fn((key: string, params?: Record<string, unknown>) => key + (params !== undefined ? ` ${JSON.stringify(params)}` : '')),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: i18nMocks.t }) }))

// ── mock：useToast（error spy——失败反馈断言面）────────────────────────────
const toastMocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ error: toastMocks.error }) }))

import {
  resolveSubagentModelDisplay,
  useSubagentModel,
  resetSubagentModelDisplayForTests,
} from '../useSubagentModel'

beforeEach(() => {
  apiMocks.setModel.mockReset()
  toastMocks.error.mockReset()
  resetSubagentModelDisplayForTests()
})

// ── 标签读取规则四分支（纯函数）────────────────────────────────────────────

describe('resolveSubagentModelDisplay — 标签读取规则四分支', () => {
  it('分支①：回执生效值在场 → 显示实际生效值（≠ 覆盖意图时如实显示生效值）', () => {
    const display = resolveSubagentModelDisplay({
      display: { effectiveModel: 'p/effective-sibling' },
      stampedModel: 'p/stamped',
      modelOverride: 'p/intent',
    })
    expect(display.label).toBe('p/effective-sibling')
    expect(display.overridden).toBe(true)
  })

  it('分支④：分叉态重载（回执态已丢 + 载荷最近生效值在场）→ 按最近生效值显示，不回退覆盖意图值', () => {
    const display = resolveSubagentModelDisplay({
      stampedModel: 'p/stamped',
      modelOverride: 'p/intent',
      recentEffectiveModel: { provider: 'p', modelId: 'recent-effective' },
    })
    expect(display.label).toBe('p/recent-effective')
    expect(display.overridden).toBe(true)
  })

  it('分支②：已记账型（无生效值源 + 覆盖意图在场）→ 覆盖意图值 + 「用户覆盖中」标注', () => {
    const display = resolveSubagentModelDisplay({
      stampedModel: 'p/stamped',
      modelOverride: 'p/intent',
    })
    expect(display.label).toBe('p/intent')
    expect(display.overridden).toBe(true)
  })

  it('兜底：从未切换（无回执态 / 无覆盖 / 无生效值）→ 盖章值、无标注（现状语义）', () => {
    const display = resolveSubagentModelDisplay({ stampedModel: 'p/stamped' })
    expect(display.label).toBe('p/stamped')
    expect(display.overridden).toBe(false)
  })

  it('回执生效值在场 + 无覆盖：生效值显示且无标注（显示口径 = 实际生效值）', () => {
    const display = resolveSubagentModelDisplay({
      display: { effectiveModel: 'p/effective' },
      stampedModel: 'p/stamped',
    })
    expect(display.label).toBe('p/effective')
    expect(display.overridden).toBe(false)
  })
})

// ── mock 宿主应答回执范式（应答到达才写状态，无乐观写）────────────────────

describe('useSubagentModel — 回执写状态（禁乐观写）', () => {
  it('api promise 未 resolve 前显示态零写入（禁乐观写断言）', async () => {
    let resolveRpc: (reply: unknown) => void = () => {}
    apiMocks.setModel.mockImplementation(
      () => new Promise((resolve) => { resolveRpc = resolve }),
    )
    const { setSubagentModel, displayOf } = useSubagentModel()

    const pending = setSubagentModel({ recordId: 'sa-1', provider: 'p', modelId: 'm' })
    // 请求已发出、应答未到：显示态必须为零写入（乐观写禁令）
    expect(displayOf('sa-1')).toBeUndefined()

    resolveRpc({ kind: 'effective', effectiveModel: { provider: 'p', modelId: 'm2' }, effectiveThinkingLevel: 'high' })
    await pending
    expect(displayOf('sa-1')).toEqual({ effectiveModel: 'p/m2' })
  })

  it('chat 已生效型：回读生效值写入（生效值 ≠ 请求目标时以回执为准）', async () => {
    apiMocks.setModel.mockResolvedValue({
      kind: 'effective',
      effectiveModel: { provider: 'p', modelId: 'sibling-model' },
      effectiveThinkingLevel: 'high',
    })
    const { setSubagentModel, displayOf } = useSubagentModel()

    await setSubagentModel({ recordId: 'sa-1', provider: 'p', modelId: 'requested' })

    expect(apiMocks.setModel).toHaveBeenCalledWith({ recordId: 'sa-1', provider: 'p', modelId: 'requested' })
    expect(displayOf('sa-1')?.effectiveModel).toBe('p/sibling-model')
    expect(displayOf('sa-1')?.overrideIntent).toBeUndefined()
  })

  it('chat 已记账型：覆盖意图写入（本次目标值，无档位值不虚构）', async () => {
    apiMocks.setModel.mockResolvedValue({ kind: 'recorded', note: '已记录，下次执行生效' })
    const { setSubagentModel, displayOf } = useSubagentModel()

    await setSubagentModel({ recordId: 'sa-1', provider: 'p', modelId: 'next-run-model' })

    expect(displayOf('sa-1')).toEqual({ overrideIntent: 'p/next-run-model' })
  })

  it('RPC 失败：显示态零写入（分支③构造性——错误应答不落状态）+ toast + undefined', async () => {
    apiMocks.setModel.mockRejectedValue(new Error('模型 X 缺少 API key，切换未生效，当前执行未受影响'))
    const { setSubagentModel, displayOf } = useSubagentModel()

    const result = await setSubagentModel({ recordId: 'sa-1', provider: 'p', modelId: 'm' })

    expect(result).toBeUndefined()
    expect(displayOf('sa-1')).toBeUndefined()
    expect(toastMocks.error).toHaveBeenCalledTimes(1)
  })

  it('run 级聚合：switched 成员写生效值、not-active 写覆盖意图、失败名单成员不写并 toast 分项', async () => {
    apiMocks.setModel.mockResolvedValue({
      members: [
        { runId: 'sa-a', state: 'switched', effectiveModel: { provider: 'p', modelId: 'm-a' }, effectiveThinkingLevel: 'high' },
        { runId: 'sa-b', state: 'not-active' },
        { runId: 'sa-c', state: 'not-applicable' },
      ],
      failures: [{ runId: 'sa-d', reason: 'engine_state_readback_failed' }],
      summary: '部分成员已切换',
    })
    const { setSubagentModel, memberDisplayOf } = useSubagentModel()

    const reply = await setSubagentModel({ runId: 'wf-1', provider: 'p', modelId: 'target' })

    expect(reply).toBeDefined()
    // switched：成员生效值（引擎回读）
    expect(memberDisplayOf('wf-1', 'sa-a')).toEqual({ effectiveModel: 'p/m-a' })
    // not-active / not-applicable：覆盖意图（记账路径，重派生效）
    expect(memberDisplayOf('wf-1', 'sa-b')).toEqual({ overrideIntent: 'p/target' })
    expect(memberDisplayOf('wf-1', 'sa-c')).toEqual({ overrideIntent: 'p/target' })
    // 失败名单成员：不写显示态（生效值未知），toast 分项呈现（成员标识 + 失败分型）
    expect(memberDisplayOf('wf-1', 'sa-d')).toBeUndefined()
    expect(toastMocks.error).toHaveBeenCalledTimes(1)
    expect(toastMocks.error.mock.calls[0]?.[0]).toContain('sa-d')
    expect(toastMocks.error.mock.calls[0]?.[0]).toContain('engine_state_readback_failed')
  })
})
