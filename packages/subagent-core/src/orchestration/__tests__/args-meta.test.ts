// src/orchestration/__tests__/args-meta.test.ts
//
// U9（args-meta）单元测试。fixture = 既有 workflow 资产 @pi-meta parameters
// （packages/subagent-core/workflows/，经 core 自有 parseResourceMeta 解析——与
// pi-sw detectors.test.ts 同源同解析器，防 fixture 漂移）。
//
// 等值对照：PI_TOOL_TOP_LEVEL 注入后复刻 pi-sw detectors.test.ts TC3a-TC3i 场景
// （u-core-args 验收条款②「pi-sw 既有 findFlattenedArgKeys 行为等值」的锚定面）。
// 对照锚常量抄自 extensions/universal/subagent-workflow/src/interface/tool-workflow.ts
// TOOL_TOP_LEVEL（m6 定稿值）——pi-sw 侧若演进，对照测试同步刷新即暴露语义分叉。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseResourceMeta } from "../../shared/meta-parser.ts";
import {
  argKeysFromMeta,
  findFlattenedArgKeys,
  normalizeArgsByMeta,
} from "../args-meta.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(here, "..", "..", "..", "workflows");

/** 解析既有 workflow 资产的 @pi-meta parameters（真实资产 fixture，禁合成替代）。 */
function loadWorkflowParameters(name: string): Record<string, unknown> {
  const src = readFileSync(join(WORKFLOWS_DIR, `${name}.js`), "utf8");
  const meta = parseResourceMeta(src, "workflow");
  if (!meta || meta.kind !== "workflow" || !meta.parameters) {
    throw new Error(`fixture 损坏：${name} 无 workflow meta 或无 parameters`);
  }
  return meta.parameters;
}

const CHAIN_PARAMS = loadWorkflowParameters("chain");
const RFL_PARAMS = loadWorkflowParameters("review-fix-loop");
const MAP_REDUCE_PARAMS = loadWorkflowParameters("map-reduce");

/**
 * pi workflow tool 顶层键集（对照锚，抄自 pi-sw tool-workflow.ts TOOL_TOP_LEVEL，
 * 含 model/thinkingLevel 升格注释）——reservedKeys 宿主注入形态的等值对照基准。
 */
const PI_TOOL_TOP_LEVEL = new Set([
  "action",
  "name",
  "slug",
  "runId",
  "args",
  "tokens",
  "time",
  "error",
  "model",
  "thinkingLevel",
]);

/** pi 等值形态：reservedKeys 注入 pi TOOL_TOP_LEVEL 后的平铺检测（宿主注入消费位）。 */
function piFindFlattened(params: unknown, meta: Record<string, unknown>): string[] {
  return findFlattenedArgKeys(params, meta, { reservedKeys: PI_TOOL_TOP_LEVEL });
}

