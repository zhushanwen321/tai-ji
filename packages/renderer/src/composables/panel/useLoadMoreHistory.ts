/**
 * useLoadMoreHistory —— 「加载更早」游标翻页的 loading 状态 + handler（从 MessageStream.vue 拆出）。
 *
 * 职责（单一变化轴「load-more 交互态」，原 misplaced 在容器组件 MessageStream.vue 内）：
 * - loadingMore：加载中 ref（驱动按钮 disabled + spinner + 文案切换）。
 * - showLoadMore：是否还有更早历史可加载（[u6] 由 store 截断窗口状态 truncated 派生，非默认 true）。
 * - handleLoadMore：防重入的加载调用（loadingMore/showLoadMore 守卫）——[u6] 走
 *   useChat.loadMoreHistory 游标翻页（crash-resilience §3.3 D4 中期，原 getFullHistory
 *   全量通路已退役），游标 = 分区最旧消息的文件侧身份，runtime 返回锚点之前的最近窗口。
 *
 * 滚动锚定（P-paging 前半）：handleLoadMore 期间 isPrepend=true 喂 `<Virtualizer :shift>`，
 * virtua 按列表**末尾**保位（reverse scroll adjustment）——prepend 插入的更早历史不把
 * 视口往下推（virtua 单一 scrollTop owner，最小可靠形态）。
 *
 * 不含：load-more 按钮的 DOM 渲染 + 高度断言（容器 useConstantHeightAssert 负责）。
 *
 * @param sessionId 当前 session id getter
 */
import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue'
import { useChat } from '@/composables/features/chat/useChat'

export function useLoadMoreHistory(sessionId: () => string): {
  /** 加载中状态（disabled / spinner / 文案切换驱动） */
  loadingMore: Ref<boolean>
  /** 是否还有更早历史可加载（store 截断窗口 truncated 派生） */
  showLoadMore: ComputedRef<boolean>
  /** 防重入加载调用（loadingMore / showLoadMore 守卫） */
  handleLoadMore: () => Promise<void>
  /** [cw wave w3 / IF8] 顶部插入信号（load-more 期间 true）。
   *  喂给 `<Virtualizer :shift>`：virta 在 shift=true 时按列表**末尾**保位（reverse scroll adjustment），
   *  专用于头部插入（load-more-history）——比手写 scrollAdjustDelta 补偿更准。 */
  isPrepend: Ref<boolean>
  } {
  const { loadMoreHistory, hasMoreHistory: checkHasMore } = useChat()
  /** 「加载更早」loading 状态 */
  const loadingMore = ref(false)
  /** [cw wave w3 / IF8] 顶部插入信号：handleLoadMore 期间 true，驱动 `<Virtualizer :shift>` 保位 */
  const isPrepend = ref(false)
  /** 是否有更早历史可加载（store 截断窗口 truncated 派生，非默认 true） */
  const showLoadMore = computed(() => checkHasMore(sessionId()))

  async function handleLoadMore(): Promise<void> {
    if (loadingMore.value || !showLoadMore.value) return
    // [cw wave w3 / IF8] 顶部插入信号前置 true：virtua :shift=true 期间，renderItems 变长
    //   会保持滚动位置相对末尾不变（即插入的历史不把视口往下推）。
    isPrepend.value = true
    loadingMore.value = true
    try {
      await loadMoreHistory(sessionId())
      // loadMoreHistory 内部更新窗口状态（truncated=false 时 showLoadMore 收敛消失）
      // 等 virtua 处理完 data length change（vue 响应式 → Virtualizer watch data.length），
      // shift=true 在此窗口内生效后才能翻 false，否则后到的高度变化（RO 测量）失去保位。
      await nextTick()
    } finally {
      isPrepend.value = false
      loadingMore.value = false
    }
  }

  return { loadingMore, showLoadMore, handleLoadMore, isPrepend }
}
