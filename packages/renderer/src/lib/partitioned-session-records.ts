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

interface EmptyResultStrikeGuard {
  /**
   * 空结果守卫判定：true = 疑似瞬时读失败，调用方保留旧分区直接 return（不覆盖）；
   * false = 放行覆盖（连续空命中达到 LIMIT 判真实删空，或结果非空 / 分区本就为空）。
   *
   * 为什么 strike 连续计数（sidebar-sync-plan P1 + R1 business-logic S3，原三 store 注释单源）：
   * runtime 读盘失败时 catch 降级返回 []，瞬时读失败若当空列表覆盖会清掉分区历史——RPC
   * 成功且空 + 分区非空时先保留旧分区。但「真实删空」（idle-gc/trash 清掉全部记录，删除
   * 动作无对应推送）同样表现为空结果，单次判定无法区分二者：用连续空命中计数（strike）
   * 区分——连续 LIMIT 次空结果判定真实删空放行覆盖（瞬时读失败不会连续命中，RPC 失败走
   * catch 且重置计数），非空结果即清零。推送路径是权威数据，不经此守卫。
   */
  shouldKeepExisting(sessionId: string, fetchedCount: number, partitionCount: number): boolean
  /** 清零该 sid 计数（成功覆盖 / RPC 失败 catch / clearSession 路径——「连续 RPC 成功且空」语义纯净，读失败与数据空不同通道，不让 RPC 故障累计出误清分区） */
  reset(sessionId: string): void
}

/**
 * 创建 loadXxx 空结果守卫（连续空命中 strike 计数，语义见 shouldKeepExisting JSDoc）。
 *
 * @param limit 连续空命中判真实删空的阈值
 * @param logTag console.warn 前缀（store 名，如 'subagent-store'）
 * @param fetchLabel RPC 方法名（warn 文案标注数据源，如 'getSubagents'）——单独参数保持
 *   两 store 原日志文案逐字等价（warn1 含方法名、warn2 只含 store 名）
 */
export function createEmptyResultStrikeGuard(
  limit: number,
  logTag: string,
  fetchLabel: string,
): EmptyResultStrikeGuard {
  // 非响应式簿记（不驱动 UI），clearSession 经 reset 一并清除防泄漏
  const strikes = new Map<string, number>()

  function shouldKeepExisting(sessionId: string, fetchedCount: number, partitionCount: number): boolean {
    if (fetchedCount !== 0 || partitionCount === 0) return false
    const count = (strikes.get(sessionId) ?? 0) + 1
    strikes.set(sessionId, count)
    if (count < limit) {
      console.warn(
        `[${logTag}] ${fetchLabel} returned empty list but partition non-empty, keeping existing records (empty strike ${count}/${limit}):`,
        sessionId,
      )
      return true
    }
    console.warn(
      `[${logTag}] consecutive empty results, treating as real deletion and clearing partition:`,
      sessionId,
    )
    return false
  }

  function reset(sessionId: string): void {
    strikes.delete(sessionId)
  }

  return { shouldKeepExisting, reset }
}
