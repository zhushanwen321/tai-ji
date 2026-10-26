// zcode-engine.test.ts —— zcode-engine 集成测试合并产物（round5-F C01 簇）。
// 全部跑 __fixtures__/fake-appserver.mjs 子进程（scenario 注入），绝不 spawn 真
// zcode.cjs。簇内共享基础设施（tmp 夹具、流水读取 helpers、顶层 hook）统一置于
// 文件头；各来源分节以「来源：<基名>」注释分隔，分节内私有 helper 按来源加前缀
// 消歧（语义保形：describe/it 原样、断言与用例名零改动）。
//
// 来源文件：
//   - zcode-engine-appserver.test.ts（引擎接线主套件：事件时序/usage/model 透传/
//     reasoningLevel 择档/abort 链/连接复用/dispose/多会话并发/capabilities）
//   - zcode-engine-degrade.test.ts（appserver 错误分类回归门）
//   - zcode-engine-dispose.test.ts（P0-1 U5 dispose 收割）
//   - zcode-engine-resume.test.ts（interact(resume) 引擎侧单测）
//   - zcode-engine-retry.test.ts（P0-1 U4 瞬时失败自动重试一次）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineRunResult, RunContext } from "../port-types.ts";
import type { AgentCallOpts } from "../port-types.ts";
import type { AgentEvent } from "@zhushanwen/subagent-engine-sdk";
import { getLogger } from "@zhushanwen/subagent-engine-sdk";
import {
  ZCODE_APPSERVER_HARVEST_GRACE_MS,
  ZCODE_KILL_GRACE_MS,
} from "../constants.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { buildResumeInjectionSegment, buildResumeUnavailableNoticeSegment } from "../zcode-engine.ts";
import { extractResumeHistory, extractResumeTotalTokens, type ResumedHistoryTurn } from "../session-channel.ts";
import { AppServerConnection } from "../connection.ts";
import { SessionChannel } from "../session-channel.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

// ── 簇内共享常量与状态（各来源同款同名，同值合一） ──

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";
const GOLDEN_SESSION_ID = "sess_golden_r3_01";
const GOLDEN_FULL_TEXT = "你好，任务完成";
/** 挂起场景：send 后零推送——turn 无事件无终态（dispose 收割 / crash 收割的形态前提）。 */
const HANG_PUSHES: string[] = [];

const engines: ZcodeEngine[] = [];
let seq = 0;
let tmpRoot: string;
let dataDir: string;
let v2Path: string;
let personalPath: string;

// ── 簇内共享 helpers（各来源同款，语义等价合一） ──

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

interface StateEvent { // oe-exempt:20261026:test:测试事件序列形态（合并产物内局部类型，非对外契约）
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

function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

// ── 簇内共享顶层 hook（各来源同款 beforeEach/afterEach 统一：mkdtemp 前缀合并、
//    afterEach 取超集——vi.unstubAllEnvs 对无 stub 的来源是 no-op） ──

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-engine-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  personalPath = path.join(tmpRoot, "personal.json");
  writeJson(v2Path, {
    provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
  });
  writeJson(personalPath, {
    config: {
      providerOrder: [PROVIDER],
      providerConfigRules: {
        providerRules: [
          { providerId: PROVIDER, providerName: "t", config: { access: { type: "api-key", apiKey: "k" }, personalModelIds: ["m1"] } },
        ],
      },
    },
  });
});

