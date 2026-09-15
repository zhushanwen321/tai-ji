/**
 * buildWorkerScript — 运行时执行回归测试。
 *
 * 现有的 worker-script-builder.test.ts 全是字符串 toContain 断言，无法捕获生成的
 * worker 源码在「真实 Worker 线程里执行」时的运行时错误。曾因此漏掉 _safePost 作用域
 * bug（定义在 async IIFE 内、却在 IIFE 外的 .then()/.catch() 里使用）：脚本每次正常
 * return 都触发 ReferenceError → Worker exit code 1 → 所有 workflow 100% 失败。
 *
 * 本测试起真实的 node:worker_threads.Worker 执行 buildWorkerScript 产物，覆盖：
 * - 脚本正常 return → {type:"return"} 消息（非 exit code 1 崩溃）
 * - 脚本 throw → {type:"error"} 消息 + workerLogs（诊断不丢）
 * - agent() 调用链路：postMessage(agent-call) ↔ postMessage(agent-result)
 * - abort 消息：pending agent() reject → WorkflowAbortedError
 * - workflow() 嵌套调用链路
 * - module.exports.execute() 自动调用入口
 * - _safePost 的 DataCloneError 防御分支
 *
 * 这是回归防线：任何让 .then/.catch 访问不到 module-scope helper 的重构都会被这里抓住。
 */
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";

// ── 判别联合：Worker → Main 消息类型（S3：用判别联合替代可选字段 + 非空断言）──

/** agent-call 消息：worker 请求主线程执行一个 agent。 */
interface AgentCallMsg {
  type: "agent-call";
  callId: number;
  opts: { prompt: string; description?: string; schema?: unknown; [k: string]: unknown };
  phase?: string;
}
/** workflow-call 消息：worker 请求主线程执行嵌套 workflow。 */
interface WorkflowCallMsg {
  type: "workflow-call";
  callId: number;
  name: string;
  args: Record<string, unknown>;
}
/** return 消息：脚本正常结束，带回结果。 */
interface ReturnMsg {
  type: "return";
  runId?: string;
  result: unknown;
  workerLogs?: unknown[];
}
/** error 消息：脚本抛错（含 _safePost 的 DataCloneError 防御路径）。 */
interface ErrorMsg {
  type: "error";
  runId?: string;
  error: string;
  workerLogs?: unknown[];
}
/** log 消息：脚本 log() 全局发出的独立诊断消息（协议见 worker-script-builder 头注释）。 */
interface LogMsg {
  type: "log";
  phase?: string;
  message?: string;
}

// ── 类型守卫：从 unknown 收窄到判别联合 ──
// 共享 hasType 辅助：避免每个守卫重复 `(m as {type?:string})` 断言（taste/no-unsafe-catch）。

function hasType<T extends string>(m: unknown, type: T): boolean {
  return typeof m === "object" && m !== null
    && (m as { type: unknown }).type === type;
}

function isAgentCall(m: unknown): m is AgentCallMsg {
  return hasType(m, "agent-call");
}
function isWorkflowCall(m: unknown): m is WorkflowCallMsg {
  return hasType(m, "workflow-call");
}
function isReturn(m: unknown): m is ReturnMsg {
  return hasType(m, "return");
}
function isError(m: unknown): m is ErrorMsg {
  return hasType(m, "error");
}
function isLog(m: unknown): m is LogMsg {
  return hasType(m, "log");
}

// ── 测试辅助：起一个真实 Worker 跑 buildWorkerScript 产物 ──────────────

interface RunResult {
  /** 收到的 return 消息的 result 字段（脚本正常结束时）。 */
  returnValue?: unknown;
  /** return 消息带回的 workerLogs（[B-3] 起只含 console.* 捕获条目，log() 不再走此通路）。 */
  returnWorkerLogs?: unknown[];
  /** 收到的 error 消息的 error 字段（脚本 throw 时）。 */
  errorMessage?: string;
  /** error 消息带回的 workerLogs（验证诊断不丢）。 */
  errorWorkerLogs?: unknown[];
  /** 收到的 {type:"log"} 独立消息列表（[B-3] 起 log() 的唯一通路）。 */
  logMessages: LogMsg[];
  /** Worker exit code（0=正常，1=崩溃）。 */
  exitCode?: number;
  /** Worker 'error' 事件的错误消息（uncaught exception，正常应为 undefined）。 */
  workerError?: string;
  /** 收到的 agent-call 消息列表。 */
  agentCalls: AgentCallMsg[];
  /** 收到的 workflow-call 消息列表。 */
  workflowCalls: WorkflowCallMsg[];
}

