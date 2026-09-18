#!/usr/bin/env node
/**
 * A7 场景：agent-tool 模式 —— rename_session 工具改名 + first-stop 对照。
 *
 * [L2.5 faux 翻轨，2026-09-15] LLM 演员改 faux 脚本（凭证无关、零 token）：主进程队列
 * = rename_session toolCall（title=TOOL_TITLE）→ 简短确认文本；对照进程队列 = 纯文本回复
 * （first-stop 不注册工具 ⇒ 必无 toolCall 的确定性判据与 agent 行为无关，faux 下恒成立）。
 *
 * 主进程：config 写 mode:"agent-tool"（extension load 时注册 rename_session 工具），先经
 * RPC 预置既有名（防覆盖守卫的触发前提），prompt 要求 agent 调 rename_session 改成指定标题。
 * 断言：
 *   ① 工具被调用：session JSONL 出现 rename_session toolCall entry
 *   ② 立即落库：`tool renamed to` 日志时刻早于最终 stop assistant message_end——
 *      execute 同步段内 setSessionName，不等 round 完成 / 下一轮
 *   ③ 覆盖既有名成功（不走防覆盖守卫）：最终名 = 指定标题 ≠ 预置名
 *
 * 对照进程：默认 first-stop 起动（不注册工具），同样 prompt。断言其 session JSONL 无任何
 * rename_session toolCall entry——确定性判据：pi RPC 无工具清单查询命令，但
 * 「无工具 ⇒ 必无 toolCall」，与 agent 行为无关（V3/V10 共用判据）。
 */

import {
	assert,
	countToolCalls,
	lastSessionInfoEntry,
	lastStopAssistantEndT,
	runScenario,
	runStandalone,
	sleep,
	spawnPi,
} from "./harness.mjs";

/** 工具指定标题（cleanTitle 后不变，断言可预测）。 */
const TOOL_TITLE = "重构配置加载";
/** 预置既有名（守卫触发前提：若 execute 误走防覆盖，最终名将保持此值）。 */
const PRESET_NAME = "预置占位名";
/** 两进程共用 prompt：明确指定工具与目标标题（Gate B 真实跑时的遵从性由模型决定，脚本按设计断言）。 */
const TOOL_PROMPT = `请调用 rename_session 工具，把当前会话改名为「${TOOL_TITLE}」。完成后简短确认即可，不要做其他事。`;

/** 主进程：agent-tool 模式 + 预置名覆盖 + toolCall/立即落库断言。 */
async function runToolSession(log) {
	const pi = await spawnPi({
		tag: "a7tool",
		renameConfig: { mode: "agent-tool" },
		faux: {
			responses: [
				{ toolCalls: [{ name: "rename_session", args: { title: "重构配置加载" } }] },
				{ text: "已把会话改名为「重构配置加载」。" },
			],
		},
	});
	try {
		// 预置既有名（RPC set_session_name success 即设置；首条 assistant 前可能仅在 pi 缓冲，
		// 不影响断言——覆盖判定看最终名）
		await pi.rpc.setSessionName(PRESET_NAME);

		const settledP = pi.rpc.waitAgentSettled(180_000);
		const toolLogP = pi.rpc.waitForSessionLog('tool renamed to "', { timeoutMs: 180_000 });
		await pi.rpc.prompt(TOOL_PROMPT);
		const toolLog = await toolLogP;
		await settledP;

		const lines = await pi.readSessionLines();
		assert(Array.isArray(lines), "session JSONL 不存在或不可读");

		// ① 工具被调用
		const calls = countToolCalls(lines, "rename_session");
		assert(calls >= 1, `① rename_session toolCall entry 未出现（${calls} 条）`);

		// ② 立即落库：tool renamed to（execute 内 setSessionName 后打出）早于最终 stop
		//    assistant message_end——落库发生在 round 完成前，不等下一轮
		const stopEndT = lastStopAssistantEndT(pi.timeline.all());
		assert(stopEndT !== null, "时间轴上未找到最终 stop assistant message_end");
		assert(
			toolLog.t < stopEndT,
			`② 立即落库断言失败: t(tool renamed to)=${toolLog.t} 不早于 t(最终 assistant message_end)=${stopEndT}`,
		);

		// ③ 覆盖既有名：最终名 = 指定标题（若误走防覆盖守卫，名字保持 PRESET_NAME）
		const info = await pi.waitSessionInfoEntry(10_000);
		assert(info !== null, "③ session_info 未落盘（工具改名未落库）");
		assert(info.name === TOOL_TITLE, `③ 最终名 "${info.name}" ≠ 指定标题 "${TOOL_TITLE}"（覆盖失败或未生效）`);
		const logTitle = toolLog.message.match(/tool renamed to "(.*)"$/)?.[1];
		assert(logTitle === TOOL_TITLE, `③ 工具日志标题 "${logTitle}" ≠ "${TOOL_TITLE}"`);
		assert(
			lastSessionInfoEntry(lines)?.name === TOOL_TITLE,
			`③ 落库名 "${lastSessionInfoEntry(lines)?.name}" ≠ "${TOOL_TITLE}"`,
		);
		log(`主进程: toolCall×${calls} + round 完成前落库 + 覆盖「${PRESET_NAME}」→「${info.name}」`);
	} finally {
		pi.cleanup();
	}
}

/** 对照进程：first-stop 起动（无工具），断言零 toolCall entry。 */
async function runControlSession(log) {
	const pi = await spawnPi({
		tag: "a7ctl",
		faux: {
			responses: [
				{ text: "当前模式没有注册 rename_session 工具，无法按请求改名。" },
			],
		},
	});
	try {
		const settledP = pi.rpc.waitAgentSettled(180_000);
		await pi.rpc.prompt(TOOL_PROMPT);
		await settledP;
		await sleep(600); // settled 后 JSONL flush 余量（pi append→flush 有延迟，A5 同款）
		const calls = countToolCalls(await pi.readSessionLines(), "rename_session");
		assert(
			calls === 0,
			`对照进程（first-stop）出现 ${calls} 条 rename_session toolCall entry（该模式不注册工具）`,
		);
		log("对照进程: 0 条 rename_session toolCall entry（first-stop 不注册工具 ⇒ 必无 toolCall）");
	} finally {
		pi.cleanup();
	}
}

export async function runA7() {
	return runScenario("A7", async (log) => {
		await runToolSession(log);
		await runControlSession(log);
	});
}

// ── 独立执行入口（node e2e/run-a7.mjs）──
runStandalone(import.meta.url, runA7);
