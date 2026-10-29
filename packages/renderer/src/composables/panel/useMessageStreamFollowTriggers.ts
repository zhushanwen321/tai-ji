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
 * | 触发源                                          | 贴底               | 脱离   |
 * |-------------------------------------------------|--------------------|--------|
 * | renderItems 条数 watch（append / 前插同型）        | 跟随（直调）         | 不滚   |
 * | streaming 回合文本总长 watch（数据信号通路）        | 跟随（followFromRo） | 不滚   |
 * | contentWrapEl RO 高度变化（测量支留守 + 触发支兜底）| 窗尾跟随（debounce） | 不滚   |
 * | scrollEl RO（视口尺寸变化，无宽高区分）             | 跟随（不经 debounce）| 不滚   |
 * | 纯宽度变化（高度未变）                             | 显式 no-op          | —      |
 * | 提交序号递增（用户主动发送，见下）                  | 强制回底重锚定**     |        |
 *
 *  ** feat-new-message-to-bottom：「不扯用户」保护（INVAR-M4-2′）只约束**到来**的内容
 *  （assistant 流式 / 工具输出 / system notice）——用户在 composer 主动发送的消息是显式
 *  用户意图，脱离态也必须回底（业界聊天通用行为：发送即回底，用户要看到自己刚发的消息
 *  与后续回复）。本行是唯一绕过 stickToBottom guard 的触发，走 followToBottomForce
 *  （= followToBottom(true)，重置贴底态 + NaN 快照 + 开收敛抑制窗，force 第二合法来源）。
 *  [chat-flow-consistency F1] 触发判据从「尾部新增 user 消息」的数据变化推断改为消费
 *  chat store 的 per-session 提交序号（submitNewMessage 受理确认单点递增——事实在产生处
 *  带上标记）：旧 watch 被 morph 回执重建 / 外来直发复用 user 消息身份尾插命中，把上翻
 *  阅读中的用户强拉回底；序号只由真实提交路径递增，回执重建与外来注入不再误触发。
 *
 * 通路分工（触发权归属）：流式跟随的主触发 = 数据信号通路（streaming 回合文本总长 watch）——
 * 内容该跟随的原因是流式 delta 到达（数据层信号，每 delta 恰好一次触发），观察对象锚定
 * renderItems 派生链过滤 isStreaming 回合（不裸遍历 messages 原始数组：isStreaming 是
 * MessageTurn 派生字段，原始 Message 类型无此标志）；bash 系统消息 append 到末位的双工作态
 * 窗口内，退居非末位的 streaming 回合增长同样被覆盖。wrap RO 观察的是「自己刚写入的布局
 * 效果」，只留守测量职责（tailHeight / 距底快照）+ 触发支 debounce 尾沿兜底无数据信号的
 * 高度变化（shiki 异步高亮、图片加载、条目显隐、trace 折叠、估算高度→实测收敛）——流式
 * 期间高频投递不断重置计时器、触发支零执行，窗尾到期才走一次 followFromRo。
 *
 * [chat-flow-consistency F2] 脱离态几何快照刷新调用点（两处）：wrap RO 测量支（高度变化
 * 投递）与 renderItems 条数 watch——高度/条数变化事实喂 refreshDistanceSnapshot（贴底态
 * guard 内聚于原语），脱离静止用户的「回到最新」胶囊随内容增长及时浮现。
 *
 * 观察目标：contentWrapEl（Virtualizer + tailEl 的静态无样式 wrapper——spacer 与 tail 高度
 * 都映射到它的盒尺寸）+ scrollEl（滚动视口）。wrap RO 回调分两支：测量支每投递必执行
 * （读 tailEl.offsetHeight 维护 tailHeight 快照 = endOffset 数据源，并以高度快照区分
 * 「纯宽度变化」no-op）；触发支改 debounce 尾沿（计时器到期才触发）。scrollEl RO 无宽高
 * 区分（宽/高任意维度变化均投递均触发——视口变化必有跟随需要且低频，不值得引入判定分支），
 * 也不经 debounce。两 RO 回调均调 notifyRoActivity()（喂 useVirtuaFollow 的 D7② 收敛抑制
 * 窗静默计时，时机 = 首次 RO 回调，不因双 rAF 拖延）。
 *
 * RO 回调内的跟随一律经 followFromRo() 双 rAF 触发（设计 §4.5 P-timing 降级预案「RO 回调内
 * 改为双 rAF（再让一帧）」，U5 验收 V6 shrink 方向间歇 113px 残留从根源修复）：外层 rAF +
 * followIfStuck 内层 rAF → scrollToIndex 恒落在触发帧之后第二个帧的 rAF 阶段，晚于下一帧
 * 的 RO 投递（同帧次序 rAF → style/layout → RO 投递，设计 §3.1）——virtua 内部 RO（观察
 * 滚动容器、更新 viewportSize 测量缓存）即使被嵌套 resize 推迟一帧投递，也已先于我们的
 * 写入完成更新，消除「用旧视口算目标」的缝隙。数据信号通路（streaming 回合文本总长 watch）
 * 复用同一 followFromRo：外层 rAF 晚于 Vue 微任务队列（DOM patch 完成后），滚动落点与 RO
 * 路径的 P-timing 等价（不新写 nextTick 等待逻辑）。
 */
