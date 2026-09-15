/**
 * session-start-once-guard.test.ts — u-audit-fix 探针实测（permission 侧）。
 *
 * 排查清单（docs/design/pi-session-start-handler-idempotency-audit.md §2 permission 行）
 * 判定「必须接入」：migrateLegacyConfig 写 agentDir 全局配置文件，属跨 session 副作用，
 * 已由 oncePerProcess 守卫收编原内联 once flag。本文件按清单探针验证点双派发实测：
 *   a) 双派发（同一 factory 闭包直接调 handler 两次）下 spy migrateLegacyConfig 调用 = 1；
 *   b) 文件面：tmp agentDir 预置旧路径文件 → 第一次 handler 后旧文件消失 + 新路径出现，
 *      第二次 handler 后新路径 mtime/内容不变（守卫拦截 = 不触碰）；
 *   c) migrated warn 仅一条：构造性蕴含于 a——warn 在 migrateLegacyConfig 调用点内部
 *      （llm-shared migrate.ts "migrated" 分支），调用 = 1 ⟹ warn ≤ 1，不另设断言。
 * 反向断言（豁免项防误伤）：footer 注册为纯内存初始化（registry.register 同 id 覆盖），
 * 清单明令不包装——双派发仍每次执行（pending push ×2）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOOTER_HANDSHAKE_KEY } from "../footer-provider.js";

// ── mock：migrateLegacyConfig 包 spy 计数（透传真实实现，文件面断言保留） ──

const { spyMigrateLegacyConfig } = vi.hoisted(() => ({
	spyMigrateLegacyConfig: vi.fn(),
}));

vi.mock("@zhushanwen/pi-llm-shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@zhushanwen/pi-llm-shared")>();
	spyMigrateLegacyConfig.mockImplementation((agentDir: string, oldRel: string, newRel: string) =>
		actual.migrateLegacyConfig(agentDir, oldRel, newRel));
	return { ...actual, migrateLegacyConfig: spyMigrateLegacyConfig };
});

// ── mock pi（对齐 index-integration.test.ts 自包含 helper 形态） ──

function createMockPi(): { pi: Pick<ExtensionAPI, "on" | "registerCommand">; calls: { eventHandlers: Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>> } } {
	const eventHandlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();
	const pi = {
		registerCommand(): void {
			/* noop */
		},
		on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void {
			if (!eventHandlers.has(event)) eventHandlers.set(event, []);
			eventHandlers.get(event)!.push(handler);
		},
	};
	return { pi: pi as Pick<ExtensionAPI, "on" | "registerCommand">, calls: { eventHandlers } };
}

function getSessionStartHandler(calls: { eventHandlers: Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>> }): (event: unknown, ctx: unknown) => unknown {
	const handlers = calls.eventHandlers.get("session_start");
	if (!handlers || handlers.length === 0) {
		throw new Error("session_start handler not registered");
	}
	return handlers[0]!;
}

// ── tmp agentDir（getAgentDir 经 PI_CODING_AGENT_DIR 推导，对齐 index-integration.test.ts） ──

const TMP_ROOT = join(tmpdir(), "pi-perm-once-guard-" + process.pid);
const AGENT_DIR = join(TMP_ROOT, "agent");
const LEGACY_PATH = join(AGENT_DIR, "permission-config.json");
const CONFIG_PATH = join(AGENT_DIR, "config", "permission-ext-config.json");

function writeLegacyConfig(mode: string): void {
	mkdirSync(AGENT_DIR, { recursive: true });
	writeFileSync(
		LEGACY_PATH,
		JSON.stringify({ mode, enabled: true, classifier: { enabled: true }, userRules: [] }, null, 2) + "\n",
		{ mode: 0o600 },
	);
}

/** oncePerProcess 的 Map 是模块级状态：每个用例 resetModules 取新鲜模块实例（对齐迁移接线测试先例）。 */
async function freshExtension(): Promise<(pi: Pick<ExtensionAPI, "on" | "registerCommand">) => void> {
	vi.resetModules();
	const mod = await import("../index.js");
	return mod.default as (pi: Pick<ExtensionAPI, "on" | "registerCommand">) => void;
}

beforeEach(() => {
	Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
	process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
	mkdirSync(AGENT_DIR, { recursive: true });
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
	if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("session_start 双派发幂等守卫（oncePerProcess，u-audit-fix）", () => {
	it("双派发下 migrateLegacyConfig 仅执行一次：spy = 1，文件面首次迁移到位、第二次 mtime/内容不变", async () => {
		// 预置旧路径文件（新路径不存在 → 走 renameSync 迁移分支）
		writeLegacyConfig("strict");

		const extension = await freshExtension();
		const { pi, calls } = createMockPi();
		extension(pi);
		const handler = getSessionStartHandler(calls);

		// 第一次派发：迁移发生（旧文件消失 + 新路径出现，内容来自旧文件）
		handler({}, { mode: "json", cwd: "/tmp", ui: {}, signal: undefined });
		expect(existsSync(LEGACY_PATH)).toBe(false);
		expect(existsSync(CONFIG_PATH)).toBe(true);
		expect(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).mode).toBe("strict");
		const mtimeAfterFirst = statSync(CONFIG_PATH).mtimeMs;
		const contentAfterFirst = readFileSync(CONFIG_PATH, "utf-8");

		// 第二次派发（factory 二调/handler 累积形态：同一 handler 引用再调）：
		// 重建旧路径文件模拟外部残留——守卫已消费 key，不得再次触碰任何文件。
		writeLegacyConfig("yolo");
		handler({}, { mode: "json", cwd: "/tmp", ui: {}, signal: undefined });

		// 探针 a：操作级去重（spy 透传真实实现，文件面与计数同源）
		expect(spyMigrateLegacyConfig).toHaveBeenCalledTimes(1);
		// 探针 b：第二次后重建的旧文件原样保留、新路径 mtime/内容严格不变
		expect(existsSync(LEGACY_PATH)).toBe(true);
		expect(statSync(CONFIG_PATH).mtimeMs).toBe(mtimeAfterFirst);
		expect(readFileSync(CONFIG_PATH, "utf-8")).toBe(contentAfterFirst);
	});

	it("豁免项防误伤：footer 注册不包装，双派发仍每次执行（pending push ×2）", async () => {
		writeLegacyConfig("strict");

		const extension = await freshExtension();
		const { pi, calls } = createMockPi();
		extension(pi);
		const handler = getSessionStartHandler(calls);

		handler({}, { mode: "json", cwd: "/tmp", ui: {}, signal: undefined });
		handler({}, { mode: "json", cwd: "/tmp", ui: {}, signal: undefined });

		// 纯内存初始化（registry.register 同 id 覆盖 / pending push）保持每 session_start
		// 执行——清单「粒度边界」明令不包装，挂进程级 flag 会杀 session 级语义。
		const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as {
			pending: Array<{ id: string; renderer: unknown }>;
		} | undefined;
		expect(slot).toBeDefined();
		expect(slot!.pending.length).toBe(2);
		expect(slot!.pending[0]!.id).toBe("pi-permission");
	});
});
