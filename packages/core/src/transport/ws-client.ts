/**
 * WebSocket 客户端 —— 连接状态机 + 心跳 + 指数退避重连（core 版）。
 *
 * 自 packages/renderer/src/lib/ws-client.ts（重建版）迁入，保留所有运行时不变量：
 *
 * [HISTORICAL] 不变量：
 * 1. 4 态状态机：disconnected → connecting → connected（onclose → reconnecting → connecting...）
 * 2. 心跳：15s 发 ping 保活（仅 keepalive，不跟踪 pong）。死连接检测分形态：桌面靠 TCP 层 +
 *    IPC supervisor 事件 runtime-restarting/runtime-failed 驱动；remote 形态（移动壳无 IPC
 *    supervisor 事件）由 probeAlive 探活补位——use-connection visibility 切前台触发，发 ping +
 *    限时等任意入站帧，超时 close 走重连链。非 pong 超时语义不变。
 * 3. 指数退避重连：1s 起、×2、上限 30s
 * 4. generation 计数：新连接 ++generation，旧 WS 的残余回调（onopen/onclose/onmessage）
 *    检查 gen !== wsGeneration 时直接 return，不干扰新连接
 *
 * S1-W1 auth 握手（spec §3.3 D4）：connect(url, credentials) 凭据为 {auth:'token'} 时，
 * open 后首条消息发 {type:'auth'}，收到 auth.result {ok:true} 才置 connected（resubscribeAll
 * / 心跳随 connected 之后启动，重订阅消息不会被 runtime 当「auth 前消息」丢弃）。
 * {auth:'skip'}（mock 平台）跳过握手，onopen 即 connected。token 空串是合法值——强制握手
 * 探测语义（移动壳无凭据首连：握手必被拒 → onAuthRejected → D8 恢复链），与 skip 不可互代。
 * 内部重连（退避）复用 currentCredentials；runtime 重启换 token 由 use-connection 的
 * onRuntimePort 路径重新拉取后 connect(url, newCredentials) 覆盖。auth 5s 客户端超时（短于
 * runtime 侧 10s）：超时 close 走 onclose → 正常重连链。
 *
 * 与 renderer 版的差异（迁移改造）：
 * - new WebSocket(url) → getPlatform().webSocket.create(url)（平台注入，mock 由 platform
 *   的 webSocket factory 决定，ws-client 不再感知 VITE_MOCK / mock-ws）
 * - 删除 import.meta.hot HMR 块（core headless 无 HMR）
 * - ConnectionState 含 restarting/failed（IPC 驱动，7 导出签名不变）
 *
 * 入站 parse 前置大小守卫 + 终止阀（crash-forensics §3.3 D8 / u10a）：
 * - JSON.parse 前检查帧大小：text 帧 `string.length` > 40M code units（≈80MB UTF-16）、
 *   binary 帧按字节 > 80MB → 整条丢弃（不 parse——UTF-16 放大 + 对象图再放大正是 E3 类
 *   OOM 形态，响亮失败优于静默 parse 巨型字符串）。阈值论证：出站守卫（C-comm-14）下合法
 *   帧恒 ≤32MiB UTF-8 字节，text 帧 string.length 恒 ≤32M code units，40M = 25% 余量，
 *   只拦「守卫已失效/协议漂移」的显著超界形态（哨兵语义）。
 * - 丢弃 → seq gap → 重订阅全量拉取 → 拉取响应同样超界 → 再丢的死循环，由**终止阀**防护：
 *   同一 session **连续 3 次**丢帧后暂停该 session 的自动重订阅（send 层拦截
 *   `session.subscribe`，与 WS 连接态无关）；**作用域 = 单 session**（resubscribeAll 的
 *   全局恢复机制不受影响，其余 session 流不连坐）。
 * - 恢复触发器 = 用户动作：`retryInboundDroppedSession(sid)`（renderer 消费者经
 *   onInboundFrameDropped 回调感知 trip，在用户切走再切回该 session 时调用一次以解除
 *   暂停并重试订阅）；应用重启是兜底路径。
 * - 归因（超界帧不可 parse，无法从对象图取 sessionId）：text 帧头部有界窗口（4KB）
 *   正则提取——① `"id"` 命中 in-flight subscribe 簿记（send 时登记的
 *   session.subscribe 请求，subscribe reply 超界是死循环主形态）→ 归因其目标 session；
 *   ② 否则取首个 `"sessionId"` 字段（live push 帧形态）；③ 均无 → null（只上报，
 *   不参与阀门）。binary 帧不读内容（无 text 可扫），归因恒 null。
 * - 每次丢弃经 onInboundFrameDropped 回调通知（单槽，对齐 onMessage 体例）——renderer
 *   消费者经既有 renderer-log IPC 通道带结构化标记上报进崩溃台账（main.jsonl
 *   `inbound-frame-dropped`，D1 矩阵），不新建 IPC 通道。
 *
 * 依赖方向：platform/port（getPlatform）→ 无下游（暴露 connect/disconnect/send/getState/onMessage）
 */
import { ref, readonly } from 'vue'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import { getPlatform, WS_READY_STATE, type WebSocketCloseInfo, type WebSocketLike } from '../platform/port'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'restarting' // runtime 崩溃，主进程正在拉起新实例（来自 IPC runtime-restarting）
  | 'failed'     // runtime 重启用尽，需用户手动重试（来自 IPC runtime-failed）

/**
 * connect 凭据对象（S4 凭据语义显式化）：auth 意图由调用方显式声明，替代旧
 * `token?: string` 三态隐式协议（undefined=保留上次 / ''=强制空串握手 / 值=正常握手——
 * 三态靠调用方与实现共享的隐式约定，U1.3 假 connected 事故的根因形态）。
 *
 * - `{ auth: 'token', token }`：走 auth 握手（open 后首条 auth 帧，auth.result ok 才
 *   connected）。token 空串 = 强制握手探测：必被 runtime 拒（bad_token）→
 *   onAuthRejected → D8 恢复链。移动壳无凭据首连用它，不得因「空值≈无凭据」误读成 skip。
 * - `{ auth: 'skip' }`：跳过握手，onopen 即 connected（mock 装配形态；URL 仅是
 *   platform factory 的路由标识，ws-client 不解析 URL）。
 */
