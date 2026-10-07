// src/__tests__/model-switch.test.ts
//
// [subagent-model-switch U2] setModel 宿主编排封装层的行为测试：
//   - §3.4 聚合不变量 1-5 各一条（原文为断言基准）；
//   - §7.2 分型处置表 7 行逐行一测（写 / 不写 + 应答形态）；
//   - 应答两型（已生效型含回读值；已记账型不含档位）；
//   - workflow run 非终局 fail-fast；
//   - 凭据 / thinking 档位预检拦截（含「无活进程 + 无凭据」组合路径——§7.2 步骤①
//     两路径统一生效的机器核对）。
//
// 编排 deps 全桩注入（engineSetModel / runAggregate 等 U3/U5 接线通道按契约形状
// 打桩）；模型校验链用真实 ModelConfigService + mock registry（校验语义真实）；
// chat 域落账用真实 RecordStore（内存 + 事件文件 tmpdir 形态——落账原语行为真实）。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 活进程镜像判据桩（编排分流判据——测试可控翻转）。
const live = vi.hoisted(() => ({ value: false }));
vi.mock("../execution/lifecycle/lifecycle-predicates.ts", () => ({
  hasLiveProcessHandle: (recordId: string) => live.value && recordId.length > 0,
}));

import { SET_MODEL_ERROR_CODES } from "@zhushanwen/subagent-engine-sdk";

import { ModelConfigService } from "../execution/assembly/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../execution/assembly/model-resolver.ts";
import { createRecord } from "../execution/persistence/execution-record.ts";
import { RecordStore } from "../execution/persistence/record-store.ts";
import { createRecordEventStream } from "../execution/persistence/record-events.ts";
import {
  engineSetModelErrorCode,
  setModel,
  type ModelSwitchDeps,
  type ModelSwitchModelService,
} from "../execution/service/model-switch.ts";
import type { ModelOverride } from "../execution/domain/record-model.ts";

// ============================================================
// fixtures
// ============================================================

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "glm-5.3",
    name: over.name ?? "GLM-5.3",
    provider: over.provider ?? "zai-coding-cn",
    reasoning: over.reasoning ?? false,
    thinkingLevelMap: over.thinkingLevelMap,
    contextWindow: over.contextWindow,
  };
}

function makeRegistry(
  models: ModelInfo[],
  authed: string[] = models.map((m) => `${m.provider}/${m.id}`),
): ModelRegistryLike {
  const authSet = new Set(authed);
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: (m) => {
      if (!m || typeof m !== "object") return false;
      const mm = m as ModelInfo;
      return authSet.has(`${mm.provider}/${mm.id}`);
    },
  };
}

/** thinking 档位表（high/xhigh 可用——预检裁决基准）。 */
const LEVELS = { off: true, high: true, xhigh: true };

function makeRecord(id: string): ReturnType<typeof createRecord> {
  return createRecord(id, {
    agent: "general-purpose",
    model: "zai-coding-cn/glm-5.3",
    thinkingLevel: "high",
    mode: "background",
    task: "demo task",
    slug: "demo",
    startedAt: 1_000,
  });
}

interface Harness { // oe-exempt:20261006:test:测试专用装配 harness 单实现为常态
  deps: ModelSwitchDeps;
  service: ModelConfigService;
  store: RecordStore;
  recordsDir: string;
  record: ReturnType<typeof createRecord>;
  engineSetModelCalls: Array<{ runId: string; model: { provider: string; modelId: string } }>;
  persistedRunOverrides: Array<{ runId: string; override: ModelOverride }>;
  aggregateCalls: number;
}

