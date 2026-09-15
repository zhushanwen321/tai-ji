/**
 * W2 TDD 测试：ReleaseChecker（自动升级检测后端，多源编排版）。
 *
 * 多源改造（update-multi-source §4.2①-⑥）后的覆盖面：
 *   W2TC1 happy path：主源 /releases/latest 返回 v0.9.0 → 胜出即出循环（次源零请求）
 *   W2TC2 三重 prerelease 过滤：防御 b（prerelease/draft）checker 循环内拦截 →
 *         该源「无新版」→ 次源；防御 c（tag 正则）→「该源无新版」（循环内 per-source）
 *   W2TC3 版本比较：同版本 / 更老版本 → 全源确认无新版 → 负缓存
 *   W2TC4 asset 平台分流：3 平台产物（dmg/exe/AppImage）+ blockmap/存量 zip 干扰
 *   W2TC5 缓存：连续两次非 force 第二次不 fetch；force 强制刷新
 *   W2TC6 失败降级：fetch 抛错 / 404 / AbortError → null 不抛；
 *         403 → per-source 退避（见「per-source 退避」组）；失败不缓存
 *   W2TC7 extractSha256 严格校验（适配层 digest 提取）
 *   W2TC8 win 产物名后缀匹配（M7-01 P0 回归防护）
 *   D6TC1-3/5 代理优先 + 失败降级直连（通道维度编排，现位于适配层 fetchSourceRelease）
 *   D6TC4 代理+直连双失败 → 该源失败 → 次源（逐源降级语义）
 *   负缓存组（重写）：循环出口语义——全部源确认无新版才写负缓存；
 *         主源无新版不写全局负缓存；混合态不写负缓存
 *   per-source 退避组：403 记该源退避、退避源短路零请求、getRateLimitedUntil
 *         全部源退避才返回最早解除时刻（min）/任一源可用返回 0
 *   manifest 组：AtomGit manifest 失败降级次源 / GitHub manifest 失败不阻塞 /
 *         manifest size 扩展填充
 *   诊断组：source-selection / source-failover 登记接线
 *   透传组：fetchReleaseByTag 无状态透传
 *
 * Mock 策略：
 * - globalThis.fetch 按 URL 路由响应（适配层 latest/by-tag 与 checker manifest 两类请求）
 * - resolveSourceOrder 经构造注入 mock（消除 auto 探测请求混入，§7.2 存量测试迁移）
 * - error-log 模块 mock（隔离降频快照 + 不落盘）；update-settings 仅 mock getUpdateSettings
 * - fetch mock 抛错一律使用无 errno code 的 Error（classifyUndiciFailure → non-fallback，
 *   不触发 curl 引擎真实 spawn，零真实网络请求）
 *
 * 运行：cd apps/electron/main && npx vitest run test/release-checker.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReleaseChecker } from '../release-checker.js'
import * as proxyConfig from '../update/proxy-config.js'

// error-log mock（模块级）：隔离 source-selection 降频快照 + 测试不落盘
const errorLogMocks = vi.hoisted(() => ({
  logSourceSelection: vi.fn(),
  logSourceFailover: vi.fn(),
}))
vi.mock('../update/error-log.js', () => ({
  logSourceSelection: errorLogMocks.logSourceSelection,
  logSourceFailover: errorLogMocks.logSourceFailover,
  logDownloadSuccess: vi.fn(),
  appendUpdateError: vi.fn(() => true),
}))

// update-settings mock：updateSource 偏好可控（默认 auto），避免读本机 settings 文件
const settingsMock = vi.hoisted(() => ({ updateSource: 'auto' as 'auto' | 'github' | 'atomgit' }))
vi.mock('../update/update-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update/update-settings.js')>()
  return {
    ...actual,
    getUpdateSettings: vi.fn(() => ({ ...actual.DEFAULT_UPDATE_SETTINGS, updateSource: settingsMock.updateSource })),
  }
})

// source-resolver mock：getLastProbeOutcome 可控（默认 null = 无探测决策详情，
// auto 路径走防御性兜底登记）；resolveSourceOrder 不经此 mock（测试用构造注入），
// 保留真实实现以免其他导出消费点失联
type MockProbeOutcome = {
  via: 'probe' | 'proxy-short-circuit'
  decidedAt: number
  results: Partial<Record<string, { reachable: boolean }>>
}
const resolverMocks = vi.hoisted(() => ({
  getLastProbeOutcome: vi.fn(() => null as MockProbeOutcome | null),
}))
vi.mock('../update/source-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update/source-resolver.js')>()
  return { ...actual, getLastProbeOutcome: resolverMocks.getLastProbeOutcome }
})

import type { UpdateSource } from '@taiji/shared'

// ── 端点形态常量（与适配层 ADAPTERS / checker buildManifestByTagUrl 对齐）──
const GITHUB_LATEST_URL = 'https://api.github.com/repos/zhushanwen321/tai-ji/releases/latest'
const ATOMGIT_LATEST_URL =
  'https://api.gitcode.com/api/v5/repos/qq_18433817/tai-ji/releases/latest'
const GITHUB_BY_TAG_PREFIX = 'https://api.github.com/repos/zhushanwen321/tai-ji/releases/tags/'
const ATOMGIT_BY_TAG_PREFIX =
  'https://api.gitcode.com/api/v5/repos/qq_18433817/tai-ji/releases/tags/'
const GITHUB_MANIFEST_URL =
  'https://github.com/zhushanwen321/tai-ji/releases/download/v0.9.0/manifest.json'
const ATOMGIT_MANIFEST_URL =
  'https://gitcode.com/qq_18433817/tai-ji/releases/download/v0.9.0/manifest.json'

/** 构造一个完整的 release JSON（含 3 平台 + blockmap/存量 zip 干扰资产） */
function makeReleaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.9.0',
    prerelease: false,
    draft: false,
    body: '## What changed\n- new feature',
    published_at: '2025-12-01T00:00:00Z',
    html_url: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
    assets: [
      {
        name: 'TaiJi-mac-arm64.dmg',
        browser_download_url: 'https://example.com/mac-arm64.dmg',
        size: 1000,
        // 合法 64 位 hex（全 a 便于断言）
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        name: 'TaiJi-setup-x64.exe',
        browser_download_url: 'https://example.com/setup-x64.exe',
        size: 2000,
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      {
        name: 'TaiJi-x86_64.AppImage',
        browser_download_url: 'https://example.com/x86_64.AppImage',
        size: 3000,
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      // 干扰①：blockmap 不应被选中（digest 用 sha512 以验证不会被误当 sha256）
      {
        name: 'TaiJi-mac-arm64.dmg.blockmap',
        browser_download_url: 'https://example.com/mac-arm64.dmg.blockmap',
        size: 10,
        digest: 'sha512:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
      // 干扰②：存量历史 release 的 mac zip（批次 3 后只发 dmg）不得被选中
      {
        name: 'TaiJi-0.8.44-mac-arm64.zip',
        browser_download_url: 'https://example.com/TaiJi-0.8.44-mac-arm64.zip',
        size: 5000,
        digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      },
    ],
    ...overrides,
  }
}

/** 无 digest 的单平台 asset（触发 manifest fallback；size 缺省 = AtomGit 形态） */
function assetWithoutDigest(name: string, url: string, size?: number): Record<string, unknown> {
  const asset: Record<string, unknown> = { name, browser_download_url: url }
  if (size !== undefined) asset.size = size
  return asset
}

/** manifest.json 资产（§4.2⑤：checker 从胜出源 assets 取 browser_download_url 作直链） */
function manifestAsset(url: string): Record<string, unknown> {
  return { name: 'manifest.json', browser_download_url: url }
}

/** 用给定 JSON 构造一个 200 Response */
function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type FetchResponder = (url: string) => Response

/** 按 URL 路由的 fetch mock（返回 spy 便于调用计数/URL 断言） */
function installRoutedFetch(respond: FetchResponder): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: unknown) => respond(String(input)))
  globalThis.fetch = spy as unknown as typeof globalThis.fetch
  return spy
}

