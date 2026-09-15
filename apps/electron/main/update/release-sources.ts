/**
 * Release 源适配层（多源改造 D1/D2）：GitHub / AtomGit 双源 fetch + normalize 单点。
 *
 * 设计：docs/design/update-multi-source.md
 * - §6.1 D1：源抽象收敛在本模块——fetchSourceRelease / fetchLatestRelease /
 *   fetchReleaseByTag 按源分派（github / atomgit 两个适配实现），输出统一 normalize
 *   后的结构；checker 保持编排门面。
 * - §6.2 D2：AtomGit 字段差异在 normalize 层补齐（逐字段规格见 normalizeSourceRelease）。
 * - §7.2：github 分支迁移自 release-checker.ts 的 doFetchGitHubLatestRelease
 *   （URL / headers / 形状守卫 / HTTP status 分流语义）；两源共用 upgradeFetch 双引擎
 *   + 代理通道参数（代理优先 + 网络失败降直连重试一次，对齐 fetchGitHubLatestRelease 编排）。
 *
 * M0 探针输入（impl-plan §0.1 实测，2026-09-07）：
 * - P1：AtomGit 附件（type=attach）browser_download_url 落域 gitcode.com
 *   （by-tag 直链形态 releases/download/{tag}/{file}）→ 白名单精确登记一项。
 * - P6：AtomGit prerelease 为 boolean、draft/published_at/html_url 为 null、release_status 'none'
 *   → `=== true` 收窄保留为防御性收窄（防 API 演化为字符串编码——先例见
 *   scripts/gitcode-release-sync.mjs createRelease 以 String(prerelease) 字符串编码写入，
 *   truthy 语义会把 "false" 误判为 true 致 AtomGit 源检查全灭）。
 *
 * 错误分类（对齐 release-checker.ts 现状 catch 风格 + 适配层失败显式化）：
 * - ReleaseFetchError(kind)：'network'（网络失败/非法 JSON）/ 'rate-limited'（GitHub 403/429；
 *   AtomGit 无限流响应头，不识别限流，一律按 HTTP 失败收口 null）/ 'bad-shape'（形状守卫失败）。
 *   u-checker 编排按 kind 把失败归入「该源失败」进源降级。
 * - 404/其他非 2xx 返回 null（服务器已响应、重试无意义，对齐 doFetchGitHubLatestRelease 现状；
 *   by-tag 无此 tag = 发布时间窗/部分同步失败窗口，null 交由调用方判定对侧不可用）。
 * - 网络/形状坏抛错而非吞 null：适配层是「该源失败」信号的产出点，checker 逐源降级依赖它。
 *
 * [同构副本并存声明]（impl-plan §5 终态）：
 * - ASSET_PATTERNS / extractSha256 与 release-checker.ts 组装段为标注并存的同构副本
 *   （对方已标 [同构副本声明]），非领地阻塞；收敛前提 = 本模块导出组装辅助（当前私有），
 *   切换单一来源的评估留待后续 cleanup。
 * - ReleaseAsset.size 已于 shared 落地可选化（size?: number，commit 363b9b7fe），
 *   AtomGit 无 API size（§6.2 规格：undefined，由 checker manifest fallback 填充）。
 *
 * 依赖方向：release-sources → @taiji/shared + ./proxy-config + ./upgrade-fetch。
 * 不 import release-checker（u-checker 将反向消费本模块，避免循环依赖）。
 */
import type { LatestReleaseInfo, ReleaseAsset, UpdateSource } from '@taiji/shared'
import { readProxyConfig, resolveProxyUrl } from './proxy-config.js'
import { upgradeFetch, isCurlHttpStatusError } from './upgrade-fetch.js'

// ── 域常量（单一来源）────────────────────────────────────────────────
// validate-release 白名单 / source-resolver 探测域 / 本模块 API 端点均消费此处，
// 防「白名单域」与「适配器产物落域」两处漂移（D1 效果段防漂移断言的锚点）。

