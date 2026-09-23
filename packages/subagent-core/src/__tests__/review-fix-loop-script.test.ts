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
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ── B2：终态残留结构化清单（与 zcode 原生版 remaining 字段对齐） ──
// 口径 = status != fixed/deferred；同源一致性由「与 message 残留 ID 同源」约束保证。
describe("review-fix-loop.js buildRemaining（终态残留四字段清单）", () => {
  function loadBuildRemaining() {
    const src = [extractFn("buildRemaining"), "buildRemaining"].join("\n");
    return vm.runInNewContext(src, {}) as (issues: unknown) => { id: string; title: string; severity: string; status: string }[];
  }

  it("issues 为 undefined/空：返回空数组（不抛错——state.issues 初始即 undefined）", () => {
    const buildRemaining = loadBuildRemaining();
    expect(buildRemaining(undefined)).toEqual([]);
    expect(buildRemaining({})).toEqual([]);
  });

  it("残留口径：open/regressed 入选，fixed/deferred 被过滤（deferred 是显式挂起，不算残留）", () => {
    const buildRemaining = loadBuildRemaining();
    const out = buildRemaining({
      "MF-1-1": { title: "still broken", severity: "major", status: "open" },
      "MF-1-2": { title: "came back", severity: "critical", status: "regressed" },
      "MF-1-3": { title: "done", severity: "major", status: "fixed" },
      "MF-1-4": { title: "parked", severity: "minor", status: "deferred" },
    });
    expect(out.map((r) => r.id)).toEqual(["MF-1-1", "MF-1-2"]);
    expect(out.map((r) => r.status)).toEqual(["open", "regressed"]);
  });

  it("字段兜底：缺失 title → 空串；缺失 severity → 'unknown'（消费侧不做 undefined 分支）", () => {
    const buildRemaining = loadBuildRemaining();
    const out = buildRemaining({ "MF-2-1": { status: "open" } });
    expect(out).toEqual([{ id: "MF-2-1", title: "", severity: "unknown", status: "open" }]);
  });

  it("畸形条目（null/非对象）不崩溃、不入清单（state 脏数据不致终态渲染炸）", () => {
    const buildRemaining = loadBuildRemaining();
    const out = buildRemaining({ "MF-3-1": null, "MF-3-2": { status: "open", title: "ok", severity: "minor" } });
    expect(out.map((r) => r.id)).toEqual(["MF-3-2"]);
  });

  it("顶层 return 确实透出 remaining 字段（防字段从返回体被移除）+ 清单由 buildRemaining 派生", () => {
    const returnBlock = WORKFLOW_SOURCE.slice(WORKFLOW_SOURCE.lastIndexOf("return {"));
    // 字段透出：返回体必须含 remaining（且是 shorthand，值即 buildRemaining 调用结果）
    expect(returnBlock).toContain("remaining,");
    // 取值来源：声明行必须走 buildRemaining（改回内联对象字面量会被这条拦住）
    expect(WORKFLOW_SOURCE).toContain("const remaining = buildRemaining(state.issues);");
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

// ── MF-1-15：fixer 文件总线两段闭包补测（fixerDocPath 渲染 + groupCalls 派发组装）──
// 两段都是 fix 轮内 const 声明的闭包（非 `function name(` 形态），上方 extractFn
// 覆盖不到；改用 extractStatement 按「depth-0 `;`」语句边界截取——(g, k) 参数括号
// 会在语句中途回到 depth 0，不能按「首次回到 0」截断，字符串/注释内的括号分号
// 也必须跳过。渲染错位的后果是直接误导 fixer 派发（组号/条目/文档路径任一错位 =
// fixer 修错文件或读不到任务文档），因此逐字节锁定文档内容与组/条目的严格一致，
// 以及组 → 文档 → 调用的一一对应。
describe("review-fix-loop.js fixerDocPath + groupCalls（fixer 文件总线渲染与派发组装）", () => {
  /** 从 marker 起截取完整语句（跳过字符串/模板串/行注释/块注释，depth-0 `;` 收口）。 */
  function extractStatement(marker: string): string {
    const start = WORKFLOW_SOURCE.indexOf(marker);
    if (start < 0) {
      throw new Error("extraction guard failed: " + marker + " not found — statement renamed/moved?");
    }
    let quote: string | null = null;
    let depth = 0;
    for (let i = start; i < WORKFLOW_SOURCE.length; i++) {
      const c = WORKFLOW_SOURCE.charAt(i);
      const next = WORKFLOW_SOURCE.charAt(i + 1);
      if (quote !== null) {
        if (c === "\\") { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "/" && next === "/") {
        while (i < WORKFLOW_SOURCE.length && WORKFLOW_SOURCE.charAt(i) !== "\n") i++;
        continue;
      }
      if (c === "/" && next === "*") {
        i += 2;
        while (i < WORKFLOW_SOURCE.length
          && !(WORKFLOW_SOURCE.charAt(i) === "*" && WORKFLOW_SOURCE.charAt(i + 1) === "/")) i++;
        i++;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") { depth++; continue; }
      if (c === ")" || c === "]" || c === "}") { depth--; continue; }
      if (c === ";" && depth === 0) return WORKFLOW_SOURCE.slice(start, i + 1);
    }
    throw new Error("extraction guard failed: no depth-0 ';' for " + marker);
  }

  /** fixerDocPath 消费的条目形状（agg.must_fix_ids schema 数据的渲染相关字段）。 */
  interface FixerDocEntry {
    id: string;
    severity?: string;
    title?: string;
    files?: string[];
    evidence?: string;
    guidance?: string;
  }

  interface FixGroupLike {
    id: string;
    issueIds: string[];
    note?: string;
  }

  const ENTRY_FULL: FixerDocEntry = {
    id: "MF-1-15",
    severity: "minor",
    title: "workflow 文档渲染函数零测试",
    files: ["workflows/review-fix-loop.js", "src/__tests__/review-fix-loop-script.test.ts"],
    evidence: "grep fixerDocPath|groupCalls 在测试零命中",
    guidance: "沿用同脚本既有源码提取模式补用例",
  };

  let roundDir = "";
  beforeEach(() => {
    roundDir = mkdtempSync(join(tmpdir(), "rfl-fixer-doc-"));
  });
  afterEach(() => {
    rmSync(roundDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function loadFns(sandbox: Record<string, unknown>): {
    fixerDocPath: (g: FixGroupLike, k: number) => string;
    groupCalls: Array<Record<string, unknown>>;
  } {
    return vm.runInNewContext(
      [
        extractStatement("const fixerDocPath = "),
        extractStatement("const groupCalls = "),
        "({ fixerDocPath, groupCalls })",
      ].join("\n"),
      sandbox,
    ) as { fixerDocPath: (g: FixGroupLike, k: number) => string; groupCalls: Array<Record<string, unknown>> };
  }

  /** fixerDocPath 沙箱：真实 fs + 临时 roundDir（产物落盘后 readFileSync 回读断言）。
   *  groupCalls 语句与 fixerDocPath 一同求值（const 声明即执行 map）——文档渲染
   *  用例注入空组 + 哨兵 buildFixPrompt（误派发即红），不静默。 */
  function docSandbox(entries: readonly unknown[]): Record<string, unknown> {
    return {
      fs: { writeFileSync },
      roundDir,
      activeEntriesForFix: entries,
      fixGroups: [],
      buildFixPrompt: () => { throw new Error("buildFixPrompt must not run in doc-render cases"); },
    };
  }

  describe("fixerDocPath（fixer 任务文档渲染）", () => {
    it("路径格式 roundDir/aggregate-4-fixer-<k>.md + 内容与组/条目逐字节一致", () => {
      const { fixerDocPath } = loadFns(docSandbox([ENTRY_FULL]));
      const p = fixerDocPath({ id: "G8", issueIds: ["MF-1-15"], note: "单条独立：补测" }, 3);
      expect(p).toBe(roundDir + "/aggregate-4-fixer-3.md");
      expect(readFileSync(p, "utf-8")).toBe(
        [
          "# Fixer task G8 — 单条独立：补测",
          "",
          "Parallel fixing: other groups run concurrently on disjoint files; touch only this group's files.",
          "",
          "- MF-1-15 [minor] workflow 文档渲染函数零测试",
          "  files: workflows/review-fix-loop.js, src/__tests__/review-fix-loop-script.test.ts",
          "  evidence: grep fixerDocPath|groupCalls 在测试零命中",
          "  guidance: 沿用同脚本既有源码提取模式补用例",
          "",
          "Verify-first: ledger entries were independently verified by the aggregator — presume they hold.",
          "If reading the code convinces you a claim is a false positive, do NOT fix it: report it in",
          "`disputed` with concrete counter-evidence (file:line + what the aggregator's verification",
          "missed; empty or vague evidence is an ES3 violation). Disputed items do not abort the loop —",
          "a human adjudicates them after the run. If you cannot rebut, fix it.",
          "All severity levels in scope; only minor may be deferred (with a concrete reason).",
          "self_check per fix: one grep command + the expected result.",
        ].join("\n"),
      );
    });

    it("note 缺失 → 标题裸组号；severity/title 缺省 → major + 空标题占位", () => {
      const { fixerDocPath } = loadFns(docSandbox([{ id: "E-1" }]));
      const body = readFileSync(fixerDocPath({ id: "G1", issueIds: ["E-1"] }, 1), "utf-8");
      expect(body).toContain("# Fixer task G1\n");
      // title 缺省渲染为空串占位（"] " 后跟空标题，e.severity || "major" 兜底）
      expect(body).toContain("- E-1 [major] ");
      expect(body).not.toContain("files:");
    });

    it("files 非数组/空数组省略；evidence/guidance 非字符串或空串省略", () => {
      const { fixerDocPath } = loadFns(docSandbox([
        { id: "E-1", severity: "critical", title: "t", files: [], evidence: "", guidance: 42 },
      ]));
      const body = readFileSync(fixerDocPath({ id: "G1", issueIds: ["E-1"] }, 1), "utf-8");
      expect(body).toContain("- E-1 [critical] t");
      expect(body).not.toContain("files:");
      expect(body).not.toContain("evidence:");
      expect(body).not.toContain("guidance:");
    });

    it("未知 issueId（activeEntriesForFix 查无）整条过滤；多条目按 issueIds 顺序渲染", () => {
      const a: FixerDocEntry = { id: "A-1", severity: "major", title: "alpha" };
      const b: FixerDocEntry = { id: "B-2", severity: "minor", title: "beta" };
      const { fixerDocPath } = loadFns(docSandbox([a, b]));
      const body = readFileSync(fixerDocPath({ id: "G2", issueIds: ["B-2", "GHOST", "A-1"] }, 1), "utf-8");
      expect(body).not.toContain("GHOST");
      expect(body.indexOf("- B-2 [minor] beta")).toBeGreaterThan(-1);
      expect(body.indexOf("- B-2 [minor] beta")).toBeLessThan(body.indexOf("- A-1 [major] alpha"));
    });

    it("覆盖写：同 k 重复渲染同路径、以最后一次为准（确定性渲染覆盖陈旧文档）", () => {
      const sandbox = docSandbox([{ id: "OLD-1", severity: "major", title: "stale" }]);
      const { fixerDocPath } = loadFns(sandbox);
      const p = fixerDocPath({ id: "G1", issueIds: ["OLD-1"] }, 1);
      expect(readFileSync(p, "utf-8")).toContain("- OLD-1 [major] stale");
      sandbox.activeEntriesForFix = [{ id: "NEW-1", severity: "major", title: "fresh" }];
      expect(fixerDocPath({ id: "G1", issueIds: ["NEW-1"] }, 1)).toBe(p);
      expect(readFileSync(p, "utf-8")).toContain("- NEW-1 [major] fresh");
      expect(readFileSync(p, "utf-8")).not.toContain("OLD-1");
    });
  });

  describe("groupCalls（fixer 派发调用组装）", () => {
    const FIX_SCHEMA = { type: "object", marker: "fix-schema" };

    function callsSandbox(opts: {
      fixGroups: FixGroupLike[];
      entries: readonly unknown[];
      fixDef: { name?: string; path?: string } | null;
      reportFile?: unknown;
      fixesCaution?: unknown;
    }): { sandbox: Record<string, unknown>; captured: Array<Record<string, unknown>> } {
      const captured: Array<Record<string, unknown>> = [];
      const sandbox: Record<string, unknown> = {
        ...docSandbox(opts.entries),
        fixGroups: opts.fixGroups,
        round: 2,
        batchIndex: 3,
        agg: { report_file: opts.reportFile, fixes_caution: opts.fixesCaution },
        fixPrompt: "FIX-INSTRUCTIONS",
        commitInstr: "COMMIT-INSTR",
        fixSchema: FIX_SCHEMA,
        MODEL: "model/x",
        FIX_DEF: opts.fixDef,
        buildFixPrompt: (args: Record<string, unknown>) => {
          captured.push(args);
          return "PROMPT-" + captured.length;
        },
      };
      return { sandbox, captured };
    }

    it("组→文档→调用一一对应：k 从 1 起、header 含 round/batch/组序、prompt 保序", () => {
      const { sandbox, captured } = callsSandbox({
        fixGroups: [
          { id: "G1", issueIds: ["A-1"], note: "n1" },
          { id: "G2", issueIds: ["B-2"] },
        ],
        entries: [
          { id: "A-1", severity: "major", title: "alpha" },
          { id: "B-2", severity: "minor", title: "beta" },
        ],
        fixDef: { name: "fxagent", path: "/agents/fx.md" },
        reportFile: "agg.md",
        fixesCaution: ["caution-1"],
      });
      const { groupCalls } = loadFns(sandbox);
      expect(groupCalls).toHaveLength(2);
      // map 保序：第 i 个调用的 prompt 来自第 i 次 buildFixPrompt
      expect(groupCalls[0].prompt).toBe("PROMPT-1");
      expect(groupCalls[1].prompt).toBe("PROMPT-2");
      expect(captured[0].header).toBe("Fix round 2 (batch 3, group G1/2)");
      expect(captured[1].header).toBe("Fix round 2 (batch 3, group G2/2)");
      // groupDocPath = fixerDocPath(g, gi+1)：文档按 1 起编号落盘且内容对组不串
      expect(captured[0].groupDocPath).toBe(roundDir + "/aggregate-4-fixer-1.md");
      expect(captured[1].groupDocPath).toBe(roundDir + "/aggregate-4-fixer-2.md");
      const doc1 = readFileSync(String(captured[0].groupDocPath), "utf-8");
      const doc2 = readFileSync(String(captured[1].groupDocPath), "utf-8");
      expect(doc1).toContain("# Fixer task G1 — n1");
      expect(doc1).toContain("- A-1 [major] alpha");
      expect(doc1).not.toContain("B-2");
      expect(doc2).toContain("# Fixer task G2\n");
      expect(doc2).toContain("- B-2 [minor] beta");
      // 上下文透传：报告路径 / caution / fix 指令 / commit 纪律
      expect(captured[0].reportPath).toBe("agg.md");
      expect(captured[0].caution).toEqual(["caution-1"]);
      expect(captured[0].fixPrompt).toBe("FIX-INSTRUCTIONS");
      expect(captured[0].commitInstr).toBe("COMMIT-INSTR");
    });

    it("调用字段：schema 恒等 fixSchema、model=MODEL、returnMeta=true、agent=FIX_DEF.path", () => {
      const { sandbox, captured } = callsSandbox({
        fixGroups: [{ id: "G7", issueIds: ["A-1"] }],
        entries: [{ id: "A-1", severity: "major", title: "alpha" }],
        fixDef: { name: "fxagent", path: "/agents/fx.md" },
      });
      const { groupCalls } = loadFns(sandbox);
      expect(groupCalls[0].schema).toBe(FIX_SCHEMA);
      expect(groupCalls[0].model).toBe("model/x");
      expect(groupCalls[0].returnMeta).toBe(true);
      expect(groupCalls[0].agent).toBe("/agents/fx.md");
      expect(groupCalls[0].description).toBe("fxagent-G7");
      expect(captured).toHaveLength(1);
    });

    it("FIX_DEF=null → description 兜底 fix-<gid>，无 agent 键（通用 subagent 路径）", () => {
      const { sandbox } = callsSandbox({
        fixGroups: [{ id: "G1", issueIds: ["A-1"] }],
        entries: [{ id: "A-1", severity: "major", title: "alpha" }],
        fixDef: null,
      });
      const { groupCalls } = loadFns(sandbox);
      expect(groupCalls[0].description).toBe("fix-G1");
      expect(Object.prototype.hasOwnProperty.call(groupCalls[0], "agent")).toBe(false);
    });

    it("FIX_DEF 有 name 无 path → 无 agent 键；report_file 非字符串 → reportPath 空串；caution 空/缺失 → []", () => {
      const { sandbox, captured } = callsSandbox({
        fixGroups: [{ id: "G3", issueIds: ["A-1"] }],
        entries: [{ id: "A-1", severity: "major", title: "alpha" }],
        fixDef: { name: "named-only" },
        reportFile: 42,
        fixesCaution: [],
      });
      const { groupCalls } = loadFns(sandbox);
      expect(groupCalls[0].description).toBe("named-only-G3");
      expect(Object.prototype.hasOwnProperty.call(groupCalls[0], "agent")).toBe(false);
      expect(captured[0].reportPath).toBe("");
      expect(captured[0].caution).toEqual([]);
    });
  });
});
