/**
 * U6c：backend.loadTasks 折叠接活跃路径裁剪 + session_tree handler 重折叠。
 *
 * 从 leafId 沿 parentId 回溯得活跃路径，被撤子树的任务 op entry 不再恢复 pending
 * 定时任务——到点不触发真实 turn（A14 可观察验收锚）。
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

import { PiSchedulerBackend, type SchedulerBackendCtx } from '../backend.js'
import { SchedulerRuntime, TICK_INTERVAL_MS } from '../runtime.js'
import { TASK_ENTRY_TYPE } from '../types.js'
import type { ScheduledTask, SchedulerEntryOp, TaskSnapshot } from '../types.js'

const SESSION_FILE = '/test/session.json'

// ── fixture ─────────────────────────────────────────

interface BranchEntry {
  id: string
  parentId: string | null
  type: string
  customType?: string
  data?: unknown
}

/** 构造 base task 快照（upsert op 用，字段集对齐 replay.test.ts 惯例） */
function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 't1',
    name: 'test',
    prompt: 't1 prompt',
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

function upsertOp(taskId: string, overrides: Partial<TaskSnapshot> = {}): SchedulerEntryOp {
  return {
    op: 'upsert',
    taskId,
    ownerSessionFile: SESSION_FILE,
    task: snapshot({ id: taskId, prompt: `${taskId} prompt`, ...overrides }),
  }
}

function taskOpEntry(id: string, parentId: string | null, op: SchedulerEntryOp): BranchEntry {
  return { type: 'custom', id, parentId, customType: TASK_ENTRY_TYPE, data: op }
}

/** 撤回后真实形态：label entry 落文件尾（parentId = 回退后叶子），leafId 指向它 */
function labelEntry(id: string, parentId: string | null): BranchEntry {
  return { type: 'label', id, parentId, targetId: 'u-x', label: 'taiji:revoked' }
}

/** 可变树状态的 ctx（模拟撤回前后 swap：entries + leafId 经闭包读取） */
function makeCtx(initialEntries: BranchEntry[], initialLeafId: string | null) {
  let entries = initialEntries
  let leafId = initialLeafId
  const ctx: SchedulerBackendCtx = {
    sessionManager: {
      getEntries: () => entries.slice(),
      getSessionFile: () => SESSION_FILE,
      getLeafId: () => leafId,
    },
  }
  return {
    ctx,
    setTree(nextEntries: BranchEntry[], nextLeafId: string | null): void {
      entries = nextEntries
      leafId = nextLeafId
    },
  }
}

/** 捕获 pi.on 注册的 handler + 副作用记录面（sendMessage / appendEntry vi.fn）。
 * on 字段仅满足 ExtensionAPI 结构完整性：session_tree 注册面已迁至 factory 顶层
 * （index.ts），backend 构造不再调 pi.on（注册面契约见 session-tree-registration.test.ts）。 */
function makePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const sendMessage = vi.fn(async () => {})
  const appendEntry = vi.fn()
  const registerProvider = vi.fn()
  const unregisterProvider = vi.fn()
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler)
    },
    sendMessage,
    appendEntry,
    registerProvider,
    unregisterProvider,
  }
  return { pi: pi as unknown as ExtensionAPI, handlers, sendMessage, appendEntry }
}

// ── loadTasks 活跃路径裁剪（U6c）─────────────────────

