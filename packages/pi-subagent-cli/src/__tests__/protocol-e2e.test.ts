// src/__tests__/protocol-e2e.test.ts
//
// 最小 e2e（W7 验收口径）：真实 spawn bin/pi-subagent-cli.mjs + NDJSON 往返——
// initialize → run（fake pi 子进程经 PATH 注入）→ host/* 反向通道到 fake 宿主
// 应答（host/childSpawned / host/handleReady / host/log / host/askUser ack 两阶段
// ——[池抽象降级] host/poolResolved 已退役）：→ run 终态应答（handle + outcome 等价断言）。
//
// fake pi（fixtures/fake-pi.mjs）：rpc 形态子进程——应答 get_state、回放事件流
// （tool/text_delta/turn_end/message_end）、发出 extension_ui_request（select
// ask_user）并等 extension_ui_response 后收尾退出。

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ENGINE_PROTOCOL_VERSION } from "@zhushanwen/subagent-engine-sdk";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(PKG_ROOT, "bin", "pi-subagent-cli.mjs");
const FAKE_PI = path.join(PKG_ROOT, "src", "__tests__", "__fixtures__", "fake-pi.mjs");

interface Frame {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
  params?: Record<string, unknown>;
}

/** fake 宿主：spawn 引擎 CLI + NDJSON 帧路由（请求应答 + 反向通道应答收集）。 */
class FakeHost {
  readonly proc: ReturnType<typeof spawn>;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (f: Frame) => void>();
  readonly reverseFrames: Frame[] = [];
  private readonly reverseResolvers = new Map<string, ((f: Frame) => void)[]>();
  private exited: Promise<{ code: number | null }>;

