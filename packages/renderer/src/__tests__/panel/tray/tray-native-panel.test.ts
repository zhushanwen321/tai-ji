/**
 * TrayNativePanel 组件测试（u-tray-native，设计 docs/design/composer-task-tray.md
 * §3.3 D2/D8/D9 + §3.5 错误规格）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：每条用例至少一个用户可见断言——行渲染（命令/耗时/pid/exit、
 *   agent/slug/task、scriptName/进度）、tab 切换、空态按钮、两段式首击确认态
 * - 观察者（形态）：pin 门控（hover 态无行内按钮）、错误态 retry、断连提示条、加载态
 * - 构建者（白盒）：行点击归宿矩阵（drawer 三 tab）与 RPC 参数（计数口径在
 *   useTrayCounts.test.ts 覆盖）
 *
 * mock 策略：
 * - `useTrayCounts` mock：数据面（计数/行集/错误/加载）直接注入——口径测试在同目录
 *   useTrayCounts.test.ts，本文件只验渲染与交互
 * - 真实 pinia + 真实 subagent/workflow store：cancel 防误报读 store 真判据
 *   （isStreamingSubagent），workflow 操作回执路径真实
 * - `@taiji/core/transport/api/domains/*` mock：kill / workflowAction RPC 可控
 * - vue-i18n 走全局 setup（从 zh-CN locale 取值）：断言真实中文文案 + 插值形态
 * - 时间：vi.useFakeTimers({ now: FIXED_NOW })——bash running 行耗时确定性
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/tray-native-panel.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { bindDrawerSessionId, getDrawerControlState, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import { subagentVirtualId } from '@taiji/shared'
import TrayNativePanel from '@/components/panel/tray/TrayNativePanel.vue'
import zhTray from '@/i18n/locales/zh-CN/tray'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { SubagentRecord, WorkflowRunRecord } from '@taiji/shared'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'
import * as sessionApi from '@taiji/core/transport/api/domains/session'

type TrayKind = 'bash' | 'subagent' | 'workflow'

// ── mock：数据面（计数/行集/错误/加载态；口径与首拉触发在 useTrayCounts.test.ts）──
interface TrayState {
  bashRunning: BackgroundTaskEntry[]
  bashEnded: BackgroundTaskEntry[]
  subagentRunning: SubagentRecord[]
  subagentEnded: SubagentRecord[]
  subagentArchived: SubagentRecord[]
  workflowRunning: WorkflowRunRecord[]
  workflowEnded: WorkflowRunRecord[]
  subagentError: string | null
  workflowError: string | null
  subagentLoading: boolean
  workflowLoading: boolean
  bashLoaded: boolean
  bashFetchFailed: boolean
  bashCorrupted: boolean
}

function createTrayState(): TrayState {
  return {
    bashRunning: [],
    bashEnded: [],
    subagentRunning: [],
    subagentEnded: [],
    subagentArchived: [],
    workflowRunning: [],
    workflowEnded: [],
    subagentError: null,
    workflowError: null,
    subagentLoading: false,
    workflowLoading: false,
    bashLoaded: true,
    bashFetchFailed: false,
    bashCorrupted: false,
  }
}

/** reactive 容器（字段变更驱动下游 computed；对象本身恒不替换，防 computed 依赖失联） */
const trayState = reactive<TrayState>(createTrayState())
const retryMock = vi.hoisted(() => vi.fn<(kind: TrayKind) => Promise<void>>().mockResolvedValue(undefined))

vi.mock('@/components/panel/tray/useTrayCounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/panel/tray/useTrayCounts')>()
  return {
    ...actual,
    useTrayCounts: () => ({
      counts: computed(() => ({
        bash: {
          running: trayState.bashRunning.length,
          ended: trayState.bashEnded.length,
          total: trayState.bashRunning.length + trayState.bashEnded.length,
        },
        subagent: {
          running: trayState.subagentRunning.length,
          ended: trayState.subagentEnded.length,
          archived: trayState.subagentArchived.length,
          total:
            trayState.subagentRunning.length +
            trayState.subagentEnded.length +
            trayState.subagentArchived.length,
        },
        workflow: {
          running: trayState.workflowRunning.length,
          ended: trayState.workflowEnded.length,
          total: trayState.workflowRunning.length + trayState.workflowEnded.length,
        },
      })),
      lists: {
        bash: {
          running: computed(() => trayState.bashRunning),
          ended: computed(() => trayState.bashEnded),
        },
        subagent: {
          running: computed(() => trayState.subagentRunning),
          ended: computed(() => trayState.subagentEnded),
          archived: computed(() => trayState.subagentArchived),
        },
        workflow: {
          running: computed(() => trayState.workflowRunning),
          ended: computed(() => trayState.workflowEnded),
        },
      },
      bashPartition: computed(() => ({
        tasks: [],
        loaded: trayState.bashLoaded,
        corrupted: trayState.bashCorrupted,
        fetchFailed: trayState.bashFetchFailed,
      })),
      errors: {
        subagent: computed(() => trayState.subagentError),
        workflow: computed(() => trayState.workflowError),
      },
      loading: {
        bash: computed(() => !trayState.bashLoaded),
        subagent: computed(() => trayState.subagentLoading),
        workflow: computed(() => trayState.workflowLoading),
      },
      retry: retryMock,
    }),
  }
})

