/**
 * Provider 导入器（IF2/IF3 落地）—— previewImport + applyImport 两步数据流。
 *
 * 安全红线（DM1）：**API key 明文绝不进前端**。
 *   - previewImport 返回脱敏 ProviderImportPreview（只 apiKeyExtracted 布尔，无 key 值）。
 *   - 完整配置（含 apiKey 明文）只活在 preview-cache（runtime 内存），applyImport 据此写 models.json。
 *
 * 数据流：
 *   Step1 previewImport(source):
 *     parseProviders(source, homeDir) → ParsedProvider[](含 apiKey 明文 + _ 元数据)
 *     → createPreview(source, providers) 存缓存，得 importId
 *     → 读现有 models.json provider ids 做冲突检测
 *     → 返回脱敏 preview（_sourceName → id/name，apiKeyExtracted 布尔，conflict 标记）
 *   Step2 applyImport(importId, selectedIds):
 *     consumePreview(importId) 取完整配置（过期则 PREVIEW_EXPIRED）
 *     → apply 时再次查冲突（preview 后 models.json 可能被改）
 *     → 逐个 upsertProvider（剥离 _ 前缀元数据）
 *     → 全成功才删缓存（一次性）；部分失败保留缓存供重试（W4/W5）
 *     → 返回 ProviderImportResult（imported/skipped/failed 三态条目 + failedCount）
 *
 * provider id 语义：_sourceName 是源里的 provider 名（如 Pi 的 'deepseek-router'），
 * 导入后作为 taiji models.json 的 provider id（不重命名）。
 *
 * coding-plan 额度显示自动开启（导入即默认同意）：apply 成功且凭证为明文的条目，若按
 * 完整数据命中 api-key 类 QuotaPreset，则向 providers.json extras 写 quota
 * { enabled: true, fetcher }（用户可随时在设置里关闭；skipped 条目不动）。见
 * matchAutoEnablePreset / autoEnableQuotaDisplay。
 *
 * 日志安全：preview/apply 的日志只记 importId/source/status/count，不记 apiKey（DM1）。
 */
import { homedir } from 'node:os'
import type {
  ProviderSource,
  ProviderImportPreview,
  ProviderPreviewItem,
  ProviderPreviewOrphanItem,
  ProviderImportResult,
  ProviderImportedItem,
  BuiltinProviderTemplate,
} from '@taiji/shared'
import { getProviderNames, upsertProvider, ensureProviderInWhitelist, type PiProviderConfig } from '../../infra/pi/pi-provider-store.js'
import { createPreview, consumePreview, deletePreview } from './preview-cache.js'
import { parseProviders } from './provider-parser.js'
import type { ParseResult, ParsedProvider, ParsedOrphanCredential } from './provider-parser.js'
// sa3 F1：内置 provider 模板（B4 铁律——只取 name/api/baseUrl 补全定义，**不复制 models**，
// 内置 model 由 pi catalog 无条件加载，复制会与内置升级漂移）。
import builtinData from '../../generated/builtin-providers.json'
import { isCatalogProvider } from '../provider-catalog.js'
// 防线载体（设计 D1）：importer 直调 infra upsertProvider，不经过 setProvider——两条主路径
// （applyProviderEntry / applyOrphanWithTemplate）都在 upsert 前接载体，防线落在写入点。
import { applyProviderWritePolicy, type ProviderWriteKind } from '../provider-config-helper.js'
import type { CredentialWriter } from '../auth/auth-storage.js'
import { matchQuotaPreset } from '@taiji/shared'
import type { QuotaPreset } from '@taiji/shared'
import type { TaijiProviderStore } from '../provider-extras-store.js'

/**
 * catalog provider 导入在 credentialWriter 未注入时的降级 reason（设计 D1④）。
 * catalog 定义来自 pi 内置 catalog、凭据只允许落 auth.json（0600）——无写入通道时
 * 宁丢不写错位，不再把模板 artifact（api/baseUrl）或 apiKey 写进 models.json。
 * imported 状态语义保持只对真实落盘成立。
 */
const CATALOG_CREDENTIAL_WRITER_UNAVAILABLE =
  'built-in provider import requires credential writer: configure credentials via the settings UI'

