// src/__tests__/concurrency-pool.test.ts
import { describe, expect, it } from "vitest";

import { DefaultConcurrencyPool } from "../assembly/concurrency-pool.ts";

describe("DefaultConcurrencyPool", () => {
  it("allows up to maxConcurrent concurrent tasks", async () => {
    const pool = new DefaultConcurrencyPool(2);
    await pool.acquire(0);
    await pool.acquire(0);
    // 第三个 acquire 应阻塞
    let thirdAcquired = false;
    const third = pool.acquire(0).then(() => { thirdAcquired = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(thirdAcquired).toBe(false);
    expect(pool.active).toBe(2);

    pool.release();
    await third;
    expect(thirdAcquired).toBe(true);
    expect(pool.active).toBe(2);

    pool.release();
    pool.release();
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.active).toBe(0);
  });

  it("higher priority acquires the pool first", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(0); // 占满

    let lowAcquired = false;
    let highAcquired = false;
    const low = pool.acquire(10).then(() => { lowAcquired = true; });
    const high = pool.acquire(0).then(() => { highAcquired = true; });

    await new Promise((r) => setTimeout(r, 5));
    pool.release();
    await Promise.race([low, high, new Promise((r) => setTimeout(r, 20))]);

    expect(highAcquired).toBe(true);
    expect(lowAcquired).toBe(false);
    pool.release();
  });

  it("same-priority tasks wake in FIFO (seq) order", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(0); // fill slot

    const order: number[] = [];
    // Enqueue 3 tasks with same priority — they should resolve in enqueue order
    const p1 = pool.acquire(0).then(() => { order.push(1); pool.release(); });
    const p2 = pool.acquire(0).then(() => { order.push(2); pool.release(); });
    const p3 = pool.acquire(0).then(() => { order.push(3); pool.release(); });

    pool.release(); // kick off the chain
    await Promise.allSettled([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("extra release() does not make active negative", () => {
    const pool = new DefaultConcurrencyPool(2);
    pool.release(); // no acquires yet
    pool.release();
    pool.release();
    expect(pool.active).toBe(0);
  });

  it("active never exceeds maxConcurrent", async () => {
    const pool = new DefaultConcurrencyPool(2);
    const acquires: Array<Promise<void>> = [];
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      acquires.push(pool.acquire(0).then(() => {
        peak = Math.max(peak, pool.active);
      }));
    }
    // Drain: release one at a time so we can observe peak
    for (let i = 0; i < 6; i++) {
      pool.release();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.allSettled(acquires);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("clamps maxConcurrent=0 to 1 (no deadlock, C3 fix)", async () => {
    const pool = new DefaultConcurrencyPool(0);
    // 不会死锁——clamp 到 1，acquire 立即返回
    await pool.acquire(0);
    expect(pool.active).toBe(1);
    pool.release();
    expect(pool.active).toBe(0);
  });

  it("clamps negative maxConcurrent to 1", async () => {
    const pool = new DefaultConcurrencyPool(-5);
    await pool.acquire(0);
    expect(pool.active).toBe(1);
  });

  it("priority 0 (sync) preempts priority 1000 (background)", async () => {
    const pool = new DefaultConcurrencyPool(1);
    await pool.acquire(1000); // background 占满

    let bgAcquired = false;
    let syncAcquired = false;
    const bg = pool.acquire(1000).then(() => { bgAcquired = true; });
    const sync = pool.acquire(0).then(() => { syncAcquired = true; });

    await new Promise((r) => setTimeout(r, 5));
    pool.release();
    await Promise.race([bg, sync, new Promise((r) => setTimeout(r, 20))]);

    expect(syncAcquired).toBe(true);
    expect(bgAcquired).toBe(false);
    pool.release();
  });

  // ============================================================
  // 分层配额：effectiveMaxConcurrent 参数控制放行上限 (T-A1~T-A4)
  // ============================================================
  //
  // [背景] T2 Wave 0 给 acquire 增加可选 effectiveMaxConcurrent 参数，让调用方
  // 传 max(1, maxConcurrent - depth) 实现分层配额（嵌套越深有效并发越小）。
  // 该参数覆盖实例级 maxConcurrent 的本次调用上限，不改实例状态。
  // 这组测试锁定该参数的语义。

  describe("分层配额 effectiveMaxConcurrent (T-A1~T-A4)", () => {
    it("T-A1: effectiveMaxConcurrent 限制本次调用放行数（小于实例级 maxConcurrent）", async () => {
      // 实例配额 5，但本次调用 effective=2 → 第 3 个应阻塞
      const pool = new DefaultConcurrencyPool(5);
      await pool.acquire(0, 2);
      await pool.acquire(0, 2);
      expect(pool.active).toBe(2);

      let thirdAcquired = false;
      const third = pool.acquire(0, 2).then(() => { thirdAcquired = true; });
      await new Promise((r) => setTimeout(r, 5));

      expect(thirdAcquired).toBe(false);
      expect(pool.active).toBe(2);

      pool.release();
      await third;
      expect(thirdAcquired).toBe(true);
      pool.release();
      pool.release();
    });

    it("T-A2: 同一 pool 实例不同 effectiveMaxConcurrent 控制不同调用放行数", async () => {
      // 同一 pool（实例级 maxConcurrent=5）
      const pool = new DefaultConcurrencyPool(5);
      // 前 3 个用 effective=3，全放行（active 0→1→2→3，每次 < 3）
      await pool.acquire(0, 3);
      await pool.acquire(0, 3);
      await pool.acquire(0, 3);
      expect(pool.active).toBe(3);

      // 第 4 个用 effective=3 → 阻塞（active 3 >= 3）
      let blockedAcquired = false;
      const blocked = pool.acquire(0, 3).then(() => { blockedAcquired = true; });
      await new Promise((r) => setTimeout(r, 5));
      expect(blockedAcquired).toBe(false);

      // 换 effective=5 放行（active 3 < 5）
      let wideAcquired = false;
      const wide = pool.acquire(0, 5).then(() => { wideAcquired = true; });
      await new Promise((r) => setTimeout(r, 5));
      expect(wideAcquired).toBe(true);
      expect(pool.active).toBe(4);

      // wide release 后 blocked 仍等（active 3 >= 3 不变直到再 release）
      pool.release(); // wide 释放
      await new Promise((r) => setTimeout(r, 5));
      expect(blockedAcquired).toBe(true);

      // 清理
      pool.release();
      pool.release();
      pool.release();
      pool.release();
      await Promise.allSettled([blocked, wide]);
    });

    it("T-A3: effectiveMaxConcurrent=1 只放行 1 个（保底）", async () => {
      const pool = new DefaultConcurrencyPool(5);
      await pool.acquire(0, 1);
      expect(pool.active).toBe(1);

      let secondAcquired = false;
      const second = pool.acquire(0, 1).then(() => { secondAcquired = true; });
      await new Promise((r) => setTimeout(r, 5));
      expect(secondAcquired).toBe(false);
      expect(pool.active).toBe(1);

      pool.release();
      await second;
      expect(secondAcquired).toBe(true);
      pool.release();
    });

    it("T-A4: maxConcurrent readonly 属性可读且等于构造值", () => {
      const pool = new DefaultConcurrencyPool(4);
      expect(pool.maxConcurrent).toBe(4);

      // clamp 路径也通过该属性暴露
      const clamped = new DefaultConcurrencyPool(0);
      expect(clamped.maxConcurrent).toBe(1);

      const negative = new DefaultConcurrencyPool(-3);
      expect(negative.maxConcurrent).toBe(1);
    });
  });

  // ============================================================
  // H2: acquire 支持 AbortSignal — abort 时排队条目 reject
  // ============================================================
  describe("H2 abort support for acquire", () => {
    it("abort signal rejects queued acquire with AbortError", async () => {
      const pool = new DefaultConcurrencyPool(1);
      await pool.acquire(0); // 占满

      const controller = new AbortController();
      const queued = pool.acquire(0, undefined, controller.signal);

      await new Promise((r) => setTimeout(r, 5));
      expect(pool.active).toBe(1); // 仍在排队

      controller.abort();

      await expect(queued).rejects.toThrow("aborted");
    });

    it("non-aborted acquire still resolves normally after release", async () => {
      const pool = new DefaultConcurrencyPool(1);
      await pool.acquire(0); // 占满

      const controller = new AbortController();
      const queued = pool.acquire(0, undefined, controller.signal);

      pool.release(); // 释放 → queued 应被 resolve
      await queued;   // 不应 reject
      expect(pool.active).toBe(1);
      pool.release();
    });
  });
});
