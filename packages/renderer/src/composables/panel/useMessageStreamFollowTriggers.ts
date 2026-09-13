/**
 * useMessageStreamFollowTriggers —— MessageStream 跟随触发编排（chat-pin-bottom-fix D3/D5）。
 *
 * useMessageStreamScroll 的继任编排（同构先例：useMessageStreamScroll 当年同为
 * vue_rules_checker ≤300 行规范自 MessageStream.vue 拆出）。D5 减法：isCompacting /
 * isSessionActive 两个 watch 已随 RO 兜底网删除——isCompacting（活动条显隐）由 tailEl RO
 * 增高路径覆盖；isSessionActive 完成滚动由「trace 折叠 → spacer 变化 → 静默跟随」+ clamp
 * 回声覆盖（设计 docs/design/chat-pin-bottom-fix.md §4.3 D5）。
 *
 * D3 触发矩阵（「跟随」= 贴底则滚底；「标 unread」= 脱离则点亮「回到底部」浮层；所有触发
 * 统一进 follow 原语 followIfStuck——其 rAF 内重读 stickToBottom 的 guard 语义不变）：
 *
 * | 触发源                                    | 贴底       | 脱离       |
 * |-------------------------------------------|------------|------------|
 * | messages.length watch（store 级）          | 跟随       | 标 unread* |
 * | 末条文本长度 watch（isStreaming 守卫）      | 跟随       | 标 unread  |
 * | tailEl RO 增高（活动条/fork 出现） | 跟随       | 标 unread  |
 * | contentWrapEl RO 其余变化（spacer）         | 跟随       | 不动，不标 |
 * | scrollEl RO（视口 resize）                 | 跟随       | 不动，不标 |
 * | 纯宽度变化（高度未变）                      | 显式 no-op | 不标       |
 *
 *  * isPrepend（load-more 前插抑制窗）为真期间：跟随但不标 unread——用户主动翻历史，下方
 *    并无新内容（设计已声明语义差异：现状前插会点亮一次 unread，本矩阵刻意降噪，V9 验收覆盖）。
 *
 * 观察目标：contentWrapEl（Virtualizer + tailEl 的静态无样式 wrapper——spacer 与 tail 高度
 * 都投影到它的盒尺寸）+ scrollEl（滚动视口）。wrap RO 回调内先读 tailEl.offsetHeight 与
 * 上次快照比对区分「tail 变化」与「spacer 变化」（两类变化都会触发 wrap RO，先扣掉 tail
 * 分量）。两 RO 回调均调 notifyRoActivity()（喂 useVirtuaFollow 的 D7② 收敛抑制窗静默计时，
 * 时机 = 首次 RO 回调，不因双 rAF 拖延）。
 *
 * RO 回调内的跟随一律经 followFromRo() 双 rAF 触发（设计 §4.5 P-timing 降级预案「RO 回调内
 * 改为双 rAF（再让一帧）」，U5 验收 V6 shrink 方向间歇 113px 残留根修）：外层 rAF +
 * followIfStuck 内层 rAF → scrollToIndex 恒落在触发帧之后第二个帧的 rAF 阶段，晚于下一帧
 * 的 RO 投递（同帧次序 rAF → style/layout → RO 投递，设计 §3.1）——virtua 内部 RO（观察
 * 滚动容器、更新 viewportSize 测量缓存）即使被嵌套 resize 推迟一帧投递，也已先于我们的
 * 写入完成更新，消除「用旧视口算目标」的缝隙。
 */