export type ConnectCredentials =
  | { auth: 'token'; token: string }
  | { auth: 'skip' }

// ── 常量 ────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_BACKOFF_EXPONENT = 2
const MAX_RECONNECT_DELAY_MS = 30_000
/**
 * WS 1001 Going Away（RFC 6455）——runtime 计划内关停（connection-manager stop）发给
 * 全部存量连接的 close 码，客户端据此区分「服务重启中」与网络断（remote-use D8，文案
 * 信号 onGoingAway；重连机制不变）。与 runtime 侧 WS_CLOSE_GOING_AWAY 同码，协议值
 * 同源 RFC，两侧常量各自就近维护。可读性 P6 探针已证（2026-10-03，Chromium 收
 * close(1001,'Server shutting down') 后 onclose event.code===1001）。
 */
const WS_CLOSE_GOING_AWAY = 1001
/** 重连总时长上限（ms）：超过即放弃，置 failed 待用户手动重试，避免长时间无意义重试占用资源。
 *  说明：曾配 attempts 计数上限（MAX_RECONNECT_ATTEMPTS=20），但指数退避（1+2+4+8+16+30…）
 *  累积约第 6-7 次即跨 60s → duration cap 先触发，attempts 永不可达，该常量为死代码已删除。
 *  放弃自动重连的判定唯由本时长上限决定。 */
const MAX_RECONNECT_DURATION_MS = 60_000
/** auth 握手客户端超时（S1-W1）：短于 runtime 侧 10s 握手超时，客户端先主动断开走重连。 */
const AUTH_TIMEOUT_MS = 5_000
/**
 * 探活超时（probeAlive，remote 形态切前台死链检测）：发 ping 后限时等任意入站帧，超时判定
 * 半开 TCP 死链（锁屏/基站切换形态），主动 close 走既有退避重连链。量级对齐单请求粒度
 * （AUTH_TIMEOUT_MS 同为 5s：正常链路 RTT 秒级以内，5s 留数个 RTT 余量）。
 */
const PROBE_ALIVE_TIMEOUT_MS = 5_000
/**
 * pre-auth 发送队列容量上限（防泄漏）：入队消息与 request 层 pending 一一对应
 * （renderer pending 层 MAX_PENDING=256 同界），超限驱逐最老并经 onQueueDrop 通知。
 */
const MAX_PREAUTH_QUEUE = 256

// ── 入站帧守卫常量（crash-forensics §3.3 D8）────────────────────────
/** text 帧大小上限（string.length code units，≈80MB UTF-16；出站守卫 32MiB 上界 + 25% 余量）。 */
export const INBOUND_FRAME_MAX_TEXT_CODE_UNITS = 40_000_000
/** binary 帧大小上限（字节；与 text 上限的 80MB 语义对齐）。 */
export const INBOUND_FRAME_MAX_BINARY_BYTES = 80_000_000
/** 终止阀阈值：同一 session 连续丢帧达此次数 → 暂停该 session 自动重订阅。 */
export const INBOUND_DROP_VALVE_TRIP_THRESHOLD = 3
/** 超界帧归因扫描窗口（头部 code units）——sessionId/id 字段在 JSON envelope 前部，4KB 足够。 */
const INBOUND_GUARD_ATTRIBUTION_WINDOW = 4096
/** in-flight subscribe 簿记条目 TTL：超界 reply 无法 parse 删除不了簿记，按 RPC backstop
 *  65s（pending sweep）+ 余量惰性过期，防泄漏（查询时清理，无独立定时器）。 */
const IN_FLIGHT_SUBSCRIBE_TTL_MS = 90_000

// ── 状态 ────────────────────────────────────────────────────
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，已登记）：WS 连接状态单例 ref（UI 连接指示的数据源，12 类未覆盖）
const state = ref<ConnectionState>('disconnected')
let ws: WebSocketLike | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** auth 握手超时计时器（auth.result 到达 / 连接关闭时清除） */
let authTimer: ReturnType<typeof setTimeout> | null = null
/** 探活超时计时器（probeAlive 专用；任意入站帧 / 连接关闭时清除——单定时器不变量对齐 authTimer） */
let probeAliveTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let wsGeneration = 0
let currentUrl: string | null = null
/** 本次连接凭据（S1-W1/S4）：connect(url, credentials) 更新（幂等 no-op 时也更新——与
 *  currentUrl 同序，保持旧 currentToken 语义）；内部重连（scheduleReconnect）复用。
 *  「保留上次凭据」是本模块内部行为，不在公开签名表达。 */
let currentCredentials: ConnectCredentials | null = null
/**
 * 本代连接是否已完成 auth（模块级真源，send() 的发送门槛）。
 * WS 握手完成即 readyState=OPEN，但 token 模式下要等 auth.result ok 才算完成——
 * TCP open → auth.result 窗口内 send() 真实送出的消息会被 runtime 设计性静默丢弃
 * （connection-manager handleUnauthedMessage，spec §3.3 D4），故未完成 auth 前入队。
 * connect() 开始时按凭据 kind 初始化（skip → onopen 即视为完成）；gen 检查保证只有当前代写入。
 */
let connectionAuthed = false
/** pre-auth 窗口入队的出站消息（FIFO；auth.result ok 后按序 flush） */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：pre-auth 发送队列（容量上限 256，非 GUI 数据；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const preAuthQueue: ClientMessage[] = []

