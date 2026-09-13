/**
 * route-inbound.test.ts —— configureRouteInbound 行为等价断言（F8，TC-2）。
 *
 * 覆盖 IF4 处理顺序全路径：
 * ① msg.id + type==='error' → 委托 pending.resolveEnvelope（收到完整原始 error envelope，不直接 reject）+ 不进路由表
 * ② msg.id + 非 error → 委托 pending.resolveEnvelope（不直接 resolve）+ 不进路由表
 * ③ 有 sessionId 未注册 type → seq gap 中间件 + dispatchSession + 更新 lastSeenSeq
 * ④ gap（seq>lastSeenSeq+1）→ subscribeSession(sid, lastSeenSeq) 被调用 + 当前消息仍 dispatch
 *    + 基线在 reconcile 成功前不推进（MF-3）
 * ⑤ 无 sessionId → dispatchGlobal + L9 warn（session./message. 前缀）
 * ⑥ 未注册 type 落 fallback（恒真条目，有 sid 也 dispatchSession）
 * ⑦ effects 回调：session.exited / message.complete / session.subagents /
 *    session.workflowUpdate / error 无 id → onGlobalError
 * ⑧ configureRouteInbound 注入三件套 + dispatcher 可调用
 * D2 阶段 A（声明式条目 schema）：
 * D2-a crossSession 声明条目（骨架形态）双通道分发且零 effect 回调 + 声明形状锁定
 * D2-b payloadGuard 坏形状 → 跳过 sessionEffect、dispatchSession/crossSession 分发照常
 * D2-c 无 sid 条目走 globalEffect（阶段 B 起直接断言 'error' 条目，探针注入已退化删除）
 * D2 阶段 B（error 单条目合并）：
 * B-1 'error' 条目两支锁定：有 sid → sessionEffect、无 sid → globalEffect，互不串扰不叠加
 * B-2 globalEffect 内 !msg.id 守卫：带 id 未命中 pending → dispatchGlobal 照常、不 toast
 * B-3 默认路径纯兜底：未命中条目无 sid → dispatchGlobal + L9 warn，零 type 特判副作用
 *
 * 全部注入驱动：vi.fn 注入 TransportPorts（pending/events/subscribe）+ InboundEffects 5 回调 spy。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureRouteInbound, ROUTE_TABLE } from './route-inbound'
import type { TransportPorts, InboundEffects } from './route-inbound'
import { resetSubscriptionStates, subscribeSession, getSubscriptionState } from './subscription-state'
import * as realPending from '../transport/api/pending'
import type { ServerMessage } from '@xyz-agent/shared'

function makePorts(overrides?: Partial<TransportPorts>): TransportPorts {
  return {
    pending: {
      resolve: vi.fn(),
      reject: vi.fn(),
      rejectAll: vi.fn(),
      // 默认「命中 pending」对齐现有用例意图（①② 验证 pending 分流，msg.id 均为 RPC reply id）。
      // broadcast-id 走 dispatchGlobal 的场景在专门用例里 mockReturnValue(false)。
      has: vi.fn().mockReturnValue(true),
      // 委托契约 mock（收尾 6 R2/ES1）：route-inbound 不再做 envelope 展开，只透传原始 msg。
      // 展开细节（code 提取 + details.detail → Error）由 renderer api/__tests__/pending.test.ts 单测覆盖。
      resolveEnvelope: vi.fn(),
    },
    events: {
      dispatchSession: vi.fn(),
      dispatchGlobal: vi.fn(),
      dispatchCrossSession: vi.fn(),
    },
    subscribe: vi.fn().mockResolvedValue({
      snapshot: [],
      stateSnapshot: [],
      lastSeq: 0,
      gap: false,
    }),
    ...overrides,
  }
}

function makeEffects(overrides?: Partial<InboundEffects>): InboundEffects {
  return {
    onSessionExited: vi.fn(),
    onMessageComplete: vi.fn(),
    onSubagents: vi.fn(),
    onSubagentEntries: vi.fn(),
    onWorkflowUpdate: vi.fn(),
    onGlobalError: vi.fn(),
    onSessionError: vi.fn(),
    ...overrides,
  }
}

/** 构造带 sessionId payload 的消息（session 通道） */
function sessionMsg(type: string, payload: Record<string, unknown>, extra?: Partial<ServerMessage>): ServerMessage {
  return { type: type as ServerMessage['type'], payload: { sessionId: 's1', ...payload }, ...extra } as ServerMessage
}