afterEach(async () => {
  vi.unstubAllEnvs(); // abort grace 注入缝等 env stub 逐用例复原（不泄漏到同文件后续用例）
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ══════════════════════════════════════════════════════════════
// 来源：zcode-engine-appserver.test.ts —— 引擎接线测试（2026-09 起单一
// app-server 形态）。覆盖：事件时序前移（text_delta 流式 + 终态
// message_end/turn_end + resolve 严格晚于末事件——不变量 2）/ usage 映射（与
// parser.mapZcodeUsage 同源）/ per-session model 透传 / 共享宿主 HOME（poolKey
// 恒 'shared'、HOME 正向透传、argv=app-server --cwd engineDataDir、无池
// config/lockfile/pidfile）/ onHandleReady 回调时点（create 应答后）/ abort 链
// D3（stop 帧先发 → stop 优雅生效不杀进程 / stop 无效 grace 耗尽 → killChain
// 连坐）/ 连接复用（跨任务 boot 1）/ dispose（幂等 / close 帧先于 SIGTERM /
// dispose 后 run 重建——不变量 4）/ 多会话并发不串线（RA3 地基，
// FAKE_STAMP_SESSION）/ -32603 Model config missing 错误归类 / capabilities
// 断言（eventGranularity 翻转无下游破坏的生产零消费方检查）。
// ══════════════════════════════════════════════════════════════

/** 隔离会话 db 期望值的独立展开（①级读取钥匙）——刻意不 import 实现的
 * zcodeSessionDbPath（自指断言：实现改错时断言仍绿），路径知识独立于实现复述。 */
function expectedSessionDbPath(): string {
  return path.join(dataDir, "engines", "zcode", "session-db", "db.sqlite");
}

/** 与 zcode-engine.ts 同一 facade 单例引用（spy 它的方法即拦截引擎的 warn 出声）。 */
const subagentsLogger = getLogger("subagents");

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

/** run 返回形态别名（abort 用例的中止终态断言范围）。 */
type EngineRunResult_ = EngineRunResult;

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
  /** 内建目录源覆盖（缺省 absent 文件——reasoningLevel 值域解析降级为不携带）。 */
  builtinCatalogPath?: string;
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
    sources: {
      v2ConfigPath: v2Path,
      personalProviderConfigPath: personalPath,
      builtinCatalogPath: overrides.builtinCatalogPath ?? path.join(tmpRoot, "absent-catalog.json"),
    },
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

function bootEnv(stateFile: string): Record<string, unknown> {
  const env = readState(stateFile).find((e) => e.ev === "env");
  return isRecord(env) ? env : {};
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-appserver", ...overrides };
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

    // handle 锚定：sessionRef.dbPath = 隔离会话库绝对路径
    // （期望值独立展开，见 expectedSessionDbPath 注释——不调实现函数）
    expect(handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: expectedSessionDbPath() });
    expect(String(handle.data.sessionRef["dbPath"]).startsWith("/")).toBe(true);
  }, 15_000);

  it("[PR3] 工具执行期活性接线：turn 中途 tool.updated progress 帧 → ctx.onEvent 收到 {type:'activity'}（零载荷严格相等）", async () => {
    // 真机探针实证（/tmp/zcode-activity-probe.log，2026-09-10）：工具执行期
    // session/event 每隔 ~1.0s 推 {type:"tool.updated", payload:{kind:"progress",…}}
    // ——既非 final-frame 也非 delta。宿主刷新逻辑只有 delta 事件，该帧族必须经
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
    // activity 事件恰一次（一帧一事件）、零载荷字段侧严格相等（无多余键）
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

  it("回调时点：onHandleReady（create 应答后）先于首事件（[池抽象降级] onPoolResolved 已退役）", async () => {
    const { engine, workspace } = makeEngine();
    const order: string[] = [];
    await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({
        onHandleReady: (partial) => order.push(`handle:${partial.sessionRef["sessionId"]}`),
        onEvent: (e) => {
          if (e.type === "text_delta" && order[order.length - 1] !== "event") order.push("event");
        },
      }),
    );
    expect(order[0]).toBe(`handle:${GOLDEN_SESSION_ID}`);
    expect(order[1]).toBe("event");
  }, 15_000);

  it("共享宿主 HOME：HOME 正向透传、遥测关、argv=app-server --cwd engineDataDir、无池 config/lockfile/pidfile、onChildSpawned 零调用", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    const onChildSpawned = vi.fn();
    const { handle } = await engine.run(makeTask({ cwd: workspace }), makeCtx({ onChildSpawned }));
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
    // capability-gate.test.ts 承载）。引擎域 run() 不做 shape 检查——本用例反转回归测试：
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

  // [U4/R4-G3] 缺席模型：create 帧不含 model 键——zcode 走自身缺省解析（用户
  // defaultModelSelection 优先），且缺席跳过 preparer 凭据预校验（D3：正确行为非
  // 放松——本用例 v2 config 仅含 m1 条目，若缺席仍走 fallback 解析链会在无
  // builtin:bigmodel-coding-plan 条目时抛 engine_credential_missing）。
  it.each([undefined, "   "] as const)(
    "task.model 缺席/空白 → create 帧无 model 键（U4：缺席交 zcode 自身缺省解析，跳过凭据预校验）",
    async (model) => {
      const { engine, stateFile, workspace } = makeEngine();
      const { outcome } = await engine.run(makeTask({ cwd: workspace, model }), makeCtx());
      expect(outcome.error).toBeUndefined();
      const create = sentFrames(stateFile, "session/create")[0];
      expect("model" in create.params).toBe(false);
      // 其余键集不受影响（strict 对象仍带 workspacePath/mode）
      expect(create.params["workspace"]).toMatchObject({ workspacePath: workspace });
      expect(create.params["mode"]).toBe("yolo");
    },
    15_000,
  );

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

  it("task.model 缺省 + ctx.ctxModel 存在 → 出声留痕（F16b：ctxModel 是 pi 链路兜底，zcode 不消费）", async () => {
    // [R4/G3] v2 config 无需再补 fallback provider 条目——缺席 model 不再解析
    // ZCODE_FALLBACK_DEFAULT_MODEL，create 不携带 model 键（zcode 自身缺省解析）。
    const { engine, stateFile, workspace } = makeEngine();
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
      // [R4/G3] 文案不再声称「实际使用引擎缺省模型 <fallback>」——缺席 = 不携带键
      expect(hit?.msg).toContain("不携带 model 键");
      expect(hit?.msg).toContain("defaultModelSelection");
      // U4：缺席 → create 帧不含 model 键（zcode 自身缺省解析）
      const create = sentFrames(stateFile, "session/create")[0];
      expect("model" in create.params).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  }, 15_000);

  it("显式 task.model 或 ctx 无 ctxModel → 零 ctxModel 信号（F16b：只在「ctx 有模型但被忽略」时出声）", async () => {
    // 第二段 run（model 缺省）走 create 省略 model 键链（CLI 缺省解析）——无 plan 家族
    // 兜底 id 参与解析（2026-09-29 account 体系迁移后缺席即省略，不伪造）
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
// reasoningLevel 择档（目录值域 × thinkingLevel——2026-10-13 探针实测驱动）
// ============================================================
// 值域来源 = preparer.resolveZcodeReasoningValues（目录 modelRules 匹配 modelId）；
// 择档语义：无 thinkingLevel → 首值（最小档，现状保形）；off 族（off/minimal，显式
// 禁思考/最省）→ 恒首值（最小档，不落非最小档回退——意图反转回归锁定）；显式
// thinkingLevel 精确命中 → 用之；其余不命中 → 非最小档末值（请求了思考 = reasoning
// 开；plan 网关对部分模型拒收 disabled——域与接受面漂移时显式意图走非最小档）。
// [2026-10-14 zcode CLI 协议适配] 解析出的 reasoningLevel 同时镜像到 create 帧
// thoughtLevel（reasoning 唯一生效通道：CLI create 把 model 转 "provider/modelId"
// 字符串时丢弃 model.options，档位只认 thoughtLevel → setThoughtLevel；详见
// buildAppServerCreateParams 头注）——下列用例的 thoughtLevel 断言锁定
// 「解析值必达 thoughtLevel」这一落地不变量。

/** 写一个 reasoning 目录（单通配规则命中全部模型；values 即值域；tmpRoot 每用例独立）。 */
function writeReasoningCatalog(values: string[]): string {
  const catalogPath = path.join(tmpRoot, "reasoning-catalog.json");
  writeJson(catalogPath, {
    config: {
      modelConfigRules: {
        modelRules: [{ modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values } } } }],
      },
    },
  });
  return catalogPath;
}

/**
 * 择档用例共用骨架：写目录 → 跑一轮 → 断言 create 帧 model.options.reasoningLevel 与
 * 镜像 thoughtLevel 同为 expected（reasoning 唯一生效通道是 thoughtLevel，两处必须同值）。
 */
async function expectReasoningPick(
  catalogValues: string[],
  thinkingLevel: string | undefined,
  expected: string,
): Promise<void> {
  const { engine, stateFile, workspace } = makeEngine({ builtinCatalogPath: writeReasoningCatalog(catalogValues) });
  await engine.run(makeTask({ cwd: workspace, thinkingLevel }), makeCtx());
  const create = sentFrames(stateFile, "session/create")[0];
  expect(create.params["model"]).toEqual({
    providerId: PROVIDER,
    modelId: "m1",
    options: { reasoningLevel: expected },
  });
  expect(create.params["thoughtLevel"]).toBe(expected);
}

describe("reasoningLevel 择档（目录值域 × thinkingLevel）", () => {
  it("无 thinkingLevel → 值域首值（最小档）且镜像到 thoughtLevel（CLI 只认 thoughtLevel 通道）", async () => {
    await expectReasoningPick(["disabled", "low", "high"], undefined, "disabled");
  }, 15_000);

  it("thinkingLevel 精确命中值域 → create 帧用请求档", async () => {
    await expectReasoningPick(["disabled", "low", "high"], "high", "high");
  }, 15_000);

  it("thinkingLevel 不在值域 → 非最小档末值且镜像到 thoughtLevel（显式思考意图不落 disabled）", async () => {
    await expectReasoningPick(["disabled", "low", "high"], "xhigh", "high");
  }, 15_000);

  it("thinkingLevel=off 且值域不含 off → 最小档且镜像到 thoughtLevel（off 透传会被 CLI 跳过后 reasoning 仍 missing——生产事故锁定）", async () => {
    // 值域 ['low','high','max']：回归前 off 非精确命中 → 落非最小档末值 'max'
    // （不思考被发成最强思考）；修复后 off 族短路值域首值。
    // [2026-10-14] thoughtLevel 同步镜像首值——CLI 值域无 off 档，透传 "off" 会被
    // listThoughtLevels 校验跳过 → 会话档位空 → turn 阶段 reasoning-level-missing。
    await expectReasoningPick(["low", "high", "max"], "off", "low");
  }, 15_000);

  it("thinkingLevel=minimal 且值域不含 minimal → 最小档且镜像到 thoughtLevel（off 族同款短路，最省意图不升级）", async () => {
    await expectReasoningPick(["disabled", "low", "high"], "minimal", "disabled");
  }, 15_000);

  it("thinkingLevel=off 精确命中值域 → 请求档原样且镜像到 thoughtLevel（精确命中语义不变）", async () => {
    await expectReasoningPick(["off", "low", "high"], "off", "off");
  }, 15_000);

  it("值域单值且请求档不在域 → 落回唯一值且镜像到 thoughtLevel（非最小档为空不越域）", async () => {
    await expectReasoningPick(["enabled"], "high", "enabled");
  }, 15_000);

  it("无值域（目录缺失）→ thoughtLevel 维持 thinkingLevel 透传且 model 无 options（现状保形）", async () => {
    // 缺省 makeEngine 无内建目录：resolver 降级 undefined → 无 reasoning 可镜像，
    // 保持 thinkingLevel 恒等透传 + model 裸 {providerId, modelId}（兼容无 reasoning
    // 值域的模型——发 thoughtLevel 会被 CLI listThoughtLevels 跳过 + warn 噪音）。
    const { engine, stateFile, workspace } = makeEngine();
    await engine.run(makeTask({ cwd: workspace, thinkingLevel: "medium" }), makeCtx());
    const create = sentFrames(stateFile, "session/create")[0];
    expect(create.params["model"]).toEqual({ providerId: PROVIDER, modelId: "m1" });
    expect(create.params["thoughtLevel"]).toBe("medium");
  }, 15_000);

  it("值域 per-engine 记忆化：目录文件删除后重复 run 仍携带同档（不重读目录）", async () => {
    const catalogPath = writeReasoningCatalog(["disabled", "low", "high"]);
    const { engine, stateFile, workspace } = makeEngine({ builtinCatalogPath: catalogPath });
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    fs.rmSync(catalogPath); // 记忆化生效则第二 run 不重读已删除的目录
    await engine.run(makeTask({ cwd: workspace }), makeCtx());
    const creates = sentFrames(stateFile, "session/create");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.params["model"]).toEqual({
      providerId: PROVIDER,
      modelId: "m1",
      options: { reasoningLevel: "disabled" },
    });
  }, 20_000);
});

