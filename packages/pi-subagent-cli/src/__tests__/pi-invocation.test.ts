// src/__tests__/pi-invocation.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getPiInvocation } from "../pi-invocation.ts";

describe("getPiInvocation", () => {
  const originalArgv = process.argv;
  const originalExecPath = process.execPath;
  let tmpScript: string;

  afterEach(() => {
    Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    if (tmpScript && fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript);
  });

  it("真实脚本路径存在 → node <script> <userArgs>", () => {
    // 创建真实临时脚本文件（避免 ESM spy 限制）
    tmpScript = path.join(os.tmpdir(), `pi-inv-test-${Date.now()}.mjs`);
    fs.writeFileSync(tmpScript, "// test");
    Object.defineProperty(process, "argv", { value: ["node", tmpScript], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });

    const result = getPiInvocation(["--mode", "json", "Task: x"]);
    expect(result.command).toBe("/usr/bin/node");
    expect(result.args).toEqual([tmpScript, "--mode", "json", "Task: x"]);
  });

  it("bun 虚拟脚本（/$bunfs/root/）→ 退化到 pi-in-PATH", () => {
    tmpScript = "";
    const virtualScript = "/$bunfs/root/pi";
    Object.defineProperty(process, "argv", { value: ["bun", virtualScript], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/bun", configurable: true });

    const result = getPiInvocation(["--mode", "json"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "json"]);
  });

  it("非通用 runtime（pi standalone binary）→ 直接 execPath", () => {
    tmpScript = "";
    Object.defineProperty(process, "argv", { value: ["/usr/bin/pi", "/nonexistent"], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/local/bin/pi-binary", configurable: true });

    const result = getPiInvocation(["--mode", "json"]);
    expect(result.command).toBe("/usr/local/bin/pi-binary");
    expect(result.args).toEqual(["--mode", "json"]);
  });

  it("node 通用 runtime + 脚本不存在 → pi-in-PATH", () => {
    tmpScript = "";
    Object.defineProperty(process, "argv", { value: ["node", "/nonexistent"], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });

    const result = getPiInvocation(["--mode", "json"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "json"]);
  });

  it("空 userArgs 合法（仅 command + 空 args）", () => {
    tmpScript = "";
    Object.defineProperty(process, "argv", { value: ["node"], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });

    const result = getPiInvocation([]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual([]);
  });
});