describe('configureRouteInbound — pending 分流（①/②/⑧）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('① error + msg.id：委托 pending.resolveEnvelope（完整原始 envelope 透传，不直接 reject）+ 不进路由表', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)

    // 默认值分支（message/code 兜底、details.detail 展开是 pending 层职责，renderer pending.test.ts 覆盖）
    dispatcher({
      type: 'error',
      id: 'req-1',
      payload: {},
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenCalledTimes(1)
    expect(ports.pending.resolveEnvelope).toHaveBeenLastCalledWith({ type: 'error', id: 'req-1', payload: {} })
    // 委托后 route-inbound 不再直接 reject（展开逻辑在 pending 层）
    expect(ports.pending.reject).not.toHaveBeenCalled()
    // 不进路由表：无 sessionId 也不 dispatchGlobal（D7）
    expect(ports.events.dispatchGlobal).not.toHaveBeenCalled()
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()

    // string detail → 原样透传
    dispatcher({
      type: 'error',
      id: 'req-2',
      payload: { code: 'WORKTREE_EXISTS', message: 'exists', details: { detail: '/path/cwd' } },
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenLastCalledWith({
      type: 'error',
      id: 'req-2',
      payload: { code: 'WORKTREE_EXISTS', message: 'exists', details: { detail: '/path/cwd' } },
    })

    // object detail → 原样透传
    dispatcher({
      type: 'error',
      id: 'req-3',
      payload: { code: 'SETUP_FAILED', message: 'setup', details: { detail: { exitCode: 1, stderr: 'boom' } } },
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenCalledTimes(3)
    expect(ports.pending.reject).not.toHaveBeenCalled()
  })

  it('② 非 error + msg.id：委托 pending.resolveEnvelope（不直接 resolve）+ 不进路由表', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher({
      type: 'session.getHistory',
      id: 'req-9',
      payload: { sessionId: 's1', messages: [] },
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenCalledWith({
      type: 'session.getHistory',
      id: 'req-9',
      payload: { sessionId: 's1', messages: [] },
    })
    expect(ports.pending.resolve).not.toHaveBeenCalled()
    // D7：pending 分流后 return，不再进路由表（即使 payload 带 sessionId）
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()
  })

  it('⑨ broadcast 带 id 但未命中 pending（如 config.skills 携带 nextPushId）：不进 pending 分流，无 sessionId → 走 dispatchGlobal（回归 2026-08 R5 问题 9）', () => {
    // 根因：runtime broadcast（config.skills/agents/...）都带 `id: nextPushId()`。
    // 旧实现 `if (msg.id)` 误吞，广播被 pending 静默丢弃，skills/agents store 永空。
    // 修复后：msg.id 未命中 pending → 继续路由 → 默认路径 → dispatchGlobal。
    const ports = makePorts({
      pending: {
        resolve: vi.fn(),
        reject: vi.fn(),
        rejectAll: vi.fn(),
        has: vi.fn().mockReturnValue(false), // 模拟 push_id 不在 pendingMap
        resolveEnvelope: vi.fn(),
      },
    })
    const dispatcher = configureRouteInbound(ports)
    dispatcher({ type: 'config.skills', id: 'push_5', payload: { skills: [] } } as unknown as ServerMessage)
    // 未进 pending 分流
    expect(ports.pending.resolve).not.toHaveBeenCalled()
    expect(ports.pending.resolveEnvelope).not.toHaveBeenCalled()
    // 无 sessionId → 默认路径 → dispatchGlobal（settings store 靠此更新）
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'config.skills', id: 'push_5' }),
    )
  })

  it('⑧ configureRouteInbound 返回可调用 dispatcher；effects 可选（不传不崩）', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports) // 无 effects
    expect(typeof dispatcher).toBe('function')
    expect(() => dispatcher({ type: 'x.unknown', payload: {} } as unknown as ServerMessage)).not.toThrow()
    expect(ports.events.dispatchGlobal).toHaveBeenCalled()
  })
})

