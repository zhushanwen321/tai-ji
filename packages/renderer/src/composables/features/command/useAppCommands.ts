/**
 * useAppCommands —— 应用内置命令注册（#2 D-004 命令注册表的应用命令区填充）。
 *
 * 职责：构建应用级命令列表（新建/收起侧栏），注册到 commandStore.appCommands，
 * 供 core useCommandRegistry（packages/core/src/domain/new-task-search/command-registry.ts）聚合进搜索命令源
 * + core useSearchJump.confirmCommand（packages/core/src/domain/new-task-search/search-jump.ts）按 name 查找执行 action
 * （renderer 版同名 useCommandRegistry.ts / useSearchJump.ts 已随域迁移删除，2026-09-11）。
 *
 * 接线层级：core 单例经壳适配 useCommandStore（registerApp）+ stores/sidebar（toggleCollapsed）。
 * actions 由调用方（useSidebar.initApp）注入，避免与 useSidebar 循环 import
 * （useSidebar.initApp 调本函数，本函数若再 import useSidebar 会成环）。
 *
 * 设计约束（spec G1.1 / D-004 / D-009）：
 *  - ⌘K（搜索本身）**不注册**为 appCommand：否则搜索结果出现「搜索」命令，逻辑自指（唤起搜索的命令
 *    出现在搜索结果里）。⌘K 的快捷键由 Sidebar keymap 兜底。
 *  - 命令按 name 唯一标识，pi slash 命令带 / 前缀（/commit）天然不与应用命令撞名（D-009）。
 *
 * 依赖方向：core 单例经壳适配 useCommandStore（registerApp）+ stores/sidebar（toggleCollapsed）。
 * 不依赖 api，不依赖 useCommandRegistry（本模块直接调 commandStore.registerApp，无需 session 上下文），不依赖 useSidebar（actions 注入破环）。
 */
import type { AppCommand } from '@taiji/core'
import { useCommandStore } from '@/composables/features/command/useCommandStore'
import { useSidebarStore } from '@/stores/sidebar'
import { usePresetStore } from '@/stores/preset'
import i18n from '@/i18n'

const t = i18n.global.t

/** 应用命令依赖的 actions（由调用方注入，打破与 useSidebar 的循环 import） */
export interface AppCommandActions {
  /** 新建任务（useSidebar.newSession） */
  newSession: () => void
}

/**
 * 构建并注册应用内置命令。
 * @param actions newSession（调用方 useSidebar.initApp 注入）
 */
export function registerAppCommands(actions: AppCommandActions): void {
  const sidebarStore = useSidebarStore()
  const commandStore = useCommandStore()
  const presetStore = usePresetStore()

  /** 将存储的 key（如 'n' / 'shift+n'）转为显示用的修饰键符号 */
  function displayShortcut(key: string): string {
    const isMac = navigator.platform.includes('Mac')
    const parts = key.split('+')
    const result: string[] = []
    for (const p of parts) {
      if (p === 'mod') result.push(isMac ? '⌘' : 'Ctrl')
      else if (p === 'shift') result.push(isMac ? '⇧' : 'Shift')
      else if (p === 'alt') result.push(isMac ? '⌥' : 'Alt')
      else result.push(p.toUpperCase())
    }
    return result.join(isMac ? '' : '+')
  }

  /** 构建快捷键显示文本：有 override 用 override，否则用默认修饰键 */
  function resolveShortcut(cmdId: string, defaultKey: string): string {
    const override = commandStore.shortcutOverrides.value[cmdId]
    if (override) return displayShortcut(override)
    // 默认格式：⌘+Key
    const isMac = navigator.platform.includes('Mac')
    return `${isMac ? '⌘' : 'Ctrl+'}${defaultKey.toUpperCase()}`
  }

  const appCommands: AppCommand[] = [
    { id: 'new-session', name: t('settings.command.new-session'), shortcut: resolveShortcut('new-session', 'n'), action: actions.newSession },
    { id: 'toggle-sidebar', name: t('settings.command.toggle-sidebar'), shortcut: resolveShortcut('toggle-sidebar', 'b'), action: () => sidebarStore.toggleCollapsed() },
    // FR-16：Cmd+Shift+P 打开模式选择 Popover
    // 兜底默认值（i18n key `settings.command.open-preset-select` 缺失时使用）必须与该 key 新措辞保持同步
    { id: 'open-preset-select', name: t('settings.command.open-preset-select', '打开模式选择'), shortcut: resolveShortcut('open-preset-select', 'shift+p'), action: () => presetStore.requestOpen() },
  ]

  commandStore.registerApp(appCommands)
}
