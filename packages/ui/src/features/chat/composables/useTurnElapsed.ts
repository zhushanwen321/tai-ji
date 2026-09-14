/**
 * useTurnElapsed —— 回合工作耗时 live 计时（从 Turn.vue 拆出，单一变化轴「elapsed 计时」）。
 *
 * 职责（纯计时关注点，原 misplaced 在展示组件 Turn.vue 内）：
 * - elapsed：streaming 态 setInterval 每秒重算 now-firstTs（live 计时）；
 *   完成态静态 lastTs-firstTs（定格）。
 * - generatedChars（u3 remove-turn-progress-bar，设计 §2.1）：已生成字符数 =
 *   Σ normalizeContent(turn.assistants[].content).length（@xyz-agent/shared 同一归一化
 *   函数，跨 assistant 段整段计入）。节拍与 elapsed 共用同一秒级 interval tick，不新增
 *   定时器；性能纪律 = 不随 delta 重算（绝不在内容 watcher 里算，只在秒级 tick 与边界点
 *   算）：挂载算一次（完成/历史 turn 挂载即定格，live≡reload 同一公式重派生）/ streaming
 *   每秒重算 / isStreaming true→false 停表时重算一次定格；失焦停 tick、恢复可见一次补算，
 *   语义对齐 elapsed 既有可见性行为。
 * - 可见性停表（Q1-7）：页面失焦（visibilitychange hidden）停止每秒 tick——elapsed 是
 *   Date.now() 绝对差值，停 tick 不丢时间；恢复可见时一次重算即补算失焦期间耗时并重启 tick。
 * - formatElapsed：Xs / Xm SSs 格式化（含 streaming/completed 边界 + 无 assistant 兜底）。
 * - 生命周期：streaming 态挂载即 start；isStreaming true→false 停表定格；onUnmounted 兜底清 interval + listener 防泄漏。
 * - listener 挂载策略（W05 review）：visibilitychange listener 仅 streaming 期间挂载
 *   （startElapsedTimer 挂、stopElapsedTimer 摘）——每个 Turn 实例（含早已完成的）
 *   完成态零 document listener，避免 N 实例 N listener 挂在 document 上。
 *
 * CW wave `session-active-ssot` T4 拆分两个信号：
 * - 计时器 start/stop 看 **isStreaming**（文本流式生成耗时——ask-user 等待不算生成耗时）。
 * - 完成自动收起（onComplete 回调）看 **isSessionActive**（对话真正结束才收起：
 *   ask-user 期间 message.complete 让 isStreaming false 但 session 仍 waiting，不应收起）。
 *
 * 不含：expanded 折叠态复位（trace 展示关注点，留 Turn.vue，经 onComplete 回调通知它复位）、
 * tool/thinking 计数、fork/编辑（Turn.vue 其他职责）。
 *
 * @param getAssistants 当前 turn 的 assistant 列表 getter（取首/末 timestamp 算耗时）
 * @param getIsStreaming 当前 turn 的「文本流式生成」态 getter（驱动计时器 live/静态切换）
 * @param getIsSessionActive 当前 turn 的「对话进行中」态 getter（驱动完成收起回调）。
 *   仅用于 onComplete 的触发判定（对话真正结束才收起 trace）。若不传则退化为跟随 isStreaming
 *   收起（向后兼容旧调用方）。
 * @param onComplete optional isSessionActive true→false 回调（Turn.vue 用它复位 expanded）
 */
import { ref, watch, onUnmounted, type Ref } from 'vue'
import { normalizeContent, type Message } from '@xyz-agent/shared'

/** 时间格式化常量（elapsed 计算） */
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const SEC_PAD_WIDTH = 2