describe('configureRouteInbound — session 通道 + seq gap 中间件（③/④/⑥）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('③ 有 sessionId 未注册 type（fallback）：seq gap 中间件 + dispatchSession', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('config.providers', { providers: [] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'config.providers' }))
    expect(ports.events.dispatchGlobal).not.toHaveBeenCalled()
  })

  it('④ gap（seq>lastSeenSeq+1）→ subscribeSession(sid, lastSeenSeq) + 当前消息仍 dispatch + 基线 reconcile 成功后推进（MF-3）', async () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    // 先建立订阅（模拟 renderer ensureStreamSubscription）：lastSeenSeq 基线 = 10；reconcile 返回 ring 最新 seq 13
    ;(ports.subscribe as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 }) // initial subscribe
      .mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 13 }) // reconcile
    await subscribeSession('s1')
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(0) // 空回放

    // gap：seq 13 > 10+1 → reconcile 回拉 + 当前消息仍 dispatch
    dispatcher(sessionMsg('session.ping', {}, { seq: 13 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1) // 当前消息仍 dispatch
    expect(ports.subscribe).toHaveBeenCalledTimes(2) // 第二次 = reconcile 回拉
    expect(ports.subscribe).toHaveBeenLastCalledWith('s1', 10) // fromSeq = lastSeenSeq（排他下界，非 seq-1；MF-1）
    // MF-3：reconcile 未 resolve 前基线不推进到 13（gap 路径不 updateLastSeenSeq）
    expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(10)
    // reconcile resolve 后 subscribeImpl 的 max() 收敛推进基线到 reply.lastSeq
    await vi.waitFor(() => {
      expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13)
    })
  })

  it('④b drop（seq<=lastSeenSeq）：不 dispatch 不触发 reconcile', async () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    ;(ports.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    dispatcher(sessionMsg('session.ping', {}, { seq: 8 })) // 重复/乱序
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(0) // 不 dispatch
    expect(ports.subscribe).toHaveBeenCalledTimes(1) // 不触发 reconcile
  })

  it('④c 正常递进（seq === lastSeenSeq+1）：dispatch + 更新基线', async () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    ;(ports.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')

    dispatcher(sessionMsg('session.ping', {}, { seq: 11 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(ports.subscribe).toHaveBeenCalledTimes(1) // 不触发 reconcile
    // 下一条 seq=12 正常递进（基线已推进到 11）
    dispatcher(sessionMsg('session.ping', {}, { seq: 12 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(2)
    expect(ports.subscribe).toHaveBeenCalledTimes(1)
  })

  it('⑥ 未注册 type 落 fallback（恒真条目）——有 sid 走 dispatchSession、无 sid 走 dispatchGlobal', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('some.new.type', { data: 1 }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    dispatcher({ type: 'config.model.list', payload: { models: [] } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
  })
})

describe('configureRouteInbound — global 通道 + L9 + effects（⑤/⑦）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('⑤ 无 sessionId → dispatchGlobal + L9 warn（session./message. 前缀）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher({ type: 'session.exited', payload: { code: 1, reason: 'x' } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session-level message missing sessionId'),
      'session.exited',
    )
    warnSpy.mockRestore()
  })

  it('⑦ session.exited 条目：dispatchSession 后 onSessionExited 回调', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.exited', { code: 1, reason: 'boom\nline2' }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    // payload 原样透传（含 sessionMsg 注入的 sessionId 字段）
    expect(effects.onSessionExited).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ code: 1, reason: 'boom\nline2' }),
    )
  })

  it('⑦ message.complete 条目：dispatchSession 后 onMessageComplete 回调', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('message.complete', { stopReason: 'stop' }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onMessageComplete).toHaveBeenCalledWith('s1', { sessionId: 's1', stopReason: 'stop' })
  })

  it('⑦ message.complete 条目：willRetry 字段原样透传（[retry-sound] 中间失败静音判据）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('message.complete', { stopReason: 'error', willRetry: true }))
    expect(effects.onMessageComplete).toHaveBeenCalledWith('s1', {
      sessionId: 's1',
      stopReason: 'error',
      willRetry: true,
    })
  })

  it('⑦ session.subagents 条目：dispatchSession 后 onSubagents 回调（非数组跳过）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.subagents', { subagents: [{ id: 'sa-1', status: 'done' }] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSubagents).toHaveBeenCalledWith('s1', [{ id: 'sa-1', status: 'done' }])
    // 非数组 payload → 跳过回调
    dispatcher(sessionMsg('session.subagents', { subagents: 'not-array' }))
    expect(effects.onSubagents).toHaveBeenCalledTimes(1)
  })

  it('⑦ session.subagentEntriesAppended 条目：dispatchSession 后 onSubagentEntries 回调（坏形状跳过，E-4）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    const entry = { type: 'message', parentId: null, timestamp: '2026-08-25T00:00:00.000Z', message: { role: 'user', content: [] } }
    dispatcher(sessionMsg('session.subagentEntriesAppended', { subagentId: 'rec-1', entries: [entry] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSubagentEntries).toHaveBeenCalledWith('s1', 'rec-1', [entry])

    // 坏形状（subagentId 空 / entries 非数组）→ 跳过回调，dispatch 照常
    dispatcher(sessionMsg('session.subagentEntriesAppended', { subagentId: '', entries: [entry] }))
    dispatcher(sessionMsg('session.subagentEntriesAppended', { subagentId: 'rec-1', entries: 'not-array' }))
    expect(effects.onSubagentEntries).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(3)
  })

  it('⑦ session.workflowUpdate 条目：dispatchSession 后 onWorkflowUpdate 回调（payload 锚定 protocol SSOT）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('session.workflowUpdate', { update: { runId: 'wf-1', status: 'running' } }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onWorkflowUpdate).toHaveBeenCalledWith('s1', { runId: 'wf-1', status: 'running' })
  })

  it('⑦ error 无 id 无 sid → onGlobalError 回调（error 条目 globalEffect，阶段 B 自默认路径特判并入）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher({ type: 'error', payload: { message: 'config load failed' } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(effects.onGlobalError).toHaveBeenCalledWith('config load failed')
    // message 缺失 → 默认 'Unknown error'
    dispatcher({ type: 'error', payload: {} } as unknown as ServerMessage)
    expect(effects.onGlobalError).toHaveBeenLastCalledWith('Unknown error')
  })

  it('⑦ error 带 sid 无 id（D6b：fire-and-forget 失败，如 extension.ui_response 无进程）→ dispatchSession + onSessionError', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher({
      type: 'error',
      payload: { code: 'handler_error', message: 'No active session for extension response: s1', sessionId: 's1' },
    } as unknown as ServerMessage)
    // session 通道仍分发（订阅者可见），effect 兜底保证无订阅者也不丢
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSessionError).toHaveBeenCalledWith('s1', {
      code: 'handler_error',
      message: 'No active session for extension response: s1',
    })
    expect(ports.events.dispatchGlobal).not.toHaveBeenCalled()
    expect(effects.onGlobalError).not.toHaveBeenCalled()
    // message 缺失 → 兜底 'Unknown error'（防御运行时坏形状）
    dispatcher({ type: 'error', payload: { sessionId: 's1' } } as unknown as ServerMessage)
    expect(effects.onSessionError).toHaveBeenLastCalledWith('s1', { code: undefined, message: 'Unknown error' })
  })

  it('⑦ error 带 id 命中 pending → 仍走 pending 分流，不触发 onSessionError（请求级失败归 pending reject）', () => {
    // has 默认 mockReturnValue(true)（对齐 RPC reply 场景）
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher({
      type: 'error',
      id: 'req-1',
      payload: { code: 'message_blocked', message: 'blocked', sessionId: 's1' },
    } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).toHaveBeenCalledTimes(1)
    expect(effects.onSessionError).not.toHaveBeenCalled()
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()
  })
})

