// ActivityScreen 组件单测（remote-use-mobile-v2 §6.18 聚合半 / §6.21 / u-activity 验收条款 1-3）。
//
// 锁定六组契约（三视角：DOM 断言为使用者面，播种接线为构建者面，首屏冒烟为观察者面）：
//   ① 首屏冒烟 + 四空态三要素（图标/说明/主行动——验收条款 2）
//   ② 回合面板（§6.21）：活跃会话计时「已观察」+ 步数 + 子代理数；回合主体只看
//     activeSession（验收条款 1 的回合半）——切活跃会话面板随切
//   ③ 「需要你处理」聚合（§6.18）：可归属条目（他会的 form/planReview）+ 无归属
//     permission 条目同区呈现；点击会话条目 = selectSession 归属会话 + form 槽（先切
//     会话再开槽——FormSheet 三源读口按活跃分区派生）；点击 permission 条目直接开槽
//   ④ dialog 待办计入聚合（queue 跨分区计数读口，bus 真实链路）
//   ⑤ 导航计数与聚合区计数一致（验收条款 3）：BottomNav 角标与聚合区消费同一 computed
//     ——同源数据下两处数字一致
//   ⑥ 子代理行直落上抛 + 排队区 QueueStrip 渲染/空态切换
//
// mock 策略（对齐 chat-screen.test）：app-runtime 仅 isActive 派生输入与 selectSession
// 出口模块级 mock（chatStore 分区 / sessionStore / sessions-runtime / companion-bridge
// 全真实——聚合读口、form 分区、dialog queue、permission controller 都是验收对象）；
// form/dialog/permission 三源经 companion-bridge __testing.mobileExtensionBus 真实帧驱动，
// delivery 投影经 core 读口直写（queue-strip-v2 先例），子代理分区经 bootstrap 直挂写口。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { getDeliveryProjectionRef, resetChatModuleStateForTest } from '@taiji/core'
import type { DeliveryFrameEntry } from '@taiji/core'
import type { SessionGroup, SessionSummary, SubagentRecord } from '@taiji/shared'
import ActivityScreen from '../ActivityScreen.vue'
import BottomNav from '../../components/BottomNav.vue'
import { i18n } from '../../i18n'
import { chatStore, sessionStore } from '../../shell/app-runtime'
import { __testing as companionTesting } from '../../shell/companion-bridge'
import { applySubagentRecords, __testing as subagentTesting } from '../../shell/subagent-records'
import { activeSheet, resetSheetManagerForTesting } from '../../shell/sheet-manager'

const { chatIsActive, selectSessionMock } = vi.hoisted(() => ({
  // 容器：mock 工厂内填充 Vue ref（响应式源——useTurnObservation 的 isActive 依赖追踪
  // 需要真 ref，普通对象属性读取不触发重算，终态翻转用例会恒真）
  chatIsActive: { current: null as { value: boolean } | null },
  selectSessionMock: vi.fn<(id: string) => Promise<void>>(),
}))

vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  const isActiveRef = ref(false)
  chatIsActive.current = isActiveRef
  return {
    ...actual,
    chatStore: {
      ...actual.chatStore,
      isActive: () => isActiveRef.value,
    },
    selectSession: selectSessionMock,
  }
})

const SID_ACTIVE = 'sid-activity-a'
const SID_OTHER = 'sid-activity-b'

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'status' | 'lastActiveAt'>): SessionSummary {
  return { label: `会话-${overrides.id}`, cwd: '/tmp/project', ...overrides }
}

const NOW = Date.now()

function seedSessions(ids: Array<{ id: string; label: string }>): void {
  const groups: SessionGroup[] = [
    {
      cwd: '/tmp/activity',
      sessions: ids.map(({ id, label }) => summary({ id, status: 'active', lastActiveAt: NOW - 30_000, label, cwd: '/tmp/activity' })),
    },
  ]
  sessionStore.applySnapshot({ groups })
}

function setChatActive(active: boolean): void {
  if (chatIsActive.current === null) throw new Error('mock 工厂未初始化 chatIsActive')
  chatIsActive.current.value = active
}

/** form/planReview 类富交互帧（C4 放行面：form=true；经 bus → form 通道 → 分区） */
function emitFormRequest(sid: string, requestId: string): void {
  companionTesting.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId: sid,
    request: {
      requestId,
      pluginId: '',
      kind: 'select',
      form: true,
      formQuestions: [
        { type: 'choice', header: 'db', question: '用哪个数据库？', options: [{ label: 'pg' }, { label: 'mysql' }] },
      ],
    },
  })
}

