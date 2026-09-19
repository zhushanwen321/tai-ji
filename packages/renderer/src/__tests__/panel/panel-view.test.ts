/**
 * Panel 渲染分支派生测试（panel-view switch 重写，单元 T3）。
 *
 * Panel 主区与输入面判据收敛为 usePanelView → derivePanelView 单点派生（D1/D2/D5），本文件锁
 * renderer 装配层的派生消费行为（core 纯函数的 64 组合表在
 * packages/core/src/domain/session/__tests__/panel-view.test.ts，V5）。
 *
 * 覆盖（每条至少一个用户可见 DOM 断言）：
 * - PV1 flow 残留免疫（G2 结构实证）：flow 活跃 + 有会话有消息 → 对话流 + Composer，
 *   Landing 不渲染（旧判据下此状态 turn 结束后 composer 消失——用户报告的原始 bug）
 * - PV2 landing：无 session + flow 活跃 → Landing；band 不重复挂 composer
 * - PV3 empty：绑定空会话（有 sid 无消息，flow idle）→ 空对话态 + Composer（直输）；
 *   无 session + flow idle → 选会话空态，无输入面
 * - PV4 dead：占位视图（重开入口），无 Composer；表单请求在场仍无 overlay
 *   （W6「dead 不应答」由派生优先级 dead > form 承接，收集侧不重复判）
 * - PV5 form overlay：请求到达 → FormOverlay 替换 Composer；应答出队 → Composer 恢复
 * - PV6 trace 输入面保留（D5/V4，一致性审查 R-U1）：trace 视图 → TraceView 替换对话流
 *   位置 + Composer 保留；trace + 表单请求 → overlay 承接应答
 * - PV7 respawn 过渡态（T4）：dead + respawnPending → 过渡条 + Composer
 *   保持（dead 占位被抑制）；收口后回落 dead 占位
 *
 * mock 策略：vi.hoisted 模块级可变对象（对齐 ask-user-inline.test.ts / landing.test.ts
 * 既有基建）——useExtensionUI（ask-user 请求队列）与 useNewTaskFlow（flow 单例态）
 * 可控；chat/session/panel store 与 trace store 用真实实现（消息 hydrate / markDead /
 * setTraceView 走真实状态；trace 分区键经 bindTraceSessionId 重绑到当前 pinia）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/panel-view.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { computed } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Panel from '@/components/panel/Panel.vue'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import {
  _resetTraceStoreForTest,
  bindTraceSessionId,
  setTraceView,
} from '@/composables/features/trace/useSessionTrace'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import type { SessionSummary } from '@taiji/shared'

// ── vi.hoisted：mock 状态在 vi.mock 工厂执行前就绪，且可在 it 中改值（普通 { value } 等价 Ref） ──
const mockState = vi.hoisted(() => ({
  flowIsActive: { value: false as boolean },
}))

// 表单请求用真 Vue ref（async 工厂内建，测试经 __mockFormReq 拿同一引用）：
// PV5「应答出队 → Composer 恢复」断言挂载后的响应式更新，普通对象不建依赖不触发重算。
vi.mock('@/composables/useExtensionUI', async () => {
  const { ref } = await import('vue')
  const formReq = ref<ExtensionUIRequest | undefined>(undefined)
  return {
    __mockFormReq: formReq,
    useExtensionUI: () => ({
      currentFormRequest: formReq,
      respond: vi.fn(),
      cancel: vi.fn(),
    }),
    formFilter: (req: { form?: boolean }) => req.form === true,
  }
})

vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    isActive: mockState.flowIsActive,
    state: { value: mockState.flowIsActive.value ? 'landing' : 'idle' },
    startFlow: vi.fn(),
    cancelFlow: vi.fn(),
    resetNewTaskFlow: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))

// stub 子组件（断言其挂载位/互斥位；重渲染成本与重依赖隔离）
const stubs = {
  MessageStream: { template: '<div data-testid="msg-stream" />' },
  Composer: { template: '<div data-testid="composer-box" />' },
  FormOverlay: { template: '<div data-testid="form-overlay" />' },
  Landing: { template: '<div data-testid="landing">landing</div>' },
  TraceView: { template: '<div data-testid="trace-view" />' },
}

function mountPanel(sessionId: string | null) {
  return mount(Panel, {
    props: {
      panelId: 'panel-root',
      sessionId,
      sessionDir: '/repo',
    },
    global: { stubs },
  })
}

const formReq: ExtensionUIRequest = {
  sessionId: 's1',
  requestId: 'req-1',
  method: 'select',
  form: true,
  formQuestions: [{ type: 'choice', header: 'db', question: '选哪个数据库?', options: [{ label: 'Postgres' }] }],
}

// 拿 mock 工厂内建的同一 ref（直接改 .value 驱动挂载后重算）
const extUIMock = await import('@/composables/useExtensionUI')

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

/** 绑定有消息的会话 s1（真实 chat store hydrate） */
function hydrateS1Messages(): void {
  const chat = useChatStore()
  chat.hydrate('s1', [
    { id: 'm1', role: 'user', content: 'hi', status: 'complete', timestamp: 1 },
  ])
}

