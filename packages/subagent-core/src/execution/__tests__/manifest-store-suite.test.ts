// src/execution/__tests__/manifest-store-suite.test.ts
//
// [round5-g 合并产物] manifest-store.ts 持久化测试簇四合一，来源：
// - manifest-parentid.test.ts（parentRecordId 落盘/向后兼容）
// - manifest-store-tmp-recovery.test.ts（sweepTmpFiles 静默删除 + listAllSync 分通道）
// - records-cwd-isolation.test.ts（rootSessionId 树物理隔离）
// - run-terminal-manifest.test.ts（run 级终局派生视图写读）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ManifestStore,
  readRunTerminalManifest,
  writeRunTerminalManifest,
  type ManifestRecord,
  type RunTerminalManifest,
} from "../persistence/manifest-store.ts";
import { getSubagentRecordsDir } from "../assembly/path-encoding.ts";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// fs partial mock：unlinkSync 可按路径注错，其余转发真实实现。
// [round5-g 合并说明] unlinkSync 仅 manifest-store.sweepTmpFiles 路径消费，其余节不触达。
const { unlinkSyncMock } = vi.hoisted(() => ({ unlinkSyncMock: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: unlinkSyncMock,
    default: { ...actual, unlinkSync: unlinkSyncMock },
  };
});


// ══════ 来源: manifest-parentid.test.ts ══════

/** 构造最小合法 ManifestRecord（5 必填），optional 字段按 overrides 传入。 */
function makeBaseManifest(overrides: Partial<ManifestRecord> = {}): ManifestRecord {
  return {
    id: "rec-test",
    rootSessionId: "session-main",
    agentName: "worker",
    status: "closed",
    createdAt: 1000,
    ...overrides,
  };
}

