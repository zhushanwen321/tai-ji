/**
 * workflow tool resume action 契约（workflow-run-resume-revision U3 / D14）。
 *
 * 覆盖面：
 * - D14 args 校验（场景 24 单元层）：传入 args 与 run-created 帧 argsSummary 的
 *   逐字段深度比对（排除 _runId）——不一致明确拒绝且差异字段可见；一致幂等通过；
 *   不传默认沿用历史（D14 层不拦）。场景级（真链路）用例由 u4b 落地。
 * - argsSummary 截断形态的保守拒绝（全文 args 不进 record，截断摘要不可比对）。
 * - record 流无 run-created 帧 → D14 层透传（资格判据归 core resumeRun 权威文案）。
 * - resumeRun 接线：budgetTimeMs（time 形参透传）/ host / runId；成功文案与 details。
 * - diffResumeArgs 纯逻辑（差异三形态 + 嵌套 + 数组 + _runId 排除）。
 *
 * mock 策略：resume-run 深路径 stub（resumeRun 为 vi.fn——不起锁/IO，只测入口
 * 面与校验层）；record 流用 mkdtemp 真文件（D14 读取面读真实路径）。范式对齐
 * tool-workflow.test.ts（lifecycle 深路径 mock + captureTool 注册层黑盒）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 被 mock 的模块——import 路径与被测源文件的等值实例（vi.mock hoist 后 barrel
// re-export 与深路径指向同一 mock 实例，对齐 tool-workflow.test.ts 先例）
import { resumeRun } from "@zhushanwen/subagent-core/orchestration/resume-run.ts";

import { actionResume, diffResumeArgs } from "../tool-workflow.ts";

/** 桩化 resume-run——resumeRun 为 vi.fn（不起锁/record IO，只测入口校验与接线面）。 */
vi.mock("@zhushanwen/subagent-core/orchestration/resume-run.ts", () => ({
  resumeRun: vi.fn(),
}));

// ── fixture ──────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  vi.mocked(resumeRun).mockReset();
  vi.mocked(resumeRun).mockResolvedValue("wf-test");
  tmpDir = mkdtempSync(join(tmpdir(), "u3-resume-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.restoreAllMocks();
});

/** 写 record 流（每行一个 JSON 对象）并返回路径——D14 读取面的真实文件。 */
function writeRecordStream(lines: unknown[]): string {
  const path = join(tmpDir, "wf-test.record.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return path;
}

/** run-created 帧（args 含 _runId——对齐 lifecycle runWorkflow 注入后落账形态）。 */
function runCreatedFrame(argsSummary: string) {
  return {
    type: "run-created",
    seq: 1,
    ts: 1_700_000_000_000,
    runId: "wf-test",
    workflowName: "demo",
    argsSummary,
    scriptSource: "// demo",
  };
}

/** 最小 deps stub（actionResume 只触 store.stateFilePath 与 resumeRun(deps)）。 */
function makeDeps(stateFilePath: string): unknown {
  return {
    runs: new Map(),
    store: { stateFilePath: () => stateFilePath },
    registry: { get: vi.fn(), getPath: vi.fn(), loadAll: vi.fn() },
  };
}

// ── diffResumeArgs 纯逻辑 ────────────────────────────────────

describe("diffResumeArgs（D14 深度比对）", () => {
  it("值不等 → 差异字段可见（场景 24 前半：{a:1} 历史以 {a:2} 发）", () => {
    expect(diffResumeArgs({ a: 2 }, { a: 1, _runId: "wf-test" })).toEqual([
      "args.a: resume 2 vs original 1",
    ]);
  });

  it("一致 → 空（场景 24 后半：{a:1} 幂等通过）", () => {
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
      'args.items: resume [1,2] vs original [1,3]',
    ]);
    expect(diffResumeArgs({ items: [1, 2] }, { items: [1, 2] })).toEqual([]);
  });
});

// ── actionResume：入口校验与接线 ─────────────────────────────

