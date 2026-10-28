// subscription-state.test.ts —— core C09 簇合并产物（round5-G）。
// 共同被测业务模块：`src/coordination/subscription-state.ts`。mock 相容：单侧 mock ../api/domains/session、../api/events、../api/pending、../ws-client——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/coordination/route-inbound.test.ts（37 用例，skip 0）
//   - src/coordination/subscription-replay.test.ts（10 用例，skip 0）
//   - src/coordination/subscription-state-seq-gate.test.ts（3 用例，skip 0）
//   - src/coordination/subscription-state.test.ts（19 用例，skip 0）
//   - src/domain/chat/__tests__/respawn-notice.test.ts（16 用例，skip 0）
//   - src/transport/__tests__/use-connection-seq-gap.test.ts（10 用例，skip 0）

import { describe, it, expect, vi, beforeEach, type Mock, afterEach, beforeAll } from 'vitest'
import { configureRouteInbound, ROUTE_TABLE, type TransportPorts, type InboundEffects } from './route-inbound'
import { resetSubscriptionStates, subscribeSession, getSubscriptionState, resubscribeAll, seqGate, setSubscriptionPorts, clearSubscription, updateLastSeenSeq, evalSeqGap, type SubscriptionState } from './subscription-state'
import { type ServerMessage, PI_RESPAWN_NOTICE_CUSTOM_TYPE, type Message } from '@taiji/shared'
import { effectScope, ref, type Ref } from 'vue'
import { createChatStore, type ChatStoreInstance } from '../domain/chat/store'
import { type ConnectionState } from '../transport/ws-client'
import { useConnection, setConnectionPorts, type ConnectionPorts } from '../transport/use-connection'

/** 构造带 seq + sessionId payload 的消息（session 通道） */
function msg(seq: number, type = 'session.ping', payloadExtra: Record<string, unknown> = {}): ServerMessage {
  return { type: type as ServerMessage['type'], seq, payload: { sessionId: 's1', ...payloadExtra } }
}
const mockDisconnect = vi.fn()
// ── ws-client mock：捕获 onMessage 注册的 dispatcher ───────────────
const mockConnect = vi.fn()
// ws-client mock 工厂（文件顶）引用的连接状态槽与消息回调槽——原属 use-connection-seq-gap
// 节 describe 内局部声明，与提升到文件顶的工厂闭包断裂（ReferenceError），提升到模块作用域
let mockStateRef: Ref<ConnectionState> = ref('disconnected')
let inboundHandler: ((msg: ServerMessage) => void) | null = null

// ── pending mock（routeInbound id 路径需要）─────────────────────────
// D3 后 configureRouteInbound 缺省直连 transport/api 真实模块（不再经 ConnectionPorts
// 注入三件套）——mock 须拦截模块本身，dispatcher 的 defaultPorts 解析到下列 mock 对象
const pendingMock = vi.hoisted(() => {
  const m = {
    resolve: vi.fn(),
    reject: vi.fn(),
    rejectAll: vi.fn(),
    // routeInbound 用 has 判定 msg.id 是否命中 pending（RPC reply）；测试模拟的带 id 消息均为 reply
    has: vi.fn().mockReturnValue(true),
    // 模拟 transport/api/pending.resolveEnvelope 行为（收尾 6 R2/ES1）：route-inbound 委托
    // envelope 展开到 pending 层（code 提取 + details.detail → Error），此处转发到 reject/resolve。
    // 真实实现单测在 transport/api/__tests__/pending.test.ts。
    resolveEnvelope: vi.fn(),
  }
  m.resolveEnvelope.mockImplementation((msg: ServerMessage) => {
    if (msg.type === 'error') {
      const payload = msg.payload as { code?: string; message?: string; details?: { detail?: unknown } }
      const message = typeof payload.message === 'string' ? payload.message : 'request failed'
      const code = typeof payload.code === 'string' ? payload.code : 'unknown'
      const enriched: Record<string, unknown> = { code }
      const d = payload.details?.detail
      if (typeof d === 'string') {
        enriched.cwd = d
      } else if (d && typeof d === 'object') {
        Object.assign(enriched, d)
      }
      m.reject(msg.id!, Object.assign(new Error(message), enriched))
    } else {
      m.resolve(msg.id!, msg.payload)
    }
  })
  return m
})
// ── events mock：捕获 dispatchSession/dispatchGlobal ────────────────
const eventsMock = vi.hoisted(() => ({
  dispatchSession: vi.fn(),
  dispatchGlobal: vi.fn(),
  dispatchCrossSession: vi.fn(),
}))
// ── subscribe mock（subscribeSession reconcile 用）──────────────────
const subscribeMock = vi.hoisted(() => ({
  subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
}))
// 来源节原在 src/transport/__tests__/，spec '../ws-client' 搬入本目录后悬空
// （解析到不存在的 src/ws-client），mock 失效令 init 走真 connect 触发 getPlatform
// fail-fast——按产物位置重写为 '../transport/ws-client'
vi.mock('../transport/ws-client', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
  getState: () => mockStateRef,
  setRestarting: vi.fn(),
  setFailed: vi.fn(),
  onMessage: (cb: (msg: ServerMessage) => void) => {
    inboundHandler = cb
    return () => {
      inboundHandler = null
    }
  },
  onQueueDrop: vi.fn(() => () => {}),
}))
// 以下三个 spec 同因来源节目录搬迁而指错（'../api/*' 从本目录解析到 src/api 门面族，
// 被测链消费的是 src/transport/api/*）——按产物位置重写
vi.mock('../transport/api/pending', () => pendingMock)
vi.mock('../transport/api/events', () => eventsMock)
vi.mock('../transport/api/domains/session', () => ({ subscribe: subscribeMock.subscribe }))

