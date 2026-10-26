/**
 * EventInterpreter 合并测试（cluster runtime-C01：8 文件折叠）。
 *
 * 来源（分节注释见内）：
 * - event-interpreter（原主文件：session-renamed / compaction / gen-stats D3 / TTFT / agent-settled V7）
 * - event-interpreter-file-changes（W18 帧序不变量）
 * - event-interpreter-settled-fallback（RT-4#2/#9 settling 终态兜底 + ping 生命期）
 * - event-interpreter-dispatch-anchor（W3 handle 分发锚定）
 * - event-interpreter-isolation（W1 interpret 事件级隔离）
 * - event-interpreter-subagent-push / event-interpreter-workflow-push（W18 直写退役）
 * - event-interpreter-w3（onTurnUsage / onTurnFinalize 回调）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/event-interpreter.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventInterpreter, PING_INTERVAL_MS } from '../services/session/event-interpreter.js'
import type { GenStatsSample, PiTranslatedEvent, SessionOccupancyTransition } from '../services/session/types.js'
import type { IFileChangeDiff } from '../services/ports/file-change-diff.js'
import type { FileChange, ServerMessage } from '@taiji/shared'

// ════════════════ 来源: event-interpreter.test.ts（原主文件）════════════════
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
  // name 正常值路径的回归钉 = test/event-interpreter-dispatch-anchor.test.ts R7（逐字等价）。
  it('TC-RN2: name undefined → 回调透传 undefined（组合根回落 basename 派生，session-rename-fanout 承载 D4）', () => {
    const { interp, onSessionRenamed } = makeInterpreter()
    interp.interpret([{ kind: 'session-renamed', name: undefined }])
    expect(onSessionRenamed).toHaveBeenCalledWith('s1', undefined)
  })
})

describe('EventInterpreter compaction 编排 (M4 事件驱动)', () => {
  it.each([
    'manual',
    // threshold 透传（驱动前端自动文案，原 TC1-auto 并入）
    'threshold',
  ] as const)('TC1: compaction_start{reason:%s} → session.compacting{reason} + isCompacting=true', (reason) => {
    const onCompactingStateChange = vi.fn()
    const { interp, sent } = makeInterpreter({ onCompactingStateChange })

    interp.interpret([{ kind: 'compaction-start', reason }])

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('session.compacting')
    expect(sent[0].payload).toMatchObject({ sessionId: 's1', status: 'compacting', reason })
    expect(onCompactingStateChange).toHaveBeenCalledWith('s1', true)
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
})

// ── composer-gen-stats LLM 窗口 D3 矩阵（八行表）──
//
// 锁定 U1 状态机回归：turnStartedAt（LLM 窗口起算锚点）+ llmWindowDurationMs（已结算窗口）+
// turn-usage 消费（durationMs 改源，一次性清 null）+ turn-start 重锚清除不变量 +
// assistant message_end role 检查。八行用例与设计 D3 矩阵表逐一对应（U3）。
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

  it('⑧ △他角色 end 混入：start → user/toolResult/custom 的 message_end → 真 assistant end → usage → durationMs=完整窗口（role 检查）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { interp, onGenStats } = makeGenStatsInterpreter()

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    vi.advanceTimersByTime(6_000) // 真窗口：t1 = 7000
    // MESSAGE_END_ALLOWED_ROLES 全量下发：user / toolResult / custom 的 end 帧同经 case 'message'，
    // role 检查必须放过它们不关闭窗口（否则 duration 被截断、锚点被误清）
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('user') }])
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('toolResult') }])
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('custom') }])
    interp.interpret([{ kind: 'message', message: makeMessageEndFrame('assistant') }])
    vi.advanceTimersByTime(99_999) // end → usage 间墙钟不计入
    interp.interpret([makeTurnUsage()])

    expect(onGenStats).toHaveBeenCalledTimes(1)
    // 完整窗口 6000：user/toolResult/custom end 未截断，assistant end 正常封窗
    expect(lastSample(onGenStats).durationMs).toBe(6_000)
  })
})

// ── composer-genstats-ttft TTFT 采样锚点（U2，设计 §3.2 + 场景表 S7）──
//
// 锁定 LlmWindowSampler 双锚点扩展（requestStartedAt / firstOutputAt / ttftMs）：锚点重锚
// 清除、first-wins 幂等、无输出信号即结束 ttftMs=null（无 0 污染）、工具轮重锚（TTFT
// 不含工具执行的契约钉）、error turn 不产脏样本、consume 一次性语义 + 分发检查 warn。
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

  it('G1 分发检查：未注册 case 的 kind 出声 warn（不静默丢弃）；既有 kind 零 warn', () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { interp } = makeGenStatsInterpreter()

    // 既有 kind 全谱采样（各段分发命中）：不得触发检查 warn
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

  it('大 delay 值照常生效（原「delay ≥ 收敛窗拒绝」上界约束随收敛窗删除一并移除，delay 与收敛判定不再耦合）', () => {
    vi.useFakeTimers()
    const onAgentSettled = vi.fn()
    const onOccupancyTransition = vi.fn()
    const { interp } = makeInterpreter({ onAgentSettled, onOccupancyTransition })
    vi.stubEnv(ENV_KEY, '60000')
    interp.interpret([{ kind: 'agent-settled' }])
    // 延迟注入生效：副作用挂 timer（未到点未执行）
    expect(onAgentSettled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    vi.unstubAllEnvs()
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

// [pi1-disposition-chat-flow D3③] 「EventInterpreter × CP6 短窗取消接线」测试组随 CP6
// 回落窗退役整体删除（窗口机制不存在，两挂点取消接线随之消失；occupancy 回落现由
// pi 权威事实驱动——handled 响应即回落，行为锚定移至 session-delivery-registry 侧测试）。

// ════════════════ 来源: event-interpreter-file-changes.test.ts ════════════════
// ---- 原文件头注释 ----
// EventInterpreter file_changes 帧序测试（W18：采集异步化 + 帧序不变量，03 D3-3）。
// 锁定（⛔ 帧序门）：
// - F1: file_changes(accumulating) 帧先于对应 tool_call_end（异步化后显式 await 保持）
// - F2: ready 恒为链尾——accumulating 采集慢于 turn-end 到达时，ready 仍最后发出
// （串行链 by-construction；fire-and-forget 实现会让 ready 抢先 → 断言失败）
// - F3: message.complete 先于 ready（complete 同步转发，ready 排链尾异步）
// - F4: 跨回合代际检查（仅 accumulating）——上回合挂起的 accumulating 在新 turn-start 后
// resolve，帧被丢弃（不串帧）；迟到的 ready 绕过检查恒推，挂旧 messageId
// （W18 review：ready 被 gen 丢弃会让变更集卡永久停在 accumulating）
// - F5: turnFinalizing 压制——turn-end 后迟到的写工具 tool-call-end 不产生 accumulating 帧
// - F6: 非 git 仓库（snapshot → null）→ 零 file_changes 帧
// IFileChangeDiff 用受控 mock（snapshot 可编程挂起/resolve），不真 spawn git。
// /

/** 采集行为哨兵：该次采集保持挂起，测试用 resolveHeld 手动完成（模拟慢 execFile）。 */
const HOLD = Symbol('hold')

/**
 * 受控 IFileChangeDiff mock：
 * - snapshotGitStatus 按调用序消费 behaviors 队列（HOLD = 挂起等手动 resolve）
 * - numstat 注入固定 Map；diffSnapshots/computeLineCounts 为简化真实语义
 */
