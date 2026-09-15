// src/__tests__/ui-request-queue.test.ts
//
// W3 测试：UI 请求队列机制（L1 per-child createUiRequestQueue）
// 1. 多个请求按 FIFO 顺序处理
// 2. 第一个请求未完成时第二个不开始
//
// 直接测试 createUiRequestQueue 的队列逻辑（纯函数，不需要 mock runSpawn）。
// 用 fake child（PassThrough stdin）+ 手动控制 Promise resolve 时序。
//
// 协议迁移（W2）：enqueue 第二参从旧 Record params（含 questions/context）改为
// ExtensionUiRequest（method 平铺）；handler 签名从 (questions,context) 改为
// UiRequestHandler (req: UiRequest) => Promise<UiResponse>。

import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createUiRequestQueue,
  type UiRequest,
  type UiRequestHandler,
  type UiResponse,
} from "../ui-request-queue.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeFakeChild(): ChildProcess {
  const stdin = new PassThrough();
  return {
    stdin,
    killed: false,
    pid: 10001,
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as ChildProcess;
}

/** 构造 select method 的 ExtensionUiRequest（ask_user 借道 select dialog 通道）。 */
function makeSelectReq(question: string): { method: "select"; title: string; options: string[] } {
  return {
    method: "select",
    title: question,
    options: [JSON.stringify({ question, options: [{ label: "A" }] })],
  };
}

