// src/__tests__/bash-tool.test.ts —— M1 前台委托回归 + M2 background 分支接入 +
// M4 白名单强制后台（D3/D13/D14）与双模式 timeout 注入
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// mock pi 官方工厂：前台行为是委托（方案 B），测试断言「透传面」而非真实 spawn
// 行为——真实行为由 pi 上游保证 + 探针 P2 实测。
const { createBashToolDefinitionMock, officialExecuteMock, agentDirRef } = vi.hoisted(() => ({
	createBashToolDefinitionMock: vi.fn(),
	officialExecuteMock: vi.fn(),
	// 可变 agentDir：M4 配置用例按需切到临时目录写 <agentDir>/config/*.json
	agentDirRef: { dir: "/tmp/bte-fake-agent-dir" },
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	createBashToolDefinition: createBashToolDefinitionMock,
	getAgentDir: () => agentDirRef.dir,
}));

// mock spawn-background：background 分支的生命周期由 background-lifecycle.test.ts
// 真实测，这里只断言「分支路由正确 + 参数传递正确」。resolveBackgroundTimeoutSec
// 镜像真实实现（显式 > 配置默认 > 不限，M4 双参数签名）。
const { spawnBackgroundTaskMock, resolveTimeoutMock, isSubagentMock } = vi.hoisted(() => ({
	spawnBackgroundTaskMock: vi.fn(),
	resolveTimeoutMock: vi.fn((sec: number | undefined, defaultSec?: number) => {
		if (sec === undefined) return defaultSec;
		if (!Number.isFinite(sec) || sec <= 0) {
			throw new Error("Invalid timeout: must be a finite number of seconds");
		}
		return sec;
	}),
	isSubagentMock: vi.fn(() => false),
}));
vi.mock("../background/spawn-background.ts", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../background/spawn-background.ts")>();
	return {
		...orig,
		spawnBackgroundTask: spawnBackgroundTaskMock,
		resolveBackgroundTimeoutSec: resolveTimeoutMock,
	};
});
vi.mock("../background/subagent-guard.ts", () => ({
	isSubagentProcess: isSubagentMock,
}));

import { clearConfigCache } from "@zhushanwen/pi-llm-shared";

import { createBashOverrideToolDefinition } from "../bash-tool.ts";

// M4：临时 agentDir 生命周期——写配置用例切 agentDirRef，afterEach 统一还原 + 清缓存
const configTempDirs: string[] = [];

