/**
 * u4-download 验收测试：downloadAsset 双引擎降级编排（D4/D5/D7/D10/D8）。
 *
 * 覆盖 impl-plan u4-download 验收条款①：
 *   - undici 连接建立失败 → 置 flag → curl 路径接管（单段 / 多段两变体）
 *   - 瞬时类失败 → 降级 curl 单次不置 flag（D4 第二档）
 *   - CurlConnectionError（curl+代理 exit 7）→ 直连兜底（无代理再试）
 *   - curl spawn ENOENT → undici 直连回退（无 dispatcher 单段完整下载）
 *   - probe usedEngine='curl' → 跳过多段直接 curl 整文件（D7）
 *   - 既有单段 / 多段 / 断点续传路径行为不回归 + HTTP 错误不降级（D4 反例）
 *   - 双引擎均失败对外报 undici 错误分类，curl 侧附 engine:'curl' 落盘（D8/F）
 *
 * Mock 策略（不真实联网、不真实 spawn）：
 *   - upgrade-fetch 部分 mock：upgradeFetch 可控（probe 分流），classifyUndiciFailure /
 *     getEnginePreference / markEnginePreferenceFromUndiciFailure 用真实实现——
 *     D4 分类与置位走真实链路，flag 状态真实可断言
 *   - curl-download 部分 mock：downloadViaCurl 可控（写 temp / 抛各形态错误），
 *     CurlConnectionError 用真实类（instanceof 判定需要）
 *   - constants mock 到临时目录（真实 fs 驱动 temp / sha256 校验 / rename / resume-state）
 *
 * 运行：cd apps/electron/main && npx vitest run update/__tests__/download-asset-fallback.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ReleaseAsset } from '@taiji/shared'
import { UpdateError } from '../types.js'

// ─── 模块 mock（vi.mock 提升：先于 download-asset 静态导入生效） ───────────────

// constants mock：UPDATE_DIR 指向临时目录（download-asset 模块加载期即读 UPDATE_DIR
// constants mock：路径函数重定向到临时目录（download-asset 的 getResumeStateFile /
// 临时文件路径运行时经 getUpdateDir 解析）。延迟求值后 hoisted 不再是硬约束，
// 保留结构最小化 diff。
const { TEST_DIR } = vi.hoisted(() => {
  const base = process.env.TMPDIR || '/tmp'
  return { TEST_DIR: `${base}/u4-download-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}` }
})

vi.mock('../constants.js', () => ({
  getUpdateDir: () => TEST_DIR,
  getUpdateErrorLog: () => `${TEST_DIR}/update-error.log`,
}))

// error-log mock：不落真实磁盘，直接断言 appendUpdateError 调用参数
vi.mock('../error-log.js', () => ({
  appendUpdateError: vi.fn(),
}))

// upgrade-fetch 部分 mock：upgradeFetch 可控（probe 结果），其余（D4 分类 /
// D5 flag 状态机）保持真实实现——断言走真实分类链路
vi.mock('../upgrade-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../upgrade-fetch.js')>()
  return { ...actual, upgradeFetch: vi.fn() }
})

// curl-download 部分 mock：downloadViaCurl 可控（真实 fs 写 temp 或抛各形态错误），
// CurlConnectionError / killActiveCurlDownloads 保持真实（instanceof 判定需要）
vi.mock('../curl-download.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../curl-download.js')>()
  return { ...actual, downloadViaCurl: vi.fn() }
})

import type { UpdateErrorEntry } from '../error-log.js'
import { downloadAsset } from '../download-asset.js'
import {
  upgradeFetch,
  getEnginePreference,
  resetEnginePreferenceForTest,
  markEnginePreferenceFromUndiciFailure,
} from '../upgrade-fetch.js'
import { downloadViaCurl, CurlConnectionError } from '../curl-download.js'
import { appendUpdateError } from '../error-log.js'

const upgradeFetchMock = vi.mocked(upgradeFetch)
const downloadViaCurlMock = vi.mocked(downloadViaCurl)
const appendUpdateErrorMock = vi.mocked(appendUpdateError)

// ─── 测试工具 ─────────────────────────────────────────────────────────────────

/** 构造 undici fetch 抛错形态（外层 'fetch failed'，errno 挂 cause）。 */
function fetchFailedWith(code: string, msg = 'connect failed'): TypeError {
  const cause = Object.assign(new Error(msg), { code })
  return new TypeError('fetch failed', { cause })
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** 公网代理（错误分类平台无关：EHOSTUNREACH 落 UPDATE_NETWORK_FAILED 兜底）。 */
const PUBLIC_PROXY = 'http://1.2.3.4:8080'
const PROXY_CONFIG = { mode: 'manual' as const, httpsProxy: PUBLIC_PROXY }

/** 让 downloadViaCurl mock「下载成功」：向 temp 写入 content（string 按 utf-8、Buffer 原样）。 */
function curlWritesContent(content: string | Buffer): void {
  downloadViaCurlMock.mockImplementation(async (_asset, opts) => {
    writeFileSync(opts.tempPath, content)
    return { tempPath: opts.tempPath }
  })
}

/** 构造带 sha256 的小 asset（低于 10MB 多段阈值 → 不 probe，直落单段路径）。 */
function smallAsset(content: string): ReleaseAsset {
  return {
    name: 'u4-asset.zip',
    downloadUrl: 'https://example.invalid/u4-asset.zip',
    size: content.length,
    sha256: sha256(content),
  }
}

/** 读取 appendUpdateError 收到的条目列表。 */
function loggedEntries(): UpdateErrorEntry[] {
  return appendUpdateErrorMock.mock.calls.map((c) => c[0])
}

beforeEach(() => {
  resetEnginePreferenceForTest()
  upgradeFetchMock.mockReset()
  downloadViaCurlMock.mockReset()
  // 默认拒绝：未显式编排 curl 行为的用例若意外走到 curl 路径，测试直接失败暴露
  downloadViaCurlMock.mockRejectedValue(new Error('[test] downloadViaCurl called unexpectedly'))
  appendUpdateErrorMock.mockClear()
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ─── 验收①：undici 连接建立失败 → 置 flag → curl 路径接管 ────────────────────

describe('u4-connect-failure-fallback', () => {
  it('u4-single-connect-failure: 单段 undici EHOSTUNREACH → 置 flag → downloadViaCurl（代理透传）接管 → 校验/rename 复用 + engine-fallback 落盘', async () => {
    const content = 'u4-fallback-content'
    const asset = smallAsset(content)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))
    curlWritesContent(content)

    const result = await downloadAsset(asset, undefined, PROXY_CONFIG)

    // 校验/rename 链复用：最终文件存在且内容正确（sha256 校验通过才会 rename）
    expect(result.filePath).toBe(join(TEST_DIR, 'u4-asset.zip'))
    expect(readFileSync(join(TEST_DIR, 'u4-asset.zip'), 'utf-8')).toBe(content)

    // D5：连接建立失败档置进程级 flag
    expect(getEnginePreference()).toBe('curl')

    // curl 接管：单次调用 + 代理 URL 透传（D10 第一步 curl+代理）
    expect(downloadViaCurlMock).toHaveBeenCalledTimes(1)
    const opts = downloadViaCurlMock.mock.calls[0]?.[1]
    expect(opts?.proxyUrl).toBe(PUBLIC_PROXY)
    expect(opts?.tempPath).toBe(join(TEST_DIR, 'u4-asset.zip.downloading'))

    // D8：undici 失败被 curl 兜住 → 降级点落盘 engine-fallback（engine=undici）
    const fallback = loggedEntries().find((e) => e.source === 'engine-fallback')
    expect(fallback?.engine).toBe('undici')
    expect(fallback?.errorCode).toBe('UPDATE_NETWORK_FAILED') // 公网代理 EHOSTUNREACH 分类
    // 无失败落盘（降级成功）
    expect(loggedEntries().some((e) => e.source === 'download')).toBe(false)
  })

  it('u4-multipart-connect-failure: 多段 part EHOSTUNREACH → 置 flag → curl 接管（多段变体）', async () => {
    // ≥ 10MB 多段阈值：probe（undici）支持后进入多段，part fetch 连接建立失败。
    // [多源改造] probe 已迁移为 GET Range 0-0 判定：mock 须回 206 + Content-Range
    // total 达标（新判定不看 accept-ranges/content-length），多段才会真正启动。
    const total = 12 * 1024 * 1024
    const content = Buffer.alloc(total, 7)
    const asset: ReleaseAsset = {
      name: 'u4-multi.zip',
      downloadUrl: 'https://example.invalid/u4-multi.zip',
      size: total,
      sha256: sha256(content),
    }
    upgradeFetchMock.mockResolvedValue({
      ok: true,
      status: 206,
      headers: { 'content-range': `bytes 0-0/${total}`, 'content-length': '1' },
      usedEngine: 'undici',
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))
    curlWritesContent(content)

    const result = await downloadAsset(asset, undefined, PROXY_CONFIG)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-multi.zip'))
    expect(getEnginePreference()).toBe('curl')
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1) // probe 走过
    expect(downloadViaCurlMock).toHaveBeenCalledTimes(1)
    expect(downloadViaCurlMock.mock.calls[0]?.[1]?.proxyUrl).toBe(PUBLIC_PROXY)
  })

  it('u4-transient-no-flag: 单段 ECONNRESET（瞬时类）→ 降级 curl 单次但不置 flag（D4 第二档）', async () => {
    const content = 'u4-transient-content'
    const asset = smallAsset(content)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('ECONNRESET')))
    curlWritesContent(content)

    const result = await downloadAsset(asset, undefined, PROXY_CONFIG)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-asset.zip'))
    expect(getEnginePreference()).toBe('undici') // 未置位：下次调用重探 undici
    expect(downloadViaCurlMock).toHaveBeenCalledTimes(1)
  })
})

