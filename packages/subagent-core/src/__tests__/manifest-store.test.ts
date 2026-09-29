import * as fsPromises from "node:fs/promises";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManifestStore } from "../execution/persistence/manifest-store";
import {
  materializeBoundRecordManifest,
  readRunTerminalManifest,
  rebuildManifestRecordIfMissing,
  rematerializeManifestRecord,
  reportInvalidManifestRecord,
  writeManifestRecordPersisted,
} from "../execution/persistence/manifest-store";
import type { ManifestRecord } from "../execution/persistence/manifest-store";
// [W1 / U2a] bound 物化守卫断言的观察面（RecordStore 写点 → records/<id>.json 投影）。
import { createRecord } from "../execution/persistence/execution-record";
import { createRecordEventJournal, recordEventsPath } from "../execution/persistence/record-events";
import type { RecordJournalEvent } from "../execution/persistence/record-events";
import { RecordStore } from "../execution/persistence/record-store";
import type { ExecutionRecord } from "../execution/assembly/types";

// [C10] 磁盘满测试需要可控的 fs.promises.rename（拖 ENOSPC/EACCES）。
// hoisted flag + vi.mock 透传：默认 renameErrorRef.current=null 走真实 rename，
// 磁盘满 it 里置入 Error 让 rename 拖出（拖一次后自动重置），其它 it 不受影响。
const { renameErrorRef, dirSyncErrorPathRef } = vi.hoisted(() => ({
  renameErrorRef: { current: null as NodeJS.ErrnoException | null },
  // T-fsync：设置为目标 dir 路径后，open(dir, "r") 返回的 handle.sync() 会抛错
  dirSyncErrorPathRef: { current: null as string | null },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const realHandle = await actual.open(...args);
      // T-fsync：仅对目标 dir（flags="r"）注入 sync 抛错，不影响 tmp 文件的 open("w")。
      // 覆盖实例 own 属性 sync（遮蔽原型方法）；close 仍走原型（this=真实实例，fd 完好）。
      const openPath = args[0];
      if (
        typeof openPath === "string" &&
        dirSyncErrorPathRef.current !== null &&
        openPath === dirSyncErrorPathRef.current &&
        args[1] === "r"
      ) {
        realHandle.sync = async (): Promise<void> => {
          throw new Error("EIO: simulated dir fsync failure");
        };
      }
      return realHandle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameErrorRef.current) {
        const err = renameErrorRef.current;
        renameErrorRef.current = null; // 抛一次后自动重置，避免污染后续 it
        throw err;
      }
      return actual.rename(...args);
    },
  };
});

