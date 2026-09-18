/**
 * useLiveToolDuration —— running 工具的行尾实时耗时（从 Block.vue 拆出，控 script 行数）。
 *
 * 仅 isRunning 期间挂载 interval（100ms tick）驱动 nowTs 重算，onUnmounted 清理，
 * 页面 hidden 停不停 tick 不在职责内（tick 只驱动一个 computed，开销可忽略——
 * 与原实现一致，行为零变化）。
 * 终态耗时用 startTime/endTime；end_not_received（流结束未收到 tool_call_end，
 * 进程崩溃/WS 断连）原单独分支已并入 completed 的 neutral-mid 置灰（同为非 running
 * 非失败的中性态，无需视觉区分——色档判定留在 Block.vue 的 toolStatusClass）。
 */
import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ToolCall } from '@taiji/shared'
import { formatDuration } from '../format-utils'

/** running 工具耗时实时跳动 tick 间隔 */
const LIVE_DUR_TICK_MS = 100

export function useLiveToolDuration(
  tool: ComputedRef<ToolCall | undefined> | Ref<ToolCall | undefined>,
  isRunning: ComputedRef<boolean>,
): ComputedRef<string> {
  const nowTs = ref(Date.now())
  let liveDurTimer: ReturnType<typeof setInterval> | null = null
  function startLiveDurTick(): void {
    if (liveDurTimer) return
    nowTs.value = Date.now()
    liveDurTimer = setInterval(() => { nowTs.value = Date.now() }, LIVE_DUR_TICK_MS)
  }
  function stopLiveDurTick(): void {
    if (liveDurTimer) { clearInterval(liveDurTimer); liveDurTimer = null }
  }
  watch(isRunning, (running) => {
    if (running) startLiveDurTick()
    else stopLiveDurTick()
  }, { immediate: true })
  onUnmounted(() => { stopLiveDurTick() })

  /** tool 块行尾耗时（running 实时算，completed 用 startTime/endTime） */
  return computed(() => {
    const start = tool.value?.startTime
    if (typeof start !== 'number') return ''
    if (isRunning.value) {
      return formatDuration(nowTs.value - start)
    }
    const end = tool.value?.endTime
    if (typeof end !== 'number' || end <= start) return ''
    return formatDuration(end - start)
  })
}