/** 组装被测编排：真实 ModelConfigService + 真实 RecordStore（tmpdir）+ 桩通道。 */
function makeHarness(opts: {
  registry: ModelRegistryLike;
  /** engineSetModel 桩行为（缺省 = 成功回读）。 */
  engineSetModel?: NonNullable<ModelSwitchDeps["engineSetModel"]> extends infer F ? F : never;
  isEngineNotActive?: (err: unknown) => boolean;
  runAggregate?: ModelSwitchDeps["runAggregate"];
  assertRunNotTerminal?: ModelSwitchDeps["assertRunNotTerminal"];
  memberRunIds?: string[];
  capabilitiesSetModel?: "native" | "unsupported";
}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "u2-model-switch-"));
  const service = new ModelConfigService({ agentDir: join(dir, "agent"), cwd: dir });
  service.initModel({ modelRegistry: opts.registry, sessionId: "sess-1" });
  const store = new RecordStore(join(dir, "sessions"), undefined, undefined, join(dir, "records"));
  const record = makeRecord("sa-demo-1");
  store.register(record);

  const engineSetModelCalls: Harness["engineSetModelCalls"] = [];
  const persistedRunOverrides: Harness["persistedRunOverrides"] = [];
  let aggregateCalls = 0;

  const engineStub = {
    id: "pi",
    capabilities: () => ({
      conversation: "native",
      steer: "unsupported",
      structuredOutput: "native",
      sessionView: "native",
      permissionMode: "ignored",
      maxTurns: true,
      ...(opts.capabilitiesSetModel !== undefined ? { setModel: opts.capabilitiesSetModel } : {}),
    }),
  };

  const deps: ModelSwitchDeps = {
    getModelService: () => service,
    markModelOverride: (rec, override) => store.markModelOverride(rec, override),
    resolveEnginePort: () => engineStub as never,
    engineSetModel:
      opts.engineSetModel ??
      ((_port, params) => {
        engineSetModelCalls.push({ runId: params.runId, model: params.model });
        return Promise.resolve({
          effectiveModel: { provider: params.model.provider, modelId: `${params.model.modelId}-turbo` },
          // M1-1：热切 wire 无档位参数——回读档位 = 引擎侧联动重设语义的裁决（桩恒定值）。
          effectiveThinkingLevel: "high",
        });
      }),
    isEngineNotActiveError: opts.isEngineNotActive ?? (() => false),
    runAggregate:
      opts.runAggregate ??
      ((input) => {
        aggregateCalls += 1;
        return Promise.resolve({
          members: input.memberRunIds.map((runId) => ({ runId, state: "not-active" as const })),
          failures: [],
          summary: "已记录，未派发步骤生效。",
        });
      }),
    assertRunNotTerminal: opts.assertRunNotTerminal ?? (() => {}),
    listAcceptedMemberRunIds: () => opts.memberRunIds ?? ["sa-m1", "sa-m2"],
    persistRunOverride: (runId, override) => {
      persistedRunOverrides.push({ runId, override });
    },
  };
  return { deps, service, store, recordsDir: join(dir, "records"), record, engineSetModelCalls, persistedRunOverrides, aggregateCalls };
}

/** 引擎错误桩（分型错误经 code 属性承载——引擎 error 帧的宿主侧形态）。 */
function engineError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, name: "EngineError" });
}

const TARGET_MODEL = { provider: "zai-coding-cn", modelId: "glm-5.3-flash" };

