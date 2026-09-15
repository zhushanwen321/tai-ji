/**
 * useSessionStreamSync wave w1 测试（TC1-TC10）。
 *
 * - TC1-TC4：diffSessionList 纯函数（无 mock）。
 * - TC5-TC10：bindSessionStreamSync 集成（真实 Pinia store + mock useChat，effectScope 包裹）。
 *
 * 运行：cd packages/renderer && npx vitest run composables/effects/__tests__/useSessionStreamSync.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { diffSessionList } from '../useSessionStreamSync'
import type { SessionSummary } from '@taiji/shared'

/** 辅助：构造最小 SessionSummary（cast 补齐可选字段，测试代码可接受） */
function mkSession(id: string): SessionSummary {
  return { id, label: id, cwd: '/x', status: 'idle' } as SessionSummary
}

describe('diffSessionList', () => {
  it('TC1: 纯新增', () => {
    const result = diffSessionList([mkSession('a'), mkSession('b')], [])
    expect(result).toEqual({ added: ['a', 'b'], removed: [] })
  })
  it('TC2: 纯移除', () => {
    const result = diffSessionList([], [mkSession('a'), mkSession('b')])
    expect(result).toEqual({ added: [], removed: ['a', 'b'] })
  })
  it('TC3: 混合（新增+移除+保留）', () => {
    const result = diffSessionList(
      [mkSession('a'), mkSession('c'), mkSession('d')],
      [mkSession('a'), mkSession('b'), mkSession('e')],
    )
    expect(result.added).toEqual(['c', 'd'])
    expect(result.removed).toEqual(['b', 'e'])
  })
  it('TC4: 双空 list', () => {
    const result = diffSessionList([], [])
    expect(result).toEqual({ added: [], removed: [] })
  })
})

// mock useChat（隔离 streamSubscriptions 模块级 Map + 捕获调用）。
// disposeSessionMock 为模块级共享，便于 TC6/TC9/TC10 断言调用次数/参数。
const disposeSessionMock = vi.fn()
vi.mock('@/composables/features/chat/useChat', () => ({
  ensureStreamSubscription: vi.fn(),
  useChat: () => ({ disposeSession: disposeSessionMock }),
  resetChatModuleState: vi.fn(),
}))

const useChatMock = await import('@/composables/features/chat/useChat')
const ensureStreamSubscriptionMock = useChatMock.ensureStreamSubscription as ReturnType<typeof vi.fn>
const { useSessionStore } = await import('@/stores/session')
const { bindSessionStreamSync } = await import('../useSessionStreamSync')

describe('bindSessionStreamSync', () => {
  let pinia: ReturnType<typeof createPinia>
  let scope: ReturnType<typeof effectScope>
  let sessionStore: ReturnType<typeof useSessionStore>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    pinia = createPinia()
    setActivePinia(pinia)
    scope = effectScope()
    sessionStore = scope.run(() => {
      const s = useSessionStore()
      bindSessionStreamSync() // 在 scope 内注册 effect
      return s
    })!
  })

  afterEach(() => {
    scope.stop()
    vi.restoreAllMocks()
  })

  it('TC5: list 从空变 [s1,s2]，ensureStreamSubscription 被对每个 added 调用', () => {
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(2)
    // 验证参数含正确 sid（第 0 参数）
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s1')
    expect(ensureStreamSubscriptionMock.mock.calls[1][0]).toBe('s2')
  })

  it('TC6: removed 触发 disposeSession，参数为被移除的 sid', () => {
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    expect(disposeSessionMock).not.toHaveBeenCalled()
    sessionStore.removeFromList('s2')
    expect(disposeSessionMock).toHaveBeenCalledTimes(1)
    expect(disposeSessionMock).toHaveBeenCalledWith('s2')
  })

  it('TC7: flush:sync——appendSession 后不 await 立即已建订阅', () => {
    // 同步 append 后立即断言（证明 flush:'sync'，非异步）
    sessionStore.appendSession(mkSession('s-sync'))
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(1)
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s-sync')
  })

  it('TC8: scope.stop() 后 watch 退订，append 不再触发 ensureStreamSubscription', () => {
    // 不清 mock：通过比较 scope.stop() 前后的调用次数差证明 watch 已取消。
    // clearAllMocks 会把计数清零，断言通过不能证明 watch 真的解绑（验证空洞）。
    const beforeCount = ensureStreamSubscriptionMock.mock.calls.length
    scope.stop()
    // stop 后再 append（store 已存在，scope 已 stop，但 store 调用仍安全）
    sessionStore.appendSession(mkSession('s-after-stop'))
    // watch 已取消：appendSession 不触发 ensureStreamSubscription，调用次数应保持不变
    expect(ensureStreamSubscriptionMock.mock.calls.length).toBe(beforeCount)
  })

  it('TC9: 异常隔离——单 session ensureStreamSubscription throw 不阻断其余', () => {
    // s1 throw，s2 正常
    ensureStreamSubscriptionMock.mockImplementation((sid: string) => {
      if (sid === 's1') throw new Error('boom-s1')
    })
    sessionStore.appendSession(mkSession('s1'))
    sessionStore.appendSession(mkSession('s2'))
    // s2 仍被调用（未因 s1 失败而中断）
    expect(ensureStreamSubscriptionMock).toHaveBeenCalledTimes(2)
    expect(ensureStreamSubscriptionMock.mock.calls[0][0]).toBe('s1')
    expect(ensureStreamSubscriptionMock.mock.calls[1][0]).toBe('s2')
    // s1 失败记录 warn，含 sid
    expect(console.warn).toHaveBeenCalled()
    const warnMsg = JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)
    expect(warnMsg).toContain('s1')
  })

  it('TC10: removed 路径内层 try-catch 隔离——disposeSession 抛错不冒泡到 removeFromList 调用栈', () => {
    // 诚实降级说明：原 TC10 声称测"最外层 try-catch 防冒泡"，但用 ensureStreamSubscription/disposeSession
    // 抛错只能到达内层 per-session try-catch（源码 added/removed 循环内已有 try-catch 吞掉），最外层
    // catch 不可达——实测为验证空洞（断言全绿但没测到声称的分支）。
    // 唯一能穿透到最外层 catch 的是 diffSessionList 抛错，但 diffSessionList 是同模块 export，
    // ESM 模块绑定下 spyOn 命名空间对象无法覆盖源码内的直接引用（已实测 spy 不生效），强行注入需
    // 重构生产代码（过度）。因此降级为名副其实地测内层 try-catch：
    // - TC9 已覆盖 added 路径（ensureStreamSubscription 抛错隔离）；
    // - 本 TC10 覆盖 removed 路径——disposeSession 抛错被内层 catch 吞，不冒泡 + 记录 warn。
    disposeSessionMock.mockImplementation(() => {
      throw new Error('dispose-boom')
    })
    sessionStore.appendSession(mkSession('s1'))
    // try 内调 removeFromList——disposeSession 抛错应被内层 try-catch 兜住，不冒泡
    expect(() => {
      sessionStore.removeFromList('s1')
    }).not.toThrow()
    // 内层 catch 记录 warn，消息含 sid（区别于最外层 watch callback error）
    expect(console.warn).toHaveBeenCalled()
    const warnMsg = JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)
    expect(warnMsg).toContain('s1')
    expect(warnMsg).toContain('disposeSession failed')
  })
})
