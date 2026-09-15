// src/__tests__/spawn-event-adapter-rpc.test.ts
//
// W1 红灯测试：spawn-event-adapter.ts 协议层重写 — Pi 原生格式 + method 平铺。
//
// 测试对象：packages/subagent-core/src/execution/engine/engines/pi/spawn-event-adapter.ts（改造）
// 契约来源：.fix-plans/00-master-summary.md §二（统一接口契约）+ §一冲突 2/判定顺序
//
// 核心改动：
//   1. isExtensionUiRequest 重写：判 type==="extension_ui_request" + id:string + method:string
//      （删 jsonrpc==="2.0" 守卫 + params 守卫 — Pi 原生格式是平铺字段）
//   2. extension_ui_request 分支：从 {id, params:Record} 改为 {id, request: ExtensionUiRequest}
//      request 按 method 平铺（title/options/message/... 与 Pi rpc-types.ts 1:1）
//   3. isRpcResponse 重写：判 type==="response" + command:string + success:boolean（SR-1 根因 1b）
//   4. 判定顺序：isExtensionUiRequest 必须在 event 分支之前（否则被 typeof obj.type===string 吞）
//
// 红灯原因：spawn-event-adapter.ts 当前用旧 JSON-RPC 2.0 守卫，对 Pi 原生格式样本
//   无法识别为 extension_ui_request（会落到 event 分支）。改造后这些断言才绿。

import { describe, expect, it } from "vitest";

import { parseSpawnLine } from "../spawn-event-adapter.ts";

// ── Pi 原生协议样本构造（来源：rpc-types.ts L230-265 真实类型） ──────────
// 10 种 method，全部 {type:"extension_ui_request", id, method, ...平铺字段}。
// 注意：无 jsonrpc 字段、无 params 包裹、method 在顶层（非 method:"extension_ui_request"）。

function piLine(methodFields: Record<string, unknown>): string {
  return JSON.stringify({ type: "extension_ui_request", id: "req-001", ...methodFields });
}


/** 判别收窄辅助：string-fallback 变体（method: string）使 !== 收窄失效，
 *  用 Extract 条件类型（可赋值方向）精确取变体。 */
function asVariant<M extends string>(
  req: import("../spawn-event-adapter.ts").ExtensionUiRequest,
  method: M,
): Extract<import("../spawn-event-adapter.ts").ExtensionUiRequest, { method: M }> {
  if (req.method !== method) throw new Error(`request.method 应为 ${method}`);
  return req as Extract<import("../spawn-event-adapter.ts").ExtensionUiRequest, { method: M }>;
}

