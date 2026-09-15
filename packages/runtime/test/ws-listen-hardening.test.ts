/**
 * SEC-U2（spec §3.3 D4 / S1-W1）：WS 传输安全加固回归——loopback 绑定 + maxPayload +
 * auth 首消息握手（unauthed 状态机：错 token 1008 / pre-auth 消息丢弃 / 正确 token 放行 /
 * fail-closed）。
 *
 * 载体：真实 ConnectionManager + 真实 ws 客户端（对齐 spec B1/B2 验收场景的进程内版本；
 * 跨进程版本见 scripts/verify-ws-auth.sh）。
 *
 * 不测 10s auth 超时真实等待（vitest 默认 5s 单测超时，且 fake timers 对真实 WS 无效）——
 * 超时路径由 scripts/verify-ws-auth.sh 的真实 runtime 场景覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createServer } from 'node:http'
import { ConnectionManager } from '../src/transport/connection-manager.js'
import { startOnFreePort } from './helpers/free-port.js'
import { MAX_WS_PAYLOAD_BYTES } from '@taiji/shared'
import type { ClientMessage } from '@taiji/shared'

const TEST_TOKEN = 'sec-u2-token-0123456789abcdef'

/** 起一个最小 ConnectionManager（onMessage/onConnect 全 mock，只测传输层行为）。
 * EADDRINUSE 韧性：经 startOnFreePort 撞端口自动换号重试（helpers/free-port.ts）。 */
async function startManager(token: string | null): Promise<{ conn: ConnectionManager; port: number; onMessage: ReturnType<typeof vi.fn>; onConnect: ReturnType<typeof vi.fn> }> {
  const onMessage = vi.fn().mockResolvedValue(undefined)
  const onConnect = vi.fn()
  const { instance: conn, port } = await startOnFreePort(
    (p) => new ConnectionManager(p, {
      onConnect,
      onMessage,
      sendError: vi.fn(),
    }, token),
  )
  return { conn, port, onMessage, onConnect }
}

/** 连接 + 发 auth + 等 auth.result，resolve 携带 { ws, authResult }。 */
function connectAndAuth(port: number, token: string): Promise<{ ws: WebSocket; authResult: { ok: boolean; reason?: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timeout = setTimeout(() => reject(new Error('auth flow timeout')), 4000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data))
      if (msg.type === 'auth.result') {
        clearTimeout(timeout)
        resolve({ ws, authResult: msg.payload })
      }
    })
    ws.on('error', reject)
  })
}

/** 等连接关闭，resolve 携带 close code。 */
function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
  })
}