/** workerLogs 条目守卫收窄 + message 包含判定（元素类型 unknown，断言前先收窄）。 */
function someLogMessageContains(logs: unknown[] | undefined, text: string): boolean {
  return (logs ?? []).some((l) => {
    if (typeof l !== "object" || l === null) return false;
    const message = (l as { message?: unknown }).message;
    return typeof message === "string" && message.includes(text);
  });
}

interface RunOptions {
  /** $ARGS。 */
  args?: Record<string, unknown>;
  /** 按 agent-call 顺序回发的 parsedOutput（默认每个回发 {ok:true}）。 */
  agentResults?: unknown[];
  /** 按 agent-call 顺序回发的完整 agent-result 对象（覆盖 agentResults 的 content/parsedOutput 默认形）。
   *  用于 returnMeta 测试：回发包含 sessionFile/worktreePath/error 的完整 result，
   *  worker handler 会原样取这些字段 resolve。未提供该项的索引退回 {content:"fallback", parsedOutput: agentResults[idx]}。 */
  agentResultObjects?: Record<string, unknown>[];
  /** 主线程对收到的 workflow-call 的处理：回发 workflow-result。 */
  handleWorkflowCall?: (msg: WorkflowCallMsg) => unknown;
  /** 是否在收到首个 agent-call 后立即发 abort（测 abort 路径）。 */
  abortAfterFirstAgentCall?: { reason: string };
  /** 超时（S9：CI 环境放宽，规避真实 Worker 启动慢导致的假阳）。 */
  timeoutMs?: number;
  /** workerData.callCache 预填（测缓存命中路径）。 */
  callCache?: Map<number, unknown>;
  /** Run 级 model override（透传到 workerData.model → $MODEL global）。 */
  model?: string;
  /** Run 级 thinkingLevel override（透传到 workerData.thinkingLevel → $THINKING_LEVEL global）。 */
  thinkingLevel?: string;
}

/**
 * 起 Worker 执行 userScript，主线程模拟 workflow runtime 回发 agent-result。
 *
 * @param userScript 用户 workflow 脚本源码
 */
