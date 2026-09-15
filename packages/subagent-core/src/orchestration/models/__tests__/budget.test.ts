// 测试框架：vitest
// 运行命令：npx vitest run src/orchestration/models/__tests__/budget.test.ts

import { describe, expect, it } from "vitest";

import {
  Budget,
  CACHE_READ_WEIGHT,
  CACHE_WRITE_WEIGHT,
  INPUT_WEIGHT,
  OUTPUT_WEIGHT,
} from "../budget.js";
import type { AgentUsage } from "../types.js";

/** 构造合法 AgentUsage，未指定字段补 0。 */
function usage(partial: Partial<AgentUsage>): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    ...partial,
  };
}

/**
 * 构造"有毒" usage：刻意注入 undefined / NaN / Infinity，
 * 模拟 provider 返回脏数据或 JSON 反序列化缺字段时的运行时场景。
 *
 * 单层 `as AgentUsage`：AgentUsage 全部必填字段（非全可选结构），
 * 不触发 taste/no-unsafe-cast 的 structuralCast；此处刻意绕过类型系统
 * 以验证 consume() 的运行时 NaN 守卫。
 */
function poisonedUsage(
  overrides: Partial<Record<keyof AgentUsage, number | undefined>>,
): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    ...overrides,
  } as AgentUsage;
}

// ── consume：加权公式 ────────────────────────────────────────

describe("Budget.consume 加权公式", () => {
  it(`纯 input → usedTokens = input × ${INPUT_WEIGHT}`, () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 100 }));
    expect(b.usedTokens).toBe(100);
  });

  it(`纯 output → usedTokens = output × ${OUTPUT_WEIGHT}（自回归开销最高）`, () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ output: 100 }));
    expect(b.usedTokens).toBe(200);
  });

  it(`纯 cacheRead → usedTokens = cacheRead × ${CACHE_READ_WEIGHT}（命中缓存，开销极低）`, () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ cacheRead: 100 }));
    expect(b.usedTokens).toBe(2);
  });

  it(`纯 cacheWrite → usedTokens = cacheWrite × ${CACHE_WRITE_WEIGHT}（首次写缓存不计 budget）`, () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ cacheWrite: 100 }));
    expect(b.usedTokens).toBe(0);
  });

  it("混合四项加权累加（input×1 + output×2 + cacheRead×0.02 + cacheWrite×0）", () => {
    const b = new Budget({ maxTokens: 10000 });
    b.consume(
      usage({ input: 100, output: 50, cacheRead: 1000, cacheWrite: 500 }),
    );
    // 100×1 + 50×2 + 1000×0.02 + 500×0 = 100 + 100 + 20 + 0 = 220
    expect(b.usedTokens).toBe(220);
  });

  it("cost 随 consume 累加", () => {
    const b = new Budget();
    b.consume(usage({ cost: 0.3 }));
    expect(b.usedCost).toBe(0.3);
  });

  it("多次 consume 累加（retry 间如实记录，不减）", () => {
    const b = new Budget();
    b.consume(usage({ input: 100, cost: 0.1 }));
    b.consume(usage({ input: 50, output: 50, cost: 0.2 }));
    // tokens: 100×1 + (50×1 + 50×2) = 250
    expect(b.usedTokens).toBe(250);
    // 0.1 + 0.2 浮点误差，用 toBeCloseTo
    expect(b.usedCost).toBeCloseTo(0.3);
  });
});

// ── consume：NaN 守卫（TDD，预期主 agent 同步补源码守卫）──────
//
// 源码 consume() 当前无守卫：undefined/NaN/Infinity 进入加权公式会产出
// NaN/Infinity 污染 usedTokens，导致后续 isExceeded 永远命中。
// 以下测试断言「脏字段当 0 处理」——守卫补上前会失败，属预期临时状态。

describe("Budget.consume NaN 守卫（undefined/NaN/Infinity 当 0 处理）", () => {
  it("input=undefined → usedTokens 不变（不当 NaN）", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(poisonedUsage({ input: undefined }));
    expect(b.usedTokens).toBe(0);
    expect(Number.isNaN(b.usedTokens)).toBe(false);
  });

  it("output=undefined → usedTokens 不变", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(poisonedUsage({ output: undefined }));
    expect(b.usedTokens).toBe(0);
  });

  it("input=NaN → usedTokens 不变", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(poisonedUsage({ input: Number.NaN }));
    expect(b.usedTokens).toBe(0);
    expect(Number.isNaN(b.usedTokens)).toBe(false);
  });

  it("output=NaN → usedTokens 不变", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(poisonedUsage({ output: Number.NaN }));
    expect(b.usedTokens).toBe(0);
  });

  it("cacheRead=NaN / cacheWrite=NaN → usedTokens 不变", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(
      poisonedUsage({ cacheRead: Number.NaN, cacheWrite: Number.NaN }),
    );
    expect(b.usedTokens).toBe(0);
  });

  it("input=Infinity → usedTokens 不变（Infinity 不烧穿预算）", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(poisonedUsage({ input: Number.POSITIVE_INFINITY }));
    expect(b.usedTokens).toBe(0);
    expect(Number.isFinite(b.usedTokens)).toBe(true);
  });

  it("合法字段与脏字段混合 → 仅累加合法部分（脏字段当 0）", () => {
    const b = new Budget({ maxTokens: 1000 });
    // input=100（合法）+ output=undefined（脏，当 0）
    b.consume(poisonedUsage({ input: 100, output: undefined }));
    expect(b.usedTokens).toBe(100);
  });

  it("已有累计后再遇脏数据 → usedTokens 保持原值不退化", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 50 })); // usedTokens = 50
    b.consume(poisonedUsage({ input: undefined }));
    expect(b.usedTokens).toBe(50);
  });

  it("cost=undefined → usedCost 不当 NaN", () => {
    const b = new Budget();
    b.consume(poisonedUsage({ cost: undefined }));
    expect(b.usedCost).toBe(0);
    expect(Number.isNaN(b.usedCost)).toBe(false);
  });
});

