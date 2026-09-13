// derive-closed-display-parity — 成败推导单一权威守卫（core 侧）
//
// 同构成败推导收敛到 execution-record.ts 的 deriveOutcome/projectOutcome（单一权威）。
// 本文件锚定：① 权威函数行为；② core 侧消费方（execution/notify/notifier.ts buildLlmContent）
// 源码不得写回手写同构 switch。
// [u1-move 拆分] 壳侧消费方（interface/bg-notify-render.ts renderRecordLines）的守卫段
// 随壳件留守 pi extension 包：src/__tests__/derive-closed-display-parity-interface.test.ts。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveOutcome, projectOutcome } from "../execution/persistence/execution-record.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** core 侧消费方源码（同构成败推导已收敛删除）。 */
const CONSUMER_SOURCES = {
  notifier: join(here, "..", "execution", "notify", "notifier.ts"),
} as const;

/**
 * 手写同构 switch 的源码特征 token：出现即说明有人把收敛删除的成败推导又写了回去。
 * （"gc" 是 ClosedReason 专属字面量——outcome 三态不含它，消费方合法代码不会出现
 * `?? "gc"` / `=== "gc"`；cancelled 比较不列入——outcome === "cancelled" 是合法消费。）
 */
const LEGACY_DERIVATION_TOKENS = [/\?\?\s*["']gc["']/, /===\s*["']gc["']/] as const;

describe("deriveOutcome — 单一权威终态派生（行为锚定）", () => {
  it("completed：closed + 无 error（gc / user-close 正常完成）", () => {
    expect(deriveOutcome("gc", undefined)).toBe("completed");
    expect(deriveOutcome("user-close", undefined)).toBe("completed");
  });

  it("failed：closed + error 非空（gc 失败）", () => {
    expect(deriveOutcome("gc", "spawn EPIPE")).toBe("failed");
  });

  it("[D6 显式取舍] parent-shutdown/parent-fork/parent-new 合成关闭 → failed（勿改 cancelled）", () => {
    // disposeAllRecords 合成 result 恒写 error:"closed due to ${reason}"——
    // 「父进程关闭时子 agent 未完成即失败」为选定行为而非疏漏。
    expect(deriveOutcome("parent-shutdown", "closed due to parent-shutdown")).toBe("failed");
    expect(deriveOutcome("parent-fork", "closed due to parent-fork")).toBe("failed");
    expect(deriveOutcome("parent-new", "closed due to parent-new")).toBe("failed");
  });

  it("cancelled：取消优先于 error（abort 合成 result 可能带 error）", () => {
    expect(deriveOutcome("cancelled", undefined)).toBe("cancelled");
    expect(deriveOutcome("cancelled", "aborted by user")).toBe("cancelled");
  });

  it("空串 error 不构成 failed（与旧同构 `record.error &&` truthy 判定逐字对齐）", () => {
    expect(deriveOutcome("gc", "")).toBe("completed");
  });
});

describe("projectOutcome — 投影唯一出口（行为锚定）", () => {
  it("running → undefined；closed 一等 outcome 直读；存量 record 兜底派生", () => {
    expect(projectOutcome({ status: "running" })).toBeUndefined();
    expect(projectOutcome({ status: "idle", closedReason: "gc", outcome: "failed" })).toBe("failed");
    expect(projectOutcome({ status: "idle", closedReason: "gc", error: "boom" })).toBe("failed");
    expect(projectOutcome({ status: "idle", closedReason: "gc" })).toBe("completed");
  });
});

describe("同构 switch 残留守卫（收敛删除后不得写回）— core 消费方", () => {
  it("消费方源码可读（fail-loud 前置）", () => {
    for (const [key, p] of Object.entries(CONSUMER_SOURCES)) {
      expect(() => readFileSync(p, "utf-8"), `源文件不可读：${key} ${p}`).not.toThrow();
    }
  });

  it("notifier buildLlmContent 无 closedReason 成败推导特征", () => {
    for (const [key, p] of Object.entries(CONSUMER_SOURCES)) {
      const src = readFileSync(p, "utf-8");
      for (const token of LEGACY_DERIVATION_TOKENS) {
        expect(
          token.test(src),
          `[${key}] 检出旧同构推导特征 /${token.source}/——成败判定应只读 outcome 或调用 ` +
            `execution-record.ts 的 deriveOutcome/projectOutcome（单一权威），禁止手写 switch 写回。` +
            `若确属新增合法用法，请同步更新本护栏的特征提取。`,
        ).toBe(false);
      }
      // 消费方必须经由单一权威实现
      expect(
        src.includes("deriveOutcome"),
        `[${key}] 未引用 deriveOutcome——outcome 兜底派生必须复用单一权威函数。`,
      ).toBe(true);
    }
  });
});
