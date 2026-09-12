// session-channel.test.ts —— R3 会话层测试：全部跑 __fixtures__/fake-appserver.mjs
// 子进程（scenario 注入会话场景），绝不 spawn 真 zcode.cjs。覆盖验收条款：
// A.2 帧序列逐字断言（create 参数键集与值形态 / subscribe deliveryKind 必填 /
// send 字段是 content 不是 text）/ sessionId 从 result.session.sessionId 提取且不用
// projection / 终态判定（turn.terminal 权威 + 缺失时收尾帧宽松判定 + error status
// 亦终态）/ read 兜底全文拼接 == delta 拼接（不变量 1，四方双来源）/ usage 收尾帧
// 提取并随 resolve 返回（step-finish tokens 宽容兜底）/ close 成功与失败路径都被
// 调用（try/finally）/ -32601/-32602 结构化透传（R5 降级链地基）/ resolve 严格晚于
// 末事件回调（不变量 2）/ golden 双副本 diff + 帧序列语料四类样本全链回放。

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureLoggerSink,
  resetLoggerSinkForTests,
  type LogLevel,
} from "@zhushanwen/subagent-engine-sdk";

import {
  AppServerConnection,
  buildAppServerEnv,
  isAppServerRpcError,
} from "../connection.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import {
  SessionChannel,
  SUBSCRIBE_DELIVERY_KIND,
  TurnTimeoutError,
  extractAssistantText,
  extractCreatedSessionId,
  extractReadUsage,
  stableWorkspaceKey,
} from "../session-channel.ts";

const TMP = mkdtempSync(join(tmpdir(), "zcode-sess-"));
const FAKE_CLI = fileURLToPath(
  new URL("./__fixtures__/fake-appserver.mjs", import.meta.url)
);

// golden fixture（采集 SSOT）——双副本 diff 断言的数据源
const GOLDEN_FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../__golden__/zcode-golden-appserver.json", import.meta.url)
    ),
    "utf8"
  )
) as { frames: typeof ZCODE_APPSERVER_GOLDEN };

const GOLDEN_SESSION_ID = "sess_golden_r3_01";
const GOLDEN_FULL_TEXT = "你好，任务完成";
const GOLDEN_FINAL_USAGE = { inputTokens: 12599, outputTokens: 17 };
const GOLDEN_READ_TOKENS = {
  input: 12599,
  output: 17,
  reasoning: 0,
  cache: 512,
  total: 12616,
};

/** 任意 RPC error 注入形态（fake scenario 的 error 三件套）。 */
interface RpcErrorSpec {
  code: number;
  message: string;
  data?: unknown;
}

interface ScenarioOverrides {
  /** 终态帧组去掉 turn.terminal（宽松判定场景）。 */
  dropTurnTerminal?: boolean;
  /** 终态帧组去掉收尾帧（delta 聚合 / read tokens 兜底场景）。 */
  dropFinalFrame?: boolean;
  /** 整组替换推送帧（完全自定义帧序）。 */
  replaceSendPushes?: Array<string | Record<string, unknown>>;
  /** 在默认帧序之后追加帧（迟到帧注入）。 */
  extraSendPushes?: Array<string | Record<string, unknown>>;
  createResult?: unknown;
  createError?: RpcErrorSpec;
  sendError?: RpcErrorSpec;
  sendResult?: unknown;
  readError?: RpcErrorSpec;
  readResult?: unknown;
}

interface ChannelHandle {
  ch: SessionChannel;
  conn: AppServerConnection;
  stateFile: string;
  workspacePath: string;
}

const CONNECTIONS: AppServerConnection[] = [];
let connSeq = 0;

/** NDJSON 行 / 帧对象统一规范化为帧对象（golden 语料是 NDJSON 行，fake 需要对象逐字回放）。 */
function toFrame(f: string | Record<string, unknown>): Record<string, unknown> {
  return typeof f === "string" ? (JSON.parse(f) as Record<string, unknown>) : f;
}

