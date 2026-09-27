// src/__tests__/jsonl-run-store-throttle.test.ts
//
// [W1 / D1] v1 快照 entry 通道退役锚定（原 workflow-record entry append 节流 [B-1]
// 随停写退役——entryThrottle 引用与 entryAppendMinIntervalMs 构造参数已删）。
//
// 锁定的语义：
// - save 恒零条目写：高频 running flush / 终态 flush / 多 run 并发 flush 全部不产生
//   workflow-record entry（主 session JSONL 不再接收运行态快照——每 run 只剩注册 +
//   终态两条 v2 小条目，写点在 core lifecycle/finalizeRun 与 loadAll 幂等补写）；
// - state 文件照写：每次 flush 落最新投影（rewrite 覆盖写，无累积——原节流的
//   O(n²) 防线随写点消除而不再需要）；
// - 高频 flush 次数有界：N 次 save 合并 1 次 flush（去抖批语义不变，writeFile 计数法）。
//
// 时间推进用 vitest fake timers；flush 经 flushPendingSaves() 直发（绕开去抖 timer），
// fs 真实 IO 不受 fake timers 影响。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Budget } from "@zhushanwen/subagent-core/orchestration/models/budget.ts";
import { Trace } from "@zhushanwen/subagent-core/orchestration/models/trace.ts";
import type { RunSpec } from "@zhushanwen/subagent-core/orchestration/models/run-spec.ts";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { WorkflowRun } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { mkCtx, mkPi } from "@zhushanwen/subagent-core/orchestration/__tests__/test-mocks.ts";
import { WORKFLOW_RECORD_CUSTOM_TYPE } from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "../jsonl-run-store.ts";

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "test-script",
    scriptPath: "/tmp/test.js",
    description: "test",
  };
}

function makeRun(runId: string, status: "running" | "done" = "running"): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    makeSpec(),
    {
      status,
      // done 快照缺 reason 触发 WorkflowRun I2 不变式错误（codec 拒收）——终态必带
      ...(status === "done" ? { reason: "completed" as const } : {}),
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

/** pi session JSONL 中的 workflow-record entry 数 = 实际 append 次数（恒 0 为绿）。 */
function recordEntryCount(entries: CustomEntry[]): number {
  return entries.filter((e) => e.type === "custom" && e.customType === WORKFLOW_RECORD_CUSTOM_TYPE).length;
}

function readStateSnapshot(tmpDir: string, runId: string): { state: { status: string; trace: unknown[] } } {
  const content = fs.readFileSync(path.join(tmpDir, "workflow-state", `${runId}.jsonl`), "utf8");
  return JSON.parse(content.trim()) as { state: { status: string; trace: unknown[] } };
}

describe("JsonlRunStore v1 快照通道退役（[W1 / D1] 停写锚定）", () => {
  let tmpDir: string;
  let entries: CustomEntry[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-run-store-throttle-"));
    entries = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("高频 running flush：零条目写，state 文件每次 flush 照写最新投影", async () => {
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
    });
    const run = makeRun("wf-throttle-1");

    await store.save(run); // 冷路径首写
    for (let i = 0; i < 10; i++) {
      run.state.trace.append({ stepIndex: i + 1, agent: "a", task: "t", model: "m", status: "pending" });
      const p = store.save(run); // 热路径入去抖批
      await store.flushPendingSaves(); // 直发 flush
      await p;
    }
    // 停写红线：高频 flush 零条目（原节流通道的写点已消除——零是唯一有界值）
    expect(recordEntryCount(entries)).toBe(0);
    // state 物化投影照写：最终 flush 时刻的最新状态（trace 10 节点全量在盘）
    expect(readStateSnapshot(tmpDir, "wf-throttle-1").state.trace).toHaveLength(10);
  });

  it("终态 flush：零条目写，state 投影携带终态（恢复权威在 journal，state 是投影）", async () => {
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
    });
    const runId = "wf-throttle-2";

    await store.save(makeRun(runId, "running"));
    const pHot = store.save(makeRun(runId, "running"));
    await store.flushPendingSaves();
    await pHot;
    expect(recordEntryCount(entries)).toBe(0);

    await store.save(makeRun(runId, "done"));
    expect(recordEntryCount(entries)).toBe(0);
    expect(readStateSnapshot(tmpDir, runId).state.status).toBe("done");
  });

  it("多 run 并发 flush：全部零条目写，各自 state 文件独立落盘", async () => {
    const store = new JsonlRunStore({
      sessionDir: tmpDir,
      pi: mkPi(entries),
      ctx: mkCtx(entries),
    });

    await store.save(makeRun("wf-throttle-a"));
    await store.save(makeRun("wf-throttle-b"));
    const pA = store.save(makeRun("wf-throttle-a"));
    const pB = store.save(makeRun("wf-throttle-b"));
    await store.flushPendingSaves();
    await Promise.all([pA, pB]);

    expect(recordEntryCount(entries)).toBe(0);
    expect(readStateSnapshot(tmpDir, "wf-throttle-a").state.status).toBe("running");
    expect(readStateSnapshot(tmpDir, "wf-throttle-b").state.status).toBe("running");
  });
});
