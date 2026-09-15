/**
 * useCloseShortcut —— Cmd/Ctrl+W 优先关 drawer 的快捷键编排。
 *
 * 主进程 before-input-event 拦截 Cmd/Ctrl+W 后经 'shortcut' type='close' 转发到 renderer。
 * 本 composable 订阅该事件，决策：
 * - drawer 打开 → 关 drawer（useSideDrawer.close()），不关窗口
 * - drawer 关闭 → 调 windowClose() IPC 主动关窗口（before-input-event 已 preventDefault
 *   默认菜单的关窗口行为，需 renderer 显式触发）
 *
 * 跨平台：before-input-event 主进程侧已处理 mac(meta)/win-linux(control)，renderer 只收 type。
 *
 * 调用方：Workspace.vue onMounted 调用一次（与 useBrowserFocusSync 并列）。
 * 生命周期跟随组件，onScopeDispose 自动退订。
 */
import { onScopeDispose } from 'vue'
import { onShortcut, windowClose } from '@/lib/ipc'
import { useSideDrawer } from '@/composables/features/drawer/useSideDrawer'

export function useCloseShortcut(): void {
  const { isOpen, close } = useSideDrawer()

  const unsubscribe = onShortcut((type) => {
    if (type !== 'close') return
    if (isOpen.value) {
      // drawer 打开 → 关 drawer，不关窗口
      close()
    } else {
      // drawer 关闭 → 关窗口（before-input-event 已吞掉默认菜单关窗，需显式触发）
      void windowClose()
    }
  })

  onScopeDispose(() => {
    unsubscribe()
  })
}
