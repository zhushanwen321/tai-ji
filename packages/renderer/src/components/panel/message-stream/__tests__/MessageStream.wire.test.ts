/**
 * MessageStream 接线 + 渲染错误边界 单文件合并（round5-d 分区 4 簇 4-17）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——两文件同 SUT（MessageStream.vue）、
 * 同壳 mock helper（message-stream-shell-mock 注册 useChatViewDeps/useChat/useSidebar），
 * 单文件共享一份全树装载。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - MessageStream.wire.test.ts（w4 接线层 + TurnRail + rail 事件路由，主体）
 *  - MessageStream.render-error.test.ts（RD-2#1 单条渲染项错误边界 + buildStreamViewItems）
 *
 * 冲突处理（试点模式）：
 *  - render-error 的 vi.mock('virtua/vue')（全量渲染 stub）提升为文件级——主体
 *    TC-w4-9 的断言对象是 TurnRail/rail-node（rail 侧栏，不在 Virtualizer 内），
 *    不依赖 virtua 真实布局，mock 无断言影响
 *  - render-error describe 节内 beforeEach 的 ResizeObserver stub /
 *    HTMLElement.prototype.scrollTo patch 对主体节无断言影响（原真实 virtua 路径
 *    在 wire 节仅依赖 rail 断言）
 *  - MessageStream / MessageTurn 双 import specifier 去重：MessageTurn 两来源
 *    （@/composables/logic/messageTurns 与 @taiji/core/domain/chat）经核实为同一
 *    re-export，统一取 core 源
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=chat npx vitest run src/components/panel/message-stream/__tests__/MessageStream.wire.test.ts（本文件登记在 domain-map.json chat 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// [w6] 壳 mock 三连（useChatViewDeps/useChat/useSidebar）由 message-stream-shell-mount 导入即
// 注册；useChat mock 含 loadMoreHistory/hasMoreHistory（useLoadMoreHistory 挂载即读）；
// 置于组件 import 之前，注册早于 MessageStream.vue 导入链加载
import '@/__tests__/helpers/message-stream-shell-mount'
import { mount } from '@vue/test-utils'
// [w6 chat-ui-and-shell T7] ui 包组件：Turn/TurnRail 迁 ui；Turn 展开态经 deps inject（真实 useTurnExpansion 在 renderer 壳 useChatViewDeps）
import { computed, nextTick, ref, shallowRef, defineComponent, h, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { VirtualizerHandle } from 'virtua/vue'
import { Turn, TurnRail } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import MessageStream from '../../MessageStream.vue'
import { useMessageStreamRail } from '@/composables/panel/useMessageStreamRail'
import { createMockVlist } from '@/__tests__/effects/_virtua-mock-helper'
import { useTurnExpansionStore } from '@/stores/turn-expansion'
import { useChatStore } from '@/stores/chat'
import { buildStreamViewItems } from '@/components/panel/message-stream/stream-view-items'
import type { SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { RenderItem } from '@/composables/logic/messageTurns'
import type { Message, ThinkingBlock, ToolCall } from '@taiji/shared'

/** 构造 toolCall（status 可指定，默认 completed） */
function makeToolCall(id: string, status: ToolCall['status'] = 'completed'): ToolCall {
  return { id, toolName: 'grep', input: { command: 'foo' }, status, startTime: 0 } as ToolCall
}

/** 构造带 contentBlocks 的 assistant message（连续同类块场景）。 */
function assistantWithBlocks(opts: {
  id?: string
  content?: string
  status?: Message['status']
  thinking?: ThinkingBlock[]
  toolCalls?: ToolCall[]
  contentBlocks?: Message['contentBlocks']
}): Message {
  return {
    id: opts.id ?? 'a1',
    role: 'assistant',
    content: opts.content ?? 'done',
    status: opts.status ?? 'complete',
    timestamp: Date.now(),
    thinking: opts.thinking,
    toolCalls: opts.toolCalls,
    contentBlocks: opts.contentBlocks,
  } as Message
}