/** 建一条连到 fake 的连接 + 会话通道（scenario 文件随 env 固化进子进程）。 */
function makeChannel(overrides: ScenarioOverrides = {}): ChannelHandle {
  connSeq += 1;
  const stateFile = join(TMP, `state-${connSeq}.jsonl`);
  const scenarioFile = join(TMP, `scenario-${connSeq}.json`);
  const workspacePath = join(TMP, `ws-${connSeq}`);
  const pushes = (
    overrides.replaceSendPushes ?? [
      ...ZCODE_APPSERVER_GOLDEN.pushStream,
      ...(overrides.dropTurnTerminal
        ? []
        : [ZCODE_APPSERVER_GOLDEN.terminal[0]]),
      ...(overrides.dropFinalFrame ? [] : [ZCODE_APPSERVER_GOLDEN.terminal[1]]),
    ]
  ).map(toFrame);
  const scenario: Record<string, unknown> = {
    createResult:
      overrides.createResult ??
      JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    sendPushes: overrides.extraSendPushes
      ? [...pushes, ...overrides.extraSendPushes.map(toFrame)]
      : pushes,
    readResult:
      overrides.readResult ?? JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    ...(overrides.createError !== undefined
      ? { createError: overrides.createError }
      : {}),
    ...(overrides.sendError !== undefined
      ? { sendError: overrides.sendError }
      : {}),
    ...(overrides.sendResult !== undefined
      ? { sendResult: overrides.sendResult }
      : {}),
    ...(overrides.readError !== undefined
      ? { readError: overrides.readError }
      : {}),
    ...(overrides.readResult !== undefined
      ? { readResult: overrides.readResult }
      : {}),
  };
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  // buildAppServerEnv 2026-09 共享宿主 HOME 改版后只收单参 baseEnv（不再覆写 HOME）；
  // 旧两参形态 (homeDir, extraEnv) 的第一参被展开成字符索引对象——PATH 进不了子 env，
  // spawn("node") 无 PATH 可查 → ENOENT。此处传 env 对象本体（与 zcode-engine-*
  // 引擎测试的 deps.processEnv 同模式）。
  const conn = new AppServerConnection({
    cliPath: FAKE_CLI,
    cwd: workspacePath,
    env: buildAppServerEnv({
      PATH: process.env.PATH ?? "",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    }),
    stderrLogPath: join(TMP, `stderr-${connSeq}.log`),
  });
  CONNECTIONS.push(conn);
  return { ch: new SessionChannel(conn), conn, stateFile, workspacePath };
}

afterEach(async () => {
  const conns = CONNECTIONS.splice(0);
  for (const conn of conns) conn.close(); // 同步 SIGTERM 面快速收割；shutdown 幂等收尸
  await Promise.allSettled(conns.map((c) => c.shutdown({ graceMs: 1_000 })));
});

// ------------------------------------------- 流水读取 helpers（fake 侧 recv 帧）

interface StateEvent {
  seq: number;
  ev: string;
  [key: string]: unknown;
}

