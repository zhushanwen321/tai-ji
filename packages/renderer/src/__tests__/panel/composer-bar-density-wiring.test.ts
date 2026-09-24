/**
 * Composer 底栏密度接线测试（D6 修订「三步聚合」版）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - 使用者（黑盒）：① 实测溢出逐级触发 左簇聚合 → 指标聚合 → 模型+思考聚合（累计）；
 *   ② 锚点保护：顶格仍溢出 → 中部让位，`+` 与发送按钮恒在且为首末按钮（零裁剪）；
 *   ③ 不留死入口：托盘全无 + 插件零贡献 → 无聚合入口；`»` Ellipsis 菜单在任何状态都不出现（退役回归）。
 * - 观察者（形态）：底栏 `flex-nowrap`（永不换行）+ 三簇结构；`data-fit` / `data-slot-*` /
 *   `data-anchor-protected` 以状态机输出为准；**bar 内永不出现 88/56px 截断 class**（模型名零截断，
 *   S4 构造性回归防线）。
 * - 构建者（白盒）：ResizeObserver 实测驱动 fit 收敛（逐级收紧到放得下 / 顶格保护 / 变宽放松回
 *   / 同宽不抖 / 卸载断开）；状态机判据本体在 composer-density.test.ts（穷举），此处只证
 *   「实测 → 状态机 → DOM」链路导通。
 *
 * 策略：
 * - `useTrayCounts` 替身（托盘三态计数注入）——真 ComposerTray 渲染，聚合入口是真实组件；
 * - `VIEW_HOST_SOURCE_KEY` provide（插件 toolbar 贡献面：有 entry → 贡献数 1）；`getViewIds` 返回空
 *   （该 mock 只服务挂载点查询，不冒充 widget 区条目）；
 * - `ManualResizeObserverStub`（`../effects/_virtua-mock-helper` 定稿件）确定性派发；
 * - 真 pinia + 真 chat store（与 composer-send-button-states 同范式），mock useChat / useNewTaskFlow /
 *   api / session store；ComposerInput 与重子组件 stub（聚合组件 stub 带契约 testid——
 *   断言「哪个组件被挂载」，组件内部行为归各自组件测试）。
 *
 * [HISTORICAL] 旧版用例断言的 data-tier 三档（640/520 阈值）、data-slot-capacity/model merged、
 * `composer-overflow-menu` / `composer-capacity-merged` / `composer-model-merged` testid、
 * 合流发丝分隔（separatorsInBar）已随三步聚合击败的旧语义删除。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-bar-density-wiring.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, nextTick, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import type { ViewCacheEntry, ViewHostSource } from '@taiji/ui/extension-host'
import { ManualResizeObserverStub } from '../effects/_virtua-mock-helper'
import {
  dispatchFitGeometry as stubFitGeometry,
  makeMountPointSource as makeHelperSource,
  toolbarEntry,
} from './_density-geometry-helper'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import Composer from '@/components/panel/Composer.vue'

// ── 托盘三态替身：计数可注入（数组型行集对本文件无消费方，恒空）──
// state = mock 工厂挂载的 reactive 计数（挂载前 null）：mount 前定值与 mount 后中途变更
// （归零→恢复 emitter 存活链用例）都经 setTrayCounts 写同一 proxy，驱动 counts 重算。
const trayFixture = vi.hoisted(() => ({
  state: null as { bashRunning: number; subagentRunning: number } | null,
}))

vi.mock('@/components/panel/tray/useTrayCounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/panel/tray/useTrayCounts')>()
  const { computed, reactive } = await import('vue')
  const state = reactive({ bashRunning: 2, subagentRunning: 1 })
  trayFixture.state = state
  const emptyList = (): ReturnType<typeof computed<never[]>> => computed(() => [])
  return {
    ...actual,
    useTrayCounts: (): UseTrayCountsReturn => ({
      counts: computed(() => ({
        bash: { running: state.bashRunning, ended: 0, total: state.bashRunning },
        subagent: { running: state.subagentRunning, ended: 0, total: state.subagentRunning },
        workflow: { running: 0, ended: 0, total: 0 },
        // u7 第 4 件：本文件不验 session 件（无子会话 → 该件不渲染），恒 0
        session: { running: 0, ended: 0, total: 0 },
      })),
      lists: {
        bash: { running: emptyList(), ended: emptyList() },
        subagent: { running: emptyList(), ended: emptyList() },
        workflow: { running: emptyList(), ended: emptyList() },
        session: { children: emptyList() },
      },
      bashPartition: computed(() => ({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })),
      errors: { subagent: computed(() => null), workflow: computed(() => null) },
      loading: {
        bash: computed(() => false),
        subagent: computed(() => false),
        workflow: computed(() => false),
      },
      retry: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

// ── chat / flow / api / session store mock（composer-send-button-states 同范式）──
const chatApiMock = vi.hoisted(() => ({
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
  sendBash: vi.fn(() => Promise.resolve()),
  abortBash: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/composables/features/chat/useChat', () => ({ useChat: () => chatApiMock }))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    submitFirstMessage: vi.fn(),
    currentModel: { value: null },
    setPendingModel: vi.fn(),
    currentCwd: ref(null),
  }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: { send: chatApiMock.send, steer: chatApiMock.steer, streamSubscribe: vi.fn(() => () => {}) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  config: { getGlobalSkills: vi.fn().mockResolvedValue([]), getProjectSkills: vi.fn().mockResolvedValue([]), onSkillCacheInvalidated: () => () => {} },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── 子组件 stub（ComposerInput 保留 mock：testid 断言沿用既有范式）──
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: { input: (val: string) => { lastInputText.value = val; return true }, keydown: null, 'slash-trigger': null, 'file-trigger': null },
  setup(_, { expose }) {
    expose({ clear: vi.fn(), setText: vi.fn(), insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value) })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})
const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
/** 聚合组件 stub（契约 testid = 组件级测试约定值；断言「哪个组件被挂载」） */
const MetricsAggregateStub = defineComponent({
  name: 'ComposerMetricsAggregate',
  template: '<div data-testid="composer-metrics-aggregate" />',
})
const ModelThinkingAggregateStub = defineComponent({
  name: 'ModelThinkingAggregate',
  template: '<div data-testid="composer-model-thinking-aggregate" />',
})
const stubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  // AddMenuPopover 保持真实：序 0 的 `+` 是「不退化」断言对象（trigger 带 title）
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  GenStatsTriggers: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  ComposerMetricsAggregate: MetricsAggregateStub,
  ModelThinkingAggregate: ModelThinkingAggregateStub,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

