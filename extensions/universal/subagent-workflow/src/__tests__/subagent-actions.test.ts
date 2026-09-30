/**
 * subagent-actions adapter + BG_MESSAGE + tool description 强化测试（FR-4/FR-5/FR-6/AC-4）。
 *
 * 修复目标：阻止 LLM 在 subagent 完成后继续轮询 subagent_list。三处冗余强化：
 *   1. adapter list action 返回 content 追加 reminder text block（每次 list 都看到）
 *   2. BG_MESSAGE 常量强化（启动时一次）
 *   3. tool description 强化（schema 阶段）
 *
 * 测试覆盖：adapter list 返回 content 数组含 reminder；BG_MESSAGE 字符串含
 * 'auto-injected' 关键词；description 源码含 'auto-injected'/'do not poll' 关键词。
 *
 * adapter import 不依赖 pi SDK（纯函数），可直接调用。description 测试用源码断言
 * （与 subagent-tool-prompt.test.ts 一致策略）；BG_MESSAGE [D6②] 权威源下沉 core
 * 后改为运行时断言（core 侧另有精确值快照）。
 *
 * [2026-09 测试审计] 本文件为壳侧 subagent action 域唯一宿主：吸收原 tool-action.test.ts
 * 的 adapter 出参结构 5 条 + schema 1 条 + model 全等回显 1 条、原 subagent-message-close.test.ts
 * 的 adapter message/close 2 条（handler 行为面权威在 core subagent-actions-core.test.ts）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { ListHandlerResult, StartHandlerResult, SubagentService } from "@zhushanwen/subagent-core";
import { startHandler } from "@zhushanwen/subagent-core";
import { adapter } from "../interface/gui/subagent-actions.ts";
import { SubagentParams } from "../interface/subagent-tool-schema.ts";
import { BG_MESSAGE } from "@zhushanwen/subagent-core/execution/assembly/subagent-actions-core.ts";
import type { ExecutionHandle, SubagentToolDetails } from "@zhushanwen/subagent-core/execution/assembly/types.ts";

// ── adapter reminder test fixtures ──

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUBAGENT_TOOL_SRC = readFileSync(
	join(__dirname, "../interface/subagent-tool.ts"),
	"utf-8",
);

/** 构造一个空 list domain object（adapter 需要 listResponse 字段）。 */
function emptyListResult(): ListHandlerResult {
	return { response: { running: 0, items: [] } };
}

/** 构造一个 running list domain object（adapter 需要 listResponse 字段）。 */
function runningListResult(running: number, count: number): ListHandlerResult {
	const items = Array.from({ length: count }, (_, i) => ({
		subagentId: `bg-${i}`,
		agent: "worker",
		slug: `task-${i}`,
		status: "running" as const,
		mode: "background" as const,
		duration: 0,
		model: "m",
		totalTokens: 0,
		sessionFile: undefined,
	}));
	return { response: { running, items } };
}

/** 构造一个 start domain object（负断言用：start 无 reminder）。 */
function startResult(): StartHandlerResult {
	return {
		kind: "bg",
		subagentId: "bg-0",
		sessionFile: undefined,
		slug: "task-0",
		model: undefined,
		response: { status: "running", mode: "background", message: BG_MESSAGE },
	};
}

describe("subagent-actions adapter list action reminder (FR-4/AC-4)", () => {
	it("list action 返回 content 是数组且第二个 text block 含 'auto-notif' 关键词", () => {
		// 模拟 service 调用 listHandler（不依赖 service 实例，构造 domain object 直接喂 adapter）
		const result = adapter({ action: "list", domain: emptyListResult() });

		// content 是数组（保证 reminder 不破坏 JSON 结构）
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content.length).toBeGreaterThanOrEqual(2);

		// 第二个 text block 是 reminder
		const reminderBlock = result.content[1];
		expect(reminderBlock.type).toBe("text");
		expect((reminderBlock as { text: string }).text).toMatch(/auto-notif|do not poll/i);
	});

	it("running list 同样带 reminder（与空 list 行为一致）", () => {
		const result = adapter({ action: "list", domain: runningListResult(2, 2) });

		expect(result.content.length).toBeGreaterThanOrEqual(2);
		expect((result.content[1] as { text: string }).text).toMatch(/auto-notif|do not poll/i);
	});
});

