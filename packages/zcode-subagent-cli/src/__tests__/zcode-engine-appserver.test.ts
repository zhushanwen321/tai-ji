// zcode-engine-appserver.test.ts —— 引擎接线测试（2026-09 起单一 app-server 形态）：
// 全部跑 __fixtures__/fake-appserver.mjs 子进程（scenario 注入），绝不 spawn 真
// zcode.cjs。覆盖：事件时序前移（text_delta 流式 + 终态 message_end/turn_end +
// resolve 严格晚于末事件——不变量 2）/ usage 映射（与 parser.mapZcodeUsage 同源）/
// per-session model 透传 / 共享宿主 HOME（poolKey 恒 'shared'、HOME 正向透传、
// argv=app-server --cwd engineDataDir、无池 config/lockfile/pidfile）/
// onHandleReady 回调时点（create 应答后）与 onPoolResolved 时点（prepare 期，
// 先于首事件）/ abort 链 D3（stop 帧先发 → stop 优雅生效不杀进程 / stop 无效
// grace 耗尽 → killChain 连坐）/ 连接复用（跨任务 boot 1）/ dispose（幂等 /
// close 帧先于 SIGTERM / dispose 后 run 重建——不变量 4）/ 多会话并发不串线
// （RA3 地基，FAKE_STAMP_SESSION）/ -32603 Model config missing 错误归类 /
// capabilities 断言（eventGranularity 翻转无下游破坏的生产零消费方守卫）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineRunResult, RunContext } from "../port-types.ts";
import type { AgentEvent } from "@zhushanwen/subagent-engine-sdk";
import type { AgentCallOpts } from "../port-types.ts";
import { getLogger } from "@zhushanwen/subagent-engine-sdk";
import { ZCODE_SHARED_POOL_KEY } from "../constants.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { AppServerConnection } from "../connection.ts";
import { SessionChannel } from "../session-channel.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

/** 隔离会话 db 期望值的独立展开（①级读取钥匙）——刻意不 import 实现的
 * zcodeSessionDbPath（自指断言：实现改错时断言仍绿），路径知识独立于实现复述。 */
function expectedSessionDbPath(): string {
  return path.join(dataDir, "engines", "zcode", "session-db", "db.sqlite");
}

/** 与 zcode-engine.ts 同一 facade 单例引用（spy 它的方法即拦截引擎的 warn 出声）。 */
const subagentsLogger = getLogger("subagents");

const GOLDEN_SESSION_ID = "sess_golden_r3_01";
const GOLDEN_FULL_TEXT = "你好，任务完成";

interface RpcErrorSpec {
  code: number;
  message: string;
  data?: unknown;
}

interface EngineHandle_ {
  engine: ZcodeEngine;
  stateFile: string;
  workspace: string;
}

/** run 返回形态别名（abort 用例的中止终态断言面）。 */
type EngineRunResult_ = EngineRunResult;

const engines: ZcodeEngine[] = [];
let seq = 0;
let tmpRoot: string;
let dataDir: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-appserver-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  writeJson(v2Path, {
    provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
  });
});

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface ScenarioOverrides {
  dropTurnTerminal?: boolean;
  replaceSendPushes?: string[];
  createError?: RpcErrorSpec;
  /** send 应答 error 帧（运行中失败注入——-32004 会话 id 留痕用例）。 */
  sendError?: RpcErrorSpec;
  stopBehavior?: "terminal" | "none";
  stampSession?: boolean;
  /** 覆盖 read 应答（read 是全文权威来源——schema 用例须与收尾帧一致）。 */
  readResult?: unknown;
  /** 多会话用例：不覆盖 createResult/readResult（fake 缺省每会话独立 sess_<id> + read {messages:[]}）。 */
  distinctSessionIds?: boolean;
}