  constructor(extraEnv: Record<string, string>) {
    this.proc = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        XYZ_AGENT_DATA_DIR: extraEnv.XYZ_AGENT_DATA_DIR,
        PATH: `${path.dirname(FAKE_PI)}${path.delimiter}${process.env.PATH ?? ""}`,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.proc.once("exit", (code) => resolve({ code }));
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim() !== "") this.consume(JSON.parse(line) as Frame);
        nl = this.buffer.indexOf("\n");
      }
    });
  }

  private consume(frame: Frame): void {
    if (typeof frame.id === "number") {
      this.pending.get(frame.id)?.(frame);
      return;
    }
    // 反向请求（id: string "rev-N"）
    this.reverseFrames.push(frame);
    const waiters = this.reverseResolvers.get(String(frame.method));
    const w = waiters?.shift();
    w?.(frame);
  }

  send(frame: unknown): void {
    this.proc.stdin!.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: unknown): Promise<Frame> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  /** 已消费（应答过）的反向帧 id 集合——waitForReverse 的去重面。 */
  private readonly consumedReverse = new Set<string>();

  /** 等指定 method 的反向请求帧（先扫已到达未消费的，再等未来帧；每帧只匹配一次）。 */
  waitForReverse(method: string, timeoutMs = 10_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for reverse ${method}`)), timeoutMs);
      const done = (f: Frame): void => {
        clearTimeout(timer);
        resolve(f);
      };
      const buffered = this.reverseFrames.find(
        (f) => f.method === method && f.id !== undefined && !this.consumedReverse.has(String(f.id)),
      );
      if (buffered !== undefined && buffered.id !== undefined) {
        this.consumedReverse.add(String(buffered.id));
        done(buffered);
        return;
      }
      const list = this.reverseResolvers.get(method) ?? [];
      list.push((f) => {
        if (f.id !== undefined) this.consumedReverse.add(String(f.id));
        done(f);
      });
      this.reverseResolvers.set(method, list);
    });
  }

  /** 应答反向请求（两阶段：ackOnly = 只发 {ack:true}）。 */
  replyReverse(id: string, result: unknown, ackOnly = false): void {
    void ackOnly;
    this.send({ id, result });
  }

  async exit(): Promise<{ code: number | null }> {
    return this.exited;
  }

  kill(): void {
    this.proc.kill("SIGKILL");
  }
}

describe("pi-subagent-cli 协议 e2e（bin 真机 NDJSON 往返）", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir !== undefined) {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      dataDir = undefined;
    }
  });

  it("initialize → run → host/* 反向通道 → askUser 两阶段 → 终态应答", async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-e2e-"));
    const host = new FakeHost({ XYZ_AGENT_DATA_DIR: dataDir });
    try {
      // 1. initialize：版本协商 + 能力应答
      const init = await host.request("initialize", {
        protocolVersion: ENGINE_PROTOCOL_VERSION,
        hostInfo: { name: "fake-host", version: "0.0.0", dataRoot: dataDir },
        engineConfig: {},
      });
      expect(init.error).toBeUndefined();
      const initResult = init.result as { engineId: string; capabilities: { maxTurns: boolean } };
      expect(initResult.engineId).toBe("pi");
      expect(initResult.capabilities.maxTurns).toBe(true);

      // 2. run：fake pi 子进程执行（事件回流 + ask_user 反向）
      const runP = host.request("run", {
        runId: "run-e2e-1",
        task: { prompt: "say hi then ask", description: "e2e", agent: "worker" },
        ctx: { cwd: dataDir, model: "fake-provider/fake-model" },
      });

      // 3. 反向通道断言（按协议契约逐个应答；poolResolved 已随池抽象降级退役）
      const childSpawned = await host.waitForReverse("host/childSpawned");
      const childPid = (childSpawned.params as { pid: number }).pid;
      expect(Number.isInteger(childPid)).toBe(true);
      expect(typeof (childSpawned.params as { recordId: string }).recordId).toBe("string");
      host.replyReverse(String(childSpawned.id), { ok: true });

      // host/log 是条件通道（仅引擎有 warn/error 时发出）——不在此等待，
      // 数据面应答形态已由 poolResolved/childSpawned/handleReady 覆盖。

      // handleReady：get_state 握手回填 sessionFile
      const handleReady = await host.waitForReverse("host/handleReady");
      expect(typeof (handleReady.params as { sessionRef: Record<string, string> }).sessionRef.sessionFile).toBe("string");
      host.replyReverse(String(handleReady.id), { ok: true });

      // askUser 两阶段：先 ack（不终结等待），fake pi 挂起等用户答案
      const askUser = await host.waitForReverse("host/askUser");
      const askParams = askUser.params as { runId: string; request: { method: string; channel?: string } };
      expect(askParams.runId).toBe("run-e2e-1");
      expect(askParams.request.method).toBe("select");
      host.replyReverse(String(askUser.id), { ack: true });
      await new Promise((r) => setTimeout(r, 100));
      // 第二阶段：最终结果（value 送达 fake pi → extension_ui_response）
      host.replyReverse(String(askUser.id), { value: "A" });

      // 4. 终态应答：handle + outcome
      const runFrame = await runP;
      expect(runFrame.error).toBeUndefined();
      // 协议 run 终态应答的 handle = EngineHandleData 本体（进程内 {data} 包装已拆，
      // 与 RemoteEngine `handle: { data: result.handle }` 互证）
      const runResult = runFrame.result as {
        handle: { engineId: string; sessionRef: Record<string, string> };
        outcome: { content: string; sessionId?: string; usage?: { input: number } };
      };
      expect(runResult.handle.engineId).toBe("pi");
      expect(runResult.handle.sessionRef.recordId).toBe("run-e2e-1");
      expect(typeof runResult.handle.sessionRef.sessionFile).toBe("string");
      expect(runResult.outcome.content).toContain("final answer");
      expect(runResult.outcome.usage?.input).toBeGreaterThan(0);

      // 5. dispose + ping（引擎进程不退出——生命周期归宿主）
      const dispose = await host.request("dispose", {});
      expect((dispose.result as { ok: boolean }).ok).toBe(true);
      const ping = await host.request("ping", {});
      expect((ping.result as { pong: boolean }).pong).toBe(true);

      // stdin EOF = 宿主死亡主判据（R9-4②）：引擎应自灭（杀进程组，exit = signal
      // 形态 code null）——本断言同时隐式验证 fake pi 任务子进程随组收割（A3 面）。
      host.proc.stdin!.end();
      const { code } = await host.exit();
      expect(code).toBeNull();
    } finally {
      host.kill();
    }
  }, 60_000);
});

// fake pi 可执行性自检（spawnSync 探针失败时给出可操作报错）
describe("fake pi fixture 自检", () => {
  it("fake-pi.mjs 可执行且应答 --version", () => {
    const probe = spawnSync(process.execPath, [FAKE_PI, "--version"], { encoding: "utf8", timeout: 5000 });
    expect(propeOk(probe.status)).toBe(true);
  });
});

function propeOk(status: number | null): boolean {
  return status === 0;
}
