/**
 * useCloseShortcut —— 容器快捷键的 IPC 桥（display-containers §6.7/§7.5）。
 *
 * 主进程 before-input-event 拦截 ⌘/Ctrl+W（type='close'）与 ⌃`（type='toggle-bottom-drawer'）
 * 后经 'shortcut' 通道转发 renderer（window-factory.ts；⌘W 同款转发链）。本 composable 只做
 * 订阅派发，**判定与 Esc 同源编排器**（key-orchestrator）——yields⌘W 让位 / 层级序 / 焦点契约
 * 都在那里，禁止在本文件持判定逻辑。
 *
 * - type='close'（⌘W）：编排器层级序逐层关容器（浮层 → 底抽屉 → 右抽屉），全关后关窗；
 * - type='toggle-bottom-drawer'（⌃`）：底抽屉开关（浮层开着照常切换）。
 *
 * 跨平台：before-input-event 主进程侧已处理 mac(meta)/win-linux(control)，renderer 只收 type。
 *
 * 调用方：Workspace.vue setup 顶层调用一次（与 useBrowserFocusSync 并列）。
 * 生命周期跟随组件，onScopeDispose 自动退订。
 */
import { onScopeDispose } from 'vue'
import { onShortcut } from '@/lib/ipc'
import { handleCmdWShortcut, handleToggleBottomDrawerShortcut } from './key-orchestrator'

export function useCloseShortcut(): void {
  const unsubscribe = onShortcut((type) => {
    if (type === 'close') {
      handleCmdWShortcut()
    } else if (type === 'toggle-bottom-drawer') {
      handleToggleBottomDrawerShortcut()
    }
  })

  onScopeDispose(() => {
    unsubscribe()
  })
}
