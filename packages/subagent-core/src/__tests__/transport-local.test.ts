// [M3 u-m3-local] LocalEngineTransport 单测 + EngineClient transport 谓词/错误码白名单单测。
//
// 覆盖（impl-plan u-m3-local 验收①②③）：
//   ① local transport spawn/stdio/frame/onExit/close 收割（真实子进程，fake-engine fixture 复用）；
//   ② transport 错误码经 EngineClient.connectOnce preserve（engine_transport_* 原样上抛，
//      不包装成 engine_crashed failed-to-start；非白名单错误维持既有包装）；
//   ③ pidfile/reaper 仅 local 模式注册：local 模式写 pidfile + close 收割；control env
//      激活（runtime transport 未接线形态）→ engine_transport_unavailable 且零 spawn 零 pidfile。

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ENGINE_TRANSPORT_ERROR_RECOVERY,
  EngineSdkError,
} from "@zhushanwen/subagent-engine-sdk";

import { EngineClient } from "../execution/engine/client/engine-client.ts";
import { pidfilePath, probePidAliveness } from "../execution/engine/client/pid-file.ts";
import { LocalEngineTransport } from "../execution/engine/client/transport/local.ts";
import type {
  EngineLaunchSpec,
  EngineTransport,
  EngineTransportExitInfo,
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

/** 轮询等待谓词成立（真实子进程信号传播有毫秒级延迟）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

function makeTransport(overrides: Partial<ConstructorParameters<typeof LocalEngineTransport>[0]> = {}): LocalEngineTransport {
  return new LocalEngineTransport({
    engineId: "fake",
    dataDir,
    hostKind: "test",
    engineCmdlineMatcher: () => false,
    ...overrides,
  });
}

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

describe("LocalEngineTransport：spawn / stdio / 帧交换（验收①）", () => {
  it("open：spawn 引擎 CLI 进程（pid 独立）+ writeFrame→onFrame 帧往返（transport 只搬运不解析协议）", async () => {
    const transport = makeTransport();
    const frames = collectFrames(transport);
    const opened = await transport.open(makeSpec());
    expect(opened.pid).toBeDefined();
    expect(opened.pid).not.toBe(process.pid);

    // initialize 请求帧往返：transport 补换行直写 stdin，stdout 行经 onFrame 回调
    expect(transport.writeFrame(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } }))).toBe(true);
    await waitFor(() => frames.parsed.some((f) => (f as { id?: number }).id === 1));
    const answered = frames.parsed.find((f) => (f as { id?: number }).id === 1) as {
      result?: { protocolVersion?: number };
    };
    expect(answered.result?.protocolVersion).toBe(1);
    await transport.close();
  });

  it("stdio 接线：多帧连续写 + 逐行投递（一行一调，不串行粘连）", async () => {
    const transport = makeTransport();
    const frames = collectFrames(transport);
    await transport.open(makeSpec());
    expect(transport.writeFrame(JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } }))).toBe(true);
    expect(transport.writeFrame(JSON.stringify({ id: 2, method: "ping", params: {} }))).toBe(true);
    await waitFor(() => frames.parsed.some((f) => (f as { id?: number }).id === 2));
    expect(frames.parsed.some((f) => (f as { id?: number }).id === 1)).toBe(true);
    // ping 应答为独立行（id 关联面不粘连）
    const pong = frames.parsed.find((f) => (f as { id?: number }).id === 2) as { result?: { pong?: boolean } };
    expect(pong.result?.pong).toBe(true);
    await transport.close();
  });

  it("writeFrame 返回回执：进程死亡后写帧 → false（宿主据以收口 in-flight）", async () => {
    const transport = makeTransport();
    const exits: EngineTransportExitInfo[] = [];
    transport.onExit((info) => exits.push(info));
    const opened = await transport.open(makeSpec());
    await waitFor(() => probePidAliveness(opened.pid!) === true);
    process.kill(opened.pid!, "SIGKILL");
    await waitFor(() => exits.length > 0);
    await waitFor(() => transport.writeFrame(JSON.stringify({ id: 9, method: "ping", params: {} })) === false);
    await transport.close(); // 已终局：幂等
  });
});

describe("LocalEngineTransport：onExit 终局投影（验收①）", () => {
  it("自然退出：code/signal 投影（reason 缺席 = local 无 engine_closed 事实源）+ 多订阅单次回调", async () => {
    const transport = makeTransport();
    const exits: EngineTransportExitInfo[] = [];
    transport.onExit((info) => exits.push(info));
    transport.onExit((info) => exits.push(info)); // 多订阅：各回调一次
    const opened = await transport.open(makeSpec());
    process.kill(opened.pid!, "SIGKILL");
    await waitFor(() => exits.length >= 2);
    // 每个订阅者各收到一次同一终局（两次订阅 = 两次回调，各一）
    expect(exits).toHaveLength(2);
    expect(exits[0]).toEqual(exits[1]);
    expect(exits[0]!.code).toBeNull();
    expect(exits[0]!.signal).toBe("SIGKILL");
    expect(exits[0]!.reason).toBeUndefined(); // reason 是 runtime engine_closed 值域
    await transport.close();
  });

  it("stderr 出口：引擎 stderr 经 onStderr 回调投递（宿主环形缓冲数据源）+ crash 终局投影 code", async () => {
    const stderrChunks: string[] = [];
    const transport = makeTransport({ onStderr: (chunk) => stderrChunks.push(chunk) });
    const exits: EngineTransportExitInfo[] = [];
    transport.onExit((info) => exits.push(info));
    await transport.open(makeSpec({ args: [FAKE_ENGINE, "--mode", "crash"] }));
    await waitFor(() => exits.length > 0);
    expect(stderrChunks.join("")).toContain("fatal: fake engine boot failure");
    expect(exits[0]!.code).toBe(1);
    expect(exits[0]!.signal).toBeNull();
    await transport.close(); // 已终局：幂等
  });
});

describe("LocalEngineTransport：close 收割（验收①）", () => {
  it("close：组杀引擎 + 组内后代连带（POSIX 进程组）+ pidfile 清理", async () => {
    const transport = makeTransport();
    const frames = collectFrames(transport);
    const opened = await transport.open(makeSpec({
      args: [FAKE_ENGINE, "--run-actions", JSON.stringify([{ op: "spawnGrandchild", recordId: "rec-grand" }])],
    }));
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

  it("pidfile 注册：open 写 engine.<hostKind>.<hostPid>.pid（local 模式专属，验收③正向面）", async () => {
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
});

// ── EngineClient：transport 选择谓词 + 错误码 preserve 白名单（验收②③）──────────

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

describe("EngineClient transport 谓词与错误码 preserve（验收②③）", () => {
  function makeClient(overrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {}): EngineClient {
    return new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      hostVersion: "test-host-1.0",
      dataDir,
      envPrefixes: [],
      ...overrides,
    });
  }

  it("control env 激活 → engine_transport_unavailable（runtime transport 未接线；不静默 local）+ 零 spawn 零 pidfile（验收③）", async () => {
    const client = makeClient({
      baseEnv: { TAIJI_SUBAGENT_CONTROL_SOCKET: "/tmp/does-not-exist.sock" },
    });
    await expect(client.ensureConnected()).rejects.toSatisfy(
      (err: Error & { code?: string; recovery?: string }) => {
        expect(err.code).toBe("engine_transport_unavailable");
        expect(err.recovery).toBe(ENGINE_TRANSPORT_ERROR_RECOVERY.engine_transport_unavailable);
        return true;
      },
    );
    // 标记不可用（不是 state 卡 connecting）+ 复现同码
    expect(client.currentState).toBe("unavailable");
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_transport_unavailable" });
    // 非本机路径绝对不 fallback：无引擎进程被 spawn，pidfile 未写（runtime 模式无 pidfile 面）
    expect(client.enginePid).toBeUndefined();
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
  });

  it("control env 空串 → local 分支（谓词只看非空；ready + pidfile 写入）", async () => {
    const client = makeClient({
      baseEnv: { TAIJI_SUBAGENT_CONTROL_SOCKET: "" },
    });
    await client.ensureConnected();
    expect(client.currentState).toBe("ready");
    expect(client.enginePid).toBeDefined();
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(true);
    await client.dispose();
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
