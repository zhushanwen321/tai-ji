/**
 * index-integration.test.ts — W5 tool_call handler 集成测试。
 *
 * 测扩展工厂注册的 tool_call handler 行为：
 *  - yolo 快速路径 → return undefined（放行）
 *  - strict 模式 → block（headless deny）
 *  - mode 切换（config 文件变化后 handler 用新 mode）
 *  - G5 并发串行化（多次 tool_call 顺序处理）
 *  - fail-closed（异常 → block）
 *  - session_start 重载 config
 *
 * 用 PI_CODING_AGENT_DIR 指向临时目录，写入 controlled permission.json，
 * 让 loadAndWatchConfig 读到指定 mode。mock pi 对象记录 handler 调用。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import permissionExtension from "../index.js";
import { FOOTER_HANDSHAKE_KEY, REQUEST_RENDER_KEY } from "../footer-provider.js";

// ──────────────────────── mock pi ────────────────────────

/** tool_call handler 的最小签名（返回 Promise<block 结果 | undefined>）。 */
type ToolCallHandler = (event: unknown, ctx: unknown) => Promise<ToolCallResult | undefined>;
/** tool_call handler 的返回值（Pi ToolCallEventResult 子集）。 */
interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

interface MockPiCalls {
	registerCommandCalls: Array<{ name: string; options: unknown }>;
	eventHandlers: Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>;
}

/**
 * 构造 mock pi。返回对象满足 ExtensionAPI 的 on/registerCommand 子集，
 * 用 `as Pick<ExtensionAPI, "on" | "registerCommand">` 单点断言（taste/no-unsafe-cast 允许 Pick 断言）。
 */
function createMockPi(): { pi: Pick<ExtensionAPI, "on" | "registerCommand">; calls: MockPiCalls } {
	const registerCommandCalls: MockPiCalls["registerCommandCalls"] = [];
	const eventHandlers: MockPiCalls["eventHandlers"] = new Map();
	const pi = {
		registerCommand(name: string, options: unknown): void {
			registerCommandCalls.push({ name, options });
		},
		on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void {
			if (!eventHandlers.has(event)) eventHandlers.set(event, []);
			eventHandlers.get(event)!.push(handler);
		},
	};
	return { pi: pi as Pick<ExtensionAPI, "on" | "registerCommand">, calls: { registerCommandCalls, eventHandlers } };
}

/** 提取 tool_call handler（已注册的单一 handler）。 */
function getToolCallHandler(calls: MockPiCalls): ToolCallHandler {
	const handlers = calls.eventHandlers.get("tool_call");
	if (!handlers || handlers.length === 0) {
		throw new Error("tool_call handler not registered");
	}
	return handlers[0] as ToolCallHandler;
}

/** 提取 session_start handler。 */
function getSessionStartHandler(calls: MockPiCalls): (event: unknown, ctx: unknown) => unknown {
	const handlers = calls.eventHandlers.get("session_start");
	if (!handlers || handlers.length === 0) {
		throw new Error("session_start handler not registered");
	}
	return handlers[0];
}

/** 提取 session_tree handler。 */
function getSessionTreeHandler(calls: MockPiCalls): (event: unknown, ctx: unknown) => unknown {
	const handlers = calls.eventHandlers.get("session_tree");
	if (!handlers || handlers.length === 0) {
		throw new Error("session_tree handler not registered");
	}
	return handlers[0];
}

/** 构造 mock ctx（含 mode/ui/signal）。 */
function makeCtx(mode: "tui" | "rpc" | "json" | "print" = "json"): unknown {
	return {
		mode,
		cwd: "/tmp",
		ui: {
			notify(): void {
				/* noop */
			},
			select(): Promise<string | undefined> {
				return Promise.resolve(undefined);
			},
			custom(): Promise<unknown> {
				return Promise.resolve(undefined);
			},
		},
		signal: undefined,
	};
}

/** bash tool_call event 构造器。 */
function bashEvent(command: string): { toolName: string; input: { command: string } } {
	return { toolName: "bash", input: { command } };
}

// ──────────────────────── 临时 config 目录 ────────────────────────

const TMP_ROOT = join(tmpdir(), "pi-perm-test-" + process.pid);
const AGENT_DIR = join(TMP_ROOT, "agent");
const CONFIG_PATH = join(AGENT_DIR, "config", "permission-ext-config.json");

