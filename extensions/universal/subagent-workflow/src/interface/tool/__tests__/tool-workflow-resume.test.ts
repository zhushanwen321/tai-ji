/**
 * workflow tool resume action 契约（workflow-run-resume-revision U3 / D14）。
 *
 * 覆盖面（[§2.5] D14 判定已下沉 core，本文件只测壳的转发与接线面）：
 * - 转发契约：args 与 journalDir 原样下传 core（判定与拒绝文案的权威测试在 core
 *   `orchestration/__tests__/resume-args-guard.test.ts`；真链路拒绝见
 *   scenario-24-args-mismatch-rejection.test.ts）。
 * - resumeRun 接线：budgetTimeMs（time 形参透传）/ budgetTokens（tokens 形参透传）/
 *   host / runId；成功文案与 details。
 * - runId 缺失与 time/tokens 负值的入口护栏（assertEntryTimeBudget / assertEntryTokenBudget 同源）。
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

import { actionResume } from "../tool-workflow.ts";

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

// ── actionResume：入口校验与接线 ─────────────────────────────

describe("actionResume", () => {
  it("runId 缺失 → throw 用法指引（不触 resumeRun）", async () => {
    await expect(
      actionResume({ action: "resume" } as never, makeDeps("/nonexistent") as never),
    ).rejects.toThrow(/resume requires 'runId'/);
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled();
  });

  it("[§2.5 转发契约] args + journalDir 原样下传（判定在 core；journalDir = store 路径同目录，防双锚）", async () => {
    const recordPath = join(tmpDir, "wf-test.record.jsonl");
    const result = (await actionResume(
      { action: "resume", runId: "wf-test", args: { a: 1 } } as never,
      makeDeps(recordPath) as never,
    )) as { content: Array<{ text: string }>; details: Record<string, unknown> };
    expect(vi.mocked(resumeRun)).toHaveBeenCalledTimes(1);
    const [calledRunId, , options] = vi.mocked(resumeRun).mock.calls[0]!;
    expect(calledRunId).toBe("wf-test");
    expect((options as { args?: unknown }).args).toEqual({ a: 1 });
    // core 缺省走模块锚；壳必须传 store 同源目录，否则多 session 场景读成「无记录」
    expect((options as { journalDir?: string }).journalDir).toBe(tmpDir);
    expect(result.content[0]!.text).toContain("Resuming workflow run wf-test");
    expect(result.details).toMatchObject({ action: "resume", runId: "wf-test", status: "running" });
  });

  it("[§2.5 转发契约] args 缺省 → options 不带 args 键（core 侧跳过比对）", async () => {
    await actionResume(
      { action: "resume", runId: "wf-test" } as never,
      makeDeps(join(tmpDir, "missing.record.jsonl")) as never,
    );
    expect(vi.mocked(resumeRun)).toHaveBeenCalledTimes(1);
    const options = vi.mocked(resumeRun).mock.calls[0]![2] as Record<string, unknown>;
    expect("args" in options).toBe(false);
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

  it("tokens 形参透传 budgetTokens（与 time 同款通道，三档回落与落盘归 core）", async () => {
    const recordPath = writeRecordStream([runCreatedFrame('{"a":1}')]);
    await actionResume(
      { action: "resume", runId: "wf-test", args: { a: 1 }, tokens: 50_000 } as never,
      makeDeps(recordPath) as never,
    );
    const options = vi.mocked(resumeRun).mock.calls[0]![2] as { budgetTokens?: number };
    expect(options.budgetTokens).toBe(50_000);
  });

  it("tokens 缺省 → options 不带 budgetTokens 键（core 侧跳过覆盖、走三档回落）", async () => {
    await actionResume(
      { action: "resume", runId: "wf-test" } as never,
      makeDeps(join(tmpDir, "missing.record.jsonl")) as never,
    );
    const options = vi.mocked(resumeRun).mock.calls[0]![2] as Record<string, unknown>;
    expect("budgetTokens" in options).toBe(false);
  });

  it("tokens 负值 → 入口护栏拒绝（与 run action 同源 assertEntryTokenBudget）", async () => {
    await expect(
      actionResume(
        { action: "resume", runId: "wf-test", tokens: -1 } as never,
        makeDeps("/nonexistent") as never,
      ),
    ).rejects.toThrow(/tokens/);
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled();
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
