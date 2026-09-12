/**
 * MessageStream kind 查表分发测试（renderer-model 归一 M1 TC2）。
 *
 * 验证：RenderItem.kind 全集（turn/systemNotice/bashExecution）在 MessageStream 模板
 * 按 kind → 组件纯查表分发（conversation-renderer-model-unification §3.3.1）：
 * - kind==='turn'          → Turn
 * - kind==='bashExecution' → BashOutputBlock
 * - 其余（systemNotice）   → SystemNotice
 *
 * 死分支回归防护：bgNotify / gui 渲染分支已随 M1 删除（BgNotifyCard 组件本体 M2、
 * Message.bgNotify 字段与 extractGuiComponent 函数 M6 删除）——kind 全集不含这两类，
 * 若未来有人加回「嗅探 details.__gui__ / bgNotify 字段再渲染专属卡片」的路径，
 * 本测通过「kind 全集三态互斥 + 无 bgNotify/gui 渲染」抓出。
 *
 * 为什么 mock virtua/vue：happy-dom 无真实布局/ResizeObserver，真 <Virtualizer> 的
 * viewportSize=0 → 不窗口化渲染任何项（MessageStream-bash.test.ts T10/gap3 曾因同因
 * skip，已由该文件内 virtua mock 恢复）。
 * 本测把 Virtualizer mock 成全量渲染 scoped slot 的 stub，让模板 v-if/v-else-if/v-else
 * 链对每项真实执行——这正是「查表分发」的断言对象（组件选中逻辑在模板，不在 virta）。
 * [U0] 起另消费 :keep-mounted 并复刻越界直传 slot 语义（见下方 [U0] 注释）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/MessageStream-kind.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import MessageStream from '@/components/panel/MessageStream.vue'
import { turnStableId } from '@xyz-agent/core/domain/chat'
import type { Message } from '@xyz-agent/shared'

// ── virtua mock：Virtualizer → 全量渲染 scoped slot 的 stub ──────────────────────────
// 暴露 VirtualizerHandle 兼容字段（MessageStream 的 rail/useVirtuaFollow
// 在 mount 期读取 scrollSize/findItemIndex/getItemOffset 等；vi.fn 保证不会调崩）。
// 注意 1：vi.mock factory 会被 hoist 到文件顶部，不能引用顶层变量——vue/vi 全部动态 import。
// 注意 2：defineExpose 是 <script setup> 编译宏，普通 setup 函数里调用不生效（实测）。
//   mock 改由 setup 返回 handle 对象（自动成为 setupState，proxy 可读）+ render 选项渲染 slot。
// [M5 stable-key] slotKeyCollector：mock render 时记录每个 item 的 slot vnode key——
//    virtua 生产实现用 slot vnode 的 key 作 item key（无 key 时 fallback `_${index}`，
//    消息插删时按索引错位复用 DOM）。收集器用于断言 slot 三分支已绑定稳定 :key。
//
// [U0 keepMounted 渲染语义]（设计 message-stream-editing-pin-identity §2.4 P5 / §5 U0-C3）：
//   本 mock 同时消费 :keep-mounted（Array）并复刻 virtua 0.50.0 实装的渲染循环——
//   `new Set(keepMounted)` 并入可视范围后逐索引调 slot({ item: data[idx], index: idx })，
//   全程无 index < data.length 检查（依据 node_modules/virtua/lib/vue/index.js：slot
//   调用 wrapper 起于 483（f.default 调用 484-487）/ keepMounted 并入循环在 505-511，
//   new Set 在 506）：idx 越界时 item=undefined 直传 slot。这不是
//   mock 的疏漏而是被测崩溃机理本身——生产代码编辑钉扎残留越界索引时，模板
//   `item.kind` 读 undefined.kind 抛 TypeError。U3 身份锚定（反查 + clamp + D8 清零）落地后用例转绿。
const slotKeyCollector = vi.hoisted(() => ({ keys: [] as (string | number | symbol | null | undefined)[][] }))

// [U3] keepMounted 收集器：记录每次渲染 MessageStream 传给 Virtualizer 的 :keep-mounted prop
//   原值（不含 mock 并入的可视范围索引）——供 U0 链路断言（编辑激活时含编辑 turn 索引，证明
//   钉扎链路未断路）与 A2 白盒断言（重排后跟随编辑回合新索引）使用，模式同 slotKeyCollector。
const keepMountedCollector = vi.hoisted(() => ({ entries: [] as number[][] }))

vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        keepMounted: { type: Array, default: () => [] },
        // [U3 适配] MessageStream U2 起传 :scroll-ref（chat-pin-bottom-fix D3 / P-wrap 门）。
        // 必须声明为 prop 吸收：不声明则落 reactive attrs，dev 下 mock render 经 dev proxy
        // 读 attrs 会跟踪它触发额外交互。注意：声明后挂载期仍有一次父驱动二次渲染
        // （:scroll-ref 绑定 undefined→el 解析 → MessageStream 重渲染 → 本 mock props 变更
        // → slot 再收集）——挂载期一次性 artifact，真实 virtua 同样会多渲染一次 slot；
        // slotKeyCollector 的断言改按「已收敛渲染窗口」取值（见「slot vnode 带稳定 :key」用例内
        // [U3 适配] 注释）。
        scrollRef: { type: Object, default: null },
      },
      setup() {
        // setup 返回对象 → 键暴露在 public instance proxy（模板 ref 指向它），
        // MessageStream 经 vlistRef.value.scrollSize/findItemIndex 等读取。
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
        // 记录本渲染收到的 :keep-mounted prop 原值（组件传入的 pinnedIndexes，不含下方
        // 并入的可视范围索引）供断言（[U3] keepMountedCollector）。
        keepMountedCollector.entries.push([...((ctx.keepMounted as number[]) ?? [])])
        // Set 迭代序 = 插入序：keepMounted 先入、可视范围后入（与 virtua 实装 m([...e]) 一致）。
        // 既有用例不产生钉扎（pinnedIndexes=[]）→ 集合退化为 0..n-1，与旧 map 行为逐字节等价。
        const indexes = new Set<number>((ctx.keepMounted as number[]) ?? [])
        for (let i = 0; i < data.length; i += 1) indexes.add(i)
        return h(
          'div',
          { class: 'mock-virtualizer' },
          // flatMap 扁平拼接 slot vnode（各自带 renderKey 稳定 key）——真实 virtua 把每项包进
          // 带 key 的 item wrapper 后扁平 push（index.js l.push(c(e))），keyed patch 按键移动
          // 复用实例；若此处保留嵌套数组 children，keepMounted 顺序变化会退化成逐位置 diff
          // → 全量重建（编辑态等实例状态丢失，与生产行为不符，P5 用例已实测踩过）。
          [...indexes].flatMap((idx) => {
            // 刻意不做越界过滤：data[idx] 越界 → item=undefined 直传 slot（virtua 实装行为）
            const vnodes = ctx.$slots.default?.({ item: data[idx], index: idx }) ?? []
            slotKeyCollector.keys.push(vnodes.map((v) => v.key))
            return vnodes
          }),
        )
      },
    }),
  }
})

// 壳 deps mock（MessageStream 装配 useChatViewDeps，测试聚焦 kind 分发不需真 deps）
const chatDepsMock = vi.hoisted(() => ({
  getMessages: vi.fn(() => []),
  isActive: vi.fn(() => false),
  isHandingOff: vi.fn(() => false),
  getChangeSetStatus: vi.fn(() => undefined),
  isExpanded: vi.fn(() => false),
  toggleExpand: vi.fn(),
  collapse: vi.fn(),
  abortBash: vi.fn(),
  editAndResend: vi.fn(),
  onFork: vi.fn(),
  onForkAsk: vi.fn(),
  onHandoff: vi.fn(),
  onHandoffAsk: vi.fn(),
  openDrawer: vi.fn(),
  onFileClick: vi.fn(),
  onAmbiguousSelect: vi.fn(),
  loadFileCandidates: vi.fn(() => Promise.resolve([])),
  renderMarkdown: vi.fn(() => Promise.resolve([])),
  renderMermaid: vi.fn(() => Promise.resolve({ svg: '' })),
  toMarkdown: vi.fn(() => ''),
}))
vi.mock('@/composables/panel/useChatViewDeps', () => ({
  useChatViewDeps: () => chatDepsMock,
}))
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

// happy-dom 不提供真实 ResizeObserver 布局测量
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** 目标组件 stub：带 testid，断言「kind → 组件」选中关系（选中哪个就渲染哪个 testid）。 */
const globalStubs = {
  // [U0 事件链打通] Turn 从无事件 stub 升级为可 emit `edit-state-change` 的 stub（设计
  // §5 U0：改 stub 或 unstub 二选一，取改 stub——真实 Turn.vue 依赖 Block/MarkdownRenderer
  // 等重组件树，happy-dom 下 mount 成本与脆弱面都大，而本测关心的链路只有：
  // canEdit prop（MessageStream 侧「最后 user turn 才可编辑」的真实判定结果）→ 编辑动作
  // → emit → MessageStream.onEditStateChange。stub 只替换 Turn/UserBubble 的内部 UI，
  // handler/钉扎派生/keepMounted 绑定全是真实生产代码路径。
  // [U3 stub 与真实 UserBubble 事件行为同构]（设计 §3.3 D2/D3）：
  // - 置位负载 {editing:true, turnKey}，turnKey 用与生产同一身份函数 turnStableId（首条消息
  //   id，与 renderKey 的 `t-` 空间一致）——生产 pinnedIndexes 按 `t-${turnKey}` 反查；
  // - 卸载清理：编辑态中卸载（session 切换 / 数据换血）时 emit {editing:false, turnKey}（D3
  //   「谁置位谁清理」）。C2（U2）已证 happy-dom 下 unmounted 内 emit 父监听器可达。
  // 编辑态 DOM 表现（turn-edit-box）模拟 UserBubble 气泡变输入框，供用例确认置位生效。
  Turn: {
    name: 'Turn',
    props: {
      turn: { type: Object, required: true },
      canEdit: { type: Boolean, default: false },
    },
    emits: ['edit-state-change'],
    data() {
      return { editing: false }
    },
    methods: {
      startEdit(): void {
        this.editing = true
        this.$emit('edit-state-change', { editing: true, turnKey: turnStableId(this.turn) })
      },
    },
    unmounted() {
      if (this.editing) {
        this.$emit('edit-state-change', { editing: false, turnKey: turnStableId(this.turn) })
      }
    },
    template: `
      <div :data-testid="'turn-stub-' + turn.index" :data-editing="String(editing)">
        <textarea v-if="editing" data-testid="turn-edit-box" />
        <button v-if="canEdit && !editing" data-testid="turn-edit-btn" @click="startEdit">edit</button>
      </div>`,
  },
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div data-testid="bash-output-stub" />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

function mountStream(sessionId: string, onError?: (err: unknown) => void) {
  return mount(MessageStream, {
    props: { sessionId },
    global: {
      stubs: globalStubs,
      // errorHandler 仅在需要收集渲染错误的用例传入：挂上后 Vue 不再把渲染错误打
      // console.error（logError 分支被短路），既有用例保持默认行为不吞意外报错
      ...(onError ? { config: { errorHandler: onError } } : {}),
    },
    attachTo: document.body,
  })
}

function makeMsg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'system',
    content: '',
    status: 'complete',
    timestamp: Date.now(),
    ...over,
  } as Message
}

