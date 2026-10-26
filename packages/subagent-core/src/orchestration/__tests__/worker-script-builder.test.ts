/**
 * buildWorkerScript — 生成源契约测试。
 *
 * （历史上本文件头部是 workflow() 嵌套调用注入契约测试——该 API 已随嵌套
 * workflow() 编排 API 退役删除，相关 describe 一并移除。）
 *
 * [round5-g 合并产物] worker-script-builder 测试簇五合一，来源：
 * - worker-script-builder.test.ts（生成源字符串契约，本文件原内容）
 * - worker-script-template-snapshot.test.ts（模板 hoisting 快照锚定）
 * - worker-script-builder-runtime.test.ts（真实 Worker 运行时回归）
 * - worker-pending-timeout-abort.test.ts（pending 超时 + abort 广播）
 * - worker-returnmeta-passthrough.test.ts（returnMeta 透传 rfl 仪表三字段）
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";



// ── H3: agent() task/agent 分支 skill 字段传递 ──

describe("buildWorkerScript — agent() skill field in task/agent branch", () => {
  const script = buildWorkerScript("// noop user script");

  it("task/agent branch includes skill in opts whitelist", () => {
    // H3: agent({task, agent, skill}) 的 skill 在 task/agent 分支被丢弃。
    // 验证生成的 worker 源码中，task/agent 分支的 opts 构造含 skill 字段。
    // 找到 task/agent 分支的 opts 构造代码（含 firstArg.task || firstArg.agent）
    const taskAgentBranch = script.match(/firstArg\.task \|\| firstArg\.agent[\s\S]*?\};/);
    expect(taskAgentBranch).toBeTruthy();
    expect(taskAgentBranch![0]).toContain("skill: firstArg.skill");
  });
});

// ── W1: postMessage 防御 + parallel() 降级类型安全 ──

describe("buildWorkerScript — W1 postMessage defense & parallel degrade", () => {
  const script = buildWorkerScript("// noop user script");

  describe("_safePost wrapper", () => {
    it("injects _safePost function", () => {
      expect(script).toContain("function _safePost(msg, context)");
    });

    it("_safePost wraps postMessage in try/catch", () => {
      // _safePost 在 module scope（parentPort 解析为 _parentPort），
      // 用宽松正则匹配「try { <something>.postMessage(msg)」避免绑死变量名。
      expect(script).toMatch(/_safePost[\s\S]*?try \{ _parentPort\.postMessage\(msg\)/);
    });

    it("_safePost logs failure with context to workerLogs", () => {
      expect(script).toContain('_pushWorkerLog("error"');
      expect(script).toContain('"[postMessage failed:" + context + "]"');
    });
  });

  describe("agent() uses _safePost", () => {
    it("agent-call postMessage guarded by _safePost", () => {
      expect(script).toContain("_safePost({ type: \"agent-call\"");
      expect(script).toContain('"agent-call"');
    });

    it("agent() throws on postMessage failure", () => {
      expect(script).toContain("postMessage failed for agent-call");
    });
  });

  describe("return/error use _safePost", () => {
    it("return postMessage uses _safePost", () => {
      expect(script).toContain('_safePost({ type: "return"');
    });

    it("error postMessage uses _safePost", () => {
      expect(script).toContain('_safePost({ type: "error"');
    });
  });

  describe("parallel() degrade returns object", () => {
    it("rejected results become {status:failed,error} objects", () => {
      expect(script).toContain('status: "failed"');
      expect(script).toMatch(/parallel[\s\S]*?status: "failed"/);
    });

    it("non-object fulfilled values wrapped as failed", () => {
      expect(script).toContain("agent returned non-object result");
    });

    it("object fulfilled values pass through unchanged", () => {
      expect(script).toContain("!Array.isArray(v)");
    });
  });

  describe("pipeline() error observability", () => {
    it("single-arg mode logs stage errors before re-throwing", () => {
      expect(script).toContain("[pipeline stage ");
      expect(script).toContain("_pushWorkerLog(\"error\"");
    });
  });
});

// ── W2: agent() returnMeta 模式 ──
// 验证 returnMeta 标志：known fields 放行 + handler resolve 分支 + 缓存重放分支，
// 且两处分支结构对称（returnMeta===true → {value, sessionFile, worktreePath, error}）。

describe("buildWorkerScript — W2 agent() returnMeta mode", () => {
  const script = buildWorkerScript("// noop user script");

  describe("returnMeta known field whitelist", () => {
    it("includes returnMeta in _knownFields Set", () => {
      expect(script).toContain('"returnMeta"');
    });

    it("includes returnMeta in unknown-fields warning text", () => {
      expect(script).toContain("cwd, fork, worktree, returnMeta");
    });

    it("does NOT warn about returnMeta when only returnMeta is passed (parity with fork/worktree)", () => {
      // fork/worktree 已是 known fields；returnMeta 加入后不应触发 warn 文案中的 returnMeta。
      // 简化断言：warning 文案里 Known 列表含 returnMeta（即被识别）。
      expect(script).toMatch(/Known fields:.*returnMeta/);
    });
  });

  describe("_pendingCalls stores returnMeta flag", () => {
    it("stores returnMeta: opts.returnMeta === true in _pendingCalls.set", () => {
      expect(script).toContain(
        "returnMeta: opts.returnMeta === true",
      );
    });
  });

  describe("agent-result handler resolve branch (改动 9b)", () => {
    it("branches on pending.returnMeta", () => {
      expect(script).toContain("if (pending.returnMeta)");
    });

    it("resolve branch returns {value, sessionFile, worktreePath, error}", () => {
      const handlerBlock = script.match(
        /if \(pending\.returnMeta\) \{[\s\S]*?\} else \{[\s\S]*?pending\.resolve\(_value\);[\s\S]*?\}/,
      );
      expect(handlerBlock).toBeTruthy();
      expect(handlerBlock![0]).toContain("value: _value");
      expect(handlerBlock![0]).toContain("sessionFile: msg.result.sessionFile");
      expect(handlerBlock![0]).toContain("worktreePath: msg.result.worktreePath");
      expect(handlerBlock![0]).toContain("error: _schemaGap ? _value : msg.result.error");
    });

    it("fallback resolve single value uses parsedOutput ?? content, gated by schema-gap (ADR-0092)", () => {
      // 判定源 = pending.hasSchema（agent-result 段在 worker 顶层，opts 不在作用域）
      expect(script).toContain(
        "const _schemaGap = pending.hasSchema && msg.result.parsedOutput === undefined && msg.result.error === undefined;",
      );
      expect(script).toContain(
        "hasSchema: opts.schema !== undefined",
      );
      expect(script).toContain(
        ": (msg.result.parsedOutput ?? msg.result.content);",
      );
    });
  });

  describe("cache replay returnMeta branch (改动 9c)", () => {
    it("early-returns undefined when !cached", () => {
      expect(script).toContain("if (!cached) return undefined;");
    });

    it("branches on opts.returnMeta === true", () => {
      expect(script).toContain("if (opts.returnMeta === true)");
    });

    it("cache replay returns {value, sessionFile, worktreePath, error} from cached", () => {
      const cacheBlock = script.match(
        /if \(opts\.returnMeta === true\) \{[\s\S]*?return _cachedValue;/,
      );
      expect(cacheBlock).toBeTruthy();
      expect(cacheBlock![0]).toContain("value: _cachedValue");
      expect(cacheBlock![0]).toContain("sessionFile: cached.sessionFile");
      expect(cacheBlock![0]).toContain("worktreePath: cached.worktreePath");
      expect(cacheBlock![0]).toContain("error: _schemaGap ? _cachedValue : cached.error");
    });

    it("cache replay fallback uses cached.parsedOutput ?? cached.content, gated by schema-gap (ADR-0092)", () => {
      expect(script).toContain(
        "const _schemaGap = opts.schema !== undefined && cached.parsedOutput === undefined && cached.error === undefined;",
      );
      expect(script).toContain(
        ": (cached.parsedOutput ?? cached.content);",
      );
    });
  });

  describe("handler (9b) and cache replay (9c) branch symmetry", () => {
    it("both expose worktreePath field (CL-1/DEC-2 core)", () => {
      // handler 读 msg.result.worktreePath；cache replay 读 cached.worktreePath。
      expect(script).toContain("msg.result.worktreePath");
      expect(script).toContain("cached.worktreePath");
    });
  });
});

// ── thinkingLevel 参数透传（agent() 三分支） ──
// 验证 thinkingLevel 在 string / task-agent / object.prompt 三个分支均被透传至
// agent-call 的 opts，且加入 _knownFields 白名单（object.prompt 分支整体透传，
// 不被 unknown-fields warn 误报）。底层 AgentCallOpts（D6 合流后 EnginePort 直传，
// buildSpawnArgs 拼 pi CLI --model provider/modelId:thinkingLevel 已打通，
// 此处只验入口层 wiring。

describe("buildWorkerScript — agent() thinkingLevel passthrough (3 branches)", () => {
  const script = buildWorkerScript("// noop user script");

  it("string branch extracts thinkingLevel from secondArg (parity with model/scene/phase)", () => {
    // agent("prompt", {thinkingLevel:"high"}) → string 分支 opts 提取 thinkingLevel
    const stringBranch = script.match(/typeof firstArg === "string"[\s\S]*?\};/);
    expect(stringBranch).toBeTruthy();
    expect(stringBranch![0]).toContain(
      "thinkingLevel: (secondArg && typeof secondArg === \"object\" && secondArg.thinkingLevel) || $THINKING_LEVEL",
    );
  });

  it("task/agent branch includes thinkingLevel in opts (parity with model/skill/timeoutMs)", () => {
    // agent({task, agent, thinkingLevel}) → task/agent 快捷分支透传 thinkingLevel
    const taskAgentBranch = script.match(/firstArg\.task \|\| firstArg\.agent[\s\S]*?\};/);
    expect(taskAgentBranch).toBeTruthy();
    expect(taskAgentBranch![0]).toContain("thinkingLevel: firstArg.thinkingLevel");
  });

  it("thinkingLevel is a known field (object.prompt branch passes through without unknown-fields warn)", () => {
    // object.prompt 分支 opts = firstArg 整体透传，thinkingLevel 自然带入；
    // 但必须进 _knownFields 白名单，否则 Object.keys(opts) 含 thinkingLevel 会触发
    // unknown-fields warn（workerLogs 污染）。验证 Set 与 warn 文案均识别 thinkingLevel。
    expect(script).toContain('"thinkingLevel"');
    expect(script).toMatch(/Known fields:.*thinkingLevel/);
  });
});

// ── P3/P4: run-level model/thinkingLevel override global injection ──
// Option B 对称单路径：workflow 顶层 model/thinkingLevel 经 workerData →
// $MODEL/$THINKING_LEVEL worker global → agent() 三分支 fallback。
// 验证生成的 worker 源码字符串包含 global 注入与三分支 fallback 逻辑。
// 运行时真生效需 worker 集成 harness（设计文档 §6 降级为源码字符串断言）。

describe("P3/P4 run-level model/thinkingLevel global injection + agent() fallback", () => {
  const script = buildWorkerScript("// noop user script");

  it("injects $MODEL global from workerData.model", () => {
    expect(script).toContain('const $MODEL = (workerData.model && typeof workerData.model === "string") ? workerData.model : undefined;');
  });

  it("injects $THINKING_LEVEL global from workerData.thinkingLevel", () => {
    expect(script).toContain('const $THINKING_LEVEL = (workerData.thinkingLevel && typeof workerData.thinkingLevel === "string") ? workerData.thinkingLevel : undefined;');
  });

  it("string branch falls back to $MODEL when secondArg.model omitted", () => {
    const stringBranch = script.match(/typeof firstArg === "string"[\s\S]*?\};/);
    expect(stringBranch).toBeTruthy();
    expect(stringBranch![0]).toContain('secondArg.model) || $MODEL');
  });

  it("string branch falls back to $THINKING_LEVEL when secondArg.thinkingLevel omitted", () => {
    const stringBranch = script.match(/typeof firstArg === "string"[\s\S]*?\};/);
    expect(stringBranch).toBeTruthy();
    expect(stringBranch![0]).toContain('secondArg.thinkingLevel) || $THINKING_LEVEL');
  });

  it("task/agent branch falls back to $MODEL when firstArg.model omitted", () => {
    const taskAgentBranch = script.match(/firstArg\.task \|\| firstArg\.agent[\s\S]*?\};/);
    expect(taskAgentBranch).toBeTruthy();
    expect(taskAgentBranch![0]).toContain('model: firstArg.model || $MODEL');
  });

  it("task/agent branch falls back to $THINKING_LEVEL when firstArg.thinkingLevel omitted", () => {
    const taskAgentBranch = script.match(/firstArg\.task \|\| firstArg\.agent[\s\S]*?\};/);
    expect(taskAgentBranch).toBeTruthy();
    expect(taskAgentBranch![0]).toContain('thinkingLevel: firstArg.thinkingLevel || $THINKING_LEVEL');
  });

  it("object branch injects $MODEL when opts.model omitted (guard fallback)", () => {
    expect(script).toContain('if (!opts.model && $MODEL) opts.model = $MODEL;');
  });

  it("object branch injects $THINKING_LEVEL when opts.thinkingLevel omitted (guard fallback)", () => {
    expect(script).toContain('if (!opts.thinkingLevel && $THINKING_LEVEL) opts.thinkingLevel = $THINKING_LEVEL;');
  });
});

// ══════ 来源: worker-script-template-snapshot.test.ts ══════

/**
 * buildWorkerScript 模板 hoisting（IF5/IF6）— byte-identical 快照锚定。
 *
 * ES8：快照先行——fixture 由「改造前实现」生成落盘（本文件同 commit），
 * 断言重构后输出与 fixture 逐字节一致，锁定 PRE/POST 边界换行与 userScript
 * 缩进语义（AC-4「逐字保留」不变式）。IF6（_KNOWN_FIELDS 提升至生成源
 * module scope）落地时基线已按设计在同一 commit 内更新为最终形态。
 *
 * 样例脚本覆盖 $ARGS / schema / parallel / pipeline / phase / log 特性。
 */



