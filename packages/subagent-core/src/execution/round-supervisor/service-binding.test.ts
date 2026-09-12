// src/execution/round-supervisor/service-binding.test.ts
//
// [MF-1 round1 test-coverage] service-binding 绑定面直测（审查基线覆盖 23.3%）。
//
// 覆盖面：
//   1. supervisorGiveUp（C-proc-13 注销发射点④「监督器放弃」唯一执行者）：
//      - 内存态 watchdog-expired：CAS 终态化 + finalizeClosed failed result +
//        终止通知（「safe to re-dispatch」用户语义，经 steer 通道）；
//      - CAS 抢锁失败跳过（他人已终态化时不重复放弃——同步链内不可达的防御
//        分支，替身 getMutable 受控注入驱动契约）；
//      - finalizeClosed 异常 best-effort（不向上抛、终止通知仍发）；
//      - superseded：errorText 带替代 id、不发终止通知；
//      - 磁盘态（boot 重认领后看门狗到期）：[U2b] store.markFinalized 归口——
//        `.state` sidecar + subagent-record 终态 entry（closed/gc/endedAt/error）+
//        `.alive` release 一体落齐、无 pi 通知；
//      - 磁盘态无 sessionFile / writeFinalizedState 返回 false（§3.4 零持久化
//        副作用 + 响亮 entry）/ 双 miss 收尾竞争 / entry 面抛错（appendEntry catch，
//        须先经 boot 重认领武装看门狗——无候选则 giveUp 不执行，用例空转）。
//   2. runPendingReconcileSweepForService 的 lookupRecordState 闭包 subagent 判据
//      （workflow 判据回归钉在 workflow-state-root.test.ts，此处补 subagent 两方向：
//      活跃 record 不被 sweep 注销 + 终态/missing 差集补发注销）。
//   3. createRoundSupervisorForService 通知装配（merged failure / decision guidance
//      + 豁免声明 / replaced notice 全走 steer 通道；candidates 接线；record 视图
//      磁盘兜底投影）。
//
// 测试纪律：fake timers（watchdog 推进）；替身 RecordStore/PiLike 驱动（不触真实
// 数据目录）；sidecar/register 写点全部 mkdtempSync 自建自删；PI_CODING_AGENT_DIR
// stub 指向 tmp（sweep 内 FileRunStore 构造读侧解析不探测真实 ~/.pi/agent）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COLD_LOOKUP_SCAN_LIMIT } from "../cold-lookup.ts";
import * as stateMarker from "../state-marker.ts";
import type { PiLike } from "../notify-host.ts";
import { RecordStore } from "../record-store.ts";
import type { ClosedReason, ExecutionRecord, SubagentRecord } from "../types.ts";
import { RoundSupervisor, ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS, type SupervisorCandidateRecord } from "./index.ts";
import {
  createRoundSupervisorForService,
  runPendingReconcileSweepForService,
  type RoundSupervisorBinding,
} from "./service-binding.ts";

// writeFinalizedState 实装（U1 后）为响亮重试 + 失败返回 false（不抛——state-marker
// 内部 3 次退避重试），give-up 的 §3.4 false 分支真实磁盘故障无法稳定驱动，仅本文件
// 的「重试耗尽」用例经模块替身注入 false 返回；默认委托真实实现，相邻用例行为不变
//（vi.spyOn 对跨模块具名导入绑定不可拦截，必须走 vi.mock）。
vi.mock("../state-marker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state-marker.ts")>();
  return { ...actual, writeFinalizedState: vi.fn(actual.writeFinalizedState) };
});

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

interface StoreHarness {
  store: RecordStore;
  /** 真实 RecordStore（磁盘态放弃分支 markFinalized 的委托目标——终态四面真写）。 */
  realStore: RecordStore;
  memory: Map<string, ExecutionRecord>;
  disk: Map<string, SubagentRecord>;
  /** collectRecords 返回的候选（替身投影；默认从 memory 生成）。 */
  collectResult: SupervisorCandidateRecord[];
  collectCalls: Array<{ limit: number; status: string; rootFilter: string | undefined }>;
  reported: SubagentRecord[];
}

