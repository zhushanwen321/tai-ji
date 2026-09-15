/**
 * W3 TDD 测试：download-asset（asset 下载 + sha256 校验）。
 *
 * 覆盖场景 W3TC1-3：
 *   W3TC1 happy path：fetch 返回内容 → 下载完成 → sha256 匹配 → 返回 filePath
 *   W3TC2 sha256 不匹配 → 抛 UpdateIntegrityError + 删半下载文件
 *   W3TC3 sha256 undefined → 降级 size 校验；size 也匹配 → 通过
 *
 * Mock 策略：用真实 fs（temp 目录）+ mock globalThis.fetch 返回固定内容 Response。
 * 升级工作目录（getUpdateDir()）经 TAIJI_AGENT_DATA_DIR 环境变量重定向到 tmp
 * （路径延迟求值，env 先设确保所有求值命中 tmp）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/download-asset.test.ts
 */
import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UpdateError } from '../update/types.js'
import { resetEnginePreferenceForTest, markEnginePreferenceFromUndiciFailure } from '../update/upgrade-fetch.js'
import { downloadViaCurl } from '../update/curl-download.js'

// curl-download 部分 mock：downloadViaCurl 可控（curl 接管场景写 temp），其余透传。
// constants 路径已延迟求值（getDataDir 运行时读 env），静态 import 无路径副作用。
const downloadViaCurlMock = vi.mocked(downloadViaCurl)

/** 构造 undici fetch 抛错形态（外层 'fetch failed'，errno 挂 cause），供真实置位链路使用。 */
function fetchFailedWith(code: string, msg = 'connect failed'): TypeError {
  const cause = Object.assign(new Error(msg), { code })
  return new TypeError('fetch failed', { cause })
}

// ── 批次 5（u5a）原子写序列断言基建 ──────────────────────────────
// 包装 writeFileSync/renameSync 透传真实现并记录调用参数，供「resume-state
// tmp 写入后 rename」序列断言（§3.7.2）。其余 fs 函数原样透传。
// 注意：原函数必须在 vi.mock 工厂闭包内捕获——若经测试文件顶层 import 别名
// 调用，该别名本身已指向 mock（vi.fn），会无限递归（Maximum call stack size exceeded）。
const fsSpy = vi.hoisted(() => ({
  writeCalls: [] as Array<{ path: string; data: string }>,
  renameCalls: [] as Array<{ from: string; to: string }>,
  /** >0 时 createWriteStream 的 open 延迟 N ms（模拟 CI threadpool 拥塞），默认 0 完全透传。
   *  延迟走真实时钟（realSetTimeout）——否则 fake timers 用例里推进假时钟就把延迟吃掉了，
   *  旋钮形同虚设。 */
  writeStreamOpenDelayMs: 0,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realWriteFileSync = actual.writeFileSync
  const realRenameSync = actual.renameSync
  const realCreateWriteStream = actual.createWriteStream
  // createWriteStream 的 open 是异步 threadpool 操作，CI 高负载下其完成可能晚于
  // 下载失败链路的 unlinkSync。经文档化 options.fs 钩子延迟 open，确定性复现该时序
  // （open/write/writev/close 全部取真实现，仅 open 时机被推迟，语义不变）。
  const realStreamFs = { open: actual.open, write: actual.write, writev: actual.writev, close: actual.close }
  return {
    ...actual,
    writeFileSync: vi.fn((...a: Parameters<typeof actual.writeFileSync>) => {
      fsSpy.writeCalls.push({ path: String(a[0]), data: String(a[1]) })
      return realWriteFileSync(...a)
    }),
    renameSync: vi.fn((...a: Parameters<typeof actual.renameSync>) => {
      fsSpy.renameCalls.push({ from: String(a[0]), to: String(a[1]) })
      return realRenameSync(...a)
    }),
    createWriteStream: (...a: Parameters<typeof actual.createWriteStream>) => {
      const delay = fsSpy.writeStreamOpenDelayMs
      if (delay <= 0) return realCreateWriteStream(...a)
      const [file, options] = a
      // options 联合含 BufferEncoding（string）/ null：仅对象形态可 spread（TS2698），
      // 生产调用（download-asset）恒传对象形态 { flags }，其余形态落空对象。
      const streamOptions = typeof options === 'object' && options !== null ? options : {}
      const delayedOpen = (...openArgs: unknown[]) => {
        realSetTimeout(() => (realStreamFs.open as (...oa: unknown[]) => void)(...openArgs), delay)
      }
      return realCreateWriteStream(file, {
        ...streamOptions,
        fs: {
          open: delayedOpen,
          write: realStreamFs.write,
          writev: realStreamFs.writev,
          close: realStreamFs.close,
        },
      })
    },
  }
})

// curl-download 部分 mock：downloadViaCurl 可控（curl 接管场景编排写 temp / 断言），
// 其余透传真实现。仅「返回值观测面」describe 的 curl 接管用例编排它，其余用例
// 不触 curl 路径（若编排回归意外触发，vi.fn 默认 resolve undefined 快速暴露）。
vi.mock('../update/curl-download.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update/curl-download.js')>()
  return { ...actual, downloadViaCurl: vi.fn() }
})

// ── env 先于一切路径求值把升级工作目录重定向到 tmp ──────────────────
// constants.ts 现经 getUpdateDir() 延迟求值（getDataDir 读 TAIJI_AGENT_DATA_DIR），
// env 前置不再是硬约束。赋值仍放最前（无害），下方模块经动态 import 在 env 就绪后加载。
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'w3-download-'))
process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

// 动态 import：确保上面 env 赋值先生效
async function loadModule() {
  return await import('../update/download-asset.js')
}

/**
 * 真实定时器引用：vi.useFakeTimers() 替换的是 globalThis 上的定时器，本引用指向原实现。
 * 用于在假时钟下等**真实** I/O 完成——假时钟推进在真实时间上是瞬时的，而
 * createWriteStream 的文件创建是 threadpool 异步 open，CI 拥塞时可晚于 abort 触发；
 * 不等就会让「temp 保留」类断言假红（2026-09-10 Test(main) CI，D1 idle 用例）。
 */
const realSetTimeout: typeof setTimeout = globalThis.setTimeout

/**
 * 轮询等真实文件出现（走真实时钟，不受 fake timers 影响）。
 * 不用 Date.now() 算 deadline——它同样被 fake timers 接管。
 */
async function waitForRealPath(filePath: string, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts && !existsSync(filePath); i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 5))
  }
}

/** 测试用固定内容 + 预计算 sha256 */
const TEST_CONTENT = Buffer.from('hello world test content for download asset')
const TEST_SHA256 = '85574708fecd188f14f0138f8634d43b889af08a2eaa8abf685870dc08c859e2'

/** 构造一个返回固定内容的 Response（带 content-length 头） */
function makeContentResponse(content: Buffer, status = 200): Response {
  // 转为 Uint8Array：lib.dom 的 BodyInit 接受 Uint8Array 但不接受 Node Buffer
  const body = new Uint8Array(content)
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.length),
    },
  })
}

