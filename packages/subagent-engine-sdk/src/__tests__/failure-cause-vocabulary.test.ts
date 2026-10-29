// src/__tests__/failure-cause-vocabulary.test.ts
//
// [subagent-observability u-foundation] FailureCause 词表枚举完整性测试锚
// （设计 §3.3.2 + §3.4「同款枚举完整性测试锚」三词表之一的 sdk 侧）。
//
// 锁定范围：
//   ① class×kind 合法组合矩阵逐行可构造（判别联合矩阵的可满足性——每行至少一个
//      合法实例编译期 + 运行时双验证）；
//   ② kind 闭合词表常量与联合同步（FAILURE_CAUSE_KIND_VOCAB_LOCK 编译锁的运行时
//      消费点 + 逐成员断言——词表漂移静态防线）；
//   ③ retryable 三态取值可表达 + retryAfterMs 缺省 undefined（不产假 0）；
//   ④ wire 序列化往返保真（判别联合逐字序列化——shared lastRound.failure 载体）；
//   ⑤ 边界用例：raw 空串合法（无文本错误形态）、engine 透传族开放前缀面、
//      class 词表外值不满足判别联合（类型契约负向验证）。

import { describe, expect, it } from "vitest";

import {
  FAILURE_CAUSE_CLOSED_KINDS,
  FAILURE_CAUSE_KIND_VOCAB_LOCK,
  FAILURE_CAUSE_KINDS_BY_CLASS,
  FAILURE_CAUSE_KINDS_BY_CLASS_LOCK,
} from "../protocol/contract-types.ts";
import type { FailureCause, FailureCauseClass, FailureRetryability } from "../protocol/contract-types.ts";

// ── ① class×kind 矩阵逐行可构造 ──────────────────────────────────────────────

describe("FailureCause class×kind 合法组合矩阵", () => {
  it("矩阵每行至少一个合法实例（设计 §3.3.2 已登记成员逐一构造）", () => {
    const matrix: readonly FailureCause[] = [
      // provider 行（两成员）
      { class: "provider", kind: "rate_limited", retryable: "conditional", retryAfterMs: 60_000, raw: "429: tier_limit_exceeded resets 17:00" },
      { class: "provider", kind: "protocol_unsupported", retryable: false, raw: "model has no API implementation" },
      // harness / agent / user 行
      { class: "harness", kind: "turn_budget_exhausted", retryable: false, raw: "turn budget exhausted" },
      { class: "harness", kind: "timeout", retryable: false, raw: "host call timeout after 5000ms" },
      { class: "agent", kind: "no_deliverable", retryable: false, raw: "structured output was not called" },
      { class: "user", kind: "cancelled", retryable: false, raw: "cancel requested" },
      // engine 透传族（开放前缀面）
      { class: "engine", kind: "engine_crashed", retryable: false, raw: "engine exited 137" },
    ];
    expect(matrix).toHaveLength(7);
    for (const cause of matrix) {
      // 判别联合成员经收窄可达全部公共字段（构造成功即矩阵行成立）。
      expect(typeof cause.raw).toBe("string");
      expect([true, false, "conditional"]).toContain(cause.retryable);
    }
  });

  it("class 判别键收窄到成员 kind（非法组合在构造处编译红——运行时抽查判别可达）", () => {
    const provider: FailureCause = { class: "provider", kind: "rate_limited", retryable: true, raw: "r" };
    if (provider.class === "provider") {
      expect(provider.kind === "rate_limited" || provider.kind === "protocol_unsupported").toBe(true);
    } else {
      throw new Error("unreachable: provider cause not narrowed by class discriminant");
    }
  });
});

// ── ② kind 闭合词表同步 ──────────────────────────────────────────────────────

