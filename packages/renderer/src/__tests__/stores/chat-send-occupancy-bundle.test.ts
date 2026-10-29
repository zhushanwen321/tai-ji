/**
 * useChat send/occupancy 集成域合并产物（round 6 renderer 测试压缩）：两文件同产物，
 * 环境默认（happy-dom；两原文件均默认环境）。
 *
 * 并入来源（基名）：
 *  - chat-integration-send（send 全链 + 失败回滚 + editAndResend + Composer DOM 断言，7 例）
 *  - chat-occupancy-phase（session.occupancy 帧 → sessionPhase 派生视图 + grep 断言，8 例）
 *
 * mock 注册与互斥核查：
 *  - 两原文件各自 vi.mock('@/api') 砍成员工厂（成员集不同）——同 spec 双工厂互斥，
 *    统一为 spread actual + 覆写并集成员（project.load/save、chat 七方法、file.read、
 *    session 五方法、config 三方法）；门面其余域走真 mockApi（VITE_MOCK），两节原
 *    砍成员版未提供的域（quota/extension/...）用例本就不触，真成员在场无害。
 *  - streamSubscribe 覆写为双 holder 捕获（integration 的 apiMock.holder +
 *    occupancy 的 streamCbHolder 同写）：两节各自 beforeEach 清己方 holder，
 *    对侧残留由其 beforeEach 兜底，无跨节污染。
 *  - occupancy 原工厂的 chat.send = sendMock（保留）；steer/submitDelivery 等并集成员
 *    全部走共享 vi.fn。occupancy 节的 streamSubscribeMock 仅剩 beforeEach 清计数
 *    （工厂不再引用，无断言面）。
 *  - integration mock useNewTaskFlow / useToast（砍成员）+ composer 域 spread——
 *    occupancy 节经真实 useChat 消费链不触这三者。
 *  - 两文件级 beforeEach（pinia + 各自 holder/mock 清理）已下沉进各自 describe。
 *  - occupancy 的 grep 断言（setCompacting 双轨）经 __dirname 相对路径扫生产源码——
 *    产物与原文件同目录（src/__tests__/stores/），路径不变。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/stores/chat-send-occupancy-bundle.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerMessage } from '@taiji/shared'
import { textToSegments, normalizeContent } from '@taiji/shared'
import { walkFiles } from '../helpers/walk-files'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'
import Composer from '@/components/panel/Composer.vue'

type StreamCb = (msg: ServerMessage) => void

// ── integration 节的 api 替身（hoisted；streamSubscribe 双 holder 见统一工厂）──
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => { holder.handler = null }
    }),
    send: vi.fn(() => Promise.resolve()),
    // [u3c/D1] 统一提交入口（core submitSegments → delivery.submit）
    submitDelivery: vi.fn(() =>
      Promise.resolve({ clientUuid: 'u-mock', state: 'in-flight' as const, lane: 'direct' as const }),
    ),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  }
})

// ── occupancy 节的替身（hoisted）──
const { streamCbHolder, streamSubscribeMock } = vi.hoisted(() => ({
  streamCbHolder: { current: null as StreamCb | null },
  streamSubscribeMock: vi.fn((_sid: string, _cb: StreamCb) => () => {}),
}))
const sendMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

// ── 统一 @/api 工厂：spread actual + 两原文件覆写成员并集 ──
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return {
    ...actual,
    project: {
      ...actual.project,
      load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }),
    },
    chat: {
      ...actual.chat,
      streamSubscribe: (sid: string, handler: (msg: ServerMessage) => void) => {
        apiMock.holder.handler = handler
        streamCbHolder.current = handler
        return () => {
          apiMock.holder.handler = null
          streamCbHolder.current = null
        }
      },
      send: (...args: unknown[]) => sendMock(...(args as [])),
      steer: vi.fn(() => Promise.resolve()),
      submitDelivery: apiMock.submitDelivery,
      getHistory: apiMock.getHistory,
      abort: apiMock.abort,
      compact: apiMock.compact,
      followUp: apiMock.followUp,
    },
    file: {
      ...actual.file,
      read: vi.fn(() => Promise.resolve({ content: '', truncated: false })),
    },
    session: {
      ...actual.session,
      subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      writeSegments: vi.fn().mockResolvedValue(undefined),
      // useModel.setThinkingLevel 依赖（thinking-level-sync watch 在 mount 时触发）
      setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })),
      // W4b：useBtwTabData badge 数据源（session.list {surface:'btw'}，btw 线进通用列表）
      listSessions: vi.fn().mockResolvedValue([]),
    },
    config: {
      ...actual.config,
      getGlobalSkills: vi.fn().mockResolvedValue([]),
      getProjectSkills: vi.fn().mockResolvedValue([]),
      onSkillCacheInvalidated: () => () => {},
    },
  }
})

// mount(Composer) 用例：mock 较深依赖（useChat 保留真实，验证 send 全链行为）
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    submitFirstMessage: vi.fn(),
    currentModel: { value: null },
    currentCwd: { value: null },
    setPendingModel: vi.fn(),
  }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ toasts: { value: [] }, error: vi.fn(), remove: vi.fn() }),
}))
// useComposerModelThinking 实装已迁 core（@taiji/core/domain/composer，composer 迁移）；
// 部分 mock 注入与 composer-shell-model-toast.test.ts 同款：importOriginal 保其余导出实装，
// stub 面覆盖 composer-shell 消费的全部返回字段（switching 等——缺字段在 Composer 渲染 computed 炸）
vi.mock('@taiji/core/domain/composer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { ref } = await import('vue')
  return {
    ...actual,
    useComposerModelThinking: () => ({
      currentModelId: ref(''),
      currentThinkingLevel: ref(undefined),
      currentThinkingLevelMap: ref(undefined),
      currentSupportedLevels: ref(undefined),
      localThinkingLevel: ref(undefined),
      switching: ref(null),
      onModelSelect: vi.fn(),
      onThinkingSelect: vi.fn(),
      enterStagingMode: vi.fn(),
      exitStagingMode: vi.fn(),
      getStagingConfig: vi.fn(() => null),
    }),
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：chat-integration-send
// ─────────────────────────────────────────────────────────────────────────────

// ── Composer 子组件 stub（参照 composer-three-states.test.ts，最小化 mount 开销）──
// getSegments 通过 emits 验证器捕获 input payload，用 textToSegments 还原（ADR-0043）。
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: {
    input: (val: string) => {
      lastInputText.value = val
      return true
    },
    keydown: null,
    'slash-trigger': null,
    'file-trigger': null,
  },
  setup(_, { expose }) {
    expose({ clear: vi.fn(), setText: vi.fn(), insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value) })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})
const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherStubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

const integrationBeforeEach = () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMock.holder.handler = null
  lastInputText.value = ''
}

function emit(msg: ServerMessage): void {
  if (apiMock.holder.handler) apiMock.holder.handler(msg)
}

describe('T1.4 useChat.send 全链', () => {
  beforeEach(integrationBeforeEach)

  it('send(text) → appendUser + addPendingSend + api.send → message_start → clearPendingSend', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-fullchain', textToSegments('hello'))
    // 1. appendUser：消息列表有 user 气泡
    const msgs = chat.getMessages('s-fullchain')
    expect(msgs.some((m) => m.role === 'user' && normalizeContent(m.content) === 'hello')).toBe(true)
    // 2. addPendingSend：isActive=true（空窗期）
    expect(chat.isActive('s-fullchain')).toBe(true)
    // 3. chatApi.submitDelivery 被调（[u3c/D1] 统一提交：图片走路径模式，promptText 二参，
    // 第三参 clientUuid = 乐观气泡 id；纯文本轮不加标记后缀（最小写入）；
    // [MF-1-2] 纯文本轮 segments 快照不上网（第五参 undefined——与 sidecar 同谓词门控））
    expect(apiMock.submitDelivery).toHaveBeenCalledWith(
      's-fullchain',
      'hello',
      msgs.find((m) => m.role === 'user')!.id,
      undefined,
      undefined,
    )
    // 4. message_start 到达 → clearPendingSend
    emit({ type: 'message.message_start', payload: { sessionId: 's-fullchain', messageId: 'a1' } })
    // message_start 后 isGenerating=true（streaming entity 存在），isActive 仍 true
    expect(chat.isGenerating('s-fullchain')).toBe(true)
    expect(chat.isActive('s-fullchain')).toBe(true)
  })
})

describe('T1.5 send 提交失败回滚', () => {
  beforeEach(integrationBeforeEach)

  it('submitDelivery reject → clearPendingSend（[W2] 不 throw，toast 消化错误）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    apiMock.submitDelivery.mockRejectedValueOnce(new Error('ws disconnected'))
    // [W2] send 失败不再 throw（与 followUp/abort 对齐：clearPendingSend + toast，不 throw）；
    // 失败信号经返回值传递（false = RPC 失败，调用方据此恢复草稿）
    await expect(send('s-fail', textToSegments('hello'))).resolves.toBe(false)
    // clearPendingSend：isActive 恢复 false（无 streaming entity + 无 pendingSend）
    expect(chat.isActive('s-fail')).toBe(false)
  })
})

describe('T5.1 editAndResend pendingSend 对称', () => {
  beforeEach(integrationBeforeEach)

  it('editAndResend → truncate + appendUser + addPendingSend + 统一提交', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit'
    const chat = useChatStore()
    // 先注入历史消息（供 truncateFrom 操作）
    chat.appendUser('s-edit', textToSegments('原问题'))
    const userMsg = chat.getMessages('s-edit').find((m) => m.role === 'user')!
    const { editAndResend } = useChat()
    // 阶段 3a：editAndResend 签名从 (sid, id, text: string) 改为 (sid, id, segments: Segment[])，
    // 内部委托 submitSegments（走 segmentsToPrompt + delivery.submit）。
    await editAndResend('s-edit', userMsg.id, textToSegments('edited text'))
    // [u3c/D1] submitDelivery 被调，第三参 clientUuid = 编辑重发的新乐观气泡 id
    // 纯文本轮不加 clientUuid 标记后缀（最小写入，与 send 同通路）
    const resentUserMsg = chat.getMessages('s-edit').filter((m) => m.role === 'user').at(-1)!
    expect(apiMock.submitDelivery).toHaveBeenCalledWith('s-edit', 'edited text', resentUserMsg.id, undefined, undefined)
    // addPendingSend：isActive=true（空窗期）
    expect(chat.isActive('s-edit')).toBe(true)
  })

  it('editAndResend 提交失败 → clearPendingSend（[W2] 不 throw，不留孤儿）', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit-fail'
    const chat = useChatStore()
    chat.appendUser('s-edit-fail', textToSegments('原问题'))
    const userMsg = chat.getMessages('s-edit-fail').find((m) => m.role === 'user')!
    apiMock.submitDelivery.mockRejectedValueOnce(new Error('ws disconnected'))
    const { editAndResend } = useChat()
    // [W2] editAndResend 失败不再 throw（与 followUp/abort 对齐）；false = RPC 失败信号
    await expect(editAndResend('s-edit-fail', userMsg.id, textToSegments('text'))).resolves.toBe(false)
    // 失败后 pendingSend 被清（isActive=false，无 streaming）
    expect(chat.isActive('s-edit-fail')).toBe(false)
  })

  it('editAndResend guard：busy 时早退（isActive=true 不执行）', async () => {
    const session = useSessionStore()
    session.activeId = 's-edit-busy'
    const chat = useChatStore()
    chat.addPendingSend('s-edit-busy')
    expect(chat.isActive('s-edit-busy')).toBe(true)
    const { editAndResend } = useChat()
    // busy 时早退：不 throw、不提交，返回 true（「无事发生」——早退无丢失风险，调用方不恢复草稿）
    await expect(editAndResend('s-edit-busy', 'msg-id', textToSegments('text'))).resolves.toBe(true)
    expect(apiMock.submitDelivery).not.toHaveBeenCalled()
  })
})

/**
 * [MANDATORY] 集成用例 DOM 断言：mount(Composer) 验证 send 全链/失败的用户可见行为。
 *
 * 走真实 useChat().send → Composer.onSend → store 状态驱动 DOM 三态渲染。
 * 断言用户可见 DOM（composer-box / stop-btn / 发送按钮）随 store 状态变化。
 */
