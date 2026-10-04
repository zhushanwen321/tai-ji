/**
 * remote-access U0.1：listen host 参数化（D1）+ auth token 集合校验（D2）+ E10 处置。
 *
 * 语义锚点（.tmp/tech-design/remote-use-mobile.md §3.3 D1/D2/D9、§3.4 E10）：
 * 1. D1：start(host) 参数化，默认 127.0.0.1 与参数化前现状逐字节一致；开态 0.0.0.0。
 * 2. D2：token 校验 = 集合成员比较 {spawn token} ∪ {remote token}；remote 通道每次
 *    auth 握手热读 remote-access.json（轮换文件即生效）；关态不装配 provider——零 IO、
 *    文件存在也不读（构造性保证，fs spy 复核）。逐成员 tokenEquals（timingSafeEqual）。
 * 3. D9：无新增 env 键——remote 通道唯一开关是构造选项 remoteTokenProvider（argv 判据
 *    的组合根装配在 index.ts，import 即 main() 不可直测，本文件锚定 ConnectionManager
 *    消费面 + readRemoteAccessToken 读侧函数）。
 * 4. E10：开态文件缺失/坏 JSON/字段不合法 → remote 集合空（fail-closed 仅 spawn token）
 *    + 响亮日志含恢复指引；enabled=false 是关态文件留存的设计内合法产出（非错误）。
 *
 * 真实 socket 集成测试（127.0.0.1 随机端口，形态对齐 ../connection-manager.stop.test.ts）；
 * 测试数据目录经 TAIJI_AGENT_DATA_DIR stub 指向 mkdtemp 自建目录（fs-guard 白名单内，
 * 禁触真实 ~/.taiji）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, type WebSocket as WsType } from 'ws'
import {
  ConnectionManager,
  parseRemoteAccessToken,
  readRemoteAccessToken,
  _resetRemoteReadGateForTest,
  type ConnectionManagerOptions,
} from '../connection-manager.js'
import { REMOTE_ACCESS_FILENAME } from '@taiji/shared'

const SPAWN_TOKEN = 'spawn-token'
const REMOTE_TOKEN_A = 'a'.repeat(64)
const REMOTE_TOKEN_B = 'b'.repeat(64)

interface Harness {
  port: number
  conn: ConnectionManager
  httpServer: HttpServer
}

async function startManager(authToken: string | null, options: ConnectionManagerOptions = {}, host?: string): Promise<Harness> {
  const conn = new ConnectionManager(0, {
    onConnect: () => {},
    onMessage: async () => {},
    sendError: () => {},
  }, authToken, options)
  await conn.start(host)
  const httpServer = (conn as unknown as { httpServer: HttpServer }).httpServer
  const addr = httpServer.address() as AddressInfo | null
  if (!addr) throw new Error('httpServer has no address after start()')
  return { port: addr.port, conn, httpServer }
}

/** 建立连接并完成一次 auth 尝试，返回握手结果与 close 码（不改变量状态，供负面/正面共用）。 */
async function tryAuth(port: number, token: string): Promise<{ ok: boolean; closeCode: number | null }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const opened = new Promise<void>((resolve, reject) => {
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
  const closed = new Promise<number | null>((resolve) => {
    ws.once('close', (code) => resolve(code ?? null))
  })
  await opened
  ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
  const ok = await authResult
  // 成功路径连接保持存活（无 close 帧）；close 码断言只对拒绝路径（rejectAuth 主动 close）有意义。
  if (ok) {
    ws.terminate()
    return { ok, closeCode: null }
  }
  const closeCode = await closed
  ws.terminate()
  return { ok, closeCode }
}

function writeRemoteAccessFile(dir: string, content: string): string {
  const filePath = join(dir, REMOTE_ACCESS_FILENAME)
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function remoteAccessJson(token: string, enabled = true): string {
  return JSON.stringify({ enabled, token, createdAt: '2026-09-19T00:00:00.000Z' })
}

describe('ConnectionManager remote-access (U0.1)', () => {
  let dataDir: string
  const opened: Harness[] = []
  const consoleSpies: ReturnType<typeof vi.spyOn>[] = []

  beforeEach(() => {
    dataDir = fs.mkdtempSync(join(tmpdir(), 'taiji-remote-access-test-'))
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
  })

  afterEach(async () => {
    for (const harness of opened.reverse()) await harness.conn.stop()
    opened.length = 0
    for (const spy of consoleSpies.reverse()) spy.mockRestore()
    consoleSpies.length = 0
    // 频控是 connection-manager 模块级状态：逐测重置防「首个响亮已被前测消耗」跨测泄漏。
    _resetRemoteReadGateForTest()
    vi.unstubAllEnvs()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function spyConsole(method: 'error' | 'warn' | 'debug' | 'log'): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, method).mockImplementation(() => {})
    consoleSpies.push(spy)
    return spy
  }

  // ── D1：listen host 参数化 ──────────────────────────────────────────────

  describe('listen host 参数化（D1）', () => {
    it('默认 start() 绑定 127.0.0.1（与参数化前现状逐字节一致）', async () => {
      const harness = await startManager(SPAWN_TOKEN)
      opened.push(harness)
      expect((harness.httpServer.address() as AddressInfo).address).toBe('127.0.0.1')
    })

    it("start('0.0.0.0') 绑定全网卡（远程访问开态）", async () => {
      const harness = await startManager(SPAWN_TOKEN, {}, '0.0.0.0')
      opened.push(harness)
      expect((harness.httpServer.address() as AddressInfo).address).toBe('0.0.0.0')
    })
  })

  // ── 关态：默认行为等价（G2/S1）────────────────────────────────────────────

  describe('关态（无 remoteTokenProvider）——默认行为等价', () => {
    it('auth 仅认 spawn token：正确值通过，错误值拒绝（close 1008）', async () => {
      const harness = await startManager(SPAWN_TOKEN)
      opened.push(harness)
      expect((await tryAuth(harness.port, SPAWN_TOKEN)).ok).toBe(true)
      const bad = await tryAuth(harness.port, 'wrong-token')
      expect(bad.ok).toBe(false)
      expect(bad.closeCode).toBe(1008)
    })

    it('remote-access.json 存在也不被读取：文件内 token 不被认证 + fs 零读取', async () => {
      // 文件里放一个合法 remote token——若被读取入集合，该 token 将通过 auth。
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_A))
      const harness = await startManager(SPAWN_TOKEN)
      opened.push(harness)
      const readSpy = vi.spyOn(fs, 'readFileSync')
      try {
        const fileToken = await tryAuth(harness.port, REMOTE_TOKEN_A)
        expect(fileToken.ok).toBe(false)
        expect((await tryAuth(harness.port, SPAWN_TOKEN)).ok).toBe(true)
        // fs spy 复核「关态零 IO」：readFileSync 无任何以 remote-access.json 结尾的调用。
        const remoteReads = readSpy.mock.calls.filter((call) => String(call[0]).endsWith(REMOTE_ACCESS_FILENAME))
        expect(remoteReads).toHaveLength(0)
      } finally {
        readSpy.mockRestore()
      }
    })
  })

  // ── 开态：集合校验 + 握手热读（D2）────────────────────────────────────────

  describe('开态（remoteTokenProvider 装配）——集合校验 + 文件热读', () => {
    it('有效 remote token 握手通过（集合 = spawn ∪ remote）', async () => {
      const harness = await startManager(SPAWN_TOKEN, { remoteTokenProvider: () => REMOTE_TOKEN_A })
      opened.push(harness)
      expect((await tryAuth(harness.port, REMOTE_TOKEN_A)).ok).toBe(true)
      expect((await tryAuth(harness.port, SPAWN_TOKEN)).ok).toBe(true)
    })

    it('文件热读：轮换 remote-access.json 后新握手认新值、旧值被拒', async () => {
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_A))
      const harness = await startManager(SPAWN_TOKEN, { remoteTokenProvider: readRemoteAccessToken })
      opened.push(harness)
      // 轮换前：旧 token A 通过。
      expect((await tryAuth(harness.port, REMOTE_TOKEN_A)).ok).toBe(true)
      // 轮换 = 重写文件（main 侧原子写语义，此处直接覆盖验证读侧热读）。
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_B))
      // 轮换后：新 token B 通过（每次握手热读，无重启）、旧 token A 被拒。
      expect((await tryAuth(harness.port, REMOTE_TOKEN_B)).ok).toBe(true)
      expect((await tryAuth(harness.port, REMOTE_TOKEN_A)).ok).toBe(false)
    })

    it('构造选项透传：mobileStaticHandler / remoteTokenProvider 到达 ConnectionManager', () => {
      const provider = (): string | null => REMOTE_TOKEN_A
      const staticHandler = async (): Promise<void> => {}
      const conn = new ConnectionManager(0, {
        onConnect: () => {},
        onMessage: async () => {},
        sendError: () => {},
      }, SPAWN_TOKEN, { mobileStaticHandler: staticHandler, remoteTokenProvider: provider })
      const opts = (conn as unknown as { options: ConnectionManagerOptions }).options
      expect(opts.mobileStaticHandler).toBe(staticHandler)
      expect(opts.remoteTokenProvider).toBe(provider)
    })
  })

  // ── E10：开态文件缺失/损坏 → fail-closed 空集合 + 响亮日志 ──────────────────

  describe('E10：开态文件缺失/损坏处置', () => {
    it('文件缺失 → readRemoteAccessToken 返回 null + error 日志含恢复指引；spawn token 仍通过', async () => {
      const errorSpy = spyConsole('error')
      const harness = await startManager(SPAWN_TOKEN, { remoteTokenProvider: readRemoteAccessToken })
      opened.push(harness)
      expect(readRemoteAccessToken()).toBeNull()
      // S3 拆分后 CM 构造零探测副作用（dist 探测归组合根 resolveMobileStaticRoot），
      // provider 装配不再触发 E5 静态日志——本测试只锚定 remote 文件读侧：按内容
      // 过滤后恰一条（过滤防御未来无关 error 干扰断言语义）。
      const remoteFileErrors = errorSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes(REMOTE_ACCESS_FILENAME))
      expect(remoteFileErrors).toHaveLength(1)
      expect(String(remoteFileErrors[0]?.[0])).toContain('恢复')
      // fail-closed 语义：remote 通道空，spawn 通道不受影响。
      expect((await tryAuth(harness.port, REMOTE_TOKEN_A)).ok).toBe(false)
      expect((await tryAuth(harness.port, SPAWN_TOKEN)).ok).toBe(true)
    })

    it('坏 JSON → null + error 日志', () => {
      const errorSpy = spyConsole('error')
      writeRemoteAccessFile(dataDir, '{broken json')
      expect(readRemoteAccessToken()).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('JSON')
    })

    it('token 字段不符合 64hex 契约 → null + error 日志', () => {
      const errorSpy = spyConsole('error')
      writeRemoteAccessFile(dataDir, remoteAccessJson('not-a-hex-token'))
      expect(readRemoteAccessToken()).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('64 位 hex')
    })

    it('enabled=false（关态文件留存，设计内合法产出）→ null，不触发 error；console.log 可观测（code-harden P2）', () => {
      const errorSpy = spyConsole('error')
      const logSpy = spyConsole('log')
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_A, false))
      expect(readRemoteAccessToken()).toBeNull()
      expect(errorSpy).not.toHaveBeenCalled()
      // 非 debug 级：关态不入集合是安全相关事实，prod 日志可见（消息内自注明 debug 性质）。
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(String(logSpy.mock.calls[0]?.[0])).toContain('enabled=false')
    })
  })

  // ── 热读失败频控（code-harden P2：重连风暴降噪）────────────────────────────
  // 语义：每进程同因首次失败响亮 error，此后同因降 debug；读取成功重置回「首次响亮」。
  // 频控状态是模块级单例，测试间隔离靠 afterEach 的 _resetRemoteReadGateForTest()。

  describe('热读失败频控', () => {
    it('同因连续失败：首次响亮 error，此后降 debug 不再刷 error', () => {
      const errorSpy = spyConsole('error')
      const debugSpy = spyConsole('debug')
      // 文件缺失（read-ENOENT）连续 3 次热读（对应客户端重连风暴的逐握手调用）。
      expect(readRemoteAccessToken()).toBeNull()
      expect(readRemoteAccessToken()).toBeNull()
      expect(readRemoteAccessToken()).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(debugSpy).toHaveBeenCalledTimes(2)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('恢复')
    })

    it('因变化重新响亮：文件缺失(ENOENT) → 坏 JSON，各自首次 error', () => {
      const errorSpy = spyConsole('error')
      const debugSpy = spyConsole('debug')
      expect(readRemoteAccessToken()).toBeNull() // read-ENOENT 响亮
      writeRemoteAccessFile(dataDir, '{broken json')
      expect(readRemoteAccessToken()).toBeNull() // bad-json 因变化 → 响亮
      expect(readRemoteAccessToken()).toBeNull() // bad-json 重复 → 降 debug
      expect(errorSpy).toHaveBeenCalledTimes(2)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('读取')
      expect(String(errorSpy.mock.calls[1]?.[0])).toContain('JSON')
      expect(debugSpy).toHaveBeenCalledTimes(1)
    })

    it('读取成功重置：失败(响亮) → 同因降级 → 成功 → 复发重新响亮', () => {
      const errorSpy = spyConsole('error')
      const filePath = join(dataDir, REMOTE_ACCESS_FILENAME)
      expect(readRemoteAccessToken()).toBeNull() // 首次失败响亮
      expect(readRemoteAccessToken()).toBeNull() // 同因降 debug
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_A))
      expect(readRemoteAccessToken()).toBe(REMOTE_TOKEN_A) // 成功 → 频控重置
      fs.rmSync(filePath)
      expect(readRemoteAccessToken()).toBeNull() // 复发 → 重新响亮（防长期降级掩盖复发）
      expect(errorSpy).toHaveBeenCalledTimes(2)
    })
  })

  // ── D2 配套规格②：集合逐成员 timingSafeEqual，近似 token 一律拒绝 ───────────
  describe('集合成员比较（近似 token 拒绝）', () => {
    it.each([
      ['remote token 等长不同值', `${'a'.repeat(63)}b`],
      ['remote token 前缀（长度不等）', 'a'.repeat(32)],
      ['spawn token 后缀扩展', `${SPAWN_TOKEN}x`],
    ])('%s → 拒绝', async (_label, nearToken) => {
      const harness = await startManager(SPAWN_TOKEN, { remoteTokenProvider: () => REMOTE_TOKEN_A })
      opened.push(harness)
      const result = await tryAuth(harness.port, nearToken)
      expect(result.ok).toBe(false)
      expect(result.closeCode).toBe(1008)
    })
  })

  // ── parseRemoteAccessToken 纯解析三态（E10 读侧语义直接锚定）────────────────

  describe('parseRemoteAccessToken（纯函数）', () => {
    it('合法开态配置 → 返回 token', () => {
      expect(parseRemoteAccessToken(remoteAccessJson(REMOTE_TOKEN_A))).toBe(REMOTE_TOKEN_A)
    })
    it('非对象 JSON（如数组/标量）→ null + error 日志', () => {
      const errorSpy = spyConsole('error')
      expect(parseRemoteAccessToken('["not","an","object"]')).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })
    it('缺 token 字段 → null + error 日志', () => {
      const errorSpy = spyConsole('error')
      expect(parseRemoteAccessToken(JSON.stringify({ enabled: true }))).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })
  })
})
