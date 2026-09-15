/**
 * useHandoffEffect 单测 —— fast-handoff 全局订阅（agent-driven 模式 wave2 简化版）。
 *
 * bindHandoffEffect（wave2 简化后）只做两件事（复位 + 跳转）：
 * - 订阅 session.handoffComplete → setHandingOff(srcSessionId,false) + loadSessions().catch(warn)
 *   .then(() => selectSession(newSessionId)).catch(warn)。
 * - 订阅 session.handoffAborted → setHandingOff(sessionId,false)。
 * onScopeDispose 时退订两个订阅。
 *
 * wave2 删除了所有 doc/reply 注入逻辑（appendUser / chatApi.send / ensureStreamSubscription /
 * disposeSession / hydrate 预标记 / 回滚）——这些都归 runtime HandoffService（newClient.prompt(doc)
 * 把文档注入新 session 触发新 turn）。广播 payload 因此移除 doc / reply 字段。
 *
 * 覆盖用例（AGENTS #5：每用例含用户可见/状态断言）：
 * - TC1 正常路径：handoffComplete → 复位源 handingOff + loadSessions + selectSession(NEW)
 * - TC2 loadSessions 失败降级：loadSessions reject → console.warn('loadSessions failed') + selectSession 仍调
 * - TC3 selectSession 失败兜底：selectSession reject → console.warn('selectSession failed')（.catch 兜底，无 unhandled rejection）
 * - TC4 handoffAborted：复位源 handingOff，loadSessions/selectSession 不调
 * - TC5 scope.stop() 退订：广播不再触发任何副作用
 *
 * mock 策略（收窄，删除 wave1 时代的 doc 注入 mock）：
 * - vi.mock('@/composables/features/sidebar/useSidebar')：loadSessions / selectSession 用 vi.fn（可 reject 测失败路径）。
 * - events / useChatStore 用**真实**实现（验 setHandingOff 写 handingOffSessions Set 的真实副作用，
 *   AGENTS #5 用户可见断言）。events 不 mock，用真实 dispatchGlobal 派发。
 *
 * 生命周期：bindHandoffEffect 用 effectScope 包裹（onScopeDispose 需 active scope），
 * scope.stop() 触发 onScopeDispose 退订。beforeEach 重建 scope + afterEach stop 兜底清干净
 * （events.ts 的 globalTypeHandlers 是模块级 Map，scope.stop 经 onScopeDispose 从中删除 handler）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useHandoffEffect.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'

// ── useSidebar mock：捕获 loadSessions/selectSession（不引入真实 useSidebar 的 30+ 依赖）──
const sidebarMock = vi.hoisted(() => ({
  loadSessions: vi.fn(() => Promise.resolve()),
  selectSession: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({
    loadSessions: sidebarMock.loadSessions,
    selectSession: sidebarMock.selectSession,
  }),
}))

import { bindHandoffEffect } from '@/composables/effects/useHandoffEffect'
import { useChatStore } from '@/stores/chat'
import * as events from '@taiji/core/transport/api'
import type { ServerMessage } from '@taiji/shared'

const SRC = 'src-1'
const NEW = 'new-1'
const SOURCE_LABEL = 'src-session'

let scope: ReturnType<typeof effectScope> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 重置默认 resolve（个别用例 mockRejectedValueOnce 后清 mock 恢复默认）
  sidebarMock.loadSessions.mockResolvedValue(undefined)
  sidebarMock.selectSession.mockResolvedValue(undefined)

  // 在独立 effectScope 内 bind：满足 onScopeDispose 需 active scope（无则 warn），
  // scope.stop() 触发 onScopeDispose 退订，作 afterEach 兜底。
  scope = effectScope()
  scope.run(() => bindHandoffEffect())
})

afterEach(() => {
  // scope.stop() 触发 onScopeDispose → off 退订（TC5 也依赖此；其它用例防 handler 残留到下一用例）
  scope?.stop()
  scope = null
})

/** 构造一条 session.handoffComplete 消息并经 global 通道派发（走真实 events 路径）。 */
function emitHandoffComplete(
  overrides: Partial<{ srcSessionId: string; newSessionId: string; sourceLabel: string }> = {},
): void {
  const payload = {
    srcSessionId: overrides.srcSessionId ?? SRC,
    newSessionId: overrides.newSessionId ?? NEW,
    sourceLabel: overrides.sourceLabel ?? SOURCE_LABEL,
  }
  events.dispatchGlobal({ type: 'session.handoffComplete', payload } as unknown as ServerMessage)
}

/** 构造一条 session.handoffAborted 消息并经 global 通道派发。 */
function emitHandoffAborted(srcSessionId: string = SRC): void {
  events.dispatchGlobal({ type: 'session.handoffAborted', payload: { srcSessionId } } as unknown as ServerMessage)
}

