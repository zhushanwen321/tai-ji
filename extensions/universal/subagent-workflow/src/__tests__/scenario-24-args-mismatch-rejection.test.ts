// src/__tests__/scenario-24-args-mismatch-rejection.test.ts
//
// 场景 24（修订设计 §4，D14）：args 不一致拒绝。
// 原步骤：对历史 args 为 {a:1} 的 run 以 {a:2} 发 resume，再以 {a:1} 发。
// 通过标准：前者拒绝且差异字段可见；后者幂等通过。
//
// 驱动链路（与 u4a 场景族的分界）：u4a 场景直驱 core resumeScenarioRun
// （resumeRun 编排原语），本场景的 D14 args 校验唯一所在层 = 壳层入口
// actionResume（tool-workflow resume action 的 U3 实装）——故直驱该公开入口
// （与单元层 tool-workflow-resume.test.ts 同名入口，但本文件不 stub resume-run：
// 真 resumeRun + 真 record IO + 真 WorkerHost，deps.store.stateFilePath 解析到
// seed 的真实 record 路径，resumeRun 经模块锚（mkScenarioEnv 注入）定位同目录）。
// LLM 层替身 = faux runner（u4a 同款），崩溃前置态 = seedCrashedRun。
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LauncherDeps } from "@zhushanwen/subagent-core";

import { actionResume } from "../interface/tool-workflow.ts";
import type { ScenarioDeps } from "./record-mode/scenario-kit.ts";
import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  scanScenarioEvents,
  seedCrashedRun,
  THREE_CALL_SERIAL_SCRIPT,
  waitForScenarioSettled,
} from "./record-mode/scenario-kit.ts";

/** 历史 args 的生产形态：rfl 仪表向 spec.args 注入 _runId 后 stringify 落账。 */
const HISTORICAL_ARGS_SUMMARY = JSON.stringify({ a: 1, _runId: "wf-s24-run" });

/**
 * 终局 manifest（<stateDir>/<runId>.json 派生缓存）是 run-settled 落盘后的异步
 * 投影（terminal-actions 终局 coda）——cleanup 前等它落盘，防 teardown 删目录与
 * 投影 rename 的竞态告警（场景族无噪音形态）。
 */