// ============================================================
// abort 链（D3：stop → grace → killChain；stop 成功不 kill）
// ============================================================

describe("abort 链（D3）", () => {
  /** 无终态推送的挂起场景（仅 state.updated——turn 永不自然落定；scenario 每引擎
   * 固化，故「后续任务」同样挂起——复用形态断言用再次 abort 收尾，不 await 自然终态）。 */
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
    // 第一轮：挂起 → abort → stop 推终态 → 优雅收尾
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

  it("stop 无效（stopBehavior none + 无终态）→ grace 耗尽 → killChain 收割共享进程 → 崩溃路径收尾 + 重建", async () => {
    // abort grace 注入缝（两轮各经历一次 ABORT_GRACE）：真实默认 3s×2 不在单测等待
    // 范围——200ms 级覆盖，fake 真子进程 IO 与杀链路径全保真。
    vi.stubEnv("TAIJI_ZCODE_TEST_ABORT_GRACE_MS", "200");
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
    // 40s 兜底保留：ABORT_GRACE 已经 env 注入缩短（实际 <2s），兜底只防 CI 抖动挂死
  }, 40_000);

  it("pre-aborted signal：短路返回中止终态——不建会话不发任何帧（防误杀共享进程）；error 事件可达（[池抽象降级] onPoolResolved 已退役）", async () => {
    const { engine, stateFile, workspace } = makeEngine();
    const controller = new AbortController();
    controller.abort();
    const order: string[] = [];
    const { handle, outcome } = await engine.run(
      makeTask({ cwd: workspace }),
      makeCtx({
        signal: controller.signal,
        onEvent: (e) => order.push(`event:${e.type}`),
      }),
    );
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toContain("session/stop");
    expect(handle.data.sessionRef["sessionId"]).toBeUndefined();
    expect(order).toEqual(["event:error"]);
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
  it("在途会话：close 帧发出（fake 收到且记入流水）→ 进程收割 → 挂起任务走崩溃路径收尾", async () => {
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

  it("窄竞态检查：进程已死（child=null）但 activeSessions 残留时，dispose 不经 post 惰性拉起新进程（D6 防泄漏）", async () => {
    // 真实微拍窗口（进程死亡收割与 activeSessions 清理之间的 microtask）不可从公开
    // 面同步注入——白盒构造同形态快照：runtime 的 conn 无活进程、activeSessions 非空。
    // 检查缺失时 dispose 循环 post("session/close") 会 ensureStarted 惰性 spawn 一代新
    // 进程再被同次 dispose 杀掉（onSpawned 同步触发）；检查生效时永不 spawn。
    // 观测范围用 conn.onSpawned（spawnGeneration 内同步调用）而非 fake 侧 boot 计数：
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
    expect(spawned).toBe(false); // 检查生效：close 帧循环跳过，零惰性 spawn
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
// capabilities（D5）+ eventGranularity 生产零消费方检查
// ============================================================

describe("capabilities（D5：仅 eventGranularity 变）", () => {
  it("单一 app-server 形态声明 eventGranularity='stream'，其余能力位与设计声明一致", () => {
    const { engine } = makeEngine();
    expect(engine.capabilities()).toEqual({
      schemaEnforcement: "emulated",
      steer: "unsupported",
      conversation: "cold",
      personaInjection: "prompt",
      eventGranularity: "stream",
      // [W2/R2] sandbox 位升 emulated（cwd 传导已通，worktree 隔离由公共层承担——
      // W3 交接翻转：带 worktree 任务不再被 capability gate 拒绝）
      sandbox: "emulated",
      sessionRead: "full",
      resume: "cold",
      interrupt: "kill-only",
      permissionMode: "native",
      maxTurns: false,
      // [subagent-model-switch] zcode 引擎不在模型切换设计范围——unsupported 如实声明
      // （zcode-engine.ts capabilities 快照同源跟随）
      setModel: "unsupported",
    });
  });

  it("eventGranularity 生产零消费方检查：src 内（测试除外）无任何能力位读取访问（翻转无下游破坏）", () => {
    // 扫描根 = 本包 src（设计意图「src 内零消费」）。勿改成 5 级上跳——本文件
    // 在 src/__tests__（比 renderer i18n 用例浅 2 层），5 级会落到 workspace 父目录
    // 扫进所有兄弟 worktree（曾致本用例 3.1s 且耗时随兄弟 worktree 文件量漂移）。
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

// ══════════════════════════════════════════════════════════════
// 来源：zcode-engine-degrade.test.ts —— appserver 错误分类回归门
//（降级链已删，仅存本主题）。2026-09 单一 app-server 形态重构删除了整条降级
// 机制：CLI spawn 降级重跑、probe 冒烟门控、模式固定 env 三态均不复存在——
// 协议漂移类错误直接上报可操作错误，不再换通道保底。错误规格表：
//   - -32603 "Model config is missing" → engine_credential_missing（共享宿主
//     HOME——凭据在 ZCode 桌面端管理），不换路径（第二任务仍走 app-server，
//     create 帧计数增长）；
//   - -32004 / -32010 → engine_run_failed 按任务失败上报（非漂移类，不换通道保底）。
// ══════════════════════════════════════════════════════════════

interface ErrorScenario {
  /** 主连接（常驻）scenario 覆盖：create/send 阶段错误注入。 */
  createError?: { code: number; message: string; data?: unknown };
  sendError?: { code: number; message: string; data?: unknown };
}

/** 建一个连到 fake 的引擎（degrade 分节私有——错误注入专版）。 */
function makeDegradeEngine(s: ErrorScenario = {}) {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  const pushes = [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal].map((l) =>
    typeof l === "string" ? (JSON.parse(l) as Record<string, unknown>) : l,
  );
  writeJson(scenarioFile, {
    createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    sendPushes: pushes,
    ...(s.createError !== undefined ? { createError: s.createError } : {}),
    ...(s.sendError !== undefined ? { sendError: s.sendError } : {}),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path, personalProviderConfigPath: personalPath, builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile, workspace };
}

function recvFrames(stateFile: string, method: string): Array<{ id: number; params: Record<string, unknown> }> {
  return readState(stateFile)
    .filter((e) => e.ev === "recv")
    .map((e) => e.frame)
    .filter(
      (f): f is { id: number; params: Record<string, unknown> } =>
        isRecord(f) && f.method === method && isRecord(f.params) && typeof f.id === "number",
    );
}

function makeDegradeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-degrade", ...overrides };
}

// ============================================================
// 错误分类表（非漂移类：-32603 / -32004 / -32010 不降级）
// ============================================================

describe("错误分类（错误规格表）", () => {
  it("-32603 'Model config is missing' → engine_credential_missing，不降级（第二任务仍走 app-server）", async () => {
    const { engine, stateFile, workspace } = makeDegradeEngine({
      createError: { code: -32603, message: "Model config is missing" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeDegradeCtx());
    expect(r1.outcome.error).toContain("engine_credential_missing");
    expect("engineFallback" in r1.outcome).toBe(false);
    const createsBefore = recvFrames(stateFile, "session/create").length;
    const r2 = await engine.run(makeTask({ cwd: workspace }), makeDegradeCtx());
    expect(r2.outcome.error).toContain("engine_credential_missing");
    expect(recvFrames(stateFile, "session/create").length).toBeGreaterThan(createsBefore);
  }, 20_000);

  it("-32004 'Session is not active' → 任务失败上报，不降级", async () => {
    const { engine, workspace } = makeDegradeEngine({
      createError: { code: -32004, message: "Session is not active" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeDegradeCtx());
    expect(r1.outcome.error).toContain("engine_run_failed");
    expect(r1.outcome.error).toContain("-32004");
    expect("engineFallback" in r1.outcome).toBe(false);
  }, 20_000);

  it("-32010（send busy）→ 任务失败上报，不降级", async () => {
    const { engine, workspace } = makeDegradeEngine({
      sendError: { code: -32010, message: "A turn is already running" },
    });
    const r1 = await engine.run(makeTask({ cwd: workspace }), makeDegradeCtx());
    expect(r1.outcome.error).toContain("engine_run_failed");
    expect(r1.outcome.error).toContain("-32010");
    expect("engineFallback" in r1.outcome).toBe(false);
  }, 20_000);
});

// ══════════════════════════════════════════════════════════════
// 来源：zcode-engine-dispose.test.ts —— P0-1 U5 dispose 收割（引擎集成
// 测试）。设计锚点：退化路径、dispose 收割兜底（D7）、P-Z3。真实现场（真实
// 环境的 close 吞没）归 Gate B；本节验证引擎层可注入的集成行为：
//   ① dispose 时在途 turn 收敛为明确失败（不挂满 turn 预算）且不触发重试轮
//     （u-z4 disposed 标志衔接：收割 ≠ 瞬时崩溃——boot 1 / create×1 机械证据）；
//   ② dispose 全链窗口 = HARVEST_GRACE 量级（与 awaitConnFinalized 同源常量——
//     行为耗时断言 + 源码常量同源静态断言）。
// channel 层 close 吞没形态的机制断言在 session-channel-dispose-harvest.test.ts
//（mock 连接——真实子进程形态下 Node close 事件不可吞没，P-Z3 真实现场归 Gate B）。
// ══════════════════════════════════════════════════════════════

interface DisposeEngineFixture {
  engine: ZcodeEngine;
  stateFile: string;
  scenarioFile: string;
  workspace: string;
}

function makeDisposeEngine(): DisposeEngineFixture {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  writeJson(scenarioFile, {
    createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    sendPushes: HANG_PUSHES.map((l) => JSON.parse(l) as Record<string, unknown>),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path, personalProviderConfigPath: personalPath, builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      TAIJI_ZCODE_MODE: "appserver",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile, scenarioFile, workspace };
}

/** 轮询流水直到指定 method 出现（在途 turn 已挂的同步点；超时抛错防静默空转）。 */
async function waitForMethod(stateFile: string, method: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sentMethods(stateFile).includes(method)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`流水 ${timeoutMs}ms 内未出现 ${method}——在途 turn 未建立`);
}

function makeDisposeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-dispose", ...overrides };
}

// ============================================================
// dispose 收割（P0-1 U5/D7：在途 turn 收敛 + 不重试 + 窗口量级）
// ============================================================

describe("dispose 收割（P0-1 U5：引擎集成测试）", () => {
  it("dispose 时在途 turn 收敛为明确失败且不重试：engine_run_failed、boot 1、create×1（收割≠瞬时崩溃，u-z4 disposed 短路）", async () => {
    // 本用例的失败终态只能来自 dispose 收割链（onClose failAllTurns → dispose
    // no-op 幂等；close 吞没变体由 channel 层 mock 测试承载）——channel 已无
    // 时间判死来源（turn 双 timer 删除），终局唯一来源即收割链
    const f = makeDisposeEngine();
    const runPromise: Promise<EngineRunResult> = f.engine.run(makeTask({ cwd: f.workspace }), makeDisposeCtx());
    await waitForMethod(f.stateFile, "session/send"); // 在途 turn 已建立

    const disposeStartedAt = Date.now();
    await f.engine.dispose();
    const disposeMs = Date.now() - disposeStartedAt;

    // run promise 在 dispose 窗口内落定（收割生效的结构性证据——5s 保护超时）
    const r = await Promise.race([
      runPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("run promise 未在 dispose 后 5s 内落定——收割未生效")), 5000),
      ),
    ]);
    expect(r.outcome.error).toMatch(/^engine_run_failed:/);
    // 收割错误带连接层崩溃 reason（close 正常到达形态：onClose 主路径先收割）
    expect(r.outcome.error).toContain("进程退出");

    // 收割 ≠ 瞬时崩溃：无重试轮、无惰性重建（boot 1 / create×1 机械证据）
    const methods = sentMethods(f.stateFile);
    expect(methods.filter((m) => m === "session/create").length).toBe(1);
    expect(bootCount(f.stateFile)).toBe(1);

    // 窗口量级：dispose 全链不超 kill 链 + HARVEST_GRACE + 进程调度余量——
    // 收割在 grace 量级窗口完成（确定性收尾时序，非等待型挂起）
    expect(disposeMs).toBeLessThan(ZCODE_KILL_GRACE_MS + ZCODE_APPSERVER_HARVEST_GRACE_MS + 2000);
  }, 30_000);

  it("grace 窗口量级一致性：dispose 收割 race 窗口与 awaitConnFinalized 同源 ZCODE_APPSERVER_HARVEST_GRACE_MS（验收⑤静态断言）", async () => {
    const engineSrc = fs.readFileSync(
      fileURLToPath(new URL("../zcode-engine.ts", import.meta.url)),
      "utf8",
    );
    // awaitConnFinalized：close 永不到达时同量级兜底（u-z2 先例）
    expect(engineSrc).toContain("setTimeout(() => finish(), ZCODE_APPSERVER_HARVEST_GRACE_MS)");
    // shutdownRuntimeAndDisposeChannel：dispose 收割 race 窗口（本单元挂接点）
    expect(engineSrc).toContain("delayResolved(ZCODE_APPSERVER_HARVEST_GRACE_MS");
    // channel dispose 收割本体是同步操作（无自有 timer）——窗口归引擎 race 单点
    const channelSrc = fs.readFileSync(
      fileURLToPath(new URL("../session-channel.ts", import.meta.url)),
      "utf8",
    );
    const disposeBody = channelSrc.slice(
      channelSrc.indexOf("  dispose(): void {"),
      channelSrc.indexOf("  /** 连接死亡收割"),
    );
    expect(disposeBody).not.toContain("setTimeout");
  });
});

// ══════════════════════════════════════════════════════════════
// 来源：zcode-engine-resume.test.ts —— [U6 / §3.2.6 要点 3]
// interact(resume) 引擎侧单测：ctx.resume 携带 zcode 锚 → session/resume 读
// 历史 → token 预算裁剪 → prompt 前缀注入 → 新 session 执行（create/send 只向
// 新会话——原地 resume 被 -32031 卡死，P-1 探针选型「resume 读 + 新 session
// 注入」的行为锁定）。
// ══════════════════════════════════════════════════════════════

const OLD_SESSION_ID = "sess_prior_anchor_1";

/** P-1 实测应答形态的合成历史（role 在 info.role，文本在 parts[].text，tokens 在 step-finish）。 */
function syntheticResumeResult(): Record<string, unknown> {
  return {
    session: { sessionId: OLD_SESSION_ID },
    messages: [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "调研 zcode 续聊链路，记住暗号：蓝莓派-42" }],
      },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "收到，暗号已记住。" },
          { type: "step-finish", tokens: { input: 1200, output: 300, cache: { read: 80, write: 20 } } },
        ],
      },
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "继续看 resume 读通道" }],
      },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "resume 应答自带全量历史。" },
          { type: "step-finish", tokens: { input: 900, output: 200 } },
        ],
      },
    ],
  };
}