// ─── 验收①：CurlConnectionError → 直连兜底（无代理再试） ──────────────────────

describe('u4-proxy-unavailable-direct-fallback', () => {
  it('u4-curl-exit7-direct: curl+代理连接失败（exit 7 形态）→ 判定代理不可用 → 无代理再试成功（D10 第二步→第三步）', async () => {
    const content = 'u4-direct-fallback-content'
    const asset = smallAsset(content)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))
    // 第一次（带代理）：CurlConnectionError；第二次（无代理）：成功
    downloadViaCurlMock
      .mockRejectedValueOnce(new CurlConnectionError('curl connection failed (exit 7)', 7, 'curl: (7) Failed to connect to 1.2.3.4 port 8080'))
      .mockImplementationOnce(async (_asset, opts) => {
        expect(opts.proxyUrl).toBeUndefined() // 直连兜底：无代理
        writeFileSync(opts.tempPath, content, 'utf-8')
        return { tempPath: opts.tempPath }
      })

    const result = await downloadAsset(asset, undefined, PROXY_CONFIG)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-asset.zip'))
    expect(readFileSync(join(TEST_DIR, 'u4-asset.zip'), 'utf-8')).toBe(content)
    expect(downloadViaCurlMock).toHaveBeenCalledTimes(2)
    expect(downloadViaCurlMock.mock.calls[0]?.[1]?.proxyUrl).toBe(PUBLIC_PROXY)
    expect(downloadViaCurlMock.mock.calls[1]?.[1]?.proxyUrl).toBeUndefined()
    // curl 侧连接失败落盘 engine='curl'（D8：curl 结果只作 engine 诊断字段）
    const curlSide = loggedEntries().find((e) => e.engine === 'curl')
    expect(curlSide?.rawCause).toContain('exit 7')
  })
})

