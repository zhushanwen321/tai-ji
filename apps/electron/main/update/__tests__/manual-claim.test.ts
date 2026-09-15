/**
 * manual-claim（u3-claim）验收测试：手动产物认领三重校验 + move + preloaded 登记。
 *
 * 覆盖验收条款：
 * ① 三重校验正反例（全过 / size 不符 / sha 不符 / sha 缺失；目录空与无同名不落盘）
 * ② 并发幂等（renameSync ENOENT → 返回成功路径不落 mismatch；其他 rename 错误原样上抛）
 * ③ writePreloadedUpdate 失败 best-effort（move 已成功仍返回 finalPath）
 *
 * mock 边界（任务约定）：仅 appendUpdateError（vi.fn 捕获断言）+ renameSync
 * （默认透传真实实现，仅并发用例注入 ENOENT——无法以真实并发确定性触发）。
 * 文件系统全部真实：constants 重定向到临时目录（与 update.test.ts 同款隔离范式），
 * sha256 期望值用 node:crypto 独立计算（不经 hash.ts 流式实现，避免同源复读）。
 *
 * 运行：cd apps/electron/main && npx vitest run update/__tests__/
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ─── 路径重定向 + mock 注入点 ─────────────────────────────────────

const {
  TEST_UPDATE_DIR,
  TEST_MANUAL_DIR,
  TEST_PRELOADED_FILE,
  renameSyncMock,
} = vi.hoisted(() => {
  // 此处不能用已导入的 join（hoisted 工厂执行时 import 绑定尚未初始化），
  // 用模板串构造等价路径（与 update.test.ts 同款范式）
  const base = process.env.TMPDIR || '/tmp'
  const dir = `${base}/manual-claim-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  type RealRenameSync = typeof import('node:fs').renameSync
  return {
    TEST_UPDATE_DIR: dir,
    TEST_MANUAL_DIR: `${dir}/manual`,
    TEST_PRELOADED_FILE: `${dir}/preloaded-update.json`,
    renameSyncMock: vi.fn<(src: string, dst: string, real: RealRenameSync) => void>(),
  }
})

// 路径函数重定向到临时目录（隔离真实数据目录）；延迟求值后不再依赖
// 「模块加载前 mock」的时序，本 import 图内 manual-claim 与 preloaded-update 均消费 constants
vi.mock('../constants.js', () => ({
  getUpdateDir: () => TEST_UPDATE_DIR,
  getPreloadedUpdateFile: () => TEST_PRELOADED_FILE,
}))

// mock 边界：appendUpdateError 只捕获调用，不写真实日志文件
vi.mock('../error-log.js', () => ({
  appendUpdateError: vi.fn(),
}))

// renameSync 可注入（并发幂等用例）；默认透传真实实现，其余 fs API 全真实
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: ((src: string, dst: string) =>
      renameSyncMock(src, dst, actual.renameSync)) as typeof actual.renameSync,
  }
})

import { tryClaimManualAsset } from '../manual-claim.js'
import { appendUpdateError } from '../error-log.js'

const appendUpdateErrorMock = vi.mocked(appendUpdateError)

// ─── fixture ─────────────────────────────────────────────────────

const ASSET_NAME = 'TaiJi-9.9.9-mac-arm64.dmg'
const ASSET_CONTENT = 'manual asset payload for claim test'

/** 独立于 hash.ts 流式实现的 sha256 计算（node:crypto 一次性 update） */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function makeRelease(assetOverride?: {
  size?: number
  sha256?: string
}): import('@taiji/shared').LatestReleaseInfo {
  return {
    version: '9.9.9',
    tagName: 'v9.9.9',
    releaseNotes: 'release notes',
    publishedAt: '2026-08-30T00:00:00Z',
    htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/v9.9.9',
    assets: {
      macArm64Dmg: {
        name: ASSET_NAME,
        downloadUrl: `https://example.invalid/${ASSET_NAME}`,
        size: assetOverride?.size ?? Buffer.byteLength(ASSET_CONTENT),
        sha256: assetOverride?.sha256 ?? sha256Hex(ASSET_CONTENT),
      },
    },
  }
}

