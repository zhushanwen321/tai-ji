// RemoteEngine 测试（W2）：cli 形态 EnginePort 门面（fake 引擎 CLI）。
//
// 覆盖（impl-plan §2.2 必写死条目）：
//   同步成员形态映射（capabilities 直读 / listModels 三态 / validateModel 三态与
//   成员不实现）/ run 帧映射（task 子集收窄 + ctx 承载）/ RunContext 反向通道映射 /
//   abort → cancel + 3s 收敛（收敛与超时杀链两路）/ read dataDir 必填 /
//   运行中失败合成 outcome vs prepare 期失败 reject 的分界。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineClient } from "../engine-client.ts";
import { RemoteEngine, type RemoteEngineManifestSnapshot } from "../remote-engine.ts";
import { SubagentStream } from "../../../stream-sink.ts";
import { getSubagentSessionDir } from "../../../path-encoding.ts";
import { isProcessAlive } from "../pid-file.ts";
import { getLogger, type UiRequest } from "@zhushanwen/subagent-engine-sdk";

const FAKE_ENGINE = fileURLToPath(new URL("./__fixtures__/fake-engine.mjs", import.meta.url));

/**
 * 默认 manifest capabilities 基线（与 fake 引擎 initialize 应答逐位一致——gate 位
 * 多声明判定的「一致放行」基线；多声明用例在此上单点改强）。
 */
const FAKE_MATCHED_CAPS = {
  schemaEnforcement: "emulated",
  steer: "unsupported",
  conversation: "unsupported",
  personaInjection: "prompt",
  eventGranularity: "stream",
  sandbox: "emulated",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "fixed",
  maxTurns: false,
} as const;

/** 轮询等待（真实 timers；引擎启动/信号传播是真实 IO，fake timers 会挂死自写轮询）。 */
async function waitForTrue(predicate: () => boolean, timeoutMs = 8_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitForTrue: condition not met within timeout");
}

function waitForReady(client: EngineClient): Promise<void> {
  return waitForTrue(() => client.currentState === "ready");
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w2-remote-engine-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.useRealTimers();
});

interface Fixture {
  engine: RemoteEngine;
  client: EngineClient;
  cleanup: () => Promise<void>;
}

