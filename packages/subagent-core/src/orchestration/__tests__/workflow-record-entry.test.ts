// workflow-record-entry.test.ts —— entry 契约单源的 v1 判定分类测试。
//
// 覆盖：
// - 表驱动全 reason 分支（wrong-type / missing-v / future-v / no-snapshot——
//   每分支至少一行真实输入）；
// - ok 分支：snapshot 引用透传（不复制不校验）与 truthy-即放行语义；
// - 词表零差集守卫：期望 reason 词表与判别联合双向穷尽（类型级赋值锚 +
//   运行时表覆盖核对——任一侧加成员即红）；
// - 常量钉住：customType / entry schema 版本的字面量值锁（壳测试另有
//   jsonl-run-store-session-file.test.ts 同款锁，双侧互证）。
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_ENTRY_VERSION,
  classifyWorkflowRecordEntryData,
  type WorkflowRecordEntryClassification,
} from "../workflow-record-entry.ts";

// 期望 reason 词表（测试自持期望载体；与判别联合的零差集由下方双向穷尽赋值锁）。
const EXPECTED_REASONS = ["wrong-type", "missing-v", "future-v", "no-snapshot"] as const;

type ExpectedReason = (typeof EXPECTED_REASONS)[number];
type UnionReason = Extract<WorkflowRecordEntryClassification, { ok: false }>["reason"];

/** 表驱动用例（reason 全分支 + 各形态变体）。 */
const CASES: Array<{ name: string; data: unknown; reason: ExpectedReason }> = [
  // wrong-type：data 连对象都不是（截断/半写）
  { name: "data undefined（entry 无 data 字段）", data: undefined, reason: "wrong-type" },
  { name: "data null", data: null, reason: "wrong-type" },
  { name: "data 非对象（number）", data: 42, reason: "wrong-type" },
  { name: "data 非对象（string）", data: "corrupt", reason: "wrong-type" },
  // missing-v：对象形态但版本缺失（写点恒定 v:1，缺失即损坏）
  { name: "对象缺 v", data: { snapshot: {} }, reason: "missing-v" },
  { name: "v 显式 undefined", data: { v: undefined, snapshot: {} }, reason: "missing-v" },
  { name: "空对象", data: {}, reason: "missing-v" },
  // future-v：版本值非当前版（含类型漂移——严格 !== 判定）
  { name: "未来版本 v=2", data: { v: 2, snapshot: {} }, reason: "future-v" },
  { name: "v 类型漂移（'1' 字符串）", data: { v: "1", snapshot: {} }, reason: "future-v" },
  { name: "v=0", data: { v: 0, snapshot: {} }, reason: "future-v" },
  // no-snapshot：v1 但快照 falsy
  { name: "v1 无 snapshot 字段", data: { v: 1 }, reason: "no-snapshot" },
  { name: "v1 snapshot null", data: { v: 1, snapshot: null }, reason: "no-snapshot" },
  { name: "v1 snapshot 空串", data: { v: 1, snapshot: "" }, reason: "no-snapshot" },
];

describe("classifyWorkflowRecordEntryData 表驱动（全 reason 分支）", () => {
  it.each(CASES)("$name → $reason", ({ data, reason }) => {
    expect(classifyWorkflowRecordEntryData(data)).toEqual({ ok: false, reason });
  });

  it("表覆盖全部期望 reason（零遗漏——分支缺失即红）", () => {
    const covered = new Set(CASES.map((c) => c.reason));
    expect([...covered].sort()).toEqual([...EXPECTED_REASONS].sort());
  });
});

describe("classifyWorkflowRecordEntryData ok 分支", () => {
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

describe("词表零差集守卫（期望词表 ↔ 判别联合）", () => {
  it("期望词表恰好 4 成员且互异（增删成员须同步联合类型与表用例）", () => {
    expect(EXPECTED_REASONS).toHaveLength(4);
    expect(new Set(EXPECTED_REASONS).size).toBe(EXPECTED_REASONS.length);
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
  it("customType 与 entry schema 版本字面量锁", () => {
    expect(WORKFLOW_RECORD_CUSTOM_TYPE).toBe("workflow-record");
    expect(WORKFLOW_RECORD_ENTRY_VERSION).toBe(1);
  });
});