describe("ManifestStore", () => {
  let store: ManifestStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
    store = new ManifestStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  describe("writeManifest", () => {
    it("should create manifest file with UUID name", async () => {
      const record = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };

      await store.writeManifest(record);

      const manifestPath = path.join(tmpDir, `${record.id}.json`);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      expect(content.id).toBe(record.id);
    });

    it("should use atomic write (tmp + rename)", async () => {
      const record = {
        id: "test-atomic",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };

      await store.writeManifest(record);

      // Verify no tmp files remain after write
      const files = fs.readdirSync(tmpDir);
      const tmpFiles = files.filter((f) => f.includes(".tmp."));
      expect(tmpFiles.length).toBe(0);
      expect(files.length).toBe(1); // Only the final manifest
    });

    it("should throw on write failure (not bestEffort)", async () => {
      const record = {
        id: "test-error",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };

      // Delete the directory to cause write failure
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });

      await expect(store.writeManifest(record)).rejects.toThrow();
    });
  });

  // [U4c / G3] tmp 恢复退役（D6）：manifest 已是可丢可重建缓存（权威 = `.state`，
  // 重建 = RecordStore.rebuildIndexes），promote 半写 tmp 的恢复语义失效——[H4/U5
  // 更名收口] recoverTmpFiles → sweepTmpFiles（名实对齐静默删除），返回删除计数。
  describe("sweepTmpFiles", () => {
    it("should delete tmp when manifest exists", async () => {
      const id = "test-recovery-1";
      const manifestPath = path.join(tmpDir, `${id}.json`);
      const tmpPath = path.join(tmpDir, `${id}.json.tmp.12345`);

      fs.writeFileSync(manifestPath, '{"id":"test-recovery-1"}');
      fs.writeFileSync(tmpPath, '{"id":"test-recovery-1"}');

      const result = await store.sweepTmpFiles();

      expect(result).toBe(1);
      expect(fs.existsSync(tmpPath)).toBe(false);
      expect(fs.existsSync(manifestPath)).toBe(true);
    });

    it("should delete valid tmp when manifest missing (promote retired)", async () => {
      const id = "test-recovery-2";
      const tmpPath = path.join(tmpDir, `${id}.json.tmp.12345`);
      const manifestPath = path.join(tmpDir, `${id}.json`);

      // 旧 promote 分支形态（合法完整 manifest 的 tmp + 正式文件缺失）也删——
      // 半写 tmp 不再被复活成「看似权威」的索引，缺员由 rebuildIndexes 重建。
      fs.writeFileSync(tmpPath, JSON.stringify({
        id,
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running",
        createdAt: Date.now(),
      }));

      const result = await store.sweepTmpFiles();

      expect(result).toBe(1);
      expect(fs.existsSync(manifestPath)).toBe(false);
      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it("should delete invalid tmp when manifest missing", async () => {
      const id = "test-recovery-3";
      const tmpPath = path.join(tmpDir, `${id}.json.tmp.12345`);

      fs.writeFileSync(tmpPath, "invalid json {{{");

      const result = await store.sweepTmpFiles();

      expect(result).toBe(1);
      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it("should delete tmp when JSON valid but not a valid manifest (missing required fields)", async () => {
      const id = "test-recovery-4";
      const tmpPath = path.join(tmpDir, `${id}.json.tmp.12345`);
      fs.writeFileSync(tmpPath, JSON.stringify({ foo: "bar" })); // 合法 JSON，非 manifest
      const result = await store.sweepTmpFiles();
      expect(result).toBe(1);
      expect(fs.existsSync(tmpPath)).toBe(false);
    });
  });

  describe("readManifest", () => {
    it("should return null for non-existent manifest", async () => {
      const result = await store.readManifest("nonexistent");
      expect(result).toBeNull();
    });

    it("should return manifest data", async () => {
      const record = {
        id: "test-read",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };

      await store.writeManifest(record);
      const result = await store.readManifest(record.id);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(record.id);
      expect(result?.status).toBe("running");
    });
  });

  // ── A3+C10：listAllSync + 并发写 + 磁盘满 rename 失败 ──

  describe("listAllSync (A3)", () => {
    it("正常读：返回目录下所有合法 manifest", async () => {
      await store.writeManifest({ id: "a-1", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 });
      await store.writeManifest({ id: "a-2", rootSessionId: "s", agentName: "w", status: "closed" as const, createdAt: 2 });
      const all = store.listAllSync();
      expect(all.length).toBe(2);
      expect(all.map((r) => r.id).sort()).toEqual(["a-1", "a-2"]);
    });

    it("损坏文件跳过：非法 JSON + 非 manifest schema 不计入，合法的正常返回", async () => {
      await store.writeManifest({ id: "good", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 });
      fs.writeFileSync(path.join(tmpDir, "broken.json"), "not json {{{");
      fs.writeFileSync(path.join(tmpDir, "wrong-schema.json"), JSON.stringify({ id: "x", foo: "bar" }));
      const all = store.listAllSync();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe("good");
    });

    it("空目录：返回空数组", () => {
      const fresh = path.join(tmpDir, "empty-sub");
      fs.mkdirSync(fresh);
      const s = new ManifestStore(fresh);
      expect(s.listAllSync()).toEqual([]);
    });

    it("tmp 文件跳过：.tmp. 后缀不计入（不与正式 manifest 重复）", async () => {
      await store.writeManifest({ id: "keep", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 });
      // 同 id 的残留 tmp（合法内容）——必须被跳过，避免与正式 manifest 重复计数
      fs.writeFileSync(
        path.join(tmpDir, "keep.json.tmp.123"),
        JSON.stringify({ id: "keep", rootSessionId: "s", agentName: "w", status: "running", createdAt: 1 }),
      );
      const all = store.listAllSync();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe("keep");
    });
  });

  // ── M3: status 枚举（SP-1 后 running/closed/cancelled 三态；crashed 不进 manifest，
  //    历史 completed/failed 由读侧 mapManifestStatus 映射为 closed）──
  describe("status 枚举 (M3)", () => {
    it("cancelled 能写入 + 读回（不再归并 failed）", async () => {
      const record = {
        id: "test-cancelled-4state",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "cancelled" as const,
        createdAt: Date.now(),
        completedAt: Date.now(),
      };
      await store.writeManifest(record);
      const result = await store.readManifest(record.id);
      expect(result).not.toBeNull();
      expect(result?.status).toBe("cancelled");
    });

    it("listAllSync 接受全部合法态（含 cancelled）", async () => {
      await store.writeManifest({ id: "s-running", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 });
      await store.writeManifest({ id: "s-completed", rootSessionId: "s", agentName: "w", status: "closed" as const, createdAt: 2 });
      await store.writeManifest({ id: "s-failed", rootSessionId: "s", agentName: "w", status: "closed" as const, createdAt: 3 });
      await store.writeManifest({ id: "s-cancelled", rootSessionId: "s", agentName: "w", status: "cancelled" as const, createdAt: 4 });
      const all = store.listAllSync();
      expect(all.length).toBe(4);
      expect(all.map((r) => r.status).sort()).toEqual(["cancelled", "closed", "closed", "running"]);
    });

    it("isValidManifest 拒绝 crashed（crashed 不进 manifest）", async () => {
      // 直接写磁盘绕过 TS 类型（crashed 不在 ManifestRecord.status union）——若意外出现于磁盘,
      // isValidManifest 守卫拒绝,listAllSync / readManifest 均不返回该 record。
      fs.writeFileSync(path.join(tmpDir, "crashed.json"), JSON.stringify({
        id: "bad-crashed", rootSessionId: "s", agentName: "w", status: "crashed", createdAt: 1,
      }));
      expect(store.listAllSync()).toEqual([]);
      expect(await store.readManifest("bad-crashed")).toBeNull();
    });

    it("isValidManifest 拒绝未知 status 值", async () => {
      fs.writeFileSync(path.join(tmpDir, "unknown.json"), JSON.stringify({
        id: "bad-unknown", rootSessionId: "s", agentName: "w", status: "totally-unknown", createdAt: 1,
      }));
      expect(store.listAllSync()).toEqual([]);
    });
  });

  describe("并发写 (C10)", () => {
    it("Promise.all 并发写 N 个不同 id：不丢不重，内容正确", async () => {
      const N = 10;
      const records = Array.from({ length: N }, (_, i) => ({
        id: `concurrent-${i}`,
        rootSessionId: "s",
        agentName: "w",
        status: "running" as const,
        createdAt: i,
      }));
      // 并发写要求全部成功（一个失败即测试失败 = 原子性语义），故意用 Promise.all 而非 allSettled
      // eslint-disable-next-line taste/prefer-allsettled -- 并发写须全部成功（一个失败即测试失败 = 原子性语义），allSettled 会吞失败信号
      await Promise.all(records.map((r) => store.writeManifest(r)));

      const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json") && !f.includes(".tmp."));
      expect(files.length).toBe(N); // 不丢
      const ids = files.map((f) => f.replace(".json", ""));
      expect(new Set(ids).size).toBe(N); // 不重
      // 内容正确：每个 id 都能读回且 createdAt 对应
      for (const r of records) {
        const got = await store.readManifest(r.id);
        expect(got?.id).toBe(r.id);
        expect(got?.createdAt).toBe(r.createdAt);
      }
    });
  });

  describe("磁盘满（rename 失败）(C10)", () => {
    afterEach(() => {
      renameErrorRef.current = null; // 保险：防 flag 残留污染后续测试
    });

    it("rename 抛 ENOSPC：writeManifest rejects + tmp 文件被清理 + 最终 manifest 未写入", async () => {
      renameErrorRef.current = Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      const rec = { id: "disk-full", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 };
      await expect(store.writeManifest(rec)).rejects.toThrow();

      const files = fs.readdirSync(tmpDir);
      expect(files.filter((f) => f.includes(".tmp.")).length).toBe(0); // best-effort 清理 tmp
      expect(files.some((f) => f === "disk-full.json")).toBe(false); // 最终 manifest 未写入
    });

    it("rename 抛 EACCES：同样清理 tmp + throw（不掩盖原错误）", async () => {
      renameErrorRef.current = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const rec = { id: "perm-denied", rootSessionId: "s", agentName: "w", status: "running" as const, createdAt: 1 };
      await expect(store.writeManifest(rec)).rejects.toThrow();

      const files = fs.readdirSync(tmpDir);
      expect(files.filter((f) => f.includes(".tmp.")).length).toBe(0);
      expect(files.some((f) => f === "perm-denied.json")).toBe(false);
    });
  });

  // F3：dir fsync 失败时 writeManifest 不应 throw（rename 已成功则视为成功，POSIX 不要求目录 fsync）
  describe("dir fsync 失败容忍（F3）", () => {
    afterEach(() => {
      dirSyncErrorPathRef.current = null; // 保险：防 flag 残留污染后续测试
    });

    it("writeManifest 应容忍 dir fsync 失败（rename 已成功则视为成功）", async () => {
      const record = {
        id: "fsync-fail",
        rootSessionId: "session-123",
        agentName: "worker",
        status: "running" as const,
        createdAt: Date.now(),
      };
      // 激活 dir sync 抛错：open(tmpDir, "r") 返回的 handle.sync() 会 throw
      dirSyncErrorPathRef.current = tmpDir;

      // 不 throw（best-effort 吞掉 dir fsync 错误，rename 已成功）
      await store.writeManifest(record);

      const manifestPath = path.join(tmpDir, `${record.id}.json`);
      expect(fs.existsSync(manifestPath)).toBe(true); // 正式 manifest 已落盘
      // tmp 已被 rename 消费（不存在）
      const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp."));
      expect(tmpFiles.length).toBe(0);
    });
  });
});

// ── [W1 / U2a] bound 物化守卫段专属 helper（v2* 前缀防重名）────────

function v2ReadEventLines(recordsDir: string, id: string): RecordJournalEvent[] {
  const content = fs.readFileSync(recordEventsPath(recordsDir, id), "utf8");
  const out: RecordJournalEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(JSON.parse(trimmed) as RecordJournalEvent);
  }
  return out;
}

function v2MakeRecord(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const base = createRecord("bg-v2", {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "v2-journal",
    startedAt: 1000,
    rootSessionId: "sess-v2",
  });
  return { ...base, ...over };
}

describe("bound 物化守卫三断言（W1 D2 决策 9）", () => {
  let rootDir: string;
  let sessionsDir: string;
  let recordsDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-v2-bound-guard-"));
    sessionsDir = path.join(rootDir, "sessions");
    recordsDir = path.join(rootDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(recordsDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeStore(): RecordStore {
    return new RecordStore(sessionsDir, undefined, undefined, recordsDir);
  }

  it("断言一（family 不误标）：运行中 record（bound manifest 已写）不被标已清理——manifest 在盘即 running 投影", () => {
    const store = makeStore();
    const rec = v2MakeRecord({ id: "sa-guard-family" });
    store.register(rec);
    const sessionFile = path.join(sessionsDir, "sa-guard-family.jsonl");
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    rec.sessionFile = sessionFile;
    store.reportRecordTransition(rec);

    // 家族扫描前提不变量：manifest 在盘且非 closed/cancelled——running record 的
    // sessionFile 存活（未被 GC），扫描不产 cleanedUp 误标。
    const manifest = JSON.parse(
      fs.readFileSync(path.join(recordsDir, "sa-guard-family.json"), "utf8") as string,
    ) as { status: string; sessionFile: string };
    expect(manifest.status).toBe("running");
    expect(fs.existsSync(manifest.sessionFile)).toBe(true);
  });

  it("断言二（跳过自愈）：锚定未就绪时本轮不写 manifest、下一物化点（轮终）自愈补写", () => {
    const store = makeStore();
    const rec = v2MakeRecord({ id: "sa-guard-heal" });
    store.register(rec);
    // spawn 回填但子 session 文件未落盘（bound 早于首笔写入的窗口）——守卫跳过。
    const sessionFile = path.join(sessionsDir, "sa-guard-heal.jsonl");
    rec.sessionFile = sessionFile; // 文件不存在
    store.reportRecordTransition(rec);
    expect(fs.existsSync(path.join(recordsDir, "sa-guard-heal.json"))).toBe(false);

    // 事件文件已落 bound 帧（事实源不受守卫影响——守卫只管 manifest 投影）。
    const events = v2ReadEventLines(recordsDir, "sa-guard-heal");
    expect(events.some((e) => e.type === "record-bound")).toBe(true);

    // 下一物化点（轮终 markRoundIdle 的 writeDerivedManifest）自愈补写。
    fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
    store.markRoundIdle("sa-guard-heal", { kind: "success", content: "ok" });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(recordsDir, "sa-guard-heal.json"), "utf8") as string,
    ) as { executionStatus: string };
    expect(manifest.executionStatus).toBe("idle");
  });

  it("断言三（zcode 粒度）：sessionRef 双键在场即物化（会话行级判读，非 dbPath 文件存在级）", () => {
    const store = makeStore();
    const rec = v2MakeRecord({ id: "sa-guard-zcode", engine: "zcode" });
    store.register(rec);
    // zcode 回填：engineHandle.sessionRef 双键（dbPath 指向不存在的文件——粒度
    // 断言：不查 dbPath 存在性，bound 产生点晚于引擎会话建立的裁决面）。
    rec.engineHandle = {
      sessionRef: { sessionId: "sess-zc-1", dbPath: path.join(rootDir, "nonexistent", "db.sqlite") },
      poolKey: "shared",
    };
    store.reportRecordTransition(rec);

    const manifestPath = path.join(recordsDir, "sa-guard-zcode.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8") as string) as {
      status: string;
      engine: string;
      engineHandle: { sessionRef: { sessionId: string; dbPath: string } };
    };
    expect(manifest.status).toBe("running");
    expect(manifest.engine).toBe("zcode");
    expect(manifest.engineHandle.sessionRef.sessionId).toBe("sess-zc-1");
    // zcode 分支零探查的直接证据：dbPath 文件不存在仍物化。
    expect(fs.existsSync(manifest.engineHandle.sessionRef.dbPath)).toBe(false);
  });
});