/** 两源 API 域与下载域（命名事实：平台名 AtomGit，域名保持 GitCode 客观事实，设计 §1） */
export const RELEASE_SOURCE_HOSTS = {
  /** GitHub API 域 */
  githubApi: 'api.github.com',
  /** GitHub release assets 下载直链域 */
  githubDownload: 'github.com',
  /** GitHub 下载 302 二跳落域（签名 CDN，历史白名单成员） */
  githubAssetsCdn: 'objects.githubusercontent.com',
  /** AtomGit（GitCode）API 域 */
  atomgitApi: 'api.gitcode.com',
  /** AtomGit 下载直链域（P1 探针实测附件落域） */
  atomgitDownload: 'gitcode.com',
} as const

/**
 * 下载域白名单（install 前校验的同源集合，D6）：GitHub 现行 2 域 + AtomGit 下载域。
 * validate-release 消费此集合（u-download-failover 领地内切换），不再各自维护。
 */
export const ALLOWED_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set<string>([
  RELEASE_SOURCE_HOSTS.githubDownload,
  RELEASE_SOURCE_HOSTS.githubAssetsCdn,
  RELEASE_SOURCE_HOSTS.atomgitDownload,
])

// ── 可归类错误 ───────────────────────────────────────────────────────

/** Release 源 fetch 失败归类（u-checker 按 kind 决定「该源失败」的退避/降级语义） */
export type ReleaseFetchErrorKind = 'network' | 'rate-limited' | 'bad-shape'

/**
 * Release 源 fetch 可归类错误。
 *
 * 与「404/null 收口」可区分：null = 服务器已响应且语义为「无此 release / 非 2xx」；
 * 本错误 = 网络失败（可换通道/换源重试）、限流（需退避）、形状坏（响应体不可信）。
 */
export class ReleaseFetchError extends Error {
  readonly kind: ReleaseFetchErrorKind
  readonly source: UpdateSource
  /** rate-limited 时的 HTTP 状态码（403/429） */
  readonly httpStatus?: number

  constructor(
    kind: ReleaseFetchErrorKind,
    source: UpdateSource,
    message: string,
    opts?: { httpStatus?: number },
  ) {
    super(message)
    this.name = 'ReleaseFetchError'
    this.kind = kind
    this.source = source
    this.httpStatus = opts?.httpStatus
  }
}

// ── 仓库与端点 ───────────────────────────────────────────────────────

/** GitHub 仓库（release-checker.ts 现行常量迁移） */
const GITHUB_REPO = 'zhushanwen321/tai-ji'
/** AtomGit 仓库（发布流程单向同步目标，文件与 GitHub 逐字节一致） */
const ATOMGIT_REPO = 'qq_18433817/tai-ji'

const GITHUB_API_BASE = `https://${RELEASE_SOURCE_HOSTS.githubApi}/repos/${GITHUB_REPO}/releases`
const ATOMGIT_API_BASE = `https://${RELEASE_SOURCE_HOSTS.atomgitApi}/api/v5/repos/${ATOMGIT_REPO}/releases`
/** AtomGit release 页面链接 base（html_url 拼接用，§6.2；页面格式 v0.9.14 实测） */
const ATOMGIT_RELEASE_PAGE_BASE = `https://${RELEASE_SOURCE_HOSTS.atomgitDownload}/${ATOMGIT_REPO}/releases`

/**
 * 请求头：Accept（GitHub JSON 媒体类型）+ X-GitHub-Api-Version + User-Agent。
 * GitHub API 要求 User-Agent 非空（否则 403）——upgradeFetch 默认已带 UA，
 * 此处显式补 GitHub 特有头。AtomGit 匿名 GET 无特殊 headers（仅默认 UA）。
 */
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const

/** fetch 超时（对齐 release-checker FETCH_TIMEOUT_MS 既有语义） */
const FETCH_TIMEOUT_MS = 10_000