/** 队列丢弃原因（onQueueDrop 回调第二参，消费方按需区分日志/错误文案） */
export type SendQueueDropReason = 'auth-failed' | 'closed' | 'overflow' | 'disconnected'

/** 队列丢弃回调（单槽，对齐 onMessage 体例）：use-connection 注册，对带 id 消息 reject 对应 pending */
let queueDropHandler: ((msgs: ClientMessage[], reason: SendQueueDropReason) => void) | null = null

/** 注册 pre-auth 队列丢弃回调，返回取消函数 */
export function onQueueDrop(cb: (msgs: ClientMessage[], reason: SendQueueDropReason) => void): () => void {
  queueDropHandler = cb
  return () => {
    if (queueDropHandler === cb) queueDropHandler = null
  }
}

// ── auth 拒绝显式信号 + 重连抑制位（remote-use D8）──────────────────

/**
 * auth 拒绝回调（单槽，对齐 onMessage 体例）：auth.result ok:false 时、**先于 ws.close()**
 * 触发。消费方 = use-connection 远程 profile 分支（移动壳：落 token 输入视图 + 凭据来源
 * 分支处置）；桌面形态不注册——不注册 = 拒绝不置抑制位 = close 走原重连链，行为逐字节不变。
 */
let authRejectedHandler: (() => void) | null = null

/**
 * auth 拒绝重连抑制位（D8「全触发点」）：仅当存在注册消费方时才会在拒绝时置位（桌面零回归
 * by construction）。置位后两个自动重连触发点全部短路：ws-client scheduleReconnect（退避
 * /onclose 链，下方守卫）+ use-connection 的 visibility 切前台主动重连（经
 * isAuthRejectedSuppressed 查询）。解除 = markConnected（auth 成功 = 凭据已有效）或
 * resetAuthRejectionSuppression（token 重试路径的显式入口）。
 */
let authRejectedSuppressed = false

/** 注册 auth 拒绝回调，返回取消函数。注册本身即武装抑制位（未注册 = 行为不变）。 */
export function onAuthRejected(cb: () => void): () => void {
  authRejectedHandler = cb
  return () => {
    if (authRejectedHandler === cb) authRejectedHandler = null
  }
}

// ── 服务端计划内关停信号（remote-use D8）──────────────────────────

/**
 * 计划内关停回调（单槽，对齐 onAuthRejected 体例）：onclose 读到 close 1001（runtime
 * 计划内停机）时、先于重连调度触发。消费方 = connection-view（移动壳断线条「服务重启中」
 * 文案分流）；桌面形态不注册 = 信号无人消费，重连链行为逐字节不变。P6 探针（设计 §5.4
 * 检查点 1）证实浏览器 CloseEvent 可读 code 1001；读不到（无事件形态/异常环境）不触发，
 * 消费方维持现状文案——降级安全。
 */
let goingAwayHandler: (() => void) | null = null

/** 注册服务端计划内关停回调，返回取消函数。 */
export function onGoingAway(cb: () => void): () => void {
  goingAwayHandler = cb
  return () => {
    if (goingAwayHandler === cb) goingAwayHandler = null
  }
}

/** auth 拒绝重连抑制位查询（use-connection 的 visibility 主动重连触发点检查用）。 */
export function isAuthRejectedSuppressed(): boolean {
  return authRejectedSuppressed
}

/**
 * 显式解除 auth 拒绝重连抑制（token 重试路径专用）：移动壳 token 输入视图提交新凭据后、
 * 重新发起连接前调用。markConnected（auth 成功）会自行复位，本入口覆盖「重试再次失败 →
 * 换凭据再试」的循环。
 */
export function resetAuthRejectionSuppression(): void {
  authRejectedSuppressed = false
}

// ── 入站帧守卫：类型 / 状态 / 公开 API（crash-forensics §3.3 D8）────

/** 一次入站超界帧丢弃的通知载荷（onInboundFrameDropped 回调参数）。 */
export interface InboundFrameDroppedInfo {
  /** 归因 session（头部有界扫描提取；null = 无法归因——只上报，不参与阀门计数）。 */
  sessionId: string | null
  /** 超界帧尺寸（text 帧 = code units；binary 帧 = 字节）。 */
  frameSize: number
  /** 帧形态（text / binary）。 */
  kind: 'text' | 'binary'
  /** 本帧是否使归因 session 首次触发终止阀（第 3 次；tripped 后续丢帧为 false）。 */
  valveTripped: boolean
  /** 归因 session 的连续丢帧计数（含本帧；无法归因时为 0）。 */
  sessionDropCount: number
}

/** 入站帧丢弃回调（单槽，对齐 onMessage 体例）：renderer 装配层注册，经既有
 *  renderer-log IPC 通道带结构化标记上报崩溃台账；valveTripped=true 时同时驱动
 *  该 session 的静态错误提示。 */
let inboundFrameDroppedHandler: ((info: InboundFrameDroppedInfo) => void) | null = null

/** 注册入站帧丢弃回调，返回取消函数。 */
export function onInboundFrameDropped(cb: (info: InboundFrameDroppedInfo) => void): () => void {
  inboundFrameDroppedHandler = cb
  return () => {
    if (inboundFrameDroppedHandler === cb) inboundFrameDroppedHandler = null
  }
}

