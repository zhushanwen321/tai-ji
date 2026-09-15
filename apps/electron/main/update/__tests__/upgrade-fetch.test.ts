/**
 * u1-fetch 验收测试：upgradeFetch 双引擎封装（D4/D5/D6/D8）。
 *
 * 覆盖验收条款：
 * ① D4 降级触发矩阵逐行（HTTP 403 不降级 / 瞬时类降级不置 flag /
 *    EHOSTUNREACH 降级且置 flag / UND_ERR_CONNECT_TIMEOUT 置 flag /
 *    disableFlagPersistence 不读不置 / 磁盘 / AbortError 总超时不降级）
 * ② curl exit code 7/28/33/35/56/22 映射（注入 CurlRunner，不真实联网）
 * ③ 降级点落盘 source='engine-fallback' + engine='undici'（mock appendUpdateError）
 *
 * 运行：cd apps/electron/main && npx vitest run update/__tests__/
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { ProxyAgent } from 'undici'
import type { CurlRunner } from '../upgrade-fetch.js'

// error-log mock：测试不落真实磁盘，直接断言 appendUpdateError 调用参数
vi.mock('../error-log.js', () => ({
  appendUpdateError: vi.fn(),
}))

import {
  upgradeFetch,
  getEnginePreference,
  resetEnginePreferenceForTest,
  markEnginePreferenceFromUndiciFailure,
  classifyUndiciFailure,
  __setCurlRunnerForTest,
  CurlFetchError,
} from '../upgrade-fetch.js'
import { appendUpdateError } from '../error-log.js'

const appendUpdateErrorMock = vi.mocked(appendUpdateError)

// ─── 测试工具 ─────────────────────────────────────────────────────

/** 构造 undici fetch 抛错形态（外层 'fetch failed'，errno 挂 cause）。 */
function fetchFailedWith(code: string, msg = 'connect failed'): TypeError {
  const cause = Object.assign(new Error(msg), { code })
  return new TypeError('fetch failed', { cause })
}

/** 构造 fetch 正常响应的假 Response（不真实联网）。 */
function fakeResponse(init: {
  ok: boolean
  status: number
  headers?: Record<string, string>
  body?: string
  textReject?: Error
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    headers: new Headers(init.headers ?? {}),
    text: init.textReject ? () => Promise.reject(init.textReject) : async () => init.body ?? '',
    body: null,
  } as unknown as Response
}

/** 假 curl runner 的行为规格。 */
interface FakeCurlSpec {
  exitCode?: number
  httpCode?: string
  headerFileContent?: string
  bodyFileContent?: string
  spawnError?: { code?: string; message: string }
}

/** 已发生的 curl 调用记录。 */
interface CurlCall {
  cmd: string
  args: string[]
}

/**
 * 安装假 curl runner：模拟 curl 行为（-D / -o 指向的文件写内容、stdout 输出
 * -w 状态码），记录调用参数。测试不 spawn 真实子进程、不联网。
 */
function installFakeCurl(spec: FakeCurlSpec, calls?: CurlCall[]): void {
  const runner: CurlRunner = (cmd, args) => {
    calls?.push({ cmd, args })
    const dIdx = args.indexOf('-D')
    if (dIdx !== -1 && spec.headerFileContent !== undefined) {
      writeFileSync(args[dIdx + 1], spec.headerFileContent, 'utf-8')
    }
    const oIdx = args.indexOf('-o')
    if (oIdx !== -1 && spec.bodyFileContent !== undefined) {
      writeFileSync(args[oIdx + 1], spec.bodyFileContent, 'utf-8')
    }
    if (spec.spawnError) {
      return { exitCode: null, stdout: '', stderr: '', spawnError: spec.spawnError }
    }
    return {
      exitCode: spec.exitCode ?? 0,
      stdout: spec.httpCode ?? '200',
      stderr: spec.exitCode !== undefined ? `curl: (${spec.exitCode}) simulated failure` : '',
    }
  }
  __setCurlRunnerForTest(runner)
}

