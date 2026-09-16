/**
 * W3 TDD 测试：orchestrator（升级流程编排器）。
 *
 * 覆盖场景 W3TC8-9：
 *   W3TC8 mac 完整流程：downloadAsset mock → prepareUpdate mock 返回 detached-script
 *         → triggerRestart=true + onProgress 推 downloading/replacing
 *   W3TC9 linux deb：prepareUpdate mock 抛 UpdateUnsupportedError → orchestrator 透传
 *
 * Mock 策略：vi.hoisted + vi.mock download-asset / platform-updater / electron。
 *   - downloadAsset 返回固定 filePath，不真下载
 *   - createPlatformUpdater 返回桩 PlatformUpdater，控制 prepareUpdate 返回值/抛错
 *   - electron app 仅占位（orchestrator 本身不直接用 app）
 *   - process.platform 经 Object.defineProperty 桩为 darwin/linux
 *
 * 运行：cd apps/electron/main && npx vitest run test/orchestrator.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { LatestReleaseInfo } from '@taiji/shared'
import { UpdateError, UpdateIntegrityError } from '../update/types.js'
import type { UpdateScriptRef, UpdateErrorCode } from '../update/types.js'
import type { IReleaseChecker } from '../interfaces.js'

// ── 必须在 import constants（间接被 orchestrator import）前设 ──────
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'w3-orch-'))
process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

// ── vi.hoisted：稳定的 mock 引用 ──────────────────────────────────
const downloadMocks = vi.hoisted(() => ({
  downloadAsset: vi.fn(),
}))
const platformMocks = vi.hoisted(() => ({
  createPlatformUpdater: vi.fn(),
}))
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('../update/download-asset.js', () => ({
  downloadAsset: downloadMocks.downloadAsset,
}))
vi.mock('../update/platform-updater.js', () => ({
  createPlatformUpdater: platformMocks.createPlatformUpdater,
}))
vi.mock('node:child_process', () => ({
  spawn: childProcessMocks.spawn,
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.8.14' },
}))

// 动态 import：env + mock 已就绪
async function loadModule() {
  return await import('../update/orchestrator.js')
}

/** LatestReleaseInfo fixture（mac + linux 都覆盖） */
const MAC_RELEASE: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '',
  publishedAt: '',
  htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
  assets: {
    macArm64Dmg: { name: 'mac.dmg', downloadUrl: 'https://x/mac.dmg', size: 1000, sha256: 'a'.repeat(64) },
    linuxX64AppImage: { name: 'app.AppImage', downloadUrl: 'https://x/app', size: 3000 },
  },
}