/** per-session 连续丢帧计数（终止阀判定依据；正常帧到达清零——「连续」语义）。 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：入站守卫 per-session 丢帧计数簿记（防死循环阀门依据；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const inboundDropStreakBySession = new Map<string, number>()
/** 终止阀生效中的 session（自动重订阅被 send 层拦截；retryInboundDroppedSession 解除）。 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：终止阀生效 session 集合（自动重订阅暂停的判定依据；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const inboundValveTrippedSessions = new Set<string>()
/**
 * in-flight subscribe 簿记（requestId → 目标 session）：超界帧归因锚。
 * send() 出站 `session.subscribe` 时登记；正常 reply 到达（id 命中）或 TTL 过期时清理。
 * subscribe reply 超界是 D8 死循环主形态（拉取响应同样超界）——reply 不可 parse 拿不到 id，
 * 反向经簿记把丢帧归因回目标 session。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记）：in-flight subscribe 归因簿记（超界 reply 的反查锚；登记见 docs/architecture/data-source-registry.md §4 ⑧）
const inFlightSubscribes = new Map<string, { sessionId: string; at: number }>()

/**
 * 解除指定 session 的终止阀（恢复触发器入口）：移除暂停 + 清零丢帧计数，此后该 session
 * 的 subscribe 请求恢复放行（调用方随即发起一次重试订阅）。
 * @returns true = 该 session 曾 tripped、本次已解除；false = 未 tripped（调用方无需动作）。
 */
export function retryInboundDroppedSession(sessionId: string): boolean {
  if (!inboundValveTrippedSessions.has(sessionId)) return false
  inboundValveTrippedSessions.delete(sessionId)
  inboundDropStreakBySession.delete(sessionId)
  console.log(`[ws] inbound drop valve released for session ${sessionId}: one re-subscribe allowed`)
  return true
}

/** 查询指定 session 的终止阀是否生效（renderer 静态提示态的判定源）。 */
export function isInboundValveTripped(sessionId: string): boolean {
  return inboundValveTrippedSessions.has(sessionId)
}

/** 测试钩子：清空入站守卫全部模块级状态（对齐 resetSubscriptionStates 模式）。 */
export function _resetInboundGuardForTest(): void {
  inboundDropStreakBySession.clear()
  inboundValveTrippedSessions.clear()
  inFlightSubscribes.clear()
  inboundFrameDroppedHandler = null
}

/** 测试钩子：in-flight subscribe 簿记当前条目数（G2 重连 sweep 断言用；生产代码零消费）。 */
export function _inFlightSubscribeCountForTest(): number {
  return inFlightSubscribes.size
}

/** 通知队列丢弃（清空方负责 splice，此处只广播） */
function notifyQueueDrop(msgs: ClientMessage[], reason: SendQueueDropReason): void {
  if (msgs.length === 0) return
  queueDropHandler?.(msgs, reason)
}

/** 清空 pre-auth 队列并通知（auth 失败 / 连接关闭 / 终止态；幂等） */
function dropPreAuthQueue(reason: SendQueueDropReason): void {
  notifyQueueDrop(preAuthQueue.splice(0), reason)
}

/** auth 完成后按序 flush 队列（markConnected 内调用；防御连接已失效时走 drop） */
function flushPreAuthQueue(): void {
  if (preAuthQueue.length === 0) return
  const batch = preAuthQueue.splice(0)
  if (ws?.readyState === WS_READY_STATE.OPEN) {
    for (const msg of batch) ws.send(JSON.stringify(msg))
  } else {
    notifyQueueDrop(batch, 'closed')
  }
}
/** 本轮重连起始时间戳（首次 scheduleReconnect 设置，connect 成功后置 null 重置） */
let reconnectStartedAt: number | null = null

// ── [stream-probe 临时探针]（subagent-stream-chunk-design §6 基线测量；零行为变化，
// 拆除 = 设计 impl-plan 阶段 5 收尾步骤）──
// 入站 parse 段累计耗时 + 帧数（模块级），disconnect() 一次性汇总并重置。
let probeParseMsTotal = 0
let probeParsedCount = 0

/** 消息回调（连接骨架阶段不注册；后续业务层注册处理 ServerMessage） */
let messageHandler: ((msg: ServerMessage) => void) | null = null

/** 注册消息回调，返回取消函数 */
export function onMessage(cb: (msg: ServerMessage) => void): () => void {
  messageHandler = cb
  return () => {
    if (messageHandler === cb) messageHandler = null
  }
}

/** 连接状态（只读 ref，供 UI 消费） */
export function getState() {
  return readonly(state)
}

/**
 * 设置为 restarting 态（收到 IPC runtime-restarting 时调，useConnection 编排）。
 * 断开当前 WS（死端口）并停止自动重连——等主进程拉起新实例后推新端口再 connect。
 */
export function setRestarting(): void {
  disconnect() // 停止在死端口上的自动重连，避免与 restarting 状态打架
  state.value = 'restarting'
}

/**
 * 设置为 failed 态（收到 IPC runtime-failed 时调）。
 * 停止自动重连，等用户手动重试。
 */
export function setFailed(): void {
  clearTimers()
  dropPreAuthQueue('disconnected') // 终止态：残留队列消息不再有机会发出
  // 重置重连簿记：failed 为终止态，残留的 reconnectAttempts/reconnectStartedAt（约 60s 前的旧值）
  // 会让后续用户重试 / visibility 重连在首次掉线时立即被判超时 → 一次失败即回 failed，指数退避失效。
  reconnectAttempts = 0
  reconnectStartedAt = null
  state.value = 'failed'
}

/**
 * 建立连接（已连接/连接中时幂等 no-op）。
 *
 * @param url         连接地址（纯路由标识，由 platform 的 webSocket factory 消费；mock 装配
 *                    为 mock:// 前缀 URL，ws-client 不解析——mock 判别经 credentials 显式表达）
 * @param credentials 凭据对象（S4 三态显式化）：{auth:'token', token} 走 auth 握手（open 后
 *                    首条 auth 帧，auth.result ok 才 connected；token 空串 = 强制握手探测，
 *                    必被拒 → onAuthRejected → D8 恢复链）；{auth:'skip'} 跳过握手，onopen
 *                    即 connected。无「保留上次」态——内部重连（scheduleReconnect）复用
 *                    currentCredentials，公开签名不表达。
 */
