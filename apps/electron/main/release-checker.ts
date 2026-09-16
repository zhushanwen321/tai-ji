/**
 * Release 检测器（多源编排门面，update-multi-source §4.2①-⑥）。
 *
 * 对应 slice auto-update-and-install：实现 IReleaseChecker Facade。
 *
 * 职责链（检查流 §4.2①-⑥，fetch+normalize 收敛在源适配层 release-sources.ts，
 * checker 消费其 fetchSourceRelease 完整产物出口）：
 *   1. 缓存命中检查（1h，force 可绕过；正/负缓存同 TTL）
 *   2. 源顺序解析：构造注入的 resolveSourceOrder(settings.updateSource)（D4；
 *      测试可替换，未注入时回退真实实现）
 *   3. 按 SourceOrder 逐源执行完整判定（fetch + 三重防御 + 版本比较，循环内 per-source 生效）：
 *      - 源在退避窗口内 → 短路跳过（零请求）
 *      - fetch 抛 ReleaseFetchError（network/bad-shape/rate-limited）→ 记该源失败 → 次源；
 *        其中 rate-limited 额外记 per-source 2h 退避
 *      - fetch 返回 null（404/非 2xx）→ 该源无响应数据，归「未确认」→ 次源
 *      - 防御 b：release.prerelease / draft 字段拦截（fetchSourceRelease 返回完整产物
 *        不做拦截，防御归本循环）→ 记「该源无新版」→ 次源
 *      - 防御 c（严格 semver tag）不过 或 版本比较不比当前新 → 记「该源无新版」→ 次源，
 *        不写全局负缓存（源 A 无新版 ≠ 全局无新版，次源可能有 stable 新版，§6.5）
 *      - 首个「fetch 成功且判定有新版」的源胜出 → 组装 + manifest 填充 → 出循环
 *   4. 循环出口（负缓存语义，§4.2⑥）：
 *      - 有胜出源 → 写正缓存（info 含 source 字段，落盘后供下载降级定向）
 *      - 所有源均「确认无新版」→ 写负缓存（info=null）
 *      - 混合态（部分失败/退避 + 其余无新版）→ 返回 null 不写负缓存
 *        （负缓存会把「未知」固化为「确认无」1h）
 *      - 所有源均失败 → null 不缓存失败
 *
 * [per-source 限流退避（§6.5）]：单值 rateLimitedUntil 改为 Map<UpdateSource, until>。
 * getRateLimitedUntil() 签名不变（返回 epoch ms），语义 = 全部已知源均在退避窗口才
 * 返回未来时刻（= 各源截止时刻的 min，最早解除时刻）；任一源无退避记录或已解除
 * 返回 0（无任何记录同样 0）——handler 判定式 `> Date.now()` 与既有 mock 形态不变，
 * §6.5「全部源都在退避窗口才报 rateLimited」由此精确成立。
 * 退避记录点：源 latest fetch 撞 GitHub 403/429（适配层 rate-limited 分类）；
 * manifest fetch 撞 GitHub 403/429（两引擎同形态重建）。GitCode manifest 的
 * 403/429 是 auth_key 签名直链的签名/权限拒绝（§4.1），按普通失败收口不记退避，
 * 由该源失败降级兜底。
 *
 * [manifest 填充（胜出源，§4.2⑤ 权威通路）]：manifest 是 release 资产之一，
 * 直链 = resolveManifestDownloadUrl(胜出源完整 assets)（适配层 browser_download_url，
 * by-tag 精确对齐本次 release，无 latest 别名的错位竞态）。
 * - 解析扩展为 Map<name, {sha256, size?}>；asset size 取值 `API size ?? manifest size`
 *   （GitCode 无 API size，size 全靠 manifest）
 * - GitHub 路径：digest 优先，manifest 失败（含 assets 无 manifest.json 资产）不阻塞
 *   （sha256 undefined → 下载侧 size 校验兜底）
 * - GitCode 路径：sha256/size 唯一来源是 manifest → 直链缺失/fetch 失败（网络/404/
 *   解析失败/目标资产缺失）计为「该源失败」→ 回循环试次源（D2 源归类）
 *
 * [HISTORICAL] 不变量：
 * - 失败一律 catch 返回 null，不缓存失败；「无新版」类结果按循环出口语义写负缓存
 * - sha256 来源：优先 asset.digest（checker 组装层提取）；缺失时 manifest fallback
 * - manifest fallback 仅在至少一个目标 asset 缺 sha256 时 fetch 一次（lazy）
 * - 通道维度「代理优先 + 失败降级直连」：latest/by-tag 在适配层内编排；manifest
 *   保留在 checker（同策略）；引擎维度（undici → curl）内嵌 upgradeFetch
 *
 * 依赖方向：release-checker → @taiji/shared + compare-versions
 *          + update/release-sources（源适配层）+ update/source-resolver（构造注入默认实现）
 *          + update/update-settings（updateSource 偏好读取）+ update/error-log（诊断登记）
 *          + update/proxy-config + update/upgrade-fetch（manifest 路径专用）
 */
