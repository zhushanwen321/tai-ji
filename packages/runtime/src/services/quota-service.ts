/**
 * QuotaService — Coding Plan 额度查询核心服务。
 *
 * 职责：
 * - hover 触发查询（quota.fetch RPC）
 * - 缓存管理（成功更新，失败返回失败态 data=null + reason；旧缓存保留内存可经 getCached 查看）
 * - 并发保护（pending Map 复用 Promise）
 * - 最小间隔保护（10s throttle）
 * - 凭证读取（api-key 按 credentialSource 解析（D3）：exclusive 只读专属 Key 文件，
 *   provider 跳过专属文件经 providerCredentialResolver：auth.json → models.json；
 *   cookie 从 secrets 文件）
 *
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md §2.2.3
 * 交互重构（D3/D12）：docs/design/coding-plan-quota-config-ux.md §7.3
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { NormalizedQuotaRow, ProviderQuotaFetcher, QuotaAuthKind, QuotaCredentialSource, QuotaConfigurePayload, QuotaFetchFailureReason, QuotaFetcherConfig } from '@xyz-agent/shared'
import { matchQuotaPreset, normalizeQuotaWorkspaceUrl, resolveQuotaCredentialSource, supportsExclusiveCredential } from '@xyz-agent/shared'
import { QUOTA_FETCHERS } from './quota-providers/index.js'
import { QuotaCache } from './quota-cache.js'
import { getProviderConfig } from '../infra/pi/pi-provider-store.js'
import { logger } from '../infra/logger.js'
import { getDataDir } from '@xyz-agent/shared/paths'
import type { XyzProviderStore, ProviderExtras } from './provider-extras-store.js'
import { readExtrasWithFallback } from './migration/provider-extras-migration.js'
import type { Credential } from './auth/auth-storage.js'
import type { ConfigProviderConfig } from './ports/config.js'
import type { IProviderCredentialResolver } from './ports/provider-credential-resolver.js'
import { toErrorMessage } from '../utils/errors.js'

/** 最小查询间隔（毫秒） */
const THROTTLE_MS = 10_000

/** secret 文件权限：仅属主可读写（W4） */
const SECRET_FILE_MODE = 0o600
/** secrets 目录权限：仅属主可读写执行（W4） */
const SECRET_DIR_MODE = 0o700

/** ProviderInfo 的最小子集（matchQuotaPreset 只需 baseUrl/name + quota 凭证来源解析所需字段）。 */
export interface ProviderInfoLike {
  baseUrl?: string
  name?: string
  /** 用户手动指定的 fetcher id（优先于 matchQuotaPreset）。 */
  quota?: {
    fetcher?: string
    /**
     * 凭证来源（D3，§7.1）。未设置 = resolveQuotaCredentialSource 按 apiKeySet 推断
     * （兼容历史数据：apiKeySet=true → exclusive，否则 provider）。
     */
    credentialSource?: QuotaCredentialSource
    /** 专属 Key 已写入 secrets 的标记（credentialSource 的推断锚点，§7.1）。 */
    apiKeySet?: boolean
  }
}

/** 从 providerId 解析 ProviderInfo（baseUrl/name）的回调。 */
export type ProviderInfoResolver = (providerId: string) => ProviderInfoLike | undefined

export interface QuotaFetchResult {
  data: NormalizedQuotaRow | null
  lastFetchAt: number | null
  /**
   * 最近一次查询失败原因（A2-4）。查询失败（data=null 失败态）或内存中记录着上次
   * 失败（getCached，供 UI 失败态 + 「查看上次成功数据」入口）时出现；成功后清除。
   * 展示语义（§3.4）：失败时 UI 整体替换为失败态，旧缓存数据保留内存不展示。
   */
  reason?: QuotaFetchFailureReason
}

export interface QuotaConfigureResult {
  ok: boolean
  error?: string
}

/**
 * provider 已在聚合层不存在（删除链已执行）——persist 的存在性守卫异常（§7.3 改动 2）。
 * 在 extrasStore.modify 回调内抛出：modify 只在回调正常返回后才写盘，回调抛错则整个
 * 写入被跳过（读-判-写与删除链的 extrasStore.delete 在同一临界区）。
 */
class ProviderGoneError extends Error {
  constructor(providerId: string) {
    super(`provider not found in aggregated provider list: ${providerId}`)
    this.name = 'ProviderGoneError'
  }
}

export interface QuotaServiceOptions {
  /** 数据目录（默认 getDataDir()）。 */
  dataDir?: string
  /**
   * 从 providerId 解析 ProviderInfo（baseUrl/name），用于 matchQuotaPreset 匹配 fetcher。
   * 默认实现返回 undefined（无法匹配，仅当 providerId 恰好等于 fetcher id 时命中）。
   */
  getProviderInfo?: ProviderInfoResolver
  /**
   * providers.json 存储（A1-5 写侧切换）：quota 配置持久化落 config/providers.json，
   * 不再经 upsertProvider 写 pi models.json（寄生字段禁复活）。
   * 未注入时 configure 的持久化失败返回（宁失败不写错位）。
   */
  providerExtrasStore?: XyzProviderStore
  /**
   * provider 聚合层存在性判定（catalog ∪ custom）：quota 绑定不再依赖 models.json
   * 条目存在（场景 E：oauth-only catalog provider 在 models.json 无条目），改为查
   * provider 聚合。默认回退 models.json 条目判定（保守，向后兼容未注入场景）。
   */
  providerExists?: (providerId: string) => boolean
  /**
   * auth.json 凭证读取通道（A2-2）：api-key 形态的第二优先级来源
   * （credential(api_key).key）与 oauth 形态的唯一来源（credential(oauth).access）。
   * 生产注入 AuthService.getCredential（直读不缓存——pi 侧 refresh 写回后必须能立即
   * 读到新值，D6）。未注入时跳过 auth.json 来源（保守，向后兼容）。
   */
  getAuthCredential?: (providerId: string) => Promise<Credential | undefined>
  /**
   * models.json 单 provider 条目读取通道（round 1 review arch-boundary S2 port 化）：
   * providerExists 默认回退与 readQuotaFallback 的 legacy quota 兜底经此读，
   * 消除新增代码路径的 services → infra 直连。生产注入 configStore.getProviderConfig
   * （PiConfigStore 委托同一 infra 函数，读同一文件同一解析，行为等价）。
   * 未注入时回退 infra 模块函数（保持既有单测的模块 mock 体系与未注入行为不变）。
   */
  getProviderConfig?: (providerId: string) => ConfigProviderConfig | undefined
  /**
   * Provider 凭据解析唯一通道（D3 收口，链 1 消费点）：api-key 形态的
   * auth.json / models.json 两段统一走 resolver（auth.json → models.json，源优先级单点声明）；
   * secrets 专属 key 段仍优先（Coding Plan 专属语义，不属于 provider 凭据）。
   * 构造必需（M2fg 收口：生产组合根恒注入，降级内联链已删除）。
   * resolver 构造无 IO、读取懒发生——无缓存语义变化（原实现同样每次调用即读盘）。
   */
  providerCredentialResolver: IProviderCredentialResolver
}