export function connect(url: string, credentials: ConnectCredentials): void {
  currentUrl = url
  currentCredentials = credentials

  // 单飞守卫（防并存连接）：存在非 CLOSED 的 socket 期间一律不放行建新连接。
  // - OPEN/CONNECTING：已有活跃连接，no-op（原幂等行为不变）。
  // - CLOSING：close 握手未完成（移动弱网下可悬挂数秒~分钟）——此前会被模块变量直接覆盖
  //   并开新连接，旧 socket 悬挂期间与新连接并存（半死连接堆积的根因：移动端「同页多连接
  //   并存」复验问题；退避定时器 / visibility 切前台 / token 重试三个入场口在 CLOSING 窗口
  //   交错即复现）。现改为 no-op：该 socket 的 onclose 到达（WHATWG 保证 close 事件最终
  //   触发）后由 onclose → scheduleReconnect 接力重连，收敛为单链。
  // - null / CLOSED：放行（旧连接已死透）。放行即清挂起的重连定时器——本调用已是最新连接
  //   意图，定时器接力作废，防「外部 connect 与退避定时器」两条链交错产生双定时器双建连。
  if (ws && ws.readyState !== WS_READY_STATE.CLOSED) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  state.value = 'connecting'
  const gen = ++wsGeneration
  // 本代 auth 状态初始化（skip 模式在 onopen 即视为完成）；后续读写都走模块级
  // connectionAuthed——send() 需要在 connect 闭包外感知 auth 进度（pre-auth 入队门槛）。
  connectionAuthed = credentials.auth === 'skip'
  ws = getPlatform().webSocket.create(url)
  console.log('[ws] connecting to', url)

  const clearAuthTimer = () => {
    if (authTimer) {
      clearTimeout(authTimer)
      authTimer = null
    }
  }

  /** connected 化（auth 成功或 skip 模式）：置位状态 + 重连簿记 + 启动心跳 + flush 队列。 */
  const markConnected = () => {
    state.value = 'connected'
    reconnectAttempts = 0
    // 连接成功 → 重置重连计时窗口（下次掉线重新开始计数）
    reconnectStartedAt = null
    // auth 成功 = 凭据已有效（D8）：复位重连抑制位，后续正常断线恢复自动重连
    authRejectedSuppressed = false
    // G2 活性治理（ADR-0069；原文档已删除 git 可追溯）：重连路径增挂 in-flight
    // subscribe 簿记的 TTL sweep。断连使部分 subscribe reply 永不到达（重连后新 id 重订），
    // 原实现唯一 sweep 触发点在超界帧归因死路径，过期条目无人扫 → 簿记随工作流强度无界
    // 增长。新连接确立时扫一次（本函数同步执行，早于 use-connection 的 state watch 触发
    // resubscribeAll——watcher 异步 flush），sweep 语义仍是 TTL 惰性过期，未过期条目不连坐。
    sweepExpiredInFlightSubscribes()
    startHeartbeat()
    flushPreAuthQueue()
  }

  ws.onopen = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略
    if (!connectionAuthed) {
      // S1-W1：首条消息必须是 auth；connected 推迟到 auth.result ok（心跳/重订阅随后）。
      // token 取自 currentCredentials（!connectionAuthed ⇔ 本代凭据为 {auth:'token'}；兜底
      // 空串 = 探测语义，异常态凭据必被 runtime 拒走重连链，不会静默假 connected）
      const token = currentCredentials?.auth === 'token' ? currentCredentials.token : ''
      ws!.send(JSON.stringify({ type: 'auth', payload: { token } }))
      authTimer = setTimeout(() => {
        if (gen !== wsGeneration) return
        console.warn('[ws] auth handshake timeout, closing for reconnect')
        ws?.close()
      }, AUTH_TIMEOUT_MS)
      return
    }
    markConnected()
  }

  ws.onmessage = (event) => {
    if (gen !== wsGeneration) return
    // 探活（remote 切前台死链检测）：本代任何入站帧都是链路活性证据——在大小守卫/parse
    // 之前清探活计时器（超界帧、坏 JSON 帧同样证明链路活，不清会被误判死链）。
    clearProbeAliveTimer()
    // 入站帧守卫（D8）：JSON.parse 前置大小检查——超界整条丢弃（不 parse，防 OOM 形态），
    // 归因 + 计数 + 终止阀见 handleOversizedInboundFrame。守卫在 auth 检查之前（任何阶段
    // 的超界帧都拦，含握手期异常帧）。
    const measured = measureInboundFrame(event.data)
    if (measured !== null && isInboundFrameOverLimit(measured)) {
      handleOversizedInboundFrame(measured)
      return
    }
    // [stream-probe 临时探针] parse 段计时（finally 保证失败帧同样计入；catch 内日志
    // 耗时偶发并入该段，罕见路径不影响量级结论）
    const probeParseStart = performance.now()
    let parsed: unknown
    try {
      parsed = JSON.parse(String(event.data))
    } catch (e) {
      // JSON 解析失败：仅记日志跳过（dispatch 已移出 try，handler 抛错不再被此处吞掉）
      console.error('[ws] parse error:', e)
      return
    } finally {
      probeParseMsTotal += performance.now() - probeParseStart
      probeParsedCount += 1
    }
    noteParsedInboundFrame(parsed)
    // auth 握手期：只消费 auth.result，其余消息（握手期不应出现）丢弃
    if (!connectionAuthed) {
      const r = parsed as { type?: unknown; payload?: { ok?: unknown } | null }
      if (r.type === 'auth.result' && r.payload != null) {
        clearAuthTimer()
        if (r.payload.ok === true) {
          connectionAuthed = true
          markConnected()
        } else {
          // runtime 拒绝（token 失效，如 runtime 已换 token 重启）→ close 走重连链，
          // 新 token 由 use-connection 的 onRuntimePort 路径刷新；
          // pre-auth 队列清空 + 通知（入队消息的 pending 由 onQueueDrop 消费方快速 reject）
          dropPreAuthQueue('auth-failed')
          // D8 显式信号：先置抑制位 + 触发消费方（移动壳切 token 输入视图），再 close——
          // 抑制位对 onclose → scheduleReconnect 可见（先置位再 close 的顺序保证）。
          // 桌面形态无注册消费方：不置位，close 走原重连链，行为不变。
          if (authRejectedHandler) {
            authRejectedSuppressed = true
            authRejectedHandler()
          }
          console.warn('[ws] auth rejected by runtime, closing for reconnect')
          ws?.close()
        }
      }
      return
    }
    if (!isServerMessage(parsed)) {
      console.warn('[ws] dropping malformed (non-ServerMessage) inbound:', parsed)
      return
    }
    messageHandler?.(parsed)
  }

  ws.onclose = (event?: WebSocketCloseInfo) => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，不干扰新连接
    // D8 close code 分流（只读码不加协议）：1001 = runtime 计划内关停 → 先触发消费方
    // 文案信号再进重连链（顺序对齐 authRejected「先置位再 close」——信号先落，重连链
    // 行为不变）；无事件形态（mock 桩）或非 1001 不触发，走现状断线路径。
    if (event?.code === WS_CLOSE_GOING_AWAY) goingAwayHandler?.()
    state.value = 'disconnected'
    stopHeartbeat()
    clearAuthTimer()
    clearProbeAliveTimer() // 探活窗内连接关闭：计时器随断连清除，不残留到重连后的新连接
    dropPreAuthQueue('closed')
    scheduleReconnect()
  }

  ws.onerror = (err) => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略（避免误 close 掉已被新 gen 取代的当前 socket）
    console.error('[ws] error:', err)
    ws?.close()
  }
}

