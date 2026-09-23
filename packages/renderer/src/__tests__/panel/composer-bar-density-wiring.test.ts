/**
 * Composer 底栏密度接线测试（u6b / 设计 `mode-system-composer-density` D6 + §7.4「底栏」行）。
 *
 * 覆盖（三视角，用户可见 DOM 断言优先）：
 * - 使用者（黑盒）：① 窄档下托盘聚合成单入口（层叠图标 + 运行数）；② `»` 溢出菜单仅在确有被收起项
 *   （插件 toolbar 有贡献）时渲染；③ 序 0 发送位在窄档仍渲染（不退化，右锚不漂移）；托盘全无条目时
 *   窄档也不出聚合入口（不留死入口）。
 * - 观察者（形态）：底栏 `flex-nowrap`（永不换行）+ 三簇结构；形态以状态机输出为准（data-tier /
 *   data-slot-* 逐元素形态），档位切换时形态整组跟随。
 * - **fit 轴**（方案 A）：实测「放不下」→ `data-fit` 逐级收紧（L2 即停 / 顶格 L3 容量+指标进 `»` /
 *   变宽放松 / 同宽不抖）；V2 合流态无实心底、分组由发丝分隔表达。
 * - 构建者（白盒）：ResizeObserver 实测驱动档位（模拟容器宽度 400/560/700 → narrow/compact/expanded），
 *   阈值判据本体在 composer-density.test.ts（100% 覆盖），此处只证「实测 → 状态机 → DOM」链路导通。
 *
 * 策略：
 * - `useTrayCounts` 替身（托盘三态计数注入）——真 ComposerTray 渲染，聚合入口是真实组件；
 * - `VIEW_HOST_SOURCE_KEY` provide（插件 toolbar 贡献面：有 entry → 贡献数 1）；`getViewIds` 返回空
 *   （该 mock 只服务挂载点查询，不冒充 widget 区条目）；
 * - `ManualResizeObserverStub`（`../effects/_virtua-mock-helper` 定稿件）确定性派发实测宽；
 * - 真 pinia + 真 chat store（与 composer-send-button-states 同范式），mock useChat / useNewTaskFlow /
 *   api / session store；ComposerInput 与重子组件 stub。
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
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import Composer from '@/components/panel/Composer.vue'

// ── 托盘三态替身：计数可注入（数组型行集对本文件无消费方，恒空）──
const trayFixture = vi.hoisted(() => ({ bashRunning: 2, subagentRunning: 1 }))

vi.mock('@/components/panel/tray/useTrayCounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/panel/tray/useTrayCounts')>()
  const emptyList = (): ReturnType<typeof computed<never[]>> => computed(() => [])
  return {
    ...actual,
    useTrayCounts: (): UseTrayCountsReturn => ({
      counts: computed(() => ({
        bash: { running: trayFixture.bashRunning, ended: 0, total: trayFixture.bashRunning },
        subagent: { running: trayFixture.subagentRunning, ended: 0, total: trayFixture.subagentRunning },
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
const stubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  // AddMenuPopover 保持真实：序 0 的 `+` 是「不退化」断言对象（trigger 带 title）
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  GenStatsTriggers: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

const SID = 's-density'

/**
 * 挂载点数据源替身：**只服务 `getView(sid, 'composer.toolbar')`**（插件 toolbar 贡献面），
 * `getViewIds` 恒空——不冒充 widget 区条目（否则挂载点 view 会被托盘 widget 区当成条目）。
 */
function makeMountPointSource(partition: Map<string, ViewCacheEntry>): ViewHostSource {
  return {
    getView: (sid, viewId) => (sid === SID ? partition.get(viewId) : undefined),
    getViewIds: () => [],
  }
}

/** 一个非空 guiTree 的挂载点条目（贡献数 > 0） */
function toolbarEntry(): ViewCacheEntry {
  return {
    viewId: 'composer.toolbar',
    pluginId: 'ext-x',
    guiTree: [{ type: 'ansi-text', props: { lines: ['toolbar'] } }],
    updatedAt: 1_760_000_000_000,
  }
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

/** 派发一次 ResizeObserver 实测宽（contentRect 只填本接线消费的 width 字段）+ 等重渲染 */
async function dispatchWidth(width: number): Promise<void> {
  const observer = ManualResizeObserverStub.created()[0]
  if (!observer) throw new Error('ResizeObserver 未创建：密度接线未挂载')
  observer.dispatch([{ contentRect: { width } as DOMRectReadOnly }])
  await nextTick()
}

/** 等 fit 收敛回路跑完（rAF 链；happy-dom 有 rAF） */
async function flushFitPasses(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })
  }
  await nextTick()
}

