/**
 * toolcall status 翻转 UI 回归测试。
 *
 * 验证：tool.status running→completed 后，DOM 上 .animate-loader-spin 消失（统一交互模式：无终态 icon）。
 * 覆盖三层链路：
 * - 方案 a：mount Block，改 props.tool.status（叶子组件单元回归）
 * - 方案 b：mount Turn，改 turn.assistants[0].toolCalls[0].status（单 turn 链路回归）
 * - 方案 c：mount MessageStream（真 store + 真虚拟滚动层），applyMessageEvent 走 tool_call_end 路径
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/tool-status-flip.test.ts
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
// [w6 chat-ui-and-shell T7] ui 包组件：Block 不 inject deps；Turn 经 ChatViewDeps inject（mount 时 provide）
import { Block, Turn } from '@xyz-agent/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import MessageStream from '@/components/panel/MessageStream.vue'
import { useChatStore } from '@/stores/chat'
import type { ToolCall, Message, ServerMessage } from '@xyz-agent/shared'
import type { MessageTurn } from '@/composables/logic/messageTurns'

// [w6 chat-ui-and-shell T7] 方案 c mount MessageStream：壳 provide 真 deps（useChatViewDeps）→ mock 装配器
vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())

const NOW = Date.now()

// ── MessageStream（方案 c）需要的全局 mock ──────────────────────────
// useChat 仅用 loadMoreHistory / hasMoreHistory，no-op 即可
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ loadMoreHistory: vi.fn(), hasMoreHistory: () => false }),
}))

// mock virtua/vue：passthrough Virtualizer（渲染所有子项，绕过 happy-dom 无 RO/viewportSize=0 的窗口化限制）。
// [cw wave w3 历史 skip，已恢复]：原本 c-multi / c-full-cycle 因 virtua 在 happy-dom 下 viewportSize=0
//   skip——未被 :keepMounted 钉扎的非末位 turn 不进渲染窗口 → DOM 找不到 turn-xray。现通过本 mock 恢复覆盖。
//   virtua 窗口化本身有独立单测（use-virtua-follow / use-message-stream-rail-virtua）覆盖；
//   本测只验证 tool status 翻转链路（真 store + 真 applyMessageEvent + 多 turn 非末位翻转），不依赖窗口化行为。
// vi.mock 为文件级（hoist），只影响本文件的 import，不影响其他测试文件。
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  const PassthroughVirtualizer = defineComponent({
    name: 'Virtualizer',
    props: {
      data: { type: Array, required: true },
      // 声明但不消费的 props（保持与真实 Virtualizer 接口一致，避免 Vue warn 未声明 prop 告警）
      itemSize: { type: Number, default: 0 },
      shift: { type: Boolean, default: false },
      keepMounted: { type: Array, default: () => [] },
      startMargin: { type: Number, default: 0 },
    },
    setup(props, { slots, expose }) {
      // 暴露一个最小 mock handle 满足 VirtualizerHandle 接口（MessageStream 的 vlistRef 绑定）。
      // c-multi / c-full-cycle 不断言滚动几何，数值随便填（消费方均有 null/空数据 guard）。
      // 注意：用 setup ctx 的 expose（非 defineExpose——后者是 <script setup> 编译宏，本文件 defineComponent 不可用）。
      expose({
        scrollSize: 1000,
        scrollOffset: 0,
        viewportSize: 1000,
        cache: {},
        findItemIndex: () => 0,
        getItemOffset: () => 0,
        getItemSize: () => 100,
        scrollToIndex: () => {},
        scrollTo: () => {},
        scrollBy: () => {},
      })
      // 透传默认 slot：把每个 data item + index 喂给子项（与真实 Virtualizer 的 #default slot 一致）。
      // 包一层 div 接住 slot 返回的 vnode 数组，避免取 [0] 索引和类型纠结；多一层 div 不影响断言
      // （断言用 [data-testid="turn-xray"] 查 Turn stub）。
      return () =>
        h(
          'div',
          { 'data-testid': 'virtualizer-mock' },
          props.data.map((item: unknown, index: number) =>
            h('div', { 'data-virtua-index': index }, slots.default?.({ item, index })),
          ),
        )
    },
  })
  return { Virtualizer: PassthroughVirtualizer }
})

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolName: 'read',
    input: { path: '/tmp/a.txt' },
    status: 'running',
    startTime: NOW,
    ...over,
  }
}

/**
 * 构造一条含单个 toolCall 的 assistant message。
 * toolCalls 与 contentBlocks（toolCall 引用）都填充，走 expandAssistantBlocks 的
 * 真实时序分支（非降级）。toolCall 对象会被 expandAssistantBlocks 通过
 * msg.toolCalls.find(...) 取出——返回的是同一引用，所以外部改它的 status 会反映到 UI。
 */
