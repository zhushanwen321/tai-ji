// constants.test.ts —— pi-subagent-cli C07 簇合并产物（round5-G）。
// 共同被测业务模块：`src/constants.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/pi-engine.test.ts（19 用例，skip 0）
//   - src/__tests__/schema-arming.test.ts（9 用例，skip 0）
//   - src/__tests__/server.test.ts（29 用例，skip 0）

import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as os from 'node:os'
import { join } from 'node:path'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { EngineSdkError, ENGINE_PROTOCOL_VERSION, type AgentEvent, type EngineCapabilities, type EngineHandleData, type InitializeParams, type ProbeReport, type SessionView, type UiRequest, type UiResponse } from '@zhushanwen/subagent-engine-sdk'
import { PiEngine, type PiEngineDeps } from '../pi-engine.ts'
import { type AgentCallOpts, type RunContext, type EnginePort, type EngineRunResult } from '../port-types.ts'
import { killAllActiveChildren, registerActiveChild, type SpawnRunCallbacks, type SpawnRunParams, type SpawnRunResult, assertSchemaEnforcementArmed, type SchemaArmingInput } from '../spawn-runner.ts'
import { PI_ADAPTER_VERSION, PI_ENGINE_ID, SCHEMA_ENV_VAR } from '../constants.ts'
import { randomUUID } from 'node:crypto'
import { EngineProtocolServer } from '../server.ts'