export class QuotaService {
  private cache: QuotaCache
  /** providerId → pending Promise（并发保护） */
  private pending: Map<string, Promise<QuotaFetchResult>> = new Map()
  /** providerId → 上次查询时间戳（throttle） */
  private lastFetchTime: Map<string, number> = new Map()
  /** cookie 文件目录 */
  private secretsDir: string
  /** 从 providerId 解析 ProviderInfo 的回调 */
  private getProviderInfo: ProviderInfoResolver
  /** providers.json 存储（quota 配置持久化落点，A1-5 写侧切换） */
  private extrasStore: XyzProviderStore | undefined
  /** provider 聚合层存在性判定 */
  private providerExists: (providerId: string) => boolean
  /** auth.json 凭证读取通道（A2-2，生产注入 AuthService.getCredential） */
  private getAuthCredential: ((providerId: string) => Promise<Credential | undefined>) | undefined
  /** models.json 单条目读取通道（arch-boundary S2 port 化，生产注入 configStore.getProviderConfig） */
  private getProviderConfigOpt: ((providerId: string) => ConfigProviderConfig | undefined) | undefined
  /** Provider 凭据解析唯一通道（D3 链 1，构造必需） */
  private readonly credentialResolver: IProviderCredentialResolver
  /** providerId → 最近一次查询失败原因（A2-4：getCached 透传；成功清除；不落盘） */
  private lastFailure: Map<string, QuotaFetchFailureReason> = new Map()

  constructor(options: QuotaServiceOptions) {
    const dir = options.dataDir ?? getDataDir()
    this.cache = new QuotaCache(dir)
    this.secretsDir = join(dir, 'secrets')
    this.getProviderInfo = options.getProviderInfo ?? (() => undefined)
    this.extrasStore = options.providerExtrasStore
    this.getProviderConfigOpt = options.getProviderConfig
    this.credentialResolver = options.providerCredentialResolver
    this.providerExists = options.providerExists
      // 保守默认：维持旧限制语义（models.json 有条目才可配置），生产恒注入聚合判定
      ?? ((providerId) => this.readProviderConfig(providerId) !== undefined)
    this.getAuthCredential = options.getAuthCredential
  }

  /**
   * models.json 单条目读取（注入通道优先，未注入回退 infra 模块函数——同一文件同一
   * 解析，行为等价；回退仅为兼容既有未注入单测的模块 mock 体系）。
   */
  private readProviderConfig(providerId: string): ConfigProviderConfig | undefined {
    return this.getProviderConfigOpt
      ? this.getProviderConfigOpt(providerId)
      : getProviderConfig(providerId) as unknown as ConfigProviderConfig | undefined
  }

  /**
   * 查询额度（hover 触发）。
   * - 并发保护：同 provider pending 期间复用 Promise
   * - throttle：10s 内重复 fetch 直接返回缓存
   * - 失败返回失败态（data=null + reason）+ log；旧缓存保留内存可经 getCached 查看
   */
  async fetch(providerId: string): Promise<QuotaFetchResult> {
    return this.runFetch(providerId, { force: false })
  }

  /**
   * 强制查询额度（Settings 测试查询按钮）。
   * - 与 fetch 逻辑相同，但**绕过 throttle**（不检查 lastFetchTime）
   * - 仍走 pending 并发保护（避免同 provider 并发请求）
   * - 失败返回失败态（data=null + reason）+ log；旧缓存保留内存可经 getCached 查看
   */
  async refresh(providerId: string): Promise<QuotaFetchResult> {
    return this.runFetch(providerId, { force: true })
  }

  /**
   * fetch/refresh 共用实现。
   * @param force - true 时绕过 throttle（refresh 用）；false 时检查 10s 最小间隔（fetch 用）
   */
  private async runFetch(providerId: string, opts: { force: boolean }): Promise<QuotaFetchResult> {
    // 并发保护：pending 期间复用 Promise
    // [W7] pending key 带 force 维度：refresh（force）和 fetch（normal）互不复用 ——
    // 否则 refresh 命中 fetch 的 pending 会返回非 force 结果（force 语义被吞）。
    // 同 force 维度内仍去重（同 provider 并发 force 或并发 normal 复用）。
    const pendingKey = this.pendingKey(providerId, opts.force)
    const existing = this.pending.get(pendingKey)
    if (existing) return existing

    // throttle：非 force 模式下，10s 内重复 fetch 直接返回缓存
    if (!opts.force) {
      const lastTime = this.lastFetchTime.get(providerId) ?? 0
      const elapsed = Date.now() - lastTime
      if (elapsed < THROTTLE_MS) {
        return this.getCached(providerId)
      }
    }

    const promise = this.doFetch(providerId, opts.force)
    this.pending.set(pendingKey, promise)

    try {
      return await promise
    } finally {
      this.pending.delete(pendingKey)
    }
  }

