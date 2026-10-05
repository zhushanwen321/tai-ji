/**
 * U0 rebuild 代际 record 样本采集器（workflow-visualization 设计 §4「单测化路径」样本采集落点）。
 *
 * 职责：在引擎单测 harness 内构造两类真实 record 样本（真实 Worker 线程 + 真实
 * run-event journal，无帧手工编造），供 u5 的 gantt-segments fixture 单测消费：
 * - rebuild 样本：worker 崩溃后 rebuild 重派——同 taskIndex 两帧 agent-started、
 *   帧间无 run 级转移帧（隐式代际边界），且含重放代际重落的 phase-started 帧
 *   （「重落的 phase-started 不参与锚定」断言的样本载体）与 ≥1 个带重试的 call。
 * - resume 样本：run 中断后 resume 重派——同 taskIndex 两帧 agent-started，帧间
 *   恰有 run-interrupted / run-resumed 转移帧各一。
 *
 * 构造手法（仓内先例对齐）：
 * - 真实 harness = runWorkflow + WorkerHostImpl（non-cloneable-return-e2e.test.ts
 *   先例）；崩溃注入 = 脚本内 setTimeout(process.exit)（worker_threads 内只终止
 *   本线程）+ 主线程 runner mock 首派永挂（模拟在飞 call），设计文档 §4 点名的
 *   TAIJI_SUBAGENT_TEST_INJECT_REBUILD_FAILURE 钩子用于「rebuild 失败」场景（S-D），
 *   本样本要的是 rebuild 成功重派，故不设该 env（设置即 rebuild 全失败、样本变质）。
 * - 重放代际不自杀：exit 定时器在 await agent() 返回后 clearTimeout——重放代际
 *   task-1 立即成功（runner mock 第 2 次调用），clearTimeout 必然先于定时触发
 *   （重放链毫秒级 vs 定时 200ms，余量 ~100×）；否则脚本确定性重跑会在每一代际
 *   都崩溃，run 永不收敛。
 * - record 落盘通道 = setRunEventJournalDirForTest(mkdtemp tmp)（vitest 防线下的
 *   显式注入）；fs-guard 白名单不含仓内目录，renderer fixture 目录的落盘走任务书
 *   允许的「测试断言样本特征后由采集者从测试输出复制」路径——本测试把 record 全文
 *   以 BEGIN/END 标记逐字节打印到输出，并将已落盘 fixture 与本次引擎真实产物做
 *   (type, taskIndex, phase) 帧三元组序列同构对拍：fixture 缺失 / 被手工编造或篡改
 *   帧序时本测试红。
 *
 * 领地：本文件 + packages/renderer/src/components/panel/workflow-viz/__tests__/
 * fixtures/{rebuild,resume}-generation.record.jsonl（u5 消费）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWorkflow } from "../../../orchestration/lifecycle.ts";
import { resumeRun } from "../../../orchestration/resume-run.ts";
import {
  interruptRun,
  isRunSettled,
  setRunEventJournalDirForTest,
} from "../../../orchestration/terminal-actions.ts";
import type { WorkflowRunEvent } from "../../../orchestration/run-events.ts";
import { runEventJournalPathIn, scanRunEvents } from "../../../execution/persistence/run-event-journal.ts";
import { WorkerHostImpl } from "../../../orchestration/worker-host.ts";
import type { LifecycleDeps, AgentRunner } from "../../../orchestration/models/ports.ts";
import type { AgentResult } from "../../../orchestration/models/types.ts";
import type { RunSpec } from "../../../orchestration/models/run-spec.ts";
import type { WorkflowRun } from "../../../orchestration/models/workflow-run.ts";

// ── fixture 锚点（renderer 消费方目录；领地内交付物）──────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(
  HERE,
  "../../../../../renderer/src/components/panel/workflow-viz/__tests__/fixtures",
);
const RESUME_FIXTURE = join(FIXTURE_DIR, "resume-generation.record.jsonl");

/** run 级转移帧词表（帧序特征断言用——agent 族 / phase 族 / worker-log 不属 run 级转移）。 */
const RUN_LEVEL_TRANSITIONS: ReadonlySet<string> = new Set([
  "run-interrupted",
  "run-resumed",
  "run-settled",
]);

// ── harness ─────────────────────────────────────────────────

let journalDir: string;

beforeEach(() => {
  journalDir = mkdtempSync(join(tmpdir(), "u0-rebuild-sample-"));
  // record journal 显式注入（vitest 防线下的唯一真落盘通道；编排侧包装额外清
  // 活体 fold 缓存 / 终局注册表——跨用例隔离）。
  setRunEventJournalDirForTest(journalDir);
});

