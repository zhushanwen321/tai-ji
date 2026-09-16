/**
 * u-release-sources 验收测试：Release 源适配层（多源改造 D1/D2）。
 *
 * 覆盖 impl-plan u-release-sources 验收条款（normalize 表测 + 防漂移 + by-tag 透传）：
 *   - prerelease 字符串 "false" 不误判为 true（D2 === true 收窄，防 GitCode 字符串编码）
 *   - prerelease boolean true 正确判定（非 stable 拦截 → null）
 *   - draft null → undefined；release_status 不影响防御字段
 *   - assets 无 size 时 size undefined（GitCode 无 API size，checker manifest fallback 填充）
 *   - 形状坏（tag_name 非 string / assets 非 array）抛可归类错误 kind 'bad-shape'
 *   - asset 字段别名容错（容器 assets/attach_files/attachFiles、name/url/size 别名族，
 *     对齐 scripts/gitcode-release-sync.mjs assetList 先例）
 *   - 两源全部产物 downloadUrl + manifest 直链 hostname ⊆ ALLOWED_DOWNLOAD_HOSTS（防漂移）
 *   - by-tag 404 → null；github by-tag/gitcode by-tag 端点形态
 *   - github 403/429 → rate-limited 可归类错误；gitcode 不识别限流（一律 null）
 *   - 网络失败 → kind 'network'；代理失败降直连重试（通道编排）；形状坏不触发通道重试
 *   - 域常量单一来源：ALLOWED_DOWNLOAD_HOSTS = GitHub 现行 2 域 + gitcode.com
 *
 * Mock 策略（对齐 download-asset-fallback.test.ts / upgrade-fetch.test.ts 既有风格）：
 *   - vi.stubGlobal('fetch')：走真实 upgradeFetch undici 引擎路径（成功响应不触发 curl 降级，
 *     零真实联网）；网络失败用 AbortError 形态（D4 分类 'non-fallback' 原样上抛，不 spawn curl）
 *   - proxy-config mock：readProxyConfig/resolveProxyUrl 可控（防读真实数据目录与 env 代理干扰）
 *   - error-log mock：appendUpdateError 不落真实磁盘
 *   - beforeEach resetEnginePreferenceForTest：隔离进程级引擎偏好模块态
 *
 * 运行：cd apps/electron/main && npx vitest run update/__tests__/release-sources.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchSourceRelease,
  fetchLatestRelease,
  fetchReleaseByTag,
  normalizeSourceRelease,
  resolveManifestDownloadUrl,
  ALLOWED_DOWNLOAD_HOSTS,
  RELEASE_SOURCE_HOSTS,
  ReleaseFetchError,
} from '../release-sources.js'
import { readProxyConfig, resolveProxyUrl } from '../proxy-config.js'
import { resetEnginePreferenceForTest } from '../upgrade-fetch.js'

// ─── 模块 mock（vi.mock 提升：先于被测模块静态导入生效） ───────────────────────

// proxy-config mock：readProxyConfig/resolveProxyUrl 可控——防读真实数据目录
// （~/.taiji/proxy-config.json）与宿主 env 代理变量干扰（测试确定性红线）
vi.mock('../proxy-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../proxy-config.js')>()
  return {
    ...actual,
    readProxyConfig: vi.fn(),
    resolveProxyUrl: vi.fn(),
  }
})

// error-log mock：upgrade-fetch 降级点落盘走真实磁盘，mock 掉（本套件不应触发；
// 若意外触发会在「拒绝默认」断言中暴露）
vi.mock('../error-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../error-log.js')>()
  return { ...actual, appendUpdateError: vi.fn() }
})

import { appendUpdateError } from '../error-log.js'

const readProxyConfigMock = vi.mocked(readProxyConfig)
const resolveProxyUrlMock = vi.mocked(resolveProxyUrl)
const appendUpdateErrorMock = vi.mocked(appendUpdateError)

// ─── mock 数据工厂 ───────────────────────────────────────────────────────────

const SHA_HEX = 'a'.repeat(64)

/** GitHub releases/latest 响应形态（digest/size 恒有，§4.1） */
function githubReleaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.9.15',
    body: 'release notes gh',
    published_at: '2026-09-01T00:00:00Z',
    html_url: `https://${RELEASE_SOURCE_HOSTS.githubDownload}/zhushanwen321/tai-ji/releases/tag/v0.9.15`,
    prerelease: false,
    draft: false,
    assets: [
      {
        name: 'TaiJi-0.9.15-mac-arm64.dmg',
        browser_download_url: `https://${RELEASE_SOURCE_HOSTS.githubDownload}/zhushanwen321/tai-ji/releases/download/v0.9.15/TaiJi-0.9.15-mac-arm64.dmg`,
        size: 135681147,
        digest: `sha256:${SHA_HEX}`,
      },
      {
        name: 'TaiJi-0.9.15-setup-x64.exe',
        browser_download_url: `https://${RELEASE_SOURCE_HOSTS.githubDownload}/zhushanwen321/tai-ji/releases/download/v0.9.15/TaiJi-0.9.15-setup-x64.exe`,
        size: 120_000_000,
      },
      {
        name: 'manifest.json',
        browser_download_url: `https://${RELEASE_SOURCE_HOSTS.githubDownload}/zhushanwen321/tai-ji/releases/download/v0.9.15/manifest.json`,
        size: 2048,
      },
    ],
    ...overrides,
  }
}