interface ResumeScenarioOverrides {
  resumeResult?: unknown;
  resumeError?: { code: number; message: string; data?: unknown };
}

/** 建一个连到 fake 的引擎（resume 分节私有：distinctSessionIds + STAMP 形态——
 * create 每次回独立 sess_<frameId>，golden 推送流按目标会话归因改写——续聊轮的
 * 新会话 ≠ golden 帧内嵌的固定 sessionId，不 stamp 则推送全被归因丢弃）。 */
function makeResumeEngine(overrides: ResumeScenarioOverrides = {}): { engine: ZcodeEngine; stateFile: string } {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  writeJson(scenarioFile, {
    sendPushes: [
      ...ZCODE_APPSERVER_GOLDEN.pushStream,
      ZCODE_APPSERVER_GOLDEN.terminal[0],
      ZCODE_APPSERVER_GOLDEN.terminal[1],
    ].map((l) => JSON.parse(l) as Record<string, unknown>),
    // -32031 定向拒投：fake 对旧会话 send 一律报 ZCODE_RUNTIME_MODEL_UNAVAILABLE
    //（P-1 实测形态）——续聊链若错误地向旧会话 send，本场景下 run 立即失败。
    sendDenySessionIds: [OLD_SESSION_ID],
    ...(overrides.resumeResult !== undefined ? { resumeResult: overrides.resumeResult } : {}),
    ...(overrides.resumeError !== undefined ? { resumeError: overrides.resumeError } : {}),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path, personalProviderConfigPath: personalPath, builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      HOME: "/fake-host-home",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
      FAKE_STAMP_SESSION: "1",
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile };
}

function makeResumeTask(): AgentCallOpts {
  return { prompt: "我刚才告诉你的暗号是什么？", description: "s", model: `${PROVIDER}/m1`, cwd: path.join(tmpRoot, "ws") };
}

function resumeCtx(): RunContext {
  return {
    taskId: "sa-resume",
    resume: {
      recordId: "sa-resume",
      resume: {
        sessionRef: { sessionId: OLD_SESSION_ID, dbPath: path.join(dataDir, "engines", "zcode", "session-db", "db.sqlite") },
      },
    },
  };
}

/** 指定 dbPath 的锚（白名单检查用例：非集合内路径 → 非法 zcode 锚）。 */
function resumeCtxWithDbPath(dbPath: string): RunContext {
  return {
    taskId: "sa-resume",
    resume: {
      recordId: "sa-resume",
      resume: {
        sessionRef: { sessionId: OLD_SESSION_ID, dbPath },
      },
    },
  };
}

describe("interact(resume)：resume 读 → 新 session 注入（P-1 选型行为锁定）", () => {
  it("resume 锚 → 先 session/resume 读历史 → 前缀注入新会话首轮 → 只向新会话 send（旧会话 send 恒 -32031 不回退）", async () => {
    const { engine, stateFile } = makeResumeEngine({ resumeResult: syntheticResumeResult() });

    const handleReady: Array<Record<string, string>> = [];
    const { handle, outcome } = await engine.run(makeResumeTask(), {
      ...resumeCtx(),
      onHandleReady: (partial) => handleReady.push(partial.sessionRef),
    });

    // ① resume 读帧先于 create（历史注入需要历史先到手）
    const resumeFrames = sentFrames(stateFile, "session/resume");
    expect(resumeFrames).toHaveLength(1);
    expect(resumeFrames[0]?.params).toEqual({ sessionId: OLD_SESSION_ID });
    const createFrames = sentFrames(stateFile, "session/create");
    expect(createFrames).toHaveLength(1);

    // ② 新会话执行成功（golden 终态流）+ 锚换新（onHandleReady 的 sessionId ≠ 旧会话）
    expect(outcome.error).toBeUndefined();
    expect(outcome.content).toBe("你好，任务完成");
    const newSessionId = createFrames[0] ? `sess_${createFrames[0].id}` : undefined;
    expect(outcome.sessionId).toBe(newSessionId);
    expect(handle.data.sessionRef["sessionId"]).toBe(newSessionId);
    expect(handleReady[0]?.["sessionId"]).toBe(newSessionId);

    // ③ 首轮 prompt = 历史前缀 + 用户新消息（暗号上下文 + 续聊框架 + 原文）
    const sendFrames = sentFrames(stateFile, "session/send");
    expect(sendFrames).toHaveLength(1);
    const content = String(sendFrames[0]?.params["content"] ?? "");
    expect(content).toContain("[Continued conversation]");
    expect(content).toContain(`prior session id: ${OLD_SESSION_ID}`);
    expect(content).toContain("user: 调研 zcode 续聊链路，记住暗号：蓝莓派-42");
    expect(content).toContain("assistant: 收到，暗号已记住。");
    expect(content).toContain("user: 继续看 resume 读通道");
    expect(content).toContain("~2700 tokens of history");
    expect(content.endsWith("我刚才告诉你的暗号是什么？")).toBe(true);
    // ④ 不回退面：send 目标是**新**会话（旧会话在 fake 侧被 -32031 定向拒投，
    //    任何向旧会话的 send 都会让本 run 失败——上面 outcome.error undefined 已隐式锁定）
    expect(sendFrames[0]?.params["sessionId"]).toBe(newSessionId);
    expect(sendFrames[0]?.params["sessionId"]).not.toBe(OLD_SESSION_ID);
  });

  it("resume 读失败（锚真失效）→ 注入锚失效声明段（延续但无历史）+ 用户消息照常执行，run 仍成功", async () => {
    const { engine, stateFile } = makeResumeEngine({
      resumeError: { code: -32602, message: `session not found: ${OLD_SESSION_ID}` },
    });
    const { outcome } = await engine.run(makeResumeTask(), resumeCtx());
    expect(outcome.error).toBeUndefined();
    expect(outcome.content).toBe("你好，任务完成");
    const sendFrames = sentFrames(stateFile, "session/send");
    expect(sendFrames).toHaveLength(1);
    const content = String(sendFrames[0]?.params["content"] ?? "");
    // 锚失效声明段：模型知情「延续但无历史」（不再静默无前缀裸跑）
    expect(content).toContain("[会话延续提示]");
    expect(content).toContain("不可恢复");
    expect(content).not.toContain("[Continued conversation]");
    // 用户消息在声明段之后照常执行
    expect(content.endsWith("我刚才告诉你的暗号是什么？")).toBe(true);
  });

  it("resume 应答空历史（锚在但从未成轮）→ 不注入空前缀", async () => {
    const { engine, stateFile } = makeResumeEngine({ resumeResult: { messages: [] } });
    const { outcome } = await engine.run(makeResumeTask(), resumeCtx());
    expect(outcome.error).toBeUndefined();
    expect(sentFrames(stateFile, "session/send")[0]?.params["content"]).toBe("我刚才告诉你的暗号是什么？");
  });

  it("无锚（首轮/one-shot）→ 不发 session/resume，行为不变", async () => {
    const { engine, stateFile } = makeResumeEngine();
    const { outcome } = await engine.run(makeResumeTask(), { taskId: "sa-fresh"});
    expect(outcome.error).toBeUndefined();
    expect(sentFrames(stateFile, "session/resume")).toHaveLength(0);
  });

  it("锚 dbPath 非白名单集合（read() ①级同构检查）→ 非法 zcode 锚：不发 session/resume、无前缀降级、run 仍成功", async () => {
    const { engine, stateFile } = makeResumeEngine();
    const { outcome } = await engine.run(makeResumeTask(), resumeCtxWithDbPath("/tmp/attacker-chosen/db.sqlite"));
    expect(outcome.error).toBeUndefined();
    expect(sentFrames(stateFile, "session/resume")).toHaveLength(0);
    const sendFrames = sentFrames(stateFile, "session/send");
    expect(sendFrames).toHaveLength(1);
    expect(String(sendFrames[0]?.params["content"] ?? "")).toBe("我刚才告诉你的暗号是什么？");
  });
});

describe("extractResumeHistory / extractResumeTotalTokens（P-1 应答形态宽容提取）", () => {
  it("双向历史按序还原（info.role 主形态 + parts 文本）；tokens 累加 input+output+cache", () => {
    const history = extractResumeHistory(syntheticResumeResult());
    expect(history.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[0]?.text).toContain("蓝莓派-42");
    expect(extractResumeTotalTokens(syntheticResumeResult())).toBe(1200 + 300 + 80 + 20 + 900 + 200);
  });

  it("非对象 / 缺 messages → 空历史与 undefined tokens；非对话 role 与空文本跳过", () => {
    expect(extractResumeHistory(undefined)).toEqual([]);
    expect(extractResumeHistory({ messages: "not-array" })).toEqual([]);
    expect(
      extractResumeHistory({
        messages: [
          { info: { role: "system" }, parts: [{ type: "text", text: "sys" }] },
          { info: { role: "user" }, parts: [{ type: "text", text: "" }] },
          { role: "user", content: "legacy form" },
        ],
      }),
    ).toEqual([{ role: "user", text: "legacy form" }]);
    expect(extractResumeTotalTokens({ messages: [] })).toBeUndefined();
  });
});

describe("buildResumeInjectionSegment（token 预算裁剪契约）", () => {
  it("超预算从最旧条目丢弃（保尾）+ 显式省略标注；tokens 数据进保留量注记", () => {
    const longText = "x".repeat(2000);
    const history: ResumedHistoryTurn[] = [
      { role: "user", text: longText },
      { role: "assistant", text: longText },
      { role: "user", text: "最新一轮：继续" },
    ];
    // 显式小预算触发裁剪（生产预算 = 模块常量缺省值，此处只验证「保尾 + 省略标注」契约）
    const segment = buildResumeInjectionSegment(history, "sess_x", 500, 250);
    expect(segment).toContain("[Continued conversation]");
    expect(segment).toContain("omitted");
    expect(segment).toContain("user: 最新一轮：继续");
    expect(segment).not.toContain(`user: ${longText}`);
    expect(segment).toContain("~500 tokens of history");
  });

  it("预算内全量保留，无省略标注", () => {
    const segment = buildResumeInjectionSegment([{ role: "user", text: "hi" }], "sess_x");
    expect(segment).toContain("user: hi");
    expect(segment).not.toContain("omitted");
    expect(segment).not.toContain("tokens of history");
  });
});

describe("buildResumeUnavailableNoticeSegment（锚失效声明段文案契约）", () => {
  it("说清「延续但无历史」语义：延续提示 + 历史不可恢复 + 独立续推指引", () => {
    const segment = buildResumeUnavailableNoticeSegment();
    expect(segment).toContain("[会话延续提示]");
    expect(segment).toContain("同一任务的延续会话");
    expect(segment).toContain("不可恢复");
    expect(segment).toContain("独立判断并继续推进任务");
    // 与 buildResumeInjectionSegment 相同的尾部形态：与后续 prompt 空行分隔
    expect(segment.endsWith("\n\n")).toBe(true);
    // 「延续且有历史」的既有框架文本不得出现（两段语义互斥）
    expect(segment).not.toContain("[Continued conversation]");
    expect(segment).not.toContain("conversation_history");
  });
});

// ══════════════════════════════════════════════════════════════
// 来源：zcode-engine-retry.test.ts —— [P0-1 U4/D6] 瞬时失败自动重试一次
// 测试（设计锚点 D6、F-1/F-4、U4）。覆盖：
//   - 重试一次成功（连接崩溃形态）：crash → failAllTurns 收割 → 新会话重跑
//     （进程死后惰性重建 + scenario 切换）→ 自然终态；
//   - 重试仍失败（连接崩溃族）：文案补「已自动重试一次」句（u-z2 留的 F-1
//     补句义务），boot 2 证据；
//   - 不可重试形态不重试：RPC 错误（-32004/-32601 漂移）/ status=error 终态
//     （D6 不采用③）/ 用户取消（aborted 短路）——各 create×1 无补句。
//（原预算继承面——resolveTransientRetryBudget 纯函数与显式总上界 env 门禁——随
//  turn 双 timer 删除一并移除：重试轮不再携带上界预算。）
// ══════════════════════════════════════════════════════════════

/** 权威终态 turn.terminal 的 error 帧（status='error' 终态——D6 不采用③的不可重试形态）。 */
const TERMINAL_ERROR_FRAME =
  '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"error"}}';

interface RetryScenarioOverrides {
  replaceSendPushes?: string[];
  stopBehavior?: "terminal" | "none" | "hang";
  sendError?: RpcErrorSpec;
  /** send 应答后 N ms 自杀（U4 扩展通道——连接崩溃收割注入）。 */
  crashAfterSendMs?: number;
  /** 非首代（崩溃后惰性重建代）send 的推送序列——重试轮的不同行为通道（U4）。 */
  rebootSendPushes?: string[];
}

interface RetryEngineFixture {
  engine: ZcodeEngine;
  stateFile: string;
  workspace: string;
  /** 重写 scenario（新 fake 进程启动时重读——崩溃重建轮的形态切换通道）。 */
  rewriteScenario: (overrides: RetryScenarioOverrides) => void;
}

function makeRetryEngine(overrides: RetryScenarioOverrides = {}): RetryEngineFixture {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  const write = (o: RetryScenarioOverrides): void => {
    writeJson(scenarioFile, {
      createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
      readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
      sendPushes: (o.replaceSendPushes ?? HANG_PUSHES).map((l) => JSON.parse(l) as Record<string, unknown>),
      ...(o.stopBehavior !== undefined ? { stopBehavior: o.stopBehavior } : {}),
      ...(o.sendError !== undefined ? { sendError: o.sendError } : {}),
      ...(o.crashAfterSendMs !== undefined ? { crashAfterSendMs: o.crashAfterSendMs } : {}),
      ...(o.rebootSendPushes !== undefined
        ? { rebootSendPushes: o.rebootSendPushes.map((l) => JSON.parse(l) as Record<string, unknown>) }
        : {}),
    });
  };
  write(overrides);
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path, personalProviderConfigPath: personalPath, builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      // 固定 appserver 定向（定向不探不降）
      TAIJI_ZCODE_MODE: "appserver",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return {
    engine,
    stateFile,
    workspace,
    rewriteScenario: (o) => write(o),
  };
}

function createCount(stateFile: string): number {
  return sentMethods(stateFile).filter((m) => m === "session/create").length;
}

function makeRetryCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-retry", ...overrides };
}

