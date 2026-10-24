/**
 * WoolExtensionInstaller — 羊毛 pi 扩展成员的安装编排薄模块（provider-plugin-access D6）。
 *
 * 羊毛是双产物形态：taiji 插件（管理动作，装 pluginsDir）+ pi 扩展（registerProvider /
 * streamSimple，装 pi 扩展目录才能被会话加载）。后者必须由宿主安装——插件沙箱的 fs
 * 只读（D3），装不了。本模块承接宿主侧编排：
 *
 *   v2-plugins.json 清单条目的配对版本（piExtensionVersion，配对唯一权威）
 *     → 拉取 wool-manifest 资产清单（热更新通道保留，只承载资产解析）
 *     → 版本配对校验（清单版本 ≠ 配对版本 → VERSION_PAIR_MISMATCH 拒绝，不落半成品）
 *     → extensionService.installExtension 钉版本安装（npm + 校验 + 回滚全既有链）
 *     → 扫描校验（安装链成功但扫描未见 = 状态异常，如实报不假装成功）
 *
 * 版本配对权威 = v2-plugins.json（D6：两清单分属两仓、都走热更新通道，配对权威必须
 * 只有一份，否则版本漂移不可归因）；wool-manifest（tai-ji-plugin 仓发布）只承载资产
 * 解析。清单热更新后重试自愈。
 *
 * 错误分级（分级即错误处理契约）：安装是核心链 fail-fast 结构化错误（code + 中文恢复
 * 指引）；无辅助链（本模块全部方法都是显式动作编排，无降级路径）。
 */

/** 资产清单发布权威源（tai-ji-plugin 仓 GitHub release 最新版资产）。 */
export const DEFAULT_WOOL_MANIFEST_URL =
  'https://github.com/zhushanwen321/tai-ji-plugin/releases/latest/download/wool-manifest.json'
/** gitcode 镜像仓 releases 匿名 API（国内备源通道第一跳）。 */
const GITCODE_RELEASES_API_URL =
  'https://api.gitcode.com/api/v5/repos/qq_18433817/tai-ji-plugin/releases?per_page=5'
/** gitcode release assets 中承载清单的文件名（发布流程契约）。 */
const GITCODE_MANIFEST_ASSET_NAME = 'wool-manifest.json'
/** 清单拉取超时（控制范围单请求粒度，红线 19：秒级；双通道下每个请求独立计时）。 */
const MANIFEST_FETCH_TIMEOUT_MS = 10_000

/** 家族 id 词表（与 pi-wool-shared types.ts WOOL_FAMILY_IDS 对齐）。 */
export const WOOL_FAMILY_IDS = ['qoder', 'trae', 'workbuddy'] as const
export type WoolFamilyId = (typeof WOOL_FAMILY_IDS)[number]

/** v2-plugins.json 清单条目包名 → 家族 id（`@scope/plugin-wool-<family>` → family）。 */
export function woolFamilyFromCatalogPackageName(packageName: string): WoolFamilyId | undefined {
  const slash = packageName.indexOf('/')
  const withoutScope = slash >= 0 ? packageName.slice(slash + 1) : packageName
  const PREFIX = 'plugin-wool-'
  if (!withoutScope.startsWith(PREFIX)) return undefined
  const family = withoutScope.slice(PREFIX.length)
  return (WOOL_FAMILY_IDS as readonly string[]).includes(family) ? (family as WoolFamilyId) : undefined
}

/** 凭据来源两值（家族固有属性，清单承载）。 */
export type WoolCredentialsSource = 'ide-extract' | 'oauth'

/** 清单内单家族条目：安装钉版本 + 展示元数据。 */
export interface WoolManifestFamily { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  /** npm 包名（含 scope，如 `@zhushanwen/pi-wool-qoder`）。 */
  pkg: string
  /** 钉定版本（semver 字面量；安装命令 `npm:<pkg>@<version>`）。 */
  version: string
  /** 完整性散列（预留字段：`<alg>:<hex>` 形态；安装链以 npm registry integrity 为准）。 */
  integrity?: string
  /** 家族显示名。 */
  displayName: string
  /** 厂商标注。 */
  vendor: string
  /** 凭据来源。 */
  credentialsSource: WoolCredentialsSource
  /** 风险文案。 */
  riskNotice: string
}

