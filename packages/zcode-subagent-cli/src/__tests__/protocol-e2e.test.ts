// protocol-e2e.test.ts —— bin 级最小 e2e（W5 任务书验收：「node 直接跑 bin + NDJSON
// stdio 完成 initialize 握手与一次 fake run 的协议往返断言」；conformance 全套归 W10）。
//
// 形态：spawn `node bin/zcode-subagent-cli.mjs`（真实进程、真实 stdout 协议通道），
// 用 __fixtures__/fake-appserver.mjs 冒充 zcode CLI（XYZ_ZCODE_CLI 注入 + HOME 指
// tmp 写入合成 v2 config——合成 apiKey，绝不碰真实凭据/真实数据目录），断言：
//   ① initialize 握手应答（protocolVersion/engineId/capabilities）；
//   ② run 期间 host/* 反向请求（poolResolved/handleReady）可达且可应答；
//   ③ event 通知（text_delta 流 + 终态 message_end/turn_end，seq 单调）；
//   ④ run 终态应答：outcome.content 与 handle.sessionRef（隔离库 dbPath）正确；
//   ⑤ dispose 幂等应答 + 进程随 stdin 关闭退出（自灭守卫主判据的隐式验证）。
// 驱动面自持（不走 core EngineClient——对端语义互证靠帧形状与 SDK 判别守卫对齐）。

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ZCODE_APPSERVER_GOLDEN } from "../golden-sample.ts";
import { zcodeSessionDbPath } from "../db-path.ts";

const BIN = fileURLToPath(new URL("../../bin/zcode-subagent-cli.mjs", import.meta.url));
const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));
const GOLDEN_SESSION_ID = "sess_golden_r3_01";
const FINAL_TEXT = "你好，任务完成";

let root: string;
let dataDir: string;
let fakeHome: string;
let scenarioFile: string;

beforeAll(() => {
  root = mkdtempSync(joinTmp("zcode-cli-e2e-"));
  dataDir = path.join(root, "engine-data");
  fakeHome = path.join(root, "fake-home");
  mkdirSync(path.join(fakeHome, ".zcode", "v2"), { recursive: true });
  // 合成凭据（fake 值，仅满足 preparer 的 v2 单源校验形态——不是真实凭据）
  writeFileSync(
    path.join(fakeHome, ".zcode", "v2", "config.json"),
    JSON.stringify({
      provider: {
        "test-provider": {
          options: { apiKey: "synthetic-e2e-key", baseURL: "https://t.example" },
          models: { m1: {} },
        },
      },
    }),
  );
  scenarioFile = path.join(root, "scenario.json");
  writeFileSync(
    scenarioFile,
    JSON.stringify({
      createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
      // fake 的 sendPushes 要对象形态（golden 内嵌副本是 JSON 行字符串——先 parse）
      sendPushes: [...ZCODE_APPSERVER_GOLDEN.pushStream, ...ZCODE_APPSERVER_GOLDEN.terminal].map(
        (l) => JSON.parse(l) as Record<string, unknown>,
      ),
      readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
    }),
  );
});

