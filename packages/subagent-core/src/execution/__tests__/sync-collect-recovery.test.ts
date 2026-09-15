// src/execution/__tests__/sync-collect-recovery.test.ts
//
// sync collect 域真实文件通路测试（subagent-sync-collect 设计 §3.1.5）。
// [modeless 波3] E1 崩溃恢复面（扫描补发 / settled 有界重扫 / 账本幂等窗口 / dispose
// 惰化）随 collectMode 记录态消亡退役——批协调状态 = 协调器内存登记态，随 session
// 生命周期消亡，崩溃后批次协调不恢复（成员 record 本体仍健全）。本文件保留：
//   1. 投影白名单：batchFinalized/终态五字段经末条 entry 重建后可见（rebuildEntryRecord）；
//   2. E9 dispose：缓冲终态成员逐条转 async notify + 落标 + 协调状态清空；在跑成员
//      走现有退出路径（不通知）；
//   3. U4 deviation #8 接线：config collectSync 预算热读传入 flush 的 notifyBatch
//      budget 参数；
//   4. 波3 语义：kill -9 同构形态下重启——orphan 覆写自洽 + 批协调不恢复（零补发零落标）；
//   5. manifest 屏障失败 warn 留痕（D6 #7a/SC-1，flush 路径驱动）；
//   6. orphan 覆写 merge 语义（async 对照 / 保留方向反向锁定）；
//   7. P-rebuild / P-manifest 探针不变量（投影不改变孤儿判定 / manifest 存在不改变
//      重建投影）；
//   8. S11：flushBatch 中 getFullRecord miss 成员用缓冲快照兜底落标。
//
// 通路保真（U8 红线：禁 mock record 断言）：
//   种子 entry 经真实 RecordStore.reportSubagentRecord → toSubagentRecordEntry 序列化
//   → 真实 appendFileSync 落 tmpdir 主 session JSONL → 读侧真实 readFileSync 扫描
//   （scanLastRecordEntries → collectLastRecordEntries + rebuildEntryRecord 投影）。
//   断言全部打在「磁盘文件内容 + 真实投影产物」上，scan/投影/序列化三层零 mock。
//
// mock 手法对齐 collect-coordinator-service.test.ts：mock session-runner（不 spawn 真子
// 进程）+ logger；record-store / config 走真实实现（tmpdir 自建自删，红线）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
// mock logger：路径从 __tests__ 出发是 ../../core/（src/core/logger.ts——subagent-service
// 经 ../core/logger.ts 引用的同一模块）。曾写 ../core/logger.ts 指向不存在的
// src/execution/core/，vi.mock 静默失效（D4 上限用例首次断言日志时暴露）。
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));
// [U3 适配] RecordStore 构造点接线 manifestDir 后，markBatchFinalized 的 manifest 面走
// writeAtomicFileSync 同步写（不再经 manifestStore.writeManifest）——屏障失败注入面
// 在本模块（默认透传真实现，仅「屏障失败」用例内 mockImplementationOnce）。
vi.mock("../../shared/atomic-write.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/atomic-write.ts")>();
  return { ...actual, writeAtomicFileSync: vi.fn(actual.writeAtomicFileSync) };
});

// [W3 改写] mock session-runner（execute 链 runSpawn 替身）随 inproc pi 引擎目录 删除消亡——
// execute 链改为协议 seam（registerFakePiEngine 替身 + 显式 settle 应答）。
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";

import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../persistence/record-entry.ts";
import { ManifestStore } from "../persistence/manifest-store.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelRegistryLike } from "../assembly/model-resolver.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { SyncCollectDomain } from "../service/sync-collect-domain.ts";
import type { SubagentRecord } from "../assembly/types.ts";
import { SubagentService } from "../subagent-service.ts";
import { writeAtomicFileSync } from "../../shared/atomic-write.ts";

/** 剥身份/relay env：身份 env 会让 service 误判自己是子进程（跳过恢复扫描），
 *  relay env 属 pi-invocation/relay-env 存量测试的敏感面（测试纪律：env 剥离）。 */
const ENV_KEYS_TO_STRIP = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
  "XYZ_SUBAGENT_RELAY_SOCKET",
  "XYZ_SUBAGENT_RELAY_NODE",
  "XYZ_SUBAGENT_RELAY_SCRIPT",
] as const;

const ROOT_SESSION = "root-session-crash";

