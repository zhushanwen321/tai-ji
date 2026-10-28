/**
 * tray 域 widget 侧合并产物（round 6 renderer 测试压缩）：三文件同产物
 * （tray-native-panel / useTrayCounts 因 useTrayCounts 真实 composable 测试与
 * composer-tray 的 partial mock 结构性互斥，归 tray-native-bundle）。
 *
 * 并入来源（基名）：
 *  - composer-tray（built-in 三态 + hover 时序 + pin，53 例）
 *  - tray-widget（icon/badge fallback 链 + status 视觉，28 例；零 mock——
 *    本产物 mock 面对其被测组件无消费）
 *  - tray-canvas-panel（列表渲染 + 行点击 overlay + 三要素 modal，11 例）
 *
 * mock 注册与互斥核查：
 *  - useTrayCounts：composer-tray 的 partial（importOriginal spread + 仅覆写
 *    useTrayCounts 函数）——TRAY_COUNTS_KEY 等真实成员保留，canvas-panel 节的
 *    provide(TRAY_COUNTS_KEY) 与 tray-widget 节不受影响。
 *  - '@taiji/core/transport/api'：composer-tray 与 canvas-panel 两厂逐字相同
 *    （spread actual + command: commandMock）→ 单次注册共享 commandMock 单例。
 *  - canvas-panel 独占：workflow-viz-overlay（openCanvasTabMock）/ useToast
 *    （toastErrorMock；ComposerTray 与 TrayWidget* 不消费 useToast，惰性无害）。
 *  - composer-tray 独占：useSidebar / useBackgroundTasks（空 tasks 形态）。
 *  - composer-tray 头段（imports+fixture+mocks）逐字保留；'./tray-view-host-mock'
 *    './tray-counts-stub' 相对说明符已改 '@/__tests__/panel/tray/…'；canvas-panel /
 *    tray-widget 节仅补 composer-tray 未覆盖模块的 import。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/components/panel/tray/__tests__/tray-widget-bundle.test.ts
 */
// ── composer-tray 头段（imports + fixture + mock 注册，逐字）──
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { computed, nextTick, reactive } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import type { ViewHostSource } from '@taiji/ui/extension-host'
import { ansiLine, makeEntry, makeWidgetSource } from '@/__tests__/panel/tray/tray-view-host-mock'
import type { MockWidgetSource } from '@/__tests__/panel/tray/tray-view-host-mock'
import { makeTrayCountsStub } from '@/__tests__/panel/tray/tray-counts-stub'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { HEADER_ACTIONS_SOURCE_KEY } from '@/composables/shell/useExtensionHostBridge'
import ComposerTray from '@/components/panel/tray/ComposerTray.vue'
import type { TrayBuiltinKind as TrayKind, UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { CanvasListEntry } from '@zhushanwen/extension-protocol'
import type { SessionSummary, SubagentRecord, WorkflowRunRecord } from '@taiji/shared'
import zhTray from '@/i18n/locales/zh-CN/tray'

// ── mock：数据范围（三件计数/行集；口径与首次拉取触发在 useTrayCounts.test.ts）──
interface TrayState {
  bashRunning: BackgroundTaskEntry[]
  bashEnded: BackgroundTaskEntry[]
  bashLoaded: boolean
  subagentRunning: SubagentRecord[]
  subagentEnded: SubagentRecord[]
  subagentLoading: boolean
  workflowRunning: WorkflowRunRecord[]
  workflowEnded: WorkflowRunRecord[]
  workflowLoading: boolean
  /** 第 4 件子会话行集（u7） */
  sessionChildren: SessionSummary[]
  /** 第 5 件画布清单（u-tray-entry） */
  canvasEntries: CanvasListEntry[]
}

function createTrayState(): TrayState {
  return {
    bashRunning: [],
    bashEnded: [],
    bashLoaded: true,
    subagentRunning: [],
    subagentEnded: [],
    subagentLoading: false,
    workflowRunning: [],
    workflowEnded: [],
    workflowLoading: false,
    sessionChildren: [],
    canvasEntries: [],
  }
}

/** reactive 容器（字段变更驱动下游 computed；对象本身恒不替换，防 computed 依赖失联） */
const trayState = reactive<TrayState>(createTrayState())

/**
 * 数据范围替身/透传开关（U1）：`calls` = useTrayCounts 调用次数 = 数据范围实例创建次数——外壳
 * 只创建唯一实例并 provide，面板 inject 消费，故任意开合次数下都应恒为 1；`useReal` 打开时
 * 透传真实现（U1 用例用真实拉取路径 + spy 断言不重发首次拉取）。
 */
const trayCountsSwitch = vi.hoisted(() => ({ useReal: false, calls: 0 }))

vi.mock('@/components/panel/tray/useTrayCounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/panel/tray/useTrayCounts')>()
  return {
    ...actual,
    useTrayCounts: (sessionIdRef: Ref<string | null | undefined>): UseTrayCountsReturn => {
      trayCountsSwitch.calls += 1
      return trayCountsSwitch.useReal ? actual.useTrayCounts(sessionIdRef) : createTrayFixture()
    },
  }
})

/** fixture 数据范围（计数/行集由 trayState 注入；`UseTrayCountsReturn` 类型标注 = 契约漂移门） */
function createTrayFixture(): UseTrayCountsReturn {
  return {
    ...makeTrayCountsStub(trayState),
    bashPartition: computed(() => ({
      tasks: [],
      loaded: trayState.bashLoaded,
      corrupted: false,
      fetchFailed: false,
    })),
    errors: { subagent: computed(() => null), workflow: computed(() => null) },
    retry: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * bash 分区状态根替身：仅 U1 用例（`useReal` 模式）会消费——真实 useTrayCounts 内部调
 * useBackgroundTasks，替身避免测试打真实 list RPC / 挂物理订阅。
 */
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

// ── mock：canvas.list RPC（第 5 件 canvas 的数据链真实经过 useCanvasSync 订阅 → canvas store
//    → canvas.list；`useReal` 模式会触发首拉——替身回空清单，避免打真实 WS 通道）──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock }
})

// ── mock：打开链（第 4 件 session 面板行点击 → selectSession；真实 useSidebar 依赖重，替身即可）──
const selectSessionMock = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>())
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: selectSessionMock }),
}))

// ── headerAction 数据源开关（B3 聚合范围：聚合面板首段 = 被聚合 clock 直开入口的承接段）。
//    经 mountTray 的 provide 注入（HEADER_ACTIONS_SOURCE_KEY 消费方 = 外壳 + HeaderActionsHost）；
//    hasVisibleHeaderActions 纯函数用真实现（可见性条件单点，与面板按钮渲染同源），source stub 经开关切换。 ──
const headerActionsSwitch = vi.hoisted(() => ({ source: null as object | null }))
// ── canvas-panel / tray-widget 补充 import（composer-tray 未覆盖的模块）──
import TrayCanvasPanel from '@/components/panel/tray/TrayCanvasPanel.vue'
import { TRAY_COUNTS_KEY } from '@/components/panel/tray/useTrayCounts'
import { defineComponent, h, inject, ref } from 'vue'
import TrayWidgetButton from '@/components/panel/tray/TrayWidgetButton.vue'
import TrayWidgetPanel from '@/components/panel/tray/TrayWidgetPanel.vue'
import { orderTrayWidgetIds } from '@/components/panel/tray/tray-order'
import type { GuiComponent, WidgetMeta } from '@zhushanwen/extension-protocol'
import type { ViewCacheEntry } from '@taiji/ui/extension-host'

// ── canvas-panel 附加 mock（openCanvasTab / useToast；transport/api 同 composer-tray 逐字，不重复注册）──
const openCanvasTabMock = vi.hoisted(() => vi.fn<(canvasId: string, sessionId: string) => void>())
vi.mock('@/components/panel/workflow-viz/overlay/workflow-viz-overlay', () => ({
  openCanvasTab: openCanvasTabMock,
}))

const toastErrorMock = vi.hoisted(() => vi.fn<(msg: string) => void>())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastErrorMock, success: vi.fn(), info: vi.fn() }),
}))

// ═══════════ 来源节：composer-tray ═══════════

describe('composer-tray', () => {
/** scheduler 形态的 headerAction source stub（activation=overlay 直开，无 E13/E3 依赖） */
function makeHeaderActionSource(overrides: { hidden?: boolean } = {}): object {
  return {
    getDeclarations: () => [
      {
        pluginId: 'scheduler-manager',
        contributionId: 'scheduler-manager.open',
        type: 'headerAction',
        headerAction: { activation: 'scheduler-overlay', icon: 'clock', title: '定时任务' },
      },
    ],
    // 缺省反转后「可见」用例一律已推送形态（hidden=true 显式停用 / false 已推送在场）
    getRuntimeState: () => ({ headerActionId: 'scheduler-manager.open', pluginId: 'scheduler-manager', updatedAt: 1, hidden: overrides.hidden === true }),
    resolveCommandAvailability: () => 'registered',
    executeCommand: () => true,
  }
}

const SID = 's-tray-shell'
const SID2 = 's-tray-shell-2'
/** fake timers 固定「现在」（bash 行耗时派生确定性） */
const FIXED_NOW = new Date(2026, 8, 16, 10, 30, 0).getTime()

/** hover 开面板延时 / 移出收起延时（与组件常量对齐；此处是断言的期望值，不是实现复用） */
const OPEN_MS = 160
const CLOSE_MS = 240

function makeTask(overrides: Partial<BackgroundTaskEntry> & { taskId: string }): BackgroundTaskEntry {
  return {
    pid: 101,
    command: 'pnpm test',
    outputFile: '/tmp/taiji/bg.log',
    startedAt: FIXED_NOW - 37_000,
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
    ...overrides,
  }
}

function makeWorkflow(overrides: Partial<WorkflowRunRecord> & { runId: string }): WorkflowRunRecord {
  return {
    scriptName: 'release-flow',
    slug: 'rel',
    status: 'done',
    startedAt: new Date(FIXED_NOW - 60_000).toISOString(),
    agentCalls: [],
    stateFilePath: '/data/wf.jsonl',
    ...overrides,
  }
}

/** 子会话 fixture（u7：第 4 件 session kind） */
function makeChild(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    label: '子会话',
    cwd: '/Users/dev/Code/work-project',
    status: 'active',
    lastActiveAt: FIXED_NOW - 5 * 60_000,
    spawnSource: 'agent',
    parentAgentSessionId: SID,
    ...overrides,
  }
}

/** 画布清单条目 fixture（u-tray-entry：第 5 件 canvas kind，形状 = canvas.list 投影；
 * ownerSessionId = D4 归属字段——本会话画布，缺省 SID） */
function makeCanvas(overrides: Partial<CanvasListEntry> & { canvasId: string }): CanvasListEntry {
  return {
    ownerSessionId: SID,
    name: `画布 ${overrides.canvasId}`,
    statement: '示例问题陈述',
    converged: false,
    openMustFix: 0,
    reviewStatus: null,
    ...overrides,
  }
}

// ── widget 区响应式数据源 mock（同构壳层桥；与 tray-widget.test.ts 共用 tray-view-host-mock）──

// ── 挂载与查询工具 ──

let wrapper: VueWrapper | null = null

function mountTray(mock: MockWidgetSource, sessionId = SID, aggregated = false): VueWrapper {
  const provide: Record<symbol, unknown> = { [VIEW_HOST_SOURCE_KEY as symbol]: mock.source }
  if (headerActionsSwitch.source) {
    provide[HEADER_ACTIONS_SOURCE_KEY as symbol] = headerActionsSwitch.source
  }
  wrapper = mount(ComposerTray, {
    props: { sessionId, aggregated },
    global: { provide },
    attachTo: document.body,
  })
  return wrapper
}

/** 当前挂载的托盘按钮行元素 */
function row(): VueWrapper {
  if (!wrapper) throw new Error('tray not mounted')
  return wrapper
}

/** built-in 按钮（按 kind 定位） */
function builtinButton(kind: TrayKind) {
  return row().find(`[data-testid="tray-builtin-button"][data-kind="${kind}"]`)
}

/** built-in 按钮渲染序（用户看到的顺序） */
function builtinKinds(): string[] {
  return row()
    .findAll('[data-testid="tray-builtin-button"]')
    .map((n) => n.attributes('data-kind') ?? '')
}

/** widget 区按钮的 viewId 序列（用户看到的顺序） */
function widgetKeys(): string[] {
  return row()
    .findAll('[data-testid="tray-widget-button"]')
    .map((n) => n.attributes('data-widget-key') ?? '')
}

/** 浮层内的面板节点（Popover portal → document.body；每键各一个，互斥下恒 ≤1） */
function panelNodes(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="tray-panel"]'))
}