/** GitCode releases/latest 响应形态（M0 探针 P6 实测：prerelease boolean / draft 等 null / 无 size/digest） */
function gitcodeReleaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.9.15',
    body: 'release notes ag',
    prerelease: false,
    release_status: 'none',
    draft: null,
    published_at: null,
    html_url: null,
    created_at: '2026-09-01T00:00:00Z',
    assets: [
      {
        name: 'TaiJi-0.9.15-mac-arm64.dmg',
        browser_download_url: `https://${RELEASE_SOURCE_HOSTS.gitcodeDownload}/qq_18433817/tai-ji/releases/download/v0.9.15/TaiJi-0.9.15-mac-arm64.dmg`,
        type: 'attach',
        id: 1001,
      },
      {
        name: 'manifest.json',
        browser_download_url: `https://${RELEASE_SOURCE_HOSTS.gitcodeDownload}/qq_18433817/tai-ji/releases/download/v0.9.15/manifest.json`,
        type: 'attach',
        id: 1002,
      },
    ],
    ...overrides,
  }
}

// ─── fetch stub 工具 ─────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** stub global fetch（upgradeFetch undici 引擎路径），返回 mock 供 URL/headers/次数断言 */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** undici AbortError 形态（D4 分类 'non-fallback'：upgradeFetch 原样上抛，不触发 curl 降级） */
function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/** 最后一次 fetch 调用的请求头（upgradeFetch buildHeaders 合并默认 UA 后的形态） */
function lastFetchHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls.at(-1)?.[1] as { headers?: Record<string, string> } | undefined
  return init?.headers ?? {}
}

