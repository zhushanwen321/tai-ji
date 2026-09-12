// src/__tests__/session-reconstructor.test.ts
//
// session-reconstructor 专属测试。
// 覆盖：从 session.jsonl 重建 turns[]/usage/result/error/eventLog；
//      identity custom entry 解析；toolCall↔toolResult 配对；
//      防御性降级（文件缺失/损坏/缺 identity/无 assistant message）。
//
// 用 tmpdir + 真实 .jsonl 文件（隔离文件系统）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IDENTITY_CUSTOM_TYPE,
  readIdentityAnywhere,
  readIdentityHeader,
  readIdentityTail,
  reconstructFromFile,
} from "../session-reconstructor.ts";

/** 写一行到文件（JSON.stringify + 换行）。 */
function writeLine(file: number, obj: unknown): void {
  fs.writeSync(file, `${JSON.stringify(obj)}\n`);
}

/** session header 行。 */
function headerLine(cwd = "/tmp"): unknown {
  return { type: "session", version: 3, id: "sess-uuid", timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

/** identity custom entry。 */
function identityEntry(identity: object): unknown {
  return {
    type: "custom", id: "id-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    customType: IDENTITY_CUSTOM_TYPE, data: identity,
  };
}

/** assistant message entry（content blocks + usage + stopReason）。 */
function assistantEntry(
  blocks: object[],
  opts: { usage?: object; stopReason?: string; errorMessage?: string; ts?: number; parentId?: string } = {},
): unknown {
  return {
    type: "message", id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    parentId: opts.parentId ?? "id-1",
    timestamp: new Date(opts.ts ?? 1000).toISOString(),
    message: {
      role: "assistant",
      content: blocks,
      usage: opts.usage ?? { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0 } },
      stopReason: opts.stopReason ?? "stop",
      errorMessage: opts.errorMessage,
      timestamp: opts.ts ?? 1000,
    },
  };
}

/** toolResult message entry。 */
function toolResultEntry(toolCallId: string, toolName: string, opts: { isError?: boolean; parentId?: string; text?: string } = {}): unknown {
  return {
    type: "message", id: `tr-${Math.random().toString(36).slice(2, 8)}`,
    parentId: opts.parentId ?? "id-1",
    timestamp: new Date(2000).toISOString(),
    message: {
      role: "toolResult", toolCallId, toolName,
      content: [{ type: "text", text: opts.text ?? "result" }],
      isError: opts.isError ?? false,
      timestamp: 2000,
    },
  };
}

describe("reconstructFromFile", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-test-"));
    filePath = path.join(tmpDir, "test.jsonl");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function writeJsonl(lines: unknown[]): void {
    const fd = fs.openSync(filePath, "w");
    for (const line of lines) writeLine(fd, line);
    fs.closeSync(fd);
  }

  // ============================================================
  // 基本重建
  // ============================================================
  describe("基本重建", () => {
    it("单 assistant message → 1 turn，text/usage 正确", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "worker", mode: "background", task: "do it", startedAt: 500 }),
        assistantEntry([{ type: "text", text: "hello world" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.id).toBe("bg-1");
      expect(rec!.agent).toBe("worker");
      expect(rec!.mode).toBe("background");
      expect(rec!.task).toBe("do it");
      expect(rec!.status).toBe("closed");
      expect(rec!.turns).toHaveLength(1);
      expect(rec!.turns[0].text).toBe("hello world");
      expect(rec!.turnCount).toBe(1);
      expect(rec!.totalTokens).toBe(30); // 10+20+0+0
      expect(rec!.result).toBe("hello world");
    });

    it("thinking block 累积进 turn.thinking", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "answer" },
        ]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.turns[0].thinking).toBe("let me think");
      expect(rec!.turns[0].text).toBe("answer");
    });

    it("多 assistant message → 多 turn，result 用空行拼接", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "first" }], { ts: 1000 }),
        assistantEntry([{ type: "text", text: "second" }], { ts: 2000, parentId: undefined }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.turns).toHaveLength(2);
      expect(rec!.turnCount).toBe(2);
      expect(rec!.result).toBe("first\n\nsecond");
    });

    it("读出 identity 里的 rootSessionId", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100, rootSessionId: "sess-A" }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.rootSessionId).toBe("sess-A");
    });

    it("旧文件 identity 写 parentSessionId → fallback 读到 rootSessionId（向后兼容）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100, parentSessionId: "sess-legacy" }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.rootSessionId).toBe("sess-legacy");
    });

    it("identity 无 rootSessionId（旧文件）→ rootSessionId 为 undefined", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.rootSessionId).toBeUndefined();
    });

    it("读出 identity 里的 slug", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", slug: "extract-urls", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.slug).toBe("extract-urls");
    });

    it("旧文件 identity 无 slug → 兜底空串（向后兼容）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.slug).toBe("");
    });

    it("读出 identity 里的 parentRecordId/depth（递归层级）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "run-2", agent: "w", mode: "background", task: "t", startedAt: 100, rootSessionId: "sess-A", parentRecordId: "run-1", depth: 2 }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.parentRecordId).toBe("run-1");
      expect(rec!.depth).toBe(2);
    });

    it("旧文件无 parentRecordId/depth → 兑底 undefined/0（顶层）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100, rootSessionId: "sess-A" }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.parentRecordId).toBeUndefined();
      expect(rec!.depth).toBe(0);
    });

    it("endedAt 为最后一条 entry 的时间戳（非 now）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "bg-1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "first" }], { ts: 1000 }),
        assistantEntry([{ type: "text", text: "second" }], { ts: 5000, parentId: undefined }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.endedAt).toBe(5000);
    });
  });

  // ============================================================
  // toolCall ↔ toolResult 配对
  // ============================================================
  describe("toolCall 配对", () => {
    it("toolCall + toolResult → InternalToolCall done", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/x.ts" } },
        ]),
        toolResultEntry("call-1", "read"),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.turns[0].toolCalls).toHaveLength(1);
      const tc = rec!.turns[0].toolCalls[0];
      expect(tc.toolName).toBe("read");
      expect(tc._status).toBe("done");
      expect(tc.isError).toBe(false);
    });

    it("toolResult isError → InternalToolCall failed", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "false" } },
        ]),
        toolResultEntry("call-1", "bash", { isError: true }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.turns[0].toolCalls[0]._status).toBe("failed");
      expect(rec!.turns[0].toolCalls[0].isError).toBe(true);
    });

    it("孤儿 toolResult（无匹配 toolCall）→ 丢弃，不崩", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "ok" }]),
        toolResultEntry("nonexistent", "read"),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.turns[0].toolCalls).toHaveLength(0);
    });
  });

  // ============================================================
  // error / stopReason
  // ============================================================
  describe("error 处理", () => {
    it("stopReason=error → lastError + error 字段", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "partial" }], {
          stopReason: "error", errorMessage: "API timeout",
        }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.lastError).toBe("API timeout");
      expect(rec!.error).toBe("API timeout");
      expect(rec!.status).toBe("closed"); // error stopReason → failed
    });

    it("stopReason=aborted 无 errorMessage → lastError = 'aborted'", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "" }], { stopReason: "aborted" }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.lastError).toBe("aborted");
      expect(rec!.status).toBe("closed");
    });

    it("前序 error 但最后 stop → lastError 清除（镜像 turn_end 语义），status=done", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "oops" }], {
          stopReason: "error", errorMessage: "transient", ts: 1000,
        }),
        assistantEntry([{ type: "text", text: "recovered" }], { stopReason: "stop", ts: 2000 }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.lastError).toBeUndefined(); // 后续 stop 清除了 error
      expect(rec!.status).toBe("closed");
      expect(rec!.result).toBe("oops\n\nrecovered");
    });
  });

  // ============================================================
  // eventLog 派生
  // ============================================================
  describe("eventLog 派生", () => {
    it("tool_start + tool_end + turn_end 条目", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x.ts" } },
        ]),
        toolResultEntry("c1", "read"),
      ]);
      const rec = reconstructFromFile(filePath);
      const types = rec!.eventLog.map((e) => e.type);
      expect(types).toContain("tool_start");
      expect(types).toContain("tool_end");
      expect(types).toContain("turn_end");
    });
  });

  // ============================================================
  // 防御性降级
  // ============================================================
  describe("防御性降级", () => {
    it("文件缺失 → undefined", () => {
      expect(reconstructFromFile(path.join(tmpDir, "nonexistent.jsonl"))).toBeUndefined();
    });

    it("空文件 → undefined", () => {
      fs.writeFileSync(filePath, "", "utf-8");
      expect(reconstructFromFile(filePath)).toBeUndefined();
    });

    it("缺 identity custom entry → undefined", () => {
      writeJsonl([
        headerLine(),
        assistantEntry([{ type: "text", text: "no identity" }]),
      ]);
      expect(reconstructFromFile(filePath)).toBeUndefined();
    });

    it("有 identity 但无 assistant message → undefined", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
      ]);
      expect(reconstructFromFile(filePath)).toBeUndefined();
    });

    it("损坏 JSON 行跳过，合法行仍解析", () => {
      const fd = fs.openSync(filePath, "w");
      fs.writeSync(fd, `${JSON.stringify(headerLine())}\n`);
      fs.writeSync(fd, "THIS IS NOT JSON\n");
      fs.writeSync(fd, `${JSON.stringify(identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }))}\n`);
      fs.writeSync(fd, `${JSON.stringify(assistantEntry([{ type: "text", text: "survived" }]))}\n`);
      fs.closeSync(fd);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.result).toBe("survived");
    });
  });

  // ============================================================
  // 分支覆盖补充（特征锚定，守护行为保持重构）
  // ============================================================
  describe("分支覆盖补充（特征锚定）", () => {
    it("无 session header（第 1 行非 header）→ 该行仍按普通 entry 解析，正常重建", () => {
      writeJsonl([
        identityEntry({ id: "r1", agent: "w", mode: "sync", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "no header" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.result).toBe("no header");
    });

    it("首行（header 位）损坏 JSON → 跳过该行，后续行仍解析", () => {
      const fd = fs.openSync(filePath, "w");
      fs.writeSync(fd, "CORRUPTED FIRST LINE\n");
      fs.writeSync(fd, `${JSON.stringify(identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }))}\n`);
      fs.writeSync(fd, `${JSON.stringify(assistantEntry([{ type: "text", text: "after corrupt header" }]))}\n`);
      fs.closeSync(fd);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.result).toBe("after corrupt header");
    });

    it("文件只有空白行 → undefined（entries 为空）", () => {
      fs.writeFileSync(filePath, "\n\n   \n", "utf-8");
      expect(reconstructFromFile(filePath)).toBeUndefined();
    });

    it("identity custom entry 的 data 非法（缺 task）→ undefined", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", startedAt: 100 }), // 缺 task
        assistantEntry([{ type: "text", text: "orphan identity" }]),
      ]);
      expect(reconstructFromFile(filePath)).toBeUndefined();
    });

    it("model_change → model = provider/modelId（多次出现时后写覆盖）", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        { type: "model_change", provider: "p1", modelId: "m1", timestamp: new Date(500).toISOString() },
        assistantEntry([{ type: "text", text: "first" }], { ts: 1000 }),
        { type: "model_change", provider: "p2", modelId: "m2", timestamp: new Date(1500).toISOString() },
        assistantEntry([{ type: "text", text: "second" }], { ts: 2000 }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.model).toBe("p2/m2");
    });

    it("model_change 字段非字符串（provider 缺失）→ model 保持空串", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        { type: "model_change", provider: 42, modelId: "m1", timestamp: new Date(500).toISOString() },
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.model).toBe("");
    });

    it("thinking_level_change → thinkingLevel 恢复；无该 entry → undefined", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        { type: "thinking_level_change", thinkingLevel: "high", timestamp: new Date(500).toISOString() },
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const withLevel = reconstructFromFile(filePath);
      expect(withLevel!.thinkingLevel).toBe("high");

      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const withoutLevel = reconstructFromFile(filePath);
      expect(withoutLevel!.thinkingLevel).toBeUndefined();
    });

    it("entry.timestamp 非法（Date.parse NaN）→ endedAt 回落 message.timestamp", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        { ...(assistantEntry([{ type: "text", text: "bad ts" }], { ts: 7777 }) as Record<string, unknown>), timestamp: "not-a-date" },
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.endedAt).toBe(7777);
    });

    it("assistant message 无 content（非数组）→ 空 turn，usage 与 stopReason 均被跳过", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        {
          type: "message",
          timestamp: new Date(3000).toISOString(),
          message: {
            role: "assistant",
            content: "not-an-array",
            usage: { input: 100, output: 100 },
            stopReason: "error",
            errorMessage: "boom",
            timestamp: 3000,
          },
        },
      ]);
      const rec = reconstructFromFile(filePath);
      // turn 在 content 校验前已创建 → record 存在
      expect(rec).toBeDefined();
      expect(rec!.turnCount).toBe(1);
      expect(rec!.turns[0].text).toBe("");
      expect(rec!.totalTokens).toBe(0); // usage 被 continue 跳过
      expect(rec!.lastError).toBeUndefined(); // stopReason=error 也被跳过
      expect(rec!.error).toBeUndefined();
      expect(rec!.endedAt).toBe(3000);
    });

    it("assistant message content 合法但无 usage → totalTokens 0，正常重建", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        {
          type: "message",
          timestamp: new Date(1000).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "no usage" }],
            stopReason: "stop",
            timestamp: 1000,
          },
        },
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.result).toBe("no usage");
      expect(rec!.totalTokens).toBe(0);
    });

    it("孤儿 toolCall（toolResult 未到达）→ toolCalls 空，turn_end label 兜底 'turn'", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec).toBeDefined();
      expect(rec!.turns[0].toolCalls).toHaveLength(0);
      const turnEnd = rec!.eventLog.find((e) => e.type === "turn_end");
      expect(turnEnd?.label).toBe("turn"); // 空 text turn 的摘要兜底
    });

    it("stopReason 非 error/aborted/stop（如 length）→ lastError 保持前值不清除", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "text", text: "oops" }], {
          stopReason: "error", errorMessage: "transient", ts: 1000,
        }),
        assistantEntry([{ type: "text", text: "truncated" }], { stopReason: "length", ts: 2000 }),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.lastError).toBe("transient");
      expect(rec!.error).toBe("transient");
    });

    it("toolResult 配对 → result.content/details 透传，startedTs 取 assistant timestamp", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100 }),
        assistantEntry([{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "ls" } }]),
        toolResultEntry("c9", "bash", { text: "file1\nfile2" }),
      ]);
      const rec = reconstructFromFile(filePath);
      const tc = rec!.turns[0].toolCalls[0];
      expect(tc.result).toEqual({ content: [{ type: "text", text: "file1\nfile2" }], details: undefined });
      expect(tc.startedTs).toBe(1000);
    });

    it("identity 的 chatMode/worktree/forkDepth 经展开透传到 record", () => {
      writeJsonl([
        headerLine(),
        identityEntry({ id: "r1", agent: "w", mode: "background", task: "t", startedAt: 100, chatMode: true, worktree: true, forkDepth: 2 }),
        assistantEntry([{ type: "text", text: "ok" }]),
      ]);
      const rec = reconstructFromFile(filePath);
      expect(rec!.chatMode).toBe(true);
      expect(rec!.worktree).toBe(true);
      expect(rec!.forkDepth).toBe(2);
    });
  });
});

