// src/__tests__/subagent-service-abort.test.ts
//
// S4: subagent-service abort 终态一致性测试。
//
// 审查发现：排队中被 abort（pool.acquire reject）走 finalizeFailed（status=failed），
// 而已运行中被 abort 走 cancelled。同一用户 abort 因时机不同产生两种终态。
//
// 修复后：pool reject 的 error 带 name="AbortError"，runAndFinalize catch 判断
// signal?.aborted 走 cancelled 路径。
//
// 本文件覆盖两层：
//   1. pool 层：acquire reject 的 error.name 是 "AbortError"（S1 前半）
//   2. pool 层：pre-aborted signal 也带 AbortError name（S1 另一处）

import { describe, expect, it } from "vitest";

import { DefaultConcurrencyPool } from "../assembly/concurrency-pool.ts";

describe("S1: ConcurrencyPool abort reject produces AbortError name", () => {
	it("queued acquire aborted via signal rejects with error.name=AbortError", async () => {
		const pool = new DefaultConcurrencyPool(1);
		await pool.acquire(0); // 占满

		const controller = new AbortController();
		const queued = pool.acquire(0, undefined, controller.signal);

		await new Promise((r) => setTimeout(r, 5));
		expect(pool.active).toBe(1); // 仍在排队

		controller.abort();

		try {
			await queued;
			expect.unreachable("should have rejected");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).name).toBe("AbortError");
			expect((err as Error).message).toContain("abort");
		}
		pool.release();
	});

	it("pre-aborted signal rejects immediately with error.name=AbortError", async () => {
		const pool = new DefaultConcurrencyPool(1);
		await pool.acquire(0); // 占满

		const controller = new AbortController();
		controller.abort(); // 先 abort 再 acquire

		try {
			await pool.acquire(0, undefined, controller.signal);
			expect.unreachable("should have rejected");
		} catch (err) {
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).name).toBe("AbortError");
			expect((err as Error).message).toContain("abort");
		}
		pool.release();
	});
});