/** 资产清单 JSON 顶层 schema（远端清单拉取的形状契约；schemaVersion 升版 = 结构演进）。 */
export interface WoolAssetManifest { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  schemaVersion: 1
  /** 清单生成时点（Unix ms，观测字段）。 */
  generatedAt: number
  families: Partial<Record<WoolFamilyId, WoolManifestFamily>>
}

/** 清单拉取结果：ok = 已校验清单；失败 = 结构化原因（阻断重试，不降级直装）。 */
export type WoolManifestFetchResult =
  | { ok: true; manifest: WoolAssetManifest; fetchedAt: number }
  | { ok: false; error: { code: 'unreachable' | 'bad_shape'; message: string } }

/** 清单结构守卫（读侧不信任远端；坏形状 = 清单损坏，重试无意义时提示检查发布通道）。 */
export function isWoolAssetManifest(value: unknown): value is WoolAssetManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return false
  if (typeof record.generatedAt !== 'number') return false
  if (typeof record.families !== 'object' || record.families === null || Array.isArray(record.families)) return false
  return Object.values(record.families).every((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const family = entry as Record<string, unknown>
    return (
      typeof family.pkg === 'string' && family.pkg.length > 0 &&
      typeof family.version === 'string' && family.version.length > 0 &&
      typeof family.displayName === 'string' && typeof family.vendor === 'string' &&
      (family.credentialsSource === 'ide-extract' || family.credentialsSource === 'oauth') &&
      typeof family.riskNotice === 'string'
    )
  })
}

/** WoolExtensionInstaller 窄依赖（既有 extension-service 通道，羊毛不新建安装机制）。 */
export interface WoolExtensionInstallerDeps { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  extensionService: {
    scanExtensions(): Promise<Array<{ name: string; version: string; enabled: boolean }>>
    installExtension(source: string): Promise<void>
    uninstallExtension(name: string): Promise<void>
  }
  /** 清单拉取地址（测试 fixture 覆盖）。显式注入 = 单源语义，不进双通道并发。 */
  manifestUrl?: string
  /** 网络出口（测试注入；缺省 globalThis.fetch）。 */
  fetchFn?: typeof fetch
  /** 时钟（测试注入）。 */
  now?: () => number
}

/** 结构化安装错误（code 进调用方错误信封）。 */
export class WoolExtensionInstallError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WoolExtensionInstallError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 清单拉取通道内部结果：通道内任何一步失败都折算为 detail 文案，通道函数不抛出。 */
type ManifestChannelOutcome =
  | { ok: true; raw: unknown }
  | { ok: false; detail: string }

/** gitcode releases API 响应 → 清单资产直链（首个非 prerelease 发布的清单资产）。 */
function pickGitcodeManifestAssetUrl(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const release = (raw as unknown[]).find((entry) => isRecord(entry) && entry.prerelease !== true)
  if (!isRecord(release) || !Array.isArray(release.assets)) return undefined
  const asset = (release.assets as unknown[]).find(
    (entry) => isRecord(entry) && entry.name === GITCODE_MANIFEST_ASSET_NAME,
  )
  const url = isRecord(asset) ? asset.browser_download_url : undefined
  return typeof url === 'string' && url.length > 0 ? url : undefined
}

/** get_entries 响应域内收窄先例同款：allSettled rejected 理论不可达，仍折算通道失败。 */
function settledChannelOutcome(result: PromiseSettledResult<ManifestChannelOutcome>): ManifestChannelOutcome {
  return result.status === 'fulfilled' ? result.value : { ok: false, detail: String(result.reason) }
}

/** 家族 → pi 扩展 npm 包名（与发布侧包名公式一致）。 */
function woolExtensionPkgName(family: WoolFamilyId): string {
  return `@zhushanwen/pi-wool-${family}`
}

/**
 * 版本配对不一致错误码（D6：v2-plugins.json 配对权威与 wool-manifest 资产版本不一致
 * 时安装拒绝，不落半成品；清单热更新后重试自愈）。
 */
export const VERSION_PAIR_MISMATCH = 'VERSION_PAIR_MISMATCH'

export class WoolExtensionInstaller {
  private readonly deps: WoolExtensionInstallerDeps
  private readonly now: () => number
  /** 清单内存缓存（成功结果缓存；失败不缓存，下次动作重拉）。 */
  private manifestCache: { manifest: WoolAssetManifest; fetchedAt: number } | undefined

