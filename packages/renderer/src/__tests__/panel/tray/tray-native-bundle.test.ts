/**
 * tray 域 native 侧合并产物（round 6 renderer 测试压缩）：两文件同产物
 * （useTrayCounts 真实 composable 测试与 composer-tray 的 partial mock 互斥，故
 * 与 tray-native-panel 同产物——后者消费真实 useTrayCounts/TRAY_COUNTS_KEY）。
 *
 * 并入来源（基名）：
 *  - tray-native-panel（分桶 tab/行渲染 + 合并派生视图 + 空态，39 例）
 *  - useTrayCounts（计数口径/谓词边界/首次拉取触发，22 例）
 *
 * mock 注册与互斥核查（两源归一）：
 *  - '@/composables/features/sidebar/useBackgroundTasks'：native 的空 tasks 形态与
 *    counts 的 partitionState/refreshMock 形态 → 统一 partitionState 形态；native 节
 *    beforeEach 增补 partitionState 空载重播（原空 tasks 形态语义等价）。
 *  - '@/api'：counts 的 apiMocks 三成员与 native 的 subagentAction/workflowAction →
 *    统一并集工厂（native 节注释明确「面板不触发」首拉 RPC，apiMocks 缺省对其无影响）。
 *  - native 独占：session domain partial（workflowAction）/ background-task domain /
 *    ws-client（wsMock）；counts 独占：transport/api partial（commandMock）。
 *  - 两节头段逐字保留（native 头仅剔除两处重复工厂与重复模块 import，补 provide/ref）。
 *  - native 节 fake timers（beforeEach/afterEach 配对）随正文包进 describe，作用域不外溢。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=tray TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/panel/tray/tray-native-bundle.test.ts（本文件登记在 domain-map.json tray 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { dispatchGlobal, dispatchCrossSession } from '@taiji/core/transport/api'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useSessionStore } from '@/stores/session'
import { useTrayCounts } from '@/components/panel/tray/useTrayCounts'
import {
  __resetBtwLineMembershipForTest,
  isKnownBtwLine,
  noteBtwLinesPulled,
} from '@/composables/panel/btw-line-membership'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { CanvasListEntry } from '@zhushanwen/extension-protocol'

// ── mock：bash 分区状态根（直接 mutate 模拟 list reply / 广播）──
let partitionState: { tasks: BackgroundTaskEntry[]; loaded: boolean; corrupted: boolean; fetchFailed: boolean }
const refreshMock = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined))
vi.mock('@/composables/features/sidebar/useBackgroundTasks', () => ({
  useBackgroundTasks: () => ({
    current: computed(() => partitionState),
    refresh: refreshMock,
  }),
}))

// ── mock：canvas.list RPC（第 5 件 canvas 的数据链真实经过 useCanvasSync 订阅 → canvas store；
//    替身 reply 可控，广播路径用 core dispatchGlobal 真实现喂——链路行为级验证）──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock }
})

// ── mock：首次拉取 RPC（subagent/workflow 列表）──
const apiMocks = vi.hoisted(() => ({
  // RT-4#8 起 API 返结构化形状 { subagents, oversize }（store 按此解构）
  getSubagents: vi.fn<(sessionId: string) => Promise<{ subagents: SubagentRecord[]; oversize?: boolean }>>(),
  getWorkflows: vi.fn<(sessionId: string) => Promise<{ workflows: WorkflowRunRecord[]; oversize?: boolean }>>(),
  // W4b 收编：btw 线成员判别拉取入口（session.list {surface:'btw'}）
  listSessions: vi.fn<(query: { surface?: string; mainSessionId?: string }) => Promise<SessionGroup[]>>(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    session: {
      ...actual.session,
      getSubagents: apiMocks.getSubagents,
      getWorkflows: apiMocks.getWorkflows,
      listSessions: apiMocks.listSessions,
      // native 节成员（面板不触发首拉，此处为编排动作面）
      subagentAction: vi.fn().mockResolvedValue(undefined),
      workflowAction: vi.fn().mockResolvedValue(undefined),
    },
  }
})

// ═══ tray-native-panel 节头段（imports + fixture + 附加 mock）═══
import { provide, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { TRAY_COUNTS_KEY } from '@/components/panel/tray/useTrayCounts'  // vue 其余成员由 useTrayCounts 节头覆盖
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useToast } from '@/composables/useToast'
import { clearToasts } from '../../helpers/toast-queue'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { bindDrawerSessionId, bindWorkflowOverlayOpener, getDrawerControlState, useBashTaskSelection, useSubagentSelection, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import { subagentVirtualId } from '@taiji/shared'
import TrayNativePanel from '@/components/panel/tray/TrayNativePanel.vue'
import { makeTrayCountsStub } from './tray-counts-stub'
import zhTray from '@/i18n/locales/zh-CN/tray'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'
import * as sessionApi from '@taiji/core/transport/api/domains/session'

// ── 数据范围替身（inject 消费点：panel 已不自建实例；U1 用例另用真实 useTrayCounts）──
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
 * 固定数据范围替身（`UseTrayCountsReturn` 类型标注 = 契约漂移门：成员增删改名即编译报错）。
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

// ── mock：bash 分区状态根（bash 数据范围；U1 用例的真实 useTrayCounts 会调用它）──
//（useBackgroundTasks 统一为 counts 节 partitionState 形态工厂，见上）

// ── mock：bash kill RPC ──
vi.mock('@taiji/core/transport/api/domains/background-task', () => ({
  kill: vi.fn(),
}))

// ── mock：workflow abort RPC（session 域其余导出保持真实）──
vi.mock('@taiji/core/transport/api/domains/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/session')>()
  return { ...actual, workflowAction: vi.fn() }
})

// ── mock：store 首次拉取 RPC（面板不触发，防真实 transport 抖动）──
//（@/api 统一为上方并集工厂）

// ── mock：ws 连接态（断连提示条驱动）──
const wsMock = vi.hoisted(() => ({ ref: null as null | { value: string } }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  const { ref: makeRef } = await import('vue')
  const stateRef = makeRef<string>('connected')
  wsMock.ref = stateRef
  return { ...actual, getState: () => stateRef }
})

// ═══════════ 来源节：tray-native-panel ═══════════

describe('tray-native-panel', () => {
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
    // id/status 对齐 WorkflowAgentCall 契约（id = trace.stepIndex 数字；status 词表
    // pending|running|done|failed——record 域 'completed' 由 mapStepStatusFromRecord
    // 映射为 'done'，词表显式转换禁止直拷）
    agentCalls: [
      { id: 0, agent: 'a', status: 'done', phase: 'p1' },
      { id: 1, agent: 'b', status: 'running', phase: 'p1' },
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
 * 模块级挂载点：用例只赋值（不各自收尾卸载），卸载统一由 afterEach 收尾。
 * 失败安全：断言抛错不再跳过卸载（泄漏的组件/interval 会污染后续用例——本文件有用例断言
 * vi.getTimerCount()），卸载收尾不依赖用例走完。范式对齐同目录 tray-widget / composer-tray。
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
  // 合并产物增补：useBackgroundTasks 统一 partitionState 形态的空载重播（原空 tasks 形态等价）
  partitionState = { tasks: [], loaded: true, corrupted: false, fetchFailed: false }
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
    // 行序由数据范围给定（排序是 background-task-bucket SSOT 的职责，口径在其单测覆盖；
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

  it('subagent：agent 绝对路径时行内显示 basename 去 .md，title 保留全路径', async () => {
    const fullPath = '/Users/x/.agents/skills/explorer/agent.md'
    trayState.subagentRunning = [
      makeSubagent({ subagentId: 'sub-1', status: 'running', engine: 'pi', agent: fullPath }),
    ]
    wrapper = mountPanel('subagent')
    await flushPromises()

    const row = wrapper.find('[data-testid="tray-subagent-row"]')
    // 行内短名（窄列 truncate 优先）
    expect(row.text()).toContain('agent')
    expect(row.text()).not.toContain(fullPath)
    // title hover 保留全路径
    expect(row.attributes('title')).toBe(`${fullPath} · review-changes`)
  })

  it('subagent：lastRound.failure 在场 → meta 行渲染 class.kind 失败标签（user.cancelled 中性档；缺省不占位）', async () => {
    trayState.subagentEnded = [
      makeSubagent({
        subagentId: 'sub-f1',
        status: 'idle',
        lastRound: {
          engineStopReason: 'error',
          failure: { class: 'provider', kind: 'rate_limited', retryable: 'conditional', raw: 'rpm 101/100' },
        },
      }),
    ]
    wrapper = mountPanel('subagent')
    await flushPromises()
    // 失败 record 落「已结束」桶（默认显示「进行中」）——先切桶再断言行渲染
    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()

    const failure = wrapper.find('[data-testid="tray-subagent-failure"]')
    expect(failure.exists()).toBe(true)
    expect(failure.text()).toBe('provider.rate_limited')
    expect(failure.classes()).toContain('text-danger')

    // user.cancelled：标签照渲染但落中性档（用户主动中止非失败）
    trayState.subagentEnded = [
      makeSubagent({
        subagentId: 'sub-f2',
        status: 'idle',
        lastRound: { engineStopReason: 'aborted', failure: { class: 'user', kind: 'cancelled', retryable: false, raw: 'user aborted' } },
      }),
    ]
    wrapper.unmount()
    wrapper = mountPanel('subagent')
    await flushPromises()
    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    const cancelled = wrapper.find('[data-testid="tray-subagent-failure"]')
    expect(cancelled.exists()).toBe(true)
    expect(cancelled.classes()).toContain('text-neutral-dim')
    expect(cancelled.classes()).not.toContain('text-danger')

    // lastRound 缺省（u3 runtime 产出前恒 undefined）→ 不占位
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sub-f3', status: 'idle' })]
    wrapper.unmount()
    wrapper = mountPanel('subagent')
    await flushPromises()
    await wrapper.find('[data-testid="tray-panel-tab-ended"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="tray-subagent-failure"]').exists()).toBe(false)
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
})

describe('TrayNativePanel [W0/V8] 合并派生视图消费锚定（盲区窗口 N/M 进度显式预期变化）', () => {
  it('盲区窗口 record-only agentCalls → N/M 进度 0/N + 0% 进度条（旧形态 0/0 → 0/N）', async () => {
    // D2-R3 record-only 成行契约形状：id/agent/slug/status/startedAt/sessionId、phase undefined。
    // 显式预期变化（设计 V8）：盲区窗口托盘进度从 0/0（agentCalls 空）变为 0/N（record-only
    // 行已可见），百分比同口径从 0%（0/0 兜底）变为 0%（0 终态 / N 总数）
    trayState.workflowRunning = [
      makeWorkflow({
        runId: 'wf-blind',
        agentCalls: [
          { id: 0, agent: 'reviewer-1', status: 'running', sessionId: 'acs-r1' },
          { id: 1, agent: 'reviewer-2', status: 'running', sessionId: 'acs-r2' },
          { id: 2, agent: 'reviewer-3', status: 'running', sessionId: 'acs-r3' },
          { id: 3, agent: 'reviewer-4', status: 'running', sessionId: 'acs-r4' },
        ],
      }),
    ]
    wrapper = mountPanel('workflow')
    await flushPromises()

    const row = wrapper.find('[data-testid="tray-workflow-row"]')
    expect(row.exists()).toBe(true)
    // N/M 计数：done=0 / total=4（合并派生视图使盲区窗口立即有值）
    expect(row.text()).toContain(msg(zhTray.tray.agentsLabel, { done: 0, total: 4 }))
    // 百分比：进度条宽度 0%（无终态步骤）
    const bar = row.find('[style*="width"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('style')).toContain('width: 0%')
  })

  it('转态后 N/M 随终态计数推进：1 终态 / 4 总数 → 25% 进度条', async () => {
    trayState.workflowRunning = [
      makeWorkflow({
        runId: 'wf-partial',
        agentCalls: [
          { id: 0, agent: 'reviewer-1', status: 'done', sessionId: 'acs-r1' },
          { id: 1, agent: 'reviewer-2', status: 'running', sessionId: 'acs-r2' },
          { id: 2, agent: 'reviewer-3', status: 'running', sessionId: 'acs-r3' },
          { id: 3, agent: 'reviewer-4', status: 'running', sessionId: 'acs-r4' },
        ],
      }),
    ]
    wrapper = mountPanel('workflow')
    await flushPromises()

    const row = wrapper.find('[data-testid="tray-workflow-row"]')
    expect(row.text()).toContain(msg(zhTray.tray.agentsLabel, { done: 1, total: 4 }))
    expect(row.find('[style*="width"]').attributes('style')).toContain('width: 25%')
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
    // 已结束记录由数据范围归入已结束行集（口径断言在 useTrayCounts.test.ts）；面板层断言
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

  it('subagent cancel 迟到收尾防误报：确认窗口期收尾后第二击不发 RPC，toast「任务已结束」', async () => {
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

    // 迟到收尾（轮终广播）：record 翻 idle，确认钮保留（可达性优先于态过滤）
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
    expect(useBashTaskSelection().selectedBackgroundTaskId.value).toBe('bt-1')
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
    const subagentSelection = useSubagentSelection()
    expect(subagentSelection.selectedSubagentId.value).toBe(subagentVirtualId(SID, 'sub-1'))
    expect(control.activeTab).toBe('subagent')
    expect(control.isOpen).toBe(true)
  })

  it('workflow 行 → openWorkflow(runId)（workflow-visualization U6/D1 改向后归宿 = overlay 打开通道；opener 绑定 spy 断言转发，反查逻辑归 controller 单测）', async () => {
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]
    const overlayOpener = vi.fn()
    bindWorkflowOverlayOpener(overlayOpener)
    wrapper = mountPanel('workflow')
    await flushPromises()

    await wrapper.find('[data-testid="tray-workflow-row"]').trigger('click')
    await flushPromises()
    // 托盘行零改动（仍传 runId）；改向后 openWorkflow 转发 overlay opener，不触达 drawer
    expect(overlayOpener).toHaveBeenCalledWith('wf-1', undefined, undefined)
  })
})

describe('TrayNativePanel 观察者形态（错误态 / 断连 / 加载态）', () => {
  it('错误态：展示可读文案 + retry 按钮按类重新拉取', async () => {
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

    // 重连（数据拍恢复由 useBackgroundTasks 重连路径负责）→ 提示条消失
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

  it('subagent：首次拉取在途（loading=true）且无任何记录 → 加载占位 + 不渲染分桶 tab', async () => {
    trayState.subagentLoading = true
    wrapper = mountPanel('subagent')
    await flushPromises()

    const loading = wrapper.find('[data-testid="tray-panel-loading"]')
    expect(loading.exists()).toBe(true)
    expect(loading.text()).toContain(zhTray.tray.loading)
    expect(wrapper.find('[data-testid="tray-panel-tabs"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-panel-empty"]').exists()).toBe(false)
  })

  it('workflow：首次拉取在途（loading=true）且无任何记录 → 加载占位 + 不渲染分桶 tab', async () => {
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

describe('TrayNativePanel 数据范围单例（U1：开合不重发首次拉取 RPC）', () => {
  it('面板关闭再打开（卸载重挂）不触发重复首次拉取：loadSubagents / loadWorkflows 各仅外壳挂载一次', async () => {
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    // 拉取路径用 spy 计数（真实实现被替身：无 RPC，数据由用例直接种入分区）
    const loadSubSpy = vi.spyOn(subagentStore, 'loadSubagents').mockResolvedValue(undefined)
    const loadWfSpy = vi.spyOn(workflowStore, 'loadWorkflows').mockResolvedValue(undefined)
    subagentStore.applyRecords(SID, [makeSubagent({ subagentId: 'sub-1', status: 'running' })])
    // workflow 种数据：applyRecords 已私有化，直写分区 ref
    workflowStore.recordsBySession = new Map(workflowStore.recordsBySession).set(SID, [
      makeWorkflow({ runId: 'wf-1', status: 'running' }),
    ])

    wrapper = mount(ShellHarness, { props: { sessionId: SID, open: false } })
    await flushPromises()

    // 外壳挂载（= 数据范围唯一实例创建点）即首次拉取，各一次
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
  it('bash 无 running 行（空态 / 仅已结束）零 interval；running 行出现即建、收尾即撤、卸载无泄漏', async () => {
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

    // running 行出现（数据范围推送）：interval 建立，耗时开始实时走
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    await flushPromises()
    expect(vi.getTimerCount()).toBe(1)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:37')
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.find('[data-testid="tray-bash-row"]').text()).toContain('00:38')

    // 行收尾（移出 running 行集）：interval 撤销
    trayState.bashRunning = []
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('subagent / workflow 面板有 running 行零 interval（行耗时走数据字段，无 now 消费者）', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sub-1', status: 'running' })]
    wrapper = mountPanel('subagent')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="tray-subagent-row"]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()

    // workflow 行耗时（workflowElapsed）直读 Date.now 不依赖 tick → 恒零 interval
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]
    wrapper = mountPanel('workflow')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="tray-workflow-row"]')).toHaveLength(1)
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
})


// ═══════════ 来源节：useTrayCounts ═══════════

describe('useTrayCounts', () => {
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
/** 宿主实例登记（afterEach 统一卸载）：canvas 订阅（use-canvas-sync）是模块级单例，
 * 不卸载会跨用例残留并钉死旧 pinia 的 store（新用例的 reply 注入对旧 store 无效）。 */
