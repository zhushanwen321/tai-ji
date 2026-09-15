// review-fix-loop.js workflow 脚本内纯函数直测（W2 移交 CRAP 240/110 最高项）。
//
// 测试方法（限制见文末 import 用例）：review-fix-loop.js 是 pi worker 模板脚本——
// 顶层执行 + 顶层 return，不可作为 ES module import（vite/esbuild 直接 SyntaxError）。
// 因此用 vm.Script 对源码文本做「函数段抽取求值」：从源文件按函数名定位 + brace
// 配平截取 normUsage / warnTelemetryMissingOnce / buildCallRecord 三段，在注入
// log/Buffer 的沙箱里求值后取回引用。抽取定位失败（函数改名/移动）会显式 throw，
// 不会静默测到旧副本。
//
// 回归锚点（对照修复史，断言在旧实现上会红）：
//   - W1：失败调用（returnMeta={value,error}）不得触发 telemetry-missing WARN
//         （旧实现不排除 error 分支，agent 失败被误诊为引擎透传未上线并烧掉 once 名额）
//   - A11：model 缺省回退 "(default)"（请求时参数语义）
//   - A12：promptMode=null（aggregator/fixer）必须保持 null，不被 || 误转 "full"
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKFLOW_SOURCE = readFileSync(
  join(__dirname, "..", "..", "workflows", "review-fix-loop.js"),
  "utf8",
);

/** 按函数名从源码文本截取完整函数段（参数括号配平后 brace 配平函数体）。
 *  抽取不到 → 显式报错（防漂移）。buildCallRecord 的解构参数含花括号，
 *  函数体起点必须从参数列表闭合括号之后找，不能直接 indexOf("{")。 */
function extractFn(name: string): string {
  const marker = "function " + name + "(";
  const start = WORKFLOW_SOURCE.indexOf(marker);
  if (start < 0) {
    throw new Error("extraction guard failed: " + marker + " not found — function renamed/moved?");
  }
  // 参数列表括号配平（解构参数内嵌的 () {} 不影响外层括号深度）
  const paramOpen = start + marker.length - 1;
  let parenDepth = 0;
  let paramClose = -1;
  for (let i = paramOpen; i < WORKFLOW_SOURCE.length; i++) {
    if (WORKFLOW_SOURCE[i] === "(") parenDepth++;
    else if (WORKFLOW_SOURCE[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) { paramClose = i; break; }
    }
  }
  if (paramClose < 0) throw new Error("extraction guard failed: unbalanced params for " + name);
  // 函数体 brace 配平
  const open = WORKFLOW_SOURCE.indexOf("{", paramClose);
  let depth = 0;
  for (let i = open; i < WORKFLOW_SOURCE.length; i++) {
    if (WORKFLOW_SOURCE[i] === "{") depth++;
    else if (WORKFLOW_SOURCE[i] === "}") {
      depth--;
      if (depth === 0) return WORKFLOW_SOURCE.slice(start, i + 1);
    }
  }
  throw new Error("extraction guard failed: unbalanced braces for " + name);
}

interface NormUsage {
  input: number; output: number;
  cacheRead: number; cacheWrite: number; cost: number;
}

interface CallRecord {
  batch: number; round: number; role: string; name: string;
  model: string;
  durationMs: number | null;
  usage: NormUsage | undefined;
  promptMode: string | null;
  promptBytes: number;
  sessionId: string | undefined;
}

interface ScriptFns {
  normUsage: (meta: unknown) => NormUsage | undefined;
  buildCallRecord: (args: {
    batch: number; round: number; role: string; name?: string;
    model?: string; prompt: unknown; promptMode?: string | null;
    meta?: unknown;
  }) => CallRecord;
  /** 重置 once-WARN 名额（模块级 warnedTelemetryMissing 是闭包状态，逐用例归零） */
  resetWarnFlag: () => void;
}

/** 求值抽取段：注入 log（数组记录）与 Buffer（buildCallRecord 的 promptBytes 依赖）。 */
function loadScriptFns(logs: string[]): ScriptFns {
  const src = [
    "let warnedTelemetryMissing = false;",
    extractFn("normUsage"),
    extractFn("warnTelemetryMissingOnce"),
    extractFn("buildCallRecord"),
    "({ normUsage, buildCallRecord, resetWarnFlag: () => { warnedTelemetryMissing = false; } })",
  ].join("\n");
  const sandbox: vm.Context = {
    Buffer,
    log: (msg: string) => { logs.push(String(msg)); },
  };
  return vm.runInNewContext(src, sandbox) as ScriptFns;
}

