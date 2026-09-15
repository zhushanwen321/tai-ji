/**
 * 预下载产物元信息 SSOT（preloaded-update）单元测试。
 *
 * 覆盖 preloaded-update.ts 全部导出：
 *   1. writePreloadedUpdate + readPreloadedUpdate 往返（同版本同 platform asset → 返回 filePath）
 *   2. version 不匹配 → readPreloadedUpdate 返回 null + 清除
 *   3. 产物文件不存在 → readPreloadedUpdate 返回 null + 清除
 *   4. 完整性校验（size / sha256）失败 → 返回 null + 清除
 *   5. 完整性校验通过 → 返回 filePath
 *
 * Mock 策略参考 orchestrator.test.ts：
 *   - 用真实 fs（临时目录），经 TAIJI_AGENT_DATA_DIR 重定向 getPreloadedUpdateFile()
 *     落点（路径延迟求值，调用时读 getDataDir；env 先设确保所有求值命中 tmp）
 *   - process.platform 经 Object.defineProperty 桩为 'darwin'（readPreloadedUpdate 依赖
 *     process.platform 选平台 asset name），beforeEach 设、afterEach 还原
 *   - release 带 macArm64Dmg asset，对应 darwin 平台
 *   - env + platform 就绪后动态 import 拿独立模块实例
 *
 * 运行：cd apps/electron/main && npx vitest run test/preloaded-update.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  closeSync,
  openSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LatestReleaseInfo, ReleaseAsset } from '@taiji/shared'

// ── env 先于一切路径求值设置（历史形态要求 import 前设，延迟求值后非硬约束）──
// constants.ts 现经 getPreloadedUpdateFile() 延迟求值（getDataDir 读 TAIJI_AGENT_DATA_DIR）。
// 赋值仍放最前（无害），下方模块经动态 import 在 env 就绪后加载。
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'preloaded-update-'))
process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

interface PreloadedUpdateModule {
  writePreloadedUpdate: (release: LatestReleaseInfo, filePath: string) => void
  readPreloadedUpdate: (release: LatestReleaseInfo) => Promise<string | null>
  readPreloadedUpdateRaw: (currentVersion: string) => Promise<{ release: LatestReleaseInfo; filePath: string } | null>
  clearPreloadedUpdate: () => void
}

// 动态 import：确保 env 赋值先生效
async function loadModule(): Promise<PreloadedUpdateModule> {
  return await import('../update/preloaded-update.js')
}

/** 计算 buffer/string 的 sha256 hex（与 download-asset hashFileSha256 一致） */
function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** preloaded-update.json 落盘路径（与 constants.ts 推导一致） */
const PRELOADED_UPDATE_FILE = path.join(TMP_DATA_DIR, 'update', 'preloaded-update.json')

/**
 * LatestReleaseInfo fixture（mac + deb 都覆盖，darwin 平台用 macArm64Dmg）。
 * 参考 orchestrator.test.ts 的 MAC_RELEASE。
 */
function makeRelease(version = '0.9.0', asset?: Partial<ReleaseAsset>): LatestReleaseInfo {
  const macAsset: ReleaseAsset = {
    name: 'TaiJi-0.10.0-mac-arm64.dmg',
    downloadUrl: 'https://example.com/mac.dmg',
    size: asset?.size ?? 1000,
    sha256: asset?.sha256 ?? 'a'.repeat(64),
  }
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '## What changed\n- preloaded-update fixture',
    publishedAt: '2025-12-01T00:00:00Z',
    htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
    assets: {
      macArm64Dmg: macAsset,
    },
  }
}

