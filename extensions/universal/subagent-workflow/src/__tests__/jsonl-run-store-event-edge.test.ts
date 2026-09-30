// src/__tests__/jsonl-run-store-event-edge.test.ts
//
// [D1] record 单源存储收敛后壳 store 的事件边沿物化面退役锚。
//
// 旧形态（[P3/D6] + [W1] 停写锚定）的「journal 事件边沿（fs.watch）→ 防抖合并 →
// state 快照物化」整链随快照删除而退役：store 无 watcher、无防抖 timer、无 pending
// 批——run 状态对宿主的可见性 = record 流直读（runtime tailer 侧消费，壳侧无物化面）。
//
// 本文件锁定退役后的写面纪律：
// 1. **append-only 唯一写面**：record 流只被 core journal 单写者链追加——store
//    全生命周期（save 多次 / dispose / disposed 后迟到 save）对 record 流零字节
//    改写（内容逐字节不变）；
// 2. **save = 显式 no-op**：零文件产生、恒 resolve（disposed 前后行为一致）；
// 3. **dispose / flushPendingSaves 幂等 resolve**（生命周期面契约保持）；
// 4. **不建目录**：store 不再有任何 mkdir/writeFile 动作（旧 doFlush 的目录惰性
//    自建随物化面删除）。
//
// fs：mkdtemp 自建自删（rmSync 带 recursive/force/maxRetries/retryDelay 红线形态）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Budget } from "@zhushanwen/subagent-core/orchestration/models/budget.ts";
import { Trace } from "@zhushanwen/subagent-core/orchestration/models/trace.ts";
import type { RunSpec } from "@zhushanwen/subagent-core/orchestration/models/run-spec.ts";
import { WorkflowRun } from "@zhushanwen/subagent-core/orchestration/models/workflow-run.ts";
import { RUN_EVENTS_SUFFIX } from "@zhushanwen/subagent-core";
import { JsonlRunStore } from "../jsonl-run-store.ts";

function makeSpec(): RunSpec {
  return {
    scriptSource: "module.exports = async () => {};",
    args: {},
    scriptName: "edge-wf",
    scriptPath: "/tmp/x.js",
    description: "test",
  };
}

function makeRun(runId: string): WorkflowRun {
  return WorkflowRun.reconstruct(
    runId,
    makeSpec(),
    {
      status: "running",
      budget: new Budget(),
      calls: new Map(),
      trace: new Trace(),
      errorLogs: [],
    },
    { startedAt: new Date().toISOString() },
  );
}

function recordPath(runId: string): string {
  return path.join(tmpDir, "workflow-state", `${runId}${RUN_EVENTS_SUFFIX}`);
}

/** 预置 record 流（core journal 单写者链的产物形态），返回写入时快照内容。 */
function seedRecord(runId: string): string {
  fs.mkdirSync(path.dirname(recordPath(runId)), { recursive: true });
  const content = [
    JSON.stringify({ type: "run-created", seq: 1, ts: Date.now(), runId, workflowName: "edge-wf", argsSummary: "{}" }),
    JSON.stringify({ type: "agent-started", seq: 2, ts: Date.now(), taskIndex: 0, agentName: "coder", attempt: 1 }),
  ].join("\n") + "\n";
  fs.writeFileSync(recordPath(runId), content, "utf8");
  return content;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-event-edge-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.restoreAllMocks();
});

describe("壳 store 写面退役（[D1] record 单源——append-only 唯一写面）", () => {
  it("save 零写面：多次 save 不产生文件、不建目录、恒 resolve", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    const run = makeRun("wf-edge-nowrite");

    await store.save(run);
    await store.save(run);
    await store.save(makeRun("wf-edge-nowrite-2"));

    expect(fs.existsSync(path.join(tmpDir, "workflow-state"))).toBe(false);
    await store.dispose();
  });

  it("record 流对 store 生命周期零改写：save/dispose 前后逐字节不变（append-only 唯一写面锚）", async () => {
    const runId = "wf-edge-appendonly";
    const seeded = seedRecord(runId);
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    await store.save(makeRun(runId));
    await store.flushPendingSaves();
    await store.dispose();
    // dispose 后迟到 save（R5 语义收敛为同一 no-op 通道）
    await store.save(makeRun(runId));

    expect(fs.readFileSync(recordPath(runId), "utf8")).toBe(seeded);
  });

  it("append-only 正向锚：core journal 追加后 store 只读消费（settledRecordOf），流仍只增不改", async () => {
    const runId = "wf-edge-monotonic";
    const seeded = seedRecord(runId);
    const store = new JsonlRunStore({ sessionDir: tmpDir });

    // store 读路径（settledRecordOf——与 loadAll 同一读原语）消费后流不变
    expect(store.settledRecordOf(runId)).toBeUndefined();
    expect(fs.readFileSync(recordPath(runId), "utf8")).toBe(seeded);

    // 单写者追加（core journal 实装形态）→ store 再读见到新事实，流仍只增不改
    fs.appendFileSync(recordPath(runId), `${JSON.stringify({ type: "run-settled", seq: 3, ts: Date.now(), outcome: "done", artifactsDir: tmpDir })}\n`, "utf8");
    const lines = fs.readFileSync(recordPath(runId), "utf8").split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    expect(store.settledRecordOf(runId)?.outcome).toBe("done");
    await store.dispose();
  });

  it("dispose / flushPendingSaves 幂等 resolve；disposed 后 save 仍 resolve（no-op 单通道）", async () => {
    const store = new JsonlRunStore({ sessionDir: tmpDir });
    await store.flushPendingSaves();
    const d1 = store.dispose();
    const d2 = store.dispose();
    expect(d1).toBe(d2); // 同一 Promise（幂等契约保持）
    await d1;
    await store.flushPendingSaves();
    await store.save(makeRun("wf-edge-after-dispose"));
    expect(fs.existsSync(path.join(tmpDir, "workflow-state"))).toBe(false);
  });
});
