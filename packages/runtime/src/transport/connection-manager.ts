/**
 * ConnectionManager — WS 连接生命周期 + 认证握手 + 心跳 + 连接池管理（C2 从 server.ts 抽出）。
 *
 * 职责：
 * - 持有 clients 连接池（Set<WebSocket>），供 broker.broadcast 遍历。
 * - WS 服务器生命周期：start（listen 绑定地址参数化，默认 127.0.0.1——remote-access D1；
 *   注册 connection 回调）/ stop（关闭 wss + http）。
 * - auth 握手（S1-W1，spec §3.3 D4）：连接建立后首条消息必须是 {type:'auth', payload:{token}}，
 *   校验通过（unauthed → authed）前不受理任何其他消息（静默丢弃）、10s 超时断开、
 *   失败以 close 1008。token 校验是集合成员比较（remote-access D2）：{spawn token} ∪
 *   {remote token（仅开态、每次握手热读 provider）}；两个通道都缺失时 fail-closed
 *   （拒绝全部连接——组合根 env 与 token 文件都缺失且无 remote 通道的场景，见 index.ts
 *   resolveRuntimeToken 与 remoteTokenProvider 装配）。
 * - 心跳：每条消息重置计时器，超时关闭连接（防僵尸连接）。仅对 authed 连接生效——
 *   未认证连接由 authTimer 兜底，防「auth 前发 ping 刷心跳绕过认证超时」。
 * - HTTP /health 端点（与 WS 同端口，简单存活探针；不要求 token——supervisor 探活用，
 *   响应只有 status/uptime，无敏感数据）。
 * - 移动壳静态托管分派（remote-access D3/E5，S3 拆分后）：静态实现与开态判定均在
 *   mobile-static.ts + 组合根，本类只持一个可空 handler 引用——注入时非 /health 请求
 *   委托 handler 服务，未注入（null）时 /health 之外一律 404，与无远程访问形态
 *   逐字节一致。
 * - maxPayload：单条消息上限（超限连接被 close 1009，见 shared MAX_WS_PAYLOAD_BYTES 校准注释）。
 *
 * 不含：消息路由（server.ts handleMessage）、消息发送（broker）、业务逻辑（handlers）。
 * 连接 auth 成功后把 ws + 解析出的 msg 通过注入的回调交给上层（RuntimeServer）处理。
 */
import { createServer, type Server as HttpServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, WebSocket, type WebSocket as WsType } from 'ws'
import {
  isRemoteAccessConfigShape,
  MAX_WS_PAYLOAD_BYTES,
  REMOTE_ACCESS_FILENAME,
  REMOTE_TOKEN_HEX64,
  type ClientMessage,
} from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'
import { toErrorMessage } from '../utils/errors.js'
import type { ErrorDetails } from './message-context.js'
import type { MobileStaticHandler } from './mobile-static.js'

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

/** 默认监听绑定地址（remote-access D1）：纯回环，与参数化前现状逐字节一致。 */
const DEFAULT_LISTEN_HOST = '127.0.0.1'

/** 常量比较（抗时序攻击）：长度不等直接 false（token 长度非秘密）。 */
function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// ── remote token 热读（remote-access D2/E10）───────────────────────────────
// 读取通道形态与 index.ts resolveRuntimeToken 同构（fs.readFileSync + getDataDir() 推导），
// 但触发时机不同：runtime-token 是启动期一次解析，remote token 是每次 WS auth 握手热读——
// token 轮换 = main 重写 remote-access.json，下一次新握手即生效，无 runtime 重启（D2）。
// 独立导出纯解析函数 + IO 包装：组合根（index.ts）import 即执行 main() 不可直测，
// E10 三态（缺失/坏 JSON/坏字段）的 fail-closed 语义由本模块单测守卫。

/**
 * 解析 remote-access.json 内容为 remote token（E10 处置：任何不合法形态返回 null，
 * remote 集合退化为空——仅 spawn token 可认证，fail-closed）。
 *
 * - 坏 JSON / 非对象 / 字段不合法 → error 日志（含恢复指引）+ null；
 * - enabled=false → 关态文件留存是设计内合法产出（D2 配套规格③），debug 级 + null，
 *   不按错误响亮（计算器分层：设计内合法产出不是错误）。
 */
