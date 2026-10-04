// MobileMessageStream「加载更早」接线测试（remote-use A2 / impl-plan U11）。
//
// 背景：移动壳此前无 loadMoreHistory 消费方、截断窗口状态无人读——长会话历史在手机
// 永久不可达（设计 §2.3 A2）。core API（useChat.loadMoreHistory 游标翻页）与 ui 组件
// （TruncatedHistoryBar）现成，本测锁定纯消费接线的三件事：
//   ① 点击「加载更早」→ 更早轮次前插进对话流（游标 = 分区最旧消息文件侧身份，
//     truncate=false 页收敛后顶部条消失）
//   ② 前插后滚动位置不跳：非贴底阅读态 scrollTop += 高度增量补偿（prepend 在头部
//     增高会把视口内容下推）；贴底态交由既有贴底跟随（两路写入以 nearBottom 单谓词
//     互斥，无时序窗）
//   ③ 截断窗口状态（chat store per-session 分区 truncated）驱动顶部条显隐——挂载态
//     与响应式翻转两个方向
//
// mock 策略：仅 transport chat 域 getHistory 出口模块级 vi.mock 隔离 WS，store/useChat
// 编排链保持全真实（对齐 app-runtime.test.ts「mock 组件层会变成断言 mock 自身」立场；
// core 侧游标翻页语义本体见 core truncated-window.test.ts / useChat 单测，本测断言壳层
// 显隐/点击路由/保位补偿）。DOM 滚动几何（scrollHeight/clientHeight/scrollTop）在
// happy-dom 无布局引擎，经 Object.defineProperty 桩定（可写变量模拟前插增高）。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { resetChatModuleStateForTest } from '@taiji/core'
import type { Message } from '@taiji/shared'
import MobileMessageStream from '../MobileMessageStream.vue'
import { chatStore } from '../../shell/app-runtime'
import { i18n } from '../../i18n'

const { getHistoryMock } = vi.hoisted(() => ({ getHistoryMock: vi.fn() }))

vi.mock('@taiji/core/transport/api/domains/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/chat')>()
  return { ...actual, getHistory: getHistoryMock }
})

const SID = 'sid-truncated-history'

function userMsg(id: string, text: string, piEntryId?: string): Message {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    status: 'complete',
    timestamp: Date.now(),
    ...(piEntryId ? { piEntryId } : {}),
  }
}

function assistantMsg(id: string, text: string): Message {
  return { id, role: 'assistant', content: text, status: 'complete', timestamp: Date.now() }
}

/** 既有最近一窗（user 带文件侧 piEntryId——游标锚）+ 更早一页（点击后的 RPC 应答） */
const RECENT: Message[] = [
  userMsg('recent-1', 'recent-question', 'entry-recent-1'),
  assistantMsg('recent-2', 'recent-answer'),
]
const EARLIER: Message[] = [
  userMsg('earlier-1', 'earlier-question', 'entry-earlier-1'),
  assistantMsg('earlier-2', 'earlier-answer'),
]
const PAGE_REPLY = { messages: EARLIER, truncated: false, loadedTurns: 3, totalTurnsEstimate: 5 }

function mountStream(): VueWrapper {
  return mount(MobileMessageStream, {
    props: { sessionId: SID },
    global: { plugins: [i18n] },
  })
}

/** 冲净微任务 + 一轮宏任务（loadMoreHistory 内 await RPC + nextTick 的完整链） */
async function settle(): Promise<void> {
  await flushPromises()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function barOf(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="truncated-history-bar"]')
}

function loadMoreBtnOf(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="load-more-history"]')
}

beforeEach(() => {
  resetChatModuleStateForTest()
  chatStore.disposeSession(SID)
  getHistoryMock.mockReset()
})