// ── incrementCallCount ───────────────────────────────────────

describe("Budget.incrementCallCount", () => {
  it("累加调用计数（每次 agent dispatch 后 +1）", () => {
    const b = new Budget();
    expect(b.totalCallCount).toBe(0);
    b.incrementCallCount();
    b.incrementCallCount();
    b.incrementCallCount();
    expect(b.totalCallCount).toBe(3);
  });
});

// ── isExceeded ───────────────────────────────────────────────

describe("Budget.isExceeded", () => {
  it("maxTokens=1000, usedTokens=999 → 未超", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 999 }));
    expect(b.isExceeded()).toBe(false);
  });

  it("maxTokens=1000, usedTokens=1000 → 超限（边界 >=）", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 1000 }));
    expect(b.isExceeded()).toBe(true);
  });

  it("maxTokens=1000, usedTokens=1001 → 超限", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 1001 }));
    expect(b.isExceeded()).toBe(true);
  });

  it("maxTokens=0 → 视为不限制（守卫，首个 agent 完成不误判）", () => {
    const b = new Budget({ maxTokens: 0 });
    b.consume(usage({ input: 999999 }));
    expect(b.isExceeded()).toBe(false);
  });

  it("maxTokens undefined → 视为不限制", () => {
    const b = new Budget();
    b.consume(usage({ input: 999999 }));
    expect(b.isExceeded()).toBe(false);
  });

  it("maxCost 边界：usedCost >= maxCost → 超限", () => {
    const b = new Budget({ maxCost: 1 });
    b.consume(usage({ cost: 1 }));
    expect(b.isExceeded()).toBe(true);
  });

  it("maxCost=0 → 视为不限制", () => {
    const b = new Budget({ maxCost: 0 });
    b.consume(usage({ cost: 999 }));
    expect(b.isExceeded()).toBe(false);
  });

  it("maxCost undefined → 视为不限制", () => {
    const b = new Budget();
    b.consume(usage({ cost: 999 }));
    expect(b.isExceeded()).toBe(false);
  });

  it("token 与 cost 均未达阈值 → 不超限", () => {
    const b = new Budget({ maxTokens: 1000, maxCost: 10 });
    b.consume(usage({ input: 50, cost: 0.5 }));
    expect(b.isExceeded()).toBe(false);
  });
});

// ── remaining ────────────────────────────────────────────────

describe("Budget.remaining", () => {
  it("正常：maxTokens - usedTokens", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 300 }));
    expect(b.remaining()).toBe(700);
  });

  it("usedTokens > maxTokens → clamp 到 0（不返回负数）", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 1500 }));
    expect(b.remaining()).toBe(0);
  });

  it("maxTokens=1000, usedTokens=1000（恰好用尽）→ 0", () => {
    const b = new Budget({ maxTokens: 1000 });
    b.consume(usage({ input: 1000 }));
    expect(b.remaining()).toBe(0);
  });

  it("maxTokens undefined → undefined（视为不限制）", () => {
    const b = new Budget();
    expect(b.remaining()).toBeUndefined();
  });

  it("maxTokens <= 0 → undefined（视为不限制）", () => {
    const b = new Budget({ maxTokens: 0 });
    expect(b.remaining()).toBeUndefined();
  });
});

// ── 构造 ─────────────────────────────────────────────────────

describe("Budget 构造", () => {
  it("默认值全 0 / undefined", () => {
    const b = new Budget();
    expect(b.usedTokens).toBe(0);
    expect(b.usedCost).toBe(0);
    expect(b.totalCallCount).toBe(0);
    expect(b.maxTokens).toBeUndefined();
    expect(b.maxCost).toBeUndefined();
    expect(b.maxTimeMs).toBeUndefined();
  });

  it("从持久化数据重建（保留全部字段）", () => {
    const b = new Budget({
      maxTokens: 5000,
      maxCost: 2,
      maxTimeMs: 60000,
      usedTokens: 100,
      usedCost: 0.3,
      totalCallCount: 7,
    });
    expect(b.maxTokens).toBe(5000);
    expect(b.maxCost).toBe(2);
    expect(b.maxTimeMs).toBe(60000);
    expect(b.usedTokens).toBe(100);
    expect(b.usedCost).toBe(0.3);
    expect(b.totalCallCount).toBe(7);
  });
});