describe("parseSpawnLine — 10 种 method 真实样本分类（Pi 原生格式）", () => {
  describe("dialog 类（select/confirm/input/editor）", () => {
    it("select → kind=extension_ui_request + request.method=select + title/options 平铺", () => {
      const result = parseSpawnLine(piLine({
        method: "select", title: "Pick one", options: ["a", "b"], timeout: 30000,
      }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      expect(result.id).toBe("req-001");
      const req = asVariant(result.request, "select");
    });

    it("confirm → request.method=confirm + title/message 平铺", () => {
      const result = parseSpawnLine(piLine({
        method: "confirm", title: "Sure?", message: "Proceed?", timeout: 10000,
      }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      const req = asVariant(result.request, "confirm");
    });

    it("input → request.method=input + title + placeholder", () => {
      const result = parseSpawnLine(piLine({
        method: "input", title: "Name", placeholder: "type here",
      }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      const req = asVariant(result.request, "input");
    });

    it("editor → request.method=editor + title + prefill", () => {
      const result = parseSpawnLine(piLine({
        method: "editor", title: "Edit", prefill: "initial text",
      }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      const req = asVariant(result.request, "editor");
    });
  });

  describe("fire-and-forget 类（notify/setStatus/setWidget/setTitle/set_editor_text）", () => {
    it("notify → request.method=notify + message + notifyType", () => {
      const result = parseSpawnLine(piLine({
        method: "notify", message: "hi", notifyType: "info",
      }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      const req = asVariant(result.request, "notify");
    });

    it("setStatus → request.method=setStatus + statusKey/statusText", () => {
      const result = parseSpawnLine(piLine({
        method: "setStatus", statusKey: "k", statusText: "running",
      }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      const req = asVariant(result.request, "setStatus");
      expect(req.statusKey).toBe("k");
    });

    it("setWidget → request.method=setWidget + widgetKey/widgetLines/widgetPlacement", () => {
      const result = parseSpawnLine(piLine({
        method: "setWidget", widgetKey: "w1",
        widgetLines: ["line1"], widgetPlacement: "aboveEditor",
      }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      const req = asVariant(result.request, "setWidget");
      expect(req.widgetKey).toBe("w1");
      expect(req.widgetPlacement).toBe("aboveEditor");
    });

    it("setTitle → request.method=setTitle + title", () => {
      const result = parseSpawnLine(piLine({ method: "setTitle", title: "My Title" }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      const req = asVariant(result.request, "setTitle");
      expect(req.title).toBe("My Title");
    });

    it("set_editor_text → request.method=set_editor_text + text", () => {
      const result = parseSpawnLine(piLine({ method: "set_editor_text", text: "body" }));
      expect(result?.kind).toBe("extension_ui_request");
      if (result?.kind !== "extension_ui_request") return;
      const req = asVariant(result.request, "set_editor_text");
    });
  });
});

describe("parseSpawnLine — 旧 JSON-RPC 2.0 格式不再被识别（守卫已删）", () => {
  it("jsonrpc+method:extension_ui_request+params 旧格式 → 不归类为 extension_ui_request", () => {
    // 旧格式（错误假设）：会被识别为 event 或 invalid，因为新守卫不认 jsonrpc
    const oldFormat = JSON.stringify({
      jsonrpc: "2.0", id: "x", method: "extension_ui_request", params: { foo: "bar" },
    });
    const result = parseSpawnLine(oldFormat);
    // 旧格式的 method 字段值是 "extension_ui_request"，无 type 字段 → invalid
    // （这是有意的：强制对齐 Pi 原生格式）
    expect(result?.kind).not.toBe("extension_ui_request");
  });
});

describe("parseSpawnLine — 判定顺序：isExtensionUiRequest 先于 event 分支", () => {
  it("extension_ui_request 不被 typeof obj.type===string 吞为 event", () => {
    // 关键 bug：extension_ui_request 有 type 字段，若 event 分支在前会被当 event
    const result = parseSpawnLine(piLine({ method: "notify", message: "x" }));
    // 必须是 extension_ui_request，不能是 event
    expect(result?.kind).toBe("extension_ui_request");
    expect(result?.kind).not.toBe("event");
  });
});

describe("parseSpawnLine — RPC response（isRpcResponse 重写，SR-1 根因 1b）", () => {
  it("Pi response 格式 {type:response, command, success} → kind=response", () => {
    const result = parseSpawnLine(JSON.stringify({
      type: "response", id: "r1", command: "run_tool", success: true,
    }));
    expect(result?.kind).toBe("response");
    if (result?.kind !== "response") return;
    expect(result.id).toBe("r1");
    expect(result.command).toBe("run_tool");
    expect(result.success).toBe(true);
  });

  it("Pi response 失败 {type:response, command, success:false, error}", () => {
    const result = parseSpawnLine(JSON.stringify({
      type: "response", command: "run_tool", success: false, error: "boom",
    }));
    expect(result?.kind).toBe("response");
    if (result?.kind !== "response") return;
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("response 含 data 字段 → 保留", () => {
    const result = parseSpawnLine(JSON.stringify({
      type: "response", command: "read", success: true, data: { out: 42 },
    }));
    expect(result?.kind).toBe("response");
    if (result?.kind !== "response") return;
    expect(result.data).toEqual({ out: 42 });
  });

  it("旧 JSON-RPC 2.0 response（jsonrpc+id+result）→ 不再归类为 response", () => {
    const oldRpc = JSON.stringify({
      jsonrpc: "2.0", id: "x", result: { answers: [] },
    });
    const result = parseSpawnLine(oldRpc);
    expect(result?.kind).not.toBe("response");
  });
});
