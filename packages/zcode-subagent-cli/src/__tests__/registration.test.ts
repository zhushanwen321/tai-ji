// registration.test.ts —— 引擎包构造入口（W5 迁移改写）。
//
// 原 core 版测的是 registerZcodeEngine → core registry 接线；引擎包无 core
// registry（发现/装载走 manifest + 宿主发现器，见 registration.ts 文件头），本文件
// 改测包内构造面：DI 工厂、engineDataDir 的 SDK env 解析通道、TAIJI_ZCODE_CLI 覆盖。
// （deviation 登记：core 版注册表断言留在 core 侧原文件——过渡期双轨。）

import { afterEach, describe, expect, it, vi } from "vitest";

import { TAIJI_DATA_DIR_ENV } from "@zhushanwen/subagent-engine-sdk";

import {
  createDefaultZcodeEngine,
  createZcodeEngine,
  defaultEngineDataDir,
} from "../registration.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createZcodeEngine（DI 工厂）", () => {
  it("deps 直达引擎：id/capabilities 正确", () => {
    const engine = createZcodeEngine({ engineDataDir: () => "/tmp/x" });
    expect(engine.id).toBe("zcode");
    expect(engine.capabilities().schemaEnforcement).toBe("emulated");
    expect(engine.capabilities().maxTurns).toBe(false);
  });
});

describe("engineDataDir 默认通道（SDK resolveEngineDataDir）", () => {
  it("env 注入即取 env 值（宿主 buildEngineChildEnv L0 注入链的透传证据）", () => {
    const prev = process.env["TAIJI_AGENT_DATA_DIR"];
    process.env["TAIJI_AGENT_DATA_DIR"] = "/from-host";
    try {
      expect(defaultEngineDataDir()).toBe("/from-host");
    } finally {
      if (prev !== undefined) process.env["TAIJI_AGENT_DATA_DIR"] = prev;
      else delete process.env["TAIJI_AGENT_DATA_DIR"];
    }
  });

  it("env 缺失 → 显式报错（不再回退 piAgentDir——引擎进程内无 pi 语义可回退）", () => {
    const prev = process.env["TAIJI_AGENT_DATA_DIR"];
    delete process.env["TAIJI_AGENT_DATA_DIR"];
    try {
      expect(() => defaultEngineDataDir()).toThrow(new RegExp(TAIJI_DATA_DIR_ENV));
    } finally {
      if (prev !== undefined) process.env["TAIJI_AGENT_DATA_DIR"] = prev;
      else delete process.env["TAIJI_AGENT_DATA_DIR"];
    }
  });
});

describe("createDefaultZcodeEngine（缺省组合根）", () => {
  it("TAIJI_ZCODE_CLI 设置时透传 cliPath 覆盖（spawn-env-contract 出站白名单条目）", async () => {
    const prev = process.env["TAIJI_AGENT_DATA_DIR"];
    const prevCli = process.env["TAIJI_ZCODE_CLI"];
    process.env["TAIJI_AGENT_DATA_DIR"] = "/tmp/eng-data";
    process.env["TAIJI_ZCODE_CLI"] = "/tmp/fake-zcode.cjs";
    try {
      const engine = createDefaultZcodeEngine();
      // deps 是私有面——经 probe 的二进制检查路径间接断言（probeVersion 不注入时
      // defaultProbeVersion 才被消费；这里只验证构造不 throw + id 正确，路径断言经
      // ZcodeEngineDeps 直构路径在 appserver 测试覆盖）
      expect(engine.id).toBe("zcode");
    } finally {
      if (prev !== undefined) process.env["TAIJI_AGENT_DATA_DIR"] = prev;
      else delete process.env["TAIJI_AGENT_DATA_DIR"];
      if (prevCli !== undefined) process.env["TAIJI_ZCODE_CLI"] = prevCli;
      else delete process.env["TAIJI_ZCODE_CLI"];
    }
  });
});
