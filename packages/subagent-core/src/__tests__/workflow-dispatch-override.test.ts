// src/__tests__/workflow-dispatch-override.test.ts
//
// [subagent-model-switch U4b] workflow 派发链的覆盖消费（§7.4 派发侧覆写 + P9 窗口
// 封住 + §6.6 复活重新盖章 + U4a journal 覆盖事件的派发侧重建消费）：
//   - 派发侧覆写：覆盖在场 → identity 解析前覆写调用参数 model（显式指定也被覆盖
//     ——用户覆盖赢，§2 目标 3 / §6.6 决策六②）；派发身份与任务书模型 = 覆盖值；
//   - taskSpec 组装点二次咨询：模拟「身份解析后、taskSpec 组装前」的覆盖更新时序
//     （池排队窗口）——窗口内切换不漏切该调用（前提 P9），盖章与启动单点一致；
//   - 复活重新盖章：revive 成员 record.model = 覆盖值解析产物、spawn argv = 覆盖值
//     （不变量 1 的复活例外；§6.6 复活接线）；
//   - 回归：无覆盖时派发行为与现状一致（ctxModel 兜底 / record.model = 解析词形）；
//     非复活路径既有盖章行为不变；
//   - U4a 事件管线闭合：journal 覆盖事件（model-override 帧）→ miss 重建
//     （rebuildRunOverride 折叠 + 回填）→ 派发吃覆盖——真实调用链上的读面闭合。
//
// 替身形态：pi EnginePort = registerFakePiEngine（协议 seam 替身，FakeRun 捕获
// task/ctx）；journal 经 setRunEventJournalDirForTest 注入 tmpdir（测试红线：不触
// 真实数据目录）。harness 范式对齐 execution/__tests__/workflow-agent-dispatch.test.ts。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { ModelConfigService } from "../execution/assembly/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../execution/assembly/model-resolver.ts";
import { createRecord, trySettleLegacyClosed } from "../execution/persistence/execution-record.ts";
import type { RecordStore } from "../execution/persistence/record-store.ts";
import type { ExecutionRecord, ModelOverride } from "../execution/domain/record-model.ts";
import { SubagentService } from "../execution/subagent-service.ts";
import { clearEngines } from "../execution/engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort, type FakeRun } from "../execution/__tests__/helpers/fake-engine-port.ts";
import { CTX_MODEL } from "../execution/__tests__/helpers/model-registry-mock.ts";
import { makePi, type PiMock } from "../execution/__tests__/helpers/pi-mock.ts";
import { dispatchRunTrigger, setRunEventJournalDirForTest } from "../orchestration/terminal-actions.ts";
import { createRunEventJournal } from "../orchestration/run-events.ts";
import type { AgentCallOpts } from "../orchestration/models/types.ts";
import type { SubagentRecordEntryV2 } from "../execution/persistence/record-entry.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../execution/persistence/record-entry.ts";

// ============================================================
// helpers
// ============================================================

/** 覆盖目标模型（registry 注册，canonical ref "zai-coding/flash"）；reasoning 开启
 *  使缺省档位推导有值（"xhigh"），重盖章 thinkingLevel 断言有力。 */
const OVERRIDE_MODEL: ModelInfo = {
  id: "flash",
  name: "Flash",
  provider: "zai-coding",
  reasoning: true,
};
const OVERRIDE_REF = "zai-coding/flash";

function makeRegistry(models: ModelInfo[]): ModelRegistryLike {
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: () => true,
  };
}

interface OverrideHarness { // oe-exempt:20261006:test:测试专用装配 harness 单实现为常态
  service: SubagentService;
  store: RecordStore;
  modelService: ModelConfigService;
  pi: PiMock;
  fake: FakePiEnginePort;
  entries: SubagentRecordEntryV2[];
  tmpRoot: string;
  journalDir: string;
}

const openHarnesses: OverrideHarness[] = [];