/** 单 panel 契约：trace 分区键（focusedSessionId）与 props.sessionId 一致（分区键跟随） */
function focusSession(sid: string | null): void {
  usePanelStore().loadSession(ROOT_PANEL_ID, sid)
}

beforeEach(() => {
  setActivePinia(createPinia())
  // trace 分区是模块级单例（不随 pinia 重建）：reset 后重绑分区键到当前 pinia 的
  // panel store（对齐 useSessionTrace.test.ts 模式），防上一用例的 trace 视图态残留
  _resetTraceStoreForTest()
  bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
  extUIMock.__mockFormReq.value = undefined
  mockState.flowIsActive.value = false
})

describe('PV1: flow 残留免疫（G2 结构实证——用户报告 bug 的原始触发态）', () => {
  it('flow 活跃 + 有会话有消息 → 对话流 + Composer 常驻，Landing 不渲染', () => {
    mockState.flowIsActive.value = true // flow 单例残留活跃（历史卡 landing / 未知缝隙）
    hydrateS1Messages()

    const wrapper = mountPanel('s1')

    // 用户可见：对话流与输入面同时在，输入面不因 flow 残留消失
    expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // Landing 判据读不到非空 sessionId——「有会话 × landing」在派生上不可表达
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })

  it('flow 活跃 + 有会话无消息（新契约无 turn 维度，flow 残留等价探针）→ 空对话态 + Composer', () => {
    mockState.flowIsActive.value = true

    const wrapper = mountPanel('s1')

    expect(wrapper.text()).toContain('输入消息开始对话')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })
})

describe('PV2: landing（新建任务流程唯一承接场景：无 session + flow 活跃）', () => {
  it('无 session + flow 活跃 → Landing 渲染，band 不重复挂 Composer', () => {
    mockState.flowIsActive.value = true

    const wrapper = mountPanel(null)

    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(true)
    // landing 态 composer 由 Landing 内嵌，band 不重复渲染（D5 判据）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(false)
  })
})

describe('PV3: empty 兜底（flow 未活跃）', () => {
  it('绑定空会话（有 sid 无消息，flow idle）→ 空对话态 + Composer 供直输', () => {
    const sessionStore = useSessionStore()
    sessionStore.appendSession(makeSession('s1'))

    const wrapper = mountPanel('s1')

    expect(wrapper.text()).toContain('输入消息开始对话')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })

  it('无 session + flow idle（选会话空态）→ 兜底空态文案，无输入面', () => {
    const wrapper = mountPanel(null)

    expect(wrapper.text()).toContain('选择左侧会话开始')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing"]').exists()).toBe(false)
  })
})

describe('PV4: dead 占位（W6：dead 不应答，派生优先级 dead > form 承接）', () => {
  it('dead → 占位视图 + 重开入口，无 Composer', () => {
    const sessionStore = useSessionStore()
    sessionStore.appendSession(makeSession('s1'))
    sessionStore.markDead('s1')

    const wrapper = mountPanel('s1')

    expect(wrapper.text()).toContain('会话进程已退出')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(false)
  })

  it('dead + 表单请求在场 → 仍无 overlay（互斥由派生吞掉，收集侧不重复判）', () => {
    const sessionStore = useSessionStore()
    sessionStore.appendSession(makeSession('s1'))
    sessionStore.markDead('s1')
    extUIMock.__mockFormReq.value = formReq

    const wrapper = mountPanel('s1')

    expect(wrapper.text()).toContain('会话进程已退出')
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })
})

