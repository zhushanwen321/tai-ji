// src/execution/__tests__/run-and-finalize-window-dispose.test.ts
//
// [D3-A4] runAndFinalize 的 one-shot 窗口收尾配对测试。
//
// 覆盖语义（disposeWindowEngine 接线的两条路径，窗口键 = record.id）：
// 1. engine.run 失败（prepare 期 reject / 进程死亡）→ catch 内收窗口（"one-shot-failed"）
//    + finalizeFailed 合成失败结果（swallow 不外抛——sync 调用方拿 failed result）。
// 2. engine.run 成功 → settle 后收窗口（"one-shot-settled"），与失败路径构成
//    「无论成败窗口必收」的配对不变量（不收即孤儿窗口实例驻留）。
//
// mock 策略：RunOrchestration 直构（settle-chain-transition.test.ts 同款部分 deps
// 注入），engine 走 registerFakePiEngine 替身（record.id 无窗口状态 → 解析回落
// registry 单例路径，run 捕获在 fake.runs）。

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecord } from "../persistence/execution-record.ts";
import { RunOrchestration } from "../service/run-orchestration.ts";
import type { ResolvedIdentity } from "../service/record-access.ts";
import type { AgentResult, ExecutionRecord } from "../domain/record-model.ts";
import type { ExecuteOptions } from "../assembly/types.ts";
import { registerFakePiEngine, type FakePiEnginePort } from "./helpers/fake-engine-port.ts";
import { clearEngines } from "../engine/registry.ts";

const failResult: AgentResult = {
  text: "",
  turns: 0,
  durationMs: 1,
  success: false,
  sessionId: "sa-x",
  toolCalls: [],
};

const successResult: AgentResult = {
  text: "done",
  turns: 1,
  durationMs: 10,
  success: true,
  sessionId: "sa-x",
  toolCalls: [],
};

/** origin=tool 的 record（executeAndAwait 的 record 形态；modeless 后域模型唯一
 *  ExecutionMode="background"——runAndFinalize 恒走池槽路径，getPool 由 stub 承载）。 */
function makeToolRecord(id: string): ExecutionRecord {
  return createRecord(id, {
    agent: "reviewer",
    mode: "background",
    task: "review it",
    slug: "reviewer",
    startedAt: Date.now(),
    origin: "tool",
  });
}

const identity: ResolvedIdentity = {
  agent: "reviewer",
  agentConfig: undefined,
  resolved: { model: undefined, thinkingLevel: undefined },
};

/** RunOrchestration 直构（仅注入被测路径消费的 deps——其余 cast 绕过完整装配）。
 *  deps 类型走字面量推断（单实现场景不起具名接口）。 */
function makeOrchestration(result: AgentResult) {
  const deps = {
    disposeWindowEngine: vi.fn(),
    finalizeFailed: vi.fn(async () => result),
    finalizeRecord: vi.fn(async () => {}),
    // runCtx 构造消费（sessionRootId 缺省不入 wire）
    getSessionRootId: vi.fn(() => null),
    // origin=tool 的 settleOneShotOutcome 簿记（record.status=running 时走 markRoundIdle）
    getStore: vi.fn(() => ({ markRoundIdle: vi.fn(), markSettled: vi.fn() })),
    // pooled（modeless 后恒 background）的池槽路径：acquire 恒成功 / release no-op
    getPool: vi.fn(() => ({ acquire: vi.fn(async () => {}), release: vi.fn(), maxConcurrent: 2 })),
  };
  const orchestration = new RunOrchestration(
    deps as unknown as ConstructorParameters<typeof RunOrchestration>[0],
  );
  return { orchestration, deps };
}

describe("runAndFinalize one-shot 窗口收尾（D3-A4 失败路径）", () => {
  afterEach(() => {
    clearEngines();
    vi.restoreAllMocks();
  });

  it("engine.run 失败 → disposeWindowEngine('one-shot-failed') + finalizeFailed 结果外返", async () => {
    const fake: FakePiEnginePort = registerFakePiEngine();
    const { orchestration, deps } = makeOrchestration(failResult);
    const record = makeToolRecord("sa-wd-fail-1");

    const runErr = new Error("engine run boom");
    const pending = orchestration.runAndFinalize(
      record,
      { task: "review it", slug: "reviewer" } as ExecuteOptions,
      identity,
      undefined,
      0,
    );
    // run 已派发到替身引擎（窗口键无状态 → registry 单例路径）→ 驱动失败应答
    //（pooled 恒 background：engine.run 前有池槽 await，等派发落 fake.runs 再驱动）
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0].fail(runErr);

    // swallow 语义：不 reject，sync 调用方拿到合成 failed result
    await expect(pending).resolves.toBe(failResult);
    expect(deps.finalizeFailed).toHaveBeenCalledWith(record, runErr);
    // 失败路径同样收窗口（record.id 键）——不收即孤儿窗口实例
    expect(deps.disposeWindowEngine).toHaveBeenCalledWith(
      record.id,
      "one-shot-failed",
      "executeAndAwait runAndFinalize failure cleanup",
    );
  });

  it("engine.run 成功 → settle 后 disposeWindowEngine('one-shot-settled')（配对不变量）", async () => {
    const fake: FakePiEnginePort = registerFakePiEngine();
    const { orchestration, deps } = makeOrchestration(successResult);
    const record = makeToolRecord("sa-wd-ok-1");

    const pending = orchestration.runAndFinalize(
      record,
      { task: "review it", slug: "reviewer" } as ExecuteOptions,
      identity,
      undefined,
      0,
    );
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
    fake.runs[0].settle({ content: "reviewed" });

    const result = await pending;
    expect(result.success).toBe(true);
    expect(deps.disposeWindowEngine).toHaveBeenCalledWith(
      record.id,
      "one-shot-settled",
      "executeAndAwait runAndFinalize settle cleanup",
    );
    // 失败路径未走：finalizeFailed 零调用
    expect(deps.finalizeFailed).not.toHaveBeenCalled();
  });
});