/** 建一个连到 fake 的引擎（scenario 文件随 env 固化进子进程；每测试独立 state 文件）。 */
function makeEngine(overrides: ScenarioOverrides = {}): EngineHandle_ {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  const pushes = (
    overrides.replaceSendPushes ?? [
      ...ZCODE_APPSERVER_GOLDEN.pushStream,
      ...(overrides.dropTurnTerminal ? [] : [ZCODE_APPSERVER_GOLDEN.terminal[0]]),
      ZCODE_APPSERVER_GOLDEN.terminal[1],
    ]
  ).map((l) => (typeof l === "string" ? (JSON.parse(l) as Record<string, unknown>) : l));
  writeJson(scenarioFile, {
    ...(overrides.distinctSessionIds === true
      ? {}
      : {
          createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
          readResult: overrides.readResult ?? JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
        }),
    sendPushes: pushes,
    ...(overrides.stopBehavior !== undefined ? { stopBehavior: overrides.stopBehavior } : {}),
    ...(overrides.createError !== undefined ? { createError: overrides.createError } : {}),
    ...(overrides.sendError !== undefined ? { sendError: overrides.sendError } : {}),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      HOME: "/fake-host-home",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
      ...(overrides.stampSession === true ? { FAKE_STAMP_SESSION: "1" } : {}),
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile, workspace };
}

// ── 流水读取 helpers（与 session-channel.test.ts 同款） ──

interface StateEvent {
  seq: number;
  ev: string;
  [key: string]: unknown;
}

function readState(file: string): StateEvent[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StateEvent);
  } catch {
    return [];
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sentFrames(stateFile: string, method: string): Array<{ id: number; params: Record<string, unknown> }> {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter(
      (f): f is { id: number; params: Record<string, unknown> } =>
        isRecord(f) && f.method === method && isRecord(f.params) && typeof f.id === "number",
    );
}

function sentMethods(stateFile: string): string[] {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.method === "string")
    .map((f) => f.method as string);
}

function bootCount(stateFile: string): number {
  return readState(stateFile).filter((e) => e.ev === "boot").length;
}

function bootEnv(stateFile: string): Record<string, unknown> {
  const env = readState(stateFile).find((e) => e.ev === "env");
  return isRecord(env) ? env : {};
}

function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-appserver", poolKey: "", ...overrides };
}

// ============================================================
// 事件时序前移 + usage 映射 + 句柄回调时点（不变量 2/3）
// ============================================================

