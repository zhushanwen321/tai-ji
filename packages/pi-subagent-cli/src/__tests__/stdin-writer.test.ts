// src/execution/__tests__/stdin-writer.test.ts
//
// stdin-writer.ts 单元测试——覆盖 respond（UiResponse 4 分支 + 序列化降级）+
// sendPromptCommand + sendGetStateCommand + writeStdinLine 背压。
//
// stdin-writer 是 spawn 改造的叶子 helper，向 rpc 子进程 stdin 写 JSON 命令。
// 与 run-spawn-integration.test.ts 的集成视角不同：本文件只测「给定 child + 入参，
// stdin 收到的确切字节内容」，逐分支验证协议格式正确性。
//
// 测试策略：
//   - 用 PassThrough 模拟 child.stdin（buffered，可事后读出 write 的字节）。
//   - 用 minimal ChildProcess 形状（{ stdin: PassThrough }）作 respond/sendPrompt 入参。
//   - respond 的 4 分支：value/confirmed/cancelled/ack。ack 不写 stdin（fire-and-forget）。
//   - JSON.stringify 降级（#16）：out.value 含循环引用 → 降级 cancelled + warn。
//   - sendPromptCommand：写 {type:"prompt",message,id} 一行。
//   - sendGetStateCommand：返回 reqId，写 {type:"get_state",id} 一行。
//   - writeStdinLine 背压：mock child.stdin.write 返回 false → warn 但不 throw。

import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock 共享 logger，让 logger.warn 可被 spy（源码已从 console.warn 改为 logger.warn）
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
// W7 迁移：stdin-writer 的日志面改 SDK logger facade——mock SDK barrel 的
// getLogger（其余成员 importOriginal 透传），保持 warn 断言面不变。
vi.mock("@zhushanwen/subagent-engine-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhushanwen/subagent-engine-sdk")>();
  return {
    ...actual,
    getLogger: () => loggerMock,
  };
});

import { respond, sendGetStateCommand, sendPromptCommand } from "../stdin-writer.ts";

// ── helpers ──

/** 用 PassThrough 构造最小合法的 ChildProcess（只测 stdin 写入）。 */
function makeChild(overrides: Partial<Pick<ChildProcess, "stdin">> = {}): ChildProcess {
  return {
    stdin: new PassThrough(),
    ...overrides,
  } as unknown as ChildProcess;
}

/**
 * 读出 child.stdin 已缓冲的全部字节（字符串）。
 *
 * PassThrough 默认是 flowing 模式，attach 'data' listener 后会 flush 缓冲。
 * 这里用 readable 状态：pause + read 取出全部缓冲。
 */
function readStdin(child: ChildProcess): string {
  const stream = child.stdin as unknown as PassThrough;
  stream.pause();
  return stream.read()?.toString() ?? "";
}

