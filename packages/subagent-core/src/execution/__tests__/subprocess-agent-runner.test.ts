// src/execution/__tests__/subprocess-agent-runner.test.ts
//
// [H2 W4] SAR 壳装配契约测试——run() 已掏空为纯转调
// SubagentService.executeWorkflowAgent（编排归 service 单点，设计
// subagent-workflow-record-unification.md §5 W4 / §3.5 终态数据流）。
//
// 本文件只锁壳契约面：
//   1. 构造签名（deps.subagentService + ctxModel 兼容——session-lifecycle.ts
//      装配点零改定的锚点）；
//   2. run() 纯转调（opts/signal/onEvent/stream 原样透传 + parentRunId 用直调
//      占位 SAR_UNATTACHED_PARENT_RUN_ID + 返回值原样返回，零映射零吞错）；
//   3. updateCtxModel 装配链兼容（model_select 刷新不炸；run() 不再消费 ctxModel）；
//   4. mergeRunSignals re-export 可用（既有 import 路径契约）。
//
// [H2 W4 删除面] 旧编排内部用例（路由集成 / model 填底 / ctxModel 孪生守卫 /
// timeoutMs 合并 / onEvent-journal 桥接 / 直传保真 / no-progress 守护落点 /
// 全链 killAll）随 SAR 编排退役删除——service 落点的行为守护由
// workflow-agent-dispatch.test.ts（W2 承接：注册面/池顺序/守护 arm 键 record.id/
// 双刷新源/fire 追注/stream 自构/D7/D6/adopt 豁免）与 engine/__tests__/routing.test.ts
// （路由 helper 单点：三层优先级 + 守卫 a/b/c + strict + fallback）承接。

import { describe, expect, it, vi } from "vitest";

import type { AgentCallOpts, AgentResult } from "../../orchestration/models/types.ts";
import type { ModelInfo } from "../model-resolver.ts";
import { SubagentStream } from "../stream-sink.ts";
import type { SubagentService } from "../subagent-service.ts";
import {
  SAR_UNATTACHED_PARENT_RUN_ID,
  SubprocessAgentRunner,
  type SubprocessAgentRunnerDeps,
} from "../subprocess-agent-runner.ts";
import { mergeRunSignals } from "../engine/common/run-signals.ts";

function makeOpts(): AgentCallOpts {
  return { prompt: "test task", agent: "worker" };
}

function makeResult(): AgentResult {
  return { content: "OK", durationMs: 100, toolCalls: [] };
}

/** mock SubagentService——只实现 executeWorkflowAgent（转调目标），其余成员不触达。 */
function createMockService(impl?: ReturnType<typeof vi.fn>): SubagentService {
  const executeWorkflowAgent = impl ?? vi.fn().mockResolvedValue(makeResult());
  const partial = { executeWorkflowAgent };
  return partial as unknown as SubagentService;
}

describe("SubprocessAgentRunner (H2 W4 纯转调壳)", () => {
  it("run() 纯转调 executeWorkflowAgent：opts/signal/onEvent/stream 原样透传，parentRunId 用直调占位", async () => {
    const executeWorkflowAgent = vi.fn().mockResolvedValue(makeResult());
    const deps: SubprocessAgentRunnerDeps = { subagentService: createMockService(executeWorkflowAgent) };
    const sar = new SubprocessAgentRunner(deps);

    const opts = makeOpts();
    const controller = new AbortController();
    const onEvent = vi.fn();
    const stream = new SubagentStream("sar-test-stream", { setWidget: () => {} });
    const result = await sar.run(opts, controller.signal, onEvent, stream);

    expect(executeWorkflowAgent).toHaveBeenCalledTimes(1);
    expect(executeWorkflowAgent).toHaveBeenCalledWith(
      opts,
      SAR_UNATTACHED_PARENT_RUN_ID,
      controller.signal,
      onEvent,
      stream,
    );
    // 返回值原样返回（executeWorkflowAgent 返回类型即 orchestration AgentResult，零映射）
    expect(result).toEqual(makeResult());
  });

  it("onEvent/stream 缺省时占位 undefined 透传（位置参数对齐 service 签名）", async () => {
    const executeWorkflowAgent = vi.fn().mockResolvedValue(makeResult());
    const sar = new SubprocessAgentRunner({ subagentService: createMockService(executeWorkflowAgent) });

    const controller = new AbortController();
    await sar.run(makeOpts(), controller.signal);

    expect(executeWorkflowAgent).toHaveBeenCalledWith(
      makeOpts(),
      SAR_UNATTACHED_PARENT_RUN_ID,
      controller.signal,
      undefined,
      undefined,
    );
  });

  it("service 同步抛错（路由失败/预检命中/嵌套超限）原样传播——壳不吞错不包装", async () => {
    const boom = new Error("engine_not_found: zcode not registered");
    const executeWorkflowAgent = vi.fn().mockRejectedValue(boom);
    const sar = new SubprocessAgentRunner({ subagentService: createMockService(executeWorkflowAgent) });

    await expect(sar.run(makeOpts(), new AbortController().signal)).rejects.toThrow(boom);
  });

  it("构造签名兼容：ctxModel 可选注入（装配点零改定锚点）+ updateCtxModel 刷新不炸", async () => {
    const ctxModel: ModelInfo = {
      id: "test/model-x",
      name: "Model X",
      provider: "test",
      reasoning: false,
      contextWindow: 128_000,
    };
    const executeWorkflowAgent = vi.fn().mockResolvedValue(makeResult());
    // ctxModel 注入构造（session-lifecycle.ts:537 形态）
    const sar = new SubprocessAgentRunner({ subagentService: createMockService(executeWorkflowAgent), ctxModel });
    // model_select 刷新链（extension index.ts 调用形态）：不炸且不影响转调
    sar.updateCtxModel(undefined);
    sar.updateCtxModel(ctxModel);

    await sar.run(makeOpts(), new AbortController().signal);
    // run() 不再消费 ctxModel：转调用参只有 opts/parentRunId/signal/onEvent/stream
    expect(executeWorkflowAgent).toHaveBeenCalledWith(
      makeOpts(),
      SAR_UNATTACHED_PARENT_RUN_ID,
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
  });

  it("re-export 契约：mergeRunSignals 经本模块路径可用（既有 import 面）", () => {
    // no-progress-killall 测试经本模块 import mergeRunSignals——锁 re-export 行存活
    //（行为本体由 engine/common/run-signals 权威实现及其测试锁定）。
    const handle = mergeRunSignals(new AbortController().signal, 60_000);
    expect(handle.signal.aborted).toBe(false);
    handle.dispose();
  });
});
