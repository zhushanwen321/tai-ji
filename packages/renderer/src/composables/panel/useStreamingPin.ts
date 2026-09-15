/**
 * useStreamingPin —— streaming turn 钉扎（W3，bash↔streaming 共存防护）。
 *
 * 背景（对齐 editing 钉扎 SR5 模式）：w2 放开 bash↔streaming 并发后，共存场景下 bash 消息
 * append 到 messages 末尾成为虚拟列表末项（system item），streaming assistant turn 变成倒数第二项。
 * 用户向上滚动时 streaming turn 可能滚出视口顶部被卸载 → ResizeObserver 断开 → 高度不再更新 →
 * 布局错乱。本 composable 输出 pinnedIndexes（含 streaming turn idx + editing turn idx），
 * 供 virtua <Virtualizer :keepMounted> 消费，恒挂该项的 RO，从根上消除滚出视口致 RO 断开、
 * 高度不更新的隐患。
 *
 * 抽出独立 composable 的原因：MessageStream.vue `<script setup>` 行数规范上限 300，
 * 内联会超限。逻辑自洽（仅依赖 renderItems），适合独立封装。
 *
 * [cw wave w4 + cr-fix] 钉扎统一由 computed pinnedIndexes 输出（喂 virtua :keepMounted）。
 * [PR#116 review M3] 跨 session 重钉由 computed pinnedIndexes 自动承接：pinnedIndexes 依赖
 * streamingTurnIdx（派生自 items / sessionId），session 切换导致 items 重建时 computed 自动重算，
 * 无需 watch 副作用驱动（旧的空 watch 已删）。
 *
 * [pin-identity U1] 编辑钉扎从「数组索引快照」改为「turn 稳定身份反查」（设计
 * docs/design/message-stream-editing-pin-identity.md §3.3 D1）：裸索引快照在 session 切换 /
 * 消息增删后过期（E-now-1 越界崩溃刷屏 / E-now-2 错钉他回合），身份（turnStableId）不过期——
 * 索引只在 pinnedIndexes 求值那一刻从当前 items 反查得出，钉扎始终指向「正在编辑的那一回合」
 * 本身。streamingTurnIdx 维持位置派生不身份化（D5：「末回合在流式」本身即位置语义，computed
 * 同步派生恒 ≤ length-1，探针 P4）。输出前 clamp 过滤越界索引（D4 纵深防御：反查已结构性
 * 消除本 bug，此过滤兜未来新增钉扎来源的同类错误——virtua 对 keepMounted 越界无任何防御，
 * data[idx]=undefined 直传 slot 读 item.kind 即崩）。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { renderKey, type RenderItem } from '@/composables/logic/messageTurns'
import type { SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream'

export interface UseStreamingPinOptions {
  /** 渲染项列表 getter（turn + system 穿插），用于定位最后一个 turn 的数组下标。
   *  [u5] 类型为 MessageStream 的 streamItems 基准（core RenderItem + skillNotice 拼接项）——
   *  pinnedIndexes 是 virtua :keep-mounted 的下标空间，必须与 :data 同一数组基准；
   *  本模块只消费 turn 项（kind==='turn' 窄化）与 items.length，notice 项天然兼容。 */
  items: ComputedRef<ReadonlyArray<RenderItem | SkillNoticeStreamItem>>
  /** 当前 session id getter（捕获跨 session 切换，streaming→streaming 时强制重钉，M3） */
  sessionId: () => string
  /** 编辑中的 turn 身份（turnStableId，null 表示无编辑），用于 virtua 多项钉扎。
   *  不持久持有位置快照：索引由 pinnedIndexes 每次从当前 items 反查（[pin-identity D1]）。 */
  editingTurnKey?: ComputedRef<string | null> | Ref<string | null>
}

