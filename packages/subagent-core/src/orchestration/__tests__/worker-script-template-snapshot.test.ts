/**
 * buildWorkerScript 模板 hoisting（IF5/IF6）— byte-identical 快照锚定。
 *
 * ES8：快照先行——fixture 由「改造前实现」生成落盘（本文件同 commit），
 * 断言重构后输出与 fixture 逐字节一致，锁定 PRE/POST 边界换行与 userScript
 * 缩进语义（AC-4「逐字保留」不变式）。IF6（_KNOWN_FIELDS 提升至生成源
 * module scope）落地时基线已按设计在同一 commit 内更新为最终形态。
 *
 * 样例脚本覆盖 $ARGS / schema / parallel / pipeline / workflow / phase / log 特性。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";

const sampleScript = [
  "// sample exercising template features",
  'const name = $ARGS.name ?? "default";',
  'phase("build");',
  'const spec = await agent("build it", { label: "builder", schema: { type: "object" } });',
  "const results = await parallel([",
  '  agent({ task: "unit tests", agent: "./tester.md" }),',
  '  agent({ task: "lint", agent: "./linter.md", skill: "lint-skill" }),',
  "]);",
  "await pipeline([(x) => x, (x) => x]);",
  'await workflow("deploy", { env: "prod" });',
  'log("done " + name + " " + $WORKSPACE + " " + $BUDGET.remaining());',
  "module.exports = { execute: async (ctx) => ctx.agent(\"finalize\") };",
].join("\n");

function loadFixture(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "__fixtures__", "worker-template.snapshot.txt"), "utf8");
}

describe("buildWorkerScript — 模板 hoisting byte-identical 快照（IF5）", () => {
  it("特性全量样例的输出与 fixture 逐字节一致", () => {
    const out = buildWorkerScript(sampleScript);
    expect(out).toBe(loadFixture());
  });

  it("首尾边界锚定：use strict 开头 + error handler 结尾 + userScript 缩进注入", () => {
    const out = buildWorkerScript(sampleScript);
    // PRE 边界：第一行 use strict（无前导换行）
    expect(out.startsWith('"use strict";\n')).toBe(true);
    // userScript 段：两空格缩进注入（AC-4 拼接语义）
    expect(out).toContain("\n  // sample exercising template features\n");
    // userScript 段结束后一个空行再接 auto-invoke 段（POST 首部换行语义）
    expect(out).toContain("ctx.agent(\"finalize\") };\n\n  // ── Auto-invoke execute() for module.exports pattern ──");
    // POST 边界：以 error handler 的 "});" 结尾（无尾随换行）
    expect(out.endsWith('_safePost({ type: "error", runId, error: err.message || String(err), workerLogs: _workerLogs }, "error");\n});')).toBe(true);
  });

  it("空 userScript 与任意脚本的拼接语义稳定（PRE/POST 不含 userScript 状态）", () => {
    const a = buildWorkerScript("x");
    const b = buildWorkerScript("y");
    // 除 userScript 段外完全一致：以 userScript 行为界切割比对
    const [preA] = a.split("\n  x\n");
    const [preB] = b.split("\n  y\n");
    expect(preA).toBe(preB);
  });

  it("A8 rfl 仪表透传字段字面量锚定（tier-1 §7.1）：live resolve 与缓存重放两对称点均含三字段", () => {
    const out = buildWorkerScript("// noop");
    // live resolve 分支（agent-result 消息处理）
    expect(out).toContain("usage: msg.result.usage,");
    expect(out).toContain("durationMs: msg.result.durationMs,");
    expect(out).toContain("sessionId: msg.result.sessionId,");
    // 缓存重放分支（_callCache 命中重建，对称点）
    expect(out).toContain("usage: cached.usage,");
    expect(out).toContain("durationMs: cached.durationMs,");
    expect(out).toContain("sessionId: cached.sessionId,");
  });
});

describe("buildWorkerScript — _KNOWN_FIELDS module scope 提升（IF6）", () => {
  const script = buildWorkerScript("// noop user script");

  it("生成源含 module 级 _KNOWN_FIELDS 声明（与 _workerLogs 同级，IIFE 外）", () => {
    // 声明在 IIFE 开始之前（module scope）：const _KNOWN_FIELDS 必须出现在 "(async () => {" 前
    const iifePos = script.indexOf("(async () => {");
    const knownPos = script.indexOf("const _KNOWN_FIELDS = new Set([");
    expect(knownPos).toBeGreaterThan(-1);
    expect(knownPos).toBeLessThan(iifePos);
    // 紧随 _workerLogs 声明之后（design IF6：与 _workerLogs/:62 同级）
    expect(script.indexOf("const _workerLogs = [];")).toBeLessThan(knownPos);
  });

  it("agent() 体内不再重建 Set（引用 _KNOWN_FIELDS，无 new Set）", () => {
    // agent() 函数体（到 parallel 声明前）内不得有 new Set 构造
    const agentPos = script.indexOf("async function agent(firstArg, secondArg)");
    const parallelPos = script.indexOf("async function parallel(calls)");
    expect(agentPos).toBeGreaterThan(-1);
    expect(parallelPos).toBeGreaterThan(agentPos);
    const agentBody = script.slice(agentPos, parallelPos);
    expect(agentBody).not.toContain("new Set(");
    expect(agentBody).toContain("_KNOWN_FIELDS.has(k)");
  });

  it("字段集合内容逐字段一致（18 known fields 不丢失——P4 增 engine，预算语义对齐增 maxTurns）", () => {
    expect(script).toContain(
      'const _KNOWN_FIELDS = new Set(["prompt", "description", "schema", "model", "scene", "label", "task", "agent", "phase", "skill", "timeoutMs", "maxTurns", "cwd", "fork", "worktree", "returnMeta", "thinkingLevel", "engine"]);',
    );
    // unknown-fields 警告文案不变（known 列表仍全量）
    expect(script).toMatch(/Known fields:.*returnMeta.*thinkingLevel.*engine/);
  });

  it("agent() 各分支均透传 maxTurns（预算语义对齐：脚本作者可显式传 turn 上限）", () => {
    // task/agent shortcut 分支：显式转发
    expect(script).toContain("maxTurns: firstArg.maxTurns,");
    // string+secondArg 分支：显式转发（?? 语义保真：显式 0 不被抹成 undefined，F-2/U5）
    expect(script).toContain(
      'maxTurns: (secondArg && typeof secondArg === "object" ? secondArg.maxTurns : undefined) ?? undefined,',
    );
    // opts = firstArg 直传分支无需处理（整对象透传）
  });

  // [F-2 maxTurns:0 吞没修复] 旧字符串分支 `&& maxTurns) || undefined` 把显式 0
  // 抹成 undefined → runSpawn 落 env 兑底（SPAWN_WATCHDOG env 设置时误挂 watchdog），
  // 与对象分支保真语义分裂。锁定生成源为 ?? 形态（0/null/undefined 区分处理）。
  it("string 分支 maxTurns 用 ?? 语义（显式 0 不抹成 undefined，F-2）", () => {
    const out = buildWorkerScript("// noop");
    expect(out).not.toContain('secondArg.maxTurns) || undefined');
    expect(out).toContain("?? undefined");
  });
});
