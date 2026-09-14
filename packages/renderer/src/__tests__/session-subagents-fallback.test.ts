/**
 * routeInbound effects 装配兜底测试（session.subagents / session.workflowUpdate 终态推送链路；
 * 原 session-workflow-update-fallback.test.ts 的 TC2 已并入本文件，同 mock 骨架）。
 *
 * 锁定根因：subagent/workflow 终态推送（session.subagents / session.workflowUpdate）此前只在
 * per-focus 订阅里处理，用户切走 session 即退订 → dispatchSession 静默丢弃
 * → 分区里 running 记录永不更新 → 侧栏菊花永转。修复：routeInbound 兜底，在 dispatchSession 之后
 * 无条件 applyRecords / triggerWorkflowReload（仿 session.exited / message.complete）。
 *
 * 验证链路：transport.onMessage 注册的 routeInbound handler 收到终态推送 →
 *   1. subagents 非活跃 session（focus≠A）：applyRecords(A, [done]) → A 分区更新，hasRunning(A)=false
 *   2. workflowUpdate 非活跃 session：终态信号触发 loadWorkflows → 分区 done，hasRunningOrPaused=false
 *   （running 信号 500ms 延迟重试在 store 层，由 stores/workflow.test.ts triggerWorkflowReload describe 锁定）
 *
 * mock 策略：vi.hoisted 捕获 ws-client.onMessage 注册的 routeInbound handler，测试向其注入
 * ServerMessage。mock ipc/ws-client 避免 init() 真实连接。mock @/api/domains/session 域函数
 * （store 经 @/api 门面导入 session，需把门面指回 domains 命名空间，同 subagent-push.test.ts）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/session-subagents-fallback.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ServerMessage, SessionGroup, SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'

// vi.hoisted 保证 mock 工厂在模块加载前就绪；resetModules 后重新加载 useConnection 时
// 仍走同一 mock 工厂（mock 在 hoisted 层注册，不受 resetModules 影响）
const mockHolder = vi.hoisted(() => {
  return {
    // 捕获 transport.on（ws-client.onMessage）注册的 routeInbound handler
    routeHandler: null as ((msg: ServerMessage) => void) | null,
    // ws-client.getState 返回的 ref。vi.hoisted 在 import 前执行，不能调 vue 的 ref，
    // 这里放 null，在 beforeEach 中用真正的 ref 替换。
    stateRef: null as ReturnType<typeof ref<string>> | null,
  }
})

// §10.2 D-1 后 useConnection 迁 core：dispatcher 经 core ws-client onMessage 注册。
// u1 实证：shim/桥不转发 mock，必须 mock core ws-client 叶子模块本身（按相对路径
// 直指 core 源文件解析到同一模块 ID）；u4 已删除 renderer lib/ws-client deprecated shim。
vi.mock('../../../core/src/transport/ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  getState: () => mockHolder.stateRef!,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: vi.fn((cb: (msg: ServerMessage) => void) => {
    mockHolder.routeHandler = cb
    return () => { mockHolder.routeHandler = null }
  }),
  onQueueDrop: vi.fn(() => () => {}),
}))

vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn(async () => undefined),
  getRuntimePortOffset: vi.fn(async () => undefined),
  getRuntimeToken: vi.fn(async () => undefined),
  onRuntimePort: vi.fn(() => () => {}),
  onRuntimeRestarting: vi.fn(() => () => {}),
  onRuntimeFailed: vi.fn(() => () => {}),
  restartRuntime: vi.fn(async () => {}),
}))

// mock sessionApi（subagent/workflow store 内部 import；getSubagents 首拉返回空，
// getWorkflows 用 vi.fn() 由用例内 mockResolvedValueOnce 控制返回值）
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  getSubagents: vi.fn(async () => []),
  getSubagentHistory: vi.fn(async () => []),
  getWorkflows: vi.fn(),
  getAgentCallHistory: vi.fn(),
  // useConnection.ensureDispatcher 经 sessionApi.subscribe 注入 ports（T2 后）
  subscribe: vi.fn(async () => {}),
  unsubscribe: vi.fn(async () => {}),
}))

// subagent store 经 @/api 门面导入 session，需把门面 session 指回上面 mock 的 domains 命名空间，
// 保证 store 与断言用的是同一个 vi.fn()（同 subagent-push.test.ts:21-25）。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  return { ...actual, session }
})

// 动态 import 容器：beforeEach resetModules 后重新加载
let useConnection: typeof import('@/composables/useConnection').useConnection
let usePanelStore: typeof import('@/stores/panel').usePanelStore
let useSessionStore: typeof import('@/stores/session').useSessionStore
let useSubagentStore: typeof import('@/stores/subagent').useSubagentStore
let useWorkflowStore: typeof import('@/stores/workflow').useWorkflowStore
let sessionApi: typeof import('@xyz-agent/core/transport/api/domains/session')

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mockHolder.routeHandler = null
  mockHolder.stateRef = ref('disconnected')
  vi.resetModules()

  const conn = await import('@/composables/useConnection')
  useConnection = conn.useConnection
  usePanelStore = (await import('@/stores/panel')).usePanelStore
  useSessionStore = (await import('@/stores/session')).useSessionStore
  useSubagentStore = (await import('@/stores/subagent')).useSubagentStore
  useWorkflowStore = (await import('@/stores/workflow')).useWorkflowStore
  sessionApi = await import('@xyz-agent/core/transport/api/domains/session')

  // 初始化 session store 含两个 session（A、B）
  const sessionStore = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 'sess-A', label: 'A', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
      { id: 'sess-B', label: 'B', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
    ],
  }
  sessionStore.applySnapshot({ groups: [group] })
})

async function initAndConnect(): Promise<void> {
  mockHolder.stateRef.value = 'connecting'
  const { init } = useConnection()
  await init()
  mockHolder.stateRef.value = 'connected'
}

/** 构造测试 SubagentRecord */
function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'sa-1',
    sessionFile: null,
    agent: 'reviewer',
    slug: 'fix',
    task: 'Fix',
    status: 'running',
    ...overrides,
  }
}