function readState(file: string): StateEvent[] {
  try {
    return readFileSync(file, "utf8")
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

interface SentFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

function sentFrames(stateFile: string, method: string): SentFrame[] {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter(
      (f): f is SentFrame =>
        isRecord(f) &&
        f.method === method &&
        isRecord(f.params) &&
        typeof f.id === "number"
    );
}

/** 客户端请求帧的 method 序列（我方反向应答帧无 method 不计入）。 */
function sentMethods(stateFile: string): string[] {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter(
      (f): f is Record<string, unknown> =>
        isRecord(f) && typeof f.method === "string"
    )
    .map((f) => f.method as string);
}

// ============================================================
// A.2 帧序列逐字断言（出站精确键集——对面 zod strict 拒未知键）
// ============================================================

describe("A.2 帧序列逐字断言", () => {
  it("create 帧：参数键集恰 {workspace, mode, persistence}；workspaceKey='ws-'+sha256 前 16；persistence:'immediate'", async () => {
    const { ch, stateFile, workspacePath } = makeChannel();
    await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    const frames = sentFrames(stateFile, "session/create");
    expect(frames).toHaveLength(1);
    // 帧级键集 {id, method, params}——无 jsonrpc、无未知键
    expect(Object.keys(frames[0]).sort()).toEqual(["id", "method", "params"]);
    const params = frames[0].params as Record<string, { workspaceKey?: string; workspacePath?: string; [k: string]: unknown }>;
    expect(Object.keys(params).sort()).toEqual([
      "mode",
      "persistence",
      "workspace",
    ]);
    expect(params.mode).toBe("yolo");
    expect(params.persistence).toBe("immediate");
    expect(Object.keys(params.workspace).sort()).toEqual([
      "workspaceKey",
      "workspacePath",
    ]);
    expect(params.workspace).toEqual({
      workspacePath,
      workspaceKey:
        "ws-" +
        createHash("sha256").update(workspacePath).digest("hex").slice(0, 16),
    });
    expect(stableWorkspaceKey(workspacePath)).toBe(
      params.workspace.workspaceKey
    );
  }, 10_000);

  it("create 可选键：model 是 strict 对象（providerId/modelId/variant）；空 toolAllowlist 不设键；toolDenylist 传则带", async () => {
    const { ch, stateFile, workspacePath } = makeChannel();
    await ch.runTurn(
      {
        workspacePath,
        mode: "yolo",
        model: { providerId: "zai", modelId: "glm-5.3", variant: "plan" },
        thoughtLevel: "high",
        toolAllowlist: [],
        toolDenylist: ["Bash", "Write"],
      },
      "做点什么"
    );
    const params = sentFrames(stateFile, "session/create")[0].params as Record<string, { workspaceKey?: string; workspacePath?: string; [k: string]: unknown }>;
    expect(Object.keys(params).sort()).toEqual([
      "mode",
      "model",
      "persistence",
      "thoughtLevel",
      "toolDenylist",
      "workspace",
    ]);
    // strict 对象逐字段（A.2 ①：字符串 model 会被 -32602 拒收）
    expect(params.model).toEqual({
      providerId: "zai",
      modelId: "glm-5.3",
      variant: "plan",
    });
    expect(params.thoughtLevel).toBe("high");
    expect(params.toolDenylist).toEqual(["Bash", "Write"]);
  }, 10_000);

  it("subscribe 帧：参数恰 {sessionId, deliveryKind:'desktop-continuous'}（deliveryKind 必填）", async () => {
    const { ch, stateFile, workspacePath } = makeChannel();
    await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    const frames = sentFrames(stateFile, "session/subscribe");
    expect(frames).toHaveLength(1);
    expect(frames[0].params).toEqual({
      sessionId: GOLDEN_SESSION_ID,
      deliveryKind: "desktop-continuous",
    });
    expect(Object.keys(frames[0].params).sort()).toEqual([
      "deliveryKind",
      "sessionId",
    ]);
    expect(SUBSCRIBE_DELIVERY_KIND).toBe("desktop-continuous");
  }, 10_000);

  it("send 帧：字段是 content 不是 text——参数恰 {sessionId, content}", async () => {
    const { ch, stateFile, workspacePath } = makeChannel();
    await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    const frames = sentFrames(stateFile, "session/send");
    expect(frames).toHaveLength(1);
    expect(frames[0].params).toEqual({
      sessionId: GOLDEN_SESSION_ID,
      content: "做点什么",
    });
    expect(Object.keys(frames[0].params).sort()).toEqual([
      "content",
      "sessionId",
    ]);
    expect("text" in frames[0].params).toBe(false);
  }, 10_000);

  it("read/close 帧参数恰 {sessionId}", async () => {
    const { ch, stateFile, workspacePath } = makeChannel();
    await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(sentFrames(stateFile, "session/read")).toHaveLength(1);
    expect(sentFrames(stateFile, "session/read")[0].params).toEqual({
      sessionId: GOLDEN_SESSION_ID,
    });
    expect(sentFrames(stateFile, "session/close")).toHaveLength(1);
    expect(sentFrames(stateFile, "session/close")[0].params).toEqual({
      sessionId: GOLDEN_SESSION_ID,
    });
  }, 10_000);
});

// ============================================================
// sessionId 提取（projection.sessionId 恒 "unknown" 勿用）
// ============================================================

describe("sessionId 提取", () => {
  it("golden create 应答：从 result.session.sessionId 提取，不用 projection.sessionId（恒 'unknown'）", async () => {
    const { ch, workspacePath } = makeChannel();
    const sid = await ch.createSession({ workspacePath, mode: "yolo" });
    expect(sid).toBe(GOLDEN_SESSION_ID);
    expect(sid).not.toBe("unknown");
    // 提取函数对 golden 应答的单点断言（conformance/golden 回放层可复用）
    expect(
      extractCreatedSessionId(JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse))
    ).toBe(GOLDEN_SESSION_ID);
  }, 10_000);

  it("无 sessionId 的 create 应答 → 显式错误（含应答摘要，不落 'unknown'）", async () => {
    const { ch, workspacePath } = makeChannel({
      createResult: { projection: { sessionId: "unknown" } },
    });
    await expect(
      ch.createSession({ workspacePath, mode: "yolo" })
    ).rejects.toThrow(/未返回 sessionId/);
  }, 10_000);

  it("宽松兜底链：session.id / 顶层 sessionId 旧形态可提取", () => {
    expect(extractCreatedSessionId({ session: { id: "sess_alt" } })).toBe(
      "sess_alt"
    );
    expect(extractCreatedSessionId({ sessionId: "sess_top" })).toBe("sess_top");
    expect(
      extractCreatedSessionId({ projection: { sessionId: "unknown" } })
    ).toBeUndefined();
  });
});

// ============================================================
// 终态判定（D4 + 不变量 1）
// ============================================================

describe("终态判定", () => {
  it("turn.terminal 权威：success → resolve，terminal={status:'success', source:'turn.terminal'}", async () => {
    const { ch, workspacePath } = makeChannel();
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.terminal).toEqual({ status: "success", source: "turn.terminal" });
  }, 10_000);

  it("turn.terminal status:'error' 亦终态（不归类会挂到超时）；read 兜底照常", async () => {
    const errorTerminal = JSON.stringify({
      method: "v4/telemetry/event",
      params: { kind: "turn.terminal", status: "error" },
    });
    const finalFrame = ZCODE_APPSERVER_GOLDEN.terminal[1];
    const { ch, workspacePath } = makeChannel({
      replaceSendPushes: [
        ...ZCODE_APPSERVER_GOLDEN.pushStream,
        errorTerminal,
        finalFrame,
      ],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.terminal).toEqual({ status: "error", source: "turn.terminal" });
    expect(r.response).toBe(GOLDEN_FULL_TEXT);
  }, 10_000);

  it("宽松匹配防洪堤：turn.terminal 缺失时收尾帧（payload.response 存在）判定终态", async () => {
    const { ch, workspacePath } = makeChannel({ dropTurnTerminal: true });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.terminal).toEqual({ status: "success", source: "final-frame" });
    expect(r.response).toBe(GOLDEN_FULL_TEXT);
  }, 10_000);

  it("迟到帧丢弃：收尾帧判定终态后，迟到的 turn.terminal 不改判、迟到的 delta 不触发回调", async () => {
    const lateDelta = JSON.stringify({
      method: "session/event",
      params: { sessionId: GOLDEN_SESSION_ID, payload: { delta: "迟到文本" } },
    });
    const lateTerminal = JSON.stringify({
      method: "v4/telemetry/event",
      params: { kind: "turn.terminal", status: "success" },
    });
    const deltas: string[] = [];
    const { ch, workspacePath } = makeChannel({
      dropTurnTerminal: true,
      extraSendPushes: [lateDelta, lateTerminal],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onTextDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["你好", "，", "任务完成"]); // 迟到 delta 未触发（不变量 2）
    expect(r.terminal).toEqual({ status: "success", source: "final-frame" }); // 迟到 turn.terminal 未改判
  }, 10_000);

  it("他人 sessionId 的推送帧不归因（防串线）", async () => {
    const crossTalk = JSON.stringify({
      method: "session/event",
      params: {
        sessionId: "sess_someone_else",
        payload: { delta: "串线文本" },
      },
    });
    const deltas: string[] = [];
    const { ch, workspacePath } = makeChannel({ extraSendPushes: [crossTalk] });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onTextDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["你好", "，", "任务完成"]);
    expect(r.response).not.toContain("串线文本");
  }, 10_000);

  it("reasoning_delta 按 kind 分流：走 onThinkingDelta，不混入 text 流与 response 聚合（F2 口径）", async () => {
    // 真机形态（2026-09-09 Gate B F2 实证）：reasoning 模型的推理增量与 answer 增量
    // 同走 session/event payload.delta，靠 payload.kind 区分（"reasoning_delta" /
    // "text_delta"）。answer 通道 = text_delta —— 不变量 3a 的拼接比对不含 reasoning。
    const reasoningFrames = [
      {
        method: "session/event",
        params: {
          sessionId: GOLDEN_SESSION_ID,
          payload: { kind: "reasoning_delta", delta: "先想一想：", assistantMessageId: "msg_r" },
        },
      },
      {
        method: "session/event",
        params: {
          sessionId: GOLDEN_SESSION_ID,
          payload: { kind: "reasoning_delta", delta: "答案是「你好」", assistantMessageId: "msg_r" },
        },
      },
    ];
    const deltas: string[] = [];
    const thinking: string[] = [];
    // reasoning 帧须在终态前到达（extraSendPushes 追加在默认帧序之后会被终态后
    // 丢弃）——用 replaceSendPushes 在 pushStream 与 terminal 之间插入。
    const { ch, workspacePath } = makeChannel({
      replaceSendPushes: [
        ...ZCODE_APPSERVER_GOLDEN.pushStream,
        ...reasoningFrames,
        ZCODE_APPSERVER_GOLDEN.terminal[0],
        ZCODE_APPSERVER_GOLDEN.terminal[1],
      ],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onTextDelta: (d) => deltas.push(d),
      onThinkingDelta: (d) => thinking.push(d),
    });
    expect(thinking).toEqual(["先想一想：", "答案是「你好」"]);
    expect(deltas).toEqual(["你好", "，", "任务完成"]); // text 流不含 reasoning
    expect(r.response).toBe(GOLDEN_FULL_TEXT); // response 聚合不含 reasoning
  }, 10_000);
});