/** duck-typed RecordStore 替身（service-binding 消费 getMutable / findLightById /
 *  collectRecords / reportSubagentRecord / markFinalized 五个读写点——markFinalized
 *  [U2b] 委托真实 store（`.state`/entry/manifest/marker release 真写），其余读点走
 *  替身 map（真实磁盘发现需 session 文件扫描，与本文件断言面无关）。 */
function makeStore(): StoreHarness {
  const memory = new Map<string, ExecutionRecord>();
  const disk = new Map<string, SubagentRecord>();
  const collectResult: SupervisorCandidateRecord[] = [];
  const collectCalls: StoreHarness["collectCalls"] = [];
  const reported: SubagentRecord[] = [];
  const realStore = new RecordStore(path.join(tmpDir, "sessions"));
  const store = {
    getMutable: (id: string) => memory.get(id),
    findLightById: (id: string) => disk.get(id),
    collectRecords: (limit: number, status: string, rootFilter: string | undefined) => {
      collectCalls.push({ limit, status, rootFilter });
      return collectResult as never;
    },
    reportSubagentRecord: (record: SubagentRecord) => {
      reported.push(record);
    },
    markFinalized: (record: ExecutionRecord, closedReason?: ClosedReason) =>
      realStore.markFinalized(record, closedReason),
  };
  return { store: store as unknown as RecordStore, realStore, memory, disk, collectResult, collectCalls, reported };
}

interface BindingHarness {
  binding: RoundSupervisorBinding;
  store: StoreHarness;
  pi: ReturnType<typeof makePi> | null;
  finalizeClosed: ReturnType<typeof vi.fn>;
}

function makeBinding(overrides: {
  store?: StoreHarness;
  pi?: ReturnType<typeof makePi> | null;
  rootId?: string | null;
  sessionFile?: string;
} = {}): BindingHarness {
  const storeHarness = overrides.store ?? makeStore();
  const pi = overrides.pi === undefined ? makePi() : overrides.pi;
  const finalizeClosed = vi.fn(async () => {});
  const binding: RoundSupervisorBinding = {
    getStore: () => storeHarness.store,
    getPi: () => pi,
    getSessionRootId: () => (overrides.rootId === undefined ? "root-1" : overrides.rootId),
    getMainSessionFile: () => overrides.sessionFile,
    finalizeClosed: finalizeClosed as unknown as (r: ExecutionRecord, res: unknown) => Promise<void>,
  };
  return { binding, store: storeHarness, pi, finalizeClosed };
}

/** 内存 ExecutionRecord 替身（字段访问面：id/agent/slug/status/resumable/result/
 *  chatMode/rootSessionId/startedAt/closedReason/turnCount）。 */
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
    resumable: true,
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
    resumable: true,
    sessionFile,
    ...overrides,
  } as unknown as SubagentRecord;
}

// ============================================================
// 测试
// ============================================================

/** 终止通知文案锚（supervisorGiveUp watchdog-expired 分支独有；guidance/replaced/merged 均不含）。 */
const TERMINATION_NOTICE_MARK = "terminated after the decision watchdog";

let tmpDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-binding-"));
  sessionFile = path.join(tmpDir, "main-session.jsonl");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 纳管 + 看门狗到期 → giveUp("watchdog-expired")（异步 giveUp 编排排空微任务）。 */
async function adoptThenExpire(supervisor: RoundSupervisor, record: ExecutionRecord): Promise<void> {
  supervisor.adoptOnProcessDeath(record, "engine crashed");
  await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);
}