beforeEach(() => {
  live.value = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// §3.4 聚合不变量 1-5
// ============================================================

describe("model-switch — 聚合不变量（§3.4）", () => {
  it("不变量 1：切换操作永不改写 record.model（该轮启动模型 = 历史事实）", async () => {
    const h = makeHarness({ registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]) });
    live.value = true;
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
    expect(reply.scope).toBe("chat");
    expect(h.record.model).toBe("zai-coding-cn/glm-5.3"); // 盖章值原样
    expect(h.record.thinkingLevel).toBe("high");
  });

  it("不变量 2：同一会话至多一个覆盖值——再次切换 = 整替（不叠加）", async () => {
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" }), makeModel({ id: "glm-5.3" })]),
    });
    const first = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
    expect(first).toMatchObject({ scope: "chat" });
    const second = await setModel(h.deps, { domain: "chat", record: h.record }, { provider: "zai-coding-cn", modelId: "glm-5.3" });
    expect(second).toMatchObject({ scope: "chat" });
    expect(h.record.modelOverride?.ref).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3" });
    expect(h.service.getModelOverride(h.record.id)?.ref).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3" });
  });

  it("不变量 3：canonical ref 全等 + 目录校验通过才可写覆盖——非法 ref 零写入", async () => {
    const h = makeHarness({ registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]) });
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, { provider: "zai-coding-cn", modelId: "no-such-model" });
    expect(reply).toMatchObject({ scope: "error" });
    if (reply.scope === "error") expect(reply.message).toMatch(/is not in the pi engine model catalog/);
    expect(h.record.modelOverride).toBeUndefined();
    expect(h.service.getModelOverride(h.record.id)).toBeUndefined();
  });

  it("不变量 4：覆盖在场时解析产物恒等于覆盖值解析产物（第 0 层短路闭环）", async () => {
    const flash = makeModel({ id: "glm-5.3-flash", reasoning: true, thinkingLevelMap: LEVELS });
    const h = makeHarness({ registry: makeRegistry([flash]) });
    await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "high");
    const override = h.record.modelOverride;
    expect(override).toBeDefined();
    // 第 0 层消费记账的解析产物 = 覆盖值（与 resolveModel 直解覆盖值同形）。
    const viaTable = h.service.resolveModel(h.record.agent, undefined, undefined, undefined, {
      model: `${override!.ref.provider}/${override!.ref.modelId}`,
      thinkingLevel: override!.thinkingLevel,
    });
    expect(viaTable.model.id).toBe("glm-5.3-flash");
    expect(viaTable.thinkingLevel).toBe("high");
  });

  it("不变量 5：切换只写意图类载体——历史事实类持久化（record-created 帧）不被改写", async () => {
    const h = makeHarness({ registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]) });
    await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
    const events = await createRecordEventStream(h.recordsDir).scan(h.record.id);
    const created = events.find((e) => e.type === "record-created");
    const overrideFrames = events.filter((e) => e.type === "record-model-override");
    // created 帧 model 保持原盖章值；新增的只有覆盖记账帧（意图载体）。
    expect(created?.model).toBe("zai-coding-cn/glm-5.3");
    expect(overrideFrames).toHaveLength(1);
    expect(h.record.model).toBe("zai-coding-cn/glm-5.3");
  });
});

// ============================================================
// §7.2 分型处置表 7 行
// ============================================================