// ======== 来源：route-inbound.test.ts ========
describe("route-inbound", () => {
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

    it('Q1-4c 原型成员名 type（constructor/toString）不误命中路由表（hasOwnProperty 检查）', () => {
      const ports = makePorts()
      const effects = makeEffects()
      const dispatcher = configureRouteInbound(ports, effects)

      // 裸 Record 下标访问会命中 Object 原型成员（truthy 但无 handle → TypeError）。
      // hasOwn 检查后语义与旧 .find 严格等价：视为未注册 type。
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

    it('⑩c extension.dialog（点号）命中 crossSession 声明条目 → dispatchCrossSession', () => {
      // 点号是 runtime wire 实际格式（event-adapter.ts），ADR 文档冒号为笔误
      const ports = makePorts()
      const dispatcher = configureRouteInbound(ports)
      dispatcher(sessionMsg('extension.dialog', { requestId: 'r', dialogKind: 'input' }))
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'extension.dialog' }),
      )
    })

    it('⑩c2 canvas.updated（带归属 sid 的失效广播）命中 crossSession 声明条目 → dispatchCrossSession', () => {
      // session-store-layout-inversion D4：payload 带归属 sessionId，按形状进 session 通道；
      // 消费方 use-canvas-sync 模块级单订阅在 crossSession 通道（广播腿修复，L4 inspect 暴露）
      const ports = makePorts()
      const dispatcher = configureRouteInbound(ports)
      dispatcher(sessionMsg('canvas.updated', { canvasId: 'cvs-x', sessionId: 's1', evType: 'CanvasCreated', eventId: '1', summary: '' }))
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'canvas.updated' }),
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

    it('⑩g extension:requestsInvalidated（P2-2 失效链）命中 crossSession 声明条目 → dispatchCrossSession', () => {
      // D-recheck2-1 回归锚：帧经 bridge EXTENSION_HANDLERS 归一为 'requests-invalidated'
      // 事件（useExtensionUI 摘审批条），但 bridge 壳只订阅 onGlobal/onCrossSession——
      // 本表漏声明 crossSession 则帧只进 session 通道，解析器永收不到，审批条僵尸 ready 残留。
      // payload 带 sessionId → 必须走有 sid 分支的 crossSession 双通道。
      const ports = makePorts()
      const dispatcher = configureRouteInbound(ports)
      dispatcher(
        sessionMsg('extension:requestsInvalidated', {
          sessionId: 's1',
          requestIds: ['pr-1'],
          reason: 'turn-aborted',
        }),
      )
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledTimes(1)
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'extension:requestsInvalidated' }),
      )
    })

    it('⑩f 全量 crossSession 声明条目 type 字面量逐项命中（防拼写回归）', () => {
      // 逐项锁 route-inbound.ts 的 crossSession 声明条目 type 全集（ROUTE_TABLE 虽已导出，
      // 但遍历其键会自我引用，锁不住源码侧拼写漂移——测试内字面量逐项断言才能钉住）。
      // 任一成员拼写漂移（如 extension.dialog 误写成冒号）→ dispatchCrossSession 不再被调
      const literals = [
        'extension:widget',
        'extension:widgetGui',
        'extension:notify',
        'extension.dialog',
        'extension:requestsInvalidated',
        'plugin:uiRequest',
        'plugin:viewUpdate',
        'plugin:headerActionUpdate',
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
      dispatcher(sessionMsg('extension:widget', { widgetKey: 'w', lines: ['l1'] }))
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledTimes(1)
      // 骨架条目只声明 crossSession（无 sessionEffect/payloadGuard）：任何 effect 不触发
      expect(effects.onSessionExited).not.toHaveBeenCalled()
      expect(effects.onSubagents).not.toHaveBeenCalled()
      expect(effects.onSessionError).not.toHaveBeenCalled()
      expect(effects.onGlobalError).not.toHaveBeenCalled()
      // 声明形状锁定：条目是纯声明式数据（crossSession 布尔 + 跳过型检查函数），无 handle 函数体
      expect(ROUTE_TABLE['extension:widget']).toEqual({ crossSession: true })
      expect(ROUTE_TABLE['session.subagents']).toEqual({
        payloadGuard: expect.any(Function),
        sessionEffect: expect.any(Function),
      })
    })

    it('D2-b payloadGuard 坏形状 → 跳过 sessionEffect，dispatchSession/crossSession 分发照常（检查只门控 effect）', () => {
      // 探针条目经导出清单注册（用后清理）：同时声明 crossSession + payloadGuard，
      // 验证检查失败时分发不受门控（D2「payloadGuard 不门控分发」显式条款）
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
        expect(ports.events.dispatchCrossSession).toHaveBeenCalledTimes(1) // crossSession 分发不被检查门控
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

    it('B-2 globalEffect 内 !msg.id 检查：error 无 sid 但带 id 未命中 pending（如迟到 reply 广播形态）→ dispatchGlobal 照常、不 onGlobalError', () => {
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
      expect(effects.onGlobalError).not.toHaveBeenCalled() // 检查拒绝：带 id 不 toast
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

  // D3「缺省真实模块直连」节剔出本产物保留独立（route-inbound-default-ports.test.ts）：
  // 该节测缺省不传 ports 时 pending 分流走真实模块单例，与本文件为 use-connection-seq-gap
  // 节设的 transport/api/pending 文件级 mock 结构性不相容（文件级 mock 无法按节分流）。
});

// ======== 来源：subscription-replay.test.ts ========
describe("subscription-replay", () => {
  type SubscribeReply = Awaited<ReturnType<TransportPorts['subscribe']>>

  function makePorts(): TransportPorts {
    return {
      pending: {
        resolve: vi.fn(),
        reject: vi.fn(),
        rejectAll: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        resolveEnvelope: vi.fn(),
      },
      events: {
        dispatchSession: vi.fn(),
        dispatchGlobal: vi.fn(),
        dispatchCrossSession: vi.fn(),
      },
      subscribe: vi.fn(),
    }
  }

  function makeEffects(): InboundEffects {
    return {
      onSessionExited: vi.fn(),
      onMessageComplete: vi.fn(),
      onSubagents: vi.fn(),
      onWorkflowUpdate: vi.fn(),
      onGlobalError: vi.fn(),
    }
  }

  /** 已 dispatch 到 session 通道的消息 seq 序列（断言辅助） */
  function dispatchedSeqs(ports: TransportPorts): Array<number | undefined> {
    return (ports.events.dispatchSession as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1].seq)
  }

  function setup() {
    const ports = makePorts()
    const effects = makeEffects()
    const dispatcher = configureRouteInbound(ports, effects)
    return { ports, effects, dispatcher }
  }

  describe('A. 回放 seq 去重（gap 触发消息不重复实体）', () => {
    beforeEach(() => {
      resetSubscriptionStates()
      vi.restoreAllMocks()
    })

    it('A1: gap 触发消息（live 已 dispatch）在 reconcile snapshot 回放中被 drop——message_start 只 dispatch 一次', async () => {
      const { ports, dispatcher } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      // initial subscribe 建基线 10（空回放）
      subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
      await subscribeSession('s1')

      // reconcile reply：fromSeq=10 排他下界，snapshot 必含触发消息 seq=13 本身
      subscribe.mockResolvedValueOnce({
        snapshot: [msg(11), msg(12), msg(13, 'message.message_start')],
        stateSnapshot: [],
        lastSeq: 13,
      })

      // live gap：seq 13 > 10+1 → dispatch 当前消息 + fire-and-forget reconcile
      dispatcher(msg(13, 'message.message_start'))

      await vi.waitFor(() => {
        // live 1 次（13）+ 回放缺失段 2 次（11、12）；触发消息 13 的回放被 gapDispatchedSeqs drop
        expect(dispatchedSeqs(ports)).toEqual([13, 11, 12])
      })
      // message_start 二连击只产生一次实体：seq=13 恰好 dispatch 一次
      expect(dispatchedSeqs(ports).filter((s) => s === 13)).toHaveLength(1)
      // 基线收敛到 13（缺失段递进 + 收敛公式）
      await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13))
      // 收敛后簿记清理（基线已覆盖）
      expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toBeUndefined()
    })

    it('A2: 多条 gap 触发消息（15、17）都靠簿记 drop，缺失段 11-14/16 补齐', async () => {
      const { ports, dispatcher } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
      await subscribeSession('s1')

      // reconcile 挂起：两条 gap 消息先后到达（in-flight 去重合并为同一次 RPC）
      let resolveReconcile!: (v: SubscribeReply) => void
      subscribe.mockImplementation(() => new Promise<SubscribeReply>((resolve) => { resolveReconcile = resolve }))

      dispatcher(msg(15)) // gap：dispatch + 记簿记 + reconcile(fromSeq=10)
      dispatcher(msg(17)) // gap：dispatch + 记簿记 + reconcile（复用 in-flight）
      expect(dispatchedSeqs(ports)).toEqual([15, 17])

      // ring 现已含 11..17（fromSeq=10 全量）
      resolveReconcile({ snapshot: [msg(11), msg(12), msg(13), msg(14), msg(15), msg(16), msg(17)], stateSnapshot: [], lastSeq: 17 })
      await vi.waitFor(() => {
        // 缺失段递进 dispatch；15、17 已 live dispatch 过 → 簿记 drop
        expect(dispatchedSeqs(ports)).toEqual([15, 17, 11, 12, 13, 14, 16])
      })
      await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(17))
    })

    it('A3: stateSnapshot 与 snapshot 同 seq 重叠（state topic 消息在 ring 内）只回放一次；溢出的旧 last-value 保留', async () => {
      const { ports } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      // initial subscribe（subscribed=false 兼容路径：evalSeqGap 全 pass，去重只靠回放内
      // replayedSeqs 簿记——这正是本用例锁定的机制）
      const subagentsInRing = msg(25, 'session.subagents', { subagents: [{ id: 'sa-1', status: 'done' }] })
      const staleLastValue = msg(5, 'session.context', { tokens: 42 })
      subscribe.mockResolvedValueOnce({
        snapshot: [msg(21), subagentsInRing],
        stateSnapshot: [subagentsInRing, staleLastValue],
        lastSeq: 25,
      })

      await subscribeSession('s1')

      // seq 25（snapshot 与 stateSnapshot 重叠）只 dispatch 一次；seq 5（ring 溢出仅剩
      // last-value）正常回放——ADR-0055 stateSnapshot 注入语义不因去重误伤
      expect(dispatchedSeqs(ports)).toEqual([21, 25, 5])
      expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(25)
    })
  })

  describe('B. 回放帧触发 ROUTE_TABLE effects 与 crossSession 分发', () => {
    beforeEach(() => {
      resetSubscriptionStates()
      vi.restoreAllMocks()
    })

    it('B1: resubscribeAll 回放 stateSnapshot 的 session.subagents → dispatchSession + onSubagents（重连后非活跃 session 终态恢复）', async () => {
      const { ports, effects } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      // 断线前已订阅（基线 20，空回放）
      subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 20 })
      await subscribeSession('s1')

      // 重连：resubscribeAll 捕获 fromSeq=20 重置条目后重发；runtime 断线期间 ring 溢出，
      // subagents last-value（旧 seq 5）只存于 stateSnapshot
      subscribe.mockResolvedValueOnce({
        snapshot: [msg(21)],
        stateSnapshot: [msg(5, 'session.subagents', { subagents: [{ id: 'sa-1', status: 'done' }] })],
        lastSeq: 21,
      })
      resubscribeAll()

      await vi.waitFor(() => {
        // stateSnapshot 帧 dispatchSession（session 通道）...
        expect(ports.events.dispatchSession).toHaveBeenCalledWith(
          's1',
          expect.objectContaining({ type: 'session.subagents', seq: 5 }),
        )
      })
      // ...且触发 onSubagents 兜底（侧栏 subagent 终态更新，修复「永久卡 running」）
      expect(effects.onSubagents).toHaveBeenCalledWith('s1', [{ id: 'sa-1', status: 'done' }])
      await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(21))
    })

    it('B2: 回放的 message.complete（snapshot 内）触发 onMessageComplete', async () => {
      const { ports, effects } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      subscribe.mockResolvedValueOnce({
        snapshot: [msg(11, 'message.complete', { stopReason: 'stop' })],
        stateSnapshot: [],
        lastSeq: 11,
      })
      await subscribeSession('s1')
      expect(ports.events.dispatchSession).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ type: 'message.complete' }),
      )
      expect(effects.onMessageComplete).toHaveBeenCalledWith('s1', { sessionId: 's1', stopReason: 'stop' })
    })

    it('B3: 回放的 session.exited（snapshot 内）触发 onSessionExited', async () => {
      const { ports, effects } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      subscribe.mockResolvedValueOnce({
        snapshot: [msg(11, 'session.exited', { code: 0, reason: 'done' })],
        stateSnapshot: [],
        lastSeq: 11,
      })
      await subscribeSession('s1')
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
      expect(effects.onSessionExited).toHaveBeenCalledWith('s1', { sessionId: 's1', code: 0, reason: 'done' })
    })

    it('B4: 回放的 extension:widget（crossSession 声明条目）→ dispatchSession + dispatchCrossSession', async () => {
      const { ports } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      subscribe.mockResolvedValueOnce({
        snapshot: [msg(11, 'extension:widget', { widgetKey: 'w', lines: [] })],
        stateSnapshot: [],
        lastSeq: 11,
      })
      await subscribeSession('s1')
      // 与 live 同语义：session 通道 + crossSession 通道（ExtensionHost 全局单例消费者）
      expect(ports.events.dispatchSession).toHaveBeenCalledWith('s1', expect.objectContaining({ type: 'extension:widget' }))
      expect(ports.events.dispatchCrossSession).toHaveBeenCalledWith(expect.objectContaining({ type: 'extension:widget' }))
    })
  })

  describe('C. live 路径回归（行为不变）', () => {
    beforeEach(() => {
      resetSubscriptionStates()
      vi.restoreAllMocks()
    })

    it('C1: 正常递进消息不双 dispatch、不触发 reconcile', async () => {
      const { ports, dispatcher } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
      await subscribeSession('s1')

      dispatcher(msg(11))
      dispatcher(msg(12))
      expect(dispatchedSeqs(ports)).toEqual([11, 12])
      expect(subscribe).toHaveBeenCalledTimes(1) // 仅 initial，无 reconcile
      expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(12)
    })

    it('C2: gap 触发消息在基线推进前重复到达（重发/乱序）→ 簿记 drop，不重复 dispatch', async () => {
      const { ports, dispatcher } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
      await subscribeSession('s1')

      // reconcile 挂起，基线停在 10（MF-3：gap 路径不推进）
      let resolveReconcile!: (v: SubscribeReply) => void
      subscribe.mockImplementation(() => new Promise<SubscribeReply>((resolve) => { resolveReconcile = resolve }))

      dispatcher(msg(13)) // gap：dispatch + 簿记
      dispatcher(msg(13)) // 重复到达：seq 13 > 基线 10（常规去重不覆盖）→ 靠簿记 drop
      expect(dispatchedSeqs(ports)).toEqual([13])

      resolveReconcile({ snapshot: [msg(11), msg(12), msg(13)], stateSnapshot: [], lastSeq: 13 })
      await vi.waitFor(() => {
        // 回放补缺失段 11、12；触发消息 13 不二连击
        expect(dispatchedSeqs(ports)).toEqual([13, 11, 12])
      })
      await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13))
    })

    it('C3: reconcile 回复空 snapshot（缺失段已不在 ring）也收敛基线并清空簿记，后续 live 正常递进', async () => {
      const { ports, dispatcher } = setup()
      const subscribe = ports.subscribe as ReturnType<typeof vi.fn>
      subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
      await subscribeSession('s1')

      subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 13 })
      dispatcher(msg(13)) // gap：dispatch + 簿记 + reconcile（ring 溢出拉不回 11、12）
      await vi.waitFor(() => expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13))
      // 簿记已清理：后续同 seq 重复由常规 seq<=lastSeenSeq 去重接管
      dispatcher(msg(13))
      expect(dispatchedSeqs(ports)).toEqual([13])
      // 后续 live 消息正常递进（基线已跟上 ring 末尾）
      dispatcher(msg(14))
      expect(dispatchedSeqs(ports)).toEqual([13, 14])
    })
  })
});

