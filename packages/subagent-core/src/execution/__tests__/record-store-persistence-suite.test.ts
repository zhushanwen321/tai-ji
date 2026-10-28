// record 域持久化面合并产物（round5-g C35）。
//
// 来源（基名，同包原独立 spec，用例逐字并入、各包一层同名 describe）：
//   manifest-store / terminal-write-latency / record-store-round-manifest /
//   record-store-orphan-revive / sync-collect-recovery / dispose-manifest-recovery /
//   model-switch。
// 被测域 = RecordStore/ManifestStore 持久化与恢复链 + setModel 编排；真实 fs 落盘
// 断言（tmpdir 自建自删），模块装载一次供全部用例复用。
//
// 文件级 mock 共三组（原各件提升，语义保持）：
//   ① core/logger 固定 mock（并集四键 debug/warn/error/info——manifest-store 三键与
//      sync-collect-recovery 四键工厂合并）；
//   ② node:fs/promises 透传拦截（renameErrorRef/dirSyncErrorPathRef 默认 null 走真实
//      实现，用例内自设自清——惰性判定，对其余节零影响）；
//   ③ lifecycle-predicates 透传桩（spread actual + hasLiveProcessHandle 换 live flag；
//      hasArmedIdleTimer/isResumable 保真——notify-host/record-lifecycle 消费不受影响；
//      model-switch 生产侧仅 import hasLiveProcessHandle，替换等价）。
//
// 同簇未并入：permanent-session-intent-actions.test.ts（node:fs/alive-store/
// child_process/worktree-registry 整模块替换 mock，与本产物各件「真实 fs 落盘断言」
// 纪律硬互斥），保留独立文件。
//
// 多层 describe 前缀为来源区块名（可溯源性）；区块内用例与 hook 原样保留。
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SET_MODEL_ERROR_CODES } from "@zhushanwen/subagent-engine-sdk";

import {
  INTEGRATION_TESTS_ENABLED,
  INTEGRATION_TESTS_SKIP_REASON,
} from "../../../../../test-guard/integration-gate.ts";
import { type SubagentRecord } from "../assembly/types.ts";
import { ModelConfigService } from "../assembly/model-config-service.ts";
import { endedMessageGuard } from "../assembly/subagent-actions-core.ts";
import { getSubagentRecordsDir, getSubagentSessionDir } from "../assembly/path-encoding.ts";
import { type ModelInfo, type ModelRegistryLike } from "../assembly/model-resolver.ts";
import { type ExecutionRecord, type ModelOverride } from "../domain/record-model.ts";
import { createRecord, completeLegacyClosed, trySettleLegacyClosed } from "../persistence/execution-record.ts";
import { ManifestStore, materializeBoundRecordManifest, readRunTerminalManifest, type ManifestRecord } from "../persistence/manifest-store.ts";
import { createRecordEventStream, recordEventsPath, type RecordEvent } from "../persistence/record-events.ts";
import { RecordStore } from "../persistence/record-store.ts";
import { derivedManifestRecord } from "../persistence/record-store-rebuild.ts";
import { SUBAGENT_RECORD_CUSTOM_TYPE, SUBAGENT_RECORD_ENTRY_VERSION } from "../persistence/record-entry.ts";
import { writeAliveMarker } from "../persistence/alive-store.ts";
import { engineSetModelErrorCode, setModel, type ModelSwitchDeps, type ModelSwitchModelService } from "../service/model-switch.ts";
import { SubagentService } from "../subagent-service.ts";
import { makePi } from "./helpers/pi-mock.ts";
import { createMemberRecord } from "./helpers/subagent-record-fixture.ts";
import { v2Entries, v2RegisteredEntry } from "./helpers/v2-record-entry.ts";

// ── 文件级 mock 段（原各来源件提升；见头注释三组说明）────────────────

const { loggerMock, renameErrorRef, dirSyncErrorPathRef, live } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  renameErrorRef: { current: null as NodeJS.ErrnoException | null },
  // T-fsync：设置为目标 dir 路径后，open(dir, "r") 返回的 handle.sync() 会抛错
  dirSyncErrorPathRef: { current: null as string | null },
  // [model-switch] 活进程镜像判据桩（编排分流判据——测试可控翻转）。
  live: { value: false },
}));

vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

// [C10] 磁盘满测试需要可控的 fs.promises.rename（拖 ENOSPC/EACCES）。
// hoisted flag + vi.mock 透传：默认 renameErrorRef.current=null 走真实 rename，
// 磁盘满 it 里置入 Error 让 rename 拖出（拖一次后自动重置），其它 it 不受影响。
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

// [model-switch] lifecycle-predicates 透传 + hasLiveProcessHandle flag 桩（其余导出保真）。
vi.mock("../lifecycle/lifecycle-predicates.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lifecycle/lifecycle-predicates.ts")>();
  return { ...actual, hasLiveProcessHandle: (recordId: string) => live.value && recordId.length > 0 };
});