describe("model-switch — 分型处置表（§7.2 七行）", () => {
  it("行 1 成功（生效值回读到手）→ 写 + 已生效型应答（回读值，非请求值）", async () => {
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
      capabilitiesSetModel: "native",
    });
    live.value = true;
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "high");
    expect(reply).toMatchObject({
      scope: "chat",
      reply: {
        kind: "effective",
        effectiveModel: { provider: "zai-coding-cn", modelId: "glm-5.3-flash-turbo" }, // 回读值（同族替换形态）
        effectiveThinkingLevel: "high",
      },
    });
    expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写
    expect(h.service.getModelOverride(h.record.id)?.ref).toEqual(TARGET_MODEL);
  });

  it("行 2 校验型失败（凭据缺失）→ 不写（含无活进程组合路径——预检两路径统一生效）", async () => {
    const unauthed = makeRegistry([makeModel({ id: "glm-5.3-flash" })], []); // 无任何已鉴权模型
    for (const isLive of [false, true]) {
      live.value = isLive;
      const h = makeHarness({ registry: unauthed, capabilitiesSetModel: "native" });
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
      expect(reply).toMatchObject({ scope: "error" });
      if (reply.scope === "error") expect(reply.message).toMatch(/auth is not configured/);
      expect(h.record.modelOverride).toBeUndefined(); // 未写（步骤①拦截）
      expect(h.service.getModelOverride(h.record.id)).toBeUndefined();
    }
  });

  it("行 3 快照型失败（engine_model_not_in_snapshot）→ 写 + 错误应答（模型本身有效）", async () => {
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
      capabilitiesSetModel: "native",
      engineSetModel: () => Promise.reject(engineError("engine_model_not_in_snapshot", "Model not found in child snapshot")),
    });
    live.value = true;
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
    expect(reply).toMatchObject({ scope: "chat", reply: { kind: "error", errorCode: "engine_model_not_in_snapshot" } });
    expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写
    // 持久化帧已落（下一轮 spawn 现取目录即可用的机制依据）。
    const events = await createRecordEventStream(h.recordsDir).scan(h.record.id);
    expect(events.filter((e) => e.type === "record-model-override")).toHaveLength(1);
  });

  it("落账返回值门（dmg-r1-10）：record 非内存实例（落账 false）→ 内存记账表同步跳过（无双介质劈叉），应答形态不变", async () => {
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
      capabilitiesSetModel: "native",
      engineSetModel: () => Promise.reject(engineError("engine_state_readback_failed", "readback failed")),
    });
    live.value = true;
    // 同 id 重建对象（gateway manifest 兜底链可能产出的形态——store.getMutable 同 id 但非同实例）
    const ghost: typeof h.record = { ...h.record };
    const reply = await setModel(h.deps, { domain: "chat", record: ghost }, TARGET_MODEL);
    // 应答形态不变（错误应答照常——生效状态未知如实报，不因落账跳过虚构校验失败）
    expect(reply).toMatchObject({ scope: "chat", reply: { kind: "error", errorCode: "engine_state_readback_failed" } });
    // 双介质劈叉消除：内存记账表未写（持久化两面 store 原语内跳过——重建对象 record 字段本就不落内存表）
    expect(h.service.getModelOverride(ghost.id)).toBeUndefined();
    expect(ghost.modelOverride).toBeUndefined();
    // 事件帧同样未写（store 原语 false 两面都跳过）
    const events = await createRecordEventStream(h.recordsDir).scan(ghost.id);
    expect(events.filter((e) => e.type === "record-model-override")).toHaveLength(0);
  });

  it("行 4 run 级聚合个别成员转发失败 → run 级意图恒写（内存表 + U4a 载体桩）", async () => {
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
      memberRunIds: ["sa-m1", "sa-m2", "sa-m3"],
      runAggregate: (input) =>
        Promise.resolve({
          members: [
            { runId: input.memberRunIds[0]!, state: "switched" as const, effectiveModel: input.model, effectiveThinkingLevel: "high" },
            { runId: input.memberRunIds[1]!, state: "not-active" as const },
            { runId: input.memberRunIds[2]!, state: "not-applicable" as const },
          ],
          failures: [{ runId: "sa-m1", reason: "engine_state_readback_failed" as const }],
          summary: "1 个成员切换失败，已列出失败名单。",
        }),
    });
    const reply = await setModel(h.deps, { domain: "workflow-run", runId: "run-1" }, TARGET_MODEL);
    expect(reply).toMatchObject({ scope: "workflow-run" });
    if (reply.scope === "workflow-run") {
      expect(reply.aggregate.failures).toEqual([{ runId: "sa-m1", reason: "engine_state_readback_failed" }]);
      expect(reply.aggregate.members).toHaveLength(3);
    }
    expect(h.persistedRunOverrides).toHaveLength(1); // run 级意图照写
    expect(h.persistedRunOverrides[0]?.runId).toBe("run-1");
    expect(h.service.getModelOverride("run-1")?.ref).toEqual(TARGET_MODEL);
  });

  it("行 5 竞态无活进程（转发期间子进程退出）→ 写 + 提示性应答", async () => {
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
      capabilitiesSetModel: "native",
      engineSetModel: () => Promise.reject(new Error("child exited during relay")),
      isEngineNotActive: () => true,
    });
    live.value = true;
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
    expect(reply).toMatchObject({ scope: "chat", reply: { kind: "recorded" } });
    if (reply.scope === "chat" && reply.reply.kind === "recorded") {
      expect(reply.reply.notice).toMatch(/已退出/);
    }
    expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写
  });

  it("行 6 引擎不支持热切（capability 预检不支持）→ 写 + 提示性应答（不发引擎调用）", async () => {
    const engineSetModelCalls: unknown[] = [];
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
      capabilitiesSetModel: "unsupported",
      engineSetModel: (port, params) => {
        engineSetModelCalls.push({ port, params });
        return Promise.resolve({ effectiveModel: params.model, effectiveThinkingLevel: "high" });
      },
    });
    live.value = true;
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
    expect(reply).toMatchObject({ scope: "chat", reply: { kind: "recorded" } });
    if (reply.scope === "chat" && reply.reply.kind === "recorded") {
      expect(reply.reply.notice).toMatch(/暂不支持执行中热切换/);
    }
    expect(engineSetModelCalls).toHaveLength(0); // 位不支持不发调用（§7.3 能力位消费点）
    expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写
  });

  it("行 7 生效值回读失败（engine_state_readback_failed）→ 写 + 错误应答（不虚构生效值）", async () => {
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
      capabilitiesSetModel: "native",
      engineSetModel: () => Promise.reject(engineError("engine_state_readback_failed", "no readback receipt")),
    });
    live.value = true;
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
    expect(reply).toMatchObject({ scope: "chat", reply: { kind: "error", errorCode: "engine_state_readback_failed" } });
    expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写（命令已送达，意图已表达）
  });
});

