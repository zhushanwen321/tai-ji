// src/orchestration/__tests__/resume-args-guard.test.ts
//
// [§2.5 D14 下沉] resume args 一致性判定单源（原壳层 tool-workflow.ts 实现下沉）。
//
// 覆盖面：
// - diffResumeArgs 纯逻辑（差异三形态 + 嵌套 + 数组 + `_runId` 双侧排除）；
// - historicalArgsOf 数据源形态（args 全文 / 缺席 / 旧格式截断摘要 / 篡改两形态）；
// - assertResumeArgsMatch 判定与文案（不一致列差异字段 / 一致通过 / 截断保守拒绝 /
//   缺席放行）；
// - 端到端：resumeRun 传不一致 args → 拒绝且**零副作用**（不强占 run、不落
//   run-resumed 帧）——下沉后 D14 与资格判据同段执行，这是「fail-fast」的锁。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertResumeArgsMatch,
  diffResumeArgs,
  historicalArgsOf,
} from "../resume-args-guard.ts";
import { resumeRun } from "../resume-run.ts";
import { createRunEventJournal } from "../run-events.ts";
import { setRunEventJournalDirForTest } from "../terminal-actions.ts";
import type { WorkflowRunEvent } from "../run-events.ts";
import type { LifecycleDeps } from "../models/ports.ts";
import type { WorkerHandle } from "../worker-handle.ts";

const runCreated = (
  payload: { args?: unknown; argsSummary?: unknown },
): Extract<WorkflowRunEvent, { type: "run-created" }> =>
  ({ type: "run-created", runId: "wf-guard", workflowName: "demo", ts: 1, ...payload }) as never;

const reject = (message: string): Error => new Error(message);

describe("diffResumeArgs（D14 深度比对）", () => {
  it("值不等 → 差异字段可见", () => {
    expect(diffResumeArgs({ a: 2 }, { a: 1, _runId: "wf-test" })).toEqual([
      "args.a: resume 2 vs original 1",
    ]);
  });

  it("一致 → 空", () => {
    expect(diffResumeArgs({ a: 1 }, { a: 1, _runId: "wf-test" })).toEqual([]);
  });

  it("_runId 双侧排除（incoming 侧携带同样不比）", () => {
    expect(diffResumeArgs({ a: 1, _runId: "other" }, { a: 1, _runId: "wf-test" })).toEqual([]);
  });

  it("仅 resume 侧有 → unexpected 形态", () => {
    expect(diffResumeArgs({ a: 1, b: 2 }, { a: 1 })).toEqual([
      "args.b: resume args only (not in original run)",
    ]);
  });

  it("仅原 run 侧有 → missing 形态", () => {
    expect(diffResumeArgs({ a: 1 }, { a: 1, b: "x" })).toEqual([
      "args.b: original run only (missing from resume args)",
    ]);
  });

  it("嵌套 plain object 递归（路径 a.b 形态）", () => {
    expect(
      diffResumeArgs({ cfg: { deep: 1, same: "s" } }, { cfg: { deep: 2, same: "s" } }),
    ).toEqual(["args.cfg.deep: resume 1 vs original 2"]);
  });

  it("数组按值整体比（不递归元素）", () => {
    expect(diffResumeArgs({ items: [1, 2] }, { items: [1, 3] })).toEqual([
      "args.items: resume [1,2] vs original [1,3]",
    ]);
    expect(diffResumeArgs({ items: [1, 2] }, { items: [1, 2] })).toEqual([]);
  });
});

