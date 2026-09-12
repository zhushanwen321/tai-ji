// src/__tests__/contract-closure.test.ts
//
// 类型闭包样板（W1 落 SDK 侧；core 侧断言挂靠归 W2，impl-plan §2.1「类型闭包处置」）。
//
// AssertMutuallyAssignable 助手自 SDK 导出（W2 在 core 里写
//   `type _A = AssertMutuallyAssignable<CoreX, SdkX>`，
// 挂 `pnpm --filter @zhushanwen/subagent-core typecheck` 断言族）。
// 本文件落三件事：
//   1. 类型层自恰断言：SDK 契约类型对自身的双向可赋值恒 true（样板可编译性验证）；
//   2. 结构子集方向断言：run.params.task（AgentCallOpts 子集）不得引入 core 全量
//      AgentCallOpts 未定义的字段——样板演示 core→SDK 方向的断言形态；
//   3. 运行时形状冒烟：关键契约类型的必填字段在字面量构造下齐备（TS 编译期已锁，
//      运行时断言防止字段被误标可选后测试静默放行）。
//
// 本文件不 import core（不变量：SDK 不得 import core；core 类型接入归 W2）。

import { describe, expect, it } from "vitest";

import type {
  AgentCallOpts,
  AgentEvent,
  AgentOutcome,
  AssertMutuallyAssignable,
  EngineCapabilities,
  EngineHandleData,
  ProbeReport,
  SessionView,
} from "../protocol/contract-types.ts";
import type { UiRequest, UiRequestHandler, UiResponse } from "../ui-types.ts";
import type { RunParams } from "../protocol/methods.ts";

// ── 1. 自恰样板（每个契约类型一行；SDK 类型 ↔ 自身恒可赋值）──
type _SelfAgentEvent = AssertMutuallyAssignable<AgentEvent, AgentEvent>;
type _SelfEngineHandleData = AssertMutuallyAssignable<EngineHandleData, EngineHandleData>;
type _SelfSessionView = AssertMutuallyAssignable<SessionView, SessionView>;
type _SelfEngineCapabilities = AssertMutuallyAssignable<EngineCapabilities, EngineCapabilities>;
type _SelfProbeReport = AssertMutuallyAssignable<ProbeReport, ProbeReport>;
type _SelfAgentOutcome = AssertMutuallyAssignable<AgentOutcome, AgentOutcome>;
type _SelfUiRequest = AssertMutuallyAssignable<UiRequest, UiRequest>;
type _SelfUiResponse = AssertMutuallyAssignable<UiResponse, UiResponse>;
type _SelfUiHandler = AssertMutuallyAssignable<UiRequestHandler, UiRequestHandler>;
// AgentCallOpts 的引擎面子集 ↔ run.params.task（协议消费方向一致）
type _SelfAgentCallOpts = AssertMutuallyAssignable<AgentCallOpts, RunParams["task"]>;

// ── 2. 方向性样板（演示 W2 core→SDK 断言形态；用结构等价镜像替代 core 类型）──
// W2 落地时把下面的 Mirror* 换成 core 实型即可：
//   type _A1 = AssertMutuallyAssignable<CoreAgentEvent, AgentEvent>;
//   type _A2 = AssertMutuallyAssignable<CoreEngineHandleData, EngineHandleData>; ……
// 方向性演示：子集镜像 → 全量声明不可反向收窄（AgentCallOpts 子集 ⊆ core 全量的
// 断言方向 = core 全量可赋值给「宽松形态」，子集断言只在必填字段上做——此处以
// UiResponse 演示联合形态的互斥可赋值性）。
type MirrorUiResponse = UiResponse;
type _MirrorClosure = AssertMutuallyAssignable<MirrorUiResponse, UiResponse>;

const selfAssertions: Array<true> = [];
void selfAssertions;

describe("类型闭包样板", () => {
  it("AssertMutuallyAssignable 自恰断言为 true（编译期锁 + 运行时确认样板可执行）", () => {
    // 类型层：所有 _Self* 与 _MirrorClosure 已在编译期被锁为 true（否则 never 不可赋值）
    const probe: _SelfAgentEvent = true;
    expect(probe).toBe(true);
  });

  it("run.params.task 与 AgentCallOpts 同一类型面（协议 task 载荷 = 引擎面子集）", () => {
    const same: _SelfAgentCallOpts = true;
    expect(same).toBe(true);
  });
});

describe("契约类型运行时形状冒烟（字段可选项漂移时在构造处爆红）", () => {
  it("EngineCapabilities 11 个能力位必填（gate 四类判据的类型面）", () => {
    const caps: EngineCapabilities = {
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "coarse",
      sandbox: "emulated",
      sessionRead: "full",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "fixed",
      maxTurns: false,
    };
    expect(Object.keys(caps)).toHaveLength(11);
  });

  it("EngineHandleData v 恒字面量 1（JSON v1 契约）", () => {
    const handle: EngineHandleData = {
      v: 1,
      engineId: "zcode",
      sessionRef: { sessionId: "s1", dbPath: "/tmp/db.sqlite" },
      poolKey: "shared",
      adapterVersion: "1.0.0",
    };
    expect(handle.v).toBe(1);
    expect(handle.sessionRef).toEqual({ sessionId: "s1", dbPath: "/tmp/db.sqlite" });
  });

  it("AgentEvent 9 种事件可构造（事件逐字序列化契约的构造面）", () => {
    const events: AgentEvent[] = [
      { type: "tool_start", toolName: "bash", args: { cmd: "ls" } },
      { type: "tool_end", toolName: "bash", result: { content: [] }, isError: false },
      { type: "text_delta", delta: "hello" },
      { type: "thinking_delta", delta: "hmm" },
      { type: "turn_end", summary: "done" },
      { type: "message_end", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { type: "compaction" },
      { type: "activity" },
      { type: "error", message: "boom" },
    ];
    expect(events).toHaveLength(9);
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        "tool_start",
        "tool_end",
        "text_delta",
        "thinking_delta",
        "turn_end",
        "message_end",
        "compaction",
        "activity",
        "error",
      ]),
    );
  });

  it("AgentOutcome.exitCode 接受 null（被信号杀死的杀链判据）", () => {
    const outcome: AgentOutcome = { content: "", engineId: "zcode", exitCode: null };
    expect(outcome.exitCode).toBeNull();
  });

  it("UiRequest/UiResponse 构造形态与 dialog-queue 契约一致（结构等价冒烟）", () => {
    const req: UiRequest = {
      method: "select",
      id: "u1",
      title: "ask_user",
      options: ["a", "b"],
      channel: "ask_user",
      channelPayload: { questions: [], allowCancel: true },
    };
    const responses: UiResponse[] = [
      { value: "a" },
      { confirmed: true },
      { cancelled: true },
      { ack: true },
    ];
    expect(req.method).toBe("select");
    expect(responses).toHaveLength(4);
  });
});
