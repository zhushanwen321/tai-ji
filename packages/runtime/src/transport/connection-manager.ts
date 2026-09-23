/**
 * ConnectionManager — WS 连接生命周期 + 认证握手 + 心跳 + 连接池管理（C2 从 server.ts 抽出）。
 *
 * 职责：
 * - 持有 clients 连接池（Set<WebSocket>），供 broker.broadcast 遍历。
 * - WS 服务器生命周期：start（listen 127.0.0.1 + 注册 connection 回调）/ stop（关闭 wss + http）。
 * - auth 握手（S1-W1，spec §3.3 D4）：连接建立后首条消息必须是 {type:'auth', payload:{token}}，
 *   校验通过（unauthed → authed）前不受理任何其他消息（静默丢弃）、10s 超时断开、
 *   失败以 close 1008。authToken=null 时 fail-closed（拒绝全部连接——组合根 env 与
 *   token 文件都缺失的场景，见 index.ts resolveRuntimeToken）。
 * - 心跳：每条消息重置计时器，超时关闭连接（防僵尸连接）。仅对 authed 连接生效——
 *   未认证连接由 authTimer 兜底，防「auth 前发 ping 刷心跳绕过认证超时」。
 * - HTTP /health 端点（与 WS 同端口，简单存活探针；不要求 token——supervisor 探活用，
 *   响应只有 status/uptime，无敏感数据）。
 * - maxPayload：单条消息上限（超限连接被 close 1009，见 shared MAX_WS_PAYLOAD_BYTES 校准注释）。
 *
 * 不含：消息路由（server.ts handleMessage）、消息发送（broker）、业务逻辑（handlers）。
 * 连接 auth 成功后把 ws + 解析出的 msg 通过注入的回调交给上层（RuntimeServer）处理。
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import { MAX_WS_PAYLOAD_BYTES, type ClientMessage } from '@taiji/shared'
import { toErrorMessage } from '../utils/errors.js'
import type { ErrorDetails } from './message-context.js'

const HTTP_OK = 200
const HTTP_NOT_FOUND = 404
const MAX_WS_CLOSE_CODE = 4000
const HEARTBEAT_TIMEOUT_MS = 45_000
/** WS 1001 Going Away（RFC 6455）——服务端计划内关停时发给全部存量连接的 close 码。 */
const WS_CLOSE_GOING_AWAY = 1001
/**
 * stop 等待存量连接优雅退出的有界上界：本机回环 close 握手毫秒级，2s = 20 倍极端余量，
 * 正常路径不触发；超时后 closeAllConnections 强制断开属回收层兜底（非正常路径依赖）。
 */
const STOP_LINGER_GRACE_MS = 2_000
/** auth 握手超时：连接建立后未在此时限内通过认证即断开（spec §3.3 D4 定 10s）。 */
const AUTH_TIMEOUT_MS = 10_000
/** WS policy violation 关闭码（RFC 6455）——auth 失败 / fail-closed 拒绝统一用它。 */
const WS_CLOSE_POLICY_VIOLATION = 1008

/** 常量比较（抗时序攻击）：长度不等直接 false（token 长度非秘密）。 */
function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 连接事件回调（由 RuntimeServer 注入）。
 * - onConnect：新连接**通过 auth 后**建立，交 broker 推送 initial state。
 * - onMessage：收到合法 ClientMessage（必然来自 authed 连接），交 server 路由（返回 Promise，错误由调用方 catch）。
 * - sendError：连接级解析/兜底错误回复（注入 broker.sendError，避免 ConnectionManager 依赖 broker）。
 * - onDisconnect：连接关闭（wave:runtime-wiring）：交 server 调 bus.unsubscribeAll(ws) 清理该 ws
 *   的所有 session 订阅。仅对 authed 连接触发（未认证连接不可能持有订阅）。可选：未注入时只做连接池清理。
 */
export interface ConnectionCallbacks {
  onConnect(ws: WsType): void
  onMessage(msg: ClientMessage, ws: WsType): Promise<void>
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void
  /** ws 断开回调（wave:runtime-wiring）：触发 MessageBus.unsubscribeAll 清理订阅。 */
  onDisconnect?(ws: WsType): void
}

