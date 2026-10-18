// src/__tests__/relay-agent.test.ts
//
// relay.mjs 代理 CLI 协议行为集成测试（E-1 验收）——本地环回 socket + 伪 runtime
// （net.createServer 模拟 runtime 侧行为），spawn 真实代理进程逐条断言：
//   1. 启动自检：归属 env（SESSION_ID/RECORD_ID）缺失 / socket env 缺失 → 退出码 13
//   2. socket 不可达（重试一次后仍失败）→ 退出码 11 + stderr 含路径与恢复指引
//   3. 握手帧字段完整（v/kind/mainSessionId/recordId/argv/env/cwd）
//   4. down/up/up-stderr 字节往返保真（中文/换行/空字节的二进制 buffer）
//   5. exit 帧退出码传播 / 退出前 stdout 已 flush
//   6. exit 帧 signal 传播（spawn 方观察到 (code=null, signal)）
//   7. socket 断 → 退出码 12（崩溃矩阵②的 extension 侧感知机制）
//   8. reject version → 退出码 10 + 重装指引；reject 其他 reason → 12
//   9. 背压：256KB 随机字节经代理双向环回（stdin→down→server→up→stdout）收齐无丢字节

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
  RELAY_EXIT_CODES,
  RELAY_PROTOCOL_VERSION,
} from "@zhushanwen/subagent-core/relay-env";

/** 被测脚本：包根 relay/relay.mjs（与 src/ 平行的零依赖脚本，不参与 TS 编译）。 */
const RELAY_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../relay/relay.mjs",
);

/** 协议帧（代理 ↔ runtime JSONL）。字段全部可选除 kind——按 kind 分支后逐字段断言。 */
interface RelayFrame {
  kind: string;
  v?: unknown;
  dir?: unknown;
  b64?: unknown;
  code?: unknown;
  signal?: unknown;
  reason?: unknown;
  supported?: unknown;
  mainSessionId?: unknown;
  recordId?: unknown;
  argv?: unknown;
  env?: unknown;
  cwd?: unknown;
}

/** JSON.parse + 运行时守卫（禁裸 as）：非对象或无 string kind 视为不可解析。 */
function parseFrame(line: string): RelayFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const kind = (parsed as Record<string, unknown>).kind;
  if (typeof kind !== "string") return null;
  return { ...(parsed as Record<string, unknown>), kind };
}

interface FakeRuntime {
  socketPath: string;
  server: net.Server;
  conn: net.Socket | null;
  /** 第一帧 handshake（默认 respond 逻辑 accept 后 resolve；自定义 respond 也 resolve）。 */
  handshakePromise: Promise<RelayFrame>;
  /** 收到的全部 down 帧解码后的字节块。 */
  downChunks: Buffer[];
  downTotal: () => number;
  /** 收到的全部 goodbye 预告帧（宿主信号终止时的 teardown 预告）。 */
  goodbyeFrames: RelayFrame[];
  send: (frame: Record<string, unknown>) => boolean;
  destroyConn: () => void;
  close: () => Promise<void>;
}

/** 默认 runtime 行为：收 handshake → 回 accept。 */
function defaultRespond(_handshake: RelayFrame, rt: FakeRuntime): void {
  rt.send({ v: RELAY_PROTOCOL_VERSION, kind: "accept" });
}