// ======== 来源：subscription-state-seq-gate.test.ts ========
describe("subscription-state-seq-gate", () => {
  function setup() {
    const subscribe = vi.fn() as Mock<TransportPorts['subscribe']>
    const replay = vi.fn()
    setSubscriptionPorts({ subscribe, replay })
    return { subscribe, replay }
  }

  /** 建立基线 10 的已订阅 session（initial subscribe，空回放） */
  async function seedBaseline10(subscribe: Mock<TransportPorts['subscribe']>): Promise<void> {
    subscribe.mockResolvedValueOnce({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
    await subscribeSession('s1')
    expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 10, subscribed: true })
  }

  describe('seqGate — MF-3 接口级钉住（判定 + 簿记 + 基线配对）', () => {
    beforeEach(() => {
      resetSubscriptionStates()
      vi.restoreAllMocks()
    })

    it('1. gap 消息序列 → reconcile 意图（fromSeq=基线）+ 簿记配对（写入/drop/递进清理）', async () => {
      const { subscribe } = setup()
      await seedBaseline10(subscribe)

      // gap：seq 13 > 10+1 → dispatch + reconcile 意图（fromSeq = 基线 10，排他下界非 12）
      expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })
      // 簿记写入与意图配对：触发消息已 dispatch 但基线未推进（MF-3）
      expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toEqual(new Set([13]))
      expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(10)

      // 第二条 gap（reconcile 未完成，基线仍 10）：同样配对
      expect(seqGate('s1', { seq: 15 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })
      expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toEqual(new Set([13, 15]))

      // 触发消息重复到达（seq 超前于基线，常规去重覆盖不到）→ 簿记 drop（PR #175 R1）
      expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'drop' })

      // 正常递进 seq=11（=10+1）→ dispatch 无 reconcile 意图 + 基线推进 11
      expect(seqGate('s1', { seq: 11 })).toEqual({ action: 'dispatch' })
      expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(11)
      // 簿记清理配对：<= 新基线的条目已无独立价值（常规 seq 去重接管），超前条目（13、15）保留
      expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toEqual(new Set([13, 15]))
    })

    it('2. reconcile 失败 → 基线原位不动（MF-3 回归钉住）+ 簿记去重仍生效 + 自愈重试可用', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { subscribe } = setup()
      await seedBaseline10(subscribe)

      // gap 触发：gate 给出 reconcile 意图 + 写簿记
      expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })

      // 模拟 route-inbound 的 fire-and-forget reconcile 触发（applySeqGap 的唯一剩余职责）
      subscribe.mockRejectedValueOnce(new Error('network flap'))
      await subscribeSession('s1', 10)
      expect(warnSpy).toHaveBeenCalled() // ES2：失败 console.warn 消化，不抛不挂起

      // MF-3 钉住：reconcile 失败后基线原位（若 gate 曾提前推进到 13，缺失段 11-12 永久不可恢复）
      expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(10)
      expect(getSubscriptionState('s1')?.subscribed).toBe(true)
      // 簿记不受失败影响：触发消息重复到达仍 drop（去重语义在失败路径保持配对）
      expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toEqual(new Set([13]))
      expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'drop' })

      // 自愈重试：基线原位 → 后续新 gap 消息再次给出 reconcile 意图（fromSeq 仍是基线 10）
      expect(seqGate('s1', { seq: 14 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })
      warnSpy.mockRestore()
    })

    it('3. reconcile 成功 → 基线 max() 收敛推进 + 簿记清理（失败原位的对照面）', async () => {
      const { subscribe, replay } = setup()
      await seedBaseline10(subscribe)

      expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'dispatch', reconcileFromSeq: 10 })

      // reconcile 成功：缺失段（11、12）+ 触发消息（13）都在回放 snapshot 内
      subscribe.mockResolvedValueOnce({
        snapshot: [
          { type: 'session.compacted', seq: 11, payload: { sessionId: 's1' } },
          { type: 'session.compacted', seq: 12, payload: { sessionId: 's1' } },
          { type: 'session.compacted', seq: 13, payload: { sessionId: 's1' } },
        ],
        stateSnapshot: [],
        lastSeq: 13,
      })
      await subscribeSession('s1', 10)
      expect(replay).toHaveBeenCalledTimes(3)

      // 基线收敛到 13（>= 触发消息 seq，不回退）；簿记清理（基线已覆盖）
      expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(13)
      expect(getSubscriptionState('s1')?.gapDispatchedSeqs).toBeUndefined()
      // 收敛后重复到达由常规 seq<=lastSeenSeq 去重接管（无需簿记）
      expect(seqGate('s1', { seq: 13 })).toEqual({ action: 'drop' })
    })
  })
});