describe("ManifestStore — parentRecordId 落盘 (M3a)", () => {
  let tmpDir: string;
  let store: ManifestStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-parentid-"));
    store = new ManifestStore(() => tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  // ── TC-m3a-new-record-parentid ──
  it("新 record 落盘含 parentRecordId（depth>=1 读回直接父 record id）", async () => {
    const record = makeBaseManifest({
      id: "rec-child",
      parentRecordId: "sa-parent-1",
    });
    await store.writeManifest(record);

    const readBack = await store.readManifest("rec-child");
    expect(readBack).not.toBeNull();
    expect(readBack?.parentRecordId).toBe("sa-parent-1");
  });

  it("顶层 record（parentRecordId 缺失）落盘读回仍 undefined", async () => {
    // 顶层 subagent parentRecordId=undefined（父是 main，main 无 record）
    const record = makeBaseManifest({ id: "rec-top" });
    await store.writeManifest(record);

    const readBack = await store.readManifest("rec-top");
    expect(readBack).not.toBeNull();
    expect(readBack?.parentRecordId).toBeUndefined();
  });

  // ── TC-m3a-old-manifest-compat ──
  it("旧 manifest JSON（无 parentRecordId）readManifest 返有效（isValidManifest 通过）", async () => {
    // 手写旧版本格式 manifest（无 parentRecordId 字段），模拟旧 subagent-workflow 写的磁盘文件
    const oldManifest = {
      id: "rec-old",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 2000,
      // 无 parentRecordId —— 旧版本写的
    };
    fs.writeFileSync(
      path.join(tmpDir, "rec-old.json"),
      JSON.stringify(oldManifest),
      "utf-8",
    );

    const readBack = await store.readManifest("rec-old");
    // readManifest 内 isValidManifest(parsed) ? parsed : null —— 非 null 即 5 必填校验通过
    expect(readBack).not.toBeNull();
    expect(readBack?.id).toBe("rec-old");
    expect(readBack?.parentRecordId).toBeUndefined();
  });

  // ── TC-m3a-isvalidmanifest-unchanged ──
  it("isValidManifest 不改：含/不含 parentRecordId 均通过（5 必填不变）", async () => {
    // isValidManifest 私有，通过 readManifest 等价验证（非 null ⟺ 校验通过）。
    // 含 parentRecordId —— 新格式
    const withParent = makeBaseManifest({
      id: "rec-with-parent",
      parentRecordId: "sa-x",
    });
    await store.writeManifest(withParent);
    expect(await store.readManifest("rec-with-parent")).not.toBeNull();

    // 不含 parentRecordId —— 仅 5 必填（旧格式 / 顶层 record）
    const minimal = {
      id: "rec-minimal",
      rootSessionId: "session-main",
      agentName: "worker",
      status: "closed",
      createdAt: 3000,
    };
    fs.writeFileSync(
      path.join(tmpDir, "rec-minimal.json"),
      JSON.stringify(minimal),
      "utf-8",
    );
    expect(await store.readManifest("rec-minimal")).not.toBeNull();
  });
});

// ══════ 来源: manifest-store-tmp-recovery.test.ts ══════

// src/execution/__tests__/manifest-store-tmp-recovery.test.ts
//
// [U4c / G3] tmp 恢复退役（D6）：sweepTmpFiles 语义 = 全部 tmp **静默删除**——
// manifest 已是可丢可重建缓存（权威 = `.state`，重建 = RecordStore.rebuildIndexes），
// promote 半写 tmp 的恢复语义失效。断言范围：
//   - 合法 JSON 的 tmp（旧 promote 分支 2 形态）也删——promote 退役的核心锚点；
//   - manifest 已存在时的陈旧 tmp（旧分支 1 形态）删；
//   - 非法 JSON 的 tmp（旧分支 3 形态）删；
//   - 返回删除计数（promote 退役后无恢复形态；公开转发链 recoverManifestTmpFiles 签名不变）；
//   - [T5④ / PS-13] per-file 容错保留：单个 tmp 删除失败（ENOENT——并发回收/外部
//     清理抢先）只 warn + 跳过，不再中断整轮。





const VALID_MANIFEST = {
  id: "sa-good",
  rootSessionId: "root-1",
  agentName: "general-purpose",
  createdAt: 1,
  status: "running",
};

describe("[U4c/G3] sweepTmpFiles 静默删除（promote 语义失效；H4/U5 更名收尾）", () => {
  let dir: string;
  let store: ManifestStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-tmp-recovery-"));
    store = new ManifestStore(() => dir);
    // 真实 unlinkSync（mock 模块对象上的 unlinkSync 已被替换，不能自引用转发）
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    unlinkSyncMock.mockReset();
    unlinkSyncMock.mockImplementation((p: fs.PathLike) => actualFs.unlinkSync(p));
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("合法 tmp + manifest 缺失（旧 promote 形态）→ 删而非提升（promote 退役锚点）", async () => {
    fs.writeFileSync(path.join(dir, "sa-good.json.tmp.111"), JSON.stringify(VALID_MANIFEST));
    const result = await store.sweepTmpFiles();
    // 重建源 = `.state` + rebuildIndexes——半写 tmp 不再被复活成「看似权威」的索引
    expect(result).toBe(1);
    expect(fs.existsSync(path.join(dir, "sa-good.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "sa-good.json.tmp.111"))).toBe(false);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("manifest 已存在 + 非法 JSON tmp → 全删，幸存 manifest 不动", async () => {
    fs.writeFileSync(path.join(dir, "sa-stale.json"), JSON.stringify(VALID_MANIFEST));
    fs.writeFileSync(path.join(dir, "sa-stale.json.tmp.222"), "{}");
    fs.writeFileSync(path.join(dir, "sa-junk.json.tmp.333"), "not json");
    const result = await store.sweepTmpFiles();
    expect(result).toBe(2);
    expect(fs.existsSync(path.join(dir, "sa-stale.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "sa-stale.json.tmp.222"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "sa-junk.json.tmp.333"))).toBe(false);
  });

  it("per-file 容错保留：单个 unlink ENOENT 只 warn 跳过，不中断整轮", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    fs.writeFileSync(path.join(dir, "sa-a.json.tmp.444"), "not json");
    fs.writeFileSync(path.join(dir, "sa-doomed.json.tmp.555"), "not json");
    const doomedPath = path.join(dir, "sa-doomed.json.tmp.555");
    unlinkSyncMock.mockImplementation((p: fs.PathLike) => {
      if (String(p) === doomedPath) {
        const err = new Error("ENOENT: file vanished") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actualFs.unlinkSync(p);
    });

    const result = await store.sweepTmpFiles();

    // 整轮不中断：doomed 之外的 tmp 处理完
    expect(result).toBe(1);
    expect(fs.existsSync(path.join(dir, "sa-a.json.tmp.444"))).toBe(false);
    // 失败留痕（warn 级，含文件名）
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("sa-doomed.json.tmp.555"),
      expect.objectContaining({ detail: expect.stringContaining("ENOENT") }),
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining("1 of 2 tmp file(s)"));
  });

  it("无 tmp 残留 → 零副作用零告警", async () => {
    fs.writeFileSync(path.join(dir, "sa-quiescent.json"), JSON.stringify(VALID_MANIFEST));
    const result = await store.sweepTmpFiles();
    expect(result).toBe(0);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});

// [A11] listAllSync 目录级读失败分通道：ENOENT = 合法缺省（静默空表）；非 ENOENT
// （ENOTDIR/EACCES 等）= 真 IO 故障（error 留痕——collectRecords orphan 派生视图把空表
// 当 not-found 消费，静默会伪装掉持续故障）。
describe("[A11] listAllSync 目录读失败分通道", () => {
  let dir: string;
  let store: ManifestStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-listall-"));
    store = new ManifestStore(() => dir);
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("manifest 目录不存在（ENOENT）→ 空表且零告警（合法缺省静默）", () => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    expect(store.listAllSync()).toEqual([]);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it("目录位被文件占据（ENOTDIR）→ 空表 + error 留痕（IO 故障可诊断）", () => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    fs.writeFileSync(dir, "not a directory");
    expect(store.listAllSync()).toEqual([]);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("list manifests"),
      expect.anything(),
    );
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});

// ══════ 来源: records-cwd-isolation.test.ts ══════

// src/__tests__/records-cwd-isolation.test.ts
//
// T5（F1 端到端补充）：验证 records 目录分区物理隔离——不同归属会话（rootSessionId）
// 的 manifest 互相不可见：一个会话树的 ManifestStore 读不到另一棵树的 manifest。
//
// [session-store-layout-inversion] 分区键演化：旧布局 getSubagentRecordsDir(agentDir, cwd)
// 按 cwd 编码段分区（F1 时代语义）；新布局分区键 = rootSessionId（session 存储树
// `<root>/<rootSid>/subagents/records/`），随会话整树回收。本文件从「cwd 物理隔离」
// 改写为「rootSessionId 树物理隔离」——隔离性仍要被测（测试意图保留，分区键换源）。
//
// T1（path-encoding.test.ts）已覆盖路径层契约；本测试补一个真实 fs + ManifestStore 的
// 端到端隔离烟雾测试，避免 SubagentService 构造成本（需 mock ModelConfigService/PiLike 等）。



let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "records-cwd-iso-"));
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 写一个最小合法的 manifest 到指定 records 目录。 */
function writeManifest(recordsDir: string, id: string): string {
  fs.mkdirSync(recordsDir, { recursive: true });
  const rec: ManifestRecord = {
    id,
    rootSessionId: "sess-1",
    agentName: "worker",
    status: "closed",
    createdAt: Date.now(),
  };
  const filePath = path.join(recordsDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(rec), "utf-8");
  return filePath;
}

describe("[F1/T5] records rootSessionId tree physical isolation", () => {
  it("ManifestStore bound to session tree A cannot read tree B's manifest (physical isolation)", () => {
    const sidA = "sid-iso-tree-a";
    const sidB = "sid-iso-tree-b";
    const recordsDirA = getSubagentRecordsDir(sidA, tmpDataDir);
    const recordsDirB = getSubagentRecordsDir(sidB, tmpDataDir);

    // 两棵会话树的 records 目录必须物理不同（已在 T1 路径层覆盖，这里再断言一次作为前提）
    expect(recordsDirA).not.toBe(recordsDirB);

    // 只在 A 树的 records 目录写一个 manifest
    writeManifest(recordsDirA, "rec-tree-a");

    const storeA = new ManifestStore(() => recordsDirA);
    const storeB = new ManifestStore(() => recordsDirB);

    const aIds = storeA.listAllSync().map((m) => m.id);
    const bIds = storeB.listAllSync().map((m) => m.id);

    // A 树能读到自己的 manifest
    expect(aIds).toContain("rec-tree-a");
    // B 树物理读不到 A 树的 manifest（不再依赖 rootSessionFilter 软过滤）
    expect(bIds).not.toContain("rec-tree-a");
    expect(bIds).toEqual([]);
  });

  it("two session trees with their own manifests are mutually invisible", () => {
    const sidA = "sid-iso-tree-a2";
    const sidB = "sid-iso-tree-b2";
    const recordsDirA = getSubagentRecordsDir(sidA, tmpDataDir);
    const recordsDirB = getSubagentRecordsDir(sidB, tmpDataDir);

    writeManifest(recordsDirA, "rec-a");
    writeManifest(recordsDirB, "rec-b");

    const storeA = new ManifestStore(() => recordsDirA);
    const storeB = new ManifestStore(() => recordsDirB);

    const aIds = storeA.listAllSync().map((m) => m.id);
    const bIds = storeB.listAllSync().map((m) => m.id);

    expect(aIds).toEqual(["rec-a"]);
    expect(bIds).toEqual(["rec-b"]);
  });
});

// ══════ 来源: run-terminal-manifest.test.ts ══════

// src/execution/__tests__/run-terminal-manifest.test.ts
//
// [P1b-2 / D5] run 级终局派生视图 manifest 写读单测（manifest-store.ts）。
//
// 锁四面（D5-④ manifest-write 输出 + D5 清理规则①单源锚定）：
// 1. 三形态写读闭环：成功=completed、失败=failed+errorCode、取消=cancelled。
// 2. 旧读侧兼容：旧 manifest（无 outcome 字段的存量/手写形态）读回 null 不炸；
//    旧记录缺可选字段读回 undefined 不炸（isValidManifest 不拒可选字段）。
// 3. 损坏降级：JSON 损坏 / 形状不合法 → null（未终局语义），消费方按「无派生视图」。
// 4. runId 防穿越：白名单外 runId 拒绝（文件名由 runId 直接拼出的路径安全线）。

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-terminal-manifest-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeManifest(overrides: Partial<RunTerminalManifest> = {}): RunTerminalManifest {
  return {
    id: "wf-1719500000000-abcd",
    workflowName: "review-fix-loop",
    outcome: "done",
    settledAt: 1719500001000,
    ...overrides,
  };
}

// ── 1. 三形态写读闭环 ────────────────────────────────────────

describe("run 终局派生视图三形态写读（验收 a：manifest 侧）", () => {
  it("成功 = completed（errorCode 缺省不落键）", async () => {
    await writeRunTerminalManifest(dir, makeManifest({ outcome: "done" }));

    const read = await readRunTerminalManifest(dir, "wf-1719500000000-abcd");
    expect(read).toEqual({
      id: "wf-1719500000000-abcd",
      workflowName: "review-fix-loop",
      outcome: "done",
      settledAt: 1719500001000,
    });
    expect(read).not.toHaveProperty("errorCode");
  });

  it("失败 = failed + errorCode", async () => {
    await writeRunTerminalManifest(
      dir,
      makeManifest({ outcome: "failed", errorCode: "engine_crashed" }),
    );

    const read = await readRunTerminalManifest(dir, "wf-1719500000000-abcd");
    expect(read).toMatchObject({ outcome: "failed", errorCode: "engine_crashed" });
  });

  it("取消 = cancelled（errorCode 缺省）", async () => {
    await writeRunTerminalManifest(dir, makeManifest({ outcome: "cancelled" }));

    const read = await readRunTerminalManifest(dir, "wf-1719500000000-abcd");
    expect(read).toMatchObject({ outcome: "cancelled" });
    expect(read).not.toHaveProperty("errorCode");
  });

  it("文件落在 <dir>/<runId>.json（与 run state / journal 同 stem 的布局锚）", async () => {
    await writeRunTerminalManifest(dir, makeManifest());
    expect(fs.existsSync(path.join(dir, "wf-1719500000000-abcd.json"))).toBe(true);
  });
});

// ── 2. 旧读侧兼容（验收 b） ──────────────────────────────────

describe("旧读侧兼容（无 outcome 字段读回 null/undefined 不炸）", () => {
  it("旧 manifest（无 outcome 字段的手写形态）→ readRunTerminalManifest 返回 null", async () => {
    await fs.promises.writeFile(
      path.join(dir, "wf-1719500000000-abcd.json"),
      JSON.stringify({ id: "wf-1719500000000-abcd", status: "closed" }),
      "utf-8",
    );

    expect(await readRunTerminalManifest(dir, "wf-1719500000000-abcd")).toBeNull();
  });

  it("outcome 词表外值（漂移形态）→ null 降级，不误判已终局", async () => {
    await fs.promises.writeFile(
      path.join(dir, "wf-1719500000000-abcd.json"),
      JSON.stringify({ id: "x", workflowName: "w", outcome: "interrupted", settledAt: 1 }),
      "utf-8",
    );

    // [D2] interrupted 已出 outcome 词表（历史写入方产物形态）→ 词表外值降级 null
    expect(await readRunTerminalManifest(dir, "wf-1719500000000-abcd")).toBeNull();
  });

});

// ── 3. 损坏降级 ──────────────────────────────────────────────

describe("损坏降级（未终局语义，不炸）", () => {
  it("JSON 损坏 → null", async () => {
    await fs.promises.writeFile(
      path.join(dir, "wf-1719500000000-abcd.json"),
      "{not json",
      "utf-8",
    );

    expect(await readRunTerminalManifest(dir, "wf-1719500000000-abcd")).toBeNull();
  });

  it("文件不存在（未终局/已清理）→ null", async () => {
    expect(await readRunTerminalManifest(dir, "wf-1719500000000-abcd")).toBeNull();
  });
});

// ── 4. runId 防穿越 ──────────────────────────────────────────

describe("runId 白名单（路径穿越防线）", () => {
  it("路径穿越形态 runId 写/读均拒绝", async () => {
    await expect(
      writeRunTerminalManifest(dir, makeManifest({ id: "../escape" })),
    ).rejects.toThrow(/非法 runId/);
    await expect(readRunTerminalManifest(dir, "../escape")).rejects.toThrow(/非法 runId/);
    await expect(readRunTerminalManifest(dir, ".hidden")).rejects.toThrow(/非法 runId/);
  });
});
