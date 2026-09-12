// src/__tests__/pi-engine.test.ts
//
// PiEngine（协议化引擎适配器）单元测试。fake spawnRunner + fake ChildProcess——
// 不 spawn 真实子进程（真实 spawn 链路见 run-spawn-once.integration.test.ts）。
// 覆盖验收面：
//   - capabilities 与 package.json manifest 快照逐位一致（同源锚点）；
//   - probe：invocation 可解析 + 版本探测（fake / default execFile）+ 缓存与 force；
//     不可解析（PATH 无 pi）→ checks 反映 + engine_probe_failed recovery；
//   - run 一次性任务：SpawnRunParams 还原（字段透传 / ctxModel 覆盖 / forkSource）、
//     回调接线（onEvent/onHandleReady/onChildSpawned/onDelta/askUser）、
//     EngineHandle + AgentOutcome 应答装配（usage 域映射 / toolCalls 投影）；
//   - run chat 轮（[H1 U3] run 派发形态，续聊 = 新 run + resume 锚点——[H1 U5] 起
//     引擎侧无 interact 面）：chatMode 分派 + resume 锚点透传（--session 穿透）+
//     recordId 锚定 handle；
//   - read 三级降级形态（journal 重放 / outcome-only）、dispose 收割幂等；
//   - dataDir 缺失 → engine_not_found（prepare 期 reject，不产生 handle）。

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineSdkError } from "@zhushanwen/subagent-engine-sdk";

import { PiEngine, type PiEngineDeps } from "../pi-engine.ts";
import type {
  AgentCallOpts,
  RunContext,
} from "../port-types.ts";
import {
  killAllActiveChildren,
  registerActiveChild,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
} from "../spawn-runner.ts";
import { resetAllEpipeFailures } from "../stdin-writer.ts";
import { PI_ADAPTER_VERSION, PI_ENGINE_ID, PI_POOL_KEY } from "../constants.ts";

/** fake 子进程：stdin 写捕获 + EPIPE 注入 + kill 观测（原 chat-session.test 形态，该文件已随 U5 删除）。 */
class FakeChild extends EventEmitter {
  readonly pid = 7331;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];
  readonly stdinWrites: string[] = [];
  epipeMode = false;
  readonly stdin = {
    destroyed: false,
    write: (chunk: string): boolean => {
      this.stdinWrites.push(chunk);
      if (this.epipeMode) {
        throw Object.assign(new Error("write EPIPE: broken"), { code: "EPIPE" });
      }
      return true;
    },
  };

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.kills.push(typeof signal === "number" ? `SIGKILL(${signal})` : signal);
    this.die(null, "SIGTERM");
    return true;
  }

  /** 退出钩子（makeEngine fake runner 挂 onChildStateChanged 收口面）。 */
  onExitHook: (() => void) | undefined;

  die(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.killed = true;
    this.emit("exit", code, signal);
    this.onExitHook?.();
  }
}

/** fake spawnRunner 捕获面。 */
interface Captured {
  params: SpawnRunParams;
  callbacks: SpawnRunCallbacks;
  resolve: (r: SpawnRunResult) => void;
}

function fakeSpawnRunner(children: FakeChild[], captured: Captured[]) {
  return (params: SpawnRunParams, callbacks: SpawnRunCallbacks): Promise<SpawnRunResult> => {
    const child = new FakeChild();
    children.push(child);
    const cap: Captured = { params, callbacks, resolve: () => {} };
    captured.push(cap);
    registerActiveChild(params.recordId, child as unknown as ChildProcess);
    // 对齐真实 executor 收口面：进程 exit → onChildStateChanged(exited) + run resolve
    child.onExitHook = () => {
      callbacks.onChildStateChanged?.({
        pid: child.pid,
        recordId: params.recordId,
        state: "exited",
        killed: child.killed,
        ...(child.exitCode !== null ? { exitCode: child.exitCode } : {}),
        ...(child.signalCode !== null ? { signal: child.signalCode } : {}),
      });
      cap.resolve(spawnRunResult());
    };
    return new Promise<SpawnRunResult>((resolve) => {
      cap.resolve = resolve;
    });
  };
}

