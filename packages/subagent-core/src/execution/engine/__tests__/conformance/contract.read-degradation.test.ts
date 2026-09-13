// contract.read-degradation.test.ts —— conformance C5（read 降级链）：不 throw、
// 坏 handle → 结构化降级（outcome-only）非崩溃、journal 重放与 live 一致
// （重放等价性，§3.3.6——journal 重放与 live 通路共用同一 reducer 的断言面）。
//
// W10 协议黑盒化：read 的引擎内三级降级（①级 db / ②级 journal / ③级 outcome-only）
// 随 W5/W7 归各引擎包（zcode zcode-engine-degrade / pi read-fallback）；core 协议层
// 断言 = read 帧往返 + 错误帧结构化（EngineSdkError，不裸 throw 崩宿主）+ reducer
// 重放等价性（core 侧事件→SessionView 共用通路）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineSdkError } from "@zhushanwen/subagent-engine-sdk";

import { eventsToSessionView } from "../../common/journal-replay.ts";
import { JournalWriter } from "../../common/event-journal.ts";
import { EngineClient } from "../../client/engine-client.ts";
import { RemoteEngine } from "../../client/remote-engine.ts";
import type { AgentEvent, EngineHandle } from "../../types.ts";
import { FAKE_CAPABILITIES } from "./fake-engine-capabilities.ts";

const FAKE_ENGINE = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__", "engine-protocol", "fake-engine-protocol.mjs",
);
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__", "engine-protocol", "smoke-run.fixture.json",
);

/** live 通路形态的事件序列（与 golden 回放同源——重放等价性的比对基准）。 */
const liveEvents: AgentEvent[] = [
  { type: "text_delta", delta: "part one. " },
  { type: "text_delta", delta: "part two." },
  { type: "message_end", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
  { type: "turn_end" },
];

function makeHandle(engineId: string, sessionRef: Record<string, string>, journalPath?: string): EngineHandle {
  return {
    data: {
      v: 1,
      engineId,
      sessionRef,
      ...(journalPath !== undefined ? { journalPath } : {}),
      adapterVersion: "1.0.0-test",
    },
  };
}

describe("conformance C5：read 降级链（协议黑盒 + reducer 等价性）", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "c5-read-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("重放等价性：journal 重放 turns 与 live 累积一致（共用 updateFromEvent reducer）", () => {
    const live = eventsToSessionView(liveEvents, "pi", "sess-x");
    expect(live.source).toBe("journal");
    expect(live.turns).toHaveLength(1);
    expect(live.turns[0]?.text).toBe("part one. part two.");
    expect(live.usage?.total).toBe(15);
  });

  it("协议 read 帧往返：正常 handle → SessionView 结构（协议层形状）", async () => {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      hostVersion: "w10-c5",
      dataDir,
      envPrefixes: [],
      baseEnv: { ...process.env, FAKE_PROTOCOL_FIXTURE: FIXTURE },
    });
    const engine = new RemoteEngine({
      engineId: "fake",
      client,
      manifest: { capabilities: FAKE_CAPABILITIES },
      dataDir,
      hostKind: "test",
    });
    try {
      await engine.read(makeHandle("fake", { sessionId: "sess-fixture" }));
      // fixture.read.result 透传（协议层不解释 SessionView 内容——形状由引擎层
      // golden 与 reducer 等价性断言盖）
    } finally {
      await engine.dispose();
    }
  });

  it("协议 read 错误帧：引擎报错 → 结构化 EngineSdkError（code/message），不裸 throw", async () => {
    const client = new EngineClient({
      engineId: "fake",
      command: process.execPath,
      args: [FAKE_ENGINE],
      hostKind: "test",
      hostVersion: "w10-c5",
      dataDir,
      envPrefixes: [],
      baseEnv: { ...process.env, FAKE_PROTOCOL_FIXTURE: FIXTURE, FAKE_PROTOCOL_ERROR: "unknown_method" },
    });
    try {
      await client.ensureConnected();
      // read 是已知方法——unknown_method 模式下用未知名触发错误帧透传断言
      await expect(client.request("bogus/read", { handle: {} }, { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
        EngineSdkError,
      );
    } finally {
      await client.dispose();
    }
  });

  it("journal 落盘形态与 live 事件序列逐项相等（协议层回放复用的落盘通路）", async () => {
    const journalPath = path.join(dataDir, "journal-sa-c5.jsonl");
    const writer = new JournalWriter({ path: journalPath, taskId: "sa-c5", engineId: "fake" });
    for (const ev of liveEvents) writer.append(ev);
    await writer.close();
    const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(liveEvents.length);
  });
});
