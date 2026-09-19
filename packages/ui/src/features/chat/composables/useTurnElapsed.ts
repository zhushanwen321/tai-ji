/**
 * useTurnElapsed —— 整个 agent-turn 的耗时 live 计时（从 Turn.vue 拆出，单一变化轴「elapsed 计时」）。
 *
 * 口径（2026-09 用户裁决：状态行是**整个 agent-turn** 的聚合事实，不是单条 assistant 消息的）：
 * - elapsed = 整 turn 墙钟。起点 = turn 起点（user 消息时间戳 / 首条 assistant 时间戳），
 *   终点 = 最后一次产出结束（Message.endedAt ∪ toolCall.endTime ∪ thinking.endTime 的 max，
 *   见 core `deriveTurnAggregates`）。因此**含工具执行 / 思考 / 等待** —— 旧实现只在文本流式
 *   期间计时、定格值取「末条 assistant 开始 − 首条 assistant 开始」，单条 assistant 的 turn
 *   恒显 1s（且漏掉末条消息自身的生成时长），已废。
 * - generatedChars = 整个 turn 的模型生成文本总量（Σ 正文 + Σ thinking），直接读聚合值
 *   （core 派生，两条链路同一公式），不再本地逐秒求和。
 *
 * 计时驱动（转 live 停 freeze 的唯一判据）：
 * - `getIsProducing` = 本 turn 仍在产出（末位 assistant 尚未写入 endedAt 且会话活跃）。
 *   true → 秒级 tick，elapsed 跟随 Date.now()（含长工具执行、等待用户输入）；false → 定格读
 *   endedAt（不再回跳：收口当下就写入 endedAt，定格值 = 最后一帧 live 值）。
 * - 完成收起（onComplete）看 `getIsSessionActive`（对话真正结束才收起：ask-user 期间会话仍
 *   waiting，不应收起未传时退化为跟随 getIsProducing）。
 *
 * 可见性停表（Q1-7）：页面失焦（visibilitychange hidden）停止每秒 tick——elapsed 是绝对
 * 差值计算，停 tick 不丢时间；恢复可见时一次重算即补算失焦期间耗时并重启 tick。
 * listener 仅 producing 期间挂载（完成态实例零 document listener）。
 *
 * 生命周期：producing 态挂载即 start；true→false 停表定格；onUnmounted 兜底清 interval + listener。
 *
 * @param getAggregates 当前 turn 的聚合事实 getter（core deriveTurnAggregates 产物）
 * @param getIsProducing 本 turn 是否仍在产出（驱动秒级 tick 与 isLive）
 * @param getIsSessionActive 对话进行中态 getter（仅驱动 onComplete 收起；不传则跟随 getIsProducing）
 * @param onComplete optional isSessionActive true→false 回调（Turn.vue 用它复位 expanded）
 */
import { computed, ref, watch, onUnmounted, type ComputedRef, type Ref } from 'vue'
import type { TurnAggregates } from '@taiji/core/domain/chat'

/** 时间格式化常量（elapsed 计算） */
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const SEC_PAD_WIDTH = 2