// ─── 验收①：curl ENOENT → undici 直连回退 ─────────────────────────────────────

describe('u4-curl-enoent-undici-direct', () => {
  it('u4-enoent-undici-direct: curl spawn ENOENT → 回退 undici 直连（无 dispatcher 单段完整下载），成功 + engine-fallback(curl) 落盘', async () => {
    const content = 'u4-enoent-fallback-content'
    const asset = smallAsset(content)
    const fetchMock = vi.fn().mockImplementation(async () => new Response(content))
    vi.stubGlobal('fetch', fetchMock)
    // undici 先失败（EHOSTUNREACH 置 flag）→ curl ENOENT → undici 直连第二次成功
    fetchMock.mockRejectedValueOnce(fetchFailedWith('EHOSTUNREACH'))
    downloadViaCurlMock.mockRejectedValue(
      Object.assign(new Error('spawn /usr/bin/curl ENOENT'), { code: 'ENOENT' }),
    )

    const result = await downloadAsset(asset, undefined, PROXY_CONFIG)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-asset.zip'))
    expect(readFileSync(join(TEST_DIR, 'u4-asset.zip'), 'utf-8')).toBe(content)
    expect(downloadViaCurlMock).toHaveBeenCalledTimes(1) // curl 形态只试一次即判定不可用

    // undici 直连：第二次 fetch 调用无 dispatcher（D10 第三步无代理直连语义）
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const directInit = fetchMock.mock.calls[1]?.[1] as (RequestInit & { dispatcher?: unknown }) | undefined
    expect(directInit?.dispatcher).toBeUndefined()

    // curl 缺失被 undici 兜住：engine-fallback(engine=curl) 落盘（A7③ 可观测依据）
    const curlUnavailable = loggedEntries().find((e) => e.source === 'engine-fallback' && e.engine === 'curl')
    expect(curlUnavailable?.rawCause).toContain('ENOENT')
  })
})