/**
 * coding-plan 额度显示自动开启的 extras 写入通道（可选注入，对齐 credentialWriter 先例）。
 * 生产由 ConfigService.applyImportProviders 传入 providerExtrasStore（providers.json 唯一
 * 读写者）；未注入（部分测试场景）时跳过写入，不影响导入主语义。
 */
type QuotaExtrasWriter = Pick<TaijiProviderStore, 'modify'>

/**
 * 判定「导入即默认同意」是否适用（coding-plan 额度显示自动开启）：返回应落盘的 preset，
 * 不适用返回 undefined。四个条件缺一不可：
 * - credentialType === 'plaintext'：env/command 落盘的是占位串（$VAR / !command，由 pi
 *   运行时解析），quota 凭证链读原始串不解占位——自动开启只会得到查询失败；明文 key 即刻可用
 * - matchQuotaPreset 命中：用导入的完整数据（baseUrl/name）匹配，与脱敏 preview 无关。
 *   name 取 provider.name ?? _sourceName，与 listProviders custom 侧的 name 派生一致
 * - preset.auth 含 'api-key'：凭证复用 provider 自己的 key（credentialSource 缺省推导
 *   'provider' → auth.json → models.json，正是导入落盘位置）。cookie 类（mimo / opencode-go）
 *   不适用——导入不提取 cookie，自动开启只会得到 no-credential 失败态
 * - 非 requiresWorkspace：资源维度 fetcher（opencode-go）还需 workspace 配置才算齐备
 */
function matchAutoEnablePreset(
  provider: { baseUrl?: string; name?: string },
  credentialType: ParsedProvider['_credentialType'],
): QuotaPreset | undefined {
  if (credentialType !== 'plaintext') return undefined
  const preset = matchQuotaPreset(provider)
  if (!preset) return undefined
  if (!preset.auth.includes('api-key')) return undefined
  if (preset.requiresWorkspace) return undefined
  return preset
}

/**
 * extras 落盘 quota（merge 语义：保留 authMethod/modelStates 与既有 quota 字段，只写
 * enabled + fetcher）。fetcher 显式落盘的必要性：catalog provider（如 zai-coding-cn /
 * kimi-coding 孤儿凭据场景）无 models.json 条目，fetch 侧 getFetcherForProvider 的
 * baseUrl/name 自动匹配读不到定义——与手动配置路径一致（useQuotaConfigure 保存时也显式
 * 传 fetcher）。credentialSource 刻意不写：缺省推导 'provider'（复用导入落盘的 provider
 * key），不制造 secrets 中间态。
 *
 * 返回写入是否成功：成功才在结果条目置 quotaAutoEnabled（前端 toast 依据），失败只 warn
 * （best-effort：导入主语义已成功，额度显示可在设置里手动配置）。
 */
async function autoEnableQuotaDisplay(store: QuotaExtrasWriter, providerId: string, fetcherId: string): Promise<boolean> {
  try {
    await store.modify(providerId, current => ({
      ...current,
      quota: { ...current?.quota, enabled: true, fetcher: fetcherId },
    }))
    return true
  } catch (err) {
    // best-effort 降级（非 silent-catch）：导入主语义（provider 定义+凭据+白名单）已成功，
    // 额度显示缺失属可恢复态（设置里手动配置即可）；在此中断/回滚反而让导入结果与磁盘态背离。
    console.warn(`[provider-importer] auto-enable quota display failed for ${providerId}:`, err)
    return false
  }
}

/**
 * previewImport 的成功返回（importId 供 Step2 applyImport 用 + 脱敏 preview 供前端渲染）。
 */
export interface PreviewImportSuccess {
  importId: string
  preview: ProviderImportPreview
}

/**
 * previewImport/applyImport 的错误返回（前端按 error.code 分流，error.message 展示）。
 */
export interface ImportError {
  error: { code: string; message: string }
}

/**
 * applyImport 的成功返回。
 */
export interface ApplyImportSuccess {
  result: ProviderImportResult
}

/**
 * 孤儿凭据 → 内置模板匹配（sa3 F1，B.3）。
 *
 * 按 providerId 在 builtin-providers.json 中查找（如 auth.json 的 'openai' → OpenAI 模板）。
 * 生成物损坏（非数组/缺 id）时返回 undefined（与 config-service listBuiltinProviders 同降级策略）。
 */
