// src/__tests__/protocol-chat-e2e.test.ts
//
// [H1 U3] chat 轮 run 派发形态 e2e（真机 NDJSON 往返）：spawn bin/pi-subagent-cli.mjs
// + fake-pi-chat.mjs（PATH 注入，每轮一进程——agent_settled 后引擎杀链收割）。
// 覆盖 chat-run 统一的线上形态（设计 docs/design/subagent-chat-run-unification.md
// §3.3 D6/D7 + §5 U3 验收「resume run 续写同文件、历史召回」）：
//   ① 首轮 run chat（无 resume）→ 反向帧链（poolResolved/childSpawned[recordId]/
//      handleReady/streamDelta[runId]）→ run 应答（handle 锚 recordId）→ 收割
//      （childStateChanged exited 上报）；不经 ChatSessionRegistry——无轮次相位帧；
//   ② 续聊 = 新 run chat + resume（首轮 sessionFile）→ fake 从同文件读到首轮写入
//      的历史（构造性召回断言：当且仅当 --session 穿透正确）→ run 应答 sessionFile
//      与首轮一致（同文件续写）；
//   ③ 反向帧面收缩断言：全部反向帧 ∈ run 域 8 通道白名单（[H1 U5] 轮次相位
//      通道已退役——轮终 = run 应答本身，无相位帧）。
// cancel 收敛的升级路径（fake timers 杀链）见 run-spawn-once 集成面；one-shot 收割
// 对照见 run-spawn-once.integration。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ENGINE_PROTOCOL_VERSION } from "@zhushanwen/subagent-engine-sdk";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(PKG_ROOT, "bin", "pi-subagent-cli.mjs");
const FIXTURE_DIR = path.join(PKG_ROOT, "src", "__tests__", "__fixtures__");

interface Frame {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
  params?: Record<string, unknown>;
}

/** fake 宿主（protocol-e2e.test.ts 同款形态）：spawn 引擎 CLI + NDJSON 帧路由。 */
class FakeHost {
  readonly proc: ReturnType<typeof spawn>;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, (f: Frame) => void>();
  readonly reverseFrames: Frame[] = [];
  private readonly reverseResolvers = new Map<string, ((f: Frame) => void)[]>();

  constructor(dataDir: string) {
    this.proc = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        XYZ_AGENT_DATA_DIR: dataDir,
        FAKE_PI_MODE: "chat",
        PATH: `${FIXTURE_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
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
    this.reverseFrames.push(frame);
    const waiters = this.reverseResolvers.get(String(frame.method));
    waiters?.shift()?.(frame);
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

  /** 等指定 method 的反向请求帧（先扫已到达的，再等未来帧；每帧只匹配一次）。 */
  waitForReverse(method: string, timeoutMs = 10_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for reverse ${method}`)), timeoutMs);
      const done = (f: Frame): void => {
        clearTimeout(timer);
        resolve(f);
      };
      const buffered = this.reverseFrames.find((f) => f.method === method && !consumed.has(f));
      if (buffered !== undefined) {
        consumed.add(buffered);
        done(buffered);
        return;
      }
      const list = this.reverseResolvers.get(method) ?? [];
      list.push((f) => {
        consumed.add(f);
        done(f);
      });
      this.reverseResolvers.set(method, list);
    });
  }

  replyReverse(id: string, result: unknown): void {
    this.send({ id, result });
  }

  kill(): void {
    this.proc.kill("SIGKILL");
  }
}

/** waitForReverse 的已消费帧去重面。 */
const consumed = new WeakSet<Frame>();

async function initialize(host: FakeHost, dataDir: string): Promise<void> {
  const init = await host.request("initialize", {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    hostInfo: { name: "fake-host", version: "0.0.0", dataRoot: dataDir },
    engineConfig: {},
  });
  expect(init.error).toBeUndefined();
}

/** 收割链自动应答：等 childStateChanged exited（数据面）并回 ack，防引擎侧反向等待挂起。 */
async function awaitReaped(host: FakeHost, recordId: string): Promise<void> {
  const exited = await host.waitForReverse("host/childStateChanged");
  expect(exited.params).toMatchObject({ recordId, state: "exited" });
  host.replyReverse(String(exited.id), { ok: true });
}

