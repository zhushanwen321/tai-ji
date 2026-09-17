// src/execution/__tests__/helpers/subagent-record-fixture.ts
//
// 存量成员 record fixture 单源（原 batch-finalized.test.ts ⇔ sync-collect-recovery.test.ts
// 各持一份 22 行逐字同形 memberRecord，仅 task/slug/rootSessionId 三处默认值不同）。
// 收敛为 createMemberRecord(defaults) 工厂：各文件传自己的默认值，call site 形态不变；
// SubagentRecord 增必填字段时只改此处。
//
// 形态要点：rebuildEntryRecord 解析门槛字段齐备（agent/task/slug/status/mode/startedAt/
// rootSessionId/depth/turns/totalTokens/model/eventLog/displayItems）——测试经真实
// reportSubagentRecord → toSubagentRecordEntry 序列化通路消费。

import type { SubagentRecord } from "../../assembly/types.ts";

/** 各文件差异化的默认值（其余 20 字段为共享恒等形态）。 */
export interface MemberRecordDefaults {
  task: string;
  slug: string;
  rootSessionId: string;
}

/** 构造 memberRecord fixture 工厂（defaults 一次性传入，call site 仍传 overrides）。 */
export function createMemberRecord(
  defaults: MemberRecordDefaults,
): (overrides: Partial<SubagentRecord> & { id: string }) => SubagentRecord {
  return (overrides) => ({
    agent: "/agents/worker.md",
    task: defaults.task,
    slug: defaults.slug,
    status: "running",
    mode: "background",
    startedAt: 1000,
    rootSessionId: defaults.rootSessionId,
    parentRecordId: undefined,
    depth: 0,
    endedAt: undefined,
    turns: 0,
    totalTokens: 0,
    model: "prov/m1",
    thinkingLevel: undefined,
    eventLog: [],
    displayItems: [],
    result: undefined,
    error: undefined,
    sessionFile: undefined,
    ...overrides,
  });
}
