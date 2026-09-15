// src/__tests__/ext-guards.test.ts
//
// oncePerProcess 单测——验收条款逐条对应（u-guards-pkg ①）：
//   a. key 隔离去重：不同 key 互不影响，各自首次调用执行
//   b. 同 key 双调 fn 仅执行一次
//   c. fn 抛错不释放 key：同 key 再调不再执行（每进程至多一次的字面语义）
//   d. 结果缓存形态：值原样重放（严格同一引用）、Promise 实例重放
//      （含 rejected Promise 缓存——不因 rejection 释放 key）
//
// 模块级 Map 是被测状态：测试间共享，每个用例用全文件唯一的 key 隔离。

import { describe, expect, it, vi } from "vitest";

import { oncePerProcess } from "../index.ts";

describe("oncePerProcess", () => {
	it("同 key 双调：fn 仅执行一次，两次返回同一结果", () => {
		const fn = vi.fn(() => ({ marker: "result" }));

		const first = oncePerProcess("dedupe:same-key", fn);
		const second = oncePerProcess("dedupe:same-key", fn);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});

	it("key 隔离：不同 key 互不影响，各自首次调用执行", () => {
		const fnA = vi.fn(() => "a");
		const fnB = vi.fn(() => "b");

		// 先各消费一次 keyA（含二次调用确认去重），keyB 的首次调用不受影响
		expect(oncePerProcess("dedupe:key-a", fnA)).toBe("a");
		expect(oncePerProcess("dedupe:key-a", fnA)).toBe("a");
		expect(oncePerProcess("dedupe:key-b", fnB)).toBe("b");

		expect(fnA).toHaveBeenCalledTimes(1);
		expect(fnB).toHaveBeenCalledTimes(1);
	});

	it("fn 同步抛错：错误原样上抛（不吞不包装），key 不释放——同 key 再调不再执行且重抛同一错误", () => {
		const boom = new Error("reap failed");
		const failing = vi.fn(() => {
			throw boom;
		});

		expect(() => oncePerProcess("dedupe:throws", failing)).toThrow(boom);

		// 再调换一个「本会成功」的 fn：若 key 被释放，它会执行并返回——这是本条
		// 的核心断言（失败不重置，双跑窗口不重新打开）
		const shouldNeverRun = vi.fn(() => "second attempt");
		expect(() => oncePerProcess("dedupe:throws", shouldNeverRun)).toThrow(boom);

		expect(failing).toHaveBeenCalledTimes(1);
		expect(shouldNeverRun).not.toHaveBeenCalled();
	});

	it("结果缓存形态：对象返回值严格同一引用（重放非重新求值）", () => {
		const shared = { id: 1 };
		const fn = vi.fn(() => shared);

		const first = oncePerProcess("dedupe:object-ref", fn);
		const second = oncePerProcess("dedupe:object-ref", fn);

		expect(first).toBe(shared);
		expect(second).toBe(shared);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("async fn：resolved Promise 实例重放（同一 toBe 实例）", async () => {
		const fn = vi.fn(async () => "settled");

		const first = oncePerProcess("dedupe:async-resolved", fn);
		const second = oncePerProcess("dedupe:async-resolved", fn);

		expect(second).toBe(first);
		await expect(first).resolves.toBe("settled");
		await expect(second).resolves.toBe("settled");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("async fn 抛错：rejected Promise 被缓存——同 key 再调重放同一实例、fn 不再执行", async () => {
		const boom = new Error("async reap failed");
		const fn = vi.fn(async () => {
			throw boom;
		});

		const first = oncePerProcess("dedupe:async-rejected", fn);
		// 先 attach 断言再消费，避免 unhandledRejection
		const firstRejection = expect(first).rejects.toThrow(boom);
		const second = oncePerProcess("dedupe:async-rejected", fn);

		expect(second).toBe(first);
		await firstRejection;
		await expect(second).rejects.toThrow(boom);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