// ── mock：bash kill RPC ──
vi.mock('@taiji/core/transport/api/domains/background-task', () => ({
  kill: vi.fn(),
}))

// ── mock：workflow pause/resume/abort RPC（session 域其余导出保持真实）──
vi.mock('@taiji/core/transport/api/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/session')>()
  return { ...actual, workflowAction: vi.fn() }
})

// ── mock：store 首拉 RPC（面板不触发，防真实 transport 抖动）──
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    session: {
      ...actual.session,
      getSubagents: vi.fn().mockResolvedValue([]),
      getWorkflows: vi.fn().mockResolvedValue([]),
      subagentAction: vi.fn().mockResolvedValue(undefined),
      workflowAction: vi.fn().mockResolvedValue(undefined),
    },
  }
})

// ── mock：ws 连接态（断连提示条驱动）──
const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref: makeRef } = await import('vue')
  const stateRef = makeRef<string>('connected')
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
})

const SID = 's-tray-panel'
const FIXED_NOW = new Date(2026, 8, 16, 10, 30, 0).getTime()
const T = (offsetMs: number) => FIXED_NOW - offsetMs

/** i18n 模板插值（全局 setup 的 t mock 按 named 参数替换 {k}） */
function msg(template: string, params: Record<string, string | number> = {}): string {
  return Object.entries(params).reduce(
    (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
    template,
  )
}

function makeTask(overrides: Partial<BackgroundTaskEntry> & { taskId: string }): BackgroundTaskEntry {
  return {
    pid: 101,
    command: 'pnpm test',
    outputFile: '/tmp/taiji/bg.log',
    startedAt: T(37_000),
    state: 'running',
    ownerPiPid: 500,
    sessionId: SID,
    ...overrides,
  }
}

function makeSubagent(overrides: Partial<SubagentRecord> & { subagentId: string }): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'reviewer',
    slug: 'review-changes',
    task: 'Review the code changes',
    status: 'idle',
    turns: 5,
    totalTokens: 10000,
    elapsedSeconds: 65,
    ...overrides,
  }
}

function makeWorkflow(overrides: Partial<WorkflowRunRecord> & { runId: string }): WorkflowRunRecord {
  return {
    scriptName: 'release-flow',
    slug: 'rel',
    status: 'running',
    startedAt: new Date(T(60_000)).toISOString(),
    agentCalls: [
      { id: 'c1', agent: 'a', status: 'completed', phase: 'p1' },
      { id: 'c2', agent: 'b', status: 'running', phase: 'p1' },
    ],
    stateFilePath: '/data/wf.jsonl',
    ...overrides,
  }
}

function mountPanel(kind: TrayKind, extra: { pinned?: boolean } = {}) {
  return mount(TrayNativePanel, {
    props: { kind, sessionId: SID, pinned: false, ...extra },
  })
}

type PanelWrapper = ReturnType<typeof mountPanel>
function rowTexts(wrapper: PanelWrapper, testid: string): string[] {
  return wrapper.findAll(`[data-testid="${testid}"]`).map((row) => row.text())
}

/** 清空 toast 模块级队列（fake timers 下自动移除不触发，需显式清） */
function clearToasts(): void {
  const { toasts, remove } = useToast()
  for (const toast of [...toasts.value]) remove(toast.id)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  Object.assign(trayState, createTrayState())
  _resetDrawerForTest()
  bindDrawerSessionId(ref(SID))
  usePanelStore().loadSession(ROOT_PANEL_ID, SID)
  clearToasts()
  vi.mocked(sessionApi.workflowAction).mockResolvedValue(undefined)
  vi.mocked(backgroundTaskApi.kill).mockResolvedValue({
    sessionId: SID,
    taskId: 'bt-1',
    killed: true,
    reason: 'killed',
  })
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  vi.useRealTimers()
  clearToasts()
  __clearSessionCleanupRegistryForTest()
  if (wsMock.ref) wsMock.ref.value = 'connected'
})