describe('configureRouteInbound — ROUTE_TABLE Record 直查等价（Q1-4）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('Q1-4a 同一 type 的多条消息（热路径）每条路由到同一 handler：同消息同路由', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)

    // message.complete 是每 turn 高频热路径，模拟连续多条同 type 入站
    for (let i = 0; i < 50; i++) {
      dispatcher(sessionMsg('message.complete', { stopReason: 'stop' }))
    }
    // 全部 50 条都经同一条目路由：dispatchSession 与 effect 回调计数一致，无漏发/重发
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(50)
    expect(effects.onMessageComplete).toHaveBeenCalledTimes(50)
    expect(ports.events.dispatchGlobal).not.toHaveBeenCalled()
  })

  it('Q1-4b 全部 5 个 effect 注册 type 逐一命中各自条目（无 sid 时走 dispatchGlobal + globalEffect 默认路径，不误命中）', () => {
    const registeredTypes = ['session.exited', 'message.complete', 'session.subagents', 'session.subagentEntriesAppended', 'session.workflowUpdate'] as const
    for (const type of registeredTypes) {
      const ports = makePorts()
      const effects = makeEffects()
      const dispatcher = configureRouteInbound(ports, effects)
      // 有 sid → 命中 Record 条目（dispatchSession + 对应 effect 回调）
      dispatcher(sessionMsg(type, type === 'session.subagents' ? { subagents: [] } : type === 'session.subagentEntriesAppended' ? { subagentId: 'rec-1', entries: [] } : {}))
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
      // 无 sid → 走 dispatchGlobal + globalEffect 默认路径（这 5 个条目未声明 globalEffect，
      // 行为与 Record 化前一致）
      dispatcher({ type, payload: {} } as unknown as ServerMessage)
      expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    }
  })

  it('Q1-4c 原型成员名 type（constructor/toString）不误命中路由表（hasOwnProperty 守卫）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)

    // 裸 Record 下标访问会命中 Object 原型成员（truthy 但无 handle → TypeError）。
    // hasOwn 守卫后语义与旧 .find 严格等价：视为未注册 type。
    expect(() =>
      dispatcher(sessionMsg('constructor', {})),
    ).not.toThrow()
    expect(() =>
      dispatcher(sessionMsg('toString', {})),
    ).not.toThrow()
    // 有 sid → 走默认路径 session 分支正常 dispatchSession，effects 无回调
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(2)
    expect(effects.onSessionExited).not.toHaveBeenCalled()
    expect(effects.onMessageComplete).not.toHaveBeenCalled()
  })
})