/** 种子 pi：appendEntry 真写主 session JSONL（每 entry 一行，pi 落盘形态）。 */
function makeWritingPi(mainFile: string) {
  return {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      fs.appendFileSync(
        mainFile,
        `${JSON.stringify({
          type: "custom",
          id: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          customType,
          data,
        })}\n`,
        "utf-8",
      );
    }),
    events: { emit: vi.fn() },
    sendMessage: vi.fn((_m: unknown, _o?: unknown) => {}),
    on: vi.fn(),
  };
}

/** 断言 pi：appendEntry 只记录不落盘（断言恢复侧写点用）。 */
function makeAssertPi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn((_m: unknown, _o?: unknown) => {}),
    on: vi.fn(),
  };
}

type AssertPi = ReturnType<typeof makeAssertPi>;
type WritingPi = ReturnType<typeof makeWritingPi>;

interface NotifierSpy {
  // Mock<T> 而非纯函数签名：测试断言消费 .mock.calls，需保留 mock 元数据
  notify: Mock<(record: unknown) => void>;
  notifyBatch: Mock<(records: unknown, budget?: unknown) => boolean>;
}

function spyNotifier(service: SubagentService): NotifierSpy {
  // [D4-① 适配] notifier 实例已封装进 notifyHost（createNotifyHost），spy 改为包装
  // host 的 notify/notifyBatch 出口（其余方法经 ...host 保留真实现）；协调器 deps
  // 闭包经 this 运行时读取 service.notifyHost，字段替换即生效。
  const host = (service as unknown as { notifyHost: object }).notifyHost;
  const spy: NotifierSpy = { notify: vi.fn(), notifyBatch: vi.fn(() => true) };
  (service as unknown as { notifyHost: unknown }).notifyHost = {
    ...host,
    notify: (record: unknown) => spy.notify(record),
    notifyBatch: (records: unknown, budget?: unknown) => spy.notifyBatch(records, budget),
  };
  return spy;
}