  /**
   * [W7] 构造 pending Map 的 key，带 force 维度区分 fetch/refresh。
   * `${providerId}:${force?'force':'normal'}` —— 同 force 去重，跨 force 隔离。
   */
  private pendingKey(providerId: string, force: boolean): string {
    return `${providerId}:${force ? 'force' : 'normal'}`
  }

  /**
   * 读缓存不发起请求（浮层首屏即时填充）。
   * [A2-4] 携带内存中最近一次失败 reason（无失败记录时无 reason 字段）：缓存数据
   * 保留供「查看上次成功数据」入口（lastFetchAt 标注），失败态渲染归 Phase B。
   */
  getCached(providerId: string): QuotaFetchResult {
    const entry = this.cache.getEntry(providerId)
    const reason = this.lastFailure.get(providerId)
    const base = entry
      ? { data: entry.data, lastFetchAt: entry.lastFetchAt }
      : { data: null, lastFetchAt: null }
    return reason !== undefined ? { ...base, reason } : base
  }

  /**
   * 配置 provider 额度查询（Settings UI 调用）。
   * - 持久化 fetcher/enabled/cookieSet/apiKeySet/credentialSource 到 config/providers.json（A1-5 写侧切换）
   * - cookie/apiKey 的 secrets 物理写入/删除在 persist 成功之后执行（§7.3 改动 2 顺序重排）
   *
   * 单 payload 对象签名（§7.1 契约收敛）：可选键缺省 = 不变（persist 继承链）。
   * cookie 空字符串 = 清除（写入 cookieSet=false）；apiKey 空字符串 = 清除专属 key；
   * workspace 接受完整 URL 或裸 wrk_ id（归一化为规范 URL 存储，P1-1），空串 = 清除，
   * 非法输入返回 ok:false（不发请求可区分 not_configured）。
   *
   * 三段顺序（§7.3 改动 2「删除与写入的顺序重排」）：全部校验与计算 → persist →
   * persist 成功后执行 secrets 物理写入/删除。原顺序是 secrets 在前——workspace 归一化
   * 或 persist 任一失败时凭证已被物理删除而 providers.json 未更新，且 renderer 只回滚
   * 本地 fetcherId（useQuotaConfigure.ts），文件不可回滚。
   *
   * 残余窗口（设计 §7.3 改动 2 显式登记，不可完全消除）：
   * - persist（锁内）与紧随的 secrets 写入之间仍有间隙：删除链若在间隙内跑完，会留下
   *   「孤立 secrets 文件 + 无 extras 条目」。量级：需同一 provider 并发「删除」与
   *   「保存额度配置」（两个 panel 或脚本），单人单编辑体操作时为 0。恢复：下一次对该
   *   provider 的删除会清掉孤立文件（D12 清理幂等）；readiness 也不把它算齐备（无
   *   extras 条目 → savedFetcher === undefined → 无既存归属）。
   * - persist 成功但 secrets 文件写入/删除失败：providers.json 已提交新状态而物理文件
   *   未同步（如说 cookieSet: true 而文件不存在）。量级：仅本地 IO 异常（磁盘满/权限）。
   *   恢复：用户重新点一次「保存并测试」即自愈。失败方向优于原顺序——「先写文件后
   *   persist」失败留下的是「幽灵文件 + 标记为 false」的静默坏状态。
   */
  async configure(payload: QuotaConfigurePayload): Promise<QuotaConfigureResult> {
    const { providerId } = payload

    // ── 第一段：全部校验与计算（零物理副作用）──
    // workspace 归一化校验（D1-1/P1-1）：非法输入 fail-fast（不落半成品配置），错误面
    // 返回给调用方（renderer 已本地预校验，此处是直接 RPC 调用者的防御线）
    let normalizedWorkspace: string | null | undefined
    if (payload.workspace !== undefined) {
      const wsResult = this.normalizeWorkspaceInput(providerId, payload.workspace)
      if ('error' in wsResult) return { ok: false, error: wsResult.error }
      normalizedWorkspace = wsResult.value
    }
    // cookieSet/apiKeySet 由 payload 纯计算（不触碰文件）：true = 本次写入，false = 本次
    // 清除，undefined = 本次不动（继承既存）。实际物理写入在第三段——persist 失败时
    // providers.json 与 secrets 都不被触碰（顺序重排的目标）
    const cookieSet = payload.cookie !== undefined ? payload.cookie !== '' : undefined
    const apiKeySet = payload.apiKey !== undefined ? payload.apiKey !== '' : undefined
    // 改动 4：fetcher 变更检测锚点——必须在 persist 之前读（persist 落盘后再读已是新值）
    const prevFetcher = this.readQuotaFallback(providerId)?.fetcher

    // ── 第二段：persist（provider 存在性检查在 modify 回调内，见 persistQuotaConfig）──
    // 持久化 quota 配置到 config/providers.json
    // （fetcher/enabled/cookieSet/apiKeySet/credentialSource/workspace）
    const persistOk = await this.persistQuotaConfig(payload, cookieSet, apiKeySet, normalizedWorkspace)
    if (!persistOk) {
      return { ok: false, error: 'failed to persist quota config' }
    }

    // 改动 4：配置态已提交（persist 成功）——上次失败原因不再适用；fetcher 变更 →
    // 缓存行（按 provider 存储、不含类型）必须失效，否则旧行被 getCached 取回并以新
    // 类型标签展示。清理锚定 persist 成功而非 configure 整体成功，且必须落在下方
    // secrets 物理写入之前：secrets 段失败返回 error 但不回滚 persist（设计登记的
    // 半提交方向），清理若排在 secrets 之后，该路径会「persist 已换新 fetcher，而缓存行
    // 与失败原因仍属旧类型」——浮层/编辑体把旧平台数据以新类型标签展示，正是改动 4
    // 要消除的现象。
    this.lastFailure.delete(providerId)
    if (payload.fetcher !== undefined && payload.fetcher !== prevFetcher) {
      this.cache.removeEntry(providerId)
    }

    // ── 第三段：persist 成功后执行 secrets 物理写入/删除 ──
    // 此处失败返回错误但不回滚 persist（已提交）；残余窗口见本方法 JSDoc。
    const dirError = this.ensureSecretsDir(providerId)
    if (dirError !== undefined) return { ok: false, error: dirError }
    if (payload.cookie !== undefined) {
      const cookieError = this.writeCookieSecret(providerId, payload.cookie)
      if (cookieError !== undefined) return { ok: false, error: cookieError }
    }
    if (payload.apiKey !== undefined) {
      const keyResult = this.writeApiKeySecret(providerId, payload.apiKey)
      if ('error' in keyResult) return { ok: false, error: keyResult.error }
    }

    return { ok: true }
  }