function makeEngine(
  manifestOverrides: Partial<RemoteEngineManifestSnapshot> = {},
  clientOverrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {},
): Fixture {
  const client = new EngineClient({
    engineId: "fake",
    command: process.execPath,
    args: [FAKE_ENGINE],
    hostKind: "test",
    dataDir,
    envPrefixes: [],
    ...clientOverrides,
  });
  const engine = new RemoteEngine({
    engineId: "fake",
    client,
    dataDir,
    hostKind: "test",
    manifest: {
      capabilities: { ...FAKE_MATCHED_CAPS },
      modelCatalog: {
        dynamic: true,
        models: [
          { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
          { id: "mimo-v2.5-pro", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.5-pro" },
        ],
      },
      ...manifestOverrides,
    },
  });
  return { engine, client, cleanup: () => client.dispose() };
}

/** RunContext 构造（回调收集器）。 */
function makeCtx(overrides: Partial<Parameters<RemoteEngine["run"]>[1]> = {}) {
  const events: unknown[] = [];
  return {
    ctx: {
      taskId: "run-1",
      poolKey: "shared",
      onEvent: (e: unknown) => {
        events.push(e);
      },
      ...overrides,
    } as Parameters<RemoteEngine["run"]>[1],
    events,
  };
}

/** 从 fake 引擎的 run-params 回显 event 解析引擎实际收到的帧载荷。 */
function extractRunParams(events: unknown[]): { task: Record<string, unknown>; ctx: Record<string, unknown> } {
  const echo = events.find(
    (e) => (e as { type: string; message?: string }).type === "error"
      && typeof (e as { message?: string }).message === "string"
      && (e as { message: string }).message.startsWith("run-params:"),
  ) as { message: string };
  expect(echo).toBeDefined();
  return JSON.parse(echo.message.slice("run-params:".length));
}

describe("RemoteEngine 同步成员形态映射（必写死）", () => {
  it("capabilities()：直读 manifest 注册期快照（不触发连接——构造同步、无缓存）", () => {
    const { engine, client, cleanup } = makeEngine();
    const caps = engine.capabilities();
    expect(caps.schemaEnforcement).toBe("emulated");
    expect(caps.maxTurns).toBe(false);
    expect(client.currentState).toBe("idle"); // 同步成员不碰协议
    void cleanup;
  });

  it("listModels() 三态：省略 modelCatalog → null（buildCoreAlignedHint）；显式 [] → []（buildEmptyModelsHint）；数组原样", async () => {
    const omitted = makeEngine({ modelCatalog: undefined });
    expect(omitted.engine.listModels()).toBeNull();
    const explicitEmpty = makeEngine({ modelCatalog: { dynamic: false, models: [] } });
    expect(explicitEmpty.engine.listModels()).toEqual([]);
    const listed = makeEngine();
    expect(listed.engine.listModels()).toEqual([
      { id: "glm-4.6", aliases: ["glm"], canonicalRef: "zai/glm-4.6" },
      { id: "mimo-v2.5-pro", canonicalRef: "xiaomi-token-plan-cn/mimo-v2.5-pro" },
    ]);
    const nullForm = makeEngine({ modelCatalog: null });
    expect(nullForm.engine.listModels()).toBeNull(); // null 合法等价省略
    await Promise.all([omitted, explicitEmpty, listed, nullForm].map((f) => f.cleanup()));
  });

  it("validateModel 成员不实现：manifest 省略 → typeof validateModel === 'undefined'（消费方跳过校验恒放行）", () => {
    const { engine } = makeEngine({ modelCatalog: undefined });
    expect(typeof (engine as unknown as { validateModel?: unknown }).validateModel).toBe("undefined");
    const { engine: withCatalog } = makeEngine();
    expect(typeof (withCatalog as unknown as { validateModel?: unknown }).validateModel).toBe("function");
  });

  it("validateModel 判定：命中回 canonicalRef；alias 命中；未命中 dynamic:false → engine_model_unknown 同步拒；dynamic:true → 放行原样 ref", () => {
    const { engine } = makeEngine();
    expect(engine.validateModel("zai/glm-4.6")).toEqual({ canonicalRef: "zai/glm-4.6" });
    expect(engine.validateModel("glm")).toEqual({ canonicalRef: "zai/glm-4.6" }); // alias
    expect(engine.validateModel("mimo-v2.5-pro")).toEqual({
      canonicalRef: "xiaomi-token-plan-cn/mimo-v2.5-pro",
    });
    // dynamic:true：未命中放行、原样 ref（运行期引擎为权威；无斜杠 ref 拆分 = 契约变更④归 W3）
    expect(engine.validateModel("custom/new-model")).toEqual({ canonicalRef: "custom/new-model" });

    const staticEngine = makeEngine({ modelCatalog: { dynamic: false, models: [{ id: "only-model" }] } });
    expect(staticEngine.engine.validateModel("only-model")).toEqual({ canonicalRef: "only-model" });
    expect(() => staticEngine.engine.validateModel("unknown-ref")).toThrowError(/engine_model_unknown/);
    expect(() => staticEngine.engine.validateModel(undefined)).toThrowError(/engine_model_unknown/);
    // dynamic:true 下 undefined ref（查引擎缺省）→ 放行（缺省模型运行期自证）
    expect(engine.validateModel(undefined)).toEqual({ canonicalRef: "" });
  });
});

describe("RemoteEngine run 帧映射", () => {
  it("task 子集收窄（model/schemaEnv/cwd/engineFallback 改挂 ctx）+ ctxModel 投影 provider/id", async () => {
    const { engine, cleanup } = makeEngine();
    const { ctx, events } = makeCtx({
      ctxModel: { id: "glm-5.1", name: "GLM", provider: "zai", reasoning: true },
      schemaEnv: "ctx-schema-env",
      engineFallback: { from: "pi", reason: "probe-failed" },
    });
    const task = {
      prompt: "do things",
      model: "zai/glm-4.6",
      cwd: "/tmp/w2-cwd",
      schemaEnv: "task-schema-env",
      engine: "pi",
      timeoutMs: 1_000,
      returnMeta: true,
      maxTurns: 5,
      description: "desc-x",
      worktree: true,
    };
    const result = await engine.run(task, ctx);
    // 宿主自持字段（engine/timeoutMs/returnMeta）与双写字段（model/schemaEnv/cwd）不进 task 帧
    const wire = extractRunParams(events);
    expect(wire.task).toMatchObject({ prompt: "do things", maxTurns: 5, description: "desc-x", worktree: true });
    expect(wire.task).not.toHaveProperty("model");
    expect(wire.task).not.toHaveProperty("engine");
    expect(wire.task).not.toHaveProperty("timeoutMs");
    expect(wire.task).not.toHaveProperty("returnMeta");
    expect(wire.task).not.toHaveProperty("schemaEnv");
    expect(wire.task).not.toHaveProperty("cwd");
    expect(wire.ctx).toMatchObject({
      poolKey: "shared",
      cwd: "/tmp/w2-cwd",
      model: "zai/glm-4.6",
      schemaEnv: "ctx-schema-env", // ctx 优先于 task（协议层单列，不双写）
      ctxModel: "zai/glm-5.1",
      engineFallback: { from: "pi", reason: "probe-failed" },
    });
    expect(wire.ctx).not.toHaveProperty("streamMode"); // 无 stream → 缺省（JSON 序列化丢 undefined 键）
    expect(result.outcome.content).toBe("fake-content-run-1");
    expect(result.handle.data.engineId).toBe("fake");
    expect(result.handle.data.adapterVersion).toBe("fake-adapter");
    await cleanup();
  });

  it("ctx.stream 存在 → streamMode stream；streamDelta 反向请求 → stream.onDelta（真 SubagentStream flush）", async () => {
    const flushed: Array<string[] | undefined> = [];
    const sink = {
      setWidget: (_key: string, lines: string[] | undefined) => {
        flushed.push(lines);
      },
    };
    const stream = new SubagentStream("w2-rec", sink);
    const { engine, cleanup } = makeEngine(undefined, {
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "streamDelta", delta: "d1" }, { op: "streamDelta", delta: "d2" }]),
      ],
    });
    const { ctx, events } = makeCtx({ stream });
    await engine.run({ prompt: "p" }, ctx);
    const wire = extractRunParams(events);
    expect(wire.ctx.streamMode).toBe("stream");
    // leading edge 同步 flush（["d1"]）；trailing edge 100ms 合并——buffer 累积语义
    // （widget 是累积预览，flush 不清 buffer，现状实现特征）
    expect(flushed[0]).toEqual(["d1"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(flushed[1]).toEqual(["d1d2"]);
    stream.dispose();
    await cleanup();
  });

  it("ctx.sessionRootId → wire ctx.sessionRootId 逐字保真；缺省不传 → wire 无该键（F6 additive）", async () => {
    // 正向：根 session id 上 wire（pi 引擎 relay 归属键 SESSION_ID 的权威来源）
    const withRoot = makeEngine();
    const { ctx: ctxRoot, events: eventsRoot } = makeCtx({ sessionRootId: "root-sess-f6" });
    await withRoot.engine.run({ prompt: "p" }, ctxRoot);
    expect(extractRunParams(eventsRoot).ctx.sessionRootId).toBe("root-sess-f6");

    // 负向：缺省 → wire ctx 不出现该键（undefined 不上 wire，旧引擎 additive 兼容）
    const bare = makeEngine();
    const { ctx: ctxBare, events: eventsBare } = makeCtx();
    await bare.engine.run({ prompt: "p" }, ctxBare);
    expect(extractRunParams(eventsBare).ctx).not.toHaveProperty("sessionRootId");

    await withRoot.cleanup();
    await bare.cleanup();
  });

  it("[Option C] wire ctx.sessionDir = getSubagentSessionDir(env 同源推导)；ctx 显式注入优先", async () => {
    // stub env 固定推导输入（测试进程可能已带这两键——stub 后期望值确定）
    vi.stubEnv("PI_CODING_AGENT_DIR", join(dataDir, "agent-dir"));
    vi.stubEnv("PI_SUBAGENT_ROOT_CWD", join(dataDir, "root-cwd"));
    try {
      // 正向：env 同源推导值上 wire（宿主单一权威 getSubagentSessionDir，引擎不自推导）
      const derived = makeEngine();
      const { ctx, events } = makeCtx();
      await derived.engine.run({ prompt: "p" }, ctx);
      expect(extractRunParams(events).ctx.sessionDir).toBe(
        getSubagentSessionDir(join(dataDir, "agent-dir"), join(dataDir, "root-cwd")),
      );

      // 宿主编排层显式注入（ctx.sessionDir）优先于 env 推导
      const injected = makeEngine();
      const { ctx: ctxInj, events: eventsInj } = makeCtx({ sessionDir: "/explicit/session-dir" });
      await injected.engine.run({ prompt: "p" }, ctxInj);
      expect(extractRunParams(eventsInj).ctx.sessionDir).toBe("/explicit/session-dir");

      await derived.cleanup();
      await injected.cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("poolResolved / handleReady → RunContext 回调（journal 路径权威 + 运行中句柄回填）", async () => {
    const pools: string[] = [];
    const readies: Array<{ sessionRef: Record<string, string>; poolKey: string }> = [];
    const { engine, cleanup } = makeEngine(undefined, {
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([
          { op: "poolResolved", poolKey: "pool-9" },
          { op: "handleReady", sessionRef: { sessionId: "s-9" }, poolKey: "pool-9" },
        ]),
      ],
    });
    const { ctx } = makeCtx({
      onPoolResolved: (p: string) => pools.push(p),
      onHandleReady: (partial) => readies.push(partial),
    });
    const result = await engine.run({ prompt: "p" }, ctx);
    expect(pools).toEqual(["pool-9"]);
    expect(readies).toEqual([{ sessionRef: { sessionId: "s-9" }, poolKey: "pool-9" }]);
    // run 终态 handle 来自引擎应答（非 handleReady 的 partial——那是运行中回填通道）
    expect(result.handle.data.sessionRef).toEqual({ sessionId: "fake-session-run-1" });
    await cleanup();
  });
});

describe("abort 分级（cancel 帧 + 3s 收敛窗口）", () => {
  it("signal abort → cancel；引擎收敛（终态应答在窗口内）→ aborted 终态正常返回", async () => {
    const controller = new AbortController();
    const { engine, cleanup } = makeEngine(undefined, {
      args: [FAKE_ENGINE, "--cancel-settle", "1", "--run-hang", "1"],
    });
    const { ctx } = makeCtx({ signal: controller.signal });
    const runPromise = engine.run({ prompt: "p" }, ctx);
    setTimeout(() => controller.abort(), 100);
    const result = await runPromise;
    expect(result.outcome.error).toContain("engine_run_failed");
    expect(result.outcome.exitCode).toBeNull(); // 被信号杀死判据
    expect(result.handle.data.engineId).toBe("fake");
    await cleanup();
  }, 15_000);

  it("cancel 3s 未收敛 → 杀链 → run 合成 abort 终态（不 reject，EnginePort 契约）", async () => {
    const controller = new AbortController();
    const { engine, client, cleanup } = makeEngine(undefined, {
      args: [FAKE_ENGINE, "--run-hang", "1"], // 不收敛（FAKE_CANCEL_SETTLE 缺省 0）
    });
    const { ctx } = makeCtx({ signal: controller.signal });
    const runPromise = engine.run({ prompt: "p" }, ctx);
    await waitForReady(client); // abort 抢在连接完成前会打断握手重建循环——先等 ready
    const enginePid = client.enginePid!;
    controller.abort();
    const result = await runPromise; // ~3s 收敛窗口超时 → 杀链 → 合成终态
    expect(result.outcome.error).toContain("engine_run_failed");
    expect(result.outcome.error).toContain("aborted before terminal answer");
    expect(result.outcome.exitCode).toBeNull();
    await waitForTrue(() => isProcessAlive(enginePid) === false); // 杀链已执行
    await cleanup();
  }, 20_000);
});

describe("失败分界（运行中合成 vs prepare 期 reject）", () => {
  it("运行中引擎崩溃 → 合成 error outcome（engine_crashed）+ 正常 handle（record 必须收尾）", async () => {
    const { engine, cleanup } = makeEngine(undefined, {
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "exit", code: 137, stderr: "boom\n" }]),
      ],
    });
    const { ctx } = makeCtx();
    const result = await engine.run({ prompt: "p" }, ctx);
    expect(result.outcome.error).toContain("engine_crashed");
    expect(result.outcome.error).toContain("boom");
    expect(result.outcome.exitCode).toBeNull();
    expect(result.handle.data.v).toBe(1);
    expect(result.handle.data.poolKey).toBe("shared");
    await cleanup();
  });

  it("prepare 期失败（版本协商越界）→ reject，不产生 handle（进程创建前失败）", async () => {
    const { engine, cleanup } = makeEngine(undefined, {
      args: [FAKE_ENGINE, "--protocol-version", "99"],
    });
    const { ctx } = makeCtx();
    await expect(engine.run({ prompt: "p" }, ctx)).rejects.toMatchObject({
      code: "engine_protocol_mismatch",
    });
    await cleanup();
  }, 20_000);
});