function startFakeRuntime(
  socketPath: string,
  respond: (handshake: RelayFrame, rt: FakeRuntime) => void = defaultRespond,
): Promise<FakeRuntime> {
  // handshake 的 settle 状态（resolve 回调 + 已收到帧），供「仅首个 handshake 帧响应」判定
  const handshakeState: { resolve: ((f: RelayFrame) => void) | null; frame: RelayFrame | null } = {
    resolve: null,
    frame: null,
  };
  const handshakePromise = new Promise<RelayFrame>((resolve) => {
    handshakeState.resolve = resolve;
  });
  let connRef: net.Socket | null = null;
  const downChunks: Buffer[] = [];
  const goodbyeFrames: RelayFrame[] = [];
  const server = net.createServer((conn) => {
    connRef = conn;
    let lineBuf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.trim()) continue;
        const frame = parseFrame(line);
        if (!frame) continue;
        if (frame.kind === "goodbye") {
          goodbyeFrames.push(frame);
          continue;
        }
        if (frame.kind === "handshake") {
          // 仅首个 handshake 帧响应 + settle（单连接单握手是协议形态）
          if (handshakeState.frame === null) {
            handshakeState.frame = frame;
            respond(frame, rt);
            handshakeState.resolve?.(frame);
          }
          continue;
        }
        if (frame.kind === "data" && frame.dir === "down" && typeof frame.b64 === "string") {
          downChunks.push(Buffer.from(frame.b64, "base64"));
        }
      }
    });
  });
  const rt: FakeRuntime = {
    socketPath,
    server,
    get conn() {
      return connRef;
    },
    downChunks,
    downTotal: () => downChunks.reduce((sum, c) => sum + c.length, 0),
    goodbyeFrames,
    send: (frame) => {
      if (!connRef || connRef.destroyed) throw new Error("fake runtime: no live connection");
      return connRef.write(JSON.stringify(frame) + "\n");
    },
    destroyConn: () => {
      connRef?.destroy();
    },
    handshakePromise,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  return new Promise<FakeRuntime>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      activeServers.push(server);
      resolve(rt);
    });
  });
}

interface SpawnOpts {
  /** undefined = 不注入该 env（测缺失路径）。 */
  socketPath?: string;
  sessionId?: string;
  recordId?: string;
  argv?: string[];
  /** 额外注入 env（如 RELAY_CONNECT_RETRY_DELAY_MS 压缩重试等待）；在 5 个 relay 变量精确控制之后合并。 */
  extraEnv?: Record<string, string>;
}

/**
 * spawn 代理进程（node 直跑 relay.mjs，env 精确控制 5 个 relay 变量）。
 * stdout/stderr 收集器随 spawn 立即挂上——对齐真实契约（extension 的 stdout pump
 * 从 spawn 起消费；若测试侧不读，代理的 stdout 背压会正确地暂停 socket，测试卡死）。
 */
interface CollectedChild {
  child: ChildProcessWithoutNullStreams;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
}

