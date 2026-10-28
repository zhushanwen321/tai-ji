import { i18n } from '../i18n';
import { liveStateOf, loadSessions, selectSession, sessionStore } from '../shell/app-runtime';
import MobileSessionList from '../views/MobileSessionList.vue';
import SessionListItem from '../views/SessionListItem.vue';
import { __testing, applySubagentRecords } from '../views/SubagentStatusLine.vue';
import type { DerivedStatus } from '@taiji/core';
import type { SessionSummary } from '@taiji/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← mobile-chat-header.spec.ts
// ======================================================================

const testState = await vi.hoisted(async () => {
  const { ref } = await import('vue')
  const { vi: hoistedVi } = await import('vitest')
  return {
    list: ref<SessionSummary[]>([]),
    liveStateOf: hoistedVi.fn(
      (_id: string) => undefined as { modelId?: string; thinkingLevel?: string } | undefined,
    ),
    chatStore: {
      isActive: hoistedVi.fn((_sid: string) => false),
      isCompacting: hoistedVi.fn((_sid: string) => false),
      isGenerating: hoistedVi.fn((_sid: string) => false),
      getMessages: hoistedVi.fn((_sid: string): unknown[] => []),
      getRetryState: hoistedVi.fn((_sid: string) => undefined),
    },
    sessionStore: {
      listLoadError: ref<string | null>(null),
      activeId: ref<string | null>(null),
    },
    loadSessions: hoistedVi.fn(async () => {}),
    selectSession: hoistedVi.fn(async () => {}),
  }
})

// 簇内并集 mock：会话列表三 spec 各自需要的 app-runtime 出口全量覆写（spread actual ——
// 组件消费的其余导出保持真实；chatStore 仅列表派生态需要的五个读口被替换）。
vi.mock('../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shell/app-runtime')>()
  return {
    ...actual,
    sessionStore: testState.sessionStore,
    sessionList: testState.list,
    liveStateOf: testState.liveStateOf,
    chatStore: testState.chatStore,
    loadSessions: testState.loadSessions,
    selectSession: testState.selectSession,
  }
})

import MobileChatHeader from '../views/MobileChatHeader.vue';
function makeSummary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    lastActiveAt: 0,
    ...overrides,
  }
}

function mountHeader(sessionId: string) {
  return mount(MobileChatHeader, { props: { sessionId } })
}

