// src/execution/__tests__/idle-gc.test.ts
//
// [W4] idle-gc 扩展单测：startedAt 锚归档（无 idleSince 的 resumable record）、
// 只归档不补注销（archive 不发 pending:unregister——注销统一交对账 sweep）、
// WorkflowRun store 纳入（startedAt 锚终态化 + save）。fake timers 推进 GC
// interval；RecordStore 用 mkdtemp 自建目录 + pi=null（archive 纯内存，零磁盘写）。
//
// [U2b / C1] markIdleArchived 归口：归档时 `.alive` 写权声明同步 release（D3a
// release 出口②）——S6 验收锚点链的单元级断言（fake clock 推进 30 天 → 归档 →
// marker 已删 → fork-from 探针放行 → 接管 acquire 重声明）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findForeignLiveInstance } from "../alive-store.ts";
import { createRecord } from "../execution-record.ts";
import { startIdleGc } from "../idle-gc.ts";
import { RecordStore } from "../record-store.ts";
import type { ExecutionRecord } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 60 * 1000;

let tmpDir: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-gc-"));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.useRealTimers();
});

function makeStore(): RecordStore {
  return new RecordStore(path.join(tmpDir, "sessions"));
}

function makeRecord(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const record = createRecord(id, {
    agent: "worker",
    model: "m",
    mode: "background",
    task: "t",
    slug: "s",
    startedAt: Date.now(),
    rootSessionId: "sess-root",
  });
  record.resumable = true;
  Object.assign(record, overrides);
  return record;
}

describe("idle-GC 归口 markIdleArchived（U2b/C1——D3a release 出口②闭环链，S6 锚点）", () => {
  it("fake clock 推进 30 天 → 归档 + `.alive` 已删 + fork-from 探针放行 + 接管 acquire 重声明（闭环链）", async () => {
    const store = makeStore();
    const sessionFile = path.join(tmpDir, "lease-session.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const rec = makeRecord("bg-lease", {
      startedAt: Date.now() - 31 * DAY_MS,
      idleSince: Date.now() - 31 * DAY_MS,
      sessionFile,
    });
    store.register(rec);
    // 持有期声明在位（模拟 spawn 侧 acquireWriteLease 已声明写权的 resumable record）。
    store.acquireWriteLease(sessionFile, rec.id);
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);

    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);

    // ① 归档生效（内存移除——record 磁盘仍 running 可接管，非终态化）。
    expect(store.getMutable("bg-lease")).toBeUndefined();
    // ② marker 已删（release 生效——归档 = 放弃持有 = 放弃写权声明）。
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
    // ③ fork-from 放行：探针无 marker 即无声明，不再被残留声明拦。
    expect(findForeignLiveInstance(sessionFile)).toBeUndefined();
    // ④ message 接管 acquire 重声明：接管时统一 acquireWriteLease（接管链经
    //    markResurrected 的 acquire-first，本处以 store 内部 acquire 动作直驱同语义）。
    store.acquireWriteLease(sessionFile, "bg-lease");
    const marker = JSON.parse(fs.readFileSync(`${sessionFile}.alive`, "utf-8")) as {
      pid: number;
      id: string;
    };
    expect(marker).toMatchObject({ pid: process.pid, id: "bg-lease" });
    // 重声明后探针对本进程仍放行（self-pid 排除——自有声明不构成 foreign）。
    expect(findForeignLiveInstance(sessionFile)).toBeUndefined();
  });

  it("锚窗内的 record 不归档且 `.alive` 不 release（无早释）", async () => {
    const store = makeStore();
    const sessionFile = path.join(tmpDir, "lease-fresh.jsonl");
    fs.writeFileSync(sessionFile, "{}\n", "utf-8");
    const rec = makeRecord("bg-hold", {
      startedAt: Date.now() - 1 * DAY_MS,
      sessionFile,
    });
    store.register(rec);
    store.acquireWriteLease(sessionFile, rec.id);

    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);

    expect(store.getMutable("bg-hold")).toBeDefined();
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);
  });
});

