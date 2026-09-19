/**
 * useTrayCounts 数据面测试（u-tray-native，设计 docs/design/composer-task-tray.md §3.3 D2/D13）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：三件计数口径与谓词边界——running+stopReason（死亡纳管态）不落进行中、
 *   archived 归已结束（[两视图裁决 2026-09-16]）、workflow running 计入进行中、bash 两视图由
 *   background-task-bucket SSOT 谓词派生；D13 首拉触发与 retry 调用序；错误态/加载态暴露面
 * - 使用者（黑盒）：本文件是纯逻辑面（无 DOM）；用户可见断言在 tray-native-panel.test.ts
 * - 观察者（形态）：同上（面板渲染形态由组件测试承载）
 *
 * mock 策略：
 * - `@/composables/features/sidebar/useBackgroundTasks` mock：bash 分区直接 mutate
 *   （状态根自身行为另有专项测试，本文件只验托盘消费口径）
 * - `@/api` mock：首拉 RPC（getSubagents/getWorkflows）结果可控；load* 写 store 分区的路径真实
 * - 真实 pinia + 真实 store：计数跑真实 recordsOf 分区（不 mock store 派生链）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/useTrayCounts.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useSessionStore } from '@/stores/session'
import { useTrayCounts } from '@/components/panel/tray/useTrayCounts'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { SessionSummary, SubagentRecord, WorkflowRunRecord } from '@taiji/shared'

// ── mock：bash 分区状态根（直接 mutate 模拟 list reply / 广播）──
let partitionState: { tasks: BackgroundTaskEntry[]; loaded: boolean; corrupted: boolean; fetchFailed: boolean }
const refreshMock = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined))
vi.mock('@/composables/features/sidebar/useBackgroundTasks', () => ({
  useBackgroundTasks: () => ({
    current: computed(() => partitionState),
    refresh: refreshMock,
  }),
}))

// ── mock：首拉 RPC（subagent/workflow 列表）──
const apiMocks = vi.hoisted(() => ({
  getSubagents: vi.fn<(sessionId: string) => Promise<SubagentRecord[]>>(),
  getWorkflows: vi.fn<(sessionId: string) => Promise<WorkflowRunRecord[]>>(),
}))
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    session: {
      ...actual.session,
      getSubagents: apiMocks.getSubagents,
      getWorkflows: apiMocks.getWorkflows,
    },
  }
})

const SID = 's-tray'
const SID2 = 's-tray-2'
/** fake timers 固定「现在」：bash running 行耗时派生确定性 */
const FIXED_NOW = new Date(2026, 8, 16, 10, 30, 0).getTime()

function makeSubagent(overrides: Partial<SubagentRecord> & { subagentId: string }): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'reviewer',
    slug: 'review',
    task: 'review the change',
    status: 'idle',
    ...overrides,
  }
}

function makeWorkflow(overrides: Partial<WorkflowRunRecord> & { runId: string }): WorkflowRunRecord {
  return {
    scriptName: 'release',
    status: 'running',
    startedAt: new Date(FIXED_NOW).toISOString(),
    agentCalls: [],
    stateFilePath: '/data/wf-state.jsonl',
    ...overrides,
  }
}

function makeTask(overrides: Partial<BackgroundTaskEntry> & { taskId: string }): BackgroundTaskEntry {
  return {
    pid: 1,
    command: 'echo',
    outputFile: '/tmp/taiji/bg.log',
    startedAt: FIXED_NOW - 1000,
    state: 'running',
    ownerPiPid: 500,
    sessionId: SID,
    ...overrides,
  }
}

// ── 测试宿主：useTrayCounts 需组件 setup 上下文（内部 watch 依赖实例 scope）──
let tray: UseTrayCountsReturn | undefined
const Harness = defineComponent({
  props: { sessionId: { type: String, required: true } },
  setup(props) {
    tray = useTrayCounts(computed(() => props.sessionId))
    return () => h('div')
  },
})

function mountHarness(sessionId = SID) {
  return mount(Harness, { props: { sessionId } })
}