afterAll(() => {
  rmSync(path.dirname(dataDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function joinTmp(prefix: string): string {
  return path.join(os.tmpdir(), prefix);
}

interface Inbound {
  kind: "response" | "notification" | "reverse";
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: string; message: string };
  params?: { runId?: string; seq?: number; event?: { type: string; delta?: string } };
}

/** 驱动一个引擎 CLI 进程：写帧 / 读帧 / 自动应答数据面 host/* 反向请求。 */
class EngineProc {
  private readonly child: ChildProcess;
  private readonly frames: Inbound[] = [];
  private waiters: Array<{ test: (f: Inbound) => boolean; resolve: (f: Inbound) => void }> = [];
  private closed = false;
  private stderrText = "";

  constructor(scenarioPath: string = scenarioFile) {
    this.child = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        XYZ_AGENT_DATA_DIR: dataDir,
        HOME: fakeHome,
        XYZ_ZCODE_CLI: FAKE_CLI,
        FAKE_SESSION_SCENARIO: scenarioPath,
        // 剥可能干扰的宿主继承面（CI/本地环境差异面收敛）
        ZCODE_SESSION_DB_PATH: "",
        ZCODE_SESSION_DB: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    let buffer = "";
    this.child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line !== "") this.onLine(line);
        nl = buffer.indexOf("\n");
      }
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (c: string) => {
      // 全量取证（分级日志断言数据源）+ 转发宿主 stderr（本地调试可见性）
      this.stderrText += c;
      process.stderr.write(`[engine-stderr] ${c}`);
    });
    this.child.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.resolve({ kind: "notification", method: "__closed__" });
    });
  }

  private onLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // 协议通道不该有坏行；忽略防挂死
    }
    let frame: Inbound;
    if (typeof parsed.method === "string" && parsed.method.startsWith("host/")) {
      frame = { kind: "reverse", id: parsed.id as string, method: parsed.method, params: parsed.params as Inbound["params"] };
      // 数据面自动应答（host/log 等 {ok:true}；两阶段面 {ack:true}）
      this.write({ id: parsed.id, result: { ok: true } });
    } else if (typeof parsed.method === "string") {
      frame = { kind: "notification", method: parsed.method, params: parsed.params as Inbound["params"] };
    } else {
      frame = {
        kind: "response",
        id: parsed.id as number,
        ...(parsed.result !== undefined ? { result: parsed.result } : {}),
        ...(parsed.error !== undefined ? { error: parsed.error as Inbound["error"] } : {}),
      };
    }
    this.frames.push(frame);
    this.waiters = this.waiters.filter((w) => {
      if (w.test(frame)) {
        w.resolve(frame);
        return false;
      }
      return true;
    });
  }

  write(frame: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  async waitFor(test: (f: Inbound) => boolean, timeoutMs = 30_000): Promise<Inbound> {
    const hit = this.frames.find(test);
    if (hit !== undefined) return hit;
    return new Promise<Inbound>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`waitFor timeout; frames so far: ${JSON.stringify(this.frames.map((f) => ({ m: f.method, id: f.id, k: f.kind })))}`));
      }, timeoutMs);
      this.waiters.push({
        test,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  async exited(timeoutMs = 10_000): Promise<boolean> {
    if (this.closed) return true;
    await this.waitFor((f) => f.method === "__closed__", timeoutMs).catch(() => null);
    return this.closed;
  }

  get allFrames(): readonly Inbound[] {
    return this.frames;
  }

  /** 子进程 stderr 全量（分级日志断言数据源——进程 close 后已 flush 完整）。 */
  get stderrOutput(): string {
    return this.stderrText;
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }

  /** 模拟宿主退出：关闭 stdin（自灭守卫主判据 = stdio EOF）。 */
  endStdin(): void {
    this.child.stdin?.end();
  }
}

describe("bin e2e：initialize → run → 终态应答 协议往返", () => {
  it("握手 + fake run 全链路（fake-appserver 冒充 zcode CLI）", { timeout: 60_000 }, async () => {
    const engine = new EngineProc();
    try {
      // ① initialize 握手
      engine.write({
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, hostInfo: { name: "vitest-e2e", version: "0.0.0", dataRoot: dataDir }, engineConfig: {} },
      });
      const init = await engine.waitFor((f) => f.kind === "response" && f.id === 1);
      expect(init.error).toBeUndefined();
      const initResult = init.result as {
        protocolVersion: number;
        engineId: string;
        capabilities: { schemaEnforcement: string; maxTurns: boolean };
      };
      expect(initResult.protocolVersion).toBe(1);
      expect(initResult.engineId).toBe("zcode");
      expect(initResult.capabilities.schemaEnforcement).toBe("emulated");
      expect(initResult.capabilities.maxTurns).toBe(false);

      // ② run（fake 场景：delta 流 + 终态 + read 兜底）
      engine.write({
        id: 2,
        method: "run",
        params: {
          runId: "run-e2e-1",
          task: { prompt: "做点什么" },
          ctx: { poolKey: "shared", cwd: dataDir, model: "test-provider/m1" },
        },
      });

      // host/poolResolved（journal 落盘路径权威——首个事件 emit 前到达）
      const pool = await engine.waitFor((f) => f.kind === "reverse" && f.method === "host/poolResolved");
      expect((pool.params as { poolKey?: string })?.poolKey).toBe("shared");
      // host/handleReady（create 应答后回填）
      const handle = await engine.waitFor((f) => f.kind === "reverse" && f.method === "host/handleReady");
      const handleParams = handle.params as { sessionRef?: Record<string, string> };
      expect(handleParams?.sessionRef?.["sessionId"]).toBe(GOLDEN_SESSION_ID);

      // ③ event 通知：text_delta（golden delta 拼接）+ 终态 message_end/turn_end
      const deltas: string[] = [];
      await engine.waitFor((f) => f.kind === "notification" && f.params?.event?.type === "turn_end");
      for (const f of engine.allFrames) {
        if (f.kind !== "notification" || f.params?.runId !== "run-e2e-1") continue;
        const ev = f.params.event;
        if (ev?.type === "text_delta" && typeof ev.delta === "string") deltas.push(ev.delta);
      }
      expect(deltas.join("")).toBe(FINAL_TEXT);
      const seqs = engine.allFrames
        .filter((f) => f.kind === "notification" && f.params?.runId === "run-e2e-1" && f.params?.seq !== undefined)
        .map((f) => f.params?.seq as number);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // seq 单调不减

      // ④ run 终态应答
      const runResp = await engine.waitFor((f) => f.kind === "response" && f.id === 2);
      expect(runResp.error).toBeUndefined();
      // 协议 RunResult.handle = EngineHandleData 本体（进程内 {data} 包装只在
      // EnginePort 面存在——与 RemoteEngine 的 `handle: { data: result.handle }` 对端互证）
      const runResult = runResp.result as {
        handle: { sessionRef: Record<string, string>; poolKey: string };
        outcome: { content: string; exitCode: number | null; error?: string; sessionId?: string };
      };
      expect(runResult.outcome.content).toBe(FINAL_TEXT);
      expect(runResult.outcome.exitCode).toBe(0);
      expect(runResult.outcome.sessionId).toBe(GOLDEN_SESSION_ID);
      expect(runResult.handle.sessionRef["sessionId"]).toBe(GOLDEN_SESSION_ID);
      // 隔离库路径单一来源（db-path 契约根）
      expect(runResult.handle.sessionRef["dbPath"]).toBe(zcodeSessionDbPath(dataDir));
      expect(runResult.handle.poolKey).toBe("shared");

      // ⑤ dispose 幂等 + ping
      engine.write({ id: 3, method: "dispose", params: {} });
      const disposeResp = await engine.waitFor((f) => f.kind === "response" && f.id === 3);
      expect(disposeResp.result).toEqual({ ok: true });
      engine.write({ id: 4, method: "dispose", params: {} });
      const disposeResp2 = await engine.waitFor((f) => f.kind === "response" && f.id === 4);
      expect(disposeResp2.result).toEqual({ ok: true });
      engine.write({ id: 5, method: "ping", params: {} });
      const ping = await engine.waitFor((f) => f.kind === "response" && f.id === 5);
      expect(ping.result).toEqual({ pong: true });

      // stdin 关闭（宿主退出面）→ 进程自灭（EOF 主判据的隐式验证）
      engine.endStdin();
      expect(await engine.exited()).toBe(true);
    } finally {
      engine.kill();
    }
  });
});

