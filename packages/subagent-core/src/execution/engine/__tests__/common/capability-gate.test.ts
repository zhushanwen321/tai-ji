// capability-gate.test.ts —— [D3-④ 预检 capabilities 化] 拦截矩阵单测。
// 设计权威源：docs/design/subagent-engine-protocolization.md §3.3「能力位」段（manifest
// 权威双向处置）+ 历史源 subagent-dual-track-convergence.md §3.3 D3-④（r3 裁定：
// EngineCapabilities +maxTurns 位 pi=true/zcode=false，不保留硬编码 shape 检查）+
// §3.4 错误规格第 1 行 + §4 V4④⑤（正反向验收）。
//
// 覆盖（构建者白盒 + 使用者黑盒）：
//   1. per-engine 拦截矩阵：pi 全放行（含 maxTurns/fork/conversation/worktree——V4⑤
//      反向守护，pi 既有合法能力零拦截）；zcode 四参数全拦（fork/conversation/
//      maxTurns/worktree）
//   2. 错误族：engine_capability_unsupported + recovery 含可操作指引（调参数 / 修
//      manifest / 升级引擎包——W3 协议化口径，不再指向「engine: pi」内置兜底）
//   3. fork 判据（借位裁定）：session 分叉通道族任一可用即放行（OR 语义，A6⑦）——
//      pi conversation=native 放行（steer 虽 unsupported 不参与否决）；通道族全缺才拦
//   4. [W3] 方向判定②：manifest 多声明 → assertGateCapabilitiesMatched 抛
//      engine_capability_mismatch（gate 位逐位正反例 + 非 gate 位不判定）

import { describe, expect, it } from "vitest";

import {
  assertGateCapabilitiesMatched,
  assertTaskShapeSupported,
  type TaskShapeForGate,
} from "../../common/capability-gate.ts";
import { EngineError } from "../../common/errors.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineCapabilities } from "../../types.ts";

// W10（§2.10 ②）：gate 判据源改读引擎包 manifest（package.json xyz-agent.capabilities
// ——协议化后同步成员唯一源），不再深路径构造内建引擎实例（W11 删除）。
function manifestCaps(relPkg: string): EngineCapabilities {
  const pkg = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../../../", relPkg, "package.json"),
      "utf8",
    ),
  ) as { "xyz-agent": { subagentEngine: { capabilities: EngineCapabilities } } };
  return pkg["xyz-agent"].subagentEngine.capabilities;
}

const PI_CAPS = manifestCaps("pi-subagent-cli");
const ZCODE_CAPS = manifestCaps("zcode-subagent-cli");

/** 会话分叉通道族可用的 zcode 形态变体（fork 判据用）。 */
const ZCODE_CAPS_WITH_CONVERSATION: EngineCapabilities = { ...ZCODE_CAPS, conversation: "native" };

function gate(
  caps: EngineCapabilities,
  task: TaskShapeForGate,
  engineId = "zcode",
): void {
  assertTaskShapeSupported(engineId, caps, task);
}

/** 断言载体（结构化面）：EngineError（core）与 EngineSdkError（SDK 构造器）共用
 *  code/message/recovery 契约，测试按结构断言不绑类。 */
interface GateErrorShape {
  code: string;
  message: string;
  recovery: string;
}

function gateError(caps: EngineCapabilities, task: TaskShapeForGate, engineId = "zcode"): GateErrorShape {
  try {
    gate(caps, task, engineId);
  } catch (err) {
    // [W1 交接防漂移项落地] conversation 分支抛 SDK EngineSdkError
    //（engineConversationUnsupportedError——core 与引擎侧判据单源，W3 接线）；其余
    // 分支仍为 core EngineError。code/recovery/message 前缀契约两侧一致。
    expect(err).toHaveProperty("code");
    expect(err).toHaveProperty("recovery");
    return err as unknown as GateErrorShape;
  }
  throw new Error("expected assertTaskShapeSupported to throw");
}