describe("事件流与回调时点（缺省 appserver 路径）", () => {
  it("text_delta 逐个实时流出 + 终态 message_end(usage)/turn_end + resolve 严格晚于末事件", async () => {
    const { engine, workspace } = makeEngine();
    const order: string[] = [];
    const events: AgentEvent[] = [];
    const { handle, outcome } = await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({
        onEvent: (e) => {
          events.push(e);
          order.push(e.type);
        },
      }),
    );
    order.push("resolve");
    expect(order).toEqual([
      "text_delta",
      "text_delta",
      "text_delta",
      "message_end",
      "turn_end",
      "resolve",
    ]);
    // text_delta 逐字（golden pushStream 的三条 session/event delta）
    expect(events[0]).toEqual({ type: "text_delta", delta: "你好" });
    expect(events[1]).toEqual({ type: "text_delta", delta: "，" });
    expect(events[2]).toEqual({ type: "text_delta", delta: "任务完成" });
    // message_end.usage：收尾帧 usage 经 parser.mapZcodeUsage 同源映射
    expect(events[3]).toEqual({
      type: "message_end",
      usage: { input: 12599, output: 17, cacheRead: 0, cacheWrite: 0 },
    });
    expect(events[4]).toEqual({ type: "turn_end" });

    // outcome：content == 全文；usage（orchestration 版，mapZcodeOutcomeUsage 同源）
    expect(outcome.error).toBeUndefined();
    expect(outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(outcome.sessionId).toBe(GOLDEN_SESSION_ID);
    expect(outcome.usage).toEqual({ input: 12599, output: 17, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
    expect(outcome.exitCode).toBe(0);

    // handle 锚定：poolKey 恒 'shared'，sessionRef.dbPath = 隔离会话库绝对路径
    // （期望值独立展开，见 expectedSessionDbPath 注释——不调实现函数）
    expect(handle.data.poolKey).toBe(ZCODE_SHARED_POOL_KEY);
    expect(handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: expectedSessionDbPath() });
    expect(String(handle.data.sessionRef["dbPath"]).startsWith("/")).toBe(true);
  }, 15_000);

  it("[PR3] 工具执行期活性接线：turn 中途 tool.updated progress 帧 → ctx.onEvent 收到 {type:'activity'}（零载荷严格相等）", async () => {
    // 真机探针实证（/tmp/zcode-activity-probe.log，2026-09-10）：工具执行期
    // session/event 每隔 ~1.0s 推 {type:"tool.updated", payload:{kind:"progress",…}}
    // ——既非 final-frame 也非 delta。宿主刷新面只有 delta 事件，该帧族必须经
    // activity 变体透出，否则「仅工具执行、零正文」形态下宿主 30min 中段无进展
    // 守护饿死误杀。引擎接线 = channel onActivity → ctx.onEvent({type:"activity"})。
    const toolUpdatedProgress = JSON.stringify({
      method: "session/event",
      params: {
        sessionId: GOLDEN_SESSION_ID,
        type: "tool.updated",
        payload: {
          toolCallId: "call_e914fc9643b7459da05127a6",
          toolName: "Bash",
          elapsedMs: 2134,
          pid: 2824,
          stdoutBytes: 11,
          stdoutTail: "progress-1\n",
          kind: "progress",
        },
      },
    });
    const { engine, workspace } = makeEngine({
      replaceSendPushes: [
        ...ZCODE_APPSERVER_GOLDEN.pushStream,
        toolUpdatedProgress,
        ZCODE_APPSERVER_GOLDEN.terminal[0],
        ZCODE_APPSERVER_GOLDEN.terminal[1],
      ],
    });
    const events: AgentEvent[] = [];
    const { outcome } = await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({ onEvent: (e) => events.push(e) }),
    );
    expect(outcome.error).toBeUndefined();
    // activity 事件恰一次（一帧一事件）、零载荷字段面严格相等（无多余键）
    const activities = events.filter((e) => e.type === "activity");
    expect(activities).toHaveLength(1);
    expect(activities[0]).toStrictEqual({ type: "activity" });
    // 事件序：activity 夹在 delta 流与终态合成事件之间（turn 中途到达）
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "text_delta",
      "text_delta",
      "activity",
      "message_end",
      "turn_end",
    ]);
  }, 15_000);

  it("回调时点：onPoolResolved（prepare 期）先于 onHandleReady（create 应答后）先于首事件", async () => {
    const { engine, workspace } = makeEngine();
    const order: string[] = [];
    await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({
        onPoolResolved: (k) => order.push(`pool:${k}`),
        onHandleReady: (partial) => order.push(`handle:${partial.poolKey}:${partial.sessionRef["sessionId"]}`),
        onEvent: (e) => {
          if (e.type === "text_delta" && order[order.length - 1] !== "event") order.push("event");
        },
      }),
    );
    expect(order[0]).toBe(`pool:${ZCODE_SHARED_POOL_KEY}`);
    expect(order[1]).toBe(`handle:${ZCODE_SHARED_POOL_KEY}:${GOLDEN_SESSION_ID}`);
    expect(order[2]).toBe("event");
  }, 15_000);

  it("共享宿主 HOME：HOME 正向透传、遥测关、argv=app-server --cwd engineDataDir、无池 config/lockfile/pidfile、onChildSpawned 零调用", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    const onChildSpawned = vi.fn();
    const { handle } = await engine.run(makeTask({ cwd: workspace }), makeCtx({ onChildSpawned }));
    expect(handle.data.poolKey).toBe(ZCODE_SHARED_POOL_KEY);
    // fake 侧 boot env：base env 携带的宿主 HOME 值原样透传（buildAppServerEnv 不覆写
    // HOME 键——launcher 同进程 import() 也不改 env）、遥测 false、统一嵌套标记
    const env = bootEnv(stateFile);
    expect(env["home"]).toBe("/fake-host-home");
    expect(env["telemetry"]).toBe("false");
    expect(env["unifiedNested"]).toBe("1");
    const boot = readState(stateFile).find((e) => e.ev === "boot");
    expect(boot?.["argv"]).toEqual(["app-server", "--cwd", dataDir]);
    // D6：app-server 常驻进程是引擎自管资源（dispose 收割），不进宿主终止链——
    // run 全程 onChildSpawned 不被调用（宿主 killAll 不误杀共享进程）
    expect(onChildSpawned).not.toHaveBeenCalled();
    // 池化时代的产物全部不存在：engines/zcode/ 只含 fs 拦截 launcher 与 session-db/
    // 会话库目录（session-db/ 为 2026-09 会话库隔离新增，W1），无池
    // config/lockfile/pidfile/journal 目录。两侧排序后比较，防 readdir 顺序不稳定
    const engineDir = fs.readdirSync(path.join(dataDir, "engines", "zcode"));
    expect([...engineDir].sort()).toEqual(["appserver-launcher.cjs", "session-db"].sort());
  }, 15_000);

  it("maxTurns（pi 专属）→ 引擎内不再拒绝（[D3-④] 能力拒绝上提宿主 capability-gate，防双轨拦截复活）", async () => {
    // [D3-④ 合并注] capability 拒绝唯一实现 = common/capability-gate（两调用点 = chat 域
    // executeViaEngine 同步段 + SAR run 前，拒绝语义 engine_capability_unsupported 由
    // capability-gate.test.ts 承载）。引擎域 run() 不做 shape 检查——本用例反转回归面：
    // maxTurns 直传引擎不得再被拒（曾因引擎内残留拦截与 gate 形成双轨）。
    const { engine, stateFile, workspace } = makeEngine();
    const r = await engine.run(makeTask({ cwd: workspace, maxTurns: 10 }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    // 正常走 app-server 流程（create×1——maxTurns 对 zcode 无通道，静默不透传）
    expect(sentFrames(stateFile, "session/create")).toHaveLength(1);
  }, 10_000);

  it("per-session model：create 帧 model={providerId,modelId}（task.model 拆分）+ toolDenylist 透传", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace, denyTools: ["bash", ""] }), makeCtx());
    const create = sentFrames(stateFile, "session/create")[0];
    expect(create.params["model"]).toEqual({ providerId: PROVIDER, modelId: "m1" });
    expect(create.params["toolDenylist"]).toEqual(["bash"]); // 空串过滤
    expect(create.params["workspace"]).toMatchObject({ workspacePath: workspace });
    expect(create.params["mode"]).toBe("yolo");
  }, 15_000);

  it("thinkingLevel → create 帧 thoughtLevel 透传（F15a：task 声明映射协议通道）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace, thinkingLevel: "high" }), makeCtx());
    const create = sentFrames(stateFile, "session/create")[0];
    expect(create.params["thoughtLevel"]).toBe("high");
  }, 15_000);

  it("thinkingLevel 未传/空白 → create 帧无 thoughtLevel 键（A.2 ① strict 对象不设空键，防 -32602）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace, thinkingLevel: "  " }), makeCtx());
    const create = sentFrames(stateFile, "session/create")[0];
    expect("thoughtLevel" in create.params).toBe(false);
  }, 15_000);

  it("thinkingLevel=medium（非常见档位）→ warn 一行提示且 thoughtLevel 键仍透传（RX2-F1：提示不拦截）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    const warns: string[] = [];
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(((msg: string) => {
      warns.push(msg);
    }) as typeof subagentsLogger.warn);
    try {
      await engine.run(makeTask({ cwd: workspace, thinkingLevel: "medium" }), makeCtx());
    } finally {
      warnSpy.mockRestore();
    }
    // 提示恰一行；措辞是「若不支持将被忽略/回落」的或然警告（core 不做权威值域断言）
    const hits = warns.filter((m) => m.includes("thoughtLevel"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("medium");
    expect(hits[0]).toContain("将被忽略/回落");
    expect(hits[0]).toContain("low/high/max");
    // 透传不拦截：create 帧仍带原值（off/minimal/medium/xhigh 全放行）
    const create = sentFrames(stateFile, "session/create")[0];
    expect(create.params["thoughtLevel"]).toBe("medium");
  }, 15_000);

  it("thinkingLevel=high（常见档位）→ 零 thoughtLevel 提示（RX2-F1：常见档位不出声）", async () => {
    const { engine, workspace } = makeEngine();
    const warns: string[] = [];
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(((msg: string) => {
      warns.push(msg);
    }) as typeof subagentsLogger.warn);
    try {
      await engine.run(makeTask({ cwd: workspace, thinkingLevel: "high" }), makeCtx());
    } finally {
      warnSpy.mockRestore();
    }
    expect(warns.filter((m) => m.includes("thoughtLevel"))).toHaveLength(0);
  }, 15_000);

  it("task.model 缺省 + ctx.ctxModel 存在 → 出声留痕（F16b：ctxModel 是 pi 链路兜底，zcode 落自身缺省链）", async () => {
    // v2 config 补缺省模型 provider 条目——ZCODE_FALLBACK_DEFAULT_MODEL 的解析链才可校验通过
    writeJson(v2Path, {
      provider: {
        [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } },
        "builtin:bigmodel-coding-plan": { options: { apiKey: "k" }, models: { "GLM-5.3": {} } },
      },
    });
    const { engine, workspace } = makeEngine();
    const warns: Array<{ msg: string; data: unknown }> = [];
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(((msg: string, data: unknown) => {
      warns.push({ msg, data });
    }) as typeof subagentsLogger.warn);
    try {
      const { outcome } = await engine.run(
        makeTask({ cwd: workspace, model: undefined }),
        makeCtx({ ctxModel: { id: "main-model", name: "Main", provider: "p", reasoning: false } }),
      );
      expect(outcome.error).toBeUndefined(); // 信号不阻断任务
      const hit = warns.find((w) => w.msg.includes("ctxModel"));
      expect(hit).toBeDefined();
      expect(hit?.msg).toContain("main-model");
      expect(hit?.msg).toContain("builtin:bigmodel-coding-plan/GLM-5.3");
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("显式 task.model 或 ctx 无 ctxModel → 零 ctxModel 信号（F16b：只在「ctx 有模型但被忽略」时出声）", async () => {
    // 第二段 run（model 缺省）走引擎缺省链——v2 config 需含 ZCODE_FALLBACK_DEFAULT_MODEL 的 provider
    writeJson(v2Path, {
      provider: {
        [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } },
        "builtin:bigmodel-coding-plan": { options: { apiKey: "k" }, models: { "GLM-5.3": {} } },
      },
    });
    const { engine, workspace } = makeEngine();
    const warns: string[] = [];
    const warnSpy = vi.spyOn(subagentsLogger, "warn").mockImplementation(((msg: string) => {
      warns.push(msg);
    }) as typeof subagentsLogger.warn);
    try {
      // 显式 task.model + ctxModel：走正常解析链，不出声
      await engine.run(makeTask({ cwd: workspace }), makeCtx({ ctxModel: { id: "main-model", name: "Main", provider: "p", reasoning: false } }));
      // model 缺省 + ctx 无 ctxModel：预期缺省链，不出声
      await engine.run(makeTask({ cwd: workspace, model: undefined }), makeCtx());
      expect(warns.filter((m) => m.includes("ctxModel"))).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("schema 任务：appserver 路径同接 schema 仿真（合法 JSON → parsedOutput）", async () => {
    const finalText = '{"verdict":"ok"}';
    const { engine, workspace } = makeEngine({
      replaceSendPushes: buildJsonPushes(finalText),
      // read 是全文权威来源——须与收尾帧一致（否则 read 兜底覆盖掉 JSON 全文）
      readResult: { messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: finalText }] }] },
    });
    const { outcome } = await engine.run(
      makeTask({ cwd: workspace, schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } }),
      makeCtx(),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.parsedOutput).toEqual({ verdict: "ok" });
  }, 15_000);

  it("schema 失败重试一轮：两会话两 send（重试轮独立 create），usage 两轮累计", async () => {
    const { engine, stateFile, workspace } = makeEngine({
      replaceSendPushes: buildJsonPushes("I think everything is fine."),
    });
    // 重试轮仍返回非 JSON（scenario 固化）→ 两轮均失败 → schema_emulation_failed
    const { outcome } = await engine.run(
      makeTask({ cwd: workspace, schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } }),
      makeCtx(),
    );
    expect(outcome.error).toContain("schema_emulation_failed");
    expect(sentFrames(stateFile, "session/create")).toHaveLength(2);
    expect(sentFrames(stateFile, "session/send")).toHaveLength(2);
    // 重试 prompt 带强化指令
    const sends = sentFrames(stateFile, "session/send");
    expect(String(sends[1]?.params["content"])).toContain("Retry: Structured Output Failed");
  }, 15_000);

  it("-32603 'Model config is missing' → engine_credential_missing 归类（outcome 不 reject）", async () => {
    const { engine, workspace } = makeEngine({
      createError: { code: -32603, message: "Model config is missing" },
    });
    const { outcome } = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(outcome.error).toContain("engine_credential_missing");
    expect(outcome.error).toContain("Model config is missing");
  }, 15_000);

  it("create 漂移错误（-32602）→ run-failed outcome 透传 code（R5 降级链地基）", async () => {
    const { engine, workspace } = makeEngine({
      createError: { code: -32602, message: "Invalid params", data: [{ path: ["model"] }] },
    });
    const { outcome } = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(outcome.error).toContain("engine_run_failed");
    expect(outcome.error).toContain("-32602");
  }, 15_000);

  it("-32004 运行中失败 → outcome/handle/错误文案携带会话 id（错误规格表：按任务失败上报含会话 id）", async () => {
    // create 成功（golden 会话）后 send 阶段失败——会话已建立，失败上报必须留痕 id
    const { engine, workspace } = makeEngine({
      sendError: { code: -32004, message: "Session is not active" },
    });
    const { handle, outcome } = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(outcome.error).toContain("engine_run_failed");
    expect(outcome.error).toContain("-32004");
    expect(outcome.error).toContain(GOLDEN_SESSION_ID);
    expect(outcome.sessionId).toBe(GOLDEN_SESSION_ID);
    expect(handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: expectedSessionDbPath() });
  }, 15_000);
});

