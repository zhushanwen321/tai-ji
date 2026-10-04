// src/__tests__/session-tree-registration.test.ts
//
// U6c session_tree 注册面契约：注册在 extension factory 顶层（每代恰一 handler），
// 同代 session_start 复发不累积。回归背景：注册曾在 PiSchedulerBackend 构造函数内，
// 而 pi RPC 模式下每次 session 替换 session_start 在同一代内触发两次
// （agent-session-runtime finishSessionReplacement 内部 rebindSession + RPC handler
// 再 rebindSession，0.84.4 实装核对），pi 的 on 是追加语义（loader.js list.push，
// 无去重无 off）——handler 随替换线性累积，残留旧代 backend 在旧 ctx 上重复执行。
//
// mock pi 的 on 必须是追加语义（list.push，对齐 pi 实装）：覆盖式 Map.set 会掩盖
// 累积回归，正是本套件要防的形态。

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'

// MF-3（与 sdk-contract.test.ts 同款）：mock importer，session_start 装配零 FS 副作用。
vi.mock('../importer.js', () => ({ importLegacyStore: vi.fn(() => vi.fn()) }))

// mock 共享 logger（与 widget-push.test.ts 同款）：防测试触碰真实日志目录。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
  setPiHandle: vi.fn(),
}))

import schedulerExtension from '../index.js'
import { TASK_ENTRY_TYPE } from '../types.js'

type Handler = (...args: unknown[]) => unknown

/** 追加语义 mock pi：on = list.push（对齐 pi loader.js on 实装，无去重无 off）。 */
function createAppendPi(): {
  pi: ExtensionAPI
  handlers: Map<string, Handler[]>
  tools: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }[]
} {
  const handlers = new Map<string, Handler[]>()
  const tools: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }[] = []
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }) =>
      tools.push(tool),
    registerCommand: vi.fn(),
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI
  return { pi, handlers, tools }
}

/** 远期到期的启用任务 upsert entry（owner = sessionFile；测试窗内无 dispatch 噪音）。 */
function taskEntry(sessionFile: string, taskId: string) {
  return {
    type: 'custom',
    customType: TASK_ENTRY_TYPE,
    data: {
      op: 'upsert',
      taskId,
      ownerSessionFile: sessionFile,
      task: {
        id: taskId,
        name: taskId,
        prompt: `${taskId} prompt`,
        kind: 'recurring',
        schedule: { mode: 'interval', intervalMs: 3_600_000 },
        enabled: true,
        createdAt: 0,
        nextRunAt: Date.now() + 3_600_000,
        runCount: 0,
        history: [],
      },
    },
  }
}

/** fake ctx：entries 经容器可变（模拟撤回前后 swap）；ui.setWidget 观测面。 */
function createFakeCtx(sessionFile: string, entriesBox: { entries: unknown[] }): ExtensionContext {
  return {
    cwd: '/test-tree-reg',
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { setWidget: vi.fn() },
    sessionManager: {
      getEntries: () => entriesBox.entries,
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext
}

describe('session_tree 注册面（factory 顶层恰一，同代 session_start 复发不累积）', () => {
  it('factory 运行恰注册 1 个 session_tree handler', () => {
    const { pi, handlers } = createAppendPi()
    schedulerExtension(pi)
    expect(handlers.get('session_tree')).toHaveLength(1)
  })

  it('同代 session_start 复发（RPC 模式每次替换触发 2 次）→ session_tree handler 恒恰 1', () => {
    const { pi, handlers } = createAppendPi()
    schedulerExtension(pi)
    const entriesBox = { entries: [] as unknown[] }
    const ctx = createFakeCtx('/test/tree-reg.json', entriesBox)
    const sessionStart = handlers.get('session_start')![0]!

    sessionStart({ type: 'session_start', reason: 'new' }, ctx)
    sessionStart({ type: 'session_start', reason: 'resume' }, ctx)

    expect(handlers.get('session_tree')).toHaveLength(1)

    // 收尾停当代 runtime 的 tick interval（fake timers 未启用，interval 需显式清）
    void handlers.get('session_shutdown')![0]()
  })

  it('复发后 session_tree 委托当代 backend：撤回后重折叠反映到任务查询', () => {
    const file = '/test/tree-reg-delegate.json'
    const entriesBox = { entries: [taskEntry(file, 't1')] as unknown[] }
    const { pi, handlers, tools } = createAppendPi()
    schedulerExtension(pi)
    const ctx = createFakeCtx(file, entriesBox)
    const sessionStart = handlers.get('session_start')![0]!

    // 同代复发两次：第 2 个 backend 为当代（旧代已被 stopScheduler + 代数判 stale）
    sessionStart({ type: 'session_start', reason: 'new' }, ctx)
    sessionStart({ type: 'session_start', reason: 'resume' }, ctx)

    // 基线：t1 在当代任务集内
    const control = tools.find(t => t.name === 'schedule_control')!

    return control
      .execute('call-base', { action: 'list' }, undefined, undefined, ctx)
      .then(result => {
        expect(result.content[0]!.text).toContain('t1')

        // 撤回：entry 移出（getEntries 变化）→ session_tree 事件 → 当代 backend 重折叠
        entriesBox.entries = []
        handlers.get('session_tree')![0]!({ type: 'session_tree' }, ctx)

        return control.execute('call-after', { action: 'list' }, undefined, undefined, ctx)
      })
      .then(result => {
        expect(result.content[0]!.text).not.toContain('t1')
      })
      .finally(() => {
        void handlers.get('session_shutdown')![0]()
      })
  })
})
