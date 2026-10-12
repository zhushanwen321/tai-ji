/**
 * 悬停详情卡消息计数测试（ui-replica-demo-fidelity 通道 2，SessionItem 消费侧）。
 *
 * 三视角（TEST-STRATEGY §3）：
 *  - 构建者白盒：fetchSessionMessageCount 缓存（lastActiveAt 键控）驱动 command 调用次数
 *  - 使用者黑盒：悬停会话行 → 详情卡末行「时间 · N 条消息」两段式出现（demo Sidebar.vue
 *    `cardSess.upd · cardSess.msgs` 同构）
 *  - 观察者形态：计数未返回/拉取失败时计数段整体不渲染（含 ` · ` 分隔——避免闪 0 与
 *    失败误显示），data-testid=session-detail-card-msg-count 缺席即占位形态
 *
 * @taiji/core/transport/api 整模块 mock（command 可控 stub；本组件树对该模块消费面仅
 * command + RPC_BACKSTOP_TIMEOUT_MS）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/session-item-message-count.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { VueWrapper } from '@vue/test-utils'

import SessionItem from '@/components/sidebar/SessionItem.vue'
import { __resetMessageCountCacheForTest } from '@/components/sidebar/session-item/use-message-count'

const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }))

vi.mock('@taiji/core/transport/api', () => ({
  command: (...args: unknown[]) => commandMock(...args),
  RPC_BACKSTOP_TIMEOUT_MS: 5000,
}))

const SID = 'count-1'

function mountItem(lastActiveAt = 1000) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { id: SID, label: '计数会话', cwd: '/p', lastActiveAt },
      active: false,
      status: 'done' as never,
    },
  })
}

async function hover(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.session-item').trigger('pointerenter')
  await flushPromises()
}

function detailCard(): HTMLElement | null {
  return document.body.querySelector('[data-testid="session-detail-card"]')
}

function msgCountSegment(): HTMLElement | null {
  return document.body.querySelector('[data-testid="session-detail-card-msg-count"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetMessageCountCacheForTest()
  commandMock.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('悬停详情卡消息计数（通道 2）', () => {
  it('悬停 → 末行「时间 · N 条消息」两段式渲染（使用者黑盒 DOM 断言）', async () => {
    commandMock.mockResolvedValue({ sessionId: SID, count: 3 })
    const wrapper = mountItem()
    await hover(wrapper)

    const card = detailCard()
    expect(card).not.toBeNull()
    const seg = msgCountSegment()
    expect(seg).not.toBeNull()
    expect(seg!.textContent).toBe('3 条消息')
    // 两段式 = 「时间 · 消息数」（demo `cardSess.upd · cardSess.msgs` 分隔形态）
    expect(card!.textContent).toContain(' · ')
    // command 入参 = session.getMessageCount + sessionId（payload 单对象）
    expect(commandMock).toHaveBeenCalledWith('session.getMessageCount', { sessionId: SID }, 5000)
  })

  it('计数未返回前该段不渲染（不闪 0——meta 行只有相对时间，无分隔符）', async () => {
    commandMock.mockReturnValue(new Promise(() => {})) // 永不 resolve 的在途拉取
    const wrapper = mountItem()
    await wrapper.find('.session-item').trigger('pointerenter')
    await flushPromises()

    expect(detailCard()).not.toBeNull()
    expect(msgCountSegment()).toBeNull()
    const lastRow = detailCard()!.lastElementChild!
    expect(lastRow.textContent).not.toContain('·')
    expect(lastRow.textContent).not.toContain('0')
  })

  it('缓存命中（同 sessionId + lastActiveAt 未变）不重复调用 command', async () => {
    commandMock.mockResolvedValue({ sessionId: SID, count: 3 })
    const first = mountItem()
    await hover(first)
    first.unmount()

    const second = mountItem() // 新实例（同 id + 同 lastActiveAt）
    await hover(second)
    second.unmount()

    expect(commandMock).toHaveBeenCalledTimes(1)
    // 第二次悬停仍显示缓存值（DOM 断言缓存语义可观察）
    const third = mountItem()
    await hover(third)
    expect(msgCountSegment()!.textContent).toBe('3 条消息')
  })

  it('lastActiveAt 变化（失效键）→ 重拉（缓存不复用）', async () => {
    commandMock.mockResolvedValue({ sessionId: SID, count: 3 })
    const before = mountItem(1000)
    await hover(before)
    before.unmount()
    expect(commandMock).toHaveBeenCalledTimes(1)

    commandMock.mockResolvedValue({ sessionId: SID, count: 7 })
    const after = mountItem(2000) // lastActiveAt 变 = 会话有新消息
    await hover(after)

    expect(commandMock).toHaveBeenCalledTimes(2)
    expect(msgCountSegment()!.textContent).toBe('7 条消息')
  })

  it('拉取失败 → 占位不渲染 + 不缓存（下次悬停重试成功后显示）', async () => {
    commandMock.mockRejectedValueOnce(new Error('read failed'))
    const wrapper = mountItem()
    await hover(wrapper)
    expect(msgCountSegment()).toBeNull()

    commandMock.mockResolvedValue({ sessionId: SID, count: 5 })
    await wrapper.find('.session-item').trigger('pointerleave')
    await hover(wrapper) // 同实例再次悬停 = 重试（失败未缓存）

    expect(commandMock).toHaveBeenCalledTimes(2)
    expect(msgCountSegment()!.textContent).toBe('5 条消息')
  })
})
