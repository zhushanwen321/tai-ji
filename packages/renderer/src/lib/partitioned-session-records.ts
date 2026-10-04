/**
 * 按 sessionId 分区的 record 表通用件（ADR-0049 Map 分区派的单源工具，S4 A1）。
 *
 * 为什么抽：subagent / workflow / extension-ui 三个 store 各持一套逐字同构的
 * 「ref<Map<sid, T[]>> + recordsOf / get / apply / clear」四件套，分区范式
 * （不可变写 / 幂等清 / 空数组兜底）一旦调整需三处同步，漂移风险高。
 *
 * 与 useSessionScopedState 的边界：那是 per-instance composable（组件多实例各持分区表），
 * 本工具服务 store 模块单例（跨组件共享、切走不清、deleteSession 精确释放）——语义不同构，
 * 不可合并。各 store 的领域分区语义（存什么、何时清）注释保留在 store 侧，本文件只持通用范式。
 */
import { computed, shallowRef } from 'vue'
import type { ComputedRef, Ref } from 'vue'

interface PartitionedRecords<T> {
  /** 分区表 state（ref：apply/clear 不可变替换触发响应性；全清场景直接整表替换 new Map()） */
  recordsBySession: Ref<Map<string, T[]>>
  /** 响应式视图：指定 session 分区（组件 computed 订阅用，切会话读不同分区自动重算） */
  recordsOf(sessionId: string): ComputedRef<T[]>
  /** 非响应式读：指定 session 分区（getter / derivedStatus computed 内调，无则空数组，不写 Map） */
  get(sessionId: string): T[]
  /** 写入指定 session 分区（不可变替换整 Map，确保 Map 响应性触发） */
  apply(sessionId: string, list: T[]): void
  /** 精确释放指定 session 分区（deleteSession 调，防泄漏 ADR-0049 AC-8；幂等） */
  clear(sessionId: string): void
}

/** 创建按 sessionId 分区的 record 表（四件套：state ref + 响应式视图 + 非响应式读 + 不可变写/清） */
export function createPartitionedRecords<T>(): PartitionedRecords<T> {
  // shallowRef：写入恒为整 Map 不可变替换（浅层跟踪即触发全部依赖），且避免泛型 T 被深度
  // UnwrapRef 改写类型（同 useSessionMarkers / useForkBranchNotify 的 Map shallowRef 范式）
  const recordsBySession = shallowRef<Map<string, T[]>>(new Map())

  function recordsOf(sessionId: string): ComputedRef<T[]> {
    return computed(() => recordsBySession.value.get(sessionId) ?? [])
  }

  function get(sessionId: string): T[] {
    return recordsBySession.value.get(sessionId) ?? []
  }

  function apply(sessionId: string, list: T[]): void {
    recordsBySession.value = new Map(recordsBySession.value).set(sessionId, list)
  }

  function clear(sessionId: string): void {
    if (!recordsBySession.value.has(sessionId)) return
    const next = new Map(recordsBySession.value)
    next.delete(sessionId)
    recordsBySession.value = next
  }

  return { recordsBySession, recordsOf, get, apply, clear }
}
