// tool-workflow-script.test.ts —— subagent-workflow C16 簇合并产物（round5-G）。
// 共同被测业务模块：`src/interface/tool/tool-workflow-script.ts`。mock 相容：单侧 mock @zhushanwen/subagent-core、node:fs——合并后 mock 全文件生效，未 mock 方用例经产物自检全绿核对。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/gui.test.ts（29 用例，skip 0）
//   - src/interface/tool/__tests__/tool-workflow-script.test.ts（38 用例，skip 0）

import { type GuiContext } from '@zhushanwen/extension-protocol'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mapRunIcon, mapRunStatus, toGuiCtx } from '../interface/gui/gui-mappers.ts'
import { adapter, buildGuiComponent, type AdapterInput } from '../interface/gui/subagent-actions.ts'
import { buildScriptGui, type WorkflowScriptToolDetails, actionGenerate, buildScriptSummary, type ScriptParams, type WorkflowScriptExecuteResult, registerWorkflowScriptTool } from '../interface/tool/tool-workflow-script.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { captureTool, type CapturedTool, type ScriptResultToolView } from '../interface/tool/__tests__/capture-tool.ts'
import { deleteWorkflow, saveWorkflow } from '@zhushanwen/subagent-core'

// node:fs 只覆写两个写盘函数、其余保持真实——C5② 后被测链经 barrel 拉起完整 core
// 依赖图（importActual），core 模块对 existsSync/statSync 等的消费不能被 2 函数工厂截断
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
// C5②：被测模块经 barrel 消费 save/delete/generateWorkflowScript——mock 挂 barrel，
// importActual 展开保持 generateWorkflowScript 真实（校验管线是被测回归测试）
vi.mock("@zhushanwen/subagent-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zhushanwen/subagent-core")>()),
  saveWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
}));