describe('configureRouteInbound — crossSession 通道（ADR-0060）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('⑩a 带 sid + crossSession 声明条目 type（extension:widget）→ dispatchSession + dispatchCrossSession', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('extension:widget', { widgetKey: 'w', lines: [] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'extension:widget' }),
    )
  })

  it('⑩b 带 sid + 非 crossSession 声明条目 type → 只 dispatchSession，不 dispatchCrossSession', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('config.providers', { providers: [] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).not.toHaveBeenCalled()
  })

  it('⑩c extension.ui_request（点号）命中 crossSession 声明条目 → dispatchCrossSession', () => {
    // 点号是 runtime wire 实际格式（event-adapter.ts），ADR 文档冒号为笔误
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher(sessionMsg('extension.ui_request', { requestId: 'r', method: 'input' }))
    expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'extension.ui_request' }),
    )
  })

  it('⑩d seq gap drop 的 crossSession 声明条目消息 → dispatchSession / dispatchCrossSession 均不调', async () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    ;(ports.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')
    // seq<=lastSeenSeq → applySeqGap drop，crossSession 也不发（防 ExtensionHost 重复处理）
    dispatcher(sessionMsg('extension:widget', { widgetKey: 'w', lines: [] }, { seq: 8 }))
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()
    expect(ports.events.dispatchCrossSession).not.toHaveBeenCalled()
  })

  it('⑩e 无 sid 的 crossSession 声明条目 type → 走 dispatchGlobal，不 dispatchCrossSession', () => {
    // crossSession 只在有 sid 分支触发；无 sid 走 global 通道
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports)
    dispatcher({ type: 'extension:widget', payload: { widgetKey: 'w', lines: [] } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).not.toHaveBeenCalled()
  })

  it('⑩f 全量 crossSession 声明条目 type 字面量逐项命中（防拼写回归）', () => {
    // 逐项锁 route-inbound.ts 的 8 个 crossSession 声明条目 type（ROUTE_TABLE 虽已导出，
    // 但遍历其键会自我引用，锁不住源码侧拼写漂移——测试内字面量逐项断言才能钉住）。
    // 任一成员拼写漂移（如 extension.ui_request 误写成冒号）→ dispatchCrossSession 不再被调
    const literals = [
      'extension:widget',
      'extension:widgetGui',
      'extension:status',
      'extension:notify',
      'extension.ui_request',
      'extension.ui_timeout',
      'plugin:uiRequest',
      'plugin:viewUpdate',
    ]
    for (const type of literals) {
      const ports = makePorts()
      const dispatcher = configureRouteInbound(ports)
      dispatcher(sessionMsg(type, { requestId: 'r', method: 'input' }))
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
        expect.objectContaining({ type }),
      )
    }
  })
})

