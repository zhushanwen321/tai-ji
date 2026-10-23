// contract.abort.test.ts —— conformance C4（abort 行为）：运行中 cancel → 引擎
// 3s 窗口内收敛终态、无悬挂 promise、错误语义结构化。
//
// W10 协议黑盒化：断言对象从内建 ZcodeEngine × fake app-server（inproc，W11 删除）
// 改为 RemoteEngine × fake 引擎 CLI——abort 走协议 cancel 帧 + 引擎收敛应答
// （杀链升级路径 = W2 EngineClient 套件 3s 收敛窗口用例）。zcode app-server 的
// stop 优雅链随 W5 归 zcode-subagent-cli 引擎内测试。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentCallOpts } from "../../../../orchestration/models/types.ts";
import { EngineClient } from "../../client/engine-client.ts";
import { RemoteEngine } from "../../client/remote-engine.ts";
import type { RunContext } from "../../port.ts";
import type { AgentEvent } from "../../types.ts";
import { FAKE_CAPABILITIES } from "./fake-engine-capabilities.ts";

const FAKE_ENGINE = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__", "engine-protocol", "fake-engine-protocol.mjs",
);
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__", "engine-protocol", "smoke-run.fixture.json",
);

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w10-c4-abort-"));
  // [session-store-layout-inversion] 协议 run 的 wire sessionDir 经
  // getSubagentSessionDir(ctx.sessionRootId)（env dataDir 兜底）推导——stubEnv 把
  // 推导落点收进本 mkdtemp 目录（自建自删红线）。
  process.env["TAIJI_AGENT_DATA_DIR"] = dataDir;
});

afterEach(() => {
  delete process.env["TAIJI_AGENT_DATA_DIR"];
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeEngine(): { engine: RemoteEngine; client: EngineClient; dispose: () => Promise<void> } {
  const client = new EngineClient({
    engineId: "fake",
    command: process.execPath,
    args: [FAKE_ENGINE],
    hostKind: "test",
    hostVersion: "w10-c4-abort",
    dataDir,
    envPrefixes: [],
    baseEnv: { ...process.env, FAKE_PROTOCOL_FIXTURE: FIXTURE, FAKE_RUN_HANG: "1" },
  });
  const engine = new RemoteEngine({
    engineId: "fake",
    client,
    manifest: { capabilities: FAKE_CAPABILITIES },
    dataDir,
    hostKind: "test",
  });
  return { engine, client, dispose: () => engine.dispose() };
}

describe("conformance C4：abort 行为（协议黑盒：cancel 帧 + 引擎收敛）", () => {
  it("挂起 run 中 abort → cancel 帧送达 → 引擎窗口内收敛终态，run 正常 resolve（不悬挂）", async () => {
    const { engine, client, dispose } = makeEngine();
    try {
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const ctx: RunContext = {
        taskId: "w10-c4-abort",
        // [session-store-layout-inversion] 派发器在 active session 内注入
        // sessionRootId（wire sessionDir 分区键的编排层权威源）——conformance 黑盒
        // 同契约注入；缺席时 buildRunParams fail-fast（host 无 env 绑定形态）。
        sessionRootId: "sid-c4-abort",
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      };
      const task: AgentCallOpts = {
        prompt: "hang",
        description: "abort-protocol",
        model: "fake/fake-1",
        cwd: dataDir,
      };
      // 推进到 run 受理再 abort——abort 先于受理会走 pre-aborted 短路面（cancel 帧
      // 先于 run 帧写入，覆盖不到 cancel 收敛），确定性推进两步：
      // ① 预建连接（真实信号：spawn + initialize 握手完成）；
      await client.ensureConnected(ctx.sessionRootId !== undefined ? { rootSessionId: ctx.sessionRootId } : undefined);
      const runP = engine.run(task, ctx);
      // ② 跨一个宏任务边沿再 abort。连接就绪后 run() 的「ensureConnected 幂等返回 →
      // wireAbortSignal 注册 → run 帧同步写入」全链是纯微任务，宏任务边沿构造性保证
      // run 帧已写入 stdin；同一 stdio FIFO 保序 → 引擎必先受理挂起再收 cancel
      //（顺序契约保证，零时长余量——CPU 忙只推迟连接建立，不改写帧顺序）。
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      const { outcome } = await runP; // 必须正常 resolve（引擎收敛，无需杀链）

      expect(outcome.exitCode).toBeNull();
      expect(outcome.error).toContain("cancelled");
    } finally {
      await dispose();
    }
  }, 20_000);
});
