// types.test.ts —— electron-main-test C15 簇合并产物（round5-G）。
// 共同被测业务模块：`update/types.ts`。mock 相容：单侧 mock electron、node:child_process、node:fs——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - test/u5d-contract.test.ts（8 用例，skip 0）
//   - test/validate-release.test.ts（34 用例，skip 0）

import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type LatestReleaseInfo, type ReleaseAsset, UPDATE_STALE_RELEASE } from '@taiji/shared'
import { validateRelease } from '../update/validate-release'
import { UpdateError } from '../update/types'
import { ALLOWED_DOWNLOAD_HOSTS, RELEASE_SOURCE_HOSTS } from '../update/release-sources'

const spawnMocks = vi.hoisted(() => ({ spawn: vi.fn() }))
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

// ======== 来源：u5d-contract.test.ts ========
describe("u5d-contract", () => {
  // ── env 先于一切路径求值设置（延迟求值后「必须在 import constants 前设」约束已解除，做法保留无害）──
  const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'u5d-'))

  process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

  /**
 * 可控 renameSync 故障注入（ESM 下不能 vi.spyOn 命名空间导出，只能走 mock 工厂）。
 * failRenameWith 置为 errno 串时，所有 renameSync 调用抛该 errno。
 * 与 download-asset.test.ts 的 fsSpy 同款：在工厂闭包内捕获真实现再包一层，
 * 避免 mock 别名自调用导致无限递归。
 */

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

  describe('u5d: 自动升级批次 5 收尾契约', () => {
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
});