/** spy 的调用 URL 列表 */
function calledUrls(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]))
}

/** 构造注入固定源顺序的 checker（消除 auto 探测请求混入） */
function makeChecker(order: UpdateSource[] = ['github', 'atomgit']): ReleaseChecker {
  return new ReleaseChecker({ resolveSourceOrder: async () => order })
}

describe('W2: ReleaseChecker 自动升级检测（多源编排）', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    settingsMock.updateSource = 'auto'
    errorLogMocks.logSourceSelection.mockClear()
    errorLogMocks.logSourceFailover.mockClear()
    resolverMocks.getLastProbeOutcome.mockClear()
    resolverMocks.getLastProbeOutcome.mockReturnValue(null)
    // 默认 mock 代理配置为 disabled（防止真实 proxy-config.json 干扰原有测试）
    vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
    vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // ── W2TC1：happy path ──────────────────────────────────────────
  it('W2TC1: 主源返回 v0.9.0（current=0.8.14）→ 胜出即出循环（次源零请求），version/sha256 正确', async () => {
    const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.version).toBe('0.9.0')
    expect(result!.tagName).toBe('v0.9.0')
    expect(result!.source).toBe('github')
    expect(result!.releaseNotes).toContain('new feature')
    expect(result!.publishedAt).toBe('2025-12-01T00:00:00Z')
    expect(result!.htmlUrl).toContain('v0.9.0')
    // sha256 从 digest strip 'sha256:' 前缀（适配层提取，必须 64 位 hex 才被接受）
    expect(result!.assets.macArm64Dmg?.sha256).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
    expect(result!.assets.winX64Exe?.sha256).toBe(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
    // 首个胜出源即出循环：只发主源 latest 一次请求
    expect(spy).toHaveBeenCalledTimes(1)
    expect(calledUrls(spy)[0]).toBe(GITHUB_LATEST_URL)
  })

  // ── W2TC2：三重 prerelease 过滤 ───────────────────────────────
  it('W2TC2a: prerelease=true → 防御 b 拦截（该源无新版）→ 两源均无新版 → 负缓存 + null', async () => {
    // fake timers 供末尾负缓存判别断言（TTL 推进，写法对齐负缓存 describe 用例）
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_700_000_000_000)
      const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson({ prerelease: true })))

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
      // 防御 b 在循环内 per-source 生效（fetchSourceRelease 返回完整产物不做拦截）：
      // 主源拦截后继续试次源，两源均「确认无新版」→ 全局负缓存成立
      expect(spy).toHaveBeenCalledTimes(2)

      // 判别力断言（R2-U2，设计 §4.2③④）：prerelease 归 noNewVersionSources（「无新版」桶）
      // 而非 failedSources——负缓存已写：TTL 内再查命中零 fetch（若归失败桶则会重新逐源）
      vi.setSystemTime(Date.now() + 30 * 60 * 1000)
      const r2 = await checker.checkForLatestRelease('0.8.14')
      expect(r2).toBeNull()
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('W2TC2b: draft=true → 防御 b 拦截 → 返回 null', async () => {
    installRoutedFetch(() => jsonResponse(makeReleaseJson({ draft: true })))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC2c: tag=v0.9.0-rc1（非严格 3 位）→ 防御 c「该源无新版」→ 两源均无新版 → null', async () => {
    const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson({ tag_name: 'v0.9.0-rc1' })))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
    // 防御 c 在循环内 per-source 生效：主源无新版后继续试次源
    expect(spy).toHaveBeenCalledTimes(2)
    expect(calledUrls(spy)).toContain(ATOMGIT_LATEST_URL)
  })

  // ── W2TC3：版本比较 ───────────────────────────────────────────
  it('W2TC3a: latest == current（同为 0.8.14）→ 主源无新版 → 试次源 → 全源确认无新版 → null', async () => {
    const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson({ tag_name: 'v0.8.14' })))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('W2TC3b: latest 比 current 更老（0.8.13 < 0.8.14）→ 返回 null', async () => {
    installRoutedFetch(() => jsonResponse(makeReleaseJson({ tag_name: 'v0.8.13' })))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  // ── W2TC4：asset 平台分流 ─────────────────────────────────────
  it('W2TC4: assets 含 3 平台 + blockmap/存量 zip 干扰 → 各平台 downloadUrl 正确，干扰不被选', async () => {
    installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.assets.macArm64Dmg?.downloadUrl).toBe('https://example.com/mac-arm64.dmg')
    expect(result!.assets.winX64Exe?.downloadUrl).toBe('https://example.com/setup-x64.exe')
    expect(result!.assets.linuxX64AppImage?.downloadUrl).toBe('https://example.com/x86_64.AppImage')
    // size 透传
    expect(result!.assets.macArm64Dmg?.size).toBe(1000)
    // blockmap 与存量 mac zip 不应出现在任何分流字段（S8：ASSET_PATTERNS 只认 dmg）
    const allUrls = [
      result!.assets.macArm64Dmg?.downloadUrl,
      result!.assets.winX64Exe?.downloadUrl,
      result!.assets.linuxX64AppImage?.downloadUrl,
    ]
    expect(allUrls).not.toContain('https://example.com/mac-arm64.dmg.blockmap')
    expect(allUrls, '存量历史 zip 不得被 mac 分流选中').not.toContain(
      'https://example.com/TaiJi-0.8.44-mac-arm64.zip',
    )
  })

  // ── W2TC4b：ASSET_PATTERNS dmg 后缀匹配（S8：匹配 .dmg 不匹配 .zip）──
  it('W2TC4b: TaiJi-<version>-mac-arm64.dmg（带版本号形态）→ macArm64Dmg 匹配；同形态 .zip 不匹配', async () => {
    installRoutedFetch(() =>
      jsonResponse(
        makeReleaseJson({
          assets: [
            {
              name: 'TaiJi-0.9.0-mac-arm64.dmg',
              browser_download_url: 'https://example.com/TaiJi-0.9.0-mac-arm64.dmg',
              size: 1000,
              digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            {
              name: 'TaiJi-0.9.0-mac-arm64.zip',
              browser_download_url: 'https://example.com/TaiJi-0.9.0-mac-arm64.zip',
              size: 2000,
              digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
          ],
        }),
      ),
    )

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.assets.macArm64Dmg?.downloadUrl).toBe('https://example.com/TaiJi-0.9.0-mac-arm64.dmg')
    // 批次 3 后 mac 只认 dmg（设计 §3.3.3-A）：zip 形态不进任何分流字段
    const urls = [
      result!.assets.macArm64Dmg?.downloadUrl,
      result!.assets.winX64Exe?.downloadUrl,
      result!.assets.linuxX64AppImage?.downloadUrl,
    ]
    expect(urls).not.toContain('https://example.com/TaiJi-0.9.0-mac-arm64.zip')
  })

  // ── W2TC5：缓存 ───────────────────────────────────────────────
  it('W2TC5a: 连续两次非 force → fetch 第二次不调用（正缓存命中）', async () => {
    const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const checker = makeChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    const r2 = await checker.checkForLatestRelease('0.8.14')

    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(r2).toEqual(r1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('W2TC5b: force=true → 绕过缓存重新 fetch', async () => {
    const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const checker = makeChecker()
    await checker.checkForLatestRelease('0.8.14')
    expect(spy).toHaveBeenCalledTimes(1)

    await checker.checkForLatestRelease('0.8.14', { force: true })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  // ── W2TC6：失败降级 ───────────────────────────────────────────
  it('W2TC6a: fetch 抛错（主源+次源均网络失败）→ 返回 null 不抛', async () => {
    installRoutedFetch(() => {
      throw new Error('network error')
    })

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC6b: 主源 403 → 记该源退避 + 次源可达（per-source 退避语义，详见退避组）', async () => {
    installRoutedFetch((url) =>
      url === GITHUB_LATEST_URL
        ? new Response('rate limited', { status: 403 })
        : jsonResponse(makeReleaseJson()),
    )

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    // github 403 记退避 → atomgit 照常尝试并胜出（退避 per-source，不阻塞次源）
    expect(result).not.toBeNull()
    expect(result!.source).toBe('atomgit')
    // atomgit 可用即检查可正常出结论：全源退避语义下仅 github 退避 → 返回 0
    //（不误报 rateLimited；github 退避的存在性由退避组短路用例的零请求计数证明）
    expect(checker.getRateLimitedUntil()).toBe(0)
  })

  it('W2TC6c: 返回 404（两源均无 release 数据）→ 返回 null', async () => {
    installRoutedFetch(() => new Response('not found', { status: 404 }))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC6d: AbortError（超时）→ 返回 null 不抛', async () => {
    installRoutedFetch(() => {
      // 模拟 AbortController.abort() 触发的 DOMException
      throw new DOMException('The operation was aborted', 'AbortError')
    })

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()
  })

  it('W2TC6e: 失败不缓存（第一轮两源均失败 → 第二轮主源恢复即重新 fetch 并胜出）', async () => {
    let callCount = 0
    const spy = installRoutedFetch(() => {
      callCount++
      if (callCount <= 2) return new Response('error', { status: 500 }) // 第一轮：github + atomgit 均失败
      return jsonResponse(makeReleaseJson()) // 第二轮：github 恢复
    })

    const checker = makeChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    expect(r1).toBeNull()

    const r2 = await checker.checkForLatestRelease('0.8.14')
    expect(r2).not.toBeNull()
    expect(r2!.source).toBe('github')
    // 第一轮 2 次（逐源）+ 第二轮 1 次（github 恢复即胜出）——失败未被缓存
    expect(callCount).toBe(3)
    expect(spy).toHaveBeenCalledTimes(3)
  })

  // ── W2TC7：extractSha256 严格校验（适配层，防御 sha512 / 非法格式污染）────────
  it('W2TC7: 非 sha256 格式的 digest（sha512 / 短 hex / 垃圾）→ sha256 字段为 undefined', async () => {
    const sha512Hex = 'e'.repeat(128) // sha512 是 128 位 hex
    installRoutedFetch(() =>
      jsonResponse(
        makeReleaseJson({
          assets: [
            {
              name: 'TaiJi-mac-arm64.dmg',
              browser_download_url: 'https://example.com/mac.dmg',
              size: 1000,
              // sha512 前缀 → 必须拒绝，不能原样返回
              digest: `sha512:${sha512Hex}`,
            },
            {
              name: 'TaiJi-setup-x64.exe',
              browser_download_url: 'https://example.com/exe',
              size: 2000,
              // sha256 前缀但 hex 长度不对（6 位）→ 拒绝
              digest: 'sha256:abc123',
            },
            {
              name: 'TaiJi-x86_64.AppImage',
              browser_download_url: 'https://example.com/appimage',
              size: 3000,
              // 无前缀、垃圾数据 → 拒绝
              digest: 'not-a-hex-string',
            },
          ],
        }),
      ),
    )

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    // sha512 前缀：禁止原样返回（修复前的 bug 会返回 'sha512:...'）
    expect(result!.assets.macArm64Dmg?.sha256).toBeUndefined()
    // sha256 前缀但 hex 长度不对：拒绝
    expect(result!.assets.winX64Exe?.sha256).toBeUndefined()
    // 垃圾数据：拒绝
    expect(result!.assets.linuxX64AppImage?.sha256).toBeUndefined()
  })

  it('W2TC7b: 无前缀纯 64 位 hex digest → 接受（三平台资产同分支）', async () => {
    installRoutedFetch(() =>
      jsonResponse(
        makeReleaseJson({
          assets: [
            {
              name: 'TaiJi-mac-arm64.dmg',
              browser_download_url: 'https://example.com/mac.dmg',
              size: 1000,
              digest: 'f'.repeat(64),
            },
            {
              name: 'TaiJi-setup-x64.exe',
              browser_download_url: 'https://example.com/exe',
              size: 2000,
              digest: 'a'.repeat(64),
            },
            {
              name: 'TaiJi-x86_64.AppImage',
              browser_download_url: 'https://example.com/appimage',
              size: 3000,
              digest: 'b'.repeat(64),
            },
          ],
        }),
      ),
    )

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.assets.macArm64Dmg?.sha256).toBe('f'.repeat(64))
    expect(result!.assets.winX64Exe?.sha256).toBe('a'.repeat(64))
    expect(result!.assets.linuxX64AppImage?.sha256).toBe('b'.repeat(64))
  })

  // ── W2TC2d：prerelease-test skill 的 beta release 不触发升级提示 ───
  //
  // 多源形态：防御 b（prerelease `=== true` 收窄）在 checker 循环内 per-source 生效
  //（fetchSourceRelease 返回完整产物、不做适配层拦截）→ 主源拦截记「无新版」→ 试次源；
  // 两源同形态 → 全源确认无新版 → 负缓存。防御 c 对 tag 正则独立生效（W2TC2c）。
  describe('W2TC2d: prerelease-test skill 的 beta release 不触发升级提示', () => {
    it('beta release（v0.8.15-beta + prerelease=true）→ 返回 null', async () => {
      // 真实 beta release 完整模拟：prerelease-test.sh 生成 v0.8.15-beta 格式 tag（含 '-'），
      // release.yml 的 `prerelease: ${{ contains(github.ref, '-') }}` 据此把 tag 标为 prerelease=true。
      installRoutedFetch(() =>
        jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15-beta', prerelease: true })),
      )

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
    })

    it('dev npm prerelease（v0.8.15-dev.0 + prerelease=true）→ 返回 null', async () => {
      // npm-prerelease skill 用 -dev.N 后缀（如 0.8.15-dev.0）。
      installRoutedFetch(() =>
        jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15-dev.0', prerelease: true })),
      )

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
    })

    it('rc 格式（v0.8.15-rc.1，带点号）→ 返回 null（防御 c 循环内生效）', async () => {
      // prerelease 未设以独立验证层 c：STRICT_VERSION_RE 必须拒绝 '0.8.15-rc.1'。
      installRoutedFetch(() => jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15-rc.1' })))

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
    })

    it('alpha 格式（v0.8.15-alpha.2）→ 返回 null', async () => {
      installRoutedFetch(() => jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15-alpha.2' })))

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).toBeNull()
    })

    it('反向：纯数字 stable（v0.8.15 + prerelease=false）→ 返回非 null（防御不过严）', async () => {
      installRoutedFetch(() =>
        jsonResponse(makeReleaseJson({ tag_name: 'v0.8.15', prerelease: false })),
      )

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).not.toBeNull()
      expect(result!.version).toBe('0.8.15')
    })
  })

  // ── D6TC1-5：代理优先 + 失败降级直连（通道维度编排，位于适配层 fetchSourceRelease）──
  describe('D6: release-checker 代理优先 + 失败降级直连', () => {
    it('D6TC1: 配置代理时 fetch 带 dispatcher 参数（代理优先）', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const fetchCalls: RequestInit[] = []
      const spy = vi.fn(async (_url: unknown, init?: RequestInit) => {
        fetchCalls.push((init ?? {}) as RequestInit)
        return jsonResponse(makeReleaseJson())
      })
      globalThis.fetch = spy as unknown as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).not.toBeNull()
      expect(result!.version).toBe('0.9.0')
      // 只调用一次 fetch（代理成功，不降级；主源胜出即出循环）
      expect(fetchCalls).toHaveLength(1)
      // dispatcher 应存在（ProxyAgent 实例）
      const options = fetchCalls[0] as Record<string, unknown>
      expect(options.dispatcher).toBeDefined()
    })

    it('D6TC2: 代理 fetch 失败 → 降级直连重试一次（适配层通道编排）', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const fetchCalls: RequestInit[] = []
      let callCount = 0
      const spy = vi.fn(async (_url: unknown, init?: RequestInit) => {
        fetchCalls.push((init ?? {}) as RequestInit)
        callCount++
        if (callCount === 1) {
          // 第一次（代理）失败——无 errno code 的 Error，不触发 curl 引擎
          throw new Error('EHOSTUNREACH')
        }
        // 第二次（直连）成功
        return jsonResponse(makeReleaseJson())
      })
      globalThis.fetch = spy as unknown as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).not.toBeNull()
      expect(result!.version).toBe('0.9.0')
      // 调用两次 fetch：代理失败 + 直连重试（github 胜出，atomgit 零请求）
      expect(fetchCalls).toHaveLength(2)
      // 第一次有 dispatcher（代理）
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher).toBeDefined()
      // 第二次无 dispatcher（直连降级）
      expect((fetchCalls[1] as Record<string, unknown>).dispatcher).toBeUndefined()
    })

    it('D6TC3: mode=disabled → 不走代理，纯直连', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)

      const fetchCalls: RequestInit[] = []
      const spy = vi.fn(async (_url: unknown, init?: RequestInit) => {
        fetchCalls.push((init ?? {}) as RequestInit)
        return jsonResponse(makeReleaseJson())
      })
      globalThis.fetch = spy as unknown as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).not.toBeNull()
      // 只调用一次（无代理，不降级）
      expect(fetchCalls).toHaveLength(1)
      // 无 dispatcher
      expect((fetchCalls[0] as Record<string, unknown>).dispatcher).toBeUndefined()
    })

    it('D6TC4: 代理 + 直连都失败 → 该源失败 → 次源同形态失败 → 返回 null（逐源降级语义）', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const spy = vi.fn(async () => {
        throw new Error('EHOSTUNREACH')
      })
      globalThis.fetch = spy as unknown as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).toBeNull()
      // 每源两试（代理 + 直连降级）× 两源 = 4 次（多源后主源失败继续试次源）
      expect(spy).toHaveBeenCalledTimes(4)
    })

    it('D6TC5: 代理 HTTP 错误（404）→ 该源不通道降级，但逐源降级继续试次源', async () => {
      vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({
        mode: 'manual',
        httpsProxy: 'http://192.168.1.202:7890',
      })
      vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue('http://192.168.1.202:7890')

      const spy = vi.fn(async () => new Response('not found', { status: 404 }))
      globalThis.fetch = spy as unknown as typeof globalThis.fetch

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')

      expect(result).toBeNull()
      // github 404 仅 1 次（服务器已响应，不触发直连重试——通道语义保持）；
      // 随后逐源降级尝试 atomgit 1 次
      expect(spy).toHaveBeenCalledTimes(2)
      const githubCalls = calledUrls(spy).filter((u) => u === GITHUB_LATEST_URL)
      expect(githubCalls).toHaveLength(1)
    })
  })

  // ── W2TC8：win 产物名后缀匹配（M7-01 P0 回归防护）────────────────
  describe('W2TC8: win asset 后缀匹配（带版本号形态）', () => {
    it('TaiJi-<version>-setup-x64.exe（正确形态）→ winX64Exe 匹配', async () => {
      installRoutedFetch(() =>
        jsonResponse(
          makeReleaseJson({
            assets: [
              {
                name: 'TaiJi-0.8.44-setup-x64.exe',
                browser_download_url: 'https://example.com/TaiJi-0.8.44-setup-x64.exe',
                size: 2000,
                digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            ],
          }),
        ),
      )

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).not.toBeNull()
      expect(result!.assets.winX64Exe?.downloadUrl).toBe(
        'https://example.com/TaiJi-0.8.44-setup-x64.exe',
      )
    })

    it('TaiJi-setup-<version>-x64.exe（setup/version 对调的错误形态）→ winX64Exe 不匹配', async () => {
      // 锁死修复：对调形态必须匹配不到，否则回归时 win 自动升级静默失效
      installRoutedFetch(() =>
        jsonResponse(
          makeReleaseJson({
            assets: [
              {
                name: 'TaiJi-setup-0.8.44-x64.exe',
                browser_download_url: 'https://example.com/TaiJi-setup-0.8.44-x64.exe',
                size: 2000,
                digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            ],
          }),
        ),
      )

      const checker = makeChecker()
      const result = await checker.checkForLatestRelease('0.8.14')
      expect(result).not.toBeNull()
      expect(result!.assets.winX64Exe).toBeUndefined()
    })
  })
})

