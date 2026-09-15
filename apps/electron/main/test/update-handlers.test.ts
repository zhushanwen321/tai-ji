/**
 * W2 TDD 测试：update-handlers IPC（W2TC7）。
 *
 * 验证 'update:check' channel：
 *   - 注册时 ipcMain.handle 捕获 handler
 *   - handler 调 app.getVersion() 拿当前版本
 *   - handler 透传 force 到 releaseChecker.checkForLatestRelease
 *   - 返回 releaseChecker 的结果（LatestReleaseInfo fixture）
 *   - releaseChecker 未注入时返回 null
 *
 * Mock 策略：参考 privileged-handlers.test.ts，vi.mock('electron')：
 *   - ipcMain.handle 捕获 handler 到 Map
 *   - app.getVersion 返回 '0.8.14'
 *
 * 运行：cd apps/electron/main && npx vitest run test/update-handlers.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LatestReleaseInfo } from '@taiji/shared'

// 捕获注册的 handler（key=channel, value=handler fn）
const handlers = new Map<string, (...args: unknown[]) => unknown>()

// 捕获 setTimeout（update:perform triggerRestart 后用 setTimeout 调 app.quit）
let capturedQuitTimer: { callback: () => void; delay: number } | null = null

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

// ── preloaded-update mock（u3b：install validateRelease 用例注入伪造 preloaded，不读真实 fs）──
const preloadedMocks = vi.hoisted(() => ({
  readPreloadedUpdateRaw: vi.fn<(v: string) => Promise<{ release: LatestReleaseInfo; filePath: string } | null>>(),
}))
vi.mock('../update/preloaded-update.js', () => ({
  readPreloadedUpdateRaw: preloadedMocks.readPreloadedUpdateRaw,
  writePreloadedUpdate: vi.fn(),
  readPreloadedUpdate: vi.fn(),
  clearPreloadedUpdate: vi.fn(),
}))

// 桩 main window + webContents.send（验证 update:progress / update:error 事件推送）
const sendSpy = vi.fn()
const mockMainWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: { send: sendSpy },
}

import { registerUpdateHandlers } from '../gateway/update-handlers.js'
import type { IReleaseChecker } from '../interfaces.js'
import type { IUpdateOrchestrator } from '../update/orchestrator.js'
import { UpdateError, UpdateUnsupportedError } from '../update/types.js'

/**
 * mock checker 的 fetchReleaseByTag 桩（多源改造后 IReleaseChecker 必需方法）。
 * handler 层不消费该方法（下载降级在 orchestrator），桩返回 null 即可满足接口形状。
 */
function stubFetchReleaseByTag() {
  return vi.fn(async (): Promise<LatestReleaseInfo | null> => null)
}

/**
 * LatestReleaseInfo 测试 fixture。
 *
 * [SECURITY] 必须通过 validateRelease 校验（update:perform handler 在 performUpdate
 * 前会校验 payload）：
 * - version 严格 3 段数字
 * - downloadUrl 必须是 GitHub 域名（github.com / objects.githubusercontent.com）的 https
 * - sha256 若存在必须是 64 位 hex（这里用全 'a'）
 */
const FIXTURE: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '## changes',
  publishedAt: '2025-12-01T00:00:00Z',
  htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
  assets: {
    macArm64Dmg: {
      name: 'TaiJi-mac-arm64.dmg',
      downloadUrl: 'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/TaiJi-mac-arm64.dmg',
      size: 1000,
      sha256: 'a'.repeat(64),
    },
  },
}

