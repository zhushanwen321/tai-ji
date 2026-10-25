// @vitest-environment node

/**
 * useHandoffEffect 单测 —— fast-handoff 全局订阅（agent-driven 模式 wave2 简化版）。
 *
 * bindHandoffEffect（[chat-flow-consistency §6 裁决表「状态机｜交接在途状态归属」行] Set 退役后）只做一件事（刷新 + 跳转）：
 * - 订阅 session.handoffComplete → loadSessions().catch(warn)
 *   .then(() => selectSession(newSessionId)).catch(warn)。
 * - session.handoffAborted 订阅已移除（唯一副作用是旧 handingOffSessions Set 复位；
 *   handingOff membership 现归 occupancy 派生视图，复位 = runtime 'handingOff-end' 原语
 *   经 session.occupancy 帧到达——本效果不再写任何状态）。
 * onScopeDispose 时退订订阅。
 *
 * wave2 删除了所有 doc/reply 注入逻辑（appendUser / chatApi.send / ensureStreamSubscription /
 * disposeSession / hydrate 预标记 / 回滚）——这些都归 runtime HandoffService（newClient.prompt(doc)
 * 把文档注入新 session 触发新 turn）。广播 payload 因此移除 doc / reply 字段。
 *
 * 覆盖用例（AGENTS #5：每用例含用户可见/状态断言）：
 * - TC1 正常路径：handoffComplete → loadSessions + selectSession(NEW)；不写本地 handingOff 状态
 *   （置位/复位权威在 runtime occupancy 帧，效果层零状态写）
 * - TC2 loadSessions 失败降级：loadSessions reject → console.warn('loadSessions failed') + selectSession 仍调
 * - TC3 selectSession 失败兜底：selectSession reject → console.warn('selectSession failed')（.catch 兜底，无 unhandled rejection）
 * - TC4 handoffAborted：订阅已移除 → 零副作用（loadSessions/selectSession 不调，occupancy 状态不动）
 * - TC5 scope.stop() 退订：广播不再触发任何副作用
 *
 * mock 策略（收窄，删除 wave1 时代的 doc 注入 mock）：
 * - vi.mock('@/composables/features/sidebar/useSidebar')：loadSessions / selectSession 用 vi.fn（可 reject 测失败路径）。
 * - events / useChatStore 用**真实**实现（验 isHandingOff 读 occupancy 派生视图的真实读口，
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
import { effectScope } from 'vue'

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

/** 经权威通路（session.occupancy 帧）把源 session 置交接在途（裁决表行：membership 唯一来源）。 */
function seedHandingOff(): void {
  const chat = useChatStore()
  chat.setOccupancy(SRC, { turn: 'idle', compacting: false, bash: false, handingOff: true })
  expect(chat.isHandingOff(SRC)).toBe(true)
}

describe('useHandoffEffect.bindHandoffEffect', () => {
  it('TC1 正常路径：handoffComplete → loadSessions + selectSession(NEW)；不写本地 handingOff 状态', async () => {
    const chat = useChatStore()
    seedHandingOff()

    emitHandoffComplete()
    await vi.waitFor(() => { expect(sidebarMock.loadSessions).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(sidebarMock.selectSession).toHaveBeenCalledWith(NEW) })

    // [§6 裁决表行] 效果层零状态写：handingOff 复位归 runtime 'handingOff-end' 原语（occupancy 帧），
    // 本订阅只编排刷新 + 跳转——本地派生视图未被本效果改动
    expect(chat.isHandingOff(SRC)).toBe(true)
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

  it('TC4 handoffAborted：订阅已移除（裁决表行）→ 零副作用，occupancy 状态不动', async () => {
    const chat = useChatStore()
    seedHandingOff()

    emitHandoffAborted(SRC)
    await new Promise((r) => setTimeout(r, 0))

    // [§6 裁决表行] handoffAborted 订阅随 Set 复位职责退役：无列表刷新、无跳转、状态不写
    //（aborted 形态的 handingOff 复位由 runtime cleanupInflight 的 'handingOff-end' 原语
    // 经 session.occupancy 帧承担）
    expect(chat.isHandingOff(SRC)).toBe(true)
    expect(sidebarMock.loadSessions).not.toHaveBeenCalled()
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })

  it('TC5 scope.stop() 退订：handoffComplete 不再触发任何副作用', async () => {
    const chat = useChatStore()
    seedHandingOff()

    // 先停 scope（触发 onScopeDispose → off 退订）
    scope!.stop()
    scope = null

    emitHandoffComplete()
    emitHandoffAborted(SRC)
    // 兜底等待，确认副作用从未发生
    await new Promise((r) => setTimeout(r, 0))

    // 退订后广播不触发任何副作用：handingOff 状态未变 + 无刷新/跳转
    expect(chat.isHandingOff(SRC)).toBe(true)
    expect(sidebarMock.loadSessions).not.toHaveBeenCalled()
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })
})
