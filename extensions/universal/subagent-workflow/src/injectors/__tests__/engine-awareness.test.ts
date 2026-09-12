// engine-awareness 单测（[engine-awareness U3]）
//
// 覆盖（设计 docs/design/subagent-engine-awareness-injection.md（已删除，git 可追溯）验收挂钩 D1/D1b/D2/D3/D5）：
// 1. normalizeEngineId：缺省/空白归一到 'pi'（单一权威源 registry.ts，直连导入）
// 2. buildEngineChangeNotice：§3.1 文案骨架、pi/非 pi 指路段分界、不含任何模型清单（D4）
// 3. runEngineAwarenessTurn 编排：
//    - 变更触发 apply + 通知（D2 顺序硬约束：提交缓存先于通知先于记账）
//    - applyRead 收到的参数与 readConfig 返回值引用相等（构造性同源，消灭双读分叉）
//    - 无变更无事
//    - 读失败保持 lastEngine 不动、不发通知（D5 态 3，防 torn write 伪通知）
//    - ENOENT（absent）= 合法缺省 pi，正常触发变更（D5 态 2）
//    - 首 turn lastEngine === undefined 静默基线化，无伪通知（D1b）
//    - 通知消息形态（customType / display / details，D3+D8 对齐 notifier 约定）
//    - 多 session 各自独立 lastEngine（per-session diff 基准互不干扰）

import { describe, expect, it } from "vitest";

import {
	buildEngineChangeNotice,
	ENGINE_CHANGE_CUSTOM_TYPE,
	runEngineAwarenessTurn,
	type EngineAwarenessDeps,
	type EngineAwarenessOutcome,
} from "../engine-awareness";
// dev 1b05be6f9 删壳 engine-awareness 的 normalizeEngineId 再导出面后，测试直连
// core barrel（与生产 engine-awareness.ts 的 import 形态一致）
import { normalizeEngineId } from "@zhushanwen/subagent-core";
import type { GlobalConfigReadResult } from "@zhushanwen/subagent-core";

// ── 测试数据 ────────────────────────────────────────────

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

// ── normalizeEngineId ──────────────────────────────────

describe("normalizeEngineId", () => {
	it("undefined 缺省归一到 'pi'", () => {
		expect(normalizeEngineId(undefined)).toBe("pi");
	});

	it("空白字符串归一到 'pi'（sanitize 会拦非字符串，但防御空白透传）", () => {
		expect(normalizeEngineId("   ")).toBe("pi");
	});

	it("非 pi 引擎透传", () => {
		expect(normalizeEngineId("zcode")).toBe("zcode");
	});
});

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
