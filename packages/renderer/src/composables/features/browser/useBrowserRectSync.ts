/**
 * useBrowserRectSync —— BrowserPane viewport rect 同步（Wave 3）。
 *
 * 职责：监听 viewport 元素尺寸/位置变化 → 节流推 browserSetRect 到主进程。
 * 抽出 composable 让 BrowserPane 聚焦布局，rect 同步逻辑独立可测。
 *
 * 触发源：
 * - ResizeObserver：viewport 尺寸变化（drawer 开合 / 模式切换 / 元素 reflow）
 * - window resize：拖窗口（元素尺寸可能不变但位置变，RO 不一定捕获）
 * - 'taiji:splitter-layout' CustomEvent：Splitter 拖动（RO 在 reka-ui 高频拖动下触发不可靠，补充路径）
 *
 * 节流策略：rAF 合并同帧 + 33ms 时间下限（~30fps）。
 * - 拖窗口 resize 每秒可触发 60+ 次，不加节流会让同步 IPC 阻塞主进程单线程
 * - 节流窗口内最后一次变化用 setTimeout 兜底，避免丢失
 *
 * [HISTORICAL] rect 坐标系：getBoundingClientRect 返回 CSS px，与主进程 setBounds 的 DIP 1:1，
 * **绝对不乘 devicePixelRatio**。乘 dpr 在 retina 屏会导致 view 定位屏外 + 尺寸翻倍。
 *
 * @param viewportEl viewport 元素的 ref（BrowserPane 的 viewportEl）
 * @param getSessionId 当前 sessionId 读取器（pushRect 时取，避免闭包陈旧）
 * @returns { pushRect, scheduleRectPush } 显式推送（nextTick 用）+ 节流调度（监听器用）
 */
import { watch, type Ref } from 'vue'
import { browserSetRect } from '@/lib/ipc'

/** rect 推送节流间隔（ms）。~30fps 足够视觉连续，避免 60fps 同步 IPC 阻塞主进程单线程 */
const RECT_PUSH_THROTTLE_MS = 33

export interface RectSyncHandle {
  /** 立即推送一次 rect（用于 nextTick 内初次推送，确保 setBounds 早于 navigate+show） */
  pushRect: () => void
  /** 节流推送（监听器用）：rAF 合并 + 33ms 时间下限 */
  scheduleRectPush: () => void
  /** 全部清理（disconnect RO + 移除 window 监听器 + cancel rAF） */
  dispose: () => void
}

export function useBrowserRectSync(
  viewportEl: Ref<HTMLElement | null>,
  getSessionId: () => string,
): RectSyncHandle {
  /** 上次推 rect 的时间戳（时间节流） */
  let lastRectPushTs = 0
  /** 待推的 rAF id（null 表示无待执行帧） */
  let rectRafId: number | null = null
  /** 节流窗口内兑底 setTimeout id（null 表示无挂起 timer；dispose 清理） */
  let rectTimerId: number | null = null
  /** viewport 尺寸监听器（disconnect 释放） */
  let resizeObserver: ResizeObserver | null = null

  /**
   * 算 viewport 元素的 rect 并推给主进程 setBounds。
   * [HISTORICAL] 不乘 devicePixelRatio——setBounds 用 DIP，与 CSS px 1:1。乘 dpr 在 retina 屏会导致 view 定位屏外 + 尺寸翻倍。
   */
  function pushRect(): void {
    const el = viewportEl.value
    if (!el) return
    const sid = getSessionId()
    if (!sid) return
    const domRect = el.getBoundingClientRect()
    const rect = {
      x: Math.round(domRect.x),
      y: Math.round(domRect.y),
      width: Math.round(domRect.width),
      height: Math.round(domRect.height),
    }
    // 跳过 0 尺寸（隐藏中/未布局），避免把 view 设成 0,0,0,0 等效隐藏
    if (rect.width === 0 || rect.height === 0) return
    void browserSetRect(sid, rect)
  }

  /**
   * 节流推 rect：rAF 合并同帧 + 33ms 时间下限。
   * 拖窗口 resize 每秒可触发 60 次，不加时间下限会让同步 IPC 阻塞主进程。
   * 节流窗口内的最后一次变化用 setTimeout 兜底，避免丢失。
   */
  function scheduleRectPush(): void {
    const now = Date.now()
    if (now - lastRectPushTs < RECT_PUSH_THROTTLE_MS) {
      // 节流窗口内：setTimeout 兑底，保证窗口结束后再推一次（避免最后一次 resize 丢失）。
      // 去重：窗口内已有兑底 timer 时不重复新建（高频 resize 会反复进入本分支）。
      if (rectTimerId !== null) return
      rectTimerId = window.setTimeout(() => {
        rectTimerId = null
        if (rectRafId !== null) return // 已有 rAF 在路上，让它推
        rectRafId = requestAnimationFrame(() => {
          rectRafId = null
          lastRectPushTs = Date.now()
          pushRect()
        })
      }, RECT_PUSH_THROTTLE_MS - (now - lastRectPushTs))
      return
    }
    if (rectRafId !== null) return // 已有待执行 rAF
    rectRafId = requestAnimationFrame(() => {
      rectRafId = null
      lastRectPushTs = Date.now()
      pushRect()
    })
  }

  // 监听 viewport 尺寸变化（drawer 开合 / 模式切换）
  watch(
    viewportEl,
    (el, _prev, onCleanup) => {
      if (!el) return
      resizeObserver = new ResizeObserver(() => scheduleRectPush())
      resizeObserver.observe(el)
      onCleanup(() => {
        resizeObserver?.disconnect()
        resizeObserver = null
      })
    },
    { immediate: true },
  )

  // window resize（拖窗口，高频）：RO 不一定捕获（元素尺寸可能不变但位置变）
  window.addEventListener('resize', scheduleRectPush)
  // Splitter @layout → PanelContainer 派发的 CustomEvent（drawer 宽度拖动调整）。
  // RO 在 SplitterPanel overflow:hidden + reka-ui 高频拖动下触发不可靠，此为补充路径。
  window.addEventListener('taiji:splitter-layout', scheduleRectPush)

  function dispose(): void {
    resizeObserver?.disconnect()
    resizeObserver = null
    window.removeEventListener('resize', scheduleRectPush)
    window.removeEventListener('taiji:splitter-layout', scheduleRectPush)
    if (rectRafId !== null) {
      cancelAnimationFrame(rectRafId)
      rectRafId = null
    }
    if (rectTimerId !== null) {
      clearTimeout(rectTimerId)
      rectTimerId = null
    }
  }

  return { pushRect, scheduleRectPush, dispose }
}