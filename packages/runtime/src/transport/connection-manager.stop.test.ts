/**
 * ConnectionManager.stop() 回归测试（A4 挂死根修，2026-09-12）。
 *
 * 缺陷：旧 stop() 仅 `httpServer.close(cb)`——回调在全部存量连接结束后才触发，而 ws 8.21
 * external-server 模式的 `wss.close()` 不关闭存量连接；滚动重启场景（main/renderer 存活、
 * 仅 runtime 退出）renderer 的 WS 连接保持、无人发 close 帧 → 回调永不触发 → runtime 永不
 * 退出 → LivenessMonitor 判死强杀，计划内零退避路径失效（Gate B A4 FAIL 根因）。
 *
 * 根修语义（本套件逐条断言）：
 * 1. 有 authed WS 客户端连接时 stop() 必然 resolve（修复前挂死）
 * 2. authed 客户端收到优雅 close 帧 1001 Going Away
 * 3. 未 auth 连接（握手中）同样被关闭、不阻塞 stop
 * 4. /health 的 keep-alive 空闲连接被 closeIdleConnections 清除、不阻塞 stop
 *
 * 真实 socket 集成测试（127.0.0.1 随机端口）：close 握手/keep-alive 清理是真实网络事件，
 * 不适用 fake timers（会冻结 socket 事件传导）；时序上界用 race 超时断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, type WebSocket as WsType } from 'ws'
import { ConnectionManager } from './connection-manager.js'

const TOKEN = 'test-token'
/** stop() 必须在该上界内 resolve：正常路径毫秒级；修复前该用例挂死（无上界可满足）。 */
const STOP_DEADLINE_MS = 5_000

interface Harness {
  port: number
  conn: ConnectionManager
  httpServer: HttpServer
}

async function startHarness(): Promise<Harness> {
  // ConnectionManager 自建 httpServer + wss（同生产构造路径），port 0 = 随机空闲端口。
  const conn = new ConnectionManager(0, {
    onConnect: () => {},
    onMessage: async () => {},
    sendError: () => {},
  }, TOKEN)
  await conn.start()
  // httpServer 是 private（生产 API 不暴露），测试经类型透视取真实端口与连接计数断言面。
  const httpServer = (conn as unknown as { httpServer: HttpServer }).httpServer
  const addr = httpServer.address() as AddressInfo | null
  if (!addr) throw new Error('httpServer has no address after start()')
  return { port: addr.port, conn, httpServer }
}

/** 建立并完成 auth 握手的客户端连接（模拟 renderer）。 */
async function connectAndAuth(port: number): Promise<WsType> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  const authResult = new Promise<boolean>((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type: string; payload?: { ok?: boolean } }
        if (msg.type === 'auth.result') resolve(msg.payload?.ok === true)
        else reject(new Error(`expected auth.result, got ${msg.type}`))
      } catch (e) { reject(e) }
    })
  })
  ws.send(JSON.stringify({ type: 'auth', payload: { token: TOKEN } }))
  expect(await authResult).toBe(true)
  return ws
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} did not resolve within ${STOP_DEADLINE_MS}ms (hang regression)`)), STOP_DEADLINE_MS).unref()
    }),
  ])
}

describe('ConnectionManager.stop() — A4 rolling-restart hang regression', () => {
  let harness: Harness
  const openedClients: WsType[] = []

  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(() => {
    // 测试内建 stop 断言服务端已关；客户端 socket 兜底 terminate（已死则 no-op）。
    for (const ws of openedClients.reverse()) ws.terminate()
    openedClients.length = 0
  })

  it('resolves while an authed WS client is still connected (the hang scenario)', async () => {
    // 修复前：authed 连接保持 → httpServer.close 回调永不触发 → stop 永不 resolve。
    const ws = await connectAndAuth(harness.port)
    openedClients.push(ws)
    expect(harness.conn.clients.size).toBe(1)
    await withDeadline(harness.conn.stop(), 'stop() with authed client')
    // stop 后服务端连接池清空（客户端被服务端关闭触发 handleClose）。
    await vi.waitFor(() => { expect(harness.conn.clients.size).toBe(0) })
  })

  it('sends a graceful close frame (1001 Going Away) to authed clients', async () => {
    const ws = await connectAndAuth(harness.port)
    openedClients.push(ws)
    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code))
    })
    await withDeadline(harness.conn.stop(), 'stop() graceful close frame')
    expect(await withDeadline(closed, 'client close event')).toBe(1001)
  })

  it('resolves while a pre-auth connection is pending', async () => {
    // 连接建立但不发 auth（authTimers 持有）——握手中连接同样占用 httpServer 连接计数。
    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`)
    openedClients.push(ws)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })
    await withDeadline(harness.conn.stop(), 'stop() with pre-auth connection')
  })

  it('resolves while an idle keep-alive HTTP connection is open', async () => {
    // 模拟 main 侧 liveness 探针：/health 响应完成后连接保持（node:http 默认 agent 带 keep-alive 头）。
    const done = new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: harness.port, path: '/health' }, (res) => {
        res.resume()
        res.on('end', resolve)
      })
      req.on('error', reject)
      req.end()
    })
    await withDeadline(done, '/health request')
    await withDeadline(harness.conn.stop(), 'stop() with keep-alive connection')
  })
})
