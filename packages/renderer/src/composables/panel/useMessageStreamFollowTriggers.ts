/**
 * useMessageStreamFollowTriggers —— MessageStream 跟随触发编排（D3/D5）。
 *
 * useMessageStreamScroll 的继任编排（同构先例：useMessageStreamScroll 当年同为
 * vue_rules_checker ≤300 行规范自 MessageStream.vue 拆出）。D5 减法：isCompacting /
 * isSessionActive 两个 watch 已随 RO 兜底网删除——isCompacting（活动条显隐）由 tailEl RO
 * 增高路径覆盖；isSessionActive 完成滚动由「trace 折叠 → spacer 变化 → 静默跟随」+ clamp
 * 回声覆盖（D5）。
 *
 * D3 触发矩阵（「跟随」= 贴底则滚底；脱离态一律不滚（followIfStuck 的 rAF 重读 guard 内聚）；
 * 所有触发统一进 follow 原语 followIfStuck。[ui-optimize-unified 决策 12] 旧「标 unread」
 * 列随未读标记状态链退役——「回到最新」胶囊浮现改由距底几何判定驱动，触发源不再区分
 * 标记/静默两档，tail/spacer 二分与前插（isPrepend）抑制窗的标记门控一并失去消费方，退役）：
 *
 * | 触发源                                    | 贴底       | 脱离       |
 * |-------------------------------------------|------------|------------|
 * | messages.length watch（store 级）          | 跟随       | 不滚       |
 * | 末条文本长度 watch（isStreaming 检查）      | 跟随       | 不滚       |
 * | contentWrapEl RO 高度变化（tail/spacer）   | 跟随       | 不滚       |
 * | scrollEl RO（视口 resize）                 | 跟随       | 不滚       |
 * | 纯宽度变化（高度未变）                      | 显式 no-op | —          |
 * | 尾部新增 user 消息（用户主动发送，见下）     | 强制回底重锚定**        |
 *
 *  ** feat-new-message-to-bottom：「不扯用户」保护（INVAR-M4-2′）只约束**到来**的内容
 *  （assistant 流式 / 工具输出 / system notice）——用户在 composer 主动发送的消息是显式
 *  用户意图，脱离态也必须回底（业界聊天通用行为：发送即回底，用户要看到自己刚发的消息
 *  与后续回复）。本行是唯一绕过 stickToBottom guard 的触发，走 followToBottomForce
 *  （= followToBottom(true)，重置贴底态 + NaN 快照 + 开收敛抑制窗，force 第二合法来源）。
 *
 * 观察目标：contentWrapEl（Virtualizer + tailEl 的静态无样式 wrapper——spacer 与 tail 高度
 * 都映射到它的盒尺寸）+ scrollEl（滚动视口）。wrap RO 回调读 tailEl.offsetHeight 维护
 * tailHeight 快照（endOffset 数据源）并以高度快照区分「纯宽度变化」（no-op）与真实高度变化。
 * 两 RO 回调均调 notifyRoActivity()（喂 useVirtuaFollow 的 D7② 收敛抑制窗静默计时，
 * 时机 = 首次 RO 回调，不因双 rAF 拖延）。
 *
 * RO 回调内的跟随一律经 followFromRo() 双 rAF 触发（设计 §4.5 P-timing 降级预案「RO 回调内
 * 改为双 rAF（再让一帧）」，U5 验收 V6 shrink 方向间歇 113px 残留从根源修复）：外层 rAF +
 * followIfStuck 内层 rAF → scrollToIndex 恒落在触发帧之后第二个帧的 rAF 阶段，晚于下一帧
 * 的 RO 投递（同帧次序 rAF → style/layout → RO 投递，设计 §3.1）——virtua 内部 RO（观察
 * 滚动容器、更新 viewportSize 测量缓存）即使被嵌套 resize 推迟一帧投递，也已先于我们的
 * 写入完成更新，消除「用旧视口算目标」的缝隙。
 */
