---
name: workflow-script-format
description: >-
  Reference for writing workflow JS scripts. Auto-loaded when using workflow-generate
  or writing/editing workflow scripts for Pi. Covers runtime environment, injected
  globals, constraints, and script patterns. Not for general coding or subagent usage.
---

# Workflow Script Format Reference

## Runtime Environment

- Script runs inside an **async IIFE in a Worker thread**. Top-level await IS supported.
- **DO NOT use `import`/`export` (ESM) syntax**. Use `require()` for Node.js built-ins.
- The script's **`return` value IS captured** and sent back to the main thread.

### [MANDATORY] Do NOT wrap your script in another async IIFE

The worker already wraps your script in an async IIFE. If you add your own `(async function main() { ... })();` wrapper **without `await`**, the worker's outer IIFE resolves immediately (fire-and-forget), posts `return` to the main thread, and the main thread tears down the runtime — **killing any in-flight `agent()` subprocess via SIGKILL within ~2ms**.

```javascript
// ❌ WRONG: bare IIFE — outer worker IIFE doesn't await this, posts return immediately
(async function main() {
  const result = await agent({ prompt: 'analyze' });  // subprocess killed ~2ms after spawn
})();

// ✅ CORRECT: top-level await directly (the worker wraps this in its own async IIFE)
const result = await agent({ prompt: 'analyze' });

// ✅ ALSO OK: awaited IIFE (rarely needed — prefer top-level await)
await (async function main() {
  const result = await agent({ prompt: 'analyze' });
})();
```

This is enforced by `lintScript`:
- **error** (workflow refuses to run): bare IIFE as a standalone statement + contains agent/parallel/pipeline.
- **warning** (workflow runs, but flagged): IIFE assigned to a variable or returned from a function + contains agent/parallel/pipeline. Review whether the surrounding code actually awaits the Promise; if not, the same kill-on-spawn bug applies.

## Required: Meta Declaration

Every script MUST declare its metadata as a `/* @pi-meta */` YAML block comment at the top level — NOT a `const meta` variable:

```javascript
/* @pi-meta
name: workflow-name
description: One-line description of what the workflow does
phases: ['phase1', 'phase2']
*/
```

- `name` must match the filename stem. `phases` is for display only.
- Optional fields: `parameters` (JSON Schema for `$ARGS`) and `usage` (markdown).
- The YAML body starts on the line after `/* @pi-meta`; the closing `*/` must sit alone at column 0.
- `generate` round-trip-validates the YAML and reports line/col on error (common pitfall: patternProperties regex must use double backslash `\\d`, not `\d`).

> **Legacy `const meta = { ... }` (transition only):** `generate` still accepts a legacy top-level `const meta` during the transition window, but the core discovery chain does NOT recognize it (no legacy fallback) — such scripts stay invisible to discovery and get no metadata injection. Always use `/* @pi-meta */` for new scripts.

## [MANDATORY] Display: description + phase

TUI `/workflows` 视图按**运行时 `phase()` 调用**分组（非 `meta.phases`），每个 agent node 的显示名取自 `description`/`label`。缺这两者 → 所有 node 挤在 `(unnamed)` phase、显示为 unnamed agent。

### MUST 规则