describe('PV7: respawn 过渡态（T4：恢复窗口不进终态页）', () => {
  it('dead + respawnPending → 过渡条渲染 + Composer 保持（dead 占位被抑制）', () => {
    const sessionStore = useSessionStore()
    const chat = useChatStore()
    sessionStore.appendSession(makeSession('s1'))
    sessionStore.markDead('s1')
    chat.markRespawnPending('s1')

    const wrapper = mountPanel('s1')

    // 用户可见 DOM 断言：过渡条（「正在自动恢复」文案）在位；对话流保持；Composer 可用
    expect(wrapper.find('[data-testid="respawn-pending-bar"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('正在自动恢复')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('会话进程已退出')
  })

  it('过渡态收口（clearRespawnPending）→ 回落 dead 占位（熔断/超时/手动收口后的终态回归）', async () => {
    const sessionStore = useSessionStore()
    const chat = useChatStore()
    sessionStore.appendSession(makeSession('s1'))
    sessionStore.markDead('s1')
    chat.markRespawnPending('s1')
    const wrapper = mountPanel('s1')
    expect(wrapper.find('[data-testid="respawn-pending-bar"]').exists()).toBe(true)

    chat.clearRespawnPending('s1')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="respawn-pending-bar"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('会话进程已退出')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('message_start 收口语义（恢复窗口发消息的 join 路径：dead 复位 + T4 条）→ 对话流恢复，不进终态页', async () => {
    // [T4 回流修复] Gate B A7 缺陷：恢复窗口内发消息经 runtime 惰性恢复
    // join 完成，无 session.restored 帧 → 此前过渡态无收口信号，超时回落 dead 终态页。
    // 修复后 useChat 的 message_start 收口 gate 执行同构三件套（clear + T4 条 + revive），
    // 本用例锁定收口后的用户可见 DOM 终态（gate 链路见 respawn-pending.test.ts ⑧）。
    const sessionStore = useSessionStore()
    const chat = useChatStore()
    sessionStore.appendSession(makeSession('s1'))
    sessionStore.markDead('s1')
    chat.markRespawnPending('s1')
    const wrapper = mountPanel('s1')
    expect(wrapper.find('[data-testid="respawn-pending-bar"]').exists()).toBe(true)

    chat.clearRespawnPending('s1')
    chat.appendRespawnNotice('s1', 'restored', '会话引擎已从崩溃中恢复。')
    sessionStore.revive('s1')
    await wrapper.vm.$nextTick()

    // 用户可见 DOM 断言：dead 占位不出现（无需手动「重新打开」）；过渡条消失；
    // 消息流渲染位恢复（T4 提示条入流——notice 数据断言见 respawn-pending.test.ts ⑧）；
    // Composer 保持可用
    expect(wrapper.text()).not.toContain('会话进程已退出')
    expect(wrapper.find('[data-testid="respawn-pending-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })
})

describe('PV5: form overlay 互斥替换（D5：overlay ⟺ (conversation || trace) && input===form）', () => {
  it('有表单请求 → FormOverlay 替换 Composer', () => {
    hydrateS1Messages()
    extUIMock.__mockFormReq.value = formReq

    const wrapper = mountPanel('s1')

    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)
  })

  it('应答出队后 → Composer 恢复（阻塞解除回到常驻输入面）', async () => {
    hydrateS1Messages()
    extUIMock.__mockFormReq.value = formReq
    const wrapper = mountPanel('s1')
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)

    // 用户应答 → 请求出队（store 队列空）
    extUIMock.__mockFormReq.value = undefined
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })
})

describe('PV6: trace 态输入面保留（D5/V4：session-trace 契约「composer 保留，不打断对话能力」）', () => {
  it('trace 视图 → TraceView 替换对话流位置，Composer 保留', () => {
    hydrateS1Messages()
    focusSession('s1')
    setTraceView('s1', 'trace')

    const wrapper = mountPanel('s1')

    // 用户可见：Trace 视图替换对话流，输入面不被打断（composer 保留在底部）
    expect(wrapper.find('[data-testid="trace-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="msg-stream"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
  })

  it('trace 视图 + 表单请求 → overlay 承接应答；应答出队后 composer 恢复、TraceView 不受影响', async () => {
    hydrateS1Messages()
    focusSession('s1')
    setTraceView('s1', 'trace')
    extUIMock.__mockFormReq.value = formReq

    const wrapper = mountPanel('s1')

    // 前半程（用户可见）：trace 态表单 overlay 正常出现并替换 composer（V4 验收语义）
    expect(wrapper.find('[data-testid="trace-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(false)

    // 后半程：应答出队（响应式驱动同 PV5）→ overlay 消失、composer 恢复，TraceView 保持
    extUIMock.__mockFormReq.value = undefined
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="form-overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="trace-view"]').exists()).toBe(true)
  })
})
