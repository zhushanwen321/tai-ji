// src/__tests__/server-run-front.test.ts
//
// [§2.11 第四批] run 前门两处纯逻辑的单测：未初始化拒绝（协议错误三件套）与
// task 子集还原（wire additive 纪律——有值才写，禁写 undefined 覆盖引擎缺省）。
//
// 为什么单独钉「有值才写」：写 undefined 会让引擎侧的模型缺省与 worktree 隔离路径的
// cwd 缺省被静默覆盖，症状是「模型没按配置走 / 子进程在错目录跑」，排查成本远高于此断言。

import { describe, expect, it } from "vitest";

import { EngineSdkError } from "../protocol/error-codes.ts";
import { assembleFullTask, notInitializedError } from "../server/index.ts";

describe("notInitializedError", () => {
  it("协议错误三件套（code / message / recovery）", () => {
    const err = notInitializedError();
    expect(err).toBeInstanceOf(EngineSdkError);
    const structured = err.toStructured();
    expect(structured.code).toBe("engine_protocol_not_initialized");
    expect(structured.message).toContain("run before initialize is a protocol violation");
    expect(structured.recovery).toBe("The host must complete the initialize handshake before dispatching runs.");
  });
});

describe("assembleFullTask（task 子集 + ctx 还原）", () => {
  it("model / cwd 有值才写：缺席时结果对象不含这两个键", () => {
    const full = assembleFullTask({ prompt: "p" } as never, {} as never);
    expect(full).toEqual({ prompt: "p" });
    expect("model" in full).toBe(false);
    expect("cwd" in full).toBe(false);
  });

  it("有值时按 ctx 覆盖 task 里的同名键（ctx 是权威还原源）", () => {
    const full = assembleFullTask(
      { prompt: "p", model: "task-model", cwd: "/task-cwd" } as never,
      { model: "ctx-model", cwd: "/ctx-cwd" } as never,
    );
    expect(full).toEqual({ prompt: "p", model: "ctx-model", cwd: "/ctx-cwd" });
  });

  it("只带其一：另一键保持缺席（不因另一方存在而被补 undefined）", () => {
    const full = assembleFullTask({ prompt: "p" } as never, { model: "m" } as never);
    expect(full).toEqual({ prompt: "p", model: "m" });
    expect("cwd" in full).toBe(false);
  });
});
