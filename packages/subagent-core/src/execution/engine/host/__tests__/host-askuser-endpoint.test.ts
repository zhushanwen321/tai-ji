// host/askUser 壳侧应答端集成断言（W6 验收，R3 MF-A / impl-plan §2.6 验收补充）：
// fake 引擎经 host/askUser 反向请求可在 core 壳侧收到应答——链路 = fake-engine CLI
// 帧④ → EngineClient reverse-router（ack 先行，R9-2）→ EngineClientOptions
// .uiRequestHandler 注入点（discovery portFactory 的接线形态：读壳侧登记处）→
// SubagentService init.uiRequestHandler 同源的 handler（[D4-④] 唯一注入入口的
// 协议化投影）。应答复用 dialog-queue 的 UiRequest/UiResponse 形状。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineClient } from "../../client/engine-client.ts";
import {
  _resetHostUiRequestEndpointForTest,
  getHostUiRequestEndpoint,
  setHostUiRequestEndpoint,
} from "../host-ui-endpoint.ts";

const FAKE_ENGINE = fileURLToPath(
  new URL("../../client/__tests__/__fixtures__/fake-engine.mjs", import.meta.url),
);

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w6-host-askuser-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  _resetHostUiRequestEndpointForTest();
});

describe("host/askUser 壳侧应答端（W6 R3 MF-A 集成断言）", () => {
  it("fake 引擎经 host/askUser 反向请求 → 壳侧登记 handler 应答（ack 先行 + 结果异步补帧②）", async () => {
    // ① 壳侧登记（生产 = SubagentService init/initSession.uiRequestHandler 写点同步登记）
    const seenRequests: Array<{ method: string; id: string }> = [];
    setHostUiRequestEndpoint(async (req) => {
      seenRequests.push({ method: req.method, id: req.id });
      return { value: "host-answer" };
    });

    // ② EngineClient 构造（discovery portFactory 同款接线形态：注入点读登记处）
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([
          { op: "askUser", request: { method: "select", id: "q1", title: "pick" } },
        ]),
      ],
      hostKind: "test",
      hostVersion: "test-host-1.0",
      dataDir,
      envPrefixes: [],
      uiRequestHandler: getHostUiRequestEndpoint(),
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
      await client.dispose();
    }

    // ③ 壳侧收到请求（形状 = dialog-queue UiRequest）
    expect(seenRequests).toEqual([{ method: "select", id: "q1" }]);
    // ④ 引擎收到应答（fake-engine 把 host/askUser 应答 echo 成 event；ack 先行语义
    //    由 client/__tests__/engine-client.test.ts 的 ack 两阶段用例锁定）
    const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
    expect(echo?.message).toContain('"value":"host-answer"');
  });

  it("登记处为空（未注入 handler）→ 引擎收 {unsupported:true} 自行降级（不炸链路）", async () => {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [
        FAKE_ENGINE,
        "--run-actions",
        JSON.stringify([{ op: "askUser", request: { method: "confirm", id: "q2" } }]),
      ],
      hostKind: "test",
      dataDir,
      envPrefixes: [],
      uiRequestHandler: getHostUiRequestEndpoint(), // undefined
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
      await client.dispose();
    }
    const echo = events.find((e) => e.message?.startsWith("askUser-result:"));
    expect(echo?.message).toContain('"unsupported":true');
  });
});
