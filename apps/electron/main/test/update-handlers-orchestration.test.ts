/**
 * update-handlers 编排逻辑测试（S#7 / S#8 / S#9 / S#11）。
 *
 * 覆盖 update-handlers.ts 中此前无回归防护的 4 块逻辑：
 *   S#7  preloadUpdateSilently + update:check 编排（写 pending 标志 + 条件触发后台预下载）：
 *        - preDownload=true → downloadUpdate 被异步触发 + pending 标志已写
 *        - preDownload=false → downloadUpdate 不被触发
 *        - preDownloading=true → 不重复下载（互斥）
 *   S#8  update:perform 快路径：已随批次 3 m17 删除（update:perform handler 不存在）；
 *        两阶段 update:download/update:install 的编排覆盖见下方 T4 describe
 *   S#9  update:getPending / update:getSettings / update:setSettings：
 *        - getSettings 返回默认值、setSettings 写入后 getSettings 读回
 *        - setSettings 传非 boolean preDownload 抛 'Invalid settings'
 *        - setSettings 传非法 updateSource（非三值）抛 'Invalid settings'（多源 D3）
 *        - getPending 透传 readPendingUpdate
 *   D3s  UPDATE_ERROR_MESSAGES.UPDATE_NETWORK_FAILED suggestion 文案中性化断言
 *        （多源 §7.3：去 GitHub 专名，双源时代用户可能恒走 GitCode）
 *   S#11 handler 全部经 deps.updateOrchestrator.* 调用（DI 契约含 downloadUpdate/installUpdate），
 *        测试用 mock DI 接口替换快路径/预下载能力——本文件即验证此可测性。
 *
 * Mock 策略：
 *   - electron：ipcMain.handle 捕获 handler；app.getVersion/quit 占位
 *   - update-settings / pending-update / preloaded-update：vi.mock 全量桩（消除 constants.ts
 *     顶层 path 预绑定对 TAIJI_AGENT_DATA_DIR 时序的依赖；本文件不读真实 fs，纯 mock 交互断言）
 *   - proxy-config：保留真实模块（testProxy/getProxyConfig 不在本批用例；setProxyConfig 校验
 *     用例属旧文件）。本文件不触发代理 IPC，故不 mock，避免影响类型解析。
 *   - DI orchestrator：每个用例注入完整的 mock IUpdateOrchestrator（resolveByVersion/downloadUpdate/installUpdate）
 *
 * 运行：cd apps/electron/main && npx vitest run test/update-handlers-orchestration.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LatestReleaseInfo, UpdateSettings, UpdateSourcePref } from '@taiji/shared'

// ── 捕获注册的 handler（key=channel, value=handler fn）──────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>()

// ── electron mock：ipcMain.handle 捕获 + app 占位 ──────────────────
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

// ── FS 依赖模块全量 mock（消除 constants 顶层 path 预绑定）──────────
const settingsMocks = vi.hoisted(() => ({
  getUpdateSettings: vi.fn<() => UpdateSettings>(),
  setUpdateSettings: vi.fn<(settings: Partial<UpdateSettings>) => void>(),
}))
// [多源 D3] 部分真实：normalizeUpdateSourcePref / UPDATE_SOURCE_PREFS / DEFAULT_UPDATE_SETTINGS
// 取真实导出（handler 的 updateSource 归一校验消费真实守卫，杜绝 mock 复刻三值列表漂移）。
// constants.ts 已全路径延迟求值（module-eager-binding 修复），importOriginal 无 fs 副作用；
// get/set 两个 fs 函数仍走 mock（本文件不读真实 fs）。
vi.mock('../update/update-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update/update-settings.js')>()
  return {
    ...actual,
    getUpdateSettings: settingsMocks.getUpdateSettings,
    setUpdateSettings: settingsMocks.setUpdateSettings,
  }
})

const pendingMocks = vi.hoisted(() => ({
  writePendingUpdate: vi.fn<(release: LatestReleaseInfo) => void>(),
  readPendingUpdate: vi.fn<(currentVersion: string) => LatestReleaseInfo | null>(),
}))
vi.mock('../update/pending-update.js', () => ({
  writePendingUpdate: pendingMocks.writePendingUpdate,
  readPendingUpdate: pendingMocks.readPendingUpdate,
  clearPendingUpdate: vi.fn(),
}))

const preloadedMocks = vi.hoisted(() => ({
  writePreloadedUpdate: vi.fn<(release: LatestReleaseInfo, filePath: string) => void>(),
  readPreloadedUpdate: vi.fn<(release: LatestReleaseInfo) => Promise<string | null>>(),
  readPreloadedUpdateRaw: vi.fn<(currentVersion: string) => Promise<{ release: LatestReleaseInfo; filePath: string } | null>>(),
  clearPreloadedUpdate: vi.fn<() => void>(),
}))
vi.mock('../update/preloaded-update.js', () => ({
  writePreloadedUpdate: preloadedMocks.writePreloadedUpdate,
  readPreloadedUpdate: preloadedMocks.readPreloadedUpdate,
  readPreloadedUpdateRaw: preloadedMocks.readPreloadedUpdateRaw,
  clearPreloadedUpdate: preloadedMocks.clearPreloadedUpdate,
}))

// 桩 main window + webContents.send（验证 update:progress / update:error 事件推送）
const sendSpy = vi.fn()
const mockMainWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: { send: sendSpy },
}

import { registerUpdateHandlers } from '../gateway/update-handlers.js'
import type { IReleaseChecker } from '../interfaces.js'

/**
 * LatestReleaseInfo fixture：必须通过 validateRelease 校验（update:perform 在执行前校验）。
 * - version 严格 3 段数字
 * - downloadUrl 为 GitHub 域 https
 * - sha256 64 位 hex
 */
