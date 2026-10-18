/**
 * Composer 底栏密度接线测试（D6 修订「三步聚合」版）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - 使用者（黑盒）：① 实测溢出逐级触发 指标聚合 → 左簇聚合 → 模型+思考聚合（累计，右簇先压）；
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
 * - `VIEW_HOST_SOURCE_KEY` provide（插件 toolbar 贡献点：有 entry → 贡献数 1）；`getViewIds` 返回空
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
import { defineComponent, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import type { ViewCacheEntry, ViewHostSource } from '@taiji/ui/extension-host'
import { ManualResizeObserverStub } from '../effects/_virtua-mock-helper'
import { composerApiModule, composerChatModule, composerChildStubs, composerFlowModule, composerSessionStoreModule, makeComposerInputMock } from '../helpers/composer-mount'
import {
  dispatchFitGeometry as stubFitGeometry,
  makeMountPointSource as makeHelperSource,
  toolbarEntry,
} from './_density-geometry-helper'
import { HEADER_ACTIONS_SOURCE_KEY } from '@/composables/shell/useExtensionHostBridge'
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
        // u-tray-entry 第 5 件：本文件不验 canvas 件，恒 0（canvas 按钮仍恒渲染，dim 态）
        canvas: { running: 0, ended: 0, total: 0 },
      })),
      lists: {
        bash: { running: emptyList(), ended: emptyList() },
        subagent: { running: emptyList(), ended: emptyList() },
        workflow: { running: emptyList(), ended: emptyList() },
        session: { children: emptyList() },
        canvas: { entries: emptyList() },
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

// ── chat / flow / api / session store mock（公共骨架收敛 helpers/composer-mount.ts 单源，
//    同 composer-file-injection 等四文件范式；api 的 chat 组是本文件增量）──
vi.mock('@/composables/features/chat/useChat', () => composerChatModule())
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
vi.mock('@/api', () => ({
  ...composerApiModule(),
  chat: { send: vi.fn(() => Promise.resolve()), steer: vi.fn(() => Promise.resolve()), streamSubscribe: vi.fn(() => () => {}) },
}))
vi.mock('@/stores/session', () => composerSessionStoreModule())

// ── 子组件 stub（ComposerInput mock 收敛 composer-mount 共用部分工厂）──
const { lastInputText, ComposerInputMock } = makeComposerInputMock()
// GenStatsTriggers 专属空 stub（共享骨架未覆盖的本文件特例）
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
// AddMenuPopover 保持真实（序 0 的 `+` 是「不退化」断言对象，trigger 带 title）——
// 从共享骨架剔除该键；其余兄弟子组件 stub 收敛 helpers/composer-mount.ts 单源
const { AddMenuPopover: _addMenuPopoverReal, ...childStubs } = composerChildStubs
const stubs = {
  ComposerInput: ComposerInputMock,
  ...childStubs,
  GenStatsTriggers: SIMPLE,
  ComposerMetricsAggregate: MetricsAggregateStub,
  ModelThinkingAggregate: ModelThinkingAggregateStub,
}

const SID = 's-density'

/** S4 两用例共用的全档宽度矩阵（截断 class 扫描 + `»` 退役检查；末行全档放不下驱动顶格） */
const WIDTH_MATRIX: Array<[number, Record<string, number>]> = [
  [800, { 0: 300, 1: 200, 2: 150, 3: 120 }],
  [400, { 0: 500, 1: 300, 2: 180, 3: 100 }],
  [300, { 0: 500, 1: 500, 2: 500, 3: 500 }],
]

/**
 * 挂载（空挂载点源）+ 派发一次 fit 几何（左簇宽全文件恒 80）——级数/锚点/fit 回路
 * 用例的共用入口（S4 矩阵用例与插件贡献用例挂载形态不同，不走此口）。
 */

/** 三簇形态断言单源：data-slot-{metrics,left-cluster,model-thinking} 的 expanded/aggregated/absent。 */
function expectClusterShape(shape: { metrics?: string; leftCluster?: string; modelThinking?: string }) {
  if (shape.metrics) expect(bar().attributes('data-slot-metrics')).toBe(shape.metrics)
  if (shape.leftCluster) expect(bar().attributes('data-slot-left-cluster')).toBe(shape.leftCluster)
  if (shape.modelThinking) expect(bar().attributes('data-slot-model-thinking')).toBe(shape.modelThinking)
}