// ============================================================
// abort 链（D3：stop → grace → killChain；stop 成功不 kill）
// ============================================================

describe("abort 链（D3）", () => {
  /** 无终态推送的挂起场景（仅 state.updated——turn 永不自然落定；scenario 每引擎
   * 固化，故「后续任务」同样挂起——复用形态断言用再次 abort 收口，不 await 自然终态）。 */
  const hangPushes = [ZCODE_APPSERVER_GOLDEN.pushStream[0]];

  /** 挂起场景下发起第 N 轮并推进到该轮 create+send 已达（轮次按 create 帧计数——
   * 全局 send 计数会被上一轮命中，waitFor 会假通过）。 */
  async function startHangRun(
    engine: ZcodeEngine,
    workspace: string,
    stateFile: string,
    taskId: string,
  ): Promise<{ run: Promise<EngineRunResult_>; controller: AbortController }> {
    const controller = new AbortController();
    const before = sentFrames(stateFile, "session/create").length;
    const run = engine.run(makeTask({ cwd: workspace }), makeCtx({ taskId, signal: controller.signal }));
    await vi.waitFor(
      () => expect(sentFrames(stateFile, "session/create").length).toBeGreaterThan(before),
      { timeout: 5_000 },
    );
    await vi.waitFor(
      () => expect(sentFrames(stateFile, "session/send").length).toBeGreaterThan(before),
      { timeout: 5_000 },
    );
    return { run, controller };
  }

  it("stop 优雅生效：stop 帧先发（send 之后）→ 终态在 grace 内到达 → 不杀共享进程（第二轮零重启）", async () => {
    // stopBehavior 缺省 'terminal'：fake 收到 stop 即推该会话终态
    const { engine, stateFile, workspace } = makeEngine({ replaceSendPushes: [...hangPushes] });
    // 第一轮：挂起 → abort → stop 推终态 → 优雅收口
    const first = await startHangRun(engine, workspace, stateFile, "sa-a1");
    first.controller.abort();
    const r1 = await first.run;
    expect(r1.outcome.exitCode).toBeNull();
    expect(r1.outcome.error).toContain("session/stop");
    // 帧序：send 之后紧跟 stop（stop 帧先于任何杀链动作）
    const methods = sentMethods(stateFile);
    expect(methods.indexOf("session/stop")).toBeGreaterThan(methods.indexOf("session/send"));
    // 不杀共享进程：同引擎第二轮（同挂起场景）再 abort 一次——进程若被杀必 boot 2，
    // 存活则 boot 计数仍 1（常驻进程跨任务复用的机制性证据）
    const second = await startHangRun(engine, workspace, stateFile, "sa-a2");
    second.controller.abort();
    const r2 = await second.run;
    expect(r2.outcome.exitCode).toBeNull();
    expect(bootCount(stateFile)).toBe(1);
  }, 30_000);

  it("stop 无效（stopBehavior none + 无终态）→ grace 耗尽 → killChain 收割共享进程 → 崩溃路径收口 + 重建", async () => {
    const { engine, stateFile, workspace } = makeEngine({
      replaceSendPushes: [...hangPushes],
      stopBehavior: "none",
    });
    const first = await startHangRun(engine, workspace, stateFile, "sa-k1");
    first.controller.abort();
    const r1 = await first.run;
    expect(r1.outcome.exitCode).toBeNull();
    expect(r1.outcome.error).toContain("session/stop");
    // killChain 生效：第二轮自动重建（boot 2——进程死后重建路径，不变量 4 同源）
    const second = await startHangRun(engine, workspace, stateFile, "sa-k2");
    second.controller.abort();
    const r2 = await second.run;
    expect(r2.outcome.exitCode).toBeNull();
    expect(bootCount(stateFile)).toBe(2);
  }, 40_000);

  it("pre-aborted signal：短路返回中止终态——不建会话不发任何帧（防误杀共享进程）；onPoolResolved 先于 error 事件（不变量 3）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    const controller = new AbortController();
    controller.abort();
    const order: string[] = [];
    const { handle, outcome } = await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({
        signal: controller.signal,
        onPoolResolved: (k) => order.push(`pool:${k}`),
        onEvent: (e) => order.push(`event:${e.type}`),
      }),
    );
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("session/stop");
    expect(handle.data.sessionRef["sessionId"]).toBeUndefined();
    // 不变量 3：poolKey 声明先于首个事件（error）——journal writer 重定向先于落盘，
    // 落盘池与 handle.poolKey 同值同源（短路分支不满足即落 shared 占位池漂移）
    expect(order).toEqual([`pool:${ZCODE_SHARED_POOL_KEY}`, "event:error"]);
    expect(handle.data.poolKey).toBe(ZCODE_SHARED_POOL_KEY);
    expect(readState(stateFile)).toHaveLength(0); // 连惰性启动都没触发
  }, 10_000);

  it("宿主超时 abort（reason 标记）→ engine_timeout 公共合成终态（对齐点④，appserver 同语义）", async () => {
    const { engine, workspace } = makeEngine({ replaceSendPushes: [...hangPushes], stopBehavior: "none" });
    const controller = new AbortController();
    controller.abort("agent-call-timeout");
    const { outcome } = await engine.run(makeTask({ cwd: workspace }), makeCtx({ signal: controller.signal }));
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("engine_timeout");
  }, 10_000);
});