  constructor(deps: WoolExtensionInstallerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * 资产清单拉取（热更新通道保留，只承载资产解析）：github 权威源 + gitcode 国内备源
   * 双通道并发（github 成功恒用 github 结果——镜像存在滞后窗口，先到先得会装旧版）；
   * 显式 manifestUrl = 单源语义。成功结果进内存缓存（同一编排内重复拉取零网络）；
   * `force: true` 跳过缓存强制重拉（版本配对不一致时的时点差自愈通道，D6），
   * 重拉成功后覆盖缓存（新清单即新权威）。
   */
  async fetchManifest(options?: { force?: boolean }): Promise<WoolManifestFetchResult> {
    if (!options?.force && this.manifestCache) {
      return { ok: true, manifest: this.manifestCache.manifest, fetchedAt: this.manifestCache.fetchedAt }
    }
    const fetchFn = this.deps.fetchFn ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init))
    let selected: ManifestChannelOutcome
    if (this.deps.manifestUrl !== undefined) {
      selected = await this.fetchChannelJson(fetchFn, this.deps.manifestUrl)
    } else {
      const [github, gitcode] = await Promise.allSettled([
        this.fetchChannelJson(fetchFn, DEFAULT_WOOL_MANIFEST_URL),
        this.fetchGitcodeChannel(fetchFn),
      ])
      const githubOutcome = settledChannelOutcome(github)
      const gitcodeOutcome = settledChannelOutcome(gitcode)
      if (githubOutcome.ok) {
        selected = githubOutcome
      } else if (gitcodeOutcome.ok) {
        selected = gitcodeOutcome
      } else {
        return {
          ok: false,
          error: {
            code: 'unreachable',
            message: `资产清单不可达（github：${githubOutcome.detail}；gitcode：${gitcodeOutcome.detail}）。请检查网络后重试；清单恢复前不执行安装`,
          },
        }
      }
    }
    if (!selected.ok) {
      return {
        ok: false,
        error: {
          code: 'unreachable',
          message: `资产清单不可达（${selected.detail}）。请检查网络后重试；清单恢复前不执行安装`,
        },
      }
    }
    if (!isWoolAssetManifest(selected.raw)) {
      return { ok: false, error: { code: 'bad_shape', message: '资产清单格式损坏（schema 校验不过）。请稍后重试或检查 taiji 发布通道；清单修复前不执行安装' } }
    }
    this.manifestCache = { manifest: selected.raw, fetchedAt: this.now() }
    return { ok: true, manifest: selected.raw, fetchedAt: this.manifestCache.fetchedAt }
  }

  /** 单 URL JSON GET 通道原语：非 2xx / 网络异常 / JSON 解析失败 → 失败 detail（不抛出）。 */
  private async fetchChannelJson(fetchFn: typeof fetch, url: string): Promise<ManifestChannelOutcome> {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS) })
      if (!response.ok) {
        return { ok: false, detail: `HTTP ${response.status}` }
      }
      return { ok: true, raw: await response.json() }
    } catch (e) {
      return { ok: false, detail: String(e) }
    }
  }

  /** gitcode 国内备源通道（两跳）：releases API 列发布 → 清单资产直链 → 拉取清单。 */
  private async fetchGitcodeChannel(fetchFn: typeof fetch): Promise<ManifestChannelOutcome> {
    const releases = await this.fetchChannelJson(fetchFn, GITCODE_RELEASES_API_URL)
    if (!releases.ok) return releases
    const assetUrl = pickGitcodeManifestAssetUrl(releases.raw)
    if (assetUrl === undefined) {
      return { ok: false, detail: 'releases 响应结构不符或缺 wool-manifest.json 资产' }
    }
    return this.fetchChannelJson(fetchFn, assetUrl)
  }

  /**
   * 安装指定家族的 pi 扩展成员（双产物安装编排的扩展侧步骤）。
   *
   * @param family 家族 id
   * @param piExtensionVersion v2-plugins.json 清单条目的配对版本（配对唯一权威，D6）
   * @returns 实际安装并扫描确认的扩展版本
   */
  async installPiExtension(family: WoolFamilyId, piExtensionVersion: string): Promise<{ installedVersion: string }> {
    const fetched = await this.fetchManifest()
    if (!fetched.ok) {
      throw new WoolExtensionInstallError(fetched.error.code, fetched.error.message)
    }
    const entry = fetched.manifest.families[family]
    if (!entry) {
      throw new WoolExtensionInstallError('family_absent', `资产清单中没有 ${family} 家族条目。请升级 taiji 或等待清单更新后重试`)
    }
    if (entry.version !== piExtensionVersion) {
      // 时点差自愈（D6）：内存缓存可能落后于热更新后的远端清单——绕过缓存强制重拉
      // 一次再判；重拉后配对一致 = 时点差已收敛，用刷新条目继续安装（用户一次重试
      // 即自愈）；重拉失败或仍不一致 = 配对不一致成立，拒绝并保留恢复指引。
      const refetched = await this.fetchManifest({ force: true })
      if (refetched.ok) {
        const refreshed = refetched.manifest.families[family]
        if (refreshed && refreshed.version === piExtensionVersion) {
          return this.installEntry(refreshed)
        }
      }
      throw new WoolExtensionInstallError(
        VERSION_PAIR_MISMATCH,
        `插件与扩展版本不匹配：清单配对要求 pi 扩展 ${woolExtensionPkgName(family)}@${piExtensionVersion}，` +
          `资产清单当前为 @${entry.version}。请稍后重试（清单热更新后自愈）；持续出现请等待清单维护方修复配对`,
      )
    }
    return this.installEntry(entry)
  }

  /**
   * 从 v2-plugins.json 清单条目出发的安装编排（PluginService.confirmPluginInstall 成功
   * 后的接线入口，U7 双产物安装编排）：包名推导家族（`@scope/plugin-wool-<family>`）
   * → 复用 installPiExtension 的配对校验与钉版安装。条目携带 piExtensionVersion 即
   * 双产物条目（plugin-catalog guard 契约）；包名非 plugin-wool-* 形态 = 清单指向
   * 未知家族，结构化拒绝——静默跳过 = 扩展缺失、对话链断链复发。
   */
  async installForCatalogEntry(entry: { packageName: string; piExtensionVersion: string }): Promise<{ installedVersion: string }> {
    const family = woolFamilyFromCatalogPackageName(entry.packageName)
    if (!family) {
      throw new WoolExtensionInstallError(
        'family_unknown',
        `清单条目 ${entry.packageName} 携带 piExtensionVersion 但包名不含 plugin-wool- 前缀，` +
          '无法推导 pi 扩展家族。请检查 v2-plugins.json 清单条目',
      )
    }
    return this.installPiExtension(family, entry.piExtensionVersion)
  }

  /** 钉版本安装 + 扫描确认（installPiExtension 正常路径与时点差自愈路径共用段）。 */
  private async installEntry(entry: WoolManifestFamily): Promise<{ installedVersion: string }> {
    // 钉版本安装（npm + isValidPiExtension 校验 + 失败回滚全在既有链内）。
    await this.deps.extensionService.installExtension(`npm:${entry.pkg}@${entry.version}`)
    const extensions = await this.deps.extensionService.scanExtensions()
    const match = extensions.find((ext) => ext.name === entry.pkg)
    if (!match || !match.enabled) {
      throw new WoolExtensionInstallError(
        'install_failed',
        `扩展 ${entry.pkg}@${entry.version} 安装命令已执行但未在扩展列表中发现，请重试或查看扩展管理页`,
      )
    }
    return { installedVersion: match.version }
  }

  /**
   * 卸载指定家族的 pi 扩展成员（双产物卸载编排的扩展侧步骤；与 taiji 插件卸载编排
   * 的调用契约 = 编排方自行保证插件侧清理先行，本方法只管扩展目录侧）。
   */
  async uninstallPiExtension(family: WoolFamilyId): Promise<void> {
    try {
      await this.deps.extensionService.uninstallExtension(woolExtensionPkgName(family))
    } catch (e) {
      throw new WoolExtensionInstallError(
        'uninstall_failed',
        `扩展卸载失败：${String(e)}。请到扩展管理页重试卸载`,
      )
    }
  }

  /** 查询指定家族 pi 扩展的已装状态（已装 = enabled 且版本已知；未装 = undefined）。 */
  async scanInstalledVersion(family: WoolFamilyId): Promise<string | undefined> {
    const extensions = await this.deps.extensionService.scanExtensions()
    const match = extensions.find((ext) => ext.name === woolExtensionPkgName(family))
    return match !== undefined && match.enabled ? match.version : undefined
  }
}
