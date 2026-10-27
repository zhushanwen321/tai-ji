// review-fix-loop.js workflow 脚本内纯函数直测（W2 移交 CRAP 240/110 最高项）。
//
// 测试方法（限制见文末 import 用例）：review-fix-loop.js 是 pi worker 模板脚本——
// 顶层执行 + 顶层 return，不可作为 ES module import（vite/esbuild 直接 SyntaxError）。
// 因此用 vm.Script 对源码文本做「函数段抽取求值」：从源文件按函数名定位 + brace
// 配平截取 normUsage / warnTelemetryMissingOnce / buildCallRecord 三段（loadScriptFns
// 集中求值），在注入 log/Buffer 的沙箱里求值后取回引用。抽取定位
// 失败（函数改名/移动）会显式 throw，不会静默测到旧副本。
//
// 回归锚点（对照修复史，断言在旧实现上会红）：
//   - W1：失败调用（returnMeta={value,error}）不得触发 telemetry-missing WARN
//         （旧实现不排除 error 分支，agent 失败被误诊为引擎透传未上线并烧掉 once 名额）
//   - A11：model 缺省回退 "(default)"（请求时参数语义）
//   - A12：promptMode=null（aggregator/fixer）必须保持 null，不被 || 误转 "full"
//
// 注：弱格式通道相关测试（summarizeDegradedTrigger 直测 / F-1 前缀契约锁定 /
// degraded 三落点锚点 / 兜底差集清单锚点）已随 fail-fast 改造整体退役——
// 结构化返回失败即终判，脚本侧无 F-1 字面量、无降级可观测性；引擎侧
// DETERMINISTIC_SCHEMA_FAILURE_PREFIX 常量仍被宿主 execute-agent-call 重试分诊
// 消费（output-collector.test.ts 侧覆盖），与本脚本无契约关系。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKFLOW_SOURCE = readFileSync(
  join(__dirname, "..", "..", "workflows", "review-fix-loop.js"),
  "utf8",
);

/** 按函数名从源码文本截取完整函数段（参数括号配平后 brace 配平函数体）。
 *  抽取不到 → 显式报错（防漂移）。buildCallRecord 的解构参数含花括号，
 *  函数体起点必须从参数列表的结束括号之后找，不能直接 indexOf("{")。 */
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

// ── applyCarryoverRegression（自 utils.cjs 迁入 pi 模板顶层——它依赖 shared 单源段
//    inheritCarryoverFields，两函数都在产物源码内，函数段抽取求值时一并取出）──
describe("review-fix-loop.js applyCarryoverRegression — 「重报 → regressed」转移（merge 路径单点实装，C2）", () => {
  const loadFns = () =>
    vm.runInNewContext(
      [extractFn("inheritCarryoverFields"), extractFn("applyCarryoverRegression"), "({ inheritCarryoverFields, applyCarryoverRegression })"].join("\n"),
      {},
    ) as {
      inheritCarryoverFields: (t: Record<string, unknown>, e: Record<string, unknown>) => boolean;
      applyCarryoverRegression: (t: Record<string, unknown>, e: Record<string, unknown>, round: number) => void;
    };
  const trackedBase = (status: string) => ({
    firstSeen: 1, severity: "major", status, openStreak: 0,
    history: [{ round: 1, status: "open" }], fixAttempts: 0,
  });
  it("fix-attempted + 重报 → regressed、fixAttempts+1、openStreak+1、history 追加（B1 逐字段等价）", () => {
    const { applyCarryoverRegression } = loadFns();
    const tracked = trackedBase("fix-attempted");
    applyCarryoverRegression(tracked, { id: "MF-1", severity: "major" }, 3);
    expect(tracked.status).toBe("regressed");
    expect(tracked.fixAttempts).toBe(1);
    expect(tracked.openStreak).toBe(1);
    expect(tracked.history).toContainEqual({ round: 3, status: "regressed" });
  });
  it("fixed + 重报 → 同样转 regressed（复发同计修复失败，needs-redesign 可达）", () => {
    const { applyCarryoverRegression } = loadFns();
    const tracked = { ...trackedBase("fixed"), fixAttempts: 1, openStreak: 2, history: [{ round: 1, status: "open" }, { round: 2, status: "fixed" }] };
    applyCarryoverRegression(tracked, { id: "MF-1", severity: "major" }, 4);
    expect(tracked.status).toBe("regressed");
    expect(tracked.fixAttempts).toBe(2);
    expect(tracked.openStreak).toBe(3);
  });
  it("severity 继承：采信本轮显式标注（shared 单源 inheritCarryoverFields 同一权威语义）", () => {
    const { applyCarryoverRegression } = loadFns();
    const tracked = trackedBase("fix-attempted");
    applyCarryoverRegression(tracked, { id: "MF-1", severity: "critical" }, 2);
    expect(tracked.severity).toBe("critical");
  });
  it("title 清单权威：转换不覆盖既有 title（title 继承只由调用方继承点承担）", () => {
    const { applyCarryoverRegression } = loadFns();
    const tracked = { ...trackedBase("fix-attempted"), title: "原始标题" };
    applyCarryoverRegression(tracked, { id: "MF-1", severity: "major", title: "重报换措辞" }, 2);
    expect(tracked.title).toBe("原始标题");
  });
});

