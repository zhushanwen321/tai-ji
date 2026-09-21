/**
 * TrayNativePanel 组件测试（u-tray-native，设计 docs/design/composer-task-tray.md——已删除，git 可追溯——
 * §3.3 D2/D8/D9 + §3.5 错误规格）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：每条用例至少一个用户可见断言——行渲染（命令/耗时/pid/exit、
 *   agent/slug/task、scriptName/进度）、tab 切换、空态按钮、两段式首击确认态
 * - 观察者（形态）：pin 门控（hover 态无行内按钮）、错误态 retry、断连提示条、加载态
 * - 构建者（白盒）：行点击归宿矩阵（drawer 三 tab）与 RPC 参数（计数口径在
 *   useTrayCounts.test.ts 覆盖）；数据面单例（U1：真实 useTrayCounts + spy 断言面板开合
 *   不重发首拉 RPC）
 *
 * mock 策略：
 * - 数据面经 `TRAY_COUNTS_KEY` **provide 替身**（非模块 mock）：面板已改 inject 消费外壳单例
 *   （U1），替身是 `UseTrayCountsReturn` 类型标注的固定数据面——契约漂移即编译报错；口径测试
 *   在同目录 useTrayCounts.test.ts，本文件只验渲染与交互
 * - U1 用例用**真实** useTrayCounts（外壳替身持有）+ spy 拉取腿（`loadSubagents` /
 *   `loadWorkflows`）：断言面板开合不重复触发首拉（旧实现每次 hover 打开都重发，是 U1 根因）
 * - 真实 pinia + 真实 subagent/workflow store：cancel 防误报读 store 真判据
 *   （isStreamingSubagent），workflow 操作回执路径真实
 * - `@taiji/core/transport/api/domains/*` mock：kill / workflowAction RPC 可控
 * - `useBackgroundTasks` mock：bash 分区直接注入（真实状态根另有专项测试；U1 用例的真实
 *   useTrayCounts 会调它，避免测试打真实 list RPC）
 * - vue-i18n 走全局 setup（从 zh-CN locale 取值）：断言真实中文文案 + 插值形态
 * - 时间：vi.useFakeTimers({ now: FIXED_NOW })——bash running 行耗时确定性
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/tray-native-panel.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, h, provide, reactive, ref } from 'vue'
import type { PropType } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore, WORKFLOW_STALL_THRESHOLD_MS } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { clearToasts } from '../../helpers/toast-queue'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { bindDrawerSessionId, getDrawerControlState, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import { subagentVirtualId } from '@taiji/shared'
import TrayNativePanel from '@/components/panel/tray/TrayNativePanel.vue'
import { TRAY_COUNTS_KEY, useTrayCounts } from '@/components/panel/tray/useTrayCounts'
import type { TrayTaskKind as TrayKind, UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import { makeTrayCountsStub } from './tray-counts-stub'
import zhTray from '@/i18n/locales/zh-CN/tray'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { SubagentRecord, WorkflowRunRecord } from '@taiji/shared'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'
import * as sessionApi from '@taiji/core/transport/api/domains/session'

// ── 数据面替身（inject 消费点：panel 已不自建实例；U1 用例另用真实 useTrayCounts）──
interface TrayState {
  bashRunning: BackgroundTaskEntry[]
  bashEnded: BackgroundTaskEntry[]
  subagentRunning: SubagentRecord[]
  subagentEnded: SubagentRecord[]
  workflowRunning: WorkflowRunRecord[]
  workflowEnded: WorkflowRunRecord[]
  subagentError: string | null
  workflowError: string | null
  subagentLoading: boolean
  workflowLoading: boolean
  bashLoaded: boolean
  bashFetchFailed: boolean
  bashCorrupted: boolean
  /** [RT-4#8] oversize 降级标志（subagent / workflow 面板降级态判据） */
  subagentOversize: boolean
  workflowOversize: boolean
}

function createTrayState(): TrayState {
  return {
    bashRunning: [],
    bashEnded: [],
    subagentRunning: [],
    subagentEnded: [],
    workflowRunning: [],
    workflowEnded: [],
    subagentError: null,
    workflowError: null,
    subagentLoading: false,
    workflowLoading: false,
    bashLoaded: true,
    bashFetchFailed: false,
    bashCorrupted: false,
    subagentOversize: false,
    workflowOversize: false,
  }
}

