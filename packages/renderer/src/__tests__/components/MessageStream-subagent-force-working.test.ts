/**
 * MessageStream 聊天流测试合并文件（波 2a 簇 4-2）。
 *
 * 节 1 — MessageStream-subagent-force-working：虚拟 session forceWorking 接线
 *        （review round2 R1-遗留-1；forceWorking → 末位 turn.isStreaming → Turn prop）。
 * 节 2 — SubagentDirectiveStream：subagent.directive live 广播 → 定向气泡 DOM
 *        （U2b 集成，§3.3.3a live 链路）。
 *
 * 合并说明：两节同壳（helpers/message-stream-shell-mount 顶层注册壳 mock 三连 +
 * virtua/vue 工厂去重为一份）。同名绑定按节重命名（globalStubs → fwStubs / dsStubs、
 * mountStream → mountStreamFw / mountStreamDs），describe/it 名零改动。
 * 各节 beforeEach 幂等（resetMessageStreamEnv），保持节内原样。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/components/MessageStream-subagent-force-working.test.ts --pool=threads
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import '@/__tests__/helpers/message-stream-shell-mount'
import { virtuaVueMockModule, messageStreamStubs, resetMessageStreamEnv, makeStreamMessageFactory } from '@/__tests__/helpers/chat-stream-mount'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, effectScope } from 'vue'
import { createUseChat, resetChatModuleStateForTest } from '@taiji/core'
import type { ChatStoreInstance, UseChatDeps } from '@taiji/core'
import type { ServerMessage, Segment, Message, SubagentRecord } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'
import { useSubagentStore, subagentVirtualId } from '@/stores/subagent'
import { SUBAGENT_OUTCOME_PLACEHOLDER } from '@taiji/shared'
import MessageStream from '@/components/panel/MessageStream.vue'

vi.mock('virtua/vue', () => virtuaVueMockModule())

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

interface Fixture {
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
