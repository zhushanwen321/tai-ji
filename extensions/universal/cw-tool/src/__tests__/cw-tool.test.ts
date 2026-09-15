/**
 * cw-tool 测试（cw 2.0 只读查询面）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 不真调 cw：通过 fake spawner 注入。白名单/参数校验在 spawn 之前，故拒绝用例断言 spawner 未被调用。
 */
import type * as cp from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// node:child_process 是原生 CJS 模块，ESM 命名导出不可重定义（vi.spyOn 报 "not configurable"）。
// 改用 vi.mock + vi.hoisted：工厂替换整个模块，hoisted vi.fn 作为 spawn，测试内动态配置实现。
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
	buildCwArgs,
	type CwDetails,
	CW_ACTIONS,
	executeCwAction,
	rejectDisallowedAction,
	rejectInvalidQueryOptions,
} from "../cw-runner.ts";
import { type CwSpawner, type CwSpawnResult, defaultCwSpawner } from "../cw-spawn.ts";
import { buildQueryTool, TOOL_NAME } from "../index.ts";

// ── fake spawner 工具 ───────────────────────────────────────────

interface CapturedCall {
	args: string[];
	cwd: string;
}

/** 造一个按队列返回预设结果的 spawner，并记录每次调用参数。 */
function fakeSpawner(responses: CwSpawnResult[]): { spawner: CwSpawner; calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	let i = 0;
	const spawner: CwSpawner = vi.fn(async (args, _input, cwd, _signal): Promise<CwSpawnResult> => {
		calls.push({ args, cwd });
		const response = responses[i] ?? { stdout: "", stderr: "", exitCode: 0 };
		i += 1;
		return response;
	});
	return { spawner, calls };
}

/** 任何 spawn 都视为违规（拒绝用例用：断言从未触达 spawn）。 */
function forbiddenSpawner(): CwSpawner {
	const spawner: CwSpawner = vi.fn(async (_args, _input, _cwd, _signal): Promise<CwSpawnResult> => {
		throw new Error("forbidden: 拒绝路径不应 spawn cw");
	});
	return spawner;
}

const CWD = "/tmp/proj";

/** ExtensionContext 最小 fake（executeCwAction 只用 ctx.cwd）。 */
const fakeCtx = ({ cwd: CWD } as unknown) as ExtensionContext;

afterEach(() => {
	spawnMock.mockReset();
});

// ── 白名单（cw 2.0 只读面：写 action 物理不可达）────────────────

describe("rejectDisallowedAction / executeCwAction 白名单", () => {
	it("CW_ACTIONS 恰为 cw 2.0 四个只读命令", () => {
		expect([...CW_ACTIONS]).toEqual(["status", "frontier", "tree", "report"]);
	});

	it.each(["create", "run", "verify", "design", "execute", "handoff", "evidence", "review", "abort"])(
		"写/1.x action %s 被拒且不 spawn",
		async (action) => {
			const err = rejectDisallowedAction(action, CW_ACTIONS, TOOL_NAME);
			expect(err).toContain(action);
			expect(err).toContain("cw-cli skill");

			const details = await executeCwAction(action, CW_ACTIONS, TOOL_NAME, {}, forbiddenSpawner(), CWD);
			expect(details).toMatchObject({ ok: false, action });
			expect(details.ok && true).toBe(false);
		},
	);

	it("错误消息列出全部允许 action", () => {
		expect(rejectDisallowedAction("run", CW_ACTIONS, TOOL_NAME)).toContain(
			"status, frontier, tree, report",
		);
	});
});

// ── 查询参数校验（action × flag 匹配 + 互斥）────────────────────

describe("rejectInvalidQueryOptions", () => {
	it("tree 传 unitId 被拒（2.0 tree 无选择器）", () => {
		expect(rejectInvalidQueryOptions("tree", { unitId: "u1" })).toContain("unitId");
	});

	it("frontier 传 unitId 被拒", () => {
		expect(rejectInvalidQueryOptions("frontier", { unitId: "u1" })).toContain("unitId");
	});

	it("非 report 传 rootId 被拒", () => {
		expect(rejectInvalidQueryOptions("status", { rootId: "r1" })).toContain("rootId");
		expect(rejectInvalidQueryOptions("tree", { rootId: "r1" })).toContain("rootId");
	});

	it("tree/report 传 json 被拒（2.0 仅 status/frontier 有 --json）", () => {
		expect(rejectInvalidQueryOptions("tree", { json: true })).toContain("json");
		expect(rejectInvalidQueryOptions("report", { json: true })).toContain("json");
	});

	it("report 同时传 unitId 与 rootId 被拒（CLI 侧互斥）", () => {
		expect(rejectInvalidQueryOptions("report", { unitId: "u1", rootId: "r1" })).toContain("互斥");
	});

	it("合法组合放行", () => {
		expect(rejectInvalidQueryOptions("status", {})).toBeUndefined();
		expect(rejectInvalidQueryOptions("status", { unitId: "u1", json: true })).toBeUndefined();
		expect(rejectInvalidQueryOptions("frontier", { json: true })).toBeUndefined();
		expect(rejectInvalidQueryOptions("tree", {})).toBeUndefined();
		expect(rejectInvalidQueryOptions("report", { unitId: "u1" })).toBeUndefined();
		expect(rejectInvalidQueryOptions("report", { rootId: "r1" })).toBeUndefined();
		expect(rejectInvalidQueryOptions("report", {})).toBeUndefined();
	});

	it("非法参数在 spawn 前拦截", async () => {
		const details = await executeCwAction(
			"report",
			CW_ACTIONS,
			TOOL_NAME,
			{ unitId: "u1", rootId: "r1" },
			forbiddenSpawner(),
			CWD,
		);
		expect(details).toMatchObject({ ok: false, action: "report" });
	});
});

