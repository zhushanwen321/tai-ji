// protocol-blackbox.test.ts —— W10 协议黑盒套件（基线三层①的自动层）。
//
// 覆盖（impl-plan §2.10 / 设计 §4 探针挂钩①）：
//   - 9 正向方法（initialize/probe/run/cancel/read/listModels/
//     validateModel/dispose/ping）× fake 引擎 CLI 往返；
//   - 8 反向通道（host/log、host/askUser、host/permission、host/streamDelta、
//     host/poolResolved、host/handleReady、host/childSpawned、host/childStateChanged）
//     的 core 侧到达断言；
//   - 错误帧：run 失败帧 / 未知方法帧（码原样透传）/ initialize 版本越界
//     （engine_protocol_mismatch → 客户端直接不可用，不重建）；
//   - fixture 回放结构等价：事件类型序列 / 顺序 / seq 单调 / 字段白名单逐字段比对
//     （排除 text_delta 文本内容等不可复现字段——设计 §4 基线三层①）+ journal 往返
//     保真 + assertAgentEventInvariants；
//   - POSIX 组探测（R9-4/A3 前提）：childSpawned 上报的 pid 做 kill(-pid, 0)，
//     不在同组即告警——本套件验证探测通路；Windows 无外部判据，仅 SDK 层保证
//     （显式登记，见文件末 describe 与 deviations）。
//
// 措辞统一（R9-1）：「子进程零残留」一律指一代子进程 + 组内后代；引擎自身
// detached 后代不判 fail（设计 §3.9 已接受代价）。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EngineClient } from "../../client/engine-client.ts";
import type { MirrorChangeEvent } from "../../client/mirror.ts";
import { JournalWriter, replayJournal } from "../../common/event-journal.ts";
import type { AgentEvent } from "../../../types.ts";
import { assertAgentEventInvariants } from "./agent-event-invariants.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "engine-protocol");
const FAKE_ENGINE = join(FIXTURE_DIR, "fake-engine-protocol.mjs");
const FIXTURE = join(FIXTURE_DIR, "smoke-run.fixture.json");

/** fixture 的白名单可比形态（record:engine-fixtures 产物 schema v1）。 */
interface EngineProtocolFixture {
  schemaVersion: number;
  engineId: string;
  protocolVersion: number;
  run: {
    params: { runId: string; ctx: Record<string, unknown> };
    result: { handle: Record<string, unknown>; outcome: Record<string, unknown> };
  };
  events: Array<{ type: string }>;
}

const fixture: EngineProtocolFixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
if (fixture.schemaVersion !== 1) {
  throw new Error(`unsupported fixture schemaVersion ${String(fixture.schemaVersion)}`);
}

/** AgentEvent 字段白名单（结构等价比对的逐字段面；text_delta.delta 内容显式排除）。 */
const FIELD_WHITELIST: Record<string, readonly string[]> = {
  text_delta: ["type", "delta"],
  message_end: ["type", "usage"],
  turn_end: ["type", "usage"],
  error: ["type", "message"],
  tool_start: ["type", "toolName", "input"],
  tool_end: ["type", "toolName", "output", "isError"],
};

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "w10-engine-protocol-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface Harness {
  client: EngineClient;
  events: AgentEvent[];
  mirrorEvents: MirrorChangeEvent[];
  logs: Array<{ level: string; message: string }>;
  askUserRequests: unknown[];
  permissionRequests: unknown[];
  streamDeltas: string[];
  poolResolved: string[];
  handleReady: Array<{ sessionRef: Record<string, string>; poolKey: string }>;
}