const sampleScript = [
  "// sample exercising template features",
  'const name = $ARGS.name ?? "default";',
  'phase("build");',
  'const spec = await agent("build it", { label: "builder", schema: { type: "object" } });',
  "const results = await parallel([",
  '  agent({ task: "unit tests", agent: "./tester.md" }),',
  '  agent({ task: "lint", agent: "./linter.md", skill: "lint-skill" }),',
  "]);",
  "await pipeline([(x) => x, (x) => x]);",
  'log("done " + name + " " + $WORKSPACE + " " + $BUDGET.remaining());',
  "module.exports = { execute: async (ctx) => ctx.agent(\"finalize\") };",
].join("\n");

function loadFixture(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "__fixtures__", "worker-template.snapshot.txt"), "utf8");
}

describe("buildWorkerScript — 模板 hoisting byte-identical 快照（IF5）", () => {
  it("特性全量样例的输出与 fixture 逐字节一致", () => {
    const out = buildWorkerScript(sampleScript);
    expect(out).toBe(loadFixture());
  });

  it("首尾边界锚定：use strict 开头 + error handler 结尾 + userScript 缩进注入", () => {
    const out = buildWorkerScript(sampleScript);
    // PRE 边界：第一行 use strict（无前导换行）
    expect(out.startsWith('"use strict";\n')).toBe(true);
    // userScript 段：两空格缩进注入（AC-4 拼接语义）
    expect(out).toContain("\n  // sample exercising template features\n");
    // userScript 段结束后一个空行再接 auto-invoke 段（POST 首部换行语义）
    expect(out).toContain("ctx.agent(\"finalize\") };\n\n  // ── Auto-invoke execute() for module.exports pattern ──");
    // POST 边界：以 error handler 的 "});" 结尾（无尾随换行）
    expect(out.endsWith('_safePost({ type: "error", runId, error: err.message || String(err), workerLogs: _workerLogs }, "error");\n});')).toBe(true);
  });

  it("空 userScript 与任意脚本的拼接语义稳定（PRE/POST 不含 userScript 状态）", () => {
    const a = buildWorkerScript("x");
    const b = buildWorkerScript("y");
    // 除 userScript 段外完全一致：以 userScript 行为界切割比对
    const [preA] = a.split("\n  x\n");
    const [preB] = b.split("\n  y\n");
    expect(preA).toBe(preB);
  });

  it("A8 rfl 仪表透传字段字面量锚定（tier-1 §7.1）：live resolve 与缓存重放两对称点均含三字段", () => {
    const out = buildWorkerScript("// noop");
    // live resolve 分支（agent-result 消息处理）
    expect(out).toContain("usage: msg.result.usage,");
    expect(out).toContain("durationMs: msg.result.durationMs,");
    expect(out).toContain("sessionId: msg.result.sessionId,");
    // 缓存重放分支（_callCache 命中重建，对称点）
    expect(out).toContain("usage: cached.usage,");
    expect(out).toContain("durationMs: cached.durationMs,");
    expect(out).toContain("sessionId: cached.sessionId,");
  });
});

