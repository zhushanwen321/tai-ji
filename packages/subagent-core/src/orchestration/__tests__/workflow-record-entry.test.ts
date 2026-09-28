// workflow-record-entry.test.ts —— entry 契约单源的 v1/v2 双版本判定分类测试。
//
// [W1 / D1] 版本升格 2 后的重写：v1 全量快照分支保留为兼容读面（分支语义与
// 收敛前逐分支对齐），v2 新增 registered/settled kind 判别。覆盖：
// - 表驱动全 reason 分支（wrong-type / missing-v / future-v / no-snapshot /
//   unknown-kind——每分支至少一行真实输入）；
// - ok 分支：v1 snapshot 引用透传（不复制不校验）与 truthy-即放行语义；
// - v2 分支：registered/settled 载荷透传（含 journalPath 锚点字段）；
// - 词表零差集守卫：期望 reason 词表与判别联合双向穷尽（类型级赋值锚 +
//   运行时表覆盖核对——任一侧加成员即红）；
// - 常量钉住：customType / entry schema 版本（W1 起 = 2）的字面量值锁（壳测试
//   另有 jsonl-run-store-session-file.test.ts 同款锁，双侧互证）。
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_KINDS,
  WORKFLOW_RECORD_ENTRY_VERSION,
  classifyWorkflowRecordEntryData,
  type WorkflowRecordEntryClassification,
} from "../workflow-record-entry.ts";

// 期望 reason 词表（测试自持期望载体；与判别联合的零差集由下方双向穷尽赋值锁）。
// v2 是合法形态的独立判别臂（载荷通道），与失败 reason 同层枚举但不属「损坏」。
const EXPECTED_REASONS = [
  "wrong-type",
  "missing-v",
  "future-v",
  "no-snapshot",
  "unknown-kind",
  "v2",
] as const;

type ExpectedReason = (typeof EXPECTED_REASONS)[number];
type UnionReason = Extract<WorkflowRecordEntryClassification, { ok: false }>["reason"];

/** 表驱动用例（failure reason 全分支 + 各形态变体；v2 合法臂单独 describe）。 */
const CASES: Array<{ name: string; data: unknown; reason: Exclude<ExpectedReason, "v2"> }> = [
  // wrong-type：data 连对象都不是（截断/半写）
  { name: "data undefined（entry 无 data 字段）", data: undefined, reason: "wrong-type" },
  { name: "data null", data: null, reason: "wrong-type" },
  { name: "data 非对象（number）", data: 42, reason: "wrong-type" },
  { name: "data 非对象（string）", data: "corrupt", reason: "wrong-type" },
  // missing-v：对象形态但版本缺失（写点恒定写 v，缺失即损坏）
  { name: "对象缺 v（v1 快照残骸）", data: { snapshot: {} }, reason: "missing-v" },
  { name: "对象缺 v（v2 残骸）", data: { kind: "registered" }, reason: "missing-v" },
  { name: "v 显式 undefined", data: { v: undefined, snapshot: {} }, reason: "missing-v" },
  { name: "空对象", data: {}, reason: "missing-v" },
  // future-v：版本值非 1/2（含类型漂移——严格判别）
  { name: "未来版本 v=3", data: { v: 3, snapshot: {} }, reason: "future-v" },
  { name: "v 类型漂移（'1' 字符串）", data: { v: "1", snapshot: {} }, reason: "future-v" },
  { name: "v=0", data: { v: 0, snapshot: {} }, reason: "future-v" },
  // no-snapshot：v1 但快照 falsy（v1 专属分支——v2 无 snapshot 概念）
  { name: "v1 无 snapshot 字段", data: { v: 1 }, reason: "no-snapshot" },
  { name: "v1 snapshot null", data: { v: 1, snapshot: null }, reason: "no-snapshot" },
  { name: "v1 snapshot 空串", data: { v: 1, snapshot: "" }, reason: "no-snapshot" },
  // unknown-kind：v2 但判别键不在词表内（v2 专属分支）
  { name: "v2 无 kind 字段", data: { v: 2 }, reason: "unknown-kind" },
  { name: "v2 kind 非法值", data: { v: 2, kind: "snapshot" }, reason: "unknown-kind" },
  { name: "v2 kind 类型漂移（number）", data: { v: 2, kind: 1 }, reason: "unknown-kind" },
];

