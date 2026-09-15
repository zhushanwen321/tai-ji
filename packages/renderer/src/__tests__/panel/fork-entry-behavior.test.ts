/**
 * W2 入口 + 行为层红灯测试（TDD：实现缺失，测试必须 fail）。
 *
 * 覆盖 U7-U11：
 * - U7  首屏冒烟：streaming/pending 态每条 assistant 有 fork 后台 + fork 提问按钮
 * - U8  forkSession 后台 fork 不切焦点（activeId 不变，W2 fast-fork）
 * - U9  forkSessionAsk send 失败自动回滚（sessionApi.remove + removeFromList）
 * - U10 ForkNotice 反馈行 transient 渲染 + 查看降级（sessionDeleted 时纯文本不可点）
 * - U11 ForkConfirmModal 已删除（文件不存在 + Turn.vue 无 import）
 *
 * 红灯预期：W2 未实现，下列用例应全 fail（import 失败 / 门控未放宽 / 函数未新增 / 组件未删除）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/fork-entry-behavior.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { Message } from '@taiji/shared'
import { useToast } from '@/composables/useToast'

// useChat mock（Turn 编辑路径依赖；forkSessionAsk 复用其 ensureStreamSubscription/disposeSession）。
// disposeSession 用模块级 spy，让 U9 W7 断言可断言「回滚时被调」（拆流式订阅 + 清 store per-session 状态）。
// ensureStreamSubscription 导出作 no-op stub：U9 测回滚编排，不验真实流式订阅。
const disposeSessionMock = vi.fn()
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn(), disposeSession: disposeSessionMock }),
  ensureStreamSubscription: vi.fn(),
}))
vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

// [w6 chat-ui-and-shell T7] ui 包 Turn/TurnSummary 经 ChatViewDeps inject 消费 fork 回调
// （原 useTurnActions/useChat store 依赖失效）。U8/U9 测 useSidebar composable 层真实行为，保留；
// U7/盲区2 改为 deps 回调契约断言（toast 反馈已迁 renderer 壳 useChatViewDeps.onFork catch）。
import { Turn } from '@taiji/ui'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import { useChatStore } from '@/stores/chat'

/** 构造 assistant message（content 是 string，status 可控） */
function makeAssistant(over: Partial<Message> = {}): Message {
  return {
    id: over.id ?? 'a1',
    role: 'assistant',
    content: over.content ?? 'AI 回复内容',
    status: over.status ?? 'complete',
    timestamp: over.timestamp ?? Date.now(),
    ...over,
  } as Message
}

function makeTurn(assistants: Message[]): MessageTurn {
  return {
    index: 1,
    user: {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '问题' }],
      status: 'complete',
      timestamp: Date.now(),
    },
    assistants,
    isStreaming: false,
    hasFoldable: false,
  }
}

const onForkMock = vi.fn()
const onForkAskMock = vi.fn()

/**
 * mount Turn —— provide mock ChatViewDeps（fork 回调经 deps 注入，编排逻辑在 renderer 壳）。
 * 不新建 pinia：组件内 chat.isActive(sessionId) 必须读到 beforeEach 设置的同一 store。
 */
