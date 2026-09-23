import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { callRenameLLM } from "./llm.js";
import type { RenameSessionConfig } from "./pure.js";

const logger = getLogger("rename-session");

/**
 * landTitle 注入项。
 *
 * llm.ts 刻意不依赖 pi 句柄（ExtensionAPI，见该模块 CallRenameLLMOptions 注释）——
 * 自动命名的 pi 副作用（getSessionName 防覆盖重查 / setSessionName 落库 / appendEntry
 * 落账）与本包唯一的自动落库管道收口在本模块，两触发入口不再各自复写这段。
 */
export interface LandTitleOptions {
	/**
	 * handler 侧 debug 日志（C3 契约，前缀区分触发入口）：
	 * - first-prompt 入口传 `firstPrompt <message>`
	 * - first-stop 入口传 `turnIndex=<n> <message>`
	 * skip/renamed to 文案本身由本模块统一产出（两入口共享硬契约文案）。
	 */
	debugLog: (message: string) => void;
	/**
	 * 显式 prompt 文本（first-prompt 模式）：文本从 message_end(role=user) 的 event
	 * 载荷取（handler 先于 entries append，getEntries() 此时不含本条，探针 P1 实测），
	 * 调用方负责提取并保证非空（空文本在 handler 侧先 skip）。
	 * 未提供时走 extractUserPromptText 从 session entries 取（first-stop 现状路径）。
	 */
	promptText?: string;
}

/**
 * 三种触发模式的共用落库管道：起 LLM → 防覆盖重查 → setSessionName → `renamed to` 日志。
 *
 * 关键契约（两触发入口一度逐字重复，收口于此——改一处即两入口同步）：
 * - usage 落账：闭包捕获 pi，把 rename LLM 调用的 usage 以 custom entry 落盘
 *   （pi.appendEntry → {type:"custom",customType:"rename-session",data:{model,usage},timestamp}，
 *   不进对话流不进 LLM 上下文）。调用时点（ok:true && usage 后立即、cleanTitle 前）由
 *   llm.ts 统一规定；catch 必须位于回调实现内部——appendEntry 抛错（session 已切换等）
 *   只记日志，不影响回调返回与后续 cleanTitle/setSessionName（「标题照常落库」）。
 * - 防覆盖：落库前重查——LLM 调用窗口（2-30s）内语义名/手动命名的竞态由此兜住
 *   （发起前查没有意义，那时查不能防竞态；skip 文案是 E2E 硬契约）。
 * - 日志时点：`renamed to` 必须晚于 setSessionName——防覆盖 return 在前，竞态命中时本
 *   日志不出现，避免「日志称 renamed 但未落库」。
 * - 错误传播：整条链路 catch 自吞（logger.error「rename LLM failed」），返回的 promise
 *   永不 reject；调用方按 fire-and-forget 处理（`void landTitle(...)`）。rename 是
 *   best-effort，任何 LLM 失败（网络/提取/auth/model 不可用）都静默跳过保留原 label，
 *   不进 session history。
 *
 * finalMessage：触发 turn 的 event.message（first-stop）；first-prompt 入口传
 * `{ content: [] }`——语义即「不等回复」，finalText 为空串走 buildTitleMessages 两条降级。
 */
export function landTitle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: RenameSessionConfig,
	finalMessage: unknown,
	opts: LandTitleOptions,
): Promise<void> {
	return callRenameLLM(ctx, config, finalMessage, {
		promptText: opts.promptText,
		appendUsageEntry: (model, usage) => {
			try {
				pi.appendEntry("rename-session", { model, usage });
			} catch (e) {
				logger.error("failed to append usage entry", { error: String(e) });
			}
		},
	})
		.then((title) => {
			// 无候选标题（LLM 失败 / model 不可用 / 清洗后为空）→ 静默跳过保留原 label
			if (!title) return;
			if (pi.getSessionName()) {
				opts.debugLog("skip: name exists");
				return;
			}
			pi.setSessionName(title);
			// 落库成功才打「renamed to」（防覆盖 return 在前，竞态命中时本日志不出现）
			opts.debugLog(`renamed to "${title}"`);
		})
		.catch((e) => logger.error("rename LLM failed", { error: String(e) }));
}
