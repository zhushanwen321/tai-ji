// src/__tests__/pi-invocation.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPiInvocation } from "../pi-invocation.ts";
import {
  RELAY_ENV_NODE,
  RELAY_ENV_RECORD_ID,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_SOCKET,
} from "@zhushanwen/subagent-engine-sdk";

// [验收门修复] getPiInvocation 的 relay 分支优先读宿主 RELAY env——根级 pnpm test
// 进程若继承宿主（pi 子进程链）的 RELAY 身份，直连分支用例的 execPath/argv 断言
// 会被改道（非自免疫，依赖 runner 环境）。文件级钩子对全部用例统一消毒：beforeEach
// 删五键、afterEach 恢复原值——有泄漏无泄漏双向绿；第二组 relay 分支用例自设
// RELAY_FULL 在清理之后执行，语义不受影响。
const RELAY_ENV_KEYS = [
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
] as const;
let savedRelayEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedRelayEnv = {};
  for (const key of RELAY_ENV_KEYS) savedRelayEnv[key] = process.env[key];
  for (const key of RELAY_ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of RELAY_ENV_KEYS) {
    const value = savedRelayEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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

describe("getPiInvocation relay 分支（E 方案 §5.1）", () => {
  const originalArgv = process.argv;
  const originalExecPath = process.execPath;
  const RELAY_ENVS = [RELAY_ENV_SOCKET, RELAY_ENV_NODE, RELAY_ENV_SCRIPT] as const;
  /** 三 env 齐备的基准值（改 argv/execPath 隔离直连分支，只测 relay 判定本身）。 */
  const RELAY_FULL: Record<string, string> = {
    [RELAY_ENV_SOCKET]: "/tmp/relay-test.sock",
    [RELAY_ENV_NODE]: "/usr/bin/relay-node",
    [RELAY_ENV_SCRIPT]: "/opt/relay/relay.mjs",
  };

  afterEach(() => {
    Object.defineProperty(process, "argv", { value: originalArgv, configurable: true });
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    for (const key of RELAY_ENVS) delete process.env[key];
  });

  /** 形态 1：三 env 齐备 + 默认 opts → relay invocation（command=NODE、args[0]=SCRIPT）。 */
  it("三 env 齐备（无 opts）→ 代理形态 <NODE> <SCRIPT> <userArgs>", () => {
    Object.assign(process.env, RELAY_FULL);
    const result = getPiInvocation(["--mode", "rpc"]);
    expect(result.command).toBe(RELAY_FULL[RELAY_ENV_NODE]);
    expect(result.args).toEqual([RELAY_FULL[RELAY_ENV_SCRIPT], "--mode", "rpc"]);
  });

  /** 形态 1 变体：opts.relay === true 显式开启，行为与缺省一致。 */
  it("三 env 齐备 + opts.relay=true → 同缺省（显式开启非必填）", () => {
    Object.assign(process.env, RELAY_FULL);
    const result = getPiInvocation(["--mode", "rpc"], { relay: true });
    expect(result.command).toBe(RELAY_FULL[RELAY_ENV_NODE]);
    expect(result.args[0]).toBe(RELAY_FULL[RELAY_ENV_SCRIPT]);
  });

  /** 形态 2：三缺一逐个枚举 → 回落现状直连（全有或全无，E-TUI 零回归）。 */
  it("三缺一（逐个枚举）→ 现状直连分支", () => {
    // 直连分支落到「node + 不存在脚本 → pi-in-PATH」可稳定断言（不依赖测试机 execPath 形态）
    Object.defineProperty(process, "argv", { value: ["node", "/nonexistent"], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });
    for (const missing of RELAY_ENVS) {
      const partial = { ...RELAY_FULL };
      delete partial[missing];
      for (const key of RELAY_ENVS) delete process.env[key];
      Object.assign(process.env, partial);
      const result = getPiInvocation(["--mode", "rpc"]);
      expect(result.command).toBe("pi"); // 分支 3：通用 runtime + 脚本不存在 → PATH
      expect(result.args).toEqual(["--mode", "rpc"]);
    }
  });

  /** 形态 3：probe 排除——显式 relay:false 时即便三 env 齐备也直连。 */
  it("relay:false 强制直连（probe 语义：探 pi 本体，不探 runtime 健康）", () => {
    Object.assign(process.env, RELAY_FULL);
    Object.defineProperty(process, "argv", { value: ["node", "/nonexistent"], configurable: true });
    Object.defineProperty(process, "execPath", { value: "/usr/bin/node", configurable: true });
    const result = getPiInvocation(["--version"], { relay: false });
    expect(result.command).toBe("pi");
    expect(result.args).toEqual(["--version"]);
  });
});