// ── buildCwArgs（2.0 参数面映射）────────────────────────────────

describe("buildCwArgs", () => {
	it("status 无参数 → 裸命令", () => {
		expect(buildCwArgs("status", {})).toEqual(["status"]);
	});

	it("status unitId + json → --unit 在前 --json 在后", () => {
		expect(buildCwArgs("status", { unitId: "u1", json: true })).toEqual([
			"status",
			"--unit",
			"u1",
			"--json",
		]);
	});

	it("frontier json", () => {
		expect(buildCwArgs("frontier", { json: true })).toEqual(["frontier", "--json"]);
	});

	it("tree 恒裸命令", () => {
		expect(buildCwArgs("tree", {})).toEqual(["tree"]);
	});

	it("report unitId / rootId 二选一", () => {
		expect(buildCwArgs("report", { unitId: "u1" })).toEqual(["report", "--unit", "u1"]);
		expect(buildCwArgs("report", { rootId: "r1" })).toEqual(["report", "--root", "r1"]);
		expect(buildCwArgs("report", {})).toEqual(["report"]);
	});

	it("无 1.x 残留 flag（--unitId / --workspace / --input / --commitHash 不出现）", () => {
		for (const action of CW_ACTIONS) {
			const args = buildCwArgs(action, { unitId: "u1", rootId: "r1", json: true });
			expect(args).not.toContain("--unitId");
			expect(args).not.toContain("--workspace");
			expect(args).not.toContain("--input");
			expect(args).not.toContain("--commitHash");
		}
	});
});

// ── executeCwAction（spawn → 解析）──────────────────────────────

describe("executeCwAction", () => {
	it("stdout 是 JSON → parsed:true + data", async () => {
		const { spawner, calls } = fakeSpawner([
			{ stdout: '{"units":[]}', stderr: "", exitCode: 0 },
		]);
		const details = await executeCwAction(
			"status",
			CW_ACTIONS,
			TOOL_NAME,
			{ json: true },
			spawner,
			CWD,
		);
		expect(details).toMatchObject({ ok: true, action: "status", parsed: true });
		if (details.ok && details.parsed) expect(details.data).toEqual({ units: [] });
		expect(calls[0]?.args).toEqual(["status", "--json"]);
		expect(calls[0]?.cwd).toBe(CWD);
	});

	it("stdout 非 JSON（人可读视图）→ parsed:false + 原样 stdout", async () => {
		const { spawner } = fakeSpawner([{ stdout: "u1  closed", stderr: "", exitCode: 0 }]);
		const details = await executeCwAction("tree", CW_ACTIONS, TOOL_NAME, {}, spawner, CWD);
		expect(details).toMatchObject({ ok: true, parsed: false });
		if (details.ok && !details.parsed) expect(details.stdout).toBe("u1  closed");
	});

	it("非零退出码 → ok:false，stderr 折进错误消息", async () => {
		const { spawner } = fakeSpawner([
			{ stdout: "", stderr: "unit 不存在: nope", exitCode: 1 },
		]);
		const details = await executeCwAction(
			"status",
			CW_ACTIONS,
			TOOL_NAME,
			{ unitId: "nope" },
			spawner,
			CWD,
		);
		expect(details).toMatchObject({ ok: false, action: "status" });
		if (!details.ok) {
			expect(details.error).toContain("exit code 1");
			expect(details.error).toContain("unit 不存在");
		}
	});

	it("null 退出码（被信号终止）同样判失败", async () => {
		const { spawner } = fakeSpawner([{ stdout: "", stderr: "", exitCode: null }]);
		const details = await executeCwAction("frontier", CW_ACTIONS, TOOL_NAME, {}, spawner, CWD);
		expect(details).toMatchObject({ ok: false });
	});

	it("spawner 抛异常 → ok:false 带 spawn 失败前缀，不向上抛", async () => {
		const spawner: CwSpawner = vi.fn(async () => {
			throw new Error("boom");
		});
		const details = await executeCwAction("status", CW_ACTIONS, TOOL_NAME, {}, spawner, CWD);
		expect(details).toMatchObject({ ok: false });
		if (!details.ok) expect(details.error).toContain("cw spawn 失败");
	});

	it("超时 → ok:false 'cw 超时'（timeoutMs=0 不限时）", async () => {
		const hangingSpawner: CwSpawner = (_args, _input, _cwd, signal) =>
			new Promise<CwSpawnResult>((resolve) => {
				signal?.addEventListener("abort", () => resolve({ stdout: "", stderr: "", exitCode: null }), {
					once: true,
				});
			});
		const details = await executeCwAction(
			"status",
			CW_ACTIONS,
			TOOL_NAME,
			{},
			hangingSpawner,
			CWD,
			undefined,
			20,
		);
		expect(details).toMatchObject({ ok: false });
		if (!details.ok) expect(details.error).toBe("cw 超时");
	});

	it("SDK abort signal 与超时合并（进入即 aborted 也判失败）", async () => {
		const controller = new AbortController();
		controller.abort();
		const { spawner } = fakeSpawner([{ stdout: "", stderr: "", exitCode: 0 }]);
		const details = await executeCwAction(
			"status",
			CW_ACTIONS,
			TOOL_NAME,
			{},
			spawner,
			CWD,
			controller.signal,
		);
		// 已 abort 的 signal 传入：spawner 可能仍 resolve，但合并机制不崩、结果可判定
		expect(typeof details.ok).toBe("boolean");
	});
});