/** dialog 四型帧（C4 门排除出 form 通道 → dialog queue 入队 + 跨分区计数读口 +1） */
function emitDialogRequest(sid: string, requestId: string): void {
  companionTesting.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId: sid,
    request: { requestId, pluginId: '', kind: 'confirm', title: '确认执行？' },
  })
}

/** 权限审批帧（bus → permission controller；V-6 降级分支 = 恒无归属） */
function emitPermissionRequest(): void {
  companionTesting.mobileExtensionBus.emit({
    kind: 'plugin-permission-request',
    request: { pluginId: 'plug-1', permissions: ['fs:read'], requestId: 'perm-1' },
  })
}

function runningRecord(subagentId: string): SubagentRecord {
  return {
    subagentId,
    sessionFile: null,
    agent: 'general-purpose',
    slug: subagentId,
    task: '跑子任务',
    status: 'running',
  }
}

function setProjection(sid: string, entries: DeliveryFrameEntry[]): void {
  const ref = getDeliveryProjectionRef()
  const next = new Map(ref.value)
  next.set(sid, entries)
  ref.value = next
}

async function mountScreen(): Promise<VueWrapper> {
  const wrapper = mount(ActivityScreen, { global: { plugins: [i18n] } })
  await flushPromises()
  await nextTick()
  return wrapper
}

function tOf(key: string, params?: Record<string, unknown>): string {
  return (i18n.global.t as (key: string, params?: Record<string, unknown>) => string)(key, params)
}

/** 三待办通道模块级单例清场（form 分区 / dialog queue 分区 / permission pending）——
 *  companion-bridge 无整体测试复位出口（各单例分属不同装配段），逐口清（dialog 走
 *  resetFor exited 语义；permission 走 resolved 帧，requestId 显式空串走 pluginId
 *  回退匹配链——controller 匹配分支 `requestId !== ''`，undefined 会落精确分支恒不中） */
