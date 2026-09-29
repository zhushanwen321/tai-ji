// src/__tests__/record-mode/template-resume.test.ts
//
// 场景 A2/A4（scriptPath 锚定恢复——设计 .tmp/tech-design/workflow-resume-scriptpath-recovery.md
// §4 验收表）：内置模板脚本（fan-out 真文件）的 resume 真链路。
//
// 回归面 = a1a4 真机终判 BLOCKED 的缺陷①：修复前 resume 重建 spec.scriptPath 恒空串，
// worker 加载 fan-out 即炸 Cannot find module './_shared/agent-refs.cjs'（cwd 相对解析）；
// 修复后 run-created 帧携带 scriptPath → 锚定恢复 → 续跑成功（A2）。A4 = 旧格式帧
//（无 scriptPath 载荷）回落现状失败形态——守卫收紧后带恢复指引的 fail-fast。
//
// 夹具协议与 scenario-kit 同源：真 resumeRun + 真 WorkerHostImpl（node:worker_threads
// 真线程跑 fan-out.js，require _shared 经 scriptPath 锚定到包内真实目录），唯一替身 =
// faux runner（LLM 层替身）。fan-out 派发序 = tasks 数组序（map 同步构造 + parallel
// 按序发 agent-call），taskIndex 与 seed 对齐。
import fs from "node:fs";
import path from "node:path";

import { WorkflowScriptRegistryImpl } from "@zhushanwen/subagent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  makeFauxRunner,
  makeScenarioDeps,
  mkScenarioEnv,
  resumeScenarioRun,
  seedCrashedRun,
  waitForScenarioSettled,
  type ScenarioEnv,
} from "./scenario-kit.ts";

/**
 * 包内 fan-out 模板真文件（worker require _shared 的锚定目标）。定位用向上查找
 *（locateTsx 同款形态）——vitest 的 vite resolver 不解析跨包包根（createRequire
 * resolve 受 package exports 限制）。
 */
function locateFanOut(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (;;) {
    const candidate = path.join(dir, "packages", "subagent-core", "workflows", "fan-out.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("fan-out.js not found in any ancestor of " + dir);
    dir = parent;
  }
}

const FAN_OUT_ABS = locateFanOut();

/** fan-out 可执行源（registry 解析链——与生产 buildRunSpecFromScript 的 toExecutable 同源）。 */
async function fanOutExecutableSource(): Promise<string> {
  const script = await new WorkflowScriptRegistryImpl().getPath(FAN_OUT_ABS);
  expect(script, `registry should resolve ${FAN_OUT_ABS}`).toBeDefined();
  return script!.toExecutable();
}

const FAN_OUT_ARGS = { tasks: ["alpha job", "beta job"] };

describe("场景 A2/A4：内置模板 resume（scriptPath 锚定恢复）", () => {
  let env: ScenarioEnv;
  /** fan-out 可执行源缓存（registry 解析 + lint 只跑一次，两用例共用）。 */
  let fanOutSource: string;
  beforeAll(async () => {
    env = mkScenarioEnv("template-resume");
    fanOutSource = await fanOutExecutableSource();
  }, 30_000);
  afterAll(() => env.cleanup());

  it("A2 fan-out 中断续跑：锚定恢复 → worker 真跑 fan-out.js（require _shared 成功）→ 回放零重派 + 在途重派 + 终态 done", async () => {
    const RUN = "wf-tpl-a2";
    await seedCrashedRun(env, RUN, {
      scriptSource: fanOutSource,
      workflowName: "fan-out",
      scriptPath: FAN_OUT_ABS,
      args: FAN_OUT_ARGS,
      settled: [{ agent: "fan-out-0" }], // taskIndex 0 已完成（resume 回放面）
      inflight: [{ agent: "fan-out-1" }], // taskIndex 1 在途（重派面）
    });

    const sd = makeScenarioDeps(env, makeFauxRunner());
    const resumed = await resumeScenarioRun(env, sd, RUN);

    expect(resumed).toBe(RUN);
    // 锚定从 run-created 帧逐字恢复（修复核心断言——修复前恒 ""）
    expect(sd.runs.get(RUN)!.spec.scriptPath).toBe(FAN_OUT_ABS);
    const outcome = await waitForScenarioSettled(sd.runs, RUN);
    // 修复前此处 failed（Cannot find module './_shared/agent-refs.cjs'）
    expect(outcome.status).toBe("done");
    // 零重派断言：taskIndex 0 缓存回话（不进 dispatches），仅 taskIndex 1 真实派发
    expect(sd.faux.dispatches).toHaveLength(1);
  }, 30_000);

  it("A4 旧格式帧（无 scriptPath 载荷）：fan-out resume 失败 = 收紧后 core_module_load_failed + 恢复指引，未到派发", async () => {
    const RUN = "wf-tpl-a4";
    await seedCrashedRun(env, RUN, {
      scriptSource: fanOutSource,
      workflowName: "fan-out",
      // scriptPath 缺省 = 旧格式帧（scriptPath 载荷落地前的形态）
      args: FAN_OUT_ARGS,
      settled: [{ agent: "fan-out-0" }],
      inflight: [{ agent: "fan-out-1" }],
    });

    const sd = makeScenarioDeps(env, makeFauxRunner());
    await resumeScenarioRun(env, sd, RUN);

    const outcome = await waitForScenarioSettled(sd.runs, RUN);
    // runSummary 投影：status = lifecycle 终局（done），reason = 结果（failed）
    expect(outcome.status).toBe("done");
    expect(outcome.reason).toBe("failed");
    // 收紧后的失败形态：带 core_module_load_failed 前缀（修复前为无前缀的
    // Node 原生 Cannot find module）+ 空串形态专属恢复指引（含 resume 字样）
    expect(outcome.error).toContain("core_module_load_failed");
    expect(outcome.error).toContain("resume");
    // 加载即失败（require _shared 前），未到任何成员派发
    expect(sd.faux.dispatches).toHaveLength(0);
  }, 30_000);
});
