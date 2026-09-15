/**
 * CT 系列：classifier.ts 单元测试（createClassifier + classifyRisk 主流程）。
 *
 * C1a 收口后 classifier 的 LLM 调用走 llm-shared callLLM（依赖注入 deps.callLLM，
 * mock 返回 CallLLMResult 判别联合）。stopReason 归一化在 callLLM 层完成，
 * classifier 消费 ok:false + stopReason 透传字段保留日志区分。
 *
 * 重点验证：
 *  - C1-C4 主流程 happy path（allow/deny/ask + code fence）
 *  - C5-C7 fail-closed（resolveModel null / callLLM ok:false / 解析失败）
 *  - C8 timeout 兜底（callLLM 永挂 + 外层 race）
 *  - C9 abort signal
 *  - C10 timeout 秒→毫秒传递（callLLM opts.timeoutMs）
 *  - TC5（G3 语义承接）：callLLM ok:false + stopReason='error'/'aborted' → fallback，
 *    日志保留 abort/error 区分（onLog 含 aborted 或 stopReason）
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CallLLMResult } from "@zhushanwen/pi-llm-shared";
import { describe, expect, it, vi } from "vitest";

import type { ClassifierConfig, ToolInvocationContext } from "../../types.js";
import type { ClassifierDeps } from "../classifier.js";
import { createClassifier } from "../classifier.js";

// ──────────────────────── fixtures ────────────────────────

/** 测试用 Model<Api>（resolveModel 注入点直接返回 Model<Api>） */
const FIXED_MODEL_OBJ: Model<Api> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions" as Api,
	provider: "test-co",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

const CONFIG: ClassifierConfig = {
	enabled: true,
	model: "auto",
	timeout: 90,
	autoApproveLowRisk: true,
	autoDenyHighRisk: true,
};

const CTX: ToolInvocationContext = {
	toolName: "bash",
	command: "ls",
	cwd: "/tmp",
};

// ──────────────────────── mock helpers ────────────────────────

/** 构造「立即返回给定 CallLLMResult」的 mock callLLM */
function okResult(content: string): CallLLMResult {
	return { ok: true, content };
}

function failResult(error: string, stopReason?: "error" | "aborted"): CallLLMResult {
	return { ok: false, error, ...(stopReason !== undefined ? { stopReason } : {}) };
}

/** 构造「永不 resolve」的 mock callLLM（用于 timeout/abort 测试） */
function neverCallLLM(): ClassifierDeps["callLLM"] {
	return () => new Promise<CallLLMResult>(() => {});
}

function makeDeps(over: Partial<ClassifierDeps> = {}): ClassifierDeps {
	return {
		resolveModel: async () => FIXED_MODEL_OBJ,
		callLLM: async () => okResult('{"outcome":"allow","risk_level":"low","reasoning":"ok","confidence":0.9}'),
		...over,
	};
}

/** 捕获 callLLM 调用参数（model / opts）的 spy。 */
function capturingCallLLM(result: CallLLMResult): {
	spy: ClassifierDeps["callLLM"];
	getLastOpts: () => Parameters<ClassifierDeps["callLLM"]>[0] | undefined;
} {
	let lastOpts: Parameters<ClassifierDeps["callLLM"]>[0] | undefined;
	const spy: ClassifierDeps["callLLM"] = (opts) => {
		lastOpts = opts;
		return Promise.resolve(result);
	};
	return { spy, getLastOpts: () => lastOpts };
}

// ──────────────────────── C1-C4: happy path ────────────────────────