/** 构造 MessageTurn：complete 态 + hasFoldable=true（让 turn-meta 可点击展开）。
 *  [M5 stable-key] user.id 随 index 派生（u1/u2/...）——稳定 key（turnStableId）在测试里
 *  必须随 turn 不同而不同，展开态隔离断言才成立（旧实现只改 index 不换 id，
 *  string key 下两个 turn 会撞同一个 key）。
 *  [block-rendering M0] 默认 assistant 含 thinking 块（trace 容器恒渲染后，折叠/展开以内容显隐表达，
 *  需要可折叠内容才能断言「内容隐藏」语义）。 */
function makeTurn(over: Partial<MessageTurn> = {}): MessageTurn {
  const index = over.index ?? 1
  return {
    index,
    user: { id: `u${index}`, role: 'user', content: 'hi', status: 'complete', timestamp: Date.now() } as Message,
    assistants: [
      assistantWithBlocks({
        status: 'complete',
        thinking: [{ id: 'th1', content: 'thinking', collapsed: true }],
        contentBlocks: [
          { type: 'thinking', refId: 'th1' },
          { type: 'text', refId: 'text' },
        ],
      }),
    ],
    isStreaming: false,
    hasFoldable: true,
    ...over,
  } as MessageTurn
}

/** [w6] ui Turn 展开态经 deps 注入：stateful mock（reactive Set）驱动展开/收起契约
 *  （真实 useTurnExpansion 逻辑在 renderer 壳 useChatViewDeps 内，组件层只经 isExpanded/toggleExpand
 *  消费；[chat-flow-consistency C3] deps.collapse 已随 onComplete 接线退役删除）。
 *  [M5 stable-key] key 为 turnStableId(turn)（string，首条消息 id），非 turn.index。 */
const expandedTurns = reactive(new Set<string>())
function statefulExpandDeps() {
  return {
    isExpanded: (key: string) => expandedTurns.has(key),
    toggleExpand: (key: string) => {
      if (expandedTurns.has(key)) expandedTurns.delete(key)
      else expandedTurns.add(key)
    },
  }
}

/** mount Turn，stub 掉子组件（Block/ChangeSetCard/MarkdownRenderer），隔离 Turn 自身接线逻辑。 */
function mountTurn(props: { turn: MessageTurn; sessionId?: string; isSessionActive?: boolean }) {
  return mount(Turn, {
    props: {
      turn: props.turn,
      sessionId: props.sessionId ?? 's1',
      ...(props.isSessionActive !== undefined ? { isSessionActive: props.isSessionActive } : {}),
    },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide(statefulExpandDeps()),
      stubs: { Block: true, ChangeSetCard: true, MarkdownRenderer: true },
    },
  })
}

