// zcode-engine.abort-dispose.test.ts —— abort 链（D3：stop → grace → killChain）、
// dispose（D6 主体）、dispose 收割（P0-1 U5/D7）。
//
// 拆分自 zcode-engine.test.ts（单文件 61 例是整包墙钟的临界路径）；用例体与
// describe 名逐字保留，共享夹具见 zcode-engine-harness.ts。
//
// 覆盖：stop 优雅生效（不杀共享进程）/ stop 无效 grace 耗尽（killChain + 崩溃路径收尾 +
// 重建）/ pre-aborted 短路 / 宿主超时 abort（engine_timeout）/ dispose 幂等与 close
// 帧先于 SIGTERM / dispose 后 run 自动重建 / 进程已死残留 activeSessions 的窄竞态 /
// 在途 turn 的 dispose 收割（不重试、窗口量级 + 同源常量静态断言）。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 2026-10-27 测试范围收缩：本文件每例经 makeEngine 真实 spawn fake appserver 子进程（真进程 abort 链 / dispose
// 收割，e2e-map E2E-INTEG-64），整文件迁入集成门控 TAIJI_TEST_INTEGRATION——门控关闭时 skip，CI 或按改动范围
// 触发时真跑。门控 import 走包内副本 integration-gate.local.ts（SSOT = test-guard/integration-gate.ts）。
import { INTEGRATION_TESTS_ENABLED, INTEGRATION_TESTS_SKIP_REASON } from "./integration-gate.local.ts";
import { describe, expect, it, vi } from "vitest";

import type { EngineRunResult, RunContext } from "../port-types.ts";
import { AppServerConnection } from "../connection.ts";
import {
  ZCODE_APPSERVER_HARVEST_GRACE_MS,
  ZCODE_KILL_GRACE_MS,
} from "../constants.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { SessionChannel } from "../session-channel.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";
import {
  FAKE_CLI,
  GOLDEN_FULL_TEXT,
  GOLDEN_SESSION_ID,
  HANG_PUSHES,
  bootCount,
  dataDirPath,
  makeCtx,
  makeEngine,
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
} from "./zcode-engine-harness.ts";

registerZcodeEngineHarness();

/** run 返回形态别名（abort 用例的中止终态断言范围）。 */
type EngineRunResult_ = EngineRunResult;

// ============================================================
// abort 链（D3：stop → grace → killChain；stop 成功不 kill）
// ============================================================

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `abort 链（D3）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
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
    // 杀链后的 finalize 确认窗（HARVEST_GRACE）同款注入：默认 1s×2 秒级等待不在
    // 单测范围——150ms 级仍保「close 迟到 → 有界返回」判据（窗口数值非契约）。
    vi.stubEnv("TAIJI_ZCODE_TEST_HARVEST_GRACE_MS", "150");
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
// dispose（D6 主体：幂等 / close 帧先于 SIGTERM / dispose 后 run 重建）
// ============================================================

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `dispose${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
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
    // 本形态的 close 永不到达（从未 spawn）→ dispose 恒走 HARVEST_GRACE 兜底窗：
    // 走 env 注入缝缩短到 150ms（判据 = 「窗口到点仍有界返回」，窗口数值非契约）。
    vi.stubEnv("TAIJI_ZCODE_TEST_HARVEST_GRACE_MS", "150");
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
      cwd: tmpRootDir(),
      env: {
        PATH: process.env.PATH ?? "",
        FAKE_STATE_FILE: path.join(tmpRootDir(), "state-dispose-guard.jsonl"),
        FAKE_SESSION_SCENARIO: path.join(tmpRootDir(), "scenario-dispose-guard.json"),
      },
      stderrLogPath: path.join(dataDirPath(), "logs", "dispose-guard-stderr.log"),
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

interface DisposeEngineFixture {  // oe-exempt:20261027:test:
  engine: ZcodeEngine;
  stateFile: string;
  scenarioFile: string;
  workspace: string;
}

function makeDisposeEngine(): DisposeEngineFixture {
  const { stateFile, scenarioFile, workspace } = nextFixtureSlot();
  writeJson(scenarioFile, {
    createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
    readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    sendPushes: HANG_PUSHES.map((l) => JSON.parse(l) as Record<string, unknown>),
  });
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDirPath(),
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2ConfigPath(), personalProviderConfigPath: personalProviderConfigPath(), builtinCatalogPath: path.join(tmpRootDir(), "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      TAIJI_ZCODE_MODE: "appserver",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  trackEngine(engine);
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

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `dispose 收割（P0-1 U5：引擎集成测试）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
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
    expect(engineSrc).toContain("setTimeout(() => finish(), harvestGraceMs())");
    // shutdownRuntimeAndDisposeChannel：dispose 收割 race 窗口（本单元挂接点）
    expect(engineSrc).toContain("delayResolved(harvestGraceMs()");
    // 两处同源的锚 = 同一解析函数，其缺省回落实参即 HARVEST_GRACE 常量
    //（env 注入缝只覆盖数值，不改变「两处同源」这一不变量）
    expect(engineSrc).toMatch(/function harvestGraceMs\(\)[\s\S]{0,240}ZCODE_APPSERVER_HARVEST_GRACE_MS/);
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
