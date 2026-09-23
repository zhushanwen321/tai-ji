// src/execution/engine/__tests__/reverse-router-slot-read.test.ts
//
// [D3] reverse-router host/askUser 槽现读断言（skill-reload-nondestructive B0）：
// EngineClient 构造后更新 host-ui-endpoint 槽 → 反向请求必须路由到新 handler。
// 生产背景：cli 引擎单例跨 reload 存活（registry D2b 幂等重注册不 dispose），
// post-reload adoption 只更新槽、不重建 EngineClient——若 reverse-router 在构造期
// 固化应答端（旧 uiRequestHandler 传参形态），在飞 run 的 ask_user 会路由到旧 ctx
// 的 handler（assertActive 抛错 → {cancelled:true} 静默取消）。本套件用真实
// fake-engine 子进程链路锁死「消费时现读」语义。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineClient } from "../client/engine-client.ts";
import {
  _resetHostUiRequestEndpointForTest,
  setHostUiRequestEndpoint,
} from "../host/host-ui-endpoint.ts";

const FAKE_ENGINE = fileURLToPath(
  new URL("../client/__tests__/__fixtures__/fake-engine.mjs", import.meta.url),
);

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "d3-slot-read-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  _resetHostUiRequestEndpointForTest();
});

interface RunOutcome {
  events: Array<{ type: string; message?: string }>;
}

/** 跑一个含单次 askUser 的 run，收集引擎 echo 的应答 event。 */
async function runAskUser(
  client: EngineClient,
  runId: string,
  request: { method: string; id: string },
): Promise<RunOutcome> {
  const events: Array<{ type: string; message?: string }> = [];
  const unregister = client.registerRunRoute(runId, {
    onEvent: (e) => {
      events.push(e as { type: string; message?: string });
    },
  });
  try {
    await client.ensureConnected();
    await client.request("run", {
      runId,
      task: { prompt: "p" },
      ctx: { poolKey: "shared", cwd: dataDir },
    });
  } finally {
    unregister();
  }
  return { events };
}

function askUserEcho(outcome: RunOutcome): string | undefined {
  return outcome.events
    .find((e) => e.message?.startsWith("askUser-result:"))
    ?.message;
}

describe("D3：reverse-router host/askUser 槽现读（构造期固化已消除）", () => {
  it("EngineClient 构造后登记应答端 → 反向请求路由到该 handler（构造期无固化面）", async () => {
    // 构造时槽为空——旧行为（构造期固化 uiRequestHandler）会把 undefined 固化进
    // reverseRouterDeps，本 run 将收 {unsupported:true}；现读语义下应正常应答。
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "askUser", request: { method: "select", id: "q1" } }]),
      ],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    try {
      const seen: string[] = [];
      setHostUiRequestEndpoint(async (req) => {
        seen.push(req.id);
        return { value: "late-registered" };
      });
      const outcome = await runAskUser(client, "run-1", { method: "select", id: "q1" });
      expect(seen).toEqual(["q1"]);
      expect(askUserEcho(outcome)).toContain('"value":"late-registered"');
    } finally {
      await client.dispose();
    }
  });

  it("同一 EngineClient 存活期换槽（adoption 形态）→ 后续反向请求路由到新 handler", async () => {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [
        FAKE_ENGINE,
        "--run-actions",
        // fake-engine 串行播放且 askUser 等应答才继续——两个 askUser 之间隔着一次
        // 真实 IO 往返，宿主在第一应答前换槽零竞态
        JSON.stringify([
          { op: "askUser", request: { method: "select", id: "q-old" } },
          { op: "askUser", request: { method: "confirm", id: "q-new" } },
        ]),
      ],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    try {
      const answeredBy: Array<{ id: string; handler: string }> = [];
      // 旧 handler（模拟 reload 前的 ctx 应答端）：应答第一次请求，并在应答内换槽
      // ——等价生产 adoption 只更新槽、不重建 EngineClient 的形态
      setHostUiRequestEndpoint(async (req) => {
        answeredBy.push({ id: req.id, handler: "old" });
        setHostUiRequestEndpoint(async (req2) => {
          answeredBy.push({ id: req2.id, handler: "new" });
          return { value: "answer-after-adoption" };
        });
        return { value: "answer-before-reload" };
      });
      const events: Array<{ type: string; message?: string }> = [];
      const unregister = client.registerRunRoute("run-1", {
        onEvent: (e) => {
          events.push(e as { type: string; message?: string });
        },
      });
      try {
        await client.ensureConnected();
        await client.request("run", {
          runId: "run-1",
          task: { prompt: "p" },
          ctx: { poolKey: "shared", cwd: dataDir },
        });
      } finally {
        unregister();
      }
      expect(answeredBy).toEqual([
        { id: "q-old", handler: "old" },
        { id: "q-new", handler: "new" }, // 槽更新对已构造单例可见 = 现读语义
      ]);
      const echoes = events
        .filter((e) => e.message?.startsWith("askUser-result:"))
        .map((e) => e.message);
      expect(echoes[0]).toContain('"value":"answer-before-reload"');
      expect(echoes[1]).toContain('"value":"answer-after-adoption"');
    } finally {
      await client.dispose();
    }
  });

  it("窗口内旧 handler 抛 assertActive（reload 间隙形态）→ 降级 {cancelled:true}，不崩不误报 unsupported", async () => {
    // 设计 §5 单测面清单项（D3 检查点补全）：reload 窗口内（invalidate → adoption 完成）
    // 槽上仍是旧 ctx 的 handler，其应答链触碰旧 pi 命中 assertActive——结构性 catch
    // 须把该形态降级为 {cancelled:true}（dialog-queue 应答链同款语义）：引擎侧收到
    // cancelled 后子进程可继续推进（非死锁、非崩溃），warn 留痕供归因。
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "askUser", request: { method: "select", id: "q-stale" } }]),
      ],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
    });
    try {
      setHostUiRequestEndpoint(async () => {
        throw new Error("session context is no longer active (assertActive)");
      });
      const outcome = await runAskUser(client, "run-1", { method: "select", id: "q-stale" });
      // 引擎 echo 的应答形态必须是 cancelled（unsupported = 槽空形态；崩 = 无 echo）
      expect(askUserEcho(outcome)).toContain('"cancelled":true');
    } finally {
      await client.dispose();
    }
  });
});