/** mount Turn 但用真实 Block（验 merged 卡片 / trace 块渲染）。 */
function mountTurnWithRealBlock(props: { turn: MessageTurn; sessionId?: string }) {
  return mount(Turn, {
    props: { turn: props.turn, sessionId: props.sessionId ?? 's1' },
    global: {
      plugins: [createPinia()],
      provide: mockChatProvide(statefulExpandDeps()),
      stubs: { ChangeSetCard: true, MarkdownRenderer: true },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  expandedTurns.clear()
})

/* ──────────────────────────────────────────────────────────────
 * TC-w4-1/2/7/8：Turn.vue 接入 useTurnExpansion（真实 composable，端到端）
 * ────────────────────────────────────────────────────────────── */
describe('Turn.vue 接线 useTurnExpansion（w1）', () => {
  it('TC-w4-1: complete 态默认折叠（showTrace=false），点 turn-meta → 展开 trace（isExpanded 驱动）', async () => {
    const wrapper = mountTurn({ turn: makeTurn() })
    // [block-rendering M0] trace 容器恒渲染（v-if 下沉 Block 级）：折叠态内容隐藏——仅 text 恒渲染，
    // thinking/tool 不渲染（原「容器不存在」断言改「内容隐藏」语义）
    expect(wrapper.find('.trace').exists()).toBe(true)
    expect(wrapper.findAllComponents({ name: 'Block' }).length).toBe(1)
    // chevron 未 rotate-90（折叠态）
    expect(wrapper.find('.chev').classes()).not.toContain('rotate-90')
    // 点击 turn-meta → useTurnExpansion.toggle → isExpanded=true → showTrace=true → thinking 块渲染
    await wrapper.find('.turn-meta').trigger('click')
    expect(wrapper.find('.trace').exists()).toBe(true)
    expect(wrapper.findAllComponents({ name: 'Block' }).length).toBe(2)
    // chevron rotate-90（展开态）
    expect(wrapper.find('.chev').classes()).toContain('rotate-90')
  })

  it('TC-w4-2 [C3 退役]: 会话结束降沿不清手动展开态（onComplete collapse 已退役，收起纯派生）', async () => {
    // [chat-flow-consistency C3] 旧契约（isSessionActive true→false 触发 onComplete →
    // deps.collapse 清手动展开）已退役：工作回合的收起由派生完成（isWorkingTurn 翻 false →
    // showTrace = isExpanded），显式 collapse 的唯一净效果是清挂载回合的手动展开态（有害无益）。
    // 新契约（design-stream-presentation C3 验收断言）：手动展开的回合在会话结束降沿保持展开。
    // 预置 expandedTurns（makeTurn() 默认稳定 key 'u1'）后降沿——展开必须原样保留。
    expandedTurns.add('u1')
    const wrapper = mount(Turn, {
      props: {
        turn: makeTurn({ isStreaming: false }),
        sessionId: 'sess-w4-2',
        isSessionActive: true,
      },
      global: {
        plugins: [createPinia()],
        provide: mockChatProvide(statefulExpandDeps()),
        stubs: { Block: true, ChangeSetCard: true, MarkdownRenderer: true },
      },
    })
    // sessionActive=true → showTrace = true || true = true（thinking+text 都渲染）
    expect(wrapper.find('.trace').exists()).toBe(true)
    expect(wrapper.findAllComponents({ name: 'Block' }).length).toBe(2)
    // 对话结束：isSessionActive true→false——不再有 onComplete collapse；手动展开保持
    expect(wrapper.find('.trace').exists()).toBe(true)
    await wrapper.setProps({ isSessionActive: false })
    // 手动展开态保持：isExpanded('u1') 仍 true → showTrace 仍 true（thinking 可回看）
    expect(wrapper.findAllComponents({ name: 'Block' }).length).toBe(2)
    expect(expandedTurns.has('u1')).toBe(true)
  })

  it('TC-w4-7: 展开态隔离 —— 两个 Turn（不同稳定 key）展开互不影响', async () => {
    // [w6] 展开态经 deps 注入（stateful mock 按稳定 key 分区）；真实 per-session 隔离在
    // renderer 壳 useChatViewDeps（useTurnExpansion(sessionId)）。组件层契约：不同 turn 稳定 key 独立。
    const turnA = makeTurn({ index: 1 })
    const turnB = makeTurn({ index: 2 })
    const wrapperA = mountTurn({ turn: turnA, sessionId: 'sessA' })
    const wrapperB = mountTurn({ turn: turnB, sessionId: 'sessB' })
    // [block-rendering M0] 初始都折叠：trace 容器恒渲染，内容隐藏（仅 text，thinking 不渲染）
    expect(wrapperA.find('.trace').exists()).toBe(true)
    expect(wrapperA.findAllComponents({ name: 'Block' }).length).toBe(1)
    expect(wrapperB.find('.trace').exists()).toBe(true)
    expect(wrapperB.findAllComponents({ name: 'Block' }).length).toBe(1)
    // 展开 A
    await wrapperA.find('.turn-meta').trigger('click')
    expect(wrapperA.find('.trace').exists()).toBe(true)
    expect(wrapperA.findAllComponents({ name: 'Block' }).length).toBe(2)
    // B 仍折叠（不同稳定 key，展开态隔离）
    expect(wrapperB.find('.trace').exists()).toBe(true)
    expect(wrapperB.findAllComponents({ name: 'Block' }).length).toBe(1)
  })

  it('TC-w4-8: 连续同类 tool 调用 → 聚进同一 run 分组容器（组内逐行独立），末位 text 独立块', async () => {
    // 构造 3 个连续 toolCall（同类型 grep ∈ explore 分组名单，非失败）
    // [3646d9d91 run 类型分组] 断言跟随分组语义：连续同类 tool 聚成 1 个 run-group 容器
    // （成员行不误合并、text 不被吞的锁定意图不变；旧断言「4 个独立 .trace-blk」对应
    // 分组功能引入前的逐块渲染形态）
    const tc1 = makeToolCall('tc1')
    const tc2 = makeToolCall('tc2')
    const tc3 = makeToolCall('tc3')
    const turn = makeTurn({
      assistants: [
        assistantWithBlocks({
          status: 'complete',
          content: 'all done',
          toolCalls: [tc1, tc2, tc3],
          contentBlocks: [
            { type: 'toolCall', refId: 'tc1' },
            { type: 'toolCall', refId: 'tc2' },
            { type: 'toolCall', refId: 'tc3' },
            { type: 'text', refId: 'text' },
          ],
        }),
      ],
    })
    const wrapper = mountTurnWithRealBlock({ turn })
    // 展开 trace（complete 态需手动展开）
    await wrapper.find('.turn-meta').trigger('click')
    expect(wrapper.find('.trace').exists()).toBe(true)
    // 不存在 merged 卡片（合并功能已移除；现行聚合形态 = run 分组容器，非 merged 卡）
    expect(wrapper.findAll('[data-testid="merged-block-card"]')).toHaveLength(0)
    // 顶层 = 1 个 run 分组容器（真实 Block 根无 data-type，按现行约定以 .trace-run-group 断言）
    // + 末位 text 独立块
    const topBlocks = wrapper.findAll('.trace > .trace-blk')
    expect(topBlocks).toHaveLength(2)
    expect(topBlocks[0].find('.trace-run-group').exists()).toBe(true)
    // 末位 text 在 trace 内（不被分组吞掉）
    expect(topBlocks[1].findComponent({ name: 'MarkdownRenderer' }).exists()).toBe(true)
    // 组默认收起（全已完成无 running 成员）；点组头展开 → 3 个成员行各自独立渲染
    // [trace W3 去壳] 成员行直递 ToolRow（根 .trace-tool，无 .trace-blk 壳层），
    // block-tool-<id> testid 经 attribute fallthrough 落 ToolRow 根
    const group = topBlocks[0].find('[data-testid="run-group"]')
    expect(group.find('[data-testid="run-group-header"]').attributes('aria-expanded')).toBe('false')
    await group.find('[data-testid="run-group-header"]').trigger('click')
    const members = group.findAll('.trace-tool')
    expect(members).toHaveLength(3)
    expect(members[0].attributes('data-testid')).toBe('block-tool-tc1')
    expect(members[1].attributes('data-testid')).toBe('block-tool-tc2')
    expect(members[2].attributes('data-testid')).toBe('block-tool-tc3')
  })
})

/* ──────────────────────────────────────────────────────────────
 * TC-w4-3：TurnRail（w3）props 契约 smoke test（TurnRail props 契约：4 props + 2 emit）
 * TC-w4-3b/4/6：useMessageStreamRail composable 单元测试（验事件路由 → useTurnExpansion，rail 下标→turnStableId 稳定 key 映射）
 *
 * MessageStream.vue 整体 mount 的真接线性由 TC-w4-9（见文末 describe）覆盖：仅 mock useChat/
 * useSidebar（store 副作用隔离），用 chat store setMessages 注入消息让 railTurns 非空，
 * 断言 TurnRail 在 DOM 渲染 + jump/toggle emit 经 MessageStream 路由到 rail composable。
 * ────────────────────────────────────────────────────────────── */
describe('MessageStream rail 接线（TurnRail props 契约 + useMessageStreamRail 事件路由）', () => {
  /** 构造 3 个 turn 的 renderItems（rail 索引空间 = 3 turns） */
  function makeRenderItems(): RenderItem[] {
    return [
      { kind: 'turn', turn: makeTurn({ index: 1 }) },
      { kind: 'turn', turn: makeTurn({ index: 2 }) },
      { kind: 'turn', turn: makeTurn({ index: 3 }) },
    ]
  }

  /**
   * mount 一个 host 组件，setup 内调 useMessageStreamRail（composable 内 onMounted/onScopeDispose
   * 需 active component instance，用 host 组件包裹避免「no active effect scope」warning）。
   * 返回 rail composable 返回值 + host wrapper（unmount 触发 onScopeDispose 清理）。
   *
   * [cw wave w4] vlistRef 必填：默认注入 createMockVlist()，virtua 路径专用。
   */
  function mountRail(opts: {
    sessionId?: string
    renderItems?: RenderItem[]
    scrollEl?: HTMLElement | null
    vlistRef?: ReturnType<typeof shallowRef<VirtualizerHandle | null>>
  } = {}): { rail: ReturnType<typeof useMessageStreamRail>; wrapper: ReturnType<typeof mount> } {
    const sessionId = computed(() => opts.sessionId ?? 's-rail-test')
    const renderItemsRef = ref<RenderItem[]>(opts.renderItems ?? makeRenderItems())
    const scrollElRef = ref<HTMLElement | null>(opts.scrollEl ?? null)
    const vlistRef = opts.vlistRef ?? shallowRef<VirtualizerHandle | null>(createMockVlist())
    let rail!: ReturnType<typeof useMessageStreamRail>
    const Host = defineComponent({
      setup() {
        rail = useMessageStreamRail({
          sessionId,
          renderItems: renderItemsRef,
          scrollEl: scrollElRef,
          vlistRef,
        })
        return () => h('div')
      },
    })
    const wrapper = mount(Host, { global: { plugins: [createPinia()] } })
    return { rail, wrapper }
  }

  /** mount TurnRail smoke test（验 props 契约：MessageStream 传给 TurnRail 的 5 个 props + 4 个 emit） */
  it('TC-w4-3: TurnRail 接受 MessageStream 传入的 props 契约（turns/activeTurnIndex/sessionActive/expandedTurns）', () => {
    const turns = makeRenderItems().map((i) => (i.kind === 'turn' ? i.turn : null)).filter(Boolean) as MessageTurn[]
    const wrapper = mount(TurnRail, {
      props: {
        turns,
        activeTurnIndex: 1,
        sessionActive: false,
        expandedTurns: new Set(['u2']),
      },
    })
    expect(wrapper.find('[data-testid="turn-rail"]').exists()).toBe(true)
    // 验 rail 接受所有 props 不报错（MessageStream 传相同 shape）
    expect(wrapper.findAll('[data-testid="rail-node"]')).toHaveLength(3)
    // expandedTurns prop 透传（toggle 图标方向依据）
    expect(wrapper.props('expandedTurns')).toEqual(new Set(['u2']))
  })

  it('TC-w4-3b: useMessageStreamRail.expandedTurns 从 store 派生当前 session 已展开的 turn 稳定 key', () => {
    const { rail, wrapper } = mountRail()
    // 初始无展开 → 空 Set
    expect(rail.expandedTurns.value.size).toBe(0)
    // onToggle(0) 翻转 railTurns[0]（稳定 key 'u1'）→ store 记录 'u1' 展开
    rail.onToggle(0)
    expect(rail.expandedTurns.value.has('u1')).toBe(true)
    expect(rail.expandedTurns.value.size).toBe(1)
    // 再 onToggle(0) 翻回 → 'u1' 折叠，expandedTurns 不含 u1
    rail.onToggle(0)
    expect(rail.expandedTurns.value.has('u1')).toBe(false)
    wrapper.unmount()
  })

  it('TC-w4-4: onToggle(idx) → useTurnExpansion.toggle 翻转（rail 下标 → turnStableId 稳定 key 映射正确）', () => {
    // useMessageStreamRail 内部调 useTurnExpansion（per-instance Map）。
    // 验证 rail onToggle 下标映射 → turnStableId 稳定 key：railTurns[0] 稳定 key 'u1'（user.id=u1），
    // onToggle(0) 应调 toggle('u1')（M5 stable-key 后 Map key 是稳定 id 非数组 index；翻转 store 断言见 TC-w4-3b）。
    // 注：useTurnExpansion 是 per-instance（每次调用建自己的 Map），与 Turn.vue 内的调用不共享——
    //    这是 w1 既定设计（任务规范「直接 import 用，不重新实现」）。本测验证 rail handler 路由正确性。
    const { rail, wrapper } = mountRail()
    // railTurns 下标 → turnStableId 稳定 key 映射（这是 onToggle 的路由核心：idx → turnStableId(turn)）
    expect(rail.railTurns.value).toHaveLength(3)
    expect(rail.railTurns.value[0].index).toBe(1)
    expect(rail.railTurns.value[1].index).toBe(2)
    expect(rail.railTurns.value[2].index).toBe(3)
    // onToggle(0) 不抛错（railTurns[0] 存在，调 useTurnExpansion.toggle('u1')——稳定 key 路由）
    expect(() => rail.onToggle(0)).not.toThrow()
    // 边界：onToggle 越界不抛错（railTurns[99] 不存在 → turnIdx undefined → no-op）
    expect(() => rail.onToggle(99)).not.toThrow()
    wrapper.unmount()
  })

  // （TC-w4-6a/6b 已删：vlistRef null no-op 与 scrollToIndex 路由由
  //  use-message-stream-rail-virtua.test.ts 更全覆盖（:106/:173），此处原走默认 mock vlist。）
})

/* ──────────────────────────────────────────────────────────────
 * TC-w4-9：mount MessageStream.vue 首屏冒烟（验真接线）
 *
 * 反回归目标：若有人从 MessageStream.vue 模板删掉 <TurnRail> 标签、删掉 rail.onJump/onToggle
 * 绑定、或重命名 emit，本测直接失败（区别于上面 composable/props 契约测试——它们不 mount
 * MessageStream.vue，删 <TurnRail> 标签后仍全绿）。
 *
 * 真实 mount 可行性：MessageStream.vue 的重依赖（useChat/useSidebar）已 mock；
 * useChat mock 补 loadMoreHistory/hasMoreHistory（useLoadMoreHistory 经 useChat 读这俩）。
 * 用 chat store setMessages 注入消息让 renderItems/railTurns 非空，TurnRail v-if 命中渲染。
 * attachTo: document.body 让 scrollEl 真挂 DOM（virtua <Virtualizer> 需真实布局测量才能窗口化渲染；
 * 不 attach 的话 scrollEl 在 happy-dom 空间里 clientHeight=0，虚拟化窗口为空）。
 * ────────────────────────────────────────────────────────────── */
describe('MessageStream.vue 首屏冒烟（mount 真组件，验 TurnRail 接线）', () => {
  /** 构造 2 turn 的消息序列（user/assistant 交替）让 toRenderItems 产出 2 个 turn。 */
  function makeStreamMessages(): Message[] {
    return [
      { id: 'u1', role: 'user', content: 'first turn', status: 'complete', timestamp: 1 } as Message,
      { id: 'a1', role: 'assistant', content: 'first reply', status: 'complete', timestamp: 2 } as Message,
      { id: 'u2', role: 'user', content: 'second turn', status: 'complete', timestamp: 3 } as Message,
      { id: 'a2', role: 'assistant', content: 'second reply', status: 'complete', timestamp: 4 } as Message,
    ]
  }

  it('TC-w4-9: mount MessageStream 渲染 TurnRail（DOM 含 [data-testid=turn-rail] + rail-node）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chat = useChatStore()
    chat.setMessages('sess-mount', makeStreamMessages())

    const wrapper = mount(MessageStream, {
      props: { sessionId: 'sess-mount' },
      attachTo: document.body,
      global: { plugins: [pinia] },
    })
    // 等 watch(scrollEl) immediate 回调 + onScrollUpdate + computed 链路稳定
    await nextTick()
    await nextTick()

    // 真接线断言 1：MessageStream 模板里的 <TurnRail> 标签确实渲染到 DOM（v-if turns.length>0 命中）
    expect(wrapper.find('[data-testid="turn-rail"]').exists()).toBe(true)
    // 真接线断言 2：rail-node 数 = 消息里的 turn 数（2 turn）
    expect(wrapper.findAll('[data-testid="rail-node"]')).toHaveLength(2)

    wrapper.unmount()
  })

  it('TC-w4-9c: 根节点自挂 data-fs-scope=chat（对话流字号域单点挂点，chat-font-scope）——主面板/drawer subagent/btw/workflow agent 详情四处消费同款，抽屉内嵌对话流恒跟 chat 档', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)

    const wrapper = mount(MessageStream, {
      props: { sessionId: 'sess-fs-scope' },
      attachTo: document.body,
      global: { plugins: [pinia] },
    })
    await nextTick()

    // 观察者断言：流根元素自挂 chat 字号域属性。组件根为 fragment（dev 模式模板顶部
    // 注释节点参与根判定），wrapper.attributes() 读到的是挂载容器非流根，须经 DOM 查询
    // 断言真实流根——删除该属性即抽屉内对话流回落 drawer 档，此断言拦截。
    const scopeHost = wrapper.find('[data-fs-scope="chat"]')
    expect(scopeHost.exists()).toBe(true)
    expect(scopeHost.classes()).toContain('relative') // 命中的是流根 div（非容器误命中）

    wrapper.unmount()
  })

  it('TC-w4-9b: mount MessageStream 后 TurnRail emit jump/toggle 经模板 @jump/@toggle 路由（验 emit 接线）', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const chat = useChatStore()
    chat.setMessages('sess-mount-emit', makeStreamMessages())

    const wrapper = mount(MessageStream, {
      props: { sessionId: 'sess-mount-emit' },
      attachTo: document.body,
      global: { plugins: [pinia] },
    })
    await nextTick()
    await nextTick()

    // 找到 MessageStream 内部渲染的 TurnRail 子组件（真接线：MessageStream import + template 引用）
    const turnRail = wrapper.findComponent(TurnRail)
    expect(turnRail.exists()).toBe(true)

    // emit jump(0) → MessageStream 模板 @jump="onJump" 路由到 rail.onJump（不抛错即接线成立）
    turnRail.vm.$emit('jump', 0)
    await nextTick()
    // emit toggle(0) → MessageStream 模板 @toggle="onToggle" 路由到 rail.onToggle → useTurnExpansion.toggle('u1')
    //   railTurns[0] 稳定 key = 'u1'（首条 user 消息 id）→ store 分区记 'u1' 展开态
    turnRail.vm.$emit('toggle', 0)
    await nextTick()

    // 真接线断言：toggle 经 MessageStream 路由到 useTurnExpansion（store isExpanded('u1') 翻为 true）。
    // 若 MessageStream 模板删了 @toggle 绑定或 onToggle 改名，store 不变 → 此处 false，测试失败。
    const store = useTurnExpansionStore()
    expect(store.isExpanded('sess-mount-emit', 'u1')).toBe(true)

    wrapper.unmount()
  })
})


