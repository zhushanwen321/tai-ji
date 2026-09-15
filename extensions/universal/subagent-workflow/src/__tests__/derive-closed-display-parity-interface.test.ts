// derive-closed-display-parity — 成败推导单一权威守卫（壳侧消费方）
//
// [u1-move 拆分] 原 derive-closed-display-parity.test.ts 的守卫段：被锚定的
// interface/bg-notify-render.ts（renderRecordLines）是壳件，随壳留守本包；
// core 侧消费方（notifier.ts）守卫与 deriveOutcome/projectOutcome 行为锚定
// 在 packages/subagent-core 同名测试文件。
//
// 同构成败推导收敛到 execution-record.ts 的 deriveOutcome/projectOutcome（单一权威），
// 本文件锚定壳侧消费方源码不得写回手写同构 switch。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** 壳侧消费方源码（同构成败推导已收敛删除）。 */
const CONSUMER_SOURCES = {
  render: join(here, "..", "interface", "bg-notify-render.ts"),
} as const;

/**
 * 手写同构 switch 的源码特征 token：出现即说明有人把收敛删除的成败推导又写了回去。
 * （"gc" 是 ClosedReason 专属字面量——outcome 三态不含它，消费方合法代码不会出现
 * `?? "gc"` / `=== "gc"`；cancelled 比较不列入——outcome === "cancelled" 是合法消费。）
 */
const LEGACY_DERIVATION_TOKENS = [/\?\?\s*["']gc["']/, /===\s*["']gc["']/] as const;

describe("同构 switch 残留守卫（收敛删除后不得写回）— 壳侧消费方", () => {
  it("消费方源码可读（fail-loud 前置）", () => {
    for (const [key, p] of Object.entries(CONSUMER_SOURCES)) {
      expect(() => readFileSync(p, "utf-8"), `源文件不可读：${key} ${p}`).not.toThrow();
    }
  });

  it("bg-notify-render renderRecordLines 无 closedReason 成败推导特征", () => {
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