const FULL_USAGE: NormUsage = { input: 1200, output: 340, cacheRead: 5600, cacheWrite: 800, cost: 0.042 };

describe("review-fix-loop.js normUsage（usage 归一）", () => {
  it("meta 缺失/非对象 → undefined", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage(undefined)).toBeUndefined();
    expect(normUsage(null)).toBeUndefined();
    expect(normUsage("string")).toBeUndefined();
    expect(normUsage(42)).toBeUndefined();
  });

  it("meta.usage 缺失/非对象 → undefined（旧引擎无 usage 键）", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({})).toBeUndefined();
    expect(normUsage({ durationMs: 100 })).toBeUndefined();
    expect(normUsage({ usage: null })).toBeUndefined();
    expect(normUsage({ usage: "1200" })).toBeUndefined();
  });

  it("usage 空对象（字段全缺）→ 五分量全部补 0，不产生 undefined 字段", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({ usage: {} })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("usage 分量缺失 → 缺省分量 0，给定分量原值（部分维度）", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({ usage: { input: 500, output: 20 } })).toEqual({
      input: 500, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0,
    });
  });

  it("usage 分量为 null → ?? 0 兜底（null 维度不计 NaN）", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({ usage: { input: null, output: 10, cacheRead: null, cacheWrite: null, cost: null } })).toEqual({
      input: 0, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0,
    });
  });

  it("usage 完整 → 五分量精确透传", () => {
    const { normUsage } = loadScriptFns([]);
    expect(normUsage({ usage: { ...FULL_USAGE } })).toEqual(FULL_USAGE);
  });
});

