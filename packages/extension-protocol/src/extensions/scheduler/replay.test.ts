import { describe, expect, it, vi } from 'vitest'
import {
  HISTORY_LIMIT,
  replayFoldEntries,
  TASK_ENTRY_TYPE,
  type SchedulerEntryLike,
  type SchedulerEntryOp,
  type TaskSnapshot,
} from '../../index'

// 包内折叠器逐行为覆盖：扩展侧 replay.test.ts 经薄 wrapper（注入共享 logger）间接覆盖本函数，
// coverage-gate 按包计量——本文件直接对包内实现断言；降级日志经 ReplayFoldOptions.warn 注入
// spy（包内零 logger 依赖），无需 vi.mock。

/** 构造 pi-scheduler:task custom entry（包装 op）。 */
function entry(op: SchedulerEntryOp): SchedulerEntryLike {
  return { type: 'custom', customType: TASK_ENTRY_TYPE, data: op }
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

describe('replayFoldEntries（包内折叠器）', () => {
  it('折叠 upsert/advance/toggle/delete 4 op 到正确末态', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A' }) }),
      entry({ op: 'upsert', taskId: 'B', ownerSessionFile: session, task: snapshot({ id: 'B' }) }),
      entry({ op: 'advance', taskId: 'A', nextRunAt: 200, at: 100, status: 'success' }),
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

  it('多次 advance 累积 runCount/history，history 超 HISTORY_LIMIT 裁剪', () => {
    const session = '/s.json'
    const entries = [entry({ op: 'upsert', taskId: 'X', ownerSessionFile: session, task: snapshot({ id: 'X' }) })]
    for (let i = 1; i <= 25; i++) {
      entries.push(entry({ op: 'advance', taskId: 'X', nextRunAt: 100 + i * 100, at: i * 10, status: 'success' }))
    }

    const result = replayFoldEntries(entries, session)
    const x = result.get('X')!
    expect(x.runCount).toBe(25)
    expect(x.lastRunAt).toBe(250)
    expect(x.nextRunAt).toBe(2600)
    expect(x.lastStatus).toBe('success')
    expect(x.history.length).toBe(HISTORY_LIMIT)
    // 保留最后 20 条（at=60..250），最早 5 条（at=10..50）被 shift 掉
    expect(x.history[0]!.at).toBe(60)
    expect(x.history[HISTORY_LIMIT - 1]!.at).toBe(250)
  })

  it('upsert 快照含非空 history → 逐项深拷贝恢复，不与快照共享引用', () => {
    const session = '/s.json'
    const snap = snapshot({ id: 'A', history: [{ at: 1, status: 'success' }, { at: 2, status: 'failed' }] })
    const tasks = replayFoldEntries(
      [entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snap })],
      session,
    )
    const restored = tasks.get('A')!
    expect(restored.history).toEqual([
      { at: 1, status: 'success' },
      { at: 2, status: 'failed' },
    ])
    // 引用隔离：对恢复 task 的 mutate 不得污染快照（snapshotToTask 逐项 {...h} 的存在理由）
    restored.history.push({ at: 3, status: 'success' })
    restored.history[0]!.at = 999
    expect(snap.history.length).toBe(2)
    expect(snap.history[0]!.at).toBe(1)
  })

  it('fork 继承序列在非 owner session 重放后 Map 为空，owner session 保留', () => {
    // upsert owner=A + advance（advance op 无 ownerSessionFile 字段，须先全量折叠再整体过滤）
    const entries = [
      entry({ op: 'upsert', taskId: 'X', ownerSessionFile: '/a.json', task: snapshot({ id: 'X' }) }),
      entry({ op: 'advance', taskId: 'X', nextRunAt: 500, at: 200, status: 'success' }),
    ]

    const inB = replayFoldEntries(entries, '/b.json')
    expect(inB.size).toBe(0)
    expect(inB.has('X')).toBe(false)

    // 对照：session A 重放保留 X 且折叠出 advance 末态（不是「永远过滤」，owner 不匹配才过滤）
    const inA = replayFoldEntries(entries, '/a.json')
    expect(inA.size).toBe(1)
    expect(inA.get('X')!.nextRunAt).toBe(500)
  })

  it('currentSessionFile 为 undefined 时，带 ownerSessionFile 的任务被过滤（--no-session 模式）', () => {
    const entries = [entry({ op: 'upsert', taskId: 'A', ownerSessionFile: '/a.json', task: snapshot({ id: 'A' }) })]
    const result = replayFoldEntries(entries, undefined)
    expect(result.size).toBe(0)
  })

  it('迭代器抛错时 warn 注入被调 + 返回空 Map，不崩溃调用方（gap4）', () => {
    const warn = vi.fn()
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

    const result = replayFoldEntries(throwingIterable, '/s.json', { warn })
    expect(result.size).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'replayFoldEntries failed',
      expect.objectContaining({ error: expect.stringContaining('JSONL corrupted') }),
    )
  })

  it('守卫逐变体拒绝缺必填/非法字段的 entry：静默跳过，合法 entry 仍折叠（MF-2）', () => {
    const warn = vi.fn()
    const session = '/s.json'
    const entries: SchedulerEntryLike[] = [
      { type: 'custom', customType: TASK_ENTRY_TYPE }, // data undefined
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: null }, // data null
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: 'not-an-object' }, // data 非对象
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: {} }, // 缺 op
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'bogus', taskId: 'A' } }, // 未知 op
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'upsert' } }, // 缺 taskId+task
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'upsert', taskId: 'A' } }, // 缺 task
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'upsert', taskId: 'A', task: null } }, // task null
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'advance', taskId: 'A', at: 1, status: 'success' } }, // 缺 nextRunAt
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'advance', taskId: 'A', nextRunAt: 'soon', at: 1, status: 'success' } }, // nextRunAt 非数
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'advance', taskId: 'A', nextRunAt: 5, at: 'x', status: 'success' } }, // at 非数
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'advance', taskId: 'A', nextRunAt: 5, at: 1, status: 'failed' } }, // status 词表外（CL8：仅 'success'）
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'toggle', taskId: 'A' } }, // 缺 enabled
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'toggle', taskId: 'A', enabled: 'yes' } }, // enabled 非布尔
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'toggle', taskId: 'A', enabled: true, nextRunAt: 'soon' } }, // 可选 nextRunAt 非法
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: { op: 'delete' } }, // 缺 taskId
      // 合法 entry 在后——全部损坏 entry 被跳过后应正常折叠
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A' }) }),
      entry({ op: 'advance', taskId: 'A', nextRunAt: 300, at: 200, status: 'success' }),
    ]

    const result = replayFoldEntries(entries, session, { warn })
    expect(result.size).toBe(1)
    const a = result.get('A')!
    // runCount=1 证明只有合法 advance 生效——任一损坏 op 漏过守卫都会额外改写末态
    expect(a.runCount).toBe(1)
    expect(a.nextRunAt).toBe(300)
    expect(a.enabled).toBe(true)
    // 守卫拒绝是静默跳过，不走降级 warn
    expect(warn).not.toHaveBeenCalled()
  })

  it('upsert task 嵌套数据损坏（history 非数组）→ 逐条跳过该 entry，其余任务保留', () => {
    const warn = vi.fn()
    const session = '/s.json'
    const entries: SchedulerEntryLike[] = [
      {
        type: 'custom',
        customType: TASK_ENTRY_TYPE,
        data: {
          op: 'upsert',
          taskId: 'BAD',
          ownerSessionFile: session,
          task: { ...snapshot({ id: 'BAD' }), history: 'not-an-array' },
        },
      },
      entry({ op: 'upsert', taskId: 'GOOD', ownerSessionFile: session, task: snapshot({ id: 'GOOD' }) }),
    ]

    const result = replayFoldEntries(entries, session, { warn })
    expect(result.size).toBe(1)
    expect(result.get('GOOD')).toBeDefined()
    expect(result.has('BAD')).toBe(false)
    // 逐条跳过 warn（非外层整体 catch 的 replayFoldEntries failed warn）
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'skipping corrupted scheduler entry',
      expect.objectContaining({ error: expect.stringContaining('is not a function') }),
    )
  })

  it('折叠抛出非 Error 对象（原始字符串）→ warn 上下文按 String(e) 化，其余任务保留', () => {
    const warn = vi.fn()
    const session = '/s.json'
    // history getter 抛原始字符串：守卫只校验 task 是对象（通过），snapshotToTask 读 history 时抛
    const rawThrowingEntry: SchedulerEntryLike = {
      type: 'custom',
      customType: TASK_ENTRY_TYPE,
      data: {
        op: 'upsert',
        taskId: 'RAW',
        ownerSessionFile: session,
        task: {
          ...snapshot({ id: 'RAW' }),
          get history(): never {
            throw 'not-an-error-object'
          },
        },
      },
    }

    const result = replayFoldEntries(
      [rawThrowingEntry, entry({ op: 'upsert', taskId: 'GOOD', ownerSessionFile: session, task: snapshot({ id: 'GOOD' }) })],
      session,
      { warn },
    )
    expect(result.size).toBe(1)
    expect(result.has('RAW')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('skipping corrupted scheduler entry', expect.objectContaining({ error: 'not-an-error-object' }))
  })

  it('advance/toggle/delete 对不存在的 taskId 为 no-op（fork 场景安全，不触发降级 warn）', () => {
    const warn = vi.fn()
    const entries = [
      entry({ op: 'advance', taskId: 'ghost', nextRunAt: 200, at: 100, status: 'success' }),
      entry({ op: 'toggle', taskId: 'ghost', enabled: false }),
      entry({ op: 'delete', taskId: 'ghost' }),
    ]
    const result = replayFoldEntries(entries, '/s.json', { warn })
    expect(result.size).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('delete 后同 taskId 的 upsert 仍可重建任务（重建前 advance 为 no-op）', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A', nextRunAt: 100 }) }),
      entry({ op: 'delete', taskId: 'A' }),
      entry({ op: 'advance', taskId: 'A', nextRunAt: 999, at: 999, status: 'success' }), // 已删 taskId：no-op
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A', nextRunAt: 200 }) }),
    ]
    const result = replayFoldEntries(entries, session)
    const a = result.get('A')!
    expect(a).toBeDefined()
    expect(a.nextRunAt).toBe(200) // 重建后的快照值，非 advance 的 999
    expect(a.runCount).toBe(0) // 重建后重置
  })

  it('toggle op 携带 nextRunAt 时，重放后 nextRunAt = 携带值（非 upsert 快照旧过期值，P1）', () => {
    const session = '/s.json'
    const entries = [
      // upsert 快照 nextRunAt=100（disable 期间过期的旧值），enabled=false（disable 态）
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A', nextRunAt: 100, enabled: false }) }),
      // toggle enable 重算到未来（500）并携带 nextRunAt
      entry({ op: 'toggle', taskId: 'A', enabled: true, nextRunAt: 500 }),
    ]

    const a = replayFoldEntries(entries, session).get('A')!
    expect(a).toBeDefined()
    expect(a.enabled).toBe(true)
    expect(a.nextRunAt).toBe(500)
  })

  it('toggle op 不携带 nextRunAt 时，重放后 nextRunAt 保持 upsert 快照值', () => {
    const session = '/s.json'
    const entries = [
      entry({ op: 'upsert', taskId: 'A', ownerSessionFile: session, task: snapshot({ id: 'A', nextRunAt: 100, enabled: false }) }),
      entry({ op: 'toggle', taskId: 'A', enabled: true }),
    ]

    const a = replayFoldEntries(entries, session).get('A')!
    expect(a.enabled).toBe(true)
    expect(a.nextRunAt).toBe(100)
  })
})
