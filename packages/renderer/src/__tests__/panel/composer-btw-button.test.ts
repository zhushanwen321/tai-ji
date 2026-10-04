/**
 * ComposerBtwButton / composer btw 入口测试（btw-question D7 + §1.4 badge 两态基础，M3-b）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒 DOM）：首屏按钮在左簇（title 文案）/ show-btw=false 与无 session 不出入口 /
 *   badge 计数 Σ（含 9+ 封顶与计数 title）/ 待处理徽点两态（pending>0 显 + 计数 title、
 *   双零不显、与计数角标同屏并列，U1）/ 进视口即清、视口内不计、离开再计 / 点击开 drawer
 *   btw tab / 切主会话 badge 归属各自主会话且切回恢复（D7③④，S10 单测面）
 * - 观察者（形态）：三档宽度（700/560/400）按钮常驻 + `+` 仍居左簇首位、发送位仍右锚
 *   （退化序登记 = 序 0 不退化，不破坏既有布局）
 * - 构建者（白盒）：COMPOSER_BTW_BUTTON_DEGRADATION_ORDER 登记值 = 0
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 补 btw 域（本文件 badge 数据源，
 * 经 composerApiModuleWithChatAndBtw 工厂——chat+getHistory+btw 增量组，btw spy 单例
 * composerBtwApiSpy 供用例内 mockResolvedValue 驱动）；useChat / useNewTaskFlow /
 * stores/session 壳 mock 经 composer-shell-mount 装配；useTrayCounts 替身（全无条目 →
 * 托盘不渲染，左簇按钮位次断言无干扰）；真实 chat store
 * （badge 未读计数从 setMessages 真实分区增长）+ 真实 core drawer 域（入口点击 / 视口判定）。
 * i18n 由 vitest-i18n-setup 全局提供（t 取 zh-CN 真实文案，断言中文无需另行 mock）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-btw-button.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, nextTick, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@taiji/shared'
// helper import 先于 Composer：其链上 import '@/api' 即触发 api mock 工厂执行（sync
// 工厂在 import 求值期解引用 helper 绑定），彼时须已初始化
import '../helpers/composer-shell-mount'
import { composerApiModuleWithChatAndBtw, composerBtwApiSpy, composerChildStubs, makeComposerInputMock } from '../helpers/composer-mount'
import {
  bindDrawerSessionId,
  drawerControl,
  getDrawerControlState,
  openDrawerTab,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'
import type { ViewHostSource } from '@taiji/ui/extension-host'
import { ManualResizeObserverStub } from '../effects/_virtua-mock-helper'
import Composer from '@/components/panel/Composer.vue'
import { COMPOSER_BTW_BUTTON_DEGRADATION_ORDER } from '@/components/panel/tray/use-composer-bar-density'
import type { UseTrayCountsReturn } from '@/components/panel/tray/useTrayCounts'
import { makeTrayCountsStub } from './tray/tray-counts-stub'
import { useChatStore } from '@/stores/chat'
import { setBtwReclaimReminder } from '@/composables/panel/btw-pending-bookkeeping'
import { __resetBtwPendingBookkeepingForTest } from '@/composables/panel/useBtwTabData'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { dispatchGlobal } from '@taiji/core/transport/api'

// ── tray 数据面替身：全无条目（三态「全无」→ 托盘不渲染，左簇位次断言无干扰）──
vi.mock('@/components/panel/tray/useTrayCounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/panel/tray/useTrayCounts')>()
  const stubState = {
    bashRunning: [],
    bashEnded: [],
    bashLoaded: true,
    subagentRunning: [],
    subagentEnded: [],
    subagentLoading: false,
    workflowRunning: [],
    workflowEnded: [],
    workflowLoading: false,
  }
  return {
    ...actual,
    useTrayCounts: (): UseTrayCountsReturn => ({
      ...makeTrayCountsStub(stubState),
      bashPartition: computed(() => ({ tasks: [], loaded: true, corrupted: false, fetchFailed: false })),
      errors: { subagent: computed(() => null), workflow: computed(() => null) },
      retry: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

// ── api mock：chat 组（spy 转发 + getHistory 回放腿空快照）+ btw 域（badge 数据源）──
vi.mock('@/api', () => composerApiModuleWithChatAndBtw())

// ── 子组件 stub（AddMenuPopover 保持真实：`+` 首位是「既有布局不破坏」断言对象）──
const { ComposerInputMock } = makeComposerInputMock()
// GenStatsTriggers 专属空 stub（composerChildStubs 未覆盖的本文件特例）
const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
// 从共享 stub 剔除 AddMenuPopover（保持真实），其余兄弟子组件转发 composerChildStubs
const { AddMenuPopover: _addMenuPopoverReal, ...childStubs } = composerChildStubs
const stubs = {
  ComposerInput: ComposerInputMock,
  ...childStubs,
  GenStatsTriggers: SIMPLE,
}

const SID = 's-btw-btn'
const SID_B = 's-btw-btn-b'
/** 挂载点空源（插件零贡献；inject 不缺供） */
const EMPTY_MOUNT_SOURCE: ViewHostSource = { getView: () => undefined, getViewIds: () => [] }

