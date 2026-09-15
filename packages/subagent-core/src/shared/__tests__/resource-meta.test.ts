/**
 * resource-meta 类型族测试（v5 §11.1）
 *
 * 编译期 + 运行期判别 ResourceMeta 联合。
 */
import { describe, expect, it } from "vitest";

import type { AgentMeta, ResourceMeta, WorkflowMeta } from "../resource-meta.ts";

describe("ResourceMeta 类型族", () => {
  it("WorkflowMeta 判别 kind='workflow'", () => {
    const wf: WorkflowMeta = {
      kind: "workflow",
      name: "chain",
      description: "test",
      phases: ["a"],
    };
    expect(wf.kind).toBe("workflow");
  });

  it("AgentMeta 判别 kind='agent'", () => {
    const ag: AgentMeta = {
      kind: "agent",
      name: "reviewer",
      description: "review",
    };
    expect(ag.kind).toBe("agent");
  });

  it("联合类型 kind 判别 narrowing", () => {
    function isWorkflow(m: ResourceMeta): m is WorkflowMeta {
      return m.kind === "workflow";
    }
    const wf: ResourceMeta = { kind: "workflow", name: "x", description: "", phases: [] };
    const ag: ResourceMeta = { kind: "agent", name: "y", description: "" };
    expect(isWorkflow(wf)).toBe(true);
    expect(isWorkflow(ag)).toBe(false);
  });

  it("可选字段缺省为 undefined", () => {
    const wf: WorkflowMeta = {
      kind: "workflow",
      name: "x",
      description: "",
      phases: [],
    };
    expect(wf.parameters).toBeUndefined();
    expect(wf.usage).toBeUndefined();
    expect(wf.when).toBeUndefined();
  });
});
