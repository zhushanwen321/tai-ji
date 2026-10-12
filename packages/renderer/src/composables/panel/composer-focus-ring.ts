/**
 * composer-box 聚焦态（demo R3 撤销口径：composer 输入区无焦点边界，光标即焦点反馈——
 * demo workbench.css composer 段注释）。从 Composer.vue 拆出（script 行数约束，
 * vue_rules_checker ≤300）。
 *
 * 聚焦不产生任何可见视觉（v6 3px accent 外环 → 外框 border-strong 提亮 → R3 无边界，
 * 两代旧形态均已退役）；isFocused 仅作聚焦态挂点（ComposerInput 的 is-focused 同语义），
 * focusRingClass 恒空，保留返回面维持 Composer.vue 接线契约不变（勿再往里加聚焦视觉）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

export function useComposerFocusRing(
  _boxClass: ComputedRef<Array<string | false>>,
  _hasAccentVisual: () => boolean,
): {
  isFocused: Ref<boolean>
  focusRingClass: ComputedRef<Array<string>>
  onBoxFocusIn: () => void
  onBoxFocusOut: () => void
} {
  const isFocused = ref(false)
  /** R3 无焦点边界：恒空（参数保留以兼容既有调用点签名，语义已随旧聚焦形态退役） */
  const focusRingClass = computed<Array<string>>(() => [''])
  /** 子元素（ComposerInput）聚焦算 box 聚焦（is-focused 挂点）；
   *  focusout 时 relatedTarget 仍在 box 内则保持（composer-box 内子元素切换不退出聚焦）。 */
  function onBoxFocusIn(): void {
    isFocused.value = true
  }
  function onBoxFocusOut(): void {
    isFocused.value = false
  }
  return { isFocused, focusRingClass, onBoxFocusIn, onBoxFocusOut }
}
