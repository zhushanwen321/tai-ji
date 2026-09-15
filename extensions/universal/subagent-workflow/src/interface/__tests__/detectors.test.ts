// Behavioral tests for weak-model parameter-misuse detectors.
//
// Complements the source-text prompt-quality tests (subagent-tool-prompt.test.ts /
// workflow-tool-prompt.test.ts): those lock that the Correct examples / anti-pattern
// STRINGS exist in source; these lock the actual trigger/no-trigger LOGIC, so a
// refactor that inverts a condition or swaps keys cannot pass just by keeping the
// literal string alive.
//
// Covers the detectors added in the weak-model-robustness PR:
//   - workflow findFlattenedArgKeys (args sub-fields flattened to top level — P0)
//
// NOTE: subagent hasFlattenedStartFields detector 已随 wave 3 拍平删除——
// startParam envelope 不再存在，task/slug 平铺到顶层是合法形态，原 detector 无意义。

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

// D9 下沉后权威实现迁至 core args-meta——宿主差异（TOOL_TOP_LEVEL 撞名保护）经
// reservedKeys 注入，与 tool-workflow 调用点保持同一契约。
import {
  argKeysFromMeta,
  findFlattenedArgKeys,
} from "@zhushanwen/subagent-core/orchestration/args-meta.ts";
import { TOOL_TOP_LEVEL } from "../tool-workflow";
import { parseResourceMeta } from "@zhushanwen/subagent-core";

// 宿主 reservedKeys 注入（与 tool-workflow ARGS_META_OPTIONS 等值契约）
const OPT = { reservedKeys: TOOL_TOP_LEVEL };

// 真实参数 meta（@pi-meta parameters——m6 动态数据源，与 TC2 同源防漂移）
function rflMeta() {
  const src = readFileSync(join(__dirname, "../../../node_modules/@zhushanwen/subagent-core/workflows/review-fix-loop.js"), "utf-8");
  const meta = parseResourceMeta(src, "workflow");
  if (!meta || meta.kind !== "workflow" || !meta.parameters) throw new Error("rfl meta");
  return meta.parameters;
}
function chainMeta() {
  const src = readFileSync(join(__dirname, "../../../node_modules/@zhushanwen/subagent-core/workflows/chain.js"), "utf-8");
  const meta = parseResourceMeta(src, "workflow");
  if (!meta || meta.kind !== "workflow" || !meta.parameters) throw new Error("chain meta");
  return meta.parameters;
}
const RFL = rflMeta();
const CHAIN = chainMeta();

describe("findFlattenedArgKeys (workflow args flatten detector — P0)", () => {
  it("TC3a: trigger——chain 参数集平铺 task 被识别；跨 workflow 区分（items 非 chain 参数不触发）", () => {
    expect(
      findFlattenedArgKeys({ action: "run", name: "chain", task: "x" }, CHAIN, OPT),
    ).toEqual(["task"]);
    // 跨 workflow：items 是 map-reduce 参数非 chain 参数 → 不触发（m6 动态集语义）
    expect(
      findFlattenedArgKeys({ action: "run", name: "chain", items: ["a"] }, CHAIN, OPT),
    ).toEqual([]);
  });

  it("TC3b: 嵌套 args 不触发", () => {
    expect(
      findFlattenedArgKeys({ action: "run", name: "x", args: { task: "x", items: ["a"] } }, CHAIN, OPT),
    ).toEqual([]);
  });

  it("TC3c: 顶层 + args 内共存不触发（args-排除保留）", () => {
    expect(
      findFlattenedArgKeys({ action: "run", name: "x", args: { task: "x" }, task: "y" }, CHAIN, OPT),
    ).toEqual([]);
  });

  it("TC3d: 无已知键不触发；空集不触发", () => {
    expect(
      findFlattenedArgKeys({ action: "run", name: "x", args: {} }, CHAIN, OPT),
    ).toEqual([]);
    // meta undefined → 空键集（原「空集不触发」等价形态）
    expect(
      findFlattenedArgKeys({ action: "status" }, undefined),
    ).toEqual([]);
  });

  it("TC3e: review-fix-loop fixAgent 平铺被识别（动态集 exact）", () => {
    expect(
      findFlattenedArgKeys({ action: "run", name: "review-fix-loop", fixAgent: "worker" }, RFL, OPT),
    ).toEqual(["fixAgent"]);
    expect(
      findFlattenedArgKeys({ action: "run", name: "review-fix-loop", args: { fixAgent: "worker" } }, RFL, OPT),
    ).toEqual([]);
  });

  it("TC3f: batchN 经 pattern 触发 + batchl 拼错不触发（数字后缀语义）", () => {
    expect(
      findFlattenedArgKeys(
        { action: "run", name: "review-fix-loop", targetType: "git-diff", target: "main" },
        RFL,
        OPT,
      ),
    ).toEqual(["targetType", "target"]);
    expect(
      findFlattenedArgKeys(
        { action: "run", name: "review-fix-loop", batch1: "reviewer", autoCommit: true },
        RFL,
        OPT,
      ),
    ).toEqual(["batch1", "autoCommit"]);
    expect(
      findFlattenedArgKeys(
        { action: "run", name: "review-fix-loop", args: { targetType: "git-diff", target: "main" } },
        RFL,
        OPT,
      ),
    ).toEqual([]);
    // batchl 拼错（非数字后缀）不触发（m6 评审 C-1：pattern 自带数字后缀校验）
    expect(
      findFlattenedArgKeys({ action: "run", name: "x", batchl: "reviewer" }, RFL, OPT),
    ).toEqual([]);
  });

  it("TC3g: 收敛参数平铺被识别（动态集 exact——S-13 3 键，model 升格 TOOL_TOP_LEVEL 后排除）", () => {
    expect(
      findFlattenedArgKeys(
        { action: "run", name: "review-fix-loop", model: "ds-flash", maxFixAttempts: 3, convergeNewIssues: 2, convergeRounds: 3 },
        RFL,
        OPT,
      ),
    ).toEqual(["maxFixAttempts", "convergeNewIssues", "convergeRounds"]);
    expect(
      findFlattenedArgKeys(
        { action: "run", name: "review-fix-loop", args: { model: "ds-flash", maxFixAttempts: 3 }, convergeRounds: 3 },
        RFL,
        OPT,
      ),
    ).toEqual(["convergeRounds"]);
  });

  it("TC3h: non-object 输入返回 []", () => {
    expect(findFlattenedArgKeys(null)).toEqual([]);
    expect(findFlattenedArgKeys(undefined)).toEqual([]);
  });

  it("TC3i: tool 顶层键不误报（M-3 回归——合成 parameters 直测 argKeysFromMeta 排除）", () => {
    // 合成 parameters：workflow 声明参数 name（tool 键撞名）——argKeysFromMeta 必须排除
    const synthetic = {
      type: "object",
      properties: { name: { type: "string" }, task: { type: "string" } },
      required: ["name"],
    };
    const keys = argKeysFromMeta(synthetic, OPT);
    expect(keys.exact.has("task")).toBe(true);
    expect(keys.exact.has("name")).toBe(false); // TOOL_TOP_LEVEL 排除（M-3 真回归锁定）
    // 合法调用不误报
    expect(
      findFlattenedArgKeys(
        { action: "run", name: "mywf", args: { name: "x" } },
        synthetic,
        OPT,
      ),
    ).toEqual([]);
    // 真实 meta 不含 name（探针实测 16 键）——附加验证
    expect(argKeysFromMeta(RFL, OPT).exact.has("name")).toBe(false);
  });
});
