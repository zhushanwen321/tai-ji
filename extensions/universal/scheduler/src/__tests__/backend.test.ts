import { describe, expect, it } from 'vitest'

import { MockSchedulerBackend } from './mock-backend.js'
import { SchedulerRuntime } from '../runtime.js'
import type { SchedulerEntryOp, TaskSnapshot } from '../types.js'

/** 构造 base task 快照（upsert op 用）。 */
function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'aaa',
    name: 'test',
    prompt: 'p',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60000 },
    enabled: true,
    force: false,
    createdAt: 0,
    nextRunAt: 100,
    runCount: 0,
    history: [],
    ...overrides,
  }
}

describe('MockSchedulerBackend', () => {
  it('records sendMessage calls', async () => {
    const backend = new MockSchedulerBackend()
    await backend.sendMessage(
      { content: 'hi', customType: 'pi-scheduler:dispatched', display: true },
      { deliverAs: 'followUp', triggerTurn: true },
    )
    expect(backend.sentMessages).toHaveLength(1)
    expect(backend.sentMessages[0]!.msg).toEqual({
      content: 'hi',
      customType: 'pi-scheduler:dispatched',
      display: true,
    })
    expect(backend.sentMessages[0]!.opts).toEqual({ deliverAs: 'followUp', triggerTurn: true })
  })

  it('records appendEntry calls and throws injected appendError', () => {
    const backend = new MockSchedulerBackend()
    const op: SchedulerEntryOp = { op: 'delete', taskId: 'aaa' }

    backend.appendEntry(op)
    expect(backend.appendedOps).toHaveLength(1)
    expect(backend.appendedOps[0]).toBe(op)

    // appendError 注入：appendEntry 抛该错（ER-APPEND-FAIL 语义——错误必须能传到调用栈供 runtime 捕获）
    backend.appendError = new Error('pi internal')
    expect(() => backend.appendEntry(op)).toThrow('pi internal')
  })

  it('now() returns injected nowValue or Date.now()', () => {
    const backend = new MockSchedulerBackend()
    expect(Math.abs(backend.now() - Date.now())).toBeLessThan(1000)
    backend.nowValue = 123456
    expect(backend.now()).toBe(123456)
  })

  // ── TC-W-BACKEND-REPLAY：loadTasks 委托 replayFoldEntries（IF-BACKEND-REPLAY）──
  it('TC-W-BACKEND-REPLAY: loadTasks 经 replayFoldEntries 恢复 owner 匹配的任务', () => {
    const backend = new MockSchedulerBackend()
    backend.fakeSessionFile = '/a.json'
    backend.fakeEntries = [
      // 非 scheduler entry：应被折叠忽略
      { type: 'message', data: {} },
      { type: 'custom', customType: 'other-ext', data: {} },
      // owner 匹配的 upsert
      {
        type: 'custom',
        customType: 'pi-scheduler:task',
        data: { op: 'upsert', taskId: 'X', ownerSessionFile: '/a.json', task: snapshot({ id: 'X' }) },
      },
      // owner 不匹配的 upsert（fork 继承）：应被过滤
      {
        type: 'custom',
        customType: 'pi-scheduler:task',
        data: { op: 'upsert', taskId: 'Y', ownerSessionFile: '/other.json', task: snapshot({ id: 'Y' }) },
      },
    ]

    const tasks = backend.loadTasks()

    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.id).toBe('X')
    expect(tasks[0]!.ownerSessionFile).toBe('/a.json')
  })

  it('TC-W-BACKEND-REPLAY: getSessionFile 返回 fakeSessionFile（缺省值）', () => {
    const backend = new MockSchedulerBackend()
    expect(backend.getSessionFile()).toBe('/test/session.json')
    backend.fakeSessionFile = '/custom.json'
    expect(backend.getSessionFile()).toBe('/custom.json')
    backend.fakeSessionFile = undefined
    expect(backend.getSessionFile()).toBeUndefined()
  })

  // ── TC2：new SchedulerRuntime(mockBackend) 可注入单测，零 FS ──

  it('TC2: SchedulerRuntime with MockSchedulerBackend constructs and dispatches via mock', async () => {
    const backend = new MockSchedulerBackend()
    // 构造不抛错（无需 cwd/pi/store mock）
    const runtime = new SchedulerRuntime(backend)
    // force 任务（L4：直投唯一入口，无 handle 直投分支已删）
    const task = await runtime.addTask('probe', { mode: 'interval', intervalMs: 60000 }, { force: true })
    expect(task).toBeDefined()
    // addTask 后 append upsert op（append-only，零 FS）
    expect(backend.appendedOps).toHaveLength(1)
    expect(backend.appendedOps[0]!.op).toBe('upsert')

    await runtime.dispatchTask(task)

    // dispatch 消息走 mock backend，含 task.prompt
    expect(backend.sentMessages).toHaveLength(1)
    expect(backend.sentMessages[0]!.msg.content).toBe('probe')
    expect(backend.sentMessages[0]!.msg.customType).toBe('pi-scheduler:dispatched')
  })
})
