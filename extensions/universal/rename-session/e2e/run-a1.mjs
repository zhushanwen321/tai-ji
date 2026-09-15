#!/usr/bin/env node
/**
 * A1 场景：工具型首轮 —— 触发时机 + 输入内容证据链（契约 C1）。
 *
 * [L2.5 faux 翻轨，2026-09-15] LLM 演员改 faux 脚本（凭证无关、零 token）：
 * 队列 = bash toolCall（列 ts 文件，触发多 iteration）→ 最终 stop 文本（结论文案，
 * 刻意不含 .ts 原始行形态——④ 负向断言的特征行前提）→ rename 标题文本。
 * 断言面全在扩展捕获的请求日志/时序构造（非模型智能），全部保留不动。
 *
 * 流程：真实 pi + faux 演员，在有 ts 文件的 fixture 目录发「列出当前目录的 ts 文件并统计行数」
 * （触发多 iteration 工具调用），round 完成后等 rename 落库，然后五重断言：
 *   ① 流序判别（主）：session JSONL 中 LLM request 日志 entry 时刻之后，stdout 时间轴上无
 *      turn_start/message_start/message_end 事件（中途触发的特征是其时刻之后仍有后续 turn
 *      事件）；时刻辅助 t(LLM request) ≥ t(最终 message_end) − 1s；round 中间 iteration 的
 *      turn_end 后仅 skip: stopReason=toolUse 类日志
 *   ② 仅一条 LLM request，user 段含「ts 文件」，结构为 [user, assistant, user] 三条
 *   ③ 内容匹配（主判别器）：日志 assistant 段（preview 截断后）与 session JSONL 最后一条
 *      stop assistant message 文本经 rebuildPreview 同构重构后一致
 *   ④ 负向：LLM request 的任何 message 段不含 toolResult 原始输出特征行
 *      （从实际 toolResult 内容选「仅原始输出才有的形态」——已剔除会出现在结论里的行）
 *   ⑤ session_info 行位于 round 全部 message entry 之后且 name 非空（行序佐证）
 *
 * 断言依据的探针事实见 e2e/README.md（P0）。rename 日志 entry 数据源 = session JSONL 的
 * extension-logger appendEntry 通道（customType rename-session:log），不写 pi 进程 stderr。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	LLM_REQUEST_MARKER,
	assert,
	assertLogTitleMatches,
	extractLastStopAssistant,
	extractRenameLogEntries,
	parseJsonlEntries,
	parseLogMessages,
	rebuildPreview,
	runScenario,
	runStandalone,
	spawnPi,
} from "./harness.mjs";

/** fixture：含多个 ts 文件的临时工作目录（行数错开，让工具原始输出特征可辨别）。 */
function makeTsFixture() {
	const dir = mkdtempSync(join(tmpdir(), "rename-e2e-fixture."));
	writeFileSync(
		join(dir, "alpha.ts"),
		Array.from({ length: 37 }, (_, i) => `export const alphaLine${i} = ${i};`).join("\n") + "\n",
	);
	writeFileSync(
		join(dir, "beta.ts"),
		Array.from({ length: 12 }, (_, i) => `export const betaLine${i} = ${i};`).join("\n") + "\n",
	);
	writeFileSync(
		join(dir, "gamma.ts"),
		Array.from({ length: 21 }, (_, i) => `export const gammaLine${i} = ${i};`).join("\n") + "\n",
	);
	writeFileSync(join(dir, "notes.md"), "# notes\n\n非 ts 文件，用于验证过滤。\n");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * faux 队列（全局到达序）：
 * 1. bash toolCall（列 ts 文件 + 行数）——多 iteration 触发，toolResult 提供 ④ 的原始输出特征行
 * 2. 最终 stop 文本——③ 内容匹配的 finalText（≤300 码点，preview=全文；刻意不含
 *    「alpha.ts」等 .ts 完整形态，保 ④ 特征行非空）
 * 3. rename 标题（rename LLM 消费的响应）
 */
const FAUX_RESPONSES = [
	{
		toolCalls: [
			{ name: "bash", args: { command: "for f in alpha.ts beta.ts gamma.ts; do echo \"$f $(wc -l < $f)\"; done" } },
		],
	},
	{ text: "共找到 3 个 ts 文件，合计 70 行；其中 alpha 最长，gamma 次之，beta 最短。" },
	{ text: "count-ts-file-lines" },
];

/** 收集 toolResult message 的原始输出行（A1 ④ 负向断言的特征候选来源）。 */
function collectToolResultLines(entries) {
	const rawLines = [];
	for (const entry of entries) {
		if (entry?.type !== "message" || entry.message?.role !== "toolResult") continue;
		if (!Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			if (block?.type === "text" && typeof block.text === "string") {
				rawLines.push(...block.text.split("\n"));
			}
		}
	}
	return rawLines;
}

/**
 * 执行 round：注册 round 等待（须先于 prompt）→ prompt → 等最终 stop → settled
 * → rename 终态日志 → session_info 落盘。返回 rename 结果日志（assertLogTitleMatches 用）。
 */
async function driveRound(pi, prompt) {
	// waitFor 只匹配未来事件，round 相关等待须在 prompt 前注册
	const settledP = pi.rpc.waitAgentSettled(180_000);
	const finalStopEndP = pi.rpc.waitFor("message_end", {
		timeoutMs: 180_000,
		filter: (ev) => ev?.message?.role === "assistant" && ev?.message?.stopReason === "stop",
	});
	await pi.rpc.prompt(prompt);
	await finalStopEndP;
	await settledP;
	// 等 rename 最终结果（显式等 renamed to 终态标记——宽松匹配 skip 日志会命中
	// 中间 iteration 的 skip: stopReason=toolUse 提前返回，那不是最终结果）
	const renameRes = await pi.rpc.waitForSessionLog('renamed to "', { timeoutMs: 45_000 });
	// 轮询等 session_info 落盘再读全量行（pi append→flush 有延迟，日志先于落库）
	await pi.waitSessionInfoEntry(10_000);
	return renameRes;
}

/** 取唯一 LLM request 日志 entry（A1 ② 前置：恰一条）。 */
function findSoleLlmRequest(logEntries) {
	const llmReqEntries = logEntries.filter((e) => e.message.includes(LLM_REQUEST_MARKER));
	assert(
		llmReqEntries.length === 1,
		`期望仅 1 条 LLM request 日志，实际 ${llmReqEntries.length} 条`,
	);
	return llmReqEntries[0];
}

/** A1 ① 流序判别（主）+ 时刻辅助：LLM request 之后无 turn 事件、时刻不早于最终 message_end-1s。 */
function assertStreamOrder(timeline, llmReq) {
	// 锚点 = session JSONL 中 LLM request entry 的时刻（data.timestamp，与时间轴同为
	// 本机 epoch ms 可比较）。断言集 = 场景 A1 ① 流序判别的 turn_start/message_start/
	// message_end（不含 turn_end：pi 先调 turn_end handler 再向 stdout 写事件，最终
	// turn_end 滞后 LLM request 1ms 级是通道顺序伪影非中途触发；中途触发的真特征是
	// 其时刻之后仍有下一 iteration 事件）
	const turnEventTypes = new Set(["turn_start", "message_start", "message_end"]);
	const lateTurnEvents = [];
	let finalStopEndT = null;
	for (const e of timeline) {
		if (e.stream !== "out") continue;
		let ev;
		try {
			ev = JSON.parse(e.line);
		} catch {
			continue;
		}
		if (ev?.type === "message_end" && ev.message?.role === "assistant" && ev.message?.stopReason === "stop") {
			finalStopEndT = e.t;
		}
		if (e.t > llmReq.t && turnEventTypes.has(ev?.type)) {
			lateTurnEvents.push(`${ev.type}@t=${e.t}`);
		}
	}
	assert(
		lateTurnEvents.length === 0,
		`LLM request 之后仍出现 turn 事件（中途触发特征）: ${lateTurnEvents.join(", ")}`,
	);
	assert(finalStopEndT !== null, "时间轴上未找到最终 stop assistant message_end");
	assert(
		llmReq.t >= finalStopEndT - 1000,
		`时刻辅助失败: t(LLM request)=${llmReq.t} 早于 t(最终 message_end)-1s=${finalStopEndT - 1000}`,
	);
}

/** A1 ① 补：中间 iteration turn_end 后仅 skip: stopReason=toolUse 类日志。 */
function assertToolUseSkips(logEntries, llmReq, log) {
	// firstPrompt skip: mode=first-stop 是 first-prompt handler 的模式分发日志
	//（rename-session-three-modes 落地后出现），与本断言要抓的「round 中间 iteration
	// 的 stopReason skip」不同源——排除后过滤（faux 翻轨首跑暴露：真实轨下该日志
	// 同样早于 LLM request，原断言对存量代码已假红）。
	const skipBefore = logEntries.filter(
		(e) => e.message.includes("skip: ") && !e.message.includes("firstPrompt skip:") && e.t < llmReq.t,
	);
	assert(skipBefore.length >= 1, `期望多 iteration 场景至少 1 条 toolUse skip 日志，实际 ${skipBefore.length} 条`);
	for (const e of skipBefore) {
		assert(
			/skip: stopReason=toolUse\b/.test(e.message),
			`LLM request 前出现非 toolUse 类 skip 日志: ${e.message}`,
		);
	}
	log(`round 中间 iteration skip 日志 ${skipBefore.length} 条（均 stopReason=toolUse）`);
}

/** A1 ② 补：messages 结构 [user, assistant, user] + user/instruction 段内容特征。返回解析结果。 */
function assertLlmRequestShape(llmReq) {
	const messages = parseLogMessages(llmReq.message);
	assert(messages !== null, "LLM request 行 JSON 解析失败");
	assert(
		messages.length === 3 &&
			messages[0].role === "user" &&
			messages[1].role === "assistant" &&
			messages[2].role === "user",
		`messages 结构非 [user, assistant, user]: ${JSON.stringify(messages?.map((m) => m.role))}`,
	);
	assert(messages[0].text.includes("ts 文件"), `user 段不含 prompt 特征「ts 文件」: ${messages[0].text}`);
	assert(messages[2].text.includes("slug"), `instruction 段不含「slug」特征: ${messages[2].text}`);
	return messages;
}

/** A1 ③ 内容匹配（主判别器）：日志 assistant 段与 session JSONL stop assistant 文本经同构重构后一致。返回 finalText。 */
function assertContentMatch(lines, messages) {
	const finalText = extractLastStopAssistant(lines);
	assert(
		typeof finalText === "string" && finalText.length > 0,
		"JSONL 中无 stop assistant 文本（finalText 为空）",
	);
	const rebuilt = rebuildPreview(finalText);
	// 同构前提：finalText ≤ 4000 码点（truncateForTitle 截断上界）——真实日志链路是
	// previewText(truncateForTitle(finalText))，超过上界时截断版尾部（码点 3901-4000）
	// ≠ 全文尾部（码点 N-99..N），rebuildPreview 对原始文本的 preview 断言会假失败。
	// 取舍：不引入 mjs↔ts 同构截断函数（避免扩大维护面），改为前置断言锁定输入规模。
	assert(
		Array.from(finalText).length <= 4000,
		`finalText 超过 4000 码点（${Array.from(finalText).length}），rebuildPreview 同构断言前提失效`,
	);
	assert(
		messages[1].text === rebuilt,
		`内容不匹配（中途触发或注入内容错误）:\n  日志 assistant 段: ${JSON.stringify(messages[1].text)}\n  重构 preview:    ${JSON.stringify(rebuilt)}`,
	);
	return finalText;
}

/**
 * A1 ④ 负向：LLM request 的任何 message 段不含 toolResult 原始输出特征行。
 * 特征选择：含 .ts 且不出现在结论文本中的行（「仅原始输出才有的形态」，剔除会进结论的词）。
 * 返回 { features, entries }（entries 供 ⑤ 行序断言复用，避免重复解析）。
 */
function assertNoToolResultLeak(lines, finalText, messages) {
	const entries = parseJsonlEntries(lines);
	const toolRawLines = collectToolResultLines(entries);
	const features = toolRawLines.filter(
		(l) => l.includes(".ts") && l.trim().length >= 8 && !finalText.includes(l.trim()),
	);
	assert(features.length > 0, "未找到 toolResult 原始输出特征行（负向断言前提缺失）");
	const leaked = features.filter((f) => messages.some((m) => m.text.includes(f) || m.text.includes(f.trim())));
	assert(
		leaked.length === 0,
		`LLM request 含 toolResult 原始输出特征（全量注入残留）: ${JSON.stringify(leaked.slice(0, 3))}`,
	);
	return { features, entries };
}

/** A1 ⑤ session_info 行序（在全部 message 之后）+ name 非空 + 日志标题一致。 */
function assertSessionInfoOrder(entries, renameRes, log) {
	let lastMsgIdx = -1;
	const infoIdx = [];
	entries.forEach((entry, i) => {
		if (entry?.type === "session_info") infoIdx.push(i);
		if (entry?.type === "message") lastMsgIdx = i;
	});
	assert(infoIdx.length >= 1, "session JSONL 无 session_info entry（rename 未落库）");
	assert(
		infoIdx.every((i) => i > lastMsgIdx),
		`session_info 行序异常: info=[${infoIdx}] 最后 message idx=${lastMsgIdx}`,
	);
	const lastInfo = entries[infoIdx[infoIdx.length - 1]];
	assert(typeof lastInfo.name === "string" && lastInfo.name.length > 0, "session_info.name 为空");
	assertLogTitleMatches(renameRes.message, lastInfo.name);
	log(`标题: ${lastInfo.name}`);
}

export async function runA1() {
	return runScenario("A1", async (log) => {
		const PROMPT = "列出当前目录的 ts 文件并统计行数";
		const fixture = makeTsFixture();
		const pi = await spawnPi({ tag: "a1", cwd: fixture.dir, faux: { responses: FAUX_RESPONSES } });
		try {
			const renameRes = await driveRound(pi, PROMPT);

			const timeline = pi.timeline.all();
			// rename 日志 entry（extension-logger appendEntry 落 session JSONL）
			const lines = await pi.readSessionLines();
			assert(Array.isArray(lines), "session JSONL 不存在或不可读");
			const logEntries = extractRenameLogEntries(lines);

			const llmReq = findSoleLlmRequest(logEntries);
			assertStreamOrder(timeline, llmReq);
			assertToolUseSkips(logEntries, llmReq, log);
			const messages = assertLlmRequestShape(llmReq);
			const finalText = assertContentMatch(lines, messages);
			const { features, entries } = assertNoToolResultLeak(lines, finalText, messages);
			assertSessionInfoOrder(entries, renameRes, log);
			log(
				`证据链: 流序①OK / 仅1条request+user段②OK / 内容匹配③OK（preview ${messages[1].text.length} 字符）/ 负向④OK（${features.length} 条特征行零泄漏）/ 行序⑤OK`,
			);
		} finally {
			pi.cleanup();
			fixture.cleanup();
		}
	});
}

// ── 独立执行入口（node e2e/run-a1.mjs）──
runStandalone(import.meta.url, runA1);
