/**
 * Workflow Extension — Worker Script Builder
 *
 * 生成运行 workflow 脚本的 Worker 线程源码字符串：注入全局函数
 * agent/parallel/pipeline/phase/log，并在 worker 内部处理
 * parentPort 消息循环（agent-call / agent-result / abort / budget-update）。
 *
 * 层归属：Infra（源码字符串生成，纯文本拼接，无 Pi 依赖）。
 *
 * 设计：
 * - WorkerLogEntry 类型来源 engine/models/types.js（不在本文件重复声明）。
 * - **AC-4 不变式**：buildWorkerScript 生成的脚本格式逐字保留——
 * 用户资产（workflow 脚本依赖 agent/parallel/pipeline/$ARGS/$BUDGET 等契约）。
 *
 * 兼容 Claude Code Workflow 脚本格式：
 * - agent(promptString) / agent(promptString, { label?, schema?, model?, scene? }) /
 * agent({ prompt, schema?, model?, scene?, description? })
 * - parallel([agent(...), ...]) 或 parallel([{ task, agent }, ...])
 * - pipeline([stageFn, ...])
 * - phase(name), log(msg)
 * - $ARGS, $WORKSPACE, $BUDGET
 * - module.exports = { meta, execute } 自动调用
 *
 * 生成的源码通过 `new Worker(code, { eval: true, workerData })` 在隔离的 Worker 线程运行。
 *
 * 通信协议（AC-4 契约，逐字保留）：
 * Worker → Main (postMessage):
 * { type: "agent-call", callId: number, opts: AgentCallOpts }
 * { type: "workflow-call", callId: number, name: string, args: Record<string, unknown> }
 * { type: "return", runId: string, result: unknown }
 * { type: "error", runId: string, error: string }
 * { type: "log", phase: string, message: string }
 *   —— log() 的唯一通路：主线程 handleWorkerMessage 的 log case 即时消费（push 进
 *   run.state.errorLogs + debug 留痕，error-recovery.ts）。[B-3] 旧实现同时把内容
 *   记入 _workerLogs 随 return/error 消息再带回一份——同一日志在 errorLogs 占两格、
 *   TUI 双份，已退役。崩溃场景（return/error 消息未发出）丢 log 条目可接受：
 *   log 是 T7 补充可观测，非持久化权威。
 *
 * Main → Worker (parentPort.on("message")):
 * { type: "agent-result", callId: number, result: AgentResult, cached: boolean }
 * { type: "workflow-result", callId: number, result: unknown }
 * { type: "budget-update", budget: unknown }
 * { type: "abort", reason: string }
 *   —— [OR-3] 主线程在 abortRun/terminateRunningRuns 终止 run 时、worker.terminate
 *   之前广播本消息；worker 侧 _pendingCalls 全部 reject（WorkflowAbortedError）并
 *   清理，脚本 catch 后自然收尾退出（P-T3：广播与 worker 自然退出交错不产
 *   unhandledRejection）。
 *
 * [OR-3] per-call 超时：agent() 的 pending 在 opts.timeoutMs > 0 时接线消息层自己的
 * 超时——主线程对 agent-call 永不回话（畸形消息丢弃 / postMessage 双重失败 / runner
 * 不 settle）时 pending 以错误 resolve（对齐 agent-result 失败容错策略：不 reject、
 * 不放大成脚本 error → rebuild）。缺省（未传 timeoutMs）= 不限，与 runner 侧
 * per-call timeout 语义一致。workflow() 无 timeout 协议字段，不接线（其 pending
 * 由 abort 广播与嵌套 run 自身上界兜底）。
 */

// ── Build worker source ─────────────────────────────────────

/**
 * Template constant segments（模块级 hoisting，IF5/TC8）——
 * 常量段在模块加载时构造一次，buildWorkerScript 每次调用只做三段 concat，
 * 消除每次 run 的 330+ 元素数组重建 + join 分配（#11 低优先形态）。
 *
 * 输出与 hoisting 前逐字节一致（join("\n") 拼装语义精确保留），由
 * __tests__/worker-script-template-snapshot.test.ts 的 byte-identical 快照锚定
 * （fixture 由改造前实现生成）。
 */