/**
 * 浮层根节点（PopoverContent 渲染的定位盒 = 面板节点的父元素）。
 * 热区判据（U3）：内边距必须在**面板节点自身**上——面板节点即浮层内容 div，覆盖浮层全幅；
 * 若内边距留在浮层根上，指针停在约 6px 的 padding 带内不会触发 pointerenter（收起计时不取消）。
 * jsdom 无命中测试，故以该结构不变量 + 行为断言共同锁定（行为：面板节点上 pointerenter
 * 取消收起、pointerleave 240ms 收起）。
 */
function panelLayerNode(): HTMLElement {
  const panel = panelNodes()[0]
  const layer = panel?.parentElement
  if (!panel || !layer) throw new Error('panel layer missing')
  return layer
}

/** 当前打开面板的键集合（互斥断言主入口） */
function panelKeys(): string[] {
  return panelNodes().map((n) => n.dataset.panelKey ?? '')
}

/** 面板内容节点（跨 built-in / widget 两类面板统一查询） */
function panelContentNodes(testid: string): HTMLElement[] {
  const panel = panelNodes()[0]
  return panel ? Array.from(panel.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)) : []
}

/** 浮层节点（面板内容 div，覆盖浮层全幅）——派发「进入/离开整体」类指针事件 */
function layerNode(): HTMLElement {
  const node = panelNodes()[0]
  if (!node) throw new Error('panel node missing')
  return node
}

/** 在浮层内元素上派发 DOM 事件（portal 内容不在 wrapper 树内，走原生 dispatch） */
function fire(node: HTMLElement | undefined, type: string): void {
  if (!node) throw new Error(`panel node missing while firing ${type}`)
  node.dispatchEvent(new Event(type))
}

/**
 * 真实点击序列（pointerdown → click）：reka 的「层外」判定发生在 pointerdown，pin 切换在 click。
 * 两次事件之间显式 flush——浏览器里 pointerdown 与 click 是两个独立任务，中间的微任务检查点会
 * 让 reka 的 dismiss 落地；同一任务里连发两事件会掩盖这条时序（变异实测：那样写的用例删掉
 * onInteractOutside 拦截仍全绿）。
 */
async function realClick(node: DOMWrapper<Element>): Promise<void> {
  node.element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await flushPromises()
  await node.trigger('click')
  await flushPromises()
  await advance(0)
}

/** 推进假时钟并让 Vue 完成重渲染 */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

/**
 * 聚合面板用例公共开场：aggregated 形态挂载 + 真实点击聚合入口 + 面板键断言
 * （原三用例逐字重复的「开聚合面板」段单源；面板段内容差异留在各用例）。
 */
async function openAggregatedPanel(): Promise<void> {
  mountTray(makeWidgetSource(SID), SID, true)
  await realClick(row().find('[data-testid="tray-aggregate-button"]'))
  expect(panelKeys()).toEqual(['aggregate'])
}

beforeEach(() => {
  setActivePinia(createPinia())
  Object.assign(trayState, createTrayState())
  trayCountsSwitch.useReal = false
  trayCountsSwitch.calls = 0
  headerActionsSwitch.source = null
  commandMock.mockReset()
  commandMock.mockResolvedValue({ canvases: [] })
  vi.useFakeTimers({ now: FIXED_NOW })
})

afterEach(() => {
  vi.useRealTimers()
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  __clearSessionCleanupRegistryForTest()
})

// ── ① built-in 三态（D7；验收 N2「归零不虚亮」）──

describe('ComposerTray built-in 三态（D7 / N2）', () => {
  it('全无记录 → 任务五件都不渲染（DOM 层不存在，而非 opacity:0）；canvas 同三态（零画布隐藏）', () => {
    mountTray(makeWidgetSource(SID))

    expect(row().find('[data-testid="composer-tray"]').exists()).toBe(true)
    // bash/subagent/workflow/session/canvas 全无 → 都不渲染（D4 隔离后 canvas 无恒渲染豁免：
    // 「本 session 无画布」前提成立，零画布时按钮隐藏，新建入口随首张画布出现）
    expect(builtinKinds()).toEqual([])
    expect(row().find('[data-testid="composer-tray"]').attributes('data-session-id')).toBe(SID)
  })

  it('有历史无进行中 → dim 常驻：按钮在，但计数与呼吸点元素不存在（不虚亮）', () => {
    trayState.bashEnded = [makeTask({ taskId: 'bt-e1', state: 'exited', reason: 'natural' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1', status: 'completed' })]
    trayState.workflowEnded = [makeWorkflow({ runId: 'wf-e1' })]
    mountTray(makeWidgetSource(SID))

    expect(builtinKinds()).toEqual(['bash', 'subagent', 'workflow'])
    for (const kind of ['bash', 'subagent', 'workflow'] as const) {
      const button = builtinButton(kind)
      expect(button.attributes('data-state')).toBe('idle')
      expect(button.find('[data-testid="tray-builtin-count"]').exists()).toBe(false)
      expect(button.find('[data-testid="tray-builtin-pulse"]').exists()).toBe(false)
      // aria 复用 panel.tray.title.*（icon 可识别性不依赖计数；原生 title 已退役，说明由 hover 面板承载）
      expect(button.attributes('aria-label')).toBe(zhTray.tray.title[kind])
    }
  })

  it('running > 0 → 亮计数 + 呼吸点（accent），且计数文本等于进行中条数', () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' }), makeTask({ taskId: 'bt-2' })]
    trayState.bashEnded = [makeTask({ taskId: 'bt-e1', state: 'exited', reason: 'natural' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1', status: 'completed' })]
    mountTray(makeWidgetSource(SID))

    const button = builtinButton('bash')
    expect(button.attributes('data-state')).toBe('running')
    expect(button.find('[data-testid="tray-builtin-count"]').text()).toBe('2')
    expect(button.find('[data-testid="tray-builtin-pulse"]').exists()).toBe(true)
    // 亮态色（角标 = demo .cbtn .badge 形态：accent 实底 + accent-fg 字）——
    // 归零不虚亮与「有进行中必亮」两面
    expect(button.find('[data-testid="tray-builtin-count"]').classes()).toContain('bg-accent')
    expect(button.find('[data-testid="tray-builtin-count"]').classes()).toContain('text-accent-fg')
    expect(button.find('[data-testid="tray-builtin-pulse"]').classes()).toContain('bg-accent')
    // 只有有进行中的那一件变亮，其余仍 dim 常驻
    expect(builtinButton('subagent').attributes('data-state')).toBe('idle')
  })

  it('三态混合：进行中件亮、仅历史件 dim、无记录件不渲染（同屏）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1' })]
    mountTray(makeWidgetSource(SID))

    // workflow 无记录 → 不渲染；bash 亮；subagent dim（零画布 → canvas 件同样不渲染）
    expect(builtinKinds()).toEqual(['bash', 'subagent'])

    // 进行中的计数消失（任务结束）→ 该按钮自动降为 dim 常驻（不虚亮）
    trayState.bashRunning = []
    trayState.bashEnded = [makeTask({ taskId: 'bt-1', state: 'exited', reason: 'natural' })]
    await nextTick()
    expect(builtinKinds()).toEqual(['bash', 'subagent'])
    expect(builtinButton('bash').attributes('data-state')).toBe('idle')
    expect(builtinButton('bash').find('[data-testid="tray-builtin-count"]').exists()).toBe(false)
  })

  it('built-in 固定序 bash → subagent → workflow（不参与 widget 动态排序）', () => {
    trayState.workflowEnded = [makeWorkflow({ runId: 'wf-e1' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1' })]
    trayState.bashEnded = [makeTask({ taskId: 'bt-e1', state: 'exited', reason: 'natural' })]
    mountTray(makeWidgetSource(SID))

    expect(builtinKinds()).toEqual(['bash', 'subagent', 'workflow'])
  })
})

// ── ② hover 时序（D8）──

describe('ComposerTray hover 时序（D8：160ms 开 / 240ms 收 / 移入面板不收起）', () => {
  it('hover 160ms 才开面板（159ms 仍不开）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS - 1)
    expect(panelKeys()).toEqual([])

    await advance(1)
    expect(panelKeys()).toEqual(['native:bash'])
    expect(builtinButton('bash').attributes('aria-expanded')).toBe('true')
  })

  it('指针离开后 240ms 收起（239ms 仍在）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)
    expect(panelKeys()).toEqual(['native:bash'])

    await builtinButton('bash').trigger('pointerleave')
    await advance(CLOSE_MS - 1)
    expect(panelKeys()).toEqual(['native:bash'])

    await advance(1)
    expect(panelKeys()).toEqual([])
    expect(builtinButton('bash').attributes('aria-expanded')).toBe('false')
  })

  it('指针移入浮层内不收起（离开 icon 的 240ms 计时器被浮层 pointerenter 取消）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)

    // icon → 面板 的间隙移动：先离开 icon，再进入浮层
    await builtinButton('bash').trigger('pointerleave')
    await advance(OPEN_MS)
    fire(layerNode(), 'pointerenter')
    await advance(CLOSE_MS * 3)

    expect(panelKeys()).toEqual(['native:bash'])
  })

  it('热区覆盖浮层 padding 带（U3）：内边距在热区元素自身，指针停在其中同样取消收起计时', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)

    // 结构不变量：p-1 必须在挂 pointerenter 的面板节点上（= 覆盖浮层全幅），
    // 留在浮层根上就会形成一圈不会取消收起计时的缺口（U3 根因）
    const panel = layerNode()
    expect(panel.className).toContain('p-1')
    expect(panelLayerNode().className).not.toContain('p-1')

    await builtinButton('bash').trigger('pointerleave')
    fire(panel, 'pointerenter')
    await advance(CLOSE_MS * 3)
    expect(panelKeys()).toEqual(['native:bash'])

    // 离开浮层整体 → 回落到 240ms 收起（不是「永不开合」）
    fire(panel, 'pointerleave')
    await advance(CLOSE_MS - 1)
    expect(panelKeys()).toEqual(['native:bash'])
    await advance(1)
    expect(panelKeys()).toEqual([])
  })

  it('浮层宽度钳制：400px 上限 + 视口钳制（窄视口不被裁）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)

    // 基准宽 400px（设计 D8）；窄视口下收到 视口-16px（仓内 CommandPopover 同款钳制），
    // min-w-0 解掉包装层 min-w-[240px] 在极窄视口下反过来压过 max-width 的优先级问题
    const cls = panelLayerNode().className
    expect(cls).toContain('w-[400px]')
    expect(cls).toContain('max-w-[calc(100vw-16px)]')
    expect(cls).toContain('min-w-0')
  })

  it('指针离开浮层 → 240ms 后收起（浮层与 icon 同语义）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)
    fire(layerNode(), 'pointerenter')
    fire(layerNode(), 'pointerleave')

    await advance(CLOSE_MS)
    expect(panelKeys()).toEqual([])
  })

  it('hover 打开面板不抢焦点（openAutoFocus 被拦下）：composer 里正在输入时预览不打断', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))
    // 模拟 composer 输入区持有焦点
    const typing = document.createElement('input')
    document.body.appendChild(typing)
    typing.focus()
    expect(document.activeElement).toBe(typing)

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)
    await flushPromises()
    await advance(0)

    expect(panelKeys()).toEqual(['native:bash'])
    // 面板挂载（reka FocusScope 会尝试聚焦内容首元素）后焦点仍在原处
    expect(document.activeElement).toBe(typing)
  })

  it('hover 开的面板未 pin：面板 data-pinned=false 且无行内操作按钮', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)

    const panel = panelNodes()[0]
    expect(panel.dataset.pinned).toBe('false')
    expect(panelContentNodes('tray-native-panel')).toHaveLength(1)
    expect(panelContentNodes('tray-bash-row')).toHaveLength(1)
    // D8：hover 态刻意不渲染行内按钮防误触（= pinned false 已透传到面板）
    expect(panelContentNodes('tray-bash-kill')).toHaveLength(0)
  })
})

