/**
 * Session active state 统一回归测试（E1-E4）。
 *
 * 锁定 cw-2026-07-09-unify-session-active-state 的核心修复：isActive 作为 UI 层执行态 SSOT，
 * 消除「提交后到 pi message_start 之间」空窗期的状态不一致；compact 互斥态独立驱动 running。
 *
 * 三视角覆盖（AGENTS.md 测试规范 #5-8）：
 * - 构建者（白盒）：store.addPendingSend / setOccupancy → isActive / isCompacting（occupancy 派生）→ deriveStatus
 * - 使用者（黑盒）：mount SessionItem/Panel 断言 DOM（转菊花 / Composer 渲染 / Landing 守卫）
 * - 观察者（形态）：spinner 含 animate-spin 动画类、composer/landing testid 存在
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-active-state.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useSessionDerivations, invalidateStatusCache } from '@/composables/features/chat/useSessionDerivations'
import { DOT_CLASS } from '@/composables/logic/sessionStatus'
import type { SessionSummary } from '@taiji/shared'

// flow 单例态 mock（panel-view 派生消费 isActive）：E4 的 landing 场景需 flow 活跃。
// flow 与 chat streaming 解耦（D1：isFlowActive 是独立事实源），mock 不读 chat store。
const flowState = vi.hoisted(() => ({ isActive: { value: false as boolean } }))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ isActive: flowState.isActive, state: { value: 'landing' }, startFlow: vi.fn(), cancelFlow: vi.fn() }),
  resetNewTaskFlow: vi.fn(),
}))

/** Panel 子组件 stub（隔离 PanelHeader/MessageStream 等的重渲染，聚焦被测逻辑） */
const panelStubs = {
  PanelHeader: { template: '<div />' },
  MessageStream: { template: '<div data-testid="msg-stream" />' },
  Composer: { template: '<div data-testid="composer" />' },
  Landing: { template: '<div data-testid="landing">landing</div>' },
}

function makeSession(id: string): SessionSummary {
  return {
    id,
    label: id,
    cwd: '/repo',
    status: 'idle',
    lastActiveAt: Date.now(),
    modelId: 'test-model',
    tokenCount: 0,
  }
}

function mountPanel(sessionId: string | null) {
  return mount(Panel, {
    props: {
      panelId: 'panel-root',
      sessionId,
      sessionLabel: sessionId ?? '',
      sessionDir: '/repo',
      status: 'done' as never,
    },
    global: { stubs: panelStubs },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  flowState.isActive.value = false
  // useSessionDerivations 的 statusCache 是模块级（同 id 复用 ComputedRef），跨测试残留。
  // 各用例新建独立 pinia，但缓存仍持有上个用例的 chat/session store 引用（已随旧 pinia 失活），
  // 导致 derivedStatus 复用陈旧闭包。每个用例前清空缓存，保证派生绑定当前 pinia 的 store。
  invalidateStatusCache()
})

describe('E1: 提交后空窗期 pending 态（核心 bug 回归）', () => {
  it('addPendingSend 后 isActive=true → derivedStatus=pending，渲染 running badge（§5.6A）', () => {
    const chat = useChatStore()
    const sessionStore = useSessionStore()
    const { derivedStatus } = useSessionDerivations()

    const session = makeSession('s1')
    sessionStore.appendSession(session)

    // 用户提交瞬间：pendingSend 填空窗（pi 尚未 message_start）
    chat.addPendingSend('s1')
    expect(chat.isActive('s1')).toBe(true)

    // derivedStatus 响应式计算应为 pending
    const status = derivedStatus('s1').value
    expect(status).toBe('pending')

    // mount SessionItem 传 pending status → 渲染 running badge（spec §5.6A D12 列表主行范式）
    const wrapper = mount(SessionItem, {
      props: { session, active: true, status },
    })
    // pending → 左侧 hollow icon（accent 空心圆）
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.find('.border-accent').exists()).toBe(true)
    expect(icon.find('.animate-spin').exists()).toBe(false)

    // 清理 pendingSend timer 避免 leak
    chat.clearPendingSend('s1')
  })
})