// ── list reminder 全文锚定（LLM 直接消费文本锁，第四轮架构审查 Strong 项）──

describe("list reminder 全文锚定", () => {
	// 上方 reminder describe 只断言关键词——重构/顺手清理改写全文不会红。本 describe
	// 逐字锁 LLM 看到的第二个 text block（期望值从 subagent-actions.ts 实现逐字复制）。

	it("list action 第二个 text block 逐字等于 reminder 全文（含前导 \\n\\n）", () => {
		const result = adapter({ action: "list", domain: emptyListResult() });

		expect(result.content).toHaveLength(2);
		expect(result.content[1]).toEqual({
			type: "text",
			text: "\n\nReminder: Subagent completion is auto-notified via auto-injected message (turn-triggering on idle). DO NOT bash sleep or poll in a loop — there is no poll action. Use action:'list' only when you concretely need state, then continue working or stop.",
		});
	});

	it("start action 无 reminder：第二个 text block 为空串（实现是空串形态，非省略 block）", () => {
		// start 的防轮询提醒在 BG_MESSAGE 里（response.message），list 专属 reminder
		// 不追加——content 恒两个 text block，非 list action 第二个为空串。
		const result = adapter({ action: "start", domain: startResult() });

		expect(result.content).toHaveLength(2);
		expect(result.content[0].type).toBe("text");
		expect((result.content[1] as { text: string }).text).toBe("");
	});
});

describe("BG_MESSAGE 强化 (FR-5)", () => {
	it("BG_MESSAGE 字符串含 'auto-injected' 或 'do not poll' 关键词", () => {
		// [B9] 防回退守护测试：BG_MESSAGE 不被误改/弱化（如有人删掉 'auto-injected'
		// 提示词）。[D6②] 常量权威源已随领域内核下沉 core subagent-actions-core
		//（原为读 subagent-actions.ts 源码文本提取，实现位置迁移后改运行时断言——
		// 行为等值，core 侧另有精确值快照）。运行时行为由 adapter list reminder 测试覆盖。
		expect(BG_MESSAGE).toMatch(/auto-injected|do not poll/i);
	});
});

describe("subagent tool description 强化 (FR-6)", () => {
	/** 提取 description: `...` 模板字符串的原始内容。 */
	function extractDescription(src: string): string {
		const m = src.match(/description:\s*`([\s\S]*?)`,/);
		if (!m) throw new Error("description template literal not found");
		return m[1];
	}

	it("description 'do NOT wait' 段含 'auto-injected' 关键词", () => {
		// [B9] 防回退守护测试：验证源码 description 模板字符串常量不被误改，非运行时行为断言。
		const description = extractDescription(SUBAGENT_TOOL_SRC);
		// 定位 "After launching" 段（section header）
		const idx = description.indexOf("## After launching");
		expect(idx).toBeGreaterThan(-1);
		const section = description.slice(idx, idx + 600);
		expect(section).toMatch(/auto-injected/i);
	});
});

// ============================================================
// adapter 出参结构（自 tool-action.test.ts 迁并）
// ============================================================