describe('configureRouteInbound — 声明式条目 schema（D2 阶段 A）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('D2-a crossSession 声明条目（骨架形态）：双通道分发且零 effect 回调 + 声明形状锁定', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('extension:status', { lines: ['l1'] }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(ports.events.dispatchCrossSession).toHaveBeenCalledTimes(1)
    // 骨架条目只声明 crossSession（无 sessionEffect/payloadGuard）：任何 effect 不触发
    expect(effects.onSessionExited).not.toHaveBeenCalled()
    expect(effects.onSubagents).not.toHaveBeenCalled()
    expect(effects.onSessionError).not.toHaveBeenCalled()
    expect(effects.onGlobalError).not.toHaveBeenCalled()
    // 声明形状锁定：条目是纯声明式数据（crossSession 布尔 + 跳过型守卫函数），无 handle 函数体
    expect(ROUTE_TABLE['extension:status']).toEqual({ crossSession: true })
    expect(ROUTE_TABLE['session.subagents']).toEqual({
      payloadGuard: expect.any(Function),
      sessionEffect: expect.any(Function),
    })
  })

  it('D2-b payloadGuard 坏形状 → 跳过 sessionEffect，dispatchSession/crossSession 分发照常（守卫只门控 effect）', () => {
    // 探针条目经导出面注册（用后清理）：同时声明 crossSession + payloadGuard，
    // 验证守卫失败时分发不受门控（D2「payloadGuard 不门控分发」显式条款）
    const probeType = 'test.d2.payloadGuardProbe'
    const sessionEffect = vi.fn()
    ROUTE_TABLE[probeType] = {
      crossSession: true,
      payloadGuard: (payload) => (payload as { ok?: unknown }).ok === true,
      sessionEffect,
    }
    try {
      const ports = makePorts()
      const effects = makeEffects()
      const dispatcher = configureRouteInbound(ports, effects)
      // 坏形状：ok !== true → guard 拒绝
      dispatcher(sessionMsg(probeType, { ok: false }))
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1) // dispatch 照常
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledTimes(1) // crossSession 分发不被守卫门控
      expect(sessionEffect).not.toHaveBeenCalled() // 只跳过 effect
      // 好形状：guard 通过 → effect 以（sid, payload, effects）调用
      dispatcher(sessionMsg(probeType, { ok: true }))
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(2)
      expect(sessionEffect).toHaveBeenCalledTimes(1)
      expect(sessionEffect).toHaveBeenCalledWith('s1', expect.objectContaining({ ok: true }), effects)
    } finally {
      delete ROUTE_TABLE[probeType]
    }
  })

  it('D2-c 无 sid 条目走 globalEffect（阶段 B 直接断言 error 条目：无 sid + 无 id → onGlobalError 兜底）', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher({ type: 'error', payload: { message: 'boom' } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    // 单条消息恰好一次——默认路径特判已删，不与条目 globalEffect 叠加
    expect(effects.onGlobalError).toHaveBeenCalledTimes(1)
    expect(effects.onGlobalError).toHaveBeenCalledWith('boom')
    // 无 sid 不触发 session 通道与 crossSession
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()
    expect(ports.events.dispatchCrossSession).not.toHaveBeenCalled()
    // 声明形状锁定：'error' 单条目双字段齐（sessionEffect + globalEffect）
    expect(ROUTE_TABLE['error']).toEqual({
      sessionEffect: expect.any(Function),
      globalEffect: expect.any(Function),
    })
  })
})

