// src/execution/__tests__/reconcile-sweep.test.ts
//
// [W4] 注册对账 sweep 单测：差集判据（record 终态 ∪ 已归档/不存在 → 补发；
// active → 跳过）、类型分流（[F2]：workflow/畸形走 workflow run 判据——终态 ∪
// store 查不到 → 补注销，running → 跳过；bash 无收口通道保守跳过——显式偏差；
// 未注入 workflow 判据时保守跳过）、写法（appendEntry 权威落盘，唯一写路径不经
// emit——[reload-closeout D4] 尽力 emit 已随恒 no-op 死路径删除；status 经
// protocol mapReasonToStatus 单点映射，budget_limited→failed 非 identity 用例锁定；
// appendEntry 抛错不计入）。差集输入 session 文件用 mkdtempSync 自建自删（禁触
// 真实数据目录）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runReconcileSweep, type SupervisedRecordState } from "../round-supervisor/reconcile-sweep.ts";

let tmpDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-sweep-"));
  sessionFile = path.join(tmpDir, "session.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.restoreAllMocks();
});

function writeSessionFile(lines: unknown[]): void {
  fs.writeFileSync(sessionFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}

function reg(id: string, type = "subagent"): unknown {
  return { customType: "pending:register", data: { id, type, name: id, registeredAt: 1, sessionId: "sess" } };
}

function unreg(id: string): unknown {
  return { customType: "pending:unregister", data: { id, reason: "completed" } };
}

function makeDeps(overrides: {
  states?: Map<string, SupervisedRecordState>;
  workflowStates?: Map<string, SupervisedRecordState>;
  injectWorkflowLookup?: boolean;
  appendEntry?: (customType: string, data: unknown) => void;
  sessionFile?: string;
} = {}) {
  const states = overrides.states ?? new Map<string, SupervisedRecordState>();
  const workflowStates = overrides.workflowStates;
  const appended: Array<{ customType: string; data: unknown }> = [];
  const deps = {
    sessionFile: overrides.sessionFile ?? sessionFile,
    lookupRecordState: (id: string): SupervisedRecordState => states.get(id) ?? "missing",
    // [F2] workflow 判据：显式注入（injectWorkflowLookup !== false 或给了
    // workflowStates）时按 Map 查；否则缺席（向后兼容形态）。
    ...(overrides.injectWorkflowLookup === false && workflowStates === undefined
      ? {}
      : {
          lookupWorkflowRunState: (id: string): SupervisedRecordState =>
            workflowStates?.get(id) ?? "missing",
        }),
    appendEntry: overrides.appendEntry ?? ((customType: string, data: unknown) => appended.push({ customType, data })),
  };
  return { deps, appended };
}

describe("runReconcileSweep 差集补发", () => {
  it("register(subagent) × record 终态 → 补发 unregister（appendEntry 权威，不经 emit），reason 取 closedReason", () => {
    writeSessionFile([reg("bg-1")]);
    const { deps, appended } = makeDeps({
      states: new Map([["bg-1", { terminal: true, closedReason: "cancelled" }]]),
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-1"]);
    expect(appended).toEqual([
      { customType: "pending:unregister", data: { id: "bg-1", reason: "cancelled", status: "cancelled" } },
    ]);
  });

  it("[D4] status 经 mapReasonToStatus 单点映射：budget_limited → failed（非 identity 词表锁定）", () => {
    writeSessionFile([reg("wf-bl", "workflow")]);
    const { deps, appended } = makeDeps({
      workflowStates: new Map([["wf-bl", { terminal: true, closedReason: "budget_limited" }]]),
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["wf-bl"]);
    expect(appended).toEqual([
      { customType: "pending:unregister", data: { id: "wf-bl", reason: "budget_limited", status: "failed" } },
    ]);
  });

  it("[D4] 未知 closedReason → status 由 protocol default=completed 兜底（原 status 裸写漂移修复）", () => {
    writeSessionFile([reg("bg-gc")]);
    const { deps, appended } = makeDeps({
      states: new Map([["bg-gc", { terminal: true, closedReason: "gc" }]]),
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-gc"]);
    expect(appended).toEqual([
      { customType: "pending:unregister", data: { id: "bg-gc", reason: "gc", status: "completed" } },
    ]);
  });

  it("record 已归档/不存在（查不到）→ 视同终态补注销（reason=expired）", () => {
    writeSessionFile([reg("bg-gone")]);
    const { deps, appended } = makeDeps({ states: new Map() }); // lookup 恒 missing
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-gone"]);
    expect(appended[0].data).toEqual({ id: "bg-gone", reason: "expired", status: "expired" });
  });

  it("record 活跃 → 保守跳过（不写）", () => {
    writeSessionFile([reg("bg-live")]);
    const { deps, appended } = makeDeps({ states: new Map([["bg-live", "active"]]) });
    const result = runReconcileSweep(deps);
    expect(result.skippedActive).toEqual(["bg-live"]);
    expect(appended).toHaveLength(0);
  });

  it("[F2] type=workflow × workflow run 终态 → 补注销（reason 取 run state reason）", () => {
    writeSessionFile([reg("wf-1", "workflow")]);
    const { deps, appended } = makeDeps({
      workflowStates: new Map([["wf-1", { terminal: true, closedReason: "aborted" }]]),
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["wf-1"]);
    expect(appended).toEqual([
      { customType: "pending:unregister", data: { id: "wf-1", reason: "aborted", status: "aborted" } },
    ]);
  });

  it("[F2] type=workflow × workflow run running → 保守跳过（宁挂账不误注销活跃 run）", () => {
    writeSessionFile([reg("wf-live", "workflow")]);
    const { deps, appended } = makeDeps({
      workflowStates: new Map([["wf-live", "active"]]),
    });
    const result = runReconcileSweep(deps);
    expect(result.skippedActive).toEqual(["wf-live"]);
    expect(result.reconciled).toEqual([]);
    expect(appended).toHaveLength(0);
  });

  it("[F2] 畸形条目（type 缺失/未知，normalizePendingType 归 workflow）× store 查不到 → 视同终态补注销", () => {
    writeSessionFile([reg("bad-1", "mystery")]);
    const { deps, appended } = makeDeps({}); // workflowStates 缺省 = 恒 missing
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bad-1"]);
    expect(appended[0].data).toEqual({ id: "bad-1", reason: "expired", status: "expired" });
  });

  it("[F2] type=bash → 保守跳过（无 record/store 可查，显式偏差——宁挂账不失明）", () => {
    writeSessionFile([reg("bt-1", "bash")]);
    const { deps, appended } = makeDeps({});
    const result = runReconcileSweep(deps);
    expect(result.skippedNonSubagent).toEqual(["bt-1"]);
    expect(appended).toHaveLength(0);
  });

  it("[F2] deps 未注入 workflow 判据 → workflow/未知类型保守跳过（判据缺席 ≠ 可注销）", () => {
    writeSessionFile([reg("wf-1", "workflow"), reg("bad-1", "mystery")]);
    const { deps, appended } = makeDeps({ injectWorkflowLookup: false });
    const result = runReconcileSweep(deps);
    expect(result.skippedNonSubagent.sort()).toEqual(["bad-1", "wf-1"]);
    expect(appended).toHaveLength(0);
  });

  it("已注销的 id 不出现在差集 → 不补发（finalizeRun 直落后的幂等：注销 entry 抵消 register）", () => {
    // 多写方竞态幂等的 sweep 侧半边：finalizeRun 直落已落 {id, reason, status} 形态的
    // 注销 entry（customType 相同、多出的 status 字段不影响差集判据——读取侧只认
    // customType + data.id），sweep 差集为空、不重复写。
    writeSessionFile([reg("bg-1"), { customType: "pending:unregister", data: { id: "bg-1", reason: "completed", status: "completed" } }]);
    const { deps, appended } = makeDeps();
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual([]);
    expect(appended).toHaveLength(0);
  });

  it("unregister 之后的重注册重新进差集（同 id 重 register = 后写胜出）", () => {
    writeSessionFile([reg("bg-1"), unreg("bg-1"), reg("bg-1")]);
    const { deps, appended } = makeDeps();
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-1"]);
    expect(appended).toHaveLength(1);
  });

  it("sessionFile 缺失 → 空跑（不抛）", () => {
    const { deps } = makeDeps({ sessionFile: undefined });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual([]);
  });

  it("session 文件不可读（未 flush/被删）→ 空跑", () => {
    const { deps } = makeDeps({ sessionFile: path.join(tmpDir, "nope.jsonl") });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual([]);
  });

  it("appendEntry 抛错 → 不计 reconciled（差集残留交下次 sweep 重试）", () => {
    writeSessionFile([reg("bg-1"), reg("bg-2")]);
    const { deps, appended } = makeDeps({
      appendEntry: (customType, data) => {
        if ((data as { id: string }).id === "bg-1") throw new Error("EACCES");
        appended.push({ customType, data });
      },
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-2"]);
    expect(appended.map((e) => (e.data as { id: string }).id)).toEqual(["bg-2"]);
  });

  it("坏行（截断 JSON）跳过不拖垮其余条目", () => {
    fs.writeFileSync(sessionFile, [JSON.stringify(reg("bg-1")), '{"customType":"pending:regis'].join("\n"), "utf-8");
    const { deps, appended } = makeDeps({
      states: new Map([["bg-1", { terminal: true, closedReason: "gc" }]]),
    });
    const result = runReconcileSweep(deps);
    expect(result.reconciled).toEqual(["bg-1"]);
    expect(appended).toHaveLength(1);
  });
});