describe("supervisorGiveUp 内存态（watchdog-expired / superseded / CAS）", () => {
  it("watchdog-expired：CAS 终态化 + finalizeClosed 收 failed result + 终止通知经 steer（safe to re-dispatch 语义）", async () => {
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-1", makeRecord());
    const supervisor = createRoundSupervisorForService(h.binding);

    await adoptThenExpire(supervisor, makeRecord());

    // CAS 终态化已落（closed + gc），finalizeClosed 收失败语义 result
    expect(h.store.memory.get("bg-1")?.status).toBe("closed");
    expect(h.store.memory.get("bg-1")?.closedReason).toBe("gc");
    expect(h.finalizeClosed).toHaveBeenCalledTimes(1);
    const [record, result] = (h.finalizeClosed.mock.calls[0] ?? []) as [ExecutionRecord, Record<string, unknown>];
    expect(record.id).toBe("bg-1");
    expect(result).toMatchObject({
      text: "",
      turns: 3,
      success: false,
      sessionId: "bg-1",
      toolCalls: [],
      durationMs: expect.any(Number),
      error: expect.stringContaining("safe to re-dispatch"),
    });

    // 终止通知：steer 通道、customType/display 契约、agent/slug 用户语义
    // （sent = [merged failure, decision guidance, termination] 三条，钉最后一条）
    expect(h.pi?.sent).toHaveLength(3);
    const sent = h.pi!.sent[2]!;
    expect(sent.options).toEqual({ deliverAs: "steer" });
    expect(sent.message.customType).toBe("subagent-round-supervisor");
    expect(sent.message.display).toBe(false);
    expect(sent.message.content).toContain('Subagent "worker" (fix-bug)');
    expect(sent.message.content).toContain("decision watchdog");
    expect(sent.message.content).toContain("you can safely re-dispatch the task");
  });

  it("CAS 抢锁失败（视图检查后 record 已被 cancel 终态化）→ 不 finalizeClosed、不通知、不重复放弃", async () => {
    const h = makeBinding({ sessionFile });
    const rec = makeRecord();
    h.store.memory.set("bg-1", rec);
    // 同步链内 view 检查与 CAS 之间不可插入并发终态化（防御分支）——替身受控注入：
    // 第一次 getMutable（watchdog 回调的视图检查）返回 running，其后（giveUp 的
    // memory 读取）返回已被 cancel 抢先终态化的同一 record。
    let viewChecked = false;
    h.store.store.getMutable = (id: string) => {
      if (!viewChecked) {
        viewChecked = true;
        return rec;
      }
      return { ...rec, status: "closed", closedReason: "cancelled" } as ExecutionRecord;
    };
    const supervisor = createRoundSupervisorForService(h.binding);

    await adoptThenExpire(supervisor, rec);

    expect(h.finalizeClosed).not.toHaveBeenCalled();
    // 纳管期通知（merged + guidance）照常，但终止通知不发生（不重复放弃）
    expect(h.pi?.sent).toHaveLength(2);
    expect(h.pi?.sent.every((s) => !s.message.content.includes(TERMINATION_NOTICE_MARK))).toBe(true);
    expect(h.store.reported).toHaveLength(0);
  });

  it("finalizeClosed 抛错 → best-effort 吞掉不向上抛，终止通知仍发", async () => {
    const h = makeBinding({ sessionFile });
    h.finalizeClosed.mockImplementation(async () => {
      throw new Error("finalize exploded");
    });
    h.store.memory.set("bg-1", makeRecord());
    const supervisor = createRoundSupervisorForService(h.binding);

    await expect(adoptThenExpire(supervisor, makeRecord())).resolves.toBeUndefined();

    expect(h.finalizeClosed).toHaveBeenCalledTimes(1);
    expect(h.pi?.sent).toHaveLength(3);
    expect(h.pi?.sent[2]?.message.content).toContain("safely re-dispatch");
  });

  it("superseded（高置信替代）：errorText 带替代 id，不发终止通知（替代通知由监督器先行）", async () => {
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-1", makeRecord());
    h.store.collectResult.push({ id: "bg-2", rootSessionId: "root-1", agent: "worker", slug: "fix-bug", startedAt: Date.now() - 1000 });
    const supervisor = createRoundSupervisorForService(h.binding);

    await adoptThenExpire(supervisor, makeRecord());

    const [record, result] = (h.finalizeClosed.mock.calls[0] ?? []) as [ExecutionRecord, Record<string, unknown>];
    expect(record.id).toBe("bg-1");
    expect(result.error).toBe("round supervisor: superseded by replacement task bg-2");
    // 终止通知不发；sent = [merged failure, replaced notice] 两条
    expect(h.pi?.sent).toHaveLength(2);
    expect(h.pi?.sent.every((s) => !s.message.content.includes(TERMINATION_NOTICE_MARK))).toBe(true);
    expect(h.pi?.sent[1]?.message.content).toContain("was already replaced by your new");
  });

  it("pi 缺席（dispose 后 getPi null）→ 终态化照常、通知静默丢弃、不炸", async () => {
    const h = makeBinding({ sessionFile, pi: null });
    h.store.memory.set("bg-1", makeRecord());
    const supervisor = createRoundSupervisorForService(h.binding);

    await expect(adoptThenExpire(supervisor, makeRecord())).resolves.toBeUndefined();

    expect(h.finalizeClosed).toHaveBeenCalledTimes(1);
    expect(h.store.memory.get("bg-1")?.status).toBe("closed");
  });
});

