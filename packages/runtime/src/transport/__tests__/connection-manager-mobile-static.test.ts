/**
 * remote-access U1.1：移动壳静态托管 handler（D3）+ 穿越防护（E4）+ dist 缺失处置（E5）。
 * S3 拆分后形态：静态实现与开态判定（resolveMobileStaticRoot / createMobileStaticHandler）
 * 在 mobile-static.ts，本文件锚定 ConnectionManager 消费面——注入 handler 后的 HTTP
 * 分派行为；开态判定/纯函数/裸 handler 单测在 mobile-static.test.ts。
 *
 * 语义锚点（remote-access 设计 §3.3 D3 / §3.4 E4/E5）：
 * 1. D3：handler 注入（组合根开态装配：remoteAccess 判据 → dist 探测通过）后同端口
 *    GET/HEAD 托管移动壳产物——目录请求回退 index.html、404 兜底、/health 先于静态
 *    分支行为不变；访问/拒绝日志只记剥除 query 的 pathname（remote token 不经静态面
 *    日志落盘）；handler 未注入（关态 / E5 禁用）HTTP 行为与远程访问引入前逐字节
 *    一致（/health 之外一律 404 空 body）。
 * 2. E4：路径白名单化防目录穿越——解码（含 %2e%2e 编码变体）后 resolve 消解再前缀
 *    判定，白名单外 400 且不发起任何 fs 读取。
 * 3. E5：开态但 mobileDist 未传 / 目录不存在 / 指向普通文件 → 静态面禁用 + 响亮
 *    error 日志（含 pnpm build 指引与打包配置提示），不拒启——WS auth 照常工作。
 *
 * 真实 socket 集成测试（127.0.0.1 随机端口，形态对齐 connection-manager-remote-access.test.ts）；
 * 请求用 node:http raw request 发任意 path（浏览器 fetch 会客户端 normalize 掉字面
 * `..`，测不到服务端穿越防护）。dist fixture 经 mkdtempSync 自建自删（fs-guard 白名单，
 * 禁触真实数据目录）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import { ConnectionManager, type ConnectionManagerOptions } from '../connection-manager.js'
import { createMobileStaticHandler, resolveMobileStaticPath, resolveMobileStaticRoot } from '../mobile-static.js'

const SPAWN_TOKEN = 'spawn-token'
const REMOTE_TOKEN_A = 'a'.repeat(64)
const INDEX_MARK = 'mobile-shell-index-marker'

interface Harness {
  port: number
  conn: ConnectionManager
}

interface RawResponse {
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
}

/** 原始 HTTP 请求：path 原样上送（不 normalize），可发字面 `..` 与 query。 */
function rawRequest(port: number, path: string, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function startManager(authToken: string | null, options: ConnectionManagerOptions = {}): Promise<Harness> {
  const conn = new ConnectionManager(0, {
    onConnect: () => {},
    onMessage: async () => {},
    sendError: () => {},
  }, authToken, options)
  await conn.start()
  const httpServer = (conn as unknown as { httpServer: { address: () => { port: number } } }).httpServer
  const addr = httpServer.address()
  if (!addr) throw new Error('httpServer has no address after start()')
  return { port: addr.port, conn }
}

/**
 * 组合根开态装配形态（S3 上移后）：remoteAccess=true 判据 → resolveMobileStaticRoot
 * 探测（E5 日志在此发出）→ 探测通过才构造 handler 注入；探测失败（null）不注入
 * （CM 关态分派 = 404）。与 index.ts Transport layer 装配段同构。
 */
function openStateOptions(mobileDist?: string): ConnectionManagerOptions {
  const root = resolveMobileStaticRoot({ remoteAccess: true, mobileDist })
  return {
    remoteTokenProvider: () => REMOTE_TOKEN_A,
    mobileStaticHandler: root !== null ? createMobileStaticHandler(root) : undefined,
  }
}

describe('ConnectionManager mobile static hosting (U1.1)', () => {
  let dataDir: string
  let distDir: string
  const opened: Harness[] = []
  const consoleSpies: ReturnType<typeof vi.spyOn>[] = []

  beforeEach(() => {
    dataDir = fs.mkdtempSync(join(tmpdir(), 'taiji-mobile-static-test-'))
    distDir = join(dataDir, 'mobile-dist')
    fs.mkdirSync(join(distDir, 'assets'), { recursive: true })
    fs.mkdirSync(join(distDir, 'sub'), { recursive: true })
    fs.writeFileSync(join(distDir, 'index.html'), `<!DOCTYPE html><html>${INDEX_MARK}</html>`, 'utf-8')
    fs.writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app")', 'utf-8')
    // 穿越目标：dist 外的「秘密」文件——穿越防护失败的信号是它被 200 读出。
    fs.writeFileSync(join(dataDir, 'secret.txt'), 'TOP_SECRET_OUTSIDE_DIST', 'utf-8')
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
  })

  afterEach(async () => {
    for (const harness of opened.reverse()) await harness.conn.stop()
    opened.length = 0
    for (const spy of consoleSpies.reverse()) spy.mockRestore()
    consoleSpies.length = 0
    vi.unstubAllEnvs()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function spyConsole(method: 'error' | 'warn' | 'log'): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, method).mockImplementation(() => {})
    consoleSpies.push(spy)
    return spy
  }

  /** 汇总已捕获的 console 输出为单个字符串（日志纪律断言用）。 */
  function allConsoleOutput(): string {
    return consoleSpies
      .map((spy) => spy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n'))
      .join('\n')
  }

  // ── D3：开态正常服务 ─────────────────────────────────────────────────────

  describe('开态静态服务（mobileDist 有效）', () => {
    it('GET / 回退 index.html（目录请求 → index.html 兜底）', async () => {
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions(distDir)))
      const res = await rawRequest(opened[0].port, '/')
      expect(res.status).toBe(200)
      expect(res.body.toString('utf-8')).toContain(INDEX_MARK)
      expect(res.headers['content-type']).toContain('text/html')
    })

    it('GET /assets/app.js 返回文件内容 + JS Content-Type（产物资产形态）', async () => {
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions(distDir)))
      const res = await rawRequest(opened[0].port, '/assets/app.js')
      expect(res.status).toBe(200)
      expect(res.body.toString('utf-8')).toBe('console.log("app")')
      expect(res.headers['content-type']).toContain('text/javascript')
    })

    // Content-Type 映射矩阵与 octet-stream 兜底归属裸 handler 面（mobile-static.test.ts
    // 的 it.each 与映射外扩展名用例），集成面不重复。

    it('子目录请求（/sub/）也回退顶层 index.html；不存在的资产路径 404 兜底', async () => {
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions(distDir)))
      const dirRes = await rawRequest(opened[0].port, '/sub/')
      expect(dirRes.status).toBe(200)
      expect(dirRes.body.toString('utf-8')).toContain(INDEX_MARK)
      const missingRes = await rawRequest(opened[0].port, '/assets/no-such-chunk.js')
      expect(missingRes.status).toBe(404)
      expect(missingRes.body).toHaveLength(0)
    })

    it('HEAD 返回与 GET 相同的头（Content-Type/Content-Length）但 body 为空', async () => {
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions(distDir)))
      const head = await rawRequest(opened[0].port, '/assets/app.js', 'HEAD')
      expect(head.status).toBe(200)
      expect(head.headers['content-type']).toContain('text/javascript')
      expect(Number(head.headers['content-length'])).toBe('console.log("app")'.length)
      expect(head.body).toHaveLength(0)
    })

    it('非 GET/HEAD（POST）→ 405 + Allow: GET, HEAD', async () => {
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions(distDir)))
      const res = await rawRequest(opened[0].port, '/', 'POST')
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET, HEAD')
    })

    it('/health 先于静态分支：开态下探针行为不变', async () => {
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions(distDir)))
      const res = await rawRequest(opened[0].port, '/health')
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body.toString('utf-8'))).toMatchObject({ status: 'ok' })
    })
  })

  // ── E4：穿越防护 ─────────────────────────────────────────────────────────

  describe('E4 路径穿越防护（字面与编码变体全部 400，白名单外零 fs 读取）', () => {
    it.each([
      ['字面 .. 段', '/../secret.txt'],
      ['编码 %2e%2e 段', '/%2e%2e/secret.txt'],
      ['编码 ..%2f 混合', '/..%2fsecret.txt'],
      ['全编码 %2e%2e%2f', '/%2e%2e%2fsecret.txt'],
      ['嵌套深穿越', '/assets/%2e%2e/%2e%2e/secret.txt'],
      ['字面多级 .. 段', '/a/b/../../../x'],
      ['畸形百分号序列', '/%zzsecret'],
      ['非法 UTF-8 百分号编码', '/%ffx'],
      ['NUL 字节', '/%00secret.txt'],
    ])('%s → 400 且不泄 dist 外内容', async (_label, path) => {
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions(distDir)))
      const warnSpy = spyConsole('warn')
      const res = await rawRequest(opened[0].port, path)
      expect(res.status).toBe(400)
      expect(res.body.toString('utf-8')).not.toContain('TOP_SECRET_OUTSIDE_DIST')
      // 拒绝日志只记 pathname（D3）——服务端路径与文件内容不落盘。
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain('TOP_SECRET')
      expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain(distDir)
    })
  })

  // ── D3：日志纪律（query 剥除）────────────────────────────────────────────

  describe('日志只记规范化路径（query 剥除，token 不落盘）', () => {
    it.each([
      ['目录回退路径', '/'],
      ['资产路径', '/assets/app.js'],
      ['穿越拒绝路径', '/../secret.txt'],
      ['404 路径', '/assets/no-such.js'],
    ])('%s 的访问/拒绝日志不含 query string', async (_label, path) => {
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions(distDir)))
      spyConsole('log')
      spyConsole('warn')
      spyConsole('error')
      await rawRequest(opened[0].port, `${path}?token=SECRETTOKEN123`)
      expect(allConsoleOutput()).not.toContain('SECRETTOKEN123')
      expect(allConsoleOutput()).not.toContain('token=')
    })
  })

  // ── D3：handler 未注入 = 不挂载（行为与远程访问引入前逐字节一致）───────────────
  // 开态守卫（mobileDist 单独出现不构成开态）已随挂载裁决上移组合根，归属
  // mobile-static.test.ts 的 resolveMobileStaticRoot 关态用例。

  describe('handler 未注入（关态 / E5 禁用）不挂载', () => {
    it('无 mobileStaticHandler：GET / → 404 空 body（现状形态），无 E5 error', async () => {
      const errorSpy = spyConsole('error')
      opened.push(await startManager(SPAWN_TOKEN))
      const res = await rawRequest(opened[0].port, '/')
      expect(res.status).toBe(404)
      expect(res.body).toHaveLength(0)
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('关态 /health 行为不变', async () => {
      opened.push(await startManager(SPAWN_TOKEN))
      const res = await rawRequest(opened[0].port, '/health')
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body.toString('utf-8'))).toMatchObject({ status: 'ok' })
    })
  })

  // ── E5：开态 dist 缺失 → 静态面禁用 + 响亮日志 + WS 不受影响 ────────────────
  // 变体判定差异（未传 / 目录不存在 / 指向普通文件）与文案归属纯函数面
  // resolveMobileStaticRoot（mobile-static.test.ts 的 E5 探测用例），集成面只锚降级行为。

  describe('E5：开态但 mobileDist 缺失（集成降级行为）', () => {
    it('未传 --mobile-dist → 响亮 error 日志（计数 1）；GET / 404；WS auth 正常', async () => {
      const errorSpy = spyConsole('error')
      // 开态形态但 mobileDist 缺失（组合根装配链：探测在 handler 构造前发出 E5 日志）
      opened.push(await startManager(SPAWN_TOKEN, openStateOptions()))
      expect(errorSpy).toHaveBeenCalledTimes(1)
      // 静态面禁用，不拒启：HTTP 静态路径 404、WS auth 照常。
      const res = await rawRequest(opened[0].port, '/')
      expect(res.status).toBe(404)
      const ws = new WebSocket(`ws://127.0.0.1:${opened[0].port}`)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
      })
      ws.send(JSON.stringify({ type: 'auth', payload: { token: REMOTE_TOKEN_A } }))
      const authOk = await new Promise<boolean>((resolve) => {
        ws.once('message', (data) => {
          const msg = JSON.parse(String(data)) as { type: string; payload?: { ok?: boolean } }
          resolve(msg.type === 'auth.result' && msg.payload?.ok === true)
        })
      })
      ws.terminate()
      expect(authOk).toBe(true)
    })
  })

  // ── resolveMobileStaticPath 纯函数白盒（正向解析锚定；负向矩阵归上方 E4 集成面）───

  describe('resolveMobileStaticPath（纯函数）', () => {
    it('dist 内路径 → 绝对路径；根路径 → distRoot 本身（目录判定入口）', () => {
      expect(resolveMobileStaticPath(distDir, '/index.html')).toBe(join(distDir, 'index.html'))
      expect(resolveMobileStaticPath(distDir, '/assets/app.js')).toBe(join(distDir, 'assets', 'app.js'))
      expect(resolveMobileStaticPath(distDir, '/')).toBe(distDir)
    })
  })
})
