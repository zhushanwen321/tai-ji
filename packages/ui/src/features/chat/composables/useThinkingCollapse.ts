/**
 * useThinkingCollapse —— thinking 块折叠状态机（从 Block.vue 拆出，控 script 行数）。
 *
 * 职责：折叠/展开状态 + 手动操作置位 + working 回落 + 收起预览 + working 尾行视口。
 *  - 折叠默认值：working 态也默认折叠（60 字符预览），与过程块收编理念一致（收编减体积
 *    + thinking 折叠 = 视觉体积最小）；用户可手动展开，展开后保持。
 *    原 SSOT §3.3.3「working→false 展开」导致 streaming 中所有 thinking 全展开，与收编
 *    减体积冲突（裁决史见 Block.vue 同区域注释）。
 *  - 用户手动 toggle 过（收起/展开均置位）→ 完成态不回落（显式意图优先，CQ1）。
 *  - working true→false：未手动操作过的块回落收起。
 *  - 收起态预览：头 60 字符截断；working 态改单行尾行视口（机制见 useTailScroll 头注释），
 *    尾 2 行即状态机所需（旧行 + 新行）。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { tailLines } from '../format-utils'
import { TAIL_WINDOW_LINES, useTailScroll } from './useTailScroll'

/** 收起态的正文预览截断长度（draft：收起时显一行摘要） */
const PREVIEW_LIMIT = 60

export interface UseThinkingCollapseParams {
  /** thinking 正文（props.content） */
  content: ComputedRef<string | undefined> | Ref<string | undefined>
  /** working 态（props.working） */
  working: ComputedRef<boolean | undefined> | Ref<boolean | undefined>
  /** 初始折叠态（ThinkingBlock.collapsed，缺省收起） */
  collapsed?: boolean
}

export function useThinkingCollapse(params: UseThinkingCollapseParams) {
  const thinkingCollapsed = ref(params.collapsed ?? true)
  const thinkingExpanded = computed(() => !thinkingCollapsed.value)
  /** 用户是否手动 toggle 过（收起/展开均置位）——置位后完成态不回落（显式意图优先，CQ1） */
  const userToggledThinking = ref(false)

  function toggleThinking(): void {
    userToggledThinking.value = true
    thinkingCollapsed.value = !thinkingCollapsed.value
  }

  /** working true→false：未手动操作过的块回落收起（用户手动操作过的保持用户意图不回滚） */
  watch(
    () => params.working.value,
    (working) => {
      if (working === false && !userToggledThinking.value) {
        thinkingCollapsed.value = true
      }
    },
  )

  /** 收起态的正文预览（截断，draft：收起时显一行摘要） */
  const previewText = computed(() => {
    const c = params.content.value?.trim() ?? ''
    if (c.length <= PREVIEW_LIMIT) return c
    return `${c.slice(0, PREVIEW_LIMIT)}…`
  })

  /* ── thinking 尾行视口（2026-08 抖动修复重写）──
   * working 态折叠预览：单行视口显示最新行（横向 CSS 钉右 + 纵向滑入动画，
   * 机制见 useTailScroll 头注释）；非 working 保持 previewText 头部 60 字符静态。 */
  const thinkingTailLines = computed(() =>
    params.working.value ? tailLines(params.content.value ?? '', TAIL_WINDOW_LINES) : [],
  )
  const { displayLines: thinkDisplayLines, contentStyle: thinkScrollStyle } = useTailScroll(thinkingTailLines)

  return {
    /** 折叠态（模板 v-if 分支判定） */
    thinkingCollapsed: thinkingCollapsed as Ref<boolean>,
    thinkingExpanded,
    toggleThinking,
    previewText,
    /** working 态尾行窗口（模板 v-if 判定视口是否渲染） */
    thinkingTailLines,
    thinkDisplayLines,
    thinkScrollStyle,
  }
}
