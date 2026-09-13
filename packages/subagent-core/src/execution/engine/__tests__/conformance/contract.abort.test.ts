// contract.abort.test.ts —— conformance C4（abort 行为）：运行中 cancel → 引擎
// 3s 窗口内收敛终态、无悬挂 promise、错误语义结构化。
//
// W10 协议黑盒化：断言对象从内建 ZcodeEngine × fake app-server（inproc，W11 删除）
// 改为 RemoteEngine × fake 引擎 CLI——abort 走协议 cancel 帧 + 引擎收敛应答
// （杀链升级面 = W2 EngineClient 套件 3s 收敛窗口用例）。zcode app-server 的
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
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeEngine(): { engine: RemoteEngine; dispose: () => Promise<void> } {
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
  return { engine, dispose: () => engine.dispose() };
}

describe("conformance C4：abort 行为（协议黑盒：cancel 帧 + 引擎收敛）", () => {
  it("挂起 run 中 abort → cancel 帧送达 → 引擎窗口内收敛终态，run 正常 resolve（不悬挂）", async () => {
    const { engine, dispose } = makeEngine();
    try {
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const ctx: RunContext = {
        taskId: "w10-c4-abort",
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      };
      const task: AgentCallOpts = {
        prompt: "hang",
        description: "abort-protocol",
        model: "fake/fake-1",
        cwd: dataDir,
      };
      const runP = engine.run(task, ctx);
      // 推进到 run 受理（fake 引擎进入 hang，poolResolved 反向帧已回）再 abort——
      // abort 先于受理会走 pre-aborted 短路面，覆盖不到 cancel 帧
      await new Promise((r) => setTimeout(r, 300));
      controller.abort();
      const { outcome } = await runP; // 必须正常 resolve（引擎收敛，无需杀链）

      expect(outcome.exitCode).toBeNull();
      expect(outcome.error).toContain("cancelled");
    } finally {
      await dispose();
    }
  }, 20_000);
});
