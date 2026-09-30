// src/__tests__/ext-guards.test.ts
//
// oncePerProcess 单测——验收条款逐条对应（u-guards-pkg ①；失败语义按加固审查裁决
// 修订为「失败不缓存、下次调用可重试」）：
//   a. key 隔离去重：不同 key 互不影响，各自首次调用执行
//   b. 同 key 双调 fn 仅执行一次
//   c. fn 抛错不吞不包装，且不缓存——同 key 再调重新执行（可重试）
//   d. 结果缓存形态：值原样重放（严格同一引用）、Promise 实例重放
//   e. rejected Promise：落定后释放 key，下次调用重新执行
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

	it("fn 同步抛错：错误原样上抛（不吞不包装），不写缓存——同 key 再调重新执行（可重试）", () => {
		const boom = new Error("reap failed");
		let attempts = 0;
		const fn = vi.fn(() => {
			attempts += 1;
			if (attempts === 1) throw boom;
			return "recovered";
		});

		expect(() => oncePerProcess("dedupe:throws-retry", fn)).toThrow(boom);
		expect(fn).toHaveBeenCalledTimes(1);

		// 失败不缓存：下次同 key 调用重新执行 fn，成功结果照常缓存
		expect(oncePerProcess("dedupe:throws-retry", fn)).toBe("recovered");
		expect(fn).toHaveBeenCalledTimes(2);
		// 成功后去重恢复：不再执行
		expect(oncePerProcess("dedupe:throws-retry", fn)).toBe("recovered");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("async fn 抛错：rejected Promise 落定后释放 key——下次调用重新执行（可重试）", async () => {
		const boom = new Error("async reap failed");
		let attempts = 0;
		const fn = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) throw boom;
			return "recovered";
		});

		const first = oncePerProcess("dedupe:async-rejected-retry", fn);
		// 先 attach 断言再消费，避免 unhandledRejection
		await expect(first).rejects.toThrow(boom);
		expect(fn).toHaveBeenCalledTimes(1);

		// rejection 已落定、key 已释放：下次调用重新执行 fn
		const second = oncePerProcess("dedupe:async-rejected-retry", fn);
		expect(second).not.toBe(first);
		await expect(second).resolves.toBe("recovered");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("async fn：rejection 落定前的同 key 双调仍重放同一实例（落定后释放）", async () => {
		const boom = new Error("async reap failed");
		const fn = vi.fn(async () => {
			throw boom;
		});

		const first = oncePerProcess("dedupe:async-inflight", fn);
		// 落定前第二次调用：同一 Promise 实例（在飞去重不双跑）
		const second = oncePerProcess("dedupe:async-inflight", fn);
		expect(second).toBe(first);
		// 先 attach 断言再消费，避免 unhandledRejection
		const firstRejection = expect(first).rejects.toThrow(boom);
		await firstRejection;
		await Promise.resolve(); // 让释放 handler 的微任务走完
		expect(fn).toHaveBeenCalledTimes(1);

		// 落定后第三次调用：key 已释放，fn 重新执行
		const third = oncePerProcess("dedupe:async-inflight", fn);
		expect(third).not.toBe(first);
		await expect(third).rejects.toThrow(boom);
		expect(fn).toHaveBeenCalledTimes(2);
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

	it("fn 返回 undefined：值仍被缓存（不因 undefined 误判未执行）", () => {
		const fn = vi.fn(() => undefined);

		const first = oncePerProcess("dedupe:undefined-value", fn);
		const second = oncePerProcess("dedupe:undefined-value", fn);

		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
