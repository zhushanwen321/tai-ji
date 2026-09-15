// src/execution/__tests__/get-state-handshake.test.ts
//
// performGetStateHandshake 单测（FR-4）：spawn 期 get_state 握手的重试节奏
// （2s 超时 + 500ms 间隔 × 3 次 + 加速路径；fake timers 驱动）。
// [modeless 波2] 原第一个 describe（requestGetStateOnce——agent_end 惰性回补单次
// 请求）已随 one-shot 回补机械删除（git 可追溯）。

import { describe, expect, it, vi } from "vitest";

import { performGetStateHandshake } from "../get-state-handshake.ts";
import type { ChildProcess } from "node:child_process";

/**
 * 最小 FakeChild：只需 stdin.write 行为（成功 / 可注入同步 throw）。
 *
 * @param behavior.throwOnWriteTimes 前 N 次调用抛错（缺省 = 每次都抛）；
 *        抛错调用不记入 writes（writes = 成功写出的行）。
 */
function makeFakeStdin(behavior?: { throwOnWrite?: Error; throwOnWriteTimes?: number }): { child: ChildProcess; writes: string[] } {
  const writes: string[] = [];
  let calls = 0;
  const child = {
    stdin: {
      write(line: string): boolean {
        calls++;
        if (
          behavior?.throwOnWrite &&
          (behavior.throwOnWriteTimes === undefined || calls <= behavior.throwOnWriteTimes)
        ) {
          throw behavior.throwOnWrite;
        }
        writes.push(line);
        return true;
      },
    },
  } as unknown as ChildProcess;
  return { child, writes };
}

/** EPIPE 形态的 stdin 同步写失败（stdin-writer.ts writeStdinLine rethrow 的错误形状）。 */
function epipeError(): Error {
  return Object.assign(new Error("write after end"), { code: "EPIPE" });
}

/** 可控的监听表：模拟 stdout pump 的 get_stateListeners（注册返回注销函数）。 */
function makeListenerRegistry() {
  const resolvers = new Map<string, (data: unknown) => void>();
  const removed: string[] = [];
  const add = (id: string, resolver: (data: unknown) => void) => {
    resolvers.set(id, resolver);
    return () => {
      if (resolvers.get(id) === resolver) resolvers.delete(id);
      removed.push(id);
    };
  };
  return { resolvers, removed, add };
}

