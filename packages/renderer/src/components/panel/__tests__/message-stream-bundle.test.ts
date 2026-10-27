/**
 * MessageStream 合并产物（round 6 renderer 测试压缩）：两源同产物。
 *
 * 并入来源（基名）：
 *  - MessageStream-bash（bashExecution 路由，4 例）
 *  - MessageStream-subagent-force-working（前轮产物整体并入：force-working 接线 +
 *    subagentThinking 反例 + directive 定向气泡，10 例）
 *
 * mock 注册（产物内统一）：
 *  - 'virtua/vue' → bash 版工厂（Virtualizer stub 全量渲染 scoped slot；props 含
 *    keepMounted/scrollRef —— subagent 原用 helpers 无 keepMounted 的简化版，统一取
 *    超集版：多声明一个 prop 对其用例无影响）。
 *  - '@/composables/panel/useChatViewDeps' → chatViewDepsModule()（bash 显式注册与
 *    subagent 经 helpers/message-stream-shell-mount 顶层注册同工厂，重复注册等价）。
 *  - '@/composables/features/chat/useChat' + '@/composables/features/sidebar/useSidebar'
 *    → 经 shell-mount 顶层注册（subagent 消费；bash 节挂载树不消费真模块，零影响）。
 *
 * 互斥登记（保留独立）：MessageStream-truncated-bar（jsdom 环境标注 + useChat/useSidebar
 * 内联定制工厂（loadMoreHistoryMock 闭包），与 shell-mount 通用工厂同 spec 多工厂互斥）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/components/panel/__tests__/message-stream-bundle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatViewDepsModule, virtuaVueMockModule, messageStreamStubs, resetMessageStreamEnv, makeStreamMessageFactory } from '@/__tests__/helpers/chat-stream-mount'
import '@/__tests__/helpers/message-stream-shell-mount'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, effectScope, defineComponent, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createUseChat, resetChatModuleStateForTest } from '@taiji/core'
import type { ChatStoreInstance, UseChatDeps } from '@taiji/core'
import { bashEffects } from '@taiji/core'
import type { MessageEffectContext } from '@taiji/core'
import type { ServerMessage, Segment, Message, SubagentRecord } from '@taiji/shared'
import { SUBAGENT_OUTCOME_PLACEHOLDER } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'
import { useSubagentStore, subagentVirtualId } from '@/stores/subagent'
import MessageStream from '@/components/panel/MessageStream.vue'
import { BashOutputBlock } from '@taiji/ui'

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

vi.mock('@/composables/panel/useChatViewDeps', () => chatViewDepsModule())

// ═══════════ 来源节：MessageStream-bash ═══════════
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
 * 固定算法的单元覆盖由 use-streaming-pin.test.ts（W3 共存防护系列）保证，顶层顺序守护同样
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

describe('MessageStream 共存固定（W5T1，streaming turn + bash 消息双挂载）', () => {
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
 * - bashStart 帧置位 → ActivityStrip bash 行出现，行内 = i18n 前缀（zh locale「正在执行」）+
 *   elapsed mono meta；命令原文不内联、在悬停详情（方案 A，见 ActivityStrip.vue 组件头注
 *   [notice-family-phrase-detail 方案 A]——长命令会把横线挤成残端，故短语化）
 * - bashAborted 到达（abortBash 兜底终态独立帧 message.bashAborted，msg-pipeline-debloat
 *   D4-3；只清执行态不产 entry）→ 行消失
 * - 行位于 Virtualizer 之外（文档流），空消息 session 也可见——不依赖 virtua 渲染窗口（T10/gap3/
 *   W5T1 依赖本文件的 Virtualizer stub 才能在 happy-dom 下渲染，本用例有无该 mock 均可跑）
 *
 * 状态说明：executingBash 是 core 模块级 per-session Map（不进 messages）；bashStartEffect /
 * bashResultEffect 哨兵分支均不解构使用 ctx，传最小 fake ctx 即可驱动真实 effect 代码路径。
 */