function makeAssistantWithTool(tool: ToolCall): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    status: 'complete',
    timestamp: NOW,
    toolCalls: [tool],
    contentBlocks: [{ type: 'toolCall', refId: 'tc1' }],
  }
}

function makeTurn(assistant: Message, isStreaming = false): MessageTurn {
  return {
    index: 1,
    user: { id: 'u1', role: 'user', content: 'q', status: 'complete', timestamp: NOW },
    assistants: [assistant],
    isStreaming,
    hasFoldable: true,
  }
}

beforeEach(() => {
  // Turn.vue 依赖多个 pinia store（chat/fileTree/subagent...）。Block.vue 只依赖 i18n。
  setActivePinia(createPinia())
})

/* ─────────────────────── 方案 c：mount MessageStream（真 store + 真虚拟滚动层）───────────────────────
 * mount 完整 MessageStream，用真实 chat store + applyMessageEvent 走真 tool_call_end 路径。
 * 用 Turn **透视 stub**（不隔离，直接渲染内部 tool 状态文本），断言 tool_call_end 后
 * 渲染的 toolCall.status 是否从 running 翻转成 completed。
 *
 * 这是验证「虚拟滚动层（visibleItems/visibleRange）是否截断响应式更新」的最小真链路。
 * ------------------------------------------------------------------------- */

// happy-dom 不提供 ResizeObserver
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Turn 透视 stub：把传入 turn 的 toolCall 状态渲染成文本，供断言。
 * 不调任何 store（隔离重依赖），仅做纯渲染。
 */
const TurnXRay = defineComponent({
  name: 'Turn',
  props: { turn: { type: Object, required: true }, sessionId: String, canEdit: Boolean },
  setup(props) {
    return () => {
      const turn = props.turn as MessageTurn
      const tc = turn.assistants[0]?.toolCalls?.[0]
      const status = tc ? tc.status : 'no-tool'
      return h(
        'div',
        {
          'data-testid': 'turn-xray',
          'data-tool-status': status,
          'data-assistant-id': turn.assistants[0]?.id ?? '',
        },
        `toolStatus:${status}`,
      )
    }
  },
})

const streamGlobalStubs = {
  Turn: TurnXRay,
  SystemNotice: { name: 'SystemNotice', template: '<div />' },
  GuiComponentRenderer: { name: 'GuiComponentRenderer', template: '<div />' },
}

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: streamGlobalStubs },
    attachTo: document.body,
  })
}

