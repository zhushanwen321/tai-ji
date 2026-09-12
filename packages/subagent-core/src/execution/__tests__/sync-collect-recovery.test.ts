// src/execution/__tests__/sync-collect-recovery.test.ts
//
// U5 崩溃恢复钩子（E1）+ dispose 转换（E9）的真实文件通路测试（subagent-sync-collect
// 设计 §3.1.5）。
//
// 通路保真（U8 红线：禁 mock record 断言）：
//   种子 entry 经真实 RecordStore.reportSubagentRecord → toSubagentRecordEntry 序列化
//   → 真实 appendFileSync 落 tmpdir 主 session JSONL → 恢复侧真实 readFileSync 扫描
//   （scanLastRecordEntries → collectLastRecordEntries + rebuildEntryRecord 投影）。
//   断言全部打在「磁盘文件内容 + 真实投影产物」上，scan/投影/序列化三层零 mock。
//
// 场景：
//   1. 标记与终态五字段可见性：collectMode/batchFinalized/status/endedAt/closedReason/
//      result/error 经末条 entry 重建后全部可见（rebuildEntryRecord 投影白名单扩展）；
//   2. E1 补发：崩溃残留（全员终态 + 无标记）→ manifest 屏障（await 落盘，先于
//      写账——「通知可达 ⇒ 索引就位」构造性保证）→ notifyBatch 单批补发（内容 = 末条终态
//      快照）+ 统一落标；async 成员 / 已标记成员（E9 排除）/ 异根成员均不入批；
//   3. E1 幂等窗口：账本同 hash 拒绝（accepted=false）也统一补标 → 标记落盘后二次
//      恢复零补发（收敛）；
//   4. E1 仍有 running：不补发，等自然终态；
//   5. E9 dispose：缓冲中已终态成员逐条转 async notify（放弃攒批）+ 落标；在跑成员
//      走现有退出路径（不通知）；
//   6. U4 deviation #8 接线：notifyBatch 收到 config 热读的 budget 参数。
//
// v2 断链 2+3（设计 subagent-sync-collect-v2.md §3.3 D3）真实序列种子（形态取自
// kill -9 真实链路，v1 教训：种子绕过 orphan 恢复直接写终态 entry = 测不到断链）：
//   7. 主用例（写文件 pi）：主文件种 register（running+sync）→ 轮终（running+
//      resumable+result 全文）两笔 entry，sessionsDir 构造子 session 文件（identity +
//      末行完整 JSON）且不写三 sidecar（分支 4 命中）→ initSession 后 orphan 覆写
//      （finalizeOrphanRecord 真实跑，merge 保留批标记与 result/model）→ E1 补发
//      单批 + 落标 → 二次重启零补发；
//   8. async 对照（同构造无 collectMode）：覆写 entry 批域字段不出现、result 按
//      merge 补齐（拉齐修复口径）；
//   9. 豁免路径（断言 pi，覆写不落盘）：E1 直读轮终 running+resumable entry 走
//      resumable 豁免判定 → 补发可达（判定侧另一分支，与协调器 hasRunningSync 同构）；
//  10. P-rebuild：rebuildEntryRecord 新投影字段（resumable/sessionFile）不改变
//      recoverEntryOnlyOrphans 的「只认 running 末条」候选判定；
//  11. v2 断链 4（设计 §3.3 D4）延迟闭合：E1 waiting → 注册 settled 有界重扫 →
//      成员补种终态 entry → settled 边沿重扫补发单批 + 落标 → 后续 settled 零处理；
//  12. D4 上限：成员恒 running → settled 驱动 8 次重扫达限 → disposed（warn 留痕含滞留 id，
//      D6 #7b/SC-2），第 9 次（成员此刻已终态）不再扫描；
//  13. v2 断链 1（设计 §3.3 D1/D2）E1 路径 manifest：写账前屏障 await 补写
//      records/<sa-id>.json（时序竞态修订：原落标出口 fire-and-forget）——成功成员
//      status 如实投影 "running"（豁免形态末条）/"closed"（覆写后末条），sessionFile
//      投影（W1 前置依赖）随批补发就位；
//  14. P-manifest 不变量：子文件锚 + manifest 并存 → 重启重建 collectRecords 投影
//      与删 manifest 后一致（byId.has 跳过语义：有子文件锚的成员永不被 manifest
//      补充投影覆盖，running manifest 不改变 list 形态）；
//  15. D4 dispose 惰化：E1 waiting → dispose() → trailing settled 边沿不扫描不落标
//      （notifier 已 dispose，跑了 notifyBatch 必 false 不写账而落标照发 → 通知永久
//      丢失；惰化后通知留给下次重启 E1 兑现）；
//  16. D3 merge 保留方向反向锁定：子文件头部 model_change 重建 model=A 非空 + 主
//      文件轮终 entry model=B（≠A）→ 覆写 entry 取 rec 侧 A（仅补不覆盖——防未来
//      被改成恒取 src 的覆盖语义而既有只测「补齐方向」的用例仍绿）。
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
// 随之迁移到本模块（默认透传真实现，仅「屏障失败」用例内 mockImplementationOnce）。
vi.mock("../../shared/atomic-write.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/atomic-write.ts")>();
  return { ...actual, writeAtomicFileSync: vi.fn(actual.writeAtomicFileSync) };
});

// [W3 改写] mock session-runner（execute 链 runSpawn 替身）随 inproc pi 引擎目录 删除消亡——
// execute 链改为协议 seam（registerFakePiEngine 替身 + 显式 settle 应答）。
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";