export function useTurnElapsed(
  getAssistants: () => Message[],
  getIsStreaming: () => boolean,
  getIsSessionActive?: () => boolean,
  onComplete?: () => void,
): { elapsed: Ref<string>; elapsedSecs: Ref<number>; firstTs: Ref<number>; lastTs: Ref<number>; isLive: Ref<boolean>; generatedChars: Ref<number> } {
  const elapsedSecs = ref(0)
  /** 已生成字符数（Σ normalizeContent 口径，节拍见头注释 generatedChars 条目） */
  const generatedChars = ref(0)
  const firstTs = ref(0)
  const lastTs = ref(0)
  const isLive = ref(getIsStreaming())
  const elapsed = ref(formatElapsed())
  let elapsedTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 计算并格式化耗时。
   * - 无 assistant → '0s' 兜底。
   * - streaming：now - 首条 timestamp（live）。
   * - completed：末条 timestamp - 首条 timestamp（定格）。最小 1s（避免 0s 抖动）。
   */
  function formatElapsed(): string {
    const as = getAssistants()
    if (as.length === 0) {
      elapsedSecs.value = 0
      firstTs.value = 0
      lastTs.value = 0
      return '0s'
    }
    firstTs.value = as[0].timestamp
    lastTs.value = as[as.length - 1].timestamp
    const first = as[0].timestamp
    const end = getIsStreaming() ? Date.now() : as[as.length - 1].timestamp
    const secs = Math.max(1, Math.round((end - first) / MS_PER_SEC))
    elapsedSecs.value = secs
    const m = Math.floor(secs / SEC_PER_MIN)
    const s = secs % SEC_PER_MIN
    return m > 0 ? `${m}m ${String(s).padStart(SEC_PAD_WIDTH, '0')}s` : `${s}s`
  }

  /**
   * 重算 generatedChars（u3）：Σ normalizeContent(assistants[].content).length。
   * 调用点纪律（头注释 generatedChars 条目）：仅秒级 tick 与边界点（挂载/起表/停表/
   * 恢复可见），禁止在内容变化点（watcher/delta）调用。
   */
  function recomputeChars(): void {
    let total = 0
    for (const a of getAssistants()) total += normalizeContent(a.content).length
    generatedChars.value = total
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
      // 与 elapsed 同一 interval tick（不新增定时器）：每秒重算字符数
      recomputeChars()
    }, MS_PER_SEC)
  }

  function startElapsedTimer(): void {
    stopTick()
    elapsed.value = formatElapsed()
    recomputeChars()
    // listener 仅 streaming 期间挂载（W05 review）：hidden 分支同样要挂——
    // 失焦进入的 streaming 恢复可见时靠它补算重启 tick
    attachVisibilityListener()
    // 页面失焦（document.hidden）时不挂每秒 tick：elapsed 是 Date.now() 绝对差值，
    // 停 tick 不丢时间，恢复可见时由 handleVisibilityChange 一次 formatElapsed 补算
    if (document.hidden) return
    scheduleTick()
  }

  /**
   * 可见性停表（Q1-7）：streaming 期间页面失焦 → 停止每秒 tick（后台不可见的
   * 重算 + 渲染纯浪费）；恢复可见 → 立即补算 elapsed（Date.now() 差值天然覆盖
   * 失焦期间的流逝时间）并重启每秒 tick。
   * 「仍在 streaming 且 timer 为空」= 因失焦被停（完成定格停表时 isStreaming 已
   * false，不满足重启条件，不会误重启）。
   */
  function handleVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      stopTick()
    } else if (getIsStreaming() && elapsedTimer === null) {
      elapsed.value = formatElapsed()
      recomputeChars() // 恢复补算（对齐 elapsed 的一次重算语义）
      scheduleTick()
    }
  }

  // 挂载时若已 streaming 即开始 live 计时。
  // generatedChars 挂载算一次：streaming turn 的首算在 startElapsedTimer 内（不重复算），
  // 完成/历史 turn 走 else 分支挂载即定格（live≡reload 同一公式重派生）。
  if (getIsStreaming()) startElapsedTimer()
  else recomputeChars()

  // 计时器：isStreaming true→false 停表定格，false→true 开始 live 计时。
  // 仅关注文本生成耗时，不看 ask-user 等待（ask-user 期间 message 已 complete，isStreaming=false）。
  watch(
    () => getIsStreaming(),
    (nw, old) => {
      isLive.value = nw
      if (old && !nw) {
        // 文本流完：停表定格（isStreaming true→false 重算一次，读到权威内容后定格）
        stopElapsedTimer()
        elapsed.value = formatElapsed()
        recomputeChars()
      } else if (!old && nw) {
        startElapsedTimer()
      }
    },
  )

  // 完成收起：isSessionActive true→false 触发（对话真正结束才收起 trace）。
  // ask-user 时序：streaming(isStreaming true, active true) → message.complete(isStreaming false)
  //   但 ask-user pending(active 仍 true) → respond(active false) 才收起。
  // 若未提供 getIsSessionActive（旧调用方），退化为跟随 isStreaming 收起。
  const activeGetter = getIsSessionActive ?? getIsStreaming
  if (onComplete) {
    watch(
      () => activeGetter(),
      (nw, old) => {
        if (old && !nw) onComplete()
      },
    )
  }

  onUnmounted(() => {
    // 兜底清理：streaming 中卸载也清干净（stopElapsedTimer 内含 tick + listener）
    stopElapsedTimer()
  })

  return { elapsed, elapsedSecs, firstTs, lastTs, isLive, generatedChars }
}
