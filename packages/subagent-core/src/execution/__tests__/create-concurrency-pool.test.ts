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
import { describe, expect, it } from "vitest";

import { createConcurrencyPool, DefaultConcurrencyPool } from "../assembly/concurrency-pool.ts";

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
