/**
 * ComposerTray 外壳测试（u-tray-shell，设计 docs/design/composer-task-tray.md
 * §3.3 D1/D6/D7/D8/D9/D12 + §3.1 场景 A/C + §3.4 终态数据流）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：每条用例至少一个用户可见断言——三态按钮（计数/呼吸点元素存在性而非
 *   opacity:0）、hover/pin 后浮层出现与消失、面板内容分流（built-in 行内操作随 pin 出现）；
 * - 观察者（形态）：同一时刻至多一个面板（data-panel-key 集合恒 ≤1）、清屏后条目与面板一并
 *   消失且 pin 不诈尸、切 session 不残留旧交互态；
 * - 构建者（白盒）：160ms 开 / 240ms 收的计时边界（fake timers 精确推进）、pin 三解除路径、
 *   pinned 透传（hover 态无行内按钮 = false；pin 后有 = true——「必须显式透传」契约的可证伪断言）。
 *
 * mock 策略：
 * - `useTrayCounts` 替身（默认 fixture 模式）：三件计数/行集直接注入（口径与首拉触发另有
 *   useTrayCounts.test.ts），本文件只验外壳三态判定与交互；`useReal` 模式透传真实现——
 *   U1 用例需要真实拉取腿可被 spy 计数（「面板开关不重发首拉 RPC」）。
 * - **真实** TrayNativePanel / TrayWidgetPanel：面板分流与 pinned 透传必须经真实组件落地
 *   （stub 会把「必须显式透传 pinned」测成空断言）；面板数据面经 TRAY_COUNTS_KEY 消费外壳实例
 *   （U1），故 `useTrayCounts` 替身的调用次数 = 数据面实例数（> 1 即面板自建第二实例）。
 * - `VIEW_HOST_SOURCE_KEY` provide 响应式 mock（同构壳层桥：shallowReactive 外层分区 Map +
 *   reactive 内层分区 Map）——推送/更新/清屏直接改分区即驱动重算；
 * - `useBackgroundTasks` mock：仅 U1 的真实数据面用例会消费（避免真实 list RPC / 物理订阅）；
 * - 真实 pinia（面板内 store 依赖）+ vue-i18n 走全局 setup（断言 zh-CN 文案）。
 *
 * timer 说明：vi.useFakeTimers({ now: FIXED_NOW })——160/240ms 边界要精确推进；reka 的
 * 「层外 pointerdown 监听延迟注册（setTimeout 0）」也随假时钟推进后才生效（点外解除用例）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/tray/composer-tray.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { computed, nextTick, reactive } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import { ansiLine, makeEntry, makeWidgetSource } from './tray-view-host-mock'
import type { MockWidgetSource } from './tray-view-host-mock'
import { makeTrayCountsStub } from './tray-counts-stub'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import ComposerTray from '@/components/panel/tray/ComposerTray.vue'
import type { TrayBuiltinKind as TrayKind, UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import { useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import type { SessionSummary, SubagentRecord, WorkflowRunRecord } from '@taiji/shared'
import zhTray from '@/i18n/locales/zh-CN/tray'

// ── mock：数据面（三件计数/行集；口径与首拉触发在 useTrayCounts.test.ts）──
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
  }
}

/** reactive 容器（字段变更驱动下游 computed；对象本身恒不替换，防 computed 依赖失联） */
const trayState = reactive<TrayState>(createTrayState())

/**
 * 数据面替身/透传开关（U1）：`calls` = useTrayCounts 调用次数 = 数据面实例创建次数——外壳
 * 只创建唯一实例并 provide，面板 inject 消费，故任意开合次数下都应恒为 1；`useReal` 打开时
 * 透传真实现（U1 用例用真实拉取腿 + spy 断言不重发首拉）。
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

/** fixture 数据面（计数/行集由 trayState 注入；`UseTrayCountsReturn` 类型标注 = 契约漂移门） */
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

// ── mock：打开链（第 4 件 session 面板行点击 → selectSession；真实 useSidebar 依赖重，替身即可）──
const selectSessionMock = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>())
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: selectSessionMock }),
}))

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
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 0,
    spawnSource: 'agent',
    parentAgentSessionId: SID,
    ...overrides,
  }
}