function createDiffMock() {
  let behaviors: unknown[] = []
  /** 挂起中的 resolve 句柄（按采集次序） */
  const held: Array<(v: unknown) => void> = []
  let numstatMap: Map<string, { add: number | undefined; del: number | undefined; path: string }> | null = null

  const impl: IFileChangeDiff = {
    async snapshotGitStatus(): Promise<unknown> {
      const behavior = behaviors.shift() ?? new Map()
      if (behavior === HOLD) {
        return new Promise<unknown>((resolve) => { held.push(resolve) })
      }
      return behavior
    },
    async numstat() {
      return numstatMap
    },
    diffSnapshots(current: unknown): FileChange[] {
      if (!current) return []
      return Array.from((current as Map<string, FileChange['status']>).entries()).map(
        ([filePath, status]) => ({ filePath, status }),
      )
    },
    computeLineCounts(
      changes: FileChange[],
      numstatMapArg: Map<string, { add: number | undefined; del: number | undefined; path: string }> | null,
    ): void {
      for (const c of changes) {
        const ns = numstatMapArg?.get(c.filePath)
        if (ns) {
          if (ns.add !== undefined) c.addLines = ns.add
          if (ns.del !== undefined) c.delLines = ns.del
        }
      }
    },
  }
  return {
    impl,
    /** 设置后续采集行为队列（每个元素 = 一次采集的返回值；HOLD = 挂起） */
    setBehaviors(next: unknown[]) { behaviors = next },
    /** 手动完成挂起中的第 n 次采集（0-based） */
    resolveHeld(index: number, value: unknown) { held[index]?.(value) },
    setNumstat(map: Map<string, { add: number | undefined; del: number | undefined; path: string }> | null) { numstatMap = map },
  }
}

const snap = (entries: Record<string, FileChange['status']>) => new Map(Object.entries(entries))

/** 排空微任务链：setImmediate 宏任务边界 guarantees 全部微任务（串行 diff 链多层 then）先行完成 */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function makeFcInterpreter(diff: IFileChangeDiff) {
  const sent: ServerMessage[] = []
  const interp = new EventInterpreter('s1', {
    send: (m) => { sent.push(m) },
    cwd: '/repo',
    fileChangeDiff: diff,
  })
  return { interp, sent }
}

const TURN_START = (messageId: string): PiTranslatedEvent => ({ kind: 'turn-start', messageId })
const WRITE_TOOL_END = (toolCallId: string): PiTranslatedEvent => ({
  kind: 'tool-call-end',
  toolCallId,
  output: 'ok',
  details: undefined,
  images: undefined,
  toolName: 'write',
  isError: false,
  entry: {
    type: 'message',
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: 'toolResult', toolCallId, toolName: 'write', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 },
  },
})
const TURN_END = (): PiTranslatedEvent => ({
  kind: 'turn-end',
  message: { type: 'message.complete', payload: { sessionId: 's1' } } as ServerMessage,
  stopReason: 'end',
})