import { onMounted, onScopeDispose, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { normalizeContent, type Message } from '@taiji/shared'

interface MessageStreamFollowTriggerDeps {
  /** store 级消息源（MessageStream.currentMessages 同一 computed——条数与末条文本的观察基准） */
  messages: ComputedRef<Message[]>
  /**
   * 末条 turn（含 isStreaming 标志）。无 turn 时为 null——null 与 undefined 都视为「无值」，
   * 内部 optional chaining（?.isStreaming）统一处理（与原 useMessageStreamScroll 同构）。
   */
  lastRenderTurn: ComputedRef<{ isStreaming: boolean } | null>
  /** 滚动容器 el（scrollEl——视口 resize RO 观察目标） */
  scrollEl: Ref<HTMLElement | null>
  /** follow 原语（useVirtuaFollow.followIfStuck）：全触发的统一入口，guard 在原语内部 */
  followIfStuck: () => void
  /** D7② RO 活动信号（useVirtuaFollow.notifyRoActivity 透传）：重置收敛抑制窗 120ms 静默计时 */
  notifyRoActivity: () => void
  /**
   * 强制回底（useVirtuaFollow.followToBottom(true) 透传）：无视 stickToBottom guard，
   * 重置贴底态 + NaN 快照 + 开收敛抑制窗。唯一调用点 = 尾部新增 user 消息（用户主动发送，
   * 触发矩阵末行——force 第二合法来源，与「回到最新」胶囊点击同级）。
   */
  followToBottomForce: () => void
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
   * RO 回调内的统一 follow 入口：套一层外层 rAF 再调 followIfStuck（双 rAF，再让一帧）。
   * 同帧合并由外层句柄 cancel 完成（[决策 12] 旧 markUnread sticky 位随标记/静默分档退役——
   * 合并只剩滚动收敛一义，cancel 不再可能丢失任何标记语义）。
   */
  function followFromRo(): void {
    if (typeof requestAnimationFrame === 'undefined') {
      // 测试 / SSR 兜底：无 rAF 直调（followIfStuck 内部自有无 rAF 的 microtask 兜底）
      deps.followIfStuck()
      return
    }
    if (pendingRoRafId !== null) cancelAnimationFrame(pendingRoRafId)
    pendingRoRafId = requestAnimationFrame(() => {
      pendingRoRafId = null
      deps.followIfStuck()
    })
  }

  onMounted(() => {
    // 建基线先于 observe（RO observe 后必投递一次当前尺寸，有基线则该回调落 no-op 分支）；
    // 本 onMounted 注册早于 MessageStream 自己的 onMounted（followToBottom(true)），
    // 首滚时 tailHeight 已就绪。
    prevTailHeight = measureTail()
    prevWrapHeight = contentWrapEl.value?.offsetHeight ?? null

    if (typeof ResizeObserver === 'undefined') return // happy-dom 无 RO 时 store watch 通路仍有效

    // contentWrapEl RO：spacer 与 tail 高度变化都映射到本元素盒尺寸（D3 触发矩阵 3-4 行）。
    // [决策 12] tail/spacer 二分与 isPrepend 前插抑制窗随标记分档退役——两类变化统一跟随
    // （tailHeight 快照照常维护：它是 endOffset 数据源，与本 RO 的触发职责解耦）。
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
      followFromRo()
    })
    if (contentWrapEl.value) wrapRo.observe(contentWrapEl.value)

    // scrollEl RO：视口 resize → 跟随（脱离态不滚由 guard 内聚；双 rAF 见文件头 P-timing）
    scrollRo = new ResizeObserver(() => {
      deps.notifyRoActivity()
      followFromRo()
    })
    if (deps.scrollEl.value) scrollRo.observe(deps.scrollEl.value)
  })

  // ── store 级 watch（D3 矩阵前两行；自 useMessageStreamScroll 迁入，语义逐路对齐）──

  // 消息条数变化 → 跟随（新消息 append / load-more 前插同型）
  watch(
    () => deps.messages.value.length,
    () => {
      deps.followIfStuck()
    },
  )

  // ── 用户主动发送 → 强制回底重锚定（触发矩阵末行，唯一绕过 guard 的触发）────────
  // 判据 = 末条消息「role:id」快照变化 ∧ role==='user'（尾部新增 user 消息）。
  // appendUser 是全部用户意图路径的共同落点，一处覆盖全部：
  // - composer 直发（useChat.send → appendUser 乐观插入）
  // - steer / followUp（pushPending 不进流，投递时 drainN → appendUser 尾插）
  // - defer 入队 flush 重放（flush → send → appendUser）
  // - 编辑重发（editAndResend → truncateFrom + appendUser）
  // 排除面（结构性不触发）：load-more 前插（尾部身份不变，新增在头部）；assistant 流式 /
  // system notice / bashExecution 追加（role ≠ user，仍走 followIfStuck 矩阵）；末条 user
  // 消息同 id 对象替换（segments 回填等，快照不变）。
  watch(
    () => {
      const list = deps.messages.value
      const last = list[list.length - 1]
      return last ? `${last.role}:${last.id}` : null
    },
    (cur, prev) => {
      if (!cur || cur === prev || !cur.startsWith('user:')) return
      deps.followToBottomForce()
    },
  )

  // streaming 中 text 追加也触发跟随（按最后一条消息归一化后的文本长度）。
  // content 是 string | Segment[]：.length 对 string 是字符数、对 Segment[] 是元素数，语义不一致；
  // 用 normalizeContent 统一取纯文本长度，类型安全且对 token 级追加仍敏感。
  // 检查语义与原 useMessageStreamScroll.ts:64 逐字对齐：仅在末 turn 流式中触发
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
