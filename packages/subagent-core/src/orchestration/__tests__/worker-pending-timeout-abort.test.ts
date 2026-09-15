/**
 * [OR-3] worker 侧 pending per-call timeoutMs + abort 广播 测试（真实 Worker 线程，P-T3）。
 *
 * 覆盖（crash-forensics-and-watchdog.md 附录 E（原 unbounded-wait-audit §4.1 OR-3 / §7.2 T3③ / §7.3 P-T3））：
 * - agent() 传 timeoutMs：主线程不回话 → pending 以错误 resolve（不 reject、不放大成
 *   脚本 error）+ 超时 warn 记入 _workerLogs——消息层自己的超时，旧实现零超时永挂
 * - returnMeta 模式超时 resolve {value:"", error}
 * - 主线程不传 timeoutMs（缺省不限）：pending 不挂 timer（行为不变）
 * - abort 广播：await 中的 agent() 以 WorkflowAbortedError reject（脚本 catch 可感知
 *   取消）→ 脚本自然收尾 → worker 自然退出（exit 0）
 * - P-T3：abort 广播与 worker 自然退出交错不产 unhandledRejection——广播后立即
 *   terminate 的竞态、fire-and-forget 后 return 的自然退出，均不产生主线程
 *   unhandledRejection 与 worker 'error' 事件
 */
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";

// ── 判别联合（对齐 worker-script-builder-runtime.test.ts 的守卫形态） ──

interface ReturnMsg {
  type: "return";
  result: unknown;
  workerLogs?: Array<{ level: string; message: string }>;
}
interface ErrorMsg {
  type: "error";
  error: string;
  workerLogs?: Array<{ level: string; message: string }>;
}

function isReturn(m: unknown): m is ReturnMsg {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "return";
}
function isError(m: unknown): m is ErrorMsg {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "error";
}
function isAgentCall(m: unknown): m is { type: "agent-call"; callId: number } {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "agent-call";
}

// ── harness：主线程「不回话」的可控 Worker 运行器 ──────────────

interface RunResult {
  returnValue?: unknown;
  errorMessage?: string;
  /** return/error 消息带回的 workerLogs（超时 warn 通路）。 */
  workerLogs: Array<{ level: string; message: string }>;
  exitCode?: number;
  workerError?: string;
  /** 收到的 agent-call 消息数（确认脚本确实发起了调用）。 */
  agentCallCount: number;
}

interface RunOptions {
  /** 收到 agent-call 后的主线程动作（默认：不回话——pending 留在 worker 侧）。 */
  onAgentCall?: (msg: { callId: number; opts: Record<string, unknown> }, worker: Worker) => void;
  /** 显式 finish（供 abort 竞态场景手工收尾）。 */
  timeoutMs?: number;
}

const createdWorkers: Worker[] = [];

afterEach(() => {
  for (const w of createdWorkers.splice(0)) {
    w.terminate().catch(() => {});
  }
});

function runWorker(userScript: string, opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? (process.env.CI ? 5000 : 2000);
  return new Promise((resolve) => {
    const worker = new Worker(buildWorkerScript(userScript), {
      eval: true,
      workerData: {
        scriptPath: "test.js",
        args: {},
        workspace: process.cwd(),
        budget: { maxTokens: 0, usedTokens: 0, usedCost: 0 },
      },
    });
    createdWorkers.push(worker);

    const result: RunResult = { workerLogs: [], agentCallCount: 0 };
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    // 兜底：永不 settle 时 terminate + 以当前观察收尾
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish();
    }, timeoutMs);
    // 收到终态消息后的宽限窗：给潜在 worker 'error' 事件一个到达机会，
    // 然后收尾（parentPort 挂着 message listener 时 worker 线程不自然退出，
    // 与生产一致由 terminate 回收——故不依赖 exit 事件断言）。
    let graceTimer: ReturnType<typeof setTimeout>;

    worker.on("message", (raw: unknown) => {
      if (isAgentCall(raw)) {
        result.agentCallCount += 1;
        opts.onAgentCall?.(raw as unknown as { callId: number; opts: Record<string, unknown> }, worker);
        return;
      }
      if (isReturn(raw)) {
        result.returnValue = raw.result;
        result.workerLogs = raw.workerLogs ?? [];
        graceTimer = setTimeout(finish, 150);
        return;
      }
      if (isError(raw)) {
        result.errorMessage = raw.error;
        result.workerLogs = raw.workerLogs ?? [];
        graceTimer = setTimeout(finish, 150);
      }
    });
    worker.on("error", (err: Error) => {
      result.workerError = err.message;
    });
    worker.on("exit", (code: number) => {
      result.exitCode = code;
      finish();
    });
  });
}

/** 收集本测试进程的 unhandledRejection（P-T3 断言）。 */
function trackUnhandledRejections(): { reasons: unknown[]; dispose: () => void } {
  const reasons: unknown[] = [];
  const handler = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on("unhandledRejection", handler);
  return { reasons, dispose: () => process.off("unhandledRejection", handler) };
}

// ── [OR-3] per-call timeoutMs（消息层自己的超时） ─────────────

