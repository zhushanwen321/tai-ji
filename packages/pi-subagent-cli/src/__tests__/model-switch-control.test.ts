// model-switch-control.test.ts
//
// [subagent-model-switch §7.3] setModel 通路单测（U3）：
//   A. spawn-runner setModelOnActiveChild——§7.3 竞态窗口全覆盖（定位时已退出 /
//      写入-读应答-回读窗口内退出 → 无活进程形态；存活但回读超时 → 回读失败形态，
//      两结局严格互斥）+ pi 错误应答三型映射 + get_state 回读生效值（不信命令应答即真）；
//   B. pi-engine setModel——原始结局 → 协议错误码映射（三型 + engine_run_not_active）
//      与成功应答形状、capabilities 声明位；
//   C. server dispatch——协议一致性（capability 非 native 引擎收 setModel 请求 =
//      结构化错误而非崩；native 引擎路由 engine 实装）+ 声明点两处镜像同批核对
//      （PiEngine.capabilities() ↔ package.json manifest，guide §3 纪律）。
//
// 测试策略：FakeChild（EventEmitter + PassThrough stdin）模拟子进程；应答帧经
// dispatchControlResponse 直接注入进程级等待表（pump 路由的分发入口同函数——
// pump 接线本身另经 spawn-run-pump 既有测试形态覆盖）；超时窗用 fake timers。

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineSdkError, SET_MODEL_STAGE_TIMEOUT_MS } from "@zhushanwen/subagent-engine-sdk";

import { registerActiveChild, unregisterActiveChild } from "../active-children.ts";
import { dispatchControlResponse, setModelOnActiveChild } from "../control-responses.ts";
import { PiEngine } from "../pi-engine.ts";
import { EngineProtocolServer } from "../server.ts";

// ── 测试基建 ──

/** 可控子进程 fake：EventEmitter 承载 close/error 事件 + 记录式 stdin 承载命令行。 */
class FakeChild extends EventEmitter {
  stdin: { write: (chunk: string) => boolean; destroyed: boolean } | null;
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  /** stdin 收到的全部字节（记录式——读取不消耗，可反复断言累计内容）。 */
  readonly written: string[] = [];

  constructor(opts: { pid?: number; stdinDestroyed?: boolean; stdinNull?: boolean } = {}) {
    super();
    this.stdin = opts.stdinNull === true
      ? null
      : {
          destroyed: opts.stdinDestroyed === true,
          write: (chunk: string): boolean => {
            this.written.push(chunk);
            return true;
          },
        };
    this.pid = opts.pid ?? 4242;
  }

  kill(): boolean {
    return true;
  }
}

/** stdin 已写入的全部命令行（累计、去空行、JSON 解析）。 */
function readStdinLines(child: FakeChild): Array<Record<string, unknown>> {
  return child.written
    .join("")
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0)
    .map((l: string) => JSON.parse(l) as Record<string, unknown>);
}

