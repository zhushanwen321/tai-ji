/**
 * Workflow hook：turn_end 时检查模型是否成功调用 structured-output 工具。
 * 未成功时通过 pi.sendUserMessage({deliverAs:"steer"}) 注入 steering message 重试。
 * 最多重试 MAX_HOOK_RETRIES 次，防止无限循环。
 *
 * RetryState：从旧 4 个 mutable 闭包（soCallCount/soSucceededEver/hookRetryCount/
 * lastSchemaError）显式化为类——per-turn reset 时机成为可单测的显式契约：
 * onTurnEnd() 仅在「判定要 steer」时调用（守卫链 toolUse/超上限/成功短路均不调）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

// 截断原语与错误块预算来自 text-primitives（共享叶节点，导出复用勿复制）。原
// 「反向依赖（环）」已破除：本模块不再 import loop-gate，依赖图单向
// （loop-gate → text-primitives ← workflow-hook）。
import {
	extractToolErrorText,
	STEER_ERROR_MAX_CHARS,
	truncateText,
} from "./text-primitives.js";

import { isToolExecutionEndEvent, isTurnEndEvent, tryParseJson } from "./schema-guards.js";
import { isObjectRootSchema } from "./execute.js";

/** Pi Extension API — properly typed via ExtensionAPI from pi-coding-agent SDK */
type PiAPI = ExtensionAPI;

// 与 tool-definition.ts 的 TOOL_NAME 对应（本模块只监听该工具的 execution 事件；
// 保持依赖图单向：workflow-hook → schema-guards，不 import tool-definition）。
const TOOL_NAME = "structured-output";
const MAX_HOOK_RETRIES = 2;

/**
 * structured-output 调用状态机（IF-7，export 契约——M5 从本模块 import）。
 *
 * 转移表（M4-TC-2 单测锁定）：
 *   - onToolExecEnd(false)      → soCallCount++ / soSucceededEver=true（成功短路终态）
 *   - onToolExecEnd(true, err)  → soCallCount++ / lastSchemaError=err ?? 通用提示
 *   - onTurnEnd()               → soCallCount=0 / hookRetryCount++ / lastSchemaError=null
 *     （仅当「判定要 steer 且发送成功」时调用——守卫链 toolUse/error/aborted/超上限/
 *      成功短路/发送失败均不调，故 toolUse 保留 soCallCount、超上限保留
 *      lastSchemaError，与旧 4-closure 逐点一致）
 *
 * terminal 态（D3/U2）：由 loop-gate 在同签名失败达 3 次时经 markTerminal() 置位，
 * turn_end hook 据此不再 steer——防御性保留：shutdown 正常生效时进程已终止，
 * 此分支是 shutdown 失败路径下的保险。terminal 不影响 onToolExecEnd 记录
 * （闸门自身幂等，重复事件无害）。
 */
export class RetryState {
	soCallCount = 0;
	soSucceededEver = false;
	hookRetryCount = 0;
	lastSchemaError: string | null = null;
	terminal = false;

	/** 闸门 terminal 置位（loop-gate 经 index.ts 回调调用；不可逆，仅 reset() 可清）。 */
	markTerminal(): void {
		this.terminal = true;
	}

	/** 记录一次 structured-output tool 执行结果。hasError = event.isError === true。 */
	onToolExecEnd(hasError: boolean, errorMsg?: string): { shouldSteer: boolean } {
		this.soCallCount++;
		if (!hasError) {
			this.soSucceededEver = true;
			return { shouldSteer: false };
		}
		this.lastSchemaError = errorMsg ?? "structured-output call failed";
		return { shouldSteer: true };
	}

	/** turn 收尾（仅当要 steer 时调用）：重置本 turn 计数、累计重试次数、清空错误。 */
	onTurnEnd(): void {
		this.soCallCount = 0;
		this.hookRetryCount++;
		this.lastSchemaError = null;
	}

	/** 五字段归零（当前无调用方；保留作状态机完整契约——含 U2 新增 terminal 态）。 */
	reset(): void {
		this.soCallCount = 0;
		this.soSucceededEver = false;
		this.hookRetryCount = 0;
		this.lastSchemaError = null;
		this.terminal = false;
	}
}

/** steer 发送失败告警的 appendEntry customType（session JSONL 持久化，不进 LLM 上下文）。 */
export const HOOK_ENTRY_TYPE = "structured-output:hook";

/**
 * steer 发送失败告警（审查项#8 失败路径）：双通道落盘（同 loop-gate writeTerminatedLog
 * 惯例）——stderr 直出 + appendEntry 持久化。预算未扣减由「不调 onTurnEnd」结构保证，
 * 下一个正常收尾的轮仍会重试 steer，不产生静默哑火。
 */