describe('MessageStream executing bash 瞬时行（[u6a] ActivityStrip bash 行）', () => {
  /** 最小 fake ctx：两个帧 handler 的目标分支都不触碰 ctx 字段（bashAborted 分支不使用 ctx） */
  const fakeCtx = { messages: undefined, applyEntryFrame: undefined } as unknown as MessageEffectContext

  /** 清残留（模块级 Map 跨用例共享，bashAborted 帧幂等清除） */
  function clearExecutingBash(sid: string): void {
    bashEffects['message.bashAborted']?.(fakeCtx, sid, { sessionId: sid, timestamp: 0 })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    clearExecutingBash('sess-exec-bash')
  })

  it('W4-E1: bashStart 置位 → bash 行出现（方案 A：前缀 + elapsed，命令在悬停详情）；bashResult 到达 → 行消失', async () => {
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
    // 方案 A 行内形态：i18n 前缀（renderer 测试 t() 从 zh-CN locale 真实取值）+ elapsed mono
    // meta。timestamp:1 → elapsed 恒为巨大时长（formatDurationHms 的 Nh Nm Ns 形态），只宽松
    // 断言「已 + 数字」不断言具体数值；命令原文不内联（移入悬停详情）
    expect(row.text()).toContain('正在执行')
    expect(row.text()).toMatch(/已\s*\d+h/)
    expect(row.text()).not.toContain('npm test')
    // 旧渲染点清理：原 executing-bash-notice testid 不应再出现
    expect(wrapper.find('[data-testid="executing-bash-notice"]').exists()).toBe(false)

    // 方案 A 悬停详情：命令原文经 HoverCard portal 挂 body（手法同 ActivityStrip.test.ts 的
    // detail 用例——pointerenter 后 vi.waitFor 轮询断言 portal 内容，open-delay 150ms + 渲染
    // 完成即通过，CPU 忙时自适应延长，替代固定 260ms 盲等）
    await wrapper.find('[data-testid="activity-strip-text-bash"]').trigger('pointerenter')
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="activity-strip-detail-body-bash"]')?.textContent).toBe('npm test')
    })

    // bashAborted 到达（abort 兜底终态帧：只清执行态不产 entry）→ 行消失，无残留 spinner
    bashEffects['message.bashAborted']?.(fakeCtx, sid, { sessionId: sid, timestamp: 0 })
    await nextTick()
    expect(wrapper.find('[data-testid="activity-strip"]').exists()).toBe(false)

    wrapper.unmount()
    // portal 详情节点不随组件卸载自动移除（ActivityStrip.test.ts 同款收尾）
    document.querySelector('[data-testid="activity-strip-detail-bash"]')?.remove()
  })
})

// ═══════════ 来源节：MessageStream-subagent-force-working（前轮产物整体并入） ═══════════
// ══════════ 节 1/2 — 来源: MessageStream-subagent-force-working.test.ts ══════════

/**
 * 验证完整接线：虚拟 session id → subagentStore.isStreamingSubagent（窄口径，
 * running 且无轮终 result）→ toRenderItemsIncremental 的 forceWorking → 末位
 * turn.isStreaming → Turn prop。轮终 running-resumable（running + result）不再把
 * 虚拟 session 末位 turn 卡 streaming；真 running（无 result）仍显示 streaming。
 *
 * 与 turn-working.test.ts 的 R1-遗留-1 组分工：彼组断言 store 两口径派生值
 * （isStreamingSubagent / isRunning）与 useSessionActive 链；本组 mount 真实
 * MessageStream 锚定组件接线——forceWorking 若回退宽松 isRunning（修复前形态），
 * 轮终用例红（isStreaming 误 true）。
 *
 * virtua mock / 壳 deps mock 与 MessageStream-kind.test.ts 同款（该文件头有
 * 完整论证：happy-dom 无布局，Virtualizer stub 全量渲染 scoped slot）；简化版
 * virtua mock 工厂在 helpers/chat-stream-mount.ts，壳 mock 三连经
 * helpers/message-stream-shell-mount.ts 顶层注册。
 */

