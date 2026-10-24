/**
 * 插件清单域 service（provider-plugin-access U5）：v2-plugins.json 清单的加载、guard
 * （含双产物版本配对校验）与本地已装版本比对。
 *
 * 清单定位：可安装插件的发现通道（浏览 + 一键安装 + 家族元数据），不是白名单、
 * 不做安全审核——用户仍可直接输入包名安装。本模块只交付 service 层；RPC 通路
 * （plugin.listAvailable / plugin.catalog 的接线）归 u-protocol（复审 F3 裁决）。
 *
 * fail-safe 链对齐 remote-config 基建（远程 → 上次缓存 → 无缓存报错）；本域不设
 * 编译期基线（清单消费方是 Provider 页家族卡，无数据时整页报错优于展示过期基线，
 * §4 S15）。双产物版本配对唯一权威 = 清单条目字段（D6）：pluginVersion 与
 * piExtensionVersion 成对钉定，任一缺失/损坏 → guard 整体拒用（VERSION_PAIR_MISMATCH），
 * 清单热更新后重试自愈；安装时点与 wool-manifest 资产的版本比对校验归 pi 扩展安装
 * 编排（U7），不在本模块。
 */
import semver from 'semver'
import {
  type PluginCatalogEntry,
  type PluginProviderFamilyMeta,
  type PluginListAvailableReply,
  type PluginCatalogReply,
} from '@taiji/shared'
import {
  loadRemoteConfig,
  refreshRemoteConfig,
  type RemoteConfigDomain,
  type RemoteRefreshOutcome,
} from '../remote-config/remote-config-fetch.js'

/** 远程清单域缓存名（<getDataDir()>/remote-config/v2-plugins.json）。 */
export const PLUGIN_CATALOG_DOMAIN: RemoteConfigDomain = 'v2-plugins'

/** 清单文件版本（schema 不兼容变更时升位，guard 拒绝旧形状）。 */
const CATALOG_VERSION = 1

/** 双产物版本配对字段缺失/损坏的 guard 拒绝码（D6：配对权威字段不可信时整体拒用）。 */
export const VERSION_PAIR_MISMATCH = 'VERSION_PAIR_MISMATCH'

/** 其余形状错误的 guard 拒绝码（字段类型/取值域非法，detail 携带字段路径）。 */
export const CATALOG_INVALID = 'CATALOG_INVALID'

/** 远程清单文件形状（configs/remote/v2-plugins.json；条目形状 = PluginCatalogEntry）。 */
export interface PluginCatalogConfig { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  version: typeof CATALOG_VERSION
  plugins: PluginCatalogEntry[]
}

/** 域 guard 校验结果：拒绝时 code ∈ { VERSION_PAIR_MISMATCH, CATALOG_INVALID }。 */
export type PluginCatalogValidation =
  | { ok: true; config: PluginCatalogConfig }
  | { ok: false; code: typeof VERSION_PAIR_MISMATCH | typeof CATALOG_INVALID; detail: string }

/** 条目级校验结果（无 config 载荷；整体 config 由 validatePluginCatalogConfig 组装）。 */
type CatalogEntryValidation = { ok: true } | { ok: false; code: typeof VERSION_PAIR_MISMATCH | typeof CATALOG_INVALID; detail: string }

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isOptionalNonEmptyString(v: unknown): boolean {
  return v === undefined || isNonEmptyString(v)
}

/** 非负整数（family.modelCount：清单声明值，负数/小数会让家族卡渲染出无意义计数）。 */
function isNonNegativeInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((s) => isNonEmptyString(s))
}

const CREDENTIAL_SOURCES: ReadonlyArray<PluginProviderFamilyMeta['credentialSource']> = ['oauth', 'ide-extract']

function isFamilyMetaValid(f: unknown): boolean {
  if (typeof f !== 'object' || f === null) return false
  const meta = f as Record<string, unknown>
  return (
    isNonEmptyString(meta.id) &&
    isNonEmptyString(meta.displayName) &&
    isNonEmptyString(meta.vendor) &&
    CREDENTIAL_SOURCES.includes(meta.credentialSource as PluginProviderFamilyMeta['credentialSource']) &&
    isNonNegativeInt(meta.modelCount)
  )
}

/**
 * 单条清单条目校验。版本配对字段（pluginVersion / piExtensionVersion）的缺失、空串、
 * 类型非法统一归 VERSION_PAIR_MISMATCH——这两个字段是安装钉版本的唯一权威（D6），
 * 损坏即配对不可信；其余字段形状错误归 CATALOG_INVALID。
 */