let harnessWrapper: ReturnType<typeof mount> | null = null
const Harness = defineComponent({
  props: { sessionId: { type: String, required: true } },
  setup(props) {
    tray = useTrayCounts(computed(() => props.sessionId))
    return () => h('div')
  },
})

function mountHarness(sessionId = SID) {
  harnessWrapper = mount(Harness, { props: { sessionId } })
  return harnessWrapper
}

/** 当前数据范围（防守：宿主 setup 必已赋值） */
function data(): UseTrayCountsReturn {
  if (!tray) throw new Error('useTrayCounts 未挂载')
  return tray
}

beforeEach(() => {
  // W4b 收编：btw 线成员判别缓存逐用例清零（拉取缓存 = session.list {surface:'btw'}）
  __resetBtwLineMembershipForTest()
  apiMocks.listSessions.mockResolvedValue([])
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMocks.getSubagents.mockResolvedValue({ subagents: [], oversize: false })
  apiMocks.getWorkflows.mockResolvedValue({ workflows: [], oversize: false })
  // canvas.list 替身：缺省空清单（canvas 用例按需覆写返回值）
  commandMock.mockReset()
  commandMock.mockResolvedValue({ canvases: [] })
  // reactive 容器：bash 分区的字段变更需驱动下游 computed 重算（mock 契约同真实分区）
  partitionState = reactive({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })
  tray = undefined
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  harnessWrapper?.unmount()
  harnessWrapper = null
  vi.useRealTimers()
})

