/**
 * BtwPanel 组件测试（btw-question D7，M3-a）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：btw.list 按 mainSid 拉取 + loadSeq 乱序守卫回写 captured 分区；
 *   选中唯一源 = core drawer 分区 selectedBtwVid（setBtwView 写入，D5 豁免同源）
 * - 使用者（黑盒 DOM）：空态三要素 / 线 chip 渲染与点击切线 / 新建提问 → fork pill 三态 /
 *   切焦点会话线列表不串台 / 加载失败可见可重试 / 创建失败可见可恢复
 * - 观察者（形态）：首屏冒烟（drawer-btw-tab + 头部 + 关键 testid 存在）；Composer 装配
 *   variant=panel + show-btw=false（防递归出 btw 入口，prop 声明归 M3-b，本处只写调用处）
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 局部替换 btw 域（门面其余域走 actual）；
 * MessageStream / Composer stub 为透传 attrs 的占位 div——渲染树装配断言经 DOM 属性
 * （session-id / variant / show-btw）落使用者可见面，对话流渲染本身归 MessageStream 既有测试族。
 * i18n 由 vitest-i18n-setup 全局 mock（t 从 zh-CN 取真实文案，断言中文文案无需另行 mock）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/btw-panel.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import type { Ref } from 'vue'
import {
  bindDrawerSessionId,
  useDrawerControl,
  _resetDrawerForTest,
} from '@taiji/core/domain/drawer'
import BtwPanel from '@/components/panel/BtwPanel.vue'
import type { ServerMessageMap } from '@taiji/shared'

// btw 具名类型走 indexed-access（shared 包出口未挂具名，SSOT = shared protocol.ts）
type BtwForkState = ServerMessageMap['btw.create']['forkState']

// ── @/api 门面局部 mock：只替换 btw 域（三元消费面 = 本面板唯一数据入口）──
const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, btw: apiMock }
})

// ── MessageStream / Composer 占位 stub（attrs 全透传 → DOM 属性断言装配面）──
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

enableAutoUnmount(afterEach)

beforeEach(() => {
  vi.resetAllMocks()
  boundSid = ref<string | null>(MAIN_A)
  bindDrawerSessionId(boundSid)
  _resetDrawerForTest()
})

describe('BtwPanel 首屏冒烟与线列表（观察者 + 使用者）', () => {
  it('首屏结构：drawer-btw-tab + 头部线列表标签 + 新建入口 + 空态三要素 DOM 存在', async () => {
    apiMock.list.mockResolvedValue([])
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    expect(wrapper.find('[data-testid="drawer-btw-tab"]').exists()).toBe(true)
    expect(apiMock.list).toHaveBeenCalledWith(MAIN_A)

    const empty = wrapper.find('[data-testid="btw-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('还没有旁路线') // 说明句（空态三要素之一）
    expect(wrapper.find('[data-testid="btw-new-thread"]').exists()).toBe(true) // 头部入口
    expect(empty.find('[data-testid="btw-empty-new"]').exists()).toBe(true) // Primary 入口
    expect(wrapper.find('[data-testid="btw-thread-list"]').exists()).toBe(false) // 无线不渲染列表
  })

  it('线列表渲染 chip + 自动选中最新线 + MessageStream/Composer 装配面（D7②）', async () => {
    apiMock.list.mockResolvedValue([{ vid: 'btw:pi-1' }, { vid: 'btw:pi-2' }])
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    const chips = wrapper.findAll('[data-testid="btw-thread-chip"]')
    expect(chips).toHaveLength(2)
    expect(chips[0].text()).toContain('pi-1') // 短名 = extractBtwPiSessionId（映射即 extract）
    expect(chips[1].text()).toContain('pi-2')

    // 默认选中最新线 → 会话区装配到该 vid
    const stream = wrapper.find('[data-testid="btw-stream"]')
    expect(stream.exists()).toBe(true)
    expect(stream.attributes('session-id')).toBe('btw:pi-2')

    const composer = wrapper.find('[data-testid="btw-composer"]')
    expect(composer.exists()).toBe(true)
    expect(composer.attributes('session-id')).toBe('btw:pi-2')
    expect(composer.attributes('variant')).toBe('panel')
    expect(composer.attributes('show-btw')).toBe('false') // 防递归出 btw 入口（④ 调用处）

    // 构建者：选中写入 core drawer 分区（与 getViewedVids D5 豁免同源，无第二副本）
    expect(useDrawerControl().selectedBtwVid.value).toBe('btw:pi-2')
    // 列表加载完成后 loading 收口（空态不误显）
    expect(wrapper.find('[data-testid="btw-empty"]').exists()).toBe(false)
  })

  it('列表携带的线（非本运行创建）不渲染 fork pill——btw.list 无 forkState，结构上不可回填', async () => {
    apiMock.list.mockResolvedValue([{ vid: 'btw:pi-1' }, { vid: 'btw:pi-2' }])
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    expect(wrapper.find('[data-testid="btw-fork-pill"]').exists()).toBe(false)
    // 切线往返后仍无 pill（进程内亦无创建记录）
    await wrapper
      .find('[data-testid="btw-thread-chip"][data-vid="btw:pi-1"]')
      .trigger('click')
    await nextTick()
    await wrapper
      .find('[data-testid="btw-thread-chip"][data-vid="btw:pi-2"]')
      .trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="btw-fork-pill"]').exists()).toBe(false)
  })

  it('点击 chip 切线：会话区跟随 + 选中态样式（列表项型 bg-surface+accent）+ 分区同步', async () => {
    apiMock.list.mockResolvedValue([{ vid: 'btw:pi-1' }, { vid: 'btw:pi-2' }])
    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    const chip1 = wrapper.find('[data-testid="btw-thread-chip"][data-vid="btw:pi-1"]')
    expect(chip1.attributes('aria-pressed')).toBe('false')
    await chip1.trigger('click')
    await nextTick()

    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('btw:pi-1')
    expect(wrapper.find('[data-testid="btw-composer"]').attributes('session-id')).toBe('btw:pi-1')
    expect(chip1.attributes('aria-pressed')).toBe('true')
    expect(chip1.classes()).toContain('bg-surface')
    expect(chip1.classes()).toContain('text-accent')
    expect(useDrawerControl().selectedBtwVid.value).toBe('btw:pi-1')
  })
})

describe('BtwPanel 新建线与 fork pill 三态（D3 口径）', () => {
  it.each<[BtwForkState, string]>([
    ['none', '无快照（源快照不可用）'],
    ['truncated', '快照截断（进行中 turn 未完整带入）'],
    ['full', '已含主对话快照'],
  ])('create reply forkState=%s → pill 文案「%s」且切到新线', async (forkState, copy) => {
    apiMock.list.mockResolvedValue([])
    apiMock.create.mockResolvedValue({ vid: 'btw:pi-9', mainSid: MAIN_A, forkState })

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)

    await wrapper.find('[data-testid="btw-empty-new"]').trigger('click')
    await settle(wrapper)

    expect(apiMock.create).toHaveBeenCalledWith(MAIN_A)
    const pill = wrapper.find('[data-testid="btw-fork-pill"]')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain(copy)
    // 新线入列表 + 会话区切到新线（create reply 即选中与 pill 的唯一数据源）
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-vid="btw:pi-9"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('btw:pi-9')
    expect(useDrawerControl().selectedBtwVid.value).toBe('btw:pi-9')
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
    // 失败不锁死入口：按钮未禁用，可直接重试
    expect(wrapper.find('[data-testid="btw-empty-new"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="btw-new-thread"]').attributes('disabled')).toBeUndefined()
  })
})

describe('BtwPanel 焦点绑定（D7②④）与失败路径', () => {
  it('切焦点会话 → 线列表按新 mainSid 重拉不串台；切回恢复（DOM 面）', async () => {
    apiMock.list.mockImplementation(async (sid: string) =>
      sid === MAIN_A ? [{ vid: 'btw:a-1' }] : [{ vid: 'btw:b-1' }],
    )

    const wrapper = mountPanel(MAIN_A)
    await settle(wrapper)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-vid="btw:a-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('btw:a-1')

    // 切到 B（模拟焦点切换：分区键先于 props 更新——生产由 focusedSessionId/leaf 同源同帧保证）
    boundSid.value = MAIN_B
    await wrapper.setProps({ sessionId: MAIN_B })
    await settle(wrapper)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-vid="btw:b-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-vid="btw:a-1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="btw-stream"]').attributes('session-id')).toBe('btw:b-1')

    // 切回 A：重拉 + 恢复 A 的线（分区隔离，无 B 泄漏）
    boundSid.value = MAIN_A
    await wrapper.setProps({ sessionId: MAIN_A })
    await settle(wrapper)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-vid="btw:a-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-vid="btw:b-1"]').exists()).toBe(false)
    expect(apiMock.list.mock.calls.filter(([sid]) => sid === MAIN_A)).toHaveLength(2)
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

    apiMock.list.mockResolvedValue([{ vid: 'btw:pi-1' }])
    await wrapper.find('[data-testid="btw-load-retry"]').trigger('click')
    await settle(wrapper)

    expect(wrapper.find('[data-testid="btw-load-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="btw-thread-chip"][data-vid="btw:pi-1"]').exists()).toBe(true)
  })

  it('无焦点会话（sessionId null）：不拉列表 + 入口禁用 + 空态可见', async () => {
    const wrapper = mountPanel(null)
    await settle(wrapper)

    expect(apiMock.list).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="btw-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btw-new-thread"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="btw-empty-new"]').attributes('disabled')).toBeDefined()
    // 无选中线 → 会话区不装配
    expect(wrapper.find('[data-testid="btw-stream"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="btw-composer"]').exists()).toBe(false)
  })
})