describe("gate 位多声明 run 期判定（W3 契约⑤接线：manifest vs initialize 应答）", () => {
  it("多声明（manifest maxTurns true vs 引擎应答 false）→ run reject engine_capability_mismatch，run 帧未发出（无事件回显）", async () => {
    const { engine, cleanup } = makeEngine({
      capabilities: { ...FAKE_MATCHED_CAPS, maxTurns: true },
    });
    const { ctx, events } = makeCtx();
    await expect(engine.run({ prompt: "p" }, ctx)).rejects.toMatchObject({
      code: "engine_capability_mismatch",
    });
    expect(events).toHaveLength(0); // gate 拒在 run 帧发出前——引擎未收到 run
    await cleanup();
  });

  it("多声明（manifest sandbox emulated vs 引擎实态 none）→ 拒，错误消息含方向证据（manifest 声明 vs initialize 应答）", async () => {
    const { engine, cleanup } = makeEngine(undefined, {
      args: [FAKE_ENGINE, "--caps-override", JSON.stringify({ sandbox: "none" })],
    });
    const { ctx } = makeCtx();
    await expect(engine.run({ prompt: "p" }, ctx)).rejects.toThrowError(
      /manifest 声明的能力位 'sandbox（worktree）'（emulated）与引擎 initialize 应答不符（none）/,
    );
    await cleanup();
  });

  it("一致放行：manifest 与应答逐位一致 → run 正常完成（现有 run 帧映射用例同走此路径的显式锚点）", async () => {
    const { engine, cleanup } = makeEngine();
    const { ctx } = makeCtx();
    const result = await engine.run({ prompt: "p" }, ctx);
    expect(result.outcome.content).toBe("fake-content-run-1");
    await cleanup();
  });

  it("非 gate 位不一致（personaInjection manifest 'flag' vs 应答 'prompt'）→ 不阻断：run 完成 + 诊断面仅 warn 留痕", async () => {
    const manifestCaps = { ...FAKE_MATCHED_CAPS, personaInjection: "flag" as const };
    const { engine, cleanup } = makeEngine(
      { capabilities: manifestCaps },
      { manifestDiagnostics: { capabilities: manifestCaps } },
    );
    const warnSpy = vi.spyOn(getLogger("subagents"), "warn");
    const { ctx } = makeCtx();
    const result = await engine.run({ prompt: "p" }, ctx);
    expect(result.outcome.content).toBe("fake-content-run-1"); // 放行
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("differ from manifest"));
    warnSpy.mockRestore();
    await cleanup();
  });
});

