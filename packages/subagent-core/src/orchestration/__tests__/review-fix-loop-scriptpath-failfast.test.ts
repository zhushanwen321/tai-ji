// 内置 workflow 脚本 scriptPath 锚定 fail-fast（机制行为自包含见下文验证目标）。
//
// 验证目标：worker 依赖加载从「cwd 静默回退」收紧为 fail-fast——scriptPath 缺席/
// 空串/非字符串时必须报 core_module_load_failed，且不发起对依赖文件
// （review-fix-loop.js → review-fix-loop-utils.cjs；chain/parallel/map-reduce/
// scatter-gather → _shared/agent-refs.cjs）的任何 require，消除从 cwd 误加载/
// 被植入同名文件的代码加载路径。
//
// 驱动方式：AsyncFunction 包装 + require/log 注入，进程内求值真实脚本源码
// （单测层极端测试整治第二波收敛：依赖加载 fail-fast 是纯逻辑判定，用注入
// 加载器即可确定性断言，不背 node 子进程冷启动成本，判据见
// docs/todo/test-single-layer-cleanup.md「判据类型 / 处置通道」）。五个脚本均含
// 顶层 await（agent/parallel 入口）与顶层 return，是 worker 模板宿主形态——纯文件
// 加载（.js ESM / .cjs CJS）在解析期即 SyntaxError，检查无从执行；以
// AsyncFunction 构造器复刻 worker 模板的「async 函数包装 + require 注入」宿主
// 形态（与 worker-script-builder 的 async IIFE 包裹同构，宿主名清单见
// orchestration/script-syntax.ts）。require 注入为「记录 + 代理」加载器：
//   - 负向断言「无路径形态 require」= 依赖文件从未被请求——比 cwd 植入标记
//     探针的「植入文件未执行」更强：连加载尝试都不存在，安全属性（无 cwd
//     回退代码加载路径）直接成立；
//   - 正向断言「require 实参 = scriptPath 派生的锚定绝对路径」= 锚定语义直证
//     ——比「依赖加载后的启动日志已打出」的间接证据更强。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOWS_DIR = join(__dirname, "..", "..", "..", "workflows");

/** 五个内置脚本（stem → 源文件名），直接读真实源文件求值。 */
const SCRIPT_STEMS = ["review-fix-loop", "chain", "parallel", "map-reduce", "scatter-gather"] as const;

/** 各脚本到达依赖加载检查所需的最小合法 $ARGS（编排四件的必需参数校验先于检查——
 *  真实触发场景即「args 合法 + scriptPath 缺失」，与 worker 宿主总是成对注入的契约一致）。 */
