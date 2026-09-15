/**
 * SubagentTab 组件测试（E-4，subagent-realtime-channel §6.1/§6.3 退役步骤 1）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者：entry 帧消费走 chatStore.applySubagentEntries（routeInbound 链，不经组件）——
 *   组件只负责快照拉取 + 恒订阅 stream_delta
 * - 使用者（黑盒 DOM）：帧先于 drawer 打开到达 → 打开 drawer「打开即完整」（快照替换后
 *   MessageStream 渲染完整对话流，消息文本 DOM 可见）；entry 帧继续到达（帧路由链）→
 *   DOM 增量出现新消息
 * - 观察者：非 running record 也恒订阅（R3 消解：订阅时机与 record 状态机解耦）
 *
 * virtua mock / 壳 deps mock 与 MessageStream-subagent-force-working.test.ts 同款
 * （该文件头有完整论证：happy-dom 无布局，Virtualizer stub 全量渲染 scoped slot）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/subagent-tab.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSubagentStore, subagentVirtualId } from '@/stores/subagent'
import { openSubagent, bindDrawerSessionId, _resetDrawerForTest } from '@xyz-agent/core/domain/drawer'
import SubagentTab from '@/components/panel/SubagentTab.vue'
import type { Message, SubagentRecord } from '@xyz-agent/shared'
import * as events from '@xyz-agent/core/transport/api'

vi.mock('virtua/vue', async () => {
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
      },
      setup() {
        return {
          scrollSize: 600,
          scrollOffset: 0,
          viewportSize: 400,
          cache: {},
          scrollToIndex: vitest.fn(),
          getItemOffset: vitest.fn(() => 0),
          getItemSize: vitest.fn(() => 200),
          findItemIndex: vitest.fn(() => 0),
          scrollTo: vitest.fn(),
          scrollBy: vitest.fn(),
        }
      },
      render(ctx) {
        return h(
          'div',
          { class: 'mock-virtualizer' },
          (ctx.data as unknown[]).map((item, index) => ctx.$slots.default?.({ item, index }) ?? []),
        )
      },
    }),
  }
})

// 壳 deps mock（对齐 MessageStream-subagent-force-working.test.ts：聚焦数据链不需真 deps）
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    editAndResend: vi.fn(),
    loadMoreHistory: vi.fn(),
    hasMoreHistory: () => false,
  }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSession: vi.fn(), abortHandoff: vi.fn() }),
}))

// sessionApi mock：fetchAndInject 内部调 getSubagentHistory（快照腿）
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  getSubagentHistory: vi.fn(),
  getSubagents: vi.fn().mockResolvedValue([]),
  subagentAction: vi.fn(),
  getAgentCallHistory: vi.fn(),
}))
// subagent store 经 @/api 门面导入 session；vitest 环境 VITE_MOCK=true 时门面把 session
// 解析到 src/api/mock（非 domains/session，mockApi.getSubagentHistory 在测试里永不 resolve，
// fetchAndInject 卡死 → 恒订阅不执行）。需把门面 session 指回上面 mock 的 domains 命名空间，
// 保证 store 与断言用的是同一个 vi.fn()（同 stores/subagent.test.ts 手法）。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  return { ...actual, session }
})
// events mock：断言恒订阅（subscribeStream 双键注册）
vi.mock('@xyz-agent/core/transport/api', () => ({
  on: vi.fn(() => vi.fn()),
  off: vi.fn(),
  dispatch: vi.fn(),
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
  onGlobal: vi.fn(() => vi.fn()),
  onGlobalType: vi.fn(() => vi.fn()),
  onCrossSession: vi.fn(() => vi.fn()),
  dispatchCrossSession: vi.fn(),
}))

import * as sessionApi from '@xyz-agent/core/transport/api/domains/session'

// happy-dom 不提供真实 ResizeObserver 布局测量
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Turn stub：透出对话流内容（黑盒断言面——MessageStream 渲染树末端的消息文本）。
 * template 表达式受限于 stub 形态，用 computed 归一 user/assistant 文本。
 */