function matchBuiltinTemplate(providerId: string): BuiltinProviderTemplate | undefined {
  const raw = builtinData.providers
  if (!Array.isArray(raw)) return undefined
  return raw.find((p) => p && typeof p === 'object' && p.id === providerId) as BuiltinProviderTemplate | undefined
}

/** 孤儿凭据的 apiKeyExtracted 计算（与组 1 的 _apiKeyExtracted 同规则：plaintext/env/command=true）。 */
function orphanKeyExtracted(credentialType: ProviderPreviewOrphanItem['credentialType']): boolean {
  return credentialType === 'plaintext' || credentialType === 'env' || credentialType === 'command'
}

/**
 * Step1：预览导入。
 *
 * 解析源配置 → 存缓存（得 importId）→ 冲突检测 → 返回脱敏 preview。
 *
 * @param source 迁移源（pi/zcode/codex/claude）。
 * @param homeDir 用户主目录（默认 process.env.HOME || os.homedir()）。
 * @returns 成功 { importId, preview }；源未安装 { error: { code: 'SOURCE_NOT_INSTALLED' } }。
 *
 * 安全：返回的 preview.providers 只含 apiKeyExtracted 布尔，**不含 apiKey 值**；
 * 组 2（orphanCredentials）同样脱敏，只含 credentialType/envVarName/占位信息（B.5）。
 */
export function previewImport(
  source: ProviderSource,
  homeDir: string = process.env.HOME || homedir(),
): PreviewImportSuccess | ImportError {
  const parsed = parseProviders(source, homeDir)
  if (!parsed) {
    return { error: { code: 'SOURCE_NOT_INSTALLED', message: `${source} not installed (source config directory not found)` } }
  }

  // 存完整配置（含 apiKey 明文）到内存缓存，得 importId
  const importId = createPreview(source, parsed.providers, parsed.orphanCredentials ?? [])

  // 冲突检测：读现有 models.json provider ids
  const existingIds = new Set(getProviderNames())

  // 构造脱敏 preview（关键：不含 apiKey 值，只留 apiKeyExtracted 布尔 + credentialType 六态）
  const items = buildPreviewItems(parsed.providers, existingIds)

  // ══ sa3 F1：孤儿凭据 → 组 2（B.3）══（匹配/未匹配分流见 collectOrphanPreviewItems）
  const { orphanItems, extraWarnings } = collectOrphanPreviewItems(parsed.orphanCredentials ?? [])

  // 日志只记 id/source/count（不记 apiKey，DM1）
  console.log(`[provider-importer] preview source=${source} importId=${importId} providerCount=${items.length} orphanCount=${orphanItems.length}`)

  return { importId, preview: buildPreviewPayload(source, parsed, items, orphanItems, extraWarnings) }
}

/**
 * 组 1 脱敏项构造：ParsedProvider → ProviderPreviewItem（不含 apiKey 值，DM1）。
 */
function buildPreviewItems(providers: ParsedProvider[], existingIds: Set<string>): ProviderPreviewItem[] {
  return providers.map((p) => ({
    id: p._sourceName,
    name: p._sourceName,
    protocol: p.api ?? 'unknown',
    modelCount: p.models?.length ?? 0,
    // parser 已按 credentialType 计算 _apiKeyExtracted（computed：plaintext/env/command 时 true；
    // env-bundle 有凭据但 Phase 1 不支持落盘，为 false——preview 语义「有凭据但跳过」），直接透传
    apiKeyExtracted: p._apiKeyExtracted,
    credentialType: p._credentialType,
    ...(p._envVarName !== undefined ? { envVarName: p._envVarName } : {}),
    conflict: existingIds.has(p._sourceName) ? 'duplicate-id' : 'none',
    warnings: p._warnings,
  }))
}

/**
 * 组 2 构造（sa3 F1，B.3）：孤儿凭据逐条匹配内置模板。
 *
 * auth.json 有、models.json 无定义的 providerId（pi 内置 provider 的凭据）：
 * - 匹配到内置模板 → 组 2 可勾选项（凭据 + 模板补全定义）
 * - 匹配不到 → 顶层 warning「未识别的凭据，无法匹配内置模板，跳过」（B.6）
 */
