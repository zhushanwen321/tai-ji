#!/usr/bin/env node
/**
 * A6 场景：first-prompt 模式 —— 发出首条请求即得名，不等回复。
 *
 * [L2.5 faux 翻轨，2026-09-15] LLM 演员改 faux 脚本（凭证无关、零 token）。
 * 环境：config 写 mode:"first-prompt"、模型留空（设计 D5：空 ref 跟随会话主模型 = faux）。
 * faux 队列（全局到达序，注意 first-prompt 模式 rename LLM 先于主 LLM 发出）：
 * rename 标题 → 首轮主 turn 文本 → 次轮主 turn 文本。
 *
 * 断言（V2 通过标准）：
 *   ① 触发时点（稳定断言，非墙钟时序差）：首条 assistant message_start 之前 rename LLM
 *      请求已发出——pi 事件链 await handler（message_end(user) handler 完成后 agent-loop
 *      才发起主 LLM 调用），LLM request 日志 entry 在 handler 同步段打出，构造性早于
 *      assistant message_start（stdout 时间轴时刻）
 *   ② 仅基于 prompt 语义（结构性证据）：LLM request messages 为 [user, user]——finalText
 *      空串走两条降级，assistant 回复不在标题输入内；user 段含 prompt 特征词
 *   ③ 最终态：标题落库（renamed to 日志与 session_info 落库名一致）
 *   ④ 后续 round 不再改名：第二轮 prompt 后无新 LLM request / 无新 session_info /
 *      正向证据 `firstPrompt skip: userCount=1`（堵「handler 未被调用」的假通过）
 *
 * rename 完成 vs assistant 完成的相对次序仅观察记录、不做 gate（两个独立 LLM 调用的
 * 完成序受 provider 排班影响；faux 下两者均即时返回，次序由调用发起序决定）。
 */

import {
	LLM_REQUEST_MARKER,
	assert,
	assertLogTitleMatches,
	countLlmRequestLogs,
	countSessionInfoEntries,
	firstAssistantStartT,
	lastSessionInfoEntry,
	lastStopAssistantEndT,
	parseLogMessages,
	runScenario,
	runStandalone,
	spawnPi,
} from "./harness.mjs";

/** 首轮 prompt：任务语义明确、含可断言的特征词（触发时 rename LLM 只有这一段输入信号）。 */
const PROMPT = "解释什么是幂等性，并举一个 HTTP PUT 的例子";

/** 次轮 prompt：与首轮主题无关的简单追问（一次性语义：不应再触发 rename）。 */
const PROMPT_2 = "2+2等于几？只回答数字";

export async function runA6() {
	return runScenario("A6", async (log) => {
		const pi = await spawnPi({
			tag: "a6",
			renameConfig: { mode: "first-prompt" },
			// 队列到达序：first-prompt handler 先发 rename LLM（首条 user 消息后、主 LLM 前）
			// → 队列[0] 给 rename 标题，[1] 给首轮主 turn，[2] 给次轮主 turn
			faux: {
				responses: [
					{ text: "explain-idempotency-http-put" },
					{ text: "幂等性指同一操作执行多次与一次效果相同；HTTP PUT 语义上幂等——重复 PUT 同一资源状态不变。" },
					{ text: "2+2 等于 4。" },
				],
			},
		});
		try {
			// ── 第一轮：触发时点 ① + 输入结构 ② + 落库 ③ ──
			// waitFor 只匹配未来事件，三个等待须在 prompt 前注册
			const settled1P = pi.rpc.waitAgentSettled(180_000);
			const assistantStartP = pi.rpc.waitFor("message_start", {
				timeoutMs: 180_000,
				filter: (ev) => ev?.message?.role === "assistant",
			});
			const llmReqP = pi.rpc.waitForSessionLog(LLM_REQUEST_MARKER, { timeoutMs: 180_000 });
			await pi.rpc.prompt(PROMPT);

			const llmReq = await llmReqP;
			await assistantStartP; // 事件先入时间轴再 resolve waiters，此刻 timeline 必含该事件
			const startT = firstAssistantStartT(pi.timeline.all());
			assert(startT !== null, "时间轴上未找到 assistant message_start 事件");
			assert(
				llmReq.t < startT,
				`触发时点断言失败: t(LLM request)=${llmReq.t} 不早于 t(首条 assistant message_start)=${startT}`,
			);
			log(`① rename LLM request 早于首条 assistant message_start（提前 ${startT - llmReq.t}ms）`);

			const messages = parseLogMessages(llmReq.message);
			assert(messages !== null, "LLM request 行 JSON 解析失败");
			assert(
				messages.length === 2 && messages[0].role === "user" && messages[1].role === "user",
				`messages 结构非 [user, user]（first-prompt 不等回复，assistant 段应为空）: ${JSON.stringify(messages?.map((m) => m.role))}`,
			);
			assert(messages[0].text.includes("幂等性"), `user 段不含 prompt 特征「幂等性」: ${messages[0].text}`);
			assert(messages[1].text.includes("slug"), `instruction 段不含「slug」特征: ${messages[1].text}`);
			log("② LLM request 输入 = [user(prompt), user(instruction)]，无 assistant 段（标题仅基于 prompt）");

			await settled1P;
			const renameRes = await pi.rpc.waitForSessionLog('renamed to "', { timeoutMs: 45_000 });
			const info = await pi.waitSessionInfoEntry(10_000);
			assert(info !== null, "session_info 未落盘（rename 未落库）");
			assertLogTitleMatches(renameRes.message, info.name);
			// 完成序观察记录（不 gate）：rename 落库日志 vs 最终 assistant message_end
			const stopEndT = lastStopAssistantEndT(pi.timeline.all());
			if (stopEndT !== null) {
				const order = renameRes.t < stopEndT ? "早于" : "晚于";
				log(`完成序观察（不 gate）: rename 落库 ${order} assistant 完成（Δ=${Math.abs(renameRes.t - stopEndT)}ms）`);
			}
			log(`③ 标题落库: ${info.name}`);

			// ── 第二轮：后续 round 不再改名 ④ ──
			const llmBefore = await countLlmRequestLogs(await pi.readSessionLines());
			const infoBefore = countSessionInfoEntries(await pi.readSessionLines());
			const settled2P = pi.rpc.waitAgentSettled(180_000);
			const skipP = pi.rpc.waitForSessionLog("skip: userCount=1", { timeoutMs: 45_000 });
			await pi.rpc.prompt(PROMPT_2);
			await settled2P;
			await skipP;
			const lines2 = await pi.readSessionLines();
			const llmAfter = countLlmRequestLogs(lines2);
			assert(llmAfter === llmBefore, `④ 第二轮出现新 LLM request（${llmBefore} → ${llmAfter}）`);
			assert(
				countSessionInfoEntries(lines2) === infoBefore,
				`④ 第二轮出现新 session_info（${infoBefore} → ${countSessionInfoEntries(lines2)}）`,
			);
			assert(lastSessionInfoEntry(lines2)?.name === info.name, "④ 第二轮后标题被改名");
			log("④ 第二轮: firstPrompt skip: userCount=1 + 无新 LLM request + 无新 session_info");
		} finally {
			pi.cleanup();
		}
	});
}

// ── 独立执行入口（node e2e/run-a6.mjs）──
runStandalone(import.meta.url, runA6);