// ══════════ 来源：MessageStream.render-error.test.ts（渲染错误边界；其
//             vi.mock('virtua/vue') 与 NoopResizeObserver/PoisonTurnStub 等 helper
//             原样保留，节内 beforeEach 管辖本节） ══════════

// ── virtua mock：Virtualizer → 全量渲染 scoped slot 的 stub（同 MessageStream-kind）──────
const slotKeyCollector = vi.hoisted(() => ({ keys: [] as (string | number | symbol | null | undefined)[][] }))

vi.mock('virtua/vue', async () => {
  const { defineComponent } = await import('vue')
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        keepMounted: { type: Array, default: () => [] },
        scrollRef: { type: Object, default: null },
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
        const data = ctx.data as unknown[]
        const indexes = new Set<number>((ctx.keepMounted as number[]) ?? [])
        for (let i = 0; i < data.length; i += 1) indexes.add(i)
        return h(
          'div',
          { class: 'mock-virtualizer' },
          [...indexes].flatMap((idx) => {
            const slot = ctx.$slots.default as ((p: unknown) => unknown[]) | undefined
            const vnodes = slot?.({ item: data[idx], index: idx }) ?? []
            slotKeyCollector.keys.push((vnodes as Array<{ key?: string | null }>).map((v) => v.key))
            return vnodes as never[]
          }),
        )
      },
    }),
  }
})

