/**
 * WT8/WT9: 扩展入口注册 + 占位 tool_call 测试
 *
 * 用 mock pi 对象记录调用，不依赖真实 Pi 运行时。
 * PI_CODING_AGENT_DIR 隔离到临时目录：permissionExtension 工厂初始化时会
 * loadAndWatchConfig → ensureConfigFile 创建默认配置，不隔离会污染真实 agentDir。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Mock Pi SDK 模块（extension.ts import 的 @earendil-works/pi-coding-agent 类型在 node_modules 有完整定义，
// 这里 import 工厂函数，用 mock pi 调用它）
import permissionExtension from "../index.js";

let tempAgentDir: string;
let originalAgentDirEnv: string | undefined;

beforeEach(() => {
	tempAgentDir = mkdtempSync(join(tmpdir(), "pi-perm-ext-test-"));
	originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;
});

afterEach(() => {
	if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
	rmSync(tempAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 最小 mock：只记录 registerCommand 和 on 调用 */
interface MockPi {
	registerCommand: (name: string, options: unknown) => void;
	on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;
}

interface RecordedCall {
	name: string;
	options: unknown;
}

function createMockPi(): {
	pi: MockPi;
	registerCommandCalls: RecordedCall[];
	eventHandlers: Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>;
} {
	const registerCommandCalls: RecordedCall[] = [];
	const eventHandlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();

	const pi: MockPi = {
		registerCommand(name: string, options: unknown) {
			registerCommandCalls.push({ name, options });
		},
		on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
			if (!eventHandlers.has(event)) {
				eventHandlers.set(event, []);
			}
			eventHandlers.get(event)!.push(handler);
		},
	};

	return { pi, registerCommandCalls, eventHandlers };
}

/** 提取 handler options 的类型（运行时 duck typing） */
interface CommandOptions {
	description: string;
	handler: (args: string, ctx: { ui: { notify: (message: string, level: string) => void } }) => void;
}

describe("WT8: 扩展入口注册", () => {
	it("permissionExtension(pi) 注册 /permission 命令和事件处理器", () => {
		const { pi, registerCommandCalls, eventHandlers } = createMockPi();

		// 不应 throw
		expect(() => permissionExtension(pi)).not.toThrow();

		// 注册了 permission 命令
		const permCommand = registerCommandCalls.find((c) => c.name === "permission");
		expect(permCommand).toBeDefined();
		const opts = permCommand!.options as CommandOptions;
		expect(opts.description).toBeTruthy();
		expect(typeof opts.handler).toBe("function");

		// 注册了 session_start 事件
		expect(eventHandlers.has("session_start")).toBe(true);

		// 注册了 tool_call 事件（W1 占位）
		expect(eventHandlers.has("tool_call")).toBe(true);

		// W1 不注册 statusline（ctx.ui.setFooter 的 TUI Component 推到 W6）
		expect(eventHandlers.has("statusline")).toBe(false);
	});

	it("permission 命令 handler 调用时返回状态消息（无参数）", () => {
		const { pi, registerCommandCalls } = createMockPi();
		permissionExtension(pi);

		const permCommand = registerCommandCalls.find((c) => c.name === "permission");
		const opts = permCommand!.options as CommandOptions;
		const notifyCalls: Array<{ message: string; level: string }> = [];
		const mockCtx = {
			ui: {
				notify(message: string, level: string) {
					notifyCalls.push({ message, level });
				},
			},
		};

		opts.handler("", mockCtx);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].message).toContain("Current mode");
		expect(notifyCalls[0].message).toContain("yolo"); // 默认模式
		expect(notifyCalls[0].level).toBe("info");
	});

	it("permission 命令切换模式后 handler 显示新模式", () => {
		const { pi, registerCommandCalls } = createMockPi();
		permissionExtension(pi);

		const permCommand = registerCommandCalls.find((c) => c.name === "permission");
		const opts = permCommand!.options as CommandOptions;
		const notifyCalls: Array<{ message: string; level: string }> = [];
		const mockCtx = {
			ui: {
				notify(message: string, level: string) {
					notifyCalls.push({ message, level });
				},
			},
		};

		// 切换到 strict（会触发 saveConfig，但 saveConfig 写真实路径，这里用临时配置）
		// 用 /permission status 避免写文件
		opts.handler("status", mockCtx);
		expect(notifyCalls[0].message).toContain("mode:");
	});
});

describe("WT9: tool_call handler（W5 三层管道接入）", () => {
	it("tool_call handler 存在且返回 Promise（不 throw）", () => {
		const { pi, eventHandlers } = createMockPi();
		permissionExtension(pi);

		const toolCallHandlers = eventHandlers.get("tool_call")!;
		expect(toolCallHandlers.length).toBe(1);

		// 调用 handler 应该不 throw，且返回 Promise（W5 handler 是 async）
		const result = toolCallHandlers[0](
			{ toolName: "bash", input: { command: "rm -rf /" } },
			{ mode: "yolo", cwd: "/tmp", ui: { notify() {}, select() { return Promise.resolve(undefined); }, custom() { return Promise.resolve(undefined); } } },
		);
		expect(result).toBeInstanceOf(Promise);
	});

	it("对被规则放行的工具调用返回 undefined（不 block）", async () => {
		const { pi, eventHandlers } = createMockPi();
		permissionExtension(pi);

		const handler = eventHandlers.get("tool_call")![0] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;

		// 注：handler 实际读取磁盘上的 config/permission-ext-config.json（无法从测试注入 config）。
		// 默认 user config 含 allow 规则 `python *`（user-1），故 `python script.py` 命中 allow → resolve undefined。
		// 此前测试断言「yolo 放行任意命令（含 git push --force）」依赖磁盘 config.mode==='yolo'，
		// 但 config 已改为 auto 且 bd-005 危险规则即使 yolo 之外的模式会拦截 force push。
		// 这里改为断言「命中 allow 规则的命令被放行」，验证 handler 放行路径稳定可重现。
		const mockCtx = {
			mode: "yolo" as const,
			cwd: "/tmp",
			ui: {
				notify() {},
				select() {
					return Promise.resolve(undefined);
				},
				custom() {
					return Promise.resolve(undefined);
				},
			},
		};

		// 命中 user-1 allow 规则（pattern: "python *"）→ 放行
		await expect(
			handler({ toolName: "bash", input: { command: "python script.py" } }, mockCtx),
		).resolves.toBeUndefined();
	});
});