describe("historicalArgsOf（数据源形态）", () => {
  it("args 全文优先（大 args 也可逐字段比对）", () => {
    expect(historicalArgsOf("wf", runCreated({ args: { a: 1 }, argsSummary: '{"a":9}' }))).toEqual({
      kind: "args",
      args: { a: 1 },
    });
  });

  it("缺席 → absent（无帧 / 帧内无 args 与 argsSummary / 空摘要）", () => {
    expect(historicalArgsOf("wf", undefined)).toEqual({ kind: "absent" });
    expect(historicalArgsOf("wf", runCreated({}))).toEqual({ kind: "absent" });
    expect(historicalArgsOf("wf", runCreated({ argsSummary: "" }))).toEqual({ kind: "absent" });
  });

  it("旧格式截断摘要（… 尾标）→ truncated", () => {
    expect(historicalArgsOf("wf", runCreated({ argsSummary: '{"a":"xxx…"}…' }))).toEqual({
      kind: "truncated",
    });
  });

  it("旧格式未截断摘要 → 解析为 args（尽力恢复）", () => {
    expect(historicalArgsOf("wf", runCreated({ argsSummary: '{"a":1,"_runId":"x"}' }))).toEqual({
      kind: "args",
      args: { a: 1, _runId: "x" },
    });
  });

  it("篡改两形态 → 结构化拒绝（裸 SyntaxError 不透出）", () => {
    expect(() => historicalArgsOf("wf", runCreated({ args: [1, 2] }))).toThrow(
      /are malformed in its record stream/,
    );
    expect(() => historicalArgsOf("wf", runCreated({ argsSummary: "{broken json" }))).toThrow(
      /are malformed in its record stream/,
    );
    expect(() => historicalArgsOf("wf", runCreated({ argsSummary: "42" }))).toThrow(
      /are malformed in its record stream/,
    );
  });
});

describe("assertResumeArgsMatch（判定与文案）", () => {
  it("不一致 → 拒绝含差异字段与恢复动作", () => {
    expect(() =>
      assertResumeArgsMatch("wf-guard", { a: 2 }, runCreated({ args: { a: 1 } }), reject),
    ).toThrow(/differ from the original run[\s\S]*args\.a: resume 2 vs original 1[\s\S]*start a new run/);
  });

  it("一致 → 通过", () => {
    expect(() =>
      assertResumeArgsMatch("wf-guard", { a: 1 }, runCreated({ args: { a: 1, _runId: "r" } }), reject),
    ).not.toThrow();
  });

  it("截断摘要 → 保守拒绝（引导免 args resume 或开新 run）", () => {
    expect(() =>
      assertResumeArgsMatch("wf-guard", { a: 1 }, runCreated({ argsSummary: '{"a":"x"}…' }), reject),
    ).toThrow(/exceed the record's args summary limit/);
  });

  it("缺席 → 放行（资格判据归 resumeRun，不在 D14 层拒绝）", () => {
    expect(() => assertResumeArgsMatch("wf-guard", { a: 1 }, undefined, reject)).not.toThrow();
  });
});

// ── 端到端：fail-fast 于任何副作用之前 ──────────────────────

let journalDir: string;

beforeEach(() => {
  journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-args-guard-"));
  setRunEventJournalDirForTest(journalDir);
});

afterEach(() => {
  setRunEventJournalDirForTest(undefined);
  fs.rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeDeps(): { deps: LifecycleDeps; runs: Map<string, unknown> } {
  const runs = new Map();
  const deps: LifecycleDeps = {
    store: { save: vi.fn(async () => {}), loadAll: vi.fn(async () => []), stateFilePath: vi.fn(() => "") },
    workerHost: {
      start: vi.fn(
        () => ({ postMessage: vi.fn(), terminate: vi.fn(async () => {}) }) as unknown as WorkerHandle,
      ),
    },
    runner: { run: vi.fn(async () => ({ content: "" })) },
    runs: runs as never,
    appendEntry: vi.fn(),
    eventBus: { emit: vi.fn() },
    onRunDone: vi.fn(),
    log: vi.fn(),
    scheduleTimeBudget: vi.fn(),
  };
  return { deps, runs };
}

describe("resumeRun × D14（端到端）", () => {
  it("args 不一致 → ResumeRejectionError 且零副作用（不落 run-resumed 帧、不占 run）", async () => {
    const journal = createRunEventJournal(journalDir);
    await journal.append("wf-guard-e2e", {
      type: "run-created",
      runId: "wf-guard-e2e",
      workflowName: "test-wf",
      argsSummary: "{}",
      args: { a: 1, _runId: "wf-guard-e2e" },
      scriptSource: "async function execute() {}",
      ts: 1_770_000_000_000,
    });
    await journal.append("wf-guard-e2e", {
      type: "run-interrupted",
      errorCode: "crashed",
      reason: "test crash",
      ts: 1_770_000_001_000,
    });

    const { deps, runs } = makeDeps();
    await expect(
      resumeRun("wf-guard-e2e", deps, { journalDir, args: { a: 2 } }),
    ).rejects.toMatchObject({ name: "ResumeRejectionError" });

    const events = await journal.scan("wf-guard-e2e");
    expect(events.some((e) => e.type === "run-resumed")).toBe(false);
    expect(runs.size).toBe(0);
  });
});