export class ConnectionManager {
  private httpServer: HttpServer
  private wss: WebSocketServer
  /** 连接池（仅 authed 连接）——broker.broadcast 遍历此集合向所有客户端推送。 */
  readonly clients = new Set<WsType>()
  private heartbeatTimers = new Map<WsType, ReturnType<typeof setTimeout>>()
  /** 未认证连接的握手超时计时器（auth 成功/连接关闭时清除）。 */
  private authTimers = new Map<WsType, ReturnType<typeof setTimeout>>()
  /** 已通过 auth 的连接集合（与 clients 池同步维护）。 */
  private authedConnections = new Set<WsType>()

  constructor(
    private port: number,
    private callbacks: ConnectionCallbacks,
    /** auth token；null = fail-closed（拒绝全部连接）。 */
    private authToken: string | null,
  ) {
    this.httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
      } else {
        res.writeHead(HTTP_NOT_FOUND)
        res.end()
      }
    })
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: MAX_WS_PAYLOAD_BYTES })
    // ws 库会把 httpServer 的 'error' 转发到 wss 上再 emit（websocket-server.js 的
    // addListeners）。EventEmitter 语义下 wss 无 error listener 时 emit('error') 直接
    // throw 成 uncaughtException，并中断 httpServer listeners 的后续执行——start()
    // 注册的 reject listener 永远跑不到，Promise 悬挂（TOCTOU 撞端口事故的放大器）。
    // 这里接住转发通道；错误的权威处理在 httpServer 侧（start 的 reject）。
    this.wss.on('error', (err) => {
      console.warn(`[runtime] wss error (forwarded, handled by http server error path): ${String((err as NodeJS.ErrnoException).code ?? err.message)}`)
    })
  }

  /** 启动 HTTP + WS 监听（显式绑回环，不对局域网开放）；注册 connection 回调。 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.on('connection', (ws) => this.handleConnection(ws))
      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        // 传输层不决定进程生死（对齐 callback-server.ts 先例）：EADDRINUSE 只 reject，
        // 进程退出决策上移到组合根（index.ts）。直接终止进程会杀掉测试 worker、
        // 剥夺调用方换端口重试的机会。文案按错误信息可操作规范指向恢复动作。
        if (err.code === 'EADDRINUSE') {
          err.message = `${err.message} — 端口 ${this.port} 被占用（EADDRINUSE）：可能已有另一个 taiji 实例在运行，请关闭其他实例后重试；可用 lsof -i :${this.port} 查看占用进程`
        }
        reject(err)
      })
      this.httpServer.listen(this.port, '127.0.0.1', () => {
        console.log(`[runtime] listening on 127.0.0.1:${this.port}`)
        resolve()
      })
    })
  }

  // ── Connection ────────────────────────────────────────────────

  private handleConnection(ws: WsType): void {
    // 连接数日志两个口径分开输出（review findings-confirmation #5）：旧 `total: clients.size + 1`
    // 把未 auth 新连接混进 authed 池计数——重连风暴期（pre-auth drop 443 条现场）半开旧连接 +
    // 未 auth 新连接堆积时 total 虚高误导排查。authenticated = 已认证池（clients，同
    // authedConnections 同步维护）；pending auth = 握手中连接（authTimers）含本条（set 在本行之后）。
    console.log(
      `[runtime] client connected (authenticated: ${this.authedConnections.size}, ` +
        `pending auth incl. this one: ${this.authTimers.size + 1})`,
    )
    // fail-closed：无 token 配置时拒绝全部连接（组合根已落 warning，这里只拒绝）。
    if (this.authToken === null) {
      this.rejectAuth(ws, 'no_token_configured')
      return
    }
    // unauthed：启动握手超时，认证通过前不进 clients 池、不推 initial state、不启心跳。
    this.authTimers.set(ws, setTimeout(() => {
      console.warn('[runtime] auth timeout, closing connection')
      ws.close(WS_CLOSE_POLICY_VIOLATION, 'Auth timeout')
    }, AUTH_TIMEOUT_MS))
    ws.on('message', (data) => this.handleRawMessage(ws, data))
    ws.on('close', () => this.handleClose(ws))
    ws.on('error', (err) => {
      console.error('[runtime] ws error:', err)
      this.handleClose(ws)
    })
  }

  private handleRawMessage(ws: WsType, data: unknown): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(data)) as ClientMessage
    } catch {
      // 未认证连接不消耗任何处理资源：直接断开（parse 失败的 auth 消息无法认证）。
      if (!this.authedConnections.has(ws)) {
        ws.close(WS_CLOSE_POLICY_VIOLATION, 'Malformed message before auth')
        return
      }
      this.callbacks.sendError(ws, 'parse_error', 'Invalid JSON')
      return
    }
    if (!this.authedConnections.has(ws)) {
      this.handleUnauthedMessage(ws, msg)
      return
    }
    // authed：auth 消息重复发送属协议错误，静默忽略（不进 handleMessage 路由）。
    if (msg.type === 'auth') return
    this.resetHeartbeat(ws)
    this.callbacks.onMessage(msg, ws).catch((err) => {
      console.error('[runtime] unhandled error in handleMessage:', err)
      // RT-1#3：兜底信封补 sessionId（裁决 7：错误消息必须可归属 session）——server 主漏斗
      // 二次抛（error envelope 发送失败）落到这里时，缺 sessionId 的信封会让前端按
      // session 隔离规则丢弃该错误。可选链提取 + typeof 守卫（畸形帧 payload 不可信）。
      const rawSessionId = (msg.payload as { sessionId?: unknown } | undefined)?.sessionId
      const details = typeof rawSessionId === 'string' && rawSessionId ? { sessionId: rawSessionId } : undefined
      try {
        this.callbacks.sendError(ws, 'handler_error', toErrorMessage(err), msg.id, details)
      // eslint-disable-next-line taste/no-silent-catch -- ws may have already closed
      } catch { /* ws 可能已关闭 */ }
    })
  }

  /** unauthed 状态机：只受理首条 auth 消息；其他消息静默丢弃（设计意图，spec §3.3 D4）。 */
  private handleUnauthedMessage(ws: WsType, msg: ClientMessage): void {
    if (msg.type !== 'auth') {
      console.warn(`[runtime] dropping pre-auth message (type=${String((msg as { type?: unknown }).type)})`)
      return
    }
    const token = (msg.payload as { token?: unknown } | undefined)?.token
    if (typeof token !== 'string' || !tokenEquals(token, this.authToken ?? '')) {
      console.warn('[runtime] auth failed: bad token')
      this.rejectAuth(ws, 'bad_token')
      return
    }
    // unauthed → authed：清握手计时、入池、回执、推 initial state、启心跳。
    const timer = this.authTimers.get(ws)
    if (timer) clearTimeout(timer)
    this.authTimers.delete(ws)
    this.authedConnections.add(ws)
    this.clients.add(ws)
    ws.send(JSON.stringify({ type: 'auth.result', payload: { ok: true } }))
    this.callbacks.onConnect(ws)
    this.resetHeartbeat(ws)
    // 口径对齐上方 handleConnection：authenticated 只计已认证池（旧文案 total 同值但语义混用）
    console.log(`[runtime] client authenticated (authenticated: ${this.clients.size})`)
  }

  /** 认证失败路径：回执结果 + close 1008。 */
  private rejectAuth(ws: WsType, reason: string): void {
    try {
      ws.send(JSON.stringify({ type: 'auth.result', payload: { ok: false, reason } }))
    // eslint-disable-next-line taste/no-silent-catch -- socket may already be closed
    } catch { /* send 失败时直接走 close */ }
    ws.close(WS_CLOSE_POLICY_VIOLATION, 'Unauthorized')
    // close 事件不一定触发（对端先断），主动清理本侧簿记。
    this.cleanupConnection(ws)
  }

  private handleClose(ws: WsType): void {
    const wasAuthed = this.authedConnections.has(ws)
    this.cleanupConnection(ws)
    if (wasAuthed) {
      this.callbacks.onDisconnect?.(ws)
      console.log(`[runtime] client disconnected (total: ${this.clients.size})`)
    }
  }

  private cleanupConnection(ws: WsType): void {
    this.clients.delete(ws)
    this.authedConnections.delete(ws)
    this.clearHeartbeat(ws)
    const timer = this.authTimers.get(ws)
    if (timer) { clearTimeout(timer); this.authTimers.delete(ws) }
  }

  private resetHeartbeat(ws: WsType): void {
    const existing = this.heartbeatTimers.get(ws)
    if (existing) clearTimeout(existing)
    this.heartbeatTimers.set(ws, setTimeout(() => {
      console.warn('[runtime] heartbeat timeout, closing connection')
      ws.close(MAX_WS_CLOSE_CODE, 'Heartbeat timeout')
    }, HEARTBEAT_TIMEOUT_MS))
  }

  private clearHeartbeat(ws: WsType): void {
    const timer = this.heartbeatTimers.get(ws)
    if (timer) { clearTimeout(timer); this.heartbeatTimers.delete(ws) }
  }

  /**
   * 关闭：清理全部计时器 + 优雅关闭全部存量 WS 连接 + 关闭 WS / HTTP。
   *
   * [A4 挂死根修]（2026-09-12，crash-forensics Gate B A4 复验）：旧实现直接
   * `httpServer.close(callback)` 等回调——Node 语义是回调在**全部存量连接结束**后才触发，
   * 而本服务 ws 库 8.21 以 external-server 模式（`{ server }` 注入）创建，其 `close()`
   * 对存量连接只摘 upgrade 监听、不主动关闭（websocket-server.js 的 noServer||server
   * 分支仅 _removeListeners + _shouldEmitClose）。于是存量连接的关闭全靠对端自觉：
   * 滚动重启是唯一「main + renderer 都存活、仅 runtime 退出」的路径，renderer 的 WS
   * 连接保持、无人发 close 帧 → close 回调永不触发 → shutdown 序列停在 conn.stop →
   * runtime 不退出（退出码 86 不可达）→ LivenessMonitor 3 连败判死强杀，计划内零退避
   * 路径退化成崩溃退避。SIGTERM 全 app 退出路径 renderer 进程先亡、连接随之断开，缺陷
   * 因此从未暴露。根修 = 服务端主动逐连接发 close 帧（滚动重启后 renderer 重连新 runtime
   * 正是设计预期恢复路径，ws-client 对任意 close 码统一走 scheduleReconnect）。
   */
  async stop(): Promise<void> {
    // 握手中（未 auth）连接先取出——下方清 authTimers 后不可达；它们同样占用 httpServer
    // 连接计数，close 帧必须覆盖。
    const pendingAuthConnections = [...this.authTimers.keys()]
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer)
    }
    this.heartbeatTimers.clear()
    for (const timer of this.authTimers.values()) {
      clearTimeout(timer)
    }
    this.authTimers.clear()
    // 1001 Going Away（RFC 6455）：计划内服务端关停语义。ws 库 close 对已关闭/握手中
    // 连接均为安全 no-op，不抛错。
    for (const ws of this.authedConnections) ws.close(WS_CLOSE_GOING_AWAY, 'Server shutting down')
    for (const ws of pendingAuthConnections) ws.close(WS_CLOSE_GOING_AWAY, 'Server shutting down')
    // 摘 wss upgrade 监听 + httpServer 停止接受新连接。
    this.wss.close()
    // /health 探针的 keep-alive 空闲连接不经 WS close 帧路径，显式清（探针已验证：本方法
    // 只清无活跃请求的连接，不触碰 upgrade 后的 WS socket）。
    this.httpServer.closeIdleConnections()
    // 等待全部连接结束。正常路径 close 握手在本机回环毫秒级完成；STOP_LINGER_GRACE_MS 是
    // 回收层有界兜底（ADR-0047 口径）：对不回 close 帧的异常对端强制断开，保证 stop 必然
    // resolve、runtime 必然走到 process.exit(86)。
    return new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        console.warn('[runtime] stop: connections lingering after grace period — force closing')
        this.httpServer.closeAllConnections()
      }, STOP_LINGER_GRACE_MS)
      this.httpServer.close(() => {
        clearTimeout(forceTimer)
        resolve()
      })
    })
  }
}

/** WS OPEN 状态码——broker.send 检测连接态用。 */
export const WS_OPEN = WebSocket.OPEN