function runWorker(userScript: string, opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? (process.env.CI ? 5000 : 2000);
  return new Promise((resolve, reject) => {
    const workerCode = buildWorkerScript(userScript);
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        scriptPath: "test.js",
        args: opts.args ?? {},
        workspace: process.cwd(),
        budget: { maxTokens: 0, usedTokens: 0, usedCost: 0 },
        callCache: opts.callCache instanceof Map
          ? Object.fromEntries(opts.callCache)
          : opts.callCache ?? {},
        // Option B run-level override：透传到 $MODEL/$THINKING_LEVEL worker global
        model: opts.model,
        thinkingLevel: opts.thinkingLevel,
      },
    });
    // S8：创建后立即登记，afterEach 兜底清理（防止 promise 泄漏导致 Worker 未终止）
    createdWorkers.push(worker);

    const result: RunResult = { agentCalls: [], workflowCalls: [], logMessages: [] };
    let agentCallIdx = 0;
    let resolved = false;
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      reject(new Error(`Worker timed out after ${timeoutMs}ms — likely hung`));
    }, timeoutMs);

    const finish = (r: RunResult): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(r);
    };

    worker.on("message", (raw: unknown) => {
      if (isAgentCall(raw)) {
        result.agentCalls.push(raw);
        if (opts.abortAfterFirstAgentCall) {
          worker.postMessage({ type: "abort", reason: opts.abortAfterFirstAgentCall.reason });
          return;
        }
        const parsed = opts.agentResults?.[agentCallIdx] ?? { ok: true };
        // returnMeta 测试路径：若调用方提供完整 result 对象（含 sessionFile/worktreePath/error），
        // 原样回发；否则用既有 {content, parsedOutput} 默认形。
        const fullResult = opts.agentResultObjects?.[agentCallIdx];
        agentCallIdx++;
        worker.postMessage({
          type: "agent-result",
          callId: raw.callId,
          result: fullResult ?? { content: "fallback", parsedOutput: parsed },
          cached: false,
        });
      } else if (isWorkflowCall(raw)) {
        result.workflowCalls.push(raw);
        const wfResult = opts.handleWorkflowCall ? opts.handleWorkflowCall(raw) : { ok: true };
        worker.postMessage({ type: "workflow-result", callId: raw.callId, result: wfResult });
      } else if (isLog(raw)) {
        // [OR-6/T7④] 独立 log 消息收集（主线程真实 runtime 当前无消费 case，测试
        // harness 收集以断言「协议消息仍发出」通路不被回退）。
        result.logMessages.push(raw);
      } else if (isReturn(raw)) {
        result.returnValue = raw.result;
        result.returnWorkerLogs = raw.workerLogs;
        finish(result);
      } else if (isError(raw)) {
        result.errorMessage = raw.error;
        result.errorWorkerLogs = raw.workerLogs;
        finish(result);
      }
    });
    worker.on("error", (err: Error) => {
      result.workerError = err.message;
      // error 事件后 Worker 会 exit code 1，给 exit handler 一个 tick 记录 exitCode
    });
    worker.on("exit", (code: number) => {
      result.exitCode = code;
      // 若未通过 return/error 消息结束（即 Worker 崩溃），以 exit 结果收尾
      if (result.returnValue === undefined && result.errorMessage === undefined) {
        finish(result);
      }
    });
  });
}

// 记录所有创建的 Worker，afterEach 兜底清理（防止泄漏）——S8
const createdWorkers: Worker[] = [];

afterEach(() => {
  for (const w of createdWorkers.splice(0)) {
    w.terminate().catch(() => {});
  }
});

// ── 回归测试：_safePost 作用域 bug（核心防线） ──────────────────────