describe('TrayNativePanel 分桶 tab 与行渲染（使用者黑盒）', () => {
  it('bash：默认「运行中」tab 亮 + 两 tab 计数 + 行渲染命令/实时耗时/pid', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', startedAt: T(53_000), endedAt: T(3_000), durationMs: 50_000 }),
    ]
    const wrapper = mountPanel('bash')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-native-panel"]').attributes('data-kind')).toBe('bash')
    // 进程域用「运行中」（与 subagent/workflow 的「进行中」区分，见 locale 文件头词表裁决）
    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').text()).toContain(zhTray.tray.bucket.runningProcess)
    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="tray-panel-tab-count-running"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="tray-panel-tab-count-ended"]').text()).toBe('1')
    // 行渲染：命令 + 实时耗时（fake now - startedAt = 37s）+ pid（running 无 exit 段）
    const row = wrapper.find('[data-testid="tray-bash-row"]')
    expect(row.text()).toContain('pnpm test')
    expect(row.text()).toContain('00:37')
    expect(row.find('[data-testid="tray-bash-meta"]').text()).toContain(
      `${zhTray.tray.pidLabel} 101`,
    )
    expect(row.find('[data-testid="tray-bash-meta"]').text()).not.toContain(zhTray.tray.exitLabel)

    // 实时 tick：advance 1s → 00:38
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:38')
    wrapper.unmount()
  })

  it('bash：切「已结束」→ 终态行显示 exit 码（null 显 —）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    // 行序由数据面给定（排序是 background-task-bucket SSOT 的职责，口径在其单测覆盖；
    // 本文件只验渲染：killed（exitCode null）在前，正常终态在后）
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e2', state: 'exited', exitCode: null, reason: 'killed', endedAt: T(1_000), durationMs: 59_000 }),
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000), durationMs: 50_000 }),
    ]
    const wrapper = mountPanel('bash')
    await flushPromises()
    // 切桶前不渲染终态行（默认「运行中」）
    expect(rowTexts(wrapper, 'tray-bash-row')).toHaveLength(1)

    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-tab-ended"]').attributes('data-active')).toBe('true')
    const rows = rowTexts(wrapper, 'tray-bash-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain(`${zhTray.tray.exitLabel} —`)
    expect(rows[1]).toContain(`${zhTray.tray.exitLabel} 0`)
    wrapper.unmount()
  })

  it('subagent：三 tab（已收起计数 0 时 dim）+ 行渲染 agent/slug/摘要/turns/tokens/耗时', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running', engine: 'pi' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sub-2', status: 'idle', stopReason: 'failed' })]
    const wrapper = mountPanel('subagent')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').text()).toContain(zhTray.tray.bucket.running)
    expect(wrapper.find('[data-testid="tray-panel-tab-archived"]').text()).toContain(zhTray.tray.bucket.archived)
    expect(wrapper.find('[data-testid="tray-panel-tab-count-running"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="tray-panel-tab-count-archived"]').text()).toBe('0')
    // 计数 0 dim 不亮（class 断言）
    expect(wrapper.find('[data-testid="tray-panel-tab-count-archived"]').classes()).toContain('opacity-40')

    // 行渲染：引擎 icon + spinner（running）+ agent + slug + task 摘要 + turns/tokens/耗时
    const row = wrapper.find('[data-testid="tray-subagent-row"]')
    expect(row.find('[data-testid="tray-subagent-engine-icon"]').exists()).toBe(true)
    expect(row.find('[data-testid="tray-subagent-spinner"]').exists()).toBe(true)
    expect(row.text()).toContain('reviewer')
    expect(row.find('[data-testid="tray-subagent-slug"]').text()).toBe('review-changes')
    expect(row.text()).toContain('Review the code changes')
    expect(row.text()).toContain(`5 ${zhTray.tray.turnsUnit}`)
    expect(row.text()).toContain('10.0k tok')
    expect(row.text()).toContain('1m5s')
    wrapper.unmount()
  })

  it('workflow：行渲染 scriptName/slug/进度 N-M/耗时（paused 行无 spinner）', async () => {
    trayState.workflowRunning = [
      makeWorkflow({ runId: 'wf-1', status: 'running' }),
      makeWorkflow({ runId: 'wf-2', status: 'paused' }),
    ]
    const wrapper = mountPanel('workflow')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').text()).toContain(zhTray.tray.bucket.running)
    const rows = wrapper.findAll('[data-testid="tray-workflow-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('release-flow')
    expect(rows[0].find('[data-testid="tray-workflow-slug"]').text()).toBe('rel')
    expect(rows[0].text()).toContain(msg(zhTray.tray.agentsLabel, { done: 1, total: 2 }))
    expect(rows[0].text()).toContain('1m0s')
    // running 行有 spinner，paused 行无（状态点替代）
    expect(rows[0].find('[data-testid="tray-workflow-spinner"]').exists()).toBe(true)
    expect(rows[1].find('[data-testid="tray-workflow-spinner"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('TrayNativePanel 空态可行动（D9）', () => {
  it('默认「进行中」桶为空 + 已结束有内容：一行提示 + 「查看已结束 (N)」，不自动跳转', async () => {
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000) }),
      makeTask({ taskId: 'bt-e2', state: 'exited', exitCode: 1, reason: 'natural', endedAt: T(2_000) }),
    ]
    const wrapper = mountPanel('bash')
    await flushPromises()

    // 空态可见 + 仍是「运行中」tab（不自动跳）
    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').attributes('data-active')).toBe('true')
    expect(rowTexts(wrapper, 'tray-bash-row')).toHaveLength(0)
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.runningProcess, { name: zhTray.tray.title.bash }),
    )
    const jump = wrapper.find('[data-testid="tray-panel-empty-jump-ended"]')
    expect(jump.text()).toBe(msg(zhTray.tray.viewEnded, { count: 2 }))

    // 显式点击才切桶
    await jump.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-tab-ended"]').attributes('data-active')).toBe('true')
    expect(rowTexts(wrapper, 'tray-bash-row')).toHaveLength(2)
    wrapper.unmount()
  })

  it('已结束桶为空（有进行中）：仅提示，无切桶按钮', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running' })]
    const wrapper = mountPanel('subagent')
    await flushPromises()

    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.ended, { name: zhTray.tray.title.subagent }),
    )
    expect(wrapper.find('[data-testid="tray-panel-empty-jump-ended"]').exists()).toBe(false)
    expect(rowTexts(wrapper, 'tray-subagent-row')).toHaveLength(0)
    wrapper.unmount()
  })

  it('subagent：已结束也为空但已收起有内容 → 提供「查看已收起 (N)」寻回入口（D2 承接）', async () => {
    trayState.subagentArchived = [makeSubagent({ subagentId: 'sub-a1', status: 'idle', intent: 'archived' })]
    const wrapper = mountPanel('subagent')
    await flushPromises()

    const jump = wrapper.find('[data-testid="tray-panel-empty-jump-archived"]')
    expect(jump.text()).toBe(msg(zhTray.tray.viewArchived, { count: 1 }))

    await jump.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-tab-archived"]').attributes('data-active')).toBe('true')
    expect(rowTexts(wrapper, 'tray-subagent-row')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('TrayNativePanel 行内操作（pin 门控 + 两段式）', () => {
  it('hover 态（pinned=false）不渲染行内按钮；pin 态渲染（D8 防误触）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running' })]
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]

    const hovered = mountPanel('bash')
    await flushPromises()
    expect(hovered.find('[data-testid="tray-bash-kill"]').exists()).toBe(false)
    hovered.unmount()

    const pinned = mountPanel('bash', { pinned: true })
    await flushPromises()
    expect(pinned.find('[data-testid="tray-bash-kill"]').exists()).toBe(true)
    pinned.unmount()

    const subagentPinned = mountPanel('subagent', { pinned: true })
    await flushPromises()
    expect(subagentPinned.find('[data-testid="tray-subagent-cancel"]').exists()).toBe(true)
    subagentPinned.unmount()

    const workflowPinned = mountPanel('workflow', { pinned: true })
    await flushPromises()
    expect(workflowPinned.find('[data-testid="tray-workflow-pause"]').exists()).toBe(true)
    expect(workflowPinned.find('[data-testid="tray-workflow-abort"]').exists()).toBe(true)
    workflowPinned.unmount()
  })

  it('bash kill 两段式：首击进确认态（不发 RPC）、mouseleave 复位、再击才发 kill', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    const wrapper = mountPanel('bash', { pinned: true })
    await flushPromises()

    // 首击：确认态（✓ + data-confirming），不发 RPC
    await wrapper.find('[data-testid="tray-bash-kill"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-bash-kill-confirm"]').attributes('data-confirming')).toBe('true')
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()

    // mouseleave 复位（防误触残留）
    await wrapper.find('[data-testid="tray-bash-row"]').trigger('mouseleave')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-bash-kill-confirm"]').exists()).toBe(false)
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()

    // 再击：发 kill RPC（sessionId + taskId）+ 确认态复位
    await wrapper.find('[data-testid="tray-bash-kill"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="tray-bash-kill-confirm"]').trigger('click')
    await flushPromises()
    expect(backgroundTaskApi.kill).toHaveBeenCalledTimes(1)
    expect(backgroundTaskApi.kill).toHaveBeenCalledWith(SID, 'bt-1')
    expect(wrapper.find('[data-testid="tray-bash-kill"]').attributes('data-confirming')).toBe('false')
    wrapper.unmount()
  })

  it('subagent cancel 两段式正常路径：running 行两击 → store.cancelSubagent(sid, id)', async () => {
    const subagentStore = useSubagentStore()
    const running = makeSubagent({ subagentId: 'sub-1', status: 'running' })
    subagentStore.applyRecords(SID, [running])
    trayState.subagentRunning = [running]
    const cancelSpy = vi.spyOn(subagentStore, 'cancelSubagent').mockResolvedValue(undefined)
    const wrapper = mountPanel('subagent', { pinned: true })
    await flushPromises()

    await wrapper.find('[data-testid="tray-subagent-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-subagent-cancel-confirm"]').exists()).toBe(true)
    expect(cancelSpy).not.toHaveBeenCalled()

    await wrapper.find('[data-testid="tray-subagent-cancel-confirm"]').trigger('click')
    await flushPromises()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledWith(SID, 'sub-1')
    wrapper.unmount()
  })

  it('subagent cancel 迟到收口防误报：确认窗口期收口后第二击不发 RPC，toast「任务已结束」', async () => {
    const subagentStore = useSubagentStore()
    const running = makeSubagent({ subagentId: 'sub-1', status: 'running' })
    subagentStore.applyRecords(SID, [running])
    trayState.subagentRunning = [running]
    const cancelSpy = vi.spyOn(subagentStore, 'cancelSubagent').mockResolvedValue(undefined)
    const wrapper = mountPanel('subagent', { pinned: true })
    await flushPromises()

    await wrapper.find('[data-testid="tray-subagent-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-subagent-cancel-confirm"]').exists()).toBe(true)

    // 迟到收口（轮终广播）：record 翻 idle，确认钮保留（可达性优先于态过滤）
    subagentStore.applyRecords(SID, [makeSubagent({ subagentId: 'sub-1', status: 'idle' })])
    await flushPromises()
    const confirm = wrapper.find('[data-testid="tray-subagent-cancel-confirm"]')
    expect(confirm.exists()).toBe(true)

    // 第二击：不发 cancel RPC（runtime 会拒绝误报），toast 给出确定反馈
    await confirm.trigger('click')
    await flushPromises()
    expect(cancelSpy).not.toHaveBeenCalled()
    const { toasts } = useToast()
    expect(toasts.value.some((toast) => toast.message === zhTray.tray.alreadyEnded)).toBe(true)
    wrapper.unmount()
  })

  it('workflow：pause 单击即发 RPC；abort 两段式（首击确认不发，再击发 abort）', async () => {
    const workflowStore = useWorkflowStore()
    const loadSpy = vi.spyOn(workflowStore, 'loadWorkflows').mockResolvedValue(undefined)
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]
    const wrapper = mountPanel('workflow', { pinned: true })
    await flushPromises()

    await wrapper.find('[data-testid="tray-workflow-pause"]').trigger('click')
    await flushPromises()
    expect(sessionApi.workflowAction).toHaveBeenCalledWith(SID, 'pause', 'wf-1')
    expect(loadSpy).toHaveBeenCalledWith(SID)

    await wrapper.find('[data-testid="tray-workflow-abort"]').trigger('click')
    await flushPromises()
    expect(sessionApi.workflowAction).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="tray-workflow-abort-confirm"]').attributes('data-confirming')).toBe('true')

    await wrapper.find('[data-testid="tray-workflow-abort-confirm"]').trigger('click')
    await flushPromises()
    expect(sessionApi.workflowAction).toHaveBeenCalledTimes(2)
    expect(sessionApi.workflowAction).toHaveBeenLastCalledWith(SID, 'abort', 'wf-1')
    wrapper.unmount()
  })

  it('workflow：paused 行显示 resume 钮（点击发 resume）', async () => {
    const workflowStore = useWorkflowStore()
    vi.spyOn(workflowStore, 'loadWorkflows').mockResolvedValue(undefined)
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-2', status: 'paused' })]
    const wrapper = mountPanel('workflow', { pinned: true })
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-workflow-pause"]').exists()).toBe(false)
    await wrapper.find('[data-testid="tray-workflow-resume"]').trigger('click')
    await flushPromises()
    expect(sessionApi.workflowAction).toHaveBeenCalledWith(SID, 'resume', 'wf-2')
    wrapper.unmount()
  })
})

