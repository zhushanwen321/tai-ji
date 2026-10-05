// src/execution/__tests__/get-state-handshake.test.ts
//
// performGetStateHandshake 单测（FR-4）：spawn 期 get_state 握手（单次 2s 超时 +
// 加速路径；fake timers 驱动）。
// [ADR-0112] 原重试节奏用例（3 次 × 2s + 500ms 间隔）随重试删除——单次超时即
// settle 已收集字段，调用方走兜底反查（LC-4）。
// [modeless 波2] 原第一个 describe（requestGetStateOnce——agent_end 惰性回补单次
// 请求）已随 one-shot 回补机械删除（git 可追溯）。

import { describe, expect, it, vi } from "vitest";

import { performGetStateHandshake } from "../get-state-handshake.ts";
import type { ChildProcess } from "node:child_process";

/**
 * 最小 FakeChild：只需 stdin.write 行为（成功 / 可注入同步 throw）。
 *
 * @param behavior.throwOnWrite 前 N 次调用抛错（缺省 = 每次都抛）；
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

describe("performGetStateHandshake（FR-4 单次握手）", () => {
  it("response 带 sessionFile → 立即 resolve（加速路径）", async () => {
    vi.useFakeTimers();
    try {
      const { child, writes } = makeFakeStdin();
      const reg = makeListenerRegistry();

      const promise = performGetStateHandshake(child, reg.add);
      expect(writes).toHaveLength(1); // 恰一次请求
      const sent = JSON.parse(writes[0]!) as { id: string; type: string };
      expect(sent.type).toBe("get_state");

      reg.resolvers.get(sent.id)?.({ sessionFile: "/tmp/sessions/abc.jsonl", sessionId: "sess-9" });
      await expect(promise).resolves.toEqual({
        sessionFile: "/tmp/sessions/abc.jsonl",
        sessionId: "sess-9",
      });
      // 加速 resolve 后不再发起新请求
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("response 只带 sessionId（无 sessionFile）→ 视同未应答：单次超时 settle 已收集字段（非悬挂）", async () => {
    // [S2 契约修复，方案 A] 不完整应答不提前停表——等单次 2s 超时 settle collected
    // （带已收集的 sessionId），调用方走兜底反查。（真实 RPC 层 get_state 应答恒带
    // sessionFile，此形态为纯契约构造的防御面，生产未观测。）
    vi.useFakeTimers();
    try {
      const { child, writes } = makeFakeStdin();
      const reg = makeListenerRegistry();

      const promise = performGetStateHandshake(child, reg.add);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      const firstId = (JSON.parse(writes[0]!) as { id: string }).id;
      reg.resolvers.get(firstId)?.({ sessionId: "only-id" });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      // 2s 超时 → settle 已收集字段；不再发起新请求（[ADR-0112] 无重试）
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(promise).resolves.toEqual({ sessionId: "only-id" });
      expect(settled).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("全程无 response → 单次超时后 resolve 空对象（调用方走兜底查找）", async () => {
    vi.useFakeTimers();
    try {
      const { child, writes } = makeFakeStdin();
      const reg = makeListenerRegistry();

      const promise = performGetStateHandshake(child, reg.add);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(promise).resolves.toEqual({});
      expect(writes).toHaveLength(1); // 恰一次请求
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendGetStateCommand 抛错（stdin EPIPE）：按「未应答」处理——立即 settle，不 reject 也不逃逸", async () => {
    // [U-A1] 抛错路径的两条后果都必须消除：① 经 promise executor 逃出 → reject；
    // ② 无界等待 → 悬挂。断言 promise resolve（非 reject）、不注册监听（无请求在途）。
    const { child } = makeFakeStdin({ throwOnWrite: epipeError() });
    const reg = makeListenerRegistry();

    await expect(performGetStateHandshake(child, reg.add)).resolves.toEqual({});
    expect(reg.resolvers.size).toBe(0); // 抛错未发出请求 → 无监听注册
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
      await vi.advanceTimersByTimeAsync(2_000);
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