/**
 * 打桩底栏几何并派发 RO：可用宽 + 左右两簇占宽（fit 回路据二者之和判「放不放得下」）。
 * 右簇占宽按当前 `data-fit` 分级回落——模拟「形态收紧 → 需求宽下降」的真实收敛过程。
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
  Object.defineProperty(barEl, 'clientWidth', { value: avail, configurable: true })
  vi.spyOn(leftEl, 'getBoundingClientRect').mockReturnValue({ width: left } as DOMRect)
  vi.spyOn(rightEl, 'getBoundingClientRect').mockImplementation(
    () => ({ width: widthByFit[barEl.getAttribute('data-fit') ?? '0'] }) as DOMRect,
  )
  const observer = ManualResizeObserverStub.created()[0]
  observer.dispatch([{ target: barEl, contentRect: { width: avail } as DOMRectReadOnly }])
  await flushFitPasses()
}

/** 合流 chip 内的发丝分隔节点（V2：1px 竖线表达分组，替代原实心底） */
function separatorsInBar(): number {
  return bar()
    .findAll('span[aria-hidden="true"]')
    .filter((node) => node.classes().includes('w-px') && node.classes().includes('bg-border-strong')).length
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
  trayFixture.bashRunning = 2
  trayFixture.subagentRunning = 1
  ManualResizeObserverStub.install()
})

afterEach(() => {
  ManualResizeObserverStub.uninstall()
  wrapper?.unmount()
  wrapper = null
})

describe('底栏三簇与永不换行（D6）', () => {
  it('底栏 flex-nowrap：宽度不足只退化形态，不换行', () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    expect(bar().classes()).toContain('flex-nowrap')
    expect(bar().classes()).not.toContain('flex-wrap')
  })
})

describe('① 窄档托盘聚合单入口（层叠图标 + 运行数）', () => {
  it('窄档：托盘收为单入口，层叠图标 + 运行数 = 进行中合计；宽档：回到逐件按钮', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    // 宽档：逐件按钮在，聚合入口不在
    await dispatchWidth(700)
    expect(bar().attributes('data-tier')).toBe('expanded')
    expect(bar().attributes('data-slot-tray')).toBe('expanded')
    expect(bar().findAll('[data-testid="tray-builtin-button"]')).toHaveLength(2)
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)

    // 窄档：单入口（层叠图标 = built-in 类别 icon 若干）+ 运行数 2 + 1 = 3
    await dispatchWidth(400)
    expect(bar().attributes('data-slot-tray')).toBe('aggregated')
    const aggregate = bar().find('[data-testid="tray-aggregate-button"]')
    expect(aggregate.exists()).toBe(true)
    expect(aggregate.find('[data-testid="tray-aggregate-count"]').text()).toBe('3')
    expect(aggregate.find('[data-testid="tray-aggregate-pulse"]').exists()).toBe(true)
    expect(aggregate.findAll('svg').length).toBeGreaterThanOrEqual(2)
    expect(bar().findAll('[data-testid="tray-builtin-button"]')).toHaveLength(0)
  })

  it('托盘全无条目（三态之「全无」）→ 窄档也不渲染聚合入口（状态机 slot = absent，无死入口）', async () => {
    trayFixture.bashRunning = 0
    trayFixture.subagentRunning = 0
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(400)

    expect(bar().attributes('data-tier')).toBe('narrow')
    expect(bar().attributes('data-slot-tray')).toBe('absent')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)
  })
})

describe('② `»` 溢出菜单仅在确有被收起项时渲染（序 3）', () => {
  it('插件 toolbar 有贡献 + 窄档 → toolbar 收起、`»` 菜单出现；宽档 → toolbar 内联、无 `»`', async () => {
    const partition = reactive(new Map<string, ViewCacheEntry>([['composer.toolbar', toolbarEntry()]]))
    mountComposer(makeMountPointSource(partition))

    await dispatchWidth(700)
    expect(bar().attributes('data-slot-plugin-toolbar')).toBe('expanded')
    expect(bar().find('[data-testid="composer-overflow-menu"]').exists()).toBe(false)

    await dispatchWidth(560)
    expect(bar().attributes('data-tier')).toBe('compact')
    expect(bar().attributes('data-slot-plugin-toolbar')).toBe('collapsed-to-menu')
    expect(bar().find('[data-testid="composer-overflow-menu"]').exists()).toBe(true)
  })

  it('插件零贡献（默认安装）→ 任何档位都无 `»`（也不产生死入口）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    for (const width of [400, 560, 700]) {
      await dispatchWidth(width)
      expect(bar().find('[data-testid="composer-overflow-menu"]').exists()).toBe(false)
      expect(bar().attributes('data-slot-plugin-toolbar')).toBe('absent')
    }
  })
})