describe('W3: orchestrator (W3TC8-9)', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let originalArch: PropertyDescriptor | undefined

  beforeEach(async () => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    // darwin 用例的隐含环境是 Apple Silicon（m8 守卫 downloadUpdate 拒 Intel mac）：
    // CI 在 x64 runner 上跑，若不桩 arch，darwin+x64 会误命中架构门控抛
    // UpdateUnsupportedError——本地 arm64 全绿、CI 恒红的根因
    originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    vi.clearAllMocks()
    // spawn 桩：返回带 unref 的假 ChildProcess（win installer 路径会真 spawn）
    childProcessMocks.spawn.mockReturnValue({ unref: vi.fn() })
    await loadModule()
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    if (originalArch) Object.defineProperty(process, 'arch', originalArch)
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  // ── W3TC8：mac 完整流程 ────────────────────────────────────────
  it('W3TC8: mac detached-script 流程 → triggerRestart=true + replacing 进度 + result 落盘无 .tmp 残留', async () => {
    setPlatform('darwin')
    // platform-updater 桩：返回 detached-script
    const detachedRef: UpdateScriptRef = { kind: 'detached-script', scriptPath: '/tmp/updater.sh' }
    platformMocks.createPlatformUpdater.mockReturnValue({
      prepareUpdate: vi.fn(() => detachedRef),
    })

    // 批次 3 删 update:perform（m17）后组合函数 performUpdate 移除：下载阶段由
    // downloadUpdate 独立承载，安装阶段入口 = installUpdate
    const { installUpdate } = await loadModule()
    const onProgress = vi.fn()
    const result = await installUpdate(MAC_RELEASE, '/tmp/downloaded.zip', onProgress)

    // detached-script → triggerRestart=true（mac/linux 已在 prepareUpdate 内 spawn）
    expect(result).toEqual({ triggerRestart: true })
    // onProgress 推 replacing 阶段
    const stages = onProgress.mock.calls.map((c) => c[0])
    expect(stages).toContain('replacing')
    expect(onProgress).toHaveBeenCalledWith('replacing', 100)
    // update-result.json status='replacing' 已写（批次 5 原子写）：终态正确且无 .tmp 残留
    const resultFile = path.join(TMP_DATA_DIR, 'update', 'update-result.json')
    expect(existsSync(resultFile)).toBe(true)
    expect(existsSync(`${resultFile}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(resultFile, 'utf-8')).status).toBe('replacing')
  })

  // ── W3TC8b：win 统一 detached-script 语义（批次 2：wrapper 在 prepareUpdate 内 spawn）──
  it('W3TC8b: win ref → detached-script 统一语义 → orchestrator 不 spawn 安装器 + triggerRestart=true', async () => {
    setPlatform('win32')
    // 改 WIN_RELEASE：需要 win asset
    const winRelease: LatestReleaseInfo = {
      ...MAC_RELEASE,
      assets: {
        winX64Exe: { name: 'setup.exe', downloadUrl: 'https://x/setup.exe', size: 2000, sha256: 'c'.repeat(64) },
      },
    }
    downloadMocks.downloadAsset.mockResolvedValue({ filePath: 'C:/tmp/setup.exe', multiPart: false, engine: 'undici' })
    // 三平台统一 detached-script：win 的 updater.cmd 已在 prepareUpdate 内 spawn（u2a）
    const detachedRef: UpdateScriptRef = {
      kind: 'detached-script',
      scriptPath: 'C:/Users/t/AppData/Local/taiji/update/updater.cmd',
    }
    platformMocks.createPlatformUpdater.mockReturnValue({
      prepareUpdate: vi.fn(() => detachedRef),
    })

    const { installUpdate } = await loadModule()
    const result = await installUpdate(winRelease, '/tmp/setup.exe')

    // detached-script → triggerRestart=true（与 mac/linux 同分支）
    expect(result).toEqual({ triggerRestart: true })
    // installUpdate 不走下载阶段（downloadAsset 不被调）
    expect(downloadMocks.downloadAsset).not.toHaveBeenCalled()
    // orchestrator 不再延迟 spawn NSIS 安装器（分支与延迟魔数已删）：全程零 spawn
    expect(childProcessMocks.spawn).not.toHaveBeenCalled()
  })

  // ── W3TC9：linux deb 抛 UpdateUnsupportedError ─────────────────
  it('W3TC9: prepareUpdate 抛 UpdateUnsupportedError → orchestrator 透传（含 fallbackUrl，installUpdate 路径）', async () => {
    setPlatform('linux')
    // platform-updater 桩：prepareUpdate 抛 UpdateUnsupportedError（模拟 deb 包 APPIMAGE 缺失）
    const { UpdateUnsupportedError } = await import('../update/types.js')
    const unsupportedErr = new UpdateUnsupportedError(
      'deb package does not support self-update',
      'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
    )
    platformMocks.createPlatformUpdater.mockReturnValue({
      prepareUpdate: vi.fn(() => { throw unsupportedErr }),
    })

    const { installUpdate } = await loadModule()
    await expect(
      installUpdate(MAC_RELEASE, '/tmp/app.AppImage', vi.fn()),
    ).rejects.toThrow(/deb package does not support self-update/)

    // 错误对象携带 fallbackUrl
    await expect(
      installUpdate(MAC_RELEASE, '/tmp/app.AppImage', vi.fn()).catch((e) => { throw e }),
    ).rejects.toMatchObject({ fallbackUrl: MAC_RELEASE.htmlUrl })
  })

  // ── W3TC9b：无 platform asset → 抛 UpdateError ─────────────────
  it('W3TC9b: 当前平台无 asset（如 unknown 平台）→ downloadUpdate 抛 UpdateError（含 release 页链接）', async () => {
    setPlatform('freebsd')
    // performUpdate 组合函数已随批次 3 删除：无 asset 守卫在 downloadUpdate 内（pickPlatformAsset）
    const { downloadUpdate } = await loadModule()
    // 批次 3 §3.3.3-D：断供错误信息并入 release.htmlUrl——存量 darwin 用户
    // （本版本起只发 dmg）报错时有一键手动下载出路（错误信息可操作）
    await expect(
      downloadUpdate(MAC_RELEASE),
    ).rejects.toThrow(
      `no asset for platform freebsd (release page: ${MAC_RELEASE.htmlUrl})`,
    )
    // downloadAsset 不应被调
    expect(downloadMocks.downloadAsset).not.toHaveBeenCalled()
  })

  // ── W3TC10：downloadUpdate 拆分函数 ────────────────────────────
  // downloadUpdate = pickAsset + 写 replacing 标记 + downloadAsset 下载校验。
  // 与 performUpdate 的下载阶段共享 downloading 锁，独立 onProgress（仅下载百分比）。
  it('W3TC10: downloadUpdate → downloadAsset mock 返回 {filePath}，透传给调用方', async () => {
    setPlatform('darwin')
    downloadMocks.downloadAsset.mockResolvedValue({ filePath: '/tmp/x.zip', multiPart: false, engine: 'undici' })

    const { downloadUpdate } = await loadModule()
    const result = await downloadUpdate(MAC_RELEASE)

    // 返回 downloadAsset 桩的 filePath（不触发替换阶段）
    expect(result).toEqual({ filePath: '/tmp/x.zip' })
    // downloadAsset 被调一次，传入了 darwin 平台的 mac asset
    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
    const downloadArg = downloadMocks.downloadAsset.mock.calls[0][0]
    expect(downloadArg.name).toBe('mac.dmg')
    // downloadUpdate 不再写 replacing 标记（T2：迁移到 installUpdate）。
    // 预下载只下载不替换，写 replacing 会导致 self-healer 误判需要回滚。
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'update-result.json'))).toBe(false)
  })

  it('W3TC10b: downloadUpdate onProgress 透传给 downloadAsset（仅下载百分比）', async () => {
    setPlatform('darwin')
    downloadMocks.downloadAsset.mockImplementation(async (_asset, onProgress) => {
      onProgress?.(25)
      onProgress?.(75)
      return { filePath: '/tmp/x.zip' }
    })

    const { downloadUpdate } = await loadModule()
    const onProgress = vi.fn()
    await downloadUpdate(MAC_RELEASE, onProgress)

    // downloadAsset 收到的 onProgress 就是调用方传的（百分比透传）
    const receivedCb = downloadMocks.downloadAsset.mock.calls[0][1]
    expect(receivedCb).toBe(onProgress)
    // 推送的百分比经透传到达调用方回调
    expect(onProgress).toHaveBeenCalledWith(25)
    expect(onProgress).toHaveBeenCalledWith(75)
  })

  it('W3TC10c: downloadUpdate 重入 → 抛 UpdateError（downloading 锁互斥）', async () => {
    setPlatform('darwin')
    // 用 gate 让第一次 downloadUpdate 挂起（downloading 锁持有中），触发第二次重入
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    downloadMocks.downloadAsset.mockImplementation(async () => {
      await gate // 阻塞直到 releaseGate
      return { filePath: '/tmp/x.zip', multiPart: false, engine: 'undici' }
    })

    const { downloadUpdate } = await loadModule()
    const first = downloadUpdate(MAC_RELEASE)
    // 让事件循环跑一轮确保 first 进入 downloadAsset（拿到锁）
    await Promise.resolve()
    // 第二次重入：downloading 锁持有中 → 抛 UpdateError
    await expect(downloadUpdate(MAC_RELEASE)).rejects.toThrow(/download already in progress/)
    // 释放第一次，让其正常结束（finally 释放锁），避免污染后续用例
    releaseGate()
    await first
  })

  // ── W3TC11：installUpdate 拆分函数 ─────────────────────────────
  // installUpdate = createPlatformUpdater.prepareUpdate + handleScriptRef。
  // 与 performUpdate 的替换阶段共享 updating 锁。
  it('W3TC11: installUpdate detached-script → 返回 {triggerRestart:true} + prepareUpdate 被调', async () => {
    setPlatform('darwin')
    const detachedRef: UpdateScriptRef = { kind: 'detached-script', scriptPath: '/tmp/updater.sh' }
    // 显式参数签名：prepareUpdate(filePath, release)，让 mock.calls 元组有元素可解构
    const prepareUpdate = vi.fn((_filePath: string, _release: LatestReleaseInfo): UpdateScriptRef => detachedRef)
    platformMocks.createPlatformUpdater.mockReturnValue({ prepareUpdate })

    const { installUpdate } = await loadModule()
    const onProgress = vi.fn()
    const result = await installUpdate(MAC_RELEASE, '/tmp/x.zip', onProgress)

    expect(result).toEqual({ triggerRestart: true })
    // createPlatformUpdater 被调
    expect(platformMocks.createPlatformUpdater).toHaveBeenCalledTimes(1)
    // prepareUpdate 收到 downloadUpdate 的 filePath + release
    expect(prepareUpdate).toHaveBeenCalledTimes(1)
    expect(prepareUpdate).toHaveBeenCalledWith('/tmp/x.zip', MAC_RELEASE)
    // onProgress 推 replacing 阶段（0 起、100 完）
    expect(onProgress).toHaveBeenCalledWith('replacing', 0)
    expect(onProgress).toHaveBeenCalledWith('replacing', 100)
    // T2：replacing 标记由 installUpdate 写入（self-healer 检测中断的关键信号）
    expect(existsSync(path.join(TMP_DATA_DIR, 'update', 'update-result.json'))).toBe(true)
  })

  it('W3TC11b: installUpdate detached-script 在 prepareUpdate 内 spawn（断言 spawn 被调）', async () => {
    setPlatform('darwin')
    // 真实 detached-script 流程：prepareUpdate 内 spawn detached bash（与 mac updater 行为一致）
    // 这里用 mock 的 prepareUpdate 显式调 spawn 模拟 mac updater 的 spawn 行为
    const detachedRef: UpdateScriptRef = { kind: 'detached-script', scriptPath: '/tmp/updater.sh' }
    platformMocks.createPlatformUpdater.mockReturnValue({
      prepareUpdate: vi.fn((_file, _release) => {
        // 模拟 mac updater.prepareUpdate 内 spawn detached bash 写替换脚本 + 触发执行
        childProcessMocks.spawn('/tmp/updater.sh', ['arg1'], { detached: true, stdio: 'ignore' })
        return detachedRef
      }),
    })

    const { installUpdate } = await loadModule()
    const result = await installUpdate(MAC_RELEASE, '/tmp/x.zip')

    expect(result).toEqual({ triggerRestart: true })
    // prepareUpdate 内 spawn 了 detached bash（orchestrator 透传给 handleScriptRef 不再 spawn）
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
    const [exe, args, opts] = childProcessMocks.spawn.mock.calls[0]
    expect(exe).toBe('/tmp/updater.sh')
    expect(args).toEqual(['arg1'])
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
  })
})

// ════════════════════════════════════════════════════════════════════
// 下载段跨源降级（update-multi-source u-download-failover：§6.5 D5 / §6.7 D7 / §6.8 D8）
//
// 覆盖：
//   - 触发集合四值 errorCode 各触发降级（by-tag 确认 → 仅替换 downloadUrl 续传）
//   - UpdateIntegrityError / source undefined / 触发集合外 errorCode 均不降级（反向断言）
//   - 对侧 by-tag null（404 发布时间窗）与 200 但目标 asset 缺失（部分同步失败窗口）
//     两形态同语义：保留断点、原错误上抛
//   - 对侧 by-tag 网络失败 / 降级续传也失败 → 原错误上抛；续传产物 sha 不符 → 原样上抛（D8）
//   - logSourceFailover(segment=download) / logDownloadSuccess 落盘断言
//   - totalBytes 三组合（一致续传 / 不一致转全量 / state 缺失从零）走真实 download-asset
//     链路（importActual 转发 + stub 全局 fetch + 真实临时目录），锚定「复用 temp+state、
//     仅替换 downloadUrl」的输入契约由 download-asset 既有守卫承接
// ════════════════════════════════════════════════════════════════════

/** 本源（GitHub）胜出 asset（temp 键控 name + 完整性基准的锚定形态） */
const SOURCE_ASSET = {
  name: 'mac.dmg',
  downloadUrl: 'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/mac.dmg',
  size: 1000,
  sha256: 'a'.repeat(64),
}

/** 本源 release（source=github） */
const RELEASE_FROM_GITHUB: LatestReleaseInfo = {
  ...MAC_RELEASE,
  source: 'github',
  assets: { macArm64Dmg: { ...SOURCE_ASSET } },
}

/** 对侧（GitCode）by-tag 返回：tagName 一致 + 同名 asset（downloadUrl 落 gitcode.com） */
const SIDE_RELEASE_GITCODE: LatestReleaseInfo = {
  ...MAC_RELEASE,
  source: 'gitcode',
  assets: {
    macArm64Dmg: {
      name: 'mac.dmg',
      downloadUrl: 'https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.9.0/mac.dmg',
      size: 1000,
      // 对侧 normalize 无 manifest 填充时 sha256 可能与源侧不同/缺失——降级续传必须
      // 保持本源完整性基准（断言第二次 downloadAsset 收到 sha256 = 本源值）
      sha256: 'b'.repeat(64),
    },
  },
}

/** 构造降级触发用网络类错误（message 内嵌 errorCode 供上抛断言） */
function makeNetError(errorCode: UpdateErrorCode): UpdateError {
  return new UpdateError(`download network failure (${errorCode})`, 'downloading', errorCode)
}

/** 构造仅含 fetchReleaseByTag 的 mock IReleaseChecker（orchestrator 降级链唯一消费面） */
function makeSideChecker(): { checker: IReleaseChecker; fetchReleaseByTag: ReturnType<typeof vi.fn> } {
  const fetchReleaseByTag = vi.fn()
  return { checker: { fetchReleaseByTag } as unknown as IReleaseChecker, fetchReleaseByTag }
}

/** 读 update-error.log（TMP 隔离目录）为 JSON 行数组 */
function readUpdateErrorLog(): Array<Record<string, unknown>> {
  const logPath = path.join(TMP_DATA_DIR, 'update', 'update-error.log')
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('u-download-failover: 下载段跨源降级（mock 双引擎失败注入）', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let originalArch: PropertyDescriptor | undefined

  beforeEach(async () => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    vi.clearAllMocks()
    childProcessMocks.spawn.mockReturnValue({ unref: vi.fn() })
    await loadModule()
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    if (originalArch) Object.defineProperty(process, 'arch', originalArch)
    vi.restoreAllMocks()
    const updateDir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  /** 装配一次「主源失败 → 对侧续传成功」的 mock 序列，返回断言句柄（side 返回值含扩展观测字段） */
  function arrangePrimaryFailSideSucceed(errorCode: UpdateErrorCode, sideRelease: LatestReleaseInfo | null) {
    const { checker, fetchReleaseByTag } = makeSideChecker()
    fetchReleaseByTag.mockResolvedValue(sideRelease)
    downloadMocks.downloadAsset
      .mockImplementationOnce(async () => { throw makeNetError(errorCode) })
      .mockResolvedValueOnce({ filePath: '/tmp/side-resumed.bin', multiPart: true, engine: 'undici' })
    return { checker, fetchReleaseByTag }
  }

  // ── 触发集合四值白名单 ─────────────────────────────────────────
  it('四值网络 errorCode 各触发降级：by-tag(对侧, tag) 确认后仅替换 downloadUrl 续传（sha256/size 保持本源基准）', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const triggerCodes = [
      'UPDATE_NETWORK_FAILED',
      'UPDATE_NETWORK_TIMEOUT',
      'UPDATE_PROXY_ERROR',
      'UPDATE_PROXY_UNREACHABLE',
    ] as const
    for (const code of triggerCodes) {
      vi.clearAllMocks()
      const { checker, fetchReleaseByTag } = arrangePrimaryFailSideSucceed(code, SIDE_RELEASE_GITCODE)

      const result = await downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker })

      // 降级发生：对侧源 by-tag 精确查询（经 IReleaseChecker 接口）
      expect(fetchReleaseByTag).toHaveBeenCalledTimes(1)
      expect(fetchReleaseByTag).toHaveBeenCalledWith('gitcode', 'v0.9.0')
      // 第二次 downloadAsset = 对侧 downloadUrl + 本源完整性基准（仅替换 downloadUrl）
      expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(2)
      const sideAssetArg = downloadMocks.downloadAsset.mock.calls[1][0]
      expect(sideAssetArg.downloadUrl).toBe(SIDE_RELEASE_GITCODE.assets.macArm64Dmg!.downloadUrl)
      expect(sideAssetArg.name).toBe(SOURCE_ASSET.name)
      expect(sideAssetArg.sha256).toBe(SOURCE_ASSET.sha256)
      expect(sideAssetArg.size).toBe(SOURCE_ASSET.size)
      // 返回对侧续传产物路径
      expect(result).toEqual({ filePath: '/tmp/side-resumed.bin' })
    }
  })

  it('source=gitcode → 对侧为 github（补集双向覆盖）', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const releaseFromGitcode: LatestReleaseInfo = {
      ...RELEASE_FROM_GITHUB,
      source: 'gitcode',
      assets: { macArm64Dmg: { ...SOURCE_ASSET, downloadUrl: 'https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.9.0/mac.dmg' } },
    }
    const { checker, fetchReleaseByTag } = makeSideChecker()
    fetchReleaseByTag.mockResolvedValue({ ...SIDE_RELEASE_GITCODE, source: 'github' })
    downloadMocks.downloadAsset
      .mockImplementationOnce(async () => { throw makeNetError('UPDATE_NETWORK_FAILED') })
      .mockResolvedValueOnce({ filePath: '/tmp/side-resumed.bin', multiPart: true, engine: 'undici' })

    await downloadUpdate(releaseFromGitcode, undefined, { releaseChecker: checker })

    expect(fetchReleaseByTag).toHaveBeenCalledWith('github', 'v0.9.0')
  })

  // ── 反向断言：不触发降级的形态 ─────────────────────────────────
  it('UpdateIntegrityError 不触发降级（D8 安全边界）：零 by-tag、零二次下载、原错误上抛', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const { checker, fetchReleaseByTag } = makeSideChecker()
    downloadMocks.downloadAsset.mockRejectedValue(
      new UpdateIntegrityError('sha256 mismatch: expected a..a', 'UPDATE_SHA256_MISMATCH'),
    )

    await expect(
      downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker }),
    ).rejects.toThrow(/sha256 mismatch/)

    expect(fetchReleaseByTag).not.toHaveBeenCalled()
    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
  })

  it('release.source undefined（旧落盘 pending/preloaded 文件）不降级：原错误上抛、零 by-tag', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const legacyRelease: LatestReleaseInfo = { ...MAC_RELEASE, source: undefined }
    const { checker, fetchReleaseByTag } = makeSideChecker()
    downloadMocks.downloadAsset.mockRejectedValue(makeNetError('UPDATE_NETWORK_FAILED'))

    await expect(
      downloadUpdate(legacyRelease, undefined, { releaseChecker: checker }),
    ).rejects.toThrow(/download network failure/)

    expect(fetchReleaseByTag).not.toHaveBeenCalled()
    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
  })

  it('触发集合外 errorCode 不降级（DISK_SPACE / FILE_RENAME_FAILED / PERMISSION_DENIED）', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const excludedCodes = [
      'UPDATE_DISK_SPACE',
      'UPDATE_FILE_RENAME_FAILED',
      'UPDATE_PERMISSION_DENIED',
    ] as const
    for (const code of excludedCodes) {
      vi.clearAllMocks()
      const { checker, fetchReleaseByTag } = makeSideChecker()
      downloadMocks.downloadAsset.mockRejectedValue(makeNetError(code))

      await expect(
        downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker }),
      ).rejects.toThrow(code)

      expect(fetchReleaseByTag).not.toHaveBeenCalled()
      expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
    }
  })

  // ── 对侧不可用两形态 + tagName 防御 ────────────────────────────
  it('对侧 by-tag null（404 发布时间窗）→ 不降级：保留断点（零二次下载）、原错误上抛', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const { checker, fetchReleaseByTag } = makeSideChecker()
    fetchReleaseByTag.mockResolvedValue(null)
    downloadMocks.downloadAsset.mockRejectedValue(makeNetError('UPDATE_NETWORK_FAILED'))

    await expect(
      downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker }),
    ).rejects.toThrow(/download network failure/)

    expect(fetchReleaseByTag).toHaveBeenCalledTimes(1)
    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
    // 对侧不可用 = 未发生降级：无 source-failover 登记
    expect(readUpdateErrorLog().filter((e) => e['source'] === 'source-failover')).toHaveLength(0)
  })

  it('by-tag 200 但目标 asset 缺失（部分同步失败窗口）→ 同语义不降级、原错误上抛', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    // 两形态：assets 全空 / 同键位 asset name 不一致（同名上传不变量破坏）
    const partialForms: Array<LatestReleaseInfo> = [
      { ...SIDE_RELEASE_GITCODE, assets: {} },
      {
        ...SIDE_RELEASE_GITCODE,
        assets: { macArm64Dmg: { ...SIDE_RELEASE_GITCODE.assets.macArm64Dmg!, name: 'renamed.dmg' } },
      },
    ]
    for (const sideRelease of partialForms) {
      vi.clearAllMocks()
      const { checker, fetchReleaseByTag } = makeSideChecker()
      fetchReleaseByTag.mockResolvedValue(sideRelease)
      downloadMocks.downloadAsset.mockRejectedValue(makeNetError('UPDATE_NETWORK_FAILED'))

      await expect(
        downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker }),
      ).rejects.toThrow(/download network failure/)

      expect(fetchReleaseByTag).toHaveBeenCalledTimes(1)
      expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
    }
  })

  it('by-tag 返回 tagName 与请求不一致（防御）→ 不降级、原错误上抛', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const { checker, fetchReleaseByTag } = makeSideChecker()
    fetchReleaseByTag.mockResolvedValue({ ...SIDE_RELEASE_GITCODE, tagName: 'v0.9.1' })
    downloadMocks.downloadAsset.mockRejectedValue(makeNetError('UPDATE_NETWORK_FAILED'))

    await expect(
      downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker }),
    ).rejects.toThrow(/download network failure/)

    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(1)
  })

  // ── 降级链失败语义 ─────────────────────────────────────────────
  it('对侧 by-tag 网络失败 → 原错误上抛（对侧错误不外泄、不误报）', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const { checker, fetchReleaseByTag } = makeSideChecker()
    fetchReleaseByTag.mockRejectedValue(new Error('side source network down'))
    downloadMocks.downloadAsset.mockRejectedValue(makeNetError('UPDATE_NETWORK_FAILED'))

    const thrown = await downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker }).then(
      () => { throw new Error('expected downloadUpdate to reject') },
      (e: unknown) => e as UpdateError,
    )
    // 上抛的是原错误而非对侧错误（§7.4：降级链失败不改变用户可见错误形态）
    expect(thrown.message).toMatch(/download network failure/)
    expect(thrown.errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(thrown.message).not.toContain('side source network down')
  })

  it('降级续传也网络失败 → 原错误上抛（§7.4 下载-双源行），failover 已登记', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const { checker, fetchReleaseByTag } = makeSideChecker()
    fetchReleaseByTag.mockResolvedValue(SIDE_RELEASE_GITCODE)
    downloadMocks.downloadAsset
      .mockImplementationOnce(async () => { throw makeNetError('UPDATE_NETWORK_FAILED') })
      .mockImplementationOnce(async () => { throw makeNetError('UPDATE_NETWORK_TIMEOUT') })

    await expect(
      downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker }),
    ).rejects.toMatchObject({
      message: /download network failure \(UPDATE_NETWORK_FAILED\)/,
      errorCode: 'UPDATE_NETWORK_FAILED',
    })

    expect(fetchReleaseByTag).toHaveBeenCalledTimes(1)
    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(2)
    // 降级确实发生（转向对侧）：source-failover 已落盘；但终态错误 = 原错误
    const failovers = readUpdateErrorLog().filter((e) => e['source'] === 'source-failover')
    expect(failovers).toHaveLength(1)
    expect(failovers[0]).toMatchObject({ from: 'github', to: 'gitcode', errorCode: 'UPDATE_NETWORK_FAILED' })
  })

  it('降级续传产物 sha 不符（UpdateIntegrityError）→ 原样上抛不被吞（D8：完整性错误不降格为网络错误）', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const { checker, fetchReleaseByTag } = makeSideChecker()
    fetchReleaseByTag.mockResolvedValue(SIDE_RELEASE_GITCODE)
    downloadMocks.downloadAsset
      .mockImplementationOnce(async () => { throw makeNetError('UPDATE_NETWORK_FAILED') })
      .mockRejectedValueOnce(new UpdateIntegrityError('side sha256 mismatch'))

    await expect(
      downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker }),
    ).rejects.toThrow(/side sha256 mismatch/)
  })

  // ── 诊断落盘 ───────────────────────────────────────────────────
  it('降级成功：logSourceFailover(segment=download) 落盘 + logDownloadSuccess 落盘（multiPart/engine 为对侧续传真实值）', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    const { checker, fetchReleaseByTag } = arrangePrimaryFailSideSucceed(
      'UPDATE_PROXY_UNREACHABLE',
      SIDE_RELEASE_GITCODE,
    )

    await downloadUpdate(RELEASE_FROM_GITHUB, undefined, { releaseChecker: checker })

    const entries = readUpdateErrorLog()
    const failover = entries.find((e) => e['source'] === 'source-failover')
    expect(failover).toBeDefined()
    expect(failover).toMatchObject({
      from: 'github',
      to: 'gitcode',
      errorCode: 'UPDATE_PROXY_UNREACHABLE',
      stage: 'downloading',
    })
    const success = entries.find((e) => e['source'] === 'download-success')
    expect(success).toBeDefined()
    // downloadAsset 返回值扩展后透传真实观测值（此处 mock 为对侧续传成功形态）
    expect(success).toMatchObject({ releaseSource: 'github', multiPart: true, engine: 'undici' })
  })

  it('正常（未降级）下载成功：logDownloadSuccess 落盘一条、multiPart/engine 透传 downloadAsset 返回值', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    downloadMocks.downloadAsset.mockResolvedValue({
      filePath: '/tmp/x.zip',
      multiPart: true,
      engine: 'undici',
    })

    await downloadUpdate(RELEASE_FROM_GITHUB)

    const entries = readUpdateErrorLog()
    expect(entries.filter((e) => e['source'] === 'download-success')).toHaveLength(1)
    expect(entries.filter((e) => e['source'] === 'source-failover')).toHaveLength(0)
    const success = entries.find((e) => e['source'] === 'download-success')
    expect(success).toMatchObject({ multiPart: true, engine: 'undici', releaseSource: 'github' })
  })

  it('curl 引擎接管成功：download-success 透传 engine=curl（S1 断言失败先核对 engine 字段的观测前提）', async () => {
    setPlatform('darwin')
    const { downloadUpdate } = await loadModule()
    downloadMocks.downloadAsset.mockResolvedValue({
      filePath: '/tmp/x.zip',
      multiPart: false,
      engine: 'curl',
    })

    await downloadUpdate(RELEASE_FROM_GITHUB)

    const success = readUpdateErrorLog().find((e) => e['source'] === 'download-success')
    expect(success).toMatchObject({ multiPart: false, engine: 'curl' })
  })
})

// ── 跨源续传 totalBytes 三组合（§11.4：真实 download-asset 链路 + stub 全局 fetch）──

describe('u-download-failover: totalBytes 三组合（真实 download-asset + stub fetch）', () => {
  const FULL_SIZE = 100
  /** 100 字节确定性内容（值域 0-250 合法字节） */
  const FULL_BYTES = Buffer.from(Array.from({ length: FULL_SIZE }, (_, i) => i % 251))
  const FULL_SHA256 = createHash('sha256').update(FULL_BYTES).digest('hex')

  const RESUME_ASSET = {
    name: 'side-resume.dmg',
    downloadUrl: 'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/side-resume.dmg',
    size: FULL_SIZE,
    sha256: FULL_SHA256,
  }
  const SIDE_RESUME_URL = 'https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.9.0/side-resume.dmg'
  const RESUME_RELEASE: LatestReleaseInfo = {
    ...MAC_RELEASE,
    source: 'github',
    assets: { macArm64Dmg: { ...RESUME_ASSET } },
  }

  const updateDir = path.join(TMP_DATA_DIR, 'update')
  const tempPath = path.join(updateDir, `${RESUME_ASSET.name}.downloading`)
  const finalPath = path.join(updateDir, RESUME_ASSET.name)
  const statePath = path.join(updateDir, 'resume-state.json')

  let originalPlatform: PropertyDescriptor | undefined
  let originalArch: PropertyDescriptor | undefined

  beforeEach(async () => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    vi.clearAllMocks()
    await loadModule()
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    if (originalArch) Object.defineProperty(process, 'arch', originalArch)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /**
   * 装配降级 + 真实 download-asset 链路：第一次（主源）由 mock 抛网络错误（避免卷入
   * curl 引擎降级链），第二次（对侧）转发到真实 downloadAsset，fetch 按 Range 头分流
   * 206/200。asset.size=100 < MIN_MULTI_PART_SIZE → 真实链路必走单段（不触发 probe）。
   */
  async function arrangeRealSideDownload(
    sideTotalBytes = FULL_SIZE,
  ): Promise<{ fetchMock: ReturnType<typeof vi.fn>; checker: IReleaseChecker }> {
    const actual = await vi.importActual<typeof import('../update/download-asset.js')>('../update/download-asset.js')
    const { checker, fetchReleaseByTag } = makeSideChecker()
    fetchReleaseByTag.mockResolvedValue({
      ...SIDE_RELEASE_GITCODE,
      assets: { macArm64Dmg: { name: RESUME_ASSET.name, downloadUrl: SIDE_RESUME_URL, size: FULL_SIZE, sha256: FULL_SHA256 } },
    })
    downloadMocks.downloadAsset
      .mockImplementationOnce(async () => { throw makeNetError('UPDATE_NETWORK_FAILED') })
      .mockImplementationOnce(actual.downloadAsset)

    const fetchMock = vi.fn(async (url: string | URL | globalThis.Request, init?: RequestInit) => {
      expect(String(url)).toBe(SIDE_RESUME_URL)
      const range = (init?.headers as Record<string, string> | undefined)?.Range
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)![1])
        const body = FULL_BYTES.subarray(start)
        return new Response(body, {
          status: 206,
          headers: {
            'content-length': String(body.length),
            'content-range': `bytes ${start}-${sideTotalBytes - 1}/${sideTotalBytes}`,
          },
        })
      }
      return new Response(FULL_BYTES, {
        status: 200,
        headers: { 'content-length': String(FULL_BYTES.length) },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    return { fetchMock, checker }
  }

  /** 预置断点现场：temp 前 40 字节 + resume-state */
  function seedBreakpoint(totalBytes: number): void {
    mkdirSync(updateDir, { recursive: true })
    writeFileSync(tempPath, FULL_BYTES.subarray(0, 40))
    writeFileSync(statePath, JSON.stringify({
      downloadedBytes: 40,
      totalBytes,
      tempPath,
      finalPath,
    }))
  }

  it('组合 A：对侧 totalBytes 与 state 一致 → 从断点 206 续传，产物 = 断点前缀 + 对侧剩余字节', async () => {
    seedBreakpoint(FULL_SIZE)
    const { fetchMock, checker } = await arrangeRealSideDownload(FULL_SIZE)
    const { downloadUpdate } = await loadModule()

    // 主源网络失败 → 降级对侧：以断点 40 字节为 Range 起点续传，sha256（本源基准）校验过
    const result = await downloadUpdate(RESUME_RELEASE, undefined, { releaseChecker: checker })

    // 降级输入契约：第二次 downloadAsset = 对侧 URL + 本源完整性基准
    expect(downloadMocks.downloadAsset).toHaveBeenCalledTimes(2)
    expect(downloadMocks.downloadAsset.mock.calls[1][0]).toMatchObject({
      name: RESUME_ASSET.name,
      downloadUrl: SIDE_RESUME_URL,
      sha256: FULL_SHA256,
    })
    // 续传发生：仅一次真实请求且带 Range: bytes=40-（复用本源断点，非全量）
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Range).toBe('bytes=40-')
    // 产物 = 断点前缀 + 对侧剩余字节（拼接正确），断点 state 已被校验链清理
    expect(readFileSync(finalPath)).toEqual(FULL_BYTES)
    expect(existsSync(statePath)).toBe(false)
    expect(result).toEqual({ filePath: finalPath })
    // 真实单段链路的 download-success 观测值：multiPart=false（size < 多段阈值）+ engine=undici
    const success = readUpdateErrorLog().find((e) => e['source'] === 'download-success')
    expect(success).toMatchObject({ multiPart: false, engine: 'undici', releaseSource: 'github' })
  })

  it('组合 B：对侧 totalBytes 与 state 不一致（超容差）→ 既有守卫触发转全量（206→无 Range 200），全量产物正确落位', async () => {
    // state 错记 total=5000，对侧真实 total=100 → 差值超 TOTAL_BYTES_TOLERANCE(1024)
    seedBreakpoint(5000)
    const { fetchMock, checker } = await arrangeRealSideDownload(FULL_SIZE)
    const { downloadUpdate } = await loadModule()

    // [实施期发现，download-asset 既有行为] 既有 m5 守卫触发 stale 转全量：递归重下
    // 成功、产物正确落位 finalPath，但递归 rename 后外层校验对已不存在的 temp 抛
    // ENOENT——该非完整性错误被跨源降级链按「续传失败」吞掉，终态 = 原错误上抛
    // （用户下次重试时无断点现场，从零全量成功，sha256 兜底不变）。本用例锚定该
    // 组合行为：守卫确实转全量 + 产物正确，失败面收敛于既有 ENOENT 而非内容损坏。
    await expect(
      downloadUpdate(RESUME_RELEASE, undefined, { releaseChecker: checker }),
    ).rejects.toMatchObject({ errorCode: 'UPDATE_NETWORK_FAILED' })

    // 两次请求：第一次带 Range（206 触发 stale 判定），作废重下第二次不带 Range（200 全量）
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstInit = fetchMock.mock.calls[0][1] as RequestInit
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit
    expect((firstInit.headers as Record<string, string>).Range).toBe('bytes=40-')
    expect((secondInit.headers as Record<string, string> | undefined)?.Range).toBeUndefined()
    // 转全量产物 = 完整内容（sha256 兜底通过），过期断点 state 与 temp 均已清理
    expect(readFileSync(finalPath)).toEqual(FULL_BYTES)
    expect(existsSync(statePath)).toBe(false)
    expect(existsSync(tempPath)).toBe(false)
  })

  it('组合 C：state 缺失（无断点现场）→ 对侧从零全量下载，产物正确', async () => {
    // 无 temp 无 state：downloadedBytes=0，请求不带 Range
    const { fetchMock, checker } = await arrangeRealSideDownload(FULL_SIZE)
    const { downloadUpdate } = await loadModule()

    const result = await downloadUpdate(RESUME_RELEASE, undefined, { releaseChecker: checker })

    expect(result).toEqual({ filePath: finalPath })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string> | undefined)?.Range).toBeUndefined()
    expect(readFileSync(finalPath)).toEqual(FULL_BYTES)
  })
})