// ============================================================
// 集成：重试一次成功（连接崩溃形态，D6/F-4 主路径）
// ============================================================

describe("瞬时失败自动重试一次（P0-1 U4：新会话重跑）", () => {
  it("连接崩溃 → 重试轮新会话重跑成功：boot 2（惰性重建）+ create×2 + 自然终态（默认配置，无显式预算）", async () => {
    // 首代 hang + crash（收割 conn-closed）；重建代（重试轮）走完整 golden 流自然终态
    // ——run 整体 await 无法经 rewriteScenario 插手重试轮，rebootSendPushes 是代感知通道
    const f = makeRetryEngine({
      crashAfterSendMs: 120,
      rebootSendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal],
    });
    const r: EngineRunResult = await f.engine.run(makeTask({ cwd: f.workspace }), makeRetryCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
    // 机械证据：崩溃 boot 1 + 重试轮惰性重建 boot 2；首轮 + 重试轮各自 create 新会话
    expect(bootCount(f.stateFile)).toBe(2);
    expect(createCount(f.stateFile)).toBe(2);
  }, 20_000);

  it("重试仍失败·连接崩溃族：重建轮再崩溃 → 文案补「已自动重试一次仍失败」句（F-4 已重试 1 次）", async () => {
    const f = makeRetryEngine({ crashAfterSendMs: 120 }); // scenario 固定 crash——重建轮同样崩溃
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeRetryCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 会话执行失败/);
    expect(r.outcome.error).toContain("已自动重试一次仍失败");
    // 一次封顶：首轮 + 重试轮共两次会话、两代进程（崩溃自动重建），不再第三轮
    expect(createCount(f.stateFile)).toBe(2);
    expect(bootCount(f.stateFile)).toBe(2);
  }, 20_000);
});

