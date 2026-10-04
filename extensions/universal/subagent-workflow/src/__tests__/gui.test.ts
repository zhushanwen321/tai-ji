/**
 * GUI 协议测试（interface 渲染壳的映射 / ctx 分发 / 构造器三面）。
 *
 * 覆盖：
 *   1. gui-mappers —— mapRunStatus / mapRunIcon（子代理执行状态 → 协议三态 + 图标）与
 *      toGuiCtx（ExtensionContext → GuiContext 最小子集）
 *   2. adapter     —— ctx.mode 分发契约（rpc → __gui__ 附加，其余模式不附加）
 *   3. 构造器      —— buildGuiComponent（subagent）/ buildScriptGui（script）按
 *      action 构造对应 GuiComponent，验证 type 字段 + 子组件结构（workflow tool 走
 *      isWorkflow 块分支不消费 `__gui__`，无构造器——D8）
 *
 * isGuiCapable 属协议包符号，其模式判定矩阵由 packages/extension-protocol 的
 * helpers.test.ts 锁定，不在此重复。
 *
 * 构造器入参是纯数据类型（AdapterInput / WorkflowScriptToolDetails 联合），不需
 * mock 领域 service，直接构造对象字面量即可。状态/icon 映射的正确性已在
 * mapRunStatus/mapRunIcon 用例里独立覆盖，构造器用例只验证「正确组件 type +
 * items 结构 + 映射联动」。
 */
import type { GuiContext } from "@zhushanwen/extension-protocol";
import { describe, expect, it } from "vitest";

import { mapRunIcon, mapRunStatus, toGuiCtx } from "../interface/gui/gui-mappers.ts";
import { adapter, buildGuiComponent } from "../interface/gui/subagent-actions.ts";
import type { AdapterInput } from "../interface/gui/subagent-actions.ts";
import { buildScriptGui } from "../interface/tool/tool-workflow-script.ts";
import type { WorkflowScriptToolDetails } from "../interface/tool/tool-workflow-script.ts";

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