/** 切到全新临时 agentDir 并写入配置文件（loadBaseToolEnhanceConfig 读时刷新即生效）。 */
function useConfig(config: Record<string, unknown>): void {
	const dir = mkdtempSync(join(tmpdir(), "bte-bashtool-cfg-"));
	configTempDirs.push(dir);
	agentDirRef.dir = dir;
	const configPath = join(dir, "config", "base-tool-enhance-ext-config.json");
	mkdirSync(join(configPath, ".."), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

afterEach(() => {
	for (const dir of configTempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	}
	agentDirRef.dir = "/tmp/bte-fake-agent-dir";
	clearConfigCache();
});

function createOfficialFactoryResult(cwd: string) {
	return {
		name: "bash",
		label: "bash",
		description: `official description for ${cwd}`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
		parameters: { type: "object", properties: {} },
		execute: officialExecuteMock,
	};
}

function setupFactory() {
	createBashToolDefinitionMock.mockReset();
	officialExecuteMock.mockReset();
	spawnBackgroundTaskMock.mockReset();
	resolveTimeoutMock.mockClear();
	isSubagentMock.mockReset();
	isSubagentMock.mockReturnValue(false);
	resolveTimeoutMock.mockImplementation((sec: number | undefined, defaultSec?: number) => {
		if (sec === undefined) return defaultSec;
		if (!Number.isFinite(sec) || sec <= 0) {
			throw new Error("Invalid timeout: must be a finite number of seconds");
		}
		return sec;
	});
	createBashToolDefinitionMock.mockImplementation((_cwd: string) => createOfficialFactoryResult(_cwd));
}

const CWD = "/tmp/bte-workdir";

function createCtx() {
	return { cwd: CWD, sessionManager: { getSessionId: () => "sess-1" } };
}

describe("createBashOverrideToolDefinition", () => {
	it("overrides the builtin bash tool by name and passes through official label", () => {
		setupFactory();
		const tool = createBashOverrideToolDefinition();
		expect(tool.name).toBe("bash");
		expect(tool.label).toBe("bash");
	});

	it("extends the official schema with optional background (command required, timeout/background optional)", () => {
		setupFactory();
		const tool = createBashOverrideToolDefinition();
		// typebox JSON Schema 形态：Optional 键不进 required
		expect(tool.parameters.type).toBe("object");
		const params = tool.parameters as unknown as {
			required: string[];
			properties: Record<string, { type: string }>;
		};
		expect(params.required).toEqual(["command"]);
		expect(params.properties.command?.type).toBe("string");
		expect(params.properties.timeout?.type).toBe("number");
		expect(params.properties.background?.type).toBe("boolean");
	});

	it("rewrites description to cover background usage (task_id / bash_output / bash_kill / whitelist / timeout)", () => {
		setupFactory();
		const tool = createBashOverrideToolDefinition();
		expect(tool.description).not.toContain("official description");
		expect(tool.description).toContain("background: true");
		expect(tool.description).toContain("task_id");
		expect(tool.description).toContain("bash_output");
		expect(tool.description).toContain("bash_kill");
		// 白名单自动转后台 + timeout 显式值被尊重（除白名单强转后台例外）
		expect(tool.description).toContain("whitelist");
		expect(tool.description).toContain("timeout in seconds");
	});

	it("passes through official promptSnippet/promptGuidelines (system-prompt parity)", () => {
		setupFactory();
		const tool = createBashOverrideToolDefinition();
		expect(tool.promptSnippet).toBe("Execute bash commands (ls, grep, find, etc.)");
		expect(tool.promptGuidelines).toEqual([
			"You can inspect PI_* environment variables for current model and session details.",
		]);
	});

	it("passes through official renderCall/renderResult (TUI render parity, pi 0.84.1 fields)", () => {
		setupFactory();
		const renderCall = vi.fn();
		const renderResult = vi.fn();
		createBashToolDefinitionMock.mockImplementation(() => ({
			...createOfficialFactoryResult("render-probe"),
			renderCall,
			renderResult,
		}));
		const tool = createBashOverrideToolDefinition();
		// 引用级相等证明 delegate 的 render 闭包原样透传（未覆写未丢弃）——官方
		// renderCall（命令格式化）/ renderResult（elapsed 计时/富结果组件）是 TUI
		// 渲染面，独立 pi 用户安装本包后不降级为通用组件
		expect(tool.renderCall).toBe(renderCall);
		expect(tool.renderResult).toBe(renderResult);
	});

	it("delegates execute to the official factory execute with recognized fields only (background stripped)", async () => {
		setupFactory();
		const expectedResult = { content: [{ type: "text" as const, text: "hi" }], details: undefined };
		officialExecuteMock.mockResolvedValue(expectedResult);

		const tool = createBashOverrideToolDefinition();
		const ctx = createCtx();
		const signal = new AbortController().signal;
		const onUpdate = vi.fn();

		const result = await tool.execute(
			"call-1",
			{ command: "echo hi", timeout: 30 },
			signal,
			onUpdate,
			ctx as never,
		);

		// 前台委托：全部参数透传，返回值透传；background 是本包增量字段，不进官方入参
		expect(officialExecuteMock).toHaveBeenCalledTimes(1);
		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-1",
			{ command: "echo hi", timeout: 30 },
			signal,
			onUpdate,
			ctx,
		);
		expect(result).toBe(expectedResult);
		expect(spawnBackgroundTaskMock).not.toHaveBeenCalled();
	});

	it("delegates without timeout when absent (undefined preserved)", async () => {
		setupFactory();
		officialExecuteMock.mockResolvedValue({ content: [], details: undefined });
		const tool = createBashOverrideToolDefinition();

		await tool.execute("call-2", { command: "ls" }, undefined, undefined, createCtx() as never);

		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-2",
			{ command: "ls", timeout: undefined },
			undefined,
			undefined,
			expect.anything(),
		);
	});

	it("builds the delegate with ctx.cwd (authoritative) and caches per cwd", async () => {
		setupFactory();
		officialExecuteMock.mockResolvedValue({ content: [], details: undefined });
		const tool = createBashOverrideToolDefinition();

		// load 时刻初始 delegate 用 process.cwd()
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(1);
		expect(createBashToolDefinitionMock).toHaveBeenCalledWith(process.cwd());

		// execute 的 ctx.cwd 与缓存不一致 → 以 ctx.cwd 重建
		await tool.execute("c1", { command: "ls" }, undefined, undefined, { cwd: "/tmp/alt" } as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledWith("/tmp/alt");
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(2);

		// 同 cwd 复用缓存（不再新建）
		await tool.execute("c2", { command: "ls" }, undefined, undefined, { cwd: "/tmp/alt" } as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(2);

		// cwd 再变 → 重建
		await tool.execute("c3", { command: "ls" }, undefined, undefined, { cwd: "/tmp/alt2" } as never);
		expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(3);
	});
});

describe("background branch routing (M2)", () => {
	it("background:true routes to spawnBackgroundTask with ctx-derived paths and returns task_id message", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue({
			ok: true,
			task: {
				taskId: "bt-1724589012-a3f7",
				pid: 12345,
				command: "sleep 5 && echo done",
				outputFile: "/tmp/bte-fake-agent-dir/base-tool-enhance/sess-1/bt-1724589012-a3f7.log",
				registryPath: "/tmp/registry.json",
				startedAt: 1,
				state: "running",
				ownerPiPid: process.pid,
				sessionId: "sess-1",
			},
		});

		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute(
			"call-bg",
			{ command: "sleep 5 && echo done", background: true, timeout: 60 },
			new AbortController().signal,
			undefined,
			createCtx() as never,
		);

		// 不走前台委托
		expect(officialExecuteMock).not.toHaveBeenCalled();
		expect(spawnBackgroundTaskMock).toHaveBeenCalledWith({
			command: "sleep 5 && echo done",
			cwd: CWD,
			dataDir: "/tmp/bte-fake-agent-dir",
			sessionId: "sess-1",
			timeoutSec: 60,
			maxConcurrent: 8,
		});

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("bt-1724589012-a3f7");
		expect(text).toContain("pid: 12345");
		expect(text).toContain("Output file:");
		expect(text).toContain('bash_output {task_id:"bt-1724589012-a3f7"}');
	});

	it("background spawn failure surfaces the error", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue({
			ok: false,
			error: "Background task limit reached (max 8 concurrent).",
		});
		const tool = createBashOverrideToolDefinition();
		await expect(
			tool.execute("call-bg-err", { command: "x", background: true }, undefined, undefined, createCtx() as never),
		).rejects.toThrow(/limit reached/);
	});

	it("D14: subagent process ignores background and delegates to foreground", async () => {
		setupFactory();
		isSubagentMock.mockReturnValue(true);
		officialExecuteMock.mockResolvedValue({ content: [{ type: "text", text: "sync" }], details: undefined });

		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute(
			"call-sub",
			{ command: "echo sync", background: true },
			undefined,
			undefined,
			createCtx() as never,
		);

		expect(spawnBackgroundTaskMock).not.toHaveBeenCalled();
		expect(officialExecuteMock).toHaveBeenCalledTimes(1);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toBe("sync");
	});
});

