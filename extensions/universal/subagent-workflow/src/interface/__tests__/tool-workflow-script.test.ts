/**
 * workflow-script tool 行为测试（generate / lint / list 三域合一；原三份拆分文件的
 * 全部用例与断言原样保留）。
 *
 * 三个被测域与断言形态：
 * - actionGenerate（m0 wave TC1-TC10 + [P-generate-roundtrip]；C5② 改接 core 管线）：
 *   五道闸校验 + tmp 写盘在 core generateWorkflowScript（barrel import）——验证宿主
 *   契约层（结构化结果 → execute-throw 转换、成功文案）+ 经真实 core 管线的校验行为
 *   回归。mock node:fs（mkdirSync/writeFileSync）避免真实落盘 .pi/workflows/.tmp/
 *   （builtin 模块 mock 对 core 管线内的写盘同样生效）；save/delete 走 barrel mock
 *   （importActual 展开覆写，其余 barrel 面（含 generateWorkflowScript）保持真实）。
 * - actionLint / actionList 黑盒输出测试（LLM 直接消费文本的形态锁）：findings 格式化
 *   文案（图标/行号/Suggestion 结构、Errors vs Warnings 标题）、not-found 建议清单与
 *   list 清单 item 行是 LLM 自纠错的唯一信息源。经注册层黑盒（capture tool +
 *   registry stub）断言锁 result.content 实际文本与 details 结构，不 mock lint 规则。
 *   finding/item 文案期望值逐字来自 core orchestration/script-lint.ts、
 *   orchestration/launcher.ts 的 formatAvailableWorkflowRefs 与 interface 层格式化
 *   （图标字节：✅ U+2705、❌ U+274C、⚠️ U+26A0+U+FE0F 带 variation selector——修改
 *   任一侧文案此测试即红，属预期锁定）。lint 规则本体走真实 core lintScript。
 * - execute 入口 abort 前置（P1-2）：aborted signal 下五个 action 全部早退，不触达
 *   registry / core barrel / 写盘（早退发生在任何副作用之前）。
 *
 * 共享基建：registry stub 统一为「get 按 name+available 解析、loadAll 全量返回」
 * 形态（list 域只触 loadAll，不消费 get，统一后行为不变）；每个用例经文件级
 * beforeEach vi.clearAllMocks 拿干净 mock 计数（abort 零触达断言依赖此）。框架：
 * vitest（禁 node:test）。
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { actionGenerate, type ScriptParams, type WorkflowScriptExecuteResult, registerWorkflowScriptTool } from "../tool-workflow-script.ts";
import { captureTool, type CapturedTool, type ScriptResultToolView } from "./capture-tool.ts";
import { deleteWorkflow, saveWorkflow } from "@zhushanwen/subagent-core";

// node:fs 只覆写两个写盘函数、其余保持真实——C5② 后被测链经 barrel 拉起完整 core
// 依赖图（importActual），core 模块对 existsSync/statSync 等的消费不能被 2 函数工厂截断
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// C5②：被测模块经 barrel 消费 save/delete/generateWorkflowScript——mock 挂 barrel，
// importActual 展开保持 generateWorkflowScript 真实（校验管线是被测回归面）
vi.mock("@zhushanwen/subagent-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zhushanwen/subagent-core")>()),
  saveWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
}));

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

// ── 注册层捕获 helper（fake pi 捕获单点见 capture-tool.ts，此处只留差异面）──

interface ScriptExecuteToolView extends CapturedTool { // oe-exempt:20260927:test 测试捕获 view 类型（非 ports 契约），单「实现」即测试本体
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<WorkflowScriptExecuteResult>;
}

/**
 * 捕获 workflow-script tool（registry 全量 stub：get/loadAll/invalidate——
 * abort 早退断言要求「零触达 registry」，stub 面必须覆盖全部三个读点）。
 */
function captureScriptExecuteTool(
  registry: Record<string, unknown> = { invalidate: vi.fn() },
): ScriptExecuteToolView {
  return captureTool<ScriptExecuteToolView>(
    (pi) => registerWorkflowScriptTool(pi as never, registry as never, () => false),
  );
}

