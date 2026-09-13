// zcode-engine-retry.test.ts —— [P0-1 U4/D6] 瞬时失败自动重试一次 + 预算继承测试
// （设计权威源 docs/design/timeout-zcode-turn-and-settled-watchdog.md §6 D6、§5.2
// F-1/F-4、§10 U4、§11 P-Z4）。全部跑 __fixtures__/fake-appserver.mjs 子进程
// （scenario 注入；crashAfterSendMs 为 U4 扩展的崩溃收割注入通道），绝不 spawn 真
// zcode.cjs。覆盖：
//   - 预算继承纯函数（P-Z4「显式预算下重试轮不重置总预算」的数学本体）：剩余 =
//     总预算 − 已耗尽的精确断言 + 下限门禁 + 非显式 unbounded；
//   - 重试一次成功（连接崩溃形态）：crash → failAllTurns 收割 → 新会话重跑（进程
//     死后惰性重建 + scenario 切换）→ 自然终态；
//   - 重试仍失败两形态各一（超时族 / 连接崩溃族）：文案补「已自动重试一次」句
//     （u-z2 留的 F-1 补句义务），连接崩溃族 boot 2 证据；
//   - 不可重试形态不重试：RPC 错误（-32004/-32601 漂移）/ status=error 终态（D6
//     被否③）/ 用户取消（aborted 短路）——各 create×1 无补句；
//   - 显式预算 vs 默认配置行为差异（P-Z4 门禁集成面）：显式预算剩余充足 → 重试；
//     剩余不足下限 → depleted 不重试；env ≤0 显式关闭上界 → unbounded 重试不受
//     门禁（与 channel resolveTurnTimerMs 同一 env 通道，vi.stubEnv 缩短量级——
//     真实默认 60min/300s 下限不在单测等待范围）。
// 集成层无法在真实等待范围内让重试轮 fire 收窄后的上界（剩余 ≈ 300s 量级），「重试
// 轮上界=剩余」的数值精确断言由纯函数层承载（turnTimeoutMs 传递链路的集成行为由
// F1 用例的重试成功佐证）——分层等价，偏差已登记。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineRunResult, RunContext } from "../port-types.ts";
import type { AgentCallOpts } from "../port-types.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import {
  ZcodeEngine,
  ZCODE_TURN_RETRY_MIN_BUDGET_MS,
  resolveTransientRetryBudget,
  type ZcodeEngineDeps,
} from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

const GOLDEN_FULL_TEXT = "你好，任务完成";
/** 挂起场景：send 后零推送——turn 在途等待（crash 收割 / idle 判死的注入底座）。 */
const HANG_PUSHES: string[] = [];
/** 权威终态 turn.terminal 的 error 帧（status='error' 终态——D6 被否③的不可重试形态）。 */
const TERMINAL_ERROR_FRAME =
  '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"error"}}';

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-retry-"));
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

interface RpcErrorSpec {
  code: number;
  message: string;
  data?: unknown;
}

interface ScenarioOverrides {
  replaceSendPushes?: string[];
  stopBehavior?: "terminal" | "none" | "hang";
  sendError?: RpcErrorSpec;
  /** send 应答后 N ms 自杀（U4 扩展通道——连接崩溃收割注入）。 */
  crashAfterSendMs?: number;
  /** 非首代（崩溃后惰性重建代）send 的推送序列——重试轮的不同行为通道（U4）。 */
  rebootSendPushes?: string[];
}

interface EngineFixture {
  engine: ZcodeEngine;
  stateFile: string;
  workspace: string;
  /** 重写 scenario（新 fake 进程启动时重读——崩溃重建轮的形态切换通道）。 */
  rewriteScenario: (overrides: ScenarioOverrides) => void;
}

