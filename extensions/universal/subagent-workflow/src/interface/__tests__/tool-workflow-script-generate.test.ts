/**
 * actionGenerate 行为测试（m0 wave / TC1-TC7 + [P-generate-roundtrip]；C5② 改接 core 管线）
 *
 * C5② 起五道闸校验 + tmp 写盘在 core generateWorkflowScript（barrel import）——本测试
 * 验证宿主契约层（结构化结果 → execute-throw 转换、signal aborted、成功文案）+ 经
 * 真实 core 管线的校验行为回归。
 *
 * mock node:fs（mkdirSync/writeFileSync）避免真实落盘 .pi/workflows/.tmp/（builtin
 * 模块 mock 对 core 管线内的写盘同样生效）。save/delete 走 barrel mock（importActual
 * 展开覆写，其余 barrel 面（含 generateWorkflowScript）保持真实）。
 *
 * 框架：vitest（禁 node:test）。
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { actionGenerate, type ScriptParams, type WorkflowScriptExecuteResult, registerWorkflowScriptTool } from "../tool-workflow-script.ts";
import { captureTool, type CapturedTool } from "./capture-tool.ts";
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

function gen(script: string, name = "test-wf"): ScriptParams {
  return { action: "generate", name, script } as ScriptParams;
}

/** WorkflowScriptExecuteResult.text 在 content[0].text。 */
function textOf(r: WorkflowScriptExecuteResult): string {
  return r.content[0]?.text ?? "";
}

// ── 注册层捕获 helper（fake pi 捕获单点见 capture-tool.ts，此处只留差异面）──

interface ScriptExecuteToolView extends CapturedTool {
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
const agent = require("./agent");
agent("worker", { task: $ARGS.task });
`;

const PI_META_MALFORMED = `/* @pi-meta
name: test-wf
description: bad
  broken: indent
phases: [a]
*/
const agent = require("./agent");
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
const agent = require("./agent");
agent("w");
`;

const LEGACY_CONST_META = `const meta = {
  name: test-wf,
  description: legacy,
  phases: ["a"]
};
const agent = require("./agent");
agent("w");
`;

const NO_META = `const agent = require("./agent");
agent("w");
`;

const ESM_IMPORT = `/* @pi-meta
name: x
description: d
phases: [a]
*/
import { foo } from "bar";
const agent = require("./agent");
agent("w");
`;

const NO_AGENT = `/* @pi-meta
name: x
description: d
phases: [a]
*/
const x = 1;
`;

describe("actionGenerate (m0: @pi-meta 认可 + round-trip)", () => {
  beforeEach(() => {
    mockedWriteFileSync.mockClear();
    mockedMkdirSync.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

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
const agent = require("./agent");
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
  // 零触达断言依赖干净计数：前序 describe（save/delete 成功路径）的调用不留痕
  beforeEach(() => {
    vi.clearAllMocks();
  });
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
