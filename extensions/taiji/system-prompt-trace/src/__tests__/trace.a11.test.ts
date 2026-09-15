/**
 * A11 留痕时机与去重（spec：.cw-specs/trace-ext.json；设计 D2 / plan §2.1）。
 *
 * 覆盖：
 * - 写入时机：session_start 不写（emit 早于 resources_discover 的 prompt 重建，必误报——设计 D2 校正），
 *   首个 turn_start 写 initial/resume
 * - hash 去重：相同不重写；变化写 change 且 parentVersionDiffSummary 生成
 * - SessionStartEvent.reason 原生 5 值（startup/reload/new/resume/fork）的落盘映射：
 *   initial←startup/new、resume←resume/fork/reload（设计 D2 v5 定案：fork 基线取源文件
 *   最后留痕、reload 为同 session 运行时重建，均属重开语义）
 *
 * 本文件用内存 fake env（文件系统路径的跨重启恢复归 A12）。
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSystemPromptTrace } from "../trace.js";
import type { SystemPromptTrace, TraceContext, TraceEnv } from "../trace.js";
import { isSystemPromptTraceEntryData, SYSTEM_PROMPT_CUSTOM_TYPE } from "../types.js";
import type { SystemPromptTraceEntryData, SwitchStash } from "../types.js";

// trace.ts 的 computePromptHash 已收敛为包内私有（无外部消费方）；测试本地同款实现计算期望值。
const computePromptHash = (text: string): string =>
	createHash("sha256").update(text, "utf-8").digest("hex");

const P1 = "You are a coding agent.\nFollow AGENTS.md.";
const P2 = "You are a coding agent.\nFollow AGENTS.md.\n[Available Models] glm-5.1 / ds-flash";

interface Harness {
	logic: SystemPromptTrace;
	ctx: TraceContext;
	stash: SwitchStash;
	entries: SystemPromptTraceEntryData[];
	setPrompt(text: string): void;
	/** 模拟 switchSession 后 extension runtime 重建（新闭包，共享模块级 stash） */
	newLogic(): SystemPromptTrace;
}

function makeHarness(initialPrompt: string): Harness {
	const entries: SystemPromptTraceEntryData[] = [];
	let prompt = initialPrompt;
	const stash: SwitchStash = { pending: null };
	// A11 不涉文件路径：三档基线全部 miss（直读 / fork prev 文件路径均不可读），隔离验证时机/去重/映射逻辑
	const env: TraceEnv = {
		readLastPromptFromFile: () => null,
	};
	const ctx: TraceContext = {
		getSystemPrompt: () => prompt,
		getSessionId: () => "sess-a11",
		getSessionFile: () => undefined,
		appendEntry: (customType, data) => {
			expect(customType).toBe(SYSTEM_PROMPT_CUSTOM_TYPE);
			if (!isSystemPromptTraceEntryData(data)) {
				throw new Error(`entry data shape invalid: ${JSON.stringify(data)}`);
			}
			entries.push(data);
		},
	};
	const makeLogic = (): SystemPromptTrace => createSystemPromptTrace(env, stash);
	return {
		logic: makeLogic(),
		ctx,
		stash,
		entries,
		setPrompt: (text) => {
			prompt = text;
		},
		newLogic: makeLogic,
	};
}

describe("A11 留痕时机与去重", () => {
	it("session_start 不写（emit 早于 prompt 重建）；首个 turn_start 写 initial v1（hash/fullText/charCount 齐全）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		expect(h.entries).toHaveLength(0);
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		const entry = h.entries[0];
		if (entry === undefined) throw new Error("entry missing");
		expect(entry).toMatchObject({
			version: 1,
			reason: "initial",
			fullText: P1,
			charCount: P1.length,
			hash: computePromptHash(P1),
		});
		expect(entry.parentVersionDiffSummary).toBeUndefined();
	});

	it("new 与 startup 同映射 initial（previousSessionFile 存在也不误作基线）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("new", "/old/session.jsonl", h.ctx);
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]?.reason).toBe("initial");
		expect(h.entries[0]?.version).toBe(1);
	});

	it("resume 无任何基线时兜底必写一条 reason=resume", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("resume", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]).toMatchObject({ version: 1, reason: "resume" });
	});

	it("hash 相同的后续 turn_start 不重写", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx);
		h.logic.onTurnStart(h.ctx);
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
	});

	it("prompt 变化写 change v2 且 parentVersionDiffSummary 生成", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx);
		h.setPrompt(P2);
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(2);
		const entry = h.entries[1];
		if (entry === undefined) throw new Error("entry missing");
		expect(entry).toMatchObject({
			version: 2,
			reason: "change",
			hash: computePromptHash(P2),
			charCount: P2.length,
		});
		expect(entry.parentVersionDiffSummary).toContain("+1 -0 lines");
		expect(entry.parentVersionDiffSummary).toContain("+ [Available Models]");
	});

	it("prompt 变回旧值再写 change v3（时间线保留真实历史，只对当前版本去重）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1 initial (P1)
		h.setPrompt(P2);
		h.logic.onTurnStart(h.ctx); // v2 change (P2)
		h.setPrompt(P1);
		h.logic.onTurnStart(h.ctx); // v3 change (P1)
		expect(h.entries).toHaveLength(3);
		expect(h.entries[2]).toMatchObject({ version: 3, reason: "change", hash: computePromptHash(P1) });
	});

	describe("reason 5 值映射（设计 D2 v5 定案）", () => {
		it("定案映射：startup/new → initial；resume → resume", () => {
			const hStartup = makeHarness(P1);
			hStartup.logic.onSessionStart("startup", undefined, hStartup.ctx);
			hStartup.logic.onTurnStart(hStartup.ctx);
			const hNew = makeHarness(P1);
			hNew.logic.onSessionStart("new", undefined, hNew.ctx);
			hNew.logic.onTurnStart(hNew.ctx);
			const hResume = makeHarness(P1);
			hResume.logic.onSessionStart("resume", undefined, hResume.ctx);
			hResume.logic.onTurnStart(hResume.ctx);
			expect(hStartup.entries[0]?.reason).toBe("initial");
			expect(hNew.entries[0]?.reason).toBe("initial");
			expect(hResume.entries[0]?.reason).toBe("resume");
		});

		// 定案（设计 D2 v5，M0 探针回炉后）：fork/reload → resume。fork 基线取源文件最后留痕
		// （previousSessionFile 缺失/不可读 → null 走本映射兜底）；reload 是同 session 的
		// extension 运行时重建——两者语义上都是「重开」而非「首建」。
		it("定案映射：fork/reload → resume（previousSessionFile 存在但 env 全 miss 时同样兜底）", () => {
			const hFork = makeHarness(P1);
			hFork.logic.onSessionStart("fork", "/prev/session.jsonl", hFork.ctx);
			hFork.logic.onTurnStart(hFork.ctx);
			const hReload = makeHarness(P1);
			hReload.logic.onSessionStart("reload", undefined, hReload.ctx);
			hReload.logic.onTurnStart(hReload.ctx);
			expect(hFork.entries[0]?.reason).toBe("resume");
			expect(hReload.entries[0]?.reason).toBe("resume");
		});
	});
});