/** 从 child.stdin 已缓冲内容按行拆分（去空行），返回 JSON.parse 后的对象数组。 */
function readStdinLines(child: ChildProcess): unknown[] {
  const text = readStdin(child);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// vi.fn() 的返回类型原生含 .mock.calls——无需双重断言（ReturnType<typeof vi.fn> 已是强类型）。
let warnSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // stdin-writer 在背压 / 序列化失败时 logger.warn；测试 mock logger 避免噪声，且可断言调用。
  loggerMock.warn.mockClear();
  warnSpy = loggerMock.warn;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// respond：UiResponse 4 分支
// ============================================================

describe("respond — UiResponse 4 分支", () => {
  describe("value 分支", () => {
    it("out={value:'hello'} → stdin 收到 extension_ui_response 含 value 字段", () => {
      const child = makeChild();
      respond(child, "req-1", { value: "hello" });

      const lines = readStdinLines(child);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-1", value: "hello" });
    });

    it("value 为含 JSON 特殊字符的字符串 → 原样透传（不二次转义）", () => {
      // out.value 是字符串，JSON.stringify({value: out.value}) 会正确序列化。
      // 关键：out.value 本身不被 JSON.parse 二次处理——它就是字符串值。
      const child = makeChild();
      const payload = JSON.stringify({ q: "ans", n: 1 }); // 合法 JSON 字符串作为 value
      respond(child, "req-2", { value: payload });

      const lines = readStdinLines(child);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-2", value: payload });
    });
  });

  describe("confirmed 分支", () => {
    it("out={confirmed:true} → stdin 收到 confirmed:true", () => {
      const child = makeChild();
      respond(child, "req-3", { confirmed: true });

      const lines = readStdinLines(child);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-3", confirmed: true });
    });

    it("out={confirmed:false} → stdin 收到 confirmed:false（用户拒绝 confirm）", () => {
      const child = makeChild();
      respond(child, "req-4", { confirmed: false });

      const lines = readStdinLines(child);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-4", confirmed: false });
    });
  });

  describe("cancelled 分支", () => {
    it("out={cancelled:true} → stdin 收到 cancelled:true", () => {
      const child = makeChild();
      respond(child, "req-5", { cancelled: true });

      const lines = readStdinLines(child);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-5", cancelled: true });
    });
  });

  describe("ack 分支（fire-and-forget）", () => {
    it("out={ack:true} → 不写 stdin（SR-5：fire-and-forget 不期待响应）", () => {
      const child = makeChild();
      respond(child, "req-6", { ack: true });

      // ack 分支 line 保持 undefined → writeStdinLine 不被调 → stdin 无数据
      expect(readStdin(child)).toBe("");
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

// ============================================================
// respond：JSON.stringify 降级（#16）
// ============================================================

describe("respond — JSON.stringify 失败降级为 cancelled (#16)", () => {
  it("out.value 含循环引用 → 降级 cancelled:true + warn，不让父进程崩溃", () => {
    // 构造循环引用对象：JSON.stringify 会抛 Converting circular structure to JSON
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const child = makeChild();
    respond(child, "req-circular", { value: circular } as never);

    // 降级为 cancelled
    const lines = readStdinLines(child);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      type: "extension_ui_response",
      id: "req-circular",
      cancelled: true,
    });
    // warn 被调用（含 request id）
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnArg).toContain("req-circular");
    expect(warnArg).toContain("JSON.stringify failed");
  });

  it("out.value 含 BigInt → JSON.stringify 抛 → 降级 cancelled + warn", () => {
    // BigInt 不可 JSON 序列化（JSON.stringify 抛 TypeError: Do not know how to serialize a BigInt）
    const child = makeChild();
    respond(child, "req-bigint", { value: BigInt(123) } as never);

    const lines = readStdinLines(child);
    expect(lines[0]).toEqual({
      type: "extension_ui_response",
      id: "req-bigint",
      cancelled: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("降级后的 cancelled 响应格式与正常 cancelled 分支一致（协议兼容）", () => {
    // 确保降级走的是同一个 cancelled 格式（子进程解析逻辑无需区分「真取消」vs「序列化失败」）
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const childFail = makeChild();
    const childCancel = makeChild();
    respond(childFail, "same-id", { value: circular } as never);
    respond(childCancel, "same-id", { cancelled: true });

    const failLine = readStdinLines(childFail)[0];
    const cancelLine = readStdinLines(childCancel)[0];
    expect(failLine).toEqual(cancelLine);
  });
});

// ============================================================
// respond：signal.aborted 守卫
// ============================================================

describe("respond — signal 已 aborted 跳过写入", () => {
  it("signal.aborted=true → 不写 stdin", () => {
    const child = makeChild();
    const controller = new AbortController();
    controller.abort();

    respond(child, "req-aborted", { value: "x" }, controller.signal);

    expect(readStdin(child)).toBe("");
  });

  it("signal.aborted=false → 正常写入", () => {
    const child = makeChild();
    const controller = new AbortController();

    respond(child, "req-active", { value: "x" }, controller.signal);

    const lines = readStdinLines(child);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ type: "extension_ui_response", id: "req-active", value: "x" });
  });
});

// ============================================================
// sendPromptCommand
// ============================================================

describe("sendPromptCommand", () => {
  it("写入 {type:'prompt',message,id} 一行，message 含完整 task 文本", () => {
    const child = makeChild();
    const task = "Task: do something complex\nwith newline";
    sendPromptCommand(child, task);

    const lines = readStdinLines(child);
    expect(lines).toHaveLength(1);
    const cmd = lines[0] as { type: string; message: string; id: string };
    expect(cmd.type).toBe("prompt");
    expect(cmd.message).toBe(task); // 多行 task 原样透传
    expect(typeof cmd.id).toBe("string");
    expect(cmd.id.length).toBeGreaterThan(0); // crypto.randomUUID 生成
  });

  it("每次调用生成不同 id（crypto.randomUUID）", () => {
    const child = makeChild();
    sendPromptCommand(child, "task-1");
    sendPromptCommand(child, "task-2");

    const lines = readStdinLines(child);
    expect(lines).toHaveLength(2);
    const id1 = (lines[0] as { id: string }).id;
    const id2 = (lines[1] as { id: string }).id;
    expect(id1).not.toBe(id2);
  });

  it("写入以 \\n 结尾（rpc 子进程按行读 stdin）", () => {
    const child = makeChild();
    sendPromptCommand(child, "task");

    // 直接查 raw 字节，验证末尾换行
    const raw = readStdin(child);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("child.stdin 已 destroyed → 静默跳过（guard 生效，不抛错）", () => {
    const stdin = new PassThrough();
    stdin.destroy();
    const child = { stdin } as unknown as ChildProcess;

    expect(() => sendPromptCommand(child, "task")).not.toThrow();
    // destroyed 后 write 无效，但函数安全返回
  });

  it("child.stdin 为 null/undefined → 静默跳过（guard 生效）", () => {
    const child = { stdin: null } as unknown as ChildProcess;
    expect(() => sendPromptCommand(child, "task")).not.toThrow();
  });

  // [V2 决策 3] streamingBehavior 可选参数：续聊热路径用 prompt+streamingBehavior 统一投递
  it("options.streamingBehavior='followUp' → 写入 streamingBehavior:followUp 字段", () => {
    const child = makeChild();
    sendPromptCommand(child, "queue this", { streamingBehavior: "followUp" });

    const lines = readStdinLines(child);
    expect(lines).toHaveLength(1);
    const cmd = lines[0] as { type: string; message: string; streamingBehavior?: string };
    expect(cmd.type).toBe("prompt");
    expect(cmd.message).toBe("queue this");
    expect(cmd.streamingBehavior).toBe("followUp");
  });

  it("options.streamingBehavior='steer' → 写入 streamingBehavior:steer 字段", () => {
    const child = makeChild();
    sendPromptCommand(child, "interrupt now", { streamingBehavior: "steer" });

    const lines = readStdinLines(child);
    const cmd = lines[0] as { streamingBehavior?: string };
    expect(cmd.streamingBehavior).toBe("steer");
  });

  it("省略 options → 不写入 streamingBehavior 字段（向后兼容，首帧 prompt 形态）", () => {
    const child = makeChild();
    sendPromptCommand(child, "first task");

    const lines = readStdinLines(child);
    const cmd = lines[0] as { streamingBehavior?: string };
    expect(cmd.streamingBehavior).toBeUndefined();
  });
});

// ============================================================
// sendGetStateCommand
// ============================================================

describe("sendGetStateCommand", () => {
  it("写入 {type:'get_state',id} 一行并返回相同 id（用于匹配 response）", () => {
    const child = makeChild();
    const returnedId = sendGetStateCommand(child);

    const lines = readStdinLines(child);
    expect(lines).toHaveLength(1);
    const cmd = lines[0] as { type: string; id: string };
    expect(cmd.type).toBe("get_state");
    expect(cmd.id).toBe(returnedId); // 返回值与写入的 id 一致
    expect(typeof cmd.id).toBe("string");
    // get_state 命令不含其他字段（只有 type + id）
    expect(Object.keys(cmd).sort()).toEqual(["id", "type"]);
  });

  it("写入以 \\n 结尾", () => {
    const child = makeChild();
    sendGetStateCommand(child);

    const raw = readStdin(child);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("每次调用返回不同 id（crypto.randomUUID）", () => {
    const child = makeChild();
    const id1 = sendGetStateCommand(child);
    const id2 = sendGetStateCommand(child);
    expect(id1).not.toBe(id2);
  });
});

// ============================================================
// writeStdinLine 背压（间接经 respond 测）
// ============================================================

describe("writeStdinLine 背压 — write 返回 false 时 warn 不 throw", () => {
  it("child.stdin.write 返回 false → warn 一次，函数正常返回（不 throw）", () => {
    // 构造 write 永远返回 false 的假 stream（模拟内核缓冲满/HWM 到达）
    // 保留 vi.fn 引用（经 PassThrough 视图后 write 的 mock 面不可达）
    const fakeWrite = vi.fn((_chunk: unknown) => false);
    const fakeStdin = {
      write: fakeWrite,
      destroyed: false,
    } as unknown as PassThrough;
    const child = { stdin: fakeStdin } as unknown as ChildProcess;

    expect(() => respond(child, "req-backpressure", { value: "x" })).not.toThrow();

    // write 被调一次（写入 command 行）
    expect(fakeWrite).toHaveBeenCalledTimes(1);
    const writtenArg = fakeWrite.mock.calls[0]![0] as string;
    expect(writtenArg).toContain("extension_ui_response");
    expect(writtenArg).toContain("req-backpressure");
    expect(writtenArg.endsWith("\n")).toBe(true);
    // warn 被调（背压告警）
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("backpressure");
  });

  it("child.stdin.write 返回 true → 不 warn（正常路径）", () => {
    const fakeStdin = {
      write: vi.fn(() => true),
      destroyed: false,
    } as unknown as PassThrough;
    const child = { stdin: fakeStdin } as unknown as ChildProcess;

    respond(child, "req-ok", { value: "x" });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// [review 修复 round2] 已删除 sendFollowUpCommand / sendSteerCommand 两 describe——
// 随 deliverToRunning（S2）死亡后两函数成零生产调用方的死 export，一并移除。
// busy 投递语义由 prompt + streamingBehavior（"followUp"/"steer"，sendPromptCommand）承担。

// ============================================================
// writeStdinLine EPIPE / ERR_STREAM_DESTROYED 检测（R3）
// ============================================================

describe("writeStdinLine EPIPE 检测 — EPIPE / ERR_STREAM_DESTROYED throw", () => {
  it("child.stdin.write 抛 {code:'EPIPE'} → throw 含 EPIPE 关键词", () => {
    const fakeStdin = {
      write: vi.fn(() => {
        const err = Object.assign(new Error("write after end"), { code: "EPIPE" });
        throw err;
      }),
      destroyed: false,
    } as unknown as PassThrough;
    const child = { stdin: fakeStdin } as unknown as ChildProcess;

    expect(() => respond(child, "req-epipe", { value: "x" })).toThrow(/EPIPE/);
  });

  it("child.stdin.write 抛 {code:'ERR_STREAM_DESTROYED'} → throw 含 EPIPE 关键词", () => {
    const fakeStdin = {
      write: vi.fn(() => {
        const err = Object.assign(new Error("Stream is destroyed"), {
          code: "ERR_STREAM_DESTROYED",
        });
        throw err;
      }),
      destroyed: false,
    } as unknown as PassThrough;
    const child = { stdin: fakeStdin } as unknown as ChildProcess;

    expect(() => sendPromptCommand(child, "task")).toThrow(/EPIPE/);
  });

  it("child.stdin.destroyed=true → 静默跳过（guard 生效，不触发 write）", () => {
    const fakeStdin = {
      write: vi.fn(),
      destroyed: true,
    } as unknown as PassThrough;
    const child = { stdin: fakeStdin } as unknown as ChildProcess;

    expect(() => respond(child, "req-destroyed", { value: "x" })).not.toThrow();
    // destroyed guard 生效，write 不被调用
    expect(fakeStdin.write).not.toHaveBeenCalled();
  });

  it("child.stdin.write 抛非 EPIPE 错误 → warn 降级不 throw（兜底）", () => {
    const fakeStdin = {
      write: vi.fn(() => {
        throw new Error("some other error");
      }),
      destroyed: false,
    } as unknown as PassThrough;
    const child = { stdin: fakeStdin } as unknown as ChildProcess;

    // 非 EPIPE 错误应 warn 降级，不 throw
    expect(() => respond(child, "req-other-err", { value: "x" })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain("unexpected stdin write error");
  });
});
