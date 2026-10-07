// src/__tests__/record-model-override.test.ts
//
// [subagent-model-switch u-foundation] modelOverride 用户覆盖记账字段的轻量契约测试：
// ① 序列化/反序列化往返保形（record 持久化经 JSON 条目投影，ref 对象 + setAt 数值
//    必须无损往返）；② 旧记录（无字段）兼容读取（可选字段向后兼容——undefined 即
//    「从未被用户覆盖」，旧 session 文件反序列化不破）。
//
// 行为实装（setModel 编排 / 解析链第 0 层 / entry 持久化投影）归 U2，不在本测试范围。

import { describe, expect, it } from "vitest";

import type { ExecutionRecord, ModelOverride } from "../execution/domain/record-model.ts";

/** 最小合法 ExecutionRecord（必填字段全给；与状态机语义无关的执行内容留空）。 */
function minimalRecord(): ExecutionRecord {
  return {
    id: "bg-1-abc",
    agent: "general-purpose",
    model: "zai-coding-cn/glm-5.3",
    thinkingLevel: undefined,
    mode: "background",
    task: "demo task",
    slug: "demo",
    startedAt: 1_000,
    rootSessionId: "root-s1",
    parentRecordId: undefined,
    depth: 0,
    status: "running",
    turns: [],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,
    controller: undefined,
  };
}

describe("modelOverride 用户覆盖记账字段契约", () => {
  it("带覆盖值的 record 经 JSON 往返后逐字段保形", () => {
    const override: ModelOverride = {
      ref: { provider: "zai-coding-cn", modelId: "glm-5.3-flash" },
      thinkingLevel: "high",
      setAt: 1_760_000_000_000,
    };
    const record: ExecutionRecord = { ...minimalRecord(), modelOverride: override };

    const roundTripped = JSON.parse(JSON.stringify(record)) as ExecutionRecord;

    expect(roundTripped.modelOverride).toEqual(override);
    expect(roundTripped.modelOverride?.ref).toEqual({
      provider: "zai-coding-cn",
      modelId: "glm-5.3-flash",
    });
    expect(roundTripped.modelOverride?.thinkingLevel).toBe("high");
    expect(roundTripped.modelOverride?.setAt).toBe(1_760_000_000_000);
  });

  it("覆盖值缺省 thinkingLevel（用户未选档位）时往返保持缺省不虚填", () => {
    const override: ModelOverride = {
      ref: { provider: "zai-coding-cn", modelId: "glm-5.3" },
      setAt: 1_760_000_000_001,
    };
    const record: ExecutionRecord = { ...minimalRecord(), modelOverride: override };

    const roundTripped = JSON.parse(JSON.stringify(record)) as ExecutionRecord;

    expect(roundTripped.modelOverride).toEqual(override);
    expect(roundTripped.modelOverride?.thinkingLevel).toBeUndefined();
    expect(Object.hasOwn(roundTripped.modelOverride ?? {}, "thinkingLevel")).toBe(false);
  });

  it("旧记录（无 modelOverride 字段）兼容读取：反序列化后字段 undefined，记录其余面不受损", () => {
    const legacy = minimalRecord();
    // 模拟旧 session 文件条目：无 modelOverride 键（序列化前也不存在该键）。
    expect(Object.hasOwn(legacy, "modelOverride")).toBe(false);

    const roundTripped = JSON.parse(JSON.stringify(legacy)) as ExecutionRecord;

    expect(roundTripped.modelOverride).toBeUndefined();
    expect(Object.hasOwn(roundTripped, "modelOverride")).toBe(false);
    // 兼容读取 = 旧记录其余字段照常可用。
    expect(roundTripped.id).toBe("bg-1-abc");
    expect(roundTripped.model).toBe("zai-coding-cn/glm-5.3");
  });
});
