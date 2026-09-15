import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}))

import { replayFoldEntries, type SchedulerEntryLike } from '../replay.js'
import type { SchedulerEntryOp, TaskSnapshot } from '../types.js'

/** 构造 pi-scheduler:task custom entry（包装 op）。 */
function entry(op: SchedulerEntryOp): SchedulerEntryLike {
  return { type: 'custom', customType: 'pi-scheduler:task', data: op }
}

/** 构造非 scheduler 的 custom entry（应被折叠忽略）。 */
function otherEntry(): SchedulerEntryLike {
  return { type: 'custom', customType: 'some-other-ext', data: { foo: 1 } }
}

/** 构造 message entry（应被折叠忽略）。 */
function messageEntry(): SchedulerEntryLike {
  return { type: 'message', data: {} }
}

/** 构造 base task 快照（upsert op 用）。 */
function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'aaa',
    name: 'test',
    prompt: 'p',
    kind: 'recurring',
    schedule: { mode: 'interval', intervalMs: 60000 },
    enabled: true,
    createdAt: 0,
    nextRunAt: 100,
    runCount: 0,
    history: [],
    ...overrides,
  }
}

describe('replayFoldEntries', () => {
  // ── TC-W-REPLAY-FOLD：折叠协议正确性（4 op 混合）──
  it('TC-W-REPLAY-FOLD: 折叠 upsert/advance/toggle/delete 4 op 到正确末态', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A' }) }),
      entry({ op: 'upsert', taskId: 'B', ownerSessionFile: session, task: snapshot({ id: 'B' }) }),
      entry({
        op: 'advance',
        taskId: 'A',
        nextRunAt: 200,
        at: 100,
        status: 'success',
      }),
      entry({ op: 'toggle', taskId: 'A', enabled: false }),
      entry({ op: 'delete', taskId: 'B' }),
    ]

    const result = replayFoldEntries(entries, session)

    expect(result.size).toBe(1)
    expect(result.has('B')).toBe(false) // B 被 delete，不复活

    const a = result.get('A')!
    expect(a).toBeDefined()
    expect(a.nextRunAt).toBe(200)
    expect(a.lastRunAt).toBe(100)
    expect(a.runCount).toBe(1)
    expect(a.history).toEqual([{ at: 100, status: 'success' }])
    expect(a.lastStatus).toBe('success') // gap2：advance 恢复 lastStatus
    expect(a.enabled).toBe(false)
    expect(a.ownerSessionFile).toBe(session) // ownerSessionFile 从 op 顶层恢复
  })

  it('折叠忽略非 pi-scheduler:task 的 custom entry 与 message entry', () => {
    const session = '/s.json'
    const entries = [
      messageEntry(),
      otherEntry(),
      entry({ op: 'upsert', taskId: 'aaa', ownerSessionFile: session, task: snapshot() }),
      otherEntry(),
    ]
    const result = replayFoldEntries(entries, session)
    expect(result.size).toBe(1)
    expect(result.get('aaa')).toBeDefined()
  })

  it('折叠忽略 data 缺失或 op 字段非法的 entry（防御损坏 entry）', () => {
    const session = '/s.json'
    const entries: SchedulerEntryLike[] = [
      { type: 'custom', customType: 'pi-scheduler:task' }, // data undefined
      { type: 'custom', customType: 'pi-scheduler:task', data: { op: 123 } }, // op 非字符串
      { type: 'custom', customType: 'pi-scheduler:task', data: {} }, // 缺 op
      { type: 'custom', customType: 'pi-scheduler:task', data: null },
    ]
    const result = replayFoldEntries(entries, session)
    expect(result.size).toBe(0)
  })

  // ── TC-W-REPLAY-NEXTRUNAT：nextRunAt 不回退（D1 核心）──
  it('TC-W-REPLAY-NEXTRUNAT: recurring advance 推进 nextRunAt，重放不回退到初值', () => {
    const session = '/s.json'
    const entries = [
      entry({
        op: 'upsert',
        taskId: 'X',
        ownerSessionFile: session,
        task: snapshot({ id: 'X', nextRunAt: 100 }),
      }),
      entry({ op: 'advance', taskId: 'X', nextRunAt: 500, at: 200, status: 'success' }),
    ]

    const result = replayFoldEntries(entries, session)
    const x = result.get('X')!
    expect(x.nextRunAt).toBe(500) // 非 upsert 初值 100
    expect(x.runCount).toBe(1)
    expect(x.lastRunAt).toBe(200)
    expect(x.lastStatus).toBe('success')
  })

  // ── TC-W-FORK-OWNER-FILTER：全量折叠后整体过滤（gap1）──
  it('TC-W-FORK-OWNER-FILTER: fork 继承序列在非 owner session 重放后 Map 为空', () => {
    // upsert owner=A + advance（advance op 无 ownerSessionFile 字段）
    const entries = [
      entry({
        op: 'upsert',
        taskId: 'X',
        ownerSessionFile: '/a.json',
        task: snapshot({ id: 'X' }),
      }),
      entry({ op: 'advance', taskId: 'X', nextRunAt: 500, at: 200, status: 'success' }),
    ]

    // session B 重放：步骤①全量折叠得到 task(owner=A)，步骤②整体过滤移除
    const inB = replayFoldEntries(entries, '/b.json')
    expect(inB.size).toBe(0)
    expect(inB.has('X')).toBe(false)

    // 对照：session A 重放应保留 X（验证不是「永远过滤」，而是 owner 不匹配才过滤）
    const inA = replayFoldEntries(entries, '/a.json')
    expect(inA.size).toBe(1)
    expect(inA.get('X')!.nextRunAt).toBe(500)
  })

  // ── TC-W-GETENTRIES-FALLBACK：getEntries 异常兜底（gap4）──
  it('TC-W-GETENTRIES-FALLBACK: 迭代器抛错时 logger.warn + 返回空 Map，不崩溃', () => {
    loggerMock.warn.mockClear()
    // 构造迭代时抛错的 iterable（模拟 session JSONL 损坏）
    const throwingIterable: Iterable<SchedulerEntryLike> = {
      [Symbol.iterator]() {
        let i = 0
        return {
          next() {
            if (i++ === 0) throw new Error('JSONL corrupted')
            return { done: true, value: undefined as unknown as SchedulerEntryLike }
          },
        }
      },
    }

    const result = replayFoldEntries(throwingIterable, '/s.json')
    expect(result.size).toBe(0)
    expect(loggerMock.warn).toHaveBeenCalled()
    const msg = loggerMock.warn.mock.calls[0]![0] as string
    expect(msg).toContain('replayFoldEntries failed')
    expect(loggerMock.warn.mock.calls[0]![1]).toEqual(expect.objectContaining({ error: expect.stringContaining('JSONL corrupted') }))
  })

  // ── gap2 补强：advance 后 lastStatus/lastRunAt/runCount/history 全恢复 ──
  it('gap2: 多次 advance 累积 runCount/history，history 超 20 裁剪', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'X', ownerSessionFile: session, task: snapshot({ id: 'X' }) }),
    ]
    for (let i = 1; i <= 25; i++) {
      entries.push(entry({ op: 'advance', taskId: 'X', nextRunAt: 100 + i * 100, at: i * 10, status: 'success' }))
    }

    const result = replayFoldEntries(entries, session)
    const x = result.get('X')!
    expect(x.runCount).toBe(25)
    expect(x.lastRunAt).toBe(250) // 最后一次 advance at
    expect(x.nextRunAt).toBe(2600) // 最后一次 advance nextRunAt (100+25*100)
    expect(x.lastStatus).toBe('success')
    expect(x.history.length).toBe(20) // 裁剪到 20
    // 保留最后 20 条（at=60..250），最早 5 条（at=10..50）被 shift 掉
    expect(x.history[0]!.at).toBe(60)
    expect(x.history[19]!.at).toBe(250)
  })

  // ── gap1 补强：delete 后该 taskId 不复活（后续 upsert 仍可重建）──
  it('gap1 补强: delete 后同 taskId 的 upsert 仍可重建任务', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A', nextRunAt: 100 }) }),
      entry({ op: 'delete', taskId: 'A' }),
      // advance 对已删 taskId 为 no-op（安全）
      entry({ op: 'advance', taskId: 'A', nextRunAt: 999, at: 999, status: 'success' }),
      // upsert 重建 A
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A', nextRunAt: 200 }) }),
    ]
    const result = replayFoldEntries(entries, session)
    const a = result.get('A')!
    expect(a).toBeDefined()
    expect(a.nextRunAt).toBe(200) // 重建后的快照值，非 advance 的 999（advance 在 delete 后 no-op）
    expect(a.runCount).toBe(0) // 重建后重置
  })

  // ── currentSessionFile undefined：所有带 owner 的任务被过滤（--no-session 模式）──
  it('currentSessionFile 为 undefined 时，带 ownerSessionFile 的任务被过滤', () => {
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: '/a.json', task: snapshot({ id: 'A' }) }),
    ]
    const result = replayFoldEntries(entries, undefined)
    expect(result.size).toBe(0)
  })

  // ── P1：toggle op 携带 nextRunAt 重放不回退到 upsert 快照旧值（跨 session 持久化）──
  it('P1: toggle op 携带 nextRunAt 时，重放后 task.nextRunAt = toggle 携带值（非 upsert 快照旧过期值）', () => {
    const session = '/s.json'
    const entries = [
      // upsert 快照 nextRunAt=100（disable 期间过期的旧值），enabled=false（disable 态）
      entry({
        op: 'upsert',
        taskId: 'A',
        ownerSessionFile: session,
        task: snapshot({ id: 'A', nextRunAt: 100, enabled: false }),
      }),
      // toggle enable 重算到未来（500）并携带 nextRunAt
      entry({ op: 'toggle', taskId: 'A', enabled: true, nextRunAt: 500 }),
    ]

    const result = replayFoldEntries(entries, session)
    const a = result.get('A')!
    expect(a).toBeDefined()
    expect(a.enabled).toBe(true)
    expect(a.nextRunAt).toBe(500) // 重算的未来值，非 upsert 快照的旧过期值 100
  })

  // 对照：toggle 不携带 nextRunAt 时，nextRunAt 保持 upsert 快照值（普通 toggle / cron 失效回退语义）
  it('P1 对照: toggle op 不携带 nextRunAt 时，重放后 nextRunAt = upsert 快照值', () => {
    const session = '/s.json'
    const entries = [
      entry({
        op: 'upsert',
        taskId: 'A',
        ownerSessionFile: session,
        task: snapshot({ id: 'A', nextRunAt: 100, enabled: false }),
      }),
      entry({ op: 'toggle', taskId: 'A', enabled: true }),
    ]

    const result = replayFoldEntries(entries, session)
    const a = result.get('A')!
    expect(a.enabled).toBe(true)
    expect(a.nextRunAt).toBe(100) // 保持 upsert 快照值
  })

  // ── MF-2：守卫按变体校验必填字段——损坏 entry 只跳过该条，不清空全部任务 ──
  it('MF-2: op 合法但缺必填字段的损坏 entry 被跳过，其余任务保留', () => {
    const session = '/s.json'
    loggerMock.warn.mockClear()
    const entries: SchedulerEntryLike[] = [
      { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'upsert' } }, // 缺 taskId+task
      { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'upsert', taskId: 'A' } }, // 缺 task
      { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'advance', taskId: 'A', at: 1, status: 'success' } }, // 缺 nextRunAt
      { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'toggle', taskId: 'A' } }, // 缺 enabled
      { type: 'custom', customType: 'pi-scheduler:task', data: { op: 'delete' } }, // 缺 taskId
      // 合法 entry 应保留（此前这 5 条损坏 entry 会清空全部任务）
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A' }) }),
    ]

    const result = replayFoldEntries(entries, session)
    expect(result.size).toBe(1)
    expect(result.get('A')).toBeDefined()
  })

  it('MF-2: upsert task 嵌套数据损坏（history 非数组）→ 逐条跳过该 entry，其余任务保留', () => {
    const session = '/s.json'
    loggerMock.warn.mockClear()
    const entries: SchedulerEntryLike[] = [
      {
        type: 'custom',
        customType: 'pi-scheduler:task',
        data: {
          op: 'upsert',
          taskId: 'BAD',
          ownerSessionFile: session,
          task: { ...snapshot({ id: 'BAD' }), history: 'not-an-array' },
        },
      },
      entry({ op: 'upsert', taskId: 'GOOD', ownerSessionFile: session, task: snapshot({ id: 'GOOD' }) }),
    ]

    const result = replayFoldEntries(entries, session)
    expect(result.size).toBe(1)
    expect(result.get('GOOD')).toBeDefined()
    expect(result.has('BAD')).toBe(false)
    // 逐条跳过 warn（非外层整体 catch 的 replayFoldEntries failed warn）
    expect(loggerMock.warn).toHaveBeenCalled()
    const msg = loggerMock.warn.mock.calls[0]![0] as string
    expect(msg).toContain('skipping corrupted scheduler entry')
  })

  // ── fork 场景安全：未知 taskId 的 advance/toggle 为静默 no-op，不触发逐条 catch ──
  it('advance/toggle 对不存在的 taskId 为 no-op（无 upsert 时不产生副作用、不触发逐条 catch warn）', () => {
    loggerMock.warn.mockClear()
    const entries = [
      entry({ op: 'advance', taskId: 'ghost', nextRunAt: 200, at: 100, status: 'success' }),
      entry({ op: 'toggle', taskId: 'ghost', enabled: false }),
      entry({ op: 'delete', taskId: 'ghost' }),
    ]
    const result = replayFoldEntries(entries, '/s.json')
    expect(result.size).toBe(0)
    // no-op 提前返回路径不抛错——MF-2 的逐条跳过 warn 不应被触发
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
