// EngineClient 集成测试（W2）：fake 引擎 CLI 子进程（__fixtures__/fake-engine.mjs）。
//
// 覆盖（impl-plan §2.2 / 验收 A6①⑦ / A8①④ / §7.2 R9-2/R9-2b/R9-3）：
//   帧往返 / initialize 握手与 pidfile 写入 / 反向通知路由（含镜像落项）/
//   host/askUser ack 两阶段 / 超时域二分（数据面 10s 判死 vs 交互面不计时，fake timers）/
//   崩溃重建 3 次退避 + 不可用 / 版本协商 mismatch / killAll 组杀（POSIX 真进程）/ dispose。
// stdin fd 不外泄（R9-4②）由 SDK spawn 单测兜底，core 侧不重测。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineClient, type RunRoute } from "../engine-client.ts";
import { isProcessAlive, pidfilePath, readPidfile, writePidfileAtomic } from "../pid-file.ts";

const FAKE_ENGINE = fileURLToPath(new URL("./__fixtures__/fake-engine.mjs", import.meta.url));

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w2-engine-client-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.useRealTimers();
});

interface ClientHandle {
  client: EngineClient;
  cleanup: () => Promise<void>;
}

function makeClient(
  overrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {},
): ClientHandle {
  const client = new EngineClient({
    engineId: "fake",
    command: process.execPath,
    args: [FAKE_ENGINE],
    hostKind: "test",
    hostVersion: "test-host-1.0",
    dataDir,
    envPrefixes: [],
    ...overrides,
  });
  return {
    client,
    cleanup: () => client.dispose(),
  };
}

/** 轮询等待谓词成立（真实子进程信号传播有毫秒级延迟）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

/** spawn 一个立刻退出的进程，取其 pid（已死宿主构造）。 */
function spawnDeadHost(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    child.once("exit", () => resolve(child.pid!));
  });
}