// ── ③ pin 三解除路径（D8）──

describe('ComposerTray pin（D8：点击 pin / 再点·Esc·点外解除）', () => {
  it('点击 icon = pin：面板常驻（指针移开超过 240ms 仍开），行内操作随之出现', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('click')
    await nextTick()

    expect(panelKeys()).toEqual(['native:bash'])
    expect(builtinButton('bash').attributes('aria-pressed')).toBe('true')

    // 指针从未进入过 icon 也不影响（点即开）；离开序列不收起
    await builtinButton('bash').trigger('pointerleave')
    await advance(CLOSE_MS * 2)
    expect(panelKeys()).toEqual(['native:bash'])
    expect(panelNodes()[0].dataset.pinned).toBe('true')
    // pinned 透传到面板 → 行内两段式终止按钮出现
    expect(panelContentNodes('tray-bash-kill').length).toBeGreaterThan(0)
  })

  it('再点 icon 解除（真实点击序列 pointerdown+click：层外拦截不得先解除再被 click 回弹）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await realClick(builtinButton('bash'))
    expect(panelKeys()).toEqual(['native:bash'])

    await realClick(builtinButton('bash'))

    expect(panelKeys()).toEqual([])
    expect(builtinButton('bash').attributes('aria-pressed')).toBe('false')
  })

  it('Esc 解除（焦点无关：hover 预览态同样响应）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)
    expect(panelKeys()).toEqual(['native:bash'])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await advance(0)
    await flushPromises()

    expect(panelKeys()).toEqual([])
    expect(builtinButton('bash').attributes('aria-expanded')).toBe('false')
  })

  it('点面板外解除（pinned 后点托盘外的任意位置）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('click')
    await nextTick()
    expect(panelNodes()[0].dataset.pinned).toBe('true')

    // reka 的层外 pointerdown 监听延迟一个宏任务注册（setTimeout 0）——先让假时钟走一步
    await advance(0)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await advance(0)
    await flushPromises()

    expect(panelKeys()).toEqual([])
    expect(builtinButton('bash').attributes('aria-pressed')).toBe('false')
  })

  it('点击托盘自身按钮行不算「面板外」：pin 一件后点另一件 icon → 原 pin 不被 pointerdown 悄悄解除', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sa-1', status: 'running' })]
    mountTray(makeWidgetSource(SID))

    await realClick(builtinButton('bash'))
    expect(panelNodes()[0].dataset.pinned).toBe('true')

    // 真实点击序列的前半：pointerdown（reka 层外判定发生在这里）
    builtinButton('subagent').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    await advance(0)
    // 被当成层外 → 这里会被解除；拦截正确 → pin 态原样保持
    expect(builtinButton('bash').attributes('aria-pressed')).toBe('true')
    expect(panelKeys()).toEqual(['native:bash'])

    // 后半：click 把交互切到 B（互斥）
    await builtinButton('subagent').trigger('click')
    await flushPromises()
    await nextTick()
    expect(panelKeys()).toEqual(['native:subagent'])
    expect(builtinButton('subagent').attributes('aria-pressed')).toBe('true')
  })
})

// ── ④ 互斥（D8：同一时刻至多一个面板）──

describe('ComposerTray 互斥（D8：同时至多一个面板）', () => {
  it('开 A 后触发 B → A 收 B 开（hover 切换）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sa-1', status: 'running' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)
    expect(panelKeys()).toEqual(['native:bash'])

    await builtinButton('subagent').trigger('pointerenter')
    await advance(OPEN_MS)

    // 互斥的结构性证据：面板节点数恒 ≤ 1，且换成 B
    expect(panelNodes()).toHaveLength(1)
    expect(panelKeys()).toEqual(['native:subagent'])
    expect(builtinButton('bash').attributes('aria-expanded')).toBe('false')
  })

  it('pin 住 A 后 hover B → 切到 B 预览（A 收，B 未 pin）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sa-1', status: 'running' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('click')
    await nextTick()
    await builtinButton('subagent').trigger('pointerenter')
    await advance(OPEN_MS)

    expect(panelKeys()).toEqual(['native:subagent'])
    expect(panelNodes()[0].dataset.pinned).toBe('false')
    expect(builtinButton('bash').attributes('aria-pressed')).toBe('false')
  })

  it('未到 160ms 就移开 → 不打开任何面板（指针路过不闪面板）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sa-1', status: 'running' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS - 1)
    await builtinButton('bash').trigger('pointerleave')
    await builtinButton('subagent').trigger('pointerenter')
    await advance(OPEN_MS)

    // 唯一打开的是 B（A 的待打开被取消，不是开完再关）
    expect(panelKeys()).toEqual(['native:subagent'])
    expect(builtinButton('bash').attributes('aria-expanded')).toBe('false')
  })
})

// ── ⑤ widget 区（D3/D6/D7）与面板分流（D1）──

describe('ComposerTray widget 区与面板分流', () => {
  it('推送 widget entry → 按钮出现；顺序 = known-order 优先，未知 key 随后（built-in 恒在最左）', async () => {
    const mock = makeWidgetSource(SID)
    mountTray(mock)
    expect(widgetKeys()).toEqual([])

    mock.push(makeEntry('custom-b', [ansiLine('b')], { title: 'B' }))
    await nextTick()
    mock.push(makeEntry('goal', [ansiLine('g')], { title: 'Goal' }))
    await nextTick()
    mock.push(makeEntry('todo', [ansiLine('t')], { title: 'Todo' }))
    await nextTick()

    expect(widgetKeys()).toEqual(['todo', 'goal', 'custom-b'])
    // built-in 各件仍恒在最左（固定序不参与动态排序）
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    await nextTick()
    expect(builtinKinds()).toEqual(['bash'])
  })

  it('widget 面板内容 = TrayWidgetPanel（meta head + guiTree 正文），推送更新后正文重算', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('v1')], { title: 'Todo', status: 'running', badge: '2' }))
    mountTray(mock)

    await row().find('[data-testid="tray-widget-button"][data-widget-key="todo"]').trigger('click')
    await nextTick()

    expect(panelKeys()).toEqual(['widget:todo'])
    expect(panelContentNodes('tray-widget-panel')).toHaveLength(1)
    expect(panelContentNodes('tray-widget-panel-title')[0].textContent).toContain('Todo')
    expect(panelContentNodes('tray-widget-panel')[0].textContent).toContain('v1')

    // 面板打开期间推送更新 → 面板随推送刷新（同 computed 链，非一次性快照）
    mock.push(makeEntry('todo', [ansiLine('v2')], { title: 'Todo', status: 'running', badge: '2' }))
    await nextTick()
    expect(panelContentNodes('tray-widget-panel')[0].textContent).toContain('v2')
  })

  it('widget 面板热区同款（U3）：浮层内（含 padding 带）pointerenter 取消收起，离开浮层 240ms 收起', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('t')], { title: 'Todo' }))
    mountTray(mock)

    await row().find('[data-testid="tray-widget-button"][data-widget-key="todo"]').trigger('pointerenter')
    await advance(OPEN_MS)
    expect(panelKeys()).toEqual(['widget:todo'])

    const panel = layerNode()
    expect(panel.className).toContain('p-1')
    expect(panelLayerNode().className).not.toContain('p-1')

    await row().find('[data-testid="tray-widget-button"][data-widget-key="todo"]').trigger('pointerleave')
    fire(panel, 'pointerenter')
    await advance(CLOSE_MS * 3)
    expect(panelKeys()).toEqual(['widget:todo'])

    fire(panel, 'pointerleave')
    await advance(CLOSE_MS)
    expect(panelKeys()).toEqual([])
  })

  it('清屏（invalidate）→ 条目消失 + 面板一并消失 + pin 不诈尸（重注册不自动弹回）', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('t')], { title: 'Todo' }))
    mock.push(makeEntry('goal', [ansiLine('g')], { title: 'Goal' }))
    mountTray(mock)

    await row().find('[data-testid="tray-widget-button"][data-widget-key="todo"]').trigger('click')
    await nextTick()
    expect(panelKeys()).toEqual(['widget:todo'])

    mock.invalidate('todo')
    await nextTick()

    expect(widgetKeys()).toEqual(['goal'])
    expect(panelKeys()).toEqual([])

    // 重注册（extension 再次 setWidget）→ 条目回但交互态不继承（不是「诈尸」弹开）
    mock.push(makeEntry('todo', [ansiLine('t3')], { title: 'Todo' }))
    await nextTick()
    expect(widgetKeys()).toEqual(['todo', 'goal'])
    expect(panelKeys()).toEqual([])
  })

  it('built-in 该类记录归零（按钮摘除）→ 面板与 pin 一并作废，记录回来也不诈尸', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await realClick(builtinButton('bash'))
    expect(panelKeys()).toEqual(['native:bash'])

    // 该 session 的 bash 记录归零（列表清空）→ 按钮摘除、面板同批作废（零画布时 canvas 件同样不渲染）
    trayState.bashRunning = []
    await flushPromises()
    await advance(0)
    expect(builtinKinds()).toEqual([])
    expect(panelKeys()).toEqual([])

    // 新记录进来 → 按钮回来但交互态不继承（不是「诈尸」弹开）
    trayState.bashRunning = [makeTask({ taskId: 'bt-2' })]
    await flushPromises()
    await advance(0)
    expect(builtinKinds()).toEqual(['bash'])
    expect(panelKeys()).toEqual([])
  })

  it('built-in 面板 vs widget 面板分流：各走各的面板组件，data-panel-key 带命名空间前缀', async () => {
    const mock = makeWidgetSource(SID)
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mock.push(makeEntry('todo', [ansiLine('t')], { title: 'Todo' }))
    mountTray(mock)

    await builtinButton('bash').trigger('click')
    await nextTick()
    expect(panelKeys()).toEqual(['native:bash'])
    expect(panelContentNodes('tray-native-panel')).toHaveLength(1)
    expect(panelContentNodes('tray-widget-panel')).toHaveLength(0)

    await row().find('[data-testid="tray-widget-button"][data-widget-key="todo"]').trigger('click')
    await flushPromises()
    expect(panelKeys()).toEqual(['widget:todo'])
    expect(panelContentNodes('tray-widget-panel')).toHaveLength(1)
    expect(panelContentNodes('tray-native-panel')).toHaveLength(0)
  })

  it('无 VIEW_HOST_SOURCE 时（未 provide）只渲染 built-in 件，不抛错', () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    wrapper = mount(ComposerTray, { props: { sessionId: SID }, attachTo: document.body })

    expect(builtinKinds()).toEqual(['bash'])
    expect(widgetKeys()).toEqual([])
  })
})

// ── ⑥ 会话切换与归属（D12 / A6）──

describe('ComposerTray 会话切换（D12/A6：不残留旧 session 交互态）', () => {
  it('切 session：面板与 pin 一并作废，托盘行跟随新 sessionId', async () => {
    const mock = makeWidgetSource(SID)
    trayState.workflowRunning = [makeWorkflow({ runId: 'wf-1', status: 'running' })]
    mountTray(mock)

    await builtinButton('workflow').trigger('click')
    await nextTick()
    expect(panelKeys()).toEqual(['native:workflow'])
    expect(builtinButton('workflow').attributes('aria-pressed')).toBe('true')

    await row().setProps({ sessionId: SID2 })
    await flushPromises()
    await advance(0)

    expect(panelKeys()).toEqual([])
    expect(row().find('[data-testid="composer-tray"]').attributes('data-session-id')).toBe(SID2)
  })
})