beforeEach(() => {
  resetEnginePreferenceForTest()
  readProxyConfigMock.mockReturnValue({ mode: 'disabled' })
  resolveProxyUrlMock.mockReturnValue(undefined)
  // 拒绝默认：意外落盘直接暴露（本套件零 curl 降级，engine-fallback 不应发生）
  appendUpdateErrorMock.mockImplementation(() => {
    throw new Error('[test] appendUpdateError called unexpectedly')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─── normalizeSourceRelease：D2 逐字段规格表测 ───────────────────────────────

describe('normalizeSourceRelease（D2 规格表测）', () => {
  it('gitcode prerelease 字符串 "false" 不误判为 true（=== true 收窄，防字符串编码）', () => {
    const raw = gitcodeReleaseJson({ prerelease: 'false' })
    const release = normalizeSourceRelease('gitcode', raw)
    expect(release.prerelease).toBe(false)
  })

  it('github prerelease "false" 字符串同样收窄为 false（收窄两源同款，防 API 演化）', () => {
    const release = normalizeSourceRelease('github', githubReleaseJson({ prerelease: 'false' }))
    expect(release.prerelease).toBe(false)
  })

  it('gitcode prerelease boolean true 正确判定为 true', () => {
    const release = normalizeSourceRelease('gitcode', gitcodeReleaseJson({ prerelease: true }))
    expect(release.prerelease).toBe(true)
  })

  it('gitcode draft null → undefined（防御 b 对 undefined 自然放行，§6.2）', () => {
    const release = normalizeSourceRelease('gitcode', gitcodeReleaseJson())
    expect(release.draft).toBeUndefined()
  })

  it('github draft boolean 原样保留（true/false 均不丢失）', () => {
    expect(normalizeSourceRelease('github', githubReleaseJson({ draft: true })).draft).toBe(true)
    expect(normalizeSourceRelease('github', githubReleaseJson({ draft: false })).draft).toBe(false)
  })

  it('gitcode release_status 任意值不影响防御字段（release_status 被忽略，§6.2）', () => {
    const release = normalizeSourceRelease(
      'gitcode',
      gitcodeReleaseJson({ release_status: 'prerelease', prerelease: false, draft: null }),
    )
    expect(release.prerelease).toBe(false)
    expect(release.draft).toBeUndefined()
  })

  it('gitcode published_at 无此字段（null）→ normalize 产物为 \'\'', () => {
    const release = normalizeSourceRelease('gitcode', gitcodeReleaseJson())
    expect(release.published_at).toBe('')
  })

  it('gitcode html_url null → 拼 gitcode.com release 页面链接（§6.2）', () => {
    const release = normalizeSourceRelease('gitcode', gitcodeReleaseJson())
    expect(release.html_url).toBe(
      `https://${RELEASE_SOURCE_HOSTS.gitcodeDownload}/qq_18433817/tai-ji/releases/v0.9.15`,
    )
  })

  it('github published_at/html_url 原样保留', () => {
    const release = normalizeSourceRelease('github', githubReleaseJson())
    expect(release.published_at).toBe('2026-09-01T00:00:00Z')
    expect(release.html_url).toBe(
      `https://${RELEASE_SOURCE_HOSTS.githubDownload}/zhushanwen321/tai-ji/releases/tag/v0.9.15`,
    )
  })

  it('gitcode assets 无 size → size undefined；github size 原样（§6.2 manifest fallback 前提）', () => {
    const ag = normalizeSourceRelease('gitcode', gitcodeReleaseJson())
    expect(ag.assets.every((a) => a.size === undefined)).toBe(true)
    const gh = normalizeSourceRelease('github', githubReleaseJson())
    expect(gh.assets[0].size).toBe(135_681_147)
  })

  it('形状坏：tag_name 非 string → 抛 ReleaseFetchError kind bad-shape', () => {
    expect(() => normalizeSourceRelease('gitcode', { tag_name: 123, assets: [] })).toThrow(ReleaseFetchError)
    expect(() => normalizeSourceRelease('gitcode', { tag_name: 123, assets: [] })).toThrow(
      expect.objectContaining({ kind: 'bad-shape', source: 'gitcode' }),
    )
  })

  it('形状坏：assets 非 array（含 null/缺失）→ bad-shape', () => {
    expect(() => normalizeSourceRelease('github', { tag_name: 'v1.0.0', assets: 'nope' })).toThrow(
      expect.objectContaining({ kind: 'bad-shape' }),
    )
    expect(() => normalizeSourceRelease('github', { tag_name: 'v1.0.0', assets: null })).toThrow(
      expect.objectContaining({ kind: 'bad-shape' }),
    )
    expect(() => normalizeSourceRelease('github', { tag_name: 'v1.0.0' })).toThrow(
      expect.objectContaining({ kind: 'bad-shape' }),
    )
  })

  it('形状坏：响应体非对象 → bad-shape', () => {
    expect(() => normalizeSourceRelease('gitcode', 'not-an-object')).toThrow(
      expect.objectContaining({ kind: 'bad-shape' }),
    )
  })

  it('别名容错：容器 attach_files / attachFiles（对齐 sync 脚本先例）', () => {
    const asset = { name: 'a.dmg', browser_download_url: 'https://gitcode.com/x/a.dmg' }
    expect(normalizeSourceRelease('gitcode', { tag_name: 'v1.0.0', attach_files: [asset] }).assets).toHaveLength(1)
    expect(normalizeSourceRelease('gitcode', { tag_name: 'v1.0.0', attachFiles: [asset] }).assets).toHaveLength(1)
  })

  it('别名容错：asset name 族 file_name/path/filename', () => {
    const url = 'https://gitcode.com/x/a.dmg'
    const ag1 = normalizeSourceRelease('gitcode', {
      tag_name: 'v1.0.0',
      assets: [{ file_name: 'a.dmg', browser_download_url: url }],
    })
    expect(ag1.assets[0].name).toBe('a.dmg')
    const ag2 = normalizeSourceRelease('gitcode', {
      tag_name: 'v1.0.0',
      assets: [{ filename: 'b.dmg', browser_download_url: url }],
    })
    expect(ag2.assets[0].name).toBe('b.dmg')
  })

  it('别名容错：url 缺失时 path/filename 仅当为 https 绝对 URL 才兜底（防文件名误当直链）', () => {
    const ag1 = normalizeSourceRelease('gitcode', {
      tag_name: 'v1.0.0',
      assets: [{ name: 'a.dmg', path: 'https://gitcode.com/x/a.dmg' }],
    })
    expect(ag1.assets[0].browser_download_url).toBe('https://gitcode.com/x/a.dmg')
    // path 为文件名语义（非绝对 URL）→ 不作 URL 命中，条目丢弃
    const ag2 = normalizeSourceRelease('gitcode', {
      tag_name: 'v1.0.0',
      assets: [{ name: 'a.dmg', path: 'a.dmg' }],
    })
    expect(ag2.assets).toHaveLength(0)
  })

  it('别名容错：size 族 filesize/file_size/attach_size（含数字字符串归一）', () => {
    const ag = normalizeSourceRelease('gitcode', {
      tag_name: 'v1.0.0',
      assets: [
        { name: 'a.dmg', browser_download_url: 'https://gitcode.com/x/a.dmg', file_size: '123' },
        { name: 'b.dmg', browser_download_url: 'https://gitcode.com/x/b.dmg', attach_size: 456 },
      ],
    })
    expect(ag.assets[0].size).toBe(123)
    expect(ag.assets[1].size).toBe(456)
  })

  it('github digest 提取：normalize 产物保留 digest 原文（sha256 hex 提取在组装层）', () => {
    const gh = normalizeSourceRelease('github', githubReleaseJson())
    expect(gh.assets[0].digest).toBe(`sha256:${SHA_HEX}`)
  })
})

// ─── fetchLatestRelease：github / gitcode 分派 ───────────────────────────────

describe('fetchLatestRelease（github 分支）', () => {
  it('happy path：URL/headers 正确，输出 normalize 后 LatestReleaseInfo（含 source/sha256 提取）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse(githubReleaseJson()))

    const info = await fetchLatestRelease('github')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://${RELEASE_SOURCE_HOSTS.githubApi}/repos/zhushanwen321/tai-ji/releases/latest`,
    )
    const headers = lastFetchHeaders(fetchMock)
    expect(headers.Accept).toBe('application/vnd.github+json')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(headers['User-Agent']).toBeTruthy()

    expect(info).not.toBeNull()
    expect(info?.version).toBe('0.9.15')
    expect(info?.tagName).toBe('v0.9.15')
    expect(info?.source).toBe('github')
    expect(info?.releaseNotes).toBe('release notes gh')
    expect(info?.publishedAt).toBe('2026-09-01T00:00:00Z')
    expect(info?.assets.macArm64Dmg?.sha256).toBe(SHA_HEX)
    expect(info?.assets.macArm64Dmg?.size).toBe(135_681_147)
  })

  it('github 403/429 → ReleaseFetchError kind rate-limited（含 httpStatus，两源中仅 github 识别限流）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse({ message: 'API rate limit exceeded' }, 403))
    await expect(fetchLatestRelease('github')).rejects.toMatchObject({
      kind: 'rate-limited',
      source: 'github',
      httpStatus: 403,
    })

    fetchMock.mockResolvedValue(jsonResponse({}, 429))
    await expect(fetchLatestRelease('github')).rejects.toMatchObject({
      kind: 'rate-limited',
      httpStatus: 429,
    })
  })

  it('github 404/500 → null（非 2xx 服务器已响应，对齐现状收口）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404))
    await expect(fetchLatestRelease('github')).resolves.toBeNull()

    fetchMock.mockResolvedValue(jsonResponse({ message: 'oops' }, 500))
    await expect(fetchLatestRelease('github')).resolves.toBeNull()
  })

  it('github draft true → null（非 stable 拦截；LatestReleaseInfo 不承载 draft，拦截须在信息丢失前）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse(githubReleaseJson({ draft: true })))
    await expect(fetchLatestRelease('github')).resolves.toBeNull()
  })

  it('形状坏（代理劫持页 200 JSON）→ bad-shape 可归类错误', async () => {
    stubFetch()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ html: 'hijack page' })))
    await expect(fetchLatestRelease('github')).rejects.toMatchObject({ kind: 'bad-shape' })
  })

  it('非法 JSON 响应体 → kind network（对齐现状「非法 JSON 按失败收口」归网络错误桶）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }))
    await expect(fetchLatestRelease('github')).rejects.toMatchObject({ kind: 'network' })
  })
})