describe('PiSchedulerBackend.loadTasks 活跃路径裁剪（U6c）', () => {
  it('有分支 fixture：被撤子树的任务 op 不进重建态', () => {
    // 树：e1(t1 upsert，active)；e1 → e3(t2 upsert，revoked-branch 物理后写)；
    // 撤回落 label 锚 L（parentId = 回退后叶子 e1），leafId = L → 活跃路径 {L, e1}
    const entries = [
      taskOpEntry('e1', null, upsertOp('t1')),
      taskOpEntry('e3', 'e1', upsertOp('t2')),
      labelEntry('L', 'e1'),
    ]
    const { ctx } = makeCtx(entries, 'L')

    const tasks = new PiSchedulerBackend(ctx, makePi().pi).loadTasks()

    const ids = tasks.map(t => t.id)
    expect(ids).toContain('t1')
    // 反向断言：被撤子树任务不恢复 pending（无裁剪时会从 e3 折叠复活）
    expect(ids).not.toContain('t2')
  })

  it('同任务跨分支：取活跃路径内最新 upsert（分支上被撤的后续推进不参与折叠）', () => {
    const entries = [
      taskOpEntry('e1', null, upsertOp('t1', { prompt: 'old prompt' })),
      taskOpEntry('e2', 'e1', upsertOp('t1', { prompt: 'active-branch prompt' })),
      taskOpEntry('e3', 'e1', upsertOp('t1', { prompt: 'revoked-branch prompt' })),
      labelEntry('L', 'e2'),
    ]
    const { ctx } = makeCtx(entries, 'L')

    const tasks = new PiSchedulerBackend(ctx, makePi().pi).loadTasks()

    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.prompt).toBe('active-branch prompt')
  })

  it('无分支回归：leafId = 文件尾 → 线性折叠最新（现行为不变）', () => {
    const entries = [
      taskOpEntry('e1', null, upsertOp('t1', { prompt: 'v1' })),
      taskOpEntry('e2', 'e1', upsertOp('t1', { prompt: 'v2' })),
    ]
    const { ctx } = makeCtx(entries, 'e2')

    const tasks = new PiSchedulerBackend(ctx, makePi().pi).loadTasks()

    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.prompt).toBe('v2')
  })

  it('legacy fixture 回归：entry 无 id/parentId（duck-typed 最小形状）→ 线性全量折叠，行为与裁剪前一致', () => {
    const entries = [
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: upsertOp('t1') },
      { type: 'custom', customType: TASK_ENTRY_TYPE, data: upsertOp('t2') },
    ]
    const ctx: SchedulerBackendCtx = {
      sessionManager: {
        getEntries: () => entries.slice(),
        getSessionFile: () => SESSION_FILE,
      },
    }

    const tasks = new PiSchedulerBackend(ctx, makePi().pi).loadTasks()

    expect(tasks.map(t => t.id).sort()).toEqual(['t1', 't2'])
  })

  it('leafId 防御：null / 指向不存在 entry → 回退文件尾（撤回落 label 锚在尾，等价命中活跃路径）', () => {
    const entries = [
      taskOpEntry('e1', null, upsertOp('t1')),
      taskOpEntry('e3', 'e1', upsertOp('t2')),
      labelEntry('L', 'e1'),
    ]

    for (const leafId of [null, 'missing-id']) {
      const { ctx } = makeCtx(entries, leafId)
      const tasks = new PiSchedulerBackend(ctx, makePi().pi).loadTasks()
      // 尾部锚 = label L（parentId=e1）→ 回溯 {L, e1}，被撤子树 t2 仍被裁掉
      expect(tasks.map(t => t.id)).toEqual(['t1'])
    }
  })
})

// ── session_tree handler 重折叠 + 到点不触发（U6c / A14）──

describe('session_tree 重折叠（U6c）', () => {
  it('撤回后 session_tree → runtime 任务集重折叠（被撤任务移除）；handler 本身零 dispatch 零 append', () => {
    // 撤回前：线性文件（leaf=尾=e2），t1/t2 均在
    const preRevoke = [
      taskOpEntry('e1', null, upsertOp('t1')),
      taskOpEntry('e2', 'e1', upsertOp('t2')),
    ]
    const { ctx, setTree } = makeCtx(preRevoke, null)
    const { pi, sendMessage, appendEntry } = makePi()

    const backend = new PiSchedulerBackend(ctx, pi)
    const runtime = new SchedulerRuntime(backend)
    runtime.loadTasks(backend.loadTasks())
    expect(runtime.getTask('t1')).toBeDefined()
    expect(runtime.getTask('t2')).toBeDefined()

    // 撤回：树回退（label 锚落尾 + leafId 指向它）→ session_tree 事件 → 重折叠
    // （生产注册面在 factory 顶层 index.ts，此处直接驱动委托体）
    setTree([...preRevoke, labelEntry('L', 'e1')], 'L')
    backend.refoldSessionTree()

    expect(runtime.getTask('t1')).toBeDefined()
    expect(runtime.getTask('t2')).toBeUndefined()

    // 纯重建断言：handler 自身不 dispatch、不 append op（不污染回退后的新分支）
    expect(sendMessage).not.toHaveBeenCalled()
    expect(appendEntry).not.toHaveBeenCalled()
  })

  it('到点不触发（A14）：重折叠后被撤子树任务 interval 到点无 turn；活跃路径任务照常 dispatch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    try {
      // 两任务同在撤回前文件上，nextRunAt = now + 1s（首个 30s tick 即到期）
      const dueAt = Date.now() + 1000
      const preRevoke = [
        taskOpEntry('e1', null, upsertOp('t1', { nextRunAt: dueAt })),
        taskOpEntry('e2', 'e1', upsertOp('t2', { nextRunAt: dueAt })),
      ]
      const { ctx, setTree } = makeCtx(preRevoke, null)
      const { pi, sendMessage } = makePi()

      const backend = new PiSchedulerBackend(ctx, pi)
      const runtime = new SchedulerRuntime(backend)
      runtime.loadTasks(backend.loadTasks())

      // 撤回回退到 e1（t2 所在子树被移出活跃路径）
      setTree([...preRevoke, labelEntry('L', 'e1')], 'L')
      backend.refoldSessionTree()
      expect(runtime.getTask('t2')).toBeUndefined()

      // tick 常驻循环不动启停逻辑：重折叠后照常消费新任务集
      runtime.startScheduler()
      await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS)

      const prompts = sendMessage.mock.calls.map(call => (call[0] as { content: string }).content)
      expect(prompts).toContain('t1 prompt')
      // A14 验收锚：被撤子树任务到点不触发真实 turn
      expect(prompts).not.toContain('t2 prompt')
      expect(sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      // tick interval 在 fake timers 域内清理，防泄漏到后续用例
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