function bashMsg(id: string): Message {
  return makeMsg({
    id,
    role: 'system',
    bashExecution: {
      command: 'echo hi',
      output: 'hi',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1000,
    },
  })
}

describe('MessageStream kind 查表分发（M1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    slotKeyCollector.keys.length = 0
    keepMountedCollector.entries.length = 0
  })

  it('TC2: kind=bashExecution → BashOutputBlock，SystemNotice/Turn 不渲染', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-kind-bash', [bashMsg('bash-1')])

    const wrapper = mountStream('sess-kind-bash')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="turn-stub-"]').exists()).toBe(false)
  })

  it('TC2: kind=systemNotice（compaction/branchSummary 等无 bashExecution 的 system）→ SystemNotice', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-kind-notice', [
      makeMsg({ id: 'c1', content: '压缩记录' }),
      makeMsg({ id: 'b1', branchSummary: { summary: 's', fromId: 'prev' } }),
    ])

    const wrapper = mountStream('sess-kind-notice')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-testid="system-notice-stub"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid^="turn-stub-"]').exists()).toBe(false)
  })

  it('TC2: kind=turn → Turn，system 类组件不渲染', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-kind-turn', [
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
    ])

    const wrapper = mountStream('sess-kind-turn')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="turn-stub-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(false)
  })

  it('TC2: 混合序列 [turn, systemNotice, turn] 按序渲染，各分支互斥（bash 归 turn 内 notices）', async () => {
    const chat = useChatStore()
    chat.hydrate('sess-kind-mix', [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'c1', content: '压缩记录' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      bashMsg('bash-1'),
    ])

    const wrapper = mountStream('sess-kind-mix')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-testid^="turn-stub-"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(true)
    // [W3 v2] bash 执行记录归 turn2 内 notices（Turn stub 内部渲染，见 ui 包 Turn.test.ts
    // turn-inline-bash 用例）——顶层不再产出独立 bashExecution 渲染项
    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(false)

    // DOM 顺序与 renderItems 一致：turn1 → notice → turn2
    const body = wrapper.element as HTMLElement
    const ids = Array.from(body.querySelectorAll('[data-testid^="turn-stub-"], [data-testid="system-notice-stub"]')).map(
      (el) => el.getAttribute('data-testid'),
    )
    expect(ids).toEqual(['turn-stub-1', 'system-notice-stub', 'turn-stub-2'])
  })

  it('TC2: bgNotify 消息（customType=subagent-bg-notify, display:false）不渲染任何专属组件（M1 死分支回归防护）', async () => {
    // [M2 display 前置] 黑名单已删：subagent-bg-notify 由生产端（core apply-entry
    // custom_message case——实时 customStart 喂 entry 与重开 replay 同一覆写点 /
    // runtime mapper）统一写 display:false → filterDisplayableMessages 按 display 字段过滤移除。
    // 若未来有人给 kind 全集加回 bgNotify 类分支/嗅探，本用例确保至少不渲染专属卡片。
    const chat = useChatStore()
    chat.hydrate('sess-kind-bgnotify', [
      makeMsg({ id: 'n1', customType: 'subagent-bg-notify', display: false, content: '子代理完成' }),
      makeMsg({ id: 'u1', role: 'user', content: 'q' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r' }),
    ])

    const wrapper = mountStream('sess-kind-bgnotify')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 过滤后只剩 user+assistant → 1 个 turn；bg-notify 消息不产生任何渲染项
    expect(wrapper.find('[data-testid="turn-stub-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bash-output-stub"]').exists()).toBe(false)
  })

  it('TC2: slot vnode 带稳定 :key（renderKey(item)，非索引——virtua item key 依据）', async () => {
    // [M5 stable-key] virtua 生产实现：slot 返回单 vnode 时取其 key 作 item key，
    // 无 key 时 fallback `_${index}`（消息插删/streaming 追加按索引错位复用 DOM）。
    // 断言：每个 item 的 slot vnode key 存在且为稳定 id 派生（turn=首条消息 id，system=message.id），
    // 且同一数据两次渲染 key 集合一致（不随渲染重建漂移）。
    const chat = useChatStore()
    chat.hydrate('sess-kind-key', [
      makeMsg({ id: 'u1', role: 'user', content: 'q1' }),
      makeMsg({ id: 'a1', role: 'assistant', content: 'r1' }),
      makeMsg({ id: 'c1', content: '压缩记录' }),
      makeMsg({ id: 'u2', role: 'user', content: 'q2' }),
      makeMsg({ id: 'a2', role: 'assistant', content: 'r2' }),
      bashMsg('bash-1'),
    ])

    const wrapper = mountStream('sess-kind-key')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 3 个渲染项（turn1 + notice + turn2；[W3 v2] bash 归 turn2 内 notices 不出顶层项），每个 slot vnode 都带 key。
    // [U3 适配] U2 起 MessageStream 向 <Virtualizer> 传 :scroll-ref（D3/P-wrap 门），挂载期该
    // 绑定经历 undefined→el 一次解析 → 父组件重渲染 → mock props 变更 → 二次渲染，收集器含
    // 2 个渲染窗口（每窗口恰 3 条，一 item 一条）。断言语义改为「每个渲染窗口的 key 集合一致
    // 且稳定」：窗口总数为 3 的整数倍，取最后一个已收敛窗口断言内容，且全部窗口的 key 并集
    // 不引入新 key（任意窗口 key 漂移都会被抓出）。
    expect(slotKeyCollector.keys.length).toBeGreaterThanOrEqual(3)
    expect(slotKeyCollector.keys.length % 3).toBe(0)
    const flatKeys = slotKeyCollector.keys.slice(-3).map((k) => k[0])
    expect(flatKeys).toEqual(['t-u1', 's-c1', 't-u2'])
    expect(new Set(slotKeyCollector.keys.flat())).toEqual(new Set(['t-u1', 's-c1', 't-u2']))
    // 全部 key 非空（virtua 不会 fallback `_${index}`）
    expect(flatKeys.every((k) => k != null && k !== '')).toBe(true)

    // 同一数据重新 mount → 已收敛窗口 key 集合一致（不随渲染重建漂移）
    slotKeyCollector.keys.length = 0
    const wrapper2 = mountStream('sess-kind-key')
    await wrapper2.vm.$nextTick()
    await wrapper2.vm.$nextTick()
    expect(slotKeyCollector.keys.slice(-3).map((k) => k[0])).toEqual(['t-u1', 's-c1', 't-u2'])
    expect(new Set(slotKeyCollector.keys.flat())).toEqual(new Set(['t-u1', 's-c1', 't-u2']))
    wrapper2.unmount()
  })
})

