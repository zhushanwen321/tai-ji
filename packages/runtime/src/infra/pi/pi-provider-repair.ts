/**
 * Provider 有效性校验 helper（从 pi-provider-store.ts 抽出，控 max-lines 500）。
 *
 * 职责：判定 provider 是否无效（空壳 provider 会被 pi 的 provider 组合层拒绝）。
 * isInvalidProvider 是纯函数，供 sanitizeInvalidProviders 启动时剔除空壳 provider 用。
 *
 * 抽出原因：pi-provider-store.ts 超 ESLint max-lines(500)。本模块只含纯校验函数
 *（不碰 modelsStore 模块级缓存）；sanitizeInvalidProviders 依赖 modelsStore.invalidate +
 * writeModels + builtinModelsById，仍留 pi-provider-store（架构约定：modelsStore 读写类
 * 函数留 store）。pi-provider-store 经 barrel re-export 保 import 路径不变，行为零变化。
 */
import type { PiProviderConfig } from './pi-provider-store.js'

/**
 * 判定 provider 是否无效（pi provider 组合层会拒绝加载）。
 *
 * [W1b 语义变更] 判定对齐 pi 0.84.1 `applyModelsJson` 的 "must specify" 抛错条件
 * （node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js:86-93，
 * 调用方 composeModelProvider :285/:293）：models / baseUrl / headers / compat /
 * modelOverrides / apiKey / oauth / authHeader 八字段任一在场即合法，全空才算无效（空壳）。
 *
 * 出处（旧判定 = pi 0.80.3 五字段语义，勿回退）：本函数曾对齐 0.80.3 的判定——报错原文
 * 只列 "baseUrl", "headers", "compat", "modelOverrides", "models" 五字段，apiKey/oauth/
 * authHeader 不在名单。0.84.1 已放宽为八字段任一在场即合法；沿用五字段判定导致只配
 * apiKey 的合法 provider 被 sanitizeInvalidProviders 从 models.json 物理删除（数据丢失
 * 级 bug，审计 A-02 / W1b 修复）。
 *
 * known-issue（D2 决策，不追溯恢复）：曾在本 bug 下被误删的 provider 配置不回滚、不迁移
 * ——修复只保证今后不删，受影响用户需手动重配。
 *
 * 逐字段与 pi 抛错条件同构对照（条件顺序对齐 dist :86-93，便于逐行核对）：
 * - models：pi `!config.models?.length`（非空数组才算在场）↔ Array.isArray && length>0
 *   （空数组无法提供任何模型，与 undefined 等效）
 * - baseUrl：falsiness（pi `!config.baseUrl`；空串另被 schema 层 minLength:1 拒绝，
 *   model-config.js:170-173，但那是 schema 层，不影响本判定按 falsiness 视同未 specify）
 * - headers：falsiness（pi `!config.headers`，空对象 {} 为 truthy → 在场）
 * - compat：falsiness（pi `!config.compat`）
 * - modelOverrides：pi `Object.keys(...).length > 0`（空对象不算在场）
 * - apiKey：falsiness（pi `!config.apiKey`）[W1b 新增]
 * - oauth：falsiness（pi `!config.oauth`）[W1b 新增]
 * - authHeader：pi 检查 `config.authHeader === undefined`——显式 false 也算"在场"即合法
 *   [W1b 新增]，本函数同构用 `=== undefined`（不用 falsiness）
 *
 * schema 层锚点（0.84.4 实装，供逐行核对）：校验器为 TypeBox 非 zod
 * （dist/core/model-config.js:3-4 导入 Type/Compile，ProviderConfigSchema 编译于 :184）；
 * provider 级 minLength:1 字段 name/baseUrl/apiKey/api 在 :170-173，模型级
 * id/name/api/baseUrl 在 :137-140，modelOverrides 级 name 在 :152。
 *
 * compat 与 oauth 是 pi 端 provider 级字段（taiji PiProviderConfig 未声明 compat；
 * oauth 的 TypeBox schema 为 Type.Literal("radius")，model-config.js:174），运行时脏数据
 * 可能含，用宽松键检查（as Record<string, unknown>）不遗漏。
 *
 * 边界：pi 对 `oauth && !baseUrl` 另有独立抛错（provider-composer.js:82-84），该条件
 * **不纳入**无效判定——sanitize 只清空壳，跨字段约束留给 pi 组合层自行报错，避免
 * sanitize 成为新的误删源。
 *
 * 非对象值（null/string/number）：pi TypeBox ProviderConfigSchema 直接拒绝 → 无效（M2 回归）。
 */
export function isInvalidProvider(provider: PiProviderConfig): boolean {
  if (typeof provider !== 'object' || provider === null) return true
  const raw = provider as Record<string, unknown>
  const hasModels = Array.isArray(raw.models) && raw.models.length > 0
  const hasOverrides =
    typeof raw.modelOverrides === 'object' &&
    raw.modelOverrides !== null &&
    Object.keys(raw.modelOverrides as object).length > 0
  return (
    !hasModels &&
    !raw.baseUrl &&
    !raw.headers &&
    !raw.compat &&
    !hasOverrides &&
    !raw.apiKey &&
    !raw.oauth &&
    raw.authHeader === undefined
  )
}
