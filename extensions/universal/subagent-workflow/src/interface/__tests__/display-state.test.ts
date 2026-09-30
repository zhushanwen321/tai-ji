// src/interface/__tests__/display-state.test.ts
//
// [§2.2 B 档] run 域展示态单点：三态投影 + 色调 / 徽标 / 签名片段三张映射的等价性。
//
// 回归价值：本批把原散在 WorkflowsView 三处的判定收敛到一处——本测试同时钉住
// 「与既有 TUI 输出逐字一致」与「run 域色档与 format.ts 的 statusColorToken 同档」
//（后者是本批修掉的三处可见错误之一的防线）。
import { describe, expect, it } from "vitest";

import type { WorkflowRun } from "@zhushanwen/subagent-core";

import {
  formatRunBadge,
  isFailedTerminal,
  runDisplaySignaturePart,
  runDisplayStateOf,
  runToneOf,
} from "../display-state.ts";
import {
  formatStatusBadge,
  type ThemeLike,
} from "../format.ts";

const markingTheme: ThemeLike = {
  fg: (color, text) => `${color}(${text})`,
  bg: (color, text) => `${color}(${text})`,
  bold: (text) => `bold(${text})`,
  underline: (text) => `u(${text})`,
};

/** 最小 run 形态（display-state 读 runSummary：runId/spec/meta/state 四组字段）。 */
function makeRun(shape: {
  status?: string;
  reason?: string;
  interruptedAt?: string;
  budget?: { usedTokens: number; maxTokens?: number; usedCost: number };
} = {}): WorkflowRun {
  return {
    runId: "wf-display",
    spec: { scriptName: "display-wf" },
    meta: { startedAt: "2026-09-30T00:00:00.000Z", ...(shape.interruptedAt ? { interruptedAt: shape.interruptedAt } : {}) },
    state: {
      status: shape.status ?? "running",
      ...(shape.reason !== undefined ? { reason: shape.reason } : {}),
      budget: shape.budget ?? { usedTokens: 0, maxTokens: 200_000, usedCost: 0 },
      trace: { toArray: () => [] },
      errorLogs: [],
    },
  } as unknown as WorkflowRun;
}

describe("runDisplayStateOf（三态投影与可中断性）", () => {
  it("running → status running + abortable", () => {
    const ds = runDisplayStateOf(makeRun());
    expect(ds.status).toBe("running");
    expect(ds.abortable).toBe(true);
    expect(ds.doneReason).toBeUndefined();
  });

  it("interrupted（meta.interruptedAt）→ 不可中断、无 doneReason", () => {
    const ds = runDisplayStateOf(makeRun({ interruptedAt: "2026-09-30T01:00:00.000Z" }));
    expect(ds.status).toBe("interrupted");
    expect(ds.abortable).toBe(false);
  });

  it("done + reason → 不可中断 + doneReason 透传", () => {
    const ds = runDisplayStateOf(makeRun({ status: "done", reason: "failed" }));
    expect(ds.status).toBe("done");
    expect(ds.abortable).toBe(false);
    expect(ds.doneReason).toBe("failed");
  });

  it("会计面透传活体快照（含 maxTokens 缺席形态）", () => {
    const ds = runDisplayStateOf(makeRun({ budget: { usedTokens: 1234, usedCost: 0.5 } }));
    expect(ds.accounting).toEqual({ usedTokens: 1234, usedCost: 0.5 });
  });
});

describe("映射表（色调 / 徽标 / 失败族）", () => {
  it.each([
    [{}, "warning", "warning(● running)"],
    [{ interruptedAt: "t" }, "muted", "muted(○ interrupted)"],
    [{ status: "done", reason: "completed" }, "success", "success(✓ completed)"],
    [{ status: "done" }, "success", "success(✓ completed)"],
    [{ status: "done", reason: "failed" }, "error", "error(✗ failed)"],
    [{ status: "done", reason: "aborted" }, "error", "error(✗ aborted)"],
    [{ status: "done", reason: "budget_limited" }, "error", "error(⚠ budget)"],
    [{ status: "done", reason: "time_limited" }, "error", "error(⚠ timeout)"],
  ] as const)("形态 %j → tone %s / badge %s", (shape, tone, badge) => {
    const ds = runDisplayStateOf(makeRun(shape as never));
    expect(runToneOf(ds)).toBe(tone);
    expect(formatRunBadge(ds, markingTheme)).toBe(badge);
  });

  it("失败族判定只认 done + 非 completed", () => {
    expect(isFailedTerminal(runDisplayStateOf(makeRun({ status: "done", reason: "failed" })))).toBe(true);
    expect(isFailedTerminal(runDisplayStateOf(makeRun({ status: "done", reason: "completed" })))).toBe(false);
    expect(isFailedTerminal(runDisplayStateOf(makeRun({ status: "done" })))).toBe(false);
    expect(isFailedTerminal(runDisplayStateOf(makeRun()))).toBe(false);
  });

  it("run 域徽标与 format.ts 的既有徽标逐字一致（同输入同输出，防两表漂移）", () => {
    const cases: Array<[never, string]> = [
      [{} as never, "running"],
      [{ interruptedAt: "t" } as never, "interrupted"],
      [{ status: "done", reason: "completed" } as never, "completed"],
      [{ status: "done", reason: "failed" } as never, "failed"],
      [{ status: "done", reason: "aborted" } as never, "aborted"],
      [{ status: "done", reason: "budget_limited" } as never, "budget_limited"],
      [{ status: "done", reason: "time_limited" } as never, "time_limited"],
    ];
    for (const [shape, legacyStatus] of cases) {
      const ds = runDisplayStateOf(makeRun(shape));
      expect(formatRunBadge(ds, markingTheme)).toBe(formatStatusBadge(legacyStatus as never, markingTheme));
    }
  });

  it("签名片段：生命周期面全字段进签名（状态/原因/可中断性任一变化即失效）", () => {
    const running = runDisplaySignaturePart(runDisplayStateOf(makeRun()));
    const failed = runDisplaySignaturePart(runDisplayStateOf(makeRun({ status: "done", reason: "failed" })));
    const completed = runDisplaySignaturePart(runDisplayStateOf(makeRun({ status: "done", reason: "completed" })));
    expect(new Set([running, failed, completed]).size).toBe(3);
    expect(running).toContain("running");
  });
});