describe("adapter 出参结构", () => {
	it("start bg → SubagentToolResult.bgResponse + slug 透传 + content 合法 JSON（C3 回归）", () => {
		const r = adapter({
			action: "start",
			domain: {
				kind: "bg", subagentId: "bg-1", sessionFile: undefined, slug: "extract-urls",
				response: { status: "running", mode: "background", message: "detached, will notify on completion" },
			},
		});
		expect(r.details.action).toBe("start");
		expect(r.details.subagentId).toBe("bg-1");
		expect(r.details.bgResponse).toBeDefined();
		expect(r.details.sessionFile).toBeNull();
		// slug 透传到 result（renderResult 的 background 行展示用）
		expect(r.details.slug).toBe("extract-urls");
		// content JSON round-trip（bg 序列化回归）
		const parsed = JSON.parse(r.content[0]!.text);
		expect(parsed.bgResponse.message).toMatch(/detached/);
		expect(parsed.slug).toBe("extract-urls");
	});

	it("list → 最外层 subagentId/sessionFile 为 null", () => {
		const r = adapter({ action: "list", domain: { response: { running: 0, items: [] } } });
		expect(r.details.action).toBe("list");
		expect(r.details.subagentId).toBeNull();
		expect(r.details.sessionFile).toBeNull();
		expect(r.details.listResponse).toEqual({ running: 0, items: [] });
	});

	// [U3 C-outcome] 对外 JSON 契约：list items 携带 outcome 且旧字段保留（验收③）。
	it("[U3] list JSON：items[].outcome 在位（failed 值）且 status/mode/state 旧字段保留", () => {
		const r = adapter({
			action: "list",
			domain: {
				response: {
					running: 0,
					items: [
						{
							subagentId: "bg-u3", agent: "w", slug: "s", state: "idle", status: "idle",
							mode: "background", duration: 1, model: "m", totalTokens: 0,
							outcome: "failed",
						},
					],
				},
			},
		});
		const parsed = JSON.parse(r.content[0]!.text) as {
			listResponse: { items: Array<Record<string, unknown>> };
		};
		const item = parsed.listResponse.items[0]!;
		expect(item.outcome).toBe("failed");
		// 旧字段保留（向后兼容）。[U2 两态] status 是 ExecutionStatus（running|idle）。
		expect(item.status).toBe("idle");
		expect(item.state).toBe("idle");
		expect(item.mode).toBe("background");
		// closedReason 退出对外 JSON
		expect("closedReason" in item).toBe(false);
	});

	// [U3 C-outcome] start bgResponse：旧字段保留；outcome 为契约完备位，start 时点
	// record 未终态恒 undefined（JSON.stringify 落键省略），终态成败经 list items 披露。
	it("[U3] start bgResponse JSON：status/mode/message 旧字段保留，outcome 起点为 undefined", () => {
		const r = adapter({
			action: "start",
			domain: {
				kind: "bg", subagentId: "bg-u3-2", sessionFile: undefined, slug: "s",
				response: { status: "running", mode: "background", message: "detached" },
			},
		});
		const parsed = JSON.parse(r.content[0]!.text) as { bgResponse: Record<string, unknown> };
		expect(parsed.bgResponse.status).toBe("running");
		expect(parsed.bgResponse.mode).toBe("background");
		expect(parsed.bgResponse.message).toBe("detached");
		expect(parsed.bgResponse.outcome).toBeUndefined();
	});

	it("cancel → cancelResponse.cancelled:true 字面量", () => {
		const r = adapter({ action: "cancel", domain: { subagentId: "bg-1", response: { cancelled: true } } });
		expect(r.details.cancelResponse).toEqual({ cancelled: true });
		expect(r.details.subagentId).toBe("bg-1");
	});
});

// ============================================================
// adapter message/close action（自 subagent-message-close.test.ts 迁并）
// ============================================================

describe("adapter message/close action", () => {
	it("message → content JSON 含 messageResponse.delivered:true", () => {
		const result = adapter({
			action: "message",
			domain: { kind: "message", subagentId: "sa-1", response: { delivered: true } },
		});
		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed).toMatchObject({ action: "message", messageResponse: { delivered: true } });
	});

	it("close → content JSON 含 closeResponse.closed:true", () => {
		const result = adapter({
			action: "close",
			domain: { kind: "close", subagentId: "sa-1", response: { closed: true } },
		});
		const text = (result.content[0] as { text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed).toMatchObject({ action: "close", closeResponse: { closed: true } });
	});
});

// ============================================================
// start model 全等回显（自 tool-action.test.ts 迁并；handler 校验/启动行为面权威在 core）
// ============================================================

