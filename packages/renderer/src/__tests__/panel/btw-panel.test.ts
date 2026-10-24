/**
 * BtwPanel 组件测试（btw-question D7，M3-a）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：session.list {surface:'btw', mainSessionId} 拉取（W4b，btw.list 退役）
 *   + loadSeq 乱序检查回写 captured 分区；
 *   选中唯一源 = core drawer 分区 selectedBtwSessionId（setBtwView 写入，D5 豁免同源）
 * - 使用者（黑盒 DOM）：空态三要素 / 线 chip 渲染与点击切线 / 新建提问 → fork pill 三态 /
 *   切焦点会话线列表不串台 / 加载失败可见可重试 / 创建失败可见可恢复
 * - 观察者（形态）：首屏冒烟（drawer-btw-tab + 无头行 chip 条顶置 + 关键 testid 存在）；Composer 装配
 *   variant=panel + show-btw=false（防递归出 btw 入口，prop 声明归 M3-b，本处只写调用处）
 * - M3-c 行为范围：formQuestions 请求 → 内联确认条降档 DOM（问题/选项按钮/Other/text 输入/
 *   Submit 门；纯函数直测归 __tests__/composables/panel/use-btw-interaction.test.ts）
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 局部替换 btw 域（门面其余域走 actual）；
 * MessageStream / Composer stub 为透传 attrs 的占位 div——渲染树装配断言经 DOM 属性
 * （session-id / variant / show-btw）落使用者可见部分，对话流渲染本身归 MessageStream 既有测试族。
 * i18n 由 vitest-i18n-setup 全局 mock（t 从 zh-CN 取真实文案，断言中文文案无需另行 mock）。
 *
 * [W2 缺陷修复] 线视图激活用例另局部 mock 两个入口（断言锚点，其余成员保真）：
 * useSidebar（只取 refreshLiveState——core 状态层拉取对账入口，缓存缺失门控在 core 侧
 * live-state-pull.test.ts 锁定）与 useChat.ensureStreamSubscription（线消息帧订阅建立）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/btw-panel.test.ts
 */
// helper import 必须先于项目内模块（@/api mock factory 在模块图加载期执行，TDZ 约束同 composer-mount 各消费文件）
import { composerApiModuleActualWithBtw, composerBtwApiMock, btwLineGroups } from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import {
  bindDrawerSessionId,
  useBtwSelection,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import BtwPanel from '@/components/panel/BtwPanel.vue'
import { useSessionStore } from '@/stores/session'
import { useChatStore } from '@/stores/chat'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ServerMessageMap, SessionSummary } from '@taiji/shared'

// btw 具名类型走 indexed-access（shared 包出口未挂具名，SSOT = shared protocol.ts）
type BtwForkState = ServerMessageMap['btw.create']['forkState']

// ── [W2 缺陷修复] 线视图激活的两个入口 mock（断言锚点）────────────────────
// useSidebar 只被 BtwPanel 消费（本文件模块图内无其他 import 方），整模块替换为
// refreshLiveState 单键 spy；useChat 保真展开、只替换 ensureStreamSubscription。
const refreshLiveStateSpy = vi.hoisted(() => vi.fn())
const ensureStreamSubscriptionSpy = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ refreshLiveState: refreshLiveStateSpy }),
}))
vi.mock('@/composables/features/chat/useChat', async (importActual) => {
  const actual = await importActual<typeof import('@/composables/features/chat/useChat')>()
  return { ...actual, ensureStreamSubscription: ensureStreamSubscriptionSpy }
})

// ── @/api 门面局部 mock：只替换 btw 域（三元消费方 = 本面板唯一数据入口）──
vi.mock('@/api', (importActual) => composerApiModuleActualWithBtw(importActual))
// 断言锚点：btw 域 spy 单例（helper 持有，播种/断言经别名）
const apiMock = composerBtwApiMock

// ── MessageStream / Composer 占位 stub（attrs 全透传 → DOM 属性断言装配侧）──
vi.mock('@/components/panel/MessageStream.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return {
    default: dc({
      name: 'MessageStream',
      setup: () => () => hs('div'),
    }),
  }
})
vi.mock('@/components/panel/Composer.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return {
    default: dc({
      name: 'Composer',
      setup: () => () => hs('div'),
    }),
  }
})

const MAIN_A = 's-btw-a'
const MAIN_B = 's-btw-b'

/** 分区键绑定 ref（每用例新建；模拟 PanelContainer 绑 focusedSessionId） */
let boundSid: Ref<string | null>

function mountPanel(sessionId: string | null) {
  return mount(BtwPanel, { props: { sessionId } })
}