// ── ⑦ 数据范围单例与首帧（U1/U2；真实 useTrayCounts + spy 拉取路径）──

describe('ComposerTray 数据范围单例（U1：面板不自建实例、开合不重发首次拉取 RPC）', () => {
  it('面板打开/关闭/换件/重开：数据范围实例恒一个、loadSubagents / loadWorkflows 各仅一次', async () => {
    // 真实数据范围（外壳仍是唯一调用点）+ spy 拉取路径：断言的是 load RPC 次数，不是替身内部行为
    trayCountsSwitch.useReal = true
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    const loadSubSpy = vi.spyOn(subagentStore, 'loadSubagents').mockResolvedValue(undefined)
    const loadWfSpy = vi.spyOn(workflowStore, 'loadWorkflows').mockResolvedValue(undefined)
    // 拉取路径被替身 → 数据直接种入分区（外壳三态与面板行集都读同一分区）
    subagentStore.applyRecords(SID, [makeSubagent({ subagentId: 'sa-1', status: 'running' })])
    // workflow 种数据：applyRecords 已私有化，直写分区 ref
    workflowStore.recordsBySession = new Map(workflowStore.recordsBySession).set(SID, [
      makeWorkflow({ runId: 'wf-1', status: 'running' }),
    ])

    mountTray(makeWidgetSource(SID))
    await flushPromises()

    expect(trayCountsSwitch.calls).toBe(1) // 唯一实例 = 外壳（面板若自建即为 2+）
    expect(loadSubSpy).toHaveBeenCalledTimes(1)
    expect(loadSubSpy).toHaveBeenCalledWith(SID)
    expect(loadWfSpy).toHaveBeenCalledTimes(1)

    // 首次打开面板（面板挂载）：行集来自外壳实例，无新增 RPC
    await builtinButton('subagent').trigger('click')
    await nextTick()
    expect(panelKeys()).toEqual(['native:subagent'])
    expect(panelContentNodes('tray-subagent-row')).toHaveLength(1)
    expect(trayCountsSwitch.calls).toBe(1)
    expect(loadSubSpy).toHaveBeenCalledTimes(1)

    // 关闭 → 换另一件打开（旧面板卸载）→ 再关再开：每次重挂都不得重发首次拉取
    await builtinButton('subagent').trigger('click')
    await nextTick()
    expect(panelKeys()).toEqual([])
    await builtinButton('workflow').trigger('click')
    await nextTick()
    expect(panelKeys()).toEqual(['native:workflow'])
    expect(panelContentNodes('tray-workflow-row')).toHaveLength(1)
    await builtinButton('workflow').trigger('click')
    await nextTick()
    await builtinButton('subagent').trigger('click')
    await nextTick()
    expect(panelKeys()).toEqual(['native:subagent'])

    expect(trayCountsSwitch.calls).toBe(1)
    expect(loadSubSpy).toHaveBeenCalledTimes(1)
    expect(loadWfSpy).toHaveBeenCalledTimes(1)
  })
})

describe('ComposerTray 首帧即列表（U2：hover 打开不闪加载态）', () => {
  it('subagent：在途（loading）但该类已有数据 → 面板打开首帧即列表，不渲染加载占位', async () => {
    trayState.subagentRunning = [makeSubagent({ subagentId: 'sa-1', status: 'running' })]
    trayState.subagentLoading = true
    mountTray(makeWidgetSource(SID))

    await builtinButton('subagent').trigger('pointerenter')
    await advance(OPEN_MS)

    expect(panelKeys()).toEqual(['native:subagent'])
    expect(panelContentNodes('tray-panel-loading')).toHaveLength(0)
    expect(panelContentNodes('tray-subagent-row')).toHaveLength(1)
  })

  it('bash：从未成功 list 过但有广播投递的任务 → 直出列表（loading 只吞「无数据的真首次拉取」）', async () => {
    trayState.bashLoaded = false
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('bash').trigger('pointerenter')
    await advance(OPEN_MS)

    expect(panelKeys()).toEqual(['native:bash'])
    expect(panelContentNodes('tray-panel-loading')).toHaveLength(0)
    expect(panelContentNodes('tray-bash-row')).toHaveLength(1)
  })
})

// ── 序 4 聚合入口（u6b / D6：「层叠图标 + 运行数」→ 面板内分段展示全部类别）──

describe('ComposerTray 序 4 聚合单入口（aggregated）', () => {
  it('aggregated + 有进行中条目 → 单入口按钮（单图标 + 运行数数字角标），逐件按钮不再渲染', () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' }), makeTask({ taskId: 'bt-2' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1', status: 'completed' })]
    mountTray(makeWidgetSource(SID), SID, true)

    const aggregate = row().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)
    // 单图标硬约束（W3a 禁多 icon 重叠）：入口内只有一个 svg（layers），运行数走数字角标
    expect(aggregate.findAll('svg')).toHaveLength(1)
    // aria = 「全部工具」（运行数不进 aria-label，只在角标；原生 title 已退役）
    expect(aggregate.attributes('aria-label')).toBe(zhTray.tray.aggregate.allTools)
    // 运行数 = 进行中合计（仅历史件不计入）
    expect(aggregate.find('[data-testid="tray-aggregate-count"]').text()).toBe('2')
    expect(aggregate.find('[data-testid="tray-aggregate-pulse"]').exists()).toBe(true)
    // 逐件按钮整体退场（聚合就是聚合，不是叠加展示）
    expect(row().findAll('[data-testid="tray-builtin-button"]')).toHaveLength(0)
  })

  it('点击聚合入口 → 面板内分段展示全部类别（段头 = 类别标题 + running/total）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.bashEnded = [makeTask({ taskId: 'bt-e1', state: 'exited', reason: 'natural' })]
    trayState.workflowEnded = [makeWorkflow({ runId: 'wf-e1' })]
    trayState.canvasEntries = [makeCanvas({ canvasId: 'cvs-1' })]
    await openAggregatedPanel()

    expect(panelContentNodes('tray-aggregate-panel')).toHaveLength(1)
    // 段 = 有记录的类别（bash + workflow + canvas），全无记录的任务类别不出段
    expect(panelContentNodes('tray-aggregate-section-bash')).toHaveLength(1)
    expect(panelContentNodes('tray-aggregate-section-workflow')).toHaveLength(1)
    expect(panelContentNodes('tray-aggregate-section-subagent')).toHaveLength(0)
    expect(panelContentNodes('tray-aggregate-section-canvas')).toHaveLength(1)
    const bashCount = panelNodes()[0]?.querySelector('[data-testid="tray-aggregate-count-bash"]')
    expect(bashCount?.textContent).toBe('1/2')
    // 段体复用真实 built-in 面板（行渲染/行内操作零复制；canvas 段体 = TrayCanvasPanel）
    expect(panelContentNodes('tray-native-panel')).toHaveLength(2)
    expect(panelContentNodes('tray-canvas-panel')).toHaveLength(1)
  })

  it('aggregated + 任务件与画布全无记录 → 聚合入口不渲染（无条目即无入口；D4 后 canvas 无恒在豁免）', async () => {
    mountTray(makeWidgetSource(SID), SID, true)

    const aggregate = row().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(false)
  })

  it('aggregated + 仅本会话有画布 → 聚合入口渲染且面板含 canvas 段（段体 = TrayCanvasPanel）', async () => {
    trayState.canvasEntries = [makeCanvas({ canvasId: 'cvs-1' })]
    mountTray(makeWidgetSource(SID), SID, true)

    const aggregate = row().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)
    // 运行数 = 未收敛画布数 1（徽标在场）
    expect(aggregate.find('[data-testid="tray-aggregate-count"]').text()).toBe('1')

    await realClick(aggregate)
    expect(panelKeys()).toEqual(['aggregate'])
    expect(panelContentNodes('tray-aggregate-section-canvas')).toHaveLength(1)
    expect(panelContentNodes('tray-canvas-panel')).toHaveLength(1)
  })

  // ── W3a：聚合入口可见条件扩展 + 聚合面板承接插件 toolbar ──

  it('aggregated + 托盘全无任务条目但插件 toolbar 有贡献 → 聚合入口仍渲染；面板含发丝分隔 + toolbar ViewHost', async () => {
    // 挂载点视图只经 getView 可见、不进 getViewIds 枚举（聚合入口可见条件的独立判定侧）
    const toolbarSource: ViewHostSource = {
      getViewIds: () => [],
      getView: (sid, viewId) =>
        sid === SID && viewId === 'composer.toolbar'
          ? makeEntry('composer.toolbar', [ansiLine('toolbar body')])
          : undefined,
    }
    wrapper = mount(ComposerTray, {
      props: { sessionId: SID, aggregated: true },
      global: { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: toolbarSource } },
      attachTo: document.body,
    })

    // 基线（只看托盘任务条目）下 toolbar 贡献是聚合入口的独立可见条件（D4 隔离后
    // canvas 件按三态参与，零画布不贡献条目）——断言保留在场性，贡献判定本身由
    // headerAction/toolbar 用例承载
    const aggregate = row().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)

    await realClick(aggregate)
    expect(panelKeys()).toEqual(['aggregate'])
    const panel = panelNodes()[0]
    // toolbar 承接：ViewHost 渲染贡献内容（用户可见 DOM）
    expect(panel?.querySelector('[data-testid="view-host"]')).not.toBeNull()
    expect(panel?.textContent ?? '').toContain('toolbar body')
    // 发丝分隔存在（h-px + bg-border-strong，紧邻 ViewHost 包装容器之前）
    expect(panel?.querySelector('span.h-px.bg-border-strong')).not.toBeNull()
  })

  it('aggregated + 插件零贡献 → 面板无发丝分隔、无 toolbar ViewHost（不留死分隔）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    await openAggregatedPanel()

    const panel = panelNodes()[0]
    expect(panel?.querySelector('[data-testid="view-host"]')).toBeNull()
    expect(panel?.querySelector('span.h-px.bg-border-strong')).toBeNull()
    // 既有托盘分段不受影响
    expect(panel?.querySelector('[data-testid="tray-aggregate-section-bash"]')).not.toBeNull()
  })

  it('widget-only（无任务条目）→ 聚合入口渲染（通用图标兜底）且面板含 widget 段', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('widget body')], { title: 'Todo', status: 'running' }))
    mountTray(mock, SID, true)

    const aggregate = row().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)
    // 运行数来自 widget meta.status === 'running'
    expect(aggregate.find('[data-testid="tray-aggregate-count"]').text()).toBe('1')
    expect(row().findAll('[data-testid="tray-widget-button"]')).toHaveLength(0)

    await realClick(aggregate)
    expect(panelKeys()).toEqual(['aggregate'])
    expect(panelContentNodes('tray-aggregate-widget-todo')).toHaveLength(1)
    expect(panelContentNodes('tray-widget-panel')).toHaveLength(1)
  })

  it('三态上抛（能力标志 hasTrayItems）：零画布零记录 → 上报 false；有记录 → true', async () => {
    mountTray(makeWidgetSource(SID), SID, true)
    // 任务条目与画布全无 → 无条目可聚合，上抛 false（D4 隔离后 canvas 无恒在豁免）
    expect(row().emitted('update:hasItems')).toEqual([[false]])

    // 任务条目进来 → 上抛翻 true
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    await nextTick()
    expect(row().emitted('update:hasItems')).toEqual([[false], [true]])
  })
})

// ── ①b 第 4 件「子会话」（u7 / 设计 mode-system-composer-density §6.7 D7）──

