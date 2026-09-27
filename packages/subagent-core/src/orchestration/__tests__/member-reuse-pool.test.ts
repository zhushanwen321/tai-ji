// src/orchestration/__tests__/member-reuse-pool.test.ts
//
// [U4 pi-workflow-run-resource-model] 成员会话 name 键复用通道单测（impl-plan u4
// 验收四条；fake engine，不拉真实进程）：
//   1. 同名第二次调用 = 同一 record（record id 不变 + ended→running 状态转移 +
//      resume 锚点续写原 session）；
//   2. 换名 = 新 record；双缺省 name = 不进复用（无名调用不塌缩共享身份）；
//   3. 登记/清空事件写入与 fold 重建等价（写入→fold→重建结果一致；写入序红线——
//      事件 append 失败不落内存；clear 先于 run-settled 帧）；
//   4. 外部 message 通道拒绝行为既有测试族（subagent-actions-core.test.ts）绿——
//      由验收命令单独跑既有文件，本文件不复制其断言（域边界 C-ext-28 的负向面）。
// 权威源：技术设计 §3.3 决策 4 / 7 / 9 / 10 + ADR-0079。
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
} from "../worker-message-pump.ts";
import {
  clearMemberReusePool,
  foldMemberReusePool,
  lookupMemberRecordId,
  registerMemberRecord,
  resetMemberReusePoolsForTest,
  type MemberReusePoolIo,
} from "../member-reuse-pool.ts";
import type { MemberPoolEvent, WorkflowRunEvent } from "../run-events.ts";

import { ModelConfigService } from "../../execution/assembly/model-config-service.ts";
import type { RecordStore } from "../../execution/persistence/record-store.ts";
import { SubagentService } from "../../execution/subagent-service.ts";
import type { ExecutionRecord } from "../../execution/assembly/types.ts";
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

/** 池模块生产 io 的测试等价装配（append 经 dispatchRunTrigger 单写者链；与
 *  workflow-dispatch / pump 的生产装配同款）。 */
function poolIo(): MemberReusePoolIo {
  return {
    appendEvent: (runId, event) => dispatchRunTrigger({ runId }, event),
    scanEvents: (runId) => scanRunEvents(runId),
  };
}

/** seed run-created 帧（生产 = lifecycle.runWorkflow 正点发射；service 直调路径需手动
 *  补——register 的 member-pool 转移在 dispatched/running 才合法，created × member-pool
 *  是表外 fail-fast，正是该纪律的构造性证明）。 */
async function seedRunCreated(runId: string): Promise<void> {
  await dispatchRunTrigger(
    { runId },
    { type: "run-created", runId, workflowName: "reuse-it", argsSummary: "{}", ts: Date.now() },
  );
}

function memberPoolEvents(events: readonly WorkflowRunEvent[]): MemberPoolEvent[] {
  return events.filter((e): e is MemberPoolEvent => e.type === "member-pool");
}

