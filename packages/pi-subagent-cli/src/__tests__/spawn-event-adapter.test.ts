// src/__tests__/spawn-event-adapter.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  deriveSessionFilePath,
  findSessionFileByHeaderId,
  parseSpawnLine,
} from "../spawn-event-adapter.ts";

describe("parseSpawnLine", () => {
  describe("空白行", () => {
    it("空字符串返回 null", () => {
      expect(parseSpawnLine("")).toBeNull();
    });

    it("纯空白返回 null", () => {
      expect(parseSpawnLine("   ")).toBeNull();
      expect(parseSpawnLine("\t\t")).toBeNull();
    });
  });

  describe("header 行", () => {
    it("type=session + id 识别为 header", () => {
      const line = JSON.stringify({
        type: "session",
        id: "abc-123",
        timestamp: "2026-07-03T12:00:00.000Z",
        cwd: "/home/user/project",
      });
      const result = parseSpawnLine(line);
      expect(result?.kind).toBe("header");
      if (result?.kind === "header") {
        expect(result.header.id).toBe("abc-123");
        expect(result.header.cwd).toBe("/home/user/project");
      }
    });

    it("header 含 parentSession + version", () => {
      const line = JSON.stringify({
        type: "session",
        id: "child-456",
        timestamp: "2026-07-03T12:00:00.000Z",
        cwd: "/home/user/project",
        parentSession: "parent-789",
        version: 2,
      });
      const result = parseSpawnLine(line);
      expect(result?.kind).toBe("header");
      if (result?.kind === "header") {
        expect(result.header.parentSession).toBe("parent-789");
        expect(result.header.version).toBe(2);
      }
    });
  });

  describe("事件行", () => {
    it("tool_execution_start 识别为 event", () => {
      const line = JSON.stringify({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "call-1",
        args: { command: "ls" },
      });
      const result = parseSpawnLine(line);
      expect(result?.kind).toBe("event");
      if (result?.kind === "event") {
        expect(result.event.type).toBe("tool_execution_start");
        expect(result.event.toolName).toBe("bash");
      }
    });

    it("message_end 识别为 event", () => {
      const line = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50 },
        },
      });
      const result = parseSpawnLine(line);
      expect(result?.kind).toBe("event");
      if (result?.kind === "event") {
        expect(result.event.type).toBe("message_end");
      }
    });

    it("turn_end 识别为 event", () => {
      const result = parseSpawnLine(JSON.stringify({ type: "turn_end" }));
      expect(result?.kind).toBe("event");
    });

    it("未知 type 仍识别为 event（schema 校验由调用方）", () => {
      const result = parseSpawnLine(JSON.stringify({ type: "some_future_event" }));
      expect(result?.kind).toBe("event");
    });
  });

  describe("invalid 行", () => {
    it("非 JSON 返回 invalid", () => {
      const result = parseSpawnLine("not json at all");
      expect(result?.kind).toBe("invalid");
      if (result?.kind === "invalid") {
        expect(result.raw).toBe("not json at all");
        expect(result.error).toBeTruthy();
      }
    });

    it("JSON 但无 type 字段返回 invalid", () => {
      const result = parseSpawnLine(JSON.stringify({ foo: "bar" }));
      expect(result?.kind).toBe("invalid");
      if (result?.kind === "invalid") {
        expect(result.error).toContain("type");
      }
    });

    it("JSON 但 type 非 string 返回 invalid", () => {
      const result = parseSpawnLine(JSON.stringify({ type: 123 }));
      expect(result?.kind).toBe("invalid");
    });

    it("JSON null 返回 invalid", () => {
      const result = parseSpawnLine("null");
      expect(result?.kind).toBe("invalid");
    });
  });
});

describe("deriveSessionFilePath", () => {
  it("拼接 sessionDir + fileTimestamp(冒号点转连字符) + id", () => {
    const header = {
      type: "session" as const,
      id: "abc-123",
      timestamp: "2026-07-03T12:00:00.000Z",
      cwd: "/proj",
    };
    const path = deriveSessionFilePath(header, "/sessions/dir");
    // fileTimestamp = timestamp.replace(/[:.]/g, "-") = "2026-07-03T12-00-00-000Z"
    expect(path).toBe("/sessions/dir/2026-07-03T12-00-00-000Z_abc-123.jsonl");
  });
});

describe("findSessionFileByHeaderId", () => {
  it("sessionId 后缀匹配返回实际文件路径", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-adapter-test-"));
    const expectedFile = path.join(tmpDir, "2026-07-03T12-00-00-000Z_sid-456.jsonl");
    fs.writeFileSync(expectedFile, "{}");
    const result = findSessionFileByHeaderId(tmpDir, "sid-456");
    expect(result).toBe(expectedFile);
    fs.rmSync(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 20 });
  });

  it("无匹配返回 undefined", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-adapter-test-"));
    const result = findSessionFileByHeaderId(tmpDir, "nonexistent");
    expect(result).toBeUndefined();
    fs.rmSync(tmpDir, { recursive: true, maxRetries: 5, retryDelay: 20 });
  });

  it("目录不存在返回 undefined（不抛错）", () => {
    const result = findSessionFileByHeaderId("/nonexistent/path/foo", "sid");
    expect(result).toBeUndefined();
  });
});