// ======== 来源：subscription-state.test.ts ========
describe("subscription-state", () => {
  function makeMsg(seq: number, type = 'session.ping'): ServerMessage {
    return { type: type as ServerMessage['type'], seq, payload: { sessionId: 's1' } }
  }

  function setup() {
    // TransportPorts['subscribe'] 形状的 mock（resolve 形状在用例内 mockResolvedValue 给定）
    const subscribe = vi.fn() as Mock<TransportPorts['subscribe']>
    const replay = vi.fn()
    setSubscriptionPorts({ subscribe, replay })
    return { subscribe, replay }
  }

  describe('subscribeSession', () => {
    beforeEach(() => {
      resetSubscriptionStates()
      vi.restoreAllMocks()
    })

    it('① 幂等检查：已 subscribed 且 fromSeq undefined → 直接 return（subscribe 不被重复调用）', async () => {
      const { subscribe } = setup()
      subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await subscribeSession('s1')
      await subscribeSession('s1')
      await subscribeSession('s1')
      expect(subscribe).toHaveBeenCalledTimes(1)
      expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 5, subscribed: true })
    })

    it('①b 并发 initial subscribe 去重（MF-2）：in-flight 期间重复调用复用同一 Promise（subscribe 只调一次）', async () => {
      const { subscribe } = setup()
      // 挂起第一个 subscribe，制造「检查通过后、await 前」的并发窗口
      let resolveFirst!: (v: { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number }) => void
      subscribe.mockImplementation(
        () => new Promise((resolve) => { resolveFirst = resolve }),
      )
      const p1 = subscribeSession('s1')
      const p2 = subscribeSession('s1')
      expect(subscribe).toHaveBeenCalledTimes(1) // 第二个复用 in-flight，不发重复 RPC
      resolveFirst({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await Promise.all([p1, p2])
      expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 5, subscribed: true })
      // resolve 后再调 → subscribed 检查拦截，仍不重复 RPC
      await subscribeSession('s1')
      expect(subscribe).toHaveBeenCalledTimes(1)
    })

    it('①c gap backfill 不被 initial subscribe 互吞（MF-2）：不同 fromSeq 各发各的 RPC', async () => {
      const { subscribe } = setup()
      const resolvers: Array<(v: { snapshot: ServerMessage[]; stateSnapshot: ServerMessage[]; lastSeq: number }) => void> = []
      subscribe.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve) }))
      const p1 = subscribeSession('s1') // initial（fromSeq undefined）in-flight
      const p2 = subscribeSession('s1', 10) // gap backfill（fromSeq 显式）不得互吞
      expect(subscribe).toHaveBeenCalledTimes(2)
      resolvers[0]({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      resolvers[1]({ snapshot: [], stateSnapshot: [], lastSeq: 10 })
      await Promise.all([p1, p2])
      expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 10, subscribed: true }) // max(5, 10)
    })

    it('② fromSeq 显式传入 → 跳过幂等检查发 RPC（reconcile backfill，即使已 subscribed）', async () => {
      const { subscribe } = setup()
      subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await subscribeSession('s1') // 首次订阅
      await subscribeSession('s1', 7) // gap reconcile：即使已 subscribed 也发 RPC
      expect(subscribe).toHaveBeenCalledTimes(2)
      expect(subscribe).toHaveBeenLastCalledWith('s1', 7)
    })

    it('③ snapshot/stateSnapshot 依次回放 replay 端口', async () => {
      const { subscribe, replay } = setup()
      subscribe.mockResolvedValue({
        snapshot: [makeMsg(1), makeMsg(2)],
        stateSnapshot: [makeMsg(3, 'session.commands'), makeMsg(4, 'session.context')],
        lastSeq: 10,
      })
      await subscribeSession('s1')
      expect(replay).toHaveBeenCalledTimes(4)
      expect(replay.mock.calls.map((c) => c[1].seq)).toEqual([1, 2, 3, 4])
      // 全部以 sessionId 路由
      for (const call of replay.mock.calls) {
        expect(call[0]).toBe('s1')
      }
    })

    it('④ lastSeenSeq = max(reply.lastSeq, maxSnapshotSeq, maxStateSnapshotSeq, prevLastSeen)', async () => {
      const { subscribe } = setup()
      // 场景 A：reply.lastSeq 最大
      subscribe.mockResolvedValue({
        snapshot: [makeMsg(2)],
        stateSnapshot: [makeMsg(1)],
        lastSeq: 10,
      })
      await subscribeSession('s1')
      expect(getSubscriptionState('s1')?.lastSeenSeq).toBe(10)

      // 场景 B：snapshot seq 最大（ring 溢出场景：lastSeq 小于已 dispatch 的 snapshot seq）
      resetSubscriptionStates()
      subscribe.mockResolvedValue({
        snapshot: [makeMsg(50), makeMsg(51)],
        stateSnapshot: [],
        lastSeq: 30,
      })
      await subscribeSession('s2')
      expect(getSubscriptionState('s2')?.lastSeenSeq).toBe(51)

      // 场景 C：prevLastSeen 最大（reconcile 期间 live 消息已推进基线，不回落）
      subscribe.mockResolvedValue({
        snapshot: [],
        stateSnapshot: [],
        lastSeq: 3,
      })
      await subscribeSession('s3') // lastSeenSeq=3
      updateLastSeenSeq('s3', 20) // live 推进到 20
      await subscribeSession('s3', 5) // reconcile 回拉，reply.lastSeq=3 < 20
      expect(getSubscriptionState('s3')?.lastSeenSeq).toBe(20)
    })

    it('⑤ subscribe RPC 失败 → console.warn + 不标记 subscribed（意图条目留存，下次可重试）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { subscribe } = setup()
      subscribe.mockRejectedValue(new Error('connection lost'))
      await subscribeSession('s1')
      expect(warnSpy).toHaveBeenCalled()
      // M1/W09 follow-up：失败时留存 subscribed=false 的意图条目（供 WS 重连后 resubscribeAll
      // 重发），gap 检测走兼容路径（evalSeqGap 分支 1/2），行为与「无条目」一致
      expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 0, subscribed: false })
      // 重试成功
      subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 8 })
      await subscribeSession('s1')
      expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 8, subscribed: true })
      warnSpy.mockRestore()
    })

    it('防御：端口未注入时 console.warn + 不崩（不标记 subscribed）', async () => {
      // 隔离模块实例（其他用例已 setSubscriptionPorts 注入，模块级状态被污染）
      vi.resetModules()
      const fresh = await import('./subscription-state')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await fresh.subscribeSession('s1')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not injected'))
      expect(fresh.getSubscriptionState('s1')).toBeUndefined()
      warnSpy.mockRestore()
    })
  })

  describe('getSubscriptionState / clearSubscription / updateLastSeenSeq / resetSubscriptionStates', () => {
    beforeEach(() => {
      resetSubscriptionStates()
      vi.restoreAllMocks()
    })

    it('getSubscriptionState：未订阅返回 undefined；订阅后返回 state', async () => {
      const { subscribe } = setup()
      expect(getSubscriptionState('s1')).toBeUndefined()
      subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
      await subscribeSession('s1')
      expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 1, subscribed: true })
    })

    it('clearSubscription：删除后 getSubscriptionState 返回 undefined', async () => {
      const { subscribe } = setup()
      subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
      await subscribeSession('s1')
      clearSubscription('s1')
      expect(getSubscriptionState('s1')).toBeUndefined()
    })

    it('updateLastSeenSeq：更新基线（仅 lastSeenSeq，不动 subscribed）；state 不存在 no-op', async () => {
      const { subscribe } = setup()
      subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
      await subscribeSession('s1')
      updateLastSeenSeq('s1', 42)
      expect(getSubscriptionState('s1')).toEqual({ lastSeenSeq: 42, subscribed: true })
      // state 不存在 → no-op 不崩
      expect(() => updateLastSeenSeq('ghost', 1)).not.toThrow()
    })

    it('resetSubscriptionStates：清空全部 Map', async () => {
      const { subscribe } = setup()
      subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 1 })
      await subscribeSession('s1')
      await subscribeSession('s2')
      resetSubscriptionStates()
      expect(getSubscriptionState('s1')).toBeUndefined()
      expect(getSubscriptionState('s2')).toBeUndefined()
    })
  })

  /**
 * evalSeqGap 六分支全覆盖（F7，TC-1；原 seq-gap.test.ts 逐字并入，D1 归位）。
 *
 * IF3 契约六分支：
 * ① state undefined → pass（无副作用）
 * ② state.subscribed=false → pass
 * ③ msg.seq 非 number → pass
 * ④ seq <= lastSeenSeq → drop（重复/乱序丢弃）
 * ⑤ seq > lastSeenSeq+1 → pass + reconcileFromSeq: lastSeenSeq（gap；subscribe fromSeq 是排他下界）
 * ⑥ seq === lastSeenSeq+1 → pass（正常递进，无 reconcileFromSeq）
 *
 * 纯函数零 mock：直接 import 调用断言返回值。
 */
  const subscribed: SubscriptionState = { lastSeenSeq: 10, subscribed: true }

  describe('evalSeqGap', () => {
    it('分支①：state undefined → pass（无副作用）', () => {
      expect(evalSeqGap({ seq: 5 }, undefined)).toEqual({ action: 'pass' })
      expect(evalSeqGap({ seq: 11 }, undefined)).toEqual({ action: 'pass' })
      expect(evalSeqGap({}, undefined)).toEqual({ action: 'pass' })
    })

    it('分支②：state.subscribed=false → pass（兼容路径不 gap 检测）', () => {
      const notSubscribed: SubscriptionState = { lastSeenSeq: 10, subscribed: false }
      expect(evalSeqGap({ seq: 5 }, notSubscribed)).toEqual({ action: 'pass' })
      expect(evalSeqGap({ seq: 100 }, notSubscribed)).toEqual({ action: 'pass' })
    })

    it('分支③：msg.seq 非 number → pass（无 gap 语义）', () => {
      expect(evalSeqGap({}, subscribed)).toEqual({ action: 'pass' })
      expect(evalSeqGap({ seq: undefined }, subscribed)).toEqual({ action: 'pass' })
    })

    it('分支④：seq <= lastSeenSeq → drop（reconcile 回放重复/乱序）', () => {
      expect(evalSeqGap({ seq: 10 }, subscribed)).toEqual({ action: 'drop' })
      expect(evalSeqGap({ seq: 3 }, subscribed)).toEqual({ action: 'drop' })
      expect(evalSeqGap({ seq: 0 }, subscribed)).toEqual({ action: 'drop' })
    })

    it('分支⑤：seq > lastSeenSeq+1 → pass + reconcileFromSeq: lastSeenSeq（gap 回拉，排他下界覆盖缺失段）', () => {
      // runtime session.subscribe 的 fromSeq 是排他下界（只返 seq > fromSeq）：
      // 传 lastSeenSeq（而非 seq-1）才能取回 lastSeenSeq+1..seq-1 的整个缺失段（MF-1）。
      expect(evalSeqGap({ seq: 12 }, subscribed)).toEqual({ action: 'pass', reconcileFromSeq: 10 })
      expect(evalSeqGap({ seq: 20 }, subscribed)).toEqual({ action: 'pass', reconcileFromSeq: 10 })
    })

    it('分支⑥：seq === lastSeenSeq+1 → pass（正常递进，无 reconcileFromSeq）', () => {
      expect(evalSeqGap({ seq: 11 }, subscribed)).toEqual({ action: 'pass' })
      expect(evalSeqGap({ seq: 10 + 1 }, subscribed)).toEqual({ action: 'pass' })
    })

    it('边界：lastSeenSeq=0（无历史）时 seq=1 正常递进、seq=2 gap', () => {
      const fresh: SubscriptionState = { lastSeenSeq: 0, subscribed: true }
      expect(evalSeqGap({ seq: 1 }, fresh)).toEqual({ action: 'pass' })
      expect(evalSeqGap({ seq: 2 }, fresh)).toEqual({ action: 'pass', reconcileFromSeq: 0 })
      expect(evalSeqGap({ seq: 0 }, fresh)).toEqual({ action: 'drop' })
    })
  })
});

