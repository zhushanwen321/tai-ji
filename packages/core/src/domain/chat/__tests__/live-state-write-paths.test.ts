/**
 * session 状态帧写入路径单测（会话架构四层分离 W0/W1：状态写入口唯一，无 sid 类别判据）。
 *
 * 锁定设计 §2.4 I2/I4 与 §7 验收项 2/5：
 * - `session.state_changed` / `session.thinkingLevelSet` 写**状态层**（按 sessionId 寄存），
 *   不再经导航列表命中（applySnapshot）——侧栏列表之外的会话 id（btw 线 session id、任意不在
 *   列表的 id）与主会话走同一个 apply 函数，无 `isBtwVirtualId` / hidden 分支；
 * - 导航列表不被状态帧触碰（列表只承载描述字段）；
 * - `session.renamed` 仍写导航列表（label 是展示字段）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/live-state-write-paths.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { textToSegments } from '@taiji/shared'
import type { Segment, ServerMessage } from '@taiji/shared'
import { createChatStore } from '../store'
import { createUseChat, resetChatModuleStateForTest } from '../useChat'
import type { UseChatDeps } from '../useChat'
import type { SessionLiveStateLike, SessionStoreLike } from '../use-chat-types'
import type { SessionLiveState } from '@taiji/core/domain/session'

interface Fixture { // oe-exempt:20261023:test:测试 harness 参数包（单文件局部，非架构契约）
  useChat: ReturnType<typeof createUseChat>
  sessionStore: SessionStoreLike & {
    applySnapshot: ReturnType<typeof vi.fn>
    revive: ReturnType<typeof vi.fn>
  }
  liveState: SessionLiveStateLike
  writeModel: (id: string, patch: { modelId?: string; thinkingLevel?: string }) => void
  emit: (sid: string, m: ServerMessage) => void
  dispose: () => void
}

/** 极简状态层替身（语义与 core createSessionLiveState 同形：字段级合并 + 缺失 undefined） */
function makeLiveState(): SessionLiveStateLike {
  const store = new Map<string, SessionLiveState>()
  return {
    applyLiveState: (id, patch) => {
      const prev = store.get(id) ?? {}
      const next: SessionLiveState = { ...prev }
      if (patch.modelId !== undefined) next.modelId = patch.modelId
      if (patch.thinkingLevel !== undefined) next.thinkingLevel = patch.thinkingLevel
      store.set(id, next)
    },
    liveStateOf: (id) => store.get(id),
    removeLiveState: (id) => {
      store.delete(id)
    },
  }
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => createChatStore())!
  const chatApi = {
    submitDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' }),
    send: vi.fn(),
    subagentAction: vi.fn(),
    abort: vi.fn(),
    compact: vi.fn(),
    bash: vi.fn(),
    abortBash: vi.fn(),
    getHistory: vi.fn(),
    streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
      streamHandlers.set(sid, h)
      return () => streamHandlers.delete(sid)
    }),
    revokeMessage: vi.fn(),
    cancelDelivery: vi.fn(),
  }
  const sessionStore = { applySnapshot: vi.fn(), revive: vi.fn() }
  const liveState = makeLiveState()
  const deps: UseChatDeps = {
    chatApi: chatApi as unknown as UseChatDeps['chatApi'],
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => sessionStore,
    getLiveStateStore: () => liveState,
    toast: { error: vi.fn(), warning: vi.fn() },
    t: (k: string) => k,
  }
  const useChat = createUseChat(deps)
  return {
    useChat,
    sessionStore,
    liveState,
    writeModel: (id, patch) => liveState.applyLiveState(id, patch),
    emit: (sid, m) => streamHandlers.get(sid)?.(m),
    dispose: () => scope.stop(),
  }
}

function frame(sid: string, type: string, payload: Record<string, unknown>): ServerMessage {
  return { type, id: `p_${type}`, payload: { sessionId: sid, ...payload } } as unknown as ServerMessage
}

const SEGMENTS: Segment[] = textToSegments('触发订阅')