// ── RX2-F2：fixAgent=fallow-scan 显式拒收（脚本顶层参数校验，非函数段） ──
// 拒收逻辑位于脚本顶层（FIX_AGENT_RAW 解析后、resolveAgentDefs 前），函数段抽取法
// 覆盖不到；改用「AsyncFunction 包装」在本进程内跑整脚本顶层（worker 模板宿主形态：
// workerData/$ARGS/require/log/$MODEL 注入；workerData.scriptPath 锚定真实路径——
// utils 锚定加载经 scriptPath 同目录 require，无需副本）。[单测层极端测试整治]
// 原形态为 node -e 冷 spawn 探针，in-process 化后断言语义不变、零 spawn。拒收点在
// RUN_ROOT 落盘 / lockReviewBase 之前（对照用例 fail 于 parseBatches 的批次校验，
// 仍在 RUN_ROOT 创建之前），执行无文件系统副作用、恒 reject。
describe("review-fix-loop.js fixAgent=fallow-scan 显式拒收（RX2-F2）", () => {
  /** worker 模板宿主形态：AsyncFunction 以注入参数为自由变量执行整脚本源码。 */
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...params: string[]
  ) => (this: unknown, ...args: unknown[]) => Promise<unknown>;

  const RFL_PATH = join(__dirname, "..", "..", "workflows", "review-fix-loop.js");
  const runner = new AsyncFunction("workerData", "$ARGS", "require", "log", "$MODEL", WORKFLOW_SOURCE + "\n");
  const requireFromTest = createRequire(import.meta.url);

  /** 跑整脚本顶层；两个用例的参数形态都必然 reject（fail-fast），resolve 即测试失败。 */
  async function runTopLevelExpectThrow(args: Record<string, unknown>): Promise<string> {
    try {
      await runner({ scriptPath: RFL_PATH }, args, requireFromTest, () => {}, "probe-model");
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    throw new Error("expected script to throw, but it resolved with args: " + JSON.stringify(args));
  }

  it("fixAgent=fallow-scan → throw 保留字错误 + fallowScan=true 恢复指引", async () => {
    const message = await runTopLevelExpectThrow({
      targetType: "file",
      target: "probe",
      fixAgent: "fallow-scan",
    });
    expect(message).toContain("内部保留字");
    expect(message).toContain("fallowScan=true");
    // 旧实现静默映射 FALLOW_DEF（fix 派发退化为通用 subagent）——不会到达此处报错
  });

  it("对照：合法形态 fixAgent（.md 路径）不触发保留字拒收（后续批次校验照常 fail）", async () => {
    const message = await runTopLevelExpectThrow({
      targetType: "file",
      target: "probe",
      fixAgent: "/tmp/rx2-f2-fake-agent.md",
    });
    // 推进到批次解析才失败（缺批次参数）——证明拒收只对字面值 fallow-scan 触发
    expect(message).toContain("缺少批次参数");
    expect(message).not.toContain("内部保留字");
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
  /** 从 marker 起截取完整语句（跳过字符串/模板串/行注释/块注释，depth-0 `;` 收尾）。 */
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

// ── 结构化失败终判恢复指引（fail-fast：错误信息带恢复动作是要求，不是兜底）──
// 源文本锚定防「终判文案被精简后丢恢复指引」——行为级断言（终判 message 内容）
// 在 subagent-workflow e2e mock 层（review-fix-loop-e2e.test.ts fail-fast describe），
// 此处锁源级形态。弱格式通道相关锚点（summarizeDegradedTrigger 直测 / F-1 前缀
// 契约锁定 / degraded 三落点 / 兜底差集清单）已随通道拆除整体退役。
describe("review-fix-loop.js 结构化失败终判恢复指引锚点", () => {
  it("恢复指引常量单一声明 + 语义覆盖结构化链路检查动作与重试闭环", () => {
    expect(WORKFLOW_SOURCE).toContain("const REVIEWER_RECOVERY_HINT = ");
    // 语义三要素：tools 白名单检查（受限 tools 过滤 schema 工具）/ 引擎 schema 支持 / 重跑闭环
    expect(WORKFLOW_SOURCE).toContain("tools 白名单须放行 structured_output");
    expect(WORKFLOW_SOURCE).toContain("schema 结构化返回");
    expect(WORKFLOW_SOURCE).toContain("重跑 workflow");
  });

  it("两处 reviewer 终判分支（结构化 error catch / 结果无效落入处）都以常量拼接收尾——防一处直写字面量漂移", () => {
    // 结构化 error 落入的终判（failFastAgent catch：failedLabel + e.message）
    expect(WORKFLOW_SOURCE).toContain('String(e)) + REVIEWER_RECOVERY_HINT;');
    // 结果无效落入的终判（审查 agent 结果无效，缺 must_fix）
    expect(WORKFLOW_SOURCE).toContain('.slice(0, 400) + REVIEWER_RECOVERY_HINT;');
    // 消费恰好两处（1 声明 + 2 消费 = 标识符共 3 次）——第三处内联即红
    expect(WORKFLOW_SOURCE.match(/REVIEWER_RECOVERY_HINT/g)?.length).toBe(3);
    expect(WORKFLOW_SOURCE.match(/\+ REVIEWER_RECOVERY_HINT;/g)?.length).toBe(2);
  });

  it("fail-fast 形态锚点：failFastAgent 包装存在、脚本无 F-1 字面量、无 degraded 可观测性", () => {
    // failFastAgent 单一声明 + reviewer/fixer/reviewer 解析失败原位重试 三处消费
    //（声明含 `(`，共 4 次；重试消费点 = 结果无效时的回注重派，2026-09-30 同步 dev-merge-gates）
    expect(WORKFLOW_SOURCE).toContain("function failFastAgent(call, failedLabel)");
    expect(WORKFLOW_SOURCE.match(/failFastAgent\(/g)?.length).toBe(4);
    // F-1 引擎前缀字面量不再内联（引擎侧常量仍被宿主重试分诊消费，与本脚本无契约关系）
    expect(WORKFLOW_SOURCE).not.toContain("Structured output failed deterministically");
    // 弱格式降级可观测性零残留（degraded 三落点已整体拆除）
    expect(WORKFLOW_SOURCE).not.toContain("degradedRounds");
    expect(WORKFLOW_SOURCE).not.toContain("degradedRoundKeys");
    expect(WORKFLOW_SOURCE).not.toContain("baselineDirtyPaths");
    expect(WORKFLOW_SOURCE).not.toContain("recoverFromReportFile");
    expect(WORKFLOW_SOURCE).not.toContain("parseAggregatedMd");
  });
});

// ── W2 分析产物落盘（skill-data-redesign 设计 §5.1-§5.4）：写盘点结构锚 ──
// 行为级断言（序列化函数本身）在 review-fix-loop-utils.test.ts（纯函数直测）；
// 本组锁脚本侧的写盘点编排形态：四类产物 + run.json 轮转在循环体有落点、每个
// round 退出点都带 critical 计数（mustFixTrajectory 数据源不缺位点）。
describe("review-fix-loop.js W2 落盘写盘点锚点", () => {
  it("四类产物 + 终态双文件在循环体有写盘点（文件名与设计 §5.1-§5.4 逐字对齐）", () => {
    // 每轮 review 后：reviewer 原始发现（problems.json，外层 {round, problems}）
    expect(WORKFLOW_SOURCE).toContain('roundDir + "/problems.json"');
    expect(WORKFLOW_SOURCE).toContain("buildProblemsDoc(round,");
    // 聚合成功后：聚合结构化返回序列化（aggregated.json，非 agent 第二产物）
    expect(WORKFLOW_SOURCE).toContain('roundDir + "/aggregated.json"');
    expect(WORKFLOW_SOURCE).toContain("buildAggregatedDoc(agg, { round, batch: batchIndex })");
    // 每轮 fix 后：逐问题对账（result.json，disposition 四值词表，全清单态映射）
    expect(WORKFLOW_SOURCE).toContain('roundDir + "/result.json"');
    expect(WORKFLOW_SOURCE).toContain("buildRoundReconciliation(fixResult, state.issues, fixIdMap)");
    // 终态：run.json（轮转归档前置）+ final.json（return 契约全集 + 计算字段）
    expect(WORKFLOW_SOURCE).toContain('const runJsonPath = RUN_ROOT + "/run.json";');
    expect(WORKFLOW_SOURCE).toContain("rotateRunJson({");
    expect(WORKFLOW_SOURCE).toContain('RUN_ROOT + "/final.json"');
    expect(WORKFLOW_SOURCE).toContain("buildFinalDoc(result, {");
    // 序列化全部走 writeAnalysisJson（分析面写失败 WARN 降级，不炸修复循环）
    expect(WORKFLOW_SOURCE.match(/writeAnalysisJson\(/g)?.length).toBe(6);
  });

  it("每个 batchRounds.push 都带 critical 计数（mustFixTrajectory 数据源不缺位点）", () => {
    const pushCount = WORKFLOW_SOURCE.match(/batchRounds\.push\(/g)?.length ?? 0;
    const criticalCount = WORKFLOW_SOURCE.match(/critical: roundCritical\b/g)?.length ?? 0;
    expect(pushCount).toBeGreaterThan(0);
    // 数量相等 = 无缺 critical 的退出点；新增退出点漏带 critical 即红
    expect(criticalCount).toBe(pushCount);
    // 聚合成功轮的计数据源 = 清单活跃口径（open/regressed critical，聚合 + reconcile 后
    // 求值；与 zcode 镜像同源）；all-clean 轮无聚合定 0；失败终态轮保持 null（轨迹剔除）
    expect(WORKFLOW_SOURCE).toContain("roundCritical = countLedgerCritical(state.issues);");
    expect(WORKFLOW_SOURCE).toContain("roundCritical = 0;");
    // 终态轨迹 = batchRounds.critical 扁平化 + 剔除未聚合轮 null（数字序列与 zcode 镜像同构）
    expect(WORKFLOW_SOURCE).toContain("const mustFixTrajectory = state.batches.flatMap((b) =>");
    expect(WORKFLOW_SOURCE).toContain(".filter((v) => v !== null),");
  });

  it("run.json schema 字段装配齐全（§5.1 字段集源级锁定）+ 轮转归档命名（冒号换连字符）", () => {
    const manifestCall = WORKFLOW_SOURCE.slice(
      WORKFLOW_SOURCE.indexOf("buildRunManifest({"),
      WORKFLOW_SOURCE.indexOf("}));", WORKFLOW_SOURCE.indexOf("buildRunManifest({")),
    );
    for (const field of [
      "projectRoot", "worktreePath", "branch", "baseCommit", "headCommit",
      "attempt", "model", "startedAt", "endedAt", "rounds",
    ]) {
      expect(manifestCall).toContain(field + ":");
    }
    // terminated / mustFixTrajectory 以 shorthand 透传（与脚本局部变量同名，无冒号形态）
    expect(manifestCall).toContain("terminated");
    expect(manifestCall).toContain("mustFixTrajectory");
    // attempt 恒 1（本循环族无 attempt 机制，防覆盖由轮转归档承担——与 zcode 镜像同口径）
    expect(WORKFLOW_SOURCE).toContain("attempt: 1,");
    // model 取不到 → null（分析侧按模型分层的字段，缺席显式可见）
    expect(manifestCall).toContain("model: MODEL || null");
    // baseCommit 用启动期锁定的 base hash（RC-6）
    expect(manifestCall).toContain("baseCommit: lockedBase.hash || \"\"");
    // startedAt 轮转命名规则在 utils 侧（rotateRunJson 用例覆盖冒号换连字符），此处锁
    // 脚本传入的是 run 启动时刻（state.meta.startedAt）——同 runId 重放覆写判据的数据源
    expect(WORKFLOW_SOURCE).toContain("startedAt: state.meta.startedAt,");
  });

  it("reviewerSchema / aggregatorSchema 增补字段在场（problems 申报 + sourceRefs 申报）", () => {
    expect(WORKFLOW_SOURCE).toContain('roundDir + "/problems.json"');
    // problems 申报：ref/level/title 三字段 + 本族 severity 词表
    expect(WORKFLOW_SOURCE).toContain('level: { type: "string", enum: ["critical", "major", "minor"]');
    // sourceRefs 申报：可选项（缺失不 fail，归一/序列化边界补 []），元素 {round, ref}
    // 与 zcode 镜像同构
    expect(WORKFLOW_SOURCE).toContain("sourceRefs: {");
    expect(WORKFLOW_SOURCE).toContain('round: { type: "number"');
  });
});