function spawnRelay(opts: SpawnOpts): CollectedChild {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[RELAY_ENV_SOCKET];
  delete env[RELAY_ENV_NODE];
  delete env[RELAY_ENV_SCRIPT];
  delete env[RELAY_ENV_SESSION_ID];
  delete env[RELAY_ENV_RECORD_ID];
  if (opts.socketPath !== undefined) env[RELAY_ENV_SOCKET] = opts.socketPath;
  if (opts.sessionId !== undefined) env[RELAY_ENV_SESSION_ID] = opts.sessionId;
  if (opts.recordId !== undefined) env[RELAY_ENV_RECORD_ID] = opts.recordId;
  // 测试注入通道先剥离再按需注入：外层环境残留不得影响用例确定性
  delete env.RELAY_CONNECT_RETRY_DELAY_MS;
  Object.assign(env, opts.extraEnv);
  const child = spawn(process.execPath, [RELAY_SCRIPT_PATH, ...(opts.argv ?? ["--mode", "rpc"])], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const collected: CollectedChild = {
    child,
    stdoutChunks: [],
    stderrChunks: [],
  };
  child.stdout.on("data", (c: Buffer) => collected.stdoutChunks.push(c));
  child.stderr.on("data", (c: Buffer) => collected.stderrChunks.push(c));
  activeChildren.push(child);
  return collected;
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: Buffer;
}

/** 等 child close，输出取自 spawn 时挂起的收集器（close 时数据已齐）。 */
function waitForExit({ child, stdoutChunks, stderrChunks }: CollectedChild): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

/** 轮询等待条件成立（25ms 间隔；超时抛错）。 */
async function pollUntil(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 固定时长等待（真实子进程集成测试无 fake timers 可用——计时在子进程内）。 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 分块发送大 up 帧（64KB/帧 + socket drain 等待，驱动代理侧 socket→stdout 背压路径）。 */
async function sendLargeUp(rt: FakeRuntime, data: Buffer): Promise<void> {
  const CHUNK = 64 * 1024;
  for (let i = 0; i < data.length; i += CHUNK) {
    const frame = {
      v: RELAY_PROTOCOL_VERSION,
      kind: "data",
      dir: "up",
      b64: data.subarray(i, i + CHUNK).toString("base64"),
    };
    if (!rt.send(frame)) {
      await new Promise<void>((resolve) => {
        const c = rt.conn;
        if (!c) return resolve();
        c.once("drain", () => resolve());
      });
    }
  }
}

const activeServers: net.Server[] = [];
const activeChildren: ChildProcessWithoutNullStreams[] = [];
const activeTmpDirs: string[] = [];

function makeSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-test-"));
  activeTmpDirs.push(dir);
  return path.join(dir, "relay.sock");
}

afterEach(async () => {
  for (const child of activeChildren) {
    if (!child.killed) child.kill("SIGKILL");
  }
  activeChildren.length = 0;
  await Promise.all(
    activeServers.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
  activeServers.length = 0;
  for (const dir of activeTmpDirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  activeTmpDirs.length = 0;
});

describe("relay agent CLI (relay.mjs)", () => {
  it("identity env missing → exit 13 + stderr names the env vars", { timeout: 10_000 }, async () => {
    const child = spawnRelay({});
    const res = await waitForExit(child);
    expect(res.code).toBe(RELAY_EXIT_CODES.MISSING_IDENTITY);
    expect(res.stderr).toContain(RELAY_ENV_SESSION_ID);
    expect(res.stderr).toContain(RELAY_ENV_RECORD_ID);
  });

  it("socket env missing (identity present) → exit 13", { timeout: 10_000 }, async () => {
    const child = spawnRelay({ sessionId: "sess-1", recordId: "rec-1" });
    const res = await waitForExit(child);
    expect(res.code).toBe(RELAY_EXIT_CODES.MISSING_IDENTITY);
    expect(res.stderr).toContain(RELAY_ENV_SOCKET);
  });

  it("socket unreachable → retry once then exit 11 with path + recovery hint", { timeout: 15_000 }, async () => {
    const socketPath = path.join(makeSocketPath(), "never-listening.sock");
    const child = spawnRelay({
      socketPath,
      sessionId: "sess-1",
      recordId: "rec-1",
      // 重试间隔注入 10ms（生产默认 200ms）——只压缩测试等待，重试一次后失败的契约不变
      extraEnv: { RELAY_CONNECT_RETRY_DELAY_MS: "10" },
    });
    const res = await waitForExit(child);
    expect(res.code).toBe(RELAY_EXIT_CODES.SOCKET_UNREACHABLE);
    expect(res.stderr).toContain(socketPath);
    expect(res.stderr).toContain("重试任务");
    expect(res.stderr).toContain("重启 taiji");
  });

  it("handshake frame carries full spawn spec (v/kind/mainSessionId/recordId/argv/env/cwd)", { timeout: 15_000 }, async () => {
    const socketPath = makeSocketPath();
    const rt = await startFakeRuntime(socketPath);
    const argv = ["--mode", "rpc", "--model", "test/model"];
    const child = spawnRelay({ socketPath, sessionId: "sess-42", recordId: "rec-99", argv });
    const hs = await rt.handshakePromise;
    expect(hs.kind).toBe("handshake");
    expect(hs.v).toBe(RELAY_PROTOCOL_VERSION);
    expect(hs.mainSessionId).toBe("sess-42");
    expect(hs.recordId).toBe("rec-99");
    expect(hs.argv).toEqual(argv);
    expect(hs.cwd).toBe(process.cwd());
    // env 全量转发：含注入的归属 env 与 socket env（runtime spawn 真实 pi 原样使用）
    expect(hs.env).toBeTypeOf("object");
    expect(hs.env).toHaveProperty(RELAY_ENV_SESSION_ID, "sess-42");
    expect(hs.env).toHaveProperty(RELAY_ENV_RECORD_ID, "rec-99");
    expect(hs.env).toHaveProperty(RELAY_ENV_SOCKET, socketPath);
    // 收尾：默认 respond 已 accept，发 exit 让子进程退出
    rt.send({ kind: "exit", code: 0 });
    const res = await waitForExit(child);
    expect(res.code).toBe(0);
  });

  it("byte roundtrip fidelity: down/up/up-stderr with CJK, newlines, NUL bytes", { timeout: 15_000 }, async () => {
    const socketPath = makeSocketPath();
    const rt = await startFakeRuntime(socketPath);
    const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
    await rt.handshakePromise;

    // 下行字节：JSON 命令行 + 中文 + 换行（挑战 JSONL 行协议）+ 空字节（挑战文本假设）
    const downBytes = Buffer.concat([
      Buffer.from('{"type":"prompt","message":"你好，世界\n', "utf8"),
      Buffer.from([0x00, 0x01, 0xff, 0xfe]),
      Buffer.from('第二行"}\n', "utf8"),
    ]);
    child.child.stdin.write(downBytes);
    await pollUntil(() => rt.downTotal() === downBytes.length, 5_000, "down bytes");
    expect(Buffer.concat(rt.downChunks)).toEqual(downBytes);

    // 上行 stdout / stderr 字节保真
    const upBytes = Buffer.concat([
      Buffer.from("stdout 流式输出\nline2\0", "utf8"),
      crypto.randomBytes(64),
    ]);
    const upStderrBytes = Buffer.concat([
      Buffer.from("stderr 诊断\n\0字节", "utf8"),
      crypto.randomBytes(32),
    ]);
    rt.send({ v: RELAY_PROTOCOL_VERSION, kind: "data", dir: "up", b64: upBytes.toString("base64") });
    rt.send({
      v: RELAY_PROTOCOL_VERSION,
      kind: "data",
      dir: "up-stderr",
      b64: upStderrBytes.toString("base64"),
    });
    rt.send({ kind: "exit", code: 3 });
    const res = await waitForExit(child);
    expect(res.stdout).toEqual(upBytes);
    expect(res.stderr).toEqual(upStderrBytes.toString("utf8"));
    expect(res.code).toBe(3);
  });

  it("exit frame code propagation flushes stdout first", { timeout: 10_000 }, async () => {
    const socketPath = makeSocketPath();
    const rt = await startFakeRuntime(socketPath);
    const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
    await rt.handshakePromise;
    const upBytes = Buffer.from("final bytes before exit\n", "utf8");
    rt.send({ v: RELAY_PROTOCOL_VERSION, kind: "data", dir: "up", b64: upBytes.toString("base64") });
    rt.send({ kind: "exit", code: 7 });
    const res = await waitForExit(child);
    expect(res.code).toBe(7);
    expect(res.stdout).toEqual(upBytes);
  });

  it("exit frame signal → exit-code folding close(143, null)（SIGTERM handler 抢占信号自终止）", { timeout: 10_000 }, async () => {
    const socketPath = makeSocketPath();
    const rt = await startFakeRuntime(socketPath);
    const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
    await rt.handshakePromise;
    rt.send({ kind: "exit", signal: "SIGTERM" });
    const res = await waitForExit(child);
    // batch B 注册 SIGTERM/SIGINT handler 后，exitByFrame 的 process.kill 自杀信号被
    // Node 截获（不再内核默认终止），同步的 process.exit(128+signo) 先行——close 形态
    // 从 (null, SIGTERM) 折算为 (143, null)，与宿主 spawn 侧退出码口径一致。
    expect(res.code).toBe(143);
    expect(res.signal).toBeNull();
  });

  it("socket closed by runtime → exit 12", { timeout: 10_000 }, async () => {
    const socketPath = makeSocketPath();
    const rt = await startFakeRuntime(socketPath);
    const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
    await rt.handshakePromise;
    rt.destroyConn();
    const res = await waitForExit(child);
    expect(res.code).toBe(RELAY_EXIT_CODES.SOCKET_CLOSED);
    expect(res.stderr).toContain("closed");
  });

  it("reject reason=version → exit 10 + reinstall recovery hint", { timeout: 10_000 }, async () => {
    const socketPath = makeSocketPath();
    const rt = await startFakeRuntime(socketPath, (_hs, r) => {
      r.send({ kind: "reject", reason: "version", supported: [RELAY_PROTOCOL_VERSION] });
    });
    const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
    const res = await waitForExit(child);
    expect(res.code).toBe(RELAY_EXIT_CODES.VERSION_MISMATCH);
    expect(res.stderr).toContain("version mismatch");
    expect(res.stderr).toContain("重装应用");
  });

  it("reject with non-version reason → exit 12", { timeout: 10_000 }, async () => {
    const socketPath = makeSocketPath();
    const rt = await startFakeRuntime(socketPath, (_hs, r) => {
      r.send({ kind: "reject", reason: "handshake_invalid" });
    });
    const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
    const res = await waitForExit(child);
    expect(res.code).toBe(RELAY_EXIT_CODES.SOCKET_CLOSED);
    expect(res.stderr).toContain("handshake_invalid");
  });

  it("backpressure: 256KB random bytes survive full down→up roundtrip", { timeout: 60_000 }, async () => {
    const socketPath = makeSocketPath();
    const rt = await startFakeRuntime(socketPath);
    const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
    await rt.handshakePromise;

    // 256KB = 4×64KB CHUNK：跨多帧下行 + 多轮回发，足以触发双向高水位（pause/drain
    // 背压循环）；契约 = 不丢字节，与 payload 量级无关——取值只为压测试耗时。
    const payload = crypto.randomBytes(256 * 1024);
    child.child.stdin.write(payload);
    await pollUntil(() => rt.downTotal() === payload.length, 30_000, "256KB down bytes");
    const receivedDown = Buffer.concat(rt.downChunks);
    expect(receivedDown).toEqual(payload);

    // 同一 payload 分 64KB up 帧回发（驱动代理 socket→stdout 背压 + 行缓冲路径）
    await sendLargeUp(rt, receivedDown);
    rt.send({ kind: "exit", code: 0 });
    const res = await waitForExit(child);
    expect(res.code).toBe(0);
    expect(res.stdout).toEqual(payload);
  });
});

// ════════════════════════════════════════════════════════════════════
// M1 显式状态机（设计 §3.4.1 D1）：connecting → handshaking → awaiting_accept →
// pumping → closing。五态均有用例：connecting（既有 unreachable/close 用例 + 本组
// accept 超时入口）、awaiting_accept（超时/早到帧缓冲/SIGTERM）、pumping（既有泵用例 +
// 迟到停表）、closing（迟到帧忽略/SIGTERM 幂等）。
// ════════════════════════════════════════════════════════════════════

describe("relay agent M1 state machine (relay.mjs)", () => {
  it(
    "awaiting_accept 超时：runtime 永不 accept → 退出码 15 + stderr 含 socket 路径与恢复指引（S5）",
    { timeout: 10_000 },
    async () => {
      const socketPath = makeSocketPath();
      // respond 为 no-op：握手收到但永不 accept
      const rt = await startFakeRuntime(socketPath, () => {});
      const child = spawnRelay({
        socketPath,
        sessionId: "s",
        recordId: "r",
        extraEnv: { TAIJI_RELAY_ACCEPT_TIMEOUT_MS: "400" },
      });
      await rt.handshakePromise;
      const res = await waitForExit(child);
      expect(res.code).toBe(RELAY_EXIT_CODES.ACCEPT_TIMEOUT);
      expect(res.stderr).toContain("accept timeout");
      // 设计 §3.5：stderr 须含 socket 路径（runtime 日志提示）与恢复指引
      expect(res.stderr).toContain(socketPath);
      expect(res.stderr).toContain("重启 taiji");
    },
  );

  it(
    "accept 先到停表：延迟 accept 越过窗口后仍存活且泵可用，不误报 15",
    { timeout: 15_000 },
    async () => {
      const socketPath = makeSocketPath();
      const rt = await startFakeRuntime(socketPath, (_hs, r) => {
        // 250ms 后才 accept（< 800ms 窗口）——accept 到达即停表
        setTimeout(() => {
          try {
            r.send({ v: RELAY_PROTOCOL_VERSION, kind: "accept" });
          } catch {}
        }, 250);
      });
      const child = spawnRelay({
        socketPath,
        sessionId: "s",
        recordId: "r",
        extraEnv: { TAIJI_RELAY_ACCEPT_TIMEOUT_MS: "800" },
      });
      await rt.handshakePromise;
      // 等过 800ms 窗口：accept 已先到，不得触发超时退出
      await sleep(1_200);
      expect(child.child.exitCode).toBeNull();
      // 泵已启动：down 数据正常转发
      const marker = Buffer.from("pump-after-late-accept\n");
      child.child.stdin.write(marker);
      await pollUntil(() => rt.downTotal() === marker.length, 5_000, "down bytes after late accept");
      rt.send({ kind: "exit", code: 0 });
      const res = await waitForExit(child);
      expect(res.code).toBe(0);
    },
  );

  it(
    "closing 后迟到帧忽略：超时退出码保持 15，迟到的 accept/up 帧不转移不落 stdout",
    { timeout: 10_000 },
    async () => {
      const socketPath = makeSocketPath();
      const rt = await startFakeRuntime(socketPath, () => {});
      const child = spawnRelay({
        socketPath,
        sessionId: "s",
        recordId: "r",
        extraEnv: { TAIJI_RELAY_ACCEPT_TIMEOUT_MS: "300" },
      });
      await rt.handshakePromise;
      // 超时（300ms）之后才发 accept + up 帧：closing 终态必须全部忽略
      setTimeout(() => {
        const frames = [
          { v: RELAY_PROTOCOL_VERSION, kind: "accept" },
          { v: RELAY_PROTOCOL_VERSION, kind: "data", dir: "up", b64: Buffer.from("late").toString("base64") },
        ];
        for (const frame of frames) {
          try {
            rt.send(frame);
          } catch {}
        }
      }, 800);
      const res = await waitForExit(child);
      expect(res.code).toBe(RELAY_EXIT_CODES.ACCEPT_TIMEOUT);
      // 迟到 up 帧不得落 stdout（closing 后 writeUp 幂等无操作；若进程已退更不会有输出）
      expect(res.stdout.length).toBe(0);
    },
  );

  it(
    "awaiting_accept 期到达的 down data 帧缓冲不判死（原实现报 unexpected exit 12），pumping 后正常转发",
    { timeout: 10_000 },
    async () => {
      const socketPath = makeSocketPath();
      const rt = await startFakeRuntime(socketPath, (_hs, r) => {
        // accept 之前先推一帧 down data（协议早到帧）
        r.send({
          v: RELAY_PROTOCOL_VERSION,
          kind: "data",
          dir: "down",
          b64: Buffer.from("early-down\n").toString("base64"),
        });
        r.send({ v: RELAY_PROTOCOL_VERSION, kind: "accept" });
      });
      const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
      await rt.handshakePromise;
      // 泵正常工作：stdin 下行字节可达（早到帧不得阻断状态机进入 pumping）
      const stdinBytes = Buffer.from("pumped-after-early-down\n");
      child.child.stdin.write(stdinBytes);
      await pollUntil(() => rt.downTotal() === stdinBytes.length, 5_000, "down bytes");
      expect(Buffer.concat(rt.downChunks)).toEqual(stdinBytes);
      rt.send({ kind: "exit", code: 0 });
      const res = await waitForExit(child);
      expect(res.code).toBe(0);
      expect(res.stderr).not.toContain("unexpected frame before accept");
    },
  );

  it(
    "awaiting_accept 期到达的 up data 帧缓冲，pumping 后转发到 stdout（accept 前预写不丢·帧形态）",
    { timeout: 10_000 },
    async () => {
      const socketPath = makeSocketPath();
      const earlyUp = Buffer.concat([Buffer.from("early-up 流式字节\n", "utf8"), crypto.randomBytes(32)]);
      const rt = await startFakeRuntime(socketPath, (_hs, r) => {
        r.send({ v: RELAY_PROTOCOL_VERSION, kind: "data", dir: "up", b64: earlyUp.toString("base64") });
        r.send({ v: RELAY_PROTOCOL_VERSION, kind: "accept" });
      });
      const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
      await rt.handshakePromise;
      rt.send({ kind: "exit", code: 0 });
      const res = await waitForExit(child);
      expect(res.code).toBe(0);
      expect(res.stdout).toEqual(earlyUp);
    },
  );

  it(
    "P-1b 事故回归：300KB handshake + 延迟 accept + accept 前预写 68KB stdin → down 字节完整等于上游（S2）",
    { timeout: 60_000 },
    async () => {
      const socketPath = makeSocketPath();
      const rt = await startFakeRuntime(socketPath, (_hs, r) => {
        // 模拟 runtime 读大 handshake 后延迟回 accept（600ms < 8s 窗口）
        setTimeout(() => {
          try {
            r.send({ v: RELAY_PROTOCOL_VERSION, kind: "accept" });
          } catch {}
        }, 600);
      });
      // 300KB env：handshake 超出 socket 写缓冲 → accept 前 drain 必然触发（事故形态）
      const filler = "x".repeat(300 * 1024);
      const child = spawnRelay({
        socketPath,
        sessionId: "s",
        recordId: "r",
        extraEnv: { TAIJI_PROBE_TASK: filler, TAIJI_RELAY_ACCEPT_TIMEOUT_MS: "8000" },
      });
      // accept 前预写 68,639 字节（事故实测的 down 字节数）：spawn 后立即写入，
      // 此时 accept 尚未到达、stdin 无监听器——预写字节必须滞留管道待 pumping 读出
      const payload = crypto.randomBytes(68_639);
      child.child.stdin.write(payload);
      await rt.handshakePromise;
      await pollUntil(() => rt.downTotal() === payload.length, 30_000, "pre-accepted down bytes");
      expect(rt.downTotal()).toBe(68_639);
      expect(Buffer.concat(rt.downChunks)).toEqual(payload);
      rt.send({ kind: "exit", code: 0 });
      const res = await waitForExit(child);
      expect(res.code).toBe(0);
    },
  );

  it(
    "SIGTERM in awaiting_accept → closing：退出码 143 且不发 goodbye（未 accept 无预告）",
    { timeout: 10_000 },
    async () => {
      const socketPath = makeSocketPath();
      const rt = await startFakeRuntime(socketPath, () => {}); // 永不 accept
      const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
      await rt.handshakePromise;
      child.child.kill("SIGTERM");
      const res = await waitForExit(child);
      expect(res.code).toBe(143);
      expect(res.signal).toBeNull();
      expect(rt.goodbyeFrames.length).toBe(0);
    },
  );

  it(
    "SIGTERM in pumping → closing 幂等：goodbye 预告帧恰好一帧 + 退出码 143",
    { timeout: 15_000 },
    async () => {
      const socketPath = makeSocketPath();
      const rt = await startFakeRuntime(socketPath); // 默认立即 accept → pumping
      const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
      await rt.handshakePromise;
      // 确认已进 pumping（down 数据可达）再发信号——避免与 accept 处理竞态
      const marker = Buffer.from("warm\n");
      child.child.stdin.write(marker);
      await pollUntil(() => rt.downTotal() === marker.length, 5_000, "pumping marker");
      child.child.kill("SIGTERM");
      const res = await waitForExit(child);
      expect(res.code).toBe(143);
      expect(rt.goodbyeFrames.length).toBe(1);
      expect(rt.goodbyeFrames[0]?.v).toBe(RELAY_PROTOCOL_VERSION);
    },
  );

  it(
    "socket close during awaiting_accept → 生命线断退出码 12（连接期 close/error 分派按状态）",
    { timeout: 10_000 },
    async () => {
      const socketPath = makeSocketPath();
      const rt = await startFakeRuntime(socketPath, () => {}); // 永不 accept
      const child = spawnRelay({ socketPath, sessionId: "s", recordId: "r" });
      await rt.handshakePromise;
      rt.destroyConn();
      const res = await waitForExit(child);
      expect(res.code).toBe(RELAY_EXIT_CODES.SOCKET_CLOSED);
    },
  );
});
