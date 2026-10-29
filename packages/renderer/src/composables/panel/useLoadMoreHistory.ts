/**
 * useLoadMoreHistory —— 「加载更早」游标翻页的 loading 状态 + handler + 触顶自动加载（从 MessageStream.vue 拆出）。
 *
 * 职责（单一变化原因「load-more 交互态」，原 misplaced 在容器组件 MessageStream.vue 内）：
 * - loadingMore：加载中状态（驱动按钮 disabled + spinner + 文案切换）。
 * - showLoadMore：是否还有更早历史可加载（[u6] 由 store 截断窗口状态 truncated 派生，非默认 true）。
 * - handleLoadMore：防重入的加载调用（loadingMore/showLoadMore 检查）——[u6] 走
 *   useChat.loadMoreHistory 游标翻页（D4 中期形态，原 getFullHistory
 *   全量通路已退役），游标 = 分区最旧消息的文件侧身份，runtime 返回锚点之前的最近窗口。
 * - onScrollOffset：**滚到顶自动续载**（2026-09-19 会话实证：历史预算按字节收窗后，重会话
 *   一页仅 1–2 轮，靠手动点按钮翻页体验支撑不了）——偏移触顶且用户已脱离锚定时自动再拉一页，
 *   顶部条退化为「正在续载 / 还有更早」的进度位（按钮保留，作为触顶信号不可达时的兜底）。
 * - slowLine：**慢网兜底细线**（OpenDesign specs/chat/history-load-and-run-grouping.md §2.2）——
 *   加载启动 150ms 未完成才置 true（快载零指示防闪烁），完成即置 false；消费方
 *   （MessageStream .hist-line-sweep）渲染 2px accent 横扫细线并承担 160ms 淡出。
 * - loadMoreError：[RD-1#4] 上一次「加载更早」失败态——失败时 truncated 窗口不变（与「已到头」
 *   在状态上不可区分），旧实现只 console.warn + finally 复位 loading，用户侧症状 = 「点了没反应、
 *   无失败提示」。现由对话流顶部条渲染可重试错误行（LoadMoreErrorBar）。
 *
 * **per-session 隔离（ADR-0049 Map 分区范式，2026-10 审查迁移）**：loadingMore / isPrepend /
 * loadMoreError / slowLine 全部收进 useSessionScopedState 分区——切 sid 天然隔离（不再用
 * 实例级 ref + watch(sessionId) 手动复位）；跨 await 的收敛一律 `updateFor(sidAtStart)`
 * 写回**发起时**的分区，迟到落盘不污染新会话（M1 竞态的结构性消除）；session 删除经
 * cleanup 注册表清分区，迟到写对已删分区 no-op（updateFor 契约）。失败态按分区归属：
 * 切走再切回仍见该 session 自己的失败行（可重试），不跨 session 泄漏。
 *
 * 滚动锚定（P-paging 前半）：handleLoadMore 期间 isPrepend=true 喂 `<Virtualizer :shift>`，
 * virtua 按列表**末尾**保位（reverse scroll adjustment）——prepend 插入的更早历史不把
 * 视口往下推（virtua 单一 scrollTop owner，最小可靠形态）；同时也构造了自动续载的节流：
 * 插入后 offset 随新内容高度抬升，用户需再次主动上滑触顶才会触发下一页。
 *
 * 不含：load-more 按钮的 DOM 渲染 + 高度断言（容器 useConstantHeightAssert 负责）。
 *
 * @param sessionId 当前 session id getter
 */
import { computed, nextTick, reactive, type ComputedRef, type Ref } from 'vue'
import { useChat } from '@/composables/features/chat/useChat'
import { useChatStore } from '@/stores/chat'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { LOAD_MORE_RESERVED_HEIGHT } from './message-stream-layout'

/**
 * 触顶自动续载阈值（px）：滚动偏移 ≤ 该值即视为「已到顶」。
 * 44（LOAD_MORE_RESERVED_HEIGHT）× 1.5 ≈ 66——取 64 给用户 ~20px 提前量：滚到顶部条附近
 * 就开始续载，不必精确停在 0；又不会在离顶一屏时误触发。
 * [2026-10-15 pill 化] 条区仍 44（pill 自然高 = pt-3 12 + h-8 32），阈值语义不变，常量不动。
 */
export const TOP_AUTO_LOAD_THRESHOLD_PX = 64