// ============================================================
// 权威终态迟到分级日志：stderr 兜底链路取证（bin 真进程全链——session-channel
// 分级 → SDK logger facade → cli-entry stderr 兜底 sink → 子进程 stderr）
// ============================================================

describe("bin e2e：final-frame 先落定 + 权威 turn.terminal 迟到的 stderr 分级", () => {
  /** 合成「pushStream + 收尾帧（先落定）+ 迟到 turn.terminal(status)」场景文件。 */
  function writeLateTerminalScenario(status: string): string {
    const file = path.join(root, `scenario-late-${status}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        createResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.createResponse),
        sendPushes: [
          ...ZCODE_APPSERVER_GOLDEN.pushStream.map(
            (l) => JSON.parse(l) as Record<string, unknown>,
          ),
          JSON.parse(ZCODE_APPSERVER_GOLDEN.terminal[1]) as Record<string, unknown>, // 收尾帧先落定（final-frame）
          { method: "v4/telemetry/event", params: { kind: "turn.terminal", status } }, // 迟到的权威终态
        ],
        readResult: JSON.parse(ZCODE_APPSERVER_GOLDEN.readResponse),
      }),
    );
    return file;
  }

  /** 走完 initialize → run → 退出全链，返回 run 应答与已退出的引擎实例。 */
  async function runOnce(scenarioPath: string): Promise<{ engine: EngineProc; runResp: Inbound }> {
    const engine = new EngineProc(scenarioPath);
    try {
      engine.write({
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, hostInfo: { name: "vitest-e2e", version: "0.0.0", dataRoot: dataDir }, engineConfig: {} },
      });
      const init = await engine.waitFor((f) => f.kind === "response" && f.id === 1);
      expect(init.error).toBeUndefined();
      engine.write({
        id: 2,
        method: "run",
        params: {
          runId: "run-late-terminal",
          task: { prompt: "做点什么" },
          ctx: { poolKey: "shared", cwd: dataDir, model: "test-provider/m1" },
        },
      });
      const runResp = await engine.waitFor((f) => f.kind === "response" && f.id === 2);
      // 退出后 stdio 管道已 flush（close 事件语义）——stderr 取证无竞态
      engine.endStdin();
      expect(await engine.exited()).toBe(true);
      return { engine, runResp };
    } catch (err) {
      engine.kill();
      throw err;
    }
  }

  it("迟到 success（常态迟到）：run 成功，stderr 无迟到终态日志（降噪根修点）", { timeout: 60_000 }, async () => {
    const { engine, runResp } = await runOnce(writeLateTerminalScenario("success"));
    try {
      expect(runResp.error).toBeUndefined();
      const outcome = (runResp.result as { outcome: { content: string } }).outcome;
      expect(outcome.content).toBe(FINAL_TEXT);
      expect(engine.stderrOutput).not.toContain("权威终态晚于落定");
      expect(engine.stderrOutput).not.toContain("[error]");
    } finally {
      engine.kill();
    }
  });

  it("迟到 interrupted：降 debug 且 stderr 无输出（依赖 SDK cli-entry sink 对 debug 跳过写）", { timeout: 60_000 }, async () => {
    const { engine, runResp } = await runOnce(writeLateTerminalScenario("interrupted"));
    try {
      // interrupted 不属失败终态（isFailedTerminalStatus 口径）——run 仍成功收口
      expect(runResp.error).toBeUndefined();
      expect(engine.stderrOutput).not.toContain("权威终态晚于落定");
      expect(engine.stderrOutput).not.toContain("[debug]"); // debug 级不落 stderr（CONSOLE_SINK 语义对齐）
      expect(engine.stderrOutput).not.toContain("[error]");
    } finally {
      engine.kill();
    }
  });

  it("迟到 failed：stderr 保留 warn（假成功识破防御面），文案含原样 status", { timeout: 60_000 }, async () => {
    const { engine, runResp } = await runOnce(writeLateTerminalScenario("failed"));
    try {
      // 权威 status=failed 经 lastTerminalStatus 分流为 run-failed（P-Z2 门修正）
      expect(runResp.error).toBeUndefined(); // run-failed 落 outcome.error，非协议 error 帧
      const outcome = (runResp.result as { outcome: { error?: string } }).outcome;
      expect(outcome.error).toContain("engine_run_failed");
      expect(engine.stderrOutput).toContain("权威终态晚于落定");
      expect(engine.stderrOutput).toContain('[warn]');
      expect(engine.stderrOutput).toContain('status="failed"');
    } finally {
      engine.kill();
    }
  });
});