const MIN_VALID_ARGS: Record<string, Record<string, unknown>> = {
  "review-fix-loop": { targetType: "file", target: "probe" },
  chain: { task: "probe" },
  parallel: { target: "probe" },
  "map-reduce": { operation: "probe", items: ["a"] },
  "scatter-gather": { task: "probe" },
  // fan-out tasks 为成员对象形态（对象-only 契约，u-fanout-template）
  "fan-out": { tasks: [{ task: "probe" }] },
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** 一次脚本求值的观测面：抛错 / require 实参序列 / log 输出序列。 */
interface ScriptEvalOutcome {
  error: Error | undefined;
  requireCalls: readonly string[];
  logs: readonly string[];
}

/** 以 worker 模板宿主形态进程内求值一个内置脚本：注入 workerData/$ARGS/
 *  require（记录 + 代理到 workflows 目录锚定的 createRequire）/ log（记录）。 */
async function evalScriptInWorkerShape(
  stem: string,
  workerData: unknown,
  args: unknown,
): Promise<ScriptEvalOutcome> {
  const src = readFileSync(join(WORKFLOWS_DIR, `${stem}.js`), "utf8");
  const requireCalls: string[] = [];
  const logs: string[] = [];
  const baseRequire = createRequire(join(WORKFLOWS_DIR, "probe.cjs"));
  const requireProbe = (id: string): unknown => {
    requireCalls.push(id);
    return baseRequire(id);
  };
  const log = (...msgs: unknown[]): void => {
    logs.push(msgs.map((m) => String(m)).join(" "));
  };
  const runner = new AsyncFunction("workerData", "$ARGS", "require", "log", `${src}\n`) as (
    workerData: unknown,
    args: unknown,
    require: (id: string) => unknown,
    log: (...msgs: unknown[]) => void,
  ) => Promise<unknown>;
  let error: Error | undefined;
  try {
    await runner(workerData, args, requireProbe, log);
  } catch (e: unknown) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  return { error, requireCalls, logs };
}

/** 依赖文件 require 判定：路径形态 id（绝对/相对）。Node 内建 id（fs/path 等）
 *  是裸名，不属于依赖文件加载意图。 */
function dependencyRequireCalls(calls: readonly string[]): string[] {
  return calls.filter((id) => id.startsWith("/") || id.startsWith("./") || id.startsWith("../"));
}

/** 负向探针公共断言：fail-fast 报错 + 依赖文件零请求（cwd 植入依赖不可能被加载
 *  ——请求都不存在，安全属性本体）。 */
function expectFailFast(outcome: ScriptEvalOutcome): Error {
  expect(outcome.error).toBeInstanceOf(Error);
  expect(outcome.error?.message).toContain("core_module_load_failed");
  expect(dependencyRequireCalls(outcome.requireCalls)).toEqual([]);
  return outcome.error as Error;
}

describe("内置 workflow 脚本 scriptPath 锚定 fail-fast", () => {
  it.each(SCRIPT_STEMS.map((stem) => [stem]))(
    "%s：scriptPath 缺席 → fail-fast 报 core_module_load_failed，依赖文件零请求",
    async (stem) => {
      const outcome = await evalScriptInWorkerShape(stem, undefined, MIN_VALID_ARGS[stem]);
      const error = expectFailFast(outcome);

      // 恢复动作可操作：指明注入义务（workerData.scriptPath / WorkerHost）
      expect(error.message).toContain("workerData");
      expect(error.message).toContain("WorkerHost");
    },
  );

  it.each([
    ["workerData 为空对象", {}],
    ["scriptPath 非字符串", { scriptPath: 123 }],
  ])("review-fix-loop：%s → fail-fast 报 core_module_load_failed", async (_label, workerData) => {
    const outcome = await evalScriptInWorkerShape("review-fix-loop", workerData, {});
    expectFailFast(outcome);
  });

  // 空串形态 = resume 从旧 record 流（scriptPath 载荷落地前）重建的 spec——与缺席
  // 同拦（D5 收紧），文案区分两种形态：空串指明「旧 run 重跑」而非「注入义务」。
  // fan-out 不在 SCRIPT_STEMS（原覆盖五件），此处单独枚举补齐六件。
  it.each([...SCRIPT_STEMS, "fan-out"].map((stem) => [stem] as const))(
    "%s：scriptPath 为空串（旧 record 流形态）→ fail-fast + 空串专属恢复指引，依赖文件零请求",
    async (stem) => {
      const outcome = await evalScriptInWorkerShape(stem, { scriptPath: "" }, MIN_VALID_ARGS[stem]);
      const error = expectFailFast(outcome);

      // 空串形态专属恢复指引：旧 run 重跑（中英文文案均含 resume 字样）
      expect(error.message).toContain("resume");
      // 文案区分的证据：不再指向注入义务（WorkerHost 是缺席形态的指引）
      expect(error.message).not.toContain("WorkerHost");
    },
  );

  it("正向探针（review-fix-loop）：scriptPath 注入后 utils 锚定加载（require 实参 = scriptPath 派生路径；白名单校验执行 = VALID_ARG_KEYS 已解构）", async () => {
    const outcome = await evalScriptInWorkerShape("review-fix-loop", { scriptPath: join(WORKFLOWS_DIR, "review-fix-loop.js") }, { definitelyNotAValidKey: true });

    // 锚定直证：依赖 require 的实参恰为 scriptPath 派生的绝对路径（非 cwd 相对形态）
    expect(outcome.requireCalls).toContain(join(WORKFLOWS_DIR, "review-fix-loop-utils.cjs"));
    // utils 加载成功的证据：白名单校验执行并拒绝伪造键（fail 协议消息），而非模块加载失败
    expect(outcome.error?.message).toContain("未知参数: definitelyNotAValidKey");
    expect(outcome.error?.message).not.toContain("core_module_load_failed");
  });

  it("正向探针（chain）：scriptPath 注入后 _shared/agent-refs.cjs 锚定加载（require 实参 = scriptPath 派生路径；依赖加载后的编排启动日志已打出）", async () => {
    const outcome = await evalScriptInWorkerShape("chain", { scriptPath: join(WORKFLOWS_DIR, "chain.js") }, { task: "probe" });

    // 锚定直证：依赖 require 的实参恰为 scriptPath 派生的 _shared 绝对路径
    expect(outcome.requireCalls).toContain(join(WORKFLOWS_DIR, "_shared", "agent-refs.cjs"));
    // 依赖加载成功的证据：chain.js 的检查与 require 位于 try 之外（require 失败 →
    // reject + core_module_load_failed），其后的启动日志「chain 开始」能打进 log
    // 即证明 agent-refs.cjs 已锚定加载且执行推进到编排段（后续 phase/agent 等模板
    // 全网未注入的 ReferenceError 被脚本自身 try/catch 吸收，求值正常返回）
    expect(outcome.logs.join("\n")).toContain("chain 开始");
    expect(outcome.error).toBeUndefined();
  });
});
