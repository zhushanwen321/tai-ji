/**
 * EventInterpreter 编排测试。
 *
 * - session-renamed（MF-3 ②）：session_info_changed 中间事件 → onSessionRenamed 回调
 *   （组合根接 sessionService.setLabelCache，runtime 内存 label 自动同步链）
 * - compaction（M4 事件驱动：interpreter 唯一源）：
 * - agent-settled V7 dev-only 延迟注入（session-dead-structural-fixes U1/V7）：
 *
 * 锁定（SSOT §3.3.4 编排表）：
 * - TC1: compaction_start{reason} → 广播 session.compacting{reason} + onCompactingStateChange(sid,true)
 * - TC2: compaction_end{result} 成功 → message.compactionSummary + session.compacted（无 error）
 *        + onContextUpdate(estimatedTokensAfter) + onCompactingStateChange(sid,false)
 * - TC3: compaction_end aborted（无 errorMessage 真值）→ session.compacted（不带 error）+ 复位，无 compactionSummary
 * - TC4: compaction_end failed（errorMessage 真值）→ session.compacted{error} + message.error 对话流提示 + 复位
 * - 孤儿 end 容错：无 preceding start 的 compaction_end → 复位对 false 幂等无害（不维护配对状态机）
 * - errorMessage 真值判据：aborted:true + errorMessage 真值 → 走 failed（真值优先于 aborted 字段）
 *
 * 运行：npx vitest run src/__tests__/event-interpreter.test.ts
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { EventInterpreter, OCCUPANCY_SETTLE_WINDOW_MS, occupancySettleWindow } from '../services/session/event-interpreter.js'
import type { GenStatsSample, PiTranslatedEvent, SessionOccupancyTransition } from '../services/session/types.js'
import type { ServerMessage } from '@taiji/shared'

function makeInterpreter(overrides: {
  send?: (m: ServerMessage) => void
  onCompactingStateChange?: (sid: string, v: boolean) => void
  onContextUpdate?: (sid: string, data: { inputTokens: number; totalTokens: number }) => void
  onSessionRenamed?: (sid: string, name: string | undefined) => void
  onAgentSettled?: (sid: string) => void
  onOccupancyTransition?: (transition: SessionOccupancyTransition) => void
} = {}) {
  const sent: ServerMessage[] = []
  const send = overrides.send ?? ((m: ServerMessage) => { sent.push(m) })
  const onCompactingStateChange = overrides.onCompactingStateChange ?? vi.fn()
  const onContextUpdate = overrides.onContextUpdate ?? vi.fn()
  const onSessionRenamed = overrides.onSessionRenamed ?? vi.fn()
  const onAgentSettled = overrides.onAgentSettled ?? vi.fn()
  const onOccupancyTransition = overrides.onOccupancyTransition ?? vi.fn()
  const interp = new EventInterpreter('s1', {
    send,
    onCompactingStateChange,
    onContextUpdate,
    onSessionRenamed,
    onAgentSettled,
    onOccupancyTransition,
  })
  return { interp, sent, onCompactingStateChange, onContextUpdate, onSessionRenamed, onAgentSettled, onOccupancyTransition }
}

describe('EventInterpreter session-renamed 编排（MF-3 ②，label 自动同步链）', () => {
  // 链路：event-adapter session_info_changed → {kind:'session-renamed'} → 本 case →
  // onSessionRenamed → 组合根 sessionService.setLabelCache（runtime 内存 label 唯一
  // 数据源）。缺测刻痕：本链路历经 3 个 fix commit 仍无回归钉住。
  it('TC-RN1: session-renamed{name} → onSessionRenamed(sid, name)', () => {
    const { interp, onSessionRenamed } = makeInterpreter()
    interp.interpret([{ kind: 'session-renamed', name: 'renamed-by-pi' }])
    expect(onSessionRenamed).toHaveBeenCalledTimes(1)
    expect(onSessionRenamed).toHaveBeenCalledWith('s1', 'renamed-by-pi')
  })

  it('TC-RN2: name undefined → 回调透传 undefined（组合根回落 basename 派生，session-rename-fanout 承载 D4）', () => {
    const { interp, onSessionRenamed } = makeInterpreter()
    interp.interpret([{ kind: 'session-renamed', name: undefined }])
    expect(onSessionRenamed).toHaveBeenCalledWith('s1', undefined)
  })
})

describe('EventInterpreter compaction 编排 (M4 事件驱动)', () => {
  it('TC1: compaction_start{reason} → session.compacting{reason} + isCompacting=true', () => {
    const onCompactingStateChange = vi.fn()
    const { interp, sent } = makeInterpreter({ onCompactingStateChange })

    interp.interpret([{ kind: 'compaction-start', reason: 'manual' }])

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('session.compacting')
    expect(sent[0].payload).toMatchObject({ sessionId: 's1', status: 'compacting', reason: 'manual' })
    expect(onCompactingStateChange).toHaveBeenCalledWith('s1', true)
  })

  it('TC1-auto: compaction_start{reason:"threshold"} → reason 透传（驱动前端自动文案）', () => {
    const { interp, sent } = makeInterpreter()
    interp.interpret([{ kind: 'compaction-start', reason: 'threshold' }])
    expect(sent[0].payload).toMatchObject({ reason: 'threshold' })
  })

  it('TC2: compaction_end{result} 成功 → compactionSummary + contextUpdate + session.compacted（无 error）+ 复位', () => {
    const onContextUpdate = vi.fn()
    const onCompactingStateChange = vi.fn()
    const { interp, sent } = makeInterpreter({ onContextUpdate, onCompactingStateChange })

    interp.interpret([{
      kind: 'compaction-end',
      reason: 'manual',
      result: { summary: '压缩摘要', tokensBefore: 100, estimatedTokensAfter: 30 },
      aborted: false,
    }])

    // compactionSummary 进对话流
    const summary = sent.find((m) => m.type === 'message.compactionSummary')
    expect(summary).toBeDefined()
    expect(summary!.payload).toMatchObject({ sessionId: 's1', summary: '压缩摘要', tokensBefore: 100 })
    // context 用量刷新（estimatedTokensAfter）
    expect(onContextUpdate).toHaveBeenCalledWith('s1', { inputTokens: 30, totalTokens: 30 })
    // session.compacted 不带 error → 前端 compacted handler flush queue
    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect(compacted).toBeDefined()
    expect(compacted!.payload).toMatchObject({ sessionId: 's1', status: 'compacted' })
    expect((compacted!.payload as { error?: string }).error).toBeUndefined()
    // 复位对称（SUG-新2）
    expect(onCompactingStateChange).toHaveBeenCalledWith('s1', false)
  })

  it('TC2b: compaction_end{result 无 summary} 成功（D2 closure）→ 仍恒发 compactionSummary 帧（summary 缺省透传，reducer 侧两侧同 fallback）', () => {
    const { interp, sent } = makeInterpreter({})

    interp.interpret([{
      kind: 'compaction-end',
      reason: 'auto',
      result: { tokensBefore: 999 }, // summary 缺失（LLM 异常返回无摘要的成功压缩）
      aborted: false,
    }])

    // 恒发帧（原 `if (r.summary)` 真值门已删）：payload.summary 为 undefined，下游
    // registry/reducer 走「上下文已压缩」fallback——live 与重开（pi 无条件落盘）一致，
    // 登记例外④消灭（等价性断言见 apply-entry-equivalence E4b）
    const summary = sent.find((m) => m.type === 'message.compactionSummary')
    expect(summary).toBeDefined()
    expect(summary!.payload).toMatchObject({ sessionId: 's1', summary: undefined, tokensBefore: 999 })
    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect(compacted).toBeDefined()
  })

  it('TC3: compaction_end aborted（无 errorMessage 真值）→ session.compacted（不带 error）+ 复位，无 compactionSummary', () => {
    const onContextUpdate = vi.fn()
    const { interp, sent } = makeInterpreter({ onContextUpdate })

    interp.interpret([{ kind: 'compaction-end', reason: 'threshold', result: undefined, aborted: true }])

    // 无 compactionSummary（压缩未发生）+ 无 message.error（非失败）
    expect(sent.find((m) => m.type === 'message.compactionSummary')).toBeUndefined()
    expect(sent.find((m) => m.type === 'message.error')).toBeUndefined()
    // context 不刷新
    expect(onContextUpdate).not.toHaveBeenCalled()
    // session.compacted 不带 error → 前端 flush（释放 compacting 期间积压消息）
    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect(compacted).toBeDefined()
    expect((compacted!.payload as { error?: string }).error).toBeUndefined()
  })

  it('TC4: compaction_end failed（errorMessage 真值）→ session.compacted{error} + message.error 对话流提示 + 复位', () => {
    const onContextUpdate = vi.fn()
    const { interp, sent } = makeInterpreter({ onContextUpdate })

    interp.interpret([{
      kind: 'compaction-end',
      reason: 'manual',
      aborted: false,
      errorMessage: 'LLM 报错',
    }])

    // session.compacted 带 error → 前端 compacted handler error 非空 → 不 flush（队列保留）
    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect(compacted).toBeDefined()
    expect((compacted!.payload as { error?: string }).error).toBe('LLM 报错')
    // message.error 进对话流（错误作为 assistant 消息插入，AGENTS.md 规则 #3）
    const errMsg = sent.find((m) => m.type === 'message.error')
    expect(errMsg).toBeDefined()
    expect((errMsg!.payload as { message?: string }).message).toContain('上下文压缩失败')
    expect((errMsg!.payload as { message?: string }).message).toContain('LLM 报错')
    // 无 compactionSummary（压缩未成功）
    expect(sent.find((m) => m.type === 'message.compactionSummary')).toBeUndefined()
    // context 不刷新
    expect(onContextUpdate).not.toHaveBeenCalled()
  })

  it('errorMessage 真值判据：aborted:true + errorMessage 真值 → 走 failed（真值优先于 aborted 字段）', () => {
    // SSOT §3.3.4：失败判据以 errorMessage 真值为准（非 aborted 字段）。
    // pi 三种 aborted:true 形态在 errorMessage 真值层面一致（都 falsy），但若 errorMessage 有值则属 failed。
    const { interp, sent } = makeInterpreter()
    interp.interpret([{ kind: 'compaction-end', reason: 'manual', aborted: true, errorMessage: '取消时附带错误' }])

    const compacted = sent.find((m) => m.type === 'session.compacted')
    expect((compacted!.payload as { error?: string }).error).toBe('取消时附带错误')
    expect(sent.find((m) => m.type === 'message.error')).toBeDefined()
  })

  it('孤儿 compaction_end 容错：无 preceding start → 复位对 false 幂等无害（不维护配对状态机）', () => {
    // SSOT SUG-新3：overflow「已 retry 过一次」早退路径无 compaction_start，直接发 compaction_end{errorMessage}。
    // interpreter 不因「未收到 start」拒绝处理 end，自洽处理（复位 + 按 errorMessage 真值判分支）。
    const onCompactingStateChange = vi.fn()
    const { interp, sent } = makeInterpreter({ onCompactingStateChange })

    interp.interpret([{
      kind: 'compaction-end',
      reason: 'overflow',
      aborted: false,
      errorMessage: 'overflow retry exhausted',
    }])

    // failed 分支：session.compacted{error} + message.error
    expect((sent.find((m) => m.type === 'session.compacted')!.payload as { error?: string }).error).toBe('overflow retry exhausted')
    expect(sent.find((m) => m.type === 'message.error')).toBeDefined()
    // 复位（对本来 false 的 isCompacting 写 false，幂等无害）
    expect(onCompactingStateChange).toHaveBeenCalledWith('s1', false)
  })

  it('完整生命周期：start → end 成功（置位/复位对称）', () => {
    const onCompactingStateChange = vi.fn()
    const { interp } = makeInterpreter({ onCompactingStateChange })

    interp.interpret([{ kind: 'compaction-start', reason: 'manual' }])
    interp.interpret([{
      kind: 'compaction-end',
      reason: 'manual',
      result: { summary: 'S', tokensBefore: 50, estimatedTokensAfter: 20 },
      aborted: false,
    }])

    // 置位 + 复位各一次，顺序 true → false
    expect(onCompactingStateChange).toHaveBeenNthCalledWith(1, 's1', true)
    expect(onCompactingStateChange).toHaveBeenNthCalledWith(2, 's1', false)
  })
})

// ── composer-gen-stats LLM 窗口 D3 矩阵（八行表）──
//
// 锁定 U1 状态机回归：turnStartedAt（LLM 窗口起算锚点）+ llmWindowDurationMs（已结算窗口）+
// turn-usage 消费（durationMs 改源，一次性清 null）+ turn-start 重锚清除不变量 +
// assistant message_end role 守卫。八行用例与设计 D3 矩阵表逐一对应（U3）。
describe('EventInterpreter composer-gen-stats LLM 窗口 D3 配对矩阵', () => {
  /** gen-stats 专用 interpreter 工厂（照抄 makeInterpreter 形态，多注入 onGenStats 采样回调）。 */
  function makeGenStatsInterpreter() {
    const sent: ServerMessage[] = []
    const onGenStats = vi.fn((_sessionId: string, _sample: GenStatsSample) => {})
    const interp = new EventInterpreter('s1', { send: (m: ServerMessage) => { sent.push(m) }, onGenStats })
    return { interp, sent, onGenStats }
  }

  /** message_end 帧（照抄 event-adapter 翻译形态：{sessionId, entry: PiMessageEntry}）。 */
  function makeMessageEndFrame(role: string): ServerMessage {
    return {
      type: 'message.message_end',
      payload: {
        sessionId: 's1',
        entry: { type: 'message', timestamp: new Date().toISOString(), message: { role } },
      },
    }
  }

  /** turn-usage 事件（字段名以 types.ts PiTranslatedEvent 实际定义为准）。 */
  function makeTurnUsage(): PiTranslatedEvent {
    return {
      kind: 'turn-usage',
      sessionId: 's1',
      inputTokens: 10,
      totalTokens: 120,
      outputTokens: 80,
      cacheRead: 20,
      cacheWrite: 0,
      input: 10,
      model: 'test-model',
      provider: 'test-provider',
    }
  }

  /** 取最近一次采样样本。 */
  function lastSample(onGenStats: ReturnType<typeof makeGenStatsInterpreter>['onGenStats']): GenStatsSample {
    return onGenStats.mock.calls[onGenStats.mock.calls.length - 1][1]
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('① 正常：start → end(assistant) → 推时钟 → usage → durationMs=窗口差（end→usage 间时钟不计入）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.advanceTimersByTime(5_000) // LLM 流式窗口：t1 = 6000
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    vi.advanceTimersByTime(30_000) // end → usage 之间的墙钟推进（工具收尾等），不得计入
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    const sample = lastSample(onGenStats)
    // 窗口差（6000-1000=5000），非墙钟差（6000+30000-1000=35000）
    expect(sample.durationMs).toBe(5_000)
    // 伴随字段透传
    expect(sample.outputTokens).toBe(80)
    expect(sample.model).toBe('test-model')
    expect(sample.provider).toBe('test-provider')
    expect(sample.cacheRead).toBe(20)
  })

  it('② △缺起：无 turn-start，直接 end(assistant) + usage → durationMs=null（速度样本跳过，命中率字段照常）', () => {
    vi.useFakeTimers()
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    const sample = lastSample(onGenStats)
    expect(sample.durationMs).toBeNull()
    // 命中率样本照常（§3.5：token 字段不受速度配对失败影响）
    expect(sample.outputTokens).toBe(80)
    expect(sample.input).toBe(10)
    expect(sample.cacheRead).toBe(20)
    expect(sample.cacheWrite).toBe(0)
  })

  it('③ △真缺闭：start → usage（无 end，pi 崩溃/断连）→ durationMs=null', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.advanceTimersByTime(7_000) // 锚点残留期推进——若误用锚点会算出 7000
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    expect(lastSample(onGenStats).durationMs).toBeNull()
  })

  it('④ △usage 缺席：start → end（无 usage）→ 下轮 start 重锚 → 下轮完整流程 → 上轮 d 不泄漏', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    // 上轮：窗口结算 d=4000，但 turn-usage 缺席 → d 残留
    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.advanceTimersByTime(4_000)
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    // 下轮：start 重锚（重锚清除不变量：同步清残留 d）→ 完整流程
    interp.interpret([{ kind: 'turn-start', messageId: 'm2' }])
    vi.advanceTimersByTime(2_000)
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    vi.advanceTimersByTime(1_000)
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    const sample = lastSample(onGenStats)
    // 本轮窗口 2000——既非上轮残留 4000，也非两轮合计 6000（end→usage 推进不计入）
    expect(sample.durationMs).toBe(2_000)
  })

  it('⑤ △合成对：start → end(assistant, ≈0ms, 无 usage) → 下轮 start 重锚 → 完整轮 → 无 ≈0ms 样本', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    // 合成对（P3 分支②）：start 与合成 end 几乎同刻到达（≈0ms 窗口），EMPTY usage 被
    // adapter 门槛丢弃 → 本 turn 无 turn-usage 事件、无采样
    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    // 下轮正常 turn：重锚清 ≈0ms 残留 → 完整流程
    interp.interpret([{ kind: 'turn-start', messageId: 'm2' }])
    vi.advanceTimersByTime(3_000)
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    interp.interpret([makeTurnUsage()])

    // 全程仅本轮 1 个样本，且非 ≈0ms
    expect(onGenStats).toHaveBeenCalledTimes(1)
    const sample = lastSample(onGenStats)
    expect(sample.durationMs).toBe(3_000)
    for (const call of onGenStats.mock.calls) {
      expect(call[1].durationMs).not.toBeLessThan(100)
    }
  })

  it('⑥ △stale-d 复合：上轮 end 结算 d 残留 × 本轮 start 重锚 → 本轮缺 end 有 usage → durationMs=null', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    // 上轮：d=4000 结算后残留（usage 缺席）
    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.advanceTimersByTime(4_000)
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    // 本轮：start 重锚已清残留 → 缺 end 但 usage 到 → 不得产「旧窗口 × 新 token」垃圾样本
    interp.interpret([{ kind: 'turn-start', messageId: 'm2' }])
    vi.advanceTimersByTime(2_500)
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    expect(lastSample(onGenStats).durationMs).toBeNull()
  })

  it('⑦ △双 start 重锚：start(t0) → start(t1) → end → usage → durationMs=t2-t1（last-writer-wins）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }]) // t0 = 1000
    vi.advanceTimersByTime(9_000)
    interp.interpret([{ kind: 'turn-start', messageId: 'm2' }]) // t1 = 10000（覆写重锚）
    vi.advanceTimersByTime(2_000)
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }]) // t2 = 12000
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    // 取第二窗口（12000-10000=2000），非第一窗口 11000
    expect(lastSample(onGenStats).durationMs).toBe(2_000)
  })

  it('⑧ △他角色 end 混入：start → user/toolResult/custom 的 message_end → 真 assistant end → usage → durationMs=完整窗口（role 守卫）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.advanceTimersByTime(6_000) // 真窗口：t1 = 7000
    // MESSAGE_END_ALLOWED_ROLES 全量下发：user / toolResult / custom 的 end 帧同经 case 'message'，
    // role 守卫必须放过它们不闭合窗口（否则 duration 被截断、锚点被误清）
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('user') }])
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('toolResult') }])
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('custom') }])
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    vi.advanceTimersByTime(99_999) // end → usage 间墙钟不计入
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    // 完整窗口 6000：user/toolResult/custom end 未截断，assistant end 正常闭合
    expect(lastSample(onGenStats).durationMs).toBe(6_000)
  })
})

