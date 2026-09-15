/**
 * enabledModels 白名单读写 helper（从 pi-provider-store.ts 抽出，控 max-lines 500）。
 *
 * 职责：settings.json.enabledModels 白名单的读写 + 边界守卫（ensureProviderInWhitelist
 * 新建 provider 守卫、cleanEnabledModelsResidue 移除 provider 残留清理）。
 *
 * 抽出原因：pi-provider-store.ts 超 ESLint max-lines(500)。本模块只经 settings.json
 *（readSettings/updateSettingsFields），不碰 modelsStore 模块级缓存，移到本模块后
 * pi-provider-store 经 barrel re-export 保 import 路径不变，行为 / 签名零变化。
 */
import { readSettings, updateSettingsFields } from './pi-settings-store.js'

export function getEnabledModels(): string[] {
  return readSettings().enabledModels ?? []
}

export function setEnabledModels(patterns: string[]): void {
  updateSettingsFields('model', s => { s.enabledModels = patterns })
}

/**
 * 删除 settings.json.enabledModels 字段（wave3 边界3 / CL2）。
 *
 * pi 白名单语义：空 = 全可用。若用 setEnabledModels([]) 写入空数组，语义不变（readSettings
 * 仍得 []，deriveEnabled 返回全 true），但「显式空数组」与「未设置」在配置语义上有歧义，
 * 且 belt-and-suspenders 要求 runtime 层让 settings.json 物理上无此字段——故用 delete 而非写 []。
 * JSON.stringify 丢弃 undefined 字段，故 updateSettingsFields(delete) 后落盘的 settings.json
 * 不含 enabledModels key（与从未设置过不可区分）。
 */
export function clearEnabledModels(): void {
  updateSettingsFields('model', s => { delete s.enabledModels })
}

/**
 * 边界1 守卫（wave3 TC5 / C2）：若 enabledModels 已非空（用户显式启用某些 provider），
 * 加 `${providerId}/*` 让新 provider 默认启用；空/undefined 时 no-op（全可用语义，新 provider 默认可用）。
 *
 * 调用点：importer applyImport 新建 provider 后、setProvider 新建 provider（existing 为空）时。
 * 幂等：pattern 已在白名单时不重复添加。
 */
export function ensureProviderInWhitelist(providerId: string): void {
  const current = getEnabledModels()
  // 空/undefined = 全可用，不加 pattern（加了反而把其他 provider 隐式禁用）
  if (current.length === 0) return
  const pattern = `${providerId}/*`
  if (current.includes(pattern)) return
  setEnabledModels([...current, pattern])
}

/**
 * 清除 enabledModels 白名单中某 provider 的残留 pattern（wave4 IF3 / C3）。
 *
 * removeProviderByKind 两分支共用：删 provider / 清凭据后，白名单里 `<id>/*` 与
 * `<id>/<model>` pattern 成了死引用，必须一并清掉，否则 pi 仍会尝试匹配已不存在的 provider。
 *
 * 语义与 toggleProviderEnabled(false) 的过滤段同构（startsWith('<id>/') 统一匹配 provider 级
 * 与 model 级 pattern，带斜杠防 openai vs openai-compatible 前缀碰撞）：
 *   - filter 后非空 → setEnabledModels(remaining)
 *   - filter 后空 → clearEnabledModels（边界3(a) 空数组守卫，CL2——delete 字段而非写空数组）
 *   - 无 pattern 被移除（provider 本就不在白名单）→ 幂等 no-op
 */
export function cleanEnabledModelsResidue(providerId: string): void {
  const current = getEnabledModels()
  if (current.length === 0) return // 全可用语义，本就无残留
  const prefix = `${providerId}/`
  const remaining = current.filter(p => !p.startsWith(prefix))
  if (remaining.length === current.length) return // 幂等：无 pattern 被移除
  if (remaining.length === 0) {
    clearEnabledModels()
  } else {
    setEnabledModels(remaining)
  }
}