// ════════════════════════════════════════════════════════════════
// 负缓存（多源循环出口语义重写，§4.2⑥）：
// 全部源确认无新版才写负缓存；主源无新版/混合态/全失败均不写
// ════════════════════════════════════════════════════════════════
describe('多源负缓存（循环出口语义）', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    settingsMock.updateSource = 'auto'
    errorLogMocks.logSourceSelection.mockClear()
    errorLogMocks.logSourceFailover.mockClear()
    resolverMocks.getLastProbeOutcome.mockClear()
    resolverMocks.getLastProbeOutcome.mockReturnValue(null)
    vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
    vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('主源「无新版」不写全局负缓存：次源新版可达并写正缓存（验收条款）', async () => {
    // github 侧 v0.8.13（确认无新版）；atomgit 侧 v0.9.0（新版）
    const spy = installRoutedFetch((url) =>
      jsonResponse(makeReleaseJson({ tag_name: url === GITHUB_LATEST_URL ? 'v0.8.13' : 'v0.9.0' })),
    )

    const checker = makeChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    // 次源新版可达：胜出源为 atomgit
    expect(r1).not.toBeNull()
    expect(r1!.version).toBe('0.9.0')
    expect(r1!.source).toBe('atomgit')
    expect(spy).toHaveBeenCalledTimes(2)

    // 主源「无新版」没有触发负缓存：TTL 内非 force 再查命中正缓存（info 非 null）
    vi.setSystemTime(Date.now() + 30 * 60 * 1000)
    const r2 = await checker.checkForLatestRelease('0.8.14')
    expect(r2).not.toBeNull()
    expect(r2).toEqual(r1)
    expect(spy).toHaveBeenCalledTimes(2) // 零新增请求
  })

  it('全部源确认无新版 → 写负缓存：TTL 内零 fetch，TTL 过重新逐源', async () => {
    // 两源均返回旧版 → 全部源确认无新版 → 全局负缓存成立
    const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson({ tag_name: 'v0.8.13' })))

    const checker = makeChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    expect(r1).toBeNull()
    expect(spy).toHaveBeenCalledTimes(2)

    // TTL 内（+30min）非 force 再查 → 负缓存命中，零 fetch
    vi.setSystemTime(Date.now() + 30 * 60 * 1000)
    const r2 = await checker.checkForLatestRelease('0.8.14')
    expect(r2).toBeNull()
    expect(spy).toHaveBeenCalledTimes(2)

    // TTL 过（+61min）→ 重新逐源 fetch（负缓存过期）
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    const r3 = await checker.checkForLatestRelease('0.8.14')
    expect(r3).toBeNull()
    expect(spy).toHaveBeenCalledTimes(4)
  })

  it('混合态（主源失败 + 次源确认无新版）→ 返回 null 但不写负缓存（验收条款）', async () => {
    let githubDown = true
    const spy = installRoutedFetch((url) => {
      if (url === GITHUB_LATEST_URL) {
        if (githubDown) throw new Error('network error')
        return jsonResponse(makeReleaseJson({ tag_name: 'v0.9.0' }))
      }
      // atomgit 恒旧版（确认无新版）
      return jsonResponse(makeReleaseJson({ tag_name: 'v0.8.13' }))
    })

    const checker = makeChecker()
    // 第一轮：github 失败（未确认）+ atomgit 无新版 → 混合态 null，不写负缓存
    const r1 = await checker.checkForLatestRelease('0.8.14')
    expect(r1).toBeNull()
    expect(spy).toHaveBeenCalledTimes(2)

    // TTL 内再查：负缓存未写 → github 恢复后当轮即可胜出（「未知」没有被固化为「确认无」）
    vi.setSystemTime(Date.now() + 30 * 60 * 1000)
    githubDown = false
    const r2 = await checker.checkForLatestRelease('0.8.14')
    expect(r2).not.toBeNull()
    expect(r2!.version).toBe('0.9.0')
    expect(r2!.source).toBe('github')
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('force=true 绕过负缓存重新逐源 fetch（手动检查不被无新版缓存挡住）', async () => {
    const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson({ tag_name: 'v0.8.13' })))

    const checker = makeChecker()
    await checker.checkForLatestRelease('0.8.14')
    expect(spy).toHaveBeenCalledTimes(2)
    // force 绕过负缓存：两源重新逐源
    await checker.checkForLatestRelease('0.8.14', { force: true })
    expect(spy).toHaveBeenCalledTimes(4)
  })

  it('全源失败不写负缓存：失败后 TTL 内再查仍逐源重新 fetch', async () => {
    let callCount = 0
    const spy = installRoutedFetch(() => {
      callCount++
      if (callCount <= 2) return new Response('error', { status: 500 })
      return jsonResponse(makeReleaseJson({ tag_name: 'v0.8.13' }))
    })

    const checker = makeChecker()
    vi.setSystemTime(1_700_000_000_000)
    const r1 = await checker.checkForLatestRelease('0.8.14')
    expect(r1).toBeNull()

    vi.setSystemTime(Date.now() + 30 * 60 * 1000)
    const r2 = await checker.checkForLatestRelease('0.8.14')
    expect(r2).toBeNull() // 第二轮 github 恢复但两源结果均是无新版（负缓存由本轮写入）
    // 第一轮失败未缓存（2 次）→ 第二轮重新逐源 fetch（github 无新版 → 继续试 atomgit）
    expect(callCount).toBe(4)
  })
})