/**
 * P5 探针门（设计 message-stream-editing-pin-identity §2.4 P5 / §5 U0，实施计划 §2 U0）：
 *
 * U0 阶段这是 failing test——旧生产代码把「正在编辑的回合」存成数组位置快照
 * （MessageStream.editingTurnIdx，slot 闭包捕获的下标），编辑组件无卸载清理，
 * 「编辑中切到更短会话」时该下标残留越界；mock Virtualizer 复刻 virtua 0.50.0
 * keepMounted 渲染语义（越界不过滤，item=undefined 直传 slot），模板 `item.kind`
 * 读 undefined.kind 抛 TypeError——即打包版 0.9.12 报障的崩溃路径。
 *
 * 【U3 起本用例为绿】编辑态改为身份锚定（editingTurnKey + useStreamingPin 反查 + clamp +
 * watch(sessionId) D8 清零 + UserBubble 卸载 emit，D2/D3/D8）后崩溃路径结构性消除。
 * 但「不崩」本身可能是断路假绿（旧参被静默忽略 → 编辑钉扎整体断路 → 不崩也没钉），
 * 故断言双通道取证：
 * - 切 session 前 keepMounted **含有**编辑 turn 的索引 → 钉扎链路真实接通（非断路）；
 * - 切短会话后 keepMounted **不含**越界索引 → 修复真实生效（D8 清零 / D3 卸载 emit 幂等归 null，
 *   反查 miss 不入 pinnedIndexes，clamp 兜底）。
 */
