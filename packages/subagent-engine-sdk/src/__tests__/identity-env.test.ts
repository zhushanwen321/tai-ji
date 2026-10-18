// src/__tests__/identity-env.test.ts
//
// [M1 u-foundation] 身份 env 契约常量测试：PI_SUBAGENT_TASK_MAX_CHARS（D2 截断上限）
// + 任务键名稳定性。写入点（pi 引擎 spawn-runner applyContentIdentityKeys，截断实现）
// 与读取点（appendSubagentIdentityEntry，零改动）在 u-m2-engine-ack / 既有测试覆盖，
// 本文件锁契约面常量。

import { describe, expect, it } from "vitest";

import { PI_SUBAGENT_TASK_MAX_CHARS, SUBAGENT_IDENTITY_ENV } from "../index.ts";

describe("PI_SUBAGENT_TASK_MAX_CHARS（设计 D2：任务文本 env 写入截断上限）", () => {
  it("恒 2000 字符（写入点 = 前 2000 字符 + 截断标记 …[truncated N chars]；ARG_MAX/E2BIG 无界暴露的写入点根因修复）", () => {
    expect(PI_SUBAGENT_TASK_MAX_CHARS).toBe(2000);
  });

  it("截断作用键 = SUBAGENT_IDENTITY_ENV.task（键名 PI_SUBAGENT_TASK 稳定——写入方/读取方/壳读者三方契约）", () => {
    expect(SUBAGENT_IDENTITY_ENV.task).toBe("PI_SUBAGENT_TASK");
  });
});