/** Turn stub：透出末位 turn.isStreaming（forceWorking 的接线终点，Turn prop 形态） */
const fwStubs = messageStreamStubs({
  name: 'Turn',
  props: { turn: { type: Object, required: true } },
  template: '<div data-testid="turn-stub" :data-streaming="String(turn.isStreaming)" />',
})

const MAIN_SID = 's-fw-main'
const SUB_ID = 'sub-fw-1'
const VIRTUAL_ID = subagentVirtualId(MAIN_SID, SUB_ID)

/** 消息工厂：role 缺省 assistant（本节聚焦 turn 末位 isStreaming 接线） */
const makeMsg = makeStreamMessageFactory('assistant')

/** 虚拟分区消息：历史拉取形态（user + assistant 均 complete——JSONL 读出 status 恒 complete） */
function virtualHistory(): Message[] {
  return [
    makeMsg({ id: 'u1', role: 'user', content: '任务' }),
    makeMsg({ id: 'a1', role: 'assistant', content: '本轮产出正文' }),
  ]
}

function makeSubagentRecord(overrides: Partial<SubagentRecord>): SubagentRecord {
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

function mountStreamFw(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: fwStubs },
    attachTo: document.body,
  })
}

async function mountAndReadStreaming(): Promise<string> {
  const wrapper = mountStreamFw(VIRTUAL_ID)
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()
  const turnStub = wrapper.find('[data-testid="turn-stub"]')
  expect(turnStub.exists()).toBe(true)
  const streaming = turnStub.attributes('data-streaming')
  wrapper.unmount()
  return streaming ?? ''
}

describe('MessageStream 虚拟 session forceWorking 接线（R1-遗留-1）', () => {
  beforeEach(() => {
    resetMessageStreamEnv()
    // 虚拟分区注入历史（fetchAndInject 形态：均 complete，streaming 态完全由 forceWorking 驱动）
    useChatStore().hydrate(VIRTUAL_ID, virtualHistory())
  })

  it('轮终 record（running + result，running-resumable）→ 末位 turn.isStreaming=false（不卡 streaming）', async () => {
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'idle', result: '本轮产出正文', stopReason: 'completed' })])
    expect(await mountAndReadStreaming()).toBe('false')
  })

  it('真 running record（无 result）→ 末位 turn.isStreaming=true（仍显示 working）', async () => {
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running' })])
    expect(await mountAndReadStreaming()).toBe('true')
  })

  it('主 session id（非虚拟）不受 subagent record 影响 → 末位 turn.isStreaming=false', async () => {
    // 主 session 分区注入同一形态消息；record 存在真 running 也不该经 forceWorking 传导
    useChatStore().hydrate(MAIN_SID, virtualHistory())
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running' })])

    const wrapper = mountStreamFw(MAIN_SID)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    // 主 session 的 streaming 判定走 assistant.status（complete）→ false（working 指示归
    // session 级 derivedStatus，不在 MessageStream forceWorking 域）
    const turnStub = wrapper.find('[data-testid="turn-stub"]')
    expect(turnStub.exists()).toBe(true)
    expect(turnStub.attributes('data-streaming')).toBe('false')
    wrapper.unmount()
  })
})

/**
 * u3-thinking（subagent-drawer-blank §7.3 + §6.3）：forceWorking 驱动 ActivityStrip 思考行。
 * MessageStream 新增 computed subagentThinking = forceWorking &&（无 turn || 末位
 * turn.assistants.length === 0），经 prop 传给真实 ActivityStrip（非 stub）——虚拟 session
 * 收不到 occupancy 帧（sessionPhase.turn 恒 idle），思考行完全由本 prop 驱动，DOM 断言
 * testid activity-strip-row-thinking。
 */
