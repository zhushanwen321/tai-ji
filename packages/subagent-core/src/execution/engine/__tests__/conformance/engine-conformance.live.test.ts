// engine-conformance.live.test.ts —— conformance run 层真机门（基线三层③，W10
// 协议化改写）。手动门（设计 §3.3.8 / §4：run 层需已装引擎 + 有效凭据，不进默认 CI）：
//
//   cd packages/subagent-core
//   ENGINE_CONFORMANCE_LIVE=1 [PI_LIVE_MODEL=... ZCODE_E2E_MODEL=...] \
//     pnpm vitest run src/execution/engine/__tests__/conformance/engine-conformance.live.test.ts
//
// W10 改写：断言对象从内建 inproc 引擎（W11 删除）改为**协议客户端 × 引擎包 CLI**
// （EngineClient spawn pi-subagent-cli 进程入口 + RemoteEngine 适配）——即 A2 真机
// 形态本身。断言口径 = 不变量与关键终态（C2 outcome / C3 stream 事件不变量），
// 不做逐字段 diff（设计 §4 基线三层③）。zcode 部分与 zcode-subagent-cli 的
// zcode-engine.live.test.ts 互补（后者覆盖 schema 全链，此处只跑 conformance 最小面）。
//
// 措辞口径（R9-1）：「子进程零残留」= 一代子进程 + 组内后代；引擎自身 detached
// 后代不判 fail（设计 §3.9 已接受代价）。POSIX 组探测（childSpawned pid 非组长）
// 由 reverse-router 运行时告警承载，真机面挂 A3 手动门；Windows 无外部判据显式登记。

import { spawn as childSpawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ZcodeEngine } from "@zhushanwen/zcode-subagent-cli";

import { EngineClient } from "../../client/engine-client.ts";
import { RemoteEngine } from "../../client/remote-engine.ts";
import type { RunContext } from "../../port.ts";
import type { AgentEvent, EngineCapabilities } from "../../types.ts";
import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
  RELAY_PROTOCOL_VERSION,
  isRelayActive,
} from "@zhushanwen/subagent-engine-sdk";
import { assertAgentEventInvariants } from "./agent-event-invariants.ts";

const LIVE = process.env["ENGINE_CONFORMANCE_LIVE"] === "1";

// 锚点：本文件在 packages/subagent-core/src/execution/engine/__tests__/conformance/
// 下，6 层 `..` 到 packages/，再进 pi-subagent-cli 的 bin 入口（manifest bin 目标，
// 与发现器可执行检查同源）。曾错写 7 层落到仓库根 → MODULE_NOT_FOUND（Gate B F1.1）。
const PI_CLI_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../pi-subagent-cli/bin/pi-subagent-cli.mjs",
);

/** pi 引擎 capabilities（manifest 同源形态——真机门内 RemoteEngine 同步成员源）。 */
const PI_LIVE_CAPABILITIES: EngineCapabilities = {
  schemaEnforcement: "native",
  steer: "native",
  conversation: "native",
  personaInjection: "file",
  eventGranularity: "stream",
  sandbox: "none",
  sessionRead: "full",
  resume: "cold",
  interrupt: "kill-only",
  permissionMode: "ignored",
  maxTurns: true,
};

