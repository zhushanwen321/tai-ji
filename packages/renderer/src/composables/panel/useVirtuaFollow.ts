/**
 * useVirtuaFollow —— virtua-based message-stream follow 状态机（R2 effects 层）。
 *
 * 设计起源：follow 状态机迁移自早期 useChatScroll（手写 DOM scrollTop 方案），后收敛为单一
 * virtua 路径（cw wave w4 删除手写方案）；本版按 chat-pin-bottom-fix 设计 v7 重构坐标原语与
 * 脱离语义（docs/design/chat-pin-bottom-fix.md §4.3 D1/D2/D7，实施计划 U1）。
 *
 * 核心不变量（INVAR-M4-2′，取代旧 INVAR-M4-2 的「wheel-only + onScroll 只单向翻真」）：
 * **stickToBottom = false（脱离锚定）只由用户输入信号驱动——① onWheel deltaY<0（滚轮上滑，
 * 恒即时生效，不受任何抑制窗约束）；② onScroll 复合判据（offset 递减 ∧ 距底 > BOTTOM_THRESHOLD，
 * 覆盖滚动条拖拽 / 键盘 PageUp·Home 等不产生 wheel 事件的上滑路径）。force 强滚 / session
 * 重建后的收敛抑制窗内暂停判据②的翻 false（lastOffset 快照照常维护、恢复分支照常生效）。
 * 「任何程序性跟随不得把用户扯回底部」的核心保护不变：跟随一律走 followIfStuck 的
 * rAF 内重读 stickToBottom guard；force 是唯一例外（用户显式点「回到底部」）。**
 *
 * 程序性写入回声的逐路径安全性（设计 D7② 推导）：
 * - follow 原语写入：目标恒为底部方向 → offset 递增 → 判据②第一合取不命中；
 * - clamp 回声（scrollHeight 收缩后浏览器把 offset 夹到新真实底部）：distance ≤ 0 → 第二合取不命中；
 * - virtua $fixScrollJump 负向补偿（offset 递减 ∧ distance 不变）：只在估算→实测收敛风暴期
 *   与「同窗未补偿的底部增长把 distance 顶到 >40」同窗密集出现，由收敛抑制窗罩住
 *   （RO 静默 ≥120ms 关窗 / 1500ms 硬上限，见 CONVERGENCE_* 常量）。
 * 历史反例的回归推演（设计 D7「反例重演」①-⑥）由 use-virtua-follow.test.ts 逐序列覆盖。
 *
 * virtua 路径实现要点：
 * - 滚动操作用 virtua VirtualizerHandle.scrollToIndex；
 * - 末项索引 = itemCount() - 1 **直取**（D1）——彻底删除旧的 findItemIndex(scrollSize) 反查。
 *   [R3 事故背景] virtua 的 findItemIndex 入参按绝对滚动坐标解释（内部再减 startMargin），而
 *   handle.scrollSize 不含 startMargin——load-more 显示时（startMargin=44）高度 <44px 的末项
 *   （SystemNotice / SkillNoticeInline 通知行约 24px）被反查到**倒数第二项**，且滚后距底为
 *   负值 ≤ 阈值 → stickToBottom 恒 true → 不浮「回到底部」按钮 → 自我锁死的错钉（设计 §3.2 F3）。
 *   索引直取与 startMargin/scrollSize 坐标语义彻底解耦，末项定位与末项像素高度无关。
 * - scrollToIndex(末项, { align: 'end', offset: endOffset() })（D2）——endOffset = Virtualizer
 *   之后、仍在滚动容器文档流内的尾部块（ActivityStrip / ForkNotice）实测总高，
 *   由 U2 经 tailEl ResizeObserver 注入。virtua offset 语义 = 目标 scrollTop 正偏移
 *   （0.50.0 core $scrollToIndex 公式：`offset + startSpacerSize + itemOffset(last) +
 *   itemSize(last) - viewportSize`）。
 */