/** reactive 容器（字段变更驱动下游 computed；对象本身恒不替换，防 computed 依赖失联） */
const trayState = reactive<TrayState>(createTrayState())
const retryMock = vi.hoisted(() => vi.fn<(kind: TrayKind) => Promise<void>>().mockResolvedValue(undefined))

/**
 * 固定数据面替身（`UseTrayCountsReturn` 类型标注 = 契约漂移门：成员增删改名即编译报错）。
 * 经 TRAY_COUNTS_KEY provide 给被测面板——面板不再 import useTrayCounts（U1），替身即其唯一数据源。
 * 模块级构造：所有计算属性都从 trayState 惰性派生，用例之间无需重建。
 */
const trayFixture: UseTrayCountsReturn = {
  ...makeTrayCountsStub(trayState),
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
  oversize: {
    subagent: computed(() => trayState.subagentOversize),
    workflow: computed(() => trayState.workflowOversize),
  },
  retry: retryMock,
}

// ── mock：bash 分区状态根（bash 数据面；U1 用例的真实 useTrayCounts 会调用它）──
vi.mock('@/composables/features/sidebar/useBackgroundTasks', () => ({
  useBackgroundTasks: () => ({
    current: computed(() => ({
      tasks: [] as BackgroundTaskEntry[],
      loaded: true,
      corrupted: false,
      fetchFailed: false,
    })),
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}))

// ── mock：bash kill RPC ──
vi.mock('@taiji/core/transport/api/domains/background-task', () => ({
  kill: vi.fn(),
}))

// ── mock：workflow abort RPC（session 域其余导出保持真实）──
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
    global: { provide: { [TRAY_COUNTS_KEY as symbol]: trayFixture } },
  })
}

/**
 * 模块级挂载点：用例只赋值（不各自收尾卸载），卸载统一由 afterEach 收口。
 * 失败安全：断言抛错不再跳过卸载（泄漏的组件/interval 会污染后续用例——本文件有用例断言
 * vi.getTimerCount()），卸载收口不依赖用例走完。范式对齐同目录 tray-widget / composer-tray。
 * getTimerCount 与 unmount 成对的用例仍保留显式 unmount（卸载即断言的一部分，幂等安全）。
 */
let wrapper: VueWrapper

/**
 * 外壳替身（U1 用例）：唯一真实 useTrayCounts 实例创建于此并 provide，面板按 open 挂载/卸载
 * ——复刻真实生命周期「外壳常驻 + 面板随 Popover 开合反复挂载」。
 */
const ShellHarness = defineComponent({
  props: {
    sessionId: { type: String, required: true },
    open: { type: Boolean, default: false },
    kind: { type: String as PropType<TrayKind>, default: 'subagent' },
  },
  setup(props) {
    provide(TRAY_COUNTS_KEY, useTrayCounts(computed(() => props.sessionId)))
    return () =>
      props.open
        ? h(TrayNativePanel, { kind: props.kind, sessionId: props.sessionId, pinned: false })
        : null
  },
})

type PanelWrapper = ReturnType<typeof mountPanel>
function rowTexts(wrapper: PanelWrapper, testid: string): string[] {
  return wrapper.findAll(`[data-testid="${testid}"]`).map((row) => row.text())
}

