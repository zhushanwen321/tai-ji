// src/execution/__tests__/subagent-service-model-switch.test.ts
//
// [subagent-model-switch §7.2 目标 5 壳接线] SubagentService.setModel 装配段的
// 行为测试：deps 闭包走真实通道（ModelConfigService 透传 / store.markModelOverride
// 落账原语 / chatRounds.resolveEnginePortForSwitch 引擎路由转发）。编排本体
// （model-switch.ts 纯函数）的分型处置表已由 model-switch.test.ts 全量覆盖，本文件
// 只锚壳装配——两文件互补，不重复证明。
//
// 场景取舍：chat 域两态（无活进程纯记账 / 活进程 + 引擎解析转发）恰好覆盖装配段
// 全部闭包；run 级聚合通道（runAggregate / persistRunOverride）的真实装配由
// workflow-dispatch 侧 U4b 测试承接（workflow-dispatch-override.test.ts）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ModelConfigService } from "../assembly/model-config-service.ts";
import type { ModelInfo, ModelRegistryLike } from "../assembly/model-resolver.ts";
import { createRecord } from "../persistence/execution-record.ts";
import type { RecordStore } from "../persistence/record-store.ts";
import { SubagentService } from "../subagent-service.ts";
import {
  _resetCoreSpawnedChildrenMirrorForTest,
  registerSpawnedChildForRecord,
} from "../engine/host/spawned-children.ts";

// ============================================================
// fixtures（形态对齐 model-switch.test.ts——校验语义真实）
// ============================================================

function makeModel(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: over.id ?? "glm-5.3-flash",
    name: over.name ?? "GLM-5.3-Flash",
    provider: over.provider ?? "zai-coding-cn",
    reasoning: over.reasoning ?? false,
    thinkingLevelMap: over.thinkingLevelMap,
    contextWindow: over.contextWindow,
  };
}

function makeRegistry(
  models: ModelInfo[],
  authed: string[] = models.map((m) => `${m.provider}/${m.id}`),
): ModelRegistryLike {
  const authSet = new Set(authed);
  return {
    getAvailable: () => models,
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    hasConfiguredAuth: (m) => {
      if (!m || typeof m !== "object") return false;
      const mm = m as ModelInfo;
      return authSet.has(`${mm.provider}/${mm.id}`);
    },
  };
}

const TARGET_MODEL = { provider: "zai-coding-cn", modelId: "glm-5.3-flash" } as const;

describe("SubagentService.setModel 壳接线（§7.2 目标 5）", () => {
  let dir: string;
  let service: SubagentService;
  let store: RecordStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shell-model-switch-"));
    const modelService = new ModelConfigService({ agentDir: join(dir, "agent"), cwd: dir });
    modelService.initModel({ modelRegistry: makeRegistry([makeModel()]), sessionId: "sess-1" });
    service = new SubagentService({ cwd: join(dir, "agent"), modelService });
    store = Reflect.get(service, "store") as RecordStore;
  });

  afterEach(() => {
    _resetCoreSpawnedChildrenMirrorForTest();
    service.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeRecord(id: string): ReturnType<typeof createRecord> {
    const record = createRecord(id, {
      agent: "general-purpose",
      model: "zai-coding-cn/glm-5.3",
      thinkingLevel: "high",
      mode: "background",
      task: "shell switch demo",
      slug: "shell-switch",
      startedAt: 1_000,
    });
    store.register(record);
    return record;
  }

  it("无活进程 → 纯记账路径：store 落账原语写 record.modelOverride + 已记账型应答（不携带档位）", async () => {
    const record = makeRecord("sa-shell-switch-1");
    const reply = await service.setModel({ domain: "chat", record }, TARGET_MODEL);
    expect(reply).toEqual({
      scope: "chat",
      reply: { kind: "recorded", notice: "已记录，下次执行生效。" },
    });
    // 落账原语真实生效（内存 record 字段；盖章值 model 不变量 5 不触碰）
    expect(record.modelOverride?.ref).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3-flash" });
    expect(record.model).toBe("zai-coding-cn/glm-5.3");
  });

  it("活进程 + 引擎解析转发（pi 未注册 → 不可用 stub 的 native 位与方法缺席组合）→ 装配损坏守卫抛出，编排写记账 + 错误应答（不虚构生效值）", async () => {
    const record = makeRecord("sa-shell-switch-2");
    // 宿主活进程镜像注册（hasLiveProcessHandle 判真 → 走引擎转发分支）
    registerSpawnedChildForRecord(record.id, { pid: 424242, killed: false } as unknown as ChildProcess);
    const reply = await service.setModel({ domain: "chat", record }, TARGET_MODEL);
    expect(reply.scope).toBe("chat");
    if (reply.scope !== "chat" || reply.reply.kind !== "error") {
      throw new Error(`expected chat error reply, got: ${JSON.stringify(reply)}`);
    }
    expect(reply.reply.message).toMatch(/setModel=native/);
    // 守卫路径仍写记账（处置表行 3/7 形态——意图已表达，生效值未知如实报错）
    expect(record.modelOverride?.ref).toEqual({ provider: "zai-coding-cn", modelId: "glm-5.3-flash" });
  });
});
