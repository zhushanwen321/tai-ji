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
  let tmpDir: string | undefined;

  afterEach(() => {
    Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    if (tmpScript && fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript);
    if (tmpDir !== undefined && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
    tmpDir = undefined;
  });

  it("本进程从 pi 入口（cli.js）启动 → node <入口> <userArgs>", () => {
    // 创建真实临时脚本文件（避免 ESM spy 限制）；basename 必须精确命中 pi 入口白名单
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-entry-"));
    tmpScript = path.join(tmpDir, "cli.js");
    fs.writeFileSync(tmpScript, "// test");
    Object.defineProperty(process, "argv", { value: ["node", tmpScript], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });

    const result = getPiInvocation(["--mode", "json", "Task: x"]);
    expect(result.command).toBe("/usr/bin/node");
    expect(result.args).toEqual([tmpScript, "--mode", "json", "Task: x"]);
  });

  it("本进程从 npm bin（pi）启动 → node <bin> <userArgs>", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bin-"));
    tmpScript = path.join(tmpDir, "pi");
    fs.writeFileSync(tmpScript, "#!/usr/bin/env node");
    Object.defineProperty(process, "argv", { value: ["node", tmpScript], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });

    const result = getPiInvocation(["--mode", "json"]);
    expect(result.command).toBe("/usr/bin/node");
    expect(result.args).toEqual([tmpScript, "--mode", "json"]);
  });

  it("staged 引擎形态（argv[1] = engines/<id>/index.js 真实文件）→ 不得复现，落 PATH", () => {
    // 回归锚点：staged 引擎入口 basename 是 index.js，不在 pi 入口白名单——
    // 复现它等于递归 spawn 引擎自身（对 pi 指令零应答，送达看门狗判死）。
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-pi-"));
    tmpDir = stagedDir;
    tmpScript = path.join(stagedDir, "index.js");
    fs.writeFileSync(tmpScript, "// staged engine bundle");
    Object.defineProperty(process, "argv", { value: ["node", tmpScript], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });

    const result = getPiInvocation(["--mode", "rpc"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "rpc"]);
    expect(result.args[0]).not.toBe(tmpScript);
  });

  it("引擎 npm bin 形态（pi-subagent-cli.mjs 真实文件）→ 不得复现，落 PATH", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bin-"));
    tmpScript = path.join(tmpDir, "pi-subagent-cli.mjs");
    fs.writeFileSync(tmpScript, "// engine bin");
    Object.defineProperty(process, "argv", { value: ["node", tmpScript], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });

    const result = getPiInvocation(["--mode", "rpc"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "rpc"]);
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
