# 子代理扩展开发指南（子代理专项模式）

> **迁移说明**：本文档迁移自 `docs/extensions/development-guide.md` §16-21、§23-24（2026-09-13）。编号已重排为连续 1-8（原 §16→1、§17→2、§18→3、§19→4、§20→5、§21→6、§23→7、§24→8）。
>
> 适用对象：会 spawn / manage 子 Pi 进程的扩展（即子代理类扩展）。通用 Tool/Command 型扩展只需关注 [development-guide.md](../../../../docs/extensions/development-guide.md) 的 🔵 通用章节；本文档是进阶模式参考。核心规范红线（入口/Tool/事件/状态/配置/日志/错误处理等）仍以 development-guide.md 为权威。

---

## 目录

- [1. 子进程保护入口模式](#1-子进程保护入口模式)
- [2. Agent 定义系统（Markdown + YAML Frontmatter）](#2-agent-定义系统markdown--yaml-frontmatter)
- [3. 子进程执行模式](#3-子进程执行模式)
- [4. 后台异步执行系统](#4-后台异步执行系统)
- [5. Chain / Pipeline 执行](#5-chain--pipeline-执行)
- [6. 跨会话通信（Intercom）](#6-跨会话通信intercom)
- [7. Acceptance Gates（验收门控）](#7-acceptance-gates验收门控)
- [8. Git Worktree 隔离](#8-git-worktree-隔离)

---

## 1. 子进程保护入口模式

当扩展会 spawn 子 Pi 进程时，扩展会被**同一个包**在子进程中也加载一次。必须在子进程中跳过父级完整注册，通过环境变量区分角色。

```typescript
// pi-subagents 的实际做法：在子进程中跳过父级扩展
export default function registerSubagentExtension(pi: ExtensionAPI): void {
  // 如果当前进程是子代理进程，则跳过完整注册
  if (process.env[SUBAGENT_CHILD_ENV] === "1") {
    if (process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1") {
      registerFanoutChildSubagentExtension(pi);  // 仅注册子级受限工具
    }
    return;
  }

  // ... 正常父级注册
}
```

**设计含义**：扩展必须考虑它在子进程中被加载的场景，通过环境变量区分角色。（标准入口与工厂函数签名见 [development-guide.md §2.1](../../../../docs/extensions/development-guide.md#21-工厂函数签名-)。）

---

## 2. Agent 定义系统（Markdown + YAML Frontmatter）

多 agent 配置场景使用。

### 2.1 Agent 文件格式

```markdown
---
name: reviewer
description: Code review specialist for diffs, plans, and codebase health
tools: read, grep, find, ls, bash, edit, write, intercom
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultReads: plan.md, progress.md
output: context.md
defaultProgress: true
maxSubagentDepth: 1
completionGuard: false
---

You are a disciplined review subagent. Your job is to inspect,
evaluate, and report findings with evidence.

## Working rules
- Read plan and relevant files first
- Use `bash` only for read-only inspection
- Do not invent issues, only report from evidence
- Prefer small corrective edits over broad rewrites
```

### 2.2 Frontmatter 字段参考

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | Agent 运行时名称（唯一标识） |
| `package` | string? | 可选包名，运行时为 `package.name` |
| `description` | string | 简短描述（list 时展示） |
| `tools` | string | 逗号分隔的工具白名单；`mcp:xxx` 选择 MCP 直接工具 |
| `extensions` | string? | 省略=全部，空=无，逗号=白名单 |
| `model` | string? | 默认模型 |
| `fallbackModels` | string? | 备选模型（逗号分隔） |
| `thinking` | string? | 思考级别：off/minimal/low/medium/high/xhigh |
| `systemPromptMode` | replace/append | `replace` 完全替换系统提示；`append` 追加到 Pi 基础提示 |
| `inheritProjectContext` | bool | 是否继承项目指令（AGENTS.md 等） |
| `inheritSkills` | bool | 是否继承 Skills 目录 |
| `defaultContext` | fresh/fork | 启动时默认的上下文模式 |
| `skills` | string? | 注入的 Skills（逗号分隔） |
| `output` | string? | 默认输出文件 |
| `defaultReads` | string? | 执行前默认读取的文件 |
| `defaultProgress` | bool | 是否维护 progress.md |
| `completionGuard` | bool | 实现完成守卫（bash 类工具设 false） |
| `maxSubagentDepth` | number | 子级嵌套深度限制 |
| `interactive` | bool | 交互模式标记（v1 不强制） |

### 2.3 Agent 发现机制

```
优先级（低→高）：Builtin → User → Project

Builtin: ~/.pi/agent/extensions/subagent/agents/
User:    ~/.pi/agent/agents/**/*.md
Project: .pi/agents/**/*.md

项目名冲突时 Project 胜出
可通过 agentScope: "user" | "project" | "both" 控制
```

### 2.4 Agent 覆盖（不复制整个文件）

```jsonc
// ~/.pi/agent/settings.json 或 .pi/settings.json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"],
        "inheritProjectContext": false
      }
    }
  }
}
```

---

## 3. 子进程执行模式

### 3.1 Pi 子进程架构

```
父进程 (Pi 主会话)
  └── 注册 subagent 工具
  └── LLM 调用 subagent({ agent: "worker", task: "..." })
  └── 扩展通过 child_process.spawn 启动子 Pi 进程
       └── 子进程 (Pi child session)
            └── 加载相同的扩展
            └── 环境变量标记：SUBAGENT_CHILD_ENV=1
            └── 扩展检测到子进程模式 → 仅注册受限工具
            └── 接收任务，独立执行
            └── 结果通过文件系统（JSONL）传递回父进程
```

### 3.2 子进程启动参数构建

```typescript
// 参考 pi-subagents 的 buildPiArgs
function buildChildArgs(config: {
  agent: AgentConfig;
  task: string;
  sessionFile?: string;
  modelOverride?: string;
  tools?: string[];
  cwd: string;
}): string[] {
  const args: string[] = [];

  if (config.sessionFile) {
    args.push("--session", config.sessionFile);
  }

  if (config.modelOverride) {
    // 必须先经 assertCanonicalModelRef 全等裁决再拼 --model（packages/subagent-core/src/shared/model-ref.ts）
    const canonical = assertCanonicalModelRef(config.modelOverride);
    args.push("--model", canonical);
  }

  if (config.tools?.length) {
    args.push("--tools", config.tools.join(","));
  }

  args.push("--cwd", config.cwd);

  // 子代理环境标记
  args.push("--env", `${SUBAGENT_CHILD_ENV}=1`);

  return args;
}
```

> **为何禁止裸拼 `--model`**：pi CLI 的 `--model` 是 pattern 非精确 ID（toLowerCase / contains 模糊匹配），「扩展层校验通过」不代表「子进程按此名执行」——裸拼曾致静默换模 429（2026-08-27 事故 A 根因 F1），且白名单外的 `"--model"` 字面量会被 `.githooks/check_subagent_channels.py`（pre-commit + CI）拦截。规则全文见 [extension-conventions.md](../../../../docs/extensions/extension-conventions.md)「模型引用解析 [MANDATORY]」。

### 3.3 执行与结果收集

```typescript
function runSync(options: RunSyncOptions): SingleResult {
  const child = spawn(piCommand, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      [SUBAGENT_CHILD_ENV]: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // JSONL 事件流解析
  const writer = createJsonlWriter(child.stdout);

  // 实时进度提取
  child.stdout.on("data", (data) => {
    for (const event of parseJsonlEvents(data)) {
      updateProgress(progress, event);
      options.onProgress?.(progress);
    }
  });

  // 等待完成
  return new Promise((resolve) => {
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        output: collectOutput(),
        usage: collectUsage(),
        messages: collectMessages(),
      });
    });
  });
}
```

---

## 4. 后台异步执行系统

### 4.1 异步任务追踪

```typescript
interface AsyncJobTracker {
  ensurePoller: () => void;
  handleStarted: (event: AsyncStartedEvent) => void;
  handleComplete: (event: AsyncCompleteEvent) => void;
  resetJobs: (ctx: ExtensionContext) => void;
}

function createAsyncJobTracker(
  pi: ExtensionAPI,
  state: ExtensionState,
  asyncDir: string
): AsyncJobTracker {
  return {
    ensurePoller() {
      if (state.poller) return;
      state.poller = setInterval(() => {
        for (const job of state.asyncJobs.values()) {
          refreshJobStatus(job, asyncDir);
        }
      }, 2000);
    },

    handleStarted(event) {
      state.asyncJobs.set(event.runId, {
        asyncId: event.runId,
        asyncDir: event.asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
    },

    handleComplete(event) {
      const job = state.asyncJobs.get(event.runId);
      if (job) {
        job.status = "completed";
        job.updatedAt = Date.now();
      }
    },

    resetJobs(ctx) {
      state.asyncJobs.clear();
    }
  };
}
```

### 4.2 文件系统结果观察器

```typescript
function createResultWatcher(pi, state, resultsDir, intervalMs) {
  let watcher: FSWatcher | null = null;

  function startResultWatcher() {
    if (!existsSync(resultsDir)) return;
    watcher = fs.watch(resultsDir, { recursive: true }, (eventType, filename) => {
      if (filename?.endsWith(".json")) {
        const result = readResultFile(path.join(resultsDir, filename));
        if (result && !state.completionSeen.has(result.runId)) {
          state.completionSeen.set(result.runId, true);
          pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, result);
        }
      }
    });
  }

  function primeExistingResults() {
    // 启动时扫描已有结果文件，避免错过热重载期间完成的结果
  }

  function stopResultWatcher() {
    watcher?.close();
    watcher = null;
  }

  return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
```

### 4.3 异步状态文件格式

```
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json          # 运行状态（running/completed/failed）
  events.jsonl         # 包装事件 + 子 Pi JSON 事件
  output-<n>.log       # 实时人类可读日志
  subagent-log-<id>.md # Markdown 格式日志
```

> 后台任务的**结果语义通知**（完成/终态投递）必须走确认式送达——持久账本 + notifyId 幂等 + settled 边沿 courier，禁依赖 steer/followUp/nextTurn 内存队列的 at-most-once 通道（约束 C-ext-19，设计见 [pi-boundary-reliability.md](../../../../docs/design/pi-boundary-reliability.md)）。

---

## 5. Chain / Pipeline 执行

多步骤工作流编排。

### 5.1 Chain 定义

```typescript
// 三种链式步骤类型
type ChainStep =
  | SequentialStep          // { agent, task }
  | ParallelStep            // { parallel: [...] }
  | DynamicParallelStep;    // { expand, parallel, collect }

interface SequentialStep {
  agent: string;
  task?: string;            // 支持 {task}, {previous}, {chain_dir}, {outputs.name} 模板变量
  output?: string;
  reads?: string[];
  as?: string;              // 命名输出，后续步骤通过 {outputs.name} 引用
  model?: string;
  phase?: string;           // 分组标签
  label?: string;           // 人类可读标签
}
```

### 5.2 Chain 执行流程

```
Step 1: scout "Analyze auth"
  → 输出写入 chain_dir/context.md
  → 文本传递给 Step 2 的 {previous}

Step 2: planner "Plan based on {previous}"
  → 读取 chain_dir/context.md
  → 输出传递给 Step 3

Step 3: { parallel: [worker "实现 A", worker "实现 B"] }
  → 两个 worker 并发执行
  → 结果聚合后传递给 Step 4

Step 4: reviewer "Review {previous}"
  → 最终输出
```

### 5.3 动态扇出（Dynamic Fanout）

```typescript
// 从结构化输出发散
{
  chain: [
    {
      agent: "scout",
      task: "返回结构化目标列表",
      as: "targets",
      outputSchema: { type: "object", properties: { items: { type: "array" } } }
    },
    {
      expand: { from: { output: "targets", path: "/items" }, maxItems: 12 },
      parallel: { agent: "reviewer", task: "Review {target.path}" },
      collect: { as: "reviews" },
      concurrency: 4
    },
    {
      agent: "worker",
      task: "综合修复 {outputs.reviews}"
    }
  ]
}
```

### 5.4 Chain 文件格式

`.chain.md` —— 简单顺序链：

```markdown
---
name: scout-planner
description: Gather context then plan
---

## scout
phase: Context
output: context.md

Analyze the codebase for {task}

## planner
phase: Planning
reads: context.md

Create a plan based on {outputs.context}
```

`.chain.json` —— 支持动态扇出。

---

## 6. 跨会话通信（Intercom）

父↔子跨进程通信。

### 6.1 Intercom Bridge 模式

```typescript
interface IntercomBridgeState {
  active: boolean;
  orchestratorTarget?: string;    // 父会话目标
  instructionFile?: string;       // 自定义桥接指令
}

function resolveIntercomBridge(input: {
  config?: IntercomBridgeConfig;
  context?: "fresh" | "fork";
  orchestratorTarget?: string;
  cwd: string;
}): IntercomBridgeState {
  return {
    active: isIntercomAvailable(input.cwd) && !!input.orchestratorTarget,
    orchestratorTarget: input.orchestratorTarget,
  };
}
```

### 6.2 子→父通信

```typescript
// 子代理使用 contact_supervisor 工具
// reason: "need_decision" —— 阻塞型决策请求
// reason: "progress_update" —— 非阻塞进度更新

// 父端监听
pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
  deliverIntercomMessage(payload);
});
```

### 6.3 结果投递

```typescript
async function deliverSubagentResultIntercomEvent(
  eventBus: IntercomEventBus,
  payload: SubagentResultIntercomPayload
): Promise<boolean> {
  // 通过 intercom 事件总线投递分组结果
  eventBus.emit("intercom:send", {
    to: payload.to,
    message: payload.message,
    source: "subagent-result",
  });
  return true;
}
```

> 结果语义的跨会话投递同样受 C-ext-19 确认式送达约束（账本 + 幂等键 + courier，见 [pi-boundary-reliability.md](../../../../docs/design/pi-boundary-reliability.md)）。

---

## 7. Acceptance Gates（验收门控）

多 agent 质量门控。

### 7.1 验收级别

| 级别 | 说明 |
|------|------|
| `auto` | 自动推断（默认） |
| `none` | 无验收 |
| `attested` | 子代理返回结构化验收报告 |
| `checked` | 运行时结构性检查通过 |
| `verified` | 配置的运行时验证命令通过 |
| `reviewed` | 独立 reviewer 结果存在 |

### 7.2 使用模式

```typescript
{
  agent: "worker",
  task: "Implement the fix",
  acceptance: {
    level: "verified",
    criteria: ["修复不扩大范围"],
    evidence: ["changed-files", "tests-added", "commands-run", "no-staged-files"],
    verify: [
      { id: "tests", command: "npm test", timeoutMs: 120000 }
    ]
  }
}
```

---

## 8. Git Worktree 隔离

并行任务文件系统隔离。

```typescript
// 为并行任务创建隔离的 git worktree
{ tasks: [...], worktree: true }

// 要求：
// - 必须在 git 仓库内
// - 工作树必须干净
// - 自动 symlink node_modules
// - 完成后自动清理 worktree 和临时分支

// 自定义 worktree 设置钩子
// config.json:
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```