// ======== 来源：gui.test.ts ========
describe("gui", () => {
  // ============================================================
  // mapRunStatus / mapRunIcon —— 子代理执行状态（ExecutionStatus）→ 三态 + 图标
  //
  // [§2.2 入参域纠正] 此前用例喂的是 workflow run 词表（done/completed/failed/
  // aborted/cancelled/crashed/error/budget_limited/time_limited + 大写 + 子串拼接），
  // 而唯一生产调用方（subagent-actions.ts）传的是 SubagentListItem.status =
  // ExecutionStatus（running|idle）——那一整张关键词表在生产不可达。收窄入参后按域内
  // 两值断言；「未知词表」这类断言随之删除（类型层面已不可表达）。
  // ============================================================

  describe("mapRunStatus", () => {
    it.each([
      ["running", "running"],
      ["idle", "done"],
    ] as const)("%s → %s", (status, expected) => {
      expect(mapRunStatus(status)).toBe(expected);
    });
  });

  describe("mapRunIcon", () => {
    it.each([
      ["running", "circle"],
      ["idle", "check"],
    ] as const)("%s → %s", (status, expected) => {
      expect(mapRunIcon(status)).toBe(expected);
    });
  });

  // ============================================================
  // toGuiCtx —— ExtensionContext → GuiContext 最小子集
  // ============================================================

  describe("toGuiCtx", () => {
    it("undefined → undefined（无 ctx 时返回 undefined，不构造空对象）", () => {
      expect(toGuiCtx(undefined)).toBeUndefined();
    });

    it("rpc 模式 → 正确提取 mode + hasUI", () => {
      const result = toGuiCtx({ mode: "rpc", hasUI: false });
      expect(result).toEqual({ mode: "rpc", hasUI: false });
    });

    it("tui 模式 → 正确透传", () => {
      const result = toGuiCtx({ mode: "tui", hasUI: true });
      expect(result).toEqual({ mode: "tui", hasUI: true });
    });

    it("返回对象只有 mode/hasUI 两键（不泄漏 ui 引用）", () => {
      const result = toGuiCtx({ mode: "rpc", hasUI: true });
      expect(Object.keys(result!)).toEqual(["mode", "hasUI"]);
    });
  });

  // ============================================================
  // buildGuiComponent —— subagent adapter 的 GUI 构造
  // ============================================================
  //
  // AdapterInput 是 start/list/cancel/message/close 五成员联合，构造对象字面量即可
  // （不需 mock SubagentService）。start 分支返回 card(stats-line)，list 分支返回
  // list-tree，cancel/message/close 分支返回 stats-line。

  describe("buildGuiComponent", () => {
    describe("action: start", () => {
      it("返回 card 组件，header 为 slug（身份信息），body 含 stats-line", () => {
        const comp = buildGuiComponent(
          {
            action: "start",
            domain: {
              kind: "bg",
              subagentId: "sub-001",
              sessionFile: "session.jsonl",
              slug: "review",
              response: { status: "running", mode: "background", message: "detached" },
            },
          },
          // _result 未被 start 分支使用，传最小满足联合的值
          {
            action: "start",
            subagentId: "sub-001",
            sessionFile: "session.jsonl",
            slug: "review",
            bgResponse: { status: "running", mode: "background", message: "detached" },
          },
        );

        expect(comp.type).toBe("card");
        const props = comp.props as { header: string; body: Array<{ type: string; props: { items: Array<{ severity: string }> } }> };
        // S#1: header 用 slug 作为身份标识（非硬编码 "subagent"），并发 subagent 可区分
        expect(props.header).toBe("review");
        expect(props.body).toHaveLength(1);
        expect(props.body[0].type).toBe("stats-line");
        expect(props.body[0].props.items[0].severity).toBe("ok");
      });
    });

    describe("action: list", () => {
      it("返回 list-tree，items 的 status/icon 按 SubagentListItem.status 正确映射", () => {
        const comp = buildGuiComponent(
          {
            action: "list",
            domain: {
              response: {
                running: 1,
                items: [
                  {
                    subagentId: "sub-running",
                    agent: "coder",
                    slug: "feat-a",
                    status: "running",
                    mode: "background",
                    duration: 10,
                    model: "gpt-4",
                    totalTokens: 100,
                  },
                  {
                    subagentId: "sub-idle",
                    agent: "reviewer",
                    slug: "",
                    // [§2.2 入参域纠正] 子代理执行状态只有 running|idle——旧 fixture 用
                    // done/failed（workflow 词表），那是 mapRunStatus 收窄掉的死分支。
                    status: "idle",
                    mode: "background",
                    duration: 20,
                    model: "gpt-4",
                    totalTokens: 200,
                  },
                  {
                    subagentId: "sub-idle-2",
                    agent: "tester",
                    slug: "ci",
                    status: "idle",
                    mode: "background",
                    duration: 5,
                    model: "gpt-4",
                    totalTokens: 50,
                  },
                ],
              },
            },
          },
          { action: "list", subagentId: null, sessionFile: null, listResponse: { running: 1, items: [] } },
        );

        expect(comp.type).toBe("list-tree");
        const props = comp.props as { items: Array<{ label: string; status: string; icon: string }> };
        expect(props.items).toHaveLength(3);

        // running → running / circle
        expect(props.items[0].status).toBe("running");
        expect(props.items[0].icon).toBe("circle");
        // 含 slug 时 label 格式 "agent · slug · subagentId"
        expect(props.items[0].label).toBe("coder · feat-a · sub-running");

        // idle → done / check（空闲 = 无进行中工作）
        expect(props.items[1].status).toBe("done");
        expect(props.items[1].icon).toBe("check");
        // 无 slug（空串）时 label 格式 "agent · subagentId"
        expect(props.items[1].label).toBe("reviewer · sub-idle");

        // idle（带 slug）→ 同映射；标签格式 "agent · slug · subagentId"
        expect(props.items[2].status).toBe("done");
        expect(props.items[2].icon).toBe("check");
        expect(props.items[2].label).toBe("tester · ci · sub-idle-2");
      });

      it("空 items → list-tree with empty items", () => {
        const comp = buildGuiComponent(
          { action: "list", domain: { response: { running: 0, items: [] } } },
          { action: "list", subagentId: null, sessionFile: null, listResponse: { running: 0, items: [] } },
        );

        expect(comp.type).toBe("list-tree");
        const props = comp.props as { items: unknown[] };
        expect(props.items).toEqual([]);
      });
    });

    describe("action: cancel", () => {
      it("返回 stats-line，含 cancelled 标签 + subagentId（severity warn）", () => {
        const comp = buildGuiComponent(
          {
            action: "cancel",
            domain: {
              subagentId: "sub-002",
              response: { cancelled: true },
            },
          },
          {
            action: "cancel",
            subagentId: "sub-002",
            sessionFile: null,
            cancelResponse: { cancelled: true },
          },
        );

        expect(comp.type).toBe("stats-line");
        const props = comp.props as { items: Array<{ label: string; value: string; severity: string }> };
        expect(props.items).toHaveLength(1);
        expect(props.items[0].label).toBe("cancelled");
        expect(props.items[0].value).toBe("sub-002");
        expect(props.items[0].severity).toBe("warn");
      });
    });

    describe("action: message", () => {
      it("返回 stats-line，含 messaged 标签 + subagentId（severity ok）", () => {
        const comp = buildGuiComponent(
          {
            action: "message",
            domain: {
              kind: "message",
              subagentId: "sub-003",
              response: { delivered: true },
            },
          },
          {
            action: "message",
            subagentId: "sub-003",
            sessionFile: null,
            messageResponse: { delivered: true },
          },
        );

        expect(comp.type).toBe("stats-line");
        const props = comp.props as { items: Array<{ label: string; value: string; severity: string }> };
        expect(props.items).toHaveLength(1);
        expect(props.items[0].label).toBe("messaged");
        expect(props.items[0].value).toBe("sub-003");
        expect(props.items[0].severity).toBe("ok");
      });
    });

    describe("action: close", () => {
      it("返回 stats-line，含 closed 标签 + subagentId（severity warn）", () => {
        const comp = buildGuiComponent(
          {
            action: "close",
            domain: {
              kind: "close",
              subagentId: "sub-004",
              response: { closed: true },
            },
          },
          {
            action: "close",
            subagentId: "sub-004",
            sessionFile: null,
            closeResponse: { closed: true },
          },
        );

        expect(comp.type).toBe("stats-line");
        const props = comp.props as { items: Array<{ label: string; value: string; severity: string }> };
        expect(props.items).toHaveLength(1);
        expect(props.items[0].label).toBe("closed");
        expect(props.items[0].value).toBe("sub-004");
        expect(props.items[0].severity).toBe("warn");
      });
    });

    describe("action: fork-from", () => {
      it("返回 stats-line：forked-from（继承源 session 路径）+ new subagent（severity ok）", () => {
        const comp = buildGuiComponent(
          {
            action: "fork-from",
            domain: {
              kind: "fork-from",
              subagentId: "sub-005",
              sourceSessionFile: "/abs/sessions/source.jsonl",
              response: { newSubagentId: "sub-005", sourceSessionFile: "/abs/sessions/source.jsonl" },
            },
          },
          {
            action: "fork-from",
            subagentId: "sub-005",
            sessionFile: null,
            forkFromResponse: { newSubagentId: "sub-005", sourceSessionFile: "/abs/sessions/source.jsonl" },
          },
        );

        expect(comp.type).toBe("stats-line");
        const props = comp.props as { items: Array<{ label: string; value: string; severity?: string }> };
        expect(props.items).toHaveLength(2);
        // 源路径直出（input.domain.sourceSessionFile），供 GUI 侧定位继承源
        expect(props.items[0].label).toBe("forked-from");
        expect(props.items[0].value).toBe("/abs/sessions/source.jsonl");
        expect(props.items[1].label).toBe("new subagent");
        expect(props.items[1].value).toBe("sub-005");
        expect(props.items[1].severity).toBe("ok");
      });
    });
  });

  // ============================================================
  // adapter —— ctx.mode 分发契约（S6）
  // ============================================================
  //
  // sdk-contract.test.ts 只覆盖 ctx.model 透传；此处补 ctx.mode 的 __gui__ 附加分发：
  // adapter() 是纯函数，ctx.mode === "rpc" → details.__gui__ 被附加，
  // ctx.mode === "tui"/"json"/"print" → details.__gui__ 为 undefined。

  function makeStartInput(): AdapterInput {
    return {
      action: "start",
      domain: {
        subagentId: "test-id",
        sessionFile: "/test/session.jsonl",
        slug: "test-slug",
        response: { status: "started" },
      },
    } as unknown as AdapterInput;
  }

  describe("S6: ctx.mode dispatches __gui__ output correctly", () => {
    it("ctx.mode=rpc → details.__gui__ is populated", () => {
      const ctx = { mode: "rpc", hasUI: true } as GuiContext;
      const result = adapter(makeStartInput(), ctx);
      expect(result.details).toHaveProperty("__gui__");
      expect(result.details.__gui__).toBeDefined();
    });

    it("ctx.mode=tui → details.__gui__ is undefined (TUI renders differently)", () => {
      const ctx = { mode: "tui", hasUI: true } as GuiContext;
      const result = adapter(makeStartInput(), ctx);
      expect(result.details.__gui__).toBeUndefined();
    });

    it("ctx.mode=json → details.__gui__ is undefined (headless)", () => {
      const ctx = { mode: "json", hasUI: false } as GuiContext;
      const result = adapter(makeStartInput(), ctx);
      expect(result.details.__gui__).toBeUndefined();
    });

    it("ctx.mode=print → details.__gui__ is undefined (headless)", () => {
      const ctx = { mode: "print", hasUI: false } as GuiContext;
      const result = adapter(makeStartInput(), ctx);
      expect(result.details.__gui__).toBeUndefined();
    });

    it("ctx=undefined → details.__gui__ is undefined (backward compat)", () => {
      const result = adapter(makeStartInput(), undefined);
      expect(result.details.__gui__).toBeUndefined();
    });
  });

  // ============================================================
  // buildScriptGui —— workflow script tool details 的 GUI 构造
  // ============================================================
  //
  // 覆盖 5 个 action 分支（generate/lint/list/save/delete），验证各分支产出的
  // stats-line 结构：component.type、item.label/value/severity。

  describe("buildScriptGui — generate", () => {
    it("产出 stats-line，severity ok，value 为脚本名", () => {
      const details: WorkflowScriptToolDetails = {
        action: "generate",
        path: "/tmp/test.js",
        name: "my-workflow",
        status: "ready",
      };
      const gui = buildScriptGui(details);
      expect(gui.type).toBe("stats-line");
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe("generated");
      expect(items[0].value).toBe("my-workflow");
      expect(items[0].severity).toBe("ok");
    });
  });

  describe("buildScriptGui — lint", () => {
    it("valid=true → value passed, severity ok", () => {
      const details: WorkflowScriptToolDetails = {
        action: "lint",
        name: "clean-script",
        valid: true,
        findingCount: 0,
      };
      const gui = buildScriptGui(details);
      expect(gui.type).toBe("stats-line");
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items[0].label).toBe("lint");
      expect(items[0].value).toBe("passed");
      expect(items[0].severity).toBe("ok");
    });

    it("valid=false → value N findings, severity warn", () => {
      const details: WorkflowScriptToolDetails = {
        action: "lint",
        name: "buggy-script",
        valid: false,
        findingCount: 3,
      };
      const gui = buildScriptGui(details);
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items[0].value).toBe("3 findings");
      expect(items[0].severity).toBe("warn");
    });
  });

  describe("buildScriptGui — list", () => {
    it("value 为脚本数量字符串，severity ok", () => {
      const details: WorkflowScriptToolDetails = {
        action: "list",
        count: 5,
      };
      const gui = buildScriptGui(details);
      expect(gui.type).toBe("stats-line");
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items[0].label).toBe("scripts");
      expect(items[0].value).toBe("5");
      expect(items[0].severity).toBe("ok");
    });

    it("count=0 → value 0（空列表仍产出 stats-line）", () => {
      const details: WorkflowScriptToolDetails = {
        action: "list",
        count: 0,
      };
      const gui = buildScriptGui(details);
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items[0].value).toBe("0");
    });
  });

  describe("buildScriptGui — save", () => {
    it("ok=true → severity ok", () => {
      const details: WorkflowScriptToolDetails = {
        action: "save",
        name: "promoted-script",
        ok: true,
      };
      const gui = buildScriptGui(details);
      expect(gui.type).toBe("stats-line");
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items[0].label).toBe("save");
      expect(items[0].value).toBe("promoted-script");
      expect(items[0].severity).toBe("ok");
    });

    it("ok=false → severity warn", () => {
      const details: WorkflowScriptToolDetails = {
        action: "save",
        name: "failed-save",
        ok: false,
      };
      const gui = buildScriptGui(details);
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items[0].severity).toBe("warn");
    });
  });

  describe("buildScriptGui — delete", () => {
    it("ok=true → severity ok", () => {
      const details: WorkflowScriptToolDetails = {
        action: "delete",
        name: "removed-script",
        ok: true,
      };
      const gui = buildScriptGui(details);
      expect(gui.type).toBe("stats-line");
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items[0].label).toBe("delete");
      expect(items[0].value).toBe("removed-script");
      expect(items[0].severity).toBe("ok");
    });

    it("ok=false → severity warn", () => {
      const details: WorkflowScriptToolDetails = {
        action: "delete",
        name: "locked-script",
        ok: false,
      };
      const gui = buildScriptGui(details);
      const items = gui.props.items as Array<{ label: string; value: string; severity: string }>;
      expect(items[0].severity).toBe("warn");
    });
  });
});