/** 在 manual/ 投放同名候选文件，返回其路径 */
function placeCandidate(name: string, content: string): string {
  mkdirSync(TEST_MANUAL_DIR, { recursive: true })
  const p = join(TEST_MANUAL_DIR, name)
  writeFileSync(p, content)
  return p
}

function readPreloaded(): Record<string, unknown> {
  return JSON.parse(readFileSync(TEST_PRELOADED_FILE, 'utf-8')) as Record<string, unknown>
}

// ─── 全局编排 ──────────────────────────────────────────────────────

// 锁定 darwin 平台分支（pickPlatformAsset 读 process.platform），与 host 无关
const ORIGINAL_PLATFORM = process.platform

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM })
  rmSync(TEST_UPDATE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

beforeEach(() => {
  rmSync(TEST_UPDATE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  renameSyncMock.mockReset()
  renameSyncMock.mockImplementation((src, dst, real) => real(src, dst))
  appendUpdateErrorMock.mockClear()
})

// ─── ① 三重校验 ───────────────────────────────────────────────────

describe('u3-claim triple-check', () => {
  it('all pass: moves file to UPDATE_DIR, writes preloaded registration, returns final path', async () => {
    const release = makeRelease()
    const candidatePath = placeCandidate(ASSET_NAME, ASSET_CONTENT)

    const result = await tryClaimManualAsset(release)

    const finalPath = join(TEST_UPDATE_DIR, ASSET_NAME)
    expect(result).toBe(finalPath)
    // 已从 manual/ 移走，内容原样落到 UPDATE_DIR
    expect(existsSync(candidatePath)).toBe(false)
    expect(readFileSync(finalPath, 'utf-8')).toBe(ASSET_CONTENT)
    // preloaded 登记形状（version/assetName/filePath/size/sha256/release/downloadedAt）
    const preloaded = readPreloaded()
    expect(preloaded.version).toBe('9.9.9')
    expect(preloaded.assetName).toBe(ASSET_NAME)
    expect(preloaded.filePath).toBe(finalPath)
    expect(preloaded.size).toBe(Buffer.byteLength(ASSET_CONTENT))
    expect(preloaded.sha256).toBe(sha256Hex(ASSET_CONTENT))
    expect(typeof preloaded.downloadedAt).toBe('string')
    expect(preloaded.release).toEqual(release)
    // 三重全过不落盘
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
  })

  it('size mismatch: returns null, logs manual-claim with expected/actual, keeps file', async () => {
    const candidatePath = placeCandidate(ASSET_NAME, 'truncated') // 9 字节 ≠ 期望
    const actualSize = 'truncated'.length

    const result = await tryClaimManualAsset(makeRelease())

    expect(result).toBeNull()
    expect(appendUpdateErrorMock).toHaveBeenCalledTimes(1)
    expect(appendUpdateErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'manual-claim',
        stage: 'downloading',
        rawCause: `size mismatch (expected ${Buffer.byteLength(ASSET_CONTENT)}, got ${actualSize})`,
      }),
    )
    // 校验失败不动文件、不落登记
    expect(existsSync(candidatePath)).toBe(true)
    expect(existsSync(TEST_PRELOADED_FILE)).toBe(false)
  })

  it('sha256 mismatch (same size, different bytes): returns null, logs manual-claim', async () => {
    const sameLengthDifferent = 'XANUAL ASSET PAYLOAD FOR CLAIM TEST' // 与 ASSET_CONTENT 同长异内容
    expect(Buffer.byteLength(sameLengthDifferent)).toBe(Buffer.byteLength(ASSET_CONTENT))
    const candidatePath = placeCandidate(ASSET_NAME, sameLengthDifferent)

    const result = await tryClaimManualAsset(makeRelease())

    expect(result).toBeNull()
    expect(appendUpdateErrorMock).toHaveBeenCalledTimes(1)
    expect(appendUpdateErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'manual-claim',
        rawCause: expect.stringContaining('sha256 mismatch'),
      }),
    )
    expect(existsSync(candidatePath)).toBe(true)
    expect(existsSync(TEST_PRELOADED_FILE)).toBe(false)
  })

  it('sha256 missing in release asset: rejects (宁拒不猜), logs manual-claim', async () => {
    const candidatePath = placeCandidate(ASSET_NAME, ASSET_CONTENT)
    const release = makeRelease()
    delete release.assets.macArm64Dmg?.sha256

    const result = await tryClaimManualAsset(release)

    expect(result).toBeNull()
    expect(appendUpdateErrorMock).toHaveBeenCalledTimes(1)
    expect(appendUpdateErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'manual-claim',
        rawCause: 'sha256 missing',
      }),
    )
    expect(existsSync(candidatePath)).toBe(true)
    expect(existsSync(TEST_PRELOADED_FILE)).toBe(false)
  })
})