// ============================================================
// 轻量 identity 扫描（readIdentityHeader / readIdentityTail / readIdentityAnywhere）
// ============================================================
// 直测三入口（parseIdentityFromText 的宿主）：头/尾窗口命中、预筛、从后往前、
// 归一化 fallback、损坏行跳过。
describe("轻量 identity 扫描（readIdentityHeader / readIdentityTail / readIdentityAnywhere）", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-identity-scan-"));
    filePath = path.join(tmpDir, "scan.jsonl");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** 写原始文本行（不经 JSON.stringify——填充行/截断行构造用）。 */
  function writeRaw(lines: string[]): void {
    fs.writeFileSync(filePath, lines.map((l) => `${l}\n`).join(""), "utf-8");
  }

  /** >64KB 的无特征填充行（预筛跳过，永不被 JSON.parse）。 */
  const fillerLine = "F".repeat(70 * 1024);

  it("identity 在头部 → 读出身份 + identity 之前途经的 model/thinkingLevel", () => {
    writeRaw([
      JSON.stringify(headerLine()),
      JSON.stringify({ type: "model_change", provider: "p1", modelId: "m1", timestamp: new Date(500).toISOString() }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high", timestamp: new Date(600).toISOString() }),
      JSON.stringify(identityEntry({
        id: "bg-9", agent: "worker", mode: "sync", task: "scan", startedAt: 42,
        slug: "s9", rootSessionId: "sess-R", depth: 1, forkDepth: 0,
      })),
    ]);
    expect(readIdentityHeader(filePath)).toEqual({
      id: "bg-9",
      agent: "worker",
      mode: "sync",
      task: "scan",
      slug: "s9",
      startedAt: 42,
      rootSessionId: "sess-R",
      parentRecordId: undefined,
      depth: 1,
      forkDepth: 0,
      chatMode: undefined,
      worktree: undefined,
      model: "p1/m1",
      thinkingLevel: "high",
      sessionFile: filePath,
    });
  });

  it("identity 之后的 model_change 不捕获（找到即停）", () => {
    writeRaw([
      JSON.stringify(headerLine()),
      JSON.stringify(identityEntry({ id: "bg-8", agent: "w", mode: "background", task: "t", startedAt: 1 })),
      JSON.stringify({ type: "model_change", provider: "late", modelId: "m", timestamp: new Date(900).toISOString() }),
    ]);
    expect(readIdentityHeader(filePath)?.model).toBe("");
  });

  it("头部无 identity → readIdentityHeader undefined", () => {
    writeRaw([JSON.stringify(headerLine()), JSON.stringify({ type: "model_change", provider: "p", modelId: "m" })]);
    expect(readIdentityHeader(filePath)).toBeUndefined();
  });

  it("文件缺失 → 三入口均 undefined（不抛）", () => {
    const missing = path.join(tmpDir, "nope.jsonl");
    expect(readIdentityHeader(missing)).toBeUndefined();
    expect(readIdentityTail(missing)).toBeUndefined();
    expect(readIdentityAnywhere(missing)).toBeUndefined();
  });

  it("identity 仅在尾部（>64KB 填充）→ header miss / tail 命中 / anywhere 命中", () => {
    writeRaw([
      JSON.stringify(headerLine()),
      fillerLine,
      JSON.stringify(identityEntry({ id: "bg-tail", agent: "w", mode: "background", task: "t", startedAt: 7 })),
    ]);
    expect(readIdentityHeader(filePath)).toBeUndefined();
    const tail = readIdentityTail(filePath);
    expect(tail?.id).toBe("bg-tail");
    // model/thinkingLevel 在尾部窗口外 → best-effort 空/undefined
    expect(tail?.model).toBe("");
    expect(tail?.thinkingLevel).toBeUndefined();
    expect(readIdentityAnywhere(filePath)?.id).toBe("bg-tail");
  });

  it("尾部多轮 identity → tail/anywhere 从后往前取最后一条（最新鲜）", () => {
    writeRaw([
      JSON.stringify(headerLine()),
      fillerLine,
      JSON.stringify(identityEntry({ id: "bg-old", agent: "w", mode: "background", task: "t", startedAt: 1 })),
      JSON.stringify(identityEntry({ id: "bg-new", agent: "w", mode: "background", task: "t2", startedAt: 2 })),
    ]);
    expect(readIdentityTail(filePath)?.id).toBe("bg-new");
    expect(readIdentityAnywhere(filePath)?.id).toBe("bg-new");
  });

  it("尾部块首行残缺（含特征串的截断 JSON）→ 跳过该行，后续行仍命中", () => {
    writeRaw([
      JSON.stringify(headerLine()),
      fillerLine,
      '{"type":"custom","customType":"subagent-identity","data":{"id":"trunc"', // 截断行
      JSON.stringify(identityEntry({ id: "bg-after-trunc", agent: "w", mode: "background", task: "t", startedAt: 3 })),
    ]);
    expect(readIdentityTail(filePath)?.id).toBe("bg-after-trunc");
  });

  it("旧 identity（parentSessionId、无 slug/depth）→ rootSessionId fallback + slug 兜底空串 + depth 0", () => {
    writeRaw([
      JSON.stringify(headerLine()),
      JSON.stringify(identityEntry({ id: "bg-old", agent: "w", mode: "background", task: "t", startedAt: 1, parentSessionId: "sess-legacy" })),
    ]);
    expect(readIdentityHeader(filePath)).toMatchObject({
      id: "bg-old",
      slug: "",
      rootSessionId: "sess-legacy",
      depth: 0,
      forkDepth: undefined,
    });
  });

  it("identity 的 chatMode/worktree 透传到轻量 recon", () => {
    writeRaw([
      JSON.stringify(headerLine()),
      JSON.stringify(identityEntry({ id: "bg-chat", agent: "w", mode: "background", task: "t", startedAt: 1, chatMode: true, worktree: true })),
    ]);
    expect(readIdentityHeader(filePath)).toMatchObject({ chatMode: true, worktree: true });
  });

  it("identity data 非法（缺 task）→ 各入口 undefined", () => {
    writeRaw([
      JSON.stringify(headerLine()),
      JSON.stringify(identityEntry({ id: "bg-bad", agent: "w", mode: "background", startedAt: 1 })), // 缺 task
    ]);
    expect(readIdentityHeader(filePath)).toBeUndefined();
    expect(readIdentityTail(filePath)).toBeUndefined();
    expect(readIdentityAnywhere(filePath)).toBeUndefined();
  });

  it("损坏行（无特征串）预筛跳过，identity 行仍命中", () => {
    writeRaw([
      "THIS IS NOT JSON",
      JSON.stringify(identityEntry({ id: "bg-prefilter", agent: "w", mode: "background", task: "t", startedAt: 5 })),
    ]);
    expect(readIdentityHeader(filePath)?.id).toBe("bg-prefilter");
  });
});

