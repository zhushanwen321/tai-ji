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

  /** 用例共用装配：stub argv/execPath → 调 getPiInvocation（断言由用例自持）。 */
  function invocationOf(argv: string[], execPath: string, userArgs: string[]) {
    Object.defineProperty(process, "argv", { value: argv, configurable: true });
    Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
    return getPiInvocation(userArgs);
  }

  it("本进程从 pi 入口（cli.js）启动 → node <入口> <userArgs>", () => {
    // 创建真实临时脚本文件（避免 ESM spy 限制）；basename 必须精确命中 pi 入口白名单
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-entry-"));
    tmpScript = path.join(tmpDir, "cli.js");
    fs.writeFileSync(tmpScript, "// test");
    const result = invocationOf(["node", tmpScript], "/usr/bin/node", ["--mode", "json", "Task: x"]);
    expect(result.command).toBe("/usr/bin/node");
    expect(result.args).toEqual([tmpScript, "--mode", "json", "Task: x"]);
  });

  it("本进程从 npm bin（pi）启动 → node <bin> <userArgs>", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bin-"));
    tmpScript = path.join(tmpDir, "pi");
    fs.writeFileSync(tmpScript, "#!/usr/bin/env node");
    const result = invocationOf(["node", tmpScript], "/usr/bin/node", ["--mode", "json"]);
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
    const result = invocationOf(["node", tmpScript], "/usr/bin/node", ["--mode", "rpc"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "rpc"]);
    expect(result.args[0]).not.toBe(tmpScript);
  });

  it("引擎 npm bin 形态（pi-subagent-cli.mjs 真实文件）→ 不得复现，落 PATH", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bin-"));
    tmpScript = path.join(tmpDir, "pi-subagent-cli.mjs");
    fs.writeFileSync(tmpScript, "// engine bin");
    const result = invocationOf(["node", tmpScript], "/usr/bin/node", ["--mode", "rpc"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "rpc"]);
  });

  it("bun 虚拟脚本（/$bunfs/root/）→ 退化到 pi-in-PATH", () => {
    tmpScript = "";
    const virtualScript = "/$bunfs/root/pi";
    const result = invocationOf(["bun", virtualScript], "/usr/bin/bun", ["--mode", "json"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "json"]);
  });

  it("非通用 runtime + pi standalone binary 命名（pi-darwin-arm64）→ 直接 execPath", () => {
    tmpScript = "";
    const result = invocationOf(
      ["/opt/pi/pi-darwin-arm64", "/nonexistent"],
      "/opt/pi/pi-darwin-arm64",
      ["--mode", "json"],
    );
    expect(result.command).toBe("/opt/pi/pi-darwin-arm64");
    expect(result.args).toEqual(["--mode", "json"]);
  });

  it("非通用 runtime + npm bin 命名（pi）→ 直接 execPath", () => {
    tmpScript = "";
    const result = invocationOf(["/opt/pi/pi", "/nonexistent"], "/opt/pi/pi", ["--mode", "json"]);
    expect(result.command).toBe("/opt/pi/pi");
    expect(result.args).toEqual(["--mode", "json"]);
  });

  it("打包态 Electron 执行器形态（execPath = TaiJi.app 二进制）→ 不得直接 spawn，落 PATH", () => {
    // 回归锚点（2026-10 实测事故）：runtime 以宿主 Electron 二进制作 node 执行器
    // spawn 引擎 CLI（ELECTRON_RUN_AS_NODE=1），引擎进程 execPath 是 Electron 而非
    // pi 二进制——原「非 node/bun 即 pi binary」假设把它当 pi 直接 spawn，node 选项
    // 解析器拒掉 --mode（"bad option: --mode"，exit 9，subagent/workflow 派发全灭）。
    // 正确通路 = 分支 3（pi 走 PATH；runtime 引擎 env 注入 pi 目录作 PATH 前缀）。
    tmpScript = "";
    const result = invocationOf(
      ["/Applications/TaiJi.app/Contents/MacOS/TaiJi", "/opt/engines/pi/index.js"],
      "/Applications/TaiJi.app/Contents/MacOS/TaiJi",
      ["--mode", "rpc"],
    );
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "rpc"]);
  });

  it("node 通用 runtime + 脚本不存在 → pi-in-PATH", () => {
    tmpScript = "";
    const result = invocationOf(["node", "/nonexistent"], "/usr/bin/node", ["--mode", "json"]);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--mode", "json"]);
  });

  it("空 userArgs 合法（仅 command + 空 args）", () => {
    tmpScript = "";
    const result = invocationOf(["node"], "/usr/bin/node", []);
    expect(result.command).toBe("pi");
    expect(result.args).toEqual([]);
  });
});