afterEach(async () => {
  setRunEventJournalDirForTest(undefined);
  // 等终局 manifest 派生写（run-settled 转移链内 fire-and-forget 段，失败仅 warn
  // 留痕）落定后再删 tmp——立即删会让迟到的 rename 撞 ENOENT 刷 stderr 噪音。
  await new Promise((r) => setTimeout(r, 120));
  rmSync(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** record 文件绝对路径（单源 = runEventJournalPathIn 文件名策略）。 */
function recordPathOf(runId: string): string {
  return runEventJournalPathIn(journalDir, runId);
}

/**
 * 按 prompt 分流的 runner mock（AgentRunner port）：
 * - script 参数（failingPrompt 指定的 call）首次返回一般性失败 → 引擎重试矩阵
 *   落 agent-retrying 帧 → 第二次成功（execute-agent-call：result.error 非空且
 *   attempts < 3 可重试；缺省 failureKind = unknown = 可重试）。
 * - hungPrompt 指定的 call 首次派发永不返回（模拟在飞中崩溃/中断）；重放代际
 *   第 2 次调用立即成功——重建后的重放由此确定性穿过崩溃点。
 */
function makeScriptedRunner(opts: {
  hungPrompt: string;
  failingPrompt?: string;
  successText: string;
}): AgentRunner {
  const hungCounts = new Map<string, number>();
  const failCounts = new Map<string, number>();
  return {
    run: (callOpts): Promise<AgentResult> => {
      const prompt = callOpts.prompt;
      if (prompt === opts.hungPrompt) {
        const n = (hungCounts.get(prompt) ?? 0) + 1;
        hungCounts.set(prompt, n);
        if (n === 1) return new Promise<AgentResult>(() => {}); // 在飞挂住
        return Promise.resolve({ content: opts.successText });
      }
      if (opts.failingPrompt !== undefined && prompt === opts.failingPrompt) {
        const n = (failCounts.get(prompt) ?? 0) + 1;
        failCounts.set(prompt, n);
        if (n === 1) {
          return Promise.resolve({ content: "", error: "transient provider hiccup (sample fixture)" });
        }
      }
      return Promise.resolve({ content: opts.successText });
    },
  };
}

function makeDeps(runner: AgentRunner): LifecycleDeps {
  return {
    store: {
      save: async () => {},
      loadAll: async () => [],
      stateFilePath: (id: string) => join(journalDir, `${id}.state.jsonl`),
    },
    workerHost: new WorkerHostImpl(),
    runner,
    runs: new Map<string, WorkflowRun>(),
    eventBus: { emit: () => {} },
    onRunDone: () => {},
    log: () => {},
  } as unknown as LifecycleDeps;
}

/** 轮询直到 run 到达终态或超时（对齐 non-cloneable-return-e2e 的 waitForTerminal）。 */
async function waitForTerminal(
  runs: Map<string, WorkflowRun>,
  runId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = runs.get(runId);
    if (run && isRunSettled(run)) return;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} did not reach a terminal state within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 轮询 record 直到谓词命中或超时（返回命中时刻的全量帧序）。 */
async function waitForRecord(
  runId: string,
  predicate: (events: readonly WorkflowRunEvent[]) => boolean,
  timeoutMs: number,
): Promise<readonly WorkflowRunEvent[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await scanRunEvents(runId, journalDir);
    if (predicate(events)) return events;
    if (Date.now() > deadline) {
      throw new Error(
        `record for ${runId} did not satisfy the wait predicate within ${timeoutMs}ms; ` +
          `frames so far: ${events.map((e) => e.type).join(",")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 帧三元组投影（对拍断言的比对形态：跨运行的确定性骨架，剥 ts/runId 等易变面）。 */
function frameSignature(events: readonly WorkflowRunEvent[]): Array<[string, number | null, string | null]> {
  return events.map((e) => {
    const taskIndex = "taskIndex" in e ? (e.taskIndex as number) : null;
    const phase = "phase" in e ? ((e as { phase?: string }).phase ?? null) : null;
    return [e.type, taskIndex, phase] as [string, number | null, string | null];
  });
}

/** 从已落盘 fixture 读帧三元组序列（缺失时红并给恢复动作）。 */
function readFixtureSignature(path: string, sampleLabel: string): Array<[string, number | null, string | null]> {
  if (!existsSync(path)) {
    throw new Error(
      `fixture missing: ${path} — it must be produced by this collector test's real engine run ` +
        `(copy the U0-SAMPLE block for "${sampleLabel}" from this test's console output verbatim; ` +
        "hand-crafting frame sequences is forbidden by the task spec)",
    );
  }
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const parsed: WorkflowRunEvent[] = lines.map((l) => JSON.parse(l) as WorkflowRunEvent);
  return frameSignature(parsed);
}

/** 把 record 全文逐字节打印到测试输出（采集者按标记复制落盘 renderer fixture）。 */
function printSampleBlock(label: string, runId: string, recordPath: string): void {
  const content = readFileSync(recordPath, "utf8").trimEnd();
  console.log(`-----U0-SAMPLE-BEGIN ${label} (${runId})-----\n${content}\n-----U0-SAMPLE-END ${label}-----`);
}

/** 同 taskIndex 的 agent-started 帧下标清单。 */
function startedFrameIndexes(
  events: readonly WorkflowRunEvent[],
  taskIndex: number,
): number[] {
  const idx: number[] = [];
  events.forEach((e, i) => {
    if (e.type === "agent-started" && (e as { taskIndex: number }).taskIndex === taskIndex) idx.push(i);
  });
  return idx;
}

// ── resume 样本 ─────────────────────────────────────────────

describe("U0 resume 代际 record 样本采集", () => {
  it(
    "run 中断 → resume 重派：同 taskIndex 两帧 agent-started、帧间有 run-interrupted/run-resumed 转移帧，fixture 与引擎产物同构",
    async () => {
      const spec: RunSpec = {
        scriptName: "u0-resume-sample",
        slug: "u0-resume-sample",
        scriptPath: "u0-resume-sample.js",
        args: {},
        scriptSource: [
          'phase("alpha");',
          'await agent({ prompt: "u0-rs-task-0", description: "alpha-worker" });',
          "// task-1 在飞时宿主中断（interruptRun）——重放代际立即成功穿过断点",
          'await agent({ prompt: "u0-rs-task-1", description: "alpha-paused" });',
          "return { ok: true };",
        ].join("\n"),
      };

      const deps = makeDeps(
        makeScriptedRunner({ hungPrompt: "u0-rs-task-1", successText: "u0 sample result" }),
      );

      const runId = await runWorkflow(spec, deps);
      await waitForRecord(
        runId,
        (events) =>
          startedFrameIndexes(events, 1).length === 1 &&
          events.some((e) => e.type === "agent-settled" && (e as { taskIndex: number }).taskIndex === 0),
        10_000,
      );

      // 中断：running → interrupted（落 run-interrupted 转移帧；旧 worker 的在飞
      // call 永挂不再产生任何帧——挂住的 runner promise 永不 resolve）
      await interruptRun(runId, {
        errorCode: "crashed",
        reason: "u0 sample: host crash while call #1 in flight",
      });
      // 中断后旧 worker 仍挂着（生产形态 = 宿主已死）；保存旧 runtime 引用，
      // 测试尾部显式释放（resume 接管走 assignRuntime，不自动释放旧代际）。
      const staleRuntime = deps.runs.get(runId)!.runtime;

      // resume：资格校验（record 严格读 + fold=interrupted）→ run-resumed 落盘 →
      // 重放接管：task-0 命中回放缓存（零帧回话）、task-1 真实重派（第二帧 agent-started）
      await resumeRun(runId, deps, { host: "u0-sample-harness" });
      await waitForTerminal(deps.runs, runId, 20_000);

      try {
        const events = await scanRunEvents(runId, journalDir);
        const recordPath = recordPathOf(runId);

        // ── 帧序特征断言（验收条款②）──
        const settled = events.filter((e) => e.type === "run-settled");
        expect(settled).toHaveLength(1);
        expect((settled[0] as { outcome: string }).outcome).toBe("done");

        const startedIdx = startedFrameIndexes(events, 1);
        expect(startedIdx).toHaveLength(2);
        const [firstStart, secondStart] = startedIdx;

        // 两帧之间恰有 run-interrupted + run-resumed 各一（顺序正确），且无 run-settled
        const between = events.slice(firstStart + 1, secondStart);
        expect(between.map((e) => e.type)).toEqual([
          "run-interrupted",
          "run-resumed",
          "phase-started",
        ]);

        // 中断前第一代际：task-0 已完成（回放集）
        const before = events.slice(0, firstStart);
        expect(before.some((e) => e.type === "agent-settled" && (e as { taskIndex: number }).taskIndex === 0)).toBe(true);

        // run-interrupted 载荷带中断来源标记
        const interrupted = events.find((e) => e.type === "run-interrupted") as { errorCode?: string };
        expect(interrupted.errorCode).toBe("crashed");

        // ── 样本全文打印（先打印后对拍，同 rebuild 场景）──
        printSampleBlock("resume", runId, recordPath);

        // ── fixture 同构对拍 ──
        expect(readFixtureSignature(RESUME_FIXTURE, "resume")).toEqual(frameSignature(events));
      } finally {
        // 释放第一代际 worker（挂住 pending 的旧代际；幂等）——防活跃线程泄漏进
        // vitest worker 池。此时 run 已终局，迟到 exit 经 isRunSettled 守卫 no-op。
        staleRuntime?.release("terminal");
      }
    },
    30_000,
  );
});