  /**
   * configure 阶段 helper 之一：确保 secrets 目录存在（失败返回 error 文案）。
   * [W4] 临时清零 umask 保证 mode 0o700 不被进程 umask 过滤（mkdirSync 的 mode 受 umask 影响）。
   * 文件级 mode 0o600 同理在写入时设置。恢复原 umask 以免影响调用方其他 IO。
   */
  private ensureSecretsDir(providerId: string): string | undefined {
    if (existsSync(this.secretsDir)) return undefined
    const prevUmask = process.umask(0)
    try {
      mkdirSync(this.secretsDir, { recursive: true, mode: SECRET_DIR_MODE })
      return undefined
    } catch (err) {
      const msg = toErrorMessage(err)
      logger.warn('[quota] failed to create secrets dir', { providerId, error: msg })
      return msg
    } finally {
      process.umask(prevUmask)
    }
  }

  /**
   * configure 阶段 helper 之二：cookie 写入/清除 secrets（失败返回 error 文案）。
   * 非空 = 写入；空串 = 清除（§7.3 改动 2：目标文件存在则删除，删除失败返回 error
   * 使 configure 整体失败——否则「标记说已清除、文件仍在」，读取端把空内容当 null
   * 会造成「标记 cookieSet=true 而实际无凭证」的幽灵态）。
   */
  private writeCookieSecret(providerId: string, cookie: string): string | undefined {
    if (!cookie) {
      return this.removeSecretFile(providerId, this.getCookiePath(providerId), 'cookie')
    }
    try {
      this.writeSecretFile(this.getCookiePath(providerId), cookie)
      return undefined
    } catch (err) {
      const msg = toErrorMessage(err)
      logger.warn('[quota] failed to write cookie', { providerId, error: msg })
      return msg
    }
  }

  /**
   * secrets 文件删除（§7.3 改动 2，cookie 空串=清除与 apiKey 清除分支共用同一语义）：
   * 文件存在则删除；文件不存在视为成功（幂等）。删除失败返回 error 文案使 configure
   * 整体失败。不做 existsSync 预检——预检本身是 TOCTOU，直接 unlink 按 ENOENT 判定缺席。
   */
  private removeSecretFile(providerId: string, filePath: string, label: string): string | undefined {
    try {
      unlinkSync(filePath)
      return undefined
    } catch (err) {
      // ENOENT = 文件本就不存在：幂等语义的成功分支（等价「文件不存在视为成功」）
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      const msg = toErrorMessage(err)
      logger.warn(`[quota] failed to remove ${label} secret file`, { providerId, error: msg })
      return msg
    }
  }

  /**
   * configure 阶段 helper 之三：Coding Plan 专属 API Key 写入/清除。
   * 非空 = 写入专属 key（apiKeySet=true）；空字符串 = 清除专属 key，fallback 到
   * provider.apiKey（apiKeySet=false）。写/删失败均返回 error 文案（调用方 fail-fast）——
   * 清除分支旧实现 unlink 失败被 catch 后只 debug log 仍返回 apiKeySet:false（标记说
   * 已清除、文件仍在，exclusive 读侧会继续读到已作废的 key），§7.3 改动 2 要求与
   * cookie 清除同语义：两处必须一致，否则凭证作废效果绑在一个不实的标记上。
   */
  private writeApiKeySecret(providerId: string, apiKey: string): { apiKeySet: boolean } | { error: string } {
    if (!apiKey) {
      const removeError = this.removeSecretFile(providerId, this.getApiKeyPath(providerId), 'api key')
      return removeError !== undefined ? { error: removeError } : { apiKeySet: false }
    }
    try {
      this.writeSecretFile(this.getApiKeyPath(providerId), apiKey)
      return { apiKeySet: true }
    } catch (err) {
      const msg = toErrorMessage(err)
      logger.warn('[quota] failed to write apiKey', { providerId, error: msg })
      return { error: msg }
    }
  }

  /**
   * configure 阶段 helper 之四：workspace 输入归一化（D1-1/P1-1）。
   * 空字符串 = 清除（value:null，恢复未配置态，查询报 not_configured）；裸 wrk_ id
   * 归一化为规范 URL 存储（P1-1）；非法输入返回 error 文案（调用方 fail-fast）。
   */
  private normalizeWorkspaceInput(
    providerId: string,
    workspace: string,
  ): { value: string | null } | { error: string } {
    const trimmed = workspace.trim()
    if (!trimmed) return { value: null }
    const normalized = normalizeQuotaWorkspaceUrl(trimmed)
    if (!normalized.ok) {
      logger.warn('[quota] invalid workspace input', { providerId, error: normalized.error })
      return { error: normalized.error }
    }
    return { value: normalized.url }
  }

