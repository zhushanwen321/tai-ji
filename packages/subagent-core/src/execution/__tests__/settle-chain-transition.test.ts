// src/execution/__tests__/settle-chain-transition.test.ts
//
// [P1b-1] settle 链收口测试（run 显式状态机 D5 的 settle 接线批次）。
//
// 锁四面（验收条款 c：settle 链改调 transition 后直写通道删除）：
// 1. settleWorkflowRecord 收口单点：CAS 通过 → exec.finalizeRecord 调用（closedReason
//    透传）；CAS 拒绝（竞态抢先收口）→ 静默跳过（现状守卫语义）。
// 2. settleOneShotOutcome（RunOrchestration）workflow origin 分支：成功/aborted →
//    record 终态化（idle + closedReason gc/cancelled）经收口单点。
// 3. finalizeFailed / finalizeAborted（RecordLifecycle）workflow origin 分支：失败/
//    取消 → 同一收口单点（静默吞失败路径的间接接入面）。
// 4. 直写通道删除断言（机器守卫）：读三个领地源文件断言 workflow origin 直写对
//    （tryTransition(record, "closed" + 内联 finalizeRecord 对）不再存在于
//    run-orchestration / record-lifecycle——收口后唯一剩余点在 worker-message-pump。
//
// doFinalizeRecord 经 vi.mock 拦截（避免真实 manifest/archive 写面）；journal 面
// （pump 接线段）走 vitest no-op 防线（本文件不注入目录——断言面在 record 终态，
// journal 落账已由 run-event-dispatch / worker-message-pump-run-events 两文件锁定）。

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../persistence/finalize-record.ts", () => ({
  doFinalizeRecord: vi.fn(async () => {}),
}));

import { createRecord, tryTransition } from "../persistence/execution-record.ts";
import { settleWorkflowRecord } from "../../orchestration/worker-message-pump.ts";
import { RunOrchestration } from "../service/run-orchestration.ts";
import { RecordLifecycle } from "../service/record-lifecycle.ts";
import type { AgentResult, ExecutionRecord } from "../assembly/types.ts";

// ── helpers ──────────────────────────────────────────────────

/** workflow origin 的 running record（真实两态机——CAS/终态断言全真）。 */
function makeWorkflowRecord(id: string): ExecutionRecord {
  return createRecord(id, {
    agent: "reviewer",
    mode: "background",
    task: "review it",
    slug: "reviewer",
    startedAt: Date.now(),
    origin: "workflow",
    parentRunId: `wf-${id}`,
  });
}

