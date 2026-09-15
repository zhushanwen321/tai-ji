/**
 * command-actions — RPC 模式 slash command action 解析纯函数测试。
 *
 * 覆盖 parseSubagentRpcCommand / parseWorkflowRpcCommand：
 * - 正常路径（action + id 齐全）
 * - missing-id 边界（action 有但 id 缺失）
 * - removed 边界（已移除的 workflow lifecycle verb → lifecycle-removed 提示，
 *   run 一次性生命周期后 pause/resume 不可用）
 * - noop 边界（空串 / 未知 action / 无参列表查看）
 *
 * 纯函数无外部依赖，直接断言返回值。
 */
import { describe, expect, it } from "vitest";

import {
  parseSubagentRpcCommand,
  parseWorkflowRpcCommand,
} from "../interface/command-actions.ts";

// ============================================================
// parseSubagentRpcCommand
// ============================================================

describe("parseSubagentRpcCommand", () => {
  it("cancel + recordId → { action: 'cancel', recordId }", () => {
    expect(parseSubagentRpcCommand("cancel bg-jwt-research")).toEqual({
      action: "cancel",
      recordId: "bg-jwt-research",
    });
  });

  it("cancel 无 recordId → cancel-missing-id", () => {
    expect(parseSubagentRpcCommand("cancel")).toEqual({ action: "cancel-missing-id" });
  });

  it("cancel 后跟多个空格再 id → 正确解析 id（trim 后）", () => {
    expect(parseSubagentRpcCommand("cancel   bg-x")).toEqual({
      action: "cancel",
      recordId: "bg-x",
    });
  });

  it("空串 → noop", () => {
    expect(parseSubagentRpcCommand("")).toEqual({ action: "noop" });
  });

  it("纯空白 → noop", () => {
    expect(parseSubagentRpcCommand("   ")).toEqual({ action: "noop" });
  });

  it("未知 action → noop", () => {
    expect(parseSubagentRpcCommand("foobar bg-x")).toEqual({ action: "noop" });
  });

  it("无参（列表查看，GUI 不走此路径但需兜底）→ noop", () => {
    expect(parseSubagentRpcCommand("bg-jwt-research")).toEqual({ action: "noop" });
  });
});

// ============================================================
// parseSubagentRpcCommand — message/start（GUI 定向消息通道，设计 §3.3.3）
// ============================================================

describe("parseSubagentRpcCommand message/start（定向消息通道）", () => {
  it("message + recordId + text（含空格）→ 剩余全量保留空格", () => {
    expect(parseSubagentRpcCommand("message sa-1 展开讲讲 这个方案")).toEqual({
      action: "message",
      recordId: "sa-1",
      text: "展开讲讲 这个方案",
    });
  });

  it("message text 含引号 → 原样保留（不解析引号语义）", () => {
    expect(parseSubagentRpcCommand('message sa-1 引用 "so called" 原文')).toEqual({
      action: "message",
      recordId: "sa-1",
      text: '引用 "so called" 原文',
    });
  });

  it("message 换行转义：字面 \\n（两字符）还原为真实换行（P3 转义协议）", () => {
    // 源码里 "\\n" = 字面反斜杠+n；解析产物含真实换行 "\n"
    expect(parseSubagentRpcCommand("message sa-1 第一行\\n第二行")).toEqual({
      action: "message",
      recordId: "sa-1",
      text: "第一行\n第二行",
    });
  });

  it("message 多个换行转义 + 空格混合 → 还原为多行文本", () => {
    expect(parseSubagentRpcCommand("message sa-1 标题\\n\\n正文 内容")).toEqual({
      action: "message",
      recordId: "sa-1",
      text: "标题\n\n正文 内容",
    });
  });

  it("message 缺 recordId → message-missing-args (missing: recordId)", () => {
    expect(parseSubagentRpcCommand("message")).toEqual({
      action: "message-missing-args",
      missing: "recordId",
    });
  });

  it("message 缺 text（recordId 后无内容）→ message-missing-args (missing: text)", () => {
    expect(parseSubagentRpcCommand("message sa-1")).toEqual({
      action: "message-missing-args",
      missing: "text",
    });
  });

  it("message text 纯字面换行（还原后为空白）→ missing text（先还原再判空）", () => {
    expect(parseSubagentRpcCommand("message sa-1 \\n")).toEqual({
      action: "message-missing-args",
      missing: "text",
    });
  });

  it("message verb 后多空格再 recordId → trim 后正确解析", () => {
    expect(parseSubagentRpcCommand("message   sa-x   hello world")).toEqual({
      action: "message",
      recordId: "sa-x",
      text: "hello world",
    });
  });

  it("start + slug + task（含空格）→ 剩余全量", () => {
    expect(parseSubagentRpcCommand("start fix-login 修复登录页 并写测试")).toEqual({
      action: "start",
      slug: "fix-login",
      task: "修复登录页 并写测试",
    });
  });

  it("start task 换行转义 → 还原为真实换行", () => {
    expect(parseSubagentRpcCommand("start my-slug 任务一\\n任务二")).toEqual({
      action: "start",
      slug: "my-slug",
      task: "任务一\n任务二",
    });
  });

  it("start 缺 slug → start-missing-args (missing: slug)", () => {
    expect(parseSubagentRpcCommand("start")).toEqual({
      action: "start-missing-args",
      missing: "slug",
    });
  });

  it("start 缺 task → start-missing-args (missing: task)", () => {
    expect(parseSubagentRpcCommand("start fix-login")).toEqual({
      action: "start-missing-args",
      missing: "task",
    });
  });

  it("message/start 与 cancel 共存：未知 verb 仍落 noop（回归保护）", () => {
    expect(parseSubagentRpcCommand("pause sa-1")).toEqual({ action: "noop" });
    expect(parseSubagentRpcCommand("restart sa-1")).toEqual({ action: "noop" });
  });
});