// ── 来源区块：manifest-store.test.ts ────────────────────────────────────────────────
describe("manifest-store", () => {
  describe("ManifestStore", () => {
    let store: ManifestStore;
    let tmpDir: string;
    // [round6 慢用例治理] 逐例递归 rmSync 推迟到 afterAll 汇总一次：mkdtempSync 每例
    // 独占新目录（隔离语义不变——目录树唯一性不变），删除合并削掉逐例递归删除的固定 IO。
    const tmpDirs: string[] = [];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
      tmpDirs.push(tmpDir);
      store = new ManifestStore(() => tmpDir);
    });

    afterAll(() => {
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

        // 首写建立目录（ensureDirOnce 记忆化——构造期不再 mkdir，目录随 session 树
        // 晚定位），随后外部删除目录 = 异常态：写不静默重建，fail-fast 上抛。
        await store.writeManifest({ ...record, id: "test-seed" });
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });

        await expect(store.writeManifest(record)).rejects.toThrow();
      });
    });

    // [U4c / G3] tmp 恢复退役（D6）：manifest 已是可丢可重建缓存（权威 = `.state`，
    // 重建 = RecordStore.rebuildIndexes），promote 半写 tmp 的恢复语义失效——[H4/U5
    // 更名收尾] recoverTmpFiles → sweepTmpFiles（名实对齐静默删除），返回删除计数。
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
        const s = new ManifestStore(() => fresh);
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
        // isValidManifest 检查拒绝,listAllSync / readManifest 均不返回该 record。
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

  // ── [W1 / U2a] bound 物化检查段专属 helper（v2* 前缀防重名）────────

  function v2ReadEventLines(recordsDir: string, id: string): RecordEvent[] {
    const content = fs.readFileSync(recordEventsPath(recordsDir, id), "utf8");
    const out: RecordEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      out.push(JSON.parse(trimmed) as RecordEvent);
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

  describe("bound 物化检查三断言（W1 D2 决策 9）", () => {
    let rootDir: string;
    let sessionsDir: string;
    let recordsDir: string;
    // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
    const rootDirs: string[] = [];

    beforeEach(() => {
      rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-v2-bound-guard-"));
      rootDirs.push(rootDir);
      sessionsDir = path.join(rootDir, "sessions");
      recordsDir = path.join(rootDir, "records");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(recordsDir, { recursive: true });
    });
    afterAll(() => {
      for (const d of rootDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    function makeStore(): RecordStore {
      return new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
    }

    it("断言一（family 不误标）：运行中 record（bound manifest 已写）不被标已清理——manifest 在盘即 running 派生视图", () => {
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
      // spawn 回填但子 session 文件未落盘（bound 早于首笔写入的窗口）——检查跳过。
      const sessionFile = path.join(sessionsDir, "sa-guard-heal.jsonl");
      rec.sessionFile = sessionFile; // 文件不存在
      store.reportRecordTransition(rec);
      expect(fs.existsSync(path.join(recordsDir, "sa-guard-heal.json"))).toBe(false);

      // 事件文件已落 bound 帧（事实源不受检查影响——检查只管 manifest 派生视图）。
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

  // ── [W1 / D2] record 域 manifest 落盘写入路径自由函数段 ─────────────
  //
  // materializeBoundRecordManifest（检查降级档：写失败记日志跳过）。
  // 写失败触发手法：blockedDir() 把目标路径的父段用文件占住——writeAtomicFileSync
  // 的 mkdirSync(recursive) 对「路径段中被文件占据」抛 ENOTDIR（不 mock fs）。

  describe("record 域 manifest 写入路径自由函数（W1/U2a/D2）", () => {
    let dir: string;
    // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
    const wfaceDirs: string[] = [];

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-wface-"));
      wfaceDirs.push(dir);
    });

    afterAll(() => {
      for (const d of wfaceDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

    describe("materializeBoundRecordManifest（检查降级档）", () => {
      it("检查通过但落点不可写 → false 不抛（下一物化点自愈）", () => {
        const sessionFile = path.join(dir, "sess.jsonl");
        fs.writeFileSync(sessionFile, "{}");
        const m: ManifestRecord = { ...makeManifest("w1-bound"), sessionFile };
        expect(materializeBoundRecordManifest(blockedDir(), m)).toBe(false);
      });
    });

    describe("读侧 IO 故障分通道（ENOENT 静默降级 / 其余留痕后降级）", () => {
      it("readManifest：非 ENOENT 读错误（ENOTDIR——父段被文件占据）→ null 不抛", async () => {
        const store = new ManifestStore(() => dir);
        fs.writeFileSync(path.join(dir, "sub"), "occupied");
        await expect(store.readManifest("sub/blocked")).resolves.toBeNull();
      });

      it("readRunTerminalManifest：非 ENOENT 读错误 → null 不抛", async () => {
        const blocker = path.join(dir, "file-blocker");
        fs.writeFileSync(blocker, "occupied");
        await expect(readRunTerminalManifest(blocker, "wf-1")).resolves.toBeNull();
      });
    });

    describe("读侧损坏 JSON 的可诊断性（损坏 warn / ENOENT 静默）", () => {
      it("readManifest：ENOENT → null 且零 warn（合法缺省静默）", async () => {
        const store = new ManifestStore(() => dir);
        loggerMock.warn.mockClear();
        await expect(store.readManifest("missing")).resolves.toBeNull();
        expect(loggerMock.warn).not.toHaveBeenCalled();
      });

      it("readManifest：JSON 损坏 → null + warn（含文件路径与「视为不存在、等待重建」）", async () => {
        const store = new ManifestStore(() => dir);
        const filePath = path.join(dir, "torn.json");
        fs.writeFileSync(filePath, "{ torn", "utf8");
        loggerMock.warn.mockClear();

        await expect(store.readManifest("torn")).resolves.toBeNull();

        expect(loggerMock.warn).toHaveBeenCalledTimes(1);
        const [message] = loggerMock.warn.mock.calls[0] as [string];
        expect(message).toContain("readManifest: corrupted JSON, treated as absent");
        expect(message).toContain("awaits rebuild");
        expect(message).toContain(filePath);
      });

      it("readRunTerminalManifest：JSON 损坏 → null + warn（含文件路径）", async () => {
        const filePath = path.join(dir, "wf-corrupt.json");
        fs.writeFileSync(filePath, "{ torn", "utf8");
        loggerMock.warn.mockClear();

        await expect(readRunTerminalManifest(dir, "wf-corrupt")).resolves.toBeNull();

        expect(loggerMock.warn).toHaveBeenCalledTimes(1);
        const [message] = loggerMock.warn.mock.calls[0] as [string];
        expect(message).toContain("readRunTerminalManifest: corrupted JSON, treated as absent");
        expect(message).toContain(filePath);
      });

      it("readRunTerminalManifest：ENOENT → null 且零 warn（未终局/已清理静默）", async () => {
        loggerMock.warn.mockClear();
        await expect(readRunTerminalManifest(dir, "wf-absent")).resolves.toBeNull();
        expect(loggerMock.warn).not.toHaveBeenCalled();
      });
    });
  });
});

// ── 来源区块：terminal-write-latency.test.ts ────────────────────────────────────────────────
describe("terminal-write-latency", () => {
  /** 时延实测层采样次数（D2 口径 N=100）。 */
  const SAMPLE_COUNT = 100;

  describe("markFinalized 终态写面：双写发生且 persisted=true（单测层）", () => {
    let tmpDir: string;
    let recordsDir: string;
    let store: RecordStore;
    // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
    const terminalWriteDirs: string[] = [];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-write-"));
      terminalWriteDirs.push(tmpDir);
      recordsDir = path.join(tmpDir, "records");
      // 生产形态全接线：manifestStore 与 manifestDir（同步写通道，D8 v7）同源同目录。
      store = new RecordStore(() => tmpDir, new ManifestStore(() => recordsDir), { appendEntry: () => {} }, () => recordsDir);
    });

    afterAll(() => {
      for (const d of terminalWriteDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    it("record-settled 事件帧 + 终态 manifest 双写发生，返回 true，record 出册", () => {
      const sessionFile = path.join(tmpDir, "session.jsonl");
      fs.writeFileSync(sessionFile, "{}\n", "utf8");
      const record = createRecord("sa-terminal-write", {
        agent: "general-purpose",
        model: "test/model",
        mode: "background",
        slug: "t",
        task: "terminal write probe",
        startedAt: 1000,
        rootSessionId: "root",
      });
      record.sessionFile = sessionFile;
      store.register(record);
      // 生产调用惯例（record-store.ts 字段写点表）：终态冻结先由调用方完成
      // （trySettleLegacyClosed 抢锁 → completeLegacyClosed 冻结 endedAt），
      // markFinalized 只吸收持久化面。
      expect(trySettleLegacyClosed(record, "gc")).toBe(true);
      completeLegacyClosed(record, { text: "done", turns: 1, durationMs: 1, success: true, sessionId: "sid", toolCalls: [] }, "gc");

      const persisted = store.markFinalized(record, "gc");

      expect(persisted).toBe(true);
      // 双写①：record-settled 事件帧已同步落盘（appendFileSync——markFinalized
      // 返回即达页缓存，无需等待窗口）
      const eventsPath = path.join(recordsDir, `${record.id}.events`);
      const events = fs.readFileSync(eventsPath, "utf8");
      expect(events).toContain('"type":"record-settled"');
      // 双写②：终态 manifest 投影已同步落盘（writeAtomicFileSync），投影口径 =
      // legacy status closed + 两态 executionStatus idle + closedReason 随行
      const manifestPath = path.join(recordsDir, `${record.id}.json`);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        status?: string;
        executionStatus?: string;
        closedReason?: string;
        eventsStamp?: { mtimeMs: number; size: number };
      };
      expect(manifest.status).toBe("closed");
      expect(manifest.executionStatus).toBe("idle");
      expect(manifest.closedReason).toBe("gc");
      // 写序水位：manifest 携带事件文件当前 stat 戳 = 物化发生在事件追加之后
      // （「先事件后派生」的确定性证据，非时序推测）
      const eventsStat = fs.statSync(eventsPath);
      expect(manifest.eventsStamp).toEqual({ mtimeMs: eventsStat.mtimeMs, size: eventsStat.size });
      // 终态 record 已出册（archive 立即移出内存）
      expect(store.getMutable(record.id)).toBeUndefined();
    });
  });

  describe.skipIf(!INTEGRATION_TESTS_ENABLED)(
    "D2 时延实测：markFinalized 终态同步写（真实磁盘）" +
      (INTEGRATION_TESTS_SKIP_REASON ? `｜skip：${INTEGRATION_TESTS_SKIP_REASON}` : ""),
    () => {
      let tmpDir: string;
      let recordsDir: string;
      let store: RecordStore;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-latency-"));
        recordsDir = path.join(tmpDir, "records");
        store = new RecordStore(() => tmpDir, new ManifestStore(() => recordsDir), { appendEntry: () => {} }, () => recordsDir);
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      });

      // 采样口径与历史系列可比：fresh record（无 endedAt，register 后直接
      // markFinalized）——计时窗内每次迭代的真实同步写 = 终态 manifest
      // writeAtomicFileSync（register 的事件面写在计时窗外）。
      it(`markFinalized N=${SAMPLE_COUNT} 采样：P99/p50/max 落输出（水位追踪，无阈值断言）`, () => {
        const sessionFile = path.join(tmpDir, "session.jsonl");
        fs.writeFileSync(sessionFile, "{}\n", "utf8");
        const samples: number[] = [];
        for (let i = 0; i < SAMPLE_COUNT; i++) {
          const record = createRecord(`sa-latency-${i}`, {
            agent: "general-purpose",
            model: "test/model",
            mode: "background",
            slug: "t",
            task: "latency probe",
            startedAt: 1000,
            rootSessionId: "root",
          });
          record.sessionFile = sessionFile;
          store.register(record);
          const t0 = performance.now();
          const persisted = store.markFinalized(record, "gc");
          const t1 = performance.now();
          expect(persisted).toBe(true);
          samples.push(t1 - t0);
        }
        samples.sort((a, b) => a - b);
        const p50 = samples[Math.floor(SAMPLE_COUNT * 0.5)]!;
        const p99 = samples[Math.ceil(SAMPLE_COUNT * 0.99) - 1]!;
        const max = samples[SAMPLE_COUNT - 1]!;
        // eslint 基建：__tests__ 豁免 no-console（测试基建通道，非生产源码）。
        // 无阈值断言：负载态墙钟无稳定上界（历史 10ms→200ms 抬升即其症状，已退役），
        // 结构性回归按数量级跳变在落盘数字上人工/文档追踪。
        console.info(
          `[D2 latency] markFinalized N=${SAMPLE_COUNT}: p50=${p50.toFixed(3)}ms ` +
            `p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms（终态 manifest 同步写；P99 水位追踪，无阈值）`,
        );
        expect(samples.length).toBe(SAMPLE_COUNT);
      });
    },
  );
});

// ── 来源区块：record-store-round-manifest.test.ts ────────────────────────────────────────────────
describe("record-store-round-manifest", () => {
  /** 构造 ExecutionRecord（running 基线，over 覆盖）。 */
  function makeRecord(id: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord {
    const base = createRecord(id, {
      agent: "worker",
      model: "m",
      mode: "background",
      task: "t",
      slug: "round-manifest",
      startedAt: 1000,
      rootSessionId: "sess-current",
    });
    return { ...base, ...over };
  }

  function makeStore(sessionsDir: string, manifestDir: string): RecordStore {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(manifestDir, { recursive: true });
    return new RecordStore(() => sessionsDir, undefined, { appendEntry: vi.fn() }, () => manifestDir);
  }

  describe("markRoundIdle 轮终派生 manifest 派生视图（B2 簿记⑫）", () => {
    let tmpDir: string;
    let sessionsDir: string;
    let manifestDir: string;
    let sessionFile: string;
    let store: RecordStore;
    // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
    const roundManifestDirs: string[] = [];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-manifest-"));
      roundManifestDirs.push(tmpDir);
      sessionsDir = path.join(tmpDir, "sessions");
      manifestDir = path.join(tmpDir, "records");
      store = makeStore(sessionsDir, manifestDir);
      sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
      fs.writeFileSync(sessionFile, "{}\n", "utf-8"); // pi 锚文件在盘（binding 快照写 sidecar 同目录）
    });

    afterAll(() => {
      for (const d of roundManifestDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    const readManifest = (id: string): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(path.join(manifestDir, `${id}.json`), "utf-8")) as Record<string, unknown>;

    it("zcode 路径：manifest 落盘且满足 session-reader zcode 判据（engine + sessionRef 双键 + executionStatus idle）", () => {
      const dbPath = path.join(tmpDir, "session-db", "db.sqlite");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // ⑪ binding 快照写锚键同目录
      const record = makeRecord("bg-zcode", {
        engine: "zcode",
        engineHandle: { sessionRef: { sessionId: "z-sess-1", dbPath }, poolKey: "shared" },
      });
      store.register(record);

      expect(store.markRoundIdle("bg-zcode", { kind: "success", content: "zcode done" })).toBe(true);

      expect(fs.existsSync(path.join(manifestDir, "bg-zcode.json"))).toBe(true);
      const raw = readManifest("bg-zcode");
      // session-reader zcode 谓词（toZcodeManifestRecord）：engine 判别第一 +
      // engineHandle.sessionRef 双键非空 + id/rootSessionId 非空 string。
      expect(raw["engine"]).toBe("zcode");
      const handle = raw["engineHandle"] as { sessionRef: Record<string, unknown> };
      expect(handle.sessionRef["sessionId"]).toBe("z-sess-1");
      expect(handle.sessionRef["dbPath"]).toBe(dbPath);
      expect(raw["id"]).toBe("bg-zcode");
      expect(raw["rootSessionId"]).toBe("sess-current");
      // 两态词汇双写：权威词 idle + legacy 派生 running（轮终 idle 无 closedReason）。
      expect(raw["executionStatus"]).toBe("idle");
      expect(raw["status"]).toBe("running");
      // [F21] zcode record 无 sessionFile：键被 JSON.stringify 丢弃（zcode 直读路径
      // 存在的原因——pi isRecordManifest 对本 manifest 恒丢弃，不误入 pi 扫描链）。
      expect("sessionFile" in raw).toBe(false);
    });

    it("pi 路径对照：manifest 被 isRecordManifest 检查语义接受（三必填 string）+ idle 派生视图双写形态", () => {
      const record = makeRecord("bg-pi", { sessionFile });
      store.register(record);

      expect(store.markRoundIdle("bg-pi", { kind: "success", content: "pi done" })).toBe(true);

      const raw = readManifest("bg-pi");
      // isRecordManifest 三必填（session-reader subagents.ts）：id/rootSessionId/sessionFile。
      expect(typeof raw["id"]).toBe("string");
      expect(typeof raw["rootSessionId"]).toBe("string");
      expect(raw["sessionFile"]).toBe(sessionFile);
      // 派生视图单点（legacyManifestStatusFields）：轮终 idle 无 closedReason →
      // legacy "running"（session-reader 视角活跃成员）+ executionStatus "idle"（权威词）。
      expect(raw["status"]).toBe("running");
      expect(raw["executionStatus"]).toBe("idle");
      expect(raw["closedReason"]).toBeUndefined();
    });

    it("回归对照：markFinalized 终态路径产物形态不变（closed + closedReason）", () => {
      const record = makeRecord("bg-final", { sessionFile });
      // 终态内存冻结留调用方（completeLegacyClosed/trySettleLegacyClosed——markFinalized 只吸收
      // 持久化路径，不回写 record.closedReason，见 record-store 方法头）。
      record.closedReason = "gc";
      store.register(record);

      expect(store.markFinalized(record)).toBe(true);

      const raw = readManifest("bg-final");
      expect(raw["status"]).toBe("closed");
      expect(raw["closedReason"]).toBe("gc");
      expect(raw["executionStatus"]).toBe("idle");
    });

    it("跨轮幂等：多轮轮终重复写派生视图（缓存性质），manifest 恒为最新合法 idle 形态", () => {
      const record = makeRecord("bg-multi", { sessionFile });
      store.register(record);
      expect(store.markRoundIdle("bg-multi", { kind: "success", content: "r1" })).toBe(true);
      // 第二轮（[§4] 轮终原语的同状态在途门：须先过轮始门）——派生视图重写幂等，
      // manifest 恒为最新合法 idle 形态。
      expect(store.markRoundStarted("bg-multi")).toBe(true);
      expect(store.markRoundIdle("bg-multi", { kind: "success", content: "r2" })).toBe(true);

      const raw = readManifest("bg-multi");
      expect(raw["id"]).toBe("bg-multi");
      expect(raw["status"]).toBe("running");
      expect(raw["executionStatus"]).toBe("idle");
    });
  });

  // [D3 缺陷五 + 顺带发现 4] 来源身份与覆盖记账随 manifest 派生视图下行 + markModelOverride
  // 写点同步刷新派生视图——manifest 源反查（collectRecordsByParentRunId 的可见性键）与
  // 磁盘快照新鲜度（zcode 成员 spawn 后唯一磁盘兜底载体）的回归锚。
  describe("manifest 来源身份派生视图与 markModelOverride 派生刷新（D3 缺陷五/顺带发现 4）", () => {
    let tmpDir: string;
    let sessionsDir: string;
    let manifestDir: string;
    let sessionFile: string;
    let store: RecordStore;
    // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
    const identityDirs: string[] = [];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "round-manifest-identity-"));
      identityDirs.push(tmpDir);
      sessionsDir = path.join(tmpDir, "sessions");
      manifestDir = path.join(tmpDir, "records");
      store = makeStore(sessionsDir, manifestDir);
      sessionFile = path.join(sessionsDir, "2026-01-01_uuid.jsonl");
      fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    });

    afterAll(() => {
      for (const d of identityDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    const readManifest = (id: string): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(path.join(manifestDir, `${id}.json`), "utf-8")) as Record<string, unknown>;

    it("workflow 成员的轮终派生视图携带 origin/parentRunId/stepIndex（run 级查询可见性键）", () => {
      const record = makeRecord("wf-member", {
        sessionFile,
        origin: "workflow",
        parentRunId: "wf-run-1",
        stepIndex: 3,
      });
      store.register(record);
      expect(store.markRoundIdle("wf-member", { kind: "success", content: "done" })).toBe(true);

      const raw = readManifest("wf-member");
      expect(raw["origin"]).toBe("workflow");
      expect(raw["parentRunId"]).toBe("wf-run-1");
      expect(raw["stepIndex"]).toBe(3);
      // 反查链：manifest 源派生视图能被 collectRecordsByParentRunId 的过滤键命中。
      const members = store.collectRecordsByParentRunId("wf-run-1", 50);
      expect(members.map((r) => r.id)).toContain("wf-member");
    });

    it("markModelOverride 写点同步刷新派生 manifest（事件帧先写、manifest 后写——水位新鲜 + 快照不再停留陈旧值）", () => {
      const record = makeRecord("ovr-member", {
        sessionFile,
        engine: "zcode",
        engineHandle: { sessionRef: { sessionId: "z-1", dbPath: path.join(tmpDir, "db.sqlite") }, poolKey: "shared" },
        origin: "workflow",
        parentRunId: "wf-run-2",
      });
      store.register(record);

      // 创建时不写 manifest（register 契约）——覆盖写点前的磁盘快照缺席。
      expect(fs.existsSync(path.join(manifestDir, "ovr-member.json"))).toBe(false);

      expect(
        store.markModelOverride(record, {
          ref: { provider: "p1", modelId: "m9" },
          thinkingLevel: "high",
          setAt: 1234,
        }),
      ).toBe(true);

      const raw = readManifest("ovr-member");
      // 覆盖记账快照 = 写点时值（顺带发现 4：磁盘快照不再 null 滞留）。
      expect(raw["modelOverride"]).toEqual({
        ref: { provider: "p1", modelId: "m9" },
        thinkingLevel: "high",
        setAt: 1234,
      });
      // 来源身份随刷新保留（缺陷五：zcode 成员的 manifest 兜底载体对 run 级查询可见）。
      expect(raw["parentRunId"]).toBe("wf-run-2");
      // 水位新鲜：manifest 的 eventsStamp 与当前事件文件 stat 一致（读侧不因过期跳过）。
      const eventsPath = path.join(manifestDir, "ovr-member.events");
      const stamp = fs.statSync(eventsPath);
      const watermarked = raw["eventsStamp"] as { mtimeMs: number; size: number };
      expect(watermarked.mtimeMs).toBe(stamp.mtimeMs);
      expect(watermarked.size).toBe(stamp.size);
      // manifest 源反查：覆盖记账值随派生视图可达（session-reader / 查询范围的读侧半边）。
      const members = store.collectRecordsByParentRunId("wf-run-2", 50);
      const found = members.find((r) => r.id === "ovr-member");
      expect(found?.modelOverride?.ref).toEqual({ provider: "p1", modelId: "m9" });
    });

    it("manifestToSubagent 读侧检查：损坏 modelOverride 形状归一 undefined（未知 JSON 不裸收）", async () => {
      fs.writeFileSync(
        path.join(manifestDir, "corrupt-ovr.json"),
        JSON.stringify({
          id: "corrupt-ovr",
          rootSessionId: "sess-current",
          agentName: "worker",
          status: "running",
          createdAt: 1000,
          modelOverride: { ref: { provider: 42 }, setAt: "not-a-number" },
        }),
        "utf-8",
      );
      const { ManifestStore } = await import("../persistence/manifest-store.ts");
      const { manifestToSubagent } = await import("../persistence/record-store-rebuild.ts");
      const ms = new ManifestStore(() => manifestDir);
      const manifest = await ms.readManifest("corrupt-ovr");
      expect(manifest).not.toBeNull();
      const projected = manifestToSubagent(manifest!);
      expect(projected?.modelOverride).toBeUndefined();
      expect(projected?.parentRunId).toBeUndefined();
      expect(projected?.origin).toBeUndefined();
    });
  });
});

// ── 来源区块：record-store-orphan-revive.test.ts ────────────────────────────────────────────────
describe("record-store-orphan-revive", () => {
  let tmpDir = "";
  // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
  const reviveDirs: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-revive-"));
    reviveDirs.push(tmpDir);
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
  });

  afterAll(() => {
    for (const d of reviveDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 第一/第二段共用的目录布局：sessions 子目录（磁盘重建源）+ records 目录（事件/
   *  manifest 面）+ 主 session 文件（entry 源）。 */
  function makeOrphanLayout(): { sessionsDir: string; recordsDir: string; mainFile: string } {
    const sessionsDir = path.join(tmpDir, "sessions");
    const recordsDir = path.join(tmpDir, "records");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(recordsDir, { recursive: true });
    return { sessionsDir, recordsDir, mainFile: path.join(tmpDir, "main.jsonl") };
  }

  /** 播种用 SubagentRecord（v2 条目构造输入；缺省 rootSessionId = sess-orphan）。 */
  function seedRecord(over: Partial<SubagentRecord> = {}): SubagentRecord {
    return {
      id: "sa-base",
      agent: "worker",
      task: "orphan revive",
      slug: "s",
      status: "running",
      mode: "background",
      startedAt: 1000,
      rootSessionId: "sess-orphan",
      parentRecordId: undefined,
      depth: 0,
      endedAt: undefined,
      turns: 0,
      totalTokens: 0,
      model: undefined,
      thinkingLevel: undefined,
      eventLog: [],
      displayItems: [],
      ...over,
    };
  }

  /** 恢复侧 store（新实例 = 重启形态；recordsDir 接线 = 事件面在场）。注入 appendEntry
   *  先行调用：抛错即中止（append 未落盘 → appended 不记），透传即捕获落盘产物。 */
  function makeStore(
    sessionsDir: string,
    recordsDir: string,
    appendEntryImpl?: (customType: string, data: unknown) => void,
  ): {
    store: RecordStore;
    appended: Array<{ customType: string; data: Record<string, unknown> }>;
  } {
    const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
    const store = new RecordStore(() => sessionsDir, undefined, {
      appendEntry: (customType: string, data: unknown) => {
        appendEntryImpl?.(customType, data);
        appended.push({ customType, data: data as Record<string, unknown> });
      },
    } as never, () => recordsDir);
    return { store, appended };
  }

  describe("[PS-10] revive() 复位 orphanJudged（appendEntry 失败后重开可重判）", () => {
    /** entry-only 孤儿播种：主 session 只有 v2 注册条目——无子文件（不在 reconstructAll
     *  结果集）且无事件文件（journal 缺场），命中 recoverEntryOnlyOrphans。 */
    function seedEntryOnlyOrphan(id: string): {
      sessionsDir: string;
      recordsDir: string;
      mainFile: string;
    } {
      const { sessionsDir, recordsDir, mainFile } = makeOrphanLayout();
      v2AppendMainSessionLine(
        mainFile,
        SUBAGENT_RECORD_CUSTOM_TYPE,
        v2RegisteredEntry(seedRecord({ id })),
      );
      return { sessionsDir, recordsDir, mainFile };
    }

    /** [U3 场景迁移] orphanJudged 的次级防线语义用 appendEntry 注入失败构造：纠偏 entry
     *  未落盘 → 判据（注册条目无终态）不自愈，重判资格完全由缓存承载。 */
    it("appendEntry 失败（纠偏 entry 未落盘）→ orphanJudged 拦截重复判定；revive 后重判收敛 idle entry", () => {
      const { sessionsDir, recordsDir, mainFile } = seedEntryOnlyOrphan("sa-revive-1");

      let failAppend = true;
      const { store, appended } = makeStore(sessionsDir, recordsDir, () => {
        if (failAppend) throw new Error("append entry failed (disk full)");
      });

      // ── 阶段 1：纠偏 entry 落盘爆炸 → 异常传播（生产由 record-access try/catch 吸收），
      // orphanJudged 已标记；磁盘无事件文件（entry-only 纠偏不建 journal）──
      expect(() => store.recoverEntryOnlyOrphans(mainFile, "sess-orphan")).toThrow(/append entry failed/);
      expect(appended).toHaveLength(0);
      expect(fs.existsSync(recordEventsPath(recordsDir, "sa-revive-1"))).toBe(false);

      // ── 阶段 2（未 revive）：判据仍命中（终态条目未落盘）但 orphanJudged 拦截 →
      // 零异常零重复（次级防线语义；appendEntry 仍为爆炸实现，未拦截即再次抛出）──
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");
      expect(appended).toHaveLength(0);

      // ── 阶段 3：append 恢复 + /new 复活（revive 复位 orphanJudged）→ 重判纠偏落盘 ──
      failAppend = false;
      store.revive();
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");

      expect(appended).toHaveLength(1); // 未 revive 时 orphanJudged 残留 → 零新 entry，此处红
      const corrected = appended[0];
      expect(corrected?.customType).toBe(SUBAGENT_RECORD_CUSTOM_TYPE);
      // v2 终态条目形态（v1 快照字段族无 v2 载体：closedReason 等不再断言）
      expect(corrected?.data.v).toBe(SUBAGENT_RECORD_ENTRY_VERSION);
      expect(corrected?.data.kind).toBe("settled");
      expect(corrected?.data.status).toBe("idle");
      expect(corrected?.data.stopReason).toBe("interrupted-by-restart");
      // 纠偏不建事件文件（entry-only 入口的磁盘面零副作用）
      expect(fs.existsSync(recordEventsPath(recordsDir, "sa-revive-1"))).toBe(false);
    });

    it("未 revive 时重判资格保持（防重缓存语义不回归）：appendEntry 恢复后重复 recover 仍零新 entry", () => {
      const { sessionsDir, recordsDir, mainFile } = seedEntryOnlyOrphan("sa-revive-2");

      let failAppend = true;
      const { store, appended } = makeStore(sessionsDir, recordsDir, () => {
        if (failAppend) throw new Error("append entry failed (disk full)");
      });

      expect(() => store.recoverEntryOnlyOrphans(mainFile, "sess-orphan")).toThrow(/append entry failed/);
      expect(appended).toHaveLength(0);

      // 同进程内不经历 revive（未重开）：append 已恢复也不重判——orphanJudged 防重语义保持
      failAppend = false;
      store.recoverEntryOnlyOrphans(mainFile, "sess-orphan");
      expect(appended).toHaveLength(0);
    });
  });

  // ── [U4a / D3b (a″)] 孤儿恢复活实例跳过：findForeignLiveInstance 现查探针 ──
  //
  // 判据 = .alive marker 的 pid 活性（pid 单判据 + self-pid 排除）。验收（F2）：
  //   - 探针活（异宿主 pid 在持声明）→ 跳过收编——boot 不得代写异宿主持有中 record 的
  //     v2 终态条目（同 root 双宿主形态下，宿主 A 的 boot 误判宿主 B 持有中的 record 会
  //     击穿跨进程写权防御）；
  //   - pid 死（无在持声明）/ self-pid 残留 → 正常收编（v2 终态条目 + record-settled 帧
  //     落盘，无 .state sidecar——[U3] 直断防重锚写点已删）。
  describe("[U4a / D3b (a″)] 孤儿恢复活实例跳过：现查探针（pid 单判据）", () => {
    /** 崩溃前形态种子（事件文件在场 = 归收编入口 recoverOrphanRecords）：真实写点落
     *  record-created / record-bound 帧（bound 携带 sessionFile 锚——活实例探针的探查
     *  对象），主 session 落同源 v2 注册条目。 */
    function seedJournalOrphan(id: string): {
      sessionsDir: string;
      recordsDir: string;
      mainFile: string;
      sessionFile: string;
    } {
      const { sessionsDir, recordsDir, mainFile } = makeOrphanLayout();
      const captured: Array<{ customType: string; data: unknown }> = [];
      const seedStore = new RecordStore(
        () => sessionsDir,
        undefined,
        {
          appendEntry: (customType: string, data: unknown) => {
            captured.push({ customType, data });
          },
        } as never,
        () => recordsDir,
      );
      const rec = v2MakeRecord({ id, rootSessionId: "sess-orphan" });
      seedStore.register(rec); // record-created 帧 + v2 注册条目（身份 + 锚点）
      const sessionFile = path.join(sessionsDir, `${id}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
      rec.sessionFile = sessionFile;
      seedStore.reportRecordTransition(rec); // record-bound 帧（sessionFile 锚入账）
      // 主 session 只落注册条目（崩溃前无终态条目）。
      v2AppendMainSessionLine(mainFile, SUBAGENT_RECORD_CUSTOM_TYPE, captured[0]?.data);
      return { sessionsDir, recordsDir, mainFile, sessionFile };
    }

    it("探针活（异宿主 pid 在持声明）→ 跳过收编：零 settled entry、journal 零追加、manifest 未物化", () => {
      const { sessionsDir, recordsDir, mainFile, sessionFile } = seedJournalOrphan("sa-probe-1");
      // pid 1（launchd）必然存活且非本测试进程——异宿主「在持声明」的确定性形态
      writeAliveMarker(sessionFile, { pid: 1, id: "sa-probe-1", startedAt: Date.now() });

      const { store, appended } = makeStore(sessionsDir, recordsDir);
      store.recoverOrphanRecords("sess-orphan", mainFile);

      expect(appended).toHaveLength(0); // 跳过：不落任何收编 entry
      // journal 零追加 + 收编 manifest 未物化（跳过是构造性的，不止条目面）
      expect(
        v2ReadEventLines(recordsDir, "sa-probe-1").some((e) => e.type === "record-settled"),
      ).toBe(false);
      expect(store.findAdoptedStopReasonSync("sa-probe-1")).toBeUndefined();
    });

    it("pid 死（marker 残留但持有者已退）→ 正常收编：v2 idle 终态条目 + record-settled 帧（无 .state 防重锚）", () => {
      const { sessionsDir, recordsDir, mainFile, sessionFile } = seedJournalOrphan("sa-probe-2");
      // 大 pid 用户空间必然不存在（ESRCH 判死）——原持有宿主已退出的残留 marker 形态
      writeAliveMarker(sessionFile, { pid: 9999999, id: "sa-probe-2", startedAt: Date.now() });

      const { store, appended } = makeStore(sessionsDir, recordsDir);
      store.recoverOrphanRecords("sess-orphan", mainFile);

      expect(appended).toHaveLength(1);
      expect(appended[0]?.customType).toBe(SUBAGENT_RECORD_CUSTOM_TYPE);
      // v2 终态条目形态（v1 快照字段族无 v2 载体：closedReason 等不再断言）
      expect(appended[0]?.data.v).toBe(SUBAGENT_RECORD_ENTRY_VERSION);
      expect(appended[0]?.data.kind).toBe("settled");
      expect(appended[0]?.data.status).toBe("idle");
      expect(appended[0]?.data.stopReason).toBe("interrupted-by-restart");
      // journal 唯一事实源：收编帧落账（幂等语义归第三段收编入口用例）
      expect(
        v2ReadEventLines(recordsDir, "sa-probe-2").filter((e) => e.type === "record-settled"),
      ).toHaveLength(1);
      // 收编 manifest 物化（sweep 判据第三级读取源）+ 无 legacy .state 防重锚
      expect(store.findAdoptedStopReasonSync("sa-probe-2")).toBe("interrupted-by-restart");
      expect(fs.existsSync(`${sessionFile}.state`)).toBe(false);
    });

    it("self-pid marker（pid 复用到本进程的残留声明）→ 放行收编：原持有者已死，record 确为孤儿", () => {
      const { sessionsDir, recordsDir, mainFile, sessionFile } = seedJournalOrphan("sa-probe-3");
      // self-pid 排除：findForeignLiveInstance 视同无 foreign——复用窗口内残留 marker
      // 不构成「异宿主在持」，record 是真孤儿应照常收编
      writeAliveMarker(sessionFile, { pid: process.pid, id: "sa-probe-3", startedAt: Date.now() });

      const { store, appended } = makeStore(sessionsDir, recordsDir);
      store.recoverOrphanRecords("sess-orphan", mainFile);

      expect(appended).toHaveLength(1);
      expect(appended[0]?.data.kind).toBe("settled");
      expect(appended[0]?.data.status).toBe("idle");
      expect(appended[0]?.data.stopReason).toBe("interrupted-by-restart");
    });
  });

  // ── [W1 / U2a] 收编入口段专属 helper（v2* 前缀防重名）──────────────

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

  function v2CapturePi(captured: unknown[]): { appendEntry: (customType: string, data: unknown) => void } {
    return {
      appendEntry: (customType: string, data: unknown) => {
        captured.push({ customType, data });
      },
    };
  }

  function v2ReadEventLines(recordsDir: string, id: string): RecordEvent[] {
    const content = fs.readFileSync(recordEventsPath(recordsDir, id), "utf8");
    const out: RecordEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      out.push(JSON.parse(trimmed) as RecordEvent);
    }
    return out;
  }

  /** 主 session JSONL 行写入（appendEntry 落盘产物形态——与 pi 落盘同构）。 */
  function v2AppendMainSessionLine(mainFile: string, customType: string, data: unknown): void {
    fs.appendFileSync(
      mainFile,
      `${JSON.stringify({
        type: "custom",
        id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      })}\n`,
      "utf8",
    );
  }

  describe("收编入口（W1 D4：journal 重放 + 收编幂等）", () => {
    let rootDir: string;
    let sessionsDir: string;
    let recordsDir: string;
    let mainFile: string;
    // [round6 慢用例治理] 删除推迟 afterAll（每例 mkdtempSync 独占目录，隔离不变）。
    const adoptDirs: string[] = [];

    beforeEach(() => {
      rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "record-v2-adopt-"));
      adoptDirs.push(rootDir);
      sessionsDir = path.join(rootDir, "sessions");
      recordsDir = path.join(rootDir, "records");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(recordsDir, { recursive: true });
      mainFile = path.join(rootDir, "main.jsonl");
    });
    afterAll(() => {
      for (const d of adoptDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    /** 崩溃前形态种子：v2 注册条目 + created/bound 帧、无终态（kill -9 等价）。 */
    function seedCrashedRecord(id: string): ExecutionRecord {
      const captured: unknown[] = [];
      const store = new RecordStore(() => sessionsDir, undefined, v2CapturePi(captured), () => recordsDir);
      const rec = v2MakeRecord({ id });
      store.register(rec);
      const sessionFile = path.join(sessionsDir, `${id}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
      rec.sessionFile = sessionFile;
      store.reportRecordTransition(rec);
      // 主 session 只落注册条目（崩溃前无终态条目）。
      const registered = (captured[0] as { data: unknown }).data;
      v2AppendMainSessionLine(mainFile, "subagent-record", registered);
      return rec;
    }

    /** 收编链（等价 kill -9 重启）：新 store + 主文件 → recoverOrphanRecords。 */
    function rebootStore(captured: unknown[]): RecordStore {
      const store = new RecordStore(() => sessionsDir, undefined, v2CapturePi(captured), () => recordsDir);
      store.recoverOrphanRecords(undefined, mainFile);
      return store;
    }

    /** 手工 v2 settled 条目行（D4 双面证据条目面的夹具构造——stopReason 可指定）。 */
    function appendManualSettledEntry(id: string, stopReason: string): void {
      v2AppendMainSessionLine(mainFile, "subagent-record", {
        v: 2,
        kind: "settled",
        id,
        status: "idle",
        stopReason,
        endedAt: Date.now(),
        turns: 0,
        totalTokens: 0,
        model: undefined,
        thinkingLevel: undefined,
      });
    }

    // [W1 / D4 双面证据第二面判别] interrupted 族条目 = 「条目面先行写、journal 帧
    // 缺失」不对称窗口残留（appendEvent fire-and-forget 失败），不构成跳过证据：
    // 收编放行 → 追加 settled 帧修复 journal（journal 唯一事实源承诺的自愈通道），
    // 二次重启由 fold settled 拦截不重复。
    it("夹具A journal 缺 settled 帧 + interrupted 终态条目 → 收编追加帧修复 journal，二次触发不重复", () => {
      seedCrashedRecord("sa-adopt-orphix");
      // 崩溃前条目面先行写了一条 interrupted settled（journal 帧因写失败缺失的形态）
      appendManualSettledEntry("sa-adopt-orphix", "interrupted");

      const captured: unknown[] = [];
      rebootStore(captured);
      const events = v2ReadEventLines(recordsDir, "sa-adopt-orphix");
      // journal 帧修复：record-settled 已追加
      expect(events.filter((e) => e.type === "record-settled")).toHaveLength(1);
      // 条目补写跟随收编链（adopted settled，幂等语义见双面证据注释）
      expect(captured.filter((c) => (c as { data: { kind?: string } }).data?.kind === "settled")).toHaveLength(1);

      // 二次重启：fold 已 settled → 不再追加（幂等）
      const captured2: unknown[] = [];
      rebootStore(captured2);
      expect(
        v2ReadEventLines(recordsDir, "sa-adopt-orphix").filter((e) => e.type === "record-settled"),
      ).toHaveLength(1);
    });

    it("夹具B journal 缺 settled 帧 + 非 interrupted 条目（completed）→ 保持跳过（双面证据成立）", () => {
      seedCrashedRecord("sa-adopt-final");
      appendManualSettledEntry("sa-adopt-final", "completed");

      const captured: unknown[] = [];
      rebootStore(captured);
      // 非 interrupted 真终态条目在 → 跳过收编，journal 零追加、条目零回调
      expect(
        v2ReadEventLines(recordsDir, "sa-adopt-final").filter((e) => e.type === "record-settled"),
      ).toHaveLength(0);
      expect(captured).toHaveLength(0);
    });

    it("验收③收编幂等（双重启不重复追加）：record-settled 帧恰一条、终态条目恰一条", async () => {
      seedCrashedRecord("sa-adopt-1");

      const capturedA: unknown[] = [];
      const storeA = rebootStore(capturedA);
      const eventsA = v2ReadEventLines(recordsDir, "sa-adopt-1");
      expect(eventsA.filter((e) => e.type === "record-settled")).toHaveLength(1);
      const settled = eventsA.find((e) => e.type === "record-settled");
      expect(settled).toMatchObject({ type: "record-settled", stopReason: "interrupted-by-restart" });
      expect(capturedA.filter((c) => (c as { data: { kind?: string } }).data?.kind === "settled")).toHaveLength(1);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(recordsDir, "sa-adopt-1.json"), "utf8") as string,
      ) as { id: string; agentName: string; executionStatus: string; stopReason?: string };
      expect(manifest).toMatchObject({ id: "sa-adopt-1", agentName: "worker", executionStatus: "idle" });
      // [W4 收敛] 收编停因上投影——sweep 判据第三级（findAdoptedStopReasonSync）的读取源。
      expect(manifest.stopReason).toBe("interrupted-by-restart");
      // 判据第三级本体：收编 manifest → 停因；非收编形态（文件缺失）→ undefined。
      expect(storeA.findAdoptedStopReasonSync("sa-adopt-1")).toBe("interrupted-by-restart");
      expect(storeA.findAdoptedStopReasonSync("sa-never-existed")).toBeUndefined();

      // 第二次重启：fold settled + 终态条目在（双面证据）→ 零追加。
      const capturedB: unknown[] = [];
      rebootStore(capturedB);
      const eventsB = v2ReadEventLines(recordsDir, "sa-adopt-1");
      expect(eventsB.filter((e) => e.type === "record-settled")).toHaveLength(1);
      expect(capturedB).toHaveLength(0);
    });

    it("夹具C 收编→复活续轮（round-started 清 fold settled）→轮完成前再崩溃→二次收编追加新帧（D4 非 interrupted 谓词复合回归）", () => {
      const id = "sa-adopt-relock";
      const rec = seedCrashedRecord(id);

      // 第一次收编（等价 kill -9 重启）：interrupted 收编帧 + 终态条目 + manifest。
      const first: unknown[] = [];
      rebootStore(first);
      expect(v2ReadEventLines(recordsDir, id).filter((e) => e.type === "record-settled")).toHaveLength(1);

      // 用户复活续跑：markResurrected 翻回活态 + markRoundStarted 落轮始帧——fold
      // settled 被 round-started 清除（record-events.ts fold 转移），旧 interrupted
      // 终态条目在（stopReason=interrupted-by-restart，中断族不构成跳过证据）。
      const liveStore = new RecordStore(() => sessionsDir, undefined, v2CapturePi([]), () => recordsDir);
      liveStore.markResurrected(rec, true);
      expect(liveStore.markRoundStarted(id)).toBe(true);
      expect(
        v2ReadEventLines(recordsDir, id).filter((e) => e.type === "record-round-started"),
      ).toHaveLength(1);

      // 轮完成前再崩溃 → 重启二次收编：旧 any-settled 判定会被首次收编的 interrupted
      // 条目误拦（实体永停 running 假活态）；非 interrupted 谓词放行 → 追加新
      // record-settled + settled 条目补写 + manifest 物化。
      const second: unknown[] = [];
      rebootStore(second);
      expect(v2ReadEventLines(recordsDir, id).filter((e) => e.type === "record-settled")).toHaveLength(2);
      expect(second.filter((c) => (c as { data: { kind?: string } }).data?.kind === "settled")).toHaveLength(1);
      expect(fs.existsSync(path.join(recordsDir, `${id}.json`))).toBe(true);

      // 三次重启：fold 已 settled（第二次收编帧）→ 幂等零追加。
      const third: unknown[] = [];
      rebootStore(third);
      expect(v2ReadEventLines(recordsDir, id).filter((e) => e.type === "record-settled")).toHaveLength(2);
      expect(third).toHaveLength(0);
    });

    it("验收⑤v2 新路径：重启后 manifest 经收编物化恢复可见（rematerialize 桥接为 v1 兼容专属零依赖）", async () => {
      seedCrashedRecord("sa-adopt-2");

      // 重启前 manifest 面 = bound 物化的 running 投影（子文件在盘）。
      const beforeManifest = JSON.parse(
        fs.readFileSync(path.join(recordsDir, "sa-adopt-2.json"), "utf8") as string,
      ) as { status: string };
      expect(beforeManifest.status).toBe("running");

      const captured: unknown[] = [];
      rebootStore(captured);

      // 重启后（收编物化）：executionStatus = idle（两态权威词）——manifest 可见性
      // 恢复通道 = 收编物化本身，与 record-access.ts rematerialize 桥接（v1 兼容
      // 专属——只认 v1 快照末条 closedReason）零依赖。
      const afterManifest = JSON.parse(
        fs.readFileSync(path.join(recordsDir, "sa-adopt-2.json"), "utf8") as string,
      ) as { executionStatus: string; closedReason?: string };
      expect(afterManifest.executionStatus).toBe("idle");
      expect(afterManifest.closedReason).toBeUndefined();
    });

    it("活体保护：内存持有（在途）与异宿主在持（pi 锚探活）均不收编", async () => {
      const capturedSeed: unknown[] = [];
      const holdingStore = new RecordStore(() => sessionsDir, undefined, v2CapturePi(capturedSeed), () => recordsDir);
      const rec = v2MakeRecord({ id: "sa-adopt-live" });
      holdingStore.register(rec);
      const sessionFile = path.join(sessionsDir, "sa-adopt-live.jsonl");
      fs.writeFileSync(sessionFile, '{"type":"session","version":3}\n', "utf8");
      rec.sessionFile = sessionFile;
      holdingStore.reportRecordTransition(rec);
      const registered = (capturedSeed[0] as { data: unknown }).data;
      v2AppendMainSessionLine(mainFile, "subagent-record", registered);

      // 同 store 持有（内存在册）：recoverOrphanRecords 的 v2 段跳过。
      holdingStore.recoverOrphanRecords(undefined, mainFile);
      const events = v2ReadEventLines(recordsDir, "sa-adopt-live");
      expect(events.some((e) => e.type === "record-settled")).toBe(false);

      // 新 store 无内存持有：正常收编（对照组——证明上一步跳过是活体保护所致）。
      const capturedCtrl: unknown[] = [];
      const ctrlStore = new RecordStore(() => sessionsDir, undefined, v2CapturePi(capturedCtrl), () => recordsDir);
      ctrlStore.recoverOrphanRecords(undefined, mainFile);
      expect(v2ReadEventLines(recordsDir, "sa-adopt-live").some((e) => e.type === "record-settled")).toBe(true);
    });

    it("空 journal / journal 未接线 / 坏链：skippedMissing / skippedNoIdentity 分类", async () => {
      const store = new RecordStore(() => sessionsDir, undefined, undefined, () => recordsDir);
      // 空 journal（从未落账）。
      expect(store.adoptInterruptedRecord("sa-never-existed")).toBe("skippedMissing");

      // 坏链：事件文件只有 bound 帧（created 帧损坏/缺失的残文件形态）。
      fs.writeFileSync(
        recordEventsPath(recordsDir, "sa-broken-chain"),
        `${JSON.stringify({ type: "record-journal", id: "sa-broken-chain" })}\n`,
        "utf8",
      );
      const journal = createRecordEventStream(() => recordsDir);
      await journal.append("sa-broken-chain", {
        type: "record-bound",
        ts: Date.now(),
        sessionFile: "/tmp/x.jsonl",
        engine: "pi",
        engineHandle: { sessionRef: {}, poolKey: "shared" },
        epoch: 0,
      });
      expect(store.adoptInterruptedRecord("sa-broken-chain")).toBe("skippedNoIdentity");

      // journal 未接线（纯内存形态）：恒 skippedMissing。
      const memStore = new RecordStore(() => sessionsDir);
      expect(memStore.adoptInterruptedRecord("sa-any")).toBe("skippedMissing");
    });
  });
});

// ── 来源区块：sync-collect-recovery.test.ts ────────────────────────────────────────────────
describe("sync-collect-recovery", () => {
  /** 剥身份 env：身份 env 会让 service 误判自己是子进程（跳过恢复扫描）。 */
  const ENV_KEYS_TO_STRIP = [
    "PI_SUBAGENT_ROOT_SESSION_ID",
    "PI_SUBAGENT_SELF_RECORD_ID",
    "PI_SUBAGENT_DEPTH",
    "PI_SUBAGENT_ROOT_CWD",
    "PI_SUBAGENT_FORK_DEPTH",
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

  /** 种子成员 record（真实 v2Entries 入参——条目构造/落盘/扫描三层真实）。 */
  const memberRecord = createMemberRecord({ task: "seed task", slug: "seed", rootSessionId: ROOT_SESSION });

  describe("[collect 退役] 存量 entry 读侧检查 + entry-born orphan 收编（真实文件通路）", () => {
    let agentDir: string;
    let mainFile: string;
    // [round6 慢用例治理] 删除推迟 afterAll：每例 mkdtempSync 独占目录（隔离不变），
    // 且与 fire 写的 ENOTEMPTY 竞态间隔更长（原逐例删除紧贴用例结束）。
    const recoveryDirs: string[] = [];

    beforeEach(() => {
      for (const k of ENV_KEYS_TO_STRIP) delete process.env[k];
      agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "core-sync-recovery-"));
      recoveryDirs.push(agentDir);
      fs.mkdirSync(getSubagentSessionDir(ROOT_SESSION, agentDir), { recursive: true });
      mainFile = path.join(agentDir, "main-session.jsonl");
    });

    afterAll(() => {
      // maxRetries：sessions-index fire 写可能与删除并发（ENOTEMPTY 竞态，根级全量
      // 并行时机器负载高会放大窗口）——同款修法见 get-record-for-action-restart.test.ts /
      // record-store-index.test.ts。
      for (const d of recoveryDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    /** 种子：v2 条目族经写入 pi 的真实 appendEntry 通路落主 session JSONL（注册条目
     *  恒在场，非 running 再补终态条目——与生产写点同序）。 */
    function seedRecord(record: SubagentRecord): void {
      const pi = makeWritingPi(mainFile);
      for (const entry of v2Entries(record)) pi.appendEntry(SUBAGENT_RECORD_CUSTOM_TYPE, entry);
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

    /** 在 sessionsDir 手工构造子 session 文件（session 头 + identity entry + 末行 v2
     *  注册条目）且**不写** `.state`/`.alive` 三 sidecar——重建矩阵分支 4 命中
     *  条件，保证 orphan 恢复走子文件锚重建真实路径（entry-born 兜底测不到
     *  D3 merge 所在路径 = 假绿）。identity 含 reconstructAll 过滤必需字段：id/agent/
     *  task string + mode 枚举 + startedAt number + rootSessionId。
     *  headModel（可选，"provider/modelId" 形态）：在 session 头与 identity 之间插一笔
     *  model_change entry——pi sdk 新 session 真实形态（dist sdk.js 对新 session 先
     *  appendModelChange 初值，session_start hook 的 identity 随后），readIdentityHeader
     *  解析 identity 前途经的 model_change 产出 light 重建的 rec.model。 */
    function writeChildSessionFile(recordId: string, task: string, headModel?: string): string {
      const childFile = path.join(getSubagentSessionDir(ROOT_SESSION, agentDir), `${recordId}.jsonl`);
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
            customType: SUBAGENT_RECORD_CUSTOM_TYPE,
            data: v2RegisteredEntry(memberRecord({ id: recordId, task, slug: "child" })),
          }) + "\n",
        "utf-8",
      );
      return childFile;
    }

    /** 种下「崩溃前主文件末条序列」：注册（running）→ 轮终（idle + stopReason/result
     *  全文 + sessionFile）——v2 条目族（终态载荷只活在 settled 条目）。 */
    function seedRoundTerminalEntries(id: string, childFile: string, result: string, model: string): void {
      seedRecord(memberRecord({ id, sessionFile: childFile, model }));
      seedRecord(
        memberRecord({ id, sessionFile: childFile, model, status: "idle", stopReason: "completed", result }),
      );
    }

    // ============================================================
    // 派生视图白名单（collectV2EntryPairs + v2PairToRecord）——存量 entry 读侧检查
    // ============================================================

    it("终态字段经真实落盘→扫描派生后可见（collectV2EntryPairs + v2PairToRecord）", () => {
      // 成员 A：注册（running）→ 终态（idle + stopReason + result）两笔真实 v2 条目
      seedRecord(memberRecord({ id: "sa-a", model: "prov/a-m" }));
      seedRecord(
        memberRecord({
          id: "sa-a",
          status: "idle",
          stopReason: "completed",
          endedAt: 2000,
          result: "done-A",
          model: "prov/a-m",
        }),
      );
      // 成员 B：failed 终态（error 字段）
      seedRecord(memberRecord({ id: "sa-b" }));
      seedRecord(
        memberRecord({ id: "sa-b", status: "idle", stopReason: "failed", endedAt: 3000, error: "boom" }),
      );

      // 读侧：真实 readFileSync 扫描 + 派生（零 mock；store 经测试后门访问）
      const recovery = makeRecoveryService(makeAssertPi());
      const scanned = (recovery as unknown as { store: RecordStore }).store.scanLastRecordEntries(mainFile);
      const byId = new Map(scanned.map((r) => [r.id, r]));

      // 终局域取末条 settled 条目（last-writer-wins）+ 身份域取注册条目
      const a = byId.get("sa-a");
      expect(a).toBeDefined();
      expect(a!.status).toBe("idle");
      expect(a!.stopReason).toBe("completed");
      expect(a!.endedAt).toBe(2000);
      expect(a!.result).toBe("done-A");
      expect(a!.error).toBeUndefined();
      expect(a!.model).toBe("prov/a-m");
      expect(a!.agent).toBe("/agents/worker.md");

      const b = byId.get("sa-b");
      expect(b!.status).toBe("idle");
      expect(b!.stopReason).toBe("failed");
      expect(b!.error).toBe("boom");
      expect(b!.result).toBeUndefined();
    });

    // ============================================================
    // kill -9 同构形态：重启 orphan 判定自洽 + 收编幂等
    // （[collect 退役] 原批协调不恢复断言随批机制删除——无恢复侧即无补发路径）
    // ============================================================

    it("kill -9 同构主用例：轮终 idle 末条自洽 → 重启 orphan 判定自洽 + 收编幂等", async () => {
      // ── 崩溃前形态：注册（running）→ 轮终（idle + stopReason/result 全文）──
      const childFile = writeChildSessionFile("sa-kill9", "kill -9 crash task");
      seedRoundTerminalEntries("sa-kill9", childFile, "kill-9 full result body", "prov/round-m");

      // ── 重启（写文件 pi：orphan 收编 entry 一旦命中即真实落盘）──
      // initSession 内已真实跑 orphan 恢复（ENV 已剥 → 根进程判定）。
      const recoveryPi = makeWritingPi(mainFile);
      const recovery = makeRecoveryService(recoveryPi);

      // 末条轮终 idle 自洽（纠偏对象 = 残留 running，轮终形态不触发 orphan 收编）——
      // 末条 settled 条目直接携带轮终正文/模型（真实轮终 entry 全集）。
      // stopReason 对齐 markRoundIdle 簿记⑩。
      const overwritten = readMainFileLastEntries().get("sa-kill9")!;
      expect(overwritten.status).toBe("idle");
      expect(overwritten.stopReason).toBe("completed");
      expect(overwritten.result).toBe("kill-9 full result body");
      expect(overwritten.model).toBe("prov/round-m");
      // 不写 .state 防重锚（`.state` 收条已整体退场；幂等由「纠偏 entry 落盘后末条
      // 变 idle，判据不再命中」构造性承接）
      expect(fs.existsSync(`${childFile}.state`)).toBe(false);
      void recovery; // [collect 退役] 原批恢复调用已随批机制删除，实例仅供下方自检链复用

      // orphan 收编幂等自检：二次重启零追加（末条已 idle，判据不再命中）
      const before = readMainFileLastEntries().get("sa-kill9")!;
      makeRecoveryService(makeAssertPi());
      const after = readMainFileLastEntries().get("sa-kill9")!;
      expect(after).toEqual(before);
    });

    // ============================================================
    // v2 断链 2+3 遗产（设计 §3.3 D3）：entry-born orphan 收编——注册条目定界
    //（registered ∧ 无非 interrupted 终态条目）后经真实 recoverEntryOnlyOrphans 补终态条目。
    // ============================================================

    it("P-rebuild：entry-born 孤儿判定只看「注册 ∧ 无终态」（无子文件锚仍入收编）", () => {
      // 注册形态末条（running，无终态条目），子文件不存在——recoverEntryOnlyOrphans 的
      // 「registered ∧ 无非 interrupted 终态条目」判定不应因派生视图字段而跳过该 id。
      seedRecord(memberRecord({ id: "sa-p-rebuild", result: "round done" }));

      const pi = makeAssertPi();
      makeRecoveryService(pi); // initSession 内 recoverEntryOnlyOrphans 真实跑

      const entry = pi.appendEntry.mock.calls
        .filter((c) => c[0] === SUBAGENT_RECORD_CUSTOM_TYPE)
        .map((c) => c[1] as Record<string, unknown>)
        .find((d) => d.id === "sa-p-rebuild");
      expect(entry).toBeDefined();
      expect(entry!.status).toBe("idle");
      // [U3 / §3.2.4] entry-born 纠偏一律保留 idle（直断 closed+gc+error 退役）
      expect(entry!.stopReason).toBe("interrupted-by-restart");
      expect(entry!.error).toBeUndefined();
    });

    // ============================================================
    // 探针 P-manifest：存量 manifest 与子文件锚并存时，manifest 不得改变重建派生视图——
    // 有子文件锚的成员永不被 manifest 补充派生视图覆盖（record-store byId.has 跳过语义）。
    // [collect 退役] 后 manifest 为磁盘遗留形态（批时代落标产物），种子改为存量模拟
    //（v2 条目 + 手写 manifest）。
    // ============================================================

    it("P-manifest 不变量：子文件锚 + manifest 并存 → 重启重建 list 派生视图与删 manifest 后逐字段一致", () => {
      const childFile = writeChildSessionFile("sa-pm", "p-manifest task");
      // 种子：v2 注册 + 终态条目（轮终 idle + 锚在子文件）；manifest 以
      // derivedManifestRecord 派生视图手写（批时代 barrier 的磁盘遗留形态）。
      const pmFull = memberRecord({ id: "sa-pm", sessionFile: childFile, status: "idle", stopReason: "completed", result: "p-manifest full result" });
      seedRecord(pmFull);
      const manifestFile = path.join(getSubagentRecordsDir(ROOT_SESSION, agentDir), "sa-pm.json");
      // records/ 目录在 v1 写点（reportSubagentRecord）删除后不再由种子隐式创建——
      // manifest 是手写磁盘遗留形态，目录显式自建。
      fs.mkdirSync(getSubagentRecordsDir(ROOT_SESSION, agentDir), { recursive: true });
      fs.writeFileSync(
        manifestFile,
        JSON.stringify(derivedManifestRecord(pmFull), null, 2),
        "utf-8",
      );
      expect(fs.existsSync(manifestFile)).toBe(true);

      // 模拟重启重建：全新 RecordStore + ManifestStore（内存缓存零残留），manifest 存在时
      const freshStore = () =>
        new RecordStore(
          () => getSubagentSessionDir(ROOT_SESSION, agentDir),
          new ManifestStore(() => getSubagentRecordsDir(ROOT_SESSION, agentDir)),
        );
      const withManifest = freshStore().collectRecords(100, "all", ROOT_SESSION);
      const pm = withManifest.find((r) => r.id === "sa-pm");
      expect(pm).toBeDefined();
      // 派生视图来自子文件锚重建（[U3 / §3.2.4] 纠偏 idle + interrupted-by-restart，无
      // sidecar 落盘），非 manifest（status 下行派生视图）——stopReason 是可辨差异位
      expect(pm!.status).toBe("idle");
      expect(pm!.stopReason).toBe("interrupted-by-restart");

      // 删 manifest 文件 → 同款重建 → 派生视图逐字段一致（不变量：manifest 的存在不改变
      // list 形态——补充派生视图只服务「entry/子文件源完全缺失」的孤儿）
      fs.rmSync(manifestFile);
      const withoutManifest = freshStore().collectRecords(100, "all", ROOT_SESSION);
      expect(withoutManifest).toEqual(withManifest);
    });
  });
});

// ── 来源区块：dispose-manifest-recovery.test.ts ────────────────────────────────────────────────
describe("dispose-manifest-recovery", () => {
  function makeTmpAgentDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "dispose-manifest-"));
  }

  function makeRecord(overrides: Partial<ExecutionRecord> & { id?: string } = {}): ExecutionRecord {
    const { id = "sa-m1", ...rest } = overrides;
    const r = createRecord(id, {
      agent: "general-purpose",
      model: "test/model",
      mode: "background",
      task: "gate b task",
      slug: "gate-b",
      startedAt: 1000,
      rootSessionId: "root-session",
      controller: new AbortController(),
    });
    Object.assign(r, rest);
    return r;
  }

  interface ServiceInternals { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    store: RecordStore;
  }

  /** 同 agentDir 二次构造 + initSession = 重启冷查（新 RecordStore/fileCache/manifest 缓存）。 */
  function makeServiceOn(agentDir: string, init?: { mainSessionFile?: string }): SubagentService {
    const modelService = new ModelConfigService({ agentDir, cwd: agentDir });
    const service = new SubagentService({ cwd: agentDir, modelService });
    service.initSession({ pi: makePi(), sessionId: "root-session", mainSessionFile: init?.mainSessionFile });
    return service;
  }

  /** 构造一条 closed 终态的 subagent-record entry 族（archive 写点的离线形态）。
   *
   * [v1 兼容层删除] v1 全量快照写点（toSubagentRecordEntry）已删：现行主 session 条目
   * 契约 = 注册 + 终态两条小条目（每族两行 JSON——v2Entries 与生产写点同序）。v2 终态
   * 条目不承载 closedReason 兼容位——该「为什么停」语义的值域完整并入 StopReason，
   * 故缺省取 stopReason = closedReason（旧读形态的迁移值），由 v2PairToRecord 派生视图回
   * stopReason；settle 形态（编排性关闭）显式传 stopReason。
   */
  function closedEntryLines(rec: {
    id: string;
    /** v1 终态兼容位（v2 条目无此载体）：仅作 stopReason 缺省——旧读形态的迁移值。 */
    closedReason?: SubagentRecord["closedReason"];
    /** v2 终态条目的停因（settle 形态的权威位）；缺省回落 closedReason。 */
    stopReason?: SubagentRecord["stopReason"];
    sessionFile?: string;
  }): string {
    const full: SubagentRecord = {
      id: rec.id,
      agent: "general-purpose",
      task: "gate b task",
      slug: "gate-b",
      status: "idle",
      stopReason: rec.stopReason ?? rec.closedReason,
      mode: "background",
      startedAt: 1000,
      rootSessionId: "root-session",
      parentRecordId: undefined,
      depth: 0,
      endedAt: 2000,
      turns: 0,
      totalTokens: 0,
      model: "test/model",
      thinkingLevel: undefined,
      eventLog: [],
      displayItems: [],
      error: "closed due to parent-shutdown",
      sessionFile: rec.sessionFile,
    };
    return v2Entries(full)
      .map((data) => JSON.stringify({ type: "custom", customType: SUBAGENT_RECORD_CUSTOM_TYPE, data }))
      .join("\n");
  }

  /** 播种 record 事件 journal 的 record-created 帧（真实写原语——收编路径 fold 的身份源）。
   *
   * [v1 兼容层删除] v2 自愈链的 manifest 物化出口 = adoptV2Orphans → adoptInterruptedRecord
   *（「注册条目在 ∧ journal 无终局帧」的不对称窗口补写 manifest），fold 身份帧是硬前提
   *（缺帧判 skippedNoIdentity）。v1 时代该场景由全量快照 entry 直读承接；v2 事件文件是
   * 事实源，离线播种须与 entry 族同批造出。
   */
  /**
   * dispose 后的收条读取——收条由事件流承载（③：`.state` 退场）：读最后一条
   * record-settled 帧，映射成与旧 sidecar 同形的 {status, reason, endedAt}。
   */
  function readDisposedState(
    agentDir: string,
    id: string,
  ): { status: string; reason?: string; endedAt?: number } {
    const file = path.join(getSubagentRecordsDir("root-session", agentDir), `${id}.events`);
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    const settled = lines
      .map((l) => JSON.parse(l) as { type?: string; stopReason?: string; endedAt?: number })
      .filter((e) => e.type === "record-settled")
      .at(-1);
    return { status: "idle", reason: settled?.stopReason, endedAt: settled?.endedAt };
  }

  async function seedCreatedJournalFrame(recordsDir: string, id: string): Promise<void> {
    await createRecordEventStream(() => recordsDir).append(id, {
      type: "record-created",
      ts: 1000,
      id,
      agent: "general-purpose",
      task: "gate b task",
      slug: "gate-b",
      origin: "tool",
      rootSessionId: "root-session",
      depth: 0,
      mode: "background",
      startedAt: 1000,
    });
  }

  function manifestPath(agentDir: string, id: string): string {
    return path.join(getSubagentRecordsDir("root-session", agentDir), `${id}.json`);
  }

  async function flushAsyncWrites(): Promise<void> {
    // fire-and-forget manifest 写 = fs.promises 微任务/宏任务链；数轮 tick 留足 flush 窗。
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => { setTimeout(r, 5); });
    }
  }

  describe("[M1/M2 Gate B] 编排性终态化 manifest 反查索引 + 重启冷查分流", () => {
    let agentDir: string;
    let service: SubagentService;
    const extraServices: SubagentService[] = [];
    // [round6 慢用例治理] 删除推迟 afterAll：每例 makeTmpAgentDir()（mkdtempSync）独占
    // 目录（隔离不变）；fire 写已由各例 afterEach flush 等尽，删除不再与之竞态。
    const gateBAgentDirs: string[] = [];

    beforeEach(() => {
      // 身份/目录贯穿 env 净化（本包 vitest.setup 不覆盖；字面量同 subagent-service 模块私有常量，
      // 残留会让 recoverOrphansIfRootProcess 误判子进程跳过恢复、rootCwd 漂移出 tmp agentDir）。
      delete process.env.PI_SUBAGENT_SELF_RECORD_ID;
      delete process.env.PI_SUBAGENT_ROOT_CWD;
      delete process.env.PI_SUBAGENT_ROOT_SESSION_ID;
      agentDir = makeTmpAgentDir();
      gateBAgentDirs.push(agentDir);
      // [session-store-layout-inversion] 生产 store 目录经
      // getSubagentRecordsDir(resolveStoreRootSessionId())（env dataDir 兜底）解析——
      // stubEnv 把写删目标收进本 mkdtemp 目录（自建自删红线）。
      vi.stubEnv("TAIJI_AGENT_DATA_DIR", agentDir);
      service = makeServiceOn(agentDir);
    });

    afterEach(async () => {
      await flushAsyncWrites(); // 等该例 fire-and-forget 写落盘（fire 写晚于用例结束，跨例无碍——目录独占）
      for (const s of extraServices.splice(0)) s.dispose();
      service.dispose();
      vi.unstubAllEnvs();
    });

    afterAll(() => {
      for (const d of gateBAgentDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    });

    it("M1: disposeAllRecords(parent-shutdown) 补写 manifest（legacy status running + executionStatus idle 双写）", async () => {
      const record = makeRecord({ id: "sa-m1" });
      (service as unknown as ServiceInternals).store.register(record);

      const count = service.disposeAllRecords("parent-shutdown");
      expect(count).toBe(1);

      // [U4c / G4-S5②] 同步写锚点：dispose 终态完成点（同步写返回后）**立即**读
      // manifest——存在且合法 JSON、无 0 字节/半写 tmp 残留（manifestDir writeSync
      // 接线后 fire-and-forget 停机窗构造性消灭；本用例不加 waitFor，等待形态回归
      // = D8 判据破坏）。
      const manifestFile = manifestPath(agentDir, "sa-m1");
      expect(fs.existsSync(manifestFile)).toBe(true);
      // [U5] 编排性关闭 = settle + 收尾写入 journal 记录（不终态化）：markSettledOut 派生视图——
      // [u-arch / §3.4 方案 A] 收起概念删除后 legacy status 恒 "running"（可续聊
      // record = 旧 reader 视角的活跃成员）+ executionStatus = idle（两态权威词）双写。
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as Record<string, unknown>;
      expect(manifest.status).toBe("running");
      expect(manifest.closedReason).toBeUndefined();
      expect(manifest.rootSessionId).toBe("root-session");
      expect(manifest.agentName).toBe("general-purpose");
      expect(manifest.createdAt).toBe(1000);
      expect(manifest.executionStatus).toBe("idle");
      // 原子写无 tmp 残留（0 字节/半写 tmp 只在崩溃打断 writeAtomicFile 时出现）
      const residue = fs.readdirSync(path.dirname(manifestFile)).filter((f) => f.includes(".tmp."));
      expect(residue).toEqual([]);
      await flushAsyncWrites(); // 拆 tmp 目录前等尽潜在异步写（防御既有 afterEach 契约）
    });

    it("M1: 在途 record 的 engineHandle.sessionRef.sessionFile 提升为终态锚点（entry+manifest 带真实路径）", async () => {
      const promoted = path.join(agentDir, "enc", "20260910T000000_sess-e1.jsonl");
      // [U2a/B3] dispose 终态化收敛 markFinalized 后 .state/binding 随锚点真实落盘——
      // 父目录须真实存在（旧路径不写 .state，promoted 仅作 manifest 字符串派生视图）。
      fs.mkdirSync(path.dirname(promoted), { recursive: true });
      fs.writeFileSync(promoted, "{}\n", "utf-8");
      const record = makeRecord({
        id: "sa-promote",
        engineHandle: { sessionRef: { sessionId: "sess-e1", sessionFile: promoted }, poolKey: "shared" },
      });
      (service as unknown as ServiceInternals).store.register(record);

      // 预写 .alive（断言 dispose 的 release 出口①——D8 终态原语内部删）
      fs.writeFileSync(
        `${promoted}.alive`,
        `${JSON.stringify({ pid: 99999, id: "sa-promote", startedAt: 1000 })}\n`,
        "utf-8",
      );

      service.disposeAllRecords("parent-shutdown");

      // record 本体提升（archive entry 派生视图随之携带）
      expect(record.sessionFile).toBe(promoted);
      // [U5] 终态收条（③ 后由事件流承载）：parent-shutdown → interrupted-by-restart
      //（§3.2.2 host shutdown 行）；不再是旧 {status:"finalized", reason} 死亡证明。
      const marker = readDisposedState(agentDir, "sa-promote");
      expect(marker.status).toBe("idle");
      expect(marker.reason).toBe("interrupted-by-restart");
      expect(typeof marker.endedAt).toBe("number");
      // .alive release（markSettledOut 内部删——§3.2.4 release 出口①收尾即放弃写权）
      expect(fs.existsSync(`${promoted}.alive`)).toBe(false);
      // manifest 落真实锚点（重启 revive/fork-from 可直接定位子文件）
      await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-promote"))).toBe(true), { interval: 1 });
      const manifest = JSON.parse(fs.readFileSync(manifestPath(agentDir, "sa-promote"), "utf-8")) as Record<string, unknown>;
      expect(manifest.sessionFile).toBe(promoted);
      expect(manifest.closedReason).toBeUndefined();
    });

    it("M1+M2: 重启冷查 manifest 源可见，endedMessageGuard 走 parent-shutdown 可重连分流", async () => {
      const record = makeRecord({ id: "sa-m1" });
      (service as unknown as ServiceInternals).store.register(record);
      service.disposeAllRecords("parent-shutdown");
      await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-m1"))).toBe(true), { interval: 1 });
      service.dispose();

      // 重启：新 Service 实例（内存空、fileCache 空、manifest 缓存空）+ initSession
      const restarted = makeServiceOn(agentDir);
      extraServices.push(restarted);

      const snap = restarted.queries.lookupRecordAnyState("sa-m1");
      expect(snap).toBeDefined();
      // [U8 / §3.2.8 双写回读] 编排性关闭产物重启冷查：manifest 源派生视图按 executionStatus
      //（两态权威词）优先读回 idle；[u-arch] 收起概念删除后 intent 不再持久化/回读
      //（manifest 残留键忽略）；closedReason 不携带（settle 语义）。
      expect(snap?.status).toBe("idle");
      expect(snap?.closedReason).toBeUndefined();

      // [U4 缩型] endedMessageGuard 的形态分流消亡——重启后的跨树 record（snapshot
      // 可查、归属拒绝）统一走「different session tree」判据文案 + fork-from 分叉指引。
      const err = endedMessageGuard(restarted, "sa-m1", new Error("subagent not found or not owned: sa-m1"));
      expect(err.message).toContain("belongs to a different session tree");
      expect(err.message).toContain("fork-from");
    });

    it("M1 自愈: manifest 被停机竞态吞掉时，boot 从 entry 族 + journal 收编重物化反查索引", async () => {
      // 离线形态：v2 终态条目（interrupted 族 = 编排性关闭的 settle 停因）已随 pi flush
      // 落盘、事件文件仅 record-created 帧（「条目范围先行写、journal 终局帧缺失」的不对称
      // 窗口），manifest 写未及落盘（无 records/<id>.json、无子文件、无绑定 sidecar）。
      // [v1 兼容层删除] v1 全量快照的 closedReason 兼容位已无载体——自愈出口从
      // rematerializeReconnectableEntryManifests（closedReason gate，现无可达输入）转为
      // v2 收编链 adoptV2Orphans → adoptInterruptedRecord（终局帧/条目/manifest 一次补齐）。
      const recordsDir = getSubagentRecordsDir("root-session", agentDir);
      const mainSessionFile = path.join(agentDir, "main-session.jsonl");
      fs.writeFileSync(
        mainSessionFile,
        `${closedEntryLines({ id: "sa-remat", stopReason: "interrupted-by-restart" })}\n`,
        "utf-8",
      );
      await seedCreatedJournalFrame(recordsDir, "sa-remat");
      expect(fs.existsSync(manifestPath(agentDir, "sa-remat"))).toBe(false);

      const restarted = makeServiceOn(agentDir, { mainSessionFile });
      extraServices.push(restarted);

      await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-remat"))).toBe(true), { interval: 1 });
      const manifest = JSON.parse(fs.readFileSync(manifestPath(agentDir, "sa-remat"), "utf-8")) as Record<string, unknown>;
      // 收编 manifest 派生视图 = legacy running + executionStatus idle + 收编停因
      //（v2 条目契约不承载 closedReason——旧终态兼容位随 v1 全量快照删除）
      expect(manifest.status).toBe("running");
      expect(manifest.executionStatus).toBe("idle");
      expect(manifest.stopReason).toBe("interrupted-by-restart");
      expect(manifest.closedReason).toBeUndefined();
      expect(manifest.rootSessionId).toBe("root-session");
      // 动作链同步恢复：message 分流可查（不再 not found）
      const snap = restarted.queries.lookupRecordAnyState("sa-remat");
      expect(snap?.status).toBe("idle");
      expect(snap?.closedReason).toBeUndefined();
    });

    it("M1 负向: user-close/cancelled/gc 末条 entry 不被重物化、不被孤儿恢复改写", async () => {
      const mainSessionFile = path.join(agentDir, "main-session.jsonl");
      const lines = [
        closedEntryLines({ id: "sa-uc", closedReason: "user-close" }),
        closedEntryLines({ id: "sa-cc", closedReason: "cancelled" }),
        closedEntryLines({ id: "sa-gc", closedReason: "gc" }),
      ];
      fs.writeFileSync(mainSessionFile, `${lines.join("\n")}\n`, "utf-8");

      const restarted = makeServiceOn(agentDir, { mainSessionFile });
      extraServices.push(restarted);
      await flushAsyncWrites();

      // 三类主动/自洽终态均不重物化 manifest（可见性语义 = 「记录真没了/无需恢复」）
      expect(fs.existsSync(manifestPath(agentDir, "sa-uc"))).toBe(false);
      expect(fs.existsSync(manifestPath(agentDir, "sa-cc"))).toBe(false);
      expect(fs.existsSync(manifestPath(agentDir, "sa-gc"))).toBe(false);
      // 查询范围不可见（保持现状语义），且孤儿恢复未追加任何 subagent-record entry（无改写）
      expect(restarted.queries.lookupRecordAnyState("sa-uc")).toBeUndefined();
      expect(restarted.queries.lookupRecordAnyState("sa-cc")).toBeUndefined();
      expect(restarted.queries.lookupRecordAnyState("sa-gc")).toBeUndefined();
    });

    it("M1 负向(store 侧): recoverEntryOnlyOrphans 对非 running 末条零 entry 追加", () => {
      // 与上一用例互补：直接钉 store 层候选检查（isEntryOrphanCandidate 只认 running 末条），
      // 防未来放宽时把主动终态误回收（closed+parent-shutdown 交由 service 重物化段治理）。
      const sessionsDir = path.join(agentDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const mainSessionFile = path.join(agentDir, "main-session.jsonl");
      fs.writeFileSync(
        mainSessionFile,
        `${closedEntryLines({ id: "sa-uc2", closedReason: "user-close" })}\n`,
        "utf-8",
      );
      const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
      const store = new RecordStore(() => sessionsDir, undefined, {
        appendEntry: (customType: string, data: unknown) => {
          appended.push({ customType, data: data as Record<string, unknown> });
        },
      });
      store.recoverEntryOnlyOrphans(mainSessionFile, "root-session");
      expect(appended).toHaveLength(0);
      store.dispose();
    });

    it("M2: cancel 终态化补写 manifest——无 sessionFile 形态重启可见 + 主动关闭分流", async () => {
      const record = makeRecord({ id: "sa-cx" });
      (service as unknown as ServiceInternals).store.register(record);
      expect(service.cancel("sa-cx")).toBe(true);

      await vi.waitFor(() => expect(fs.existsSync(manifestPath(agentDir, "sa-cx"))).toBe(true), { interval: 1 });
      // [U5] cancel = 中断轮 settle（不终态化）：markSettled 派生视图 legacy "running"
      //（idle 无 closedReason）、closedReason undefined；`.state` 新格式收条
      // {status:"idle", stopReason:"interrupted"}。
      const manifest = JSON.parse(fs.readFileSync(manifestPath(agentDir, "sa-cx"), "utf-8")) as Record<string, unknown>;
      expect(manifest.status).toBe("running");
      expect(manifest.closedReason).toBeUndefined();
      service.dispose();

      const restarted = makeServiceOn(agentDir);
      extraServices.push(restarted);
      const snap = restarted.queries.lookupRecordAnyState("sa-cx");
      // [U8 / §3.2.8 双写回读] cancel settle 后重启：manifest legacy "running" 下行
      //（活跃成员——万物可续，可续聊；旧 session-reader 视角），宿主内读侧按
      // executionStatus 权威词读回 idle；closedReason 不携带。
      expect(snap?.status).toBe("idle");
      expect(snap?.closedReason).toBeUndefined();

      // [U4 缩型] 「主动关闭」专属文案消亡——跨树统一归属判据文案（万物可续后
      // cancelled 遗留位不再拒绝同树 message）。
      const err = endedMessageGuard(restarted, "sa-cx", new Error("subagent not found or not owned: sa-cx"));
      expect(err.message).toContain("belongs to a different session tree");
      expect(err.message).toContain("fork-from");
    });

    it("M2: manifest 源 user-close 快照走「主动关闭」专属文案（读侧派生视图三分流汇总）", async () => {
      // user-close 终态正常路径走 doFinalizeRecord（store.markFinalized 携 closedReason，
      // 写侧由 finalize-record.test.ts 钉）；此处钉读侧：离线构造 user-close manifest，
      // 重启后 endedMessageGuard 不再误入 reconnectable/fork-from 分支（Gate B 实测错分流形态）。
      const restarted = makeServiceOn(agentDir);
      extraServices.push(restarted);
      // 离线播种的写目标 = records 目录（本用例无 register 写点，目录尚不存在）——先建再写
      fs.mkdirSync(path.dirname(manifestPath(agentDir, "sa-ucx")), { recursive: true });
      fs.writeFileSync(
        manifestPath(agentDir, "sa-ucx"),
        JSON.stringify({
          id: "sa-ucx",
          rootSessionId: "root-session",
          agentName: "general-purpose",
          status: "closed",
          closedReason: "user-close",
          createdAt: 1000,
          completedAt: 2000,
          task: "gate b task",
          slug: "gate-b",
        }),
        "utf-8",
      );
      // manifest 缓存按 stat 戳读取，写入后直接查询即可（listAllSync 每次重 stat）
      // [U4 缩型] user-close 快照同走跨树归属判据文案（形态分流消亡）。
      const err = endedMessageGuard(restarted, "sa-ucx", new Error("subagent not found or not owned: sa-ucx"));
      expect(err.message).toContain("belongs to a different session tree");
      expect(err.message).toContain("fork-from");
    });

    // ── [U5] disposeAllRecords 自动收起——编排性关闭语义矩阵 ──
    //
    // [U5 / §3.2.5 编排性关闭行] 终态化退役：dispose = settle（.state 新格式收条
    // {status:"idle", stopReason: interrupted-by-parent/restart}）+ 收尾写入 journal 记录
    //（markSettledOut：worktreeHandle 清句 + `.alive` release）+ 放弃轮标记。万物可续
    // 下任何 dispose 后 record 均可 message 寻回续聊（U4 锚判据），「可重连集」枚举
    // gate 消亡——矩阵断言改为 .state 磁盘产物 + 收尾资源侧 + 放弃标记（gate ②判据）。
    describe("[U5] disposeAllRecords 编排性关闭——语义矩阵", () => {
      /** 构造带真实 sessionFile + .alive marker 的活跃 record 并注册进 service store。 */
      function registerActiveRecord(opts: {
        id: string;
        chatMode?: boolean;
        result?: string;
      }): { record: ExecutionRecord; sessionFile: string } {
        const sessionFile = path.join(agentDir, `sess-${opts.id}.jsonl`);
        fs.writeFileSync(sessionFile, "{}\n", "utf-8");
        fs.writeFileSync(
          `${sessionFile}.alive`,
          `${JSON.stringify({ pid: 99999, id: opts.id, startedAt: 1000 })}\n`,
          "utf-8",
        );
        const record = makeRecord({
          id: opts.id,
          result: opts.result,
          sessionFile,
        });
        (service as unknown as ServiceInternals).store.register(record);
        return { record, sessionFile };
      }

      it("行 1 [chat × parent-shutdown]：.state 收条 status=idle + stopReason=interrupted-by-restart + .alive release", () => {
        const { record, sessionFile } = registerActiveRecord({ id: "sa-d8-chat-shutdown" });
        expect(service.disposeAllRecords("parent-shutdown")).toBe(1);

        const marker = readDisposedState(agentDir, record.id);
        expect(marker.status).toBe("idle");
        expect(marker.reason).toBe("interrupted-by-restart");
        expect(typeof marker.endedAt).toBe("number");
        // 编排性关闭 = settle idle + 收尾写入 journal 记录（无意愿字段）+ 在途轮置放弃标记
        expect(record.status).toBe("idle");
        expect(record.lastAbandonedRound).toEqual({ epoch: 0, round: 0 });
        // release 出口①：.alive 删除（markSettledOut——收尾即放弃写权）
        expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
      });

      it("行 2 [chat × parent-fork]：stopReason=interrupted-by-parent——自动收起后 message 寻回可续（旧 fork-from 承接通道消亡）", () => {
        const { record, sessionFile } = registerActiveRecord({ id: "sa-d8-chat-fork" });
        service.disposeAllRecords("parent-fork");

        const marker = readDisposedState(agentDir, record.id);
        expect(marker.status).toBe("idle");
        expect(marker.reason).toBe("interrupted-by-parent");
        expect(record.status).toBe("idle");
        // [U5] 旧「parent-fork 不可续」收紧裁决随终态化消亡——idle + 锚在 = 可续聊
        //（U4 万物可续）；message 隐含寻回经既有 revive 链承接（无意愿字段翻转）。
      });

      it("行 3 [one-shot × parent-shutdown]：stopReason=interrupted-by-restart，重启冷查分流不依赖可重连集", () => {
        registerActiveRecord({ id: "sa-d8-oneshot-shutdown" });
        service.disposeAllRecords("parent-shutdown");

        const marker = readDisposedState(agentDir, "sa-d8-oneshot-shutdown");
        expect(marker.status).toBe("idle");
        expect(marker.reason).toBe("interrupted-by-restart");
        // [U5] 重建单规则：一律 idle（U3）——stopReason 只是展示位，复活资格 = 物理三件套
      });

      it("行 4 [one-shot × parent-new]：stopReason=interrupted-by-parent（不再谎报 gc / 不再终态化）", () => {
        const { record, sessionFile } = registerActiveRecord({ id: "sa-d8-oneshot-new" });
        service.disposeAllRecords("parent-new");

        const marker = readDisposedState(agentDir, record.id);
        expect(marker.status).toBe("idle");
        expect(marker.reason).toBe("interrupted-by-parent");
        expect(record.status).toBe("idle");
        expect(record.closedReason).toBeUndefined();
      });

      it("行 5 [one-shot 纳管态 × parent-shutdown]：settle idle → boot 重认领意愿消亡（[U5/D4 MF-1] isBootReadoptable 死代码已删，孤儿纠偏 idle 等 revive）", () => {
        // 纳管态形态：无 result（监督器死亡接管后的 W4 形态）
        const { record, sessionFile } = registerActiveRecord({
          id: "sa-d8-adoptable",
          result: undefined,
        });
        expect(record.result).toBeUndefined();
        service.disposeAllRecords("parent-shutdown");

        // [U5] settle 后内存形态：idle + interrupted-by-restart（不终态化
        // ——closedReason 恒 undefined，result 不被合成 error 抹写）
        expect(record.status).toBe("idle");
        expect(record.closedReason).toBeUndefined();
        expect(record.stopReason).toBe("interrupted-by-restart");
        const marker = readDisposedState(agentDir, record.id);
        expect(marker.reason).toBe("interrupted-by-restart");

        // boot 重认领意愿消亡：[U5/D4 MF-1] 磁盘重建单规则恒 idle + 孤儿恢复恒 idle
        //（无在途轮即无接管需求）——isBootReadoptable 谓词已随死代码清理删除，
        // dispose 产物 idle 形态即「等 revive」终态，无重认领路径。
        expect(record.status).toBe("idle");
      });
    });
  });
});

// ── 来源区块：model-switch.test.ts ────────────────────────────────────────────────
describe("model-switch", () => {
  // ============================================================
  // fixtures
  // ============================================================

  function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
    return {
      id: over.id ?? "glm-5.3",
      name: over.name ?? "GLM-5.3",
      provider: over.provider ?? "zai-coding-cn",
      reasoning: over.reasoning ?? false,
      thinkingLevelMap: over.thinkingLevelMap,
      contextWindow: over.contextWindow,
    };
  }

  function makeRegistry(
    models: ModelInfo[],
    authed: string[] = models.map((m) => `${m.provider}/${m.id}`),
  ): ModelRegistryLike {
    const authSet = new Set(authed);
    return {
      getAvailable: () => models,
      find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
      hasConfiguredAuth: (m) => {
        if (!m || typeof m !== "object") return false;
        const mm = m as ModelInfo;
        return authSet.has(`${mm.provider}/${mm.id}`);
      },
    };
  }

  /** thinking 档位表（high/xhigh 可用——预检裁决基准）。 */
  const LEVELS = { off: true, high: true, xhigh: true };

  function makeRecord(id: string): ReturnType<typeof createRecord> {
    return createRecord(id, {
      agent: "general-purpose",
      model: "zai-coding-cn/glm-5.3",
      thinkingLevel: "high",
      mode: "background",
      task: "demo task",
      slug: "demo",
      startedAt: 1_000,
    });
  }

  interface Harness { // oe-exempt:20261006:test:测试专用装配 harness 单实现为常态
    deps: ModelSwitchDeps;
    service: ModelConfigService;
    store: RecordStore;
    recordsDir: string;
    record: ReturnType<typeof createRecord>;
    engineSetModelCalls: Array<{ runId: string; model: { provider: string; modelId: string } }>;
    persistedRunOverrides: Array<{ runId: string; override: ModelOverride }>;
    aggregateCalls: number;
  }

  /** 组装被测编排：真实 ModelConfigService + 真实 RecordStore（tmpdir）+ 桩通道。 */
  function makeHarness(opts: {
    registry: ModelRegistryLike;
    /** engineSetModel 桩行为（缺省 = 成功回读）。 */
    engineSetModel?: NonNullable<ModelSwitchDeps["engineSetModel"]> extends infer F ? F : never;
    isEngineNotActive?: (err: unknown) => boolean;
    runAggregate?: ModelSwitchDeps["runAggregate"];
    assertRunNotTerminal?: ModelSwitchDeps["assertRunNotTerminal"];
    memberRunIds?: string[];
    capabilitiesSetModel?: "native" | "unsupported";
  }): Harness {
    const dir = mkdtempSync(join(tmpdir(), "u2-model-switch-"));
    const service = new ModelConfigService({ agentDir: join(dir, "agent"), cwd: dir });
    service.initModel({ modelRegistry: opts.registry, sessionId: "sess-1" });
    const store = new RecordStore(() => join(dir, "sessions"), undefined, undefined, () => join(dir, "records"));
    const record = makeRecord("sa-demo-1");
    store.register(record);

    const engineSetModelCalls: Harness["engineSetModelCalls"] = [];
    const persistedRunOverrides: Harness["persistedRunOverrides"] = [];
    let aggregateCalls = 0;

    const engineStub = {
      id: "pi",
      capabilities: () => ({
        conversation: "native",
        steer: "unsupported",
        structuredOutput: "native",
        sessionView: "native",
        permissionMode: "ignored",
        maxTurns: true,
        ...(opts.capabilitiesSetModel !== undefined ? { setModel: opts.capabilitiesSetModel } : {}),
      }),
    };

    const deps: ModelSwitchDeps = {
      getModelService: () => service,
      markModelOverride: (rec, override) => store.markModelOverride(rec, override),
      resolveEnginePort: () => engineStub as never,
      engineSetModel:
        opts.engineSetModel ??
        ((_port, params) => {
          engineSetModelCalls.push({ runId: params.runId, model: params.model });
          return Promise.resolve({
            effectiveModel: { provider: params.model.provider, modelId: `${params.model.modelId}-turbo` },
            // M1-1：热切 wire 无档位参数——回读档位 = 引擎侧联动重设语义的裁决（桩恒定值）。
            effectiveThinkingLevel: "high",
          });
        }),
      isEngineNotActiveError: opts.isEngineNotActive ?? (() => false),
      runAggregate:
        opts.runAggregate ??
        ((input) => {
          aggregateCalls += 1;
          return Promise.resolve({
            members: input.memberRunIds.map((runId) => ({ runId, state: "not-active" as const })),
            failures: [],
            summary: "已记录，未派发步骤生效。",
          });
        }),
      assertRunNotTerminal: opts.assertRunNotTerminal ?? (() => {}),
      listAcceptedMemberRunIds: () => opts.memberRunIds ?? ["sa-m1", "sa-m2"],
      persistRunOverride: (runId, override) => {
        persistedRunOverrides.push({ runId, override });
      },
    };
    return { deps, service, store, recordsDir: join(dir, "records"), record, engineSetModelCalls, persistedRunOverrides, aggregateCalls };
  }

  /** 引擎错误桩（分型错误经 code 属性承载——引擎 error 帧的宿主侧形态）。 */
  function engineError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code, name: "EngineError" });
  }

  const TARGET_MODEL = { provider: "zai-coding-cn", modelId: "glm-5.3-flash" };

  beforeEach(() => {
    live.value = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // §3.4 聚合不变量 1-5
  // ============================================================

  describe("model-switch — 聚合不变量（§3.4）", () => {
    it("不变量 1：切换操作永不改写 record.model（该轮启动模型 = 历史事实）", async () => {
      const h = makeHarness({ registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]) });
      live.value = true;
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
      expect(reply.scope).toBe("chat");
      expect(h.record.model).toBe("zai-coding-cn/glm-5.3"); // 盖章值原样
      expect(h.record.thinkingLevel).toBe("high");
    });

    it("不变量 2：同一会话至多一个覆盖值——再次切换 = 整替（不叠加）", async () => {
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" }), makeModel({ id: "glm-5.3" })]),
      });
      const first = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
      expect(first).toMatchObject({ scope: "chat" });
      const second = await setModel(h.deps, { domain: "chat", record: h.record }, { provider: "zai-coding-cn", modelId: "glm-5.3" });
      expect(second).toMatchObject({ scope: "chat" });
      expect(h.record.modelOverride?.ref).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3" });
      expect(h.service.getModelOverride(h.record.id)?.ref).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3" });
    });

    it("不变量 3：canonical ref 全等 + 目录校验通过才可写覆盖——非法 ref 零写入", async () => {
      const h = makeHarness({ registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]) });
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, { provider: "zai-coding-cn", modelId: "no-such-model" });
      expect(reply).toMatchObject({ scope: "error" });
      if (reply.scope === "error") expect(reply.message).toMatch(/is not in the pi engine model catalog/);
      expect(h.record.modelOverride).toBeUndefined();
      expect(h.service.getModelOverride(h.record.id)).toBeUndefined();
    });

    it("不变量 4：覆盖在场时解析产物恒等于覆盖值解析产物（第 0 层短路闭环）", async () => {
      const flash = makeModel({ id: "glm-5.3-flash", reasoning: true, thinkingLevelMap: LEVELS });
      const h = makeHarness({ registry: makeRegistry([flash]) });
      await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "high");
      const override = h.record.modelOverride;
      expect(override).toBeDefined();
      // 第 0 层消费记账的解析产物 = 覆盖值（与 resolveModel 直解覆盖值同形）。
      const viaTable = h.service.resolveModel(h.record.agent, undefined, undefined, undefined, {
        model: `${override!.ref.provider}/${override!.ref.modelId}`,
        thinkingLevel: override!.thinkingLevel,
      });
      expect(viaTable.model.id).toBe("glm-5.3-flash");
      expect(viaTable.thinkingLevel).toBe("high");
    });

    it("不变量 5：切换只写意图类载体——历史事实类持久化（record-created 帧）不被改写", async () => {
      const h = makeHarness({ registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]) });
      await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
      const events = await createRecordEventStream(() => h.recordsDir).scan(h.record.id);
      const created = events.find((e) => e.type === "record-created");
      const overrideFrames = events.filter((e) => e.type === "record-model-override");
      // created 帧 model 保持原盖章值；新增的只有覆盖记账帧（意图载体）。
      expect(created?.model).toBe("zai-coding-cn/glm-5.3");
      expect(overrideFrames).toHaveLength(1);
      expect(h.record.model).toBe("zai-coding-cn/glm-5.3");
    });
  });

  // ============================================================
  // §7.2 分型处置表 7 行
  // ============================================================

  describe("model-switch — 分型处置表（§7.2 七行）", () => {
    it("行 1 成功（生效值回读到手）→ 写 + 已生效型应答（回读值，非请求值）", async () => {
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
        capabilitiesSetModel: "native",
      });
      live.value = true;
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "high");
      expect(reply).toMatchObject({
        scope: "chat",
        reply: {
          kind: "effective",
          effectiveModel: { provider: "zai-coding-cn", modelId: "glm-5.3-flash-turbo" }, // 回读值（同族替换形态）
          effectiveThinkingLevel: "high",
        },
      });
      expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写
      expect(h.service.getModelOverride(h.record.id)?.ref).toEqual(TARGET_MODEL);
    });

    it("行 2 校验型失败（凭据缺失）→ 不写（含无活进程组合路径——预检两路径统一生效）", async () => {
      const unauthed = makeRegistry([makeModel({ id: "glm-5.3-flash" })], []); // 无任何已鉴权模型
      for (const isLive of [false, true]) {
        live.value = isLive;
        const h = makeHarness({ registry: unauthed, capabilitiesSetModel: "native" });
        const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
        expect(reply).toMatchObject({ scope: "error" });
        if (reply.scope === "error") expect(reply.message).toMatch(/auth is not configured/);
        expect(h.record.modelOverride).toBeUndefined(); // 未写（步骤①拦截）
        expect(h.service.getModelOverride(h.record.id)).toBeUndefined();
      }
    });

    it("行 3 快照型失败（engine_model_not_in_snapshot）→ 写 + 错误应答（模型本身有效）", async () => {
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
        capabilitiesSetModel: "native",
        engineSetModel: () => Promise.reject(engineError("engine_model_not_in_snapshot", "Model not found in child snapshot")),
      });
      live.value = true;
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
      expect(reply).toMatchObject({ scope: "chat", reply: { kind: "error", errorCode: "engine_model_not_in_snapshot" } });
      expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写
      // 持久化帧已落（下一轮 spawn 现取目录即可用的机制依据）。
      const events = await createRecordEventStream(() => h.recordsDir).scan(h.record.id);
      expect(events.filter((e) => e.type === "record-model-override")).toHaveLength(1);
    });

    it("写入返回值门（dmg-r1-10）：record 非内存实例（写入 false）→ 内存记账表同步跳过（无双介质劈叉），应答形态不变", async () => {
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
        capabilitiesSetModel: "native",
        engineSetModel: () => Promise.reject(engineError("engine_state_readback_failed", "readback failed")),
      });
      live.value = true;
      // 同 id 重建对象（gateway manifest 兜底链可能产出的形态——store.getMutable 同 id 但非同实例）
      const ghost: typeof h.record = { ...h.record };
      const reply = await setModel(h.deps, { domain: "chat", record: ghost }, TARGET_MODEL);
      // 应答形态不变（错误应答照常——生效状态未知如实报，不因写入跳过虚构校验失败）
      expect(reply).toMatchObject({ scope: "chat", reply: { kind: "error", errorCode: "engine_state_readback_failed" } });
      // 双介质劈叉消除：内存记账表未写（持久化两面 store 原语内跳过——重建对象 record 字段本就不落内存表）
      expect(h.service.getModelOverride(ghost.id)).toBeUndefined();
      expect(ghost.modelOverride).toBeUndefined();
      // 事件帧同样未写（store 原语 false 两面都跳过）
      const events = await createRecordEventStream(() => h.recordsDir).scan(ghost.id);
      expect(events.filter((e) => e.type === "record-model-override")).toHaveLength(0);
    });

    it("行 4 run 级聚合个别成员转发失败 → run 级意图恒写（内存表 + U4a 载体桩）", async () => {
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
        memberRunIds: ["sa-m1", "sa-m2", "sa-m3"],
        runAggregate: (input) =>
          Promise.resolve({
            members: [
              { runId: input.memberRunIds[0]!, state: "switched" as const, effectiveModel: input.model, effectiveThinkingLevel: "high" },
              { runId: input.memberRunIds[1]!, state: "not-active" as const },
              { runId: input.memberRunIds[2]!, state: "not-applicable" as const },
            ],
            failures: [{ runId: "sa-m1", reason: "engine_state_readback_failed" as const }],
            summary: "1 个成员切换失败，已列出失败名单。",
          }),
      });
      const reply = await setModel(h.deps, { domain: "workflow-run", runId: "run-1" }, TARGET_MODEL);
      expect(reply).toMatchObject({ scope: "workflow-run" });
      if (reply.scope === "workflow-run") {
        expect(reply.aggregate.failures).toEqual([{ runId: "sa-m1", reason: "engine_state_readback_failed" }]);
        expect(reply.aggregate.members).toHaveLength(3);
      }
      expect(h.persistedRunOverrides).toHaveLength(1); // run 级意图照写
      expect(h.persistedRunOverrides[0]?.runId).toBe("run-1");
      expect(h.service.getModelOverride("run-1")?.ref).toEqual(TARGET_MODEL);
    });

    it("行 5 竞态无活进程（转发期间子进程退出）→ 写 + 提示性应答", async () => {
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
        capabilitiesSetModel: "native",
        engineSetModel: () => Promise.reject(new Error("child exited during run")),
        isEngineNotActive: () => true,
      });
      live.value = true;
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
      expect(reply).toMatchObject({ scope: "chat", reply: { kind: "recorded" } });
      if (reply.scope === "chat" && reply.reply.kind === "recorded") {
        expect(reply.reply.notice).toMatch(/已退出/);
      }
      expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写
    });

    it("行 6 引擎不支持热切（capability 预检不支持）→ 写 + 提示性应答（不发引擎调用）", async () => {
      const engineSetModelCalls: unknown[] = [];
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
        capabilitiesSetModel: "unsupported",
        engineSetModel: (port, params) => {
          engineSetModelCalls.push({ port, params });
          return Promise.resolve({ effectiveModel: params.model, effectiveThinkingLevel: "high" });
        },
      });
      live.value = true;
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
      expect(reply).toMatchObject({ scope: "chat", reply: { kind: "recorded" } });
      if (reply.scope === "chat" && reply.reply.kind === "recorded") {
        expect(reply.reply.notice).toMatch(/暂不支持执行中热切换/);
      }
      expect(engineSetModelCalls).toHaveLength(0); // 位不支持不发调用（§7.3 能力位消费点）
      expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写
    });

    it("行 7 生效值回读失败（engine_state_readback_failed）→ 写 + 错误应答（不虚构生效值）", async () => {
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
        capabilitiesSetModel: "native",
        engineSetModel: () => Promise.reject(engineError("engine_state_readback_failed", "no readback receipt")),
      });
      live.value = true;
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL);
      expect(reply).toMatchObject({ scope: "chat", reply: { kind: "error", errorCode: "engine_state_readback_failed" } });
      expect(h.record.modelOverride?.ref).toEqual(TARGET_MODEL); // 已写（命令已送达，意图已表达）
    });
  });

  // ============================================================
  // 应答两型 + run 非终局 + 预检拦截
  // ============================================================

  describe("model-switch — 应答两型 / run 非终局 fail-fast / 档位预检", () => {
    it("已记账型应答不含档位（无回读源——档位由下次解析推导，不预告猜测值）", async () => {
      const h = makeHarness({ registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]) });
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "high");
      expect(reply.scope).toBe("chat");
      if (reply.scope === "chat" && reply.reply.kind === "recorded") {
        expect("effectiveThinkingLevel" in reply.reply).toBe(false);
        expect("effectiveModel" in reply.reply).toBe(false);
      } else {
        expect.unreachable("无活进程路径应答必须是已记账型");
      }
    });

    it("run 已终局 → 步骤① fail-fast（scope error + 零写入 + 聚合不触达）", async () => {
      const h = makeHarness({
        registry: makeRegistry([makeModel({ id: "glm-5.3-flash" })]),
        assertRunNotTerminal: () => {
          throw new Error("run already terminal (done/failed/cancelled/time_limited) — no future step to apply the override");
        },
      });
      const reply = await setModel(h.deps, { domain: "workflow-run", runId: "run-1" }, TARGET_MODEL);
      expect(reply).toMatchObject({ scope: "error" });
      if (reply.scope === "error") expect(reply.message).toMatch(/terminal/);
      expect(h.persistedRunOverrides).toHaveLength(0);
      expect(h.aggregateCalls).toBe(0);
      expect(h.service.getModelOverride("run-1")).toBeUndefined();
    });

    it("thinking 档位预检：显式候选档位对新模型不可用 → 拒（不写）", async () => {
      const onlyHigh = makeModel({ id: "glm-5.3-flash", reasoning: true, thinkingLevelMap: { high: true } });
      const h = makeHarness({ registry: makeRegistry([onlyHigh]) });
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "xhigh");
      expect(reply).toMatchObject({ scope: "error" });
      if (reply.scope === "error") expect(reply.message).toMatch(/thinkingLevel "xhigh" is not available/);
      expect(h.record.modelOverride).toBeUndefined();
    });

    it("凭据预检 + 档位预检先于 capability 分流（无活进程路径同样生效——§7.2 步骤①）", async () => {
      const unauthed = makeRegistry([makeModel({ id: "glm-5.3-flash" })], []);
      const h = makeHarness({ registry: unauthed });
      const reply = await setModel(h.deps, { domain: "chat", record: h.record }, TARGET_MODEL, "high");
      // 无活进程路径直接走记账分支，但凭据预检已在前置校验段拦截——未到记账写侧。
      expect(reply).toMatchObject({ scope: "error" });
      expect(h.record.modelOverride).toBeUndefined();
    });
  });

  // ============================================================
  // 分型词表收窄 helper
  // ============================================================

  describe("engineSetModelErrorCode", () => {
    it("分型错误经 code 属性收窄到 SDK 三型词表；非分型错误返回 undefined", () => {
      expect(engineSetModelErrorCode(engineError("engine_model_not_in_snapshot", "x"))).toBe("engine_model_not_in_snapshot");
      expect(engineSetModelErrorCode(engineError("engine_credential_missing", "x"))).toBe("engine_credential_missing");
      expect(engineSetModelErrorCode(engineError("engine_state_readback_failed", "x"))).toBe("engine_state_readback_failed");
      expect(engineSetModelErrorCode(new Error("plain"))).toBeUndefined();
      expect(engineSetModelErrorCode(undefined)).toBeUndefined();
      expect(SET_MODEL_ERROR_CODES).toHaveLength(3);
    });
  });
});