function writeSteerFailedLog(pi: PiAPI, hookRetryCount: number, err: unknown): void {
	const message = toErrorMessage(err);
	process.stderr.write(
		`[structured-output hook] steer send failed (retry budget NOT consumed, will retry at next turn end): ${message}\n`,
	);
	try {
		pi.appendEntry(HOOK_ENTRY_TYPE, {
			event: "steer_send_failed",
			hookRetryCount,
			error: message,
			guidance:
				"The steering message could not be delivered (e.g. compaction in progress or extension deactivated); the retry budget was preserved and the hook will retry at the next turn end.",
		});
	} catch (appendErr) {
		// appendEntry 失败不阻断 hook——stderr 通道已落，此处补诊断（同 cache-probe 惯例）
		process.stderr.write(
			`[structured-output hook] appendEntry failed: ${toErrorMessage(appendErr)}\n`,
		);
	}
}

/**
 * steer 守卫链（原 turn_end handler 内联守卫提取，判定顺序与旧实现逐条一致）。
 * 命中任一守卫即跳过 steer，且调用方不调 onTurnEnd（toolUse/error/aborted 保留
 * soCallCount、超上限保留 lastSchemaError，与旧 4-closure 逐点一致）：
 *   0. 闸门 terminal（D3/U2）：同签名失败已满 3 次、shutdown 已发——不再 steer，
 *      让进程终止（防御性保留：shutdown 正常生效时进程已死，到不了这里）
 *   1. 已经成功调用过 structured-output，不再干预
 *   2. 不是合法 turn_end 事件
 *   3. stopReason="toolUse" → 模型还在调工具链，不需要干预
 *   4. stopReason="error"/"aborted"（审查项#9）/"deferred"（F4：pi-ai StopReason
 *      枚举成员，types.d.ts:275——provider 延迟响应挂起，本轮没有可消费 steer 的
 *      收尾点）→ 本轮异常/未收尾终止：此刻注入的 steer 在本轮不会被消费，
 *      chatMode 复用子进程时会泄漏成下一轮的陈旧指令——不发送
 *   5. 超过重试上限：放弃，让子进程自然结束（调用方据 result.error 判定失败）
 */
function shouldSkipSteer(state: RetryState, event: unknown): boolean {
	if (state.terminal) return true;
	if (state.soSucceededEver) return true;
	if (!isTurnEndEvent(event)) return true;
	const stopReason = event.message?.stopReason;
	if (stopReason === "toolUse") return true;
	if (stopReason === "error" || stopReason === "aborted" || stopReason === "deferred") return true;
	return state.hookRetryCount >= MAX_HOOK_RETRIES;
}

/**
 * 构造 steer reminder（原 turn_end handler 内联三元提取）。两种失败形态：
 *   - calledButFailed（调了但全是 isError）→ 注入具体校验错误 + 正确 schema
 *   - 否则（完全没调用）→ 注入"必须调用"提示 + schema 形状；文案按参数层实际契约
 *     （根类型）条件化：object 根 arguments 即 data；非 object 根参数层实际是 {value}
 *     包装（P6）——固定 "arguments ARE the data" 会指导模型直传裸值，必被包装层
 *     required:["value"] 拒绝，系统性浪费重试预算。判定与包装判定同源
 *     （isObjectRootSchema），与工具 description / ASP 同语汇。
 *
 * 错误块经 truncateText 截断（审查项#1，上限 = STEER_ERROR_MAX_CHARS，与 loop-gate
 * 签名上限语义独立——见 F5 拆分）：pi-ai validation.js 的实参回显无截断，
 * 大 payload 失败时原始错误 ≈11K chars。如实口径：截断保留首部 = 错误类型 +
 * 靠前的字段名，列表靠后的字段名可能被截掉；完整 schema 形状由 reminder 内
 * schemaJson 全文另行完整携带，模型修正不依赖错误块的截断尾部。
 */
function buildSteerReminder(
	calledButFailed: boolean,
	lastSchemaError: string | null,
	schemaJson: string,
	isObjectRoot: boolean,
): string {
	if (calledButFailed) {
		return [
			"[MANDATORY] Your structured-output call FAILED validation:",
			truncateText(lastSchemaError ?? "structured-output call failed", STEER_ERROR_MAX_CHARS),
			"",
			"The schema is enforced by the system (PI_WORKFLOW_SCHEMA) — this tool's parameter schema IS the required shape of your result.",
			`The required schema for your result is: ${schemaJson}`,
			"Fix your arguments to conform to this schema and call the structured-output tool AGAIN.",
			"Do NOT output the result as text — call the tool.",
		].join("\n");
	}
	return isObjectRoot
		? [
				"[MANDATORY] You MUST call the structured-output tool now.",
				"Your task requires a structured output. Do NOT respond with plain text.",
				`Your arguments ARE the data — call structured-output with your result as the tool's arguments, matching this shape: ${schemaJson}`,
				"The schema is enforced by the system; your arguments are validated against the authoritative schema automatically.",
				"This is enforced by the workflow system. Just call the tool.",
			].join("\n")
		: [
				"[MANDATORY] You MUST call the structured-output tool now.",
				"Your task requires a structured output. Do NOT respond with plain text.",
				`Call structured-output with a single argument \`{value: <data>}\` — put the result itself in \`value\`, and it must conform to this shape: ${schemaJson}`,
				"Non-object schemas are wrapped in a `value` field because tool call arguments must be objects.",
				"Validation errors may reference paths starting with `value.` (e.g. `value.0`, `value.name`): that prefix addresses the wrapper, not your data — strip it to locate the offending field.",
				"The schema is enforced by the system; the `value` field is validated against the authoritative schema automatically.",
				"This is enforced by the workflow system. Just call the tool.",
			].join("\n");
}

