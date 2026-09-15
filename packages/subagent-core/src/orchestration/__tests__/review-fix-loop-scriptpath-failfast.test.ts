// 内置 workflow 脚本 scriptPath 锚定 fail-fast（u0-failfast / D1 附带加固，计划偏差 #6 扩展）。
//
// 验证目标：worker 依赖加载从「cwd 静默回退」收紧为 fail-fast——scriptPath 缺席时
// 必须报 core_module_load_failed 且不加载用户目录下的同名依赖文件
// （review-fix-loop.js → review-fix-loop-utils.cjs；chain/parallel/map-reduce/
// scatter-gather → _shared/agent-refs.cjs），消除从 cwd 误加载/被植入同名文件的代码加载面。
//
// 驱动方式：node:child_process spawn node -e 探针 + AsyncFunction 包装。五个脚本均含
// 顶层 await（agent/parallel 入口）与顶层 return，是 worker 模板宿主形态——纯文件加载
// （.js ESM / .cjs CJS）在解析期即 SyntaxError，守卫无从执行（review-fix-loop-script.test.ts
// 头注释同样记录了该形态约束）。探针以 AsyncFunction 构造器复刻 worker 模板的「async
// 函数包装 + require 注入」宿主形态后求值真实源码副本，仍是真实子进程 + 真实退出码。
// 负向探针在 cwd 预置植入版依赖（require 即抛标记错误），断言标记未出现——直接验证
// 安全属性本体；正向探针以「require 之后的确定性行为」作为依赖加载成功的证据
// （review-fix-loop 白名单校验执行 = VALID_ARG_KEYS 已解构；chain 推进到编排段
// 首个模板全局 log = _shared/agent-refs.cjs 已 require）。
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKFLOWS_DIR = join(__dirname, "..", "..", "..", "workflows");

/** 五个内置脚本（stem → 源文件名），副本统一以 .cjs 落 sandbox。 */
const SCRIPT_STEMS = ["review-fix-loop", "chain", "parallel", "map-reduce", "scatter-gather"] as const;

/** 各脚本到达依赖加载守卫所需的最小合法 $ARGS（编排四件的必需参数校验先于守卫——
 *  真实触发场景即「args 合法 + scriptPath 缺失」，与 worker 宿主总是成对注入的契约一致）。 */
const MIN_VALID_ARGS: Record<(typeof SCRIPT_STEMS)[number], string> = {
  "review-fix-loop": '{ targetType: "file", target: "probe" }',
  chain: '{ task: "probe" }',
  parallel: '{ target: "probe" }',
  "map-reduce": '{ operation: "probe", items: ["a"] }',
  "scatter-gather": '{ task: "probe" }',
};

/** 植入依赖的标记错误文本：出现即证明 cwd 回退加载仍然存在（fail-fast 被绕过）。 */
const PLANTED_MARKER = "PLANTED-CWD-UTILS-LOADED";

const run = promisify(execFile);

/** execFile reject 侧的最小形状（Node ExecException 子集，避免 any / 无守卫断言）。 */
interface ExecFailure extends Error {
  code?: number | string;
  stderr?: string;
}

function isExecFailure(e: unknown): e is ExecFailure {
  return e instanceof Error;
}

let sandboxDir = "";

beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), "rfl-scriptpath-failfast-"));
  for (const stem of SCRIPT_STEMS) {
    copyFileSync(join(WORKFLOWS_DIR, stem + ".js"), join(sandboxDir, stem + ".cjs"));
  }
  // _shared 布局对齐真实 workflows/（四编排脚本经 SCRIPT_DIR + "/_shared" 定位）
  mkdirSync(join(sandboxDir, "_shared"));
  copyFileSync(join(WORKFLOWS_DIR, "_shared", "agent-refs.cjs"), join(sandboxDir, "_shared", "agent-refs.cjs"));
  // review-fix-loop 的纯函数层依赖（正向探针的 scriptPath 锚定 require 对象）
  copyFileSync(join(WORKFLOWS_DIR, "review-fix-loop-utils.cjs"), join(sandboxDir, "review-fix-loop-utils.cjs"));
});

