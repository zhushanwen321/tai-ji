// 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）
// 运行命令：npx vitest run tests/characterization-hook.test.ts
//
// [HISTORICAL 背景] 行为基线测试（characterization test）：
// 在 M4 拆模块重构（src/index.ts 单文件 → 6 模块，setupWorkflowHook 的 4 个
// mutable 闭包 → RetryState 显式类）之前，对旧 setupWorkflowHook 的对外行为
// 锁基线。重构（M4-T6）后本文件必须零改动继续全绿——这是「重构不改行为」的证明。
//
// 锁定旧实现的两个微妙时序（重构时最容易悄悄改变的）：
//   1. soCallCount 只在「判定要 steer 的分支」重置——toolUse / 超上限的 turn_end
//      直接 return，不重置计数（toolUse 后同一 turn 链的失败累计仍走 FAILED 分支）
//   2. lastSchemaError 只在 steer 后清空——超上限时保留最近错误（turn 自然结束）
//
// [U2 重锁 2026-08-28] 设计 §7.4「RetryState 增 terminal 态」为允许的基线变更：
//   - ②：同 turn 3 次同签名失败 → 闸门（loop-gate）在第 3 次 terminal + shutdown，
//     turn_end 不再 steer（旧基线：single steer）——硬闸门接管软 steer
//   - ③：第 3 轮失败同时是第 3 次同签名失败 → terminal 抢在 hookRetryCount 上限
//     之前拦截（旧基线：超上限放弃）；steer 总数仍 2，新增 shutdown 副作用断言

import { afterEach, describe, expect, it, vi } from "vitest";

// ── mock pi 公共 fixture（M5-T4：与 structured-output.test.ts Workflow hook 组共享）──
// on() 收集回调，emit() 按注册顺序触发（第二参数恒传含 shutdown 的 handlerCtx），
// sendUserMessage/appendEntry/ctx.shutdown spy。
import {
  createMockPi,
  FAILED_TOOL_END,
  failedToolEndWith,
  loadExtension,
  paramLayerErrorText,
  restoreSchemaEnv,
  SCHEMA,
  SCHEMA_ENV_NAME,
  SUCCESS_TOOL_END,
  turnEndPayload,
} from "./mock-pi-fixture.js";

const originalSchemaEnv = process.env[SCHEMA_ENV_NAME];