/** 微任务冲刷：dispatch 的 acquire/engine.run 链路是 await 链，flush 后 run 才进 fake。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function baseOpts(over: Partial<AgentCallOpts> = {}): AgentCallOpts {
  return { prompt: "调研 A", description: "research-a", ...over };
}

// ============================================================
// 1. 池机制：fold 重建等价 + 写入序红线（纯池 + journal 注入）
// ============================================================

describe("member-reuse-pool（决策 9：journal 承载 + fold 重建 + 写入序）", () => {
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

  it("登记/清空事件写入与 fold 重建等价（写入→fold→重建结果一致）", async () => {
    const io = poolIo();
    await seedRunCreated("wf-fold-1");
    await registerMemberRecord("wf-fold-1", "reviewer", "sa-1", io);
    await registerMemberRecord("wf-fold-1", "fixer", "sa-2", io);

    // 写入序：登记事件先落 journal（scan 即见 register 帧，seq 单写者分配）
    const events = await scanRunEvents("wf-fold-1");
    expect(events.map((e) => e.type)).toEqual(["run-created", "member-pool", "member-pool"]);
    expect(memberPoolEvents(events).map((e) => [e.seq, e.action, e.action === "register" ? e.name : "", e.action === "register" ? e.recordId : ""])).toEqual([
      [2, "register", "reviewer", "sa-1"],
      [3, "register", "fixer", "sa-2"],
    ]);

    // fold 等价：事件流重放 = 内存池内容
    expect([...foldMemberReusePool(events).entries()]).toEqual([["reviewer", "sa-1"], ["fixer", "sa-2"]]);
    await expect(lookupMemberRecordId("wf-fold-1", "reviewer", io)).resolves.toBe("sa-1");

    // 清空：事件先落、内存后清；fold 重放终帧 = 空池
    await expect(clearMemberReusePool("wf-fold-1", io)).resolves.toBe(true);
    const eventsAfter = await scanRunEvents("wf-fold-1");
    expect(eventsAfter.at(-1)).toMatchObject({ type: "member-pool", action: "clear" });
    expect([...foldMemberReusePool(eventsAfter).entries()]).toEqual([]);

    // 跨实例重建：reset 后首次访问 = journal fold 重建（clear 已落 → 未命中）
    resetMemberReusePoolsForTest();
    await expect(lookupMemberRecordId("wf-fold-1", "reviewer", io)).resolves.toBeUndefined();
  });

  it("fold 重建恢复：run 中断重发后按 journal 重建映射，未登记名按未命中", async () => {
    const io = poolIo();
    await seedRunCreated("wf-fold-2");
    await registerMemberRecord("wf-fold-2", "reviewer", "sa-1", io);

    resetMemberReusePoolsForTest(); // 模拟进程重启（内存池清零，journal 在盘）
    await expect(lookupMemberRecordId("wf-fold-2", "reviewer", io)).resolves.toBe("sa-1");
    // fold 后仍缺的名字 = 首派名，按未命中（undefined）由调用方新建
    await expect(lookupMemberRecordId("wf-fold-2", "newcomer", io)).resolves.toBeUndefined();
  });

  it("写入序红线：登记事件 append 失败时内存池不落项（不留无 journal 证据的孤项）", async () => {
    await seedRunCreated("wf-fold-3");
    const boom: MemberReusePoolIo = {
      appendEvent: () => Promise.reject(new Error("disk full")),
      scanEvents: (runId) => scanRunEvents(runId),
    };
    await expect(registerMemberRecord("wf-fold-3", "reviewer", "sa-1", boom)).rejects.toThrow("disk full");
    // 内存未写（事件未落 = 权威介质无证据）；io 恢复后重登成功
    await expect(lookupMemberRecordId("wf-fold-3", "reviewer", poolIo())).resolves.toBeUndefined();
    await registerMemberRecord("wf-fold-3", "reviewer", "sa-1", poolIo());
    await expect(lookupMemberRecordId("wf-fold-3", "reviewer", poolIo())).resolves.toBe("sa-1");
  });

  it("同名换绑 warn 留痕 + 后写覆盖（决策 9「行为不一致可追查」）；空池/未加载 run 的 clear 零事件", async () => {
    const io = poolIo();
    await seedRunCreated("wf-fold-4");
    await registerMemberRecord("wf-fold-4", "reviewer", "sa-1", io);
    await registerMemberRecord("wf-fold-4", "reviewer", "sa-9", io); // 并行同名派发形态
    const events = await scanRunEvents("wf-fold-4");
    expect(foldMemberReusePool(events).get("reviewer")).toBe("sa-9");
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("rebind"));

    // 未加载/空池 run：clear 不发事件、返回 false（memberless run 的 journal 保持零 member-pool 帧）
    await expect(clearMemberReusePool("wf-never-touched", io)).resolves.toBe(false);
    await expect(clearMemberReusePool("wf-fold-4", io)).resolves.toBe(true); // 首次清空有事件
    await expect(clearMemberReusePool("wf-fold-4", io)).resolves.toBe(false); // 已清，不再发
  });

  it("journal 扫描失败降级：warn 留痕按空池继续（派发主链不炸）", async () => {
    const failing: MemberReusePoolIo = {
      appendEvent: (runId, event) => dispatchRunTrigger({ runId }, event),
      scanEvents: () => Promise.reject(new Error("journal unreadable")),
    };
    await expect(lookupMemberRecordId("wf-fold-5", "reviewer", failing)).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("fold rebuild failed"));
  });
});

// ============================================================
// 2. finalizeRun 接线：clear 先于 run-settled 帧（terminal 后表外 fail-fast）
// ============================================================

describe("finalizeRun 池清空接线（设计 §5 三事同点）", () => {
  /** 构造真实 WorkflowRun（window-dispose-workflow.test 同款）。 */
  function makeRealRun(runId: string): WorkflowRun {
    const run = new WorkflowRun(
      runId,
      { scriptName: "reuse-it", scriptSource: "agent('hi')", args: {}, scriptPath: "/tmp/reuse-it.js" },
      {
        status: "running",
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

  it("有登记的 run：member-pool(clear) 帧先于 run-settled 落账，fold 终帧 = 空池", async () => {
    const dir = makeTmpDir("member-reuse-fin-");
    setRunEventJournalDirForTest(dir);
    try {
      await seedRunCreated("wf-fin-1");
      await registerMemberRecord("wf-fin-1", "reviewer", "sa-1", poolIo());

      await finalizeRun(makeRealRun("wf-fin-1"), makeDeps(), "completed", { context: "test" });

      const events = await scanRunEvents("wf-fin-1");
      expect(events.map((e) => e.type)).toEqual([
        "run-created",
        "member-pool",
        "member-pool",
        "run-settled",
      ]);
      // 清空先于终局帧（终局后 member-pool 是表外转移，进不了 journal）
      expect(events.at(-1)).toMatchObject({ type: "run-settled", outcome: "completed" });
      expect(events.at(-2)).toMatchObject({ type: "member-pool", action: "clear" });
      expect([...foldMemberReusePool(events).entries()]).toEqual([]);
    } finally {
      resetMemberReusePoolsForTest();
      setRunEventJournalDirForTest(undefined);
      rmTmp(dir);
    }
  });

  it("零成员 run：journal 无 member-pool 帧（空池不发 clear，journal 形态与 U4 前同型）", async () => {
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

  it("验收①：同名第二次调用 = 同一 record（id 不变 + ended→running 转移 + resume 锚点续写原 session）", async () => {
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
    // 登记事件随首轮派发落 journal（每 name 一次）
    await expect(scanRunEvents("run-A")).resolves.toContainEqual(
      expect.objectContaining({ type: "member-pool", action: "register", name: "research-a", recordId: record.id }),
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

    const names = memberPoolEvents(await scanRunEvents("run-A"))
      .filter((e) => e.action === "register")
      .map((e) => (e.action === "register" ? e.name : ""));
    expect(names).toEqual(["research-a", "research-b"]); // 无名调用零登记
  });

  it("同名仍在飞：第二次调用拒绝（run 内名唯一，zcode 对齐）；登记事件每 name 只发一次", async () => {
    const h = await harness();
    const r1 = h.service.executeWorkflowAgent(baseOpts(), "run-A");
    await flush();
    const run1 = h.fake.runs[0]!;

    // 第一轮在飞期间同名调用：池命中但 record running → fail-fast（防同 session 双写者）
    await expect(
      h.service.executeWorkflowAgent(baseOpts({ prompt: "并发同名" }), "run-A"),
    ).rejects.toThrow(/still running/);

    run1.settle({ content: "done-1" });
    await r1;
    const registers = memberPoolEvents(await scanRunEvents("run-A")).filter(
      (e) => e.action === "register",
    );
    expect(registers).toHaveLength(1); // 续聊 revive 复用同一映射，不发新事件
  });
});
