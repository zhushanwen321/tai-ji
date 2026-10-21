/**
 * tool-prompt-contract.test.ts — U6 锚词契约测试（session-manager-archive-delete）。
 *
 * 断言对象 = 注册数据形态（mock pi 捕获 registerTool 实参，读 description /
 * promptSnippet / exposure / parameters 的运行时值——不读源码文本，格式重排与
 * 转义形态不敏感）。断言范围与权威源 = 设计 §4 验收 5（契约测试锁文案双轨，
 * 防约束文案被无意改掉 = 约束静默消失）。
 *
 * 两段门控（impl-plan §2 u-contract-test 行）：
 * 1. 结构断言段：始终生效（随两终局工具注册在场即绿）——8 工具注册全集、
 *    delete_session 的 USER-INITIATED ONLY 双锚词（description + promptSnippet）、
 *    其余 7 工具两处零该锚词（防约束文案复制稀释）、delete/archive exposure=deferred。
 * 2. 文案断言段：挂 u-copy-rewrite 的 commit 门——COPY_READY = 六个现有工具
 *    description 均含 "## Example"；copy 落地前整段 skip，落地后自动生效。
 *    内容：8 工具 description 含 Example 段、含 sessionId 参数的 6 工具其
 *    sessionId 字段说明含 list_my_sessions 来源句式、description 零 "times out"
 *    （P0 漂移词禁入）、环境行统一短语 "hangs forever" 在场。
 *
 * 框架：vitest（禁 node:test）。
 */
import { describe, expect, it, vi } from "vitest";

import registerExtension from "../index.ts";

/** mock pi：捕获 registerTool 实参全字段（含 promptSnippet / exposure）。 */
function createMockPi() {
	const registered: Array<Record<string, unknown>> = [];
	const pi = {
		registerTool: (tool: Record<string, unknown>) => {
			registered.push(tool);
		},
		on: vi.fn(),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
	};
	return { pi, registered };
}

const { pi, registered } = createMockPi();
registerExtension(pi as never);

/** 运行时检查（extensions taste/no-unsafe-cast 规范：窄化断言须有 guard）。 */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function tool(name: string): Record<string, unknown> {
	const t = registered.find((r) => r.name === name);
	if (!isRecord(t)) throw new Error(`tool not registered: ${name}`);
	return t;
}

function description(name: string): string {
	const d = tool(name).description;
	if (typeof d !== "string") throw new Error(`${name} description is not a string`);
	return d;
}

/** promptSnippet 的可检视图：未配置 = 空串（负锚检测不受 undefined 影响）。 */
function promptSnippet(name: string): string {
	const s = tool(name).promptSnippet;
	return typeof s === "string" ? s : "";
}

/** schema 的可检视图：经 JSON 往返剥离 typebox 类型包装，只看数据形态。 */
function schemaProperties(name: string): Record<string, unknown> {
	const raw: unknown = JSON.parse(JSON.stringify(tool(name).parameters));
	if (!isRecord(raw)) throw new Error(`${name} parameters is not an object schema`);
	if (!isRecord(raw.properties)) throw new Error(`${name} schema has no properties`);
	return raw.properties;
}

// ── 工具全集（与 tool-registration.test.ts 的 8 名清单同源）──

const ALL_TOOL_NAMES = [
	"create_managed_session",
	"send_to_session",
	"read_session_history",
	"list_my_sessions",
	"get_session_status",
	"abort_session",
	"delete_session",
	"archive_session",
] as const;

/** 含 sessionId 参数的 6 工具（id 来源句式断言范围——create 无 id 参数、list 无参数）。 */
const SESSION_ID_TOOLS = [
	"send_to_session",
	"read_session_history",
	"get_session_status",
	"abort_session",
	"delete_session",
	"archive_session",
] as const;

/** 六个现有工具（u-copy-rewrite 的重写对象；COPY_READY 检测范围）。 */
const LEGACY_SIX = [
	"create_managed_session",
	"send_to_session",
	"read_session_history",
	"list_my_sessions",
	"get_session_status",
	"abort_session",
] as const;

// ══════════════════════════════════════════════════════════════
// 结构断言段（始终生效）
// ══════════════════════════════════════════════════════════════

describe("结构断言段：注册全集与 delete 人身约束双锚词", () => {
	it("8 工具全部注册，名字集合精确匹配（漏注册/多注册/改名即红）", () => {
		expect(registered).toHaveLength(ALL_TOOL_NAMES.length);
		expect(new Set(registered.map((t) => t.name))).toEqual(new Set(ALL_TOOL_NAMES));
	});

	it("delete_session：description 与 promptSnippet 双含 USER-INITIATED ONLY", () => {
		expect(description("delete_session"), "delete description 缺人身约束锚词").toContain(
			"USER-INITIATED ONLY",
		);
		expect(promptSnippet("delete_session"), "delete promptSnippet 缺人身约束锚词").toContain(
			"USER-INITIATED ONLY",
		);
	});

	it("delete_session：description 含词义消歧锚（设计验收 5）", () => {
		expect(description("delete_session")).toContain("means archive_session, NOT this tool");
	});

	it("其余 7 工具：description 与 promptSnippet 两处均不含 USER-INITIATED ONLY（防约束文案复制稀释）", () => {
		for (const name of ALL_TOOL_NAMES) {
			if (name === "delete_session") continue;
			expect(description(name), `${name} description 不应含约束锚词`).not.toContain(
				"USER-INITIATED ONLY",
			);
			expect(promptSnippet(name), `${name} promptSnippet 不应含约束锚词`).not.toContain(
				"USER-INITIATED ONLY",
			);
		}
	});

	it("两新工具 exposure 为 deferred（delete_session / archive_session）", () => {
		expect(tool("delete_session").exposure, "delete_session exposure 应为 deferred").toBe(
			"deferred",
		);
		expect(tool("archive_session").exposure, "archive_session exposure 应为 deferred").toBe(
			"deferred",
		);
	});
});

// ══════════════════════════════════════════════════════════════
// 文案断言段（COPY_READY 门：u-copy-rewrite 文案落地前整段 skip）
// ══════════════════════════════════════════════════════════════

const COPY_READY = LEGACY_SIX.every((name) => description(name).includes("## Example"));

describe.skipIf(!COPY_READY)("文案断言段：8 工具文案契约（u-copy-rewrite 落地后自动生效）", () => {
	it("8 工具 description 均含 ## Example 段", () => {
		for (const name of ALL_TOOL_NAMES) {
			expect(description(name), `${name} description 缺 ## Example 段`).toContain("## Example");
		}
	});

	it("sessionId 参数 6 工具：sessionId 字段说明含 list_my_sessions 来源句式", () => {
		for (const name of SESSION_ID_TOOLS) {
			const sessionId = schemaProperties(name).sessionId;
			if (!isRecord(sessionId)) throw new Error(`${name} schema 缺 sessionId 参数`);
			expect(
				sessionId.description,
				`${name} sessionId 字段说明缺 id 来源句式`,
			).toContain("list_my_sessions");
		}
	});

	it("8 工具 description 零 times out（P0 漂移词禁入）", () => {
		for (const name of ALL_TOOL_NAMES) {
			expect(description(name), `${name} description 残留 times out`).not.toContain("times out");
		}
	});

	it("环境行统一短语 hangs forever 在场（8 工具）", () => {
		for (const name of ALL_TOOL_NAMES) {
			expect(description(name), `${name} description 缺 hangs forever 环境行`).toContain(
				"hangs forever",
			);
		}
	});
});