import { compare } from 'compare-versions'
import type { LatestReleaseInfo, ReleaseAsset, UpdateSource, UpdateSourcePref } from '@taiji/shared'
import type { IReleaseChecker } from './interfaces.js'
import {
  fetchSourceRelease,
  fetchReleaseByTag as fetchReleaseByTagFromSource,
  resolveManifestDownloadUrl,
  ReleaseFetchError,
} from './update/release-sources.js'
import type { SourceRelease, SourceReleaseAsset } from './update/release-sources.js'
import type { SourceOrder } from './update/source-resolver.js'
import { getLastProbeOutcome, resolveSourceOrder } from './update/source-resolver.js'
import { getUpdateSettings } from './update/update-settings.js'
import type { SourceProbeOutcome } from './update/error-log.js'
import { logSourceSelection, logSourceFailover } from './update/error-log.js'
import { readProxyConfig, resolveProxyUrl } from './update/proxy-config.js'
import { upgradeFetch, isCurlHttpStatusError } from './update/upgrade-fetch.js'

/** 时长换算（复用于缓存 TTL / 限流退避等时长常量组合） */
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MS_PER_SECOND = 1000

/** fetch 超时（对齐适配层 FETCH_TIMEOUT_MS 既有语义） */
const FETCH_TIMEOUT_MS = 10_000

/** 403/429 限流退避窗口小时数（RM2.3：跳过后续周期的联网检查，共 2h） */
const RATE_LIMIT_BACKOFF_HOURS = 2
const RATE_LIMIT_BACKOFF_MS =
  RATE_LIMIT_BACKOFF_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

/**
 * 全部已知更新源（getRateLimitedUntil 的全源退避判定集合）。
 * [枚举同步锚点] 成员与 shared 的 UpdateSource 联合类型一一对应
 * （packages/shared/src/update.ts——shared 只导出类型无运行时值常量；适配层
 * RELEASE_SOURCE_HOSTS 的键是 host 用途名而非源名，不可作源枚举）。新增源时
 * 同批更新本常量，防类型面与运行时枚举双轨漂移。
 */
const KNOWN_UPDATE_SOURCES: readonly UpdateSource[] = ['github', 'gitcode']

/** HTTP 状态码：GitHub API 限流/配额拒绝（RM2.3 可区分信号） */
const HTTP_STATUS_FORBIDDEN = 403
const HTTP_STATUS_TOO_MANY_REQUESTS = 429

/**
 * GitHub API 限流/拒绝信号（HTTP 403/429）。
 *
 * [legacy 导出锚点] 现仅作为 manifest 路径 403/429 的内部信号类保留导出：
 * latest/by-tag 的限流信号已改由适配层 ReleaseFetchError('rate-limited') 承载。
 * 既有 test/release-checker-upgrade-fetch.test.ts 以本导出做重建形态回归锚点，
 * 领地在 u5（update-network-resilience），删除前须先迁移该文件。
 */
export class ReleaseRateLimitedError extends Error {
  constructor(message = 'Release source rate limited (403/429)') {
    super(message)
    this.name = 'ReleaseRateLimitedError'
  }
}

/** 缓存有效期（1h） */
const CACHE_TTL_MS = SECONDS_PER_MINUTE * MINUTES_PER_HOUR * MS_PER_SECOND