/** 成功 curl 的常规落盘内容。 */
const OK_HEADERS = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: "abc"\r\n'

const URL_A = 'https://example.com/manifest.json'
/** 公网代理（错误分类平台无关，落 UPDATE_NETWORK_FAILED）。 */
const PUBLIC_PROXY = 'http://1.2.3.4:8080'

beforeEach(() => {
  resetEnginePreferenceForTest()
  appendUpdateErrorMock.mockClear()
  __setCurlRunnerForTest(undefined)
})

afterEach(() => {
  __setCurlRunnerForTest(undefined)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ─── 验收①：D4 降级触发矩阵逐行 ──────────────────────────────────

describe('U1-D4-matrix', () => {
  it('U1-D4 HTTP 403 不触发 curl 降级（服务器已响应与引擎无关）', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 403, body: '{"message":"rate limited"}' })),
    )

    const result = await upgradeFetch(URL_A)

    expect(result).toMatchObject({ ok: false, status: 403, usedEngine: 'undici' })
    expect(result.bodyText).toBe('{"message":"rate limited"}')
    expect(calls).toHaveLength(0) // 未降级
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
    expect(getEnginePreference()).toBe('undici')
  })

  it.each(['EHOSTUNREACH', 'ECONNREFUSED', 'ENETUNREACH'])(
    'U1-D4 连接建立失败 %s 降级且置 flag，第二次调用直接 curl',
    async (code) => {
      const calls: CurlCall[] = []
      installFakeCurl({ httpCode: '200', headerFileContent: OK_HEADERS, bodyFileContent: '{}' }, calls)
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith(code)))

      const r1 = await upgradeFetch(URL_A, { proxyUrl: PUBLIC_PROXY })
      expect(r1.usedEngine).toBe('curl')
      expect(getEnginePreference()).toBe('curl')

      // 第二次调用：fetch 若被调用即抛错——flag 已置应跳过 undici
      const fetchMustNotRun = vi.fn(() => {
        throw new Error('undici should be skipped after flag set')
      })
      vi.stubGlobal('fetch', fetchMustNotRun)
      const r2 = await upgradeFetch(URL_A)
      expect(r2.usedEngine).toBe('curl')
      expect(fetchMustNotRun).not.toHaveBeenCalled()
    },
  )

  it('U1-D4 UND_ERR_CONNECT_TIMEOUT 置 flag（授权拦截丢包型与拒绝型同源同档）', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '204' }, calls)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(fetchFailedWith('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error')),
    )

    const result = await upgradeFetch(URL_A)

    expect(result.usedEngine).toBe('curl')
    expect(getEnginePreference()).toBe('curl')
  })

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])(
    'U1-D4 瞬时类 %s 仅本次降级不置 flag，第二次调用仍先试 undici',
    async (code) => {
      const calls: CurlCall[] = []
      installFakeCurl({ httpCode: '200' }, calls)
      const fetchMock = vi.fn().mockRejectedValue(fetchFailedWith(code))
      vi.stubGlobal('fetch', fetchMock)

      const r1 = await upgradeFetch(URL_A)
      expect(r1.usedEngine).toBe('curl')
      expect(getEnginePreference()).toBe('undici')

      const r2 = await upgradeFetch(URL_A)
      expect(r2.usedEngine).toBe('curl')
      expect(fetchMock).toHaveBeenCalledTimes(2) // flag 未置：第二次仍重探 undici
    },
  )

  it('U1-D4 probe 组合：method HEAD + ECONNRESET 瞬时降级 → usedEngine=curl 且不置 flag（设计 §4 覆盖清单逐字项）', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200', headerFileContent: OK_HEADERS }, calls)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('ECONNRESET')))

    const result = await upgradeFetch(URL_A, { method: 'HEAD' })

    // probe 场景专属组合：HEAD 请求遇瞬时类错误 → 本次降级 curl 成功
    expect(result.usedEngine).toBe('curl')
    expect(result.bodyText).toBeUndefined() // HEAD 无 body 语义保持
    // 瞬时类不置 flag：下次 probe 仍重探 undici 多段（update-network-resilience D7 语义的前提）
    expect(getEnginePreference()).toBe('undici')
    // curl 侧同为 HEAD 形态（-I），probe 降级不改变请求语义
    expect(calls[0].args).toContain('-I')
  })

  it('U1-D4 流中断 UND_ERR_SOCKET（body 读取阶段）降级不置 flag', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    const socketErr = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        fakeResponse({
          ok: true,
          status: 200,
          textReject: new TypeError('terminated', { cause: socketErr }),
        }),
      ),
    )

    const result = await upgradeFetch(URL_A)

    expect(result.usedEngine).toBe('curl')
    expect(getEnginePreference()).toBe('undici')
  })

  it.each(['ENOSPC', 'EACCES'])('U1-D4 磁盘错误 %s 不降级原样上抛', async (code) => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    const diskErr = fetchFailedWith(code)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(diskErr))

    await expect(upgradeFetch(URL_A)).rejects.toBe(diskErr) // 原始错误同引用上抛
    expect(calls).toHaveLength(0)
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
  })

  it('U1-D4 AbortError 总超时不降级（fake timers 驱动 AbortController）', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, opts: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
            })
          }),
      ),
    )

    const promise = upgradeFetch(URL_A, { timeoutMs: 5_000 })
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion

    expect(calls).toHaveLength(0) // 总预算耗尽不换引擎
    expect(getEnginePreference()).toBe('undici')
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
  })
})