// ── composer-genstats-ttft TTFT 采样锚点（U2，设计 §3.2 + 场景表 S7）──
//
// 锁定 LlmWindowSampler 双锚点扩展（requestStartedAt / firstOutputAt / ttftMs）：锚点重锚
// 清除、first-wins 幂等、无输出信号即结束 ttftMs=null（无 0 污染）、工具轮重锚（TTFT
// 不含工具执行的契约钉）、error turn 不产脏样本、consume 一次性语义 + 分发守卫 warn。
describe('EventInterpreter composer-genstats-ttft TTFT 采样锚点（S7 契约）', () => {
  function makeGenStatsInterpreter() {
    const sent: ServerMessage[] = []
    const onGenStats = vi.fn((_sessionId: string, _sample: GenStatsSample) => {})
    const interp = new EventInterpreter('s1', { send: (m: ServerMessage) => { sent.push(m) }, onGenStats })
    return { interp, sent, onGenStats }
  }

  function makeMessageEndFrame(role: string): ServerMessage {
    return {
      type: 'message.message_end',
      payload: {
        sessionId: 's1',
        entry: { type: 'message', timestamp: new Date().toISOString(), message: { role } },
      },
    }
  }

  function makeTurnUsage(): PiTranslatedEvent {
    return {
      kind: 'turn-usage',
      sessionId: 's1',
      inputTokens: 10,
      totalTokens: 120,
      outputTokens: 80,
      cacheRead: 20,
      cacheWrite: 0,
      input: 10,
      model: 'test-model',
      provider: 'test-provider',
    }
  }

  function lastSample(onGenStats: ReturnType<typeof makeGenStatsInterpreter>['onGenStats']): GenStatsSample {
    return onGenStats.mock.calls[onGenStats.mock.calls.length - 1][1]
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('T1 正常：request-start → first-output → usage → ttftMs = 首输出与锚点差（end/usage 后续推进不计入）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(300) // 请求发出 → 首个输出 token（TTFT 主体段）
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }])
    vi.advanceTimersByTime(70_000) // 后续流式 + 收尾（不计入 TTFT）
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    expect(lastSample(onGenStats).ttftMs).toBe(300)
  })

  it('T2 锚点重锚清除：上轮未消费 ttft 残留 → 新 request-start 重锚 → 只算新窗口（不含上轮）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    // 上轮：锚点 + 首输出（ttft=300 结算），但 turn-usage 缺席（错误轮 / 合成对）→ 残留
    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(300)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }])
    // 下轮：request-start 重锚（清除不变量：清 ttftMs/firstOutputAt）→ 新窗口 500
    vi.advanceTimersByTime(6_700) // t = 8000
    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(500)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }])
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    expect(lastSample(onGenStats).ttftMs).toBe(500)
  })

  it('T3 first-wins 幂等：多首输出信号（text + thinking + toolcall 混合块）只取窗口首个', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(200)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }]) // thinking_start（首个信号）
    vi.advanceTimersByTime(700)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }]) // text_start（后续信号）
    vi.advanceTimersByTime(900)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }]) // toolcall_start
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    expect(lastSample(onGenStats).ttftMs).toBe(200) // 非 900 / 1800
  })

  it('T4 无输出信号即结束：锚点后直接 message_end + usage（错误 / 断连）→ ttftMs=null（无 0 污染）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(9_000) // 长等待后断连——窗口内零输出信号
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    const sample = lastSample(onGenStats)
    expect(sample.ttftMs).toBeNull() // 无值纪律：null 非 0
    // 伴生字段照常（ttft 缺失不影响速度/命中率路径）
    expect(sample.outputTokens).toBe(80)
    expect(sample.cacheRead).toBe(20)
  })

  it('T5 无锚防御：输出信号先于锚点（runtime 中途启动 / 不可能序）→ 不产值、不污染后续窗口', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    // 孤儿信号：无锚点直接到达（§3.5 防御行）——不得记 firstOutputAt
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }])
    interp.interpret([makeTurnUsage()])
    expect(onGenStats).toHaveBeenCalledTimes(1)
    expect(lastSample(onGenStats).ttftMs).toBeNull()

    // 同一 interpreter 后续正常轮：孤儿信号不得劫持 first-wins（否则 ttft 偏大 4000）
    vi.advanceTimersByTime(4_000) // t = 5000
    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(250)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }])
    interp.interpret([makeTurnUsage()])
    expect(onGenStats).toHaveBeenCalledTimes(2)
    expect(lastSample(onGenStats).ttftMs).toBe(250)
  })

  it('T6 工具轮重锚（S7 契约钉）：TTFT 不含工具执行——轮 2 只算本锚点窗口', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    // 轮 1：LLM 输出 tool_call（toolcall_start 首输出）→ turn_end（usage 到达）
    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(150)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }])
    vi.advanceTimersByTime(350)
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    interp.interpret([makeTurnUsage()])
    expect(lastSample(onGenStats).ttftMs).toBe(150)

    // 工具执行 60s（不含在 TTFT）→ 轮 2：turn_start 重锚起算
    vi.advanceTimersByTime(60_000) // t = 61500
    interp.interpret([{ kind: 'turn-start', messageId: 'm2' }])
    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(200)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }])
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(2)
    // 轮 2 ttft = 200（本锚点窗口），非 60700（轮 1 锚点跨工具执行）
    expect(lastSample(onGenStats).ttftMs).toBe(200)
  })

  it('T7 error turn 不产脏样本：锚点后流内 error（零输出信号）+ 真实 partial usage → ttftMs=null，速度字段不受扰', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, sent, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    // 流内 error：adapter 产 message.stream_error（无 llm-first-output），后续 partial
    // message_end 携带真实 usage → turn-usage 到达（pi P3① 行为）
    interp.interpret([{
      kind: 'message',
      message: { type: 'message.stream_error', payload: { sessionId: 's1', content: 'boom', kind: 'error' } },
    }])
    vi.advanceTimersByTime(8_000)
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    const sample = lastSample(onGenStats)
    expect(sample.ttftMs).toBeNull() // 无输出信号 → null（禁 0）
    expect(sample.durationMs).toBe(8_000) // 速度窗口照常（message_start→end 差）
    expect(sent.some((m) => m.type === 'message.stream_error')).toBe(true)
  })

  it('T8 consume 一次性：ttftMs 读后置 null——缺新锚点的后续 usage 不得复用旧值', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'llm-request-start', sessionId: 's1' }])
    vi.advanceTimersByTime(300)
    interp.interpret([{ kind: 'llm-first-output', sessionId: 's1' }])
    interp.interpret([makeTurnUsage()]) // 消费 ttft=300
    interp.interpret([makeTurnUsage()]) // 缺新锚点的后续 usage（异常序）

    expect(onGenStats).toHaveBeenCalledTimes(2)
    expect(onGenStats.mock.calls[0][1].ttftMs).toBe(300)
    expect(lastSample(onGenStats).ttftMs).toBeNull()
  })

  it('G1 分发守卫：未注册 case 的 kind 出声 warn（不静默丢弃）；既有 kind 零 warn', () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { interp } = makeGenStatsInterpreter()

    // 既有 kind 全谱采样（各段分发命中）：不得触发守卫 warn
    interp.interpret([
      { kind: 'noop' },
      { kind: 'turn-start', messageId: 'm1' },
      { kind: 'llm-request-start', sessionId: 's1' },
      { kind: 'llm-first-output', sessionId: 's1' },
      { kind: 'trace-trigger', trigger: 'message_end' },
      { kind: 'thinking-level', level: 'high' },
      { kind: 'session-renamed', name: 'n' },
      { kind: 'hook', eventType: 'agent_start', data: {} },
      { kind: 'agent-settled' },
    ])
    expect(warnSpy).not.toHaveBeenCalled()

    // 未识别 kind（新 kind 漏注册 case 的形态）：warn 出声
    interp.interpret([{ kind: 'totally-unknown' } as unknown as PiTranslatedEvent])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('totally-unknown')
  })
})

