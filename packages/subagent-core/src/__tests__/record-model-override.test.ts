// src/__tests__/record-model-override.test.ts
//
// [subagent-model-switch u-foundation] modelOverride 用户覆盖记账字段的轻量契约测试：
// ① 序列化/反序列化往返保形（record 持久化经 JSON 条目派生视图，ref 对象 + setAt 数值
//    必须无损往返）；② 旧记录（无字段）兼容读取（可选字段向后兼容——undefined 即
//    「从未被用户覆盖」，旧 session 文件反序列化不破）。
//
// 行为实装（setModel 编排 / 解析链第 0 层 / entry 持久化派生视图）归 U2，不在本测试范围。

import { describe, expect, it } from "vitest";

// [round5-g 合并产物] 吸收同被测值域（record-model.ts）姊妹件：
// - subagent-model-source-parity.test.ts（SubagentModelSource 双侧值域对拍，原
//   src/execution/__tests__/ 下）。
import type { ExecutionRecord, ModelOverride } from "../execution/domain/record-model.ts";
import type { SubagentModelSource as SharedSubagentModelSource } from '@taiji/shared'
import { SUBAGENT_MODEL_SOURCE_ALL } from '@taiji/shared'
import type { SubagentModelSource as CoreSubagentModelSource } from "../execution/domain/record-model.ts"
import { SUBAGENT_MODEL_SOURCES } from "../execution/domain/record-model.ts";

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

// ══════ 来源: subagent-model-source-parity.test.ts ══════

// ── 编译期断言：双向兼容（删任一侧字面量 → 某方向赋值 tsc 红）──────────────────
type Assignable<T, U> = [T] extends [U]
  ? true
  : ['SubagentModelSource 双侧值域漂移：一侧字面量不在另一侧联合内（S-9 对拍断言失败）']

const _coreToShared: Assignable<CoreSubagentModelSource, SharedSubagentModelSource> = true
const _sharedToCore: Assignable<SharedSubagentModelSource, CoreSubagentModelSource> = true
// 消费以通过 noUnusedLocals（类型断言无运行时语义，值恒 true）
void _coreToShared
void _sharedToCore

describe('SubagentModelSource 双侧值域对拍（S-9：shared 副本 ↔ core 本地副本）', () => {
  it('运行时清单逐项相等（顺序无关）：SUBAGENT_MODEL_SOURCES ≡ SUBAGENT_MODEL_SOURCE_ALL', () => {
    // toEqual 对长度与成员逐位敏感：任一侧增删值 / 单侧内部重复（元组 satisfies
    // 正向锁不拦重复）均使比对失败
    expect([...SUBAGENT_MODEL_SOURCES].sort()).toEqual([...SUBAGENT_MODEL_SOURCE_ALL].sort())
  })

  it('双侧清单非空且成员无重复（元组作为值域锚点的形态前提）', () => {
    const coreValues = [...SUBAGENT_MODEL_SOURCES]
    const sharedValues = [...SUBAGENT_MODEL_SOURCE_ALL]
    expect(coreValues.length).toBeGreaterThan(0)
    expect(sharedValues.length).toBeGreaterThan(0)
    expect(new Set(coreValues).size).toBe(coreValues.length)
    expect(new Set(sharedValues).size).toBe(sharedValues.length)
  })
})
