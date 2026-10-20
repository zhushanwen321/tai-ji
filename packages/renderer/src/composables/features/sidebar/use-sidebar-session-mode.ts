import { ref } from 'vue'
import type { SidebarSessionMode } from './useProjectGroups'

/** 模式持久化键（与 useDrawerSplitWidth 的 `taiji:` 前缀 UI 偏好同通道、同 localStorage 直存形态） */
const SESSION_MODE_KEY = 'taiji:sidebar-session-mode'

/** 恢复持久化模式（缺失/非法值回退默认平铺——N8 默认 A） */
function loadSidebarSessionMode(): SidebarSessionMode {
  return localStorage.getItem(SESSION_MODE_KEY) === 'groups' ? 'groups' : 'flat'
}

/**
 * 侧栏会话列表 flat/groups 模式开关（localStorage 持久化，全局 UI 偏好非 per-session 态）。
 * @param onLeaveGroups 模式实际切换后的联动复位（组头随模式卸载，删除确认态不留残）
 */
export function useSidebarSessionMode(onLeaveGroups: () => void) {
  const mode = ref<SidebarSessionMode>(loadSidebarSessionMode())

  /** 切换模式并持久化 */
  function setMode(next: SidebarSessionMode): void {
    if (mode.value === next) return
    mode.value = next
    onLeaveGroups()
    localStorage.setItem(SESSION_MODE_KEY, next)
  }

  return { mode, setMode }
}