/**
 * 当前连接凭据只读取值面（terminal-multi-instance 设计 §0.5 P6）。
 *
 * 用途：终端域的「runtime 世代变更」核对判据——renderer 在 WS 连接建立边沿比较本值与
 * 上一次连接建立时保存的值，**变化即世代变更**（每次 spawn 重新生成 randomBytes token，
 * 旧 token 对新进程必失效）；未变即同世代（WS 闪断 / 无新进程的幂等 `runtime-port` 广播沿），
 * 终端域不重置。端口值不构成世代信号（`findAvailablePort` 重启常落回原端口）。
 *
 * 语义：模块私有 `currentCredentials` 的只读世代判据面——token 形态凭据返回其 token
 * （`connect(url, credentials)` 每次传入时更新、内部退避重连复用 currentCredentials 时
 * 保留上次值、skip 形态 / 未连接为 null）。空串 token 是合法值（强制握手探测语义），
 * 原样返回不归一。世代判据只做相等性比较，非鉴权用途——鉴权走握手 {type:'auth'} 通道。
 */
export function getCurrentToken(): string | null {
  return currentCredentials?.auth === 'token' ? currentCredentials.token : null
}

/** 主动断开（不触发重连） */
export function disconnect(): void {
  // [stream-probe 临时探针] 连接段 parse 耗时一次性汇总（有 parse 才输出；输出后重置，
  // 下段连接独立统计）
  if (probeParsedCount > 0) {
    console.info(
      `[stream-probe] ws-client parseFrames=${probeParsedCount} parseMsTotal=${probeParseMsTotal.toFixed(1)}`,
    )
    probeParseMsTotal = 0
    probeParsedCount = 0
  }
  // 递增 generation 使旧 WS 的回调失效
  wsGeneration++
  clearTimers()
  dropPreAuthQueue('disconnected') // 回调将被摘除，onclose 清队路径不可达，此处显式清
  if (ws) {
    // 先摘回调再 close，避免触发 onclose → scheduleReconnect
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
    ws = null
  }
  state.value = 'disconnected'
}

/**
 * 发送消息（W4：返回 boolean，让调用方 fast-fail）。
 *
 * 返回契约：
 * - readyState=OPEN 且本代 auth 已完成 → 实际发送，返回 true（已发送确认）
 * - readyState=OPEN 但 auth 未完成（TCP open → auth.result 窗口）→ 入 pre-auth 队列
 *   （有界 MAX_PREAUTH_QUEUE），auth 成功后按序 flush，返回 true（已接受）；
 *   auth 失败 / 连接关闭时清队并经 onQueueDrop 通知（消费方 reject 对应 pending）
 * - readyState≠OPEN（CONNECTING/CLOSED）→ 不发送不入队，返回 false（调用方可立即 reject / 重试）
 */
export function send(msg: ClientMessage): boolean {
  // 终止阀拦截（D8）：tripped session 的自动重订阅（gap reconcile / resubscribeAll /
  // ensureStreamSubscription 路径）在此暂停——不发送，返回 false 走 request 层 fast-fail
  // （pending 立即 reject，subscribeSession catch 消化）。恢复经 retryInboundDroppedSession
  // （用户切走切回触发一次），此后同型请求正常放行。其余 session 与非 subscribe 消息不受影响。
  if (isSubscribeForValvedSession(msg)) return false
  if (ws?.readyState === WS_READY_STATE.OPEN) {
    if (!connectionAuthed) {
      if (preAuthQueue.length >= MAX_PREAUTH_QUEUE) {
        // 防泄漏：驱逐最老（FIFO 队头）并通知 drop
        notifyQueueDrop(preAuthQueue.splice(0, 1), 'overflow')
      }
      preAuthQueue.push(msg)
      return true
    }
    recordOutboundSubscribe(msg)
    ws.send(JSON.stringify(msg))
    return true
  }
  return false
}

// ── 探活（probeAlive，remote 形态切前台死链检测）──────────────