/**
 * [RD-1#4] 失败重试行占位高度：LoadMoreErrorBar 行高（Button dense h-8 + 无 padding = 32px）。
 * 失败时顶部条容器多出这一行，:startMargin 必须同幅增补，否则该行会压住首条消息
 * （absolute top-0 容器不参与文档流，virta 只认 startMargin 的占位）。
 * 与 LOAD_MORE_RESERVED_HEIGHT 同族但独立：无失败行时占位不变（0 增补）。
 */
export const LOAD_MORE_ERROR_ROW_HEIGHT = 32

/**
 * [hist-line] 慢网兜底细线的显隐延迟（ms）：加载启动后超过该时长仍未完成才显示细线
 * （OpenDesign specs/chat/history-load-and-run-grouping.md §2.2）。快载（<150ms）全程
 * 零指示防闪烁——真实侧 cursor 翻页多为快载，细线只在慢网/大页时兜底显形。
 * 完成后的 160ms opacity 淡出不由本常量承担（CSS transition，见 MessageStream .hist-line-sweep）。
 */
export const SLOW_LINE_DELAY_MS = 150

/** per-session 分区态（reactive 容器，useSessionScopedState 响应式契约要求） */
interface LoadMorePartition {
  /** 加载中（防重入 + 按钮 spinner） */
  loadingMore: boolean
  /** [cw wave w3 / IF8] 顶部插入信号（驱动 `<Virtualizer :shift>` 保位） */
  isPrepend: boolean
  /** [RD-1#4] 上一次「加载更早」失败（顶部条渲染可重试错误行） */
  loadMoreError: boolean
  /** [hist-line] 慢网兜底细线显隐（spec §2.2） */
  slowLine: boolean
}