import { ref, computed, onScopeDispose } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'

/** 距底小于该阈值（px）视为贴底（迁移自 useChatScroll 的 BOTTOM_THRESHOLD；D7 复合判据沿用） */
const BOTTOM_THRESHOLD = 40

/**
 * D7② 收敛抑制窗：contentWrap RO 静默 ≥120ms 视为测量收敛完成，关窗。
 * 不用「静默 ≥2 帧」：60Hz 下 2 帧 = 33ms，流式 md 渲染是 rAF 逐帧 trailing 节流，帧级增长
 * 间隙会误关窗；120ms ≈ 7 帧静默，远超帧级节流周期与 RO 投递延迟。token 节奏快于 120ms 时
 * 流式期间 RO 持续活跃、窗口由硬上限关闭；慢 token 节奏下经本分支提前关窗（安全性不变，
 * 设计 v7 条件限定）。
 */
const CONVERGENCE_RO_SILENCE_MS = 120
/** D7② 收敛抑制窗硬上限：防长会话测量收敛长尾；RO 持续活跃的流式场景窗口恒取本上限 */
const CONVERGENCE_HARD_CAP_MS = 1500

/**
 * virtua-based follow 状态机。
 *
 * @param opts.vlistRef Virtualizer 组件的 handle ref（由消费方通过 template ref 绑定）
 * @param opts.itemCount D1 末项索引直取的数据条数源。U2 由 MessageStream 注入
 *   `() => streamItems.value.length`。[过渡缺省] 未注入时取 Number.MAX_SAFE_INTEGER，交由
 *   virtua scrollToIndex 内部 clamp 到 [0, itemsLength-1]（virtua 0.50.0 实装 $scrollToIndex
 *   首行 `t = r(t, 0, $getItemsLength() - 1)`，r 为 min/max clamp），语义等价末项直取——
 *   U1→U2 接线窗口的兼容层（MessageStream 消费面本单元不改）。
 * @param opts.endOffset D2 真实底部原语的滚动目标正偏移（尾部块实测总高）。U2 由 tailEl RO
 *   注入。[过渡缺省] 未注入时 = 0（无尾部高度补偿，落点 = 旧版 align-end 语义）。
 * @param opts.onStickChange stickToBottom 翻转时的副作用回调（消费方可据此收起「回到底部」浮层等）
 */