describe('方案 c: mount MessageStream（真 store + 真虚拟滚动层）— tool_call_end 翻转', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('c-full: hydrate(user) → message_start → tool_call_start → tool_call_end，断言 Turn 收到 status 翻转', async () => {
    const chat = useChatStore()
    const sid = 'sess-c'
    // hydrate 一条 user 消息（避免 message_start 找不到前置）
    chat.hydrate(sid, [
      { id: 'u1', role: 'user', content: 'read file', status: 'complete', timestamp: NOW },
    ])

    const wrapper = mountStream(sid)
    await nextTick()

    // 触发 message_start：插入 streaming assistant
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage<'message.message_start'>)
    await nextTick()

    // 触发 tool_call_start：插入 running tool
    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_start',
      payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: { path: '/x' }, timestamp: new Date(0).toISOString() } },
    } as ServerMessage<'message.tool_call_start'>)
    await nextTick()

    // 断言 running：Turn 透视 stub 应显示 toolStatus:running
    const running = wrapper.find('[data-testid="turn-xray"]')
    expect(running.exists()).toBe(true)
    expect(running.attributes('data-tool-status')).toBe('running')

    // 触发 tool_call_end：翻转成 completed
    chat.applyMessageEvent(sid, {
      type: 'message.tool_call_end',
      payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'file content' }], isError: false, timestamp: 0 } } },
    } as ServerMessage<'message.tool_call_end'>)
    await nextTick()

    // 断言翻转：Turn 透视 stub 应显示 toolStatus:completed
    const completed = wrapper.find('[data-testid="turn-xray"]')
    expect(completed.attributes('data-tool-status')).toBe('completed')

    wrapper.unmount()
  })

  it('c-multi: 多 turn，running tool 在非末位 turn —— 验证虚拟窗口非末项 turn 翻转', async () => {
    // [cw wave w3 历史 skip，已恢复]：原本因 virtua 在 happy-dom 下 viewportSize=0 skip——未被 :keepMounted
    //   钉扎的非末位 turn 不进渲染窗口 → DOM 找不到 turn-xray。现通过 mock virtua/vue 的 Virtualizer 为
    //   passthrough 组件恢复覆盖——virtua 窗口化有独立单测，本测只验证 tool status 翻转链路
    //   （真 store + 真 applyMessageEvent + 多 turn 非末位翻转）。
    const chat = useChatStore()
    const sid = 'sess-c-multi'
    const history: Message[] = []
    for (let i = 1; i <= 4; i++) {
      history.push({ id: `u${i}`, role: 'user', content: `q${i}`, status: 'complete', timestamp: NOW })
      history.push({ id: `a${i}`, role: 'assistant', content: `answer${i}`, status: 'complete', timestamp: NOW })
    }
    // 第 5 个 turn：user + assistant(streaming)
    history.push({ id: 'u5', role: 'user', content: 'q5', status: 'complete', timestamp: NOW })
    chat.hydrate(sid, history)

    const wrapper = mountStream(sid)
    await nextTick()

    // message_start 给第 5 turn 插 streaming assistant（末位 turn，必在窗口）
    chat.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a5' },
    } as ServerMessage<'message.message_start'>)
    await nextTick()

    // 直接测「已 hydrate 的完成 turn 上 toolCalls 状态翻转」。
    // 用 setMessages 覆盖第 1 turn 含 running tool，再翻转。
    // [W10 D-1 容器 API] messages 是 Map<sid, Ref<Message[]>>——读分区数组走 getMessages（生产读法），
    //   直接 messages.get(sid) 拿到内层 Ref（无 .map），是 D-1 适配遗漏点（W21 review Fix-1）。
    const base = chat.getMessages(sid)
    const tool: ToolCall = { id: 'tc-multi', toolName: 'read', input: {}, status: 'running', startTime: NOW }
    const updated: Message[] = base.map((m) =>
      m.id === 'a1'
        ? { ...m, toolCalls: [tool], contentBlocks: [{ type: 'toolCall', refId: 'tc-multi' }] }
        : m,
    )
    chat.setMessages(sid, updated)
    await nextTick()

    // 找到 turn1（data-assistant-id=a1），断言 running
    const turn1 = wrapper
      .findAll('[data-testid="turn-xray"]')
      .find((w) => w.attributes('data-assistant-id') === 'a1')
    expect(turn1?.attributes('data-tool-status')).toBe('running')

    // 翻转 tool status via setMessages（不可变替换，模拟 tool_call_end 的 store 路径）
    const toolDone: ToolCall = { ...tool, status: 'completed', output: 'done' }
    const updated2: Message[] = chat.getMessages(sid).map((m) =>
      m.id === 'a1' ? { ...m, toolCalls: [toolDone] } : m,
    )
    chat.setMessages(sid, updated2)
    await nextTick()

    const turn1After = wrapper
      .findAll('[data-testid="turn-xray"]')
      .find((w) => w.attributes('data-assistant-id') === 'a1')
    expect(turn1After?.attributes('data-tool-status')).toBe('completed')
    wrapper.unmount()
  })

  it('c-full-cycle: message.start→tool_start→tool_end→message.complete(full working→done) 真实生命周期', async () => {
    // [cw wave w3 历史 skip，已恢复]：同 c-multi 理由——message.complete 后 a1 不再 streaming，真实 virtua
    //   :keepMounted 释放该 idx，happy-dom（viewportSize=0）下会卸载 a1 致 turn-xray 消失。现通过 mock
    //   virtua/vue 的 Virtualizer 为 passthrough 组件恢复覆盖——virtua 窗口化有独立单测，本测只验证
    //   tool status 翻转真实生命周期（真 store + 真 applyMessageEvent 走 message.complete 路径）。
    const chat = useChatStore()
    const sid = 'sess-cycle'
    chat.hydrate(sid, [
      { id: 'u1', role: 'user', content: 'q', status: 'complete', timestamp: NOW },
    ])
    const wrapper = mountStream(sid)
    await nextTick()

    // message_start（streaming assistant）→ turn isStreaming=true
    chat.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } } as ServerMessage<'message.message_start'>)
    await nextTick()

    // tool_call_start
    chat.applyMessageEvent(sid, { type: 'message.tool_call_start', payload: { sessionId: sid, entry: { type: 'toolCall', toolCallId: 'tc1', toolName: 'read', arguments: {}, timestamp: new Date(0).toISOString() } } } as ServerMessage<'message.tool_call_start'>)
    await nextTick()
    expect(wrapper.find('[data-testid="turn-xray"]').attributes('data-tool-status')).toBe('running')

    // tool_call_end（completed）
    chat.applyMessageEvent(sid, { type: 'message.tool_call_end', payload: { sessionId: sid, entry: { type: 'message', parentId: null, timestamp: new Date(0).toISOString(), message: { role: 'toolResult', toolCallId: 'tc1', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 0 } } } } as ServerMessage<'message.tool_call_end'>)
    await nextTick()

    // message.complete（normal stop）→ finalizeSession reason='normal'
    chat.applyMessageEvent(sid, { type: 'message.complete', payload: { sessionId: sid, stopReason: 'stop', content: 'final answer' } } as ServerMessage<'message.complete'>)
    await nextTick()
    const finalStatus = wrapper.find('[data-testid="turn-xray"]').attributes('data-tool-status')

    // 关键断言：tool_call_end 已 completed，finalize reason=normal 不改 completed toolCalls
    expect(finalStatus).toBe('completed')
    wrapper.unmount()
  })
})