/** 多段下载测试：12MB 内容（大于 MIN_MULTI_PART_SIZE = 10MB） */
const MULTI_PART_SIZE = 12 * 1024 * 1024
const MULTI_PART_CONTENT = Buffer.alloc(MULTI_PART_SIZE, 0)
// 填充可识别的模式，便于后续断言内容
for (let i = 0; i < MULTI_PART_SIZE; i++) {
  MULTI_PART_CONTENT[i] = i % 256
}

/**
 * 构造多段探测响应（GET `Range: bytes=0-0` 的 206 形态）。
 * [多源改造] probe 已从 HEAD + accept-ranges 迁移为 GET Range 0-0 + Content-Range 判定：
 * 206 响应体仅 1 字节（content-length 恒 1，P7 实测陷阱），total 只能从 Content-Range 取。
 */
function makeProbeResponse(total: number): Response {
  return new Response(new Uint8Array([0]), {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1',
      'Content-Range': `bytes 0-0/${total}`,
      'Accept-Ranges': 'bytes',
    },
  })
}

/** 构造 Range 响应（content-length + content-range） */
function makeRangeResponse(content: Buffer, start: number, end: number): Response {
  const slice = content.subarray(start, end + 1)
  const body = new Uint8Array(slice)
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${end}/${content.length}`,
      'Accept-Ranges': 'bytes',
    },
  })
}

/** 计算 buffer 的 sha256 hex */
function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('W3: download-asset (W3TC1-3)', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    // 清理 tmp 目录内容（保留目录本身供下次用）
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── W3TC1：happy path（sha256 匹配）────────────────────────────
  it('W3TC1: fetch 内容 → sha256 匹配 → 返回 filePath，文件已 rename 到最终名', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'test-asset.zip',
      downloadUrl: 'https://example.com/test.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    })

    // 返回路径是最终文件名（无 .downloading 后缀）
    expect(result.filePath).toMatch(/test-asset\.zip$/)
    // 文件存在且内容正确
    expect(existsSync(result.filePath)).toBe(true)
    expect(readFileSync(result.filePath)).toEqual(TEST_CONTENT)
    // .downloading 临时文件已清理
    expect(existsSync(`${result.filePath}.downloading`)).toBe(false)
    // 返回值观测面（download-success 数据源，设计 §8.2 S1）：小文件纯单段成功形态
    expect(result.multiPart).toBe(false)
    expect(result.engine).toBe('undici')
  })

  // ── W3TC2：sha256 不匹配 → 抛 UpdateIntegrityError ──────────────
  it('W3TC2: sha256 不匹配 → 抛 UpdateIntegrityError + 清理半下载文件', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    await expect(downloadAsset({
      name: 'bad-asset.zip',
      downloadUrl: 'https://example.com/bad.zip',
      size: TEST_CONTENT.length,
      sha256: '0'.repeat(64), // 故意错误的 sha256
    })).rejects.toThrow(/sha256 mismatch/)

    // 最终文件不应存在（校验失败被清理）
    const finalPath = path.join(TMP_DATA_DIR, 'update', 'bad-asset.zip')
    expect(existsSync(finalPath)).toBe(false)
    // .downloading 也应被清理
    expect(existsSync(`${finalPath}.downloading`)).toBe(false)
  })

  // ── W3TC3：sha256 undefined → 降级 size 校验通过 ────────────────
  it('W3TC3: sha256 undefined → 降级 size 校验，size 匹配 → 通过', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'no-sha.zip',
      downloadUrl: 'https://example.com/no-sha.zip',
      size: TEST_CONTENT.length,
      // sha256 缺失
    })

    expect(existsSync(result.filePath)).toBe(true)
    expect(readFileSync(result.filePath)).toEqual(TEST_CONTENT)
  })

  // ── W3TC3b：sha256 缺失 + size 不匹配 → 抛 UpdateIntegrityError ─
  it('W3TC3b: sha256 undefined + size 不匹配 → 抛 UpdateIntegrityError', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    await expect(downloadAsset({
      name: 'bad-size.zip',
      downloadUrl: 'https://example.com/bad-size.zip',
      size: 9999, // 故意错误
    })).rejects.toThrow(/size mismatch/)
  })

  // ── W3TC3c：sha256 缺失 + size=0 → 抛 UpdateIntegrityError（BLOCKER 4 回归）
  //    旧实现 `else if (asset.size && asset.size > 0)` 在 size=0 时跳过校验，
  //    攻击者可让下载文件被任意篡改而无校验拦截。修复后二者全缺则拒绝。
  it('W3TC3c: sha256 undefined + size=0 → 抛 UpdateIntegrityError（拒绝无校验）', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch

    await expect(downloadAsset({
      name: 'no-check.zip',
      downloadUrl: 'https://example.com/no-check.zip',
      size: 0, // size=0（被旧实现当作「无 size」跳过）
      // sha256 缺失
    })).rejects.toThrow(/no integrity check available/)

    // 最终文件不应存在（校验失败被清理）
    const finalPath = path.join(TMP_DATA_DIR, 'update', 'no-check.zip')
    expect(existsSync(finalPath)).toBe(false)
  })

  // ── W3TC4：多段并行下载（大文件 + probe 206 放行）──────────────────
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('W3TC4: 大文件且探测 206 放行 → 多段并发下载 → 文件完整 + sha256 通过', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    globalThis.fetch = vi.fn(async (url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      // probe 探测请求（GET Range: bytes=0-0）→ 206 + Content-Range total 达标，放行多段
      if (rangeHeader === 'bytes=0-0') {
        return makeProbeResponse(MULTI_PART_CONTENT.length)
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      const end = Number(match[2])
      return makeRangeResponse(MULTI_PART_CONTENT, start, end)
    }) as unknown as typeof globalThis.fetch

    const onProgress = vi.fn()
    const result = await downloadAsset({
      name: 'multipart-asset.zip',
      downloadUrl: 'https://example.com/multipart.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    }, onProgress)

    expect(result.filePath).toMatch(/multipart-asset\.zip$/)
    expect(existsSync(result.filePath)).toBe(true)
    const downloaded = readFileSync(result.filePath)
    expect(downloaded.length).toBe(MULTI_PART_CONTENT.length)
    expect(downloaded.compare(MULTI_PART_CONTENT)).toBe(0)
    // .downloading 与 .part-* 都应清理
    expect(existsSync(`${result.filePath}.downloading`)).toBe(false)
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    expect(existsSync(path.join(updateDir, 'multipart-asset.zip.downloading.part-0'))).toBe(false)
    expect(onProgress).toHaveBeenCalled()
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1]?.[0]
    expect(lastCall).toBe(100)
  })

  // ── W3TC4b：单段大文件下载速度基准（用于对比多段）────────────────
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('W3TC4b: 大文件但探测回 200 全量（不支持 Range）→ 单段下载 → 文件完整', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    globalThis.fetch = vi.fn(async () => makeContentResponse(MULTI_PART_CONTENT)) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'singlepart-asset.zip',
      downloadUrl: 'https://example.com/singlepart.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expect(result.filePath).toMatch(/singlepart-asset\.zip$/)
    const downloaded = readFileSync(result.filePath)
    expect(downloaded.length).toBe(MULTI_PART_CONTENT.length)
    expect(downloaded.compare(MULTI_PART_CONTENT)).toBe(0)
  })

  // ── 进度回调 ────────────────────────────────────────────────────
  it('W3TC1b: onProgress 回调被调用（百分比 0-100）', async () => {
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT)) as unknown as typeof globalThis.fetch
    const onProgress = vi.fn()

    await downloadAsset({
      name: 'progress.zip',
      downloadUrl: 'https://example.com/progress.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    }, onProgress)

    expect(onProgress).toHaveBeenCalled()
    // 最后一次进度应为 100（content-length 等于实际长度）
    const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1]?.[0]
    expect(lastCall).toBeLessThanOrEqual(100)
    expect(lastCall).toBeGreaterThanOrEqual(0)
  })
})

/**
 * 多段并行下载错误路径测试（S#10 / test-coverage）。
 *
 * W3TC4 只测 happy path。这里覆盖错误清理路径：某段 Range 请求返回 500 时，
 * downloadPart 抛 UpdateError → downloadAsset rejects → 所有 .part-* 临时文件 +
 * .downloading 合并产物 + resume-state 全部被清理，无磁盘泄漏。
 */
describe('W3 multipart error path (S#10)', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── W3TC5：某段 Range 返回 500 → downloadAsset rejects + 全部临时文件清理 ──
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('W3TC5: 某段 Range 请求返回 500 → downloadAsset rejects UpdateError，.part-* 与 .downloading 全部清理', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    // 让 part-0 的 Range 请求返回 500，其余段正常；probe 探测 206 放行多段。
    globalThis.fetch = vi.fn(async (url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      // probe 探测请求（GET Range: bytes=0-0）→ 206 + Content-Range 放行多段
      if (rangeHeader === 'bytes=0-0') {
        return makeProbeResponse(MULTI_PART_CONTENT.length)
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      // 第一段（start=0）返回 500 触发 downloadPart 抛错
      if (start === 0) {
        return new Response('Internal Server Error', { status: 500 })
      }
      const end = Number(match[2])
      return makeRangeResponse(MULTI_PART_CONTENT, start, end)
    }) as unknown as typeof globalThis.fetch

    const updateDir = path.join(TMP_DATA_DIR, 'update')
    const assetName = 'multipart-err.zip'
    const downloadingPath = path.join(updateDir, `${assetName}.downloading`)

    await expect(downloadAsset({
      name: assetName,
      downloadUrl: 'https://example.com/multipart-err.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })).rejects.toThrow(/HTTP 500/)

    // 最终文件不存在
    expect(existsSync(path.join(updateDir, assetName))).toBe(false)
    // .downloading 合并产物未残留
    expect(existsSync(downloadingPath)).toBe(false)
    // 所有 .part-* 临时文件均被清理（downloadPart 自清 + downloadMultiPart catch 兜底）
    if (existsSync(updateDir)) {
      const leftovers = readdirSync(updateDir).filter((f) => /\.part-\d+$/.test(f))
      expect(leftovers).toEqual([])
    }
  })
})

/**
 * RM3 多段 Range 违约降级测试（update-reliability 批次 4）。
 *
 * 旧实现 downloadPart 只查 response.ok，服务器/代理忽略 Range 回 200 全量时
 * 四段各下全量 → 合并 4 倍损坏文件 → sha 失败重下死循环。修复后任一段检测到
 * 非 206 或段长不符 → 整批放弃多段，降级单段完整下载，产物必须完整正确。
 */
describe('RM3: multipart Range violation → fallback to single-stream', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  /** body 截短用例的截断长度（远小于段长 3MB，足以触发段长不符） */
  const TRUNCATED_PART_BYTES = 1024

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 断言降级后无 .part-* / .downloading 残留（泄漏检查） */
  function expectNoLeftovers(assetName: string): void {
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) {
      const leftovers = readdirSync(updateDir).filter(
        (f) => f.startsWith(assetName) && (/\.part-\d+$/.test(f) || f.endsWith('.downloading')),
      )
      expect(leftovers).toEqual([])
    }
  }

  /** 断言降级产物是完整正确的文件（若未降级会是 4 倍体积拼接损坏文件且 sha 抛错） */
  function expectIntactFile(filePath: string): void {
    const downloaded = readFileSync(filePath)
    expect(downloaded.length).toBe(MULTI_PART_CONTENT.length)
    expect(downloaded.compare(MULTI_PART_CONTENT)).toBe(0)
  }

  // RM3-1: probe 探测 206 放行后，段 GET 带 Range 一律回 200 全量（真实世界最典型：
  // 某些代理/CDN 静默剥离 Range 头）。修复前：4 段各收 12MB 全量合并成 48MB 损坏
  // 文件 → sha 失败重试死循环。修复后：整批放弃多段，降级单段完整下载。
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('服务器忽略 Range 回 200 → 整批放弃多段，降级单段完整下载且产物正确', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    // 记录每个 GET 请求是否带 Range 头，用于断言「最终走了单段全新下载」
    const getRangeHeaders: Array<string | undefined> = []
    globalThis.fetch = vi.fn(async (url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range
      // probe 探测请求（GET Range: bytes=0-0）→ 206 放行多段（探测之后代理才开始剥 Range）
      if (rangeHeader === 'bytes=0-0') {
        return makeProbeResponse(MULTI_PART_CONTENT.length)
      }
      getRangeHeaders.push(rangeHeader)
      // 无论是否带 Range，一律回 200 + 全量内容（模拟忽略 Range 的服务器）
      return makeContentResponse(MULTI_PART_CONTENT)
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'rm3-ignore-range.zip',
      downloadUrl: 'https://example.com/rm3-ignore-range.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    // 降级路径可观察信号：多段阶段若干带 Range 的 GET 之后，还有一个无 Range 头
    // 的 GET——那是降级后的单段完整下载（全新下载不发 Range 头）。
    expect(getRangeHeaders.filter((r) => r !== undefined).length).toBeGreaterThanOrEqual(1)
    expect(getRangeHeaders).toContain(undefined)
    expectIntactFile(result.filePath)
    expectNoLeftovers('rm3-ignore-range.zip')
  })

  // RM3-2: 206 但段长与请求不符（代理返回错误区间/截短内容）。
  // 无论 content-length 是否可提前发现，都应降级单段完整下载，绝不合并错位内容。
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('段响应 206 但段长与请求不符 → 降级单段完整下载', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    globalThis.fetch = vi.fn(async (url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      // probe 探测请求（GET Range: bytes=0-0）→ 206 + Content-Range 放行多段
      if (rangeHeader === 'bytes=0-0') {
        return makeProbeResponse(MULTI_PART_CONTENT.length)
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      // 无 Range 头 = 降级后的单段完整下载，回全量
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      // 回 206 但 body 只有 1KB（远小于段长 3MB），content-length 与实际 body 相符，
      // 触发「content-length != 段长」提前拦截分支
      const wrongSlice = MULTI_PART_CONTENT.subarray(start, start + TRUNCATED_PART_BYTES)
      return new Response(new Uint8Array(wrongSlice), {
        status: 206,
        headers: {
          'Content-Length': String(wrongSlice.length),
          'Content-Range': `bytes ${start}-${start + wrongSlice.length - 1}/${MULTI_PART_CONTENT.length}`,
        },
      })
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'rm3-content-length-mismatch.zip',
      downloadUrl: 'https://example.com/rm3-cl-mismatch.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expectIntactFile(result.filePath)
    expectNoLeftovers('rm3-content-length-mismatch.zip')
  })

  // RM3-3: 206 但 content-length 声称与段长相符、body 实际被截短（chunked 传输或
  // 代理半途截断）。提前拦截无法发现，靠流结束后的实下字节数兜底校验降级。
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('段响应 206 且 content-length 声称相符但 body 实际截短 → 流结束校验降级单段', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    globalThis.fetch = vi.fn(async (url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      // probe 探测请求（GET Range: bytes=0-0）→ 206 + Content-Range 放行多段
      if (rangeHeader === 'bytes=0-0') {
        return makeProbeResponse(MULTI_PART_CONTENT.length)
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      const end = Number(match[2])
      // content-length 声称等于段长（与请求一致），但 body 实际只有 1KB——声称与实况不符
      const shortSlice = MULTI_PART_CONTENT.subarray(start, start + TRUNCATED_PART_BYTES)
      return new Response(new Uint8Array(shortSlice), {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${MULTI_PART_CONTENT.length}`,
        },
      })
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'rm3-body-truncated.zip',
      downloadUrl: 'https://example.com/rm3-truncated.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expectIntactFile(result.filePath)
    expectNoLeftovers('rm3-body-truncated.zip')
  })
})