describe("UI 请求队列", () => {
  it("多个 extension_ui_request 按 FIFO 顺序处理", async () => {
    const callOrder: string[] = [];
    // 每个请求返回独立的可控 Promise
    const resolvers: Array<(v: UiResponse) => void> = [];

    const handler: UiRequestHandler = vi.fn((req: UiRequest) => {
      callOrder.push(req.title ?? "");
      return new Promise<UiResponse>((resolve) => {
        resolvers.push(resolve);
      });
    }) as unknown as UiRequestHandler;

    const child = makeFakeChild();
    const ctx = { uiRequestHandler: handler } as Parameters<
      typeof createUiRequestQueue
    >[1];
    const enqueue = createUiRequestQueue(child, ctx);

    // 快速入队三个请求（handler 被调用但不 resolve）
    enqueue("r1", makeSelectReq("Q1"));
    enqueue("r2", makeSelectReq("Q2"));
    enqueue("r3", makeSelectReq("Q3"));

    // 第一个请求立即开始处理
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["Q1"]);

    // resolve 第一个 → 第二个开始处理
    resolvers[0]({ value: "a1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["Q1", "Q2"]);

    // resolve 第二个 → 第三个开始处理
    resolvers[1]({ value: "a2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("第一个请求未 resolve 时第二个不调用 uiRequestHandler", async () => {
    const callOrder: string[] = [];
    let firstResolve: (v: UiResponse) => void;

    const handler: UiRequestHandler = vi.fn((req: UiRequest) => {
      callOrder.push(req.title ?? "");
      if (req.title === "Q1") {
        return new Promise<UiResponse>((resolve) => {
          firstResolve = resolve;
        });
      }
      return Promise.resolve<UiResponse>({ value: "done" });
    }) as unknown as UiRequestHandler;

    const child = makeFakeChild();
    const ctx = { uiRequestHandler: handler } as Parameters<
      typeof createUiRequestQueue
    >[1];
    const enqueue = createUiRequestQueue(child, ctx);

    enqueue("r1", makeSelectReq("Q1"));
    enqueue("r2", makeSelectReq("Q2"));

    // 只有 Q1 被调用，Q2 还在队列里
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["Q1"]);

    // 等一下，Q2 仍然不应该被调用
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["Q1"]);

    // resolve Q1 → Q2 才开始
    firstResolve!({ value: "a1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["Q1", "Q2"]);
  });
});

// ── LC-3/T2⑦ 验收⑤：timeout 字段透传链路（L1 队列 → handler 段）──
// 下游段（handler → dialogQueue 消费）由 dialog-queue.test.ts / ui-request-handler-factory.test.ts 锁死。

describe("UI 请求队列 — timeout 字段透传（LC-3/T2⑦）", () => {
  it("ExtensionUiRequest.timeout 经 handleUiRequest 到达 uiRequestHandler 收到的 UiRequest", async () => {
    const received: UiRequest[] = [];
    const handler: UiRequestHandler = (req: UiRequest) => {
      received.push(req);
      return Promise.resolve<UiResponse>({ value: "ok" });
    };

    const child = makeFakeChild();
    const ctx = { uiRequestHandler: handler } as Parameters<
      typeof createUiRequestQueue
    >[1];
    const enqueue = createUiRequestQueue(child, ctx);

    enqueue("r1", { ...makeSelectReq("Q1"), timeout: 5000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(1);
    expect(received[0].timeout).toBe(5000);
  });
});

// ── extractMethodFields 字段复制链路（经 createUiRequestQueue → handleUiRequest 锁定）──
// 13 个 method-specific 字段的复制语义：typed 守卫字段（string/number/array）验型通过才复制、
// presence-only 字段（statusText/widgetLines/widgetPlacement）仅 in 检查直赋、缺失字段不复制。
// 协议形状来自 JSON 反序列化，坏类型运行时可达——用例以 as unknown as 构造越界形状做防御锁定。

describe("UI 请求队列 — method-specific 字段复制（extractMethodFields 链路）", () => {
  function makeQueue(handler: UiRequestHandler): { enqueue: ReturnType<typeof createUiRequestQueue> } {
    const child = makeFakeChild();
    const ctx = { uiRequestHandler: handler } as Parameters<
      typeof createUiRequestQueue
    >[1];
    return { enqueue: createUiRequestQueue(child, ctx) };
  }

  it("全字段请求：typed 守卫字段与 presence-only 字段全部复制到 UiRequest", async () => {
    const received: UiRequest[] = [];
    const { enqueue } = makeQueue((req) => {
      received.push(req);
      return Promise.resolve<UiResponse>({ ack: true });
    });

    // 13 字段全量形状（协议 union 无单变体携带全部字段，运行时平铺可达）
    const req = {
      method: "select",
      title: "t",
      options: ["a", "b"],
      message: "m",
      placeholder: "p",
      prefill: "pf",
      notifyType: "warning",
      statusKey: "sk",
      statusText: "st",
      widgetKey: "wk",
      widgetLines: ["l1"],
      widgetPlacement: "belowEditor",
      text: "tx",
      timeout: 2500,
    } as unknown as Parameters<ReturnType<typeof createUiRequestQueue>>[1];

    enqueue("r1", req);
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      title: "t",
      options: ["a", "b"],
      message: "m",
      placeholder: "p",
      prefill: "pf",
      notifyType: "warning",
      statusKey: "sk",
      statusText: "st",
      widgetKey: "wk",
      widgetLines: ["l1"],
      widgetPlacement: "belowEditor",
      text: "tx",
      timeout: 2500,
    });
  });

  it("typed 守卫字段类型不符时跳过复制，其余字段照常", async () => {
    const received: UiRequest[] = [];
    const { enqueue } = makeQueue((req) => {
      received.push(req);
      return Promise.resolve<UiResponse>({ ack: true });
    });

    const req = {
      method: "select",
      title: "kept-title", // 合法（title 非法值会在链路上游 startsWith 处炸掉整条请求，见下一条用例）
      options: "not-array", // string ≠ array → 跳过
      timeout: "5000", // string ≠ number → 跳过
      message: "kept",
    } as unknown as Parameters<ReturnType<typeof createUiRequestQueue>>[1];

    enqueue("r1", req);
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(1);
    expect(received[0].title).toBe("kept-title");
    expect("options" in received[0]).toBe(false);
    expect("timeout" in received[0]).toBe(false);
    expect(received[0].message).toBe("kept");
  });

  it("typed 非法 title（number）在上游 startsWith 处炸链路 → handler 不被调、单请求失败被吞不阻塞队列", async () => {
    // HEAD 真实行为锚定（探针实证）：title: 42 在 extractMethodFields 之前的环节
    // 触发 str.startsWith is not a function，异常被 handleUiRequest 的 .catch 吞掉
    //（注释声明的「单个请求失败不阻塞后续」语义）——守卫的「跳过该字段」对 title 不可达。
    const received: UiRequest[] = [];
    const { enqueue } = makeQueue((req) => {
      received.push(req);
      return Promise.resolve<UiResponse>({ ack: true });
    });

    const badReq = {
      method: "select",
      title: 42,
      message: "kept",
    } as unknown as Parameters<ReturnType<typeof createUiRequestQueue>>[1];
    enqueue("r1", badReq);
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(0); // handler 未被调（链路在上游失败）

    // 队列不阻塞：后续合法请求照常处理
    enqueue("r2", {
      method: "select",
      title: "Q2",
      options: [JSON.stringify({ question: "Q2", options: [{ label: "A" }] })],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(1);
    expect(received[0].title).toBe("Q2");
  });

  it("presence-only 字段仅 in 检查直赋；未声明的字段不复制（保持 UiRequest 可选）", async () => {
    const received: UiRequest[] = [];
    const { enqueue } = makeQueue((req) => {
      received.push(req);
      return Promise.resolve<UiResponse>({ ack: true });
    });

    // statusText 存在但值为 undefined（statusText: string | undefined 变体合法形态）→ 仍复制
    const req = {
      method: "setStatus",
      statusKey: "k",
      statusText: undefined,
      unknownField: "should-not-copy",
    } as unknown as Parameters<ReturnType<typeof createUiRequestQueue>>[1];

    enqueue("r1", req);
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toHaveLength(1);
    expect("statusText" in received[0]).toBe(true);
    expect(received[0].statusText).toBeUndefined();
    expect("unknownField" in received[0]).toBe(false);
  });
});