describe("argKeysFromMeta（schema → 已知参数键集）", () => {
  it("真实资产 chain.js：exact = properties 键集（task/agents）", () => {
    const { exact, patterns } = argKeysFromMeta(CHAIN_PARAMS);
    expect([...exact].sort()).toEqual(["agents", "task"]);
    expect(patterns).toEqual([]);
  });

  it("真实资产 review-fix-loop.js：exact 16 键 + patternProperties 正则（^batch\\d+$）", () => {
    const { exact, patterns } = argKeysFromMeta(RFL_PARAMS);
    // properties 键（schema 定义序）
    expect([...exact]).toEqual([
      "targetType",
      "target",
      "autoCommit",
      "maxRounds",
      "stuckThreshold",
      "skipCleanAgents",
      "recheckAfterFix",
      "fixAgent",
      "maxFixAttempts",
      "convergeNewIssues",
      "convergeRounds",
      "aggregatorModel",
      "reviewPrompt",
      "fixPrompt",
      "fallowScan",
      "agents",
      "batchNames",
    ]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].source).toBe("^batch\\d+$");
    // pattern 语义：数字后缀命中、拼错不命中（m6 评审 C-1）
    expect(patterns[0].test("batch1")).toBe(true);
    expect(patterns[0].test("batch12")).toBe(true);
    expect(patterns[0].test("batchl")).toBe(false);
  });

  it("空 meta（undefined / null / 非对象）→ 空键集（legacy const-meta 检测跳过）", () => {
    expect(argKeysFromMeta(undefined)).toEqual({ exact: new Set(), patterns: [] });
    expect(argKeysFromMeta(null)).toEqual({ exact: new Set(), patterns: [] });
    expect(argKeysFromMeta("not-an-object" as unknown as Record<string, unknown>)).toEqual({
      exact: new Set(),
      patterns: [],
    });
  });

  it("meta 无 properties/patternProperties（如仅 type:object）→ 空键集", () => {
    const { exact, patterns } = argKeysFromMeta({ type: "object" });
    expect(exact.size).toBe(0);
    expect(patterns).toEqual([]);
  });

  it("reservedKeys 注入：撞名参数键从 exact 排除（m6 评审 M-3 撞名保护）", () => {
    const synthetic = {
      type: "object",
      properties: { name: { type: "string" }, task: { type: "string" } },
      required: ["name"],
    };
    const keys = argKeysFromMeta(synthetic, { reservedKeys: PI_TOOL_TOP_LEVEL });
    expect(keys.exact.has("task")).toBe(true);
    expect(keys.exact.has("name")).toBe(false); // pi TOOL_TOP_LEVEL 排除（M-3 真回归锁定）
    // 缺省（无 reservedKeys）不排除——core 中性形态
    const bare = argKeysFromMeta(synthetic);
    expect(bare.exact.has("name")).toBe(true);
  });

  it("能命中 reservedKeys 的 pattern 整条跳过（m6 exec-review S1：^run.*$ 不误伤 runId）", () => {
    const synthetic = {
      type: "object",
      properties: { task: { type: "string" } },
      patternProperties: { "^run.*$": { type: "string" }, "^batch\\d+$": { type: "string" } },
    };
    const keys = argKeysFromMeta(synthetic, { reservedKeys: PI_TOOL_TOP_LEVEL });
    expect(keys.patterns).toHaveLength(1);
    expect(keys.patterns[0].source).toBe("^batch\\d+$");
  });

  it("非法 pattern 跳过不抛（双保险通路，与 pi logger.warn+跳过等值）", () => {
    const synthetic = {
      type: "object",
      patternProperties: { "([": { type: "string" }, "^ok\\d+$": { type: "string" } },
    };
    const keys = argKeysFromMeta(synthetic);
    expect(keys.patterns).toHaveLength(1);
    expect(keys.patterns[0].source).toBe("^ok\\d+$");
  });
});

