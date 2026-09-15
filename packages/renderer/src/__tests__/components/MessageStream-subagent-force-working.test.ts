/**
 * MessageStream 虚拟 session forceWorking 接线测试（review round2 R1-遗留-1）。
 *
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
 * 完整论证：happy-dom 无布局，Virtualizer stub 全量渲染 scoped slot）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/MessageStream-subagent-force-working.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatViewDepsModule } from '@/__tests__/helpers/chat-stream-mount'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { useSubagentStore, subagentVirtualId } from '@/stores/subagent'
import MessageStream from '@/components/panel/MessageStream.vue'
import { SUBAGENT_OUTCOME_PLACEHOLDER } from '@xyz-agent/shared'
import type { Message, SubagentRecord } from '@xyz-agent/shared'

vi.mock('virtua/vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { vi: vitest } = await import('vitest')
  return {
    Virtualizer: defineComponent({
      name: 'MockVirtualizer',
      props: {
        data: { type: Array, default: () => [] },
        // [U3 适配] 吸收 MessageStream U2 起的 :scroll-ref prop（chat-pin-bottom-fix D3），
        // 与 MessageStream-kind.test.ts mock 同款；不声明则落 reactive attrs 触发挂载期自渲染
        // （本文件无收集器断言，仅契约对齐消除 artifact 源头）。
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
        return h(
          'div',
          { class: 'mock-virtualizer' },
          (ctx.data as unknown[]).map((item, index) => ctx.$slots.default?.({ item, index }) ?? []),
        )
      },
    }),
  }
})

// 壳 deps mock（对齐 MessageStream-kind.test.ts：测试聚焦 forceWorking 接线不需真 deps）
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

// happy-dom 不提供真实 ResizeObserver 布局测量
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Turn stub：透出末位 turn.isStreaming（forceWorking 的接线终点，Turn prop 形态） */
const globalStubs = {
  Turn: {
    name: 'Turn',
    props: { turn: { type: Object, required: true } },
    template: '<div data-testid="turn-stub" :data-streaming="String(turn.isStreaming)" />',
  },
  SystemNotice: { name: 'SystemNotice', template: '<div />' },
  BashOutputBlock: { name: 'BashOutputBlock', template: '<div />' },
  ForkNotice: { name: 'ForkNotice', template: '<div />' },
  Button: { name: 'Button', template: '<button><slot /></button>' },
}

const MAIN_SID = 's-fw-main'
const SUB_ID = 'sub-fw-1'
const VIRTUAL_ID = subagentVirtualId(MAIN_SID, SUB_ID)

function makeMsg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    status: 'complete',
    timestamp: Date.now(),
    ...over,
  } as Message
}

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

function mountStream(sessionId: string) {
  return mount(MessageStream, {
    props: { sessionId },
    global: { stubs: globalStubs },
    attachTo: document.body,
  })
}

async function mountAndReadStreaming(): Promise<string> {
  const wrapper = mountStream(VIRTUAL_ID)
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
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
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

    const wrapper = mountStream(MAIN_SID)
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

    const wrapper = mountStream(sidB)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('forceWorking=true + 末位 turn 有 assistant 消息 → 无 thinking 行', async () => {
    // outer beforeEach 已给 VIRTUAL_ID 注入 user + assistant 历史（末位 turn 有产出）
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running' })])

    const wrapper = mountStream(VIRTUAL_ID)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('非 virtual session id → forceWorking 恒 false → 无 thinking 行（主会话零回归）', async () => {
    useChatStore().hydrate(MAIN_SID, virtualHistory())
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ status: 'running' })])

    const wrapper = mountStream(MAIN_SID)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

/**
 * 占位反例（D6 / docs/design/subagent-nonpi-visibility-followups.md §3.3）：③级投影的
 * 占位 assistant（content === SUBAGENT_OUTCOME_PLACEHOLDER，仅 result/error 双缺时出现）
 * 不算实质产出——思考行仍触发；真实 content（result/error 文本）= 有产出 → 熄灭。
 * drawer-blank T3 既有断言（上方「末位 turn 无 assistant → thinking 行出现」）不动。
 */
describe('MessageStream subagentThinking 占位反例（D6）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  it('末位 assistant 为占位（③级 result/error 双缺投影）→ thinking 行仍出现', async () => {
    const sidP = subagentVirtualId(MAIN_SID, 'sub-fw-ph')
    useChatStore().hydrate(sidP, [
      makeMsg({ id: 'u1', role: 'user', content: '任务' }),
      makeMsg({ id: 'a1', role: 'assistant', content: SUBAGENT_OUTCOME_PLACEHOLDER }),
    ])
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ subagentId: 'sub-fw-ph', status: 'running' })])

    const wrapper = mountStream(sidP)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('末位 assistant 为真实 content（error 文本投影）→ thinking 行熄灭', async () => {
    const sidR = subagentVirtualId(MAIN_SID, 'sub-fw-real')
    useChatStore().hydrate(sidR, [
      makeMsg({ id: 'u1', role: 'user', content: '任务' }),
      makeMsg({ id: 'a1', role: 'assistant', content: '错误：模型不可用' }),
    ])
    const sub = useSubagentStore()
    sub.applyRecords(MAIN_SID, [makeSubagentRecord({ subagentId: 'sub-fw-real', status: 'running' })])

    const wrapper = mountStream(sidR)
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="activity-strip-row-thinking"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
