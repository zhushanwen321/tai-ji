/**
 * MessageStream bashExecution 路由测试（composer-bash-execute W3 TK9）。
 *
 * 验证：含 bashExecution 的 system 消息 → 路由到 BashOutputBlock 而非 SystemNotice。
 *
 * [cw wave w3] T10/gap3/W5T1 三用例曾整体 skip（[HISTORICAL] 溯源）：MessageStream.vue 切到
 *   virtua <Virtualizer> 后，happy-dom 无真实 ResizeObserver/布局 → viewportSize=0 → 未被
 *   :keepMounted 钉扎的项（bash 是 system item，非 streaming 非 editing）不进渲染窗口 →
 *   DOM 找不到 BashOutputBlock。这是 happy-dom 测试环境限制而非真实回归（真实 Chromium 有 RO
 *   会正常窗口化）。现以 virtua mock 修复（Virtualizer → 全量渲染 scoped slot 的 stub，
 *   模式复用 MessageStream-kind.test.ts），三用例恢复运行。
 *   BashOutputBlock 组件自身的渲染 / exit tag / output 展示覆盖由 BashOutputBlock.test.ts 维持。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/MessageStream-bash.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import MessageStream from '@/components/panel/MessageStream.vue'
// [w6 chat-ui-and-shell T7] ui 包 BashOutputBlock（MessageStream 壳 provide 真 deps → mock useChatViewDeps）
import { BashOutputBlock } from '@xyz-agent/ui'
// [W4] executingBash 瞬时态置/清：直接调 core bash-effects 的帧 handler（bashStart 置 /
// bashResult abort 哨兵帧清，均不触碰 ctx——哨兵分支在解构后 return 前短路，传最小 fake ctx）
import { bashEffects } from '@xyz-agent/core'
import type { MessageEffectContext } from '@xyz-agent/core'
import type { Message } from '@xyz-agent/shared'
import { defineComponent, h } from 'vue'

// ── virtua mock：Virtualizer → 全量渲染 scoped slot 的 stub（模式复用 MessageStream-kind.test.ts
// 简化版：无需其 slotKeyCollector / keepMountedCollector 断言收集器）──────────────────────
// 为什么 mock：happy-dom 无真实布局/ResizeObserver，真 <Virtualizer> 的 viewportSize=0 →
// 非 keepMounted 项（bash 是 system item）不进渲染窗口 → DOM 找不到。stub 让模板
// v-if/v-else-if/v-else 链对每项真实执行。handle 兼容字段保留：MessageStream 的
// rail/useVirtuaFollow 在 mount 期读取 scrollSize/findItemIndex 等（vi.fn 保证不会调崩）。
// 注意 1：vi.mock factory 会被 hoist 到文件顶部，不能引用顶层变量——vue/vi 全部动态 import。
// 注意 2：defineExpose 是 <script setup> 编译宏，普通 setup 函数里调用不生效（实测）。
//   mock 改由 setup 返回 handle 对象（自动成为 setupState，proxy 可读）+ render 选项渲染 slot。
vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        keepMounted: { type: Array, default: () => [] },
        // MessageStream 传 :scroll-ref，必须声明为 prop 吸收（不声明则落 reactive attrs，
        // dev 下 mock render 经 dev proxy 读 attrs 会跟踪它触发额外交互）。
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
        // Set 迭代序 = 插入序：keepMounted 先入、可视范围后入（与 virtua 实装 m([...e]) 一致）；
        // 无真实布局下视口恒 0，全量并入 0..n-1 =「全部项都在渲染窗口内」。
        const indexes = new Set<number>((ctx.keepMounted as number[]) ?? [])
        for (let i = 0; i < data.length; i += 1) indexes.add(i)
        return h(
          'div',
          { class: 'mock-virtualizer' },
          [...indexes].flatMap((idx) => {
            // 刻意不做越界过滤：data[idx] 越界 → item=undefined 直传 slot（virtua 实装行为）
            return ctx.$slots.default?.({ item: data[idx], index: idx }) ?? []
          }),
        )
      },
    }),
  }
})

// 壳 deps mock（MessageStream 装配 useChatViewDeps，测试聚焦路由分支不需真 deps）
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

// happy-dom 不提供 ResizeObserver
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const globalStubs = {
  Turn: { name: 'Turn', template: '<div />' },
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  GuiComponentRenderer: { name: 'GuiComponentRenderer', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
}

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

describe('MessageStream bashExecution 路由', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('T10: messages 含 bashExecution system 消息 → BashOutputBlock 渲染，SystemNotice 不渲染', () => {
    const chat = useChatStore()
    const sid = 'sess-bash-route'
    const bashMsg: Message = {
      id: 'bash-1',
      role: 'system',
      content: '',
      status: 'complete',
      bashExecution: {
        command: 'echo hi',
        output: 'hi',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
      timestamp: 1000,
    } as Message
    chat.hydrate(sid, [bashMsg])

    const wrapper = mountStream(sid)
    // BashOutputBlock 真组件渲染（未被 stub）
    const block = wrapper.findComponent(BashOutputBlock)
    expect(block.exists()).toBe(true)
    // SystemNotice stub 不应出现（bash 消息走 BashOutputBlock 分支）
    expect(wrapper.find('[data-testid="system-notice-stub"]').exists()).toBe(false)
  })

  /**
   * gap3 首屏冒烟用例（PR#116 review gap3）：mount MessageStream + hydrate 一条 bash 消息，
   * 下钻断言 BashOutputBlock 内部三个 DOM testid 节点同时存在（不只 findComponent 实例存在）。
   *
   * 审查要求：T10 只断言了 BashOutputBlock 组件实例存在（findComponent），未下钻到内部 testid，
   * 无法防护「组件挂了但内部 render 为空 / testid 缺失 / v-if 误判」事故。本用例补这条：mount 后
   * 直接 find DOM 节点，验证 bash-output-block / bash-output / bash-status-tag 三节点齐全。
   *
   * 前置确认：BashOutputBlock.vue 已具备三个 testid（G4 新增了 bash-output-truncated），
   * 无需改产品代码暴露 testid。
   */
  it('gap3: hydrate bash 消息 → DOM 同时存在 bash-output-block + bash-output + bash-status-tag 三 testid', async () => {
    const chat = useChatStore()
    const sid = 'sess-bash-smoke'
    const bashMsg: Message = {
      id: 'bash-smoke-1',
      role: 'system',
      content: '',
      status: 'complete',
      bashExecution: {
        command: 'ls -la',
        output: 'total 0\ndrwxr-xr-x  2 root root 4096 Jul 26 10:00 .',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 1000,
      },
      timestamp: 1000,
    } as Message
    chat.hydrate(sid, [bashMsg])

    const wrapper = mountStream(sid)
    // 等 mount + 虚拟列表 visibleRange 收敛（首屏单条消息必在窗口内）
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // ── 下钻到 BashOutputBlock 内部 DOM testid（不只 findComponent 实例存在）──
    // bash-output-block：根容器
    const block = wrapper.find('[data-testid="bash-output-block"]')
    expect(block.exists()).toBe(true)
    // bash-output：输出区（complete + hasOutput 才渲染）
    const output = wrapper.find('[data-testid="bash-output"]')
    expect(output.exists()).toBe(true)
    expect(output.text()).toContain('total 0')
    // bash-status-tag：exit 标签（complete 态渲染，显示「exit 0」）
    const tag = wrapper.find('[data-testid="bash-status-tag"]')
    expect(tag.exists()).toBe(true)
    expect(tag.text()).toBe('exit 0')
  })
})

