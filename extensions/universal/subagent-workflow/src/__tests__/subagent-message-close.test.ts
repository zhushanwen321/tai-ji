// src/__tests__/subagent-message-close.test.ts
//
// M2-B3 message/close action handler + adapter + 四态映射测试。
//
// handler 层测试：mock SubagentService（getRecordForAction/resumeRound/deliverChatMessage/
// closeSubagent），验证 messageHandler/closeHandler 的参数校验、状态分流、返回值。
// 归属守卫/终态化/行为分流的真正逻辑在 service 层测试覆盖
//（subagent-service-message-close.test.ts）。

import { describe, expect, it, vi } from "vitest";

import { createRecord } from "@zhushanwen/subagent-core/execution/execution-record.ts";
import type { SubagentService } from "@zhushanwen/subagent-core";
import type { ExecutionRecord } from "@zhushanwen/subagent-core";
import { adapter, closeHandler, mapExternalState, messageHandler } from "../interface/subagent-actions.ts";

/** 构造测试用 record（默认非 chatMode running——chatMode 统一投递测试显式传 chatMode:true）。 */
function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const r = createRecord("sa-test", {
    agent: "general-purpose",
    model: "test/model",
    mode: "background",
    task: "test",
    slug: "test",
    startedAt: 1000,
    rootSessionId: "root-session",
    chatMode: false,
  });
  Object.assign(r, overrides);
  return r;
}

/** mock SubagentService 的 message/close 相关方法子集。
 *  [D4 聚合跟随] message/close 生产消费面 = service.chatActions（平铺键保留供既有
 *  断言引用）。 */
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
    resumeRound: vi.fn(),
    // [H1 U2 / D5 双写点①] SP-5 升级 gate（U2 编排改写新增消费面——mock 缺成员即
    // TypeError，U2 偏差登记的 extensions 破损用例根因）；缺省放行，gate 拒绝分支
    // 由 subagent-core subagent-actions-core.test.ts 专测。
    canUpgradeToConversation: vi.fn(() => true),
    chatActions,
  } as unknown as SubagentService;
}

// ============================================================
// mapExternalState 四态映射（决策 10 细则 3）
// ============================================================

describe("mapExternalState 两态映射（v4 B-1：running/closed 收敛，决策 10 细则 3）", () => {
  it("running → active", () => {
    expect(mapExternalState("running")).toBe("active");
  });
  it("closed → ended", () => {
    expect(mapExternalState("closed")).toBe("ended");
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
// messageHandler 非 chatMode 状态分流（SP-5 one-shot upgrade）
// SP-5：非 chatMode active record（running/idle）收到 message 时自动升级为 chatMode，
// 走 deliverChatMessage 统一投递路径（热路径或冷路径 resume）。
// ============================================================

describe("messageHandler 非 chatMode 状态分流（SP-5 one-shot upgrade）", () => {
  it("running + interrupt:true → upgrade chatMode + deliverChatMessage(record, text)（[H1 U6] interrupt 退役）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "follow up",
      interrupt: true,
    });

    // SP-5：非 chatMode running → upgrade chatMode → deliverChatMessage 统一投递
    expect(record.chatMode).toBe(true);
    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "follow up");
    expect(service.resumeRound).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "message",
      subagentId: "sa-test",
      slug: "test",
      response: { delivered: true },
    });
  });

  it("running + interrupt 默认 false → upgrade chatMode + deliverChatMessage(record, text)（[H1 U6] interrupt 退役）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    await messageHandler(service, { subagentId: "sa-test", text: "queue this" });

    // SP-5：非 chatMode running → upgrade chatMode → deliverChatMessage 统一投递
    expect(record.chatMode).toBe(true);
    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "queue this");
  });

  it("running（进程回收态，旧 idle）→ upgrade chatMode + deliverChatMessage（统一派发新轮）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "continue",
      interrupt: true,
    });

    // SP-5：非 chatMode running → upgrade chatMode → deliverChatMessage（v4 B-1：旧 idle 折入 running）
    expect(record.chatMode).toBe(true);
    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "continue");
    expect(service.resumeRound).not.toHaveBeenCalled();
    expect(result.response).toEqual({ delivered: true });
  });

  it("终态（done）→ throw ended（含恢复指引）", async () => {
    const service = makeMockService();
    const record = makeRecord({ status: "closed" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    await expect(
      messageHandler(service, { subagentId: "sa-test", text: "hi" }),
    ).rejects.toThrow(/has ended/);
  });

  it("归属守卫：getRecordForAction throw 时透传（not found or not owned）", async () => {
    const service = makeMockService();
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("subagent not found or not owned: sa-x");
    });

    await expect(
      messageHandler(service, { subagentId: "sa-x", text: "hi" }),
    ).rejects.toThrow(/not found or not owned/);
  });
});

// ============================================================
// messageHandler chatMode 统一投递（V2 决策 3）
// ============================================================

describe("messageHandler chatMode 统一投递（V2 决策 3）", () => {
  it("chatMode running → deliverChatMessage（不走 resumeRound）", async () => {
    const service = makeMockService();
    const record = makeRecord({ chatMode: true, status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    const result = await messageHandler(service, {
      subagentId: "sa-test",
      text: "follow up",
      interrupt: true,
    });

    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "follow up");
    expect(service.resumeRound).not.toHaveBeenCalled();
    expect(result.response).toEqual({ delivered: true });
  });

  it("chatMode running（旧 idle）→ deliverChatMessage（统一投递，不走 resumeRound——V2 进程长驻，判活分流）", async () => {
    const service = makeMockService();
    const record = makeRecord({ chatMode: true, status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    await messageHandler(service, { subagentId: "sa-test", text: "continue", interrupt: false });

    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "continue");
    expect(service.resumeRound).not.toHaveBeenCalled();
  });

  it("chatMode running → deliverChatMessage 统一投递（[H1 U6] interrupt 输入不参与分派）", async () => {
    const service = makeMockService();
    const record = makeRecord({ chatMode: true, status: "running" });
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);

    await messageHandler(service, { subagentId: "sa-test", text: "stop", interrupt: true });
    expect(service.deliverChatMessage).toHaveBeenCalledWith(record, "stop");
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
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);
    (service.closeSubagent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

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
    (service.getRecordForAction as ReturnType<typeof vi.fn>).mockReturnValue(record);
    (service.closeSubagent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

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