describe('W2: update-handlers IPC (W2TC7)', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('W2TC7a: 调 handler({}, { force: true }) → checkForLatestRelease 被调且 force 透传，返回 fixture', async () => {
    const checkForLatestRelease = vi.fn(async (
      _currentVersion: string,
      _opts?: { force?: boolean },
    ): Promise<LatestReleaseInfo | null> => FIXTURE)
    const mockChecker: IReleaseChecker = { checkForLatestRelease, fetchReleaseByTag: stubFetchReleaseByTag() }

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, { force: true })

    // checkForLatestRelease 被调，app.getVersion() 透传为 '0.8.14'
    expect(checkForLatestRelease).toHaveBeenCalledTimes(1)
    expect(checkForLatestRelease).toHaveBeenCalledWith('0.8.14', { force: true })
    // 返回 UpdateCheckResult（RM2.3 形状）：有新版 + 非限额
    expect(result).toEqual({ info: FIXTURE, rateLimited: false })
  })

  it('W2TC7b: 不传 payload → force 默认 undefined', async () => {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    const mockChecker: IReleaseChecker = { checkForLatestRelease, fetchReleaseByTag: stubFetchReleaseByTag() }

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({})

    expect(checkForLatestRelease).toHaveBeenCalledWith('0.8.14', { force: undefined })
    expect(result).toEqual({ info: FIXTURE, rateLimited: false })
  })

  it('W2TC7c: checkForLatestRelease 返回 null → info=null 且非限额（确认无新版）', async () => {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => null)
    const mockChecker: IReleaseChecker = { checkForLatestRelease, fetchReleaseByTag: stubFetchReleaseByTag() }

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, {})
    expect(result).toEqual({ info: null, rateLimited: false })
  })

  it('W2TC7c2: null + 退避窗口内 → rateLimited=true（RM2.3 信号透传：限额未知 ≠ 无新版）', async () => {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => null)
    const mockChecker: IReleaseChecker = {
      checkForLatestRelease,
      fetchReleaseByTag: stubFetchReleaseByTag(),
      getRateLimitedUntil: () => Date.now() + 2 * 60 * 60 * 1000,
    }

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, {})
    expect(result).toEqual({ info: null, rateLimited: true })
  })

  it('W2TC7c2b: 全源退避聚合语义——getRateLimitedUntil 全部源退避才返回最早解除时刻：窗口内 true / 窗口过 false', async () => {
    // 多源改造后 checker.getRateLimitedUntil() 仅在全部源均在退避窗口时返回未来时刻
    //（= 各源截止的最早解除时刻 min；任一源可用返回 0，签名不变）。handler 判定式
    // 不感知源数，仅消费该聚合值：返回值 > now 即「全部源均在退避窗口」的信号
    // 形态（全源退避），透传 rateLimited=true。
    const inWindowChecker: IReleaseChecker = {
      checkForLatestRelease: vi.fn(async (): Promise<LatestReleaseInfo | null> => null),
      fetchReleaseByTag: stubFetchReleaseByTag(),
      // 模拟两源退避截止不同（github +2h、atomgit +1h）→ 聚合最早解除时刻 = +1h > now
      getRateLimitedUntil: () => Date.now() + 60 * 60 * 1000,
    }
    registerUpdateHandlers({ releaseChecker: inWindowChecker } as never)
    const inWindow = await handlers.get('update:check')!({}, {})
    expect(inWindow).toEqual({ info: null, rateLimited: true })

    // 窗口已过（聚合值 ≤ now，即任一源可用或全部退避已解除）→ rateLimited=false（确认无新版）
    const expiredChecker: IReleaseChecker = {
      checkForLatestRelease: vi.fn(async (): Promise<LatestReleaseInfo | null> => null),
      fetchReleaseByTag: stubFetchReleaseByTag(),
      getRateLimitedUntil: () => Date.now() - 1000,
    }
    registerUpdateHandlers({ releaseChecker: expiredChecker } as never)
    const expired = await handlers.get('update:check')!({}, {})
    expect(expired).toEqual({ info: null, rateLimited: false })
  })

  it('W2TC7c3: 有新版时不报 rateLimited（getRateLimitedUntil 不影响正结果）', async () => {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    const mockChecker: IReleaseChecker = {
      checkForLatestRelease,
      fetchReleaseByTag: stubFetchReleaseByTag(),
      // 窗口未过但 info 非 null（理论上不发生：退避窗口内短路返回 null；防御断言）
      getRateLimitedUntil: () => Date.now() + 60_000,
    }

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, {})
    expect(result).toEqual({ info: FIXTURE, rateLimited: false })
  })

  it('W2TC7d: releaseChecker=undefined（未注入）→ handler 返回 null 形状，不调 checkForLatestRelease', async () => {
    registerUpdateHandlers({} as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, { force: true })
    expect(result).toEqual({ info: null, rateLimited: false })
  })

  it('W2TC7e: checkForLatestRelease 抛错 → handler 兜底返回 null 形状不 reject', async () => {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => {
      throw new Error('checker crash')
    })
    const mockChecker: IReleaseChecker = { checkForLatestRelease, fetchReleaseByTag: stubFetchReleaseByTag() }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    registerUpdateHandlers({ releaseChecker: mockChecker } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, {})
    expect(result).toEqual({ info: null, rateLimited: false })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ════════════════════════════════════════════════════════════════
// [A-X4] update:check force 节流：10s 窗口内重复 force 请求降级为非 force
// 语义（走 checker 缓存），不拒绝、不烧 GitHub API 配额。节流是模块级状态，
// 用 fake timers + 未来基点错开各用例（与其他用例互不污染）。
// ════════════════════════════════════════════════════════════════
describe('[A-X4] update:check force 节流', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('10s 窗口内第二次 force=true 降级为非 force（不绕缓存），窗口外恢复透传', async () => {
    vi.useFakeTimers()
    // fake 起点默认为真实当前时间；+30s 偏移避开前序用例（真实时钟）置位的节流时间戳
    vi.setSystemTime(Date.now() + 30_000)
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => null)
    registerUpdateHandlers({ releaseChecker: { checkForLatestRelease } } as never)

    const handler = handlers.get('update:check')!

    // 第 1 次 force：窗口外 → 透传 force: true（并置位节流时间戳）
    const first = await handler({}, { force: true })
    expect(first).toEqual({ info: null, rateLimited: false })
    expect(checkForLatestRelease).toHaveBeenLastCalledWith('0.8.14', { force: true })

    // 第 2 次（窗口内）：降级为非 force 语义——仍正常调用返回（体验无损），
    // 但不再 force 绕缓存（配额不被放大）
    const second = await handler({}, { force: true })
    expect(second).toEqual({ info: null, rateLimited: false })
    expect(checkForLatestRelease).toHaveBeenLastCalledWith('0.8.14', { force: false })
    expect(checkForLatestRelease).toHaveBeenCalledTimes(2)

    // 窗口外（+11s > 10s 窗口）：force 透传恢复
    vi.setSystemTime(Date.now() + 11_000)
    await handler({}, { force: true })
    expect(checkForLatestRelease).toHaveBeenLastCalledWith('0.8.14', { force: true })
  })

  it('force=false/缺失不节流（本就命中缓存无害），透传行为不变', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 90_000)
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    registerUpdateHandlers({ releaseChecker: { checkForLatestRelease } } as never)

    const handler = handlers.get('update:check')!
    // 连续两次非 force 调用（间隔 0ms）：均透传，不被节流降级
    await handler({}, {})
    await handler({}, {})
    expect(checkForLatestRelease).toHaveBeenCalledTimes(2)
    expect(checkForLatestRelease).toHaveBeenNthCalledWith(1, '0.8.14', { force: undefined })
    expect(checkForLatestRelease).toHaveBeenNthCalledWith(2, '0.8.14', { force: undefined })
  })
})