/** HTTP 状态码：GitHub API 限流/配额拒绝 */
const HTTP_STATUS_FORBIDDEN = 403
const HTTP_STATUS_TOO_MANY_REQUESTS = 429

// ── 源适配器配置表（按源分派；两源共用 fetch 流程，差异收敛在此）────────

interface SourceAdapter {
  /** releases/latest 端点 */
  latestUrl: string
  /** releases/tags/{tag} 端点（by-tag 精确查询） */
  byTagUrl: (tag: string) => string
  /** 附加请求头；undefined = 匿名 GET 无特殊 headers（仅 upgradeFetch 默认 UA） */
  headers?: Record<string, string>
  /**
   * 是否识别限流信号：GitHub 有 60 次/h 匿名配额，403/429 → rate-limited 可归类错误；
   * AtomGit 无限流响应头（§4.1），403/429 与其他非 2xx 同收口 null。
   */
  rateLimitAware: boolean
}

const ADAPTERS: Record<UpdateSource, SourceAdapter> = {
  github: {
    latestUrl: `${GITHUB_API_BASE}/latest`,
    byTagUrl: (tag) => `${GITHUB_API_BASE}/tags/${encodeURIComponent(tag)}`,
    headers: { ...GITHUB_HEADERS },
    rateLimitAware: true,
  },
  atomgit: {
    latestUrl: `${ATOMGIT_API_BASE}/latest`,
    byTagUrl: (tag) => `${ATOMGIT_API_BASE}/tags/${encodeURIComponent(tag)}`,
    rateLimitAware: false,
  },
}

// ── normalize（D2 规格，两源统一出口形态 = GitHubRelease 同形）──────────

/**
 * normalize 后的单个 asset（GitHubRelease asset 同形，别名容错已归一）。
 * size 可选：AtomGit 实测无 size（null/缺字段），GitHub 恒有；digest 仅 GitHub 提供。
 */
export interface SourceReleaseAsset {
  /** 文件名（如 'TaiJi-0.9.15-mac-arm64.dmg' / 'manifest.json'） */
  name: string
  /** 下载直链 */
  browser_download_url: string
  /** 文件大小（字节）；AtomGit 无 → undefined（由 checker manifest fallback 填充） */
  size?: number
  /** GitHub 服务端摘要（'sha256:<hex>' 形态）；AtomGit 无 → undefined */
  digest?: string
}

/**
 * normalize 后的 release（GitHubRelease 同形）——checker 既有三重防御/版本比较/
 * 组装逻辑可无差别消费任一源。
 *
 * 字段语义：
 * - prerelease：显式 `=== true` 收窄后的 boolean（恒存在，非 boolean 一律 false）
 * - draft：github 原样 boolean；atomgit 恒 undefined（API 只返回已发布 release，
 *   防御 b 的 `if (release.draft)` 对 undefined 自然放行，语义等价，§6.2）
 * - release_status：忽略（AtomGit 特有，prerelease 防御不依赖它）
 */
export interface SourceRelease {
  /** 原始 tag（如 'v0.9.15'） */
  tag_name: string
  /** Release body markdown 原文 */
  body?: string
  /** 发布时间；atomgit 无此字段 → ''（LatestReleaseInfo.publishedAt 现有 ?? '' 容错） */
  published_at?: string
  /** release 页面 URL；atomgit 拼 gitcode.com 页面链接 */
  html_url?: string
  /** prerelease 标记（收窄后恒 boolean） */
  prerelease: boolean
  /** draft 标记；atomgit → undefined */
  draft?: boolean
  /** 产物资产列表（含 manifest.json 等非平台资产） */
  assets: SourceReleaseAsset[]
}

/** 容器字段别名族（对齐 scripts/gitcode-release-sync.mjs assetList 容错先例：GitCode 同构性不可靠） */
function resolveAssetContainer(raw: Record<string, unknown>): unknown {
  return raw.assets ?? raw.attach_files ?? raw.attachFiles
}