describe('useTrayCounts 计数口径与谓词边界（D2）', () => {
  it('subagent：进行中 = isRunningProjection；running+stopReason 与 idle 均落已结束（[两视图裁决 2026-09-16]）', async () => {
    const subagentStore = useSubagentStore()
    subagentStore.applyRecords(SID, [
      makeSubagent({ subagentId: 'a-running', status: 'running' }),
      // 轮收条已写的轮终（running + stopReason='failed'）→ 不落进行中（占用判据 = running && 无停因）
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

  it('workflow：running 计入进行中，done 落已结束；[D2] interrupted 计 ended 桶（暂停态不算进行中——显式裁决单测锁住）', async () => {
    const workflowStore = useWorkflowStore()
    // 种数据（applyRecords 已私有化，直写分区 ref）
    workflowStore.recordsBySession = new Map(workflowStore.recordsBySession).set(SID, [
      makeWorkflow({ runId: 'wf-run', status: 'running' }),
      makeWorkflow({ runId: 'wf-done', status: 'done', reason: 'completed' }),
      makeWorkflow({ runId: 'wf-int', status: 'interrupted' }),
    ])
    mountHarness()

    expect(data().counts.value.workflow).toEqual({ running: 1, ended: 2, total: 3 })
    expect(data().lists.workflow.running.value.map((r) => r.runId)).toEqual(['wf-run'])
    expect(data().lists.workflow.ended.value.map((r) => r.runId)).toEqual(['wf-done', 'wf-int'])
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
    // 首次拉取 RPC 按 sid 返回不同列表：切 session 后计数跟随新分区（真实 load* 写分区路径）
    apiMocks.getSubagents.mockImplementation(async (sid: string) => ({
      subagents:
        sid === SID2
          ? [
              makeSubagent({ subagentId: 'b-1', status: 'idle' }),
              makeSubagent({ subagentId: 'b-2', status: 'idle' }),
            ]
          : [makeSubagent({ subagentId: 'a-1', status: 'running' })],
      oversize: false,
    }))
    const wrapper = mountHarness(SID)
    await vi.waitFor(() => expect(data().counts.value.subagent.running).toBe(1), { interval: 1 })

    await wrapper.setProps({ sessionId: SID2 })
    await vi.waitFor(() => expect(data().counts.value.subagent.total).toBe(2), { interval: 1 })
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
    spawnSource: 'agent',
    parentAgentSessionId: SID,
    ...overrides,
  }
}

describe('useTrayCounts session kind（第 4 件子会话，u7 / 设计 mode-system-composer-density §6.7 D7）', () => {
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

  it('行集按 lastActiveAt 倒序（最近在前；面板行序 = 数据范围行序）', () => {
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

describe('useTrayCounts D13 首次拉取触发与 retry', () => {
  it('挂载即拉：loadSubagents / loadWorkflows 各以当前 sessionId 调一次', async () => {
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    const loadSubSpy = vi.spyOn(subagentStore, 'loadSubagents')
    const loadWfSpy = vi.spyOn(workflowStore, 'loadWorkflows')

    mountHarness()
    await vi.waitFor(() => {
      expect(loadSubSpy).toHaveBeenCalledTimes(1)
      expect(loadWfSpy).toHaveBeenCalledTimes(1)
    }, { interval: 1 })
    expect(loadSubSpy).toHaveBeenCalledWith(SID)
    expect(loadWfSpy).toHaveBeenCalledWith(SID)
    // 拉取路径真正落到 RPC（store 内部未短路）
    expect(apiMocks.getSubagents).toHaveBeenCalledWith(SID)
    expect(apiMocks.getWorkflows).toHaveBeenCalledWith(SID)
  })

  it('sessionId 变化 → 按新 sid 重新拉取（历史桶依赖此路径）', async () => {
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    const loadSubSpy = vi.spyOn(subagentStore, 'loadSubagents')
    const loadWfSpy = vi.spyOn(workflowStore, 'loadWorkflows')

    const wrapper = mountHarness(SID)
    await vi.waitFor(() => expect(loadSubSpy).toHaveBeenCalledTimes(1), { interval: 1 })

    await wrapper.setProps({ sessionId: SID2 })
    await vi.waitFor(() => expect(loadSubSpy).toHaveBeenCalledTimes(2), { interval: 1 })
    expect(loadSubSpy).toHaveBeenLastCalledWith(SID2)
    expect(loadWfSpy).toHaveBeenLastCalledWith(SID2)
    expect(apiMocks.getSubagents).toHaveBeenLastCalledWith(SID2)
    expect(apiMocks.getWorkflows).toHaveBeenLastCalledWith(SID2)
  })

  it('retry(kind) 按类重新拉取：subagent / workflow → load*；bash → refresh', async () => {
    mountHarness()
    await vi.waitFor(() => expect(apiMocks.getWorkflows).toHaveBeenCalledTimes(1), { interval: 1 })
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
    await vi.waitFor(() => expect(apiMocks.getSubagents).not.toHaveBeenCalled(), { interval: 1 })
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

describe('P-invisible·任务托盘：D9③ 派生视图抑制（btw 线不映射 subagent/workflow）', () => {
  it('btw 线挂托盘：线 owner 分区有派生记录仍构造性归零；bash（线自身任务）照常', async () => {
    const lineId = 'line-tray-1'
    // W4b 收编判别器 = session.list {surface:'btw'} 拉取缓存成员判别（登记于
    // constraints.json C-data-28 抑制类清单；旧 isBtwSession 派生表随收编删除）——线
    // session id 经缓存预热（= 抽屉打开时拉取产物喂入，同步命中路径）。
    noteBtwLinesPulled([lineId])
    // 线 owner 分区真实灌入派生记录（生产 = loadSubagents(线 id) / 广播路径落分区）
    useSubagentStore().applyRecords(lineId, [makeSubagent({ subagentId: 'a-line', status: 'running' })])
    // 种数据（applyRecords 已私有化，直写分区 ref）
    const workflowStore = useWorkflowStore()
    workflowStore.recordsBySession = new Map(workflowStore.recordsBySession).set(
      lineId,
      [makeWorkflow({ runId: 'wf-line', status: 'running' })],
    )
    // bash = 线自身后台命令（非派生虚拟键，抑制面不覆盖）
    partitionState = reactive({
      tasks: [makeTask({ taskId: 't-line' })], loaded: true, corrupted: false, fetchFailed: false,
    })

    mountHarness(lineId)

    expect(data().counts.value.subagent).toEqual({ running: 0, ended: 0, total: 0 })
    expect(data().counts.value.workflow).toEqual({ running: 0, ended: 0, total: 0 })
    expect(data().lists.subagent.running.value).toHaveLength(0)
    expect(data().lists.workflow.running.value).toHaveLength(0)
    expect(data().counts.value.bash.total).toBe(1) // 边界：bash 不在派生抑制面
    // W4a 已接受代价：3 处纯性能防护分支（首次拉取/retry）删判别器——对线会话多发几次
    // 空 RPC（hasBackgroundWork/deriveStatus/loadError 对线派生值改变，线不进托盘汇总
    // 范围、不可见；§6 取舍表）。此处断言「拉了但行集仍归零」的新形态。
    expect(apiMocks.getSubagents).toHaveBeenCalledWith(lineId)
    expect(apiMocks.getWorkflows).toHaveBeenCalledWith(lineId)
  })

  it('在途竞态：补拉未回时切回已缓存线会话，旧 sid 的迟到回写不得解除抑制（时效守卫回归）', async () => {
    const lineId = 'line-tray-race'
    const lineSubagent = makeSubagent({ subagentId: 'a-race', status: 'running' })
    const lineWorkflow = makeWorkflow({ runId: 'wf-race', status: 'running' })
    // 首次拉取对 lineId 返回线的派生记录（与下方预种一致——D13 拉取 watch 切到 lineId
    // 时会用 RPC 结果覆盖分区，两边同内容保证覆盖幂等，判别力只剩 derivedSuppressed）
    apiMocks.getSubagents.mockImplementation(async (sid: string) => ({
      subagents: sid === lineId ? [lineSubagent] : [],
      oversize: false,
    }))
    apiMocks.getWorkflows.mockImplementation(async (sid: string) => ({
      workflows: sid === lineId ? [lineWorkflow] : [],
      oversize: false,
    }))
    // 挂载 sid = SID（未缓存主会话）→ watch 内 ensure 触发 session.list 全量拉取并挂起
    // （在途补拉）；此时把焦点切到已缓存线会话（同步命中路径），旧 sid 的 Promise 续写
    // 随后才到达——回写前无 sid 时效守卫会把 derivedSuppressed 覆写为 false，线的派生
    // 任务漏进托盘计数（knownLines 写入不触发 watch 重算，错误状态无自纠触发点）。
    let resolveListSessions!: (groups: SessionGroup[]) => void
    apiMocks.listSessions.mockImplementation(
      () =>
        new Promise<SessionGroup[]>((resolve) => {
          resolveListSessions = resolve
        }),
    )
    const wrapper = mountHarness(SID)
    await vi.waitFor(() => expect(apiMocks.listSessions).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(apiMocks.listSessions).toHaveBeenCalledWith({ surface: 'btw' })

    // 线 owner 分区预种派生记录（拉取未覆盖前也有数据，中间态断言才有判别力）
    useSubagentStore().applyRecords(lineId, [lineSubagent])
    // 种数据（applyRecords 已私有化，直写分区 ref）
    const workflowStore = useWorkflowStore()
    workflowStore.recordsBySession = new Map(workflowStore.recordsBySession).set(lineId, [lineWorkflow])
    // 缓存预热（= 抽屉打开时拉取产物喂入）后切焦点：同步命中，抑制立即生效
    noteBtwLinesPulled([lineId])
    await wrapper.setProps({ sessionId: lineId })
    expect(data().counts.value.subagent.total).toBe(0)
    expect(data().counts.value.workflow.total).toBe(0)

    // 旧 sid（SID，非线）的在途补拉此时才落表（快照替换：lineId 出缓存）——续写到达时
    // 焦点已不是 SID，时效守卫跳过回写，derivedSuppressed 保持 true
    resolveListSessions([])
    await vi.waitFor(() => expect(isKnownBtwLine(lineId)).toBe(false), { interval: 1 })
    await nextTick()
    expect(data().counts.value.subagent).toEqual({ running: 0, ended: 0, total: 0 })
    expect(data().counts.value.workflow).toEqual({ running: 0, ended: 0, total: 0 })
    expect(data().lists.subagent.running.value).toHaveLength(0)
    expect(data().lists.workflow.running.value).toHaveLength(0)
  })
})

// ── 第 5 件 canvas（u-tray-entry，problem-solve-canvas §3.1(3)）──

/** canvas.list 条目 fixture（形状 = canvas.list 投影，含阶段徽标派生输入；ownerSessionId = D4 归属字段） */
function makeCanvasEntry(overrides: Partial<CanvasListEntry> & { canvasId: string }): CanvasListEntry {
  return {
    ownerSessionId: SID,
    name: `画布 ${overrides.canvasId}`,
    statement: '示例陈述',
    converged: false,
    openMustFix: 0,
    reviewStatus: null,
    ...overrides,
  }
}

/** 构造 canvas.updated 全局广播帧并分发（core 全局通道真实现，use-canvas-sync.test 同款；
 * payload.sessionId = 画布归属会话——D4 隔离后消费方按归属分流） */
function broadcastCanvasUpdated(canvasId: string, sessionId: string = SID): void {
  // canvas.updated 消费端在 crossSession 通道（use-canvas-sync 模块级单订阅）——
  // dispatchGlobal 不喂该通道，发帧必须走 dispatchCrossSession（对齐 use-canvas-sync.test）
  dispatchCrossSession({
    type: 'canvas.updated',
    payload: { canvasId, sessionId, evType: 'NodeCreated', eventId: 'ev-1', summary: '' },
  } as ServerMessage<'canvas.updated'>)
}

describe('useTrayCounts canvas kind（第 5 件画布，u-tray-entry）', () => {
  it('计数口径：running = 未收敛数、ended = 已收敛数、total = 全部；行集 = canvas.list 投影', async () => {
    commandMock.mockResolvedValue({
      canvases: [
        makeCanvasEntry({ canvasId: 'cvs-open' }),
        makeCanvasEntry({ canvasId: 'cvs-done', converged: true }),
        makeCanvasEntry({ canvasId: 'cvs-fix', openMustFix: 2, reviewStatus: 'in-progress' }),
      ],
    })
    mountHarness()
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(3), { interval: 1 })

    expect(data().counts.value.canvas).toEqual({ running: 2, ended: 1, total: 3 })
    expect(data().lists.canvas.entries.value.map((c) => c.canvasId)).toEqual([
      'cvs-open',
      'cvs-done',
      'cvs-fix',
    ])
  })

  it('canvas.updated 广播失效 → 重新 canvas.list 拉取，清单与计数跟随（推为提示、拉为真理）', async () => {
    // 按 type 分流（广播处理器会同时发 canvas.get + canvas.list，Once 队列会被 get 消费）
    commandMock.mockImplementation(async (type: string) => {
      if (type === 'canvas.list') return { canvases: [makeCanvasEntry({ canvasId: 'cvs-1' })] }
      return null
    })
    mountHarness()
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(1), { interval: 1 })

    // 广播后重拉：清单换新（旧画布收敛 + 新画布加入）
    commandMock.mockImplementation(async (type: string) => {
      if (type === 'canvas.list') {
        return {
          canvases: [
            makeCanvasEntry({ canvasId: 'cvs-1', converged: true }),
            makeCanvasEntry({ canvasId: 'cvs-2' }),
          ],
        }
      }
      return null
    })
    broadcastCanvasUpdated('cvs-1')
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(2), { interval: 1 })
    expect(data().counts.value.canvas).toEqual({ running: 1, ended: 1, total: 2 })
  })

  it('画布按归属会话隔离：空 sid 下 canvas 计数归零（per-session 分区——无会话即无画布）', async () => {
    commandMock.mockResolvedValue({
      canvases: [makeCanvasEntry({ canvasId: 'cvs-global' })],
    })
    const wrapper = mountHarness('')
    await vi.waitFor(() => expect(data().counts.value.session.total).toBe(0), { interval: 1 })
    // 空 sid → 归一 null → 不发 canvas.list RPC、计数恒零（与 session 件同款归零语义）
    expect(commandMock).not.toHaveBeenCalledWith('canvas.list', expect.anything(), expect.anything())
    expect(data().counts.value.canvas).toEqual({ running: 0, ended: 0, total: 0 })
    wrapper.unmount()
  })

  it('跨会话广播不刷新本会话计数：B 会话画布的 canvas.updated 只重拉 B 分区（A 计数不变）', async () => {
    commandMock.mockImplementation(async (type: string) => {
      if (type === 'canvas.list') return { canvases: [makeCanvasEntry({ canvasId: 'cvs-a' })] }
      return null
    })
    mountHarness()
    await vi.waitFor(() => expect(data().counts.value.canvas.total).toBe(1), { interval: 1 })

    // B 会话的画布变更广播（payload.sessionId = SID2）→ 只重拉 B 分区清单，
    // A 的计数与清单不变（D4 隔离：托盘计数 = 本会话画布）
    commandMock.mockImplementation(async (type: string) => {
      if (type === 'canvas.list') {
        return {
          canvases: [
            makeCanvasEntry({ canvasId: 'cvs-a' }),
            makeCanvasEntry({ canvasId: 'cvs-b', ownerSessionId: SID2 }),
          ],
        }
      }
      return null
    })
    broadcastCanvasUpdated('cvs-b', SID2)
    await vi.waitFor(() => expect(commandMock).toHaveBeenCalledWith('canvas.list', { sessionId: SID2 }, expect.anything()), { interval: 1 })
    // A 的清单未被动过（B 的广播只写 B 分区）
    expect(data().lists.canvas.entries.value.map((c) => c.canvasId)).toEqual(['cvs-a'])
    expect(data().counts.value.canvas.total).toBe(1)
  })
})
})