/** 等待 list/create promise 链 + 渲染落地（loadSeq 回写 → computed → DOM） */
async function settle(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  await flushPromises()
  await nextTick()
  await nextTick()
}

/** 读面板内部线条目（<script setup> 的 state 经 wrapper.vm 代理可读，同
 *  model-select-popover.test.ts 范式）——cwd 无 DOM 承载，白盒断言字段值。 */
function optimisticEntry(wrapper: Awaited<ReturnType<typeof mountPanel>>): SessionSummary {
  const state = (wrapper.vm as unknown as { state: { threads: SessionSummary[] } }).state
  return state.threads[state.threads.length - 1]
}

enableAutoUnmount(afterEach)

beforeEach(() => {
  // M3-c：BtwPanel 经 useBtwInteraction → useExtensionUI 消费 extensionUIStore（pinia 必需）
  setActivePinia(createPinia())
  vi.resetAllMocks()
  boundSid = ref<string | null>(MAIN_A)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
})

describe('BtwPanel 首屏冒烟与线列表（观察者 + 使用者）', () => {
  it('首屏结构：drawer-btw-tab + 空态三要素 DOM 存在；无头行（r5 对齐 demo：chip 条顶置），空态入口唯一 = btw-empty-new', async () => {
    apiMock.list.mockResolvedValue([])
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    expect(wrapper.find('[data-testid="drawer-btw-tab"]').exists()).toBe(true)
    expect(apiMock.list).toHaveBeenCalledWith({ surface: 'btw', mainSessionId: MAIN_A })

    const empty = wrapper.find('[data-testid="btw-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('还没有旁路线') // 说明句（空态三要素之一）
    expect(wrapper.find('[data-testid="btw-new-thread"]').exists()).toBe(false) // 头行已删：空态下无线列表右簇钮
    expect(empty.find('[data-testid="btw-empty-new"]').exists()).toBe(true) // Primary 入口
    expect(wrapper.find('[data-testid="btw-thread-list"]').exists()).toBe(false) // 无线不渲染列表
  })

  it('线列表渲染 chip + 右簇新建钮恒在可视区 + 自动选中最新线 + MessageStream/Composer 装配侧（D7②）', async () => {
    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }, { id: 'pi-2' }))
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    const chips = wrapper.findAll('[data-testid="btw-thread-chip"]')
    expect(chips).toHaveLength(2)
    // W4b label 重定义（§3.4.3）：chip 标签 = 线 label（btw-<序号> 可区分形态）——
    // 旧形态全部同名 basename(cwd) 只能靠截断 sessionId 区分；session id 仍走
    // data-session-id 属性（选择器契约不变）。
    expect(chips[0].text()).toContain('btw-1')
    expect(chips[1].text()).toContain('btw-2')
    expect(chips[0].attributes('data-session-id')).toBe('pi-1')
    expect(chips[1].attributes('data-session-id')).toBe('pi-2')

    // r5 结构对齐：新建入口承载到 chip 行右簇（demo 无头行形态，入口在滚动区外恒可视）
    expect(wrapper.find('[data-testid="btw-new-thread"]').exists()).toBe(true)

    // 默认选中最新线 → 会话区装配到该线 session id
    const stream = wrapper.find('[data-testid="btw-stream"]')
    expect(stream.exists()).toBe(true)
    expect(stream.attributes('session-id')).toBe('pi-2')

    const composer = wrapper.find('[data-testid="btw-composer"]')
    expect(composer.exists()).toBe(true)
    expect(composer.attributes('session-id')).toBe('pi-2')
    expect(composer.attributes('variant')).toBe('panel')
    expect(composer.attributes('show-btw')).toBe('false') // 防递归出 btw 入口（④ 调用处）

    // 构建者：选中写入 core drawer 分区（与 getViewedVids D5 豁免同源，无第二副本）
    expect(useBtwSelection().selectedBtwSessionId.value).toBe('pi-2')
    // 列表加载完成后 loading 收尾（空态不误显）
    expect(wrapper.find('[data-testid="btw-empty"]').exists()).toBe(false)
  })

  it('对话流字号域（chat-font-scope）：composer 带挂 data-fs-scope=chat——btw 输入区跟 chat 档非 drawer chrome', async () => {
    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }))
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    // composer 带（含内联确认条）跟 chat 档：与主面板 composer（main-area chat scope 内）同语义。
    // 流根的 chat scope 归 MessageStream 组件本体（wire 测试 TC-w4-9c 已断真实组件）——
    // 本套件 MessageStream 为透传 attrs 的 stub div，组件内部属性不在断言范围。
    const band = wrapper.find('[data-testid="btw-interaction"]')
    expect(band.exists()).toBe(true)
    expect(band.attributes('data-fs-scope')).toBe('chat')
  })

  it('列表携带的线（非本运行创建）不渲染 fork pill——session.list 条目无 forkState，结构上不可回填', async () => {
    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }, { id: 'pi-2' }))
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    expect(wrapper.find('[data-testid="btw-fork-pill"]').exists()).toBe(false)
    // 切线往返后仍无 pill（进程内亦无创建记录）
    await wrapper
      .find('[data-testid="btw-thread-chip"][data-session-id="pi-1"]')
      .trigger('click')
    await nextTick()
    await wrapper
      .find('[data-testid="btw-thread-chip"][data-session-id="pi-2"]')
      .trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="btw-fork-pill"]').exists()).toBe(false)
  })

  it('点击 chip 切线：会话区跟随 + 选中态样式（itab 胶囊型 border+surface-hover solid hover tone）+ 分区同步', async () => {
    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }, { id: 'pi-2' }))
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    const chip1 = wrapper.find('[data-testid="btw-thread-chip"][data-session-id="pi-1"]')
    expect(chip1.attributes('aria-pressed')).toBe('false')
    await chip1.trigger('click')
    await nextTick()

    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('pi-1')
    expect(wrapper.find('[data-testid="btw-composer"]').attributes('session-id')).toBe('pi-1')
    expect(chip1.attributes('aria-pressed')).toBe('true')
    // ui-replica M5：chip 形态对齐 demo .itab 胶囊（选中 border + surface-hover 底 + fg；
    // 2026-10-14 全族迁移：旧 border-strong + bg-bg-elevated 浮层档退役，选中态 = solid hover tone）
    expect(chip1.classes()).toContain('border-border')
    expect(chip1.classes()).toContain('bg-surface-hover')
    expect(chip1.classes()).toContain('text-neutral-fg')
    expect(useBtwSelection().selectedBtwSessionId.value).toBe('pi-1')
  })
})

