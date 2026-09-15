// nesting-guard.test.ts —— 嵌套标记注入与原生标记剥离（D8 双层防护）。
//
// 实现体已收编 @zhushanwen/subagent-engine-sdk（common/nesting-guard.ts 为
// re-export shim，s4-reuse 簇 2）：SDK 侧 __tests__/primitives.test.ts 已有同语义
// 断言，本文件保留 core 侧独有细粒度断言——精确名 vs 前缀剥离边界（CLAUDE_UNRELATED）、
// 非 '1' 值不抛、空白 env 最小产出。错误形态随收编改 NestedSpawnRejectedError
//（code/recovery 文案与 core 词表逐字一致）。
//
// 三视角：①构建者——三引擎原生标记（PI_SUBAGENT_* / CLAUDECODE / ZSW_NESTED）全部
// 剥离且其余 env 保留；②使用者——子代理进程内 assertNotNestedSpawn 同步拒绝且文案
// 可操作；③观察者——产出的 env 是新对象（不污染入参）。

import { describe, expect, it } from "vitest";

import {
  assertNotNestedSpawn,
  buildNestedSpawnEnv,
  NestedSpawnRejectedError,
  NESTED_SPAWN_ENV,
} from "../../common/nesting-guard.ts";

describe("buildNestedSpawnEnv", () => {
  it("注入统一标记 TAIJI_AGENT_SUBAGENT=1", () => {
    const env = buildNestedSpawnEnv({ PATH: "/usr/bin" });
    expect(env[NESTED_SPAWN_ENV]).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("剥离 pi 原生标记 PI_SUBAGENT_*（任意后缀）", () => {
    const env = buildNestedSpawnEnv({
      PI_SUBAGENT_ID: "bg-1",
      PI_SUBAGENT_CWD: "/tmp/x",
      PI_SUBAGENT_SESSION: "abc",
      KEEP_ME: "yes",
    });
    expect("PI_SUBAGENT_ID" in env).toBe(false);
    expect("PI_SUBAGENT_CWD" in env).toBe(false);
    expect("PI_SUBAGENT_SESSION" in env).toBe(false);
    expect(env.KEEP_ME).toBe("yes");
  });

  it("剥离 CC 与 zsub 的原生标记（CLAUDECODE / ZSW_NESTED）", () => {
    const env = buildNestedSpawnEnv({
      CLAUDECODE: "1",
      ZSW_NESTED: "1",
      CLAUDE_UNRELATED: "keep", // 非嵌套标记的 CLAUDE_ 前缀不受影响
    });
    expect("CLAUDECODE" in env).toBe(false);
    expect("ZSW_NESTED" in env).toBe(false);
    expect(env.CLAUDE_UNRELATED).toBe("keep");
  });

  it("返回新对象，不 mutate 入参（spawn env 组装链安全）", () => {
    const base = { PATH: "/usr/bin", PI_SUBAGENT_ID: "x" };
    const env = buildNestedSpawnEnv(base);
    expect(base.PI_SUBAGENT_ID).toBe("x");
    expect("TAIJI_AGENT_SUBAGENT" in base).toBe(false);
    expect(env).not.toBe(base);
  });

  it("空白 env 也能产出仅含标记的最小 env", () => {
    const env = buildNestedSpawnEnv({});
    expect(env).toEqual({ [NESTED_SPAWN_ENV]: "1" });
  });
});

describe("assertNotNestedSpawn", () => {
  it("检测到统一标记（本进程已是 subagent）→ 抛 nested_spawn_rejected", () => {
    expect(() => assertNotNestedSpawn({ [NESTED_SPAWN_ENV]: "1" })).toThrowError(NestedSpawnRejectedError);
    try {
      assertNotNestedSpawn({ [NESTED_SPAWN_ENV]: "1" });
      expect.unreachable("should throw");
    } catch (err) {
      const e = err as NestedSpawnRejectedError;
      expect(e.code).toBe("nested_spawn_rejected");
      // 文案说明防护规则（标记名）+ 指向 task 内自行完成
      expect(e.message).toContain("TAIJI_AGENT_SUBAGENT");
      expect(e.recovery).toMatch(/inside the current task/);
    }
  });

  it("无标记 / 值非 '1' → 不抛（顶层进程正常派发）", () => {
    expect(() => assertNotNestedSpawn({})).not.toThrow();
    expect(() => assertNotNestedSpawn({ [NESTED_SPAWN_ENV]: "0" })).not.toThrow();
    expect(() => assertNotNestedSpawn({ [NESTED_SPAWN_ENV]: undefined })).not.toThrow();
  });
});