let wrapper: VueWrapper | null = null
let boundSid: Ref<string | null>

function msg(id: string): Message {
  return { id, role: 'assistant', content: 'x', status: 'complete', timestamp: 0 }
}

function mountComposer(
  props: { sessionId?: string | null; showBtw?: boolean } = {},
): VueWrapper {
  const sessionId = props.sessionId === undefined ? SID : props.sessionId
  wrapper = mount(Composer, {
    props: {
      sessionId,
      ...(props.showBtw === undefined ? {} : { showBtw: props.showBtw }),
    },
    global: {
      stubs,
      provide: { [VIEW_HOST_SOURCE_KEY as symbol]: EMPTY_MOUNT_SOURCE },
    },
  })
  return wrapper
}

function bar(): VueWrapper {
  if (!wrapper) throw new Error('composer not mounted')
  const node = wrapper.find('[data-testid="composer-bar"]')
  if (!node.exists()) throw new Error('composer-bar missing')
  return node
}

function badge(): ReturnType<VueWrapper['find']> {
  if (!wrapper) throw new Error('composer not mounted')
  return wrapper.find('[data-testid="composer-btw-badge"]')
}

/** 待处理徽点（badge 两态的 pending 半边，U1） */
function pendingDot(): ReturnType<VueWrapper['find']> {
  if (!wrapper) throw new Error('composer not mounted')
  return wrapper.find('[data-testid="composer-btw-pending"]')
}

function buttonTitle(): string | undefined {
  if (!wrapper) throw new Error('composer not mounted')
  return bar().find('[data-testid="composer-btw-button"]').attributes('title')
}

/** 拉取 promise 链 + watch 调度 + 渲染落地 */
async function settle(): Promise<void> {
  await flushPromises()
  await nextTick()
  await nextTick()
}

/** 派发一次 ResizeObserver 实测宽（密度接线用）+ 等重渲染 */
async function dispatchWidth(width: number): Promise<void> {
  const observer = ManualResizeObserverStub.created()[0]
  if (!observer) throw new Error('ResizeObserver 未创建：密度接线未挂载')
  observer.dispatch([{ contentRect: { width } as DOMRectReadOnly }])
  await nextTick()
}

/** 单线 badge 用例共用起步：list=[t1] + 挂载 + settle，返回真 chatStore（setMessages 驱动） */
async function mountSingleLineWithChat(): Promise<ReturnType<typeof useChatStore>> {
  composerBtwApiSpy.list.mockResolvedValue([{ vid: 'btw:t1' }])
  mountComposer()
  await settle()
  return useChatStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  composerBtwApiSpy.list.mockResolvedValue([])
  ManualResizeObserverStub.install()
  boundSid = ref(SID)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
  __clearSessionCleanupRegistryForTest()
  __resetBtwPendingBookkeepingForTest() // 模块级待处理簿记（含回收提醒集合）逐用例清零
})

afterEach(() => {
  ManualResizeObserverStub.uninstall()
  wrapper?.unmount()
  wrapper = null
})