// ============================================================
// 应答两型 + run 非终局 + 预检拦截
// ============================================================

describe("model-switch — 应答两型 / run 非终局 fail-fast / 档位预检", () => {
  it("已记账型应答不含档位（无回读源——档位由下次解析推导，不预告猜测值）", async () => {
    const h = makeHarness({ registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]) });
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "high");
    expect(reply.scope).toBe("chat");
    if (reply.scope === "chat" && reply.reply.kind === "recorded") {
      expect("effectiveThinkingLevel" in reply.reply).toBe(false);
      expect("effectiveModel" in reply.reply).toBe(false);
    } else {
      expect.unreachable("无活进程路径应答必须是已记账型");
    }
  });

  it("run 已终局 → 步骤① fail-fast（scope error + 零写入 + 聚合不触达）", async () => {
    const h = makeHarness({
      registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
      assertRunNotTerminal: () => {
        throw new Error("run already terminal (done/failed/cancelled/time_limited) — no future step to apply the override");
      },
    });
    const reply = await setModel(h.deps, { domain: "workflow-run", runId: "run-1" }, TARGET_MODEL);
    expect(reply).toMatchObject({ scope: "error" });
    if (reply.scope === "error") expect(reply.message).toMatch(/terminal/);
    expect(h.persistedRunOverrides).toHaveLength(0);
    expect(h.aggregateCalls).toBe(0);
    expect(h.service.getModelOverride("run-1")).toBeUndefined();
  });

  it("thinking 档位预检：显式候选档位对新模型不可用 → 拒（不写）", async () => {
    const onlyHigh = makeModel({ id: "glm-5.3-flash", reasoning: true, thinkingLevelMap: { high: true } });
    const h = makeHarness({ registry: makeRegistry([onlyHigh]) });
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "xhigh");
    expect(reply).toMatchObject({ scope: "error" });
    if (reply.scope === "error") expect(reply.message).toMatch(/thinkingLevel "xhigh" is not available/);
    expect(h.record.modelOverride).toBeUndefined();
  });

  it("凭据预检 + 档位预检先于 capability 分流（无活进程路径同样生效——§7.2 步骤①）", async () => {
    const unauthed = makeRegistry([makeModel({ id: "glm-5.3-flash" })], []);
    const h = makeHarness({ registry: unauthed });
    const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "high");
    // 无活进程路径直接走记账分支，但凭据预检已在前置校验段拦截——未到记账写面。
    expect(reply).toMatchObject({ scope: "error" });
    expect(h.record.modelOverride).toBeUndefined();
  });
});

// ============================================================
// 分型词表收窄 helper
// ============================================================

describe("engineSetModelErrorCode", () => {
  it("分型错误经 code 属性收窄到 SDK 三型词表；非分型错误返回 undefined", () => {
    expect(engineSetModelErrorCode(engineError("engine_model_not_in_snapshot", "x"))).toBe("engine_model_not_in_snapshot");
    expect(engineSetModelErrorCode(engineError("engine_credential_missing", "x"))).toBe("engine_credential_missing");
    expect(engineSetModelErrorCode(engineError("engine_state_readback_failed", "x"))).toBe("engine_state_readback_failed");
    expect(engineSetModelErrorCode(new Error("plain"))).toBeUndefined();
    expect(engineSetModelErrorCode(undefined)).toBeUndefined();
    expect(SET_MODEL_ERROR_CODES).toHaveLength(3);
  });
});