// ============================================================
// [PR3] onActivity：非终态非增量 session/event 帧的活性回调
// ============================================================

describe("onActivity（tool 执行期活性）", () => {
  // 真机探针实证（/tmp/zcode-activity-probe.log，2026-09-10）：工具执行期
  // session/event 每隔 ~1.0s 推一帧 tool.updated {kind:"progress"}——既非
  // final-frame（无 response）也非 delta（无 delta 字段），此前不产生任何宿主可见
  // 回调，「仅工具执行、零正文」形态下宿主侧无进展守护饿死误杀。onActivity 即该
  // 帧族的宿主刷新面（引擎映射 AgentEvent {type:"activity"}）。
  function toolUpdatedProgressFrame(
    elapsedMs: number,
    stdoutTail: string
  ): string {
    return JSON.stringify({
      method: "session/event",
      params: {
        sessionId: GOLDEN_SESSION_ID,
        type: "tool.updated",
        payload: {
          toolCallId: "call_e914fc9643b7459da05127a6",
          toolName: "Bash",
          elapsedMs,
          pid: 2824,
          stdoutBytes: 11,
          stdoutTail,
          kind: "progress",
        },
      },
    });
  }

  it("无 delta 无 response 的帧（探针同款 tool.updated progress）→ onActivity 恰调用一次/帧", async () => {
    const onActivity = vi.fn();
    // 三帧 progress 夹在 delta 流与终态之间（turn 中途——工具执行期形态）
    const { ch, workspacePath } = makeChannel({
      replaceSendPushes: [
        ...ZCODE_APPSERVER_GOLDEN.pushStream,
        toolUpdatedProgressFrame(2134, "progress-1\n"),
        toolUpdatedProgressFrame(3200, "progress-2\n"),
        toolUpdatedProgressFrame(4260, "progress-3\n"),
        ZCODE_APPSERVER_GOLDEN.terminal[0],
        ZCODE_APPSERVER_GOLDEN.terminal[1],
      ],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onActivity,
    });
    expect(onActivity).toHaveBeenCalledTimes(3); // 恰一次/帧，无重复发射
    expect(r.terminal).toEqual({ status: "success", source: "turn.terminal" }); // progress 帧不干扰终态判定
  }, 10_000);

  it("payload.delta 帧 → onActivity 不调（delta 回调已是宿主可见进展，不双发活性）", async () => {
    const onActivity = vi.fn();
    const deltas: string[] = [];
    const { ch, workspacePath } = makeChannel(); // golden 序：session/event 全是 delta 帧
    await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onTextDelta: (d) => deltas.push(d),
      onActivity,
    });
    expect(deltas).toEqual(["你好", "，", "任务完成"]); // delta 路径确实走了
    expect(onActivity).not.toHaveBeenCalled();
  }, 10_000);

  it("final-frame（payload.response）→ onActivity 不调（终态帧非活性语义）", async () => {
    const onActivity = vi.fn();
    // dropTurnTerminal：终态仅由收尾帧宽松判定——final-frame 路径直达断言面
    const { ch, workspacePath } = makeChannel({ dropTurnTerminal: true });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onActivity,
    });
    expect(r.terminal).toEqual({ status: "success", source: "final-frame" });
    expect(onActivity).not.toHaveBeenCalled();
  }, 10_000);

  it("已落定 turn 的迟到非 delta 帧 → onActivity 不调（settle 后 run 已收尾）", async () => {
    const onActivity = vi.fn();
    // extraSendPushes 追加在终态帧之后：turn.terminal 已落定，迟到的 progress 帧不产活性
    const { ch, workspacePath } = makeChannel({
      extraSendPushes: [toolUpdatedProgressFrame(9_000, "progress-late\n")],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onActivity,
    });
    expect(r.terminal).toEqual({ status: "success", source: "turn.terminal" });
    expect(onActivity).not.toHaveBeenCalled();
  }, 10_000);
});

