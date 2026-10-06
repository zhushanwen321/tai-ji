// src/__tests__/run-model-switch-aggregate.test.ts
//
// [subagent-model-switch U5] run 级全切聚合函数单测——mock EnginePort 表驱动
// （真实转发联调挂 U3 commit 门补跑，本文件以接口编程 + mock 验收）。
//
// 覆盖面（任务书测试要求，设计锚点 §7.1 / §7.4 / §7.5 / §8 场景 7）：
//   ① 三态分派：capability 非 native → not-applicable（先于引擎调用与目标模型校验，
//      §8 场景 7 步骤④）；存活成员成功 → switched 携带引擎回读生效值（非请求值，
//      §6.4 同族替换形态）；引擎定位不到活跃子进程 → not-active。
//   ② 部分失败不回滚：快照型 / 凭据型 / 回读失败型逐一列入名单，其余成员结果正常
//      返回，函数不抛异常（§7.5 聚合行）。
//   ③ 失败名单与成员态数组同维：同一受理成员 runId、两数组互斥、并集 = 受理集。
//   ④ run 级覆盖意图写入不受个别成员失败影响：含失败成员场景回调仍被调用恰好一次
//      （§7.5 聚合行「写」处置）。
//   ⑤ summary：承载未派发步骤沿用说明；全员非 switched 退化为「已记录，未派发步骤
//      生效」、不携带档位（§7.1）。

import { describe, expect, it } from "vitest";
import {
  EngineSdkError,
  type EngineCapabilities,
  type ModelRef,
  type SetModelParams,
  type SetModelResult,
} from "@zhushanwen/subagent-engine-sdk";

import {
  ENGINE_RUN_NOT_ACTIVE_CODE,
  runModelSwitchAggregate,
  type RunModelSwitchAggregateCall,
  type SetModelCapableEnginePort,
} from "../execution/service/run-model-switch-aggregate.ts";

// ============================================================
// mock EnginePort（setModel 转发窄接口替身）
// ============================================================

/** 切换目标（请求意图）与引擎回读生效值（同族替换形态——生效值 ≠ 请求值，§6.4）。 */
const TARGET_MODEL: ModelRef = { provider: "zai-coding-cn", modelId: "glm-5.3-flash" };
const EFFECTIVE_MODEL: ModelRef = { provider: "zai-coding-cn", modelId: "glm-5.3-flash-v2" };

/** 完整 capabilities（11 必填位照 fake-engine-port.ts 现役替身；setModel 位可配）。 */
function capsWith(setModel: EngineCapabilities["setModel"]): EngineCapabilities {
  return {
    schemaEnforcement: "native",
    steer: "unsupported",
    conversation: "native",
    personaInjection: "flag",
    eventGranularity: "stream",
    sandbox: "emulated",
    sessionRead: "full",
    resume: "native",
    interrupt: "kill-only",
    permissionMode: "native",
    maxTurns: true,
    setModel,
  };
}

type SetModelBehavior =
  | { kind: "ok"; effectiveModel: ModelRef; effectiveThinkingLevel: string }
  | { kind: "engineError"; code: string }
  | { kind: "rawError"; err: unknown };

/** setModel 转发通道替身：capabilities 可配、转发行为可配、调用参数全捕获。 */
class FakeSwitchPort implements SetModelCapableEnginePort {
  readonly id = "fake";
  readonly setModelCalls: SetModelParams[] = [];

  constructor(
    private readonly caps: EngineCapabilities,
    private readonly behavior: SetModelBehavior,
  ) {}

  capabilities(): EngineCapabilities {
    return this.caps;
  }

  async setModel(params: SetModelParams): Promise<SetModelResult> {
    this.setModelCalls.push(params);
    if (this.behavior.kind === "ok") {
      return {
        effectiveModel: this.behavior.effectiveModel,
        effectiveThinkingLevel: this.behavior.effectiveThinkingLevel,
      };
    }
    if (this.behavior.kind === "engineError") {
      throw new EngineSdkError(this.behavior.code, "mock detail", "mock recovery");
    }
    throw this.behavior.err;
  }

  // EnginePort 其余连接级成员（本函数不触达，stub 保持接口完整）。
  async probe(): Promise<never> {
    throw new Error("fake port: probe not expected in aggregate tests");
  }

