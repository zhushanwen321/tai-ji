// src/execution/__tests__/collect-coordinator-service.test.ts
//
// collectCoordinator 的 service 集成面（subagent-sync-collect U2）：
//   1. 偏差#4 落点：execute({collect:"sync"}) 的 record 落 collectMode="sync"
//      （观察者形态：subagent-record entry 落盘产物断言，非 mock record）；
//   2. notifyComplete 统一路由：sync 成员终态 → 协调器缓冲 → 单成员闭合 → 降级
//      flush → notifier.notify 收到该成员（观察点：替换 notifier.notify 为 spy，
//      闭包经 this 运行时读取，替换生效）；
//   3. async record（无 collect）直通同一 notifier.notify（现状路径字节不变）；
//   4. 偏差#3 接线：getCollectSyncDefault 读真实 config（缺省 async / 配置 sync +
//      reloadGlobalConfig 后生效）；
//   5. flush 屏障时序：manifest 写完成先于 notifyBatch 写账（通知可达 ⇒ 索引就位
//      的构造性保证，时序竞态修复）。
//
// mock 手法对齐 ended-message-and-fork-from.test.ts：[W3 改写] 替身从
// vi.mock session-runner（不 spawn 真子进程）改为协议 seam（registerFakePiEngine 替身，
// 测试显式 settle 应答）+ logger；record-store / config 走真实实现（tmpdir 自建自删，红线）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// [W3] execute 链经 executeViaEngine → kickOffChatRound → engine.run（协议替身）。
// 替身 run 挂起不自动 settle：测试取 fake.runs.at(-1) 显式 settle（受控时序——
// 原 runSpawnMock 的 resolve 时序控制等价面）。
import { clearEngines } from "../engine/registry.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";

import { getSubagentSessionDir, getSubagentRecordsDir } from "../path-encoding.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelRegistryLike } from "../model-resolver.ts";
import { SubagentService } from "../subagent-service.ts";

const IDENTITY_ENV_KEYS = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
] as const;

function makePi() {
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn(),
    on: vi.fn(),
  };
}

interface NotifierSpy {
  // Mock<T> 而非纯函数签名：测试断言消费 .mock.calls，需保留 mock 元数据
  notify: Mock<(record: unknown) => void>;
  /** U3：sync 批投递 spy。mock 返回 true（flushBatch 接线的落标 accepted 分支可达）。 */
  notifyBatch: Mock<(records: unknown, budget?: unknown) => boolean>;
}

/** 替换 service 私有 notifier 为仅覆盖 notify/notifyBatch 的 spy（保留其余方法；
 *  协调器 deps 闭包经 this 运行时读取，替换生效）。 */
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

