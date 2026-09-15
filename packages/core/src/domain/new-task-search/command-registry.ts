/**
 * command-registry —— 命令注册表聚合（core 域迁移版，IF6）。
 *
 * [归位] 迁自 renderer composables/features/useCommandRegistry.ts（40 行），逻辑不变。
 * commandStore 从 useCommandStore()（pinia 全局）改为构造注入实例（F4）。
 *
 * D-016 物理隔离：appCommands 静态（session 切换不触发响应式）+ slashCommands per-session Map。
 * AC-2.2：切换 session 时 appCommands 不被重新计算（两区独立 ref）。
 */
import { computed, type ComputedRef } from 'vue'
import type { createCommandStore, SessionCommand } from './command-store'
import type { AppCommand } from './types'

/** 统一命令视图（供 useSearch 命令源 + Sidebar keydown 共享） */
export type UnifiedCommand = AppCommand | SessionCommand

export function useCommandRegistry(
  activeSessionId: { value: string | null },
  commandStore: ReturnType<typeof createCommandStore>,
) {
  /**
   * 聚合应用命令（静态）+ 当前 active session 的 slash 命令。
   * AC-2.1：返回统一列表。
   * AC-2.2：appCommands 不随 session 切换重算（物理隔离，store 内独立 ref）。
   * AC-2.3：pi 带 / 前缀天然不撞应用命令（D-009）。
   */
  function list(): ComputedRef<UnifiedCommand[]> {
    return computed(() => {
      const sid = activeSessionId.value
      const slash = sid ? commandStore.slashCommandsOf(sid).value : [] // 无 session → slash 空（AC-4.8）
      return [...commandStore.appCommands.value, ...slash]
    })
  }

  /**
   * 启动时注册应用命令（静态，一次性）。
   * AC-2.4：幂等覆盖，无 session 关联。
   */
  function registerApp(cmds: AppCommand[]): void {
    commandStore.registerApp(cmds)
  }

  return { list, registerApp }
}
