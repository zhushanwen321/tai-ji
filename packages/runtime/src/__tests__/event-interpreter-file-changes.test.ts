/**
 * EventInterpreter file_changes 帧序测试（W18：采集异步化 + 帧序不变量，03 D3-3）。
 *
 * 锁定（⛔ 帧序门）：
 * - F1: file_changes(accumulating) 帧先于对应 tool_call_end（异步化后显式 await 保持）
 * - F2: ready 恒为链尾——accumulating 采集慢于 turn-end 到达时，ready 仍最后发出
 *       （串行链 by-construction；fire-and-forget 实现会让 ready 抢先 → 断言失败）
 * - F3: message.complete 先于 ready（complete 同步转发，ready 排链尾异步）
 * - F4: 跨回合代际守卫（仅 accumulating）——上回合挂起的 accumulating 在新 turn-start 后
 *       resolve，帧被丢弃（不串帧）；迟到的 ready 绕过守卫恒推，挂旧 messageId
 *       （W18 review：ready 被 gen 丢弃会让变更集卡永久停在 accumulating）
 * - F5: turnFinalizing 压制——turn-end 后迟到的写工具 tool-call-end 不产生 accumulating 帧
 * - F6: 非 git 仓库（snapshot → null）→ 零 file_changes 帧
 *
 * IFileChangeDiff 用受控 mock（snapshot 可编程挂起/resolve），不真 spawn git。
 *
 * 运行：npx vitest run src/__tests__/event-interpreter-file-changes.test.ts
 */
import { describe, it, expect } from 'vitest'
import { EventInterpreter } from '../services/session/event-interpreter.js'
import type { PiTranslatedEvent } from '../services/session/types.js'
import type { IFileChangeDiff } from '../services/ports/file-change-diff.js'
import type { FileChange, ServerMessage } from '@taiji/shared'

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

function makeInterpreter(diff: IFileChangeDiff) {
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
    const { interp, sent } = makeInterpreter(mock.impl)

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
    const { interp, sent } = makeInterpreter(mock.impl)

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

  it('F4a: 跨回合代际守卫（仅 accumulating）——上回合挂起的 accumulating 在新 turn-start 后 resolve，帧被丢弃（不串帧）', async () => {
    const mock = createDiffMock()
    mock.setBehaviors([HOLD])
    const { interp, sent } = makeInterpreter(mock.impl)

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

  it('F4b: 迟到的 ready 绕过代际守卫恒推——ready 排链后 turnGen++ 再 flush，ready 不丢且挂旧 messageId', async () => {
    const mock = createDiffMock()
    // 回合 1 的 accumulating + ready 采集都挂起
    mock.setBehaviors([HOLD, HOLD])
    const { interp, sent } = makeInterpreter(mock.impl)

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

    // ready 不丢：若无「ready 绕过守卫」，本帧被 gen 静默丢弃 → 卡片永久停在 accumulating
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
    const { interp, sent } = makeInterpreter(mock.impl)

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
    const { interp, sent } = makeInterpreter(mock.impl)

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
    const { interp, sent } = makeInterpreter(mock.impl)

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
