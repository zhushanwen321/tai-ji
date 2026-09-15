/**
 * session.exited 事件端到端测试 —— 进程退出反馈链路。
 *
 * 锁定 R1（进程退出时前端无 streamSubscription → message.error 静默丢弃）+
 *      R7（退出的 session 仍可点击，触发 restore→再崩溃循环）。
 *
 * 验证链路：transport.onMessage 注册的 routeInbound handler 收到 session.exited →
 *   1. chat store markSessionError（聊天流追加 error 消息 + 重置活跃态）
 *   2. session store markDead（status 置 dead）
 *   3. toast 提示（首行 reason）
 *
 * mock 策略：vi.hoisted 捕获 ws-client.onMessage 注册的 routeInbound handler，
 * 测试向其注入 ServerMessage。mock ipc/ws-client 避免 init() 真实连接。
 *
 * useConnection 有模块级 dispatcherInstalled/initialised 标志，每个用例需 resetModules +
 * 动态 import 重新加载，确保 dispatcher 在 init() 时重新安装（routeHandler 被捕获）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/session-exited.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import type { ServerMessage, SessionGroup } from '@taiji/shared'

// vi.hoisted 保证 mock 工厂在模块加载前就绪；resetModules 后重新加载 useConnection 时
// 仍走同一 mock 工厂（mock 在 hoisted 层注册，不受 resetModules 影响）
const mockHolder = vi.hoisted(() => {
  return {
    // 捕获 transport.on（ws-client.onMessage）注册的 routeInbound handler
    routeHandler: null as ((msg: ServerMessage) => void) | null,
    // ws-client.getState 返回的 ref。vi.hoisted 在 import 前执行，不能调 vue 的 ref，
    // 这里放 null，在 beforeEach 中用真正的 ref 替换（见 initMockState）。
    stateRef: null as ReturnType<typeof ref<string>> | null,
  }
})

// §10.2 D-1 后 useConnection 迁 core：dispatcher 经 core ws-client onMessage 注册。
// u1 实证：shim/桥不转发 mock，必须 mock core ws-client 叶子模块本身（按相对路径
// 直指 core 源文件解析到同一模块 ID）；u4 已删除 renderer lib/ws-client deprecated shim。
vi.mock('../../../core/src/transport/ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
  // getState 返回 mockHolder.stateRef（beforeEach 中用真正的 vue ref 初始化）
  getState: () => mockHolder.stateRef!,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: vi.fn((cb: (msg: ServerMessage) => void) => {
    mockHolder.routeHandler = cb
    return () => { mockHolder.routeHandler = null }
  }),
  onQueueDrop: vi.fn(() => () => {}),
}))

vi.mock('@/lib/ipc', () => ({
  getRuntimePort: vi.fn(async () => undefined),
  getRuntimePortOffset: vi.fn(async () => undefined),
  getRuntimeToken: vi.fn(async () => undefined),
  onRuntimePort: vi.fn(() => () => {}),
  onRuntimeRestarting: vi.fn(() => () => {}),
  onRuntimeFailed: vi.fn(() => () => {}),
  restartRuntime: vi.fn(async () => {}),
}))

// 动态 import 容器：beforeEach resetModules 后重新加载
let useConnection: typeof import('@/composables/useConnection').useConnection
let useChatStore: typeof import('@/stores/chat').useChatStore
let useSessionStore: typeof import('@/stores/session').useSessionStore
let useToast: typeof import('@/composables/useToast').useToast

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 强制 real api domains：本文件验证 ws 订阅链路（subscribe RPC / events.on），mock 门面
  //（vitest.config 默认 VITE_MOCK=true）会把 sessionApi.subscribe/chatApi.streamSubscribe
  // 换成不发 ws、不挂 events 的 stub，链路断言全部失效。resetModules 前设置，
  // 动态 import 时 api/index 的 isMock 按此求值
  vi.stubEnv('VITE_MOCK', 'false')
  // 重置 mock holder + useConnection 模块级状态
  mockHolder.routeHandler = null
  // 用真正的 vue ref 初始化（vi.hoisted 时 vue 未加载，只能在此创建）
  mockHolder.stateRef = ref('disconnected')
  vi.resetModules()

  // 重新加载模块（useConnection 的 dispatcherInstalled/initialised 归零）
  const conn = await import('@/composables/useConnection')
  useConnection = conn.useConnection
  useChatStore = (await import('@/stores/chat')).useChatStore
  useSessionStore = (await import('@/stores/session')).useSessionStore
  useToast = (await import('@/composables/useToast')).useToast

  // 初始化 session store 含一个 idle session
  const sessionStore = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's-exit', label: 'test', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
    ],
  }
  sessionStore.applySnapshot({ groups: [group] })
})

async function initAndConnect(): Promise<void> {
  mockHolder.stateRef.value = 'connecting'
  const { init } = useConnection()
  await init()
  mockHolder.stateRef.value = 'connected'
}

describe('session.exited 事件端到端反馈链路', () => {
  it('routeInbound 收到 session.exited → markSessionError + markDead + toast', async () => {
    await initAndConnect()
    expect(mockHolder.routeHandler).not.toBeNull()

    const chatStore = useChatStore()
    const sessionStore = useSessionStore()
    const { toasts } = useToast()

    // 注入 session.exited 消息
    const exitedMsg: ServerMessage = {
      type: 'session.exited',
      payload: { sessionId: 's-exit', code: 1, reason: 'Session process exited (code: 1)\n\nError: extension load failed' },
    }
    mockHolder.routeHandler!(exitedMsg)

    // 1. chat store：追加了 error 消息
    const msgs = chatStore.getMessages('s-exit')
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs.some((m) => m.role === 'assistant' && m.status === 'error')).toBe(true)
    const errMsg = msgs.find((m) => m.status === 'error')!
    expect(errMsg.content).toContain('extension load failed')

    // 2. session store：status 置 dead
    expect(sessionStore.list.find((s) => s.id === 's-exit')?.status).toBe('dead')

    // 3. toast：首行 reason
    expect(toasts.value.length).toBeGreaterThanOrEqual(1)
    const lastToast = toasts.value[toasts.value.length - 1]
    expect(lastToast.type).toBe('error')
    expect(lastToast.message).toContain('会话进程已退出')
    expect(lastToast.message).toContain('Session process exited') // 首行
  })

  it('session.exited 含多行 stderr 时 toast 只取首行', async () => {
    await initAndConnect()

    const { toasts } = useToast()
    const multiLineReason = `Session process exited (code: 1)\n\nError: node:sqlite not found\n    at loadExtension\n    at main`

    mockHolder.routeHandler!({
      type: 'session.exited',
      payload: { sessionId: 's-exit', code: 1, reason: multiLineReason },
    })

    const lastToast = toasts.value[toasts.value.length - 1]
    // toast 只含首行，不含 stack trace
    expect(lastToast.message).toContain('Session process exited')
    expect(lastToast.message).not.toContain('node:sqlite')
    expect(lastToast.message).not.toContain('at loadExtension')
  })

  it('session.exited 重置 chat 活跃态（流式中崩溃不复位 → UI 卡死）', async () => {
    await initAndConnect()

    const chatStore = useChatStore()
    // 模拟流式中：创建 streaming entity（取代 setStreaming(true)，isGenerating 从实体派生）
    chatStore.applyMessageEvent('s-exit', { type: 'message.message_start', payload: { sessionId: 's-exit', messageId: 'a-exit' } })
    expect(chatStore.isGenerating('s-exit')).toBe(true)

    mockHolder.routeHandler!({
      type: 'session.exited',
      payload: { sessionId: 's-exit', code: 1, reason: 'crashed' },
    })

    // 关键：isGenerating 复位（规则 #3，markSessionError → finalizeSession 收口 streaming entity）
    expect(chatStore.isGenerating('s-exit')).toBe(false)
  })

  it('session.exited 对未知 sessionId 仍 toast（兜底，防静默丢弃）', async () => {
    await initAndConnect()

    const { toasts } = useToast()
    const sessionStore = useSessionStore()
    const beforeCount = sessionStore.list.length

    mockHolder.routeHandler!({
      type: 'session.exited',
      payload: { sessionId: 'unknown-ghost', code: 0, reason: 'orphan exit' },
    })

    // markDead 对未知 session 是 no-op（列表不变）
    expect(sessionStore.list.length).toBe(beforeCount)
    // 但 toast 仍触发（不静默丢弃）
    expect(toasts.value.some((t) => t.message.includes('orphan exit'))).toBe(true)
  })

  it('session.exited 失效本地流订阅：旧 events handler 移除 + 恢复窗口/respawn 后重发 subscribe', async () => {
    await initAndConnect()
    // resetModules 后动态加载（与 useConnection/useMessageEffects 共享同一模块实例）
    const chatMod = await import('@/composables/features/chat/useChat')
    const events = await import('@taiji/core/transport/api')
    const { getSubscriptionState } = await import('../../../core/src/coordination/subscription-state')
    const wsSend = vi.mocked((await import('../../../core/src/transport/ws-client')).send)

    const chatStore = useChatStore()
    const sessionStore = useSessionStore()
    /** ws 上 session.subscribe RPC 发出次数（reply 无人回会 reject，不影响计数） */
    const subscribeCalls = () =>
      wsSend.mock.calls.filter((args) => (args[0] as { type?: string }).type === 'session.subscribe').length
    const dispatchStart = (messageId: string) =>
      events.dispatchSession('s-exit', {
        type: 'message.message_start',
        payload: { sessionId: 's-exit', messageId },
      })
    const flushAsync = () => new Promise((r) => setTimeout(r, 0))

    // 首次订阅（模拟用户首次 send 前的惰性订阅建立）：subscribe RPC 发出 + events handler 挂载
    chatMod.ensureStreamSubscription('s-exit', chatStore, sessionStore)
    await flushAsync()
    expect(subscribeCalls()).toBe(1)
    dispatchStart('m1')
    await nextTick()
    expect(chatStore.isGenerating('s-exit')).toBe(true)

    // pi 死亡
    mockHolder.routeHandler!({
      type: 'session.exited',
      payload: { sessionId: 's-exit', code: 1, reason: 'crashed' },
    })

    // invalidateStreamSubscription 已执行：旧订阅状态清除 + 旧 events handler 移除。
    // [T4 回流修复] 随后恢复窗口订阅立即重发 subscribe（第 2 次）——成为恢复后新 bus entry
    // 的订阅者，restored live 可达；subscriptionStates 留 subscribed=false 意图条目。
    // （subscribe RPC 发出经 subscribeImpl 的动态 import microtask，先 flush 再断言）
    await flushAsync()
    expect(subscribeCalls()).toBe(2)
    expect(getSubscriptionState('s-exit')).toMatchObject({ subscribed: false })
    // isGenerating 已由 markSessionError 复位（前述用例锁定），dispatch m2 验证旧 handler 缺位
    //——若旧 handler 仍在，message_start 会重新点亮 streaming 态
    dispatchStart('m2')
    await nextTick()
    expect(chatStore.isGenerating('s-exit')).toBe(false)

    // respawn 后再次 ensure：不被 streamSubscriptions 幂等守卫短路，重挂 handler +
    // 重发 subscribe（第 3 次；subscriptionStates 幂等守卫对 subscribed=false 不拦截）
    chatMod.ensureStreamSubscription('s-exit', chatStore, sessionStore)
    await flushAsync()
    expect(subscribeCalls()).toBe(3)

    // 新 events handler 生效：dispatch message_start 驱动 streaming 态
    dispatchStart('m3')
    await nextTick()
    expect(chatStore.isGenerating('s-exit')).toBe(true)
  })
})