// ─── 验收①：probe usedEngine='curl' → 跳过多段 ────────────────────────────────

describe('u4-probe-curl-skips-multipart', () => {
  it('u4-probe-curl: probe usedEngine=curl → 直接 curl 整文件（undici fetch 零调用），校验/rename 复用', async () => {
    const total = 12 * 1024 * 1024
    const content = Buffer.alloc(total, 3)
    const asset: ReleaseAsset = {
      name: 'u4-probe-curl.zip',
      downloadUrl: 'https://example.invalid/u4-probe-curl.zip',
      size: total,
      sha256: sha256(content),
    }
    // [多源改造] probe 请求已迁移为 GET Range 0-0：mock 回 206 + Content-Range 形态
    //（usedEngine='curl' 编排在判定前分流，此形态即 curl 引擎探测成功的真实响应）
    upgradeFetchMock.mockResolvedValue({
      ok: true,
      status: 206,
      headers: { 'content-range': `bytes 0-0/${total}`, 'content-length': '1' },
      usedEngine: 'curl',
    })
    const fetchMustNotRun = vi.fn(() => {
      throw new Error('undici must be skipped when probe used curl engine')
    })
    vi.stubGlobal('fetch', fetchMustNotRun)
    curlWritesContent(content)

    const result = await downloadAsset(asset, undefined, PROXY_CONFIG)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-probe-curl.zip'))
    expect(fetchMustNotRun).not.toHaveBeenCalled() // 跳过多段与单段（全部 undici 形态）
    expect(upgradeFetchMock).toHaveBeenCalledTimes(1)
    expect(upgradeFetchMock.mock.calls[0]?.[0]).toBe(asset.downloadUrl)
    expect(upgradeFetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      proxyUrl: PUBLIC_PROXY,
    })
    expect(downloadViaCurlMock).toHaveBeenCalledTimes(1)
    expect(downloadViaCurlMock.mock.calls[0]?.[1]?.proxyUrl).toBe(PUBLIC_PROXY)
  })
})