describe('P5 探针门：keepMounted 越界渲染崩溃复现（U0 红 → U3 绿）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    slotKeyCollector.keys.length = 0
    keepMountedCollector.entries.length = 0
  })

  it('编辑中切短会话 → mount/重渲染不抛，且 keepMounted 证明钉扎链路接通后随切换收敛（U3）', async () => {
    const chat = useChatStore()

    // 长会话 5 个 turn（每 turn = user + assistant）：末 turn 是最后 user turn，
    // canEdit（index === lastUserTurnIdx）仅对其为 true → 恰 1 个编辑按钮
    const longMsgs: Message[] = []
    for (let i = 1; i <= 5; i += 1) {
      longMsgs.push(makeMsg({ id: `u${i}`, role: 'user', content: `q${i}` }))
      longMsgs.push(makeMsg({ id: `a${i}`, role: 'assistant', content: `r${i}` }))
    }
    chat.hydrate('sess-edit-long', longMsgs)
    // 短会话 1 个 turn：旧索引快照协议下切换后残留的下标 4 越界（越界长度=1）
    chat.hydrate('sess-edit-short', [
      makeMsg({ id: 'su1', role: 'user', content: 'sq' }),
      makeMsg({ id: 'sa1', role: 'assistant', content: 'sr' }),
    ])

    // 渲染错误的收集双通道：app.config.errorHandler（Vue 3 render 错误主通路）+
    // console.error spy（兜底 Vue 行为差异）。收集后静默，避免 stderr 泄漏。
    const errors: unknown[] = []
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const wrapper = mountStream('sess-edit-long', (err) => {
      errors.push(err)
    })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 事件序列第 1 步：进入末 turn 编辑（DOM 点击 → stub emit {editing:true, turnKey:'u5'}
    // → 真实 handler 写 editingTurnKey → pinnedIndexes 身份反查）
    const editBtns = wrapper.findAll('[data-testid="turn-edit-btn"]')
    expect(editBtns).toHaveLength(1) // canEdit 只给最后 user turn——顺带锚定链路前置条件
    await editBtns[0].trigger('click')
    await wrapper.vm.$nextTick()
    // 编辑态置位的 DOM 表现（模拟 UserBubble 气泡变输入框）
    expect(wrapper.find('[data-testid="turn-edit-box"]').exists()).toBe(true)

    // [非断路假绿证明] 编辑激活时 keepMounted 必含编辑 turn 的索引 4（t-u5 反查命中）——
    // 钉扎链路真实接通（断路假绿形态下此处恒为 []）
    const keepMountedActive = keepMountedCollector.entries[keepMountedCollector.entries.length - 1] ?? []
    expect(keepMountedActive).toContain(4)

    // 事件序列第 2 步：切短会话（props.sessionId 变化 → watch flush:'pre' D8 清零先行 →
    // Virtualizer :key 重建、旧编辑 stub 卸载 emit {editing:false, turnKey}（D3）幂等归 null）
    const entriesLenBeforeSwitch = keepMountedCollector.entries.length
    await wrapper.setProps({ sessionId: 'sess-edit-short' })
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // [修复生效证明] 切换后每次渲染的 keepMounted 全部有界（短会话仅 1 个渲染项，
    // 越界索引 4 不得出现——E-now-1 崩溃路径被结构性消除）
    const keepMountedAfter = keepMountedCollector.entries.slice(entriesLenBeforeSwitch)
    expect(keepMountedAfter.length).toBeGreaterThan(0)
    for (const keepMounted of keepMountedAfter) {
      expect(keepMounted.every((idx) => idx >= 0 && idx < 1)).toBe(true)
    }

    // 断言：切换后的 mount/重渲染零崩溃（旧协议下失败信息含 TypeError 证据：
    // Cannot read properties of undefined (reading 'kind')——keepMounted=[4] 越界 →
    // mock slot 收到 item=undefined → 模板 item.kind 抛错）。
    const allMsgs = [
      ...errors.map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))),
      ...consoleErrorSpy.mock.calls.map((args) => args.map(String).join(' ')),
    ]
    expect(allMsgs.join(' | ')).toBe('')

    consoleErrorSpy.mockRestore()
    wrapper.unmount()
  })
})