// ─── 验收①：D5 引擎记忆选项 ──────────────────────────────────────

describe('U1-engine-memory', () => {
  it('U1-D5 disableFlagPersistence 不置 flag（testProxy 探针不污染进程记忆）', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    const r1 = await upgradeFetch(URL_A, { disableFlagPersistence: true })
    expect(r1.usedEngine).toBe('curl')
    expect(getEnginePreference()).toBe('undici') // 未置位

    // 第二次（参与置位的普通调用）应先试 undici
    const fetchMock = vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH'))
    vi.stubGlobal('fetch', fetchMock)
    await upgradeFetch(URL_A)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('U1-D5 disableFlagPersistence 不读 flag（flag 已置仍试 undici）', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    // 第一步：普通调用置 flag
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))
    await upgradeFetch(URL_A)
    expect(getEnginePreference()).toBe('curl')

    // 第二步：声明不参与置位的调用仍走 undici
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200, body: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)
    const r2 = await upgradeFetch(URL_A, { disableFlagPersistence: true })
    expect(r2.usedEngine).toBe('undici')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('U1-D5 markEnginePreferenceFromUndiciFailure 仅连接建立失败档置位', () => {
    expect(markEnginePreferenceFromUndiciFailure(fetchFailedWith('ENOTFOUND'))).toBe(false)
    expect(getEnginePreference()).toBe('undici')
    expect(markEnginePreferenceFromUndiciFailure(fetchFailedWith('ECONNREFUSED'))).toBe(true)
    expect(getEnginePreference()).toBe('curl')
  })
})

// ─── undici 引擎行为 ──────────────────────────────────────────────

describe('U1-undici-engine', () => {
  it('U1-undici GET 成功返回 bodyText 与 headers，不触发 curl 与落盘', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"v":1}' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await upgradeFetch(URL_A, { headers: { Accept: 'application/vnd.github+json' } })

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      usedEngine: 'undici',
      bodyText: '{"v":1}',
    })
    expect(result.headers['content-type']).toBe('application/json')
    expect(calls).toHaveLength(0)
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()

    const opts = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: ProxyAgent }
    expect(opts.method).toBe('GET')
    expect(opts.headers).toMatchObject({
      'User-Agent': 'taiji-updater',
      Accept: 'application/vnd.github+json',
    })
    expect(opts.dispatcher).toBeUndefined() // 无代理不挂 dispatcher
  })

  it('U1-undici HEAD 成功返回 headers 无 bodyText', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ ok: true, status: 200, headers: { 'accept-ranges': 'bytes' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await upgradeFetch(URL_A, { method: 'HEAD' })

    expect(result.usedEngine).toBe('undici')
    expect(result.bodyText).toBeUndefined()
    expect(result.headers['accept-ranges']).toBe('bytes')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('HEAD')
  })

  it('U1-undici 有代理时构造 ProxyAgent dispatcher（对齐 buildFetchOptions）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse({ ok: true, status: 200, body: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await upgradeFetch(URL_A, { proxyUrl: PUBLIC_PROXY })

    expect(result.usedEngine).toBe('undici')
    const opts = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: ProxyAgent }
    expect(opts.dispatcher).toBeInstanceOf(ProxyAgent)
  })
})

