/**
 * index.ts wiring SDK 契约测试（Gate-1.6 覆盖缺口：wiring 层 0%；round1 review「wiring 层无 SDK 契约测试」）。
 *
 * mock 边界（对齐 subagent-workflow index 测试先例）：
 * - baseline.ts 走真实 fs（previousSessionFile / getSessionFile 直读路径用真实临时文件）
 * - pi 用 Proxy 假体：捕获 on 注册的 handler 与 appendEntry 落点；handler 以 SDK 双参契约
 *   (event, ctx) 驱动；ctx 只需 index.ts 实际消费的字段（getSystemPrompt + sessionManager 的
 *   getSessionId / getSessionFile）
 * - @zhushanwen/pi-extension-logger mock 三导出（getLogger / createLogger / setPiHandle），
 *   setPiHandle 捕获 factory 注入（D3 接线契约），logger 方法收集供吞错断言
 * - switchStash 是模块级单例：beforeEach vi.resetModules 隔离用例；同 it 内二次 dynamic import
 *   模拟「switch 重建 extension runtime + 同进程模块缓存延续」的真实链路
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isSystemPromptTraceEntryData, SYSTEM_PROMPT_CUSTOM_TYPE } from "../types.js";
import type { SystemPromptTraceEntryData } from "../types.js";

// trace.ts 的 computePromptHash 已收敛为包内私有（无外部消费方）；测试本地同款实现计算期望值。
const computePromptHash = (text: string): string =>
	createHash("sha256").update(text, "utf-8").digest("hex");

const P1 = "wiring prompt\nline-1";
const P2 = "wiring prompt\nline-1\nline-2-added";

const { loggerMock, setPiHandleMock } = vi.hoisted(() => {
	const mock = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
	return { loggerMock: mock, setPiHandleMock: vi.fn() };
})
vi.mock("@zhushanwen/pi-extension-logger", () => ({
	getLogger: () => loggerMock,
	createLogger: () => loggerMock,
	setPiHandle: setPiHandleMock,
}))

type RecordedHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface RecordedEntry {
	customType: string;
	data: unknown;
}

interface WiringHarness {
	pi: ExtensionAPI;
	handlers: Map<string, RecordedHandler>;
	entries: RecordedEntry[];
}

/** Proxy 假体 pi：捕获 on 注册的 handler 与 appendEntry 落点（其余成员 no-op）。 */
function createWiringHarness(): WiringHarness {
	const handlers = new Map<string, RecordedHandler>();
	const entries: RecordedEntry[] = [];
	const pi = new Proxy<ExtensionAPI>({} as ExtensionAPI, {
		get(_target: unknown, prop: string | symbol): unknown {
			if (prop === "on") {
				return (event: string, handler: RecordedHandler): void => {
					handlers.set(event, handler);
				};
			}
			if (prop === "appendEntry") {
				return (customType: string, data?: unknown): void => {
					entries.push({ customType, data });
				};
			}
			return (): void => undefined;
		},
	});
	return { pi, handlers, entries };
}

/** ctx 最小形状（index.ts 实际消费：getSystemPrompt + sessionManager 的 getSessionId/getSessionFile；cwd 是 SDK 契约字段）。
 * getSessionFile 缺省 undefined（新 session 未落盘）；需要指向真实文件时传 getSessionFileOverride。 */
function createCtx(
	getPrompt: () => string,
	sessionId: string,
	getSessionFileOverride?: () => string | undefined,
): Record<string, unknown> {
	return {
		cwd: "/home/user/project",
		getSystemPrompt: getPrompt,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: getSessionFileOverride ?? ((): string | undefined => undefined),
		},
	};
}

/** 以 SDK 双参契约 (event, ctx) 驱动已注册 handler。 */
async function emit(h: WiringHarness, event: string, payload: unknown, ctx: unknown): Promise<void> {
	const handler = h.handlers.get(event);
	if (handler === undefined) throw new Error(`handler for "${event}" not registered`);
	await handler(payload, ctx);
}

/** 模拟 pi 落盘形状的留痕 entry（供 previousSessionFile / targetSessionFile 直读路径）。 */
function writeSessionEntry(filePath: string, data: SystemPromptTraceEntryData): void {
	writeFileSync(
		filePath,
		JSON.stringify({ type: "custom", customType: SYSTEM_PROMPT_CUSTOM_TYPE, data }) + "\n",
	);
}

/** resetModules 后重新加载 index.ts；同 it 内二次调用拿同一模块实例（switchStash 共享）。 */
async function loadExtension(): Promise<(pi: ExtensionAPI) => void> {
	const mod = await import("../index.js");
	return mod.default;
}