// ============================================================
// 权威终态迟到分级日志（P-Z2 常态迟到降噪：final-frame 先落定 + turn.terminal 迟到）
// ============================================================

describe("权威终态迟到分级日志", () => {
  // 真机实证（P-Z2）：该形态唯一可达路径是 success 终态常态迟到——每个成功任务
  // 必经。原无条件 warn 经 SDK cli-entry stderr 兜底 → runtime [rpc:stderr] 全量
  // console.error 链路，每个成功任务产一条零区分度 ERROR 级日志。此处分级断言
  // （stderr 链路侧的取证在 protocol-e2e：bin 真进程 stderr 捕获）。
  interface CapturedLog {
    level: LogLevel;
    component: string;
    message: string;
  }
  let logs: CapturedLog[];

  beforeEach(() => {
    logs = [];
    configureLoggerSink({
      log(level, component, message) {
        logs.push({ level, component, message });
      },
    });
  });
  afterEach(() => {
    resetLoggerSinkForTests();
  });

  /** 迟到的权威 turn.terminal 帧（final-frame 先落定场景注入）。 */
  function lateTerminalFrame(
    status: string,
    extra?: Record<string, unknown>
  ): string {
    return JSON.stringify({
      method: "v4/telemetry/event",
      params: { kind: "turn.terminal", status, ...extra },
    });
  }

  function lateTerminalLogs(): CapturedLog[] {
    return logs.filter((l) => l.message.includes("权威终态晚于落定"));
  }

  it("迟到 success（常态迟到）：零日志；lastTerminalStatus 仍入账（识破依据不受分级影响）", async () => {
    const { ch, workspacePath } = makeChannel({
      dropTurnTerminal: true,
      extraSendPushes: [lateTerminalFrame("success")],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.terminal).toEqual({ status: "success", source: "final-frame" }); // 落定语义不变
    expect(r.lastTerminalStatus).toBe("success"); // 入账路径不动
    expect(lateTerminalLogs()).toEqual([]); // 常态迟到零日志（降噪根修点）
  }, 10_000);

  it("迟到 failed：warn 保留（假成功识破防御面），文案含原样 status；lastTerminalError 照常入账", async () => {
    const { ch, workspacePath } = makeChannel({
      dropTurnTerminal: true,
      extraSendPushes: [
        lateTerminalFrame("failed", {
          errorCode: "E_MODEL",
          errorMessage: "boom",
        }),
      ],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.terminal).toEqual({ status: "success", source: "final-frame" }); // 仍不改写落定
    expect(r.lastTerminalStatus).toBe("failed");
    expect(r.lastTerminalError).toEqual({ code: "E_MODEL", message: "boom" }); // 入账路径不动
    const warns = lateTerminalLogs();
    expect(warns).toHaveLength(1);
    expect(warns[0].level).toBe("warn");
    expect(warns[0].message).toContain('status="failed"'); // 原样 status 在案
  }, 10_000);

  it("迟到 interrupted（用户中断形态）：降 debug 不打 warn", async () => {
    const { ch, workspacePath } = makeChannel({
      dropTurnTerminal: true,
      extraSendPushes: [lateTerminalFrame("interrupted")],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.lastTerminalStatus).toBe("interrupted");
    const hits = lateTerminalLogs();
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe("debug");
    expect(hits[0].message).toContain('status="interrupted"');
  }, 10_000);

  it("迟到未知 status（协议漂移防御）：保守 warn，原样 status 写入文案", async () => {
    const { ch, workspacePath } = makeChannel({
      dropTurnTerminal: true,
      extraSendPushes: [lateTerminalFrame("cancelled-weird")],
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.lastTerminalStatus).toBe("cancelled-weird");
    const warns = lateTerminalLogs();
    expect(warns).toHaveLength(1);
    expect(warns[0].level).toBe("warn");
    expect(warns[0].message).toContain('status="cancelled-weird"');
  }, 10_000);
});

// ============================================================
// read 兜底与不变量 1（text_delta 拼接 == read 全文，双来源）
// ============================================================

describe("read 兜底与不变量 1", () => {
  it("golden 全链：delta 拼接 === resolve.response === read 全文 === 收尾帧 response（四方一致）", async () => {
    const deltas: string[] = [];
    const { ch, workspacePath } = makeChannel();
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onTextDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["你好", "，", "任务完成"]);
    expect(deltas.join("")).toBe(GOLDEN_FULL_TEXT);
    // read 是权威来源：golden readResponse 的 assistant text parts 拼接与 delta 流一致
    expect(
      extractAssistantText(JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse))
    ).toBe(GOLDEN_FULL_TEXT);
    expect(r.response).toBe(deltas.join(""));
    // 收尾帧 response（第二来源）亦一致
    const finalFrame = JSON.parse(ZCODE_APPSERVER_GOLDEN.terminal[1]) as {
      params: { payload: { response: string } };
    };
    expect(finalFrame.params.payload.response).toBe(GOLDEN_FULL_TEXT);
    expect(r.response).toBe(finalFrame.params.payload.response);
  }, 10_000);

  it("read 失败（-32004）→ 收尾帧 response 兜底，不抛", async () => {
    const { ch, workspacePath } = makeChannel({
      readError: { code: -32004, message: "Session is not active" },
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.response).toBe(GOLDEN_FULL_TEXT); // 收尾帧
    expect(r.usage).toEqual(GOLDEN_FINAL_USAGE); // usage 仍从收尾帧提取
  }, 10_000);

  it("read 失败 + 无收尾帧 → delta 聚合兜底（三层降级链末位），usage 缺席", async () => {
    const deltas: string[] = [];
    const { ch, workspacePath } = makeChannel({
      dropFinalFrame: true,
      readError: { code: -32003, message: "boom" },
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onTextDelta: (d) => deltas.push(d),
    });
    expect(r.response).toBe(deltas.join(""));
    expect(r.response).toBe(GOLDEN_FULL_TEXT);
    expect(r.usage).toBeUndefined();
  }, 10_000);

  it("read 成功但提取不到 assistant 文本（messages 空）→ 收尾帧兜底", async () => {
    const { ch, workspacePath } = makeChannel({ readResult: { messages: [] } });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.response).toBe(GOLDEN_FULL_TEXT);
  }, 10_000);
});

// ============================================================
// usage（收尾帧权威 → read step-finish tokens 宽容兜底）
// ============================================================

describe("usage", () => {
  it("usage 从收尾帧提取并随 resolve 返回（A.2 权威形态，精确对象——read tokens 不遮蔽）", async () => {
    const { ch, workspacePath } = makeChannel();
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.usage).toEqual(GOLDEN_FINAL_USAGE);
  }, 10_000);

  it("收尾帧缺失时 read step-finish tokens 宽容兜底（A.5 未确认项——字段缺席不抛）", async () => {
    const { ch, workspacePath } = makeChannel({ dropFinalFrame: true });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.usage).toEqual(GOLDEN_READ_TOKENS);
    // 提取函数单点：golden readResponse 的 tokens 结构（宽容解析面）
    expect(
      extractReadUsage(JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse))
    ).toEqual(GOLDEN_READ_TOKENS);
  }, 10_000);

  it("收尾帧与 read tokens 皆无 → usage 缺席（不给残缺对象）", async () => {
    const { ch, workspacePath } = makeChannel({
      dropFinalFrame: true,
      readResult: { messages: [] },
    });
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.usage).toBeUndefined();
  }, 10_000);
});