describe('③ 序 0 不退化：窄档下发送位（+ 添加内容）仍在', () => {
  it('400px 窄档：发送位与 `+` 都渲染，右簇形态为合流/合体（序 1/2）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(400)

    expect(bar().attributes('data-tier')).toBe('narrow')
    // 发送位（序 0）：四态之一必在（此处全 idle → send），title 含「发送」
    const sendButton = bar().findAll('button').find((n) => n.attributes('title')?.includes('发送'))
    expect(sendButton).toBeDefined()
    // `+` 添加内容（序 0）：真实 AddMenuPopover 触发器仍在底栏左簇
    const addButton = bar().findAll('button').find((n) => n.attributes('title') === '添加内容（附件 / 命令）')
    expect(addButton).toBeDefined()
    // 序 0 的 `+` 在左簇首位、发送位在右簇末位（三簇结构下两端锚定）
    const buttons = bar().findAll('button')
    expect(buttons[0]?.attributes('title')).toBe('添加内容（附件 / 命令）')
    expect(buttons[buttons.length - 1]?.attributes('title')).toContain('发送')
    // 序 1/2 合流形态生效（信息不丢，只是合成单 chip 容器）
    expect(bar().attributes('data-slot-capacity')).toBe('merged')
    expect(bar().attributes('data-slot-model')).toBe('merged')
    expect(bar().find('[data-testid="composer-capacity-merged"]').exists()).toBe(true)
    expect(bar().find('[data-testid="composer-model-merged"]').exists()).toBe(true)
  })
})

describe('④ ResizeObserver 实测驱动档位与形态（模拟容器宽度变化）', () => {
  it('400 → 560 → 700：narrow → compact → expanded，逐元素形态整组跟随状态机', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))

    await dispatchWidth(400)
    expect(bar().attributes('data-tier')).toBe('narrow')
    expect(bar().attributes('data-slot-capacity')).toBe('merged')
    expect(bar().attributes('data-slot-model')).toBe('merged')
    expect(bar().attributes('data-slot-tray')).toBe('aggregated')

    await dispatchWidth(560)
    expect(bar().attributes('data-tier')).toBe('compact')
    expect(bar().attributes('data-slot-capacity')).toBe('merged')
    expect(bar().attributes('data-slot-model')).toBe('merged')
    // 序 4 只在 narrow 生效（累计退化：compact 不含序 4）
    expect(bar().attributes('data-slot-tray')).toBe('expanded')
    expect(bar().find('[data-testid="tray-aggregate-button"]').exists()).toBe(false)

    await dispatchWidth(700)
    expect(bar().attributes('data-tier')).toBe('expanded')
    expect(bar().attributes('data-slot-capacity')).toBe('expanded')
    expect(bar().attributes('data-slot-model')).toBe('expanded')
    expect(bar().attributes('data-slot-tray')).toBe('expanded')
    expect(bar().find('[data-testid="composer-capacity-merged"]').exists()).toBe(false)
    expect(bar().find('[data-testid="composer-model-merged"]').exists()).toBe(false)
  })

  it('阈值边界按状态机常量归高档（640 → expanded，520 → compact）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))

    await dispatchWidth(640)
    expect(bar().attributes('data-tier')).toBe('expanded')
    await dispatchWidth(639)
    expect(bar().attributes('data-tier')).toBe('compact')
    await dispatchWidth(520)
    expect(bar().attributes('data-tier')).toBe('compact')
    await dispatchWidth(519)
    expect(bar().attributes('data-tier')).toBe('narrow')
  })

  it('卸载后 observer 断开（不再消费派发）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(400)
    const observer = ManualResizeObserverStub.created()[0]
    wrapper?.unmount()
    wrapper = null
    // disconnect 后 dispatch 不再触达组件（无异常即为断开；此处断言 DOM 已随卸载消失）
    observer?.dispatch([{ contentRect: { width: 700 } as DOMRectReadOnly }])
    await nextTick()
    expect(document.querySelector('[data-testid="composer-bar"]')).toBeNull()
  })
})