  async run(): Promise<never> {
    throw new Error("fake port: run not expected in aggregate tests");
  }

  async read(): Promise<never> {
    throw new Error("fake port: read not expected in aggregate tests");
  }
}

/** 常用替身快捷构造。 */
function portOf(
  setModel: EngineCapabilities["setModel"],
  behavior: SetModelBehavior,
): FakeSwitchPort {
  return new FakeSwitchPort(capsWith(setModel), behavior);
}

function switchedPort(): FakeSwitchPort {
  return portOf("native", {
    kind: "ok",
    effectiveModel: EFFECTIVE_MODEL,
    effectiveThinkingLevel: "high",
  });
}

function failingPort(code: string): FakeSwitchPort {
  return portOf("native", { kind: "engineError", code });
}

const NOT_ACTIVE_BEHAVIOR: SetModelBehavior = {
  kind: "engineError",
  code: ENGINE_RUN_NOT_ACTIVE_CODE,
};

/** 聚合调用组装：成员表 → resolver 查表（缺表成员 = 引擎未注册形态）。 */
function callWith(
  memberPorts: Record<string, SetModelCapableEnginePort>,
  overrides: Partial<RunModelSwitchAggregateCall> = {},
): RunModelSwitchAggregateCall {
  return {
    runId: "run-1",
    model: TARGET_MODEL,
    memberRunIds: Object.keys(memberPorts),
    resolveMemberPort: (memberRunId) => {
      const port = memberPorts[memberRunId];
      if (port === undefined) {
        throw new EngineSdkError("engine_not_found", `no port for ${memberRunId}`, "check resolver");
      }
      return port;
    },
    ...overrides,
  };
}

// ============================================================
// ① 三态分派
// ============================================================

describe("runModelSwitchAggregate 三态分派", () => {
  it("capability 非 native → not-applicable，先于引擎调用（目标模型不可用形态未触达）", async () => {
    // §8 场景 7 步骤④：zcode 成员即使目标模型不可用也是 not-applicable——
    // mock 表达 = unsupported 引擎若被调用必返回快照型失败，断言结果是
    // not-applicable 而非失败名单，且 setModel 从未被调用。
    const zcodeLike = portOf("unsupported", {
      kind: "engineError",
      code: "engine_model_not_in_snapshot",
    });

    const result = await runModelSwitchAggregate(callWith({ "m-zcode": zcodeLike }));

    expect(result.members).toEqual([{ runId: "m-zcode", state: "not-applicable" }]);
    expect(result.failures).toEqual([]);
    expect(zcodeLike.setModelCalls).toHaveLength(0);
  });

  it("capability 缺省（manifest 未声明）→ not-applicable（缺省 = unsupported）", async () => {
    const undeclared = portOf(undefined, {
      kind: "engineError",
      code: "engine_model_not_in_snapshot",
    });

    const result = await runModelSwitchAggregate(callWith({ "m-old": undeclared }));

    expect(result.members).toEqual([{ runId: "m-old", state: "not-applicable" }]);
    expect(undeclared.setModelCalls).toHaveLength(0);
  });

  it("native 存活成员 → switched 携带引擎回读生效值（非请求值）", async () => {
    const alive = switchedPort();

    const result = await runModelSwitchAggregate(
      callWith({ "m-alive": alive }, { thinkingLevel: "low" }),
    );

    expect(result.members).toEqual([
      {
        runId: "m-alive",
        state: "switched",
        effectiveModel: EFFECTIVE_MODEL,
        effectiveThinkingLevel: "high",
      },
    ]);
    expect(result.members[0]?.effectiveModel).not.toEqual(TARGET_MODEL);
    expect(result.failures).toEqual([]);
  });

  it("引擎定位不到活跃子进程 → not-active（已退出成员，无生效值字段）", async () => {
    const exited = portOf("native", NOT_ACTIVE_BEHAVIOR);

    const result = await runModelSwitchAggregate(callWith({ "m-exited": exited }));

    expect(result.members).toEqual([{ runId: "m-exited", state: "not-active" }]);
    expect(result.members[0]).not.toHaveProperty("effectiveModel");
    expect(result.members[0]).not.toHaveProperty("effectiveThinkingLevel");
    expect(result.failures).toEqual([]);
  });

  it("转发参数透传：runId / model / thinkingLevel 原样送达引擎（缺省档位 = undefined）", async () => {
    const alive = switchedPort();
    const explicit = switchedPort();

    await runModelSwitchAggregate(callWith({ "m-1": alive }, { thinkingLevel: undefined }));
    await runModelSwitchAggregate(callWith({ "m-2": explicit }, { thinkingLevel: "low" }));

    expect(alive.setModelCalls[0]).toEqual({
      runId: "m-1",
      model: TARGET_MODEL,
      thinkingLevel: undefined,
    });
    expect(explicit.setModelCalls[0]).toEqual({
      runId: "m-2",
      model: TARGET_MODEL,
      thinkingLevel: "low",
    });
  });
});