function resetPendingChannels(): void {
  companionTesting.resetFormRequestsForTest()
  companionTesting.mobileDialogQueue.resetFor(SID_ACTIVE)
  companionTesting.mobileDialogQueue.resetFor(SID_OTHER)
  companionTesting.mobileExtensionBus.emit({
    kind: 'plugin-permission-request-resolved',
    resolved: { pluginId: 'plug-1', requestId: '', approved: true },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetChatModuleStateForTest()
  chatStore.disposeSession(SID_ACTIVE)
  chatStore.disposeSession(SID_OTHER)
  subagentTesting.resetSubagentPartitionsForTest()
  resetPendingChannels()
  resetSheetManagerForTesting()
  selectSessionMock.mockReset()
  selectSessionMock.mockResolvedValue(undefined)
  setChatActive(false)
  sessionStore.setActiveId(SID_ACTIVE)
  seedSessions([
    { id: SID_ACTIVE, label: '活跃会话甲' },
    { id: SID_OTHER, label: '其他会话乙' },
  ])
  i18n.global.locale.value = 'zh-CN'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('首屏冒烟 + 四空态三要素（观察者面 / 验收条款 2）', () => {
  it('全空播种：屏容器 + 四区块标题在场，四空态各自含图标/说明/主行动三要素', async () => {
    const wrapper = await mountScreen()
    expect(wrapper.find('[data-testid="activity-screen"]').exists()).toBe(true)
    for (const sectionTitle of ['mobile.activity.turnTitle', 'mobile.activity.pendingTitle', 'mobile.activity.subagentTitle', 'mobile.activity.queueTitle']) {
      expect(wrapper.text()).toContain(tOf(sectionTitle))
    }
    const empties = [
      { id: 'activity-empty-running', action: 'activity-empty-running-action' },
      { id: 'activity-empty-pending', action: 'activity-empty-pending-action' },
      { id: 'activity-empty-subagents', action: 'activity-empty-subagents-action' },
      { id: 'activity-empty-queue', action: 'activity-empty-queue-action' },
    ]
    for (const { id, action } of empties) {
      const empty = wrapper.find(`[data-testid="${id}"]`)
      // 三要素缺一不可（EmptyState 规格）：说明行 + 主行动按钮 + 图标容器（aria-hidden 装饰层）
      expect(empty.exists(), id).toBe(true)
      expect(empty.find('[data-testid="empty-state-title"]').text(), `${id} 说明`).not.toBe('')
      expect(empty.find(`[data-testid="${action}"]`).exists(), `${id} 主行动`).toBe(true)
      expect(empty.find('span[aria-hidden="true"] svg').exists(), `${id} 图标`).toBe(true)
    }
    wrapper.unmount()
  })
})

describe('回合面板（§6.21 / 验收条款 1 回合半）', () => {
  it('生成中：面板显示活跃会话标题 + 已观察计时（fake 推进秒级刷新）+ 步数 + 子代理数', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
    setChatActive(true)
    // 先挂载（观察锚点 = 空分区尾部）再播种回合消息与子代理分区——工具调用全在锚点之后
    const wrapper = await mountScreen()
    chatStore.hydrate(SID_ACTIVE, [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        timestamp: Date.now(),
        toolCalls: [
          { id: 't1', toolName: 'Read', input: {}, status: 'completed', startTime: Date.now() },
          { id: 't2', toolName: 'Bash', input: {}, status: 'completed', startTime: Date.now() },
          { id: 't3', toolName: 'Edit', input: {}, status: 'running', startTime: Date.now() },
        ],
      },
    ])
    applySubagentRecords(SID_ACTIVE, [runningRecord('sub-1'), runningRecord('sub-2')])
    await nextTick()
    await nextTick()

    const panel = wrapper.get('[data-testid="activity-turn-panel"]')
    expect(panel.get('[data-testid="activity-turn-session"]').text()).toBe('活跃会话甲')
    expect(panel.get('[data-testid="activity-turn-timer"]').text()).toBe(
      tOf('mobile.activity.observed', { duration: '00:00' }),
    )
    expect(panel.get('[data-testid="activity-turn-steps"]').text()).toBe(tOf('mobile.activity.steps', { count: 2 }))
    expect(panel.get('[data-testid="activity-turn-subagents"]').text()).toBe(
      tOf('mobile.activity.subagentCount', { count: 2 }),
    )

    vi.advanceTimersByTime(65_000)
    await nextTick()
    expect(wrapper.get('[data-testid="activity-turn-timer"]').text()).toBe(
      tOf('mobile.activity.observed', { duration: '01:05' }),
    )
    wrapper.unmount()
  })

  it('回合主体只看 activeSession：他会的待办聚合进「需要你处理」，但面板标题恒为活跃会话；切活跃会话面板随切', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
    setChatActive(true)
    const wrapper = await mountScreen()
    // 他会（SID_OTHER）的 form 待办：进聚合区（§6.18 全部会话）
    emitFormRequest(SID_OTHER, 'req-other-1')
    await nextTick()
    await nextTick()
    // 面板 = 活跃会话甲（回合主体不看他会——§6.18 收窄口径）
    expect(wrapper.get('[data-testid="activity-turn-session"]').text()).toBe('活跃会话甲')
    expect(wrapper.find(`[data-testid="activity-pending-session-${SID_OTHER}"]`).exists()).toBe(true)

    // 切活跃会话 → 面板随切（useTurnObservation 响应式 sid；新会话生成中 = 接入即记）
    sessionStore.setActiveId(SID_OTHER)
    await nextTick()
    await nextTick()
    expect(wrapper.get('[data-testid="activity-turn-session"]').text()).toBe('其他会话乙')
    wrapper.unmount()
  })

  it('非生成中（isActive false）→ 面板不渲染，空态①（无运行）在场', async () => {
    const wrapper = await mountScreen()
    expect(wrapper.find('[data-testid="activity-turn-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="activity-empty-running"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('「需要你处理」聚合区（§6.18 / 验收条款 1）', () => {
  it('可归属条目（他会 form）+ 无归属 permission 条目同区呈现；点击会话条目 = selectSession 归属会话 + form 槽', async () => {
    const wrapper = await mountScreen()
    emitFormRequest(SID_OTHER, 'req-1')
    emitPermissionRequest()
    await nextTick()
    await nextTick()

    const sessionEntry = wrapper.get(`[data-testid="activity-pending-session-${SID_OTHER}"]`)
    expect(sessionEntry.text()).toContain('其他会话乙')
    expect(sessionEntry.text()).toContain(tOf('mobile.activity.pendingForm', { count: 1 }))
    expect(wrapper.get('[data-testid="activity-pending-permission"]').text()).toContain(
      tOf('mobile.activity.pendingPermission'),
    )

    await sessionEntry.trigger('click')
    await flushPromises()
    expect(selectSessionMock).toHaveBeenCalledTimes(1)
    expect(selectSessionMock).toHaveBeenCalledWith(SID_OTHER)
    expect(activeSheet.value).toBe('form')
    wrapper.unmount()
  })

  it('点击 permission 条目直接开 permission 槽（无归属一等分支——不切会话）', async () => {
    const wrapper = await mountScreen()
    emitPermissionRequest()
    await nextTick()
    await nextTick()

    await wrapper.get('[data-testid="activity-pending-permission"]').trigger('click')
    await flushPromises()
    expect(selectSessionMock).not.toHaveBeenCalled()
    expect(activeSheet.value).toBe('permission')
    wrapper.unmount()
  })

  it('dialog 待办计入聚合（queue 跨分区计数读口，bus 真实链路：非活跃会话的 confirm 帧进条目）', async () => {
    const wrapper = await mountScreen()
    emitDialogRequest(SID_OTHER, 'dlg-1')
    await nextTick()
    await nextTick()

    const entry = wrapper.get(`[data-testid="activity-pending-session-${SID_OTHER}"]`)
    expect(entry.text()).toContain(tOf('mobile.activity.pendingDialog', { count: 1 }))
    wrapper.unmount()
  })

  it('待办全清（作答摘除后）→ 聚合区回空态②（无待办三要素）', async () => {
    const wrapper = await mountScreen()
    emitFormRequest(SID_OTHER, 'req-1')
    await nextTick()
    expect(wrapper.find('[data-testid="activity-empty-pending"]').exists()).toBe(false)

    resetPendingChannels()
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="activity-empty-pending"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('导航计数与聚合区计数一致（验收条款 3）', () => {
  it('同源数据下 BottomNav 角标数字 = 聚合区条目合计（会话 form 1 + dialog 1 + permission 1 = 3）', async () => {
    emitFormRequest(SID_OTHER, 'req-1')
    emitDialogRequest(SID_OTHER, 'dlg-1')
    emitPermissionRequest()

    const screen = await mountScreen()
    // 聚合区条目（使用者面）：他会条目 1 条 + permission 条目 1 条
    expect(screen.find(`[data-testid="activity-pending-session-${SID_OTHER}"]`).exists()).toBe(true)
    expect(screen.find('[data-testid="activity-pending-permission"]').exists()).toBe(true)
    screen.unmount()

    const nav = mount(BottomNav, { props: { modelValue: 'sessions' }, global: { plugins: [i18n] } })
    const badge = nav.get('[data-testid="nav-badge-activity"]')
    expect(badge.text()).toBe('3')
    nav.unmount()
  })

  it('待办清零 → 角标不渲染（无待办无角标，不占位）', async () => {
    emitFormRequest(SID_OTHER, 'req-1')
    const nav = mount(BottomNav, { props: { modelValue: 'sessions' }, global: { plugins: [i18n] } })
    expect(nav.find('[data-testid="nav-badge-activity"]').text()).toBe('1')

    resetPendingChannels()
    await nextTick()
    await nextTick()
    expect(nav.find('[data-testid="nav-badge-activity"]').exists()).toBe(false)
    nav.unmount()
  })
})

describe('子代理行直落 + 排队区', () => {
  it('运行中子代理行渲染 + 点击上抛 open-subagent-detail（直落 SubagentSheet 详情的屏侧契约）', async () => {
    const wrapper = await mountScreen()
    applySubagentRecords(SID_ACTIVE, [runningRecord('sub-9')])
    await nextTick()
    await nextTick()

    const row = wrapper.get('[data-testid="activity-subagent-sub-9"]')
    expect(row.text()).toContain('sub-9')
    await row.trigger('click')
    expect(wrapper.emitted('open-subagent-detail')).toEqual([['sub-9']])
    wrapper.unmount()
  })

  it('排队条目在场渲染 QueueStrip（复用 §6.22 状态机渲染）；投影清空回空态④', async () => {
    const wrapper = await mountScreen()
    setProjection(SID_ACTIVE, [{ clientUuid: 'q1', preview: '排队消息', state: 'queued', lane: 'queued' }])
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-queue-strip"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('排队消息')

    setProjection(SID_ACTIVE, [])
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="mobile-queue-strip"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="activity-empty-queue"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
