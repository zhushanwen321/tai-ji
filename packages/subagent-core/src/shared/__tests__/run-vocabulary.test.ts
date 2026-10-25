// src/shared/__tests__/run-vocabulary.test.ts
//
// [subagent-observability u-foundation] run-vocabulary 词表枚举完整性测试锚
// （设计 §3.4「FailureCause.kind 词表与 SettlementReason 结清枚举同款枚举完整性
// 测试锚」——run-vocabulary 同位；覆盖两词表 + RunOutcome 第五值）。
//
// 锁定面：
//   ① SettlementReason 结清枚举封闭五值（completed/failed/cancelled/lost/no_result，
//      §3.3.6）+ 解析缺省 unknown 的 fail-visible 类型面（词表外 reason 不落五值）
//      + 与 extension-protocol SETTLEMENT_REASONS 的跨包对拍（词表漂移防线）；
//   ② RunOutcome 五值（含 partially_succeeded 第五值，§3.3.8）+ 双包对账的 core
//      侧成员集合（runtime workflow-outcome-vocab-parity 断言的 core 输入面）；
//   ③ DoneReason 三词表跨词表对拍（core 权威 ALL_DONE_REASONS ≡ core 镜像
//      RunDoneReason ≡ shared WORKFLOW_DONE_REASON_ALL——三份字面量任一侧单独
//      扩缩值即红；runtime vocab-parity 测试族只对账 status/outcome 轴，不覆盖
//      DoneReason 轴）；
//   ④ runSettledOutcomeToDoneReason 对 partially_succeeded 的恒等映射行（折叠成
//      failed 即丢「部分成功」终局原因——runtime 派生视图 reason 依赖本行）。
//
// 纯常量/纯函数断言，零 fs / 零 timer——不触碰真实数据目录。

import { describe, expect, it } from "vitest";

import { SETTLEMENT_REASONS } from "@zhushanwen/extension-protocol";
import { WORKFLOW_DONE_REASON_ALL } from "@taiji/shared";

import { ALL_DONE_REASONS, type DoneReason } from "../../orchestration/models/types.ts";
import {
  ALL_RUN_OUTCOMES,
  ALL_SETTLEMENT_REASONS,
  runSettledOutcomeToDoneReason,
  type ResolvedSettlementReason,
  type RunDoneReason,
} from "../run-vocabulary.ts";

describe("SettlementReason 结清枚举（§3.3.6 封闭五值）", () => {
  it("恰为五值：completed/failed/cancelled/lost/no_result（词表封闭——新增成员同 commit 登记常量与本断言）", () => {
    expect([...ALL_SETTLEMENT_REASONS]).toEqual([
      "completed",
      "failed",
      "cancelled",
      "lost",
      "no_result",
    ]);
    expect(new Set(ALL_SETTLEMENT_REASONS).size).toBe(ALL_SETTLEMENT_REASONS.length);
  });

  it("解析缺省 unknown 在 ResolvedSettlementReason 值域（fail-visible——词表外 reason 不落五值，不产假成功）", () => {
    const parsed: ResolvedSettlementReason = "unknown";
    expect(parsed).toBe("unknown");
    // unknown 不是结清事实——不在封闭五值内（解析缺省与结清词表分层）。
    expect(ALL_SETTLEMENT_REASONS).not.toContain("unknown");
  });

  it("lost 与 no_result 边界语义互异（lost = 有宿主重启事实；no_result = 无事实可依/被接管）", () => {
    expect(ALL_SETTLEMENT_REASONS).toContain("lost");
    expect(ALL_SETTLEMENT_REASONS).toContain("no_result");
    expect("lost").not.toBe("no_result");
  });

  it("双包词表对拍：core ALL_SETTLEMENT_REASONS 与 extension-protocol SETTLEMENT_REASONS 逐成员一致（词表漂移跨包防线）", () => {
    // core 是结清产值权威写侧、protocol 是落盘 reason 的解析权威通道——两侧各自
    // 持同值字面量（依赖方向 core → protocol，protocol 不反向引 core），漂移只能
    // 靠本对拍抓：任一侧增删/改名成员即红，强迫同批登记。
    expect([...ALL_SETTLEMENT_REASONS]).toEqual([...SETTLEMENT_REASONS]);
    expect(new Set(ALL_SETTLEMENT_REASONS).size).toBe(new Set(SETTLEMENT_REASONS).size);
  });
});