/**
 * 异步链等待：手写短轮询（真实 timers）。
 * 为什么不用 vi.waitFor：vitest 4.1.8 本包环境下 vi.waitFor 对 falsy callback
 * 立即 resolve 不轮询不超时（sanity 用例实证：waitFor(()=>false,{timeout:100})
 * resolve(false) 而非 reject）——属测试基建缺陷，与被测链路无关，此处绕开。
 */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`collect-coordinator-service: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("collectCoordinator service integration (U2)", () => {
  let agentDir: string;
  let service: SubagentService;
  let pi: ReturnType<typeof makePi>;
  let fake: FakePiEnginePort;

  beforeEach(() => {
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
    clearEngines();
    fake = registerFakePiEngine();
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-collect-coord-"));
    fs.mkdirSync(getSubagentSessionDir(agentDir, agentDir), { recursive: true });
    pi = makePi();
    service = makeService(pi);
  });

  afterEach(() => {
    service.dispose();
    clearEngines();
    fs.rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeService(piInstance: ReturnType<typeof makePi>): SubagentService {
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    const modelRegistry: ModelRegistryLike = {
      getAvailable: () => [],
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
    modelService.initModel({
      sessionId: "root-session-cur",
      ctxModel: { id: "m", name: "M", provider: "p", reasoning: false },
      modelRegistry,
    });
    const created = new SubagentService({ cwd: agentDir, modelService });
    created.initSession({ pi: piInstance, sessionId: "root-session-cur" });
    return created;
  }

  it("stamps collectMode on the in-memory record visible to the coordinator routing (偏差#4 落点)", async () => {
    // 注：entry 落盘观察者断言（subagent-record entry 含 collectMode）依赖
    // record-store.recordToSubagent 投影扩展——U5 领地（偏差登记）；本用例锁
    // 内存 record 经协调器路由的可见行为：sync 成员终态 → 单成员闭合 → notifyBatch
    // 批投递（下方用例），async 成员直通。本条记录 execute 链零异常完成。
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "collect me", slug: "collect-me", collect: "sync" });
    await until(() => fake.runs.length >= 1);
    await settleLast();
    await until(() => spy.notifyBatch.mock.calls.length > 0);
    expect(handle.subagentId).toMatch(/^sa-/);
  });

  it("routes a finished sync member into a single-member batch (U3 接线：单成员闭合 → notifyBatch)", async () => {
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "collect me", slug: "collect-me", collect: "sync" });
    await until(() => fake.runs.length >= 1);
    await settleLast();
    await until(() => spy.notifyBatch.mock.calls.length > 0);
    // U3 接线后：sync 成员走单条批投递（不再逐条降级 notify）
    expect(spy.notify).not.toHaveBeenCalled();
    const batches = spy.notifyBatch.mock.calls.map((c) => c[0] as { id: string }[]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((m) => m.id)).toEqual([handle.subagentId]);
  });

  it("flushBatch accepted=false（幂等拒绝）时落标已前置完成（U3 归口：合一原语幂等覆写）", async () => {
    const spy = spyNotifier(service);
    spy.notifyBatch.mockReturnValue(false); // 模拟同成员集批已在账（E1 重建重发形态）
    const handle = await service.execute({ task: "collect me", slug: "collect-me", collect: "sync" });
    await until(() => fake.runs.length >= 1);
    await settleLast();
    await until(() => spy.notifyBatch.mock.calls.length > 0);
    expect(handle.subagentId).toMatch(/^sa-/);
    // [U3 批写归口] 落标随 markBatchFinalized 前置到写账前（合一原语形态下「屏障 →
    // 写账 → 落标」三段不可兼得，构造性 barrier 优先）：accepted=false（同成员集批
    // 已在账 = 该批此前成功投递时已落标）时本次落标属幂等覆写（appendEntry
    // last-writer-wins），E1 排除判据（collectMode=sync + batchFinalized）不受写账
    // 拒绝影响——防该成员以无标记形态被 E1 重收（异成员集 hash 不触发账本幂等）。
    const recordEntries = pi.appendEntry.mock.calls
      .filter((c) => c[0] === "subagent-record")
      .map((c) => c[1] as Record<string, unknown>);
    expect(recordEntries.length).toBeGreaterThan(0); // execute 链自身的 register/archive 在场
    expect(recordEntries.some((d) => d["id"] === handle.subagentId && d["batchFinalized"] === true)).toBe(true);
  });

  it("routes an async member through the same notifyAsync path (现状直通)", async () => {
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "plain", slug: "plain" });
    await until(() => fake.runs.length >= 1);
    await settleLast();
    await until(() => spy.notify.mock.calls.length > 0);
    const notified = spy.notify.mock.calls.map((c) => c[0] as { id: string });
    expect(notified.some((n) => n.id === handle.subagentId)).toBe(true);
  });

  it("getCollectSyncDefault reads real config (偏差#3 接线)", () => {
    // 无 config.json → 缺省 async
    expect(service.getCollectSyncDefault()).toBe("async");
    // 写入 collectSync.default=sync + reload → sync 生效
    const configPath = path.join(agentDir, "subagents", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, maxConcurrent: 6, collectSync: { default: "sync" } }),
      "utf-8",
    );
    const modelService = (service as unknown as { modelService: ModelConfigService }).modelService;
    modelService.reloadGlobalConfig();
    expect(service.getCollectSyncDefault()).toBe("sync");
    // E5 坏值回默认：非枚举 → async 兜底
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, maxConcurrent: 6, collectSync: { default: "immediate" } }),
      "utf-8",
    );
    modelService.reloadGlobalConfig();
    expect(service.getCollectSyncDefault()).toBe("async");
  });

  /** 伪造子 session 文件（record-store.test.ts 同款：header + identity + subagent-record
   *  entry）——落标通路 getFullRecord 冷路径重建的真实文件数据源（mock runSpawn 不产子文件）。 */
  function writeChildSessionFile(recordId: string, agent: string, result: string): void {
    const sessionsDir = getSubagentSessionDir(agentDir, agentDir);
    const ts = new Date(1000).toISOString();
    const header = JSON.stringify({
      type: "session", version: 3, id: `sess-${recordId}`, timestamp: ts, cwd: agentDir,
    });
    const identity = JSON.stringify({
      type: "custom", id: "id-1", parentId: null, timestamp: ts,
      customType: "subagent-identity",
      data: {
        id: recordId, agent, mode: "background", task: "collect me", startedAt: 1000,
        rootSessionId: "root-session-cur", depth: 0,
      },
    });
    const recordEntry = JSON.stringify({
      type: "custom", id: "id-2", parentId: "id-1", timestamp: ts,
      customType: "subagent-record",
      data: {
        v: 1, id: recordId, agent, task: "collect me", slug: "collect-me",
        status: "closed", mode: "background", startedAt: 1000,
        rootSessionId: "root-session-cur", parentRecordId: undefined, depth: 0,
        endedAt: 2000, turns: 1, totalTokens: 10, model: "prov/m1", thinkingLevel: undefined,
        eventLog: [], displayItems: [], result,
      },
    });
    fs.writeFileSync(path.join(sessionsDir, `${recordId}.jsonl`), `${header}\n${identity}\n${recordEntry}\n`, "utf-8");
  }

  /** 受控替身 settle：等替身 run 到位（execute 返回后的异步链内发起），按需 settle。
   *  原 runSpawnMock 受控 promise 的等价面（content "ok" 对齐原 AgentResult.text）。 */
  const settleLast = async (): Promise<void> => {
    await until(() => fake.runs.length >= 1);
    fake.runs[fake.runs.length - 1]!.settle({ content: "ok" });
  };

  it("跨轮续累（D2 service 层）：两轮派 2 sync → 闭合时单批 2 成员", async () => {
    const spy = spyNotifier(service);
    const h1 = await service.execute({ task: "t1", slug: "one", collect: "sync" });
    const h2 = await service.execute({ task: "t2", slug: "two", collect: "sync" });
    // engine.run 在 execute 返回后的异步链内才被发起——等两个替身 run 都到位
    await until(() => fake.runs.length >= 2);

    // 第一台终态：第二台仍 running → 缓冲不闭合（零投递）
    fake.runs[0]!.settle({ content: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 50)); // microtask 链排空
    expect(spy.notifyBatch.mock.calls).toHaveLength(0);

    // 第二台终态：闭合 → 单批 2 成员（含第一台的快照，跨轮续累不丢）
    fake.runs[1]!.settle({ content: "ok" });
    await until(() => spy.notifyBatch.mock.calls.length > 0);
    expect(spy.notifyBatch.mock.calls).toHaveLength(1);
    const batch = spy.notifyBatch.mock.calls[0]![0] as { id: string }[];
    expect(batch.map((m) => m.id).sort()).toEqual([h1.subagentId, h2.subagentId].sort());
    expect(spy.notify).not.toHaveBeenCalled();
  });

  it("batchFinalized 落标（真文件通路）：闭合 flush 写账成功后末条 entry 带标记（E1 排除判据）", async () => {
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "collect me", slug: "collect-me", collect: "sync" });
    await until(() => fake.runs.length >= 1); // 替身 run 已到位
    // 子 session 文件在闭合判定/flush 前就位（真实生产链中引擎轮次已写好 identity）
    writeChildSessionFile(handle.subagentId, "/agents/worker.md", "ok");
    await settleLast();
    await until(() => spy.notifyBatch.mock.calls.length > 0);

    // 观察者形态：主 session 落盘的末条 subagent-record entry 带 batchFinalized=true +
    // collectMode=sync（reportSubagentRecord 直投影 SubagentRecord，不经 recordToSubagent）。
    // status 不在此锁：one-shot 成功链走 SP-5 resumable 回退（record 留内存 running 态，
    // 真实形态），E1 排除判据只依赖 collectMode+batchFinalized 两字段。
    const marked = pi.appendEntry.mock.calls
      .filter((c) => c[0] === "subagent-record")
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d["id"] === handle.subagentId && d["batchFinalized"] === true);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.["collectMode"]).toBe("sync");
    expect(marked[0]?.["result"]).toBe("ok");
    expect(marked[0]?.["resumable"]).toBe(true); // SP-5 成功回退态（真链形态保真）
  });

  it("flush 屏障：manifest 写完成先于 notifyBatch 写账（通知可达 ⇒ 索引就位，构造性保证）", async () => {
    // 时序竞态修复（v2 D1 修订）：批通知路径的 manifest 写从「写账后 fire-and-forget」
    // 前移为「写账前 await 全部落盘」屏障——「通知可达 ⇒ 索引就位」从大概率成立升为
    // 构造性保证（by construction）。断言打在 notifyBatch（写账入口）被调用的时刻：
    // 磁盘上 records/<sa-id>.json 必已存在（修复前该时刻大概率 false，探针实测 mtime
    // 相对 notify entry ±2/3ms 方向不定）。
    const spy = spyNotifier(service);
    const handle = await service.execute({ task: "collect me", slug: "collect-me", collect: "sync" });
    await until(() => fake.runs.length >= 1); // 替身 run 已到位
    writeChildSessionFile(handle.subagentId, "/agents/worker.md", "ok");
    const manifestPath = path.join(getSubagentRecordsDir(agentDir, agentDir), `${handle.subagentId}.json`);
    // 写账时刻钩子：mock 内联捕获 manifest 存在性（此刻即指针行消费可用性）
    let manifestExistsAtLedgerWrite = false;
    spy.notifyBatch.mockImplementation(() => {
      manifestExistsAtLedgerWrite = fs.existsSync(manifestPath);
      return true;
    });
    await settleLast();
    await until(() => spy.notifyBatch.mock.calls.length > 0);
    expect(manifestExistsAtLedgerWrite).toBe(true);
  });
});