describe("[OR-3] agent() pending per-call timeoutMs", () => {
  it("主线程不回话 + timeoutMs=50 → pending 以错误 resolve（[B-5] 单值错误消息字符串）", async () => {
    const script = `
      const r = await agent("never answered", { timeoutMs: 50 });
      return { got: r };
    `;
    const res = await runWorker(script);

    // 脚本正常 return（超时未放大成脚本 error → 不触发 rebuild 矩阵）
    expect(res.errorMessage).toBeUndefined();
    expect(res.workerError).toBeUndefined();
    expect(res.agentCallCount).toBe(1);
    // [B-5] 非 returnMeta 超时 resolve 单值字符串（对齐 agent-result 失败路径
    // resolve _value = parsedOutput ?? content 的形态）——字符串消费型脚本
    // （r.trim() 类）不再 TypeError
    const got = (res.returnValue as { got: string }).got;
    expect(typeof got).toBe("string");
    expect(got).toContain("timed out after 50ms");
    expect(got).toContain("no agent-result received");
    // 超时 warn 记入 _workerLogs（诊断可见）
    expect(res.workerLogs.some((l) => l.level === "warn" && l.message.includes("timed out after 50ms"))).toBe(true);
  });

  it("returnMeta 模式超时（对象分支透传 returnMeta）→ resolve {value:\"\", error}", async () => {
    const script = `
      const r = await agent({ prompt: "never answered", timeoutMs: 50, returnMeta: true });
      return r;
    `;
    const res = await runWorker(script);

    expect(res.errorMessage).toBeUndefined();
    expect(res.returnValue).toEqual({ value: "", error: expect.stringContaining("timed out after 50ms") });
  });

  it("[B-5] 字符串消费型脚本（r.trim()）在超时路径不 TypeError（resolve 单值字符串）", async () => {
    // 旧实现超时 resolve {content:"", error} 对象 → r.trim() 抛 TypeError →
    // 脚本 error → 放大成 rebuild；修复后 resolve 字符串，脚本按普通失败文本消费
    const script = `
      const r = await agent("never answered", { timeoutMs: 40 });
      return { trimmed: r.trim().length > 0 };
    `;
    const res = await runWorker(script);

    expect(res.errorMessage).toBeUndefined();
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({ trimmed: true });
  });

  it("string+secondArg 分支：timeoutMs 透传到 agent-call 消息 opts（此前该分支丢弃该字段）", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    const script = `await agent("with timeout", { timeoutMs: 1234, label: "probe" }); return "unreachable";`;
    await runWorker(script, {
      onAgentCall: (msg, worker) => {
        seenOpts = msg.opts;
        // 回发结果让脚本收尾（透传断言与挂起行为解耦）
        worker.postMessage({ type: "agent-result", callId: msg.callId, result: { content: "ok" }, cached: false });
      },
    });

    expect(seenOpts?.timeoutMs).toBe(1234);
    expect(seenOpts?.prompt).toBe("with timeout");
  });
});

// ── [OR-3] abort 广播（worker 侧接收） ───────────────────────

describe("[OR-3] abort 广播接收（P-T3：交错不产 unhandledRejection）", () => {
  it("await 中的 agent() 收到 abort → WorkflowAbortedError → 脚本 catch 后自然 return → exit 0", async () => {
    const script = `
      try {
        await agent("will be aborted");
        return "should not reach";
      } catch (e) {
        return { caught: e.name, reason: e.reason };
      }
    `;
    const res = await runWorker(script, {
      onAgentCall: (msg, worker) => {
        worker.postMessage({ type: "abort", reason: "run aborted by user" });
      },
    });

    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBeUndefined();
    expect(res.returnValue).toEqual({ caught: "WorkflowAbortedError", reason: "run aborted by user" });
  });

  it("广播后立即 terminate（竞态）：无 worker error、无 unhandledRejection", async () => {
    const tracked = trackUnhandledRejections();
    try {
      const script = `return await agent("race with terminate");`;
      const res = await runWorker(script, {
        onAgentCall: (msg, worker) => {
          // 广播与 terminate 同 tick 发出——模拟 abortRun 的广播→transition(terminate) 竞态
          worker.postMessage({ type: "abort", reason: "race" });
          void worker.terminate();
        },
      });
      // 无论脚本是否来得及收尾：主线程侧无 error 事件、进程无 unhandledRejection
      expect(res.workerError).toBeUndefined();
      // 给潜在异步 unhandledRejection 一个窗口
      await new Promise((r) => { setTimeout(r, 20); });
      expect(tracked.reasons).toEqual([]);
    } finally {
      tracked.dispose();
    }
  });

  it("fire-and-forget agent() 后脚本 return：无 worker error（超时/abort 通路外的孤儿 pending 不产 rejection）", async () => {
    const script = `
      agent("fire and forget");
      return "returned early";
    `;
    const res = await runWorker(script, { timeoutMs: 400 });

    expect(res.returnValue).toBe("returned early");
    expect(res.workerError).toBeUndefined();
  });

  it("fire-and-forget + timeoutMs：超时 resolve（非 reject）→ 无 worker error 事件", async () => {
    const script = `
      agent("orphan with timeout", { timeoutMs: 40 });
      return "returned before timeout";
    `;
    const res = await runWorker(script, { timeoutMs: 600 });

    // 超时以 resolve 收口（容错策略）——即使无人消费该 promise 也不产 rejection
    expect(res.returnValue).toBe("returned before timeout");
    expect(res.workerError).toBeUndefined();
  });
});
