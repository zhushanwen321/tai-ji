/**
 * useStreamingPin —— streaming turn 固定挂载（W3，bash↔streaming 共存防护）。
 *
 * 背景（对齐 editing 固定挂载 SR5 模式）：w2 放开 bash↔streaming 并发后，共存场景下 bash 消息
 * append 到 messages 末尾成为虚拟列表末项（system item），streaming assistant turn 变成倒数第二项。
 * 用户向上滚动时 streaming turn 可能滚出视口顶部被卸载 → ResizeObserver 断开 → 高度不再更新 →
 * 布局错乱。本 composable 输出 pinnedIndexes（含 streaming turn idx + editing turn idx），
 * 供 virtua <Virtualizer :keepMounted> 消费，恒挂该项的 RO，从根上消除滚出视口致 RO 断开、
 * 高度不更新的隐患。
 *
 * 抽出独立 composable 的原因：MessageStream.vue `<script setup>` 行数规范上限 300，
 * 内联会超限。逻辑自洽（仅依赖 renderItems），适合独立封装。
 *
 * [cw wave w4 + cr-fix] 固定挂载统一由 computed pinnedIndexes 输出（喂 virtua :keepMounted）。
 * [PR#116 review M3] 跨 session 重新固定由 computed pinnedIndexes 自动承接：pinnedIndexes 依赖
 * streamingTurnIdxs（派生自 items / sessionId），session 切换导致 items 重建时 computed 自动重算，
 * 无需 watch 副作用驱动（旧的空 watch 已删）。
 *
 * [pin-identity U1] 编辑固定挂载从「数组索引快照」改为「turn 稳定身份反查」（D1）：
 * 裸索引快照在 session 切换 /
 * 消息增删后过期（E-now-1 越界崩溃刷屏 / E-now-2 错固定他回合），身份（turnStableId）不过期——
 * 索引只在 pinnedIndexes 求值那一刻从当前 items 反查得出，固定挂载始终指向「正在编辑的那一回合」
 * 本身。streaming 钉住维持位置派生不身份化（streaming 是回合级数据信号而非身份，computed
 * 同步派生恒有界，探针 P4）；[chat-flow-consistency D2] 后钉住对象从「末位 streaming turn」
 * 扩为「全部 streaming turn」——双工作态过渡期两回合都入钉住集合。输出前 clamp 过滤越界
 * 索引（D4 纵深防御：反查已结构性
 * 消除本 bug，此过滤兜未来新增固定挂载来源的同类错误——virtua 对 keepMounted 越界无任何防御，
 * data[idx]=undefined 直传 slot 读 item.kind 即崩）。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import { renderKey, type RenderItem } from '@/composables/logic/messageTurns'
import type { SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream'

export interface UseStreamingPinOptions {
  /** 渲染项列表 getter（turn + system 穿插），用于定位全部 streaming turn 的数组下标。
   *  [u5] 类型为 MessageStream 的 streamItems 基准（core RenderItem + skillNotice 拼接项）——
   *  pinnedIndexes 是 virtua :keep-mounted 的下标空间，必须与 :data 同一数组基准；
   *  本模块只消费 turn 项（kind==='turn' 窄化）与 items.length，notice 项天然兼容。 */
  items: ComputedRef<ReadonlyArray<RenderItem | SkillNoticeStreamItem>>
  /** 当前 session id getter（捕获跨 session 切换，streaming→streaming 时强制重钉，M3）。
   *  可选：实现经 computed 派生（[PR#116 review M3]）后本成员已无消费方，仅存量调用点
   *  尚在传入；待接口退役清理。 */
  sessionId?: () => string
  /** 编辑中的 turn 身份（turnStableId，null 表示无编辑），用于 virtua 多项固定挂载。
   *  不持久持有位置快照：索引由 pinnedIndexes 每次从当前 items 反查（[pin-identity D1]）。 */
  editingTurnKey?: ComputedRef<string | null> | Ref<string | null>
}

