// [M3 u-m3-rt-transport] RuntimeControlClient / RuntimeEngineTransport 单测 +
// EngineClient transport 谓词接线（假 control server = 同包自建 unix socket，帧按
// SDK control-protocol 词表；不依赖 runtime 包、不起真实 runtime/GUI）。
//
// 覆盖（impl-plan u-m3-rt-transport 验收①②③④）：
//   ① open→writeFrame→onFrame 全链（假 server）；hello/engine_open id 关联（乱序应答）；
//      engine_closed → onExit（含 stderrTail/reason）；engine_close 幂等；
//   ② 错误码面：engine_open_timeout / engine_frame_too_large /
//      engine_backpressure_overflow / engine_transport_lost / engine_transport_unavailable
//      （+ hello_reject version → engine_protocol_mismatch）；
//   ③ 连接死亡 → 在册通道 engine_transport_lost fan-out + 在途 open 全拒（不重试）；
//   ④ 谓词：control env 激活 → runtime transport 被选中（ready 经 control 通道、
//      零 spawn 零 pidfile）；空串/缺失 → local（既有 transport-local.test.ts 覆盖）。
//   ⑤ [ADR-0122] 握手期失败（protocol mismatch）→ teardown 清理链迟到的 engine_closed
//      不复活 unavailable（下一次 ensureConnected 仍抛原错误、不重新 engine_open）。

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EngineSdkError,
  SUBAGENT_CONTROL_FRAME_KINDS,
  SUBAGENT_CONTROL_PROTOCOL_VERSION,
} from "@zhushanwen/subagent-engine-sdk";

import { EngineClient } from "../execution/engine/client/engine-client.ts";
import { pidfilePath } from "../execution/engine/client/pid-file.ts";
import { RuntimeControlClient } from "../execution/engine/client/transport/control-client.ts";
import type {
  ControlChannelHandlers,
} from "../execution/engine/client/transport/control-shared.ts";
import { mapControlError } from "../execution/engine/client/transport/control-shared.ts";
import {
  RuntimeEngineTransport,
  type RuntimeEngineTransportOptions,
} from "../execution/engine/client/transport/runtime.ts";
import type {
  EngineLaunchSpec,
  EngineTransportExitInfo,
} from "../execution/engine/client/transport/types.ts";

const K = SUBAGENT_CONTROL_FRAME_KINDS;