describe("review-fix-loop.js buildCallRecord（calls[] 十字段条目）", () => {
  it("完整 returnMeta → 十字段精确形状（promptBytes 按 utf8 字节计）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    const rec = buildCallRecord({
      batch: 2, round: 3, role: "reviewer", name: "code-reviewer",
      model: "x/y", prompt: "审查 a√", promptMode: "scoped",
      meta: { durationMs: 12345, usage: { ...FULL_USAGE }, sessionId: "sess-1" },
    });
    // "审查 a√" = 审(3B)+查(3B)+空格(1B)+a(1B)+√(3B) = 11 字节（utf8 多字节验证）
    expect(rec).toEqual({
      batch: 2, round: 3, role: "reviewer", name: "code-reviewer",
      model: "x/y", durationMs: 12345, usage: FULL_USAGE,
      promptMode: "scoped", promptBytes: 11, sessionId: "sess-1",
    });
  });

  it("多批多角色连续构造 → 各条目独立（批/角色/usage 互不污染）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    const r1 = buildCallRecord({
      batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
      prompt: "p1", meta: { durationMs: 1, usage: { input: 10 }, sessionId: "s1" },
    });
    const r2 = buildCallRecord({
      batch: 2, round: 1, role: "aggregator", model: "m2",
      prompt: "p2", promptMode: null, meta: { durationMs: 2, usage: { input: 20 } },
    });
    expect(r1.batch).toBe(1);
    expect(r1.usage?.input).toBe(10);
    expect(r2.batch).toBe(2);
    expect(r2.usage?.input).toBe(20);
    expect(r1.promptMode).toBe("full"); // 缺省回退（reviewer 全量模式）
  });

  it("W1 回归：失败调用（returnMeta={value,error}）不触发 telemetry-missing WARN", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    const rec = buildCallRecord({
      batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
      prompt: "p", meta: { value: "", error: "agent timeout" },
    });
    // 旧实现不排除 error 分支：失败调用被误诊「透传未上线」并 WARN（本断言会红）
    expect(logs).toEqual([]);
    // 失败调用天然无 usage/durationMs——降级形态如实记录
    expect(rec.usage).toBeUndefined();
    expect(rec.durationMs).toBeNull();
  });

  it("W1 之后真正缺 usage 的成功调用仍能 WARN（once 名额未被失败调用烧掉）", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    buildCallRecord({
      batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
      prompt: "p", meta: { value: "ok", error: "agent timeout" },
    });
    buildCallRecord({
      batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
      prompt: "p", meta: { durationMs: 5 }, // returnMeta 在但 usage 缺失
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("returnMeta usage/durationMs missing");
  });

  it("A10 回归：多次降级调用只 WARN 一次（不逐调用刷屏）", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    for (let i = 0; i < 3; i++) {
      buildCallRecord({
        batch: 1, round: 1, role: "reviewer", name: "a", model: "m",
        prompt: "p", meta: { durationMs: 5 }, // usage 缺失
      });
    }
    expect(logs).toHaveLength(1);
  });

  it("A11 回归：model 空/缺省 → \"(default)\"（请求时参数语义，非实际运行模型）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    const rec = buildCallRecord({
      batch: 1, round: 1, role: "fixer", model: undefined, prompt: "p",
      meta: { durationMs: 1 },
    });
    expect(rec.model).toBe("(default)");
    expect(buildCallRecord({ batch: 1, round: 1, role: "fixer", model: "", prompt: "p", meta: {} }).model).toBe("(default)");
  });

  it("A12 回归：promptMode=null（aggregator/fixer）保持 null，不被误转 \"full\"", () => {
    const { buildCallRecord } = loadScriptFns([]);
    // 旧实现 `promptMode || \"full\"` 会把 null 转成 "full"（本断言会红）
    expect(buildCallRecord({ batch: 1, round: 1, role: "aggregator", prompt: "p", promptMode: null, meta: {} }).promptMode).toBeNull();
  });

  it("A12 边界：promptMode 空串保持空串（空串 ≠ 缺省，不回退 full）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    expect(buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", promptMode: "", meta: {} }).promptMode).toBe("");
  });

  it("promptMode 缺省（undefined）→ \"full\"（reviewer 默认全量模式）", () => {
    const { buildCallRecord } = loadScriptFns([]);
    expect(buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", meta: {} }).promptMode).toBe("full");
  });

  it("name 缺省/空 → role 兜底", () => {
    const { buildCallRecord } = loadScriptFns([]);
    expect(buildCallRecord({ batch: 1, round: 1, role: "fixer", name: undefined, prompt: "p", meta: {} }).name).toBe("fixer");
    expect(buildCallRecord({ batch: 1, round: 1, role: "fixer", name: "", prompt: "p", meta: {} }).name).toBe("fixer");
  });

  it("durationMs 非数（字符串/null）→ 条目记 null + WARN", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    expect(buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", meta: { durationMs: "1200", usage: {} } }).durationMs).toBeNull();
    expect(buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", meta: { durationMs: null, usage: {} } }).durationMs).toBeNull();
    expect(logs).toHaveLength(1);
  });

  it("meta 缺失（旧引擎无 returnMeta）→ 降级条目且不触发 WARN（判定前提是 metaObj 存在）", () => {
    const logs: string[] = [];
    const { buildCallRecord } = loadScriptFns(logs);
    const rec = buildCallRecord({ batch: 1, round: 1, role: "reviewer", prompt: "p", meta: undefined });
    expect(rec.durationMs).toBeNull();
    expect(rec.usage).toBeUndefined();
    expect(rec.sessionId).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("prompt 非字符串 → promptBytes 0；sessionId 非字符串 → undefined", () => {
    const { buildCallRecord } = loadScriptFns([]);
    const rec = buildCallRecord({
      batch: 1, round: 1, role: "reviewer", prompt: undefined,
      meta: { durationMs: 1, sessionId: 12345 },
    });
    expect(rec.promptBytes).toBe(0);
    expect(rec.sessionId).toBeUndefined();
  });
});

describe("review-fix-loop.js 模块形态约束", () => {
  it("顶层 return 使其不可作为 ES module import（pi worker 脚本，非可导入模块）", async () => {
    // 本 import 语句同时是静态依赖边：让依赖分析把该 workflow 文件纳入测试可达域
    // （CRAP 覆盖估算）。顶层 return / require 决定了 import 必然 reject——这是
    // workflow 脚本的固有形态，抽取测试法（本文件）因此是唯一可行的直测途径。
    // `as string` 使 import() 参数脱离字面量模块解析（该文件顶层 return，非合法模块，
// 本就无类型可锚）；esbuild 转译剥除断言后运行时与字面量形态完全一致
    await expect(import("../../workflows/review-fix-loop.js" as string)).rejects.toThrow();
  });
});

// ── RX2-F2：fixAgent=fallow-scan 显式拒收（脚本顶层参数校验，非函数段） ──
// 拒收逻辑位于脚本顶层（FIX_AGENT_RAW 解析后、resolveAgentDefs 前），函数段抽取法
// 覆盖不到；改用 review-fix-loop-scriptpath-failfast.test.ts 同款「AsyncFunction 包装
// + node -e 真实子进程」探针跑整脚本顶层副本。拒收点在 RUN_ROOT 落盘 / lockReviewBase
// 之前，探针无文件系统副作用、恒非零退出。
describe("review-fix-loop.js fixAgent=fallow-scan 显式拒收（RX2-F2）", () => {
  const run = promisify(execFile);

  /** execFile reject 侧的最小形状（Node ExecException 子集）。 */
  interface ExecFailure extends Error {
    code?: number | string;
    stderr?: string;
  }

  function isExecFailure(e: unknown): e is ExecFailure {
    return e instanceof Error;
  }

  let sandboxDir = "";

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "rfl-fixagent-guard-"));
    const workflowsDir = join(__dirname, "..", "..", "workflows");
    // 副本以 .cjs 落 sandbox（require 解析形态对齐 worker 宿主）；utils 锚定加载经
    // workerData.scriptPath（副本同目录），白名单校验前即需要它
    copyFileSync(join(workflowsDir, "review-fix-loop.js"), join(sandboxDir, "review-fix-loop.cjs"));
    copyFileSync(join(workflowsDir, "review-fix-loop-utils.cjs"), join(sandboxDir, "review-fix-loop-utils.cjs"));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** -e 探针体：AsyncFunction 复刻 worker 模板宿主形态（workerData/$ARGS/log 注入）。 */
  function probeCode(argsJson: string): string {
    const copyPath = join(sandboxDir, "review-fix-loop.cjs");
    return [
      "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
      "const src = require('fs').readFileSync(" + JSON.stringify(copyPath) + ", 'utf8');",
      "const runner = new AsyncFunction('workerData', '$ARGS', 'require', 'log', src + '\\n');",
      "const workerData = { scriptPath: " + JSON.stringify(join(sandboxDir, "review-fix-loop.cjs")) + " };",
      "const $ARGS = " + argsJson + ";",
      // $MODEL 是 worker 模板全局（主模型注入）——对照用例会推进到 fixAgent 解析之后
      // 的 MODEL = $MODEL 行（:204），缺席会 ReferenceError 而非到达批次校验
      "const $MODEL = 'probe-model';",
      "runner(workerData, $ARGS, require, function () {}).catch(function (e) {",
      "  require('fs').writeSync(2, String((e && e.message) || e) + '\\n');",
      "  process.exit(1);",
      "});",
    ].join("\n");
  }

  async function runProbeExpectFailure(argsJson: string): Promise<string> {
    const outcome = await run(process.execPath, ["-e", probeCode(argsJson)], {
      cwd: sandboxDir,
      timeout: 30_000,
    }).then(
      (): ExecFailure | null => null,
      (e: unknown): ExecFailure | null => (isExecFailure(e) ? e : null),
    );
    if (outcome === null) {
      throw new Error("expected non-zero exit, but node exited 0 with args: " + argsJson);
    }
    return String(outcome.stderr ?? "");
  }

  it("fixAgent=fallow-scan → 非零退出 + 保留字错误 + fallowScan=true 恢复指引", async () => {
    const stderr = await runProbeExpectFailure(
      '{ targetType: "file", target: "probe", fixAgent: "fallow-scan" }',
    );
    expect(stderr).toContain("内部保留字");
    expect(stderr).toContain("fallowScan=true");
    // 旧实现静默映射 FALLOW_DEF（fix 派发退化为通用 subagent）——不会到达此处报错
  });

  it("对照：合法形态 fixAgent（.md 路径）不触发保留字拒收（后续批次校验照常 fail）", async () => {
    const stderr = await runProbeExpectFailure(
      '{ targetType: "file", target: "probe", fixAgent: "/tmp/rx2-f2-fake-agent.md" }',
    );
    // 推进到批次解析才失败（缺批次参数）——证明拒收只对字面值 fallow-scan 触发
    expect(stderr).toContain("缺少批次参数");
    expect(stderr).not.toContain("内部保留字");
  });
});
