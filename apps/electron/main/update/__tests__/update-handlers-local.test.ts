/**
 * update-network-resilience u6-handlers 验收测试：gateway update-handlers 的四项接入。
 *
 * 覆盖（update 网络韧性设计）：
 *   - D1 短路①②：update:download 入口本地短路（preloaded 严格同版本 / pending 认领），
 *     断网（resolveByVersion 抛网络错）场景零网络返回 downloaded；版本严格相等反例
 *     （preloaded 0.9.12 vs 请求 0.9.11 不短路，继续原链）
 *   - D1 启动恢复链：update:getPreloaded miss 后认领（全本地），命中后重读返回
 *   - D2 交错缓解：update:install 响应增加实装 version 字段
 *   - D5/D8 testProxy 双引擎：undici 失败被 curl 兜住 → success:true（且探针不置
 *     enginePreference）；双失败 → undici 侧分类文案（含 D2 v3 修订的 EHOSTUNREACH 覆写）；
 *     D8 curl HTTP 状态错误（exit 22 携带 httpStatusCode）→ success:true 不落盘不报错；
 *     双失败落盘补 engine 诊断字段（CurlFetchError=curl 侧 / 原样上抛=仅 undici）
 *
 * Mock 策略（对齐 test/update-handlers-orchestration.test.ts 范式）：
 *   - electron：ipcMain.handle 捕获 handler 到 Map + app.getVersion='0.8.14'
 *   - pending-update / preloaded-update / manual-claim / error-log：vi.mock 全量桩
 *     （纯 mock 交互断言，不触真实 fs）
 *   - upgrade-fetch：**保留真实模块**（testProxy 用例经其测试钩子
 *     __setCurlRunnerForTest 注入假 curl + stub 全局 fetch 模拟 undici，不真实联网）
 *
 * 运行：cd apps/electron/main && npx vitest run update/__tests__/update-handlers-local.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LatestReleaseInfo } from '@taiji/shared'

// ── 捕获注册的 handler（key=channel, value=handler fn）──────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
  app: {
    getVersion: vi.fn(() => '0.8.14'),
    quit: vi.fn(),
  },
}))

// ── FS 依赖模块全量 mock（纯 mock 交互断言，不触真实 fs）──────────────
const pendingMocks = vi.hoisted(() => ({
  writePendingUpdate: vi.fn<(release: LatestReleaseInfo) => void>(),
  readPendingUpdate: vi.fn<(currentVersion: string) => LatestReleaseInfo | null>(),
}))
vi.mock('../pending-update.js', () => ({
  writePendingUpdate: pendingMocks.writePendingUpdate,
  readPendingUpdate: pendingMocks.readPendingUpdate,
  clearPendingUpdate: vi.fn(),
}))

const preloadedMocks = vi.hoisted(() => ({
  writePreloadedUpdate: vi.fn<(release: LatestReleaseInfo, filePath: string) => void>(),
  readPreloadedUpdate: vi.fn<(release: LatestReleaseInfo) => Promise<string | null>>(),
  readPreloadedUpdateRaw: vi.fn<
    (currentVersion: string) => Promise<{ release: LatestReleaseInfo; filePath: string } | null>
  >(),
  clearPreloadedUpdate: vi.fn(),
}))
vi.mock('../preloaded-update.js', () => ({
  writePreloadedUpdate: preloadedMocks.writePreloadedUpdate,
  readPreloadedUpdate: preloadedMocks.readPreloadedUpdate,
  readPreloadedUpdateRaw: preloadedMocks.readPreloadedUpdateRaw,
  clearPreloadedUpdate: preloadedMocks.clearPreloadedUpdate,
}))

const claimMocks = vi.hoisted(() => ({
  tryClaimManualAsset: vi.fn<(release: LatestReleaseInfo) => Promise<string | null>>(),
}))
vi.mock('../manual-claim.js', () => ({
  tryClaimManualAsset: claimMocks.tryClaimManualAsset,
  getManualAssetDir: () => '/tmp/manual-claim-test/manual',
}))

const errorLogMocks = vi.hoisted(() => ({
  appendUpdateError: vi.fn<(entry: Record<string, unknown>) => void>(),
}))
vi.mock('../error-log.js', () => ({
  appendUpdateError: errorLogMocks.appendUpdateError,
}))

import { registerUpdateHandlers } from '../../gateway/update-handlers.js'
import type { IUpdateOrchestrator } from '../orchestrator.js'
import { UpdateError } from '../types.js'
// testProxy 用例保留真实 upgradeFetch（经其测试钩子注入假 curl，不真实联网）
import { __setCurlRunnerForTest, resetEnginePreferenceForTest, getEnginePreference } from '../upgrade-fetch.js'

/**
 * LatestReleaseInfo fixture：必须通过 validateRelease 校验（install 路径会校验）。
 * version=0.9.11（待升级版本，当前 app 版本 mock 为 0.8.14）。
 */
