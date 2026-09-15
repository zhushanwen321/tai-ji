// src/orchestration/__tests__/worker-message-pump-serialize-failed-result.test.ts
//
// makeSerializeFailedResult 独立单测（W2 防御关键纯函数）。
//
// 背景：postMessage 序列化失败时，主线程需回发「必可克隆」的 fallback result
// 让 worker 内 pending Promise resolve（否则 agent()/workflow() 永久挂起，只能靠
// timeout 兜底）。两条 fallback 路径（postAgentResult / dispatchWorkflowCall.postResult）
// 共享 makeSerializeFailedResult 构造逻辑——本测试锁住其返回 shape，确保两条路径
// 不漂移。
//
// 验证点：
//   1. content 恒为 ""（纯字符串 fallback，必可克隆——不含 function/Symbol/循环引用）
//   2. error 形如 "<prefix>: <errMsg>"（前缀区分调用方，便于诊断定位）
//   3. prefix / errMsg 各自原样透传（含空串、特殊字符、多行）

import { describe, expect, it } from "vitest";

import { makeSerializeFailedResult } from "../worker-message-pump.ts";

describe("makeSerializeFailedResult", () => {
  it("返回 {content:'', error:'<prefix>: <errMsg>'} 形状（必可克隆 fallback）", () => {
    const result = makeSerializeFailedResult("Result serialization failed", "DataCloneError: ...");
    expect(result).toEqual({
      content: "",
      error: "Result serialization failed: DataCloneError: ...",
    });
  });

  it("content 恒为空串（纯字符串 fallback，不含不可克隆成员）", () => {
    // 无论入参如何，content 必为 ""——postMessage 必须能克隆这个 fallback result。
    const result = makeSerializeFailedResult("any prefix", "any error");
    expect(result.content).toBe("");
  });

  it("error 由 prefix + ': ' + errMsg 拼接（前缀区分调用方，便于诊断）", () => {
    const result = makeSerializeFailedResult("Workflow result serialization failed", "boom");
    expect(result.error).toBe("Workflow result serialization failed: boom");
    // 分隔符固定为 ": "——两条 fallback 路径共享同一构造逻辑。
    expect(result.error).toContain(": ");
  });

  it("prefix 与 errMsg 原样透传（含空串、特殊字符、多行）", () => {
    // 空串 prefix
    expect(makeSerializeFailedResult("", "err").error).toBe(": err");
    // 空串 errMsg
    expect(makeSerializeFailedResult("prefix", "").error).toBe("prefix: ");
    // 含冒号 / 换行 / unicode 的 errMsg（原样透传，不做转义）
    const weird = "err: with: colons\nand newline 中文 🚀";
    expect(makeSerializeFailedResult("P", weird).error).toBe(`P: ${weird}`);
  });

  it("返回对象字段仅 content + error（无多余字段，shape 稳定不漂移）", () => {
    const result = makeSerializeFailedResult("p", "e");
    expect(Object.keys(result).sort()).toEqual(["content", "error"]);
  });
});
