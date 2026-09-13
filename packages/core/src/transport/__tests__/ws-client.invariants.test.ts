// ws-client 不变量特征测试 —— 规格权威。
//
// 规格来源：原 docs/architecture/renderer-rebuild/ws-client-invariants.md（remote-use 期撰写，
//   依据 renderer-rebuild-architecture.md §5.1 ws-client 不预拆整体迁入 / §11.0.4 不变量定义
//   修正 / 附录 B.2-4 特征测试覆盖），2026-09-13 复核后沉入本注释块——文档已删除，本块是
//   特征测试断言点的唯一规格权威；描述已逐类对照现行实现（ws-client.ts + coordination/）修正。
//
// 不变量定义修正：旧「本地模式逐字节不变」不可执行（测试无法锁定字节级）→
//   新「特征测试覆盖的关键行为不变」（下列行为特征 = 特征测试必须锁定的不变量）。
//
// ── 5 类不变量定义（按现行实现修正后的口径，[漂移] 标注与原稿的差异）──
// ① 连接状态机：模块级状态机仅允许合法迁移。现行 6 态 disconnected/connecting/connected/
//   reconnecting/restarting/failed。[漂移] 原稿 4 态 connecting/open/closing/closed 是
//   remote-use 期术语；closing 中间态不存在——主动 disconnect 先摘回调再 close，直接置
//   disconnected。断言点：connecting → connected（onopen，token 模式经 auth.result ok 的
//   markConnected）可达；主动 disconnect → disconnected 可达且残余回调被摘除；非法迁移拒绝
//   （已连接/连接中重复 connect 幂等 no-op，不重置状态不建新 WS）；onclose → disconnected →
//   scheduleReconnect（closed 是重连起点，原稿语义保留）。
// ② auth 握手：token 模式下 open 后首帧必为 {type:'auth', payload:{token}}，等 auth.result
//   才进消息处理（握手期业务消息丢弃）。[漂移] 原稿的 buildAuthMessage 共享函数与 auth.ok /
//   auth.reject 双类型不存在——现行 wire 协议是单一 auth.result { ok, reason? }
//   （shared/protocol.ts，runtime 对握手失败 close 1008），auth 帧在 ws-client onopen 内联
//   构造；原稿「probe 与 ws-client 共用 buildAuthMessage 防漂移」的前提已消失（无独立 probe
//   模块）。[漂移] 原稿「auth.ok 后订阅 + flush pending」——resubscribeAll / pending rejectAll
//   归 use-connection 编排层（connected false→true watch 驱动），ws-client 层等价行为是
//   markConnected 置位 + pre-auth 队列 flush（见 ⑥）。[漂移] 原稿「auth.reject 降级：标记
//   连接不可用 + 壳降级 UI」——现行语义 = close 走重连链（新 token 由 use-connection 的
//   onRuntimePort 路径刷新），非降级 UI。
// ③ close code 分流：按 WebSocket close code 分流重连策略。能力未迁入 core（保持 it.todo）：
//   现行 ws-client onclose 不读 code，一律走退避重连。原稿断言点：1006 异常关闭 → 退避重连；
//   4001 认证失效 → 不重连；4000/4003 等服务端正常关闭 → 不重连；分流判定集中在 ws-client
//   单点（不散落 routeInbound/domain）。[漂移] 原稿「4001 不重连」与现行 auth 拒绝行为
//   （close → 重连链，等 token 刷新）语义相反——激活时按现行语义裁决分流表，不照搬原稿。
// ④ seq 回放（可靠投递语义）：session 通道消息带 seq，gap 检测后 reconcile 保证消息不丢。
//   seq 机制全部在 transport + coordination（seqGate / subscription-state / route-inbound），
//   不进 domain（domain store 只面对已排序、已去重的消息流）。断言点：gap 检测 → subscribe
//   reconcile（fromSeq = lastSeenSeq 排他下界）；[漂移] 原稿「reconcile 响应后服务端发
//   seqReset → reload 全量历史 + 重载前静默窗口」不存在（runtime/core 均无 seqReset）——现行
//   是增量回拉，snapshot/stateSnapshot 经 replay dispatcher 走与 live 相同的路由管线（seqGate
//   去重 + gapDispatchedSeqs 簿记 drop + ROUTE_TABLE effects），基线 max() 收敛不回退；
//   presence 弱可靠通道不入 seq 桶（靠 auth.ok/presence.list 兜底，约束同时锁定在
//   coordination/presence.ts 头注释，防未来误「修复」成入桶）；send.rejected 是 runtime 预检
//   拒绝的独立反馈类型（shared/protocol.ts D-006，带 clientUuid 回带），消费在
//   domain/chat/useChat（不进对话流）——原稿断言点已被实现消化，不在本文件 todo。
// ⑤ 重连退避：异常断开后指数退避重连。断言点：base 1s / ×2 / cap 30s 序列；连续失败达
//   [漂移] 时长上限 60s（MAX_RECONNECT_DURATION_MS）后停止自动重连置 failed 待用户手动重试
//   （原稿「次数上限如 10 次」不成立——attempts 上限曾存在但恒被时长上限先触发，死代码已删）；
//   [漂移] 原稿「jitter 随机抖动防惊群」不存在——现行确定性 delay（单用户自托管单连接，
//   无惊群形态）；[漂移] 原稿「visibilitychange 触发立即重连 + 重置退避计数」已实现在
//   transport/use-connection.ts（headless 化经 visibility 端口：切回 visible 且未连接时用
//   最近 url 主动重连，不干等退避最长 30s），由 use-connection-visibility.test.ts 锁定，
//   退避簿记归零发生在连接成功（markConnected）而非触发瞬间；退避与连接状态解耦——重连成功
//   后退避簿记归零（reconnectAttempts=0 + reconnectStartedAt=null），不污染新连接。
//
// ── 协议演进纪律 ──
// - ws-client 从 remote-use 整体迁入 core/transport 后不预拆（auth/seq/RTT 经模块级状态紧
//   耦合，拆分边界按实际耦合测量再定——架构文档 §5.1）。
// - 新增行为不变量（如未来引入心跳 RTT 测量）时，先扩本注释块规格 + 新增 it.todo，再实现
//   ——规格先行，本注释块随实现漂移时同步修正。
//
// ── 激活范围（F4 → S-33 扩）──
// 已激活：① 3 条 + ② 3 条 + ④ gap reconcile 1 条 + ⑤ 退避/时长上限 2 条（fake 注入 +
//   vi.useFakeTimers）。② 原为 C4 deferred（「auth 能力迁入 core 时激活」），S-33 复审确认
//   auth 握手已落地 core ws-client（connect(url, token) 双参），defer 理由失效。
// 保持 todo 范围（C4 deferred）：③ close code 分流 3 条、④ reconcile 回放断言 + presence
//   2 条——close code / presence 能力未迁入 core，激活待后续 wave。⑤ visibility 重连的 todo
//   已移除（行为已落地 use-connection 并有专门测试，见 ⑤ [漂移] 说明）。
// 超出原稿范围（规格按实现现状增补）：⑥ pre-auth 发送队列（review findings-confirmation #3）
//   + 辅助状态（restarting/failed IPC 驱动）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { providePlatform } from '../../platform/port'
import type { ClientMessage } from '@xyz-agent/shared'
import {
  connect,
  disconnect,
  getState,
  onMessage,
  onQueueDrop,
  setFailed,
  setRestarting,
  send,
  type SendQueueDropReason,
} from '../ws-client'
import { configureRouteInbound, type TransportPorts } from '../../coordination/route-inbound'
import { subscribeSession, resetSubscriptionStates } from '../../coordination/subscription-state'
import { createFakeWebSocket, type FakeWebSocket } from './helpers/fake-websocket'

