// connection.test.ts —— R2 连接层测试：全部跑 __fixtures__/fake-appserver.mjs 子进程
// （移植自 zsw 仓 84b63a0^ fake-server 测试模式，vitest 形态改造），绝不 spawn 真
// zcode.cjs。覆盖验收条款：四帧型分发逐型 / 请求-应答 id 关联（并发不串）/
// requestRuntimePreferences 常量应答逐字段 / 未知反向回空 result / onClose 全部在途
// reject（含 stderr 尾 400 截断）/ 惰性启动与进程死后重建 / stderr tee 落盘 /
// protocol 自报忽略 / 无 jsonrpc 字段的帧收发（出站精确键集 = 对面 strict 拒未知键
// 的镜像义务）/ env 惯例 / 关闭原语幂等。

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ZCODE_APPSERVER_STDERR_TAIL_CHARS } from "../constants.ts";
import {
  AppServerConnection,
  RUNTIME_PREFERENCES,
  buildAppServerEnv,
  isAppServerRpcError,
} from "../connection.ts";

const TMP = mkdtempSync(join(tmpdir(), "zcode-conn-"));
const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-appserver.mjs", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fake 侧事件流水条目（JSONL：boot/env/recv/reverse-answer）。 */
interface StateEvent {
  seq: number;
  ev: string;
  [key: string]: unknown;
}