export function parseRemoteAccessToken(raw: string): string | null {
  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {
    console.error(
      `[runtime] remote access: ${REMOTE_ACCESS_FILENAME} 不是合法 JSON — remote token 不可用` +
        '（fail-closed：仅 spawn token 可认证，远程客户端将全部被拒）。' +
        '恢复：回桌面端 设置 → 远程访问面板 执行轮换（重写配置文件），或检查该文件内容',
    )
    return null
  }
  // shape 判据单源 = shared 的 isRemoteAccessConfigShape（main 写侧守卫 import 同一
  // 谓词，判据不可能分叉）；本侧从宽策略（enabled=false 早退跳过 hex、enabled=true 才
  // 校验 hex、任何不合法形态 fail-closed 返回 null）刻意保留在本地——与 main 写侧
  // 从严恒校验的不对称是文档化的双侧策略差异，不上收、不参数化。
  if (!isRemoteAccessConfigShape(config)) {
    console.error(
      `[runtime] remote access: ${REMOTE_ACCESS_FILENAME} 字段不合法（缺 enabled/token 或类型不符）— ` +
        'remote token 不可用（fail-closed：仅 spawn token 可认证）。' +
        '恢复：回桌面端 设置 → 远程访问面板 执行轮换（重写配置文件），或删除该文件后在面板重新开启',
    )
    return null
  }
  // 关态文件留存（D2 配套规格③）：开关关闭但文件还在，token 不入集合。这是开关切换
  // 触发 runtime 重启前的正常窗口态，非错误。
  if (config.enabled === false) {
    console.debug(`[runtime] remote access: ${REMOTE_ACCESS_FILENAME} enabled=false（关态文件留存），remote token 不入鉴权集合`)
    return null
  }
  if (!REMOTE_TOKEN_HEX64.test(config.token)) {
    console.error(
      `[runtime] remote access: ${REMOTE_ACCESS_FILENAME} token 字段不符合契约（须为 64 位 hex 小写）— ` +
        'remote token 不可用（fail-closed：仅 spawn token 可认证）。' +
        '恢复：回桌面端 设置 → 远程访问面板 执行轮换（重新生成 token 并重写配置文件）',
    )
    return null
  }
  return config.token
}

// ── 移动壳静态托管（remote-access D3/E4/E5）────────────────────────────────
// 实现已抽至 mobile-static.ts（S3 拆分：静态托管与连接生命周期是正交变化轴）。
// 开态判定（remote-access flag → dist 探测 → handler 构造）归组合根（index.ts），
// 本模块只消费注入的 handler（见 ConnectionManagerOptions.mobileStaticHandler）。

/**
 * 热读 `<getDataDir()>/<REMOTE_ACCESS_FILENAME>` 取 remote token（remote-access D2）。
 * 每次握手调用一次（auth 是低频事件），文件缺失/不可读按 E10 fail-closed 返回 null +
 * 响亮日志（含恢复指引）。组合根仅在 `--remote-access` 开态把本函数装配为
 * remoteTokenProvider——关态不装配，本函数不被调用（关态零 IO）。
 */
export function readRemoteAccessToken(): string | null {
  const filePath = join(getDataDir(), REMOTE_ACCESS_FILENAME)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    console.error(
      `[runtime] remote access: 读取 ${filePath} 失败（${toErrorMessage(error)}）— ` +
        'remote token 不可用（fail-closed：仅 spawn token 可认证，远程客户端将全部被拒）。' +
        '恢复：回桌面端 设置 → 远程访问面板 确认开关并执行轮换（重新生成 token 并写回文件），或检查文件权限',
    )
    return null
  }
  return parseRemoteAccessToken(raw)
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

/**
 * 远程访问服务形态选项（remote-access U0.1）：组合根经 parseArgs（argv，D9）解析并
 * 做完开态判定后经 RuntimeServer 透传注入。全部可选——缺省即现状形态（纯回环 + 单
 * spawn token，零静态挂载）。
 */