describe('EventInterpreter file_changes 帧序（W18 D3-3）', () => {
  it('F1: accumulating 帧先于对应 tool_call_end（异步化后显式 await 保持）', async () => {
    const mock = createDiffMock()
    mock.setBehaviors([snap({ 'a.ts': 'modified' })])
    const { interp, sent } = makeFcInterpreter(mock.impl)

    interp.interpret([TURN_START('m1'), WRITE_TOOL_END('t1')])
    await flushMicrotasks()

    const seq = sent.map((m) => m.type)
    const fcIdx = seq.indexOf('message.file_changes')
    const tceIdx = seq.indexOf('message.tool_call_end')
    expect(fcIdx).toBeGreaterThanOrEqual(0)
    expect(tceIdx).toBeGreaterThan(fcIdx)
    const fc = sent[fcIdx].payload as { changeSetStatus: string; fileChanges: FileChange[] }
    expect(fc.changeSetStatus).toBe('accumulating')
    expect(fc.fileChanges[0].filePath).toBe('a.ts')
  })

  it('F2+F3: ready 恒为链尾——accumulating 慢于 turn-end 到达时 ready 仍最后发出；complete 先于 ready', async () => {
    const mock = createDiffMock()
    // 第一次采集（accumulating）挂起：turn-end 在它未完成时同步到达（乱序场景）
    mock.setBehaviors([HOLD, snap({ 'a.ts': 'modified' })])
    const { interp, sent } = makeFcInterpreter(mock.impl)

    interp.interpret([TURN_START('m1'), WRITE_TOOL_END('t1'), TURN_END()])
    await flushMicrotasks()
    // turn-end 已同步处理（complete 已发），accumulating 采集仍挂起，ready 排链上等待
    expect(sent.filter((m) => m.type === 'message.file_changes')).toHaveLength(0)
    expect(sent.some((m) => m.type === 'message.complete')).toBe(true)

    // 完成 accumulating 的采集 → 链继续：accumulating 帧 → tool_call_end 帧 → ready 帧
    mock.resolveHeld(0, snap({ 'a.ts': 'modified' }))
    await flushMicrotasks()

    const fcFrames = sent.filter((m) => m.type === 'message.file_changes')
    expect(fcFrames).toHaveLength(2)
    expect((fcFrames[0].payload as { changeSetStatus: string }).changeSetStatus).toBe('accumulating')
    expect((fcFrames[1].payload as { changeSetStatus: string }).changeSetStatus).toBe('ready')
    // accumulating 帧先于其 tool_call_end；ready 恒为链尾（最后一帧）
    const seq = sent.map((m) => m.type)
    expect(seq.indexOf('message.file_changes')).toBeLessThan(seq.indexOf('message.tool_call_end'))
    expect(seq.lastIndexOf('message.file_changes')).toBe(sent.length - 1)
    // complete 先于 ready（⛔ D3-3 断言）
    expect(seq.indexOf('message.complete')).toBeLessThan(seq.lastIndexOf('message.file_changes'))
  })

  it('F4a: 跨回合代际检查（仅 accumulating）——上回合挂起的 accumulating 在新 turn-start 后 resolve，帧被丢弃（不串帧）', async () => {
    const mock = createDiffMock()
    mock.setBehaviors([HOLD])
    const { interp, sent } = makeFcInterpreter(mock.impl)

    interp.interpret([TURN_START('m1'), WRITE_TOOL_END('t1')])
    await flushMicrotasks()
    // 回合 2 开始（turnGen++），回合 1 的 accumulating 采集仍挂起（链上排队）
    interp.interpret([TURN_START('m2')])
    await flushMicrotasks()

    // 回合 1 的 accumulating 采集完成，但 gen 已不匹配 → 丢弃，零 file_changes 帧
    mock.resolveHeld(0, snap({ 'a.ts': 'modified' }))
    await flushMicrotasks()

    expect(sent.filter((m) => m.type === 'message.file_changes')).toHaveLength(0)
    // 丢的是 file_changes 帧，tool_call_end 事件本身照常转发（await 链尾后送出）
    expect(sent.filter((m) => m.type === 'message.tool_call_end')).toHaveLength(1)
  })

  it('F4b: 迟到的 ready 绕过代际检查恒推——ready 排链后 turnGen++ 再 flush，ready 不丢且挂旧 messageId', async () => {
    const mock = createDiffMock()
    // 回合 1 的 accumulating + ready 采集都挂起
    mock.setBehaviors([HOLD, HOLD])
    const { interp, sent } = makeFcInterpreter(mock.impl)

    interp.interpret([TURN_START('m1'), WRITE_TOOL_END('t1'), TURN_END()])
    await flushMicrotasks()
    // 回合 2 开始（turnGen++）——模拟 pi followUp 续跑（triggerTurn）抢在 ready 链段执行前
    interp.interpret([TURN_START('m2')])
    await flushMicrotasks()

    // 回合 1 的 accumulating + ready 采集相继完成：accumulating 被 gen 丢弃，ready 恒推
    mock.resolveHeld(0, snap({ 'a.ts': 'modified' }))
    await flushMicrotasks()
    mock.resolveHeld(1, snap({ 'a.ts': 'modified', 'b.ts': 'added' }))
    await flushMicrotasks()

    // ready 不丢：若无「ready 绕过检查」，本帧被 gen 静默丢弃 → 卡片永久停在 accumulating
    const fcFrames = sent.filter((m) => m.type === 'message.file_changes')
    expect(fcFrames).toHaveLength(1)
    const ready = fcFrames[0].payload as { changeSetStatus: string; messageId: string; fileChanges: FileChange[] }
    expect(ready.changeSetStatus).toBe('ready')
    expect(ready.messageId).toBe('m1') // 挂排链时捕获的旧 messageId，不串新回合
    expect(ready.fileChanges.map((c) => c.filePath).sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('F5: turnFinalizing 压制——turn-end 后迟到的写工具 tool-call-end 不产生 accumulating 帧', async () => {
    const mock = createDiffMock()
    mock.setBehaviors([snap({ 'a.ts': 'modified' }), snap({ 'a.ts': 'modified' })])
    const { interp, sent } = makeFcInterpreter(mock.impl)

    interp.interpret([TURN_START('m1'), WRITE_TOOL_END('t1')])
    await flushMicrotasks()
    interp.interpret([TURN_END()])
    await flushMicrotasks()
    // turn 前段：t1 accumulating + ready
    expect(sent.filter((m) => m.type === 'message.file_changes')).toHaveLength(2)

    // turn-end 后迟到的写工具 tool-call-end（fire-and-forget handler 晚于 turn-end 执行）
    interp.interpret([WRITE_TOOL_END('t2')])
    await flushMicrotasks()

    // accumulating 被压制；tool_call_end 帧本身照常转发
    expect(sent.filter((m) => m.type === 'message.file_changes')).toHaveLength(2)
    expect(sent.filter((m) => m.type === 'message.tool_call_end')).toHaveLength(2)
  })

  it('F6: 非 git 仓库（snapshot → null）→ 零 file_changes 帧（tool_call_end 照常转发）', async () => {
    const mock = createDiffMock()
    mock.setBehaviors([null, null])
    const { interp, sent } = makeFcInterpreter(mock.impl)

    interp.interpret([TURN_START('m1'), WRITE_TOOL_END('t1'), TURN_END()])
    await flushMicrotasks()

    expect(sent.filter((m) => m.type === 'message.file_changes')).toHaveLength(0)
    expect(sent.filter((m) => m.type === 'message.tool_call_end')).toHaveLength(1)
    expect(sent.some((m) => m.type === 'message.complete')).toBe(true)
  })

  it('同一回合多写工具：accumulating 按触发序串行，ready 仍为链尾', async () => {
    const mock = createDiffMock()
    mock.setBehaviors([
      snap({ 'a.ts': 'modified' }),
      snap({ 'a.ts': 'modified', 'b.ts': 'added' }),
      snap({ 'a.ts': 'modified', 'b.ts': 'added' }),
    ])
    const { interp, sent } = makeFcInterpreter(mock.impl)

    interp.interpret([
      TURN_START('m1'),
      WRITE_TOOL_END('t1'),
      WRITE_TOOL_END('t2'),
      TURN_END(),
    ])
    await flushMicrotasks()

    const fcFrames = sent.filter((m) => m.type === 'message.file_changes')
    expect(fcFrames).toHaveLength(3)
    const statuses = fcFrames.map((m) => (m.payload as { changeSetStatus: string }).changeSetStatus)
    expect(statuses).toEqual(['accumulating', 'accumulating', 'ready'])
    // ready 是整个 sent 序列的最后一帧
    expect(sent[sent.length - 1].type).toBe('message.file_changes')
  })
})

// ════════════════ 来源: event-interpreter-settled-fallback.test.ts ════════════════
// ---- 原文件头注释 ----
// [RT-4#2 / RT-4#9] EventInterpreter settling 终态兜底 + ping 生命期 + 未知 kind 检查。
// 锁定三条不变量（code-harden RT-4#2 审计修复）：
// - SC1 settled 副作用抛错（onAgentSettled 的 bash flush publish 炸）→ occupancy 终态
// 'idle' 仍必达（此前 settling→idle 唯一边沿 = agent_settled 处理链，链内抛错 =
// occupancy 永久 settling、消息恒入 defer 队列）。
// - SC2 ping 生命期 = turn-start → agent_settled：turn-end（settling 期）ping 继续
// 探测（pi 收尾挂死时 3 次失败触发 onSilentAbort），settled 处理后停（防 B1 永续）。
// - SC3 未知 kind（类型外运行时构造）落 handleMetaEvent default warn，不静默丢弃。
// （原 RT-4#2③ UserStoppedGate 收敛环代数上限组已随 ADR-0122 时间窗收敛环删除一并
// 移除——「settled 永不到达」场景归 PingProbe → onSilentAbort → forceQuit 显式上报链，
// 锁定用例见下方 settling 期 pi 真死组。）
// /

const SID = 'sid-rt4-settled'

function makeSettledInterpreter(opts: {
  onAgentSettled?: (sessionId: string) => void
  pingPi?: () => Promise<Record<string, unknown> | undefined>
  onOccupancyTransition?: (t: SessionOccupancyTransition) => void
  onSilentAbort?: (p: { sessionId: string }) => void
}) {
  const sent: ServerMessage[] = []
  const interp = new EventInterpreter(SID, {
    send: (m: ServerMessage) => { sent.push(m) },
    onAgentSettled: opts.onAgentSettled,
    pingPi: opts.pingPi,
    onSilentAbort: opts.onSilentAbort,
    onOccupancyTransition: opts.onOccupancyTransition,
  })
  return { interp, sent }
}

describe('[RT-4#2①] settled 副作用抛错 → occupancy 终态 idle 必达', () => {
  it('onAgentSettled 抛错：补写 idle，不中断（settling 不永久滞留）', () => {
    const transitions: SessionOccupancyTransition[] = []
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { interp } = makeSettledInterpreter({
      onAgentSettled: () => { throw new Error('bash flush boom') },
      onOccupancyTransition: (t) => { transitions.push(t) },
    })

    interp.interpret([
      { kind: 'turn-start', messageId: 'm1' },
      { kind: 'turn-end', message: { type: 'message.complete', payload: { sessionId: SID, stopReason: 'end_turn' } }, stopReason: 'end_turn' },
      { kind: 'agent-settled' },
    ])

    // 抛错被隔离：settled 处理链的 'idle' 兜底仍写入（applyAgentSettledEffects 内部
    // 'idle' 未达 → runAgentSettledEffects catch 补写）
    expect(transitions).toContain('idle')
    // 错误落日志（不静默）
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('正常链：settled → idle 写入一次（幂等链路不重复报错）', () => {
    const transitions: SessionOccupancyTransition[] = []
    const { interp } = makeSettledInterpreter({
      onOccupancyTransition: (t) => { transitions.push(t) },
    })
    interp.interpret([{ kind: 'agent-settled' }])
    expect(transitions).toEqual(['idle'])
  })
})

describe('[RT-4#2②] ping 生命期 = turn-start → agent_settled', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('turn-end 后 ping 继续探测（settling 期零探测已消除），agent-settled 后停止', async () => {
    const pingPi = vi.fn(async () => ({ ok: true }) as Record<string, unknown>)
    const { interp } = makeSettledInterpreter({ pingPi })

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(pingPi).toHaveBeenCalledTimes(1)

    // turn-end：settling 期 ping 不停（修复点——原实现此处 stop）
    interp.interpret([
      { kind: 'turn-end', message: { type: 'message.complete', payload: { sessionId: SID, stopReason: 'end_turn' } }, stopReason: 'end_turn' },
    ])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2)
    expect(pingPi).toHaveBeenCalledTimes(3)

    // agent-settled：ping 停止（turn 间不探测，AC-3 语义保留）
    interp.interpret([{ kind: 'agent-settled' }])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 10)
    expect(pingPi).toHaveBeenCalledTimes(3)
  })

  it('settling 期 pi 真死：连续失败达阈值触发 onSilentAbort（settling 期有 no-progress 检测）', async () => {
    const pingPi = vi.fn(async () => undefined) // resolve(undefined) = 计失败（AC-9）
    const onSilentAbort = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { interp } = makeSettledInterpreter({ pingPi, onSilentAbort })

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    interp.interpret([
      { kind: 'turn-end', message: { type: 'message.complete', payload: { sessionId: SID, stopReason: 'end_turn' } }, stopReason: 'end_turn' },
    ])
    // settling 窗内 3 次失败（turn-end 后不再有事件，模拟 pi finally 前挂死）
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3)
    expect(onSilentAbort).toHaveBeenCalledWith({ sessionId: SID })
    warnSpy.mockRestore()
  })

  it('settled 副作用抛错也停 ping（finally 收尾，防 B1 永续）', async () => {
    const pingPi = vi.fn(async () => ({ ok: true }) as Record<string, unknown>)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { interp } = makeSettledInterpreter({
      pingPi,
      onAgentSettled: () => { throw new Error('boom') },
    })

    interp.interpret([{ kind: 'turn-start', messageId: 'm1' }])
    interp.interpret([{ kind: 'agent-settled' }])
    const countAfterSettled = pingPi.mock.calls.length
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 10)
    expect(pingPi.mock.calls.length).toBe(countAfterSettled)
    vi.restoreAllMocks()
  })
})