describe("EngineClient 帧往返与握手", () => {
  it("ensureConnected：spawn + initialize 握手 → ready（进程即引擎 CLI，pid 独立）", async () => {
    const { client, cleanup } = makeClient();
    await client.ensureConnected();
    expect(client.currentState).toBe("ready");
    expect(client.enginePid).toBeDefined();
    expect(client.enginePid).not.toBe(process.pid);
    await cleanup();
  });

  it("spawn 成功后原子写实例维度 pidfile（engine.<hostKind>.<hostPid>.pid，含 enginePid/hostPid/engineStartTime）；dispose 清理", async () => {
    const { client, cleanup } = makeClient();
    await client.ensureConnected();
    const path = pidfilePath(dataDir, "fake", "test", process.pid);
    expect(existsSync(path)).toBe(true);
    const content = readPidfile(path);
    expect(content).toMatchObject({
      enginePid: client.enginePid,
      hostPid: process.pid,
      hostKind: "test",
      engineId: "fake",
    });
    expect(content?.engineStartTime).not.toBeNull(); // POSIX 真值（R9-3b）
    await cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it("ping 往返（请求-应答 id 关联；不设墙钟）", async () => {
    const { client, cleanup } = makeClient();
    await client.ping();
    expect(client.currentState).toBe("ready");
    await cleanup();
  });

  it("版本协商越界：engine_protocol_mismatch（含双方版本 + 升级指引）+ 该引擎标记不可用", async () => {
    const { client, cleanup } = makeClient({
      args: [FAKE_ENGINE, "--protocol-version", "99"],
    });
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    expect(client.currentState).toBe("unavailable");
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    await expect(cleanup()).resolves.toBeUndefined(); // dispose 幂等不抛
  }, 20_000);

  it("initialize 应答与 manifest 诊断不一致 → warn 留痕（仅诊断，不阻断 ready）", async () => {
    const warnMessages: string[] = [];
    const { client, cleanup } = makeClient({
      manifestDiagnostics: {
        capabilities: {
          schemaEnforcement: "native",
          steer: "native",
          conversation: "native",
          personaInjection: "file",
          eventGranularity: "coarse",
          sandbox: "native",
          sessionRead: "partial",
          resume: "native",
          interrupt: "native",
          permissionMode: "native",
          maxTurns: true,
        },
      },
    });
    const original = console.warn;
    console.warn = (...parts: unknown[]) => {
      warnMessages.push(parts.join(" "));
    };
    try {
      await client.ensureConnected();
    } finally {
      console.warn = original;
    }
    expect(client.currentState).toBe("ready");
    expect(warnMessages.some((m) => m.includes("capabilities differ from manifest"))).toBe(true);
    await cleanup();
  });
});

describe("EngineClient 反向通知路由（run 作用域 + 镜像）", () => {
  it("event 通知 / streamDelta / handleReady 路由到 run 作用域回调；handleReady 回填 partial handle", async () => {
    const events: unknown[] = [];
    const deltas: string[] = [];
    const readyPartials: Array<{ sessionRef: Record<string, string> }> = [];
    const route: RunRoute = {
      onEvent: (e) => {
        events.push(e);
      },
      onStreamDelta: (d) => {
        deltas.push(d);
      },
      onHandleReady: (partial) => {
        readyPartials.push(partial);
      },
    };
    const { client, cleanup } = makeClient({
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([
          { op: "emit", seq: 1, event: { type: "text_delta", delta: "hello" } },
          { op: "streamDelta", delta: "stream-1" },
          { op: "handleReady", sessionRef: { sessionId: "s-1" } },
        ]),
      ],
    });
    const unregister = client.registerRunRoute("run-1", route);
    await client.ensureConnected();
    const result = (await client.request("run", {
      runId: "run-1",
      task: { prompt: "p" },
      ctx: { cwd: dataDir },
    })) as { handle: { sessionRef: Record<string, string> }; outcome: { content: string } };
    expect(result.outcome.content).toBe("fake-content-run-1");
    expect(events).toContainEqual({ type: "text_delta", delta: "hello" });
    expect(deltas).toEqual(["stream-1"]);
    expect(readyPartials).toEqual([{ sessionRef: { sessionId: "s-1" } }]);
    expect(client.getPartialHandle()).toEqual({ sessionRef: { sessionId: "s-1" } });
    unregister();
    await cleanup();
  });

  it("host/childSpawned + host/childStateChanged → 镜像落项/更新 + onMirrorChanged 广播", async () => {
    const mirrorEvents: string[] = [];
    const { client, cleanup } = makeClient({
      onMirrorChanged: (e) => mirrorEvents.push(e.reason),
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([
          { op: "childSpawned", pid: 4242, recordId: "rec-1" },
          { op: "childStateChanged", pid: 4242, recordId: "rec-1", state: "exited", killed: true, exitCode: 3 },
        ]),
      ],
    });
    await client.ensureConnected();
    await client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } });
    expect(mirrorEvents).toContain("childSpawned");
    expect(mirrorEvents).toContain("childStateChanged");
    expect(client.mirror.getEntry(4242)).toMatchObject({
      pid: 4242,
      state: "exited",
      killed: true,
      exitCode: 3,
    });
    await cleanup();
    // dispose → 整体置死 + 清空（失效语义 2+3）
    expect(client.mirror.size).toBe(0);
  });

  it("host/log 数据面 → 注入的 log 出口（缺省 logger facade 不抛）", async () => {
    const logs: Array<{ level: string; component: string; message: string }> = [];
    const { client, cleanup } = makeClient({
      log: (p) => logs.push({ level: p.level, component: p.component, message: p.message }),
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "log", level: "warn", component: "fake-comp", message: "log-line-1" }]),
      ],
    });
    await client.ensureConnected();
    await client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } });
    expect(logs).toContainEqual({ level: "warn", component: "fake-comp", message: "log-line-1" });
    await cleanup();
  });
});

describe("host/askUser ack 两阶段（R9-2）", () => {
  it("uiRequestHandler 注入：先回 {ack:true}，handler 结果异步补帧②（引擎 echo 结果 event）", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { client, cleanup } = makeClient({
      uiRequestHandler: async (req) => {
        expect(req.method).toBe("select");
        return { value: "answer-A" };
      },
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([
          { op: "emit", seq: 1, event: { type: "text_delta", delta: "before" } },
          { op: "askUser", request: { method: "select", id: "q1", title: "pick" } },
        ]),
      ],
    });
    const unregister = client.registerRunRoute("run-1", {
      onEvent: (e) => { events.push(e as { type: string; message?: string }); },
    });
    await client.ensureConnected();
    await client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } });
    unregister();
    const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
    expect(echo?.message).toContain('"value":"answer-A"');
    await cleanup();
  });

  it("handler 抛错 → 引擎收 {cancelled:true}（dialog-queue 应答链同款兜底）", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { client, cleanup } = makeClient({
      uiRequestHandler: async () => {
        throw new Error("handler exploded");
      },
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "askUser", request: { method: "confirm", id: "q2" } }]),
      ],
    });
    const unregister = client.registerRunRoute("run-1", {
      onEvent: (e) => { events.push(e as { type: string; message?: string }); },
    });
    await client.ensureConnected();
    await client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } });
    unregister();
    const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
    expect(echo?.message).toContain('"cancelled":true');
    await cleanup();
  });

  it("无 uiRequestHandler → {unsupported:true}（未实现的交互能力，引擎自行降级）", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const { client, cleanup } = makeClient({
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "askUser", request: { method: "input", id: "q3" } }]),
      ],
    });
    const unregister = client.registerRunRoute("run-1", {
      onEvent: (e) => { events.push(e as { type: string; message?: string }); },
    });
    await client.ensureConnected();
    await client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } });
    unregister();
    const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
    expect(echo?.message).toContain('"unsupported":true');
    await cleanup();
  });
});

