/**
 * rfl 仪表 T1（tier-1 §7.1）：returnMeta 透传 usage/durationMs/sessionId。
 *
 * 两个对称点的运行时验证（worker-script-builder 模板字符串断言无法证明
 * 「真实 Worker 线程里 resolve 对象字段齐全」）：
 *   A1 live resolve——agent-result 消息回发完整 AgentResult，returnMeta:true
 *      时 resolve 对象 = {value, sessionFile, worktreePath, error, usage, durationMs, sessionId}
 *   A2 缓存重放——workerData.callCache 命中时重建对象同样含三字段（对称点）
 *
 * 模式与 worker-script-builder-runtime.test.ts 相同：真实 Worker 线程执行
 * buildWorkerScript 产物，主线程模拟 runtime 回发消息。
 */
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";

const USAGE = { input: 100, output: 50, cacheRead: 700, cacheWrite: 30, cost: 0.012, contextTokens: 850, turns: 3 };

const createdWorkers: Worker[] = [];

afterEach(() => {
  for (const w of createdWorkers.splice(0)) {
    w.terminate().catch(() => {});
  }
});

interface RunOutcome {
  returnValue?: unknown;
  errorMessage?: string;
  exitCode?: number;
}

/**
 * 起 Worker 跑 userScript；收到首个 agent-call 即回发 agentResult（调用方提供），
 * 等脚本 return。callCache 命中路径不会发出 agent-call（直接从缓存重建返回）。
 */
function runWorker(
  userScript: string,
  opts: { agentResult?: Record<string, unknown>; callCache?: Record<number, unknown>; timeoutMs?: number },
): Promise<RunOutcome> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  return new Promise((resolve, reject) => {
    const worker = new Worker(buildWorkerScript(userScript), {
      eval: true,
      workerData: {
        scriptPath: "test.js",
        args: {},
        workspace: process.cwd(),
        budget: { maxTokens: 0, usedTokens: 0, usedCost: 0 },
        callCache: opts.callCache ?? {},
      },
    });
    createdWorkers.push(worker);
    const out: RunOutcome = {};
    let settled = false;
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error("Worker timed out — likely hung"));
    }, timeoutMs);
    const finish = (r: RunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    worker.on("message", (raw: unknown) => {
      const msg = raw as { type?: string; callId?: number };
      if (msg.type === "agent-call" && typeof msg.callId === "number") {
        worker.postMessage({
          type: "agent-result",
          callId: msg.callId,
          result: opts.agentResult ?? { content: "fallback", parsedOutput: { ok: true } },
          cached: false,
        });
      } else if (msg.type === "return") {
        out.returnValue = (raw as { result?: unknown }).result;
        finish(out);
      } else if (msg.type === "error") {
        out.errorMessage = (raw as { error?: string }).error;
        finish(out);
      }
    });
    worker.on("exit", (code: number) => {
      out.exitCode = code;
      if (code !== 0) finish(out);
    });
    worker.on("error", (err: Error) => {
      out.errorMessage = err.message;
      finish(out);
    });
  });
}

const META_SCRIPT = "const meta = await agent({ prompt: 'passthrough probe', returnMeta: true }); return meta;";

describe("A1 returnMeta live resolve 透传（tier-1 §7.1）", () => {
  it("A1 agent-result 回发完整 AgentResult 时 resolve 对象含 usage/durationMs/sessionId（七字段全集）", async () => {
    const outcome = await runWorker(META_SCRIPT, {
      agentResult: {
        content: "raw text",
        parsedOutput: { ok: true },
        sessionFile: "/tmp/sess.jsonl",
        worktreePath: "/tmp/wt",
        error: undefined,
        usage: USAGE,
        durationMs: 83_000,
        sessionId: "sess-abc-1",
      },
    });
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.returnValue).toEqual({
      value: { ok: true },
      sessionFile: "/tmp/sess.jsonl",
      worktreePath: "/tmp/wt",
      error: undefined,
      usage: USAGE,
      durationMs: 83_000,
      sessionId: "sess-abc-1",
    });
  });

  it("A1 旧主线程（AgentResult 无三字段）时 resolve 对象三字段为 undefined（向后兼容不抛错）", async () => {
    const outcome = await runWorker(META_SCRIPT, {
      agentResult: { content: "raw", parsedOutput: { v: 1 }, sessionFile: "/tmp/s.jsonl" },
    });
    expect(outcome.returnValue).toMatchObject({
      value: { v: 1 },
      sessionFile: "/tmp/s.jsonl",
      usage: undefined,
      durationMs: undefined,
      sessionId: undefined,
    });
  });
});

describe("A2 returnMeta 缓存重放重建透传（对称点，tier-1 §7.1）", () => {
  it("A2 workerData.callCache 命中时重建对象含 usage/durationMs/sessionId（不回发 agent-call）", async () => {
    const outcome = await runWorker(META_SCRIPT, {
      callCache: {
        0: {
          content: "cached raw",
          parsedOutput: { cached: true },
          sessionFile: "/tmp/cached.jsonl",
          worktreePath: "/tmp/cwt",
          usage: USAGE,
          durationMs: 42_000,
          sessionId: "sess-cache-9",
        },
      },
    });
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.returnValue).toEqual({
      value: { cached: true },
      sessionFile: "/tmp/cached.jsonl",
      worktreePath: "/tmp/cwt",
      error: undefined,
      usage: USAGE,
      durationMs: 42_000,
      sessionId: "sess-cache-9",
    });
  });
});
