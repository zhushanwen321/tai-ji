/**
 * Composer 底栏密度接线 + slash 注入合并产物（round 5-G U9，单文件多源：2 个源文件同
 * SUT（Composer.vue）、环境全默认 happy-dom）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - composer-bar-density-wiring.test.ts（底栏三步聚合接线，19 例）
 *  - composer-slash-injection.test.ts（pendingSlash 注入 watch，9 例；round 5-G U9 并入）
 *
 * 覆盖（bar-density 节，三视角，用户可见 DOM 断言优先）：
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
 * 覆盖（slash-injection 节，Wave C，U12-U16/U18）：
 *  - U12 匹配时注入 + 注入顺序（insertSlashChip 先于 clearPendingSlash）
 *  - U13 不匹配时不消费（不误清留给其他 Composer 的 pendingSlash）
 *  - U14 landing 态匹配（双方 null）／U15 watch 非 immediate／U16 重复点击同命令触发
 *  - U18 split 双 Composer 竞争消费／U19-U20b SearchModal 注入按 isSkill 分流
 *
 * U9 解锁改造记录：
 *  - 原 slash-injection 的 '@/stores/chat' 窄 mock（composerChatStoreModule：useChatStore
 *    仅 7 动作键）撤销——bar-density 节策略是真 pinia + 真 chat store（send-button-states
 *    同范式），模块级窄 mock 会砍掉真实 store 全成员。slash 节直接用真实 store：Composer
 *    构造期只读 isActive / getRetryState（真实成员，无活跃 session 时恒 false / undefined，
 *    与原窄 mock 下该 computed 未被求值的净效果等价且更真实）；send/steer 等动作方法在
 *    useChat composable 上不在 store 上，本节用例不触发，无需处置。
 *  - '@/stores/session' 双文件同指纹 mock 去重为顶层一份（composerSessionStoreModule）。
 *  - slash 节 ComposerInput mock（'@taiji/ui/features/composer' spread 覆写）保留：bar-density
 *    节的 ComposerInput 走 global.stubs 名称匹配拦截（mock 组件 name 相同被 stub 替换，
 *    不进 DOM）。
 *  - bar-density 节的 useTrayCounts / useChat / useNewTaskFlow / @/api mock 对 slash 节
 *    泄漏无害（slash 用例不触发其调用路径，挂载期消费的形态兼容）。
 *
 * [HISTORICAL] 旧版用例断言的 data-tier 三档（640/520 阈值）、data-slot-capacity/model merged、
 * `composer-overflow-menu` / `composer-capacity-merged` / `composer-model-merged` testid、
 * 合流发丝分隔（separatorsInBar）已随三步聚合击败的旧语义删除。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=panel TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/panel/composer-bar-density-wiring.test.ts（本文件登记在 domain-map.json panel 域，默认档被排除）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
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
import { useCommandStore, __testing } from '@/composables/features/command/useCommandStore'

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

// ── slash 节的 ComposerInput mock（U9 并入自 composer-slash-injection）：
//    defineExpose 暴露 insertSlashChip / insertSkillChip 为独立 vi.fn() spy。
//    每个测试 mount 前重新生成 spy：通过 factory 读取最新 spy 引用。
//    insertSkillChip 供 pendingSlash.isSkill 分流断言（搜索注入的 skill 项不走 insertSlashChip）。
//    bar-density 节的 ComposerInput 走 global.stubs 名称匹配（mock 组件 name 相同被 stub
//    替换不进 DOM，spy 不误收集）。
let composerInputSpies: Array<{
  insertSlashChip: ReturnType<typeof vi.fn>
  insertSkillChip: ReturnType<typeof vi.fn>
}> = []
// W4：ComposerInput 迁 ui 包（@taiji/ui/features/composer），mock 目标是 ui 包路径
vi.mock('@taiji/ui/features/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/ui/features/composer')>()
  return {
    ...actual,
    ComposerInput: defineComponent({
    name: 'ComposerInput',
    emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
    setup() {
      const insertSlashChip = vi.fn()
      const insertSkillChip = vi.fn()
      const spy = { insertSlashChip, insertSkillChip }
      composerInputSpies.push(spy)
      return { insertSlashChip, insertSkillChip }
    },
    template: '<div data-testid="composer-input" />',
    }),
  }
})

// ══════════ 来源节：composer-bar-density-wiring（原文件顶层 hook/helper 下沉包裹层内）══════════

describe('Composer 底栏密度（composer-bar-density-wiring 合并节）', () => {

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
    // 缺省反转后「可见」用例一律已推送形态（hidden=true 显式停用 / false 已推送在场）
    getRuntimeState: () => ({ headerActionId: 'scheduler-manager.open', pluginId: 'scheduler-manager', updatedAt: 1, hidden }),
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

/** 底栏首/末按钮（序 0 锚点断言用）：首钮 = `+`（aria-label，原生 title 已退役）；
 *  末钮 = 发送位（不在左簇清理范围，title 保留原生） */
