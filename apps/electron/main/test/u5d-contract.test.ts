/**
 * u5d 契约测试（自动升级可靠性优化 · 批次 5 收口单元）。
 *
 * 覆盖 4 项改动的验收条款：
 *   m8  Intel mac 架构门控：darwin + 非 arm64 → downloadUpdate 入口抛
 *       UpdateUnsupportedError，且**不触发任何下载**（预下载与手动下载共用入口）
 *   m9  rename 失败错误码：非权限类的落定失败 → UPDATE_FILE_RENAME_FAILED
 *   #7  UPDATE_STALE_RELEASE 接线：shared 值导出 + resolveByVersion 抛该码
 *   #13 win 侧写 updater.pid：WinUpdater spawn 后把 child.pid 落到 UPDATER_PID_FILE
 *
 * 不 mock download-asset 模块本身——m8 用「fetch 是否被调用」证明有无下载，
 * m9 则需要真实的 downloadAsset 跑完下载+校验+落定全链路。
 * 升级工作目录（getUpdateDir()）经 TAIJI_AGENT_DATA_DIR 重定向到 tmp（路径延迟求值；
 * env 前置约束已解除，保留先设 env 的做法无害）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/u5d-contract.test.ts
 */
import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LatestReleaseInfo, ReleaseAsset } from '@taiji/shared'
import { UPDATE_STALE_RELEASE } from '@taiji/shared'

// ── env 先于一切路径求值设置（延迟求值后「必须在 import constants 前设」约束已解除，做法保留无害）──
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'u5d-'))
process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

const spawnMocks = vi.hoisted(() => ({ spawn: vi.fn() }))
/**
 * 可控 renameSync 故障注入（ESM 下不能 vi.spyOn 命名空间导出，只能走 mock 工厂）。
 * failRenameWith 置为 errno 串时，所有 renameSync 调用抛该 errno。
 * 与 download-asset.test.ts 的 fsSpy 同款：在工厂闭包内捕获真实现再包一层，
 * 避免 mock 别名自调用导致无限递归。
 */
const fsMocks = vi.hoisted(() => ({ failRenameWith: undefined as string | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realRenameSync = actual.renameSync
  return {
    ...actual,
    renameSync: vi.fn((...a: Parameters<typeof actual.renameSync>) => {
      if (fsMocks.failRenameWith) {
        const e: NodeJS.ErrnoException = new Error(`injected ${fsMocks.failRenameWith}`)
        e.code = fsMocks.failRenameWith
        throw e
      }
      return realRenameSync(...a)
    }),
  }
})
vi.mock('node:child_process', () => ({ spawn: spawnMocks.spawn }))
vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '0.9.9' } }))

// 动态 import：env + mock 已就绪
async function loadOrchestrator() {
  return await import('../update/orchestrator.js')
}
async function loadDownloadAsset() {
  return await import('../update/download-asset.js')
}
async function loadPlatformUpdater() {
  return await import('../update/platform-updater.js')
}

const TEST_CONTENT = Buffer.from('u5d contract test content for download asset')
const TEST_SHA256 = createHash('sha256').update(TEST_CONTENT).digest('hex')

const MAC_RELEASE: LatestReleaseInfo = {
  version: '0.9.0',
  tagName: 'v0.9.0',
  releaseNotes: '',
  publishedAt: '',
  htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
  assets: {
    macArm64Dmg: {
      name: 'mac.dmg',
      downloadUrl: 'https://example.invalid/mac.dmg',
      size: TEST_CONTENT.length,
      sha256: TEST_SHA256,
    },
  },
}

const WIN_RELEASE: LatestReleaseInfo = {
  ...MAC_RELEASE,
  assets: {
    winX64Exe: {
      name: 'win-setup.exe',
      downloadUrl: 'https://example.invalid/win-setup.exe',
      size: 1000,
      sha256: 'b'.repeat(64),
    },
  },
}

const MAC_ASSET: ReleaseAsset = MAC_RELEASE.assets.macArm64Dmg!

function makeContentResponse(content: Buffer): Response {
  return new Response(new Uint8Array(content), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.length),
    },
  })
}

function updateDirPath(): string {
  return path.join(TMP_DATA_DIR, 'update')
}