// ── W3：update:perform（W3TC10）──────────────────────────────────
describe('u3b: update:install validateRelease（m11 防御纵深）', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    sendSpy.mockClear()
    capturedQuitTimer = null
    // 拦截 setTimeout 捕获 quit 定时器
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, delay?: number) => {
      capturedQuitTimer = { callback: cb, delay: delay ?? 0 }
      return 0 as unknown as NodeJS.Timeout
    }) as typeof setTimeout)
  })

  it('污染 version 的 preloaded → install 前被 validateRelease 拒绝，installUpdate 不被调', async () => {
    // m11：version 含单引号会被拼进 bash 脚本单引号上下文 → 白名单格式校验拦截
    const poisoned: LatestReleaseInfo = {
      ...FIXTURE,
      version: "0.9.0' --$(touch /tmp/pwned)",
    }
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({ release: poisoned, filePath: '/tmp/pre.zip' })
    const installUpdate = vi.fn(async () => ({ triggerRestart: true }))
    registerUpdateHandlers({
      updateOrchestrator: { installUpdate } as unknown as IUpdateOrchestrator,
      getMainWindow: () => mockMainWindow as never,
    } as never)

    const handler = handlers.get('update:install')!
    await expect(handler({}, {})).rejects.toThrow(/invalid version/)
    // 拒绝发生在 installUpdate 之前（污染数据不进 orchestrator）
    expect(installUpdate).not.toHaveBeenCalled()
  })

  it('合法 preloaded → validateRelease 放行，installUpdate 正常调用（不误伤）', async () => {
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({ release: FIXTURE, filePath: '/tmp/pre.zip' })
    const installUpdate = vi.fn(async () => ({ triggerRestart: true }))
    registerUpdateHandlers({
      updateOrchestrator: { installUpdate } as unknown as IUpdateOrchestrator,
      getMainWindow: () => mockMainWindow as never,
    } as never)

    const handler = handlers.get('update:install')!
    const result = await handler({}, {})
    // u6（update-network-resilience D2）：install 响应增加实装 version 字段
    expect(result).toEqual({ triggerRestart: true, version: '0.9.0' })
    expect(installUpdate).toHaveBeenCalledTimes(1)
    expect(installUpdate).toHaveBeenCalledWith(FIXTURE, '/tmp/pre.zip', expect.any(Function))
  })
})

