import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { useSessionStore } from '@/stores/session'
import { usePresetStore } from '@/stores/preset'
import { BUILTIN_PRESET_IDS } from '@taiji/shared'

/**
 * 对话态只读模式 chip 派生（u4，设计 `.tmp/tech-design/mode-system-composer-density.md`
 * §6.5 D5 / §7.5 E7）。从 Composer.vue 拆出（script 行数约束，先例 composer-focus-ring.ts /
 * useDeferQueueRows.ts；判据自原实现原样搬移，零行为改动）：
 *
 * - 仅 `variant === 'panel'` 且有 sessionId 时参与判定；
 * - §7.5 E7 三态闸：preset 列表未加载（空数组）/ 加载失败 → 不渲染（与 ModeDeclarationRow
 *   同判据，避免闪裸 `custom:xxxx`，也避免留下空占位的 meta 行）；
 * - 只读 chip 仅在**非默认模式**渲染，判据 = `launchPresetId !== (defaultPresetId || 'builtin:full')`。
 *   注意是 `||` 不是 `??`：`defaultPresetId` 为空串（store 未加载）时兜底 builtin:full。
 */
export function useComposerModeChip(
  sessionId: MaybeRefOrGetter<string | null>,
  variant: MaybeRefOrGetter<'panel' | 'landing'>,
): { modeChipPresetId: ComputedRef<string | null> } {
  const sessionStore = useSessionStore()
  const presetStore = usePresetStore()

  const modeChipPresetId = computed<string | null>(() => {
    const id = toValue(sessionId)
    if (toValue(variant) !== 'panel' || !id) return null
    if (presetStore.loadError !== null || presetStore.presets.length === 0) return null
    const launchPresetId = sessionStore.list.find((s) => s.id === id)?.launchPresetId
    const fallbackModeId = presetStore.defaultPresetId || BUILTIN_PRESET_IDS.FULL
    return launchPresetId && launchPresetId !== fallbackModeId ? launchPresetId : null
  })

  return { modeChipPresetId }
}