describe("buildWorkerScript — _KNOWN_FIELDS module scope 提升（IF6）", () => {
  const script = buildWorkerScript("// noop user script");

  it("生成源含 module 级 _KNOWN_FIELDS 声明（与 _workerLogs 同级，IIFE 外）", () => {
    // 声明在 IIFE 开始之前（module scope）：const _KNOWN_FIELDS 必须出现在 "(async () => {" 前
    const iifePos = script.indexOf("(async () => {");
    const knownPos = script.indexOf("const _KNOWN_FIELDS = new Set([");
    expect(knownPos).toBeGreaterThan(-1);
    expect(knownPos).toBeLessThan(iifePos);
    // 紧随 _workerLogs 声明之后（design IF6：与 _workerLogs/:62 同级）
    expect(script.indexOf("const _workerLogs = [];")).toBeLessThan(knownPos);
  });

  it("agent() 体内不再重建 Set（引用 _KNOWN_FIELDS，无 new Set）", () => {
    // agent() 函数体（到 parallel 声明前）内不得有 new Set 构造
    const agentPos = script.indexOf("async function agent(firstArg, secondArg)");
    const parallelPos = script.indexOf("async function parallel(calls)");
    expect(agentPos).toBeGreaterThan(-1);
    expect(parallelPos).toBeGreaterThan(agentPos);
    const agentBody = script.slice(agentPos, parallelPos);
    expect(agentBody).not.toContain("new Set(");
    expect(agentBody).toContain("_KNOWN_FIELDS.has(k)");
  });

  it("字段集合内容逐字段一致（18 known fields 不丢失——P4 增 engine，预算语义对齐增 maxTurns）", () => {
    expect(script).toContain(
      'const _KNOWN_FIELDS = new Set(["prompt", "description", "schema", "model", "scene", "label", "task", "agent", "phase", "skill", "timeoutMs", "maxTurns", "cwd", "fork", "worktree", "returnMeta", "thinkingLevel", "engine"]);',
    );
    // unknown-fields 警告文案不变（known 列表仍全量）
    expect(script).toMatch(/Known fields:.*returnMeta.*thinkingLevel.*engine/);
  });

  it("agent() 各分支均透传 maxTurns（预算语义对齐：脚本作者可显式传 turn 上限）", () => {
    // task/agent shortcut 分支：显式转发
    expect(script).toContain("maxTurns: firstArg.maxTurns,");
    // string+secondArg 分支：显式转发（?? 语义保真：显式 0 不被抹成 undefined，F-2/U5）
    expect(script).toContain(
      'maxTurns: (secondArg && typeof secondArg === "object" ? secondArg.maxTurns : undefined) ?? undefined,',
    );
    // opts = firstArg 直传分支无需处理（整对象透传）
  });

  // [F-2 maxTurns:0 吞没修复] 旧字符串分支 `&& maxTurns) || undefined` 把显式 0
  // 抹成 undefined → runSpawn 落 env 兜底（SPAWN_WATCHDOG env 设置时误挂 watchdog），
  // 与对象分支保真语义分裂。锁定生成源为 ?? 形态（0/null/undefined 区分处理）。
  it("string 分支 maxTurns 用 ?? 语义（显式 0 不抹成 undefined，F-2）", () => {
    const out = buildWorkerScript("// noop");
    expect(out).not.toContain('secondArg.maxTurns) || undefined');
    expect(out).toContain("?? undefined");
  });
});

