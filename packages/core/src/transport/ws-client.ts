/**
 * WebSocket 客户端 —— 连接状态机 + 心跳 + 指数退避重连（core 版）。
 *
 * 自 packages/renderer/src/lib/ws-client.ts（重建版）迁入，保留所有运行时不变量：
 *
 * [HISTORICAL] 不变量：
 * 1. 4 态状态机：disconnected → connecting → connected（onclose → reconnecting → connecting...）
 * 2. 心跳：15s 发 ping 保活（仅 keepalive，不跟踪 pong；死连接检测靠 TCP 层 + IPC supervisor
 *    事件 runtime-restarting/runtime-failed 驱动，非 pong 超时）
 * 3. 指数退避重连：1s 起、×2、上限 30s
 * 4. generation 计数：新连接 ++generation，旧 WS 的残余回调（onopen/onclose/onmessage）
 *    检查 gen !== wsGeneration 时直接 return，不干扰新连接
 *
 * S1-W1 auth 握手（spec §3.3 D4）：connect(url, token) 传入 token 时，open 后首条消息发
 * {type:'auth'}，收到 auth.result {ok:true} 才置 connected（resubscribeAll / 心跳随 connected
 * 之后启动，重订阅消息不会被 runtime 当「auth 前消息」丢弃）。token 未传（mock 平台）保持
 * 旧行为。内部重连（退避 / visibility）复用 currentToken；runtime 重启换 token 由
 * use-connection 的 onRuntimePort 路径重新拉取后 connect(url, newToken) 覆盖。auth 5s 客户端
 * 超时（短于 runtime 侧 10s）：超时 close 走 onclose → 正常重连链。
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
import type { ClientMessage, ServerMessage } from '@xyz-agent/shared'
import { getPlatform, WS_READY_STATE, type WebSocketLike } from '../platform/port'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'restarting' // runtime 崩溃，主进程正在拉起新实例（来自 IPC runtime-restarting）
  | 'failed'     // runtime 重启用尽，需用户手动重试（来自 IPC runtime-failed）

// ── 常量 ────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_BACKOFF_EXPONENT = 2
const MAX_RECONNECT_DELAY_MS = 30_000
/** 重连总时长上限（ms）：超过即放弃，置 failed 待用户手动重试，避免长时间无意义重试占用资源。
 *  说明：曾配 attempts 计数上限（MAX_RECONNECT_ATTEMPTS=20），但指数退避（1+2+4+8+16+30…）
 *  累积约第 6-7 次即跨 60s → duration cap 先触发，attempts 永不可达，该常量为死代码已删除。
 *  放弃自动重连的判定唯由本时长上限决定。 */
const MAX_RECONNECT_DURATION_MS = 60_000
/** auth 握手客户端超时（S1-W1）：短于 runtime 侧 10s 握手超时，客户端先主动断开走重连。 */
const AUTH_TIMEOUT_MS = 5_000
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
let reconnectAttempts = 0
let wsGeneration = 0
let currentUrl: string | null = null
/** 本次连接凭据（S1-W1）：connect(url, token) 更新；内部重连复用；mock url 强制清空。 */
let currentToken: string | null = null
/**
 * 本代连接是否已完成 auth（模块级真源，send() 的发送门槛）。
 * WS 握手完成即 readyState=OPEN，但 token 模式下要等 auth.result ok 才算完成——
 * TCP open → auth.result 窗口内 send() 真实送出的消息会被 runtime 设计性静默丢弃
 * （connection-manager handleUnauthedMessage，spec §3.3 D4），故未完成 auth 前入队。
 * connect() 开始时按「无 token 模式视为已完成」初始化；gen 检查保证只有当前代写入。
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
 * @param url   连接地址（mock 平台为 mock:// 前缀）
 * @param token WS auth token（S1-W1）。传入时 open 后先走 auth 握手（首条消息 auth，
 *              等 auth.result ok 才 connected）；不传（mock / 无 IPC）保持旧行为。
 *              未传时保留上次 token 供内部重连复用；mock url 一律清空。
 */
export function connect(url: string, token?: string): void {
  currentUrl = url
  if (url.startsWith('mock:')) {
    currentToken = null
  } else if (token !== undefined) {
    currentToken = token
  }

  // 幂等：已连接或连接中，不重复建连
  if (ws && (ws.readyState === WS_READY_STATE.OPEN || ws.readyState === WS_READY_STATE.CONNECTING)) return

  state.value = 'connecting'
  const gen = ++wsGeneration
  // 本代 auth 状态初始化（无 token 模式在 onopen 即视为完成）；后续读写都走模块级
  // connectionAuthed——send() 需要在 connect 闭包外感知 auth 进度（pre-auth 入队门槛）。
  connectionAuthed = currentToken === null
  ws = getPlatform().webSocket.create(url)
  console.log('[ws] connecting to', url)

  const clearAuthTimer = () => {
    if (authTimer) {
      clearTimeout(authTimer)
      authTimer = null
    }
  }

  /** connected 化（auth 成功或无 token 模式）：置位状态 + 重连簿记 + 启动心跳 + flush 队列。 */
  const markConnected = () => {
    state.value = 'connected'
    reconnectAttempts = 0
    // 连接成功 → 重置重连计时窗口（下次掉线重新开始计数）
    reconnectStartedAt = null
    // G2 活性治理（docs/design/memory-leak-remediation.md §3.4）：重连路径增挂 in-flight
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
      // S1-W1：首条消息必须是 auth；connected 推迟到 auth.result ok（心跳/重订阅随后）
      ws!.send(JSON.stringify({ type: 'auth', payload: { token: currentToken } }))
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
    // 入站帧守卫（D8）：JSON.parse 前置大小检查——超界整条丢弃（不 parse，防 OOM 形态），
    // 归因 + 计数 + 终止阀见 handleOversizedInboundFrame。守卫在 auth 检查之前（任何阶段
    // 的超界帧都拦，含握手期异常帧）。
    const measured = measureInboundFrame(event.data)
    if (measured !== null && isInboundFrameOverLimit(measured)) {
      handleOversizedInboundFrame(measured)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(String(event.data))
    } catch (e) {
      // JSON 解析失败：仅记日志跳过（dispatch 已移出 try，handler 抛错不再被此处吞掉）
      console.error('[ws] parse error:', e)
      return
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

  ws.onclose = () => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，不干扰新连接
    state.value = 'disconnected'
    stopHeartbeat()
    clearAuthTimer()
    dropPreAuthQueue('closed')
    scheduleReconnect()
  }

  ws.onerror = (err) => {
    if (gen !== wsGeneration) return // 旧 WS 残余回调，忽略（避免误 close 掉已被新 gen 取代的当前 socket）
    console.error('[ws] error:', err)
    ws?.close()
  }
}

/** 主动断开（不触发重连） */
export function disconnect(): void {
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
  reconnectTimer = setTimeout(() => connect(currentUrl!), delay)
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

function clearTimers(): void {
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (authTimer) {
    clearTimeout(authTimer)
    authTimer = null
  }
}