import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../record-entry.ts";
import { ManifestStore } from "../manifest-store.ts";
import { ModelConfigService } from "../model-config-service.ts";
import type { ModelRegistryLike } from "../model-resolver.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../path-encoding.ts";
import { RecordStore } from "../record-store.ts";
import type { SubagentRecord } from "../types.ts";
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

/** settled handler 捕获 + 驱动（D4 重扫用例用）：pi 实装为列表分发（P-settled 定谳，
 *  0.84.4 dist loader.js on() push 进数组 + runner.js emit() 遍历全部 handler 并逐一
 *  await），捕获数组同构——emitAgentSettled 逐一 await 已注册 handler（D4 重扫
 *  handler 已 async 化：E1 补发前有 manifest 屏障 await），模拟一次 settled 边沿。 */
interface SettledDriver {
  /** 驱动一次 agent_settled 边沿（快照遍历，防 handler 内注册/变异干扰本轮）。 */
  emitAgentSettled(): Promise<void>;
}

// on/sendMessage 给显式 Mock 签名：vi.fn() 默认 Mock<Procedure | Constructable>
// 不可赋给 PiLike 的具名方法签名（PiLike 结构兼容要求参数可逆变）
function settledCapture(): {
  driver: SettledDriver;
  on: Mock<(event: string, handler: () => void | Promise<void>) => void>;
} {
  const handlers: Array<() => void | Promise<void>> = [];
  return {
    driver: {
      emitAgentSettled: async () => {
        for (const h of [...handlers]) await h();
      },
    },
    on: vi.fn((event: string, handler: () => void | Promise<void>) => {
      if (event === "agent_settled") handlers.push(handler);
    }),
  };
}

/** 种子 pi：appendEntry 真写主 session JSONL（每 entry 一行，pi 落盘形态）。 */
function makeWritingPi(mainFile: string) {
  const { driver, on } = settledCapture();
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
    on,
    emitAgentSettled: driver.emitAgentSettled,
  };
}

/** 断言 pi：appendEntry 只记录不落盘（断言恢复侧写点用）。 */
function makeAssertPi() {
  const { driver, on } = settledCapture();
  return {
    appendEntry: vi.fn(),
    events: { emit: vi.fn() },
    sendMessage: vi.fn((_m: unknown, _o?: unknown) => {}),
    on,
    emitAgentSettled: driver.emitAgentSettled,
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
    chatMode: false,
    collectMode: "sync",
    ...overrides,
  };
}

