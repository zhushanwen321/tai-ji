// engine-awareness 单测（[engine-awareness U3]；engine 域合并宿主）
//
// 覆盖（设计 docs/design/subagent-engine-awareness-injection.md（已删除，git 可追溯）
// 验收挂钩 D1/D1b/D2/D3/D4/D5/D7/D8）：
// 1. buildEngineChangeNotice：§3.1 文案骨架、pi/非 pi 指路段分界、不含任何模型清单（D4）
// 2. runEngineAwarenessTurn 编排：
//    - 变更触发 apply + 通知（D2 顺序硬约束：提交缓存先于通知先于记账）
//    - applyRead 收到的参数与 readConfig 返回值引用相等（构造性同源，消灭双读分叉）
//    - 无变更无事 / 读失败保持 lastEngine 不动（D5 态 3）/ ENOENT=合法缺省（D5 态 2）
//    - 首 turn 静默基线化（D1b）/ 通知消息形态（D3+D8）/ 多 session 独立 lastEngine
// 3. 引擎切换只变尾部（A8 前置）：provider models 段前缀不变，变化只发生在链尾
//    engine 段——断的是「切换前后 prompt 的稳定头部逐字节不变」，复刻 index.ts
//    装配形态（BASE + provider models 段 + engine 追加段）；注册序本身由
//    src/__tests__/injector-chain-order.test.ts 的源码锚点守卫。
// 4. setupModelListInjector handler（provider models 段生产渲染路径）：注入 append /
//    空列表不干预链 / registry 异常 fail-safe。
// 5. formatModelList guide 全量快照：MODEL_LIST_GUIDE 是壳自有文案，core 测试用假
//    guide 不锁本文案——此处是唯一字节锁（guide 改写即红灯）。
//
// normalizeEngineId 缺省归一契约（undefined/空白 → 'pi'、非 pi 透传）归 core
// registry.test.ts（单一权威源所在地直测）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildEngineModelsPromptAppend,
	buildSubagentEngineSection,
	formatModelList,
	type EnginePort,
	type GlobalConfigReadResult,
	type ModelEntry,
} from "@zhushanwen/subagent-core";
import { clearEngines, registerEngine } from "@zhushanwen/subagent-core/execution/engine/registry.ts";

import {
	buildEngineChangeNotice,
	ENGINE_CHANGE_CUSTOM_TYPE,
	runEngineAwarenessTurn,
	type EngineAwarenessDeps,
	type EngineAwarenessOutcome,
} from "../engine-awareness";
import { MODEL_LIST_GUIDE, setupModelListInjector } from "../model-list-injector.ts";

// ── 测试数据（engine-awareness 编排面）──────────────────

/** ok 态读取结果工厂（config 形状与 sanitize 输出一致）。 */
function okRead(defaultEngine: string | undefined): GlobalConfigReadResult {
	return {
		status: "ok",
		config: { version: 1, maxConcurrent: 6, ...(defaultEngine !== undefined ? { defaultEngine } : {}) },
	};
}

/** 调用序记录 + 发送捕获的 deps 工厂。 */
function makeDeps(overrides: Partial<EngineAwarenessDeps> = {}) {
	const calls: string[] = [];
	const sent: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
	const applied: GlobalConfigReadResult[] = [];
	let lastEngine: string | undefined;
	const deps: EngineAwarenessDeps = {
		readConfig: () => okRead(undefined),
		applyRead: (read) => {
			calls.push("apply");
			applied.push(read);
		},
		sendMessage: (message) => {
			calls.push("send");
			sent.push(message);
		},
		getLastEngine: () => lastEngine,
		setLastEngine: (engine) => {
			calls.push(`set:${engine}`);
			lastEngine = engine;
		},
		...overrides,
	};
	return { deps, calls, sent, applied, getLast: () => lastEngine };
}

// ── buildEngineChangeNotice（D4 不含模型清单）────────────

describe("buildEngineChangeNotice", () => {
	it("pi 目标：§3.1 文案骨架（zcode → pi），指向 <available_provider_models>", () => {
		const content = buildEngineChangeNotice("zcode", "pi");
		expect(content).toBe(
			[
				"Subagent default engine changed: zcode → pi (effective this turn).",
				"Use pi-registry ids from <available_provider_models> for explicit models;",
				"omit `model` to inherit. The <current_subagent_engine> section reflects the current state.",
			].join("\n"),
		);
	});

	it("非 pi 目标：指向该引擎清单段 <available_<engine>_models>", () => {
		const content = buildEngineChangeNotice("pi", "zcode");
		expect(content).toContain("Subagent default engine changed: pi → zcode (effective this turn).");
		expect(content).toContain("<available_zcode_models>");
		expect(content).not.toContain("<available_provider_models>");
	});

	it("不含任何模型清单（无 <model> 标签 / 无 provider id 形态，D4）", () => {
		for (const to of ["pi", "zcode"]) {
			const content = buildEngineChangeNotice("zcode", to);
			expect(content).not.toContain("<model>");
			// provider id 形态：zai-coding-cn/glm-5.3、builtin:bigmodel-coding-plan/... 等
			expect(content).not.toMatch(/[a-z][\w-]*\/[\w.-]+/i);
			expect(content).not.toContain("builtin:");
		}
	});
});

