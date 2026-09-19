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
 *
 * F1（设计 `.tmp/tech-design/mode-system-composer-density.md` §7.5 E4）：`modeChipFallbackTo`
 * 透传 `SessionSummary.launchPresetFallbackTo`（非默认模式会话 restore 回落 builtin:full 的事实），
 * chip 据此区分「已回落（本次以全工具模式启动）」与「未回落（仅预告重启后回落）」——
 * 未回落态不得声称本次已用全工具。
 */
export function useComposerModeChip(
  sessionId: MaybeRefOrGetter<string | null>,
  variant: MaybeRefOrGetter<'panel' | 'landing'>,
): { modeChipPresetId: ComputedRef<string | null>; modeChipFallbackTo: ComputedRef<string | null> } {
  const sessionStore = useSessionStore()
  const presetStore = usePresetStore()

  /** 当前会话的 summary（panel 态 + 有 id 时）；其余态 undefined。 */
  const sessionSummary = computed(() => {
    const id = toValue(sessionId)
    if (toValue(variant) !== 'panel' || !id) return undefined
    return sessionStore.list.find((s) => s.id === id)
  })

  const modeChipPresetId = computed<string | null>(() => {
    if (presetStore.loadError !== null || presetStore.presets.length === 0) return null
    const launchPresetId = sessionSummary.value?.launchPresetId
    const fallbackModeId = presetStore.defaultPresetId || BUILTIN_PRESET_IDS.FULL
    return launchPresetId && launchPresetId !== fallbackModeId ? launchPresetId : null
  })

  /** 回落目标 id（F1 披露）；无回落事实 → null。 */
  const modeChipFallbackTo = computed<string | null>(
    () => sessionSummary.value?.launchPresetFallbackTo ?? null,
  )

  return { modeChipPresetId, modeChipFallbackTo }
}