const successResult: AgentResult = {
  text: "done",
  turns: 1,
  durationMs: 10,
  success: true,
  sessionId: "sa-x",
  toolCalls: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. settleWorkflowRecord 收口单点 ─────────────────────────

describe("settleWorkflowRecord（D7 例外族收口单点）", () => {
  it("CAS 通过 → exec.finalizeRecord 调用且 closedReason 透传", async () => {
    const record = makeWorkflowRecord("sa-sw-1");
    const finalizeRecord = vi.fn(async () => {});

    await settleWorkflowRecord(record, successResult, "gc", { finalizeRecord });

    expect(finalizeRecord).toHaveBeenCalledTimes(1);
    expect(finalizeRecord).toHaveBeenCalledWith(successResult, "gc");
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
  });

  it("CAS 拒绝（竞态抢先收口）→ 静默跳过不覆盖（现状守卫语义）", async () => {
    const record = makeWorkflowRecord("sa-sw-2");
    tryTransition(record, "closed", "cancelled"); // 抢先方
    const finalizeRecord = vi.fn(async () => {});

    await settleWorkflowRecord(record, successResult, "gc", { finalizeRecord });

    expect(finalizeRecord).not.toHaveBeenCalled();
    expect(record.closedReason).toBe("cancelled"); // 不被 "gc" 覆盖
  });
});

// ── 2. settleOneShotOutcome（RunOrchestration workflow origin 分支） ──

describe("settleOneShotOutcome 经收口单点（workflow origin）", () => {
  function makeOrchestration() {
    const finalizeRecord = vi.fn(async () => {});
    const orchestration = new RunOrchestration({
      finalizeRecord,
    } as unknown as ConstructorParameters<typeof RunOrchestration>[0]);
    return { orchestration, finalizeRecord };
  }

  it("成功 → record idle + closedReason=gc + finalizeRecord('closed','gc')", async () => {
    const { orchestration, finalizeRecord } = makeOrchestration();
    const record = makeWorkflowRecord("sa-so-1");

    await orchestration.settleOneShotOutcome(record, successResult, false);

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
    expect(finalizeRecord).toHaveBeenCalledWith(record, expect.objectContaining({ success: true }), "closed", "gc");
  });

  it("aborted → closedReason=cancelled（不漂移为 gc）", async () => {
    const { orchestration, finalizeRecord } = makeOrchestration();
    const record = makeWorkflowRecord("sa-so-2");

    await orchestration.settleOneShotOutcome(record, successResult, true);

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("cancelled");
    expect(finalizeRecord).toHaveBeenCalledWith(record, successResult, "closed", "cancelled");
  });

  it("失败（success=false）→ closedReason=gc（原三分支等价：失败与成功同 gc）", async () => {
    const { orchestration, finalizeRecord } = makeOrchestration();
    const record = makeWorkflowRecord("sa-so-3");
    const failedResult: AgentResult = { ...successResult, success: false, error: "boom" };

    await orchestration.settleOneShotOutcome(record, failedResult, false);

    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
    expect(finalizeRecord).toHaveBeenCalledWith(record, failedResult, "closed", "gc");
  });
});

// ── 3. finalizeFailed / finalizeAborted（RecordLifecycle workflow origin 分支） ──

describe("finalizeFailed / finalizeAborted 经收口单点（workflow origin）", () => {
  function makeLifecycle() {
    const lifecycle = new RecordLifecycle({
      getWorktreeManager: () => ({}),
      getModelService: () => ({}),
      getStore: () => ({ markRoundIdle: vi.fn() }),
      getNotifyHost: () => ({}),
      getPi: () => null,
      getSessionsDir: () => os.tmpdir(),
    } as unknown as ConstructorParameters<typeof RecordLifecycle>[0]);
    return lifecycle;
  }

  it("finalizeFailed → record idle + closedReason=gc + 合成 failed result（不 re-throw）", async () => {
    const lifecycle = makeLifecycle();
    const record = makeWorkflowRecord("sa-ff-1");

    const result = await lifecycle.finalizeFailed(record, new Error("engine crashed"));

    expect(result.success).toBe(false);
    expect(result.error).toContain("engine crashed");
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("gc");
  });

  it("finalizeAborted → record idle + closedReason=cancelled", async () => {
    const lifecycle = makeLifecycle();
    const record = makeWorkflowRecord("sa-fa-1");

    const result = await lifecycle.finalizeAborted(record);

    expect(result.success).toBe(false);
    expect(record.status).toBe("idle");
    expect(record.closedReason).toBe("cancelled");
  });

  it("非 workflow origin 不终态化（既有 U5 语义：失败轮落 idle 等续聊，D7 零外溢）", async () => {
    const lifecycle = makeLifecycle();
    const record = createRecord("sa-ff-2", {
      agent: "a",
      mode: "background",
      task: "t",
      slug: "a",
      startedAt: Date.now(),
    });

    const result = await lifecycle.finalizeFailed(record, new Error("x"));

    expect(result.success).toBe(false);
    expect(record.status).toBe("running"); // 走 markRoundIdle 分支（running 保持）
  });
});

// ── 4. 直写通道删除断言（验收 c 的机器守卫） ─────────────────

describe("直写通道删除断言（grep 等价的机器守卫）", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  function readService(name: string): string {
    return fs.readFileSync(path.join(here, "../service", name), "utf8");
  }

  it("run-orchestration.ts 无 workflow origin 直写对（tryTransition + finalizeRecord 内联）", () => {
    const source = readService("run-orchestration.ts");
    expect(source).not.toContain('tryTransition(record, "closed"');
    // settleOneShotOutcome 改调收口单点
    expect(source).toContain("settleWorkflowRecord(record, result, aborted ? \"cancelled\" : \"gc\"");
  });

  it("record-lifecycle.ts 无 workflow origin 直写对", () => {
    const source = readService("record-lifecycle.ts");
    expect(source).not.toContain('tryTransition(record, "closed"');
    expect(source).toContain("settleWorkflowRecord(record, failedResult");
    expect(source).toContain("settleWorkflowRecord(record, cancelledResult");
  });

  it("收口单点唯一性：tryTransition(record, \"closed\" 仅存在于 worker-message-pump（settle 域）", () => {
    const pump = fs.readFileSync(path.join(here, "../../orchestration/worker-message-pump.ts"), "utf8");
    expect(pump).toContain('tryTransition(record, "closed"');
  });
});
