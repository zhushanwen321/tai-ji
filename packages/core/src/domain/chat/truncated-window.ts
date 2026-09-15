/**
 * [u4d-truncated-ui] 历史预算截断窗口状态（crash-resilience §3.3 D4 / impl-plan u4d）。
 *
 * u4b 在 session.history 响应落了双预算窗口契约（truncated/loadedTurns/totalTurnsEstimate，
 * shared protocol SSOT）；本模块是 renderer/core 侧的窗口状态 SSOT：chat store 按 session
 * 分区持有，hydrate/reconcileHistory 路径随响应写入，「加载更早」（[u6] 游标翻页，原
 * getFullHistory 全量通路已退役）成功后更新。消息列表顶部条（renderer TruncatedHistoryBar +
 * MessageStream v-if）据 `truncated` 显隐、`loadedTurns` 显示「已加载最近 N 轮」。
 *
 * [HISTORICAL] N1 的 historyTruncatedSessions（useChat 模块级 Set<boolean>）双轨退役：
 * 布尔显隐从本窗口状态派生（hasMoreHistory），避免「同一 truncated 事实两处存储」。
 * [u6] legacy historyTruncated wire 字段退役（偏差表 D7 双轨收口）：truncated 是唯一
 * 截断标志，HistoryWindowReply 三字段必填（mock 门面同契约），归一无回落逻辑。
 *
 * 判据归 [ADR-0049 例外]：createChatStore() factory 经 renderer
 * defineStore 包装为单例，本 Map 是 factory 单例内的响应式业务状态（ref<Map>，对齐
 * occupancies/compactingReasons 的不可变写范式）。
 */
import { ref, type Ref } from 'vue'

/**
 * session.history 响应的窗口契约字段（[u6] 三字段必填——与 shared protocol SSOT 对齐）。
 */
export interface HistoryWindowReply {
  /** true = 窗口外仍有历史（「加载更早」顶部条显隐的唯一依据） */
  truncated: boolean
  /** 本次返回的完整 turn 数（「已加载最近 N 轮」的 N；游标翻页时 = 本页 turn 数） */
  loadedTurns: number
  /** session 的 turn 总数估计（读到头为精确值，窗口截断时为下界） */
  totalTurnsEstimate: number
}

/** 历史加载窗口状态（u4b session.history 双预算截断契约的 store 侧投影） */
export interface HistoryWindow {
  /** true = 窗口外仍有历史（顶部条显示的唯一依据；false = 顶部条结构性不渲染，A6 回归） */
  truncated: boolean
  /** 累计已加载的完整 turn 数（[u6] 游标翻页时 = 各页 loadedTurns 累计） */
  loadedTurns: number
  /** session 的 turn 总数估计（读到头为精确值，窗口截断时为下界） */
  totalTurnsEstimate: number
}

/**
 * 历史响应 → 窗口状态归一（getHistory 消费方共用一份，防散点缺省处理漂移）。
 * [u6] 三字段必填（shared protocol SSOT 对齐），无回落逻辑。
 */
export function historyWindowFromReply(reply: HistoryWindowReply): HistoryWindow {
  return {
    truncated: reply.truncated,
    loadedTurns: reply.loadedTurns,
    totalTurnsEstimate: reply.totalTurnsEstimate,
  }
}

/** 创建截断窗口状态控制器（chat store factory 体内实例化，per-factory 单例） */
export function createTruncatedWindowController() {
  /** 按 sessionId 分区的窗口状态（ref<Map>，不可变写保证响应式，对齐 occupancies 范式） */
  const historyWindows: Ref<Map<string, HistoryWindow>> = ref(new Map())

  /** 写入/覆盖该 session 的窗口状态（hydrate/reconcileHistory 随响应写；loadMoreHistory 收敛写） */
  function setHistoryWindow(sessionId: string, window: HistoryWindow): void {
    historyWindows.value = new Map(historyWindows.value).set(sessionId, window)
  }

  /** 读窗口状态。无记录（未 hydrate / 已清理）= undefined，消费方按「无截断」处理。 */
  function getHistoryWindow(sessionId: string): HistoryWindow | undefined {
    return historyWindows.value.get(sessionId)
  }

  /** 清除该 session 的窗口分区（disposeSession / LRU 驱逐；幂等）。 */
  function clearHistoryWindow(sessionId: string): void {
    if (!historyWindows.value.has(sessionId)) return
    const next = new Map(historyWindows.value)
    next.delete(sessionId)
    historyWindows.value = next
  }

  return { historyWindows, setHistoryWindow, getHistoryWindow, clearHistoryWindow }
}

export type TruncatedWindowController = ReturnType<typeof createTruncatedWindowController>