const SID = 's-density'

/**
 * 挂载点数据源替身（几何 helper 单份替身的本文件绑 SID 形态）。
 */
function makeMountPointSource(partition: Map<string, ViewCacheEntry>): ViewHostSource {
  return makeHelperSource(SID, partition)
}

let wrapper: VueWrapper | null = null

function mountComposer(source: ViewHostSource | null): VueWrapper {
  wrapper = mount(Composer, {
    props: { sessionId: SID },
    global: {
      stubs,
      ...(source ? { provide: { [VIEW_HOST_SOURCE_KEY as symbol]: source } } : {}),
    },
  })
  return wrapper
}

/** 底栏容器 */
function bar(): VueWrapper {
  if (!wrapper) throw new Error('composer not mounted')
  const node = wrapper.find('[data-testid="composer-bar"]')
  if (!node.exists()) throw new Error('composer-bar missing')
  return node
}

/** 派发一次 ResizeObserver 回调（触发测量 pass）+ 等重渲染 */
async function dispatchTick(): Promise<void> {
  const observer = ManualResizeObserverStub.created()[0]
  if (!observer) throw new Error('ResizeObserver 未创建：密度接线未挂载')
  observer.dispatch([{ contentRect: { width: 0 } as DOMRectReadOnly }])
  await nextTick()
}

/** 等 fit 收敛回路跑完（helper 单份；本文件调用点见 dispatchFitGeometry） */

/**
 * 打桩底栏几何并派发 RO：真差异（从 Composer wrapper 查三簇节点）留本文件，
 * 打桩 + 派发 + rAF 排空同构本体在 `_density-geometry-helper` 单份。
 */
async function dispatchFitGeometry(
  avail: number,
  left: number,
  widthByFit: Record<string, number>,
): Promise<void> {
  const barEl = bar().element as HTMLElement
  const leftEl = barEl.querySelector<HTMLElement>('[data-composer-cluster="left"]')
  const rightEl = barEl.querySelector<HTMLElement>('[data-composer-cluster="right"]')
  if (!leftEl || !rightEl) throw new Error('底栏两簇节点缺失：模板与 fit 回路不同步？')
  await stubFitGeometry({ bar: barEl, left: leftEl, right: rightEl }, avail, left, widthByFit)
}

/** 底栏首/末按钮（序 0 锚点断言用） */
function firstButtonTitle(): string | undefined {
  return bar().findAll('button')[0]?.attributes('title')
}
function lastButtonTitle(): string | undefined {
  const buttons = bar().findAll('button')
  return buttons[buttons.length - 1]?.attributes('title')
}