describe.skipIf(!LIVE)("conformance run 层（协议客户端 × 引擎包 CLI，手动门）", () => {
  it("pi：简单任务全链（C2：outcome 无 error、content 非空、engineId=pi；C3 stream 不变量）", async (testCtx) => {
    const model = process.env["PI_LIVE_MODEL"];
    if (model === undefined || model === "") {
      testCtx.skip("PI_LIVE_MODEL 未设置（需真实 provider/model 凭据）——pi live run 面跳过");
      return;
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "w10-live-pi-"));
    // 测试侧宿主扩展隔离（Gate B F1.2 裁决）：pi spawn 会加载宿主 ~/.pi/agent/npm
    // 全局扩展，本机版本破碎（subagent-workflow 8.7.0 × subagent-core 0.2.0 exports
    // 失配）时 pi 启动即退出 code 1——真机门要验的是引擎链路不是宿主扩展环境。
    // main.ts 忽略 argv，argv-mirror 会把 --no-extensions 镜像给 pi 子进程（与
    // pi 官方 hint "pi -ne" 同参）。产品镜像语义不动（正常宿主扩展照常加载）。
    const client = new EngineClient({
      engineId: "pi",
      command: process.execPath,
      args: [PI_CLI_ENTRY, "--no-extensions"],
      hostKind: "test",
      hostVersion: "w10-live",
      dataDir,
      envPrefixes: [],
    });
    const engine = new RemoteEngine({
      engineId: "pi",
      client,
      manifest: { capabilities: PI_LIVE_CAPABILITIES },
      dataDir,
      hostKind: "test",
    });
    try {
      const events: AgentEvent[] = [];
      const task = { prompt: "Reply with the single word: ok", description: "live-c2", model, cwd: os.tmpdir() };
      const ctx: RunContext = { taskId: "sa-live-pi-c2", poolKey: "shared", onEvent: (e) => events.push(e) };
      const { outcome } = await engine.run(task, ctx);
      expect(outcome.error).toBeUndefined();
      expect(outcome.content.trim().length).toBeGreaterThan(0);
      expect(outcome.engineId).toBe("pi");
      assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });
    } finally {
      await engine.dispose();
    }
  }, 120_000);

  it("zcode：probe 真机（C1 live 面：三项 check 全过）", async () => {
    const engine = new ZcodeEngine({ engineDataDir: () => "/tmp/zcode-conformance-live" });
    const report = await engine.probe();
    expect(report.ok).toBe(true);
    expect(report.engineVersion).toMatch(/^0\.\d+\.\d+$/);
  }, 60_000);

  it("zcode：app-server 常驻通道 run 全链（C2 outcome 无 error + C3 stream 事件不变量）", async (testCtx) => {
    const model = process.env["ZCODE_E2E_MODEL"];
    if (model === undefined || model === "") {
      testCtx.skip("ZCODE_E2E_MODEL 未设置（需真实 provider/model 凭据）——appserver live run 面跳过");
      return;
    }
    const engine = new ZcodeEngine({
      engineDataDir: () => "/tmp/zcode-conformance-live-appserver",
    });
    const events: AgentEvent[] = [];
    const { outcome } = await engine.run(
      { prompt: "Reply with the single word: ok", description: "live-appserver-c2", model, cwd: "/tmp" },
      { taskId: "sa-live-zcode-appserver", poolKey: "", onEvent: (e) => events.push(e) },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.content.trim().length).toBeGreaterThan(0);
    expect(outcome.sessionId).toMatch(/^sess_/);
    assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });
    await engine.dispose().catch(() => undefined);
  }, 180_000);
});

// ── relay 变体（E 方案 §2.3：同一契约 × 不同 spawn 通道，手动门内的手动门）──
//
// W10 协议化：relay env 由引擎 CLI 子进程消费（pi 包 spawn-runner 的 relay ctx
// rewrite）；本变体经 EngineClient baseEnv 注入 relay 三 env + 测试内伪 runtime，
// 断言 C2/C3 经代理转发的全等。前置：ENGINE_CONFORMANCE_LIVE=1 + PI_LIVE_MODEL。