// ── W4: update:getLaunchResult handler（A2/A3）───────────────────

// ── W4: update:getLaunchResult handler（A2/A3）───────────────────
describe('A2-launch-result-handler-vitest', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  function registerWithGetLaunchResult(getLaunchResult: () => Promise<{ status: string; version: string } | null>) {
    registerUpdateHandlers({
      getMainWindow: () => mockMainWindow as never,
      releaseChecker: { checkForLatestRelease: vi.fn() } as never,
      getLaunchResult,
    } as never)
  }

  it('A2-launch-result-handler-vitest: getLaunchResult handler 返回缓存值 + consumed 一次性', async () => {
    // 模拟 main.ts 的 consumed 一次性缓存
    let cache: { status: string; version: string } | null = { status: 'done', version: '0.9.9' }
    const getLaunchResult = async () => {
      const result = cache
      cache = null
      return result
    }
    registerWithGetLaunchResult(getLaunchResult)

    const handler = handlers.get('update:getLaunchResult')!
    expect(handler).toBeDefined()

    // 首次调用：返回缓存值
    const first = await handler()
    expect(first).toEqual({ status: 'done', version: '0.9.9' })

    // 第二次调用：consumed 一次性，返回 null
    const second = await handler()
    expect(second).toBeNull()
  })

  it('A3-main-cache-vitest: getLaunchResult 回调返回 cleanupCompletedUpdate 的缓存值', async () => {
    // 模拟 cleanupCompletedUpdate 返回 rolled-back 状态
    const getLaunchResult = async () => ({ status: 'rolled-back', version: '0.9.7' })
    registerWithGetLaunchResult(getLaunchResult)

    const handler = handlers.get('update:getLaunchResult')!
    const result = await handler()
    expect(result).toEqual({ status: 'rolled-back', version: '0.9.7' })
  })
})

// ════════════════════════════════════════════════════════════════
// u3a：resolveByVersion（批次 3 信任锚 RC1：四分支 + 60s 节流）
// 真实 resolver 逻辑单测（DI mock 的 handler 编排测试在
// update-handlers-orchestration.test.ts）。节流是模块级状态，
// 各用例用 fake timers 的 now 递增错开，避免互相污染。
// ════════════════════════════════════════════════════════════════
import { resolveByVersion } from '../update/orchestrator.js'