/**
 * 严格版本号校验（strip 前导 v 后）——拒绝 rc/beta 等后缀。
 * 支持 3 段（1.2.3）或 4 段（1.2.3.4，electron-builder 有时输出 4 段 build 号）。
 */
const STRICT_VERSION_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/

/**
 * 源顺序解析函数类型（构造注入契约）。真实实现 = update/source-resolver 的
 * resolveSourceOrder；测试注入可忽略 pref 参数直接返回固定序列。
 */
type ResolveSourceOrderFn = (pref: UpdateSourcePref) => Promise<SourceOrder>

// ── 组装层：SourceRelease → LatestReleaseInfo（胜出源平台分流）────────
//
// [同构副本声明] 与适配层 toLatestReleaseInfo 内部的 ASSET_PATTERNS/extractSha256/
// pickAsset 同构（适配层两者私有、fetchSourceRelease 的 JSDoc 预设「checker 自行组装
// LatestReleaseInfo」）。差异点仅一处：此处 pickAsset 不做 digest→sha256 之外的
// 额外兜底（manifest fallback 在 fillManifestForWinner 统一补）。若适配层后续导出
// 组装辅助，本段应删除切换为单一来源。

/** asset 文件名 pattern（按平台后缀匹配；兼容带/不带版本号的文件名，历史语义） */
const ASSET_PATTERNS = {
  macArm64Dmg: (name: string): boolean => name.endsWith('-mac-arm64.dmg'),
  winX64Exe: (name: string): boolean => name.endsWith('-setup-x64.exe'),
  linuxX64AppImage: (name: string): boolean => name.endsWith('-x86_64.AppImage'),
} as const

/**
 * 从 asset.digest（格式 'sha256:<hex>'）提取纯 64 位 hex。
 * 非法格式（如 'sha512:...'、垃圾数据、长度不符）一律返回 undefined，
 * 避免下游把非 sha256 值当 sha256 用导致误判。
 */
function extractSha256(digest?: string): string | undefined {
  if (!digest) return undefined
  const prefix = 'sha256:'
  if (digest.startsWith(prefix)) {
    const hex = digest.slice(prefix.length)
    return /^[0-9a-f]{64}$/i.test(hex) ? hex : undefined
  }
  // 不带前缀：必须本身是 64 位 hex 才算合法 sha256
  return /^[0-9a-f]{64}$/i.test(digest) ? digest : undefined
}