export interface ConnectionManagerOptions {
  /**
   * 移动壳静态 handler（remote-access D3，S3 拆分后形态）：由 mobile-static.ts 的
   * createMobileStaticHandler 构造，组合根仅在 remote-access 开态且 dist 探测通过
   * （resolveMobileStaticRoot 非空）时注入；本类不感知静态细节，只按「是否注入」
   * 分派——未注入（关态/E5 禁用）时 /health 之外一律 404，与无远程访问形态逐字节
   * 一致。所有分支都写完响应，分派即视为已服务。
   */
  mobileStaticHandler?: MobileStaticHandler
  /**
   * remote token 热读 provider（remote-access D2）：**每次 auth 握手时调用**，
   * 返回值非 null 时作为集合第二成员参与校验（逐成员 tokenEquals）。
   * 未注入 = 关态：不调用、remote 集合恒空、零文件 IO（D9 ambient 免疫的运行时半边）。
   * 返回 null = E10（文件缺失/损坏，读侧已响亮日志），该次握手 remote 通道为空。
   */
  remoteTokenProvider?: () => string | null
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
  /**
   * 移动壳静态 handler（remote-access D3/E5，S3 拆分后）：组合根开态判定 + dist 探测
   * 通过时注入，实现与生命周期在 mobile-static.ts。null = 关态或 E5 禁用，HTTP 分派
   * 不进静态分支（与无远程访问形态逐字节一致）。
   */
  private readonly mobileStaticHandler: MobileStaticHandler | null

  constructor(
    private port: number,
    private callbacks: ConnectionCallbacks,
    /** auth token（spawn 通道）；null = 该通道缺失（集合语义下是否 fail-closed 见 handleConnection）。 */
    private authToken: string | null,
    /** 远程访问服务形态选项（remote-access U0.1）；缺省 = 现状形态（纯回环 + 单 spawn token）。 */
    private options: ConnectionManagerOptions = {},
  ) {
    this.mobileStaticHandler = options.mobileStaticHandler ?? null
    this.httpServer = createServer((req, res) => {
      // 分派顺序固定：/health 探针先于静态托管（开态行为不变）；handler 未注入
      // （关态/E5 禁用）只有 /health 与 404 两条路径，与远程访问引入前逐字节一致。
      if (req.url === '/health') {
        res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
      } else if (this.mobileStaticHandler !== null) {
        // 静态实现委托注入的 handler（mobile-static.ts）；handler 所有分支都写完响应。
        void this.mobileStaticHandler(req, res)
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

  /**
   * 启动 HTTP + WS 监听；注册 connection 回调。
   * 绑定地址参数化（remote-access D1）：默认 127.0.0.1 纯回环（与参数化前现状逐字节一致），
   * 远程访问开态由组合根传 '0.0.0.0'。仍是同一个 HTTP+WS server、同一份连接池。
   */
  start(host: string = DEFAULT_LISTEN_HOST): Promise<void> {
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
      this.httpServer.listen(this.port, host, () => {
        console.log(`[runtime] listening on ${host}:${this.port}`)
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
    // fail-closed：两个凭据通道（spawn token / remote token 热读）都缺失时拒绝全部连接
    // （组合根已落 warning，这里只拒绝）。开态 spawn token 缺失但 remote 通道在时仍走
    // 正常握手——集合校验时 remote 也为空则 bad_token 拒绝，fail-closed 语义不破。
    if (this.authToken === null && !this.options.remoteTokenProvider) {
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
      try {
        this.callbacks.sendError(ws, 'handler_error', toErrorMessage(err), msg.id)
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
    if (typeof token !== 'string' || !this.isAcceptedToken(token)) {
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

  /**
   * token 集合成员校验（remote-access D2）：{spawn token} ∪ {remote token}，逐成员
   * 走 tokenEquals（timingSafeEqual）——单值扩集合不退化抗时序属性，禁 includes/Set.has。
   * remote 通道每次握手热读（provider 调用点唯一在此，保证轮换文件即生效）；关态
   * provider 未装配时短路返回（不调用、零文件 IO）。
   */
  private isAcceptedToken(token: string): boolean {
    if (this.authToken !== null && tokenEquals(token, this.authToken)) return true
    const provider = this.options.remoteTokenProvider
    if (!provider) return false
    const remote = provider()
    return remote !== null && tokenEquals(token, remote)
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