const FIXTURE: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '## changes',
  publishedAt: '2025-12-01T00:00:00Z',
  htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
  assets: {
    macArm64Dmg: {
      name: 'TaiJi-0.10.0-mac-arm64.dmg',
      downloadUrl:
        'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/TaiJi-0.10.0-mac-arm64.dmg',
      size: 1000,
      sha256: 'a'.repeat(64),
    },
  },
}

import type { Mock } from 'vitest'

/** mock IUpdateOrchestrator（保留 .mock 断言能力；每方法为 Mock 而非具体函数） */
interface MockOrchestrator {
  downloadUpdate: Mock<(release: LatestReleaseInfo, onProgress?: (percent: number) => void) =>
    Promise<{ filePath: string }>>
  installUpdate: Mock<
    (
      release: LatestReleaseInfo,
      filePath: string,
      onProgress?: (stage: string, percent: number) => void,
    ) => Promise<{ triggerRestart: boolean }>
  >
  resolveByVersion: Mock<
    (
      version: string,
      opts: { currentVersion: string; releaseChecker: unknown },
    ) => Promise<LatestReleaseInfo>
  >
}

/**
 * 构造完整 mock IUpdateOrchestrator（resolveByVersion/downloadUpdate/installUpdate 全桩）。
 * overrides 逐字段替换，保留其余字段的默认 mock（.mock 断言仍可用）。
 */
function mockOrchestrator(overrides: Partial<MockOrchestrator> = {}): MockOrchestrator {
  return {
    downloadUpdate: vi.fn(async () => ({ filePath: '/tmp/preloaded.zip' })),
    installUpdate: vi.fn(async () => ({ triggerRestart: false })),
    // u3a 契约版本号化：默认解析回 FIXTURE（权威 latest 与请求一致分支）
    resolveByVersion: vi.fn(async () => FIXTURE),
    ...overrides,
  }
}

/** 捕获 setTimeout（update:perform triggerRestart 后用 setTimeout 调 app.quit） */
let capturedQuitTimer: { delay: number } | null = null

// 预下载门控 isAutoUpdateSupportedForCurrentInstall（真实现非 mock）在 linux 无
// APPIMAGE 时返回 false → update:check 不触发预下载 → downloadUpdate 0 次调用。
// CI 在 linux x64 runner 上跑，本地 mac 全绿、CI 恒红的根因；FIXTURE 即 mac 语义，
// 全文件统一桩 darwin
let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  handlers.clear()
  vi.clearAllMocks()
  sendSpy.mockClear()
  mockMainWindow.isDestroyed.mockReturnValue(false)
  capturedQuitTimer = null
  // 拦截 setTimeout 仅捕获 quit 定时器（delay），其余放行避免影响 vi 内部定时器
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, delay?: number) => {
    // update:perform 成功路径用 setTimeout(cb, 500) 安排 quit；捕获此定时器
    capturedQuitTimer = { delay: delay ?? 0 }
    // 不实际执行 cb（避免触发 app.quit mock 的副作用），返回占位 handle
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout)
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