function makeEngine(overrides: ScenarioOverrides = {}): EngineFixture {
  seq += 1;
  const stateFile = path.join(tmpRoot, `state-${seq}.jsonl`);
  const scenarioFile = path.join(tmpRoot, `scenario-${seq}.json`);
  const workspace = path.join(tmpRoot, `ws-${seq}`);
  const write = (o: ScenarioOverrides): void => {
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
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      // 钉扎 appserver 定向（定向不探不降）；turn 阈值走全局 env stub（session-channel
      // 的 resolveTurnTimerMs 与引擎预算门禁都直读 process.env——D2 env 通道）
      XYZ_ZCODE_MODE: "appserver",
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

function createCount(stateFile: string): number {
  return sentMethods(stateFile).filter((m) => m === "session/create").length;
}

function bootCount(stateFile: string): number {
  return readState(stateFile).filter((e) => e.ev === "boot").length;
}

function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-retry", ...overrides };
}

// ============================================================
// 预算继承纯函数（P-Z4 数学本体：剩余 = 总预算 − 已耗尽，不重置）
// ============================================================

describe("resolveTransientRetryBudget（P-Z4：显式预算下重试轮不重置总预算）", () => {
  it("显式预算下剩余 = 总预算 − 已耗尽（精确数值，重试轮上界=剩余）", () => {
    expect(resolveTransientRetryBudget(3_600_000, 1_800_000)).toEqual({ state: "inherit", remainingMs: 1_800_000 });
    expect(resolveTransientRetryBudget(400_000, 100_000)).toEqual({ state: "inherit", remainingMs: 300_000 });
  });

  it("剩余恰为下限 → inherit（边界含）；剩余低于下限 → depleted（不重试直接终态化）", () => {
    expect(resolveTransientRetryBudget(ZCODE_TURN_RETRY_MIN_BUDGET_MS, 0)).toEqual({
      state: "inherit",
      remainingMs: ZCODE_TURN_RETRY_MIN_BUDGET_MS,
    });
    expect(resolveTransientRetryBudget(360_000, 300_000)).toEqual({ state: "depleted" });
  });

  it("非显式预算（env 未设/非法回落/≤0 显式关闭）→ unbounded（无总预算面，重试不受门禁）", () => {
    expect(resolveTransientRetryBudget(undefined, 0)).toEqual({ state: "unbounded" });
    expect(resolveTransientRetryBudget(undefined, 999_999)).toEqual({ state: "unbounded" });
  });
});

// ============================================================
// 集成：重试一次成功（连接崩溃形态，D6/F-4 主路径）
// ============================================================

describe("瞬时失败自动重试一次（P0-1 U4：新会话重跑）", () => {
  it("连接崩溃 → 重试轮新会话重跑成功：boot 2（惰性重建）+ create×2 + 自然终态（默认配置，无显式预算）", async () => {
    // 首代 hang + crash（收割 conn-closed）；重建代（重试轮）走完整 golden 流自然终态
    // ——run 整体 await 无法经 rewriteScenario 插手重试轮，rebootSendPushes 是代感知通道
    const f = makeEngine({
      crashAfterSendMs: 120,
      rebootSendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal],
    });
    const r: EngineRunResult = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(r.outcome.exitCode).toBe(0);
    // 机械证据：崩溃 boot 1 + 重试轮惰性重建 boot 2；首轮 + 重试轮各自 create 新会话
    expect(bootCount(f.stateFile)).toBe(2);
    expect(createCount(f.stateFile)).toBe(2);
  }, 20_000);

  it("重试仍失败·超时族：文案补「已自动重试一次仍超时」句（F-1 补句义务），进程不杀（boot 1）", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "300");
    const f = makeEngine(); // hang + stopBehavior 缺省 terminal（两轮止损链都 stop-acked）
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_timeout:/);
    // u-z2 留的补句义务：仅重试真实发生后出现（F-1 样例句逐字）
    expect(r.outcome.error).toContain("已自动重试一次仍超时");
    expect(r.outcome.error).toContain("重试在止损链终局后启动，无新旧任务双跑窗");
    // 重试轮同样走止损链（stop 已送达）+ 停止损不杀共享进程（boot 1）
    expect(r.outcome.error).toContain("session/stop 已送达");
    expect(bootCount(f.stateFile)).toBe(1);
    expect(createCount(f.stateFile)).toBe(2);
  }, 20_000);

  it("重试仍失败·连接崩溃族：重建轮再崩溃 → 文案补「已自动重试一次仍失败」句（F-4 已重试 1 次）", async () => {
    const f = makeEngine({ crashAfterSendMs: 120 }); // scenario 固定 crash——重建轮同样崩溃
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 会话执行失败/);
    expect(r.outcome.error).toContain("已自动重试一次仍失败");
    // 一次封顶：首轮 + 重试轮共两次会话、两代进程（崩溃自动重建），不再第三轮
    expect(createCount(f.stateFile)).toBe(2);
    expect(bootCount(f.stateFile)).toBe(2);
  }, 20_000);
});

