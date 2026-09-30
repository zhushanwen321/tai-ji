/**
 * 命令文案在错误消息 / 通知中的展示截断（单份实现）。
 *
 * 为什么独立成叶子模块：truncateCommand 曾在 spawn-background.ts 与 notify.ts 各留
 * 一份同构定义——notify 被 spawn-background import（emitPendingRegister），反向 import
 * 会成环，两份只能靠数值对齐隐式同步。抽到双方共同依赖的叶子模块后环消失，截断
 * 口径（80 字符 + 省略号）单源。
 */

/** 命令在错误文案中的展示长度上限。 */
export const COMMAND_DISPLAY_LIMIT = 80;

/** 超上限取前 80 字符 + 省略号；等长/短命令原样返回。 */
export function truncateCommand(command: string): string {
	return command.length > COMMAND_DISPLAY_LIMIT
		? `${command.slice(0, COMMAND_DISPLAY_LIMIT)}…`
		: command;
}
