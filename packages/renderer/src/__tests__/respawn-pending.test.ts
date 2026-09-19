/**
 * respawn 过渡态端到端测试（T4 回流修复，Gate B 实测缺陷回归）。
 *
 * Gate B 实测：pi kill -9 后 runtime 3/3 自动恢复成功，但 renderer 0/3 出现 T4 提示条——
 * UI 立即进终态错误页（composer 卸载），session.restored 两条通路（live 定向推送 /
 * ring 回放）都不可达。修复后行为（本文件锁定）：
 * - 意外退出（非强制）→ respawnPending 过渡态（panel 派生保持 conversation 形态，
 *   composer 可用——恢复窗口发消息经 runtime join 送达的 UI 半边）+ 恢复窗口订阅
 *   （立即重发 subscribe，成为恢复后新 bus entry 的订阅者 → restored live 可达）；
 * - session.restored 到达 → 过渡态收口 + dead 复位 + 对话流插 T4 恢复提示条；
 * - session.restoreFailed：willRetry=true 保持过渡态；willRetry=false（熔断）→ 收口回
 *   终态 dead 页 + 失败提示条；
 * - 恢复超时（30s 无结果）→ 过渡态收口回终态（dead 已置，派生回 dead 占位）；
 * - 用户强制退出 → 直接终态（过渡态不出现，A7 反向验收）。
 *
 * mock 策略：与 session-exited.test.ts 同款（vi.hoisted 捕获 routeInbound handler 注入
 * ServerMessage；VITE_MOCK=false 强制真实 api domains；ws-client mock 捕获 send）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/respawn-pending.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'
import type { ServerMessage, SessionGroup } from '@taiji/shared'

const mockHolder = vi.hoisted(() => {
  return {
    routeHandler: null as ((msg: ServerMessage) => void) | null,
    stateRef: null as ReturnType<typeof ref<string>> | null,
  }
})

vi.mock('../../../core/src/transport/ws-client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
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

let useConnection: typeof import('@/composables/useConnection').useConnection
let useChatStore: typeof import('@/stores/chat').useChatStore
let useSessionStore: typeof import('@/stores/session').useSessionStore
let forcedExitMarks: typeof import('@/composables/effects/forced-exit-marks')

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.stubEnv('VITE_MOCK', 'false')
  mockHolder.routeHandler = null
  mockHolder.stateRef = ref('disconnected')
  vi.resetModules()

  const conn = await import('@/composables/useConnection')
  useConnection = conn.useConnection
  useChatStore = (await import('@/stores/chat')).useChatStore
  useSessionStore = (await import('@/stores/session')).useSessionStore
  forcedExitMarks = await import('@/composables/effects/forced-exit-marks')
  forcedExitMarks.resetForcedExitMarks()

  const sessionStore = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's-respawn', label: 'test', cwd: '/repo', status: 'idle', lastActiveAt: 100, modelId: 'm/x', tokenCount: 0 },
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

/** 意外退出注入（code: 1 = 崩溃形态；强制退出走 forced-exit-marks 标记区分，帧形状相同） */
function injectExited(sessionId = 's-respawn'): void {
  mockHolder.routeHandler!({
    type: 'session.exited',
    payload: { sessionId, code: 1, reason: 'Session process exited (code: 1)' },
  })
}

function injectRestored(sessionId = 's-respawn', attempts = 1): void {
  mockHolder.routeHandler!({
    type: 'session.restored',
    payload: { sessionId, attempts },
  })
}

function injectRestoreFailed(sessionId: string, willRetry: boolean): void {
  mockHolder.routeHandler!({
    type: 'session.restoreFailed',
    payload: { sessionId, attempts: 1, willRetry, reason: 'spawn failed' },
  })
}