// happy-dom 不提供真实 ResizeObserver 布局测量
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Turn stub：turn.user.content 命中 POISON 且毒开关开 → render 抛错（注入坏渲染项） */
const poison = reactive({ on: true })
const PoisonTurnStub = defineComponent({
  name: 'Turn',
  props: { turn: { type: Object, required: true } },
  setup(props) {
    const userContent = computed(() => {
      const t = props.turn as { user?: { content?: string } }
      return t.user?.content
    })
    return () => {
      if (poison.on && userContent.value === 'POISON') {
        throw new Error('render boom: poisoned turn')
      }
      return h('div', { 'data-testid': `turn-stub-${(props.turn as { index?: number }).index}` })
    }
  },
})

const globalStubs = {
  Turn: PoisonTurnStub,
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div data-testid="bash-output-stub" />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
}

function makeMsg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    status: 'complete',
    timestamp: Date.now(),
    ...over,
  } as Message
}

function mountStream(sessionId: string, onError?: (err: unknown) => void) {
  return mount(MessageStream, {
    props: { sessionId },
    global: {
      stubs: globalStubs,
      // errorHandler 收集器：断言边界把错误拦在组件级（return false 不升级到全局）
      ...(onError ? { config: { errorHandler: onError } } : {}),
    },
    attachTo: document.body,
  })
}