describe.skipIf(!LIVE)("conformance relay 变体（协议客户端 × relay 代理 spawn，手动门）", () => {
  /** 伪 runtime：按 E-2 协议扮演 runtime 侧——握手 accept + spawn 真实 pi + 双向转发 + exit 传播。 */
  function startFakeRuntime(socketPath: string): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((conn) => {
        let lineBuf = "";
        let pi: ChildProcess | null = null;
        const send = (frame: Record<string, unknown>): void => {
          conn.write(`${JSON.stringify(frame)}\n`);
        };
        const handleLine = (line: string): void => {
          let frame: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(line);
            if (typeof parsed !== "object" || parsed === null) return;
            frame = parsed as Record<string, unknown>;
          } catch {
            return;
          }
          if (frame.kind === "handshake" && pi === null) {
            // 按 E-2 协议回 accept，随后按握手帧 spawn 真实 pi（直连——本进程 env 已带
            // relay 三 env，必须 relay:false 防二次代理死循环）；env 剥离 relay 五键
            //（对齐 E-2 registry 剥离逻辑，防孙进程嵌套 relay 时旧值误导）。
            send({ v: RELAY_PROTOCOL_VERSION, kind: "accept" });
            const argv = Array.isArray(frame.argv) ? (frame.argv as string[]) : [];
            // 直连 spawn 真实 pi：不用 getPiInvocation——本进程是 vitest worker，
            // argv[1] 是 vitest 自身脚本，分支 1 会镜像出「node <vitest> <pi args>」
            // 的错误启动。与引擎 CLI 的分支 3 同语义：PATH 解析 pi。
            const invocation = { command: "pi", args: argv };
            const env: NodeJS.ProcessEnv = { ...(frame.env as NodeJS.ProcessEnv) };
            for (const key of [RELAY_ENV_SOCKET, RELAY_ENV_NODE, RELAY_ENV_SCRIPT, RELAY_ENV_SESSION_ID, RELAY_ENV_RECORD_ID]) {
              delete env[key];
            }
            pi = childSpawn(invocation.command, invocation.args, {
              env,
              cwd: typeof frame.cwd === "string" ? frame.cwd : undefined,
              stdio: ["pipe", "pipe", "pipe"],
            });
            pi.stdout?.on("data", (c: Buffer) => {
              send({ v: RELAY_PROTOCOL_VERSION, kind: "data", dir: "up", b64: c.toString("base64") });
            });
            pi.stderr?.on("data", (c: Buffer) => {
              if (process.env["RELAY_DEBUG_STDERR"] === "1") console.error("[fake-runtime pi stderr]", c.toString());
              send({ v: RELAY_PROTOCOL_VERSION, kind: "data", dir: "up-stderr", b64: c.toString("base64") });
            });
            pi.on("close", (code, signal) => {
              send(signal !== null ? { kind: "exit", signal } : { kind: "exit", code: code ?? 1 });
            });
            return;
          }
          if (frame.kind === "data" && frame.dir === "down" && typeof frame.b64 === "string") {
            pi?.stdin?.write(Buffer.from(frame.b64, "base64"));
          }
        };
        conn.setEncoding("utf8");
        conn.on("data", (chunk: string) => {
          lineBuf += chunk;
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl);
            lineBuf = lineBuf.slice(nl + 1);
            if (line.trim()) handleLine(line);
          }
        });
        // 断连即杀（对齐 E-2 registry 语义）——防代理死/测试收尾后真实 pi 变孤儿
        conn.on("close", () => {
          if (pi !== null && !pi.killed) pi.kill("SIGTERM");
        });
      });
      server.once("error", reject);
      server.listen(socketPath, () => resolve(server));
    });
  }

  it("pi × relay：伪 runtime 环回全链（C2 outcome 无 error + C3 事件不变量经代理转发全等）", { timeout: 180_000 }, async (testCtx) => {
    const model = process.env["PI_LIVE_MODEL"];
    if (model === undefined || model === "") {
      testCtx.skip("PI_LIVE_MODEL 未设置（relay 变体与直连 live 用例共享凭据前置）");
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conformance-live-"));
    const socketPath = path.join(tmpDir, "relay.sock");
    const server = await startFakeRuntime(socketPath);
    try {
      // relay 三键注入的是引擎子进程 baseEnv（不是测试进程自身的 process.env）——
      // 激活校验对 baseEnv 做（曾误查 process.env 恒 false，前置断言自爆）。
      const relayBaseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        [RELAY_ENV_SOCKET]: socketPath,
        [RELAY_ENV_NODE]: process.execPath,
        // relay.mjs 权威源在 subagent-workflow 扩展包内（runtime 经 staged 布局消费，
        // bundle-extensions.mjs 拷到 electron resources——测试直连源文件）。曾错指
        // subagent-core/src/relay/relay.mjs（不存在）→ relay 子进程即退 code 1。
        [RELAY_ENV_SCRIPT]: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../../../../../../extensions/universal/subagent-workflow/relay/relay.mjs",
        ),
      };
      if (!isRelayActive(relayBaseEnv)) {
        throw new Error("relay env 自构后仍不激活——前置断言失败");
      }
      const client = new EngineClient({
        engineId: "pi",
        command: process.execPath,
        args: [PI_CLI_ENTRY, "--no-extensions"],
        hostKind: "test",
        hostVersion: "w10-live-relay",
        dataDir: tmpDir,
        envPrefixes: [],
        baseEnv: relayBaseEnv,
        // 归属身份（L0 identityEnv 通道）：协议 v1 ctx 无 sessionRootId 字段，引擎侧
        // buildChildEnv 缺省回落 PI_SUBAGENT_ROOT_SESSION_ID——伪 runtime 场景由测试
        // 显式提供（模拟宿主注入根 session 身份）。
        identityEnv: { PI_SUBAGENT_ROOT_SESSION_ID: "sess-w10-live-relay-probe" },
      });
      const engine = new RemoteEngine({
        engineId: "pi",
        client,
        manifest: { capabilities: PI_LIVE_CAPABILITIES },
        dataDir: tmpDir,
        hostKind: "test",
      });
      const events: AgentEvent[] = [];
      const task = { prompt: "Reply with the single word: ok", description: "live-relay-c2", model, cwd: os.tmpdir() };
      const ctx: RunContext = {
        taskId: "sa-live-pi-relay",
        poolKey: "shared",
        onEvent: (event) => events.push(event),
      };
      const { outcome } = await engine.run(task, ctx);
      // C2：outcome 无 error + engineId 仍为 pi（relay 是 spawn 通道不是引擎身份）
      expect(outcome.error).toBeUndefined();
      expect(outcome.content.trim().length).toBeGreaterThan(0);
      expect(outcome.engineId).toBe("pi");
      // C3：事件不变量五条对「经代理转发的子进程 stdout」逐一成立
      assertAgentEventInvariants(events, { granularity: "stream", content: outcome.content });
      await engine.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