// ── 测试平台注入（fake websocket factory，每次 create 产出新 fake 并登记） ──
let fakes: FakeWebSocket[]

function installTestPlatform(): void {
  fakes = []
  providePlatform({
    kind: 'mock',
    storage: {
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    webSocket: {
      create: () => {
        const f = createFakeWebSocket()
        fakes.push(f)
        return f
      },
    },
  })
}

function latestFake(): FakeWebSocket {
  expect(fakes.length).toBeGreaterThan(0)
  return fakes[fakes.length - 1]
}

describe('ws-client 不变量 ① 连接状态机', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect() // 重置模块级单例状态（上轮残留连接/定时器）
  })
  afterEach(() => {
    disconnect()
    vi.useRealTimers()
  })

  it('合法迁移 connecting → open 可达（onopen 触发）', () => {
    connect('ws://test')
    expect(getState().value).toBe('connecting')
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')
  })

  it('合法迁移 open → closed 可达（主动 disconnect，残余回调被摘除）', () => {
    connect('ws://test')
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')

    disconnect()
    expect(getState().value).toBe('disconnected')
    // 主动断开摘回调：fake 的 onclose/onerror/onmessage 已置 null（onopen 原版不摘，gen 检查兜底），
    // 残余 trigger 不干扰新连接
    const f = latestFake()
    expect(f.onclose).toBeNull()
    expect(f.onerror).toBeNull()
    expect(f.onmessage).toBeNull()
    f.triggerOpen()
    expect(getState().value).toBe('disconnected')
  })

  it('非法迁移 open → connecting 被拒绝（connect 幂等 no-op，不重置状态）', () => {
    connect('ws://test')
    latestFake().triggerOpen()
    expect(getState().value).toBe('connected')
    expect(fakes.length).toBe(1)

    connect('ws://test-2') // 已连接，重复建连应被拒绝
    expect(fakes.length).toBe(1) // 未创建新 WS
    expect(getState().value).toBe('connected')
  })
})