// ============================================================
// ② 部分失败不回滚（三型表驱动）
// ============================================================

describe("runModelSwitchAggregate 部分失败不回滚", () => {
  it.each([
    { label: "快照型", code: "engine_model_not_in_snapshot" },
    { label: "凭据型", code: "engine_credential_missing" },
    { label: "回读失败型", code: "engine_state_readback_failed" },
  ])(
    "$label 失败成员列入名单、switched 成员结果正常返回",
    async ({ code }) => {
      const alive = switchedPort();
      const broken = failingPort(code);

      const result = await runModelSwitchAggregate(
        callWith({ "m-alive": alive, "m-broken": broken }, { memberRunIds: ["m-alive", "m-broken"] }),
      );

      expect(result.members).toEqual([
        {
          runId: "m-alive",
          state: "switched",
          effectiveModel: EFFECTIVE_MODEL,
          effectiveThinkingLevel: "high",
        },
      ]);
      expect(result.failures).toEqual([{ runId: "m-broken", reason: code }]);
    },
  );

  it("六成员全谱系混合分派：三态 + 三型失败各归其位、受理序保序", async () => {
    const memberPorts: Record<string, SetModelCapableEnginePort> = {
      "m-switched": switchedPort(),
      "m-not-active": portOf("native", NOT_ACTIVE_BEHAVIOR),
      "m-not-applicable": portOf("unsupported", {
        kind: "engineError",
        code: "engine_model_not_in_snapshot",
      }),
      "m-snapshot": failingPort("engine_model_not_in_snapshot"),
      "m-credential": failingPort("engine_credential_missing"),
      "m-readback": failingPort("engine_state_readback_failed"),
    };

    const result = await runModelSwitchAggregate(
      callWith(memberPorts, {
        memberRunIds: [
          "m-switched",
          "m-not-active",
          "m-not-applicable",
          "m-snapshot",
          "m-credential",
          "m-readback",
        ],
      }),
    );

    expect(result.members).toEqual([
      {
        runId: "m-switched",
        state: "switched",
        effectiveModel: EFFECTIVE_MODEL,
        effectiveThinkingLevel: "high",
      },
      { runId: "m-not-active", state: "not-active" },
      { runId: "m-not-applicable", state: "not-applicable" },
    ]);
    expect(result.failures).toEqual([
      { runId: "m-snapshot", reason: "engine_model_not_in_snapshot" },
      { runId: "m-credential", reason: "engine_credential_missing" },
      { runId: "m-readback", reason: "engine_state_readback_failed" },
    ]);
  });
});

// ============================================================
// ③ 失败名单与成员态数组同维
// ============================================================

describe("runModelSwitchAggregate 名单同维断言", () => {
  it("members 与 failures 是同一受理成员集合的互斥划分（无交集、并集 = 受理集）", async () => {
    const memberPorts: Record<string, SetModelCapableEnginePort> = {
      "m-a": switchedPort(),
      "m-b": portOf("native", NOT_ACTIVE_BEHAVIOR),
      "m-c": portOf("unsupported", { kind: "rawError", err: new Error("never called") }),
      "m-d": failingPort("engine_model_not_in_snapshot"),
      "m-e": failingPort("engine_credential_missing"),
    };

    const accepted = ["m-a", "m-b", "m-c", "m-d", "m-e"];
    const result = await runModelSwitchAggregate(callWith(memberPorts, { memberRunIds: accepted }));

    const memberIds = result.members.map((m) => m.runId);
    const failureIds = result.failures.map((f) => f.runId);

    expect(memberIds.length + failureIds.length).toBe(accepted.length);
    expect(new Set([...memberIds, ...failureIds])).toEqual(new Set(accepted));
    expect(memberIds.filter((id) => failureIds.includes(id))).toEqual([]);
    // 受理序保序（前端按成员分项呈现的对齐前提，§7.1）。
    expect([...memberIds, ...failureIds].sort()).toEqual([...accepted].sort());
  });
});