describe('ComposerTray 第 4 件「子会话」（u7）', () => {
  it('有子会话（进行中）→ data-kind="session" 按钮渲染 + 呼吸点 + 计数徽标 = 子会话总数', () => {
    trayState.sessionChildren = [
      makeChild({ id: 'c-1', status: 'active' }),
      makeChild({ id: 'c-2', status: 'done' }),
      makeChild({ id: 'c-3', status: 'error' }),
    ]
    mountTray(makeWidgetSource(SID))

    const button = builtinButton('session')
    expect(button.exists()).toBe(true)
    expect(button.attributes('aria-label')).toBe(zhTray.tray.title.session)
    expect(button.attributes('data-state')).toBe('running')
    expect(button.find('[data-testid="tray-builtin-pulse"]').exists()).toBe(true)
    // 计数徽标 = 子会话总数（设计 §6.7：`● 3`；运行中信号由呼吸点承载）
    expect(button.find('[data-testid="tray-builtin-count"]').text()).toBe('3')
  })

  it('仅历史（无进行中）→ dim 常驻：按钮在，计数与呼吸点都不出（不虚亮）', () => {
    trayState.sessionChildren = [makeChild({ id: 'c-1', status: 'done' })]
    mountTray(makeWidgetSource(SID))

    const button = builtinButton('session')
    expect(button.exists()).toBe(true)
    expect(button.attributes('data-state')).toBe('idle')
    expect(button.find('[data-testid="tray-builtin-count"]').exists()).toBe(false)
    expect(button.find('[data-testid="tray-builtin-pulse"]').exists()).toBe(false)
  })

  it('全无子会话 → 该件不渲染（三态之「全无」；DOM 层不存在；零画布时 canvas 件同样不渲染）', () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    expect(builtinButton('session').exists()).toBe(false)
    expect(builtinKinds()).toEqual(['bash'])
  })

  it('固定序末位：bash → subagent → workflow → session → canvas（不参与 widget 动态排序）', () => {
    trayState.bashEnded = [makeTask({ taskId: 'bt-e1', state: 'exited', reason: 'natural' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1', status: 'completed' })]
    trayState.workflowEnded = [makeWorkflow({ runId: 'wf-e1' })]
    trayState.sessionChildren = [makeChild({ id: 'c-1', status: 'done' })]
    trayState.canvasEntries = [makeCanvas({ canvasId: 'cvs-1' })]
    mountTray(makeWidgetSource(SID))

    expect(builtinKinds()).toEqual(['bash', 'subagent', 'workflow', 'session', 'canvas'])
  })

  it('聚合入口共存（序 4）：聚合面板含 session 段与 canvas 段，段内各复用专属面板', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.sessionChildren = [makeChild({ id: 'c-1', status: 'active' })]
    trayState.canvasEntries = [makeCanvas({ canvasId: 'cvs-1' })]
    await openAggregatedPanel()

    expect(panelContentNodes('tray-aggregate-section-session')).toHaveLength(1)
    expect(panelContentNodes('tray-session-panel')).toHaveLength(1)
    expect(panelContentNodes('tray-aggregate-section-canvas')).toHaveLength(1)
    expect(panelContentNodes('tray-canvas-panel')).toHaveLength(1)
    // bash 段仍走 TrayNativePanel（分流未改变）
    expect(panelContentNodes('tray-native-panel')).toHaveLength(1)
  })

  it('聚合入口运行数含子会话运行中计数（跨件求和）', () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.sessionChildren = [
      makeChild({ id: 'c-1', status: 'active' }),
      makeChild({ id: 'c-2', status: 'done' }),
    ]
    mountTray(makeWidgetSource(SID), SID, true)
    // bash 1 + session 1 = 2（canvas 零画布不计入）
    expect(row().find('[data-testid="tray-aggregate-count"]').text()).toBe('2')
  })
})

// ── ①c 第 5 件「画布」（u-tray-entry，problem-solve-canvas §3.1(3)）──

describe('ComposerTray 第 5 件「画布」（u-tray-entry）', () => {
  it('零画布 → 按钮不渲染（D4 裁决 4：三态之「全无」——「＋新建画布」入口随首张画布出现）', () => {
    mountTray(makeWidgetSource(SID))

    expect(builtinButton('canvas').exists()).toBe(false)
    expect(builtinKinds()).toEqual([])
  })

  it('有画布 → 计数徽标 = 画布总数；存在未收敛画布 → 呼吸点亮（running = 未收敛数）', async () => {
    trayState.canvasEntries = [
      makeCanvas({ canvasId: 'cvs-open' }),
      makeCanvas({ canvasId: 'cvs-done', converged: true }),
      makeCanvas({ canvasId: 'cvs-fix', openMustFix: 2 }),
    ]
    mountTray(makeWidgetSource(SID))

    const button = builtinButton('canvas')
    expect(button.attributes('data-state')).toBe('running')
    // 徽标 = 总数（数量型类别与 session 件同款：total 承载数量，呼吸点承载进行中）
    expect(button.find('[data-testid="tray-builtin-count"]').text()).toBe('3')
    expect(button.find('[data-testid="tray-builtin-pulse"]').exists()).toBe(true)

    // 聚合入口运行数 = 未收敛画布数（bash 0 + canvas 2）
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    mountTray(makeWidgetSource(SID), SID, true)
    expect(row().find('[data-testid="tray-aggregate-count"]').text()).toBe('2')
  })

  it('全部画布已收敛 → dim 常驻（呼吸点与计数徽标都不出，不虚亮）', () => {
    trayState.canvasEntries = [
      makeCanvas({ canvasId: 'cvs-done', converged: true }),
      makeCanvas({ canvasId: 'cvs-done-2', converged: true }),
    ]
    mountTray(makeWidgetSource(SID))

    const button = builtinButton('canvas')
    expect(button.attributes('data-state')).toBe('idle')
    expect(button.find('[data-testid="tray-builtin-pulse"]').exists()).toBe(false)
    expect(button.find('[data-testid="tray-builtin-count"]').exists()).toBe(false)
  })

  it('点击画布按钮 → 面板分流到 TrayCanvasPanel（面板键 native:canvas）', async () => {
    trayState.canvasEntries = [makeCanvas({ canvasId: 'cvs-1' })]
    mountTray(makeWidgetSource(SID))

    await builtinButton('canvas').trigger('click')
    await nextTick()

    expect(panelKeys()).toEqual(['native:canvas'])
    expect(panelContentNodes('tray-canvas-panel')).toHaveLength(1)
    expect(panelContentNodes('tray-native-panel')).toHaveLength(0)
    expect(panelContentNodes('tray-session-panel')).toHaveLength(0)
  })
})

// ── 聚合面板 headerAction 段（demo composer-bar spec §2.1 B3：L2 聚合范围 = 定时任务 + 托盘 →
//    layers 单钮，被聚合 clock 的直开动作由面板首段承接）──

describe('ComposerTray 聚合面板 headerAction 段（B3 聚合范围含定时任务入口）', () => {
  it('有可见声明 → 面板首段渲染 headerAction 按钮（clock 直开入口随聚合走）', async () => {
    headerActionsSwitch.source = makeHeaderActionSource()
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    await openAggregatedPanel()

    // HeaderActionsHost 真组件渲染：scheduler overlay 直开按钮（testid 形态 = 声明 id 派生）
    expect(panelContentNodes('header-action-scheduler-manager-open')).toHaveLength(1)
  })

  it('声明运行时 hidden=true → 首段不渲染（零声明同款，不留死段）', async () => {
    headerActionsSwitch.source = makeHeaderActionSource({ hidden: true })
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    await openAggregatedPanel()

    expect(panelContentNodes('header-action-scheduler-manager-open')).toHaveLength(0)
  })

  it('托盘全无任务条目 + widget 空 + headerAction 有入口 → 聚合入口在场（headerAction 独立可见条件）', () => {
    headerActionsSwitch.source = makeHeaderActionSource()
    // 三态全空托盘（bash/subagent/workflow/session/canvas 全无）+ 空 widget 源
    mountTray(makeWidgetSource(SID), SID, true)

    // D4 隔离后 canvas 件按三态参与（零画布不渲染）——本用例重新获得辨析力：
    // 入口在场只能由 headerAction 贡献解释（canvas 恒渲染豁免已取消）
    expect(row().find('[data-testid="tray-aggregate-button"]').exists()).toBe(true)
  })
})
})

// ═══════════ 来源节：tray-widget ═══════════