/** 首个非空 string */
function firstString(...vals: unknown[]): string | undefined {
  return vals.find((v): v is string => typeof v === 'string' && v.length > 0)
}

/** 首个非 undefined/null 值（size 别名族；GitCode 现状 size null 被跳过后穷尽 → undefined） */
function firstDefined(...vals: unknown[]): unknown {
  return vals.find((v) => v !== undefined && v !== null)
}

/** 仅当值为 https 绝对 URL 时返回（下载域白名单只放行 https，http/相对路径不作 URL 别名命中） */
function asHttpsUrl(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith('https://') ? v : undefined
}

/** size 字段归一：number 直取；纯数字字符串转换（GitCode 历史字符串编码防御）；其余 undefined */
function normalizeAssetSize(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}

/**
 * 单个 asset 的别名容错映射（对齐 sync 脚本 assetList :172-185 先例）：
 * - name：name / file_name / path / filename 族
 * - url：browser_download_url 权威；path / filename 仅当其值为 https 绝对 URL 时兜底
 *   （两字段在先例中是文件名语义，防文件名被误当下载直链）
 * - size：size / filesize / file_size / attach_size 族（AtomGit 现状全缺 → undefined）
 * name 或 url 缺失的条目丢弃（对齐先例 filter(a => a.name) 纪律 + 坏 URL 不进下载面）。
 */
function normalizeSourceAsset(a: unknown): SourceReleaseAsset | undefined {
  if (typeof a !== 'object' || a === null) return undefined
  const o = a as Record<string, unknown>
  const name = firstString(o.name, o.file_name, o.path, o.filename)
  if (name === undefined) return undefined
  const url = firstString(o.browser_download_url, asHttpsUrl(o.path), asHttpsUrl(o.filename))
  if (url === undefined) return undefined
  return {
    name,
    browser_download_url: url,
    size: normalizeAssetSize(firstDefined(o.size, o.filesize, o.file_size, o.attach_size)),
    digest: typeof o.digest === 'string' ? o.digest : undefined,
  }
}

/**
 * 两源统一 normalize（D2 逐字段规格）：
 * - 形状守卫（两源同款）：tag_name 非 string / 资产容器非 array → bad-shape 可归类错误
 *   （不把错误推迟到下游消费点——对齐 doFetchGitHubLatestRelease 守卫意图，失败显式化）
 * - prerelease → `=== true` 收窄（防字符串编码 "false" 被 truthy 误判）
 * - draft → 非 boolean 一律 undefined（AtomGit null → undefined）
 * - published_at → atomgit 恒 ''（无此字段）；github 原样
 * - html_url → atomgit 拼 `https://gitcode.com/{repo}/releases/{tag}`；github 原样
 * - release_status → 忽略
 * - asset size/digest → 缺失即 undefined（checker manifest fallback 填充）
 *
 * @throws ReleaseFetchError kind 'bad-shape' 形状守卫失败
 */