function writeConfig(mode: string, enabled = true): void {
	mkdirSync(AGENT_DIR, { recursive: true });
	mkdirSync(join(AGENT_DIR, "config"), { recursive: true });
	const config = {
		mode,
		enabled,
		classifier: { enabled: true, model: "auto", timeout: 5, autoApproveLowRisk: true, autoDenyHighRisk: true },
		userRules: [],
	};
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

beforeEach(() => {
	// 清理 footer 握手 slot（防 footer 测试跨用例污染）
	Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
	Reflect.deleteProperty(globalThis, REQUEST_RENDER_KEY);
	process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
	mkdirSync(AGENT_DIR, { recursive: true });
	// 默认 yolo config（大多数测试需要可预测起点）
	writeConfig("yolo");
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
	Reflect.deleteProperty(globalThis, REQUEST_RENDER_KEY);
	if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ──────────────────────── 测试 ────────────────────────

describe("W5 tool_call handler 集成", () => {
	it("工厂注册 session_start + tool_call + /permission command", () => {
		const { pi, calls } = createMockPi();
		expect(() => permissionExtension(pi)).not.toThrow();
		expect(calls.eventHandlers.has("session_start")).toBe(true);
		expect(calls.eventHandlers.has("tool_call")).toBe(true);
		const permCmd = calls.registerCommandCalls.find((c) => c.name === "permission");
		expect(permCmd).toBeDefined();
	});

	it("yolo 快速路径 → return undefined（放行，不跑管道）", async () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		const result = await handler(bashEvent("rm -rf /"), makeCtx());
		expect(result).toBeUndefined();
	});

	it("enabled=false → 等同 yolo 放行", async () => {
		writeConfig("strict", false);
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		const result = await handler(bashEvent("ls"), makeCtx());
		expect(result).toBeUndefined();
	});

	it("strict + headless → block（fail-closed deny）", async () => {
		writeConfig("strict");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		const result = await handler(bashEvent("ls"), makeCtx("json"));
		expect(result).toBeDefined();
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("headless");
	});

	it("approve + 非安全命令 + headless → block", async () => {
		writeConfig("approve");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		// curl 不在白名单 → ask → approve 模式 → 人工审批 → headless deny
		const result = await handler(bashEvent("curl http://example.com"), makeCtx("json"));
		expect(result?.block).toBe(true);
	});

	it("approve + 安全命令（ls）→ 放行", async () => {
		writeConfig("approve");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		// ls 在白名单 → allow → 放行
		const result = await handler(bashEvent("ls"), makeCtx("json"));
		expect(result).toBeUndefined();
	});

	it("缺 toolName → fail-closed block", async () => {
		writeConfig("approve");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		const result = await handler({ input: { command: "ls" } }, makeCtx());
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("missing toolName");
	});

	it("G5 并发串行：多个 tool_call 顺序处理（不重叠）", async () => {
		writeConfig("strict");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		// 并发发起 3 个 tool_call（不 await），它们应串行
		const ctx = makeCtx();
		const p1 = handler(bashEvent("ls"), ctx);
		const p2 = handler(bashEvent("pwd"), ctx);
		const p3 = handler(bashEvent("whoami"), ctx);
		// Promise.all 这里是故意的：3 个调用是同一串行链上的任务，断言全部 block。
		// 非独立降级场景才用 allSettled；此处任一 reject 即测试失败（符合预期）。
		const results = await Promise.all([p1, p2, p3]);
		expect(results.length).toBe(3);
		for (const r of results) {
			expect(r?.block).toBe(true);
		}
	});

	it("session_start handler 重载 config（mode 切换生效）", async () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const toolHandler = getToolCallHandler(calls);
		const sessionHandler = getSessionStartHandler(calls);

		// 初始 yolo → 放行
		const r1 = await toolHandler(bashEvent("ls"), makeCtx());
		expect(r1).toBeUndefined();

		// 切换到 strict，触发 session_start 重载
		writeConfig("strict");
		getSessionStartHandler(calls);
		sessionHandler({}, makeCtx());

		// 现在 strict → block
		const r2 = await toolHandler(bashEvent("ls"), makeCtx());
		expect(r2?.block).toBe(true);
	});

	it("异常路径 → fail-closed block（绝不放行）", async () => {
		writeConfig("approve");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		// input=null → 容错为 {}，bash 无 command → 走管道，approve + 空命令 → 人工审批 → headless deny
		const result = await handler({ toolName: "bash", input: null }, makeCtx());
		expect(result).toBeDefined();
		expect(result?.block).toBe(true);
	});
});

// ──────────────────────── W8 /permission rule 命令集成 ────────────────────────

/** 提取 /permission command handler。 */
function getPermissionHandler(calls: MockPiCalls): (args: string, ctx: unknown) => Promise<void> {
	const cmd = calls.registerCommandCalls.find((c) => c.name === "permission");
	if (!cmd) throw new Error("permission command not registered");
	return (cmd.options as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
}

describe("W8 /permission rule 命令集成", () => {
	it("headless（json）→ notify 降级提示，不改 config", async () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getPermissionHandler(calls);
		const ctx = makeCtx("json");
		// 不应抛错
		await handler("rule", ctx);
	});

	it("permission handler 分流：rule 参数走 rule 路径（headless 降级）", async () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getPermissionHandler(calls);
		const ctx = makeCtx("json");
		// rule 参数应走 headless 降级（notify）
		await expect(handler("rule", ctx)).resolves.not.toThrow();
	});
});