// ─── curl 引擎行为（D6 规格） ─────────────────────────────────────

describe('U1-curl-engine', () => {
  function primeUndiciFailure(calls: CurlCall[], spec: FakeCurlSpec): void {
    installFakeCurl(spec, calls)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))
  }

  it('U1-curl GET 成功：headers/body 分文件解析、usedEngine=curl', async () => {
    const calls: CurlCall[] = []
    primeUndiciFailure(calls, {
      httpCode: '200',
      headerFileContent: OK_HEADERS,
      bodyFileContent: '{"sha256":"abc"}',
    })

    const result = await upgradeFetch(URL_A, { proxyUrl: PUBLIC_PROXY })

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      usedEngine: 'curl',
      bodyText: '{"sha256":"abc"}',
    })
    expect(result.headers['content-type']).toBe('application/json')
    expect(result.headers.etag).toBe('"abc"')

    const { cmd, args } = calls[0]
    expect(cmd).toBe(process.platform === 'darwin' ? '/usr/bin/curl' : 'curl')
    // D6 必含 flags
    for (const flag of ['-f', '-L', '-w', '%{http_code}', '--connect-timeout', '10', '-D', '-o', '-x']) {
      expect(args).toContain(flag)
    }
    expect(args).toContain(PUBLIC_PROXY)
    expect(args).toContain('-H')
    expect(args).toContain('User-Agent: taiji-updater')
    expect(args).toContain('--max-time')
    expect(args).toContain('30') // 默认 timeoutMs 30s 派生
    expect(args[args.length - 1]).toBe(URL_A) // URL 在参数末尾
  })

  it('U1-curl HEAD：-I -L 且无 -o（无 body 文件）', async () => {
    const calls: CurlCall[] = []
    primeUndiciFailure(calls, { httpCode: '200', headerFileContent: OK_HEADERS })

    const result = await upgradeFetch(URL_A, { method: 'HEAD' })

    expect(result.usedEngine).toBe('curl')
    expect(result.bodyText).toBeUndefined()
    const args = calls[0].args
    expect(args).toContain('-I')
    expect(args).toContain('-L')
    expect(args).toContain('-f')
    expect(args).not.toContain('-o')
  })

  it('U1-curl timeoutMs 派生 --max-time 秒数（向上取整）', async () => {
    const calls: CurlCall[] = []
    primeUndiciFailure(calls, { httpCode: '200' })

    await upgradeFetch(URL_A, { timeoutMs: 5_500 })

    const maxTimeIdx = calls[0].args.indexOf('--max-time')
    expect(calls[0].args[maxTimeIdx + 1]).toBe('6')
  })

  it('U1-curl 无代理时不含 -x', async () => {
    const calls: CurlCall[] = []
    primeUndiciFailure(calls, { httpCode: '200' })

    await upgradeFetch(URL_A)

    expect(calls[0].args).not.toContain('-x')
  })

  it('U1-curl -L 多跳重定向时 headers 取最后一组', async () => {
    const calls: CurlCall[] = []
    const twoHops = [
      'HTTP/1.1 302 Found',
      'Location: https://cdn.example.com/file',
      '',
      'HTTP/1.1 200 OK',
      'Content-Type: application/octet-stream',
    ].join('\r\n')
    primeUndiciFailure(calls, { httpCode: '200', headerFileContent: twoHops })

    const result = await upgradeFetch(URL_A)

    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('application/octet-stream')
    expect(result.headers.location).toBeUndefined() // 第一跳的头不进最终语义
  })

  it('U1-curl 临时文件用后清理', async () => {
    const calls: CurlCall[] = []
    let headerPath = ''
    let bodyPath = ''
    __setCurlRunnerForTest((cmd, args) => {
      calls.push({ cmd, args })
      headerPath = args[args.indexOf('-D') + 1]
      bodyPath = args[args.indexOf('-o') + 1]
      writeFileSync(headerPath, OK_HEADERS, 'utf-8')
      writeFileSync(bodyPath, 'x', 'utf-8')
      return { exitCode: 0, stdout: '200', stderr: '' }
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    await upgradeFetch(URL_A)

    expect(existsSync(headerPath)).toBe(false)
    expect(existsSync(bodyPath)).toBe(false)
  })
})