describe('u3a: resolveByVersion（版本解析四分支 + 60s 节流）', () => {
  /** 递增的 fake 时钟基点（各用例间隔 > 节流窗口 60s + 用例内最大 61s×2 推进，隔离模块级节流状态） */
  const BASE = 1_700_000_000_000
  const STEP = 200_000
  let seq = 0

  /** 构造 checker 桩：非强制 / 强制调用分别返回指定值（undefined 视为 null） */
  function makeChecker(nonForce: LatestReleaseInfo | null, force: LatestReleaseInfo | null) {
    return {
      checkForLatestRelease: vi.fn(
        async (_v: string, opts?: { force?: boolean }) =>
          (opts?.force ? force : nonForce) ?? null,
      ),
    } as unknown as IReleaseChecker
  }

  /** 与 FIXTURE 同构、版本号为 0.9.1 的「更新 latest」（供 STALE 分支用） */
  /** 与 FIXTURE 同构、版本号 0.9.0 的「权威 latest」（供 STALE 分支：请求 0.9.1 被拒） */
  const LATEST_0_9_0: LatestReleaseInfo = { ...FIXTURE, version: '0.9.0' }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('③ 版本格式非法 → 直接拒绝，不打 checker（含非 string 类型防御）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    const checker = makeChecker(null, null)

    await expect(
      resolveByVersion('abc', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/invalid requested version format/)
    // 拒绝即节流：后续断言前推进 61s 离开节流窗口
    vi.setSystemTime(Date.now() + 61_000)
    await expect(
      resolveByVersion('1.2', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/invalid requested version format/)
    vi.setSystemTime(Date.now() + 61_000)
    // typeof 守卫：IPC 数字被正则隐式串化绕过（123 → '123'）必须被拒
    await expect(
      resolveByVersion(123 as unknown as string, { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/invalid requested version format/)
    // 拒绝发生在任何 checker 调用之前（零 API 消耗）
    expect(checker.checkForLatestRelease).not.toHaveBeenCalled()
  })

  it('④ STALE/解析失败后 60s 内：合法请求也被直接拒绝（不触发 force check），窗口外恢复', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    const checker = makeChecker(null, null)
    // 前置：制造一次拒绝（格式非法，now = 本用例起点）
    await expect(
      resolveByVersion('bad', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/invalid requested version format/)

    // 窗口内：合法版本 + 缓存命中的 checker 也被节流拒绝
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/throttled/)
    // 节流拒绝发生在 checker 之前（不触发 force check → 无 API 放大）
    expect(checker.checkForLatestRelease).not.toHaveBeenCalled()

    // 窗口外（61s 后）：恢复解析能力（缓存命中分支）
    vi.setSystemTime(Date.now() + 61_000)
    checker.checkForLatestRelease = vi.fn(async () => FIXTURE) as never
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).resolves.toBe(FIXTURE)
  })

  it('① 缓存命中且版本一致 → 用缓存 release，不触发 force check', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    const checker = makeChecker(FIXTURE, FIXTURE)
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).resolves.toBe(FIXTURE)
    // 只调了非强制（缓存优先）一次；force 分支未进入（单参调用，无第二参）
    expect(checker.checkForLatestRelease).toHaveBeenCalledTimes(1)
    expect(checker.checkForLatestRelease).toHaveBeenCalledWith('0.8.14')
  })

  it('② 缓存不一致 → force check；latest ≠ 请求版本 → UPDATE_STALE_RELEASE + 记节流', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    // 缓存给 0.9.0，请求 0.9.1 → 不一致；force 也返回 0.9.0（权威 latest 未到 0.9.1）
    const checker = makeChecker(FIXTURE, LATEST_0_9_0)
    const err = await resolveByVersion('0.9.1', {
      currentVersion: '0.8.14',
      releaseChecker: checker,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(UpdateError)
    expect((err as UpdateError).errorCode).toBe('UPDATE_STALE_RELEASE')
    // force check 真的发生了（权威确认，而非直接用缓存拒绝）
    expect(checker.checkForLatestRelease).toHaveBeenCalledTimes(2)
    expect(checker.checkForLatestRelease).toHaveBeenLastCalledWith('0.8.14', { force: true })

    // STALE 拒绝后节流生效：窗口内的后续请求直接拒绝
    await expect(
      resolveByVersion('0.9.1', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).rejects.toThrow(/throttled/)
  })

  it('② check 失败（网络）→ 抛 UPDATE_NETWORK_FAILED，绝不回退缓存外/renderer 数据；且网络失败不节流', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    // 缓存 miss + force 均失败（网络断，既不能确认也不能证伪）
    const downChecker = makeChecker(null, null)
    const err = await resolveByVersion('0.9.0', {
      currentVersion: '0.8.14',
      releaseChecker: downChecker,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(UpdateError)
    expect((err as UpdateError).errorCode).toBe('UPDATE_NETWORK_FAILED')

    // 网络失败不触发节流：立即重试（网络恢复，缓存命中）即成功
    const recovered = makeChecker(FIXTURE, FIXTURE)
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: recovered }),
    ).resolves.toBe(FIXTURE)
  })

  it('② 缓存 miss → force check 命中请求版本 → 用权威结果', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE + seq * STEP)
    seq++
    const checker = makeChecker(null, FIXTURE)
    await expect(
      resolveByVersion('0.9.0', { currentVersion: '0.8.14', releaseChecker: checker }),
    ).resolves.toBe(FIXTURE)
    // 非 force miss（null）后走了 force
    expect(checker.checkForLatestRelease).toHaveBeenCalledTimes(2)
    expect(checker.checkForLatestRelease).toHaveBeenLastCalledWith('0.8.14', { force: true })
  })
})
