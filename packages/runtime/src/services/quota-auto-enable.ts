/**
 * coding-plan 额度显示自动开启（「默认同意」语义）—— 导入（provider-importer）与新增
 * provider（provider-config-helper.setProvider 新建分支）共用的判定 + 落盘。
 *
 * 设计依据：docs/architecture/v3-specs/coding-plan-quota/design.md §2.2.1「自动关联逻辑」。
 *
 * 适用条件（matchAutoEnablePreset，四条缺一不可）：
 * - 凭证为明文（plaintext）：env/command 落盘的是占位串（$VAR / !command，由 pi 运行时
 *   解析），quota 凭证链读原始串不解占位——自动开启只会得到查询失败；明文 key 即刻可用
 * - matchQuotaPreset 命中（baseUrl/name 命中内置预设）
 * - preset.auth 含 'api-key'：凭证复用 provider 自己的 key（credentialSource 缺省推导
 *   'provider' → auth.json → models.json，正是落盘位置）。cookie 类（mimo / opencode-go）
 *   不适用——无 cookie 可复用，自动开启只会得到 no-credential 失败态
 * - 非 requiresWorkspace：资源维度 fetcher（opencode-go）还需 workspace 配置才算齐备
 *
 * 落盘语义（autoEnableQuotaDisplay）：merge 写 extras `quota { enabled: true, fetcher }`
 * （保留 authMethod/modelStates 与既有 quota 其它字段）；fetcher 显式落盘——catalog provider
 * （如 zai-coding-cn 孤儿凭据）无 models.json 条目，查询侧的 baseUrl/name 自动匹配读不到
 * 定义（与手动配置路径一致，useQuotaConfigure 保存时也显式传 fetcher）。credentialSource
 * 刻意不写：缺省推导 'provider'（复用 provider 自己的 key），不制造 secrets 中间态。
 *
 * 「默认同意，用户可关闭」：enabled 是用户同意位（D4）——一旦用户显式设置过
 * （quota.enabled 有值，含手动关闭），自动开启不再覆盖（不复活用户关掉的显示）。
 */
import { matchQuotaPreset } from '@taiji/shared'
import type { QuotaPreset } from '@taiji/shared'
import type { TaijiProviderStore } from './provider-extras-store.js'

/** 自动开启的 extras 写入通道（可选注入，对齐 credentialWriter 先例）。 */
export type QuotaExtrasWriter = Pick<TaijiProviderStore, 'modify'>

/**
 * 凭据形态是否为「明文 key」（判定字符串形态，供 setProvider 路径用；导入路径的六态
 * credentialType 判定同语义——只有 'plaintext' 适用）。$VAR / ${VAR} env 占位与 !command
 * 前缀均非明文。
 */
export function isPlaintextCredential(raw: string | undefined): boolean {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return false
  return !trimmed.startsWith('$') && !trimmed.startsWith('!')
}

/**
 * 判定「默认同意自动开启」是否适用：返回应落盘的 preset，不适用返回 undefined。
 * credentialType 只有 'plaintext' 适用（导入侧六态 / setProvider 侧明文判定，语义见文件头）。
 */
export function matchAutoEnablePreset(
  provider: { baseUrl?: string; name?: string },
  credentialType: string,
): QuotaPreset | undefined {
  if (credentialType !== 'plaintext') return undefined
  const preset = matchQuotaPreset(provider)
  if (!preset) return undefined
  if (!preset.auth.includes('api-key')) return undefined
  if (preset.requiresWorkspace) return undefined
  return preset
}

/**
 * 「新增」路径的 preset 匹配输入归一：catalog 用内置模板的 baseUrl/name（平台身份——QuickSetup
 * 刻意不回传模板 baseUrl（防线⑥快照 artifact），data.name 是可改展示名（如 "Z.AI Coding CN"
 * 不命中 \bzai\b），模板身份才是稳定锚点，对齐 importer 孤儿凭据路径的 matchBuiltinTemplate
 * 同法）；custom / 无模板用 data/合并后的 baseUrl/name（用户显式身份）。
 */
export function resolveCreateMatchIdentity(
  tpl: { baseUrl?: string; name?: string } | undefined,
  data: { baseUrl?: unknown; name?: unknown },
  merged: Record<string, unknown>,
): { baseUrl?: string; name?: string } {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
  return {
    baseUrl: tpl?.baseUrl ?? str(data.baseUrl) ?? str(merged.baseUrl),
    name: tpl?.name ?? str(data.name) ?? str(merged.name),
  }
}

/**
 * 新建 provider 的额度显示自动开启（「新增即默认同意」单一入口，setProvider 新建分支调用）。
 * 判定顺序：凭据可用 → preset 命中 → 落盘（内部守卫：用户已有 enabled 决定不覆盖）。
 *
 * @param credentialUsable 凭据可用（调用方判定）：明文（isPlaintextCredential，env 占位
 *   $VAR / !command 落盘的是占位串，quota 凭证链不解占位）**且**真的有落盘路径
 *   （catalog + 无 credentialWriter 时 apiKey 被丢弃（M5-01），自动开启只会有 no-credential
 *   失败态——对齐 importer「failed 不自动开启」）。
 * @param identity preset 匹配输入（调用方归一）：catalog 用内置模板的 baseUrl/name（平台
 *   身份——QuickSetup 刻意不回传模板 baseUrl（快照 artifact），data.name 是可改展示名，
 *   模板身份才是稳定锚点，对齐 importer 孤儿凭据路径的 matchBuiltinTemplate 同法）；
 *   custom 用 data/合并后的 baseUrl/name（用户显式身份）。
 */
export async function autoEnableQuotaDisplayOnCreate(
  store: QuotaExtrasWriter | undefined,
  providerId: string,
  identity: { baseUrl?: string; name?: string },
  credentialUsable: boolean,
): Promise<boolean> {
  if (!credentialUsable) return false
  const preset = matchAutoEnablePreset(identity, 'plaintext')
  if (!preset) return false
  return autoEnableQuotaDisplay(store, providerId, preset.fetcher)
}

/**
 * extras 落盘 quota 自动开启（merge 语义见文件头）。用户已有 enabled 决定时不动
 * （「默认同意」只对从无决定的新配置生效，不覆盖手动关闭）。
 *
 * 返回是否**本次真实写入**（undefined → true 翻转）：调用方据此置 quotaAutoEnabled /
 * toast 依据，不实报告禁止（写失败 / 未翻转均不报）。失败只 warn（best-effort：主语义
 * （provider 定义+凭据+白名单）已成功，额度显示可在设置里手动配置）。
 */
export async function autoEnableQuotaDisplay(
  store: QuotaExtrasWriter | undefined,
  providerId: string,
  fetcherId: string,
): Promise<boolean> {
  if (!store) return false
  try {
    let wrote = false
    await store.modify(providerId, current => {
      if (current?.quota?.enabled !== undefined) return current
      wrote = true
      return { ...current, quota: { ...current?.quota, enabled: true, fetcher: fetcherId } }
    })
    return wrote
  } catch (err) {
    // best-effort 降级（非 silent-catch）：主语义已成功，额度显示缺失属可恢复态
    // （设置里手动配置即可）；在此中断/回滚反而让主流程结果与磁盘态背离。
    console.warn(`[quota-auto-enable] auto-enable quota display failed for ${providerId}:`, err)
    return false
  }
}