// ============================================================
// 连接复用（共享宿主 HOME：无凭据刷新机制——登录态轮换后常驻连接用旧凭据，
// 引擎进程重启才生效；跨任务连接复用本身仍是 D1 不变量）
// ============================================================

describe("连接复用", () => {
  it("第二任务复用常驻连接（boot 1），两会话独立 create", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(bootCount(stateFile)).toBe(1);
    expect(sentFrames(stateFile, "session/create")).toHaveLength(2);
  }, 20_000);
});

// ============================================================
// dispose（D6 主体：幂等 / close 帧先于 SIGTERM / dispose 后 run 重建）
// ============================================================

describe("dispose", () => {
  it("在途会话：close 帧发出（fake 收到且记入流水）→ 进程收割 → 挂起任务走崩溃路径收口", async () => {
    const { engine, stateFile, workspace } = makeEngine({
      replaceSendPushes: [ZCODE_APPSERVER_GOLDEN.pushStream[0]], // 挂起不落定
    });
    const runPromise = engine.run(makeTask({ cwd: workspace }), makeCtx());
    await vi.waitFor(() => expect(sentFrames(stateFile, "session/send")).toHaveLength(1), { timeout: 5_000 });
    await engine.dispose();
    const { outcome } = await runPromise;
    // 挂起任务被崩溃路径收割（连接死亡 → failAllTurns → run-failed outcome）
    expect(outcome.error).toContain("engine_run_failed");
    // close 帧确实发出（fake 必须活着才能记流水——SIGTERM 先发则该帧大概率丢失，
    // 帧在流水里即证明 close 先于进程死亡送达）
    const closeFrames = sentFrames(stateFile, "session/close");
    expect(closeFrames).toHaveLength(1);
    expect(closeFrames[0]?.params["sessionId"]).toBe(GOLDEN_SESSION_ID);
    // 帧序：close 在 send 之后（在途会话的收尾）
    const methods = sentMethods(stateFile);
    expect(methods.indexOf("session/close")).toBeGreaterThan(methods.indexOf("session/send"));
    // 预算说明：waitFor ≤5s + killChain grace 5s + fake SIGTERM 100ms 排空窗口，套件
    // 并发负载下 20s 偶发超限（正常完成 ~10s），放宽到 30s 防环境性 flake
  }, 30_000);

  it("幂等：连续两次 dispose 第二次零副作用；无运行时时 dispose 是 no-op", async () => {
    const { engine } = makeEngine();
    await engine.dispose(); // 从未 run——no-op
    const { engine: e2, stateFile, workspace } = makeEngine();
    await e2.run(makeTask({ cwd: workspace }), makeCtx());
    await e2.dispose();
    const boots = bootCount(stateFile);
    await e2.dispose();
    expect(bootCount(stateFile)).toBe(boots); // 无新 boot、无重复杀
  }, 15_000);

  it("dispose 后首个 run 自动重建（与进程死后重建同路径——不变量 4）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(bootCount(stateFile)).toBe(1);
    await engine.dispose();
    const second = await engine.run(makeTask({ cwd: workspace }), makeCtx());
    expect(second.outcome.error).toBeUndefined();
    expect(second.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(bootCount(stateFile)).toBe(2);
  }, 15_000);

  it("窄竞态守卫：进程已死（child=null）但 activeSessions 残留时，dispose 不经 post 惰性拉起新进程（D6 防泄漏）", async () => {
    // 真实微拍窗口（进程死亡收割与 activeSessions 清理之间的 microtask）不可从公开
    // 面同步注入——白盒构造同形态快照：runtime 的 conn 无活进程、activeSessions 非空。
    // 守卫缺失时 dispose 循环 post("session/close") 会 ensureStarted 惰性 spawn 一代新
    // 进程再被同次 dispose 杀掉（onSpawned 同步触发）；守卫生效时永不 spawn。
    // 观测面用 conn.onSpawned（spawnGeneration 内同步调用）而非 fake 侧 boot 计数：
    // post 后紧接 SIGTERM，新进程来不及写 boot 即死，写盘时序不可靠。
    const { engine } = makeEngine();
    let spawned = false;
    const conn = new AppServerConnection({
      cliPath: FAKE_CLI,
      cwd: tmpRoot,
      env: {
        PATH: process.env.PATH ?? "",
        FAKE_STATE_FILE: path.join(tmpRoot, "state-dispose-guard.jsonl"),
        FAKE_SESSION_SCENARIO: path.join(tmpRoot, "scenario-dispose-guard.json"),
      },
      stderrLogPath: path.join(dataDir, "logs", "dispose-guard-stderr.log"),
      onSpawned: () => {
        spawned = true;
      },
    });
    const ghostRt = {
      conn,
      channel: new SessionChannel(conn),
      activeSessions: new Set<string>(["sess_ghost"]),
    };
    (engine as unknown as { appserverRuntime: unknown }).appserverRuntime = ghostRt;
    expect(conn.alive).toBe(false); // 快照前置：无活进程
    await engine.dispose();
    expect(spawned).toBe(false); // 守卫生效：close 帧循环跳过，零惰性 spawn
  }, 15_000);
});