// ════════════════════════════════════════════════════════════════
// 批次 5（u5a）：resume-state 原子写序列（§3.7.2 m12）
// 断言 saveResumeState 走「写 .tmp → renameSync 到终态」序列而非直写。
// ════════════════════════════════════════════════════════════════
describe('批次 5: resume-state 原子写序列（§3.7.2）', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    fsSpy.writeCalls.length = 0
    fsSpy.renameCalls.length = 0
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('多段下载过程中 saveResumeState → 先写 resume-state.json.tmp 再 renameSync 到终态（验收③）', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    // 单段大文件下载（服务器不支持 Range）→ data 流式回调触发 saveResumeState
    // （多段成功路径不写 resume-state，分段写入只发生在单段流式下载）。
    // probe 探测请求（GET Range: bytes=0-0）同样回 200 全量 → 出口④ 非 206 → 单段。
    globalThis.fetch = vi.fn(async (_url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      if (rangeHeader === 'bytes=0-0') {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      return makeContentResponse(MULTI_PART_CONTENT)
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'multipart-atomic.zip',
      downloadUrl: 'https://example.com/multipart-atomic.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expect(result.filePath).toMatch(/multipart-atomic\.zip$/)

    // 序列断言：resume-state.json.tmp 的 writeFileSync 先于 renameSync(→resume-state.json)
    const tmpWrite = fsSpy.writeCalls.find((c) => c.path.endsWith('resume-state.json.tmp'))
    const rename = fsSpy.renameCalls.find((c) => c.to.endsWith('resume-state.json'))
    expect(tmpWrite, '应先写 resume-state.json.tmp').toBeDefined()
    expect(rename, '应 renameSync 到 resume-state.json 终态').toBeDefined()
    const writeIdx = fsSpy.writeCalls.indexOf(tmpWrite!)
    const renameIdx = fsSpy.renameCalls.indexOf(rename!)
    expect(rename).toBeDefined()
    expect(rename!.from).toBe(tmpWrite!.path)
    // 下载成功后 clearResumeState 清掉终态文件（且 .tmp 不残留）
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'resume-state.json'))).toBe(false)
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'resume-state.json.tmp'))).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════
// B-4 续传判定边界（review round 1 test-coverage MF）。
// 锁定 downloadAsset 的放宽续传分支语义：
//   overshoot = stat.size - state.downloadedBytes
//   - overshoot <= 0 → 信任 stat.size 续传（落盘字节是唯一真相）
//   - 0 < overshoot <= SAVE_INTERVAL_BYTES 且 stat.size <= totalBytes → 仍续传
//     （保存后 pipe 异步刷盘、硬崩溃常落在两次保存之间）
//   - overshoot > SAVE_INTERVAL_BYTES 或 stat.size > totalBytes → 作废重下
// 条件写反（如把信任窗口改成「只有 overshoot<=0 才续传」或全信任）这些用例必红。
// ════════════════════════════════════════════════════════════════

