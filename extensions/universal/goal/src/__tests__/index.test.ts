/**
 * index.ts 测试 — 工厂入口 + 跨扩展 API（goalInit slot）
 *
 * 覆盖 T1.8 (NFR-AC-8)：goalInit 签名 (objective, budget, ctx, slug?, successCriteria?)，
 * 结构上无法接收 tasks（task CRUD 已删除，D-16/FR-4 双轨消除）。active 守卫由 service.test.ts 覆盖。
 *
 * 用最小 fake pi + fake ctx 实例化 goalExtension 工厂，再从 globalThis slot 读取 goalInit——
 * mock 形态与真实通道同构（goal-bridge-cross-extension.md §3.4：桥的元教训是 mock 世界
 * 构造「共享 pi 对象」掩盖了真实世界的 per-extension 隔离，两侧测试一律走 slot）。
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { handleSessionStart } from "../adapters/event-handlers/session-start";
import goalExtension, { GOAL_INIT_SLOT_KEY, type GoalInitFn } from "../index";
import { contextInjectionPrompt } from "../projection/prompts";
import { createGoalSession } from "../session";

/** 每用例后清 slot，防跨用例 globalThis 泄漏（设计 §3.4：teardown 两侧通用） */
afterEach(() => {
	Reflect.set(globalThis, GOAL_INIT_SLOT_KEY, undefined);
});

/** 从 globalThis slot 读取 goalInit（与 plan 侧 compact.ts 的消费形态一致） */
function readGoalInit(): GoalInitFn | undefined {
	const fn = Reflect.get(globalThis, GOAL_INIT_SLOT_KEY);
	return typeof fn === "function" ? (fn as GoalInitFn) : undefined;
}

// ── Minimal fake pi / ctx ─────────────────────────────

interface FactoryFixture {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	states: unknown[];
	history: unknown[];
	sendUser: unknown[];
	commands: Record<string, { description?: string }>;
}

/** 工厂所需的最小 pi：registerCommand/registerTool/on/registerMessageRenderer + appendEntry/sendMessage/sendUserMessage */
function makeFactoryFixture(): FactoryFixture {
	const states: unknown[] = [];
	const history: unknown[] = [];
	const sendUser: unknown[] = [];
	const commands: Record<string, { description?: string }> = {};
	const pi = {
		registerCommand: (name: string, opts: { description?: string }) => {
			commands[name] = { description: opts.description };
		},
		registerTool: () => {},
		on: () => {},
		registerMessageRenderer: () => {},
		appendEntry(customType: string, data?: unknown): void {
			if (customType === "goal-history") history.push(data);
			else states.push(data);
		},
		sendMessage: () => {},
		sendUserMessage(content: unknown): void {
			sendUser.push(content);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		getContextUsage: () => null,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, states, history, sendUser, commands };
}

// ── goalInit slot（NFR-AC-8 / T1.8）──────────────────

describe("goalInit slot（NFR-AC-8 / T1.8）", () => {
	it("工厂实例化后 slot 内 goalInit 存在；正常调用 → 创建 goal（返回 true + 持久化 state）", () => {
		const { pi, ctx, states } = makeFactoryFixture();
		goalExtension(pi);
		const goalInit = readGoalInit();
		expect(typeof goalInit).toBe("function");
		const ok = goalInit!("build feature X", undefined, ctx);
		expect(ok).toBe(true);
		expect(states).toHaveLength(1); // appendState 调用
		const persisted = states[0] as { objective?: string };
		expect(persisted.objective).toBe("build feature X");
	});

	it("U22b: 5 参签名（slug + successCriteria string[]）→ true 且 state.successCriteria 深等于入参", () => {
		const { pi, ctx, states } = makeFactoryFixture();
		goalExtension(pi);
		// GoalInitFn 签名防漂移：successCriteria 为 string[]（数组入参，非旧 string）
		const ok = readGoalInit()!("objective", undefined, ctx, "slug", ["cond A", "cond B"]);
		expect(ok).toBe(true);
		// appendState 持久化的 state 深透传 successCriteria 数组
		const persisted = states[0] as { slug?: string; successCriteria?: string[] };
		expect(persisted.slug).toBe("slug");
		expect(persisted.successCriteria).toEqual(["cond A", "cond B"]);
	});

	it("ctx 缺失 → 返回 false（创建失败，不 throw）", () => {
		// FR-4.2/D-16: ctx 必填
		const { pi } = makeFactoryFixture();
		goalExtension(pi);
		const init = readGoalInit()!;
		expect(() => init("obj", undefined, undefined)).not.toThrow();
		expect(init("obj", undefined, undefined)).toBe(false);
	});
});

// ── /goal 命令注册（TC9）─────────────────────────

describe("/goal 命令注册（TC9）", () => {
	it("goal 命令已注册且有 description", () => {
		const { pi, commands } = makeFactoryFixture();
		goalExtension(pi);
		expect(commands["goal"]).toBeDefined();
		expect(commands["goal"]?.description?.length).toBeGreaterThan(0);
	});
});

// ── E1 全链路集成（goal-criteria-array/plan.md E1）─────

/** registerTool 捕获的最小 tool 形状（只需 name + execute） */
interface CapturedGoalTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: { action: string; goalId: string; status: string; slug?: string };
	}>;
}