function collectOrphanPreviewItems(
  orphanCredentials: ParsedOrphanCredential[],
): { orphanItems: ProviderPreviewOrphanItem[]; extraWarnings: string[] } {
  const orphanItems: ProviderPreviewOrphanItem[] = []
  const extraWarnings: string[] = []
  for (const oc of orphanCredentials) {
    const tpl = matchBuiltinTemplate(oc.providerId)
    if (!tpl) {
      extraWarnings.push(`credential ${oc.providerId}: no built-in template match, skipped`)
      continue
    }
    orphanItems.push({
      providerId: oc.providerId,
      name: tpl.name,
      credentialType: oc.credentialType,
      ...(oc.envVarName !== undefined ? { envVarName: oc.envVarName } : {}),
      builtinTemplateMatched: true,
      modelCount: tpl.modelCount ?? tpl.models?.length ?? 0,
      modelNames: (tpl.models ?? []).map((m) => m.id),
      apiKeyExtracted: orphanKeyExtracted(oc.credentialType),
      warnings: oc.warnings,
    })
  }
  return { orphanItems, extraWarnings }
}

/**
 * preview 顶层 payload 组装：组 1 / parseError / 合并 warnings / 组 2（有项才出字段，shared SSOT 可选字段）。
 */
function buildPreviewPayload(
  source: ProviderSource,
  parsed: ParseResult,
  items: ProviderPreviewItem[],
  orphanItems: ProviderPreviewOrphanItem[],
  extraWarnings: string[],
): ProviderImportPreview {
  return {
    source,
    providers: items,
    ...(orphanItems.length > 0 ? { orphanCredentials: orphanItems } : {}),
    // B2：透出 parseError 和顶层 warnings（即使 providers 非空，parseError 也可能存在——
    // 部分损坏场景）。ProviderImportPreview 的 parseError/warnings 是可选字段（shared SSOT）。
    ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    ...(parsed.warnings?.length || extraWarnings.length ? { warnings: [...(parsed.warnings ?? []), ...extraWarnings] } : {}),
  }
}

/**
 * W1 输入校验（防 WS 异常 payload 导致 crash）。非法返回 ImportError，合法返回 null。
 */
function validateApplyRequest(importId: unknown, selectedIds: unknown): ImportError | null {
  if (typeof importId !== 'string' || !importId.trim()) {
    return { error: { code: 'INVALID_REQUEST', message: 'importId is required' } }
  }
  if (!Array.isArray(selectedIds) || !selectedIds.every((id) => typeof id === 'string')) {
    return { error: { code: 'INVALID_REQUEST', message: 'selectedIds must be a string array' } }
  }
  return null
}

/**
 * 组 1 单条处理：models.json 已定义的 provider（分体系处理）。
 *
 * 返回 null = 未勾选（不产生条目）；否则返回 imported/skipped/failed 三态条目之一。
 */
