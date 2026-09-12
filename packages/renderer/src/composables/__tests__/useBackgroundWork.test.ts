/**
 * useBackgroundWork 谓词测试（CW wave `completion-sound-bg-guard`）。
 *
 * 覆盖 TC1-TC5（hasBackgroundWork 谓词各场景）+ TC9（deriveStatus working 态回归，
 * 走真实 useSessionDerivations 集成路径，验证重构后行为不变）。
 *
 * 用真实 store（setActivePinia + applyRecords 注入数据），不 mock store 方法：
 * - TC1-TC5 直测 useBackgroundWork().hasBackgroundWork
 * - TC9 经 useSessionDerivations().derivedStatus 验证 working 态（谓词接入 deriveStatus 回归）
 *
 * 运行：cd packages/renderer && npx vitest run composables/__tests__/useBackgroundWork.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SUBAGENT_RECORD_CUSTOM_TYPE } from '@xyz-agent/shared'
import type { SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'
import { useBackgroundWork } from '../features/chat/useBackgroundWork'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
// R3-1④：跨包消费 runtime extractor 真实投影产物构造 fixture——手工拼 origin 的
// SubagentRecord 会掩盖 runtime 投影白名单断链（origin 恒 undefined 时下游过滤用例
// 照样绿，假绿）。投影白名单删 origin 时本文件的投影断言与下游判定断言共同转红。
import { scanSubagentEntries } from '../../../../runtime/src/services/session/subagent-extractor.js'

/** 构造最小合法 SubagentRecord（仅必填字段）。 */
function makeSubagent(overrides: Partial<SubagentRecord>): SubagentRecord {
  return {
    subagentId: 'sub-1',
    sessionFile: null,
    agent: 'general-purpose',
    slug: 'worker',
    task: 'do something',
    status: 'running',
    ...overrides,
  }
}

/** 构造最小合法 WorkflowRunRecord（仅必填字段）。 */
function makeWorkflow(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'review',
    status: 'running',
    startedAt: '2026-07-01T00:00:00.000Z',
    agentCalls: [],
    stateFilePath: '/tmp/state.json',
    ...overrides,
  }
}