/** 手写短轮询（真实 timers）——vi.waitFor 在 vitest 4.1.8 本包环境对 falsy callback
 *  立即 resolve 不轮询（见 collect-coordinator-service.test.ts 同款说明）。 */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`sync-collect-recovery: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 种子成员 record（真实 reportSubagentRecord 入参——序列化/落盘/扫描三层真实）。 */
function memberRecord(overrides: Partial<SubagentRecord> & { id: string }): SubagentRecord {
  return {
    agent: "/agents/worker.md",
    task: "seed task",
    slug: "seed",
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: ROOT_SESSION,
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    sessionFile: undefined,
    ...overrides,
  };
}

describe("sync collect 域真实文件通路（[modeless 波3] E9/flush/投影）", () => {
  let agentDir: string;
  let mainFile: string;

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_STRIP) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-sync-recovery-"));
    fs.mkdirSync(getSubagentSessionDir(agentDir, agentDir), { recursive: true });
    mainFile = path.join(agentDir, "main-session.jsonl");
  });

  afterEach(() => {
    clearEngines();
    // maxRetries：E9 落标的 manifest fire-and-forget 原子写（tmp→fsync→rename，
    // 链尾 fsyncDir 仍在飞；批通知路径的屏障 await 已含 fsyncDir，无此竞态）+
    // sessions-index fire 写都可能与删除并发（ENOTEMPTY 竞态，根级全量并行时机器
    // 负载高会放大窗口）——同款修法见 get-record-for-action-restart.test.ts /
    // record-store-index.test.ts。
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 种子 store：真实 RecordStore + 写文件 pi（种子经真实 toSubagentRecordEntry 序列化）。 */
  function makeSeedStore(): RecordStore {
    return new RecordStore(
      getSubagentSessionDir(agentDir, agentDir),
      new ManifestStore(getSubagentRecordsDir(agentDir, agentDir)),
      makeWritingPi(mainFile),
    );
  }

  /** 恢复侧 service：断言 pi（覆写不落盘，断言内存面）/ 写文件 pi（覆写真实落盘）
   *  两用。 */
  /** [W3] 协议替身注册（per-test 调用；afterEach clearEngines 统一清理）。 */
  function makeRecoveryFake(): FakePiEnginePort {
    clearEngines();
    return registerFakePiEngine();
  }

  function makeRecoveryService(pi: AssertPi | WritingPi): SubagentService {
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    const modelRegistry: ModelRegistryLike = {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
    modelService.initModel({
      sessionId: ROOT_SESSION,
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      modelRegistry,
    });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi, sessionId: ROOT_SESSION, mainSessionFile: mainFile });
    return service;
  }

  /** 读回主文件每 id 末条 entry data（断言文件真实内容用）。 */
  function readMainFileLastEntries(): Map<string, Record<string, unknown>> {
    const lastById = new Map<string, Record<string, unknown>>();
    for (const line of fs.readFileSync(mainFile, "utf-8").split("\n")) {
      if (!line.includes(SUBAGENT_RECORD_CUSTOM_TYPE) || line.trim() === "") continue;
      const obj = JSON.parse(line) as { customType?: string; data?: { id?: string } };
      if (obj.customType === SUBAGENT_RECORD_CUSTOM_TYPE && typeof obj.data?.id === "string") {
        lastById.set(obj.data.id, obj.data as Record<string, unknown>);
      }
    }
    return lastById;
  }

  /** 在 sessionsDir 手工构造子 session 文件（session 头 + identity entry + 末行完整
   *  JSON record entry，E9 用例同款形态）且**不写** `.state`/`.alive`
   *  三 sidecar——重建矩阵分支 4 命中条件，保证 orphan 恢复走 finalizeOrphanRecord
   *  真实路径（entry-born 兜底测不到 D3 merge 所在路径 = 假绿）。
   *  identity 含 reconstructAll 过滤必需字段：id/agent/task string + mode 枚举 +
   *  startedAt number + rootSessionId。
   *  headModel（可选，"provider/modelId" 形态）：在 session 头与 identity 之间插一笔
   *  model_change entry——pi sdk 新 session 真实形态（dist sdk.js 对新 session 先
   *  appendModelChange 初值，session_start hook 的 identity 随后），readIdentityHeader
   *  解析 identity 前途经的 model_change 产出 light 重建的 rec.model。 */
  function writeChildSessionFile(recordId: string, task: string, headModel?: string): string {
    const childFile = path.join(getSubagentSessionDir(agentDir, agentDir), `${recordId}.jsonl`);
    const ts = new Date(1000).toISOString();
    const modelChangeLine =
      headModel === undefined
        ? ""
        : JSON.stringify({
            type: "model_change", id: `mc-${recordId}-0`, parentId: null, timestamp: ts,
            provider: headModel.slice(0, headModel.indexOf("/")),
            modelId: headModel.slice(headModel.indexOf("/") + 1),
          }) + "\n";
    fs.writeFileSync(
      childFile,
      JSON.stringify({ type: "session", version: 3, id: `sess-${recordId}`, timestamp: ts, cwd: agentDir }) + "\n" +
        modelChangeLine +
        JSON.stringify({
          type: "custom", id: `cid-${recordId}-1`, parentId: null, timestamp: ts,
          customType: "subagent-identity",
          data: { id: recordId, agent: "/agents/worker.md", mode: "background", task, startedAt: 1000, rootSessionId: ROOT_SESSION, depth: 0 },
        }) + "\n" +
        JSON.stringify({
          type: "custom", id: `cid-${recordId}-2`, parentId: `cid-${recordId}-1`, timestamp: ts,
          customType: "subagent-record",
          data: {
            v: 1, id: recordId, agent: "/agents/worker.md", task, slug: "child",
            status: "running", mode: "background", startedAt: 1000, rootSessionId: ROOT_SESSION,
            depth: 0, turns: 1, totalTokens: 10, model: "prov/child-m", eventLog: [], displayItems: [],
          },
        }) + "\n",
      "utf-8",
    );
    return childFile;
  }

  /** 种下「崩溃前主文件末条序列」：register（running）→ 轮终（idle + result 全文 +
   *  sessionFile）——[U4/D3] 翻边后轮终权威形态（markRoundIdle 写 idle）。
   *  [modeless 波3] collectMode 种子参数随字段消亡删除（批成员身份在协调器登记态）。 */
  function seedRoundTerminalEntries(id: string, childFile: string, result: string, model: string): void {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id, sessionFile: childFile, model }));
    store.reportSubagentRecord(
      memberRecord({ id, sessionFile: childFile, model, status: "idle", stopReason: "completed", result }),
    );
  }

  // ============================================================
  // 投影白名单（rebuildEntryRecord）
  // ============================================================

  it("批标记与终态五字段经真实落盘→扫描投影后可见（rebuildEntryRecord 白名单扩展）", () => {
    const store = makeSeedStore();
    // 成员 A：register（running）→ 终态（idle + gc + result）两笔真实 entry
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({
        id: "sa-a",
        status: "idle",
        closedReason: "gc",
        endedAt: 2000,
        result: "done-A",
      }),
    );
    // 成员 B：failed 终态（error 字段）
    store.reportSubagentRecord(memberRecord({ id: "sa-b" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-b", status: "idle", closedReason: "gc", endedAt: 3000, error: "boom" }),
    );
    // 成员 C：已落标（batchFinalized，E9/flush 后形态）
    store.reportSubagentRecord(
      memberRecord({ id: "sa-c", status: "idle", closedReason: "gc", endedAt: 4000, batchFinalized: true }),
    );

    // 读侧：真实 readFileSync 扫描 + 投影（零 mock；store 经测试后门访问，与
    // collect-coordinator-service.test.ts 访问 notifier 同款手法）
    const recovery = makeRecoveryService(makeAssertPi());
    const scanned = (recovery as unknown as { store: RecordStore }).store.scanLastRecordEntries(mainFile);
    const byId = new Map(scanned.map((r) => [r.id, r]));

    // 终态五字段 + 落标标记全可见（末条 last-writer-wins）
    const a = byId.get("sa-a");
    expect(a).toBeDefined();
    expect(a!.status).toBe("idle");
    expect(a!.endedAt).toBe(2000);
    expect(a!.closedReason).toBe("gc");
    expect(a!.result).toBe("done-A");
    expect(a!.error).toBeUndefined();
    expect(a!.batchFinalized).toBeUndefined();

    const b = byId.get("sa-b");
    expect(b!.error).toBe("boom");
    expect(b!.result).toBeUndefined();

    expect(byId.get("sa-c")!.batchFinalized).toBe(true);
  });

  // ============================================================
  // E9 dispose（缓冲转账 + 协调状态清空）
  // ============================================================

  it("E9 dispose：缓冲终态成员逐条转 async notify + 落标；在跑成员走现有退出路径（不通知）", async () => {
    // 复用 execute 真链：成员 1 受控终态（入缓冲后批因成员 2 在跑不闭合），成员 2 悬置 running
    const fake = makeRecoveryFake();
    const pi = makeAssertPi();
    const service = makeRecoveryService(pi);
    const spy = spyNotifier(service);
    const h1 = await service.execute({ task: "terminal one", slug: "one", collect: "sync" });
    await service.execute({ task: "running two", slug: "two", collect: "sync" });
    await until(() => fake.runs.length >= 2);

    // 成员 1 子文件就位（E9 落标 getFullRecord 冷路径数据源）
    const sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    const ts = new Date(1000).toISOString();
    fs.writeFileSync(
      path.join(sessionsDir, `${h1.subagentId}.jsonl`),
      `${JSON.stringify({ type: "session", version: 3, id: `sess-${h1.subagentId}`, timestamp: ts, cwd: agentDir })}\n` +
        JSON.stringify({
          type: "custom", id: "id-1", parentId: null, timestamp: ts,
          customType: "subagent-identity",
          data: { id: h1.subagentId, agent: "/agents/worker.md", mode: "background", task: "terminal one", startedAt: 1000, rootSessionId: ROOT_SESSION, depth: 0 },
        }) + "\n" +
        JSON.stringify({
          type: "custom", id: "id-2", parentId: "id-1", timestamp: ts,
          customType: "subagent-record",
          data: {
            v: 1, id: h1.subagentId, agent: "/agents/worker.md", task: "terminal one", slug: "one",
            status: "closed", mode: "background", startedAt: 1000, rootSessionId: ROOT_SESSION,
            depth: 0, endedAt: 2000, turns: 1, totalTokens: 10, model: "prov/m1",
            eventLog: [], displayItems: [], result: "ok-terminal",
          },
        }) + "\n",
      "utf-8",
    );

    // 成员 1 终态：入缓冲，成员 2 在跑 → 批不闭合（零批投递）
    fake.runs[0]!.settle({ content: "ok-terminal" });
    // 等 settle 收尾链排空（finalize→route 入缓冲；成员 2 悬置 → 零投递）
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spy.notify.mock.calls.length + spy.notifyBatch.mock.calls.length).toBe(0);
    expect(spy.notifyBatch).not.toHaveBeenCalled();

    // dispose（E9）：成员 1 逐条转 async 写账 + 落标；成员 2 不通知（现有退出路径）
    service.dispose();
    expect(spy.notify).toHaveBeenCalledTimes(1);
    expect(spy.notify.mock.calls[0]![0]).toMatchObject({ id: h1.subagentId, status: "closed" });
    expect(spy.notifyBatch).not.toHaveBeenCalled(); // 放弃攒批
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks.map((m) => m.id)).toEqual([h1.subagentId]);
    expect(marks[0]!.result).toBe("ok-terminal");

    // [modeless 波3] E9 后批协调状态清空（clear）：无挂起排程可触发、登记集消亡——
    // dispose 后 settle 链不可能再入批（成员 2 走 disposeAllRecords 退出路径，无通知）。
    expect(spy.notify).toHaveBeenCalledTimes(1);
  });

  it("U4 deviation #8 接线：config collectSync 预算热读传入 flush 的 notifyBatch budget 参数", async () => {
    const fake = makeRecoveryFake();
    // 写 config（collectSync 预算字段）+ reload —— 与 getCollectSyncDefault 同款访问链
    const configPath = path.join(agentDir, "subagents", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, maxConcurrent: 6, collectSync: { default: "sync", perItemChars: 1234, totalChars: 5678 } }),
      "utf-8",
    );

    const pi = makeAssertPi();
    const service = makeRecoveryService(pi);
    const modelService = (service as unknown as { modelService: ModelConfigService }).modelService;
    modelService.reloadGlobalConfig();
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "budget task", slug: "budget", collect: "sync" });
    await until(() => fake.runs.length >= 1);
    fake.runs[0]!.settle({ content: "ok-budget" });
    await until(() => spy.notifyBatch.mock.calls.length > 0);

    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    expect(spy.notifyBatch.mock.calls[0]![1]).toEqual({ perItemChars: 1234, totalChars: 5678 });
    expect(spy.notifyBatch.mock.calls[0]![0]).toMatchObject([{ id: handle.subagentId }]);
  });

  // ============================================================
  // [modeless 波3] kill -9 同构形态：重启后批协调不恢复
  // （E1 恢复面退役——成员 record 本体健全，零补发零落标）
  // ============================================================

  it("kill -9 同构主用例（波3）：轮终 idle 末条自洽 → 重启 orphan 判定自洽 + 批协调不恢复（零补发）", async () => {
    // ── 崩溃前形态：register（running）→ 轮终（idle+result 全文，[U4] 翻边）──
    const childFile = writeChildSessionFile("sa-kill9", "kill -9 crash task");
    seedRoundTerminalEntries("sa-kill9", childFile, "kill-9 full result body", "prov/round-m");

    // ── 重启（写文件 pi：orphan 覆写 entry 真实落盘）──
    // initSession 内已真实跑 orphan 恢复（ENV 已剥 → 根进程判定）。
    const recoveryPi = makeWritingPi(mainFile);
    const recovery = makeRecoveryService(recoveryPi);

    // [U4/D4 → U5] 末条轮终 idle 自洽（纠偏对象 = 残留 running，轮终形态不触发
    // orphan 覆写）——末条直接携带轮终正文/模型（真实轮终 entry 全集）。
    // stopReason 对齐 markRoundIdle 簿记⑩。
    const overwritten = readMainFileLastEntries().get("sa-kill9")!;
    expect(overwritten.status).toBe("idle");
    expect(overwritten.closedReason).toBeUndefined();
    expect(overwritten.stopReason).toBe("completed");
    expect(overwritten.result).toBe("kill-9 full result body");
    expect(overwritten.model).toBe("prov/round-m");
    // 不写 .state 防重锚（writeFinalizedState(file,"gc") 写点已删；幂等由「纠偏
    // entry 落盘后末条变 idle，判据不再命中」构造性承接）
    expect(fs.existsSync(`${childFile}.state`)).toBe(false);

    // ── [modeless 波3] 批协调不恢复：E1 已退役 → 零补发零落标 ──
    // 成员通知已在崩溃前的 flush 投递（或随 dispose 转 async 兑底）；协调器登记态
    // 随旧 session 消亡，重启后无人重收集——成员 record 本体（idle+result+锚）健全，
    // fork/message 续用能力不受影响。
    const spy = spyNotifier(recovery);
    await recovery.recoverSyncCollectBatch(); // accepted-no-op
    expect(spy.notifyBatch).not.toHaveBeenCalled();
    expect(spy.notify).not.toHaveBeenCalled();
    const marked = readMainFileLastEntries().get("sa-kill9")!;
    expect(marked.batchFinalized).toBeUndefined();

    // orphan 覆写幂等自检：二次重启零追加（末条已 idle，判据不再命中）
    const before = readMainFileLastEntries().get("sa-kill9")!;
    makeRecoveryService(makeAssertPi());
    const after = readMainFileLastEntries().get("sa-kill9")!;
    expect(after).toEqual(before);
  });

  // ============================================================
  // v2 断链 2+3 遗产（设计 §3.3 D3）：orphan 覆写 merge 语义。
  // 种子形态取自 kill -9 真实链路（主文件两笔 entry + 子文件 + 无三 sidecar，
  // 让 finalizeOrphanRecord 在同一测试里真实跑）。
  // ============================================================

  it("async 对照：覆写 entry 批域字段不出现，result/model 按 merge 补齐（拉齐修复口径）", () => {
    const childFile = writeChildSessionFile("sa-async-ctl", "async crash task");
    seedRoundTerminalEntries("sa-async-ctl", childFile, "async full result body", "prov/async-m");

    const recoveryPi = makeWritingPi(mainFile);
    makeRecoveryService(recoveryPi); // initSession 内 orphan 覆写真实跑

    const overwritten = readMainFileLastEntries().get("sa-async-ctl")!;
    expect(overwritten.status).toBe("idle");
    // 批域标记对非批成员恒 no-op：序列化产物不含该键（merge 无值可补）
    expect(Object.hasOwn(overwritten, "batchFinalized")).toBe(false);
    // result/model 修补对 async 成员同样生效（light 重建丢 result/model 的拉齐修复）
    expect(overwritten.result).toBe("async full result body");
    expect(overwritten.model).toBe("prov/async-m");
  });

  it("merge 保留方向反向锁定：子文件 identity 重建 model=A 非空 + 主文件残留 running 末条 model=B → 覆写 entry 取 rec 侧 A（仅补不覆盖）", () => {
    // 反向构造（既有用例只测「rec 侧空 → src 补齐」方向，恒取 src 的覆盖语义回归下
    // 仍绿）：rec 侧 model 来自子文件头部 model_change 的 light 重建（A），last 侧
    // model 来自主文件在飞残留 running entry（B≠A，kill -9 在飞死亡 + 轮中
    // model_change 的真实形态）→ 覆写 entry 必须保留 A。
    // [U4/D4] 纠偏前提 = 末条残留 running（轮终 idle 形态不触发覆写），故本用例
    // 末条种 running（在飞死亡），与 seedRoundTerminalEntries 的轮终 idle 序列分流。
    const childFile = writeChildSessionFile("sa-merge-dir", "merge direction task", "prov-child/child-m-a");
    const store = makeSeedStore();
    store.reportSubagentRecord(
      memberRecord({ id: "sa-merge-dir", sessionFile: childFile, model: "prov/round-m-b", result: "merge direction result" }),
    );

    const recoveryPi = makeWritingPi(mainFile);
    makeRecoveryService(recoveryPi); // initSession 内 orphan 覆写（merge 生效点）真实跑

    const overwritten = readMainFileLastEntries().get("sa-merge-dir")!;
    expect(overwritten.status).toBe("idle");
    // rec 侧 A（identity 重建值）胜出：merge 是「仅补 undefined/空值、不覆盖已有值」，
    // 恒取 src 的覆盖语义会把这里改写成 B —— pickStr 的 cur 半边由此锁定。
    expect(overwritten.model).toBe("prov-child/child-m-a");
    // 前提自检（非 vacuous）：src 侧 running entry（覆写前已落盘，仍在文件中）确携带
    // 异值 B——证明 cur 侧非空时 src 侧有可覆盖的异值被让位，而非「无源可取」。
    const allModels = fs.readFileSync(mainFile, "utf-8").split("\n")
      .filter((l) => l.includes(SUBAGENT_RECORD_CUSTOM_TYPE) && l.includes("sa-merge-dir"))
      .map((l) => (JSON.parse(l) as { data?: { model?: string } }).data?.model);
    expect(allModels).toContain("prov/round-m-b");
  });

  it("P-rebuild：投影字段不改变 entry-born 孤儿判定（register running 末条无子文件锚仍入判定覆写）", () => {
    // register 形态末条（running + sessionFile 字段在 entry 里），子文件不存在
    // ——recoverEntryOnlyOrphans 的「只认 running 末条」判定不应因投影字段
    // （sessionFile 等）而跳过该 id。
    const seedStore = makeSeedStore();
    seedStore.reportSubagentRecord(
      memberRecord({ id: "sa-p-rebuild", result: "round done", sessionFile: path.join(agentDir, "no-such-child.jsonl") }),
    );

    const pi = makeAssertPi();
    makeRecoveryService(pi); // initSession 内 recoverEntryOnlyOrphans 真实跑

    const entry = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .find((d) => d.id === "sa-p-rebuild");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("idle");
    // [U3 / §3.2.4] entry-born 纠偏一律保留 idle（直断 closed+gc+error 退役）
    expect(entry!.closedReason).toBeUndefined();
    expect(entry!.stopReason).toBe("interrupted-by-restart");
    expect(entry!.error).toBeUndefined();
  });

  // ============================================================
  // v2 断链 1 遗产 + 探针 P-manifest：批落标出口 manifest 落盘后，running manifest
  // 不得触发 collectRecords 孤儿补充投影——有子文件锚的成员永不被 manifest 补充
  // 投影覆盖（record-store byId.has 跳过语义）。
  // ============================================================

  it("P-manifest 不变量：子文件锚 + manifest 并存 → 重启重建 list 投影与删 manifest 后逐字段一致", () => {
    // 落标形态构造：子文件锚（identity/子文件重建源）+ markBatchFinalized 落标
    //（batchFinalized entry + manifest 同步落盘——批闭合 flush 的真实写面）。
    const childFile = writeChildSessionFile("sa-pm", "p-manifest task");
    const store = new RecordStore(
      getSubagentSessionDir(agentDir, agentDir),
      new ManifestStore(getSubagentRecordsDir(agentDir, agentDir)),
      makeWritingPi(mainFile),
      getSubagentRecordsDir(agentDir, agentDir),
    );
    // 种子：末条轮终 idle + 锚（子文件在）→ 落标（原语内部序：manifest 落盘完成先于
    // entry）。[modeless 波3] E1 已退役，落标数据源直接喂 record（与 flush 路径
    // getFullRecord 重建产物同构——本用例断言面在 manifest 存在性不变量，不在重建链）。
    void store.markBatchFinalized([
      memberRecord({ id: "sa-pm", sessionFile: childFile, status: "idle", stopReason: "completed", result: "p-manifest full result" }),
    ]);
    const manifestFile = path.join(getSubagentRecordsDir(agentDir, agentDir), "sa-pm.json");
    expect(fs.existsSync(manifestFile)).toBe(true);

    // 模拟重启重建：全新 RecordStore + ManifestStore（内存缓存零残留），manifest 存在时
    const freshStore = () =>
      new RecordStore(
        getSubagentSessionDir(agentDir, agentDir),
        new ManifestStore(getSubagentRecordsDir(agentDir, agentDir)),
      );
    const withManifest = freshStore().collectRecords(100, "all", ROOT_SESSION);
    const pm = withManifest.find((r) => r.id === "sa-pm");
    expect(pm).toBeDefined();
    // 投影来自子文件锚重建（[U3 / §3.2.4] 纠偏 idle + interrupted-by-restart，无
    // sidecar 落盘），非 manifest（status 下行投影）——closedReason 有无仍是可辨差异位
    expect(pm!.status).toBe("idle");
    expect(pm!.closedReason).toBeUndefined();
    expect(pm!.stopReason).toBe("interrupted-by-restart");

    // 删 manifest 文件 → 同款重建 → 投影逐字段一致（不变量：manifest 的存在不改变
    // list 形态——补充投影只服务「entry/子文件源完全缺失」的孤儿）
    fs.rmSync(manifestFile);
    const withoutManifest = freshStore().collectRecords(100, "all", ROOT_SESSION);
    expect(withoutManifest).toEqual(withManifest);
  });

  // ============================================================
  // S11：flushBatch 中 getFullRecord miss 成员用缓冲快照兜底落标
  // ============================================================

  it("S11：flushBatch 中 getFullRecord miss 成员用缓冲快照兜底落标", async () => {
    // 成员 1：失败终态（archive 出内存）且不写子文件 → getFullRecord 双 miss
    //（内存已出 + 子文件缺失——子文件被 GC/删除的窗口形态）；
    // 成员 2：SP-5 成功回退（留内存）→ getFullRecord 内存命中（正常落标对照）。
    const fake = makeRecoveryFake();
    // 写文件 pi：标记 entry 真实落盘主文件，扫描通路（rebuildEntryRecord）可重解析
    const pi = makeWritingPi(mainFile);
    const service = makeRecoveryService(pi);
    const spy = spyNotifier(service);
    const h1 = await service.execute({ task: "miss one", slug: "one", collect: "sync" });
    const h2 = await service.execute({ task: "full two", slug: "two", collect: "sync" });
    await until(() => fake.runs.length >= 2);

    // 成员 1 子文件故意缺失（getFullRecord miss 前提）；成员 2 内存命中不依赖子文件。
    // 注：两成员的 settle 链竞态可能拆两批（[U8] 合批窗口形态）——S11 断言与批切分
    // 无关，只锁「批成员并集覆盖」与「miss 成员兜底落标」。
    fake.runs[0]!.settle({ content: "boom-miss", error: "boom-miss" });
    fake.runs[1]!.settle({ content: "ok-full" });
    await until(() => spy.notifyBatch.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50)); // flushBatch 落标同步链排空

    // 批成员并集覆盖两成员（miss 成员随批写账，成员集 hash 口径不变）
    const batchIds = spy.notifyBatch.mock.calls
      .flatMap((c) => (c[0] as Array<{ id: string }>).map((m) => m.id))
      .sort();
    expect(batchIds).toEqual([h1.subagentId, h2.subagentId].sort());

    // 落标全员覆盖：miss 成员 h1 缓冲快照兜底 + full 成员 h2 正常落标
    //（修复前 h1 被跳过 → 无标记 → 批域排除判据失位）。
    // [modeless 波3] 标记 entry 每成员可出现两笔（flush 落标 + 自动 close 归档透传
    // ——archiveBatchMembers 把 batchFinalized 带进归档 entry，防 last-writer-wins
    // 抹掉落标标记），按成员去重断言覆盖。
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect([...new Set(marks.map((m) => m.id))].sort()).toEqual([h1.subagentId, h2.subagentId].sort());

    // 兜底标记 entry 经扫描通路可重解析且带标记（批域排除判据就位）
    const scanned = (service as unknown as { store: RecordStore }).store.scanLastRecordEntries(mainFile);
    const h1Last = scanned.find((r) => r.id === h1.subagentId);
    expect(h1Last).toBeDefined();
    expect(h1Last!.batchFinalized).toBe(true);
    // [U5] 失败轮 settle（markRoundIdle 落 idle，不终态化——
    // [two-state-convergence U4/D3] 翻边）——entry status 投影随之 idle
    expect(h1Last!.status).toBe("idle");
  });

  // ============================================================
  // [modeless 波3] 屏障失败 warn 留痕（D6 #7a/SC-1，flush 路径驱动）
  // ============================================================

  it("屏障失败 warn 留痕（D6 #7a/SC-1）：manifest 同步写失败不阻断投递，warn 含成员 id", async () => {
    // 直构 SyncCollectDomain（确定性单成员批 = 单次 writeAtomicFileSync 调用，
    // mockImplementationOnce 恰好命中）：成员 route 入批 → 去抖窗口闭合 flush。
    // 同步分支 try/catch 吞错 = 不阻断落标/写账投递（best-effort 与旧 allSettled 同源）。
    const store = new RecordStore(
      getSubagentSessionDir(agentDir, agentDir),
      undefined,
      makeWritingPi(mainFile),
      getSubagentRecordsDir(agentDir, agentDir),
    );
    const notifyBatch = vi.fn(() => true);
    const domain = new SyncCollectDomain({
      getStore: () => store,
      getNotifyHost: () => ({
        toNotifyRecord: (record: { id: string }) => ({
          id: record.id,
          status: "closed" as const,
          agent: "/agents/worker.md",
          model: "prov/m1",
          result: undefined,
          error: undefined,
          startedAt: 1000,
          endedAt: 2000,
        }),
        notify: () => {},
        notifyBatch,
      }),
      closeMembers: async () => {},
      getSessionRootId: () => ROOT_SESSION,
      getCollectSyncSection: () => undefined,
    });
    loggerMock.warn.mockClear(); // logger 模块级共享，计数从本用例起算
    vi.mocked(writeAtomicFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    domain.collectCoordinator.registerMember("sa-bar-fail");
    expect(
      domain.collectCoordinator.route({
        id: "sa-bar-fail",
        agent: "/agents/worker.md",
        model: "prov/m1",
        startedAt: 1000,
        endedAt: 2000,
        result: "barrier result",
      } as never),
    ).toBe("sync-flushed");
    // 去抖窗口到期 → flushBatch 闭包（屏障吞错 → 写账 → 落标 → close）
    await until(() => notifyBatch.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50)); // closeMembers 落标链排空

    // best-effort 语义：写账照常推进（反查索引缺失只影响指针行反查，不构成写账失败）
    expect(notifyBatch).toHaveBeenCalledTimes(1);
    // D6 #7a 适配（U1 同步分支 warn 形态）：message 含 sync write failed 语义 +
    // detail.id 定位成员。
    const barrierWarns = loggerMock.warn.mock.calls.filter((c) =>
      String(c[0]).startsWith("[subagents] batch-finalized manifest sync write failed"),
    );
    expect(barrierWarns).toHaveLength(1);
    expect((barrierWarns[0]![1] as { detail?: { id?: string } }).detail?.id).toBe("sa-bar-fail");
  });
});