function mountTurn(turn: MessageTurn, sessionId = 's1') {
  return mount(Turn, {
    props: { turn, sessionId },
    global: {
      provide: mockChatProvide({ onFork: onForkMock, onForkAsk: onForkAskMock }),
      stubs: {
        Block: true,
        ChangeSetCard: true,
        MarkdownRenderer: true,
      },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  // 模块级 mock（disposeSessionMock）需跨用例清调用记录，避免 U9 断言被先前用例污染。
  vi.clearAllMocks()
  // useToast 是模块级单例，跨用例共享 → 清空残留 toast（U9-fail 断言 toasts 内容）。
  const { toasts } = useToast()
  toasts.value = []
})

// ── U7：首屏冒烟 —— summary action 行恒有 fork 按钮（W2 门控已放宽，ui 版无条件渲染） ────────
describe('U7 首屏冒烟：fork 按钮恒渲染（门控已放宽）', () => {
  it('每条 assistant 的 summary action 行有 fork 按钮（ui TurnSummary 无 isSessionActive 门控）', () => {
    const turn = makeTurn([makeAssistant({ id: 'a1', status: 'streaming' })])
    const wrapper = mountTurn(turn, 's-stream')
    // W2 放宽门控后 streaming 态也应有 fork 按钮（ui 版 fork 按钮恒在 summary action 行）
    const forkBtns = wrapper.findAll('button').filter((b) =>
      b.attributes('title')?.includes('分叉') || b.attributes('title')?.includes('fork'),
    )
    expect(forkBtns.length).toBeGreaterThan(0)
    // fork 统一为 fork-ask-btn（进 composer 模式），不再有独立的 fork-background-btn
    expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(true)
  })

  it('多条 assistant 消息时，summary action 行有 fork 后台 + fork 提问按钮（与复制同行）', () => {
    const turn = makeTurn([
      makeAssistant({ id: 'a1', content: '第一条回复' }),
      makeAssistant({ id: 'a2', content: '第二条回复' }),
    ])
    const wrapper = mountTurn(turn, 's-idle')
    // fork 统一为 fork-ask-btn（与复制/复制MD/handoff 并列同行）
    expect(wrapper.findAll('[data-testid="fork-background-btn"]').length).toBe(0)
    expect(wrapper.findAll('[data-testid="fork-ask-btn"]').length).toBe(1)
    // fork 按钮与复制按钮在同一容器（action 行，4 个并列按钮）
    const actionRow = wrapper.find('.turn-summary .mt-1\\.5')
    expect(actionRow.exists()).toBe(true)
    expect(actionRow.find('[data-testid="fork-ask-btn"]').exists()).toBe(true)
    expect(actionRow.findAll('button').length).toBe(4)
  })
})

// ── U8：forkSession 后台 fork 不切焦点（W2 fast-fork） ──────────────────────
// 历史背景：v1 forkSession 内部调 panel.split() 把 fork 切到 standby panel（切焦点）。
// v2 移除 split 后退化：openInStandby 选项保留为契约但行为恒为「不切焦点」（useForkActions.ts）。
describe('U8：forkSession 后台 fork 不切焦点（不切 activeId）', () => {
  it('fork 后台后焦点留在原 session（不切焦点）', async () => {
    // 直接对真实 useSidebar 行为做断言：forkSession 后 activeId 应保持不变。
    const { useSidebar } = await import('@/composables/features/sidebar/useSidebar')
    const sidebar = useSidebar()

    const sessionStore = (await import('@/stores/session')).useSessionStore()
    const sessionApi = (await import('@/api')).session

    // 准备一条可被 fork 的消息
    const chatStore = useChatStore()
    const sid = 's-fork-src'
    chatStore.hydrate(sid, [makeAssistant({ id: 'm1', piEntryId: 'e1' })])

    // mock fork RPC 返回新 session；先 append 进 sessionStore 让 selectSession 不炸
    const forked = { id: 'new-fork', label: 'fork', cwd: '/tmp' } as never
    vi.spyOn(sessionApi, 'fork').mockResolvedValue(forked)
    // 预注册新 session 到 store（appendSession 入组），并 mock switchSession 避免命中 mock runtime
    sessionStore.appendSession(forked)
    vi.spyOn(sessionApi, 'switchSession' as never).mockResolvedValue(undefined as never)
    vi.spyOn(sessionApi, 'getCommands' as never).mockResolvedValue({ commands: [] } as never)
    vi.spyOn(sessionApi, 'getContext' as never).mockResolvedValue({} as never)

    const beforeActive = sessionStore.activeId

    await sidebar.forkSession(sid, 'm1', { includeFrom: true, openInStandby: true })

    // activeId 不应变（后台 fork 不切焦点，W2 fast-fork）
    expect(sessionStore.activeId).toBe(beforeActive)
  })
})

// ── U9：forkSessionAsk send 失败自动回滚 ─────────────────────────────────
describe('U9：forkSessionAsk send 失败自动回滚（disposeSession + sessionApi.remove + removeFromList）', () => {
  it('fork 提问发送失败后不留空白分支（回滚清理）', async () => {
    const { useSidebar } = await import('@/composables/features/sidebar/useSidebar')
    const sidebar = useSidebar()

    const sessionApi = (await import('@/api')).session
    const sessionStore = (await import('@/stores/session')).useSessionStore()
    const removeSpy = vi.spyOn(sessionApi, 'remove').mockResolvedValue(undefined as never)
    const removeFromListSpy = vi.spyOn(sessionStore, 'removeFromList')

    // fork 成功（创建占位 session），但随后 send reject
    vi.spyOn(sessionApi, 'fork').mockResolvedValue({
      id: 'fork-placeholder',
      label: 'fork',
      cwd: '/tmp',
    } as never)
    const chatApi = (await import('@/api')).chat
    vi.spyOn(chatApi, 'send' as never).mockRejectedValue(new Error('send failed') as never)

    // [W1] forkSessionAsk 现在 rethrow 而非吞错 resolve（错误反馈职责上移到调用方）。
    // 资源清理（disposeSession + remove + removeFromList）仍在 catch 内 rethrow 前执行。
    await expect(sidebar.forkSessionAsk('s-src', 'm1', '追问内容')).rejects.toThrow('send failed')

    // 回滚三件套均被调（W7 补 disposeSession 断言：拆流式订阅 + 清 chat store per-session 状态）
    expect(disposeSessionMock).toHaveBeenCalledWith('fork-placeholder')
    expect(removeSpy).toHaveBeenCalledWith('fork-placeholder')
    expect(removeFromListSpy).toHaveBeenCalledWith('fork-placeholder')
  })
})

// ── U10：ForkNotice 反馈行 transient 渲染 + 查看降级 ─────────────────────
describe('U10：ForkNotice 反馈行（transient，非 banner）+ 查看降级', () => {
  // ForkNotice.vue 是 W2 新建组件，当前不存在 → import 失败（红灯）。
  // 用动态拼接的 specifier 让 Vite 不在构建期静态解析（否则整个文件 collection 失败），
  // 只让 U10 两个用例在运行期 import 时单独抛错失败。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noticePath = ('@/components' + '/panel/ForkNotice.vue') as any

  it('ForkNotice 渲染为反馈行（fork-notice class），含查看链接', async () => {
    const ForkNotice = (await import(noticePath)).default
    const wrapper = mount(ForkNotice, {
      props: { sessionDeleted: false },
      global: { plugins: [createPinia()] },
    })
    // 反馈行 class（区别于 banner）
    expect(wrapper.find('.fork-notice').exists()).toBe(true)
    expect(wrapper.find('.banner').exists()).toBe(false)
    // 含查看链接（可点击，session 未删）
    const viewLink = wrapper.find('[data-testid="fork-notice-view"]')
    expect(viewLink.exists()).toBe(true)
    expect(viewLink.attributes('disabled')).toBeFalsy()
  })

  it('sessionDeleted=true 时查看降级为纯文本不可点', async () => {
    const ForkNotice = (await import(noticePath)).default
    const wrapper = mount(ForkNotice, {
      props: { sessionDeleted: true },
      global: { plugins: [createPinia()] },
    })
    const viewLink = wrapper.find('[data-testid="fork-notice-view"]')
    // session 已删 → 查看降级为纯文本，不可点（无 role=button / disabled 或非 <a>/<button>）
    expect(viewLink.exists()).toBe(true)
    // 降级态：不应是可交互元素（无 role=button，或 aria-disabled）
    const interactive =
      viewLink.attributes('role') === 'button' ||
      viewLink.element.tagName === 'A' ||
      viewLink.element.tagName === 'BUTTON'
    expect(interactive).toBe(false)
  })
})

// ── U11：ForkConfirmModal 已删除 ─────────────────────────────────────────
describe('U11：ForkConfirmModal 已删除（文件不存在 + Turn.vue 无 import）', () => {
  it('ForkConfirmModal.vue 文件已不存在', () => {
    const modalPath = path.resolve(
      __dirname,
      '../../components/panel/message-stream/ForkConfirmModal.vue',
    )
    // 红灯：当前文件存在 → existsSync 返回 true → 断言 false 失败
    expect(fs.existsSync(modalPath)).toBe(false)
  })

  it('Turn.vue 源码不再 import ForkConfirmModal', () => {
    // [w6] Turn 已迁 ui 包（renderer 旧目录删除），检查 ui 包源码
    const turnPath = path.resolve(
      __dirname,
      '../../../../ui/src/features/chat/Turn.vue',
    )
    const source = fs.readFileSync(turnPath, 'utf-8')
    expect(source).not.toContain('ForkConfirmModal')
  })
})

// ── 盲区 2（renderer）：fork 触发回调契约（编排 + toast 反馈已迁 renderer 壳 useChatViewDeps） ──────────────────
describe('盲区 2：fork 按钮点击 → deps.onForkAsk 回调（编排在 renderer 壳）', () => {
  it('点 fork 按钮 → deps.onForkAsk(sessionId, message) 被调（统一进 composer 模式）', async () => {
    onForkAskMock.mockClear()
    const turn = makeTurn([makeAssistant({ id: 'a1', piEntryId: 'pi-a1' })])
    const wrapper = mountTurn(turn, 's-fork-ask')

    // fork 按钮统一为 fork-ask（进 composer 模式，可输入或空提交；空提交=后台 fork）
    await wrapper.find('[data-testid="fork-ask-btn"]').trigger('click')

    expect(onForkAskMock).toHaveBeenCalledWith('s-fork-ask', expect.objectContaining({ id: 'a1' }))
  })
})