describe('useBackgroundWork', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('TC1: subagent running → true', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  // [review findings-confirmation #8] TC1b：running-resumable（轮终回写 running + result）
  // 不是后台真在跑——v4 轮终迁移故意回写 running（可冷路径 resume），result 有值即轮终信号。
  // 不排除会致 derivedStatus 恒 working → 末位 turn 永久「工作中」。
  it('TC1b: subagent running + result（轮终 running-resumable）→ false', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'running', result: '本轮产出' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  // TC1c：混跑场景——一个轮终 resumable + 一个真在跑（首轮无 result）→ 仍算 working
  it('TC1c: 轮终 resumable + 首轮真在跑混合 → true（任一真在跑即 working）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [
      makeSubagent({ subagentId: 'sub-idle', status: 'running', result: 'done text' }),
      makeSubagent({ subagentId: 'sub-live', status: 'running' }),
    ])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC2: workflow running → true', () => {
    const wf = useWorkflowStore()
    wf.applyRecords('s1', [makeWorkflow({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC3: workflow paused → true（paused 不续跑主 agent，仍算未完成）', () => {
    const wf = useWorkflowStore()
    wf.applyRecords('s1', [makeWorkflow({ status: 'paused' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('TC4: 全 done（subagent done + workflow done）→ false', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'done' })])
    wf.applyRecords('s1', [makeWorkflow({ status: 'done' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  it('TC5: subagent 其它终态（failed/cancelled/crashed）+ workflow done → false', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'failed' })])
    wf.applyRecords('s1', [makeWorkflow({ status: 'done' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  it('TC5b: 无任何 records（未访问 session）→ false', () => {
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('never-seen')).toBe(false)
  })

  it('TC5c: 混合 —— subagent done 但 workflow running → true（聚合 OR 语义）', () => {
    const sub = useSubagentStore()
    const wf = useWorkflowStore()
    sub.applyRecords('s1', [makeSubagent({ status: 'done' })])
    wf.applyRecords('s1', [makeWorkflow({ status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  // H2 W1（record-unification D1③）：workflow 脚本派发的 subagent（origin='workflow'）
  // 不算本 session 的后台工作——其生命周期由 workflow run 承载，混入会让主 session
  // 在 workflow 运行期间被误判 working（列表恒亮「工作中」）。
  it('W1: 仅 workflow origin 的 subagent running → false（不被 workflow 派发 record 绑架）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [
      makeSubagent({ subagentId: 'sub-wf-1', status: 'running', origin: 'workflow' }),
      makeSubagent({ subagentId: 'sub-wf-2', status: 'running', origin: 'workflow' }),
    ])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(false)
  })

  it('W1: workflow origin + 手动 tool running 混合 → true（tool record 判定不受影响）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [
      makeSubagent({ subagentId: 'sub-wf-1', status: 'running', origin: 'workflow' }),
      makeSubagent({ subagentId: 'sub-tool-1', status: 'running' }),
    ])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })

  it('W1: origin 缺省（存量 record，undefined = tool 语义）仍参与判定（零迁移保障）', () => {
    const sub = useSubagentStore()
    sub.applyRecords('s1', [makeSubagent({ subagentId: 'sub-legacy', status: 'running' })])
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s1')).toBe(true)
  })
})

// R3-1④（H2 阶段 3 一致性审查修复）：fixture 源 = runtime extractor 真实投影。
// 上方 W1 用例手工拼 origin 只验证谓词本身；runtime 投影白名单断链时它们照样绿。
// 本组用例经 scanSubagentEntries 从自描述 entry 派生——白名单删 origin → 投影断言
// undefined → hasBackgroundWork 判定断言同步转红（红锚联动）。
describe('useBackgroundWork × runtime extractor 真实投影产物（R3-1④）', () => {
  /** 自描述 subagent-record entry 构造（pi JSONL 持久化形态 = runtime extractor 输入）。 */
  function recordEntry(data: Record<string, unknown>): Record<string, unknown> {
    return { type: 'custom', customType: SUBAGENT_RECORD_CUSTOM_TYPE, data }
  }

  it('投影透传 + 判定：extractor 产出的 workflow record 不绑架 hasBackgroundWork（投影白名单删 origin 即红）', () => {
    const records = scanSubagentEntries([
      recordEntry({ v: 1, id: 'sub-proj-wf', status: 'running', origin: 'workflow' }),
      recordEntry({ v: 1, id: 'sub-proj-wf-idle', status: 'running', result: '轮终产出', origin: 'workflow' }),
    ])
    // fixture 源证明：origin 由 runtime 投影产出，非手工拼装
    expect(records.find((r) => r.subagentId === 'sub-proj-wf')?.origin).toBe('workflow')

    const sub = useSubagentStore()
    sub.applyRecords('s-proj', records)
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s-proj')).toBe(false)
  })

  it('零迁移：extractor 缺省投影（存量 record，origin undefined）仍判定为后台工作', () => {
    const records = scanSubagentEntries([recordEntry({ v: 1, id: 'sub-proj-legacy', status: 'running' })])
    expect(records[0]?.origin).toBeUndefined()

    const sub = useSubagentStore()
    sub.applyRecords('s-proj-legacy', records)
    const { hasBackgroundWork } = useBackgroundWork()
    expect(hasBackgroundWork('s-proj-legacy')).toBe(true)
  })
})

/**
 * TC9：deriveStatus working 态回归（集成）。
 * 验证 useSessionDerivations 重构后（内联判定 → useBackgroundWork）derivedStatus 行为不变：
 * subagent running → working；全部回落 done 后 → done。
 *
 * 用真实 subagent store + applyRecords 注入数据；invalidateStatusCache 清模块级缓存，
 * 避免 computed 持有上个 pinia 实例的旧 store 闭包（对齐 derive-status-ask-user.test.ts 模式）。
 */
describe('TC9: useSessionDerivations.derivedStatus working 态回归（useBackgroundWork 接入）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('subagent running → derivedStatus = working；subagent done 后回落 done', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const sub = useSubagentStore()
    const sessionId = 's-tc9'

    // 初始：未 hydrate + 非活跃 + 无 background → done
    expect(derivedStatus(sessionId).value).toBe('done')

    // 注入 subagent running → working（hasBackgroundWork=true）
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9', status: 'running' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // subagent 全 done → 回落 done（响应式：computed 重算）
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9', status: 'done' })])
    expect(derivedStatus(sessionId).value).toBe('done')
  })

  // [review findings-confirmation #8] TC9b：subagent 轮终（record 有 result 仍 running，
  // v4 running-resumable 设计）→ derivedStatus 不再 working（回 done）→ sessionActive
  // false → isWorkingTurn false。这是「完成注入后末位 turn 永久工作中」的核心回归：
  // live 期行为对齐重开后（record=closed → done）。
  it('subagent 轮终（running + result）→ derivedStatus = done（非 working）；真在跑（无 result）→ working', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const sub = useSubagentStore()
    const sessionId = 's-tc9c'

    // 真在跑（首轮，无轮终信号）→ working
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9c', status: 'running' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // 轮终回写 running + result（resumable）→ 不算 working，回落 done
    sub.applyRecords(sessionId, [makeSubagent({ subagentId: 'sub-tc9c', status: 'running', result: '本轮产出' })])
    expect(derivedStatus(sessionId).value).toBe('done')
  })

  // [H2 W1] 仅 workflow origin 的 subagent running → derivedStatus 不进 working
  //（用户可见行为：session 列表不亮「工作中」——workflow 派发 record 由 run 视图承载）。
  it('W1: 仅 workflow origin subagent running → derivedStatus = done（非 working）', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const sub = useSubagentStore()
    const sessionId = 's-wf-only'

    sub.applyRecords(sessionId, [
      makeSubagent({ subagentId: 'sub-wf-only', status: 'running', origin: 'workflow' }),
    ])
    expect(derivedStatus(sessionId).value).toBe('done')
  })

  it('workflow paused → derivedStatus = working（paused 也算 background work）', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const wf = useWorkflowStore()
    const sessionId = 's-tc9b'

    // workflow paused → working（hasBackgroundWork=true，paused 视为未完成）
    wf.applyRecords(sessionId, [makeWorkflow({ runId: 'wf-tc9b', status: 'paused' })])
    expect(derivedStatus(sessionId).value).toBe('working')

    // workflow done → 回落 done
    wf.applyRecords(sessionId, [makeWorkflow({ runId: 'wf-tc9b', status: 'done' })])
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})
