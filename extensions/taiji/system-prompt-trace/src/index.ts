/**
 * pi extension wiring：把 ExtensionContext 适配进 trace.ts 状态机并订阅三个事件。
 *
 * 事件直接标注 SDK 具名类型（与同组 msg-id-mapper / system-prompt 的既有风格一致）：
 * pi 的 on() 按事件名重载，handler 参数即 SDK 事件类型。SDK reason 枚举演进时
 * mapReasonForFirstWrite 的 switch 在编译期报 non-exhaustive（负防腐），不再有运行时静默归一。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeSwitchEvent,
	SessionStartEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

import { setPiHandle } from "@zhushanwen/pi-extension-logger";

import { readLastPromptFromSessionFile } from "./baseline.js";
import { createSystemPromptTrace } from "./trace.js";
import type { TraceContext, TraceEnv } from "./trace.js";
import type { SwitchStash } from "./types.js";

// 模块级单例：session_before_switch（旧 runtime）→ session_start（新 runtime）之间传递
// targetSessionFile 直读基线。switch 会 teardown 并重建 extension runtime，闭包状态不跨
// runtime 存活（见 types.ts SwitchStash 注释），只有模块缓存在进程内延续。
const switchStash: SwitchStash = { pending: null };

function toTraceContext(pi: ExtensionAPI, ctx: ExtensionContext): TraceContext {
	// appendEntry 在 ExtensionAPI（pi 对象）上；getSystemPrompt/sessionManager 在 ExtensionContext 上
	return {
		getSystemPrompt: () => ctx.getSystemPrompt(),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		getSessionId: () => ctx.sessionManager.getSessionId(),
		getSessionFile: () => ctx.sessionManager.getSessionFile(),
	};
}

export default function systemPromptTraceExtension(pi: ExtensionAPI): void {
	// 日志通道注入（extension-logger 两阶段初始化：工厂拿 pi → setPiHandle）。缺此注入时
	// trace 中 logger.error 的 appendEntry 通道是 no-op，生产默认完全静默——
	// 此前全包从未注入（文本-实现漂移审查 D3 补接线，恢复注释声称的持久化语义）。
	// 测试环境无真实 globalPi 消费方时调用本身安全（存引用，不触发 appendEntry）。
	setPiHandle(pi);

	const env: TraceEnv = {
		readLastPromptFromFile: (filePath) => readLastPromptFromSessionFile(filePath),
	};

	const logic = createSystemPromptTrace(env, switchStash);

	pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
		logic.onSessionStart(
			event.reason,
			typeof event.previousSessionFile === "string" ? event.previousSessionFile : undefined,
			toTraceContext(pi, ctx),
		);
	});

	pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent) => {
		logic.onSessionBeforeSwitch(
			event.reason,
			typeof event.targetSessionFile === "string" ? event.targetSessionFile : undefined,
		);
	});

	pi.on("turn_start", async (_event: TurnStartEvent, ctx: ExtensionContext) => {
		logic.onTurnStart(toTraceContext(pi, ctx));
	});
}