/** 当前数据面（防守：宿主 setup 必已赋值） */
function data(): UseTrayCountsReturn {
  if (!tray) throw new Error('useTrayCounts 未挂载')
  return tray
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMocks.getSubagents.mockResolvedValue([])
  apiMocks.getWorkflows.mockResolvedValue([])
  // reactive 容器：bash 分区面的字段变更需驱动下游 computed 重算（mock 契约同真实分区）
  partitionState = reactive({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })
  tray = undefined
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useTrayCounts 计数口径与谓词边界（D2）', () => {
  it('subagent：进行中 = isRunningProjection；running+stopReason 与 idle 均落已结束（[两视图裁决 2026-09-16]）', async () => {
    const subagentStore = useSubagentStore()
    subagentStore.applyRecords(SID, [
      makeSubagent({ subagentId: 'a-running', status: 'running' }),
      // 死亡纳管态（W4 adoptEngineDeath：running + stopReason='failed'）→ 不落进行中
      makeSubagent({ subagentId: 'a-dead', status: 'running', stopReason: 'failed' }),
      makeSubagent({ subagentId: 'a-idle', status: 'idle' }),
    ])
    mountHarness()

    expect(data().counts.value.subagent).toEqual({ running: 1, ended: 2, total: 3 })
    expect(data().lists.subagent.running.value.map((r) => r.subagentId)).toEqual(['a-running'])
    expect(data().lists.subagent.ended.value.map((r) => r.subagentId)).toEqual([
      'a-dead',
      'a-idle',
    ])
    // 两桶互斥且全覆盖（running + ended = total）
    const counts = data().counts.value.subagent
    expect(counts.running + counts.ended).toBe(counts.total)
  })

  it('subagent：origin=workflow 的 record 不计入任何桶（workflow 面板承载）', async () => {
    const subagentStore = useSubagentStore()
    subagentStore.applyRecords(SID, [
      makeSubagent({ subagentId: 'a-tool', status: 'running' }),
      makeSubagent({ subagentId: 'a-wf', status: 'running', origin: 'workflow' }),
    ])
    mountHarness()

    expect(data().counts.value.subagent).toEqual({ running: 1, ended: 0, total: 1 })
    expect(data().lists.subagent.running.value.map((r) => r.subagentId)).toEqual(['a-tool'])
  })

  it('workflow：running 计入进行中，done 落已结束（一次性生命周期 D-2：无 paused 态）', async () => {
    const workflowStore = useWorkflowStore()
    workflowStore.applyRecords(SID, [
      makeWorkflow({ runId: 'wf-run', status: 'running' }),
      makeWorkflow({ runId: 'wf-done', status: 'done', reason: 'completed' }),
    ])
    mountHarness()

    expect(data().counts.value.workflow).toEqual({ running: 1, ended: 1, total: 2 })
    expect(data().lists.workflow.running.value.map((r) => r.runId)).toEqual(['wf-run'])
    expect(data().lists.workflow.ended.value.map((r) => r.runId)).toEqual(['wf-done'])
  })

  it('bash：两视图由 background-task-bucket SSOT 谓词派生（killing 属运行中桶，含排序）', async () => {
    partitionState.tasks = [
      makeTask({ taskId: 'bt-ended-old', state: 'exited', exitCode: 0, reason: 'natural', startedAt: FIXED_NOW - 60_000, endedAt: FIXED_NOW - 30_000 }),
      makeTask({ taskId: 'bt-killing', state: 'killing', startedAt: FIXED_NOW - 5_000 }),
      makeTask({ taskId: 'bt-ended-new', state: 'exited', exitCode: 1, reason: 'natural', startedAt: FIXED_NOW - 50_000, endedAt: FIXED_NOW - 10_000 }),
      makeTask({ taskId: 'bt-running', state: 'running', startedAt: FIXED_NOW - 20_000 }),
      makeTask({ taskId: 'bt-orphaned', state: 'orphaned', startedAt: FIXED_NOW - 70_000, endedAt: FIXED_NOW - 40_000 }),
    ]
    mountHarness()

    expect(data().counts.value.bash).toEqual({ running: 2, ended: 3, total: 5 })
    // 运行中桶：startedAt 升序（SSOT 排序内置，本层不二次加工）
    expect(data().lists.bash.running.value.map((t) => t.taskId)).toEqual(['bt-running', 'bt-killing'])
    // 已结束桶：endedAt 倒序
    expect(data().lists.bash.ended.value.map((t) => t.taskId)).toEqual([
      'bt-ended-new',
      'bt-ended-old',
      'bt-orphaned',
    ])
  })

  it('计数随 session 分区切换（各 session 独立，不串台）', async () => {
    // 首拉 RPC 按 sid 返回不同列表：切 session 后计数跟随新分区（真实 load* 写分区路径）
    apiMocks.getSubagents.mockImplementation(async (sid: string) =>
      sid === SID2
        ? [
            makeSubagent({ subagentId: 'b-1', status: 'idle' }),
            makeSubagent({ subagentId: 'b-2', status: 'idle' }),
          ]
        : [makeSubagent({ subagentId: 'a-1', status: 'running' })],
    )
    const wrapper = mountHarness(SID)
    await vi.waitFor(() => expect(data().counts.value.subagent.running).toBe(1))

    await wrapper.setProps({ sessionId: SID2 })
    await vi.waitFor(() => expect(data().counts.value.subagent.total).toBe(2))
    expect(data().counts.value.subagent).toEqual({ running: 0, ended: 2, total: 2 })
  })
})