// ── S#9：update:getPending / update:getSettings / update:setSettings ──
describe('S#9 update-handlers: settings & pending IPC', () => {
  beforeEach(() => {
    registerUpdateHandlers({} as never)
  })

  it('update:getSettings → 透传 getUpdateSettings() 返回值', async () => {
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })

    const handler = handlers.get('update:getSettings')!
    const result = await handler({}, {})

    expect(settingsMocks.getUpdateSettings).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ preDownload: true })
  })

  it('update:setSettings 合法 boolean → 调 setUpdateSettings 且返回 {success:true}', async () => {
    const handler = handlers.get('update:setSettings')!
    const result = await handler({}, { preDownload: true })

    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledTimes(1)
    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledWith({ preDownload: true })
    expect(result).toEqual({ success: true })
  })

  it('update:setSettings → getSettings 读回：写入后 SSOT 模块被调相同对象（write-then-read 编排）', async () => {
    // 仿真「写入后读回」的 IPC 编排：先 getSettings 返回 false，setSettings(true)，
    // 再把 getSettings mock 切到 true 模拟「写入后读回」，验证 getSettings 透传新值
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: false })
    const setHandler = handlers.get('update:setSettings')!
    const getHandler = handlers.get('update:getSettings')!

    // 写入前读 → false
    const before = (await getHandler({}, {})) as UpdateSettings
    expect(before).toMatchObject({ preDownload: false })
    // 写入 true
    await setHandler({}, { preDownload: true })
    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledWith({ preDownload: true })
    // 模拟 SSOT 落盘后读回 true
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    const after = (await getHandler({}, {})) as UpdateSettings
    expect(after).toEqual({ preDownload: true })
  })

  it('update:setSettings preDownload 非 boolean → 抛 Invalid settings', async () => {
    const handler = handlers.get('update:setSettings')!
    // preDownload 传字符串（handler 层唯一输入校验分支）
    await expect(handler({}, { preDownload: 'yes' as unknown as boolean })).rejects.toThrow(
      /Invalid settings/,
    )
    // 校验失败不应落盘
    expect(settingsMocks.setUpdateSettings).not.toHaveBeenCalled()
  })

  it('update:setSettings updateSource 非法值（gitee）→ 抛 Invalid settings 且不落盘（多源 D3）', async () => {
    const handler = handlers.get('update:setSettings')!
    await expect(
      handler({}, { updateSource: 'gitee' as unknown as UpdateSourcePref }),
    ).rejects.toThrow(/Invalid settings/)
    // 非法值不落盘
    expect(settingsMocks.setUpdateSettings).not.toHaveBeenCalled()
  })

  it('update:setSettings updateSource null/数字（非 undefined）→ 抛 Invalid settings', async () => {
    const handler = handlers.get('update:setSettings')!
    // null !== undefined 且非三值 → 与先例同构（preDownload null 同样抛）
    await expect(
      handler({}, { updateSource: null as unknown as UpdateSourcePref }),
    ).rejects.toThrow(/Invalid settings/)
    await expect(
      handler({}, { updateSource: 42 as unknown as UpdateSourcePref }),
    ).rejects.toThrow(/Invalid settings/)
    expect(settingsMocks.setUpdateSettings).not.toHaveBeenCalled()
  })

  it('update:setSettings 旧值 updateSource（v0.10.0 落盘 atomgit）→ 经 IPC 归一为 gitcode 落盘（多源 D3 + 平台更名兼容）', async () => {
    const handler = handlers.get('update:setSettings')!
    const result = await handler({}, { updateSource: 'atomgit' })

    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledTimes(1)
    // 旧标识符接受不拒（该源即 GitCode 旧称），落盘值归一为新标识符——与读取侧 normalize 同源守卫
    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledWith({ updateSource: 'gitcode' })
    expect(result).toEqual({ success: true })
  })

  it('update:setSettings 不传 updateSource（缺失）→ 不触发枚举校验，正常落盘（局部更新兼容）', async () => {
    const handler = handlers.get('update:setSettings')!
    await handler({}, { preDownload: true })

    expect(settingsMocks.setUpdateSettings).toHaveBeenCalledWith({ preDownload: true })
  })

  it('update:getPending → 透传 readPendingUpdate(currentVersion)', async () => {
    pendingMocks.readPendingUpdate.mockReturnValue(FIXTURE)
    const handler = handlers.get('update:getPending')!

    const result = await handler({}, {})

    // readPendingUpdate 收到 app.getVersion() = '0.8.14'
    expect(pendingMocks.readPendingUpdate).toHaveBeenCalledTimes(1)
    expect(pendingMocks.readPendingUpdate).toHaveBeenCalledWith('0.8.14')
    // update:getPending 形状不变（设计 §3.5.1：getPending 不属于契约变更范围）
    expect(result).toEqual(FIXTURE)
  })

  it('update:getPending readPendingUpdate 返回 null → handler 返回 null（无新版/已升级）', async () => {
    pendingMocks.readPendingUpdate.mockReturnValue(null)
    const handler = handlers.get('update:getPending')!

    const result = await handler({}, {})
    expect(result).toBeNull()
  })
})

