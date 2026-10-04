/**
 * mobile-static 单测（S3 拆分产物）：静态托管 module 的三个独立可测面——
 * 1. resolveMobileStaticRoot：挂载判定 + E5 探测（关态守卫「mobileDist 单独出现不
 *    构成开态」自 ConnectionManager 迁入此处——开态判据是显式 remoteAccess 布尔，
 *    不再从 remoteTokenProvider 装配痕迹推断）；关态零探测副作用（无 statSync、无日志）。
 * 2. createMobileStaticHandler：裸 httpServer 挂 handler（无需 ConnectionManager
 *    harness / authToken / wss）锚定核心服务行为——404 / Content-Type 映射 / 穿越防护。
 * 3. 端到端分派行为（/health 先于静态、405、HEAD、日志纪律）由
 *    connection-manager-mobile-static.test.ts 的 ConnectionManager 集成测试覆盖，
 *    此处不重复。
 *
 * dist fixture 经 mkdtempSync 自建自删（fs-guard 白名单，禁触真实数据目录）；
 * 穿越请求用 node:http raw request 发字面 `..`（浏览器 fetch 会客户端 normalize）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMobileStaticHandler, resolveMobileStaticRoot } from '../mobile-static.js'

const INDEX_MARK = 'mobile-shell-index-marker'

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

/** 裸静态 server：只挂 createMobileStaticHandler，无 WS / authToken（module 独立可测形态）。 */
async function startStaticServer(distRoot: string): Promise<{ port: number; server: Server }> {
  const server = createServer(createMobileStaticHandler(distRoot))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  return { port: addr.port, server }
}

describe('mobile-static module (S3)', () => {
  let dataDir: string
  let distDir: string
  const openedServers: Server[] = []
  const consoleSpies: ReturnType<typeof vi.spyOn>[] = []

  beforeEach(() => {
    dataDir = fs.mkdtempSync(join(tmpdir(), 'taiji-mobile-static-module-test-'))
    distDir = join(dataDir, 'mobile-dist')
    fs.mkdirSync(join(distDir, 'assets'), { recursive: true })
    fs.writeFileSync(join(distDir, 'index.html'), `<!DOCTYPE html><html>${INDEX_MARK}</html>`, 'utf-8')
    fs.writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app")', 'utf-8')
    fs.writeFileSync(join(distDir, 'assets', 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]))
    fs.writeFileSync(join(distDir, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf-8')
    // 穿越目标：dist 外的「秘密」文件——穿越防护失败的信号是它被 200 读出。
    fs.writeFileSync(join(dataDir, 'secret.txt'), 'TOP_SECRET_OUTSIDE_DIST', 'utf-8')
  })

  afterEach(async () => {
    for (const server of openedServers.reverse()) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    openedServers.length = 0
    for (const spy of consoleSpies.reverse()) spy.mockRestore()
    consoleSpies.length = 0
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function spyConsole(method: 'error' | 'warn' | 'log'): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, method).mockImplementation(() => {})
    consoleSpies.push(spy)
    return spy
  }

  // ── 开态判定 + E5 探测（挂载裁决迁入组合根判据的 module 半边）────────────────

  describe('resolveMobileStaticRoot（开态判定 + E5 探测）', () => {
    it('关态守卫（自 ConnectionManager 迁入）：remoteAccess=false 时 mobileDist 单独出现不构成开态——null + 零日志 + 零探测 IO', () => {
      const statSpy = vi.spyOn(fs, 'statSync')
      const errorSpy = spyConsole('error')
      const warnSpy = spyConsole('warn')
      const result = resolveMobileStaticRoot({ remoteAccess: false, mobileDist: distDir })
      expect(result).toBeNull()
      // 关态零探测副作用：不 statSync（E5 探测不发生）、无任何日志。
      expect(statSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
      statSpy.mockRestore()
    })

    it('开态未传 mobileDist → null + error 含 --mobile-dist 与 pnpm build / 打包配置指引（E5）', () => {
      const errorSpy = spyConsole('error')
      const result = resolveMobileStaticRoot({ remoteAccess: true })
      expect(result).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logged = String(errorSpy.mock.calls[0]?.[0])
      expect(logged).toContain('--mobile-dist')
      expect(logged).toContain('pnpm --filter @taiji/mobile-renderer build')
      expect(logged).toContain('extraResources')
    })

    it('开态目录不存在 → null + error 含缺失路径与 build 指引（E5）', () => {
      const errorSpy = spyConsole('error')
      const missingDir = join(dataDir, 'no-such-dist')
      const result = resolveMobileStaticRoot({ remoteAccess: true, mobileDist: missingDir })
      expect(result).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(missingDir)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('pnpm --filter @taiji/mobile-renderer build')
    })

    it('开态指向普通文件（非目录）→ null + error（E5 同处置）', () => {
      const errorSpy = spyConsole('error')
      const filePath = join(dataDir, 'not-a-dir')
      fs.writeFileSync(filePath, 'x', 'utf-8')
      const result = resolveMobileStaticRoot({ remoteAccess: true, mobileDist: filePath })
      expect(result).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })

    it('开态有效目录 → resolve 后的绝对路径（白名单判定基准）', () => {
      const errorSpy = spyConsole('error')
      const result = resolveMobileStaticRoot({ remoteAccess: true, mobileDist: distDir })
      expect(result).toBe(join(distDir))
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  // ── 裸 handler 服务行为（无需 ConnectionManager harness）────────────────────

  describe('createMobileStaticHandler（裸 httpServer 挂载）', () => {
    it('不存在路径 → 404 空 body', async () => {
      const { port, server } = await startStaticServer(distDir)
      openedServers.push(server)
      const res = await rawRequest(port, '/assets/no-such-chunk.js')
      expect(res.status).toBe(404)
      expect(res.body).toHaveLength(0)
    })

    it.each([
      ['/assets/app.js', 'text/javascript'],
      ['/assets/font.woff2', 'font/woff2'],
      ['/index.html', 'text/html'],
    ])('Content-Type 映射：%s → %s', async (path, expectedType) => {
      const { port, server } = await startStaticServer(distDir)
      openedServers.push(server)
      const res = await rawRequest(port, path)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain(expectedType)
    })

    it('映射外扩展名（.svg）→ octet-stream 兜底', async () => {
      const { port, server } = await startStaticServer(distDir)
      openedServers.push(server)
      const res = await rawRequest(port, '/assets/icon.svg')
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('application/octet-stream')
    })

    it.each([
      ['字面 .. 段', '/../secret.txt'],
      ['编码 %2e%2e 段', '/%2e%2e/secret.txt'],
      ['全编码 %2e%2e%2f', '/%2e%2e%2fsecret.txt'],
    ])('穿越防护：%s → 400 且不泄 dist 外内容', async (_label, path) => {
      const { port, server } = await startStaticServer(distDir)
      openedServers.push(server)
      const res = await rawRequest(port, path)
      expect(res.status).toBe(400)
      expect(res.body.toString('utf-8')).not.toContain('TOP_SECRET_OUTSIDE_DIST')
    })
  })
})