// ============================================================
// 多会话并发（RA3 双会话地基：FAKE_STAMP_SESSION——推送按会话归因）
// ============================================================

describe("多会话并发（单常驻进程双会话不串线）", () => {
  it("并发两 runTurn：各自 sessionId/事件流/结果独立，boot 计数 1（同进程共享）", async () => {
    // distinctSessionIds：fake 缺省 create 应答每会话独立 sess_<请求id>；stamp 后
    // 推送按目标会话归因（telemetry 帧补 sid——并发下不再依赖「唯一在途」兜底）
    const { engine, stateFile, workspace } = makeEngine({ stampSession: true, distinctSessionIds: true });
    const eventsA: AgentEvent[] = [];
    const eventsB: AgentEvent[] = [];
    const [a, b] = await Promise.all([
      engine.run(makeTask({ cwd: workspace }), makeCtx({ taskId: "sa-a", onEvent: (e) => eventsA.push(e) })),
      engine.run(makeTask({ cwd: workspace }), makeCtx({ taskId: "sa-b", onEvent: (e) => eventsB.push(e) })),
    ]);
    expect(a.outcome.error).toBeUndefined();
    expect(b.outcome.error).toBeUndefined();
    expect(a.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(b.outcome.content).toBe(GOLDEN_FULL_TEXT);
    // 两会话 sessionId 独立（fake 缺省 sess_<请求id>）——不串线
    expect(a.outcome.sessionId).toMatch(/^sess_\d+$/);
    expect(b.outcome.sessionId).toMatch(/^sess_\d+$/);
    expect(a.outcome.sessionId).not.toBe(b.outcome.sessionId);
    // 各自的 delta 流完整（三条全到，无串扰丢失）
    expect(eventsA.filter((e) => e.type === "text_delta")).toHaveLength(3);
    expect(eventsB.filter((e) => e.type === "text_delta")).toHaveLength(3);
    // 两会话的 handle 各归各
    expect(a.handle.data.sessionRef["sessionId"]).toBe(a.outcome.sessionId);
    expect(b.handle.data.sessionRef["sessionId"]).toBe(b.outcome.sessionId);
    const creates = sentFrames(stateFile, "session/create");
    expect(creates).toHaveLength(2);
    // 两会话的 send/subscribe/read/close 各自指向自己的 sessionId（通道帧不串线）
    const sendSids = sentFrames(stateFile, "session/send").map((f) => f.params["sessionId"]);
    expect(new Set(sendSids).size).toBe(2);
    expect(sendSids.sort()).toEqual([a.outcome.sessionId, b.outcome.sessionId].sort());
    expect(bootCount(stateFile)).toBe(1);
  }, 20_000);
});

// ============================================================
// capabilities（D5）+ eventGranularity 生产零消费方守卫
// ============================================================

describe("capabilities（D5：仅 eventGranularity 变）", () => {
  it("单一 app-server 形态声明 eventGranularity='stream'，其余能力位与设计声明一致", () => {
    const { engine } = makeEngine();
    expect(engine.capabilities()).toEqual({
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "unsupported",
      personaInjection: "prompt",
      eventGranularity: "stream",
      sandbox: "none",
      sessionRead: "full",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: false,
    });
  });

  it("eventGranularity 生产零消费方守卫：src 内（测试除外）无任何能力位读取访问（翻转无下游破坏）", () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
    const consumerAccess = /\.(capabilities\(\)|caps|capabilities)\.eventGranularity\b/g;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          consumerAccess.lastIndex = 0;
          if (consumerAccess.test(text)) offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

// ── 内部 helper ──

/** 造一组「delta 流 + 收尾帧 + read 应答」的 JSON 输出推送（schema 仿真用例）。 */
function buildJsonPushes(finalText: string): string[] {
  return [
    ZCODE_APPSERVER_GOLDEN.pushStream[0],
    ZCODE_APPSERVER_GOLDEN.pushStream[1],
    ZCODE_APPSERVER_GOLDEN.pushStream[2],
    JSON.stringify({
      method: "v4/telemetry/event",
      params: { kind: "turn.terminal", status: "success" },
    }),
    JSON.stringify({
      method: "session/event",
      params: { sessionId: GOLDEN_SESSION_ID, payload: { response: finalText } },
    }),
  ];
}