function validateCatalogEntry(p: unknown, index: number): CatalogEntryValidation {
  const at = `plugins[${index}]`
  if (typeof p !== 'object' || p === null) {
    return { ok: false, code: CATALOG_INVALID, detail: `${at} is not an object` }
  }
  const entry = p as Record<string, unknown>
  // 版本配对字段：pluginVersion 必填；piExtensionVersion 仅双产物条目携带，出现即必须合法
  if (!isNonEmptyString(entry.pluginVersion)) {
    return { ok: false, code: VERSION_PAIR_MISMATCH, detail: `${at}.pluginVersion must be a non-empty string` }
  }
  if (!isOptionalNonEmptyString(entry.piExtensionVersion)) {
    return { ok: false, code: VERSION_PAIR_MISMATCH, detail: `${at}.piExtensionVersion must be a non-empty string when present` }
  }
  if (!isNonEmptyString(entry.packageName) || !isNonEmptyString(entry.pluginId) || !isNonEmptyString(entry.displayName)) {
    return { ok: false, code: CATALOG_INVALID, detail: `${at}.packageName/pluginId/displayName must be non-empty strings` }
  }
  if (!isOptionalNonEmptyString(entry.description)) {
    return { ok: false, code: CATALOG_INVALID, detail: `${at}.description must be a string when present` }
  }
  if (entry.family !== undefined && !isFamilyMetaValid(entry.family)) {
    return { ok: false, code: CATALOG_INVALID, detail: `${at}.family has invalid fields` }
  }
  if (entry.capabilities !== undefined && !isStringArray(entry.capabilities)) {
    return { ok: false, code: CATALOG_INVALID, detail: `${at}.capabilities must be a string array when present` }
  }
  if (entry.readPaths !== undefined && !isStringArray(entry.readPaths)) {
    return { ok: false, code: CATALOG_INVALID, detail: `${at}.readPaths must be a string array when present` }
  }
  return { ok: true }
}

/**
 * 清单文件整体校验（带原因：guard 拒绝的可观测面——remote-config-fetch 只记通用
 * warn，域内具体拒绝码经本函数暴露给日志与测试断言）。任一条目非法 = 整体拒用，
 * 不部分采纳（与 remote-config 域 guard 同纪律：坏配置最坏后果是停留在上次可用数据）。
 */
export function validatePluginCatalogConfig(v: unknown): PluginCatalogValidation {
  if (typeof v !== 'object' || v === null) {
    return { ok: false, code: CATALOG_INVALID, detail: 'catalog is not an object' }
  }
  const body = v as Record<string, unknown>
  if (body.version !== CATALOG_VERSION) {
    return { ok: false, code: CATALOG_INVALID, detail: `version must be ${CATALOG_VERSION}` }
  }
  if (!Array.isArray(body.plugins)) {
    return { ok: false, code: CATALOG_INVALID, detail: 'plugins must be an array' }
  }
  for (let i = 0; i < body.plugins.length; i++) {
    const entryResult = validateCatalogEntry(body.plugins[i], i)
    if (!entryResult.ok) return entryResult
  }
  return {
    ok: true,
    config: { version: CATALOG_VERSION, plugins: body.plugins as PluginCatalogEntry[] },
  }
}

/** 形状 guard（喂给 remote-config fetch 链的类型收窄入口；原因诊断走 validatePluginCatalogConfig）。 */
export function isPluginCatalogConfig(v: unknown): v is PluginCatalogConfig {
  return validatePluginCatalogConfig(v).ok
}

/** 清单读取结果：config undefined = 无缓存且拉取失败（UI 整页报错，S15②）。 */
export interface PluginCatalogLoadResult { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  config: PluginCatalogConfig | undefined
  /** 缓存兜底生效（数据可能过期 → UI 显示「清单可能不是最新」提示，S15①）。 */
  stale: boolean
  reason?: RemoteRefreshOutcome<unknown>['reason']
}

/**
 * 本地已装条目（S15② 本地回退的数据源，R-2 裁决 2026-10-24）：清单不可达时
 * listAvailable 用已装插件构造条目，renderer 按 namespace 前缀识别插件条目——
 * 「重新授权 / 更新插件」入口不随清单故障消失（S15「已装 provider 的管理不受影响」，
 * D5 目标 3）。事实源 = registry descriptor（scan 唯一装配点）。
 */
