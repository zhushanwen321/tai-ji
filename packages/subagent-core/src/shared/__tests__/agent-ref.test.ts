/**
 * agent-ref 测试：displayAgentName 短名投影 + normalizeRef `..` 段拒绝（⛔2 样本集）
 * + invalidAgentRefMessage 文案工厂 + normalizeWorkflowRef 三分裁决（sink 设计 U1）。
 *
 * 数据层不变式（displayAgentName 只服务显示出口）：非路径值原样返回。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  displayAgentName,
  invalidAgentRefMessage,
  normalizeRef,
  normalizeWorkflowRef,
} from "../agent-ref.ts";

describe("displayAgentName", () => {
  it("mac/linux 绝对路径取 basename 并去 .md", () => {
    expect(displayAgentName("/Users/x/.agents/agents/worker.md")).toBe("worker");
    expect(displayAgentName("/home/u/project/.agents/agents/reviewer.md")).toBe("reviewer");
  });

  it("windows 路径（反斜杠分隔）同样取短名", () => {
    expect(displayAgentName("C:\\Users\\x\\agents\\worker.md")).toBe("worker");
    expect(displayAgentName("C:/Users/x/agents/worker.md")).toBe("worker");
  });

  it("非路径 agent 名原样返回（DEFAULT_AGENT_NAME 等）", () => {
    expect(displayAgentName("general-purpose")).toBe("general-purpose");
    expect(displayAgentName("worker")).toBe("worker");
  });

  it("无 .md 扩展名的 basename 原样返回（不去别的后缀）", () => {
    expect(displayAgentName("/a/b/worker")).toBe("worker");
    expect(displayAgentName("/a/b/agent.spec.ts")).toBe("agent.spec.ts");
  });

  it("裸文件名（无目录）也去 .md", () => {
    expect(displayAgentName("worker.md")).toBe("worker");
  });
});

// ── ⛔2：`..` 段拒绝（sink 设计声明行为变更——现状两宿主均放行，收紧为安全修复）──

describe("normalizeRef `..` 段拒绝（⛔2 样本集）", () => {
  it("agent .md 面：/x/../y.md 拒绝", () => {
    expect(normalizeRef("/x/../y.md", ".md")).toBeNull();
  });

  it("workflow .js 面：/x/../y.js 拒绝（normalizeRef 为 agent/workflow 双消费面）", () => {
    expect(normalizeRef("/x/../y.js", ".js")).toBeNull();
  });

  it("~/ 开头合法路径不误伤（展开后无 .. 段照常通过）", () => {
    expect(normalizeRef("~/agents/worker.md", ".md")).toBe(join(homedir(), "agents/worker.md"));
  });

  it("~/ 展开后含 .. 段同样拒绝（收紧的一致延伸，显式声明）", () => {
    expect(normalizeRef("~/../x.md", ".md")).toBeNull();
  });

  it("无扩展名校验面同样拒绝（收紧在 ext 校验之前）", () => {
    expect(normalizeRef("/x/../y.md")).toBeNull();
  });

  it("中段/尾段/多段 .. 均拒绝", () => {
    expect(normalizeRef("/a/../b/c.md", ".md")).toBeNull();
    expect(normalizeRef("/a/b/..", ".md")).toBeNull();
    expect(normalizeRef("/a/../b/../c.md", ".md")).toBeNull();
  });

  it("windows 反斜杠分隔的 .. 段同样拒绝", () => {
    expect(normalizeRef("C:\\x\\..\\y.md", ".md")).toBeNull();
  });

  it(". 段与 .. 前缀文件名不误伤（最小收紧：只拒 .. 路径段）", () => {
    expect(normalizeRef("/x/./y.md", ".md")).toBe("/x/./y.md");
    expect(normalizeRef("/x/..foo.md", ".md")).toBe("/x/..foo.md");
  });

  it("既有行为保持：空/相对路径/扩展名不符仍 null，普通绝对路径通过", () => {
    expect(normalizeRef("", ".md")).toBeNull();
    expect(normalizeRef("worker.md", ".md")).toBeNull();
    expect(normalizeRef("/x/y.js", ".md")).toBeNull();
    expect(normalizeRef("/x/y.md", ".md")).toBe("/x/y.md");
  });
});

// ── 报错文案工厂（sink 设计 U1：口径收敛单点）──

describe("invalidAgentRefMessage", () => {
  it("非 .. 形态：与 AgentRegistry.loadByPath 既有 throw 文案逐字一致（基准口径）", () => {
    expect(invalidAgentRefMessage("worker")).toBe(
      "Invalid agent ref: worker. Agent refs must be absolute paths to .md files (use <location> from <available_subagents>).",
    );
  });

  it(".. 形态：附纠正指引（含 .. 段说明与注入段 location 指引）", () => {
    const msg = invalidAgentRefMessage("/x/../y.md");
    expect(msg).toMatch(/^Invalid agent ref: \/x\/\.\.\/y\.md\./);
    expect(msg).toContain('without ".." path segments');
    expect(msg).toContain("<location> from <available_subagents>");
  });

  it("howToList 注入：第三宿主清单段名替换缺省 <available_subagents>", () => {
    expect(invalidAgentRefMessage("worker", { howToList: "<available_agents>" })).toContain(
      "use <location> from <available_agents>",
    );
  });
});

// ── workflow ref 原语（sink 设计 U1：名/路径二分 + 保留字裁决 + 内置名优先）──

describe("normalizeWorkflowRef 三分裁决", () => {
  const knownNames = ["review-fix-loop", "chain", "my-user-wf"];

  it("裸名分支：命中 knownNames → name（内置名优先——命中即用，不猜路径）", () => {
    expect(normalizeWorkflowRef("review-fix-loop", { knownNames })).toEqual({
      kind: "name",
      name: "review-fix-loop",
    });
    expect(normalizeWorkflowRef("my-user-wf", { knownNames })).toEqual({
      kind: "name",
      name: "my-user-wf",
    });
  });

  it("裸名分支：未命中 knownNames → invalid/unknown_name", () => {
    expect(normalizeWorkflowRef("no-such-wf", { knownNames })).toEqual({
      kind: "invalid",
      ref: "no-such-wf",
      reason: "unknown_name",
    });
  });

  it("裸名分支：缺省 knownNames → 无已知名，全部裸名 unknown_name", () => {
    expect(normalizeWorkflowRef("review-fix-loop")).toEqual({
      kind: "invalid",
      ref: "review-fix-loop",
      reason: "unknown_name",
    });
  });

  it("保留字裁决：. 与 .. 拒绝（reserved）", () => {
    expect(normalizeWorkflowRef(".", { knownNames })).toEqual({
      kind: "invalid",
      ref: ".",
      reason: "reserved",
    });
    expect(normalizeWorkflowRef("..", { knownNames })).toEqual({
      kind: "invalid",
      ref: "..",
      reason: "reserved",
    });
  });

  it("保留字优先于 knownNames（宿主清单异常含保留字也不放行）", () => {
    expect(normalizeWorkflowRef("..", { knownNames: ["chain", ".."] })).toEqual({
      kind: "invalid",
      ref: "..",
      reason: "reserved",
    });
  });

  it("空引用：empty（首尾空白 trim 后同判）", () => {
    expect(normalizeWorkflowRef("")).toEqual({ kind: "invalid", ref: "", reason: "empty" });
    expect(normalizeWorkflowRef("   ")).toEqual({ kind: "invalid", ref: "   ", reason: "empty" });
  });

  it("路径分支：绝对 .js 路径 → path", () => {
    expect(normalizeWorkflowRef("/proj/wf.js", { knownNames })).toEqual({
      kind: "path",
      path: "/proj/wf.js",
    });
  });

  it("路径分支：~/ 前缀展开为 homedir 绝对路径", () => {
    expect(normalizeWorkflowRef("~/wf.js", { knownNames })).toEqual({
      kind: "path",
      path: join(homedir(), "wf.js"),
    });
  });

  it("路径分支：.. 段拒绝（⛔2 同面——路径域收紧对 workflow 原语生效）", () => {
    expect(normalizeWorkflowRef("/x/../y.js", { knownNames })).toEqual({
      kind: "invalid",
      ref: "/x/../y.js",
      reason: "parent_segment",
    });
  });

  it("路径分支：相对路径 not_absolute、非 .js 扩展名 bad_ext", () => {
    // "wf.js" 无分隔符是合法裸名形态（workflow 名可含点号）→ 走名分支不猜路径
    expect(normalizeWorkflowRef("wf.js", { knownNames })).toEqual({
      kind: "invalid",
      ref: "wf.js",
      reason: "unknown_name",
    });
    // 显式相对路径形态（含分隔符）→ 路径分支
    expect(normalizeWorkflowRef("./wf.js", { knownNames })).toEqual({
      kind: "invalid",
      ref: "./wf.js",
      reason: "not_absolute",
    });
    expect(normalizeWorkflowRef("/proj/wf.txt", { knownNames })).toEqual({
      kind: "invalid",
      ref: "/proj/wf.txt",
      reason: "bad_ext",
    });
  });

  it("路径分支失败原因优先级：.. 段先于扩展名判定", () => {
    expect(normalizeWorkflowRef("/x/../y.txt")).toEqual({
      kind: "invalid",
      ref: "/x/../y.txt",
      reason: "parent_segment",
    });
  });

  it("路径分支失败原因优先级：.. 段先于绝对路径判定（重放顺序对齐 normalizeRef 判序）", () => {
    // 相对路径 + 含 .. 段：normalizeRef 实际因 parent_segment 先判拒绝，归因
    // 不得误报 not_absolute（否则指引改绝对路径后仍被 .. 段拒绝——两步误导）
    expect(normalizeWorkflowRef("a/../b.js")).toEqual({
      kind: "invalid",
      ref: "a/../b.js",
      reason: "parent_segment",
    });
  });

  it("裸名与路径天然二分：名字是简单标识符，含分隔符即归路径分支（对齐 pi 现行为）", () => {
    // 名字不撞路径：knownNames 命中不受路径分支影响
    expect(normalizeWorkflowRef("chain", { knownNames: ["chain"] }).kind).toBe("name");
    // 同串含分隔符后不再是名引用（绝对路径形态但缺 .js 后缀 → bad_ext）
    expect(normalizeWorkflowRef("/chain", { knownNames: ["chain"] })).toEqual({
      kind: "invalid",
      ref: "/chain",
      reason: "bad_ext",
    });
  });
});