describe('BtwPanel 新建线与 fork pill 三态（D3 口径）', () => {
  it.each<[BtwForkState, string]>([
    ['none', '无快照（源快照不可用）'],
    ['truncated', '快照截断（进行中 turn 未完整带入）'],
    ['full', '已含主对话快照'],
  ])('create reply forkState=%s → pill 文案「%s」且切到新线', async (forkState, copy) => {
    apiMock.list.mockResolvedValue([])
    apiMock.create.mockResolvedValue({ sessionId: 'pi-9', mainSid: MAIN_A, forkState })

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    await wrapper.find('[data-testid="btw-empty-new"]').trigger('click')
    await settle(wrapper)

    expect(apiMock.create).toHaveBeenCalledWith(MAIN_A)
    const pill = wrapper.find('[data-testid="btw-fork-pill"]')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain(copy)
    // 新线入列表 + 会话区切到新线（create reply 即选中与 pill 的唯一数据源）
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-session-id="pi-9"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('pi-9')
    expect(useBtwSelection().selectedBtwSessionId.value).toBe('pi-9')
  })

  it('即时入列条目 cwd = 所属主会话 cwd（§5-W4b 派生规则；不写主会话 id）', async () => {
    // 主会话 summary 进 session store（侧栏列表权威持有 cwd）；线列表为空（空态新建）
    useSessionStore().appendSession({
      id: MAIN_A,
      label: 'main-a',
      cwd: '/repo/main',
      status: 'idle',
      lastActiveAt: 0,
    })
    apiMock.list.mockResolvedValue([])
    apiMock.create.mockResolvedValue({ sessionId: 'pi-9', mainSid: MAIN_A, forkState: 'none' })

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    await wrapper.find('[data-testid="btw-empty-new"]').trigger('click')
    await settle(wrapper)

    const entry = optimisticEntry(wrapper)
    expect(entry.id).toBe('pi-9')
    // 设计 §5-W4b：线条目 cwd = 所属主会话 cwd（runtime toLineSummary / mock
    // buildBtwLineEntries 同口径）。主会话 id 不得落进 cwd 字段。
    expect(entry.cwd).toBe('/repo/main')
    expect(entry.cwd).not.toBe(MAIN_A)
    expect(entry.status).toBe('idle')
    expect(typeof entry.lastActiveAt).toBe('number')
  })

  it('即时入列条目 cwd 兜底取同分区已拉取线条目 cwd（session store 无主会话时）', async () => {
    // 无线列表先行拉取（其 cwd 即主会话 cwd 的权威投影）；session store 不播种主会话
    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }))
    apiMock.create.mockResolvedValue({ sessionId: 'pi-9', mainSid: MAIN_A, forkState: 'none' })

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    await wrapper.find('[data-testid="btw-new-thread"]').trigger('click')
    await settle(wrapper)

    const entry = optimisticEntry(wrapper)
    expect(entry.id).toBe('pi-9')
    expect(entry.cwd).toBe('/repo/main')
    expect(entry.cwd).not.toBe(MAIN_A)
  })

  it('创建失败：行内错误可见（含原因）+ 入口保持可用（P2 可恢复）', async () => {
    apiMock.list.mockResolvedValue([])
    apiMock.create.mockRejectedValue(new Error('fork source missing'))

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    await wrapper.find('[data-testid="btw-empty-new"]').trigger('click')
    await settle(wrapper)

    const err = wrapper.find('[data-testid="btw-create-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('创建旁路线失败')
    expect(err.text()).toContain('fork source missing')
    // 失败不锁死入口：按钮未禁用，可直接重试（失败发生在空态，chip 行右簇钮未渲染）
    expect(wrapper.find('[data-testid="btw-empty-new"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="btw-new-thread"]').exists()).toBe(false)
  })
})