describe('TrayNativePanel 行点击归宿矩阵（D2）', () => {
  it('bash 行 → drawer bashTask tab（写 selectedBackgroundTaskId）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    const wrapper = mountPanel('bash')
    await flushPromises()

    await wrapper.find('[data-testid="tray-bash-row"]').trigger('click')
    await flushPromises()
    const control = getDrawerControlState()
    expect(control.selectedBackgroundTaskId).toBe('bt-1')
    expect(control.activeTab).toBe('bashTask')
    expect(control.isOpen).toBe(true)
    wrapper.unmount()
  })

  it('subagent 行 → drawer subagent tab（virtualId = subagentVirtualId(mainSid, subId)）', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running' })]
    const wrapper = mountPanel('subagent')
    await flushPromises()

    await wrapper.find('[data-testid="tray-subagent-row"]').trigger('click')
    await flushPromises()
    const control = getDrawerControlState()
    expect(control.selectedSubagentId).toBe(subagentVirtualId(SID, 'sub-1'))
    expect(control.activeTab).toBe('subagent')
    expect(control.enteredFrom).toBe('chat')
    expect(control.isOpen).toBe(true)
    wrapper.unmount()
  })

  it('workflow 行 → drawer workflow tab（以 runId 作选中值）', async () => {
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]
    const wrapper = mountPanel('workflow')
    await flushPromises()

    await wrapper.find('[data-testid="tray-workflow-row"]').trigger('click')
    await flushPromises()
    const control = getDrawerControlState()
    expect(control.selectedWorkflowName).toBe('wf-1')
    expect(control.activeTab).toBe('workflow')
    expect(control.isOpen).toBe(true)
    wrapper.unmount()
  })
})

