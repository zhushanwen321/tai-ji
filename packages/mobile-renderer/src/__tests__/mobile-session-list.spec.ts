// MobileSessionList 组件测试（remote-use D7 列表行；审计缺口补齐：整组件此前无测试）。
//
// 行为面（按组件实装）：lastActiveAt 倒序排序、时间文案（今天 HH:mm 补零 / 跨日 M/D）、
// 状态点配色 + 状态文案、加载失败态（role=alert 错误行 + 点击重试）、空态占位、
// 点选回调（selectSession → open-chat）、新建入口（new-task）、选中态高亮。
//
// app-runtime 模块级 mock：组件消费的 4 个导出（sessionStore.listLoadError / activeId、
// sessionList、loadSessions、selectSession）替换为测试可写 ref + vi.fn，隔离 core WS
// 依赖（测试禁触网络）。ref 在 mock 工厂内创建，测试经 import 拿到同一实例驱动场景。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/mobile-session-list.spec.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { SessionSummary } from '@taiji/shared'
// 可写驱动 ref：真实模块导出的 sessionList 是只读 ref（store 对外形态），测试驱动
// 写入走此可写实例（mock 工厂与用例共用同一对象，类型零断言）
const testState = await vi.hoisted(async () => {
  const { ref } = await import('vue')
  return { list: ref<SessionSummary[]>([]) }
})

vi.mock('../shell/app-runtime', async () => {
  const { ref } = await import('vue')
  return {
    sessionStore: {
      listLoadError: ref<string | null>(null),
      activeId: ref<string | null>(null),
    },
    sessionList: testState.list,
    loadSessions: vi.fn(async () => {}),
    selectSession: vi.fn(async () => {}),
  }
})

import MobileSessionList from '../views/MobileSessionList.vue'
import { i18n } from '../i18n'
import { loadSessions, selectSession, sessionStore } from '../shell/app-runtime'

function mountList() {
  return mount(MobileSessionList, { global: { plugins: [i18n] } })
}

function makeSummary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'lastActiveAt'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    modelId: 'test-model',
    tokenCount: 0,
    ...overrides,
  }
}

// 今天上午 9:05（当天分支，断言两位补零；分钟 5 分一位数字，padStart 后显 '09:05'）
const TODAY_HOUR = 9
const TODAY_MINUTE = 5
// 远 past 固定日期 2001-02-03（跨日分支，显 'M/D'）
const PAST_YEAR = 2001
const PAST_MONTH_INDEX = 1
const PAST_DAY = 3

