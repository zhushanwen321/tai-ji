/**
 * 插件贡献（hook/tool/command 注册条目）清理（从 plugin-service.ts 迁出，
 * max-lines 拆分——纯 Map 过滤逻辑无 this 依赖，逻辑不变）。
 *
 * togglePlugin(false) / uninstallPlugin / Worker crash 回调共用——禁用/卸载/崩溃
 * 插件的贡献不残留：仍可被路由的 tool/command 与仍会执行的 hook 都指向已死
 * Worker，调用必超时。Worker 侧对偶清理在 plugin-bootstrap 的 'deactivate'
 * 分支（disposePluginHooks / disposePluginTools）。
 */
import type { HookEntry, ToolEntry } from './plugin-types.js'
import type { CommandRegistration } from './api/commands-api.js'

/**
 * 清理指定插件的全部 hook 注册条目（P-1）。
 *
 * filter 重建数组保序（注册时的 priority 排序不受影响）；清空的 hookType 条目整键删除。
 */
export function removePluginHookEntries(hookRegistry: Map<string, HookEntry[]>, pluginId: string): void {
  for (const [hookType, entries] of hookRegistry) {
    const filtered = entries.filter(e => e.pluginId !== pluginId)
    if (filtered.length === 0) {
      hookRegistry.delete(hookType)
    } else {
      hookRegistry.set(hookType, filtered)
    }
  }
}

/**
 * 清理指定插件的全部工具注册条目（Fix-7：与 removePluginHookEntries 同模式）。
 *
 * 禁用/卸载插件的工具不再出现在 bridge schema 同步（syncToolsToBridge）与
 * bridge 执行路由中。
 */
export function removePluginToolEntries(toolRegistry: Map<string, ToolEntry>, pluginId: string): void {
  for (const [toolKey, entry] of toolRegistry) {
    if (entry.pluginId === pluginId) {
      toolRegistry.delete(toolKey)
    }
  }
}

/**
 * 清理指定插件的全部命令注册条目（Fix-7：与 removePluginHookEntries 同模式）。
 * 禁用/卸载后 command invoke 不再投递给该插件。
 */
export function removePluginCommandEntries(commandRegistry: Map<string, CommandRegistration>, pluginId: string): void {
  for (const [commandId, reg] of commandRegistry) {
    if (reg.pluginId === pluginId) {
      commandRegistry.delete(commandId)
    }
  }
}
