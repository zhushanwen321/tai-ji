/**
 * npm-installer tarball 下载 stall 兜底单测（timeout-audit-hygiene-batch u-h3）。
 *
 * 设计依据：docs/design/timeout-audit-hygiene-batch.md §3.3（D3-1~D3-4）+ §4.3 V3。
 * 故障注入 = 本地 HTTPS 服务器真实 TCP 语义（非 mock 下载逻辑）：
 * - stall-after-header：发 header 后不发 body（V3-1 原挂死场景）
 * - stall-after-bytes：发部分 body 后停发（中途断流，gunzip 已挂载）
 * - trickle：限速分段发送完整 tarball（V3-2 慢速合法下载，验证不误杀）
 *
 * SSRF 校验（validateUrlHost）强制 tarball URL 必须 https + 非纯 IP host，故本地
 * 服务器走 TLS：自签证书 fixture + 测试进程 NODE_TLS_REJECT_UNAUTHORIZED=0。
 *
 * timer 惯例：stall 触发窗口用 fake timers 验证默认 60s（D3-2）；不误杀 / timeout
 * 旋钮连通用真实短定时器（经 options.timeout 传入小值，D3-2 单旋钮语义）。
 *
 * 运行：cd packages/runtime && npx vitest run test/npm-installer-tarball-stall.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import * as tar from 'tar'
import { installPackage, NpmInstallError } from '../src/infra/installers/npm-installer.js'

// ── 证书 fixture（自签 localhost，仅测试用）────────────────────────────
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'test-localhost-cert')
const TLS_OPTIONS = {
  key: readFileSync(join(FIXTURE_DIR, 'key.pem')),
  cert: readFileSync(join(FIXTURE_DIR, 'cert.pem')),
}

// ── tarball fixture：真实 gzip+tar 包（index.js 用随机内容防 gzip 压缩，
//    保证 trickle 分段时长足以超过测试 timeout 窗口）──────────────────────
function buildPackageTarball(): { gzip: Buffer; integrity: string } {
  const buildDir = mkdtempSync(join(tmpdir(), 'stall-test-build-'))
  try {
    const pkgDir = join(buildDir, 'package')
    mkdirSync(pkgDir)
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fake-pkg', version: '1.0.0' }))
    writeFileSync(
      join(pkgDir, 'index.js'),
      'module.exports = 1\n' + crypto.randomBytes(24_000).toString('hex'),
    )
    // tar v7 sync c() 无 file 选项时返回内部流对象而非 Buffer——落盘再读回
    const tarPath = join(buildDir, 'pkg.tar')
    tar.c({ cwd: buildDir, portable: true, sync: true, file: tarPath }, ['package'])
    const gzip = zlib.gzipSync(readFileSync(tarPath))
    const integrity = `sha512-${crypto.createHash('sha512').update(gzip).digest('base64')}`
    return { gzip, integrity }
  } finally {
    rmSync(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

const tarball = buildPackageTarball()

// ── 本地 registry/tarball 服务器 ──────────────────────────────────────
type TarballBehavior = 'complete' | 'trickle' | 'stall-after-header' | 'stall-after-bytes'

const TRICKLE_CHUNK = 2048
const TRICKLE_INTERVAL_MS = 40

let server: https.Server
let baseUrl: string
let behavior: TarballBehavior
let withIntegrity: boolean
let nodeModulesDir: string
let originalRegistry: string | undefined
let resolveTarballRequested!: () => void
let tarballRequested!: Promise<void>
let resolveTarballClosed!: () => void
let tarballClosed!: Promise<void>

async function startServer(): Promise<void> {
  tarballRequested = new Promise<void>((r) => { resolveTarballRequested = r })
  tarballClosed = new Promise<void>((r) => { resolveTarballClosed = r })
  server = https.createServer(TLS_OPTIONS, (req, res) => {
    if (req.url === '/fake-pkg') {
      const dist: { tarball: string; integrity?: string } = { tarball: `${baseUrl}/fake-pkg-1.0.0.tgz` }
      if (withIntegrity) dist.integrity = tarball.integrity
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': { version: '1.0.0', dist, dependencies: {} },
        },
      }))
      return
    }
    if (req.url === '/fake-pkg-1.0.0.tgz') {
      resolveTarballRequested()
      res.on('close', resolveTarballClosed)
      switch (behavior) {
        case 'complete':
          res.writeHead(200, { 'content-length': tarball.gzip.length })
          res.end(tarball.gzip)
          return
        case 'trickle': {
          // 限速分段发送：总时长（chunk 数 × 间隔）显著超过测试 timeout 窗口，
          // 安装若成功即证明 stall timer 被持续 data 刷新而非「传输太快未触发」
          res.writeHead(200, { 'content-length': tarball.gzip.length })
          let offset = 0
          const sendChunk = (): void => {
            if (res.destroyed) return
            if (offset >= tarball.gzip.length) {
              res.end()
              return
            }
            const end = Math.min(offset + TRICKLE_CHUNK, tarball.gzip.length)
            res.write(tarball.gzip.subarray(offset, end))
            offset = end
            setTimeout(sendChunk, TRICKLE_INTERVAL_MS)
          }
          sendChunk()
          return
        }
        case 'stall-after-header':
          // 发 header 后零 body，连接挂住不 end（原 F3 挂死场景）
          res.writeHead(200, { 'content-length': tarball.gzip.length })
          res.flushHeaders()
          return
        case 'stall-after-bytes':
          // 中途断流：发部分 body 后停发，连接挂住不 end
          res.writeHead(200, { 'content-length': tarball.gzip.length })
          res.write(tarball.gzip.subarray(0, Math.min(2048, tarball.gzip.length)))
          return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  // 不指定 host → 双栈监听，localhost 无论解析为 ::1 或 127.0.0.1 均可达
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`
}

function closeServer(): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function getConnections(): Promise<number> {
  return new Promise((resolve, reject) =>
    server.getConnections((err, count) => (err ? reject(err) : resolve(count))),
  )
}

/** fake timers 下推进真实 IO（setImmediate 未被 fake）：等 loopback header 到达客户端 */
async function flushIo(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r))
}

