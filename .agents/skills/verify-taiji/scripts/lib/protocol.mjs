/**
 * runtime WS 协议原语（lib 层）：auth 握手 + RPC 往返 + 广播事件队列。
 *
 * 语义移植自 e2e/fixtures/launch-app-real.ts 的 openAuthedWs / wsRoundTrip / openListenWs /
 * waitForRuntime / waitForExtensionsReady（不 import 该文件——它依赖 @playwright/test），
 * 但把「三个连接」收成一个连接：同一个 WS 上既发 RPC 又收广播（runtime 支持）。
 *
 * 纪律（API-CONTRACT §1.2）：
 * - 事件消费必须按 sessionId 过滤（本文件只保证 events 原样带 type/payload；谓词由调用方给）；
 * - 条件等待（waitFor 条件轮询 + 明确超时），超时附最近 20 帧类型摘要（区分「慢」与「死」）；
 * - keepalive 定时器在 close 时清理（否则进程不退出）。
 *
 * 零第三方依赖：Node ≥ 22 自带全局 WebSocket。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 事件队列上限（长验收防内存无界增长）。 */
const MAX_EVENTS = 5_000

/** auth 握手 / RPC 默认超时常量。 */
const AUTH_TIMEOUT_MS = 15_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const KEEPALIVE_INTERVAL_MS = 20_000
const POLL_INTERVAL_MS = 50

/**
 * RPC → reply 类型映射（协议表 ReplyPayloadMap 的 wire 事实）。
 *
 * 注意（契约缺口）：API-CONTRACT §1.2 写「replyType 省略 = 与 type 同名」，
 * 但 protocol.ts 里大量 RPC 的 reply 是异名的（session.create→session.created、
 * plugin.list→config.plugins 等）。因此本表优先，未登记的再回落同名。
 */
const REPLY_TYPES = {
  'session.create': 'session.created',
  'session.fork': 'session.created',
  'session.restore': 'session.created',
  'session.delete': 'session.deleted',
  'session.deleteByCwd': 'session.deletedByCwd',
  'session.switch': 'session.switched',
  'session.history': 'session.history',
  'session.getCommands': 'session.commands',
  'session.getContext': 'context.update',
  'session.getSubagents': 'session.subagents',
  'session.getWorkflows': 'session.workflows',
  'config.sessions': 'config.sessions',
  'model.list': 'model.list',
  'model.switch': 'model.switched',
  'config.setProvider': 'config.providerUpdated',
  'config.deleteProvider': 'config.providerUpdated',
  'message.send': 'message.status',
  'message.abort': 'message.status',
  'ping': 'pong',
  'extension.list': 'config.extensions',
  'plugin.list': 'config.plugins',
  'plugin.toggle': 'config.plugins',
  'plugin.config.get': 'plugin:config',
  'plugin.config.set': 'plugin:config',
}

class ProtocolError extends Error {
  constructor(message, { hint, evidence, code } = {}) {
    super(message)
    this.name = 'ProtocolError'
    this.hint = hint
    this.evidence = evidence
    this.code = code
  }
}

/**
 * 建立已认证的连接。
 * @param {{dataDir:string, runtimePort:number, token?:string, authTimeoutMs?:number}} options
 */