describe("CT1: happy path — callLLM ok:true 正常文本", () => {
	it("allow JSON → ClassifierResult.allow", async () => {
		const classifier = createClassifier(makeDeps({
			callLLM: async () => okResult('{"outcome":"allow","risk_level":"low","reasoning":"safe","confidence":0.9}'),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
		expect(r.risk_level).toBe("low");
		expect(r.confidence).toBeCloseTo(0.9);
	});

	it("deny JSON → ClassifierResult.deny", async () => {
		const classifier = createClassifier(makeDeps({
			callLLM: async () => okResult('{"outcome":"deny","risk_level":"high","reasoning":"rm -rf /","confidence":0.95}'),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("deny");
		expect(r.risk_level).toBe("high");
	});

	it("ask JSON → ClassifierResult.ask", async () => {
		const classifier = createClassifier(makeDeps({
			callLLM: async () => okResult('{"outcome":"ask","risk_level":"medium","reasoning":"uncertain","confidence":0.5}'),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
	});

	it("LLM 输出带 code fence → 正则提取仍成功", async () => {
		const classifier = createClassifier(makeDeps({
			callLLM: async () => okResult('```json\n{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.8}\n```'),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
	});
});

// ──────────────────────── C5-C7: fail-closed ────────────────────────

describe("CT2: fail-closed 路径", () => {
	it("C5: resolveModel 返回 null → fallback ask（不调 callLLM）", async () => {
		const callLLM = vi.fn(async () => okResult("x"));
		const classifier = createClassifier(makeDeps({
			resolveModel: async () => null,
			callLLM,
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
		expect(r.confidence).toBe(0);
		expect(callLLM).not.toHaveBeenCalled();
	});

	it("C6: callLLM 返回 ok:false（LLM 调用失败）→ fallback ask", async () => {
		const classifier = createClassifier(makeDeps({
			callLLM: async () => failResult("network down"),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
		expect(r.confidence).toBe(0);
	});

	it("C7: LLM 输出无法解析 → parser fallback ask", async () => {
		const classifier = createClassifier(makeDeps({
			callLLM: async () => okResult("totally not json"),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
		expect(r.reasoning).toContain("parse failed");
	});
});

// ──────────────────────── C8-C10: timeout / abort ────────────────────────

describe("CT3: timeout 与 abort 兜底", () => {
	it("C8: callLLM 永挂 + 短 timeout → fallback ask（不卡死）", async () => {
		// fake timers 模拟 1s 超时流逝（M3 同款正解），避免真实等待；timeout 单位是秒，
		// classifyRisk 内 * MILLIS_PER_SECOND 转 ms 后挂 setTimeout → 推进 1000ms 触发
		vi.useFakeTimers();
		try {
			const shortTimeoutConfig: ClassifierConfig = { ...CONFIG, timeout: 1 };
			const classifier = createClassifier(makeDeps({
				callLLM: neverCallLLM(),
			}));
			const classifyPromise = classifier.classifyRisk(CTX, shortTimeoutConfig);
			await vi.advanceTimersByTimeAsync(1000);
			const r = await classifyPromise;
			expect(r.outcome).toBe("ask");
		} finally {
			vi.useRealTimers();
		}
	});

	it("C9: abort signal 已 abort → 立刻 fallback ask", async () => {
		const ac = new AbortController();
		ac.abort();
		const classifier = createClassifier(makeDeps({
			callLLM: neverCallLLM(),
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG, ac.signal);
		expect(r.outcome).toBe("ask");
	});

	it("C10: timeout=0 → 不设外层超时，callLLM 正常返回", async () => {
		const noTimeoutConfig: ClassifierConfig = { ...CONFIG, timeout: 0 };
		const classifier = createClassifier(makeDeps());
		const r = await classifier.classifyRisk(CTX, noTimeoutConfig);
		expect(r.outcome).toBe("allow");
	});
});

// ──────────────────────── TC5: stopReason 透传（G3 语义承接） ────────────────────────

describe("CT4 / TC5: callLLM ok:false + stopReason 透传 → fallback + 日志区分", () => {
	it("stopReason='error' → fallback ask + onLog 含 error 与 stopReason", async () => {
		const onLog = vi.fn();
		const classifier = createClassifier(makeDeps({
			callLLM: async () => failResult("API error: 429", "error"),
			onLog,
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		// 关键：ok:false（无论 stopReason）→ 不能当成功 allow
		expect(r.outcome).toBe("ask");
		expect(r.confidence).toBe(0);
		// 日志保留 stopReason 区分（G3 语义不丢）
		expect(onLog).toHaveBeenCalledWith(expect.stringContaining("stopReason=error"));
	});

	it("stopReason='aborted' → fallback ask + onLog 含 aborted（TC5 abort 路径）", async () => {
		const onLog = vi.fn();
		const classifier = createClassifier(makeDeps({
			callLLM: async () => failResult("aborted", "aborted"),
			onLog,
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
		expect(r.confidence).toBe(0);
		// abort 与 error 分开记（aborted 专用日志）
		expect(onLog).toHaveBeenCalledWith(expect.stringContaining("aborted"));
	});

	it("ok:false 无 stopReason（catch 路径）→ fallback + 日志含 failed", async () => {
		const onLog = vi.fn();
		const classifier = createClassifier(makeDeps({
			callLLM: async () => failResult("network timeout"),
			onLog,
		}));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("ask");
		expect(onLog).toHaveBeenCalledWith(expect.stringContaining("LLM call failed"));
	});

	it("ok:true（stopReason 正常或未设）→ 正常解析，不受 stopReason 兜底影响", async () => {
		const classifier = createClassifier(makeDeps());
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
	});
});

// ──────────────────────── CT5: callLLM opts 构造 ────────────────────────

describe("CT5: callLLM opts 构造（model/messages/timeoutMs/signal）", () => {
	it("callLLM 收到解析出的 model + systemPrompt + messages（单轮 user）", async () => {
		const { spy, getLastOpts } = capturingCallLLM(okResult('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}'));
		const classifier = createClassifier(makeDeps({ callLLM: spy }));
		const r = await classifier.classifyRisk(CTX, CONFIG);
		expect(r.outcome).toBe("allow");
		const opts = getLastOpts();
		expect(opts).toBeDefined();
		expect(opts?.model).toBe(FIXED_MODEL_OBJ);
		expect(opts?.systemPrompt.length).toBeGreaterThan(0);
		expect(opts?.messages).toHaveLength(1);
		expect(opts?.messages[0]?.role).toBe("user");
		expect(opts?.messages[0]?.content).toEqual([{ type: "text", text: expect.stringContaining("ls") }]);
	});

	it("timeout 秒→毫秒传递：CONFIG.timeout=90 → opts.timeoutMs=90000", async () => {
		const { spy, getLastOpts } = capturingCallLLM(okResult('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}'));
		const classifier = createClassifier(makeDeps({ callLLM: spy }));
		await classifier.classifyRisk(CTX, CONFIG);
		const opts = getLastOpts();
		expect(opts?.timeoutMs).toBe(90_000);
	});

	it("signal 透传：classifyRisk 的 signal 进 callLLM opts.signal（abort 双保险）", async () => {
		const { spy, getLastOpts } = capturingCallLLM(okResult('{"outcome":"allow","risk_level":"low","reasoning":"x","confidence":0.9}'));
		const classifier = createClassifier(makeDeps({ callLLM: spy }));
		const ac = new AbortController();
		await classifier.classifyRisk(CTX, CONFIG, ac.signal);
		const opts = getLastOpts();
		expect(opts?.signal).toBe(ac.signal);
	});
});
