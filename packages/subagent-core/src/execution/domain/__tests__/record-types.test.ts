// src/execution/domain/__tests__/record-types.test.ts
//
// [subagent-observability u-foundation] StopReason 停因词表枚举完整性测试锚
// （设计 §3.3.3 轮收条事实化 + §3.4「NEW_STOP_REASONS/ROUND_TERMINAL_STOP_REASONS
// 常量锚与枚举完整性测试同批」——三词表锚之一的 record-types 同位）。
//
// 锁定范围：
//   ① 全枚举值数与成员逐一（16 值无重复——归档族 + 宿主中断族 + 引擎原值 +
//      迁移期旧值四个分区的并集）；
//   ② 轮终写入值域 ROUND_TERMINAL_STOP_REASONS = 引擎原值三态（stop/error/aborted
//      ——停因只存事实，u3 判定链接线后的唯一轮终写入词表）；
//   ③ 迁移期旧值 completed/failed 仍在解析词表（历史帧解析放行 + 双写期写侧兼容，
//      迁移完删旧值 §3.4——本用例在删值批随成员一并删除）；
//   ④ 词表混淆防线：引擎原值不与派生展示词混写（「cancelled 族」是 FailureCause
//      分型不是停因值——不新增 cancelled 停因成员的裁决锚）；
//   ⑤ isValidStopReason 边界：引擎原值放行、垃圾值拒绝（解析守卫与词表同源）。
//
// 纯常量断言，零 fs / 零 timer——不触碰真实数据目录。

import { describe, expect, it } from "vitest";

import {
  CLOSED_REASONS,
  LEGACY_INFERRED_STOP_REASONS,
  NEW_STOP_REASONS,
  ROUND_TERMINAL_STOP_REASONS,
  STOP_REASONS,
} from "../record-types.ts";
import { isValidStopReason } from "../record-model.ts";

describe("StopReason 枚举完整性（subagent-observability §3.3.3 轮收条事实化词表）", () => {
  it("全枚举 = 归档族 7 值（6 写值 + disconnected 读侧兜底）+ 宿主中断/重开 4 值 + 引擎原值 3 值 + 迁移期旧值 2 值 = 16 无重复", () => {
    expect(STOP_REASONS).toHaveLength(16);
    expect(new Set(STOP_REASONS).size).toBe(STOP_REASONS.length);
    for (const reason of [
      ...CLOSED_REASONS,
      "disconnected",
      ...NEW_STOP_REASONS,
      ...ROUND_TERMINAL_STOP_REASONS,
      ...LEGACY_INFERRED_STOP_REASONS,
    ] as const) {
      expect(STOP_REASONS).toContain(reason);
    }
  });

  it("NEW_STOP_REASONS 恰为 4 个宿主中断/重开事实词（宿主打断时引擎没机会报停因——宿主层事实词）", () => {
    expect([...NEW_STOP_REASONS]).toEqual([
      "interrupted",
      "interrupted-by-restart",
      "interrupted-by-parent",
      "reopened",
    ]);
  });

  it("ROUND_TERMINAL_STOP_REASONS = 引擎原值三态 stop/error/aborted（停因只存事实——推断值退出轮终写入值域）", () => {
    expect([...ROUND_TERMINAL_STOP_REASONS]).toEqual(["stop", "error", "aborted"]);
    // 引擎原值是 markRoundIdle 的写入词表（u3 接线后唯一轮终写入方），推断值不在内。
    expect(ROUND_TERMINAL_STOP_REASONS).not.toContain("completed");
    expect(ROUND_TERMINAL_STOP_REASONS).not.toContain("failed");
  });

  it("迁移期旧值 completed/failed 仍在解析词表（历史帧解析放行 + 双写期兼容；迁移完删旧值时本用例随成员同批删除）", () => {
    expect([...LEGACY_INFERRED_STOP_REASONS]).toEqual(["completed", "failed"]);
    for (const legacy of LEGACY_INFERRED_STOP_REASONS) {
      expect(STOP_REASONS).toContain(legacy);
      expect(isValidStopReason(legacy)).toBe(true);
    }
  });

  it("无 cancelled 停因值（「cancelled 族」是 FailureCause 分型不是停因——防第二套中止词表）", () => {
    // CLOSED_REASONS 的 'cancelled' 是旧 closed 终态历史成员（归档族，历史帧解析
    // 放行）；引擎原值/中断族/轮终写入值域不新增任何 cancelled 形态停因。
    expect(ROUND_TERMINAL_STOP_REASONS).not.toContain("cancelled");
    expect(NEW_STOP_REASONS).not.toContain("cancelled");
  });
});

describe("isValidStopReason 停因解析边界（解析守卫与词表同源）", () => {
  it("引擎原值三态放行；垃圾值/undefined 拒绝", () => {
    expect(isValidStopReason("stop")).toBe(true);
    expect(isValidStopReason("error")).toBe(true);
    expect(isValidStopReason("aborted")).toBe(true);
    expect(isValidStopReason("engine_stopped")).toBe(false);
    expect(isValidStopReason("")).toBe(false);
    expect(isValidStopReason(undefined)).toBe(false);
  });
});