// ── runEngineAwarenessTurn：变更编排 ─────────────────────

describe("runEngineAwarenessTurn", () => {
	it("变更触发 apply + 通知 + 记账，顺序硬约束 apply → send → set（D2）", () => {
		const read = okRead("pi");
		const { deps, calls, sent, applied } = makeDeps({
			readConfig: () => read,
			getLastEngine: () => "zcode",
		});
		const result = runEngineAwarenessTurn(deps);
		expect(result).toEqual({ outcome: "changed", from: "zcode", to: "pi" });
		expect(calls).toEqual(["apply", "send", "set:pi"]);
		// 构造性同源：提交到路由缓存的就是本次读取返回的同一对象（非重读、非拷贝）
		expect(applied[0]).toBe(read);
		expect(sent).toHaveLength(1);
		expect(sent[0].customType).toBe(ENGINE_CHANGE_CUSTOM_TYPE);
		expect(sent[0].content).toContain("zcode → pi");
	});

	it("通知消息形态对齐 notifier 约定（display:true + details 携带 from/to，D3/D8）", () => {
		const { deps, sent } = makeDeps({
			readConfig: () => okRead("zcode"),
			getLastEngine: () => "pi",
		});
		runEngineAwarenessTurn(deps);
		expect(sent[0].display).toBe(true);
		expect(sent[0].details).toEqual({ from: "pi", to: "zcode" });
	});

	it("无变更无事：零 apply 零通知零写入", () => {
		const { deps, calls, sent } = makeDeps({
			readConfig: () => okRead("zcode"),
			getLastEngine: () => "zcode",
		});
		const result: EngineAwarenessOutcome = runEngineAwarenessTurn(deps);
		expect(result).toEqual({ outcome: "unchanged", engine: "zcode" });
		expect(calls).toEqual([]);
		expect(sent).toHaveLength(0);
	});

	it("读失败保持 lastEngine 不动、不 apply 不通知（D5 态 3）", () => {
		let lastEngine: string | undefined = "zcode";
		const { deps, calls, sent } = makeDeps({
			readConfig: () => ({ status: "failed", reason: "Unexpected token in JSON" }),
			getLastEngine: () => lastEngine,
			setLastEngine: (engine) => {
				lastEngine = engine;
			},
		});
		const result = runEngineAwarenessTurn(deps);
		expect(result).toEqual({ outcome: "read-failed", reason: "Unexpected token in JSON" });
		expect(calls).toEqual([]);
		expect(sent).toHaveLength(0);
		expect(lastEngine).toBe("zcode");
	});

	it("ENOENT（absent）= 合法缺省 pi：正常触发变更（D5 态 2）", () => {
		const read: GlobalConfigReadResult = { status: "absent", config: { version: 1, maxConcurrent: 6 } };
		const { deps, calls, sent, applied } = makeDeps({
			readConfig: () => read,
			getLastEngine: () => "zcode",
		});
		const result = runEngineAwarenessTurn(deps);
		expect(result).toEqual({ outcome: "changed", from: "zcode", to: "pi" });
		expect(calls).toEqual(["apply", "send", "set:pi"]);
		// absent 态同样构造性同源（删配置切回缺省也走同一次读取）
		expect(applied[0]).toBe(read);
		expect(sent[0].content).toContain("zcode → pi");
	});

	it("缺省 config（defaultEngine 字段缺失）diff 基准归一为 pi：zcode → 无字段 视为变更到 pi", () => {
		const { deps, sent } = makeDeps({
			readConfig: () => okRead(undefined),
			getLastEngine: () => "zcode",
		});
		const result = runEngineAwarenessTurn(deps);
		expect(result).toEqual({ outcome: "changed", from: "zcode", to: "pi" });
		expect(sent[0].content).toContain("zcode → pi");
	});
});

// ── runEngineAwarenessTurn：D1b 基线化 ───────────────────