// ============================================================
// close（D4 用后即毁：成功/失败路径都 close——try/finally）
// ============================================================

describe("close（D4 用后即毁）", () => {
  it("成功路径：请求帧序恰 create→subscribe→send→read→close（close 最后）", async () => {
    const { ch, stateFile, workspacePath } = makeChannel();
    await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(sentMethods(stateFile)).toEqual([
      "session/create",
      "session/subscribe",
      "session/send",
      "session/read",
      "session/close",
    ]);
  }, 10_000);

  it("send 失败（-32010 busy）→ reject 且 close 仍被调用（try/finally）", async () => {
    const { ch, stateFile, workspacePath } = makeChannel({
      sendError: {
        code: -32010,
        message: "A prompt is already running for this session",
      },
    });
    const err = await ch
      .runTurn({ workspacePath, mode: "yolo" }, "做点什么")
      .then(
        () => {
          throw new Error("should reject");
        },
        (e: unknown) => e
      );
    expect(isAppServerRpcError(err)).toBe(true);
    if (isAppServerRpcError(err)) expect(err.code).toBe(-32010);
    expect(sentFrames(stateFile, "session/close")).toHaveLength(1); // 失败路径也 close
  }, 10_000);

  it("send 返回 accepted:false → 显式 reject 且 close 已尽力", async () => {
    const { ch, stateFile, workspacePath } = makeChannel({
      sendResult: { accepted: false },
    });
    await expect(
      ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么")
    ).rejects.toThrow(/accepted:false/);
    expect(sentFrames(stateFile, "session/close")).toHaveLength(1);
  }, 10_000);

  it("终态超时（turn.terminal 与收尾帧均未达）→ TurnTimeoutError（ceiling 形态，P0-1 两 timer 语义）且 close 仍被调用", async () => {
    const onlyRunning = [ZCODE_APPSERVER_GOLDEN.pushStream[0]]; // 仅 state.updated，无终态
    const { ch, stateFile, workspacePath } = makeChannel({
      replaceSendPushes: onlyRunning,
    });
    const err = await ch
      .runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
        turnTimeoutMs: 250, // P0-1 语义收窄：显式总上界（不再是固定墙钟预算）
      })
      .then(
        () => {
          throw new Error("should reject");
        },
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(TurnTimeoutError);
    expect((err as TurnTimeoutError).kind).toBe("ceiling");
    expect(sentFrames(stateFile, "session/close")).toHaveLength(1);
  }, 10_000);
});

