/**
 * usePinBottomGuard —— dev-only 贴底跟随收敛断言（chat-pin-bottom-fix §4.4 护栏⑦，U4）。
 *
 * 防什么：R1 类「最后一段增长未补偿」的任何未来变体（新异步渲染形态 / 新尾部块 / virtua
 * 升级行为漂移）——单测只能覆盖「今天想到的回归」，本断言是结果导向的兜底层：dev 环境下
 * 贴底态跟随未真正收敛时即时 console.warn，不再依赖用户报障（设计 G3）。
 *
 * spec（docs/design/chat-pin-bottom-fix.md §4.4⑦ 逐条）：
 * - 前置收敛窗口：仅在最近一次 follow 原语执行后的 500ms 内检查；新 follow 重启窗口，
 *   用户脱离（stickToBottom 翻 false）取消窗口；
 * - 双采样：窗口末尾采一次 gap，超阈值则隔 200ms 复采一次，两次均超才 warn——区分
 *   「估算收敛期的合法瞬态 gap」与「未收敛」（设计 r2 S4 落实）；
 * - 阈值 max(2, 2×devicePixelRatio) px 取整（retina 非整数缩放取整误差容差）；
 * - 只对 stickToBottom=true 且 gap 超阈值发声——断言「我们自己的 follow 是否收敛」，
 *   不对用户阅读静止态发声（滚动条拖拽场景结构性不误报）；
 * - isStreaming 判读指引：流式中（isStreaming=true）双超阈值按真实跟随失效上报——收敛期
 *   恒在 force 后窗口内，窗口外的流式持续 gap 无合法瞬态解释（设计 v5）；
 * - follow 频率计数器（§4.5 P-no-loop，校准 r1 补齐）：滑动 1s 窗口内 follow 原语执行
 *   >60 次 → warn（RO → follow → scrollToIndex → 内容高度变化 → RO 观察循环的唯一机器
 *   检测层）；沿触发——持续超限只报一次，回落后再超限再报；
 * - import.meta.env.DEV 门控：生产构建原样透传 follow API，零运行时开销（同构先例
 *   useConstantHeightAssert）。
 *
 * 消费方式（MessageStream 接线，实施计划偏差 #7 预扩授权）：useVirtuaFollow 返回值整体
 * 传入 follow 字段，本 composable 返回同构 API——followIfStuck / followToBottom 被 dev
 * 包装，每次原语调用后开启/重启收敛检查窗（窗口以调用时点起算，覆盖其内部 rAF 一帧执行
 * 延迟 + 后续测量收敛期）。gap = scrollHeight - scrollTop - clientHeight（设计 §5.1 判据）。
 *
 * 真实 dpr / 真实布局的端到端行为无法单测（happy-dom 无真实布局引擎），由 V8 故障注入在
 * dev app 侧验证（实施计划 U4 验收④）；fake timers 可控的双采样时序与判读文案由
 * use-pin-bottom-guard.test.ts 覆盖。
 */
import { onScopeDispose, watch } from 'vue'
import type { Ref } from 'vue'
import type { useVirtuaFollow } from './useVirtuaFollow'

/** 前置收敛窗口：最近一次 follow 原语执行后等待测量的时长（§4.4⑦「500ms 收敛窗口」） */
const CONVERGE_WINDOW_MS = 500
/** 双采样间隔：窗口末首次采样超阈值后，隔此时长复采一次（两次均超才 warn） */
const RESAMPLE_DELAY_MS = 200
/** P-no-loop 频率窗口：滑动窗口时长（§4.5「1s 内 follow 次数 > 60 即 warn」） */
const FOLLOW_RATE_WINDOW_MS = 1000
/** P-no-loop 频率上限：rAF 帧率上限 60fps 下每帧至多一次 follow，恒超 60/s 即循环 */
const FOLLOW_RATE_LIMIT = 60

/** useVirtuaFollow 返回的 follow 原语 API（本守卫返回同构 API，调用面零改动） */
export type FollowApi = ReturnType<typeof useVirtuaFollow>

export interface PinBottomGuardDeps {
  /** follow 原语 API（useVirtuaFollow 返回值整体透入；stickToBottom 从此读取） */
  follow: FollowApi
  /** 滚动容器（MessageStream scrollEl）：gap 实测源 */
  scrollEl: Ref<HTMLElement | null>
  /** 流式判读（MessageStream：末 turn isStreaming）：warn 文案的判读指引分支 */
  isStreaming?: () => boolean
}

