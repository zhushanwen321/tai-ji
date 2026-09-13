/**
 * [U3 / §3.2.4 迁移] 孤儿恢复与子文件末行内容解耦的回归锚。
 *
 * [HISTORICAL] 原文件验证 readLastJsonlLine 判定矩阵（超长末行扩窗 / 截断行识别）。
 * 永久会话模型 §3.2.4 重建单规则落地后：磁盘重建恒 idle、孤儿恢复只做 entry 面纠偏
 *（一律保留 idle，锚在等 revive），**子文件末行内容不再参与任何判定**——
 * readLastJsonlLine 的扩窗/截断判定机制随直断分支整体删除。
 *
 * 本文件保留的回归价值（原 V1 探针事故锚）：真实库存在 28 个末行 65KB-776KB 的
 * 完整 entry（subagent-identity 的 task 内嵌大 payload）。旧实现固定 64KB 尾窗把
 * 超长末行从中间切开 → JSON.parse 失败 → 误判「截断」→ 孤儿恢复错落 error。
 * 新实现下这类文件照常被扫描（identity 在头部）并完成 entry 纠偏——超长/截断/
 * 异构末行对孤儿恢复完全无感知（不抛错、不落 error、照常 idle）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ManifestStore } from "../execution/persistence/manifest-store";
import { RecordStore } from "../execution/persistence/record-store";

// [Gate A teardown 稳定性] no-op 掉索引落盘。根因：recoverOrphanRecords 走的
// reconstructAll（record-store.ts）扫描尾 fire-and-forget saveIndex（tmp+fsync+rename
// 异步 fs），满载下该 promise 可能在本文件 teardown 之后才 settle，其失败分支经
// logger.warn → console.warn 上报 vitest（rpc onUserConsoleLog 在途）——worker 关闭
// rpc 时在途调用被 reject 为 EnvironmentTeardownError（0 断言失败，纯 teardown 时序）。
// 本文件用一次性 tmpdir、断言只观察 appendEntry 捕获的判定结果，落盘与否无观察者——
// no-op 消除在途 IO 链，任何负载下确定；loadIndex 等其余导出保留原实现。
vi.mock("../execution/persistence/sessions-index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../execution/persistence/sessions-index.ts")>()),
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

describe("孤儿恢复与子文件末行内容解耦（超长末行 / 截断行无感知）", () => {
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

  /** 写子 session 文件（首行 identity + 自定义末行）+ 主 session 的 running 残留 entry。 */
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
    // 主 session 末条 entry 残留 running——entry 纠偏判据的命中前提
    const mainFile = path.join(rootDir, "main-session.jsonl");
    const mainEntry = JSON.stringify({
      type: "custom", id: `e-${id}`, parentId: null, customType: "subagent-record",
      data: { id, agent: "worker", task: "t", startedAt: 1000, status: "running" },
    });
    fs.writeFileSync(mainFile, mainEntry + "\n", "utf8");
    return mainFile;
  }

  function recovered(id: string, mainFile: string) {
    const { pi, entries } = makePiHook();
    const store = new RecordStore(sessionsDir, new ManifestStore(path.join(rootDir, "records")), pi);
    store.recoverOrphanRecords("session-main", mainFile);
    const hits = entries.filter((e) => e.data && (e.data as { id?: string }).id === id);
    if (hits.length === 0) throw new Error("orphan record not reported for " + id);
    return hits[hits.length - 1].data as Record<string, unknown>;
  }

  it("300KB 完整超长末行 → 照常 idle 纠偏、无 error（旧 64KB 尾窗实现会误判截断）", () => {
    // 300KB 单行 entry：> 64KB 初始窗 × 4 扩窗一档（64K→256K 仍不够 → 1M 覆盖到文件头）
    const bigPayload = "x".repeat(300 * 1024);
    const mainFile = writeOrphanSession("orphan-bigline", JSON.stringify({ type: "custom", customType: "subagent-record", data: { task: bigPayload, status: "done" } }));
    const rec = recovered("orphan-bigline", mainFile);
    // [U3 / §3.2.4] 一律保留 idle：无 closedReason、无任何 error 载体
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBeUndefined();
    expect(rec.stopReason).toBe("interrupted-by-restart");
    expect(rec.error).toBeUndefined();
  });

  it("末行截断（无尾换行的半行 JSON）→ 照常 idle 纠偏、无截断 error（末行判读路径已删）", () => {
    // 半写入形态：最后一行 JSON 被切断且无尾换行
    const truncated = '{"type":"message","role":"assistant","content":"half-written line without clos';
    const mainFile = writeOrphanSession("orphan-truncated", truncated, { trailingNewline: false });
    const rec = recovered("orphan-truncated", mainFile);
    expect(rec.status).toBe("idle");
    expect(rec.closedReason).toBeUndefined();
    expect(rec.error).toBeUndefined();
  });

  it("超长且截断的末行 → 同款无感知（不因行长/截断形态改变纠偏行为）", () => {
    const bigTruncated = JSON.stringify({ type: "custom", customType: "subagent-record", data: { task: "y".repeat(300 * 1024) } }).slice(0, 300 * 1024);
    const mainFile = writeOrphanSession("orphan-bigcut", bigTruncated, { trailingNewline: false });
    const rec = recovered("orphan-bigcut", mainFile);
    expect(rec.status).toBe("idle");
    expect(rec.error).toBeUndefined();
  });

  it("常规末行（多行文件、完整 JSON）→ 照常 idle 纠偏", () => {
    const mainFile = writeOrphanSession("orphan-normal", JSON.stringify({ type: "message", role: "assistant", content: "final" }));
    const rec = recovered("orphan-normal", mainFile);
    expect(rec.status).toBe("idle");
    expect(rec.error).toBeUndefined();
  });

  it("仅 identity 单行文件（首行即末行，合法 JSON）→ 照常 idle 纠偏", () => {
    const identity = JSON.stringify({
      type: "custom",
      customType: "subagent-identity",
      data: {
        id: "orphan-empty", agent: "worker", mode: "background", task: "t", slug: "s",
        startedAt: 1000, rootSessionId: "session-main", depth: 0,
      },
    });
    // identity 首行 + 紧跟空行结尾：非空段只剩 identity
    const file = path.join(sessionsDir, "2026-07-18T12-00-00-000Z_orphan-empty.jsonl");
    fs.writeFileSync(file, identity + "\n", "utf8");
    const mainFile = path.join(rootDir, "main-session.jsonl");
    const mainEntry = JSON.stringify({
      type: "custom", id: "e-orphan-empty", parentId: null, customType: "subagent-record",
      data: { id: "orphan-empty", agent: "worker", task: "t", startedAt: 1000, status: "running" },
    });
    fs.writeFileSync(mainFile, mainEntry + "\n", "utf8");

    const rec = recovered("orphan-empty", mainFile);
    expect(rec.status).toBe("idle");
    expect(rec.error).toBeUndefined();
  });
});