/**
 * JSONL session 文件里的 entry 形状——对齐 pi session entry 契约
 * （session.ts isGoalStateEntry 读 type "custom" + customType 字段）。
 */
interface SessionFileEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * E1 fixture：在 makeFactoryFixture 模式上增加两点——
 * ① registerTool 捕获注册的 tool（execute 可直接调用）；
 * ② appendEntry 写真实 JSONL 临时文件（模拟 pi session 落盘：每 entry 一行 JSON）。
 *
 * @param sessionFile appendEntry 的落盘路径
 * @param entries sessionManager.getEntries 返回值（重载场景传入从文件读回的 entry）
 */
function makeE1Fixture(
	sessionFile: string,
	entries: SessionFileEntry[] = [],
): { pi: ExtensionAPI; ctx: ExtensionContext; tools: Record<string, CapturedGoalTool> } {
	const tools: Record<string, CapturedGoalTool> = {};
	const pi = {
		registerCommand: () => {},
		registerTool: (tool: CapturedGoalTool) => {
			tools[tool.name] = tool;
		},
		on: () => {},
		registerMessageRenderer: () => {},
		// 落盘语义对齐 pi：appendEntry(customType, data) → session 文件追加一行 {type:"custom",customType,data}
		appendEntry(customType: string, data?: unknown): void {
			appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType, data })}\n`, "utf-8");
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		signal: { aborted: false } as AbortSignal,
		getContextUsage: () => null,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => entries, getBranch: () => undefined },
	} as unknown as ExtensionContext;

	return { pi, ctx, tools };
}

/** 从 JSONL session 文件读回全部 entry（模拟进程重启后读盘） */
function readSessionEntries(sessionFile: string): SessionFileEntry[] {
	const lines = readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean);
	expect(lines.length).toBeGreaterThan(0);
	return lines.map((line) => JSON.parse(line) as SessionFileEntry);
}

describe("E1 全链路集成：goal_control create 数组 → 落盘 → 重载 → prompt 注入", () => {
	it("create successCriteria string[] 经 JSONL 持久化后重载，仍深等于原数组并注入编号列表", async () => {
		const dir = mkdtempSync(join(tmpdir(), "goal-e1-"));
		const sessionFile = join(dir, "session.jsonl");
		try {
			// 1. 工厂实例化 → goal_control tool 已注册
			const { pi, ctx, tools } = makeE1Fixture(sessionFile);
			goalExtension(pi);
			const tool = tools["goal_control"];
			expect(tool).toBeDefined();

			// 2. execute goal_control create（successCriteria 数组）→ 成功
			const result = await tool!.execute(
				"e2e-call-1",
				{
					action: "create",
					objective: "ship successCriteria array end to end",
					successCriteria: ["e2e cond a", "e2e cond b"],
				},
				undefined,
				undefined,
				ctx,
			);
			expect(result.details.action).toBe("create");
			expect(result.details.status).toBe("active");

			// 3. 落盘 session 文件读回 → goal-state entry 的 successCriteria 为数组且深等于原值
			const entries = readSessionEntries(sessionFile);
			const stateEntries = entries.filter((e) => e.type === "custom" && e.customType === "goal-state");
			expect(stateEntries.length).toBeGreaterThan(0);
			const persisted = stateEntries[stateEntries.length - 1]!.data as Record<string, unknown>;
			expect(Array.isArray(persisted.successCriteria)).toBe(true);
			expect(persisted.successCriteria).toEqual(["e2e cond a", "e2e cond b"]);

			// 4. 新 session/persistence 上下文重载（生产 session_start 路径）→ 深等于原数组
			const reload = makeE1Fixture(join(dir, "reload-out.jsonl"), entries);
			const reloaded = createGoalSession();
			await handleSessionStart(reload.pi, reloaded, reload.ctx);
			expect(reloaded.state).not.toBeNull();
			expect(reloaded.state!.successCriteria).toEqual(["e2e cond a", "e2e cond b"]);

			// 5. contextInjectionPrompt → <successCriteria> 段含编号行（plan 需求 3：编号列表）
			const state = reloaded.state!;
			const prompt = contextInjectionPrompt(state);
			expect(prompt).toContain("<successCriteria>");
			expect(prompt).toContain("1. e2e cond a");
			expect(prompt).toContain("2. e2e cond b");
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});
});
