// zcode-engine-timeout.test.ts —— [P0-1 U2] 引擎超时处置链测试（设计权威源
// docs/design/timeout-zcode-turn-and-settled-watchdog.md §6 D3/D4、§5.2 F-1/F-2）。
// 全部跑 __fixtures__/fake-appserver.mjs 子进程（scenario 注入），绝不 spawn 真
// zcode.cjs。覆盖：
//   - stop 应答三态裁决各一（D3 v1.1 超时入口 escalateOn:"stop-outcome"）：
//     ① stop 成功应答 → 止损确认链终止，共享进程不杀（boot 计数复用证据）；
//     ② 协议性 error 应答（stopError 注入，健康形态竞态——closeSession 先行关会话）
//        → 不升级杀链（「stop 报错一律升级会误杀健康进程」的击穿修正回归面）；
//     ③ stop 无应答（stopBehavior:'hang'——控制面假死形态，SIGSTOP 等价）→ 3s 超时
//        判连接级失败 → killChain 升级 → 进程死亡 + 下一任务重建（boot 2 机械证据）；
//   - engine_timeout 前缀归类（D4，与 engine_run_failed 分流）+ 会话 id 留痕；
//   - idle / ceiling 两形态文案有别（ceiling 附 XYZ_ZCODE_TURN_MAX_TIMEOUT_MS env
//     自救通道——§5.2 F-2）；
//   - 非超时错误不受影响（sendError → engine_run_failed 原路径，abort 链不触发）；
//   - alive 守卫（修复轮）：conn 已 finalize 的微窗口内 stop 分支不惰性重建进程
//     （对称 closeSession 的 !alive 守卫），按连接级失败形态终局。
// idle/ceiling 阈值经 vi.stubEnv 缩短（session-channel 的 env 通道，D2）——真实默认
// 30min/60min 不在单测等待范围。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineRunResult, RunContext } from "../port-types.ts";
import type { AgentCallOpts } from "../port-types.ts";
import { zcodeSessionDbPath } from "../db-path.ts";
import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { AppServerConnection } from "../connection.ts";
import { SessionChannel, TurnTimeoutError } from "../session-channel.ts";
import { ZcodeEngine, type ZcodeEngineDeps } from "../zcode-engine.ts";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const PROVIDER = "test-provider";

const GOLDEN_SESSION_ID = "sess_golden_r3_01";
const GOLDEN_FULL_TEXT = "你好，任务完成";
/** 挂起场景：send 后零推送——turn 无事件（idle 主判定的判死形态）。 */
const HANG_PUSHES: string[] = [];

interface RpcErrorSpec {
  code: number;
  message: string;
  data?: unknown;
}

interface ScenarioOverrides {
  replaceSendPushes?: string[];
  stopBehavior?: "terminal" | "none" | "hang";
  stopError?: RpcErrorSpec;
  sendError?: RpcErrorSpec;
}

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-eng-timeout-"));
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
  /** 重写 scenario（新 fake 进程启动时重读——killChain 重建轮的形态切换通道）。 */
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
      ...(o.stopError !== undefined ? { stopError: o.stopError } : {}),
      ...(o.sendError !== undefined ? { sendError: o.sendError } : {}),
    });
  };
  write(overrides);
  const deps: ZcodeEngineDeps = {
    engineDataDir: () => dataDir,
    cliPath: FAKE_CLI,
    sources: { v2ConfigPath: v2Path },
    processEnv: {
      PATH: process.env.PATH ?? "",
      // 钉扎 appserver 定向（定向不探不降）；idle/ceiling 阈值走全局 env stub
      // （session-channel 的 resolveTurnTimerMs 直接读 process.env——D2 env 通道）
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
    scenarioFile,
    workspace,
    rewriteScenario: (o) => write(o),
  };
}

// ── 流水读取 helpers（与 zcode-engine-appserver.test.ts 同款） ──

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

/** fake 进程 pid（boot 流水记录——进程探活的取证面：kill(pid,0) 不抛即存活）。 */
function bootPid(stateFile: string): number {
  const boot = readState(stateFile).find((e) => e.ev === "boot");
  if (!boot || typeof boot["pid"] !== "number") throw new Error("boot 流水缺失 pid");
  return boot["pid"];
}