/**
 * 探活：发一条 ping 心跳，限时 PROBE_ALIVE_TIMEOUT_MS 内收到**任何入站帧**即视为链路活
 * （不依赖 pong 具体语义——任意入站帧都是活性证据，onmessage 首行清除）；超时无帧判定半开
 * TCP 死链（锁屏/基站切换形态：state 恒 connected、send 返回 true 但对端收不到），console.warn
 * 后主动 close——close 走既有 onclose → 退避重连链（此处不动 reconnectAttempts 等重连簿记，
 * 由既有路径处理；非 auth 拒绝，抑制位不涉及）。
 *
 * 仅 connected 态有效（其余状态调用 no-op）。调用方 = use-connection visibility 切前台分支
 * （仅 remote 形态；移动壳无 IPC supervisor 事件补位，切前台是死链检测的唯一低成本时机）。
 * 本地/mock 形态不调用——桌面死链检测由 TCP 层 + IPC supervisor 事件兜底，零回归。
 *
 * 计时器清理点与心跳/auth 计时器同款：任意入站帧（onmessage 首行）/ onclose / clearTimers
 * （disconnect、setFailed）——断开与重连各路径不残留；重复调用先清旧（单定时器不变量，
 * 对齐 scheduleReconnect :703-705 注释先例）。超时回调带 gen 守卫（对齐 authTimer），换代后
 * 旧探活不误杀新连接。
 */
export function probeAlive(): void {
  if (state.value !== 'connected') return
  if (ws === null || ws.readyState !== WS_READY_STATE.OPEN) return
  clearProbeAliveTimer()
  send({ type: 'ping', payload: {} })
  const gen = wsGeneration
  probeAliveTimer = setTimeout(() => {
    probeAliveTimer = null
    if (gen !== wsGeneration) return // 已换代：旧探活不误杀新连接
    console.warn(
      '[ws] alive probe timeout: connection unresponsive (no inbound frame since probe ping), closing for reconnect',
    )
    ws?.close()
  }, PROBE_ALIVE_TIMEOUT_MS)
}

// ── 内部 ────────────────────────────────────────────────────

// ── 入站帧守卫私有实现（crash-forensics §3.3 D8）──────────────────

/** 超界判定前的帧度量（text 帧留原文供归因；binary 帧不读内容——大帧转字符串本身是 OOM 形态）。 */
interface InboundFrameMeasurement {
  kind: 'text' | 'binary'
  size: number
  text: string | null
}

/**
 * 度量入站帧：text 帧（string）按 code units；binary 帧按字节（ArrayBuffer / view /
 * Blob 类——runtime 只发 text JSON，binary 分支是形态存在性防御。core 无 DOM lib，
 * Blob 判定走 duck-typing：带 number size 字段即按 binary 度量）。无法度量的形态
 * （undefined 等）返回 null，不守卫，维持原 parse 错误链行为。
 */
function measureInboundFrame(data: unknown): InboundFrameMeasurement | null {
  if (typeof data === 'string') return { kind: 'text', size: data.length, text: data }
  if (data instanceof ArrayBuffer) return { kind: 'binary', size: data.byteLength, text: null }
  if (ArrayBuffer.isView(data)) return { kind: 'binary', size: data.byteLength, text: null }
  const size = (data as { size?: unknown } | null)?.size
  if (typeof size === 'number') return { kind: 'binary', size, text: null }
  return null
}

function isInboundFrameOverLimit(measured: InboundFrameMeasurement): boolean {
  return measured.kind === 'text'
    ? measured.size > INBOUND_FRAME_MAX_TEXT_CODE_UNITS
    : measured.size > INBOUND_FRAME_MAX_BINARY_BYTES
}

/**
 * 处理超界帧：响亮丢弃（console error）→ 归因 → per-session 连续计数 → 阈值触发终止阀
 * → 丢弃回调通知（每次丢弃都通知——台账 ×4 计数由消费方逐帧上报）。
 */
function handleOversizedInboundFrame(measured: InboundFrameMeasurement): void {
  const sessionId = attributeOversizedFrame(measured.text)
  let valveTripped = false
  let sessionDropCount = 0
  if (sessionId !== null) {
    sessionDropCount = (inboundDropStreakBySession.get(sessionId) ?? 0) + 1
    inboundDropStreakBySession.set(sessionId, sessionDropCount)
    if (sessionDropCount >= INBOUND_DROP_VALVE_TRIP_THRESHOLD && !inboundValveTrippedSessions.has(sessionId)) {
      inboundValveTrippedSessions.add(sessionId)
      valveTripped = true
      console.error(
        `[ws] inbound drop valve tripped for session ${sessionId}: ` +
          `pausing auto re-subscribe after ${sessionDropCount} consecutive dropped frames ` +
          `(user re-entry retries once; other sessions unaffected)`,
      )
    }
  }
  console.error(
    `[ws] inbound frame dropped (over size limit): kind=${measured.kind} size=${measured.size} ` +
      `session=${sessionId ?? 'unattributed'}`,
  )
  inboundFrameDroppedHandler?.({
    sessionId,
    frameSize: measured.size,
    kind: measured.kind,
    valveTripped,
    sessionDropCount,
  })
}

/**
 * 超界帧归因（帧不可 parse，只能头部有界窗口正则提取——O(窗口) 代价，不建对象图）：
 * ① 首个 `"id"` 命中 in-flight subscribe 簿记 → 归因其目标 session（subscribe reply
 *    超界 = 死循环主形态，reply 顶层无 sessionId 字段，id 反查是唯一精确锚）；
 * ② 否则首个 `"sessionId"` 字段（live push 帧形态：bus.publish 定向推送 payload 带 sessionId）；
 * ③ 均无（含 binary 帧无 text）→ null。
 */
function attributeOversizedFrame(text: string | null): string | null {
  sweepExpiredInFlightSubscribes()
  if (text === null) return null
  const window = text.length > INBOUND_GUARD_ATTRIBUTION_WINDOW ? text.slice(0, INBOUND_GUARD_ATTRIBUTION_WINDOW) : text
  const idMatch = /"id":"([^"]{1,128})"/.exec(window)
  if (idMatch) {
    const entry = inFlightSubscribes.get(idMatch[1])
    if (entry) return entry.sessionId
  }
  const sidMatch = /"sessionId":"([^"]{1,128})"/.exec(window)
  return sidMatch ? sidMatch[1] : null
}