/** 写托盘计数（响应式 state：mount 前定值与 mount 后中途变更同口） */
function setTrayCounts(bashRunning: number, subagentRunning: number): void {
  const state = trayFixture.state
  if (!state) throw new Error('tray fixture state 未初始化：useTrayCounts mock 工厂未执行')
  state.bashRunning = bashRunning
  state.subagentRunning = subagentRunning
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
  setTrayCounts(2, 1)
  ManualResizeObserverStub.install()
})

afterEach(() => {
  ManualResizeObserverStub.uninstall()
  wrapper?.unmount()
  wrapper = null
})

describe('底栏三簇与永不换行（D6 硬约束）', () => {
  it('底栏 flex-nowrap：宽度不足只退化形态，不换行', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchTick()
    expect(bar().classes()).toContain('flex-nowrap')
    expect(bar().classes()).not.toContain('flex-wrap')
    // 双轴旧语义构造性不存在
    expect(bar().attributes('data-tier')).toBeUndefined()
  })
})

describe('三步聚合：实测溢出 → 状态机 → DOM（累计，左簇 → 指标 → 模型）', () => {
  it('放得下 → fit 0 全展开：托盘逐件按钮在、无任何聚合入口', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchFitGeometry(800, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-fit')).toBe('0')
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
    expect(bar().attributes('data-slot-metrics')).toBe('expanded')
    expect(bar().attributes('data-slot-model-thinking')).toBe('expanded')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
    expect(bar().findAll('[data-testid="tray-builtin-button"]').length).toBeGreaterThanOrEqual(2)
    expect(bar().find('[data-testid="composer-metrics-aggregate"]').exists()).toBe(false)
    expect(bar().find('[data-testid="composer-model-thinking-aggregate"]').exists()).toBe(false)
  })

  it('L1 收缩停级 → 左簇聚合（托盘单入口 + 运行数），指标/模型仍展开', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    // L0 需求 80+500=580 > 400；L1 需求 80+300=380 ≤ 400 → 停在 L1
    await dispatchFitGeometry(400, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('1')
    expect(bar().attributes('data-slot-left-cluster')).toBe('aggregated')
    const aggregate = bar().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)
    expect(aggregate.find('[data-testid="tray-aggregate-count"]').text()).toBe('3')
    expect(bar().findAll('[data-testid="tray-builtin-button"]')).toHaveLength(0)
    // 序 2/3 未触发
    expect(bar().attributes('data-slot-metrics')).toBe('expanded')
    expect(bar().attributes('data-slot-model-thinking')).toBe('expanded')
  })

  it('L2 → 指标聚合（单图标聚合组件挂载），模型仍完整形态', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    // L0 580 > 300；L1 380 > 300；L2 260 ≤ 300 → 停在 L2
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('2')
    expect(bar().attributes('data-slot-left-cluster')).toBe('aggregated')
    expect(bar().attributes('data-slot-metrics')).toBe('aggregated')
    expect(bar().find('[data-testid="composer-metrics-aggregate"]').exists()).toBe(true)
    expect(bar().attributes('data-slot-model-thinking')).toBe('expanded')
    expect(bar().find('[data-testid="composer-model-thinking-aggregate"]').exists()).toBe(false)
  })

  it('L3 顶格 → 模型+思考聚合（三步全生效）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    // 所有级别都放不下 → 顶格 L3（且 demand 仍 > avail → 进锚点保护，见下个 describe）
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 400, 2: 350, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('3')
    expect(bar().attributes('data-slot-model-thinking')).toBe('aggregated')
    expect(bar().find('[data-testid="composer-model-thinking-aggregate"]').exists()).toBe(true)
  })
})

describe('锚点保护：顶格仍放不下 → 中部让位，锚点零裁剪（S1）', () => {
  it('持续溢出 → data-anchor-protected，左簇/指标让位，模型聚合按钮与 `+`/发送恒在', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 500, 2: 500, 3: 500 })
    expect(bar().attributes('data-fit')).toBe('3')
    expect(bar().attributes('data-anchor-protected')).toBe('true')
    // 中部让位：左簇与指标不渲染（无死入口）
    expect(bar().attributes('data-slot-left-cluster')).toBe('absent')
    expect(bar().attributes('data-slot-metrics')).toBe('absent')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
    expect(bar().find('[data-testid="composer-metrics-aggregate"]').exists()).toBe(false)
    // 模型入口 + 序 0 锚点恒在
    expect(bar().attributes('data-slot-model-thinking')).toBe('aggregated')
    expect(firstButtonTitle()).toBe('添加内容（附件 / 命令）')
    expect(lastButtonTitle()).toContain('发送')
  })

  it('窗口放宽 → 解除保护并逐级降回全展开', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 400, 2: 350, 3: 320 })
    expect(bar().attributes('data-anchor-protected')).toBe('true')
    // 放宽到 600（L0 需求 380 ≤ 600）→ 解保护 + 连续降级到 0
    await dispatchFitGeometry(600, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-anchor-protected')).toBeUndefined()
    expect(bar().attributes('data-fit')).toBe('0')
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
    expect(bar().attributes('data-slot-metrics')).toBe('expanded')
  })
})

