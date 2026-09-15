/**
 * useBrowserZoom —— BrowserPane 缩放管理（Wave 5）。
 *
 * 职责：管理 zoom factor 状态 + Cmd+/-/0 快捷键 + 主进程 IPC 同步。
 * 抽出 composable 让 BrowserPane 聚焦布局，缩放逻辑独立可测。
 *
 * 快捷键（spec §4.2）：
 * - Cmd/Ctrl + = 放大（factor += STEP）
 * - Cmd/Ctrl + - 缩小（factor -= STEP）
 * - Cmd/Ctrl + 0 重置（factor = 1.0）
 *
 * factor 范围：MIN ~ MAX（0.25 ~ 5.0，Chromium 限制），防止极端值。
 *
 * per-session 持久化：主进程 webContents.setZoomFactor 是 per-webContents 的（每个 view 独立），
 * 切回 session 时 BrowserPane onMounted 调 browserGetZoom 读回上次值（view keep-alive 保留状态）。
 *
 * @param sessionIdRef session id（IPC 参数）
 * @returns { zoomFactor, zoomIn, zoomOut, zoomReset, setZoomFromRemote, onZoomKeydown }
 *   - zoomFactor：当前缩放因子响应式 ref（供 UI 显示百分比）
 *   - zoomIn/zoomOut/zoomReset：主动操作（按钮点击调）
 *   - setZoomFromRemote：主进程主动 setZoomFactor 后经 onBrowserState 回推时调（只更新本地 ref，不回调 IPC 避免循环）
 *   - onZoomKeydown：keydown handler（BrowserPane 挂全局 keydown 时传给它过滤 Cmd+/-/0）
 */
import { ref, watch, type Ref } from 'vue'
import { browserGetZoom, browserSetZoom } from '@/lib/ipc'

/** 缩放步进（每次 +/- 改变 10%） */
const ZOOM_STEP = 0.1
/** 最小缩放（Chromium 限制 0.25） */
const ZOOM_MIN = 0.25
/** 最大缩放（Chromium 限制 5.0） */
const ZOOM_MAX = 5.0
/** 默认缩放（100%） */
const ZOOM_DEFAULT = 1.0

/** 钳制 zoom factor 到合法范围 */
function clampZoom(factor: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor))
}

export function useBrowserZoom(sessionIdRef: Ref<string>): {
  zoomFactor: Ref<number>
  zoomIn: () => void
  zoomOut: () => void
  zoomReset: () => void
  setZoomFromRemote: (factor: number) => void
  onZoomKeydown: (e: KeyboardEvent) => boolean
} {
  const zoomFactor = ref<number>(ZOOM_DEFAULT)

  /** 应用 zoom factor 到主进程 + 更新本地状态 */
  function applyZoom(factor: number): void {
    const clamped = clampZoom(factor)
    zoomFactor.value = clamped
    void browserSetZoom(sessionIdRef.value, clamped)
  }

  /**
   * 主进程主动 setZoomFactor 后经 onBrowserState 推回时调，仅更新本地 ref 不调 IPC（避免循环）。
   *
   * 场景：dom-ready autoFit 检测到溢出 → 主进程 setZoomFactor(fit) + notify → renderer 收到 state.zoomFactor
   * → 调本方法同步本地基准。否则用户后续按 Cmd+ 时基准仍是 1.0（autoFit 前的值），缩放步进错误。
   * 与 applyZoom 区别：applyZoom 是 renderer→主进程（用户操作），setZoomFromRemote 是主进程→renderer（autoFit 回推）。
   */
  function setZoomFromRemote(factor: number): void {
    zoomFactor.value = clampZoom(factor)
  }

  function zoomIn(): void {
    applyZoom(zoomFactor.value + ZOOM_STEP)
  }

  function zoomOut(): void {
    applyZoom(zoomFactor.value - ZOOM_STEP)
  }

  function zoomReset(): void {
    applyZoom(ZOOM_DEFAULT)
  }

  /**
   * Cmd/Ctrl +/-/0 快捷键 handler。
   * BrowserPane 挂 window keydown 时调本函数，返回 true 表示已消费（阻止默认），false 表示非缩放键。
   * e.preventDefault 阻止浏览器默认缩放（Cmd+= 会触发页面缩放）。
   */
  function onZoomKeydown(e: KeyboardEvent): boolean {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return false
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      zoomIn()
      return true
    }
    if (e.key === '-') {
      e.preventDefault()
      zoomOut()
      return true
    }
    if (e.key === '0') {
      e.preventDefault()
      zoomReset()
      return true
    }
    return false
  }

  // sessionId 变化时从主进程读回该 session 的 zoom（view keep-alive 保留状态）
  watch(
    () => sessionIdRef.value,
    async (sid) => {
      if (sid) {
        zoomFactor.value = await browserGetZoom(sid)
      }
    },
    { immediate: true },
  )

  return { zoomFactor, zoomIn, zoomOut, zoomReset, setZoomFromRemote, onZoomKeydown }
}
