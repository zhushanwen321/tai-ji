/**
 * 按 sessionId 分区的 record 表通用件（ADR-0049 Map 分区派的单源工具，S4 A1）。
 *
 * 为什么抽：subagent / workflow / extension-ui 三个 store 各持一套逐字同构的
 * 「ref<Map<sid, T[]>> + recordsOf / get / apply / clear」四件套，分区范式
 * （不可变写 / 幂等清 / 空数组兜底）一旦调整需三处同步，漂移风险高。
 * 同理收编「每会话加载态三件套」（待裁决项 1 收敛 2026-10-04）：loading /
 * loadError / oversize 三张分区 Map + 三个读取函数在 subagent / workflow 两 store
 * 逐字抄写（extension-ui 无拉取态不在此列），收进 createPartitionedLoadState。
 *
 * 与 useSessionScopedState 的边界：那是 per-instance composable（组件多实例各持分区表），
 * 本工具服务 store 模块单例（跨组件共享、切走不清、deleteSession 精确释放）——语义不同构，
 * 不可合并。各 store 的领域分区语义（存什么、何时清）注释保留在 store 侧，本文件只持通用范式。
 */
import { computed, ref, shallowRef } from 'vue'
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

/** 每 session 加载态三件套的分区读写面（createPartitionedLoadState 返回形状）。 */
export interface PartitionedLoadState {
  /** per-session 加载态读取（消费方 computed 内调用建立响应依赖；无条目 = 不在途） */
  isLoadingOf(sessionId: string): boolean
  /** per-session 加载错误读取（无条目 = 无错误） */
  loadErrorOf(sessionId: string): string | null
  /** [RT-4#8] per-session oversize 降级读取（面板降级提示判据；无条目 = false） */
  oversizeOf(sessionId: string): boolean
  /** 拉取开始：loading 置位 + 该 sid 错误清除（loadXxx 入口两行的语义单点） */
  beginLoad(sessionId: string): void
  /**
   * 拉取收尾：loading 条目删除（finally 路径）。delete 而非 set(sid, false)：load 在途时
   * clearSession 已删分区的话，set 会为已删 session 重生条目（残留）；读取端 `?? false`
   * 缺省语义等价（无条目 = 不在途）。
   */
  endLoad(sessionId: string): void
  /** 写入该 sid 分区错误消息（catch 路径；失败不覆盖分区数据由 store 侧保证） */
  setLoadError(sessionId: string, message: string): void
  /** 置位 oversize 降级标志（[RT-4#8] 列表不可用，面板显示降级提示） */
  setOversize(sessionId: string): void
  /** 清除 oversize 降级标志（恢复正常读取后） */
  clearOversize(sessionId: string): void
  /** 精确释放指定 session 三分区（deleteSession 调，防泄漏，ADR-0049 AC-8；幂等） */
  clear(sessionId: string): void
  /** 整表替换三分区（clearSubagents / clearWorkflows 全局重置场景，RD-3#12 全清语义） */
  clearAll(): void
}

/**
 * 创建每 session 加载态三件套（loading / loadError / oversize 三张分区 Map + 读取函数，
 * 待裁决项 1 收敛 2026-10-04——原 subagent / workflow 两 store 逐字抄写的 71 行收进本工厂）。
 *
 * 三 facet 的领域语义（何时置位、错误文案来源、降级提示消费面）留在 store 侧；本工厂只持
 * 分区范式：ref<Map> 分区（ADR-0049 派，split 双面板并行拉取互不遮蔽）+ 缺省读取
 * （无条目 = false / null）+ delete 式清理（防已删 session 重生条目）。
 */
export function createPartitionedLoadState(): PartitionedLoadState {
  const loadingBySession = ref(new Map<string, boolean>())
  const loadErrorBySession = ref(new Map<string, string | null>())
  const oversizeBySession = ref(new Map<string, boolean>())

  function isLoadingOf(sessionId: string): boolean {
    return loadingBySession.value.get(sessionId) ?? false
  }

  function loadErrorOf(sessionId: string): string | null {
    return loadErrorBySession.value.get(sessionId) ?? null
  }

  function oversizeOf(sessionId: string): boolean {
    return oversizeBySession.value.get(sessionId) ?? false
  }

  function beginLoad(sessionId: string): void {
    loadingBySession.value.set(sessionId, true)
    loadErrorBySession.value.delete(sessionId)
  }

  function endLoad(sessionId: string): void {
    loadingBySession.value.delete(sessionId)
  }

  function setLoadError(sessionId: string, message: string): void {
    loadErrorBySession.value.set(sessionId, message)
  }

  function setOversize(sessionId: string): void {
    oversizeBySession.value.set(sessionId, true)
  }

  function clearOversize(sessionId: string): void {
    oversizeBySession.value.delete(sessionId)
  }

  function clear(sessionId: string): void {
    loadingBySession.value.delete(sessionId)
    loadErrorBySession.value.delete(sessionId)
    oversizeBySession.value.delete(sessionId)
  }

  function clearAll(): void {
    loadingBySession.value = new Map()
    loadErrorBySession.value = new Map()
    oversizeBySession.value = new Map()
  }

  return { isLoadingOf, loadErrorOf, oversizeOf, beginLoad, endLoad, setLoadError, setOversize, clearOversize, clear, clearAll }
}