function makeHarness(): OverrideHarness {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dispatch-override-"));
  process.env.TAIJI_AGENT_DATA_DIR = path.join(tmpRoot, "engine-data");
  const journalDir = path.join(tmpRoot, "run-events");
  setRunEventJournalDirForTest(journalDir);
  const agentDir = path.join(tmpRoot, "agent");
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: makeRegistry([CTX_MODEL, OVERRIDE_MODEL]),
    sessionId: "wf-override-it",
    ctxModel: CTX_MODEL,
  });
  const service = new SubagentService({ cwd: agentDir, modelService });
  const pi = makePi();
  const entries: SubagentRecordEntryV2[] = [];
  pi.appendEntry.mockImplementation((customType: string, data: unknown) => {
    if (customType === SUBAGENT_RECORD_CUSTOM_TYPE) entries.push(data as SubagentRecordEntryV2);
  });
  service.initSession({ pi, sessionId: "wf-override-it" });
  const fake = registerFakePiEngine();
  const harness: OverrideHarness = {
    service,
    store: Reflect.get(service, "store") as RecordStore,
    modelService,
    pi,
    fake,
    entries,
    tmpRoot,
    journalDir,
  };
  openHarnesses.push(harness);
  return harness;
}

function overrideOf(setAt = Date.now()): ModelOverride {
  return { ref: { provider: OVERRIDE_MODEL.provider, modelId: OVERRIDE_MODEL.id }, setAt };
}

function baseOpts(over: Partial<AgentCallOpts> = {}): AgentCallOpts {
  return { prompt: "调研 A", description: "research-a", ...over };
}

/** 微任务冲刷：dispatch 的 acquire/engine.run 链路是 await 链，flush 后 run 才进 fake。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function soleRun(fake: FakePiEnginePort): FakeRun {
  expect(fake.runs).toHaveLength(1);
  return fake.runs[0]!;
}

function runningRecord(store: RecordStore): ExecutionRecord {
  const running = store.listRunning();
  expect(running.length).toBeGreaterThanOrEqual(1);
  return store.getMutable(running[0]!.id)!;
}

/** seed run-created + agent-started(memberRecordId) 绑定帧（member-reuse-pool.test.ts
 *  同款形态——生产写点 = pump dispatchAgentCall 链，测试直构造绑定）。 */
async function seedMemberBinding(runId: string, agentName: string, memberRecordId: string): Promise<void> {
  await dispatchRunTrigger(
    { runId },
    { type: "run-created", runId, workflowName: "override-it", argsSummary: "{}", ts: Date.now() },
  );
  await dispatchRunTrigger(
    { runId },
    {
      type: "agent-started",
      taskIndex: 0,
      agentName,
      attempt: 1,
      memberRecordId,
      ts: Date.now(),
    },
  );
}

/** 预置已结束（idle）的 workflow 成员 record 并注册进内存表（revive 通道的命中
 *  前提：内存 getMutable 命中 + resurrectClosed 可翻边）。 */
function seedIdleMemberRecord(store: RecordStore, runId: string, id: string): ExecutionRecord {
  const base = createRecord(id, {
    agent: "research-a",
    model: "p/m",
    mode: "background",
    task: "旧一轮任务",
    slug: "research-a",
    startedAt: Date.now(),
  });
  expect(trySettleLegacyClosed(base, "gc")).toBe(true);
  const record: ExecutionRecord = {
    ...base,
    origin: "workflow",
    parentRunId: runId,
  };
  store.register(record);
  return record;
}

let prevDataDirEnv: string | undefined;