describe('BtwPanel 焦点绑定（D7②④）与失败路径', () => {
  it('切焦点会话 → 线列表按新 mainSid 重新拉取不串台；切回恢复（DOM 面）', async () => {
    apiMock.list.mockImplementation(async (q: { mainSessionId?: string }) =>
      q.mainSessionId === MAIN_A ? btwLineGroups({ id: 'a-1' }) : btwLineGroups({ id: 'b-1' }),
    )

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-session-id="a-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('a-1')

    // 切到 B（模拟焦点切换：分区键先于 props 更新——生产由 focusedSessionId/leaf 同源同帧保证）
    boundSid.value = MAIN_B
    await wrapper.setProps({ sessionId: MAIN_B })
    await settle(wrapper)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-session-id="b-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-session-id="a-1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('b-1')

    // 切回 A：重新拉取 + 恢复 A 的线（分区隔离，无 B 泄漏）
    boundSid.value = MAIN_A
    await wrapper.setProps({ sessionId: MAIN_A })
    await settle(wrapper)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-session-id="a-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-session-id="b-1"]').exists()).toBe(false)
    expect(apiMock.list.mock.calls.filter(([q]) => (q as { mainSessionId?: string }).mainSessionId === MAIN_A)).toHaveLength(2)
  })

  it('加载失败：行内错误 + 重试恢复（P2 可见可恢复）', async () => {
    apiMock.list.mockRejectedValueOnce(new Error('rpc timeout'))

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    const err = wrapper.find('[data-testid="btw-load-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('线列表加载失败')
    expect(err.text()).toContain('rpc timeout')
    expect(wrapper.find('[data-testid="btw-empty"]').exists()).toBe(false) // 错误态不与空态混显

    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }))
    await wrapper.find('[data-testid="btw-load-retry"]').trigger('click')
    await settle(wrapper)

    expect(wrapper.find('[data-testid="btw-load-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-session-id="pi-1"]').exists()).toBe(true)
  })

  it('无焦点会话（sessionId null）：不拉列表 + 入口禁用 + 空态可见', async () => {
    const wrapper = mountPanel(null)
    await settle(wrapper)

    expect(apiMock.list).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="btw-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-empty-new"]').attributes('disabled')).toBeDefined()
    // 无选中线 → 会话区不装配
    expect(wrapper.find('[data-testid="btw-stream"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="btw-composer"]').exists()).toBe(false)
  })
})