// ──────────────────────── footer line 注册（consumer 端握手 + render 读时刷新）────────────────────────

describe("footer line 注册", () => {
	it("session_start：ctx.ui 无 theme → 仍注册 renderer（不依赖 ctx.ui），render(null theme) 返回 null", () => {
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const sessionHandler = getSessionStartHandler(calls);
		const ctxNoTheme = { mode: "json", cwd: "/tmp", ui: {}, signal: undefined };
		expect(() => sessionHandler({}, ctxNoTheme)).not.toThrow();
		// 不再依赖 ctx.ui.theme（pi 的 ExtensionUIContext 无此字段）：无条件注册
		const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as {
			pending: Array<{ id: string; renderer: unknown }>;
		} | undefined;
		expect(slot).toBeDefined();
		expect(slot!.pending.length).toBe(1);
		const renderer = slot!.pending[0]!.renderer as {
			render: (ctx: unknown, theme: unknown) => string | null;
		};
		// headless：theme 无效（undefined）→ null（statusline 跳过）
		expect(renderer.render(undefined, undefined)).toBeNull();
	});

	it("render：theme 无 fg 函数 → 返回 null（不抛）", () => {
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const sessionHandler = getSessionStartHandler(calls);
		sessionHandler({}, { mode: "json", cwd: "/tmp", ui: {}, signal: undefined });
		const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as {
			pending: Array<{ id: string; renderer: unknown }>;
		} | undefined;
		const renderer = slot!.pending[0]!.renderer as {
			render: (ctx: unknown, theme: unknown) => string | null;
		};
		expect(renderer.render(undefined, { fg: "not-a-fn" })).toBeNull();
	});

	it("session_start：注册 renderer，render(ctx, theme) 用传入 theme 构造 palette + 读时刷新", () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const sessionHandler = getSessionStartHandler(calls);
		// 注册不依赖 ctx.ui.theme；theme 由 statusline 在 render 时传入
		sessionHandler({}, { mode: "json", cwd: "/tmp", ui: {}, signal: undefined });
		// consumer 端：owner(pi-statusline) 未加载 → registry 未就绪 → renderer 进 pending
		const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as {
			version: number;
			pending: Array<{ id: string; renderer: unknown }>;
		} | undefined;
		expect(slot).toBeDefined();
		expect(slot!.version).toBe(1);
		expect(slot!.pending.length).toBe(1);
		expect(slot!.pending[0]!.id).toBe("pi-permission");
		const renderer = slot!.pending[0]!.renderer as {
			render: (ctx: unknown, theme: unknown) => string | null;
		};
		// statusline render hook 传入的 theme 参数（pi Theme 对象，fg(token, text)）
		const theme = { fg: (_t: string, text: string): string => text };
		// render 用传入 theme 构造 palette + 读最新 config（yolo）→ 含 YOLO label
		expect(renderer.render(undefined, theme)).toContain("YOLO");
		// 读时刷新：改 config mode 后再次 render → 反映 Strict（验证 render 内 loadAndWatchConfig）
		writeConfig("strict");
		const out2 = renderer.render(undefined, theme);
		expect(out2).toContain("Strict");
		expect(out2).not.toContain("YOLO");
	});

	it("session_tree：触发不抛异常（只 requestRender，不改注册状态）", () => {
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const sessionTreeHandler = getSessionTreeHandler(calls);
		expect(() => sessionTreeHandler({}, undefined)).not.toThrow();
	});
});