describe('configureRouteInbound — error 单条目合并（D2 阶段 B）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('B-1 error 条目两支锁定：有 sid → sessionEffect（onSessionError）、无 sid → globalEffect（onGlobalError），互不串扰不叠加', () => {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    // 有 sid 支：dispatchSession + onSessionError，不触发 global 通道/回调
    dispatcher(sessionMsg('error', { code: 'c1', message: 'm1' }))
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    expect(effects.onSessionError).toHaveBeenCalledTimes(1)
    expect(effects.onSessionError).toHaveBeenCalledWith('s1', { code: 'c1', message: 'm1' })
    expect(ports.events.dispatchGlobal).not.toHaveBeenCalled()
    expect(effects.onGlobalError).not.toHaveBeenCalled()
    // 无 sid 支：dispatchGlobal + onGlobalError，不触发 session 通道/回调
    dispatcher({ type: 'error', payload: { message: 'global boom' } } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(effects.onGlobalError).toHaveBeenCalledTimes(1) // 特判已删不叠加，恰好一次
    expect(effects.onGlobalError).toHaveBeenCalledWith('global boom')
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1) // 仍只有有 sid 那条
    expect(effects.onSessionError).toHaveBeenCalledTimes(1)
  })

  it('B-2 globalEffect 内 !msg.id 守卫：error 无 sid 但带 id 未命中 pending（如迟到 reply 广播形态）→ dispatchGlobal 照常、不 onGlobalError', () => {
    const ports = makePorts({
      pending: {
        resolve: vi.fn(),
        reject: vi.fn(),
        rejectAll: vi.fn(),
        has: vi.fn().mockReturnValue(false), // id 未命中 pending：不进 pending 分流
        resolveEnvelope: vi.fn(),
      },
    })
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher({ type: 'error', id: 'late-1', payload: { message: 'late' } } as unknown as ServerMessage)
    expect(ports.pending.resolveEnvelope).not.toHaveBeenCalled()
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(effects.onGlobalError).not.toHaveBeenCalled() // 守卫拒绝：带 id 不 toast
  })

  it('B-3 默认路径纯兜底（对 error 不再特判）：未命中条目无 sid 消息只 dispatchGlobal + L9 warn，零 effect 副作用', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    // 未注册 type（session.* 前缀触发 L9 warn）无 sid → 默认路径只做通道分发 + warn
    dispatcher({ type: 'session.unregisteredProbe', payload: {} } as unknown as ServerMessage)
    expect(ports.events.dispatchGlobal).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('session-level message missing sessionId'),
      'session.unregisteredProbe',
    )
    expect(effects.onGlobalError).not.toHaveBeenCalled()
    expect(effects.onSessionError).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('configureRouteInbound — 缺省真实模块直连（D3）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('不传 ports：pending 分流用真实 transport/api/pending（register 的 reply 被 resolve）', async () => {
    // 生产路径：configureRouteInbound() 缺省 defaultPorts（直连 core transport/api 模块级
    // 单例）——真实 pending 注册表收到 reply id 后经 resolveEnvelope 结算 Promise
    const dispatcher = configureRouteInbound()
    const replyPromise = realPending.register('default-ports-reply-1', 60_000)
    dispatcher({
      type: 'session.getCommands',
      id: 'default-ports-reply-1',
      payload: { commands: [] },
    } as unknown as ServerMessage)
    await expect(replyPromise).resolves.toEqual({ commands: [] })
    // 清理模块级 pendingMap（真实单例状态，防泄漏到其他用例）
    realPending.rejectAll(new Error('test cleanup'))
  })
})