// ── S#7：preloadUpdateSilently + update:check 编排 ──────────────────
describe('S#7 update-handlers: preload orchestration in update:check', () => {
  /**
   * 注册 handler：注入 mockChecker（返回 FIXTURE）+ orchestrator。
   * preDownload 默认 false，由调用方经 settingsMocks 控制开关。
   */
  function register(orch: MockOrchestrator): void {
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    // fetchReleaseByTag 为 u-foundation 补的接口必需方法：handler 编排（本文件覆盖面）不
    // 消费它（消费方是 orchestrator 下载降级，u-download-failover），桩空实现满足接口形状
    const mockChecker: IReleaseChecker = {
      checkForLatestRelease,
      fetchReleaseByTag: vi.fn(async () => null),
    }
    registerUpdateHandlers({
      releaseChecker: mockChecker,
      updateOrchestrator: orch,
      getMainWindow: () => mockMainWindow as never,
    } as never)
  }

  it('preDownload=true → check 后：pending 标志已写 + downloadUpdate 异步触发 + 写 preloaded 元信息', async () => {
    const orch = mockOrchestrator()
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    register(orch)

    const handler = handlers.get('update:check')!
    const result = await handler({}, { force: true })

    // 返回 fixture
    expect(result).toEqual({ info: FIXTURE, rateLimited: false })
    // 功能 1：pending 标志已写
    expect(pendingMocks.writePendingUpdate).toHaveBeenCalledTimes(1)
    expect(pendingMocks.writePendingUpdate).toHaveBeenCalledWith(FIXTURE)

    // 预下载开关开 → 后台 downloadUpdate 异步触发（不阻塞 check 响应）。
    // 预下载是 fire-and-forget promise，需 await 一轮微任务让 preloadUpdateSilently 跑完。
    await vi.waitFor(() => {
      expect(orch.downloadUpdate).toHaveBeenCalledTimes(1)
    })
    expect(orch.downloadUpdate).toHaveBeenCalledWith(FIXTURE)
    // 下载成功 → 写 preloaded-update.json（供 update:download 快路径命中）
    expect(preloadedMocks.writePreloadedUpdate).toHaveBeenCalledTimes(1)
    const [releaseArg, filePathArg] = preloadedMocks.writePreloadedUpdate.mock.calls[0]
    expect(releaseArg).toBe(FIXTURE)
    expect(filePathArg).toBe('/tmp/preloaded.zip')
    // 快路径不调 installUpdate（预下载只下载不替换）
    expect(orch.installUpdate).not.toHaveBeenCalled()
  })

  it('preDownload=false → check 后写 pending 标志，但 downloadUpdate 不被触发', async () => {
    const orch = mockOrchestrator()
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: false })
    register(orch)

    const handler = handlers.get('update:check')!
    await handler({}, {})

    // 功能 1 的 pending 标志照写（与预下载开关无关）
    expect(pendingMocks.writePendingUpdate).toHaveBeenCalledTimes(1)
    // 预下载开关关 → 不触发后台下载
    expect(orch.downloadUpdate).not.toHaveBeenCalled()
    expect(preloadedMocks.writePreloadedUpdate).not.toHaveBeenCalled()
  })

  it('updateOrchestrator 未注入（dev/check-only）→ 跳过预下载，不抛错', async () => {
    // S#11：preDownload 编排引用 deps.updateOrchestrator，未注入时安全跳过（perform 会另行报错）
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    registerUpdateHandlers({
      releaseChecker: { checkForLatestRelease } as never,
    } as never)

    const handler = handlers.get('update:check')!
    const result = await handler({}, {})

    expect(result).toEqual({ info: FIXTURE, rateLimited: false })
    expect(pendingMocks.writePendingUpdate).toHaveBeenCalledTimes(1)
    // 无 orchestrator → 不触发预下载（不抛 TypeError）
    await Promise.resolve() // 让微任务跑一轮
    expect(preloadedMocks.writePreloadedUpdate).not.toHaveBeenCalled()
  })

  it('preDownloading=true（已在预下载）→ 不重复触发 downloadUpdate（互斥）', async () => {
    // 用 gate 让首次 downloadUpdate 挂起（preDownloading 标志持续为 true）
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        await gate // 阻塞直到 releaseGate
        return { filePath: '/tmp/preloaded.zip' }
      }),
    })
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    register(orch)

    const handler = handlers.get('update:check')!

    // 第一次 check：触发预下载，downloadUpdate 挂起在 gate 上（preDownloading=true）
    await handler({}, {})
    await vi.waitFor(() => expect(orch.downloadUpdate).toHaveBeenCalledTimes(1))

    // 第二次 check：preDownloading 仍为 true（首次未完成）→ 不重复触发 downloadUpdate
    await handler({}, {})
    // 仍是 1 次（互斥生效）
    expect(orch.downloadUpdate).toHaveBeenCalledTimes(1)

    // 释放首次预下载，让其正常结束（finally 重置 preDownloading），避免污染后续用例
    releaseGate()
    await vi.waitFor(() => expect(preloadedMocks.writePreloadedUpdate).toHaveBeenCalled())
  })

  it('preDownload=true 但 downloadUpdate 抛错 → 静默 warn，不 reject check 响应', async () => {
    // 预下载失败应静默放弃（功能 2 决策），不抛给 check 调用方
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        throw new Error('network down')
      }),
    })
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    register(orch)

    const handler = handlers.get('update:check')!
    // check 响应正常返回 fixture（预下载失败不影响 check 结果）
    const result = await handler({}, {})
    expect(result).toEqual({ info: FIXTURE, rateLimited: false })

    // 预下载失败 → warn + 不写 preloaded 元信息
    await vi.waitFor(() => expect(orch.downloadUpdate).toHaveBeenCalledTimes(1))
    expect(preloadedMocks.writePreloadedUpdate).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ── T4：拆分后的 update:download / update:install / update:getPreloaded ─────