describe('TrayNativePanel 观察者形态（错误态 / 断连 / 加载态）', () => {
  it('错误态：展示可读文案 + retry 按钮按类重拉', async () => {
    trayState.subagentError = 'rpc-down'
    const wrapper = mountPanel('subagent')
    await flushPromises()

    const error = wrapper.find('[data-testid="tray-panel-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain(msg(zhTray.tray.loadFailed, { error: 'rpc-down' }))
    // 错误态下不渲染分桶 tab（避免在无数据时展示空计数）
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)

    await wrapper.find('[data-testid="tray-panel-retry"]').trigger('click')
    await flushPromises()
    expect(retryMock).toHaveBeenCalledWith('subagent')
    wrapper.unmount()
  })

  it('加载态：首拉在途渲染加载文案（bash = 从未拉到过一次）', async () => {
    trayState.bashLoaded = false
    const wrapper = mountPanel('bash')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').text()).toContain(zhTray.tray.loading)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('bash 断连提示条：断连 + 拉取失败时出现，重连后消失；损坏条独立显示', async () => {
    trayState.bashFetchFailed = true
    wsMock.ref!.value = 'disconnected'
    const wrapper = mountPanel('bash')
    await flushPromises()

    const banner = wrapper.find('[data-testid="tray-bash-disconnect-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain(zhTray.tray.disconnectBanner)

    // 重连（数据拍恢复由 useBackgroundTasks 重连腿负责）→ 提示条消失
    wsMock.ref!.value = 'connected'
    trayState.bashFetchFailed = false
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-bash-disconnect-banner"]').exists()).toBe(false)

    // 损坏条（sticky 位）独立于连接态显示
    trayState.bashCorrupted = true
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-bash-corrupt-banner"]').text()).toContain(zhTray.tray.corruptBanner)
    wrapper.unmount()
  })
})
