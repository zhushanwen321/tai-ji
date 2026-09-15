/**
 * workflow-script GUI 协议测试。
 *
 * 覆盖 buildScriptGui 的 5 个 action 分支（generate/lint/list/save/delete），
 * 验证各分支产出的 stats-line 结构：component.type、item.label/value/severity。
 *
 * buildScriptGui 入参是 WorkflowScriptToolDetails 联合（纯数据），不需 mock
 * 领域 service，直接构造对象字面量即可。
 */
import { describe, expect, it } from "vitest";

import type { WorkflowScriptToolDetails } from "../interface/tool-workflow-script.ts";
import { buildScriptGui } from "../interface/tool-workflow-script.ts";

// ============================================================
// generate
// ============================================================

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

// ============================================================
// lint
// ============================================================

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

// ============================================================
// list
// ============================================================

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

// ============================================================
// save
// ============================================================

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

// ============================================================
// delete
// ============================================================

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