/** 清空 toast 模块级队列（fake timers 下自动移除不触发，需显式清） */

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
  // 先卸载（fake timers 仍在位，组件 interval 回收走 fake clock），再切回真实计时器
  wrapper?.unmount()
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
    wrapper = mountPanel('bash')
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
  })

  it('bash：切「已结束」→ 终态行显示 exit 码（null 显 —）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    // 行序由数据面给定（排序是 background-task-bucket SSOT 的职责，口径在其单测覆盖；
    // 本文件只验渲染：killed（exitCode null）在前，正常终态在后）
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e2', state: 'exited', exitCode: null, reason: 'killed', endedAt: T(1_000), durationMs: 59_000 }),
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000), durationMs: 50_000 }),
    ]
    wrapper = mountPanel('bash')
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
  })

  it('subagent：两 tab（进行中/已结束，无第三桶）+ 行渲染 agent/slug/摘要/turns/tokens/耗时', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running', engine: 'pi' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sub-2', status: 'idle', stopReason: 'failed' })]
    wrapper = mountPanel('subagent')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').text()).toContain(zhTray.tray.bucket.running)
    expect(wrapper.find('[data-testid="tray-panel-tab-ended"]').text()).toContain(zhTray.tray.bucket.ended)
    expect(wrapper.find('[data-testid="tray-panel-tab-count-running"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="tray-panel-tab-count-ended"]').text()).toBe('1')
    // [两视图裁决 2026-09-16] 「已收起」桶退役：archived tab 不存在
    expect(wrapper.find('[data-testid="tray-panel-tab-archived"]').exists()).toBe(false)

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
  })

  it('workflow：行渲染 scriptName/slug/进度 N-M/耗时（done 行无 spinner，状态点替代）', async () => {
    trayState.workflowRunning = [
      makeWorkflow({ runId: 'wf-1', status: 'running' }),
      makeWorkflow({ runId: 'wf-2', status: 'done', reason: 'completed' }),
    ]
    wrapper = mountPanel('workflow')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-tab-running"]').text()).toContain(zhTray.tray.bucket.running)
    const rows = wrapper.findAll('[data-testid="tray-workflow-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('release-flow')
    expect(rows[0].find('[data-testid="tray-workflow-slug"]').text()).toBe('rel')
    expect(rows[0].text()).toContain(msg(zhTray.tray.agentsLabel, { done: 1, total: 2 }))
    expect(rows[0].text()).toContain('1m0s')
    // running 行有 spinner，done 行无（状态点替代）
    expect(rows[0].find('[data-testid="tray-workflow-spinner"]').exists()).toBe(true)
    expect(rows[1].find('[data-testid="tray-workflow-spinner"]').exists()).toBe(false)
  })

  it('workflow [P3/D6]：health 停滞超阈值 → tray-workflow-stalled 指示（无进展 + 时长）；旧快照 health 缺省不判定', async () => {
    const stale = T(WORKFLOW_STALL_THRESHOLD_MS + 120_000)
    trayState.workflowRunning = [
      makeWorkflow({ runId: 'wf-1', status: 'running', health: { lastProgressAt: stale } }),
    ]
    wrapper = mountPanel('workflow')
    await flushPromises()

    // tick gate 含 workflow running 行 → now.value = FIXED_NOW，停滞判定确定性成立
    const stalled = wrapper.find('[data-testid="tray-workflow-stalled"]')
    expect(stalled.exists()).toBe(true)
    expect(stalled.text()).toContain(zhTray.tray.stalledNoProgress.split('{duration}')[0]!.trim())
    expect(stalled.text()).toContain('17m') // 15min 阈值 + 2min = 停滞 17m

    // 旧快照 additive 读：health 缺省 → 不判定停滞（无指示、不炸）
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-2', status: 'running' })]
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-workflow-stalled"]').exists()).toBe(false)
  })
})

