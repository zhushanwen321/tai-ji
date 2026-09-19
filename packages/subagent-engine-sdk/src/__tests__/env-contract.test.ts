// src/__tests__/env-contract.test.ts
//
// buildEngineChildEnv 三层契约（W12，impl-plan §2.12 三层表逐行）+ buildOutboundChildEnv
// 出站卫生 + 守卫断言「L0 基础设施键集合 ∩ L1 deny/剥除集合 = ∅」。
// 三层表的每条规格在此对应至少一个断言：L0 注入项 / L1 恒高于 manifest 放行 /
// L2 保留前缀拒绝 + 形态校验 + 非法丢弃 warn + 未声明不放行 warn。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildEngineChildEnv,
  buildOutboundChildEnv,
  ENGINE_ENV_DENY_LIST,
  ENGINE_ENV_L0_INFRA_KEYS,
  SHARED_POOL_KEY,
  type LoggerSink,
  configureLoggerSink,
  resetLoggerSinkForTests,
} from "../index.ts";

/** warn 捕获 sink（断言「非法条目丢弃 + warn」的 warn 半边）。 */
function captureSink(): { sink: LoggerSink; warns: string[] } {
  const warns: string[] = [];
  return { sink: { log: (level, _component, message) => { if (level === "warn") warns.push(message); } }, warns };
}

describe("buildEngineChildEnv 三层契约", () => {
  let cap: ReturnType<typeof captureSink>;
  beforeEach(() => {
    cap = captureSink();
    configureLoggerSink(cap.sink);
  });
  afterEach(() => {
    resetLoggerSinkForTests();
  });

  it("L1：deny/剥除键从 baseEnv 剥除（大小写不敏感）", () => {
    const env = buildEngineChildEnv(
      {
        PATH: "/usr/bin",
        TAIJI_AGENT_PACKAGED: "1",
        taiji_runtime_token: "tok",
        TAIJI_AGENT_API_KEY: "k",
        TAIJI_SUBAGENT_RELAY_SESSION_ID: "parent",
        TAIJI_SUBAGENT_RELAY_RECORD_ID: "r",
      },
      { dataDir: "/d" },
    );
    expect(env.PATH).toBe("/usr/bin");
    for (const key of ENGINE_ENV_DENY_LIST) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.taiji_runtime_token).toBeUndefined();
  });

  it("L0：基础设施键注入（dataDir/engineNode/ELECTRON_RUN_AS_NODE/SUBAGENT/relay/identity）", () => {
    const env = buildEngineChildEnv({}, {
      dataDir: "/data-root",
      engineNode: "/exec/node",
      electronRunAsNode: true,
      relay: { socket: "/s", node: "/n", script: "/sc" },
      identityEnv: { PI_SUBAGENT_ROOT_SESSION_ID: "sid", PI_SUBAGENT_DEPTH: undefined },
    });
    expect(env.TAIJI_AGENT_DATA_DIR).toBe("/data-root");
    expect(env.TAIJI_AGENT_ENGINE_NODE).toBe("/exec/node");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.TAIJI_AGENT_SUBAGENT).toBe("1");
    expect(env.TAIJI_SUBAGENT_RELAY_SOCKET).toBe("/s");
    expect(env.TAIJI_SUBAGENT_RELAY_NODE).toBe("/n");
    expect(env.TAIJI_SUBAGENT_RELAY_SCRIPT).toBe("/sc");
    expect(env.PI_SUBAGENT_ROOT_SESSION_ID).toBe("sid");
    expect(env.PI_SUBAGENT_DEPTH).toBeUndefined();
  });

  it("L0：ELECTRON_RUN_AS_NODE 条件注入（非 Electron 执行器不注入）", () => {
    const env = buildEngineChildEnv({}, { dataDir: "/d", engineNode: "/bin/node" });
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("次序写死：先 L1 过滤后 L0 注入——baseEnv 的同名键被 L0 显式值覆盖", () => {
    const env = buildEngineChildEnv(
      { TAIJI_AGENT_DATA_DIR: "/stale" },
      { dataDir: "/fresh" },
    );
    expect(env.TAIJI_AGENT_DATA_DIR).toBe("/fresh");
  });

  it("L2：声明前缀放行 processEnv 键（大小写不敏感前缀匹配）", () => {
    const env = buildEngineChildEnv(
      {},
      { dataDir: "/d", envPrefixes: ["MYENGINE_"], processEnv: { MYENGINE_TOKEN: "t", myengine_lower: "l" } },
    );
    expect(env.MYENGINE_TOKEN).toBe("t");
    expect(env.myengine_lower).toBe("l");
  });

  it("L2：保留前缀（TAIJI_/TAIJI_AGENT_/TAIJI_SUBAGENT_）拒绝 + warn", () => {
    const env = buildEngineChildEnv(
      {},
      { dataDir: "/d", envPrefixes: ["TAIJI_HACK_"], processEnv: { TAIJI_HACK_X: "1" } },
    );
    expect(env.TAIJI_HACK_X).toBeUndefined();
    expect(cap.warns.some((w) => w.includes("reserved prefix"))).toBe(true);
  });

  it("L2：非法形态前缀丢弃 + warn（包继续可用）", () => {
    const env = buildEngineChildEnv(
      {},
      { dataDir: "/d", envPrefixes: ["BAD-PREFIX!", "MYENGINE_"], processEnv: { MYENGINE_A: "1" } },
    );
    expect(env.MYENGINE_A).toBe("1");
    expect(cap.warns.some((w) => w.includes("invalid shape"))).toBe(true);
  });

  it("L2：未声明前缀的 processEnv 键不放行 + warn", () => {
    const env = buildEngineChildEnv(
      {},
      { dataDir: "/d", envPrefixes: ["MYENGINE_"], processEnv: { OTHER_X: "1" } },
    );
    expect(env.OTHER_X).toBeUndefined();
    expect(cap.warns.some((w) => w.includes("OTHER_X"))).toBe(true);
    const envNoPrefix = buildEngineChildEnv(
      {},
      { dataDir: "/d", processEnv: { OTHER_X: "1" } },
    );
    expect(envNoPrefix.OTHER_X).toBeUndefined();
  });

  it("L1 恒高于 L2：deny 键不能经声明前缀从 baseEnv 或 processEnv 回来", () => {
    const env = buildEngineChildEnv(
      { TAIJI_AGENT_API_KEY: "leak" },
      { dataDir: "/d", envPrefixes: ["TAIJI_"], processEnv: { TAIJI_RUNTIME_TOKEN: "leak2" } },
    );
    expect(env.TAIJI_AGENT_API_KEY).toBeUndefined();
    expect(env.TAIJI_RUNTIME_TOKEN).toBeUndefined();
  });

  it("纯函数：不 mutate baseEnv / processEnv 入参", () => {
    const base = { TAIJI_AGENT_PACKAGED: "1", KEEP: "k" };
    const proc = { MYENGINE_A: "1" };
    buildEngineChildEnv(base, { dataDir: "/d", envPrefixes: ["MYENGINE_"], processEnv: proc });
    expect(base).toEqual({ TAIJI_AGENT_PACKAGED: "1", KEEP: "k" });
    expect(proc).toEqual({ MYENGINE_A: "1" });
  });

  it("守卫断言：L0 基础设施键集合 ∩ L1 deny/剥除集合 = ∅", () => {
    const denySet = new Set(ENGINE_ENV_DENY_LIST);
    const overlap = ENGINE_ENV_L0_INFRA_KEYS.filter((k) => denySet.has(k));
    expect(overlap).toEqual([]);
  });
});