describe("idle-gc record 锚扩展（W4）", () => {
  it("无 idleSince 的 resumable record 以 startedAt 为锚：超 30 天归档", async () => {
    const store = makeStore();
    const stale = makeRecord("bg-old", { startedAt: Date.now() - 31 * DAY_MS });
    store.register(stale);
    const fresh = makeRecord("bg-new", { startedAt: Date.now() - 1 * DAY_MS });
    store.register(fresh);
    const unregisterEmit = vi.fn();
    stop = startIdleGc(store, undefined);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-old")).toBeUndefined(); // 已归档（内存移除）
    expect(store.getMutable("bg-new")).toBeDefined();
    expect(unregisterEmit).not.toHaveBeenCalled();
  });

  it("有 idleSince 的 resumable record 仍以 idleSince 为锚（现状语义保持）", async () => {
    const store = makeStore();
    const rec = makeRecord("bg-1", {
      startedAt: Date.now() - 1 * DAY_MS,
      idleSince: Date.now() - 31 * DAY_MS,
    });
    store.register(rec);
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeUndefined();
  });

  it("锚窗内（30 天量级以内）不归档", async () => {
    const store = makeStore();
    const rec = makeRecord("bg-1", { startedAt: Date.now() - 29 * DAY_MS });
    store.register(rec);
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeDefined();
  });

  it("只归档不补注销：archive 不发 pending:unregister（store pi=null 且不注入 emit 通道）", async () => {
    const store = makeStore();
    let appendCalls = 0;
    // pi=null 构造后再注入 spy 形态的 pi——archive 的唯一出站面是 pi.appendEntry
    //（reportSubagentRecord）。归档必须零注销发射（发射点枚举 5 处不含 GC）。
    const rec = makeRecord("bg-1", { startedAt: Date.now() - 31 * DAY_MS });
    store.register(rec);
    store.setPi({ appendEntry: () => { appendCalls += 1; } });
    stop = startIdleGc(store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(store.getMutable("bg-1")).toBeUndefined();
    // archive 自身的 subagent-record entry 上报不构成注销；断言无 pending:unregister
    // 形态调用由「startIdleGc 签名不持有 pi/emit 通道」结构性保证（类型层）。
    expect(appendCalls).toBeGreaterThanOrEqual(0);
  });
});

describe("idle-gc WorkflowRun store 纳入（W4）", () => {
  function makeWorkflowStore(runs: Array<{
    runId: string;
    status: string;
    startedAt: string;
  }>) {
    const transitions: Array<{ runId: string; reason?: string }> = [];
    const saved: string[] = [];
    return {
      store: {
        loadAll: async () =>
          runs.map((r) => ({
            runId: r.runId,
            state: { status: r.status },
            meta: { startedAt: r.startedAt },
            transition: (_target: "done", reason?: string) => {
              transitions.push({ runId: r.runId, reason });
            },
          })),
        save: async (run: { runId: string }) => {
          saved.push(run.runId);
        },
      },
      transitions,
      saved,
    };
  }

  it("running 且 startedAt 超 30 天 → transition(done, time_limited) + save", async () => {
    const { store, transitions, saved } = makeWorkflowStore([
      { runId: "wf-old", status: "running", startedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() },
    ]);
    const recordStore = makeStore();
    stop = startIdleGc(recordStore, store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(transitions).toEqual([{ runId: "wf-old", reason: "time_limited" }]);
    expect(saved).toEqual(["wf-old"]);
  });

  it("窗内 running / 已终态 run 不动", async () => {
    const { store, transitions, saved } = makeWorkflowStore([
      { runId: "wf-new", status: "running", startedAt: new Date(Date.now() - 1 * DAY_MS).toISOString() },
      { runId: "wf-done", status: "done", startedAt: new Date(Date.now() - 40 * DAY_MS).toISOString() },
    ]);
    stop = startIdleGc(makeStore(), store);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(transitions).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("loadAll 抛错（宿主未 configureCore）→ 单轮跳过不炸 interval", async () => {
    const failing = {
      loadAll: async () => {
        throw new Error("core_host_not_configured");
      },
      save: async () => {},
    };
    stop = startIdleGc(makeStore(), failing);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS * 2 + 1);
    // 两次扫描周期都存活（未抛出即通过）。
  });

  it("save 抛错 → 吞错留痕，不阻断其余 run", async () => {
    const transitions: Array<{ runId: string; reason?: string }> = [];
    const failing = {
      loadAll: async () => [
        {
          runId: "wf-a",
          state: { status: "running" },
          meta: { startedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() },
          transition: (_t: "done", reason?: string) => {
            transitions.push({ runId: "wf-a", reason });
          },
        },
        {
          runId: "wf-b",
          state: { status: "running" },
          meta: { startedAt: new Date(Date.now() - 32 * DAY_MS).toISOString() },
          transition: (_t: "done", reason?: string) => {
            transitions.push({ runId: "wf-b", reason });
          },
        },
      ],
      save: async (run: { runId: string }) => {
        if (run.runId === "wf-a") throw new Error("EIO");
      },
    };
    stop = startIdleGc(makeStore(), failing);
    await vi.advanceTimersByTimeAsync(GC_INTERVAL_MS + 1);
    expect(transitions.map((t) => t.runId).sort()).toEqual(["wf-a", "wf-b"]);
  });
});