const globalStubs = {
  Turn: defineComponent({
    name: 'Turn',
    props: { turn: { type: Object, required: true } },
    setup(props) {
      const text = () => {
        const t = props.turn as { user?: { content: unknown }; assistants?: Array<{ content: unknown }> }
        const asText = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c))
        return [
          asText(t.user?.content),
          ...(t.assistants ?? []).map((a) => asText(a.content)),
        ].join('|')
      }
      return () => h('div', { 'data-testid': 'turn-stub' }, text())
    },
  }),
  SystemNotice: { name: 'SystemNotice', template: '<div />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

const MAIN_SID = 's-tab-main'
const SUB_ID = 'sub-tab-1'
const VIRTUAL_ID = subagentVirtualId(MAIN_SID, SUB_ID)

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: SUB_ID,
    sessionFile: null,
    agent: 'general-purpose',
    slug: 'worker',
    task: 'do something',
    status: 'running',
    ...overrides,
  }
}

function mountTab() {
  const wrapper = mount(SubagentTab, {
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
  return wrapper
}

/** 等待 fetchAndInject（async watch immediate → RPC microtask → setMessages）落地到渲染 */
async function settle(wrapper: Awaited<ReturnType<typeof mountTab>>) {
  await flushPromises()
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()
}

describe('SubagentTab E-4 接入（entry 帧 + 恒订阅）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    _resetDrawerForTest()
    // drawer control 是 per-session 分区（sidRef 绑定驱动）：绑定固定 sid 才能让 openSubagent
    // 的写入与 SubagentTab 的 useDrawerControl 读到同一分区（renderer 由 useSideDrawer 顶层
    // 绑 focusedSessionId，测试直连 core 域同款手法——PanelContainer.test.ts 先例）
    bindDrawerSessionId(ref(MAIN_SID))
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    // records 预置（subagentMeta 标题栏读分区；不依赖 session.subagents 推送）
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord()])
  })

  it('帧先于打开 → 打开即完整：entry 帧写分区 + 快照替换后 DOM 渲染完整对话流', async () => {
    // ① 帧先于 drawer 打开到达（routeInbound 兜底链 → chatStore.applySubagentEntries）
    const chat = useChatStore()
    chat.applySubagentEntries(VIRTUAL_ID, [
      {
        type: 'message',
        parentId: null,
        timestamp: '2026-08-25T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '分析这个仓库' }], timestamp: 1000 },
      },
      {
        type: 'message',
        parentId: null,
        timestamp: '2026-08-25T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '第一段产出' }], timestamp: 2000 },
      },
    ])
    expect(chat.getMessages(VIRTUAL_ID)).toHaveLength(2)

    // ② drawer 打开：fetchAndInject 快照（文件直读全量）替换分区
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([
      { id: 'uuid-u1', role: 'user', content: '分析这个仓库', status: 'complete', timestamp: 1000 },
      { id: 'uuid-a1', role: 'assistant', content: '第一段产出', status: 'complete', timestamp: 2000 },
    ] as Message[])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })

    const wrapper = mountTab()
    await settle(wrapper)

    // 黑盒 DOM：打开即完整（快照内容全量可见）
    const turns = wrapper.findAll('[data-testid="turn-stub"]')
    expect(turns.length).toBeGreaterThanOrEqual(1)
    expect(turns[0]?.text()).toContain('分析这个仓库')
    expect(turns[0]?.text()).toContain('第一段产出')

    // ③ 新 entry 帧继续到达（帧路由链）→ DOM 增量出现新消息（同 turn 追加 assistant：
    // message-turns 的 D11 分组 = user 起点到下一 user 之前，第二条 assistant 并入同 turn）
    chat.applySubagentEntries(VIRTUAL_ID, [
      {
        type: 'message',
        parentId: null,
        timestamp: '2026-08-25T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '第二段产出' }], timestamp: 4000 },
      },
    ])
    await settle(wrapper)
    const turnsAfter = wrapper.findAll('[data-testid="turn-stub"]')
    expect(turnsAfter.length).toBe(1)
    expect(turnsAfter[0]?.text()).toContain('第一段产出')
    expect(turnsAfter[0]?.text()).toContain('第二段产出')

    wrapper.unmount()
  })

  it('恒订阅（R3 消解）：非 running record 打开也注册 stream_delta 双键订阅', async () => {
    // 非 running（done）record：旧逻辑 isRunning=false 不订阅；E-4 恒订阅
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ status: 'done' })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })

    const wrapper = mountTab()
    await settle(wrapper)

    // 快照腿确实走了 mock（而非 VITE_MOCK 的 mockApi 挂起实现），恒订阅才有执行机会
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledWith(MAIN_SID, SUB_ID)
    // 双键订阅（主 sid + 虚拟分区 id，tee 帧 payload.sessionId 归属差异适配）
    expect(events.on).toHaveBeenCalledWith(MAIN_SID, expect.any(Function))
    expect(events.on).toHaveBeenCalledWith(VIRTUAL_ID, expect.any(Function))
    wrapper.unmount()
  })

  it('引擎 badge（U3 D9）：engine 缺省 → 常态 badge 显示 pi', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ engine: undefined })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const badge = wrapper.find('[data-testid="subagent-engine-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('pi')
    expect(badge.classes()).not.toContain('text-warn')
    wrapper.unmount()
  })

  it('引擎 badge：engine=zcode → 常态 badge 显示 zcode', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ engine: 'zcode' })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const badge = wrapper.find('[data-testid="subagent-engine-badge"]')
    expect(badge.text()).toBe('zcode')
    expect(badge.classes()).not.toContain('text-warn')
    wrapper.unmount()
  })

  it('引擎 badge：engineFallback → 警告态，文案「请求 zcode → 已回退 pi」+ title 恢复指引', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: 'pi', engineFallback: { from: 'zcode', reason: 'engine_probe_failed' } }),
    ])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const badge = wrapper.find('[data-testid="subagent-engine-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('请求 zcode → 已回退 pi')
    // 警告态样式（--warn 语义色）
    expect(badge.classes()).toContain('text-warn')
    // title 展开恢复指引（含回退引擎名）
    expect(badge.attributes('title')).toContain('zcode')
    wrapper.unmount()
  })

  // ── 停因词展示（永久会话模型 §3.2.8 U8b：详情面板 stopReason 原文 kebab-case，对齐 U8a TUI 决策）──

  it('停因词：idle + stopReason → 标题栏渲染原文 kebab-case（为什么停一句话解释）', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ status: 'idle', stopReason: 'interrupted-by-restart' }),
    ])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const reason = wrapper.find('[data-testid="subagent-stop-reason"]')
    expect(reason.exists()).toBe(true)
    expect(reason.text()).toBe('interrupted-by-restart')
    wrapper.unmount()
  })

  it('停因词：W4 新型（[U5/D4] adoptEngineDeath：running + stopReason=failed）→ 有值即渲染', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({
        status: 'running',
        stopReason: 'failed',
        result: 'round did not complete: boom',
      }),
    ])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const reason = wrapper.find('[data-testid="subagent-stop-reason"]')
    expect(reason.exists()).toBe(true)
    expect(reason.text()).toBe('failed')
    wrapper.unmount()
  })

  it('停因词：running（在飞轮无停因）与无 stopReason 的 record → 不渲染停因元素', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ status: 'running' })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    expect(wrapper.find('[data-testid="subagent-stop-reason"]').exists()).toBe(false)

    // idle 但无停因（从未收口 / 存量数据）→ 同样不渲染
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ status: 'idle' })])
    await settle(wrapper)
    expect(wrapper.find('[data-testid="subagent-stop-reason"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('空态：未选中 subagent 时渲染空态占位（首屏冒烟）', () => {
    const wrapper = mountTab()
    expect(wrapper.find('[data-testid="drawer-subagent-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="drawer-subagent-tab"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('SubagentTab U4：zcode 终态渲染 + 运行中 coarse 提示', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    _resetDrawerForTest()
    bindDrawerSessionId(ref(MAIN_SID))
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord()])
  })

  it('running + engine=zcode → coarse 提示条渲染（文案含引擎名与「不支持实时流」）', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ engine: 'zcode' })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const hint = wrapper.find('[data-testid="subagent-coarse-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('zcode')
    expect(hint.text()).toContain('不支持实时流')
    wrapper.unmount()
  })

  it('running + 无 engine（pi）→ 无提示条，恒订阅流式行为不变', async () => {
    // makeRecord 默认 status running（pi 真在跑场景）
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    expect(wrapper.find('[data-testid="subagent-coarse-hint"]').exists()).toBe(false)
    // pi 流式通路照旧：stream_delta 双键订阅已注册
    expect(events.on).toHaveBeenCalledWith(MAIN_SID, expect.any(Function))
    expect(events.on).toHaveBeenCalledWith(VIRTUAL_ID, expect.any(Function))
    wrapper.unmount()
  })

  it('sessionFile=null + engine=zcode → 仍发起 getSubagentHistory RPC，无空态短路', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: 'zcode', sessionFile: null, status: 'done', endedAt: 2000 }),
    ])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledWith(MAIN_SID, SUB_ID)
    // 选中态下不显示「未选中」空态，也无加载错误
    expect(wrapper.find('[data-testid="drawer-subagent-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="drawer-subagent-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('历史返回 zcode Message[]（含 toolCalls 的 assistant turn）→ 正常渲染消息列表', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ engine: 'zcode', status: 'done' })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([
      { id: 'zc-u1', role: 'user', content: '分析仓库', status: 'complete', timestamp: 1000 },
      {
        id: 'zc-a1',
        role: 'assistant',
        content: '已完成分析',
        status: 'complete',
        timestamp: 2000,
        toolCalls: [
          {
            id: 'zc-tc1',
            toolName: 'Read',
            input: { path: 'a.ts' },
            output: 'file content',
            status: 'completed',
            startTime: 1500,
            endTime: 1600,
          },
        ],
      },
    ] as Message[])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const turns = wrapper.findAll('[data-testid="turn-stub"]')
    expect(turns.length).toBeGreaterThanOrEqual(1)
    expect(turns[0]?.text()).toContain('分析仓库')
    expect(turns[0]?.text()).toContain('已完成分析')
    wrapper.unmount()
  })

  it('RPC 失败 + engine=zcode 有 result → 错误面板内展示 outcome 摘要（不白屏）', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: 'zcode', status: 'done', result: '最终结论：一切正常', endedAt: 2000 }),
    ])
    vi.mocked(sessionApi.getSubagentHistory).mockRejectedValue(new Error('rpc timeout'))
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    expect(wrapper.find('[data-testid="drawer-subagent-error"]').exists()).toBe(true)
    const summary = wrapper.find('[data-testid="subagent-outcome-summary"]')
    expect(summary.exists()).toBe(true)
    expect(summary.text()).toContain('最终结论：一切正常')
    wrapper.unmount()
  })

  it('RPC 返回空结果 + engine=zcode 有 result → 客户端 outcome 兜底投影渲染（不白屏）', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: 'zcode', status: 'done', result: '兜底摘要文本', endedAt: 2000 }),
    ])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const turns = wrapper.findAll('[data-testid="turn-stub"]')
    expect(turns.length).toBeGreaterThanOrEqual(1)
    expect(turns[0]?.text()).toContain('do something')
    expect(turns[0]?.text()).toContain('兜底摘要文本')
    expect(wrapper.find('[data-testid="drawer-subagent-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('RPC 返回空结果 + pi record → seed task 用户气泡（1 turn），不注入兜底投影', async () => {
    // drawer-blank-fix T5 预期翻转（旧断言：0 turn「行为不变」）：u2 seed 生效后，pi 空历史
    // 种入 record.task 用户气泡（分区 1 turn），杜绝首开白屏；pi 仍不走 outcome 兜底投影。
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ status: 'done', result: 'pi 轮终结果' })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    const turns = wrapper.findAll('[data-testid="turn-stub"]')
    expect(turns.length).toBe(1)
    expect(turns[0]?.text()).toContain('do something')
    expect(wrapper.find('[data-testid="subagent-outcome-summary"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

/**
 * 非 pi 终态回填桥（status watch，设计 D2 / docs/design/subagent-nonpi-visibility-followups.md
 * §3.3）：运行中打开的 tab 在 record 跨越 running→终态 时经 loadSubagentData 重拉一次，
 * 对话流自动收敛到完整内容。四守卫反例（pi 零变化 / vid 切换 / 已终态不二拉）同组守护。
 */
describe('SubagentTab 非 pi 终态回填（status watch，D2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    _resetDrawerForTest()
    bindDrawerSessionId(ref(MAIN_SID))
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ engine: 'zcode' })])
  })

  it('非 pi running→done 推送 → fetchAndInject 第 2 次拉取 + coarse hint 消失 + 终态内容出现', async () => {
    vi.mocked(sessionApi.getSubagentHistory)
      // 首拉：运行中空历史（窗口 B 形态，task seed 兜底）
      .mockResolvedValueOnce([])
      // 回填拉取：终态完整对话
      .mockResolvedValueOnce([
        { id: 'ref-u1', role: 'user', content: 'do something', status: 'complete', timestamp: 1000 },
        { id: 'ref-a1', role: 'assistant', content: '终态完整产出', status: 'complete', timestamp: 2000 },
      ] as Message[])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)

    // 运行中形态：coarse hint 在场，首拉 1 次
    expect(wrapper.find('[data-testid="subagent-coarse-hint"]').exists()).toBe(true)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(1)

    // 终态推送（applyRecords → currentRecord status 跨越 running→done）
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: 'zcode', status: 'done', result: '终态完整产出', endedAt: 2000 }),
    ])
    await settle(wrapper)

    // 回填拉取触发第 2 次（同参数）
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(2)
    expect(sessionApi.getSubagentHistory).toHaveBeenLastCalledWith(MAIN_SID, SUB_ID)
    // 黑盒 DOM：coarse hint 消失 + 终态内容出现在消息流
    expect(wrapper.find('[data-testid="subagent-coarse-hint"]').exists()).toBe(false)
    const turns = wrapper.findAll('[data-testid="turn-stub"]')
    expect(turns.length).toBeGreaterThanOrEqual(1)
    expect(turns[0]?.text()).toContain('do something')
    expect(turns[0]?.text()).toContain('终态完整产出')
    wrapper.unmount()
  })

  it('pi record（engine 缺省）同样推送 running→done → fetchAndInject 仍 1 次（零变化守护）', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [makeRecord({ engine: undefined })])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(1)

    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: undefined, status: 'done', result: 'pi 结果', endedAt: 2000 }),
    ])
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('vid 切换：停留 B 期间推 A 终态 → 不为 A 触发加载；切回 A → vid watch 首拉兜底', async () => {
    const SUB_ID_B = 'sub-tab-2'
    const VIRTUAL_ID_B = subagentVirtualId(MAIN_SID, SUB_ID_B)
    const recordA = makeRecord({ engine: 'zcode' })
    useSubagentStore().applyRecords(MAIN_SID, [
      recordA,
      makeRecord({ subagentId: SUB_ID_B, engine: 'zcode' }),
    ])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(1)

    // 切到 B：vid watch 首拉 B（第 2 次，参数 B）
    openSubagent({ virtualId: VIRTUAL_ID_B, enteredFrom: 'chat' })
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(2)
    expect(sessionApi.getSubagentHistory).toHaveBeenLastCalledWith(MAIN_SID, SUB_ID_B)

    // 停留 B 期间 A 终态推送：status watch 的 vid 守卫跳过（A 非 current vid，源变化即切换守卫拦截）
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: 'zcode', status: 'done', result: 'A 结果', endedAt: 3000 }),
      makeRecord({ subagentId: SUB_ID_B, engine: 'zcode' }),
    ])
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(2)

    // 切回 A：vid watch 首拉兜底（非 status watch）
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(3)
    expect(sessionApi.getSubagentHistory).toHaveBeenLastCalledWith(MAIN_SID, SUB_ID)
    wrapper.unmount()
  })

  it('打开时已终态 → 首拉后推 records（status 不变 done→done）→ 不二次加载', async () => {
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: 'zcode', status: 'done', result: '结果', endedAt: 2000 }),
    ])
    vi.mocked(sessionApi.getSubagentHistory).mockResolvedValue([])
    openSubagent({ virtualId: VIRTUAL_ID, enteredFrom: 'chat' })
    const wrapper = mountTab()
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(1)

    // runtime 全量帧重推（status 无跨越）
    useSubagentStore().applyRecords(MAIN_SID, [
      makeRecord({ engine: 'zcode', status: 'done', result: '结果', endedAt: 2000 }),
    ])
    await settle(wrapper)
    expect(sessionApi.getSubagentHistory).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