1. **每个 `agent()` 必须传 `description`（必填，非可选）**。命名规范见下方 [`description` naming convention](#description-naming-convention-mandatory)（kebab-case、无 round 后缀）。
2. **每个含 agent 调用的逻辑段，必须在该段第一个 agent 调用前调 `phase('xxx')`**，且 `'xxx'` 出现在 `meta.phases` 字符串数组里。

### Minimal 示例（三者齐备）

```javascript
/* @pi-meta
name: review-fix
description: review then fix
phases: ['review', 'fix']
*/

phase('review');
const r = await agent({ prompt: 'review diff', description: 'review-diff' });

phase('fix');
await agent({ prompt: `apply fix: ${r}`, description: 'apply-fix' });
return { done: true };
```

### 反面教材 ❌

```javascript
// ❌ agent() 无 description → TUI 显示 unnamed agent
await agent({ prompt: 'review diff' });

// ❌ phases 用对象数组 → 引擎忽略，全部归入 (unnamed)
/* @pi-meta
name: x
phases: [{ title: 'review' }, { title: 'fix' }]
*/

// ❌ 声明了 phases 但从不 phase() 调用 → 运行时分组失效
/* @pi-meta
name: x
phases: ['review', 'fix']
*/
// ... 直接 await agent(...) 从不调 phase('review') / phase('fix')
```

以上三项由 `lintScript` 静态检查（warning 级），详见 `script-lint.ts` 的 `checkAgentDescription` / `checkMetaPhases` / `checkPhaseConsistency`。

## Injected Globals (pre-defined, do NOT redeclare)

### `agent(...)` — Call an AI agent

支持三种签名：
- `agent(promptString)` — 最简，prompt 字符串，返回 content 字符串
- `agent(promptString, { label?, schema?, ... })` — 字符串 + opts（`label` 是 `description` 的别名）
- `agent({ prompt, schema?, description?, agent?, skill?, timeoutMs?, model?, scene?, thinkingLevel? })` — 完整 opts 对象
  - `thinkingLevel?` (`string`) — 思考强度，合法值 `off | minimal | low | medium | high | xhigh`，透传至 pi CLI 拼接为 `--model provider/modelId:thinkingLevel`（与 `model?` 同效，影响子 agent 推理预算）

Returns `parsedOutput` (structured data when schema provided) or `content` (string).

**[MANDATORY] Structured output rule:** When you need JSON/structured data from an agent, you MUST pass `schema`. The `schema` parameter triggers a tool-call mechanism where the LLM calls a `structured-output` tool to return validated JSON — this is reliable. NEVER ask the agent to "output JSON in a code block" or use regex to extract JSON from text.

```javascript
// ✅ CORRECT: use schema parameter — returns parsed JS object directly
const result = await agent({
  prompt: 'Analyze this code and rate it',
  schema: {
    type: 'object',
    properties: {
      score: { type: 'number' },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['score'],
  },
  description: 'code-analysis',
});
// result is already a parsed object: { score: 8, issues: [...] }
```

```javascript
// ❌ WRONG: prompt-based JSON extraction — fragile, LLM often wraps in markdown
const result = await agent({ prompt: 'Analyze code. Output JSON: { "score": N }' });
// result is a string, you'd need regex to extract — DON'T do this
```

### `parallel(calls)` — Run multiple agent calls concurrently

```javascript
const [r1, r2, r3] = await parallel([
  agent({ prompt: 'Review file A', description: 'review-a' }),
  agent({ prompt: 'Review file B', description: 'review-b' }),
  agent({ prompt: 'Review file C', description: 'review-c' }),
]);
```

并发默认上限 6（ConcurrencyPool 限流，`maxConcurrent=6` 来源 ADR-030 决策 3），超出自动排队。元素也可以是返回 Promise 的函数，会被直接调用：

### `pipeline(...)` — Execute stages sequentially

**模式一：顺序模式** — 传入 stage 数组，每个 stage 收到上一个 stage 的结果：

```javascript
const final = await pipeline([
  () => agent({ prompt: 'Analyze code', description: 'analyze' }),
  (prev) => agent({ prompt: `Write tests for: ${prev}`, description: 'test-gen' }),
]);
```

**模式二：笛卡尔积模式** — 传入 items 数组 + 多个 stage，对每个 item 依次跑完所有 stage（批处理杀手锏）：

```javascript
// 对每个 file 依次跑 review → fix
await pipeline(
  files,                                      // items
  (file) => agent({ prompt: `Review ${file}`, description: 'review', schema: {...} }),
  (review, file) => agent({ prompt: `Fix ${file}: ${JSON.stringify(review)}`, description: 'fix' }),
);
// stage 函数签名：(prevResult, currentItem) => result；第一个 stage 只收 currentItem
```

### `workflow(name, args?)` — Call another workflow (nested orchestration)

调用已定义的子 workflow（by name），实现 workflow 嵌套编排（顺序 chain / 并行 parallel / scatter-gather / map-reduce）。被调用的 workflow 必须已通过 `workflow-script save` 或放在 `.pi/workflows/` / `~/.pi/agent/workflows/` 可被发现。

**签名**：`workflow(name: string, args?: object) => Promise<AgentResult>`

**参数**：
- `name` — 目标 workflow 的名称（`meta.name`，即文件名 stem）
- `args` — 传给子 workflow 的参数对象，子 workflow 内通过 `$ARGS` 读取

**返回值**：`AgentResult`，与 `agent()` 返回结构同构：
- `content: string` — 子 workflow 的 return 值（字符串化）
- `parsedOutput?: unknown` — 子 workflow return 的对象（当 return 是对象时）
- `usage?: {...}` — token 消耗
- `error?: string` — 失败原因（成功时无此字段）

**嵌套配额**：`workflow()` 调用走同一 ConcurrencyPool，按 depth 分层分配配额（`max(1, 6 - depth)`，保底 1 槽防饿死）。`parallel()` 内的 `workflow()` 调用共享父 workflow 的配额池，超出自动排队（不报错）。嵌套深度受 `MAX_FORK_DEPTH` 护栏保护（见 ADR-030 决策 3）。

**返回值**：`workflow()` 返回 `AgentResult` 对象（与 `agent()` 一致）：
- 成功：`{ content: string, parsedOutput?: object }`——content 是子 workflow execute() 返回值的 JSON 字符串；parsedOutput 是返回值为对象时的原样回传
- 失败：`{ content: "", error: string }`——子 workflow 未找到/lint 失败/执行异常/被 abort

**循环检测**：`workflow()` 自动追踪调用链（A→B→C），如果目标 name 已在当前调用链中（如 A→B→A），立即返回 error result（`Circular workflow call detected: A → B → A`），不执行子 workflow。

**预算继承**：子 workflow 的 token 预算继承父 workflow 的剩余预算。子 workflow 消耗的 tokens/cost 执行后累加回父 workflow 的预算池。父 workflow abort 时子 workflow 级联 abort。

**chain 基础示例**（顺序：每步输出作下步输入）：
```javascript
const a = await workflow("extract", { source: inputPath });
const b = await workflow("transform", { raw: a.content });
const c = await workflow("load", { normalized: b.content });
```

**parallel 基础示例**（并行：多个独立子 workflow 同时跑）：
```javascript
const results = await parallel(
  tasks.map((t) => workflow(t, { target }))
);
```

> 内置通用编排 workflow（chain / parallel / scatter-gather / map-reduce / review-fix-loop，可直接 `workflow run`，用 `agent()` 自包含实现）见 `extensions/universal/subagent-workflow/workflows/`。本段教 `workflow()` 嵌套 API，workflows 目录是开箱即用的通用编排工具（用 `agent()` 而非 `workflow()` 嵌套）。

### Other globals

- `$ARGS` — Object with workflow arguments (from `--args key=val`)
- `$WORKSPACE` — Absolute path to the project workspace root
- `$BUDGET` — Budget info（getter + 方法，**不是**扁平字段）：
  - `$BUDGET.total` — token 预算上限（未设预算时为 0）
  - `$BUDGET.spent()` — 已用 token
  - `$BUDGET.remaining()` — 剩余 token（最小为 0）
  - 例：`if ($BUDGET.remaining() < 5000) { phase('wrap-up'); }`
- `phase(name)` — 设置当前阶段名，影响 TUI 分组显示。`meta.phases` 只是声明，TUI 实际分组靠运行时 `phase()` 调用或 agent opts 的 `phase` 字段
- `log(msg)` — 输出诊断信息（收集到 workerLogs，失败时附在错误消息里，不泄漏到主进程 stderr）
- `module.exports = { meta, execute }` — 脚本可导出 `execute({ agent, parallel, pipeline, phase, log, $ARGS, $WORKSPACE, $BUDGET })`，运行时会自动调用（兼容 Claude Code 写法）

### `description` naming convention [MANDATORY]

`description` 用作 TUI 显示的 agent 标识，必须简短可读。规则：kebab-case，单词间用 `-` 分隔，不含 round/iteration 后缀。

```javascript
// ✅ CORRECT: kebab-case，单词间用 - 分隔
agent({ prompt: '...', description: 'review-business-logic' });
agent({ prompt: '...', description: 'fix-imports' });
agent({ prompt: '...', description: 'parse-must-fix' });

// ❌ WRONG: 无分隔符拼接（不可读）
agent({ prompt: '...', description: 'reviewbusinesslogic' });
agent({ prompt: '...', description: 'fiximports' });

// ❌ WRONG: 冗长描述（不是 label 用途）
agent({ prompt: '...', description: 'Review business logic against spec requirements' });

// ❌ WRONG: 不必要的 round/iteration 后缀（TUI 自带序号）
agent({ prompt: '...', description: 'review-business-logic-round-1' });
// ✅ CORRECT: 去掉 round 后缀
agent({ prompt: '...', description: 'review-business-logic' });
```

## Constraints

- `agent()` calls **must be deterministic in order** for crash-retry replay to work correctly. 根因：调用结果按单调递增的 callId（从 0 起、按调用顺序）缓存。Runs are one-shot（无 pause/resume——提前停止用 abort，要新结果重新 run）；worker 基础设施错误自动重试 ≤3 次，重试时已完成调用按 callId 重放缓存结果不重跑。`parallel()` 内的调用顺序不能随机，否则重放会错位命中旧结果。注意：无 script hash 校验，重试重放的是缓存结果，开发期改脚本应重新 run。
- `parallel()` 并发默认上限 6（ConcurrencyPool，超出自动排队；来源 ADR-030 决策 3）。
- Throwing an error aborts the workflow (after retries).
- Use `require()` for Node.js built-ins: `const fs = require('node:fs');`

## Complete Example

```javascript
/* @pi-meta
name: review-fix-loop
description: "Loop: review → fix → commit until clean"
phases: ['review-fix']
*/

const MAX_ROUNDS = 10;
let round = 0;

while (round < MAX_ROUNDS) {
  round++;
  const result = await agent({
    prompt: `Round ${round}: Review git diff main...HEAD. Fix all issues. Commit with: fix: review round ${round}.`,
    schema: {
      type: 'object',
      properties: {
        mustFix: { type: 'number', description: 'Number of MUST-fix issues found' },
        suggestions: { type: 'number', description: 'Number of suggestions' },
        summary: { type: 'string' },
      },
      required: ['mustFix'],
    },
    description: 'review',
  });

  // result is already a parsed object thanks to schema
  if (result.mustFix === 0) break;
}

return { rounds: round, clean: true };
```

## Script Size Guideline

Keep scripts under **100 lines**. Scripts are orchestration glue, not business logic.
If a script exceeds 100 lines, split into multiple smaller workflow scripts.

## Verification Patterns

Workflow nodes should be **verifiable** — every critical execution path needs a check that the AI's output is correct. Two patterns are supported:

### Pattern A: Node-Internal Verification

Embed self-check instructions directly in the prompt and require a structured output that includes validation. Best for: trivial classification, single-step lookups, format checks.

```javascript
// Example: classify severity of a code review finding
const result = await agent({
  prompt: `Classify the severity of this finding: "${findingText}".
The selfCheck field MUST reflect whether severity and reason are both present and consistent.`,
  schema: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string' },
      selfCheck: { type: 'object', properties: { valid: { type: 'boolean' }, reason: { type: 'string' } } },
    },
    required: ['severity', 'reason', 'selfCheck'],
  },
  description: 'classify-severity',
});

if (!result.selfCheck.valid) {
  throw new Error(`self-check failed: ${result.selfCheck.reason}`);
}
```

**Pros:** Single call, low overhead. **Cons:** Self-check is part of the same call — AI can lie about validation.

### Pattern B: Follow-up Verify Node

A second `agent()` call that explicitly verifies the previous result. Best for: critical mutations, data transforms, anything where errors propagate downstream.

```javascript
// Example: review a file, then verify the review is complete
const review = await agent({
  prompt: `Review ${file} for issues. Report each finding with severity and reason.`,
  schema: {
    type: 'object',
    properties: {
      findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, reason: { type: 'string' } } } } },
    },
    required: ['findings'],
  },
  description: 'review',
});

const verify = await agent({
  prompt: `You are verifying a code review. The previous output was:
${JSON.stringify(review)}
Did the review cover: (1) all functions in the file, (2) at least 3 potential issues, (3) severity rating for each?`,
  schema: {
    type: 'object',
    properties: {
      valid: { type: 'boolean' },
      missingItems: { type: 'array', items: { type: 'string' } },
    },
    required: ['valid'],
  },
  description: 'verify-review',
});

if (!verify.valid) {
  throw new Error(`verification failed for ${file}: ${verify.missingItems.join(', ')}`);
}
```

**Pros:** Independent check, harder to game. **Cons:** Doubles agent calls.

### Decision Tree

```
Is the step a critical data transform or mutation?
├─ YES → Use Pattern B (follow-up verify)
└─ NO
   ├─ Trivial classification / format check?
   │  └─ YES → Use Pattern A (node-internal)
   └─ Read-only / informational?
      └─ No verification needed
```

### Anti-pattern

- **Never skip verification entirely on critical execution paths** — even with strong prompts, AI outputs are probabilistic. A verify step catches hallucinations before they propagate.
