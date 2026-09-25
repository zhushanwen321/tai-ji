// src/orchestration/__tests__/persist-throttle.test.ts
//
// RunPersistThrottle（两 RunStore adapter 共享的落盘节流决策）的表驱动单测——
// 五要素判定 + 记账时机。这是「两 adapter 决策等价」的唯一期望源：adapter 侧
// 测试只保留通道特定断言（FileRunStore 跳过即不 append / JsonlRunStore 跳过
// entry 但 state 仍写），语义矩阵在此单点锚定。
import { describe, expect, it } from "vitest";

import { createRunPersistThrottle } from "../persist-throttle.ts";

describe("shouldPersist 五要素", () => {
  it("首写豁免：无记账时窗口再小也落盘", () => {
    const t = createRunPersistThrottle(60_000);
    expect(t.shouldPersist("run-1", false, 0)).toBe(true);
  });

  it("窗口跳过：running 记账后窗口内不落盘", () => {
    const t = createRunPersistThrottle(1000);
    t.recordPersisted("run-1", false, 0);
    expect(t.shouldPersist("run-1", false, 999)).toBe(false);
  });

  it("窗口到期：恰好到达间隔即落盘（>= 不是 >）", () => {
    const t = createRunPersistThrottle(1000);
    t.recordPersisted("run-1", false, 0);
    expect(t.shouldPersist("run-1", false, 1000)).toBe(true);
  });

  it("终态豁免：窗口内且刚记账，终态仍落盘", () => {
    const t = createRunPersistThrottle(60_000);
    t.recordPersisted("run-1", false, 0);
    expect(t.shouldPersist("run-1", true, 1)).toBe(true);
  });

  it("零禁用：interval=0 恒落盘（含刚记账）", () => {
    const t = createRunPersistThrottle(0);
    t.recordPersisted("run-1", false, 0);
    expect(t.shouldPersist("run-1", false, 0)).toBe(true);
  });

  it("负值钳制：构造传负数等价 0（禁用）", () => {
    const t = createRunPersistThrottle(-1);
    t.recordPersisted("run-1", false, 0);
    expect(t.shouldPersist("run-1", false, 0)).toBe(true);
  });

  it("per-runId 互不影响", () => {
    const t = createRunPersistThrottle(1000);
    t.recordPersisted("run-1", false, 0);
    expect(t.shouldPersist("run-1", false, 500)).toBe(false);
    expect(t.shouldPersist("run-2", false, 500)).toBe(true);
  });
});

describe("recordPersisted 记账语义", () => {
  it("running 记账后，窗口从记账时刻起算（时间源为传入 now）", () => {
    const t = createRunPersistThrottle(1000);
    t.recordPersisted("run-1", false, 100);
    expect(t.shouldPersist("run-1", false, 1099)).toBe(false);
    expect(t.shouldPersist("run-1", false, 1100)).toBe(true);
  });

  it("终态记账即删：同 runId 后续判定回到首写豁免形态", () => {
    const t = createRunPersistThrottle(60_000);
    t.recordPersisted("run-1", false, 0);
    t.recordPersisted("run-1", true, 10);
    // 终态后 runId 不再 save，此断言是防御性语义锚（删条目而非残留终态时刻）
    expect(t.shouldPersist("run-1", false, 11)).toBe(true);
  });

  it("不记账不推进窗口：仅 shouldPersist 不产生任何状态变化", () => {
    const t = createRunPersistThrottle(1000);
    t.recordPersisted("run-1", false, 0);
    // 窗口内反复探测（跳过路径）不记账——窗口到期时刻不变
    expect(t.shouldPersist("run-1", false, 500)).toBe(false);
    expect(t.shouldPersist("run-1", false, 999)).toBe(false);
    expect(t.shouldPersist("run-1", false, 1000)).toBe(true);
  });
});