// ══════ 来源: worker-script-builder-runtime.test.ts ══════

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
 * - module.exports.execute() 自动调用入口
 * - _safePost 的 DataCloneError 防御分支
 *
 * 这是回归防线：任何让 .then/.catch 访问不到 module-scope helper 的重构都会被这里抓住。
 */



// ── 判别联合：Worker → Main 消息类型（S3：用判别联合替代可选字段 + 非空断言）──

/** agent-call 消息：worker 请求主线程执行一个 agent。 */
interface AgentCallMsg {
  type: "agent-call";
  callId: number;
  opts: { prompt: string; description?: string; schema?: unknown; [k: string]: unknown };
  phase?: string;
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

// ── 类型检查：从 unknown 收窄到判别联合 ──
// 共享 hasType 辅助：避免每个检查重复 `(m as {type?:string})` 断言（taste/no-unsafe-catch）。

function hasType<T extends string>(m: unknown, type: T): boolean {
  return typeof m === "object" && m !== null
    && (m as { type: unknown }).type === type;
}

function isAgentCall(m: unknown): m is AgentCallMsg {
  return hasType(m, "agent-call");
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
}

/** workerLogs 条目检查收窄 + message 包含判定（元素类型 unknown，断言前先收窄）。 */
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

    const result: RunResult = { agentCalls: [], logMessages: [] };
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
    // running、无终态（runWorker 会 2s 超时 reject，即本测试修复前会红）。
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
  // 落 runSpawn 的 env 兜底（SPAWN_WATCHDOG env 设置时误挂 watchdog），与对象分支
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


describe("buildWorkerScript runtime — schema 出口契约（ADR-0092 保留项）", () => {
  // [ADR-0092] 带 schema 却既无 parsedOutput 也无显式 error = 结果出口断裂：
  // 对象形态是 schema 调用唯一合法结果，无文本回落选项——出口不得静默把正文
  // 文本当结果（脚本无感知）。违规出口 resolve 错误说明（returnMeta 走 error 字段）。

  it("带 schema + 无 parsedOutput + 无 error → resolve 错误说明（不静默回落正文文本）", async () => {
    const script = `
      const v = await agent({ prompt: "p", schema: { type: "object" } });
      return { got: v };
    `;
    const res = await runWorker(script, { agentResultObjects: [{ content: "plain prose" }] });
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({
      got: expect.stringMatching(/neither a parsed object nor an explicit error/),
    });
  });

  it("带 schema + returnMeta → error 字段带说明、value 同串（脚本可判错）", async () => {
    const script = `
      const r = await agent({ prompt: "p", schema: { type: "object" }, returnMeta: true });
      return r;
    `;
    const res = await runWorker(script, { agentResultObjects: [{ content: "plain prose" }] });
    expect(res.workerError).toBeUndefined();
    const ret = res.returnValue as { error?: string; value?: string };
    expect(ret.error).toMatch(/ADR-0092/);
    expect(ret.value).toMatch(/neither a parsed object nor an explicit error/);
  });

  it("无 schema + 无 parsedOutput → content 回落不变（容错策略不受影响）", async () => {
    const script = `
      const v = await agent({ prompt: "p" });
      return { got: v };
    `;
    const res = await runWorker(script, { agentResultObjects: [{ content: "plain prose" }] });
    expect(res.returnValue).toEqual({ got: "plain prose" });
  });

  it("带 schema + 显式 error → content 回落不变（失败 resolve 容错形态保留）", async () => {
    const script = `
      const v = await agent({ prompt: "p", schema: { type: "object" } });
      return { got: v };
    `;
    const res = await runWorker(script, {
      agentResultObjects: [{ content: "fallback text", error: "boom" }],
    });
    expect(res.returnValue).toEqual({ got: "fallback text" });
  });

  it("缓存命中路径同判：带 schema + 无 parsedOutput 无 error 的缓存结果 → 错误说明", async () => {
    const script = `
      const v = await agent({ prompt: "p", schema: { type: "object" } });
      return { got: v };
    `;
    // callCache 预填 = 重放命中（callId 0）；缓存条目无 parsedOutput 无 error。
    const res = await runWorker(script, {
      callCache: new Map([[0, { content: "cached prose" }]]),
    });
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({
      got: expect.stringMatching(/neither a parsed object nor an explicit error/),
    });
  });
});

// ══════ 来源: worker-pending-timeout-abort.test.ts ══════

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



// ── 判别联合（对齐 worker-script-builder-runtime.test.ts 的检查形态） ──

interface ReturnMsgLogged {
  type: "return";
  result: unknown;
  workerLogs?: Array<{ level: string; message: string }>;
}
interface ErrorMsgLogged {
  type: "error";
  error: string;
  workerLogs?: Array<{ level: string; message: string }>;
}

function isReturnMsg(m: unknown): m is ReturnMsgLogged {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "return";
}
function isErrorMsg(m: unknown): m is ErrorMsgLogged {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "error";
}
function isAgentCallMsg(m: unknown): m is { type: "agent-call"; callId: number } {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "agent-call";
}

// ── harness：主线程「不回话」的可控 Worker 运行器 ──────────────

interface PendingRunResult {
  returnValue?: unknown;
  errorMessage?: string;
  /** return/error 消息带回的 workerLogs（超时 warn 通路）。 */
  workerLogs: Array<{ level: string; message: string }>;
  exitCode?: number;
  workerError?: string;
  /** 收到的 agent-call 消息数（确认脚本确实发起了调用）。 */
  agentCallCount: number;
}

interface PendingRunOptions {
  /** 收到 agent-call 后的主线程动作（默认：不回话——pending 留在 worker 侧）。 */
  onAgentCall?: (msg: { callId: number; opts: Record<string, unknown> }, worker: Worker) => void;
  /** 显式 finish（供 abort 竞态场景手工收尾）。 */
  timeoutMs?: number;
}

const silentWorkers: Worker[] = [];

afterEach(() => {
  for (const w of silentWorkers.splice(0)) {
    w.terminate().catch(() => {});
  }
});

function runWorkerSilent(userScript: string, opts: PendingRunOptions = {}): Promise<PendingRunResult> {
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
    silentWorkers.push(worker);

    const result: PendingRunResult = { workerLogs: [], agentCallCount: 0 };
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
      if (isAgentCallMsg(raw)) {
        result.agentCallCount += 1;
        opts.onAgentCall?.(raw as unknown as { callId: number; opts: Record<string, unknown> }, worker);
        return;
      }
      if (isReturnMsg(raw)) {
        result.returnValue = raw.result;
        result.workerLogs = raw.workerLogs ?? [];
        graceTimer = setTimeout(finish, 150);
        return;
      }
      if (isErrorMsg(raw)) {
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
    const res = await runWorkerSilent(script);

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
    const res = await runWorkerSilent(script);

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
    const res = await runWorkerSilent(script);

    expect(res.errorMessage).toBeUndefined();
    expect(res.workerError).toBeUndefined();
    expect(res.returnValue).toEqual({ trimmed: true });
  });

