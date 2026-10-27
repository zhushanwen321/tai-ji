// zcode-engine.resume-retry.test.ts —— interact(resume) 续聊 + 瞬时失败自动重试一次
//（P0-1 U4/D6）与不可重试形态。
//
// 拆分自 zcode-engine.test.ts（单文件 61 例是整包墙钟的临界路径）；用例体与
// describe 名逐字保留，共享夹具见 zcode-engine-harness.ts。
//
// 覆盖：resume 锚 → session/resume 读历史 → token 预算裁剪 → 前缀注入新会话首轮
//（P-1 选型「resume 读 + 新 session 注入」，原地 resume 被 -32031 卡死）/ 锚失效声明段 /
// 历史提取与预算裁剪纯函数契约 / 连接崩溃 → 新会话重跑一次（boot 2）/ 重试仍失败的补句 /
// 不可重试形态（RPC 错误、漂移码、status=error 终态、用户取消）各 create×1。

import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentCallOpts, EngineRunResult, RunContext } from "../port-types.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { extractResumeHistory, extractResumeTotalTokens, type ResumedHistoryTurn } from "../session-channel.ts";
import { buildResumeInjectionSegment, buildResumeUnavailableNoticeSegment } from "../zcode-engine.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";
import {
  FAKE_CLI,
  GOLDEN_FULL_TEXT,
  HANG_PUSHES,
  PROVIDER,
  bootCount,
  dataDirPath,
  makeTask,
  nextFixtureSlot,
  personalProviderConfigPath,
  readState,
  registerZcodeEngineHarness,
  sentFrames,
  sentMethods,
  tmpRootDir,
  trackEngine,
  v2ConfigPath,
  writeJson,
  type RpcErrorSpec,
} from "./zcode-engine-harness.ts";

registerZcodeEngineHarness();

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

interface ResumeScenarioOverrides {  // oe-exempt:20261027:test:
  resumeResult?: unknown;
  resumeError?: { code: number; message: string; data?: unknown };
}

/** 建一个连到 fake 的引擎（resume 分节私有：distinctSessionIds + STAMP 形态——
 * create 每次回独立 sess_<frameId>，golden 推送流按目标会话归因改写——续聊轮的
 * 新会话 ≠ golden 帧内嵌的固定 sessionId，不 stamp 则推送全被归因丢弃）。 */
function makeResumeEngine(overrides: ResumeScenarioOverrides = {}): { engine: ZcodeEngine; stateFile: string } {
  const { stateFile, scenarioFile } = nextFixtureSlot();
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
    engineDataDir: () => dataDirPath(),
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2ConfigPath(), personalProviderConfigPath: personalProviderConfigPath(), builtinCatalogPath: path.join(tmpRootDir(), "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      HOME: "/fake-host-home",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
      FAKE_STAMP_SESSION: "1",
    },
  };
  const engine = new ZcodeEngine(deps);
  trackEngine(engine);
  return { engine, stateFile };
}

function makeResumeTask(): AgentCallOpts {
  return { prompt: "我刚才告诉你的暗号是什么？", description: "s", model: `${PROVIDER}/m1`, cwd: path.join(tmpRootDir(), "ws") };
}

function resumeCtx(): RunContext {
  return {
    taskId: "sa-resume",
    resume: {
      recordId: "sa-resume",
      resume: {
        sessionRef: { sessionId: OLD_SESSION_ID, dbPath: path.join(dataDirPath(), "engines", "zcode", "session-db", "db.sqlite") },
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

interface RetryScenarioOverrides {  // oe-exempt:20261027:test:
  replaceSendPushes?: string[];
  stopBehavior?: "terminal" | "none" | "hang";
  sendError?: RpcErrorSpec;
  /** send 应答后 N ms 自杀（U4 扩展通道——连接崩溃收割注入）。 */
  crashAfterSendMs?: number;
  /** 非首代（崩溃后惰性重建代）send 的推送序列——重试轮的不同行为通道（U4）。 */
  rebootSendPushes?: string[];
}

interface RetryEngineFixture {  // oe-exempt:20261027:test:
  engine: ZcodeEngine;
  stateFile: string;
  workspace: string;
  /** 重写 scenario（新 fake 进程启动时重读——崩溃重建轮的形态切换通道）。 */
  rewriteScenario: (overrides: RetryScenarioOverrides) => void;
}

function makeRetryEngine(overrides: RetryScenarioOverrides = {}): RetryEngineFixture {
  const { stateFile, scenarioFile, workspace } = nextFixtureSlot();
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
    engineDataDir: () => dataDirPath(),
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2ConfigPath(), personalProviderConfigPath: personalProviderConfigPath(), builtinCatalogPath: path.join(tmpRootDir(), "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      // 固定 appserver 定向（定向不探不降）
      TAIJI_ZCODE_MODE: "appserver",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  trackEngine(engine);
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
    // 两轮崩溃各经历一次 finalize 确认窗（close 迟到形态）：经 env 注入缝缩到
    // 150ms（判据 = 「重试仍失败 + 补句」，窗口数值非契约）。
    vi.stubEnv("TAIJI_ZCODE_TEST_HARVEST_GRACE_MS", "150");
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