/**
 * W5 共存场景集成测试（bash-align-pi-tui-w4::w5-tests-regression W5T1）。
 *
 * 背景：w2 放开 bash↔streaming 并发后，共存场景下 bash 消息 append 到 messages 末尾，
 * streaming assistant turn 变成倒数第二项。w3 单测了 useStreamingPin 的 pinnedIndexes
 * 算法（W3T1-T3，喂 virtua <Virtualizer :keepMounted>），但未集成测 MessageStream——本用例补这条缺口。
 *
 * 验证（mount 后）：
 * - streaming assistant turn 的 DOM 节点存在（在窗口内、未被虚拟列表卸载）
 * - bash 消息 DOM 存在（BashOutputBlock 真组件渲染）
 * - bash DOM 由 streaming turn 内 notices 渲染（[W3 v2] rule 4 归因，位于 turn-stub 根 div 内部）
 *
 * 钉扎算法的单元覆盖由 use-streaming-pin.test.ts（W3 共存防护系列）保证，顶层顺序守护同样
 * 由该单测 + core message-turns.incremental.test.ts R4 接管；happy-dom 下经本文件的 virtua
 * mock（全量渲染 stub）驱动真实模板分支，本用例聚焦「mount 后共存双挂载 + rule 4 归因成立」。
 */