/**
 * @param items 渲染项列表（含末尾可能排着的 bash system item）
 * @param sessionId 当前 session id getter
 * @param editingTurnKey 编辑中的 turn 身份 turnStableId（可选，null 表示无编辑，virtua 多项固定挂载用）
 *
 * watch streaming turn 的 isStreaming：true 时该 turn idx 进入 pinnedIndexes，false 时移除。
 * （当前固定挂载由 computed pinnedIndexes 派生，无 watch 副作用。）
 * streamingTurnIdxs 是 items 里全部 streaming turn 的数组下标（[chat-flow-consistency D2]
 * 双工作态并存期可为多项），保证 streaming turn 不滚出视口顶部。
 *
 * [cw wave w4] 返回 pinnedIndexes（virtua 多项固定挂载输出）：聚合「全部 streaming turn idx」+
 * 「editing turn 身份反查 idx」去重 + clamp 越界，喂 virtua <Virtualizer :keepMounted>
 * （旧 pinStreaming 入参已于 w4 删除；[pin-identity U1] editing 从裸下标改身份反查）。
 */
export function useStreamingPin(options: UseStreamingPinOptions): {
  /** 需要固定挂载在窗口内的项下标数组（streaming turn idx + editing turn 身份反查 idx，去重、
   *  clamp 过滤 < 0 与 >= items.length——virtua 越界即崩，输出必须全部有界）。
   *  virtua 路径消费（<Virtualizer :keepMounted>）。 */
  pinnedIndexes: ComputedRef<number[]>
} {
  const { items } = options

  /**
   * 当前全部 streaming turn 的数组下标（[chat-flow-consistency D2 消费方核对] 双展开期
   * 两回合都入钉住集合）：D2 放宽后 turn.isStreaming 不再以末位回合短路——插话回流开出
   * 新回合时旧回合在定稿收尾前保持 streaming，双工作态并存期两个回合都必须恒挂载（各自
   * 的 RO 断开即高度测量断链，bash↔streaming 共存防护的同一动机）。仍是位置派生不身份化
   * （streaming 本身即位置无关的回合级信号，computed 同步派生恒有界），与 pinnedIndexes
   * 消费方式不变。
   */
  const streamingTurnIdxs = computed<number[]>(() => {
    const idxs: number[] = []
    const list = items.value
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]
      if (item && item.kind === 'turn' && item.turn.isStreaming) idxs.push(i)
    }
    return idxs
  })

  /**
   * virtua 多项固定挂载：聚合需恒在窗口内的项下标。
   * - 全部 streaming turn 下标（streamingTurnIdxs，双工作态并存期可为多项）
   * - editing turn 身份反查 idx（editingTurnKey 为 turnStableId，非 null 时对当前 items 反查）
   * 去重 + clamp。virtua 路径消费（<Virtualizer :keepMounted>）。
   */
  const pinnedIndexes = computed<number[]>(() => {
    const idxs: number[] = []
    for (const streamIdx of streamingTurnIdxs.value) {
      if (!idxs.includes(streamIdx)) idxs.push(streamIdx)
    }

    // 编辑固定挂载按身份反查（[pin-identity D1]）：editingTurnKey 与 renderKey 同一身份空间
    // （`t-${turnStableId}`）。显式 null guard：null/undefined 即无编辑，直接不反查——
    // 禁止依赖 `t-${null}` 字符串拼接的巧合路径。反查 miss（-1）= 回合不在场（E2），
    // 语义即「无可固定的项」，不入 pinnedIndexes（fail-safe：宁可少固定不崩溃）。
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
    // 即有界），此过滤兜未来新增固定挂载来源违反纪律的同类错误（含 streamingTurnIdxs 路径的
    // 理论越界）——virtua 对越界索引无防御，越界/负值一律不出门（E3：极端时序最多少钉一项，防崩不治病）。
    const len = items.value.length
    return idxs.filter((idx) => idx >= 0 && idx < len)
  })

  return { pinnedIndexes }
}