export interface CatalogInstalledEntry { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  pluginId: string
  displayName: string
  packageName: string
  pluginVersion: string
  /** manifest 声明命名空间（provider 插件才有；renderer 条目第二识别源） */
  namespace?: string
}

/**
 * 已装条目 → 可安装视图条目（installed=true；无清单基线，不带 updateAvailable——
 * 版本比对需要清单版本，清单不可达时不猜测，S26 更新提示等待清单恢复）。
 */
export function installedEntriesToCatalogEntries(
  entries: ReadonlyArray<CatalogInstalledEntry>,
): PluginListAvailableReply['plugins'] {
  return entries.map((entry) => ({
    packageName: entry.packageName,
    pluginId: entry.pluginId,
    displayName: entry.displayName,
    pluginVersion: entry.pluginVersion,
    ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
    installed: true,
    installedVersion: entry.pluginVersion,
  }))
}

/** PluginRegistry descriptors → 本地已装条目（S15② 回退数据源；与 installedVersionsFromDescriptors 同构的装配纯函数）。 */
export function installedEntriesFromDescriptors(
  descriptors: ReadonlyArray<{ pluginId: string; displayName: string; version: string; packageName?: string; namespace?: string }>,
): CatalogInstalledEntry[] {
  return descriptors.map((d) => ({
    pluginId: d.pluginId,
    displayName: d.displayName,
    packageName: d.packageName ?? d.pluginId,
    pluginVersion: d.version,
    ...(d.namespace !== undefined ? { namespace: d.namespace } : {}),
  }))
}

function toLoadResult(outcome: RemoteRefreshOutcome<PluginCatalogConfig>): PluginCatalogLoadResult {
  // stale = 有数据兜底但本次不是「确认新鲜」路径（节流/304 视为新鲜；网络失败与
  // guard 拒绝意味着远端状态未知，数据可能是过期缓存）
  const stale = outcome.data !== undefined && (outcome.reason === 'network' || outcome.reason === 'invalid')
  return { config: outcome.data, stale, reason: outcome.reason }
}

/** 拉取清单（含节流 / ETag / fail-safe 全语义，透传 refreshRemoteConfig）。 */
export async function refreshPluginCatalog(options?: { force?: boolean }): Promise<PluginCatalogLoadResult> {
  return toLoadResult(await refreshRemoteConfig(PLUGIN_CATALOG_DOMAIN, isPluginCatalogConfig, options))
}

/** 读清单（纯缓存，不发网络）。 */
export function loadPluginCatalog(): PluginCatalogConfig | undefined {
  return loadRemoteConfig(PLUGIN_CATALOG_DOMAIN, isPluginCatalogConfig)
}

/**
 * 本地已装插件版本读侧端口：pluginId → 包内 package.json version（版本唯一事实，
 * D11——PluginRegistry descriptor.version 承载，更新比对直读它，不落第二份）。
 */
export interface PluginInstalledVersionsPort { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  getInstalledVersions(): Promise<ReadonlyMap<string, string>>
}

/** PluginRegistry descriptors → 端口数据（pluginId 匹配键 = descriptor.pluginId，目录名权威）。 */
export function installedVersionsFromDescriptors(
  descriptors: ReadonlyArray<{ pluginId: string; version: string }>,
): ReadonlyMap<string, string> {
  return new Map(descriptors.map((d) => [d.pluginId, d.version]))
}

/**
 * 清单版本 > 已装版本（S26「更新插件」动作数据源）。任一侧非合法 semver 不比较
 * （返回 false 不猜测）——清单或插件包版本字段损坏时静默不提示更新，不误装。
 */
function isUpdateAvailable(catalogVersion: string, installedVersion: string): boolean {
  const catalog = semver.valid(catalogVersion)
  const installed = semver.valid(installedVersion)
  return catalog !== null && installed !== null && semver.gt(catalog, installed)
}

/** 清单条目 ⊕ 本地已装版本 → 可安装视图（plugin.listAvailable reply 的组装纯函数）。 */
export function listAvailablePlugins(
  plugins: ReadonlyArray<PluginCatalogEntry>,
  installedVersions: ReadonlyMap<string, string>,
): PluginListAvailableReply {
  return {
    plugins: plugins.map((entry) => {
      const installedVersion = installedVersions.get(entry.pluginId)
      if (installedVersion === undefined) {
        return { ...entry, installed: false }
      }
      return {
        ...entry,
        installed: true,
        installedVersion,
        ...(isUpdateAvailable(entry.pluginVersion, installedVersion) ? { updateAvailable: true } : {}),
      }
    }),
  }
}