describe("capability-gate（D3-④ 拦截矩阵）", () => {
  it("能力位声明：pi maxTurns=true、zcode maxTurns=false（r3 扩位裁定）", () => {
    expect(PI_CAPS.maxTurns).toBe(true);
    expect(ZCODE_CAPS.maxTurns).toBe(false);
  });

  it("[V4⑤ 反向] pi 引擎全参数放行：maxTurns/fork/forkFromSessionFile/conversation/worktree 零拦截", () => {
    expect(() =>
      gate(PI_CAPS, { maxTurns: 3, fork: true, conversation: true, worktree: true }, "pi"),
    ).not.toThrow();
    expect(() => gate(PI_CAPS, { forkFromSessionFile: "/tmp/sess.jsonl", worktree: { path: "/tmp/wt" } }, "pi")).not.toThrow();
  });

  it("[V4④ 正向] zcode 引擎四参数全拦：fork/conversation/maxTurns/worktree → engine_capability_unsupported", () => {
    const cases: Array<[TaskShapeForGate, RegExp]> = [
      [{ fork: true }, /不支持 fork/],
      [{ forkFromSessionFile: "/tmp/sess.jsonl" }, /fork-from 同为父 session 上下文继承/],
      [{ conversation: true }, /不支持 resume 续聊/],
      [{ maxTurns: 10 }, /不支持 maxTurns/],
      [{ worktree: true }, /不支持 worktree 隔离/],
      [{ worktree: { path: "/tmp/wt" } }, /不支持 worktree 隔离/],
    ];
    for (const [task, pattern] of cases) {
      const err = gateError(ZCODE_CAPS, task);
      expect(err.code).toBe("engine_capability_unsupported");
      expect(err.message).toMatch(pattern);
      expect(err.message).toContain("capabilities");
      // 错误信息可操作（§3.4 + W3 协议化口径）：恢复指引 = 调整参数 / 修 manifest /
      // 升级引擎包（能力声明的载体），不再指向「engine: pi」内置兜底
      expect(err.recovery).toMatch(/去掉|不传/);
      expect(err.recovery).toMatch(/修 manifest|升级引擎包/);
    }
  });

  it("zcode 放行面：无能力参数的任务全放行；maxTurns undefined（未传）不拦", () => {
    expect(() => gate(ZCODE_CAPS, {})).not.toThrow();
    expect(() => gate(ZCODE_CAPS, { maxTurns: undefined, fork: false, conversation: false, worktree: false })).not.toThrow();
  });

  it("fork 判据（借位裁定）：session 分叉通道族任一可用即放行——conversation=native 的引擎 fork 放行", () => {
    // pi 的 steer 声明 unsupported（spawn 链路未接通），fork 仍放行——通道族判定不因
    // 单一通道缺失而误拦（上面 pi 用例已覆盖）。此处补 zcode 形态 + conversation 通道
    // 可用的对照：fork 从拦截翻为放行。
    expect(() => gate(ZCODE_CAPS_WITH_CONVERSATION, { fork: true })).not.toThrow();
    expect(() => gate({ ...ZCODE_CAPS, steer: "native" }, { fork: true })).not.toThrow();
  });
});

// ============================================================
// [W3] 方向判定②：manifest 多声明 → engine_capability_mismatch（impl-plan §2.3）
// ============================================================

describe("assertGateCapabilitiesMatched（manifest vs initialize 应答，gate 位方向判定）", () => {
  function mismatchError(
    manifestCaps: EngineCapabilities,
    answeredCaps: EngineCapabilities,
  ): EngineError {
    try {
      assertGateCapabilitiesMatched("fake", manifestCaps, answeredCaps);
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError);
      return err as EngineError;
    }
    throw new Error("expected assertGateCapabilitiesMatched to throw");
  }

  it("conversation：manifest 非 unsupported、应答 unsupported → engine_capability_mismatch", () => {
    const err = mismatchError(
      { ...ZCODE_CAPS, conversation: "native" },
      { ...ZCODE_CAPS, conversation: "unsupported" },
    );
    expect(err.code).toBe("engine_capability_mismatch");
    expect(err.message).toContain("conversation");
    expect(err.recovery).toMatch(/manifest|升级引擎包/);
  });

  it("fork 通道族（OR 对偶）：manifest 任一可用、应答双 unsupported → mismatch", () => {
    const err = mismatchError(
      { ...ZCODE_CAPS, steer: "native" },
      { ...ZCODE_CAPS, steer: "unsupported", conversation: "unsupported" },
    );
    expect(err.code).toBe("engine_capability_mismatch");
    expect(err.message).toContain("fork");
  });

  it("maxTurns：manifest true、应答 false → mismatch", () => {
    const err = mismatchError({ ...ZCODE_CAPS, maxTurns: true }, { ...ZCODE_CAPS, maxTurns: false });
    expect(err.code).toBe("engine_capability_mismatch");
    expect(err.message).toContain("maxTurns");
  });

  it("sandbox：manifest 非 none、应答 none → mismatch", () => {
    const err = mismatchError({ ...ZCODE_CAPS, sandbox: "emulated" }, { ...ZCODE_CAPS, sandbox: "none" });
    expect(err.code).toBe("engine_capability_mismatch");
    expect(err.message).toContain("sandbox");
  });

  it("应答强于 manifest（引擎兑现更多）→ 不抛；同值对齐 → 不抛（无多声明）", () => {
    const weak = { ...ZCODE_CAPS, conversation: "unsupported" as const, maxTurns: false, sandbox: "none" as const };
    const strong = { ...ZCODE_CAPS, conversation: "native" as const, maxTurns: true, sandbox: "emulated" as const };
    // 应答强于 manifest：引擎兑现 manifest 全部声明，无多声明
    expect(() => assertGateCapabilitiesMatched("fake", weak, strong)).not.toThrow();
    // 同值对齐：无差异
    expect(() => assertGateCapabilitiesMatched("fake", strong, strong)).not.toThrow();
  });

  it("非 gate 位不一致 → 不判定不抛（无论强弱一律 warn 留痕，归 EngineClient 诊断面）", () => {
    const manifest = { ...ZCODE_CAPS, personaInjection: "file" as const, eventGranularity: "stream" as const, sessionRead: "full" as const, resume: "native" as const, interrupt: "native" as const, permissionMode: "native" as const, schemaEnforcement: "native" as const };
    const weaker = { ...ZCODE_CAPS, personaInjection: "prompt" as const, eventGranularity: "coarse" as const, sessionRead: "outcome-only" as const, resume: "unsupported" as const, interrupt: "kill-only" as const, permissionMode: "fixed" as const, schemaEnforcement: "emulated" as const };
    expect(() => assertGateCapabilitiesMatched("fake", manifest, weaker)).not.toThrow();
  });
});
