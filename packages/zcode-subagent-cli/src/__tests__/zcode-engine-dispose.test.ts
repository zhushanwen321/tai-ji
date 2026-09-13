// zcode-engine-dispose.test.ts —— P0-1 U5 dispose 收割（引擎集成面，fake-appserver
// 子进程，绝不 spawn 真 zcode.cjs）。
//
// 设计权威源：docs/design/timeout-zcode-turn-and-settled-watchdog.md §3.4（退化
// 路径）、§6 D7（dispose 收割兜底）、§11 P-Z3。真实现场（真实环境的 close 吞没）
// 归 Gate B；本文件验证引擎层可注入的集成行为：
//   ① dispose 时在途 turn 收敛为明确失败（不挂满 turn 预算）且不触发重试轮
//     （u-z4 disposed 标志衔接：收割 ≠ 瞬时崩溃——boot 1 / create×1 机械证据）；
//   ② dispose 全链窗口 = HARVEST_GRACE 量级（与 awaitConnFinalized 同源常量——
//     行为耗时断言 + 源码常量同源静态断言）。
// channel 层 close 吞没形态的机制断言在 session-channel-dispose-harvest.test.ts
// （mock 连接——真实子进程形态下 Node close 事件不可吞没，P-Z3 真实现场归 Gate B）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineRunResult, RunContext } from "../port-types.ts";
import type { AgentCallOpts } from "../port-types.ts";
import {
  ZCODE_APPSERVER_HARVEST_GRACE_MS,
  ZCODE_KILL_GRACE_MS,
} from "../constants.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

const GOLDEN_SESSION_ID = "sess_golden_r3_01";
/** 挂起场景：send 后零推送——turn 无事件无终态（dispose 收割的形态前提）。 */
const HANG_PUSHES: string[] = [];

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-dispose-"));
  dataDir = path.join(tmpRoot, "data");
  v2Path = path.join(tmpRoot, "v2.json");
  writeJson(v2Path, {
    provider: { [PROVIDER]: { options: { apiKey: "k", baseURL: "https://t.example" }, models: { m1: {} } } },
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface EngineFixture {
  engine: ZcodeEngine;
  stateFile: string;
  scenarioFile: string;
  workspace: string;
}

function makeEngine(): EngineFixture {
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
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      XYZ_ZCODE_MODE: "appserver",
      FAKE_STATE_FILE: stateFile,
      FAKE_SESSION_SCENARIO: scenarioFile,
    },
  };
  const engine = new ZcodeEngine(deps);
  engines.push(engine);
  return { engine, stateFile, scenarioFile, workspace };
}

// ── 流水读取 helpers（与 zcode-engine-timeout.test.ts 同款） ──

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

function sentMethods(stateFile: string): string[] {
  return readState(stateFile)
    .map((e) => e.frame)
    .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.method === "string")
    .map((f) => f.method as string);
}

function bootCount(stateFile: string): number {
  return readState(stateFile).filter((e) => e.ev === "boot").length;
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

function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-dispose", ...overrides };
}

// ============================================================
// dispose 收割（P0-1 U5/D7：在途 turn 收敛 + 不重试 + 窗口量级）
// ============================================================

describe("dispose 收割（P0-1 U5：引擎集成面）", () => {
  it("dispose 时在途 turn 收敛为明确失败且不重试：engine_run_failed、boot 1、create×1（收割≠瞬时崩溃，u-z4 disposed 短路）", async () => {
    // 两 timer 显式关闭（规则 19 opt-out 形态）——排除 timeout 判死路径，
    // 本用例的失败终态只能来自 dispose 收割链（onClose failAllTurns → dispose
    // no-op 幂等；close 吞没变体由 channel 层 mock 测试承载）
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "0");
    vi.stubEnv("XYZ_ZCODE_TURN_MAX_TIMEOUT_MS", "0");
    const f = makeEngine();
    const runPromise: Promise<EngineRunResult> = f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
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
    // 收割在 grace 量级窗口闭合，而非挂满 turn 预算（30min/60min 量级差异）
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