/** 按 pattern 从完整资产列表挑选单平台资产（sha256 先取 digest，manifest fallback 由调用方补） */
function pickPlatformAsset(
  assets: readonly SourceReleaseAsset[],
  match: (name: string) => boolean,
): ReleaseAsset | undefined {
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
 * 胜出源 SourceRelease → LatestReleaseInfo（平台分流，size 可为 undefined——
 * GitCode 无 API size，由 manifest fallback 填充，§6.2）。
 */
function buildLatestReleaseInfo(source: UpdateSource, release: SourceRelease): LatestReleaseInfo {
  const tagName = release.tag_name
  return {
    version: tagName.startsWith('v') ? tagName.slice(1) : tagName,
    tagName,
    releaseNotes: release.body ?? '',
    publishedAt: release.published_at ?? '',
    htmlUrl: release.html_url ?? '',
    assets: {
      macArm64Dmg: pickPlatformAsset(release.assets, ASSET_PATTERNS.macArm64Dmg),
      winX64Exe: pickPlatformAsset(release.assets, ASSET_PATTERNS.winX64Exe),
      linuxX64AppImage: pickPlatformAsset(release.assets, ASSET_PATTERNS.linuxX64AppImage),
    },
    source,
  }
}

// ── manifest 解析结构 ──────────────────────────────────────────────

/** manifest 单资产条目（多源扩展：size 可选——GitCode 的 API size 缺失由 manifest 补） */
interface ManifestAssetInfo {
  sha256: string
  size?: number
}

// ── 缓存条目类型 ──────────────────────────────────────────────────

/**
 * 缓存条目（info=null 表示「全部源确认无新版」的负缓存，同样受 TTL 保护）。
 */
interface CacheEntry {
  info: LatestReleaseInfo | null
  fetchedAt: number
}

/** 逐源尝试的失败记录（源降级登记与混合态判定的输入） */
interface SourceAttemptFailure {
  source: UpdateSource
  /** 失败归类（诊断 errorCode 字段透传，取 ReleaseFetchErrorKind / 收口语义值） */
  errorCode: string
}

/**
 * Release 检测器实现（多源编排门面）。
 *
 * 按 SourceOrder 逐源检测最新可用版本，1h 缓存 + per-source 限流退避。
 * 单实例由 main.ts 构造并注入到 IpcHandlerDeps.releaseChecker。
 */
export class ReleaseChecker implements IReleaseChecker {
  /** 缓存条目；null 表示无缓存（首次或上次 fetch 失败）；info=null 为负缓存（全部源确认无新版） */
  private cachedResult: CacheEntry | null = null

  /** per-source 限流退避截止时刻（epoch ms）：窗口内该源短路跳过（零请求） */
  private readonly backoffUntil = new Map<UpdateSource, number>()

  /** 源顺序解析（构造注入；未注入回退真实实现） */
  private readonly resolveSourceOrderFn: ResolveSourceOrderFn

  constructor(opts?: { resolveSourceOrder?: ResolveSourceOrderFn }) {
    this.resolveSourceOrderFn = opts?.resolveSourceOrder ?? resolveSourceOrder
  }

  /**
   * 限流退避截止时刻（IReleaseChecker 可选方法，签名不变）。
   * 语义 = 全部已知源（KNOWN_UPDATE_SOURCES）均在退避窗口才返回未来时刻，
   * 值取各源截止的 min（最早解除时刻）；任一源无退避记录或已解除（<= now）
   * 返回 0，无任何退避记录返回 0——任一源可用即检查可正常出结论，不报限流（§6.5）。
   * update:check handler 据此把「全源限额退避中的 null」与「确认无新版的 null」区分开，
   * 经 UpdateCheckResult.rateLimited 透传 renderer（RM2.3 信号透传）。
   */
  getRateLimitedUntil(): number {
    const now = Date.now()
    let min = Infinity
    for (const source of KNOWN_UPDATE_SOURCES) {
      const until = this.backoffUntil.get(source)
      if (until === undefined || until <= now) return 0
      if (until < min) min = until
    }
    return min === Infinity ? 0 : min
  }

  /**
   * 按 tag 从指定源精确查询 release（IReleaseChecker 透传实现，多源改造新增）。
   * 透传式语义：源由调用方显式指定（对侧源推导在 orchestrator），checker 无状态转发，
   * 与 D1 门面定位一致。
   */
  fetchReleaseByTag(source: UpdateSource, tag: string): Promise<LatestReleaseInfo | null> {
    return fetchReleaseByTagFromSource(source, tag)
  }

  /**
   * 检测最新可用版本（多源编排，§4.2①-⑥）。
   *
   * @param currentVersion 当前版本（如 '0.8.14'）
   * @param opts.force 强制刷新缓存
   */
  async checkForLatestRelease(
    currentVersion: string,
    opts?: { force?: boolean },
  ): Promise<LatestReleaseInfo | null> {
    // 1. 缓存命中检查（force 可绕过；正/负缓存的命中均零联网）
    const cached = this.getCachedResultIfFresh(opts)
    if (cached !== undefined) return cached

    // 2. 源顺序解析（§4.2②）：settings 来源偏好 → resolver（显式偏好/代理短路/探测）
    const pref = getUpdateSettings().updateSource ?? 'auto'
    const order = await this.resolveSourceOrderFn(pref)

    // 3. 逐源完整判定（§4.2③④）
    const noNewVersionSources: UpdateSource[] = []
    const failedSources: SourceAttemptFailure[] = []
    const latestTags: Partial<Record<UpdateSource, string>> = {}
    let winner: { source: UpdateSource; info: LatestReleaseInfo } | null = null

    for (const source of order) {
      // 退避短路：窗口内零请求（per-source 化的现状单源退避语义）
      if (Date.now() < (this.backoffUntil.get(source) ?? 0)) continue

      let release: SourceRelease | null = null
      try {
        release = await fetchSourceRelease(source)
      } catch (err) {
        // 可归类失败：rate-limited 记 per-source 退避；其余（network/bad-shape）记该源失败
        if (err instanceof ReleaseFetchError && err.kind === 'rate-limited') {
          this.recordRateLimitBackoff(source, 'latest')
          failedSources.push({ source, errorCode: err.kind })
        } else {
          failedSources.push({
            source,
            errorCode: err instanceof ReleaseFetchError ? err.kind : 'network',
          })
        }
        continue
      }
      if (!release) {
        // null 收口：404/非 2xx（该源无响应数据）→「未确认」桶（不写全局负缓存），试次源
        failedSources.push({ source, errorCode: 'no-release' })
        continue
      }
      latestTags[source] = release.tag_name

      // 三重 prerelease 防御 b：prerelease/draft 字段拦截（循环内 per-source 生效，
      // §4.2③④「被防御拦截 → 记该源无新版」；fetchSourceRelease 返回完整产物不做拦截，
      // 拦截归 checker——偏差登记「防御 b 前移适配层」合并回本循环）
      if (release.prerelease || release.draft) {
        noNewVersionSources.push(source)
        continue
      }

      // 防御 c + 版本比较（循环内 per-source 生效）：「该源无新版」不写全局负缓存
      const strippedVersion = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : release.tag_name
      if (this.isNoNewerVersion(strippedVersion, currentVersion)) {
        noNewVersionSources.push(source)
        continue
      }

      // 首个判定有新版的源为胜出候选 → 组装 + manifest 填充（§4.2⑤）
      const filled = await this.fillManifestForWinner(source, release)
      if (!filled) {
        // GitCode 路径 manifest 是 sha256/size 唯一来源：URL 缺失/fetch 失败/解析失败/
        // 目标资产缺失均计「该源失败」→ 回循环试次源（D2；GitHub 路径失败在此前已不阻塞返回）
        failedSources.push({ source, errorCode: 'manifest-failed' })
        continue
      }
      winner = { source, info: filled }
      break
    }

    // 4. 诊断登记（每轮实际发生源选择的检查结束时；缓存命中不经过此处）
    this.logSourceSelection(pref, order, winner, latestTags)

    // 5. 循环出口落位（§4.2⑥）
    if (winner) {
      // 源降级登记：前源失败转次源成功（含 manifest 失败触发的降级）
      for (const failed of failedSources) {
        logSourceFailover({
          segment: 'check',
          from: failed.source,
          to: winner.source,
          errorCode: failed.errorCode,
          manifestFrom: winner.source,
        })
      }
      // fetchedAt 必须在 fetch 完成后重新取 now，否则会比实际获取时间提前最多 10s（fetch timeout）
      this.cachedResult = { info: winner.info, fetchedAt: Date.now() }
      return winner.info
    }
    if (order.length > 0 && noNewVersionSources.length === order.length) {
      // 全部源均「确认无新版」→ 全局负缓存成立（混合态/全失败/全退避不落此分支）
      this.cachedResult = { info: null, fetchedAt: Date.now() }
    }
    return null
  }

  /**
   * 缓存命中检查（force 可绕过；正/负缓存同样命中）。
   *
   * @returns 命中返回缓存 info（null = 负缓存「全部源确认无新版」）；
   *          未命中（无缓存 / 已过期 / force）返回 undefined
   */
  private getCachedResultIfFresh(opts?: { force?: boolean }): LatestReleaseInfo | null | undefined {
    if (opts?.force) return undefined
    if (!this.cachedResult) return undefined
    const age = Date.now() - this.cachedResult.fetchedAt
    if (age >= CACHE_TTL_MS) return undefined
    return this.cachedResult.info
  }

  /**
   * 防御 c + 版本比较（per-source）：判定该源 release 是否「无新版」。
   * 非 strictly newer（含版本格式非法 / compare 抛错）均视为无新版。
   */
  private isNoNewerVersion(strippedVersion: string, currentVersion: string): boolean {
    // 三重 prerelease 防御 c：严格版本号校验（拒绝 rc/beta 后缀）
    if (!STRICT_VERSION_RE.test(strippedVersion)) return true
    try {
      return !compare(strippedVersion, currentVersion, '>') // compare 抛错则视为非新版
    } catch {
      return true
    }
  }

  /**
   * 记录指定源的限流退避窗口（RM2.3：2h）并输出诊断日志。
   */
  private recordRateLimitBackoff(source: UpdateSource, context: string): void {
    const until = Date.now() + RATE_LIMIT_BACKOFF_MS
    this.backoffUntil.set(source, until)
    console.warn(
      `[release-checker] rate limited by release source ${source} (${context}), backing off until ${new Date(until).toISOString()}`,
    )
  }

  /**
   * 登记本轮检查的源选择结果（source-selection 成功登记，S1/S2/F5 观测面）。
   *
   * probe 观测口径（R1-U1a 接线）：
   * - auto 路径透传 resolver 最近一次排序决策的探测详情（getLastProbeOutcome，
   *   S2 观测面）：executed=true + results（Partial<Record> → SourceProbeRecord[]
   *   映射，basis 取决策通道 via 原值——ProbeSourceOutcome 不含探测手段明细，
   *   决策通道即本次排序依据；缺键源如实缺项不捏造，代理短路下仅 github 键）。
   *   返回 null 为防御性兜底（理论上 auto 必有决策）→ executed=false +
   *   reason 'resolver-internal'。
   * - 显式偏好路径不产生探测决策，维持 executed=false + reason
   *   'explicit-preference'（resolver 对显式偏好将详情重置为 null，语义一致）。
   * tags = 各源 fetch 响应的 latest tag（F5 同步缺失观测面），
   * 该源无响应（失败/退避短路）则缺 key。
   */
  private logSourceSelection(
    pref: UpdateSourcePref,
    order: SourceOrder,
    winner: { source: UpdateSource } | null,
    latestTags: Partial<Record<UpdateSource, string>>,
  ): void {
    let probe: SourceProbeOutcome
    if (pref === 'auto') {
      const outcome = getLastProbeOutcome()
      probe = outcome
        ? {
          executed: true,
          // 白名单过滤：探测结果只登记已知源，未知键丢弃不捏造（防注入，taste 规则要求）
          results: Object.entries(outcome.results)
            .filter(([s]) => KNOWN_UPDATE_SOURCES.includes(s as UpdateSource))
            .map(([s, o]) => ({
              source: s as UpdateSource,
              reachable: o.reachable,
              basis: outcome.via,
            })),
        }
        : { executed: false, reason: 'resolver-internal' }
    } else {
      probe = { executed: false, reason: 'explicit-preference' }
    }
    logSourceSelection({
      order,
      winner: winner?.source ?? null,
      probe,
      tags: latestTags,
    })
  }

  /**
   * 胜出源的 manifest 填充（§4.2⑤ 权威通路）。
   *
   * manifest 直链 = resolveManifestDownloadUrl(胜出源完整 assets)（适配层从
   * browser_download_url 取，by-tag 精确对齐本次 release，无 latest 别名错位竞态）。
   * 仅在至少一个目标平台 asset 缺 sha256 时 fetch manifest（lazy，现状语义）。
   * 解析 Map 扩展为 <name, {sha256, size?}>，size 取值 `API size ?? manifest size`。
   *
   * @returns 填充后的 info；GitCode 路径 manifest 必经失败（直链缺失/fetch 失败/
   *          解析失败/目标资产缺失）返回 null（调用方计该源失败 → 次源）；
   *          GitHub 路径 manifest 失败不阻塞（digest 优先 + API size 兜底，现状语义）
   */
  private async fillManifestForWinner(
    source: UpdateSource,
    release: SourceRelease,
  ): Promise<LatestReleaseInfo | null> {
    const info = buildLatestReleaseInfo(source, release)

    // 仅检查 3 个目标 asset 的 sha256（blockmap 等干扰资产的缺失不影响升级校验）
    const targetAssets = Object.values(info.assets).filter((a): a is ReleaseAsset => a !== undefined)
    const needsManifest = targetAssets.some((a) => a.sha256 === undefined)
    if (!needsManifest) return info

    // manifest 直链取自胜出源 assets 中 manifest.json 的 browser_download_url；
    // 资产缺失（发布同步事故形态）按源归类：GitCode 必经失败，GitHub 不阻塞
    const manifestUrl = resolveManifestDownloadUrl(release.assets)
    if (!manifestUrl) {
      return source === 'gitcode' ? null : info
    }

    const manifestMap = await this.fetchManifest(source, manifestUrl)

    if (source === 'gitcode') {
      // GitCode：manifest 是 sha256/size 唯一来源——fetch 失败或目标资产缺失均不可下载
      if (!manifestMap) return null
      const filled = applyManifestToInfo(info, manifestMap)
      const stillMissing = Object.values(filled.assets).some(
        (a) => a !== undefined && a.sha256 === undefined,
      )
      return stillMissing ? null : filled
    }
    // GitHub：manifest 失败不阻塞（digest 优先掩护 + API size 恒在，下载侧校验兜底）
    return manifestMap ? applyManifestToInfo(info, manifestMap) : info
  }

  /**
   * fetch manifest.json（sha256/size fallback）。
   *
   * manifest 由 CI generate-manifest.sh 生成，结构：
   *   { version, releasedAt, assets: { "<filename>": { sha256, size } } }
   * 失败（网络/超时/解析/404）一律返回 null（不阻塞，按源归类由调用方分派）；
   * GitHub 路径 403/429 额外记录该源 2h 限流退避（两引擎同形态）后同样返回 null；
   * GitCode 路径 403/429 按普通 manifest 失败收口（auth_key 签名直链的 403 = 签名/
   * 权限拒绝，非限流信号，见 closeManifestHttpError）。
   *
   * 通道编排与 latest 同策略：代理优先 + 失败降级直连（引擎降级内嵌 upgradeFetch）。
   *
   * @param manifestUrl manifest 直链（胜出源 assets 的 browser_download_url）
   * @returns Map<filename, {sha256, size?}>；不可用时返回 null
   */
  private async fetchManifest(
    source: UpdateSource,
    manifestUrl: string,
  ): Promise<Map<string, ManifestAssetInfo> | null> {

    // 读代理配置（与适配层 fetchSourceRelease 同源策略）
    const proxyConfig = readProxyConfig()
    const proxyUrl = resolveProxyUrl(proxyConfig)
    const useProxy = proxyUrl !== undefined

    try {
      // 第一次尝试：代理优先
      return await this.doFetchManifest(source, manifestUrl, useProxy ? proxyUrl : undefined)
    } catch (err) {
      // 403/429 重建的限流信号（仅 GitHub 路径会抛出）——服务器已响应，不触发通道
      // 维度直连重试，记该源退避窗口后按 manifest 失败收口（null → 由调用方按源归类）
      if (err instanceof ReleaseRateLimitedError) {
        this.recordRateLimitBackoff(source, 'manifest')
        return null
      }
      // 网络错误
      if (useProxy) {
        // 降级直连重试
        try {
          return await this.doFetchManifest(source, manifestUrl, undefined)
        } catch (directErr) {
          // 直连重试撞 403/429：就地记退避后收口 null——此处不能 rethrow（本 catch 位于
          // 外层 catch 块内，rethrow 会直接冒泡出 fetchManifest，破坏「manifest 失败由
          // 调用方按源归类」契约），退避必须在此记录
          if (directErr instanceof ReleaseRateLimitedError) {
            this.recordRateLimitBackoff(source, 'manifest direct')
          }
          return null
        }
      }
      return null
    }
  }

  /**
   * 执行单次 fetch manifest.json（经 upgradeFetch 双引擎）。
   *
   * @param source 所属源（403/429 分派依据：仅 GitHub 记限流信号）
   * @param manifestUrl manifest 直链（胜出源 assets 的 browser_download_url）
   * @param proxyUrl 代理 URL；undefined 表示直连
   * @returns Map<filename, {sha256, size?}>；
   *          HTTP 错误返回 null（GitHub 403/429 除外——undici ok:false 与 curl exit 22
   *          携带 httpStatusCode 两形态同抛 ReleaseRateLimitedError，D8 两引擎无漂移）；
   *          网络错误抛出（供降级逻辑捕获）
   */
  private async doFetchManifest(
    source: UpdateSource,
    manifestUrl: string,
    proxyUrl?: string,
  ): Promise<Map<string, ManifestAssetInfo> | null> {
    try {
      const result = await upgradeFetch(manifestUrl, {
        proxyUrl,
        timeoutMs: FETCH_TIMEOUT_MS,
      })
      if (!result.ok) {
        return closeManifestHttpError(source, result.status)
      }
      return parseManifestAssets(result.bodyText)
    } catch (err) {
      // 限流信号直通（undici !ok 分支在 try 内 throw，若无此保护会被下方包装成
      // 'fetch failed' 网络错误吞掉退避语义——与适配层 doFetchSourceRelease 同款首行守卫）
      if (err instanceof ReleaseRateLimitedError) throw err
      // D8 curl 引擎 HTTP 状态交互规则：携带 httpStatusCode 的 CurlFetchError = 服务器
      // 已响应——GitHub 403/429 重建限流信号供外层记退避且不触发直连重试；404/5xx 与
      // GitCode 403/429 按 manifest null 语义收口（同样不触发直连重试）
      if (isCurlHttpStatusError(err)) {
        return closeManifestHttpError(source, err.httpStatusCode)
      }
      // 网络错误（含不带 httpStatusCode 的 CurlFetchError——双引擎均网络失败）与
      // 非法 JSON 均抛出，供调用方做通道维度降级
      throw new Error('fetch failed')
    }
  }
}

/**
 * manifest HTTP 错误状态分流（两引擎同款，D8 无漂移）：GitHub 403/429 重建
 * ReleaseRateLimitedError（外层记该源退避）；GitCode 403/429 与其他 HTTP 错误
 * 按普通 manifest null 语义收口（不记限流退避）。
 *
 * 按源分派的依据（§4.1）：「403 = 限流/配额拒绝」前提仅在 GitHub 域成立（60 次/h
 * 匿名配额 + X-RateLimit-* 头）；GitCode manifest 直链落 file-cdn.gitcode.com 的
 * auth_key 签名 URL，403 = 签名/权限拒绝而非限流——误记 2h 退避会使国内主场景
 * （GitCode 优先）的后续检查被短路降级。GitCode 的失败由该源失败降级兜底。
 */
function closeManifestHttpError(source: UpdateSource, status: number): null {
  if (
    source === 'github' &&
    (status === HTTP_STATUS_FORBIDDEN || status === HTTP_STATUS_TOO_MANY_REQUESTS)
  ) {
    throw new ReleaseRateLimitedError()
  }
  return null
}

/**
 * 解析 manifest.json 响应体为 Map<filename, {sha256, size?}>（多源扩展：size 透传）。
 *
 * 结构非法（无 assets / 空 map）返回 null；body 非法 JSON 时 JSON.parse 原样
 * 上抛（由调用方 catch 包装网络错误，对齐既有语义）。
 */
function parseManifestAssets(bodyText: string | undefined): Map<string, ManifestAssetInfo> | null {
  const manifest = JSON.parse(bodyText ?? '') as {
    assets?: Record<string, { sha256?: unknown; size?: unknown }>
  }
  const assetsMap = manifest?.assets
  if (!assetsMap || typeof assetsMap !== 'object') return null
  const map = new Map<string, ManifestAssetInfo>()
  for (const [name, info] of Object.entries(assetsMap)) {
    const sha = info?.sha256
    if (typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha)) {
      map.set(name, {
        sha256: sha,
        size: typeof info?.size === 'number' && Number.isFinite(info.size) ? info.size : undefined,
      })
    }
  }
  return map.size > 0 ? map : null
}

/**
 * 把 manifest 条目回填到 LatestReleaseInfo 的目标平台 asset：
 * sha256 取 `asset.sha256 ?? manifest.sha256`（digest 优先，现状语义）；
 * size 取 `API size ?? manifest size`（GitCode 无 API size，size 全靠 manifest，§6.2）。
 */
function applyManifestToInfo(
  info: LatestReleaseInfo,
  manifestMap: Map<string, ManifestAssetInfo>,
): LatestReleaseInfo {
  const patch = (asset?: ReleaseAsset): ReleaseAsset | undefined => {
    if (!asset) return asset
    const entry = manifestMap.get(asset.name)
    if (!entry) return asset
    return {
      ...asset,
      sha256: asset.sha256 ?? entry.sha256,
      size: asset.size ?? entry.size,
    }
  }
  return {
    ...info,
    assets: {
      macArm64Dmg: patch(info.assets.macArm64Dmg),
      winX64Exe: patch(info.assets.winX64Exe),
      linuxX64AppImage: patch(info.assets.linuxX64AppImage),
    },
  }
}
