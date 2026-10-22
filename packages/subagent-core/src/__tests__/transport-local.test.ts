// [M3 u-m3-local] LocalEngineTransport 单测 + EngineClient transport 谓词/错误码白名单单测。
//
// [单测层极端测试整治] 本文件按层拆分：
//   ① 帧面逻辑（stdio 接线 / 行切分 / 半行残片上限 / writeFrame 回执 / onExit 终局
//      投影 / stderr 出口）——经 spawnChildProcess 注入点接进程端点桩（FakeChildProcess
//      + PassThrough 管道），确定性同步验证、零真进程；
//   ② EngineClient transport 选择谓词 + 错误码 preserve——谓词真实求值，local 分支
//      换握手桩（不 spawn）；错误码用例本就是 stub transport；
//   ③ 进程治理真链（真 spawn fake-engine / POSIX 进程组收割 / pidfile 注册与死后
//      清理）——进程事实属判据③，挂 TAIJI_TEST_INTEGRATION 门控（本地默认跳过、CI 真跑）。

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ENGINE_TRANSPORT_ERROR_RECOVERY,
  EngineSdkError,
} from "@zhushanwen/subagent-engine-sdk";

import {
  INTEGRATION_TESTS_ENABLED,
  INTEGRATION_TESTS_SKIP_REASON,
} from "../../../../test-guard/integration-gate.ts";
import { EngineClient, SUBAGENT_TRANSPORT_ENV } from "../execution/engine/client/engine-client.ts";
import { pidfilePath, probePidAliveness } from "../execution/engine/client/pid-file.ts";
import { LocalEngineTransport } from "../execution/engine/client/transport/local.ts";
import { RuntimeEngineTransport } from "../execution/engine/client/transport/runtime.ts";
import type {
  EngineLaunchSpec,
  EngineTransport,
  EngineTransportExitInfo,
  EngineTransportOpenResult,
} from "../execution/engine/client/transport/types.ts";

const FAKE_ENGINE = fileURLToPath(
  new URL("../execution/engine/client/__tests__/__fixtures__/fake-engine.mjs", import.meta.url),
);

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "u-m3-local-transport-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeSpec(overrides: Partial<EngineLaunchSpec> = {}): EngineLaunchSpec {
  return {
    engineId: "fake",
    entryPath: process.execPath,
    args: [FAKE_ENGINE],
    cwd: dataDir,
    envPrefixes: [],
    rootSessionId: "", // local 实现忽略（runtime 归属键）
    ...overrides,
  };
}

/** NDJSON 帧行收集器（onFrame 订阅 + 行 JSON 解析）。 */
function collectFrames(transport: EngineTransport): { raw: string[]; parsed: unknown[] } {
  const raw: string[] = [];
  const parsed: unknown[] = [];
  transport.onFrame((line) => {
    raw.push(line);
    try {
      parsed.push(JSON.parse(line) as unknown);
    } catch {
      // 非 NDJSON 行不进 parsed（协议契约外输出）
    }
  });
  return { raw, parsed };
}

// ── ① 帧面逻辑：进程端点桩（FakeChildProcess + 管道回声引擎）──────────────────

/**
 * 进程端点桩：EventEmitter + PassThrough 双工管道，pid 取不可达高位（killProcessTree
 * 对其 ESRCH no-op，不触碰真实进程表）。实现 wireChild / close / waitForChildExit
 * 消费的 ChildProcess 面（on / removeAllListeners / pid / exitCode / signalCode /
 * stdin / stdout / stderr 流）。
 */
class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  kill(): boolean {
    return true;
  }
  /** 模拟进程终局：置 exit/signal 事实后派发 exit 事件（真实 ChildProcess 同点序）。 */
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (signal !== null) {
      this.signalCode = signal;
      this.exitCode = null;
    } else {
      this.exitCode = code;
      this.signalCode = null;
    }
    this.emit("exit", code, signal);
  }
}