// ============================================================
// 转义协议互逆（runtime encodeDirectiveText ↔ decodeNewlineEscapes）
// ============================================================

describe("转义协议互逆（message/start 文本往返不变）", () => {
  // runtime 侧 encodeDirectiveText（session-service.ts）的本地镜像：extension 不依赖
  // runtime 包（依赖边界 F7），互逆性靠两侧测试对同一 wire 协议双向钉死。
  // 编码规则：原生反斜杠 → \\（先）、真实换行 → 字面 \n（后），命令保持单行。
  const encodeMirror = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

  it("原文含字面 \\n（反斜杠+n，如路径 C:\\new）→ 往返不变（不被误解码为换行）", () => {
    const original = "路径 C:\\new folder 的说明";
    const parsed = parseSubagentRpcCommand(`message sa-1 ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "message", recordId: "sa-1", text: original });
  });

  it("原文含反斜杠（非 n 前缀，如正则 \\d+ 与 UNC 路径）→ 往返不变", () => {
    const original = "正则 \\d+ 与 \\\\server\\share";
    const parsed = parseSubagentRpcCommand(`message sa-1 ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "message", recordId: "sa-1", text: original });
  });

  it("原文含真实换行 → 往返不变（编码为字面 \\n 后还原）", () => {
    const original = "第一行\n第二行";
    const parsed = parseSubagentRpcCommand(`message sa-1 ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "message", recordId: "sa-1", text: original });
  });

  it("混合：反斜杠 + 真实换行 + 字面 \\n 同文 → 往返不变", () => {
    const original = "C:\\new\n正则 \\d+\n收尾";
    const parsed = parseSubagentRpcCommand(`message sa-1 ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "message", recordId: "sa-1", text: original });
  });

  it("start task 同样满足互逆（task 与 text 共用同一转义协议）", () => {
    const original = "任务 C:\\new\n第二行";
    const parsed = parseSubagentRpcCommand(`start my-slug ${encodeMirror(original)}`);
    expect(parsed).toEqual({ action: "start", slug: "my-slug", task: original });
  });

  it("wire 上编码后的文本不含真实换行（命令单行不变式）", () => {
    const original = "a\nb\nc\\d";
    expect(encodeMirror(original).includes("\n")).toBe(false);
  });
});

// ============================================================
// parseWorkflowRpcCommand
// ============================================================

describe("parseWorkflowRpcCommand", () => {
  it("pause + runId → { action: 'lifecycle-removed', verb: 'pause' }（run 一次性生命周期，不可挂起）", () => {
    expect(parseWorkflowRpcCommand("pause run-abc")).toEqual({
      action: "lifecycle-removed",
      verb: "pause",
    });
  });

  it("resume + runId → { action: 'lifecycle-removed', verb: 'resume' }（run 一次性生命周期，不可恢复）", () => {
    expect(parseWorkflowRpcCommand("resume run-def")).toEqual({
      action: "lifecycle-removed",
      verb: "resume",
    });
  });

  it("abort + runId → { action: 'abort', runId }", () => {
    expect(parseWorkflowRpcCommand("abort run-ghi")).toEqual({
      action: "abort",
      runId: "run-ghi",
    });
  });

  it("pause 无 runId → lifecycle-removed（removed verb 优先于 missing-id 判定——提示语义优先）", () => {
    expect(parseWorkflowRpcCommand("pause")).toEqual({
      action: "lifecycle-removed",
      verb: "pause",
    });
  });

  it("resume 无 runId → lifecycle-removed（removed verb 优先于 missing-id 判定）", () => {
    expect(parseWorkflowRpcCommand("resume")).toEqual({
      action: "lifecycle-removed",
      verb: "resume",
    });
  });

  it("abort 无 runId → lifecycle-missing-id with verb", () => {
    expect(parseWorkflowRpcCommand("abort")).toEqual({
      action: "lifecycle-missing-id",
      verb: "abort",
    });
  });

  it("空串 → noop", () => {
    expect(parseWorkflowRpcCommand("")).toEqual({ action: "noop" });
  });

  it("纯空白 → noop", () => {
    expect(parseWorkflowRpcCommand("  ")).toEqual({ action: "noop" });
  });

  it("未知 action → noop", () => {
    expect(parseWorkflowRpcCommand("status run-abc")).toEqual({ action: "noop" });
  });

  it("无参（列表查看）→ noop", () => {
    expect(parseWorkflowRpcCommand("run-abc")).toEqual({ action: "noop" });
  });
});