describe("buildWorkerScript runtime — _safePost scope regression (exit code 1 bug)", () => {
  it("脚本正常 return 时发出 return 消息，Worker 不崩溃（exit code 0）", async () => {
    const script = `return { status: "ok", value: 42 };`;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBeUndefined();
    expect(res.returnValue).toEqual({ status: "ok", value: 42 });
    expect(res.exitCode).not.toBe(1);
  });

  it("脚本 throw 时发出 error 消息并带回 workerLogs，Worker 不裸崩", async () => {
    const script = `
      console.log("before throw");
      throw new Error("script boom");
    `;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBe("script boom");
    expect(res.exitCode).not.toBe(1);
  });

  it("agent() → result → return 完整链路：parallel 风格脚本正常完成", async () => {
    const script = `
      phase("analyze");
      const results = await parallel([
        () => agent({ prompt: "task-1", description: "a1" }),
        () => agent({ prompt: "task-2", description: "a2" }),
      ]);
      const ok = results.filter((r) => r && r.ok).length;
      return { status: "ok", analyzed: results.length, ok };
    `;
    const res = await runWorker(script, { agentResults: [{ ok: true }, { ok: true }] });
    expect(res.agentCalls).toHaveLength(2);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({ status: "ok", analyzed: 2, ok: 2 });
    expect(res.exitCode).not.toBe(1);
  });

  it("脚本 return 后 Worker 不发 workerError 事件（_safePost 在 .then 可达）", async () => {
    const script = `return "done";`;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toBe("done");
  });

  it("parallel([agent(...), ...]) Promise 数组：CC 兼容写法不触发 DataCloneError", async () => {
    // parallel.js/map-reduce.js/scatter-gather.js 都用 `parallel([agent({...}), ...])`——
    // 传入已实例化的 Promise 数组（agent() 同步返回 Promise）。旧 parallel() 实现把
    // Promise 当 opts 传给 agent() → postMessage DataCloneError → allSettled 全 rejected
    // → 脚本返回 error。修复：parallel() 用 thenable 鸭辨直接返回 in-flight Promise。
    // 此测试用真实的 Promise 数组写法（而非函数数组），对应内置脚本的真实用法。
    const script = `
      const results = await parallel([
        agent({ prompt: "p1", description: "a1" }),
        agent({ prompt: "p2", description: "a2" }),
      ]);
      return { count: results.length, ok: results.every((r) => r && r.ok) };
    `;
    const res = await runWorker(script, { agentResults: [{ ok: true }, { ok: true }] });
    expect(res.agentCalls).toHaveLength(2);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBeUndefined();
    expect(res.returnValue).toEqual({ count: 2, ok: true });
    expect(res.exitCode).not.toBe(1);
  });

  it("[F1] execute() 返回不可克隆值 → 回发可克隆 error 消息（不再静默 exit(0)），DataCloneError 详情在 workerLogs", async () => {
    // 修复前：return 值含 function → _safePost 吞掉 DataCloneError 返回 false → 无任何
    // 消息发出 → worker 静默 exit(0) → 主线程 handleWorkerExit(0) no-op → run 永久
    // running、runAndWait 悬挂（runWorker 会 2s 超时 reject，即本测试修复前会红）。
    // 修复后：.then 检测 _safePost 失败，回发可克隆 error 消息接管。
    const script = `return { ok: true, fn: () => 1 };`;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toBeUndefined(); // return 消息未发出（被 DataCloneError 拦下）
    expect(res.errorMessage).toMatch(/structured-clone failed/);
    // DataCloneError 详情由 _safePost 记入 workerLogs 随 error 消息带回（诊断不丢）
    expect((res.errorWorkerLogs ?? []).length).toBeGreaterThan(0);
    expect(res.exitCode).not.toBe(1);
  });

  it("[F1] 不可克隆 Symbol 成员同样回发 error 消息（循环引用同理，同一 _safePost 失败路径）", async () => {
    const script = `return { sym: Symbol("no-clone") };`;
    const res = await runWorker(script);
    expect(res.errorMessage).toMatch(/structured-clone failed/);
    expect(res.exitCode).not.toBe(1);
  });
});

// ── S4-S7：覆盖此前缺失的运行时路径 ──────────────────────────────────

describe("buildWorkerScript runtime — 之前缺失的路径覆盖", () => {
  it("S4 abort 消息：pending agent() 被 reject → WorkflowAbortedError", async () => {
    // 脚本 await 一个 agent()，主线程回发 abort → agent reject → 脚本抛错进 .catch
    const script = `
      await agent({ prompt: "will-be-aborted" });
    `;
    const res = await runWorker(script, { abortAfterFirstAgentCall: { reason: "user cancel" } });
    // abort 让 pending reject → 脚本 throw WorkflowAbortedError → .catch 发 type:error
    expect(res.agentCalls).toHaveLength(1);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toMatch(/Workflow aborted/);
    expect(res.exitCode).not.toBe(1);
  });

  it("S5 workflow() 嵌套调用：workflow-call ↔ workflow-result 链路正常", async () => {
    const script = `
      const r = await workflow("sub-wf", { x: 1 });
      return { nested: r };
    `;
    const res = await runWorker(script, {
      handleWorkflowCall: (msg) => ({ echo: msg.args, name: msg.name }),
    });
    expect(res.workflowCalls).toHaveLength(1);
    expect(res.workflowCalls[0]!.name).toBe("sub-wf");
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({ nested: { echo: { x: 1 }, name: "sub-wf" } });
    expect(res.exitCode).not.toBe(1);
  });

  it("S6 module.exports.execute() 自动调用入口：ctx 注入完整、return 正常", async () => {
    const script = `
      const meta = { name: "exec-mode" };
      module.exports = {
        meta,
        execute: async (ctx) => {
          const r = await ctx.agent({ prompt: "via-execute" });
          return { viaExecute: true, agentResult: r, hasGlobals: typeof ctx.parallel === "function" };
        },
      };
    `;
    const res = await runWorker(script, { agentResults: [{ ok: true, source: "exec" }] });
    expect(res.agentCalls).toHaveLength(1);
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({
      viaExecute: true,
      agentResult: { ok: true, source: "exec" },
      hasGlobals: true,
    });
    expect(res.exitCode).not.toBe(1);
  });

  it("S7 _safePost 的 .catch 路径带回 workerLogs：脚本 throw 时诊断不丢", async () => {
    // _safePost 的价值两半：(1) return 路径成功发消息（S1-S3 覆盖）；
    // (2) error 路径（.catch）发 type:error + workerLogs，让主线程拿到诊断。
    // 本例验证 .catch 里的 _safePost 正常工作——脚本 throw → console.* 被劫持进
    // _workerLogs → .catch 用 _safePost 发回 {type:"error", workerLogs}。
    // 修复前 .catch 里的 _safePost 是 ReferenceError，workerLogs 发不回（errorLogs 全空）。
    const script = `
      console.log("step-1");
      console.warn("step-2-warning");
      throw new Error("diagnostic-test-error");
    `;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.errorMessage).toBe("diagnostic-test-error");
    expect(res.errorWorkerLogs).toBeDefined();
    expect(res.errorWorkerLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "log", message: "step-1" }),
        expect.objectContaining({ level: "warn", message: "step-2-warning" }),
      ]),
    );
    expect(res.exitCode).not.toBe(1);
  });
});

