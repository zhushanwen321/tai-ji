/**
 * [session-dead 结构性修复 D3] forceQuit 队列回收 —— core 侧重投状态清理行为测试。
 *
 * 锁定 createUseChat 返回面新增的 clearDeferFlushRetryTimer（D3 消费方 = renderer
 * useSidebarSessionActions.onForceQuitSession 编排）：
 * - D3-1 清掉已 armed 的 1s 重投 timer（flushDeferQueueAfterIdle 的 S1 拒绝重投脉冲不再开火）
 * - D3-2 同步清连续失败计数：清理后失败序列从零起算，达阈值的一次性熔断提示（deferFlushStalled）
 *   不被历史计数提前触发
 * - D3-3 回归锚：disposeSession 既有清理行为不变（timer 随 dispose 失效）
 *
 * 队列清空/草稿回收/追加三行为的 renderer 侧覆盖见
 * renderer __tests__/composables/panel/use-compact-queue.test.ts（drain）、
 * __tests__/sidebar/force-quit-queue-recovery.test.ts（编排）、
 * __tests__/panel/force-quit-draft-recovery-dom.test.ts（V1② 草稿可见 + 追加）。
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/force-quit-defer-recovery.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { ServerMessage } from '@xyz-agent/shared'
import { createChatStore } from '../store'
import { createUseChat, resetChatModuleStateForTest, ensureStreamSubscription } from '../useChat'
import type { UseChatDeps, EnsureStreamSubDeps } from '../useChat'

/** occupancy idle 帧（flush 触发源：handleSessionOccupancy 的三维 idle 判定） */
function occupancyIdle(sid: string): ServerMessage {
  return {
    type: 'session.occupancy',
    payload: { sessionId: sid, turn: 'idle', compacting: false, bash: false },
  } as ServerMessage
}

interface Fixture {
  useChat: ReturnType<typeof createUseChat>
  flush: ReturnType<typeof vi.fn>
  toast: { error: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> }
  emit: (sid: string, m: ServerMessage) => void
  dispose: () => void
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => createChatStore())!
  // S1 拒绝形态：flush resolve false（条目留队 → 计数 + arm 重投 timer）
  const flush = vi.fn().mockResolvedValue(false)
  const compactQueue = {
    flush,
    enqueue: vi.fn(),
    peek: vi.fn(() => [] as Array<{ id: string; text: string }>),
    hasPending: vi.fn(() => true),
    confirmDelivery: vi.fn(() => false),
  }
  const chatApi = {
    send: vi.fn().mockResolvedValue(undefined),
    subagentAction: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    bash: vi.fn().mockResolvedValue(undefined),
    abortBash: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ messages: [], historyTruncated: false }),
    getFullHistory: vi.fn().mockResolvedValue([]),
    streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
      streamHandlers.set(sid, h)
      return () => {
        streamHandlers.delete(sid)
      }
    }),
  }
  const toast = { error: vi.fn(), warning: vi.fn() }
  const deps: UseChatDeps = {
    chatApi,
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => ({ applySnapshot: vi.fn(), revive: vi.fn() }),
    toast,
    t: (k: string) => k,
    getCompactQueue: () => compactQueue,
  }
  const useChat = createUseChat(deps)
  // 按需建立会话级订阅（对齐 useChat.test.ts：捕获 handler 供 emit 驱动 session.* 帧；
  // ensureStreamSubscription 幂等——同 sid 重复调用 no-op）
  const subDeps: EnsureStreamSubDeps = {
    chatApi,
    toast,
    t: deps.t,
    getCompactQueue: () => compactQueue,
  }
  return {
    useChat,
    flush,
    toast,
    emit: (sid, m) => {
      ensureStreamSubscription(sid, chatStore, deps.getSessionStore(), subDeps)
      streamHandlers.get(sid)?.(m)
    },
    dispose: () => scope.stop(),
  }
}