// ──────────────────────── M4：白名单强制后台 + timeout 注入 ────────────────────────

function makeSpawnedTask(command: string) {
	return {
		ok: true as const,
		task: {
			taskId: "bt-1724589012-ffff",
			pid: 4242,
			command,
			outputFile: "/tmp/bte-fake-agent-dir/base-tool-enhance/sess-1/bt-1724589012-ffff.log",
			registryPath: "/tmp/registry.json",
			startedAt: 1,
			state: "running" as const,
			ownerPiPid: process.pid,
			sessionId: "sess-1",
		},
	};
}

function resultText(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content[0]?.type === "text" ? (content[0].text ?? "") : "";
}

describe("whitelist force-background routing (M4, D3/D13/D14)", () => {
	it("force-test 命中（background 缺省）→ 强制后台，result 注明 pattern 命中", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("npm test"));
		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute("call-f1", { command: "npm test" }, undefined, undefined, createCtx() as never);

		expect(officialExecuteMock).not.toHaveBeenCalled();
		expect(spawnBackgroundTaskMock).toHaveBeenCalledTimes(1);
		const text = resultText(result);
		expect(text).toContain("task_id: bt-1724589012-ffff");
		expect(text).toContain("Forced to background");
		expect(text).toContain("matched force-background whitelist pattern 'test' (npm test)");
		// 未带显式 timeout 时无「忽略」注记
		expect(text).not.toContain("Ignored explicit timeout");
	});

	it("D3：白名单命中无视显式 background:false", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("npx vitest run"));
		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute(
			"call-f2",
			{ command: "npx vitest run", background: false },
			undefined,
			undefined,
			createCtx() as never,
		);

		expect(officialExecuteMock).not.toHaveBeenCalled();
		expect(spawnBackgroundTaskMock).toHaveBeenCalledTimes(1);
		expect(resultText(result)).toContain("Forced to background");
	});

	it("D13：命中时忽略 LLM 显式 timeout（无配置默认 → 不限）且 result 注明", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("npm test"));
		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute(
			"call-f3",
			{ command: "npm test", timeout: 120 },
			undefined,
			undefined,
			createCtx() as never,
		);

		// 显式 120 被忽略、无配置默认 → timeoutSec undefined（不限）
		expect(spawnBackgroundTaskMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: undefined }));
		const text = resultText(result);
		expect(text).toContain("Ignored explicit timeout 120s");
		expect(text).toContain("unlimited");
	});

	it("D13 + 配置默认：忽略显式 120，取 backgroundTimeoutSeconds=300 并注明", async () => {
		setupFactory();
		useConfig({ backgroundTimeoutSeconds: 300 });
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("npm test"));
		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute(
			"call-f4",
			{ command: "npm test", timeout: 120 },
			undefined,
			undefined,
			createCtx() as never,
		);

		expect(spawnBackgroundTaskMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 300 }));
		const text = resultText(result);
		expect(text).toContain("Ignored explicit timeout 120s");
		expect(text).toContain("300s (config default)");
	});

	it("disableBuiltinForcePatterns:true → 白名单不命中，走前台委托", async () => {
		setupFactory();
		useConfig({ disableBuiltinForcePatterns: true });
		officialExecuteMock.mockResolvedValue({ content: [{ type: "text", text: "fg" }], details: undefined });
		const tool = createBashOverrideToolDefinition();
		await tool.execute("call-f5", { command: "npm test" }, undefined, undefined, createCtx() as never);

		expect(spawnBackgroundTaskMock).not.toHaveBeenCalled();
		expect(officialExecuteMock).toHaveBeenCalledTimes(1);
	});

	it("用户正则命中 → 强制后台且 result 引用用户 pattern 字面量", async () => {
		setupFactory();
		useConfig({ disableBuiltinForcePatterns: true, forceBackgroundPatterns: ["sleep \\d+"] });
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("sleep 999"));
		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute("call-f6", { command: "sleep 999" }, undefined, undefined, createCtx() as never);

		expect(spawnBackgroundTaskMock).toHaveBeenCalledTimes(1);
		expect(resultText(result)).toContain("matched force-background whitelist user pattern 'sleep \\d+'");
	});

	it("非命中 + 显式 background:true → 正常显式后台分支（非 forced 注记）", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("sleep 5"));
		const tool = createBashOverrideToolDefinition();
		const result = await tool.execute(
			"call-f7",
			{ command: "sleep 5", background: true },
			undefined,
			undefined,
			createCtx() as never,
		);

		expect(spawnBackgroundTaskMock).toHaveBeenCalledTimes(1);
		const text = resultText(result);
		expect(text).toContain("task_id: bt-1724589012-ffff");
		expect(text).not.toContain("Forced to background");
	});

	it("D14：subagent 降级全量——白名单不生效、background 忽略、显式 timeout 前台透传", async () => {
		setupFactory();
		isSubagentMock.mockReturnValue(true);
		officialExecuteMock.mockResolvedValue({ content: [{ type: "text", text: "sync" }], details: undefined });
		const tool = createBashOverrideToolDefinition();
		await tool.execute(
			"call-f8",
			{ command: "npm test", background: true, timeout: 120 },
			undefined,
			undefined,
			createCtx() as never,
		);

		expect(spawnBackgroundTaskMock).not.toHaveBeenCalled();
		expect(officialExecuteMock).toHaveBeenCalledWith(
			"call-f8",
			{ command: "npm test", timeout: 120 },
			undefined,
			undefined,
			expect.anything(),
		);
	});
});