describe("actionResume", () => {
  it("runId 缺失 → throw 用法指引（不触 resumeRun）", async () => {
    await expect(
      actionResume({ action: "resume" } as never, makeDeps("/nonexistent") as never),
    ).rejects.toThrow(/resume requires 'runId'/);
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled();
  });

  it("args 与历史不一致 → 拒绝且差异字段可见，不触 resumeRun（场景 24 前半）", async () => {
    const recordPath = writeRecordStream([runCreatedFrame('{"a":1,"_runId":"wf-test"}')]);
    const err = await actionResume(
      { action: "resume", runId: "wf-test", args: { a: 2 } } as never,
      makeDeps(recordPath) as never,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("differ from the original run");
    expect(err.message).toContain("args.a: resume 2 vs original 1");
    expect(err.message).toContain("start a new run");
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled();
  });

  it("args 与历史一致 → 幂等通过（场景 24 后半），resumeRun 接线生效", async () => {
    const recordPath = writeRecordStream([runCreatedFrame('{"a":1,"_runId":"wf-test"}')]);
    const result = (await actionResume(
      { action: "resume", runId: "wf-test", args: { a: 1 } } as never,
      makeDeps(recordPath) as never,
    )) as { content: Array<{ text: string }>; details: Record<string, unknown> };
    expect(vi.mocked(resumeRun)).toHaveBeenCalledTimes(1);
    const [calledRunId, calledDeps, options] = vi.mocked(resumeRun).mock.calls[0]!;
    expect(calledRunId).toBe("wf-test");
    expect(calledDeps).toBeDefined();
    expect((options as { budgetTimeMs?: number }).budgetTimeMs).toBeUndefined();
    expect(typeof (options as { host?: string }).host).toBe("string");
    expect(result.content[0]!.text).toContain("Resuming workflow run wf-test");
    expect(result.details).toMatchObject({ action: "resume", runId: "wf-test", status: "running" });
  });

  it("args 缺省 → 默认沿用历史（D14 层不拦，不读 record）", async () => {
    await actionResume(
      { action: "resume", runId: "wf-test" } as never,
      makeDeps(join(tmpDir, "missing.record.jsonl")) as never,
    );
    expect(vi.mocked(resumeRun)).toHaveBeenCalledTimes(1);
  });

  it("record 流无 run-created 帧 → D14 层透传（资格判据归 resumeRun 权威文案）", async () => {
    const recordPath = writeRecordStream([
      { type: "phase-started", seq: 1, ts: 1, phase: "p1" },
    ]);
    await actionResume(
      { action: "resume", runId: "wf-test", args: { a: 1 } } as never,
      makeDeps(recordPath) as never,
    );
    expect(vi.mocked(resumeRun)).toHaveBeenCalledTimes(1);
  });

  it("argsSummary 截断 → 保守拒绝（无法逐字段比对；引导免 args resume 或开新 run）", async () => {
    const long = "x".repeat(300);
    const recordPath = writeRecordStream([runCreatedFrame(`{"payload":"${long}","_runId":"wf-test"}…`)]);
    const err = await actionResume(
      { action: "resume", runId: "wf-test", args: { payload: long } } as never,
      makeDeps(recordPath) as never,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("exceed the record's args summary limit");
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled();
  });

  it("time 形参透传 budgetTimeMs（u2 偏差②：预算经 D14 同款通道传入）", async () => {
    const recordPath = writeRecordStream([runCreatedFrame('{"a":1}')]);
    await actionResume(
      { action: "resume", runId: "wf-test", args: { a: 1 }, time: 120_000 } as never,
      makeDeps(recordPath) as never,
    );
    const options = vi.mocked(resumeRun).mock.calls[0]![2] as { budgetTimeMs?: number };
    expect(options.budgetTimeMs).toBe(120_000);
  });

  it("time 负值 → 入口护栏拒绝（与 run action 同源 assertEntryTimeBudget）", async () => {
    await expect(
      actionResume(
        { action: "resume", runId: "wf-test", time: -1 } as never,
        makeDeps("/nonexistent") as never,
      ),
    ).rejects.toThrow(/time/);
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled();
  });
});
