// zcode-engine-status.test.ts —— [P0-1 U3] 引擎终态 status 消费测试（设计权威源
// docs/design/timeout-zcode-turn-and-settled-watchdog.md §6 D5、§5.2 F-3、§8 A4；
// ⛔P-Z2 门修正：真实 status 枚举 = ["success","interrupted","failed"]（app-server
// dist schema f.enum 实证，无 "error"）——判据 failed 主 + error 容错，v1 的
// `=== "error"` 对真实 failed 终态漏分流即假成功（探针 /tmp/pz2-probe 实锤）。
// 覆盖：
//   - status:'failed'（真实帧形，errorCode/errorMessage 携带）→ run-failed 且错误
//     详情来自 terminal 帧（errorCode/errorMessage 优先——真实形态错误详情只在
//     terminal 帧，read/delta 携带不了；read 尾部为兜底）：
//     ① 帧序 A：turn.terminal failed 先到（权威 settle）；
//     ② 帧序 B：final-frame 宽松 settle success 先到 + turn.terminal failed 迟到
//        （u-z1 lastTerminalStatus/lastTerminalError 衔接——只记录不改写落定）；
//   - P-Z2 降级形态：failed 无 errorCode/errorMessage + read 无错误信息 → 仍
//     run-failed 不假成功（read/finalText 尾部兜底）；
//   - 全空形态（无 delta/收尾帧/read 内容）→ 不伪造错误详情；
//   - status:'interrupted'（真实枚举成员）→ 不误判失败（用户中断不属引擎失败，
//     随宿主 abort 主路径——落定语义登记）；
//   - status:'error'（非真实枚举）→ 容错分支仍 run-failed（防协议漂移滑回假成功）；
//   - 成功路径零回归：terminal success 先到 / final-frame 先到 + terminal success
//     迟到 / final-frame 独走（无 turn.terminal）三形态均 parsed；
//   - schema 任务遇 failed 终态：分流先于 schema 校验（不产 schema_emulation_failed、
//     不进强化重试）。
// 失败终态即时到达，idle/ceiling 默认阈值不参与——无需 env stub。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EngineRunResult, RunContext } from "../port-types.ts";
import type { AgentCallOpts } from "../port-types.ts";
import { zcodeSessionDbPath } from "../db-path.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

const GOLDEN_SESSION_ID = "sess_golden_r3_01";
const GOLDEN_FULL_TEXT = "你好，任务完成";
/** 真实协议 failed 终态帧（⛔P-Z2 门 credfail 实测帧形：errorCode/errorMessage 携带）。 */
const TERMINAL_FAILED_REAL =
  '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"failed","errorCode":"model_request_failed","errorMessage":"Provider marked the request as failed (bad port / credential invalid)"}}';
/** failed 无错误详情变体（P-Z2 降级形态注入材料）。 */
const TERMINAL_FAILED_BARE =
  '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"failed"}}';
/** interrupted 终态（真实枚举成员——用户中断，不误判失败的回归面）。 */
const TERMINAL_INTERRUPTED_FRAME =
  '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"interrupted"}}';
/** 非真实枚举的 "error" 终态（容错分支——防协议漂移滑回假成功）。 */
const TERMINAL_ERROR_FRAME =
  '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"error"}}';
/** 收尾帧（A.2 ⑤ response 形态）——final-frame 宽松终态的注入材料（golden terminal[1]）。 */
const GOLDEN_FINAL_FRAME = ZCODE_APPSERVER_GOLDEN.terminal[1];
/** read 兜底返回的服务端错误文本（read 尾部兜底路径的载体）。 */
const READ_ERROR_TEXT = "Error: provider request failed (401 Unauthorized)";
/** 真实 failed 终态的 terminal 帧错误详情（探针 credfail 实测值）。 */
const TERMINAL_ERROR_CODE = "model_request_failed";
const TERMINAL_ERROR_MESSAGE = "Provider marked the request as failed (bad port / credential invalid)";

let engines: ZcodeEngine[] = [];
let seq = 0;
let tmpRoot: string;
let dataDir: string;
let v2Path: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