describe('MessageStream — 单条渲染项错误边界（RD-2#1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    poison.on = true
    slotKeyCollector.keys.length = 0
  })

  it('注入 render 抛错的 item：占位行出现、其余 item 正常渲染、全局 errorHandler 零调用', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-rd21', [
      makeMsg({ id: 'u1', content: 'normal question' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'normal answer' }),
      makeMsg({ id: 'u2', content: 'POISON' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'poisoned answer' }),
    ])
    const globalErrors: unknown[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = mountStream('sess-rd21', (e) => { globalErrors.push(e) })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 坏 item → 边界占位行；好 item → 正常渲染
    expect(wrapper.find('[data-testid="stream-item-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="turn-stub-1"]').exists()).toBe(true)
    // 错误被边界拦截：不升级全局（RD-2#1 验收核心断言）
    expect(globalErrors).toHaveLength(0)
    expect(errSpy).toHaveBeenCalled()
    // 稳定 key 挂在分支根 vnode（renderKey = t-<首条消息 id> 空间不变，M5 回归锚）。
    // mock 每次 slot 调用收集一组（每项恰 1 个边界 vnode），flat 后逐项断言。
    const allKeys = slotKeyCollector.keys.flat()
    expect(allKeys).toContain('t-u1')
    expect(allKeys).toContain('t-u2')
    wrapper.unmount()
    errSpy.mockRestore()
  })

  it('修复数据后点重试：占位行消失、该 item 恢复渲染（slot 重挂载）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-rd21-retry', [
      makeMsg({ id: 'u1', content: 'POISON' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'poisoned answer' }),
    ])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = mountStream('sess-rd21-retry')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="stream-item-error"]').exists()).toBe(true)

    // 数据修复（坏渲染原因消除）→ 点重试 → slot 重挂载恢复渲染
    poison.on = false
    await wrapper.find('[data-testid="stream-item-error-retry"]').trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="stream-item-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="turn-stub-1"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('buildStreamViewItems — slot 表达式前置求值（RD-2#1 第一道防线）', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function turnFixture(over: Partial<MessageTurn>): MessageTurn {
    return {
      index: 0,
      user: { id: 'u1', role: 'user', content: 'hi', status: 'complete', timestamp: 0 } as Message,
      assistants: [],
      isStreaming: false,
      ...over,
    } as MessageTurn
  }

  it('正常项：key/canEdit/isLastTurn/preview 前置算好（canEdit 只落最后 user turn）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = [
      { kind: 'turn', turn: turnFixture({ index: 0, user: { id: 'u1', role: 'user', content: 'first', status: 'complete', timestamp: 0 } as Message }) },
      { kind: 'turn', turn: turnFixture({ index: 1, user: { id: 'u2', role: 'user', content: 'last', status: 'complete', timestamp: 0 } as Message }) },
    ] as unknown as SkillNoticeStreamItem[]
    const views = buildStreamViewItems(items, 1, items[1]!.turn as MessageTurn)
    expect(views.map((v) => v.key)).toEqual(['t-u1', 't-u2'])
    expect(views[0]).toMatchObject({ kind: 'turn', canEdit: false, isLastTurn: false })
    expect(views[1]).toMatchObject({ kind: 'turn', canEdit: true, isLastTurn: true, preview: 'last' })
  })

  it('单项求值抛错（turn 缺失）→ broken 占位项（1:1 不删位），不炸整个列表构建', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = [
      { kind: 'turn', turn: undefined } as unknown as SkillNoticeStreamItem,
      { kind: 'turn', turn: turnFixture({}) } as unknown as SkillNoticeStreamItem,
    ]
    const views = buildStreamViewItems(items, 0, null)
    expect(views).toHaveLength(2)
    expect(views[0]).toMatchObject({ kind: 'broken', key: 'broken-0' })
    expect(views[1]).toMatchObject({ kind: 'turn', key: 't-u1' })
  })
})