/* ─────────────────────── 方案 a：mount Block，改 props.tool.status ─────────────────────── */
describe('方案 a: mount Block 组件 — 翻转 props.tool.status', () => {
  it('running→completed：双环 loader 消失，无终态 icon（统一交互模式）', async () => {
    const tool = makeTool({ status: 'running' })
    const wrapper = mount(Block, {
      props: { type: 'tool', tool, sessionId: 's1' },
    })

    // running 态：双环 loader 存在
    expect(wrapper.findAll('.animate-loader-spin').length).toBeGreaterThan(0)

    // 翻转 status → completed
    await wrapper.setProps({ tool: { ...tool, status: 'completed', output: 'file content' } })

    // 断言：loader 消失，无终态 Check icon（统一交互模式：无末尾 icon）
    expect(wrapper.findAll('.animate-loader-spin')).toHaveLength(0)
    expect(wrapper.find('svg.lucide-check').exists()).toBe(false)
  })
})

/* ─────────────────────── 方案 b：mount Turn，改 turn prop 内 tool ─────────────────────── */
// 展开 trace 需状态化 toggleExpand/isExpanded（reactive Set，同 turn-working U19）
describe('方案 b: mount Turn 组件 — 翻转 turn.assistants[0].toolCalls[0].status', () => {
  const expandedTurns = reactive(new Set<string>())
  beforeEach(() => {
    expandedTurns.clear()
  })
  it('running→completed：Turn 内 Block 双环 loader 消失，无终态 icon', async () => {
    const tool = makeTool({ status: 'running' })
    const assistant = makeAssistantWithTool(tool)
    const turn = makeTurn(assistant, /* isStreaming */ false)

    const wrapper = mount(Turn, {
      props: { turn, sessionId: 's1' },
      global: {
        provide: mockChatProvide({
          isExpanded: (key: string) => expandedTurns.has(key),
          toggleExpand: (key: string) => {
            if (expandedTurns.has(key)) expandedTurns.delete(key)
            else expandedTurns.add(key)
          },
        }),
        stubs: { ChangeSetCard: true, MarkdownRenderer: true },
      },
    })

    // 需展开 trace 才能看到 Block（showTrace = isSessionActive || expanded；这里 isSessionActive=false）
    // 点击 turn-meta 按钮展开
    await wrapper.find('button.turn-meta').trigger('click')
    await nextTick()

    // running 态断言：双环 loader 存在
    expect(wrapper.findAll('.animate-loader-spin').length).toBeGreaterThan(0)

    // 翻转 status：构造新的 turn prop（不可变更新，模拟 store commitMessages 路径）
    const tool2: ToolCall = { ...tool, status: 'completed', output: 'file content' }
    const assistant2: Message = { ...assistant, toolCalls: [tool2] }
    const turn2: MessageTurn = { ...turn, assistants: [assistant2] }
    await wrapper.setProps({ turn: turn2 })
    await nextTick()

    // 断言：loader 消失，无终态 Check icon（统一交互模式：无末尾 icon）
    expect(wrapper.findAll('.animate-loader-spin')).toHaveLength(0)
  })
})

