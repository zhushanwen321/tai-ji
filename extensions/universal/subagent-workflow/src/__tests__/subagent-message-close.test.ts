// src/__tests__/subagent-message-close.test.ts
//
// M2-B3 message/close action handler + adapter + 两态映射测试。
//
// handler 层测试：mock SubagentService（getRecordForAction/deliverChatMessage/closeSubagent/
// engineSupportsConversation），验证 messageHandler/closeHandler 的参数校验、守卫链、
// 统一投递入参、返回值。归属守卫/准入/翻边（revive）的真正逻辑在 service 层测试覆盖
//（subagent-core conversation-continuation.test.ts / subagent-actions-core.test.ts）。
//
// [modeless 波1 迁移] 「模式」不再是 record 状态（ExecutionRecord.chatMode 停写删除）：
// message 对任何归属内 record 直接续聊——原「one-shot → chatMode 升级」路径消亡，
// handler 层判据链收敛为 归属校验（allowReconnect 冷查准入）→ workflow-origin 域边界
// → 引擎能力轴 gate（engineSupportsConversation，unsupported 引擎硬拒 + 重派/fork 指引）。
// 原「非 chatMode 状态分流（SP-5 one-shot upgrade）」组的 chatMode 置位断言迁移为
// 「投递入参 / 唯一投递路径 / 引擎 gate」断言（chatMode 字段无对应行为面）；
// interrupt 参数随 D2 打断统一语义退役（输入不参与分派，仅工具 schema 兼容面保留）。

import { describe, expect, it, vi } from "vitest";

import { createRecord } from "@zhushanwen/subagent-core/execution/persistence/execution-record.ts";
import { EngineError } from "@zhushanwen/subagent-core/execution/engine/common/errors.ts";
import type { SubagentService } from "@zhushanwen/subagent-core";
import type { ExecutionRecord } from "@zhushanwen/subagent-core";
import { closeHandler, mapExternalState, messageHandler } from "@zhushanwen/subagent-core";
import { adapter } from "../interface/subagent-actions.ts";

/** 构造测试用 record（modeless：无 chatMode 字段——「模式」不是 record 状态，
 *  空闲即可续聊；status / closedReason / engine 变体由各用例显式 override）。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const r = createRecord("sa-test", {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
  });
  Object.assign(r, overrides);
  return r;
}

/** mock SubagentService 的 message/close 相关方法子集。
 *  [D4 聚合跟随] message/close 生产消费面 = service.chatActions（平铺键保留供既有
 *  断言引用）。
 *  [modeless 波1] engineSupportsConversation 是平铺访问器（真实 service 同构——
 *  subagent-service.ts 平铺方法，非 chatActions 成员）；缺成员即 TypeError。缺省
 *  放行 = pi native 语义，拒绝分支由本文件「引擎能力轴 gate」组专测。 */
function makeMockService(): SubagentService {
  const chatActions = {
    getRecordForAction: vi.fn(),
    deliverChatMessage: vi.fn(),
    closeSubagent: vi.fn(),
  };
  return {
    getRecordForAction: chatActions.getRecordForAction,
    deliverChatMessage: chatActions.deliverChatMessage,
    closeSubagent: chatActions.closeSubagent,
    engineSupportsConversation: vi.fn(() => true),
    chatActions,
  } as unknown as SubagentService;
}