function todayAt(hour: number, minute: number): number {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

function itemIdsInOrder(wrapper: ReturnType<typeof mountList>): string[] {
  return wrapper
    .findAll('[data-testid^="mobile-session-item-"]')
    .map((node) => node.attributes('data-testid') ?? '')
}

describe('MobileSessionList 会话列表（D7 列表行）', () => {
  beforeEach(() => {
    // i18n 是模块级单例：同 worker 前序测试可能把 locale 切到 en-US，此处固定中文
    i18n.global.locale.value = 'zh-CN'
    testState.list.value = []
    sessionStore.listLoadError.value = null
    sessionStore.activeId.value = null
    vi.mocked(loadSessions).mockClear()
    vi.mocked(selectSession).mockClear()
    vi.mocked(loadSessions).mockResolvedValue(undefined)
    vi.mocked(selectSession).mockResolvedValue(undefined)
  })

  it('排序：lastActiveAt 倒序渲染（最近活跃在前），与数据源顺序无关', () => {
    testState.list.value = [
      makeSummary({ id: 's-mid', lastActiveAt: todayAt(TODAY_HOUR, TODAY_MINUTE) }),
      makeSummary({ id: 's-old', lastActiveAt: new Date(PAST_YEAR, PAST_MONTH_INDEX, PAST_DAY).getTime() }),
      makeSummary({ id: 's-new', lastActiveAt: Date.now() }),
    ]
    const wrapper = mountList()
    expect(itemIdsInOrder(wrapper)).toEqual([
      'mobile-session-item-s-new',
      'mobile-session-item-s-mid',
      'mobile-session-item-s-old',
    ])
    wrapper.unmount()
  })

  it('时间文案：今天显 HH:mm（两位补零），跨日（非今天）显 M/D', () => {
    testState.list.value = [
      makeSummary({ id: 's-today', lastActiveAt: todayAt(TODAY_HOUR, TODAY_MINUTE) }),
      makeSummary({ id: 's-past', lastActiveAt: new Date(PAST_YEAR, PAST_MONTH_INDEX, PAST_DAY).getTime() }),
    ]
    const wrapper = mountList()
    expect(wrapper.get('[data-testid="mobile-session-item-s-today"]').text()).toContain('09:05')
    expect(wrapper.get('[data-testid="mobile-session-item-s-past"]').text()).toContain('2/3')
    wrapper.unmount()
  })

  it('运行状态可见：状态点配色（active=bg-accent / idle=bg-neutral-dim）+ 状态文案', () => {
    testState.list.value = [
      makeSummary({ id: 's-active', status: 'active', lastActiveAt: Date.now() }),
      makeSummary({ id: 's-idle', status: 'idle', lastActiveAt: Date.now() }),
    ]
    const wrapper = mountList()
    const activeItem = wrapper.get('[data-testid="mobile-session-item-s-active"]')
    const idleItem = wrapper.get('[data-testid="mobile-session-item-s-idle"]')
    expect(activeItem.get('.rounded-full').classes()).toContain('bg-accent')
    expect(activeItem.text()).toContain('运行中')
    expect(idleItem.get('.rounded-full').classes()).toContain('bg-neutral-dim')
    expect(idleItem.text()).toContain('空闲')
    wrapper.unmount()
  })

  it('加载失败态：错误行可见（role=alert + 错误文案），列表不渲染；点击错误行触发重试', async () => {
    sessionStore.listLoadError.value = '连接已断开'
    testState.list.value = [makeSummary({ id: 's-1', lastActiveAt: Date.now() })]
    const wrapper = mountList()
    const errorRow = wrapper.get('[data-testid="mobile-session-list-error"]')
    expect(errorRow.attributes('role')).toBe('alert')
    expect(errorRow.text()).toBe('连接已断开')
    // 失败态下列表不渲染（v-if / v-else-if 互斥分支）
    expect(wrapper.find('[data-testid="mobile-session-item-s-1"]').exists()).toBe(false)

    expect(loadSessions).not.toHaveBeenCalled()
    await errorRow.trigger('click')
    expect(loadSessions).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('空列表且无错误：空态占位「暂无会话」可见，无错误行', () => {
    const wrapper = mountList()
    expect(wrapper.find('[data-testid="mobile-session-list-error"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="mobile-session-list-empty"]').text()).toContain('暂无会话')
    wrapper.unmount()
  })

  it('点选条目：selectSession(sessionId) 后 emit("open-chat", sessionId)', async () => {
    testState.list.value = [makeSummary({ id: 's-1', lastActiveAt: Date.now() })]
    const wrapper = mountList()
    await wrapper.get('[data-testid="mobile-session-item-s-1"]').trigger('click')
    await flushPromises()
    expect(selectSession).toHaveBeenCalledWith('s-1')
    expect(wrapper.emitted('open-chat')).toEqual([['s-1']])
    wrapper.unmount()
  })

  it('新建入口：点「+」按钮 emit("new-task")，不触发会话选择', async () => {
    testState.list.value = [makeSummary({ id: 's-1', lastActiveAt: Date.now() })]
    const wrapper = mountList()
    await wrapper.get('[data-testid="mobile-new-task"]').trigger('click')
    expect(wrapper.emitted('new-task')).toHaveLength(1)
    expect(selectSession).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('选中态：activeId 对应条目高亮（bg-accent-soft），其余条目不带', () => {
    testState.list.value = [
      makeSummary({ id: 's-1', lastActiveAt: Date.now() }),
      makeSummary({ id: 's-2', lastActiveAt: Date.now() }),
    ]
    sessionStore.activeId.value = 's-1'
    const wrapper = mountList()
    expect(wrapper.get('[data-testid="mobile-session-item-s-1"]').classes()).toContain('bg-accent-soft')
    expect(wrapper.get('[data-testid="mobile-session-item-s-2"]').classes()).not.toContain('bg-accent-soft')
    wrapper.unmount()
  })
})