// ======== 来源：respawn-notice.test.ts ========
describe("respawn-notice", () => {
  function makePorts(): TransportPorts {
    return {
      pending: {
        resolve: vi.fn(),
        reject: vi.fn(),
        rejectAll: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        resolveEnvelope: vi.fn(),
      },
      events: {
        dispatchSession: vi.fn(),
        dispatchGlobal: vi.fn(),
        dispatchCrossSession: vi.fn(),
      },
      subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0, gap: false }),
    }
  }

  function sessionMsg(type: string, payload: Record<string, unknown>): ServerMessage {
    return { type: type as ServerMessage['type'], payload: { sessionId: 's1', ...payload } } as ServerMessage
  }

  describe('route-inbound：session.restored / session.restoreFailed 条目（u8 D7）', () => {
    beforeEach(() => {
      resetSubscriptionStates()
    })

    it('session.restored → onSessionRestored 回调（sid + payload 透传），dispatchSession 照常', () => {
      const ports = makePorts()
      const effects: InboundEffects = {
        onSessionRestored: vi.fn(),
      }
      const dispatcher = configureRouteInbound(ports, effects)
      dispatcher(sessionMsg('session.restored', { attempts: 1 }))
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
      expect(effects.onSessionRestored).toHaveBeenCalledWith('s1', { sessionId: 's1', attempts: 1 })
    })

    it('session.restoreFailed → onSessionRestoreFailed 回调（willRetry/reason 透传）', () => {
      const ports = makePorts()
      const effects: InboundEffects = {
        onSessionRestoreFailed: vi.fn(),
      }
      const dispatcher = configureRouteInbound(ports, effects)
      dispatcher(sessionMsg('session.restoreFailed', { attempts: 2, willRetry: false, reason: 'attach hard-fail' }))
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
      expect(effects.onSessionRestoreFailed).toHaveBeenCalledWith('s1', {
        sessionId: 's1',
        attempts: 2,
        willRetry: false,
        reason: 'attach hard-fail',
      })
    })

    it('未注册 effects 时条目无害（分发照常、无回调）', () => {
      const ports = makePorts()
      const dispatcher = configureRouteInbound(ports)
      expect(() => dispatcher(sessionMsg('session.restored', { attempts: 1 }))).not.toThrow()
      expect(ports.events.dispatchSession).toHaveBeenCalledTimes(1)
    })
  })

  describe('chat store appendRespawnNotice（u8 提示条写入点）', () => {
    /** store 实例（effectScope 包裹 onScopeDispose 注册，store.test.ts makeStore 同款） */
    let store: ChatStoreInstance
    let dispose: () => void

    beforeEach(() => {
      const scope = effectScope(true)
      store = scope.run(() => createChatStore())!
      dispose = () => scope.stop()
    })

    afterEach(() => {
      dispose()
    })

    it('restored 形态：customType/variant/liveOnly/display/fallback 文本齐备，追加到消息流', () => {
      store.appendRespawnNotice('s1', 'restored', 'fallback restored text')
      const messages = store.getMessages('s1')
      expect(messages).toHaveLength(1)
      const notice = messages[0]
      expect(notice.role).toBe('system')
      expect(notice.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
      expect(notice.details).toEqual({ variant: 'restored' })
      expect(notice.liveOnly).toBe(true)
      expect(notice.display).toBe(true)
      expect(notice.content).toBe('fallback restored text')
      expect(notice.status).toBe('complete')
      expect(notice.id.startsWith('sys-')).toBe(true)
    })

    it('restoreFailed 形态：variant 透传（渲染方据此切失败态 + 重试按钮）', () => {
      store.appendRespawnNotice('s1', 'restoreFailed', 'fallback failed text')
      const notice = store.getMessages('s1')[0]
      expect(notice.details).toEqual({ variant: 'restoreFailed' })
      expect(notice.content).toBe('fallback failed text')
    })

    it('追加不覆盖既有消息（append 语义，与 appendSystemNotice 同款）', () => {
      store.appendRespawnNotice('s1', 'restored', 'first')
      store.appendRespawnNotice('s1', 'restoreFailed', 'second')
      const messages = store.getMessages('s1')
      expect(messages).toHaveLength(2)
      expect(messages[1].content).toBe('second')
    })
  })

  describe('chat store respawnPending 过渡态分区（crash-resilience T4 回流修复）', () => {
    /** store 实例（effectScope 包裹，上方 describe 同款） */
    let store: ChatStoreInstance
    let dispose: () => void

    beforeEach(() => {
      const scope = effectScope(true)
      store = scope.run(() => createChatStore())!
      dispose = () => scope.stop()
    })

    afterEach(() => {
      dispose()
    })

    it('mark/clear/is 三件套：默认 false → mark 后 true → clear 后 false', () => {
      expect(store.isRespawnPending('s1')).toBe(false)
      store.markRespawnPending('s1')
      expect(store.isRespawnPending('s1')).toBe(true)
      store.clearRespawnPending('s1')
      expect(store.isRespawnPending('s1')).toBe(false)
    })

    it('mark 幂等（重复 exited 不破坏恢复窗口单语义），clear 对未 pending session no-op', () => {
      store.markRespawnPending('s1')
      store.markRespawnPending('s1')
      expect(store.isRespawnPending('s1')).toBe(true)
      expect(() => store.clearRespawnPending('s-other')).not.toThrow()
      expect(store.isRespawnPending('s1')).toBe(true)
    })

    it('per-session 隔离：A session pending 不影响 B session（Map/Set 分区范式）', () => {
      store.markRespawnPending('s1')
      expect(store.isRespawnPending('s1')).toBe(true)
      expect(store.isRespawnPending('s2')).toBe(false)
    })

    it('disposeSession 同点清理过渡态分区（session 删除后不留恢复窗口残留）', () => {
      store.markRespawnPending('s1')
      expect(store.isRespawnPending('s1')).toBe(true)
      store.disposeSession('s1')
      expect(store.isRespawnPending('s1')).toBe(false)
    })
  })

  describe('chat store respawn 提示条 reconcile 保留（crash-resilience D7 修复：mergeBaselineWithLive 拣回重插）', () => {
    /** store 实例（effectScope 包裹，上方 describe 同款） */
    let store: ChatStoreInstance
    let dispose: () => void

    beforeEach(() => {
      const scope = effectScope(true)
      store = scope.run(() => createChatStore())!
      dispose = () => scope.stop()
    })

    afterEach(() => {
      dispose()
    })

    /** 构造 complete user / assistant 消息（store.test.ts 同款形态，无 piEntryId） */
    const userMsg = (id: string, content = 'hi'): Message => ({ id, role: 'user', content, status: 'complete', timestamp: 1 })
    const completeAssistant = (id: string, content = '回复'): Message => ({ id, role: 'assistant', content, status: 'complete', timestamp: 1 })

    it('插入提示条 → 模拟切入 reconcile（truncated=true 窗口合并）→ 提示条仍在（锚定前驱消息之后）', () => {
      const sid = 's1'
      store.hydrate(sid, [userMsg('m1'), completeAssistant('a1')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
      store.appendRespawnNotice(sid, 'restored', '会话引擎已从崩溃中恢复')
      expect(store.getMessages(sid)).toHaveLength(3)

      // 切入 reconcile：窗口响应覆盖全部分区（windowFirstId=m1 命中分区首位 → 整体合并路径）
      store.reconcileHistory(sid, [userMsg('m1', 'q'), completeAssistant('a1')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
      const msgs = store.getMessages(sid)
      expect(msgs).toHaveLength(3)
      expect(msgs[2]!.id.startsWith('sys-')).toBe(true)
      expect(msgs[2]!.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
      expect(msgs[2]!.liveOnly).toBe(true)
      expect(msgs[2]!.content).toBe('会话引擎已从崩溃中恢复')

      // 再次切入 reconcile：仍恰好一条（拣回幂等，不产生副本）
      store.reconcileHistory(sid, [userMsg('m1', 'q'), completeAssistant('a1')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
      expect(store.getMessages(sid).map((m) => m.id)).toEqual(msgs.map((m) => m.id))
    })

    it('truncated=true 且分区有更早历史（keptEarlier 分支）：提示条在窗口段被拣回，更早历史保留不动', () => {
      const sid = 's2'
      store.hydrate(sid, [userMsg('m1'), userMsg('m2')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 4 })
      store.prependHistory(sid, [userMsg('m-early', '更早')])
      store.appendRespawnNotice(sid, 'restoreFailed', '引擎恢复失败')
      store.reconcileHistory(sid, [userMsg('m1'), userMsg('m2')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 4 })
      const msgs = store.getMessages(sid)
      expect(msgs).toHaveLength(4)
      expect(msgs[0]!.id).toBe('m-early')
      expect(msgs[0]!.content).toBe('更早')
      expect(msgs[3]!.content).toBe('引擎恢复失败')
    })

    it('提示条插入后有新消息（切走再切回、新消息已落盘进基线）：提示条仍锚在原时序位（前驱之后、新消息之前）', () => {
      const sid = 's3'
      store.hydrate(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
      store.appendRespawnNotice(sid, 'restored', '恢复横幅')
      // 提示条之后用户继续对话（live overlay），随后落盘、切入 reconcile 时已在基线内
      store.setMessages(sid, [...store.getMessages(sid), userMsg('u-1', '继续')])
      store.reconcileHistory(sid, [userMsg('m1'), userMsg('pi-u1', '继续')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
      const msgs = store.getMessages(sid)
      // u-1 overlay 与基线 pi-u1 文本同源被去重（内容随基线权威）；[turn-key 身份保留]
      // 分区已建立 id（u-1）带到合并结果；横幅锚定 m1 之后、该消息之前（真实时序）
      expect(msgs.map((m) => m.id)).toEqual(['m1', msgs[1]!.id, 'u-1'])
      expect(msgs[1]!.content).toBe('恢复横幅')
    })

    it('前驱为 live-only overlay（reconcile 后被基线去重，id 保留）：锚命中 → 原时序位锚定，仍恰好一条', () => {
      const sid = 's6'
      store.hydrate(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 2 })
      // 崩溃前用户已发消息（live overlay，尚未落盘），恢复横幅在其后追加（真实时序：overlay → notice）
      store.setMessages(sid, [userMsg('m1'), userMsg('u-1', '继续')])
      store.appendRespawnNotice(sid, 'restored', '恢复横幅')
      // reconcile：u-1 已落盘进基线（pi-u1 同文本）→ overlay 被文本判据去重（内容随基线权威）；
      // [turn-key 身份保留] 合并结果沿用分区已建立 id（u-1）→ 提示条前驱锚命中 → 原时序位锚定
      store.reconcileHistory(sid, [userMsg('m1'), userMsg('pi-u1', '继续')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
      const msgs = store.getMessages(sid)
      expect(msgs).toHaveLength(3)
      // id 序列锚定：u-1 的 id 在结果中保留（去重只换内容不换身份），提示条锚其之后
      expect(msgs.map((m) => m.id)).toEqual(['m1', 'u-1', msgs[2]!.id])
      expect(msgs[2]!.id.startsWith('sys-')).toBe(true)
      expect(msgs[2]!.customType).toBe(PI_RESPAWN_NOTICE_CUSTOM_TYPE)
      expect(msgs[2]!.liveOnly).toBe(true)
      expect(msgs[2]!.content).toBe('恢复横幅')
      // 再次 reconcile：仍恰好一条（拣回幂等，不产生副本）
      store.reconcileHistory(sid, [userMsg('m1'), userMsg('pi-u1', '继续')], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 2 })
      expect(store.getMessages(sid).filter((m) => m.customType === PI_RESPAWN_NOTICE_CUSTOM_TYPE)).toHaveLength(1)
    })

    it('过期提示条（超 5 分钟保留窗口）不再保留（liveOnly 一次性语义，不无限堆积）', () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000)
        const sid = 's4'
        store.hydrate(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
        store.appendRespawnNotice(sid, 'restored', '旧横幅')
        expect(store.getMessages(sid)).toHaveLength(2)
        vi.setSystemTime(1_000 + 5 * 60 * 1000 + 1)
        store.reconcileHistory(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
        expect(store.getMessages(sid).map((m) => m.id)).toEqual(['m1'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('保留范围收窄：非 respawn 的 liveOnly system 消息（stream_warn 形态）切入 reconcile 后仍消失', () => {
      const sid = 's5'
      store.hydrate(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
      store.setMessages(sid, [
        userMsg('m1'),
        { id: 'sys-warn', role: 'system', content: 'stream 超时', status: 'complete', timestamp: Date.now(), liveOnly: true },
      ])
      store.reconcileHistory(sid, [userMsg('m1')], { truncated: true, loadedTurns: 1, totalTurnsEstimate: 1 })
      expect(store.getMessages(sid).map((m) => m.id)).toEqual(['m1'])
    })
  })
});

// ======== 来源：use-connection-seq-gap.test.ts ========
describe("use-connection-seq-gap", () => {
  function makePorts(): ConnectionPorts {
    return {
      ipc: {
        getRuntimeTargetSnapshot: vi.fn().mockResolvedValue(null),
        onRuntimePort: vi.fn().mockReturnValue(() => {}),
        onRuntimeRestarting: vi.fn().mockReturnValue(() => {}),
        onRuntimeFailed: vi.fn().mockReturnValue(() => {}),
        // RD-3#2：启动失败真因消费端口（推送置 failed 短路徒劳重连 + init 拉取兜底）
        onRuntimeError: () => () => {},
        getRuntimeStartError: async () => null,
        restartRuntime: vi.fn().mockResolvedValue(undefined),
      },
      visibility: {
        isVisible: () => true,
        onVisibilityChange: () => () => {},
      },
      // mock 分支：dispatcher 在 mock return 前安装（ensureDispatcher 先于 mock 分支）
      env: { isMock: true, isDev: false },
      effects: {},
      t: vi.fn((key: string) => `[${key}]`),
      onRuntimeUnavailable: vi.fn(),
    }
  }

  // routeInbound 是模块级单例函数（ensureDispatcher 首次安装后 dispatcherInstalled=true，
  // 后续 init 不重装）。beforeAll 安装一次捕获 handler 引用，beforeEach 只清 mock 调用记录 +
  // 重置订阅状态（不重装分发器）。
  let pushInbound: (msg: ServerMessage) => void

  beforeAll(async () => {
    setConnectionPorts(makePorts())
    const { init } = useConnection()
    await init()
    expect(inboundHandler).not.toBeNull()
    pushInbound = (msg: ServerMessage) => inboundHandler!(msg)
  })

  beforeEach(() => {
    resetSubscriptionStates()
    vi.clearAllMocks()
    mockStateRef = ref('disconnected')
    subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 })
  })

  /** 构造带 seq 的 server-push 消息（无 id，live 通道） */
  function liveMsg(seq: number, type = 'message.chunk', sid = 's1'): ServerMessage {
    return { type, seq, payload: { sessionId: sid } } as ServerMessage
  }

  describe('TC3: gap 检测 seq<=lastSeenSeq 丢弃', () => {
    it('seq === lastSeenSeq：不 dispatch（重复）', async () => {
      subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await subscribeSession('s1')
      expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)

      pushInbound(liveMsg(5))

      expect(eventsMock.dispatchSession).not.toHaveBeenCalled()
      // 基线不变（仍 5）
      expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)
    })

    it('seq < lastSeenSeq：不 dispatch（乱序/回退）', async () => {
      subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await subscribeSession('s1')

      pushInbound(liveMsg(3))

      expect(eventsMock.dispatchSession).not.toHaveBeenCalled()
      expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)
    })
  })

  describe('TC5: seq === lastSeenSeq+1 正常递进（不 reconcile）', () => {
    it('seq=6, lastSeenSeq=5：dispatch + 更新基线，不调 subscribe', async () => {
      subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await subscribeSession('s1')

      pushInbound(liveMsg(6))

      expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
      expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s1', liveMsg(6))
      expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(6)
      // subscribe RPC 只被首次 subscribeSession 调过一次（gap 未触发 reconcile）
      expect(subscribeMock.subscribe).toHaveBeenCalledTimes(1)
    })
  })

  describe('TC4: gap 检测 seq>lastSeenSeq+1 触发 reconcile', () => {
    it('seq=8, lastSeenSeq=5：触发 subscribeSession(s1, 5) + 当前 msg 仍 dispatch + 基线不提前推进（MF-3）', async () => {
      subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await subscribeSession('s1')
      vi.clearAllMocks()

      pushInbound(liveMsg(8))

      // 当前 msg 仍 dispatch（gap 期间尽量不丢）
      expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
      expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s1', liveMsg(8))
      // MF-3：基线不提前推进到 8——reconcile RPC 成功前推进基线，失败则缺失段 {6,7} 永久不可恢复
      expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(5)
      // reconcile 触发：subscribeSession(s1, fromSeq=5) 被调（lastSeenSeq=排他下界，覆盖缺失段 {6,7}）。
      // defaultPorts.subscribe 经动态 import 解析（route-inbound 顶部注释），fire-and-forget 的
      // reconcile RPC 晚 1 个微任务到达——waitFor 等待而非同步断言（断言语义不变）
      await vi.waitFor(() => {
        expect(subscribeMock.subscribe).toHaveBeenCalledWith('s1', 5)
      })
    })
  })

  describe('TC6: 未 subscribe session 不做 gap 检测（兼容旧路径）', () => {
    it('state 不存在：带 seq 消息正常 dispatch，不丢弃、不 reconcile', () => {
      // s2 从未 subscribe（无 state）
      pushInbound(liveMsg(99, 'message.chunk', 's2'))

      expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
      expect(eventsMock.dispatchSession).toHaveBeenCalledWith('s2', liveMsg(99, 'message.chunk', 's2'))
      // 不触发 reconcile
      expect(subscribeMock.subscribe).not.toHaveBeenCalled()
    })

    it('subscribed=false（subscribeSession 失败）：正常 dispatch 不 gap 检测', async () => {
      subscribeMock.subscribe.mockRejectedValue(new Error('RPC down'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      await subscribeSession('s3')
      // 失败不标记 subscribed——意图条目留存 {lastSeenSeq:0, subscribed:false}
      //（M1/W09 follow-up：供重连后 resubscribeAll 重发），gap 检测走兼容路径
      expect(getSubscriptionState('s3')).toEqual({ lastSeenSeq: 0, subscribed: false })

      pushInbound(liveMsg(50, 'message.chunk', 's3'))

      expect(eventsMock.dispatchSession).toHaveBeenCalledTimes(1)
    })
  })

  describe('TC8: routeInbound 的 id 路径不受 seq 影响（D7 互斥）', () => {
    it('带 id 的 RPC reply：走 pending.resolve，sid 命中时仍 dispatch（id/seq 来源互斥不阻断 dispatch）', () => {
      const reply: ServerMessage = {
        type: 'session.subagents',
        id: 'r1',
        payload: { sessionId: 's1', subagents: [] },
      } as ServerMessage

      pushInbound(reply)

      // id 路径：pending.resolve 被调
      expect(pendingMock.resolve).toHaveBeenCalledWith('r1', reply.payload)
    })

    it('带 id 的 error reply：走 pending.reject（透传 code/message）', () => {
      const reply: ServerMessage = {
        type: 'error',
        id: 'r2',
        payload: { code: 'ERR_X', message: 'boom' },
      } as ServerMessage

      pushInbound(reply)

      expect(pendingMock.reject).toHaveBeenCalledTimes(1)
      const [id, err] = pendingMock.reject.mock.calls[0]!
      expect(id).toBe('r2')
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('boom')
      expect((err as Error & { code: string }).code).toBe('ERR_X')
    })

    it('已 subscribe session 收到带 id+seq 的 reply：pending 走 id 路径，seq 分支不影响（D7 互斥）', async () => {
      subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await subscribeSession('s1')

      // 带 id 的 reply（无 seq）→ pending.resolve，dispatch 仍发生（兼容：reply 也可能含 sessionId）
      const reply: ServerMessage = {
        type: 'session.commands',
        id: 'r3',
        payload: { sessionId: 's1' },
      } as ServerMessage

      pushInbound(reply)

      expect(pendingMock.resolve).toHaveBeenCalledWith('r3', reply.payload)
    })
  })

  describe('updateLastSeenSeq 与 routeInbound 协同', () => {
    it('routeInbound 收到正常递进 seq 后更新基线，下一条 seq<=新基线 丢弃', async () => {
      subscribeMock.subscribe.mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 5 })
      await subscribeSession('s1')

      pushInbound(liveMsg(6)) // 正常递进 → 基线变 6
      expect(getSubscriptionState('s1')!.lastSeenSeq).toBe(6)
      vi.clearAllMocks()

      pushInbound(liveMsg(6)) // 重复 seq=6 → 丢弃
      expect(eventsMock.dispatchSession).not.toHaveBeenCalled()
    })
  })
});