describe("runEngineAwarenessTurn lastEngine 基线化（D1b）", () => {
	it("首 turn lastEngine === undefined：静默基线化为当前值，无伪通知，但 apply 先行（D1b 修订）", () => {
		const read = okRead("zcode");
		const { deps, calls, sent, applied, getLast } = makeDeps({
			readConfig: () => read,
			// session_start 初始化读失败 → lastEngine 未设置（undefined）
		});
		const result = runEngineAwarenessTurn(deps);
		expect(result).toEqual({ outcome: "baseline", engine: "zcode" });
		// D1b 修订：基线分支必须先提交读取结果把 Service 缓存对齐到刚读到的现值——
		// 否则「session_start 读失败缓存回落 + 文件此后被修好」形态下，
		// 缓存/路由/状态段永停旧值且永不通知
		expect(calls).toEqual(["apply", "set:zcode"]);
		// 构造性同源：基线分支提交的也是本次读取的同一对象
		expect(applied[0]).toBe(read);
		expect(sent).toHaveLength(0);
		expect(getLast()).toBe("zcode");
	});

	it("基线化后再 turn 读到同值 → unchanged（基线生效，且 unchanged 仍零调用）", () => {
		let lastEngine: string | undefined;
		const { deps, calls, sent } = makeDeps({
			readConfig: () => okRead("zcode"),
			getLastEngine: () => lastEngine,
			setLastEngine: (engine) => {
				lastEngine = engine;
			},
		});
		expect(runEngineAwarenessTurn(deps)).toEqual({ outcome: "baseline", engine: "zcode" });
		expect(runEngineAwarenessTurn(deps)).toEqual({ outcome: "unchanged", engine: "zcode" });
		// setLastEngine 被本用例 override（写局部变量、不记录 calls），故 calls 仅剩
		// baseline 分支的 apply；unchanged 分支零调用
		expect(calls).toEqual(["apply"]);
		expect(sent).toHaveLength(0);
	});

	it("lastEngine === undefined 且读失败：连基线都不做，不写入不通知", () => {
		const { deps, calls, sent, getLast } = makeDeps({
			readConfig: () => ({ status: "failed", reason: "EACCES" }),
		});
		const result = runEngineAwarenessTurn(deps);
		expect(result).toEqual({ outcome: "read-failed", reason: "EACCES" });
		expect(calls).toEqual([]);
		expect(sent).toHaveLength(0);
		expect(getLast()).toBeUndefined();
	});
});

// ── 多 session 独立性 ──────────────────────────────────

describe("runEngineAwarenessTurn 多 session 独立 lastEngine", () => {
	/**
	 * 模拟 index.ts 装配形态：共享 per-session 状态 Map（sessionState），
	 * 每个 sid 一组 deps（getLastEngine/setLastEngine 绑定各自 sid）。
	 */
	function makeMultiSessionState() {
		const lastEngines = new Map<string, string | undefined>();
		const notices: Array<{ sid: string; content: string }> = [];
		function depsFor(sid: string, read: () => GlobalConfigReadResult): EngineAwarenessDeps {
			return {
				readConfig: read,
				applyRead: () => {},
				sendMessage: (message) => {
					notices.push({ sid, content: message.content });
				},
				getLastEngine: () => lastEngines.get(sid),
				setLastEngine: (engine) => {
					lastEngines.set(sid, engine);
				},
			};
		}
		return { lastEngines, notices, depsFor };
	}

	it("session1 检测变更不污染 session2 的基线（各自独立边沿）", () => {
		const { lastEngines, notices, depsFor } = makeMultiSessionState();
		const readZcode = (): GlobalConfigReadResult => okRead("zcode");
		const readPi = (): GlobalConfigReadResult => okRead("pi");

		// 各自首 turn 基线化
		const sid1 = depsFor("s1", readZcode);
		const sid2 = depsFor("s2", readPi);
		expect(runEngineAwarenessTurn(sid1)).toEqual({ outcome: "baseline", engine: "zcode" });
		expect(runEngineAwarenessTurn(sid2)).toEqual({ outcome: "baseline", engine: "pi" });

		// session1 的引擎切换（zcode → pi）：session1 收通知，session2 无感知
		const sid1After = depsFor("s1", readPi);
		expect(runEngineAwarenessTurn(sid1After)).toEqual({ outcome: "changed", from: "zcode", to: "pi" });
		// session2 再 turn：仍 unchanged，零通知
		const sid2After = depsFor("s2", readPi);
		expect(runEngineAwarenessTurn(sid2After)).toEqual({ outcome: "unchanged", engine: "pi" });

		expect(notices).toHaveLength(1);
		expect(notices[0].sid).toBe("s1");
		expect(lastEngines.get("s1")).toBe("pi");
		expect(lastEngines.get("s2")).toBe("pi");
	});
});

