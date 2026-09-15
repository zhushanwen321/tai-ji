/**
 * Provider 认证徽章（wave-list-badge，demo provider-auth-badge 三色）。
 *
 * 纯函数（无 i18n 实例——t 由调用方传入，保持组件可测性）。
 * 分类：
 *  - env_var → $ENV（info 色，demo $OPENAI_API_KEY 的通用形式——ProviderInfo 不含 apiKey 值）
 *  - oauth → OAuth（warn 色）
 *  - ambient → 云凭证（info 色）
 *  - api_key（apiKeySet）→ API Key（中性）
 *  - 无凭据 → API Key（未设置）（中性）
 */
import type { ProviderInfo } from '@taiji/shared'

/** 徽章文案 key（settings.provider.authBadge.<key>） */
export function authBadgeTextKey(p: ProviderInfo): string {
  if (p.authMethod === 'env_var') return 'env'
  if (p.authMethod === 'oauth') return 'oauth'
  if (p.authMethod === 'ambient') return 'ambient'
  if (p.apiKeySet) return 'apiKey'
  return 'apiKeyUnset'
}

/** 徽章颜色类（demo provider-auth-badge：env/ambient info，oauth warn，key 中性） */
export function authBadgeClass(p: ProviderInfo): string {
  if (p.authMethod === 'env_var' || p.authMethod === 'ambient') return 'bg-info-soft text-info'
  if (p.authMethod === 'oauth') return 'bg-warn-soft text-warn'
  return 'bg-surface-hover text-neutral-mid'
}
