// errors.test.ts —— 引擎层错误 SSOT 的结构锁定。
//
// 三视角：①构建者——12 条 code 与设计错误规格全表一致（[W3] 协议化增
// engine_capability_mismatch——manifest 多声明的 run 期握手阻断面，与 SDK 协议错误码
// 词表同源）；②使用者——错误消息 code 前缀格式可被字符串匹配分流；③观察者——每条
// 错误必有非空恢复指引（可操作）。

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECOVERY_HINTS,
  ENGINE_ERROR_CODES,
  EngineError,
  engineRunFailedDetail,
  engineTimeoutDetail,
  isEngineErrorCode,
  promptTooLargeError,
  STDOUT_TAIL_ECHO_CHARS,
} from "../../common/errors.ts";

describe("ENGINE_ERROR_CODES（§3.3.3 全表）", () => {
  it("12 条错误码与设计文档错误规格表逐条一致（[W3] 协议化增 engine_capability_mismatch）", () => {
    expect([...ENGINE_ERROR_CODES]).toEqual([
      "engine_not_found",
      "engine_probe_failed",
      "engine_credential_missing",
      "nested_spawn_rejected",
      "schema_emulation_failed",
      "engine_timeout",
      "engine_capability_unsupported",
      "engine_capability_mismatch",
      "engine_session_not_resumable",
      "model_not_available",
      "prompt_too_large",
      "engine_run_failed",
    ]);
  });

  it("isEngineErrorCode 收窄：表内 code 为 true，表外/非字符串为 false", () => {
    expect(isEngineErrorCode("engine_timeout")).toBe(true);
    expect(isEngineErrorCode("engine_not_found")).toBe(true);
    expect(isEngineErrorCode("engine_oops")).toBe(false);
    expect(isEngineErrorCode(42)).toBe(false);
    expect(isEngineErrorCode(undefined)).toBe(false);
  });
});

describe("DEFAULT_RECOVERY_HINTS（恢复指引全集）", () => {
  it("11 条 code 每条都有非空恢复指引（可操作，非安慰性文案）", () => {
    for (const code of ENGINE_ERROR_CODES) {
      const hint = DEFAULT_RECOVERY_HINTS[code];
      expect(hint, `recovery hint for ${code}`).toMatch(/\S/);
      expect(hint.length).toBeGreaterThan(20);
    }
  });

  it("关键恢复动作在指引中（抽查三条错误规格的载体系数）", () => {
    expect(DEFAULT_RECOVERY_HINTS.engine_timeout).toMatch(/stdout tail/i);
    expect(DEFAULT_RECOVERY_HINTS.prompt_too_large).toMatch(/stdin/);
    expect(DEFAULT_RECOVERY_HINTS.nested_spawn_rejected).toMatch(/inside the current task/);
  });
});

describe("EngineError", () => {
  it("message 为 <code>: <detail> 前缀格式（outcome.error 分流依据）", () => {
    const err = new EngineError("engine_timeout", "chain exhausted", "retry with pi");
    expect(err.message).toBe("engine_timeout: chain exhausted");
    expect(err.code).toBe("engine_timeout");
    expect(err.recovery).toBe("retry with pi");
    expect(err.name).toBe("EngineError");
  });

  it("toStructured 投影 code/message/recovery 三字段", () => {
    const structured = new EngineError("model_not_available", "no such model", "pick another").toStructured();
    expect(structured).toEqual({
      code: "model_not_available",
      message: "model_not_available: no such model",
      recovery: "pick another",
    });
  });
});

describe("具名构造器", () => {
  it("promptTooLargeError：detail 含实际/上限字节数，recovery 含三条恢复建议", () => {
    const err = promptTooLargeError(200_000, 131_072);
    expect(err.code).toBe("prompt_too_large");
    expect(err.message).toContain("200000");
    expect(err.message).toContain("131072");
    expect(err.recovery).toMatch(/shorten the task/i);
    expect(err.recovery).toMatch(/file channel/);
    expect(err.recovery).toMatch(/stdin/);
  });

  it("engineTimeoutDetail：含 stdout 尾部 + engine: pi 重跑建议", () => {
    const detail = engineTimeoutDetail("partial stdout output");
    expect(detail).toContain("partial stdout output");
    expect(detail).toMatch(/SIGTERM/);
    expect(detail).toMatch(/SIGKILL/);
    expect(detail).toMatch(/`engine: pi`/);
  });

  it(`engineTimeoutDetail：stdout 尾部截断到 ${STDOUT_TAIL_ECHO_CHARS} 字符`, () => {
    const longTail = "x".repeat(STDOUT_TAIL_ECHO_CHARS + 500);
    const detail = engineTimeoutDetail(longTail);
    // 截断后含省略号标记，总长有界（不含前后固定文案不超过 2000 + 常量开销）
    expect(detail).toContain("...");
    expect(detail.length).toBeLessThan(STDOUT_TAIL_ECHO_CHARS + 600);
  });

  it("engineRunFailedDetail：含 reason / exit code / 尾部 / 恢复指引", () => {
    const detail = engineRunFailedDetail("stdout parse failed", 3, "some output");
    expect(detail).toContain("stdout parse failed");
    expect(detail).toContain("exit code 3");
    expect(detail).toContain("some output");
    expect(detail).toMatch(/probe/);
    // exitCode=null（被信号杀死）的形态
    expect(engineRunFailedDetail("crash", null, "t")).toContain("killed by signal");
  });

  // nestedSpawnRejectedError 用例已随构造器删除（nesting-guard 收编 SDK 后死导出，
  // 活体单源 SDK nesting-guard.ts NestedSpawnRejectedError，其行为由 SDK
  // __tests__/primitives.test.ts + 本目录 nesting-guard.test.ts 覆盖）。
  // schemaEmulationFailedDetail 用例已随函数删除（test-only 死镜像收口，活体单源
  // SDK error-codes.ts，其行为由 SDK __tests__/primitives.test.ts 覆盖）。
});