// ── [W1 / U2a / D2] record 域 manifest 落盘写面自由函数段 ─────────────
//
// 写面语义三档（manifest-store.ts 中段头注释的测试锚定）：
//   响亮（writeManifestRecordPersisted：失败 error 日志 + 用户可见 entry）/
//   不响亮（rematerialize / rebuild：失败 warn/debug 留痕不构成宿主错误）/
//   守卫降级（materializeBoundRecordManifest：写失败记日志跳过）。
// 写失败触发手法：blockedDir() 把目标路径的父段用文件占住——writeAtomicFileSync
// 的 mkdirSync(recursive) 对「路径段中被文件占据」抛 ENOTDIR（不 mock fs）。

describe("record 域 manifest 写面自由函数（W1/U2a/D2）", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-wface-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeManifest(id: string): ManifestRecord {
    return { id, rootSessionId: "sess-w1", agentName: "worker", status: "running", createdAt: 1234 };
  }

  /** 目标父段被文件挡住的目录路径：writeAtomicFileSync（ensureDir 默认）抛 ENOTDIR。 */
  function blockedDir(): string {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "occupied");
    return path.join(blocker, "sub");
  }

  describe("writeManifestRecordPersisted（终态持久通道——响亮档）", () => {
    it("dir 接线 → 同步原子写：内容与 manifest 一致（读侧无感差异）", () => {
      const m = makeManifest("w1-persist");
      writeManifestRecordPersisted(undefined, dir, m.id, m);
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "w1-persist.json"), "utf8")) as ManifestRecord;
      expect(onDisk.id).toBe("w1-persist");
      expect(onDisk.status).toBe("running");
    });

    it("dir 分支写失败 → 响亮降级：不 throw + appendEntry 双通道上报", () => {
      const appendEntry = vi.fn();
      writeManifestRecordPersisted(undefined, blockedDir(), "w1-fail", makeManifest("w1-fail"), appendEntry);
      expect(appendEntry).toHaveBeenCalledTimes(1);
      expect(appendEntry).toHaveBeenCalledWith(
        "subagent:manifest-write-failed",
        expect.objectContaining({ id: "w1-fail" }),
      );
    });

    it("dir 缺省 + store 在 → 异步写（fire-and-forget，终态不阻塞）", async () => {
      const store = new ManifestStore(dir);
      writeManifestRecordPersisted(store, undefined, "w1-async", makeManifest("w1-async"));
      await vi.waitFor(() => {
        expect(fs.existsSync(path.join(dir, "w1-async.json"))).toBe(true);
      });
    });
  });

  describe("rematerializeManifestRecord（缓存补缺通道——不响亮档）", () => {
    it("dir 分支成功：补写落盘", () => {
      const m = makeManifest("w1-remat");
      rematerializeManifestRecord(undefined, dir, m);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "w1-remat.json"), "utf8"))).toMatchObject({ id: "w1-remat" });
    });

    it("dir 分支写失败：warn 留痕不响亮（不 throw、无 entry 面）", () => {
      expect(() => rematerializeManifestRecord(undefined, blockedDir(), makeManifest("w1-remat-fail"))).not.toThrow();
    });

    it("dir 缺省 + store 在 → 异步补写", async () => {
      const store = new ManifestStore(dir);
      rematerializeManifestRecord(store, undefined, makeManifest("w1-remat-async"));
      await vi.waitFor(() => {
        expect(fs.existsSync(path.join(dir, "w1-remat-async.json"))).toBe(true);
      });
    });
  });

  describe("rebuildManifestRecordIfMissing（惰性补建通道）", () => {
    it("无落点（dir 与 store 均缺省，纯内存测试形态）→ false 不写", () => {
      expect(rebuildManifestRecordIfMissing(undefined, undefined, "w1-none", makeManifest("w1-none"), new Set())).toBe(false);
    });

    it("dir 分支：缺员补写 true → 已存在 false → tried 去重 false", () => {
      const tried = new Set<string>();
      const m = makeManifest("w1-rebuild");
      expect(rebuildManifestRecordIfMissing(dir, undefined, m.id, m, tried)).toBe(true);
      expect(fs.existsSync(path.join(dir, "w1-rebuild.json"))).toBe(true);
      // manifest 已在盘 → 跳过。
      expect(rebuildManifestRecordIfMissing(dir, undefined, m.id, m, new Set())).toBe(false);
      // tried 集合已登记（boot 全量轮与惰性通道共享防重复写）→ 跳过。
      expect(rebuildManifestRecordIfMissing(dir, undefined, m.id, m, tried)).toBe(false);
    });

    it("dir 分支写失败 → false（debug 留痕不抛）", () => {
      expect(rebuildManifestRecordIfMissing(blockedDir(), undefined, "w1-rebuild-fail", makeManifest("w1-rebuild-fail"), new Set())).toBe(false);
    });

    it("dir 缺省 + store 在 → 异步写返回 true", async () => {
      const store = new ManifestStore(dir);
      expect(rebuildManifestRecordIfMissing(undefined, store, "w1-rebuild-async", makeManifest("w1-rebuild-async"), new Set())).toBe(true);
      await vi.waitFor(() => {
        expect(fs.existsSync(path.join(dir, "w1-rebuild-async.json"))).toBe(true);
      });
    });
  });

  describe("reportInvalidManifestRecord（损坏 manifest 双通道上报）", () => {
    it("appendEntry 载荷携带身份四字段（session.jsonl 复盘面）", () => {
      const appendEntry = vi.fn();
      reportInvalidManifestRecord(makeManifest("bad-invalid"), appendEntry);
      expect(appendEntry).toHaveBeenCalledWith(
        "subagent:manifest-invalid-status",
        expect.objectContaining({ id: "bad-invalid", rootSessionId: "sess-w1", agentName: "worker" }),
      );
    });
  });

  describe("materializeBoundRecordManifest（守卫降级档）", () => {
    it("守卫通过但落点不可写 → false 不抛（下一物化点自愈）", () => {
      const sessionFile = path.join(dir, "sess.jsonl");
      fs.writeFileSync(sessionFile, "{}");
      const m: ManifestRecord = { ...makeManifest("w1-bound"), sessionFile };
      expect(materializeBoundRecordManifest(blockedDir(), m)).toBe(false);
    });
  });

  describe("读面 IO 故障分通道（ENOENT 静默降级 / 其余留痕后降级）", () => {
    it("readManifest：非 ENOENT 读错误（ENOTDIR——父段被文件占据）→ null 不抛", async () => {
      const store = new ManifestStore(dir);
      fs.writeFileSync(path.join(dir, "sub"), "occupied");
      await expect(store.readManifest("sub/blocked")).resolves.toBeNull();
    });

    it("readRunTerminalManifest：非 ENOENT 读错误 → null 不抛", async () => {
      const blocker = path.join(dir, "file-blocker");
      fs.writeFileSync(blocker, "occupied");
      await expect(readRunTerminalManifest(blocker, "wf-1")).resolves.toBeNull();
    });
  });
});
