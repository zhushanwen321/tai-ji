// src/__tests__/temp-prompt.test.ts
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { cleanupTempPrompt, writePromptToTempFile } from "../temp-prompt.ts";

describe("writePromptToTempFile", () => {
  it("创建临时目录 + 写入 prompt 文件", async () => {
    const result = await writePromptToTempFile("test-agent", "You are a helper.");
    expect(result.dir).toBeTruthy();
    expect(result.filePath).toBeTruthy();
    expect(fs.existsSync(result.dir)).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(true);

    const content = fs.readFileSync(result.filePath, "utf-8");
    expect(content).toBe("You are a helper.");

    // 清理
    await cleanupTempPrompt(result);
    expect(fs.existsSync(result.dir)).toBe(false);
  });

  it("agentName 非法字符替换为下划线", async () => {
    const result = await writePromptToTempFile("my agent/v2:spec", "prompt");
    expect(path.basename(result.filePath)).toBe("prompt-my_agent_v2_spec.md");
    await cleanupTempPrompt(result);
  });

  it("文件权限 0o600（仅 owner 读写）", async () => {
    const result = await writePromptToTempFile("secure", "secret prompt");
    const stat = fs.statSync(result.filePath);
    // 只取低 9 位（rwxrwxrwx），忽略文件类型位
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
    await cleanupTempPrompt(result);
  });

  it("多字节内容（中文）正确写入", async () => {
    const result = await writePromptToTempFile("cn", "你是一个助手。");
    const content = fs.readFileSync(result.filePath, "utf-8");
    expect(content).toBe("你是一个助手。");
    await cleanupTempPrompt(result);
  });
});

describe("cleanupTempPrompt", () => {
  it("不存在的目录不抛错（best-effort）", async () => {
    const fake = { dir: "/nonexistent/path/foo", filePath: "/nonexistent/path/foo/p.md" };
    await expect(cleanupTempPrompt(fake)).resolves.not.toThrow();
  });
});