describe('tray-widget', () => {
const SID = 's-widget'

function makeMeta(overrides: Partial<WidgetMeta> = {}): WidgetMeta {
  return { title: 'Todo', ...overrides }
}

// ── 组件直挂（按钮 / 面板：props 驱动，无数据源）──

function mountButton(props: {
  viewId: string
  meta?: WidgetMeta
  pinned?: boolean
  expanded?: boolean
}): VueWrapper {
  return mount(TrayWidgetButton, { props })
}

function mountPanel(props: {
  viewId: string
  meta?: WidgetMeta
  guiTree: GuiComponent[]
}): VueWrapper {
  return mount(TrayWidgetPanel, { props })
}

/** 按钮上的 icon 区（状态色断言宿主：状态色挂 icon 容器，便于断言「无状态色类」） */
function iconSpan(wrapper: VueWrapper): DOMWrapper<Element> {
  return wrapper.find('[data-testid="tray-widget-icon"]')
}

// ── widget 区（外壳契约复刻：ViewHostStore 响应式消费方 + 排序 + 按钮/面板组装）──

interface WidgetEntry {
  viewId: string
  entry: ViewCacheEntry
}

/**
 * 外壳契约复刻宿主 = ComposerTray widget 区的最小形态（排序 → 按钮行 → 打开的面板）。
 *
 * 为什么在测试内复刻：本单元领地不含 ComposerTray.vue（归 u-tray-shell），而验收条款 ⑤/⑥
 * （推送后条目重算 / invalidate 后条目消失）必须落在本单元测试。故以同构宿主承载，关键形态
 * 与外壳一致：
 * - entries computed 内**同时**调用 getViewIds（分区键迭代）与 getView（分区值读）——承自已
 *   退役的对话流 widget pill entries 头注契约，拆开即断链；
 * - 面板随「打开 key 仍在 entries 内」渲染（entry 消失 → 面板消失，清屏即摘除）。
 */
const TrayWidgetStrip = defineComponent({
  props: { sessionId: { type: String, required: true } },
  setup(props) {
    const source = inject(VIEW_HOST_SOURCE_KEY, null)
    const openKey = ref<string | null>(null)

    const entries = computed<WidgetEntry[]>(() => {
      if (!source) return []
      return orderTrayWidgetIds(source.getViewIds(props.sessionId))
        .map((viewId) => ({ viewId, entry: source.getView(props.sessionId, viewId) }))
        .filter(
          (e): e is WidgetEntry =>
            e.entry !== undefined && e.entry.guiTree.length > 0,
        )
    })

    return () => {
      const openEntry = entries.value.find((e) => e.viewId === openKey.value)
      const children = entries.value.map((e) =>
        h(TrayWidgetButton, {
          key: e.viewId,
          viewId: e.viewId,
          meta: e.entry.meta,
          pinned: e.viewId === openKey.value,
          expanded: e.viewId === openKey.value,
          onTogglePin: () => {
            openKey.value = openKey.value === e.viewId ? null : e.viewId
          },
        }),
      )
      if (openEntry) {
        children.push(
          h(TrayWidgetPanel, {
            key: `panel-${openEntry.viewId}`,
            viewId: openEntry.viewId,
            meta: openEntry.entry.meta,
            guiTree: openEntry.entry.guiTree,
          }),
        )
      }
      return h(
        'div',
        { 'data-testid': 'tray-widget-strip', 'data-session-id': props.sessionId },
        children,
      )
    }
  },
})

/**
 * 反证宿主（断链形态）：setup 期一次性快照（非 effect 内 → 无依赖收集），
 * 用于钉住「响应式建链」用例不是空断言——断链时推送后条目不重算。
 */
const BrokenStrip = defineComponent({
  setup() {
    const source = inject(VIEW_HOST_SOURCE_KEY, null)
    const frozen: WidgetEntry[] = source
      ? orderTrayWidgetIds(source.getViewIds(SID))
          .map((viewId) => ({ viewId, entry: source.getView(SID, viewId) }))
          .filter((e): e is WidgetEntry => e.entry !== undefined)
      : []
    return () =>
      h(
        'div',
        { 'data-testid': 'tray-widget-strip' },
        frozen.map((e) => h(TrayWidgetButton, { key: e.viewId, viewId: e.viewId, meta: e.entry.meta })),
      )
  },
})

function mountStrip(mock: MockWidgetSource, component = TrayWidgetStrip): VueWrapper {
  return mount(component, {
    props: { sessionId: SID },
    global: { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: mock.source } },
  })
}

/** widget 区按钮的 viewId 序列（用户看到的顺序） */
function stripKeys(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('[data-testid="tray-widget-button"]')
    .map((n) => n.attributes('data-widget-key') ?? '')
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

// ── ① icon fallback 链（D4 四档）──

describe('TrayWidgetButton icon fallback 链（D4）', () => {
  it('档① 自定义 paths（合法）→ 渲染 <path :d>，风格由宿主锁死', () => {
    const wrapper = mountButton({
      viewId: 'todo',
      meta: makeMeta({ icon: { paths: ['M4 6h16', 'M4 12h10'] } }),
    })

    const svg = wrapper.find('[data-testid="tray-widget-icon-paths"]')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('viewBox')).toBe('0 0 24 24')
    expect(svg.attributes('fill')).toBe('none')
    expect(svg.attributes('stroke')).toBe('currentColor')
    expect(svg.attributes('stroke-width')).toBe('1.75')
    expect(svg.attributes('stroke-linecap')).toBe('round')
    expect(svg.attributes('stroke-linejoin')).toBe('round')
    expect(svg.findAll('path').map((p) => p.attributes('d'))).toEqual(['M4 6h16', 'M4 12h10'])
    // 档① 命中即不再下探 lucide 档（即使 viewId 有内置映射）
    expect(wrapper.find('svg.lucide').exists()).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('档② lucide 名解析：registry 命中（拼写归一化：连字符/大小写/下划线同解）', () => {
    const meta = makeMeta({ icon: 'list-checks' })
    expect(mountButton({ viewId: 'w-a', meta }).find('svg.lucide-list-checks').exists()).toBe(true)
    expect(mountButton({ viewId: 'w-b', meta: makeMeta({ icon: 'ListChecks' }) }).find('svg.lucide-list-checks').exists()).toBe(true)
    expect(mountButton({ viewId: 'w-c', meta: makeMeta({ icon: 'list_checks' }) }).find('svg.lucide-list-checks').exists()).toBe(true)
    // 宿主锁死线宽（与档①同 1.75，非 lucide 默认 2）
    expect(mountButton({ viewId: 'w-d', meta }).find('svg.lucide-list-checks').attributes('stroke-width')).toBe('1.75')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('档③ 内置 widgetKey 映射：todo→ListChecks / goal→Target（无 icon 与未知 key 两路注入）', () => {
    const todoBtn = mountButton({ viewId: 'todo', meta: makeMeta() })
    expect(todoBtn.find('svg.lucide-list-checks').exists()).toBe(true)

    const goalBtn = mountButton({ viewId: 'goal', meta: makeMeta({ icon: 'no-such-icon' }) })
    expect(goalBtn.find('svg.lucide-target').exists()).toBe(true)
    // 未知 string key 落内置映射，且 warn 一次（可操作诊断）
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('unknown-key')
    expect(String(warnSpy.mock.calls[0][0])).toContain('goal')
  })

  it('档③ 非法 paths 越限 → 落内置映射 + warn（不崩渲染）', () => {
    // 'e' 与 '>' 均不在白名单字符集内（含 SVG 端点字符时同样拒绝）
    const wrapper = mountButton({
      viewId: 'todo',
      meta: makeMeta({ icon: { paths: ['M4 6h16<script>'] } }),
    })
    expect(wrapper.find('[data-testid="tray-widget-icon-paths"]').exists()).toBe(false)
    expect(wrapper.find('svg.lucide-list-checks').exists()).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('illegal-char')
  })

  it('档③ meta.icon 显式 null（协议可达坏形态）→ 落内置映射 + warn，不崩渲染', () => {
    // icon 类型不含 null，但 wire 上 stripUndefined 只删 undefined 不删 null（第三方独立
    // 安装扩展可达）——归 'not-array' 走兜底链，与非法 paths 同路（协议契约「坏数据不崩渲染」）
    const wrapper = mountButton({
      viewId: 'todo',
      meta: makeMeta({ icon: null as unknown as WidgetMeta['icon'] }),
    })
    expect(wrapper.find('[data-testid="tray-widget-icon-paths"]').exists()).toBe(false)
    expect(wrapper.find('svg.lucide-list-checks').exists()).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('not-array')
  })

  it('档④ 通用兜底：未知 viewId + 未知 key → LayoutGrid（与 view 兜底 icon 同源）', () => {
    const wrapper = mountButton({ viewId: 'custom-note', meta: makeMeta({ icon: 'no-such-icon' }) })
    expect(wrapper.find('svg.lucide-layout-grid').exists()).toBe(true)
  })

  it('warn 去重：同一 viewId 同因坏数据只提示一次（tool call 级重推不刷屏）', async () => {
    const badMeta = makeMeta({ icon: { paths: ['M4 6h16 bad;chars'] } })
    const wrapper = mountButton({ viewId: 'w-dedupe', meta: badMeta })
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // 重推同因坏数据（组件重算）→ 仍只 1 次
    await wrapper.setProps({ meta: makeMeta({ icon: { paths: ['M4 6h16 worse;chars'] } }) })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('脏数据防护：原型链键（viewId/status 为 constructor 类取值）不崩渲染、不取到原型成员', () => {
    // viewId 由 extension 决定（setWidget 第一参数），'constructor' 是合法 widget key——
    // 内置映射表必须是 Map（裸对象下标会取到 Object.prototype.constructor 当组件渲染）
    const protoKey = mountButton({ viewId: 'constructor', meta: makeMeta({ icon: 'unknown' }) })
    expect(protoKey.find('svg.lucide-layout-grid').exists()).toBe(true)

    // status 脏值同理：状态色查表走 switch，脏值落默认（无状态色类），不抛错
    const dirtyStatus: WidgetMeta = { title: 'X', status: 'constructor' as WidgetMeta['status'] }
    const dirty = mountButton({ viewId: 'todo', meta: dirtyStatus })
    expect(iconSpan(dirty).classes()).not.toContain('text-accent')
    expect(iconSpan(dirty).classes()).not.toContain('text-success')
    expect(dirty.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)
  })
})

// ── ② badge fallback 链 + truncate（D4/§3.5）──

describe('TrayWidgetButton badge fallback 链与 truncate（D4/§3.5）', () => {
  it('meta.badge 直用；超长 truncate 至 6 字符，全文进按钮 aria-label 括注（原生 title 退役）', () => {
    const short = mountButton({ viewId: 'todo', meta: makeMeta({ badge: '42%' }) })
    const shortBadge = short.find('[data-testid="tray-widget-badge"]')
    expect(shortBadge.text()).toBe('42%')
    expect(short.find('[data-testid="tray-widget-button"]').attributes('aria-label')).toBe('Todo（42%）')

    const long = mountButton({ viewId: 'todo', meta: makeMeta({ badge: '1234567890' }) })
    const longBadge = long.find('[data-testid="tray-widget-badge"]')
    expect(longBadge.text()).toBe('123456')
    expect(longBadge.text().length).toBe(6)
    expect(long.find('[data-testid="tray-widget-button"]').attributes('aria-label')).toBe('Todo（1234567890）')
  })

  it('badge 缺省 → progress.label；无 label → String(progress.current)', () => {
    const withLabel = mountButton({
      viewId: 'goal',
      meta: makeMeta({ progress: { current: 2, total: 5, label: '2/5' } }),
    })
    expect(withLabel.find('[data-testid="tray-widget-badge"]').text()).toBe('2/5')

    const noLabel = mountButton({
      viewId: 'goal',
      meta: makeMeta({ progress: { current: 42, total: 100 } }),
    })
    expect(noLabel.find('[data-testid="tray-widget-badge"]').text()).toBe('42')
  })

  it('无 badge 且无 progress → 不渲染 badge 元素（归零不虚亮）', () => {
    const wrapper = mountButton({ viewId: 'todo', meta: makeMeta() })
    expect(wrapper.find('[data-testid="tray-widget-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-widget-status"]').exists()).toBe(false)
  })
})

// ── ③ status 视觉（D4）──

describe('TrayWidgetButton status 视觉（D4：running=accent+呼吸点 / done / failed / idle）', () => {
  it('running → accent 色 + 呼吸点元素存在（badge 同色）', () => {
    const wrapper = mountButton({
      viewId: 'todo',
      meta: makeMeta({ status: 'running', badge: '2' }),
    })
    expect(iconSpan(wrapper).classes()).toContain('text-accent')
    expect(wrapper.find('[data-testid="tray-widget-pulse"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tray-widget-badge"]').classes()).toContain('text-accent')
  })

  it('done / failed / idle 各取状态色，且非 running 无呼吸点元素（元素不存在而非隐藏）', () => {
    const done = mountButton({ viewId: 'todo', meta: makeMeta({ status: 'done', badge: '5' }) })
    expect(iconSpan(done).classes()).toContain('text-success')
    expect(done.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)

    const failed = mountButton({ viewId: 'todo', meta: makeMeta({ status: 'failed', badge: '!' }) })
    expect(iconSpan(failed).classes()).toContain('text-danger')
    expect(failed.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)

    const idle = mountButton({ viewId: 'todo', meta: makeMeta({ status: 'idle', badge: '2/5' }) })
    expect(iconSpan(idle).classes()).toContain('text-neutral-dim')
    expect(idle.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)
  })

  it('无 meta（v1 旧 extension）→ 标题回退 viewId、无状态色类、无呼吸点无 badge', () => {
    const wrapper = mountButton({ viewId: 'legacy-widget' })
    const button = wrapper.find('[data-testid="tray-widget-button"]')
    expect(button.attributes('aria-label')).toBe('legacy-widget')
    // 无 status → icon 不挂状态色类（继承按钮中性色：常态 dim、hover 提亮）
    expect(iconSpan(wrapper).classes()).not.toContain('text-accent')
    expect(iconSpan(wrapper).classes()).not.toContain('text-success')
    expect(iconSpan(wrapper).classes()).not.toContain('text-danger')
    expect(button.classes()).toContain('text-neutral-dim')
    expect(wrapper.find('[data-testid="tray-widget-pulse"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tray-widget-badge"]').exists()).toBe(false)
    // 合规路径不刷 warn（A7：无 icon/badge 的旧 widget 正常挂载）
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ── ④ 按钮契约（外壳交互位 + 上抛事件）──

describe('TrayWidgetButton 外壳契约（hover/pin 状态由外壳持有）', () => {
  it('指针进 / 出 icon 上抛 hover-start / hover-end（计时由外壳承担）', async () => {
    const wrapper = mountButton({ viewId: 'todo', meta: makeMeta() })
    const button = wrapper.find('[data-testid="tray-widget-button"]')

    await button.trigger('pointerenter')
    expect(wrapper.emitted('hover-start')).toHaveLength(1)
    expect(wrapper.emitted('hover-end')).toBeUndefined()

    await button.trigger('pointerleave')
    expect(wrapper.emitted('hover-end')).toHaveLength(1)
  })

  it('点击 icon 上抛 toggle-pin（外壳切换 pin）；pinned/expanded 驱动 aria 与提亮', async () => {
    const wrapper = mountButton({ viewId: 'todo', meta: makeMeta() })
    const button = wrapper.find('[data-testid="tray-widget-button"]')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(button.attributes('aria-expanded')).toBe('false')

    await button.trigger('click')
    expect(wrapper.emitted('toggle-pin')).toHaveLength(1)

    await wrapper.setProps({ pinned: true, expanded: true })
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(button.attributes('aria-expanded')).toBe('true')
    expect(button.classes()).toContain('bg-surface-hover')
  })

  it('aria-label 取 meta.title（面板标题同源；原生 title 退役），viewId 落 data-widget-key', () => {
    const wrapper = mountButton({ viewId: 'todo', meta: makeMeta({ title: '待办清单' }) })
    const button = wrapper.find('[data-testid="tray-widget-button"]')
    expect(button.attributes('aria-label')).toBe('待办清单')
    expect(button.attributes('data-widget-key')).toBe('todo')
  })
})

// ── ⑤ 面板（meta head + GuiComponentRenderer 正文）──

describe('TrayWidgetPanel（meta head + guiTree 正文）', () => {
  it('head：标题 + 状态点色 + 进度计数文本 + mini bar 宽度', () => {
    const wrapper = mountPanel({
      viewId: 'todo',
      meta: makeMeta({
        title: 'Todo',
        status: 'running',
        progress: { current: 2, total: 5, label: '2/5' },
      }),
      guiTree: [ansiLine('body line')],
    })

    const panel = wrapper.find('[data-testid="tray-widget-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('data-widget-key')).toBe('todo')
    expect(wrapper.find('[data-testid="tray-widget-panel-title"]').text()).toBe('Todo')
    expect(wrapper.find('[data-testid="tray-widget-panel-dot"]').classes()).toContain('bg-accent')
    expect(wrapper.find('[data-testid="tray-widget-panel-label"]').text()).toBe('2/5')
    const fill = wrapper.find('[data-testid="tray-widget-panel-progress-fill"]')
    expect(fill.attributes('style')).toContain('width: 40%')
    expect(fill.classes()).toContain('bg-accent')
  })

  it('head 进度：label 缺省 → current/total；severity=danger → fill 取 danger', () => {
    const wrapper = mountPanel({
      viewId: 'goal',
      meta: makeMeta({ progress: { current: 95, total: 100, severity: 'danger' } }),
      guiTree: [ansiLine('goal body')],
    })
    expect(wrapper.find('[data-testid="tray-widget-panel-label"]').text()).toBe('95/100')
    expect(wrapper.find('[data-testid="tray-widget-panel-progress-fill"]').classes()).toContain('bg-danger')
  })

  it('[RD-2#8] progress 数值非有限（NaN/Infinity，第三方 widget 脏数据）→ 不渲染 mini bar、计数显「无进度」；extension 自带 label 仍优先', () => {
    // current=NaN：ViewHostStore.narrowMeta 只校验 title，progress 深度字段归本组件把关
    const nanCurrent = mountPanel({
      viewId: 'bad-widget',
      meta: makeMeta({ title: 'Bad', progress: { current: Number.NaN, total: 5 } }),
      guiTree: [ansiLine('x')],
    })
    expect(nanCurrent.find('[data-testid="tray-widget-panel-progress-fill"]').exists()).toBe(false)
    expect(nanCurrent.find('[data-testid="tray-widget-panel-label"]').text()).toBe('无进度')
    nanCurrent.unmount()

    // total=Infinity：旧检查只挡 total<=0（NaN/Infinity 比较恒 false 会漏过 → width:'NaN%'）
    const infTotal = mountPanel({
      viewId: 'bad-widget',
      meta: makeMeta({ progress: { current: 3, total: Number.POSITIVE_INFINITY } }),
      guiTree: [ansiLine('x')],
    })
    expect(infTotal.find('[data-testid="tray-widget-panel-progress-fill"]').exists()).toBe(false)
    expect(infTotal.find('[data-testid="tray-widget-panel-label"]').text()).toBe('无进度')
    infTotal.unmount()

    // label 契约优先：extension 已格式化的 label 不被「无进度」覆盖（数值缺失只影响派生 label/bar）
    const withLabel = mountPanel({
      viewId: 'bad-widget',
      meta: makeMeta({ progress: { current: Number.NaN, total: Number.NaN, label: '42%' } }),
      guiTree: [ansiLine('x')],
    })
    expect(withLabel.find('[data-testid="tray-widget-panel-label"]').text()).toBe('42%')
    expect(withLabel.find('[data-testid="tray-widget-panel-progress-fill"]').exists()).toBe(false)
    withLabel.unmount()
  })

  it('body = GuiComponentRenderer 渲染 guiTree（ansi-text + list-tree 落真实 DOM）', () => {
    const wrapper = mountPanel({
      viewId: 'todo',
      meta: makeMeta(),
      guiTree: [
        ansiLine('head line'),
        { type: 'list-tree', props: { items: [{ label: '写测试', status: 'running' }] } },
      ],
    })

    expect(wrapper.find('[data-testid="ansi-text"]').text()).toContain('head line')
    const tree = wrapper.find('[data-testid="gui-list-tree"]')
    expect(tree.exists()).toBe(true)
    expect(tree.text()).toContain('写测试')
    // 渲染协议容器在场的证据（渲染器 testid 不被子组件覆盖）
    expect(wrapper.findAll('[data-testid="gui-component-renderer"]')).toHaveLength(2)
  })

  it('无 meta（v1 旧 extension）→ 标题回退 viewId、无进度区；guiTree 为空 → 整体零 DOM', () => {
    const legacy = mountPanel({ viewId: 'legacy-widget', guiTree: [ansiLine('x')] })
    expect(legacy.find('[data-testid="tray-widget-panel-title"]').text()).toBe('legacy-widget')
    expect(legacy.find('[data-testid="tray-widget-panel-label"]').exists()).toBe(false)
    expect(legacy.find('[data-testid="tray-widget-panel-progress-fill"]').exists()).toBe(false)
    expect(legacy.find('[data-testid="tray-widget-panel-dot"]').classes()).toContain('bg-neutral-dim')

    const empty = mountPanel({ viewId: 'todo', meta: makeMeta(), guiTree: [] })
    expect(empty.find('[data-testid="tray-widget-panel"]').exists()).toBe(false)
  })
})

// ── ⑥ widget 区依赖追踪（验收 ⑤/⑥：推送重算 / invalidate 消失）──

describe('widget 区依赖追踪（getViewIds + getView 同 computed 路径建链）', () => {
  it('推送新 entry → 新条目出现，且顺序 = known-order 优先（未知 key 随后按插入序）', async () => {
    const mock = makeWidgetSource(SID)
    const wrapper = mountStrip(mock)
    expect(stripKeys(wrapper)).toEqual([])

    mock.push(makeEntry('custom-b', [ansiLine('b')], makeMeta({ title: 'B' })))
    await wrapper.vm.$nextTick()
    mock.push(makeEntry('goal', [ansiLine('g')], makeMeta({ title: 'Goal' })))
    await wrapper.vm.$nextTick()
    mock.push(makeEntry('todo', [ansiLine('t')], makeMeta({ title: 'Todo' })))
    await wrapper.vm.$nextTick()

    // known-order 优先：todo/goal 恒在前（与插入序无关），custom-b 追加其后
    expect(stripKeys(wrapper)).toEqual(['todo', 'goal', 'custom-b'])
    expect(wrapper.find('[data-testid="tray-widget-strip"]').attributes('data-session-id')).toBe(SID)
    expect(wrapper.findAll('[data-testid="tray-widget-button"]')).toHaveLength(3)
  })

  it('推送更新同一 key → 按钮与面板重算（非缓存 stale），面板随 pin 打开', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('v1')], makeMeta({ title: 'Todo', badge: '1' })))
    const wrapper = mountStrip(mock)
    expect(wrapper.find('[data-testid="tray-widget-badge"]').text()).toBe('1')

    mock.push(makeEntry('todo', [ansiLine('v2')], makeMeta({ title: 'Todo', badge: '7' })))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="tray-widget-badge"]').text()).toBe('7')

    // 点 icon → pin → 面板出现（外壳契约：hover/pin 归外壳，本宿主用点击复刻 pin 路径）
    await wrapper.find('[data-testid="tray-widget-button"]').trigger('click')
    const panel = wrapper.find('[data-testid="tray-widget-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.find('[data-testid="ansi-text"]').text()).toContain('v2')

    // 面板打开期间推送更新 → 正文随推送刷新（同 computed 链，非一次性快照）
    mock.push(makeEntry('todo', [ansiLine('v3')], makeMeta({ title: 'Todo', badge: '8' })))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="tray-widget-panel"]').find('[data-testid="ansi-text"]').text()).toContain('v3')
  })

  it('分区在挂载后才建（首帧短路陷阱）→ 推送仍触发重算', async () => {
    // 挂载顺序刻意颠倒：先 mount（此时无分区、无 entry）再首次 push
    const mock = makeWidgetSource(SID)
    const wrapper = mountStrip(mock)
    expect(stripKeys(wrapper)).toEqual([])

    mock.push(makeEntry('todo', [ansiLine('late')], makeMeta({ title: 'Todo' })))
    await wrapper.vm.$nextTick()
    expect(stripKeys(wrapper)).toEqual(['todo'])
  })

  it('清屏（gui:null → invalidate）→ 条目与已打开面板一并消失', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('t')], makeMeta({ title: 'Todo' })))
    mock.push(makeEntry('goal', [ansiLine('g')], makeMeta({ title: 'Goal' })))
    const wrapper = mountStrip(mock)
    await wrapper.find('[data-testid="tray-widget-button"]').trigger('click')
    expect(wrapper.find('[data-testid="tray-widget-panel"]').exists()).toBe(true)

    mock.invalidate('todo')
    await wrapper.vm.$nextTick()

    expect(stripKeys(wrapper)).toEqual(['goal'])
    expect(wrapper.find('[data-testid="tray-widget-panel"]').exists()).toBe(false)
  })

  it('invalidate → 重注册的未知 key 落尾部（「当前插入序」契约在 DOM 上成立）', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('t')], makeMeta()))
    mock.push(makeEntry('goal', [ansiLine('g')], makeMeta()))
    mock.push(makeEntry('alpha', [ansiLine('a')], makeMeta()))
    const wrapper = mountStrip(mock)
    expect(stripKeys(wrapper)).toEqual(['todo', 'goal', 'alpha'])

    mock.invalidate('alpha')
    await wrapper.vm.$nextTick()
    mock.push(makeEntry('alpha', [ansiLine('a2')], makeMeta()))
    await wrapper.vm.$nextTick()

    expect(stripKeys(wrapper)).toEqual(['todo', 'goal', 'alpha'])
    mock.push(makeEntry('beta', [ansiLine('b')], makeMeta()))
    await wrapper.vm.$nextTick()
    // alpha 已是「重注册后的插入序」，beta 后插 → alpha 在前（证明 alpha 确实落到尾部而非原位）
    expect(stripKeys(wrapper)).toEqual(['todo', 'goal', 'alpha', 'beta'])
  })

  it('反证：非响应式快照（断链形态）推送后条目不重算——正例断言不是空断言', async () => {
    const mock = makeWidgetSource(SID)
    mock.push(makeEntry('todo', [ansiLine('t')], makeMeta({ title: 'Todo' })))
    const wrapper = mountStrip(mock, BrokenStrip)
    expect(stripKeys(wrapper)).toEqual(['todo'])

    mock.push(makeEntry('goal', [ansiLine('g')], makeMeta({ title: 'Goal' })))
    await wrapper.vm.$nextTick()

    // setup 期一次性快照不建依赖链 → 新条目不出现（= 断链症状，验收 ⑤ 的反面）
    expect(stripKeys(wrapper)).toEqual(['todo'])
  })
})
})