describe('S4 模型名零截断 + `»` 退役（构造性回归防线）', () => {
  it('任意宽度矩阵下 bar 内永不出现 88/56px 截断 class（模型名非聚合态恒完整）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    const matrix: Array<[number, Record<string, number>]> = [
      [800, { 0: 300, 1: 200, 2: 150, 3: 120 }],
      [400, { 0: 500, 1: 300, 2: 180, 3: 100 }],
      [300, { 0: 500, 1: 500, 2: 500, 3: 500 }],
    ]
    for (const [avail, widths] of matrix) {
      await dispatchFitGeometry(avail, 80, widths)
      const html = bar().html()
      expect(html).not.toContain('max-w-[88px]')
      expect(html).not.toContain('max-w-[56px]')
    }
  })

  it('任何状态（含插件有贡献 + 强制溢出）都不出现 `»` Ellipsis 溢出菜单（退役）', async () => {
    const partition = reactive(new Map<string, ViewCacheEntry>([['composer.toolbar', toolbarEntry()]]))
    mountComposer(makeMountPointSource(partition))
    const matrix: Array<[number, Record<string, number>]> = [
      [800, { 0: 300, 1: 200, 2: 150, 3: 120 }],
      [400, { 0: 500, 1: 300, 2: 180, 3: 100 }],
      [300, { 0: 500, 1: 500, 2: 500, 3: 500 }],
    ]
    for (const [avail, widths] of matrix) {
      await dispatchFitGeometry(avail, 80, widths)
      expect(bar().find('[data-testid="composer-overflow-menu"]').exists()).toBe(false)
      expect(bar().find('[data-testid="composer-overflow-capacity-metrics"]').exists()).toBe(false)
    }
    // 插件有贡献 + 展开态：左簇仍是散图标路径（挂载点内联），无 `»`
    await dispatchFitGeometry(800, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
  })
})

describe('不留死入口（能力标志 → 左簇形态）', () => {
  it('托盘全无条目 + 插件零贡献 → leftCluster absent，任何状态无聚合入口', async () => {
    setTrayCounts(0, 0)
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchFitGeometry(800, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-slot-left-cluster')).toBe('absent')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
    // `+` 仍在（序 0 与托盘无关）
    expect(firstButtonTitle()).toBe('添加内容（附件 / 命令）')
  })

  it('非保护态托盘恒挂载：条目归零→恢复，聚合按钮经 absent 再回来（emitter 存活链）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    // L1 聚合态起步：聚合入口在场
    await dispatchFitGeometry(400, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-slot-left-cluster')).toBe('aggregated')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(true)

    // 条目归零 → has-items false 上抛（托盘外壳未被卸载，emitter 存活）→ leftCluster absent
    setTrayCounts(0, 0)
    await nextTick()
    expect(bar().attributes('data-slot-left-cluster')).toBe('absent')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)

    // 条目恢复 → 同一 emitter 仍上抛 → 聚合按钮重新渲染（形态恢复，无需重挂）
    setTrayCounts(2, 1)
    await nextTick()
    expect(bar().attributes('data-slot-left-cluster')).toBe('aggregated')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(true)
  })
})

describe('fit 收敛回路（宽度矩阵驱动）', () => {
  it('放得下 → 不施加 fit 退化（data-fit = 0）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchFitGeometry(800, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-fit')).toBe('0')
  })

  it('同宽度下反复派发不抖（级数稳定）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('2')
    for (let i = 0; i < 4; i += 1) {
      await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    }
    expect(bar().attributes('data-fit')).toBe('2')
  })

  it('卸载后 observer 断开（不再消费派发）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchFitGeometry(800, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    const observer = ManualResizeObserverStub.created()[0]
    wrapper?.unmount()
    wrapper = null
    observer?.dispatch([{ contentRect: { width: 700 } as DOMRectReadOnly }])
    await nextTick()
    expect(document.querySelector('[data-testid="composer-bar"]')).toBeNull()
  })
})