describe('session 状态帧 → 状态层（无列表命中判据）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('侧栏列表之外的会话 id（btw 线 session id）收到 state_changed：状态层更新（验收项 2 核心）', async () => {
    const f = makeFixture()
    const sessionId = 'pi-line-1'
    await f.useChat.send(sessionId, SEGMENTS)

    f.emit(sessionId, frame(sessionId, 'session.state_changed', { modelId: 'p/line-model', thinkingLevel: 'low' }))

    // 状态层按 id 寄存：与主会话完全同一条路径
    expect(f.liveState.liveStateOf(sessionId)).toEqual({ modelId: 'p/line-model', thinkingLevel: 'low' })
    // 导航列表不再承载状态字段写入（唯一写入口是状态层）
    expect(f.sessionStore.applySnapshot).not.toHaveBeenCalled()
    f.dispose()
  })

  it('btw 线与主会话走同一个 apply 函数（无 isBtwVirtualId 分支，验收项 5）', async () => {
    const f = makeFixture()
    const main = 'main-s1'
    const sessionId = 'pi-line-2'
    await f.useChat.send(main, SEGMENTS)
    await f.useChat.send(sessionId, SEGMENTS)

    f.emit(main, frame(main, 'session.state_changed', { modelId: 'p/main' }))
    f.emit(sessionId, frame(sessionId, 'session.state_changed', { modelId: 'p/line' }))

    const applySpy = vi.spyOn(f.liveState, 'applyLiveState')
    f.emit(main, frame(main, 'session.thinkingLevelSet', { level: 'high' }))
    f.emit(sessionId, frame(sessionId, 'session.thinkingLevelSet', { level: 'high' }))
    // 同一签名、同一入口被调用两次（入参形状相同，仅 id 不同）
    expect(applySpy.mock.calls).toEqual([
      [main, { thinkingLevel: 'high' }],
      [sessionId, { thinkingLevel: 'high' }],
    ])
    f.dispose()
  })

  it('未知 id（既不在侧栏列表也无任何注册）：照样写入状态层，不静默丢弃', async () => {
    const f = makeFixture()
    const ghost = 'ghost-session'
    await f.useChat.send(ghost, SEGMENTS)

    f.emit(ghost, frame(ghost, 'session.state_changed', { modelId: 'p/ghost' }))
    expect(f.liveState.liveStateOf(ghost)).toEqual({ modelId: 'p/ghost' })
    f.dispose()
  })

  it('thinkingLevel 缺省时只写 modelId，已缓存档位保留（字段级合并）', async () => {
    const f = makeFixture()
    const sid = 's-merge'
    await f.useChat.send(sid, SEGMENTS)
    f.emit(sid, frame(sid, 'session.state_changed', { modelId: 'p/one', thinkingLevel: 'low' }))

    f.emit(sid, frame(sid, 'session.state_changed', { modelId: 'p/two', thinkingLevel: undefined }))
    expect(f.liveState.liveStateOf(sid)).toEqual({ modelId: 'p/two', thinkingLevel: 'low' })
    f.dispose()
  })

  it('thinkingLevelSet 单独更新档位，不影响 modelId', async () => {
    const f = makeFixture()
    const sid = 's-tl'
    await f.useChat.send(sid, SEGMENTS)
    f.emit(sid, frame(sid, 'session.state_changed', { modelId: 'p/model' }))

    f.emit(sid, frame(sid, 'session.thinkingLevelSet', { level: 'max' }))
    expect(f.liveState.liveStateOf(sid)).toEqual({ modelId: 'p/model', thinkingLevel: 'max' })
    f.dispose()
  })

  it('session.renamed 仍写导航列表（label 是展示字段，不进状态层）', async () => {
    const f = makeFixture()
    await f.useChat.send('s-rename', SEGMENTS)

    f.emit('s-rename', frame('s-rename', 'session.renamed', { name: '新名' }))
    expect(f.sessionStore.applySnapshot).toHaveBeenCalledWith('s-rename', { label: '新名' })
    expect(f.liveState.liveStateOf('s-rename')).toBeUndefined()
    f.dispose()
  })
})
