/**
 * 存量 provider 配置迁移：catalog provider 错位 apiKey 迁 auth.json。
 *
 * 背景：taiji 此前不区分 pi 的两套 provider 体系，catalog provider 的
 * apiKey 被错位写进 models.json（0644 明文）。此迁移在启动期幂等执行：
 * - catalog provider 条目含 apiKey → apiKey 迁 auth.json，删 models.json 条目
 * - 若条目有非默认 override（baseUrl/compat）→ 保留 override-only 条目只删 apiKey
 * - 自定义 provider 条目 → 不动
 * - OAuth 冲突（auth.json 已有 oauth）→ 跳过
 * - 迁移失败不阻断启动，warn + 下次重试
 *
 * 🔒 三层架构：本文件位于 services 层，models.json CRUD 经 IConfigStore port 访问
 *（infra/pi/pi-config-store 实现），pi 协议类型（PiProviderConfig）不进入 services——
 * 这里只见 ConfigProviderConfig service 视图。
 */
import { isCatalogProvider } from '../provider-catalog.js'
import type { AuthStorage, CredentialWriter } from '../auth/auth-storage.js'
import type { IConfigStore, ConfigProviderConfig } from '../ports/config.js'

export interface MigrationReport {
  migrated: string[]
  kept: string[]
  failed: string[]
  skipped: string[]
  errors: string[]
}

/**
 * step2 迁移结果：provider 级 enabled → settings.json.enabledModels 白名单。
 *
 * - migratedEnabled=false：models.json 无 provider 级 enabled 字段，完全 no-op（幂等，TC6）
 * - migratedEnabled=true：曾发现有 enabled 字段，已删字段；可能同时设了白名单
 * - fullDisabledWarn=true：所有 provider enabled===false（pi 契约不支持全禁用，
 *   迁移后全可用 + warn 提示用户手动移除，ES4/TC3）
 */
export interface ProviderEnabledMigrationReport {
  migratedEnabled: boolean
  fullDisabledWarn?: boolean
}

/**
 * migrateProviderConfig 合并报告：step1 catalog apiKey 迁移 + step2 provider.enabled 迁移。
 * 启动期调用，失败不阻断启动。 */
export interface ProviderConfigMigrationReport {
  catalog: MigrationReport
  enabled: ProviderEnabledMigrationReport
}

/**
 * 启动期幂等迁移：catalog provider 错位 apiKey → auth.json。
 * @param authStorage AuthStorage 实例（读 OAuth 冲突检查用；写入不走它——A1-4 收口）
 * @param credentialWriter auth.json 凭据写通道（A1-4 收口：经 AuthService.saveCredential 写入）
 * @returns MigrationReport
 */
