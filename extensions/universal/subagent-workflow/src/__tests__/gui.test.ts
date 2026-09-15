/**
 * GUI 协议测试。
 *
 * 覆盖三层：
 *   1. gui-mappers —— mapRunStatus / mapRunIcon（状态字符串 → 协议三态 + 图标）
 *   2. protocol    —— isGuiCapable（mode 判定 GUI 渲染通道是否有效）
 *   3. 构造器      —— buildGuiComponent（subagent）/ buildWorkflowGui（workflow）
 *                    按 action 构造对应 GuiComponent，验证 type 字段 + 子组件结构。
 *
 * buildGuiComponent / buildWorkflowGui 的入参是纯数据类型（AdapterInput /
 * WorkflowToolDetails 联合），不需 mock 领域 service，直接构造对象字面量即可。
 * 状态/icon 映射的正确性已在 mapRunStatus/mapRunIcon 用例里独立覆盖，构造器用例
 * 只验证「正确组件 type + items 结构 + 映射联动」。
 */
import { isGuiCapable } from "@taiji/extension-protocol";
import { describe, expect,it } from "vitest";

import { mapRunIcon,mapRunStatus, toGuiCtx } from "../interface/gui-mappers.ts";
import { buildGuiComponent } from "../interface/subagent-actions.ts";
import type { WorkflowToolDetails } from "../interface/tool-workflow.ts";
import { buildWorkflowGui } from "../interface/tool-workflow.ts";

// ============================================================
// mapRunStatus —— 状态字符串 → list-tree 三态 status
// ============================================================

describe("mapRunStatus", () => {
  it("running → running", () => {
    expect(mapRunStatus("running")).toBe("running");
  });

  it("done / completed / success / pending → done", () => {
    expect(mapRunStatus("done")).toBe("done");
    expect(mapRunStatus("completed")).toBe("done");
    expect(mapRunStatus("success")).toBe("done");
    expect(mapRunStatus("pending")).toBe("done");
  });

  it("failed / aborted / cancelled / crashed / error → failed", () => {
    expect(mapRunStatus("failed")).toBe("failed");
    expect(mapRunStatus("aborted")).toBe("failed");
    expect(mapRunStatus("cancelled")).toBe("failed");
    expect(mapRunStatus("crashed")).toBe("failed");
    expect(mapRunStatus("error")).toBe("failed");
  });

  it("budget / time_limited reason → failed", () => {
    expect(mapRunStatus("budget_limited")).toBe("failed");
    expect(mapRunStatus("time_limited")).toBe("failed");
  });

  it("组合状态 done (failed) → failed（reason 后缀优先于外层 done）", () => {
    // mapRunStatus 用 includes 子串匹配，"done (failed)" 含 "failed" → failed。
    // 这是 workflow status action 的典型输入（status + reason 拼接）。
    expect(mapRunStatus("done (failed)")).toBe("failed");
  });

  it("大小写不敏感", () => {
    expect(mapRunStatus("RUNNING")).toBe("running");
    expect(mapRunStatus("Failed")).toBe("failed");
    expect(mapRunStatus("DONE")).toBe("done");
  });
});

// ============================================================
// mapRunIcon —— 状态字符串 → TreeItem.icon
// ============================================================