// ============================================================
// 错误透传（R5 降级链地基：-32601/-32602 结构化透传）
// ============================================================

describe("错误透传（-32601/-32602 漂移类）", () => {
  it("create -32602：reject 形态 isAppServerRpcError，code/message/data 原样（zod 诊断随 data 带出）；无会话故无 close 帧", async () => {
    const zodIssues = [{ path: ["model"], message: "not an object" }];
    const { ch, stateFile, workspacePath } = makeChannel({
      createError: { code: -32602, message: "Invalid params", data: zodIssues },
    });
    const err = await ch
      .runTurn({ workspacePath, mode: "yolo" }, "做点什么")
      .then(
        () => {
          throw new Error("should reject");
        },
        (e: unknown) => e
      );
    expect(isAppServerRpcError(err)).toBe(true);
    if (isAppServerRpcError(err)) {
      expect(err.code).toBe(-32602);
      expect(err.data).toEqual(zodIssues);
      expect(err.message).toContain("Invalid params");
      expect(err.message).toContain("[-32602]");
    }
    // sessionId 未建立：无从 close（D4 会话尚未存在）
    expect(sentFrames(stateFile, "session/close")).toHaveLength(0);
  }, 10_000);

  it("send -32602：透传且会话已建立 → close 已尽力（try/finally 不因透传跳过）", async () => {
    const { ch, stateFile, workspacePath } = makeChannel({
      sendError: {
        code: -32602,
        message: "Invalid params",
        data: [{ path: ["content"] }],
      },
    });
    const err = await ch
      .runTurn({ workspacePath, mode: "yolo" }, "做点什么")
      .then(
        () => {
          throw new Error("should reject");
        },
        (e: unknown) => e
      );
    expect(isAppServerRpcError(err)).toBe(true);
    if (isAppServerRpcError(err)) expect(err.code).toBe(-32602);
    expect(sentFrames(stateFile, "session/close")).toHaveLength(1);
  }, 10_000);

  it("-32601（方法不存在）同样结构化透传", async () => {
    const { ch, workspacePath } = makeChannel({
      createError: { code: -32601, message: "Method not found" },
    });
    const err = await ch.createSession({ workspacePath, mode: "yolo" }).then(
      () => {
        throw new Error("should reject");
      },
      (e: unknown) => e
    );
    expect(isAppServerRpcError(err)).toBe(true);
    if (isAppServerRpcError(err)) {
      expect(err.code).toBe(-32601);
      expect(err.message).toContain("Method not found");
    }
  }, 10_000);
});

// ============================================================
// resolve 时序（不变量 2：resolve 严格晚于全部事件回调）
// ============================================================

describe("resolve 时序（不变量 2）", () => {
  it("事件回调序在前、resolve 严格最后（终态判定 → read 兜底 → 才 resolve）", async () => {
    const order: string[] = [];
    const { ch, workspacePath } = makeChannel();
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      onTextDelta: (d) => order.push(`delta:${d}`),
    });
    order.push("resolve");
    expect(order).toEqual([
      "delta:你好",
      "delta:，",
      "delta:任务完成",
      "resolve",
    ]);
    expect(r.response).toBe(GOLDEN_FULL_TEXT);
  }, 10_000);
});

// ============================================================
// [R4] 连接崩溃收割（onClose 面 → failAllTurns——不再挂到 turnTimeoutMs）
// ============================================================