describe("findFlattenedArgKeys（args 平铺检测——pi-sw 行为等值对照）", () => {
  it("TC3a: trigger——chain 参数集平铺 task 被识别；跨 workflow 区分（items 非 chain 参数不触发）", () => {
    expect(piFindFlattened({ action: "run", name: "chain", task: "x" }, CHAIN_PARAMS)).toEqual(["task"]);
    expect(piFindFlattened({ action: "run", name: "chain", items: ["a"] }, CHAIN_PARAMS)).toEqual([]);
  });

  it("TC3b: 嵌套 args 不触发", () => {
    expect(
      piFindFlattened({ action: "run", name: "x", args: { task: "x", items: ["a"] } }, CHAIN_PARAMS),
    ).toEqual([]);
  });

  it("TC3c: 顶层 + args 内共存不触发（args-排除保留）", () => {
    expect(
      piFindFlattened({ action: "run", name: "x", args: { task: "x" }, task: "y" }, CHAIN_PARAMS),
    ).toEqual([]);
  });

  it("TC3d: 无已知键不触发；空集不触发", () => {
    expect(piFindFlattened({ action: "run", name: "x", args: {} }, CHAIN_PARAMS)).toEqual([]);
    expect(findFlattenedArgKeys({ action: "status" }, undefined)).toEqual([]);
  });

  it("TC3e: review-fix-loop fixAgent 平铺被识别（动态集 exact）", () => {
    expect(
      piFindFlattened({ action: "run", name: "review-fix-loop", fixAgent: "worker" }, RFL_PARAMS),
    ).toEqual(["fixAgent"]);
    expect(
      piFindFlattened({ action: "run", name: "review-fix-loop", args: { fixAgent: "worker" } }, RFL_PARAMS),
    ).toEqual([]);
  });

  it("TC3f: batchN 经 pattern 触发 + batchl 拼错不触发（数字后缀语义）", () => {
    expect(
      piFindFlattened({ action: "run", name: "review-fix-loop", targetType: "git-diff", target: "main" }, RFL_PARAMS),
    ).toEqual(["targetType", "target"]);
    expect(
      piFindFlattened({ action: "run", name: "review-fix-loop", batch1: "reviewer", autoCommit: true }, RFL_PARAMS),
    ).toEqual(["batch1", "autoCommit"]);
    expect(
      piFindFlattened({ action: "run", name: "review-fix-loop", args: { targetType: "git-diff", target: "main" } }, RFL_PARAMS),
    ).toEqual([]);
    expect(piFindFlattened({ action: "run", name: "x", batchl: "reviewer" }, RFL_PARAMS)).toEqual([]);
  });

  it("TC3g: 收敛参数平铺被识别（model 升格 TOOL_TOP_LEVEL 后排除）", () => {
    expect(
      piFindFlattened(
        { action: "run", name: "review-fix-loop", model: "ds-flash", maxFixAttempts: 3, convergeNewIssues: 2, convergeRounds: 3 },
        RFL_PARAMS,
      ),
    ).toEqual(["maxFixAttempts", "convergeNewIssues", "convergeRounds"]);
    expect(
      piFindFlattened(
        { action: "run", name: "review-fix-loop", args: { model: "ds-flash", maxFixAttempts: 3 }, convergeRounds: 3 },
        RFL_PARAMS,
      ),
    ).toEqual(["convergeRounds"]);
  });

  it("TC3h: non-object 输入返回 []", () => {
    expect(findFlattenedArgKeys(null, undefined)).toEqual([]);
    expect(findFlattenedArgKeys(undefined, undefined)).toEqual([]);
  });

  it("TC3i: tool 顶层键不误报（M-3 回归——合成 parameters 直测 reservedKeys 排除）", () => {
    const synthetic = {
      type: "object",
      properties: { name: { type: "string" }, task: { type: "string" } },
      required: ["name"],
    };
    expect(
      piFindFlattened({ action: "run", name: "mywf", args: { name: "x" } }, synthetic),
    ).toEqual([]);
    // 真实 meta 不含 name（探针口径）——附加验证
    expect(argKeysFromMeta(RFL_PARAMS, { reservedKeys: PI_TOOL_TOP_LEVEL }).exact.has("name")).toBe(false);
  });

  it("args 为非对象标量时 args-排除失效（顶层已知键全报——与 pi 谓词等值）", () => {
    expect(
      piFindFlattened({ action: "run", name: "chain", args: "oops", task: "x" }, CHAIN_PARAMS),
    ).toEqual(["task"]);
  });
});