describe("start model 全等回显", () => {
	/** 最小 stub service：startHandler 解析链（E4 守卫前置）触达的读面 + execute。 */
	function makeStartService(execute: (opts: { task: string; slug?: string }) => Promise<ExecutionHandle>): SubagentService {
		const findRecord = vi.fn(() => undefined);
		const collectRecords = vi.fn(() => []);
		const getFullRecord = vi.fn(() => undefined);
		return {
			execute,
			findRecord,
			collectRecords,
			getFullRecord,
			getCollectSyncDefault: vi.fn(() => "async" as const),
			queries: {
				findRecord,
				collectRecords,
				getFullRecord,
				lookupRecordAnyState: vi.fn(() => undefined),
				onChange: vi.fn(() => () => {}),
			},
		} as unknown as SubagentService;
	}

	function makeRunningDetails(model: string): SubagentToolDetails {
		return {
			status: "running",
			mode: "background",
			agent: "worker",
			model,
			thinkingLevel: undefined,
			slug: "s",
			turns: 1,
			totalTokens: 10,
			elapsedSeconds: 1,
			eventLog: [],
			result: undefined,
		} as SubagentToolDetails;
	}

	// [U1] start 返回值 model 为 registry 全等回显（透传 handle.details.model）。
	it("model 为 registry 全等回显：领域对象 / adapter 外层 / LLM content JSON 三处同源", async () => {
		const svc = makeStartService(async () => ({
			mode: "background",
			subagentId: "bg-2-456",
			sessionFile: undefined,
			// record.model = resolved（裁决放行条目）拼接的 "provider/id"，保留 registry 大小写
			details: makeRunningDetails("zai-coding-cn/GLM-5.3-Flash"),
		}));
		const r = await startHandler(svc, { task: "t", slug: "s" }, undefined);
		expect(r.model).toBe("zai-coding-cn/GLM-5.3-Flash");
		// adapter 外层 result 同源回显
		const toolResult = adapter({ action: "start", domain: r });
		const result = toolResult.details;
		if (result.action !== "start") throw new Error("expected start variant");
		expect(result.model).toBe("zai-coding-cn/GLM-5.3-Flash");
		// LLM content JSON 同源（与 details 一致）
		const contentJson = JSON.parse(toolResult.content[0]!.type === "text" ? toolResult.content[0].text : "{}");
		expect(contentJson.model).toBe("zai-coding-cn/GLM-5.3-Flash");
		expect(contentJson.bgResponse.notifyContract).toBe("ledger+at-least-once");
	});
});

// ============================================================
// schema 面（自 tool-action.test.ts 迁并；本包 typebox 被 alias 丢 options，
// 真实 typebox 编译契约由 structured-output cross-package-contract.test.ts 承担）
// ============================================================

describe("subagent tool schema 面", () => {
	it("listParam.includeWorkflow 声明存在且 optional（D1① 工具契约）", () => {
		const raw: unknown = JSON.parse(JSON.stringify(SubagentParams));
		if (!(typeof raw === "object" && raw !== null)) throw new Error("SubagentParams is not an object schema");
		const props = (raw as { properties?: unknown }).properties;
		if (!(typeof props === "object" && props !== null)) throw new Error("SubagentParams has no properties");
		const listParam = (props as Record<string, unknown>).listParam;
		if (!(typeof listParam === "object" && listParam !== null)) throw new Error("listParam missing");
		const listProps = (listParam as { properties?: unknown }).properties;
		if (!(typeof listProps === "object" && listProps !== null)) throw new Error("listParam has no properties");
		expect(Object.keys(listProps)).toEqual(expect.arrayContaining(["includeFinished", "includeWorkflow", "limit"]));
		const includeWorkflow = (listProps as Record<string, unknown>).includeWorkflow;
		expect(includeWorkflow).toBeDefined();
		const req = (listParam as { required?: unknown }).required;
		if (Array.isArray(req)) {
			expect(req).not.toContain("includeWorkflow");
		}
	});
});