async function applyProviderEntry(
  provider: ParsedProvider,
  selectedIds: string[],
  existingIds: Set<string>,
  credentialWriter: CredentialWriter | undefined,
): Promise<ProviderImportedItem | null> {
  // 只处理用户勾选的 provider
  if (!selectedIds.includes(provider._sourceName)) return null

  // 冲突跳过（不覆写已存在的同名 provider）
  if (existingIds.has(provider._sourceName)) {
    return { id: provider._sourceName, name: provider._sourceName, status: 'skipped', reason: 'duplicate' }
  }

  // catalog 分路：pi 内置 provider 定义的秘钥归 auth.json，不建 models.json 条目
  if (isCatalogProvider(provider._sourceName) && credentialWriter) {
    try {
      if (provider.apiKey && provider.apiKey !== '') {
        await credentialWriter.saveCredential(provider._sourceName, { type: 'api_key', key: provider.apiKey })
      }
      // catalog 提供定义——即使无 apiKey 也标记 imported（catalog 定义即可用）
      return { id: provider._sourceName, name: provider._sourceName, status: 'imported' }
    } catch (e) {
      return {
        id: provider._sourceName,
        name: provider._sourceName,
        status: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      }
    }
  }

  // 自定义 provider 或 credentialWriter 未注入：写 models.json（经防线载体转译）
  try {
    // 剥离 _ 前缀元数据（对象解构，剩余即干净的 PiProviderConfig）
    const {
      _sourceName, _apiKeyExtracted, _credentialType, _envVarName, _warnings,
      // 载体托管的字段单独取出：name/baseUrl/apiKey/api/models 由 applyProviderWritePolicy
      // 按 kind + source 语义转译后写回；其余字段（headers/compat/modelOverrides/authMethod 等）
      // 原样透传（rest）——不经过载体托管的面保持导入的完整语义。
      name, baseUrl, apiKey, api, models,
      ...rest
    } = provider
    const kind: ProviderWriteKind = isCatalogProvider(_sourceName) ? 'catalog' : 'custom'
    const merged: Record<string, unknown> = { ...rest }
    // models 归一为自由 record（载体入参形态）：spread 出匿名对象类型才具隐式索引签名
    const modelEntries = models?.map((m) => ({ ...m }))
    // 防线载体（设计 D1④）：source='import' 时 catalog 的 provider 级 api/baseUrl 一律剥除
    // （导入数据不是用户在 UI 显式设置的网关，不产生隐形网关）；空串转译同 settings 路径。
    const { skipUpsert } = applyProviderWritePolicy(
      merged,
      { name, baseUrl, apiKey, api, models: modelEntries },
      kind,
      'import',
      _sourceName,
    )
    if (skipUpsert) {
      // 防线③ 不物化空壳：剥除/转译后无实质字段（八字段全缺）→ 不落盘。
      // catalog 在 credentialWriter 未注入时 API key 本也无处安放（宁丢不写错位）——
      // imported 状态语义只对真实落盘成立，故报 failed 并引导经 UI 配置凭据。
      return {
        id: _sourceName,
        name: _sourceName,
        status: 'failed',
        reason: kind === 'catalog' ? CATALOG_CREDENTIAL_WRITER_UNAVAILABLE : 'nothing to import',
      }
    }
    // as 断言约定见 applyProviderWritePolicy JSDoc「维护约定」（形状安全由载体字段族保证）
    upsertProvider(_sourceName, merged as PiProviderConfig)
    return { id: _sourceName, name: _sourceName, status: 'imported' }
  } catch (e) {
    return {
      id: provider._sourceName,
      name: provider._sourceName,
      status: 'failed',
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 组 2 单条处理：孤儿凭据（sa3 F1）——冲突检查 + 内置模板匹配，落盘见 applyOrphanWithTemplate。
 *
 * 返回 null = 未勾选（不产生条目）。
 */
async function applyOrphanCredential(
  oc: ParsedOrphanCredential,
  selectedIds: string[],
  existingIds: Set<string>,
  credentialWriter: CredentialWriter | undefined,
): Promise<ProviderImportedItem | null> {
  if (!selectedIds.includes(oc.providerId)) return null

  // 冲突跳过（preview 后 models.json 可能已有该 id）
  if (existingIds.has(oc.providerId)) {
    return { id: oc.providerId, name: oc.providerId, status: 'skipped', reason: 'duplicate' }
  }

  const tpl = matchBuiltinTemplate(oc.providerId)
  if (!tpl) {
    return { id: oc.providerId, name: oc.providerId, status: 'failed', reason: 'no built-in template match' }
  }

  return applyOrphanWithTemplate(oc, tpl, credentialWriter)
}

/**
 * 孤儿凭据按内置模板落盘（分体系处理：catalog → auth.json，否则 → models.json 模板）。
 */
async function applyOrphanWithTemplate(
  oc: ParsedOrphanCredential,
  tpl: BuiltinProviderTemplate,
  credentialWriter: CredentialWriter | undefined,
): Promise<ProviderImportedItem> {
  // catalog 分路：孤儿凭据本质是 pi catalog provider 的 auth.json 凭据
  if (isCatalogProvider(oc.providerId) && credentialWriter) {
    try {
      if (oc.apiKey !== undefined && oc.apiKey !== '') {
        await credentialWriter.saveCredential(oc.providerId, { type: 'api_key', key: oc.apiKey })
      }
      return { id: oc.providerId, name: oc.providerId, status: 'imported' }
    } catch (e) {
      return {
        id: oc.providerId,
        name: oc.providerId,
        status: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      }
    }
  }

  // credentialWriter 未注入时的降级：catalog provider 定义来自 pi 内置 catalog，凭据只允许
  // 落 auth.json（0600）——无写入通道时无处安放，宁丢不写错位（设计 D1④）：不再把模板
  // artifact（tpl.api/tpl.baseUrl）与 config.apiKey 写进 models.json，返回 failed 引导
  // 用户经 UI 配置凭据（imported 状态语义只对真实落盘成立，不再有「写模板进 models.json」的降级）。
  if (isCatalogProvider(oc.providerId)) {
    return {
      id: oc.providerId,
      name: oc.providerId,
      status: 'failed',
      reason: CATALOG_CREDENTIAL_WRITER_UNAVAILABLE,
    }
  }

  // 非 catalog 孤儿凭据：写 models.json 模板（经防线载体转译，source='import'）
  try {
    const merged: Record<string, unknown> = {}
    const { skipUpsert } = applyProviderWritePolicy(
      merged,
      { name: tpl.name, api: tpl.api, baseUrl: tpl.baseUrl, apiKey: oc.apiKey },
      'custom',
      'import',
      oc.providerId,
    )
    if (!skipUpsert) {
      // as 断言约定见 applyProviderWritePolicy JSDoc「维护约定」（形状安全由载体字段族保证）
      upsertProvider(oc.providerId, merged as PiProviderConfig)
      return { id: oc.providerId, name: oc.providerId, status: 'imported' }
    }
    // 模板无实质字段（八字段全缺）→ 不物化空壳，也不谎报 imported
    return { id: oc.providerId, name: oc.providerId, status: 'failed', reason: 'nothing to import' }
  } catch (e) {
    return {
      id: oc.providerId,
      name: oc.providerId,
      status: 'failed',
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * S6：selectedIds 中不在 imported 条目里的 id（既没 imported 也没 skipped/failed，
 * 即不在 preview 里的）补一条 failed 条目，让用户有反馈。
 */
function collectMissingIdsAsFailed(selectedIds: string[], imported: ProviderImportedItem[]): void {
  const handledIds = new Set(imported.map((i) => i.id))
  for (const id of selectedIds) {
    if (!handledIds.has(id)) {
      imported.push({ id, name: id, status: 'failed', reason: 'not found in preview' })
    }
  }
}

/**
 * 边界1（wave3 TC5 / C2）：为本次导入的新 provider 加 enabledModels 白名单守卫。
 *
 * 若 enabledModels 非空（用户已显式启用某些 provider），新 provider 默认不启用——补 <id>/*
 * 让其可用。ensureProviderInWhitelist 内部判空（全可用时 no-op）+ 幂等。catalog（auth.json）
 * 与 custom（models.json）两类导入统一处理（listProviders 双源聚合都会派生 enabled）。
 */
function ensureWhitelistForImported(imported: ProviderImportedItem[]): void {
  for (const item of imported) {
    if (item.status === 'imported') {
      ensureProviderInWhitelist(item.id)
    }
  }
}

/**
 * Step2：应用导入（写入 models.json）。
 *
 * 从缓存取完整配置 → apply 时再次查冲突 → 逐个 upsertProvider（剥离 _ 元数据）→ 全成功才删缓存。
 *
 * W1：入口加输入校验（防 WS 异常 payload 导致 crash）。
 * W4/W5：部分失败保留缓存供用户重试（重试时 conflict 检测会让已导入的 skipped）；全成功才删。
 * S6：selectedIds 中既未 imported 也未 skipped/failed 的 id（不在 preview 里的）补一条 failed 条目。
 *
 * @param importId Step1 previewImport 返回的 importId。
 * @param selectedIds 用户勾选导入的 provider id 列表（对应 _sourceName）。
 * @param credentialWriter catalog 分路的凭据写入通道（A1-4，见上）。
 * @param quotaExtrasStore providers.json 写通道（可选）：导入成功的条目命中 api-key 类
 *          QuotaPreset 且凭证为明文时，写 quota { enabled: true, fetcher } 自动开启
 *          coding-plan 额度显示（导入即默认同意，用户可关闭；skipped/failed 不动）。
 *          未注入时跳过（部分测试场景）。
 * @returns 成功 { result }；缓存过期/不存在 { error: { code: 'PREVIEW_EXPIRED' } }；
 *          入参非法 { error: { code: 'INVALID_REQUEST' } }。
 *
 * 安全：upsertProvider 写入的 config 不含 _ 前缀元数据（对象解构剥离）；apiKey 明文从缓存透传。
 */
export async function applyImport(
  importId: string,
  selectedIds: string[],
  // A1-4 收口：catalog 分路写凭据经 CredentialWriter（AuthService.saveCredential），
  // 不再直接持有 authStorage.set——auth.json 写入唯一入口在 AuthService。
  credentialWriter?: CredentialWriter,
  quotaExtrasStore?: QuotaExtrasWriter,
): Promise<ApplyImportSuccess | ImportError> {
  // W1：输入校验（防 WS 异常 payload 导致 crash）
  const validationError = validateApplyRequest(importId, selectedIds)
  if (validationError) return validationError

  const entry = consumePreview(importId)
  if (!entry) {
    return { error: { code: 'PREVIEW_EXPIRED', message: '预览已过期或不存在，请重新检测' } }
  }

  // apply 时再次查冲突（preview 后 models.json 可能被改）
  const existingIds = new Set(getProviderNames())
  const imported: ProviderImportedItem[] = []
  // 自动开启额度显示的目标（决策用完整数据在此收集，写入在主流程成功后统一执行；
  // 携带结果条目引用——写成功才置 quotaAutoEnabled，前端 toast 据此提示）
  const autoEnableTargets: Array<{ item: ProviderImportedItem; fetcher: string }> = []

  // ══ 组 1：models.json 已定义的 provider（分体系处理）══
  for (const provider of entry.providers) {
    const item = await applyProviderEntry(provider, selectedIds, existingIds, credentialWriter)
    if (!item) continue
    imported.push(item)
    if (item.status === 'imported') {
      const preset = matchAutoEnablePreset(
        { baseUrl: provider.baseUrl, name: provider.name ?? provider._sourceName },
        provider._credentialType,
      )
      if (preset) autoEnableTargets.push({ item, fetcher: preset.fetcher })
    }
  }

  // ══ 组 2：孤儿凭据（sa3 F1，分体系处理：catalog → auth.json，否则 → models.json 模板）══
  for (const oc of entry.orphanCredentials) {
    const item = await applyOrphanCredential(oc, selectedIds, existingIds, credentialWriter)
    if (!item) continue
    imported.push(item)
    if (item.status === 'imported') {
      // 决策用模板的完整定义（baseUrl/name），凭证形态用 oc 的六态判定
      const tpl = matchBuiltinTemplate(oc.providerId)
      const preset = tpl
        ? matchAutoEnablePreset({ baseUrl: tpl.baseUrl, name: tpl.name }, oc.credentialType)
        : undefined
      if (preset) autoEnableTargets.push({ item, fetcher: preset.fetcher })
    }
  }

  // S6：selectedIds 中不在 imported 条目里的 id 补 failed 条目（不在 preview 里的给用户反馈）
  collectMissingIdsAsFailed(selectedIds, imported)

  // W4/W5：全成功才删缓存（一次性）；部分失败保留缓存供用户重试
  // （重试时 conflict 检测会让已导入的 skipped，未导入的可继续尝试）
  const failedCount = imported.filter((i) => i.status === 'failed').length
  if (failedCount === 0) {
    deletePreview(importId)
  }

  // 边界1（wave3 TC5 / C2）：白名单守卫
  ensureWhitelistForImported(imported)

  // coding-plan 额度显示自动开启（导入即默认同意）：只对本次真实落盘（imported）的条目；
  // skipped（duplicate）不动——不覆盖用户对既存 provider 的配置。写入必须在本函数返回前
  // 完成：handler 随后广播 provider 列表，闸门（renderer quota.enabled）直接消费本次写值。
  // 写成功才在结果条目置 quotaAutoEnabled（写失败不置位，前端不 toast 不实报告）。
  for (const target of autoEnableTargets) {
    if (quotaExtrasStore && await autoEnableQuotaDisplay(quotaExtrasStore, target.item.id, target.fetcher)) {
      target.item.quotaAutoEnabled = true
    }
  }

  // 日志只记 id/source/status/count（不记 apiKey，DM1）
  const importedCount = imported.filter((i) => i.status === 'imported').length
  const skippedCount = imported.filter((i) => i.status === 'skipped').length
  const autoEnabledLog = quotaExtrasStore ? autoEnableTargets.length : 0
  console.log(
    `[provider-importer] apply source=${entry.source} importId=${importId} imported=${importedCount} skipped=${skippedCount} failed=${failedCount} quotaAutoEnabled=${autoEnabledLog}`,
  )

  return { result: { source: entry.source, imported, failedCount } }
}
