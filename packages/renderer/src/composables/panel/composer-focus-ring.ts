/**
 * composer-box 聚焦态视觉（demo 权威：.composer-box:focus-within 外框变 border-strong，
 * demo workbench.css composer 段；无 accent 外环）。从 Composer.vue 拆出（script 行数约束，
 * vue_rules_checker ≤300）。
 *
 * boxClass（composer-shell）三级链 staging>bash>steer>hasInput 无 focus 分支，聚焦态在壳层补：
 * focus 优先级低于 staging/bash/steer（三者已含 accent border 语义色，聚焦不覆盖），
 * 否则聚焦时输出外框 border-strong 提亮（v6 §6.1 的 3px accent 外环已随 demo 复刻退役）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

export function useComposerFocusRing(
  boxClass: ComputedRef<Array<string | false>>,
  /** staging/steer/bash 活跃判定（共享视觉特征已含 accent border，聚焦态不叠加） */
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
    // 聚焦外框提亮一档（demo .composer-box:focus-within { border-color: var(--border-strong) }）
    return ['!border-[var(--border-strong)]']
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
