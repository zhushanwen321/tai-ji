// zcode-engine-retry.test.ts —— [P0-1 U4/D6] 瞬时失败自动重试一次测试
// （设计锚点 D6、F-1/F-4、U4）。全部跑 __fixtures__/fake-appserver.mjs 子进程
// （scenario 注入；crashAfterSendMs 为 U4 扩展的崩溃收割注入通道），绝不 spawn 真
// zcode.cjs。覆盖：
//   - 重试一次成功（连接崩溃形态）：crash → failAllTurns 收割 → 新会话重跑（进程
//     死后惰性重建 + scenario 切换）→ 自然终态；
//   - 重试仍失败（连接崩溃族）：文案补「已自动重试一次」句（u-z2 留的 F-1 补句
//     义务），boot 2 证据；
//   - 不可重试形态不重试：RPC 错误（-32004/-32601 漂移）/ status=error 终态（D6
//     被否③）/ 用户取消（aborted 短路）——各 create×1 无补句。
// （原预算继承面——resolveTransientRetryBudget 纯函数与显式总上界 env 门禁——随
// turn 双 timer 删除一并移除：重试轮不再携带上界预算。）

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
let personalPath: string;

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-retry-"));
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
    sources: { v2ConfigPath: v2Path, personalProviderConfigPath: personalPath, builtinCatalogPath: path.join(tmpRoot, "absent-catalog.json") },
    processEnv: {
      PATH: process.env.PATH ?? "",
      // 钉扎 appserver 定向（定向不探不降）
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

