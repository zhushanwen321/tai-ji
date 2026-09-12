/**
 * readLastJsonlLine 孤儿终态判定用例（W2 移交 CRAP 43.1；私有函数，经公共 API
 * RecordStore.recoverOrphanRecords 驱动——appendEntry 捕获判定结果）。
 *
 * [HISTORICAL] 回归锚点（record-store.ts 窗口扩容注释 / V1 探针）：真实库存在
 * 28 个末行 65KB-776KB 的完整 entry（subagent-identity 的 task 内嵌大 payload）。
 * 旧实现固定 64KB 尾窗把超长末行从中间切开 → JSON.parse 失败 → 误判「截断」→
 * 孤儿恢复错落 error。本文件的 300KB 完整末行用例在旧实现上会红。
 *
 * 判定矩阵（finalizeOrphanRecord）：
 *   - 末行完整 JSON（含超长行）→ closed/gc 且无 error
 *   - 末行截断（无尾换行的半行 JSON）→ closed/gc + error "truncated last line"
 *   - 超长且截断的组合 → 仍按截断判 error（不因行长放宽）
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManifestStore } from "../execution/manifest-store";
import { RecordStore } from "../execution/record-store";

// [Gate A teardown 稳定性] no-op 掉索引落盘。根因：recoverOrphanRecords 走的
// reconstructAll（record-store.ts）扫描尾 fire-and-forget saveIndex（tmp+fsync+rename
// 异步 fs），满载下该 promise 可能在本文件 teardown 之后才 settle，其失败分支经
// logger.warn → console.warn 上报 vitest（rpc onUserConsoleLog 在途）——worker 关闭
// rpc 时在途调用被 reject 为 EnvironmentTeardownError（0 断言失败，纯 teardown 时序）。
// 本文件用一次性 tmpdir、断言只观察 appendEntry 捕获的判定结果，落盘与否无观察者——
// no-op 消除在途 IO 链，任何负载下确定；loadIndex 等其余导出保留原实现。
vi.mock("../execution/sessions-index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../execution/sessions-index.ts")>()),
  saveIndex: async () => {},
}));

interface CapturedEntry {
  type: string;
  data: Record<string, unknown>;
}

function makePiHook() {
  const entries: CapturedEntry[] = [];
  return {
    entries,
    pi: { appendEntry: vi.fn((type: string, entry: unknown) => { entries.push({ type, data: entry as Record<string, unknown> }); }) },
  };
}

describe("readLastJsonlLine 孤儿终态判定（超长末行 / 截断行）", () => {
  let rootDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "lastline-"));
    sessionsDir = path.join(rootDir, "sessions");
    fs.mkdirSync(sessionsDir);
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 写一个会被重建为 running 孤儿的子 session 文件（首行 identity + 自定义末行）。 */
  function writeOrphanSession(id: string, lastLine: string, opts: { trailingNewline?: boolean } = {}): string {
    const identity = JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id, agent: "worker", mode: "background", task: "t", slug: "s",
        startedAt: 1000, rootSessionId: "session-main", depth: 0,
      },
    });
    const file = path.join(sessionsDir, `2026-07-18T12-00-00-000Z_${id}.jsonl`);
    const middle = JSON.stringify({ type: "message", role: "assistant", content: "mid" });
    const body = [identity, middle, lastLine].join("\n") + (opts.trailingNewline === false ? "" : "\n");
    fs.writeFileSync(file, body, "utf8");
    return file;
  }

  function recovered(id: string) {
    const { pi, entries } = makePiHook();
    const store = new RecordStore(sessionsDir, new ManifestStore(path.join(rootDir, "records")), pi);
    store.recoverOrphanRecords("session-main");
    const hits = entries.filter((e) => e.data && (e.data as { id?: string }).id === id);
    if (hits.length === 0) throw new Error("orphan record not reported for " + id);
    return hits[hits.length - 1].data as Record<string, unknown>;
  }

  it("300KB 完整超长末行 → closed/gc 无 error（64KB 固定尾窗的旧实现会误判截断）", () => {
    // 300KB 单行 entry：> 64KB 初始窗 × 4 扩窗一档（64K→256K 仍不够 → 1M 覆盖到文件头）
    const bigPayload = "x".repeat(300 * 1024);
    writeOrphanSession("orphan-bigline", JSON.stringify({ type: "custom", customType: "subagent-record", data: { task: bigPayload, status: "done" } }));
    const rec = recovered("orphan-bigline");
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBe("gc");
    // 回归锚点本体：300KB 完整行不误判截断（[F3] in-flight 重启中断 error 在场，
    // 但无截断标记——64KB 固定尾窗的旧实现会把本行从中间切开判「truncated」）。
    expect(rec.error).toContain("host restart");
    expect(rec.error).not.toContain("truncated");
  });

  it("末行截断（无尾换行的半行 JSON）→ closed/gc + error 标记截断", () => {
    // 半写入形态：最后一行 JSON 被切断且无尾换行
    const truncated = '{"type":"message","role":"assistant","content":"half-written line without clos';
    writeOrphanSession("orphan-truncated", truncated, { trailingNewline: false });
    const rec = recovered("orphan-truncated");
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBe("gc");
    // [F3] 无 resumable 信号 = in-flight：截断判定并入重启中断文案（"— last line truncated"）
    expect(rec.error).toContain("host restart");
    expect(rec.error).toContain("truncated");
  });

  it("超长且截断的末行 → 仍判截断 error（扩窗是为完整行服务，不放宽截断判定）", () => {
    const bigTruncated = JSON.stringify({ type: "custom", customType: "subagent-record", data: { task: "y".repeat(300 * 1024) } }).slice(0, 300 * 1024);
    writeOrphanSession("orphan-bigcut", bigTruncated, { trailingNewline: false });
    const rec = recovered("orphan-bigcut");
    expect(rec.status).toBe("idle");
    // [F3] 无 resumable 信号 = in-flight：截断判定并入重启中断文案
    expect(rec.error).toContain("host restart");
    expect(rec.error).toContain("truncated");
  });

  it("常规末行（多行文件、完整 JSON）→ closed/gc；无 resumable 信号 = in-flight 重启中断（[F3]）", () => {
    writeOrphanSession("orphan-normal", JSON.stringify({ type: "message", role: "assistant", content: "final" }));
    const rec = recovered("orphan-normal");
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBe("gc");
    // [F3] 末行完整但无 resumable/result 信号 = 在途被重启中断：投影不得谎报 completed
    expect(rec.error).toContain("host restart");
  });

  it("仅 identity 单行文件（首行即末行，合法 JSON）→ closed 无 error", () => {
    const identity = JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id: "orphan-empty", agent: "worker", mode: "background", task: "t", slug: "s",
        startedAt: 1000, rootSessionId: "session-main", depth: 0,
      },
    });
    // identity 首行 + 紧跟空行结尾：非空段只剩 identity（窗口到文件头，首段完整）
    fs.writeFileSync(path.join(sessionsDir, "2026-07-18T12-00-00-000Z_orphan-empty.jsonl"), identity + "\n", "utf8");
    const rec = recovered("orphan-empty");
    // 唯一非空行 = identity 首行（合法 JSON）→ 无截断标记；[F3] in-flight 重启中断 error 在场
    expect(rec.status).toBe("idle");
    expect(rec.error).toContain("host restart");
    expect(rec.error).not.toContain("truncated");
  });
});