describe("超时域二分（fake timers，R9-2 / R9-2b）", () => {
  it("快答数据面挂起 10s → 引擎故障：杀进程 + 在途 run 失败（engine_crashed）", async () => {
    vi.useFakeTimers();
    const { client, cleanup } = makeClient({
      args: [
        FAKE_ENGINE,
        "--run-actions",
        // streamDelta 挂起宿主消费方 + 引擎长 delay 保持 run 在途（引擎内部 timer
        // 是独立进程的真实时钟，不受宿主 fake timers 影响）
        JSON.stringify([
          { op: "streamDelta", delta: "hang" },
          { op: "delay", ms: 60_000 },
        ]),
      ],
    });
    const unregister = client.registerRunRoute("run-1", {
      onStreamDelta: () => new Promise<void>(() => {}), // 宿主消费方死锁
    });
    await client.ensureConnected();
    const runFailed = expect(
      client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } }),
    ).rejects.toMatchObject({ code: "engine_crashed" });
    // 分步推进：streamDelta 反向请求是真实 IO（引擎收到 run → 回帧），guardTimer
    // 注册于帧到达之后——一次性 advance(10s) 会与该 IO 竞态（推进时守卫尚未注册）。
    // 循环小步推进直到杀链生效（teardown → state 离开 ready）。
    for (let i = 0; i < 200 && client.currentState === "ready"; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await runFailed;
    expect(client.currentState).not.toBe("ready"); // 杀链已执行
    unregister();
    await cleanup();
  }, 20_000);

  it("人机交互面 ack 后永不计时：handler 挂 60s 不判引擎故障（R9-2 负向 + ADR-0047）", async () => {
    vi.useFakeTimers();
    const { client, cleanup } = makeClient({
      uiRequestHandler: () => new Promise(() => {}), // 用户永不回答
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "askUser", request: { method: "select", id: "q-hang" } }]),
      ],
    });
    await client.ensureConnected();
    const enginePid = client.enginePid!;
    void client
      .request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } })
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    // ack 已回（引擎继续跑），handler 挂起不触发任何杀链
    expect(client.currentState).toBe("ready");
    expect(client.enginePid).toBe(enginePid);
    expect(isProcessAlive(enginePid)).toBe(true);
    // 负向断言完成后必须走杀链收尾：不 dispose = 引擎进程泄漏为常驻孤儿
    // （fake 引擎 stdin EOF 后保活不自灭），且带 exit 监听的 client 跨文件存活。
    vi.useRealTimers(); // 杀链（dispose 帧 3s 上界 / SIGKILL 收尸）走真实时钟
    await cleanup();
  }, 20_000);
});

