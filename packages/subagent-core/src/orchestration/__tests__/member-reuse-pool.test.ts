// src/orchestration/__tests__/member-reuse-pool.test.ts
//
// [U4 pi-workflow-run-resource-model → D6 绑定消解]（workflow-run-resume-revision）
// 成员会话 name 键复用通道单测（fake engine，不拉真实进程）：
//   1. 同名第二次调用 = 同一 record（record id 不变 + ended→running 状态转移 +
//      resume 锚点续写原 session）；
//   2. 换名 = 新 record；双缺省 name = 不进复用（无名调用不塌缩共享身份）；
//   3. [D6] 绑定字段化承载：绑定真相 = agent-started 载荷的 memberRecordId 字段
//      （随帧落 record），fold 重建从帧恢复（首派建绑、重复携带不换绑）；无独立
//      member-pool 词表事件（[D6] 删除——登记收尾零 IO、收尾清空只释放内存，
//      恢复语义由「终局后无后续 agent-started 帧」构造性承接）；
//   4. 外部 message 通道拒绝行为既有测试族（subagent-actions-core.test.ts）绿——
//      由验收命令单独跑既有文件，本文件不复制其断言（域边界 C-ext-28 的负向面）。
// 权威源：workflow-run-resume-revision 设计 D6 + ADR-0079（机制前身）。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { Budget } from "../models/budget.ts";
import { RunRuntime } from "../models/run-runtime.ts";
import { Trace } from "../models/trace.ts";
import { WorkflowRun } from "../models/workflow-run.ts";
import type { AgentCallOpts, AgentResult } from "../models/types.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";
import {
  dispatchRunTrigger,
  finalizeRun,
  scanRunEvents,
  setRunEventJournalDirForTest,
} from "../terminal-actions.ts";
import {
  clearMemberReusePool,
  foldMemberBindings,
  lookupMemberRecordId,
  peekMemberRecordId,
  registerMemberRecord,
  resetMemberReusePoolsForTest,
  type MemberReusePoolIo,
} from "../../execution/service/member-reuse-pool.ts";
import type { WorkflowRunEvent } from "../run-events.ts";

import { ModelConfigService } from "../../execution/assembly/model-config-service.ts";
import type { RecordStore } from "../../execution/persistence/record-store.ts";
import { SubagentService } from "../../execution/subagent-service.ts";
import type { ExecutionRecord } from "../../execution/domain/record-model.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "../../execution/__tests__/helpers/fake-engine-port.ts";
import { CTX_MODEL as ctxModel, emptyRegistry } from "../../execution/__tests__/helpers/model-registry-mock.ts";
import { makePi } from "../../execution/__tests__/helpers/pi-mock.ts";

// ── 工具 ─────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

/** 绑定模块生产 io 的测试等价装配（scan 经 terminal-actions 的 scanRunEvents 单源
 *  防线；与 workflow-dispatch 的生产装配同款——[D6] 后无 append 通道）。 */
function poolIo(): MemberReusePoolIo {
  return {
    scanEvents: (runId) => scanRunEvents(runId),
  };
}

/** seed run-created 帧（生产 = lifecycle.runWorkflow 正点发射；service 直调路径需手动
 *  补——后续转移在 running 才合法，created × agent-started 是表外 fail-fast，正是该
 *  纪律的构造性证明）。 */
async function seedRunCreated(runId: string): Promise<void> {
  await dispatchRunTrigger(
    { runId },
    { type: "run-created", runId, workflowName: "reuse-it", argsSummary: "{}", ts: Date.now() },
  );
}

/** seed agent-started 帧（[D6] 绑定字段的落账面——生产 = pump dispatchAgentCall 链；
 *  memberRecordId 续写帧携带、首派缺省）。 */
async function seedAgentStarted(runId: string, taskIndex: number, agentName: string, memberRecordId?: string): Promise<void> {
  await dispatchRunTrigger(
    { runId },
    {
      type: "agent-started",
      taskIndex,
      agentName,
      attempt: 1,
      ...(memberRecordId !== undefined ? { memberRecordId } : {}),
      ts: Date.now(),
    },
  );
}