// 共存测试的 Turn stub：渲染带 turn index testid 的 div，便于断言 DOM 存在 + 顺序。
// 用 defineComponent 而非 template 字符串：props.turn 是对象，模板字符串取不到字段。
// [W3 v2 适配] streaming bash system 消息归当前 turn 内 notices（message-turns D4 规则 4
// appendInlineNotice，顶层不再产出独立 bashExecution 渲染项），由真实 Turn.vue 内部
// v-for notices 渲染 BashOutputBlock——stub 同构渲染 notices 的 bash 消息（真 BashOutputBlock），
// 否则共存场景 bash DOM 永不出现。
const TurnStub = defineComponent({
  name: 'Turn',
  props: {
    turn: { type: Object, required: true },
    sessionId: { type: String, default: undefined },
  },
  setup(props) {
    return () => {
      const turn = props.turn as { index: number; notices?: Message[] }
      return h('div', { 'data-testid': `turn-stub-${turn.index}` }, [
        ...(turn.notices ?? [])
          .filter((n) => n.bashExecution !== undefined)
          .map((n) => h(BashOutputBlock, { message: n, sessionId: props.sessionId })),
      ])
    }
  },
})

const coexistStubs = {
  Turn: TurnStub,
  SystemNotice: { name: 'SystemNotice', template: '<div data-testid="system-notice-stub" />' },
  GuiComponentRenderer: { name: 'GuiComponentRenderer', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
}

describe('MessageStream 共存钉扎（W5T1，streaming turn + bash 消息双挂载）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('W5T1: 共存场景 mount → streaming turn DOM + bash DOM 双挂载，bash 由 turn 内 notices 渲染', async () => {
    const chat = useChatStore()
    const sid = 'sess-coexist'
    // 1) streaming assistant turn：user + status:'streaming' 的 assistant（最后一条 assistant
    //    为 streaming → messageTurns 把 turn.isStreaming 置 true → useStreamingPin 驱动 pinStreaming）
    const userMsg: Message = {
      id: 'u-coexist',
      role: 'user',
      content: 'run the tests',
      status: 'complete',
      timestamp: 100,
    } as Message
    const streamingAssistant: Message = {
      id: 'a-coexist',
      role: 'assistant',
      content: 'running...',
      status: 'streaming',
      timestamp: 101,
    } as Message
    // 2) streaming bash system msg：composer 直接执行 bash，与 streaming turn 并发
    //    （w2 放开并发；bash 是元信息 system 消息排在 streaming turn 之后）
    const streamingBash: Message = {
      id: 'bash-coexist',
      role: 'system',
      content: '',
      status: 'streaming',
      bashExecution: {
        command: 'npm test',
        output: '',
        exitCode: null,
        cancelled: false,
        truncated: false,
        excludeFromContext: false,
        timestamp: 102,
      },
      timestamp: 102,
    } as Message
    // hydrate 注入共存消息序列：[user, streaming assistant, streaming bash]
    chat.hydrate(sid, [userMsg, streamingAssistant, streamingBash])

    const wrapper = mount(MessageStream, {
      props: { sessionId: sid },
      global: { stubs: coexistStubs },
      attachTo: document.body,
    })
    // 等 mount 后 watch（scrollEl / useStreamingPin）副作用落地
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()

    // streaming assistant turn 的 DOM 节点存在（在 visibleRange 内、未被虚拟列表卸载）
    const turnEl = wrapper.find('[data-testid="turn-stub-1"]')
    expect(turnEl.exists()).toBe(true)

    // bash 消息存在（findComponent 证明 BashOutputBlock 真组件渲染、未被 stub）
    expect(wrapper.findComponent(BashOutputBlock).exists()).toBe(true)
    // [W3 v2 适配] bash DOM 经 testid 下钻取元素（gap3 同款模式）。[HISTORICAL] 不用
    // findComponent().element：BashOutputBlock 模板根前有顶层注释 → dev 下 subTree 是
    // fragment（注释锚点 + 根 div），VTU 对 fragment 根组件的 .element 归一化错位
    // （实测指向 stub 根 div 而非 bash-output-block）——本用例 skip 期间从未真跑故未暴露。
    const bashEl = wrapper.find('[data-testid="bash-output-block"]').element as HTMLElement

    // 归因断言：bash 由 turn 内 notices 渲染（[W3 v2] rule 4 归因）→ bash-output-block 必在
    // turn-stub 根 div 内部。rule 4 回归（bash 逃逸回顶层渲染项）时 bashEl 在 turn-stub 之外，
    // contains 为 false → 红。顶层顺序守护已由 use-streaming-pin.test.ts（W3 共存防护）+
    // core message-turns.incremental.test.ts R4 单测接管，此处不做文档序断言。
    expect(turnEl.element.contains(bashEl)).toBe(true)
  })
})