describe("连接崩溃收割（R4 onClose 面）", () => {
  it("进程崩溃（test/suicide）→ 在途 turn 立即 reject（崩溃 reason 含 stderr 尾）——不等 turnTimeoutMs", async () => {
    // 挂起场景（无终态）+ 长预算：崩溃收割前 turnTimeoutMs 兜底永远不会到
    const onlyRunning = [ZCODE_APPSERVER_GOLDEN.pushStream[0]];
    const { ch, conn, stateFile, workspacePath } = makeChannel({ replaceSendPushes: onlyRunning });
    const turn = ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么", {
      turnTimeoutMs: 60_000,
    });
    // 等 send 已达（fake 流水可观测）后在同一连接上触发自杀（崩溃收割的触发面）
    await vi.waitFor(() => {
      expect(sentFrames(stateFile, "session/send")).toHaveLength(1);
    }, { timeout: 5_000 });
    // suicide 不回应答——崩溃时该请求随 pending 一起 reject（预期，吞掉）
    await conn.request("test/suicide").then(
      () => undefined,
      () => undefined,
    );
    const err = await turn.then(
      () => {
        throw new Error("should reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toContain("app-server");
    expect(String((err as Error).message)).toMatch(/进程退出|spawn 失败|CRASH-MARK-TAIL/);
  }, 10_000);

  it("post：fire-and-forget 帧不等待应答（活连接 true；返回布尔不抛）", async () => {
    const { conn } = makeChannel();
    expect(typeof conn.post).toBe("function");
    expect(conn.post("session/close", { sessionId: "sess_x" })).toBe(true);
    await conn.shutdown({ graceMs: 1_000 });
    // 死连接：ensureStarted 重建一代（D1 重建语义）→ post 复又可用；不抛即可
    expect(typeof conn.post("session/close", { sessionId: "sess_x" })).toBe("boolean");
    await conn.shutdown({ graceMs: 1_000 });
  }, 10_000);
});

// ============================================================
// golden 双副本与帧序列语料（R3 验收 ②）
// ============================================================

describe("golden 双副本与四类样本", () => {
  it("双副本 diff：golden-sample.ts 内嵌副本 === fixture frames（防漂移，更新需同步两处）", () => {
    expect(ZCODE_APPSERVER_GOLDEN).toEqual(GOLDEN_FIXTURE.frames);
  });

  it("四类样本形态自检：create 可提取 sessionId≠unknown；推送流含三 method 且 stream.chunk 无文本；终态双帧；read 可提取全文与 tokens", () => {
    // ① create 应答
    expect(
      extractCreatedSessionId(JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse))
    ).toBe(GOLDEN_SESSION_ID);
    // ④ 推送流：state.updated + stream.chunk（无文本）+ session/event（文本在此）
    const pushMethods = ZCODE_APPSERVER_GOLDEN.pushStream.map(
      (l) => (JSON.parse(l) as { method: string }).method
    );
    expect(new Set(pushMethods)).toEqual(
      new Set(["state.updated", "v4/telemetry/event", "session/event"])
    );
    const streamChunk = JSON.parse(ZCODE_APPSERVER_GOLDEN.pushStream[1]) as {
      params: Record<string, unknown>;
    };
    expect(streamChunk.params.kind).toBe("stream.chunk");
    for (const textKey of ["chunk", "text", "content", "delta"]) {
      expect(streamChunk.params[textKey]).toBeUndefined(); // A.2：stream.chunk 无文本
    }
    const deltaFrame = JSON.parse(ZCODE_APPSERVER_GOLDEN.pushStream[2]) as {
      params: { payload: { delta: string } };
    };
    expect(deltaFrame.params.payload.delta).toBe("你好");
    // ⑤ 终态双帧
    const terminalFrame = JSON.parse(ZCODE_APPSERVER_GOLDEN.terminal[0]) as {
      params: { kind: string; status: string };
    };
    expect(terminalFrame.params).toEqual({
      kind: "turn.terminal",
      status: "success",
    });
    const finalFrame = JSON.parse(ZCODE_APPSERVER_GOLDEN.terminal[1]) as {
      params: { payload: { response: string; usage: unknown } };
    };
    expect(finalFrame.params.payload.response).toBe(GOLDEN_FULL_TEXT);
    expect(finalFrame.params.payload.usage).toEqual(GOLDEN_FINAL_USAGE);
    // ⑥ read 应答
    expect(
      extractAssistantText(JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse))
    ).toBe(GOLDEN_FULL_TEXT);
    expect(
      extractReadUsage(JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse))
    ).toEqual(GOLDEN_READ_TOKENS);
  });

  it("golden 帧序列全链回放（fake 逐字回放四类样本）：不变量 1 + usage + sessionId 一次收口", async () => {
    const { ch, workspacePath } = makeChannel(); // scenario 即 golden 四类样本
    const r = await ch.runTurn({ workspacePath, mode: "yolo" }, "做点什么");
    expect(r.sessionId).toBe(GOLDEN_SESSION_ID);
    expect(r.response).toBe(GOLDEN_FULL_TEXT); // delta 拼接 == read 全文 == 收尾帧
    expect(r.usage).toEqual(GOLDEN_FINAL_USAGE);
    expect(r.terminal).toEqual({ status: "success", source: "turn.terminal" });
  }, 10_000);
});