describe("performGetStateHandshake（FR-4 重试握手）", () => {
  it("首次 response 带 sessionFile → 立即 resolve（加速路径，不等剩余重试）", async () => {
    vi.useFakeTimers();
    try {
      const { child, writes } = makeFakeStdin();
      const reg = makeListenerRegistry();

      const promise = performGetStateHandshake(child, reg.add);
      expect(writes).toHaveLength(1); // 仅首次请求
      const sent = JSON.parse(writes[0]!) as { id: string; type: string };
      expect(sent.type).toBe("get_state");

      reg.resolvers.get(sent.id)?.({ sessionFile: "/tmp/sessions/abc.jsonl", sessionId: "sess-9" });
      await expect(promise).resolves.toEqual({
        sessionFile: "/tmp/sessions/abc.jsonl",
        sessionId: "sess-9",
      });
      // 加速 resolve 后不再发起后续重试
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("response 只带 sessionId（无 sessionFile）→ 视同未应答：剩余重试照发，3 轮耗尽 resolve 已收集字段", async () => {
    // [S2 契约修复，方案 A] 不完整应答不清任何驱动（clearTimeout 移入 sessionFile
    // 命中分支）——本轮 timer 超时照常排 retry，剩余轮次照发（writes 推进到 3）；
    // 3 轮耗尽 resolve collected（带已收集的 sessionId），不悬挂。与头注「最多重试
    // GET_STATE_MAX_RETRIES（3）次」契约一致（真实 RPC 层 get_state 应答恒带
    // sessionFile，此形态为纯契约构造的防御面，生产未观测）。
    vi.useFakeTimers();
    try {
      const { child, writes } = makeFakeStdin();
      const reg = makeListenerRegistry();

      const promise = performGetStateHandshake(child, reg.add);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      // 第 1 轮应答缺 sessionFile（仅 sessionId）：不 resolve，驱动保留
      const firstId = (JSON.parse(writes[0]!) as { id: string }).id;
      reg.resolvers.get(firstId)?.({ sessionId: "only-id" });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      // 2s 超时 + 500ms 间隔 → 第 2 轮照发（重试轮未丢失）
      await vi.advanceTimersByTimeAsync(2_500);
      expect(writes).toHaveLength(2);

      // 第 2 轮应答仍缺 sessionFile → 第 3 轮照发
      const secondId = (JSON.parse(writes[1]!) as { id: string }).id;
      reg.resolvers.get(secondId)?.({ sessionId: "only-id" });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(writes).toHaveLength(3);

      // 第 3 轮应答缺 sessionFile → 3 轮耗尽必 settle：resolve 已收集字段（非悬挂）
      const thirdId = (JSON.parse(writes[2]!) as { id: string }).id;
      reg.resolvers.get(thirdId)?.({ sessionId: "only-id" });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(promise).resolves.toEqual({ sessionId: "only-id" });
      expect(settled).toBe(true);

      // 耗尽后不再发起新请求（attempts 封顶 3）
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("全程无 response → 3 次重试后 resolve 空对象（调用方走兜底查找）", async () => {
    vi.useFakeTimers();
    try {
      const { child, writes } = makeFakeStdin();
      const reg = makeListenerRegistry();

      const promise = performGetStateHandshake(child, reg.add);
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(promise).resolves.toEqual({});
      expect(writes).toHaveLength(3); // MAX_RETRIES 次请求
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendGetStateCommand 抛错（stdin EPIPE）：按「本轮未应答」处理——3 轮耗尽必 settle，不 reject 也不逃逸", async () => {
    // [U-A1] 抛错路径的两条后果都必须消除：① 首轮经 promise executor 逃出 → reject；
    // ② 重试轮经 setTimeout 回调进入 → 逃出即宿主 uncaughtException（比悬挂更糟）。
    // 本用例三轮全部同步抛错：断言 promise resolve（非 reject）、3 次尝试后 settle，
    // 且抛错轮不注册监听（无请求在途）。
    vi.useFakeTimers();
    try {
      const { child } = makeFakeStdin({ throwOnWrite: epipeError() });
      const reg = makeListenerRegistry();

      let settled = false;
      const promise = performGetStateHandshake(child, reg.add);
      void promise.then(() => {
        settled = true;
      });

      // 2 轮间隔 500ms（RETRY_INTERVAL_MS）——抛错路径不设 2s timer，1.5s 足够跑满 3 轮
      await vi.advanceTimersByTimeAsync(1_500);

      await expect(promise).resolves.toEqual({});
      expect(settled).toBe(true);
      expect(reg.resolvers.size).toBe(0); // 抛错轮未发出请求 → 无监听注册
    } finally {
      vi.useRealTimers();
    }
  });

  it("首轮抛错后恢复：第 2 轮照发且应答带 sessionFile → 握手成功 resolve（抛错不吞后续轮次）", async () => {
    vi.useFakeTimers();
    try {
      const { child, writes } = makeFakeStdin({ throwOnWrite: epipeError(), throwOnWriteTimes: 1 });
      const reg = makeListenerRegistry();

      const promise = performGetStateHandshake(child, reg.add);
      expect(reg.resolvers.size).toBe(0); // 首轮抛错：未发出请求

      // 500ms 后第 2 轮照发（抛错只吞掉本轮，不改写轮次节奏）
      await vi.advanceTimersByTimeAsync(500);
      expect(writes).toHaveLength(1);
      const sent = JSON.parse(writes[0]!) as { id: string; type: string };
      expect(sent.type).toBe("get_state");

      reg.resolvers.get(sent.id)?.({ sessionFile: "/tmp/sessions/recovered.jsonl", sessionId: "sess-recover" });
      await expect(promise).resolves.toEqual({
        sessionFile: "/tmp/sessions/recovered.jsonl",
        sessionId: "sess-recover",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolve 后迟到的 response 被忽略（resolved 守卫，不二次 resolve）", async () => {
    vi.useFakeTimers();
    try {
      const { child } = makeFakeStdin();
      const resolvers = new Map<string, (data: unknown) => void>();
      const addVoid = (id: string, resolver: (data: unknown) => void): void => {
        resolvers.set(id, resolver);
      };

      const promise = performGetStateHandshake(child, addVoid);
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(promise).resolves.toEqual({});

      // 迟到 response：resolved 已置位，resolver 早退（无 resolve 副作用 / 不抛）
      for (const resolver of resolvers.values()) {
        expect(() => resolver({ sessionFile: "/tmp/late.jsonl" })).not.toThrow();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