// ─── 噪音控制：常态不落盘 ─────────────────────────────────────────

describe('u3-claim noise control (no log on common misses)', () => {
  it('manual dir absent: returns null without logging', async () => {
    const result = await tryClaimManualAsset(makeRelease())

    expect(result).toBeNull()
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
    expect(existsSync(TEST_PRELOADED_FILE)).toBe(false)
  })

  it('manual dir exists but no same-name file: returns null without logging', async () => {
    placeCandidate('some-unrelated-file.zip', 'not the asset')

    const result = await tryClaimManualAsset(makeRelease())

    expect(result).toBeNull()
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
    expect(existsSync(TEST_PRELOADED_FILE)).toBe(false)
  })

  it('no platform asset in release: returns null without logging', async () => {
    const release = makeRelease()
    delete release.assets.macArm64Dmg

    const result = await tryClaimManualAsset(release)

    expect(result).toBeNull()
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
    expect(existsSync(TEST_PRELOADED_FILE)).toBe(false)
  })
})

// ─── ② 并发幂等与 rename 错误传播 ─────────────────────────────────

describe('u3-claim concurrency idempotency', () => {
  it('renameSync ENOENT (concurrent claim already moved it): returns final path, no mismatch log', async () => {
    const candidatePath = placeCandidate(ASSET_NAME, ASSET_CONTENT)
    renameSyncMock.mockImplementationOnce(() => {
      // 模拟并发认领已把源文件移走（statSync 通过后、renameSync 前的竞态窗口）
      throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${candidatePath}'`), {
        code: 'ENOENT',
      })
    })

    const result = await tryClaimManualAsset(makeRelease())

    expect(result).toBe(join(TEST_UPDATE_DIR, ASSET_NAME))
    // 幂等成功不落 mismatch
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
    // 登记由并发胜者负责，本调用不再写
    expect(existsSync(TEST_PRELOADED_FILE)).toBe(false)
  })

  it('renameSync non-ENOENT error: rethrows as-is', async () => {
    placeCandidate(ASSET_NAME, ASSET_CONTENT)
    renameSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })

    const caught = await tryClaimManualAsset(makeRelease()).then(
      () => null,
      (err: unknown) => err,
    )

    expect(caught).toBeInstanceOf(Error)
    expect((caught as NodeJS.ErrnoException).code).toBe('EACCES')
    expect(appendUpdateErrorMock).not.toHaveBeenCalled()
  })
})

// ─── ③ writePreloadedUpdate 失败的 best-effort 降级 ────────────────

describe('u3-claim preloaded-write tolerance', () => {
  it('preloaded write failure (best-effort inside writePreloadedUpdate): still returns final path after move', async () => {
    placeCandidate(ASSET_NAME, ASSET_CONTENT)
    // 让 writePreloadedUpdate 内部 writeFileSync 必败：占位目录顶掉目标文件路径（EISDIR）
    mkdirSync(TEST_PRELOADED_FILE, { recursive: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await tryClaimManualAsset(makeRelease())

      // move 已成功为既成事实，登记失败不否定认领（快路径 miss 时下次重下）
      expect(result).toBe(join(TEST_UPDATE_DIR, ASSET_NAME))
      expect(readFileSync(join(TEST_UPDATE_DIR, ASSET_NAME), 'utf-8')).toBe(ASSET_CONTENT)
      expect(existsSync(join(TEST_MANUAL_DIR, ASSET_NAME))).toBe(false)
      expect(appendUpdateErrorMock).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
