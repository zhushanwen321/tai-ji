/**
 * useMessageStreamRail —— TurnRail（w4 wave IF4）的 per-session 状态 + 事件路由。
 *
 * 职责：
 * - railTurns：派生 renderItems 中所有 turn（rail 节点列表数据源）。
 * - activeTurnIndex：按 virta scrollOffset 精确定位当前激活 turn 下标（viewport indicator 跟随滚动）。
 * - 事件路由：onJump（滚动定位）/ onToggle / onExpandAll / onCollapseAll，全部经 useTurnExpansion
 *   与 Turn.vue 共享同一 session 展开态（同一 session Map key）。
 *
 * 索引空间注意：rail 内部用 railTurns 数组下标（0-based），Turn.vue 用 props.turn（稳定 key
 * 经 turnStableId 派生，M5 stable-key）。toggle/expandAll/collapseAll 把下标转 turn 稳定 key
 * 再传 useTurnExpansion，保证 Map key 一致（string key 不随消息插删漂移）。
 *
 * 提取至此（composables/panel 既有范式）：MessageStream.vue script setup ≤300 行规范 + rail 关注点单一可复用。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { VirtualizerHandle } from 'virtua/vue'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import type { SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream'
import { turnStableId } from '@taiji/core/domain/chat'
import { railMemoFor } from '@taiji/ui'
import { useTurnExpansion } from '@/composables/panel/useTurnExpansion'
import { useTurnExpansionStore } from '@/stores/turn-expansion'

/**
 * 空集合单例（expandedTurns 的 null-sid / 无展开分支复用）。
 * 复用同一引用避免每次响应式触发 new Set()，减少下游（TurnRail 经 props 接收）
 * 因 Set 引用变更触发的无谓重渲染（W3 性能优化）。
 * frozen 保证不被外部 mutate 污染——expandedTurns 的契约是只读 Set。
 */
const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>()) as ReadonlySet<string>

/** 逐项引用恒等：长度相等且每项引用相同（引用同 ⇒ 内容同，ADR-0039 不可变更新保证）。 */
function sameTurnRefSequence(a: readonly MessageTurn[], b: readonly MessageTurn[]): boolean {
  return a.length === b.length && a.every((turn, i) => turn === b[i])
}

/** rail 可见投影签名逐字段比对（railMemoFor 四字段 = TurnRail 渲染消费的全部 turn 派生字段）。 */
function railMemoEquals(
  a: ReturnType<typeof railMemoFor>,
  b: ReturnType<typeof railMemoFor>,
): boolean {
  return (
    a.userSummary === b.userSummary &&
    a.agentSummary === b.agentSummary &&
    a.failed === b.failed &&
    a.iconClass === b.iconClass
  )
}

/** useMessageStreamRail 依赖（由 MessageStream.vue 注入，避免重复读取 store/props）。 */
export interface UseMessageStreamRailDeps {
  sessionId: ComputedRef<string>
  /** 完整渲染项列表（turn + system 穿插），railTurns 派生自此。
   *  [u5] 类型为 MessageStream 的 streamItems 基准（core RenderItem + skillNotice 拼接项）——
   *  rail 的 jump/active 下标空间必须与 Virtualizer :data 一致；本模块只消费 turn 项
   *  （kind==='turn' 窄化），notice 项自然跳过。 */
  renderItems: ComputedRef<ReadonlyArray<SkillNoticeStreamItem>>
  /** [cw wave w4] virtua VirtualizerHandle ref（单一 virtua 路径：rail jump/active 都走 virta API）。
   *  vlistRef 必填：onJump 调 scrollToIndex，updateActiveTurnIndex 调 findItemIndex。 */
  vlistRef: Ref<VirtualizerHandle | null>
}