describe('configureRouteInbound — subagent.stream_delta 桥接（[idle-refresh] §5.1 D1）', () => {
  beforeEach(() => {
    resetSubscriptionStates()
  })

  it('subagent.stream_delta 帧（未注册 type，恒走默认兜底路径）→ onSubagentStreamDelta 收原始 frame + dispatchSession 照常', () => {
    const ports = makePorts()
    const effects = makeEffects({ onSubagentStreamDelta: vi.fn() })
    const dispatcher = configureRouteInbound(ports, effects)
    const frame = { type: 'subagent.stream_delta', payload: { sessionId: 'subagent:s1:bg-1', recordId: 'bg-1', lines: ['x'] } } as unknown as ServerMessage
    dispatcher(frame)
    // 帧透传（父 sid 解析与 refresh 由 effects 实现方完成，core 不做业务解析）
    expect(effects.onSubagentStreamDelta).toHaveBeenCalledWith(frame)
    // 既有 FALLBACK 语义不受影响（session 通道照常分发）
    expect(ports.events.dispatchSession).toHaveBeenCalledWith('subagent:s1:bg-1', frame)
  })

  it('tee 双形态：虚拟 id 与主 sid 帧都到达回调（payload.sessionId 原样透传）', () => {
    const ports = makePorts()
    const effects = makeEffects({ onSubagentStreamDelta: vi.fn() })
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher({ type: 'subagent.stream_delta', payload: { sessionId: 'subagent:s1:bg-1', recordId: 'bg-1', lines: ['a'] } } as unknown as ServerMessage)
    dispatcher({ type: 'subagent.stream_delta', payload: { sessionId: 's1', recordId: 'bg-1', lines: ['a'] } } as unknown as ServerMessage)
    expect(effects.onSubagentStreamDelta).toHaveBeenCalledTimes(2)
  })

  it('非 subagent.stream_delta 的未注册 type 帧 → 回调不调（no-op）', () => {
    const ports = makePorts()
    const effects = makeEffects({ onSubagentStreamDelta: vi.fn() })
    const dispatcher = configureRouteInbound(ports, effects)
    dispatcher(sessionMsg('message.text_delta', { delta: 'x' }))
    dispatcher(sessionMsg('message.status', { status: 'sent' }))
    expect(effects.onSubagentStreamDelta).not.toHaveBeenCalled()
  })

  it('seq gap drop 的 subagent.stream_delta 帧 → 回调不调（与 dispatchSession 同 gate）', async () => {
    const ports = makePorts()
    const effects = makeEffects({ onSubagentStreamDelta: vi.fn() })
    const dispatcher = configureRouteInbound(ports, effects)
    ;(ports.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')
    dispatcher(sessionMsg('subagent.stream_delta', { recordId: 'bg-1', lines: ['x'] }, { seq: 8 }))
    expect(effects.onSubagentStreamDelta).not.toHaveBeenCalled()
    expect(ports.events.dispatchSession).not.toHaveBeenCalled()
  })

  it('未注册 onSubagentStreamDelta 回调时跳过（undefined 可选，行为与现状一致）', () => {
    const ports = makePorts()
    const dispatcher = configureRouteInbound(ports, makeEffects())
    expect(() =>
      dispatcher({ type: 'subagent.stream_delta', payload: { sessionId: 'subagent:s1:bg-1', recordId: 'bg-1', lines: ['x'] } } as unknown as ServerMessage),
    ).not.toThrow()
    expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
  })
})