describe('ws-client 不变量 ② auth 握手', () => {
  // S-33 复审激活：auth 握手已落地 core ws-client（onopen 首条 auth / auth.result ok 才
  // markConnected / reject 走 close 重连链），C4 defer 理由失效。原 todo 前提修正：
  // core ws-client 层无「订阅触发 + pending flush」——resubscribeAll / pending.rejectAll
  // 归 use-connection 编排层（connected 状态监听驱动），故按 ws-client 实际行为断言等价语义
  // （connected 置位 + 握手期业务消息丢弃）。
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect() // 重置模块级单例状态（上轮残留连接/定时器）
  })
  afterEach(() => {
    disconnect()
    // currentToken 是模块级残留（connect(url, token) 设置，disconnect 不清）：经 mock url
    // 复位为 null（connect 对 mock: 前缀强制清空），避免本 describe 的 token 改变后续
    // describe（④ seq / ⑤ 退避）connect('ws://test') 的无 token 行为
    connect('mock://reset-token')
    disconnect()
    vi.useRealTimers()
  })

  it('auth.result ok=true 后进入 connected；握手期业务消息被丢弃（不进消息处理）', () => {
    const handler = vi.fn()
    const off = onMessage(handler)

    connect('ws://test', 'tok-1')
    const f = latestFake()
    f.triggerOpen()
    // open 后首条 send 是 auth 握手消息
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-1' } })
    // 握手未完成：不置 connected
    expect(getState().value).toBe('connecting')

    // 握手期业务消息（合法 ServerMessage 形状）不进入消息处理
    f.triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
    expect(handler).not.toHaveBeenCalled()

    // auth.ok → markConnected
    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    expect(getState().value).toBe('connected')

    // 对照：握手完成后同一形状消息正常进入消息处理（丢弃仅发生在握手期）
    f.triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 2, payload: { sessionId: 's1' } }))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.chunk' }))
    off()
  })

  it('auth.result ok=false（reject）后不进入 connected，close 走重连链', () => {
    const handler = vi.fn()
    const off = onMessage(handler)

    connect('ws://test', 'tok-2')
    const f = latestFake()
    f.triggerOpen()
    expect(getState().value).toBe('connecting')

    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: false } }))
    // 拒绝：不 markConnected（降级 = 主动断开走重连链，新 token 由上层 connect(url, newToken) 刷新）
    expect(getState().value).toBe('connecting')
    expect(f.closeCalls).toBe(1)

    // 拒绝后仍处握手期：业务消息不进入消息处理
    f.triggerMessage(JSON.stringify({ type: 'message.chunk', seq: 1, payload: { sessionId: 's1' } }))
    expect(handler).not.toHaveBeenCalled()

    // close 完成（onclose 到达）→ 进入正常重连退避链
    f.triggerClose()
    expect(getState().value).toBe('reconnecting')
    off()
  })

  it('auth 消息在 open 前不发（open 后首条 send 即 auth，含 payload.token 结构）', () => {
    connect('ws://test', 'tok-3')
    const f = latestFake()
    // open 前（CONNECTING）：不发送任何消息
    expect(f.sent).toHaveLength(0)

    f.triggerOpen()
    expect(f.sent).toHaveLength(1)
    expect(JSON.parse(f.sent[0])).toEqual({ type: 'auth', payload: { token: 'tok-3' } })
  })
})

