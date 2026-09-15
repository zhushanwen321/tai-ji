/**
 * 留痕状态机（纯逻辑，文件系统与 pi 上下文经 env/ctx 注入，可脱离 pi 单测）。
 *
 * 写入时机（设计 D2 校正）：
 * - 不在 session_start 写——该事件 emit 早于 resources_discover 的 prompt 重建，快照必不完整、
 *   首 turn 必误报一次 change；
 * - 首个 turn_start 写 initial/resume——此时 getSystemPrompt() 已含 before_agent_start 注入
 *   （pi 的事件链：用户消息 handler 先 await emitBeforeAgentStart（agent-session.ts:1243-1244），
 *   再 agent_start → turn_start 事件分发（agent-session.ts:739-746））；
 * - 后续每个 turn_start 做 hash 对比，变化才写 change。
 */

import { createHash } from "node:crypto";

import type { SessionStartEvent } from "@earendil-works/pi-coding-agent";

import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("pi-system-prompt-trace");
import { summarizePromptDiff } from "./diff.js";
import { mapReasonForFirstWrite, SYSTEM_PROMPT_CUSTOM_TYPE } from "./types.js";
import type {
	PromptBaseline,
	SwitchStash,
	SystemPromptTraceEntryData,
	TraceReason,
} from "./types.js";

/** 逻辑所需的 per-call pi 上下文（wiring 从 ExtensionContext + ExtensionAPI 适配；测试注入 fake）。 */
export interface TraceContext {
	getSystemPrompt(): string;
	appendEntry(customType: string, data: unknown): void;
	getSessionId(): string;
	/** 当前 session 文件路径（pi sessionManager.getSessionFile()；首条 assistant 落盘前可能 undefined）。 */
	getSessionFile(): string | undefined;
}

/** 文件系统侧依赖（wiring 用真实 fs；测试注入临时目录实现）。 */
export interface TraceEnv {
	readLastPromptFromFile(filePath: string): PromptBaseline | null;
}

export interface SystemPromptTrace {
	onSessionStart(
		reason: SessionStartEvent["reason"],
		previousSessionFile: string | undefined,
		ctx: TraceContext,
	): void;
	onSessionBeforeSwitch(reason: string, targetSessionFile: string | undefined): void;
	onTurnStart(ctx: TraceContext): void;
}

/** 当前已确立的 prompt 版本（写过或基线去重命中后确立）。 */
interface CurrentPrompt {
	version: number;
	hash: string;
	fullText: string;
}

function computePromptHash(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function createSystemPromptTrace(env: TraceEnv, stash: SwitchStash): SystemPromptTrace {
	let sessionStartReason: SessionStartEvent["reason"] | null = null;
	let baseline: PromptBaseline | null = null;
	let current: CurrentPrompt | null = null;

	const write = (
		ctx: TraceContext,
		text: string,
		hash: string,
		reason: TraceReason,
		version: number,
		parentFullText: string | undefined,
	): void => {
		const data: SystemPromptTraceEntryData = {
			version,
			hash,
			reason,
			fullText: text,
			charCount: text.length,
		};
		if (parentFullText !== undefined) {
			data.parentVersionDiffSummary = summarizePromptDiff(parentFullText, text);
		}
		ctx.appendEntry(SYSTEM_PROMPT_CUSTOM_TYPE, data);
	};

	return {
		onSessionStart(reason, previousSessionFile, ctx) {
			sessionStartReason = reason;
			current = null;
			// 基线解析（设计 D1/D2 v5 三档，优先级从高到低）：
			// 1. stash：session_before_switch 直读目标文件（进程内 resume；stash 为模块级单例，跨 runtime 传递）
			// 2. fork 档：读事件 previousSessionFile（源 session 文件）最后留痕——常态 /fork 时点
			//    fork 新文件未落盘（M0 探针实证），直读不可靠；缺失/未落盘/读取失败 → null
			// 3. 直读档：ctx.getSessionFile() 指向当前 session 文件（覆盖 reload / 直启 resume /
			//    new 兜底；文件不存在或无留痕 → null）
			// 4. 全 miss → null：首个 turn 按 reason 映射写 initial/resume（resume 必写 = 兜底路径）
			// stash 无论是否采用都消费：cancelled switch 的残留基线不允许污染下一次 session_start
			const stashed = stash.pending;
			stash.pending = null;
			if (stashed !== null && sessionStartReason === "resume") {
				baseline = stashed;
			} else if (sessionStartReason === "fork") {
				baseline = previousSessionFile !== undefined ? env.readLastPromptFromFile(previousSessionFile) : null;
			} else {
				const sessionFile = ctx.getSessionFile();
				baseline = sessionFile === undefined ? null : env.readLastPromptFromFile(sessionFile);
			}
		},

		onSessionBeforeSwitch(reason, targetSessionFile) {
			// 只有 resume 的目标文件承载同 session 历史；new 的目标是全新空文件。
			// 该 handler 在旧 runtime 里执行，结果写入模块级 stash 供新 runtime 的
			// session_start 消费（switch 会重建 extension runtime，见 types.ts SwitchStash 注释）。
			stash.pending =
				reason === "resume" && targetSessionFile !== undefined
					? env.readLastPromptFromFile(targetSessionFile)
					: null;
		},

		onTurnStart(ctx) {
			try {
				const text = ctx.getSystemPrompt();
				const hash = computePromptHash(text);
				if (current !== null) {
					// 后续 turn：hash 对比去重（设计 D2），变化才写 change
					if (hash === current.hash) return;
					write(ctx, text, hash, "change", current.version + 1, current.fullText);
					current = { version: current.version + 1, hash, fullText: text };
					return;
				}
				// 本 session_start 周期的首个 turn_start
				if (baseline !== null && baseline.hash === hash) {
					// 跨重启基线命中且未变化：不写，但确立 current 供后续 turn 继续对比
					current = { version: baseline.version, hash, fullText: text };
					return;
				}
				// 必写：有基线 → resume（该 session 已有历史版本，这是重开点的快照，version 续接）；
				// 无基线 → 按 SessionStartEvent.reason 映射（startup/new→initial，resume→resume 兜底必写）
				const version = baseline === null ? 1 : baseline.version + 1;
				const reason: TraceReason =
					baseline === null ? mapReasonForFirstWrite(sessionStartReason ?? "startup") : "resume";
				const parentFullText = baseline === null ? undefined : baseline.fullText;
				write(ctx, text, hash, reason, version, parentFullText);
				current = { version, hash, fullText: text };
			} catch (e) {
				// 留痕是诊断性旁路：任何失败都不允许影响 agent 主流程（logger.error → appendEntry 持久化）
				logger.error("turn_start handler failed", { detail: String(e) });
			}
		},
	};
}
