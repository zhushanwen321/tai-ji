/**
 * W3 TDD 测试：update-self-healer（启动自愈器）。
 *
 * 覆盖场景 W3TC11：
 *   W3TC11a status='replacing' + .old 存在 → 触发回滚 + 写 status='rolled-back'，返回 true
 *   W3TC11a-noop status='replacing' + .old 不存在（下载期失败）→ 写 status='no-op'，返回 false
 *   W3TC11b status='done' → no-op 返回 false（不回滚）
 *   W3TC11c update-result.json 不存在 → no-op 返回 false
 *   W3TC11d result 文件损坏（JSON 解析失败）→ 不抛，返回 false
 *
 * Mock 策略：用真实 fs（tmp 目录）写 update-result.json，self-healer 读 + 回滚。
 *   - mac 回滚路径：用真实 tmp 目录模拟 .app bundle + .old 备份
 *
 * 运行：cd apps/electron/main && npx vitest run test/update-self-healer.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── electron mock：cleanupCompletedUpdate 调 app.getVersion()，需桩为可控版本 ──
// vi.hoisted 保证 vi.mock 工厂能引用（vitest 会把 vi.mock 提升到文件顶部）。
const electronMock = vi.hoisted(() => ({ appVersion: '0.8.49' }))
vi.mock('electron', () => ({
  app: {
    getVersion: () => electronMock.appVersion,
  },
}))

// ── 必须在 import constants（间接被 self-healer import）前设 ────────
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'w3-healer-'))
process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

// 动态 import：env 已设
async function loadModule() {
  return await import('../update/update-self-healer.js')
}

describe('W3: update-self-healer (W3TC11)', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let originalExecPath: string
  const updateDir = path.join(TMP_DATA_DIR, 'update')
  const resultFile = path.join(updateDir, 'update-result.json')

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalExecPath = process.execPath
    vi.clearAllMocks()
    mkdirSync(updateDir, { recursive: true })
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true })
    vi.restoreAllMocks()
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 写 update-result.json */
  function writeResult(data: Record<string, unknown>): void {
    writeFileSync(resultFile, JSON.stringify(data))
  }

  // ── W3TC11c：result 文件不存在 → no-op ─────────────────────────
  it('W3TC11c: update-result.json 不存在 → 返回 false（no-op）', async () => {
    rmSync(resultFile, { force: true })
    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()
    expect(result).toBe(false)
  })

  // ── W3TC11b：status='done' → no-op ─────────────────────────────
  it('W3TC11b: status=done → 返回 false（终态不回滚）', async () => {
    writeResult({ status: 'done', version: '0.9.0', at: '2025-12-01T00:00:00Z' })
    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()
    expect(result).toBe(false)
    // result 文件未被改写（仍为 done）
    expect(JSON.parse(existsSync(resultFile) ? readFileSync(resultFile, 'utf-8') : '{}').status).toBe('done')
  })

  it('W3TC11b2: status=failed → 返回 false（终态不回滚）', async () => {
    writeResult({ status: 'failed', version: '0.9.0', at: '2025-12-01T00:00:00Z', error: 'sha mismatch' })
    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()
    expect(result).toBe(false)
  })

  // ── W3TC11a：status='replacing' + .old 不存在 → no-op ───────────
  // 语义：下载/校验阶段失败（download-asset 在替换前就失败，没产生 .old），
  //       原 app 未被改动 → 无需回滚，写 status='no-op' 返回 false。
  it('W3TC11a: status=replacing + .old 不存在（linux 无 APPIMAGE）→ 写 no-op，返回 false', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env.APPIMAGE // 无 APPIMAGE → getOldBackupPath() 返回 undefined
    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(false)
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('no-op')
  })

  // ── W3TC11a-linux-old：status=replacing + linux .old 存在 → 回滚 AppImage ─
  it('W3TC11a-linux-old: linux + APPIMAGE 设定 + .old 存在 → rm 半截 + mv .old 回来', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    // 用 tmp 目录模拟 AppImage（半截态）+ .old（备份）
    const tmpAppDir = mkdtempSync(path.join(tmpdir(), 'w3-linux-app-'))
    const appImage = path.join(tmpAppDir, 'TaiJi-x86_64.AppImage')
    const oldImage = `${appImage}.old`
    writeFileSync(appImage, 'half-installed')
    writeFileSync(oldImage, 'old-good-version')

    process.env.APPIMAGE = appImage
    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(true)
    // .old 已 mv 回 AppImage（半截态被 rm + .old 恢复）
    expect(existsSync(appImage)).toBe(true)
    expect(existsSync(oldImage)).toBe(false)
    expect(readFileSync(appImage, 'utf-8')).toBe('old-good-version')
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('rolled-back')

    rmSync(tmpAppDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── W3TC11a-linux-noop：status=replacing + linux APPIMAGE 设定但无 .old → no-op
  it('W3TC11a-linux-noop: linux + APPIMAGE 设定 + 无 .old → 写 no-op 返回 false', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    // APPIMAGE 指向一个不存在的路径（仅环境变量，不创建文件）
    const tmpAppDir = mkdtempSync(path.join(tmpdir(), 'w3-linux-noop-'))
    const appImage = path.join(tmpAppDir, 'TaiJi.AppImage')
    process.env.APPIMAGE = appImage
    // 不创建 appImage / appImage.old → getOldBackupPath() 返回的 .old 不存在 → no-op

    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(false)
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('no-op')

    rmSync(tmpAppDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── W3TC11a-mac：mac 平台 status=replacing + .old 存在 → 回滚 .app ─
  it('W3TC11a-mac: mac 平台 status=replacing + .old 备份存在 → rm 半截 + mv .old 回来', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    // 模拟 .app 目录结构（用 tmp 目录）：execPath = <tmpApp>/Contents/MacOS/TaiJi
    const tmpAppRoot = mkdtempSync(path.join(tmpdir(), 'w3-mac-app-'))
    const appBundle = path.join(tmpAppRoot, 'TaiJi.app')
    const oldBundle = `${appBundle}.old`
    // 创建假 .app（半截态）+ .old（备份）
    mkdirSync(path.join(appBundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(appBundle, 'Contents', 'MacOS', 'TaiJi'), 'half-installed')
    mkdirSync(path.join(oldBundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(oldBundle, 'Contents', 'MacOS', 'TaiJi'), 'old-good-version')
    // execPath 桩：<appBundle>/Contents/MacOS/TaiJi
    Object.defineProperty(process, 'execPath', {
      value: path.join(appBundle, 'Contents', 'MacOS', 'TaiJi'),
      configurable: true,
    })

    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(true)
    // .old 已 mv 回 .app（半截态被 rm + .old 恢复）
    expect(existsSync(appBundle)).toBe(true)
    expect(existsSync(oldBundle)).toBe(false)
    // .app 内容是 .old 的内容（old-good-version）
    expect(readFileSync(path.join(appBundle, 'Contents', 'MacOS', 'TaiJi'), 'utf-8')).toBe('old-good-version')
    // result 已写 rolled-back
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('rolled-back')

    // 清理
    rmSync(tmpAppRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── W3TC11a-mac-noop：mac 平台 status=replacing + 无 .old → no-op ─
  it('W3TC11a-mac-noop: mac 平台 status=replacing + 无 .old 备份 → 写 no-op 返回 false', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    // 模拟 .app 目录但无 .old（中断发生在下载期，未进入替换阶段）
    const tmpAppRoot = mkdtempSync(path.join(tmpdir(), 'w3-mac-noop-'))
    const appBundle = path.join(tmpAppRoot, 'TaiJi.app')
    mkdirSync(path.join(appBundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(appBundle, 'Contents', 'MacOS', 'TaiJi'), 'untouched-original')
    Object.defineProperty(process, 'execPath', {
      value: path.join(appBundle, 'Contents', 'MacOS', 'TaiJi'),
      configurable: true,
    })

    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()

    expect(result).toBe(false)
    // 原 .app 未被改动（rm + mv .old 不会触发）
    expect(readFileSync(path.join(appBundle, 'Contents', 'MacOS', 'TaiJi'), 'utf-8')).toBe('untouched-original')
    const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
    expect(written.status).toBe('no-op')

    rmSync(tmpAppRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── W3TC11d：result 文件损坏 → 不抛，返回 false ────────────────
  it('W3TC11d: result 文件非法 JSON → 不抛，返回 false（不阻塞启动）', async () => {
    writeFileSync(resultFile, 'not-json{broken')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { maybeRollbackInterruptedUpdate } = await loadModule()
    const result = await maybeRollbackInterruptedUpdate()
    expect(result).toBe(false)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ── cleanupCompletedUpdate：启动时清理已完成/失败的升级产物 ──────
// 覆盖终态清理矩阵（done 真假 / failed / rolled-back / no-op / 无 result / 幂等 / 路径注入）。
describe('cleanupCompletedUpdate', () => {
  const updateDir = path.join(TMP_DATA_DIR, 'update')
  const resultFile = path.join(updateDir, 'update-result.json')
  const preloadedFile = path.join(updateDir, 'preloaded-update.json')
  const pendingFile = path.join(updateDir, 'pending-update.json')
  const updaterScript = path.join(updateDir, 'updater.sh')
  const linuxUpdaterScript = path.join(updateDir, 'updater-linux.sh')
  const winUpdaterScript = path.join(updateDir, 'updater.cmd')
  const updaterLog = path.join(updateDir, 'updater.log')
  const linuxUpdaterLog = path.join(updateDir, 'updater-linux.log')
  const winUpdaterLog = path.join(updateDir, 'updater-win.log')
  const zipFile = path.join(updateDir, 'TaiJi-mac-arm64.zip')

  beforeEach(() => {
    // 默认 app 版本 = 0.8.49（done 用例默认真 done：current >= target）
    electronMock.appVersion = '0.8.49'
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    mkdirSync(updateDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(updateDir)) rmSync(updateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 写 update-result.json */
  function writeResult(data: Record<string, unknown>): void {
    writeFileSync(resultFile, JSON.stringify(data))
  }

  /**
   * 写入全套升级产物。
   * - preloadedFilePath：preloaded.filePath 指向的下载 zip（默认 updateDir 内的 zipFile）
   * - createZip：是否在 zipFile 处创建实体文件（路径注入用例传 false，用 outside 文件代替）
   */
  function seedArtifacts(opts: { preloadedFilePath?: string; createZip?: boolean } = {}): void {
    const fp = opts.preloadedFilePath ?? zipFile
    if (opts.createZip !== false) writeFileSync(zipFile, 'fake-zip-content')
    writeFileSync(preloadedFile, JSON.stringify({
      version: '0.8.49',
      assetName: 'TaiJi-mac-arm64.zip',
      filePath: fp,
      downloadedAt: '2025-12-01T00:00:00Z',
      size: 'fake-zip-content'.length,
      release: { version: '0.8.49' },
    }))
    writeFileSync(pendingFile, '{}')
    writeFileSync(updaterScript, '#!/bin/bash')
    writeFileSync(linuxUpdaterScript, '#!/bin/bash')
    writeFileSync(winUpdaterScript, '@echo off')
    writeFileSync(updaterLog, 'log')
    writeFileSync(linuxUpdaterLog, 'log')
    writeFileSync(winUpdaterLog, 'log')
  }

  /** 断言全套产物（含 result 自身）已被清理；keepLogs=true 时不断言日志删除（m14：非 done 终态保留日志） */
  function expectAllCleaned(extra: string[] = [], opts: { keepLogs?: boolean } = {}): void {
    expect(existsSync(resultFile)).toBe(false)
    expect(existsSync(preloadedFile)).toBe(false)
    expect(existsSync(zipFile)).toBe(false)
    expect(existsSync(pendingFile)).toBe(false)
    expect(existsSync(updaterScript)).toBe(false)
    expect(existsSync(linuxUpdaterScript)).toBe(false)
    expect(existsSync(winUpdaterScript)).toBe(false)
    if (!opts.keepLogs) {
      expect(existsSync(updaterLog)).toBe(false)
      expect(existsSync(linuxUpdaterLog)).toBe(false)
      expect(existsSync(winUpdaterLog)).toBe(false)
    }
    for (const f of extra) expect(existsSync(f)).toBe(false)
  }

  it('A1-cleanup-returns-status-vitest: done + version <= current → 清全部 + 返回 LaunchResult', async () => {
    seedArtifacts()
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()
    expectAllCleaned()
    // W4: done 终态返回 LaunchResult
    expect(result).toEqual({ status: 'done', version: '0.8.49' })
  })

  it('A3-main-cache-vitest: cleanupCompletedUpdate 返回值可被缓存（module 级变量模式）', async () => {
    // 模拟 main.ts 的 module-level cache 模式
    let cache: { status: string; version: string } | null = null
    seedArtifacts()
    writeResult({ status: 'rolled-back', version: '0.9.7', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    // main.ts 的 whenReady 内：cache = await cleanupCompletedUpdate()
    cache = await cleanupCompletedUpdate()
    // 验证缓存值可读取（模拟 getLaunchResult 回调）
    expect(cache).toEqual({ status: 'rolled-back', version: '0.9.7' })
    // consumed 一次性：读取后清空
    const result = cache
    cache = null
    expect(result).toEqual({ status: 'rolled-back', version: '0.9.7' })
    expect(cache).toBeNull()
  })

  it('2. done + version > current（假 done，app 仍旧版）→ 不清 + 返回 null', async () => {
    electronMock.appVersion = '0.8.48' // app 仍旧版，target 0.8.49 未生效
    seedArtifacts()
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()
    // W4: 假 done 返回 null（不通知）
    expect(result).toBeNull()
    // 全部产物仍在（未清理）
    expect(existsSync(resultFile)).toBe(true)
    expect(existsSync(preloadedFile)).toBe(true)
    expect(existsSync(zipFile)).toBe(true)
    expect(existsSync(pendingFile)).toBe(true)
  })

  it('3. failed → 清全部含 result + 返回 LaunchResult（error 原因码透传，A-D1）', async () => {
    seedArtifacts()
    writeResult({ status: 'failed', version: '0.9.0', at: '2025-12-01T00:00:00Z', error: 'sha mismatch' })
    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()
    expectAllCleaned()
    // W4: failed 终态返回 LaunchResult；A-D1：error 码随返回值透传给 renderer
    expect(result).toEqual({ status: 'failed', version: '0.9.0', error: 'sha mismatch' })
  })

  it('3b. failed + result 无 error 字段（旧版脚本）→ LaunchResult 不含 error 键', async () => {
    seedArtifacts()
    writeResult({ status: 'failed', version: '0.9.0', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()
    expectAllCleaned()
    expect(result).toEqual({ status: 'failed', version: '0.9.0' })
    expect(result && 'error' in result).toBe(false)
  })

  it('3c. failed + error 非字符串（受损 result）→ 容错不透传', async () => {
    seedArtifacts()
    writeResult({ status: 'failed', version: '0.9.0', at: '2025-12-01T00:00:00Z', error: 42 })
    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()
    expectAllCleaned()
    expect(result).toEqual({ status: 'failed', version: '0.9.0' })
  })

  it('3d. done + result 含 error 字段 → 不透传（error 仅 failed 态有意义）', async () => {
    seedArtifacts()
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z', error: 'stale' })
    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()
    expectAllCleaned()
    expect(result).toEqual({ status: 'done', version: '0.8.49' })
  })

  it('4. rolled-back → 清全部含 result + 返回 LaunchResult', async () => {
    seedArtifacts()
    writeResult({ status: 'rolled-back', version: '0.9.0', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()
    expectAllCleaned()
    // W4: rolled-back 终态返回 LaunchResult
    expect(result).toEqual({ status: 'rolled-back', version: '0.9.0' })
  })

  it('5. no-op → 清全部含 result + 返回 null（不通知）；日志保留（m14）', async () => {
    seedArtifacts()
    const downloading1 = path.join(updateDir, 'asset.zip.downloading')
    const downloading2 = path.join(updateDir, 'other.downloading')
    writeFileSync(downloading1, 'partial')
    writeFileSync(downloading2, 'partial')
    writeResult({ status: 'no-op', version: '0.9.0', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()
    // W4: no-op 返回 null（不通知用户）
    expect(result).toBeNull()
    expectAllCleaned([downloading1, downloading2], { keepLogs: true })
    // m14：no-op 无实质事件 → 日志保留原样（不删不归档）
    expect(existsSync(updaterLog)).toBe(true)
    expect(existsSync(linuxUpdaterLog)).toBe(true)
  })

  it('[A-G2] 原子写孤儿 tmp（update-result.json.tmp / resume-state.json.tmp）→ 终态清理一并删除', async () => {
    seedArtifacts()
    // 实际原子写实现的两类孤儿 tmp（写崩残留，半截 JSON）+ 一个通用 .tmp（模式覆盖未来新原子写点）
    const resultTmp = path.join(updateDir, 'update-result.json.tmp')
    const resumeTmp = path.join(updateDir, 'resume-state.json.tmp')
    const genericTmp = path.join(updateDir, 'download-chunk.tmp')
    writeFileSync(resultTmp, '{"status":"repl')
    writeFileSync(resumeTmp, '{"downloadedBytes":')
    writeFileSync(genericTmp, 'partial')
    writeResult({ status: 'no-op', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    const { cleanupCompletedUpdate } = await loadModule()
    const result = await cleanupCompletedUpdate()

    expect(result).toBeNull()
    expectAllCleaned([resultTmp, resumeTmp, genericTmp], { keepLogs: true })
    // 自身回滚路径（writeResultFileAtomic）正常完成后也不应留 tmp 中间产物
    const leftoverTmp = readdirSync(updateDir).filter((f) => f.endsWith('.tmp'))
    expect(leftoverTmp).toEqual([])
  })

  it('[A-G1] 回滚路径的 rolled-back 标记走原子写（tmp+rename），写后无 .tmp 残留', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const tmpAppDir = mkdtempSync(path.join(tmpdir(), 'w3-atomic-'))
    const appImage = path.join(tmpAppDir, 'TaiJi-x86_64.AppImage')
    writeFileSync(appImage, 'half-installed')
    writeFileSync(`${appImage}.old`, 'old-good-version')
    process.env.APPIMAGE = appImage
    writeResult({ status: 'replacing', version: '0.9.0', at: '2025-12-01T00:00:00Z' })

    try {
      const { maybeRollbackInterruptedUpdate } = await loadModule()
      const rolledBack = await maybeRollbackInterruptedUpdate()

      expect(rolledBack).toBe(true)
      // rolled-back 标记可解析（原子写语义：读到的是完整 JSON）且 .tmp 中间产物已 rename 消失
      const written = JSON.parse(readFileSync(resultFile, 'utf-8'))
      expect(written.status).toBe('rolled-back')
      expect(existsSync(`${resultFile}.tmp`)).toBe(false)
    } finally {
      rmSync(tmpAppDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
      delete process.env.APPIMAGE
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('6. 无 update-result.json → 返回 null 不抛错（也不误删现存产物）', async () => {
    // 不写 result，但写一些产物（验证无 result 时不触发清理）
    writeFileSync(pendingFile, '{}')
    writeFileSync(updaterLog, 'log')
    const { cleanupCompletedUpdate } = await loadModule()
    await expect(cleanupCompletedUpdate()).resolves.toBeNull()
    // 无 result → 不清理，产物仍在
    expect(existsSync(pendingFile)).toBe(true)
    expect(existsSync(updaterLog)).toBe(true)
  })

  it('7. 幂等：连续两次调用不抛错，首次有返回值，二次返回 null', async () => {
    seedArtifacts()
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' })
    const { cleanupCompletedUpdate } = await loadModule()
    const first = await cleanupCompletedUpdate()
    expect(first).toEqual({ status: 'done', version: '0.8.49' })
    // 第二次（产物已无，ignoreENOENT 吞 ENOENT）不抛错，返回 null
    await expect(cleanupCompletedUpdate()).resolves.toBeNull()
    expectAllCleaned()
  })

  it('8. filePath 路径注入（preloaded.filePath 在 UPDATE_DIR 外）→ outside 文件不删、其余产物仍清', async () => {
    // outside 文件放在 OS tmpdir（明确在 UPDATE_DIR 之外）
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'outside-inject-'))
    const outsideFile = path.join(outsideDir, 'outside.txt')
    writeFileSync(outsideFile, 'should-not-delete')
    // createZip=false：本次 preloaded.filePath 指向 outside，updateDir 内无真实 zip
    seedArtifacts({ preloadedFilePath: outsideFile, createZip: false })
    writeResult({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cleanupCompletedUpdate } = await loadModule()
    await cleanupCompletedUpdate()
    // 路径注入防护：outside 文件未被删
    expect(existsSync(outsideFile)).toBe(true)
    // warn 记录了跳过
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/skip download zip outside UPDATE_DIR/),
    )
    warnSpy.mockRestore()
    // 其余产物仍清
    expect(existsSync(resultFile)).toBe(false)
    expect(existsSync(preloadedFile)).toBe(false)
    expect(existsSync(pendingFile)).toBe(false)
    expect(existsSync(updaterScript)).toBe(false)

    rmSync(outsideDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
})

// ════════════════════════════════════════════════════════════════
// 批次 5（u5a）：updater.pid 互斥检查方（§3.7.1）
// ════════════════════════════════════════════════════════════════
describe('批次 5: updater.pid 互斥（§3.7.1 检查方）', () => {
  const updateDir2 = path.join(TMP_DATA_DIR, 'update')
  const pidFile = path.join(updateDir2, 'updater.pid')
  const resultFile = path.join(updateDir2, 'update-result.json')
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    vi.clearAllMocks()
    mkdirSync(updateDir2, { recursive: true })
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    if (existsSync(updateDir2)) rmSync(updateDir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function writeReplacingResult(): void {
    // 齐备的「应触发回滚」现场：replacing + .old 备份存在
    writeFileSync(resultFile, JSON.stringify({ status: 'replacing', version: '0.9.1' }))
    mkdirSync(path.join(updateDir2, 'TaiJi.app.old'), { recursive: true })
  }

  /**
   * 只读探活等待：轮询 `ps -p <pid> -o command=`（与被测模块探活同款命令形态），
   * 直到子进程 argv 可见且匹配 updater 脚本名。spawn fork 到 bash exec 完成之间
   * 子进程可能尚不可见于 ps，满载下该窗口拉长——零等待直接调被测函数会因单次
   * 探活误判「不存活」而误回滚。deadline 5s、间隔 25ms；只读探测，不触碰共享资源。
   */
  async function waitForUpdaterArgv(pid: number, scriptName: RegExp): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
        if (out.status === 0 && scriptName.test(out.stdout ?? '')) return
      } catch { /* 进程尚未可见，继续轮询 */ }
      if (Date.now() >= deadline) {
        throw new Error(`updater process (pid=${pid}) not visible via ps within 5s (pattern: ${scriptName})`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  it('验收②：pid 存活（win 平台仅存活检查）→ defer：不回滚 + 日志 updater in flight', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // pid = 测试进程自身（必存活）
    writeFileSync(pidFile, String(process.pid))
    writeReplacingResult()

    const mod = await loadModule()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rolledBack = await mod.maybeRollbackInterruptedUpdate()
    logSpy.mockRestore()

    // defer：返回 false（未回滚）且 replacing result 原样保留（未被改写为 rolled-back）
    expect(rolledBack).toBe(false)
    expect(readFileSync(resultFile, 'utf-8')).toContain('replacing')
    expect(existsSync(path.join(updateDir2, 'TaiJi.app.old'))).toBe(true)
    // pid 文件保留（updater 还在跑，由它自己退出时清理）
    expect(existsSync(pidFile)).toBe(true)
  })

  it('死 pid → 自愈清理残留 pid 文件并正常走回滚检查（不 defer）', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    writeFileSync(pidFile, '999999999') // 超出 pid 范围，必不存在
    // 无 result 文件：正常检查路径直接 false（关键是 pid 残留被清理）

    const mod = await loadModule()
    const rolledBack = await mod.maybeRollbackInterruptedUpdate()

    expect(rolledBack).toBe(false)
    expect(existsSync(pidFile), '死 pid 残留应被自愈清理').toBe(false)
  })

  it('mac 进程名加固：pid 存活但 argv 不含 updater 脚本（PID 复用）→ 视为不存活，正常清理', async () => {
    // 本机 darwin 跑：process.pid 的 argv = node/vitest，不含 updater.sh → 加固判定不复用
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    writeFileSync(pidFile, String(process.pid))
    writeReplacingResult()

    const mod = await loadModule()
    const rolledBack = await mod.maybeRollbackInterruptedUpdate()

    // 非 updater 进程占位 → 不 defer，正常走回滚检查（replacing + .old 存在会真回滚，
    // 这里 .old 未创建 → 走 no-op 分支返回 false，但 pid 残留被清理）
    expect(rolledBack).toBe(false)
    expect(existsSync(pidFile), 'PID 复用 → 残留 pid 应被清理').toBe(false)
  })

  it('mac 阳性：真实 bash updater.sh 进程 → 识别为 in-flight（defer），pid 文件保留', async () => {
    // 回归守卫：加固用 ps -o command=（argv），不能退化为 comm=——脚本进程的 comm
    // 恒为 "bash"（解释器映像），comm= 会把真实存活的脚本 100% 误判为 PID 复用，
    // 互斥 fail-open（2026-08 一致性审查实证）。本用例用真实 bash 脚本进程 + 真实 ps。
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const fakeScript = path.join(updateDir2, 'updater.sh')
    writeFileSync(fakeScript, '#!/bin/bash\nsleep 30\n')
    const child = spawn('bash', [fakeScript], { detached: true, stdio: 'ignore' })
    try {
      // 先等子进程 argv 经 ps 可见（只读探活），再调被测函数——避免 fork/exec 窗口内
      // 单次探活误判不存活 → 误回滚
      await waitForUpdaterArgv(child.pid!, /\/updater\.sh(?:\s|$)/)
      writeFileSync(pidFile, String(child.pid))
      writeReplacingResult()

      const mod = await loadModule()
      const rolledBack = await mod.maybeRollbackInterruptedUpdate()

      // defer：不回滚、result 原样保留、pid 文件不被误清（脚本还在跑）
      expect(rolledBack).toBe(false)
      expect(readFileSync(resultFile, 'utf-8')).toContain('replacing')
      expect(existsSync(pidFile), '真实 updater 脚本在跑 → pid 文件必须保留').toBe(true)
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 进程组已退 */ }
      try { child.kill('SIGKILL') } catch { /* 已退 */ }
    }
  })

  it('mac 阳性（linux 脚本名）：真实 bash updater-linux.sh 进程 → 识别为 in-flight', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const fakeScript = path.join(updateDir2, 'updater-linux.sh')
    writeFileSync(fakeScript, '#!/bin/bash\nsleep 30\n')
    const child = spawn('bash', [fakeScript], { detached: true, stdio: 'ignore' })
    try {
      // 同款只读探活等待（见 waitForUpdaterArgv 注释）
      await waitForUpdaterArgv(child.pid!, /\/updater-linux\.sh(?:\s|$)/)
      writeFileSync(pidFile, String(child.pid))
      writeReplacingResult()

      const mod = await loadModule()
      const rolledBack = await mod.maybeRollbackInterruptedUpdate()

      expect(rolledBack).toBe(false)
      expect(existsSync(pidFile), 'updater-linux.sh 在跑 → pid 文件必须保留').toBe(true)
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 进程组已退 */ }
      try { child.kill('SIGKILL') } catch { /* 已退 */ }
    }
  })
})

// ════════════════════════════════════════════════════════════════
// 批次 5（u5b）：清理矩阵修补（m13）+ 日志保留（m14）+ 文案/字段（m15/m18）
// ════════════════════════════════════════════════════════════════
describe('批次 5: 清理矩阵与 self-healer 债务（m13/m14/m15/m18）', () => {
  const updateDir2 = path.join(TMP_DATA_DIR, 'update')
  const resultFile2 = path.join(updateDir2, 'update-result.json')
  let originalPlatform: PropertyDescriptor | undefined
  let originalExecPath: string

  /** mac 平台桩 + execPath 指向 tmp 内伪造 .app 布局 */
  function stubMacWithApp(): { appBundle: string; stagingDir: string } {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const appBundle = path.join(updateDir2, 'TaiJi.app')
    Object.defineProperty(process, 'execPath', {
      value: path.join(appBundle, 'Contents', 'MacOS', 'TaiJi'),
      configurable: true,
    })
    return {
      appBundle,
      stagingDir: path.join(updateDir2, `.staging.TaiJi.app`),
    }
  }

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalExecPath = process.execPath
    vi.clearAllMocks()
    mkdirSync(updateDir2, { recursive: true })
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true })
    if (existsSync(updateDir2)) rmSync(updateDir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('验收① m13：done 终态 + .old/.broken/.new/.staging 残留 → cleanup 后全清（rmSync recursive 吞目录）', async () => {
    const { appBundle, stagingDir } = stubMacWithApp()
    // 伪造全部残留：.old/.broken/.new 目录 + staging 目录（含内部文件验证 recursive）
    for (const dir of [`${appBundle}.old`, `${appBundle}.broken`, `${appBundle}.new`, stagingDir]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'inner.txt'), 'stale')
    }
    writeFileSync(resultFile2, JSON.stringify({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' }))

    const mod = await loadModule()
    await mod.cleanupCompletedUpdate()

    // m13：.old 不再跨启动存活，全部残留清空
    expect(existsSync(`${appBundle}.old`)).toBe(false)
    expect(existsSync(`${appBundle}.broken`)).toBe(false)
    expect(existsSync(`${appBundle}.new`)).toBe(false)
    expect(existsSync(stagingDir)).toBe(false)
  })

  it('m13 linux：.old/.broken 清理（APPIMAGE 推导）', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.APPIMAGE = path.join(updateDir2, 'TaiJi-x86_64.AppImage')
    writeFileSync(path.join(updateDir2, 'TaiJi-x86_64.AppImage.old'), 'stale')
    writeFileSync(path.join(updateDir2, 'TaiJi-x86_64.AppImage.broken'), 'stale')
    writeFileSync(resultFile2, JSON.stringify({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' }))

    const mod = await loadModule()
    await mod.cleanupCompletedUpdate()

    expect(existsSync(path.join(updateDir2, 'TaiJi-x86_64.AppImage.old'))).toBe(false)
    expect(existsSync(path.join(updateDir2, 'TaiJi-x86_64.AppImage.broken'))).toBe(false)
    delete process.env.APPIMAGE
  })

  it('验收② m14：failed → updater.log 归档为 updater-<date>.log 保留（原文件不存在）', async () => {
    writeFileSync(path.join(updateDir2, 'updater.log'), 'failure stack trace')
    writeFileSync(path.join(updateDir2, 'updater-linux.log'), 'failure stack trace linux')
    writeFileSync(path.join(updateDir2, 'updater-win.log'), 'failure stack trace win')
    writeFileSync(resultFile2, JSON.stringify({ status: 'failed', version: '0.9.1', at: '2025-12-01T00:00:00Z' }))

    const mod = await loadModule()
    await mod.cleanupCompletedUpdate()

    const today = new Date().toISOString().slice(0, 10)
    expect(existsSync(path.join(updateDir2, 'updater.log'))).toBe(false)
    expect(existsSync(path.join(updateDir2, `updater-${today}.log`))).toBe(true)
    expect(existsSync(path.join(updateDir2, `updater-linux-${today}.log`))).toBe(true)
    // win 日志同策略归档（一致性审查补齐：批次 2 产物原不在 m14 清单）
    expect(existsSync(path.join(updateDir2, 'updater-win.log'))).toBe(false)
    expect(existsSync(path.join(updateDir2, `updater-win-${today}.log`))).toBe(true)
  })

  it('m14 对照：done → updater.log 直接删除（不归档）', async () => {
    writeFileSync(path.join(updateDir2, 'updater.log'), 'happy path log')
    writeFileSync(path.join(updateDir2, 'updater-win.log'), 'happy path log win')
    writeFileSync(resultFile2, JSON.stringify({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' }))

    const mod = await loadModule()
    await mod.cleanupCompletedUpdate()

    expect(existsSync(path.join(updateDir2, 'updater.log'))).toBe(false)
    // win 日志 done 态同删（与 mac/linux 同口径）
    expect(existsSync(path.join(updateDir2, 'updater-win.log'))).toBe(false)
    const archived = readdirSync(updateDir2).filter((f) => /^updater.*-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    expect(archived).toEqual([])
  })

  it('m14：>7 天旧归档被清理，7 天内归档保留', async () => {
    const utimesSync = (await import('node:fs')).utimesSync
    const oldArchive = path.join(updateDir2, 'updater-2020-01-01.log')
    const freshArchive = path.join(updateDir2, 'updater-2020-01-02.log')
    writeFileSync(oldArchive, 'old')
    writeFileSync(freshArchive, 'fresh')
    // mtime 老化：8 天前 vs 1 天前（真实 mtime 操作，cutoff 用真实时钟比较）
    const now = new Date()
    utimesSync(oldArchive, now, new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000))
    utimesSync(freshArchive, now, new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000))
    writeFileSync(resultFile2, JSON.stringify({ status: 'done', version: '0.8.49', at: '2025-12-01T00:00:00Z' }))

    const mod = await loadModule()
    await mod.cleanupCompletedUpdate()

    expect(existsSync(oldArchive), '8 天前旧档应被清理').toBe(false)
    expect(existsSync(freshArchive), '1 天内归档应保留').toBe(true)
  })

  it('验收③ m15：win no-op reason = installer wrapper exited before completion', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    // win 无 .old 备份机制（getOldBackupPath win 返回 undefined）→ replacing 走 no-op 分支
    writeFileSync(resultFile2, JSON.stringify({ status: 'replacing', version: '0.9.1' }))

    const mod = await loadModule()
    await mod.maybeRollbackInterruptedUpdate()

    const written = JSON.parse(readFileSync(resultFile2, 'utf-8')) as { status: string; reason: string }
    expect(written.status).toBe('no-op')
    expect(written.reason).toBe('installer wrapper exited before completion')
  })

  it('验收④ m18：corrupt json 含 version → rolled-back 标记带提取的 version', async () => {
    const { appBundle } = stubMacWithApp()
    // corrupt raw：半截 replacing JSON，version 字段完整、at 字段被截断
    writeFileSync(
      resultFile2,
      '{"status":"replacing","version":"0.9.1","at":"2025-12-01T00:00',
    )
    mkdirSync(`${appBundle}.old`, { recursive: true }) // .old 存在 → 触发回滚

    const mod = await loadModule()
    const rolledBack = await mod.maybeRollbackInterruptedUpdate()

    expect(rolledBack).toBe(true)
    const written = JSON.parse(readFileSync(resultFile2, 'utf-8')) as { status: string; version?: string }
    expect(written.status).toBe('rolled-back')
    expect(written.version).toBe('0.9.1')
  })

  it('验收④ m18 下限：corrupt json 无 version → rolled-back 无 version 字段（无 toast 维持下限）', async () => {
    const { appBundle } = stubMacWithApp()
    writeFileSync(resultFile2, '{"status":"replacing","at":"2025-12-01T00:00')
    mkdirSync(`${appBundle}.old`, { recursive: true })

    const mod = await loadModule()
    await mod.maybeRollbackInterruptedUpdate()

    const written = JSON.parse(readFileSync(resultFile2, 'utf-8')) as { status: string; version?: string }
    expect(written.status).toBe('rolled-back')
    expect(written.version).toBeUndefined()
  })
})
