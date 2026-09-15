import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadRenameConfig, saveRenameConfig, setAutoRenameSwitch } from "./pure.js";

/**
 * 解析 /auto-rename 参数并执行开关操作。
 *
 * 开关双机制（见 pure.ts [COMPAT] 契约注释）：
 * - `<agentDir>/auto-rename-enabled` flag 文件 = taiji runtime 开关契约（live 覆盖源，存在即生效）
 * - `config/rename-session-ext-config.json` 的 `enabled` = pi CLI 用户开关（flag 不存在时生效）
 *
 * 写入策略：
 * - on → 只创建 flag（不写 config.enabled=true：避免 config 残留 true 导致旧 runtime 删 flag 后仍开启的错位）
 * - off → 先写 config.enabled=false（覆盖手写的 true），再删 flag（flag 是覆盖源，必须移除才真正关闭）
 *
 * 用法（enable/disable 是 on/off 的别名）：
 *   /auto-rename                  — 查看当前状态
 *   /auto-rename on | enable      — 开启
 *   /auto-rename off | disable    — 关闭
 */
export function executeAutoRenameCommand(args: string): string {
	const trimmed = args.trim().toLowerCase();

	if (trimmed === "" || trimmed === "status") {
		const { enabled } = loadRenameConfig();
		const state = enabled ? "已开启 ✓" : "已关闭 ✗";
		return `自动重命名会话：${state}\n用法：/auto-rename on | off | status（别名 enable / disable）`;
	}

	if (trimmed === "on" || trimmed === "enable") {
		setAutoRenameSwitch(true);
		return "已开启：自动重命名会话";
	}

	if (trimmed === "off" || trimmed === "disable") {
		const result = saveRenameConfig({ ...loadRenameConfig(), enabled: false });
		setAutoRenameSwitch(false);
		return result.success ? "已关闭：自动重命名会话" : `设置失败：${result.error}`;
	}

	return `未知参数 "${args.trim()}"。\n用法：/auto-rename on | off | status（别名 enable / disable）`;
}

/** 注册 /auto-rename 命令。 */
export function registerAutoRenameCommand(pi: ExtensionAPI): void {
	pi.registerCommand("auto-rename", {
		description: "控制自动重命名会话功能。/auto-rename [on|off|status]（别名 enable/disable）",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trimStart().toLowerCase();
			const opts = [
				{ label: "on", value: "on", description: "开启自动重命名" },
				{ label: "off", value: "off", description: "关闭自动重命名" },
				{ label: "enable", value: "enable", description: "开启自动重命名（on 别名）" },
				{ label: "disable", value: "disable", description: "关闭自动重命名（off 别名）" },
				{ label: "status", value: "status", description: "查看当前状态" },
			];
			return trimmed === "" ? opts : opts.filter((o) => o.label.startsWith(trimmed));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(executeAutoRenameCommand(args), "info");
		},
	});
}