describe('T4 update-handlers: update:download / update:install / update:getPreloaded', () => {
  beforeEach(() => {
    // 默认无预下载产物
    preloadedMocks.readPreloadedUpdate.mockResolvedValue(null)
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue(null)
  })

  function register(orch: MockOrchestrator): void {
    registerUpdateHandlers({
      updateOrchestrator: orch,
      // u3a：update:download 新增 releaseChecker 依赖（resolveByVersion 权威解析用）
      releaseChecker: { checkForLatestRelease: vi.fn(async () => null) },
      getMainWindow: () => mockMainWindow as never,
    } as never)
  }

  // ── update:download 成功路径 ───────────────────────────────
  it('update:download：无预下载产物 → resolveByVersion 权威解析 + downloadUpdate + 写 preloaded', async () => {
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => ({ filePath: '/tmp/dl.zip' })),
    })
    register(orch)

    const handler = handlers.get('update:download')!
    // u3a 新契约：renderer 只传意图（version），不传 release 数据
    const result = await handler({}, { version: '0.9.0' })

    expect(result).toEqual({ downloaded: true })
    // resolveByVersion 被调：version + currentVersion（app.getVersion = 0.8.14）
    expect(orch.resolveByVersion).toHaveBeenCalledTimes(1)
    expect(orch.resolveByVersion.mock.calls[0][0]).toBe('0.9.0')
    expect(orch.resolveByVersion.mock.calls[0][1]).toMatchObject({ currentVersion: '0.8.14' })
    // downloadUpdate 用的是 main 权威解析出的 release（非 renderer 传入）
    expect(orch.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(orch.downloadUpdate.mock.calls[0][0]).toBe(FIXTURE)
    // 写 preloaded 元信息（供 update:install 读）
    expect(preloadedMocks.writePreloadedUpdate).toHaveBeenCalledTimes(1)
    expect(preloadedMocks.writePreloadedUpdate).toHaveBeenCalledWith(FIXTURE, '/tmp/dl.zip')
  })

  // ── update:download 快路径（已有预下载产物）─────────────────
  it('update:download：已有有效预下载产物 → resolveByVersion 后跳过 downloadUpdate', async () => {
    preloadedMocks.readPreloadedUpdate.mockResolvedValue('/tmp/preloaded.zip')
    const orch = mockOrchestrator()
    register(orch)

    const handler = handlers.get('update:download')!
    const result = await handler({}, { version: '0.9.0' })

    expect(result).toEqual({ downloaded: true })
    // 解析照走（权威 latest 判定），但快路径不调 downloadUpdate（已有产物）
    expect(orch.resolveByVersion).toHaveBeenCalledTimes(1)
    expect(orch.downloadUpdate).not.toHaveBeenCalled()
    // 也不重复写 preloaded（已有产物）
    expect(preloadedMocks.writePreloadedUpdate).not.toHaveBeenCalled()
  })

  // ── update:download inFlight-await（后台预下载进行中）─────────
  it('update:download：后台预下载进行中 → await preDownloadPromise 后再判断', async () => {
    // 用 gate 模拟后台预下载挂起
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        await gate
        return { filePath: '/tmp/bg.zip' }
      }),
    })
    settingsMocks.getUpdateSettings.mockReturnValue({ preDownload: true })
    const checkForLatestRelease = vi.fn(async (): Promise<LatestReleaseInfo | null> => FIXTURE)
    registerUpdateHandlers({
      releaseChecker: { checkForLatestRelease } as never,
      updateOrchestrator: orch,
      getMainWindow: () => mockMainWindow as never,
    } as never)

    // 触发 update:check 启动后台预下载（挂起在 gate）
    const checkHandler = handlers.get('update:check')!
    await checkHandler({}, { force: true })
    await vi.waitFor(() => expect(orch.downloadUpdate).toHaveBeenCalledTimes(1))

    // 此时后台预下载挂起中，preDownloadPromise 非 null
    // readPreloadedUpdate 返回 null（产物未写）
    preloadedMocks.readPreloadedUpdate.mockResolvedValue(null)

    // update:download 会先 await preDownloadPromise（后台预下载）
    const downloadHandler = handlers.get('update:download')!
    const downloadPromise = downloadHandler({}, { version: '0.9.0' })
    await Promise.resolve() // 让事件循环跑一轮

    // 释放后台预下载 → downloadPromise 继续
    releaseGate()
    await vi.waitFor(() => expect(preloadedMocks.writePreloadedUpdate).toHaveBeenCalled())

    // 后台预下载完成后 readPreloadedUpdate 应命中（模拟后台写入了产物）
    preloadedMocks.readPreloadedUpdate.mockResolvedValue('/tmp/bg.zip')
    const result = await downloadPromise
    expect(result).toEqual({ downloaded: true })
  })

  // ── update:download 推进度事件 ──────────────────────────────
  it('update:download：downloadUpdate onProgress → 推 update:progress 事件（stage=downloading）', async () => {
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async (_release, onProgress) => {
        onProgress?.(50)
        return { filePath: '/tmp/dl.zip' }
      }),
    })
    register(orch)

    const handler = handlers.get('update:download')!
    await handler({}, { version: '0.9.0' })

    // downloadUpdate 的 onProgress 被传入了
    expect(orch.downloadUpdate.mock.calls[0][1]).toBeTypeOf('function')
 // 进度被转发为 update:progress 事件（stage=downloading）
    expect(sendSpy).toHaveBeenCalledWith('update:progress', { stage: 'downloading', percent: 50 })
  })

  // ── update:download 失败 → 推 update:error ──────────────────
  it('update:download：downloadUpdate 抛 UpdateError → 推 update:error + throw 可序列化对象', async () => {
    const { UpdateError } = await import('../update/types.js')
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        throw new UpdateError('network timeout', 'downloading', 'UPDATE_NETWORK_TIMEOUT')
      }),
    })
    register(orch)

    const handler = handlers.get('update:download')!
    // reject 抛出可序列化对象（非 Error，避免结构化克隆失败）
    await expect(handler({}, { version: '0.9.0' })).rejects.toMatchObject({
      stage: 'downloading',
    })
    // 推 update:error 事件
    expect(sendSpy).toHaveBeenCalledWith('update:error', expect.objectContaining({
      stage: 'downloading',
    }))
    // download 失败不清 preloaded
    expect(preloadedMocks.clearPreloadedUpdate).not.toHaveBeenCalled()
  })

  // ── UPDATE_NETWORK_TIMEOUT 用户文案成因分流（design-code-sync F1）──────────
  it('update:download：curl connect-timeout 形态 → 用户文案分流为连接超时（不误标停滞）', async () => {
    const { UpdateError } = await import('../update/types.js')
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        // mapCurlExitToError connect 档产出的英文诊断串形态
        throw new UpdateError('curl connection timeout (no connection within 10s, exit 28)', 'downloading', 'UPDATE_NETWORK_TIMEOUT')
      }),
    })
    register(orch)

    const handler = handlers.get('update:download')!
    await expect(handler({}, { version: '0.9.0' })).rejects.toMatchObject({
      stage: 'downloading',
      message: '连接超时（10 秒未建立连接）',
      suggestion: '请检查网络连接或代理设置后重试',
    })
    expect(sendSpy).toHaveBeenCalledWith('update:error', expect.objectContaining({
      errorCode: 'UPDATE_NETWORK_TIMEOUT',
      message: '连接超时（10 秒未建立连接）',
    }))
  })

  it('update:download：停滞形态 → 用户文案保持停滞 + 断点续传指引（不被 connect 话术覆盖）', async () => {
    const { UpdateError } = await import('../update/types.js')
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        // undici 停滞档（finalizeSingleStreamError）/ curl --speed-time 档的英文诊断串形态
        throw new UpdateError('download stalled (no data for 30s), aborted; temp kept — retry resumes from break point', 'downloading', 'UPDATE_NETWORK_TIMEOUT')
      }),
    })
    register(orch)

    const handler = handlers.get('update:download')!
    await expect(handler({}, { version: '0.9.0' })).rejects.toMatchObject({
      stage: 'downloading',
      message: '下载停滞（连续 30 秒无数据）已中断',
      suggestion: expect.stringContaining('断点续传'),
    })
    expect(sendSpy).toHaveBeenCalledWith('update:error', expect.objectContaining({
      errorCode: 'UPDATE_NETWORK_TIMEOUT',
      message: '下载停滞（连续 30 秒无数据）已中断',
    }))
  })

  it('update:download：泛化 timeout 形态（testProxy 探测类）→ 中性超时话术（无下载语境不给续传指引）', async () => {
    const { UpdateError } = await import('../update/types.js')
    const orch = mockOrchestrator({
      downloadUpdate: vi.fn(async () => {
        // classifyNetError 对 AbortError 的泛化形态（无 stalled/connection timeout 特征）
        throw new UpdateError('timeout (aborted)', 'downloading', 'UPDATE_NETWORK_TIMEOUT')
      }),
    })
    register(orch)

    const handler = handlers.get('update:download')!
    await expect(handler({}, { version: '0.9.0' })).rejects.toMatchObject({
      stage: 'downloading',
      message: '连接或响应超时',
      suggestion: '请检查网络连接是否稳定，或尝试配置代理服务器',
    })
  })

  // ── update:install 成功路径（从 preloaded 读）─────────────────
  it('update:install：从 readPreloadedUpdateRaw 读 release+filePath → installUpdate 用 preloaded release', async () => {
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({ release: FIXTURE, filePath: '/tmp/pre.zip' })
    const orch = mockOrchestrator({
      installUpdate: vi.fn(async () => ({ triggerRestart: true })),
    })
    register(orch)

    const handler = handlers.get('update:install')!
    const result = await handler({}, {})

    // u6（update-network-resilience D2）：install 响应增加实装 version 字段（preloaded release.version）
    expect(result).toEqual({ triggerRestart: true, version: '0.9.0' })
    // installUpdate 收到 preloaded 的 release + filePath（不是前端传入）
    expect(orch.installUpdate).toHaveBeenCalledTimes(1)
    expect(orch.installUpdate).toHaveBeenCalledWith(FIXTURE, '/tmp/pre.zip', expect.any(Function))
    // readPreloadedUpdateRaw 收到 app.getVersion() = '0.8.14'（版本守卫传参，WTC12 集成验证）
    expect(preloadedMocks.readPreloadedUpdateRaw).toHaveBeenCalledWith('0.8.14')
    // triggerRestart=true → 安排延迟 quit
    expect(capturedQuitTimer).not.toBeNull()
    expect(capturedQuitTimer!.delay).toBe(500)
  })

  // ── update:install 无预下载产物 → 抛错 ──────────────────────
  it('update:install：无预下载产物 → 抛 No preloaded update available', async () => {
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue(null)
    const orch = mockOrchestrator()
    register(orch)

    const handler = handlers.get('update:install')!
    await expect(handler({}, {})).rejects.toThrow(/No preloaded update available/)
    // installUpdate 不被调
    expect(orch.installUpdate).not.toHaveBeenCalled()
  })

  // ── update:install 失败 → 清 preloaded（防死循环）────────────
  it('update:install：installUpdate 抛错 → 清 preloaded（防重试死循环）', async () => {
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({ release: FIXTURE, filePath: '/tmp/pre.zip' })
    const orch = mockOrchestrator({
      installUpdate: vi.fn(async () => {
        throw new Error('spawn failed')
      }),
    })
    register(orch)

    const handler = handlers.get('update:install')!
    await expect(handler({}, {})).rejects.toThrow(/spawn failed/)
    // install 失败 → 清 preloaded 标志
    expect(preloadedMocks.clearPreloadedUpdate).toHaveBeenCalledTimes(1)
  })

  // ── update:install 推进度事件 ──────────────────────────────
  it('update:install：installUpdate onProgress → 推 update:progress 事件', async () => {
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({ release: FIXTURE, filePath: '/tmp/pre.zip' })
    const orch = mockOrchestrator({
      installUpdate: vi.fn(async (_rel, _fp, onProgress) => {
        onProgress?.('replacing', 50)
        return { triggerRestart: false }
      }),
    })
    register(orch)

    const handler = handlers.get('update:install')!
    await handler({}, {})

    expect(sendSpy).toHaveBeenCalledWith('update:progress', { stage: 'replacing', percent: 50 })
  })

  // ── update:getPreloaded 有效产物 → 返回 {release,filePath} ───
  it('update:getPreloaded：有有效预下载产物 → 返回 {release, filePath}', async () => {
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue({ release: FIXTURE, filePath: '/tmp/pre.zip' })
    const orch = mockOrchestrator()
    register(orch)

    const handler = handlers.get('update:getPreloaded')!
    const result = await handler({}, {})
    expect(result).toEqual({ release: FIXTURE, filePath: '/tmp/pre.zip' })
  })

  // ── update:getPreloaded 无产物 → 返回 null ──────────────────
  it('update:getPreloaded：无预下载产物 → 返回 null', async () => {
    preloadedMocks.readPreloadedUpdateRaw.mockResolvedValue(null)
    const orch = mockOrchestrator()
    register(orch)

    const handler = handlers.get('update:getPreloaded')!
    const result = await handler({}, {})
    expect(result).toBeNull()
  })
})

// ── D3s：UPDATE_ERROR_MESSAGES suggestion 文案中性化（多源 update-multi-source §7.3）──
describe('D3s update types: UPDATE_NETWORK_FAILED suggestion 文案', () => {
  it('suggestion 无 GitHub 专名（双源时代用户可能恒走 GitCode），且保留网络/防火墙排查指引', async () => {
    const { UPDATE_ERROR_MESSAGES } = await import('../update/types.js')
    const suggestion = UPDATE_ERROR_MESSAGES.UPDATE_NETWORK_FAILED.suggestion
    // 去 GitHub 专名（大小写两种形态都断言，防「github.com」式回潮）
    expect(suggestion).not.toContain('GitHub')
    expect(suggestion).not.toContain('github')
    // 保留可操作性：仍指向网络/防火墙排查动作
    expect(suggestion).toContain('网络')
    expect(suggestion).toContain('防火墙')
  })
})