async function mountAndFit(avail: number, widths: Record<string, number>): Promise<void> {
  mountComposer(makeMountPointSource(reactive(new Map())))
  await dispatchFitGeometry(avail, 80, widths)
}

/**
 * 挂载点数据源替身（几何 helper 单份替身的本文件绑 SID 形态）。
 */
function makeMountPointSource(partition: Map<string, ViewCacheEntry>): ViewHostSource {
  return makeHelperSource(SID, partition)
}

/**
 * headerAction 数据源替身（B3 聚合范围用例：scheduler overlay 直开声明形态——
 * hasVisibleHeaderActions 判定消费 getDeclarations/getRuntimeState 两面）。
 */
function makeHeaderActionSource(hidden = false): object {
  return {
    getDeclarations: () => [
      {
        pluginId: 'scheduler-manager',
        contributionId: 'scheduler-manager.open',
        type: 'headerAction',
        headerAction: { activation: 'scheduler-overlay', icon: 'clock', title: '定时任务' },
      },
    ],
    getRuntimeState: () => (hidden ? { hidden: true } : undefined),
    resolveCommandAvailability: () => 'registered',
    executeCommand: () => true,
  }
}

let wrapper: VueWrapper | null = null

function mountComposer(source: ViewHostSource | null, headerSource?: object | null): VueWrapper {
  const provide: Record<symbol, unknown> = {}
  if (source) provide[VIEW_HOST_SOURCE_KEY as symbol] = source
  if (headerSource) provide[HEADER_ACTIONS_SOURCE_KEY as symbol] = headerSource
  wrapper = mount(Composer, {
    props: { sessionId: SID },
    global: {
      stubs,
      // 键是 symbol（Object.keys 不含 symbol，判空用 Reflect.ownKeys）
      ...(Reflect.ownKeys(provide).length > 0 ? { provide } : {}),
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

describe('三步聚合：实测溢出 → 状态机 → DOM（累计，指标 → 左簇 → 模型）', () => {
  it('放得下 → fit 0 全展开：托盘逐件按钮在、无任何聚合入口', async () => {
    await mountAndFit(800, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-fit')).toBe('0')
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
    expect(bar().attributes('data-slot-metrics')).toBe('expanded')
    expect(bar().attributes('data-slot-model-thinking')).toBe('expanded')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
    expect(bar().findAll('[data-testid="tray-builtin-button"]').length).toBeGreaterThanOrEqual(2)
    expect(bar().find('[data-testid="composer-metrics-aggregate"]').exists()).toBe(false)
    expect(bar().find('[data-testid="composer-model-thinking-aggregate"]').exists()).toBe(false)
  })

  it('L1 收缩停级 → 指标聚合（单图标聚合组件挂载），左簇/模型仍展开', async () => {
    // L0 需求 80+500=580 > 400；L1 需求 80+300=380 ≤ 400 → 停在 L1
    await mountAndFit(400, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('1')
    // 序 2/3 未触发：左簇逐件按钮在（托盘未聚合）、模型完整形态
    expectClusterShape({ metrics: 'aggregated', leftCluster: 'expanded', modelThinking: 'expanded' })
    expect(bar().find('[data-testid="composer-metrics-aggregate"]').exists()).toBe(true)
    expect(bar().findAll('[data-testid="tray-builtin-button"]').length).toBeGreaterThanOrEqual(2)
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
    expect(bar().find('[data-testid="composer-model-thinking-aggregate"]').exists()).toBe(false)
  })

  it('L2 → 左簇聚合（托盘单入口 + 运行数），指标保持聚合、模型仍完整形态', async () => {
    // L0 580 > 300；L1 380 > 300；L2 80+180=260 ≤ 300 → 停在 L2
    await mountAndFit(300, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('2')
    expectClusterShape({ metrics: 'aggregated', leftCluster: 'aggregated', modelThinking: 'expanded' })
    expect(bar().find('[data-testid="composer-metrics-aggregate"]').exists()).toBe(true)
    const aggregate = bar().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)
    expect(aggregate.find('[data-testid="tray-aggregate-count"]').text()).toBe('3')
    expect(bar().findAll('[data-testid="tray-builtin-button"]')).toHaveLength(0)
    expect(bar().attributes('data-slot-model-thinking')).toBe('expanded')
    expect(bar().find('[data-testid="composer-model-thinking-aggregate"]').exists()).toBe(false)
  })

  it('L3 顶格 → 模型+思考聚合（三步全生效）', async () => {
    // 所有级别都放不下 → 顶格 L3（且 demand 仍 > avail → 进锚点保护，见下个 describe）
    await mountAndFit(300, { 0: 500, 1: 400, 2: 350, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('3')
    expect(bar().attributes('data-slot-model-thinking')).toBe('aggregated')
    expect(bar().find('[data-testid="composer-model-thinking-aggregate"]').exists()).toBe(true)
  })

  it('从宽到窄依次观察到 ①指标聚合 ②左簇聚合 ③模型聚合；回拉变宽还原（B1 次序）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    // 全宽：全展开
    await dispatchFitGeometry(800, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expectClusterShape({ metrics: 'expanded', leftCluster: 'expanded' })

    // ① 400px：指标先聚合（右簇先压——信息先让位），左簇未动
    await dispatchFitGeometry(400, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('1')
    expectClusterShape({ metrics: 'aggregated', leftCluster: 'expanded' })

    // ② 300px：左簇后聚合（指标保持聚合）
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('2')
    expectClusterShape({ metrics: 'aggregated', leftCluster: 'aggregated' })

    // ③ 250px：模型+思考最后聚合
    await dispatchFitGeometry(250, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('3')
    expect(bar().attributes('data-slot-model-thinking')).toBe('aggregated')

    // 回拉变宽按档位还原：800px 逐级降回全展开（同宽收敛同档，与收缩方向无关）
    await dispatchFitGeometry(800, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('0')
    expect(bar().attributes('data-slot-metrics')).toBe('expanded')
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
    expect(bar().attributes('data-slot-model-thinking')).toBe('expanded')
  })
})

describe('锚点保护：顶格仍放不下 → 中部让位，锚点零裁剪（S1）', () => {
  it('持续溢出 → data-anchor-protected，左簇/指标让位，模型聚合按钮与 `+`/发送恒在', async () => {
    await mountAndFit(300, { 0: 500, 1: 500, 2: 500, 3: 500 })
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
    await mountAndFit(300, { 0: 500, 1: 400, 2: 350, 3: 320 })
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
    for (const [avail, widths] of WIDTH_MATRIX) {
      await dispatchFitGeometry(avail, 80, widths)
      const html = bar().html()
      expect(html).not.toContain('max-w-[88px]')
      expect(html).not.toContain('max-w-[56px]')
    }
  })

  it('任何状态（含插件有贡献 + 强制溢出）都不出现 `»` Ellipsis 溢出菜单（退役）', async () => {
    const partition = reactive(new Map<string, ViewCacheEntry>([['composer.toolbar', toolbarEntry()]]))
    mountComposer(makeMountPointSource(partition))
    for (const [avail, widths] of WIDTH_MATRIX) {
      await dispatchFitGeometry(avail, 80, widths)
      expect(bar().find('[data-testid="composer-overflow-menu"]').exists()).toBe(false)
      expect(bar().find('[data-testid="composer-overflow-capacity-metrics"]').exists()).toBe(false)
    }
    // 插件有贡献 + 展开态：左簇仍是散图标路径（挂载点内联），无 `»`
    await dispatchFitGeometry(800, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
  })
})

describe('B3 聚合范围：headerAction（定时任务钮）随左簇聚合走（demo composer-bar spec §2.1/§4.2）', () => {
  it('L0 expanded：headerAction 钮在左簇渲染（clock 直开入口在场）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())), makeHeaderActionSource())
    await dispatchTick()
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
    expect(bar().find('[data-testid="header-action-scheduler-manager-open"]').exists()).toBe(true)
  })

  it('L2 aggregated：左簇摘除 headerAction 钮（聚合面板首段承接，面板段断言归 composer-tray.test）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())), makeHeaderActionSource())
    // L0 580 > 300；L1 380 > 300；L2 80+180=260 ≤ 300 → 停在 L2
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('2')
    expectClusterShape({ leftCluster: 'aggregated' })
    // 左簇内 headerAction 钮已摘除（入口改由聚合面板承载）
    expect(bar().find('[data-testid="header-action-scheduler-manager-open"]').exists()).toBe(false)
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(true)
  })

  it('托盘全无 + toolbar 零贡献 + headerAction 有入口 → leftCluster 非 absent（第三内容源）', async () => {
    setTrayCounts(0, 0)
    mountComposer(makeMountPointSource(reactive(new Map())), makeHeaderActionSource())
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    // 若无 headerAction 源，此几何下 leftCluster = absent（不留死入口旧行为）；
    // 有源则聚合入口必须在场——被聚合 clock 的直开动作不因托盘空而丢失
    expectClusterShape({ leftCluster: 'aggregated' })
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(true)
  })

  it('声明运行时 hidden=true → 不构成左簇内容：hidden 钮不渲染，左簇仅剩恒在的 canvas 件', async () => {
    setTrayCounts(0, 0)
    // hidden 声明不构成左簇内容（hasVisibleHeaderActions 判定），mountAndFit 的空 provide 路径
    // 不带 headerSource——为覆盖「hidden 源在场」形态走显式挂载
    mountComposer(makeMountPointSource(reactive(new Map())), makeHeaderActionSource(true))
    await dispatchFitGeometry(800, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    // [u-tray-entry 后] canvas 件恒渲染（创建入口豁免）→ 左簇不再有 absent 形态；
    // hidden headerAction 钮照旧不渲染（该判定语义不变）
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
    expect(bar().find('[data-testid="header-action-scheduler-manager-open"]').exists()).toBe(false)
    expect(bar().find('[data-testid="tray-builtin-button"][data-kind="canvas"]').exists()).toBe(true)
  })
})

describe('不留死入口（能力标志 → 左簇形态）', () => {
  it('托盘全无任务条目 + 插件零贡献 → leftCluster expanded（canvas 恒渲染件在场，无聚合入口）', async () => {
    setTrayCounts(0, 0)
    await mountAndFit(800, { 0: 300, 1: 200, 2: 150, 3: 120 })
    // [u-tray-entry 后] canvas 件恒渲染（创建入口豁免）→「托盘全无 → absent」形态不可达，
    // 宽裕档下左簇 = expanded（恒在的 canvas 按钮，dim 态）
    expect(bar().attributes('data-slot-left-cluster')).toBe('expanded')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
    expect(bar().find('[data-testid="tray-builtin-button"][data-kind="canvas"]').exists()).toBe(true)
    // `+` 仍在（序 0 与托盘无关）
    expect(firstButtonTitle()).toBe('添加内容（附件 / 命令）')
  })

  it('非保护态托盘恒挂载：条目归零→恢复，聚合运行数跟随归零再回升（外壳与 emitter 链不卸载）', async () => {
    // L2 聚合态起步（左簇聚合生效）：聚合入口在场，运行数 = bash 2 + subagent 1
    await mountAndFit(300, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expectClusterShape({ leftCluster: 'aggregated' })
    const aggregate = bar().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)
    expect(aggregate.find('[data-testid="tray-aggregate-count"]').text()).toBe('3')

    // 条目归零 → has-items 恒 true（canvas 件豁免，见 ComposerTray builtinItems 注释）→
    // 左簇保持聚合形态；运行数角标归零消失（归零不虚亮），外壳未被卸载
    setTrayCounts(0, 0)
    await nextTick()
    expectClusterShape({ leftCluster: 'aggregated' })
    expect(bar().find('[data-testid="tray-aggregate-count"]').exists()).toBe(false)

    // 条目恢复 → 同一数据面仍驱动重算 → 运行数角标回升（响应链存活，无需重挂）
    setTrayCounts(2, 1)
    await nextTick()
    expectClusterShape({ leftCluster: 'aggregated' })
    expect(bar().find('[data-testid="tray-aggregate-count"]').text()).toBe('3')
  })
})

describe('fit 收敛回路（宽度矩阵驱动）', () => {
  it('放得下 → 不施加 fit 退化（data-fit = 0）', async () => {
    await mountAndFit(800, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-fit')).toBe('0')
  })

  it('同宽度下反复派发不抖（级数稳定）', async () => {
    await mountAndFit(300, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('2')
    for (let i = 0; i < 4; i += 1) {
      await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    }
    expect(bar().attributes('data-fit')).toBe('2')
  })

  it('卸载后 observer 断开（不再消费派发）', async () => {
    await mountAndFit(800, { 0: 300, 1: 200, 2: 150, 3: 120 })
    const observer = ManualResizeObserverStub.created()[0]
    wrapper?.unmount()
    wrapper = null
    observer?.dispatch([{ contentRect: { width: 700 } as DOMRectReadOnly }])
    await nextTick()
    expect(document.querySelector('[data-testid="composer-bar"]')).toBeNull()
  })
})