describe('[RT-4#9] 未知 kind 运行时兜底（default warn，不静默丢弃）', () => {
  it('类型外 kind（未来新增事件漏接线）落 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { interp } = makeSettledInterpreter({})
    // 编译期穷尽检查（assertTranslatedEventHandled）使生产代码不可能构造未知 kind；
    // 运行时防御 = adapter 演进期 / 反序列化边界的类型外值。cast 模拟该形态。
    const futureEvent = { kind: 'future-kind', payload: {} } as unknown as PiTranslatedEvent
    interp.interpret([futureEvent])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unhandled PiTranslatedEvent kind=future-kind'),
    )
    warnSpy.mockRestore()
  })
})

// ════════════════ 来源: event-interpreter-dispatch-anchor.test.ts ════════════════
// ---- 原文件头注释 ----
// EventInterpreter handle 分发特征锚定测试（复杂度债务偿还 W3 批）。
// 背景：handle（原 cyclo 33，22 case 单一 switch）按处理阶段拆为五段 switch
// （handle 主 switch 结构编排 case + handleConversationEvent 对话内容流 +
// handleTurnLifecycleEvent turn 生命周期 + handleRoutingEvent server 路由 +
// handleMetaEvent 元数据与观测 hook，行为保持重构）。现有测试聚焦 turn-usage / turn-end /
// subagent / workflow / watchdog / isolation 通路，本文件补齐路由类与流类 case 的
// 直连分发断言（重构前即缺位的分支，补特征锚定用例防提取引入分发漂移）。
// 断言形态：单事件 → 恰好一次回调/帧、参数逐字段一致；跨分组批次 → 分发顺序保持。
// 纯 mock，无 fs IO。
// /