/** 进程探活（信号 0 不投递只探测）：返回 true = 存活。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeTask(overrides?: Partial<AgentCallOpts>): AgentCallOpts {
  return { prompt: "做点什么", description: "s", model: `${PROVIDER}/m1`, ...overrides };
}

function makeCtx(overrides?: Partial<RunContext>): RunContext {
  return { taskId: "sa-timeout", ...overrides };
}

// ============================================================
// stop 应答三态裁决（D3 v1.1 超时入口）+ engine_timeout 归类（D4）
// ============================================================

describe("超时处置链（P0-1 U2：catch 分流 → stop-outcome 三态裁决 → engine_timeout）", () => {
  it("态① stop 成功应答：止损确认链终止，outcome 止损路径=「stop 已送达」，共享进程不杀（复用轮 boot 1）", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "300");
    const f = makeEngine(); // hang 场景（send 后零事件）+ stopBehavior 缺省 terminal（reply stopped）
    const r: EngineRunResult = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    // D4 归类：engine_timeout 前缀 + idle 判定标注 + 会话 id 留痕
    expect(r.outcome.error).toMatch(/^engine_timeout:/);
    expect(r.outcome.error).toContain("idle 判定");
    expect(r.outcome.exitCode).toBeNull();
    expect(r.outcome.sessionId).toBe(GOLDEN_SESSION_ID);
    // D3 强制可观测面（r3 SG-4）：止损路径 = stop 已送达
    expect(r.outcome.error).toContain("session/stop 已送达");
    expect(r.outcome.error).not.toContain("升级杀链");
    // 恢复指引（§5.2 F-1）
    expect(r.outcome.error).toContain("engine: pi");
    // stop 帧已发出（send 之后）
    const methods = sentMethods(f.stateFile);
    expect(methods).toContain("session/stop");
    expect(methods.indexOf("session/stop")).toBeGreaterThan(methods.indexOf("session/send"));
    // 不杀共享进程（机械证据）：fake 进程仍存活 + 全程零重启（boot 计数 1）。
    // （复用进程时 scenario 固化在其内存——下一任务无法切正常场景，探活是「不杀」
    // 的直接证据；进程若被 killChain 收割则探活必失败。）
    expect(processAlive(bootPid(f.stateFile))).toBe(true);
    expect(bootCount(f.stateFile)).toBe(1);
  }, 20_000);

  it("态② 协议性 error 应答（会话已回收形态）：不升级杀链（健康形态竞态——stop 报错 ≠ 控制面死）", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "300");
    const f = makeEngine({
      stopError: { code: -32004, message: "Session is not active" },
    });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_timeout:/);
    expect(r.outcome.error).toContain("idle 判定");
    // 止损路径 = 协议性 error 分支，绝不出现杀链分支专属文案
    expect(r.outcome.error).toContain("协议性 error");
    expect(r.outcome.error).not.toContain("无应答已升级杀链");
    expect(sentMethods(f.stateFile)).toContain("session/stop");
    // 进程未被杀（机械证据：探活 + 零重启）——本用例守护的正是「stop 失败一律升级」
    // 修正后不误杀健康共享进程的回归面（D3 被否谱系第四条）
    expect(processAlive(bootPid(f.stateFile))).toBe(true);
    expect(bootCount(f.stateFile)).toBe(1);
  }, 20_000);

  it("态③ stop 无应答（hang=控制面假死）：3s 超时判连接级失败 → killChain 升级 → 进程死亡 + 重建（boot 2）", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "300");
    const f = makeEngine({ stopBehavior: "hang" });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_timeout:/);
    expect(r.outcome.error).toContain("idle 判定");
    // D3 强制可观测面（A2 对称）：止损路径 = stop 无应答已升级杀链
    expect(r.outcome.error).toContain("session/stop 无应答已升级杀链");
    expect(sentMethods(f.stateFile)).toContain("session/stop");
    // killChain 真的收割了共享进程（机械证据）：旧 fake 进程已死（探活失败）
    expect(processAlive(bootPid(f.stateFile))).toBe(false);
    // 切换正常场景后下一任务必须重建（boot 计数：U4 起首轮 killChain 收口后自动重试
    // 一次——重试轮经惰性重建 boot 2（同 scenario 仍 hang+stop hang → 重试轮也走
    // killChain 收口）；本用例的下一任务再重建 boot 3——「killChain 后重建」语义不变，
    // 计数随 U4 重试 +1）
    f.rewriteScenario({ replaceSendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal] });
    const r2 = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r2.outcome.error).toBeUndefined();
    expect(r2.outcome.content).toBe(GOLDEN_FULL_TEXT);
    expect(bootCount(f.stateFile)).toBe(3);
  }, 40_000);

  it("ceiling 形态（idle 关闭 + 总上界判死）：文案标 chatty-wedge + 附 XYZ_ZCODE_TURN_MAX_TIMEOUT_MS env 自救通道（F-2）", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "0"); // 显式关闭 idle（规则 19 opt-out）
    vi.stubEnv("XYZ_ZCODE_TURN_MAX_TIMEOUT_MS", "400");
    const f = makeEngine();
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toMatch(/^engine_timeout:/);
    expect(r.outcome.error).toContain("总上界");
    expect(r.outcome.error).toContain("chatty-wedge");
    // env 自救通道提示（F-2 与 idle 形态的文案分野）
    expect(r.outcome.error).toContain("XYZ_ZCODE_TURN_MAX_TIMEOUT_MS");
    expect(r.outcome.error).toContain("0 关闭总上界");
    // idle 形态专属的「连续静默」文案不出现
    expect(r.outcome.error).not.toContain("连续静默");
    expect(r.outcome.error).toContain("session/stop 已送达");
  }, 20_000);

  it("非超时错误不受影响：sendError → engine_run_failed 原路径，abort 链不触发（流水无 session/stop）", async () => {
    const f = makeEngine({ sendError: { code: -32004, message: "Session is not active" } });
    const r = await f.engine.run(makeTask({ cwd: f.workspace }), makeCtx());
    expect(r.outcome.error).toContain("engine_run_failed");
    expect(r.outcome.error).not.toContain("engine_timeout");
    expect(r.outcome.error).toContain("-32004");
    expect(r.outcome.sessionId).toBe(GOLDEN_SESSION_ID);
    // abort 链未被触发：流水只有 create/subscribe/send/close，无 stop
    expect(sentMethods(f.stateFile)).not.toContain("session/stop");
  }, 15_000);

  it("handle 锚定不变量在超时收口下成立：onHandleReady 已回填 sessionId + poolKey（不变量 3 不因超时路径缺失）", async () => {
    vi.stubEnv("XYZ_ZCODE_TURN_IDLE_TIMEOUT_MS", "300");
    const f = makeEngine();
    const ready: Array<{ sessionId: unknown }> = [];
    const r = await f.engine.run(
      makeTask({ cwd: f.workspace }),
      makeCtx({
        onHandleReady: (partial) =>
          ready.push({ sessionId: partial.sessionRef["sessionId"] }),
      }),
    );
    expect(ready).toEqual([
      { sessionId: GOLDEN_SESSION_ID},
      // U4 起首轮超时收口后自动重试一次（同 hang 场景）——重试轮 create 再回填一次，
      // 值相同（同一 fake 的 golden create 应答）：不变量 3 每轮 create 都成立
      { sessionId: GOLDEN_SESSION_ID},
    ]);
    expect(r.handle.data.sessionRef).toEqual({ sessionId: GOLDEN_SESSION_ID, dbPath: zcodeSessionDbPath(dataDir) });
  }, 20_000);

  it("alive 守卫：conn 已 finalize（进程死+收割完成微窗口）时 stop 分支不惰性重建，按连接级失败形态终局", async () => {
    // 真实微拍窗口（turn 判死与 abort 链发 stop 之间进程 finalize 完成）不可从公开
    // 面同步注入——白盒构造同形态快照（dispose 窄竞态守卫测试同款先例）：真实
    // AppServerConnection 从未启动（child=null 等价 finalize 完成快照），onSpawned
    // 探针锁「request → ensureStarted 惰性重建」未发生（守卫缺失时 stop 分支必凭空
    // spawn 新一代进程再写帧）。
    let spawned = false;
    const conn = new AppServerConnection({
      cliPath: FAKE_CLI,
      cwd: tmpRoot,
      env: {
        PATH: process.env.PATH ?? "",
        FAKE_STATE_FILE: path.join(tmpRoot, "state-alive-guard.jsonl"),
        FAKE_SESSION_SCENARIO: path.join(tmpRoot, "scenario-alive-guard.json"),
      },
      stderrLogPath: path.join(dataDir, "logs", "alive-guard-stderr.log"),
      onSpawned: () => {
        spawned = true;
      },
    });
    expect(conn.alive).toBe(false); // 快照前置：无活进程（finalize 完成形态）
    const engine = new ZcodeEngine({
      engineDataDir: () => dataDir,
      cliPath: FAKE_CLI,
      sources: { v2ConfigPath: v2Path },
      processEnv: { PATH: process.env.PATH ?? "", XYZ_ZCODE_MODE: "appserver" },
    });
    engines.push(engine);
    const ghostRt = {
      conn,
      channel: new SessionChannel(conn),
      activeSessions: new Set<string>(),
    };
    const turn: Promise<unknown> = Promise.reject(
      new TurnTimeoutError("idle", { thresholdMs: 300, elapsed: 301, lastEventAt: undefined }),
    );
    void turn.catch(() => undefined); // abort 链只 race 不 await reject——防 unhandled rejection
    const chain = (
      engine as unknown as {
        appServerAbortChain: (
          rt: unknown,
          turn: Promise<unknown>,
          getSessionId: () => string | undefined,
          sessionCreated: Promise<void>,
          entry: { escalateOn: "turn-settled" | "stop-outcome" },
        ) => Promise<string>;
      }
    ).appServerAbortChain.bind(engine);
    // 超时入口：conn 已死 = 连接级失败形态——不发 stop、不惰性重建，直接杀链终局
    const stopPath = await chain(ghostRt, turn, () => GOLDEN_SESSION_ID, Promise.resolve(), {
      escalateOn: "stop-outcome",
    });
    expect(stopPath).toBe("stop-unreachable-killed");
    expect(spawned).toBe(false); // 守卫生效：零惰性 spawn（无新进程被凭空拉起）
    expect(conn.alive).toBe(false); // 连接保持死亡态（无 request 触发重建）
    // 用户取消入口：跳过 stop 落回 grace race——turn 已 reject 立即 settled（零重建）
    const settledPath = await chain(ghostRt, turn, () => GOLDEN_SESSION_ID, Promise.resolve(), {
      escalateOn: "turn-settled",
    });
    expect(settledPath).toBe("settled-in-grace");
    expect(spawned).toBe(false);
  }, 15_000);
});