describe('respawn 过渡态（T4 回流修复）', () => {
  it('① 意外退出 → 进过渡态（不进终态派生：composer 判据保持 conversation）', async () => {
    await initAndConnect()
    const chatStore = useChatStore()
    const sessionStore = useSessionStore()
    const { derivePanelView } = await import('@taiji/core')

    injectExited()

    // 过渡态分区置位（侧栏 status 仍 dead——置灰准确；panel 派生被 isSessionRespawning 抑制）
    expect(chatStore.isRespawnPending('s-respawn')).toBe(true)
    expect(sessionStore.list.find((s) => s.id === 's-respawn')?.status).toBe('dead')
    const view = derivePanelView({
      sessionId: 's-respawn',
      hasMessages: true,
      isSessionDead: sessionStore.list.find((s) => s.id === 's-respawn')?.status === 'dead',
      isSessionRespawning: chatStore.isRespawnPending('s-respawn'),
      isTraceView: false,
      hasFormOverlay: false,
      isFlowActive: false,
    })
    // conversation 形态 = Panel.vue Composer 渲染判据（dead 才卸载 composer）
    expect(view.kind).toBe('conversation')
  })

  it('② session.restored 到达 → 过渡态收口 + dead 复位 + T4 恢复提示条入流', async () => {
    await initAndConnect()
    const chatStore = useChatStore()
    const sessionStore = useSessionStore()

    injectExited()
    expect(chatStore.isRespawnPending('s-respawn')).toBe(true)

    injectRestored()
    expect(chatStore.isRespawnPending('s-respawn')).toBe(false)
    // dead 复位（revive：dead → idle）
    expect(sessionStore.list.find((s) => s.id === 's-respawn')?.status).toBe('idle')
    // T4 提示条（respawnRestored 文案经 appendRespawnNotice 入对话流）
    const msgs = chatStore.getMessages('s-respawn')
    const notice = msgs.find((m) => m.role === 'system' && (m.details as { variant?: string } | undefined)?.variant === 'restored')
    expect(notice).toBeDefined()
    expect(notice!.content.length).toBeGreaterThan(0)
  })

  it('③ restoreFailed：willRetry=true 保持过渡态；willRetry=false（熔断）收口回终态 + 失败提示条', async () => {
    await initAndConnect()
    const chatStore = useChatStore()
    const sessionStore = useSessionStore()

    injectExited()
    expect(chatStore.isRespawnPending('s-respawn')).toBe(true)

    // 第一次失败：runtime 自动续排，过渡态保持（防提示条闪烁）
    injectRestoreFailed('s-respawn', true)
    expect(chatStore.isRespawnPending('s-respawn')).toBe(true)
    expect(sessionStore.list.find((s) => s.id === 's-respawn')?.status).toBe('dead')

    // 第二次失败：熔断（willRetry=false）→ 收口过渡态，终态 dead 页保留「重新打开」
    injectRestoreFailed('s-respawn', false)
    expect(chatStore.isRespawnPending('s-respawn')).toBe(false)
    expect(sessionStore.list.find((s) => s.id === 's-respawn')?.status).toBe('dead')
    const msgs = chatStore.getMessages('s-respawn')
    const notice = msgs.find((m) => (m.details as { variant?: string } | undefined)?.variant === 'restoreFailed')
    expect(notice).toBeDefined()
  })

  it('④ 恢复窗口发消息不报错：composer 可用（①）+ message.send RPC 经 ws 发出（runtime join 半边见 runtime 单测）', async () => {
    await initAndConnect()
    const wsSend = vi.mocked((await import('../../../core/src/transport/ws-client')).send)
    const chatStore = useChatStore()

    injectExited()
    expect(chatStore.isRespawnPending('s-respawn')).toBe(true)

    // 过渡态（pending）下发送：UI 半边 = 无本地 dead 拦截，消息走既有发送编排链路发出
    //（runtime 侧 ensureActive join 等恢复完成后送达——该半边已有 runtime 单测）
    const { useChat } = await import('@/composables/features/chat/useChat')
    await expect(useChat().send('s-respawn', [{ type: 'text', text: 'hello during recovery' }])).resolves.toBeUndefined()
    const sentTypes = wsSend.mock.calls.map((args) => (args[0] as { type?: string }).type)
    expect(sentTypes).toContain('message.send')
  })

  it('⑤ 用户强制退出 → 直接终态（过渡态不出现，A7 反向验收）', async () => {
    await initAndConnect()
    const chatStore = useChatStore()
    const sessionStore = useSessionStore()

    // forceQuit RPC 发出前的意图标记（onForceQuitSession 同款时序）
    forcedExitMarks.markForcedExit('s-respawn')
    injectExited()

    expect(chatStore.isRespawnPending('s-respawn')).toBe(false)
    expect(sessionStore.list.find((s) => s.id === 's-respawn')?.status).toBe('dead')
    // 标记读后即清（一次意图只消费一次）
    expect(forcedExitMarks.consumeForcedExit('s-respawn')).toBe(false)
  })

  it('⑥ 恢复超时（30s 无 restored/restoreFailed）→ 过渡态收口回终态派生', async () => {
    vi.useFakeTimers()
    try {
      await initAndConnect()
      const chatStore = useChatStore()
      const sessionStore = useSessionStore()
      const { derivePanelView } = await import('@taiji/core')

      injectExited()
      expect(chatStore.isRespawnPending('s-respawn')).toBe(true)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(chatStore.isRespawnPending('s-respawn')).toBe(false)
      // dead 已置（exited 时），过渡态清除后派生回落 dead 占位（「重新打开」出口）
      const view = derivePanelView({
        sessionId: 's-respawn',
        hasMessages: true,
        isSessionDead: sessionStore.list.find((s) => s.id === 's-respawn')?.status === 'dead',
        isSessionRespawning: chatStore.isRespawnPending('s-respawn'),
        isTraceView: false,
        hasFormOverlay: false,
        isFlowActive: false,
      })
      expect(view.kind).toBe('dead')
    } finally {
      vi.useRealTimers()
    }
  })

  it('⑦ 手动重开（useSidebar.restoreSession）：restore RPC 成功即收口过渡态（手动路径无 restored 帧，本地收口兜底）', async () => {
    await initAndConnect()
    const chatStore = useChatStore()
    const sessionApiMod = await import('@/api')

    injectExited()
    expect(chatStore.isRespawnPending('s-respawn')).toBe(true)

    // spy restore RPC；后续 core 12 步切入链在本测试环境无 transport 会 reject——
    // 收口点在 selectSession 之前（restore RPC 成功即恢复事实成立），reject 不影响断言
    vi.spyOn(sessionApiMod.session, 'restoreSession').mockResolvedValue({ id: 's-respawn' } as never)
    const { useSidebar } = await import('@/composables/features/sidebar/useSidebar')
    const sidebar = useSidebar()
    await expect(sidebar.restoreSession('s-respawn')).rejects.toThrow()

    expect(chatStore.isRespawnPending('s-respawn')).toBe(false)
  })

  it('⑧ 恢复窗口发消息 → message_start 到达（join 路径无 restored 帧）→ 收口 + dead 复位 + T4 条（Gate B A7 缺陷回归）', async () => {
    // 缺陷复现链：kill → 1s 内发消息 → runtime 惰性恢复 join 先于 D7 timer 完成 →
    // timer fire「already active/restoring — skip auto respawn」→ session.restored 帧永不
    // 发布 → 过渡态无收口信号，30s 超时后回落 dead 终态页（用户被迫手动「重新打开」）。
    // 修复：恢复窗口内 message.start（新 pi 已在处理用户消息）经 useChat 收口 gate 收口。
    await initAndConnect()
    const chatStore = useChatStore()
    const sessionStore = useSessionStore()
    const events = await import('@taiji/core/transport/api')
    const { derivePanelView } = await import('@taiji/core')

    injectExited()
    expect(chatStore.isRespawnPending('s-respawn')).toBe(true)

    // 恢复窗口内发消息（send 建立订阅；runtime join 半边见用例④）
    const { useChat } = await import('@/composables/features/chat/useChat')
    await useChat().send('s-respawn', [{ type: 'text', text: 'hello during recovery' }])

    // 恢复完成（无 session.restored 帧）后新 pi 开始处理：message_start 经恢复窗口订阅到达
    events.dispatchSession('s-respawn', {
      type: 'message.message_start',
      payload: { sessionId: 's-respawn', messageId: 'm-join' },
    })
    await nextTick()

    // 过渡态收口 + dead 复位（用户不再见 dead 终态屏，无需手动「重新打开」）
    expect(chatStore.isRespawnPending('s-respawn')).toBe(false)
    expect(sessionStore.list.find((s) => s.id === 's-respawn')?.status).toBe('idle')
    // T4 恢复提示条入流（与 restored 帧路径同文案）
    const msgs = chatStore.getMessages('s-respawn')
    const notice = msgs.find((m) => m.role === 'system' && (m.details as { variant?: string } | undefined)?.variant === 'restored')
    expect(notice).toBeDefined()
    // 派生保持 conversation 形态（Panel.vue Composer 渲染判据，dead 占位不出现）
    const view = derivePanelView({
      sessionId: 's-respawn',
      hasMessages: true,
      isSessionDead: sessionStore.list.find((s) => s.id === 's-respawn')?.status === 'dead',
      isSessionRespawning: chatStore.isRespawnPending('s-respawn'),
      isTraceView: false,
      hasFormOverlay: false,
      isFlowActive: false,
    })
    expect(view.kind).toBe('conversation')
  })
})