const FIXTURE: LatestReleaseInfo = {
  version: '0.9.11',
  tagName: 'v0.9.11',
  releaseNotes: '## changes',
  publishedAt: '2025-12-01T00:00:00Z',
  htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.11',
  assets: {
    macArm64Dmg: {
      name: 'TaiJi-mac-arm64.dmg',
      downloadUrl:
        'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.11/TaiJi-mac-arm64.dmg',
      size: 1000,
      sha256: 'a'.repeat(64),
    },
  },
}

// 桩 main window + webContents.send（验证短路不推 update:progress 事件）
const sendSpy = vi.fn()
const mockMainWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: { send: sendSpy },
}

/** 构造 mock orchestrator：默认 resolveByVersion/downloadUpdate 正常完成（可覆写） */
function mockOrchestrator(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    resolveByVersion: vi.fn(async () => FIXTURE),
    downloadUpdate: vi.fn(async () => ({ filePath: '/tmp/dl.zip' })),
    installUpdate: vi.fn(async () => ({ triggerRestart: false })),
    ...overrides,
  } as unknown as IUpdateOrchestrator & Record<string, ReturnType<typeof vi.fn>>
}

/** 注册 handler（download/install 用例共用注入形态） */
function registerWith(orch: unknown): void {
  registerUpdateHandlers({
    updateOrchestrator: orch,
    releaseChecker: { checkForLatestRelease: vi.fn(async () => null) },
    getMainWindow: () => mockMainWindow as never,
  } as never)
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  sendSpy.mockClear()
  // 各 SSOT mock 默认值（mockResolvedValue 覆盖前序用例的实现）
  pendingMocks.readPendingUpdate.mockReturnValue(null)
  preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue(null)
  preloadedMocks.readPreloadedUpdate.mockResolvedValue(null)
  claimMocks.tryClaimManualAsset.mockResolvedValue(null)
})

