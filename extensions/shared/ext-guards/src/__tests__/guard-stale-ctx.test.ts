// src/__tests__/guard-stale-ctx.test.ts
//
// guardStaleCtx 单测——验收条款逐条对应（crash-resilience u1-ext-guard）：
//   a. 前置代际检查：isCtxStale=true → fn 不执行、stale 静默降级（返回 undefined）
//   b. 非 stale 错误原样上抛（守卫不吞真实 bug，同步 throw 与 async rejection 双面）
//   c. onStale 回调：前置命中无参调用；文案分诊命中携带错误调用；缺省走 TAIJI_AGENT_DEBUG=1 stderr
//   d. 文案子串匹配：STALE_CTX_MARKER 命中即静默（isCtxStale=false 时文案兜底仍生效）
//   e. async fn：stale rejection → resolve undefined；非 stale rejection → 原样 reject
//   f. 正常路径：返回值/resolve 值原样透传（守卫不改变正常路径，A2 负面验证的单测面）

import { describe, expect, it, vi, afterEach } from "vitest";

import { STALE_CTX_MARKER, guardStaleCtx } from "../index.ts";

/** pi 实装 stale 文案的完整形态（E1 崩溃堆栈原文，探针 PS-30 守卫其稳定性）。 */
const PI_STALE_ERROR = `This extension ctx is stale ${STALE_CTX_MARKER} or reload. Do not use a captured pi or command ctx after ctx.newSession().`;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("guardStaleCtx 前置代际检查（G1 形态）", () => {
	it("isCtxStale=true：fn 完全不执行，stale 静默降级返回 undefined", () => {
		const fn = vi.fn(() => "should not run");

		const result = guardStaleCtx(fn, {
			isCtxStale: () => true,
			onStale: () => {},
		});

		expect(fn).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	});

	it("前置命中：onStale 以无参调用（无捕获错误）", () => {
		const onStale = vi.fn();

		guardStaleCtx(
			() => {
				throw new Error("never reached");
			},
			{ isCtxStale: () => true, onStale },
		);

		expect(onStale).toHaveBeenCalledTimes(1);
		expect(onStale.mock.calls[0]).toHaveLength(0);
	});

	it("isCtxStale=false（缺省）：fn 正常执行、返回值原样透传（不改变正常路径）", () => {
		const shared = { ok: true };

		const result = guardStaleCtx(() => shared, { isCtxStale: () => false, onStale: () => {} });

		expect(result).toBe(shared);
	});
});

describe("guardStaleCtx 同步抛错分诊（F2 形态同步面）", () => {
	it("非 stale 错误：原样上抛（同一错误实例，不吞不包装）", () => {
		const boom = new Error("real bug: schema validation exploded");
		const onStale = vi.fn();

		expect(() =>
			guardStaleCtx(() => {
				throw boom;
			}, { isCtxStale: () => false, onStale }),
		).toThrow(boom);
		expect(onStale).not.toHaveBeenCalled();
	});

	it("文案子串匹配：isCtxStale=false 但错误文案含 STALE_CTX_MARKER → 静默降级（reload 盲区兜底）", () => {
		const onStale = vi.fn();

		const result = guardStaleCtx(() => {
			throw new Error(PI_STALE_ERROR);
		}, { isCtxStale: () => false, onStale });

		expect(result).toBeUndefined();
		expect(onStale).toHaveBeenCalledTimes(1);
		const captured: unknown = onStale.mock.calls[0]?.[0];
		expect(captured).toBeInstanceOf(Error);
		expect((captured as Error).message).toContain(STALE_CTX_MARKER);
	});

	it("非 Error 的 thrown 值含文案子串 → 同样分诊为 stale（String(value) 兜底）", () => {
		const onStale = vi.fn();

		const result = guardStaleCtx(() => {
			throw `wrapper: ${STALE_CTX_MARKER} (string throw)`;
		}, { onStale });

		expect(result).toBeUndefined();
		expect(onStale).toHaveBeenCalledTimes(1);
	});

	it("代际翻转兜底：抛错后 isCtxStale() 翻转为 true → 分诊 stale（in-flight 回调场景）", () => {
		let stale = false;
		const onStale = vi.fn();

		const result = guardStaleCtx(() => {
			stale = true; // 模拟同步窗口外的代际翻转（真实场景为 rejection 到达时已翻转）
			throw new Error("boom");
		}, { isCtxStale: () => stale, onStale });

		expect(result).toBeUndefined();
		expect(onStale).toHaveBeenCalledTimes(1);
	});
});

describe("guardStaleCtx async fn（F2 形态异步面，scheduler tick 迁移形态）", () => {
	it("stale rejection：resolve 为 undefined（不 reject，fire-and-forget 安全）", async () => {
		const onStale = vi.fn();

		const result = guardStaleCtx(async () => {
			throw new Error(PI_STALE_ERROR);
		}, { isCtxStale: () => false, onStale });

		await expect(result).resolves.toBeUndefined();
		expect(onStale).toHaveBeenCalledTimes(1);
	});

	it("非 stale rejection：原样 reject 给调用方的 .catch（同一错误实例）", async () => {
		const boom = new Error("async real bug");
		const onStale = vi.fn();

		const result = guardStaleCtx(async () => {
			throw boom;
		}, { isCtxStale: () => false, onStale });

		await expect(result).rejects.toThrow(boom);
		expect(onStale).not.toHaveBeenCalled();
	});

	it("async 正常路径：resolve 值原样透传", async () => {
		const result = guardStaleCtx(async () => "tick done", { onStale: () => {} });

		await expect(result).resolves.toBe("tick done");
	});
});

describe("guardStaleCtx onStale 缺省（默认 debug 日志）", () => {
	it("TAIJI_AGENT_DEBUG=1：stderr 写入守卫降级行（含 label 与错误文案）", () => {
		vi.stubEnv("TAIJI_AGENT_DEBUG", "1");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		guardStaleCtx(() => {
			throw new Error(PI_STALE_ERROR);
		}, { label: "pkg:scene" });

		expect(stderr).toHaveBeenCalledTimes(1);
		const line = String(stderr.mock.calls[0]?.[0]);
		expect(line).toContain("[ext-guards] stale ctx degraded (pkg:scene)");
		expect(line).toContain(STALE_CTX_MARKER);
	});

	it("TAIJI_AGENT_DEBUG 未设：静默（不写 stderr）", () => {
		vi.stubEnv("TAIJI_AGENT_DEBUG", "");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		guardStaleCtx(() => {
			throw new Error(PI_STALE_ERROR);
		});

		expect(stderr).not.toHaveBeenCalled();
	});
});