/** record 流内 agent-started 帧的绑定投影（(agentName, memberRecordId) 对；首派帧 memberRecordId undefined）。 */
function startedBindings(events: readonly WorkflowRunEvent[]): Array<[string, string | undefined]> {
  return events
    .filter((e): e is Extract<WorkflowRunEvent, { type: "agent-started" }> => e.type === "agent-started")
    .map((e) => [e.agentName, e.memberRecordId] as [string, string | undefined]);
}

/** 微任务冲刷：dispatch 的 acquire/engine.run 链路是 await 链，flush 后 run 才进 fake。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function baseOpts(over: Partial<AgentCallOpts> = {}): AgentCallOpts {
  return { prompt: "调研 A", description: "research-a", ...over };
}

// ============================================================
// 1. 绑定机制：fold 重建等价 + [D6] 无事件承载（纯池 + record 读注入）
// ============================================================

describe("member-reuse-pool（[D6]：agent-started.memberRecordId 承载 + fold 重建）", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir("member-reuse-pool-");
    setRunEventJournalDirForTest(dir);
  });

  afterEach(() => {
    resetMemberReusePoolsForTest();
    setRunEventJournalDirForTest(undefined);
    rmTmp(dir);
  });

  it("[D6] 绑定随 agent-started 帧落账（续写帧携带 memberRecordId、首派缺省）；fold 等价（首派建绑、重复携带不换绑）", async () => {
    const io = poolIo();
    await seedRunCreated("wf-fold-1");
    // 首派：绑定未登记（缓存 miss）→ agent-started 帧缺省
    await seedAgentStarted("wf-fold-1", 0, "reviewer");
    // 续写：绑定已登记（registerMemberRecord 后）→ agent-started 帧携带
    await registerMemberRecord("wf-fold-1", "reviewer", "sa-1", io);
    await seedAgentStarted("wf-fold-1", 1, "reviewer", "sa-1");
    await registerMemberRecord("wf-fold-1", "fixer", "sa-2", io);
    await seedAgentStarted("wf-fold-1", 2, "fixer", "sa-2");

    // record 流形态：零 member-pool 帧（[D6] 词表成员已删），绑定字段随 agent-started 帧在场
    const events = await scanRunEvents("wf-fold-1");
    expect(events.some((e) => (e.type as string) === "member-pool")).toBe(false);
    expect(startedBindings(events)).toEqual([
      ["reviewer", undefined], // 首派（建绑前）
      ["reviewer", "sa-1"], // 续写帧携带
      ["fixer", "sa-2"],
    ]);

    // fold 等价：事件流重放 = 内存表内容（首派建绑——首个携带 recordId 的帧生效）
    expect([...foldMemberBindings(events).entries()]).toEqual([["reviewer", "sa-1"], ["fixer", "sa-2"]]);
    await expect(lookupMemberRecordId("wf-fold-1", "reviewer", io)).resolves.toBe("sa-1");
  });

  it("fold 重建恢复：run 中断重发后按 record 重建绑定，未登记名按未命中", async () => {
    const io = poolIo();
    await seedRunCreated("wf-fold-2");
    await seedAgentStarted("wf-fold-2", 0, "reviewer", "sa-1");

    resetMemberReusePoolsForTest(); // 模拟进程重启（内存表清零，record 在盘）
    await expect(lookupMemberRecordId("wf-fold-2", "reviewer", io)).resolves.toBe("sa-1");
    // fold 后仍缺的名字 = 首派名，按未命中（undefined）由调用方新建
    await expect(lookupMemberRecordId("wf-fold-2", "newcomer", io)).resolves.toBeUndefined();
  });

  it("[D6] 登记收尾零 IO（无 append 通道——绑定与 agent-started 帧一体，无「事件落了内存没改」窄窗）；peek 同步读活体缓存", async () => {
    await seedRunCreated("wf-fold-3");
    const io = poolIo();
    // 未加载前 peek = undefined（不触发 fold 重建——派发主链不等待 async）
    expect(peekMemberRecordId("wf-fold-3", "reviewer", io)).toBeUndefined();
    await registerMemberRecord("wf-fold-3", "reviewer", "sa-1", io);
    expect(peekMemberRecordId("wf-fold-3", "reviewer", io)).toBe("sa-1");
    // record 流仍只有 run-created 帧（登记零事件）
    await expect(scanRunEvents("wf-fold-3")).resolves.toHaveLength(1);
  });

  it("同名换绑 warn 留痕 + 后写覆盖（「行为不一致可追查」）；clear 恒 false 且 record 流零事件（终局后无后续 agent-started 帧构造性承接恢复语义）", async () => {
    const io = poolIo();
    await seedRunCreated("wf-fold-4");
    await seedAgentStarted("wf-fold-4", 0, "reviewer", "sa-1");
    await registerMemberRecord("wf-fold-4", "reviewer", "sa-1", io);
    await registerMemberRecord("wf-fold-4", "reviewer", "sa-9", io); // 并行同名派发形态
    const events = await scanRunEvents("wf-fold-4");
    expect(foldMemberBindings(events).get("reviewer")).toBe("sa-1"); // 首派建绑——fold 不随内存换绑
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("rebind"));

    // clear 只释放内存（无 clear 事件可发），恒返回 false（诊断面形状保留）
    await expect(clearMemberReusePool("wf-never-touched", io)).resolves.toBe(false);
    await expect(clearMemberReusePool("wf-fold-4", io)).resolves.toBe(false);
    expect(peekMemberRecordId("wf-fold-4", "reviewer", io)).toBeUndefined();
  });

  it("record 扫描失败降级：warn 留痕按空表继续（派发主链不炸）", async () => {
    const failing: MemberReusePoolIo = {
      scanEvents: () => Promise.reject(new Error("record unreadable")),
    };
    await expect(lookupMemberRecordId("wf-fold-5", "reviewer", failing)).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("fold rebuild failed"));
  });
});

// ============================================================
// 2. finalizeRun 接线：绑定清空只释放内存（record 流零 member-pool 帧）
// ============================================================

describe("finalizeRun 绑定清空接线（[D6]：内存释放、零事件）", () => {
  /** 构造真实 WorkflowRun（window-dispose-workflow.test 同款）。 */
  function makeRealRun(runId: string): WorkflowRun {
    const run = new WorkflowRun(
      runId,
      { scriptName: "reuse-it", scriptSource: "agent('hi')", args: {}, scriptPath: "/tmp/reuse-it.js" },
      {
        budget: new Budget(),
        calls: new Map(),
        trace: new Trace(),
        errorLogs: [],
      },
      { startedAt: new Date().toISOString() },
    );
    const worker = {
      postMessage: vi.fn(),
      terminate: vi.fn(async () => {}),
    } as unknown as WorkerHandle;
    run.assignRuntime(new RunRuntime(worker, new AbortController()));
    return run;
  }

  function makeDeps(): LifecycleDeps {
    return {
      store: { save: vi.fn(async () => {}) },
      workerHost: { start: vi.fn(() => ({ postMessage: vi.fn() })) },
      runner: { run: vi.fn(async () => ({}) as AgentResult) },
      runs: new Map(),
      appendEntry: vi.fn(),
      eventBus: { emit: vi.fn() },
      onRunDone: vi.fn(),
      log: vi.fn(),
    } as unknown as LifecycleDeps;
  }

  it("有绑定的 run：终局后 record 流零 member-pool 帧（[D6] 无 clear 事件），终局帧照常落账", async () => {
    const dir = makeTmpDir("member-reuse-fin-");
    setRunEventJournalDirForTest(dir);
    try {
      await seedRunCreated("wf-fin-1");
      await seedAgentStarted("wf-fin-1", 0, "reviewer", "sa-1");
      await registerMemberRecord("wf-fin-1", "reviewer", "sa-1", poolIo());

      await finalizeRun(makeRealRun("wf-fin-1"), makeDeps(), "completed", { context: "test" });

      const events = await scanRunEvents("wf-fin-1");
      expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "done" });
      expect(events.some((e) => (e.type as string) === "member-pool")).toBe(false);
      // 内存绑定已释放（finalizeRun 清空接线）
      expect(peekMemberRecordId("wf-fin-1", "reviewer", poolIo())).toBeUndefined();
      // fold 重建语义等价：终局后无后续 agent-started 帧 → 重建结果与清空后一致
      //（新进程重启后 pool 按帧 fold 重建出 sa-1，但 run 已终局无续写派发，无行为差异）
    } finally {
      resetMemberReusePoolsForTest();
      setRunEventJournalDirForTest(undefined);
      rmTmp(dir);
    }
  });

  it("零成员 run：终局 record 流形态与绑定机制无涉（run-created → run-settled 两帧）", async () => {
    const dir = makeTmpDir("member-reuse-fin-");
    setRunEventJournalDirForTest(dir);
    try {
      await seedRunCreated("wf-fin-2");
      await finalizeRun(makeRealRun("wf-fin-2"), makeDeps(), "completed", { context: "test" });
      const events = await scanRunEvents("wf-fin-2");
      expect(events.map((e) => e.type)).toEqual(["run-created", "run-settled"]);
    } finally {
      resetMemberReusePoolsForTest();
      setRunEventJournalDirForTest(undefined);
      rmTmp(dir);
    }
  });
});