/** plugin.catalog reply（清单原始目录条目，含家族元数据）。 */
export function toCatalogReply(config: PluginCatalogConfig): PluginCatalogReply {
  return { entries: config.plugins }
}

/**
 * 插件清单 service：清单加载与本地安装状态比对的编排入口（RPC 接线归 u-protocol，
 * 复审 F3）。registry 依赖走端口注入，不与 PluginRegistry 实现耦合。
 * getInstalledEntries（可选）= S15② 本地回退数据源；缺省时 available=false 的
 * reply 为空清单（单测与旧装配形态）。
 */
export class PluginCatalogService implements PluginInstalledVersionsPort {
  private readonly deps: PluginInstalledVersionsPort & {
    getInstalledEntries?: () => Promise<ReadonlyArray<CatalogInstalledEntry>>
  }

  constructor(deps: PluginInstalledVersionsPort & { getInstalledEntries?: () => Promise<ReadonlyArray<CatalogInstalledEntry>> }) {
    this.deps = deps
  }

  getInstalledVersions(): Promise<ReadonlyMap<string, string>> {
    return this.deps.getInstalledVersions()
  }

  /** 拉取清单（fail-safe 链语义见 PluginCatalogLoadResult）。 */
  async load(options?: { force?: boolean }): Promise<PluginCatalogLoadResult> {
    return refreshPluginCatalog(options)
  }

  /** reply 本体的拉取元数据（S15①② renderer 两态呈现的数据源，R-2 裁决）。 */
  private replyMeta(load: PluginCatalogLoadResult): Pick<PluginListAvailableReply, 'available' | 'stale' | 'reason'> {
    return {
      available: load.config !== undefined,
      stale: load.stale,
      ...(load.reason !== undefined ? { reason: load.reason } : {}),
    }
  }

  /** plugin.catalog：清单原始目录条目（available/stale/reason 语义与 listAvailable 对齐）。 */
  async catalog(options?: { force?: boolean }): Promise<{
    reply: PluginCatalogReply
    available: boolean
    stale: boolean
    reason?: RemoteRefreshOutcome<unknown>['reason']
  }> {
    const load = await this.load(options)
    // 回退条目复用 listAvailable 的组装（installed/installedVersion 形态），本 reply
    // 契约是裸 PluginCatalogEntry——剥掉声明外字段（D6 B4：wire 形状与声明一致）
    const entries = load.config !== undefined
      ? load.config.plugins
      : (await this.installedFallbackEntries()).map(({ installed: _installed, installedVersion: _v, ...entry }) => entry)
    return {
      reply: { entries, ...this.replyMeta(load) },
      available: load.config !== undefined,
      stale: load.stale,
      reason: load.reason,
    }
  }

  /**
   * plugin.listAvailable：可安装视图（附本地安装状态比对）。
   * available=false（无缓存且拉取失败）时 reply 携带本地已装条目回退（S15②：管理
   * 入口不随清单故障消失）；回退条目不带 updateAvailable（无清单基线，不猜测）。
   */
  async listAvailable(options?: { force?: boolean }): Promise<{
    reply: PluginListAvailableReply
    available: boolean
    stale: boolean
    reason?: RemoteRefreshOutcome<unknown>['reason']
  }> {
    // 顺序 await（非 Promise.all）：两源语义不独立——installedVersions 是比对组装的必需
    // 输入，部分降级会渲染出「全部未安装」的误导视图；load 恒不 reject（fail-safe 链），
    // 端口 reject 时整体失败由调用方按 RPC 错误处置
    const load = await this.load(options)
    const installedVersions = await this.getInstalledVersions()
    const plugins = load.config !== undefined
      ? listAvailablePlugins(load.config.plugins, installedVersions).plugins
      : await this.installedFallbackEntries()
    return {
      reply: { plugins, ...this.replyMeta(load) },
      available: load.config !== undefined,
      stale: load.stale,
      reason: load.reason,
    }
  }

  /** 本地已装条目回退（S15②）：端口缺失 → 空清单（旧装配形态，单测常态）。 */
  private async installedFallbackEntries(): Promise<PluginListAvailableReply['plugins']> {
    if (this.deps.getInstalledEntries === undefined) return []
    return installedEntriesToCatalogEntries(await this.deps.getInstalledEntries())
  }
}
