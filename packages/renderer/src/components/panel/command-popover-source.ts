/**
 * command-popover-source.ts —— CommandPopover slash 命令合并源注入契约（W3 收编，D1 归一）。
 *
 * 壳（useExtensionHostBridge）provide 真实实现（CommandRegistry.resolveSlashCommands 适配），
 * 组件 inject；单测 global.provide mock。无注入（独立使用/测试）时组件降级 pi-only 真源（现状行为）。
 *
 * 独立 .ts 文件而非 SFC 内导出：<script setup> 不允许 export 非 type 声明（编译期错误），
 * 且壳/测试需要 import 该 key，避免 import 整个组件文件。
 */
import type { InjectionKey } from 'vue'
import type { SlashCommandLike, ResolvedSlashCommand } from '@taiji/core'

/** slash 命令合并源（registry 声明 ∪ commandStore pi 真源）。 */
interface SlashCommandSource {
  resolveSlashCommands(piCommands: SlashCommandLike[]): ResolvedSlashCommand[]
}

/** provide/inject key——壳 provide，CommandPopover inject（对齐 ui 包 source-key 范式）。 */
export const SLASH_COMMAND_SOURCE_KEY: InjectionKey<SlashCommandSource> = Symbol('slash-command-source')