function makeHarness(extraEnv: Record<string, string> = {}, routeRunId = fixture.run.params.runId): Harness {
  const h: Harness = {
    client: undefined as unknown as EngineClient,
    events: [],
    mirrorEvents: [],
    logs: [],
    askUserRequests: [],
    permissionRequests: [],
    streamDeltas: [],
    poolResolved: [],
    handleReady: [],
  };
  h.client = new EngineClient({
    engineId: fixture.engineId,
    command: process.execPath,
    args: [FAKE_ENGINE],
    hostKind: "test",
    hostVersion: "w10-protocol-blackbox",
    dataDir,
    envPrefixes: [],
    log: (p) => h.logs.push({ level: p.level, message: p.message }),
    uiRequestHandler: async (req) => {
      h.askUserRequests.push(req);
      return { value: "option-a" };
    },
    permissionHandler: async (params) => {
      h.permissionRequests.push(params);
      return { approved: true };
    },
    onMirrorChanged: (event) => h.mirrorEvents.push(event),
    baseEnv: {
      ...process.env,
      FAKE_PROTOCOL_FIXTURE: FIXTURE,
      ...extraEnv,
    },
  });
  const unregister = h.client.registerRunRoute(routeRunId, {
    onEvent: (event) => {
      h.events.push(event as AgentEvent);
    },
    onStreamDelta: (delta) => {
      h.streamDeltas.push(delta);
    },
    onPoolResolved: (poolKey) => {
      h.poolResolved.push(poolKey);
    },
    onHandleReady: (partial) => {
      h.handleReady.push(partial);
    },
  });
  void unregister;
  return h;
}

describe("协议黑盒：9 正向方法 × fake 引擎回放", () => {
  it("initialize/probe/listModels/validateModel/read/ping 往返（fixture 白名单比对）", async () => {
    const h = makeHarness();
    try {
      await h.client.ensureConnected();
      expect(h.client.currentState).toBe("ready");

      const probe = (await h.client.request("probe", {}, { timeoutMs: 5_000 })) as {
        ok: boolean; checks: Array<{ name: string; ok: boolean }>;
      };
      expect(probe.ok).toBe(true);
      expect(probe.checks.every((c) => typeof c.name === "string" && typeof c.ok === "boolean")).toBe(true);

      const models = (await h.client.request("listModels", {}, { timeoutMs: 5_000 })) as {
        models: Array<{ id: string }>;
      };
      expect(models.models.map((m) => m.id)).toEqual(["fake-1"]);

      const validated = (await h.client.request(
        "validateModel",
        { modelRef: "fake/fake-1" },
        { timeoutMs: 5_000 },
      )) as { canonicalRef: string };
      expect(validated.canonicalRef).toBe("fake/fake-1");

      // [H1 U5] interact 方法已随 chat-run 统一退役（D5）——往返断言随之删除，
      // fake 引擎对未知方法回 engine_method_unknown（unknown_method 模式覆盖）。

      const view = (await h.client.request(
        "read",
        { handle: fixture.run.result.handle, dataDir },
        { timeoutMs: 5_000 },
      )) as { entries: unknown[] };
      expect(Array.isArray(view.entries)).toBe(true);

      await h.client.ping(); // 诊断面：不 throw 即通
    } finally {
      await h.client.dispose();
    }
  });

  it("run：终态应答 handle+outcome 与 fixture 白名单逐字段一致", async () => {
    const h = makeHarness();
    try {
      await h.client.ensureConnected();
      const result = (await h.client.request("run", fixture.run.params)) as {
        handle: Record<string, unknown>;
        outcome: Record<string, unknown>;
      };
      expect(result.handle).toEqual(fixture.run.result.handle);
      expect(result.outcome).toEqual(fixture.run.result.outcome);
    } finally {
      await h.client.dispose();
    }
  });

  it("cancel：受理应答（收敛语义由 W2 client 套件的 3s 窗口用例覆盖，此处断言帧往返）", async () => {
    const h = makeHarness();
    try {
      await h.client.ensureConnected();
      const ack = (await h.client.request(
        "cancel",
        { runId: "run-smoke-1", reason: "test" },
        { timeoutMs: 5_000 },
      )) as { ok: boolean };
      expect(ack.ok).toBe(true);
    } finally {
      await h.client.dispose();
    }
  });

  it("dispose：幂等收口（应答 ok + 进程退出）", async () => {
    const h = makeHarness();
    await h.client.ensureConnected();
    const r = (await h.client.request("dispose", {}, { timeoutMs: 5_000 })) as { ok: boolean };
    expect(r.ok).toBe(true);
    await h.client.dispose();
    await expect(h.client.dispose()).resolves.toBeUndefined();
  });
});

