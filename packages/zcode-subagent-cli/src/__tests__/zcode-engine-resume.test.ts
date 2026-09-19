// zcode-engine-resume.test.ts —— [U6 / §3.2.6 要点 3] interact(resume) 引擎侧单测：
// ctx.resume 携带 zcode 锚 → session/resume 读历史 → token 预算裁剪 → prompt 前缀
// 注入 → 新 session 执行（create/send 只向新会话——原地 resume 被 -32031 卡死，
// P-1 探针选型「resume 读 + 新 session 注入」的行为锁定）。全部跑 fake-appserver
// 子进程（scenario 注入），绝不 spawn 真 zcode.cjs。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentCallOpts, RunContext } from "../port-types.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { buildResumeInjectionSegment, buildResumeUnavailableNoticeSegment } from "../zcode-engine.ts";
import { extractResumeHistory, extractResumeTotalTokens, type ResumedHistoryTurn } from "../session-channel.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";
const OLD_SESSION_ID = "sess_prior_anchor_1";

const engines: ZcodeEngine[] = [];
let tmpRoot: string;
let dataDir: string;
let v2Path: string;
let seq = 0;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-resume-"));
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

/** 建一个连到 fake 的引擎（distinctSessionIds + STAMP 形态：create 每次回独立
 *  sess_<frameId>，golden 推送流按目标会话归因改写——续聊轮的新会话 ≠ golden 帧
 *  内嵌的固定 sessionId，不 stamp 则推送全被归因丢弃）。 */
function makeEngine(overrides: ResumeScenarioOverrides = {}): { engine: ZcodeEngine; stateFile: string } {
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
    sources: { v2ConfigPath: v2Path },
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

function makeTask(): AgentCallOpts {
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

/** 指定 dbPath 的锚（白名单守卫用例：非集合内路径 → 非法 zcode 锚）。 */
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

interface StateEvent {
  seq: number;
  ev: string;
  [key: string]: unknown;
}

function readState(file: string): StateEvent[] {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as StateEvent);
  } catch {
    return [];
  }
}

function sentFrames(stateFile: string, method: string): Array<{ id: number; params: Record<string, unknown> }> {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter(
      (f): f is { id: number; params: Record<string, unknown> } =>
        typeof f === "object" && f !== null && !Array.isArray(f) &&
        (f as Record<string, unknown>).method === method &&
        typeof (f as Record<string, unknown>).id === "number" &&
        typeof (f as Record<string, unknown>).params === "object",
    ) as Array<{ id: number; params: Record<string, unknown> }>;
}

describe("interact(resume)：resume 读 → 新 session 注入（P-1 选型行为锁定）", () => {
  it("resume 锚 → 先 session/resume 读历史 → 前缀注入新会话首轮 → 只向新会话 send（旧会话 send 恒 -32031 不回退）", async () => {
    const { engine, stateFile } = makeEngine({ resumeResult: syntheticResumeResult() });

    const handleReady: Array<Record<string, string>> = [];
    const { handle, outcome } = await engine.run(makeTask(), {
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
    const { engine, stateFile } = makeEngine({
      resumeError: { code: -32602, message: `session not found: ${OLD_SESSION_ID}` },
    });
    const { outcome } = await engine.run(makeTask(), resumeCtx());
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
    const { engine, stateFile } = makeEngine({ resumeResult: { messages: [] } });
    const { outcome } = await engine.run(makeTask(), resumeCtx());
    expect(outcome.error).toBeUndefined();
    expect(sentFrames(stateFile, "session/send")[0]?.params["content"]).toBe("我刚才告诉你的暗号是什么？");
  });

  it("无锚（首轮/one-shot）→ 不发 session/resume，行为不变", async () => {
    const { engine, stateFile } = makeEngine();
    const { outcome } = await engine.run(makeTask(), { taskId: "sa-fresh"});
    expect(outcome.error).toBeUndefined();
    expect(sentFrames(stateFile, "session/resume")).toHaveLength(0);
  });

  it("锚 dbPath 非白名单集合（read() ①级同构守卫）→ 非法 zcode 锚：不发 session/resume、无前缀降级、run 仍成功", async () => {
    const { engine, stateFile } = makeEngine();
    const { outcome } = await engine.run(makeTask(), resumeCtxWithDbPath("/tmp/attacker-chosen/db.sqlite"));
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