// ──────────────────────────────────────────────────────────────
// 引擎切换只变尾部（A8 前置）：复刻 index.ts 装配形态（BASE + provider models
// 段 + engine 追加段），断言切换前后稳定头部逐字节不变、engine 段恒居尾。
// 注册序事实由 injector-chain-order.test.ts 源码锚点守卫，本处不重复。
// ──────────────────────────────────────────────────────────────

/** pi registry 风格条目（provider models 段数据源；同时充当 ctx.modelRegistry 快照）。 */
const PROVIDER_ENTRIES: ModelEntry[] = [
	{
		provider: "zai-coding-cn",
		id: "glm-5.3",
		name: "GLM 5.3",
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
	},
	{
		provider: "minimax-cn",
		id: "MiniMax-M3",
		name: "MiniMax M3",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
	},
];

/** zcode 引擎清单（v2 registry 风格 id）。 */
const ZCODE_MODELS: Array<{ id: string; name?: string }> = [
	{ id: "builtin:bigmodel-coding-plan/GLM-5.3", name: "GLM-5.3" },
	{ id: "builtin:bigmodel-coding-plan/GLM-5.3-Flash" },
];

/** 模拟 pi 核心 system prompt（engine 追加段之外的全部内容）。 */
const BASE = "You are a coding agent.\n\n# System\nCore prompt body.";

/** index.ts 尾部追加模板的分隔符（`${event.systemPrompt}\n\n${append}`）。 */
const APPEND_SEPARATOR = "\n\n";

/**
 * engine handler 的追加段拼装（与 engine-awareness.ts setupEngineAwarenessInjector
 * 内 handler 同款：状态段 + 清单段、空段剔除、\n\n 连接）。复刻保真由
 * injector-chain-order.test.ts 的源码锚点断言保证。
 */
function composeEngineAppend(defaultEngine: string | undefined): string {
	return [buildSubagentEngineSection(defaultEngine), buildEngineModelsPromptAppend(defaultEngine)]
		.filter((part) => part !== "")
		.join("\n\n");
}

/** 合成一个 turn 的 system prompt 尾部：BASE + provider models 段 + engine 追加段。 */
function composeTurn(defaultEngine: string | undefined): string {
	const providerSection = formatModelList(PROVIDER_ENTRIES, { guide: MODEL_LIST_GUIDE });
	const afterProvider = providerSection === "" ? BASE : BASE + providerSection;
	const append = composeEngineAppend(defaultEngine);
	return append === "" ? afterProvider : `${afterProvider}${APPEND_SEPARATOR}${append}`;
}