export async function migrateLegacyProviderConfig(
  configStore: IConfigStore,
  authStorage: Pick<AuthStorage, 'get'>,
  credentialWriter: CredentialWriter,
): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], kept: [], failed: [], skipped: [], errors: [] }

  try {
    const models = configStore.readModels()
    const providers = models.providers ?? {}

    for (const [providerId, config] of Object.entries(providers)) {
      await migrateSingleProviderEntry(configStore, authStorage, credentialWriter, report, providerId, config)
    }
  } catch (e) {
    report.errors.push(`migration failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return report
}

/**
 * 单条目处理（kept/skipped/migrated/failed 四态分流，原主循环体原样提取）：
 * catalog + 有 apiKey 才迁移；OAuth 冲突跳过；写凭据/删条目失败进 failed + errors。
 */
async function migrateSingleProviderEntry(
  configStore: IConfigStore,
  authStorage: Pick<AuthStorage, 'get'>,
  credentialWriter: CredentialWriter,
  report: MigrationReport,
  providerId: string,
  config: ConfigProviderConfig,
): Promise<void> {
  // 只处理 catalog provider
  if (!isCatalogProvider(providerId)) {
    report.kept.push(providerId)
    return
  }

  // 只处理有 apiKey 的条目（无 apiKey 的是 override-only 条目，不动）
  if (!config.apiKey || config.apiKey === '') {
    report.kept.push(providerId)
    return
  }

  // OAuth 冲突检查
  try {
    const existing = await authStorage.get(providerId)
    if (existing?.type === 'oauth') {
      report.skipped.push(providerId)
      return
    }
  } catch (e) {
    // auth.json 读失败不阻断，继续迁移（秘钥会覆盖写入）：OAuth 冲突检查跳过，
    // 记 warn 保留可观测性（启动期一次性，无刷屏风险）
    console.warn('[runtime] legacy migration: read auth.json for OAuth conflict check failed, continuing:', e)
  }

  try {
    await migrateCatalogApiKey(configStore, credentialWriter, providerId, config)

    report.migrated.push(providerId)
  } catch (e) {
    report.failed.push(providerId)
    report.errors.push(`${providerId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * catalog 条目的 apiKey 迁移落盘：写 auth.json + 按 override 有无删条目/保留 override-only 条目。
 * 抛错由调用方 catch（failed + errors）。
 */
async function migrateCatalogApiKey(
  configStore: IConfigStore,
  credentialWriter: CredentialWriter,
  providerId: string,
  config: ConfigProviderConfig,
): Promise<void> {
  // 写 apiKey 到 auth.json（A1-4 收口：经 credentialWriter，不再直接持有 authStorage.set）
  await credentialWriter.saveCredential(providerId, { type: 'api_key', key: config.apiKey as string })

  // 删 models.json 条目（重建不含 apiKey 的配置）
  const { apiKey: _apiKey, ...rest } = config as Record<string, unknown>
  if (hasNonDefaultOverride(rest)) {
    configStore.upsertProvider(providerId, rest as ConfigProviderConfig)
  } else {
    // 无 override → 删除整个条目，catalog provider 回退 builtin template。
    // A7：用 removeProvider（功能完整：删条目 + 同步清理 default）替代「写最小条目」变通
    // （写 {name,api,baseUrl} 会丢失 models/quota 等字段且语义不准）。
    // removeProvider 若删的是 default 承载 provider 会重选 newDefault 并写回 settings.json，
    // 运行时 findValidDefaultModel 兜底（catalog provider 仍可用，凭据已正位 auth.json）。
    configStore.removeProvider(providerId)
  }
}

/**
 * 非 builtin template 默认字段（name/api/baseUrl）的 override 判定。
 *
 * 如果只剩下默认字段（name/api/baseUrl 来自 builtin template），直接删条目；
 * 如果有额外 override 字段 → 保留 override-only 条目。
 * M5-04：hasOverride 判定必须覆盖 models/quota——catalog 条目含 model 级配置
 *（如 model.enabled 编辑）或 Coding Plan quota 时整条删除会丢用户配置，与 step2
 *「model 级 enabled 保留不动」承诺冲突。含 models/quota 的条目保留 override-only
 * 形态（仅删 apiKey），models 级 enabled 由 pi 原生消费。
 */
function hasNonDefaultOverride(rest: Record<string, unknown>): boolean {
  return Object.keys(rest).length > 0 && (
    rest.baseUrl !== undefined || rest.compat !== undefined || rest.headers !== undefined
    || rest.models !== undefined || rest.quota !== undefined
  )
}

/**
 * step2 启动期幂等迁移：provider 级 enabled 字段 → settings.json.enabledModels 白名单。
 *
 * 背景（G5）：wave3 把 provider 启停源改为 enabledModels（SSOT）后，存量 models.json 的
 * provider 级 `enabled` 字段未被消费，存量用户的启停配置「丢失」（deriveEnabled 只读
 * enabledModels，不再读 provider.enabled）。本 step 把存量 enabled 字段迁移成白名单。
 *
 * 逻辑（design CL1/CL2/C1-C3）：
 * 1. 收集有 provider 级 enabled 字段的条目（`'enabled' in config`）。无任何条目有此字段
 *    → 完全 no-op（幂等，TC6）。
 * 2. 全 enabled（无 disabled）→ 不设白名单（保持「无白名单=全可用」语义，TC2/CL1）。
 *    避免「全 enabled 迁移后设全部 pattern」的冗余（全 pattern ≡ 空 = 全可用，但空更简洁，
 *    且未来新增 provider 不自动可用是白名单语义的反效果）。
 * 3. 有 disabled → enabledModels = enabled 条目的 `<id>/*`（TC1）。
 * 4. 全 disabled（enabled 为空）→ clearEnabledModels + fullDisabledWarn（ES4/TC3）。
 *    pi 契约不支持全禁用（白名单语义空=全可用），迁移后全可用 + warn 提示用户手动移除。
 * 5. 删 provider 级 enabled 字段（upsertProvider 写回无 enabled 的 config）。model 级
 *    `models[].enabled` 保留不动（TC4）——它由 pi 原生消费，不在本次迁移范围。
 * 6. defaultModel 重选不主动做（CL2）：依赖运行时 findValidDefaultModel 兜底（wave2 catalog
 *    兜底已过滤 enabledModels），迁移后若 default 落白名单外下次 getDefaultModel 自动重选。
 *
 * @returns migratedEnabled=true 表示曾发现有 enabled 字段并已处理（删字段 ± 设白名单）
 */
export async function migrateProviderEnabledToWhitelist(configStore: IConfigStore): Promise<ProviderEnabledMigrationReport> {
  const report: ProviderEnabledMigrationReport = { migratedEnabled: false }

  try {
    const models = configStore.readModels()
    const providers = models.providers ?? {}

    // 收集有 provider 级 enabled 字段的（含 enabled:true / enabled:false）
    const providersWithEnabled = Object.entries(providers).filter(
      ([, config]) => config !== null && typeof config === 'object' && 'enabled' in config,
    ) as Array<[string, ConfigProviderConfig]>

    // 无 provider 级 enabled 字段 → 完全 no-op（幂等，TC6）
    if (providersWithEnabled.length === 0) {
      return report
    }

    // 分 enabled(enabled!==false) / disabled(enabled===false)。
    // 与 deriveEnabled 同语义：省略/true/其他 truthy 都视为启用，仅严格 ===false 视为禁用。
    const enabledProviderIds: string[] = []
    for (const [providerId, config] of providersWithEnabled) {
      if (config.enabled !== false) {
        enabledProviderIds.push(providerId)
      }
    }
    const hasDisabled = enabledProviderIds.length < providersWithEnabled.length

    if (hasDisabled) {
      if (enabledProviderIds.length === 0) {
        // 全 disabled → clearEnabledModels + warn（ES4/TC3）
        configStore.clearEnabledModels()
        report.fullDisabledWarn = true
      } else {
        // 部分禁用 → enabledModels = enabled 的 <id>/*（TC1）
        configStore.setEnabledModels(enabledProviderIds.map(id => `${id}/*`))
      }
    }
    // 全 enabled（无 disabled）→ 不设白名单（保持全可用，TC2/CL1）

    // 删 provider 级 enabled 字段（TC4 + 幂等 TC6 前提）。
    // model 级 models[].enabled 不动（pi 原生消费）。
    for (const [providerId, config] of providersWithEnabled) {
      const { enabled: _removed, ...rest } = config
      configStore.upsertProvider(providerId, rest)
    }

    report.migratedEnabled = true
  } catch (e) {
    // 迁移失败不阻断启动（与 step1 同模式），warn + 下次重试
    console.warn('[runtime] migrateProviderEnabledToWhitelist failed:', e)
  }

  return report
}

/**
 * 启动期编排：step1（catalog 错位 apiKey → auth.json）+ step2（provider.enabled → enabledModels）。
 *
 * 顺序：step2 先跑（MF1 修复，exec-review must-fix）。原因：step1 对无 override 的 catalog provider
 * 「写最小 {name,api,baseUrl} 条目」（step1 预存变通）会丢弃 enabled 字段，若 step1 先跑则 step2
 * 读不到 enabled → 启停状态丢失（G5 核心场景：catalog+apiKey+enabled+无override）。step2 先读 enabled
 * 迁 enabledModels + 删字段，再 step1 处理 apiKey（操作 models.json，settings.json 的 enabledModels
 * 不受影响），确保 G5 覆盖。两步各自 try/catch，互不阻断。
 *
 * @param authStorage AuthStorage 实例（读侧；写入经 credentialWriter）
 * @param credentialWriter auth.json 凭据写通道（A1-4 收口）
 */
export async function migrateProviderConfig(
  configStore: IConfigStore,
  authStorage: Pick<AuthStorage, 'get'>,
  credentialWriter: CredentialWriter,
): Promise<ProviderConfigMigrationReport> {
  const enabled = await migrateProviderEnabledToWhitelist(configStore)
  const catalog = await migrateLegacyProviderConfig(configStore, authStorage, credentialWriter)
  return { catalog, enabled }
}