describe('session.subagents routeInbound 兜底', () => {
  it('TC1 非活跃 session 兜底：focus=B 时 A 的终态推送仍更新 A 分区（侧栏不卡 running）', async () => {
    await initAndConnect()
    expect(mockHolder.routeHandler).not.toBeNull()

    const panel = usePanelStore()
    const subagentStore = useSubagentStore()

    // 焦点为 B（A 为非活跃 session）
    panel.loadSession(panel.panels[0].id, 'sess-B')

    // 预填 A 分区一条 running 记录（模拟 subagent 发起后侧栏显示菊花）
    subagentStore.applyRecords('sess-A', [makeRecord({ subagentId: 'sa-1', status: 'running' })])
    expect(subagentStore.hasRunning('sess-A')).toBe(true)

    // 注入 A 的终态推送（status: done）
    const msg: ServerMessage = {
      type: 'session.subagents',
      payload: { sessionId: 'sess-A', subagents: [makeRecord({ subagentId: 'sa-1', status: 'done' })] },
    }
    mockHolder.routeHandler!(msg)

    // A 分区更新为 done
    expect(subagentStore.getRecordsBySession('sess-A')[0].status).toBe('done')
    // 侧栏不再显示 running
    expect(subagentStore.hasRunning('sess-A')).toBe(false)
  })

  // （原 TC4「活跃 session 兜底」已删：route-inbound 兜底本就不判焦点，与 TC1 走同一
  // 代码路径产出同一断言，属重复锁面。）

  /** 构造测试 WorkflowRunRecord（最小字段集，覆盖 status 断言） */
  function makeWorkflow(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
    return {
      runId: 'w1',
      scriptName: 'flow',
      status: 'done',
      reason: 'completed',
      startedAt: '2026-07-10T10:00:00Z',
      completedAt: '2026-07-10T10:30:00Z',
      usedTokens: 0,
      totalCallCount: 0,
      agentCalls: [],
      stateFilePath: '/data/w1.jsonl',
      ...overrides,
    }
  }

  it('TC2-W 非活跃 session workflow 终态兜底：focus≠A 时 A 的终态信号触发 loadWorkflows 更新分区', async () => {
    await initAndConnect()
    expect(mockHolder.routeHandler).not.toBeNull()

    const panel = usePanelStore()
    const workflowStore = useWorkflowStore()

    // 焦点为 B（A 非活跃）
    panel.loadSession(panel.panels[0].id, 'sess-B')

    // 预填 A 分区 running workflow（模拟侧栏菊花）
    workflowStore.applyRecords('sess-A', [makeWorkflow({ runId: 'w1', status: 'running' })])
    expect(workflowStore.hasRunningOrPaused('sess-A')).toBe(true)

    // getWorkflows 返回 done（终态）
    vi.mocked(sessionApi.getWorkflows).mockResolvedValueOnce([makeWorkflow({ runId: 'w1', status: 'done' })])

    // 注入 A 的 workflowUpdate 终态信号
    const msg: ServerMessage = {
      type: 'session.workflowUpdate',
      payload: { sessionId: 'sess-A', update: { runId: 'w1', status: 'done' } },
    }
    mockHolder.routeHandler!(msg)

    // 等 loadWorkflows RPC flush
    await vi.waitFor(() => {
      expect(workflowStore.getRecordsBySession('sess-A')[0].status).toBe('done')
    })

    expect(workflowStore.hasRunningOrPaused('sess-A')).toBe(false)
    expect(sessionApi.getWorkflows).toHaveBeenCalledWith('sess-A')
  })
})