beforeEach(() => {
  engines = [];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-status-"));
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
  /** send 应答前逐帧推送的注入序列（覆盖缺省 golden 流）。 */
  sendPushes: string[];
  /** 覆盖 read 应答（缺省 golden readResponse——assistant 全文）。 */
  readResult?: unknown;
}

interface EngineFixture {
  engine: ZcodeEngine;
  workspace: string;
}

function makeEngine(overrides: ScenarioOverrides): EngineFixture {
  seq += 1;
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  writeJson(scenarioFile, {
    createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    readResult: overrides.readResult ?? JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    sendPushes: overrides.sendPushes.map((l) => JSON.parse(l) as Record<string, unknown>),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      // 钉扎 appserver 定向（定向不探不降，与 zcode-engine-appserver.test.ts 同款）
      XYZ_ZCODE_MODE: "appserver",
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, workspace };
}

function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-status", ...overrides };
}

// ============================================================
// status='failed'（真实帧形）→ run-failed（⛔P-Z2 门修正根修回归面）
// ============================================================

describe("failed 终态分流（真实协议枚举：parsed 前消费 status → run-failed，不假成功）", () => {
  it("帧序 A：turn.terminal failed（errorCode/errorMessage）先到 + read 有全文 → run-failed 且详情取 terminal 帧（优先于 read 尾部）", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, TERMINAL_FAILED_REAL],
      // read 缺省 golden（有全文）——证明 terminal 帧详情优先级高于 read 尾部
    });
    const r: EngineRunResult = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    // F-3 文案形态：engine_run_failed 前缀 + 真实枚举值 failed + 会话 id（非 engine_timeout 族）
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
    expect(r.outcome.error).toContain(`（会话 ${GOLDEN_SESSION_ID}）`);
    expect(r.outcome.error).not.toContain("engine_timeout");
    // ⛔P-Z2：错误详情来自 terminal 帧（read/delta 携带不了——errorCode/errorMessage 优先）
    expect(r.outcome.error).toContain(`errorCode: ${TERMINAL_ERROR_CODE}`);
    expect(r.outcome.error).toContain(TERMINAL_ERROR_MESSAGE);
    // 详情已采信，read 尾部不再叠加（详情 > read 兜底的优先级裁决）
    expect(r.outcome.error).not.toContain(GOLDEN_FULL_TEXT);
    // 恢复指引（F-3）
    expect(r.outcome.error).toContain("engine_credential_missing 同族排查");
    // 失败形态（非成功）：异常终态口径 exitCode=null、content 空
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
    // run 不 reject——正常 handle 返回（record 必须收尾），sessionId 留痕进 sessionRef
    //（dbPath 形态随 2026-09 会话库隔离为隔离库绝对路径——zcodeSessionDbPath(engineDataDir)）
    expect(r.outcome.sessionId).toBe(GOLDEN_SESSION_ID);
    expect(r.handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: zcodeSessionDbPath(dataDir) });
  }, 15_000);

  it("帧序 B：final-frame 宽松 settle success 先到 + turn.terminal failed 迟到（lastTerminalStatus/lastTerminalError 衔接）→ 仍 run-failed", async () => {
    const f = makeEngine({
      // final-frame 先落定（session-channel 恒 settle success），权威 failed 只被记录
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, TERMINAL_FAILED_REAL],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
    // 迟到 terminal 帧的详情仍透传（channel 只记录不改写落定，消费层识破假成功）
    expect(r.outcome.error).toContain(`errorCode: ${TERMINAL_ERROR_CODE}`);
    expect(r.outcome.error).toContain(TERMINAL_ERROR_MESSAGE);
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
  }, 15_000);

  it("P-Z2 降级形态：failed 无 errorCode/errorMessage + final-frame 先到 + read 无错误信息 → 尾部兜底，仍 run-failed 不假成功", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, TERMINAL_FAILED_BARE],
      readResult: { messages: [] }, // read 无错误信息（降级形态判据）
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    // 覆盖面收窄但不假成功：final-frame 的宽松 success 不采信
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
    // 尾部以 finalText 降级合成（read 空 → 收尾帧全文 → delta 聚合的既有降级链）
    expect(r.outcome.error).toContain(GOLDEN_FULL_TEXT);
  }, 15_000);

  it("全空形态：仅 turn.terminal failed（无 delta/收尾帧/错误详情）+ read 空 → run-failed 且不伪造错误详情", async () => {
    const f = makeEngine({
      sendPushes: [TERMINAL_FAILED_BARE],
      readResult: { messages: [] },
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
    expect(r.outcome.error).toContain("服务端无返回内容");
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
  }, 15_000);

  it("schema 任务遇 failed 终态：分流先于 schema 校验（不产 schema_emulation_failed、不进强化重试）", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, TERMINAL_FAILED_REAL],
    });
    const r = await f.engine.run(
      makeTask({ cwd: f.workspace, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }),
      makeCtx(),
    );
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=failed/);
    expect(r.outcome.error).not.toContain("schema_emulation_failed");
    expect(r.outcome.parsedOutput).toBeUndefined();
  }, 15_000);
});

// ============================================================
// interrupted 不误判 + error 容错分支（⛔P-Z2 门修正的两翼）
// ============================================================

describe("非失败终态裁决（interrupted 随宿主 abort 主路径；error 容错防漂移）", () => {
  it("status:'interrupted'（真实枚举成员）→ 不误判失败：parsed 收口（用户中断不属引擎失败，落定语义登记）", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, TERMINAL_INTERRUPTED_FRAME],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    // 不分流：引擎侧不抢先把它终态化为失败（宿主 abort 主路径的收口语义保留）
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
  }, 15_000);

  it("status:'error'（非真实枚举，容错分支）→ 仍 run-failed 不假成功（防协议漂移滑回 v1 缺陷）", async () => {
    const f = makeEngine({
      sendPushes: [TERMINAL_ERROR_FRAME],
      readResult: { messages: [] },
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
    expect(r.outcome.error).toContain("服务端无返回内容");
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.content).toBe("");
  }, 15_000);
});

// ============================================================
// 成功路径零回归（负面验证——§8 A6 同族）
// ============================================================

describe("成功路径零回归（U3 分流不误伤正常终态）", () => {
  it("terminal success 先到（golden 流）→ parsed：content 全文、exitCode 0、无 error", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
  }, 15_000);

  it("final-frame 先到 + terminal success 迟到 → parsed（权威 success 后到不改写已落定的成功）", async () => {
    const f = makeEngine({
      // final-frame 在权威 terminal 之前到达（宽松终态先 settle，权威后到只记录）
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME, ZCODE_APPSERVER_GOLDEN.terminal[0]],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
  }, 15_000);

  it("final-frame 独走（无 turn.terminal 到达）→ parsed（无权威 status 可消费，不判失败）", async () => {
    const f = makeEngine({
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, GOLDEN_FINAL_FRAME],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
  }, 15_000);
});