/** 微任务 + 宏任务各一拍（保证编排链在 dispatch 之后推进到下一步同步写入）。
 *  **禁止在 fake timers 激活时使用**——真实 setTimeout 会被 fake 挂起；fake 窗内
 *  用 `vi.advanceTimersByTimeAsync(0)` 替代。 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const MODEL_A = { provider: "prov-a", modelId: "model-a" };
const MODEL_B = { provider: "prov-b", modelId: "model-b" };

/** 标准 get_state 回读载荷（pi RpcSessionState 形状子集）。 */
function statePayload(provider: string, modelId: string, thinkingLevel: string): unknown {
  return { model: { provider, id: modelId }, thinkingLevel };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── A. setModelOnActiveChild：竞态窗口 + 三型映射 ──

describe("setModelOnActiveChild — 竞态窗口全覆盖（§7.3）", () => {
  const RUN_ID = "rec-race";

  it("定位时无活跃子进程 → not-active（无活进程形态）", async () => {
    const outcome = await setModelOnActiveChild("rec-never-registered", MODEL_B);
    expect(outcome).toEqual({ kind: "not-active" });
  });

  it("定位时已退出（exitCode 已置）→ not-active（定位窗口退出 = 无活进程，非回读失败）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    child.exitCode = 0;
    try {
      const outcome = await setModelOnActiveChild(RUN_ID, MODEL_B);
      expect(outcome).toEqual({ kind: "not-active" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("写入窗口退出（stdin 已毁）→ not-active（投递判别式上浮，不悬挂不误判超时）", async () => {
    const child = new FakeChild({ stdinDestroyed: true });
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const outcome = await setModelOnActiveChild(RUN_ID, MODEL_B);
      expect(outcome).toEqual({ kind: "not-active" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("读应答窗口内退出（close 事件）→ not-active（退出 ≠ 超时，两结局互斥）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await flushAsync();
      child.emit("close", 1, null);
      const outcome = await pending;
      expect(outcome).toEqual({ kind: "not-active" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("存活但读应答超时 → readback-failed(set-model-response)（回读失败形态，非无活进程）", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await vi.advanceTimersByTimeAsync(SET_MODEL_STAGE_TIMEOUT_MS);
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: "readback-failed", stage: "set-model-response" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("超时但窗口内已退出（exit 标志已置、close 未及处理）→ not-active（终检兜住竞态归并）", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await vi.advanceTimersByTimeAsync(0); // fake timers 下推进微任务（替代 flushAsync）
      child.exitCode = 1; // 模拟「超时窗满时进程已死但 close 事件尚未被消费」的竞态形态
      await vi.advanceTimersByTimeAsync(SET_MODEL_STAGE_TIMEOUT_MS);
      const outcome = await pending;
      expect(outcome).toEqual({ kind: "not-active" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });
});

describe("setModelOnActiveChild — pi 错误应答三型映射 + 成功路径", () => {
  const RUN_ID = "rec-map";

  it("set_model 应答 Model not found → model-not-in-snapshot（快照冻结，模型本身有效）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await flushAsync();
      const [cmd] = readStdinLines(child);
      expect(cmd).toMatchObject({ type: "set_model", provider: "prov-b", modelId: "model-b" });
      dispatchControlResponse(cmd["id"] as string, false, undefined, `Model not found: prov-b/model-b`);
      const outcome = await pending;
      expect(outcome).toEqual({
        kind: "model-not-in-snapshot",
        detail: "Model not found: prov-b/model-b",
      });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("set_model 应答 No API key → credential-missing（checkAuth 权威兜底）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await flushAsync();
      const [cmd] = readStdinLines(child);
      dispatchControlResponse(cmd["id"] as string, false, undefined, "No API key for prov-b/model-b");
      const outcome = await pending;
      expect(outcome).toEqual({
        kind: "credential-missing",
        detail: "No API key for prov-b/model-b",
      });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("set_model 应答未知错误消息 → readback-failed（三型词表封闭映射的残余收口：生效状态不可信）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await flushAsync();
      const [cmd] = readStdinLines(child);
      dispatchControlResponse(cmd["id"] as string, false, undefined, "pi internal boom");
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: "readback-failed", stage: "set-model-response" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("成功路径：set_model 成功 → get_state 回读生效值（不信命令应答即真——回读值 ≠ 请求值时以回读为准）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await flushAsync();
      const [setCmd] = readStdinLines(child);
      // 命令应答是意图回显（pi 快照条目）——刻意给一个 ≠ 最终生效值的 data
      dispatchControlResponse(setCmd["id"] as string, true, { provider: "prov-a", id: "model-a" }, undefined);
      await flushAsync();
      const lines = readStdinLines(child);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({ type: "get_state" });
      dispatchControlResponse(lines[1]!["id"] as string, true, statePayload("prov-b", "model-b", "high"), undefined);
      const outcome = await pending;
      expect(outcome).toEqual({
        kind: "switched",
        effectiveModel: { provider: "prov-b", modelId: "model-b" },
        effectiveThinkingLevel: "high",
      });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("set_model 成功后、get_state 窗口内退出 → not-active（回读期间退出行——四窗口同一处置）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await flushAsync();
      const [setCmd] = readStdinLines(child);
      dispatchControlResponse(setCmd["id"] as string, true, { provider: "prov-b", id: "model-b" }, undefined);
      await flushAsync();
      child.emit("close", 0, null);
      const outcome = await pending;
      expect(outcome).toEqual({ kind: "not-active" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("get_state 失败应答 → readback-failed(state-readback)（生效值未知如实报）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await flushAsync();
      const [setCmd] = readStdinLines(child);
      dispatchControlResponse(setCmd["id"] as string, true, { provider: "prov-b", id: "model-b" }, undefined);
      await flushAsync();
      const [, stateCmd] = readStdinLines(child);
      dispatchControlResponse(stateCmd!["id"] as string, false, undefined, "state unavailable");
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: "readback-failed", stage: "state-readback" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("get_state 数据不完整（缺 model/thinkingLevel）→ readback-failed(state-readback)，不虚构生效值", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await flushAsync();
      const [setCmd] = readStdinLines(child);
      dispatchControlResponse(setCmd["id"] as string, true, { provider: "prov-b", id: "model-b" }, undefined);
      await flushAsync();
      const [, stateCmd] = readStdinLines(child);
      dispatchControlResponse(stateCmd!["id"] as string, true, { thinkingLevel: "high" }, undefined);
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: "readback-failed", stage: "state-readback" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("存活但 get_state 回读超时 → readback-failed(state-readback)（回读失败形态，非无活进程）", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = setModelOnActiveChild(RUN_ID, MODEL_B);
      await vi.advanceTimersByTimeAsync(0); // fake timers 下推进微任务（替代 flushAsync）
      const [setCmd] = readStdinLines(child);
      dispatchControlResponse(setCmd["id"] as string, true, { provider: "prov-b", id: "model-b" }, undefined);
      await vi.advanceTimersByTimeAsync(SET_MODEL_STAGE_TIMEOUT_MS);
      const outcome = await pending;
      expect(outcome).toMatchObject({ kind: "readback-failed", stage: "state-readback" });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });
});

// ── B. pi-engine setModel：原始结局 → 协议错误码映射 ──

describe("PiEngine.setModel — 协议错误码映射（U3）", () => {
  const RUN_ID = "rec-engine";
  let engine: PiEngine;

  beforeEach(() => {
    engine = new PiEngine();
  });

  it("capabilities().setModel = 'native'（链路接通后的声明位）", () => {
    expect(engine.capabilities().setModel).toBe("native");
  });

  it("switched 结局 → SetModelResult（生效值 = 回读值）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = engine.setModel({ runId: RUN_ID, model: MODEL_B });
      await flushAsync();
      const [setCmd] = readStdinLines(child);
      dispatchControlResponse(setCmd["id"] as string, true, { provider: "prov-b", id: "model-b" }, undefined);
      await flushAsync();
      const [, stateCmd] = readStdinLines(child);
      dispatchControlResponse(stateCmd!["id"] as string, true, statePayload("prov-b", "model-b", "max"), undefined);
      await expect(pending).resolves.toEqual({
        effectiveModel: { provider: "prov-b", modelId: "model-b" },
        effectiveThinkingLevel: "max",
      });
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("not-active 结局 → error code engine_run_not_active（无活进程形态，非三型失败）", async () => {
    const err = await engine.setModel({ runId: "rec-never-registered", model: MODEL_B }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineSdkError);
    expect((err as EngineSdkError).code).toBe("engine_run_not_active");
  });

  it("model-not-in-snapshot 结局 → error code engine_model_not_in_snapshot（message 含 pi 原文）", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = engine.setModel({ runId: RUN_ID, model: MODEL_B });
      await flushAsync();
      const [setCmd] = readStdinLines(child);
      dispatchControlResponse(setCmd["id"] as string, false, undefined, "Model not found: prov-b/model-b");
      const err = await pending.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EngineSdkError);
      expect((err as EngineSdkError).code).toBe("engine_model_not_in_snapshot");
      expect((err as EngineSdkError).message).toContain("Model not found: prov-b/model-b");
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("credential-missing 结局 → error code engine_credential_missing", async () => {
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      const pending = engine.setModel({ runId: RUN_ID, model: MODEL_B });
      await flushAsync();
      const [setCmd] = readStdinLines(child);
      dispatchControlResponse(setCmd["id"] as string, false, undefined, "No API key for prov-b/model-b");
      const err = await pending.catch((e: unknown) => e);
      expect((err as EngineSdkError).code).toBe("engine_credential_missing");
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });

  it("readback-failed 结局 → error code engine_state_readback_failed（生效值未知如实报）", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    registerActiveChild(RUN_ID, child as unknown as ChildProcess);
    try {
      // catch 在超时触发前挂上（ rejection 发生在 advanceTimers 期间——后挂会被判 unhandled）
      const pending = engine.setModel({ runId: RUN_ID, model: MODEL_B }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(SET_MODEL_STAGE_TIMEOUT_MS);
      const err = await pending;
      expect((err as EngineSdkError).code).toBe("engine_state_readback_failed");
    } finally {
      unregisterActiveChild(RUN_ID, child as unknown as ChildProcess);
    }
  });
});

// ── C. server dispatch：协议一致性 + 声明镜像核对 ──

interface OutFrame { // oe-exempt:20261006:test:测试专用出帧形态断言结构单实现为常态
  id?: number | string;
  result?: unknown;
  error?: { code: string; message: string; recovery: string };
}

function makeSink() {
  const frames: OutFrame[] = [];
  return {
    frames,
    write: (frame: unknown): void => {
      frames.push(frame as OutFrame);
    },
    async waitFor(pred: (f: OutFrame) => boolean, timeoutMs = 2_000): Promise<OutFrame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = frames.find(pred);
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) {
          throw new Error(`frame not observed within ${timeoutMs}ms; frames=${JSON.stringify(frames)}`);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    },
  };
}

describe("server setModel dispatch — 协议一致性（U3）", () => {
  it("引擎 capability 声明非 native → setModel 请求回 engine_capability_unsupported 结构化错误（明确错误而非崩）", async () => {
    const engine = new PiEngine();
    // manifest/实装漂移模拟：声明位翻 unsupported（实装仍在——防御的是声明面）
    vi.spyOn(engine, "capabilities").mockReturnValue({
      ...engine.capabilities(),
      setModel: "unsupported",
    });
    const sink = makeSink();
    const server = new EngineProtocolServer({ write: sink.write, engine });
    server.handleFrame({ id: 7, method: "setModel", params: { runId: "rec-1", model: MODEL_B } });
    const frame = await sink.waitFor((f) => f.id === 7 && f.error !== undefined);
    expect(frame.error?.code).toBe("engine_capability_unsupported");
    expect(frame.error?.message).toContain("setModel");
  });

  it("引擎声明 native 但未实装 setModel 成员（实装漂移）→ engine_run_failed 结构化错误，不崩", async () => {
    const engine = new PiEngine();
    // 摘除成员模拟实装漂移（capabilities 仍 native）
    (engine as { setModel?: unknown }).setModel = undefined;
    const sink = makeSink();
    const server = new EngineProtocolServer({ write: sink.write, engine });
    server.handleFrame({ id: 8, method: "setModel", params: { runId: "rec-1", model: MODEL_B } });
    const frame = await sink.waitFor((f) => f.id === 8 && f.error !== undefined);
    expect(frame.error?.code).toBe("engine_run_failed");
  });

  it("声明点两处镜像同批核对：PiEngine.capabilities().setModel ↔ package.json manifest（guide §3 纪律）", () => {
    // 本文件位于 <pkg>/src/__tests__；manifest 在 <pkg>/package.json
    const manifestPath = join(dirname(dirname(import.meta.dirname)), "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      taiji: { subagentEngine: { capabilities: { setModel: string } } };
    };
    expect(manifest.taiji.subagentEngine.capabilities.setModel).toBe("native");
    expect(new PiEngine().capabilities().setModel).toBe(
      manifest.taiji.subagentEngine.capabilities.setModel,
    );
  });
});