/** 取第 index 条 entry data（运行时 guard，拒绝 wiring 产出畸形 entry）。 */
function entryData(h: WiringHarness, index: number): SystemPromptTraceEntryData {
	const data = h.entries[index]?.data;
	if (!isSystemPromptTraceEntryData(data)) {
		throw new Error(`entry data shape invalid: ${JSON.stringify(data)}`);
	}
	return data;
}

let rootDir = "";

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), "spt-wiring-"));
	vi.resetModules();
});

afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("index.ts wiring SDK 契约", () => {
	it("注册恰好三个事件 handler（session_start / session_before_switch / turn_start）", async () => {
		const ext = await loadExtension();
		const h = createWiringHarness();
		ext(h.pi);
		expect([...h.handlers.keys()].sort()).toEqual([
			"session_before_switch",
			"session_start",
			"turn_start",
		]);
	});

	it("factory 调用 setPiHandle(pi) 注入日志通道（缺注入时 logger.error 的 appendEntry 通道是 no-op，生产完全静默）", async () => {
		const ext = await loadExtension();
		const h = createWiringHarness();
		// hoisted mock 不随 resetModules 清调用历史，先清再驱动，隔离其他用例的累计调用
		setPiHandleMock.mockClear();
		ext(h.pi);
		expect(setPiHandleMock).toHaveBeenCalledTimes(1);
		// pi 是 Proxy 假体，深度相等比较不可靠，用引用相等断言
		const injected = setPiHandleMock.mock.calls[0]?.[0];
		expect(injected).toBe(h.pi);
	});

	it("startup（无 previousSessionFile、session 未落盘）→ 首 turn 写 initial v1（appendEntry 形状）；prompt 变化写 change v2 带 diff 摘要", async () => {
		const ext = await loadExtension();
		const h = createWiringHarness();
		ext(h.pi);
		let prompt = P1;
		const ctx = createCtx(() => prompt, "sess-w1");

		await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await emit(h, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]?.customType).toBe(SYSTEM_PROMPT_CUSTOM_TYPE);
		expect(entryData(h, 0)).toMatchObject({
			version: 1,
			reason: "initial",
			fullText: P1,
			charCount: P1.length,
			hash: computePromptHash(P1),
		});
		// 自持久化基线小文件已随 persisted 子系统删除（设计目标 2）：无 agentDir 落盘面，仅 session JSONL

		prompt = P2;
		await emit(h, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 }, ctx);
		expect(h.entries).toHaveLength(2);
		const change = entryData(h, 1);
		expect(change).toMatchObject({ version: 2, reason: "change", hash: computePromptHash(P2) });
		expect(change.parentVersionDiffSummary).toContain("+1 -0 lines");
	});

	it("fork（previousSessionFile 为 string）→ 直读该文件最后留痕作基线（D2 v5 定案）；hash 未变不写", async () => {
		const prevFile = join(rootDir, "prev-session.jsonl");
		writeSessionEntry(prevFile, {
			version: 3,
			hash: computePromptHash(P1),
			reason: "change",
			fullText: P1,
			charCount: P1.length,
		});

		const ext = await loadExtension();
		const h = createWiringHarness();
		ext(h.pi);
		const ctx = createCtx(() => P1, "sess-w-fork");
		await emit(
			h,
			"session_start",
			{ type: "session_start", reason: "fork", previousSessionFile: prevFile },
			ctx,
		);
		await emit(h, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

		expect(h.entries).toHaveLength(0);
	});

	it("fork 的 previousSessionFile 三态防御：字段缺失 / 源文件未落盘 / 读取失败 → 基线 null → resume v1 兜底", async () => {
		const ext = await loadExtension();
		const h = createWiringHarness();
		ext(h.pi);
		// 态 1 判据强化（R5-F2）：getSessionFile() 可读且带留痕（version 5，hash = P1）——
		// 若 fork 缺失 previousSessionFile 时 fall-through 直读档，基线命中 P1 → 首 turn
		// 不写 entry（下方三 entry 断言即失败）；D2 语义（fork 只认 previousSessionFile，
		// 缺失即 null，不落直读档）下必写 resume v1。
		const readableFile = join(rootDir, "readable-session.jsonl");
		writeSessionEntry(readableFile, {
			version: 5,
			hash: computePromptHash(P1),
			reason: "change",
			fullText: P1,
			charCount: P1.length,
		});
		const ctxFallbackReadable = createCtx(() => P1, "sess-w-fork-def", () => readableFile);
		const ctx = createCtx(() => P1, "sess-w-fork-def");

		// 态 1：字段缺失（in-memory fork 且源 sessionFile 为 undefined）——即便
		// getSessionFile() 可读带留痕，fork 档也不落直读档
		await emit(h, "session_start", { type: "session_start", reason: "fork" }, ctxFallbackReadable);
		await emit(h, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctxFallbackReadable);
		// 态 2：源文件未落盘（源会话尚无 assistant 即 fork，首条 assistant 前 pi _persist 不落盘）
		await emit(
			h,
			"session_start",
			{ type: "session_start", reason: "fork", previousSessionFile: join(rootDir, "not-flushed.jsonl") },
			ctx,
		);
		await emit(h, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 }, ctx);
		// 态 3：读取失败（路径指向目录，readFileSync EISDIR）
		await emit(
			h,
			"session_start",
			{ type: "session_start", reason: "fork", previousSessionFile: rootDir },
			ctx,
		);
		await emit(h, "turn_start", { type: "turn_start", turnIndex: 2, timestamp: 0 }, ctx);

		expect(h.entries).toHaveLength(3);
		expect(entryData(h, 0)).toMatchObject({ version: 1, reason: "resume", hash: computePromptHash(P1) });
		expect(entryData(h, 1)).toMatchObject({ version: 1, reason: "resume" });
		expect(entryData(h, 2)).toMatchObject({ version: 1, reason: "resume" });
	});

	it("session_before_switch（targetSessionFile 为 string）→ 模块级 stash 跨 runtime 传递；新 runtime resume + hash 未变 → 不写", async () => {
		const targetFile = join(rootDir, "target-session.jsonl");
		writeSessionEntry(targetFile, {
			version: 2,
			hash: computePromptHash(P1),
			reason: "resume",
			fullText: P1,
			charCount: P1.length,
		});

		// 旧 runtime：before_switch 直读目标文件 → stash（该 handler 只消费 event）
		const oldExt = await loadExtension();
		const oldH = createWiringHarness();
		oldExt(oldH.pi);
		await emit(
			oldH,
			"session_before_switch",
			{ type: "session_before_switch", reason: "resume", targetSessionFile: targetFile },
			undefined,
		);

		// switch 重建 runtime：同进程模块缓存延续 → switchStash 传递基线
		const newExt = await loadExtension();
		const newH = createWiringHarness();
		newExt(newH.pi);
		const ctx = createCtx(() => P1, "sess-w-switch");
		await emit(newH, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await emit(newH, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
		expect(newH.entries).toHaveLength(0);
	});

	it("stash 基线 hash 与当前不同 → 新 runtime 写 resume 续接版本，diff 摘要 parent 全文来自目标文件", async () => {
		const targetFile = join(rootDir, "target-session.jsonl");
		writeSessionEntry(targetFile, {
			version: 2,
			hash: computePromptHash(P1),
			reason: "resume",
			fullText: P1,
			charCount: P1.length,
		});

		const oldExt = await loadExtension();
		const oldH = createWiringHarness();
		oldExt(oldH.pi);
		await emit(
			oldH,
			"session_before_switch",
			{ type: "session_before_switch", reason: "resume", targetSessionFile: targetFile },
			undefined,
		);

		const newExt = await loadExtension();
		const newH = createWiringHarness();
		newExt(newH.pi);
		const ctx = createCtx(() => P2, "sess-w-switch2");
		await emit(newH, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await emit(newH, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

		expect(newH.entries).toHaveLength(1);
		const entry = entryData(newH, 0);
		expect(entry).toMatchObject({ version: 3, reason: "resume", hash: computePromptHash(P2) });
		expect(entry.parentVersionDiffSummary).toContain("+1 -0 lines");
	});

	it("session_before_switch 无 targetSessionFile → 不读文件；resume 兜底必写 v1", async () => {
		const ext = await loadExtension();
		const h = createWiringHarness();
		ext(h.pi);
		await emit(h, "session_before_switch", { type: "session_before_switch", reason: "new" }, undefined);
		const ctx = createCtx(() => P1, "sess-w6");
		await emit(h, "session_start", { type: "session_start", reason: "resume" }, ctx);
		await emit(h, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);

		expect(h.entries).toHaveLength(1);
		expect(entryData(h, 0)).toMatchObject({
			version: 1,
			reason: "resume",
			hash: computePromptHash(P1),
		});
	});

	it("getSystemPrompt 抛错 → handler 吞掉不写 entry（留痕是诊断旁路，不影响 agent 主流程）", async () => {
		const ext = await loadExtension();
		const h = createWiringHarness();
		ext(h.pi);
		const boomCtx = createCtx(() => {
			throw new Error("prompt boom");
		}, "sess-w7");

		loggerMock.error.mockClear();
		try {
			await emit(h, "session_start", { type: "session_start", reason: "startup" }, boomCtx);
			await emit(h, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, boomCtx);
		} finally {
			// no-op: cleanup handled after assertions
		}
		expect(h.entries).toHaveLength(0);
		expect(loggerMock.error).toHaveBeenCalledTimes(1);
		loggerMock.error.mockClear();
	});
});