describe('ws-client 不变量 ③ close code 分流', () => {
  // [C4 deferred] close code 分流属后续迁移 wave（close code 处理能力迁入 core 时激活）。
  // 现行 onclose 不读 code 一律走退避重连；runtime 侧对 auth 握手失败发 close 1008
  // （shared/protocol.ts auth.result 注释）。原稿断言点：1006（浏览器层异常关闭）→ 重连走
  // ⑤ 退避；4001（服务端明确拒绝认证）→ 不重连、标记需重新认证；4xxx（服务端正常关闭如
  // 4000/4003）→ 不重连、尊重服务端意图等用户手动重连。[漂移] 原稿「4001 不重连」与现行
  // auth 拒绝行为（close → 重连链，等 use-connection 刷新 token）语义相反——激活时按现行
  // 语义裁决分流表，不照搬原稿。分流判定必须集中在 ws-client 单点（不散落 routeInbound/
  // domain），便于整体锁定行为。
  it.todo('1006（异常关闭）触发重连走退避序列')
  it.todo('4001（认证失效）不重连，标记需重新认证（壳降级 UI）')
  it.todo('4xxx（服务端正常关闭，如 4000/4003）不重连')
})

describe('ws-client 不变量 ④ seq 回放', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
    // 清订阅状态 Map（上轮用例残留 subscribed 标记会干扰 gap 判定，RK3）
    resetSubscriptionStates()
  })
  afterEach(() => {
    disconnect()
    vi.useRealTimers()
  })

  it('seq gap 检测后发起 reconcile 请求（拉取缺失区间）', async () => {
    // spyPorts：pending/events/subscribe 全 vi.fn()，subscribe 返回空 snapshot + lastSeq=10 预置基线
    const subscribeSpy = vi.fn(async () => ({ snapshot: [], stateSnapshot: [], lastSeq: 10 }))
    const spyPorts: TransportPorts = {
      pending: { resolve: vi.fn(), reject: vi.fn(), rejectAll: vi.fn(), has: vi.fn(() => false), resolveEnvelope: vi.fn() },
      events: { dispatchSession: vi.fn(), dispatchGlobal: vi.fn(), dispatchCrossSession: vi.fn() },
      subscribe: subscribeSpy,
    }
    // 注册 dispatcher（模拟 renderer ensureDispatcher 安装：onMessage(configureRouteInbound(ports))）
    onMessage(configureRouteInbound(spyPorts))

    connect('ws://test')
    latestFake().triggerOpen()

    // 预置 subscribed state：经真实 subscribeSession（spy reply lastSeq=10 → state={10, true}）
    await subscribeSession('s1')
    expect(subscribeSpy).toHaveBeenCalledWith('s1', undefined)

    // fake WS push seq=13 的 session 通道消息：s1 已 subscribed（lastSeenSeq=10），
    // 13 > 10+1 → gap，reconcileFromSeq = lastSeenSeq = 10（排他下界，覆盖缺失段 {11,12}；
    // 非 seq-1=12——runtime subscribe 只返 seq > fromSeq，传 12 会永久漏掉 11/12，MF-1）
    latestFake().triggerMessage(
      JSON.stringify({ type: 'message.chunk', seq: 13, payload: { sessionId: 's1' } }),
    )
    // flush subscribeSession 内部 await（fire-and-forget 微任务）
    await Promise.resolve()
    await Promise.resolve()

    expect(subscribeSpy).toHaveBeenCalledTimes(2)
    expect(subscribeSpy).toHaveBeenLastCalledWith('s1', 10)
  })

  // [漂移修正] 原稿描述「reconcile 响应后服务端发 seqReset → reload 会话历史（重载前静默
  // 窗口）」在现行实现不存在（runtime/core 均无 seqReset 消息、无全量 reload、无静默窗口）。
  // 现行语义：reconcile = subscribeSession(sid, lastSeenSeq) 增量回拉缺失段（fromSeq 排他
  // 下界），reply.snapshot/stateSnapshot 经注入的 replay dispatcher 进入与 live 相同的路由
  // 管线——seqGate 去重（gap 触发消息 live 已 dispatch 但基线未推进，靠 gapDispatchedSeqs
  // 簿记 drop；缺失段逐条递进推进基线）+ ROUTE_TABLE effects + crossSession 分发照常触发
  // （PR #175 review R1 MUST_FIX），基线 max() 收敛不回退（MF-3：reconcile 成功才推进，
  // 失败保持原位可重试）。激活时断言：回放去重 + 基线收敛 + 回放路径 effects 同触发。
  it.todo('reconcile 回放经与 live 相同的路由管线（gap 触发消息簿记去重 + 基线 max() 收敛）')
  // 约束仍有效（presence 弱可靠通道，架构文档 §5.3-4）：presence 是全局协同态，不入 seq 桶，
  // 靠 auth.ok / presence.list 兜底补全。本约束同时锁定在 coordination/presence.ts 头注释
  // （防未来误「修复」成入桶）。presence 当前为占位（C4 deferred）——激活待 presence 落地。
  it.todo('presence 弱可靠通道不入 seq 桶（靠 auth.ok/presence.list 兜底）')
})