// ── [B-3] log() 单通路可观测性 ─────────────────────────────────────
// 旧双通路（log() 同时 post 独立消息 + 记入 _workerLogs 随 return/error 带回）让
// 同一日志在主线程 errorLogs 占两格、TUI 双份。修复后 log() 只发独立 {type:"log"}
// 消息，主线程 handleWorkerLog 即时消费（error-recovery.ts）；崩溃场景丢 log 条目
// 可接受（log 是 T7 补充可观测）。

describe("buildWorkerScript runtime — [B-3] log() 单通路", () => {
  it("log() 发出独立 {type:\"log\"} 消息且携带 phase（主线程即时消费的唯一通路）", async () => {
    const script = `
      phase("build");
      log("hello from script");
      return { ok: true };
    `;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    expect(res.logMessages).toEqual([{ type: "log", phase: "build", message: "hello from script" }]);
    expect(res.exitCode).not.toBe(1);
  });

  it("log() 内容不再随 return 消息的 workerLogs 带回（双份入账已退役）", async () => {
    const script = `
      phase("build");
      log("hello from script");
      return { ok: true };
    `;
    const res = await runWorker(script);
    expect(res.workerError).toBeUndefined();
    // workerLogs 中不得出现 log() 的条目（否则主线程 log case + workerLogs 双份入账）
    expect(someLogMessageContains(res.returnWorkerLogs, "hello from script")).toBe(false);
  });

  it("log() 内容不再随 error 消息的 workerLogs 带回（console.* 捕获通路不受影响）", async () => {
    const script = `
      log("before-crash");
      console.error("crash-context");
      throw new Error("boom");
    `;
    const res = await runWorker(script);
    expect(res.errorMessage).toBe("boom");
    // log() 的条目不在 error workerLogs（单通路）
    expect(someLogMessageContains(res.errorWorkerLogs, "before-crash")).toBe(false);
    // console.* 捕获通路保持（workerLogs 仍带回 console.error 条目）
    expect(res.errorWorkerLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", message: "crash-context" }),
      ]),
    );
  });
});

// ── W2: agent() returnMeta 模式运行时验证 ───────────────────────────
// 现有 worker-script-builder.test.ts 的 16 条 returnMeta 断言全是字符串 toContain，
// 无法验证「真实 Worker 线程执行时 agent({returnMeta:true}) resolve 出对象、
// 不设 returnMeta resolve 单值」。此处补运行时验证（对称 handler 9b 分支）。