describe("pi-subagent-cli chat 轮 run 派发形态 e2e（bin 真机 NDJSON 往返）", () => {
  let dataDir: string | undefined;
  let host: FakeHost | undefined;

  afterEach(() => {
    host?.kill();
    host = undefined;
    if (dataDir !== undefined) {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      dataDir = undefined;
    }
  });

  it("首轮 → resume 续聊（同文件续写 + 历史召回）→ 收割 + 反向帧面收缩", async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-chat-"));
    host = new FakeHost(dataDir);
    await initialize(host, dataDir);

    // ① 首轮 run chat（无 resume）：反向帧链（recordId 锚定）→ run 应答
    const runP = host.request("run", {
      runId: "run-chat-1",
      task: { prompt: "hello", conversation: true, description: "chat-e2e" },
      ctx: { poolKey: "shared", cwd: dataDir, model: "fake-provider/fake-model", streamMode: "stream" },
      resume: { recordId: "rec-chat-1" },
    });
    const poolResolved = await host.waitForReverse("host/poolResolved");
    expect((poolResolved.params as { poolKey: string }).poolKey).toBe("shared");
    host.replyReverse(String(poolResolved.id), { ok: true });

    const childSpawned = await host.waitForReverse("host/childSpawned");
    expect((childSpawned.params as { recordId: string }).recordId).toBe("rec-chat-1");
    host.replyReverse(String(childSpawned.id), { ok: true });

    const handleReady = await host.waitForReverse("host/handleReady");
    const sessionFile = (handleReady.params as { sessionRef: Record<string, string> }).sessionRef.sessionFile;
    expect(typeof sessionFile).toBe("string");
    host.replyReverse(String(handleReady.id), { ok: true });

    const firstDelta = await host.waitForReverse("host/streamDelta");
    expect(firstDelta.params).toEqual({ runId: "run-chat-1", delta: "chat-first-answer" });
    host.replyReverse(String(firstDelta.id), { ok: true });

    const runFrame = await runP;
    expect(runFrame.error).toBeUndefined();
    const runResult = runFrame.result as { handle: { sessionRef: Record<string, string> }; outcome: { content: string } };
    expect(runResult.handle.sessionRef.recordId).toBe("rec-chat-1");
    expect(runResult.handle.sessionRef.sessionFile).toBe(sessionFile);
    expect(runResult.outcome.content).toBe("chat-first-answer");

    // agent_settled 后杀链收割（每轮一进程）：exited 镜像上报（killed）
    await awaitReaped(host, "rec-chat-1");

    // [H1 U5] 反向帧面收缩（收割后 = 首轮全程帧齐备）：全部反向帧 ∈ run 域 8 通道
    // 白名单（轮次相位通道已随协议退役——轮终 = agent_settled 的 run 应答本身，
    // 无相位帧）
    expect([...new Set(host.reverseFrames.filter((f) => f.method !== "event").map((f) => f.method))].sort()).toEqual([
      "host/childSpawned",
      "host/childStateChanged",
      "host/handleReady",
      "host/poolResolved",
      "host/streamDelta",
    ]);

    // ② 续聊 = 新 run chat + resume（首轮 sessionFile，--session 续写同文件）：
    //    fake 从同文件读到首轮写入的 1 行历史 → 回复 resumed-history:1（构造性召回
    //    断言——历史可见当且仅当 resume 锚点穿透到 spawn 参数）
    const resumeP = host.request("run", {
      runId: "run-resume-1",
      task: { prompt: "continue", conversation: true },
      ctx: { poolKey: "shared", cwd: dataDir, model: "fake-provider/fake-model" },
      resume: {
        recordId: "rec-chat-1",
        resume: { sessionRef: { recordId: "rec-chat-1", sessionFile }, poolKey: "shared" },
      },
    });
    const resumeSpawned = await host.waitForReverse("host/childSpawned");
    expect((resumeSpawned.params as { recordId: string }).recordId).toBe("rec-chat-1");
    host.replyReverse(String(resumeSpawned.id), { ok: true });

    const resumeReady = await host.waitForReverse("host/handleReady");
    // 同文件续写：resume 轮的 session 身份 = 首轮文件（--session 定位不变）
    expect((resumeReady.params as { sessionRef: Record<string, string> }).sessionRef.sessionFile).toBe(sessionFile);
    host.replyReverse(String(resumeReady.id), { ok: true });

    const resumeFrame = await resumeP;
    expect(resumeFrame.error).toBeUndefined();
    const resumeResult = resumeFrame.result as { handle: { sessionRef: Record<string, string> }; outcome: { content: string } };
    expect(resumeResult.handle.sessionRef.sessionFile).toBe(sessionFile);
    // 历史召回：第二轮进程读到首轮进程写入的内容（1 行）
    expect(resumeResult.outcome.content).toBe("resumed-history:1");

    await awaitReaped(host, "rec-chat-1");

    // ③ [H1 U5] 收割后进程无保活——续聊只能经 ② 的 resume run 形态（interact 面
    // 已随协议退役，此处不再有冷拒绝断言载体）。
  }, 60_000);
});