export function normalizeSourceRelease(source: UpdateSource, raw: unknown): SourceRelease {
  if (typeof raw !== 'object' || raw === null) {
    throw new ReleaseFetchError('bad-shape', source, `release response is not an object (${typeof raw})`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.tag_name !== 'string') {
    throw new ReleaseFetchError(
      'bad-shape',
      source,
      `release response has unexpected shape (tag_name=${String(r.tag_name)})`,
    )
  }
  const rawAssets = resolveAssetContainer(r)
  if (!Array.isArray(rawAssets)) {
    throw new ReleaseFetchError(
      'bad-shape',
      source,
      `release response has unexpected shape (assets=${Array.isArray(rawAssets) ? 'array' : typeof rawAssets})`,
    )
  }
  const assets = rawAssets
    .map((a) => normalizeSourceAsset(a))
    .filter((a): a is SourceReleaseAsset => a !== undefined)
  return {
    tag_name: r.tag_name,
    body: typeof r.body === 'string' ? r.body : undefined,
    published_at:
      source === 'atomgit' ? '' : typeof r.published_at === 'string' ? r.published_at : undefined,
    html_url:
      source === 'atomgit'
        ? `${ATOMGIT_RELEASE_PAGE_BASE}/${r.tag_name}`
        : typeof r.html_url === 'string'
          ? r.html_url
          : undefined,
    prerelease: r.prerelease === true,
    draft: typeof r.draft === 'boolean' ? r.draft : undefined,
    assets,
  }
}

/**
 * manifest 直链解析辅助（checker 消费）：从 release JSON assets 中按
 * name === 'manifest.json' 取 browser_download_url（§4.2⑤：by-tag 精确对齐本次
 * release，禁用 releases/latest/download/ 别名——无验证记录且有 latest 前移错位竞态）。
 */
export function resolveManifestDownloadUrl(
  assets: readonly SourceReleaseAsset[],
): string | undefined {
  return assets.find((a) => a.name === 'manifest.json')?.browser_download_url
}

// ── fetch 流程（两源共用：upgradeFetch 双引擎 + 代理通道编排）────────────

/**
 * 单次 fetch + status 分流 + normalize（形态对齐 doFetchGitHubLatestRelease）。
 *
 * @returns normalize 后的 SourceRelease；非 2xx（含 404，限流除外）返回 null
 * @throws ReleaseFetchError 'rate-limited'（GitHub 403/429，两引擎同款重建——
 *         undici ok:false 与 curl exit 22 携带 httpStatusCode 两形态等价）/
 *         'bad-shape'（形状守卫）/ 'network'（网络错误、双引擎均网络失败、非法 JSON）
 */
async function doFetchSourceRelease(
  source: UpdateSource,
  url: string,
  proxyUrl: string | undefined,
): Promise<SourceRelease | null> {
  const adapter = ADAPTERS[source]
  try {
    const result = await upgradeFetch(url, {
      headers: adapter.headers ? { ...adapter.headers } : undefined,
      proxyUrl,
      timeoutMs: FETCH_TIMEOUT_MS,
    })
    if (!result.ok) {
      // 限流是服务器明确响应（AtomGit 无限流语义不识别）→ 可归类错误，不并入 null 也不降级直连
      if (
        adapter.rateLimitAware &&
        (result.status === HTTP_STATUS_FORBIDDEN || result.status === HTTP_STATUS_TOO_MANY_REQUESTS)
      ) {
        throw new ReleaseFetchError(
          'rate-limited',
          source,
          `release source ${source} rate limited (HTTP ${result.status})`,
          { httpStatus: result.status },
        )
      }
      return null
    }
    const raw = JSON.parse(result.bodyText ?? '') as unknown
    return normalizeSourceRelease(source, raw)
  } catch (err) {
    // 可归类错误直通（限流/形状坏），不得被下方包装吞掉 kind
    if (err instanceof ReleaseFetchError) throw err
    // curl 引擎 HTTP 状态交互规则（对齐 release-checker D8 重建）：携带 httpStatusCode 的
    // CurlFetchError = 服务器已响应——GitHub 403/429 重建限流错误；其他按非 2xx null 收口，
    // 均不触发外层「代理→直连」通道重试
    if (isCurlHttpStatusError(err)) {
      if (
        adapter.rateLimitAware &&
        (err.httpStatusCode === HTTP_STATUS_FORBIDDEN ||
          err.httpStatusCode === HTTP_STATUS_TOO_MANY_REQUESTS)
      ) {
        throw new ReleaseFetchError(
          'rate-limited',
          source,
          `release source ${source} rate limited (HTTP ${err.httpStatusCode})`,
          { httpStatus: err.httpStatusCode },
        )
      }
      return null
    }
    // 网络错误（含不带 httpStatusCode 的 CurlFetchError——exit 7/28 等网络级失败）与
    // 非法 JSON 均归 network 桶抛出（对齐现状「fetch failed」收口 + 非法 JSON 同桶语义）
    throw new ReleaseFetchError(
      'network',
      source,
      `release source ${source} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * 通道维度编排（对齐 fetchGitHubLatestRelease，update-network-resilience D6/D10）：
 * 代理优先，网络失败降直连重试一次；限流/形状坏不重试（服务器已响应 / 响应体已坏，换通道无意义）。
 *
 * 与现状的差异（设计意图）：现状 checker 外层把最终失败吞成 null；适配层是
 * 「该源失败」信号产出点，网络失败显式上抛（ReleaseFetchError），由 checker 逐源降级。
 */
async function fetchSourceReleaseViaChannel(
  source: UpdateSource,
  url: string,
): Promise<SourceRelease | null> {
  const proxyConfig = readProxyConfig()
  const proxyUrl = resolveProxyUrl(proxyConfig)
  const useProxy = proxyUrl !== undefined

  try {
    return await doFetchSourceRelease(source, url, useProxy ? proxyUrl : undefined)
  } catch (err) {
    if (err instanceof ReleaseFetchError && err.kind !== 'network') throw err
    if (useProxy) {
      // 降级直连重试一次（重试结果原样上抛/返回——直连撞限流/形状坏同样不吞）
      return await doFetchSourceRelease(source, url, undefined)
    }
    throw err
  }
}

// ── 组装（SourceRelease → LatestReleaseInfo）─────────────────────────

// 与 release-checker.ts 组装段标注并存的同构副本（非领地阻塞，详见文件头声明）。
const ASSET_PATTERNS = {
  macArm64Dmg: (name: string): boolean => name.endsWith('-mac-arm64.dmg'),
  winX64Exe: (name: string): boolean => name.endsWith('-setup-x64.exe'),
  linuxX64AppImage: (name: string): boolean => name.endsWith('-x86_64.AppImage'),
} as const

/** 从 GitHub asset.digest（'sha256:<hex>'）提取纯 64 位 hex；非法一律 undefined（对齐现状） */
function extractSha256(digest?: string): string | undefined {
  if (!digest) return undefined
  const prefix = 'sha256:'
  if (digest.startsWith(prefix)) {
    const hex = digest.slice(prefix.length)
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : undefined
  }
  return /^[0-9a-f]{64}$/i.test(digest) ? digest : undefined
}

/** 与 ReleaseAsset 同构（size 已可选化），简化候选（后续 cleanup）；AtomGit 无 API size，规格见 §6.2 */
type ReleaseAssetLoose = Omit<ReleaseAsset, 'size'> & { size?: number }

/** 按 pattern 从 asset 列表挑选单平台资产；sha256 取 asset.digest（manifest fallback 由 checker 做） */
function pickAsset(
  assets: readonly SourceReleaseAsset[],
  match: (name: string) => boolean,
): ReleaseAssetLoose | undefined {
  const found = assets.find((a) => match(a.name))
  if (!found) return undefined
  return {
    name: found.name,
    downloadUrl: found.browser_download_url,
    size: found.size,
    sha256: extractSha256(found.digest),
  }
}

/**
 * SourceRelease → LatestReleaseInfo 组装。
 *
 * prerelease/draft 拦截在此收口（返回 null = 非 stable，不可作升级目标）：该防御
 * 等价于现状 checker 在 buildLatestReleaseInfo 前执行的防御 b——LatestReleaseInfo
 * 不承载 prerelease/draft 字段，拦截必须在信息丢失前完成。防御 c（严格 semver）
 * 与版本比较仍归 checker（version 字段可校验，信息未丢失）。
 *
 * size 单字段断言：AtomGit 无 API size → 运行时 undefined（checker manifest fallback
 * 填充），类型收敛债务见文件头注释。
 */
function toLatestReleaseInfo(source: UpdateSource, release: SourceRelease): LatestReleaseInfo | null {
  if (release.prerelease || release.draft) return null
  const tagName = release.tag_name
  const info: Omit<LatestReleaseInfo, 'assets'> & {
    assets: {
      macArm64Dmg?: ReleaseAssetLoose
      winX64Exe?: ReleaseAssetLoose
      linuxX64AppImage?: ReleaseAssetLoose
    }
  } = {
    version: tagName.startsWith('v') ? tagName.slice(1) : tagName,
    tagName,
    releaseNotes: release.body ?? '',
    publishedAt: release.published_at ?? '',
    htmlUrl: release.html_url ?? '',
    assets: {
      macArm64Dmg: pickAsset(release.assets, ASSET_PATTERNS.macArm64Dmg),
      winX64Exe: pickAsset(release.assets, ASSET_PATTERNS.winX64Exe),
      linuxX64AppImage: pickAsset(release.assets, ASSET_PATTERNS.linuxX64AppImage),
    },
    source,
  }
  return info as LatestReleaseInfo
}

// ── 公开 API ─────────────────────────────────────────────────────────

/**
 * fetch 指定源的最新 release（releases/latest），返回 normalize 后的完整产物
 * （GitHubRelease 同形，含原始 assets 数组——manifest.json 等非平台资产保留）。
 *
 * checker 消费形态（§4.2⑤ 权威通路）：winner = fetchSourceRelease(source) →
 * 防御/版本比较用 prerelease/draft/tag_name 字段 → resolveManifestDownloadUrl(winner.assets)
 * 取 manifest 直链 → 自行组装 LatestReleaseInfo（manifest size 扩展在 checker 组装层）。
 *
 * 不做非 stable 拦截（与 fetchLatestRelease 的差异点）：SourceRelease 完整承载
 * prerelease/draft 字段，防御归 checker 循环（§4.2③④），本函数只负责 fetch+normalize。
 *
 * @returns SourceRelease；非 2xx（含 404）返回 null
 * @throws ReleaseFetchError 网络失败 / GitHub 限流 / 形状坏（可归类，u-checker 记该源失败）
 */
export async function fetchSourceRelease(source: UpdateSource): Promise<SourceRelease | null> {
  return fetchSourceReleaseViaChannel(source, ADAPTERS[source].latestUrl)
}

/**
 * fetch 指定源的最新 release（releases/latest），normalize + 非 stable 拦截后输出。
 * 与 fetchSourceRelease 复用同一 fetch+normalize 管线，仅出口形态不同（LatestReleaseInfo
 * 平台分流视图 vs 完整产物）。
 *
 * @returns LatestReleaseInfo（含 source）；非 2xx（含 404）或非 stable（prerelease/draft）
 *          返回 null
 * @throws ReleaseFetchError 网络失败 / GitHub 限流 / 形状坏（可归类，u-checker 记该源失败）
 */
export async function fetchLatestRelease(source: UpdateSource): Promise<LatestReleaseInfo | null> {
  const release = await fetchSourceRelease(source)
  return release ? toLatestReleaseInfo(source, release) : null
}

/**
 * fetch 指定源按 tag 精确查询的 release（releases/tags/{tag}，下载跨源降级与
 * checker 透传共用）。
 *
 * @returns LatestReleaseInfo（含 source）；无此 tag（404）返回 null（发布时间窗
 *          = 对侧不可用，调用方保留断点原错误上抛，§6.5）；非 stable 同样 null
 * @throws ReleaseFetchError 同 fetchLatestRelease
 */
export async function fetchReleaseByTag(
  source: UpdateSource,
  tag: string,
): Promise<LatestReleaseInfo | null> {
  const release = await fetchSourceReleaseViaChannel(source, ADAPTERS[source].byTagUrl(tag))
  return release ? toLatestReleaseInfo(source, release) : null
}