describe('MessageStream → ActivityStrip subagentThinking 接线（u3-thinking / §6.3）', () => {
  it('forceWorking=true + 分区仅 task 用户气泡（末位 turn 无 assistant）→ thinking 行出现', async () => {
    // 独立虚拟分区（hydrate 每 session 一次，outer beforeEach 已占 VIRTUAL_ID 名额）
    const sidB = subagentVirtualId(MAIN_SID, 'sub-fw-2')
    useChatStore().hydrate(sidB, [makeMsg({ id: 'u1', role: 'user', content: '任务' })])
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ subagentId: 'sub-fw-2', status: 'running' })])

    const wrapper = mountStreamFw(sidB)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('forceWorking=true + 末位 turn 有 assistant 消息 → 无 thinking 行', async () => {
    // outer beforeEach 已给 VIRTUAL_ID 注入 user + assistant 历史（末位 turn 有产出）
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running' })])

    const wrapper = mountStreamFw(VIRTUAL_ID)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('非 virtual session id → forceWorking 恒 false → 无 thinking 行（主会话零回归）', async () => {
    useChatStore().hydrate(MAIN_SID, virtualHistory())
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running' })])

    const wrapper = mountStreamFw(MAIN_SID)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

/**
 * 占位反例（D6）：③级派生视图的
 * 占位 assistant（content === SUBAGENT_OUTCOME_PLACEHOLDER，仅 result/error 双缺时出现）
 * 不算实质产出——思考行仍触发；真实 content（result/error 文本）= 有产出 → 熄灭。
 * drawer-blank T3 既有断言（上方「末位 turn 无 assistant → thinking 行出现」）不动。
 */
describe('MessageStream subagentThinking 占位反例（D6）', () => {
  beforeEach(resetMessageStreamEnv)

  it('末位 assistant 为占位（③级 result/error 双缺派生视图）→ thinking 行仍出现', async () => {
    const sidP = subagentVirtualId(MAIN_SID, 'sub-fw-ph')
    useChatStore().hydrate(sidP, [
      makeMsg({ id: 'u1', role: 'user', content: '任务' }),
      makeMsg({ id: 'a1', role: 'assistant', content: SUBAGENT_OUTCOME_PLACEHOLDER }),
    ])
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ subagentId: 'sub-fw-ph', status: 'running' })])

    const wrapper = mountStreamFw(sidP)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('末位 assistant 为真实 content（error 文本派生视图）→ thinking 行熄灭', async () => {
    const sidR = subagentVirtualId(MAIN_SID, 'sub-fw-real')
    useChatStore().hydrate(sidR, [
      makeMsg({ id: 'u1', role: 'user', content: '任务' }),
      makeMsg({ id: 'a1', role: 'assistant', content: '错误：模型不可用' }),
    ])
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ subagentId: 'sub-fw-real', status: 'running' })])

    const wrapper = mountStreamFw(sidR)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

// ══════════ 节 2/2 — 来源: SubagentDirectiveStream.test.ts ══════════

/**
 * 全链路（真实段）：core createUseChat 的会话级订阅 handler（subagent.directive 分支）→
 * renderer pinia chatStore（appendSubagentDirective）→ MessageStream 渲染 → SystemNotice
 * 定向气泡 DOM。唯一 mock：chatApi RPC 层（streamSubscribe 捕获 handler 供测试 emit 广播）
 * 与 MessageStream 的外围壳依赖（virtua / useChatViewDeps / useChat / useSidebar，
 * 对齐 MessageStream-kind.test.ts 模式）——数据与渲染链路全部真实。
 *
 * 覆盖：
 * - 匹配 sid 的 subagent.directive 广播 → 聊天流出现「@slug：text」定向气泡 DOM
 * - 不匹配 sid 的广播 → 不出现（ADR-0049 per-session 隔离，架构约定 7）
 */

/** stub 仅外围组件；SystemNotice 刻意不 stub——定向气泡 DOM 是断言对象 */
const dsStubs = {
  Turn: { name: 'Turn', template: '<div data-testid="turn-stub" />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div />' },
  TurnRail: { name: 'TurnRail', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

interface Fixture {  // oe-exempt:20261027:test:
  useChat: ReturnType<typeof createUseChat>
  chatStore: ReturnType<typeof useChatStore>
  subagentAction: ReturnType<typeof vi.fn>
  emit: (sid: string, m: ServerMessage) => void
  mountStreamDs: () => ReturnType<typeof mount>
  dispose: () => void
}

function makeFixture(sid: string): Fixture {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => useChatStore())!
  const chatApi = {
    send: vi.fn().mockResolvedValue(undefined),
    subagentAction: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    bash: vi.fn().mockResolvedValue(undefined),
    abortBash: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    streamSubscribe: vi.fn((s: string, h: (m: ServerMessage) => void) => {
      streamHandlers.set(s, h)
      return () => streamHandlers.delete(s)
    }),
  }
  const deps: UseChatDeps = {
    chatApi,
    writeSegments: vi.fn().mockResolvedValue(undefined),
    // pinia store → core ChatStoreInstance 的类型鸿沟 cast（renderer useChat.ts 同款，运行时等价）
    getChatStore: () => chatStore as unknown as ChatStoreInstance,
    getSessionStore: () => ({ applySnapshot: vi.fn() }),
    getLiveStateStore: () => ({ applyLiveState: vi.fn(), liveStateOf: () => undefined, removeLiveState: vi.fn() }),
    // [session-dead 第三环] warning 注入点（本用例不触发）
    toast: { error: vi.fn(), warning: vi.fn() },
    t: (k: string) => k,
    // [u3c] getCompactQueue 注入已随 useCompactQueue 退役摘除（UseChatDeps 无该成员）
  }
  const useChat = createUseChat(deps)
  return {
    useChat,
    chatStore,
    subagentAction: chatApi.subagentAction,
    emit: (s, m) => streamHandlers.get(s)?.(m),
    mountStreamDs: () =>
      mount(MessageStream, {
        props: { sessionId: sid },
        global: { stubs: dsStubs },
        attachTo: document.body,
      }),
    dispose: () => scope.stop(),
  }
}

function directiveMsg(sid: string, slug: string, text: string): ServerMessage {
  return {
    type: 'subagent.directive',
    payload: { sessionId: sid, subagentId: 'rec-1', slug, direction: 'user', text },
  } as ServerMessage
}

describe('subagent.directive live 广播 → 聊天流定向气泡（U2b 集成）', () => {
  beforeEach(() => {
    resetMessageStreamEnv()
    resetChatModuleStateForTest()
  })

  it('匹配 sid 的广播 → 聊天流出现「@slug：text」定向气泡 DOM', async () => {
    const sid = 'live-1'
    const f = makeFixture(sid)
    // 定向发送（真实分流链路：subagentAction 而非 send + 建立会话级订阅）
    const segments: Segment[] = [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: '汇报当前进度' },
    ]
    await f.useChat.send(sid, segments)
    expect(f.subagentAction).toHaveBeenCalledTimes(1)
    // runtime 广播到达（extension 留痕 entry 落盘后）
    f.emit(sid, directiveMsg(sid, 'build-api', '汇报当前进度'))
    await flushPromises()

    const wrapper = f.mountStreamDs()
    await nextTick()
    const bubble = wrapper.find('[data-testid="subagent-directive-bubble"]')
    expect(bubble.exists()).toBe(true)
    expect(bubble.find('[data-testid="subagent-directive-slug"]').text()).toBe('@build-api')
    expect(bubble.text()).toContain('汇报当前进度')
    // 定向消息不是对话回合：无 user 气泡 / turn 渲染（主 agent 无新 turn，§3.3.8）
    expect(wrapper.find('[data-testid="turn-stub"]').exists()).toBe(false)
    wrapper.unmount()
    f.dispose()
  })

  it('不匹配 sid 的广播 → 定向气泡不出现（per-session 隔离）', async () => {
    const sid = 'live-2'
    const f = makeFixture(sid)
    await f.useChat.send(sid, [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'hi' },
    ])
    // 伪造异 session 广播到达本 session handler（防御层 payload.sessionId 校验）
    f.emit(sid, directiveMsg('other-session', 'build-api', '串台消息'))
    await flushPromises()

    const wrapper = f.mountStreamDs()
    await nextTick()
    expect(wrapper.find('[data-testid="subagent-directive-bubble"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('串台消息')
    wrapper.unmount()
    f.dispose()
  })
})