/** mock 方法视作 vi.fn（既有断言范式）。 */
function asSpy(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

// ============================================================
// mapExternalState 两态映射（决策 10 细则 3）
// ============================================================

describe("mapExternalState 两态映射（v4 B-1：running/closed 收敛，决策 10 细则 3）", () => {
  it("running → active", () => {
    expect(mapExternalState("running")).toBe("active");
  });
  it("idle → idle（可续聊语义，替代旧 ended）", () => {
    expect(mapExternalState("idle")).toBe("idle");
  });
});

// ============================================================
// messageHandler 参数校验
// ============================================================

describe("messageHandler 参数校验", () => {
  it("缺 subagentId → throw", async () => {
    const service = makeMockService();
    await expect(messageHandler(service, { text: "hi" })).rejects.toThrow(/subagentId is required/);
  });

  it("text 空白 → throw（含 Correct 正例）", async () => {
    const service = makeMockService();
    await expect(
      messageHandler(service, { subagentId: "sa-1", text: "   " }),
    ).rejects.toThrow(/text is required/);
  });
});

// ============================================================
// messageHandler 统一投递（[modeless 波1] 状态无关：任何归属内 record 同路）
// 旧「非 chatMode 状态分流（SP-5 one-shot upgrade）」组对位迁移——chatMode 字段与
// 「升级」概念随 modeless 重构消亡，原 4 个用例的覆盖去向：投递入参与唯一投递路径
// 断言（详见下方用例注释）。
// ============================================================

describe("messageHandler 统一投递（modeless：状态无关，任何归属内 record 同路）", () => {
  it("running + interrupt:true → deliverChatMessage(record, text)（[H1 U6] interrupt 退役：输入不参与分派）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    asSpy(service.getRecordForAction).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "follow up",
      interrupt: true,
    });

    // 归属校验入参契约（[U4] 万物可续：message 走 allowReconnect 冷查准入）
    expect(service.getRecordForAction).toHaveBeenCalledWith("sa-test", { allowReconnect: true });
    // 引擎能力轴 gate 收到的即归属校验返回的 record（唯一资格判据，与 record 形态无关）
    expect(service.engineSupportsConversation).toHaveBeenCalledWith(record);
    // 统一投递：record 身份原样 + text 透传（trim 见下一条用例）
    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "follow up");
    // 无第二条派发/归档路径（message 不归档、不 close）
    expect(service.closeSubagent).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "message",
      subagentId: "sa-test",
      slug: "test",
      response: { delivered: true },
    });
  });

  it("running + interrupt 缺省 → deliverChatMessage(record, text.trim())（与 interrupt:true 同路）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    asSpy(service.getRecordForAction).mockReturnValue(record);

    await messageHandler(service, { subagentId: "sa-test", text: "  queue this  " });

    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "queue this");
    expect(service.closeSubagent).not.toHaveBeenCalled();
  });

  it("running（进程回收态）→ deliverChatMessage（handler 不按 status 分流，判活/翻边归 Continuation）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    asSpy(service.getRecordForAction).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "continue",
      interrupt: true,
    });

    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "continue");
    expect(result.response).toEqual({ delivered: true });
  });

  it("[U4 万物可续] idle + 遗留 closedReason（旧终态遗留 record）→ 放行投递（ended 拒绝格消亡）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "idle", closedReason: "gc" });
    asSpy(service.getRecordForAction).mockReturnValue(record);

    const result = await messageHandler(service, { subagentId: "sa-test", text: "hi" });

    // 形态枚举 gate 消亡：idle + 遗留 closedReason 不进任何拒绝分支 → 引擎轴 gate → 投递
    expect(service.engineSupportsConversation).toHaveBeenCalledWith(record);
    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "hi");
    expect(result.response).toEqual({ delivered: true });
  });

  it("[U4] workflow-origin record → 拒绝（D7 域边界：workflow 编排成员不进 message 通道）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "idle" });
    record.origin = "workflow";
    asSpy(service.getRecordForAction).mockReturnValue(record);

    await expect(
      messageHandler(service, { subagentId: "sa-test", text: "hi" }),
    ).rejects.toThrow(/workflow-origin record/);
    expect(service.deliverChatMessage).not.toHaveBeenCalled();
  });

  it("归属守卫：getRecordForAction throw 时透传（not found or not owned）", async () => {
    const service = makeMockService();
    asSpy(service.getRecordForAction).mockImplementation(() => {
      throw new Error("subagent not found or not owned: sa-x");
    });

    await expect(
      messageHandler(service, { subagentId: "sa-x", text: "hi" }),
    ).rejects.toThrow(/not found or not owned/);
  });
});

// ============================================================
// messageHandler 引擎能力轴 gate（[modeless 波1] message 资格唯一判据）
// 原 SP-5「canUpgradeToConversation」记录级升级门随 chatMode 消亡——资格判据与
// record 无关：引擎 capabilities.conversation 非 'unsupported' 才放行（pi native /
// zcode cold 均可续），unsupported 引擎硬拒 + 重派/fork/换引擎指引（防续聊行为悬空）。
// 与 Continuation revive 翻边格（写点②）共用同一构造器，本组覆盖写点①。
// ============================================================

describe("messageHandler 引擎能力轴 gate（[modeless 波1] 升级门消亡后的唯一资格判据）", () => {
  it("unsupported 引擎（engineSupportsConversation=false）→ 硬拒 + 重派/fork/换引擎指引（不投递）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running", engine: "stub-unsupported" });
    asSpy(service.getRecordForAction).mockReturnValue(record);
    asSpy(service.engineSupportsConversation).mockReturnValue(false);

    const err = await messageHandler(service, { subagentId: "sa-test", text: "hi" }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(EngineError);
    const engineErr = err as EngineError;
    expect(engineErr.code).toBe("engine_capability_unsupported");
    // 拒绝依据回显 record 的引擎 id（引擎轴判据，非 record 形态判据）
    expect(engineErr.message).toContain("engine 'stub-unsupported' cannot continue this subagent by message");
    expect(engineErr.message).toContain("capabilities.conversation = 'unsupported'");
    // 拒绝即带恢复动作（错误 → 权威源 → 重试闭环）
    expect(engineErr.recovery).toContain("action:'start'");
    expect(engineErr.recovery).toContain("action:'fork-from'");
    expect(engineErr.recovery).toContain("conversation capability");
    // 拒绝发生在投递前：不产生悬空续聊
    expect(service.deliverChatMessage).not.toHaveBeenCalled();
  });

  it("gate 放行（pi native 缺省）→ 投递：拒绝面只在引擎轴，与 record 形态无关", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "idle", closedReason: "cancelled" });
    asSpy(service.getRecordForAction).mockReturnValue(record);

    const result = await messageHandler(service, { subagentId: "sa-test", text: "hi" });

    expect(service.engineSupportsConversation).toHaveBeenCalledWith(record);
    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "hi");
    expect(result.response).toEqual({ delivered: true });
  });
});