  /**
   * 持久化 quota 配置到 config/providers.json（A1-5 写侧切换，经 XyzProviderStore.modify
   * RMW——只覆写 quota 字段，同 provider 其他扩展数据不动）。
   *
   * 校验：provider 必须存在于聚合层（catalog 或 custom，providerExists 注入判定）——
   * quota 绑定不再依赖 models.json 条目存在（场景 E：oauth-only catalog provider）。
   *
   * 既有值继承（A1-3 读源切换）：quota 既有值经 readQuotaFallback 双读——providers.json
   * 条目优先，无条目时回退 models.json 旧 quota（迁移失败窗口兼容——迁移成功后
   * models.json 已剥离，该回退恒 miss）。
   */
  private async persistQuotaConfig(
    payload: QuotaConfigurePayload,
    cookieSet: boolean | undefined,
    apiKeySet: boolean | undefined,
    /** undefined = 本次不动 workspace；null = 清除；string = 归一化 URL 写入 */
    workspace: string | null | undefined,
  ): Promise<boolean> {
    const { providerId } = payload
    if (!this.extrasStore) {
      logger.warn('[quota] provider extras store not configured, cannot persist quota', { providerId })
      return false
    }
    const legacyQuota = this.readQuotaFallback(providerId)
    try {
      await this.extrasStore.modify(providerId, current => {
        // §7.3 改动 2：存在性检查在锁内（原在 modify 之前）——modify 的锁只锁文件、不锁
        // provider 存在性，而删除链的 cleanProviderExtras 用同一把锁：检查放在 modify
        // 之前会把 TOCTOU 窗口拉大。失败序列：T2(configure) 检查通过 → T1(删除) 完整
        // 跑完（models.json / auth.json / extras / secrets 全清）→ T2 的 persist 落盘
        // 复活僵尸 quota 条目 → T2 的 secrets 写入重建刚被删的凭据文件 → 同 id 重建时
        // readiness 因「¬typeChanged ∧ cookieSet」判齐备 → 复用被删 provider 的旧 Cookie
        // （M5-05 缺口重开）。放回调内与 delete 争同一临界区，回调抛错则整个写入被跳过。
        if (!this.providerExists(providerId)) throw new ProviderGoneError(providerId)
        // workspace 三态（对齐 apiKeySet 的「本次明确传入才动」语义，清除态显式落 undefined）
        const existingQuota = current?.quota
        return {
          ...current,
          quota: {
            fetcher: QuotaService.inheritQuotaField(payload.fetcher, existingQuota?.fetcher, legacyQuota?.fetcher),
            enabled: payload.enabled,
            // 保留既有 cookieSet，除非本次明确写入/清除（空串清除 → cookieSet=false）
            cookieSet: QuotaService.inheritQuotaField(cookieSet, existingQuota?.cookieSet, legacyQuota?.cookieSet),
            // 保留既有 apiKeySet，除非本次明确传入新值（含空字符串清除）
            apiKeySet: QuotaService.inheritQuotaField(apiKeySet, existingQuota?.apiKeySet, legacyQuota?.apiKeySet),
            // credentialSource 恒由 payload 显式值经继承链落盘（键缺省 = 继承既存）。
            // 禁止在写侧调 resolveQuotaCredentialSource 补默认（§7.3 改动 6 反例）：它是
            // **显式值优先**（quota?.credentialSource ?? …），`incoming ?? resolve(...)` 只在
            // incoming 为 undefined 时触发，因此不会覆盖显式值。真实危害是把**未设置的字段
            // 物化成推断值**——setEnabled 式缺省 payload 会在磁盘写入用户从未选择过的来源
            // （拨一下开关就静默改写来源选择，正是 D3 要消除的「UI 说的与 runtime 用的背离」），
            // 且此后该 provider 不再跟随推断：专属 Key 被清后 apiKeySet 变 false，读侧本应
            // 回落 provider，冻结的显式值会让查询走向 no-credential。
            // 可证伪基线 = quota-service.test.ts「未设置值不被物化成推断值」场景 C（磁盘记录
            // 仍不含 credentialSource 键）；同用例的场景 A/B 拦的是另一个 mutation（丢继承链：
            // `credentialSource: payload.credentialSource` 丢 undefined 键），对本条不变红。
            credentialSource: QuotaService.inheritQuotaField(
              payload.credentialSource,
              existingQuota?.credentialSource,
              legacyQuota?.credentialSource,
            ),
            workspace: QuotaService.resolveWorkspaceValue(workspace, existingQuota, legacyQuota),
          },
        }
      })
      return true
    } catch (err) {
      const msg = toErrorMessage(err)
      logger.warn('[quota] failed to persist quota config to providers.json', { providerId, error: msg })
      return false
    }
  }

  /**
   * quota 字段继承链（A1-3 读源切换）：显式新值 → providers.json 既有值 →
   * models.json legacy quota 兜底。?? 短路链与原内联写法逐字等价（仅消重复）。
   */
  private static inheritQuotaField<T>(next: T | undefined, current: T | undefined, legacy: T | undefined): T | undefined {
    return next ?? current ?? legacy
  }

  /**
   * workspace 三态继承：undefined = 本次不动（继承既有值）；null = 清除（落 undefined）；
   * string = 归一化 URL 写入。与 apiKeySet 的「本次明确传入才动」语义对齐。
   */
  private static resolveWorkspaceValue(
    workspace: string | null | undefined,
    current: ProviderExtras['quota'] | undefined,
    legacyQuota: ProviderExtras['quota'] | undefined,
  ): string | undefined {
    if (workspace === undefined) return current?.workspace ?? legacyQuota?.workspace
    if (workspace === null) return undefined
    return workspace
  }