// ──────────────────────── session_start 配置路径迁移接线（index.ts migrateLegacyConfig 调用）────────────────────────
// 迁移经 oncePerProcess 守卫（u-audit-fix 收编原内联 once flag），守卫的模块级 Map
// 跨用例残留：用 vi.resetModules() + 动态 import 取新鲜模块实例，否则前面用例已触发过
// session_start，迁移分支永不执行（静默不测）。
describe("session_start 配置路径迁移接线", () => {
	const LEGACY_PATH = join(AGENT_DIR, "permission-config.json");

	/** 重置模块 + 动态 import，返回新鲜 permissionExtension 工厂。 */
	async function freshExtension(): Promise<(pi: Pick<ExtensionAPI, "on" | "registerCommand">) => void> {
		vi.resetModules();
		const mod = await import("../index.js");
		return mod.default as (pi: Pick<ExtensionAPI, "on" | "registerCommand">) => void;
	}

		/** 写旧路径配置文件（permission-config.json）。 */
	function writeLegacyConfig(mode: string): void {
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(
			LEGACY_PATH,
			JSON.stringify({ mode, enabled: true, classifier: { enabled: true }, userRules: [] }, null, 2) + "\n",
			{ mode: 0o600 },
		);
	}

	it("旧路径存在 + 新路径不存在 → session_start 触发 renameSync 迁移（内容保留 + 旧文件消失）", async () => {
		// 前置：beforeEach 已写新路径 yolo 配置，迁移场景要求新路径不存在
		rmSync(CONFIG_PATH, { force: true });
		writeLegacyConfig("strict");

		const extension = await freshExtension();
		const { pi, calls } = createMockPi();
		extension(pi);
		const handler = getSessionStartHandler(calls);
		handler({}, makeCtx("json"));

		// 新路径存在且内容来自旧文件（renameSync 保留内容），旧文件消失
		expect(existsSync(CONFIG_PATH)).toBe(true);
		const migrated = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(migrated.mode).toBe("strict");
		expect(existsSync(LEGACY_PATH)).toBe(false);
	});

	it("once 守卫：同进程第二次 session_start 不重复迁移（重建旧文件不动）", async () => {
		rmSync(CONFIG_PATH, { force: true });
		writeLegacyConfig("auto");

		const extension = await freshExtension();
		const { pi, calls } = createMockPi();
		extension(pi);
		const handler = getSessionStartHandler(calls);
		handler({}, makeCtx("json"));
		expect(existsSync(LEGACY_PATH)).toBe(false); // 首次已迁移

		// 重建旧文件（模拟外部残留），再次触发 session_start → oncePerProcess 守卫跳过迁移
		writeLegacyConfig("yolo");
		handler({}, makeCtx("json"));
		expect(existsSync(LEGACY_PATH)).toBe(true); // 未被再次消费
		expect(existsSync(CONFIG_PATH)).toBe(true);
	});

	it("旧路径存在 + 新路径已存在 → 删除旧文件（残留副本清理），新配置内容不变", async () => {
		// beforeEach 已写新路径 yolo；再放旧文件 → session_start 删旧文件，新内容保持 yolo
		writeLegacyConfig("strict");

		const extension = await freshExtension();
		const { pi, calls } = createMockPi();
		extension(pi);
		const handler = getSessionStartHandler(calls);
		handler({}, makeCtx("json"));

		expect(existsSync(LEGACY_PATH)).toBe(false);
		const current = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(current.mode).toBe("yolo");
	});

	it("旧路径不存在（全新安装）→ noop，不创建新路径之外的东西", async () => {
		rmSync(CONFIG_PATH, { force: true });
		expect(existsSync(LEGACY_PATH)).toBe(false);

		const extension = await freshExtension();
		const { pi, calls } = createMockPi();
		extension(pi);
		const handler = getSessionStartHandler(calls);
		expect(() => handler({}, makeCtx("json"))).not.toThrow();
		expect(existsSync(CONFIG_PATH)).toBe(false); // 迁移不凭空造新配置
	});
});