function readDpr(): number {
  return (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1
}

/** gap 实测（§5.1 判据定义）；scrollEl 未挂载返回 null（跳过本轮采样） */
function measureGap(el: HTMLElement | null): number | null {
  if (!el) return null
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

/** 阈值下限（dpr=1 基准 2px，设计 §5.1 判据 gap ≤ 2px） */
const GAP_THRESHOLD_BASE_PX = 2
/** dpr 缩放系数：retina 按 2×dpr 容差（§4.4⑦「阈值 max(2, 2×dpr) px 取整」） */
const DPR_SCALE = 2

/** 阈值 max(2, 2×dpr) px 取整（retina 非整数缩放取整误差容差） */
function thresholdPx(): number {
  return Math.round(Math.max(GAP_THRESHOLD_BASE_PX, DPR_SCALE * readDpr()))
}

export function usePinBottomGuard(deps: PinBottomGuardDeps): FollowApi {
  const { follow, scrollEl, isStreaming } = deps
  // 生产构建：原样透传（护栏只在 dev 存在，§4.4⑦「import.meta.env.DEV 门控」）
  if (!import.meta.env.DEV) return follow

  let windowTimer: ReturnType<typeof setTimeout> | null = null
  let resampleTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimers(): void {
    if (windowTimer !== null) {
      clearTimeout(windowTimer)
      windowTimer = null
    }
    if (resampleTimer !== null) {
      clearTimeout(resampleTimer)
      resampleTimer = null
    }
  }

  /** 窗口末采样（双采样第一次）：贴底态且 gap 超阈值 → 安排 200ms 后复采 */
  function sampleAtWindowEnd(): void {
    windowTimer = null
    if (!follow.stickToBottom.value) return // 用户已脱离：不对阅读静止态发声
    const gap = measureGap(scrollEl.value)
    if (gap === null || gap <= thresholdPx()) return
    resampleTimer = setTimeout(resample, RESAMPLE_DELAY_MS)
  }

  /** 复采（双采样第二次）：仍超阈值才判「未收敛」并 warn（首采超、复采收敛 = 合法瞬态，静默） */
  function resample(): void {
    resampleTimer = null
    if (!follow.stickToBottom.value) return
    const gap = measureGap(scrollEl.value)
    const threshold = thresholdPx()
    if (gap === null || gap <= threshold) return
    report(gap, threshold)
  }

  function report(gap: number, threshold: number): void {
    const guidance = isStreaming?.()
      ? 'isStreaming=true：收敛窗外的流式持续 gap 无合法瞬态解释——按真实跟随失效排查。'
      : '非流式态持续 gap——排查最近改动的跟随链路（估算收敛类瞬态已被双采样过滤）。'
    console.warn(
      `[pin-bottom-guard] 贴底态跟随未收敛：gap=${gap}px > 阈值 ${threshold}px（dpr=${readDpr()}，双采样均超）。` +
        `${guidance} 👉 复现与判读指引见 docs/design/chat-pin-bottom-fix.md §4.4；` +
        '最近改动的跟随链路：useVirtuaFollow.ts / useMessageStreamFollowTriggers.ts / MessageStream.vue。',
    )
  }

  /** follow 原语执行入口（followIfStuck / followToBottom 包装共用）：开/重启收敛检查窗 */
  function armWindow(): void {
    clearTimers() // 新 follow 取消旧窗口（重启）
    windowTimer = setTimeout(sampleAtWindowEnd, CONVERGE_WINDOW_MS)
  }

  /**
   * P-no-loop 观察循环检测（§4.5 判据载体）：滑动 1s 窗口计数 follow 原语执行次数，
   * 超 60 次/s（rAF 帧率上限，恒超即「RO → follow → 内容高度变化 → RO」自激）→ warn。
   * 沿触发：超限态只报一次，窗口滑出回落后再超限再报——持续循环不会被 60 次/s 刷屏淹没。
   */
  const followTimestamps: number[] = []
  let loopActive = false
  function countFollowExecution(): void {
    const now = Date.now()
    followTimestamps.push(now)
    while (followTimestamps.length > 0) {
      const oldest = followTimestamps[0]
      if (oldest === undefined || now - oldest <= FOLLOW_RATE_WINDOW_MS) break
      followTimestamps.shift()
    }
    const looping = followTimestamps.length > FOLLOW_RATE_LIMIT
    if (looping && !loopActive) {
      loopActive = true
      console.warn(
        `[pin-bottom-guard] follow 频率异常：${FOLLOW_RATE_WINDOW_MS}ms 内 follow 次数=${followTimestamps.length}` +
          ` > ${FOLLOW_RATE_LIMIT}——疑似 RO 兜底网观察循环（RO → follow → scrollToIndex → 内容高度变化 → RO）。` +
          '👉 处置见 docs/design/chat-pin-bottom-fix.md §4.5 P-no-loop 降级路径（100ms 防抖 / 收窄观察目标）。',
      )
    } else if (!looping) {
      loopActive = false
    }
  }

  // 用户脱离取消窗口（§4.4⑦）：wheel / 滚动条拖拽 / 键盘上滑均经 stickToBottom 翻 false 汇聚
  watch(follow.stickToBottom, (stuck) => {
    if (!stuck) clearTimers()
  })
  onScopeDispose(clearTimers)

  return {
    ...follow,
    followIfStuck: (followOpts) => {
      follow.followIfStuck(followOpts)
      countFollowExecution()
      armWindow()
    },
    followToBottom: (force) => {
      follow.followToBottom(force)
      countFollowExecution()
      armWindow()
    },
  }
}