describe('u5d: 自动升级批次 5 收口契约', () => {
  let originalPlatform: PropertyDescriptor | undefined
  let originalArch: PropertyDescriptor | undefined
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    originalArch = Object.getOwnPropertyDescriptor(process, 'arch')
    originalFetch = globalThis.fetch
    vi.clearAllMocks()
    fsMocks.failRenameWith = undefined
    spawnMocks.spawn.mockReturnValue({ pid: 4242, unref: vi.fn() })
  })

  afterEach(() => {
    fsMocks.failRenameWith = undefined
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    if (originalArch) Object.defineProperty(process, 'arch', originalArch)
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    if (existsSync(updateDirPath())) rmSync(updateDirPath(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function setArch(arch: string): void {
    Object.defineProperty(process, 'arch', { value: arch, configurable: true })
  }
  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  }

  // ── #7 放最前：orchestrator 的 resolveByVersion 有 60s 模块级节流，
  //    本文件内只有这一条用例触发拒绝，先跑可避开被其它用例污染。──────
  it('#7: UPDATE_STALE_RELEASE 由 shared 导出，且版本过期分支携带该错误码', async () => {
    // ① shared 侧值导出存在（orchestrator 才能以常量引用替代字面量桥接）
    expect(UPDATE_STALE_RELEASE).toBe('UPDATE_STALE_RELEASE')

    const { resolveByVersion } = await loadOrchestrator()
    const checker = {
      checkForLatestRelease: vi
        .fn()
        // 第一次（缓存查询）返回 null → 触发权威 force check
        .mockResolvedValueOnce(null)
        // 第二次（force）返回与请求版本不同的 latest → STALE_RELEASE
        .mockResolvedValueOnce({ ...MAC_RELEASE, version: '9.9.9' }),
    }

    const err = await resolveByVersion('0.9.0', {
      currentVersion: '0.8.0',
      releaseChecker: checker as never,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as { errorCode?: string }).errorCode).toBe(UPDATE_STALE_RELEASE)
    expect((err as Error).message).toContain('stale')
  })

  it('m8: darwin + 非 arm64 → 抛 UpdateUnsupportedError（带 fallbackUrl）且完全不下载', async () => {
    setPlatform('darwin')
    setArch('x64')
    // 若门控失效而下到下载阶段，fetch 会被调用——用「零调用」反证入口拦截生效
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT))

    const { downloadUpdate } = await loadOrchestrator()
    const err = await downloadUpdate(MAC_RELEASE).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('UpdateUnsupportedError')
    expect((err as { fallbackUrl?: string }).fallbackUrl).toBe(MAC_RELEASE.htmlUrl)
    // 核心断言：一个字节都没下（预下载同样共用本入口，因此也被拦住）
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('m8 反例: darwin + arm64 放行到下载阶段（不被门控拦截）', async () => {
    setPlatform('darwin')
    setArch('arm64')
    // 下载阶段必然失败（拒绝网络），但只要门控放行就会走到 fetch
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })

    const { downloadUpdate } = await loadOrchestrator()
    const err = await downloadUpdate(MAC_RELEASE).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    // 不是架构不支持，而是网络失败 → 证明已越过门控进入下载
    expect((err as Error).name).not.toBe('UpdateUnsupportedError')
    expect((err as { errorCode?: string }).errorCode).toBe('UPDATE_NETWORK_FAILED')
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  it('m9: rename 落定失败（非权限类）→ UPDATE_FILE_RENAME_FAILED', async () => {
    const { downloadAsset } = await loadDownloadAsset()
    mkdirSync(updateDirPath(), { recursive: true })
    // 预置终态路径为目录 → renameSync(file → dir) 抛 ENOTEMPTY/EISDIR，
    // 既非 EACCES 也非 EPERM，走通用分支（此前误报 UPDATE_INTEGRITY_FAILED）
    mkdirSync(path.join(updateDirPath(), MAC_ASSET.name))

    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT))
    const err = await downloadAsset(MAC_ASSET).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as { errorCode?: string }).errorCode).toBe('UPDATE_FILE_RENAME_FAILED')
  })

  it('m9 反例: rename 权限失败仍归 UPDATE_PERMISSION_DENIED（不被新码吞掉）', async () => {
    const { downloadAsset } = await loadDownloadAsset()
    globalThis.fetch = vi.fn(async () => makeContentResponse(TEST_CONTENT))
    fsMocks.failRenameWith = 'EACCES'

    const err = await downloadAsset(MAC_ASSET).catch((e: unknown) => e)

    expect((err as { errorCode?: string }).errorCode).toBe('UPDATE_PERMISSION_DENIED')
  })

  it('#13: WinUpdater spawn 后把 child.pid 写入 UPDATER_PID_FILE', async () => {
    setPlatform('win32')
    spawnMocks.spawn.mockReturnValue({ pid: 4242, unref: vi.fn() })

    const { createPlatformUpdater } = await loadPlatformUpdater()
    const ref = createPlatformUpdater().prepareUpdate('/tmp/downloaded-setup.exe', WIN_RELEASE)

    expect(ref.kind).toBe('detached-script')
    expect(spawnMocks.spawn).toHaveBeenCalledWith(
      'cmd',
      ['/c', path.join(updateDirPath(), 'updater.cmd')],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    )
    const pidFile = path.join(updateDirPath(), 'updater.pid')
    expect(existsSync(pidFile)).toBe(true)
    expect(readFileSync(pidFile, 'utf-8')).toBe('4242')
  })

  it('#13 容错: spawn 未返回 pid 时不抛错、不写 pid 文件', async () => {
    setPlatform('win32')
    spawnMocks.spawn.mockReturnValue({ pid: undefined, unref: vi.fn() })

    const { createPlatformUpdater } = await loadPlatformUpdater()
    const ref = createPlatformUpdater().prepareUpdate('/tmp/downloaded-setup.exe', WIN_RELEASE)

    expect(ref.kind).toBe('detached-script')
    expect(existsSync(path.join(updateDirPath(), 'updater.pid'))).toBe(false)
  })

  it('两个新错误码都有中文文案，且 stage 落在合法 UpdateStage 内', async () => {
    const { UPDATE_ERROR_MESSAGES } = await import('../update/types.js')
    type Stage = (typeof UPDATE_ERROR_MESSAGES)[keyof typeof UPDATE_ERROR_MESSAGES]['stage']
    const validStages = new Set<Stage>(['downloading', 'replacing', 'restarting'])

    for (const code of ['UPDATE_STALE_RELEASE', 'UPDATE_FILE_RENAME_FAILED'] as const) {
      const info = UPDATE_ERROR_MESSAGES[code]
      expect(info, `${code} 应有文案条目`).toBeDefined()
      expect(info.message.length).toBeGreaterThan(0)
      expect(info.suggestion.length).toBeGreaterThan(0)
      expect(validStages.has(info.stage)).toBe(true)
    }
  })
})