describe('T1.4/T1.5 send 全链 Composer DOM 断言（用户可见行为）', () => {
  beforeEach(integrationBeforeEach)

  function mountComposer(sessionId: string) {
    return mount(Composer, { props: { sessionId }, global: { stubs: otherStubs } })
  }

  it('send 后 message_start 到达 → Composer 转停止按钮态（DOM 可见）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dom-start'
    // idle 态先挂载：显示发送按钮、无停止按钮
    const wrapper = mountComposer('s-dom-start')
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
    // 用户输入 → Enter 触发真实 useChat.send（走 mock api.send → resolve）
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '第一条消息')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    // flushPromises 排空全部 microtask（send 链路 + Vue render job），不依赖固定 nextTick 计数
    // ——U24/U25 onSend phase extraction（commit 8c9e2da43）的 async helper 包装使 render flush
    // 晚一个 microtask hop（详见 chat-send-rejected.test.ts 同注释）。
    await flushPromises()
    // message_start 到达 → isGenerating=true → isActive=true
    emit({ type: 'message.message_start', payload: { sessionId: 's-dom-start', messageId: 'a1' } })
    await flushPromises()
    // DOM 断言：停止按钮可见（用户可中断当前回合）
    expect(wrapper.find('.stop-btn').exists()).toBe(true)
  })

  it('send 失败后 Composer 回到可重试态（composer-box 可见 + 无停止按钮）', async () => {
    const session = useSessionStore()
    session.activeId = 's-dom-fail'
    const chat = useChatStore()
    // submitDelivery reject（useChat.send 内部 catch + clearPendingSend，[W2] 不 throw）
    apiMock.submitDelivery.mockRejectedValueOnce(new Error('ws disconnected'))
    const wrapper = mountComposer('s-dom-fail')
    // 用户输入 → Enter 触发 send
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '要发的消息')
    await wrapper.vm.$nextTick()
    wrapper.findComponent(ComposerInputMock).vm.$emit('keydown', new KeyboardEvent('keydown', { key: 'Enter' }))
    // flushPromises 排空全部 microtask（含 submitSegments await chatApi.submitDelivery 的 reject
    // + catch + clearPendingSend 后的 render flush），不依赖固定 nextTick 计数（同上注释）；
    // 单次调用即排空 store 状态与 DOM 渲染两阶段，无需二次冲洗
    await flushPromises()
    // store 侧：pendingSend 已清，无 streaming → isActive=false（用户可重试）
    expect(chat.isActive('s-dom-fail')).toBe(false)
    // DOM 断言 1：composer-box 仍渲染（输入区未消失）
    expect(wrapper.find('[data-testid="composer-box"]').exists()).toBe(true)
    // DOM 断言 2：无停止按钮（非活跃态，用户可重新发送）
    expect(wrapper.find('.stop-btn').exists()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 来源节：chat-occupancy-phase（原文件级 beforeEach 已下沉进各 describe）
// ─────────────────────────────────────────────────────────────────────────────

const occupancyBeforeEach = () => {
  setActivePinia(createPinia())
  streamCbHolder.current = null
  streamSubscribeMock.mockClear()
  sendMock.mockClear()
  resetChatModuleState()
}

/** 建立订阅（ensureStreamSubscription 经 send 触发，renderer 薄包装同 core handler） */
async function subscribe(sid: string): Promise<void> {
  await useChat().send(sid, textToSegments('trigger'))
  expect(streamCbHolder.current).not.toBeNull()
}

function occupancyMsg(sessionId: string, turn: 'idle' | 'dispatching' | 'generating' | 'settling', compacting: boolean, bash: boolean): ServerMessage {
  return { type: 'session.occupancy', payload: { sessionId, turn, compacting, bash } } as ServerMessage
}

describe('session.occupancy 帧 → sessionPhase 派生视图（D1）', () => {
  beforeEach(occupancyBeforeEach)

  it('turn 四态帧序列：dispatching → generating → settling → idle，派生视图逐步跟随', async () => {
    const chat = useChatStore()
    await subscribe('o1')

    streamCbHolder.current!(occupancyMsg('o1', 'dispatching', false, false))
    expect(chat.sessionPhase('o1')).toEqual({ turn: 'dispatching', compacting: false, bash: false })
    expect(chat.sessionPhase('o1').turn).toBe('dispatching')

    streamCbHolder.current!(occupancyMsg('o1', 'generating', false, false))
    expect(chat.sessionPhase('o1').turn).toBe('generating')

    // settling（D6：收尾不是活跃 turn——派生视图必须能表达，分发器据此 defer）
    streamCbHolder.current!(occupancyMsg('o1', 'settling', false, false))
    expect(chat.sessionPhase('o1').turn).toBe('settling')

    streamCbHolder.current!(occupancyMsg('o1', 'idle', false, false))
    expect(chat.sessionPhase('o1')).toEqual({ turn: 'idle', compacting: false, bash: false })
  })

  it('compacting 维度帧 → isCompacting（occupancy 派生，单一来源）+ sessionPhase 正交表达', async () => {
    const chat = useChatStore()
    await subscribe('o2')

    // 无 occupancy 记录 = 全 idle 缺省
    expect(chat.isCompacting('o2')).toBe(false)

    streamCbHolder.current!(occupancyMsg('o2', 'idle', true, false))
    expect(chat.isCompacting('o2')).toBe(true)
    expect(chat.sessionPhase('o2')).toEqual({ turn: 'idle', compacting: true, bash: false })

    // threshold 形态：generating + compacting 并存（D6 行 3 的派生视图前提）
    streamCbHolder.current!(occupancyMsg('o2', 'generating', true, false))
    expect(chat.isCompacting('o2')).toBe(true)
    expect(chat.sessionPhase('o2').turn).toBe('generating')

    // compaction_end 三路复位（含失败）→ compacting=false
    streamCbHolder.current!(occupancyMsg('o2', 'idle', false, false))
    expect(chat.isCompacting('o2')).toBe(false)
  })

  it('bash 维度帧 → sessionPhase.bash（renderer bash flag 从 occupancy 取得，D6 行 6 数据源）', async () => {
    const chat = useChatStore()
    await subscribe('o2b')

    streamCbHolder.current!(occupancyMsg('o2b', 'idle', false, true))
    expect(chat.sessionPhase('o2b')).toEqual({ turn: 'idle', compacting: false, bash: true })

    streamCbHolder.current!(occupancyMsg('o2b', 'idle', false, false))
    expect(chat.sessionPhase('o2b').bash).toBe(false)
  })

  it('session.compacting{reason} → reason 文案源保留（浮层消费方不受 membership 通路切换影响）', async () => {
    const chat = useChatStore()
    await subscribe('o3')

    // interpreter 同一挂点先发 session.compacting 再发 occupancy（帧序）
    streamCbHolder.current!({ type: 'session.compacting', payload: { sessionId: 'o3', status: 'compacting', reason: 'manual' } } as ServerMessage)
    streamCbHolder.current!(occupancyMsg('o3', 'idle', true, false))
    expect(chat.isCompacting('o3')).toBe(true)
    expect(chat.getCompactingReason('o3')).toBe('manual')

    // compacted → reason 清除（occupancy compacting=false 由下一帧驱动）
    streamCbHolder.current!({ type: 'session.compacted', payload: { sessionId: 'o3', status: 'compacted' } } as ServerMessage)
    expect(chat.getCompactingReason('o3')).toBeUndefined()
    streamCbHolder.current!(occupancyMsg('o3', 'idle', false, false))
    expect(chat.isCompacting('o3')).toBe(false)
  })
})

describe('occupancy 快照恢复（G4：重连 resubscribeAll / 切回 session）', () => {
  beforeEach(occupancyBeforeEach)

  it('回放帧序列收敛：压缩中状态从 stateSnapshot 回放恢复（V5 场景等价断言）', async () => {
    const chat = useChatStore()
    await subscribe('r1')

    // 重连/切回后 subscribe 的 stateSnapshot 回放最后一帧 occupancy{compacting:true}
    //（last-value 快照）——handler 与 live 同通路，派生视图收敛到帧值。
    streamCbHolder.current!(occupancyMsg('r1', 'idle', true, false))
    expect(chat.isCompacting('r1')).toBe(true)
    expect(chat.sessionPhase('r1')).toEqual({ turn: 'idle', compacting: true, bash: false })
  })

  it('重连快照回放 settle：占用中断连后回放 idle 帧 → 派生视图复位 + 空记录回落全 idle 缺省', async () => {
    const chat = useChatStore()
    await subscribe('r2')

    // 占用派生视图（断连前最后已知态）
    streamCbHolder.current!(occupancyMsg('r2', 'generating', true, false))
    expect(chat.isCompacting('r2')).toBe(true)

    // 重连回放：pi 已收尾，stateSnapshot 的 last-value 是 idle
    streamCbHolder.current!(occupancyMsg('r2', 'idle', false, false))
    expect(chat.isCompacting('r2')).toBe(false)
    expect(chat.sessionPhase('r2')).toEqual({ turn: 'idle', compacting: false, bash: false })
  })
})

describe('occupancy 帧不再触发投递（[u3c] renderer 侧投递时机职责已退役）', () => {
  beforeEach(occupancyBeforeEach)

  /**
   * [u3c 退役] 前身「occupancy idle × defer 队列非空 → flush 触发」用例随 defer 队列整体退役
   * （设计 §3.1 删除范围）：投递时机由 runtime 内核驱动（occupancy 边沿是内核 lane 再判定触发源），
   * renderer 不再持队列、不再触发 flush。本用例改为锁定「occupancy 帧只写派生视图、不产生任何提交
   * RPC」——旧触发路径不存在，正交确认其不复活。
   */
  it('occupancy 帧序列（settling/idle+bash/idle）→ 零提交 RPC，派生视图照常跟随', async () => {
    const chat = useChatStore()
    await subscribe('f1')
    sendMock.mockClear()
    chat.clearPendingSend('f1')

    streamCbHolder.current!(occupancyMsg('f1', 'settling', false, false))
    streamCbHolder.current!(occupancyMsg('f1', 'idle', false, true))
    streamCbHolder.current!(occupancyMsg('f1', 'idle', false, false))

    // 帧序列发完后统一排空全部微任务再断言负向（[R2-b15-F7]）：逐帧单微任务冲洗对
    // 「延迟提交」实现会假绿——flushPromises 排空后「零提交 RPC」才成立
    await flushPromises()

    // 派生视图跟随（帧驱动）而零提交 RPC：投递时机不在 renderer
    expect(chat.sessionPhase('f1')).toEqual({ turn: 'idle', compacting: false, bash: false })
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('setCompacting 双轨通路无残留（验收⑥，grep 断言）', () => {
  it('renderer + core 生产源码零 `.setCompacting(` 调用（通路废弃，u5b 收尾）', () => {
    const roots = [
      join(__dirname, '../../composables'),
      join(__dirname, '../../components'),
      join(__dirname, '../../stores'),
      join(__dirname, '../../../../core/src/domain/chat'),
      join(__dirname, '../../../../core/src/domain/composer'),
    ]
    const offenders: string[] = []
    for (const root of roots) {
      // 共享遍历 helper（__tests__/helpers/walk-files）：跳 __tests__/node_modules，收 .ts/.vue
      for (const file of walkFiles(root, { extensions: ['.ts', '.vue'], skipDirs: ['__tests__', 'node_modules'] })) {
        const content = readFileSync(file, 'utf-8')
        if (/\.setCompacting\(/.test(content)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