describe("sync collect recovery (U5 E1/E9) — 真实文件通路", () => {
  let agentDir: string;
  let mainFile: string;

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_STRIP) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-sync-recovery-"));
    fs.mkdirSync(getSubagentSessionDir(agentDir, agentDir), { recursive: true });
    mainFile = path.join(agentDir, "main-session.jsonl");
  });

  afterEach(() => {
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

  /** 恢复侧 service：断言 pi（覆写不落盘，断言内存面）/ 写文件 pi（覆写真实落盘，
   *  E1 读覆写后末条——kill -9 真实链路同构）两用。 */
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

  /** 种下「崩溃前主文件末条序列」：register（running+sync）→ 轮终（running+
   *  resumable + result 全文 + sessionFile）——成功成员崩溃时的真实末条形态
   *  （SP-5 one-shot 轮终写点，finalize-record.ts doFinalizeRoundToIdle）。
   *  collectMode 必须显式传（"sync" 主用例 / undefined async 对照）——不可给默认值：
   *  JS 默认参数对显式 undefined 也触发，async 对照会被默认 "sync" 污染。 */
  function seedRoundTerminalEntries(id: string, childFile: string, result: string, model: string, collectMode: "sync" | undefined): void {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id, sessionFile: childFile, model, collectMode }));
    store.reportSubagentRecord(memberRecord({ id, sessionFile: childFile, model, collectMode, resumable: true, result }));
  }

  it("标记与终态五字段经真实落盘→扫描投影后可见（rebuildEntryRecord 白名单扩展）", () => {
    const store = makeSeedStore();
    // 成员 A：register（running+sync）→ 终态（closed + gc + result）两笔真实 entry
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({
        id: "sa-a",
        status: "closed",
        closedReason: "gc",
        endedAt: 2000,
        result: "done-A",
      }),
    );
    // 成员 B：failed 终态（error 字段）
    store.reportSubagentRecord(memberRecord({ id: "sa-b" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-b", status: "closed", closedReason: "gc", endedAt: 3000, error: "boom" }),
    );
    // 成员 C：已落标（batchFinalized，E9/flush 后形态）
    store.reportSubagentRecord(
      memberRecord({ id: "sa-c", status: "closed", closedReason: "gc", endedAt: 4000, batchFinalized: true }),
    );
    // 成员 D：async（无 collectMode）终态
    store.reportSubagentRecord(
      memberRecord({ id: "sa-d", status: "closed", closedReason: "gc", endedAt: 5000, collectMode: undefined }),
    );

    // 恢复侧：真实 readFileSync 扫描 + 投影（零 mock；store 经测试后门访问，与
    // collect-coordinator-service.test.ts 访问 notifier 同款手法）
    const recovery = makeRecoveryService(makeAssertPi());
    const scanned = (recovery as unknown as { store: RecordStore }).store.scanLastRecordEntries(mainFile);
    const byId = new Map(scanned.map((r) => [r.id, r]));

    // 终态五字段 + 两标记字段全可见（末条 last-writer-wins）
    const a = byId.get("sa-a");
    expect(a).toBeDefined();
    expect(a!.status).toBe("closed");
    expect(a!.endedAt).toBe(2000);
    expect(a!.closedReason).toBe("gc");
    expect(a!.result).toBe("done-A");
    expect(a!.error).toBeUndefined();
    expect(a!.collectMode).toBe("sync");
    expect(a!.batchFinalized).toBeUndefined();

    const b = byId.get("sa-b");
    expect(b!.error).toBe("boom");
    expect(b!.result).toBeUndefined();

    expect(byId.get("sa-c")!.batchFinalized).toBe(true);
    expect(byId.get("sa-d")!.collectMode).toBeUndefined();
  });

  it("E1 补发：全员终态无标记 → notifyBatch 单批（末条终态快照）+ 统一落标；async/已标记/异根排除", async () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );
    store.reportSubagentRecord(memberRecord({ id: "sa-b" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-b", status: "closed", closedReason: "gc", endedAt: 3000, error: "boom" }),
    );
    // 排除面 1：async 终态成员不入批
    store.reportSubagentRecord(
      memberRecord({ id: "sa-async", status: "closed", closedReason: "gc", endedAt: 4000, collectMode: undefined }),
    );
    // 排除面 2：已标记成员（E9 转换后重启形态）不入批
    store.reportSubagentRecord(
      memberRecord({ id: "sa-marked", status: "closed", closedReason: "gc", endedAt: 5000, batchFinalized: true }),
    );
    // 排除面 3：异根成员不入批
    store.reportSubagentRecord(
      memberRecord({ id: "sa-foreign", status: "closed", closedReason: "gc", endedAt: 6000, rootSessionId: "other-root" }),
    );

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const spy = spyNotifier(recovery);
    // 屏障断言钩子（严格时序门）：notifyBatch（写账入口）被调用的时刻，成员 manifest
    // 必已在磁盘——「通知可达 ⇒ 索引就位」的构造性保证（修复前 manifest 在写账后
    // fire-and-forget 写，该时刻只大概率成立）。
    let manifestExistsAtLedgerWrite = false;
    spy.notifyBatch.mockImplementation(() => {
      manifestExistsAtLedgerWrite = fs.existsSync(
        path.join(getSubagentRecordsDir(agentDir, agentDir), "sa-a.json"),
      );
      return true;
    });
    await recovery.recoverSyncCollectBatch();

    // 单批补发：只有 sa-a / sa-b 入批，内容 = 末条终态快照
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    const batch = spy.notifyBatch.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(batch.map((m) => m.id).sort()).toEqual(["sa-a", "sa-b"]);
    const a = batch.find((m) => m.id === "sa-a")!;
    expect(a.status).toBe("closed");
    expect(a.result).toBe("done-A");
    expect(a.closedReason).toBe("gc");
    const b = batch.find((m) => m.id === "sa-b")!;
    expect(b.error).toBe("boom");
    // 单条 notify 零调用（补发形态是批，不是逐条）
    expect(spy.notify).not.toHaveBeenCalled();
    // E1 屏障：写账时刻成员 manifest 已落盘（严格时序门）
    expect(manifestExistsAtLedgerWrite).toBe(true);

    // 统一落标：两成员各一笔 batchFinalized entry（appendEntry 直投影，含终态快照）
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks.map((m) => m.id).sort()).toEqual(["sa-a", "sa-b"]);
  });

  it("屏障失败 warn 留痕（D6 #7a/SC-1）：manifest 同步写失败不阻断补发，warn 含成员 id（U1 同步分支形态）", async () => {
    const childFile = writeChildSessionFile("sa-bar-fail", "barrier fail task");
    seedRoundTerminalEntries("sa-bar-fail", childFile, "barrier result", "prov/bar-m", "sync");

    const recovery = makeRecoveryService(makeAssertPi());
    const spy = spyNotifier(recovery);
    loggerMock.warn.mockClear(); // logger 模块级共享，计数从本用例起算
    // [U3 适配] 构造点接线 manifestDir 后屏障走 writeAtomicFileSync 同步分支——失败
    // 注入面从 manifestStore.writeManifest（异步降级分支打桩）迁至原子写模块。单成员
    // 批 = 单次调用，mockImplementationOnce 恰好命中；同步分支 try/catch 吞错 =
    // 不阻断落标/写账投递（best-effort 与旧 allSettled 同源）。
    vi.mocked(writeAtomicFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });

    await recovery.recoverSyncCollectBatch();

    // best-effort 语义：写账照常推进（反查索引缺失只影响指针行反查，不构成写账失败）
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    // D6 #7a 适配（U1 同步分支 warn 形态）：message 含 sync write failed 语义 +
    // detail.id 定位成员（manifest 路径由 recordsDir/<id>.json 推导——异步分支的
    // 路径直书线索未纳入 U1 同步分支实装，按现行为断言）。
    const barrierWarns = loggerMock.warn.mock.calls.filter((c) =>
      String(c[0]).startsWith("[subagents] batch-finalized manifest sync write failed"),
    );
    expect(barrierWarns).toHaveLength(1);
    expect((barrierWarns[0]![1] as { detail?: { id?: string } }).detail?.id).toBe("sa-bar-fail");
  });

  it("E1 幂等窗口：账本同 hash 拒绝（accepted=false）也统一补标 → 标记落盘后二次恢复零补发", async () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );

    // 第一次恢复：notifyBatch 返回 false（模拟「批闭合写账成功、落标前崩溃」后账本已在该批）
    const pi1 = makeAssertPi();
    const first = makeRecoveryService(pi1);
    const spy1 = spyNotifier(first);
    spy1.notifyBatch.mockReturnValue(false);
    await first.recoverSyncCollectBatch();
    expect(spy1.notifyBatch).toHaveBeenCalledTimes(1);
    // 账本拒绝也算已投递 → 仍统一补标
    const marks1 = pi1.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks1.map((m) => m.id)).toEqual(["sa-a"]);

    // 标记真实落盘（写文件 pi 把补标 entry 追加进主文件——flush 后形态）
    const seedForMark = makeSeedStore();
    seedForMark.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A", batchFinalized: true }),
    );

    // 第二次恢复：全员已标记 → 零补发零 notify（收敛，无振荡）
    const second = makeRecoveryService(makeAssertPi());
    const spy2 = spyNotifier(second);
    await second.recoverSyncCollectBatch();
    expect(spy2.notifyBatch).not.toHaveBeenCalled();
    expect(spy2.notify).not.toHaveBeenCalled();
  });

  it("E1 仍有 running 成员：不补发不落标（等自然终态走正常流）", async () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );
    // 在跑成员：末条 running（子进程活到重启后的形态）
    store.reportSubagentRecord(memberRecord({ id: "sa-running" }));

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const spy = spyNotifier(recovery);
    await recovery.recoverSyncCollectBatch();

    expect(spy.notifyBatch).not.toHaveBeenCalled();
    expect(spy.notify).not.toHaveBeenCalled();
    expect(
      pi.appendEntry.mock.calls
        .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
        .map((c) => c[1] as Record<string, unknown>)
        .some((d) => d.batchFinalized === true),
    ).toBe(false);
  });

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
    expect(marks[0]!.collectMode).toBe("sync");
    expect(marks[0]!.result).toBe("ok-terminal");
  });

  it("U4 deviation #8 接线：config collectSync 预算热读传入 notifyBatch budget 参数", async () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );
    // 写 config（collectSync 预算字段）+ reload —— 与 getCollectSyncDefault 同款访问链
    const configPath = path.join(agentDir, "subagents", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, maxConcurrent: 6, collectSync: { default: "sync", perItemChars: 1234, totalChars: 5678 } }),
      "utf-8",
    );

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const modelService = (recovery as unknown as { modelService: ModelConfigService }).modelService;
    modelService.reloadGlobalConfig();
    const spy = spyNotifier(recovery);
    await recovery.recoverSyncCollectBatch();

    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    expect(spy.notifyBatch.mock.calls[0]![1]).toEqual({ perItemChars: 1234, totalChars: 5678 });

    // 文件末条确为无标记终态（本用例的数据前提自检）
    const last = readMainFileLastEntries().get("sa-a");
    expect(last!.batchFinalized).toBeUndefined();
  });

  // ============================================================
  // v2 断链 2+3（设计 §3.3 D3）：orphan 覆写 merge + E1 resumable 豁免。
  // 种子形态取自 kill -9 真实链路（v1 教训：绕过 orphan 恢复直接写终态 entry
  // 测不到断链——主文件两笔 entry + 子文件 + 无三 sidecar，让 finalizeOrphanRecord
  // 与 E1 在同一测试里真实跑）。
  // ============================================================

  it("kill -9 同构主用例：orphan 覆写 merge 保留批标记与 result/model → E1 补发单批 + 落标 → 二次重启零补发", async () => {
    // ── 崩溃前形态：register（running+sync）→ 轮终（running+resumable+result 全文）──
    const childFile = writeChildSessionFile("sa-kill9", "kill -9 crash task");
    seedRoundTerminalEntries("sa-kill9", childFile, "kill-9 full result body", "prov/round-m", "sync");

    // ── 重启恢复（写文件 pi：orphan 覆写 entry 真实落盘，E1 读覆写后末条）──
    // initSession 内已真实跑 orphan 恢复（ENV 已剥 → 根进程判定 → finalizeOrphanRecord）。
    const recoveryPi = makeWritingPi(mainFile);
    const recovery = makeRecoveryService(recoveryPi);

    // 断链 2 核心断言：覆写 entry（主文件末条）保留批域标记与轮终正文/模型——
    // 重建矩阵不含这些字段，不 merge 就会被覆写抹掉（E1 候选集恒空的真根因）。
    const overwritten = readMainFileLastEntries().get("sa-kill9")!;
    expect(overwritten.status).toBe("closed");
    expect(overwritten.closedReason).toBe("gc");
    expect(overwritten.collectMode).toBe("sync");
    expect(overwritten.result).toBe("kill-9 full result body");
    expect(overwritten.model).toBe("prov/round-m");
    // 防重锚落盘（覆写已判终态，二次重启不再进判定）
    expect(fs.existsSync(`${childFile}.state`)).toBe(true);

    // ── E1 真实跑：末条（覆写后 closed entry）候选命中 → 补发 + 落标 ──
    const spy = spyNotifier(recovery);
    await recovery.recoverSyncCollectBatch();
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    expect(spy.notify).not.toHaveBeenCalled();
    const batch = spy.notifyBatch.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(batch).toHaveLength(1);
    expect(batch[0]!.id).toBe("sa-kill9");
    // 成功成员正文含 result 全文（来自覆写 entry 的 merge 保留，非 "(empty)"）
    expect(batch[0]!.result).toBe("kill-9 full result body");
    expect(batch[0]!.status).toBe("closed");

    // 补发后落标 batchFinalized（主文件末条）
    const marked = readMainFileLastEntries().get("sa-kill9")!;
    expect(marked.batchFinalized).toBe(true);
    expect(marked.collectMode).toBe("sync");

    // [v2 D1] E1 路径 manifest：写账前屏障 await 补写 records/<sa-id>.json（时序
    // 竞态修订：原为落标出口 fire-and-forget），反查索引随补发就位（指针行消费前
    // 可得——await 返回时屏障已完成，无需轮询）。覆写后 closed 重建快照 → status
    // 如实投影 "closed"；sessionFile 来自 W1 的 rebuildEntryRecord 投影扩展。
    const manifestFile = path.join(getSubagentRecordsDir(agentDir, agentDir), "sa-kill9.json");
    expect(fs.existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: "sa-kill9",
      rootSessionId: ROOT_SESSION,
      agentName: "/agents/worker.md",
      status: "closed",
      sessionFile: childFile,
    });

    // ── 二次重启（V2 验收「零重发」）：已标记 → 候选空 → 零补发 ──
    const second = makeRecoveryService(makeAssertPi());
    const spy2 = spyNotifier(second);
    await second.recoverSyncCollectBatch();
    expect(spy2.notifyBatch).not.toHaveBeenCalled();
    expect(spy2.notify).not.toHaveBeenCalled();
  });

  it("async 对照：覆写 entry 批域字段不出现，result/model 按 merge 补齐（拉齐修复口径）", () => {
    const childFile = writeChildSessionFile("sa-async-ctl", "async crash task");
    // 同构造但无 collectMode（undefined 覆盖 memberRecord 默认 "sync"）
    seedRoundTerminalEntries("sa-async-ctl", childFile, "async full result body", "prov/async-m", undefined);

    const recoveryPi = makeWritingPi(mainFile);
    makeRecoveryService(recoveryPi); // initSession 内 orphan 覆写真实跑

    const overwritten = readMainFileLastEntries().get("sa-async-ctl")!;
    expect(overwritten.status).toBe("closed");
    // 批域字段对非 sync 成员恒 no-op：序列化产物不含这两键（merge 无值可补）
    expect(Object.hasOwn(overwritten, "collectMode")).toBe(false);
    expect(Object.hasOwn(overwritten, "batchFinalized")).toBe(false);
    // result/model 修补对 async 成员同样生效（light 重建丢 result/model 的拉齐修复）
    expect(overwritten.result).toBe("async full result body");
    expect(overwritten.model).toBe("prov/async-m");
  });

  it("merge 保留方向反向锁定：子文件 identity 重建 model=A 非空 + 主文件轮终 model=B → 覆写 entry 取 rec 侧 A（仅补不覆盖）", () => {
    // 反向构造（既有用例只测「rec 侧空 → src 补齐」方向，恒取 src 的覆盖语义回归下
    // 仍绿）：rec 侧 model 来自子文件头部 model_change 的 light 重建（A），last 侧
    // model 来自主文件轮终 entry（B≠A）→ 覆写 entry 必须保留 A。
    const childFile = writeChildSessionFile("sa-merge-dir", "merge direction task", "prov-child/child-m-a");
    seedRoundTerminalEntries("sa-merge-dir", childFile, "merge direction result", "prov/round-m-b", "sync");

    const recoveryPi = makeWritingPi(mainFile);
    makeRecoveryService(recoveryPi); // initSession 内 orphan 覆写（merge 生效点）真实跑

    const overwritten = readMainFileLastEntries().get("sa-merge-dir")!;
    expect(overwritten.status).toBe("closed");
    // rec 侧 A（identity 重建值）胜出：merge 是「仅补 undefined/空值、不覆盖已有值」，
    // 恒取 src 的覆盖语义会把这里改写成 B —— pickStr 的 cur 半边由此锁定。
    expect(overwritten.model).toBe("prov-child/child-m-a");
    // 前提自检（非 vacuous）：src 侧轮终 entry（覆写前已落盘，仍在文件中）确携带
    // 异值 B——证明 cur 侧非空时 src 侧有可覆盖的异值被让位，而非「无源可取」。
    const allModels = fs.readFileSync(mainFile, "utf-8").split("\n")
      .filter((l) => l.includes(SUBAGENT_RECORD_CUSTOM_TYPE) && l.includes("sa-merge-dir"))
      .map((l) => (JSON.parse(l) as { data?: { model?: string } }).data?.model);
    expect(allModels).toContain("prov/round-m-b");
  });

  it("豁免路径：轮终 running+resumable 末条（覆写不落盘）→ E1 resumable 豁免 → 补发可达 + manifest 如实投影 running", async () => {
    const childFile = writeChildSessionFile("sa-exempt", "exempt path task");
    seedRoundTerminalEntries("sa-exempt", childFile, "exempt full result body", "prov/round-m", "sync");

    // 断言 pi：orphan 覆写 entry 不落盘——主文件末条保持轮终 running+resumable 形态，
    // E1 读的是该 entry（覆写不可达的防御分支残余，正是豁免口径要覆盖的形态）。
    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);

    // 前提自检：主文件末条仍是轮终 running+resumable（旧口径 status !== "closed"
    // 会把它顶死在「等自然终态」，本用例锁定豁免判定让补发可达）。
    const lastBefore = readMainFileLastEntries().get("sa-exempt")!;
    expect(lastBefore.status).toBe("running");
    expect(lastBefore.resumable).toBe(true);

    const spy = spyNotifier(recovery);
    await recovery.recoverSyncCollectBatch();
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    const batch = spy.notifyBatch.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(batch[0]!.id).toBe("sa-exempt");
    // 补发内容 = 轮终快照（result 全文；resumable 投影使豁免判定可见）
    expect(batch[0]!.result).toBe("exempt full result body");

    // 落标 entry（断言 pi 的内存面）：覆写被豁免放行的成员同样统一补标
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks.map((m) => m.id)).toEqual(["sa-exempt"]);

    // [v2 D1/D2 断链 1] E1 补发路径（rebuildEntryRecord 重建快照来源）的 manifest：
    // 写账前屏障 await 补写（await 返回时必在场），成功成员此刻实态 running+
    // resumable → status 如实投影 "running"（D2：不撒谎写 closed）；sessionFile
    // 来自 W1 的投影扩展（前置依赖）。
    const manifestFile = path.join(getSubagentRecordsDir(agentDir, agentDir), "sa-exempt.json");
    expect(fs.existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: "sa-exempt",
      rootSessionId: ROOT_SESSION,
      agentName: "/agents/worker.md",
      status: "running",
      createdAt: 1000,
      sessionFile: childFile,
    });
  });

  // ============================================================
  // v2 断链 4（设计 §3.3 D4）：E1 等待分支的 settled 有界重扫。等待不再死等——
  // 成员延迟终态（冷路径 resume → 正常流落 entry）由 settled 边沿驱动重扫收敛。
  // ============================================================

  it("D4 延迟闭合：E1 仍有 running → 注册 settled 重扫（单注册）→ 成员补种终态 entry → 边沿重扫补发单批+落标 → disposed", async () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );
    // 在跑成员：末条 running（子进程活到重启后的形态，与既有 waiting 用例同构造）
    store.reportSubagentRecord(memberRecord({ id: "sa-late" }));

    // 断言 pi：orphan 覆写不落盘 → 主文件末条保持 running，E1 走等待分支（前提自检）
    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const spy = spyNotifier(recovery);
    await recovery.recoverSyncCollectBatch();

    // 等待分支：零补发 + 注册 settled 重扫恰一次（agent_settled 单注册断言）
    expect(spy.notifyBatch).not.toHaveBeenCalled();
    const settledRegistrations = pi.on.mock.calls.filter((c) => c[0] === "agent_settled");
    expect(settledRegistrations).toHaveLength(1);

    // 成员延迟终态：冷路径 resume → 正常流终态落 entry（reportSubagentRecord 真实写点同构）
    const lateStore = makeSeedStore();
    lateStore.reportSubagentRecord(
      memberRecord({ id: "sa-late", status: "closed", endedAt: 9000, result: "late full result" }),
    );

    // settled 边沿 → 重扫一次（await 完整补发链：manifest 屏障 → 写账 → 落标）：
    // 全员终态 → 补发单批（两成员，含延迟成员 result 全文）
    await pi.emitAgentSettled();
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    const batch = spy.notifyBatch.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(batch.map((m) => m.id).sort()).toEqual(["sa-a", "sa-late"]);
    expect(batch.find((m) => m.id === "sa-late")!.result).toBe("late full result");

    // 重扫落标：两成员统一补 batchFinalized（断言 pi 内存面）
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks.map((m) => m.id).sort()).toEqual(["sa-a", "sa-late"]);

    // disposed 验证：补发完成后再驱动 settled 边沿 → 零处理（无第二次补发）
    await pi.emitAgentSettled();
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
  });

  it("D4 上限：成员恒 running → settled 驱动 8 次重扫达限 disposed（warn 留痕含滞留 id，D6 #7b）→ 第 9 次（成员已终态）不再扫描", async () => {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-stuck" }));

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const spy = spyNotifier(recovery);
    loggerMock.debug.mockClear(); // logger 是模块级共享，计数从本用例起算
    await recovery.recoverSyncCollectBatch();
    expect(spy.notifyBatch).not.toHaveBeenCalled();
    expect(pi.on.mock.calls.filter((c) => c[0] === "agent_settled")).toHaveLength(1);

    // 连续 8 次 settled：每次重扫（成员末条恒 running → 每次都判「仍在等」）。
    // waiting 判定过滤用消息前缀精确匹配（达限日志文案同样含 "still running" 词）。
    const e1WaitingLogs = () => loggerMock.debug.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("[subagents] E1 sync batch recovery:"));
    for (let i = 0; i < 8; i++) await pi.emitAgentSettled();
    // 首扫 1 + 重扫 8 = 9 次 waiting 判定留痕；达限 warn 恰一次（D6 #7b/SC-2：debug→warn，含滞留成员 id）
    expect(e1WaitingLogs()).toHaveLength(9);
    const limitCalls = loggerMock.warn.mock.calls.filter((c) =>
      String(c[0]).startsWith("[subagents] E1 settled rescan: reached limit"),
    );
    expect(limitCalls).toHaveLength(1);
    expect(limitCalls[0]![1]).toEqual({ ids: ["sa-stuck"] });
    expect(spy.notifyBatch).not.toHaveBeenCalled();

    // 第 9 次驱动时成员已补种终态：disposed 不再扫描（零补发 + waiting 日志不增）
    const lateStore = makeSeedStore();
    lateStore.reportSubagentRecord(
      memberRecord({ id: "sa-stuck", status: "closed", endedAt: 9500, result: "too late" }),
    );
    await pi.emitAgentSettled();
    expect(spy.notifyBatch).not.toHaveBeenCalled();
    expect(e1WaitingLogs()).toHaveLength(9);
  });

  it("D4 dispose 惰化：E1 waiting → dispose() → trailing settled 边沿不扫描不落标（通知不丢失）", async () => {
    // 与「D4 延迟闭合」同构造（成员补种终态 + settled 边沿 → 补发落标）作对照：
    // 本用例在边沿前插入 dispose()——handler 已惰化，扫描/补发/落标全不发生。
    // 失败模式（修复前）：dispose 后 notifier 已 dispose → notifyBatch 短路 false
    // 且不写账，而 E1 dispatched 段不判 accepted 仍统一落标 → 批被标 batchFinalized
    // 而通知从未写账（永久丢失）；惰化后通知由下次重启 E1 首扫兑现（无标记可达）。
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-a" }));
    store.reportSubagentRecord(
      memberRecord({ id: "sa-a", status: "closed", closedReason: "gc", endedAt: 2000, result: "done-A" }),
    );
    // 在跑成员：末条 running → E1 走等待分支并注册 settled 重扫
    store.reportSubagentRecord(memberRecord({ id: "sa-late" }));

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);
    const spy = spyNotifier(recovery);
    await recovery.recoverSyncCollectBatch();
    expect(spy.notifyBatch).not.toHaveBeenCalled();
    expect(pi.on.mock.calls.filter((c) => c[0] === "agent_settled")).toHaveLength(1);

    // session_shutdown：dispose 惰化重扫 handler
    recovery.dispose();

    // 成员补种终态 + trailing settled 边沿：handler 已惰化 → 零扫描（无 E1 日志）
    const lateStore = makeSeedStore();
    lateStore.reportSubagentRecord(
      memberRecord({ id: "sa-late", status: "closed", endedAt: 9000, result: "late full result" }),
    );
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    await pi.emitAgentSettled();
    expect(spy.notifyBatch).not.toHaveBeenCalled();
    const e1Logs = () =>
      [...loggerMock.debug.mock.calls, ...loggerMock.warn.mock.calls]
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith("[subagents] E1"));
    expect(e1Logs()).toHaveLength(0);

    // 不落标：无 batchFinalized entry —— 通知不写账也不封门，留给下次重启兑现
    expect(
      pi.appendEntry.mock.calls
        .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
        .map((c) => c[1] as Record<string, unknown>)
        .some((d) => d.batchFinalized === true),
    ).toBe(false);
  });

  it("P-rebuild：新投影字段不改变 entry-born 孤儿判定（轮终 running 末条无子文件锚仍入判定覆写）", () => {
    // 轮终形态末条（running + resumable + sessionFile 字段在 entry 里），子文件不
    // 存在——recoverEntryOnlyOrphans 的「只认 running 末条」判定不应因新投影字段
    // （resumable/sessionFile）而跳过该 id（resumable 豁免只在 E1 口径，不在
    // entry-born 域）。
    const seedStore = makeSeedStore();
    seedStore.reportSubagentRecord(
      memberRecord({ id: "sa-p-rebuild", resumable: true, result: "round done", sessionFile: path.join(agentDir, "no-such-child.jsonl") }),
    );

    const pi = makeAssertPi();
    makeRecoveryService(pi); // initSession 内 recoverEntryOnlyOrphans 真实跑

    const entry = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .find((d) => d.id === "sa-p-rebuild");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("closed");
    expect(entry!.closedReason).toBe("gc");
    expect(String(entry!.error)).toContain("no child session file");
  });

  // ============================================================
  // v2 断链 1（设计 §3.3 D1/D2 + 探针 P-manifest）：落标出口 manifest 落盘后，
  // running manifest 不得触发 collectRecords 孤儿补充投影——有子文件锚的成员
  // 永不被 manifest 补充投影覆盖（record-store byId.has 跳过语义）。
  // ============================================================

  it("P-manifest 不变量：子文件锚 + manifest 并存 → 重启重建 list 投影与删 manifest 后逐字段一致", async () => {
    // 豁免形态构造（区分度最强）：落标写出的 manifest.status="running"（D2 如实
    // 投影）与子文件 sidecar 重建投影 closed+gc 可辨——若 manifest 被错误投影，
    // status/closedReason 形态差异立即暴露。
    const childFile = writeChildSessionFile("sa-pm", "p-manifest task");
    seedRoundTerminalEntries("sa-pm", childFile, "p-manifest full result", "prov/pm-m", "sync");
    const recovery = makeRecoveryService(makeAssertPi()); // initSession：orphan 判定 + sidecar 真实落盘
    const spy = spyNotifier(recovery);
    await recovery.recoverSyncCollectBatch(); // E1 豁免补发：manifest 屏障（先于写账）→ 落标
    expect(spy.notifyBatch).toHaveBeenCalledTimes(1);
    const manifestFile = path.join(getSubagentRecordsDir(agentDir, agentDir), "sa-pm.json");
    expect(fs.existsSync(manifestFile)).toBe(true); // 屏障：await 返回时必已落盘

    // 模拟重启重建：全新 RecordStore + ManifestStore（内存缓存零残留），manifest 存在时
    const freshStore = () =>
      new RecordStore(
        getSubagentSessionDir(agentDir, agentDir),
        new ManifestStore(getSubagentRecordsDir(agentDir, agentDir)),
      );
    const withManifest = freshStore().collectRecords(100, "all", ROOT_SESSION);
    const pm = withManifest.find((r) => r.id === "sa-pm");
    expect(pm).toBeDefined();
    // 投影来自子文件 sidecar 重建（closed+gc），非 manifest（status="running"）
    expect(pm!.status).toBe("closed");
    expect(pm!.closedReason).toBe("gc");

    // 删 manifest 文件 → 同款重建 → 投影逐字段一致（不变量：manifest 的存在不改变
    // list 形态——补充投影只服务「entry/子文件源完全缺失」的孤儿）
    fs.rmSync(manifestFile);
    const withoutManifest = freshStore().collectRecords(100, "all", ROOT_SESSION);
    expect(withoutManifest).toEqual(withManifest);
  });

  // ============================================================
  // E1 恢复批语义修复（review round1 簇 B）：one-shot 成功成员崩溃时末条 entry 恒为
  // running+resumable（SP-5 轮终形态）——syncRebuildToNotifyMember 直通 status 的旧
  // 形态使补发记录仍是 running：批头只统计 closed 成员 → 全员成功的恢复批显示
  // 「0 finished」，条目文案落「finished a round」（对话轮次语义），且 rebuildEntryRecord
  // 不投影 patchFile → worktree 改动的 git-apply 回收指针丢失。修复 = 对齐
  // notify-host toNotifyRecord 映射（closed + outcome 物化 + patchFile 透传）+
  // rebuildEntryRecord 补 patchFile 投影。
  // ============================================================

  it("E1 恢复批语义：one-shot 成功成员（running+resumable 末条）补发记录为 closed 形态——批头计数正确 + patchFile 提示在场", async () => {
    const patchPath = path.join(agentDir, "patches", "sa-ntf.patch");
    // 崩溃前主文件末条序列：register → 轮终 running+resumable + result 全文 + patchFile
    //（worktree one-shot 成功成员 kill -9 后的真实末条形态，SP-5 轮终写点）。
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id: "sa-ntf", collectMode: "sync", patchFile: patchPath }));
    store.reportSubagentRecord(
      memberRecord({
        id: "sa-ntf",
        collectMode: "sync",
        resumable: true,
        result: "resumable full result body",
        endedAt: 2000,
        patchFile: patchPath,
      }),
    );

    const pi = makeAssertPi();
    const recovery = makeRecoveryService(pi);

    // 投影层断言：rebuildEntryRecord 补 patchFile 投影后，E1 扫描快照可见
    //（修复前投影丢弃 → 补发记录无从携带 git-apply 指针）。
    const scanned = (recovery as unknown as { store: RecordStore }).store.scanLastRecordEntries(mainFile);
    expect(scanned.find((r) => r.id === "sa-ntf")!.patchFile).toBe(patchPath);

    // 真实 notifier 通路（不 spy——测试进程无 ledger/投递域装配 → 内核直发降级，
    // pi.sendMessage 同步可捕获）：断言主 agent 实际消费的批通知内容。
    await recovery.recoverSyncCollectBatch();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const sent = pi.sendMessage.mock.calls[0]![0] as {
      content: string;
      details?: { items?: Array<Record<string, unknown>> };
    };
    // 批头计数：closed+completed 成员计入 finished（修复前 running 直通 → 0 finished）
    expect(sent.content).toContain("Subagent batch completed: 1 finished, 0 failed, 0 cancelled.");
    // 条目文案：completed 终态而非「finished a round」（对话轮次语义）
    expect(sent.content).toContain("completed. Result:");
    expect(sent.content).toContain("resumable full result body");
    expect(sent.content).not.toContain("finished a round");
    // patchFile 的 git-apply 回收指针在场（修复前投影缺失 → 提示整行丢失）
    expect(sent.content).toContain(`git apply ${patchPath}`);
    // 补发记录一等断言（details items = ledger/GUI 同源消费形态）：closed + outcome 物化
    expect(sent.details?.items?.[0]).toMatchObject({
      id: "sa-ntf",
      status: "closed",
      outcome: "completed",
      patchFile: patchPath,
    });

    // 落标不受影响：批补发后统一补 batchFinalized
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks.map((m) => m.id)).toEqual(["sa-ntf"]);
  });

  it("S11：flushBatch 中 getFullRecord miss 成员用缓冲快照兜底落标（防重启后 E1 异 hash 双投递）", async () => {
    // 成员 1：失败终态（archive 出内存）且不写子文件 → getFullRecord 双 miss
    //（内存已出 + 子文件缺失——子文件被 GC/删除的窗口形态）；
    // 成员 2：SP-5 成功回退（留内存）→ getFullRecord 内存命中（正常落标对照）。
    const fake = makeRecoveryFake();
    // 写文件 pi：标记 entry 真实落盘主文件，E1 扫描通路（rebuildEntryRecord）可重解析
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
    //（修复前 h1 被跳过 → 无标记 → 重启后 E1 重新收集该成员，以异成员集 hash
    // 重新补发 → 同成员双投递）
    const marks = pi.appendEntry.mock.calls
      .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
      .map((c) => c[1] as Record<string, unknown>)
      .filter((d) => d.batchFinalized === true);
    expect(marks.map((m) => m.id).sort()).toEqual([h1.subagentId, h2.subagentId].sort());

    // 兜底标记 entry 经 E1 扫描通路可重解析且带标记（重启后候选排除判据就位）
    const scanned = (service as unknown as { store: RecordStore }).store.scanLastRecordEntries(mainFile);
    const h1Last = scanned.find((r) => r.id === h1.subagentId);
    expect(h1Last).toBeDefined();
    expect(h1Last!.batchFinalized).toBe(true);
    expect(h1Last!.collectMode).toBe("sync");
    expect(h1Last!.status).toBe("closed");
  });
});