// ─── 验收②：curl exit code 映射（D8） ────────────────────────────

describe('U1-curl-exit-code-mapping', () => {
  it.each([
    [7, 'connection-failed'],
    [28, 'timeout'],
    [33, 'range-error'],
    [35, 'ssl-error'],
    [56, 'receive-error'],
    [22, 'http-error'],
  ])('U1-exit-%s 映射为 kind=%s', async (exitCode, kind) => {
    installFakeCurl({ exitCode, httpCode: exitCode === 22 ? '403' : '000' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    const err = await upgradeFetch(URL_A).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CurlFetchError)
    const curlErr = err as CurlFetchError
    expect(curlErr.exitCode).toBe(exitCode)
    expect(curlErr.kind).toBe(kind)
    expect(appendUpdateErrorMock).not.toHaveBeenCalled() // curl 未兜住不落 engine-fallback
  })

  it('U1-exit-22 携带 -w 解析的最终状态码（D6：exit 22 时仍输出 http_code）', async () => {
    installFakeCurl({ exitCode: 22, httpCode: '403' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    const err = await upgradeFetch(URL_A).catch((e: unknown) => e)

    expect((err as CurlFetchError).httpStatusCode).toBe(403)
    expect((err as CurlFetchError).message).toContain('403')
  })

  it('U1-exit-unknown 未知退出码映射 kind=unknown', async () => {
    installFakeCurl({ exitCode: 1 })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    const err = await upgradeFetch(URL_A).catch((e: unknown) => e)

    expect((err as CurlFetchError).kind).toBe('unknown')
  })

  it('U1-spawn-ENOENT 映射 kind=spawn-failed 并携带 errno（D10 第三步判定依据）', async () => {
    installFakeCurl({ spawnError: { code: 'ENOENT', message: 'spawn curl ENOENT' } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    const err = await upgradeFetch(URL_A).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CurlFetchError)
    const curlErr = err as CurlFetchError
    expect(curlErr.kind).toBe('spawn-failed')
    expect(curlErr.spawnErrorCode).toBe('ENOENT')
  })

  it('U1-curl 失败时 CurlFetchError 携带触发降级的 undiciError（双失败报 undici 分类的依据，D8）', async () => {
    installFakeCurl({ exitCode: 7 })
    const undiciErr = fetchFailedWith('EHOSTUNREACH')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(undiciErr))

    const err = await upgradeFetch(URL_A).catch((e: unknown) => e)

    expect((err as CurlFetchError).undiciError).toBe(undiciErr) // 同引用
  })

  it('U1-flag 置位后的直连 curl 失败不携带 undiciError（无 undici 上下文）', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))
    await upgradeFetch(URL_A) // 置 flag
    expect(getEnginePreference()).toBe('curl')

    // flag 路径：curl 失败
    installFakeCurl({ exitCode: 28 })
    const err = await upgradeFetch(URL_A).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CurlFetchError)
    expect((err as CurlFetchError).undiciError).toBeUndefined()
  })
})

// ─── 验收③：降级点落盘 ───────────────────────────────────────────