/** 等待 flush promise 的 then 链跑完（微任务两层：flush().then + 内部分支） */
async function settleFlushChain(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('forceQuit 队列回收 —— core 重投状态清理（session-dead D3）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetChatModuleStateForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('D3-1: 清掉已 armed 的 1s 重投 timer——clear 后不再重投（未清理的对照 sid 照常重投）', async () => {
    const f = makeFixture()

    // 两个 session 各自经历一次 S1 拒绝（flush false）→ 各 arm 一个 1s 重投 timer
    f.emit('s-clear', occupancyIdle('s-clear'))
    f.emit('s-keep', occupancyIdle('s-keep'))
    await settleFlushChain()
    expect(f.flush).toHaveBeenCalledTimes(2)
    f.flush.mockClear()

    // D3 编排点：clear s-clear 的重投状态（经 createUseChat 返回面）
    f.useChat.clearDeferFlushRetryTimer('s-clear')

    // 越过重投窗口：s-clear 的 timer 已清不再 fire；s-keep 的 timer 照常 fire 重投
    vi.advanceTimersByTime(2000)
    await settleFlushChain()
    const calls = f.flush.mock.calls.map((c) => c[0])
    expect(calls).toEqual(['s-keep'])
    f.dispose()
  })

  it('D3-2: 同步清连续失败计数——清理后失败序列从零起算，历史计数不提前触发熔断提示', async () => {
    const f = makeFixture()
    const SID = 's1'

    // S1 拒绝 → 1s 重投 → 再拒绝 → …（单次触发源 + 连续重投窗口）：连续 5 次失败
    // 恰达阈值触发一次熔断提示，此后停 timer 自驱重投
    f.emit(SID, occupancyIdle(SID))
    await settleFlushChain()
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1000)
      await settleFlushChain()
    }
    expect(f.flush).toHaveBeenCalledTimes(5)
    expect(f.toast.warning).toHaveBeenCalledTimes(1)
    expect(f.toast.warning).toHaveBeenCalledWith('composable.deferFlushStalled')

    // D3 编排点：clear（清 timer + 失败计数）→ 新一轮触发源：计数从零起算，不触发提示
    f.useChat.clearDeferFlushRetryTimer(SID)
    f.toast.warning.mockClear()

    f.emit(SID, occupancyIdle(SID))
    await settleFlushChain()
    vi.advanceTimersByTime(1000)
    await settleFlushChain()
    // 新一轮第 2 次 flush（失败计数 = 2 ≪ 阈值 5）：无提示，重投 timer 照常 re-arm
    expect(f.flush).toHaveBeenCalledTimes(7)
    expect(f.toast.warning).not.toHaveBeenCalled()
    f.dispose()
  })

  it('D3-3: 回归锚——disposeSession 既有清理行为不变（arm 后 dispose，重投不开火）', async () => {
    const f = makeFixture()
    const SID = 's-dispose'

    f.emit(SID, occupancyIdle(SID))
    await settleFlushChain()
    expect(f.flush).toHaveBeenCalledTimes(1)

    f.useChat.disposeSession(SID)
    f.flush.mockClear()

    vi.advanceTimersByTime(2000)
    await settleFlushChain()
    expect(f.flush).not.toHaveBeenCalled()
    f.dispose()
  })

  it('u10/G4: disposeSession 清连续失败计数——重开后的新失败序列从零起算（残留计数会让首次重开即熔断）', async () => {
    const f = makeFixture()
    const SID = 's-dispose-count'

    // 预置 4 次连续失败（恰差一次到阈值 5）：若 disposeSession 不清计数，重开后首次失败即达 5 触发熔断提示
    f.emit(SID, occupancyIdle(SID))
    await settleFlushChain()
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000)
      await settleFlushChain()
    }
    expect(f.flush).toHaveBeenCalledTimes(4)
    expect(f.toast.warning).not.toHaveBeenCalled()

    // session 销毁（清 timer + 连续失败计数；重开 = ensureStreamSubscription 重建订阅）
    f.useChat.disposeSession(SID)

    // 重开后的新失败序列：4 次不熔断（计数从零起算；若残留，第 1 次即恰达阈值触发提示）
    f.emit(SID, occupancyIdle(SID))
    await settleFlushChain()
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000)
      await settleFlushChain()
    }
    expect(f.toast.warning).not.toHaveBeenCalled()

    // 第 5 次恰达阈值 → 一次熔断提示（证明重开序列完整、非重投链断裂的假绿）
    f.emit(SID, occupancyIdle(SID))
    await settleFlushChain()
    expect(f.toast.warning).toHaveBeenCalledTimes(1)
    expect(f.toast.warning).toHaveBeenCalledWith('composable.deferFlushStalled')
    f.dispose()
  })
})