/** 最大公共前缀长度（逐码元比较；用于「分叉点不早于稳定头部」断言）。 */
function commonPrefixLength(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

/** 最小 fake 引擎（engine 注入链只用 listModels；其余面走不到）。 */
function fakeEngine(id: string, models: Array<{ id: string; name?: string }>): EnginePort {
	return {
		id,
		capabilities: () => ({ conversation: "unsupported", steer: "unsupported", sandbox: "none" }),
		probe: async () => ({ ok: true, engineVersion: "test" }),
		run: async () => {
			throw new Error("not used in this test");
		},
		read: async () => ({ engineId: id, turns: [], source: "outcome-only" }),
		// 每次调用返回新数组实例（模拟 registry 每 turn 现值）——渲染必须与实例无关
		listModels: () => models.map((m) => ({ ...m })),
	};
}

/**
 * 断言「从 from 切到 to 时变化只发生在尾部 engine 段」：
 *   - provider models 段及其之前的头部逐字节不变（公共前缀 toBe 级断言）；
 *   - 剥离尾部 engine 追加段后两串余部逐字节相等且恰为稳定头部；
 *   - 分叉点不早于稳定头部末尾（差异绝不侵入 provider models 段）；
 *   - 切换后的引擎追加段恰居 prompt 尾部。
 */
function expectOnlyTailDiffers(from: string | undefined, to: string | undefined): void {
	const stableHead = BASE + formatModelList(PROVIDER_ENTRIES, { guide: MODEL_LIST_GUIDE });
	const before = composeTurn(from);
	const after = composeTurn(to);
	const beforeAppend = composeEngineAppend(from);
	const afterAppend = composeEngineAppend(to);

	expect(before).not.toBe(after);
	expect(before.startsWith(stableHead)).toBe(true);
	expect(after.startsWith(stableHead)).toBe(true);
	expect(before.slice(0, before.length - beforeAppend.length - APPEND_SEPARATOR.length)).toBe(
		stableHead,
	);
	expect(after.slice(0, after.length - afterAppend.length - APPEND_SEPARATOR.length)).toBe(
		stableHead,
	);
	expect(commonPrefixLength(before, after)).toBeGreaterThanOrEqual(stableHead.length);
	expect(after.endsWith(afterAppend)).toBe(true);
}

describe("引擎切换只变尾部（A8 前置：变化只断尾部 cache 前缀）", () => {
	beforeEach(() => {
		clearEngines();
		registerEngine("zcode", () => fakeEngine("zcode", ZCODE_MODELS));
	});

	afterEach(() => {
		clearEngines();
	});

	it("zcode → pi：provider models 段前缀不变，变化只发生在 engine 段（尾部）", () => {
		expectOnlyTailDiffers("zcode", "pi");
	});

	it("pi → zcode（反向切换）：同款只变尾部", () => {
		expectOnlyTailDiffers("pi", "zcode");
	});

	it("zcode → ghost（配置手误形态）：G4 降级段同样只替换尾部，不破坏前缀", () => {
		expectOnlyTailDiffers("zcode", "ghost");
	});
});

// ──────────────────────────────────────────────────────────────
// setupModelListInjector handler：provider models 段的生产渲染路径。
// model-list-injector 无模块级状态（每次 setup 注册新 handler），静态 import 直测。
// ──────────────────────────────────────────────────────────────

describe("setupModelListInjector", () => {
	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

	function setupWithRegistry(models: ModelEntry[], fail = false): Handler {
		const handlers: Record<string, Handler> = {};
		const pi = {
			on: (name: string, fn: Handler) => {
				handlers[name] = fn;
			},
		} as unknown as Parameters<typeof setupModelListInjector>[0];
		setupModelListInjector(pi);
		const registry = fail
			? { getAvailable: vi.fn(() => { throw new Error("registry boom"); }) }
			: { getAvailable: vi.fn(() => models) };
		const handler = handlers["before_agent_start"];
		if (!handler) throw new Error("before_agent_start handler not registered");
		return (event: unknown) => handler(event, { modelRegistry: registry });
	}

	it("注册 before_agent_start handler，注入 append 到 systemPrompt 尾部", async () => {
		const handler = setupWithRegistry([entry()]);
		const result = (await handler({ systemPrompt: "BASE" }, {})) as {
			systemPrompt: string;
		};
		expect(result.systemPrompt.startsWith("BASE")).toBe(true);
		expect(result.systemPrompt).toContain("<available_provider_models>");
		expect(result.systemPrompt).toContain("zai-coding-cn/glm-5.2");
	});

	it("空模型列表返回 undefined（不返回 systemPrompt，不干预链）", async () => {
		const handler = setupWithRegistry([]);
		const result = await handler({ systemPrompt: "BASE" }, {});
		expect(result).toBeUndefined();
	});

	it("registry 异常被吞掉（fail-safe，不阻断 agent turn）", async () => {
		const handler = setupWithRegistry([], true);
		const result = await handler({ systemPrompt: "BASE" }, {});
		expect(result).toBeUndefined();
	});
});

// ── formatModelList guide 全量快照（壳自有文案唯一字节锁）──

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
	return {
		provider: "zai-coding-cn",
		id: "glm-5.2",
		name: "GLM 5.2",
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		...overrides,
	};
}

describe("formatModelList guide 全量快照（MODEL_LIST_GUIDE 唯一字节锁）", () => {
	it("guide 文案全量锚定：骨架 + 引导语 + 条目模板测试内硬编码快照（改写 MODEL_LIST_GUIDE 即红灯）", () => {
		// 渲染算法契约（排序/caps/转义/空列表）由 core injection-render byte-exact
		// parity 承载；本条锁壳侧 guide 文案本体（期望值不插值生产常量——文案两侧
		// 同源插值时漂移无守卫，故硬编码）
		const out = formatModelList([
			entry({ provider: "p", id: "m", name: "N" }),
		], { guide: MODEL_LIST_GUIDE });
		expect(out).toBe(
			`\n\n<available_provider_models>\nThe following models are available (auth-configured). Use these ids when delegating via the subagent/workflow \`model\` param ("provider/modelId" format) to match the task (e.g. vision models for screenshots, strong reasoners for architecture). Do NOT switch the main conversation model mid-session — per-call model override on delegates only (switching the main model is cache-hostile); use the /model command only when the user explicitly asks to change it.\n  <model><id>p/m</id><name>N</name><caps>reasoning</caps><contextWindow>200000</contextWindow></model>\n</available_provider_models>`,
		);
	});
});
