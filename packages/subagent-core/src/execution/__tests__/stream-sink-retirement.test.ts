// src/execution/__tests__/stream-sink-retirement.test.ts
//
// widget 私货通道退役步骤 2（E 方案 §6.3）测试，两层：
//   判定层：createBackgroundStream 真实函数（vi.importActual 绕过文件级 mock）——
//   gui+relay 激活不创建；tui / relay 未激活 / headless 原样创建；sink=null 恒降级。
//   接线层：SubagentService.execute（background → kickOffChatRound 同步段）透传
//   mode/streamSink 给工厂——mode 传错 = 判定失效，故接线面必须锁定。
//
// spawn 层 mock（FakeChild），与 nested-visibility-env-propagation.test.ts 同模式。

import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mock modules ──

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  class FakeChild extends EventEmitter {
    pid = 12345;
    stdout = new PassThrough();
    stdin = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    killSignal: string | undefined;
    kill(sig?: string): boolean {
      this.killed = true;
      this.killSignal = sig;
      return true;
    }
  }

  return {
    spawn: vi.fn(() => new FakeChild()),
    execFile: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout?: string, stderr?: string) => void,
      ) => cb(new Error("execFile not configured in this test")),
    ),
  };
});

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    promises: actual.promises,
  };
});

// 接线层观测点：工厂调用记录（参数透传断言用）。返回 stub 形状满足消费面
// （session-runner onDelta / subagent-service dispose）。判定层走 vi.importActual。
vi.mock("../stream-sink.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stream-sink.ts")>();
  return {
    ...actual,
    createBackgroundStream: vi.fn((recordId: string) => ({
      onDelta: () => {},
      dispose: () => {},
      recordId,
    })),
  };
});

vi.mock("../alive-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../alive-store.ts")>();
  return {
    ...actual,
    writeAliveMarker: vi.fn(),
    removeAliveMarker: vi.fn(),
  };
});

vi.mock("../state-marker.ts", () => ({
  writeFinalizedState: vi.fn(),
  writeCancelledState: vi.fn(),
  readStateMarker: vi.fn(() => undefined),
  statStateStamp: vi.fn(() => null),
  STATE_SIDECAR_EXT: ".state",
}));

vi.mock("../manifest-store.ts", () => {
  class FakeManifestStore {
    writeManifest = vi.fn(async () => {});
    readManifest = vi.fn(async () => null);
    listAllSync = vi.fn(() => []);
    sweepTmpFiles = vi.fn(async () => 0);
  }
  return { ManifestStore: vi.fn(function (_recordsDir: string) { return new FakeManifestStore(); }) };
});

import { spawn } from "node:child_process";

import { ModelConfigService } from "../model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../model-resolver.ts";
import { RELAY_ENV_NODE, RELAY_ENV_SCRIPT, RELAY_ENV_SOCKET } from "@zhushanwen/subagent-engine-sdk";
import { SubagentService } from "../subagent-service.ts";
import { createBackgroundStream } from "../stream-sink.ts";
import type { ExtensionMode } from "../host-mode.ts";

const mockSpawn = vi.mocked(spawn);
const mockCreateStream = vi.mocked(createBackgroundStream);

interface FakeChild {
  pid: number;
  stdout: PassThrough;
  emit(event: string, ...args: unknown[]): boolean;
}

const RELAY_ENV_KEYS = [RELAY_ENV_SOCKET, RELAY_ENV_NODE, RELAY_ENV_SCRIPT] as const;

/** relay 激活三 env 齐备输入（判定矩阵共用）。 */
const RELAY_ON: Record<string, string> = {
  [RELAY_ENV_SOCKET]: "/tmp/retire.sock",
  [RELAY_ENV_NODE]: "/usr/bin/node",
  [RELAY_ENV_SCRIPT]: "/opt/relay.mjs",
};

function lastSpawnedChild(): FakeChild {
  const result = mockSpawn.mock.results.at(-1);
  if (!result) throw new Error("spawn was not called yet");
  return result.value as FakeChild;
}

function makeEmptyRegistry(): ModelRegistryLike {
  return { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => true };
}

function makePi() {
  return { sendMessage: vi.fn(), appendEntry: vi.fn(), events: { emit: vi.fn() } };
}

const ctxModel: ModelInfo = { id: "m", name: "M", provider: "p", reasoning: false };

function setupService(mode: ExtensionMode | undefined, sessionId = "retire-it"): SubagentService {
  const agentDir = "/tmp/stream-retire-it";
  const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
  modelService.initModel({
    modelRegistry: makeEmptyRegistry(),
    sessionId,
    ctxModel,
  });
  const service = new SubagentService({
    cwd: agentDir,
    modelService,
    getMainSessionFile: () => "/mock/main-session.jsonl",
  });
  service.initSession({
    pi: makePi(),
    sessionId,
    mode,
    streamSink: { setWidget: vi.fn() },
  });
  return service;
}

