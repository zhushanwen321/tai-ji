/**
 * useBrowserFocusSync —— 切 session 时同步主进程 WebContentsView 焦点（Wave 4 per-session 隔离）。
 *
 * 职责：watch focusedSessionId 变化 → browserFocus(newSid) → 主进程 swap visible view。
 * 确保切 session 时屏幕只显示新 session 的 browser view（隐藏其他 session 的可见 view）。
 *
 * 为什么需要独立 composable 而非依赖 BrowserPane 的 mount/unmount：
 * - mount/unmount 驱动的 view swap 是隐式的，依赖 Vue 渲染时序
 * - spec D5 要求「renderer drawerState swap 与主进程 view swap 由同一 IPC 显式触发」
 * - LRU 淘汰后切回时，新 BrowserPane mount 会 create+show，但旧 session 的可见 view 不会被隐藏
 *   （旧 BrowserPane 已卸载，无人调 hide）——browserFocus 显式清场防止多 view 同时可见
 *
 * 触发源覆盖（独立 watch > 塞进 selectSession）：
 * - selectSession 主路径（点 sidebar session）
 * - ⌘[/⌘] 导航回退（AppShell watch navigation.pointer → syncSessionToPanel）
 * - deleteSession 后自动聚焦其他 session
 * 三条路径都会改变 focusedSessionId，独立 watch 全覆盖。
 *
 * 调用方：Workspace.vue onMounted 调用一次。watch 生命周期跟随组件。
 * 无 IPC（web/mock）时 browserFocus 静默 no-op，不影响其他逻辑。
 */
import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePanelStore } from '@/stores/panel'
import { browserFocus } from '@/lib/ipc'

export function useBrowserFocusSync(): void {
  const panel = usePanelStore()

  /**
   * 当前焦点 session（store.focusedSessionId，UI 高亮的真相源）。
   * v2 split 移除后直接读 store computed（此前 local computed 从 panels.find 派生，单 panel 下冗余）。
   */
  const { focusedSessionId } = storeToRefs(panel)

  // 切 session 时通知主进程 swap visible view。
  // immediate: true 覆盖首次挂载（此时可能已有 session 聚焦，确保 view 状态正确）。
  // null sid（无 session）时跳过——无 session 时主进程无需 swap。
  watch(
    () => focusedSessionId.value,
    (sid) => {
      if (sid) {
        // [W6] debug log：观察 focus swap 触发频率，便于排查「切 session 不更新」类问题。
        // 触发源覆盖 selectSession / ⌘[/⌘] / deleteSession 后自动聚焦三条路径，
        // 高频场景（如快速连按 ⌘[）打日志便于复现。
        console.debug('[browserFocusSync] swap to', sid)
        void browserFocus(sid)
      }
    },
    { immediate: true },
  )
}
