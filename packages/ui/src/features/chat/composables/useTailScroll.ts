/**
 * useTailScroll — 流式 block 尾行跟随 composable（单行视口 + 滚动动画）。
 *
 * 机制（2026-08 抖动修复重写，替换旧「尾 3 行窗口 + translateY(-(n-1)*20px)」）：
 * - 横向钉右由调用方 CSS 承担（viewport `flex justify-end` + 行右对齐，溢出裁左，
 *   永远显示最新字符），composable 不再操作 scrollLeft——旧实现 watch→nextTick→rAF
 *   晚 1-2 帧钉右，高频 delta 下「未钉右中间态」可见，是横向抖动根因。
 * - 纵向滑入：settled/sliding 状态机。settled 渲染当前行（transform 0）；换行时渲染
 *   [旧行, 新行] 并过渡 translateY(0 → -50%)——容器自身 2 行的 50% 恰好一行，与
 *   行高数值完全解耦（旧实现硬编码 20px 与实际继承行高 15.7-18.8px 不符致裁切）。
 *   120ms 后无过渡重置回单行：重置帧显示内容不变（新行已成为当前行），无闪烁
 *   （虚拟滚动 recycle 手法）。滑入进行中再次换行 → 瞬切 settle（快节奏放弃动画）。
 *
 * 降级开关 disableScroll：恒 settled 瞬切，无动画（reduced-motion / 测试场景）。
 */
import { type ComputedRef, type Ref, computed, onUnmounted, ref, watch } from 'vue'

/** useTailScroll 选项 */
export interface UseTailScrollOptions {
  /** 降级开关：恒 settled 瞬切（无滑入动画） */
  disableScroll?: boolean
  /** 纵向滑入动画时长（ms），与 Block.vue CSS --duration-fast 对应。默认 120。 */
  slideDuration?: number
}

/** useTailScroll 返回值 */
export interface UseTailScrollReturn {
  /** 当前应渲染的行（settled: [当前行]；sliding: [旧行, 新行]），直接 v-for 渲染 */
  displayLines: ComputedRef<string[]>
  /** 内容容器 :style（transform + transition，绑定到纵向滚动容器） */
  contentStyle: ComputedRef<Record<string, string>>
}

/** 滑入动画默认时长（对齐 --duration-fast；写死数值因 TS 侧无法读 CSS 变量） */
const DEFAULT_SLIDE_DURATION = 120
/** 倒数第二行下标偏移（尾 2 行窗口的上一行，换行判定用；具名避 no-magic-numbers） */
const SECOND_LAST_OFFSET = 2

/**
 * 单行视口尾行跟随 composable。
 *
 * 「换行」判定：尾 2 行窗口下，新窗口的倒数第二行 === 旧尾行 → 发生了换行（旧行
 * 从尾位移到倒数第二位）；否则是尾行文本追加（同行横向增长，无纵向动作）。
 *
 * @param rawLines - 尾行窗口（调用方 tailLines(content, 2) 的结果，只需尾 2 行）
 * @param options  - 选项（均可选）
 * @returns displayLines（渲染用） + contentStyle（:style 绑定用）
 *
 * @example
 * ```ts
 * const tail = computed(() => tailLines(content.value, 2))
 * const { displayLines, contentStyle } = useTailScroll(tail)
 * // template:
 * // <span class="flex h-[1lh] min-w-0 flex-1 justify-end overflow-hidden">
 * //   <span class="flex flex-col items-end" :style="contentStyle">
 * //     <span v-for="line in displayLines" class="whitespace-nowrap">{{ line }}</span>
 * //   </span>
 * // </span>
 * ```
 */
export function useTailScroll(
  rawLines: Ref<string[]> | ComputedRef<string[]>,
  options: UseTailScrollOptions = {},
): UseTailScrollReturn {
  const { disableScroll = false, slideDuration = DEFAULT_SLIDE_DURATION } = options

  /** 是否已收到首行（区分初始化与后续变化；不用 settledLine 非空判断——首行可能是空串） */
  let initialized = false
  /** settled 态当前显示行 */
  const settledLine = ref('')
  /** sliding 态行对 [旧行, 新行]；null = settled */
  const slidingPair = ref<[string, string] | null>(null)
  /** sliding 内部分两拍：enter（渲染双行、transform 0）→ slide（加 translateY + transition）。
   *  双 rAF 切拍保证浏览器先 paint 过 translateY(0)，否则同帧改 transform 不触发过渡。 */
  const slidingPhase = ref<'enter' | 'slide'>('enter')
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let phaseFrames: number[] = []

  function clearPending(): void {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer)
      settleTimer = undefined
    }
    phaseFrames.forEach(cancelAnimationFrame)
    phaseFrames = []
  }

  watch(
    rawLines,
    (lines) => {
      const latest = lines.length > 0 ? lines[lines.length - 1] : ''
      const second = lines.length > 1 ? lines[lines.length - SECOND_LAST_OFFSET] : undefined
      // 初始化：首行瞬切（无旧行可滚入）。immediate 覆盖挂载时 content 已有存量的场景
      //（subagent 流恢复 / v-memo 重建挂载），否则状态机停在空初始值永远不显示。
      if (!initialized) {
        initialized = true
        settledLine.value = latest
        return
      }
      if (disableScroll) {
        settledLine.value = latest
        slidingPair.value = null
        return
      }
      if (slidingPair.value) {
        if (second === slidingPair.value[1]) {
          // 滑入中又换行：放弃动画瞬切到最新（快节奏放弃动画，settle 显示行 = 滑动目标行，无回退闪烁）
          clearPending()
          slidingPair.value = null
          settledLine.value = latest
        } else {
          // 滑入中尾行文本追加：目标行原地更新，动画继续
          slidingPair.value[1] = latest
        }
        return
      }
      if (second === settledLine.value) {
        // 换行：从「用户当前所见行」滑入新行
        startSlide(settledLine.value, latest)
        return
      }
      // 同行横向追加：只更新文本，无纵向动作（钉右由 CSS 承担）
      settledLine.value = latest
    },
    { flush: 'post', immediate: true },
  )

  function startSlide(from: string, to: string): void {
    settledLine.value = from
    slidingPair.value = [from, to]
    slidingPhase.value = 'enter'
    phaseFrames = [
      requestAnimationFrame(() => {
        phaseFrames.push(
          requestAnimationFrame(() => {
            slidingPhase.value = 'slide'
          }),
        )
      }),
    ]
    settleTimer = setTimeout(() => {
      // settle 读 slidingPair 当前值而非闭包 to：滑入中目标行可能被原地追加更新过
      settledLine.value = slidingPair.value?.[1] ?? to
      slidingPair.value = null
      settleTimer = undefined
    }, slideDuration)
  }

  onUnmounted(clearPending)

  const displayLines = computed(() => {
    if (slidingPair.value) return [slidingPair.value[0], slidingPair.value[1]]
    return [settledLine.value]
  })

  const contentStyle = computed<Record<string, string>>(() => {
    // settled / sliding-enter：transform 0 且无 transition（重置帧不能带过渡）
    const style: Record<string, string> = { transform: 'translateY(0)' }
    if (slidingPair.value && slidingPhase.value === 'slide') {
      style.transform = 'translateY(-50%)'
      style.transition = 'transform var(--duration-fast) var(--ease)'
    }
    return style
  })

  return { displayLines, contentStyle }
}