export function useTurnElapsed(
  getAggregates: () => TurnAggregates,
  getIsProducing: () => boolean,
  getIsSessionActive?: () => boolean,
  onComplete?: () => void,
): {
  elapsed: Ref<string>
  elapsedSecs: Ref<number>
  startedAt: ComputedRef<number>
  endedAt: ComputedRef<number>
  isLive: Ref<boolean>
  generatedChars: ComputedRef<number>
} {
  const elapsedSecs = ref(0)
  const elapsed = ref(formatElapsed())
  /** 定格标记：tick 期间为 false，停表后为 true（驱动 isLive 与「进行中」文案） */
  const isLive = ref(getIsProducing())
  let elapsedTimer: ReturnType<typeof setInterval> | null = null

  /** turn 起点（core 聚合：user 消息 / 首条 assistant 时间戳；无成员 = 0） */
  const startedAt = computed(() => getAggregates().startedAt)
  /** turn 终点（core 聚合：最后一次产出结束；进行中 = 已发生活动的结束时刻，供兜底） */
  const endedAt = computed(() => getAggregates().endedAt)
  /** 模型生成文本总量（Σ 正文 + Σ thinking，整 turn 口径） */
  const generatedChars = computed(() => getAggregates().generatedChars)

  /**
   * 计算并格式化整 turn 墙钟。
   * - 无起点（空 turn）→ '0s' 兜底。
   * - producing：now − 起点（live 计时，含工具/等待）。
   * - 定格：endedAt − 起点（endedAt 缺失时回退聚合终点，等价旧行为）。最小 1s（避免 0s 抖动）。
   */
  function formatElapsed(): string {
    const { startedAt: start, endedAt: end } = getAggregates()
    if (start === 0) {
      elapsedSecs.value = 0
      return '0s'
    }
    const endTs = getIsProducing() ? Date.now() : end
    const secs = Math.max(1, Math.round((endTs - start) / MS_PER_SEC))
    elapsedSecs.value = secs
    const m = Math.floor(secs / SEC_PER_MIN)
    const s = secs % SEC_PER_MIN
    return m > 0 ? `${m}m ${String(s).padStart(SEC_PAD_WIDTH, '0')}s` : `${s}s`
  }

  /** visibilitychange listener 挂载标记（幂等挂/摘，防重复注册） */
  let visibilityListenerAttached = false

  function attachVisibilityListener(): void {
    if (visibilityListenerAttached) return
    document.addEventListener('visibilitychange', handleVisibilityChange)
    visibilityListenerAttached = true
  }

  function detachVisibilityListener(): void {
    if (!visibilityListenerAttached) return
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    visibilityListenerAttached = false
  }

  /** 停止每秒 tick（保留 visibility listener：恢复可见时靠它补算重启） */
  function stopTick(): void {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }

  /** 完全停表：清 tick + 摘 visibility listener（完成定格/卸载时调） */
  function stopElapsedTimer(): void {
    stopTick()
    detachVisibilityListener()
  }

  function scheduleTick(): void {
    elapsedTimer = setInterval(() => {
      elapsed.value = formatElapsed()
    }, MS_PER_SEC)
  }

  function startElapsedTimer(): void {
    stopTick()
    elapsed.value = formatElapsed()
    // listener 仅 producing 期间挂载（W05 review）：hidden 分支同样要挂——
    // 失焦进入的 producing 恢复可见时靠它补算重启 tick
    attachVisibilityListener()
    // 页面失焦（document.hidden）时不挂每秒 tick：elapsed 是绝对差值，
    // 停 tick 不丢时间，恢复可见时由 handleVisibilityChange 一次 formatElapsed 补算
    if (document.hidden) return
    scheduleTick()
  }

  /**
   * 可见性停表（Q1-7）：producing 期间页面失焦 → 停止每秒 tick（后台不可见的
   * 重算 + 渲染纯浪费）；恢复可见 → 立即补算 elapsed（Date.now() 差值天然覆盖
   * 失焦期间的流逝时间）并重启每秒 tick。
   * 「仍在 producing 且 timer 为空」= 因失焦被停（完成定格停表时 getIsProducing 已
   * false，不满足重启条件，不会误重启）。
   */
  function handleVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      stopTick()
    } else if (getIsProducing() && elapsedTimer === null) {
      elapsed.value = formatElapsed()
      scheduleTick()
    }
  }

  // 挂载时若已 producing 即开始 live 计时；否则即定格（完成/历史 turn 直接读聚合终点，
  // live≡reload 同一公式重派生）。
  if (getIsProducing()) startElapsedTimer()
  else elapsed.value = formatElapsed()

  // 计时器：producing true→false 停表定格（读权威 endedAt），false→true 开始 live 计时。
  // 真 turn 墙钟口径：工具执行 / 等待用户输入期间 producing 仍为 true，计时连续不断。
  watch(
    () => getIsProducing(),
    (nw, old) => {
      isLive.value = nw
      if (old && !nw) {
        // 产出结束：停表定格（读权威 endedAt，末帧 live 值 = 定格值，不回跳）
        stopElapsedTimer()
        elapsed.value = formatElapsed()
      } else if (!old && nw) {
        startElapsedTimer()
      }
    },
  )

  // 聚合值变化（endedAt 落定 / 起点后移等）且已定格时刷新格式化结果
  watch(
    () => [startedAt.value, endedAt.value] as const,
    () => {
      if (!isLive.value) elapsed.value = formatElapsed()
    },
  )

  // 完成收起：isSessionActive true→false 触发（对话真正结束才收起 trace）。
  // ask-user 时序：producing(isStreaming true, active true) → 工具阻塞(producing false)
  //   但 ask-user pending(active 仍 true) → respond(active false) 才收起。
  // 若未提供 getIsSessionActive（旧调用方），退化为跟随 producing 收起。
  const activeGetter = getIsSessionActive ?? getIsProducing
  if (onComplete) {
    watch(
      () => activeGetter(),
      (nw, old) => {
        if (old && !nw) onComplete()
      },
    )
  }

  onUnmounted(() => {
    // 兜底清理：producing 中卸载也清干净（stopElapsedTimer 内含 tick + listener）
    stopElapsedTimer()
  })

  return { elapsed, elapsedSecs, startedAt, endedAt, isLive, generatedChars }
}