export function useMessageStreamRail(deps: UseMessageStreamRailDeps): {
  railTurns: ComputedRef<MessageTurn[]>
  activeTurnIndex: Ref<number>
  /** 当前 session 已展开的 turn 稳定 key 集合（TurnRail toggle 图标方向依据）。
   *  ReadonlySet：消费方只读（TurnRail 用 .has 查询），空态复用 EMPTY_SET 单例（W3）。 */
  expandedTurns: ComputedRef<ReadonlySet<string>>
  updateActiveTurnIndex: () => void
  onJump: (idx: number) => void
  onToggle: (idx: number) => void
} {
  const { sessionId, renderItems } = deps

  /** rail 状态接入 useTurnExpansion（与 Turn.vue 共享同一 session Map）。 */
  const { toggle } = useTurnExpansion(sessionId)

  /**
   * rail 节点数据源：renderItems 中所有 turn（rail 列表渲染 + jump/toggle 索引空间）。
   *
   * 引用恒等（streaming perf）：renderItems 每条流式 delta 替换数组引用（ADR-0039 不可变
   * 替换），filter/map 每次重算产出新数组——即使 turn 成员引用一个都没变，下游 TurnRail 的
   * turns prop / expandedTurns 的依赖也会因引用变更连带重算/重渲。末尾逐项 === 比对：
   * 长度相等且每项引用相同 → 返回上次数组引用（下游 props 不变 → Vue 跳过 patch）；
   * 任一 turn 引用变化（消息增删 / 消息内容替换）→ 照常产出新数组，行为不变。
   * lastRailTurns 用 per-instance 闭包持有（split mode 多实例各自 railTurns，禁模块级共享）。
   *
   * 投影恒等放宽（streaming perf 二段）：仅末位 turn 引用不同（streaming 末位 turn 每
   * delta 重建）、其余逐项引用相同，且末位 turn 的 rail 可见投影签名（railMemoFor 四字段
   * userSummary/agentSummary/failed/iconClass——TurnRail 渲染消费的全部 turn 派生字段）
   * 与上次相同 → 返回旧数组引用。此时 TurnRail render 输出逐字节不变（摘要串相同 ⇒ 渲染
   * 相同），props 引用不变 → 常驻面板零 vnode diff、expandedTurns 依赖不失效。签名经
   * 共享 railMemoFor（@taiji/ui，与 TurnRail 渲染同一 WeakMap）：每帧对末位 turn 至多算
   * 一次摘要，且该 memo 被后续真重渲帧直接命中（判定与渲染同源，摘要成本不因判定翻倍）。
   * 摘要真变（用户可见变更）→ 走下方重建路径，TurnRail 照常更新，行为不变。
   */
  let lastRailTurns: MessageTurn[] = []
  /**
   * turn → railTurns 下标索引：updateActiveTurnIndex 每滚动帧查询，替代 findIndex 线性扫描
   * （O(n) → O(1)）。仅在 railTurns 数组引用变化时随求值同步重建（内容未变则下标不变，
   * 无需重建）；被替换的 turn 旧键失去引用后由 GC 回收。查询前先读 railTurns.value 保证
   * 索引与本次数组同步（见 updateActiveTurnIndex）。
   */
  let railIndexByTurn = new WeakMap<MessageTurn, number>()

  /**
   * 投影恒等放宽判定：仅末位 turn 引用不同（streaming 末位 turn 每 delta 重建）、其余
   * 逐项引用相同，且末位 turn 的 rail 可见投影签名（railMemoFor 四字段——TurnRail 渲染
   * 消费的全部 turn 派生字段）与上次相同 → 补末位下标映射并返回 true（复用旧数组）。
   * 此时 TurnRail render 输出逐字节不变（摘要串相同 ⇒ 渲染相同），props 引用不变 →
   * 常驻面板零 vnode diff、expandedTurns 依赖不失效。签名经共享 railMemoFor（@taiji/ui，
   * 与 TurnRail 渲染同一 WeakMap）：每帧对末位 turn 至多算一次摘要，且该 memo 被后续
   * 真重渲帧直接命中（判定与渲染同源，摘要成本不因判定翻倍）。摘要真变（用户可见变更）
   * → 返回 false 走重建路径，TurnRail 照常更新，行为不变。
   */
  function lastTurnProjectionUnchanged(next: MessageTurn[]): boolean {
    const lastIdx = next.length - 1
    if (lastIdx < 0) return false
    const prevLast = lastRailTurns[lastIdx]
    const nextLast = next[lastIdx]
    if (
      prevLast === undefined ||
      nextLast === undefined ||
      lastRailTurns.length !== next.length ||
      !sameTurnRefSequence(lastRailTurns.slice(0, lastIdx), next.slice(0, lastIdx))
    ) {
      return false
    }
    if (!railMemoEquals(railMemoFor(prevLast), railMemoFor(nextLast))) return false
    // rail 投影恒等 → 复用旧数组。补末位下标映射保持索引与当前 renderItems 同步
    // （同位同投影）：updateActiveTurnIndex 对末位新引用仍 O(1) 命中，不退化 findIndex。
    railIndexByTurn.set(nextLast, lastIdx)
    return true
  }

  /** 全量重建：采纳 next 数组 + 同步重建下标索引（lastRailTurns per-instance 闭包持有，
   *  split mode 多实例各自 railTurns，禁模块级共享）。 */
  function rebuildRailTurns(next: MessageTurn[]): MessageTurn[] {
    const index = new WeakMap<MessageTurn, number>()
    // first-wins 对齐 findIndex 语义（同 turn 引用重复出现理论不可达，防御性保持等价）
    next.forEach((turn, i) => {
      if (!index.has(turn)) index.set(turn, i)
    })
    lastRailTurns = next
    railIndexByTurn = index
    return next
  }

  const railTurns = computed<MessageTurn[]>(() => {
    const next = renderItems.value.filter((item) => item.kind === 'turn').map((item) => item.turn)
    // 快判 → 投影恒等放宽 → 全量重建，三级判定语义见上方 railTurns 机制注释
    if (sameTurnRefSequence(lastRailTurns, next)) return lastRailTurns
    if (lastTurnProjectionUnchanged(next)) return lastRailTurns
    return rebuildRailTurns(next)
  })

  /**
   * renderItems 空间下标 → rail 下标（截至该下标共有几个 turn 项，0-based）。
   * railTurns 恒为 renderItems 的 turn 子序列（同帧派生、同序同长），该序号即 turn 在
   * railTurns 中的下标——索引 get miss 且按引用 findIndex 也 miss 时的结构正确兜底：
   * 投影恒等放宽期间 railTurns 末位持旧引用，新引用不在旧数组，按序号定位仍指向
   * 当前最新同位 turn（旧实现此路径返回 -1，indicator 会错位）。
   */
  function railOrdinalAt(renderIdx: number): number {
    const items = renderItems.value
    let ordinal = -1
    const upper = Math.min(renderIdx, items.length - 1)
    for (let i = 0; i <= upper; i += 1) {
      if (items[i]?.kind === 'turn') ordinal += 1
    }
    return ordinal
  }

  /**
   * rail 下标 → renderItems 下标（第 idx 个 turn 项的位置，onJump 兜底方向）。
   * 与 railOrdinalAt 同一结构事实（railTurns = renderItems 的 turn 子序列）的反向运用：
   * 按引用 findIndex miss（放宽期间末位旧引用已被 renderItems 替换）时，第 idx 个 turn
   * 项即 railTurns[idx] 的当前同位 turn，跳转定位语义不变。
   */
  function nthTurnRenderIndex(idx: number): number {
    const items = renderItems.value
    let seen = -1
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]?.kind === 'turn') {
        seen += 1
        if (seen === idx) return i
      }
    }
    return -1
  }

  /**
   * 派生当前 session 已展开的 turn 稳定 key 集合（TurnRail toggle 图标方向依据）。
   *
   * [M5 stable-key] key 从 MessageTurn.index 改为 turnStableId(turn)（首条消息 id）：
   * 消息插删（load-more/streaming）时 index 漂移，展开态会错绑到别的 turn；
   * string 稳定 key 随 turn 首条消息 id 不变（消息 id 创建时生成，全局唯一）。
   *
   * 响应式追踪关键：用 store.isExpanded(sid, key) 逐个查 railTurns 的稳定 key，
   * 不直接遍历 store.partitions.entries()。原因：
   * - 外层 partitions 是 plain Map（非响应式），遍历/读它都不建立依赖；
   *   真正的依赖通过内层 reactive Map.get(key) 建立（store.isExpanded 内部走 getPartition
   *   惰性创建分区 + 读 reactive Map.get(key)），故必须逐个查 isExpanded 才能让
   *   toggle/expand/collapse mutate 时正确失效。
   * - 直接读 entries() 还会把 partition 误当响应式源，但 partition 引用本身不变（只 mutate 内容），
   *   不会触发 computed 重算——必须通过 get(key) 建立 per-key 依赖。
   *
   * 与 Turn.vue 读 isExpanded 的追踪链路一致（同一 store 同一分区同一 key 依赖）。
   */
  const store = useTurnExpansionStore()
  const expandedTurns = computed<ReadonlySet<string>>(() => {
    const sid = sessionId.value
    if (!sid) return EMPTY_SET
    const expanded = new Set<string>()
    for (const turn of railTurns.value) {
      const key = turnStableId(turn)
      if (store.isExpanded(sid, key)) {
        expanded.add(key)
      }
    }
    return expanded.size === 0 ? EMPTY_SET : expanded
  })

  /** 当前激活 turn 在 railTurns 中的下标（viewport indicator 位置 + active 节点高亮）。 */
  const activeTurnIndex = ref(0)

  /**
   * 按 virtua scrollOffset 精确定位当前激活 turn 下标（viewport indicator 跟随滚动）。
   * [cw wave w4] 单一 virtua 路径：vlistRef.findItemIndex(scrollOffset) 反查当前可见首项。
   * 下标映射走 railIndexByTurn O(1) 索引（railTurns 求值时同步重建），不再每帧 findIndex 线性扫描。
   */
  function updateActiveTurnIndex(): void {
    const v = deps.vlistRef.value
    if (!v) return
    const renderIdx = v.findItemIndex(v.scrollOffset)
    // findItemIndex 返回 renderItems 空间下标（含 system 条目），
    // 需映射回 railTurns 空间（仅 turn），与 onJump 的映射对称。
    // 若 renderItems[renderIdx] 是 system 项，保持上次 activeTurnIndex 不变。
    const item = renderItems.value[renderIdx]
    if (item?.kind === 'turn') {
      // railTurns.value 读在前：正常时序（onVirtuaScroll）下 virtua 已渲染 ⇒ 模板已读过
      // railTurns ⇒ 索引必已建；此读兜底任何未求值路径——惰性求值顺带同步重建索引
      // （投影恒等放宽帧也会在此补末位映射）。
      const turns = railTurns.value
      // miss 兜底两级：索引命中 O(1)；miss 先按引用 findIndex（行为与旧实现一致），
      // 再 miss（-1，放宽期间末位新引用不在旧数组）落 railOrdinalAt 结构定位，
      // 不再返回 -1 错位（旧实现该路径不可达，新形态下由结构序号保证正确）。
      const mapped = railIndexByTurn.get(item.turn)
      if (mapped !== undefined) {
        activeTurnIndex.value = mapped
        return
      }
      const found = turns.findIndex((t) => t === item.turn)
      activeTurnIndex.value = found >= 0 ? found : railOrdinalAt(renderIdx)
    }
  }

  /**
   * rail jump：滚动到对应 turn 的 renderItems 下标。
   * idx 是 railTurns 数组下标，需映射回 renderItems 下标（系统提示行穿插使两者不一致）。
   * railTurns[idx] 已持有目标 turn 对象，直接用引用相等 findIndex（无需 O(n) 累计 turnCount）。
   *
   * [cw wave w4] 单一 virtua 路径：vlistRef.scrollToIndex(renderIdx, {align:'start'})。
   */
  function onJump(idx: number): void {
    const targetTurn = railTurns.value[idx]
    if (!targetTurn) return
    let renderIdx = renderItems.value.findIndex(
      (item) => item.kind === 'turn' && item.turn === targetTurn,
    )
    if (renderIdx < 0) {
      // 投影恒等放宽期间 railTurns 末位持旧引用（rail 显示未变不更新数组），按引用
      // 查找 miss——按「第 idx 个 turn 项」结构定位兜底，跳转语义不变（跳到当前
      // 最新同位 turn）。旧行为此处直接 return（不滚动），该 miss 在旧形态不可达。
      renderIdx = nthTurnRenderIndex(idx)
    }
    if (renderIdx < 0) return
    const v = deps.vlistRef.value
    if (!v) return
    v.scrollToIndex(renderIdx, { align: 'start' })
  }

  /** rail toggle：切该 turn 的展开态。
   *  idx 是 railTurns 下标 → 转成 turn 稳定 key（turnStableId，M5 stable-key；
   *  与 Turn.vue/TurnMeta 用的 key 派生一致，同 store 同分区）。 */
  function onToggle(idx: number): void {
    const turn = railTurns.value[idx]
    if (turn) toggle(turnStableId(turn))
  }

  /**
   * rail 横向定位已随三卡化（2026-10-04）简化为 TurnRail 组件内 absolute right-2——
   * 原 panelRightEdge（ResizeObserver 跟踪 panel 根 section 右缘 + 视口坐标换算）整链删除，
   * 跨区缺陷（fixed 垂直居中不感知底抽屉高度）随定位方式切换构造性消除。
   */

  return {
    railTurns,
    activeTurnIndex,
    expandedTurns,
    updateActiveTurnIndex,
    onJump,
    onToggle,
  }
}