// ======== 来源：pi-engine.test.ts ========
describe("pi-engine", () => {
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

    /** 退出钩子（makeEngine fake runner 挂 onChildStateChanged 收敛点）。 */
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

  /** fake spawnRunner 捕获点。 */
  interface Captured { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
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
      // 对齐真实 executor 收敛点：进程 exit → onChildStateChanged(exited) + run resolve
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

  interface Harness { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
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

  /** 测试宿主注入的权威 sessionDir（ctx.sessionDir 缺失即 fail-fast，直构 ctx 必带）。 */
  const HOST_SESSION_DIR = "/host/agent-dir/subagents/test-proj/sessions";

  const baseCtx: RunContext = { taskId: "run-e1", sessionDir: HOST_SESSION_DIR };

  /** 驱动 fake executor 的标准回调序列并 resolve（askUser 可选触发）。 */
  async function settleRun(cap: Captured, result: SpawnRunResult, opts: { askUser?: boolean } = {}): Promise<void> {
    cap.callbacks.onEvent?.({ type: "turn_end" });
    cap.callbacks.onHandleReady?.({ sessionRef: { sessionId: "sess-e1" }});
    cap.callbacks.onChildSpawned?.(4321, cap.params.recordId);
    cap.callbacks.onDelta?.("stream-chunk");
    if (opts.askUser) await cap.callbacks.askUser?.({ method: "select", id: "ui-1", title: "pick", options: ["a", "b"] });
    cap.resolve(result);
    await Promise.resolve();
  }

  afterEach(() => {
    killAllActiveChildren();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("PiEngine.capabilities", () => {
    it("与 package.json manifest 的 capabilities 快照逐位一致（同源锚点）", async () => {
      const { readFileSync } = await import("node:fs");
      const pkg = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8") as string,
      ) as { "taiji"?: { subagentEngine?: { capabilities?: Record<string, unknown> } } };
      const manifestCaps = pkg["taiji"]?.subagentEngine?.capabilities;
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
      vi.stubEnv("TAIJI_AGENT_DATA_DIR", "");
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
      // [D1] schema 以本体形态透传（wire task.schema 单字段承载）
      const fullFieldsSchema = { type: "object", properties: { result: { type: "string" } } };

      const runP = engine.run(
        {
          prompt: "full fields",
          description: "desc-agent",
          model: "fallback/provider",
          thinkingLevel: "high",
          schema: fullFieldsSchema,
          maxTurns: 5,
          graceTurns: 1,
          skillPath: "/skills/x",
          appendSystemPrompt: ["extra prompt"],
          forkSource: "/tmp/fork-source.jsonl",
        },
        {
          taskId: "run-full",
          sessionDir: HOST_SESSION_DIR,
          signal,
          ctxModel: { id: "m1", provider: "prov" },
          stream: { onDelta: (d) => deltas.push(d) },
          onEvent: (e) => events.push(e),
          onHandleReady: (p) => handleReady.push(p),
          onChildSpawned: (c) => childSpawned.push(c),
          sessionRootId: "root-sess-f6",
        },
      );

      const cap = captured[0]!;
      expect(cap.params).toMatchObject({
        recordId: "run-full",
        task: "full fields",
        agentName: "desc-agent",
        model: "prov/m1",
        thinkingLevel: "high",
        schema: fullFieldsSchema,
        maxTurns: 5,
        graceTurns: 1,
        skillPaths: ["/skills/x"],
        appendSystemPrompt: ["extra prompt"],
        forkSource: "/tmp/fork-source.jsonl",
        sessionRootId: "root-sess-f6",
        signal,
        // [Option C] ctx.sessionDir 宿主注入值直通（引擎不自推导）
        sessionDir: HOST_SESSION_DIR,
      });

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
        adapterVersion: PI_ADAPTER_VERSION,
      });

      // 回调接线
      expect(events.map((e) => (e as { type: string }).type)).toEqual(["turn_end"]);
      expect(handleReady).toEqual([{ sessionRef: { sessionId: "sess-e1" }}]);
      expect(childSpawned).toEqual([{ pid: 4321, killed: false }]);
      expect(deltas).toEqual(["stream-chunk"]);

      // outcome 映射（usage 域 + toolCalls 派生视图；AgentOutcome 无 success 字段——
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

    it("[D1] task.schema 本体直通 SpawnRunParams.schema（env 字符串字段已退役，不跨层）", async () => {
      const { engine, captured } = makeEngine();
      const schema = {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
      } as Record<string, unknown>;
      const runP = engine.run({ prompt: "structured", schema }, { ...baseCtx, taskId: "run-schema" });
      // schema 以本体（对象引用）透传——派生 env 是 spawn-runner 的职责，引擎适配层
      // 不预序列化（PI_WORKFLOW_SCHEMA 值 = spawn 期 JSON.stringify 本体，逐字节
      // 等值断言见 run-spawn-once.integration 的真实 spawn 链用例）
      expect(captured[0]!.params.schema).toEqual(schema);
      // 负向断言：传输态 env 字符串字段已退役（防字段名复活）
      expect(captured[0]!.params).not.toHaveProperty("schemaEnv");
      await settleRun(captured[0]!, spawnRunResult());
      const { outcome } = await runP;
      expect(outcome.error).toBeUndefined();
    });

    it("[D1] task.schema 缺省 → SpawnRunParams 不挂键（无 schema run 零行为变化）", async () => {
      const { engine, captured } = makeEngine();
      const runP = engine.run(baseTask, baseCtx);
      expect(captured[0]!.params).not.toHaveProperty("schema");
      await settleRun(captured[0]!, spawnRunResult());
      const { outcome } = await runP;
      expect(outcome.error).toBeUndefined();
    });

    it("agentName 回落链 description → agent → workflow-agent；失败结果分诊透传", async () => {
      const { engine, captured } = makeEngine();
      const runP = engine.run({ prompt: "x" }, { ...baseCtx, taskId: "run-fb" });
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
      const runP2 = engine.run({ prompt: "y", agent: "/agents/a.md" }, { ...baseCtx, taskId: "run-fb2" });
      expect(captured[1]!.params.agentName).toBe("/agents/a.md");
      await settleRun(captured[1]!, spawnRunResult());
      await runP2;
    });

    it("[Option C] ctx.sessionDir 宿主注入值直通 --session-dir（引擎不自推导）", async () => {
      const { engine, captured } = makeEngine();
      const hostAuthoritative = "/host/agent-dir/subagents/--Users-x-proj--/sessions";
      const runP = engine.run(
        { prompt: "sessionDir priority" },
        { taskId: "run-sd-priority", sessionDir: hostAuthoritative },
      );
      // ctx.sessionDir 原样直通（引擎无自推导 fallback——推导目录落宿主扫描根外，
      // 缺失即 fail-fast，见下方缺失用例）
      expect(captured[0]!.params.sessionDir).toBe(hostAuthoritative);
      await settleRun(captured[0]!, spawnRunResult());
      await runP;
    });

    it("[subagent-observability §3.3.1/§3.3.3] 收尾事实字段透传：promptDisposition / observations / engineStopReason / retryAttempts", async () => {
      const { engine, captured } = makeEngine();
      const runP = engine.run({ prompt: "handled round" }, { ...baseCtx, taskId: "run-disposition" });
      await settleRun(
        captured[0]!,
        spawnRunResult({
          // 被接管轮形态（P6-A）：无停因 + 接管标注 + 观察事实（无 usage——零执行）
          promptDisposition: "handled",
          observations: ["structured output was never called"],
          usage: undefined,
          turns: 0,
        }),
      );
      const { outcome } = await runP;
      // [F1-33/F1-40] promptDisposition 透传（引擎产出 → 协议应答，宿主轮收条数据源）
      expect(outcome.promptDisposition).toBe("handled");
      // [F1-34] observations 透传
      expect(outcome.observations).toEqual(["structured output was never called"]);
      expect(outcome.engineStopReason).toBeUndefined();
      expect(outcome.retryAttempts).toBeUndefined();

      // 失败轮形态：engineStopReason + retryAttempts 透传（>0 才落键的既有判据）
      const runP2 = engine.run({ prompt: "failed round" }, { ...baseCtx, taskId: "run-stop" });
      await settleRun(
        captured[1]!,
        spawnRunResult({
          engineStopReason: "aborted",
          retryAttempts: 2,
          success: false,
          error: "engine reported error without message text",
        }),
      );
      const { outcome: outcome2 } = await runP2;
      expect(outcome2.engineStopReason).toBe("aborted");
      expect(outcome2.retryAttempts).toBe(2);
      expect(outcome2.promptDisposition).toBeUndefined();
      expect(outcome2.observations).toBeUndefined();
    });

    it("ctx.sessionDir 缺失 → engine_not_found fail-fast（附宿主接线恢复指引），不进 spawn", async () => {
      const { engine, captured } = makeEngine();
      const ctx: RunContext = { taskId: "run-sd-missing" };
      await expect(engine.run(baseTask, ctx)).rejects.toMatchObject({
        code: "engine_not_found",
      });
      await expect(engine.run(baseTask, ctx)).rejects.toThrow(/ctx\.sessionDir/);
      expect(captured).toHaveLength(0);
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
    it("会话形态轮：recordId 锚定 + resume 锚点透传（--session 穿透），不经 ChatSessionRegistry", async () => {
      const { engine, captured } = makeEngine();
      const runP = engine.run(
        { prompt: "chat turn" },
        {
          taskId: "run-chat-1",
          sessionDir: HOST_SESSION_DIR,
          sessionRootId: "root-sess-f6",
          resume: {
            recordId: "rec-chat-9",
            resume: { sessionRef: { recordId: "rec-chat-9", sessionFile: "/tmp/sess-c9.jsonl" }},
          },
        },
      );
      const cap = captured[0]!;
      expect(cap.params).toMatchObject({
        recordId: "rec-chat-9",
        task: "chat turn",
        // [H1 U3] 会话形态轮 = run 派发形态（agent_settled resolve+收割是引擎内建
        // 唯一语义，[modeless 波2] 无 per-run 形态参数），不经 ChatSessionRegistry.startRound
        resumeSessionFile: "/tmp/sess-c9.jsonl",
        sessionRootId: "root-sess-f6",
        // [Option C] ctx.sessionDir 宿主注入值直通（引擎不自推导）
        sessionDir: HOST_SESSION_DIR,
      });
      expect(cap.params.agentName).toBe("chat-agent");

      // 会话形态轮回调：onEvent / onHandleReady / onChildSpawned / onChildStateChanged
      // 全走 ctx 直通（与 one-shot 共用 buildRunCallbacks）
      cap.callbacks.onEvent?.({ type: "turn_end" });
      cap.callbacks.onHandleReady?.({ sessionRef: { sessionFile: "/tmp/sess-c9.jsonl" }});
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
      const runP = engine.run({ prompt: "first" }, { ...baseCtx, taskId: "run-chat-2", resume: { recordId: "rec-new" } });
      expect(captured[0]!.params.resumeSessionFile).toBeUndefined();
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
        ...baseCtx,
        taskId: "run-chat-ask",
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
  // EPIPE 兜底 / chat 轮 run 域分支过渡兼容范围）已随 interact 方法退役删除：
  //   - 续聊投递的 run 通道形态覆盖 = 上方「PiEngine.run（chat 轮 run 派发形态）」
  //     （resume 锚点透传 + recordId 锚定 handle；[modeless 波2] 轮终形态为引擎内建）；
  //   - EPIPE 兜底语义由 stdin-writer.test（writeStdinLine EPIPE 检测）单元直测；
  //   - cancel/abort 通道 = run 域 cancel 帧（server AbortController → signal），
  //     server.test cancel 用例覆盖；
  //   - 收割链（agent_settled resolve + 杀链）由 run-spawn-once.integration 覆盖。
  describe("PiEngine.read / dispose", () => {
    it("eventsPath 在 → ②级 journal 重放（source journal）；不在 → ③级 outcome-only", async () => {
      const dir = fs.mkdtempSync(join(tmpdir(), "pi-cli-test-engine-read-"));
      try {
        const eventsPath = join(dir, "journal.jsonl");
        fs.writeFileSync(
          eventsPath,
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
              eventsPath,
            adapterVersion: PI_ADAPTER_VERSION,
          },
        });
        expect(jouredSource(journaled)).toBe("journal");
        expect(journaled.sessionId).toBe("sess-r1");
        expect(journaled.turns[0]?.text).toBe("replayed");

        const outcomeOnly = await engine.read({
          data: { v: 1, engineId: PI_ENGINE_ID, sessionRef: { recordId: "rec-r2" }, adapterVersion: PI_ADAPTER_VERSION },
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
      // ADR-0122 防御清理：杀链 SIGKILL 直杀（原「SIGTERM → 30s grace → SIGKILL」退役）
      expect(child.kills).toEqual(["SIGKILL"]);

      // 幂等：二次 dispose 不抛
      await engine.dispose();
    });
  });

  /** SessionView source 提取（窄化助手）。 */
  function jouredSource(view: { source: string }): string {
    return view.source;
  }
});

// ======== 来源：schema-arming.test.ts ========
describe("schema-arming", () => {
  const SCHEMA = { type: "object", properties: { answer: { type: "number" } } } as const;

  const STRUCTURED_OUTPUT_DIR = "/x/node_modules/@zhushanwen/pi-structured-output";

  const STRUCTURED_OUTPUT_ENTRY = "/x/node_modules/@zhushanwen/pi-structured-output/index.js";

  /** 全武装基线：native + schema + env 已派生 + --extension 含 structured-output。 */
  function armedInput(overrides: Partial<SchemaArmingInput> = {}): SchemaArmingInput {
    return {
      schemaEnforcement: "native",
      schema: SCHEMA,
      childEnv: { [SCHEMA_ENV_VAR]: JSON.stringify(SCHEMA) },
      spawnArgs: ["--extension", STRUCTURED_OUTPUT_DIR, "--no-extensions"],
      ...overrides,
    };
  }

  function messageOf(fn: () => void): string {
    try {
      fn();
    } catch (err) {
      if (err instanceof Error) return err.message;
      throw err;
    }
    throw new Error("expected fn to throw, but it resolved");
  }

  describe("assertSchemaEnforcementArmed — [D3 止血版] 武装断言", () => {
    it("断言①：native + schema 任务 + PI_WORKFLOW_SCHEMA 未派生进 env → 抛引擎侧派生漂移错误", () => {
      const msg = messageOf(() =>
        assertSchemaEnforcementArmed(
          armedInput({ childEnv: {}, spawnArgs: ["--extension", STRUCTURED_OUTPUT_DIR] }),
        ),
      );
      expect(msg).toContain("[schema-arming]");
      expect(msg).toContain(SCHEMA_ENV_VAR);
      // 引擎侧归因（非宿主配置错误）+ 可操作恢复动作
      expect(msg).toContain("engine-side derivation drift");
      expect(msg).toContain("Recovery:");
    });

    it("断言②（验收 a）：native + schema 任务 + 扩展缺席 → 错误文本含双形态恢复指引", () => {
      const msg = messageOf(() =>
        assertSchemaEnforcementArmed(armedInput({ spawnArgs: ["--no-extensions"] })),
      );
      // taiji 宿主形态 → extension-service 诊断
      expect(msg).toContain("extension-service");
      // 独立形态 → 安装 peerDependency 或改用无 schema workflow（D2 行为变更声明文案）
      expect(msg).toContain("install @zhushanwen/pi-structured-output (peerDependency)");
      expect(msg).toContain("schema-less workflow");
      expect(msg).toContain("[schema-arming]");
    });

    it("断言②：--extension 为目录形态与入口文件形态都命中（不抛）", () => {
      expect(() =>
        assertSchemaEnforcementArmed(armedInput({ spawnArgs: ["--extension", STRUCTURED_OUTPUT_ENTRY] })),
      ).not.toThrow();
    });

    it("断言②：路径段前缀相似（pi-structured-output-lookalike）不误判为在场", () => {
      expect(() =>
        assertSchemaEnforcementArmed(
          armedInput({ spawnArgs: ["--extension", "/x/@zhushanwen/pi-structured-output-lookalike"] }),
        ),
      ).toThrow(/\[schema-arming\]/);
    });

    it("断言②：dev 源码布局（extensions/universal/structured-output，目录与入口文件形态）命中", () => {
      // L4 A1 根因回归锁：dev 下 taiji 宿主注入的 ctx.extensionPaths 是源码目录
      // （无 @zhushanwen scope 段）——断言②须同判据识别 dev 布局别名段。
      expect(() =>
        assertSchemaEnforcementArmed(
          armedInput({ spawnArgs: ["--extension", "/repo/extensions/universal/structured-output"] }),
        ),
      ).not.toThrow();
      expect(() =>
        assertSchemaEnforcementArmed(
          armedInput({
            spawnArgs: [
              "--extension", "/repo/extensions/universal/subagent-workflow",
              "--extension", "/repo/extensions/universal/structured-output/index.js",
            ],
          }),
        ),
      ).not.toThrow();
    });

    it("断言②：dev 布局尾段同名前缀目录不误判为在场（两段连续匹配防误伤）", () => {
      expect(() =>
        assertSchemaEnforcementArmed(
          armedInput({ spawnArgs: ["--extension", "/repo/extensions/universal/structured-output-lookalike"] }),
        ),
      ).toThrow(/\[schema-arming\]/);
    });

    it("全武装（env + 扩展在场）→ 不抛", () => {
      expect(() => assertSchemaEnforcementArmed(armedInput())).not.toThrow();
    });

    it("capability 分流（验收 b）：emulated 引擎（zcode mock capabilities）豁免——schema 任务全缺席不触发断言", () => {
      expect(() =>
        assertSchemaEnforcementArmed(
          armedInput({ schemaEnforcement: "emulated", childEnv: {}, spawnArgs: [] }),
        ),
      ).not.toThrow();
    });

    it("无 schema 任务（声明缺省）→ 无武装面，不触发断言", () => {
      expect(() =>
        assertSchemaEnforcementArmed(armedInput({ schema: undefined, childEnv: {}, spawnArgs: [] })),
      ).not.toThrow();
    });
  });
});

// ======== 来源：server.test.ts ========
describe("server", () => {
  // ── fixture（合成的引擎数据形态；sessionFile 等路径只是内存字符串，无 fs 语义）──

  const CAPABILITIES: EngineCapabilities = {
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
  };

  const HANDLE: EngineHandleData = {
    v: 1,
    engineId: "pi",
    sessionRef: { recordId: "rec_server_test_1", sessionFile: "/tmp/fake-pi-session.jsonl" },
    adapterVersion: PI_ADAPTER_VERSION,
  };

  const PROBE_REPORT: ProbeReport = {
    ok: true,
    engineVersion: "9.9.9-fake",
    checks: [{ name: "binary", ok: true }],
  };

  const SESSION_VIEW: SessionView = { engineId: "pi", turns: [], source: "native" };

  const INIT_PARAMS: InitializeParams = {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    hostInfo: { name: "vitest-server-test", version: "0.0.0", dataRoot: "/tmp/fake-host-root" },
    engineConfig: {},
  };

  const FAKE_OUTCOME = { content: "你好", exitCode: 0, engineId: "pi", sessionId: HANDLE.sessionRef.recordId };

  interface OutFrame { // oe-exempt:20261006:test:测试专用出帧形态断言结构单实现为常态
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: string; message: string; recovery: string };
  }

  // ── 测试基建 ──

  /** 内存帧 sink：收集全部出站帧 + 轮询等待目标帧（dispatch 应答在微任务后写回）。 */
  function makeSink() {
    const frames: OutFrame[] = [];
    return {
      frames,
      write: (frame: unknown): void => {
        frames.push(frame as OutFrame);
      },
      async waitFor(pred: (f: OutFrame) => boolean, what: string, timeoutMs = 2_000): Promise<OutFrame> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const hit = frames.find(pred);
          if (hit !== undefined) return hit;
          if (Date.now() > deadline) {
            throw new Error(`frame not observed within ${timeoutMs}ms: ${what}; frames=${JSON.stringify(frames)}`);
          }
          await new Promise((r) => setTimeout(r, 2));
        }
      },
    };
  }

  /** EnginePort 内存 fake（含 pi 专有 bindAskUser 绑定侧）：
 * 逐成员 vi.fn，overrides 直替换（undefined = 未实现分支）。 */
  type FakeEngine = EnginePort & {
    bindAskUser(handler: ((req: UiRequest) => Promise<UiResponse>) | undefined): void;
  };

  function makeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
    const base: FakeEngine = {
      id: "pi",
      capabilities: vi.fn((): EngineCapabilities => ({ ...CAPABILITIES })),
      probe: vi.fn(async (): Promise<ProbeReport> => ({ ...PROBE_REPORT })),
      run: vi.fn(async (_task: AgentCallOpts, _ctx: RunContext): Promise<EngineRunResult> => {
        return { handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } };
      }),
      read: vi.fn(async (): Promise<SessionView> => ({ ...SESSION_VIEW })),
      listModels: vi.fn((): Array<{ id: string; name?: string }> => [{ id: "prov/m1", name: "M1" }]),
      validateModel: vi.fn((modelRef: string | undefined) => ({ canonicalRef: modelRef ?? "" })),
      dispose: vi.fn(async (): Promise<void> => undefined),
      bindAskUser: vi.fn((_handler: ((req: UiRequest) => Promise<UiResponse>) | undefined): void => undefined),
    };
    return { ...base, ...overrides };
  }

  /** 组合一个 server（缺省 clock 记录侧 + 内存 sink），返回全部观测点。
 * piAgentDir 缺省注入一个不存在的 tmp 路径——查询范围（listModels/validateModel，
 * 路由 engine-query）读不到任何数据文件 → null/结构化错误，测试既不触碰真实
 * 系统 pi 目录，也无需 fixture 文件（本文件保持零 fs 写删）。 */
  function makeServer(engine = makeEngine(), reverseTimeoutMs?: number, piAgentDir?: string) {
    const sink = makeSink();
    const clockCalls: Array<{ op: string; id: string }> = [];
    const server = new EngineProtocolServer({
      write: sink.write,
      engine,
      piAgentDir: piAgentDir ?? path.join(os.tmpdir(), `pi-server-test-absent-${randomUUID()}`),
      reverseClock: {
        started: (id: string) => clockCalls.push({ op: "started", id }),
        acked: (id: string) => clockCalls.push({ op: "acked", id }),
        settled: (id: string) => clockCalls.push({ op: "settled", id }),
        dispose: () => clockCalls.push({ op: "dispose", id: "-" }),
      },
      ...(reverseTimeoutMs !== undefined ? { reverseTimeoutMs } : {}),
    });
    return { server, sink, engine, clockCalls };
  }

  /** 发一帧请求并等对应 id 的应答帧（result/error 二选一）。 */
  async function request(
    server: EngineProtocolServer,
    sink: ReturnType<typeof makeSink>,
    id: number,
    method: string,
    params?: unknown,
  ): Promise<OutFrame> {
    server.handleFrame(params === undefined ? { id, method } : { id, method, params });
    return sink.waitFor(
      (f) => f.id === id && (f.result !== undefined || f.error !== undefined),
      `response#${id} ${method}`,
    );
  }

  // ── 帧分类路由 ──

  describe("handleFrame 帧分类路由", () => {
    it("请求帧（数字 id）→ 分发到 handler 并写回 {id, result}", async () => {
      const { server, sink } = makeServer();
      const resp = await request(server, sink, 1, "ping", {});
      expect(resp.error).toBeUndefined();
      expect(resp.result).toEqual({ pong: true });
    });

    it("未知方法 → engine_protocol_unknown_method（错误原文含方法名与 request id 回显）", async () => {
      const { server, sink } = makeServer();
      const resp = await request(server, sink, 42, "host/greet", {});
      expect(resp.error?.code).toBe("engine_protocol_unknown_method");
      expect(resp.error?.message).toContain("unknown protocol method: host/greet");
      expect(resp.error?.message).toContain("request id 42");
      expect(resp.error?.recovery).toContain("protocol v1");
    });

    it("handler 抛普通 Error → engine_run_failed + 恢复指引（非结构化错误兜底）", async () => {
      const engine = makeEngine({ probe: vi.fn(async (): Promise<ProbeReport> => { throw new Error("boom"); }) });
      const { server, sink } = makeServer(engine);
      const resp = await request(server, sink, 5, "probe", {});
      expect(resp.error?.code).toBe("engine_run_failed");
      expect(resp.error?.message).toBe("boom");
      expect(resp.error?.recovery).toContain("logs");
    });

    it("入站反向请求帧 → engine_protocol_bad_frame（id 0）且不断流", async () => {
      const { server, sink } = makeServer();
      server.handleFrame({ id: "h-9", method: "host/askUser", params: {} });
      const bad = await sink.waitFor((f) => f.id === 0, "bad_frame");
      expect(bad.error?.code).toBe("engine_protocol_bad_frame");
      expect(bad.error?.message).toContain("host/askUser");
      const ping = await request(server, sink, 1, "ping", {});
      expect(ping.result).toEqual({ pong: true });
    });

    it("无法归类的帧静默忽略（stdout 协议通道独占，不回显坏帧）", () => {
      const { server, sink } = makeServer();
      server.handleFrame({});
      server.handleFrame("raw string");
      server.handleFrame({ id: 3, method: 42 });
      server.handleFrame({ id: "x" });
      expect(sink.frames).toHaveLength(0);
    });

    it("应答帧 id 无在途反向请求 → 静默忽略不抛", () => {
      const { server, sink } = makeServer();
      expect(() => server.handleFrame({ id: "rev-ghost", result: { ok: true } })).not.toThrow();
      expect(sink.frames).toHaveLength(0);
    });
  });

  // ── 10 正向方法分发表 ──

  describe("dispatchTable 表驱动路由（逐方法 → EnginePort 成员）", () => {
    it("initialize：版本协商 + 能力应答（查询范围 agentDir 无数据 → 应答不含 models 键）", async () => {
      const engine = makeEngine();
      const { server, sink } = makeServer(engine);
      const resp = await request(server, sink, 1, "initialize", INIT_PARAMS);
      expect(resp.error).toBeUndefined();
      expect(resp.result).toEqual({
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        engineId: "pi",
        engineVersion: PI_ADAPTER_VERSION,
        adapterVersion: PI_ADAPTER_VERSION,
        capabilities: CAPABILITIES,
      });
    });

    it("initialize：models 应答源 = 引擎查询范围（engine-query 读数据目录，不经 engine mock；models 派生视图仅 id）", async () => {
      // engine.listModels mock 不再被分发位消费（pi-workflow-run-resource-model §3.3
      // 决策 11：查询范围路由 engine-query）——数据范围断言归 engine-query.test.ts（fixture
      // 注入形态），本用例锁定「mock 声明不泄漏进 initialize 应答」的改道路由事实。
      const engine = makeEngine({ listModels: vi.fn((): Array<{ id: string; name?: string }> => [{ id: "mock-only/m", name: "Mock" }]) });
      const { server, sink } = makeServer(engine);
      const resp = await request(server, sink, 1, "initialize", INIT_PARAMS);
      expect(resp.error).toBeUndefined();
      expect(Object.keys(resp.result as object)).not.toContain("models");
      expect(vi.mocked(engine.listModels)).not.toHaveBeenCalled();
    });

    it("initialize 版本越界 → engine_protocol_mismatch（含双方版本与升级指引）", async () => {
      const { server, sink } = makeServer();
      const resp = await request(server, sink, 1, "initialize", { ...INIT_PARAMS, protocolVersion: 99 });
      expect(resp.error?.code).toBe("engine_protocol_mismatch");
      expect(resp.error?.message).toContain("99");
      expect(resp.error?.message).toContain(`v${ENGINE_PROTOCOL_VERSION}`);
    });

    it("probe：对象 params 透传（force 面）；缺省/非对象 params → undefined", async () => {
      const engine = makeEngine();
      const { server, sink } = makeServer(engine);
      const r1 = await request(server, sink, 1, "probe", { force: true });
      expect(r1.result).toEqual(PROBE_REPORT);
      expect(vi.mocked(engine.probe)).toHaveBeenLastCalledWith({ force: true });

      await request(server, sink, 2, "probe");
      expect(vi.mocked(engine.probe)).toHaveBeenLastCalledWith(undefined);

      await request(server, sink, 3, "probe", "not-an-object");
      expect(vi.mocked(engine.probe)).toHaveBeenLastCalledWith(undefined);
    });

    it("run 先于 initialize → engine_protocol_not_initialized（握手前置门）", async () => {
      const { server, sink } = makeServer();
      const resp = await request(server, sink, 1, "run", {
        runId: "r-early",
        task: { prompt: "p" },
        ctx: { poolKey: "shared", cwd: "/w" },
      });
      expect(resp.error?.code).toBe("engine_protocol_not_initialized");
    });

    it("listModels：分发位路由 engine-query（agentDir 无数据 → {models:null}；数据范围 fixture 断言归 engine-query.test.ts）", async () => {
      const { server, sink } = makeServer();
      const r1 = await request(server, sink, 1, "listModels", {});
      expect(r1.result).toEqual({ models: null });
    });

    it("validateModel：分发位路由 engine-query（无数据目录 + 无缺省声明 → engine_model_unknown 结构化错误）", async () => {
      const { server, sink } = makeServer();
      const r1 = await request(server, sink, 1, "validateModel", { modelRef: "prov/m1" });
      expect(r1.error?.code).toBe("engine_model_unknown");
      expect(r1.error?.recovery).toContain("listModels");

      const r2 = await request(server, sink, 2, "validateModel", {});
      expect(r2.error?.code).toBe("engine_model_unknown");
      expect(r2.error?.recovery).toContain("pi /model");
    });

    it("read：handle 以 {data} 包装传给引擎（协议范围裸 handle）", async () => {
      const engine = makeEngine();
      const { server, sink } = makeServer(engine);
      const r2 = await request(server, sink, 2, "read", { handle: HANDLE, dataDir: "/d" });
      expect(r2.result).toEqual(SESSION_VIEW);
      expect(vi.mocked(engine.read)).toHaveBeenLastCalledWith({ data: HANDLE });
    });

    it("dispose：引擎释放被调用且返回 {ok:true}；引擎未实现 dispose 仍 ok（幂等）", async () => {
      const engine = makeEngine();
      const { server, sink } = makeServer(engine);
      const r1 = await request(server, sink, 1, "dispose", {});
      expect(r1.result).toEqual({ ok: true });
      expect(vi.mocked(engine.dispose!)).toHaveBeenCalledTimes(1);

      const second = makeServer(makeEngine({ dispose: undefined }));
      const r2 = await request(second.server, second.sink, 1, "dispose", {});
      expect(r2.result).toEqual({ ok: true });
    });

    it("[subagent-model-switch] setModel：native 引擎路由 EnginePort.setModel（载荷透传 + result 写回）；缺省声明位（fixture 无 setModel 键 = unsupported）→ engine_capability_unsupported", async () => {
      // 缺省 fake：capabilities 未声明 setModel（undefined = unsupported）→ 分发行能力位防御拒绝
      const gate = makeEngine();
      const g = makeServer(gate);
      const rejected = await request(g.server, g.sink, 1, "setModel", {
        runId: "rec-1",
        model: { provider: "p", modelId: "m" },
      });
      expect(rejected.error?.code).toBe("engine_capability_unsupported");
      expect(vi.mocked(gate.setModel ?? vi.fn())).not.toHaveBeenCalled();

      // native 声明 + 成员实装 → 路由 engine（协议载荷 cast 收敛在适配行）
      const setModelFn = vi.fn(async (params: { runId: string; model: unknown }) => ({
        effectiveModel: params.model,
        effectiveThinkingLevel: "high",
      }));
      const native = makeEngine({
        capabilities: vi.fn((): EngineCapabilities => ({ ...CAPABILITIES, setModel: "native" })),
        setModel: setModelFn as unknown as FakeEngine["setModel"],
      });
      const n = makeServer(native);
      const routed = await request(n.server, n.sink, 2, "setModel", {
        runId: "rec-2",
        model: { provider: "p", modelId: "m" },
      });
      expect(routed.result).toEqual({
        effectiveModel: { provider: "p", modelId: "m" },
        effectiveThinkingLevel: "high",
      });
      expect(setModelFn).toHaveBeenCalledWith({ runId: "rec-2", model: { provider: "p", modelId: "m" } });
    });
  });

  // ── run 协议载荷还原 + 事件/反向通道 ──

  describe("run：协议载荷 → 本地 AgentCallOpts/RunContext", () => {
    it("全字段还原：ctx.model 合回 task、ctxModel 解析、streamMode、反向通道、事件 seq 单调、终态拆包", async () => {
      let captured: { task: AgentCallOpts; ctx: RunContext } | undefined;
      const engine = makeEngine({
        run: vi.fn(async (task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> => {
          captured = { task, ctx };
          ctx.onHandleReady?.({ sessionRef: HANDLE.sessionRef });
          ctx.onEvent?.({ type: "text_delta", delta: "你好" } satisfies AgentEvent);
          ctx.onEvent?.({ type: "message_end", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 } });
          ctx.stream?.onDelta("你好");
          return { handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } };
        }),
      });
      const { server, sink } = makeServer(engine);
      const init = await request(server, sink, 1, "initialize", INIT_PARAMS);
      expect(init.error).toBeUndefined();

      server.handleFrame({
        id: 2,
        method: "run",
        params: {
          runId: "run-1",
          // [D1] schema 本体经 wire task.schema 单字段承载（ctx 侧 env 字符串已退役）
          task: { prompt: "做点什么", denyTools: ["bash"], schema: { type: "object" } },
          ctx: {
                cwd: "/w",
            model: "prov/m1",
            ctxModel: "prov/ctx-model",
            streamMode: "stream",
            sessionRootId: "root-sess-9",
            sessionDir: "/host/agent-dir/subagents/--Users-x-proj--/sessions",
          },
        },
      });

      const ready = await sink.waitFor((f) => f.method === "host/handleReady", "handleReady");
      server.handleFrame({ id: ready.id, result: { ok: true } });
      expect(ready.params).toEqual({ runId: "run-1", sessionRef: HANDLE.sessionRef});

      const delta = await sink.waitFor((f) => f.method === "host/streamDelta", "streamDelta");
      server.handleFrame({ id: delta.id, result: { ok: true } });
      expect(delta.params).toEqual({ runId: "run-1", delta: "你好" });

      // 事件通知：runId 关联 + seq 单调递增
      const ev1 = await sink.waitFor((f) => f.method === "event", "event#1");
      const ev2 = await sink.waitFor((f) => f.method === "event" && f !== ev1, "event#2");
      const p1 = ev1.params as { runId: string; seq: number; event: AgentEvent };
      const p2 = ev2.params as { runId: string; seq: number; event: AgentEvent };
      expect(p1).toMatchObject({ runId: "run-1", seq: 1, event: { type: "text_delta", delta: "你好" } });
      expect(p2).toMatchObject({ runId: "run-1", seq: 2, event: { type: "message_end" } });

      // 本地全量 task 还原（ctx.model/cwd 合回；task 其余字段透传——含 [D1] wire
      // task.schema 本体直通）+ RunContext 断言
      expect(captured?.task).toEqual({
        prompt: "做点什么",
        denyTools: ["bash"],
        schema: { type: "object" },
        model: "prov/m1",
        cwd: "/w",
      });
      expect(captured?.ctx.taskId).toBe("run-1");
      expect(captured?.ctx.ctxModel).toEqual({ provider: "prov", id: "ctx-model" });
      // [D1] 负向断言：ctx 侧传输态 env 字符串字段已退役（防字段名复活）
      expect("schemaEnv" in (captured?.ctx ?? {})).toBe(false);
      // 运行期引擎 fallback 已删：ctx 不得重现留痕字段（防字段名复活）
      expect(captured?.ctx).not.toHaveProperty("engineFallback");
      expect(captured?.ctx.sessionRootId).toBe("root-sess-9");
      // [Option C 协议化] ctx.sessionDir 还原透传（宿主权威值，引擎不自推导）
      expect(captured?.ctx.sessionDir).toBe("/host/agent-dir/subagents/--Users-x-proj--/sessions");
      expect(captured?.ctx.stream).toBeDefined();
      expect(captured?.ctx.signal).toBeInstanceOf(AbortSignal);
      expect(captured?.ctx.resume).toBeUndefined();

      // 一次性 run：onChildSpawned 以 runId 锚定；pid 缺省不发包
      captured?.ctx.onChildSpawned?.({ pid: 4242, killed: false });
      const spawned = await sink.waitFor((f) => f.method === "host/childSpawned", "childSpawned");
      expect(spawned.params).toEqual({ pid: 4242, recordId: "run-1" });
      const spawnedCount = sink.frames.filter((f) => f.method === "host/childSpawned").length;
      captured?.ctx.onChildSpawned?.({ pid: undefined, killed: false });
      expect(sink.frames.filter((f) => f.method === "host/childSpawned")).toHaveLength(spawnedCount);

      // [SR-4] onChildStateChanged：只有 exited 发帧（宿主镜像据此取消该 pid 的挂起 dialog）；
      // running 由 childSpawned 覆盖，不发重复帧
      const stateChangedCount = sink.frames.filter((f) => f.method === "host/childStateChanged").length;
      captured?.ctx.onChildStateChanged?.({ pid: 4242, recordId: "run-1", state: "running", killed: false });
      expect(sink.frames.filter((f) => f.method === "host/childStateChanged")).toHaveLength(stateChangedCount);

      captured?.ctx.onChildStateChanged?.({
        pid: 4242, recordId: "run-1", state: "exited", killed: true, exitCode: 1,
      });
      const exitedFrame = await sink.waitFor((f) => f.method === "host/childStateChanged", "childStateChanged");
      expect(exitedFrame.params).toEqual({
        pid: 4242, recordId: "run-1", state: "exited", killed: true, exitCode: 1,
      });

      // host/handleReady 反向请求必须先于事件到达（§3.4 不变量 3 帧序证据）
      expect(sink.frames.indexOf(ready)).toBeLessThan(sink.frames.indexOf(ev1));

      // 终态应答：进程内 {data} 包装拆掉（协议 RunResult.handle = EngineHandleData 本体）
      const resp = await sink.waitFor(
        (f) => f.id === 2 && (f.result !== undefined || f.error !== undefined),
        "run response",
      );
      expect(resp.result).toEqual({ handle: HANDLE, outcome: FAKE_OUTCOME });
    });

    it("ctx.cwd 缺省（wire 不带）→ task 不合回 cwd（additive 语义——引擎回退自身进程 cwd）", async () => {
      const engine = makeEngine();
      const { server, sink } = makeServer(engine);
      await request(server, sink, 0, "initialize", INIT_PARAMS);

      server.handleFrame({
        id: 20,
        method: "run",
        params: { runId: "r-cwd", task: { prompt: "p" }, ctx: { model: "prov/m1" } },
      });
      await sink.waitFor(
        (f) => f.id === 20 && (f.result !== undefined || f.error !== undefined),
        "run#cwd-absent",
      );
      const task = (engine.run as Mock).mock.calls[0]?.[0] as AgentCallOpts;
      expect(task.cwd).toBeUndefined();
    });

    it("ctxModel 归一：空串/空白/无斜杠/前导斜杠/尾斜杠 → undefined（parseCtxModel 边界）", async () => {
      const engine = makeEngine();
      const { server, sink } = makeServer(engine);
      await request(server, sink, 0, "initialize", INIT_PARAMS);

      const malformed = ["", "   ", "noprovider", "/leading", "prov/"] as const;
      for (const [i, ref] of malformed.entries()) {
        server.handleFrame({
          id: 10 + i,
          method: "run",
          params: { runId: `r-${i}`, task: { prompt: "p" }, ctx: { poolKey: "shared", cwd: "/w", ctxModel: ref } },
        });
        const resp = await sink.waitFor(
          (f) => f.id === 10 + i && (f.result !== undefined || f.error !== undefined),
          `run#${i}`,
        );
        expect(resp.error, `ctxModel=${JSON.stringify(ref)} 不应报错`).toBeUndefined();
        const ctx = (engine.run as Mock).mock.calls[i]?.[1] as RunContext;
        expect(ctx.ctxModel, `ctxModel=${JSON.stringify(ref)} 应归一为 undefined`).toBeUndefined();
      }
    });

    it("[F6] ctx.sessionRootId 缺省 → 还原后的 RunContext 无该键（additive 语义，归属键缺省不注入）", async () => {
      const engine = makeEngine();
      const { server, sink } = makeServer(engine);
      await request(server, sink, 0, "initialize", INIT_PARAMS);
      await request(server, sink, 20, "run", {
        runId: "run-f6",
        task: { prompt: "p" },
        ctx: { poolKey: "shared", cwd: "/w" },
      });
      const ctx = (engine.run as Mock).mock.calls[0]?.[1] as RunContext;
      expect(ctx).not.toHaveProperty("sessionRootId");
    });

    it("cancel：活跃 run 的 signal 被 abort（reason 透传）；收尾后 cancel 幂等 ok；迟到事件 seq 回落 0", async () => {
      let capturedCtx: RunContext | undefined;
      let release!: (value: EngineRunResult) => void;
      const engine = makeEngine({
        run: vi.fn((_task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> => {
          capturedCtx = ctx;
          return new Promise<EngineRunResult>((resolve) => {
            release = resolve;
          });
        }),
      });
      const { server, sink } = makeServer(engine);
      await request(server, sink, 1, "initialize", INIT_PARAMS);

      server.handleFrame({
        id: 2,
        method: "run",
        params: { runId: "run-c", task: { prompt: "p" }, ctx: { poolKey: "shared", cwd: "/w" } },
      });
      await vi.waitFor(() => expect(capturedCtx).toBeDefined());

      const cancelResp = await request(server, sink, 3, "cancel", { runId: "run-c", reason: "host timeout" });
      expect(cancelResp.result).toEqual({ ok: true });
      expect(capturedCtx?.signal?.aborted).toBe(true);
      expect((capturedCtx?.signal?.reason as Error).message).toContain("cancelled by host: host timeout");

      // 释放 run（activeRuns 清理路径）→ 终态应答照常写回
      release({ handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } });
      const resp = await sink.waitFor((f) => f.id === 2 && f.result !== undefined, "run response");
      expect(resp.error).toBeUndefined();

      // 已收尾 runId 再 cancel → 无活跃登记，仍受理 ok
      const lateCancel = await request(server, sink, 4, "cancel", { runId: "run-c", reason: "late" });
      expect(lateCancel.result).toEqual({ ok: true });

      // 引擎迟到事件：无活跃登记 → seq 回落 0（通知照发，不丢事件）
      capturedCtx?.onEvent?.({ type: "turn_end" });
      const late = await sink.waitFor((f) => f.method === "event", "late event");
      expect(late.params).toMatchObject({ runId: "run-c", seq: 0 });
    });
  });

  // ── pi 专有：askUser 绑定侧 + run.resume 帧校验 ──

  describe("bindAskUser 两阶段绑定体（pi 专有）", () => {
    it("非 chat run：run 前绑定 askUser 等待体（host/askUser 载荷 {runId, request}），run 结束解绑", async () => {
      let release!: (value: EngineRunResult) => void;
      const engine = makeEngine({
        run: vi.fn((_task: AgentCallOpts, _ctx: RunContext): Promise<EngineRunResult> =>
          new Promise<EngineRunResult>((resolve) => {
            release = resolve;
          })),
      });
      const { server, sink } = makeServer(engine);
      await request(server, sink, 1, "initialize", INIT_PARAMS);

      server.handleFrame({
        id: 2,
        method: "run",
        params: { runId: "run-ask", task: { prompt: "p" }, ctx: { poolKey: "shared", cwd: "/w" } },
      });
      await vi.waitFor(() => expect(vi.mocked(engine.bindAskUser)).toHaveBeenCalledTimes(1));
      const handler = vi.mocked(engine.bindAskUser).mock.calls[0]![0]!;
      expect(handler).toBeTypeOf("function");

      // run 期间经等待体发 askUser → host/askUser 反向帧（runId 关联）
      const req: UiRequest = { method: "select", id: "ui-1", title: "选一个" };
      const answerP = handler(req);
      const ask = await sink.waitFor((f) => f.method === "host/askUser", "askUser frame");
      expect(ask.params).toEqual({ runId: "run-ask", request: req });
      server.handleFrame({ id: ask.id, result: { value: "A" } });
      await expect(answerP).resolves.toEqual({ value: "A" });

      // run 结束（finally）：bindAskUser(undefined) 解绑，防跨 run 串扰
      release({ handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } });
      await sink.waitFor((f) => f.id === 2 && f.result !== undefined, "run response");
      expect(vi.mocked(engine.bindAskUser)).toHaveBeenLastCalledWith(undefined);
    });

    it("chat run：同走 per-run 绑定（[H1 U3] 每轮一进程，run 结束解绑）；recordId 锚定镜像帧", async () => {
      let release!: (value: EngineRunResult) => void;
      const engine = makeEngine({
        run: vi.fn((_task: AgentCallOpts, _ctx: RunContext): Promise<EngineRunResult> =>
          new Promise<EngineRunResult>((resolve) => {
            release = resolve;
          })),
      });
      const { server, sink } = makeServer(engine);
      await request(server, sink, 1, "initialize", INIT_PARAMS);

      server.handleFrame({
        id: 2,
        method: "run",
        params: {
          runId: "run-chat",
          task: { prompt: "hi" },
          ctx: { poolKey: "shared", cwd: "/w" },
          resume: { recordId: "rec-chat-9" },
        },
      });
      await vi.waitFor(() => expect(vi.mocked(engine.bindAskUser)).toHaveBeenCalledTimes(1));
      const handler = vi.mocked(engine.bindAskUser).mock.calls[0]![0]!;
      expect(handler).toBeTypeOf("function");

      // 会话形态轮 ctx.resume 透传（引擎读端锚定 recordId）
      const ctx = (engine.run as Mock).mock.calls[0]![1] as RunContext;
      expect(ctx.resume).toEqual({ recordId: "rec-chat-9" });

      // run 期间 askUser 等待体可用（per-run 绑定与 one-shot 同构——chat 轮短命 run）
      const req: UiRequest = { method: "select", id: "ui-2", title: "选一个" };
      const answerP = handler(req);
      const ask = await sink.waitFor((f) => f.method === "host/askUser", "chat askUser frame");
      expect(ask.params).toEqual({ runId: "run-chat", request: req });
      server.handleFrame({ id: ask.id, result: { value: "B" } });
      await expect(answerP).resolves.toEqual({ value: "B" });

      // 会话形态轮 run：onChildSpawned 以 recordId 锚定（区别于一次性 run 的 runId 锚定）
      ctx.onChildSpawned?.({ pid: 777, killed: false });
      const spawned = await sink.waitFor((f) => f.method === "host/childSpawned", "childSpawned");
      expect(spawned.params).toEqual({ pid: 777, recordId: "rec-chat-9" });

      // [SR-4] 会话形态同键锚定：childStateChanged 用 recordId（非 runId）
      ctx.onChildStateChanged?.({ pid: 777, recordId: "rec-chat-9", state: "exited", killed: true });
      const exitedChat = await sink.waitFor((f) => f.method === "host/childStateChanged", "childStateChanged");
      expect(exitedChat.params).toEqual({
        pid: 777, recordId: "rec-chat-9", state: "exited", killed: true,
      });

      // run 结束（finally）：bindAskUser(undefined) 解绑，防跨 run 串扰
      release({ handle: { data: { ...HANDLE } }, outcome: { ...FAKE_OUTCOME } });
      await sink.waitFor((f) => f.id === 2 && f.result !== undefined, "run response");
      expect(vi.mocked(engine.bindAskUser)).toHaveBeenLastCalledWith(undefined);
    });

    it("run.resume 空 recordId → engine_protocol_bad_frame（前置校验，run 不进引擎）", async () => {
      const engine = makeEngine();
      const { server, sink } = makeServer(engine);
      await request(server, sink, 1, "initialize", INIT_PARAMS);
      const resp = await request(server, sink, 2, "run", {
        runId: "run-bad",
        task: { prompt: "p" },
        ctx: { poolKey: "shared", cwd: "/w" },
        resume: { recordId: "" },
      });
      expect(resp.error?.code).toBe("engine_protocol_bad_frame");
      expect(resp.error?.message).toContain("recordId");
      expect(vi.mocked(engine.run)).not.toHaveBeenCalled();
    });

    it("run.resume conversation 位 unsupported 引擎 → engine_capability_unsupported（能力位 gate）", async () => {
      const engine = makeEngine({
        capabilities: vi.fn((): EngineCapabilities => ({ ...CAPABILITIES, conversation: "unsupported" })),
      });
      const { server, sink } = makeServer(engine);
      await request(server, sink, 1, "initialize", INIT_PARAMS);
      const resp = await request(server, sink, 2, "run", {
        runId: "run-gate",
        task: { prompt: "hi" },
        ctx: { poolKey: "shared", cwd: "/w" },
        resume: { recordId: "rec-gate" },
      });
      expect(resp.error?.code).toBe("engine_capability_unsupported");
      expect(vi.mocked(engine.run)).not.toHaveBeenCalled();
    });
  });

  // [H1 U5] bindHostChannels 构造期三分通道接线（streamDelta/轮次相位/会话级
  // askUser）已随 chat-session.ts 删除——askUser/runId 键 streamDelta/childStateChanged
  // 的 run 域形态断言保留在上方「run：协议载荷还原」与「bindAskUser」用例中。

  // ── 反向请求客户端 ──

  describe("reverseRequest 客户端", () => {
    it("帧形状（rev-N 单调 id + method/params）+ result 应答落位 + clock started/acked/settled", async () => {
      const { server, sink, clockCalls } = makeServer();
      const p1 = server.reverseRequest("host/log", { message: "hello" });
      const f1 = await sink.waitFor((f) => f.id === "rev-1" && f.method === "host/log", "rev-1");
      expect(f1.params).toEqual({ message: "hello" });
      expect(clockCalls).toEqual([{ op: "started", id: "rev-1" }]);

      server.handleFrame({ id: "rev-1", result: { ok: true } });
      await expect(p1).resolves.toEqual({ ok: true });
      expect(clockCalls).toEqual([
        { op: "started", id: "rev-1" },
        { op: "acked", id: "rev-1" },
        { op: "settled", id: "rev-1" },
      ]);

      // id 单调递增
      const p2 = server.reverseRequest("host/log", {});
      await sink.waitFor((f) => f.id === "rev-2", "rev-2");
      server.handleFrame({ id: "rev-2", result: { ok: true } });
      await expect(p2).resolves.toEqual({ ok: true });
    });

    it("ack 两阶段（R9-2）：{ack:true} 只 ack 计时侧不终结等待，最终帧才 settle", async () => {
      const { server, sink, clockCalls } = makeServer();
      const p = server.reverseRequest("host/askUser", { runId: "r", request: { method: "select", id: "1" } });
      await sink.waitFor((f) => f.id === "rev-1", "rev-1");
      expect(clockCalls).toEqual([{ op: "started", id: "rev-1" }]);

      // 第一段：ack 帧 → 仅 acked（移出 in-flight 自灭计时），p 仍 pending
      server.handleFrame({ id: "rev-1", result: { ack: true } });
      expect(clockCalls).toEqual([
        { op: "started", id: "rev-1" },
        { op: "acked", id: "rev-1" },
      ]);
      let settledOrRejected = false;
      void p.then(
        () => { settledOrRejected = true; },
        () => { settledOrRejected = true; },
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(settledOrRejected).toBe(false);

      // 第二段：最终结果帧 → settle + clock.settled。现状断言：settleReverse 对任何
      // 带在途登记的应答帧先调 acked（含终结帧本身）→ 终结帧产生第二次 acked
      // （幂等无害，登记 settleReverse 双 acked 现状，见任务汇报）
      server.handleFrame({ id: "rev-1", result: { value: "picked" } });
      await expect(p).resolves.toEqual({ value: "picked" });
      expect(clockCalls).toEqual([
        { op: "started", id: "rev-1" },
        { op: "acked", id: "rev-1" },
        { op: "acked", id: "rev-1" },
        { op: "settled", id: "rev-1" },
      ]);
    });

    it("error 应答 → reject（文案含 rejected 前缀与结构化 error 帧）", async () => {
      const { server, sink } = makeServer();
      const p = server.reverseRequest("host/askUser", { request: { kind: "select" } });
      await sink.waitFor((f) => f.id === "rev-1", "rev-1");
      server.handleFrame({ id: "rev-1", error: { code: "host_unavailable", message: "no ui", recovery: "retry" } });
      // A8 修复落地（round1 business-logic S1）：toErrorMessage(非 Error object) 改
      // JSON.stringify——结构化 error 帧（含原始 code/message/recovery）直进 reject 文案，
      // 不再退化为 "[object Object]"（与 zcode 包 settleReverse 同批修复）
      await expect(p).rejects.toThrow(
        'reverse request rev-1 rejected: {"code":"host_unavailable","message":"no ui","recovery":"retry"}',
      );
    });

    it("缺省 60s 超时兜底：reject + clock.settled + 迟到应答不再落位（fake timers）", async () => {
      vi.useFakeTimers();
      try {
        const { server, sink, clockCalls } = makeServer();
        const p = server.reverseRequest("host/log", {});
        expect(sink.frames).toHaveLength(1);
        const assertion = expect(p).rejects.toThrow(/host\/log \(rev-1\) timed out after 60000ms/);
        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;
        expect(clockCalls).toContainEqual({ op: "started", id: "rev-1" });
        expect(clockCalls).toContainEqual({ op: "settled", id: "rev-1" });
        // 迟到应答：pending 已清理 → 无副作用
        const before = sink.frames.length;
        server.handleFrame({ id: "rev-1", result: { ok: true } });
        expect(sink.frames).toHaveLength(before);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