import { onMounted, onScopeDispose, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { normalizeContent } from '@taiji/shared'
import type { RenderItem } from '@/composables/logic/messageTurns'

/** wrap RO 触发支的 debounce 窗口值（尾沿：每次投递重置计时器，到期才触发 follow）。
 *  初值 250ms（真机验收节点校准：流式间隙超窗即兜底盲区源变化，窗口过大只增加盲区跟随
 *  延迟、过小则流式间隙偶发一次幂等兜底滚动——均非错误，参数校准不改结构）。 */
export const RO_FOLLOW_DEBOUNCE_MS = 250

interface MessageStreamFollowTriggerDeps {
  /**
   * 流渲染项基准（MessageStream.renderItems 同一 computed——renderItems 条数 watch 与
   * streaming 回合文本总长 watch 两路观察共用）。turn 项携带 MessageTurn（isStreaming
   * 派生字段在 turn 上，原始 Message 类型无此标志——禁裸遍历 messages 原始数组）。
   */
  renderItems: ComputedRef<RenderItem[]>
  /**
   * 本 session 的提交序号 getter（chat store getSubmitSeq——[chat-flow-consistency F1]
   * force 回底的触发源）：递增 = 用户主动发送（submitNewMessage 受理确认单点 +1，覆盖
   * send / followUp / editAndResend 全部提交路径）。morph 回执重建 / 外来直发不动序号，
   * 结构性不触发 force。
   */
  submitSeq: () => number
  /** 滚动容器 el（scrollEl——视口 resize RO 观察目标） */
  scrollEl: Ref<HTMLElement | null>
  /** follow 原语（useVirtuaFollow.followIfStuck）：全触发的统一入口，guard 在原语内部 */
  followIfStuck: () => void
  /** D7② RO 活动信号（useVirtuaFollow.notifyRoActivity 透传）：重置收敛抑制窗 120ms 静默计时 */
  notifyRoActivity: () => void
  /**
   * 强制回底（useVirtuaFollow.followToBottom(true) 透传）：无视 stickToBottom guard，
   * 重置贴底态 + NaN 快照 + 开收敛抑制窗。唯一调用点 = 提交序号递增（用户主动发送，
   * 触发矩阵末行——force 第二合法来源，与「回到最新」胶囊点击同级）。
   */
  followToBottomForce: () => void
  /**
   * [chat-flow-consistency F2] 脱离态几何快照刷新（useVirtuaFollow.refreshDistanceSnapshot
   * 透传）：wrap RO 测量支（高度变化投递）/ 条数 watch 两个调用点喂入，脱离态胶囊浮现
   * 判定即时跟上几何事实（贴底态 guard 在原语内聚，调用方零判定）。
   */
  refreshDistanceSnapshot: () => void
}

/**
 * 跟随触发编排（数据信号主触发 + wrap RO 测量留守 / 触发支 debounce 兜底 + store watch）。
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
  /** 外层 rAF 句柄（null = 无 pending；连续触发 cancel 合并，同 U1 pendingRafId 模式） */
  let pendingRoRafId: number | null = null

  /**
   * RO / 数据信号通路内的统一 follow 入口：套一层外层 rAF 再调 followIfStuck（双 rAF，
   * 再让一帧）。同帧合并由外层句柄 cancel 完成（[决策 12] 旧 markUnread sticky 位随
   * 标记/静默分档退役——合并只剩滚动收敛一义，cancel 不再可能丢失任何标记语义）。
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

  // ── wrap RO 触发支 debounce 尾沿（流式期间高频投递不断重置计时器 → 触发支零执行；
  //    流停/间隙超窗后窗尾到期执行一次，覆盖的正是无数据信号的盲区高度变化源）────────
  /** debounce 计时器句柄（实例态闭包：每个 MessageStream 挂载域一份，随 dispose 复位） */
  let roFollowTimerId: ReturnType<typeof setTimeout> | null = null
  /** 本 debounce 窗内计时器被高频投递重置的次数（S7 dev 观测载体，与计时器同闭包不跨模块） */
  let devWindowResets = 0

  function scheduleRoFollowDebounced(): void {
    const hadPending = roFollowTimerId !== null
    if (roFollowTimerId !== null) clearTimeout(roFollowTimerId)
    if (hadPending && import.meta.env.DEV) devWindowResets += 1
    roFollowTimerId = setTimeout(() => {
      roFollowTimerId = null
      if (import.meta.env.DEV) {
        // S7 载体：窗尾汇总输出一条（流式期间逐投递输出会刷屏——汇总形态与护栏
        // P-no-loop「沿触发只报一次」的防刷屏先例同构）；计数证明高频投递确实在
        // 重置计时器而非碰巧没触发。非 dev 构建整支裁剪零开销。
        console.info(
          `[follow-triggers] wrap RO 触发支 debounce 窗到期执行（本窗投递重置 ${devWindowResets} 次）`,
        )
        devWindowResets = 0
      }
      followFromRo()
    }, RO_FOLLOW_DEBOUNCE_MS)
  }

  onMounted(() => {
    // 建基线先于 observe（RO observe 后必投递一次当前尺寸，有基线则该回调落 no-op 分支）；
    // 本 onMounted 注册早于 MessageStream 自己的 onMounted（followToBottom(true)），
    // 首滚时 tailHeight 已就绪。
    prevTailHeight = measureTail()
    prevWrapHeight = contentWrapEl.value?.offsetHeight ?? null

    if (typeof ResizeObserver === 'undefined') return // happy-dom 无 RO 时 store watch 通路仍有效

    // contentWrapEl RO：测量留守 + 触发支 debounce 尾沿兜底（D3 触发矩阵 3 行）。
    // 测量支每投递必执行（notifyRoActivity / measureTail / 基线快照维护——tailHeight 是
    // endOffset 数据源，触发职责收窄后照常刷新）；[决策 12] tail/spacer 二分与 isPrepend
    // 前插抑制窗随标记分档退役——两类变化统一跟随。基线未建只建基线、纯宽度变化显式
    // no-op（两支同门）。[chat-flow-consistency F2] 高度变化事实同步喂脱离态几何快照刷新
    // （测量支职责）——脱离静止用户的「回到最新」胶囊随内容增长即时浮现。
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
      deps.refreshDistanceSnapshot()
      scheduleRoFollowDebounced()
    })
    if (contentWrapEl.value) wrapRo.observe(contentWrapEl.value)

    // scrollEl RO：视口尺寸变化 → 跟随（脱离态不滚由 guard 内聚；双 rAF 见文件头 P-timing）。
    // 不经 debounce（视口变化必有跟随需要且低频）；无宽高区分（宽/高任意维度变化均触发）。
    scrollRo = new ResizeObserver(() => {
      deps.notifyRoActivity()
      followFromRo()
    })
    if (deps.scrollEl.value) scrollRo.observe(deps.scrollEl.value)
  })

  // ── store 级 watch（D3 矩阵前两行；自 useMessageStreamScroll 迁入，语义逐路对齐）──

  // 渲染项条数变化 → 脱离态几何快照刷新（[F2]）+ 跟随（直调不套外层 rAF：新消息 append /
  // load-more 前插 / bash 系统消息 append 同型；scrollToIndex 索引直取末项，估算高度误差由
  // wrap RO 触发支 debounce 窗尾兜底收敛；前插由 virtua :shift 原生位移补偿。贴底态快照
  // 刷新由原语内 guard 拦下，跟随照常）
  watch(
    () => deps.renderItems.value.length,
    () => {
      deps.refreshDistanceSnapshot()
      deps.followIfStuck()
    },
  )

  // ── 用户主动发送 → 强制回底重锚定（触发矩阵末行，唯一绕过 guard 的触发）────────
  // [chat-flow-consistency F1] 判据 = 本 session 提交序号递增（提交事实在产生处标记——
  // chat store submitSeqs 分区，submitNewMessage 受理确认单点 +1，send / followUp /
  // editAndResend 三通路共同上提点）。替代旧「尾部新增 user 消息」watch（已删除）：后者
  // 被 morph 回执重建（user-delivery 复用原 clientUuid 尾插）与外来直发命中，把上翻阅读
  // 中的用户强拉回底——序号不动即不触发，回执重建后的新回合内容对贴底用户照常
  // 跟随、对脱离用户不滚（INVAR-M4-2′ guard 管住「到来的内容不扯人」）。
  // 递减不触发（session 切换读到另一分区的更小值——切回动作自身已有 followToBottom(true)）。
  watch(deps.submitSeq, (cur, prev) => {
    if (cur > prev) deps.followToBottomForce()
  })

  // 流式跟随主触发（数据信号通路）：观察对象 = 全部 streaming 回合的文本总长（逐 turn
  // assistants 归一化求和）。content 是 string | Segment[]：.length 对 string 是字符数、
  // 对 Segment[] 是元素数，语义不一致；用 normalizeContent 统一取纯文本长度，类型安全且对
  // token 级追加仍敏感。观察对象锚 isStreaming 回合后，getter 值变化 ⟹ 存在流式回合文本
  // 增长（非流式内容变化不改变总长），回调无需再查 streaming 标志；bash 双工作态窗口内
  // 退居非末位的 streaming 回合增长同样覆盖。时机走 followFromRo 双 rAF（外层 rAF 晚于
  // Vue 微任务队列，DOM patch 已完成；第二帧 rAF 时 virtua 测量缓存已更新——与 RO 路径
  // P-timing 落点等价），同帧多次触发由外层句柄 cancel 合并。
  watch(
    () => {
      let total = 0
      for (const item of deps.renderItems.value) {
        if (item.kind !== 'turn' || !item.turn.isStreaming) continue
        for (const assistant of item.turn.assistants) {
          total += normalizeContent(assistant.content).length
        }
      }
      return total
    },
    () => {
      followFromRo()
    },
  )

  onScopeDispose(() => {
    // 外层 rAF pending 期间 dispose（session 切换/组件卸载）→ 取消，防泄漏与幽灵 follow
    if (pendingRoRafId !== null) {
      cancelAnimationFrame(pendingRoRafId)
      pendingRoRafId = null
    }
    // debounce 计时器同点清理（窗尾到期即幽灵 follow）
    if (roFollowTimerId !== null) {
      clearTimeout(roFollowTimerId)
      roFollowTimerId = null
    }
    wrapRo?.disconnect()
    scrollRo?.disconnect()
    wrapRo = null
    scrollRo = null
  })

  return { contentWrapEl, tailEl, tailHeight }
}