export async function createProtocol(options) {
  const dataDir = path.resolve(options.dataDir)
  const runtimePort = options.runtimePort
  if (!runtimePort) {
    throw new ProtocolError('createProtocol 缺 runtimePort', {
      hint: '先 instance.waitReady() 再从 <dataDir>/runtime.port 读端口',
      evidence: { dataDir },
    })
  }
  const token = options.token ?? readToken(dataDir)
  if (!token) {
    throw new ProtocolError(`runtime-token 缺失或为空：${path.join(dataDir, 'runtime-token')}`, {
      hint: '实例未起 / main 未写 token；先 instance.waitReady()，仍缺失看 <dataDir>/logs/ main-/runtime- 日志',
      evidence: { dataDir },
    })
  }

  const ws = new WebSocket(`ws://127.0.0.1:${runtimePort}`)
  const events = []
  const pending = new Map() // id -> { resolve, reject, timer, type, startedAt }
  let seq = 0
  let closed = false
  let closeReason = null
  const authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS

  const waiters = new Set() // waitFor 轮询的安全唤醒（仅用于打断 sleep，判定仍在循环内重算）

  function notifyFrame() {
    for (const w of waiters) w()
  }

  function pushEvent(frame) {
    events.push({
      type: frame.type,
      payload: frame.payload ?? {},
      receivedAt: Date.now(),
      seq: frame.seq,
    })
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  }

  function onMessage(raw) {
    let frame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
    } catch {
      return // 非 JSON 帧（理论上不存在）忽略
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'auth.result') return // 握手由 open 阶段消费
    if (frame.id !== undefined && frame.id !== null) {
      const p = pending.get(frame.id)
      if (!p) {
        // 带 id 但不匹配任何在途 RPC = 服务端 push 帧：state topic（session.delivery /
        // session.occupancy 等）与 broadcast 用 message-broker nextPushId() 的 `push_<n>` id，
        // 区别于 RPC reply 的配对 id（lib RPC id = `rpc-*`、keepalive = `ka-*`，无碰撞）。
        // 按广播帧入 events，否则状态帧被当「无关 reply」静默丢弃、waitFor 永远观测不到
        // （2026-10-24 p1-queue-inline-edit 首跑实测：session.delivery 全部被丢）。
        if (frame.type === 'error') return // 无匹配在途 RPC 的 error envelope 无从归因，不入 events
        pushEvent(frame)
        notifyFrame()
        return
      }
      pending.delete(frame.id)
      clearTimeout(p.timer)
      if (frame.type === 'error') {
        const payload = frame.payload ?? {}
        p.reject(
          new ProtocolError(`RPC ${p.type} 返回错误: ${payload.code ?? 'error'} — ${payload.message ?? ''}`, {
            code: payload.code,
            hint: '看 <dataDir>/logs/runtime-*.log 对应时间点；协议错误码见 buildError 表',
            evidence: { requestType: p.type, expectedReplyType: p.replyType, errorPayload: payload },
          }),
        )
      } else {
        // id 是权威匹配键；reply 类型用于诊断（异名映射见 REPLY_TYPES）。
        // __type 用不可枚举属性挂载：JSON.stringify / spread 不会把它当 payload 字段回传。
        const out = { ...(frame.payload ?? {}) }
        Object.defineProperty(out, '__type', { value: frame.type, enumerable: false, configurable: true })
        p.resolve(out)
      }
      return
    }
    // 无 id = 广播帧
    if (frame.type === 'error') {
      pushEvent(frame)
      return
    }
    pushEvent(frame)
    notifyFrame()
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ProtocolError(`WS auth 握手超时（${authTimeoutMs}ms）`, {
          hint: 'runtime 未起或端口不是本实例；核对 <dataDir>/runtime.port 与 lsof',
          evidence: { runtimePort, dataDir },
        }),
      )
    }, authTimeoutMs)
    let authed = false
    const onFrame = (ev) => {
      let frame
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      if (frame?.type === 'auth.result') {
        if (authed) return
        authed = true
        clearTimeout(timer)
        if (frame.payload?.ok === true) resolve()
        else
          reject(
            new ProtocolError(`WS auth 被拒: ${frame.payload?.reason ?? 'unknown'}`, {
              hint: 'token 与 runtime 不匹配（旧实例 / 连错端口）；重新 waitReady 后再连',
              evidence: { reason: frame.payload?.reason, dataDir, runtimePort },
            }),
          )
        return
      }
      // auth 完成后的所有帧走统一分发（单监听器，避免双监听器重复入队）
      if (authed) onMessage(ev.data)
    }
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
    })
    ws.addEventListener('message', onFrame)
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(
        new ProtocolError('WS 连接失败', {
          hint: `确认 runtime 在 127.0.0.1:${runtimePort} 监听（lsof -i :${runtimePort}）`,
          evidence: { runtimePort, dataDir },
        }),
      )
    })
    ws.addEventListener('close', () => {
      clearTimeout(timer)
      if (!authed) {
        reject(
          new ProtocolError('WS 在 auth 完成前关闭', {
            hint: 'runtime 可能刚退出；看 <dataDir>/logs/runtime-*.log',
            evidence: { runtimePort },
          }),
        )
      }
    })
  })


  ws.addEventListener('close', (ev) => {
    closed = true
    closeReason = { code: ev.code, reason: ev.reason }
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(
        new ProtocolError(`WS 关闭导致 RPC ${p.type} 中断`, {
          hint: 'runtime 退出 / 网络断开；看 <dataDir>/logs/runtime-*.log',
          evidence: { code: ev.code, reason: ev.reason, requestType: p.type },
        }),
      )
    }
    pending.clear()
    notifyFrame()
  })

  // keepalive：runtime 无服务端心跳超时，但长静默连接被 OS/代理回收的窗口存在；
  // 用只读 ping（reply 带 id 不入 events）保活。close 时清理（否则进程不退出）。
  const keepalive = setInterval(() => {
    if (closed) return
    try {
      const id = `ka-${++seq}`
      pending.set(id, {
        resolve: () => {},
        reject: () => {},
        timer: setTimeout(() => pending.delete(id), 5_000),
        type: 'keepalive',
        startedAt: Date.now(),
      })
      ws.send(JSON.stringify({ type: 'ping', id, payload: {} }))
    } catch {
      /* ws 正在关闭 */
    }
  }, KEEPALIVE_INTERVAL_MS)
  keepalive.unref?.()

  function recentTypeSummary(n = 20) {
    return events
      .slice(-n)
      .map((e) => `${e.type}@${new Date(e.receivedAt).toISOString().slice(11, 23)}`)
      .join(', ')
  }

  /** 发 RPC（reply 以 id 匹配；错误 envelope 转 reject）。 */
  async function call(type, payload = {}, opts = {}) {
    if (closed) {
      throw new ProtocolError(`连接已关闭，无法发 ${type}`, {
        hint: '重新 createProtocol（实例可能已重启）',
        evidence: { closeReason },
      })
    }
    const id = opts.id ?? `rpc-${++seq}-${Date.now().toString(36)}`
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const expectedReplyType = opts.replyType ?? REPLY_TYPES[type] ?? type
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new ProtocolError(`RPC ${type} 超时（${timeoutMs}ms，id=${id}）`, {
            hint: '用 --json 的单步 vp 复现；超时看 runtime 日志与最近帧摘要（区分慢与死）',
            evidence: { type, id, timeoutMs, expectedReplyType, recentFrames: recentTypeSummary(20) },
          }),
        )
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer, type, replyType: expectedReplyType, startedAt: Date.now() })
    })
    const frame = { type, id, payload }
    try {
      ws.send(JSON.stringify(frame))
    } catch (e) {
      const p = pending.get(id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(id)
      }
      throw new ProtocolError(`发送 ${type} 失败: ${e instanceof Error ? e.message : String(e)}`, {
        hint: 'WS 可能已关闭',
        evidence: { type },
      })
    }
    return promise
  }

  /** 订阅 session（返回快照）。 */
  async function subscribe(sessionId, opts = {}) {
    const payload = { sessionId }
    if (opts.fromSeq !== undefined) payload.fromSeq = opts.fromSeq
    const reply = await call('session.subscribe', payload, { replyType: 'session.subscribe', timeoutMs: opts.timeoutMs ?? 30_000 })
    const { __type, ...rest } = reply
    return {
      snapshot: rest.snapshot ?? [],
      stateSnapshot: rest.stateSnapshot ?? [],
      lastSeq: rest.lastSeq ?? 0,
      gap: rest.gap,
      raw: rest,
    }
  }

  /**
   * 条件等待：轮询事件队列直到 predicate 命中（禁固定 sleep 后断言）。
   * @param {(evt:{type:string,payload:object,receivedAt:number})=>boolean} predicate
   */
  /**
   * 条件等待：轮询事件队列直到 predicate 命中。
   *
   * [契约 §1.2 落地] `opts.sessionId` 存在时**先按 sessionId 过滤再交给 predicate**
   * （旧实现把过滤责任全推给调用方，契约声称的能力并未实现，审查 C 指出）。
   * 帧上 `payload.sessionId` 缺省视为「全局帧」，对任何 session 都放行（与
   * waitTurnEnd 的既有语义一致）。
   */
  async function waitFor(predicate, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const sid = opts.sessionId
    const startedAt = Date.now()
    let cursor = Math.max(0, Math.min(opts.since ?? 0, events.length))
    const deadline = startedAt + timeoutMs
    const matchesSession = (evt) =>
      sid === undefined || evt.payload?.sessionId === undefined || evt.payload?.sessionId === sid
    for (;;) {
      while (cursor < events.length) {
        const evt = events[cursor++]
        if (matchesSession(evt) && predicate(evt)) return evt
      }
      if (Date.now() >= deadline) {
        throw new ProtocolError(`waitFor 超时（${timeoutMs}ms，已扫 ${events.length} 帧）`, {
          hint: '看 evidence.recentFrames：有推进=慢，无目标类型=可能死锁/未订阅',
          evidence: {
            timeoutMs,
            totalEvents: events.length,
            recentFrames: recentTypeSummary(20),
          },
        })
      }
      // 等待新帧或 50ms 安全轮询（判定每轮重算，非盲等）
      await new Promise((resolve) => {
        const w = () => {
          waiters.delete(w)
          resolve()
        }
        waiters.add(w)
        setTimeout(w, POLL_INTERVAL_MS)
      })
    }
  }

  /** 发消息（默认走 delivery.submit 统一入口；deliver:false 退化 message.send）。 */
  async function send(sessionId, text, opts = {}) {
    const clientUuid = opts.clientUuid ?? randomUuid()
    if (opts.deliver === false) {
      await call('message.send', { sessionId, content: text, clientUuid }, { timeoutMs: opts.timeoutMs ?? 60_000 })
      return { clientUuid, channel: 'message.send' }
    }
    const reply = await call(
      'delivery.submit',
      { sessionId, content: text, clientUuid },
      { timeoutMs: opts.timeoutMs ?? 60_000 },
    )
    return { clientUuid, channel: 'delivery.submit', reply }
  }

  /**
   * 等 turn 结束（message.complete / message.error / message.stream_error / session.exited
   * 都算结束；返回事件，调用方按 type 区分成功与失败）。
   */
  async function waitTurnEnd(sessionId, opts = {}) {
    const since = opts.since ?? events.length
    const timeoutMs = opts.timeoutMs ?? 180_000
    const endTypes = new Set(['message.complete', 'message.error', 'message.stream_error', 'session.exited'])
    const evt = await waitFor((e) => endTypes.has(e.type), { timeoutMs, since, sessionId })
    return {
      type: evt.type,
      payload: evt.payload,
      ok: evt.type === 'message.complete' && evt.payload?.stopReason !== 'error',
      at: evt.receivedAt,
    }
  }

  async function history(sessionId, opts = {}) {
    const payload = { sessionId }
    if (opts.limitTurns !== undefined) payload.limitTurns = opts.limitTurns
    if (opts.cursor !== undefined) payload.cursor = opts.cursor
    const reply = await call('session.history', payload, { timeoutMs: opts.timeoutMs ?? 60_000 })
    const { __type, ...rest } = reply
    return rest
  }

  async function close() {
    clearInterval(keepalive)
    // 先拒掉未完成 RPC（不等 close 事件，防 hang）
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(
        new ProtocolError(`close() 中断 RPC ${p.type}`, {
          hint: '调用方主动关闭了协议连接',
          evidence: { requestType: p.type },
        }),
      )
      pending.delete(id)
    }
    for (const w of waiters) w()
    waiters.clear()
    if (closed) return
    closed = true
    try {
      ws.close()
    } catch {
      /* already closing */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      ws.addEventListener('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return {
    /** 收到的广播帧（无 id），元素 {type,payload,receivedAt,seq?}。 */
    events,
    get closed() {
      return closed
    },
    get closeReason() {
      return closeReason
    },
    call,
    subscribe,
    waitFor,
    send,
    waitTurnEnd,
    history,
    close,
    recentTypeSummary,
  }
}

function readToken(dataDir) {
  const file = path.join(dataDir, 'runtime-token')
  try {
    return fs.readFileSync(file, 'utf8').trim() || null
  } catch {
    return null
  }
}

function randomUuid() {
  // 幂等键只要求进程内唯一 + 形态稳定，不要求密码学强度
  return `verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
