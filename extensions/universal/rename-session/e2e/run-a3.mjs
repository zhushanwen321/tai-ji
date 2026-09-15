#!/usr/bin/env node
/**
 * A3 场景：防覆盖手动命名 —— 3a 静态 + 3b 竞态 + 3c 一次性语义。
 *
 * [L2.5 faux 翻轨，2026-09-15] LLM 演员改 faux 脚本（凭证无关、零 token）：
 * - 3a/3c 队列（全局到达序）：首轮主 turn 文本 → rename 标题 → 次轮主 turn 文本
 *   （3c 的 rename skip 不消费 rename 步骤，次轮只吃主 turn 步骤）
 * - 3b 竞态用 TAIJI_FAUX_TPS 流控拉长 rename 响应耗时（faux 即时返回会让竞态窗口
 *   缩到微秒级，手动命名永远抢不进）：rename 标题响应流式 ~秒级，known-flaky
 *   容忍保留（窗口仍受轮询 250ms + RPC 往返影响）
 *
 * 3a 静态：先 setSessionName「我的手动名字」再发 prompt；等 rename settled 后再等 ≥10s，
 *         最后 session_info 仍为手动名 + 日志 skip: name exists。
 * 3b 竞态：发 prompt 后等 session JSONL 出现 LLM request 日志 entry（rename LLM 调用进行中、
 *         尚未返回）立即 setSessionName「竞态命名」；等 rename settled 后断言 skip: name exists
 *         + 名字未被覆盖。
 * 3c 一次性：3a 完成后（同一 session）发第二条 prompt；断言无新 LLM request、无新自动
 *         session_info、正向证据 skip: count=2（堵「handler 未被调用」的假通过）。
 *
 * 3a+3c 共用一个 session（3c 依赖 3a 的既有手动名），3b 独立 session。
 */

import {
	HarnessError,
	LLM_REQUEST_MARKER,
	assert,
	extractRenameLogEntries,
	lastSessionInfoEntry,
	parseJsonlEntries,
	runScenario,
	runStandalone,
	sleep,
	spawnPi,
} from "./harness.mjs";

/** session JSONL 中 LLM request 日志 entry 条数（3c「无新 LLM request」断言用）。 */
async function countLlmRequests(pi) {
	const lines = await pi.readSessionLines();
	return extractRenameLogEntries(lines ?? []).filter((e) => e.message.includes(LLM_REQUEST_MARKER))
		.length;
}

/** session JSONL 中 session_info 条数（3c「无新自动 session_info」断言用）。 */
async function countSessionInfos(pi) {
	return parseJsonlEntries(await pi.readSessionLines()).filter((e) => e?.type === "session_info").length;
}

/** 3a + 3c：静态防覆盖 + 一次性语义（同一 session 两轮）。 */
async function seg3aAnd3c(log) {
	const MANUAL = "我的手动名字";
	const pi = await spawnPi({
		tag: "a3a",
		faux: {
			responses: [
				{ text: "1+1 等于 2。" }, // 首轮主 turn
				{ text: "simple-arithmetic-question" }, // 首轮 rename（被 name exists 守卫 skip 前仍真实调用）
				{ text: "2+2 等于 4。" }, // 3c 次轮主 turn
			],
		},
	});
	try {
		// ── 3a 静态 ──
		await pi.rpc.setSessionName(MANUAL);
		const settled1P = pi.rpc.waitAgentSettled(180_000);
		await pi.rpc.prompt("1+1等于几？只回答数字");
		await settled1P;
		// 显式等 skip: name exists 精确文案——宽松匹配 skip 日志可能命中中间 iteration 的
		// skip: stopReason=toolUse 提前返回，那不是 rename 的最终决定
		await pi.rpc.waitForSessionLog("skip: name exists", { timeoutMs: 45_000 });
		await sleep(10_500); // ≥10s 观察窗口（迟到覆盖检测）
		assert(lastSessionInfoEntry(await pi.readSessionLines())?.name === MANUAL, "3a 等待 10s 后手动名被覆盖");
		log(`3a OK: skip: name exists + 10s 后仍为「${MANUAL}」`);

		// ── 3c 一次性（同 session 第二轮）──
		const llmBefore = await countLlmRequests(pi);
		const infoBefore = await countSessionInfos(pi);
		const settled2P = pi.rpc.waitAgentSettled(180_000);
		await pi.rpc.prompt("2+2等于几？只回答数字");
		await settled2P;
		await pi.rpc.waitForSessionLog("skip: count=2", { timeoutMs: 45_000 });
		const llmAfter = await countLlmRequests(pi);
		assert(llmAfter === llmBefore, `3c 出现新 LLM request（${llmBefore} → ${llmAfter}）`);
		assert(
			(await countSessionInfos(pi)) === infoBefore,
			`3c 出现新自动 session_info（${infoBefore} → ${await countSessionInfos(pi)}）`,
		);
		assert(lastSessionInfoEntry(await pi.readSessionLines())?.name === MANUAL, "3c 第二轮后手动名被覆盖");
		log("3c OK: skip: count=2 + 无新 LLM request + 无新 session_info");
	} finally {
		pi.cleanup();
	}
}