describe("协议黑盒：8 反向通道 core 侧到达", () => {
  it("run 期间全部 8 通道到达并被正确路由", async () => {
    const h = makeHarness();
    try {
      await h.client.ensureConnected();
      await h.client.request("run", fixture.run.params);

      // host/log
      expect(h.logs.some((l) => l.message.includes("run started"))).toBe(true);
      // host/streamDelta
      expect(h.streamDeltas).toEqual(["Hello", " world"]);
      // host/poolResolved
      expect(h.poolResolved).toEqual(["shared"]);
      // host/handleReady
      expect(h.handleReady).toEqual([{ sessionRef: { sessionId: "sess-fixture" }, poolKey: "shared" }]);
      // host/childSpawned + host/childStateChanged（镜像落项 + 状态更新）
      const spawned = h.mirrorEvents.filter((e) => e.reason === "childSpawned");
      expect(spawned).toHaveLength(1);
      expect(typeof spawned[0]?.pid).toBe("number");
      const stateChanged = h.mirrorEvents.filter((e) => e.reason === "childStateChanged");
      expect(stateChanged).toHaveLength(1);
      expect(stateChanged[0]?.recordId).toBe(fixture.run.params.runId);
      // host/askUser + host/permission（交互面 ack 两阶段）
      expect(h.askUserRequests).toHaveLength(1);
      expect(h.permissionRequests).toHaveLength(1);
    } finally {
      await h.client.dispose();
    }
  });
});

describe("协议黑盒：错误帧", () => {
  it("run 失败帧 → EngineSdkError（code/message/recovery 透传）", async () => {
    const h = makeHarness({ FAKE_PROTOCOL_ERROR: "run_failed" });
    try {
      await h.client.ensureConnected();
      await expect(h.client.request("run", fixture.run.params)).rejects.toMatchObject({
        code: "engine_run_failed",
        message: expect.stringContaining("scripted run failure"),
      });
    } finally {
      await h.client.dispose();
    }
  });

  it("未知方法帧 → 错误码原样透传（帧形态权威，非码表枚举）", async () => {
    const h = makeHarness({ FAKE_PROTOCOL_ERROR: "unknown_method" });
    try {
      await h.client.ensureConnected();
      await expect(h.client.request("bogus/method", {}, { timeoutMs: 5_000 })).rejects.toMatchObject({
        code: "engine_method_unknown",
      });
    } finally {
      await h.client.dispose();
    }
  });

  it("initialize 版本越界 → engine_protocol_mismatch + 客户端直接不可用（不重建）", async () => {
    const h = makeHarness({ FAKE_PROTOCOL_VERSION: "99" });
    try {
      await expect(h.client.ensureConnected()).rejects.toMatchObject({ code: "engine_protocol_mismatch" });
      expect(h.client.currentState).toBe("unavailable");
    } finally {
      await h.client.dispose();
    }
  });
});