// ── widget 区响应式数据源 mock（同构壳层桥；与 tray-widget.test.ts 共用 tray-view-host-mock）──

// ── 挂载与查询工具 ──

let wrapper: VueWrapper | null = null

function mountTray(mock: MockWidgetSource, sessionId = SID, aggregated = false): VueWrapper {
  wrapper = mount(ComposerTray, {
    props: { sessionId, aggregated },
    global: { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: mock.source } },
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

beforeEach(() => {
  setActivePinia(createPinia())
  Object.assign(trayState, createTrayState())
  trayCountsSwitch.useReal = false
  trayCountsSwitch.calls = 0
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
  it('全无记录 → 三按钮都不渲染（DOM 层不存在，而非 opacity:0）', () => {
    mountTray(makeWidgetSource(SID))

    expect(row().find('[data-testid="composer-tray"]').exists()).toBe(true)
    expect(row().findAll('[data-testid="tray-builtin-button"]')).toHaveLength(0)
    // 托盘行本身仍在（挂载点可见，只是无条目=零视觉噪音）
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
      // 标题/aria 复用 panel.tray.title.*（icon 可识别性不依赖计数）
      expect(button.attributes('title')).toBe(zhTray.tray.title[kind])
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
    // 亮态色（accent 系，非 dim）——归零不虚亮与「有进行中必亮」两面
    expect(button.find('[data-testid="tray-builtin-count"]').classes()).toContain('text-accent')
    expect(button.find('[data-testid="tray-builtin-pulse"]').classes()).toContain('bg-accent')
    // 只有有进行中的那一件变亮，其余仍 dim 常驻
    expect(builtinButton('subagent').attributes('data-state')).toBe('idle')
  })

  it('三态混合：进行中件亮、仅历史件 dim、无记录件不渲染（同屏）', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1' })]
    mountTray(makeWidgetSource(SID))

    // workflow 无记录 → 不渲染；bash 亮；subagent dim
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

    // 结构不变量：p-1.5 必须在挂 pointerenter 的面板节点上（= 覆盖浮层全幅），
    // 留在浮层根上就会形成一圈不会取消收起计时的缺口（U3 根因）
    const panel = layerNode()
    expect(panel.className).toContain('p-1.5')
    expect(panelLayerNode().className).not.toContain('p-1.5')

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
    // built-in 三件仍恒在最左（固定序不参与动态排序）
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
    expect(panel.className).toContain('p-1.5')
    expect(panelLayerNode().className).not.toContain('p-1.5')

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

    // 该 session 的 bash 记录归零（列表清空）→ 按钮摘除、面板同批作废
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

  it('无 VIEW_HOST_SOURCE 时（未 provide）只渲染 built-in 三件，不抛错', () => {
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

// ── ⑦ 数据面单例与首帧（U1/U2；真实 useTrayCounts + spy 拉取腿）──

describe('ComposerTray 数据面单例（U1：面板不自建实例、开合不重发首拉 RPC）', () => {
  it('面板打开/关闭/换件/重开：数据面实例恒一个、loadSubagents / loadWorkflows 各仅一次', async () => {
    // 真实数据面（外壳仍是唯一调用点）+ spy 拉取腿：断言的是 load RPC 次数，不是替身内部行为
    trayCountsSwitch.useReal = true
    const subagentStore = useSubagentStore()
    const workflowStore = useWorkflowStore()
    const loadSubSpy = vi.spyOn(subagentStore, 'loadSubagents').mockResolvedValue(undefined)
    const loadWfSpy = vi.spyOn(workflowStore, 'loadWorkflows').mockResolvedValue(undefined)
    // 拉取腿被替身 → 数据直接种入分区（外壳三态与面板行集都读同一分区）
    subagentStore.applyRecords(SID, [makeSubagent({ subagentId: 'sa-1', status: 'running' })])
    workflowStore.applyRecords(SID, [makeWorkflow({ runId: 'wf-1', status: 'running' })])

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

    // 关闭 → 换另一件打开（旧面板卸载）→ 再关再开：每次重挂都不得重发首拉
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

  it('bash：从未成功 list 过但有广播投递的任务 → 直出列表（loading 只吞「无数据的真首拉」）', async () => {
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
  it('aggregated + 有进行中条目 → 单入口按钮（层叠图标 + 运行数），逐件按钮不再渲染', () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' }), makeTask({ taskId: 'bt-2' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1', status: 'completed' })]
    mountTray(makeWidgetSource(SID), SID, true)

    const aggregate = row().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)
    // 层叠图标：两个类别 icon（bash + subagent）重叠于入口内
    expect(aggregate.findAll('svg').length).toBeGreaterThanOrEqual(2)
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
    mountTray(makeWidgetSource(SID), SID, true)

    await realClick(row().find('[data-testid="tray-aggregate-button"]'))

    expect(panelKeys()).toEqual(['aggregate'])
    expect(panelContentNodes('tray-aggregate-panel')).toHaveLength(1)
    // 段 = 有记录的类别（bash + workflow），全无记录的类别不出段
    expect(panelContentNodes('tray-aggregate-section-bash')).toHaveLength(1)
    expect(panelContentNodes('tray-aggregate-section-workflow')).toHaveLength(1)
    expect(panelContentNodes('tray-aggregate-section-subagent')).toHaveLength(0)
    const bashCount = panelNodes()[0]?.querySelector('[data-testid="tray-aggregate-count-bash"]')
    expect(bashCount?.textContent).toBe('1/2')
    // 段体复用真实 built-in 面板（行渲染/行内操作零复制）
    expect(panelContentNodes('tray-native-panel')).toHaveLength(2)
  })

  it('aggregated + 全无条目（三态之「全无」）→ 聚合入口不渲染（无死入口）', () => {
    mountTray(makeWidgetSource(SID), SID, true)

    expect(row().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
    expect(row().findAll('[data-testid="tray-builtin-button"]')).toHaveLength(0)
  })

  it('widget-only（无 built-in 记录）→ 聚合入口仍渲染（通用图标兜底）且面板含 widget 段', async () => {
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

  it('三态上抛（能力标志 hasTrayItems）：有面无面各上报一次', () => {
    mountTray(makeWidgetSource(SID), SID, true)
    expect(row().emitted('update:hasItems')).toEqual([[false]])

    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID), SID, true)
    expect(row().emitted('update:hasItems')).toEqual([[true]])
  })
})

// ── ①b 第 4 件「子会话」（u7 / 设计 .tmp/tech-design/mode-system-composer-density.md §6.7 D7）──

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
    expect(button.attributes('title')).toBe(zhTray.tray.title.session)
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

  it('全无子会话 → 该件不渲染（三态之「全无」；DOM 层不存在）', () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    mountTray(makeWidgetSource(SID))

    expect(builtinButton('session').exists()).toBe(false)
    expect(builtinKinds()).toEqual(['bash'])
  })

  it('固定序末位：bash → subagent → workflow → session（不参与 widget 动态排序）', () => {
    trayState.bashEnded = [makeTask({ taskId: 'bt-e1', state: 'exited', reason: 'natural' })]
    trayState.subagentEnded = [makeSubagent({ subagentId: 'sa-e1', status: 'completed' })]
    trayState.workflowEnded = [makeWorkflow({ runId: 'wf-e1' })]
    trayState.sessionChildren = [makeChild({ id: 'c-1', status: 'done' })]
    mountTray(makeWidgetSource(SID))

    expect(builtinKinds()).toEqual(['bash', 'subagent', 'workflow', 'session'])
  })

  it('聚合入口共存（序 4）：聚合面板含 session 段，且段内复用 TraySessionPanel', async () => {
    trayState.bashRunning = [makeTask({ taskId: 'bt-1' })]
    trayState.sessionChildren = [makeChild({ id: 'c-1', status: 'active' })]
    mountTray(makeWidgetSource(SID), SID, true)

    await realClick(row().find('[data-testid="tray-aggregate-button"]'))
    expect(panelKeys()).toEqual(['aggregate'])
    expect(panelContentNodes('tray-aggregate-section-session')).toHaveLength(1)
    expect(panelContentNodes('tray-session-panel')).toHaveLength(1)
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
    // bash 1 + session 1 = 2
    expect(row().find('[data-testid="tray-aggregate-count"]').text()).toBe('2')
  })
})