/** 3b 竞态单次尝试（known-flaky，失败由调用方重跑，上限 2 次）。 */
async function seg3bOnce(log) {
	const RACE_NAME = "竞态命名";
	const pi = await spawnPi({
		tag: "a3b",
		// TPS=8：rename 标题响应流式秒级返回（faux 即时返回会把竞态窗口缩到微秒级，
		// 手动命名永远抢不进——known-flaky 从「偶发 miss」变「必然 miss」）
		faux: {
			tps: 8,
			responses: [
				{ text: "3+5 等于 8。" },
				{ text: "race-window-rename-title" },
			],
		},
	});
	try {
		const settledP = pi.rpc.waitAgentSettled(180_000);
		await pi.rpc.prompt("3+5等于几？只回答数字");
		// 等 LLM request 日志 entry（debug 内省在 callLLM 之前打出——此刻 rename LLM 调用进行中）
		const llmReq = await pi.rpc.waitForSessionLog(LLM_REQUEST_MARKER, { timeoutMs: 180_000 });
		// 立即抢入手动命名（竞态窗口内，llmReq.t 到 rename 返回通常 1-3s）
		const tGrab = Date.now();
		await pi.rpc.setSessionName(RACE_NAME);
		log(`3b 抢入命名：LLM request 后 ${tGrab - llmReq.t}ms 完成 set_session_name`);
		await settledP;
		// rename 终态时序（日志契约更新后）：`renamed to` 在 handler .then() 的 setSessionName
		// 之后打出——竞态命中防覆盖时提前 return 打 `skip: name exists`，renamed to 不出现。
		// 故成功防覆盖 = skip: name exists；renamed to 出现 = 标题已抢先落库（miss），交重跑
		const outcome = await pi.rpc.waitForSessionLog(/skip: name exists|renamed to "/, { timeoutMs: 45_000 });
		assert(
			outcome.message.includes("skip: name exists"),
			`3b 竞态 miss：rename 先于手动命名落库（${outcome.message}）`,
		);
		await sleep(10_500); // ≥10s 观察窗口
		assert(lastSessionInfoEntry(await pi.readSessionLines())?.name === RACE_NAME, "3b 等待 10s 后竞态命名被覆盖");
		log(`3b OK: rename 返回时 skip: name exists + 名字未被覆盖（仍为「${RACE_NAME}」）`);
	} finally {
		pi.cleanup();
	}
}

export async function runA3() {
	return runScenario("A3", async (log) => {
		await seg3aAnd3c(log);

		// 3b known-flaky：断言 miss（竞态窗口输给 rename 返回速度）重跑上限 2 次
		const MAX_RERUNS = 2;
		let lastErr = null;
		for (let attempt = 0; attempt <= MAX_RERUNS; attempt++) {
			try {
				if (attempt > 0) log(`3b 重跑（第 ${attempt}/${MAX_RERUNS} 次，known-flaky 容忍）`);
				await seg3bOnce(log);
				return;
			} catch (e) {
				lastErr = e;
				log(`3b 尝试 ${attempt + 1} 失败: ${e?.message ?? e}`);
			}
		}
		throw new HarnessError(
			"assertion",
			`3b 竞态断言在 ${MAX_RERUNS + 1} 次尝试内均 miss（超出 known-flaky 容忍，按真失败处理）: ${lastErr?.message ?? lastErr}`,
		);
	});
}

// ── 独立执行入口（node e2e/run-a3.mjs）──
runStandalone(import.meta.url, runA3);