// ======== 来源：validate-release.test.ts ========
describe("validate-release", () => {
  /** 合法的 mac asset（GitHub 域名 + https + 64 位 hex sha256） */
  const VALID_MAC = {
    name: 'TaiJi-mac-arm64.dmg',
    downloadUrl: 'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/TaiJi-mac-arm64.dmg',
    size: 1000,
    sha256: 'a'.repeat(64),
  }

  /** 构造一个合法的 base release（按需 override） */
  function makeRelease(overrides: Partial<LatestReleaseInfo> = {}): LatestReleaseInfo {
    return {
      version: '0.9.0',
      tagName: 'v0.9.0',
      releaseNotes: '## changes',
      publishedAt: '2025-12-01T00:00:00Z',
      htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
      assets: { macArm64Dmg: { ...VALID_MAC } },
      ...overrides,
    }
  }

  /** 覆盖某个 asset */
  function withAsset(
    key: 'macArm64Dmg' | 'winX64Exe' | 'linuxX64AppImage',
    asset: LatestReleaseInfo['assets']['macArm64Dmg'],
  ): LatestReleaseInfo {
    const release = makeRelease()
    release.assets = { [key]: asset } as LatestReleaseInfo['assets']
    return release
  }

  describe('validate-release', () => {
    // ── happy path ──────────────────────────────────────────────────
    it('合法 payload（GitHub https + 64 位 hex sha256）→ 不抛', () => {
      expect(() => validateRelease(makeRelease())).not.toThrow()
    })

    it('4 段版本号（0.9.0.1）合法 → 不抛', () => {
      expect(() => validateRelease(makeRelease({ version: '0.9.0.1' }))).not.toThrow()
    })

    it('objects.githubusercontent.com 域名合法 → 不抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl =
        'https://objects.githubusercontent.com/taiji/asset.zip?token=abc'
      expect(() => validateRelease(release)).not.toThrow()
    })

    it('sha256 缺失（undefined）合法 → 不抛（仅 size 校验时 size 不查格式）', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.sha256 = undefined
      expect(() => validateRelease(release)).not.toThrow()
    })

    it('所有 3 个 asset 都存在且合法 → 不抛', () => {
      const release = makeRelease()
      release.assets = {
        macArm64Dmg: { ...VALID_MAC },
        winX64Exe: {
          name: 'TaiJi-0.10.0-win-x64.exe',
          downloadUrl: 'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/TaiJi-0.10.0-win-x64.exe',
          size: 2000,
          sha256: 'b'.repeat(64),
        },
        linuxX64AppImage: {
          name: 'TaiJi-0.10.0-linux-x64.AppImage',
          downloadUrl: 'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/TaiJi-0.10.0-linux-x64.AppImage',
          size: 3000,
        },
      }
      expect(() => validateRelease(release)).not.toThrow()
    })

    it('assets 全空对象（无任何平台 asset）合法 → 不抛', () => {
      expect(() => validateRelease(makeRelease({ assets: {} }))).not.toThrow()
    })

    // ── version 非法 ────────────────────────────────────────────────
    it('version 含前导 v → 抛 UpdateError(downloading)', () => {
      expect(() => validateRelease(makeRelease({ version: 'v0.9.0' }))).toThrow(UpdateError)
      expect(() => validateRelease(makeRelease({ version: 'v0.9.0' }))).toThrow(/invalid version/)
    })

    it('version 含特殊字符（0.9.0; rm -rf）→ 抛（防 shell 注入）', () => {
      expect(() => validateRelease(makeRelease({ version: '0.9.0;rm -rf' }))).toThrow(/invalid version/)
    })

    it('version 段数不足（0.9）→ 抛', () => {
      expect(() => validateRelease(makeRelease({ version: '0.9' }))).toThrow(/invalid version/)
    })

    it('version 非数字（x.y.z）→ 抛', () => {
      expect(() => validateRelease(makeRelease({ version: 'x.y.z' }))).toThrow(/invalid version/)
    })

    it('version 5 段（0.9.0.1.2）→ 抛', () => {
      expect(() => validateRelease(makeRelease({ version: '0.9.0.1.2' }))).toThrow(/invalid version/)
    })

    // ── asset.name 路径遍历 + shell 注入 ───────────────────────────
    it('name 含 ../（路径遍历）→ 抛', () => {
      const release = withAsset('macArm64Dmg', {
        ...VALID_MAC,
        name: '../../etc/passwd',
      })
      expect(() => validateRelease(release)).toThrow(/invalid asset name/)
    })

    it('name 含分号（shell 元字符）→ 抛', () => {
      const release = withAsset('macArm64Dmg', {
        ...VALID_MAC,
        name: 'evil;rm -rf.zip',
      })
      expect(() => validateRelease(release)).toThrow(/invalid asset name/)
    })

    it('name 含空格 → 抛', () => {
      const release = withAsset('macArm64Dmg', {
        ...VALID_MAC,
        name: 'evil name.zip',
      })
      expect(() => validateRelease(release)).toThrow(/invalid asset name/)
    })

    it('name 含美元符号（$ 变量展开）→ 抛', () => {
      const release = withAsset('macArm64Dmg', {
        ...VALID_MAC,
        name: 'evil$HOME.zip',
      })
      expect(() => validateRelease(release)).toThrow(/invalid asset name/)
    })

    it('name 含反引号（命令替换）→ 抛', () => {
      const release = withAsset('macArm64Dmg', {
        ...VALID_MAC,
        name: 'evil`whoami`.zip',
      })
      expect(() => validateRelease(release)).toThrow(/invalid asset name/)
    })

    it('name 含斜杠（路径分隔符）→ 抛', () => {
      const release = withAsset('macArm64Dmg', {
        ...VALID_MAC,
        name: 'sub/dir.zip',
      })
      expect(() => validateRelease(release)).toThrow(/invalid asset name/)
    })

    it('winX64Exe asset name 非法 → 抛（不只检查 macArm64Dmg）', () => {
      const release = withAsset('winX64Exe', {
        ...VALID_MAC,
        name: '../evil.exe',
      })
      expect(() => validateRelease(release)).toThrow(/invalid asset name/)
    })

    // ── downloadUrl SSRF 防护 ───────────────────────────────────────
    it('downloadUrl 是 http://（非 https）→ 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl =
        'http://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/mac.zip'
      expect(() => validateRelease(release)).toThrow(/must be https/)
    })

    it('downloadUrl 是 file://（本地文件读取 SSRF）→ 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl = 'file:///etc/passwd'
      expect(() => validateRelease(release)).toThrow(/must be https/)
    })

    it('downloadUrl 非白名单域名（内网探测 SSRF）→ 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl =
        'https://169.254.169.254/latest/meta-data/' // AWS metadata endpoint
      expect(() => validateRelease(release)).toThrow(/host not allowed/)
    })

    it('downloadUrl 非白名单域名（example.com）→ 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl = 'https://example.com/mac.zip'
      expect(() => validateRelease(release)).toThrow(/host not allowed/)
    })

    it('downloadUrl localhost（内网探测）→ 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl = 'https://localhost:8080/mac.zip'
      expect(() => validateRelease(release)).toThrow(/host not allowed/)
    })

    it('downloadUrl 非法格式（无法 parse）→ 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl = 'not-a-url'
      expect(() => validateRelease(release)).toThrow(/invalid download url/)
    })

    // ── sha256 格式 ─────────────────────────────────────────────────
    it('sha256 非 64 位（太短 abc123）→ 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.sha256 = 'abc123'
      expect(() => validateRelease(release)).toThrow(/invalid sha256 format/)
    })

    it('sha256 含非 hex 字符 → 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.sha256 = 'g'.repeat(64) // g 不是 hex
      expect(() => validateRelease(release)).toThrow(/invalid sha256 format/)
    })

    it('sha256 含分号（shell 注入到校验脚本）→ 抛', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.sha256 = 'a'.repeat(63) + ';' // 64 字符但含 ;
      expect(() => validateRelease(release)).toThrow(/invalid sha256 format/)
    })

    it('sha256 大写 hex 合法 → 不抛（大小写不敏感）', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.sha256 = 'A'.repeat(64)
      expect(() => validateRelease(release)).not.toThrow()
    })

    // ── 错误类型 ────────────────────────────────────────────────────
    it('所有校验失败都抛 UpdateError 且 stage=downloading', () => {
      try {
        validateRelease(makeRelease({ version: 'bad' }))
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(UpdateError)
        expect((err as UpdateError).stage).toBe('downloading')
      }
    })
  })

  // ── 多源白名单（update-multi-source D6：域集合消费 release-sources 单一来源）────

  describe('validate-release 多源白名单', () => {
    it('gitcode.com 域（GitCode 下载直链，P1 探针落域）→ 放行', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl =
        'https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.9.15/TaiJi-mac-arm64.dmg'
      expect(() => validateRelease(release)).not.toThrow()
    })

    it('api.gitcode.com（API 域，非下载白名单成员）→ 仍拒绝（严格 hostname 匹配，无后缀放行）', () => {
      const release = makeRelease()
      release.assets.macArm64Dmg!.downloadUrl =
        'https://api.gitcode.com/api/v5/repos/qq_18433817/tai-ji/attach_files/x.dmg'
      expect(() => validateRelease(release)).toThrow(/host not allowed/)
    })

    it('域集合与 release-sources 导出同源：白名单 = 两源下载域精确集合（防漂移断言）', () => {
      // 单一来源 SSOT 内容锁定：GitHub 现行 2 域 + GitCode 下载域
      expect([...ALLOWED_DOWNLOAD_HOSTS].sort()).toEqual([
        RELEASE_SOURCE_HOSTS.gitcodeDownload,
        RELEASE_SOURCE_HOSTS.githubDownload,
        RELEASE_SOURCE_HOSTS.githubAssetsCdn,
      ])
    })

    it('ALLOWED_DOWNLOAD_HOSTS 内每个域都能通过校验（遍历放行断言，集合扩域不漏测）', () => {
      for (const host of ALLOWED_DOWNLOAD_HOSTS) {
        const release = makeRelease()
        release.assets.macArm64Dmg!.downloadUrl = `https://${host}/releases/download/v0.9.0/asset.bin`
        expect(() => validateRelease(release), `host ${host} should be allowed`).not.toThrow()
      }
    })

    it('白名单扩域不放松既有防线：file:// / 内网 IP / 任意域 / 非 https 依旧拒绝', () => {
      const rejectUrls = [
        'file:///etc/passwd',
        'http://gitcode.com/asset.dmg',
        'https://169.254.169.254/latest/meta-data/',
        'https://evil.example.com/asset.dmg',
      ]
      for (const url of rejectUrls) {
        const release = makeRelease()
        release.assets.macArm64Dmg!.downloadUrl = url
        expect(() => validateRelease(release), `url ${url} should be rejected`).toThrow(UpdateError)
      }
    })
  })
});