  /**
   * quota 既有值双读回退（A1-3 读源切换）：providers.json 条目（经 XyzProviderStore 同步
   * 读）优先，无条目时回退 models.json 旧寄生 quota。providers.json 有条目时与 modify
   * 回调的 current.quota 同值（兜底链中 current 优先，此处值仅补充无条目场景）。
   */
  /** A1-3 双读回退（providers.json 优先 + models.json 旧寄生 quota 兜底），复用 migration 的 readExtrasWithFallback。 */
  private readQuotaFallback(providerId: string): NonNullable<ProviderExtras['quota']> | undefined {
    if (!this.extrasStore) return this.readProviderConfig(providerId)?.quota
    return readExtrasWithFallback(
      this.extrasStore,
      { getProviderConfig: (id) => this.readProviderConfig(id) },
      providerId,
    )?.quota
  }

  /**
   * 实际执行查询（内部方法）。五个出口（§7.3 改动 4「出口覆盖」）：
   * ① `!fetcher` 早退——不发请求，不经收尾 helper（lastFetchTime 不写；本地判定无请求
   *    无日志，速率受 hover 事件与 renderer markPending 去重双重有界，显式行为变更）；
   * ② `no-credential`——凭证缺失显式失败（§7.3 改动 1，原为静默返回缓存）；
   * ③ 成功 `cache.update`；④ `fetchFailed(reason)`；⑤ throw → `fetchFailed('network')`。
   * ②-⑤ 全部经 finishFetch 收尾 helper（守卫 + 三件套 + lastFetchTime 单点收口）。
   *
   * [W5] throttle 计时只在非 force 路径更新（现迁入 finishFetch）：refresh（force=true）
   * 不应更新 lastFetchTime，否则 refresh 后 10s 内的 hover fetch 会被错误拦截。
   */
  private async doFetch(providerId: string, force: boolean): Promise<QuotaFetchResult> {
    const fetcher = this.getFetcherForProvider(providerId)
    // 出口 ①（!fetcher 早退）：静默降级缓存，不经 finishFetch（不写 lastFetchTime）
    if (!fetcher) return this.getCached(providerId)

    // 在途写回守卫锚点：发起时的 fetcher id（下方两个 await——resolveCredential /
    // fetchQuota——期间 configure 可能换类型，落地前与当前值比对）
    const fetcherIdAtStart = fetcher.id

    const resolved = await this.resolveCredential(providerId, fetcher.auth)
    if (!resolved) {
      // 出口 ②（no-credential，§7.3 改动 1）：凭证缺失显式失败而非静默返回缓存——
      // 从零日志变为每次一条 warn（表 A #13，失败查询的节流速率前提）
      logger.warn('[quota] fetch failed', { providerId, reason: 'no-credential' })
      return this.finishFetch(providerId, force, fetcherIdAtStart, () =>
        this.fetchFailed(providerId, 'no-credential'))
    }

    try {
      // D1-2：per-provider 只读配置注入（首期仅 workspaceUrl——资源维度 fetcher 的
      // workspace 归一化地址，经 readQuotaFallback 双读 providers.json/models.json 旧值）
      const config: QuotaFetcherConfig = {
        workspaceUrl: this.readQuotaFallback(providerId)?.workspace,
      }
      const outcome = await fetcher.fetchQuota(resolved.credential, resolved.kind, config)

      if (outcome.ok) {
        // 出口 ③（成功）：清失败标记 + 更新缓存
        return this.finishFetch(providerId, force, fetcherIdAtStart, () => {
          this.lastFailure.delete(providerId)
          this.cache.update(providerId, outcome.data)
          return { data: outcome.data, lastFetchAt: Date.now() }
        })
      }

      // 出口 ④（查询失败，ok:false，reason 可区分）：返回失败态——data 置 null
      // 不再降级展示旧缓存（§3.4 失败态语义：旧缓存保留内存，可经 getCached 查看并
      // 标注 lastFetchAt）；401 恢复指引文案归 Phase B（i18n key 已就绪）。
      logger.warn('[quota] fetch failed', { providerId, reason: outcome.reason })
      return this.finishFetch(providerId, force, fetcherIdAtStart, () =>
        this.fetchFailed(providerId, outcome.reason))
    } catch (err) {
      // 出口 ⑤（异常防御，fetcher 契约不 throw，此处兜底逃逸异常）：按 network 失败态处理 + log
      const msg = toErrorMessage(err)
      logger.warn('[quota] fetch threw', { providerId, error: msg })
      return this.finishFetch(providerId, force, fetcherIdAtStart, () =>
        this.fetchFailed(providerId, 'network'))
    }
  }

  /**
   * doFetch 收尾 helper（§7.3 改动 4「结构收口，防出口漂移」）：在途写回守卫 +
   * lastFetchTime 节流锚点单点收口——除「!fetcher 早退」外全部出口经此，新出口不经
   * helper 即不写时间戳，遗漏在代码结构里可见而非靠清单纪律。
   *
   * - 守卫：发起时捕获的 fetcherId 与当前 getFetcherForProvider 比对（该读直读盘无缓存，
   *   persist 落盘后立即可见，与 broadcast 无关）。失配 = 在途期间类型已变更 → 三件套
   *   （cache.update / lastFailure / lastFetchTime）全部不写——旧行不回写、时间戳不盖
   *   （否则新类型首个 fetch 在 10s 内被 throttle 压制，返回已清空的 getCached，
   *   「暂无额度数据」持续 ≤10s），返回 getCached 读当前真相（不是手工空对象——
   *   消费方按「有 reason → setError；无 reason → setCache」分流，手工 {data:null} 会被
   *   当成功数据写进 store 并清掉诊断态 error）。
   * - lastFetchTime：完成时刻写入（[W5] 写点从发起处迁到此处——发起时刻写在两个 await
   *   之前，守卫撤不回已发生的写）。仅非 force 路径写（refresh 不污染 fetch 的 throttle
   *   判定）；在途期间由 pending 并发复用去重覆盖，窗口实际拉长一个在途时长，无害。
   * - 被否方案（设计原文）：失配分支补 lastFetchTime.delete(pid) 的补偿写——「set 后
   *   再按条件 delete」依赖两处写点的顺序永不改变，比单一写点脆弱。
   */
  private finishFetch(
    providerId: string,
    force: boolean,
    fetcherIdAtStart: string,
    commit: () => QuotaFetchResult,
  ): QuotaFetchResult {
    if (this.getFetcherForProvider(providerId)?.id !== fetcherIdAtStart) {
      // 失配出口：全部落地写丢弃（不写 lastFetchTime、不写三件套）
      return this.getCached(providerId)
    }
    if (!force) {
      this.lastFetchTime.set(providerId, Date.now())
    }
    return commit()
  }

