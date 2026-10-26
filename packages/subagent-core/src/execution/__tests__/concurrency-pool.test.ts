// src/execution/__tests__/concurrency-pool.test.ts
//
// [round5-g 合并产物] DefaultConcurrencyPool 并发池测试簇三合一，来源：
// - concurrency-pool.test.ts（本文件原内容：池行为/分层配额/abort）
// - create-concurrency-pool.test.ts（工厂 queuePolicy 策略）
// - subagent-service-abort.test.ts（pool 层 abort 终态一致性——被测对象即本池，
//   文件名不改、以节注释登记）

import { describe, expect, it } from "vitest";

import { createConcurrencyPool, DefaultConcurrencyPool } from "../assembly/concurrency-pool.ts";

// src/__tests__/concurrency-pool.test.ts


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

// ══════ 来源: create-concurrency-pool.test.ts ══════

// src/execution/__tests__/create-concurrency-pool.test.ts
//
// U4（subagent-core-sink-design D7）：并发池工厂 createConcurrencyPool({maxConcurrent, queuePolicy})。
// 排队策略差异是宿主声明的有意决策（pi=priority / zsw=strict-fifo），保留为参数而非消灭。
// 锚定：
//   ①缺省策略与既有 DefaultConcurrencyPool 行为逐点等值（pi 零回归）；
//   ②priority / strict-fifo 两策略排队顺序语义互斥可辨。
//
// pool 的排队/放行是纯 Promise resolve（microtask），无 timer 参与——microtask flush
// 推进，不引入真实 setTimeout（TEST-STRATEGY 禁真实等待），无需 fake timers。