describe('fetchLatestRelease（gitcode 分支）', () => {
  it('happy path：URL 正确、匿名 GET 无特殊 headers（仅默认 UA）、字段映射齐备', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse(gitcodeReleaseJson()))

    const info = await fetchLatestRelease('gitcode')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://${RELEASE_SOURCE_HOSTS.gitcodeApi}/api/v5/repos/qq_18433817/tai-ji/releases/latest`,
    )
    const headers = lastFetchHeaders(fetchMock)
    expect(headers['User-Agent']).toBeTruthy()
    expect(headers).not.toHaveProperty('Accept')
    expect(headers).not.toHaveProperty('X-GitHub-Api-Version')

    expect(info).not.toBeNull()
    expect(info?.version).toBe('0.9.15')
    expect(info?.tagName).toBe('v0.9.15')
    expect(info?.source).toBe('gitcode')
    expect(info?.releaseNotes).toBe('release notes ag')
    expect(info?.publishedAt).toBe('')
    expect(info?.htmlUrl).toBe(
      `https://${RELEASE_SOURCE_HOSTS.gitcodeDownload}/qq_18433817/tai-ji/releases/v0.9.15`,
    )
    // GitCode 无 API size → undefined（checker manifest fallback 填充，§6.2）
    expect(info?.assets.macArm64Dmg?.size).toBeUndefined()
    expect(info?.assets.macArm64Dmg?.sha256).toBeUndefined()
    expect(info?.assets.macArm64Dmg?.downloadUrl).toContain(RELEASE_SOURCE_HOSTS.gitcodeDownload)
  })

  it('gitcode prerelease "false" 字符串不误判 → 正常返回 info（非 null，GitCode 源检查不全灭）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse(gitcodeReleaseJson({ prerelease: 'false' })))
    const info = await fetchLatestRelease('gitcode')
    expect(info).not.toBeNull()
    expect(info?.version).toBe('0.9.15')
  })

  it('gitcode prerelease boolean true → null（非 stable 拦截）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse(gitcodeReleaseJson({ prerelease: true })))
    await expect(fetchLatestRelease('gitcode')).resolves.toBeNull()
  })

  it('gitcode 403/429 不识别限流（无限流响应头，§4.1）→ null 而非 rate-limited', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse({}, 429))
    await expect(fetchLatestRelease('gitcode')).resolves.toBeNull()
  })

  it('gitcode 形状坏 → bad-shape 可归类错误', async () => {
    stubFetch()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ foo: 1 })))
    await expect(fetchLatestRelease('gitcode')).rejects.toMatchObject({
      kind: 'bad-shape',
      source: 'gitcode',
    })
  })
})