describe("引擎崩溃与重建（A8①③）", () => {
  it("run 中引擎进程死亡：在途 run 失败（engine_crashed + stderr 尾）+ 镜像清空 + pidfile 清理", async () => {
    const { client, cleanup } = makeClient({
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([
          { op: "childSpawned", pid: 5151, recordId: "rec-crash" },
          { op: "exit", code: 137, stderr: "mid-run crash sample\n" },
        ]),
      ],
    });
    await client.ensureConnected();
    expect(client.enginePid).toBeDefined();
    const path = pidfilePath(dataDir, "fake", "test", process.pid);
    await expect(
      client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } }),
    ).rejects.toSatisfy((err: Error & { code?: string }) => {
      expect(err.code).toBe("engine_crashed");
      expect(err.message).toContain("stderr tail");
      expect(err.message).toContain("mid-run crash sample");
      return true;
    });
    expect(client.currentState).toBe("exited");
    expect(client.mirror.size).toBe(0); // 崩溃后镜像清空（isResumable 回落「无句柄」）
    await waitFor(() => !existsSync(path)); // pidfile 随引擎死亡清理
    await cleanup();
  });

  it("stderr 常驻排空：环形缓冲只留尾 400 字符（宿主侧不落盘）", async () => {
    const { client, cleanup } = makeClient({ args: [FAKE_ENGINE, "--mode", "crash"] });
    // crash 模式：spawn 即死（stderr 写 600+ 字符样本）→ initialize 无应答 →
    // 重建循环走完（真实退避 1+2+4=7s）→ 标记不可用 reject engine_crashed。
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_crashed" });
    expect(client.stderrTailText.length).toBeLessThanOrEqual(401);
    expect(client.stderrTailText).toContain("x"); // 尾部内容保留（头部被截）
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
    await cleanup();
  }, 30_000);

  it("崩溃重建：初建失败 + 3 次重建退避 1s/2s/4s 全败 → 标记不可用（恒 throw，含恢复指引）", async () => {
    const { client, cleanup } = makeClient({ args: [FAKE_ENGINE, "--mode", "crash"] });
    // 真实退避序列：初建(即时崩) → 1s → 重建1(崩) → 2s → 重建2(崩) → 4s →
    // 重建3(崩) → 不可用。每次 spawn→崩溃是真实子进程 IO，无法用 fake timers
    // 推进（advance 不等 IO），故整段走真实时钟（约 7s + 启动开销）。
    await expect(client.ensureConnected()).rejects.toSatisfy(
      (err: Error & { code?: string; recovery?: string }) => {
        expect(err.code).toBe("engine_crashed");
        expect(err.message).toContain("failed to start after 4 attempts");
        expect(err.recovery).toContain("unavailable until the next host start");
        return true;
      },
    );
    expect(client.currentState).toBe("unavailable");
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_crashed" });
    await cleanup();
  }, 30_000);

  it("重建恢复：进程意外死亡后下次 ensureConnected 重建成功（新 pid）；连接复用不重建", async () => {
    const { client, cleanup } = makeClient();
    await client.ensureConnected();
    const firstPid = client.enginePid!;
    process.kill(firstPid, "SIGKILL"); // 模拟崩溃（单杀制造 exit 事件）
    await waitFor(() => client.currentState === "exited");
    await client.ensureConnected();
    expect(client.currentState).toBe("ready");
    expect(client.enginePid).not.toBe(firstPid);
    const pidAfterRebuild = client.enginePid;
    await client.ensureConnected(); // 连接复用：不重建
    expect(client.enginePid).toBe(pidAfterRebuild);
    await cleanup();
  });
});

describe("收割（POSIX 进程组；范围 = 一代子进程 + 组内后代，R9-1）", () => {
  it("killAll：负 pid 组杀连带组内后代（引擎 + grandchild 全灭）+ 镜像置死 + pidfile 清理", async () => {
    const { client } = makeClient({
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "spawnGrandchild", recordId: "rec-grand" }]),
      ],
    });
    const unregister = client.registerRunRoute("run-1", {});
    void client
      .ensureConnected()
      .then(() =>
        client.request("run", { runId: "run-1", task: { prompt: "p" }, ctx: { cwd: dataDir } }),
      )
      .catch(() => {});
    await waitFor(() => client.mirror.size > 0);
    const grandchildPid = client.mirror.snapshot()[0]!.pid;
    const enginePid = client.enginePid!;
    expect(isProcessAlive(grandchildPid)).toBe(true);

    await client.killAll("test harvest");
    // 组内双亡（detached 后代不覆盖——R9-1 已接受代价，不在断言范围）
    await waitFor(() => isProcessAlive(grandchildPid) === false);
    await waitFor(() => isProcessAlive(enginePid) === false);
    expect(client.mirror.size).toBe(0);
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
    unregister();
  }, 20_000);

  it("dispose 幂等且引擎自然退出；killAll 在进程已死时不抛", async () => {
    const { client, cleanup } = makeClient();
    await client.ensureConnected();
    const enginePid = client.enginePid!;
    await client.dispose();
    await waitFor(() => isProcessAlive(enginePid) === false);
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
    await expect(client.dispose()).resolves.toBeUndefined(); // 幂等
    await expect(client.killAll("again")).resolves.toBeUndefined();
    await cleanup();
  });
});

describe("pidfile 启动期清扫（EngineClient 接线，R9-3）", () => {
  it("首次 ensureConnected 前清扫同 id 陈旧 pidfile（宿主死残留被删；自己的文件照常写入）", async () => {
    const staleHostPid = await spawnDeadHost();
    const stalePath = pidfilePath(dataDir, "fake", "pi", staleHostPid);
    writePidfileAtomic(stalePath, {
      enginePid: 999999999,
      hostPid: staleHostPid,
      engineStartTime: null,
      engineId: "fake",
      hostKind: "pi",
      writtenAt: new Date().toISOString(),
    });
    expect(existsSync(stalePath)).toBe(true);

    const { client, cleanup } = makeClient();
    await client.ensureConnected(); // 启动清扫发生在这里
    expect(existsSync(stalePath)).toBe(false); // 陈旧文件被清（防 N 次崩溃重启堆积）
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(true);
    await cleanup();
  });
});