// ════════════════════════════════════════════════════════════════
// per-source 限流退避（§6.5）：Map<UpdateSource, until> +
// getRateLimitedUntil() 全部源均在退避窗口才返回最早解除时刻（min）/
// 任一源无退避记录或已解除返回 0 / 退避源短路零请求
// ════════════════════════════════════════════════════════════════
describe('per-source 限流退避', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    settingsMock.updateSource = 'auto'
    errorLogMocks.logSourceSelection.mockClear()
    errorLogMocks.logSourceFailover.mockClear()
    resolverMocks.getLastProbeOutcome.mockClear()
    resolverMocks.getLastProbeOutcome.mockReturnValue(null)
    vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
    vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('退避源短路零请求：github 403 退避窗口内 force 检查跳过 github，atomgit 照常可达（验收条款）', async () => {
    const spy = installRoutedFetch((url) =>
      url === GITHUB_LATEST_URL
        ? new Response('rate limited', { status: 403 })
        : jsonResponse(makeReleaseJson()),
    )

    const checker = makeChecker()
    // 第一轮：github 403 记退避，atomgit 胜出（per-source 退避互不干扰）
    const r1 = await checker.checkForLatestRelease('0.8.14')
    expect(r1).not.toBeNull()
    expect(r1!.source).toBe('atomgit')
    // 仅 github 退避 + atomgit 可用 → 全源退避语义返回 0（退避存在性由下方第二轮
    // force 短路计数证明：github 计数恒 1 = 退避生效零请求）
    expect(checker.getRateLimitedUntil()).toBe(0)
    expect(spy).toHaveBeenCalledTimes(2)
    const githubCallsAfterRound1 = calledUrls(spy).filter((u) => u === GITHUB_LATEST_URL).length
    expect(githubCallsAfterRound1).toBe(1)

    // +1h（退避窗口内）：force 绕过缓存重查 → github 短路（零请求），atomgit 照常 fetch
    vi.setSystemTime(Date.now() + 60 * 60 * 1000)
    const r2 = await checker.checkForLatestRelease('0.8.14', { force: true })
    expect(r2).not.toBeNull()
    expect(r2!.source).toBe('atomgit')
    // github 计数不变（退避源短路零请求）；atomgit force 后重新 fetch 1 次
    expect(calledUrls(spy).filter((u) => u === GITHUB_LATEST_URL).length).toBe(
      githubCallsAfterRound1,
    )
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('getRateLimitedUntil：无任何退避记录 → 0（验收条款）', async () => {
    installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const checker = makeChecker()
    expect(checker.getRateLimitedUntil()).toBe(0)
    await checker.checkForLatestRelease('0.8.14')
    // 成功检查不产生退避记录
    expect(checker.getRateLimitedUntil()).toBe(0)
  })

  it('仅 github 退避（atomgit 无退避记录且正常确认无新版）→ getRateLimitedUntil 返回 0（不误报限流）', async () => {
    // 失真场景回归（design-code-sync R1）：github 限流退避 2h + atomgit 正常检查确认
    // 无新版——handler 判定式 `!info && getRateLimitedUntil() > Date.now()` 在旧
    // max 语义下误报 rateLimited=true（UI 显示「限流约 2 小时暂停检查」，实际刚
    // 正常确认无新版）；新全源语义下 atomgit 可用即返回 0
    const spy = installRoutedFetch((url) =>
      url === GITHUB_LATEST_URL
        ? new Response('rate limited', { status: 403 })
        : jsonResponse(makeReleaseJson({ tag_name: 'v0.8.13' })), // atomgit 确认无新版
    )

    const checker = makeChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    // github 退避（入 Map）+ atomgit 确认无新版 → 混合态 null 不写负缓存
    expect(r1).toBeNull()
    expect(spy).toHaveBeenCalledTimes(2)
    // atomgit 可用即检查可正常出结论：仅 github 退避 → 0（handler 不报 rateLimited）
    expect(checker.getRateLimitedUntil()).toBe(0)
  })

  // AtomGit 当前链路不可经公共 API 构造退避（适配层 rateLimitAware 仅 github，
  // §4.1 无限流响应头不识别），双源退避聚合语义用白盒注入构造各源截止值
  function injectBackoff(
    checker: ReleaseChecker,
    entries: Partial<Record<UpdateSource, number>>,
  ): void {
    const internals = checker as unknown as { backoffUntil: Map<UpdateSource, number> }
    for (const [source, until] of Object.entries(entries)) {
      internals.backoffUntil.set(source as UpdateSource, until as number)
    }
  }

  it('双源均在退避窗口 → 返回各源截止的 min（最早解除时刻）且 > now（验收条款）', () => {
    const checker = makeChecker()
    const t0 = Date.now()
    injectBackoff(checker, {
      github: t0 + 2 * 60 * 60 * 1000,
      atomgit: t0 + 30 * 60 * 1000,
    })

    const until = checker.getRateLimitedUntil()
    expect(until).toBeGreaterThan(t0)
    // min 而非 max：返回最早解除时刻（atomgit 的 +30min），非 github 的 +2h
    expect(until).toBe(t0 + 30 * 60 * 1000)
  })

  it('双源退避但其一已解除 → 返回 0（任一源可用即不报限流）', () => {
    const checker = makeChecker()
    const t0 = Date.now()
    injectBackoff(checker, {
      github: t0 + 2 * 60 * 60 * 1000, // 仍在窗口
      atomgit: t0 - 1000, // 已解除
    })

    expect(checker.getRateLimitedUntil()).toBe(0)
  })

  it('退避按源分派：github latest 403 记退避；atomgit manifest 403 是签名拒绝不记退避；github 退避窗口内短路零请求', async () => {
    // github latest 403（记 github 退避）；atomgit latest 无 digest → manifest 403
    //（auth_key 签名直链的签名/权限拒绝，§4.1——普通失败收口，不记退避）
    // → atomgit 该源失败 → 全源失败 null
    const spy = installRoutedFetch((url) => {
      if (url === GITHUB_LATEST_URL) return new Response('rate limited', { status: 403 })
      if (url === ATOMGIT_LATEST_URL)
        return jsonResponse(
          makeReleaseJson({
            assets: [
              assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg'),
              manifestAsset(ATOMGIT_MANIFEST_URL),
            ],
          }),
        )
      if (url === ATOMGIT_MANIFEST_URL) return new Response('forbidden', { status: 403 })
      return new Response('not found', { status: 404 })
    })

    const checker = makeChecker()
    const r1 = await checker.checkForLatestRelease('0.8.14')
    expect(r1).toBeNull()
    // 退避仅来自 github（latest 403）；atomgit manifest 403 不污染退避 Map——
    // 全源退避语义下 atomgit 可用即返回 0（github 退避的存在性由下方第二轮 force
    // 短路计数证明：GITHUB_LATEST_URL 计数恒 1）
    expect(checker.getRateLimitedUntil()).toBe(0)

    // github 退避窗口内 force 查询：github 短路（计数恒 1，零请求）；atomgit 不在
    // 退避 → 照常尝试（latest 1 + manifest 1）
    vi.setSystemTime(Date.now() + 90 * 60 * 1000)
    const r2 = await checker.checkForLatestRelease('0.8.14', { force: true })
    expect(r2).toBeNull()
    const urls = calledUrls(spy)
    expect(urls.filter((u) => u === GITHUB_LATEST_URL)).toHaveLength(1)
    expect(urls.filter((u) => u === ATOMGIT_LATEST_URL)).toHaveLength(2)
    expect(urls.filter((u) => u === ATOMGIT_MANIFEST_URL)).toHaveLength(2)
  })
})

// ════════════════════════════════════════════════════════════════
// manifest 填充与源归类（§4.2⑤/D2）：AtomGit 失败降级次源 / GitHub 不阻塞 /
// size 扩展填充（API size ?? manifest size）
// ════════════════════════════════════════════════════════════════
describe('manifest 填充与源归类', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    settingsMock.updateSource = 'auto'
    errorLogMocks.logSourceSelection.mockClear()
    errorLogMocks.logSourceFailover.mockClear()
    resolverMocks.getLastProbeOutcome.mockClear()
    resolverMocks.getLastProbeOutcome.mockReturnValue(null)
    vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
    vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('AtomGit manifest fetch 404 → 该源失败 → 降级次源 github 胜出（验收条款）', async () => {
    const spy = installRoutedFetch((url) => {
      if (url === ATOMGIT_LATEST_URL)
        return jsonResponse(
          makeReleaseJson({
            assets: [
              assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg'),
              manifestAsset(ATOMGIT_MANIFEST_URL),
            ],
          }),
        )
      if (url === ATOMGIT_MANIFEST_URL) return new Response('not found', { status: 404 })
      return jsonResponse(makeReleaseJson()) // github latest：带 digest
    })

    const checker = makeChecker(['atomgit', 'github'])
    const result = await checker.checkForLatestRelease('0.8.14')

    // AtomGit manifest 是 sha256 唯一来源，404 计该源失败 → 回循环 github 胜出
    expect(result).not.toBeNull()
    expect(result!.source).toBe('github')
    expect(result!.version).toBe('0.9.0')
    const urls = calledUrls(spy)
    expect(urls.filter((u) => u === ATOMGIT_LATEST_URL)).toHaveLength(1)
    expect(urls.filter((u) => u === ATOMGIT_MANIFEST_URL)).toHaveLength(1)
    expect(urls.filter((u) => u === GITHUB_LATEST_URL)).toHaveLength(1)
  })

  it.each([403, 429])(
    'AtomGit manifest HTTP %i → 签名/权限拒绝按普通失败收口（不记限流退避）→ 该源失败降级次源',
    async (status) => {
      // AtomGit manifest 直链是 auth_key 签名 URL（§4.1），403 = 签名/权限拒绝而非
      // 限流信号——若误记 2h 退避，国内主场景（AtomGit 优先）后续检查会被短路降级
      installRoutedFetch((url) => {
        if (url === ATOMGIT_LATEST_URL)
          return jsonResponse(
            makeReleaseJson({
              assets: [
                assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg'),
                manifestAsset(ATOMGIT_MANIFEST_URL),
              ],
            }),
          )
        if (url === ATOMGIT_MANIFEST_URL) return new Response('forbidden', { status })
        return jsonResponse(makeReleaseJson())
      })

      const checker = makeChecker(['atomgit', 'github'])
      const result = await checker.checkForLatestRelease('0.8.14')

      // 该源失败 → 降级次源 github 胜出（既有兜底）
      expect(result).not.toBeNull()
      expect(result!.source).toBe('github')
      // 关键断言：不写限流退避——后续检查不被短路
      expect(checker.getRateLimitedUntil()).toBe(0)
    },
  )

  it('AtomGit manifest 网络失败 → 同样计该源失败降级次源', async () => {
    installRoutedFetch((url) => {
      if (url === ATOMGIT_LATEST_URL)
        return jsonResponse(
          makeReleaseJson({
            assets: [
              assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg'),
              manifestAsset(ATOMGIT_MANIFEST_URL),
            ],
          }),
        )
      if (url === ATOMGIT_MANIFEST_URL) throw new Error('network error')
      return jsonResponse(makeReleaseJson())
    })

    const checker = makeChecker(['atomgit', 'github'])
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).not.toBeNull()
    expect(result!.source).toBe('github')
  })

  it('AtomGit manifest 200 但目标资产缺失 → 该源失败（资产缺失与 fetch 失败同语义）', async () => {
    installRoutedFetch((url) => {
      if (url === ATOMGIT_LATEST_URL)
        return jsonResponse(
          makeReleaseJson({
            assets: [
              assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg'),
              manifestAsset(ATOMGIT_MANIFEST_URL),
            ],
          }),
        )
      // manifest 200 但 assets 无目标条目（发布同步事故形态）
      if (url === ATOMGIT_MANIFEST_URL)
        return jsonResponse({ version: '0.9.0', assets: { 'other-file.zip': { sha256: 'a'.repeat(64) } } })
      return jsonResponse(makeReleaseJson())
    })

    const checker = makeChecker(['atomgit', 'github'])
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).not.toBeNull()
    expect(result!.source).toBe('github')
  })

  it('AtomGit assets 无 manifest.json 资产 → 该源失败降级次源（直链缺失形态）', async () => {
    // assets 中没有 manifest.json（发布同步事故另一形态）→ resolveManifestDownloadUrl
    // 返回 undefined → AtomGit 路径必经失败
    installRoutedFetch((url) => {
      if (url === ATOMGIT_LATEST_URL)
        return jsonResponse(
          makeReleaseJson({
            assets: [assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg')],
          }),
        )
      return jsonResponse(makeReleaseJson())
    })

    const checker = makeChecker(['atomgit', 'github'])
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).not.toBeNull()
    expect(result!.source).toBe('github')
  })

  it('AtomGit manifest 成功 → sha256 与 size 均从 manifest 填充（API size 缺失形态）', async () => {
    installRoutedFetch((url) => {
      if (url === ATOMGIT_LATEST_URL)
        return jsonResponse(
          makeReleaseJson({
            assets: [
              assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg'),
              manifestAsset(ATOMGIT_MANIFEST_URL),
            ],
          }),
        )
      return jsonResponse({
        version: '0.9.0',
        releasedAt: '2025-12-01T00:00:00Z',
        assets: { 'TaiJi-mac-arm64.dmg': { sha256: 'd'.repeat(64), size: 4321 } },
      })
    })

    const checker = makeChecker(['atomgit', 'github'])
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.source).toBe('atomgit')
    expect(result!.assets.macArm64Dmg?.sha256).toBe('d'.repeat(64))
    expect(result!.assets.macArm64Dmg?.size).toBe(4321)
  })

  it('GitHub manifest 失败不阻塞：digest 缺失 → manifest 404 → 胜出保持、sha256 undefined、API size 兜底（验收条款）', async () => {
    const spy = installRoutedFetch((url) => {
      if (url === GITHUB_LATEST_URL)
        return jsonResponse(
          makeReleaseJson({
            assets: [
              assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg', 1000),
              manifestAsset(GITHUB_MANIFEST_URL),
            ],
          }),
        )
      if (url === GITHUB_MANIFEST_URL) return new Response('not found', { status: 404 })
      return jsonResponse(makeReleaseJson())
    })

    const checker = makeChecker(['github', 'atomgit'])
    const result = await checker.checkForLatestRelease('0.8.14')

    // 不阻塞：github 胜出（atomgit 零请求），sha256 留 undefined 由下载侧校验兜底
    expect(result).not.toBeNull()
    expect(result!.source).toBe('github')
    expect(result!.assets.macArm64Dmg?.sha256).toBeUndefined()
    expect(result!.assets.macArm64Dmg?.size).toBe(1000)
    const urls = calledUrls(spy)
    expect(urls).toContain(GITHUB_MANIFEST_URL)
    expect(urls.filter((u) => u === ATOMGIT_LATEST_URL)).toHaveLength(0)
  })

  it('GitHub manifest 成功 → sha256/size 从 manifest 填充（digest 缺失 fallback 现状语义保持）', async () => {
    installRoutedFetch((url) => {
      if (url === GITHUB_LATEST_URL)
        return jsonResponse(
          makeReleaseJson({
            assets: [
              assetWithoutDigest('TaiJi-mac-arm64.dmg', 'https://example.com/mac.dmg', 1000),
              manifestAsset(GITHUB_MANIFEST_URL),
            ],
          }),
        )
      return jsonResponse({
        version: '0.9.0',
        releasedAt: '2025-12-01T00:00:00Z',
        assets: { 'TaiJi-mac-arm64.dmg': { sha256: 'e'.repeat(64), size: 9999 } },
      })
    })

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')

    expect(result).not.toBeNull()
    expect(result!.source).toBe('github')
    expect(result!.assets.macArm64Dmg?.sha256).toBe('e'.repeat(64))
    // size 取 API size ?? manifest size：GitHub API size 恒在 → 保持 1000
    expect(result!.assets.macArm64Dmg?.size).toBe(1000)
  })

  it('digest 齐全 → 不 fetch manifest（lazy 现状语义保持）', async () => {
    const spy = installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).not.toBeNull()
    expect(result!.assets.macArm64Dmg?.sha256).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
    // 仅 latest 一次请求，无 manifest fetch
    expect(spy).toHaveBeenCalledTimes(1)
    expect(calledUrls(spy).some((u) => u.endsWith('manifest.json'))).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════
// 诊断接线（S1/S2/F5 观测面）：source-selection / source-failover
// ════════════════════════════════════════════════════════════════
describe('诊断登记接线', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    settingsMock.updateSource = 'auto'
    errorLogMocks.logSourceSelection.mockClear()
    errorLogMocks.logSourceFailover.mockClear()
    resolverMocks.getLastProbeOutcome.mockClear()
    resolverMocks.getLastProbeOutcome.mockReturnValue(null)
    vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
    vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('主源失败转次源成功 → logSourceSelection(order/winner/tags) + logSourceFailover(segment check)', async () => {
    installRoutedFetch((url) =>
      url === GITHUB_LATEST_URL
        ? new Response('rate limited', { status: 403 })
        : jsonResponse(makeReleaseJson()),
    )

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result!.source).toBe('atomgit')

    expect(errorLogMocks.logSourceSelection).toHaveBeenCalledTimes(1)
    expect(errorLogMocks.logSourceSelection).toHaveBeenCalledWith({
      order: ['github', 'atomgit'],
      winner: 'atomgit',
      probe: { executed: false, reason: 'resolver-internal' },
      tags: { atomgit: 'v0.9.0' }, // github 无响应 → 缺 key（F5 观测面语义）
    })
    expect(errorLogMocks.logSourceFailover).toHaveBeenCalledWith({
      segment: 'check',
      from: 'github',
      to: 'atomgit',
      errorCode: 'rate-limited',
      manifestFrom: 'atomgit',
    })
  })

  it('全源确认无新版 → source-selection 登记 winner=null（每轮检查结束均登记）', async () => {
    installRoutedFetch(() => jsonResponse(makeReleaseJson({ tag_name: 'v0.8.13' })))

    const checker = makeChecker()
    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result).toBeNull()

    expect(errorLogMocks.logSourceSelection).toHaveBeenCalledTimes(1)
    expect(errorLogMocks.logSourceSelection).toHaveBeenCalledWith({
      order: ['github', 'atomgit'],
      winner: null,
      probe: { executed: false, reason: 'resolver-internal' },
      tags: { github: 'v0.8.13', atomgit: 'v0.8.13' },
    })
  })

  it('缓存命中不登记（未发生源选择）', async () => {
    installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const checker = makeChecker()
    await checker.checkForLatestRelease('0.8.14')
    await checker.checkForLatestRelease('0.8.14') // 正缓存命中

    expect(errorLogMocks.logSourceSelection).toHaveBeenCalledTimes(1)
  })

  it('显式来源偏好 → probe.reason=explicit-preference（pref 透传 resolver，不消费探测详情）', async () => {
    settingsMock.updateSource = 'atomgit'
    const orderSeen: unknown[] = []
    const checker = new ReleaseChecker({
      resolveSourceOrder: async (pref) => {
        orderSeen.push(pref)
        return ['atomgit', 'github']
      },
    })
    installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result!.source).toBe('atomgit')
    // settings.updateSource 透传 resolver（D3 显式偏好 = 优先级）
    expect(orderSeen).toEqual(['atomgit'])
    // 显式偏好不是探测决策：不消费 getLastProbeOutcome（resolver 对显式偏好重置详情）
    expect(resolverMocks.getLastProbeOutcome).not.toHaveBeenCalled()
    expect(errorLogMocks.logSourceSelection).toHaveBeenCalledWith(
      expect.objectContaining({ winner: 'atomgit', probe: { executed: false, reason: 'explicit-preference' } }),
    )
  })

  it('auto 路径透传 resolver 探测详情（S2 观测面）：executed=true + results 对齐 getLastProbeOutcome', async () => {
    resolverMocks.getLastProbeOutcome.mockReturnValue({
      via: 'probe',
      decidedAt: 1_700_000_000_000,
      results: { github: { reachable: true }, atomgit: { reachable: false } },
    })
    // 探测排序形态：gitcode 可达者排前
    const checker = new ReleaseChecker({ resolveSourceOrder: async () => ['atomgit', 'github'] })
    installRoutedFetch((url) =>
      url === ATOMGIT_LATEST_URL ? new Response('not found', { status: 404 }) : jsonResponse(makeReleaseJson()),
    )

    const result = await checker.checkForLatestRelease('0.8.14')
    expect(result!.source).toBe('github')

    expect(errorLogMocks.logSourceSelection).toHaveBeenCalledWith({
      order: ['atomgit', 'github'],
      winner: 'github',
      probe: {
        executed: true,
        // resolver 的 Partial<Record> → SourceProbeRecord[] 映射；basis 透传决策
        // 通道 via 原值（ProbeSourceOutcome 无探测手段明细）
        results: [
          { source: 'github', reachable: true, basis: 'probe' },
          { source: 'atomgit', reachable: false, basis: 'probe' },
        ],
      },
      tags: { github: 'v0.9.0' }, // atomgit 404 无响应 → 缺 key
    })
  })

  it('auto + 代理短路决策 → executed=true 且 results 仅 github 键（gitcode 无推断依据，缺键不捏造）', async () => {
    resolverMocks.getLastProbeOutcome.mockReturnValue({
      via: 'proxy-short-circuit',
      decidedAt: 1_700_000_000_000,
      results: { github: { reachable: true } },
    })
    installRoutedFetch(() => jsonResponse(makeReleaseJson()))

    const checker = makeChecker()
    await checker.checkForLatestRelease('0.8.14')

    expect(errorLogMocks.logSourceSelection).toHaveBeenCalledWith({
      order: ['github', 'atomgit'],
      winner: 'github',
      probe: {
        executed: true,
        // 代理短路仅能推断 github（能配代理 = github 可达概率高），atomgit 缺键如实缺项
        results: [{ source: 'github', reachable: true, basis: 'proxy-short-circuit' }],
      },
      tags: { github: 'v0.9.0' },
    })
  })
})