describe('E2: 非焦点 session 提交后 pending 态（activeId 限定已移除）', () => {
  it('activeId=A + addPendingSend(B) → derivedStatus(B)=pending', () => {
    const chat = useChatStore()
    const sessionStore = useSessionStore()
    const { derivedStatus } = useSessionDerivations()

    const sessionA = makeSession('A')
    const sessionB = makeSession('B')
    sessionStore.appendSession(sessionA)
    sessionStore.appendSession(sessionB)

    // 模拟 split：A 是焦点 panel，B 是非焦点 panel
    sessionStore.activeId = 'A'
    expect(sessionStore.active?.id).toBe('A')

    // 用户在 B panel 提交（B 非焦点）→ pendingSend(B) 应驱动 B 的 pending
    chat.addPendingSend('B')
    expect(chat.isActive('B')).toBe(true)

    // B 非焦点但 derivedStatus(B) 仍 pending（activeId 限定已移除，bug 修复核心）
    const statusB = derivedStatus('B').value
    expect(statusB).toBe('pending')

    // mount SessionItem(B) 传 pending → 渲染 running badge（spec §5.6A D12）
    const wrapper = mount(SessionItem, {
      props: { session: sessionB, active: false, status: statusB },
    })
    const icon = wrapper.find('[data-testid="session-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.find('.border-accent').exists()).toBe(true)
    expect(icon.find('.animate-spin').exists()).toBe(false)

    chat.clearPendingSend('B')
  })
})

describe('E3: compact 期 compacting 态 + Panel 渲染 Composer（conversation 恒挂，D2 存在性与模态正交）', () => {
  it('setOccupancy(s1,{compacting:true}) → derivedStatus=compacting；Panel 渲染 Composer', () => {
    const chat = useChatStore()
    const sessionStore = useSessionStore()
    const { derivedStatus } = useSessionDerivations()

    const session = makeSession('s1')
    sessionStore.appendSession(session)

    // 触发 compact：compact 互斥态开启
    chat.setOccupancy('s1', { turn: 'idle', compacting: true, bash: false })
    expect(chat.isCompacting('s1')).toBe(true)

    // compact 不并入 isActive（设计约束：用户不可干预压缩流程）
    expect(chat.isActive('s1')).toBe(false)

    // derivedStatus 应为 compacting（compact 视觉态独立分支）
    const status = derivedStatus('s1').value
    expect(status).toBe('compacting')

    // mount Panel(s1) → Composer 在 DOM 中（conversation 恒常驻，compacting 禁用模态由 Composer 内部承担）
    const wrapper = mountPanel('s1')
    expect(wrapper.find('[data-testid="composer"]').exists()).toBe(true)
  })
})

describe('E4: Panel landing 态不被其他 session 流式误伤（回归保护）', () => {
  it('Panel(sessionId=null) + session-A 流式 → 渲染 Landing，不落兜底空态', () => {
    const chat = useChatStore()

    // 模拟 A 会话正在流式（message_start 创建 streaming entity）
    chat.applyMessageEvent('session-A', {
      type: 'message.message_start',
      payload: { sessionId: 'session-A', messageId: 'a1' },
    })
    expect(chat.isGenerating('session-A')).toBe(true)

    // Panel 绑定 sessionId=null（landing 态，点新建后）。panel-view 派生下 landing
    // 需 flow 活跃（D1：landing ⟺ !sessionId && isFlowActive）；isFlowActive 与
    // chat streaming 解耦，A 的流式不误伤 landing panel（本用例回归语义）
    flowState.isActive.value = true
    const wrapper = mountPanel(null)

    // 关键回归断言：A 流式不误伤 landing panel
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(true)
    // 不落兜底空态（「选择左侧会话开始」）
    expect(wrapper.text()).not.toContain('选择左侧会话开始')
  })

  it('Panel(sessionId=null) + flow idle → 落 empty 空态（D1 派生：无 session 且流程未活跃无 Landing）', () => {
    const chat = useChatStore()
    chat.applyMessageEvent('session-A', {
      type: 'message.message_start',
      payload: { sessionId: 'session-A', messageId: 'a1' },
    })

    // flow 未活跃（无编排入口触发 startFlow）→ empty 兜底空态，不再渲染 Landing
    const wrapper = mountPanel(null)

    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('选择左侧会话开始')
  })
})

describe('DOT_CLASS SSOT 一致性（附加 sanity）', () => {
  it('streaming 态 DOT_CLASS 仍含 bg-accent（静态圆点 fallback 映射未被意外修改）', () => {
    // DOT_CLASS 是 8 态 → 圆点 class 的 SSOT。组件层改用 STATUS_ICON 语义图标，
    // 但 DOT_CLASS 表不可漂移，仍作为 fallback 使用。
    expect(DOT_CLASS.streaming).toContain('bg-accent')
    expect(DOT_CLASS.done).toBe('bg-success')
  })
})