describe("buildWorkerScript runtime — W2 agent() returnMeta mode", () => {
  it("agent({prompt, returnMeta:true}) resolve 出 {value, sessionFile, worktreePath, error}（非单值）", async () => {
    // returnMeta:true → worker handler 走 9b 分支，resolve 包含 4 字段的对象。
    // 主线程回发的 result 带 sessionFile/worktreePath/error，验证它们被原样透传。
    const script = `
      const r = await agent({ prompt: "with-meta", returnMeta: true });
      return r;
    `;
    const res = await runWorker(script, {
      agentResultObjects: [
        {
          content: "raw-text",
          parsedOutput: { ok: true },
          sessionFile: "/tmp/sess-1.jsonl",
          worktreePath: "/tmp/wt-abc",
          error: undefined,
        },
      ],
    });
    expect(res.agentCalls).toHaveLength(1);
    // agent-call 消息应透传 returnMeta（验证 m1 修复：prompt 分支本就透传）
    expect(res.agentCalls[0]!.opts.returnMeta).toBe(true);
    expect(res.workerError).toBeUndefined();
    // value = parsedOutput ?? content = {ok:true}（结构化输出优先）
    expect(res.returnValue).toEqual({
      value: { ok: true },
      sessionFile: "/tmp/sess-1.jsonl",
      worktreePath: "/tmp/wt-abc",
      error: undefined,
    });
    expect(res.exitCode).not.toBe(1);
  });

  it("不设 returnMeta 时 agent() resolve 单值（向后兼容）", async () => {
    // 无 returnMeta → handler 走 else 分支，resolve 裸 _value（向后兼容）。
    const script = `
      const r = await agent({ prompt: "no-meta" });
      return r;
    `;
    const res = await runWorker(script, {
      agentResultObjects: [
        {
          content: "raw-text",
          parsedOutput: { ok: true },
          sessionFile: "/tmp/sess-2.jsonl",
          worktreePath: "/tmp/wt-def",
        },
      ],
    });
    expect(res.agentCalls).toHaveLength(1);
    expect(res.agentCalls[0]!.opts.returnMeta).toBeUndefined();
    expect(res.workerError).toBeUndefined();
    // 单值：parsedOutput 优先（{ok:true}），sessionFile/worktreePath 被丢弃
    expect(res.returnValue).toEqual({ ok: true });
    expect(res.exitCode).not.toBe(1);
  });

  it("agent({task, returnMeta:true}) task/agent 快捷分支也透传 returnMeta（m1 修复）", async () => {
    // m1 修复：task/agent 快捷分支现在透传 returnMeta（之前丢弃）。
    // 用 task 而非 prompt 触发快捷分支，验证 returnMeta 生效。
    const script = `
      const r = await agent({ task: "via-task-branch", returnMeta: true });
      return r;
    `;
    const res = await runWorker(script, {
      agentResultObjects: [
        {
          content: "task-raw",
          parsedOutput: "task-value",
          sessionFile: "/tmp/sess-3.jsonl",
          worktreePath: "/tmp/wt-ghi",
          error: "soft-fail-msg",
        },
      ],
    });
    expect(res.agentCalls).toHaveLength(1);
    // 快捷分支透传 returnMeta（m1 修复点）
    expect(res.agentCalls[0]!.opts.returnMeta).toBe(true);
    expect(res.agentCalls[0]!.opts.prompt).toBe("via-task-branch");
    expect(res.workerError).toBeUndefined();
    // returnMeta 生效 → resolve 对象（非单值）
    expect(res.returnValue).toEqual({
      value: "task-value",
      sessionFile: "/tmp/sess-3.jsonl",
      worktreePath: "/tmp/wt-ghi",
      error: "soft-fail-msg",
    });
    expect(res.exitCode).not.toBe(1);
  });
});

// ── P3/P4 runtime: run-level model/thinkingLevel override 真实注入（L0→L1 升级）──
// worker-script-builder.test.ts 的 P3/P4 block 全是源码字符串断言（L0：验证「生成的
// 源码含 $MODEL 注入行」）。本组起真实 Worker 线程，传 workerData.model/thinkingLevel，
// 断言 agent() 三分支产出的 agent-call 消息 opts.model/opts.thinkingLevel 真实继承
// $MODEL/$THINKING_LEVEL global（L1：验证「运行时 agent-call 携带正确 override」）。
// 对应 docs/testing/ 断言价值层级 L1（真实 Worker 产物，非源码字符串）。