describe('EventInterpreter · handle 三段分发锚定（W3 复杂度债务偿还）', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  // ── handleRoutingEvent / handleMetaEvent：server 路由与元数据回调类（每 case 恰好一次、参数逐字段一致） ──

  // [pi1-disposition-chat-flow D7①] R3（bridge-ui → onBridgeUIRequest）随 bridge 退役删除
  // （kind 与 option 均已删，编号空位保留登记对账）。
  // R1/R2（setStatus 路由与 WS 透传两用例）随状态栏退役删除
  // （kind 与 option 均已删，编号空位保留登记对账）。

  it('R4: session-manager-ui → onSessionManagerRequest(requestId, sessionId, action, params)', () => {
    const onSessionManagerRequest = vi.fn()
    const interpreter = new EventInterpreter('sid-r4', { send, onSessionManagerRequest })

    interpreter.interpret([{
      kind: 'session-manager-ui', requestId: 'req-2', sessionId: 'evt-sid',
      action: 'list' as never, params: { q: 1 },
    }])

    expect(onSessionManagerRequest).toHaveBeenCalledTimes(1)
    expect(onSessionManagerRequest).toHaveBeenCalledWith('req-2', 'evt-sid', 'list', { q: 1 })
  })

  it('R5: extension-ui → onExtensionUIRequest(requestId, sessionId, method, payload)', () => {
    const onExtensionUIRequest = vi.fn()
    const interpreter = new EventInterpreter('sid-r5', { send, onExtensionUIRequest })

    interpreter.interpret([{ kind: 'extension-ui', requestId: 'req-3', sessionId: 'evt-sid', method: 'confirm', payload: { m: 'confirm' } }])

    expect(onExtensionUIRequest).toHaveBeenCalledTimes(1)
    expect(onExtensionUIRequest).toHaveBeenCalledWith('req-3', 'evt-sid', 'confirm', { m: 'confirm' })
  })

  it('R6: thinking-level → thinkingLevelState()?.markDirty() 失效（事件 payload 不回写）', () => {
    const markDirty = vi.fn()
    const interpreter = new EventInterpreter('sid-r6', { send, thinkingLevelState: () => ({ markDirty }) })

    interpreter.interpret([{ kind: 'thinking-level', level: 'high' }])

    expect(markDirty).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('R7: session-renamed → onSessionRenamed(sessionId, name)', () => {
    const onSessionRenamed = vi.fn()
    const interpreter = new EventInterpreter('sid-r7', { send, onSessionRenamed })

    interpreter.interpret([{ kind: 'session-renamed', name: 'new-name' }])

    expect(onSessionRenamed).toHaveBeenCalledTimes(1)
    expect(onSessionRenamed).toHaveBeenCalledWith('sid-r7', 'new-name')
  })

  it('R8: hook → executeHooks("onPiEvent", {event, ...data})（fire-and-forget）', () => {
    const executeHooks = vi.fn(() => Promise.resolve({ blocked: false }))
    const interpreter = new EventInterpreter('sid-r8', { send, executeHooks })

    interpreter.interpret([{ kind: 'hook', eventType: 'agent_start', data: { extra: 1 } }])

    expect(executeHooks).toHaveBeenCalledTimes(1)
    expect(executeHooks).toHaveBeenCalledWith('onPiEvent', { event: 'agent_start', extra: 1 })
  })

  // ── handleConversationEvent / handleTurnLifecycleEvent：对话流与 turn 生命周期类 ──

  it('S1: subagent-stream → subagent.stream_delta WS 帧（sessionId/recordId/lines 透传）', () => {
    const interpreter = new EventInterpreter('sid-s1', { send })

    interpreter.interpret([{ kind: 'subagent-stream', sessionId: 'virt-1', recordId: 'rec-1', lines: ['a', 'b'] }])

    expect(sent).toEqual([{
      type: 'subagent.stream_delta',
      payload: { sessionId: 'virt-1', recordId: 'rec-1', lines: ['a', 'b'] },
    }])
  })

  it('S2: agent-settled → onAgentSettled(sessionId) 恰好一次', () => {
    const onAgentSettled = vi.fn()
    const interpreter = new EventInterpreter('sid-s2', { send, onAgentSettled })

    interpreter.interpret([{ kind: 'agent-settled' }])

    expect(onAgentSettled).toHaveBeenCalledTimes(1)
    expect(onAgentSettled).toHaveBeenCalledWith('sid-s2')
  })

  it('S3: trace-trigger → onTraceSync(sessionId, trigger)', () => {
    const onTraceSync = vi.fn()
    const interpreter = new EventInterpreter('sid-s3', { send, onTraceSync })

    interpreter.interpret([{ kind: 'trace-trigger', trigger: 'message_end' }])

    expect(onTraceSync).toHaveBeenCalledTimes(1)
    expect(onTraceSync).toHaveBeenCalledWith('sid-s3', 'message_end')
  })

  it('S4: noop → 零帧零回调（无产出）', () => {
    const onAgentSettled = vi.fn()
    const interpreter = new EventInterpreter('sid-s4', { send, onAgentSettled })

    interpreter.interpret([{ kind: 'noop' }])

    expect(sent).toEqual([])
    expect(onAgentSettled).not.toHaveBeenCalled()
  })

  // ── 跨分组分发顺序（批内顺序保持 = 单一 switch 等价性） ───────────

  it('O1: 混合批次 [session-renamed, turn-usage, message] → 分发顺序与批次顺序一致', () => {
    const callOrder: string[] = []
    const onSessionRenamed = vi.fn(() => { callOrder.push('session-renamed') })
    const onContextUpdate = vi.fn(() => { callOrder.push('turn-usage') })
    const interpreter = new EventInterpreter('sid-o1', { send, onSessionRenamed, onContextUpdate })
    const msgFrame: ServerMessage = { type: 'message.delta' as ServerMessage['type'], payload: { sessionId: 'sid-o1' } }

    interpreter.interpret([
      { kind: 'session-renamed', name: 'new-label' },
      // gen-stats D1/D2：turn-usage 携带样本六字段（composer-gen-stats 事件契约扩展）
      { kind: 'turn-usage', sessionId: 'x', inputTokens: 1, totalTokens: 1, outputTokens: null, cacheRead: null, cacheWrite: null, input: null, model: null, provider: null },
      { kind: 'message', message: msgFrame },
    ])

    expect(callOrder).toEqual(['session-renamed', 'turn-usage'])
    // message 帧最后透传（帧序保持）
    expect(sent).toEqual([msgFrame])
  })

  it('O2: 混合批次 [turn-start, tool-call-index, agent-settled] → 结构编排 case 与流 case 混排不乱序', () => {
    const onAgentSettled = vi.fn()
    const interpreter = new EventInterpreter('sid-o2', { send, onAgentSettled })

    interpreter.interpret([
      { kind: 'turn-start', messageId: 'm-1' },
      { kind: 'tool-call-index', toolCallId: 'tc-1', contentIndex: 3 },
      { kind: 'agent-settled' },
    ])

    // turn-start 副作用齐发（messageId 记录 + ping 循环启动，watchdog 通路另有专测）
    expect(onAgentSettled).toHaveBeenCalledTimes(1)
    // tool-call-index 锚点入缓存：随后 tool-call-start 可消费（分发落主 switch）
    interpreter.interpret([{
      kind: 'tool-call-start', toolCallId: 'tc-1', toolName: 'read', input: {},
      entry: { id: 'e1', type: 'toolCall' } as never,
    }])
    // 异步 handler flush
    return Promise.resolve().then(() => {
      const startFrame = sent.find(m => m.type === 'message.tool_call_start')
      expect(startFrame).toBeDefined()
      expect((startFrame!.payload as { entry: { contentIndex?: number } }).entry.contentIndex).toBe(3)
    })
  })
})

// ════════════════ 来源: event-interpreter-isolation.test.ts ════════════════
// ---- 原文件头注释 ----
// W1 TDD 测试：EventInterpreter.interpret() 的 per-event try-catch（事件级隔离）。
// 背景：interpret() 当前是「裸 for 循环」调 handle()，无 try-catch。
// EventAdapter.attach() 虽然在「整批事件」外有 try-catch（隔离整批失败），
// 但 interpret 一次会处理多个 PiTranslatedEvent——若其中第 N 个事件触发 handler 抛错
// （如 send 回调被 mock 成抛、或某个 details 形状异常），for 循环会被中断，
// 后续事件（含关键的 turn-end / agent_end）被吞掉，导致：
// - isGenerating 永不复位（onTurnFinalize 未触发）
// - message.complete 不送达前端（streaming 永远不停）
// W1 改动：interpret() 内对每个事件包 try-catch，单事件失败仅记日志不中断批次。
// [红灯说明] 当前 interpret() 无 per-event try-catch，第 2 个事件抛错会中断 for 循环 →
// 第 3 个事件不被处理 → 断言失败。加 try-catch 后应转绿。
// /

describe('EventInterpreter · W1 interpret 循环事件级隔离', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
  })

  /** 构造一个会被正常转发的 message 事件（带唯一 tag 便于断言被处理）。 */
  function taggedMessage(tag: string): PiTranslatedEvent {
    return {
      kind: 'message',
      message: { type: 'message.text_delta', payload: { sessionId: 'sid-iso', delta: tag } },
    }
  }

  /** 构造一个会触发 send 抛错的 message 事件。 */
  function throwingMessage(): PiTranslatedEvent {
    return {
      kind: 'message',
      message: { type: 'message.text_delta', payload: { sessionId: 'sid-iso', delta: 'throw' } },
    }
  }

  /** 构造一个 turn-end（agent_end）事件。 */
  function turnEnd(): PiTranslatedEvent {
    return {
      kind: 'turn-end',
      message: {
        type: 'message.complete',
        payload: { sessionId: 'sid-iso', stopReason: 'end_turn' },
      },
      stopReason: 'end_turn',
    }
  }

  // ── ISO1：单个事件抛错不中断批次 ──────────────────────────────
  it('ISO1: 3 个事件中第 2 个触发 handler 抛错 → 第 3 个事件仍被处理', () => {
    // send 在收到 delta='throw' 时抛错，其余正常入栈
    send = (msg) => {
      const delta = (msg.payload as { delta?: string } | undefined)?.delta
      if (delta === 'throw') throw new Error('boom from send')
      sent.push(msg)
    }
    const onTurnFinalize = vi.fn()
    const interpreter = new EventInterpreter('sid-iso', { send, onTurnFinalize })

    // 同一批 interpret：ev1 正常 → ev2 抛错 → ev3 必须仍被处理（W1 隔离）
    interpreter.interpret([
      taggedMessage('first'),
      throwingMessage(),
      taggedMessage('third'),
    ])

    // 第 1 个与第 3 个事件都已入栈（第 2 个被隔离吞掉）
    const deltas = sent.map((m) => (m.payload as { delta?: string }).delta)
    expect(deltas).toContain('first')
    expect(deltas).toContain('third')
  })

  // ── ISO2：turn-end 不被前面抛错事件吞掉 ──────────────────────
  it('ISO2: 抛错 message 事件 + turn-end 同批 → onTurnFinalize 仍被调用（isGenerating 复位不被吞）', () => {
    send = (msg) => {
      const delta = (msg.payload as { delta?: string } | undefined)?.delta
      if (delta === 'throw') throw new Error('boom before turn-end')
      sent.push(msg)
    }
    const onTurnFinalize = vi.fn()
    const interpreter = new EventInterpreter('sid-iso', { send, onTurnFinalize })

    interpreter.interpret([
      throwingMessage(),
      turnEnd(),
    ])

    // turn-end 的 onTurnFinalize（occupancy 终态收口）必须被触发，否则 session 永远占用
    expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    // onTurnFinalize 签名 (sessionId, stopReason?, willRetry?) —— 正常 turn-end 路径传
    // stopReason + willRetry（本用例载荷无 willRetry 字段 → false）
    expect(onTurnFinalize).toHaveBeenCalledWith('sid-iso', 'end_turn', false)
  })

  // ── ISO3：turn-end 自己抛错时 onTurnFinalize 兜底复位（B2 核心） ──
  it('ISO3: turn-end handler 自身抛错 → onTurnFinalize 仍被兜底调用（isGenerating 不永久 busy）', () => {
    // send 在处理 turn-end（message.complete）时抛错——模拟 send 回调抛 / details 形状异常
    send = (msg) => {
      if (msg.type === 'message.complete') throw new Error('boom inside turn-end')
      sent.push(msg)
    }
    const onTurnFinalize = vi.fn()
    const interpreter = new EventInterpreter('sid-iso', { send, onTurnFinalize })

    interpreter.interpret([turnEnd()])

    // B2: 即使 turn-end 自身 handler 抛错，catch 兜底也必须调 onTurnFinalize，
    // 否则 occupancy 永不复位 → session 永久占用（AGENTS.md 规则 #3）
    // S4：catch 兜底也传 stopReason（对齐正常路径 + handleTurnEndSideEffects 的 outcome 映射）
    // willRetry 同源透传（handleIsolatedEventError 与 handleTurnEnd 读同一帧载荷 → false）
    expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    expect(onTurnFinalize).toHaveBeenCalledWith('sid-iso', 'end_turn', false)
  })
})