/** 等 kickOffChatRound 的 detached 轮次执行走到 spawn（stream 创建先于此）。 */
async function waitForSpawnCall(): Promise<void> {
  const baseline = mockSpawn.mock.calls.length;
  const deadline = Date.now() + 2000;
  while (mockSpawn.mock.calls.length <= baseline) {
    if (Date.now() > deadline) throw new Error("spawn was not called within 2000ms");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function executeBackground(service: SubagentService): Promise<void> {
  await service.execute({ task: "retire test", slug: "test", ctxModel });
  await waitForSpawnCall();
  // 推进 detached runSpawn 收尾（FakeChild close），防句柄悬挂干扰后续用例
  lastSpawnedChild().emit("close", 0);
}

// ── 判定层：createBackgroundStream 真实函数（vi.importActual 绕过文件级 mock）──

describe("退役步骤 2 判定层：createBackgroundStream", () => {
  const sink = { setWidget: vi.fn() };

  it("gui（mode=rpc）+ relay 激活 → 不创建（tee 供数，widget 私货停发）", async () => {
    const actual = await vi.importActual<typeof import("../stream-sink.ts")>("../stream-sink.ts");
    expect(actual.createBackgroundStream("rec-1", sink, "rpc", RELAY_ON)).toBeUndefined();
  });

  it("tui（mode=tui）+ relay 激活 → 原样创建（TUI widget 行是终端用户的实时预览）", async () => {
    const actual = await vi.importActual<typeof import("../stream-sink.ts")>("../stream-sink.ts");
    const stream = actual.createBackgroundStream("rec-1", sink, "tui", RELAY_ON);
    expect(stream).toBeInstanceOf(actual.SubagentStream);
    stream?.dispose();
    expect(sink.setWidget).toHaveBeenCalledWith(`subagent-stream-rec-1`, undefined);
  });

  it("gui + relay 未激活 → 原样创建（现状路径，独立 pi / 无 runtime 环境零回归）", async () => {
    const actual = await vi.importActual<typeof import("../stream-sink.ts")>("../stream-sink.ts");
    const stream = actual.createBackgroundStream("rec-1", sink, "rpc", {});
    expect(stream).toBeInstanceOf(actual.SubagentStream);
    stream?.dispose();
  });

  it("headless（mode 未穿透）+ relay 激活 → 原样创建（抑制条件精确等于 gui，不扩大面）", async () => {
    const actual = await vi.importActual<typeof import("../stream-sink.ts")>("../stream-sink.ts");
    const stream = actual.createBackgroundStream("rec-1", sink, undefined, RELAY_ON);
    expect(stream).toBeInstanceOf(actual.SubagentStream);
    stream?.dispose();
  });

  it("sink=null 恒不创建（session_start 未注入降级，与退役判定正交）", async () => {
    const actual = await vi.importActual<typeof import("../stream-sink.ts")>("../stream-sink.ts");
    expect(actual.createBackgroundStream("rec-1", null, "tui", {})).toBeUndefined();
    expect(actual.createBackgroundStream("rec-1", null, "rpc", RELAY_ON)).toBeUndefined();
  });
});

// ── 接线层：service → 工厂的参数透传（mode 传错 = 判定失效）──
// [W3 改写] 驱动方式从 inproc spawn（FakeChild close）改为协议 seam
//（registerFakePiEngine 替身）——kickOffChatRound 的 stream 创建先于 pool acquire，
// 替身 run 挂起即可观察工厂入参。
import { registerFakePiEngine } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";

describe("退役步骤 2 接线层：kickOffChatRound 透传 mode/sink 给工厂", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of RELAY_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of RELAY_ENV_KEYS) delete process.env[key];
    clearEngines();
    vi.restoreAllMocks();
  });

  it.each<[string, ExtensionMode | undefined]>([
    ["rpc", "rpc"],
    ["tui", "tui"],
    ["undefined（headless）", undefined],
  ])("mode=%s：工厂收到 initSession 注入的 mode 与 streamSink", async (_label, mode) => {
    clearEngines();
    registerFakePiEngine();
    const service = setupService(mode);
    await service.execute({ task: "retire test", slug: "test", ctxModel, conversation: true });
    await vi.waitFor(() => expect(mockCreateStream).toHaveBeenCalledTimes(1));
    const [recordId, sinkArg, modeArg] = mockCreateStream.mock.calls[0]!;
    expect(typeof recordId).toBe("string");
    expect(sinkArg).toHaveProperty("setWidget");
    expect(modeArg).toBe(mode);
  });
});