describe('入口渲染与 show-btw 实例开关（D7 ③入口）', () => {
  it('首屏：composer 左簇渲染 btw 按钮（title=旁路提问），`+` 仍居左簇首位', async () => {
    mountComposer()
    await settle()

    const btn = bar().find('[data-testid="composer-btw-button"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('旁路提问')

    const buttons = bar().findAll('button')
    expect(buttons[0]?.attributes('title')).toBe('添加内容（附件 / 命令）')
    expect(buttons[1]?.attributes('title')).toBe('旁路提问')
  })

  it('show-btw=false：不出 btw 入口（drawer 内实例防递归），左簇其余元素不受影响', async () => {
    const w = mountComposer({ showBtw: false })
    await settle()

    expect(w.find('[data-testid="composer-btw-button"]').exists()).toBe(false)
    expect(bar().findAll('button')[0]?.attributes('title')).toBe('添加内容（附件 / 命令）')
  })

  it('无 session：不出 btw 入口（badge 数据面需主会话；真 landing 态不受影响）', async () => {
    const w = mountComposer({ sessionId: null })
    await settle()

    expect(w.find('[data-testid="composer-btw-button"]').exists()).toBe(false)
  })
})

describe('badge 两态基础：聚合 Σ unread + 清除 = 线内容进视口（§1.4 / D8 未读行）', () => {
  it('聚合 = 当前主会话名下线的 Σ：逐线累加、title 换计数文案、>9 封顶 9+', async () => {
    composerBtwApiSpy.list.mockResolvedValue([{ vid: 'btw:t1' }, { vid: 'btw:t2' }])
    mountComposer()
    await settle()
    const chat = useChatStore()

    // 常态归零：有线无未读 → 不渲染角标
    expect(badge().exists()).toBe(false)

    chat.setMessages('btw:t1', [msg('a1')])
    await settle()
    expect(badge().text()).toBe('1')
    expect(bar().find('[data-testid="composer-btw-button"]').attributes('title')).toBe('1 条未读旁路回复')

    // Σ per-line：t1 再来一条 + t2 一条 = 3
    chat.setMessages('btw:t1', [msg('a1'), msg('a2')])
    chat.setMessages('btw:t2', [msg('b1')])
    await settle()
    expect(badge().text()).toBe('3')
    expect(bar().find('[data-testid="composer-btw-button"]').attributes('title')).toBe('3 条未读旁路回复')

    // 封顶 9+
    chat.setMessages(
      'btw:t1',
      Array.from({ length: 12 }, (_, i) => msg(`x${i}`)),
    )
    await settle()
    expect(badge().text()).toBe('9+')
  })

  it('清除 = 线内容进视口；视口内新回复不计；关面板后再计', async () => {
    const chat = await mountSingleLineWithChat()

    chat.setMessages('btw:t1', [msg('a1')])
    await settle()
    expect(badge().text()).toBe('1')

    // 进视口 = drawer 开在 btw tab + 选中该线（BtwPanel 自动选中的等价写入）
    openDrawerTab('btw')
    drawerControl.setBtwView('btw:t1')
    await settle()
    expect(badge().exists()).toBe(false) // 用户可见 DOM：角标消失

    // 视口内到达：不计
    chat.setMessages('btw:t1', [msg('a1'), msg('a2')])
    await settle()
    expect(badge().exists()).toBe(false)

    // 关面板：离开视口，新回复再计
    drawerControl.close()
    await settle()
    chat.setMessages('btw:t1', [msg('a1'), msg('a2'), msg('a3')])
    await settle()
    expect(badge().text()).toBe('1')
  })

  it('badge 归属各自主会话：切走不串台、切回恢复（D7③④，S10 单测面）', async () => {
    composerBtwApiSpy.list.mockImplementation((sid: string) =>
      Promise.resolve(sid === SID ? [{ vid: 'btw:ta' }] : [{ vid: 'btw:tb' }]),
    )
    const w = mountComposer()
    await settle()
    const chat = useChatStore()

    chat.setMessages('btw:ta', [msg('a1')])
    await settle()
    expect(badge().text()).toBe('1')

    // 切到 B：badge 归 B 分区（A 的未读不串台）
    await w.setProps({ sessionId: SID_B })
    await settle()
    expect(badge().exists()).toBe(false)

    chat.setMessages('btw:tb', [msg('b1')])
    await settle()
    expect(badge().text()).toBe('1')

    // 切回 A：分区保留，badge 恢复
    await w.setProps({ sessionId: SID })
    await settle()
    expect(badge().text()).toBe('1')
  })
})

describe('badge 两态：待处理徽点与 unread 计数并列呈现（§1.4 裁决 U1 + D8 终态机）', () => {
  it('双零（unread=0 且 pending=0）：计数角标与待处理徽点都不渲染，title 保持入口语义', async () => {
    composerBtwApiSpy.list.mockResolvedValue([{ vid: 'btw:t1' }])
    mountComposer()
    await settle()

    // 用户可见 DOM：两态都不显（常态归零）
    expect(badge().exists()).toBe(false)
    expect(pendingDot().exists()).toBe(false)
    expect(buttonTitle()).toBe('旁路提问')
  })

  it('pending>0：待处理徽点渲染 + title 换待处理计数文案（Σ per-line 待处理线数）；清除后归零不显', async () => {
    composerBtwApiSpy.list.mockResolvedValue([{ vid: 'btw:t1' }, { vid: 'btw:t2' }])
    mountComposer()
    await settle()
    expect(pendingDot().exists()).toBe(false)

    // 置位一条线（回收提醒 setter = D8 终态机第四行数据源）→ 徽点 + 计数 title
    setBtwReclaimReminder('btw:t1', true)
    await settle()
    expect(pendingDot().exists()).toBe(true)
    expect(buttonTitle()).toBe('1 条旁路线待处理')

    // Σ per-line：第二条线也待处理 → 2
    setBtwReclaimReminder('btw:t2', true)
    await settle()
    expect(buttonTitle()).toBe('2 条旁路线待处理')

    // 清除支：提醒全清 → 双零不显、title 回入口语义
    setBtwReclaimReminder('btw:t1', false)
    setBtwReclaimReminder('btw:t2', false)
    await settle()
    expect(pendingDot().exists()).toBe(false)
    expect(buttonTitle()).toBe('旁路提问')
  })

  it('reclaimImminent 消费接线：拉取置位 → 徽点 + 计数 title 可见；state 帧广播翻转 false → 双双回落（用户可见 DOM）', async () => {
    composerBtwApiSpy.list.mockResolvedValue([{ vid: 'btw:t1', reclaimImminent: true }])
    mountComposer()
    await settle()

    // 使用者黑盒：数据源 = 拉取 reply 的 reclaimImminent（非直接 setter）→ badge 待处理态可见
    expect(pendingDot().exists()).toBe(true)
    expect(buttonTitle()).toBe('1 条旁路线待处理')

    // runtime 回收提醒翻转广播（live 帧 global 通道路由）→ 集合清除 → badge 聚合回落
    dispatchGlobal({
      type: 'btw.list',
      payload: { mainSid: SID, threads: [{ vid: 'btw:t1', reclaimImminent: false }] },
    })
    await settle()

    expect(pendingDot().exists()).toBe(false)
    expect(buttonTitle()).toBe('旁路提问')
  })

  it('两态并列：unread 计数角标（右上）与待处理徽点（右下）同屏共存；title 待处理优先', async () => {
    const chat = await mountSingleLineWithChat()

    // 先让消息增长落地（D8 回收提醒清除支 = 线内容增长即清；与置位同拍会被抢先清掉）
    chat.setMessages('btw:t1', [msg('a1')])
    await settle()
    setBtwReclaimReminder('btw:t1', true)
    await settle()

    // 并列呈现：计数与徽点各自可见（drawer 关着也可见，U1 修的正是这个静默盲区）
    expect(badge().text()).toBe('1')
    expect(pendingDot().exists()).toBe(true)
    expect(buttonTitle()).toBe('1 条旁路线待处理')
  })
})

describe('点击入口与退化序登记（D7 + use-composer-bar-density 序 0）', () => {
  it('点击按钮 = 打开 drawer 并切到 btw tab（D7 唯一入口）', async () => {
    const w = mountComposer()
    await settle()
    const btn = w.find('[data-testid="composer-btw-button"]')
    expect(btn.exists()).toBe(true) // 使用者可见面

    await btn.trigger('click')
    const drawer = getDrawerControlState()
    expect(drawer.isOpen).toBe(true)
    expect(drawer.activeTab).toBe('btw')
  })

  it('退化序登记（序 0 不退化）：700/560/400 三档按钮常驻，`+` 居首、发送位右锚（既有布局不破坏）', async () => {
    const w = mountComposer()
    await settle()
    expect(COMPOSER_BTW_BUTTON_DEGRADATION_ORDER).toBe(0)

    for (const width of [700, 560, 400]) {
      await dispatchWidth(width)
      const node = bar()
      expect(node.find('[data-testid="composer-btw-button"]').exists()).toBe(true)
      const buttons = node.findAll('button')
      expect(buttons[0]?.attributes('title')).toBe('添加内容（附件 / 命令）')
      expect(buttons[buttons.length - 1]?.attributes('title')).toContain('发送')
    }
    // 密度档位本身如实驱动（证明确实经过退化，而非恒 fit=0 展开）
    // [HISTORICAL] 原断言 data-tier='narrow'（固定阈值 tier 轴：700/560/400 → expanded/mid/narrow）
    // ——该轴已随三步聚合实测化退役；现行轴 = data-fit（0–3 实测 fit 级，判据 = 可用宽 vs 两簇
    // 占宽）。jsdom 无真实几何（clientWidth/占宽恒 0 → 需求 0 → 恒 fit=0），故本探针须打桩几何
    // （composer-bar-density-wiring 的 dispatchFitGeometry 同法）才走退化；data-fit 0→3 全档
    // 由 wiring 测试的纯接线面承接，此处只证全量挂载下回路真实驱动。
    const probeBar = bar().element as HTMLElement
    const probeLeft = probeBar.querySelector<HTMLElement>('[data-composer-cluster="left"]')
    const probeRight = probeBar.querySelector<HTMLElement>('[data-composer-cluster="right"]')
    if (!probeLeft || !probeRight) throw new Error('底栏两簇节点缺失：模板与 fit 回路不同步？')
    Object.defineProperty(probeBar, 'clientWidth', { value: 200, configurable: true })
    vi.spyOn(probeLeft, 'getBoundingClientRect').mockReturnValue({ width: 150 } as DOMRect)
    vi.spyOn(probeRight, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect)
    ManualResizeObserverStub.created()[0].dispatch([
      { target: probeBar, contentRect: { width: 200 } as DOMRectReadOnly },
    ])
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })
    await settle()
    expect(Number(bar().attributes('data-fit'))).toBeGreaterThan(0)
  })
})