function spawnRunResult(overrides: Partial<SpawnRunResult> = {}): SpawnRunResult {
  return {
    content: "done",
    turns: 2,
    durationMs: 12,
    success: true,
    error: undefined,
    sessionId: "sess-e1",
    sessionFile: "/tmp/sess-e1.jsonl",
    toolCalls: [],
    parsedOutput: undefined,
    usage: undefined,
    failureKind: undefined,
    ...overrides,
  };
}

interface Harness {
  engine: PiEngine;
  children: FakeChild[];
  captured: Captured[];
}

function makeEngine(deps: PiEngineDeps = {}): Harness {
  const children: FakeChild[] = [];
  const captured: Captured[] = [];
  const engine = new PiEngine({
    dataDir: "/tmp/engine-data",
    spawnRunner: fakeSpawnRunner(children, captured),
    ...deps,
  });
  return { engine, children, captured };
}

const baseTask: AgentCallOpts = { prompt: "do things" };
const baseCtx: RunContext = { taskId: "run-e1", poolKey: PI_POOL_KEY };

/** 驱动 fake executor 的标准回调序列并 resolve（askUser 可选触发）。 */
async function settleRun(cap: Captured, result: SpawnRunResult, opts: { askUser?: boolean } = {}): Promise<void> {
  cap.callbacks.onEvent?.({ type: "turn_end" });
  cap.callbacks.onHandleReady?.({ sessionRef: { sessionId: "sess-e1" }, poolKey: PI_POOL_KEY });
  cap.callbacks.onChildSpawned?.(4321, cap.params.recordId);
  cap.callbacks.onDelta?.("stream-chunk");
  if (opts.askUser) await cap.callbacks.askUser?.({ method: "select", id: "ui-1", title: "pick", options: ["a", "b"] });
  cap.resolve(result);
  await Promise.resolve();
}

afterEach(() => {
  killAllActiveChildren();
  resetAllEpipeFailures();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PiEngine.capabilities", () => {
  it("与 package.json manifest 的 capabilities 快照逐位一致（同源锚点）", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8") as string,
    ) as { "xyz-agent"?: { subagentEngine?: { capabilities?: Record<string, unknown> } } };
    const manifestCaps = pkg["xyz-agent"]?.subagentEngine?.capabilities;
    expect(manifestCaps).toBeDefined();
    const { engine } = makeEngine();
    expect(engine.capabilities()).toEqual(manifestCaps);
  });
});