describe('ws-client 不变量 ⑤ 重连退避', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    disconnect()
    vi.useRealTimers()
  })

  it('指数退避序列符合 base/cap 参数（1s/2s/4s… capped 30s）', () => {
    connect('ws://test')
    latestFake().triggerOpen()

    // attempt 1：base 1s
    latestFake().triggerClose()
    expect(getState().value).toBe('reconnecting')
    vi.advanceTimersByTime(999)
    expect(fakes.length).toBe(1) // 未到 1s 不重连
    vi.advanceTimersByTime(1)
    expect(fakes.length).toBe(2) // 1s 到 → 重连（create 新 fake）

    // attempt 2：×2 = 2s
    latestFake().triggerClose()
    vi.advanceTimersByTime(1999)
    expect(fakes.length).toBe(2)
    vi.advanceTimersByTime(1)
    expect(fakes.length).toBe(3)

    // attempt 3：×2 = 4s
    latestFake().triggerClose()
    vi.advanceTimersByTime(4000)
    expect(fakes.length).toBe(4)

    // attempt 5：理论 16s；attempt 6：理论 32s → capped 30s
    latestFake().triggerClose() // attempt 4 → 8s
    vi.advanceTimersByTime(8000)
    expect(fakes.length).toBe(5)
    latestFake().triggerClose() // attempt 5 → 16s
    vi.advanceTimersByTime(16_000)
    expect(fakes.length).toBe(6)
    latestFake().triggerClose() // attempt 6 → min(32s, 30s) = 30s
    vi.advanceTimersByTime(29_999)
    expect(fakes.length).toBe(6) // 未到 30s 不重连（未 cap 则需 32s）
    vi.advanceTimersByTime(1)
    expect(fakes.length).toBe(7) // 30s 到 → cap 生效
  })

  it('连续重连失败达时长上限后停止重连（防无限重试）', () => {
    connect('ws://test')
    latestFake().triggerOpen()

    let guard = 0
    while (getState().value !== 'failed' && guard < 30) {
      latestFake().triggerClose()
      vi.advanceTimersByTime(30_000)
      guard++
    }
    expect(getState().value).toBe('failed')
    const lenAtFail = fakes.length

    // 已 failed：后续不再调度重连（无新 WS 创建）
    vi.advanceTimersByTime(30_000)
    expect(fakes.length).toBe(lenAtFail)
    expect(getState().value).toBe('failed')
  })

  // [已落地] 原稿 ⑤ todo「visibilitychange（页面可见）触发立即重连，并重置退避计数」已实现
  // 于 transport/use-connection.ts（headless 化经 visibility 端口，非本文件职责）：切回
  // visible 且未连接时用最近 url（lastConnectedUrl）主动重连，不干等 ws-client 退避（最长
  // 30s）；hidden 不触发、已 connected 不触发。由 use-connection-visibility.test.ts 锁定。
  // [漂移] 原稿「重置退避计数」发生在触发瞬间不成立——退避簿记归零在连接成功（markConnected
  // 置 reconnectAttempts=0 + reconnectStartedAt=null）。
})