/** 轮询等待谓词成立（真实 socket/子进程时序有毫秒级延迟）。 */
async function waitFor(predicate: () => boolean, what = "condition", timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor: ${what} not met within ${timeoutMs}ms`);
}

type FakeFrame = Record<string, unknown>;

/**
 * 假 control server（unix socket，单行 JSON；帧词表/版本 = SDK 单源）。
 * 缺省行为：hello → hello_ok；engine_open → engine_opened（channelId ch-N）；engine_close
 * → engine_closed（engine_exit）；engine_frame → onEngineFrame 钩子（协议应答）。
 */
class FakeControlServer {
  readonly frames: FakeFrame[] = [];
  /** engine_open 被连接级根绑定拒绝的记录（R2A-N1 回归面）。 */
  readonly openFailures: Array<{ code: unknown; launch: unknown }> = [];
  readonly dir: string;
  readonly socketPath: string;
  holdHello = false;
  holdOpen = false;
  rejectHelloVersion = false;
  autoCloseOnEngineClose = true;
  onEngineOpen: ((socket: net.Socket, frame: FakeFrame) => void) | undefined;
  onEngineFrame: ((socket: net.Socket, frame: FakeFrame) => void) | undefined;
  private readonly server: net.Server;
  private readonly conns = new Set<net.Socket>();
  private readonly buffers = new Map<net.Socket, string>();
  /** 连接级根绑定（模拟 runtime 的首 open 定根语义；无重置点）。 */
  private readonly connRoots = new Map<net.Socket, unknown>();
  private channelSeq = 0;

  private constructor(dir: string, socketPath: string) {
    this.dir = dir;
    this.socketPath = socketPath;
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  static async start(): Promise<FakeControlServer> {
    const dir = mkdtempSync(join(tmpdir(), "u-m3-rt-"));
    const self = new FakeControlServer(dir, join(dir, "c.sock"));
    await new Promise<void>((resolve, reject) => {
      self.server.once("error", reject);
      self.server.listen(self.socketPath, () => {
        self.server.removeListener("error", reject);
        resolve();
      });
    });
    return self;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** 当前活连接的绑定根（R2A-N1：一条连接只应有一个根）。 */
  get activeConnectionRoots(): unknown[] {
    return [...this.connRoots.values()];
  }

  sendControl(socket: net.Socket, frame: FakeFrame): void {
    try {
      socket.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // 对端已死：测试断言侧自行超时
    }
  }

  sendToAll(frame: FakeFrame): void {
    for (const socket of this.conns) this.sendControl(socket, frame);
  }

  /**
   * 逐段写原始字节到活连接（跨 chunk UTF-8 边界测试）：段间留 gap，保证客户端侧
   * 按两次 data 事件收到（段内可落在多字节字符中间）。
   */
  async sendRawChunks(chunks: Buffer[], gapMs = 30): Promise<void> {
    for (const socket of this.conns) {
      for (const chunk of chunks) {
        await new Promise<void>((resolve) => socket.write(chunk, () => resolve()));
        if (gapMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, gapMs));
      }
    }
  }

  sendEngineFrame(channelId: string, line: string): void {
    this.sendToAll({ v: SUBAGENT_CONTROL_PROTOCOL_VERSION, kind: K.engineFrame, channelId, line });
  }

  sendEngineClosed(channelId: string, info: Partial<{ code: number | null; signal: string | null; reason: string; stderrTail: string }> = {}): void {
    this.sendToAll({
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: K.engineClosed,
      channelId,
      code: info.code === undefined ? 0 : info.code,
      signal: info.signal === undefined ? null : info.signal,
      reason: info.reason ?? "engine_exit",
      ...(info.stderrTail !== undefined ? { stderrTail: info.stderrTail } : {}),
    });
  }

  sendError(channelId: string | undefined, code: string, message = code): void {
    this.sendToAll({
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: K.error,
      ...(channelId !== undefined ? { channelId } : {}),
      code,
      message,
      recovery: "test recovery",
    });
  }

  pauseConnections(): void {
    for (const socket of this.conns) socket.pause();
  }

  resumeConnections(): void {
    for (const socket of this.conns) socket.resume();
  }

  destroyConnections(): void {
    for (const socket of [...this.conns]) socket.destroy();
  }

  async close(): Promise<void> {
    this.destroyConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }

  private handleConnection(socket: net.Socket): void {
    this.conns.add(socket);
    this.buffers.set(socket, "");
    socket.on("data", (chunk: Buffer) => this.handleData(socket, chunk));
    socket.on("error", () => {
      // 测试替身：对端 RST 等预期内
    });
    socket.on("close", () => {
      this.conns.delete(socket);
      this.buffers.delete(socket);
      this.connRoots.delete(socket);
    });
  }

  private handleData(socket: net.Socket, chunk: Buffer): void {
    let buffer = (this.buffers.get(socket) ?? "") + chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const frame = parsed as FakeFrame;
      this.frames.push(frame);
      this.handleFrame(socket, frame);
    }
    this.buffers.set(socket, buffer);
  }

  private handleFrame(socket: net.Socket, frame: FakeFrame): void {
    if (frame.kind === K.hello) {
      if (this.holdHello) return;
      if (this.rejectHelloVersion) {
        this.sendControl(socket, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: K.helloReject,
          id: frame.id,
          reason: "version",
          message: "protocol version mismatch",
          recovery: "upgrade",
          supported: [SUBAGENT_CONTROL_PROTOCOL_VERSION],
        });
        return;
      }
      this.sendControl(socket, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.helloOk,
        id: frame.id,
        runtimePid: process.pid,
        protocolVersion: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      });
      return;
    }
    if (frame.kind === K.engineOpen) {
      if (this.holdOpen) return;
      // 连接级根绑定（runtime control-server 同语义）：首个 open 定根，之后不同根
      // 一律 engine_open_failed{session}（连接根无重置点）——N1 的回归面。
      const launch = frame.launch as Record<string, unknown> | undefined;
      const root = launch?.rootSessionId;
      if (!this.connRoots.has(socket)) {
        this.connRoots.set(socket, root);
      } else if (this.connRoots.get(socket) !== root) {
        this.openFailures.push({ code: "session", launch });
        this.sendControl(socket, {
          v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
          kind: K.engineOpenFailed,
          id: frame.id,
          code: "session",
          message: `root session mismatch: connection bound to ${String(this.connRoots.get(socket))}, open carried ${String(root)}`,
          recovery: "One control connection serves one root session; open a new connection for another session.",
        });
        return;
      }
      if (this.onEngineOpen !== undefined) {
        this.onEngineOpen(socket, frame);
        return;
      }
      const channelId = `ch-${++this.channelSeq}`;
      this.sendControl(socket, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.engineOpened,
        id: frame.id,
        channelId,
        pid: process.pid,
      });
      return;
    }
    if (frame.kind === K.engineFrame) {
      this.onEngineFrame?.(socket, frame);
      return;
    }
    if (frame.kind === K.engineClose && this.autoCloseOnEngineClose) {
      this.sendEngineClosed(String(frame.channelId));
    }
  }
}

const openServers: FakeControlServer[] = [];
const dataDirs: string[] = [];

async function startServer(): Promise<FakeControlServer> {
  const server = await FakeControlServer.start();
  openServers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.close();
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeTransport(
  server: FakeControlServer,
  overrides: Partial<RuntimeEngineTransportOptions> = {},
): RuntimeEngineTransport {
  return new RuntimeEngineTransport({
    engineId: "fake",
    hostKind: "test",
    baseEnv: {
      TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath,
      TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-rt-1",
    },
    connectTimeoutMs: 1_000,
    helloTimeoutMs: 1_000,
    openTimeoutMs: 1_000,
    closeGraceMs: 400,
    ...overrides,
  });
}

function makeSpec(overrides: Partial<EngineLaunchSpec> = {}): EngineLaunchSpec {
  return {
    engineId: "fake",
    entryPath: process.execPath,
    args: ["--fake"],
    cwd: tmpdir(),
    envPrefixes: [],
    rootSessionId: "",
    ...overrides,
  };
}

function collectExits(transport: RuntimeEngineTransport): EngineTransportExitInfo[] {
  const exits: EngineTransportExitInfo[] = [];
  transport.onExit((info) => exits.push(info));
  return exits;
}

describe("RuntimeEngineTransport：control 通道全链（验收①）", () => {
  it("hello 关联 + engine_open→engine_opened（launch 归属键）+ 帧双向（engine_frame 信封）", async () => {
    const server = await startServer();
    const transport = makeTransport(server);
    const frames: string[] = [];
    transport.onFrame((line) => frames.push(line));

    const opened = await transport.open(makeSpec());
    expect(opened.pid).toBe(process.pid); // 假 server 回传 runtime pid（协议面 pid 透传）

    const hello = server.frames.find((f) => f.kind === K.hello);
    expect(hello).toMatchObject({
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: K.hello,
      hostPid: process.pid,
      hostKind: "test",
    });
    const open = server.frames.find((f) => f.kind === K.engineOpen);
    const launch = open?.launch as Record<string, unknown>;
    expect(launch).toMatchObject({
      engineId: "fake",
      entryPath: process.execPath,
      cwd: tmpdir(),
      rootSessionId: "sess-rt-1",
    });
    expect(launch.parentRecordId).toBeUndefined(); // 顶层无身份 env → 不携带嵌套键

    // C→R：writeFrame 包 engine_frame 信封（line 原样）
    const request = JSON.stringify({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    expect(transport.writeFrame(request)).toBe(true);
    await waitFor(() => server.frames.some((f) => f.kind === K.engineFrame && f.line === request), "engine_frame C→R");

    // R→C：解包 engine_frame.line 交给 onFrame
    server.sendEngineFrame("ch-1", JSON.stringify({ id: 1, result: { protocolVersion: 1 } }));
    await waitFor(() => frames.length === 1, "engine_frame R→C");
    expect(JSON.parse(frames[0]!) as unknown).toEqual({ id: 1, result: { protocolVersion: 1 } });

    await transport.close();
  });

  it("多通道同一连接：engine_open 应答乱序仍按 id 关联，帧按 channelId 路由不串", async () => {
    const server = await startServer();
    const replies: Array<{ socket: net.Socket; frame: FakeFrame }> = [];
    server.onEngineOpen = (socket, frame) => {
      replies.push({ socket, frame });
      if (replies.length !== 2) return;
      const [first, second] = replies as [{ socket: net.Socket; frame: FakeFrame }, { socket: net.Socket; frame: FakeFrame }];
      // 先回第二个（ch-b），再回第一个（ch-a）
      server.sendControl(second.socket, { v: 1, kind: K.engineOpened, id: second.frame.id, channelId: "ch-b", pid: 111 });
      server.sendControl(first.socket, { v: 1, kind: K.engineOpened, id: first.frame.id, channelId: "ch-a", pid: 222 });
    };
    const transportA = makeTransport(server);
    const transportB = makeTransport(server);
    const framesA: string[] = [];
    const framesB: string[] = [];
    transportA.onFrame((line) => framesA.push(line));
    transportB.onFrame((line) => framesB.push(line));

    const [openA, openB] = await Promise.all([transportA.open(makeSpec()), transportB.open(makeSpec())]);
    expect(server.connectionCount).toBe(1); // 进程级共享：两个通道一条连接
    expect(openA.pid).toBe(222); // 第一个 open 的应答后到（ch-a）
    expect(openB.pid).toBe(111);

    server.sendEngineFrame("ch-a", "for-a");
    server.sendEngineFrame("ch-b", "for-b");
    await waitFor(() => framesA.length === 1 && framesB.length === 1, "per-channel frame routing");
    expect(framesA).toEqual(["for-a"]);
    expect(framesB).toEqual(["for-b"]);

    await transportA.close();
    await transportB.close();
  });

  it("[m-core-1] 跨 chunk 的 UTF-8 多字节字符不被撕裂（StringDecoder 按字符边界切分）", async () => {
    const server = await startServer();
    server.onEngineOpen = (socket, frame) => {
      server.sendControl(socket, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.engineOpened,
        id: frame.id,
        channelId: "ch-utf8",
        pid: process.pid,
      });
    };
    const transport = makeTransport(server);
    const frames: string[] = [];
    transport.onFrame((line) => frames.push(line));
    await transport.open(makeSpec());

    const inboundLine = JSON.stringify({ id: 9, result: { text: "中文内容" } });
    const envelope = `${JSON.stringify({
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: K.engineFrame,
      channelId: "ch-utf8",
      line: inboundLine,
    })}\n`;
    const bytes = Buffer.from(envelope, "utf8");
    const charStart = bytes.indexOf(Buffer.from("中", "utf8"));
    expect(charStart).toBeGreaterThan(0);
    // 3 字节汉字拆到两个 chunk：切点落在字符内部（bytes[charStart..charStart+3)）。
    await server.sendRawChunks([bytes.subarray(0, charStart + 1), bytes.subarray(charStart + 1)], 30);

    await waitFor(() => frames.length === 1, "inbound engine frame after split chunks");
    expect(frames[0]).toBe(inboundLine);
    expect(frames[0]).not.toContain("\uFFFD");
    await transport.close();
  });

  it("engine_closed → onExit（code/signal/reason/stderrTail）；stderrTail 经 onStderr 出口", async () => {
    const server = await startServer();
    const stderr: string[] = [];
    const transport = makeTransport(server, { onStderr: (chunk) => stderr.push(chunk) });
    const exits = collectExits(transport);
    await transport.open(makeSpec());

    server.sendEngineClosed("ch-1", {
      code: 3,
      signal: "SIGKILL",
      reason: "killed_by_control",
      stderrTail: "fatal: engine exploded",
    });
    await waitFor(() => exits.length === 1, "onExit");
    expect(exits[0]).toEqual({
      code: 3,
      signal: "SIGKILL",
      reason: "killed_by_control",
      stderrTail: "fatal: engine exploded",
    });
    expect(stderr.join("")).toContain("fatal: engine exploded");
    // 通道已终局：再次 close 幂等立即 resolve（不重复发 engine_close）
    await transport.close();
    expect(server.frames.filter((f) => f.kind === K.engineClose)).toHaveLength(0);
  });

  it("engine_close 幂等：并发重复 close 只发一帧，engine_closed 到达后都 resolve", async () => {
    const server = await startServer();
    const transport = makeTransport(server);
    await transport.open(makeSpec());

    const first = transport.close();
    const second = transport.close();
    await Promise.all([first, second]);
    await waitFor(() => server.frames.some((f) => f.kind === K.engineClose), "engine_close sent");
    expect(server.frames.filter((f) => f.kind === K.engineClose)).toHaveLength(1);
  });

  it("engine_close 宽限：server 不回 engine_closed → close 在宽限后放弃该通道（不关共享连接）", async () => {
    const server = await startServer();
    server.autoCloseOnEngineClose = false;
    const transport = makeTransport(server, { closeGraceMs: 120 });
    await transport.open(makeSpec());
    const startedAt = Date.now();
    await transport.close();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    // 共享连接仍活（通道放弃不影响连接）：第二次 open 复用同一连接成功
    const again = makeTransport(server);
    await again.open(makeSpec());
    expect(server.connectionCount).toBe(1);
    await again.close();
  });
});

describe("RuntimeControlClient：连接死亡 fan-out（验收①③）", () => {
  it("连接死亡：在册通道 engine_transport_lost + 在途 open 全拒 + 客户端不可用不重试", async () => {
    const server = await startServer();
    const client = new RuntimeControlClient({
      socketPath: server.socketPath,
      hostKind: "test",
      connectTimeoutMs: 1_000,
      helloTimeoutMs: 1_000,
      openTimeoutMs: 1_000,
    });
    const errors: EngineSdkError[] = [];
    const handlers: ControlChannelHandlers = {
      onFrame: () => {},
      onExit: () => {},
      onError: (err) => errors.push(err),
    };
    await client.connect();
    await client.openChannel(makeSpec(), { rootSessionId: "sess-1" }, handlers);
    server.holdOpen = true;
    const pending = client.openChannel(makeSpec(), { rootSessionId: "sess-1" }, handlers);
    await waitFor(() => server.frames.filter((f) => f.kind === K.engineOpen).length === 2, "second engine_open");

    server.destroyConnections();
    await expect(pending).rejects.toMatchObject({ code: "engine_transport_lost" });
    await waitFor(() => errors.length === 1, "channel error fan-out");
    expect(errors[0]?.code).toBe("engine_transport_lost");
    expect(errors[0]?.recovery).toContain("control connection");
    expect(client.channelCount).toBe(0);
    expect(client.isUsable).toBe(false);
    await expect(client.connect()).rejects.toMatchObject({ code: "engine_transport_unavailable" });
    client.dispose();
  });
});

describe("传输错误码面（验收②）", () => {
  it("engine_open_timeout：runtime 迟不回应答 → open 以超时码 reject", async () => {
    const server = await startServer();
    server.holdOpen = true;
    const transport = makeTransport(server, { openTimeoutMs: 120 });
    await expect(transport.open(makeSpec())).rejects.toMatchObject({ code: "engine_open_timeout" });
  });

  it("迟到 engine_opened（本端已超时）→ 丢弃并补发 engine_close（不让 runtime 留下无人认领的通道）", async () => {
    const server = await startServer();
    server.holdOpen = true;
    const client = new RuntimeControlClient({
      socketPath: server.socketPath,
      hostKind: "test",
      connectTimeoutMs: 1_000,
      helloTimeoutMs: 1_000,
      openTimeoutMs: 100,
    });
    await client.connect();
    const handlers: ControlChannelHandlers = { onFrame: () => {}, onExit: () => {}, onError: () => {} };
    await expect(client.openChannel(makeSpec(), { rootSessionId: "sess-1" }, handlers))
      .rejects.toMatchObject({ code: "engine_open_timeout" });
    const openId = server.frames.find((f) => f.kind === K.engineOpen)?.id;
    server.sendToAll({ v: 1, kind: K.engineOpened, id: openId, channelId: "ch-late", pid: process.pid });
    await waitFor(
      () => server.frames.some((f) => f.kind === K.engineClose && f.channelId === "ch-late"),
      "late engine_close",
    );
    expect(client.channelCount).toBe(0);
    client.dispose();
  });

  it("engine_open_failed：runtime 拒开（spawn_failed）→ engine_crashed（与 local 启动失败同型）", async () => {
    const server = await startServer();
    server.onEngineOpen = (socket, frame) => {
      server.sendControl(socket, {
        v: 1,
        kind: K.engineOpenFailed,
        id: frame.id,
        code: "spawn_failed",
        message: "engine executor not found",
        recovery: "install the engine",
      });
    };
    const transport = makeTransport(server);
    await expect(transport.open(makeSpec())).rejects.toMatchObject({
      code: "engine_crashed",
      message: expect.stringContaining("spawn_failed"),
      recovery: "install the engine",
    });
  });

  it("D10 错误分型映射：runtime 裁决码按语义分流（逐码锁定）", () => {
    const cases: Array<[string, string]> = [
      ["session", "engine_transport_unavailable"],
      ["channel_limit", "engine_backpressure_overflow"],
      ["invalid_launch", "engine_crashed"],
      ["spawn_failed", "engine_crashed"],
      ["duplicate", "engine_transport_unavailable"],
      // [R2A-N3①] 通道终局（非关闭竞态）不是连接丢失：原 code 透传，不落
      // engine_transport_lost（D10 的 lost 专指 control 连接中途丢失）。
      ["unknown_channel", "unknown_channel"],
      ["engine_open_timeout", "engine_open_timeout"],
      ["engine_frame_too_large", "engine_frame_too_large"],
      ["engine_backpressure_overflow", "engine_backpressure_overflow"],
      // SDK transport 族 / 引擎透传码原样保留（不重复收敛）。
      ["engine_transport_lost", "engine_transport_lost"],
      ["engine_not_found", "engine_not_found"],
    ];
    for (const [controlCode, expected] of cases) {
      const err = mapControlError(controlCode, `detail-${controlCode}`);
      expect(err.code, controlCode).toBe(expected);
      if (expected !== controlCode) {
        expect(err.message, controlCode).toContain(`(control code: ${controlCode}`);
      }
      // [R2A-N3③] runtime 帧裁决的错误都带 controlCode 机器标记（connectOnce 据此
      // 保留启动裁决的专用 recovery）。
      expect(err.data?.controlCode, controlCode).toBe(controlCode);
    }
    // recovery 语义：crash 面有专用兜底（不借用 transport_unavailable 的可达性文案）
    expect(mapControlError("spawn_failed", "boom").recovery).toContain("runtime failed to launch");
    // [R2A-N3①] unknown_channel：透传 code + 通道终局 recovery（连接仍活），不是 lost。
    const unknown = mapControlError("unknown_channel", "unknown channel ch-9");
    expect(unknown.code).not.toBe("engine_transport_lost");
    expect(unknown.message).toContain("unknown channel ch-9");
    expect(unknown.recovery).toContain("control connection itself is still alive");
    // runtime 帧携带的 recovery 优先（排障指引不丢）。
    expect(mapControlError("unknown_channel", "gone", "Open the engine channel again with engine_open.").recovery)
      .toBe("Open the engine channel again with engine_open.");
    // [R2A-N3②] channel_limit 与字节背压区分：同 code 但 detail 显式标明「通道数上限」。
    const channelLimit = mapControlError("channel_limit", "connection channel limit (256) reached");
    expect(channelLimit.code).toBe("engine_backpressure_overflow");
    expect(channelLimit.message).toContain("channel-count limit, not write-queue byte backpressure");
  });

  it("engine_frame_too_large：出站信封超限 → writeFrame false + onTransportError 具体码（不截断）", async () => {
    const server = await startServer();
    const transport = makeTransport(server, { maxFrameBytes: 1_024 });
    const errors: EngineSdkError[] = [];
    transport.onTransportError((err) => errors.push(err));
    await transport.open(makeSpec());

    expect(transport.writeFrame("x".repeat(4_096))).toBe(false);
    expect(errors[0]?.code).toBe("engine_frame_too_large");
    // 过载通道已补发 engine_close（让 runtime 杀组回收）
    await waitFor(() => server.frames.some((f) => f.kind === K.engineClose), "engine_close after oversize");
    await transport.close();
  });

  it("engine_backpressure_overflow：socket 背压 + 单通道队列上限 → 具体码且通道终止", async () => {
    const server = await startServer();
    const transport = makeTransport(server, { channelQueueMaxBytes: 1_024 });
    const errors: EngineSdkError[] = [];
    transport.onTransportError((err) => errors.push(err));
    await transport.open(makeSpec());
    server.pauseConnections();

    const payload = "y".repeat(64 * 1024);
    const deadline = Date.now() + 5_000;
    while (errors.length === 0 && Date.now() < deadline) {
      transport.writeFrame(payload);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(errors[0]?.code).toBe("engine_backpressure_overflow");
    expect(transport.writeFrame(payload)).toBe(false);
    await transport.close();
  });

  it("背压队列 drain：连接恢复后积压帧按 FIFO 到达（不丢帧不串序）", async () => {
    const server = await startServer();
    const transport = makeTransport(server);
    await transport.open(makeSpec());
    server.pauseConnections();
    const payload = "z".repeat(64 * 1024);
    const lines = Array.from({ length: 16 }, (_, i) => `queued-${i}-${payload}`);
    for (const line of lines) transport.writeFrame(line);
    server.resumeConnections();
    await waitFor(
      () => lines.every((l) => server.frames.some((f) => f.kind === K.engineFrame && f.line === l)),
      "queued frames drained",
    );
    const received = server.frames.filter((f) => f.kind === K.engineFrame).map((f) => String(f.line));
    expect(received).toEqual(lines); // FIFO 且零丢失
    await transport.close();
  });

  it("engine_transport_unavailable：socket 不存在 / hello 超时（connect/hello 失败面，不静默 local）", async () => {
    const server = await startServer();
    const missing = new RuntimeEngineTransport({
      engineId: "fake",
      hostKind: "test",
      baseEnv: {
        TAIJI_SUBAGENT_CONTROL_SOCKET: join(tmpdir(), `u-m3-rt-missing-${process.pid}.sock`),
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-rt-1",
      },
      connectTimeoutMs: 500,
    });
    await expect(missing.open(makeSpec())).rejects.toMatchObject({ code: "engine_transport_unavailable" });

    server.holdHello = true;
    const transport = makeTransport(server, { helloTimeoutMs: 120 });
    await expect(transport.open(makeSpec())).rejects.toMatchObject({ code: "engine_transport_unavailable" });
  });

  it("hello_reject version → engine_protocol_mismatch（D9 版本矩阵）", async () => {
    const server = await startServer();
    server.rejectHelloVersion = true;
    const transport = makeTransport(server);
    await expect(transport.open(makeSpec())).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
  });

  it("runtime 裁决 error 帧（channelId）→ 具体码经 onTransportError fan-out", async () => {
    const server = await startServer();
    const transport = makeTransport(server);
    const errors: EngineSdkError[] = [];
    transport.onTransportError((err) => errors.push(err));
    await transport.open(makeSpec());

    server.sendError("ch-1", "engine_backpressure_overflow", "socket queue overflow");
    await waitFor(() => errors.length === 1, "channel error frame");
    expect(errors[0]?.code).toBe("engine_backpressure_overflow");
    expect(errors[0]?.message).toContain("socket queue overflow");
    await transport.close();
  });

  it("launch 归属键：spec 优先，其次 control env；嵌套身份 env → parentRecordId/depth；root 缺失显式失败", async () => {
    const server = await startServer();
    const nested = makeTransport(server, {
      baseEnv: {
        TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath,
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-root-env",
        PI_SUBAGENT_SELF_RECORD_ID: "rec-parent",
        PI_SUBAGENT_DEPTH: "2",
      },
    });
    await nested.open(makeSpec());
    const launch = server.frames.find((f) => f.kind === K.engineOpen)?.launch as Record<string, unknown>;
    expect(launch).toMatchObject({
      rootSessionId: "sess-root-env",
      parentRecordId: "rec-parent",
      depth: 2,
    });
    await nested.close();

    const explicit = makeTransport(server);
    await explicit.open(makeSpec({ rootSessionId: "sess-from-run-ctx" }));
    const explicitLaunch = server.frames.filter((f) => f.kind === K.engineOpen).at(-1)?.launch as Record<string, unknown>;
    expect(explicitLaunch.rootSessionId).toBe("sess-from-run-ctx");
    await explicit.close();

    const noRoot = makeTransport(server, {
      baseEnv: { TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath },
    });
    await expect(noRoot.open(makeSpec())).rejects.toMatchObject({ code: "engine_transport_unavailable" });

    // [B-U-1 嵌套优先级] spec（run ctx 真根）> control env（spawn 期 temp id）>
    // 身份 env（PI_SUBAGENT_ROOT_SESSION_ID = 嵌套真根）；spec 有值时不得被 env 遮蔽。
    const nestedExplicit = makeTransport(server, {
      baseEnv: {
        TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath,
        TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-spawn-temp",
        PI_SUBAGENT_ROOT_SESSION_ID: "sess-nested-root",
      },
    });
    await nestedExplicit.open(makeSpec({ rootSessionId: "sess-run-ctx" }));
    const nestedLaunch = server.frames.filter((f) => f.kind === K.engineOpen).at(-1)?.launch as Record<string, unknown>;
    expect(nestedLaunch.rootSessionId).toBe("sess-run-ctx");
    await nestedExplicit.close();
  });
});

// ── EngineClient 谓词接线（验收③④）─────────────────────────────────────────────

/** 假 server 的引擎协议应答：initialize/dispose 各回 result（EngineClient 握手用）。 */
function wireFakeEngineProtocol(server: FakeControlServer): void {
  server.onEngineFrame = (socket, frame) => {
    let parsed: { id?: number; method?: string };
    try {
      parsed = JSON.parse(String(frame.line)) as { id?: number; method?: string };
    } catch {
      return;
    }
    if (parsed.method !== "initialize" && parsed.method !== "dispose") return;
    server.sendControl(socket, {
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: K.engineFrame,
      channelId: frame.channelId,
      line: JSON.stringify({ id: parsed.id, result: { protocolVersion: SUBAGENT_CONTROL_PROTOCOL_VERSION } }),
    });
  };
}

function makeHostedClient(
  server: FakeControlServer,
  dataDir: string,
  baseEnv: Record<string, string | undefined> = {},
  engineId = "fake",
): EngineClient {
  return new EngineClient({
    engineId,
    command: process.execPath,
    args: ["--never-spawned"],
    hostKind: "test",
    dataDir,
    envPrefixes: [],
    baseEnv: {
      TAIJI_SUBAGENT_CONTROL_SOCKET: server.socketPath,
      TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "sess-rt-1",
      ...baseEnv,
    },
  });
}

/**
 * 假引擎协议应答（initialize + 任意正向方法）：R2A-N1/N2 用例需要 run/probe 级请求
 * 兑现（双客户端、并发 ensureConnected 后的实际派发）。
 */
function wireEchoEngineProtocol(server: FakeControlServer, seenMethods: string[] = []): void {
  server.onEngineFrame = (socket, frame) => {
    let parsed: { id?: number; method?: string };
    try {
      parsed = JSON.parse(String(frame.line)) as { id?: number; method?: string };
    } catch {
      return;
    }
    if (parsed.method === undefined) return;
    seenMethods.push(parsed.method);
    const result = parsed.method === "initialize"
      ? { protocolVersion: SUBAGENT_CONTROL_PROTOCOL_VERSION }
      : { ok: parsed.method };
    server.sendControl(socket, {
      v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
      kind: K.engineFrame,
      channelId: frame.channelId,
      line: JSON.stringify({ id: parsed.id, result }),
    });
  };
}

describe("EngineClient：runtime transport 谓词接线（验收③④）", () => {
  it("[B-U-1] run ctx 权威根 → engine_open.rootSessionId（不被 control env 的 spawn 期 temp id 遮蔽）", async () => {
    const server = await startServer();
    wireFakeEngineProtocol(server);
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
    dataDirs.push(dataDir);
    // control env 模拟 create 路径：ProcessManager 在 spawn 时注入 temp id（pi 自生成
    // sessionId 后 rekey 只改 runtime Map，不更新已 spawn 的 pi env）。
    const client = makeHostedClient(server, dataDir, {
      TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id",
    });

    await client.ensureConnected("real-session-id-from-ctx");
    expect(client.currentState).toBe("ready");
    const open = server.frames.find((f) => f.kind === K.engineOpen);
    expect((open?.launch as Record<string, unknown>).rootSessionId).toBe("real-session-id-from-ctx");
    await client.dispose();
  });

  it("[B-U-1] 探针先以 env 初值建连 → run ctx 真实根触发换代重连（engine_open 携带权威根）", async () => {
    const server = await startServer();
    wireFakeEngineProtocol(server);
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
    dataDirs.push(dataDir);
    const client = makeHostedClient(server, dataDir, {
      TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id",
    });

    // 探针路径（无 run ctx）：control env 初值成为连接绑定值。
    await client.ensureConnected();
    const opens = server.frames.filter((f) => f.kind === K.engineOpen);
    expect((opens[0]?.launch as Record<string, unknown>).rootSessionId).toBe("spawn-temp-id");

    // run 路径携带 per-run 权威根：旧通道不可换绑（runtime 侧 session 不一致即拒），
    // 换代重连 + 新 engine_open 用真根。
    await client.ensureConnected("real-session-id-from-ctx");
    expect(client.currentState).toBe("ready");
    const reopened = server.frames.filter((f) => f.kind === K.engineOpen);
    expect(reopened).toHaveLength(2);
    expect((reopened[1]?.launch as Record<string, unknown>).rootSessionId).toBe("real-session-id-from-ctx");
    // 旧通道已发 engine_close（runtime 杀组回收）
    expect(server.frames.some((f) => f.kind === K.engineClose)).toBe(true);
    await client.dispose();
  });

  it("[R2A-N1] 单 control server + 双 EngineClient：pi run（真根）先 / zcode probe（env temp 根）后 → 无 session mismatch、无永久 unavailable", async () => {
    const server = await startServer();
    wireEchoEngineProtocol(server);
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-n1-"));
    dataDirs.push(dataDir);
    // 两个引擎共享同一进程级 control env：create 路径的 spawn 期 temp 根。
    const env = { TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id" };
    const pi = makeHostedClient(server, dataDir, env, "pi");
    const zcode = makeHostedClient(server, dataDir, env, "zcode");

    // 顺序 A：pi run 先用真根建连。
    await pi.ensureConnected("real-root");
    // zcode probe 无 run ctx → env 回落 temp 根。旧实现落到 pi 的共享连接上 →
    // engine_open_failed{session} → probe 永久 unavailable。
    await zcode.ensureConnected();

    expect(pi.currentState).toBe("ready");
    expect(zcode.currentState).toBe("ready");
    expect(server.openFailures).toEqual([]);
    // 协议不变量：不同根各占一条连接，每条连接只绑一个根。
    expect(server.connectionCount).toBe(2);
    expect([...new Set(server.activeConnectionRoots)].sort()).toEqual(["real-root", "spawn-temp-id"]);
    // 两引擎的通道都真实可用（不是「标记 ready 但请求走不通」）。
    await expect(pi.request("run", { runId: "pi-run" })).resolves.toBeTruthy();
    await expect(zcode.request("probe", {})).resolves.toBeTruthy();

    // 顺序 B（反序，同一 server 新会话）：zcode probe 先（temp 根）→ pi run 后（真根
    // 不能在 temp 连接上 open 被拒）。
    const piB = makeHostedClient(server, dataDir, env, "pi-b");
    const zcodeB = makeHostedClient(server, dataDir, env, "zcode-b");
    await zcodeB.ensureConnected();
    await piB.ensureConnected("real-root-b");
    expect(piB.currentState).toBe("ready");
    expect(zcodeB.currentState).toBe("ready");
    expect(server.openFailures).toEqual([]);
    await expect(piB.request("run", { runId: "pi-run-b" })).resolves.toBeTruthy();
    await expect(zcodeB.request("probe", {})).resolves.toBeTruthy();

    await pi.dispose();
    await zcode.dispose();
    await piB.dispose();
    await zcodeB.dispose();
  });

  it("[R2A-N2] 探针后两个并发 ensureConnected（真根）→ 只生成一代连接，两 run 都成功", async () => {
    const server = await startServer();
    wireEchoEngineProtocol(server);
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-n2-"));
    dataDirs.push(dataDir);
    const client = makeHostedClient(server, dataDir, {
      TAIJI_SUBAGENT_CONTROL_ROOT_SESSION_ID: "spawn-temp-id",
    });

    // 探针先建连（temp 根，通道 1）。
    await client.ensureConnected();
    // 并行两个 run：旧实现两次 rebind 各自起一代 connectOnce → 第三个 engine_open
    // 与误拆新 transport（transport_lost/unavailable）。单飞后只应有一次换绑 + 一次 open。
    await Promise.all([
      client.ensureConnected("real-root"),
      client.ensureConnected("real-root"),
    ]);

    const opens = server.frames.filter((f) => f.kind === K.engineOpen);
    expect(opens.map((f) => (f.launch as Record<string, unknown>).rootSessionId))
      .toEqual(["spawn-temp-id", "real-root"]);
    expect(server.openFailures).toEqual([]);
    expect(client.currentState).toBe("ready");
    // temp 连接在换绑后 refcount 归零被关停，只剩真根连接。
    await waitFor(() => server.connectionCount === 1, "temp connection disposed after rebind");
    expect(server.activeConnectionRoots).toEqual(["real-root"]);

    // 两个 run 共用同一代连接且都得到应答（不是「一个成功一个 transport_lost」）。
    const results = await Promise.all([
      client.request("run", { runId: "run-a" }),
      client.request("run", { runId: "run-b" }),
    ]);
    expect(results).toEqual([{ ok: "run" }, { ok: "run" }]);
    expect(client.currentState).toBe("ready");
    await client.dispose();
  });

  it("[B-U-3] 同失败形态分型等价（code 同为 engine_crashed）+ [R2A-N3③] runtime 帧 recovery 保留", async () => {
    // local：entry 子进程加载即退出（本地启动失败的真实形态）
    const localDir = mkdtempSync(join(tmpdir(), "u-m3-rt-local-dead-"));
    dataDirs.push(localDir);
    const deadEngine = join(localDir, "dead-engine.mjs");
    writeFileSync(deadEngine, "process.exit(1);\n", "utf8");
    const local = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [deadEngine],
      hostKind: "test",
      dataDir: localDir,
      envPrefixes: [],
      baseEnv: {},
    });
    let localCode: string | undefined;
    try {
      await local.ensureConnected();
    } catch (err) {
      localCode = (err as EngineSdkError).code;
    }
    expect(localCode).toBe("engine_crashed");

    // runtime：runtime 侧启动裁决失败（invalid_launch / spawn_failed）→ 同一 code 分型；
    // R2A-N3③：runtime 帧的专用 recovery 经 connectOnce 原样保留（不被宿主通用文案
    // 盖掉——恢复指引指向真实修复动作）。
    for (const controlCode of ["invalid_launch", "spawn_failed"] as const) {
      const server = await startServer();
      server.onEngineOpen = (socket, frame) => {
        server.sendControl(socket, {
          v: 1,
          kind: K.engineOpenFailed,
          id: frame.id,
          code: controlCode,
          message: controlCode === "invalid_launch"
            ? "entryPath is not an absolute existing path"
            : "engine executor not found",
          recovery: "resolve the engine entry from the descriptor",
        });
      };
      const runtimeDir = mkdtempSync(join(tmpdir(), "u-m3-rt-runtime-invalid-"));
      dataDirs.push(runtimeDir);
      const hosted = makeHostedClient(server, runtimeDir);
      await expect(hosted.ensureConnected("real-session-id")).rejects.toSatisfy(
        (err: Error & { code?: string; recovery?: string; message?: string }) => {
          expect(err.code).toBe("engine_crashed");
          expect(err.message).toContain(controlCode);
          // [R2A-N3③] 真实 open 路径的 recovery 断言：runtime 帧文案保留。
          expect(err.recovery).toBe("resolve the engine entry from the descriptor");
          return true;
        },
      );
      expect(hosted.currentState).toBe("unavailable");
    }
  });
  it("control env 激活 → runtime transport 被选中：ready 经 control 通道（零 spawn 零 pidfile）+ dispose 走 dispose 帧与 engine_close", async () => {
    const server = await startServer();
    wireFakeEngineProtocol(server);
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
    dataDirs.push(dataDir);
    const client = makeHostedClient(server, dataDir);

    await client.ensureConnected();
    expect(client.currentState).toBe("ready");
    // runtime 模式无 local 进程面：不 spawn、无 pidfile（验收③）
    expect(client.enginePid).toBeUndefined();
    expect(existsSync(pidfilePath(dataDir, "fake", "test", process.pid))).toBe(false);
    const open = server.frames.find((f) => f.kind === K.engineOpen);
    expect((open?.launch as Record<string, unknown>).rootSessionId).toBe("sess-rt-1");

    const before = server.frames.length;
    await client.dispose();
    expect(client.currentState).toBe("disposed");
    const after = server.frames.slice(before);
    // 优雅关闭序：引擎协议 dispose 帧（engine_frame）→ engine_close（控制帧）
    expect(after.some((f) => f.kind === K.engineFrame && String(f.line).includes('"method":"dispose"'))).toBe(true);
    expect(after.some((f) => f.kind === K.engineClose)).toBe(true);
  });

  it("通道级 error 帧 → 在途请求以具体码 reject（不被后续 engine_closed 的 engine_crashed 覆盖）", async () => {
    const server = await startServer();
    wireFakeEngineProtocol(server);
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
    dataDirs.push(dataDir);
    const client = makeHostedClient(server, dataDir);

    await client.ensureConnected();
    const pending = client.request("ping", {});
    await waitFor(
      () => server.frames.some((f) => f.kind === K.engineFrame && String(f.line).includes('"method":"ping"')),
      "ping frame",
    );
    // D8 顺序：先 error {code}，再 engine_closed——具体码不被 engine_crashed 覆盖
    server.sendError("ch-1", "engine_frame_too_large", "engine frame envelope too large");
    server.sendEngineClosed("ch-1", { code: null, signal: null, reason: "killed_by_control" });
    await expect(pending).rejects.toMatchObject({ code: "engine_frame_too_large" });
    // 通道级错误在 engine_closed 后回到 exited（下次 run 可重建——退避重试语义与引擎崩溃同型）；
    // 连接死亡无 engine_closed 跟随 → 保持 unavailable（不在同一连接重试）
    expect(client.currentState).toBe("exited");
  });

  it("[m-core-3] unknown_channel（通道终局、连接仍活）→ 不 markUnavailable；下一次 run 在活连接上重新 open", async () => {
    const server = await startServer();
    wireEchoEngineProtocol(server);
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-unknown-"));
    dataDirs.push(dataDir);
    const client = makeHostedClient(server, dataDir);

    await client.ensureConnected();
    expect(client.currentState).toBe("ready");

    // runtime 对 unknown_channel 只发 error 帧、不跟 engine_closed（D10：通道终局，
    // 不是连接丢失）。旧实现无条件 markUnavailable → 无 engine_closed 回落，永久不可用。
    server.sendError("ch-1", "unknown_channel", "unknown channel ch-1");
    await waitFor(() => client.currentState === "exited", "state falls back to exited");
    expect(client.currentState).not.toBe("unavailable");

    // 下一次 run 可重建：同一 control 连接上重新 engine_open（连接未死，不重连）。
    await client.ensureConnected();
    expect(client.currentState).toBe("ready");
    expect(server.frames.filter((f) => f.kind === K.engineOpen)).toHaveLength(2);
    expect(server.connectionCount).toBe(1);
    await expect(client.request("probe", {})).resolves.toBeTruthy();
    await client.dispose();
  });

  it("连接在 engine_open 期间死亡 → ensureConnected 以 engine_transport_lost 上抛（不包装）+ 标记不可用", async () => {
    const server = await startServer();
    server.holdOpen = true;
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
    dataDirs.push(dataDir);
    const client = makeHostedClient(server, dataDir);

    const pending = client.ensureConnected();
    await waitFor(() => server.frames.some((f) => f.kind === K.engineOpen), "engine_open in flight");
    server.destroyConnections();
    await expect(pending).rejects.toMatchObject({ code: "engine_transport_lost" });
    expect(client.currentState).toBe("unavailable");
  });

  it("hello_reject version → engine_protocol_mismatch 原样上抛（不包装 engine_crashed）", async () => {
    const server = await startServer();
    server.rejectHelloVersion = true;
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-data-"));
    dataDirs.push(dataDir);
    const client = makeHostedClient(server, dataDir);

    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    expect(client.currentState).toBe("unavailable");
  });

  it("[ADR-0122] 握手期失败（initialize 版本不兼容）→ 清理回执 engine_closed 不复活 unavailable；再次 ensureConnected 仍抛原错误且不重新 engine_open", async () => {
    const server = await startServer();
    // 通道已 open、initialize 应答版本越界（握手失败的快速形态；超时形态
    // engine_handshake_timeout 走同一条 connectOnce catch → teardown + markUnavailable 路径）。
    server.onEngineFrame = (socket, frame) => {
      let parsed: { id?: number; method?: string };
      try {
        parsed = JSON.parse(String(frame.line)) as { id?: number; method?: string };
      } catch {
        return;
      }
      if (parsed.method !== "initialize") return;
      server.sendControl(socket, {
        v: SUBAGENT_CONTROL_PROTOCOL_VERSION,
        kind: K.engineFrame,
        channelId: frame.channelId,
        line: JSON.stringify({ id: parsed.id, result: { protocolVersion: 999 } }),
      });
    };
    const dataDir = mkdtempSync(join(tmpdir(), "u-m3-rt-handshake-"));
    dataDirs.push(dataDir);
    const client = makeHostedClient(server, dataDir);

    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    // 清理链（teardownProcess → engine_close → runtime 回 engine_closed → 通道终局）
    // 走完的确定性信号 = 共享 control 连接引用归零被关停（release 在 onExit 之后）。
    await waitFor(() => server.connectionCount === 0, "engine_closed processed (control connection released)");
    // 终局失败不得被清理回执复活（旧实现 onTransportExit 无条件 state = "exited"，
    // 会让下一次 ensureConnected 把终局错误当可重试、重新 spawn 引擎）。
    expect(client.currentState).toBe("unavailable");

    const opensBefore = server.frames.filter((f) => f.kind === K.engineOpen).length;
    await expect(client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
    expect(server.frames.filter((f) => f.kind === K.engineOpen)).toHaveLength(opensBefore);
    expect(client.currentState).toBe("unavailable");
  });
});