describe("buildWorkerScript runtime — P3/P4 run-level model/thinkingLevel override 真实注入", () => {
  it("workerData.model 经 $MODEL global 注入到 object 分支 agent() opts.model", async () => {
    const script = `await agent({ prompt: "hi" }); return { done: true };`;
    const res = await runWorker(script, { model: "anthropic/claude-sonnet-4-5" });
    expect(res.agentCalls).toHaveLength(1);
    expect(res.agentCalls[0]!.opts.model).toBe("anthropic/claude-sonnet-4-5");
    expect(res.workerError).toBeUndefined();
    expect(res.exitCode).not.toBe(1);
  });

  it("workerData.thinkingLevel 经 $THINKING_LEVEL global 注入到 opts.thinkingLevel", async () => {
    const script = `await agent({ prompt: "hi" }); return { done: true };`;
    const res = await runWorker(script, { thinkingLevel: "high" });
    expect(res.agentCalls).toHaveLength(1);
    expect(res.agentCalls[0]!.opts.thinkingLevel).toBe("high");
    expect(res.workerError).toBeUndefined();
  });

  it("per-call model 优先于 $MODEL global（显式传 model 时不被 override 覆盖）", async () => {
    const script = `await agent({ prompt: "hi", model: "openai/gpt-4o" }); return {};`;
    const res = await runWorker(script, { model: "anthropic/claude-sonnet-4-5" });
    expect(res.agentCalls).toHaveLength(1);
    expect(res.agentCalls[0]!.opts.model).toBe("openai/gpt-4o");
  });

  it("agent() 三分支一致继承 $MODEL（string / task / object.prompt）", async () => {
    const script = `
      await agent("str-branch");
      await agent({ task: "t" });
      await agent({ prompt: "obj" });
      return {};
    `;
    const res = await runWorker(script, {
      model: "X/Y",
      agentResults: [{}, {}, {}],
    });
    expect(res.agentCalls).toHaveLength(3);
    expect(res.agentCalls.map((c) => c.opts.model)).toEqual(["X/Y", "X/Y", "X/Y"]);
  });

  it("model+thinkingLevel 同时注入（Option B 对称验证）", async () => {
    const script = `await agent({ prompt: "hi" }); return {};`;
    const res = await runWorker(script, { model: "p/m", thinkingLevel: "max" });
    expect(res.agentCalls[0]!.opts.model).toBe("p/m");
    expect(res.agentCalls[0]!.opts.thinkingLevel).toBe("max");
  });

  it("不传 model 时 opts.model 为 undefined（零配置默认继承主 agent，不误注入）", async () => {
    const script = `await agent({ prompt: "hi" }); return {};`;
    const res = await runWorker(script);
    expect(res.agentCalls).toHaveLength(1);
    expect(res.agentCalls[0]!.opts.model).toBeUndefined();
  });
});

describe("buildWorkerScript runtime — string 分支 maxTurns ?? 语义保真（F-2）", () => {
  // 旧实现 `(cond && secondArg.maxTurns) || undefined` 把显式 0 抹成 undefined →
  // 落 runSpawn 的 env 兑底（SPAWN_WATCHDOG env 设置时误挂 watchdog），与对象分支
  // （直接透传保真）语义分裂。锁定运行时行为：string 分支传 0 → postMessage
  // opts.maxTurns === 0。
  it("agent(str, { maxTurns: 0 }) → postMessage opts.maxTurns === 0（不被抹成 undefined）", async () => {
    const script = `await agent("p", { maxTurns: 0 }); return {};`;
    const res = await runWorker(script);
    expect(res.agentCalls).toHaveLength(1);
    expect(res.agentCalls[0]!.opts.maxTurns).toBe(0);
    expect(res.workerError).toBeUndefined();
  });

  it("agent(str, { maxTurns: 8 }) → 8；不传 → undefined（其余语义不变）", async () => {
    const resA = await runWorker(`await agent("p", { maxTurns: 8 }); return {};`);
    expect(resA.agentCalls[0]!.opts.maxTurns).toBe(8);
    const resB = await runWorker(`await agent("p"); return {};`);
    expect(resB.agentCalls[0]!.opts.maxTurns).toBeUndefined();
  });
});