/** PRE 段：use strict … User workflow script 注释行（不含 userScript）。 */
const WORKER_TEMPLATE_PRE = [
  '"use strict";',
  '// Module-scope helpers: accessible to BOTH the IIFE body AND the outer',
  '// .then()/.catch() handlers (which run outside the IIFE). _workerLogs/',
  '// _pushWorkerLog/_safePost + the parentPort/workerData handles must all live',
  '// here — a previous version declared _safePost inside the IIFE, so the',
  '// .then()/.catch() return/error handlers threw ReferenceError: _safePost is',
  '// not defined, crashing the Worker on EVERY script return (exit code 1) and',
  '// losing all diagnostics. require() is cached, so destructuring once at module',
  '// load and reusing everywhere avoids the redundant require calls that used to',
  '// appear in the IIFE and the outer .then/.catch.',
  'const { parentPort: _parentPort, workerData: _workerData } = require("node:worker_threads");',
  'const _workerLogs = [];',
  '// IF6(#12): known agent() fields — hoisted to module scope, built once per worker',
  '// (was rebuilt inside agent() on every call; field set is call-invariant).',
  'const _KNOWN_FIELDS = new Set(["prompt", "description", "schema", "model", "scene", "label", "task", "agent", "phase", "skill", "timeoutMs", "maxTurns", "cwd", "fork", "worktree", "returnMeta", "thinkingLevel", "engine"]);',
  'function _pushWorkerLog(level, args) {',
  '  try { _workerLogs.push({ level, message: args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ") }); } catch (e) { /* swallow */ }',
  '}',
  '// ── safePostMessage wrapper: 统一 postMessage 防御（DataCloneError 等）──',
  '// Module-scope so the outer .then/.catch return/error handlers can use it.',
  '// context 取值约定（诊断标识）：固定为消息类型字面量——',
  '// "agent-call" / "workflow-call" / "return" / "error"，调用方据此在日志里',
  '// 一眼定位是哪类 postMessage 失败。新增调用点必须传对应 context。',
  'function _safePost(msg, context) {',
  '  try { _parentPort.postMessage(msg); return true; }',
  '  catch (e) {',
  '    const errMsg = e && e.message ? e.message : String(e);',
  '    const stack = e && e.stack ? e.stack : "";',
  '    _pushWorkerLog("error", ["[postMessage failed:" + context + "]", errMsg, stack]);',
  '    return false;',
  '  }',
  '}',
  '(async () => {',
  '  const parentPort = _parentPort;',
  '  const workerData = _workerData;',
  '',
  '  if (!parentPort) {',
  '    throw new Error("Workflow worker: parentPort is null — not running in a Worker thread");',
  '  }',
  '',
  '  // ── Intercept console.* to avoid leaking worker diagnostics into the input area ──',
  '  console.log = function (...args) { _pushWorkerLog("log", args); };',
  '  console.warn = function (...args) { _pushWorkerLog("warn", args); };',
  '  console.error = function (...args) { _pushWorkerLog("error", args); };',
  '  console.info = function (...args) { _pushWorkerLog("info", args); };',
  '',
  '  // ── Internal state ──',
  '  let _callIdCounter = 0;',
  '  let _agentCallCount = 0;',
  '  const _pendingCalls = new Map();',
  '  const _callCache = workerData.callCache instanceof Map',
  '    ? workerData.callCache',
  '    : new Map(Object.entries(workerData.callCache || {}).map(([k, v]) => [Number(k), v]));',
  '',
  '  // ── Injected globals ──',
  '  const $ARGS = (workerData.args && typeof workerData.args === "object") ? workerData.args : {};\n' +
      '  const args = $ARGS;',
  '  const $WORKSPACE = typeof workerData.workspace === "string" ? workerData.workspace : "";',
  '  const _budgetData = {',
  '    total: (workerData.budget && workerData.budget.maxTokens) || 0,',
  '    _spentTokens: (workerData.budget && workerData.budget.usedTokens) ?? 0,',
  '    _spentCost: (workerData.budget && workerData.budget.usedCost) ?? 0,',
  '  };',
  '  const $BUDGET = {',
  '    get total() { return _budgetData.total; },',
  '    spent() { return _budgetData._spentTokens; },',
  '    remaining() { return Math.max(0, _budgetData.total - _budgetData._spentTokens); },',
  '  };',
  '',
  '  // ── Run-level model/thinkingLevel override (Option B symmetric single-path) ──',
  '  // Injected from workerData (set by workerHost from RunSpec.model/thinkingLevel).',
  '  // agent() reads these as run-level defaults; per-call explicit opts still win.',
  '  const $MODEL = (workerData.model && typeof workerData.model === "string") ? workerData.model : undefined;',
  '  const $THINKING_LEVEL = (workerData.thinkingLevel && typeof workerData.thinkingLevel === "string") ? workerData.thinkingLevel : undefined;',
  '',
  '  // ── WorkflowAbortedError ──',
  '  class WorkflowAbortedError extends Error {',
  '    constructor(reason) {',
  '      super("Workflow aborted: " + (reason || "No reason"));',
  '      this.name = "WorkflowAbortedError";',
  '      this.reason = reason || "";',
  '    }',
  '  }',
  '',
  '  // ── Message handler (main thread → worker) ──',
  '  parentPort.on("message", (msg) => {',
  '    if (msg.type === "agent-result") {',
  '      const pending = _pendingCalls.get(msg.callId);',
  '      if (pending) {',
  '        _pendingCalls.delete(msg.callId);',
  '        // [OR-3] 结果已到，清除 per-call 超时 timer（有 timer 才清，防御旧 pending 无该字段）',
  '        if (pending.timer) { clearTimeout(pending.timer); }',
  '        if (typeof msg.result !== "undefined") {',
  '          _callCache.set(msg.callId, msg.result);',
  '        }',
  '        // 失败不传播到 agent 外部：resolve 而非 reject。',
  '        // 旧实现在 result.error 时 reject，单 agent 失败会冒到 worker 顶层 .catch()',
  '        // → 发 type:"error" → handleScriptError → rebuildRuntime → SIGKILL 同伴进程，',
  '        // 把单点失败放大成整批崩溃。改为始终 resolve（错误时回退到 content 文本），',
  '        // 让 parallel() 下的脚本容错循环（parseResult → null → skip）自然接管。',
  '        // 错误原因已由主线程 executeAgentCall → trace.update(result.error) 保留在 trace/TUI，',
  '        // 不丢失。失败 resolve 为空字符串是既定容错策略。',
  '        // [MF-4] schema 模式下失败时 agent() 仍 resolve（content 回退、不 throw）——',
  '        // 需要检查错误时请用 returnMeta:true（resolve 值含 error 字段）。',
  '        // parsedOutput: validated data object from structured-output execute().',
  '        // Fallback to content (raw text) when no schema was requested or on error.',
  '        // W2 改动 9(b)：returnMeta===true 时 resolve {value,sessionFile,worktreePath,error,usage,durationMs,sessionId}',
  '        // （对称缓存重放 9c）；否则单值。usage/durationMs/sessionId 为 rfl 仪表透传（tier-1 §7.1，',
  '        // AgentResult 已含、此处原样转发，缺省 undefined 兼容旧主线程）。',
  '        const _value = msg.result.parsedOutput ?? msg.result.content;',
  '        if (pending.returnMeta) {',
  '          pending.resolve({',
  '            value: _value,',
  '            sessionFile: msg.result.sessionFile,',
  '            worktreePath: msg.result.worktreePath,',
  '            error: msg.result.error,',
  '            usage: msg.result.usage,',
  '            durationMs: msg.result.durationMs,',
  '            sessionId: msg.result.sessionId,',
  '          });',
  '        } else {',
  '          pending.resolve(_value);',
  '        }',
  '      }',
  '    } else if (msg.type === "workflow-result") {',
  '      const pending = _pendingCalls.get(msg.callId);',
  '      if (pending) {',
  '        _pendingCalls.delete(msg.callId);',
  '        // [OR-3] 结果已到，清除 per-call 超时 timer（workflow() 当前不挂 timer，防御性对称清理）',
  '        if (pending.timer) { clearTimeout(pending.timer); }',
  '        pending.resolve(msg.result);',
  '      }',
  '    } else if (msg.type === "abort") {',
  '      // [OR-3] 主线程 abortRun/terminateRunningRuns 的优雅解阻广播：全部 pending',
  '      // reject（脚本 catch WorkflowAbortedError 可感知取消）+ 清理 timer + 清 Map。',
  '      // 后续迟到结果命中空 Map（no-op），不产主线程 unhandledRejection。',
  '      const err = new WorkflowAbortedError(msg.reason);',
  '      _pendingCalls.forEach((p) => { if (p.timer) { clearTimeout(p.timer); } p.reject(err); });',
  '      _pendingCalls.clear();',
  '    } else if (msg.type === "budget-update" && msg.budget) {',
  '      _budgetData._spentTokens = msg.budget.usedTokens ?? _budgetData._spentTokens;',
  '      _budgetData._spentCost = msg.budget.usedCost ?? _budgetData._spentCost;',
  '    }',
  '    // "budget-warning" is informational; no required handling',
  '  });',
  '',
  // ── phase global ──
  '  let _currentPhase = "";',
  '  function phase(name) { _currentPhase = String(name); }',
  '',
  // ── log global ──
  '  function log(msg) {',
  '    var _logText = String(msg);',
  '    // [B-3] 单通路：只发独立 {type:"log"} 消息，主线程 handleWorkerLog 即时消费',
  '    //（push 进 errorLogs）。不再同时记入 _workerLogs——旧双通路让同一日志随',
  '    // return/error 的 workerLogs 再带回一份，errorLogs 占两格、TUI 双份。',
  '    try { parentPort.postMessage({ type: "log", phase: _currentPhase, message: _logText }); } catch(e) { /* swallow */ }',
  '  }',
  '',
  // ── agent global — CC-compatible multi-signature ──
  '  async function agent(firstArg, secondArg) {',
  '    let opts;',
  '    if (typeof firstArg === "string") {',
  '      opts = {',
  '        prompt: firstArg,',
  '        description: (secondArg && typeof secondArg === "object" && secondArg.label) || undefined,',
  '        schema: (secondArg && typeof secondArg === "object" && secondArg.schema) || undefined,',
  '        model: (secondArg && typeof secondArg === "object" && secondArg.model) || $MODEL,',
  '        scene: (secondArg && typeof secondArg === "object" && secondArg.scene) || undefined,\n' +
      '        phase: (secondArg && typeof secondArg === "object" && secondArg.phase) || undefined,',
  '        thinkingLevel: (secondArg && typeof secondArg === "object" && secondArg.thinkingLevel) || $THINKING_LEVEL,',
  '        // step 级 turn 上限（turn limiter；显式 0/负 = 显式不限，压过 spawn watchdog env 兑底，SP-6）\n' +
      '        // ?? 语义保真：仅 null/undefined 归 undefined（走 env 兑底），显式 0 保留（U5 参数 > env）',
  '        maxTurns: (secondArg && typeof secondArg === "object" ? secondArg.maxTurns : undefined) ?? undefined,',
  '        // [OR-3] per-call timeoutMs 透传（string 分支此前丢弃该字段——对象分支已有；',
  '        // worker pending 消息层超时依赖它流到 agent-call 消息）',
  '        timeoutMs: (secondArg && typeof secondArg === "object" ? secondArg.timeoutMs : undefined),',
  '        // P4 D9③：step 级 engine 显式指定（仅限必须某引擎独有能力的场景）',
  '        engine: (secondArg && typeof secondArg === "object" && secondArg.engine) || undefined,',
  '      };',
  '    } else if (typeof firstArg === "object" && firstArg !== null) {',
  '      if (firstArg.prompt) {',
  '        opts = firstArg;',
  '      } else if (firstArg.task || firstArg.agent) {',
  '        // fork/worktree/returnMeta forwarded here (parity with agent({prompt,...}) and direct-pass',
  '        // branches). Previously this shortcut dropped them (w1 only noted, not wired).',
  '        opts = {',
  '          prompt: firstArg.task || firstArg.prompt || "",',
  '          description: firstArg.label || firstArg.description,',
  '          agent: firstArg.agent,',
  '          schema: firstArg.schema,',
  '          model: firstArg.model || $MODEL,',
  '          scene: firstArg.scene,',
  '          skill: firstArg.skill,',
  '          timeoutMs: firstArg.timeoutMs,',
  '          maxTurns: firstArg.maxTurns,',
  '          cwd: firstArg.cwd,',
  '          fork: firstArg.fork,',
  '          worktree: firstArg.worktree,',
  '          returnMeta: firstArg.returnMeta,',
  '          thinkingLevel: firstArg.thinkingLevel || $THINKING_LEVEL,',
  '          engine: firstArg.engine,',
  '        };',
  '      } else {',
  '        opts = firstArg;',
  '      }',
  '    } else {',
  '      throw new Error("agent() requires a prompt string or options object as first argument");',
  '    }',
  '',
  '    // Run-level fallback for object branches (opts = firstArg direct assign).',
  '    // Priority: agent() explicit > $MODEL global (set from workerData.model).',
  '    if (!opts.model && $MODEL) opts.model = $MODEL;',
  '    if (!opts.thinkingLevel && $THINKING_LEVEL) opts.thinkingLevel = $THINKING_LEVEL;',
  '',
  '    // Validate known agent() fields to catch API misuse early (_KNOWN_FIELDS at module scope)',
  '    const _unknownFields = Object.keys(opts).filter((k) => !_KNOWN_FIELDS.has(k));',
  '    if (_unknownFields.length > 0) {',
  '      _pushWorkerLog("warn", ["[workflow] agent() received unknown fields: " + _unknownFields.join(", ") + ". Known fields: prompt, description, schema, model, scene, label, task, agent, phase, skill, timeoutMs, maxTurns, cwd, fork, worktree, returnMeta, thinkingLevel, engine"]);',
  '    }',
  '',
  '    const callId = _callIdCounter;',
  '    _callIdCounter++;',
  '    _agentCallCount++;',
  '    if (_callCache.has(callId)) {',
  '      const cached = _callCache.get(callId);',
  '      // 与 live handler 对齐：失败也 resolve（回退 content），不 throw。',
  '      // 见 agent-result 消息处理的注释：拒绝传播失败到 agent 外部。',
  '      // W2 改动 9(c)：returnMeta 分支（对称 handler 9b），opts 仍在闭包作用域。',
  '      if (!cached) return undefined;',
  '      const _cachedValue = cached.parsedOutput ?? cached.content;',
  '      if (opts.returnMeta === true) {',
  '        return {',
  '          value: _cachedValue,',
  '          sessionFile: cached.sessionFile,',
  '          worktreePath: cached.worktreePath,',
  '          error: cached.error,',
  '          usage: cached.usage,',
  '          durationMs: cached.durationMs,',
  '          sessionId: cached.sessionId,',
  '        };',
  '      }',
  '      return _cachedValue;',
  '    }',
  '',
  '    const _effectivePhase = opts.phase || _currentPhase;\n' +
      '    delete opts.phase;\n' +
      '\n' +
      '    if (!_safePost({ type: "agent-call", callId, opts, phase: _effectivePhase }, "agent-call")) {',
  '      return Promise.reject(new Error("postMessage failed for agent-call (callId=" + callId + "): see workerLogs"));',
  '    }',
  '    return new Promise((resolve, reject) => {',
  '      const _pending = { resolve: resolve, reject: reject, returnMeta: opts.returnMeta === true, timer: undefined };',
  '      // [OR-3] per-call timeoutMs：消息层自己的超时——主线程对 agent-call 永不回话',
  '      //（畸形消息丢弃 / postMessage 双重失败 / runner 不 settle）时 pending 不再永挂',
  '      //（旧实现零超时 → agent() 永挂 → worker 不退出 → run 永久 running）。',
  '      // 超时以错误 resolve（对齐 agent-result 失败容错策略：不 reject、不把单点超时',
  '      // 放大成脚本 error → rebuild），并记入 _workerLogs 留诊断。仅显式 timeoutMs > 0',
  '      // 启用（缺省不限，与 runner 侧 per-call timeout 语义一致）。timer unref：脚本',
  '      // 已 return 时残留 timer 不延迟 worker 自然退出。',
  '      if (typeof opts.timeoutMs === "number" && opts.timeoutMs > 0) {',
  '        _pending.timer = setTimeout(() => {',
  '          if (!_pendingCalls.delete(callId)) { return; }',
  '          const _timeoutMsg = "agent call timed out after " + opts.timeoutMs + "ms (callId=" + callId + ") — no agent-result received from main thread";',
  '          _pushWorkerLog("warn", ["[workflow] " + _timeoutMsg]);',
  '          if (opts.returnMeta === true) {',
  '            _pending.resolve({ value: "", error: _timeoutMsg });',
  '          } else {',
  '            // [B-5] 非 returnMeta 超时 resolve 单值错误消息字符串（对齐 agent-result',
  '            // 失败路径 resolve 单值 _value = parsedOutput ?? content 的形态）——',
  '            // 旧实现 resolve {content:"", error} 对象，字符串消费型脚本（r.trim() 类）',
  '            // 在超时路径 TypeError。',
  '            _pending.resolve(_timeoutMsg);',
  '          }',
  '        }, opts.timeoutMs);',
  '        if (_pending.timer && typeof _pending.timer.unref === "function") { _pending.timer.unref(); }',
  '      }',
  '      _pendingCalls.set(callId, _pending);',
  '    });',
  '  }',
  '',
  // ── parallel global — CC-compatible ──
  // allSettled 语义：单个 agent 的意外 reject（postMessage 失败等基础设施异常、abort）
  // 不拖垮整批。rejected 结果降级为错误消息字符串（与 agent() 的 error→content 回退一致，
  // parseResult(string) → null → 脚本 soft-fail）。B1 之后 agent() 不再因 agent 失败 reject，
  // 这里作为纵深防御保留。
  //
  // **Promise 项处理**：CC-compatible 写法 `parallel([agent({...}), ...])` 传入的是已实例化
  // 的 Promise 数组（agent() 同步返回 Promise）。Promise 是 object 但无 .then 鸭辨分支时
  // 会落到 `agent(c)` 把 Promise 当 opts 传 → postMessage DataCloneError。必须在函数/opts
  // 分支前用 thenable 鸭辨直接返回 in-flight Promise，让 allSettled 接管。
  '  async function parallel(calls) {',
  '    if (typeof calls === "function") { return calls(); }',
  '    const settled = await Promise.allSettled(calls.map((c) => {',
  '      if (c && typeof c.then === "function") { return c; }',
  '      if (typeof c === "function") { return c(); }',
  '      if (typeof c === "object" && c !== null && (c.task || c.agent)) { return agent(c); }',
  '      return agent(c);',
  '    }));',
  '    return settled.map((r) => {',
  '      if (r.status === "fulfilled") {',
  '        const v = r.value;',
  '        if (v !== null && typeof v === "object" && !Array.isArray(v)) {',
  '          // 主线程 fallback（postAgentResult/postResult serialization failed）回发的对象含 error 字段',
  '          // → 归一化为 failed 形状，与脚本侧 r.status === "failed" 检查统一',
  '          if (typeof v.error === "string" && v.error.length > 0) return { status: "failed", error: v.error };',
  '          return v;',
  '        }',
  '        return { status: "failed", error: "agent returned non-object result (type=" + typeof v + ")" };',
  '      }',
  '      const reason = r.reason;',
  '      const errMsg = reason instanceof Error ? reason.message : String(reason);',
  '      return { status: "failed", error: errMsg };',
  '    });',
  '  }',
  '',
  // ── pipeline global ──
  '  async function pipeline(firstArg, ...restStages) {',
  '    // Single-arg mode: pipeline([stage1, stage2, ...])',
  '    if (Array.isArray(firstArg) && restStages.length === 0) {',
  '      let result;',
  '      for (let i = 0; i < firstArg.length; i++) {',
  '        try { result = await firstArg[i](result); }',
  '        catch (e) {',
  '          const msg = e && e.message ? e.message : String(e);',
  '          _pushWorkerLog("error", ["[pipeline stage " + i + " failed]", msg]);',
  '          throw e;',
  '        }',
  '      }',
  '      return result;',
  '    }',
  '    // Cartesian product mode: pipeline([items], stage1, stage2, ...)',
  '    if (Array.isArray(firstArg) && restStages.length > 0 && typeof restStages[0] === "function") {',
  '      const results = [];',
  '      for (let idx = 0; idx < firstArg.length; idx++) {',
  '        const item = firstArg[idx];',
  '        let val = item;',
  '        let failed = false;',
  '        for (const stage of restStages) {',
  '          if (failed) break;',
  '          try { val = await stage(val); }',
  '          catch (e) {',
  '          const msg = e && e.message ? e.message : String(e);',
  '          _pushWorkerLog("error", ["[pipeline cartesian stage failed for item " + (idx + 1) + "]", msg]);',
  '          val = null; failed = true;',
  '          }',
  '        }',
  '        results.push(val);',
  '      }',
  '      return results;',
  '    }',
  '    throw new Error("pipeline() expects pipeline([stage1, ...]) or pipeline([items], stage1, ...)");',
  '  }',
  '',
  '  // ── workflow global — nested workflow invocation ──',
  '  async function workflow(name, args) {',
  '    if (typeof name !== "string" || name.length === 0) {',
  '      throw new Error("workflow() requires a workflow name string as first argument");',
  '    }',
  '    const workflowArgs = (typeof args === "object" && args !== null) ? args : {};',
  '    const callId = _callIdCounter;',
  '    _callIdCounter++;',
  '    if (!_safePost({ type: "workflow-call", callId, name, args: workflowArgs }, "workflow-call")) {',
  '      return Promise.reject(new Error("postMessage failed for workflow-call (name=" + name + "): see workerLogs"));',
  '    }',
  '    return new Promise((resolve, reject) => {',
  '      _pendingCalls.set(callId, { resolve, reject });',
  '    });',
  '  }',
  '',
  '  // ── User workflow script ──',
].join("\n");

