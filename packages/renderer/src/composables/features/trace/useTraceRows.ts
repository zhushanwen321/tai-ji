/**
 * useTraceRows —— store 分区 → core TraceRow[] 的共享派生（TraceView / TraceInspector 共用）。
 *
 * 派生链：partition（header/entries/malformed/sessionEnd/leafId）→ mergeTraceLines 归并 →
 * core mapSessionTraceRows（12 kind + context 边界 + 影子化）。分区 mutate 触发重算
 * （增量 append / 全量刷新共享同一派生——「对话与 Trace 视图共享数据」design §3.1 样例 4）。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { mapSessionTraceRows } from '@taiji/core/domain/session-trace'
import type { TraceRow } from '@taiji/core/domain/session-trace'
import { mergeTraceLines } from './trace-lines'
import { useSessionTrace } from './useSessionTrace'

/** 当前分区（focusedSessionId）的台账行派生。未 ready 返回空数组。 */
export function useTraceRows(): ComputedRef<TraceRow[]> {
  const { partition } = useSessionTrace()
  return computed<TraceRow[]>(() => {
    const p = partition.value
    if (p.status !== 'ready') return []
    return mapSessionTraceRows({
      lines: mergeTraceLines(p.header, p.entries, p.malformed),
      sessionEnd: p.sessionEnd,
      leafId: p.leafId ?? undefined,
    })
  })
}
