/**
 * thinking-levels —— W3 shim（re-export core + 保留 getDisplayLabel）。
 *
 * [归位] 纯逻辑（ThinkingLevel/THINKING_LEVELS/isThinkingLevel/normalizeSupportedLevels/
 * resolveThinkingValue/resolveThinkingKey/highestAvailableLevel/isSameThinkingScheme/
 * isOnOffMap）已迁 @taiji/core/domain/composer/thinking-levels（W3）。
 *
 * getDisplayLabel 依赖 i18n（@/i18n 全局实例），留在 renderer（core 零 renderer import）。
 * 其余全部 re-export core。旧调用方（ThinkingLevelPopover.vue 等）零改动。
 *
 * W4 壳接入时删除本 shim（getDisplayLabel 以注入 t 方式迁入 core 或随壳迁移）。
 */
import i18n from '@/i18n'
import {
  THINKING_LEVELS,
  isOnOffMap,
  type ThinkingLevel,
} from '@taiji/core/domain/composer/thinking-levels'

// core 已含 ThinkingLevelOption / THINKING_LEVELS / isThinkingLevel / normalizeSupportedLevels /
// resolveThinkingValue / resolveThinkingKey / highestAvailableLevel / isSameThinkingScheme / isOnOffMap
// （U6：本地档位推算函数已删除，export * 自动收窄）
export * from '@taiji/core/domain/composer/thinking-levels'

/**
 * 取某档位的显示 label。on/off 模式下 high → t('composable.thinkingLevel.on')，其余走 labelKey + t。
 *
 * @param t 可选 i18n 翻译函数（来自 useI18n）。不传时回退到全局 i18n.global.t，
 *          兼容组件外（如 tests / 非 Vue 上下文）调用。
 */
export function getDisplayLabel(
  level: ThinkingLevel,
  map?: Record<string, string | null>,
  t?: (key: string) => string,
): string {
  const translate = t ?? i18n.global.t
  if (level === 'high' && isOnOffMap(map)) return translate('composable.thinkingLevel.on')
  const opt = THINKING_LEVELS.find((o) => o.level === level)
  if (!opt) return translate('composable.thinkingLevel.default')
  return translate(opt.labelKey)
}