// ======== 来源：tool-workflow-script.test.ts ========
describe("tool-workflow-script", () => {
  const mockedWriteFileSync = vi.mocked(writeFileSync);

  const mockedMkdirSync = vi.mocked(mkdirSync);

  // ── 注册层捕获 helper（fake pi 捕获单点见 capture-tool.ts，此处只留差异点）──

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
      "workflow_script",
    );
  }

  /** 可用脚本 stub（loadScriptSource 经 registry.get 取 sourceCode）。 */
  function makeScript(name: string, sourceCode: string) {
    return { name, source: "saved", path: `/abs/${name}.js`, sourceCode, available: true, meta: {} };
  }

  // exposure 注册终态锚（C-ext-05，2026-10-23 ADR-0136）：workflow-script direct 常驻 =
  // 注册时不写 exposure 字段（SDK 缺省 direct，pi-semantics PS-91）——误写 "deferred" 会把
  // workflow-script 从模型默认可见集收走（tool_search 才可激活），此处红。
  describe("workflow-script exposure 注册终态（C-ext-05）", () => {
    it("direct 常驻：不写 exposure 字段（SDK 缺省 direct）", () => {
      const tool = captureScriptExecuteTool();
      expect(tool.name).toBe("workflow_script");
      expect(tool.exposure).toBeUndefined();
    });
  });

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
   * W4：save/delete 失败路径从 return {isError:true} 改为 throw——execute throw →
   * pi agent-loop catch 置 isError:true（pi-agent-core dist/agent-loop.js
   * executePreparedToolCall，1.0.0 实读 catch :581-588；1.0.0 起正常 return 的
   * isError 也被尊重——:579 isError: result.isError === true，0.84.4 才硬编码
   * false——本包失败恒走 throw，行为不变）。
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
    /** 各 action 的最小合法入参（generate 给齐 name+script：检查失效时会走完真实 core 管线并写盘，零触达断言随之红）。 */
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
    it("0 findings → ✅ 单行文案，summary-only details、无 isError", async () => {
      const registry = makeRegistry([makeScript("clean-wf", CLEAN_SCRIPT)]);
      const tool = captureScriptTool(registry);
      const r = await lintCall(tool, "clean-wf");
      expect(registry.get).toHaveBeenCalledWith("clean-wf");
      expect(r.content).toEqual([{ type: "text", text: "✅ No issues found in 'clean-wf'." }]);
      expect(r.details).toEqual({ summary: "Script clean-wf linted: 0 issues" });
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
        summary: "Script no-entry-wf linted: 1 findings",
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
      expect(r.details).toEqual({
        action: "lint",
        name: "unnamed-wf",
        valid: true,
        findingCount: 1,
        summary: "Script unnamed-wf linted: passed",
      });
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
    /** details 的 __gui__ 派生视图形态（协议 GuiRenderResult 的断言子集）。 */
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

    it("RPC ctx + summary-only details（lint 0 findings）→ stats-line 展示摘要（原 undefined 无 GUI 块的形态随 details.summary 化升级）", async () => {
      const registry = makeRegistry([makeScript("clean-wf", CLEAN_SCRIPT)]);
      const tool = captureScriptTool(registry);
      const r = await tool.execute("id", { action: "lint", name: "clean-wf" }, undefined, undefined, {
        mode: "rpc",
        hasUI: true,
      });
      const details = r.details as { summary?: string; __gui__?: { component?: { type?: string; props?: { items?: Array<{ label?: string; value?: string; severity?: string }> } } } };
      expect(details.summary).toBe("Script clean-wf linted: 0 issues");
      expect(details.__gui__?.component?.type).toBe("stats-line");
      expect(details.__gui__?.component?.props?.items).toEqual([
        { label: "done", value: "Script clean-wf linted: 0 issues", severity: "ok" },
      ]);
    });

    it("非 RPC ctx + 纯文本结果（summary-only details）→ details 只带 summary、无 __gui__", async () => {
      const registry = makeRegistry([makeScript("clean-wf", CLEAN_SCRIPT)]);
      const tool = captureScriptTool(registry);
      const r = await lintCall(tool, "clean-wf");
      expect(r.details).toEqual({ summary: "Script clean-wf linted: 0 issues" });
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
      expect(r.details).toEqual({
        action: "list",
        count: 2,
        summary: "Listed 2 workflow scripts",
      });
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
      expect(r.details).toEqual({
        action: "list",
        count: 1,
        summary: "Listed 1 workflow script",
      });
    });

    it("description 缺省 → (no description) 占位（core formatter 行为透传）", async () => {
      const registry = makeRegistry([makeListScript("bare-wf", "saved", "")]);
      const tool = captureScriptTool(registry);
      const r = await listCall(tool);
      expect(r.content).toEqual([
        { type: "text", text: "Available workflows:\n  - [saved] bare-wf: (no description)" },
      ]);
    });

    it("空清单（无任何脚本）→ 空态单行文案，summary-only details、无 isError", async () => {
      const registry = makeRegistry([]);
      const tool = captureScriptTool(registry);
      const r = await listCall(tool);
      expect(r.content).toEqual([{ type: "text", text: "No workflow scripts available." }]);
      expect(r.details).toEqual({ summary: "Listed 0 workflow scripts" });
      expect(r.isError).toBeUndefined();
    });

    it("全不可用清单 → 同空态文案（available filter 后为空）", async () => {
      const registry = makeRegistry([{ ...makeListScript("broken-wf", "saved", "x"), available: false }]);
      const tool = captureScriptTool(registry);
      const r = await listCall(tool);
      expect(r.content).toEqual([{ type: "text", text: "No workflow scripts available." }]);
    });
  });

  // ── GUI attach（RPC 模式分发；list 的 GUI 派生视图 = scripts 计数 stats-line）──

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
      expect(r.details).toEqual({
        action: "list",
        count: 1,
        summary: "Listed 1 workflow script",
      });
    });
  });

  // ── 收起态一行摘要（details.summary 约定，见 extension-conventions.md）──

  describe("buildScriptSummary + renderResult 折叠分支", () => {
    /** renderResult 直通 stub theme（fg 原样返回，便于断言纯文本）。 */
    const renderTheme = { fg: (_token: string, text: string) => text } as never;

    const renderText = (node: { render(width: number): string[] }): string =>
      node.render(400).join("\n");

    it("buildScriptSummary 五 action 措辞（list 单数/复数分源；lint valid → passed）", () => {
      const p = { action: "lint" } as ScriptParams;
      expect(buildScriptSummary(p, { action: "generate", path: "/a.js", name: "deploy-wf", status: "ready" })).toBe(
        "Script deploy-wf generated",
      );
      expect(buildScriptSummary(p, { action: "lint", name: "deploy-wf", valid: true, findingCount: 2 })).toBe(
        "Script deploy-wf linted: passed",
      );
      expect(buildScriptSummary(p, { action: "lint", name: "deploy-wf", valid: false, findingCount: 3 })).toBe(
        "Script deploy-wf linted: 3 findings",
      );
      expect(buildScriptSummary(p, { action: "list", count: 1 })).toBe("Listed 1 workflow script");
      expect(buildScriptSummary(p, { action: "list", count: 2 })).toBe("Listed 2 workflow scripts");
      expect(buildScriptSummary(p, { action: "save", name: "deploy-wf", ok: true })).toBe(
        "Script deploy-wf saved",
      );
      expect(buildScriptSummary(p, { action: "delete", name: "deploy-wf", ok: true })).toBe(
        "Script deploy-wf deleted",
      );
    });

    it("renderResult 折叠 + details.summary → 单行摘要（不渲染 content 全文）", () => {
      const tool = captureScriptExecuteTool();
      const renderResult = (tool as unknown as {
        renderResult: (r: unknown, o: { expanded: boolean }, t: never) => { render(width: number): string[] };
      }).renderResult;
      const node = renderResult(
        {
          content: [{ type: "text", text: "Available workflows:\n  - [saved] deploy-wf: deploy the app" }],
          details: { action: "list", count: 1, summary: "Listed 1 workflow script" },
        },
        { expanded: false },
        renderTheme,
      );
      const text = renderText(node);
      // pi-tui Text.render 逐行 pad，整串断言用 toContain；折叠态不输出 content 全文
      expect(text).toContain("Listed 1 workflow script");
      expect(text).not.toContain("deploy the app");
    });

    it("renderResult 展开 → 维持 renderTextResult 全文渲染（summary 不参与展开态）", () => {
      const tool = captureScriptExecuteTool();
      const renderResult = (tool as unknown as {
        renderResult: (r: unknown, o: { expanded: boolean }, t: never) => { render(width: number): string[] };
      }).renderResult;
      const node = renderResult(
        {
          content: [{ type: "text", text: "Saved workflow script: deploy-wf" }],
          details: { action: "save", name: "deploy-wf", ok: true, summary: "Script deploy-wf saved" },
        },
        { expanded: true },
        renderTheme,
      );
      expect(renderText(node)).toContain("Saved workflow script: deploy-wf");
    });

    it("renderResult 折叠 + details 无 summary（历史 entry）→ 落回全文渲染（读写向后兼容）", () => {
      const tool = captureScriptExecuteTool();
      const renderResult = (tool as unknown as {
        renderResult: (r: unknown, o: { expanded: boolean }, t: never) => { render(width: number): string[] };
      }).renderResult;
      const node = renderResult(
        { content: [{ type: "text", text: "legacy full text" }], details: undefined },
        { expanded: false },
        renderTheme,
      );
      expect(renderText(node)).toContain("legacy full text");
    });
  });
});