// ============================================================
// [H2 S3] identity 面 origin/parentRunId 透传（写 → 读 → 重建往返保真）
// ============================================================
//
// Gate B S3 FAIL 根因的 identity entry 侧防线：identity custom entry 携带
// origin/parentRunId 时，reconstructFromFile（全量重建面）与 readIdentityHeader
// （light 列表面）必须透传；缺省/非法值守卫归一 undefined（= "tool" 语义），
// 对齐 readEntryOriginFields 主 entry 重建侧守卫。
describe("[H2 S3] identity 面 origin/parentRunId 透传", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-origin-"));
    filePath = path.join(tmpDir, "origin.jsonl");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function writeOriginJsonl(identity: object): void {
    const fd = fs.openSync(filePath, "w");
    writeLine(fd, headerLine());
    writeLine(fd, identityEntry(identity));
    writeLine(fd, assistantEntry([{ type: "text", text: "done" }]));
    fs.closeSync(fd);
  }

  it("往返保真：identity(origin=workflow, parentRunId) → 全量重建 + 轻量扫描均透传", () => {
    writeOriginJsonl({
      id: "bg-wf", agent: "worker", mode: "background", task: "wf task", startedAt: 10,
      origin: "workflow", parentRunId: "wf-run-9",
    });

    const full = reconstructFromFile(filePath);
    expect(full).toBeDefined();
    expect(full!.origin).toBe("workflow");
    expect(full!.parentRunId).toBe("wf-run-9");

    const light = readIdentityHeader(filePath);
    expect(light).toBeDefined();
    expect(light!.origin).toBe("workflow");
    expect(light!.parentRunId).toBe("wf-run-9");
  });

  it("缺省负向：旧 identity（无 origin/parentRunId）→ 重建两字段 undefined（= tool 语义）", () => {
    writeOriginJsonl({ id: "bg-old", agent: "w", mode: "background", task: "t", startedAt: 1 });

    expect(reconstructFromFile(filePath)!.origin).toBeUndefined();
    expect(reconstructFromFile(filePath)!.parentRunId).toBeUndefined();
    expect(readIdentityHeader(filePath)!.origin).toBeUndefined();
    expect(readIdentityHeader(filePath)!.parentRunId).toBeUndefined();
  });

  it("非法值守卫：origin 非白名单 / parentRunId 非 string → 守卫归一 undefined（不抛）", () => {
    writeOriginJsonl({
      id: "bg-bad", agent: "w", mode: "background", task: "t", startedAt: 1,
      origin: "bogus", parentRunId: 42,
    });

    const full = reconstructFromFile(filePath);
    expect(full!.origin).toBeUndefined();
    expect(full!.parentRunId).toBeUndefined();
    const light = readIdentityHeader(filePath)!;
    expect(light.origin).toBeUndefined();
    expect(light.parentRunId).toBeUndefined();
  });

  it("origin=tool 显式值 → 透传保留（负向判定 `!== \"workflow\"` 依赖真实值）", () => {
    writeOriginJsonl({
      id: "bg-tool", agent: "w", mode: "background", task: "t", startedAt: 1,
      origin: "tool",
    });
    expect(reconstructFromFile(filePath)!.origin).toBe("tool");
    expect(readIdentityHeader(filePath)!.origin).toBe("tool");
  });
});