describe('MobileChatHeader 聊天头部模型标签（u13/A5）', () => {
  beforeEach(() => {
    testState.liveStateOf.mockReset()
    testState.liveStateOf.mockReturnValue(undefined)
  })

  it('头部可见：状态层 modelId 与 thinkingLevel 同行呈现（V11 聊天头面）', () => {
    testState.list.value = [makeSummary({ id: 's-1' })]
    testState.liveStateOf.mockImplementation((id: string) => (id === 's-1' ? { modelId: 'm-1', thinkingLevel: 'high' } : undefined))
    const wrapper = mountHeader('s-1')
    expect(wrapper.find('[data-testid="mobile-chat-header"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="mobile-chat-header-model"]').text()).toBe('m-1 · high')
    wrapper.unmount()
  })

  it('thinkingLevel 缺失：仅显示 modelId', () => {
    testState.list.value = [makeSummary({ id: 's-1' })]
    testState.liveStateOf.mockImplementation((id: string) => (id === 's-1' ? { modelId: 'm-2' } : undefined))
    const wrapper = mountHeader('s-1')
    expect(wrapper.get('[data-testid="mobile-chat-header-model"]').text()).toBe('m-2')
    wrapper.unmount()
  })

  it('sessionList 无匹配会话：头部不渲染', () => {
    testState.list.value = [makeSummary({ id: 's-1' })]
    const wrapper = mountHeader('s-other')
    expect(wrapper.find('[data-testid="mobile-chat-header"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('[W1] 状态层未观测：显式未知，头部不渲染（不回退 SessionSummary 种子字段）', () => {
    // W3：SessionSummary 种子字段已删（三状态字段退役），「显式未知」用例不再给种子
    testState.list.value = [makeSummary({ id: 's-1' })]
    const wrapper = mountHeader('s-1')
    expect(wrapper.find('[data-testid="mobile-chat-header"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

// ======================================================================
// ← mobile-session-list-item.spec.ts
// ======================================================================

function makeItem(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
    lastActiveAt: new Date(2001, 1, 3).getTime(),
    ...overrides,
  }
}

function mountItem(item: SessionSummary, active = false, derivedStatus: DerivedStatus = 'done') {
  return mount(SessionListItem, {
    props: { item, active, derivedStatus },
    global: { plugins: [i18n] },
  })
}

function itemRoot(wrapper: ReturnType<typeof mountItem>) {
  return wrapper.get('[data-testid^="mobile-session-item-"]')
}

describe('SessionListItem 会话列表行（u13/A5）', () => {
  beforeEach(() => {
    // i18n 是模块级单例：同 worker 前序测试可能把 locale 切到 en-US，此处固定中文
    i18n.global.locale.value = 'zh-CN'
    vi.mocked(liveStateOf).mockReset()
    vi.mocked(liveStateOf).mockReturnValue(undefined)
  })

  it('外迁内容等价：label + 状态点配色 + 状态文案 + 时间（跨日 M/D）', () => {
    const wrapper = mountItem(makeItem({ id: 's-1' }), false, 'streaming')
    const root = itemRoot(wrapper)
    expect(root.text()).toContain('会话-s-1')
    expect(root.get('.rounded-full').classes()).toContain('bg-accent')
    expect(root.text()).toContain('生成中')
    expect(root.text()).toContain('2/3')
    wrapper.unmount()
  })

  it('A14 派生态渲染：waiting → warn 色 + 等待输入文案；done → success 色已完成（对齐桌面 DOT_CLASS 色语言）', () => {
    const waiting = mountItem(makeItem({ id: 's-w' }), false, 'waiting')
    expect(waiting.get('.rounded-full').classes()).toContain('bg-warn')
    expect(waiting.text()).toContain('等待输入')
    waiting.unmount()

    const done = mountItem(makeItem({ id: 's-d' }), false, 'done')
    expect(done.get('.rounded-full').classes()).toContain('bg-success')
    expect(done.text()).toContain('已完成')
    done.unmount()
  })

  it('dead 进程态特判：meta dead → 红点 + 已退出（进程态权威于对话派生，A3 分流视觉锚）', () => {
    const dead = mountItem(makeItem({ id: 's-dead', status: 'dead' }), false, 'done')
    expect(dead.get('.rounded-full').classes()).toContain('bg-danger')
    expect(dead.text()).toContain('已退出')
    expect(dead.text()).not.toContain('已完成')
    dead.unmount()
  })

  it('A5 模型标签：状态层 modelId 可见（行内独立 testid）', () => {
    vi.mocked(liveStateOf).mockImplementation((id: string) => (id === 's-1' ? { modelId: 'claude-opus-4' } : undefined))
    const wrapper = mountItem(makeItem({ id: 's-1' }))
    // 状态层权威：显示状态层值而非列表种子字段
    expect(wrapper.get('[data-testid="mobile-session-model-line"]').text()).toBe('claude-opus-4')
    wrapper.unmount()
  })

  it('A5 思考档标签：状态层 thinkingLevel 有值时以「modelId · level」拼接；缺失时仅 modelId', () => {
    vi.mocked(liveStateOf).mockImplementation((id: string) =>
      id === 's-1' ? { modelId: 'm-1', thinkingLevel: 'high' } : id === 's-2' ? { modelId: 'm-2' } : undefined,
    )
    const withLevel = mountItem(makeItem({ id: 's-1' }))
    expect(withLevel.get('[data-testid="mobile-session-model-line"]').text()).toBe('m-1 · high')
    withLevel.unmount()

    const withoutLevel = mountItem(makeItem({ id: 's-2' }))
    expect(withoutLevel.get('[data-testid="mobile-session-model-line"]').text()).toBe('m-2')
    withoutLevel.unmount()
  })

  it('[W1] 状态层缺失 → 模型标签显式未知（空串，不回退 SessionSummary 种子字段）', () => {
    const wrapper = mountItem(makeItem({ id: 's-unobserved' }))
    expect(wrapper.get('[data-testid="mobile-session-model-line"]').text()).toBe('')
    wrapper.unmount()
  })

  it('交互：click 与 keydown.enter 均 emit("open", item.id)', async () => {
    const wrapper = mountItem(makeItem({ id: 's-1' }))
    await itemRoot(wrapper).trigger('click')
    await itemRoot(wrapper).trigger('keydown.enter')
    expect(wrapper.emitted('open')).toEqual([['s-1'], ['s-1']])
    wrapper.unmount()
  })

  it('active 高亮：active=true 带 bg-accent-soft，false 不带', () => {
    const active = mountItem(makeItem({ id: 's-1' }), true)
    expect(itemRoot(active).classes()).toContain('bg-accent-soft')
    active.unmount()
    const inactive = mountItem(makeItem({ id: 's-2' }), false)
    expect(itemRoot(inactive).classes()).not.toContain('bg-accent-soft')
    inactive.unmount()
  })
})

// ======================================================================
// ← mobile-session-list.spec.ts
// ======================================================================

function mountList() {
  return mount(MobileSessionList, { global: { plugins: [i18n] } })
}

function makeSummary_m2(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'lastActiveAt'>): SessionSummary {
  return {
    label: `会话-${overrides.id}`,
    cwd: '/tmp/project',
    status: 'idle',
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

/** 每用例前置重置（两个 describe 共用单点）：i18n locale 固定中文 + store/分区/RPC mock 全量复位 */
function resetSessionListTestState(): void {
  // i18n 是模块级单例：同 worker 前序测试可能把 locale 切到 en-US，此处固定中文
  i18n.global.locale.value = 'zh-CN'
  testState.list.value = []
  sessionStore.listLoadError.value = null
  sessionStore.activeId.value = null
  testState.chatStore.isActive.mockReturnValue(false)
  testState.chatStore.isCompacting.mockReturnValue(false)
  testState.chatStore.isGenerating.mockReturnValue(false)
  testState.chatStore.getMessages.mockReturnValue([])
  testState.chatStore.getRetryState.mockReturnValue(undefined)
  __testing.resetSubagentPartitionsForTest()
  vi.mocked(liveStateOf).mockReset()
  vi.mocked(liveStateOf).mockReturnValue(undefined as never)
  vi.mocked(loadSessions).mockClear()
  vi.mocked(selectSession).mockClear()
  vi.mocked(loadSessions).mockResolvedValue(undefined)
  vi.mocked(selectSession).mockResolvedValue(undefined)
}

describe('MobileSessionList 会话列表（remote-use-mobile D7 列表行）', () => {
  beforeEach(() => {
    resetSessionListTestState()
  })

  it('排序：runtime 组序原样渲染（A13 统一裁决——客户端 lastActiveAt 重排已删除），与数据源顺序一致', () => {
    // 数据源故意按 lastActiveAt 乱序注入：客户端不重排，行序 = 数据源（runtime 组序派生视图）
    testState.list.value = [
      makeSummary_m2({ id: 's-mid', lastActiveAt: todayAt(TODAY_HOUR, TODAY_MINUTE) }),
      makeSummary_m2({ id: 's-old', lastActiveAt: new Date(PAST_YEAR, PAST_MONTH_INDEX, PAST_DAY).getTime() }),
      makeSummary_m2({ id: 's-new', lastActiveAt: Date.now() }),
    ]
    const wrapper = mountList()
    expect(itemIdsInOrder(wrapper)).toEqual([
      'mobile-session-item-s-mid',
      'mobile-session-item-s-old',
      'mobile-session-item-s-new',
    ])
    wrapper.unmount()
  })

  it('时间文案：今天显 HH:mm（两位补零），跨日（非今天）显 M/D', () => {
    testState.list.value = [
      makeSummary_m2({ id: 's-today', lastActiveAt: todayAt(TODAY_HOUR, TODAY_MINUTE) }),
      makeSummary_m2({ id: 's-past', lastActiveAt: new Date(PAST_YEAR, PAST_MONTH_INDEX, PAST_DAY).getTime() }),
    ]
    const wrapper = mountList()
    expect(wrapper.get('[data-testid="mobile-session-item-s-today"]').text()).toContain('09:05')
    expect(wrapper.get('[data-testid="mobile-session-item-s-past"]').text()).toContain('2/3')
    wrapper.unmount()
  })

  it('运行状态可见（A14 派生态）：streaming 输入 → bg-accent + 生成中；未 hydrate meta idle → 已完成；dead → 红点已退出', () => {
    testState.list.value = [
      makeSummary_m2({ id: 's-streaming', status: 'active', lastActiveAt: Date.now() }),
      makeSummary_m2({ id: 's-idle', status: 'idle', lastActiveAt: Date.now() }),
      makeSummary_m2({ id: 's-dead', status: 'dead', lastActiveAt: Date.now() }),
    ]
    // streaming 输入 = isGenerating（core chat store occupancy，移动输入子集之一）
    testState.chatStore.isGenerating.mockImplementation((sid: string) => sid === 's-streaming')
    const wrapper = mountList()
    const streamingItem = wrapper.get('[data-testid="mobile-session-item-s-streaming"]')
    const idleItem = wrapper.get('[data-testid="mobile-session-item-s-idle"]')
    const deadItem = wrapper.get('[data-testid="mobile-session-item-s-dead"]')
    expect(streamingItem.get('.rounded-full').classes()).toContain('bg-accent')
    expect(streamingItem.text()).toContain('生成中')
    // meta idle 未 hydrate（无消息分区）→ 谓词终态兜底 done（桌面侧栏同语义）
    expect(idleItem.get('.rounded-full').classes()).toContain('bg-success')
    expect(idleItem.text()).toContain('已完成')
    // dead 是进程态非对话派生态——红点特判权威于派生（A3 分流视觉锚）
    expect(deadItem.get('.rounded-full').classes()).toContain('bg-danger')
    expect(deadItem.text()).toContain('已退出')
    wrapper.unmount()
  })

  it('working 态输入链（A14/U20：A9 subagent 运行态分区 → hasBackgroundWork → 后台任务）', () => {
    testState.list.value = [makeSummary_m2({ id: 's-working', status: 'idle', lastActiveAt: Date.now() })]
    // 真实 SubagentStatusLine 分区（无 mock）：推送 running 记录 → 移动 working 输入源成立
    applySubagentRecords('s-working', [
      {
        subagentId: 'sa-1',
        sessionFile: null,
        agent: 'coder',
        slug: 'coder',
        task: 'do work',
        status: 'running',
      },
    ])
    const wrapper = mountList()
    const workingItem = wrapper.get('[data-testid="mobile-session-item-s-working"]')
    expect(workingItem.get('.rounded-full').classes()).toContain('bg-accent')
    expect(workingItem.text()).toContain('后台任务')
    wrapper.unmount()
  })

  it('加载失败态：错误行可见（role=alert + 错误文案），列表不渲染；点击错误行触发重试', async () => {
    sessionStore.listLoadError.value = '连接已断开'
    testState.list.value = [makeSummary_m2({ id: 's-1', lastActiveAt: Date.now() })]
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
    testState.list.value = [makeSummary_m2({ id: 's-1', lastActiveAt: Date.now() })]
    const wrapper = mountList()
    await wrapper.get('[data-testid="mobile-session-item-s-1"]').trigger('click')
    await flushPromises()
    expect(selectSession).toHaveBeenCalledWith('s-1')
    expect(wrapper.emitted('open-chat')).toEqual([['s-1']])
    wrapper.unmount()
  })

  it('新建入口：点「+」按钮 emit("new-task")，不触发会话选择', async () => {
    testState.list.value = [makeSummary_m2({ id: 's-1', lastActiveAt: Date.now() })]
    const wrapper = mountList()
    await wrapper.get('[data-testid="mobile-new-task"]').trigger('click')
    expect(wrapper.emitted('new-task')).toHaveLength(1)
    expect(selectSession).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('选中态：activeId 对应条目高亮（bg-accent-soft），其余条目不带', () => {
    testState.list.value = [
      makeSummary_m2({ id: 's-1', lastActiveAt: Date.now() }),
      makeSummary_m2({ id: 's-2', lastActiveAt: Date.now() }),
    ]
    sessionStore.activeId.value = 's-1'
    const wrapper = mountList()
    expect(wrapper.get('[data-testid="mobile-session-item-s-1"]').classes()).toContain('bg-accent-soft')
    expect(wrapper.get('[data-testid="mobile-session-item-s-2"]').classes()).not.toContain('bg-accent-soft')
    wrapper.unmount()
  })

  it('模型/思考档标签：状态层 modelId 与 thinkingLevel 行内可见（u13/A5，V11 列表行面）', () => {
    testState.list.value = [
      makeSummary_m2({ id: 's-1', lastActiveAt: Date.now() }),
    ]
    vi.mocked(liveStateOf).mockImplementation((id: string) =>
      id === 's-1' ? { modelId: 'm-list', thinkingLevel: 'high' } : undefined,
    )
    const wrapper = mountList()
    const modelLine = wrapper.get('[data-testid="mobile-session-item-s-1"] [data-testid="mobile-session-model-line"]')
    expect(modelLine.text()).toBe('m-list · high')
    wrapper.unmount()
  })
})

// 动作菜单遮罩（长按/dead 引导菜单 + 重命名二级表单，底部 sheet 形态两处 backdrop）：
// 菜单打开经 dead 条目点击分流（A3）驱动——无长按 timer，链路最短。

describe('MobileSessionList 动作菜单 backdrop（点击关闭）', () => {
  beforeEach(() => {
    resetSessionListTestState()
  })

  it('dead 条目点击 → 引导菜单打开（backdrop 可见）；点击 backdrop 关闭菜单', async () => {
    testState.list.value = [makeSummary_m2({ id: 's-dead-menu', status: 'dead', lastActiveAt: Date.now() })]
    const wrapper = mountList()
    // dead 分流（A3）：click 不切入，弹引导菜单
    await wrapper.get('[data-testid="mobile-session-item-s-dead-menu"]').trigger('click')
    expect(wrapper.get('[data-testid="mobile-session-menu-backdrop"]').element).toBeTruthy()
    // 点击 backdrop 关闭菜单
    await wrapper.get('[data-testid="mobile-session-menu-backdrop"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-session-menu-backdrop"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('菜单·重命名 → 重命名表单打开（其 backdrop 可见，菜单已收起）；点击 backdrop 关闭表单', async () => {
    testState.list.value = [makeSummary_m2({ id: 's-menu-rename', status: 'dead', lastActiveAt: Date.now() })]
    const wrapper = mountList()
    await wrapper.get('[data-testid="mobile-session-item-s-menu-rename"]').trigger('click')
    await wrapper.get('[data-testid="mobile-session-menu-rename"]').trigger('click')
    // 二级表单 backdrop 可见，一级菜单已随 openRename 收起
    expect(wrapper.get('[data-testid="mobile-session-rename-backdrop"]').element).toBeTruthy()
    expect(wrapper.find('[data-testid="mobile-session-menu-backdrop"]').exists()).toBe(false)
    await wrapper.get('[data-testid="mobile-session-rename-backdrop"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-session-rename-backdrop"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