afterEach(() => {
  // fixture 的 restoreSchemaEnv 只处理 env；vi.restoreAllMocks 必须在消费方保留
  restoreSchemaEnv(originalSchemaEnv);
  // 闸门 terminal 会武装真实 15s 兜底硬退 timer——触发 terminal 的测试用 fake timers
  // 包裹，此处还原真实 timers 并丢弃未触发的 fake timer（不残留跨测试的硬退风险）
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 时序断言（4 个）：旧 4-closure 实现的行为基线 ──────────────

describe("characterization: setupWorkflowHook timing (baseline before RetryState refactor)", () => {
  it("① toolUse turn_end does not reset soCallCount → next turn's failure steers with FAILED validation (not MUST call)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // turn 1: 失败调用 + toolUse turn_end → 不干预（模型还在调工具链）
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload("toolUse"));
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    // turn 2: 再次失败调用 + stop（StopReason 真实枚举成员，原误写 end_turn）→ steer。
    // soCallCount 未被 toolUse turn 重置（累计 2），calledButFailed=true →
    // 文案走 FAILED validation 分支而非 MUST call。
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendUserMessage.mock.calls[0]![0] as string;
    expect(msg).toContain("FAILED validation");
    expect(msg).not.toContain("MUST call the structured-output tool");
  });

  it("② [U2 重锁] 3 same-signature failures in one turn → gate terminal + shutdown at 3rd, turn_end does NOT steer (was: single steer)", async () => {
    vi.useFakeTimers(); // terminal 武装 15s 兜底硬退 timer——fake 掉避免真实 timer 泄漏
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    expect(pi.ctx.shutdown).not.toHaveBeenCalled(); // 2 次 < 阈值 3
    // 第 3 次同签名失败：闸门 terminal → onTerminal 标记 RetryState.terminal + shutdown
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "structured-output:gate",
      expect.objectContaining({ event: "terminated", consecutiveFailures: 3 }),
    );

    // turn_end：守卫链第 0 条（terminal）拦截 → 不 steer（旧基线：1 次 steer）
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("③ [U2 重锁] 3 failed turns → exactly 2 steers; 3rd failure (same signature ×3) hits gate terminal BEFORE retry-cap give-up → shutdown", async () => {
    vi.useFakeTimers(); // terminal 武装 15s 兜底硬退 timer——fake 掉避免真实 timer 泄漏
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 失败→steer 循环 3 轮：前 2 轮 steer（失败次数 1、2），第 3 轮失败是第 3 次
    // 同签名失败 → 闸门 terminal + shutdown；turn_end 被守卫链第 0 条拦截不 steer。
    // steer 总数与旧基线一致（2），拦截者从 hookRetryCount 上限变为 terminal。
    for (let i = 0; i < 3; i++) {
      await pi.emit("tool_execution_end", FAILED_TOOL_END);
      await pi.emit("turn_end", turnEndPayload());
    }
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);
  });

  it("④ after a successful call, later failed calls never steer again (soSucceededEver short-circuit; gate count cleared by success)", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 成功调用 → soSucceededEver=true（终态）。后续失败调用 + turn_end 均不干预。
    // 闸门侧：成功清零后仅 1 次失败，未达阈值 → 无 shutdown（软硬闸门互不干扰）。
    await pi.emit("tool_execution_end", SUCCESS_TOOL_END);
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.ctx.shutdown).not.toHaveBeenCalled();
  });

  // [U2 新增基线] 设计 §7.4：terminal 是 shutdown 失效路径下的保险分支——
  // 本测试锁「terminal 后 hook 彻底哑火」：即使 turn_end 带不同 stopReason/
  // 后续失败继续到达，也不再有任何 steer。
  it("⑤ [U2] after gate terminal, no steer under ANY subsequent turn_end shape (shutdown-failure insurance)", async () => {
    vi.useFakeTimers(); // terminal 武装 15s 兜底硬退 timer——fake 掉避免真实 timer 泄漏
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 3 次同签名失败 → terminal
    for (let i = 0; i < 3; i++) {
      await pi.emit("tool_execution_end", FAILED_TOOL_END);
    }
    expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);

    // 保险分支：后续任意 turn 形态（toolUse / stop）与失败均不 steer
    await pi.emit("turn_end", turnEndPayload("toolUse"));
    await pi.emit("tool_execution_end", failedToolEndWith("a different error"));
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    // terminal 幂等：第 4+ 次失败不重复 shutdown
    expect(pi.ctx.shutdown).toHaveBeenCalledTimes(1);
  });

  // ── U3（审查项#8/#9/#1）新增基线 ─────────────────────────────

  // 每轮不同字段的失败原料——字段集合不同 = 闸门签名不同，避免闸门 terminal
  //（3 次同签名）先于 hook 上限拦截，干扰预算语义断言。
  const failWith = (field: string) =>
    failedToolEndWith(paramLayerErrorText(`  - ${field}: must be number`, "{}"));

  it("⑥ [U3 审查项#9 + F4] stopReason=error/aborted/deferred 轮不 steer（防 chatMode 复用子进程时陈旧 steer 泄漏到下一轮），预算不扣、状态保留", async () => {
    // deferred：pi-ai StopReason 枚举成员（types.d.ts:275，provider 延迟响应挂起）——
    // 与 error/aborted 同属「本轮无可消费 steer 的收尾点」形态，不发送不扣预算。
    for (const stopReason of ["error", "aborted", "deferred"]) {
      const pi = createMockPi();
      await loadExtension(pi, SCHEMA);

      await pi.emit("tool_execution_end", FAILED_TOOL_END);
      await pi.emit("turn_end", turnEndPayload(stopReason));
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(pi.appendEntry).not.toHaveBeenCalled();

      // 预算不扣减 + 失败状态保留：下一个正常收尾的轮仍 steer，
      // 且因 soCallCount/lastSchemaError 保留走 FAILED 分支（非 MUST call）
      await pi.emit("turn_end", turnEndPayload());
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
      const msg = pi.sendUserMessage.mock.calls[0]![0] as string;
      expect(msg).toContain("FAILED validation");
      expect(msg).toContain("Schema validation failed: /count must be number");
    }
  });

  it("⑦ [U3 审查项#8] steer 发送失败（rejected promise）→ 不扣预算 + appendEntry 告警，后续轮仍可 steer（不永久哑火）", async () => {
    // 注（形态契约锁定）：pi 0.84.1 实装下 extension 侧 sendUserMessage 的异步 rejection
    // 被 pi 吞（loader.js 同步转发 + .catch(emitError) 转事件，不冒泡到调用方），
    // 本用例在 mock 层构造 reject，锁定的是「未来 pi 返回真 Promise 时 hook 不得
    // 白扣预算/不得永久哑火」的 Promise 形态契约，非 0.84.1 现网行为复现。
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // 第 1 轮：发送失败（await 路径 reject —— 模拟 compaction 中 prompt() 抛错）
    pi.sendUserMessage.mockRejectedValueOnce(new Error("compaction in progress"));
    await pi.emit("tool_execution_end", failWith("count"));
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // 失败告警：appendEntry 持久化（沿用本包 customType 通道格式）
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    const [entryType, entryData] = pi.appendEntry.mock.calls[0]!;
    expect(entryType).toBe("structured-output:hook");
    expect(entryData).toMatchObject({
      event: "steer_send_failed",
      error: "compaction in progress",
    });

    // 预算未扣减证明：之后两个正常轮各 steer 一次（若失败轮白扣，此处只剩 1 次）
    await pi.emit("tool_execution_end", failWith("alpha"));
    await pi.emit("turn_end", turnEndPayload());
    await pi.emit("tool_execution_end", failWith("beta"));
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);

    // 第 4 个正常轮：hookRetryCount=2 达上限 → 放弃（失败有界语义不变）
    await pi.emit("tool_execution_end", failWith("gamma"));
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(3);
  });

  it("⑧ [U3 审查项#8] steer 发送同步 throw（扩展被拒）→ 同样不扣预算 + 告警含错误文本", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    pi.sendUserMessage.mockImplementationOnce(() => {
      throw new Error("extension deactivated");
    });
    await pi.emit("tool_execution_end", FAILED_TOOL_END);
    await pi.emit("turn_end", turnEndPayload());
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "structured-output:hook",
      expect.objectContaining({ event: "steer_send_failed", error: "extension deactivated" }),
    );
    expect(pi.ctx.shutdown).not.toHaveBeenCalled();
  });

  it("⑨ [U3 审查项#1] 大 payload 失败：回灌错误块经截断有界化，首部错误类型+字段名保留，全量实参回显不整体入回灌", async () => {
    const pi = createMockPi();
    await loadExtension(pi, SCHEMA);

    // ≈11K chars 的参数层错误（审查场景：pi-ai validation.js 实参回显无截断）
    const bigEcho = JSON.stringify({ payload: "x".repeat(11000) }, null, 2);
    await pi.emit(
      "tool_execution_end",
      failedToolEndWith(paramLayerErrorText("  - assessments.0.impact: must be string", bigEcho)),
    );
    await pi.emit("turn_end", turnEndPayload());

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendUserMessage.mock.calls[0]![0] as string;
    expect(msg).toContain("FAILED validation");
    expect(msg).toContain("Validation failed for tool");
    expect(msg).toContain("assessments.0.impact"); // 首部关键信息：错误字段名保留
    expect(msg).not.toContain(bigEcho); // 全量实参回显不得整体进入回灌
    expect(msg.length).toBeLessThan(2000); // 有界（错误块 ≤500c + schema + 指引）
  });
});
