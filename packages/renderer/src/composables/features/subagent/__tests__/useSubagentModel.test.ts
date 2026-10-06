// @vitest-environment happy-dom

/**
 * useSubagentModel 单测（subagent-model-switch §7.1 入口层，U1 验收面——renderer 半边）。
 *
 * 覆盖（mock 宿主应答回执范式 + 标签读取规则四分支 + thinking 槽取值）：
 * - **禁乐观写**：api promise 未 resolve 前显示态零写入（应答到达才写状态）；
 * - 回执分流：chat 两型（effective → 生效值 / recorded → 覆盖意图）+ run 级聚合
 *   （switched → 成员生效值 / not-active·not-applicable → 成员覆盖意图 / 失败名单
 *   不写 + toast 分项）；
 * - thinking 档位同步（§6.4）：回执带 effectiveThinkingLevel → 展示态字段更新且面板
 *   取值跟随；回执缺省该字段（聚合成员 optional）→ 字段不动、面板回退盖章值；
 * - 失败路径：RPC reject → 显示态零写入（标签读取规则分支③的构造性成立载体）+
 *   返回 undefined；
 * - resolveSubagentModelDisplay 四分支：① 回执生效值在场 → 实际生效值；④ 分叉态
 *   重载（无回执态 + 活进程在场 recordStatus:'running' + 载荷最近生效值在场）→ 生效值
 *   承接、不回退覆盖意图值；④ 门控（F1-30）：已结束成员（idle）重载不吃
 *   recentEffectiveModel → 落覆盖意图（②'）或盖章值；② 已记账
 *   → 覆盖意图值 + 「用户覆盖中」标注（优先级高于④——已记账回执在场时「最近生效值」
 *   是同会话早前热切的历史值，§6.4 口径显示覆盖意图值）；兜底 → 盖章值；
 * - effective 型回执意图受理凭证（F1-31 裁决候选 A）：effective 回执同时写
 *   overrideIntent（请求目标 ref）——badge 事实依据 = 意图已受理，D3 缺陷四轮内空窗修复。
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
  resolveSubagentThinkingLevel,
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

  it('分支④：分叉态重载（回执态已丢 + 活进程在场 + 载荷最近生效值在场）→ 按最近生效值显示，不回退覆盖意图值', () => {
    const display = resolveSubagentModelDisplay({
      stampedModel: 'p/stamped',
      modelOverride: 'p/intent',
      recentEffectiveModel: { provider: 'p', modelId: 'recent-effective' },
      recordStatus: 'running',
    })
    expect(display.label).toBe('p/recent-effective')
    expect(display.overridden).toBe(true)
  })

  it('分支④ 门控（F1-30）：已结束成员（idle）重载不吃最近生效值 → 落覆盖意图值（分支②\'，badge 同源）', () => {
    // recorded 型切换 + 重载：recorded 回执态已丢，pi 成员 recentEffectiveModel 恒有值
    // （spawn 首条即写 model_change）——无门控时标签显示历史生效值、与实际生效值背离
    // （D3-A6b 17:57 实测）；门控后已结束成员走覆盖意图（与「用户覆盖中」badge 同源）
    const display = resolveSubagentModelDisplay({
      stampedModel: 'p/stamped',
      modelOverride: 'p/intent',
      recentEffectiveModel: { provider: 'p', modelId: 'recent-effective' },
      recordStatus: 'idle',
    })
    expect(display.label).toBe('p/intent')
    expect(display.overridden).toBe(true)
  })

  it('分支④ 门控（F1-30）：已结束成员重载 + 无覆盖 → 盖章值（不再吃最近生效值）', () => {
    const display = resolveSubagentModelDisplay({
      stampedModel: 'p/stamped',
      recentEffectiveModel: { provider: 'p', modelId: 'recent-effective' },
      recordStatus: 'idle',
    })
    expect(display.label).toBe('p/stamped')
    expect(display.overridden).toBe(false)
  })

  it('分支②：已记账型（无生效值源 + 覆盖意图在场）→ 覆盖意图值 + 「用户覆盖中」标注', () => {
    const display = resolveSubagentModelDisplay({
      stampedModel: 'p/stamped',
      modelOverride: 'p/intent',
    })
    expect(display.label).toBe('p/intent')
    expect(display.overridden).toBe(true)
  })

  it('分支② 优先于④：已记账型回执在场 + 载荷最近生效值同场 → 显示本次覆盖意图值，不显示历史生效值', () => {
    // 先热切产生 model_change 尾条目（载荷 recentEffectiveModel），后无活进程记账型切换
    // 写入回执 overrideIntent——§6.4：已记账型路径标签 = 覆盖意图值；「最近生效值」消费
    // 域仅限分叉态重载（回执态整体缺席），回执态在场时显示它 = 历史值 stale 显示
    const display = resolveSubagentModelDisplay({
      display: { overrideIntent: 'p/recorded-intent' },
      stampedModel: 'p/stamped',
      modelOverride: 'p/intent',
      recentEffectiveModel: { provider: 'p', modelId: 'recent-effective' },
    })
    expect(display.label).toBe('p/recorded-intent')
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
    // 生效值 + 意图受理凭证（F1-31：overrideIntent = 请求目标 ref）+ 生效档位
    expect(displayOf('sa-1')).toEqual({ effectiveModel: 'p/m2', overrideIntent: 'p/m', thinkingLevel: 'high' })
  })

  it('chat 已生效型：回读生效值写入，且 overrideIntent = 请求目标 ref（意图受理凭证，F1-31）', async () => {
    apiMocks.setModel.mockResolvedValue({
      kind: 'effective',
      effectiveModel: { provider: 'p', modelId: 'sibling-model' },
      effectiveThinkingLevel: 'high',
    })
    const { setSubagentModel, displayOf } = useSubagentModel()

    await setSubagentModel({ recordId: 'sa-1', provider: 'p', modelId: 'requested' })

    expect(apiMocks.setModel).toHaveBeenCalledWith({ recordId: 'sa-1', provider: 'p', modelId: 'requested' })
    expect(displayOf('sa-1')?.effectiveModel).toBe('p/sibling-model')
    // F1-31 裁决候选 A：回执即意图受理凭证——同族替换（生效值 ≠ 目标）时意图 ref
    // 仍是本次请求目标，badge 事实依据 = 意图已受理（D3 缺陷四轮内空窗修复）
    expect(displayOf('sa-1')?.overrideIntent).toBe('p/requested')
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
    // switched：成员生效值（引擎回读）+ 生效档位（成员携带时随行）——聚合成员不写
    // overrideIntent（F1-31 裁决范围 = chat 域 effective 型回执；聚合成员 badge 依赖
    // run 级意图通道与载荷重推，边界经本断言固化）
    expect(memberDisplayOf('wf-1', 'sa-a')).toEqual({ effectiveModel: 'p/m-a', thinkingLevel: 'high' })
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

// ── thinking 档位同步（§6.4：切换回执连 thinkingLevel 一起同步，防面板档位脱节）──

describe('useSubagentModel — thinking 档位同步（§6.4）', () => {
  it('chat 已生效型：回执带 effectiveThinkingLevel → 展示态字段更新，面板取值跟随热切值', async () => {
    apiMocks.setModel.mockResolvedValue({
      kind: 'effective',
      effectiveModel: { provider: 'p', modelId: 'm2' },
      effectiveThinkingLevel: 'low',
    })
    const { setSubagentModel, displayOf } = useSubagentModel()

    await setSubagentModel({ recordId: 'sa-1', provider: 'p', modelId: 'm' })

    expect(displayOf('sa-1')?.thinkingLevel).toBe('low')
    // 面板 thinking 槽取值（SubagentTab 消费同源纯函数）：展示态档位优先于盖章值
    expect(resolveSubagentThinkingLevel(displayOf('sa-1'), 'high')).toBe('low')
  })

  it('聚合 switched 成员缺省档位字段：展示态不写字段（UI 跟随事实，禁乐观回显）', async () => {
    apiMocks.setModel.mockResolvedValue({
      members: [{ runId: 'sa-a', state: 'switched', effectiveModel: { provider: 'p', modelId: 'm-a' } }],
      failures: [],
      summary: '已切换',
    })
    const { setSubagentModel, memberDisplayOf } = useSubagentModel()

    await setSubagentModel({ runId: 'wf-1', provider: 'p', modelId: 'target' })

    // 回执缺省 effectiveThinkingLevel → 展示态无该字段（不虚构档位）
    expect(memberDisplayOf('wf-1', 'sa-a')).toEqual({ effectiveModel: 'p/m-a' })
    // 面板取值回退启动盖章值（record.thinkingLevel）
    expect(resolveSubagentThinkingLevel(memberDisplayOf('wf-1', 'sa-a'), 'high')).toBe('high')
  })

  it('resolveSubagentThinkingLevel：展示态在场取热切值；回执态缺席回退盖章值', () => {
    expect(resolveSubagentThinkingLevel({ effectiveModel: 'p/m', thinkingLevel: 'low' }, 'high')).toBe('low')
    expect(resolveSubagentThinkingLevel({ effectiveModel: 'p/m' }, 'high')).toBe('high')
    expect(resolveSubagentThinkingLevel(undefined, 'high')).toBe('high')
    // 盖章值也缺省（record 无 thinkingLevel）：槽位整体缺省（面板隐藏 thinking 槽）
    expect(resolveSubagentThinkingLevel(undefined, undefined)).toBeUndefined()
  })
})
