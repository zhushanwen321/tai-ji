/**
 * 三列表加载错误态测试（W2 / S5+M1+M5）。
 *
 * 覆盖：
 * - U5: session store listLoadError — loadSessions 失败设错误，成功清空
 * - U6: workflow store loadError — loadWorkflows 失败设错误且不清空 records
 * - U7: subagent fetchAndInject fail-fast — 失败 throw 不静默 setMessages([])
 *
 * 运行：npx vitest run src/__tests__/stores/list-load-error.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { WorkflowRunRecord } from '@taiji/shared'

// ── mock api 域（workflow/subagent store 用 @/api/domains/session，useSidebar 用 @/api）──
const listMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
const getWorkflowsMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
const getSubagentsMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))
const getSubagentHistoryMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])))

vi.mock('@taiji/core/transport/api/domains/session', () => ({
  list: listMock,
  getWorkflows: getWorkflowsMock,
  getSubagents: getSubagentsMock,
  getSubagentHistory: getSubagentHistoryMock,
  create: vi.fn(() => Promise.resolve({})),
  switchSession: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { getHistory: vi.fn(() => Promise.resolve([])) },
  session: {
    create: vi.fn(() => Promise.resolve({})),
    list: listMock,
    switchSession: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    getWorkflows: getWorkflowsMock,
    getSubagents: getSubagentsMock,
    getSubagentHistory: getSubagentHistoryMock,
  },
}))
vi.mock('@taiji/core/transport/api', () => ({
  on: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
  onGlobalType: vi.fn(() => () => {}),
}))

import { useSessionStore } from '@/stores/session'
import { useWorkflowStore } from '@/stores/workflow'
import { useSubagentStore } from '@/stores/subagent'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { effectScope } from 'vue'

function makeWorkflow(id: string): WorkflowRunRecord {
  return {
    runId: id,
    scriptName: `wf-${id}`,
    slug: '',
    status: 'running',
    agentCalls: [],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('U5: session store listLoadError（W2 / S5）', () => {
  it('loadSessions 失败后 session.listLoadError 为非空错误消息', async () => {
    const scope = effectScope()
    scope.run(() => useSidebar())
    const session = useSessionStore()

    listMock.mockRejectedValue(new Error('server down'))
    // loadSessions 是 useSidebar 内部函数，通过重新调用触发
    // 需要直接调 useSidebar().loadSessions()
    const sidebar = scope.run(() => useSidebar())!
    await sidebar.loadSessions()

    expect(session.listLoadError).toBe('server down')
    scope.stop()
  })

  it('loadSessions 成功后 listLoadError 清空为 null', async () => {
    const scope = effectScope()
    const sidebar = scope.run(() => useSidebar())!
    const session = useSessionStore()

    // 先失败
    listMock.mockRejectedValueOnce(new Error('fail'))
    await sidebar.loadSessions()
    expect(session.listLoadError).not.toBeNull()

    // 再成功
    listMock.mockResolvedValue([])
    await sidebar.loadSessions()
    expect(session.listLoadError).toBeNull()

    scope.stop()
  })
})

describe('U6: workflow store loadError（W2 / M1）', () => {
  it('loadWorkflows 失败后 loadError 含错误消息，records 保留旧数据', async () => {
    const store = useWorkflowStore()
    const sid = 's1'
    const record1 = makeWorkflow('w1')

    // 先成功加载一条数据
    getWorkflowsMock.mockResolvedValueOnce([record1])
    await store.loadWorkflows(sid)
    expect(store.getRecordsBySession(sid)).toHaveLength(1)

    // 再失败
    getWorkflowsMock.mockRejectedValue(new Error('timeout'))
    await store.loadWorkflows(sid)

    expect(store.loadErrorOf('s1')).toBe('timeout')
    // records 保留旧数据（未被清空）
    expect(store.getRecordsBySession(sid)).toEqual([record1])
    expect(store.isLoadingOf('s1')).toBe(false)
  })
})

describe('U7: subagent fetchAndInject fail-fast（W2 / M5）', () => {
  it('fetchAndInject 失败时 throw，setMessages 不被调用', async () => {
    const store = useSubagentStore()
    const setMessages = vi.fn()

    getSubagentHistoryMock.mockRejectedValue(new Error('rpc fail'))

    await expect(
      store.fetchAndInject('mainSid', 'subId', setMessages),
    ).rejects.toThrow('rpc fail')

    // setMessages 未被调用（不再静默注入空数组）
    expect(setMessages).not.toHaveBeenCalled()
  })
})