describe('TrayNativePanel 空态可行动（D9）', () => {
  it('默认「进行中」桶为空 + 已结束有内容：一行提示 + 「查看已结束 (N)」，不自动跳转', async () => {
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000) }),
      makeTask({ taskId: 'bt-e2', state: 'exited', exitCode: 1, reason: 'natural', endedAt: T(2_000) }),
    ]
    wrapper = mountPanel('bash')
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
  })

  it('已结束桶为空（有进行中）：仅提示，无切桶按钮', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running' })]
    wrapper = mountPanel('subagent')
    await flushPromises()

    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.ended, { name: zhTray.tray.title.subagent }),
    )
    expect(wrapper.find('[data-testid="tray-panel-empty-jump-ended"]').exists()).toBe(false)
    expect(rowTexts(wrapper, 'tray-subagent-row')).toHaveLength(0)
  })

  it('subagent：已结束记录落已结束桶渲染（[两视图裁决 2026-09-16]，无寻回入口）', async () => {
    // 已结束记录由数据面归入已结束行集（口径断言在 useTrayCounts.test.ts）；面板层断言
    // 空「进行中」tab 下经「查看已结束」跳转后该记录走「已结束」tab 可见，且无
    // 「查看已收起」寻回按钮（「已收起」机制已全链路删除，第三桶不存在）
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sub-a1', status: 'idle' })]
    wrapper = mountPanel('subagent')
    await flushPromises()

    // 空态（进行中为空）只有「查看已结束」可行动按钮
    const jump = wrapper.find('[data-testid="tray-panel-empty-jump-ended"]')
    expect(jump.text()).toBe(msg(zhTray.tray.viewEnded, { count: 1 }))
    expect(wrapper.find('[data-testid="tray-panel-empty-jump-archived"]').exists()).toBe(false)

    await jump.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-tab-ended"]').attributes('data-active')).toBe('true')
    expect(rowTexts(wrapper, 'tray-subagent-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('Review the code changes')
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
    expect(workflowPinned.find('[data-testid="tray-workflow-pause"]').exists()).toBe(false)
    expect(workflowPinned.find('[data-testid="tray-workflow-abort"]').exists()).toBe(true)
    workflowPinned.unmount()
  })

  it('bash kill 两段式：首击进确认态（不发 RPC）、mouseleave 复位、再击才发 kill', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    wrapper = mountPanel('bash', { pinned: true })
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
  })

  it('subagent cancel 两段式正常路径：running 行两击 → store.cancelSubagent(sid, id)', async () => {
    const subagentStore = useSubagentStore()
    const running = makeSubagent({ subagentId: 'sub-1', status: 'running' })
    subagentStore.applyRecords(SID, [running])
    trayState.subagentRunning = [running]
    const cancelSpy = vi.spyOn(subagentStore, 'cancelSubagent').mockResolvedValue(undefined)
    wrapper = mountPanel('subagent', { pinned: true })
    await flushPromises()

    await wrapper.find('[data-testid="tray-subagent-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-subagent-cancel-confirm"]').exists()).toBe(true)
    expect(cancelSpy).not.toHaveBeenCalled()

    await wrapper.find('[data-testid="tray-subagent-cancel-confirm"]').trigger('click')
    await flushPromises()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledWith(SID, 'sub-1')
  })

  it('subagent cancel 迟到收口防误报：确认窗口期收口后第二击不发 RPC，toast「任务已结束」', async () => {
    const subagentStore = useSubagentStore()
    const running = makeSubagent({ subagentId: 'sub-1', status: 'running' })
    subagentStore.applyRecords(SID, [running])
    trayState.subagentRunning = [running]
    const cancelSpy = vi.spyOn(subagentStore, 'cancelSubagent').mockResolvedValue(undefined)
    wrapper = mountPanel('subagent', { pinned: true })
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
  })

  it('workflow：abort 两段式（首击确认不发，再击发 abort）；无 pause/resume 钮（D-2 一次性生命周期）', async () => {
    const workflowStore = useWorkflowStore()
    const loadSpy = vi.spyOn(workflowStore, 'loadWorkflows').mockResolvedValue(undefined)
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]
    wrapper = mountPanel('workflow', { pinned: true })
    await flushPromises()

    // D-2：一次性生命周期，宿主不暴露 pause/resume
    expect(wrapper.find('[data-testid="tray-workflow-pause"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-workflow-resume"]').exists()).toBe(false)

    await wrapper.find('[data-testid="tray-workflow-abort"]').trigger('click')
    await flushPromises()
    expect(sessionApi.workflowAction).toHaveBeenCalledTimes(0)
    expect(wrapper.find('[data-testid="tray-workflow-abort-confirm"]').attributes('data-confirming')).toBe('true')

    await wrapper.find('[data-testid="tray-workflow-abort-confirm"]').trigger('click')
    await flushPromises()
    expect(sessionApi.workflowAction).toHaveBeenCalledTimes(1)
    expect(sessionApi.workflowAction).toHaveBeenLastCalledWith(SID, 'abort', 'wf-1')
    expect(loadSpy).toHaveBeenCalledWith(SID)
  })
})

describe('TrayNativePanel 行点击归宿矩阵（D2）', () => {
  it('bash 行 → drawer bashTask tab（写 selectedBackgroundTaskId）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    wrapper = mountPanel('bash')
    await flushPromises()

    await wrapper.find('[data-testid="tray-bash-row"]').trigger('click')
    await flushPromises()
    const control = getDrawerControlState()
    expect(control.selectedBackgroundTaskId).toBe('bt-1')
    expect(control.activeTab).toBe('bashTask')
    expect(control.isOpen).toBe(true)
  })

  it('subagent 行 → drawer subagent tab（virtualId = subagentVirtualId(mainSid, subId)）', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running' })]
    wrapper = mountPanel('subagent')
    await flushPromises()

    await wrapper.find('[data-testid="tray-subagent-row"]').trigger('click')
    await flushPromises()
    const control = getDrawerControlState()
    expect(control.selectedSubagentId).toBe(subagentVirtualId(SID, 'sub-1'))
    expect(control.activeTab).toBe('subagent')
    expect(control.enteredFrom).toBe('chat')
    expect(control.isOpen).toBe(true)
  })

  it('workflow 行 → drawer workflow tab（以 runId 作选中值）', async () => {
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]
    wrapper = mountPanel('workflow')
    await flushPromises()

    await wrapper.find('[data-testid="tray-workflow-row"]').trigger('click')
    await flushPromises()
    const control = getDrawerControlState()
    expect(control.selectedWorkflowName).toBe('wf-1')
    expect(control.activeTab).toBe('workflow')
    expect(control.isOpen).toBe(true)
  })
})