function firstButtonTitle(): string | undefined {
  return bar().findAll('button')[0]?.attributes('aria-label')
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

  it('声明运行时 hidden=true → 不构成左簇内容：hidden 钮不渲染，三源全空 → 左簇 absent', async () => {
    setTrayCounts(0, 0)
    // hidden 声明不构成左簇内容（hasVisibleHeaderActions 判定），mountAndFit 的空 provide 路径
    // 不带 headerSource——为覆盖「hidden 源在场」形态走显式挂载
    mountComposer(makeMountPointSource(reactive(new Map())), makeHeaderActionSource(true))
    await dispatchFitGeometry(800, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    // [session-store-layout-inversion 裁决 4] canvas 件恒渲染豁免已删除（画布按归属会话隔离，
    // 零画布即隐藏）→ hidden headerAction 不构成内容时三源全空 → 不留死入口 absent
    expect(bar().attributes('data-slot-left-cluster')).toBe('absent')
    expect(bar().find('[data-testid="header-action-scheduler-manager-open"]').exists()).toBe(false)
    expect(bar().find('[data-testid="tray-builtin-button"][data-kind="canvas"]').exists()).toBe(false)
  })
})

describe('不留死入口（能力标志 → 左簇形态）', () => {
  it('托盘全无任务条目 + 插件零贡献 → leftCluster absent（不留死入口；canvas 件零画布同隐藏）', async () => {
    setTrayCounts(0, 0)
    await mountAndFit(800, { 0: 300, 1: 200, 2: 150, 3: 120 })
    // [session-store-layout-inversion 裁决 4] canvas 件恒渲染豁免已删除（画布归属会话隔离
    // 后「本 session 无画布」前提成立）→ 三源全空 = absent 形态（新建入口随首张画布出现）
    expect(bar().attributes('data-slot-left-cluster')).toBe('absent')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
    expect(bar().find('[data-testid="tray-builtin-button"][data-kind="canvas"]').exists()).toBe(false)
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

    // 条目归零 → [session-store-layout-inversion 裁决 4] canvas 件无豁免 → 三源全空
    // → 左簇 absent、聚合按钮与角标一并消失（归零不虚亮）；托盘外壳恒挂载（emitter 与
    // useTrayCounts 数据面唯一实例不卸载，见 Composer.vue 挂载注释），响应链存活
    setTrayCounts(0, 0)
    await nextTick()
    expectClusterShape({ leftCluster: 'absent' })
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)

    // 条目恢复 → 同一数据面仍驱动重算 → 聚合形态与运行数角标回升（无需重挂）
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
}) // ── 底栏密度包裹层结束（本节 hook 作用域收口）

// ══════════ 来源节：composer-slash-injection（U9 并入；@/stores/chat 窄 mock 撤销，
// 改节内对真实 chat store 的 7 动作方法 spy——策略：真 pinia + 真 commandStore
// （需观察 pendingSlash 真实值 / clearPendingSlash 真实副作用）+ 真 chat store）══════════

describe('Composer slash 注入（composer-slash-injection 合并节）', () => {
  /** mount Composer，返回 wrapper + 最近一次 ComposerInput 的 insertSlashChip / insertSkillChip spy */
  function mountSlashComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
    const wrapper = mount(Composer, {
      props,
      global: { stubs: composerChildStubs },
    })
    const spy = composerInputSpies.at(-1)?.insertSlashChip
    const skillSpy = composerInputSpies.at(-1)?.insertSkillChip
    if (!spy || !skillSpy) throw new Error('ComposerInput spy 未生成')
    return { wrapper, spy, skillSpy }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    composerInputSpies = []
    // [w5] 壳单例跨测试共享：reset 让每个用例拿到全新实例（旧 Composer watch 订阅旧实例，不再干扰）
    __testing.__resetCommandStoreForTesting()
    // U9 改造：原模块窄 mock（useChatStore 仅 7 动作键）撤销——改用真实 store。
    // Composer 构造期只读 isActive / getRetryState（真实成员，无活跃 session 时恒
    // false/undefined，与原窄 mock 下「computed 未被求值」的净效果等价且更真实）；
    // 动作方法（send/steer 等）在 useChat composable 上，不在 store 上，无需 spy。
  })

  // ───────────────────────── U12 匹配时注入 + 注入顺序 ─────────────────────────

  describe('Composer slash 注入 watch（Wave C）', () => {
    it('U12 匹配时注入并按序先 insert 后 clear（含 icon 透传）', async () => {
      const { spy: insertSpy } = mountSlashComposer({ sessionId: 's1' })
      const commandStore = useCommandStore()
      const clearSpy = vi.spyOn(commandStore, 'clearPendingSlash')

      commandStore.requestSlashInjection({
        command: '/goal',
        icon: 'star',
        sessionId: 's1',
      })
      await nextTick()

      // insertSlashChip 收到 command + icon（透传）
      expect(insertSpy).toHaveBeenCalledOnce()
      expect(insertSpy).toHaveBeenCalledWith('/goal', 'star')
      // pendingSlash 被消费清空
      expect(commandStore.pendingSlash.value).toBeNull()
      expect(clearSpy).toHaveBeenCalledOnce()
      // 注入顺序：先 insertSlashChip 后 clearPendingSlash（防先清后注入读到 null）
      expect(insertSpy).toHaveBeenCalledBefore(clearSpy)
    })

    // ───────────────────────── U13 不匹配时不消费（不误清）─────────────────────────

    it('U13 不匹配 sessionId 时不消费（不误清留给其他 Composer 的请求）', async () => {
      const { spy: insertSpy } = mountSlashComposer({ sessionId: 's1' })
      const commandStore = useCommandStore()
      const clearSpy = vi.spyOn(commandStore, 'clearPendingSlash')

      commandStore.requestSlashInjection({ command: '/x', sessionId: 's2' })
      await nextTick()

      // 不注入
      expect(insertSpy).not.toHaveBeenCalled()
      // 不清空（显式断言调用次数 0，防「无论匹配都 clear」误实现清掉 s2 的请求）
      expect(clearSpy).not.toHaveBeenCalled()
      // pendingSlash 仍非 null（留给 sid=s2 的 Composer 消费）
      expect(commandStore.pendingSlash.value).not.toBeNull()
      expect(commandStore.pendingSlash.value?.sessionId).toBe('s2')
    })

    // ───────────────────────── U14 landing 态匹配（双方 null）─────────────────────────

    it('U14 landing 态（sessionId=null）匹配 null 请求时注入', async () => {
      const { spy: insertSpy } = mountSlashComposer({ sessionId: null, variant: 'landing' })
      const commandStore = useCommandStore()

      commandStore.requestSlashInjection({
        command: '/goal',
        icon: 'star',
        sessionId: null,
      })
      await nextTick()

      expect(insertSpy).toHaveBeenCalledOnce()
      expect(insertSpy).toHaveBeenCalledWith('/goal', 'star')
      expect(commandStore.pendingSlash.value).toBeNull()
    })

    // ───────────────────────── U15 watch 非 immediate（残留值不误注入）─────────────────────────

    it('U15 watch 非 immediate（挂载前残留 pendingSlash 不误注入）', async () => {
      const commandStore = useCommandStore()
      // 挂载前预设 pendingSlash（模拟 store 残留前一个 Composer 的请求）
      commandStore.requestSlashInjection({
        command: '/goal',
        icon: 'star',
        sessionId: 's1',
      })
      expect(commandStore.pendingSlash.value).not.toBeNull() // 预设存在

      // 然后才 mount Composer（非 immediate：初始值不应触发 watch）
      const { spy: insertSpy } = mountSlashComposer({ sessionId: 's1' })
      await nextTick()
      await flushPromises()

      expect(insertSpy).not.toHaveBeenCalled()
      // 残留值未被本 Composer 误消费（应留给真正触发的消费时机）
      expect(commandStore.pendingSlash.value).not.toBeNull()
    })

    // ───────────────────────── U16 重复点击同命令触发（ts 变化）─────────────────────────

    it('U16 重复点击同命令（ts 变化）→ insertSlashChip 调用 2 次', async () => {
      const { spy: insertSpy } = mountSlashComposer({ sessionId: 's1' })
      const commandStore = useCommandStore()

      // 第一次请求 → watch 触发 → insertSlashChip + clearPendingSlash（pendingSlash 变 null）
      commandStore.requestSlashInjection({ command: '/goal', icon: 'star', sessionId: 's1' })
      await nextTick()
      expect(insertSpy).toHaveBeenCalledOnce()

      // 第二次请求（ts 不同）→ pendingSlash 从 null 变非 null → watch 再触发
      // 两次请求间隔需让第一次的 watch 执行完（clearPendingSlash 已将值置 null）
      await nextTick()
      commandStore.requestSlashInjection({ command: '/goal', icon: 'star', sessionId: 's1' })
      await nextTick()

      expect(insertSpy).toHaveBeenCalledTimes(2)
      expect(commandStore.pendingSlash.value).toBeNull()
    })

    // ───────────────────────── U18 split 双 Composer 竞争消费 ─────────────────────────

    it('U18 split 双 Composer：仅目标 session 的 Composer 消费（竞争不重复注入）', async () => {
      // 同一 pinia 下 mount 两个 Composer（s1 + s2），各自 ComposerInput mock spy 独立
      const { spy: spy1 } = mountSlashComposer({ sessionId: 's1' })
      const { spy: spy2 } = mountSlashComposer({ sessionId: 's2' })
      const commandStore = useCommandStore()

      // 注入目标 s1
      commandStore.requestSlashInjection({ command: '/goal', sessionId: 's1' })
      await nextTick()
      await flushPromises()

      // 仅 s1 的 Composer 注入（1 次），s2 不被调
      expect(spy1).toHaveBeenCalledOnce()
      expect(spy1).toHaveBeenCalledWith('/goal', undefined)
      expect(spy2).not.toHaveBeenCalled()

      // 全局注入总次数 === 1（无重复/广播消费）
      expect(spy1.mock.calls.length + spy2.mock.calls.length).toBe(1)
      // pendingSlash 最终为 null（被 s1 消费方清一次）
      expect(commandStore.pendingSlash.value).toBeNull()
    })
  })

  // ───────────────── U19/U20 SearchModal 注入按 isSkill 分流（第三条 skill 入口合流）─────────────────
  // pi 的 skill 命令名是裸 `skill:<name>`（无前导 /），命令通路（insertSlashChip）内 `/skill:` 前缀
  // 判定为假 ⇒ 不分流会落成命令 chip。本组锁：isSkill 真 → insertSkillChip(裸名, location, icon)；
  // 缺省 → 维持 insertSlashChip(命令通路回归锁)。

  describe('Composer pendingSlash 按 isSkill 分流（SearchModal ⌘K 注入）', () => {
    it('U19 isSkill:true → insertSkillChip(裸名, location, icon)，不走 insertSlashChip，通道被清', async () => {
      const { spy: slashSpy, skillSpy } = mountSlashComposer({ sessionId: 's1' })
      const commandStore = useCommandStore()

      commandStore.requestSlashInjection({
        command: 'skill:code-review',
        icon: 'star',
        sessionId: 's1',
        isSkill: true,
        location: '/skills/code-review/SKILL.md',
      })
      await nextTick()

      // 裸名（剥 `skill:` 前缀）+ location + icon 透传
      expect(skillSpy).toHaveBeenCalledOnce()
      expect(skillSpy).toHaveBeenCalledWith('code-review', '/skills/code-review/SKILL.md', 'star')
      // 命令通路未被调用（不落命令 chip）
      expect(slashSpy).not.toHaveBeenCalled()
      expect(commandStore.pendingSlash.value).toBeNull()
    })

    it('U20 回归锁：isSkill 缺省/false → 仍走 insertSlashChip，不调 insertSkillChip', async () => {
      const { spy: slashSpy, skillSpy } = mountSlashComposer({ sessionId: 's1' })
      const commandStore = useCommandStore()

      commandStore.requestSlashInjection({ command: 'goal', icon: 'goal', sessionId: 's1', isSkill: false })
      await nextTick()

      expect(slashSpy).toHaveBeenCalledOnce()
      expect(slashSpy).toHaveBeenCalledWith('goal', 'goal')
      expect(skillSpy).not.toHaveBeenCalled()
      expect(commandStore.pendingSlash.value).toBeNull()
    })

    it('U19b isSkill:true 且 location 缺省 → insertSkillChip(裸名, undefined, icon)（不兜底不报错）', async () => {
      const { skillSpy } = mountSlashComposer({ sessionId: 's1' })
      const commandStore = useCommandStore()

      commandStore.requestSlashInjection({
        command: 'skill:code-review',
        icon: 'star',
        sessionId: 's1',
        isSkill: true,
      })
      await nextTick()

      expect(skillSpy).toHaveBeenCalledWith('code-review', undefined, 'star')
    })
  })
})