describe("PiEngine.probe", () => {
  it("invocation 可解析 + 版本探测成功 → ok 报告（缓存复用，force 才重探）", async () => {
    let probeCalls = 0;
    const { engine } = makeEngine({
      probeVersion: () => {
        probeCalls += 1;
        return Promise.resolve("pi 0.84.4");
      },
    });

    const first = await engine.probe();
    expect(first.ok).toBe(true);
    expect(first.engineVersion).toBe("pi 0.84.4");
    expect(first.checks.map((c) => c.name)).toEqual(["invocation", "version"]);
    expect(first.error).toBeUndefined();

    // 缓存：不重探
    const cached = await engine.probe();
    expect(cached).toBe(first);
    expect(probeCalls).toBe(1);

    // force：重探
    const forced = await engine.probe({ force: true });
    expect(forced).not.toBe(first);
    expect(probeCalls).toBe(2);
  });

  it("版本探测返回空 → version check fail → ok:false + engine_probe_failed recovery", async () => {
    const { engine } = makeEngine({ probeVersion: () => Promise.resolve("") });
    const report = await engine.probe();
    expect(report.ok).toBe(false);
    expect(report.engineVersion).toBe("");
    expect(report.checks.find((c) => c.name === "version")?.ok).toBe(false);
    expect(report.error?.code).toBe("engine_probe_failed");
    expect(report.error?.recovery).toContain("--version");
  });

  it("default 探测器：fake pi 可执行脚本 → execFile 成功解析首行", async () => {
    const binDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-probe-bin-"));
    const piPath = join(binDir, "pi");
    fs.writeFileSync(piPath, "#!/bin/sh\necho 'pi 9.9.9-fake'\n");
    fs.chmodSync(piPath, 0o755);
    const savedPath = process.env.PATH;
    const savedArgv1 = process.argv[1];
    try {
      // argv[1] 摘除 → getPiInvocation 落 PATH 分支（command "pi"）；PATH 指向 fake bin
      process.argv[1] = undefined as unknown as string;
      process.env.PATH = binDir;
      const { engine } = makeEngine();
      const report = await engine.probe({ force: true });
      expect(report.ok).toBe(true);
      expect(report.engineVersion).toBe("pi 9.9.9-fake");
    } finally {
      process.env.PATH = savedPath;
      process.argv[1] = savedArgv1;
      fs.rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("default 探测器失败（pi 不可执行）→ best-effort undefined → probe fail；PATH 无 pi → invocation fail", async () => {
    const binDir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-probe-bad-"));
    // 非可执行文件：isInvocationResolvable 的 existsSync 判真，但 execFile 失败
    fs.writeFileSync(join(binDir, "pi"), "not executable");
    const savedPath = process.env.PATH;
    const savedArgv1 = process.argv[1];
    try {
      process.argv[1] = undefined as unknown as string;
      process.env.PATH = binDir;
      const { engine } = makeEngine();
      const report = await engine.probe({ force: true });
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => c.name === "invocation")?.ok).toBe(true);
      expect(report.checks.find((c) => c.name === "version")?.ok).toBe(false);

      // PATH 摘空：invocation 不可解析（detail 含期望恢复动作）
      process.env.PATH = "";
      const unreachable = await engine.probe({ force: true });
      expect(unreachable.ok).toBe(false);
      const invocationCheck = unreachable.checks.find((c) => c.name === "invocation");
      expect(invocationCheck?.ok).toBe(false);
      expect(invocationCheck?.detail).toContain("cannot resolve pi executable");
      expect(unreachable.checks).toHaveLength(1);
    } finally {
      process.env.PATH = savedPath;
      process.argv[1] = savedArgv1;
      fs.rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe("PiEngine.run（一次性任务形态）", () => {
  it("dataDir 缺失（显式空 + env 摘除）→ engine_not_found reject，不进 spawn", async () => {
    vi.stubEnv("XYZ_AGENT_DATA_DIR", "");
    const { engine, captured } = makeEngine({ dataDir: "" });
    await expect(engine.run(baseTask, baseCtx)).rejects.toMatchObject({
      code: "engine_not_found",
    });
    expect(captured).toHaveLength(0);
  });

  it("params 还原全字段透传 + ctxModel 覆盖 model + poolKey 上报 + 应答装配", async () => {
    const { engine, captured } = makeEngine();
    const events: unknown[] = [];
    const handleReady: unknown[] = [];
    const childSpawned: unknown[] = [];
    const deltas: string[] = [];
    const pools: string[] = [];
    const signal = new AbortController().signal;

    const runP = engine.run(
      {
        prompt: "full fields",
        description: "desc-agent",
        model: "fallback/provider",
        thinkingLevel: "high",
        schemaEnv: "{}",
        maxTurns: 5,
        graceTurns: 1,
        skillPath: "/skills/x",
        appendSystemPrompt: ["extra prompt"],
        forkSource: "/tmp/fork-source.jsonl",
      },
      {
        taskId: "run-full",
        poolKey: PI_POOL_KEY,
        signal,
        ctxModel: { id: "m1", provider: "prov" },
        stream: { onDelta: (d) => deltas.push(d) },
        onEvent: (e) => events.push(e),
        onHandleReady: (p) => handleReady.push(p),
        onChildSpawned: (c) => childSpawned.push(c),
        onPoolResolved: (p) => pools.push(p),
        sessionRootId: "root-sess-f6",
      },
    );

    const cap = captured[0]!;
    expect(pools).toEqual([PI_POOL_KEY]);
    expect(cap.params).toMatchObject({
      recordId: "run-full",
      task: "full fields",
      agentName: "desc-agent",
      model: "prov/m1",
      thinkingLevel: "high",
      schemaEnv: "{}",
      maxTurns: 5,
      graceTurns: 1,
      skillPaths: ["/skills/x"],
      appendSystemPrompt: ["extra prompt"],
      forkSource: "/tmp/fork-source.jsonl",
      sessionRootId: "root-sess-f6",
      signal,
      // [LEGACY fallback] ctx.sessionDir 缺省 → 旧推导 <dataDir>/subagents/sessions/
      // <encoded(cwd)>（cwd 未传 = process.cwd()）；权威 = 宿主注入（见下方优先用例）
      sessionDir: join("/tmp/engine-data", "subagents", "sessions", process.cwd().replace(/[^a-zA-Z0-9_-]+/g, "_")),
    });
    expect(cap.params.chatMode).toBeUndefined();

    await settleRun(
      cap,
      spawnRunResult({
        toolCalls: [
          { toolName: "read_file", args: { path: "a.txt" }, result: { content: [] } },
          { toolName: "no_args_tool" },
        ],
        usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: 0.7 },
      }),
      { askUser: false },
    );
    const { handle, outcome } = await runP;

    // handle 装配（W1 契约：v1 + recordId 锚 + adapterVersion）
    expect(handle.data).toEqual({
      v: 1,
      engineId: PI_ENGINE_ID,
      sessionRef: { recordId: "run-full", sessionId: "sess-e1", sessionFile: "/tmp/sess-e1.jsonl" },
      poolKey: PI_POOL_KEY,
      adapterVersion: PI_ADAPTER_VERSION,
    });

    // 回调接线
    expect(events.map((e) => (e as { type: string }).type)).toEqual(["turn_end"]);
    expect(handleReady).toEqual([{ sessionRef: { sessionId: "sess-e1" }, poolKey: PI_POOL_KEY }]);
    expect(childSpawned).toEqual([{ pid: 4321, killed: false }]);
    expect(deltas).toEqual(["stream-chunk"]);

    // outcome 映射（usage 域 + toolCalls 投影；AgentOutcome 无 success 字段——
    // 失败经 error/failureKind 表达）
    expect(outcome).toMatchObject({
      content: "done",
      durationMs: 12,
      sessionId: "sess-e1",
      sessionFile: "/tmp/sess-e1.jsonl",
      engineId: PI_ENGINE_ID,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        cost: 0.7,
        contextTokens: 130,
        turns: 2,
      },
      toolCalls: [
        { name: "read_file", input: JSON.stringify({ path: "a.txt" }) },
        { name: "no_args_tool", input: "" },
      ],
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.failureKind).toBeUndefined();
  });

  it("agentName 回落链 description → agent → workflow-agent；失败结果分诊透传", async () => {
    const { engine, captured } = makeEngine();
    const runP = engine.run({ prompt: "x" }, { taskId: "run-fb", poolKey: PI_POOL_KEY });
    expect(captured[0]!.params.agentName).toBe("workflow-agent");
    // [F6] ctx.sessionRootId 缺省 → SpawnRunParams 不挂键（additive 语义，one-shot 形态）
    expect(captured[0]!.params).not.toHaveProperty("sessionRootId");
    await settleRun(
      captured[0]!,
      spawnRunResult({
        success: false,
        error: "agent aborted by kill chain",
        failureKind: "stale_context",
      }),
    );
    const { outcome } = await runP;
    expect(outcome.error).toBe("agent aborted by kill chain");
    expect(outcome.failureKind).toBe("stale_context");
    expect(outcome.usage).toBeUndefined();

    // agent 字段兜底（description 缺失）
    const runP2 = engine.run({ prompt: "y", agent: "/agents/a.md" }, { taskId: "run-fb2", poolKey: PI_POOL_KEY });
    expect(captured[1]!.params.agentName).toBe("/agents/a.md");
    await settleRun(captured[1]!, spawnRunResult());
    await runP2;
  });

  it("[Option C] ctx.sessionDir 优先——引擎不再自推导（宿主权威 getSubagentSessionDir 值直通 --session-dir）", async () => {
    const { engine, captured } = makeEngine();
    const hostAuthoritative = "/host/agent-dir/subagents/--Users-x-proj--/sessions";
    const runP = engine.run(
      { prompt: "sessionDir priority" },
      { taskId: "run-sd-priority", poolKey: PI_POOL_KEY, sessionDir: hostAuthoritative },
    );
    // ctx.sessionDir 有值 → 原样直通（[LEGACY] fallback 不参与——即使其推导值不同）
    expect(captured[0]!.params.sessionDir).toBe(hostAuthoritative);
    await settleRun(captured[0]!, spawnRunResult());
    await runP;
  });

  it("bindAskUser 注入后 run 回调 askUser 转发 host handler", async () => {
    const { engine, captured } = makeEngine();
    const asked: string[] = [];
    engine.bindAskUser(async (req) => {
      asked.push(req.title ?? "");
      return { value: "picked" };
    });
    const runP = engine.run(baseTask, { ...baseCtx });
    const answer = await captured[0]!.callbacks.askUser?.({ method: "select", id: "ui-2", title: "q", options: ["a"] });
    expect(answer).toEqual({ value: "picked" });
    expect(asked).toEqual(["q"]);
    await settleRun(captured[0]!, spawnRunResult());
    await runP;
  });
});

describe("PiEngine.run（会话形态轮 run 派发形态）", () => {
  it("会话形态轮：recordId 锚定 + resume 锚点透传（--session 穿透）+ chatMode 分派，不经 ChatSessionRegistry", async () => {
    const { engine, captured } = makeEngine();
    const runP = engine.run(
      { prompt: "chat turn" },
      {
        taskId: "run-chat-1",
        poolKey: PI_POOL_KEY,
        sessionRootId: "root-sess-f6",
        resume: {
          recordId: "rec-chat-9",
          resume: { sessionRef: { recordId: "rec-chat-9", sessionFile: "/tmp/sess-c9.jsonl" }, poolKey: PI_POOL_KEY },
        },
      },
    );
    const cap = captured[0]!;
    expect(cap.params).toMatchObject({
      recordId: "rec-chat-9",
      task: "chat turn",
      // [H1 U3] 会话形态轮 = run 派发形态：chatMode 仅作 spawn-runner 的 agent_settled
      // resolve+收割分派（D7），不再经 ChatSessionRegistry.startRound
      chatMode: true,
      resumeSessionFile: "/tmp/sess-c9.jsonl",
      sessionRootId: "root-sess-f6",
      // [LEGACY fallback] ctx.sessionDir 缺省 → 旧推导不变（LEGACY 语义锁定）
      sessionDir: join("/tmp/engine-data", "subagents", "sessions", process.cwd().replace(/[^a-zA-Z0-9_-]+/g, "_")),
    });
    expect(cap.params.agentName).toBe("chat-agent");

    // 会话形态轮回调：onEvent / onHandleReady / onChildSpawned / onChildStateChanged
    // 全走 ctx 直通（与 one-shot 共用 buildRunCallbacks）
    cap.callbacks.onEvent?.({ type: "turn_end" });
    cap.callbacks.onHandleReady?.({ sessionRef: { sessionFile: "/tmp/sess-c9.jsonl" }, poolKey: PI_POOL_KEY });
    cap.callbacks.onChildSpawned?.(555, "rec-chat-9");

    // per-run askUser 绑定：bindAskUser 未注入时无 askUser 回调
    // （chat 会话级固定绑定随 registry 解耦退役）
    expect(cap.callbacks.askUser).toBeUndefined();

    cap.resolve(spawnRunResult({ sessionId: "sess-c9", sessionFile: "/tmp/sess-c9.jsonl" }));
    await Promise.resolve();
    const { handle, outcome } = await runP;
    // 会话形态轮 handle 以 recordId 锚定（非 runId）
    expect(handle.data.sessionRef.recordId).toBe("rec-chat-9");
    expect(outcome.content).toBe("done");
  });

  it("会话形态轮无 resume 锚点（首轮新建）→ resumeSessionFile 不挂键", async () => {
    const { engine, captured } = makeEngine();
    const runP = engine.run({ prompt: "first" }, {
      taskId: "run-chat-2",
      poolKey: PI_POOL_KEY,
      resume: { recordId: "rec-new" },
    });
    expect(captured[0]!.params.resumeSessionFile).toBeUndefined();
    expect(captured[0]!.params.chatMode).toBe(true);
    // [F6] ctx.sessionRootId 缺省 → SpawnRunParams 不挂键（additive 语义）
    expect(captured[0]!.params).not.toHaveProperty("sessionRootId");
    await settleRun(captured[0]!, spawnRunResult());
    const { handle } = await runP;
    expect(handle.data.sessionRef.recordId).toBe("rec-new");
  });

  it("会话形态轮 bindAskUser 注入后回调转发 host handler（per-run 绑定与 one-shot 同构）", async () => {
    const { engine, captured } = makeEngine();
    const asked: string[] = [];
    engine.bindAskUser(async (req) => {
      asked.push(req.title ?? "");
      return { value: "picked" };
    });
    const runP = engine.run({ prompt: "chat" }, {
      taskId: "run-chat-ask",
      poolKey: PI_POOL_KEY,
      resume: { recordId: "rec-ask" },
    });
    const answer = await captured[0]!.callbacks.askUser?.({ method: "select", id: "ui-4", title: "q", options: ["a"] });
    expect(answer).toEqual({ value: "picked" });
    expect(asked).toEqual(["q"]);
    await settleRun(captured[0]!, spawnRunResult());
    await runP;
  });
});

// [H1 U5] PiEngine.interact 三分派用例族（message 投递 / close / cancel / 冷路径 /
// EPIPE 兜底 / chat 轮 run 域分支过渡兼容面）已随 interact 方法退役删除：
//   - 续聊投递的 run 通道形态覆盖 = 上方「PiEngine.run（chat 轮 run 派发形态）」
//     （resume 锚点透传 + chatMode 分派 + recordId 锚定 handle）；
//   - EPIPE 兜底语义由 stdin-writer.test（writeStdinLine EPIPE 检测）单元直测；
//   - cancel/abort 通道 = run 域 cancel 帧（server AbortController → signal），
//     server.test cancel 用例覆盖；
//   - 收割链（agent_settled resolve + 杀链）由 run-spawn-once.integration 覆盖。
describe("PiEngine.read / dispose", () => {
  it("journalPath 在 → ②级 journal 重放（source journal）；不在 → ③级 outcome-only", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-engine-read-"));
    try {
      const journalPath = join(dir, "journal.jsonl");
      fs.writeFileSync(
        journalPath,
        [
          JSON.stringify({ type: "text_delta", delta: "replayed" }),
          JSON.stringify({ type: "turn_end" }),
        ].join("\n"),
      );
      const { engine } = makeEngine();
      const journaled = await engine.read({
        data: {
          v: 1,
          engineId: PI_ENGINE_ID,
          sessionRef: { recordId: "rec-r1", sessionId: "sess-r1", sessionFile: "/tmp/sess-r1.jsonl" },
          poolKey: PI_POOL_KEY,
          journalPath,
          adapterVersion: PI_ADAPTER_VERSION,
        },
      });
      expect(jouredSource(journaled)).toBe("journal");
      expect(journaled.sessionId).toBe("sess-r1");
      expect(journaled.turns[0]?.text).toBe("replayed");

      const outcomeOnly = await engine.read({
        data: { v: 1, engineId: PI_ENGINE_ID, sessionRef: { recordId: "rec-r2" }, poolKey: PI_POOL_KEY, adapterVersion: PI_ADAPTER_VERSION },
      });
      expect(outcomeOnly).toEqual({ engineId: PI_ENGINE_ID, turns: [], source: "outcome-only" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("dispose：全量收割活跃子进程 + EPIPE 计数清空（幂等）", async () => {
    const { engine } = makeEngine();
    const child = new FakeChild();
    registerActiveChild("rec-dispose", child as unknown as ChildProcess);

    await engine.dispose();
    expect(child.kills).toEqual(["SIGTERM"]);

    // 幂等：二次 dispose 不抛
    await engine.dispose();
  });
});

/** SessionView source 提取（窄化助手）。 */
function jouredSource(view: { source: string }): string {
  return view.source;
}
