// run-snapshot.test.ts —— 快照格式版本常量单源。
// [W2 剥离留档 | dwfq-f81a7c55-2] D2 词表删 ask-executing 的编译连带，属 V1 领地，主 agent 恢复补提交。

//
// 唯一活面 = SNAPSHOT_VERSION 值锁定：bump 会让 runtime extractor 版本守卫把
// 存量历史 run 快照整条跳过（历史 run 从 UI 消失）——值变更是显式格式重构
// 决策，不允许顺手漂移。
//
// 纯内存测试：无 configureCore 依赖。

import { describe, expect, it } from "vitest";

import { SNAPSHOT_VERSION } from "../run-snapshot.ts";

describe("run-snapshot — SNAPSHOT_VERSION 值锁定", () => {
  it(`保持 wf-run-v2（不 bump——bump 会让 extractor 守卫清空历史 run）`, () => {
    expect(SNAPSHOT_VERSION).toBe("wf-run-v2");
  });
});