describe("buildOutboundChildEnv（SDK 版出站卫生）", () => {
  it("缺省全量继承父 env + deny 剥除（worktree git 场景）", () => {
    const env = buildOutboundChildEnv({
      parentEnv: {
        PATH: "/usr/bin",
        GIT_SSH_COMMAND: "ssh",
        TAIJI_AGENT_PACKAGED: "1",
        TAIJI_RUNTIME_TOKEN: "tok",
        TAIJI_AGENT_API_KEY: "k",
        TAIJI_SUBAGENT_RELAY_SESSION_ID: "s",
      },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_SSH_COMMAND).toBe("ssh");
    expect(env.TAIJI_AGENT_PACKAGED).toBeUndefined();
    expect(env.TAIJI_RUNTIME_TOKEN).toBeUndefined();
    expect(env.TAIJI_AGENT_API_KEY).toBeUndefined();
    expect(env.TAIJI_SUBAGENT_RELAY_SESSION_ID).toBeUndefined();
  });

  it("extras 注入 / undefined 删除语义", () => {
    const env = buildOutboundChildEnv({
      parentEnv: { A: "1", B: "2" },
      extras: { B: undefined, C: "3" },
    });
    expect(env).toEqual({ A: "1", C: "3" });
  });

  it("显式 prefixes 时按白名单过滤（大小写不敏感）", () => {
    const env = buildOutboundChildEnv({
      parentEnv: { PATH: "/bin", systemroot: "C:\\Windows", SECRET: "x" },
      prefixes: ["PATH", "SYSTEMROOT"],
    });
    expect(env).toEqual({ PATH: "/bin", systemroot: "C:\\Windows" });
  });
});

describe("常量镜像自洽", () => {
  it("ENGINE_ENV_L0_INFRA_KEYS 无重复", () => {
    expect(new Set(ENGINE_ENV_L0_INFRA_KEYS).size).toBe(ENGINE_ENV_L0_INFRA_KEYS.length);
  });

  it("SHARED_POOL_KEY 值锚定 'shared'（存量 journal 落盘路径分段，L3 收编后改名不改值）", () => {
    expect(SHARED_POOL_KEY).toBe("shared");
  });

  it("deny 清单含模式回落两键（SDK 镜像与 shared SSOT 逐项相等由 check_env_whitelist_sync.py 兜底；本断言防镜像内单侧漏项）", () => {
    expect(ENGINE_ENV_DENY_LIST).toContain("TAIJI_PRESET_FALLBACK_FROM");
    expect(ENGINE_ENV_DENY_LIST).toContain("TAIJI_PRESET_FALLBACK_TO");
  });
});