describe("mapRunIcon", () => {
  it("running → circle（进行中）", () => {
    expect(mapRunIcon("running")).toBe("circle");
  });

  it("done / completed / success → check", () => {
    expect(mapRunIcon("done")).toBe("check");
    expect(mapRunIcon("completed")).toBe("check");
    expect(mapRunIcon("success")).toBe("check");
  });

  it("failed / aborted / cancelled / crashed / error → cross", () => {
    expect(mapRunIcon("failed")).toBe("cross");
    expect(mapRunIcon("aborted")).toBe("cross");
    expect(mapRunIcon("cancelled")).toBe("cross");
    expect(mapRunIcon("crashed")).toBe("cross");
    expect(mapRunIcon("error")).toBe("cross");
  });

  it("budget / time_limited → cross", () => {
    expect(mapRunIcon("budget_limited")).toBe("cross");
    expect(mapRunIcon("time_limited")).toBe("cross");
  });

  it("未知状态 → done/check（default 兜底，S#15）", () => {
    expect(mapRunStatus("foobar")).toBe("done");
    expect(mapRunIcon("foobar")).toBe("check");
  });

  it("空串 → done/check（default 兜底，S#15）", () => {
    expect(mapRunStatus("")).toBe("done");
    expect(mapRunIcon("")).toBe("check");
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
// isGuiCapable —— RPC 模式才支持 GUI 渲染通道
// ============================================================

describe("isGuiCapable (protocol)", () => {
  it("rpc mode + hasUI → true（唯一支持 GUI 的组合）", () => {
    expect(isGuiCapable({ mode: "rpc", hasUI: true })).toBe(true);
  });

  it("rpc mode + 无 UI → 仍 true（hasUI 不影响判定，仅看 mode）", () => {
    // 实测协议实现：isGuiCapable 只检查 mode === "rpc"。
    // hasUI 为 false 时 rpc 仍判定为 capable（runtime 可能走非 widget 渲染路径）。
    expect(isGuiCapable({ mode: "rpc", hasUI: false })).toBe(true);
  });

  it("tui mode → false", () => {
    expect(isGuiCapable({ mode: "tui", hasUI: true })).toBe(false);
  });

  it("print mode → false", () => {
    expect(isGuiCapable({ mode: "print", hasUI: false })).toBe(false);
  });

  it("json mode → false", () => {
    expect(isGuiCapable({ mode: "json", hasUI: false })).toBe(false);
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
                  subagentId: "sub-done",
                  agent: "reviewer",
                  slug: "",
                  status: "done",
                  mode: "background",
                  duration: 20,
                  model: "gpt-4",
                  totalTokens: 200,
                },
                {
                  subagentId: "sub-failed",
                  agent: "tester",
                  slug: "ci",
                  status: "failed",
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

      // done → done / check
      expect(props.items[1].status).toBe("done");
      expect(props.items[1].icon).toBe("check");
      // 无 slug（空串）时 label 格式 "agent · subagentId"
      expect(props.items[1].label).toBe("reviewer · sub-done");

      // failed → failed / cross
      expect(props.items[2].status).toBe("failed");
      expect(props.items[2].icon).toBe("cross");
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
});

// ============================================================
// buildWorkflowGui —— workflow tool details 的 GUI 构造
// ============================================================
//
// WorkflowToolDetails 是 run/status/abort 联合。run→list-tree(1 item)，
// status→list-tree(N items)，abort→stats-line。

describe("buildWorkflowGui", () => {
  describe("action: run", () => {
    it("running → list-tree，单 item status=running icon=circle", () => {
      const details: WorkflowToolDetails = {
        action: "run",
        runId: "abcdefgh1234",
        status: "running",
        name: "build",
        slug: "ci",
      };
      const comp = buildWorkflowGui(details);

      expect(comp.type).toBe("list-tree");
      const props = comp.props as { items: Array<{ label: string; status: string; icon: string }> };
      expect(props.items).toHaveLength(1);
      expect(props.items[0].status).toBe("running");
      expect(props.items[0].icon).toBe("circle");
      // label = name + slug + runId 前 8 字符
      expect(props.items[0].label).toBe("build ci abcdefgh");
    });

    it("not_found → stats-line danger（错误状态不渲染为成功）", () => {
      const details: WorkflowToolDetails = {
        action: "run",
        runId: "",
        status: "not_found",
        name: "missing",
      };
      const comp = buildWorkflowGui(details);

      // not_found 是脚本未找到的逻辑错误（isError:true），短路为 stats-line danger，
      // 不走通用 mapper 的 done/check 成功映射（避免绿色对勾与错误文案矛盾）。
      expect(comp.type).toBe("stats-line");
      const props = comp.props as { items: Array<{ label: string; value: string; severity: string }> };
      expect(props.items[0].label).toBe("run");
      expect(props.items[0].value).toBe("not found");
      expect(props.items[0].severity).toBe("danger");
    });

    it("无 slug 时 label 不含双空格（filter(Boolean).join 生效）", () => {
      const details: WorkflowToolDetails = {
        action: "run",
        runId: "1234567890",
        status: "running",
        name: "deploy",
      };
      const comp = buildWorkflowGui(details);
      const props = comp.props as { items: Array<{ label: string }> };
      // slug 缺失 → filter(Boolean) 过滤掉空段 → "deploy 12345678"（单空格）
      expect(props.items[0].label).toBe("deploy 12345678");
    });
  });

  describe("action: status", () => {
    it("多 runs → list-tree，每个 run 的 status+reason 拼接后映射", () => {
      const details: WorkflowToolDetails = {
        action: "status",
        runs: [
          { runId: "run11111", name: "build", slug: "b", status: "running" },
          { runId: "run22222", name: "test", slug: "t", status: "done", reason: "completed" },
          { runId: "run33333", name: "deploy", slug: "d", status: "done", reason: "failed" },
        ],
      };
      const comp = buildWorkflowGui(details);

      expect(comp.type).toBe("list-tree");
      const props = comp.props as { items: Array<{ label: string; status: string; icon: string }> };
      expect(props.items).toHaveLength(3);

      // running
      expect(props.items[0].status).toBe("running");
      expect(props.items[0].icon).toBe("circle");

      // done (completed) — reason 为 completed，statusStr = "done (completed)"
      // 含 "done" → done；无 failed 子串 → check
      expect(props.items[1].status).toBe("done");
      expect(props.items[1].icon).toBe("check");

      // done (failed) — statusStr = "done (failed)"，含 "failed" → failed/cross
      expect(props.items[2].status).toBe("failed");
      expect(props.items[2].icon).toBe("cross");
    });

    it("空 runs → list-tree with empty items", () => {
      const details: WorkflowToolDetails = { action: "status", runs: [] };
      const comp = buildWorkflowGui(details);

      expect(comp.type).toBe("list-tree");
      const props = comp.props as { items: unknown[] };
      expect(props.items).toEqual([]);
    });
  });

  describe("abort → stats-line", () => {
    it("abort → stats-line，label=abort value=runId 前 8 字符，severity=warn（破坏性终止非成功完成）", () => {
      const details: WorkflowToolDetails = {
        action: "abort",
        runId: "abortId1234",
        status: "aborted",
        reason: "user",
      };
      const comp = buildWorkflowGui(details);
      expect(comp.type).toBe("stats-line");
      const props = comp.props as { items: Array<{ label: string; value: string; severity: string }> };
      expect(props.items[0].label).toBe("abort");
      expect(props.items[0].value).toBe("abortId1");
      expect(props.items[0].severity).toBe("warn");
    });
  });
});