describe('preloaded-update (预下载产物元信息 SSOT)', () => {
  let mod: PreloadedUpdateModule
  let originalPlatform: PropertyDescriptor | undefined
  // 记录本用例创建的临时产物文件，afterEach 清理
  const createdFiles: string[] = []

  beforeEach(async () => {
    // 桩 platform 为 darwin（readPreloadedUpdate 内 pickPlatformAssetName 读 process.platform）
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    mod = await loadModule()
    // 每个用例独立：清掉残留的 preloaded-update.json
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    createdFiles.length = 0
  })

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    // 清理本用例创建的产物文件
    for (const f of createdFiles) {
      if (existsSync(f)) rmSync(f, { force: true })
    }
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  /** 创建一个真实存在的临时产物文件，返回绝对路径 */
  function createProductFile(name: string, content?: string): string {
    const filePath = path.join(TMP_DATA_DIR, 'products', name)
    mkdirSync(path.dirname(filePath), { recursive: true })
    if (content !== undefined) {
      writeFileSync(filePath, content)
    } else {
      // 创建空文件（existsSync 判定为 true 即可）
      const fd = openSync(filePath, 'w')
      closeSync(fd)
    }
    createdFiles.push(filePath)
    return filePath
  }

  // ── 1. writePreloadedUpdate + readPreloadedUpdate 往返（完整性通过） ─
  it('writePreloadedUpdate 后 readPreloadedUpdate 返回同一 filePath（同版本同 platform asset + 完整性通过）', async () => {
    const content = 'roundtrip content'
    const release = makeRelease('0.9.0', { size: content.length, sha256: sha256Hex(content) })
    const filePath = createProductFile('mac.dmg', content)

    mod.writePreloadedUpdate(release, filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    // 同版本 + 同平台 asset + 文件存在 + size/sha256 匹配 → 返回 filePath
    const result = await mod.readPreloadedUpdate(release)
    expect(result).toBe(filePath)
    // 读取有效不清除
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)
  })

  // ── 2. version 不匹配 → 返回 null + 清除 ───────────────────────
  it('readPreloadedUpdate：release.version 不匹配 → 返回 null + 清除元信息', async () => {
    const writeRelease = makeRelease('0.9.0')
    const filePath = createProductFile('mac.dmg')
    mod.writePreloadedUpdate(writeRelease, filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    // 读取时 release 版本变了（0.9.1）→ 产物失效
    const readRelease = makeRelease('0.9.1')
    const result = await mod.readPreloadedUpdate(readRelease)
    expect(result).toBeNull()
    // 元信息被清除
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  // ── 3. 产物文件不存在 → 返回 null + 清除 ───────────────────────
  it('readPreloadedUpdate：产物文件已被删除 → 返回 null + 清除元信息', async () => {
    const release = makeRelease('0.9.0')
    // 写入一个指向不存在文件的元信息
    const ghostPath = path.join(TMP_DATA_DIR, 'products', 'ghost.zip')
    expect(existsSync(ghostPath)).toBe(false)
    mod.writePreloadedUpdate(release, ghostPath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    const result = await mod.readPreloadedUpdate(release)
    expect(result).toBeNull()
    // 元信息被清除
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  // ── 4. 完整性校验：size 不匹配 ────────────────────────────────
  it('readPreloadedUpdate：size 不匹配 → 返回 null + 清除元信息', async () => {
    const content = 'small'
    // 元信息里写 size=1000，实际文件只有 5 字节
    const release = makeRelease('0.9.0', { size: 1000, sha256: sha256Hex(content) })
    const filePath = createProductFile('mac.dmg', content)
    mod.writePreloadedUpdate(release, filePath)

    const result = await mod.readPreloadedUpdate(release)
    expect(result).toBeNull()
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  // ── 5. 完整性校验：sha256 不匹配 ───────────────────────────────
  it('readPreloadedUpdate：sha256 不匹配 → 返回 null + 清除元信息', async () => {
    const content = 'valid content'
    const release = makeRelease('0.9.0', { size: content.length, sha256: 'b'.repeat(64) })
    const filePath = createProductFile('mac.dmg', content)
    mod.writePreloadedUpdate(release, filePath)

    const result = await mod.readPreloadedUpdate(release)
    expect(result).toBeNull()
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  // ── 6. 完整性校验：size=0 时跳过 size 但 sha256 仍校验 ─────────────
  it('readPreloadedUpdate：size=0 跳过 size 校验，sha256 匹配仍返回 filePath', async () => {
    const content = 'zero-size-meta'
    const release = makeRelease('0.9.0', { size: 0, sha256: sha256Hex(content) })
    const filePath = createProductFile('mac.dmg', content)
    mod.writePreloadedUpdate(release, filePath)

    const result = await mod.readPreloadedUpdate(release)
    expect(result).toBe(filePath)
  })

  // ── 额外：readPreloadedUpdate 文件不存在 → 返回 null ────────────
  it('readPreloadedUpdate：元信息文件不存在 → 返回 null（不抛错）', async () => {
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
    const result = await mod.readPreloadedUpdate(makeRelease('0.9.0'))
    expect(result).toBeNull()
  })

  // ── 额外：clearPreloadedUpdate 显式清除 ────────────────────────
  it('clearPreloadedUpdate：显式清除已存在的元信息文件', () => {
    const filePath = createProductFile('mac.dmg')
    mod.writePreloadedUpdate(makeRelease('0.9.0'), filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)
    mod.clearPreloadedUpdate()
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
    // 幂等：再次清除不抛错
    expect(() => mod.clearPreloadedUpdate()).not.toThrow()
  })

  // ── 额外：落盘结构含 version/assetName/filePath/downloadedAt/size/sha256
  it('writePreloadedUpdate：落盘 JSON 含 version/assetName/filePath/downloadedAt/size/sha256', () => {
    const content = 'structured content'
    const sha = sha256Hex(content)
    const release = makeRelease('0.9.0', { size: content.length, sha256: sha })
    const filePath = createProductFile('mac.dmg', content)
    mod.writePreloadedUpdate(release, filePath)

    // 解析落盘文件验证结构（unknown + 字段访问，不用 as any）
    const raw = readFileSync(PRELOADED_UPDATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const obj = parsed as Record<string, unknown>
    expect(obj.version).toBe('0.9.0')
    // assetName 与 darwin 平台 mac asset name 一致
    expect(obj.assetName).toBe('TaiJi-0.10.0-mac-arm64.dmg')
    expect(obj.filePath).toBe(filePath)
    expect(typeof obj.downloadedAt).toBe('string')
    expect(obj.size).toBe(content.length)
    expect(obj.sha256).toBe(sha)
    // T3：落盘结构含完整 release 信息（update:install 权威源）
    expect(typeof obj.release).toBe('object')
    expect(obj.release).not.toBeNull()
    const rel = obj.release as Record<string, unknown>
    expect(rel.version).toBe('0.9.0')
  })

  // ── T3：readPreloadedUpdateRaw 读回 { release, filePath } ──────
  it('readPreloadedUpdateRaw：writePreloadedUpdate 后读回 { release, filePath }（不做版本匹配）', async () => {
    const content = 'raw content'
    const release = makeRelease('0.9.0', { size: content.length, sha256: sha256Hex(content) })
    const filePath = createProductFile('mac.dmg', content)
    mod.writePreloadedUpdate(release, filePath)

    const result = await mod.readPreloadedUpdateRaw('0.0.0')
    expect(result).not.toBeNull()
    expect(result!.filePath).toBe(filePath)
    // release 字段含完整 release 信息
    expect(result!.release.version).toBe('0.9.0')
    expect(result!.release.assets.macArm64Dmg?.name).toBe('TaiJi-0.10.0-mac-arm64.dmg')
  })

  // ── T3：readPreloadedUpdateRaw 拒绝旧格式（无 release 字段）─────
  it('readPreloadedUpdateRaw：旧格式（无 release 字段）→ 返回 null + 清除元信息', async () => {
    // 手工构造旧格式 JSON（无 release 字段，模拟 T3 之前的产物）
    const oldFormat = {
      version: '0.9.0',
      assetName: 'TaiJi-0.10.0-mac-arm64.dmg',
      filePath: createProductFile('mac.dmg', 'old'),
      downloadedAt: '2025-12-01T00:00:00Z',
      size: 3,
    }
    mkdirSync(path.dirname(PRELOADED_UPDATE_FILE), { recursive: true })
    writeFileSync(PRELOADED_UPDATE_FILE, JSON.stringify(oldFormat))
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    const result = await mod.readPreloadedUpdateRaw('0.0.0')
    // 旧格式无 release → isPreloadedUpdateData 返回 false → 清除
    expect(result).toBeNull()
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  // ── T3：readPreloadedUpdateRaw 产物文件不存在 → null + 清除 ──────
  it('readPreloadedUpdateRaw：产物文件不存在 → 返回 null + 清除', async () => {
    const release = makeRelease('0.9.0')
    const ghostPath = path.join(TMP_DATA_DIR, 'products', 'ghost-raw.zip')
    expect(existsSync(ghostPath)).toBe(false)
    mod.writePreloadedUpdate(release, ghostPath)

    const result = await mod.readPreloadedUpdateRaw('0.0.0')
    expect(result).toBeNull()
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  // ── T3：readPreloadedUpdateRaw 文件不存在 → null（不抛错）─────
  it('readPreloadedUpdateRaw：元信息文件不存在 → 返回 null（不抛错）', async () => {
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
    const result = await mod.readPreloadedUpdateRaw('0.0.0')
    expect(result).toBeNull()
  })

  // ── 版本比较清除策略（与 readPendingUpdate 对称）──────────────
  it('readPreloadedUpdateRaw：currentVersion >= preloaded.version → 清除元信息 + 返回 null', async () => {
    const content = 'version-guard-expired'
    const release = makeRelease('0.9.0', { size: content.length, sha256: sha256Hex(content) })
    const filePath = createProductFile('mac.dmg', content)
    mod.writePreloadedUpdate(release, filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    // currentVersion 0.9.0 >= preloaded 0.9.0 → 产物过期，清除
    const result = await mod.readPreloadedUpdateRaw('0.9.0')
    expect(result).toBeNull()
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(false)
  })

  it('readPreloadedUpdateRaw：currentVersion < preloaded.version → 返回数据（未过期）', async () => {
    const content = 'version-guard-valid'
    const release = makeRelease('0.9.0', { size: content.length, sha256: sha256Hex(content) })
    const filePath = createProductFile('mac.dmg', content)
    mod.writePreloadedUpdate(release, filePath)

    // currentVersion 0.8.0 < preloaded 0.9.0 → 未过期，返回数据
    const result = await mod.readPreloadedUpdateRaw('0.8.0')
    expect(result).not.toBeNull()
    expect(result!.filePath).toBe(filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)
  })

  it('readPreloadedUpdateRaw：非 semver 版本号 → compare 抛错 catch + 保留元信息（不误删）', async () => {
    const content = 'version-guard-nonsemver'
    // version='invalid'：isPreloadedUpdateData 通过（typeof string），但 compare 抛错
    const release = makeRelease('invalid', { size: content.length, sha256: sha256Hex(content) })
    const filePath = createProductFile('mac.dmg', content)
    mod.writePreloadedUpdate(release, filePath)
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // compare('0.9.0', 'invalid', '>=') 抛错 → catch + warn + 保留
    const result = await mod.readPreloadedUpdateRaw('0.9.0')
    expect(result).not.toBeNull()
    expect(result!.release.version).toBe('invalid')
    expect(existsSync(PRELOADED_UPDATE_FILE)).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
