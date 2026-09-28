// src/execution/registry-reconcile/sweep-binding.test.ts
//
// sweep-binding 绑定面直测：runPendingReconcileSweepForService 的 lookupRecordState
// 闭包 subagent 判据（workflow 判据回归钉在 workflow-state-root.test.ts，此处补
// subagent 两方向：活跃 record 不被 sweep 注销 + 终态/missing 差集补发注销）。
//
// 测试纪律：替身 RecordStore/PiLike 驱动（不触真实数据目录）；PI_CODING_AGENT_DIR
// stub 指向 tmp（sweep 内 FileRunStore 构造读侧解析不探测真实 ~/.pi/agent）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PiLike } from "../notify/notify-host.ts";
import { RecordStore } from "../persistence/record-store.ts";
import type { ExecutionRecord, SubagentRecord } from "../assembly/types.ts";
import { runPendingReconcileSweepForService, type ReconcileSweepBinding } from "./sweep-binding.ts";

// ============================================================
// 替身
// ============================================================

type SentMessage = {
  message: { customType: string; content: string; display: boolean };
  options: { deliverAs?: string } | undefined;
};

type TestPi = PiLike & {
  sent: SentMessage[];
  appended: Array<{ customType: string; data: unknown }>;
  emitted: Array<{ channel: string; data: unknown }>;
};

function makePi(): TestPi {
  const sent: SentMessage[] = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    sendMessage: vi.fn((message: SentMessage["message"], options?: SentMessage["options"]) => {
      sent.push({ message, options });
    }),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      appended.push({ customType, data });
    }),
    events: {
      emit: vi.fn((channel: string, data: unknown) => {
        emitted.push({ channel, data });
      }),
    },
    sent,
    appended,
    emitted,
  } as unknown as TestPi;
}

interface StoreHarness { // oe-exempt:20260928:framework:测试替身形状契约——本仓测试 fake 注入常规形态（RecordStore duck-type 面 + 断言用句柄）
  store: RecordStore;
  memory: Map<string, ExecutionRecord>;
  disk: Map<string, SubagentRecord>;
}

/** duck-typed RecordStore 替身（sweep-binding 消费 getMutable / findLightById 两个
 *  读点——真实磁盘发现需 session 文件扫描，与本文件断言面无关）。 */
function makeStore(): StoreHarness {
  const memory = new Map<string, ExecutionRecord>();
  const disk = new Map<string, SubagentRecord>();
  const store = {
    getMutable: (id: string) => memory.get(id),
    findLightById: (id: string) => disk.get(id),
  };
  return { store: store as unknown as RecordStore, memory, disk };
}

interface BindingHarness { // oe-exempt:20260928:framework:测试装配契约——binding/store/pi 三件套打包返回，与既有测试 SetupResult 形态同构
  binding: ReconcileSweepBinding;
  store: StoreHarness;
  pi: ReturnType<typeof makePi> | null;
}

function makeBinding(overrides: {
  store?: StoreHarness;
  pi?: ReturnType<typeof makePi> | null;
  sessionFile?: string;
} = {}): BindingHarness {
  const storeHarness = overrides.store ?? makeStore();
  const pi = overrides.pi === undefined ? makePi() : overrides.pi;
  const binding: ReconcileSweepBinding = {
    getStore: () => storeHarness.store,
    getPi: () => pi,
    getMainSessionFile: () => overrides.sessionFile,
  };
  return { binding, store: storeHarness, pi };
}

/** 内存 ExecutionRecord 替身（字段访问面：id/agent/slug/status/result/
 *  rootSessionId/startedAt/closedReason）。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "bg-1",
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "fix-bug",
    startedAt: Date.now() - 1000,
    status: "running",
    rootSessionId: "root-1",
    turnCount: 3,
    ...overrides,
  } as ExecutionRecord;
}

/** 磁盘 SubagentRecord 替身（findLightById 返回形态，最小字段集）。 */
function makeDiskRecord(sessionFile: string | undefined, overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "bg-disk",
    agent: "worker",
    task: "t",
    slug: "fix-bug",
    status: "running",
    mode: "background",
    startedAt: Date.now() - 2000,
    rootSessionId: "root-1",
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 1,
    totalTokens: 0,
    model: "m",
    eventLog: [],
    displayItems: [],
    sessionFile,
    ...overrides,
  } as unknown as SubagentRecord;
}

// ============================================================
// 测试
// ============================================================

let tmpDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-binding-"));
  sessionFile = path.join(tmpDir, "main-session.jsonl");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("runPendingReconcileSweepForService 的 subagent 判据（lookupRecordState 闭包）", () => {
  /** sweep harness：PI_CODING_AGENT_DIR stub（sweep 内 FileRunStore 读侧解析不触真实目录）。 */
  function setup(): { agentDir: string } {
    const agentDir = path.join(tmpDir, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    return { agentDir };
  }

  function writeRegister(id: string, type: string): void {
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ customType: "pending:register", data: { id, type, name: id } }) + "\n",
      "utf-8",
    );
  }

  it("isChildProcess=true → 空跑（不读 store、不读 session 文件）", () => {
    setup();
    const h = makeBinding({ sessionFile });
    const getMutableSpy = vi.spyOn(h.store.store, "getMutable");
    runPendingReconcileSweepForService(h.binding, true);
    expect(getMutableSpy).not.toHaveBeenCalled();
    expect(h.pi?.appended ?? []).toHaveLength(0);
  });

  it("getMainSessionFile undefined → 空跑（差集输入源缺席，store 零读取）", () => {
    setup();
    const h = makeBinding({});
    const getMutableSpy = vi.spyOn(h.store.store, "getMutable");
    runPendingReconcileSweepForService(h.binding, false);
    expect(getMutableSpy).not.toHaveBeenCalled();
    expect(h.pi?.appended ?? []).toHaveLength(0);
  });

  it("活跃 subagent record（内存 running）→ 不补注销（误注销活跃 record 的回归钉）", () => {
    setup();
    writeRegister("bg-live", "subagent");
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-live", makeRecord({ id: "bg-live" }));
    runPendingReconcileSweepForService(h.binding, false);
    expect(h.pi?.appended ?? []).toHaveLength(0);
    expect(h.pi?.emitted ?? []).toHaveLength(0);
  });

  it("活跃 subagent record（仅磁盘 running）→ 不补注销", () => {
    setup();
    writeRegister("bg-disk", "subagent");
    const h = makeBinding({ sessionFile });
    h.store.disk.set("bg-disk", makeDiskRecord(sessionFile, { id: "bg-disk" }));
    runPendingReconcileSweepForService(h.binding, false);
    expect(h.pi?.appended ?? []).toHaveLength(0);
  });

  it("终态 subagent record（内存 closed，closedReason 有值）→ 差集补发注销（reason 直传 closedReason，status 经 mapReasonToStatus）", () => {
    setup();
    writeRegister("bg-done", "subagent");
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-done", makeRecord({ id: "bg-done", status: "idle", closedReason: "cancelled" }));
    runPendingReconcileSweepForService(h.binding, false);
    expect(h.pi?.appended).toEqual([
      { customType: "pending:unregister", data: { id: "bg-done", reason: "cancelled", status: "cancelled" } },
    ]);
    // [reload-closeout D4] 尽力 emit 已删（恒 no-op 死路径）——注销唯一持久化路径 = appendEntry
    expect(h.pi?.emitted ?? []).toHaveLength(0);
  });

  it("终态 subagent record（磁盘 idle+closedReason，桥接判据命中）→ 补发注销（reason 透传 closedReason，未知值 status 兜底 completed）", () => {
    setup();
    writeRegister("bg-old", "subagent");
    const h = makeBinding({ sessionFile });
    h.store.disk.set(
      "bg-old",
      makeDiskRecord(sessionFile, { id: "bg-old", status: "idle", closedReason: "gc" }),
    );
    runPendingReconcileSweepForService(h.binding, false);
    expect(h.pi?.appended).toEqual([
      { customType: "pending:unregister", data: { id: "bg-old", reason: "gc", status: "completed" } },
    ]);
  });

  it("record 已归档/不存在（双 miss）→ 视同终态补注销（reason=expired）", () => {
    setup();
    writeRegister("bg-gone", "subagent");
    const h = makeBinding({ sessionFile });
    runPendingReconcileSweepForService(h.binding, false);
    expect(h.pi?.appended).toEqual([
      { customType: "pending:unregister", data: { id: "bg-gone", reason: "expired", status: "expired" } },
    ]);
  });

  it("pi 缺席（getPi null）→ 只判不写，不炸", () => {
    setup();
    writeRegister("bg-gone", "subagent");
    const h = makeBinding({ sessionFile, pi: null });
    expect(() => runPendingReconcileSweepForService(h.binding, false)).not.toThrow();
  });

  it("getStore 抛错（store 未初始化形态）→ best-effort 吞掉不向上抛", () => {
    setup();
    // 差集非空是前置：无 register entry 时 collectActiveRegisterEntries 返回空、
    // 循环零次、lookupRecordState（内含 getStore）不可达，用例空转（MF-R2-2）。
    writeRegister("bg-gone", "subagent");
    const h = makeBinding({ sessionFile });
    let storeRequested = 0;
    h.binding.getStore = () => {
      storeRequested += 1;
      throw new Error("store exploded");
    };
    expect(() => runPendingReconcileSweepForService(h.binding, false)).not.toThrow();
    // 空转守卫：getStore 未被触达 = 判据链路没跑，异常根本没进 sweep 外层 catch
    expect(storeRequested).toBeGreaterThanOrEqual(1);
  });
});