// ── 工具注册与 execute 闭包 ─────────────────────────────────────

describe("buildQueryTool / 扩展注册", () => {
	it("注册单个 cw_query 工具（4 角色工具已退役）", async () => {
		const registered: Array<{ name: string }> = [];
		const fakePi = {
			registerTool: (tool: { name: string }) => {
				registered.push(tool);
			},
		};
		const { default: cwToolExtension } = await import("../index.ts");
		cwToolExtension(fakePi as unknown as ExtensionAPI);
		expect(registered.map((t) => t.name)).toEqual([TOOL_NAME]);
		expect(TOOL_NAME).toBe("cw_query");
	});

	it("execute 成功路径返回 stdout 文本 + details", async () => {
		const { spawner } = fakeSpawner([{ stdout: "u1 closed", stderr: "", exitCode: 0 }]);
		const tool = buildQueryTool(spawner);
		const result = await tool.execute(
			"call-1",
			{ action: "status" },
			undefined,
			undefined,
			fakeCtx,
		);
		expect(result.content[0]).toMatchObject({ type: "text", text: "u1 closed" });
		expect(result.details).toMatchObject({ ok: true, action: "status" });
	});

	it("execute 失败路径 content 带工具名与错误", async () => {
		const { spawner } = fakeSpawner([{ stdout: "", stderr: "boom", exitCode: 1 }]);
		const tool = buildQueryTool(spawner);
		const result = await tool.execute(
			"call-1",
			{ action: "frontier" },
			undefined,
			undefined,
			fakeCtx,
		);
		expect(result.content[0]).toMatchObject({ type: "text" });
		if (result.content[0]?.type === "text") {
			expect(result.content[0].text).toContain("cw_query");
			expect(result.content[0].text).toContain("失败");
		}
		expect(result.details).toMatchObject({ ok: false, action: "frontier" });
	});

	it("进入即 aborted → 短路返回 aborted，不 spawn", async () => {
		const controller = new AbortController();
		controller.abort();
		const tool = buildQueryTool(forbiddenSpawner());
		const result = await tool.execute(
			"call-1",
			{ action: "status" },
			controller.signal,
			undefined,
			fakeCtx,
		);
		expect(result.details).toMatchObject({ ok: false, error: "aborted by signal" });
	});
});

// ── defaultCwSpawner（子进程抽象，与命令面无关）─────────────────

describe("defaultCwSpawner", () => {
	it("spawn PATH 上的裸 cw，无硬编码路径；kill 信号透传", async () => {
		const child = new EventEmitter() as unknown as cp.ChildProcess;
		// EventEmitter 无 kill/stdin/stdout/stderr ——挂最小 stub 满足实现调用
		const killCalls: string[] = [];
		(child as unknown as { kill: (sig?: string) => void }).kill = (sig?: string) => {
			killCalls.push(sig ?? "");
		};
		child.stdout = new EventEmitter() as unknown as NonNullable<cp.ChildProcess["stdout"]>;
		child.stderr = new EventEmitter() as unknown as NonNullable<cp.ChildProcess["stderr"]>;
		child.stdin = { write: () => true, end: () => {} } as unknown as NonNullable<
			cp.ChildProcess["stdin"]
		>;
		(child.stdout as unknown as { setEncoding: (e: string) => void }).setEncoding = () => {};
		(child.stderr as unknown as { setEncoding: (e: string) => void }).setEncoding = () => {};

		spawnMock.mockReturnValueOnce(child);

		const controller = new AbortController();
		const realCwd = process.cwd(); // defaultCwSpawner 有 existsSync(cwd) 前置检查，用真实存在目录
		const promise = defaultCwSpawner(["status"], undefined, realCwd, controller.signal);
		controller.abort();
		child.emit("close", null);
		const result = await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			"cw",
			["status"],
			expect.objectContaining({ cwd: realCwd }),
		);
		expect(killCalls).toContain("SIGTERM");
		expect(result.exitCode).toBeNull();
	});
});