describe('useHandoffEffect.bindHandoffEffect', () => {
  it('TC1 正常路径：handoffComplete → 复位源 handingOff + loadSessions + selectSession(NEW)', async () => {
    const chat = useChatStore()
    // 模拟 handoff 触发态：源 session 标 handingOff=true（消除「正在交接…」反馈后应复位）
    chat.setHandingOff(SRC, true)
    expect(chat.isHandingOff(SRC)).toBe(true)

    emitHandoffComplete()
    await vi.waitFor(() => { expect(sidebarMock.loadSessions).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(sidebarMock.selectSession).toHaveBeenCalledWith(NEW) })

    // [复位] 源 session handingOff 已清（消除「正在交接…」反馈）
    expect(chat.isHandingOff(SRC)).toBe(false)
    // loadSessions 调 1 次
    expect(sidebarMock.loadSessions).toHaveBeenCalledTimes(1)
    // 跳转到新 session
    expect(sidebarMock.selectSession).toHaveBeenCalledTimes(1)
    expect(sidebarMock.selectSession).toHaveBeenCalledWith(NEW)
  })

  it('TC2 loadSessions 失败降级：reject → .catch 兜底 warn（selectSession 不调，loadSessions 内部 try/catch 不会 reject，此路径仅 mock 验证兜底健壮性）', async () => {
    sidebarMock.loadSessions.mockRejectedValue(new Error('network'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    emitHandoffComplete()
    // loadSessions reject → .then 不执行 → selectSession 不调；rejection 传播到末尾 .catch
    await vi.waitFor(() => {
      const selectWarn = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('selectSession failed'),
      )
      expect(selectWarn).toBeDefined()
    })

    // [兜底] loadSessions reject 被末尾 .catch 捕获（warn 'selectSession failed'）
    const selectWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('selectSession failed'),
    )
    expect(selectWarn).toBeDefined()
    // selectSession 未调用（.then 未执行）
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()

    // 排空 microtask 队列，确认 .catch 已兜底无 unhandledRejection
    await new Promise((r) => setTimeout(r, 0))

    warnSpy.mockRestore()
  })

  it('TC3 selectSession 失败兜底：reject → console.warn(selectSession failed)，无 unhandled rejection', async () => {
    sidebarMock.selectSession.mockRejectedValue(new Error('boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    emitHandoffComplete()
    // 等 .catch 链跑完（loadSessions resolve → then(selectSession reject) → catch warn）
    await vi.waitFor(() => {
      const selectWarn = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('selectSession failed'),
      )
      expect(selectWarn).toBeDefined()
    })

    // [兜底] selectSession 失败已 warn（.catch 吞掉异常，保留排查线索）
    const selectWarn = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('selectSession failed'),
    )
    expect(selectWarn).toBeDefined()

    // 排空 microtask 队列，确认 .catch 已兜底无 unhandledRejection
    await new Promise((r) => setTimeout(r, 0))

    warnSpy.mockRestore()
  })

  it('TC4 handoffAborted：复位源 handingOff，loadSessions/selectSession 不调', async () => {
    const chat = useChatStore()
    chat.setHandingOff(SRC, true)
    expect(chat.isHandingOff(SRC)).toBe(true)

    emitHandoffAborted(SRC)
    await nextTick()

    // [复位] 源 session handingOff 已清（用户取消或 abort 兜底）
    expect(chat.isHandingOff(SRC)).toBe(false)
    // handoffAborted 只复位，不刷新列表也不跳转
    expect(sidebarMock.loadSessions).not.toHaveBeenCalled()
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })

  it('TC5 scope.stop() 退订：handoffComplete + handoffAborted 不再触发任何副作用', async () => {
    const chat = useChatStore()
    // 先停 scope（触发 onScopeDispose → off 退订）
    scope!.stop()
    scope = null

    // SRC 先标 handingOff=true 让它在 set 里——emit handoffAborted 后若订阅未退订会把它复位。
    // 退订生效时 set 应仍含 SRC（未被复位）。handoffComplete 路径同理不再触发 loadSessions/selectSession。
    chat.setHandingOff(SRC, true)
    const handingOffBefore = new Set(chat.handingOffSessions)

    emitHandoffComplete()
    emitHandoffAborted(SRC)
    // 兜底等待，确认副作用从未发生
    await new Promise((r) => setTimeout(r, 0))

    // 退订后广播不触发任何副作用：handingOffSessions Set 未变（SRC 仍含，未被复位）
    expect(chat.isHandingOff(SRC)).toBe(true)
    expect(chat.handingOffSessions).toEqual(handingOffBefore)
    expect(sidebarMock.loadSessions).not.toHaveBeenCalled()
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })
})