describe('ws-client 不变量 ⑥ pre-auth 发送队列', () => {
  // review findings-confirmation #3：TCP open → auth.result 窗口内 send() 真实送出会被 runtime
  // 设计性静默丢弃（connection-manager handleUnauthedMessage），pending 挂满 65s sweep。
  // 修复：OPEN 但本代未 auth → 入队；auth ok 后按序 flush；auth 失败 / 连接关闭 → 清队 +
  // onQueueDrop 通知（use-connection 消费方对带 id 消息 reject 对应 pending）。
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    disconnect()
    // currentToken 复位（同 ② describe 体例）：避免 token 残留改变后续 describe 的无 token 行为
    connect('mock://reset-token')
    disconnect()
    vi.useRealTimers()
  })

  /** 构造带 id 的 RPC 型 ClientMessage（生产 request.ts command() 同款形状，as 断言体例一致） */
  function rpcMsg(id: string): ClientMessage {
    return { type: 'config.sessions', id, payload: {} } as ClientMessage
  }

  it('pre-auth 窗口 send 入队（返回 true，不上 wire）；auth ok 后按序 flush', () => {
    connect('ws://test', 'tok-q1')
    const f = latestFake()
    f.triggerOpen()
    expect(f.sent).toHaveLength(1) // 仅 auth 握手帧

    expect(send(rpcMsg('q-a'))).toBe(true)
    expect(send(rpcMsg('q-b'))).toBe(true)
    // pre-auth：接受但未上 wire（旧行为此处真实送出 → runtime 静默丢弃）
    expect(f.sent).toHaveLength(1)

    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    expect(getState().value).toBe('connected')
    // flush 到达且保序
    expect(f.sent).toHaveLength(3)
    expect(JSON.parse(f.sent[1]).id).toBe('q-a')
    expect(JSON.parse(f.sent[2]).id).toBe('q-b')
  })

  it('auth 失败清队并通知 drop（带 id 消息可被消费方 reject），消息永不上 wire', () => {
    // 消费方模拟（生产由 use-connection 注册）：带 id 消息 → reject 对应 pending
    const rejectedIds: string[] = []
    let dropReason: SendQueueDropReason | undefined
    const off = onQueueDrop((msgs, reason) => {
      dropReason = reason
      for (const m of msgs) {
        const id = (m as { id?: string }).id
        if (typeof id === 'string') rejectedIds.push(id)
      }
    })

    connect('ws://test', 'tok-q2')
    const f = latestFake()
    f.triggerOpen()
    expect(send(rpcMsg('q-rej'))).toBe(true)

    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: false } }))
    f.triggerClose() // auth reject 的 close 到达（走重连链）
    expect(getState().value).toBe('reconnecting')

    expect(f.sent).toHaveLength(1) // 只有 auth 帧，队列消息未上 wire
    expect(dropReason).toBe('auth-failed')
    expect(rejectedIds).toEqual(['q-rej'])
    off()
  })

  it('auth 握手超时（close）→ 清队并通知 drop（reason=closed）', () => {
    const droppedIds: string[] = []
    let dropReason: SendQueueDropReason | undefined
    const off = onQueueDrop((msgs, reason) => {
      dropReason = reason
      for (const m of msgs) droppedIds.push(...msgs.map((m2) => String((m2 as { id?: string }).id)))
    })

    connect('ws://test', 'tok-q3')
    const f = latestFake()
    f.triggerOpen()
    expect(send(rpcMsg('q-timeout'))).toBe(true)

    vi.advanceTimersByTime(5_000) // AUTH_TIMEOUT_MS：客户端先断（短于 runtime 侧 10s）
    f.triggerClose() // close 事件到达
    expect(f.sent).toHaveLength(1)
    expect(dropReason).toBe('closed')
    expect(droppedIds).toEqual(['q-timeout'])
    off()
  })

  it('队列超限（256）驱逐最老并通知 overflow；flush 只发余下且保序', () => {
    const overflowIds: string[] = []
    const off = onQueueDrop((msgs, reason) => {
      expect(reason).toBe('overflow')
      overflowIds.push(...msgs.map((m) => String((m as { id?: string }).id)))
    })

    connect('ws://test', 'tok-q4')
    const f = latestFake()
    f.triggerOpen()
    for (let i = 0; i <= 256; i++) send(rpcMsg(`q-${i}`)) // 257 条 → 驱逐 q-0
    expect(overflowIds).toEqual(['q-0'])

    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    // 1 auth 帧 + 256 条队列消息
    expect(f.sent).toHaveLength(257)
    expect(JSON.parse(f.sent[1]).id).toBe('q-1')
    expect(JSON.parse(f.sent[256]).id).toBe('q-256')
    off()
  })

  it('已 auth 的连接 send 直发不入队（无回归）', () => {
    connect('ws://test', 'tok-q5')
    const f = latestFake()
    f.triggerOpen()
    f.triggerMessage(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    expect(send(rpcMsg('q-direct'))).toBe(true)
    // auth 帧 + 直发消息，无队列中转延迟
    expect(f.sent).toHaveLength(2)
    expect(JSON.parse(f.sent[1]).id).toBe('q-direct')
  })
})