// ════════════════ 来源: event-interpreter-subagent-push.test.ts ════════════════
// ---- 原文件头注释 ----
// W18 tests：EventInterpreter subagent 事件 → 派生缓存失效信号。
// 背景（W18 data-source-governance P3.1，D4）：subagent 列表数据源切换为
// 「entry_appended 失效 → get_entries(since) 增量重新拉取 → entry 扫描派生缓存」。
// interpreter 的 subagent 事件流（tool-call-end 建 running / bg-notify 合并终态）
// 直写退役**——全部降级为失效信号（onRecordEntriesInvalidated，组合根注入
// sessionService.invalidateRecordEntries）。数据合并语义（status 归一 / agent 覆盖 /
// closedReason 派生视图 / batch 合并）由 entry 扫描承载（subagent-extractor.test.ts 的
// scanSubagentEntries 用例 + session-record-entries.test.ts 的拉取收敛用例）。
// U1：subagent tool-call-end → 失效回调（不产 session.subagents 帧）
// U2：bg-notify（single/batch）customStart → 失效回调 + customStart 帧照发前端
// U3：非 subagent 工具不触发失效
// U4：record-entry-appended 主信号 → 失效回调
// /

describe('EventInterpreter · subagent 事件 → 派生缓存失效（W18 直写退役）', () => {
  let sent: ServerMessage[]
  let invalidations: Array<{ sessionId: string; customType: string }>
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    invalidations = []
    send = (msg) => { sent.push(msg) }
  })

  function makeInterpreter(sessionId: string): EventInterpreter {
    return new EventInterpreter(sessionId, {
      send,
      onRecordEntriesInvalidated: (sid, customType) => { invalidations.push({ sessionId: sid, customType }) },
    })
  }

  /** 构造 subagent tool-call-end 事件（W12 曾直写建 running 记录的事件流） */
  function subagentEnd(toolCallId: string, details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'tool-call-end',
      toolCallId,
      toolName: 'subagent',
      output: JSON.stringify(details),
      details,
      images: undefined,
      isError: false,
      entry: {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'toolResult', toolCallId, toolName: 'subagent', content: JSON.stringify(details), isError: false, details, timestamp: 0 },
      },
    }
  }

  /** 构造 customStart message 事件（bg-notify 载体） */
  function customStart(sessionId: string, customType: string, details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'message',
      message: {
        type: 'message.customStart',
        payload: { sessionId, customType, details },
      } as ServerMessage,
    }
  }

  // ── U1：subagent tool-call-end → 失效回调 ──────────────────────
  it('U1: subagent tool-call-end → 失效 subagent-record，不产 session.subagents 帧（直写退役）', () => {
    const interpreter = makeInterpreter('sid-u1')

    interpreter.interpret([
      subagentEnd('call-1', {
        action: 'start',
        subagentId: 'bg-1-123',
        sessionFile: '/data/sub.jsonl',
        bgResponse: { status: 'running', message: 'detached' },
      }),
    ])

    expect(invalidations).toEqual([{ sessionId: 'sid-u1', customType: 'subagent-record' }])
    // 数据不进事件侧缓存：无 session.subagents 帧（发布归 sessionService 拉取收敛后）
    expect(sent.filter((m) => m.type === 'session.subagents')).toHaveLength(0)
    // 通用 tool_call_end WS 帧照常产出
    expect(sent.some((m) => m.type === 'message.tool_call_end')).toBe(true)
  })

  // ── U2：bg-notify → 失效回调 + customStart 帧照发 ──────────────
  describe('U2: bg-notify customStart → 失效回调（数据合并归 entry 扫描）', () => {
    it('single 形态 bg-notify → 失效 + customStart 帧转发前端（BgNotifyCard 渲染不受退役影响）', () => {
      const interpreter = makeInterpreter('sid-u2')

      interpreter.interpret([
        customStart('sid-u2', 'subagent-bg-notify', {
          id: 'bg-1-123', status: 'closed', agent: 'reviewer', model: 'glm-5.2',
          startedAt: 1000, endedAt: 2000, closedReason: 'gc',
        }),
      ])

      expect(invalidations).toEqual([{ sessionId: 'sid-u2', customType: 'subagent-record' }])
      const frames = sent.filter((m) => m.type === 'message.customStart')
      expect(frames).toHaveLength(1)
      expect((frames[0]!.payload as { customType?: string }).customType).toBe('subagent-bg-notify')
      expect(sent.filter((m) => m.type === 'session.subagents')).toHaveLength(0)
    })

    it('batch 形态 bg-notify → 同样一次失效（防抖合并由 sessionService 承接）', () => {
      const interpreter = makeInterpreter('sid-u2b')

      interpreter.interpret([
        customStart('sid-u2b', 'subagent-bg-notify', {
          batch: true,
          items: [
            { id: 'bg-a-1', status: 'closed', agent: 'worker', startedAt: 1000, endedAt: 2000 },
            { id: 'bg-b-2', status: 'closed', agent: 'researcher', startedAt: 1100, endedAt: 2200 },
          ],
        }),
      ])

      expect(invalidations).toEqual([{ sessionId: 'sid-u2b', customType: 'subagent-record' }])
    })
  })

  // ── U3：非 subagent 工具不触发失效 ─────────────────────────────
  it('U3: 非 subagent 工具的 tool-call-end 不触发失效', () => {
    const interpreter = makeInterpreter('sid-u3')

    interpreter.interpret([
      {
        kind: 'tool-call-end',
        toolCallId: 'call-other',
        toolName: 'read',
        output: 'ok',
        details: { action: 'start', subagentId: 'bg-x' },
        images: undefined,
        isError: false,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'toolResult', toolCallId: 'call-other', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 },
        },
      },
    ])

    expect(invalidations).toHaveLength(0)
  })

  // ── U4：record-entry-appended 主信号 ───────────────────────────
  it('U4: record-entry-appended（entry_appended 主信号翻译产物）→ 失效回调', () => {
    const interpreter = makeInterpreter('sid-u4')

    interpreter.interpret([{ kind: 'record-entry-appended', customType: 'subagent-record' }])

    expect(invalidations).toEqual([{ sessionId: 'sid-u4', customType: 'subagent-record' }])
    expect(sent.filter((m) => m.type === 'session.subagents')).toHaveLength(0)
  })

  it('U5: 无关 customType 的 customStart 不触发失效（检查保持）', () => {
    const interpreter = makeInterpreter('sid-u5')

    interpreter.interpret([customStart('sid-u5', 'unrelated-notify', { id: 'x' })])

    expect(invalidations).toHaveLength(0)
  })
})