function readState(file: string): StateEvent[] {
  try {
    return readFileSync(file, "utf8")
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

/** 轮询等待 fake 侧异步效果可见（fake 异步处理 stdin，不能假设即时）。 */
async function waitFor(cond: () => boolean, ms = 5_000, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

interface FakeHandle {
  conn: AppServerConnection;
  stateFile: string;
  stderrLog: string;
  cwd: string;
}

interface FakeOpts {
  /** FAKE_STDERR=1：启动时往 stderr 写两行。 */
  stderrLines?: boolean;
  /** FAKE_EXTRA_KEYS=1：fake 应答/推送帧携带未知键（客户端宽容解析断言）。 */
  extraKeys?: boolean;
  /** FAKE_PROTOCOL_PUSH=1：协议自报走 {method:'protocol'} 推送形态。 */
  protocolPush?: boolean;
  /** 基 env 预置引擎原生嵌套标记（nesting guard 剥离断言）。 */
  polluteNested?: boolean;
  /** 注入故障反向 handler（fire-and-forget catch 断言）。 */
  reverseHandlers?: Readonly<Record<string, (params: unknown) => unknown>>;
}

const CONNECTIONS: AppServerConnection[] = [];
let connSeq = 0;

/** 建一个连到 fake 的连接（env 面向子进程固化，测试间零共享状态）。 */
function makeConnection(opts: FakeOpts = {}): FakeHandle {
  connSeq += 1;
  const stateFile = join(TMP, `state-${connSeq}.jsonl`);
  const stderrLog = join(TMP, `stderr-${connSeq}.log`);
  const cwd = join(TMP, `cwd-${connSeq}`);
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: "/fake-host-home",
    FAKE_STATE_FILE: stateFile,
    ...(opts.stderrLines ? { FAKE_STDERR: "1" } : {}),
    ...(opts.extraKeys ? { FAKE_EXTRA_KEYS: "1" } : {}),
    ...(opts.protocolPush ? { FAKE_PROTOCOL_PUSH: "1" } : {}),
    ...(opts.polluteNested ? { ZSW_NESTED: "1", CLAUDECODE: "1", PI_SUBAGENT_DEPTH: "2" } : {}),
  };
  const conn = new AppServerConnection({
    cliPath: FAKE_CLI,
    cwd,
    env: buildAppServerEnv(base),
    stderrLogPath: stderrLog,
    ...(opts.reverseHandlers ? { reverseHandlers: opts.reverseHandlers } : {}),
  });
  CONNECTIONS.push(conn);
  return { conn, stateFile, stderrLog, cwd };
}

afterEach(async () => {
  await Promise.allSettled(CONNECTIONS.splice(0).map((c) => c.shutdown({ graceMs: 1_000 })));
});

// ------------------------------------------- 惰性启动与重建（D1 / 不变量 4）

describe("惰性启动与惰性重建", () => {
  it("构造不 spawn：无流水、无 pid、alive=false（连接构建零成本）", async () => {
    const { conn, stateFile } = makeConnection();
    expect(conn.alive).toBe(false);
    expect(conn.pid).toBeUndefined();
    await sleep(80);
    expect(existsSync(stateFile)).toBe(false);
    expect(conn.pid).toBeUndefined();
  });

  it("首次请求才 spawn：boot 流水出现，argv 形态 = `app-server --cwd <dir>`（D10 基线，不带 --stdio/--surface）", async () => {
    const { conn, stateFile, cwd } = makeConnection();
    const r = await conn.request("test/echo", { marker: "first" });
    expect(r).toEqual({ marker: "first" });
    const boots = readState(stateFile).filter((e) => e.ev === "boot");
    expect(boots).toHaveLength(1);
    expect(boots[0].argv).toEqual(["app-server", "--cwd", cwd]);
    expect(conn.pid).toBeGreaterThan(0);
    expect(conn.alive).toBe(true);
  }, 10_000);

  it("进程死后下次请求自动重建（与惰性启动同路径）：boot 两次、pid 变化", async () => {
    const { conn, stateFile } = makeConnection();
    await conn.request("test/echo", { n: 1 });
    const pidBefore = conn.pid;
    await expect(conn.request("test/suicide")).rejects.toThrow(/app-server/);
    expect(await waitFor(() => !conn.alive)).toBe(true);
    const r2 = await conn.request("test/echo", { n: 2 });
    expect(r2).toEqual({ n: 2 });
    const boots = readState(stateFile).filter((e) => e.ev === "boot");
    expect(boots).toHaveLength(2);
    expect(boots[1].pid).not.toBe(boots[0].pid);
    expect(conn.pid).not.toBe(pidBefore);
  }, 15_000);

  it("spawn 失败（nodeBin ENOENT）走同一收割路径：请求 reject 带 spawn 失败语境，连接不悬挂", async () => {
    const conn = new AppServerConnection({
      cliPath: FAKE_CLI,
      cwd: TMP,
      nodeBin: join(TMP, "no-such-node-bin"),
      env: { PATH: process.env.PATH ?? "" },
      stderrLogPath: join(TMP, "enoent.log"),
    });
    CONNECTIONS.push(conn);
    await expect(conn.request("test/echo", {})).rejects.toThrow(/spawn 失败/);
    expect(await waitFor(() => !conn.alive)).toBe(true);
  }, 10_000);
});

// ------------------------------------------- 四帧型分发（附录 A.1）

describe("四帧型分发（NDJSON，无 jsonrpc 字段）", () => {
  it("客户端请求帧：出站精确键集 {id, method, params}——无 jsonrpc、无未知键（对面 strict 拒未知键）", async () => {
    const { conn, stateFile } = makeConnection();
    await conn.request("test/echo", { a: 1 });
    const frames = readState(stateFile)
      .map((e) => (e as Record<string, unknown>).frame)
      .filter((f): f is Record<string, unknown> => isRecord(f) && f.method === "test/echo");
    expect(frames).toHaveLength(1);
    expect(Object.keys(frames[0]).sort()).toEqual(["id", "method", "params"]);
    expect(typeof frames[0].id).toBe("number");
    expect("jsonrpc" in frames[0]).toBe(false);
  });

  it("应答帧（result）：resolve 应答值；帧级未知键宽容解析（我们是客户端，strict 校验是对面）", async () => {
    const { conn } = makeConnection({ extraKeys: true });
    const r = await conn.request<{ marker: string }>("test/echo", { marker: "lenient" });
    expect(r).toEqual({ marker: "lenient" });
    // 推送帧携带未知键同样不破坏分发
    const received: unknown[] = [];
    conn.onNotification("test/notification", (p) => received.push(p));
    await conn.request("test/push", { pushMethod: "test/notification", pushParams: { delta: "hi" } });
    expect(received).toEqual([{ delta: "hi" }]);
  });

  it("应答帧（error）：code/message/data 挂到 reject Error（A.3 错误码通道，-32602 zod 诊断随 data 带出）", async () => {
    const { conn } = makeConnection();
    const err = await conn
      .request("test/fail", {
        code: -32602,
        message: "Invalid params",
        data: [{ path: ["model"], message: "not an object" }],
      })
      .then(
        () => {
          throw new Error("should reject");
        },
        (e: unknown) => e,
      );
    expect(isAppServerRpcError(err)).toBe(true);
    if (isAppServerRpcError(err)) {
      expect(err.code).toBe(-32602);
      expect(err.data).toEqual([{ path: ["model"], message: "not an object" }]);
      expect(err.message).toContain("[-32602]");
      expect(err.message).toContain("Invalid params");
    }
  });

  it("服务端推送帧：onNotification(method) 收到 params；handler 异常不拖死帧泵；退订生效", async () => {
    const { conn } = makeConnection();
    const received: unknown[] = [];
    const receivedBoom: unknown[] = [];
    const receivedOff: unknown[] = [];
    conn.onNotification("test/notification", (params) => {
      received.push(params);
    });
    conn.onNotification("test/notification", (params) => {
      receivedBoom.push(params);
      throw new Error("handler boom");
    });
    const off = conn.onNotification("test/notification", (params) => {
      receivedOff.push(params);
    });
    off();
    await conn.request("test/push", { pushMethod: "test/notification", pushParams: { delta: "hello" } });
    await conn.request("test/push", { pushMethod: "test/notification", pushParams: { delta: "again" } });
    expect(received).toEqual([{ delta: "hello" }, { delta: "again" }]);
    expect(receivedBoom).toEqual([{ delta: "hello" }, { delta: "again" }]);
    expect(receivedOff).toEqual([]);
    // 抛过异常后连接仍可用
    const r = await conn.request("test/echo", { ok: 1 });
    expect(r).toEqual({ ok: 1 });
  });
});

// ------------------------------------------- 请求-应答 id 关联

describe("请求-应答 id 关联", () => {
  it("并发多请求不串线：3 个在途请求各自 resolve 自己的回显；id 自增互异", async () => {
    const { conn, stateFile } = makeConnection();
    const [a, b, c] = await Promise.all([
      conn.request("test/delay-echo", { who: "a", delayMs: 60 }),
      conn.request("test/delay-echo", { who: "b", delayMs: 30 }),
      conn.request("test/echo", { who: "c" }),
    ]);
    expect(a).toEqual({ who: "a", delayMs: 60 });
    expect(b).toEqual({ who: "b", delayMs: 30 });
    expect(c).toEqual({ who: "c" });
    const ids = readState(stateFile)
      .map((e) => (e as Record<string, unknown>).frame)
      .filter((f): f is { id: number } => isRecord(f) && typeof f.method === "string" && typeof f.id === "number")
      .map((f) => f.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it("超时预算参数化：小预算 reject 超时，pending 清理后后续请求正常", async () => {
    const { conn } = makeConnection();
    await expect(conn.request("test/delay-echo", { delayMs: 5_000 }, { timeoutMs: 120 })).rejects.toThrow(/超时/);
    const r = await conn.request("test/echo", { after: "timeout" });
    expect(r).toEqual({ after: "timeout" });
  }, 10_000);
});

// ------------------------------------------- 反向请求应答（D9）

describe("反向请求应答（D9）", () => {
  it("session/requestRuntimePreferences → 常量表应答逐字段（真实协议：create 先发反向请求并等应答）", async () => {
    const { conn, stateFile } = makeConnection();
    const created = await conn.request<{ session: { sessionId: string } }>("session/create", {
      workspace: { workspacePath: "/w", workspaceKey: "ws-x" },
      mode: "yolo",
    });
    expect(typeof created.session.sessionId).toBe("string");
    const answers = readState(stateFile).filter((e) => e.ev === "reverse-answer");
    expect(answers).toHaveLength(1);
    const result = (answers[0].answer as { result?: Record<string, unknown> }).result;
    // 逐字段断言（D9 常量逐字来自旧实现实测）
    expect(result).toEqual({ ...RUNTIME_PREFERENCES });
    expect(result?.nativeSearchEnhancementsEnabled).toBe(true);
    expect(result?.memoryEnabled).toBe(false);
    expect(result?.askUserQuestionAutoResolutionEnabled).toBe(true);
    expect(result?.modelContextBudgetStrategy).toBe("preflight-v1");
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "askUserQuestionAutoResolutionEnabled",
      "memoryEnabled",
      "modelContextBudgetStrategy",
      "nativeSearchEnhancementsEnabled",
    ]);
    // 反向应答帧出站精确键集 {id, result}（无 jsonrpc、无未知键）
    const answerFrame = readState(stateFile)
      .map((e) => (e as Record<string, unknown>).frame)
      .find((f): f is Record<string, unknown> => isRecord(f) && typeof f.id === "string");
    expect(answerFrame).toBeDefined();
    expect(Object.keys(answerFrame!).sort()).toEqual(["id", "result"]);
  });

  it("未知反向请求 → 回 {id, result:{}}（不答会 15s 超时断连，旧实测 -32022）", async () => {
    const { conn, stateFile } = makeConnection();
    await conn.request("test/reverse", { reverseMethod: "permission/request", reverseParams: { tool: "Bash" } });
    const answers = readState(stateFile).filter((e) => e.ev === "reverse-answer");
    expect(answers).toHaveLength(1);
    const answer = answers[0].answer as { result?: unknown; error?: unknown };
    expect(answer.result).toEqual({});
    expect(answer.error).toBeUndefined();
  });

  it("应答失败不拖死连接（fire-and-forget + catch）：故障 handler → 回 error 帧，连接仍可用", async () => {
    const { conn, stateFile } = makeConnection({
      reverseHandlers: {
        "session/requestRuntimePreferences": () => {
          throw new Error("prefs boom");
        },
      },
    });
    const created = await conn.request("session/create", {});
    expect(created).toBeTruthy();
    const answers = readState(stateFile).filter((e) => e.ev === "reverse-answer");
    expect(answers).toHaveLength(1);
    const answer = answers[0].answer as { error?: { code?: number; message?: string } };
    expect(answer.error?.code).toBe(-32000);
    expect(answer.error?.message).toContain("prefs boom");
    const r = await conn.request("test/echo", { still: "alive" });
    expect(r).toEqual({ still: "alive" });
  });
});

// ------------------------------------------- 崩溃收割（onClose）

describe("崩溃收割（onClose/exit）", () => {
  it("进程意外退出：全部在途 reject，错误信息附 stderr 尾（400 字符截断）", async () => {
    const { conn } = makeConnection();
    await conn.request("test/echo", { warm: true });
    const errors = await Promise.all(
      [
        conn.request("test/delay-echo", { who: "a", delayMs: 10_000 }),
        conn.request("test/delay-echo", { who: "b", delayMs: 10_000 }),
        conn.request("test/suicide"),
      ].map((p) => p.then(
        () => {
          throw new Error("should reject");
        },
        (e: unknown) => e,
      )),
    );
    expect(errors).toHaveLength(3);
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("app-server");
      expect(msg).toContain("code=1");
      expect(msg).toContain("CRASH-MARK-TAIL");
      // 截断到常量值：600 个 A 只保留尾部（< 400），整段噪声不允许进错误信息
      expect(msg).not.toMatch(new RegExp(`A{${ZCODE_APPSERVER_STDERR_TAIL_CHARS}}`));
    }
    expect(await waitFor(() => !conn.alive)).toBe(true);
  }, 15_000);
});

// ------------------------------------------- stderr tee 落盘

describe("stderr tee 落盘", () => {
  it("stderr 实时 append 到参数化路径（引擎数据目录注入点；测试用 tmp）", async () => {
    const { conn, stderrLog } = makeConnection({ stderrLines: true });
    await conn.request("test/echo", {});
    const ok = await waitFor(() => {
      try {
        const text = readFileSync(stderrLog, "utf8");
        return text.includes("fake-appserver stderr line A") && text.includes("fake-appserver stderr line B");
      } catch {
        return false;
      }
    });
    expect(ok).toBe(true);
  });
});

// ------------------------------------------- env 惯例（构造注入面）

describe("env 惯例（共享宿主 HOME 形态）", () => {
  it("buildAppServerEnv：HOME 正向透传（共享宿主）+ 遥测关闭 + nesting guard 剥离/注入（fake 侧 env 快照）", async () => {
    const { conn, stateFile } = makeConnection({ polluteNested: true });
    await conn.request("test/echo", {});
    const envEvents = readState(stateFile).filter((e) => e.ev === "env");
    expect(envEvents).toHaveLength(1);
    const snap = envEvents[0] as {
      home?: string;
      telemetry?: string;
      nested?: string;
      unifiedNested?: string;
    };
    // 共享宿主 HOME 契约（2026-09 起）：base env 携带的宿主 HOME 值原样透传到子进程
    // env（不覆写、不剥离——db/plugins/MCP 全继承宿主 HOME）
    expect(snap.home).toBe("/fake-host-home");
    expect(snap.telemetry).toBe("false");
    expect(snap.nested).toBeUndefined();
    expect(snap.unifiedNested).toBe("1");
  });
});

// ------------------------------------------- 关闭原语（R4 dispose 的连接侧原语）

describe("关闭原语", () => {
  it("close()：同步 SIGTERM 面——进程随后死亡；幂等；只起过一代", async () => {
    const { conn, stateFile } = makeConnection();
    await conn.request("test/echo", {});
    expect(conn.alive).toBe(true);
    conn.close();
    conn.close();
    expect(await waitFor(() => !conn.alive)).toBe(true);
    expect(readState(stateFile).filter((e) => e.ev === "boot")).toHaveLength(1);
  }, 10_000);

  it("shutdown()：杀链走完进程退出；幂等；之后首个请求自动重建（不变量 4：与崩溃重建同路径）", async () => {
    const { conn, stateFile } = makeConnection();
    await conn.request("test/echo", {});
    await conn.shutdown({ graceMs: 1_500 });
    await conn.shutdown();
    expect(await waitFor(() => !conn.alive)).toBe(true);
    const r = await conn.request("test/echo", { reborn: true });
    expect(r).toEqual({ reborn: true });
    expect(readState(stateFile).filter((e) => e.ev === "boot")).toHaveLength(2);
  }, 15_000);

  it("close() 后调 shutdown()：await close 发起的同一杀链，resolve 不早于进程退出（幂等——同一 promise）", async () => {
    const { conn, stateFile } = makeConnection();
    await conn.request("test/echo", {});
    const pid = conn.pid;
    conn.close();
    let shutdownSettled = false;
    const shutdownPromise = conn.shutdown().then(() => {
      shutdownSettled = true;
    });
    await shutdownPromise;
    expect(shutdownSettled).toBe(true);
    // killChain 挂 exit 事件 resolve（Node exit 前已收尸）——shutdown resolve 时进程
    // 必已退出：kill(0) 探活抛 ESRCH 即「resolve 不早于杀链完成」的机制性证据
    expect(() => process.kill(pid ?? -1, 0)).toThrow(/ESRCH/);
    // 幂等：再次 shutdown 复用同一 promise，无新杀链、无新进程
    await conn.shutdown();
    expect(readState(stateFile).filter((e) => e.ev === "boot")).toHaveLength(1);
  }, 10_000);
});

// ------------------------------------------- protocol 自报与宽容解析

describe("protocol 自报与宽容解析", () => {
  it("首帧 {protocol:{name,version}} 自报忽略不抛，protocolInfo 记录，连接可用", async () => {
    const { conn } = makeConnection();
    const r = await conn.request("test/echo", { ok: 1 });
    expect(r).toEqual({ ok: 1 });
    expect(conn.protocolInfo).toEqual({ name: "ZCode Protocol", version: 1 });
  });

  it("protocol 推送形态 {method:'protocol'} 同样收敛到 protocolInfo", async () => {
    const { conn } = makeConnection({ protocolPush: true });
    await conn.request("test/echo", {});
    expect(conn.protocolInfo).toEqual({ name: "ZCode Protocol", version: 1 });
  });

  it("坏行跳过不断流：非 JSON 行之后正常应答", async () => {
    const { conn } = makeConnection();
    const r = await conn.request("test/malformed-first", {});
    expect(r).toEqual({ survived: true });
  });
});