export function useLoadMoreHistory(
  sessionId: () => string,
  /** 列表项数 getter（顶部条占位判据：无条目时条不渲染，占位归 0） */
  itemCount?: () => number,
): {
  /** 加载中状态（disabled / spinner / 文案切换驱动） */
  loadingMore: Ref<boolean>
  /** 是否还有更早历史可加载（store 截断窗口 truncated 派生） */
  showLoadMore: ComputedRef<boolean>
  /** 防重入加载调用（loadingMore / showLoadMore 检查） */
  handleLoadMore: () => Promise<void>
  /** [cw wave w3 / IF8] 顶部插入信号（load-more 期间 true）。
   *  喂给 `<Virtualizer :shift>`：virta 在 shift=true 时按列表**末尾**保位（reverse scroll adjustment），
   *  专用于头部插入（load-more-history）——比手写 scrollAdjustDelta 补偿更准。 */
  isPrepend: Ref<boolean>
  /** 滚动位置信号入口（MessageStream 的 virtua @scroll 透传 offset）——触顶自动续载判定点。 */
  onScrollOffset: (offset: number, isDetached: boolean) => void
  /** [RD-1#4] 上一次「加载更早」失败（顶部条渲染可重试错误行；按分区归属本 session） */
  loadMoreError: Ref<boolean>
  /** [RD-1#4] virta startMargin：顶部条占位（含失败重试行增补） */
  topBarReservedHeight: ComputedRef<number>
  /** [hist-line] 慢网兜底细线显隐（spec §2.2）：加载启动 150ms 未完成才 true，
   *  完成（成功/失败）即 false；淡出由消费方 CSS transition 承担。 */
  slowLine: Ref<boolean>
} {
  const { loadMoreHistory, hasMoreHistory: checkHasMore } = useChat()

  // [ADR-0049 迁移] per-session 交互态 = Map 分区；init 必须 reactive（工厂响应式契约：
  // plain object 的 mutate 不触发下游 computed）
  const state = useSessionScopedState<LoadMorePartition>(computed(() => sessionId()), () =>
    reactive({
      loadingMore: false,
      isPrepend: false,
      loadMoreError: false,
      slowLine: false,
    }),
  )

  /** 是否有更早历史可加载（store 截断窗口 truncated 派生，非默认 true） */
  const showLoadMore = computed(() => checkHasMore(sessionId()))

  // 消费方 computed：读当前 sid 分区（切 sid 自动切视图，无需手动复位）
  const loadingMore = computed(() => state.current.value.loadingMore)
  const isPrepend = computed(() => state.current.value.isPrepend)
  // [session-cold-switch-perf §3.3-3] 合并后台重建失败态：historyCacheReady 失败帧把
  // 「正在加载更早」指示收敛为同一失败重试行（复用 loadMore 失败态形态，与手动翻页失败
  // 共用同一呈现）；重试动作（handleLoadMore 成功）或任意 history 重拉成功即清除。
  const loadMoreError = computed(
    () => state.current.value.loadMoreError || useChatStore().isHistoryCacheFailed(sessionId()),
  )
  const slowLine = computed(() => state.current.value.slowLine)

  async function handleLoadMore(): Promise<void> {
    if (loadingMore.value || !showLoadMore.value) return
    // [ADR-0049 M1 竞态] 捕获发起时 sid：跨 await 的全部落盘走 updateFor 写回原分区，
    // 切 sid 后的迟到收敛不写入新分区（updateFor 对已删分区 no-op，防僵尸写回）。
    const sidAtStart = sessionId()
    state.update((s) => {
      // [cw wave w3 / IF8] 顶部插入信号前置 true：virtua :shift=true 期间，renderItems 变长
      //   会保持滚动位置相对末尾不变（即插入的历史不把视口往下推）。
      s.isPrepend = true
      s.loadingMore = true
    })
    // [hist-line] 慢网兜底：150ms 未完成才置 true（快载零指示防闪烁，spec §2.2）。
    // 定时器自中和：settle 后触发即 no-op——不持共享句柄，跨 session 并发加载互不误清。
    let settled = false
    setTimeout(() => {
      if (settled) return
      state.updateFor(sidAtStart, (s) => {
        s.slowLine = true
      })
    }, SLOW_LINE_DELAY_MS)
    try {
      // loadMoreHistory 内部更新窗口状态（truncated=false 时 showLoadMore 收敛消失）
      // 等 virtua 处理完 data length change（vue 响应式 → Virtualizer watch data.length），
      // shift=true 在此窗口内生效后才能翻 false，否则后到的高度变化（RO 测量）失去保位。
      const ok = await loadMoreHistory(sidAtStart)
      await nextTick()
      // [RD-1#4] 失败显形：返回 false 时窗口状态未变（用户无法从 UI 推断失败），
      // 落 loadMoreError 由顶部条渲染可重试错误行；成功即清除本 session 上次失败态。
      state.updateFor(sidAtStart, (s) => {
        s.loadMoreError = !ok
      })
    } finally {
      settled = true
      // 细线立即翻 false，160ms opacity 淡出由消费方 CSS transition 承担（spec §2.2）
      state.updateFor(sidAtStart, (s) => {
        s.slowLine = false
        s.isPrepend = false
        s.loadingMore = false
      })
    }
  }

  /**
   * 滚动位置信号（MessageStream 的 onVirtuaScroll 透传）：触顶即自动续载一页。
   *
   * 两个前置条件各有职责：
   * - isDetached（用户已脱离锚定，= !stickToBottom）：把「用户主动上滑到顶」与
   *   「session 切换时 scrollTop 被 clamp 到 0 的程序性回声」区分开——后者发生时长滚到
   *   底的强滚尚未落地且 stickToBottom 被 force 置 true，不会白拉一页历史。
   * - offset ≤ THRESHOLD：触顶判定；续载后 virtua :shift 保位把 offset 抬到阈值以上，
   *   天然节流为「每次主动上滑至顶拉一页」。
   * 防重入直接复用 handleLoadMore 自身的 loadingMore/showLoadMore 检查（单一状态源，
   * per-session 分区各守各的）。
   */
  function onScrollOffset(offset: number, isDetached: boolean): void {
    if (!isDetached) return
    if (offset > TOP_AUTO_LOAD_THRESHOLD_PX) return
    if (loadingMore.value || !showLoadMore.value) return
    void handleLoadMore()
  }

  /**
   * [RD-1#4] virta startMargin：截断顶部条占位（含失败重试行的增补）。
   * 收在本 composable 内而非容器组件——它是 load-more 交互态自身的布局派生量
   * （showLoadMore × loadMoreError × 列表非空），与 MessageStream 的其它定位关注点无关。
   */
  const topBarReservedHeight = computed(() =>
    showLoadMore.value && (itemCount?.() ?? 0) > 0
      ? LOAD_MORE_RESERVED_HEIGHT + (loadMoreError.value ? LOAD_MORE_ERROR_ROW_HEIGHT : 0)
      : 0,
  )

  return {
    loadingMore,
    showLoadMore,
    handleLoadMore,
    isPrepend,
    onScrollOffset,
    loadMoreError,
    topBarReservedHeight,
    slowLine,
  }
}