describe('agent-settled V7 dev-only 延迟注入（session-dead-structural-fixes U1）', () => {
  const ENV_KEY = 'TAIJI_AGENT_DEV_SETTLING_DELAY_MS'

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('未设开关：agent-settled 同步处理（bash flush + idle 转移立即发生，零行为差异锚）', () => {
    vi.useFakeTimers()
    const onAgentSettled = vi.fn()
    const onOccupancyTransition = vi.fn()
    const { interp } = makeInterpreter({ onAgentSettled, onOccupancyTransition })

    interp.interpret([{ kind: 'agent-settled' }])

    // 三件副作用同步完成，无 timer 在途
    expect(onAgentSettled).toHaveBeenCalledTimes(1)
    expect(onOccupancyTransition).toHaveBeenCalledWith('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('设开关：idle 转移延迟发生——延迟期内 settling 窗口保持（注入点在 settling→idle 转移之前）', async () => {
    vi.useFakeTimers()
    vi.stubEnv(ENV_KEY, '2000')
    const onAgentSettled = vi.fn()
    const onOccupancyTransition = vi.fn()
    const { interp } = makeInterpreter({ onAgentSettled, onOccupancyTransition })

    interp.interpret([{ kind: 'agent-settled' }])

    // 关键时点断言（设计 §4.2 V7 注入点时点约束）：延迟期内转移尚未发生——settling 窗口
    // 保持，预检门可观测到 turn !== 'idle'。若延迟落在转移后（仅延迟广播）本断言即红。
    expect(onAgentSettled).not.toHaveBeenCalled()
    expect(onOccupancyTransition).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)

    // 窗口期满，三件副作用按原序补发（idle 转移 + bash flush）
    expect(onAgentSettled).toHaveBeenCalledTimes(1)
    expect(onOccupancyTransition).toHaveBeenCalledWith('idle')
  })

  it('设开关：延迟不阻塞事件流其他处理（同批次后续事件同步处理）', async () => {
    vi.useFakeTimers()
    vi.stubEnv(ENV_KEY, '2000')
    const onSessionRenamed = vi.fn()
    const onOccupancyTransition = vi.fn()
    const { interp, onAgentSettled } = makeInterpreter({ onSessionRenamed, onOccupancyTransition })

    interp.interpret([{ kind: 'agent-settled' }, { kind: 'session-renamed', name: 'after-settled' }])

    // agent-settled 在延迟在途，同批次后续事件已同步完成
    expect(onSessionRenamed).toHaveBeenCalledTimes(1)
    expect(onAgentSettled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(onOccupancyTransition).toHaveBeenCalledWith('idle')
  })

  it('设开关：延迟窗口内重复 agent-settled → 先同步 flush 前一个再排新 timer（顺序保持、事件不丢，R3 S-3 补测）', async () => {
    vi.useFakeTimers()
    vi.stubEnv(ENV_KEY, '2000')
    const sideEffects: string[] = []
    const onAgentSettled = vi.fn(() => sideEffects.push('settled'))
    const onOccupancyTransition = vi.fn((transition: SessionOccupancyTransition) => sideEffects.push(`occupancy:${transition}`))
    const { interp } = makeInterpreter({ onAgentSettled, onOccupancyTransition })

    interp.interpret([{ kind: 'agent-settled' }])
    expect(vi.getTimerCount()).toBe(1)
    // 物理上极窄（pi 单 run 结束只发一次）的防御路径：重复 settled → 旧 timer clearTimeout，
    // 前一个副作用同步 flush，再排新 timer——timer 数不变（旧清新增）
    interp.interpret([{ kind: 'agent-settled' }])
    expect(onAgentSettled).toHaveBeenCalledTimes(1) // 前一个已同步 flush
    expect(vi.getTimerCount()).toBe(1) // 旧 timer 已清，只剩新 timer
    await vi.advanceTimersByTimeAsync(2000)
    expect(onAgentSettled).toHaveBeenCalledTimes(2)
    // 顺序保持：flush 的在前，新 timer 到点的在后；每个 settled 的三件副作用按原序（flush + idle 转移）
    expect(sideEffects).toEqual(['settled', 'occupancy:idle', 'settled', 'occupancy:idle'])
  })

  it('非法开关值（非数字 / ≤0 / 空串）→ 视为未设，零行为差异', () => {
    vi.useFakeTimers()
    const onAgentSettled = vi.fn()
    const { interp } = makeInterpreter({ onAgentSettled })
    const invalidValues = ['abc', '-5', '0', '']
    invalidValues.forEach((invalid, i) => {
      vi.stubEnv(ENV_KEY, invalid)
      interp.interpret([{ kind: 'agent-settled' }])
      // 每次都同步处理（无延迟在途）：计数随迭代线性增长，无 timer 积压
      expect(onAgentSettled).toHaveBeenCalledTimes(i + 1)
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('缺陷 1 修复：delay ≥ 收敛窗（3000ms）→ 拒绝生效零行为差异（防 settled 被推迟过收敛窗，破坏「掐而 settled 未到」判定）', () => {
    vi.useFakeTimers()
    const onAgentSettled = vi.fn()
    const onOccupancyTransition = vi.fn()
    const { interp } = makeInterpreter({ onAgentSettled, onOccupancyTransition })
    for (const [i, tooLarge] of ['3000', '5000', '60000'].entries()) {
      vi.stubEnv(ENV_KEY, tooLarge)
      interp.interpret([{ kind: 'agent-settled' }])
      // 同步处理（拒绝生效）：delay 达到 ABORT_STALL_CONVERGENCE_WINDOW_MS 量级时，
      // restore-abort 受害 turn 的 settled 会被推迟到收敛窗满之后 → onWindowElapsed 在
      // pendingSettled=false 下误判收敛清标记（设计 v4 ③边界缝确定性重开）
      expect(onAgentSettled).toHaveBeenCalledTimes(i + 1)
      expect(onOccupancyTransition).toHaveBeenCalledWith('idle')
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('缺陷 2 修复：dispose 后在途延迟 timer 到点零副作用（防幽灵 idle 打在同 id restore 的新 session 上）', async () => {
    vi.useFakeTimers()
    vi.stubEnv(ENV_KEY, '2000')
    const onAgentSettled = vi.fn()
    const onOccupancyTransition = vi.fn()
    const { interp } = makeInterpreter({ onAgentSettled, onOccupancyTransition })

    interp.interpret([{ kind: 'agent-settled' }])
    expect(vi.getTimerCount()).toBe(1) // timer 在途
    interp.dispose() // 销毁（生产经 adapter.detach 转调）
    expect(vi.getTimerCount()).toBe(0) // timer 已清

    await vi.advanceTimersByTimeAsync(10_000) // 原定到期点之后
    // 到点零副作用：session 已销毁（同 id 可能已重注册新 interpreter），迟到帧不得打在新记录上
    expect(onAgentSettled).not.toHaveBeenCalled()
    expect(onOccupancyTransition).not.toHaveBeenCalled()
  })

  it('缺陷 2 修复：dispose 后到达的 agent-settled 同步路径同样短路（防御深度）', () => {
    vi.useFakeTimers()
    const onAgentSettled = vi.fn()
    const onOccupancyTransition = vi.fn()
    const { interp } = makeInterpreter({ onAgentSettled, onOccupancyTransition })

    interp.dispose()
    interp.interpret([{ kind: 'agent-settled' }])

    expect(onAgentSettled).not.toHaveBeenCalled()
    expect(onOccupancyTransition).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose 幂等：重复调用不抛、二次 interpret 仍短路', () => {
    vi.useFakeTimers()
    const onOccupancyTransition = vi.fn()
    const { interp } = makeInterpreter({ onOccupancyTransition })
    interp.dispose()
    expect(() => interp.dispose()).not.toThrow()
    interp.interpret([{ kind: 'agent-settled' }])
    expect(onOccupancyTransition).not.toHaveBeenCalled()
  })
})

/**
 * CP6：turn 事件到达即取消命令-only 收口窗口（scheduler-trigger-inversion §11 CP6）。
 *
 * 这里锁 interpreter 侧的接线：`turn-start`（handleTurnLifecycleEvent）与 `hook{agent_start}`
 * （handleMetaEvent）两个挂点必须调用 occupancySettleWindow.cancel——窗口由 dispatcher 武装。
 * 取消用「回调不再触发」行为级断言（而非内部 Map 断言）。
 */
describe('EventInterpreter × CP6 短窗取消接线', () => {
  afterEach(() => {
    occupancySettleWindow.resetForTest()
    vi.useRealTimers()
  })

  it('turn-start 到达 → 取消窗口（到期不再回调）', () => {
    vi.useFakeTimers()
    occupancySettleWindow.resetForTest()
    const onElapsed = vi.fn()
    occupancySettleWindow.arm('s1', onElapsed)
    const { interp } = makeInterpreter()
    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.advanceTimersByTime(OCCUPANCY_SETTLE_WINDOW_MS * 2)
    expect(onElapsed).not.toHaveBeenCalled()
  })

  it('hook{agent_start} 到达 → 取消窗口（到期不再回调）', () => {
    vi.useFakeTimers()
    occupancySettleWindow.resetForTest()
    const onElapsed = vi.fn()
    occupancySettleWindow.arm('s1', onElapsed)
    const { interp } = makeInterpreter()
    interp.interpret([{ kind: 'hook', eventType: 'agent_start', data: {} }])
    vi.advanceTimersByTime(OCCUPANCY_SETTLE_WINDOW_MS * 2)
    expect(onElapsed).not.toHaveBeenCalled()
  })

  it('无 turn 事件（命令-only）→ 窗口如期回调（对照组：取消不是无条件）', () => {
    vi.useFakeTimers()
    occupancySettleWindow.resetForTest()
    const onElapsed = vi.fn()
    occupancySettleWindow.arm('s1', onElapsed)
    const { interp } = makeInterpreter()
    // 无关事件（非 turn）不取消
    interp.interpret([{ kind: 'hook', eventType: 'tool_execution_start', data: {} }])
    vi.advanceTimersByTime(OCCUPANCY_SETTLE_WINDOW_MS)
    expect(onElapsed).toHaveBeenCalledTimes(1)
  })
})
