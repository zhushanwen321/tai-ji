// zcode-engine.reasoning-errors.test.ts —— create 帧择档（reasoningLevel/thoughtLevel）、
// appserver 错误分类回归门、单常驻进程多会话隔离。
//
// 拆分自 zcode-engine.test.ts（单文件 61 例是整包墙钟的临界路径）；用例体与
// describe 名逐字保留，共享夹具见 zcode-engine-harness.ts。
//
// 覆盖：reasoningLevel 值域择档（目录 modelRules → create 帧 model.options.reasoningLevel
// 与 thoughtLevel 镜像同值）/ 错误规格表（-32603 → engine_credential_missing；-32004 /
// -32010 → 任务失败上报；均不降级）/ 双会话并发不串线（FAKE_STAMP_SESSION）。

import * as fs from "node:fs";
import * as path from "node:path";

// 2026-10-27 测试范围收缩：本文件每例经 makeEngine 真实 spawn fake appserver 子进程（真进程 reasoning 镜像与
// 错误分类，e2e-map E2E-INTEG-65），整文件迁入集成门控 TAIJI_TEST_INTEGRATION——门控关闭时 skip，CI 或按改动
// 范围触发时真跑。门控 import 走包内副本 integration-gate.local.ts（SSOT = test-guard/integration-gate.ts）。
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "./integration-gate.local.ts";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "@zhushanwen/subagent-engine-sdk";
import type { RunContext } from "../port-types.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";
import {
  FAKE_CLI,
  GOLDEN_FULL_TEXT,
  PROVIDER,
  bootCount,
  dataDirPath,
  isRecord,
  makeCtx,
  makeEngine,
  makeTask,
  nextFixtureSlot,
  personalProviderConfigPath,
  readState,
  registerZcodeEngineHarness,
  sentFrames,
  tmpRootDir,
  trackEngine,
  v2ConfigPath,
  writeJson,
} from "./zcode-engine-harness.ts";

registerZcodeEngineHarness();

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
  const catalogPath = path.join(tmpRootDir(), "reasoning-catalog.json");
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

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `reasoningLevel 择档（目录值域 × thinkingLevel）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
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
// 多会话并发（RA3 双会话地基：FAKE_STAMP_SESSION——推送按会话归因）
// ============================================================

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `多会话并发（单常驻进程双会话不串线）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
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

interface ErrorScenario {  // oe-exempt:20261027:test:
  /** 主连接（常驻）scenario 覆盖：create/send 阶段错误注入。 */
  createError?: { code: number; message: string; data?: unknown };
  sendError?: { code: number; message: string; data?: unknown };
}

/** 建一个连到 fake 的引擎（degrade 分节私有——错误注入专版）。 */
function makeDegradeEngine(s: ErrorScenario = {}) {
  const { stateFile, scenarioFile, workspace } = nextFixtureSlot();
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
    engineDataDir: () => dataDirPath(),
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2ConfigPath(), personalProviderConfigPath: personalProviderConfigPath(), builtinCatalogPath: path.join(tmpRootDir(), "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  trackEngine(engine);
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

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `错误分类（错误规格表）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
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