describe("协议黑盒：fixture 回放结构等价（基线三层①）", () => {
  it("事件类型序列/顺序/seq 单调/字段白名单（排除 text_delta 文本内容）", async () => {
    const h = makeHarness();
    try {
      await h.client.ensureConnected();
      const result = (await h.client.request("run", fixture.run.params)) as {
        outcome: { content: string };
      };

      // ① 类型序列 + 顺序（与 fixture.events 白名单形态逐项一致）
      expect(h.events.map((e) => e.type)).toEqual(fixture.events.map((e) => e.type));

      // ② seq 单调（协议通知帧的 seq 字段经 fake 引擎按 fixture 播放）
      //    ——事件流本身不透传 seq，单调性由通知帧序承担；此处断言到达顺序稳定。

      // ③ 字段白名单：每条事件的实际键 ⊆ 白名单
      for (const event of h.events) {
        const whitelist = FIELD_WHITELIST[event.type];
        expect(whitelist, `missing whitelist for event type ${event.type}`).toBeDefined();
        for (const key of Object.keys(event)) {
          expect(whitelist).toContain(key);
        }
      }

      // ④ 排除项自证：text_delta 文本内容参与流式拼接不变量（3a），但内容本身
      //    不做逐字段 diff（不可复现字段——设计 §4）
      assertAgentEventInvariants(h.events, { granularity: "stream", content: result.outcome.content });

      // ⑤ journal 往返保真（回放层事件落 journal 后重读等价）
      const journalPath = join(dataDir, "blackbox-journal.jsonl");
      const writer = new JournalWriter({
        path: journalPath,
        taskId: "w10-blackbox",
        engineId: fixture.engineId,
      });
      for (const event of h.events) writer.append(event);
      await writer.close();
      const replayed = replayJournal(journalPath) as AgentEvent[];
      expect(replayed.map((e) => e.type)).toEqual(h.events.map((e) => e.type));
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(h.events));
    } finally {
      await h.client.dispose();
    }
  });

  it("录制产物回放校验：recorded.fixture.json（record:engine-fixtures 产物）结构不变量", async () => {
    // 录制/复跑闭环（设计 §4）：录制脚本产物 schemaVersion 1 + 脱敏不变量 +
    // 事件通知 seq 单调 + 反向通道覆盖。真机引擎录制时产物替换本文件即可把同一
    // 套结构断言升格为该引擎的协议层基线（不逐字段 diff 正文）。
    const recorded = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "recorded.fixture.json"), "utf8"),
    ) as {
      schemaVersion: number;
      wire: {
        engineToHost: Array<{ method?: string; params?: { seq?: number; runId?: string } }>;
        hostToEngine: Array<{ id: number | string; method: string }>;
      };
      events: Array<{ type: string }>;
    };
    expect(recorded.schemaVersion).toBe(1);

    // 事件通知 seq 单调（同 runId）
    const seqs = recorded.wire.engineToHost
      .filter((f) => f.method === "event" && typeof f.params?.seq === "number")
      .map((f) => f.params!.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // 反向通道覆盖（录制期间 8 通道全部上线）
    const reverse = new Set(
      recorded.wire.engineToHost
        .filter((f) => typeof (f as { id?: string }).id === "string")
        .map((f) => (f as { method: string }).method),
    );
    for (const ch of [
      "host/log", "host/askUser", "host/permission", "host/streamDelta",
      "host/poolResolved", "host/handleReady", "host/childSpawned", "host/childStateChanged",
    ]) {
      expect(reverse.has(ch)).toBe(true);
    }

    // 结构白名单形态与 curated fixture 同源
    expect(recorded.events).toEqual(fixture.events);
  });

  it("POSIX 组探测：childSpawned 上报 pid 非组长（在引擎收割组内；A3 前提；Windows 显式跳过）", async () => {
    if (process.platform === "win32") {
      // Windows 无外部组判据（无 kill(-pid,0) 等价物）——仅 SDK 层 spawnEngineChild
      // 的 detached/stdio 规约保证，真机面挂 A3 手动门（taskkill /T /F 形态）。
      return;
    }
    const h = makeHarness();
    try {
      await h.client.ensureConnected();
      await h.client.request("run", fixture.run.params);
      const spawned = h.mirrorEvents.find((e) => e.reason === "childSpawned");
      expect(spawned?.pid).toBeDefined();
      // 预期形态（reverse-router 组探测同款语义）：任务子进程与引擎同组（收割 =
      // 引擎组级 kill(-enginePid)）→ 该 pid 非组长 → kill(-pid,0) ESRCH。
      // kill(-pid,0) 成功 = 自成进程组 = 不在收割组内 = 告警面（R9-1 限定：一代
      // 子进程 + 组内后代；引擎自身 detached 后代不判 fail，设计 §3.9 已接受代价）。
      expect(() => process.kill(-spawned!.pid!, 0)).toThrow();
    } finally {
      await h.client.dispose();
    }
  });
});