/** 子会话 fixture（u7：session kind 数据源 = renderer session store 的 SessionSummary） */
function makeChild(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    label: '子会话',
    cwd: '/Users/dev/Code/work-project',
    status: 'idle',
    lastActiveAt: FIXED_NOW,
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 0,
    spawnSource: 'agent',
    parentAgentSessionId: SID,
    ...overrides,
  }
}

describe('useTrayCounts session kind（第 4 件子会话，u7 / 设计 .tmp/tech-design/mode-system-composer-density.md §6.7 D7）', () => {
  it('仅计 parentAgentSessionId === 当前 sessionId：父为 null 的根会话 / 别人（SID2）的子会话都不计入', () => {
    useSessionStore().applySnapshot({
      groups: [
        {
          cwd: '/w',
          sessions: [
            makeChild({ id: 'c-mine', parentAgentSessionId: SID, status: 'active' }),
            makeChild({ id: 'c-other', parentAgentSessionId: SID2, status: 'active' }),
            makeChild({ id: 'c-root', parentAgentSessionId: undefined, status: 'active' }),
          ],
        },
      ],
    })
    mountHarness(SID)

    expect(data().counts.value.session).toEqual({ running: 1, ended: 0, total: 1 })
    expect(data().lists.session.children.value.map((c) => c.id)).toEqual(['c-mine'])
  })

  it('运行中计数口径 = SessionSummary.status === \'active\'；状态翻转后计数跟随（运行中 → 完成）', async () => {
    const sessionStore = useSessionStore()
    sessionStore.applySnapshot({
      groups: [
        {
          cwd: '/w',
          sessions: [
            makeChild({ id: 'c-run', status: 'active' }),
            makeChild({ id: 'c-done', status: 'done' }),
            makeChild({ id: 'c-err', status: 'error' }),
          ],
        },
      ],
    })
    mountHarness(SID)
    expect(data().counts.value.session).toEqual({ running: 1, ended: 2, total: 3 })

    // 子会话结束（active → done）：运行中归零，已结束 +1（同一 store，响应式重算）
    sessionStore.applySnapshot('c-run', { status: 'done' })
    await nextTick()
    expect(data().counts.value.session).toEqual({ running: 0, ended: 3, total: 3 })
  })

  it('行集按 lastActiveAt 倒序（最近在前；面板行序 = 数据面行序）', () => {
    useSessionStore().applySnapshot({
      groups: [
        {
          cwd: '/w',
          sessions: [
            makeChild({ id: 'c-old', lastActiveAt: FIXED_NOW - 60_000 }),
            makeChild({ id: 'c-new', lastActiveAt: FIXED_NOW - 1_000 }),
          ],
        },
      ],
    })
    mountHarness(SID)
    expect(data().lists.session.children.value.map((c) => c.id)).toEqual(['c-new', 'c-old'])
  })

  it('无 session（null sid）→ session 计数归零（不读全表）', () => {
    useSessionStore().applySnapshot({
      groups: [{ cwd: '/w', sessions: [makeChild({ id: 'c-mine', status: 'active' })] }],
    })
    const wrapper = mountHarness('')
    expect(data().counts.value.session).toEqual({ running: 0, ended: 0, total: 0 })
    wrapper.unmount()
  })
})