describe("FAILURE_CAUSE_CLOSED_KINDS 闭合词表（新值同 commit 登记锚）", () => {
  it("编译锁消费点在场且恒 true（词表与联合漂移时 tsc 红，本断言防锁被删）", () => {
    expect(FAILURE_CAUSE_KIND_VOCAB_LOCK).toBe(true);
    expect(FAILURE_CAUSE_KINDS_BY_CLASS_LOCK).toBe(true);
  });

  it("恰为 6 个闭合成员（engine 透传族不进闭合表）", () => {
    expect([...FAILURE_CAUSE_CLOSED_KINDS].sort()).toEqual([
      "cancelled",
      "no_deliverable",
      "protocol_unsupported",
      "rate_limited",
      "timeout",
      "turn_budget_exhausted",
    ]);
    for (const kind of FAILURE_CAUSE_CLOSED_KINDS) {
      expect(kind.startsWith("engine_")).toBe(false);
    }
  });

  it("per-class kind 值域并集 = 闭合词表（FAILURE_CAUSE_KINDS_BY_CLASS 与闭合表对账）", () => {
    const byClass = new Set(Object.values(FAILURE_CAUSE_KINDS_BY_CLASS).flat());
    expect([...byClass].sort()).toEqual([...FAILURE_CAUSE_CLOSED_KINDS].sort());
  });
});

// ── ③ retryable 三态 + retryAfterMs 缺省 ─────────────────────────────────────

describe("retryable 三态与 retryAfterMs 缺省语义", () => {
  it("三态取值 true / false / \"conditional\" 均可表达（与重试规则 verdict 同词表）", () => {
    const retryabilities: readonly FailureRetryability[] = [true, false, "conditional"];
    expect(retryabilities).toHaveLength(3);
    const causes: readonly FailureCause[] = [
      { class: "provider", kind: "rate_limited", retryable: true, raw: "r" },
      { class: "provider", kind: "protocol_unsupported", retryable: false, raw: "r" },
      { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "r" },
    ];
    expect(causes.map((c) => c.retryable)).toEqual([true, false, "conditional"]);
  });

  it("retryAfterMs 缺省 = undefined（unknown，不产假 0——§3.3.2 双通道皆无时的缺省）", () => {
    const cause: FailureCause = { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "r" };
    expect(cause.retryAfterMs).toBeUndefined();
  });

  it("raw 空串合法（无文本错误形态——必填字段的最小合法值边界）", () => {
    const cause: FailureCause = { class: "engine", kind: "engine_x", retryable: false, raw: "" };
    expect(cause.raw).toBe("");
  });
});

// ── ④ wire 序列化往返 ────────────────────────────────────────────────────────

describe("FailureCause wire 序列化往返（shared lastRound.failure 载体契约）", () => {
  it("JSON 往返保真（判别联合逐字序列化，无运行时映射损失）", () => {
    const cause: FailureCause = {
      class: "provider",
      kind: "rate_limited",
      retryable: "conditional",
      retryAfterMs: 120_000,
      raw: "429: quota exceeded, resets 2026-10-24T18:00:00Z",
    };
    const roundTrip = JSON.parse(JSON.stringify(cause)) as FailureCause;
    expect(roundTrip).toEqual(cause);
    expect(roundTrip.class).toBe("provider");
    expect(roundTrip.kind).toBe("rate_limited");
    expect(roundTrip.retryable).toBe("conditional");
    expect(roundTrip.retryAfterMs).toBe(120_000);
  });

  it("cause 点拼序列化公式：\"<class>.<kind>\"（run 终局 failedMembers[].cause 载体）", () => {
    const cause: FailureCause = { class: "provider", kind: "rate_limited", retryable: "conditional", raw: "r" };
    expect(`${cause.class}.${cause.kind}`).toBe("provider.rate_limited");
  });
});

// ── ⑤ 词表边界 ───────────────────────────────────────────────────────────────

describe("class 词表边界", () => {
  it("class 五维词表逐成员可构造（provider/harness/agent/engine/user）", () => {
    const classes: readonly FailureCauseClass[] = ["provider", "harness", "agent", "engine", "user"];
    expect(classes).toHaveLength(5);
  });

  it("engine 透传族接受任意 engine_ 前缀 kind（开放面——引擎自报错误码透传契约）", () => {
    const kinds = ["engine_crashed", "engine_timeout", "engine_x_y"] as const;
    for (const kind of kinds) {
      const cause: FailureCause = { class: "engine", kind, retryable: false, raw: "raw" };
      expect(cause.kind).toBe(kind);
    }
  });
});
