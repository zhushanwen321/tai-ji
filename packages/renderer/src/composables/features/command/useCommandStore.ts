/**
 * useCommandStore —— command store 壳单例（new-task-search 域 w5 壳接线）。
 *
 * [归位] SearchDeps.commandStore 必须是 core createCommandStore 实例（core useSearch/
 * useSearchJump 内部访问其方法），且 pendingSlash 通道两端（SearchModal 写 / Composer
 * useCommandPopoverTrigger watch 读）必须同实例，否则 slash 注入断裂。壳单例提供：
 * - 模块级缓存（多次调用同一实例，Sidebar/CommandPopover/SystemPage/Composer 共享数据）
 * - getPlatform().storage 注入（须在 providePlatform 之后调用——AppShell setup 先调
 *   useSettingsShell() 再渲染子树，消费方都在子树内）
 * - 创建时 fire-and-forget initShortcutOverrides（async 恢复 localStorage 覆盖，
 *   启动瞬间的读取窗口可接受——与旧 pinia 版 setup 同步读的差异）
 *
 * 消费方契约：core 实例的 ref 需显式 .value（无 pinia 解包）。
 * [D7 收口] 旧 pinia stores/command.ts 已删（renderer-deepening u2.1），本单例是唯一 command SSOT。
 */
import { createCommandStore, getPlatform } from '@taiji/core'

let instance: ReturnType<typeof createCommandStore> | null = null

export function useCommandStore(): ReturnType<typeof createCommandStore> {
  if (!instance) {
    instance = createCommandStore(getPlatform().storage)
    // async 恢复快捷键覆盖（旧 pinia 版在 store setup 同步读 localStorage；core 版经
    // storage 端口 async 读，创建后立即 fire-and-forget，首次渲染前大概率完成）
    void instance.initShortcutOverrides()
  }
  return instance
}

/** 仅测试用：重置单例（跨用例隔离，对齐 core resetSearchModal/resetSideDrawer 先例）。 */
export function __resetCommandStoreForTesting(): void {
  instance = null
}