/**
 * 注册 turn_end hook，检查模型是否成功调用 structured-output 工具。
 * 未成功时通过 pi.sendUserMessage({deliverAs:"steer"}) 注入 steering message 重试。
 * 最多重试 MAX_HOOK_RETRIES 次，防止无限循环。
 *
 * @returns 共享的 RetryState（U2：index.ts 拿它接线 loop-gate 的 onTerminal 回调）。
 *
 * 两种失败形态都会触发 steer：
 * 1. 完全没调用（soCallCount === 0）→ 注入"必须调用"提示 + 正确 schema
 * 2. 调了但全是 isError（soCallCount > 0 && !soSucceededEver）→ 注入具体校验错误
 *    + 正确 schema。旧实现在此处撒手交给 Pi 自然修正，但模型遇到 "Invalid JSON Schema"
 *    时无法自行修正（它不知道正确 schema 长什么样），实测会放弃 → 子进程正常退出 →
 *    workflow 把单点失败放大成整批崩溃。故此处主动 steer 并回灌错误细节。
 *
 * 检测时序：Pi 保证同 turn 内所有 tool_execution_end 都在 turn_end 之前触发，
 * 故 turn_end 读取的状态已反映本 turn 全部 tool 调用结果。
 */
export function setupWorkflowHook(pi: PiAPI, schemaJson: string): RetryState {
	const state = new RetryState();

	// 根类型判定与 {value} 包装判定同源（isObjectRootSchema，P6）：注册期
	// createWorkflowToolDefinition 已对同一 schema 完成 assertJsonSchemaRoot fail-fast，
	// 此处解析失败不可能到达；真失败时判定为非 object 根 → 包装契约文案（保守方向）。
	const isObjectRoot = isObjectRootSchema(tryParseJson(schemaJson));

	// 追踪 structured-output 调用结果：
	// 成功 → soSucceededEver=true（终态，后续不再干预）
	// 失败 → soCallCount++，记录 lastSchemaError，由 turn_end 决定是否 steer 重试
	pi.on("tool_execution_end", async (event: unknown) => {
		if (!isToolExecutionEndEvent(event)) return;
		if (event.toolName !== TOOL_NAME) return;
		state.onToolExecEnd(
			event.isError === true,
			extractToolErrorText(event.result) ?? "structured-output call failed",
		);
	});

	pi.on("turn_end", async (event: unknown) => {
		// 守卫链（判定明细见 shouldSkipSteer 注释）：命中即直接 return，不调
		// onTurnEnd——预算不扣减，状态保留到下一个正常收尾的轮再判定 steer。
		if (shouldSkipSteer(state, event)) return;

		// 完全没调用 OR 调了但全是失败 → 都需要 steer。两种情况共用重试上限与计数。
		const calledButFailed = state.soCallCount > 0;
		// 构造 reminder 时 lastSchemaError 必须仍是本 turn 的错误文本，
		// 故 onTurnEnd()（清空 lastSchemaError）必须在发送成功之后调用。
		const reminder = buildSteerReminder(calledButFailed, state.lastSchemaError, schemaJson, isObjectRoot);

		// 审查项#8：await 发送结果——发送失败（如 compaction 中 prompt() 抛错 / 扩展已
		// 被 assertActive 拒绝）不扣减重试预算（不调 onTurnEnd），否则 fire-and-forget
		// 丢一份 steer + 白扣一次预算，两次即永久哑火。
		// pi 0.84.1 实装（loader.js）：extension 侧 sendUserMessage 同步转发且吞掉异步
		// rejection（转 emitError）返回 void——await 对 undefined 立即解析；此处的
		// try/catch 兜住同步 throw（assertActive）与未来 pi 返回真 Promise 的形态。
		try {
			await pi.sendUserMessage(reminder, { deliverAs: "steer" });
		} catch (err) {
			writeSteerFailedLog(pi, state.hookRetryCount, err);
			return;
		}
		// 发送成功才按本 turn 重置计数、累计重试次数、清空 lastSchemaError
		state.onTurnEnd();
	});

	// U2：暴露共享状态——index.ts 接线 loop-gate 的 onTerminal 回调（markTerminal）
	return state;
}