// ============================================================
// messageHandler 投递面唯一性（[modeless 波1] 无模式分支 / 无第二派发路径）
// 旧「chatMode 统一投递（V2 决策 3）」组对位迁移——chatMode 字段消亡后该组与上一组
// 同路，保留为「唯一投递路径」独立断言面：投递恰一次 + 无其它 chat action +
// interrupt 两取值逐字等价（防未来重新引入分流分支时静默漂移）。
// ============================================================

describe("messageHandler 投递面唯一性（无模式分支 / 无第二派发路径）", () => {
  it("running → deliverChatMessage 恰一次 + 无其它 chat action（无 resume 旁路）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    asSpy(service.getRecordForAction).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "follow up",
      interrupt: true,
    });

    expect(service.deliverChatMessage).toHaveBeenCalledTimes(1);
    expect(service.getRecordForAction).toHaveBeenCalledTimes(1);
    expect(service.closeSubagent).not.toHaveBeenCalled();
    expect(result.response).toEqual({ delivered: true });
  });

  it("idle → deliverChatMessage 恰一次（status 翻边归 Continuation，handler 不分流）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "idle" });
    asSpy(service.getRecordForAction).mockReturnValue(record);

    await messageHandler(service, { subagentId: "sa-test", text: "continue", interrupt: false });

    expect(service.deliverChatMessage).toHaveBeenCalledTimes(1);
    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "continue");
    expect(service.closeSubagent).not.toHaveBeenCalled();
  });

  it("interrupt:true / 缺省 false 两取值 → 投递参数逐字相同（[H1 U6] interrupt 输入不参与分派）", async () => {
    const runOnce = async (interrupt?: boolean) => {
      const service = makeMockService();
      const record = makeRecord({ status: "running" });
      asSpy(service.getRecordForAction).mockReturnValue(record);
      await messageHandler(service, {
        subagentId: "sa-test",
        text: "stop",
        ...(interrupt !== undefined ? { interrupt } : {}),
      });
      return {
        deliverCalls: asSpy(service.deliverChatMessage).mock.calls,
        gateCalls: asSpy(service.engineSupportsConversation).mock.calls.length,
      };
    };

    const withTrue = await runOnce(true);
    const withFalse = await runOnce(false);
    const withUndefined = await runOnce(undefined);

    // 三种 interrupt 取值 → 投递入参恒为 (record, text) 二元组（无第三实参位：
    // interrupt 不进投递签名，分派面不含该输入）
    for (const calls of [withTrue.deliverCalls, withFalse.deliverCalls, withUndefined.deliverCalls]) {
      expect(calls).toHaveLength(1);
      expect(calls[0]!).toHaveLength(2);
      expect(calls[0]![1]).toBe("stop");
    }
    // 资格 gate 查询次数与取值无关（无按 interrupt 分流的额外判据）
    expect(withTrue.gateCalls).toBe(withFalse.gateCalls);
    expect(withUndefined.gateCalls).toBe(withFalse.gateCalls);
  });
});

// ============================================================
// closeHandler
// ============================================================

describe("closeHandler", () => {
  it("缺 subagentId → throw", async () => {
    const service = makeMockService();
    await expect(closeHandler(service, {})).rejects.toThrow(/subagentId is required/);
  });

  it("正常 → closeSubagent 被调 + 返回 closed:true", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    asSpy(service.getRecordForAction).mockReturnValue(record);
    asSpy(service.closeSubagent).mockResolvedValue(undefined);

    const result = await closeHandler(service, {
      subagentId: "sa-test",
      force: true,
    });

    expect(service.closeSubagent).toHaveBeenCalledWith(record, true);
    expect(result).toEqual({
      kind: "close",
      subagentId: "sa-test",
      response: { closed: true },
    });
  });

  it("force 默认 false", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    asSpy(service.getRecordForAction).mockReturnValue(record);
    asSpy(service.closeSubagent).mockResolvedValue(undefined);

    await closeHandler(service, { subagentId: "sa-test" });

    expect(service.closeSubagent).toHaveBeenCalledWith(record, false);
  });
});

// ============================================================
// adapter message/close action
// ============================================================

describe("adapter message/close action", () => {
  it("message → content JSON 含 messageResponse.delivered:true", () => {
    const result = adapter({
      action: "message",
      domain: { kind: "message", subagentId: "sa-1", response: { delivered: true } },
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ action: "message", messageResponse: { delivered: true } });
  });

  it("close → content JSON 含 closeResponse.closed:true", () => {
    const result = adapter({
      action: "close",
      domain: { kind: "close", subagentId: "sa-1", response: { closed: true } },
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ action: "close", closeResponse: { closed: true } });
  });
});