describe("classifyWorkflowRecordEntryData 表驱动（failure reason 全分支）", () => {
  it.each(CASES)("$name → $reason", ({ data, reason }) => {
    expect(classifyWorkflowRecordEntryData(data)).toEqual({ ok: false, reason });
  });

  it("表覆盖全部期望 failure reason（零遗漏——分支缺失即红）", () => {
    const covered = new Set(CASES.map((c) => c.reason));
    const expectedFailure = EXPECTED_REASONS.filter((r) => r !== "v2");
    expect([...covered].sort()).toEqual([...expectedFailure].sort());
  });
});

describe("classifyWorkflowRecordEntryData ok 分支（v1 兼容读面）", () => {
  it("v1 且 snapshot truthy → ok，snapshot 引用透传（不复制不校验形状）", () => {
    const snapshot = { v: "wf-run-v2", runId: "wf-1" };
    const result = classifyWorkflowRecordEntryData({ v: 1, snapshot, updatedAt: "2026-09-24T00:00:00Z" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot).toBe(snapshot);
    }
  });

  it("snapshot 为 truthy 非对象也放行（形状校验归消费方解码层）", () => {
    const result = classifyWorkflowRecordEntryData({ v: 1, snapshot: "not-an-object" });
    expect(result).toEqual({ ok: true, snapshot: "not-an-object" });
  });
});

describe("classifyWorkflowRecordEntryData v2 分支（W1 注册/终态两条小条目）", () => {
  it("v2 registered → reason 'v2'，载荷透传 + journalPath 锚点字段在位", () => {
    const entry = {
      v: 2,
      kind: "registered",
      runId: "wf-1",
      workflowName: "review-fix-loop",
      scriptName: "review-fix-loop",
      slug: "pr-123",
      startedAt: 1780000000000,
      journalPath: "/tmp/workflow-state/wf-1.events.jsonl",
    };
    const result = classifyWorkflowRecordEntryData(entry);
    expect(result).toEqual({ ok: false, reason: "v2", entry });
    if (!result.ok && result.reason === "v2" && result.entry.kind === "registered") {
      // TS 窄化面：判别联合经 kind 收窄（消费方解码路径的形态锚）
      expect(result.entry.journalPath).toBe("/tmp/workflow-state/wf-1.events.jsonl");
    }
  });

  it("v2 settled → reason 'v2'，终局摘要字段透传", () => {
    const entry = {
      v: 2,
      kind: "settled",
      runId: "wf-1",
      status: "done",
      reason: "completed",
      outcome: "done",
      settledAt: 1780000123000,
      callCount: 4,
      usedTokens: 12345,
    };
    const result = classifyWorkflowRecordEntryData(entry);
    expect(result).toEqual({ ok: false, reason: "v2", entry });
  });

  it("v2 载荷不做形状校验（truthy kind 即透传——解码归消费方，与 v1 snapshot 同哲学）", () => {
    const result = classifyWorkflowRecordEntryData({ v: 2, kind: "settled" });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "v2") {
      expect(result.entry).toEqual({ v: 2, kind: "settled" });
    }
  });
});

describe("词表零差集守卫（期望词表 ↔ 判别联合）", () => {
  it("期望词表恰好 6 成员且互异（增删成员须同步联合类型与表用例）", () => {
    expect(EXPECTED_REASONS).toHaveLength(6);
    expect(new Set(EXPECTED_REASONS).size).toBe(EXPECTED_REASONS.length);
  });

  it("kind 词表恰为 registered/settled（D1 条目契约：每实体两条小条目）", () => {
    expect([...WORKFLOW_RECORD_ENTRY_KINDS]).toEqual(["registered", "settled"]);
  });

  it("类型级双向穷尽锚：期望词表与联合 reason 零差集（任一侧加成员即编译失败）", () => {
    // 双向可赋值 = 零差集；`as` 只是让空数组字面量取目标类型，赋值兼容性由
    // tsc --noEmit 把关（词表单侧漂移结构性不可达——run-events.test.ts 的
    // never 穷尽锚同款纪律）。
    const fromUnion: ExpectedReason[] = [] as UnionReason[];
    const fromExpected: UnionReason[] = [] as ExpectedReason[];
    expect(fromUnion).toEqual(fromExpected);
  });
});

describe("常量钉住", () => {
  it("customType 与 entry schema 版本字面量锁（W1 起版本 = 2——v1 为兼容读面）", () => {
    expect(WORKFLOW_RECORD_CUSTOM_TYPE).toBe("workflow-record");
    expect(WORKFLOW_RECORD_ENTRY_VERSION).toBe(2);
  });
});