  it("string+secondArg 分支：timeoutMs 透传到 agent-call 消息 opts（此前该分支丢弃该字段）", async () => {
    let seenOpts: Record<string, unknown> | undefined;
    const script = `await agent("with timeout", { timeoutMs: 1234, label: "probe" }); return "unreachable";`;
    await runWorkerSilent(script, {
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
    const res = await runWorkerSilent(script, {
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
      const res = await runWorkerSilent(script, {
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
    const res = await runWorkerSilent(script, { timeoutMs: 400 });

    expect(res.returnValue).toBe("returned early");
    expect(res.workerError).toBeUndefined();
  });

  it("fire-and-forget + timeoutMs：超时 resolve（非 reject）→ 无 worker error 事件", async () => {
    const script = `
      agent("orphan with timeout", { timeoutMs: 40 });
      return "returned before timeout";
    `;
    const res = await runWorkerSilent(script, { timeoutMs: 600 });

    // 超时以 resolve 收尾（容错策略）——即使无人消费该 promise 也不产 rejection
    expect(res.returnValue).toBe("returned before timeout");
    expect(res.workerError).toBeUndefined();
  });
});

// ══════ 来源: worker-returnmeta-passthrough.test.ts ══════

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



const USAGE = { input: 100, output: 50, cacheRead: 700, cacheWrite: 30, cost: 0.012, contextTokens: 850, turns: 3 };

const passthroughWorkers: Worker[] = [];

afterEach(() => {
  for (const w of passthroughWorkers.splice(0)) {
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
function runWorkerPassthrough(
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
    passthroughWorkers.push(worker);
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
    const outcome = await runWorkerPassthrough(META_SCRIPT, {
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
    const outcome = await runWorkerPassthrough(META_SCRIPT, {
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
    const outcome = await runWorkerPassthrough(META_SCRIPT, {
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