// ════════════════════════════════════════════════════════════════
// D1：update:download 入口本地短路①②
// ════════════════════════════════════════════════════════════════
describe('u6 D1: update:download 本地短路', () => {
  it('断网场景：resolveByVersion 抛网络错 + 认领命中 → downloaded:true 且不触网络链（未调 resolveByVersion/downloadUpdate）', async () => {
    // 断网语义：resolveByVersion（网络前置依赖）若被触达必然抛错——用它作「短路必须前置于它」的哨兵
    const orch = mockOrchestrator({
      resolveByVersion: vi.fn(async () => {
        throw new UpdateError('fetch failed', 'downloading', 'UPDATE_NETWORK_FAILED')
      }),
    })
    registerWith(orch)

    // 短路① miss（无 preloaded）；短路② 命中：pending 版本与请求严格相等 + manual 目录有匹配产物
    pendingMocks.readPendingUpdate.mockReturnValue(FIXTURE)
    claimMocks.tryClaimManualAsset.mockResolvedValue('/tmp/taiji-update/TaiJi-mac-arm64.dmg')

    const handler = handlers.get('update:download')!
    const result = await handler({}, { version: '0.9.11' })

    expect(result).toEqual({ downloaded: true })
    // 全本地：网络解析与下载均未被触达
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).resolveByVersion).not.toHaveBeenCalled()
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).downloadUpdate).not.toHaveBeenCalled()
    // 认领以 pending release 为基准（D3）
    expect(claimMocks.tryClaimManualAsset).toHaveBeenCalledTimes(1)
    expect(claimMocks.tryClaimManualAsset).toHaveBeenCalledWith(FIXTURE)
    // 短路不触发下载进度事件
    expect(sendSpy).not.toHaveBeenCalledWith('update:progress', expect.anything())
  })

  it('短路①：preloaded 与请求版本严格相等 → downloaded:true，不触 resolveByVersion / 认领 / 下载', async () => {
    const orch = mockOrchestrator()
    registerWith(orch)
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({
      release: FIXTURE,
      filePath: '/tmp/preloaded.zip',
    })

    const handler = handlers.get('update:download')!
    const result = await handler({}, { version: '0.9.11' })

    expect(result).toEqual({ downloaded: true })
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).resolveByVersion).not.toHaveBeenCalled()
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).downloadUpdate).not.toHaveBeenCalled()
    expect(claimMocks.tryClaimManualAsset).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalledWith('update:progress', expect.anything())
  })

  it('短路①版本严格相等反例：preloaded 0.9.12 vs 请求 0.9.11 → 不短路，继续原链走到 resolveByVersion', async () => {
    const orch = mockOrchestrator()
    registerWith(orch)
    // preloaded 有效但版本不同（0.9.12 > 当前 0.8.14，readPreloadedUpdateRaw 语义内有效）
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({
      release: { ...FIXTURE, version: '0.9.12' },
      filePath: '/tmp/preloaded-0912.zip',
    })
    // pending null：短路② 无基准不触发
    pendingMocks.readPendingUpdate.mockReturnValue(null)

    const handler = handlers.get('update:download')!
    const result = await handler({}, { version: '0.9.11' })

    // 继续原链：resolveByVersion 被调（请求版本透传），完整下载后返回 downloaded
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).resolveByVersion).toHaveBeenCalledTimes(1)
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).resolveByVersion.mock.calls[0][0]).toBe('0.9.11')
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).downloadUpdate).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ downloaded: true })
  })

  it('短路②认领 miss（返回 null）→ 静默继续原链（走网络下载），不误报错误', async () => {
    const orch = mockOrchestrator()
    registerWith(orch)
    pendingMocks.readPendingUpdate.mockReturnValue(FIXTURE)
    claimMocks.tryClaimManualAsset.mockResolvedValue(null) // manual/ 无候选或校验失败

    const handler = handlers.get('update:download')!
    const result = await handler({}, { version: '0.9.11' })

    expect(claimMocks.tryClaimManualAsset).toHaveBeenCalledTimes(1)
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).resolveByVersion).toHaveBeenCalledTimes(1)
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).downloadUpdate).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ downloaded: true })
  })

  it('短路②认领抛异常（并发 fs 竞态）→ 不阻断升级，继续原链', async () => {
    const orch = mockOrchestrator()
    registerWith(orch)
    pendingMocks.readPendingUpdate.mockReturnValue(FIXTURE)
    claimMocks.tryClaimManualAsset.mockRejectedValue(new Error('ENOENT race'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handler = handlers.get('update:download')!
    const result = await handler({}, { version: '0.9.11' })

    expect(result).toEqual({ downloaded: true })
    expect((orch as Record<string, ReturnType<typeof vi.fn>>).downloadUpdate).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ════════════════════════════════════════════════════════════════
// D1 启动恢复链：update:getPreloaded miss 后认领
// ════════════════════════════════════════════════════════════════
describe('u6 D1: update:getPreloaded miss 后认领', () => {
  it('preloaded miss + pending 有效 + 认领命中 → 重读 preloaded 返回标准形状（全本地）', async () => {
    registerWith(mockOrchestrator())
    // 第一次读 miss，认领写登记后重读命中
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({
      release: FIXTURE,
      filePath: '/tmp/taiji-update/TaiJi-mac-arm64.dmg',
    })
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValueOnce(null)
    pendingMocks.readPendingUpdate.mockReturnValue(FIXTURE)
    claimMocks.tryClaimManualAsset.mockResolvedValue('/tmp/taiji-update/TaiJi-mac-arm64.dmg')

    const handler = handlers.get('update:getPreloaded')!
    const result = await handler({}, {})

    // 认领以 pending 为基准（启动链无请求版本可比，D3）
    expect(claimMocks.tryClaimManualAsset).toHaveBeenCalledWith(FIXTURE)
    // 重读 preloaded 返回 { release, filePath }（两次读均传 app.getVersion）
    expect(preloadedMocks.readPreloadedUpdateRaw).toHaveBeenCalledTimes(2)
    expect(preloadedMocks.readPreloadedUpdateRaw).toHaveBeenNthCalledWith(1, '0.8.14')
    expect(preloadedMocks.readPreloadedUpdateRaw).toHaveBeenNthCalledWith(2, '0.8.14')
    expect(result).toEqual({ release: FIXTURE, filePath: '/tmp/taiji-update/TaiJi-mac-arm64.dmg' })
  })

  it('preloaded miss + pending null（常态）→ 返回 null，不触认领', async () => {
    registerWith(mockOrchestrator())
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue(null)
    pendingMocks.readPendingUpdate.mockReturnValue(null)

    const handler = handlers.get('update:getPreloaded')!
    const result = await handler({}, {})

    expect(result).toBeNull()
    expect(claimMocks.tryClaimManualAsset).not.toHaveBeenCalled()
  })

  it('preloaded miss + 认领 miss → 返回 null（静默，不误报）', async () => {
    registerWith(mockOrchestrator())
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue(null)
    pendingMocks.readPendingUpdate.mockReturnValue(FIXTURE)
    claimMocks.tryClaimManualAsset.mockResolvedValue(null)

    const handler = handlers.get('update:getPreloaded')!
    const result = await handler({}, {})

    expect(claimMocks.tryClaimManualAsset).toHaveBeenCalledTimes(1)
    expect(result).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════
// D2 交错缓解：update:install 响应增加实装 version 字段
// ════════════════════════════════════════════════════════════════
describe('u6 D2: update:install 响应含实装 version', () => {
  /** 捕获 setTimeout（triggerRestart 后的延迟 quit），不实际执行 */
  let capturedQuitTimer: { delay: number } | null = null

  beforeEach(() => {
    capturedQuitTimer = null
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, delay?: number) => {
      capturedQuitTimer = { delay: delay ?? 0 }
      return 0 as unknown as NodeJS.Timeout
    }) as typeof setTimeout)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('install 成功 → 返回 { triggerRestart, version }（version = preloaded release.version）', async () => {
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({
      release: FIXTURE,
      filePath: '/tmp/preloaded.zip',
    })
    const installUpdate = vi.fn(async () => ({ triggerRestart: true }))
    const orch = mockOrchestrator({ installUpdate })
    registerWith(orch)

    const handler = handlers.get('update:install')!
    const result = await handler({}, {})

    expect(result).toEqual({ triggerRestart: true, version: '0.9.11' })
    expect(installUpdate).toHaveBeenCalledWith(FIXTURE, '/tmp/preloaded.zip', expect.any(Function))
    // triggerRestart=true → 仍安排 500ms 延迟 quit（既有不变量不回归）
    expect(capturedQuitTimer).not.toBeNull()
    expect(capturedQuitTimer!.delay).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════
// D5/D8：update:testProxy 双引擎
// 真实 upgradeFetch + __setCurlRunnerForTest 假 curl + stub 全局 fetch 模拟 undici
// ════════════════════════════════════════════════════════════════
describe('u6 D5/D8: update:testProxy 双引擎', () => {
  const originalPlatform = process.platform
  /** 构造 undici 连接建立失败形态（EHOSTUNREACH，D4 第一档：若参与置位则会置 curl） */
  function undiciEhostUnreachable(): Error {
    const cause = Object.assign(new Error('connect EHOSTUNREACH 192.168.1.202:7890'), {
      code: 'EHOSTUNREACH',
    })
    return new Error('fetch failed', { cause })
  }

  beforeEach(() => {
    // 分类断言锁定 darwin（classifyProxyUnreachable 的 EHOSTUNREACH+私网分支仅 darwin 成立）
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    resetEnginePreferenceForTest()
    registerUpdateHandlers({} as never)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    __setCurlRunnerForTest(undefined)
    resetEnginePreferenceForTest()
    vi.unstubAllGlobals()
  })

  it('undici 失败（EHOSTUNREACH）被 curl 兜住 → success:true，且探针不置 enginePreference（disableFlagPersistence）', async () => {
    // undici 引擎：连接建立失败（D4 第一档，正常会置 flag——testProxy 声明不参与置位）。
    // 显式声明 fetch 形参类型，mock.calls 才有正确的 (input, init) 元组形状
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw undiciEhostUnreachable()
    })
    vi.stubGlobal('fetch', fetchSpy)
    // curl 引擎：假 runner 模拟成功（HEAD + -w '%{http_code}' 输出 200）
    const curlRunner = vi.fn(() => ({ exitCode: 0, stdout: '200', stderr: '' }))
    __setCurlRunnerForTest(curlRunner)

    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, {
      mode: 'manual',
      httpProxy: 'http://192.168.1.202:7890',
      httpsProxy: 'http://192.168.1.202:7890',
    })

    // D8：单引擎失败被另一引擎兜住 → 用户看到成功（curl 能走 = 能升级）
    expect(result).toEqual({ success: true })
    // 双引擎确实各跑了一次：undici HEAD 到 github.com + curl 兜底
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://github.com')
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe('HEAD')
    expect(curlRunner).toHaveBeenCalledTimes(1)
    // D5：试错探针不污染进程级引擎记忆（EHOSTUNREACH 属连接建立失败档，置位被 disable 抑制）
    expect(getEnginePreference()).toBe('undici')
  })

  it('undici 直接成功 → success:true，不触 curl（回归：无降级开销）', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const curlRunner = vi.fn(() => ({ exitCode: 0, stdout: '200', stderr: '' }))
    __setCurlRunnerForTest(curlRunner)

    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, {
      mode: 'manual',
      httpProxy: 'http://192.168.1.202:7890',
      httpsProxy: 'http://192.168.1.202:7890',
    })

    expect(result).toEqual({ success: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(curlRunner).not.toHaveBeenCalled()
    expect(getEnginePreference()).toBe('undici')
  })

  it('双失败（undici EHOSTUNREACH 私网 + curl exit 7）→ 报 undici 侧分类 UPDATE_PROXY_UNREACHABLE + 落盘 test-proxy', async () => {
    const fetchSpy = vi.fn(async () => {
      throw undiciEhostUnreachable()
    })
    vi.stubGlobal('fetch', fetchSpy)
    __setCurlRunnerForTest(() => ({ exitCode: 7, stdout: '', stderr: 'curl: (7) Failed to connect' }))

    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, {
      mode: 'manual',
      httpProxy: 'http://192.168.1.202:7890',
      httpsProxy: 'http://192.168.1.202:7890',
    })

    // D8：双引擎均失败报 undici 错误分类（curl exit 7 无 errno 级区分，不抢分类权）
    expect(result).toMatchObject({
      success: false,
      code: 'UPDATE_PROXY_UNREACHABLE',
      message: '无法连接代理 (EHOSTUNREACH)',
    })
    // D7：落盘 source=test-proxy，code 维持原分类（与下载路径归因一致）；
    // engine 诊断字段：CurlFetchError = curl 侧失败形态（双引擎均失败）
    expect(errorLogMocks.appendUpdateError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'test-proxy', errorCode: 'UPDATE_PROXY_UNREACHABLE', engine: 'curl' }),
    )
  })

  it('D8: curl 引擎 HTTP 状态错误（exit 22 携带 httpStatusCode）→ 代理可达返回 success:true，不落盘不报错', async () => {
    // undici 连接失败降级 curl → curl -f 拿到 HTTP 403（服务器已响应）以上抛形态
    // 结束——「任何 HTTP 响应算代理可用」准绳在 curl 引擎下同样成立
    const fetchSpy = vi.fn(async () => {
      throw undiciEhostUnreachable()
    })
    vi.stubGlobal('fetch', fetchSpy)
    const curlRunner = vi.fn(() => ({
      exitCode: 22,
      stdout: '403',
      stderr: 'curl: (22) The requested URL returned error: 403',
    }))
    __setCurlRunnerForTest(curlRunner)

    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, {
      mode: 'manual',
      httpProxy: 'http://192.168.1.202:7890',
      httpsProxy: 'http://192.168.1.202:7890',
    })

    // HTTP 状态 = 代理链路可用（服务器返回了状态）：与 undici 路径任何 resolve 算成功等价
    expect(result).toEqual({ success: true })
    expect(curlRunner).toHaveBeenCalledTimes(1)
    // 不落盘、不报错（区别于双引擎网络失败）
    expect(errorLogMocks.appendUpdateError).not.toHaveBeenCalled()
    expect(getEnginePreference()).toBe('undici')
  })

  it('双失败但仅 undici 侧失败（AbortError 非降级类原样上抛）→ 落盘 engine=undici', async () => {
    // AbortError 总超时属 D4 不降级档：curl 从未执行，错误原样上抛为 undici 形态
    const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    const fetchSpy = vi.fn(async () => {
      throw abortErr
    })
    vi.stubGlobal('fetch', fetchSpy)
    const curlRunner = vi.fn(() => ({ exitCode: 0, stdout: '200', stderr: '' }))
    __setCurlRunnerForTest(curlRunner)

    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, {
      mode: 'manual',
      httpProxy: 'http://192.168.1.202:7890',
      httpsProxy: 'http://192.168.1.202:7890',
    })

    // 分类走 undici 侧（UPDATE_NETWORK_TIMEOUT），curl 未被触发
    expect(result).toMatchObject({ success: false, code: 'UPDATE_NETWORK_TIMEOUT' })
    // 泛化 timeout 形态（F1 分流）→ 中性超时话术：无下载语境，不给停滞/续传文案
    expect(result).toMatchObject({ message: '连接或响应超时', suggestion: '请检查网络连接是否稳定，或尝试配置代理服务器' })
    expect(curlRunner).not.toHaveBeenCalled()
    // engine 诊断字段：非 CurlFetchError 上抛形态 = 仅 undici 失败
    expect(errorLogMocks.appendUpdateError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'test-proxy', engine: 'undici' }),
    )
  })

  it('双失败（公网代理 EHOSTUNREACH）→ UPDATE_NETWORK_FAILED 被 D2 v3 覆写为代理语境文案', async () => {
    // 公网代理：classifyProxyUnreachable 不成立 → 原分类 UPDATE_NETWORK_FAILED（darwin 公网兜底分支）
    const cause = Object.assign(new Error('connect EHOSTUNREACH 203.0.113.1:7890'), {
      code: 'EHOSTUNREACH',
    })
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch failed', { cause })
    })
    vi.stubGlobal('fetch', fetchSpy)
    __setCurlRunnerForTest(() => ({ exitCode: 7, stdout: '', stderr: 'curl: (7) Failed to connect' }))

    const handler = handlers.get('update:testProxy')!
    const result = await handler({}, {
      mode: 'manual',
      httpProxy: 'http://203.0.113.1:7890',
      httpsProxy: 'http://203.0.113.1:7890',
    })

    // 落盘 code 维持原分类，对用户文案覆写为代理语境（D2 v3 修订保留）
    expect(result).toMatchObject({
      success: false,
      code: 'UPDATE_NETWORK_FAILED',
      message: '无法连接代理 (EHOSTUNREACH)',
      suggestion: '请检查代理地址与端口是否正确、代理服务是否正在运行，以及当前网络能否连通代理',
    })
    expect(errorLogMocks.appendUpdateError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'test-proxy', errorCode: 'UPDATE_NETWORK_FAILED', engine: 'curl' }),
    )
  })
})