describe("supervisorGiveUp 磁盘态（boot 重认领后看门狗到期）", () => {
  function makeDiskBinding(diskRecord: SubagentRecord): BindingHarness {
    const h = makeBinding({ sessionFile });
    // [U2b] 终态 entry/manifest 面 = markFinalized 经真实 store 落 pi.appendEntry
    //（archive 面），绑定 pi 注入真实 store。
    h.store.realStore.setPi(h.pi ?? null);
    h.store.disk.set(diskRecord.id, diskRecord);
    // boot 分区候选（真实 collectRecords 的 running 投影形态）
    h.store.collectResult.push({
      id: diskRecord.id,
      rootSessionId: diskRecord.rootSessionId,
      agent: diskRecord.agent,
      slug: diskRecord.slug,
      startedAt: diskRecord.startedAt,
    });
    return h;
  }

  /** pi.appended 中 customType=subagent-record 的终态 entry 载荷。 */
  function subagentEntries(pi: ReturnType<typeof makePi> | null): Array<Record<string, unknown>> {
    return (pi?.appended ?? [])
      .filter((a) => a.customType === "subagent-record")
      .map((a) => a.data as Record<string, unknown>);
  }

  it("markFinalized 归口：.state sidecar + subagent-record 终态 entry（closed/gc/endedAt/error）+ .alive release 一体落齐；磁盘态不发终止通知", async () => {
    const diskRecord = makeDiskRecord(sessionFile);
    const h = makeDiskBinding(diskRecord);
    // 持有期声明在位（boot 重认领形态——磁盘 running record 携带写权声明）。
    h.store.realStore.acquireWriteLease(sessionFile, diskRecord.id);
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);
    const supervisor = createRoundSupervisorForService(h.binding);

    // 纳管经磁盘兜底视图（内存 Map 空）——boot 分区重认领形态
    supervisor.bootPartition();
    await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);

    // sidecar：sessionFile 旁 .state 内容 = {status:finalized, reason:"gc"}；finalizeClosed 不适用（无内存 record）
    expect(JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8"))).toEqual({
      status: "finalized",
      reason: "gc",
    });
    expect(h.finalizeClosed).not.toHaveBeenCalled();

    // 终态 entry 落盘（markFinalized → archive → pi.appendEntry）：磁盘 record + 终态语义位
    const entries = subagentEntries(h.pi);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "bg-disk",
      status: "closed",
      closedReason: "gc",
      endedAt: expect.any(Number),
      error: expect.stringContaining("safe to re-dispatch"),
    });
    expect(String(entries[0]!["error"])).not.toContain("superseded");

    // [D3a release 出口①] 终态原语删写权声明——磁盘态放弃同样释放（残留声明会
    // 误拦异宿主接管）。
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);

    // 磁盘态分支无终止通知（sent 仅 boot 重认领的 decision guidance 一条）
    expect(h.pi?.sent).toHaveLength(1);
    expect(h.pi?.sent.every((s) => !s.message.content.includes(TERMINATION_NOTICE_MARK))).toBe(true);
  });

  it("磁盘态无 sessionFile → 跳过 sidecar，仍终态 entry（markFinalized 无锚点降级路径）", async () => {
    const diskRecord = makeDiskRecord(undefined);
    const h = makeDiskBinding(diskRecord);
    const supervisor = createRoundSupervisorForService(h.binding);

    supervisor.bootPartition();
    await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);

    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    const entries = subagentEntries(h.pi);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "bg-disk", status: "closed", closedReason: "gc" });
  });

  it("entry 面抛错（pi.appendEntry 炸）→ best-effort 吞掉不向上抛，sidecar 照常落盘", async () => {
    // 候选入 collectResult → boot 重认领（readopted）武装看门狗——没有这一步
    // listCandidateRecords 返回空、giveUp 永不执行、entry catch 不可达（MF-R2-2）。
    const diskRecord = makeDiskRecord(sessionFile);
    const h = makeDiskBinding(diskRecord);
    (h.pi!.appendEntry as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("entry write exploded");
    });
    const supervisor = createRoundSupervisorForService(h.binding);

    const { readopted } = supervisor.bootPartition();
    expect(readopted).toEqual([diskRecord.id]);
    // 裸 await：giveUp 编排若有逃逸异常会以 unhandled rejection 判红本用例
    await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);

    // sidecar 与终态 entry 是两段独立 best-effort：entry 抛错不回滚已落 sidecar
    //（markFinalized 写序 = .state 先、archive/entry 后，D8）。
    expect(JSON.parse(fs.readFileSync(`${sessionFile}.state`, "utf-8"))).toEqual({
      status: "finalized",
      reason: "gc",
    });
    expect(subagentEntries(h.pi)).toHaveLength(0);
  });

  it("writeFinalizedState 返回 false（重试耗尽）→ 零持久化副作用：无终态 entry、无 state-write-failed 之外的写入面、响亮 entry 上报", async () => {
    const diskRecord = makeDiskRecord(sessionFile);
    const h = makeDiskBinding(diskRecord);
    const supervisor = createRoundSupervisorForService(h.binding);
    // 模块替身注入失败返回（U1 后 writeFinalizedState 不抛——重试耗尽返回 false）；
    // finally 恢复委托真实实现。
    const actual = await vi.importActual<typeof import("../state-marker.ts")>(
      "../state-marker.ts",
    );
    const writeSpy = vi.mocked(stateMarker.writeFinalizedState);
    writeSpy.mockImplementation(() => false);
    try {
      supervisor.bootPartition();
      await vi.advanceTimersByTimeAsync(ROUND_SUPERVISOR_WATCHDOG_DEFAULT_MS + 1);
    } finally {
      writeSpy.mockImplementation(actual.writeFinalizedState);
    }

    // 替身确实被 giveUp 消费（否则用例假绿）
    expect(writeSpy).toHaveBeenCalled();
    // [§3.4] record 留 running：.state 未落 + 无终态 entry（零持久化副作用）
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    expect(subagentEntries(h.pi)).toHaveLength(0);
    // 响亮上报腿：subagent:state-write-failed entry（GUI 通知面，对齐 doFinalizeRecord）
    const failNotices = (h.pi?.appended ?? []).filter((a) => a.customType === "subagent:state-write-failed");
    expect(failNotices).toHaveLength(1);
    expect(failNotices[0]?.data).toMatchObject({ id: diskRecord.id, status: "closed", closedReason: "gc" });
  });

  it("giveUp 执行时 record 已被 archive（内存移除 + 磁盘无 light）→ 双 miss 直接 return，零副作用", async () => {
    const h = makeBinding({ sessionFile });
    h.store.realStore.setPi(h.pi ?? null);
    const rec = makeRecord();
    h.store.memory.set("bg-1", rec);
    // 视图检查（内存 running）之后、giveUp 磁盘兜底之前被 archive 的收尾竞争替身投影
    let viewChecked = false;
    h.store.store.getMutable = () => {
      if (!viewChecked) {
        viewChecked = true;
        return rec;
      }
      return undefined;
    };
    const supervisor = createRoundSupervisorForService(h.binding);

    await adoptThenExpire(supervisor, rec);

    expect(h.finalizeClosed).not.toHaveBeenCalled();
    expect(h.pi?.sent).toHaveLength(2); // 纳管期通知照常，终止通知不发（零通知放弃）
    expect(h.pi?.sent.every((s) => !s.message.content.includes(TERMINATION_NOTICE_MARK))).toBe(true);
    expect(subagentEntries(h.pi)).toHaveLength(0);
    expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
  });
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

  it("活跃 subagent record（仅磁盘 running，boot 重认领形态）→ 不补注销", () => {
    setup();
    writeRegister("bg-disk", "subagent");
    const h = makeBinding({ sessionFile });
    h.store.disk.set("bg-disk", makeDiskRecord(sessionFile, { id: "bg-disk" }));
    runPendingReconcileSweepForService(h.binding, false);
    expect(h.pi?.appended ?? []).toHaveLength(0);
  });

  it("终态 subagent record（内存 closed，closedReason 有值）→ 差集补发注销（reason 直传 closedReason）+ 尽力 emit", () => {
    setup();
    writeRegister("bg-done", "subagent");
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-done", makeRecord({ id: "bg-done", status: "closed", closedReason: "cancelled" }));
    runPendingReconcileSweepForService(h.binding, false);
    expect(h.pi?.appended).toEqual([
      { customType: "pending:unregister", data: { id: "bg-done", reason: "cancelled", status: "cancelled" } },
    ]);
    expect(h.pi?.emitted).toEqual([{ channel: "pending:unregister", data: { id: "bg-done", reason: "cancelled" } }]);
  });

  it("终态 subagent record（磁盘 closed，closedReason 缺失）→ 补发注销 reason=completed 兜底", () => {
    setup();
    writeRegister("bg-old", "subagent");
    const h = makeBinding({ sessionFile });
    h.store.disk.set(
      "bg-old",
      makeDiskRecord(sessionFile, { id: "bg-old", status: "closed", resumable: false }),
    );
    runPendingReconcileSweepForService(h.binding, false);
    expect(h.pi?.appended).toEqual([
      { customType: "pending:unregister", data: { id: "bg-old", reason: "completed", status: "completed" } },
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

describe("createRoundSupervisorForService 通知装配", () => {
  it("merged failure notice：死亡纳管单条通知（failed 如实 + 已接管契约）经 steer", () => {
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-1", makeRecord());
    const supervisor = createRoundSupervisorForService(h.binding);

    supervisor.adoptOnProcessDeath(makeRecord(), "engine crashed");

    const first = h.pi?.sent[0]!;
    expect(first.options).toEqual({ deliverAs: "steer" });
    expect(first.message.customType).toBe("subagent-round-supervisor");
    expect(first.message.display).toBe(false);
    expect(first.message.content).toContain('Subagent "worker" (fix-bug)');
    expect(first.message.content).toContain("failed: the engine/child process driving it died (engine crashed)");
    expect(first.message.content).toContain("NOT completed");
    expect(first.message.content).toContain("Do NOT re-dispatch this task before that guidance arrives");
  });

  it("decision guidance：无替代命中 → 指引不带豁免声明；slug 缺失回落 record id", () => {
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-1", makeRecord({ slug: "" }));
    const supervisor = createRoundSupervisorForService(h.binding);

    supervisor.adoptOnProcessDeath(makeRecord({ slug: "" }), "engine crashed");

    const guidance = h.pi?.sent[1]!;
    expect(guidance.message.content).toContain('Subagent "worker" (bg-1, id=bg-1) died mid-task');
    expect(guidance.message.content).toContain("Decide now");
    expect(guidance.message.content).toContain("it will be terminated automatically when the decision watchdog expires");
    expect(guidance.message.content).not.toContain("If you have already re-dispatched");
  });

  it("低置信对账（仅 agent 同名）→ 指引自带豁免声明文案", () => {
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-1", makeRecord());
    h.store.collectResult.push({ id: "bg-2", rootSessionId: "root-1", agent: "worker", slug: "other-task", startedAt: Date.now() - 1000 });
    const supervisor = createRoundSupervisorForService(h.binding);

    supervisor.adoptOnProcessDeath(makeRecord(), "engine crashed");

    const guidance = h.pi?.sent[1]!;
    expect(guidance.message.content).toContain(
      "If you have already re-dispatched or no longer need this task, ignore this guidance",
    );
  });

  it("高置信替代 → sendReplacedNotice 文案（原任务终止、无需 resume）", () => {
    const h = makeBinding({ sessionFile });
    h.store.memory.set("bg-1", makeRecord());
    h.store.collectResult.push({ id: "bg-2", rootSessionId: "root-1", agent: "worker", slug: "fix-bug", startedAt: Date.now() - 1000 });
    const supervisor = createRoundSupervisorForService(h.binding);

    supervisor.adoptOnProcessDeath(makeRecord(), "engine crashed");

    const notice = h.pi?.sent[1]!;
    expect(notice.message.content).toContain("was already replaced by your new task bg-2");
    expect(notice.message.content).toContain("no resume is needed");
  });

  it("candidates 接线：collectRecords 以 (SCAN_LIMIT, running, rootId) 调用；rootId null → undefined filter", () => {
    const h = makeBinding({ sessionFile, rootId: "root-1" });
    h.store.collectResult.push({ id: "bg-1", rootSessionId: "root-1", agent: "worker", slug: "fix-bug", startedAt: 1 });
    const supervisor = createRoundSupervisorForService(h.binding);
    supervisor.bootPartition();
    expect(h.store.collectCalls).toEqual([
      { limit: COLD_LOOKUP_SCAN_LIMIT, status: "running", rootFilter: "root-1" },
    ]);

    const h2 = makeBinding({ sessionFile, rootId: null });
    const supervisor2 = createRoundSupervisorForService(h2.binding);
    supervisor2.bootPartition();
    expect(h2.store.collectCalls).toEqual([
      { limit: COLD_LOOKUP_SCAN_LIMIT, status: "running", rootFilter: undefined },
    ]);
  });

  it("record 视图磁盘兜底投影：内存 miss 时 boot 分区经 findLightById 读视图并可重认领", () => {
    const h = makeBinding({ sessionFile });
    h.store.disk.set("bg-disk", makeDiskRecord(sessionFile));
    h.store.collectResult.push({ id: "bg-disk", rootSessionId: "root-1", agent: "worker", slug: "fix-bug", startedAt: 1 });
    const supervisor = createRoundSupervisorForService(h.binding);

    const { readopted } = supervisor.bootPartition();

    expect(readopted).toEqual(["bg-disk"]);
    // 磁盘投影视图驱动判定：resumable + 无完成产出 → 决策指引送达
    expect(h.pi?.sent).toHaveLength(1);
    expect(h.pi?.sent[0]?.message.content).toContain("died mid-task and stays resumable");
  });
});