describe('useTrayCounts D13 首拉触发与 retry', () => {
  it('挂载即拉：loadSubagents / loadWorkflows 各以当前 sessionId 调一次', async () => {
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    const loadSubSpy = vi.spyOn(subagentStore, 'loadSubagents')
    const loadWfSpy = vi.spyOn(workflowStore, 'loadWorkflows')

    mountHarness()
    await vi.waitFor(() => {
      expect(loadSubSpy).toHaveBeenCalledTimes(1)
      expect(loadWfSpy).toHaveBeenCalledTimes(1)
    })
    expect(loadSubSpy).toHaveBeenCalledWith(SID)
    expect(loadWfSpy).toHaveBeenCalledWith(SID)
    // 拉取腿真正落到 RPC（store 内部未短路）
    expect(apiMocks.getSubagents).toHaveBeenCalledWith(SID)
    expect(apiMocks.getWorkflows).toHaveBeenCalledWith(SID)
  })

  it('sessionId 变化 → 按新 sid 重拉（历史桶依赖此腿）', async () => {
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    const loadSubSpy = vi.spyOn(subagentStore, 'loadSubagents')
    const loadWfSpy = vi.spyOn(workflowStore, 'loadWorkflows')

    const wrapper = mountHarness(SID)
    await vi.waitFor(() => expect(loadSubSpy).toHaveBeenCalledTimes(1))

    await wrapper.setProps({ sessionId: SID2 })
    await vi.waitFor(() => expect(loadSubSpy).toHaveBeenCalledTimes(2))
    expect(loadSubSpy).toHaveBeenLastCalledWith(SID2)
    expect(loadWfSpy).toHaveBeenLastCalledWith(SID2)
    expect(apiMocks.getSubagents).toHaveBeenLastCalledWith(SID2)
    expect(apiMocks.getWorkflows).toHaveBeenLastCalledWith(SID2)
  })

  it('retry(kind) 按类重拉：subagent / workflow → load*；bash → refresh', async () => {
    mountHarness()
    await vi.waitFor(() => expect(apiMocks.getWorkflows).toHaveBeenCalledTimes(1))
    vi.clearAllMocks()

    await data().retry('subagent')
    expect(apiMocks.getSubagents).toHaveBeenCalledWith(SID)
    expect(apiMocks.getWorkflows).not.toHaveBeenCalled()

    await data().retry('workflow')
    expect(apiMocks.getWorkflows).toHaveBeenCalledWith(SID)
    expect(refreshMock).not.toHaveBeenCalled()

    await data().retry('bash')
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it('无 session 时不拉取（null sid 不写分区，retry no-op）', async () => {
    const wrapper = mountHarness('')
    await vi.waitFor(() => expect(apiMocks.getSubagents).not.toHaveBeenCalled())
    await data().retry('subagent')
    expect(apiMocks.getSubagents).not.toHaveBeenCalled()
    expect(data().counts.value.subagent.total).toBe(0)
    wrapper.unmount()
  })
})

describe('useTrayCounts 错误态与加载态暴露面（面板 retry 判据）', () => {
  it('loadError 透出（subagent / workflow 各自独立）', async () => {
    mountHarness()
    expect(data().errors.subagent.value).toBeNull()
    expect(data().errors.workflow.value).toBeNull()

    apiMocks.getSubagents.mockRejectedValueOnce(new Error('rpc-down'))
    await data().retry('subagent')
    expect(data().errors.subagent.value).toBe('rpc-down')
    // workflow 侧不受影响（各自独立通道）
    expect(data().errors.workflow.value).toBeNull()
  })

  it('loading：bash = 从未拉到过一次；subagent/workflow = store isLoading', async () => {
    partitionState.loaded = false
    mountHarness()
    expect(data().loading.bash.value).toBe(true)

    partitionState.loaded = true
    await vi.advanceTimersByTimeAsync(0)
    expect(data().loading.bash.value).toBe(false)
    expect(data().loading.subagent.value).toBe(false)
    expect(data().loading.workflow.value).toBe(false)
  })

  it('bash 分区（loaded/corrupted/fetchFailed）原样透出供提示条判定', () => {
    partitionState.corrupted = true
    partitionState.fetchFailed = true
    mountHarness()
    expect(data().bashPartition.value.corrupted).toBe(true)
    expect(data().bashPartition.value.fetchFailed).toBe(true)
  })
})