// ============================================================
// 不可重试形态不重试（D6 不采用其余方案的理由 + 形态排除）
// ============================================================

describe("不可重试形态不重试（一次会话收尾，无补句）", () => {
  it("RPC 错误（-32004 busy）：非瞬时形态 → 不重试（create×1）", async () => {
    const f = makeRetryEngine({ sendError: { code: -32004, message: "Session is busy" } });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeRetryCtx());
    expect(r.outcome.error).toContain("-32004");
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
    expect(bootCount(f.stateFile)).toBe(1);
  }, 15_000);

  it("漂移码（-32601）：R5 降级链专属语义，不进瞬时重试（D6 不采用②）", async () => {
    const f = makeRetryEngine({ sendError: { code: -32601, message: "method not found" } });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeRetryCtx());
    expect(r.outcome.error).toContain("-32601");
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
  }, 15_000);

  it("status='error' 终态：D6 不采用③（错误内容可能非瞬时）→ 不重试（create×1）", async () => {
    const f = makeRetryEngine({ replaceSendPushes: [TERMINAL_ERROR_FRAME] });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeRetryCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
    expect(bootCount(f.stateFile)).toBe(1);
  }, 15_000);

  it("用户取消（turn 在途时 abort）：aborted 短路优先 → 不重试（create×1）", async () => {
    const f = makeRetryEngine(); // hang + stopBehavior terminal（stop 优雅生效 → aborted 收尾）
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeRetryCtx({ signal: controller.signal }));
    // 用户取消入口现状语义零改动（U2）：engine_run_failed 中止标记（非超时语义）
    expect(r.outcome.error).toContain("被中止");
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
  }, 15_000);
});
