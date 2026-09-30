// src/__tests__/identity-env.test.ts
//
// [§2.7] 子代理身份 env 写回（引擎侧）单测：值来源分层、深度递增、回落语义。
import { describe, expect, it } from "vitest";

import { SUBAGENT_IDENTITY_ENV } from "@zhushanwen/subagent-engine-sdk";

import { applyIdentityEnvToChildEnv } from "../spawn-runner.ts";

const KEY = SUBAGENT_IDENTITY_ENV;

const BASE_PARAMS = {
  recordId: "sa-child",
  agentName: "reviewer",
  task: "review this",
  cwd: "/repo/worktree",
};

describe("applyIdentityEnvToChildEnv（§2.7 身份 env 写回）", () => {
  it("run 参数面：selfRecordId / agent / task / rootCwd 回落 spawn cwd", () => {
    const env: Record<string, string> = {};
    applyIdentityEnvToChildEnv(env, BASE_PARAMS, {});
    expect(env[KEY.selfRecordId]).toBe("sa-child");
    expect(env[KEY.agent]).toBe("reviewer");
    expect(env[KEY.task]).toBe("review this");
    // 引擎自身没有真 ROOT cwd → 回落本次 spawn cwd
    expect(env[KEY.rootCwd]).toBe("/repo/worktree");
    // 顶层（父进程无 DEPTH）→ 子进程深度 1
    expect(env[KEY.depth]).toBe("1");
    // 缺省 mode = background；无 fork 链、无 worktree、无父 record → 不写
    expect(env[KEY.mode]).toBe("background");
    expect(env[KEY.forkDepth]).toBeUndefined();
    expect(env[KEY.worktree]).toBeUndefined();
    expect(env[KEY.parentRecordId]).toBeUndefined();
    // startedAt / slug 引擎无从得知 → 不写（壳读者各自回落）
    expect(env[KEY.startedAt]).toBeUndefined();
    expect(env[KEY.slug]).toBeUndefined();
  });

  it("嵌套链贯穿：rootSessionId 参数优先、rootCwd 继承、depth+1、父 record 入位", () => {
    const env: Record<string, string> = {};
    applyIdentityEnvToChildEnv(
      env,
      { ...BASE_PARAMS, sessionRootId: "sess-run" },
      {
        [KEY.rootSessionId]: "sess-env",
        [KEY.rootCwd]: "/repo/root",
        [KEY.depth]: "2",
        [KEY.forkDepth]: "1",
        [KEY.selfRecordId]: "sa-parent",
        [KEY.mode]: "chat",
        [KEY.worktree]: "true",
      },
    );
    expect(env[KEY.rootSessionId]).toBe("sess-run");
    expect(env[KEY.rootCwd]).toBe("/repo/root");
    expect(env[KEY.depth]).toBe("3");
    expect(env[KEY.forkDepth]).toBe("1");
    expect(env[KEY.parentRecordId]).toBe("sa-parent");
    expect(env[KEY.mode]).toBe("chat");
    expect(env[KEY.worktree]).toBe("true");
  });

  it("rootSessionId 回落引擎 env；worktree 由 run 声明置位", () => {
    const env: Record<string, string> = {};
    applyIdentityEnvToChildEnv(env, { ...BASE_PARAMS, worktree: true }, { [KEY.rootSessionId]: "sess-env" });
    expect(env[KEY.rootSessionId]).toBe("sess-env");
    expect(env[KEY.worktree]).toBe("true");
  });

  it("覆盖既有 env 值（deny 终态写回的语义：以本次 run 的事实为准）", () => {
    const env: Record<string, string> = { [KEY.selfRecordId]: "stale", [KEY.depth]: "9" };
    applyIdentityEnvToChildEnv(env, BASE_PARAMS, {});
    expect(env[KEY.selfRecordId]).toBe("sa-child");
    expect(env[KEY.depth]).toBe("1");
  });
});