/** 惰性过期清理：in-flight subscribe 簿记条目超 TTL 删除（超界 reply 删不了簿记的防泄漏口）。 */
function sweepExpiredInFlightSubscribes(): void {
  if (inFlightSubscribes.size === 0) return
  const now = Date.now()
  for (const [id, entry] of inFlightSubscribes) {
    if (now - entry.at > IN_FLIGHT_SUBSCRIBE_TTL_MS) inFlightSubscribes.delete(id)
  }
}

/**
 * send() 出站登记：`session.subscribe` 请求（带 id）记入 in-flight 簿记——其 reply 超界时
 * attributeOversizedFrame 经 id 反查归因目标 session。仅在实际发送路径登记（pre-auth 入队
 * 窗口的 subscribe 实际不存在——订阅经 auth 后的 RPC 发起）；其余 type no-op。
 */
function recordOutboundSubscribe(msg: ClientMessage): void {
  if (msg.type !== 'session.subscribe') return
  const id = (msg as { id?: unknown }).id
  const sid = (msg.payload as { sessionId?: unknown }).sessionId
  if (typeof id === 'string' && typeof sid === 'string') {
    inFlightSubscribes.set(id, { sessionId: sid, at: Date.now() })
  }
}

/** send() 终止阀判定：该出站请求是否为「被暂停 session」的订阅请求。 */
function isSubscribeForValvedSession(msg: ClientMessage): boolean {
  if (msg.type !== 'session.subscribe' || inboundValveTrippedSessions.size === 0) return false
  const sid = (msg.payload as { sessionId?: unknown }).sessionId
  return typeof sid === 'string' && inboundValveTrippedSessions.has(sid)
}

/**
 * 可 parse 的正常入站帧到达时的守卫簿记维护：
 * - id 命中 in-flight subscribe 簿记 → 清理（reply 正常到达 = 订阅完成，归因锚退役）；
 * - payload.sessionId 命中丢帧计数表 → 清零该 session 计数（「连续 3 次」的连续性中断语义：
 *   丢 2 帧 → 正常帧 → 再丢 2 帧，不触发终止阀）。空表时零开销（size 门控，常态热路径）。
 */
function noteParsedInboundFrame(parsed: unknown): void {
  if (inFlightSubscribes.size > 0 && typeof parsed === 'object' && parsed !== null) {
    const id = (parsed as { id?: unknown }).id
    if (typeof id === 'string') inFlightSubscribes.delete(id)
  }
  if (inboundDropStreakBySession.size > 0 && typeof parsed === 'object' && parsed !== null) {
    const sid = (parsed as { payload?: { sessionId?: unknown } }).payload?.sessionId
    if (typeof sid === 'string' && inboundDropStreakBySession.has(sid)) {
      inboundDropStreakBySession.set(sid, 0)
    }
  }
}

/**
 * 入站消息运行时形状守卫（MF-5：替代 `JSON.parse(...) as ServerMessage` unsafe cast）。
 * 仅做最小形状校验：type 为字符串 + payload 非 null。不验证 type 是否在已知 ServerMessageType
 * 联合内（未知 type 由下游 dispatcher 兜底分支处理），避免过度收紧静默丢弃合法 runtime 消息。
 * ServerMessage 的 payload 恒为对象（pong / session.writeSegments:result 为 Record<string,never>={}），
 * 故 payload!=null 不会误杀任何合法变体。
 */
function isServerMessage(x: unknown): x is ServerMessage {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { type?: unknown }).type === 'string' &&
    (x as { payload?: unknown }).payload != null
  )
}

function scheduleReconnect(): void {
  if (!currentUrl) return
  // D8 抑制位触发点 ①：auth 拒绝后不自动重连（凭据失效重连 100% 失败，纯烧日志；等 token
  // 重试路径显式 reset + connect）。置位前提 = 存在注册消费方（桌面恒 false，重连链不变）。
  if (authRejectedSuppressed) {
    console.log('[ws] reconnect suppressed after auth rejection (waiting for credential retry)')
    return
  }
  // 重连时长上限兜底（设计文档 A4 §3.3）：总时长超 MAX_RECONNECT_DURATION_MS → 放弃自动重连，置 failed。
  if (reconnectStartedAt === null) reconnectStartedAt = Date.now()
  if (Date.now() - reconnectStartedAt > MAX_RECONNECT_DURATION_MS) {
    console.warn('[ws] reconnect duration exceeded, giving up (state=failed)')
    setFailed()
    return
  }
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(RECONNECT_BACKOFF_EXPONENT, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS,
  )
  reconnectAttempts++
  state.value = 'reconnecting'
  console.log('[ws] reconnecting in', delay, 'ms (attempt', reconnectAttempts + ')')
  // 「保留上次凭据」的内部实现（S4）：复用 currentCredentials 重新发起（currentCredentials
  // 与 currentUrl 同在 connect 设置，非 null 由 currentUrl 守卫蕴含）
  // 单一定时器不变量：覆盖前清旧 handle——旧定时器若滞留到期再触发，会与本次调度的定时器
  // 构成双链（单飞守卫能挡住双建连，但重连簿记会被无谓搅动）。
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => connect(currentUrl!, currentCredentials!), delay)
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WS_READY_STATE.OPEN) {
      send({ type: 'ping', payload: {} })
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/** 清除探活计时器（入站帧 / onclose / clearTimers 三类清理点共用；幂等） */
function clearProbeAliveTimer(): void {
  if (probeAliveTimer) {
    clearTimeout(probeAliveTimer)
    probeAliveTimer = null
  }
}

function clearTimers(): void {
  stopHeartbeat()
  clearProbeAliveTimer()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }
}