  /** 失败态构造（A2-4）：记录失败原因；lastFetchAt 标注上次成功时间（§3.4 旧缓存标注语义）。 */
  private fetchFailed(providerId: string, reason: QuotaFetchFailureReason): QuotaFetchResult {
    this.lastFailure.set(providerId, reason)
    const lastSuccessAt = this.cache.getEntry(providerId)?.lastFetchAt ?? null
    return { data: null, lastFetchAt: lastSuccessAt, reason }
  }

  /**
   * 根据 providerId 查找对应的 fetcher。
   *
   * 设计文档 §2.2.3：providerId 是用户在 settings 创建的 provider id（如 'my-zhipu'、'glm'），
   * 不是 fetcher id（'zhipu'/'kimi-coding'）。查找优先级：
   *
   * 1. 用户手动指定的 quota.fetcher（直接按 id 查 QUOTA_FETCHERS）
   * 2. 经 ProviderInfo 的 baseUrl/name 调 matchQuotaPreset 匹配 QUOTA_PRESETS 得到 preset.fetcher
   * 3. fallback：直接按 providerId 查 fetchers（兼容 provider id 恰好等于 fetcher id 的场景）
   */
  private getFetcherForProvider(providerId: string): ProviderQuotaFetcher | null {
    const info = this.getProviderInfo(providerId)

    // 优先级 1：用户手动指定的 fetcher id（不再依赖 baseUrl/name 自动匹配，
    // 适配自建反代、非标准 baseUrl 等自动匹配失败/猜错的场景）
    if (info?.quota?.fetcher) {
      const manual = QUOTA_FETCHERS.get(info.quota.fetcher)
      if (manual) return manual
    }

    // 优先级 2：经 baseUrl/name 匹配 preset
    if (info) {
      const preset = matchQuotaPreset({ baseUrl: info.baseUrl, name: info.name })
      if (preset) {
        return QUOTA_FETCHERS.get(preset.fetcher) ?? null
      }
    }

    // 优先级 3：直接按 providerId 查 fetchers（仅命中 provider id 恰好等于 fetcher id 的场景）
    return QUOTA_FETCHERS.get(providerId) ?? null
  }

  /**
   * 按 fetcher.auth 能力声明数组序解析凭证（A2-2 三形态解析链）。
   * 首个解析到凭证的形态即生效，并以该形态作为 kind 传给 fetchQuota（凭证语义可区分）。
   * 全形态 miss → null（调用方不发请求，返回缓存）。
   *
   * 例外（D3 / §7.3 改动 3）：「用专属 Key」（exclusive）且该 fetcher 声明了 api-key
   * 形态时，只允许 api-key 形态，不回退 auth 数组中的其它形态。原因：`getCredential`
   * 的 api-key 分支在 exclusive 下只读专属 Key 文件，缺失返回 null——若上层继续遍历，
   * kimi-coding（auth=['api-key','oauth']）会用 provider 的 OAuth 登录态查成功，而 UI
   * 分段控件显示「用专属 Key」，正是 D3「UI 的选择与 runtime 使用的凭证不得背离」要
   * 消灭的「显示用 A、实际用 B」（§3.2 失败模式 D）。文件缺失即 null → 上层落
   * no-credential（§7.3 改动 3「缺失即 no-credential，不回退」）。
   *
   * 收窄条件由 shared 的 supportsExclusiveCredential 提供（两端共用，coding-plan-quota-config-ux
   * §7 残留 11：UI 与 runtime 必须同一判据，否则 UI 显示「用专属 Key」而 runtime 忽略该选择）：
   * cookie 类 fetcher（auth 不含 api-key）不命中，仍按数组序正常解析；source === 'provider'
   * 时也完全走原路径。
   */
  private async resolveCredential(
    providerId: string,
    auth: readonly QuotaAuthKind[],
  ): Promise<{ credential: string; kind: QuotaAuthKind } | null> {
    const source = resolveQuotaCredentialSource(this.getProviderInfo(providerId)?.quota)
    if (source === 'exclusive' && supportsExclusiveCredential(auth)) {
      const credential = await this.getCredential(providerId, 'api-key')
      return credential ? { credential, kind: 'api-key' } : null
    }
    for (const kind of auth) {
      const credential = await this.getCredential(providerId, kind)
      if (credential) return { credential, kind }
    }
    return null
  }