async function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  await Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not within ${ms}ms`)), ms)),
  ])
}

// ── P3-1 双断言①：无未处理 rejection / uncaught（error 事件泄漏检测）────
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

beforeAll(() => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  process.on('unhandledRejection', onUnhandled)
  process.on('uncaughtException', onUnhandled)
})

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled)
  process.off('uncaughtException', onUnhandled)
  // 留一拍给潜在的延迟 rejection 落账，再统一断言为零
  await new Promise<void>((r) => setImmediate(r))
  expect(unhandled).toEqual([])
})

beforeEach(async () => {
  behavior = 'complete'
  withIntegrity = true
  originalRegistry = process.env.NPM_CONFIG_REGISTRY
  nodeModulesDir = mkdtempSync(join(tmpdir(), 'stall-test-nm-'))
  await startServer()
  process.env.NPM_CONFIG_REGISTRY = baseUrl
})

afterEach(async () => {
  vi.useRealTimers()
  await closeServer()
  if (originalRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY
  else process.env.NPM_CONFIG_REGISTRY = originalRegistry
  rmSync(nodeModulesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('tarball stall 兜底 — 触发路径（默认 60s 窗口，fake timers）', () => {
  // stall 在 advanceTimersByTimeAsync 期间即 reject，先于断言挂 handler——立即挂
  // no-op catch 占位（派生 promise 为 fulfilled 态），避免 unhandledRejection 噪声；
  // 断言仍走原 promise
  const installForStall = (): { promise: Promise<void> } => {
    const promise = installPackage('fake-pkg', nodeModulesDir)
    promise.catch(() => {})
    return { promise }
  }
  it('header 后零 body（流式路径）：60s 触发 → destroy → 可重试 network 错误 + tmp 清理', async () => {
    behavior = 'stall-after-header'
    withIntegrity = false

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { promise } = installForStall()
    await tarballRequested // 请求到达服务器（header 已 writeHead + flushHeaders）
    await flushIo() // header 经 loopback 到达客户端 → stall timer 已启动
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()

    await expect(promise).rejects.toBeInstanceOf(NpmInstallError)
    await expect(promise).rejects.toMatchObject({ code: 'network' })
    await expect(promise).rejects.toThrow(/no data received for 60000ms \(stalled connection\)/)

    // 流被 destroy：server 侧连接已被客户端终止（无句柄泄漏）
    await withTimeout(tarballClosed, 1000)
    expect(await getConnections()).toBe(0)

    // 失败的 tmp 目录被清理、目标目录不出现半成品
    expect(existsSync(join(nodeModulesDir, 'fake-pkg.tmp'))).toBe(false)
    expect(existsSync(join(nodeModulesDir, 'fake-pkg'))).toBe(false)
  })

  it('header 后零 body（integrity 路径）：60s 触发 → network stalled（final 单侧挂载生效）', async () => {
    behavior = 'stall-after-header'
    withIntegrity = true

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { promise } = installForStall()
    await tarballRequested
    await flushIo()
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()

    await expect(promise).rejects.toBeInstanceOf(NpmInstallError)
    await expect(promise).rejects.toMatchObject({ code: 'network' })
    await expect(promise).rejects.toThrow(/stalled connection/)

    await withTimeout(tarballClosed, 1000)
    expect(await getConnections()).toBe(0)
    expect(existsSync(join(nodeModulesDir, 'fake-pkg.tmp'))).toBe(false)
  })

  it('中途断流（流式路径，gunzip 已挂载）：60s 触发 → promise 有限时间 settle → network stalled（P3-1 传播完整）', async () => {
    behavior = 'stall-after-bytes'
    withIntegrity = false

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { promise } = installForStall()
    await tarballRequested
    await flushIo() // 部分 body 也经 loopback 到达，gunzip 已被 pipe 挂载
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()

    // rejects 断言本身即 P3-1 双断言②：destroy 后 promise 不会悬挂，
    // gunzip 侧错误（若先 settle）也被统一收敛为 network stalled
    await expect(promise).rejects.toBeInstanceOf(NpmInstallError)
    await expect(promise).rejects.toMatchObject({ code: 'network' })
    await expect(promise).rejects.toThrow(/stalled connection/)

    await withTimeout(tarballClosed, 1000)
    expect(await getConnections()).toBe(0)
    expect(existsSync(join(nodeModulesDir, 'fake-pkg.tmp'))).toBe(false)
  })

  it('中途断流（integrity 路径）：60s 触发 → network stalled', async () => {
    behavior = 'stall-after-bytes'
    withIntegrity = true

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { promise } = installForStall()
    await tarballRequested
    await flushIo()
    await vi.advanceTimersByTimeAsync(60_000)
    vi.useRealTimers()

    await expect(promise).rejects.toBeInstanceOf(NpmInstallError)
    await expect(promise).rejects.toMatchObject({ code: 'network' })
    await expect(promise).rejects.toThrow(/stalled connection/)
    expect(existsSync(join(nodeModulesDir, 'fake-pkg.tmp'))).toBe(false)
  })
})

describe('tarball stall 兜底 — 不误杀与旋钮（真实短定时器，options.timeout 注入）', () => {
  it('慢速持续数据流（流式路径）不误杀：总时长超过窗口仍安装成功', async () => {
    behavior = 'trickle'
    withIntegrity = false

    // gzip 后 ~50KB / 2KB 每 40ms ≈ 1s 总时长 > 300ms 窗口——
    // 成功即证明 stall timer 被每个 data chunk 持续刷新（非总墙钟语义）
    await expect(installPackage('fake-pkg', nodeModulesDir, { timeout: 300 })).resolves.toBeUndefined()

    const pkgJson = JSON.parse(readFileSync(join(nodeModulesDir, 'fake-pkg', 'package.json'), 'utf-8'))
    expect(pkgJson.name).toBe('fake-pkg')
    expect(existsSync(join(nodeModulesDir, 'fake-pkg', 'index.js'))).toBe(true)
    expect(existsSync(join(nodeModulesDir, 'fake-pkg.tmp'))).toBe(false)
  }, 15_000)

  it('慢速持续数据流（integrity 路径）不误杀：安装成功且 integrity 校验通过', async () => {
    behavior = 'trickle'
    withIntegrity = true

    await expect(installPackage('fake-pkg', nodeModulesDir, { timeout: 300 })).resolves.toBeUndefined()

    expect(existsSync(join(nodeModulesDir, 'fake-pkg', 'package.json'))).toBe(true)
    expect(existsSync(join(nodeModulesDir, 'fake-pkg.tmp'))).toBe(false)
  }, 15_000)

  it('timeout 旋钮连通：传入小值即以该值触发 stall（不再等默认 60s）', async () => {
    behavior = 'stall-after-header'
    withIntegrity = true

    // 真实定时器 250ms 触发；若旋钮未接入 stall 窗口则需等 60s → 用例超时失败
    const promise = installPackage('fake-pkg', nodeModulesDir, { timeout: 250 })
    await expect(promise).rejects.toBeInstanceOf(NpmInstallError)
    await expect(promise).rejects.toMatchObject({ code: 'network' })
    await expect(promise).rejects.toThrow(/no data received for 250ms/)
  }, 15_000)
})

describe('既有安装成功路径回归（stall 兜底不破坏正常流）', () => {
  it('完整响应 + integrity 校验：安装成功', async () => {
    behavior = 'complete'
    withIntegrity = true

    await expect(installPackage('fake-pkg', nodeModulesDir)).resolves.toBeUndefined()

    const pkgJson = JSON.parse(readFileSync(join(nodeModulesDir, 'fake-pkg', 'package.json'), 'utf-8'))
    expect(pkgJson.name).toBe('fake-pkg')
    expect(pkgJson.version).toBe('1.0.0')
    expect(existsSync(join(nodeModulesDir, 'fake-pkg', 'index.js'))).toBe(true)
    expect(existsSync(join(nodeModulesDir, 'fake-pkg.tmp'))).toBe(false)
  })

  it('完整响应无 integrity（流式 pipe 路径）：安装成功', async () => {
    behavior = 'complete'
    withIntegrity = false

    await expect(installPackage('fake-pkg', nodeModulesDir)).resolves.toBeUndefined()

    const pkgJson = JSON.parse(readFileSync(join(nodeModulesDir, 'fake-pkg', 'package.json'), 'utf-8'))
    expect(pkgJson.name).toBe('fake-pkg')
    expect(existsSync(join(nodeModulesDir, 'fake-pkg', 'index.js'))).toBe(true)
    expect(existsSync(join(nodeModulesDir, 'fake-pkg.tmp'))).toBe(false)
  })
})