// ════════════════════════════════════════════════════════════════
// fetchReleaseByTag 透传（IReleaseChecker 实现缺口消解，下载降级共用）
// ════════════════════════════════════════════════════════════════
describe('fetchReleaseByTag 透传', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    settingsMock.updateSource = 'auto'
    errorLogMocks.logSourceSelection.mockClear()
    errorLogMocks.logSourceFailover.mockClear()
    resolverMocks.getLastProbeOutcome.mockClear()
    resolverMocks.getLastProbeOutcome.mockReturnValue(null)
    vi.spyOn(proxyConfig, 'readProxyConfig').mockReturnValue({ mode: 'disabled' })
    vi.spyOn(proxyConfig, 'resolveProxyUrl').mockReturnValue(undefined)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('按 tag 精确查询指定源 → 透传适配层（by-tag 端点形态）', async () => {
    const spy = installRoutedFetch((url) => {
      expect(url.startsWith(ATOMGIT_BY_TAG_PREFIX)).toBe(true)
      return jsonResponse(makeReleaseJson())
    })

    const checker = makeChecker()
    const result = await checker.fetchReleaseByTag('atomgit', 'v0.9.0')

    expect(result).not.toBeNull()
    expect(result!.version).toBe('0.9.0')
    expect(result!.source).toBe('atomgit')
    expect(calledUrls(spy)[0]).toBe(`${ATOMGIT_BY_TAG_PREFIX}v0.9.0`)
  })

  it('该源无此 tag（404）→ 返回 null', async () => {
    installRoutedFetch(() => new Response('not found', { status: 404 }))

    const checker = makeChecker()
    const result = await checker.fetchReleaseByTag('github', 'v0.9.0')
    expect(result).toBeNull()
  })
})