/** 管道回声引擎：stdin 行 → 最小协议应答（initialize/ping/run）→ stdout 行。 */
function attachEchoEngine(child: FakeChildProcess): void {
  let buffer = "";
  child.stdin.setEncoding("utf-8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.trim().length > 0) handleLine(line);
      idx = buffer.indexOf("\n");
    }
  });
  function send(frame: object): void {
    child.stdout.write(`${JSON.stringify(frame)}\n`);
  }
  function handleLine(line: string): void {
    let frame: { id?: number; method?: string };
    try {
      frame = JSON.parse(line) as { id?: number; method?: string };
    } catch {
      return;
    }
    switch (frame.method) {
      case "initialize":
        send({ id: frame.id, result: { protocolVersion: 1, engineId: "fake" } });
        break;
      case "ping":
        send({ id: frame.id, result: { pong: true } });
        break;
      case "run":
        send({
          id: frame.id,
          result: {
            handle: { v: 1, engineId: "fake", sessionRef: { sessionId: "fake-session-1" }, poolKey: "shared" },
            outcome: { content: "fake-content-run-1", engineId: "fake", exitCode: 0, durationMs: 1 },
          },
        });
        break;
      default:
        break;
    }
  }
}

/** PassThrough 管道传播是 nextTick 链——一个宏任务轮次内确定性到达。 */
async function flushPipes(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** 装配接 FakeChildProcess 的 transport（spawn 注入点；其余路径全真）。 */
function makeFakeChildTransport(
  overrides: Partial<ConstructorParameters<typeof LocalEngineTransport>[0]> = {},
): { transport: LocalEngineTransport; child: FakeChildProcess } {
  const child = new FakeChildProcess(999_999_999);
  const transport = new LocalEngineTransport({
    engineId: "fake",
    dataDir,
    hostKind: "test",
    engineCmdlineMatcher: () => false,
    // 进程端点桩注入（测试 seam，见 LocalEngineTransportOptions.spawnChildProcess 注释）
    spawnChildProcess: () => child as unknown as ChildProcess,
    ...overrides,
  });
  return { transport, child };
}

describe("LocalEngineTransport：帧面逻辑（进程端点桩，验收①）", () => {
  it("open：接线子进程端点（pid 回执独立）+ writeFrame→onFrame 帧往返 + 多帧连续写逐行投递（不粘连）", async () => {
    const { transport, child } = makeFakeChildTransport();
    attachEchoEngine(child);
    const frames = collectFrames(transport);
    const opened = await transport.open(makeSpec());
    expect(opened.pid).toBeDefined();
    expect(opened.pid).not.toBe(process.pid);

    expect(
      transport.writeFrame(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } })),
    ).toBe(true);
    expect(transport.writeFrame(JSON.stringify({ id: 2, method: "ping", params: {} }))).toBe(true);
    await flushPipes();
    // 逐行投递：两帧都到达且 id 关联面不粘连
    const answered = frames.parsed.find((f) => (f as { id?: number }).id === 1) as {
      result?: { protocolVersion?: number };
    };
    expect(answered.result?.protocolVersion).toBe(1);
    const pong = frames.parsed.find((f) => (f as { id?: number }).id === 2) as { result?: { pong?: boolean } };
    expect(pong.result?.pong).toBe(true);
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  it("writeFrame 返回回执：进程死亡后（exitCode 非空）写帧 → false（宿主据以收口 in-flight）", async () => {
    const { transport, child } = makeFakeChildTransport();
    await transport.open(makeSpec());
    expect(transport.writeFrame(JSON.stringify({ id: 9, method: "ping", params: {} }))).toBe(true);
    child.exitCode = 1;
    expect(transport.writeFrame(JSON.stringify({ id: 9, method: "ping", params: {} }))).toBe(false);
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  it("onExit 终局投影：signal 投影（reason 缺席 = local 无 engine_closed 事实源）+ 多订阅各一次 + 幂等单派发", async () => {
    const { transport, child } = makeFakeChildTransport();
    const exits: EngineTransportExitInfo[] = [];
    transport.onExit((info) => exits.push(info));
    transport.onExit((info) => exits.push(info)); // 多订阅：各回调一次
    await transport.open(makeSpec());
    child.emitExit(null, "SIGKILL");
    // 每个订阅者各收到一次同一终局（两次订阅 = 两次回调，各一）
    expect(exits).toHaveLength(2);
    expect(exits[0]).toEqual(exits[1]);
    expect(exits[0]!.code).toBeNull();
    expect(exits[0]!.signal).toBe("SIGKILL");
    expect(exits[0]!.reason).toBeUndefined(); // reason 是 runtime engine_closed 值域
    // 二次终局（迟到的重复 exit 事件）不重复派发
    child.emit("exit", null, "SIGKILL");
    expect(exits).toHaveLength(2);
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  it("stderr 出口：引擎 stderr 经 onStderr 回调投递（宿主环形缓冲数据源）+ 正常退出终局投影 code", async () => {
    const stderrChunks: string[] = [];
    const { transport, child } = makeFakeChildTransport({ onStderr: (chunk) => stderrChunks.push(chunk) });
    const exits: EngineTransportExitInfo[] = [];
    transport.onExit((info) => exits.push(info));
    await transport.open(makeSpec());
    child.stderr.write("fatal: fake engine boot failure\n");
    await flushPipes();
    expect(stderrChunks.join("")).toContain("fatal: fake engine boot failure");
    child.emitExit(1, null);
    expect(exits[0]!.code).toBe(1);
    expect(exits[0]!.signal).toBeNull();
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });

  it("stdout 半行上限：持续无换行输出 → 残片丢头留尾 + 首截断 warn 一次；换行冲刷后垃圾行按行投递，后续合法帧照常", async () => {
    const warnMessages: string[] = [];
    const { transport, child } = makeFakeChildTransport();
    const frames = collectFrames(transport);
    await transport.open(makeSpec());
    const original = console.warn;
    console.warn = (...parts: unknown[]) => {
      warnMessages.push(parts.join(" "));
    };
    try {
      // 1.5 MiB 无换行垃圾（> 1 MiB 上限）分片写（残片经多次 data 事件反复超限）
      const total = 1_572_864;
      const chunkSize = 64 * 1024;
      for (let written = 0; written < total; written += chunkSize) {
        child.stdout.write("x".repeat(Math.min(chunkSize, total - written)));
      }
      await flushPipes();
      // 截断告警只发首截断一次
      expect(warnMessages.filter((m) => m.includes("stdout partial line exceeded"))).toHaveLength(1);
      // 换行冲刷：残片（截尾后的 1 MiB）成为一行投递给订阅方
      child.stdout.write("\n");
      await flushPipes();
      expect(frames.raw).toHaveLength(1);
      expect(frames.raw[0]).toBe("x".repeat(1_048_576));
      // 后续合法 NDJSON 帧照常逐行投递（截断不得破坏后续帧边界）
      child.stdout.write('{"id":9,"result":{"ok":true}}\n');
      await flushPipes();
      const ok = frames.parsed.find((f) => (f as { id?: number }).id === 9) as { result?: { ok?: boolean } };
      expect(ok.result?.ok).toBe(true);
    } finally {
      console.warn = original;
    }
    child.stdout.end();
    child.stderr.end();
    child.stdin.end();
  });
});

// ── ② EngineClient：transport 选择谓词 + 错误码 preserve 白名单（验收②③）────────

/** 假 transport（open 行为可编程；不经 LocalEngineTransport——谓词/白名单面单测用）。 */
function makeStubTransport(openImpl: () => Promise<{ pid?: number }>): EngineTransport {
  return {
    open: openImpl,
    writeFrame: () => false,
    onFrame: () => {},
    onExit: () => {},
    close: async () => {},
  };
}

class StubTransportClient extends EngineClient {
  private readonly stub: EngineTransport;
  constructor(stub: EngineTransport, opts: ConstructorParameters<typeof EngineClient>[0]) {
    super(opts);
    this.stub = stub;
  }
  protected override resolveTransport(): EngineTransport {
    return this.stub;
  }
}

/** 握手桩 transport：initialize/ping/run 帧照 fake-engine 语义回最小应答（谓词面单测——不 spawn）。 */
class HandshakeStubTransport implements EngineTransport {
  private readonly frameHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(info: EngineTransportExitInfo) => void> = [];
  private alive = true;

  async open(): Promise<EngineTransportOpenResult> {
    return { pid: 4242 };
  }

  writeFrame(line: string): boolean {
    if (!this.alive) return false;
    let frame: { id?: number; method?: string };
    try {
      frame = JSON.parse(line) as { id?: number; method?: string };
    } catch {
      return true;
    }
    if (frame.method === undefined) return true; // 反向请求应答帧
    switch (frame.method) {
      case "initialize":
        this.emit({ id: frame.id, result: { protocolVersion: 1, engineId: "fake" } });
        break;
      case "ping":
        this.emit({ id: frame.id, result: { pong: true } });
        break;
      case "run":
        this.emit({
          id: frame.id,
          result: {
            handle: { v: 1, engineId: "fake", sessionRef: { sessionId: "fake-session-1" }, poolKey: "shared" },
            outcome: { content: "fake-content-run-1", engineId: "fake", exitCode: 0, durationMs: 1 },
          },
        });
        break;
      case "dispose":
        this.emit({ id: frame.id, result: { ok: true } });
        this.alive = false;
        for (const handler of this.exitHandlers) handler({ code: 0, signal: null });
        break;
      default:
        break;
    }
    return true;
  }

  onFrame(handler: (line: string) => void): void {
    this.frameHandlers.push(handler);
  }

  onExit(handler: (info: EngineTransportExitInfo) => void): void {
    this.exitHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.alive = false;
  }

  private emit(frame: object): void {
    const line = JSON.stringify(frame);
    for (const handler of this.frameHandlers) handler(line);
  }
}

/**
 * 谓词探针 client：resolveTransport 经 super 真实求值（谓词逻辑 = 被测面），记录选中
 * 分支；local 分支换握手桩（避免真 spawn），runtime 分支返回真实 transport（其连接
 * 失败面本身是被测行为，连接到不存在的 socket 路径 = 确定性立即失败，无真子进程）。
 */
class PredicateProbeClient extends EngineClient {
  private readonly stub: HandshakeStubTransport;
  selected: "local" | "runtime" | undefined;
  constructor(stub: HandshakeStubTransport, opts: ConstructorParameters<typeof EngineClient>[0]) {
    super(opts);
    this.stub = stub;
  }
  protected override resolveTransport(): EngineTransport {
    const real = super.resolveTransport();
    const isRuntime = real instanceof RuntimeEngineTransport;
    this.selected = isRuntime ? "runtime" : "local";
    return isRuntime ? real : this.stub;
  }
}

describe("EngineClient transport 谓词与错误码 preserve（验收②③）", () => {
  function baseClientOpts(
    overrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {},
  ): ConstructorParameters<typeof EngineClient>[0] {
    return {
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      hostVersion: "test-host-1.0",
      dataDir,
      envPrefixes: [],
      ...overrides,
    };
  }

  it("control env 激活 → engine_transport_unavailable（runtime transport 真实 connect 失败面；不静默 local）+ 零 spawn 零 pidfile（验收③）", async () => {
    const client = new PredicateProbeClient(
      new HandshakeStubTransport(),
      baseClientOpts({
        baseEnv: { TAIJI_SUBAGENT_CONTROL_SOCKET: join(tmpdir(), `u-m3-rt-missing-${process.pid}.sock`) },
      }),
    );
    await expect(client.ensureConnected()).rejects.toSatisfy(
      (err: Error & { code?: string; recovery?: string }) => {
        expect(err.code).toBe("engine_transport_unavailable");
        expect(err.recovery).toBe(ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_unavailable);
        return true;
      },
    );
    expect(client.selected).toBe("runtime");
    // 标记不可用（不是 state 卡 connecting）+ 复现同码
    expect(client.currentState).toBe("unavailable");
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_transport_unavailable" });
    // 非本机路径绝对不 fallback：无引擎进程被 spawn，pidfile 未写（runtime 模式无 pidfile 面）
    expect(client.enginePid).toBeUndefined();
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
  });

  it("control env 空串 → local 分支（谓词只看非空；ready）", async () => {
    const client = new PredicateProbeClient(
      new HandshakeStubTransport(),
      baseClientOpts({ baseEnv: { TAIJI_SUBAGENT_CONTROL_SOCKET: "" } }),
    );
    await client.ensureConnected();
    expect(client.selected).toBe("local");
    expect(client.currentState).toBe("ready");
    await client.dispose();
  });

  it("[D9] TAIJI_SUBAGENT_TRANSPORT=local 优先于 control env 激活判定（强制 local；ready）", async () => {
    const client = new PredicateProbeClient(
      new HandshakeStubTransport(),
      baseClientOpts({
        baseEnv: {
          // control env 本应选中 runtime（socket 路径甚至不存在）——逃生舱必须抢先。
          TAIJI_SUBAGENT_CONTROL_SOCKET: join(tmpdir(), `u-m3-rt-missing-${process.pid}.sock`),
          [SUBAGENT_TRANSPORT_ENV]: "local",
        },
      }),
    );
    await client.ensureConnected();
    expect(client.selected).toBe("local");
    expect(client.currentState).toBe("ready");
    await client.dispose();
  });

  it("[D9] 非 local 值不改变既有谓词（control env 仍选 runtime → 显式不可用）", async () => {
    const client = new PredicateProbeClient(
      new HandshakeStubTransport(),
      baseClientOpts({
        baseEnv: {
          TAIJI_SUBAGENT_CONTROL_SOCKET: join(tmpdir(), `u-m3-rt-missing-${process.pid}.sock`),
          [SUBAGENT_TRANSPORT_ENV]: "runtime",
        },
      }),
    );
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_transport_unavailable" });
    expect(client.selected).toBe("runtime");
    expect(client.currentState).toBe("unavailable");
  });

  it("transport 错误码经 connectOnce preserve：open 拒 engine_transport_lost → 原样上抛（不包装 failed-to-start）+ 标记不可用", async () => {
    const stub = makeStubTransport(() =>
      Promise.reject(
        new EngineSdkError(
          "engine_transport_lost",
          "control connection lost during engine_open",
          ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_lost,
        ),
      ),
    );
    const client = new StubTransportClient(stub, {
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    await expect(client.ensureConnected()).rejects.toSatisfy(
      (err: Error & { code?: string; recovery?: string; message?: string }) => {
        expect(err.code).toBe("engine_transport_lost");
        expect(err.recovery).toBe(ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_lost);
        expect(err.message).not.toContain("failed to start"); // 不包装成 engine_crashed
        return true;
      },
    );
    expect(client.currentState).toBe("unavailable");
  });

  it("非白名单错误维持既有 engine_crashed 包装（failed to start 文案）", async () => {
    const stub = makeStubTransport(() => Promise.reject(new Error("boom during open")));
    const client = new StubTransportClient(stub, {
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    await expect(client.ensureConnected()).rejects.toSatisfy(
      (err: Error & { code?: string; message?: string }) => {
        expect(err.code).toBe("engine_crashed");
        expect(err.message).toContain("failed to start: boom during open");
        return true;
      },
    );
    expect(client.currentState).toBe("unavailable");
  });

  it("engine_protocol_mismatch preserve（白名单既有成员，回归护栏）", async () => {
    const stub = makeStubTransport(() =>
      Promise.reject(new EngineSdkError("engine_protocol_mismatch", "engine speaks v99", "upgrade the engine package")),
    );
    const client = new StubTransportClient(stub, {
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    expect(client.currentState).toBe("unavailable");
  });
});

// ── ③ 进程治理真链（真 spawn fake-engine；进程事实 = 判据③，挂集成门控）──────────

describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
  `LocalEngineTransport：真进程治理链（验收①③）${INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""}`,
  () => {
    /** 轮询等待谓词成立（真实子进程信号传播有毫秒级延迟——本组为集成门控真跑形态）。 */
    async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 25): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
      }
      throw new Error("waitFor: condition not met within timeout");
    }

    function makeTransport(
      overrides: Partial<ConstructorParameters<typeof LocalEngineTransport>[0]> = {},
    ): LocalEngineTransport {
      return new LocalEngineTransport({
        engineId: "fake",
        dataDir,
        hostKind: "test",
        engineCmdlineMatcher: () => false,
        ...overrides,
      });
    }

    it("open 真进程：spawn 引擎 CLI（pid 独立）+ initialize 帧往返 + 多帧连续写逐行投递", async () => {
      const transport = makeTransport();
      const frames = collectFrames(transport);
      const opened = await transport.open(makeSpec());
      expect(opened.pid).toBeDefined();
      expect(opened.pid).not.toBe(process.pid);

      expect(
        transport.writeFrame(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } })),
      ).toBe(true);
      expect(transport.writeFrame(JSON.stringify({ id: 2, method: "ping", params: {} }))).toBe(true);
      await waitFor(() => frames.parsed.some((f) => (f as { id?: number }).id === 2));
      const answered = frames.parsed.find((f) => (f as { id?: number }).id === 1) as {
        result?: { protocolVersion?: number };
      };
      expect(answered.result?.protocolVersion).toBe(1);
      const pong = frames.parsed.find((f) => (f as { id?: number }).id === 2) as { result?: { pong?: boolean } };
      expect(pong.result?.pong).toBe(true);
      await transport.close();
    });

    it("close：组杀引擎 + 组内后代连带（POSIX 进程组）+ pidfile 清理", async () => {
      const transport = makeTransport();
      const frames = collectFrames(transport);
      const opened = await transport.open(
        makeSpec({
          args: [FAKE_ENGINE, "--run-actions", JSON.stringify([{ op: "spawnGrandchild", recordId: "rec-grand" }])],
        }),
      );
      const enginePid = opened.pid!;
      // 驱动协议：initialize → run（spawnGrandchild 动作经反向通道上报孙进程 pid）
      transport.writeFrame(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
      transport.writeFrame(JSON.stringify({ id: 2, method: "run", params: { runId: "run-1", task: { prompt: "p" } } }));
      await waitFor(() =>
        frames.parsed.some((f) => (f as { method?: string }).method === "host/childSpawned"),
      );
      const grandchildPid = (
        frames.parsed.find((f) => (f as { method?: string }).method === "host/childSpawned") as {
          params?: { pid?: number };
        }
      )?.params?.pid;
      expect(grandchildPid).toBeDefined();
      expect(probePidAliveness(grandchildPid!)).toBe(true);

      await transport.close("u-m3-local harvest test");
      // 组内双亡（detached 后代不覆盖——既有已接受代价）
      await waitFor(() => probePidAliveness(grandchildPid!) === false);
      await waitFor(() => probePidAliveness(enginePid) === false);
      // pidfile 随 close 链清理（exit 投影段）
      expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
    });

    it("pidfile 注册：open 写 engine.<hostKind>.<hostPid>.pid（local 模式专属，验收③正向面）；引擎死后 exit 投影清理", async () => {
      const transport = makeTransport();
      const path = pidfilePath(dataDir, "fake", "test", process.pid);
      expect(existsSync(path)).toBe(false);
      const opened = await transport.open(makeSpec());
      expect(existsSync(path)).toBe(true);
      // 引擎死后 exit 投影清理
      process.kill(opened.pid!, "SIGTERM");
      await waitFor(() => !existsSync(path));
      await transport.close();
    });
  },
);