describe("read / probe / dispose 门面（[H1 U6] interact 断言随 interact 面退役删除）", () => {
  it("read 协议帧携带 dataDir（必填：存量池时代相对 dbPath 定位）", async () => {
    const { engine, cleanup } = makeEngine();
    const view = await engine.read({
      data: {
        v: 1,
        engineId: "fake",
        sessionRef: { sessionId: "s-read" },
        poolKey: "shared",
        adapterVersion: "fake-adapter",
      },
    });
    expect(view.engineId).toBe("fake");
    expect(view.source).toBe("native");
    expect(view.turns).toHaveLength(1);
    await cleanup();
  });

  it("probe → ProbeReport；dispose → client 停机（幂等）", async () => {
    const { engine, cleanup } = makeEngine();
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toBe("fake-1.0.0");
    await engine.dispose();
    await expect(engine.dispose()).resolves.toBeUndefined(); // 幂等
    await cleanup();
  });

  it("host/askUser 经 RemoteEngine 门面（uiRequestHandler 由 EngineClient 承接）：请求形状 = UiRequest", async () => {
    const seenRequests: UiRequest[] = [];
    const { engine, cleanup } = makeEngine(undefined, {
      uiRequestHandler: async (req) => {
        seenRequests.push(req);
        return { confirmed: true };
      },
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "askUser", request: { method: "confirm", id: "q-facade" } }]),
      ],
    });
    const { ctx, events } = makeCtx();
    await engine.run({ prompt: "p" }, ctx);
    expect(seenRequests).toEqual([{ method: "confirm", id: "q-facade" }]);
    const echo = events.find(
      (e) => typeof (e as { message?: string }).message === "string"
        && (e as { message: string }).message.startsWith("askUser-result:"),
    ) as { message: string };
    expect(echo.message).toContain('"confirmed":true');
    await cleanup();
  });
});