describe('ws-client 辅助状态（restarting/failed IPC 驱动）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTestPlatform()
    disconnect()
  })
  afterEach(() => {
    disconnect()
    vi.useRealTimers()
  })

  it('setFailed 停止自动重连并置 failed', () => {
    connect('ws://test')
    latestFake().triggerOpen()
    latestFake().triggerClose() // 触发重连调度
    expect(getState().value).toBe('reconnecting')

    setFailed()
    expect(getState().value).toBe('failed')
    const lenAtFail = fakes.length
    vi.advanceTimersByTime(30_000)
    expect(fakes.length).toBe(lenAtFail) // 定时器已清，不再重连
  })

  it('setRestarting 断开当前连接并置 restarting', () => {
    connect('ws://test')
    latestFake().triggerOpen()
    setRestarting()
    expect(getState().value).toBe('restarting')
    expect(latestFake().closeCalls).toBe(1) // 当前 WS 被主动 close
    expect(getState().value).not.toBe('disconnected') // 不被重连逻辑覆盖
  })

  it('send 在 OPEN 时发送并返回 true，非 OPEN 返回 false', () => {
    connect('ws://test')
    expect(send({ type: 'ping', payload: {} })).toBe(false) // CONNECTING 不可发送
    latestFake().triggerOpen()
    expect(send({ type: 'ping', payload: {} })).toBe(true)
    expect(latestFake().sent).toHaveLength(1)
    expect(JSON.parse(latestFake().sent[0])).toEqual({ type: 'ping', payload: {} })
  })
})