describe('TrayNativePanel 观察者形态（错误态 / 断连 / 加载态）', () => {
  it('错误态：展示可读文案 + retry 按钮按类重拉', async () => {
    trayState.subagentError = 'rpc-down'
    wrapper = mountPanel('subagent')
    await flushPromises()

    const error = wrapper.find('[data-testid="tray-panel-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain(msg(zhTray.tray.loadFailed, { error: 'rpc-down' }))
    // 错误态下不渲染分桶 tab（避免在无数据时展示空计数）
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)

    await wrapper.find('[data-testid="tray-panel-retry"]').trigger('click')
    await flushPromises()
    expect(retryMock).toHaveBeenCalledWith('subagent')
  })

  it('[RT-4#8] oversize 降级态：显示「会话过大，列表暂不可用」+ 指引（与空列表分形，无 retry）', async () => {
    trayState.subagentOversize = true
    wrapper = mountPanel('subagent')
    await flushPromises()

    const oversize = wrapper.find('[data-testid="tray-panel-oversize"]')
    expect(oversize.exists()).toBe(true)
    expect(oversize.text()).toContain(zhTray.tray.oversizeTitle)
    expect(oversize.text()).toContain(zhTray.tray.oversizeHint)
    // 降级态非错误：无 retry 按钮（重试结果恒同）；不渲染列表 tab
    expect(wrapper.find('[data-testid="tray-panel-retry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
  })

  it('[RT-4#8] oversize 降级态：workflow 面板同款；error 优先级高于 oversize', async () => {
    trayState.workflowOversize = true
    trayState.workflowError = 'rpc-down'
    wrapper = mountPanel('workflow')
    await flushPromises()
    // 传输失败（可重试）优先于 oversize（数据降级）——error 分支在前
    expect(wrapper.find('[data-testid="tray-panel-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tray-panel-oversize"]').exists()).toBe(false)

    trayState.workflowError = null
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-panel-oversize"]').exists()).toBe(true)
  })

  it('加载态：在途且无数据显示加载文案（bash = 从未拉到过一次）', async () => {
    trayState.bashLoaded = false
    wrapper = mountPanel('bash')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').text()).toContain(zhTray.tray.loading)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
  })

  it('bash 断连提示条：断连 + 拉取失败时出现，重连后消失；损坏条独立显示', async () => {
    trayState.bashFetchFailed = true
    wsMock.ref!.value = 'disconnected'
    wrapper = mountPanel('bash')
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
  })
})

/**
 * U2 判据矩阵：`isKindLoading = 在途 && 该类 total === 0`（TrayNativePanel.vue 的 isKindLoading）。
 * 两个合取项都要有用例约束——「在途」项（loading.X / bash 的 !loaded）被删掉即退化为
 * `total === 0`，下列否定用例转红（本组用例即该项的变异红区）。
 */
describe('TrayNativePanel 加载态判据（U2：在途且该类无数据才占位）', () => {
  it('bash：从未拉到过一次（在途）且无任务 → 加载占位 + 不渲染分桶 tab', async () => {
    trayState.bashLoaded = false
    wrapper = mountPanel('bash')
    await flushPromises()

    const loading = wrapper.find('[data-testid="tray-panel-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.text()).toContain(zhTray.tray.loading)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty"]').exists()).toBe(false)
  })

  it('subagent：首拉在途（loading=true）且无任何记录 → 加载占位 + 不渲染分桶 tab', async () => {
    trayState.subagentLoading = true
    wrapper = mountPanel('subagent')
    await flushPromises()

    const loading = wrapper.find('[data-testid="tray-panel-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.text()).toContain(zhTray.tray.loading)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty"]').exists()).toBe(false)
  })

  it('workflow：首拉在途（loading=true）且无任何记录 → 加载占位 + 不渲染分桶 tab', async () => {
    trayState.workflowLoading = true
    wrapper = mountPanel('workflow')
    await flushPromises()

    const loading = wrapper.find('[data-testid="tray-panel-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.text()).toContain(zhTray.tray.loading)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty"]').exists()).toBe(false)
  })

  it('bash：已拉到过一次（非在途）且无任务 → 空态，不占位', async () => {
    wrapper = mountPanel('bash')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.runningProcess, { name: zhTray.tray.title.bash }),
    )
  })

  it('subagent：非在途且无记录 → 空态（可行动空态），不占位', async () => {
    wrapper = mountPanel('subagent')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.running, { name: zhTray.tray.title.subagent }),
    )
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(true)
  })

  it('workflow：非在途且无记录 → 空态，不占位', async () => {
    wrapper = mountPanel('workflow')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty-hint"]').text()).toBe(
      msg(zhTray.tray.empty.running, { name: zhTray.tray.title.workflow }),
    )
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(true)
  })
})