/**
 * @param items 渲染项列表（含末尾可能排着的 bash system item）
 * @param sessionId 当前 session id getter
 * @param editingTurnKey 编辑中的 turn 身份 turnStableId（可选，null 表示无编辑，virtua 多项钉扎用）
 *
 * watch 最后一个 turn 的 isStreaming：true 时该 turn idx 进入 pinnedIndexes，false 时移除。
 * （当前钉扎由 computed pinnedIndexes 派生，无 watch 副作用。）
 * lastTurnIdx 是 items 里最后一个 turn 的数组下标（bash system item 排在其后），
 * 钉扎逻辑作用于 startIndex（startIndex 不超过 lastTurnIdx），保证 streaming turn 不滚出视口顶部。
 *
 * [cw wave w4] 返回 pinnedIndexes（virtua 多项钉扎输出）：聚合「streaming turn idx」+
 * 「editing turn 身份反查 idx」去重 + clamp 越界，喂 virtua <Virtualizer :keepMounted>
 * （旧 pinStreaming 入参已于 w4 删除；[pin-identity U1] editing 从裸下标改身份反查）。
 */
export function useStreamingPin(options: UseStreamingPinOptions): {
  /** 需要钉扎在窗口内的项下标数组（streaming turn idx + editing turn 身份反查 idx，去重、
   *  clamp 过滤 < 0 与 >= items.length——virtua 越界即崩，输出必须全部有界）。
   *  virtua 路径消费（<Virtualizer :keepMounted>）。 */
  pinnedIndexes: ComputedRef<number[]>
} {
  const { items } = options

  /** items 里最后一个 turn 的数组下标（跳过末尾 system item，如 bash 消息） */
  const lastTurnIdx = computed(() => {
    const list = items.value
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i]
      if (item && item.kind === 'turn') return i
    }
    return -1
  })

  /** 最后一个 turn（已跳过末尾 system item），用于读 isStreaming（避免对联合类型用可选链不收窄） */
  const lastTurn = computed(() => {
    const idx = lastTurnIdx.value
    if (idx < 0) return null
    const item = items.value[idx]
    return item && item.kind === 'turn' ? item.turn : null
  })

  /** 当前 streaming turn 的数组下标（末 turn isStreaming 时 = lastTurnIdx，否则 -1）。
   *  pinnedIndexes 消费此派生。 */
  const streamingTurnIdx = computed(() =>
    lastTurn.value?.isStreaming && lastTurnIdx.value >= 0 ? lastTurnIdx.value : -1,
  )

  /**
   * virtua 多项钉扎：聚合需恒在窗口内的项下标。
   * - streaming turn idx（streamingTurnIdx，末 turn isStreaming 时有值，否则 -1）
   * - editing turn 身份反查 idx（editingTurnKey 为 turnStableId，非 null 时对当前 items 反查）
   * 去重 + clamp。virtua 路径消费（<Virtualizer :keepMounted>）。
   */
  const pinnedIndexes = computed<number[]>(() => {
    const idxs: number[] = []
    const streamIdx = streamingTurnIdx.value
    if (streamIdx >= 0) idxs.push(streamIdx)

    // 编辑钉扎按身份反查（[pin-identity D1]）：editingTurnKey 与 renderKey 同一身份空间
    // （`t-${turnStableId}`）。显式 null guard：null/undefined 即无编辑，直接不反查——
    // 禁止依赖 `t-${null}` 字符串拼接的巧合路径。反查 miss（-1）= 回合不在场（E2），
    // 语义即「无钉可钉」，不入 pinnedIndexes（fail-safe：宁可不钉不崩溃）。
    const turnKey = options.editingTurnKey?.value ?? null
    if (turnKey != null) {
      const target = `t-${turnKey}`
      // 只反查 turn 项：target 属 `t-` 空间，显式 kind 判定不依赖「s-/t- 前缀空间不碰撞」的隐含知识
      const found = items.value.findIndex(
        (item) => item.kind === 'turn' && renderKey(item) === target,
      )
      if (found >= 0 && !idxs.includes(found)) idxs.push(found)
    }

    // clamp 纵深防御（[pin-identity D4]）：身份反查已结构性消除越界（反查自当前 items，命中
    // 即有界），此过滤兜未来新增钉扎来源违反纪律的同类错误（含 streamingTurnIdx 路径的理论
    // 越界）——virtua 对越界索引无防御，越界/负值一律不出门（E3：极端时序最多少钉一项，防崩不治病）。
    const len = items.value.length
    return idxs.filter((idx) => idx >= 0 && idx < len)
  })

  return { pinnedIndexes }
}
