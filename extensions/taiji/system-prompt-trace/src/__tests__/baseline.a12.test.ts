/**
 * A12 hash 基线跨重启恢复（spec：.cw-specs/trace-ext.json；设计 D2 复审 N2 / plan §2.1）。
 *
 * 三档（优先级从高到低，口径同 trace.ts onSessionStart，设计 D1/D2 v5）：
 * 1. 进程内 resume：session_before_switch.targetSessionFile 直读目标文件取上一版 hash
 *    （switch 重建 extension runtime，基线经模块级 stash 传递——用「新闭包 + 共享 stash」模拟）
 * 2. fork：previousSessionFile 直读源 session 文件最后留痕（设计 D2 v5 定案——常态 /fork
 *    时点 fork 新文件未落盘，直读不可靠）
 * 3. 直读档：ctx.getSessionFile() 直读当前 session 文件（app 重启直 spawn resume / reload——
 *    此链路无 switch 事件、reason=startup；文件未落盘 / 无留痕 → null）
 * 4. 兜底：三档都读不到 → 任意 reason 必写一条（startup/new→initial，resume/fork/reload→resume）
 *
 * 用真实临时目录 + 真实 fs 函数（非 mock 投影）；appendEntry 同步模拟 pi appendCustomEntry
 * 的落盘形状（session-manager.ts）。
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLastPromptFromSessionFile } from "../baseline.js";
import { createSystemPromptTrace } from "../trace.js";
import type { SystemPromptTrace, TraceContext, TraceEnv } from "../trace.js";
import { isSystemPromptTraceEntryData, SYSTEM_PROMPT_CUSTOM_TYPE } from "../types.js";
import type { SystemPromptTraceEntryData, SwitchStash } from "../types.js";

// trace.ts 的 computePromptHash 已收敛为包内私有（无外部消费方）；测试本地同款实现计算期望值。
const computePromptHash = (text: string): string =>
	createHash("sha256").update(text, "utf-8").digest("hex");

const P1 = "base prompt\nline-1";
const P2 = "base prompt\nline-1\nline-2-added";

interface FsHarness {
	logic: SystemPromptTrace;
	ctx: TraceContext;
	stash: SwitchStash;
	sessionFile: string;
	entries: SystemPromptTraceEntryData[];
	setPrompt(text: string): void;
	/** 真实链路中 new/fork 的新 session 有全新 id 与全新（未落盘的）文件；切换 ctx 指向并返回新文件路径 */
	openNewSession(id: string): string;
	/** 模拟 extension runtime 重建（switchSession teardown + createRuntime 重跑 factory：新闭包，共享 stash 与文件） */
	newLogic(): SystemPromptTrace;
	/** 读当前 session 文件的非空行（模拟 pi 落盘结果核对） */
	sessionLines(): string[];
}

let rootDir = "";

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), "spt-a12-"));
});

afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeHarness(initialPrompt: string, opts?: { noSessionFile?: boolean }): FsHarness {
	const dir = join(rootDir, `sess-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const sessionFile = join(dir, "session.jsonl");
	const entries: SystemPromptTraceEntryData[] = [];
	let prompt = initialPrompt;
	let sessionId = "sess-a12";
	// 真实链路中 getSessionFile() 指向当前 session 的文件（首条 assistant 前 pi 未 flush，
	// 文件可能不存在——appendEntry 的 append 模式会自建，与 pi 的延迟落盘行为等价可接受）
	let currentSessionFile: string | undefined = opts?.noSessionFile === true ? undefined : sessionFile;
	const stash: SwitchStash = { pending: null };

	const env: TraceEnv = {
		readLastPromptFromFile: (filePath) => readLastPromptFromSessionFile(filePath),
	};

	const ctx: TraceContext = {
		getSystemPrompt: () => prompt,
		getSessionId: () => sessionId,
		getSessionFile: () => currentSessionFile,
		appendEntry: (customType, data) => {
			if (!isSystemPromptTraceEntryData(data)) {
				throw new Error(`entry data shape invalid: ${JSON.stringify(data)}`);
			}
			// 纯内存 session（getSessionFile() undefined，pi 首条 assistant 前 _persist 未 flush）：
			// entry 只进内存，不落文件——与 pi appendCustomEntry 内存先行、延迟落盘的行为等价
			if (currentSessionFile !== undefined) {
				// 模拟 pi appendCustomEntry 落盘形状（session-manager.ts）
				appendFileSync(
					currentSessionFile,
					JSON.stringify({
						type: "custom",
						customType,
						data,
						id: `e${entries.length + 1}`,
						parentId: null,
						timestamp: new Date().toISOString(),
					}) + "\n",
				);
			}
			entries.push(data);
		},
	};

	const makeLogic = (): SystemPromptTrace => createSystemPromptTrace(env, stash);

	return {
		logic: makeLogic(),
		ctx,
		stash,
		sessionFile,
		entries,
		setPrompt: (text) => {
			prompt = text;
		},
		openNewSession: (id) => {
			const file = join(dir, `${id}.jsonl`);
			sessionId = id;
			currentSessionFile = file;
			return file;
		},
		newLogic: makeLogic,
		sessionLines: () => {
			if (currentSessionFile === undefined) return [];
			try {
				return readFileSync(currentSessionFile, "utf-8").split("\n").filter((l) => l.trim() !== "");
			} catch {
				return [];
			}
		},
	};
}

describe("A12 hash 基线跨重启恢复", () => {
	it("路径 1（进程内 resume）：targetSessionFile 直读命中且 hash 未变 → 不重写（跨 switch 去重）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1 initial
		expect(h.entries).toHaveLength(1);

		// 旧 runtime 在 before_switch 直读目标文件 → stash
		h.logic.onSessionBeforeSwitch("resume", h.sessionFile);
		expect(h.stash.pending).toMatchObject({ hash: computePromptHash(P1), version: 1 });

		// 新 runtime（switch 后重建）消费 stash；hash 相同 → 不写
		const logic2 = h.newLogic();
		logic2.onSessionStart("resume", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.sessionLines()).toHaveLength(1);
	});

	it("路径 1（进程内 resume）：基线 hash 变化 → 写 resume v2，diff 摘要的 parent 全文来自目标文件", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1 initial
		h.logic.onSessionBeforeSwitch("resume", h.sessionFile);

		h.setPrompt(P2);
		const logic2 = h.newLogic();
		logic2.onSessionStart("resume", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(2);
		expect(h.entries[1]).toMatchObject({ version: 2, reason: "resume", hash: computePromptHash(P2) });
		expect(typeof h.entries[1]?.parentVersionDiffSummary).toBe("string");
		expect(h.entries[1]?.parentVersionDiffSummary).toContain("+1 -0 lines");
	});

	it("直读档（app 重启直 spawn resume）：getSessionFile() 目标文件命中且 hash 未变 → 不写（reason=startup、无 switch 事件）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1 initial（落 sessionFile）
		expect(h.entries).toHaveLength(1);

		// app 重启直启：全新闭包 + 空 stash（无 before_switch 可用）；getSessionFile() 指向同一文件
		//（pi 直启 resume 时 sessionManager open 的目标文件），直读最后留痕命中
		const logic2 = h.newLogic();
		logic2.onSessionStart("startup", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.sessionLines()).toHaveLength(1);
	});

	it("直读档（app 重启直 spawn resume）：基线命中但 prompt 已变 → 写 resume v2，diff 摘要来自直读留痕 fullText（persisted 时代的数据层缺口已修复）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1

		h.setPrompt(P2);
		const logic2 = h.newLogic();
		logic2.onSessionStart("startup", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(2);
		// 基线存在 → 该 session 已有历史版本 → resume（而非 initial 重新计数）
		expect(h.entries[1]).toMatchObject({ version: 2, reason: "resume", hash: computePromptHash(P2) });
		// 直读档基线含 fullText → parentVersionDiffSummary 不再缺省（F1 修复）
		expect(h.entries[1]?.parentVersionDiffSummary).toContain("+1 -0 lines");
	});

	it("路径 4（兜底）：三档基线都读不到（getSessionFile 未落盘返回 undefined）且 reason=resume → 必写一条", () => {
		const h = makeHarness(P1, { noSessionFile: true });
		h.logic.onSessionStart("resume", undefined, h.ctx); // 无 stash、getSessionFile() undefined
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]).toMatchObject({ version: 1, reason: "resume" });
	});

	it("直读档：session 文件损坏 → 视为无基线，resume 必写一条", () => {
		const h = makeHarness(P1);
		writeFileSync(h.sessionFile, "{ not valid json\n");
		h.logic.onSessionStart("resume", undefined, h.ctx); // 无 stash；直读损坏行全部跳过 → null
		h.logic.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]).toMatchObject({ version: 1, reason: "resume" });
	});

	it("目标文件无留痕 entry（旧 session 先于本 extension）→ 无基线 → resume 必写 v1", () => {
		const h = makeHarness(P1);
		appendFileSync(h.sessionFile, JSON.stringify({ type: "message", message: { role: "user" } }) + "\n");
		h.logic.onSessionBeforeSwitch("resume", h.sessionFile);
		expect(h.stash.pending).toBeNull();

		const logic2 = h.newLogic();
		logic2.onSessionStart("resume", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]).toMatchObject({ version: 1, reason: "resume" });
	});

	it("cancelled switch 的 stash 残留不污染后续 new session（消费但不采用）", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1
		h.logic.onSessionBeforeSwitch("resume", h.sessionFile); // switch 随后被取消，无 session_start 消费
		expect(h.stash.pending).not.toBeNull();

		// 之后用户开了全新 session：新 sessionId + 全新未落盘文件 → stash 被消费但不采用，
		// 直读档 miss（新文件不存在），从 v1 重新计数
		const logic2 = h.newLogic();
		h.openNewSession("sess-a12-new");
		logic2.onSessionStart("new", undefined, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(2);
		expect(h.entries[1]).toMatchObject({ version: 1, reason: "initial" });
	});

	it("fork（设计 D2 v5 定案）：previousSessionFile 直读源文件最后留痕作基线，hash 未变不写", () => {
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1（落进 h.sessionFile）

		// pi 原生 fork 不经 session_before_switch：基线来自 session_start.previousSessionFile；
		// fork 新 session 是全新 id 与未落盘的新文件（常态 /fork 时点新文件不 flush，M0 探针实证）
		h.openNewSession("sess-a12-fork");
		const logic2 = h.newLogic();
		logic2.onSessionStart("fork", h.sessionFile, h.ctx);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(1);
	});

	it("fork（V6 第二步）：fork 基线命中确立 current 后配置回变 → 写 change，version 自源留痕续接 +1，diff 相对源留痕 fullText", () => {
		// 源 session 预置两条留痕：v1（配置 A prompt）→ v2（配置 B prompt）
		const h = makeHarness(P1);
		h.logic.onSessionStart("startup", undefined, h.ctx);
		h.logic.onTurnStart(h.ctx); // v1 initial（A）
		h.setPrompt(P2);
		h.logic.onTurnStart(h.ctx); // v2 change（B）
		expect(h.entries).toHaveLength(2);

		// fork 新 session：新闭包 + 空 stash → fork 档直读源文件最后留痕 v2 作基线
		h.openNewSession("sess-a12-fork-change");
		const logic2 = h.newLogic();
		logic2.onSessionStart("fork", h.sessionFile, h.ctx);
		logic2.onTurnStart(h.ctx); // prompt 仍 B：hash 命中源留痕 → 不写，仅确立 current（沿用上一用例语义）
		expect(h.entries).toHaveLength(2);
		expect(h.sessionLines()).toHaveLength(0); // fork 新文件零留痕

		// 配置回变（B → A）：current 已由 fork 基线命中确立 → 后续 turn 变化走 change 分支
		//（而非 resume——resume 仅用于 session_start 后基线重确立的首 turn）
		h.setPrompt(P1);
		logic2.onTurnStart(h.ctx);
		expect(h.entries).toHaveLength(3);
		expect(h.entries[2]).toMatchObject({
			version: 3, // 源最后留痕 v2 + 1
			reason: "change", // 非 resume / 非 initial
			hash: computePromptHash(P1),
			fullText: P1,
		});
		// diff 相对源留痕 v2 的 fullText（B）：P2 → P1 为删 1 行（"+N -M lines" 头形态）
		expect(h.entries[2]?.parentVersionDiffSummary).toContain("+0 -1 lines");
		// fork 新文件恰好落盘这一条留痕
		expect(h.sessionLines()).toHaveLength(1);
	});

	it("readLastPromptFromSessionFile：损坏行跳过、取最后一条有效留痕；文件缺失 → null", () => {
		const scanDir = mkdtempSync(join(rootDir, "scan-"));
		const file = join(scanDir, "s.jsonl");
		const entryV1 = {
			type: "custom",
			customType: SYSTEM_PROMPT_CUSTOM_TYPE,
			data: { version: 1, hash: "hash-v1", reason: "initial", fullText: "old text", charCount: 8 },
		};
		const entryV2 = {
			type: "custom",
			customType: SYSTEM_PROMPT_CUSTOM_TYPE,
			data: { version: 2, hash: "hash-v2", reason: "change", fullText: "new text", charCount: 8 },
		};
		writeFileSync(file, [JSON.stringify(entryV1), "{ broken json", JSON.stringify(entryV2), ""].join("\n"));
		expect(readLastPromptFromSessionFile(file)).toMatchObject({
			hash: "hash-v2",
			version: 2,
			fullText: "new text",
		});
		expect(readLastPromptFromSessionFile(join(scanDir, "missing.jsonl"))).toBeNull();
	});
});