describe('MobileMessageStream 加载更早（A2 / U11）', () => {
  it('验收① 点击「加载更早」→ 游标翻页前插更早轮次；truncated=false 页收敛后顶部条消失', async () => {
    chatStore.hydrate(SID, RECENT, { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    getHistoryMock.mockResolvedValue(PAGE_REPLY)
    const wrapper = mountStream()
    await settle()

    expect(loadMoreBtnOf(wrapper).exists()).toBe(true)
    await loadMoreBtnOf(wrapper).trigger('click')
    await settle()

    // 游标 = 分区最旧消息的文件侧身份（piEntryId ?? id）——core 游标翻页契约
    expect(getHistoryMock).toHaveBeenCalledTimes(1)
    expect(getHistoryMock).toHaveBeenCalledWith(SID, { cursor: 'entry-recent-1' })
    // 分区前插：更早轮次在分区头部（构建者白盒视角）
    const partition = chatStore.getMessages(SID)
    expect(partition[0]?.id).toBe('earlier-1')
    expect(partition[1]?.id).toBe('earlier-2')
    expect(partition[2]?.id).toBe('recent-1')
    // DOM 前插序：更早问题排在既有最近问题之前（使用者视角）
    const text = wrapper.text()
    expect(text).toContain('earlier-question')
    expect(text.indexOf('earlier-question')).toBeLessThan(text.indexOf('recent-question'))
    // 页 truncated=false → 窗口收敛 → 顶部条结构性消失（翻页到头语义）
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('验收② 非贴底阅读态前插后 scrollTop += 高度增量（滚动位置不跳）', async () => {
    chatStore.hydrate(SID, RECENT, { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    const wrapper = mountStream()
    await settle()

    // happy-dom 无布局：桩定滚动几何，可写变量模拟「前插使 scrollHeight 1000→1800」
    const el = wrapper.find('[data-testid="mobile-message-stream"]').element as HTMLElement
    let scrollHeight = 1000
    let scrollTopValue = 0
    Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { get: () => 400, configurable: true })
    Object.defineProperty(el, 'scrollTop', {
      get: () => scrollTopValue,
      set: (v: number) => {
        scrollTopValue = v
      },
      configurable: true,
    })
    scrollTopValue = 100 // 上翻阅读态：距底 500px
    await wrapper.find('[data-testid="mobile-message-stream"]').trigger('scroll')
    expect(chatStore.getHistoryWindow(SID)?.truncated).toBe(true)

    // 前插落 DOM 后 scrollHeight 增高（真实浏览器下 nextTick 后才可读）
    getHistoryMock.mockImplementation(async () => {
      scrollHeight = 1800
      return PAGE_REPLY
    })
    await loadMoreBtnOf(wrapper).trigger('click')
    await settle()

    // 锚定补偿：scrollTop += 增量（800）→ 视口正在读的内容原位不动
    expect(scrollTopValue).toBe(900)
    wrapper.unmount()
  })

  it('验收② 加载中防重入：pending 期按钮禁用 + 重复点击只走一次翻页通路', async () => {
    chatStore.hydrate(SID, RECENT, { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    let resolveRpc!: (v: typeof PAGE_REPLY) => void
    getHistoryMock.mockImplementation(
      () => new Promise<typeof PAGE_REPLY>((resolve) => (resolveRpc = resolve)),
    )
    const wrapper = mountStream()
    await settle()

    await loadMoreBtnOf(wrapper).trigger('click')
    expect(loadMoreBtnOf(wrapper).attributes('disabled')).toBeDefined()
    await loadMoreBtnOf(wrapper).trigger('click')
    expect(getHistoryMock).toHaveBeenCalledTimes(1)

    resolveRpc(PAGE_REPLY)
    await settle()
    expect(getHistoryMock).toHaveBeenCalledTimes(1)
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('验收③ 截断窗口状态驱动显隐：无记录/false 不渲染，true 渲染，响应式翻转即消失', async () => {
    // 无窗口记录（未 hydrate / 已清理）= 无截断 → 结构性不渲染
    chatStore.hydrate(SID, RECENT)
    let wrapper = mountStream()
    await settle()
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()

    // truncated=false（全量窗口）→ 不渲染（A6 回归：普通 session 无截断提示）
    chatStore.disposeSession(SID)
    chatStore.hydrate(SID, RECENT, { truncated: false, loadedTurns: 2, totalTurnsEstimate: 2 })
    wrapper = mountStream()
    await settle()
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()

    // truncated=true → 条可见：N = loadedTurns + 「加载更早」入口（文案经 ui locale 单源）
    chatStore.disposeSession(SID)
    chatStore.hydrate(SID, RECENT, { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
    wrapper = mountStream()
    await settle()
    expect(barOf(wrapper).exists()).toBe(true)
    const expectedInfo = i18n.global.t('panel.message.loadedRecentTurns', { count: 2 })
    expect(wrapper.find('[data-testid="truncated-history-info"]').text()).toBe(expectedInfo)
    expect(loadMoreBtnOf(wrapper).text()).toContain(i18n.global.t('panel.message.loadEarlier'))

    // 响应式翻转：窗口状态置 false → 条即时消失（状态驱动，非仅挂载期快照）
    chatStore.setHistoryWindow(SID, { truncated: false, loadedTurns: 5, totalTurnsEstimate: 5 })
    await settle()
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  it('验收③ 消息分区为空时不渲染顶部条（无可翻页游标，对齐桌面 renderItems 条件）', async () => {
    chatStore.hydrate(SID, [], { truncated: true, loadedTurns: 0, totalTurnsEstimate: 3 })
    const wrapper = mountStream()
    await settle()
    expect(barOf(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })
})
