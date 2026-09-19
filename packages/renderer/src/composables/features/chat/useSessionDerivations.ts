/**
 * useSessionDerivations —— session 派生状态轻量 composable（R2 features 层）。
 *
 * 重构动机（2026-07-02 架构返工 C3）：useSidebar 曾吞 5 个关注点
 * （session CRUD + 启动编排 initApp + 派生状态 derivedStatus + 命令时序修补 +
 * 文件树预触发），8 个消费者各只用一部分。其中 derivedStatus 是纯派生计算，
 * 被多个「只需派生状态、不需要 session CRUD 巨型闭包」的消费者（Sidebar/PanelContainer）共用。
 *
 * 本 composable 把派生职责从 useSidebar 抽离，让只用派生状态的消费者改依赖本轻量 composable，
 * 不再拉入 useSidebar 的 session CRUD 巨型闭包（消除不必要的依赖耦合）。
 *
 * 派生逻辑本体（deriveStatus 纯函数）在 composables/logic/sessionStatus.ts（与 DOT_CLASS 同源，
 * 5 态 SSOT 聚合）；本 composable 只做「读 chat/session store → 包成响应式 ComputedRef」的薄包装。
 *
 * 为什么是 features 层而非 store 内：stores 互不 import，派生需同时读 chat store（消息分区）+
 * session store（activeId），无法放在单个 store 内（R2 铁律：stores 间禁止互相 import）。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useBackgroundWork } from '@/composables/features/chat/useBackgroundWork'
import { deriveStatus } from '@/composables/logic/sessionStatus'
import type { DerivedStatus } from '@/types'

/**
 * computed 实例缓存（W3，ADR 侧栏性能优化）。
 *
 * 模块级 Map 缓存 derivedStatus 的 ComputedRef 实例，同 id 复用，
 * 消除 Sidebar statusOf 每次 `derivedStatus(id).value` 新建 computed 立即丢弃的浪费
 * （原实现缓存机制完全失效，侧栏每次渲染 O(N×M)）。
 *
 * 缓存共享合理：所有 useSessionDerivations() 调用者（Sidebar）读同一 chat store，
 * session id 命名空间一致，Pinia store 是应用级单例。deleteSession 时调 invalidateStatusCache
 * 清理，避免已删 session 的 computed 残留（残留非泄漏——页面刷新全清，但显式清理更洁）。
 */
// @data-owner #11 —— #11 session 活跃态的 renderer 派生缓存（per-session DerivedStatus computed 复用；失效经 invalidateStatusCache，非第二写方）
const statusCache = new Map<string, ComputedRef<DerivedStatus>>()

export function useSessionDerivations() {
  const chat = useChatStore()
  // W6：重新引入 session store 取元数据 status（metaStatus）——去全量预 hydrate 后，
  // 未访问 session 的终态（done/error/stopped）来自 runtime session_end 元数据。
  const session = useSessionStore()
  // RK3：subagent/workflow/extensionUI store 在 useSessionDerivations 外层闭包取（Pinia 单例引用稳定）。
  // computed 体内实际调用 hasBackgroundWork/hasPendingBlockingOverlay，建立对各自 records Map 的响应式依赖。
  // 别名 hasSessionBackgroundWork：与 derivedStatus computed 体内同名局部变量解耦（避免 shadow）。
  const { hasBackgroundWork: hasSessionBackgroundWork } = useBackgroundWork()
  const extensionUIStore = useExtensionUIStore()

  /**
   * 响应式派生指定 session 的状态点（D6）。
   * 读 chat store 分区末尾消息 + isActive（pendingSend ∨ isGenerating）。
   * [W1] isActive 作为 UI 层 SSOT，消除提交后到 message_start 之间空窗期的状态不一致。
   * [W3] 同 id 复用缓存的 ComputedRef（消除每次新建丢弃的浪费）。computed 只在依赖变化时重算，
   * 配合 W2 的 isGenerating O(1)，单次重算也高效。
   * [W6] 传 metaStatus（session 元数据 status），未 hydrate session 用它兜底终态。
   */
  function derivedStatus(id: string): ComputedRef<DerivedStatus> {
    let c = statusCache.get(id)
    if (!c) {
      // [W10 KNOWN-LIMIT] session.list.find 是 O(n)，侧栏 N 个 session 各调一次 derivedStatus
      // 致整体 O(n²)。session.list 规模通常 <50（用户活跃 session 数有限，LRU 上限 8），
      // O(n²) 可接受，不做 index Map 优化（避免引入额外维护成本）。若未来 session 规模增长，
      // 可改用 Map<id, status> 索引（session store 内维护）降至 O(n)。
      c = computed(() => {
        const meta = session.list.find((s) => s.id === id)?.status
        // hasBackgroundWork：主 turn 已结束但有 background subagent/workflow 仍在跑 → working 态。
        // 必须在 computed 体内读（建立对 recordsBySession 的响应式依赖，records 变化自动重算）。
        const hasBackgroundWork = hasSessionBackgroundWork(id)
        // hasFormOverlayPending：统一表单 overlay 请求 pending → waiting 态。
        // 判定键 = form 键，权威口径见 stores/extension-ui.ts hasPendingBlockingOverlay
        // 注释：新 form 帧原生携带、legacy askUser / scheduleCreate 帧经归一层附加后
        // 统一命中（T3 + schedule-create U6 随判定键收敛自动联动）。
        // 非响应式 getter，但 computed 通过其引用的 requestsBySession 响应式 ref 建立依赖。
        const hasFormOverlayPending = extensionUIStore.hasPendingBlockingOverlay(id)
        return deriveStatus(id, chat, chat.isActive(id), chat.isCompacting(id), hasBackgroundWork, meta, hasFormOverlayPending)
      })
      statusCache.set(id, c)
    }
    return c
  }

  return {
    derivedStatus,
    invalidateStatusCache,
  }
}

/**
 * 清除派生状态缓存（deleteSession 时调用，W3）。
 * @param sessionId 指定 id 清除；不传则清除全部。
 */
export function invalidateStatusCache(sessionId?: string): void {
  if (sessionId) {
    statusCache.delete(sessionId)
  } else {
    statusCache.clear()
  }
}