describe('⑤ fit 轴：实测放不下时逐级收紧右簇内容（方案 A 内容自适应）', () => {
  it('V2 合流态视觉：无实心底，分组由发丝分隔表达（两个合流组各一条）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(400)
    // 序 1 / 序 2 两组合流 → 各组内 1px 竖线分隔（替代原 bg-surface-2 实心 chip）
    expect(separatorsInBar()).toBe(2)
    const capacityChip = bar().find('[data-testid="composer-capacity-merged"]')
    expect(capacityChip.classes()).not.toContain('bg-surface-2')
  })

  it('放得下 → 不施加 fit 退化（data-fit = 0，容量+指标留在底栏）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(560)
    await dispatchFitGeometry(500, 80, 380)
    expect(bar().attributes('data-fit')).toBe('0')
    expect(bar().find('[data-testid="composer-capacity-merged"]').exists()).toBe(true)
  })

  it('放不下 → 收紧到刚好放得下的那一级即停（不到顶）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(400)
    // L0 需求 580 > 300；L1 380 > 300；L2 260 ≤ 300 → 停在 L2（右簇图标化）
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('2')
    // L2 未到 L3：容量+指标仍在底栏（只是图标化），`»` 里不出现收纳区
    expect(bar().find('[data-testid="composer-capacity-merged"]').exists()).toBe(true)
    expect(bar().find('[data-testid="composer-overflow-capacity-metrics"]').exists()).toBe(false)
  })

  it('一直放不下 → 顶格 L3：容量+指标退出底栏、进 `»` 菜单（模型/档位仍在）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(400)
    // 右簇恒 500：任何一级都放不下 → 顶格 L3
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 500, 2: 500, 3: 500 })
    expect(bar().attributes('data-fit')).toBe('3')
    // 底栏：容量+指标组消失（腾出宽度）
    expect(bar().find('[data-testid="composer-capacity-merged"]').exists()).toBe(false)
    // `»` 菜单：即使插件零贡献，也因 fit L3 的收纳项而出现
    const menu = bar().find('[data-testid="composer-overflow-menu"]')
    expect(menu.exists()).toBe(true)
    // 打开菜单：容量+指标整组收纳在内（详情浮层路径不变）
    await menu.find('button').trigger('click')
    expect(document.querySelector('[data-testid="composer-overflow-capacity-metrics"]')).not.toBeNull()
    // 序 0 与序 2 仍在底栏（切模型任何宽度可达）
    const addButton = bar().findAll('button').find((n) => n.attributes('title') === '添加内容（附件 / 命令）')
    expect(addButton).toBeDefined()
    const sendButton = bar().findAll('button').find((n) => n.attributes('title')?.includes('发送'))
    expect(sendButton).toBeDefined()
  })

  it('变宽 → 逐级放松回 full（迟滞：只在更宽裕时降级，不来回抖）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(400)
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 500, 2: 500, 3: 500 })
    expect(bar().attributes('data-fit')).toBe('3')
    // 容器大幅变宽 + 内容变窄 → 一路放松到 L0（600 仍属 compact：合流组回到底栏）
    await dispatchFitGeometry(600, 80, { 0: 300, 1: 200, 2: 150, 3: 120 })
    expect(bar().attributes('data-fit')).toBe('0')
    expect(bar().attributes('data-tier')).toBe('compact')
    expect(bar().find('[data-testid="composer-capacity-merged"]').exists()).toBe(true)
    // 收纳项消失 → 插件零贡献时 `»` 菜单一并消失（不留死入口）
    expect(bar().find('[data-testid="composer-overflow-menu"]').exists()).toBe(false)
  })

  it('同宽度下反复派发不抖（级数稳定）', async () => {
    mountComposer(makeMountPointSource(reactive(new Map())))
    await dispatchWidth(400)
    await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    expect(bar().attributes('data-fit')).toBe('2')
    for (let i = 0; i < 4; i += 1) {
      await dispatchFitGeometry(300, 80, { 0: 500, 1: 300, 2: 180, 3: 100 })
    }
    expect(bar().attributes('data-fit')).toBe('2')
  })
})