// ════════════════ 来源: event-interpreter-w3.test.ts ════════════════
// ---- 原文件头注释 ----
// W3 TDD tests：EventInterpreter 新回调 onTurnUsage / onTurnFinalize（U6 + U7）。
// 背景：W3 收尾第二条 pi 事件订阅（attachUsageListener），把副作用
// （isGenerating 复位 / tokenCount 写入等）迁移到中间事件链路。
// EventInterpreter 两个可选回调：
// - onTurnUsage(sessionId)：pi turn_end 触发（turn 级副作用：project sidecar 兜底等；
// label 持久化 W1 起移交 pi set_session_name RPC，不再经此链路直写）
// - onTurnFinalize(sessionId)：pi agent_end 触发（复位 isGenerating=false + 终态副作用）
// U6：turn-end / turn-usage handler 调用新回调（各调一次含 sessionId）。
// U7：副作用经中间事件链路保留（onTurnFinalize→handleTurnEndSideEffects 复位 isGenerating；
// onContextUpdate 含 totalTokens→applyContextUpdate 写入 tokenCount）。
// /

describe('EventInterpreter · W3 onTurnUsage / onTurnFinalize 回调', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  // ── U6：turn-usage（pi turn_end）调 onTurnUsage ──────────────────
  describe('U6: turn-usage handler 调 onTurnUsage（pi turn_end 主路径）', () => {
    it('turn-usage 事件触发 onTurnUsage 回调一次，参数含 sessionId', () => {
      const onTurnUsage = vi.fn()
      const onContextUpdate = vi.fn()
      const interpreter = new EventInterpreter('sid-u6a', { send, onContextUpdate, onTurnUsage })

      const ev: PiTranslatedEvent = {
        kind: 'turn-usage',
        sessionId: 'sid-u6a',
        inputTokens: 163628,
        totalTokens: 163628,
        outputTokens: null,
        cacheRead: null,
        cacheWrite: null,
        input: null,
        model: null,
        provider: null,
      }
      interpreter.interpret([ev])

      // onTurnUsage 调一次，参数是 interpreter 持有的 sessionId
      expect(onTurnUsage).toHaveBeenCalledTimes(1)
      expect(onTurnUsage).toHaveBeenCalledWith('sid-u6a')
    })

    it('turn-usage 先调 onContextUpdate 再调 onTurnUsage（顺序：用量回写在前，持久化在后）', () => {
      const callOrder: string[] = []
      const onContextUpdate = vi.fn(() => { callOrder.push('onContextUpdate') })
      const onTurnUsage = vi.fn(() => { callOrder.push('onTurnUsage') })
      const interpreter = new EventInterpreter('sid-order', { send, onContextUpdate, onTurnUsage })

      interpreter.interpret([{
        kind: 'turn-usage',
        sessionId: 'sid-order',
        inputTokens: 100,
        totalTokens: 100,
        outputTokens: null,
        cacheRead: null,
        cacheWrite: null,
        input: null,
        model: null,
        provider: null,
      }])

      expect(callOrder).toEqual(['onContextUpdate', 'onTurnUsage'])
    })

    it('未注入 onTurnUsage 时不抛错（可选回调）', () => {
      const onContextUpdate = vi.fn()
      const interpreter = new EventInterpreter('sid-noop', { send, onContextUpdate })

      expect(() => interpreter.interpret([{
        kind: 'turn-usage', sessionId: 'sid-noop', inputTokens: 10, totalTokens: 10,
        outputTokens: null, cacheRead: null, cacheWrite: null, input: null, model: null, provider: null,
      }])).not.toThrow()
      expect(onContextUpdate).toHaveBeenCalledTimes(1)
    })
  })

  // ── U6：turn-end（pi agent_end）调 onTurnFinalize ────────────────
  describe('U6: turn-end handler 调 onTurnFinalize（pi agent_end）', () => {
    it('turn-end 事件触发 onTurnFinalize 回调一次，参数含 sessionId', async () => {
      const onTurnFinalize = vi.fn()
      const interpreter = new EventInterpreter('sid-u6b', { send, onTurnFinalize })

      const completeMsg: ServerMessage = {
        type: 'message.complete',
        payload: { sessionId: 'sid-u6b', stopReason: 'end_turn' },
      }
      const ev: PiTranslatedEvent = {
        kind: 'turn-end',
        message: completeMsg,
        inputTokens: 5000,
        totalTokens: 5000,
        stopReason: 'end_turn',
      }
      interpreter.interpret([ev])
      // handleTurnEnd 返回 Promise（虽然同步执行），flush 微任务
      await new Promise<void>(r => setTimeout(r, 0))

      expect(onTurnFinalize).toHaveBeenCalledTimes(1)
      // onTurnFinalize 签名 (sessionId, stopReason?, willRetry?) —— 正常 turn-end 路径传
      // stopReason + willRetry（本用例载荷无 willRetry 字段 → false）
      expect(onTurnFinalize).toHaveBeenCalledWith('sid-u6b', 'end_turn', false)
    })

    it('turn-end 先转发 message.complete 再调 onTurnFinalize', async () => {
      const onTurnFinalize = vi.fn()
      const interpreter = new EventInterpreter('sid-te-order', { send, onTurnFinalize })

      const completeMsg: ServerMessage = {
        type: 'message.complete',
        payload: { sessionId: 'sid-te-order', stopReason: 'end_turn' },
      }
      interpreter.interpret([{ kind: 'turn-end', message: completeMsg, totalTokens: 0 }])
      await new Promise<void>(r => setTimeout(r, 0))

      // message.complete 已转发
      expect(sent.find(m => m.type === 'message.complete')).toBeDefined()
      // onTurnFinalize 调一次
      expect(onTurnFinalize).toHaveBeenCalledTimes(1)
    })

    it('未注入 onTurnFinalize 时不抛错（可选回调）', async () => {
      const interpreter = new EventInterpreter('sid-noop-te', { send })
      const completeMsg: ServerMessage = {
        type: 'message.complete',
        payload: { sessionId: 'sid-noop-te', stopReason: 'end_turn' },
      }
      expect(() => interpreter.interpret([{ kind: 'turn-end', message: completeMsg }])).not.toThrow()
      await new Promise<void>(r => setTimeout(r, 0))
      expect(sent.find(m => m.type === 'message.complete')).toBeDefined()
    })
  })
})