describe('SEC-U2 WS transport hardening (loopback + maxPayload + auth handshake)', () => {
  let cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const fn of cleanup) await fn()
    cleanup = []
  })

  it('SEC-U2 listen 显式绑 127.0.0.1（不对局域网开放）', async () => {
    const { conn, port } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())
    // 绑定地址经 OS 视角断言（address() 返回实际绑定的地址族）
    const addr = (conn as unknown as { httpServer: { address(): { address: string; port: number } } }).httpServer.address()
    expect(addr.address).toBe('127.0.0.1')
    expect(addr.port).toBe(port)
  })

  it('SEC-U2 maxPayload 常量生效——超限消息连接被关闭', async () => {
    const { conn, port } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())
    const { ws, authResult } = await connectAndAuth(port, TEST_TOKEN)
    expect(authResult.ok).toBe(true)

    // 发送超限消息（MAX_WS_PAYLOAD_BYTES + 1 字节的 JSON payload）——ws 库收到超限帧
    // 以 close 1009 (Message Too Big) 关闭连接
    const closed = waitClose(ws)
    const oversized = 'x'.repeat(MAX_WS_PAYLOAD_BYTES + 1024)
    ws.send(JSON.stringify({ type: 'ping', payload: { pad: oversized } }))
    const { code } = await closed
    expect([1009, 1006, 1005]).toContain(code)
  })

  it('SEC-U2 无 auth 的客户端被拒——pre-auth 业务消息被丢弃，auth 超时断开', async () => {
    const { conn, port } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())
    const onMessage = (conn as unknown as { callbacks: { onMessage: (msg: ClientMessage) => void } }).callbacks.onMessage

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    // auth 前发业务消息：静默丢弃（不进 handleMessage、不断开——等 auth 超时再断）
    ws.send(JSON.stringify({ type: 'plugin.toggle', id: 'evil-1', payload: { pluginId: 'x', enabled: false } }))
    await new Promise<void>((r) => setTimeout(r, 300))
    expect(onMessage).not.toHaveBeenCalled()
    ws.close()
  })

  it('SEC-U2 错误 token 被拒（auth.result ok=false + close 1008）', async () => {
    const { conn, port } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const closed = waitClose(ws)
    const authReply = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data))
        if (msg.type === 'auth.result') resolve(msg.payload)
      })
    })
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'auth', payload: { token: 'forged-token-attempt' } }))

    const reply = await authReply
    expect(reply.ok).toBe(false)
    expect(reply.reason).toBe('bad_token')
    const { code } = await closed
    expect(code).toBe(1008)
  })

  it('SEC-U2 正确 token auth 后消息正常受理（onConnect + onMessage 触发）', async () => {
    const { conn, port, onMessage, onConnect } = await startManager(TEST_TOKEN)
    cleanup.push(() => conn.stop())

    const { ws, authResult } = await connectAndAuth(port, TEST_TOKEN)
    expect(authResult.ok).toBe(true)
    // auth 成功 → 连接入池 + initial state 通道打开
    expect(onConnect).toHaveBeenCalledTimes(1)
    expect(conn.clients.size).toBe(1)

    // auth 后业务消息正常路由
    const seen = new Promise<void>((resolve) => {
      const iv = setInterval(() => { if (onMessage.mock.calls.length > 0) { clearInterval(iv); resolve() } }, 20)
    })
    ws.send(JSON.stringify({ type: 'plugin.toggle', id: 'legit-1', payload: { pluginId: 'x', enabled: true } }))
    await seen
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plugin.toggle', id: 'legit-1' }),
      expect.anything(),
    )
    ws.close()
  })

  it('SEC-U2 fail-closed——token 未配置（null）时拒绝全部连接（close 1008）', async () => {
    const { conn, port } = await startManager(null)
    cleanup.push(() => conn.stop())

    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const closed = waitClose(ws)
    const authReply = new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data))
        if (msg.type === 'auth.result') resolve(msg.payload)
      })
    })
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'auth', payload: { token: 'anything' } }))

    const reply = await authReply
    expect(reply.ok).toBe(false)
    expect(reply.reason).toBe('no_token_configured')
    const { code } = await closed
    expect(code).toBe(1008)
  })

  it('SEC-U2 EADDRINUSE → reject（非 process.exit）+ 可操作文案', async () => {
    // 先用真实 http server 占住一个端口，再让 ConnectionManager 对同端口 listen。
    // 旧实现对 EADDRINUSE 直接 process.exit(1)——测试 worker 会被整个杀掉（本用例
    // 以 crash/超时的可观察方式失败）。新语义（对齐 callback-server.ts 先例）：reject
    // 保留 code=EADDRINUSE + 可操作排查文案，进程生死由调用方（组合根）决定。
    const occupied = createServer()
    const port = await new Promise<number>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', () => {
        const addr = occupied.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('occupied server address() returned non-object'))
      })
    })
    cleanup.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())))

    const conn = new ConnectionManager(port, {
      onConnect: vi.fn(),
      onMessage: vi.fn().mockResolvedValue(undefined),
      sendError: vi.fn(),
    }, TEST_TOKEN)
    cleanup.push(() => conn.stop())

    await expect(conn.start()).rejects.toMatchObject({
      code: 'EADDRINUSE',
      message: expect.stringMatching(/端口 \d+ 被占用.*lsof -i :\d+/s),
    })
  })
})