import { onMounted, onScopeDispose, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { normalizeContent, type Message } from '@xyz-agent/shared'

interface MessageStreamFollowTriggerDeps {
  /** store 级消息源（MessageStream.currentMessages 同一 computed——条数与末条文本的观察基准） */
  messages: ComputedRef<Message[]>
  /**
   * 末条 turn（含 isStreaming 标志）。无 turn 时为 null——null 与 undefined 都视为「无值」，
   * 内部 optional chaining（?.isStreaming）统一处理（与原 useMessageStreamScroll 同构）。
   */
  lastRenderTurn: ComputedRef<{ isStreaming: boolean } | null>
  /** load-more 前插抑制窗信号（useLoadMoreHistory.isPrepend）：窗内跟随但不标 unread */
  isPrepend: Ref<boolean>
  /** 滚动容器 el（scrollEl——视口 resize RO 观察目标） */
  scrollEl: Ref<HTMLElement | null>
  /** follow 原语（useVirtuaFollow.followIfStuck）：全触发的统一入口，guard 在原语内部 */
  followIfStuck: (opts?: { markUnread?: boolean }) => void
  /** D7② RO 活动信号（useVirtuaFollow.notifyRoActivity 透传）：重置收敛抑制窗 120ms 静默计时 */
  notifyRoActivity: () => void
}

/**
 * 跟随触发编排（RO 兜底网 + store watch）。
 *
 * 返回 contentWrapEl / tailEl 供 MessageStream 模板绑定（ref），tailHeight 供
 * useVirtuaFollow 的 endOffset 消费（D2：offset=tailHeight 即真实底部）。
 */
export function useMessageStreamFollowTriggers(deps: MessageStreamFollowTriggerDeps): {
  contentWrapEl: Ref<HTMLElement | null>
  tailEl: Ref<HTMLElement | null>
  tailHeight: Ref<number>
} {
  const contentWrapEl = ref<HTMLElement | null>(null)
  const tailEl = ref<HTMLElement | null>(null)
  /** D2：尾部块实测总高（endOffset 数据源；RO 实测持续刷新，初始 0） */
  const tailHeight = ref(0)

  let wrapRo: ResizeObserver | null = null
  let scrollRo: ResizeObserver | null = null
  /** 上次快照（null = 未建基线；首个 RO 投递只建基线不触发跟随） */
  let prevTailHeight: number | null = null
  let prevWrapHeight: number | null = null

  /** 读 tailEl 当前高度并同步 tailHeight ref（保证 endOffset 恒为最新实测值） */
  function measureTail(): number {
    const h = tailEl.value?.offsetHeight ?? 0
    tailHeight.value = h
    return h
  }

  // ── RO 回调双 rAF 触发（P-timing 降级预案，见文件头）────────────────────────
  /** 外层 rAF 句柄（null = 无 pending；连续 RO 触发 cancel 合并，同 U1 pendingRafId 模式） */
  let pendingRoRafId: number | null = null
  /**
   * 外层合并的 markUnread sticky 位：同帧多个 RO 回调 cancel-reschedule 时，标记型（tail
   * 增高）调用不被后到的静默型调用取消丢失（对齐 U1 followIfStuck 的 pendingMarkUnread
   * 语义：cancel 只收敛滚动，不丢 unread 标记）。
   */
  let pendingRoMarkUnread = false

  /**
   * RO 回调内的统一 follow 入口：套一层外层 rAF 再调 followIfStuck（双 rAF，再让一帧）。
   * markUnread 语义逐分支透传（tail/spacer 二分与 isPrepend 门控不变），同帧合并由外层
   * 句柄 cancel + sticky 位完成。
   */
  function followFromRo(markUnread: boolean): void {
    if (typeof requestAnimationFrame === 'undefined') {
      // 测试 / SSR 兜底：无 rAF 直调（followIfStuck 内部自有无 rAF 的 microtask 兜底）
      deps.followIfStuck({ markUnread })
      return
    }
    if (markUnread) pendingRoMarkUnread = true
    if (pendingRoRafId !== null) cancelAnimationFrame(pendingRoRafId)
    pendingRoRafId = requestAnimationFrame(() => {
      pendingRoRafId = null
      const shouldMark = pendingRoMarkUnread
      pendingRoMarkUnread = false
      deps.followIfStuck({ markUnread: shouldMark })
    })
  }

  onMounted(() => {
    // 建基线先于 observe（RO observe 后必投递一次当前尺寸，有基线则该回调落 no-op 分支）；
    // 本 onMounted 注册早于 MessageStream 自己的 onMounted（followToBottom(true)），
    // 首滚时 tailHeight 已就绪。
    prevTailHeight = measureTail()
    prevWrapHeight = contentWrapEl.value?.offsetHeight ?? null

    if (typeof ResizeObserver === 'undefined') return // happy-dom 无 RO 时 store watch 通路仍有效

    // contentWrapEl RO：spacer 与 tail 高度变化都投影到本元素盒尺寸（D3 触发矩阵 3-6 行）
    wrapRo = new ResizeObserver((entries) => {
      deps.notifyRoActivity()
      const last = entries[entries.length - 1]
      const wrapHeight = last ? last.contentRect.height : (contentWrapEl.value?.offsetHeight ?? 0)
      const tailH = measureTail()
      const prevTail = prevTailHeight
      const prevWrap = prevWrapHeight
      prevTailHeight = tailH
      prevWrapHeight = wrapHeight
      if (prevTail === null || prevWrap === null) return // 首回调：只建基线
      if (tailH === prevTail && wrapHeight === prevWrap) return // 纯宽度变化（高度未变）→ no-op
      if (deps.isPrepend.value) {
        // 前插抑制窗：跟随但不标 unread（用户主动翻历史，下方并无新内容）
        followFromRo(false)
        return
      }
      if (tailH > prevTail) {
        // tail 增高：活动条/fork 行出现或长高 = 底部区域新内容 → 标 unread
        followFromRo(true)
      } else {
        // spacer 变化（fence finalize / 图片加载 / 估算收敛 / trace 折叠）→ 静默跟随不标
        followFromRo(false)
      }
    })
    if (contentWrapEl.value) wrapRo.observe(contentWrapEl.value)

    // scrollEl RO：视口 resize → 静默跟随（脱离态不标 unread；双 rAF 见文件头 P-timing）
    scrollRo = new ResizeObserver(() => {
      deps.notifyRoActivity()
      followFromRo(false)
    })
    if (deps.scrollEl.value) scrollRo.observe(deps.scrollEl.value)
  })

  // ── store 级 watch（D3 矩阵前两行；自 useMessageStreamScroll 迁入，语义逐路对齐）──

  // 消息条数变化 → 跟随（新消息 append / load-more 前插——前插抑制窗内跟随但不标 unread）
  watch(
    () => deps.messages.value.length,
    () => {
      if (deps.isPrepend.value) {
        deps.followIfStuck({ markUnread: false })
        return
      }
      deps.followIfStuck()
    },
  )

  // streaming 中 text 追加也触发跟随（按最后一条消息归一化后的文本长度）。
  // content 是 string | Segment[]：.length 对 string 是字符数、对 Segment[] 是元素数，语义不一致；
  // 用 normalizeContent 统一取纯文本长度，类型安全且对 token 级追加仍敏感。
  // 守卫语义与原 useMessageStreamScroll.ts:64 逐字对齐：仅在末 turn 流式中触发
  // （编辑历史消息等非流式内容变化不触发）。
  watch(
    () => {
      const list = deps.messages.value
      const last = list[list.length - 1]
      if (!last) return 0
      return normalizeContent(last.content).length
    },
    () => {
      if (deps.lastRenderTurn.value?.isStreaming) {
        deps.followIfStuck()
      }
    },
  )

  onScopeDispose(() => {
    // 外层 rAF pending 期间 dispose（session 切换/组件卸载）→ 取消，防泄漏与幽灵 follow
    if (pendingRoRafId !== null) {
      cancelAnimationFrame(pendingRoRafId)
      pendingRoRafId = null
    }
    wrapRo?.disconnect()
    scrollRo?.disconnect()
    wrapRo = null
    scrollRo = null
  })

  return { contentWrapEl, tailEl, tailHeight }
}