// ============================================================
// ④ run 级覆盖意图写入不受个别成员失败影响
// ============================================================

describe("runModelSwitchAggregate 覆盖意图写入", () => {
  it("含失败成员场景：意图写入回调仍被调用恰好一次（§7.5 聚合行「写」处置）", async () => {
    let intentWrites = 0;
    const memberPorts: Record<string, SetModelCapableEnginePort> = {
      "m-snapshot": failingPort("engine_model_not_in_snapshot"),
      "m-credential": failingPort("engine_credential_missing"),
      "m-readback": failingPort("engine_state_readback_failed"),
    };

    const result = await runModelSwitchAggregate(
      callWith(memberPorts, {
        memberRunIds: ["m-snapshot", "m-credential", "m-readback"],
        persistOverrideIntent: () => {
          intentWrites += 1;
        },
      }),
    );

    expect(intentWrites).toBe(1);
    expect(result.failures).toHaveLength(3);
    expect(result.members).toEqual([]);
  });

  it("全成功场景：意图写入回调恰好一次，且时点在全量转发完成后", async () => {
    let intentWrites = 0;
    let forwardedAtIntent = -1;
    const alive = switchedPort();
    const second = switchedPort();

    const result = await runModelSwitchAggregate(
      callWith(
        { "m-1": alive, "m-2": second },
        {
          memberRunIds: ["m-1", "m-2"],
          persistOverrideIntent: () => {
            intentWrites += 1;
            forwardedAtIntent = alive.setModelCalls.length + second.setModelCalls.length;
          },
        },
      ),
    );

    expect(intentWrites).toBe(1);
    expect(forwardedAtIntent).toBe(2);
    expect(result.members).toHaveLength(2);
  });

  it("缺省回调（不传 persistOverrideIntent）正常返回聚合结果", async () => {
    const result = await runModelSwitchAggregate(callWith({ "m-a": switchedPort() }));

    expect(result.members).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });
});

// ============================================================
// ⑤ summary 汇总文案
// ============================================================

describe("runModelSwitchAggregate summary", () => {
  it("有 switched 成员：承载未派发步骤沿用说明与成员计数、不携带档位值", async () => {
    const result = await runModelSwitchAggregate(
      callWith(
        { "m-a": switchedPort(), "m-b": switchedPort(), "m-c": failingPort("engine_model_not_in_snapshot") },
        { memberRunIds: ["m-a", "m-b", "m-c"], thinkingLevel: "high" },
      ),
    );

    expect(result.summary).toContain("未派发步骤");
    expect(result.summary).toContain("2/3");
    expect(result.summary).not.toContain("high");
  });

  it("全员非 switched（not-active / not-applicable / 失败混合）：退化为已记录文案", async () => {
    const result = await runModelSwitchAggregate(
      callWith(
        {
          "m-x": portOf("native", NOT_ACTIVE_BEHAVIOR),
          "m-y": portOf("unsupported", { kind: "rawError", err: new Error("never called") }),
          "m-z": failingPort("engine_credential_missing"),
        },
        { memberRunIds: ["m-x", "m-y", "m-z"] },
      ),
    );

    expect(result.summary).toBe("已记录，未派发步骤生效");
  });

  it("空受理清单：三组件恒保留、退化为已记录文案、意图回调仍恰好一次", async () => {
    let intentWrites = 0;

    const result = await runModelSwitchAggregate(
      callWith({}, {
        memberRunIds: [],
        persistOverrideIntent: () => {
          intentWrites += 1;
        },
      }),
    );

    expect(result.members).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.summary).toBe("已记录，未派发步骤生效");
    expect(intentWrites).toBe(1);
  });
});