describe('U1-engine-fallback-log', () => {
  it('U1-fallback undici 失败被 curl 兜住时落盘 source=engine-fallback + engine=undici', async () => {
    const calls: CurlCall[] = []
    installFakeCurl({ httpCode: '200' }, calls)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    const result = await upgradeFetch(URL_A, { proxyUrl: PUBLIC_PROXY })

    expect(result.usedEngine).toBe('curl')
    expect(appendUpdateErrorMock).toHaveBeenCalledTimes(1)
    const entry = appendUpdateErrorMock.mock.calls[0]?.[0]
    expect(entry.source).toBe('engine-fallback')
    expect(entry.engine).toBe('undici')
    expect(entry.errorCode).toBe('UPDATE_NETWORK_FAILED') // 公网代理 EHOSTUNREACH 分类
    expect(entry.stage).toBe('downloading')
    expect(entry.proxyUrl).toBe(PUBLIC_PROXY) // 无凭证脱敏后原样
  })

  it('U1-fallback undici 成功路径不落盘', async () => {
    installFakeCurl({ httpCode: '200' }, [])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200 })))

    await upgradeFetch(URL_A)

    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'darwin')(
    'U1-fallback darwin 私网代理 EHOSTUNREACH 落盘 UPDATE_PROXY_UNREACHABLE 分类',
    async () => {
      installFakeCurl({ httpCode: '200' }, [])
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

      await upgradeFetch(URL_A, { proxyUrl: 'http://192.168.1.202:7890' })

      const entry = appendUpdateErrorMock.mock.calls[0]?.[0]
      expect(entry.errorCode).toBe('UPDATE_PROXY_UNREACHABLE')
    },
  )

  it('U1-fallback 含凭证的代理 URL 落盘前脱敏', async () => {
    installFakeCurl({ httpCode: '200' }, [])
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    await upgradeFetch(URL_A, { proxyUrl: 'http://user:secret@1.2.3.4:8080' })

    const entry = appendUpdateErrorMock.mock.calls[0]?.[0]
    // stripCredential（proxy-config SSOT）经 URL 重建剥凭证，尾斜杠为其规范化行为
    expect(entry.proxyUrl).toBe('http://1.2.3.4:8080/')
    expect(String(entry.proxyUrl)).not.toContain('secret')
  })

  it('U1-fallback rawCause 保留 undici 最内层 cause', async () => {
    installFakeCurl({ httpCode: '200' }, [])
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchFailedWith('EHOSTUNREACH')))

    await upgradeFetch(URL_A)

    const entry = appendUpdateErrorMock.mock.calls[0]?.[0]
    expect(entry.rawCause).toBe('connect failed')
  })
})

// ─── classifyUndiciFailure 直测（D4 分类函数） ────────────────────

describe('U1-classifyUndiciFailure', () => {
  it.each(['EHOSTUNREACH', 'ECONNREFUSED', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])(
    'U1-classify %s → connect-establishment',
    (code) => {
      expect(classifyUndiciFailure(fetchFailedWith(code))).toBe('connect-establishment')
    },
  )

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])('U1-classify %s → transient', (code) => {
    expect(classifyUndiciFailure(fetchFailedWith(code))).toBe('transient')
  })

  it.each(['UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT'])(
    'U1-classify %s → stream-interrupted',
    (code) => {
      expect(classifyUndiciFailure(fetchFailedWith(code))).toBe('stream-interrupted')
    },
  )

  it('U1-classify 磁盘 / AbortError / 未知 → non-fallback', () => {
    expect(classifyUndiciFailure(fetchFailedWith('ENOSPC'))).toBe('non-fallback')
    expect(classifyUndiciFailure(fetchFailedWith('EACCES'))).toBe('non-fallback')
    expect(
      classifyUndiciFailure(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
    ).toBe('non-fallback')
    expect(classifyUndiciFailure(new Error('something weird'))).toBe('non-fallback')
    expect(classifyUndiciFailure('not an error')).toBe('non-fallback')
  })
})