/** microtask flush：让排队条目的 resolve/.then 链跑完（pool 无 timer 语义）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("createConcurrencyPool 工厂（U4/D7）", () => {
  it("缺省 queuePolicy 与既有 DefaultConcurrencyPool 行为逐点等值（active/排队/release 对照）", async () => {
    const factory = createConcurrencyPool({ maxConcurrent: 2 });
    const classic = new DefaultConcurrencyPool(2);

    // 槽位放行与 active 计数一致
    await factory.acquire(0);
    await factory.acquire(0);
    await classic.acquire(0);
    await classic.acquire(0);
    expect(factory.active).toBe(classic.active);
    expect(factory.active).toBe(2);

    // 超额 acquire 同样排队（不放行）
    let factoryQueued = false;
    let classicQueued = false;
    const fq = factory.acquire(0).then(() => {
      factoryQueued = true;
    });
    const cq = classic.acquire(0).then(() => {
      classicQueued = true;
    });
    await flushMicrotasks();
    expect(factoryQueued).toBe(false);
    expect(classicQueued).toBe(false);

    // release 后排队条目同样获得槽位，active 语义一致
    factory.release();
    classic.release();
    await flushMicrotasks();
    expect(factoryQueued).toBe(true);
    expect(classicQueued).toBe(true);
    expect(factory.active).toBe(classic.active);

    // 清理后归零一致
    factory.release();
    classic.release();
    factory.release();
    classic.release();
    await flushMicrotasks();
    expect(factory.active).toBe(0);
    expect(classic.active).toBe(0);
    await Promise.allSettled([fq, cq]);
  });

  it("queuePolicy 缺省值等值：不传 queuePolicy 与显式 'priority' 产出同序放行", async () => {
    const implicit = createConcurrencyPool({ maxConcurrent: 1 });
    const explicit = createConcurrencyPool({ maxConcurrent: 1, queuePolicy: "priority" });

    const implicitOrder: string[] = [];
    const explicitOrder: string[] = [];

    // 同一序列：低优先级先入队、高优先级后入队 → priority 策略下高优先级插队
    for (const [pool, order] of [
      [implicit, implicitOrder],
      [explicit, explicitOrder],
    ] as const) {
      await pool.acquire(0);
      const low = pool.acquire(1000).then(() => {
        order.push("low");
        pool.release();
      });
      const high = pool.acquire(0).then(() => {
        order.push("high");
        pool.release();
      });
      pool.release();
      await Promise.all([low, high]);
    }

    expect(implicitOrder).toEqual(["high", "low"]);
    expect(explicitOrder).toEqual(implicitOrder);
  });

  it("queuePolicy:'priority' 高优先级先获得释放的槽位（pi 既有行为）", async () => {
    const pool = createConcurrencyPool({ maxConcurrent: 1, queuePolicy: "priority" });
    await pool.acquire(1000); // 低优先级占满

    let lowAcquired = false;
    let highAcquired = false;
    const low = pool.acquire(1000).then(() => {
      lowAcquired = true;
    });
    const high = pool.acquire(0).then(() => {
      highAcquired = true;
    });
    await flushMicrotasks();
    expect(lowAcquired).toBe(false);
    expect(highAcquired).toBe(false);

    pool.release();
    await flushMicrotasks();
    expect(highAcquired).toBe(true);
    expect(lowAcquired).toBe(false);
    pool.release();
    await Promise.allSettled([low, high]);
  });

  it("queuePolicy:'strict-fifo' 忽略 priority，纯入队顺序放行", async () => {
    const pool = createConcurrencyPool({ maxConcurrent: 1, queuePolicy: "strict-fifo" });
    await pool.acquire(0); // 占满

    const order: number[] = [];
    // 入队顺序 priority: 10 → 0 → 5。priority 策略会让 0 最先；strict-fifo 必须按 10 → 0 → 5
    const a = pool.acquire(10).then(() => {
      order.push(10);
      pool.release();
    });
    const b = pool.acquire(0).then(() => {
      order.push(0);
      pool.release();
    });
    const c = pool.acquire(5).then(() => {
      order.push(5);
      pool.release();
    });
    pool.release(); // 放行队首（seq 最小 = a）

    await Promise.all([a, b, c]);
    expect(order).toEqual([10, 0, 5]);
  });

  it("queuePolicy:'strict-fifo' 高优先级不插队（与 priority 策略语义互斥可辨）", async () => {
    const pool = createConcurrencyPool({ maxConcurrent: 1, queuePolicy: "strict-fifo" });
    await pool.acquire(0); // 占满

    let lowFirstAcquired = false;
    let highSecondAcquired = false;
    // 低优先级先入队，高优先级后入队——priority 策略会放行 high；strict-fifo 必须放行 low
    const low = pool.acquire(1000).then(() => {
      lowFirstAcquired = true;
    });
    const high = pool.acquire(0).then(() => {
      highSecondAcquired = true;
    });
    await flushMicrotasks();
    expect(lowFirstAcquired).toBe(false);
    expect(highSecondAcquired).toBe(false);

    pool.release();
    await flushMicrotasks();
    expect(lowFirstAcquired).toBe(true);
    expect(highSecondAcquired).toBe(false);

    pool.release();
    await flushMicrotasks();
    expect(highSecondAcquired).toBe(true);
    await Promise.allSettled([low, high]);
  });

  it("策略不影响并发语义：strict-fifo 的 clamp/active 与 priority 一致", async () => {
    const pool = createConcurrencyPool({ maxConcurrent: 0, queuePolicy: "strict-fifo" });
    // clamp 到 1（C3 修复语义策略无关）
    expect(pool.maxConcurrent).toBe(1);
    await pool.acquire(0);
    expect(pool.active).toBe(1);
    pool.release();
    expect(pool.active).toBe(0);
  });

  it("strict-fifo 下排队条目 abort 仍 reject（AbortError，H2 语义策略无关）", async () => {
    const pool = createConcurrencyPool({ maxConcurrent: 1, queuePolicy: "strict-fifo" });
    await pool.acquire(0); // 占满

    const controller = new AbortController();
    const queued = pool.acquire(0, undefined, controller.signal);
    await flushMicrotasks();
    expect(pool.active).toBe(1); // 仍在排队

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ══════ 来源: subagent-service-abort.test.ts ══════

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