async function waitForTerminalManifest(env: ReturnType<typeof mkScenarioEnv>, runId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(join(env.stateDir, `${runId}.json`))) {
    if (Date.now() > deadline) {
      throw new Error(`terminal manifest for ${runId} not written within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 壳层 deps = 场景 deps + registry 桩（resume 链不触 registry——发现依赖归
 * actionRun；stub 满足 WorkflowScriptRegistry 四方法契约）。
 */
function makeShellDeps(sd: ScenarioDeps): LauncherDeps {
  return {
    ...sd.deps,
    registry: {
      loadAll: async () => [],
      get: async () => undefined,
      getPath: async () => undefined,
      invalidate: () => {},
    },
  };
}

/** 断言 record 无 run-resumed / run-settled、无活体注册、零派发（拒绝后状态无损）。 */
async function expectRejectionLeftNoTrace(sd: ScenarioDeps, env: ReturnType<typeof mkScenarioEnv>, runId: string): Promise<void> {
  const events = await scanScenarioEvents(env, runId);
  expect(events.some((e) => e.type === "run-resumed")).toBe(false);
  expect(events.some((e) => e.type === "run-settled")).toBe(false);
  expect(sd.runs.has(runId)).toBe(false);
  expect(sd.faux.dispatches).toHaveLength(0);
}

describe("场景 24：args 不一致拒绝（D14 fail-fast）", () => {
  it.each([
    {
      desc: "单字段值不同（设计行前半：历史 {a:1} 以 {a:2} 发）",
      runId: "wf-s24-mismatch",
      incoming: { a: 2 },
      diffLine: "args.a: resume 2 vs original 1",
    },
    {
      desc: "新增字段（resume 侧多出的键）",
      runId: "wf-s24-extra",
      incoming: { a: 1, extra: "x" },
      diffLine: "args.extra: resume args only (not in original run)",
    },
    {
      desc: "缺失字段（原 run 侧有的键被省略）",
      runId: "wf-s24-missing",
      incoming: {},
      diffLine: "args.a: original run only (missing from resume args)",
    },
  ])("$desc → 拒绝且差异字段可见，record / 活体态零触碰", async ({ runId, incoming, diffLine }) => {
    const env = mkScenarioEnv("24m");
    try {
      await seedCrashedRun(env, runId, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        argsSummary: HISTORICAL_ARGS_SUMMARY,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });
      const sd = makeScenarioDeps(env, makeFauxRunner());

      const err = await actionResume(
        { action: "resume", runId, args: incoming } as Parameters<typeof actionResume>[0],
        makeShellDeps(sd),
      ).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      // 拒绝文案三要素：判定 + 差异字段逐条可见 + 恢复指引（新 run / 原样传 / 省略沿用）
      expect(err.message).toContain("differ from the original run");
      expect(err.message).toContain(diffLine);
      expect(err.message).toContain("start a new run");

      await expectRejectionLeftNoTrace(sd, env, runId);
    } finally {
      env.cleanup();
    }
  });

  it("一致幂等通过（设计行后半：历史 {a:1,_runId} 以 {a:1} 发）→ 真链路 resume，A/B 回放零派发、C 派发、run completed", async () => {
    const runId = "wf-s24-run";
    const env = mkScenarioEnv("24ok");
    try {
      await seedCrashedRun(env, runId, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        argsSummary: HISTORICAL_ARGS_SUMMARY,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });
      const sd = makeScenarioDeps(env, makeFauxRunner());

      const result = await actionResume(
        { action: "resume", runId, args: { a: 1 } } as Parameters<typeof actionResume>[0],
        makeShellDeps(sd),
      );
      const summary = await waitForScenarioSettled(sd.runs, runId);
      expect(summary.reason).toBe("completed");
      await waitForTerminalManifest(env, runId);

      // D14 放行后走完整 resume 链：A/B 回放零 token（无派发），C 真实派发恰一次
      expect(sd.faux.dispatches).toHaveLength(1);
      expect(sd.faux.dispatches[0]!.opts["agent"]).toBe("C");
      const events = await scanScenarioEvents(env, runId);
      expect(events.some((e) => e.type === "run-resumed")).toBe(true);
      expect(String((result as { content: Array<{ text: string }> }).content[0]!.text)).toContain(`Resuming workflow run ${runId}`);
    } finally {
      env.cleanup();
    }
  });

  it("_runId 排除键：incoming 侧携带不同 _runId 值 → 排除后一致放行（机器字段不属用户意图）", async () => {
    const runId = "wf-s24-runid";
    const env = mkScenarioEnv("24rid");
    try {
      await seedCrashedRun(env, runId, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        // 历史侧 _runId = runId 本身；incoming 侧 _runId 值不同——双侧剔除后 {a:1} 一致
        argsSummary: JSON.stringify({ a: 1, _runId: runId }),
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });
      const sd = makeScenarioDeps(env, makeFauxRunner());

      await actionResume(
        { action: "resume", runId, args: { a: 1, _runId: "wf-s24-runid" } } as Parameters<typeof actionResume>[0],
        makeShellDeps(sd),
      );
      const summary = await waitForScenarioSettled(sd.runs, runId);
      expect(summary.reason).toBe("completed");
      await waitForTerminalManifest(env, runId);
      expect(sd.faux.dispatches.map((d) => d.opts["agent"])).toEqual(["C"]);
    } finally {
      env.cleanup();
    }
  });

  it("现行格式：超长 args 全文随帧落盘 → 传 args 逐字段深度比对通过（截断退化不复存在）+ 不一致逐字段可见", async () => {
    const runId = "wf-s24-fullargs";
    const env = mkScenarioEnv("24fa");
    try {
      // 生产写面 dispatchRunCreated 现行形态：args 全文 + argsSummary 摘要随帧
      // 双落（超长 args 的摘要截断不影响全文比对面）
      const longPayload = "y".repeat(400);
      const historical = { payload: longPayload, _runId: runId };
      const serialized = JSON.stringify({ payload: longPayload, _runId: runId });
      expect(serialized.length).toBeGreaterThan(256);
      await seedCrashedRun(env, runId, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        args: historical,
        argsSummary: `${serialized.slice(0, 256)}…`,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      // 传原 args（剔除 _runId 机器字段）→ D14 逐字段比对通过，resume 真链路续跑
      const sd = makeScenarioDeps(env, makeFauxRunner());
      await actionResume(
        { action: "resume", runId, args: { payload: longPayload } } as Parameters<typeof actionResume>[0],
        makeShellDeps(sd),
      );
      const summary = await waitForScenarioSettled(sd.runs, runId);
      expect(summary.reason).toBe("completed");
      await waitForTerminalManifest(env, runId);
      expect(sd.faux.dispatches.map((d) => d.opts["agent"])).toEqual(["C"]);

      // 传不一致 args → 逐字段差异可见（截断形态下曾退化为「传 args 一律拒绝」，
      // 全文面恢复「逐字段深度比对」承诺）
      const env2 = mkScenarioEnv("24fa2");
      try {
        await seedCrashedRun(env2, runId, {
          scriptSource: THREE_CALL_SERIAL_SCRIPT,
          args: historical,
          settled: [{ agent: "A" }, { agent: "B" }],
          inflight: [{ agent: "C" }],
        });
        const sd2 = makeScenarioDeps(env2, makeFauxRunner());
        const err = await actionResume(
          { action: "resume", runId, args: { payload: "z".repeat(400) } } as Parameters<typeof actionResume>[0],
          makeShellDeps(sd2),
        ).catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain("payload");
        expect(err.message).toContain("differ from the original run");
      } finally {
        env2.cleanup();
      }
    } finally {
      env.cleanup();
    }
  });

  it("旧格式帧回落：argsSummary 截断形态（无 args 全文）传 args → 保守拒绝 + 恢复指引；省略 args → resume 正常续跑", async () => {
    const runId = "wf-s24-trunc";
    const env = mkScenarioEnv("24tr");
    try {
      // 旧格式流（args 全文载荷落地前落盘）：run-created 帧只带截断摘要（slice 256
      // + 「…」尾标——截断边界常量 = terminal-actions.ts RUN_ARGS_SUMMARY_MAX_CHARS，
      // 模块私有，此处按生产形态字面构造；检测面 = readHistoricalArgs 的「…」尾标
      // 判定，仅旧格式帧到达）
      const longPayload = "y".repeat(400);
      const serialized = JSON.stringify({ payload: longPayload, _runId: runId });
      expect(serialized.length).toBeGreaterThan(256);
      const truncatedSummary = `${serialized.slice(0, 256)}…`;
      await seedCrashedRun(env, runId, {
        scriptSource: THREE_CALL_SERIAL_SCRIPT,
        argsSummary: truncatedSummary,
        settled: [{ agent: "A" }, { agent: "B" }],
        inflight: [{ agent: "C" }],
      });

      // 传入 args（哪怕与截断前缀一致）→ 保守拒绝：截断摘要无法逐字段比对
      const sd = makeScenarioDeps(env, makeFauxRunner());
      const err = await actionResume(
        { action: "resume", runId, args: { payload: longPayload } } as Parameters<typeof actionResume>[0],
        makeShellDeps(sd),
      ).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("truncated summary");
      expect(err.message).toContain("legacy record stream without the full-args payload");
      expect(err.message).toContain("$ARGS will be empty");
      await expectRejectionLeftNoTrace(sd, env, runId);

      // 恢复路径：省略 args → D14 跳过，resume 真链路正常续跑（截断摘要的
      // $ARGS 尽力恢复回落 {}，脚本不消费 $ARGS 不受影响）
      await actionResume(
        { action: "resume", runId } as Parameters<typeof actionResume>[0],
        makeShellDeps(sd),
      );
      const summary = await waitForScenarioSettled(sd.runs, runId);
      expect(summary.reason).toBe("completed");
      await waitForTerminalManifest(env, runId);
      expect(sd.faux.dispatches.map((d) => d.opts["agent"])).toEqual(["C"]);
    } finally {
      env.cleanup();
    }
  });
});