describe('BtwPanel 内联确认条表单降档（M3-c 行为范围，useBtwInteraction 消费链）', () => {
  it('formQuestions 请求 → 确认条渲染问题文本 + choice 选项按钮 + Other/text 单行输入', async () => {
    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }))
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    // 自动选中唯一线（latest = pi-1）→ 交互区挂载到该线 session id
    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('pi-1')

    // 驱动侧 = 生产 bus 订阅的等价写入（store 是 pending SSOT，addRequest 与
    // useExtensionUI 订阅路径写入同一分区）；归一化纯函数群直测见
    // src/__tests__/composables/panel/use-btw-interaction.test.ts
    const store = useExtensionUIStore()
    store.addRequest('pi-1', {
      sessionId: 'pi-1',
      requestId: 'r-form-1',
      method: 'select',
      form: true,
      formQuestions: [
        {
          type: 'choice',
          header: '模型',
          question: '选哪个模型？',
          options: [{ label: 'A' }, { label: 'B', description: '更快' }, { noLabel: true }],
        },
        { type: 'text', question: '补充说明' },
        { type: 'boolean', question: '越界类型应被剔除' },
      ],
      receivedAt: Date.now(),
    })
    await settle(wrapper)

    const bar = wrapper.find('[data-testid="btw-inline-confirm"]')
    expect(bar.exists()).toBe(true)
    // 合法题渲染（choice 文本 + text 文本）；非法项（type 越界 + 缺 label 选项）被剔除不渲染
    expect(bar.text()).toContain('选哪个模型？')
    expect(bar.text()).toContain('补充说明')
    expect(bar.text()).not.toContain('越界类型应被剔除')
    const options = bar.findAll('[data-testid="btw-form-option"]')
    expect(options).toHaveLength(2)
    expect(options[0].attributes('data-value')).toBe('A')
    expect(options[1].attributes('data-value')).toBe('B')
    // choice 题降档带 Other 单行输入（allowOther 缺省 true）；text 题降档 = 单行输入
    expect(bar.find('[data-testid="btw-form-other"]').exists()).toBe(true)
    expect(bar.find('[data-testid="btw-form-text"]').exists()).toBe(true)
  // 提交门：choice/text 均未作答 → Submit 禁用（降档口径逐题可答判定）
  expect(bar.find('[data-testid="btw-form-submit"]').attributes('disabled')).toBeDefined()
  })
})

// ── [W2 缺陷修复] 线视图激活（D3 真机验收 A11 缺陷 2 的回归防线）───────────
//
// 缺陷形态：打开冷线时模型 chip 恒显占位符「…」（liveStateOf(线)=null）、全量 WS 帧
// session.getState=0 / session.subscribe 仅主会话——btw 线视图不走 selectSession 切入链
// （步 5 ensureStreamSubscription + 步 13 refreshLiveState 对线零覆盖），bindSessionStreamSync
// 也只 watch 侧栏 sessionStore.list（线 surface='btw' 不在列表内）。修复 = BtwPanel 选中线
// 激活点补两件事；本组锁定该接线（缓存缺失门控语义在 core live-state-pull.test.ts）。

describe('BtwPanel 线视图激活：状态层拉取 + 流订阅建立', () => {
  it('打开线视图（挂载即自动选中最新线）→ 对该线触发状态层拉取 + 流订阅建立', async () => {
    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }, { id: 'pi-2' }))
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    // 自动选中最新线 pi-2（D7②）→ 通道建立两件事都按该线 id 触发
    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('pi-2')
    expect(ensureStreamSubscriptionSpy).toHaveBeenCalledWith('pi-2', useChatStore(), useSessionStore())
    expect(refreshLiveStateSpy).toHaveBeenCalledWith('pi-2')
  })

  it('点 chip 切线 → 通道建立跟随新选中线（订阅/拉取按线 id 逐线建立）', async () => {
    apiMock.list.mockResolvedValue(btwLineGroups({ id: 'pi-1' }, { id: 'pi-2' }))
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    ensureStreamSubscriptionSpy.mockClear()
    refreshLiveStateSpy.mockClear()

    await wrapper.find('[data-testid="btw-thread-chip"][data-session-id="pi-1"]').trigger('click')
    await nextTick()

    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('pi-1')
    expect(ensureStreamSubscriptionSpy).toHaveBeenCalledWith('pi-1', useChatStore(), useSessionStore())
    expect(refreshLiveStateSpy).toHaveBeenCalledWith('pi-1')
  })

  it('新建线即选中 → 通道建立覆盖创建期路径（create reply 选中新线）', async () => {
    apiMock.list.mockResolvedValue([])
    apiMock.create.mockResolvedValue({ sessionId: 'pi-9', mainSid: MAIN_A, forkState: 'none' })
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    ensureStreamSubscriptionSpy.mockClear()
    refreshLiveStateSpy.mockClear()

    await wrapper.find('[data-testid="btw-empty-new"]').trigger('click')
    await settle(wrapper)

    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('pi-9')
    expect(ensureStreamSubscriptionSpy).toHaveBeenCalledWith('pi-9', useChatStore(), useSessionStore())
    expect(refreshLiveStateSpy).toHaveBeenCalledWith('pi-9')
  })

  it('空态（无选中线）不触发通道建立（无线可激活）', async () => {
    apiMock.list.mockResolvedValue([])
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    expect(wrapper.find('[data-testid="btw-stream"]').exists()).toBe(false)
    expect(ensureStreamSubscriptionSpy).not.toHaveBeenCalled()
    expect(refreshLiveStateSpy).not.toHaveBeenCalled()
  })
})
