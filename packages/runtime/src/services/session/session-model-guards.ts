/**
 * 会话/模型错误分型的两判助手（U2，从 session-service 抽出——该文件超 max-lines 上限，
 * 正面提取而非 disable）。
 *
 * 用途：`Model not found` 三型分型（设计 §3.4）——pi 的错误文本只说明「引擎快照里没这个模型」，
 * 三种成因由 taiji 侧两判分开：
 *   ① 模型不在注册表 → `MODEL_NOT_FOUND`（真已不存在）；
 *   ② 在注册表但 provider 无凭据 → `PROVIDER_CREDENTIAL_MISSING`；
 *   ③ 在注册表且凭据齐备 → `ENGINE_MODEL_MISSING`（快照未同步 or 配置含坏内容，双因文案 D11）。
 *
 * 共同的保守方向 = **fail-open**：无法判定时不误报更「确定」的码（未注入 configService /
 * listProviders 抛错 → 视为「在注册表 / 有凭据」→ 落双因文案，用户仍有可行动作）。
 */
import { TAIJI_SESSION_ACTIVATE_TIMEOUT_MS, DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS } from '@taiji/shared'
import { toErrorMessage } from '../../utils/errors.js'
import type { IConfigService } from '../../interfaces.js'

/**
 * 模型是否在 taiji 注册表投影里（`listProviders()` = catalog 合并集 + models.json override，
 * 与 composer 模型列表同源）。configService 未注入 → true（fail-open）。
 */
export function isModelInRegistry(
  configService: IConfigService | null,
  provider: string,
  modelId: string,
): boolean {
  if (!configService) return true
  try {
    const info = configService.listProviders().find((p) => p.id === provider)
    if (!info) return false
    return info.models.some((m) => m.id === modelId)
  } catch (e) {
    console.warn(`[session-service] model registry check failed (fail-open): ${provider}/${modelId}, ${toErrorMessage(e)}`)
    return true
  }
}

/**
 * provider 是否凭据齐备：apiKey 落盘（含 catalog 在 auth.json 的凭据）/ OAuth / ambient /
 * env_var 引用四种形态任一成立即算齐备。
 *
 * 保守方向（避免误报 `PROVIDER_CREDENTIAL_MISSING`）：`apiKeySet` 为 false 但 authMethod 是
 * ambient/env_var 时仍算齐备——这类凭据由 pi 运行时解析（env 引用），taiji 侧看不到值。
 */
export function providerHasCredential(configService: IConfigService | null, provider: string): boolean {
  if (!configService) return true
  try {
    const info = configService.listProviders().find((p) => p.id === provider)
    if (!info) return false
    if (info.apiKeySet) return true
    return info.authMethod === 'ambient' || info.authMethod === 'env_var'
  } catch (e) {
    console.warn(`[session-service] credential check failed (fail-open): ${provider}, ${toErrorMessage(e)}`)
    return true
  }
}

/**
 * 激活上界 env 解析（U2）：`TAIJI_SESSION_ACTIVATE_TIMEOUT_MS` 覆盖默认 15s；
 * 非法值（非数/NaN）回落默认；`≤0` = 不限时（逃生门，与 bash RPC 的 0=不限时同口径）。
 */
export function resolveActivateTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env[TAIJI_SESSION_ACTIVATE_TIMEOUT_MS]
  if (raw === undefined) return DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    console.warn(`[session-service] invalid ${TAIJI_SESSION_ACTIVATE_TIMEOUT_MS} value "${raw}", falling back to ${DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS}ms`)
    return DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS
  }
  return n
}