describe("RunOutcome 枚举完整性（§3.3.8 第五值）", () => {
  it("五值：done/failed/cancelled/time_limited + partially_succeeded（成员交付结算派生的独立档）", () => {
    expect([...ALL_RUN_OUTCOMES]).toEqual([
      "done",
      "failed",
      "cancelled",
      "time_limited",
      "partially_succeeded",
    ]);
  });

  it("interrupted 不在 outcome 词表（[D2] 移出入 lifecycle 暂停态——回归锚保持）", () => {
    expect(ALL_RUN_OUTCOMES).not.toContain("interrupted");
  });
});

describe("DoneReason 三词表跨词表对拍（core 权威 ≡ core 镜像 ≡ shared）", () => {
  // 三份字面量物理独立（core DoneReason 编排层权威 / RunDoneReason shared 层镜像 /
  // shared WorkflowDoneReason wire 契约——core↔shared 依赖方向不允许物理单源），
  // 编译锁只能锁各自联合与常量的内部一致，跨词表漂移只能靠本对拍抓：任一侧单独
  // 扩缩值即红，强迫三份同批显式重审。
  it("core ALL_DONE_REASONS ≡ shared WORKFLOW_DONE_REASON_ALL 逐成员一致（值级对拍）", () => {
    expect([...ALL_DONE_REASONS].sort()).toEqual([...WORKFLOW_DONE_REASON_ALL].sort());
    expect(new Set(ALL_DONE_REASONS).size).toBe(ALL_DONE_REASONS.length);
    expect(new Set(WORKFLOW_DONE_REASON_ALL).size).toBe(WORKFLOW_DONE_REASON_ALL.length);
  });

  it("封闭六值快照（任一词表单独扩缩值即本用例红——三份同批显式重审）", () => {
    const six = [
      "aborted",
      "budget_limited",
      "completed",
      "failed",
      "partially_succeeded",
      "time_limited",
    ];
    expect([...ALL_DONE_REASONS].sort()).toEqual(six);
    expect([...WORKFLOW_DONE_REASON_ALL].sort()).toEqual(six);
  });

  it("镜像联合值域双向一致（编译锚消费：收窄/扩值漏跟任一方向漂移即编译红）", () => {
    // 编译锚①：ALL_DONE_REASONS 值域 ⊆ RunDoneReason（镜像联合收窄即本行编译红）。
    const mirrorTyped: readonly RunDoneReason[] = ALL_DONE_REASONS;
    // 编译锚②：RunDoneReason 联合 ⊆ DoneReason 值域（镜像单独扩值漏跟权威即编译红）。
    type RunDoneReasonWithinAuthority = [RunDoneReason] extends [DoneReason]
      ? true
      : ["RunDoneReason 镜像扩值须与 DoneReason 权威同批（run-vocabulary 三词表对拍锚）"];
    const mirrorCoverage: RunDoneReasonWithinAuthority = true;
    expect(mirrorTyped).toHaveLength(ALL_DONE_REASONS.length);
    expect(mirrorCoverage).toBe(true);
  });
});

describe("RunDoneReason 映射行", () => {

  it("runSettledOutcomeToDoneReason：partially_succeeded 恒等映射（折叠成 failed 即丢部分成功终局原因）", () => {
    expect(runSettledOutcomeToDoneReason("partially_succeeded")).toBe("partially_succeeded");
  });

  it("既有四行映射不回归（done→completed / cancelled→aborted / time_limited→time_limited / failed→failed）", () => {
    expect(runSettledOutcomeToDoneReason("done")).toBe("completed");
    expect(runSettledOutcomeToDoneReason("cancelled")).toBe("aborted");
    expect(runSettledOutcomeToDoneReason("time_limited")).toBe("time_limited");
    expect(runSettledOutcomeToDoneReason("failed")).toBe("failed");
  });

  it("budget_limited 细分恢复：outcome=failed + errorCode=budget_limited → reason=budget_limited（分级不折叠）", () => {
    expect(runSettledOutcomeToDoneReason("failed", "budget_limited")).toBe("budget_limited");
  });
});