/** registry stub（duck-typed WorkflowScriptRegistry——lint 只触 get/loadAll）。 */
function makeRegistry(scripts: Array<Record<string, unknown>>) {
  return {
    get: vi.fn((name: string) =>
      Promise.resolve(scripts.find((s) => s.name === name && s.available === true)),
    ),
    loadAll: vi.fn(() => Promise.resolve(scripts)),
    invalidate: vi.fn(),
  };
}

function captureScriptTool(registry: ReturnType<typeof makeRegistry>): ScriptResultToolView {
  return captureTool<ScriptResultToolView>(
    (pi) => registerWorkflowScriptTool(pi as never, registry as never, () => false),
    "workflow-script",
  );
}

/** 可用脚本 stub（loadScriptSource 经 registry.get 取 sourceCode）。 */
function makeScript(name: string, sourceCode: string) {
  return { name, source: "saved", path: `/abs/${name}.js`, sourceCode, available: true, meta: {} };
}

/** 清单脚本 stub（source 显式覆盖以覆盖 saved/tmp 两种标签形态）。 */
function makeListScript(name: string, source: "saved" | "tmp", description: string) {
  return { name, source, path: `/abs/${name}.js`, sourceCode: "// x", available: true, meta: { description } };
}

function lintCall(tool: ScriptResultToolView, name: string) {
  // ctx 传 {}（mode 非 rpc）→ details 不附加 __gui__，锁的是 pi 侧可见原始输出
  return tool.execute("id", { action: "lint", name }, undefined, undefined, {});
}

function listCall(tool: ScriptResultToolView) {
  return tool.execute("id", { action: "list" }, undefined, undefined, {});
}

function gen(script: string, name = "test-wf"): ScriptParams {
  return { action: "generate", name, script } as ScriptParams;
}

/** WorkflowScriptExecuteResult.text 在 content[0].text。 */
function textOf(r: WorkflowScriptExecuteResult): string {
  return r.content[0]?.text ?? "";
}

// ── generate 脚本 fixtures（按 core 校验闸逐项构造触发形态）──

const PI_META_VALID = `/* @pi-meta
name: test-wf
description: 合法新格式
phases: [a, b]
parameters:
  type: object
  properties:
    task: { type: string }
  required: [task]
*/
agent("worker", { task: $ARGS.task });
`;

const PI_META_MALFORMED = `/* @pi-meta
name: test-wf
description: bad
  broken: indent
phases: [a]
*/
agent("w");
`;

const PI_META_REGEX_SINGLE_BS = `/* @pi-meta
name: test-wf
description: regex
phases: [A]
parameters:
  type: object
  patternProperties:
    "^batch\\d+$": { type: string }
*/
agent("w");
`;

const LEGACY_CONST_META = `const meta = {
  name: test-wf,
  description: legacy,
  phases: ["a"]
};
agent("w");
`;

const NO_META = `agent("w");
`;

const ESM_IMPORT = `/* @pi-meta
name: x
description: d
phases: [a]
*/
import { foo } from "bar";
agent("w");
`;

const NO_AGENT = `/* @pi-meta
name: x
description: d
phases: [a]
*/
const x = 1;
`;

// ── lint 脚本 fixtures（按 core script-lint 检查项构造稳定触发形态）──

/** 合法脚本：有 agent() 入口 + 调用带 description → 0 findings。 */
const CLEAN_SCRIPT = [
  "const summary = await agent({",
  '  prompt: "Do the work",',
  '  description: "work-agent",',
  "});",
].join("\n");

/** 无任何编排入口 → 恰 1 个 error finding（line 0，行号稳定）。 */
const NO_ENTRY_SCRIPT = "const x = 1;";

/** agent() 调用缺 description/label → 恰 1 个 warning finding（line 1）。 */
const UNNAMED_AGENT_SCRIPT = 'await agent({ prompt: "work" });';

// 每用例干净 mock 计数：generate 写盘断言（toHaveBeenCalledTimes(1)）与 abort 零触达
// 断言（前序用例的 save/delete/generate 调用不留痕）共同依赖。
beforeEach(() => {
  vi.clearAllMocks();
});