  /**
   * 获取凭证（单形态，来源链按 credentialSource 分支，§7.3 改动 1+3 / D3）。
   * - api-key：exclusive → 只读专属 Key 文件（缺失 → null → no-credential，**不回退**——
   *   配置声明「用专属 Key」而 Key 不在就应报出来，不偷偷换成另一份凭证）；
   *   provider → 完全跳过专属 Key 文件，经唯一凭据通道 resolver（auth.json → models.json）
   * - oauth：auth.json `credential(oauth).access`（直读现值，不自行 refresh——D6）
   * - cookie：secrets cookie 文件
   *
   * 支持自定义 API Key 是为了适配 router/反代场景：provider 的 baseUrl 指向本地 router，
   * 但 provider.apiKey 是 router 的 key，而 Coding Plan 平台（如 bigmodel.cn）需要平台专属 key。
   */
  private async getCredential(providerId: string, kind: QuotaAuthKind): Promise<string | null> {
    if (kind === 'api-key') {
      // 凭证归属锚点（D3）：UI 与 runtime 必须用同一个 resolveQuotaCredentialSource，
      // 否则两端推断可以背离。未显式设置时按 apiKeySet 推断（兼容历史数据）。
      const source = resolveQuotaCredentialSource(this.getProviderInfo(providerId)?.quota)
      if (source === 'exclusive') {
        // 只读 quota 专属 Key 文件——quota 专属 key 语义，不属于 provider 凭据，
        // 不并入 resolver（D3：resolver 只管 provider 凭据两源）。缺失 → null → no-credential
        return this.readSecret(this.getApiKeyPath(providerId))
      }
      // source === 'provider'：完全跳过专属 Key 文件——这是 D3 消除「显示用 A、实际
      // 用 B」（§3.2 失败模式 D）的机制所在：来源切走后残留的专属 Key 永不被读。
      // D3 链 1（凭据收口）：auth.json api_key → models.json apiKey 两段统一走 resolver。
      // 异常降级保留（resolveCredential 在 doFetch 的 try 之外，删掉降级会让 resolver
      // 异常逃逸成 RPC 无响应——退化为 backstop 超时，比 no-credential 难诊断）。
      try {
        const resolved = await this.credentialResolver.resolveProviderCredential(providerId)
        return resolved?.key ?? null
      } catch (err) {
        const msg = toErrorMessage(err)
        logger.debug('[quota] failed to resolve provider credential', { providerId, error: msg })
        return null
      }
    }

    if (kind === 'oauth') {
      const authCred = await this.readAuthCredential(providerId)
      return authCred?.type === 'oauth' && authCred.access ? authCred.access : null
    }

    // cookie 类型：从 secrets 目录读取
    return this.readSecret(this.getCookiePath(providerId))
  }

  /** auth.json 凭证读取（未注入通道 / 读取异常 → undefined，不阻断后续来源链）。 */
  private async readAuthCredential(providerId: string): Promise<Credential | undefined> {
    if (!this.getAuthCredential) return undefined
    try {
      return await this.getAuthCredential(providerId)
    } catch (err) {
      const msg = toErrorMessage(err)
      logger.debug('[quota] failed to read auth.json credential', { providerId, error: msg })
      return undefined
    }
  }

  /** 读 secret 文件（去空白），文件不存在/读取失败返回 null */
  private readSecret(filePath: string): string | null {
    try {
      if (!existsSync(filePath)) return null
      const val = readFileSync(filePath, 'utf-8').trim()
      return val || null
    } catch (err) {
      // 读取失败不阻断流程（返回 null fallback），但必须 log（架构约定 #4 落盘，禁止静默 catch）
      const msg = toErrorMessage(err)
      logger.debug('[quota] failed to read secret file', { filePath, error: msg })
      return null
    }
  }

  /**
   * [W4] 写入 secret 文件并设 0o600 权限。
   *
   * cookie/apiKey 是敏感凭证，文件权限应为 0600（仅属主可读写）。
   * writeFileSync 的 mode 选项仅在创建新文件时生效且被 umask 过滤，故临时清零 umask +
   * 用 chmodSync 后置强制设权限（已存在文件覆盖内容后 mode 不变，也需后置设）。
   */
  private writeSecretFile(filePath: string, content: string): void {
    const prevUmask = process.umask(0)
    try {
      writeFileSync(filePath, content, { encoding: 'utf-8', mode: SECRET_FILE_MODE })
      // mode 选项对新文件且 umask=0 时已生效；chmodSync 后置保证已存在文件被覆盖后权限正确
      chmodSync(filePath, SECRET_FILE_MODE)
    } finally {
      process.umask(prevUmask)
    }
  }

  /** cookie 文件路径：`<dataDir>/secrets/<providerId>-cookie.txt` */
  private getCookiePath(providerId: string): string {
    return join(this.secretsDir, `${providerId}-cookie.txt`)
  }

  /** Coding Plan 专属 API Key 文件路径：`<dataDir>/secrets/<providerId>-apikey.txt` */
  private getApiKeyPath(providerId: string): string {
    return join(this.secretsDir, `${providerId}-apikey.txt`)
  }

  /**
   * provider 删除链的 quota 状态清理（D12，§7.3 改动 5）：删两个 secrets 文件 + 清内存
   * 失败/节流标记 + 清缓存条目。幂等（ENOENT 视为成功）。
   *
   * 接线形态（t2 批）：本批仅提供实现——组合根经 ConfigService 的可选注入钩子
   * `setQuotaStateCleaner((pid) => quotaService.clearProviderState(pid))` 后置回填
   * （先例 setCredentialWriter），并遵循「只在 cleanProviderExtras 成功之后执行」的
   * 排序约束（防幽灵标记）。清理失败只 warn 不阻断删除主流程（对齐
   * cleanAuthCredential / cleanProviderExtras 的既有语义）。
   */
  async clearProviderState(providerId: string): Promise<void> {
    const cookieError = this.removeSecretFile(providerId, this.getCookiePath(providerId), 'cookie')
    const apiKeyError = this.removeSecretFile(providerId, this.getApiKeyPath(providerId), 'api key')
    if (cookieError !== undefined || apiKeyError !== undefined) {
      // secrets 删失败留下惰性孤儿文件（provider 已删 ⇒ 无人 fetch；下次同 id 删除再清），
      // 不阻断——但内存态仍清（provider 已删，失败/节流标记失去消费方）
      logger.warn('[quota] failed to clear provider quota secrets', { providerId, cookieError, apiKeyError })
    }
    this.lastFailure.delete(providerId)
    this.lastFetchTime.delete(providerId)
    this.cache.removeEntry(providerId)
  }
}