describe("timeout injection dual-mode (M4, 优先级 LLM 显式 > 配置默认 > 不限)", () => {
	it("前台：未填 timeout + foregroundTimeoutSeconds=42 → 注入官方委托", async () => {
		setupFactory();
		useConfig({ foregroundTimeoutSeconds: 42 });
		officialExecuteMock.mockResolvedValue({ content: [], details: undefined });
		const tool = createBashOverrideToolDefinition();
		await tool.execute("t1", { command: "ls" }, undefined, undefined, createCtx() as never);

		expect(officialExecuteMock).toHaveBeenCalledWith("t1", { command: "ls", timeout: 42 }, undefined, undefined, expect.anything());
	});

	it("D14 × G3 正交：subagent 降级不关前台超时注入（未填 timeout → 配置默认照常注入前台委托）", async () => {
		// 锁行为：前台注入路径不检查 subagent（bash-tool.ts G3 语义）——降级只废
		// background/白名单，subagent 内长命令仍受全局前台默认超时挂死保护
		setupFactory();
		isSubagentMock.mockReturnValue(true);
		useConfig({ foregroundTimeoutSeconds: 42 });
		officialExecuteMock.mockResolvedValue({ content: [], details: undefined });
		const tool = createBashOverrideToolDefinition();
		await tool.execute(
			"t-sub-fg",
			{ command: "sleep 30", background: true },
			undefined,
			undefined,
			createCtx() as never,
		);

		expect(spawnBackgroundTaskMock).not.toHaveBeenCalled();
		expect(officialExecuteMock).toHaveBeenCalledWith(
			"t-sub-fg",
			{ command: "sleep 30", timeout: 42 },
			undefined,
			undefined,
			expect.anything(),
		);
	});

	it("前台：显式 7 优先于配置默认 42", async () => {
		setupFactory();
		useConfig({ foregroundTimeoutSeconds: 42 });
		officialExecuteMock.mockResolvedValue({ content: [], details: undefined });
		const tool = createBashOverrideToolDefinition();
		await tool.execute("t2", { command: "ls", timeout: 7 }, undefined, undefined, createCtx() as never);

		expect(officialExecuteMock).toHaveBeenCalledWith("t2", { command: "ls", timeout: 7 }, undefined, undefined, expect.anything());
	});

	it("前台：均未配置 → 不注入（timeout undefined = pi 原生不限时，D4）", async () => {
		setupFactory();
		officialExecuteMock.mockResolvedValue({ content: [], details: undefined });
		const tool = createBashOverrideToolDefinition();
		await tool.execute("t3", { command: "ls" }, undefined, undefined, createCtx() as never);

		expect(officialExecuteMock).toHaveBeenCalledWith("t3", { command: "ls", timeout: undefined }, undefined, undefined, expect.anything());
	});

	it("后台：未填 timeout + backgroundTimeoutSeconds=45 → 注入 spawn", async () => {
		setupFactory();
		useConfig({ backgroundTimeoutSeconds: 45 });
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("sleep 5"));
		const tool = createBashOverrideToolDefinition();
		await tool.execute("t4", { command: "sleep 5", background: true }, undefined, undefined, createCtx() as never);

		expect(spawnBackgroundTaskMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 45 }));
	});

	it("后台：显式 9 优先于配置默认 45", async () => {
		setupFactory();
		useConfig({ backgroundTimeoutSeconds: 45 });
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("sleep 5"));
		const tool = createBashOverrideToolDefinition();
		await tool.execute("t5", { command: "sleep 5", background: true, timeout: 9 }, undefined, undefined, createCtx() as never);

		expect(spawnBackgroundTaskMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 9 }));
	});

	it("后台：均未配置 → 不限（timeoutSec undefined）", async () => {
		setupFactory();
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("sleep 5"));
		const tool = createBashOverrideToolDefinition();
		await tool.execute("t6", { command: "sleep 5", background: true }, undefined, undefined, createCtx() as never);

		expect(spawnBackgroundTaskMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: undefined }));
	});

	it("并发上限走配置 maxConcurrentBackground（缺省 8）", async () => {
		setupFactory();
		useConfig({ maxConcurrentBackground: 3 });
		spawnBackgroundTaskMock.mockReturnValue(makeSpawnedTask("sleep 5"));
		const tool = createBashOverrideToolDefinition();
		await tool.execute("t7", { command: "sleep 5", background: true }, undefined, undefined, createCtx() as never);

		expect(spawnBackgroundTaskMock).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 3 }));
	});
});