/**
 * A2 白盒判据（设计 message-stream-editing-pin-identity §4 A2 / §5 U3 验收，与黑盒分列执行）：
 *
 * 「编辑中后台消息入流」的最小重排形态——前插一条 system 消息使编辑 turn 索引整体后移。
 * 身份锚定下 pinnedIndexes 每次从当前 items 反查（D1），keepMounted 必须跟随编辑回合的
 * 新索引（G3：钉在身份上，不钉在位置上）——位置快照协议在此会错钉/残留旧索引（E-now-2）。
 * setMessages 直接覆盖（不受 hydrate 一次性守卫），renderKey 身份不变 → Turn 实例按 key
 * 复用，编辑态不被打断（G2）。
 */
describe('A2 白盒：编辑中数组重排 → keepMounted 跟随编辑回合身份（U3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
    slotKeyCollector.keys.length = 0
    keepMountedCollector.entries.length = 0
  })

  it('编辑末 turn 后前插 system 消息 → keepMounted 从旧索引 2 移到新索引 3，编辑态保持', async () => {
    const chat = useChatStore()
    const msgs: Message[] = []
    for (let i = 1; i <= 3; i += 1) {
      msgs.push(makeMsg({ id: `u${i}`, role: 'user', content: `q${i}` }))
      msgs.push(makeMsg({ id: `a${i}`, role: 'assistant', content: `r${i}` }))
    }
    chat.hydrate('sess-a2-reorder', msgs)

    const wrapper = mountStream('sess-a2-reorder')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // 末 turn（u3，渲染项索引 2）进入编辑——canEdit 只给最后 user turn
    const editBtns = wrapper.findAll('[data-testid="turn-edit-btn"]')
    expect(editBtns).toHaveLength(1)
    await editBtns[0].trigger('click')
    await wrapper.vm.$nextTick()

    // 编辑激活：keepMounted = [2]（t-u3 反查自当前 items）
    expect(keepMountedCollector.entries[keepMountedCollector.entries.length - 1]).toEqual([2])

    // 重排：前插 system 消息（渲染项 [notice, t1, t2, t3]）→ 编辑 turn 索引 2 → 3
    chat.setMessages('sess-a2-reorder', [makeMsg({ id: 'sys-a2', content: '压缩记录' }), ...msgs])
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // keepMounted 跟随身份：恒等于编辑回合的新索引 3（位置快照协议会残留 2 → 错钉他回合）
    expect(keepMountedCollector.entries[keepMountedCollector.entries.length - 1]).toEqual([3])

    // G2：编辑态未被重排打断（输入框仍在——renderKey 稳定，Turn 实例按 key 复用）
    expect(wrapper.find('[data-testid="turn-edit-box"]').exists()).toBe(true)

    wrapper.unmount()
  })
})
