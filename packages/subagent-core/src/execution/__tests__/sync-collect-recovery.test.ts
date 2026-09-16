// src/execution/__tests__/sync-collect-recovery.test.ts
//
// [collect 退役] sync collect 批机制本体（SyncCollectDomain/E9 dispose 转账/flushBatch/
// 预算热读/manifest 屏障）已整体删除，本文件保留两个非批覆盖面（真实文件通路）：
//   1. 存量 entry 读侧守卫：batchFinalized/终态五字段经末条 entry 重建投影可见
//      （rebuildEntryRecord 白名单——旧 session 文件必须可读，D6 读侧保留纪律）；
//   2. orphan 覆写 merge 语义（v2 断链遗产，通用 record 重建规则）+ P-rebuild /
//      P-manifest 探针不变量。
//
// 通路保真（U8 红线：禁 mock record 断言）：
//   种子 entry 经真实 RecordStore.reportSubagentRecord → toSubagentRecordEntry 序列化
//   → 真实 appendFileSync 落 tmpdir 主 session JSONL → 读侧真实 readFileSync 扫描
//   （scanLastRecordEntries → collectLastRecordEntries + rebuildEntryRecord 投影）。
//   断言全部打在「磁盘文件内容 + 真实投影产物」上，scan/投影/序列化三层零 mock。
//
// mock 手法：mock logger；record-store 走真实实现（tmpdir 自建自删，红线）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
// mock logger：路径从 __tests__ 出发是 ../../core/（src/core/logger.ts——subagent-service
// 经 ../core/logger.ts 引用的同一模块）。曾写 ../core/logger.ts 指向不存在的
// src/execution/core/，vi.mock 静默失效（D4 上限用例首次断言日志时暴露）。
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import { SUBAGENT_RECORD_CUSTOM_TYPE } from "../persistence/record-entry.ts";
import { ManifestStore } from "../persistence/manifest-store.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelRegistryLike } from "../assembly/model-resolver.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { derivedManifestRecord } from "../persistence/record-store-rebuild.ts";
import type { SubagentRecord } from "../assembly/types.ts";
import { SubagentService } from "../subagent-service.ts";

/** 剥身份/relay env：身份 env 会让 service 误判自己是子进程（跳过恢复扫描），
 *  relay env 属 pi-invocation/relay-env 存量测试的敏感面（测试纪律：env 剥离）。 */
const ENV_KEYS_TO_STRIP = [
  "PI_SUBAGENT_ROOT_SESSION_ID",
  "PI_SUBAGENT_SELF_RECORD_ID",
  "PI_SUBAGENT_DEPTH",
  "PI_SUBAGENT_ROOT_CWD",
  "PI_SUBAGENT_FORK_DEPTH",
  "TAIJI_SUBAGENT_RELAY_SOCKET",
  "TAIJI_SUBAGENT_RELAY_NODE",
  "TAIJI_SUBAGENT_RELAY_SCRIPT",
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

describe("[collect 退役] 存量 entry 读侧守卫 + orphan 覆写 merge（真实文件通路）", () => {
  let agentDir: string;
  let mainFile: string;

  beforeEach(() => {
    for (const k of ENV_KEYS_TO_STRIP) delete process.env[k];
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-sync-recovery-"));
    fs.mkdirSync(getSubagentSessionDir(agentDir, agentDir), { recursive: true });
    mainFile = path.join(agentDir, "main-session.jsonl");
  });

  afterEach(() => {
    // maxRetries：sessions-index fire 写可能与删除并发（ENOTEMPTY 竞态，根级全量
    // 并行时机器负载高会放大窗口）——同款修法见 get-record-for-action-restart.test.ts /
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
   *  JSON record entry）且**不写** `.state`/`.alive` 三 sidecar——重建矩阵分支 4 命中
   *  条件，保证 orphan 恢复走 finalizeOrphanRecord 真实路径（entry-born 兜底测不到
   *  D3 merge 所在路径 = 假绿）。identity 含 reconstructAll 过滤必需字段：id/agent/
   *  task string + mode 枚举 + startedAt number + rootSessionId。
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
   *  sessionFile）——[U4/D3] 翻边后轮终权威形态（markRoundIdle 写 idle）。 */
  function seedRoundTerminalEntries(id: string, childFile: string, result: string, model: string): void {
    const store = makeSeedStore();
    store.reportSubagentRecord(memberRecord({ id, sessionFile: childFile, model }));
    store.reportSubagentRecord(
      memberRecord({ id, sessionFile: childFile, model, status: "idle", stopReason: "completed", result }),
    );
  }

  // ============================================================
  // 投影白名单（rebuildEntryRecord）——存量 entry 读侧守卫
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
    // 成员 C：已落标（batchFinalized——存量批成员 entry 形态，[collect 退役] 后只读）
    store.reportSubagentRecord(
      memberRecord({ id: "sa-c", status: "idle", closedReason: "gc", endedAt: 4000, batchFinalized: true }),
    );

    // 读侧：真实 readFileSync 扫描 + 投影（零 mock；store 经测试后门访问）
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
  // kill -9 同构形态：重启 orphan 判定自洽 + 覆写幂等
  // （[collect 退役] 原批协调不恢复断言随批机制删除——无恢复面即无补发面）
  // ============================================================

  it("kill -9 同构主用例：轮终 idle 末条自洽 → 重启 orphan 判定自洽 + 覆写幂等", async () => {
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
    void recovery; // [collect 退役] 原批恢复调用已随批机制删除，实例仅供下方自检链复用

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
  // 探针 P-manifest：存量 manifest 与子文件锚并存时，manifest 不得改变重建投影——
  // 有子文件锚的成员永不被 manifest 补充投影覆盖（record-store byId.has 跳过语义）。
  // [collect 退役] 后 manifest 为磁盘遗留形态（批时代落标产物），种子改为存量模拟
  //（batchFinalized entry + 手写 manifest）。
  // ============================================================

  it("P-manifest 不变量：子文件锚 + manifest 并存 → 重启重建 list 投影与删 manifest 后逐字段一致", () => {
    const childFile = writeChildSessionFile("sa-pm", "p-manifest task");
    const store = new RecordStore(
      getSubagentSessionDir(agentDir, agentDir),
      new ManifestStore(getSubagentRecordsDir(agentDir, agentDir)),
      makeWritingPi(mainFile),
      getSubagentRecordsDir(agentDir, agentDir),
    );
    // 种子：末条轮终 idle + 锚（子文件在）+ 落标标记 entry（存量批成员形态）；
    // manifest 以 derivedManifestRecord 投影手写（批时代 barrier 的磁盘遗留形态）。
    const pmFull = memberRecord({ id: "sa-pm", sessionFile: childFile, status: "idle", stopReason: "completed", result: "p-manifest full result" });
    void store.reportSubagentRecord(memberRecord({ ...pmFull, batchFinalized: true }));
    const manifestFile = path.join(getSubagentRecordsDir(agentDir, agentDir), "sa-pm.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify(derivedManifestRecord(pmFull), null, 2),
      "utf-8",
    );
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
    // 落标标记不在子文件锚重建投影词汇（entry 扫描链专属——见投影白名单用例）
    expect(pm!.batchFinalized).toBeUndefined();
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
});