describe('TrayNativePanel 数据面单例（U1：开合不重发首拉 RPC）', () => {
  it('面板关闭再打开（卸载重挂）不触发重复首拉：loadSubagents / loadWorkflows 各仅外壳挂载一次', async () => {
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    // 拉取腿用 spy 计数（真实实现被替身：无 RPC，数据由用例直接种入分区）
    const loadSubSpy = vi.spyOn(subagentStore, 'loadSubagents').mockResolvedValue(undefined)
    const loadWfSpy = vi.spyOn(workflowStore, 'loadWorkflows').mockResolvedValue(undefined)
    subagentStore.applyRecords(SID, [makeSubagent({ subagentId: 'sub-1', status: 'running' })])
    workflowStore.applyRecords(SID, [makeWorkflow({ runId: 'wf-1', status: 'running' })])

    wrapper = mount(ShellHarness, { props: { sessionId: SID, open: false } })
    await flushPromises()

    // 外壳挂载（= 数据面唯一实例创建点）即首拉，各一次
    expect(loadSubSpy).toHaveBeenCalledTimes(1)
    expect(loadSubSpy).toHaveBeenCalledWith(SID)
    expect(loadWfSpy).toHaveBeenCalledTimes(1)
    expect(loadWfSpy).toHaveBeenCalledWith(SID)

    // 打开面板 = 首次挂载：行来自外壳同一实例（同一分区），无新增拉取
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-native-panel"]').attributes('data-kind')).toBe('subagent')
    expect(wrapper.findAll('[data-testid="tray-subagent-row"]')).toHaveLength(1)
    expect(loadSubSpy).toHaveBeenCalledTimes(1)
    expect(loadWfSpy).toHaveBeenCalledTimes(1)

    // 关闭（面板卸载）→ 再打开（重新挂载）：仍不重发（旧实现此处会再拉一轮）
    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-native-panel"]').exists()).toBe(false)
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.findAll('[data-testid="tray-subagent-row"]')).toHaveLength(1)
    expect(loadSubSpy).toHaveBeenCalledTimes(1)
    expect(loadWfSpy).toHaveBeenCalledTimes(1)

  })

  it('缺 TRAY_COUNTS_KEY 时响亮失败（不得静默自建第二数据实例）', () => {
    // 面板只能在 ComposerTray 内渲染：无 provide 即抛错（错误信息含恢复动作）；若后人改回
    // 「自建实例」回退，本用例转红（U1 的双实例路径不得复活）
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => mount(TrayNativePanel, { props: { kind: 'subagent', sessionId: SID } }))
        .toThrowError(/TRAY_COUNTS_KEY/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('TrayNativePanel 首帧即列表（U2：有数据不闪加载态）', () => {
  it('subagent：在途（loading）但该 sid 已有数据 → 直出列表，不渲染加载占位', async () => {
    trayState.subagentLoading = true
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running' })]
    wrapper = mountPanel('subagent')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="tray-subagent-row"]')).toHaveLength(1)
  })

  it('bash：从未拉到过一次但分区已有任务 → 直出列表（提示条语义不受影响）', async () => {
    trayState.bashLoaded = false
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    wrapper = mountPanel('bash')
    await flushPromises()

    expect(wrapper.find('[data-testid="tray-panel-loading"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="tray-bash-row"]')).toHaveLength(1)
  })
})

/**
 * tick 空转治理：1s interval 仅随「可见 live bash 行」建撤（elapsedLabel 的 now 分支是 tick
 * 唯一消费者——subagent/workflow 行耗时走数据字段，bash 终态行走 durationMs，均不需 tick）。
 * 断言手段 = vi.getTimerCount()（fake timers 挂起 timer 数；beforeEach 重设 fake clock 后基线为 0）。
 */
describe('TrayNativePanel tick 空转治理（interval 仅随可见 running bash 行建撤）', () => {
  it('bash 无 running 行（空态 / 仅已结束）零 interval；running 行出现即建、收口即撤、卸载无泄漏', async () => {
    // 仅已结束行：可见行耗时静态（durationMs），无 tick 消费者
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000), durationMs: 50_000 }),
    ]
    wrapper = mountPanel('bash')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()

    // 空面板（可行动空态）同样零 interval
    Object.assign(trayState, createTrayState())
    wrapper = mountPanel('bash')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)

    // running 行出现（数据面推送）：interval 建立，耗时开始实时走
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:37')
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:38')

    // 行收口（移出 running 行集）：interval 撤销
    trayState.bashRunning = []
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('subagent 面板有 running 行零 interval；workflow 面板 running 行建 tick（[P3/D6] 停滞信号为 now 消费者）、无 running 行撤 tick', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running' })]
    wrapper = mountPanel('subagent')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="tray-subagent-row"]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()

    // [P3/D6] workflow running 行是停滞信号推导的 now 消费者 → tick 建立（原「恒零
    // interval」契约随消费面变更：workflowElapsed 不需要 now，停滞指示需要）
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]
    wrapper = mountPanel('workflow')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="tray-workflow-row"]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    // running 行收口 → tick 撤销（gate 语义与 bash 面板同构）
    trayState.workflowRunning = []
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('bash 切「已结束」桶停 tick，切回「运行中」桶即恢复且首帧耗时准确（now 先同步再渲染）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.bashEnded = [
      makeTask({ taskId: 'bt-e1', state: 'exited', exitCode: 0, reason: 'natural', endedAt: T(3_000), durationMs: 50_000 }),
    ]
    wrapper = mountPanel('bash')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:37')

    // tick 走 5s（00:42）后切到已结束桶：无 live 行 → interval 撤销，now 冻结
    await vi.advanceTimersByTimeAsync(5000)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:42')
    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)

    // 停留期间再走 10s（无 interval，now 不动）；切回运行桶：interval 恢复 + 首帧即 00:52
    // （watch pre 先于渲染刷新 now；若依赖后续 tick 则首帧仍是 stale 00:42，用例转红）
    await vi.advanceTimersByTimeAsync(10_000)
    await wrapper.find('[data-testid="tray-panel-tab-running"]').trigger('click')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:52')
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('多实例并存（split mode）各自独立 gate：每实例恰一个 interval，卸载即回收', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    const first = mountPanel('bash')
    const second = mountPanel('bash')
    await flushPromises()
    expect(vi.getTimerCount()).toBe(2)

    first.unmount()
    expect(vi.getTimerCount()).toBe(1)
    second.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('TrayNativePanel bash kill 失败用户反馈（错误 toast，不再只 console.debug）', () => {
  it('kill RPC reject → 第二击后 error toast 可见（终止后台命令失败 + 原因）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-kill-fail' })]
    vi.mocked(backgroundTaskApi.kill).mockRejectedValueOnce(new Error('rpc down'))
    // 行内按钮仅 pin 态渲染（hover 态无行内按钮，与既有两段式用例同前提）
    wrapper = mountPanel('bash', { pinned: true })
    await flushPromises()

    // 两段式：首击进确认态（不发 RPC），确认按钮第二击发令
    await wrapper.find('[data-testid="tray-bash-kill"]').trigger('click')
    expect(backgroundTaskApi.kill).not.toHaveBeenCalled()
    await wrapper.find('[data-testid="tray-bash-kill-confirm"]').trigger('click')
    await flushPromises()
    expect(backgroundTaskApi.kill).toHaveBeenCalledWith(SID, 'bt-kill-fail')

    const { toasts } = useToast()
    const errorToast = toasts.value.find((toast) => toast.type === 'error')
    expect(errorToast).toBeDefined()
    expect(errorToast?.message).toBe(msg(zhTray.tray.killFailed, { msg: 'rpc down' }))
  })
})
