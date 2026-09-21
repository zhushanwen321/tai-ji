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

import {
  AGENT_EVENT_TYPE_NAMES,
  type AgentCallOpts,
  type AgentEvent,
  type AgentEventType,
  type AgentOutcome,
  type AssertMutuallyAssignable,
  type EngineCapabilities,
  type EngineHandleData,
  type ProbeReport,
  type SessionView,
} from "../protocol/contract-types.ts";
import type { UiRequest, UiRequestHandler, UiResponse } from "../ui-types.ts";
import type { RunContextParams, RunParams } from "../protocol/methods.ts";

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

// ── 3. 协议演进宪法机器锁（C3/C4/C2；权威源 docs/architecture/subagent-engine-protocolization.md
//    §3.3「协议演进宪法」）。断言必须带 const 锚点消费——裸 type alias 结果为 never 时
//    tsc 不报错，`const probe: _X = true` 形态让漂移在 typecheck 期即红。

// C3 事件词表 SSOT 双向锁：union 任一侧漂移（词表删成员 / union 加成员）即 never → 红。
type _AgentEventTypeNamesClosure = AssertMutuallyAssignable<
  AgentEventType,
  (typeof AGENT_EVENT_TYPE_NAMES)[number]
>;

// C4 task/ctx 双写禁令锁：keyof 交集与 never 双向可赋值恒 true（禁令绝对条款：
// 同一语义不得在 task 与 ctx 各挂一份，取值源必须唯一）。边界：禁令钉 wire 类型
// （本断言两端 = contract-types.ts AgentCallOpts × methods.ts RunContextParams）；
// port-contract.ts 的 RunContext 进程内合回形态是宿主侧独立契约，不在此列。
// 机器锁覆盖同名交集；异名同义双写由判据 4 成文 + CR 人判兜底。
type _NoTaskCtxDualWrite = AssertMutuallyAssignable<
  keyof AgentCallOpts & keyof RunContextParams,
  never
>;

// C2-① 存量能力位逐一必填的类型面：任一键被误标可选即 EngineCapabilities 不再
// 可赋值给 Required 形态 → 红。运行时键集合投影见 REQUIRED_CAPABILITY_KEYS。
type _CapabilityKeysAllRequired = AssertMutuallyAssignable<
  EngineCapabilities,
  Required<EngineCapabilities>
>;

// C2-① 存量 11 键名词表（逐一必填的运行时投影；新增轴走可选键，不进本词表）。
const REQUIRED_CAPABILITY_KEYS = [
  "schemaEnforcement",
  "steer",
  "conversation",
  "personaInjection",
  "eventGranularity",
  "sandbox",
  "sessionRead",
  "resume",
  "interrupt",
  "permissionMode",
  "maxTurns",
] as const satisfies readonly (keyof EngineCapabilities)[];

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

  it("C3 事件词表 ↔ AgentEvent union 双向锁为 true（词表删成员 / union 加成员均编译红）", () => {
    const c3: _AgentEventTypeNamesClosure = true;
    expect(c3).toBe(true);
  });

  it("C4 task/ctx 双写禁令锁为 true（keyof 交集 = never；任一侧加同名键编译红）", () => {
    const c4: _NoTaskCtxDualWrite = true;
    expect(c4).toBe(true);
  });
});

describe("契约类型运行时形状冒烟（字段可选项漂移时在构造处爆红）", () => {
  it("C2-① 存量 11 能力位逐一必填（键名集合词表锚定 + Required 类型锁，替换长度魔法数）", () => {
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
    expect([...Object.keys(caps)].sort()).toEqual([...REQUIRED_CAPABILITY_KEYS].sort());
    const allRequired: _CapabilityKeysAllRequired = true;
    expect(allRequired).toBe(true);
  });

  it("C2-② 可选新增轴缺省构造编译通过（新增轴一律可选键，缺省语义 = 该轴最弱档）", () => {
    // 模拟新增第 12 能力位：可选键 + 双侧 reducer/解析器对缺省的 no-op 语义。
    // 消费新轴的 core 代码必须处理缺省（不得 `!` 断言）——D11 C2 约定。
    type CapsWithFutureAxis = EngineCapabilities & { futureAxis?: "native" | "off" };
    const withoutFutureAxis: CapsWithFutureAxis = {
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
    const asBase: EngineCapabilities = withoutFutureAxis;
    expect("futureAxis" in asBase).toBe(false);
  });

  it("EngineHandleData v 恒字面量 1（JSON v1 契约）", () => {
    const handle: EngineHandleData = {
      v: 1,
      engineId: "zcode",
      sessionRef: { sessionId: "s1", dbPath: "/tmp/db.sqlite" },
      adapterVersion: "1.0.0",
    };
    expect(handle.v).toBe(1);
    expect(handle.sessionRef).toEqual({ sessionId: "s1", dbPath: "/tmp/db.sqlite" });
  });

  it("AgentEvent 词表逐值可构造（事件逐字序列化契约的构造面；目标集合从 AGENT_EVENT_TYPE_NAMES 派生）", () => {
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
    expect(events.map((e) => e.type)).toEqual([...AGENT_EVENT_TYPE_NAMES]);
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