// ════════════════ 来源: event-interpreter-workflow-push.test.ts ════════════════
// ---- 原文件头注释 ----
// W18 tests：EventInterpreter workflow 事件 → 派生缓存失效信号。
// 背景（W18 data-source-governance P3.1，D4）：workflow 列表数据源切换为
// 「entry_appended 失效 → get_entries(since) 增量重新拉取 → entry 扫描派生缓存」。
// interpreter 的 workflow 事件流（tool-call-end 发起 running / workflow-result 终态）
// 直写退役**——降级为失效信号（onRecordEntriesInvalidated）。增量信号帧
// session.workflowUpdate 的发布归 sessionService 拉取收敛后的状态 diff（含
// running/done/reason 语义，见 session-record-entries.test.ts）。
// U1：workflow tool-call-end → 失效回调（不产 session.workflowUpdate 帧）
// U2：workflow-result customStart → 失效回调 + customStart 帧照发前端
// U3：非 workflow tool / 无关 customType 不触发失效
// U4：W09 快速路径 customType 护栏（带 customType 的 delta 回落完整检查路径）
// /

describe('EventInterpreter · workflow 事件 → 派生缓存失效（W18 直写退役）', () => {
  let sent: ServerMessage[]
  let invalidations: Array<{ sessionId: string; customType: string }>
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    invalidations = []
    send = (msg) => { sent.push(msg) }
  })

  function makeInterpreter(sessionId: string): EventInterpreter {
    return new EventInterpreter(sessionId, {
      send,
      onRecordEntriesInvalidated: (sid, customType) => { invalidations.push({ sessionId: sid, customType }) },
    })
  }

  /** 构造 workflow tool-call-end 事件（W12 曾直写 running 信号的事件流） */
  function workflowEnd(details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'tool-call-end',
      toolCallId: 'call-wf-1',
      toolName: 'workflow',
      output: JSON.stringify(details),
      details,
      images: undefined,
      isError: false,
      entry: {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'toolResult', toolCallId: 'call-wf-1', toolName: 'workflow', content: JSON.stringify(details), isError: false, details, timestamp: 0 },
      },
    }
  }

  /** 构造 customStart message 事件 */
  function customStart(customType: string, details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'message',
      message: {
        type: 'message.customStart',
        payload: {
          sessionId: 'sid-wf',
          customType,
          content: 'test',
          details,
        },
      },
    }
  }

  /** 从 sent 里提取 session.workflowUpdate 消息 */
  function findWorkflowUpdate(): ServerMessage | undefined {
    return sent.find((m) => m.type === 'session.workflowUpdate')
  }

  // ── U1：workflow tool-call-end → 失效回调 ──────────────────────
  it('U1: workflow tool-call-end → 失效 workflow-record，不产 session.workflowUpdate 帧（直写退役）', () => {
    const interpreter = makeInterpreter('sid-wf')

    interpreter.interpret([
      workflowEnd({ action: 'run', runId: 'wf-test-001', status: 'running', name: 'deploy-flow' }),
    ])

    expect(invalidations).toEqual([{ sessionId: 'sid-wf', customType: 'workflow-record' }])
    expect(findWorkflowUpdate()).toBeUndefined()
    // 通用 tool_call_end WS 帧照常产出
    expect(sent.some((m) => m.type === 'message.tool_call_end')).toBe(true)
  })

  // ── U2：workflow-result customStart → 失效回调 + 帧照发 ────────
  it('U2: workflow-result customStart → 失效 + customStart 帧转发前端（完成 turn 注入渲染不受影响）', () => {
    const interpreter = makeInterpreter('sid-wf')

    interpreter.interpret([
      customStart('workflow-result', {
        runId: 'wf-test-002',
        name: 'test-flow',
        status: 'done',
        reason: 'completed',
        traceLength: 3,
      }),
    ])

    expect(invalidations).toEqual([{ sessionId: 'sid-wf', customType: 'workflow-record' }])
    const frames = sent.filter((m) => m.type === 'message.customStart')
    expect(frames).toHaveLength(1)
    expect((frames[0]!.payload as { customType?: string }).customType).toBe('workflow-result')
    expect(findWorkflowUpdate()).toBeUndefined()
  })

  // ── U3：检查语义保持 ────────────────────────────────────────────
  it('U3: 非 workflow tool 的 tool-call-end 不触发失效', () => {
    const interpreter = makeInterpreter('sid-wf')

    interpreter.interpret([
      {
        kind: 'tool-call-end',
        toolCallId: 'call-other',
        toolName: 'read',
        output: 'ok',
        details: { action: 'run', runId: 'wf-x', status: 'running' },
        images: undefined,
        isError: false,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'toolResult', toolCallId: 'call-other', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, details: { action: 'run', runId: 'wf-x', status: 'running' }, timestamp: 0 },
        },
      },
    ])

    expect(invalidations).toHaveLength(0)
  })

  it('U3b: 无关 customType（subagent-bg-notify）不触发 workflow 失效（定向检查保持）', () => {
    const interpreter = makeInterpreter('sid-wf')

    interpreter.interpret([
      customStart('subagent-bg-notify', { id: 'bg-1', status: 'closed' }),
    ])

    expect(invalidations).toEqual([{ sessionId: 'sid-wf', customType: 'subagent-record' }])
  })

  // ── U4：W09 快速路径 customType 护栏 ───────────────────────────
  describe('W09 微项 4 快速路径 customType 护栏', () => {
    /** 构造 text_delta message 事件（可选注入 customType 模拟未来新增产出点） */
    function textDelta(payloadExtra?: Record<string, unknown>): PiTranslatedEvent {
      return {
        kind: 'message',
        message: {
          type: 'message.text_delta',
          payload: { sessionId: 'sid-wf', delta: 'x', ...payloadExtra },
        },
      }
    }

    it('无 customType 的 text_delta 走快速路径：只 send 一次，零失效（纯转发）', () => {
      const interpreter = makeInterpreter('sid-wf')

      interpreter.interpret([textDelta()])

      expect(sent).toHaveLength(1)
      expect(sent[0]!.type).toBe('message.text_delta')
      expect(invalidations).toHaveLength(0)
    })

    it('带 customType 的 text_delta 回落完整检查路径：workflow-result 失效生效', () => {
      const interpreter = makeInterpreter('sid-wf')

      // 模拟未来新增「带 customType 的 delta 产出点」：护栏必须使其绕开快速路径，
      // 否则 workflow 检查函数被静默跳过（W09 review 指出的绕过风险）。
      interpreter.interpret([
        textDelta({ customType: 'workflow-result', details: { runId: 'wf-guard-1', status: 'done', reason: 'completed' } }),
      ])

      // delta 本身仍被转发（完整路径的 message 分支同样 send）+ 失效被触发
      expect(sent).toHaveLength(1)
      expect(sent[0]!.type).toBe('message.text_delta')
      expect(invalidations).toEqual([{ sessionId: 'sid-wf', customType: 'workflow-record' }])
    })
  })
})
