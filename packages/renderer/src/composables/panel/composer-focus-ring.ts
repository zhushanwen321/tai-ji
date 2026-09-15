/**
 * composer-box 聚焦态与聚焦环视觉（v6 §6.1 .focused：border-accent + 3px accent 外环）。
 * 从 Composer.vue 拆出（script 行数约束，vue_rules_checker ≤300）。
 *
 * boxClass（composer-shell）三级链 staging>bash>steer>hasInput 无 focus 分支，聚焦环在壳层补：
 * focus 优先级低于 staging/bash/steer（三者已含 accent border + ring，聚焦不叠加），否则聚焦时
 * 输出 3px accent 外环（! 前缀压过 hasInput 的 2px 微环 Tailwind 内联工具类）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

export function useComposerFocusRing(
  boxClass: ComputedRef<Array<string | false>>,
  /** staging/steer/bash 活跃判定（共享视觉特征已含 accent border，聚焦环不叠加） */
  hasAccentVisual: () => boolean,
): {
  isFocused: Ref<boolean>
  focusRingClass: ComputedRef<Array<string>>
  onBoxFocusIn: () => void
  onBoxFocusOut: () => void
} {
  const isFocused = ref(false)
  /** 排除条件用 steer/bash 共享视觉特征 `border-[var(--accent)]`（Plan 04 删
   *  animate-steer-breathe 后原字符串条件变死代码，F3 修复）。 */
  const focusRingClass = computed<Array<string>>(() => {
    if (!isFocused.value) return ['']
    const exclusive = String(boxClass.value[0] ?? '')
    if (exclusive.includes('border-[var(--accent)]') || hasAccentVisual()) {
      return ['']
    }
    // 3px accent-ring 外环（v6 §6.1 .focused 真值；与 staging/bash 分支的 shadow-[0_0_0_3px_var(--accent-ring)] 同视觉语言）
    return ['!border-[var(--accent)] ![box-shadow:0_0_0_3px_var(--accent-ring)]']
  })
  /** 子元素（ComposerInput）聚焦算 box 聚焦（v6 .focused 态）；
   *  focusout 时 relatedTarget 仍在 box 内则保持（composer-box 内子元素切换不退出聚焦）。 */
  function onBoxFocusIn(): void {
    isFocused.value = true
  }
  function onBoxFocusOut(): void {
    isFocused.value = false
  }
  return { isFocused, focusRingClass, onBoxFocusIn, onBoxFocusOut }
}
