/**
 * [W2/V1 D1] settleRunAccounting 终局记录原语 + 终局记录注册表单测。
 *
 * 锁定语义：
 * 1. 原语两件一次齐全：journal run-settled 帧（经 dispatchRunTrigger 单写者队列）
 *    + manifest 物化——活体形态（spec 携带）经 dispatch 链 outputs 执行；冷路径
 *    （runId 键投递）由原语补写 manifest（workflowName 从 run-created 帧取）。
 * 2. 幂等两道：三面证据前置（adoptInterruptedRun 侧）+ 表内转移 fail-fast 让位
 *    （terminal × run-settled IllegalTransitionError）。
 * 3. 注册表：note 于 terminal 落账 → isRunSettled / settledRecordOf 可查询 →
 *    forgetSettledRecord 回收（与 runs Map 同生命周期）。
 * 4. 双帧 fold 停帧（[W2 D3 竞态防护] V1 单测锚）：同 run 两帧 run-settled 经
 *    foldRunEventFrames → onBrokenFrame 出声 + 保守停在先到帧的 terminal
 *    （terminal 吸收态无出边——后到帧是表外转移）。
 *
 * 测试红线：journal 目录 setRunEventJournalDirForTest 注入 mkdtemp（禁触真实
 * 数据目录）；runId 唯一化防模块级 liveRunStates/注册表跨用例污染。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRunEventJournal,
  foldRunEventFrames,
  type RunEventJournal,
  type WorkflowRunEvent,
} from "../run-events.ts";
import {
  forgetSettledRecord,
  isRunSettled,
  settleRunAccounting,
  settledRecordOf,
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import { Budget } from "../models/budget.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";

let dir: string;
let journal: RunEventJournal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "settle-accounting-"));
  setRunEventJournalDirForTest(dir);
  journal = createRunEventJournal(dir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.restoreAllMocks();
});

/** 引导：journal 首帧 + 活体态 seed（created → dispatched）。 */
async function seedCreated(runId: string): Promise<void> {
  await journal.append(runId, {
    type: "run-created",
    runId,
    workflowName: "sig-wf",
    argsSummary: "{}",
    ts: Date.now(),
  });
}

function makeRun(runId: string): WorkflowRun {
  return new WorkflowRun(
    runId,
    { scriptName: "sig-wf", scriptSource: "agent('x')", args: {}, scriptPath: "/tmp/x.js" },
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

describe("settleRunAccounting 原语（[W2/V1 D1] journal 帧 + manifest 两件单点）", () => {
  it("冷路径（runId 键投递）：帧 + manifest 两件落盘，帧载荷 = settlement 参数", async () => {
    await seedCreated("wf-sa-1");
    const settledAt = Date.now();

    await settleRunAccounting(
      { runId: "wf-sa-1" },
      { outcome: "failed", errorCode: "idle-evicted", reason: "idle run evicted after retention TTL", settledAt },
      { workflowName: "sig-wf" },
    );

    const events = await journal.scan("wf-sa-1");
    const settled = events.find((e) => e.type === "run-settled") as
      | Extract<WorkflowRunEvent, { type: "run-settled" }>
      | undefined;
    expect(settled).toBeDefined();
    expect(settled).toMatchObject({ outcome: "failed", errorCode: "idle-evicted" });
    expect(settled?.ts).toBe(settledAt);
    // manifest 补写（冷路径 spec 缺省 → 原语承接；原子写有 IO 窗——轮询落定）
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(dir, "wf-sa-1.json"))).toBe(true);
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "wf-sa-1.json"), "utf8")) as {
      outcome?: string;
      errorCode?: string;
      workflowName?: string;
    };
    expect(manifest).toMatchObject({ outcome: "failed", errorCode: "idle-evicted", workflowName: "sig-wf" });
  });

  it("注册表：terminal 落账即 note → isRunSettled / settledRecordOf 可查询 → forget 回收", async () => {
    await seedCreated("wf-sa-2");
    const run = makeRun("wf-sa-2");
    expect(isRunSettled(run)).toBe(false);

    await settleRunAccounting({ runId: "wf-sa-2" }, { outcome: "failed", settledAt: Date.now() });

    expect(isRunSettled(run)).toBe(true);
    expect(settledRecordOf("wf-sa-2")).toMatchObject({ outcome: "failed" });
    forgetSettledRecord("wf-sa-2");
    expect(isRunSettled(run)).toBe(false);
    expect(settledRecordOf("wf-sa-2")).toBeUndefined();
  });

  it("让位（幂等第二道）：已终局 run 再投终局触发 → IllegalTransitionError 上抛（调用方分类）", async () => {
    await seedCreated("wf-sa-3");
    await settleRunAccounting({ runId: "wf-sa-3" }, { outcome: "failed", settledAt: Date.now() });

    await expect(
      settleRunAccounting({ runId: "wf-sa-3" }, { outcome: "failed", settledAt: Date.now() }),
    ).rejects.toMatchObject({ name: "IllegalTransitionError" });
    // 单终局不变量：run-settled 恰一帧
    const events = await journal.scan("wf-sa-3");
    expect(events.filter((e) => e.type === "run-settled")).toHaveLength(1);
  });
});

describe("双帧 fold 停帧（[W2 D3 竞态防护] 单测锚——先到帧为准 + onBrokenFrame 出声）", () => {
  it("同 run 两帧 run-settled：fold 停在先到帧的 terminal，坏帧出声", () => {
    // 构造双帧事件流（两帧 run-settled——跨进程 TOCTOU 双写的 journal 形态）
    const dual = [
      { type: "run-created", runId: "wf-dual", workflowName: "sig-wf", argsSummary: "{}", ts: 1_000, seq: 1 },
      { type: "agent-started", taskIndex: 1, agentName: "a", attempt: 1, ts: 2_000, seq: 2 },
      { type: "run-settled", outcome: "interrupted", errorCode: "idle-evicted", artifactsDir: dir, ts: 3_000, seq: 3 },
      { type: "run-settled", outcome: "failed", artifactsDir: dir, ts: 4_000, seq: 4 },
    ] as unknown as readonly WorkflowRunEvent[];

    const broken: string[] = [];
    const state = foldRunEventFrames(dual, (_err, lastType) => {
      broken.push(lastType);
    });

    // 先到帧为准：terminal(interrupted)——吸收态无出边，后到帧是表外转移
    expect(state).toEqual({ lifecycle: "terminal", outcome: "interrupted" });
    // 出声：onBrokenFrame 恰一次（后到帧），可观测留证（warn 归消费方注入）
    expect(broken).toEqual(["run-settled"]);
  });
});