describe("normalizeArgsByMeta（归一组装 + 警告收集）", () => {
  it("正常嵌套：args 原样归一、无警告（chain 真实契约）", () => {
    const r = normalizeArgsByMeta(
      { action: "run", name: "chain", args: { task: "x", agents: "/a.md" } },
      CHAIN_PARAMS,
      { reservedKeys: PI_TOOL_TOP_LEVEL },
    );
    expect(r.args).toEqual({ task: "x", agents: "/a.md" });
    expect(r.warnings).toEqual([]);
  });

  it("args 缺省归一为空对象（params.args ?? {}——pi actionRun 等值）", () => {
    const r = normalizeArgsByMeta(
      { action: "run", name: "chain" },
      CHAIN_PARAMS,
      { reservedKeys: PI_TOOL_TOP_LEVEL },
    );
    expect(r.args).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  it("平铺误用：flattened_args 警告含键名列表（机读 keys + 中立 message）", () => {
    const r = normalizeArgsByMeta(
      { action: "run", name: "chain", task: "x" },
      CHAIN_PARAMS,
      { reservedKeys: PI_TOOL_TOP_LEVEL },
    );
    expect(r.args).toEqual({}); // 平铺键不静默收编（pi 现行为是 throw，修复动作留宿主）
    expect(r.warnings).toEqual([
      {
        code: "flattened_args",
        message: "Detected task at top level — they belong inside 'args'.",
        keys: ["task"],
      },
    ]);
  });

  it("平铺 + args 共存：args-排除生效，无警告（与 pi TC3c 对齐）", () => {
    const r = normalizeArgsByMeta(
      { action: "run", name: "x", args: { task: "x" }, task: "y" },
      CHAIN_PARAMS,
      { reservedKeys: PI_TOOL_TOP_LEVEL },
    );
    expect(r.args).toEqual({ task: "x" });
    expect(r.warnings).toEqual([]);
  });

  it("未知键：不产生警告（检测只对已知键——类型错误归 args-validator）", () => {
    const r = normalizeArgsByMeta(
      { action: "run", name: "chain", unknownKey: "v" },
      CHAIN_PARAMS,
      { reservedKeys: PI_TOOL_TOP_LEVEL },
    );
    expect(r.args).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  it("空 meta：no_parameter_contract 警告 + args 仍归一（M-2 显式信号）", () => {
    const r = normalizeArgsByMeta({ action: "run", name: "legacy", args: { task: "x" } }, undefined);
    expect(r.args).toEqual({ task: "x" });
    expect(r.warnings).toEqual([
      { code: "no_parameter_contract", message: "未声明参数契约（或解析为空）——平铺检测跳过，args 不校验" },
    ]);
  });

  it("pattern 键平铺：batch1 经 pattern 命中进警告（review-fix-loop 真实契约）", () => {
    const r = normalizeArgsByMeta(
      { action: "run", name: "review-fix-loop", batch1: "reviewer" },
      RFL_PARAMS,
      { reservedKeys: PI_TOOL_TOP_LEVEL },
    );
    expect(r.warnings).toEqual([
      {
        code: "flattened_args",
        message: "Detected batch1 at top level — they belong inside 'args'.",
        keys: ["batch1"],
      },
    ]);
  });

  it("reservedKeys 撞名：workflow 声明 model 参数时顶层 model 不误报（宿主键集注入生效）", () => {
    const synthetic = {
      type: "object",
      properties: { model: { type: "string" }, task: { type: "string" } },
    };
    const withReserved = normalizeArgsByMeta(
      { action: "run", model: "ds-flash", task: "x" },
      synthetic,
      { reservedKeys: PI_TOOL_TOP_LEVEL },
    );
    expect(withReserved.warnings[0]).toMatchObject({ code: "flattened_args", keys: ["task"] });
    // 不注入 reservedKeys（core 中性形态）：model 是已知参数 → 平铺报 model+task
    const bare = normalizeArgsByMeta({ action: "run", model: "ds-flash", task: "x" }, synthetic);
    expect(bare.warnings[0]).toMatchObject({ code: "flattened_args", keys: ["model", "task"] });
  });

  it("多键平铺按 Object.keys 序产出（与 pi throw 文案键序一致）", () => {
    const r = normalizeArgsByMeta(
      { action: "run", name: "review-fix-loop", targetType: "git-diff", target: "main" },
      RFL_PARAMS,
      { reservedKeys: PI_TOOL_TOP_LEVEL },
    );
    expect(r.warnings[0]).toMatchObject({ code: "flattened_args", keys: ["targetType", "target"] });
    expect((r.warnings[0] as { message: string }).message).toBe(
      "Detected targetType, target at top level — they belong inside 'args'.",
    );
  });

  it("params 非对象：args = {}，无警告（防御分支，不抛）", () => {
    expect(normalizeArgsByMeta(null, CHAIN_PARAMS)).toEqual({ args: {}, warnings: [] });
    expect(normalizeArgsByMeta(undefined, CHAIN_PARAMS)).toEqual({ args: {}, warnings: [] });
  });

  it("args 为非对象标量：原样透传（类型校验责任在 args-validator，不发明约束）", () => {
    const r = normalizeArgsByMeta({ action: "run", name: "chain", args: "oops" }, CHAIN_PARAMS);
    expect(r.args).toBe("oops");
  });

  it("map-reduce oneOf 契约：oneOf 不参与键集（properties 才是键集来源——与 pi 等值）", () => {
    const { exact } = argKeysFromMeta(MAP_REDUCE_PARAMS);
    expect([...exact].sort()).toEqual(["agents", "items", "itemsJson", "operation"]);
  });
});
