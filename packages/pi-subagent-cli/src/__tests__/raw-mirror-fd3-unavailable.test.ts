// src/__tests__/raw-mirror-fd3-unavailable.test.ts
//
// [C-U4] fd3 不可用的进程级一次性告警：设计 §3.4.4「warn 一次」+ raw-mirror 内部
// 注释「避免每个 run 重复尝试与告警」。修复前 fd3Unavailable 后每个 run 仍走
// `warn(...)`（引擎长驻进程下每个 task pi 都刷一条相同告警）。
//
// 测试手法：mock `node:fs.createWriteStream` 同步抛错（等价 EBADF 的创建期形态）；
// 真实 fd 3 在 vitest worker 里可能是内部管道，**禁止**创建真实 fd3 写入器。

import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: () => {
      throw new Error("EBADF: bad file descriptor, fd 3");
    },
  };
});

import { createFd3RawMirrorWriter, RAW_MIRROR_ENV_VAR, type RawMirrorWriter } from "../raw-mirror.ts";

describe("[C-U4] fd3 不可用：告警一次 + 后续 run 不重复建流", () => {
  it("连续 15 个 run：warn 仅一次，全部返回 undefined（不建任何写入器）", () => {
    const warns: string[] = [];
    const writers: Array<RawMirrorWriter | undefined> = [];
    for (let i = 0; i < 15; i += 1) {
      writers.push(
        createFd3RawMirrorWriter({
          recordId: `rec-fd3-off-${i}`,
          env: { [RAW_MIRROR_ENV_VAR]: "1" },
          warn: (message) => warns.push(message),
        }),
      );
    }
    expect(writers.every((writer) => writer === undefined)).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("unavailable");
    expect(warns[0]).toContain("fd3");
  });
});