// ============================================================
// 3. 入口分岔（决策 10）：同名续写 = 同一 record；换名 = 新 record
// ============================================================

describe("executeWorkflowAgent 成员复用分岔（决策 10：record 创建前）", () => {
  type Harness = {
    service: SubagentService;
    store: RecordStore;
    fake: FakePiEnginePort;
    tmpRoot: string;
  };

  let open: Harness | undefined;

  function makeHarness(): Harness {
    const tmpRoot = makeTmpDir("member-reuse-it-");
    setRunEventJournalDirForTest(path.join(tmpRoot, "workflow-state"));
    process.env.TAIJI_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
    const agentDir = path.join(tmpRoot, "agent");
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    modelService.initModel({
      modelRegistry: emptyRegistry(),
      sessionId: "member-reuse-it",
      ctxModel,
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    const pi = makePi();
    service.initSession({ pi, sessionId: "member-reuse-it" });
    const fake = registerFakePiEngine();
    const store = Reflect.get(service, "store") as RecordStore;
    return { service, store, fake, tmpRoot };
  }

  async function harness(): Promise<Harness> {
    open = makeHarness();
    await seedRunCreated("run-A");
    return open;
  }

  function runningRecord(store: RecordStore): ExecutionRecord {
    const running = store.listRunning();
    expect(running).toHaveLength(1);
    return store.getMutable(running[0]!.id)!;
  }

  afterEach(() => {
    if (open) {
      open.service.dispose();
      rmTmp(open.tmpRoot);
      open = undefined;
    }
    resetMemberReusePoolsForTest();
    setRunEventJournalDirForTest(undefined);
    delete process.env.TAIJI_AGENT_DATA_DIR;
    vi.restoreAllMocks();
  });

  it("验收①：同名第二次调用 = 同一 record（id 不变 + ended→running 转移 + resume 锚点续写原 session；[D6] 零登记事件）", async () => {
    const h = await harness();
    const sessionFile = path.join(h.tmpRoot, "member.jsonl");

    // 第一轮：新建成员并跑完（D7 收口 = 立即终态化，record 归档出内存）
    const r1 = h.service.executeWorkflowAgent(baseOpts(), "run-A");
    await flush();
    const run1 = h.fake.runs[0]!;
    const record = runningRecord(h.store);
    expect(record.origin).toBe("workflow");
    expect(record.parentRunId).toBe("run-A");
    run1.settle({ content: "done-1", sessionFile });
    await r1;
    expect(h.store.listRunning()).toHaveLength(0); // 已结束（archive 出内存）
    // [D6] 登记零事件：record 流无 member-pool 帧（绑定随 agent-started 帧承载，
    // 本直调链无 pump agent-call 消息——内存绑定表为消费面）
    await expect(scanRunEvents("run-A")).resolves.toSatisfy(
      (events: WorkflowRunEvent[]) => events.every((e) => (e.type as string) !== "member-pool"),
    );

    // 第二轮同名：不建新 record，revive 拉起回 running + resume 锚点
    const r2 = h.service.executeWorkflowAgent(baseOpts({ prompt: "调研 A 续" }), "run-A");
    await flush();
    const run2 = h.fake.runs[1]!;
    expect(run2).not.toBe(run1); // 新 run（每轮 = 新 run + resume 锚点）
    expect(run2.ctx.taskId).toBe(record.id); // 同一子代理身份（record id 不变）
    expect(run2.ctx.resume).toEqual({
      recordId: record.id,
      resume: { sessionRef: { recordId: record.id, sessionFile } }, // pi 锚：续写原 session 文件
    });
    const revived = h.store.getMutable(record.id);
    expect(revived).toBeDefined(); // revive 后重新在册（冷重建链）
    expect(revived!.status).toBe("running"); // ended → running 状态转移
    expect(revived!.closedReason).toBeUndefined(); // 旧终态遗留位清除
    run2.settle({ content: "done-2", sessionFile });
    await r2;
    expect(h.store.listRunning()).toHaveLength(0); // 完成后再次结束
  });

  it("验收②：换名 = 新 record；双缺省 name 不进复用（无名调用零登记）", async () => {
    const h = await harness();

    // 换名：research-a 跑完后 research-b = 新 record、无锚（现状路径 resume 键不上 wire）
    const r1 = h.service.executeWorkflowAgent(baseOpts(), "run-A");
    await flush();
    const run1 = h.fake.runs[0]!;
    const recordA = runningRecord(h.store);
    run1.settle({ content: "done-1" });
    await r1;

    const r2 = h.service.executeWorkflowAgent(baseOpts({ description: "research-b" }), "run-A");
    await flush();
    const run2 = h.fake.runs[1]!;
    const recordB = runningRecord(h.store);
    expect(recordB.id).not.toBe(recordA.id); // 换名 = 新子代理
    expect(run2.ctx.resume).toBeUndefined();
    run2.settle({ content: "done-2" });
    await r2;

    // 双缺省 name：无身份键，两次调用各建成员
    const r3 = h.service.executeWorkflowAgent({ prompt: "p3" }, "run-A");
    await flush();
    const run3 = h.fake.runs[2]!;
    const recordC = runningRecord(h.store);
    run3.settle({ content: "done-3" });
    await r3;

    const r4 = h.service.executeWorkflowAgent({ prompt: "p4" }, "run-A");
    await flush();
    const run4 = h.fake.runs[3]!;
    const recordD = runningRecord(h.store);
    expect(recordD.id).not.toBe(recordC.id);
    run4.settle({ content: "done-4" });
    await r4;

    // [D6] 绑定表内面断言（原 member-pool register 帧断言的机制等价面）：有名调用
    // 各自登记、无名调用零登记
    const io = poolIo();
    await expect(lookupMemberRecordId("run-A", "research-a", io)).resolves.toBe(recordA.id);
    await expect(lookupMemberRecordId("run-A", "research-b", io)).resolves.toBe(recordB.id);
  });

  it("同名仍在飞：第二次调用拒绝（run 内名唯一，zcode 对齐）；[D6] 登记零事件（绑定表内面核验）", async () => {
    const h = await harness();
    const r1 = h.service.executeWorkflowAgent(baseOpts(), "run-A");
    await flush();
    const run1 = h.fake.runs[0]!;

    // 第一轮在飞期间同名调用：绑定命中但 record running → fail-fast（防同 session 双写者）
    await expect(
      h.service.executeWorkflowAgent(baseOpts({ prompt: "并发同名" }), "run-A"),
    ).rejects.toThrow(/still running/);

    run1.settle({ content: "done-1" });
    await r1;
    // [D6] 零事件断言（原「register 帧每 name 一次」的机制等价面）：record 流无
    // member-pool 帧；续聊 revive 复用同一绑定（内存表内容不变）
    const events = await scanRunEvents("run-A");
    expect(events.some((e) => (e.type as string) === "member-pool")).toBe(false);
    await expect(lookupMemberRecordId("run-A", "research-a", poolIo())).resolves.toBeDefined();
  });
});