export function useVirtuaFollow(opts: {
  vlistRef: Ref<VirtualizerHandle | null>
  itemCount?: () => number
  endOffset?: () => number
  onStickChange?: (stuck: boolean) => void
}): {
  stickToBottom: Ref<boolean>
  unreadBelow: Ref<boolean>
  showJumpButton: ComputedRef<boolean>
  onScroll: (offset: number) => void
  onWheel: (e: WheelEvent) => void
  followIfStuck: (opts?: { markUnread?: boolean }) => void
  followToBottom: (force?: boolean) => void
  /** D7 session 重建入口：置 NaN 快照 + 开收敛抑制窗（U2 在 sessionId watch 同步调用） */
  onSessionRebuild: () => void
  /** D7② RO 活动信号入口：U2 的 contentWrapEl ResizeObserver 回调喂入（重置 120ms 静默计时） */
  notifyRoActivity: () => void
} {
  const { vlistRef, onStickChange } = opts

  /** 是否贴底（只由用户输入信号驱动翻 false，见文件头 INVAR-M4-2′）。初始贴底。 */
  const stickToBottom = ref(true)
  /** 非贴底时有新内容到达 → 置 true（标记「下方有未读新内容」）；回贴底清零。 */
  const unreadBelow = ref(false)
  /** 用户当前不在底部 且 有未读新内容 → 显示「回到底部」浮层。 */
  const showJumpButton: ComputedRef<boolean> = computed(
    () => !stickToBottom.value && unreadBelow.value,
  )

  /**
   * D7① lastOffset 快照：上一个 scroll 事件的 offset。NaN = 「无快照」哨兵——
   * - 初始即 NaN：composable 创建后的第一个 scroll 事件只建快照不判定；
   * - followToBottom(force=true) 与 onSessionRebuild() 同步置 NaN：下一事件只建快照不判定，
   *   消除「session 重建归零回声与 force 写入送达先后」两种时序的分叉（设计第 3 轮主审 S2）。
   */
  let lastOffset = Number.NaN

  /**
   * follow 原语的滚动目标（D1 + D2）：末项索引直取 + offset = endOffset()。
   * 边界4：itemCount() ≤ 0（空列表）→ 无末项可滚，跳过。
   */
  function scrollToRealBottom(v: VirtualizerHandle): void {
    const count = opts.itemCount?.() ?? Number.MAX_SAFE_INTEGER
    if (count <= 0) return
    v.scrollToIndex(count - 1, { align: 'end', offset: opts.endOffset?.() ?? 0 })
  }

  // ── D7② force 后收敛抑制窗 ────────────────────────────────────────────────
  // 与 D3 触发矩阵的 isPrepend 前插抑制窗（U2 实现，抑制的是 unread 标记）是两个独立窗口，
  // 互不共用状态（设计 D7 命名区分声明）。本窗只抑制 onScroll 复合判据的翻 false。
  /** 抑制窗是否打开（窗内暂停脱离判定；快照维护 / 恢复分支 / wheel 均不受影响） */
  let convergenceWindowActive = false
  /** RO 静默关窗计时器（每次 RO 活动重置；触发即关窗） */
  let roQuietTimer: ReturnType<typeof setTimeout> | null = null
  /** 硬上限关窗计时器（开窗即设定；防 RO 持续活跃下窗口永不关） */
  let roHardCapTimer: ReturnType<typeof setTimeout> | null = null

  function closeConvergenceWindow(): void {
    convergenceWindowActive = false
    if (roQuietTimer !== null) {
      clearTimeout(roQuietTimer)
      roQuietTimer = null
    }
    if (roHardCapTimer !== null) {
      clearTimeout(roHardCapTimer)
      roHardCapTimer = null
    }
  }

  function armRoQuietTimer(): void {
    if (roQuietTimer !== null) clearTimeout(roQuietTimer)
    roQuietTimer = setTimeout(closeConvergenceWindow, CONVERGENCE_RO_SILENCE_MS)
  }

  /** 开窗（幂等：重复调用重置两个计时器）。调用点：followToBottom(force=true) 与 onSessionRebuild()。 */
  function openConvergenceWindow(): void {
    closeConvergenceWindow()
    convergenceWindowActive = true
    armRoQuietTimer()
    roHardCapTimer = setTimeout(closeConvergenceWindow, CONVERGENCE_HARD_CAP_MS)
  }

  /**
   * D7② RO 活动信号入口：U2 的 contentWrapEl ResizeObserver 回调喂入（任何 contentWrap
   * 尺寸变化都算活动，不区分 tailEl/spacer 分量——关窗信号只关心「测量是否还在持续」）。
   * 仅窗内有效（重置 120ms 静默计时）；窗口未开时 no-op。
   */
  function notifyRoActivity(): void {
    if (!convergenceWindowActive) return
    armRoQuietTimer()
  }

  /**
   * wheel 事件回调：滚轮 / 触控板上滑（deltaY < 0）→ 脱离锚定。
   * wheel 是纯用户信号（程序性 scrollToIndex 不触发 wheel），**恒即时生效，不受收敛抑制窗
   * 约束**（D7②；抑制窗副作用⑥的恢复路径之一）。下滑（deltaY > 0）不改变 stickToBottom——
   * 回到底部由 onScroll 恢复分支处理。
   */
  function onWheel(e: WheelEvent): void {
    if (e.deltaY < 0) {
      stickToBottom.value = false
      onStickChange?.(false)
    }
  }

  /**
   * scroll 事件回调（virtua Virtualizer 的 onScroll(offset) 透传）——D7① 复合判据三分支：
   * - `offset < lastOffset ∧ distance > BOTTOM_THRESHOLD` → 翻 **false**（用户上滑：滚动条
   *   拖拽 / 键盘 PageUp·Home / 滚轮的 scroll 回声恒满足 offset 递减）；收敛抑制窗内暂停；
   * - `distance ≤ BOTTOM_THRESHOLD` → 翻 **true**（恢复分支，不受抑制窗影响）；
   * - 其余（含程序性写入回声：offset 递增）→ 不动。
   * lastOffset 快照每个事件照常维护（含抑制窗内）；NaN 哨兵（初始 / force / 重建置位）后的
   * 下一个事件只建快照不判定。
   * 两个早返回 guard：
   */
  function onScroll(offset: number): void {
    const v = vlistRef.value
    // 边界1: vlistRef null（首帧未挂载）→ 早返回
    if (!v) return
    // 边界2: scrollSize=0（空数据）→ distance 计算无意义，早返回（快照也不建——重建后空列表期
    // 的 scroll 回声不消费 NaN 哨兵，首个有效事件才建快照）
    if (v.scrollSize === 0) return

    const distance = v.scrollSize - offset - v.viewportSize
    const hadSnapshot = !Number.isNaN(lastOffset)
    const prevOffset = lastOffset
    lastOffset = offset

    // D7① NaN 重置规则：无快照 → 本事件只建快照不判定
    if (!hadSnapshot) return

    if (distance <= BOTTOM_THRESHOLD) {
      // 恢复分支（不受抑制窗影响，D7②）
      if (!stickToBottom.value) {
        stickToBottom.value = true
        unreadBelow.value = false
        onStickChange?.(true)
      }
      return
    }
    if (offset < prevOffset && !convergenceWindowActive) {
      // 复合判据脱离分支（D7②：抑制窗内暂停翻 false）
      if (stickToBottom.value) {
        stickToBottom.value = false
        onStickChange?.(false)
      }
    }
    // 其余（程序性写入回声等）→ 不动
  }

  /**
   * 待执行的 rAF 句柄（null = 无 pending）。连续 followIfStuck 会先 cancel 旧 rAF 再调度新 rAF，
   * 避免叠加多个 pending 回调；scope dispose 时（session 切换/组件卸载）取消 pending rAF 防泄漏。
   */
  let pendingRafId: number | null = null

  /**
   * 待执行 rAF 的「标 unread」sticky 位：同帧多次 followIfStuck（store 信号 + RO 兜底网
   * 双轨触发）cancel-reschedule 时，标记型调用的语义不被后到的静默型调用取消丢失
   * （D3 双触发收敛无害的前提：cancel 只收敛滚动，不丢 unread 标记）。
   */
  let pendingMarkUnread = false

  /**
   * 跟随到底部（仅在贴底时生效；D3 触发矩阵所有触发的统一原语）。
   *
   * INVAR-M4-2′【关键】：stickToBottom guard 在 rAF 执行时重新读取，而非调用时捕获。
   * 否则：调用时贴底→用户上滑翻 false→rAF 仍按调用时的 true 滚→把上滑用户扯回底部。
   *
   * @param followOpts.markUnread 脱离态下的行为分档（D3 触发矩阵）：
   *   - true（默认，store 级信号 + tailEl 增高）：脱离时不滚但**标 unread**（点亮「回到底部」浮层）；
   *   - false（静默跟随：contentWrap spacer 变化 / scrollEl 视口 resize）：脱离时既不滚也不标。
   */
  function followIfStuck(followOpts?: { markUnread?: boolean }): void {
    const markUnread = followOpts?.markUnread ?? true
    // 调用点即时标记（脱离态）：让「同帧被静默型调用 cancel-reschedule」不丢标记。
    // rAF 时点仍会按重读结果补标记（调用时贴底→rAF 前脱离的既有语义保持）。
    if (markUnread && !stickToBottom.value) {
      unreadBelow.value = true
    }
    if (markUnread) pendingMarkUnread = true

    const run = (): void => {
      pendingRafId = null
      const shouldMarkUnread = pendingMarkUnread
      pendingMarkUnread = false
      // INVAR-M4-2′: rAF 内重读 stickToBottom，避免调用时贴底→用户上滑→仍被扯回
      if (!stickToBottom.value) {
        // U15 即时语义（迁移自 useChatScroll.ts:243）：非贴底时新内容到达 → 标记 unreadBelow，
        // 让 showJumpButton 浮层（= !stickToBottom && unreadBelow）出现，用户可点「回到底部」。
        if (shouldMarkUnread) unreadBelow.value = true
        return
      }
      const v = vlistRef.value
      // 边界3: rAF 触发时 vlistRef 可能已 dispose（session 切换）→ null check
      if (!v) return
      scrollToRealBottom(v)
    }
    if (typeof requestAnimationFrame !== 'undefined') {
      // 连续 followIfStuck：先 cancel 旧 rAF，避免多个 pending 回调叠加
      if (pendingRafId !== null) cancelAnimationFrame(pendingRafId)
      pendingRafId = requestAnimationFrame(run)
    } else {
      // 测试 / SSR 环境兜底（无 rAF）：用 microtask 推进，保持「异步重读」语义。
      // microtask 无法取消，接受其执行（run 内 null check / stickToBottom 重读保证安全）。
      Promise.resolve().then(run)
    }
  }

  // scope dispose（session 切换/组件卸载）兜底取消 pending rAF 与抑制窗计时器，防泄漏。
  // composable 在 setup 同步调用 → scope 必然活跃（测试无 scope 时 onScopeDispose 为 no-op，不抛错）。
  onScopeDispose(() => {
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId)
      pendingRafId = null
    }
    closeConvergenceWindow()
  })

  /**
   * D7 session 重建入口：Virtualizer 因 :key=session 重建时由 U2 在 sessionId watch 同步调用
   * （早于其 nextTick 的 followToBottom(true)）。
   * - lastOffset 置 NaN：重建的 scrollTop 归零回声与后续 force 写入无论谁先送达，首个 scroll
   *   事件都只建快照不判定（消除时序分叉，设计反例重演③）；
   * - 开收敛抑制窗：重建后全量估算→实测收敛风暴罩在窗内（U2 的 nextTick force 会再开一次，幂等）。
   * 不重置 stick/unread——那是 force 写入（followToBottom(true)）的职责，保持单一语义源。
   */
  function onSessionRebuild(): void {
    lastOffset = Number.NaN
    openConvergenceWindow()
  }

  /**
   * 滚动到底部。
   * - force=true（用户「回到底部」浮层点击 / U2 的挂载首滚与 session 切换强滚）：无视
   *   stickToBottom，**同步**强制滚到底并重置贴底态（同步不走 rAF，让用户点击的即时反馈最强）。
   *   同时置 lastOffset=NaN 并开收敛抑制窗（D7②——强滚后的估算收敛风暴期负补偿回声不误脱离）。
   *   状态重置不受 vlistRef null 影响（强滚语义下贴底态为真，即使句柄尚未挂上无法执行滚动）。
   * - force=false（默认）：同 followIfStuck（受 stickToBottom guard，非贴底时不滚）。
   */
  function followToBottom(force = false): void {
    if (!force) {
      followIfStuck()
      return
    }
    stickToBottom.value = true
    unreadBelow.value = false
    lastOffset = Number.NaN
    openConvergenceWindow()
    const v = vlistRef.value
    if (v) scrollToRealBottom(v)
    onStickChange?.(true)
  }

  return {
    stickToBottom,
    unreadBelow,
    showJumpButton,
    onScroll,
    onWheel,
    followIfStuck,
    followToBottom,
    onSessionRebuild,
    notifyRoActivity,
  }
}