// ═══════════ 来源节：tray-canvas-panel ═══════════

describe('tray-canvas-panel', () => {
const SID = 's-canvas-panel'

/** 数据面替身（inject 消费点）：reactive 容器供 canvasEntries 变更驱动重算 */
const trayState = reactive({
  bashRunning: [],
  bashEnded: [],
  bashLoaded: true,
  subagentRunning: [],
  subagentEnded: [],
  subagentLoading: false,
  workflowRunning: [],
  workflowEnded: [],
  workflowLoading: false,
  canvasEntries: [] as CanvasListEntry[],
})

const trayFixture: UseTrayCountsReturn = {
  ...makeTrayCountsStub(trayState),
  bashPartition: computed(() => ({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })),
  errors: { subagent: computed(() => null), workflow: computed(() => null) },
  retry: vi.fn().mockResolvedValue(undefined),
}

function makeCanvas(overrides: Partial<CanvasListEntry> & { canvasId: string }): CanvasListEntry {
  return {
    ownerSessionId: SID,
    name: `画布 ${overrides.canvasId}`,
    statement: '示例问题陈述',
    converged: false,
    openMustFix: 0,
    reviewStatus: null,
    ...overrides,
  }
}

let wrapper: VueWrapper | null = null

function mountPanel(pinned = false): VueWrapper {
  wrapper = mount(TrayCanvasPanel, {
    props: { sessionId: SID, pinned },
    global: { provide: { [TRAY_COUNTS_KEY as symbol]: trayFixture } },
  })
  return wrapper
}

/** modal 渲染在 reka portal（document.body）——跨 wrapper 统一从 body 查 */
function bodyQuery(testid: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
}

/**
 * 提交三要素表单：对 form 派发 submit（组件 @submit.prevent 承接）。不用按钮 click——
 * jsdom 不实现「type=submit 按钮 click → form submit」的浏览器派生行为，点按钮只会
 * 消费事件不提交。
 */
function submitForm(): void {
  const form = bodyQuery('tray-canvas-form')
  if (!form) throw new Error('modal form not mounted')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  trayState.canvasEntries = []
  commandMock.mockReset()
  commandMock.mockResolvedValue({ ok: true, eventId: 'ev-1', evType: 'CanvasCreated', summary: '' })
  toastErrorMock.mockClear()
  openCanvasTabMock.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('TrayCanvasPanel 列表渲染与阶段徽标（使用者黑盒 / 观察者）', () => {
  it('渲染画布行：名称 + 阶段徽标 + must-fix 计数 + 段头摘要（计数与行集同源）', async () => {
    trayState.canvasEntries = [
      makeCanvas({ canvasId: 'cvs-grow', name: '多引擎拆分规划', statement: '多引擎支持怎么落地' }),
      makeCanvas({ canvasId: 'cvs-review', openMustFix: 2, reviewStatus: 'in-progress', statement: '另一个问题' }),
      makeCanvas({ canvasId: 'cvs-done', converged: true, statement: '已收敛的问题' }),
    ]
    const panel = mountPanel()
    await flushPromises()

    expect(panel.find('[data-testid="tray-canvas-panel"]').exists()).toBe(true)
    const rows = panel.findAll('[data-testid="tray-canvas-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].attributes('data-canvas-id')).toBe('cvs-grow')
    expect(rows[0].text()).toContain('多引擎拆分规划')
    // 阶段徽标（派生展示值）与 must-fix 计数
    expect(rows[0].text()).toContain(zhTray.tray.canvas.phase.growing)
    expect(rows[1].text()).toContain(zhTray.tray.canvas.phase.reviewing)
    expect(rows[1].find('[data-testid="tray-canvas-mustfix"]').text()).toContain('2')
    expect(rows[2].text()).toContain(zhTray.tray.canvas.phase.converged)
    // 段头摘要（3 张 · 2 进行中——进行中 = 未收敛）
    const header = panel.find('[data-testid="tray-canvas-header"]').text()
    expect(header).toContain('3 张画布')
    expect(header).toContain('2 进行中')
  })

  it('阶段点色语言：生长中 accent、审查中 warn、已收敛 success', async () => {
    trayState.canvasEntries = [
      makeCanvas({ canvasId: 'cvs-grow' }),
      makeCanvas({ canvasId: 'cvs-review', openMustFix: 1 }),
      makeCanvas({ canvasId: 'cvs-done', converged: true }),
    ]
    const panel = mountPanel()
    await flushPromises()

    const dots = panel.findAll('[data-testid="tray-canvas-dot"]')
    expect(dots[0].classes()).toContain('bg-accent')
    expect(dots[1].classes()).toContain('bg-warn')
    expect(dots[2].classes()).toContain('bg-success')
  })

  it('must-fix 归零 → 计数不渲染（归零不虚亮）；审查终态（max-rounds）非 in-progress 不判审查中', async () => {
    trayState.canvasEntries = [
      makeCanvas({ canvasId: 'cvs-clean' }),
      makeCanvas({ canvasId: 'cvs-stuck', reviewStatus: 'max-rounds' }),
    ]
    const panel = mountPanel()
    await flushPromises()

    expect(panel.findAll('[data-testid="tray-canvas-mustfix"]')).toHaveLength(0)
    const rows = panel.findAll('[data-testid="tray-canvas-row"]')
    // max-rounds 有停回说明待用户裁决，但无开放 must-fix 且非 in-progress → 按设计词表落生长中
    expect(rows[1].text()).toContain(zhTray.tray.canvas.phase.growing)
  })

  it('无画布 → 空态提示；「＋ 新建画布」按钮在场（防御性空态不破版）', async () => {
    const panel = mountPanel()
    await flushPromises()

    expect(panel.find('[data-testid="tray-canvas-row"]').exists()).toBe(false)
    expect(panel.find('[data-testid="tray-canvas-empty"]').text()).toContain(zhTray.tray.canvas.empty)
    expect(panel.find('[data-testid="tray-canvas-create"]').exists()).toBe(true)
  })
})

describe('TrayCanvasPanel 行点击打开 overlay（构建者白盒）', () => {
  it('点击行 → openCanvasTab 携该画布 id（renderer 直达入口）', async () => {
    trayState.canvasEntries = [makeCanvas({ canvasId: 'cvs-open-me' })]
    const panel = mountPanel()
    await flushPromises()

    await panel.find('[data-testid="tray-canvas-row"]').trigger('click')
    expect(openCanvasTabMock).toHaveBeenCalledTimes(1)
    // 载荷带归属 sessionId（D4：overlay 级联判定 + CanvasPane per-session 分区的键）
    expect(openCanvasTabMock).toHaveBeenCalledWith('cvs-open-me', SID)
  })
})

describe('TrayCanvasPanel 三要素 modal（缺一拒绝 = 不变量 1 前置校验）', () => {
  async function openModal(): Promise<void> {
    const panel = mountPanel()
    await flushPromises()
    await panel.find('[data-testid="tray-canvas-create"]').trigger('click')
    await flushPromises()
  }

  it('「＋ 新建画布」→ modal 出现（标题 + 三字段 + 提交按钮）', async () => {
    await openModal()

    expect(bodyQuery('tray-canvas-statement')).not.toBeNull()
    expect(bodyQuery('tray-canvas-criterias')).not.toBeNull()
    expect(bodyQuery('tray-canvas-scope')).not.toBeNull()
    expect(bodyQuery('tray-canvas-submit')).not.toBeNull()
  })

  it('全空提交 → 拒绝文案逐项指明三处缺失，不发 mutate，modal 保持', async () => {
    await openModal()

    submitForm()
    await flushPromises()

    const err = bodyQuery('tray-canvas-form-error')
    expect(err).not.toBeNull()
    expect(err!.textContent).toContain(zhTray.tray.canvas.form.statement)
    expect(err!.textContent).toContain(zhTray.tray.canvas.form.criterias)
    expect(err!.textContent).toContain(zhTray.tray.canvas.form.scopeExclusions)
    expect(commandMock).not.toHaveBeenCalled()
    // modal 保持（用户可就地补全）
    expect(bodyQuery('tray-canvas-submit')).not.toBeNull()
  })

  it('缺一拒绝（逐项）：只缺完成判据 → 文案只指明判据，statement / scope 已填不发 mutate', async () => {
    await openModal()

    const statement = bodyQuery('tray-canvas-statement') as HTMLInputElement
    statement.value = '多引擎支持怎么落地'
    statement.dispatchEvent(new Event('input', { bubbles: true }))
    const scope = bodyQuery('tray-canvas-scope') as HTMLTextAreaElement
    scope.value = '不改 provider 抽象层'
    scope.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    submitForm()
    await flushPromises()

    const err = bodyQuery('tray-canvas-form-error')
    expect(err).not.toBeNull()
    expect(err!.textContent).not.toContain(zhTray.tray.canvas.form.statement)
    expect(err!.textContent).toContain(zhTray.tray.canvas.form.criterias)
    expect(err!.textContent).not.toContain(zhTray.tray.canvas.form.scopeExclusions)
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('判据/排除项全空行视为缺失（每行一条口径：trim 后空行不计）', async () => {
    await openModal()

    const statement = bodyQuery('tray-canvas-statement') as HTMLInputElement
    statement.value = '多引擎支持怎么落地'
    statement.dispatchEvent(new Event('input', { bubbles: true }))
    const criterias = bodyQuery('tray-canvas-criterias') as HTMLTextAreaElement
    criterias.value = '  \n  '
    criterias.dispatchEvent(new Event('input', { bubbles: true }))
    const scope = bodyQuery('tray-canvas-scope') as HTMLTextAreaElement
    scope.value = '不改 provider 抽象层'
    scope.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    submitForm()
    await flushPromises()

    expect(bodyQuery('tray-canvas-form-error')).not.toBeNull()
    expect(commandMock).not.toHaveBeenCalled()
  })

  it('三要素齐全 → mutate(actor=user, action=create) 携三要素行集；成功后 modal 关闭', async () => {
    await openModal()

    const statement = bodyQuery('tray-canvas-statement') as HTMLInputElement
    statement.value = '  多引擎支持怎么落地  '
    statement.dispatchEvent(new Event('input', { bubbles: true }))
    const criterias = bodyQuery('tray-canvas-criterias') as HTMLTextAreaElement
    criterias.value = '两条 provider 并存可切\n切换零消息丢失'
    criterias.dispatchEvent(new Event('input', { bubbles: true }))
    const scope = bodyQuery('tray-canvas-scope') as HTMLTextAreaElement
    scope.value = '不改 provider 抽象层\n不动 pi 上游'
    scope.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    submitForm()
    await flushPromises()

    expect(commandMock).toHaveBeenCalledTimes(1)
    expect(commandMock).toHaveBeenCalledWith('canvas.mutate', {
      actor: 'user',
      sessionId: SID,
      action: 'create',
      params: {
        statement: '多引擎支持怎么落地',
        criterias: ['两条 provider 并存可切', '切换零消息丢失'],
        scopeExclusions: ['不改 provider 抽象层', '不动 pi 上游'],
      },
    }, expect.any(Number))
    // 成功 → modal 关（画布唤起由 use-canvas-sync 的 CanvasCreated 广播链承接，本面板零接线）
    expect(bodyQuery('tray-canvas-submit')).toBeNull()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('mutate 结构化失败（ok=false）→ toast 呈现 message + recover，modal 保持可改', async () => {
    commandMock.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_params', message: '根问题陈述（statement）为空', recover: '修正字段后重试' },
    })
    await openModal()

    const statement = bodyQuery('tray-canvas-statement') as HTMLInputElement
    statement.value = '多引擎支持怎么落地'
    statement.dispatchEvent(new Event('input', { bubbles: true }))
    const criterias = bodyQuery('tray-canvas-criterias') as HTMLTextAreaElement
    criterias.value = '判据一'
    criterias.dispatchEvent(new Event('input', { bubbles: true }))
    const scope = bodyQuery('tray-canvas-scope') as HTMLTextAreaElement
    scope.value = '排除项一'
    scope.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()

    submitForm()
    await flushPromises()

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock.mock.calls[0][0]).toContain('根问题陈述（statement）为空')
    expect(toastErrorMock.mock.calls[0][0]).toContain('修正字段后重试')
    // 失败 → modal 保持（用户可改后重试）
    expect(bodyQuery('tray-canvas-submit')).not.toBeNull()
  })
})
})