// ─── 通道编排（代理优先 + 失败降直连，对齐 fetchGitHubLatestRelease，update-network-resilience D6/D10）──

describe('通道编排', () => {
  it('网络失败（无代理）→ ReleaseFetchError kind network 上抛（适配层失败显式化，checker 记该源失败）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockRejectedValue(abortError())
    await expect(fetchLatestRelease('github')).rejects.toMatchObject({ kind: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('代理失败 → 直连重试一次成功（update-network-resilience D6/D10 通道降级）', async () => {
    readProxyConfigMock.mockReturnValue({ mode: 'manual', httpsProxy: 'http://127.0.0.1:7890' })
    resolveProxyUrlMock.mockReturnValue('http://127.0.0.1:7890')
    const fetchMock = stubFetch()
    fetchMock.mockRejectedValueOnce(abortError()).mockResolvedValueOnce(jsonResponse(githubReleaseJson()))

    const info = await fetchLatestRelease('github')

    expect(info?.source).toBe('github')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('代理 + 直连均网络失败 → network 上抛（不吞失败）', async () => {
    readProxyConfigMock.mockReturnValue({ mode: 'manual', httpsProxy: 'http://127.0.0.1:7890' })
    resolveProxyUrlMock.mockReturnValue('http://127.0.0.1:7890')
    const fetchMock = stubFetch()
    fetchMock.mockRejectedValue(abortError())

    await expect(fetchLatestRelease('gitcode')).rejects.toMatchObject({ kind: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('形状坏不触发直连重试（响应体已坏，换通道无意义）', async () => {
    readProxyConfigMock.mockReturnValue({ mode: 'manual', httpsProxy: 'http://127.0.0.1:7890' })
    resolveProxyUrlMock.mockReturnValue('http://127.0.0.1:7890')
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse({ tag_name: 42, assets: [] }))

    await expect(fetchLatestRelease('github')).rejects.toMatchObject({ kind: 'bad-shape' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('限流不触发直连重试（服务器已明确响应，对齐现状）', async () => {
    readProxyConfigMock.mockReturnValue({ mode: 'manual', httpsProxy: 'http://127.0.0.1:7890' })
    resolveProxyUrlMock.mockReturnValue('http://127.0.0.1:7890')
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse({}, 403))

    await expect(fetchLatestRelease('github')).rejects.toMatchObject({ kind: 'rate-limited' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─── fetchSourceRelease：完整产物出口（checker §4.2⑤ manifest 通路输入源）────

describe('fetchSourceRelease（完整产物，含原始 assets 数组）', () => {
  it('返回 normalize 后完整产物：原始 assets 含 manifest.json 条目，prerelease/draft 字段保留', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockImplementation(async () => jsonResponse(gitcodeReleaseJson()))

    const release = await fetchSourceRelease('gitcode')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://${RELEASE_SOURCE_HOSTS.gitcodeApi}/api/v5/repos/qq_18433817/tai-ji/releases/latest`,
    )
    expect(release).not.toBeNull()
    // 原始 assets 数组：平台资产与 manifest.json 等非平台资产全部保留（平台分流只发生在
    // fetchLatestRelease 出口）——resolveManifestDownloadUrl 的生产链路输入源
    expect(release?.assets).toHaveLength(2)
    expect(release?.assets.map((a) => a.name)).toEqual([
      'TaiJi-0.9.15-mac-arm64.dmg',
      'manifest.json',
    ])
    // 防御字段完整保留（不做非 stable 拦截，防御归 checker）
    expect(release?.prerelease).toBe(false)
    expect(release?.draft).toBeUndefined()
    expect(release?.tag_name).toBe('v0.9.15')
    // manifest 直链可从产物解析（§4.2⑤ 权威通路端到端）
    expect(resolveManifestDownloadUrl(release!.assets)).toContain('manifest.json')
  })

  it('与 fetchLatestRelease 复用同一 fetch+normalize 管线：prerelease 产物完整返回而 LatestReleaseInfo 出口拦截为 null（分工仅在出口层）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockImplementation(async () => jsonResponse(gitcodeReleaseJson({ prerelease: true })))

    const release = await fetchSourceRelease('gitcode')
    expect(release?.prerelease).toBe(true)

    const info = await fetchLatestRelease('gitcode')
    expect(info).toBeNull()
    // 同一 latest 端点被命中两次（同一管线，非第二套 fetch 实现）
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new URL(fetchMock.mock.calls[0][0] as string).pathname).toBe(
      new URL(fetchMock.mock.calls[1][0] as string).pathname,
    )
  })

  it('404 → null（非 2xx 收口语义与 fetchLatestRelease 一致）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockImplementation(async () => jsonResponse({ message: 'Not Found' }, 404))
    await expect(fetchSourceRelease('github')).resolves.toBeNull()
  })

  it('形状坏 → ReleaseFetchError kind bad-shape', async () => {
    stubFetch()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ foo: 1 })))
    await expect(fetchSourceRelease('github')).rejects.toMatchObject({
      kind: 'bad-shape',
      source: 'github',
    })
  })
})

// ─── fetchReleaseByTag：by-tag 精确查询（下载跨源降级/checker 透传共用）──────

describe('fetchReleaseByTag', () => {
  it('github by-tag 端点形态正确（releases/tags/{tag}，tag encodeURIComponent）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse(githubReleaseJson()))

    const info = await fetchReleaseByTag('github', 'v0.9.15')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://${RELEASE_SOURCE_HOSTS.githubApi}/repos/zhushanwen321/tai-ji/releases/tags/v0.9.15`,
    )
    expect(info?.source).toBe('github')
    expect(info?.tagName).toBe('v0.9.15')
  })

  it('gitcode by-tag 端点形态正确', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse(gitcodeReleaseJson()))

    const info = await fetchReleaseByTag('gitcode', 'v0.9.15')

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://${RELEASE_SOURCE_HOSTS.gitcodeApi}/api/v5/repos/qq_18433817/tai-ji/releases/tags/v0.9.15`,
    )
    expect(info?.source).toBe('gitcode')
  })

  it('by-tag 404（无此 tag）→ null：github 与 gitcode 同语义（发布时间窗 = 对侧不可用）', async () => {
    // 每次调用返回新 Response（upgradeFetch 消费 res.text()，Response 实例不可复用）
    const fetchMock = stubFetch()
    fetchMock.mockImplementation(async () => jsonResponse({ message: 'Not Found' }, 404))
    await expect(fetchReleaseByTag('github', 'v9.9.9')).resolves.toBeNull()
    await expect(fetchReleaseByTag('gitcode', 'v9.9.9')).resolves.toBeNull()
  })

  it('by-tag 命中 prerelease tag → null（同款防御，对侧不可作降级目标）', async () => {
    const fetchMock = stubFetch()
    fetchMock.mockResolvedValue(jsonResponse(gitcodeReleaseJson({ prerelease: true })))
    await expect(fetchReleaseByTag('gitcode', 'v0.9.16-rc.1')).resolves.toBeNull()
  })
})

// ─── resolveManifestDownloadUrl：manifest 直链解析辅助 ───────────────────────

describe('resolveManifestDownloadUrl', () => {
  it('按 name === manifest.json 取 browser_download_url（§4.2⑤ assets 直链，非 latest 别名）', () => {
    const assets = normalizeSourceRelease('gitcode', gitcodeReleaseJson()).assets
    expect(resolveManifestDownloadUrl(assets)).toBe(
      `https://${RELEASE_SOURCE_HOSTS.gitcodeDownload}/qq_18433817/tai-ji/releases/download/v0.9.15/manifest.json`,
    )
  })

  it('无 manifest 资产 → undefined', () => {
    const assets = normalizeSourceRelease('gitcode', {
      tag_name: 'v1.0.0',
      assets: [{ name: 'a.dmg', browser_download_url: 'https://gitcode.com/x/a.dmg' }],
    }).assets
    expect(resolveManifestDownloadUrl(assets)).toBeUndefined()
  })
})

// ─── 域常量单一来源 + 防漂移（D1 效果段 / §8 单测分工）────────────────────────

describe('域常量与防漂移断言', () => {
  it('ALLOWED_DOWNLOAD_HOSTS = GitHub 现行白名单 2 域 + gitcode.com（P1 探针精确登记）', () => {
    expect([...ALLOWED_DOWNLOAD_HOSTS].sort()).toEqual(
      ['github.com', 'objects.githubusercontent.com', 'gitcode.com'].sort(),
    )
  })

  it('两源适配器产出的全部 assets downloadUrl + manifest 直链 hostname ⊆ ALLOWED_DOWNLOAD_HOSTS（防漂移）', () => {
    const gh = normalizeSourceRelease('github', githubReleaseJson())
    const ag = normalizeSourceRelease('gitcode', gitcodeReleaseJson())
    const manifestUrls = [gh.assets, ag.assets]
      .map((assets) => resolveManifestDownloadUrl(assets))
      .filter((u): u is string => u !== undefined)
    const allUrls = [
      ...gh.assets.map((a) => a.browser_download_url),
      ...ag.assets.map((a) => a.browser_download_url),
      ...manifestUrls,
    ]
    expect(allUrls.length).toBeGreaterThanOrEqual(6)
    for (const url of allUrls) {
      expect(ALLOWED_DOWNLOAD_HOSTS.has(new URL(url).hostname)).toBe(true)
    }
    // 落域实测事实锚定（P1）：github 产物落 github.com、gitcode 产物落 gitcode.com
    expect(new URL(gh.assets[0].browser_download_url).hostname).toBe(RELEASE_SOURCE_HOSTS.githubDownload)
    expect(new URL(ag.assets[0].browser_download_url).hostname).toBe(RELEASE_SOURCE_HOSTS.gitcodeDownload)
  })

  it('fetch 全链路产物（LatestReleaseInfo 平台分流后）downloadUrl hostname 同样 ⊆ 白名单', async () => {
    const fetchMock = stubFetch()
    fetchMock
      .mockResolvedValueOnce(jsonResponse(githubReleaseJson()))
      .mockResolvedValueOnce(jsonResponse(gitcodeReleaseJson()))

    const gh = await fetchLatestRelease('github')
    const ag = await fetchLatestRelease('gitcode')

    for (const info of [gh, ag]) {
      for (const asset of [info?.assets.macArm64Dmg, info?.assets.winX64Exe, info?.assets.linuxX64AppImage]) {
        if (!asset) continue
        expect(ALLOWED_DOWNLOAD_HOSTS.has(new URL(asset.downloadUrl).hostname)).toBe(true)
      }
    }
  })
})