// 与 download-asset.ts 的 SAVE_INTERVAL_BYTES 一致（模块未导出）
const SAVE_INTERVAL_BYTES = 1024 * 1024

describe('B-4: 断点续传判定边界（overshoot 信任窗口）', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  /** 预置续传现场：写 resume-state.json + 指定大小的 .downloading 临时文件。 */
  function setupResumeScene(
    assetName: string,
    opts: { downloadedBytes: number; tempFileSize: number; totalBytes: number; tempIsContentPrefix?: boolean },
  ): { tempPath: string; finalPath: string } {
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    mkdirSync(updateDir, { recursive: true })
    const tempPath = path.join(updateDir, `${assetName}.downloading`)
    const finalPath = path.join(updateDir, assetName)
    // tempIsContentPrefix（默认 true）：temp 内容 = TEST_CONTENT 前缀，续传拼接后 sha 才能过；
    // 重下用例的 temp 会被覆盖写，内容无关，用 junk buffer 模拟「外部追加的脏字节」。
    const content = opts.tempIsContentPrefix === false
      ? Buffer.alloc(opts.tempFileSize, 0xab)
      : TEST_CONTENT.subarray(0, opts.tempFileSize)
    writeFileSync(tempPath, content)
    writeFileSync(
      path.join(updateDir, 'resume-state.json'),
      JSON.stringify({ downloadedBytes: opts.downloadedBytes, totalBytes: opts.totalBytes, tempPath, finalPath }),
    )
    return { tempPath, finalPath }
  }

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ① 0 < overshoot <= SAVE_INTERVAL_BYTES 且 stat.size <= totalBytes → 信任 stat.size 续传
  it('略超 state（≤1MB）→ 从 stat.size 续传（Range 起点 = stat.size），产物完整', async () => {
    const stateBytes = 20
    const tempSize = 30 // overshoot = 10，落在 (0, 1MB] 信任窗口
    setupResumeScene('b4-slight-overshoot.zip', { downloadedBytes: stateBytes, tempFileSize: tempSize, totalBytes: TEST_CONTENT.length })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rangeHeaders: Array<string | undefined> = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range
      rangeHeaders.push(rangeHeader)
      if (!rangeHeader) return makeContentResponse(TEST_CONTENT)
      const start = Number(/^bytes=(\d+)-$/.exec(rangeHeader)![1])
      return makeRangeResponse(TEST_CONTENT, start, TEST_CONTENT.length - 1)
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'b4-slight-overshoot.zip',
      downloadUrl: 'https://example.com/b4-slight-overshoot.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    })

    // 唯一一次 GET 带 Range 且起点 = stat.size（而非 state.downloadedBytes）
    expect(rangeHeaders).toEqual([`bytes=${tempSize}-`])
    // 可观察信号：日志声明续传起点
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes(`resuming from ${tempSize} bytes`))).toBe(true)
    // 续传拼接后产物完整正确（前缀 + 剩余段 = 原内容）
    expect(readFileSync(result.filePath).compare(TEST_CONTENT)).toBe(0)
  })

  // ①b overshoot <= 0（temp 比 state 记录的小）→ 同样信任 stat.size 续传
  it('temp 不大于 state → 从 stat.size 续传（落盘字节优先于计数器）', async () => {
    const stateBytes = 30
    const tempSize = 20 // overshoot = -10
    setupResumeScene('b4-undershoot.zip', { downloadedBytes: stateBytes, tempFileSize: tempSize, totalBytes: TEST_CONTENT.length })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rangeHeaders: Array<string | undefined> = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range
      rangeHeaders.push(rangeHeader)
      if (!rangeHeader) return makeContentResponse(TEST_CONTENT)
      const start = Number(/^bytes=(\d+)-$/.exec(rangeHeader)![1])
      return makeRangeResponse(TEST_CONTENT, start, TEST_CONTENT.length - 1)
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'b4-undershoot.zip',
      downloadUrl: 'https://example.com/b4-undershoot.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    })

    expect(rangeHeaders).toEqual([`bytes=${tempSize}-`])
    expect(readFileSync(result.filePath).compare(TEST_CONTENT)).toBe(0)
  })

  // ② overshoot > SAVE_INTERVAL_BYTES → 作废重下（全新请求无 Range 头）
  it('显著超限（>1MB）→ 作废重下：请求无 Range 头、mismatch 日志、产物完整', async () => {
    setupResumeScene('b4-big-overshoot.zip', {
      downloadedBytes: 20,
      tempFileSize: 20 + SAVE_INTERVAL_BYTES + 1, // overshoot 恰好超信任窗口 1 字节
      totalBytes: TEST_CONTENT.length,
      tempIsContentPrefix: false, // 模拟外部追加的脏字节
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rangeHeaders: Array<string | undefined> = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range
      rangeHeaders.push(rangeHeader)
      if (!rangeHeader) return makeContentResponse(TEST_CONTENT)
      const start = Number(/^bytes=(\d+)-$/.exec(rangeHeader)![1])
      return makeRangeResponse(TEST_CONTENT, start, TEST_CONTENT.length - 1)
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'b4-big-overshoot.zip',
      downloadUrl: 'https://example.com/b4-big-overshoot.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    })

    // 重下 = 全新请求（无 Range 头）
    expect(rangeHeaders).toEqual([undefined])
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('resume state mismatch'))).toBe(true)
    // 覆盖写后产物完整
    expect(readFileSync(result.filePath).compare(TEST_CONTENT)).toBe(0)
  })

  // ②b stat.size > totalBytes（超上界）→ 即使 overshoot 在信任窗口内也作废重下
  it('temp 超过 totalBytes 上界 → 作废重下（信任窗口不豁免上界检查）', async () => {
    setupResumeScene('b4-over-total.zip', {
      downloadedBytes: 20,
      tempFileSize: 40, // overshoot = 20 ≤ 1MB，但 40 > totalBytes 30 → 必须重下
      totalBytes: 30,
      tempIsContentPrefix: true,
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rangeHeaders: Array<string | undefined> = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range
      rangeHeaders.push(rangeHeader)
      if (!rangeHeader) return makeContentResponse(TEST_CONTENT)
      const start = Number(/^bytes=(\d+)-$/.exec(rangeHeader)![1])
      return makeRangeResponse(TEST_CONTENT, start, TEST_CONTENT.length - 1)
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'b4-over-total.zip',
      downloadUrl: 'https://example.com/b4-over-total.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    })

    expect(rangeHeaders).toEqual([undefined])
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('resume state mismatch'))).toBe(true)
    expect(readFileSync(result.filePath).compare(TEST_CONTENT)).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════
// RM3 downloadPart 共享 abort 组合（review round 1 test-coverage MF）。
// RM3 修复本体：段失败 → downloadMultiPart 的 abortController.abort() 经
// sharedSignal 传入 downloadPart，与其 per-part watchdog controller 组合——
// 共享 abort 触发本段 controller abort，健康段的 fetch 被真实中断而非跑完。
// 无此回归测试，修复可被无声回退回「abort 不生效」（健康段挂满全程）。
// ════════════════════════════════════════════════════════════════
describe('RM3-4: 段失败 → 共享 signal 中断其余段', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  /**
   * RM3 共享 abort 场景的 fetch mock：part-0 返回 HTTP 500；健康段（part-1..3）
   * 返回 206 流——发出 64 字节后挂起（永不自然结束），直到所属 fetch signal 收到
   * abort 才 error。每个健康段的可观察状态记入 partAborted（aborted = signal 收到 abort）。
   */
  function makeSharedAbortFetchMock(partAborted: Map<number, { aborted: boolean }>) {
    return vi.fn(async (_url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      // probe 探测请求（GET Range: bytes=0-0）→ 206 + Content-Range 放行多段
      // （必须先于 start===0 的 500 分支截获，否则探测即 500，多段根本不会启动）
      if (rangeHeader === 'bytes=0-0') {
        return makeProbeResponse(MULTI_PART_CONTENT.length)
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (!match) {
        return makeContentResponse(MULTI_PART_CONTENT)
      }
      const start = Number(match[1])
      const end = Number(match[2])
      if (start === 0) {
        return new Response('Internal Server Error', { status: 500 })
      }
      const signal = init?.signal as AbortSignal | undefined
      const obs = { aborted: false }
      partAborted.set(start, obs)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MULTI_PART_CONTENT.subarray(start, start + 64)))
          const onAbort = () => {
            obs.aborted = true
            try { controller.error(new Error('shared abort')) } catch { /* 已关闭 */ }
          }
          if (signal?.aborted) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
        },
      })
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${MULTI_PART_CONTENT.length}`,
        },
      })
    }) as unknown as typeof globalThis.fetch
  }

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    fsSpy.writeStreamOpenDelayMs = 0
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('part-0 返回 500 → 其余三段挂起流收到 abort 被中断（非跑完），整批 rejects', { timeout: 30_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    // 每个健康段的可观察状态：aborted = 该段 fetch 的 signal 收到 abort
    const partAborted = new Map<number, { aborted: boolean }>()
    globalThis.fetch = makeSharedAbortFetchMock(partAborted)

    const pending = downloadAsset({
      name: 'rm3-shared-abort.zip',
      downloadUrl: 'https://example.com/rm3-shared-abort.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })
    // part-0 会在 waitFor 窗口内先 reject——先挂兜底 handler 防被判 unhandled rejection
    //（下方 await expect(pending).rejects 才是真正的断言消费）
    pending.catch(() => {})

    // fail-fast：三个健康段的 signal 必须收到共享 abort（否则 abort 组合失效，
    // 与其等满 30s 测试超时，这里 5s 内给出指向性失败）
    await vi.waitFor(() => {
      expect(partAborted.size).toBe(3)
      for (const obs of partAborted.values()) {
        expect(obs.aborted).toBe(true)
      }
    }, { timeout: 5_000, interval: 50 })

    // 无 Range 违约 → 抛第一个真实错误（part-0 的 HTTP 500），不误降级
    await expect(pending).rejects.toThrow(/HTTP 500/)

    // 清理兜底：无 .part-* 残留
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) {
      const leftovers = readdirSync(updateDir).filter((f) => /\.part-\d+$/.test(f))
      expect(leftovers).toEqual([])
    }
  })

  // [RM3-CI 回归] 失败清理与 createWriteStream 异步 open 的竞争。
  // open 是 threadpool 异步操作：CI mac 高负载下（同文件 suite 84s、threadpool 拥塞）
  // 部分段失败链路（共享 abort → 流 error → reject → catch → unlinkSync）会跑在
  // open 完成之前——unlink 扑空（ENOENT）后 open 完成把 .part 文件「复活」成永久
  // 残留。本地快路径 open 先完成，该缺陷从不暴露（CI run 34037936933 确定性红 vs
  // 本地全绿）。注入 50ms open 延迟确定性复现该时序：实现必须等 writeStream 'close'
  // （fd 生命周期终态）落定后再清理，清理才能确定作用于已存在（或从未创建）的文件。
  it('open 完成晚于失败清理（CI threadpool 拥塞形态）→ 段失败清理仍无 .part 残留', { timeout: 30_000 }, async () => {
    fsSpy.writeStreamOpenDelayMs = 50
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    const partAborted = new Map<number, { aborted: boolean }>()
    globalThis.fetch = makeSharedAbortFetchMock(partAborted)

    const pending = downloadAsset({
      name: 'rm3-open-race.zip',
      downloadUrl: 'https://example.com/rm3-open-race.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })
    pending.catch(() => {})

    await vi.waitFor(() => {
      expect(partAborted.size).toBe(3)
      for (const obs of partAborted.values()) {
        expect(obs.aborted).toBe(true)
      }
    }, { timeout: 5_000, interval: 50 })

    await expect(pending).rejects.toThrow(/HTTP 500/)

    // 给被延迟的 open 留出完成窗口（50ms）：残留若会「复活」，此刻已在盘上
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    const updateDir = path.join(TMP_DATA_DIR, 'update')
    const leftovers = readdirSync(updateDir).filter((f) => /\.part-\d+$/.test(f))
    expect(leftovers).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════
// probe 四出口归类表测（多源改造：HEAD → GET Range 0-0 + Content-Range 判定）。
//
// 判定规格（设计 §7.2 download-asset 行，逐字对齐）：
//   ① 206 + `Content-Range: bytes 0-0/{total}` 且 total ≥ 10MB → supported
//     （totalBytes 取自 Content-Range——206 形态 content-length 恒 1，照搬即两源多段全灭）
//   ② 206 + total 数字低于阈值 → not supported
//   ③ 206 但 Content-Range 缺失 / total `*` / 单位非 bytes / 不可解析 → 一律 not supported
//   ④ 非 206（200 全量退化 / 405 等）→ not supported（单段，合法出口）
//
// 黑盒观察信号：probe（请求 Range: bytes=0-0）supported=true 时后续发出段请求
//（Range 形态 bytes=N-M），partSize = floor(totalBytes/4)——首段 Range 直接编码了
// totalBytes 的取值来源；not supported 时无段请求、直接单段全新下载（无 Range 头）。
// ════════════════════════════════════════════════════════════════
describe('probe 四出口归类（GET Range 0-0 + Content-Range 判定）', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  // 12MB / 4 段切分的首段参数（totalBytes=12582912 时 partSize=floor(total/4)=3145728）。
  // 若 totalBytes 错取恒 1 的 content-length：maxParts=max(1,min(4,0))=1、partSize=1，
  // 首段 Range 会是 bytes=0-0——「出现 bytes=0-3145727 的段请求」唯一地证明
  // totalBytes 来自 Content-Range 而非 content-length。
  const PART0_RANGE = 'bytes=0-3145727'
  const PROBE_RANGE = 'bytes=0-0'

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    // curl 接管用例经真实置位链路写过进程级 flag，必须复位防泄漏到同文件后续 describe
    resetEnginePreferenceForTest()
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 表测共用骨架：mock 探测响应形态 + 段/单段响应，记录全部请求 Range 序列 */
  function makeRangeRecordingFetch(
    probeRespond: () => Response,
    opts: { serveRangeParts?: boolean } = {},
  ): { rangeLog: Array<string | undefined> } {
    const rangeLog: Array<string | undefined> = []
    globalThis.fetch = vi.fn(async (_url, init) => {
      const rangeHeader = (init?.headers as Record<string, string> | undefined)?.Range ?? ''
      if (rangeHeader === PROBE_RANGE) {
        return probeRespond()
      }
      rangeLog.push(rangeHeader || undefined)
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (opts.serveRangeParts && match) {
        const start = Number(match[1])
        const end = Number(match[2])
        return makeRangeResponse(MULTI_PART_CONTENT, start, end)
      }
      return makeContentResponse(MULTI_PART_CONTENT)
    }) as unknown as typeof globalThis.fetch
    return { rangeLog }
  }

  // 出口①：206 + Content-Range total 达标 → supported；totalBytes 来自 Content-Range。
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('① 206 + Content-Range total 达标 → 多段启动，首段 Range 证明 totalBytes 取自 Content-Range 而非恒 1 的 content-length', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    // P7 实测两源形态：206 + Content-Range total 正确 + Content-Length 恒 1
    const { rangeLog } = makeRangeRecordingFetch(
      () => makeProbeResponse(MULTI_PART_CONTENT.length),
      { serveRangeParts: true },
    )

    const result = await downloadAsset({
      name: 'probe-exit1.zip',
      downloadUrl: 'https://example.com/probe-exit1.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    // supported 的可观察信号：段请求已发出，且首段 Range 编码了 Content-Range 的 total
    expect(rangeLog).toContain(PART0_RANGE)
    // 4 段全部下发（multiPart 判定 + 段切分均基于 totalBytes=12582912）
    expect(rangeLog.filter((r) => r !== undefined && r !== PROBE_RANGE)).toHaveLength(4)
    // 产物完整正确（多段合并 + sha 通过）
    expect(readFileSync(result.filePath).compare(MULTI_PART_CONTENT)).toBe(0)
    // 返回值观测面：probe supported 且多段真实完成（S1 断言「multiPart: true」防
    // probe 改造回归静默退化单段）
    expect(result.multiPart).toBe(true)
    expect(result.engine).toBe('undici')
  })

  // 出口②：206 + total 数字低于阈值 → not supported（文件不够大，单段）。
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('② 206 但 Content-Range total 低于 10MB 阈值 → not supported，单段完成不抛错', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    const { rangeLog } = makeRangeRecordingFetch(
      () => new Response(new Uint8Array([0]), {
        status: 206,
        headers: { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/1024' },
      }),
    )

    const result = await downloadAsset({
      name: 'probe-exit2.zip',
      downloadUrl: 'https://example.com/probe-exit2.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    // 无段请求：探测之后唯一一次请求是单段全新下载（无 Range 头）
    expect(rangeLog).toEqual([undefined])
    expect(readFileSync(result.filePath).compare(MULTI_PART_CONTENT)).toBe(0)
    // 返回值观测面：total 低于阈值未走多段
    expect(result.multiPart).toBe(false)
    expect(result.engine).toBe('undici')
  })

  // 出口③：206 但 Content-Range 不可用（缺失 / total `*` / 单位非 bytes）→ 一律 not supported。
  // 无 total 即无法切分多段；解析失败不抛错，只落单段出口。
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it.each([
    ['Content-Range 缺失', {}],
    ['total 为 *', { 'Content-Range': 'bytes 0-0/*' }],
    ['单位非 bytes', { 'Content-Range': 'items 0-0/12582912' }],
    ['形态不可解析', { 'Content-Range': 'garbage' }],
  ])('③ 206 但 %s → not supported，单段完成不抛错', { timeout: 60_000 }, async (_label, extraHeaders) => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    const { rangeLog } = makeRangeRecordingFetch(
      () => new Response(new Uint8Array([0]), {
        status: 206,
        headers: { 'Content-Length': '1', ...extraHeaders },
      }),
    )

    const result = await downloadAsset({
      name: 'probe-exit3.zip',
      downloadUrl: 'https://example.com/probe-exit3.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expect(rangeLog).toEqual([undefined])
    expect(readFileSync(result.filePath).compare(MULTI_PART_CONTENT)).toBe(0)
    // 返回值观测面：Content-Range 不可用一律单段
    expect(result.multiPart).toBe(false)
    expect(result.engine).toBe('undici')
  })

  // 出口④：非 206（P5 实测 gitcode.com 主域形态：GET Range 0-0 回 200 全量）→
  // not supported，单段合法出口，正确性无风险。
  // 超时豁免登记：CI mac runner threadpool 拥塞（口径对齐 [RM3-CI 回归] 用例登记），本地实测 <0.2s——60s 是负载余量非真实耗时
  it('④ 探测回 200 全量退化 → not supported，单段完成不抛错', { timeout: 60_000 }, async () => {
    const expectedSha = sha256Hex(MULTI_PART_CONTENT)
    const { rangeLog } = makeRangeRecordingFetch(
      () => makeContentResponse(MULTI_PART_CONTENT),
    )

    const result = await downloadAsset({
      name: 'probe-exit4.zip',
      downloadUrl: 'https://example.com/probe-exit4.zip',
      size: MULTI_PART_CONTENT.length,
      sha256: expectedSha,
    })

    expect(rangeLog).toEqual([undefined])
    expect(readFileSync(result.filePath).compare(MULTI_PART_CONTENT)).toBe(0)
    // 返回值观测面：200 全量退化（服务器/代理剥 Range）单段合法出口
    expect(result.multiPart).toBe(false)
    expect(result.engine).toBe('undici')
  })

  // curl 接管成功形态（engine 观测面）：flag=curl 入口分流 → 全程 undici 零调用，
  // curl 引擎完成下载。engine=curl 断言锁「实际成功者」语义（降级后成功以 curl 为准）。
  it('flag=curl 入口接管成功 → engine=curl 且 multiPart=false', async () => {
    // 真实置位链路构造 flag（仅连接建立失败档置位）
    expect(markEnginePreferenceFromUndiciFailure(fetchFailedWith('EHOSTUNREACH'))).toBe(true)
    downloadViaCurlMock.mockImplementation(async (_asset, opts) => {
      writeFileSync(opts.tempPath, TEST_CONTENT)
      return { tempPath: opts.tempPath }
    })
    // flag=curl 应跳过全部 undici 形态（probe 与单/多段 fetch 均不发生）
    globalThis.fetch = vi.fn(async () => {
      throw new Error('undici must be skipped when engine preference is curl')
    }) as unknown as typeof globalThis.fetch

    const result = await downloadAsset({
      name: 'engine-curl.zip',
      downloadUrl: 'https://example.com/engine-curl.zip',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    })

    expect(result.engine).toBe('curl')
    expect(result.multiPart).toBe(false)
    expect(readFileSync(result.filePath)).toEqual(TEST_CONTENT)
    expect(existsSync(`${result.filePath}.downloading`)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════
// D1 idle 停滞检测语义（timeout-slow-flow-wallclock 设计 §8 P2 / §9 场景 1/2 单测映射）。
// 总墙钟删除后单段路径的唯一超时形态是 idle watchdog（fetch 前挂载）：
//   ① 慢速但持续传输（<30s 必有字节）跨旧总钟边界（>3600s）不被杀
//   ② 流中停滞 30s 无数据 → 中断 + UPDATE_NETWORK_TIMEOUT + temp 保留可续传
//   ③ 等响应头阶段停滞 30s → idle 前移后照样中断（防 header 阶段无限挂）
// ════════════════════════════════════════════════════════════════
describe('D1: idle 停滞检测（总墙钟已删）', () => {
  let originalFetch: typeof globalThis.fetch
  let downloadAsset: typeof import('../update/download-asset.js')['downloadAsset']

  /** 单块字节数（400 块 × 1KB = 400KB < 1MB 保存阈值，避免中途写 resume-state 干扰） */
  const CHUNK_BYTES = 1024

  /** 受控流式下载源：测试手动 enqueue/close 驱动 data 事件；signal abort 时 error 掉流（镜像真实 undici abort 传播行为）。 */
  function makeControlledSource(totalBytes: number, signal?: AbortSignal): {
    response: Response
    enqueue: (buf: Uint8Array) => void
    close: () => void
  } {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c
        signal?.addEventListener('abort', () => {
          try { c.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })) } catch { /* 已关闭 */ }
        }, { once: true })
      },
    })
    return {
      response: new Response(stream, {
        status: 200,
        headers: { 'Content-Length': String(totalBytes) },
      }),
      enqueue: (buf) => streamController?.enqueue(buf),
      close: () => streamController?.close(),
    }
  }

  beforeEach(async () => {
    originalFetch = globalThis.fetch
    const mod = await loadModule()
    downloadAsset = mod.downloadAsset
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ① 场景 1（单测缩样）：慢速但持续传输不被杀——每 10s 一块共 400 块 = 4000s，
  //    跨越旧总墙钟 3600s 边界；删除总钟后应完整下载成功。
  it('慢速但持续传输跨旧总钟边界（4000s > 3600s）不被杀，最终下载成功', async () => {
    vi.useFakeTimers()
    const totalChunks = 400
    const content = Buffer.alloc(totalChunks * CHUNK_BYTES, 0x5a)
    const expectedSha = sha256Hex(content)
    let source: ReturnType<typeof makeControlledSource> | undefined
    globalThis.fetch = vi.fn(async () => {
      source = makeControlledSource(content.length)
      return source.response
    }) as unknown as typeof globalThis.fetch

    const pending = downloadAsset({
      name: 'd1-slow-sustained.zip',
      downloadUrl: 'https://example.com/d1-slow-sustained.zip',
      size: content.length,
      sha256: expectedSha,
    })
    const probe = pending.then(() => 'resolved' as const, () => 'rejected' as const)

    // 每块间隔 10s（< 30s idle 边界）：data 到达即重置 idle，跨旧总钟边界持续推进
    for (let i = 0; i < totalChunks; i++) {
      source!.enqueue(new Uint8Array(content.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)))
      await vi.advanceTimersByTimeAsync(10_000)
    }
    source!.close()

    expect(await probe).toBe('resolved')
    const finalPath = path.join(TMP_DATA_DIR, 'update', 'd1-slow-sustained.zip')
    expect(readFileSync(finalPath).compare(content)).toBe(0)
  }, 30_000)

  // ② 场景 2（单测缩样）：流中停滞 30 秒无数据 → idle 中断，错误可续传（temp 保留）。
  it('流中停滞 30 秒 → idle abort，报 UPDATE_NETWORK_TIMEOUT（停滞文案）且 temp + resume-state 保留可续传', async () => {
    vi.useFakeTimers()
    const totalBytes = 100 * 1024 // < 10MB 多段阈值：直接单段路径，无 probe 干扰
    let source: ReturnType<typeof makeControlledSource> | undefined
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      source = makeControlledSource(totalBytes, init?.signal)
      return source.response
    }) as unknown as typeof globalThis.fetch

    const pending = downloadAsset({
      name: 'd1-stall-midstream.zip',
      downloadUrl: 'https://example.com/d1-stall.zip',
      size: totalBytes,
    })
    const probe = pending.then(() => 'resolved' as const, (e: unknown) => e)

    source!.enqueue(new Uint8Array(CHUNK_BYTES)) // 首块到达（重置 idle）
    await vi.advanceTimersByTimeAsync(1_000) // flush data 回调
    // 先等 .downloading 真实落盘（fd open 完成）再推进假时钟：open 是 threadpool
    // 异步操作，CI 拥塞时可晚于 idle abort 触发，届时 destroy 会连带取消尚未创建的
    // 文件 → 断言假红（生产不会：abort 要求 30s 无数据，必晚于 open）。
    const stallTempPath = path.join(TMP_DATA_DIR, 'update', 'd1-stall-midstream.zip.downloading')
    await waitForRealPath(stallTempPath)
    await vi.advanceTimersByTimeAsync(30_000) // 停滞满 30s → idle abort

    const err = await probe
    expect(err).toBeInstanceOf(UpdateError)
    const updateErr = err as UpdateError
    expect(updateErr.errorCode).toBe('UPDATE_NETWORK_TIMEOUT')
    expect(updateErr.message).toContain('stalled')
    expect(updateErr.message).toContain('30s')
    // 可续传：temp 与 resume-state 均保留（重试从断点续传）
    expect(existsSync(stallTempPath)).toBe(true)
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'resume-state.json'))).toBe(true)
  }, 30_000)

  // ③ P2 守护（单测缩样）：等响应头阶段停滞——idle 前移到 fetch 之前后，header 阶段
  //    同样受 30s 保护；删除总钟后此阶段不再无限挂（P2 探针实证正常 CDN header 时延
  //    p50≈0.4s / max≈0.9s，30s 边界余量 >30x）。
  it('等响应头阶段停滞 30 秒 → idle 前移后照样中断（UPDATE_NETWORK_TIMEOUT），不再无限挂', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
        })
      })) as unknown as typeof globalThis.fetch

    const pending = downloadAsset({
      name: 'd1-stall-header.zip',
      downloadUrl: 'https://example.com/d1-stall-header.zip',
      size: 4096,
    })
    const probe = pending.then(() => 'resolved' as const, (e: unknown) => e)
    await vi.advanceTimersByTimeAsync(30_000)

    const err = await probe
    expect(err).toBeInstanceOf(UpdateError)
    expect((err as UpdateError).errorCode).toBe('UPDATE_NETWORK_TIMEOUT')
    // header 停滞的诊断串为停滞语义（F1 成因分流的判别依据），非泛化 'timeout (aborted)'
    expect((err as UpdateError).message).toContain('stalled')
    // header 阶段失败：temp 文件从未创建，无半下载残留
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'd1-stall-header.zip.downloading'))).toBe(false)
  }, 30_000)

  // ④ 用户可见文案闭环（G1 失败路径）：main 推送 update:error 前经 toUserFriendly()
  //    映射（reportUpdateDownloadError 组 UpdateErrorPayload），toast/设置页展示的是
  //    停滞语义中文文案 + 断点续传指引（设计 §5.2 样例 5）；英文技术 message 只走
  //    落盘诊断通道，不直达用户。
  it('UPDATE_NETWORK_TIMEOUT 用户可见文案为停滞语义 + 续传指引（toUserFriendly 映射闭环）', () => {
    const err = new UpdateError(
      'download stalled (no data for 30s), aborted; temp kept — retry resumes from break point',
      'downloading',
      'UPDATE_NETWORK_TIMEOUT',
    )
    const friendly = err.toUserFriendly()
    expect(friendly.message).toBe('下载停滞（连续 30 秒无数据）已中断')
    expect(friendly.suggestion).toContain('断点续传')
    expect(friendly.suggestion).toContain('重试')
    // 英文技术 message 无「(大写码)」形态，不触发 (CODE) 后缀拼接污染中文文案
    expect(friendly.message).not.toContain('stalled')
  })
})
