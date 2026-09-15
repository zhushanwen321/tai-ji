/**
 * buildWorkerScript — workflow() 全局函数注入测试。
 *
 * 验证生成的 worker 源码字符串包含 workflow 嵌套调用所需的全部契约：
 * - workflow() 全局函数声明
 * - workflow-call 消息（Worker → Main）
 * - workflow-result 消息处理（Main → Worker）
 * - execute() context 包含 workflow
 * - name 参数校验
 */
import { describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";

describe("buildWorkerScript — workflow() global injection", () => {
  const script = buildWorkerScript("// noop user script");

  it("injects workflow() global function", () => {
    expect(script).toContain("async function workflow");
  });

  it('workflow() sends workflow-call message', () => {
    expect(script).toContain('type: "workflow-call"');
  });

  it('handles workflow-result message', () => {
    // worker 是 workflow-result 的接收方，用条件分支处理（非对象字面量）
    expect(script).toContain('msg.type === "workflow-result"');
  });

  it("execute() context includes workflow", () => {
    expect(script).toContain(
      "module.exports.execute({ agent, parallel, pipeline, phase, log, workflow, $ARGS, $WORKSPACE, $BUDGET })",
    );
  });

  it("workflow() validates name argument", () => {
    expect(script).toContain(
      "workflow() requires a workflow name string as first argument",
    );
  });
});

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

  describe("workflow() uses _safePost", () => {
    it("workflow-call postMessage guarded by _safePost", () => {
      expect(script).toContain("_safePost({ type: \"workflow-call\"");
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

    it("cartesian mode logs stage errors instead of silent swallow", () => {
      expect(script).toContain("[pipeline cartesian stage failed");
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
      expect(handlerBlock![0]).toContain("error: msg.result.error");
    });

    it("fallback resolve single value uses msg.result.parsedOutput ?? msg.result.content", () => {
      expect(script).toContain(
        "const _value = msg.result.parsedOutput ?? msg.result.content;",
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
      expect(cacheBlock![0]).toContain("error: cached.error");
    });

    it("cache replay fallback uses cached.parsedOutput ?? cached.content", () => {
      expect(script).toContain(
        "const _cachedValue = cached.parsedOutput ?? cached.content;",
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