/** POST 段：auto-invoke execute() + 顶层 .then/.catch return/error handler。 */
const WORKER_TEMPLATE_POST = [
  '  // ── Auto-invoke execute() for module.exports pattern ──',
  '  if (typeof module !== "undefined" && module.exports && typeof module.exports.execute === "function") {',
  '    return await module.exports.execute({ agent, parallel, pipeline, phase, log, workflow, $ARGS, $WORKSPACE, $BUDGET });',
  '  }',
  '})().then((result) => {',
  '  const runId = (_workerData.args && typeof _workerData.args === "object" && _workerData.args._runId) || "";',
  '  if (!_safePost({ type: "return", runId, result, workerLogs: _workerLogs }, "return")) {',
  '    // [F1] return 值不可克隆（含 function/Symbol/循环引用 → DataCloneError）时 _safePost',
  '    // 只能记日志返回 false——若不补救，worker 将静默 exit(0)，主线程收不到任何终态消息，',
  '    // run 永久 running、runAndWait 悬挂。回发可克隆的 error 消息（DataCloneError 详情',
  '    // 已由 _safePost 记入 _workerLogs 随消息带回），让主线程 handleScriptError 接管，',
  '    // run 经既有重试矩阵收敛到终态 failed。',
  '    _safePost({ type: "error", runId, error: "Workflow return value could not be delivered (structured-clone failed) — see workerLogs for the postMessage error", workerLogs: _workerLogs }, "error");',
  '  }',
  '}).catch((err) => {',
  '  const runId = (_workerData.args && typeof _workerData.args === "object" && _workerData.args._runId) || "";',
  '  _safePost({ type: "error", runId, error: err.message || String(err), workerLogs: _workerLogs }, "error");',
  '});',
].join("\n");

/**
 * Build the complete worker source text by wrapping the user's workflow script
 * with infrastructure code and injected global functions.
 *
 * AC-4：脚本格式不变（用户资产）。逐字保留旧 buildWorkerScript 的拼接逻辑——
 * 三段 concat 的换行语义 = 原单数组 join("\n")（userScript 段带 2 空格缩进，
 * 段后一个空行接 auto-invoke 段），byte-identical 快照锚定。
 */
export function buildWorkerScript(userScript: string): string {
  return WORKER_TEMPLATE_PRE + "\n  " + userScript + "\n\n" + WORKER_TEMPLATE_POST;
}
