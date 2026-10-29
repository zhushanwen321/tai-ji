// turn-observation —— 回合计时/步数的观察 composable（remote-use-mobile-v2 §6.21 客户端
// 派生的组件侧承接；派生算子本体在 ./turn-timer 纯函数）。
//
// 消费方：ChatScreen（页头状态行，固定会话）与 ActivityScreen（回合面板，跟随
// activeSessionId）——两处同一观察形态（isGenerating 上升沿记起点 + 分区尾部锚点 + 秒级
// tick），单实现防第二套计时逻辑（u-chat 内联形态的抽取，行为契约以 chat-screen 测试组
// 为回归基线）。
//
// 口径（§6.21，与 turn-timer.ts 头注同源）：计时起点 = 本端观察到回合开始的本地时刻；
// 接入时已在生成中（挂载/切会话恰逢 active）→ 记当下（「已观察」显示值 < 真实耗时）；
// 切会话即按新会话当前态重置（新会话的观察起点与其回合无关）。仅生成中返回非空计时
//（isActive 只在订阅后可观察——「仅已订阅显示」构造性成立）。
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Message } from '@taiji/shared'
import { chatStore } from '../shell/app-runtime'
import { countCompletedToolCalls, formatObservedDuration, turnStartIndexAt } from './turn-timer'

/** 秒级刷新 tick 周期 ms（产品功能定时——ADR-0122 保留白名单「产品功能定时」；
 *  SettingsScreen connectedSince 60s 刷新先例，1s 粒度是计时显示的功能语义） */
const TIMER_TICK_MS = 1000

/**
 * 回合观察读口：
 * - isActive：该会话生成中（含在途提交；未订阅会话恒 false）；
 * - observedDuration：「已观察」MM:SS 文案，空串 = 当前无观察中的回合（非生成中）；
 * - completedSteps：本回合工具调用完成计数（无观察中回合恒 0）。
 */
export function useTurnObservation(sessionId: Ref<string | null | undefined>): {
  isActive: ComputedRef<boolean>
  observedDuration: ComputedRef<string>
  completedSteps: ComputedRef<number>
} {
  const isActive = computed(() => {
    const sid = sessionId.value
    return sid !== null && sid !== undefined && chatStore.isActive(sid)
  })
  const messages = computed<Message[]>(() => {
    const sid = sessionId.value
    return sid ? chatStore.getMessages(sid) : []
  })

  /** 本回合「已观察」起点（ms；null = 当前无观察中的回合） */
  const observedStartAt = ref<number | null>(null)
  /** 回合起点消息索引（步数统计锚点，turn-timer.ts 口径） */
  const turnStartIndex = ref(0)
  /** 秒级刷新 tick（驱动 observedDuration 重算） */
  const nowTick = ref(Date.now())
  let ticker: ReturnType<typeof setInterval> | null = null

  // 起点/锚点随「会话 × 生成态」任一变化按当前态重置：上升沿记此刻（§6.21 上升沿观察）、
  // 接入/切入时已在生成中记当下（接入即记）、下降沿或无会话清空。
  watch([sessionId, isActive], () => {
    if (isActive.value) {
      observedStartAt.value = Date.now()
      turnStartIndex.value = turnStartIndexAt(messages.value)
    } else {
      observedStartAt.value = null
    }
  }, { immediate: true })

  onMounted(() => {
    ticker = setInterval(() => {
      nowTick.value = Date.now()
    }, TIMER_TICK_MS)
  })

  onBeforeUnmount(() => {
    if (ticker !== null) clearInterval(ticker)
    ticker = null
  })

  const observedDuration = computed(() =>
    observedStartAt.value === null ? '' : formatObservedDuration(observedStartAt.value, nowTick.value),
  )
  const completedSteps = computed(() =>
    observedStartAt.value === null ? 0 : countCompletedToolCalls(messages.value, turnStartIndex.value),
  )

  return { isActive, observedDuration, completedSteps }
}