// ─── 验收①：既有单段 / 多段 / 续传路径行为不回归 ──────────────────────────────

describe('u4-regression', () => {
  it('u4-single-success: 正常 undici 单段成功（小文件不 probe）：无 curl、无降级、无落盘', async () => {
    const content = 'u4-plain-single-content'
    const asset = smallAsset(content)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(content)))

    const result = await downloadAsset(asset)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-asset.zip'))
    expect(readFileSync(join(TEST_DIR, 'u4-asset.zip'), 'utf-8')).toBe(content)
    expect(upgradeFetchMock).not.toHaveBeenCalled() // 小文件不发 probe（S#1 阈值过滤）
    expect(downloadViaCurlMock).not.toHaveBeenCalled()
    expect(getEnginePreference()).toBe('undici')
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
  })

  it('u4-multipart-success: probe usedEngine=undici + supported → 原有多段路径（Range 分段下载合并，回归）', async () => {
    const total = 12 * 1024 * 1024
    const content = Buffer.alloc(total, 9)
    const asset: ReleaseAsset = {
      name: 'u4-multi-ok.zip',
      downloadUrl: 'https://example.invalid/u4-multi-ok.zip',
      size: total,
      sha256: sha256(content),
    }
    // [多源改造] probe mock 迁移为 206 + Content-Range total 达标（新判定不看
    // accept-ranges/content-length；content-length: 1 即 206 形态的恒 1 陷阱实锤）
    upgradeFetchMock.mockResolvedValue({
      ok: true,
      status: 206,
      headers: { 'content-range': `bytes 0-0/${total}`, 'content-length': '1' },
      usedEngine: 'undici',
    })
    // part fetch：按 Range 头切片返回 206
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      const m = /^bytes=(\d+)-(\d+)$/.exec(headers?.Range ?? headers?.range ?? '')
      if (!m) return new Response(null, { status: 400 })
      const start = Number(m[1])
      const end = Number(m[2])
      return new Response(content.subarray(start, end + 1), { status: 206 })
    }))

    const result = await downloadAsset(asset)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-multi-ok.zip'))
    // [NOTE] 不用 toEqual 比较 12MB Buffer：vitest 结构化深比较实测 14s+ 会超时，
    // Buffer.equals 是 O(n) 字节比较
    expect(readFileSync(join(TEST_DIR, 'u4-multi-ok.zip')).equals(content)).toBe(true)
    expect(downloadViaCurlMock).not.toHaveBeenCalled()
    expect(getEnginePreference()).toBe('undici')
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
  })

  it('u4-resume-regression: 断点续传路径回归（temp 残留 + state → Range 续传追加）+ 成功后 state 统一清理', async () => {
    const full = '0123456789abcdef'.repeat(320) // 5120 字节
    const asset = smallAsset(full)
    const tempPath = join(TEST_DIR, 'u4-asset.zip.downloading')
    writeFileSync(tempPath, full.slice(0, 100), 'utf-8')
    writeFileSync(join(TEST_DIR, 'resume-state.json'), JSON.stringify({
      downloadedBytes: 100,
      totalBytes: full.length,
      tempPath,
      finalPath: join(TEST_DIR, 'u4-asset.zip'),
    }))
    const fetchMock = vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      expect(headers?.Range).toBe('bytes=100-') // 从断点续传
      const rest = full.slice(100)
      return new Response(rest, {
        status: 206,
        headers: { 'content-length': String(rest.length) },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadAsset(asset)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-asset.zip'))
    expect(readFileSync(join(TEST_DIR, 'u4-asset.zip'), 'utf-8')).toBe(full) // 追加拼回完整内容
    expect(downloadViaCurlMock).not.toHaveBeenCalled()
    // D6：校验链前统一清理 resume-state（undici 路径成功后无残留）
    expect(existsSync(join(TEST_DIR, 'resume-state.json'))).toBe(false)
  })

  it('u4-http-error-no-fallback: HTTP 404 原样上抛不降级（D4 第四档反例：服务器已响应与引擎无关）', async () => {
    const asset = smallAsset('never-downloaded')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })))

    let caught: unknown
    try {
      await downloadAsset(asset)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(UpdateError)
    expect((caught as UpdateError).message).toBe('download failed: HTTP 404')
    expect(downloadViaCurlMock).not.toHaveBeenCalled()
    expect(getEnginePreference()).toBe('undici')
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
  })

  it('u4-entry-flag-curl: flag=curl → 直接 curl 整文件路径（undici fetch / probe 零调用），校验/rename/clearResumeState 复用', async () => {
    // 用真实置位链路构造 flag（markEnginePreferenceFromUndiciFailure 仅连接建立失败档置位）
    expect(markEnginePreferenceFromUndiciFailure(fetchFailedWith('EHOSTUNREACH'))).toBe(true)
    expect(getEnginePreference()).toBe('curl')

    const content = 'u4-entry-flag-content'
    const asset = smallAsset(content)
    const fetchMustNotRun = vi.fn(() => {
      throw new Error('undici must be skipped after flag set')
    })
    vi.stubGlobal('fetch', fetchMustNotRun)
    curlWritesContent(content)
    // 预置不匹配的残留 state（tempPath 指向别处）：验证校验链前统一清理
    writeFileSync(join(TEST_DIR, 'resume-state.json'), JSON.stringify({
      downloadedBytes: 1, totalBytes: 2, tempPath: 'stale-path', finalPath: 'stale-final',
    }))

    const result = await downloadAsset(asset, undefined, PROXY_CONFIG)

    expect(result.filePath).toBe(join(TEST_DIR, 'u4-asset.zip'))
    expect(readFileSync(join(TEST_DIR, 'u4-asset.zip'), 'utf-8')).toBe(content)
    expect(fetchMustNotRun).not.toHaveBeenCalled()
    expect(upgradeFetchMock).not.toHaveBeenCalled() // 不 probe
    expect(downloadViaCurlMock).toHaveBeenCalledTimes(1)
    expect(downloadViaCurlMock.mock.calls[0]?.[1]?.proxyUrl).toBe(PUBLIC_PROXY)
    // D6 统一清理：残留 state 已清
    expect(existsSync(join(TEST_DIR, 'resume-state.json'))).toBe(false)
  })
})