describe("actionGenerate (m0: @pi-meta 认可 + round-trip)", () => {
  /**
   * W4b：generate 校验族错误路径从 return {isError:true} 改为 throw（pi 只对
   * execute throw 置 isError:true，返回值 isError 被 agent-loop 丢弃）。
   * actionGenerate 是同步函数——断言用同步 toThrow。
   */

  it("TC1: 合法 @pi-meta → ready + writeFileSync 被调用", () => {
    const r = actionGenerate(gen(PI_META_VALID));
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/ready|generated|test-wf/i);
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it("TC2: malformed @pi-meta YAML → throw + writeFileSync 未调用 [P-generate-roundtrip]", () => {
    expect(() => actionGenerate(gen(PI_META_MALFORMED))).toThrow(
      /cannot be parsed/i,
    );
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("TC3: legacy const meta（过渡期）→ ready + writeFileSync 被调用", () => {
    const r = actionGenerate(gen(LEGACY_CONST_META));
    expect(r.isError).toBeFalsy();
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it("TC4: 无 meta → throw 提及 @pi-meta 新格式", () => {
    expect(() => actionGenerate(gen(NO_META))).toThrow(/meta declaration/i);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("TC5: @pi-meta 单反斜杠正则 → throw（LLM 高频错）[P-generate-roundtrip]", () => {
    expect(() => actionGenerate(gen(PI_META_REGEX_SINGLE_BS))).toThrow(
      /escape|cannot be parsed/i,
    );
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("TC6: ESM import → throw（保留现有行为）", () => {
    expect(() => actionGenerate(gen(ESM_IMPORT))).toThrow(/ESM|import/i);
  });

  it("TC7: 无 agent() → throw（保留现有行为）", () => {
    expect(() => actionGenerate(gen(NO_AGENT))).toThrow(/agent\(\)/i);
  });

  // TC8（原 signal aborted 直调用例）已删：abort 前置上移到 execute 入口后，
  // actionGenerate 不再消费 signal——覆盖见下方「execute 入口 abort 前置」describe。

  it("TC9: 缺 name/script 参数 → throw 'generate requires'（防御性，schema 先拦）", () => {
    expect(() => actionGenerate({ action: "generate" } as ScriptParams)).toThrow(
      "generate requires 'name' and 'script' parameters",
    );
  });

  it("TC10: ESM export（非 meta）→ throw（W4b 收敛路径）", () => {
    const script = `/* @pi-meta
name: x
description: d
phases: [a]
*/
export const foo = 1;
agent("w");
`;
    expect(() => actionGenerate(gen(script))).toThrow(/ESM 'export'/i);
  });
});

describe("actionSave/actionDelete error paths (W4: throw 范式)", () => {
  /**
   * W4：save/delete 失败路径从 return {isError:true} 改为 throw——pi 只对 execute
   * throw 置 isError:true（agent-loop.js:453-483 丢弃返回值里的 isError）。
   * 经 registerWorkflowScriptTool 注册层测（mock workflow-files 的 FS 依赖）。
   */
  const ctx = { mode: "tui" as const, hasUI: true };

  it("save 失败 → throw 'Save failed: <原因>'（pi catch 后置 isError:true）", async () => {
    vi.mocked(saveWorkflow).mockRejectedValueOnce(new Error("disk full"));
    const tool = captureScriptExecuteTool();
    await expect(
      tool.execute("id", { action: "save", name: "tmp-wf" }, undefined, undefined, ctx),
    ).rejects.toThrow("Save failed: disk full");
  });

  it("delete 失败 → throw 'Delete failed: <原因>'", async () => {
    // deleteWorkflow 是同步函数——mock 用同步 throw（mockRejectedValue 不会被
    // actionDelete 的同步 try/catch 捕获）
    vi.mocked(deleteWorkflow).mockImplementationOnce(() => {
      throw new Error("script is running");
    });
    const tool = captureScriptExecuteTool();
    await expect(
      tool.execute("id", { action: "delete", name: "tmp-wf" }, undefined, undefined, ctx),
    ).rejects.toThrow("Delete failed: script is running");
  });

  it("save 成功路径不受影响（ok details 正常返回）", async () => {
    vi.mocked(saveWorkflow).mockResolvedValueOnce("saved tmp-wf");
    const tool = captureScriptExecuteTool();
    const r = await tool.execute("id", { action: "save", name: "tmp-wf" }, undefined, undefined, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.details).toMatchObject({ action: "save", name: "tmp-wf", ok: true });
  });
});

describe("execute 入口 abort 前置（P1-2：与 workflow / subagents 两 tool 对称）", () => {
  /**
   * abort 检查此前只在 generate（actionGenerate 内）存在，lint/save/delete/list
   * 四路径漏拦——已统一上移到 execute 入口（tool-shared assertNotAborted 同源）。
   * 黑盒断言：aborted signal 下五个 action 全部早退，且不触达 registry / core
   * barrel / 写盘（早退发生在任何副作用之前）。
   */

  const ctx = { mode: "tui" as const, hasUI: true };
  /** 各 action 的最小合法入参（generate 给齐 name+script：守卫失效时会走完真实 core 管线并写盘，零触达断言随之红）。 */
  const ACTION_PARAMS: Record<string, Record<string, unknown>> = {
    generate: { action: "generate", name: "test-wf", script: "// s" },
    lint: { action: "lint", name: "test-wf" },
    save: { action: "save", name: "test-wf" },
    delete: { action: "delete", name: "test-wf" },
    list: { action: "list" },
  };

  it.each(Object.keys(ACTION_PARAMS))(
    "action:%s → throw 'Operation aborted before start'，registry/core 管线零触达",
    async (action) => {
      const registry = {
        get: vi.fn(),
        loadAll: vi.fn(),
        invalidate: vi.fn(),
      };
      const tool = captureScriptExecuteTool(registry);
      await expect(
        tool.execute("id", ACTION_PARAMS[action], AbortSignal.abort(), undefined, ctx),
      ).rejects.toThrow("Operation aborted before start");
      expect(registry.get).not.toHaveBeenCalled();
      expect(registry.loadAll).not.toHaveBeenCalled();
      expect(registry.invalidate).not.toHaveBeenCalled();
      expect(mockedWriteFileSync).not.toHaveBeenCalled(); // generate 的 tmp 写盘未发生
      expect(vi.mocked(saveWorkflow)).not.toHaveBeenCalled();
      expect(vi.mocked(deleteWorkflow)).not.toHaveBeenCalled();
    },
  );
});

describe("actionLint 输出形态（LLM 可见文本锁）", () => {
  it("0 findings → ✅ 单行文案，无 details、无 isError", async () => {
    const registry = makeRegistry([makeScript("clean-wf", CLEAN_SCRIPT)]);
    const tool = captureScriptTool(registry);
    const r = await lintCall(tool, "clean-wf");
    expect(registry.get).toHaveBeenCalledWith("clean-wf");
    expect(r.content).toEqual([{ type: "text", text: "✅ No issues found in 'clean-wf'." }]);
    expect(r.details).toBeUndefined();
    expect(r.isError).toBeUndefined();
  });

  it("error finding → ❌ 行 + Suggestion 缩进续行 + Errors 标题，details/isError 结构化", async () => {
    const registry = makeRegistry([makeScript("no-entry-wf", NO_ENTRY_SCRIPT)]);
    const tool = captureScriptTool(registry);
    const r = await lintCall(tool, "no-entry-wf");
    expect(r.content).toEqual([
      {
        type: "text",
        text:
          "Errors found in 'no-entry-wf':\n\n" +
          "❌ L0: Workflow script must call agent(), parallel(), or pipeline() at least once.\n" +
          "   Suggestion: Add at least one agent(), parallel(), or pipeline() invocation.",
      },
    ]);
    expect(r.details).toEqual({
      action: "lint",
      name: "no-entry-wf",
      valid: false,
      findingCount: 1,
    });
    expect(r.isError).toBe(true);
  });

  it("warning-only finding（agent 缺 description）→ ⚠️ 行 + Warnings 标题，isError=false 不拦截", async () => {
    const registry = makeRegistry([makeScript("unnamed-wf", UNNAMED_AGENT_SCRIPT)]);
    const tool = captureScriptTool(registry);
    const r = await lintCall(tool, "unnamed-wf");
    expect(r.content).toEqual([
      {
        type: "text",
        text:
          "Warnings found in 'unnamed-wf':\n\n" +
          "⚠️ L1: agent() call without `description` (or `label`) will show as '(unnamed)' in TUI.\n" +
          "   Suggestion: Add `description: 'kebab-case-name'` to agent() opts for readable /workflows display.",
      },
    ]);
    expect(r.details).toEqual({ action: "lint", name: "unnamed-wf", valid: true, findingCount: 1 });
    expect(r.isError).toBe(false);
  });

  it("name 不存在 → throw 完整 not-found 文案，清单走 core 拒单格式（含 location 行，不可用项剔除）", async () => {
    const registry = makeRegistry([
      { ...makeScript("broken-wf", "// x"), available: false, meta: { description: "解析失败" } },
      { ...makeScript("clean-scripts", "// x"), meta: { description: "remove stale tmp scripts" } },
    ]);
    const tool = captureScriptTool(registry);
    // 全文精确匹配（toBe）——同时锁定 item 行 = core formatAvailableWorkflowRefs
    // 缺省形态（与 run 拒单有意统一，带 location 行）与不可用项剔除（broken-wf 零出现）
    const err = (await lintCall(tool, "ghost-wf").catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(
      "Workflow 'ghost-wf' not found or not available.\n" +
        "Available:\n" +
        "  - clean-scripts: remove stale tmp scripts\n" +
        "    location: /abs/clean-scripts.js",
    );
  });

  it("name 不存在且无可用脚本 → 建议清单降级为 (none)", async () => {
    const registry = makeRegistry([]);
    const tool = captureScriptTool(registry);
    await expect(lintCall(tool, "ghost-wf")).rejects.toThrow(
      "Workflow 'ghost-wf' not found or not available.\nAvailable:\n  (none)",
    );
  });
});

// ── GUI attach（RPC 模式分发；attach 实现单点在 tool-shared withGuiAttach）──

describe("actionLint GUI attach（execute 级 RPC/非 RPC 分发）", () => {
  /** details 的 __gui__ 投影形态（协议 GuiRenderResult 的断言子集）。 */
  type GuiProjection = { __gui__?: { component?: { type?: string; props?: { items?: Array<{ label?: string; value?: string }> } } } };

  it("RPC ctx → details 附带 __gui__（lint findings → stats-line warn）", async () => {
    const registry = makeRegistry([makeScript("no-entry-wf", NO_ENTRY_SCRIPT)]);
    const tool = captureScriptTool(registry);
    const r = await tool.execute("id", { action: "lint", name: "no-entry-wf" }, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
    });
    const gui = (r.details as GuiProjection).__gui__;
    expect(gui).toBeDefined();
    expect(gui?.component?.type).toBe("stats-line");
    expect(gui?.component?.props?.items).toEqual([{ label: "lint", value: "1 findings", severity: "warn" }]);
  });

  it("RPC ctx + 纯文本结果（details undefined）→ details 保持 undefined", async () => {
    const registry = makeRegistry([makeScript("clean-wf", CLEAN_SCRIPT)]);
    const tool = captureScriptTool(registry);
    const r = await tool.execute("id", { action: "lint", name: "clean-wf" }, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
    });
    expect(r.details).toBeUndefined();
  });

  it("非 RPC ctx（lintCall 既有形态）→ details 无 __gui__", async () => {
    const registry = makeRegistry([makeScript("no-entry-wf", NO_ENTRY_SCRIPT)]);
    const tool = captureScriptTool(registry);
    const r = await lintCall(tool, "no-entry-wf");
    expect((r.details as GuiProjection).__gui__).toBeUndefined();
  });
});

describe("actionList 输出形态（LLM 可见文本锁）", () => {
  it("非空清单 → 标题 + core formatter item 行（[source] 标签 + ':' 分隔 + 无 location 行）+ details 计数", async () => {
    const registry = makeRegistry([
      makeListScript("deploy-wf", "saved", "deploy the app"),
      makeListScript("scratch-wf", "tmp", "one-off scratch task"),
    ]);
    const tool = captureScriptTool(registry);
    const r = await listCall(tool);
    expect(registry.loadAll).toHaveBeenCalledOnce();
    expect(r.content).toEqual([
      {
        type: "text",
        text:
          "Available workflows:\n" +
          "  - [saved] deploy-wf: deploy the app\n" +
          "  - [tmp] scratch-wf: one-off scratch task",
      },
    ]);
    expect(r.details).toEqual({ action: "list", count: 2 });
    expect(r.isError).toBeUndefined();
  });

  it("不可用项剔除：available=false 不进清单，count 只计可用项", async () => {
    const registry = makeRegistry([
      makeListScript("deploy-wf", "saved", "deploy the app"),
      { ...makeListScript("broken-wf", "saved", "解析失败"), available: false },
    ]);
    const tool = captureScriptTool(registry);
    const r = await listCall(tool);
    expect(r.content).toEqual([
      { type: "text", text: "Available workflows:\n  - [saved] deploy-wf: deploy the app" },
    ]);
    expect(r.details).toEqual({ action: "list", count: 1 });
  });

  it("description 缺省 → (no description) 占位（core formatter 行为透传）", async () => {
    const registry = makeRegistry([makeListScript("bare-wf", "saved", "")]);
    const tool = captureScriptTool(registry);
    const r = await listCall(tool);
    expect(r.content).toEqual([
      { type: "text", text: "Available workflows:\n  - [saved] bare-wf: (no description)" },
    ]);
  });

  it("空清单（无任何脚本）→ 空态单行文案，无 details、无 isError", async () => {
    const registry = makeRegistry([]);
    const tool = captureScriptTool(registry);
    const r = await listCall(tool);
    expect(r.content).toEqual([{ type: "text", text: "No workflow scripts available." }]);
    expect(r.details).toBeUndefined();
    expect(r.isError).toBeUndefined();
  });

  it("全不可用清单 → 同空态文案（available filter 后为空）", async () => {
    const registry = makeRegistry([{ ...makeListScript("broken-wf", "saved", "x"), available: false }]);
    const tool = captureScriptTool(registry);
    const r = await listCall(tool);
    expect(r.content).toEqual([{ type: "text", text: "No workflow scripts available." }]);
  });
});

// ── GUI attach（RPC 模式分发；list 的 GUI 投影 = scripts 计数 stats-line）──

describe("actionList GUI attach（execute 级 RPC/非 RPC 分发）", () => {
  type GuiProjection = { __gui__?: { component?: { type?: string; props?: { items?: Array<{ label?: string; value?: string; severity?: string }> } } } };

  it("RPC ctx → details 附带 __gui__（list → scripts 计数 stats-line）", async () => {
    const registry = makeRegistry([makeListScript("deploy-wf", "saved", "deploy the app")]);
    const tool = captureScriptTool(registry);
    const r = await tool.execute("id", { action: "list" }, undefined, undefined, {
      mode: "rpc",
      hasUI: true,
    });
    const gui = (r.details as GuiProjection).__gui__;
    expect(gui).toBeDefined();
    expect(gui?.component?.type).toBe("stats-line");
    expect(gui?.component?.props?.items).toEqual([{ label: "scripts", value: "1", severity: "ok" }]);
  });

  it("非 RPC ctx → details 无 __gui__（原始 details 结构保留）", async () => {
    const registry = makeRegistry([makeListScript("deploy-wf", "saved", "deploy the app")]);
    const tool = captureScriptTool(registry);
    const r = await listCall(tool);
    expect((r.details as GuiProjection).__gui__).toBeUndefined();
    expect(r.details).toEqual({ action: "list", count: 1 });
  });
});