beforeEach(() => {
  prevDataDirEnv = process.env["TAIJI_AGENT_DATA_DIR"];
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  clearEngines();
  for (const h of openHarnesses) {
    h.service.dispose();
    fs.rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  openHarnesses.length = 0;
  vi.restoreAllMocks();
  if (prevDataDirEnv === undefined) delete process.env["TAIJI_AGENT_DATA_DIR"];
  else process.env["TAIJI_AGENT_DATA_DIR"] = prevDataDirEnv;
});

// ============================================================
// 1. 派发侧覆写（§7.4 / §6.6 决策六②）
// ============================================================

describe("workflow 派发链覆盖消费（U4b）", () => {
  it("派发侧覆写：覆盖在场时显式调用参数 model 也被覆盖——派发身份与任务书模型 = 覆盖值", async () => {
    const h = makeHarness();
    h.modelService.setModelOverride("run-ovr", overrideOf());

    const pending = h.service.executeWorkflowAgent(
      baseOpts({ model: "main/main-model" }), // 调用参数显式指定旧模型——用户覆盖赢
      "run-ovr",
    );
    await flush();
    const run = soleRun(h.fake);
    const record = runningRecord(h.store);

    // 引擎 ctx（spawn argv 源，pi-engine buildRunIdentityParams 拼词形）= 覆盖值解析产物
    expect(run.ctx.ctxModel).toMatchObject({ provider: "zai-coding", id: "flash" });
    // 任务声明 = record 盖章词形 = 覆盖词形
    expect(run.task.model).toBe(OVERRIDE_REF);
    expect(record.model).toBe(OVERRIDE_REF);

    run.settle({ content: "done" });
    await pending;
  });

  // ============================================================
  // 2. taskSpec 组装点二次咨询（§7.4 P9 窗口封住）
  // ============================================================

  it("P9 窗口封住：身份解析后、taskSpec 组装前（池排队窗口）的切换不漏切——盖章与启动单点一致", async () => {
    const h = makeHarness();
    // 占满共享池 → 派发排队；identity 解析（acquire 前）已跑且覆盖未在场
    const pool = Reflect.get(h.service, "pool") as {
      maxConcurrent: number;
      acquire(p: number, m?: number, s?: AbortSignal): Promise<void>;
      release(): void;
    };
    for (let i = 0; i < pool.maxConcurrent; i++) await pool.acquire(0);

    const pending = h.service.executeWorkflowAgent(baseOpts(), "run-p9");
    await flush();
    expect(h.fake.runs).toHaveLength(0); // 仍在池排队（引擎未启动——P9 窗口内）

    // 窗口内 run 级切换（生产 = setModel 内存表写入；此处直写同表）
    h.modelService.setModelOverride("run-p9", overrideOf());
    pool.release();

    await flush();
    const run = soleRun(h.fake);
    const record = runningRecord(h.store);

    // spawn 前最后时刻取到最新覆盖：ctxModel 与任务书 = 覆盖值，盖章同步更新
    //（§6.6「取值与盖章单点完成，不存在盖章 ≠ 实际启动的窗口」）。
    expect(run.ctx.ctxModel).toMatchObject({ provider: "zai-coding", id: "flash" });
    expect(run.task.model).toBe(OVERRIDE_REF);
    expect(record.model).toBe(OVERRIDE_REF);

    run.settle({ content: "done" });
    await pending;
  });

  // ============================================================
  // 3. 复活重新盖章（§6.6 复活接线——不变量 1 例外）
  // ============================================================

  it("复活重新盖章：revive 成员 record.model = 覆盖值解析产物、spawn argv = 覆盖值（旧盖章被替换）", async () => {
    const h = makeHarness();
    const stale = seedIdleMemberRecord(h.store, "run-revive", "sa-revive-target");
    expect(stale.model).toBe("p/m"); // 旧盖章（上一轮启动模型——主对话模型词形）
    await seedMemberBinding("run-revive", "research-a", stale.id);

    h.modelService.setModelOverride("run-revive", overrideOf());

    const pending = h.service.executeWorkflowAgent(baseOpts(), "run-revive");
    await flush();
    const run = soleRun(h.fake);

    // 复活重派 = 新一轮启动：引擎调用前按最新解析产物（含覆盖）重新盖章
    expect(run.ctx.ctxModel).toMatchObject({ provider: "zai-coding", id: "flash" });
    expect(run.task.model).toBe(OVERRIDE_REF);
    const revived = h.store.getMutable(stale.id)!;
    expect(revived.model).toBe(OVERRIDE_REF);
    // thinkingLevel 同步重盖章（flash reasoning 开启 → 缺省档位推导 = "xhigh"）
    expect(revived.thinkingLevel).toBe("xhigh");
    // 复活命中路径不新建 record（同一成员实体续写）
    expect(h.store.listRunning().map((r) => r.id)).toEqual([stale.id]);

    run.settle({ content: "done" });
    await pending;
  });

  // ============================================================
  // 4. 回归：无覆盖 = 现状行为
  // ============================================================

  it("无覆盖回归：派发行为与现状一致（ctxModel 兜底解析、record.model = 解析词形、零覆写）", async () => {
    const h = makeHarness();
    const pending = h.service.executeWorkflowAgent(baseOpts(), "run-baseline");
    await flush();
    const run = soleRun(h.fake);
    const record = runningRecord(h.store);

    // 现状语义：三层解析第 3 层 ctxModel 兜底（harness 注入 CTX_MODEL = p/m），盖章词形一致
    expect(run.ctx.ctxModel).toMatchObject({ provider: "p", id: "m" });
    expect(run.task.model).toBe("p/m");
    expect(record.model).toBe("p/m");

    run.settle({ content: "done" });
    await pending;
  });

  // ============================================================
  // 5. U4a 事件管线闭合（journal 覆盖事件 → miss 重建 → 派发消费）
  // ============================================================

  it("U4a 事件管线闭合：journal 覆盖事件 → miss 重建（rebuildRunOverride 折叠 + 回填）→ 派发吃覆盖", async () => {
    const h = makeHarness();
    // 模拟 setModel run 级切换的持久化产物（生产写入面 = 壳 persistRunOverride 的
    // journal.append 同款帧）——内存表刻意不写（主 agent 重启后的 miss 形态）。
    const journal = createRunEventJournal(h.journalDir);
    await journal.append("run-rebuild", {
      type: "model-override",
      model: { provider: OVERRIDE_MODEL.provider, modelId: OVERRIDE_MODEL.id },
      ts: Date.now(),
    });

    const pending = h.service.executeWorkflowAgent(baseOpts(), "run-rebuild");
    await flush();
    const run = soleRun(h.fake);
    const record = runningRecord(h.store);

    // 派发侧覆写经 miss 重建命中：内存表回填 + 解析输入覆写 → 派发 = 覆盖值
    expect(run.ctx.ctxModel).toMatchObject({ provider: "zai-coding", id: "flash" });
    expect(record.model).toBe(OVERRIDE_REF);
    // 回填生效：覆盖表内存命中（后续派发不再读 journal）
    expect(h.modelService.getModelOverride("run-rebuild")).toMatchObject({
      ref: { provider: "zai-coding", modelId: "flash" },
    });

    run.settle({ content: "done" });
    await pending;

    // 第二次派发（内存已回填）同样吃覆盖——重建只发生一次的回归面
    const pending2 = h.service.executeWorkflowAgent(baseOpts({ description: "research-b" }), "run-rebuild");
    await flush();
    const run2 = h.fake.runs[1]!;
    expect(run2.ctx.ctxModel).toMatchObject({ provider: "zai-coding", id: "flash" });
    run2.settle({ content: "done" });
    await pending2;
  });

  it("非复活路径既有盖章行为不变：覆盖缺席（他 run 作用域不串扰）时新建 record 盖章 = identity 解析词形", async () => {
    const h = makeHarness();
    // 覆盖写在别的 run（作用域 = runId 键，不串扰本 run）
    h.modelService.setModelOverride("run-other", overrideOf());

    const pending = h.service.executeWorkflowAgent(baseOpts(), "run-fresh");
    await flush();
    const run = soleRun(h.fake);
    const record = runningRecord(h.store);

    expect(run.ctx.ctxModel).toMatchObject({ provider: "p", id: "m" });
    expect(record.model).toBe("p/m");

    run.settle({ content: "done" });
    await pending;
  });
});