afterEach(() => {
  rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** cwd 植入件：若任一脚本回退 process.cwd() 加载依赖，本文件被 require 即抛标记错误。 */
function plantHostileUtils(dir: string): void {
  const payload = 'throw new Error("' + PLANTED_MARKER + '");\n';
  writeFileSync(join(dir, "review-fix-loop-utils.cjs"), payload, "utf8");
  writeFileSync(join(dir, "_shared", "agent-refs.cjs"), payload, "utf8");
}

/** 跑 node 子进程并要求非零退出，返回 stderr。意外零退出 → 显式红（探针失效不静默）。 */
async function runNodeExpectFailure(args: string[], cwd: string): Promise<string> {
  const outcome = await run(process.execPath, args, { cwd, timeout: 30_000 }).then(
    (): ExecFailure | null => null,
    (e: unknown): ExecFailure | null => (isExecFailure(e) ? e : null),
  );
  if (outcome === null) {
    throw new Error("expected non-zero exit, but node exited 0: " + args.join(" "));
  }
  return String(outcome.stderr ?? "");
}

/** 跑 node 子进程并要求零退出，返回 { stdout, stderr }。非零退出 → 显式红。 */
async function runNodeExpectSuccess(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const outcome = await run(process.execPath, args, { cwd, timeout: 30_000 }).then(
    (r: { stdout: string; stderr: string }) => r,
    (): null => null,
  );
  if (outcome === null) {
    throw new Error("expected zero exit, but node exited non-zero: " + args.join(" "));
  }
  return outcome;
}

/** -e 探针体：AsyncFunction 包装复刻 worker 模板宿主形态，注入 workerData/$ARGS/log
 *  后求值指定脚本副本。log 为模板全局（map-reduce 在守卫前有 log 调用，缺失会提前
 *  ReferenceError 而到不了守卫），实现为 writeSync(1) 记录到 stdout——编排脚本自身的
 *  try/catch 会吞掉后续缺失模板全局的 ReferenceError 并正常返回（exit 0），「依赖加载
 *  之后的启动日志已打出」因此构成依赖加载成功的确定性证据。 */
function probeCode(stem: string, workerDataJson: string, argsJson: string): string {
  const copyPath = join(sandboxDir, stem + ".cjs");
  return [
    "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
    "const src = require('fs').readFileSync(" + JSON.stringify(copyPath) + ", 'utf8');",
    "const runner = new AsyncFunction('workerData', '$ARGS', 'require', 'log', src + '\\n');",
    "const workerData = " + workerDataJson + ";",
    "const $ARGS = " + argsJson + ";",
    "runner(workerData, $ARGS, require, function (m) { require('fs').writeSync(1, String(m) + '\\n'); }).catch(function (e) {",
    "  require('fs').writeSync(2, String((e && e.message) || e) + '\\n');",
    "  process.exit(1);",
    "});",
  ].join("\n");
}

describe("内置 workflow 脚本 scriptPath 锚定 fail-fast（u0-failfast）", () => {
  it.each(SCRIPT_STEMS.map((stem) => [stem]))(
    "%s：scriptPath 缺席 → 非零退出 + core_module_load_failed，cwd 植入依赖不被加载",
    async (stem) => {
      plantHostileUtils(sandboxDir);
      const stderr = await runNodeExpectFailure(
        ["-e", probeCode(stem, "undefined", MIN_VALID_ARGS[stem])],
        sandboxDir,
      );

      expect(stderr).toContain("core_module_load_failed");
      // 恢复动作可操作：指明注入义务（workerData.scriptPath / WorkerHost）
      expect(stderr).toContain("workerData");
      expect(stderr).toContain("WorkerHost");
      // 安全属性本体：cwd 回退已消除，植入的同名依赖未被加载
      expect(stderr).not.toContain(PLANTED_MARKER);
    },
  );

  it.each([
    ["workerData 为空对象", "{}"],
    ["scriptPath 非字符串", "{ scriptPath: 123 }"],
  ])("review-fix-loop：%s → fail-fast 报 core_module_load_failed", async (_label, workerDataJson) => {
    plantHostileUtils(sandboxDir);
    const stderr = await runNodeExpectFailure(
      ["-e", probeCode("review-fix-loop", workerDataJson, "{}")],
      sandboxDir,
    );

    expect(stderr).toContain("core_module_load_failed");
    expect(stderr).not.toContain(PLANTED_MARKER);
  });

  it("正向探针（review-fix-loop）：scriptPath 注入后 utils 锚定加载成功（白名单校验执行 = VALID_ARG_KEYS 已解构）", async () => {
    const workerDataJson = "{ scriptPath: " + JSON.stringify(join(sandboxDir, "review-fix-loop.cjs")) + " }";
    const stderr = await runNodeExpectFailure(
      ["-e", probeCode("review-fix-loop", workerDataJson, "{ definitelyNotAValidKey: true }")],
      sandboxDir,
    );

    // utils 加载成功的证据：白名单校验执行并拒绝伪造键（fail 协议消息），而非模块加载失败
    expect(stderr).toContain("未知参数: definitelyNotAValidKey");
    expect(stderr).not.toContain("core_module_load_failed");
  });

  it("正向探针（chain）：scriptPath 注入后 _shared/agent-refs.cjs 锚定加载成功（依赖加载后的编排启动日志已打出）", async () => {
    const workerDataJson = "{ scriptPath: " + JSON.stringify(join(sandboxDir, "chain.cjs")) + " }";
    const { stdout, stderr } = await runNodeExpectSuccess(
      ["-e", probeCode("chain", workerDataJson, '{ task: "probe" }')],
      sandboxDir,
    );

    // 依赖加载成功的证据：chain.js 的守卫与 require 位于 try 之外（require 失败 →
    // 非零退出 + core_module_load_failed），其后的启动日志「chain 开始」能出现在
    // stdout 即证明 _shared/agent-refs.cjs 已锚定加载且执行推进到编排段
    expect(stdout).toContain("chain 开始");
    expect(stderr).not.toContain("core_module_load_failed");
    expect(stderr).not.toContain(PLANTED_MARKER);
  });
});