/**
 * W4 executing bash 瞬时行（turn-attribution D2 ephemeral 通道）。
 *
 * [u6a / D7 展示统一] 行渲染点已从 MessageStream 模板迁入 ActivityStrip 组件
 * （data-testid 从 executing-bash-notice 变为 activity-strip-row-bash），生命周期与数据源
 * （bash-effects 模块级 per-session Map）不变。
 *
 * 覆盖（出现/消失生命周期 + 内容）：
 * - bashStart 帧置位 → ActivityStrip bash 行出现，含 i18n 前缀（zh locale「正在执行」）+ mono 命令
 * - bashResult 到达（abort 哨兵帧 command:''+cancelled:true 只清执行态不产 entry）→ 行消失
 * - 行位于 Virtualizer 之外（文档流），空消息 session 也可见——不依赖 virtua 渲染窗口（T10/gap3/
 *   W5T1 依赖本文件的 Virtualizer stub 才能在 happy-dom 下渲染，本用例有无该 mock 均可跑）
 *
 * 状态说明：executingBash 是 core 模块级 per-session Map（不进 messages）；bashStartEffect /
 * bashResultEffect 哨兵分支均不解构使用 ctx，传最小 fake ctx 即可驱动真实 effect 代码路径。
 */
describe('MessageStream executing bash 瞬时行（[u6a] ActivityStrip bash 行）', () => {
  /** 最小 fake ctx：两个帧 handler 的目标分支都不触碰 ctx 字段（哨兵分支在解构后短路） */
  const fakeCtx = { messages: undefined, applyEntryFrame: undefined } as unknown as MessageEffectContext

  /** 清残留（模块级 Map 跨用例共享，哨兵帧幂等清除） */
  function clearExecutingBash(sid: string): void {
    bashEffects['message.bashResult']?.(fakeCtx, sid, { command: '', cancelled: true })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    clearExecutingBash('sess-exec-bash')
  })

  it('W4-E1: bashStart 置位 → bash 行出现（前缀文案 + 命令文本）；bashResult 到达 → 行消失', async () => {
    const sid = 'sess-exec-bash'
    clearExecutingBash(sid)
    const wrapper = mountStream(sid)

    // 初始：无执行态 → 活动条不渲染
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)

    // bashStart 帧置位 → bash 行出现（live 中途出现的真实时序）
    bashEffects['message.bashStart']?.(fakeCtx, sid, { command: 'npm test', timestamp: 1 })
    await nextTick()
    const row = wrapper.find('[data-testid="activity-strip-row-bash"]')
    expect(row.exists()).toBe(true)
    // W4 完整形态：i18n 前缀（renderer 测试 t() 从 zh-CN locale 真实取值）+ mono 命令文本
    expect(row.text()).toContain('正在执行')
    expect(row.text()).toContain('npm test')
    // 旧渲染点清理：原 executing-bash-notice testid 不应再出现
    expect(wrapper.find('[data-testid="executing-bash-notice"]').exists()).toBe(false)

    // bashResult 到达（abort 哨兵帧：只清执行态不产 entry）→ 行消失，无残留 spinner
    bashEffects['message.bashResult']?.(fakeCtx, sid, { command: '', cancelled: true })
    await nextTick()
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)

    wrapper.unmount()
  })
})