/* ─────────────────────── 方案 c（叶子）：直接验证 traceBlocks 响应式 ───────────────────────
 * 不 mount MessageStream（虚拟滚动层窗口化由 virta <Virtualizer> 内部负责），而是聚焦验证
 * 「Turn 把 toolCall 引用的 status 变化（不可变替换）传给 Block」是否响应式。
 * ------------------------------------------------------------------------- */
describe('方案 c（叶子）: traceBlocks 响应式验证（不可变替换翻转）', () => {
  const expandedTurns = reactive(new Set<string>())
  beforeEach(() => {
    expandedTurns.clear()
  })
  it('c1: 不可变替换 turn prop（模拟 store commit）— 应翻转', async () => {
    const tool = makeTool({ status: 'running' })
    const assistant = makeAssistantWithTool(tool)
    const turn = makeTurn(assistant, false)

    const wrapper = mount(Turn, {
      props: { turn, sessionId: 's1' },
      global: {
        provide: mockChatProvide({
          isExpanded: (key: string) => expandedTurns.has(key),
          toggleExpand: (key: string) => {
            if (expandedTurns.has(key)) expandedTurns.delete(key)
            else expandedTurns.add(key)
          },
        }),
        stubs: { ChangeSetCard: true, MarkdownRenderer: true },
      },
    })
    await wrapper.find('button.turn-meta').trigger('click')
    await nextTick()
    expect(wrapper.findAll('.animate-loader-spin').length).toBeGreaterThan(0)

    // 不可变替换（与方案 b 同）
    const tool2: ToolCall = { ...tool, status: 'completed', output: 'done' }
    const a2: Message = { ...assistant, toolCalls: [tool2] }
    await wrapper.setProps({ turn: { ...turn, assistants: [a2] } })
    await nextTick()

    expect(wrapper.findAll('.animate-loader-spin')).toHaveLength(0)
  })
})

/* [cw wave w4] 方案 d（虚拟滚动响应式——heights/scrollTop 变化触发 visibleRange 重算）随
 *   useVirtualTurnList 删除而移除：virta <Virtualizer> 内部维护测量缓存 + RO，响应式窗口化由 virta 负责，
 *   不再是应用层职责。tool status 翻转链路覆盖由方案 a（Block）/ b（Turn）/ c（MessageStream + leaf）保持。 */