// ============================================================
// 不可重试形态不重试（D6 被否谱系 + 形态排除）
// ============================================================

describe("不可重试形态不重试（一次会话收口，无补句）", () => {
  it("RPC 错误（-32004 busy）：非瞬时形态 → 不重试（create×1）", async () => {
    const f = makeEngine({ sendError: { code: -32004, message: "Session is busy" } });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toContain("-32004");
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
    expect(bootCount(f.stateFile)).toBe(1);
  }, 15_000);

  it("漂移码（-32601）：R5 降级链专属语义，不进瞬时重试（D6 被否②）", async () => {
    const f = makeEngine({ sendError: { code: -32601, message: "method not found" } });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toContain("-32601");
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
  }, 15_000);

  it("status='error' 终态：D6 被否③（错误内容可能非瞬时）→ 不重试（create×1）", async () => {
    const f = makeEngine({ replaceSendPushes: [TERMINAL_ERROR_FRAME] });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 终态 status=error/);
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
    expect(bootCount(f.stateFile)).toBe(1);
  }, 15_000);

  it("用户取消（turn 在途时 abort）：aborted 短路优先 → 不重试（create×1）", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "5000");
    const f = makeEngine(); // hang + stopBehavior terminal（stop 优雅生效 → aborted 收口）
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx({ signal: controller.signal }));
    // 用户取消入口现状语义零改动（U2）：engine_run_failed 中止标记（非超时语义）
    expect(r.outcome.error).toContain("被中止");
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
  }, 15_000);
});

// ============================================================
// 显式预算 vs 默认配置（P-Z4 门禁集成面）
// ============================================================

describe("显式预算门禁与默认配置的行为差异（P-Z4 集成面）", () => {
  it("显式预算剩余充足（310s > 300s 下限 + 首轮消耗）→ 重试发生：boot 2 + create×2 + 自然终态", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_MAX_TIMEOUT_MS", "310000");
    const f = makeEngine({
      crashAfterSendMs: 120,
      rebootSendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal],
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    // 重试未被预算门禁拦截（剩余 ≥ 下限），重试轮成功收口
    expect(r.outcome.error).toBeUndefined();
    expect(r.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(bootCount(f.stateFile)).toBe(2);
    expect(createCount(f.stateFile)).toBe(2);
  }, 20_000);

  it("显式预算剩余不足下限（60s − 消耗 < 300s）→ depleted 不重试：boot 1 + create×1 + 无补句", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_MAX_TIMEOUT_MS", "60000");
    const f = makeEngine({ crashAfterSendMs: 120 }); // scenario 固定 crash（无重试即不重建）
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_run_failed: app-server 会话执行失败/);
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
    expect(bootCount(f.stateFile)).toBe(1);
  }, 15_000);

  it("env ≤0 显式关闭总上界 → 无显式预算（unbounded）→ 重试不受门禁：boot 2 证据", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_MAX_TIMEOUT_MS", "0");
    const f = makeEngine({ crashAfterSendMs: 120 }); // scenario 固定 crash——重试轮同样崩溃
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toContain("已自动重试一次仍失败");
    expect(createCount(f.stateFile)).toBe(2);
    expect(bootCount(f.stateFile)).toBe(2);
  }, 20_000);

  it("超时族 + 预算门禁拦截（depleted）→ 未重试：engine_timeout 文案不含补句（补句仅随真实重试，F-1 一致性）", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "300");
    vi.stubEnv("XYZ_ZCODE_TURN_MAX_TIMEOUT_MS", "60000"); // 剩余 60s − 首轮消耗 < 300s 下限
    const f = makeEngine(); // hang + stop terminal（首轮 idle 判死 → timeout 形态）
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_timeout:/);
    expect(r.outcome.error).toContain("idle 判定");
    // 目标 3 的反面断言：未重试形态不含「已自动重试」句（与行为一致）
    expect(r.outcome.error).not.toContain("已自动重试");
    expect(createCount(f.stateFile)).toBe(1);
    expect(bootCount(f.stateFile)).toBe(1);
  }, 15_000);
});
