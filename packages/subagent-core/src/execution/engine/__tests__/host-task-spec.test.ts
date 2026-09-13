// host-task-spec.test.ts —— ExecuteOptions → AgentCallOpts 直译映射单测（fork-from 载体）。
//
// 背景（W3 断链修复）：fork-from 的 ExecuteOptions.forkFromSessionFile 在 chat 域协议化
// 改写后曾断链（本 mapper 不映射 → 协议 run 帧无承载位 → fork-from 轮次以无 --fork 的
// 全新 session 跑，继承历史丢失）。本文件钉死宿主侧映射面：forkFromSessionFile →
// forkSource 改名透传（三层同名的唯一改名点）+ 缺省不落键（协议负向兼容）。
// 端到端消费链由两侧专项覆盖：
//   - chat 域执行链观测（subagent-workflow ended-message-and-fork-from.test 的 fake.runs）；
//   - pi 引擎接收面（pi-subagent-cli chat-protocol.test 一次性 run + spawn-args.test
//     的 forkSource → --fork 直测）。

import { describe, expect, it } from "vitest";

import { executeOptionsToEngineTaskSpec } from "../host-task-spec.ts";
import type { ExecuteOptions } from "../../assembly/types.ts";

function baseOpts(): ExecuteOptions {
  return { task: "do work", slug: "map-test" };
}

describe("executeOptionsToEngineTaskSpec（ExecuteOptions → AgentCallOpts 直译）", () => {
  it("forkFromSessionFile 存在 → forkSource 透传（fork-from 协议载体的宿主侧源头）", () => {
    const spec = executeOptionsToEngineTaskSpec({
      ...baseOpts(),
      forkFromSessionFile: "/sessions/sa-src.jsonl",
    });
    expect(spec.forkSource).toBe("/sessions/sa-src.jsonl");
    expect(spec.prompt).toBe("do work");
  });

  it("缺省 → 键不落（负向兼容：无 fork-from 的调用帧形状不变）", () => {
    const spec = executeOptionsToEngineTaskSpec(baseOpts());
    expect("forkSource" in spec).toBe(false);
  });

  it("fork 与 forkSource 互不挤占（独立可选透传；取值优先级语义归引擎侧）", () => {
    const spec = executeOptionsToEngineTaskSpec({
      ...baseOpts(),
      fork: true,
      forkFromSessionFile: "/sessions/sa-src.jsonl",
    });
    expect(spec.fork).toBe(true);
    expect(spec.forkSource).toBe("/sessions/sa-src.jsonl");
  });
});