// ─── F：双引擎均失败对外报 undici 错误分类 ────────────────────────────────────

describe('u4-final-failure-undici-classification', () => {
  it('u4-both-fail-report-undici: undici EHOSTUNREACH + curl 超时（exit 28 形态）→ 对外报 undici 分类，curl 侧 engine=curl 落盘', async () => {
    const asset = smallAsset('never-downloaded')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))
    downloadViaCurlMock.mockRejectedValue(new UpdateError(
      'curl download stalled (no data for 30s, exit 28)',
      'downloading',
      'UPDATE_NETWORK_TIMEOUT',
    ))

    let caught: unknown
    try {
      await downloadAsset(asset, undefined, PROXY_CONFIG)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(UpdateError)
    const updateErr = caught as UpdateError
    // D8：对外分类来自 undici 侧（EHOSTUNREACH → 通用网络失败），不是 curl 的超时形态
    expect(updateErr.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(updateErr.message).toBe('network connection failed (EHOSTUNREACH)')
    expect(updateErr.message).not.toContain('curl')
    // curl 侧形态落盘 engine='curl'（不参与对外分类）
    const curlSide = loggedEntries().find((e) => e.engine === 'curl' && e.source === 'download')
    expect(curlSide?.errorCode).toBe('UPDATE_NETWORK_TIMEOUT')
    expect(curlSide?.rawCause).toContain('exit 28')
  })
})
