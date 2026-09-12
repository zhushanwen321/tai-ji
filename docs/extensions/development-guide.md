# Pi Extension 开发指南

> **文档来源说明**：本文档由原 `docs/extensions/standards.md`（Pi Extension 开发规范，规范红线视角）与 `docs/extensions/research/pi-extension-production-guide.md`（Pi Extension 生产级开发指南，完整模式范例视角）合并而成，是 Pi Extension 开发的单一权威源。
>
> 配套文档（冲突时以下列文档为准，本文档相应章节为其摘要）：强约束红线清单见 [extension-conventions.md](./extension-conventions.md)；日志现行口径（三层通道，禁裸 `console.*`）见 [logging-conventions.md](./logging-conventions.md)。本文档所载约束登记于 [docs/constraints.json](../constraints.json)（架构约束登记 SSOT）。
>
> 合并策略：以「规范红线」为骨架（第一部分，必须遵守的硬约束），以「完整模式范例」为血肉（第二部分，生产级扩展的进阶模式）。重叠主题（Tool 注册、事件生命周期、入口模式、项目结构）已融合去重，不再分两处讲述。
>
> 最后更新：2026-08-22

---

## 术语约定

### 分类标签（遵守强度）

| 分类标签 | 含义 | 遵守强度 |
|---------|------|---------|
| **[规范]** | 必须遵守的规则。违反会导致代码审查不通过或有运行时风险 | 必须 |
| **[MANDATORY]** | [规范] 的强化形式，违反会直接导致运行时崩溃 | 必须 |
| **[指南]** | 推荐做法。不遵守不视为违规但应有合理理由 | 推荐 |

### 适用层级图例

本指南区分两种层级的模式：**通用模式**（所有 Pi extension 适用）和 **子代理专项模式**（仅 spawn/manage 子进程的扩展适用）。

| 图例 | 含义 |
|------|------|
| 🔵 通用 | 所有 Pi extension 适用 |
| 🟠 子代理专项 | 仅 spawn/manage 子 Pi 进程的复杂扩展适用（进阶，子代理扩展才需要） |

> 对于简单的 Tool/Command 型扩展（如 `pi-todo`），只需关注 🔵 标记的章节即可。

---

## 目录

- [第一部分：核心规范（红线，必须遵守）](#第一部分核心规范红线必须遵守)
  - [1. 包结构与项目架构](#1-包结构与项目架构规范)
  - [2. 入口与工厂模式](#2-入口与工厂模式规范)
  - [3. 模块职责划分](#3-模块职责划分规范)
  - [4. Tool 注册与设计](#4-tool-注册与设计规范)
  - [5. Command 注册](#5-command-注册规范)
  - [6. 事件生命周期管理](#6-事件生命周期管理规范)
  - [7. 状态与会话管理](#7-状态与会话管理规范)
  - [8. 配置管理](#8-配置管理规范)
  - [9. 依赖管理](#9-依赖管理规范)
  - [10. 日志与诊断输出](#10-日志与诊断输出规范)
  - [11. 错误处理与弹性模式](#11-错误处理与弹性模式规范)
  - [12. 类型安全](#12-类型安全规范)
  - [13. 路径与配置硬编码](#13-路径与配置硬编码规范)
  - [14. 健壮性基础要求](#14-健壮性基础要求规范)
- [第二部分：进阶模式（完整范例）](#第二部分进阶模式完整范例)
  - [15. 系统概述与架构蓝图](#15-系统概述与架构蓝图)
  - [16. 子进程保护入口模式](#16-子进程保护入口模式子代理专项)
  - [17. Agent 定义系统（Markdown + YAML Frontmatter）](#17-agent-定义系统markdown--yaml-frontmatter子代理专项)
  - [18. 子进程执行模式](#18-子进程执行模式子代理专项)
  - [19. 后台异步执行系统](#19-后台异步执行系统子代理专项)
  - [20. Chain / Pipeline 执行](#20-chain--pipeline-执行子代理专项)
  - [21. 跨会话通信（Intercom）](#21-跨会话通信intercom子代理专项)
  - [22. TUI 渲染系统](#22-tui-渲染系统)
  - [23. Acceptance Gates（验收门控）](#23-acceptance-gates验收门控子代理专项)
  - [24. Git Worktree 隔离](#24-git-worktree-隔离子代理专项)
  - [25. 测试与 CI/CD](#25-测试与-cicd)
- [第三部分：附录](#第三部分附录)
  - [A. 模块组织指南（按规模）](#a-模块组织指南按规模指南)
  - [B. 性能指南](#b-性能指南指南)
  - [C. 反模式清单](#c-反模式清单)
  - [D. 新扩展检查清单](#d-新扩展检查清单)
  - [E. 术语表](#e-术语表)
  - [F. 参考仓库列表](#f-参考仓库列表)

---

# 第一部分：核心规范（红线，必须遵守）

> 本部分来自规范红线视角。所有 [规范]/[MANDATORY] 标记都是硬约束，违反会导致代码审查不通过或运行时崩溃。

## 1. 包结构与项目架构 **[规范]**

### 1.1 npm 包名与目录分组

npm 包名格式：

```
@scope/pi-<name>
```

示例：`@zhushanwen/pi-goal`、`@zhushanwen/pi-todo`

仓库内源码按职责分两组（分组约定与 role 字段校验详见 [extension-conventions.md](extension-conventions.md)「目录分组与 role 字段」）：

```
extensions/
├── taiji/       # role=taiji：xyz-agent 集成包（契约两端在 xyz-agent 体系内，离开 xyz-agent 无功能，必在 mandatory 清单）
├── universal/   # role=universal：独立通用包（功能自足，独立 pi 用户可单独安装）
└── shared/      # 共享库（不是 extension 包，不属于任何分组）
```

新建包必须放入对应分组目录并在 package.json 声明 `"xyz-agent": { "role": "taiji" | "universal" }`，同时登记 `extension-dependencies.json`。

### 1.2 扩展加载位置

| 位置 | 作用域 |
|------|--------|
| `~/.pi/agent/extensions/*.ts` | 全局 |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录） |
| `.pi/extensions/*.ts` | 项目级 |
| `.pi/extensions/*/index.ts` | 项目级（子目录） |
| `package.json` → `pi.extensions` | npm 包分发 |

### 1.3 package.json 必需字段

**[规范]** package.json 必须包含以下字段：

```jsonc
{
  "name": "@scope/pi-extension-name",
  "version": "0.1.0",
  "description": "一句话说清功能",
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension"], // 必须含 "pi-package"
  "bin": {
    "pi-extension-name": "install.mjs" // [历史形态] 早期安装脚本入口；现行活跃包 0 个含 install.mjs，pi 字段原生发现（见 §15.3）
  },
  "files": [
    "index.ts",
    "src/**/*.ts",
    "skills/**/*",
    "prompts/**/*",
    "README.md",
    "LICENSE"
  ],
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },
  "peerDependencies": { /* 见第 9 节 */ },
  "main": "index.ts" // 非必须，但建议
}
```

**[规范]** `pi.extensions` **必须**为 `["./index.ts"]`，禁止使用 `["./src/index.ts"]`。顶层 `index.ts` 作为 re-export 胶水层（`export { default } from "./src/index.ts"`），确保 Pi 扩展加载列表中统一显示纯包名而非包名+子路径。

**[规范]** `type: "module"` 必须设定——Pi 运行时使用 ESM 加载扩展。

**[规范]** `files` 必须包含入口 `.ts` 文件，否则 npm publish 后丢失入口。

**[规范]** `pi.extensions` 数组指向入口 TypeScript 文件（值为 `["./index.ts"]` 或 `["./dist/index.js"]`）。

**[规范]** `keywords` 必须包含 `"pi-package"` 以便 Pi 包管理器识别。

**[指南]** `bin` 指向 `install.mjs` 供 `pi install npm:xxx` 使用。安装脚本负责将扩展注册到 `~/.pi/agent/extensions/` 目录。（[历史形态] 本仓现行活跃包 0 个含 install.mjs——pi 通过 package.json `pi` 字段原生发现 npm 包资源，无需安装脚本。）

### 1.4 Pi SDK 包引用

**[规范]** Pi SDK 包始终用 `peerDependencies`（非 `dependencies`），由 Pi 运行时提供。`peerDependencies` 必须 `optional: true`，因为扩展运行在 Pi 进程内。

当前 Pi SDK 的 scope 分布（上游 npm `@earendil-works/pi-coding-agent@0.84.4`；曾用 fork xyz-pi 已废弃切回）：

| 包 | 作用域 | 说明 |
|---|---|---|
| `pi-coding-agent` | `@earendil-works` | **主 API 包**。TUI/AI 的入口 |
| `pi-tui` | `@earendil-works` | TUI 组件库（Container/Text/Box/Markdown 等） |
| `pi-ai` | `@earendil-works` | AI 工具（StringEnum / complete / getModel 等） |
| `pi-agent-core` | `@earendil-works` | Agent 核心类型（仅 subagent 场景） |

```jsonc
// 标准 package.json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@earendil-works/pi-ai": "*",
    "@sinclair/typebox": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@earendil-works/pi-tui": { "optional": true },
    "@earendil-works/pi-ai": { "optional": true }
  }
}
```

**[规范]** `@earendil-works/pi-coding-agent` 是核心依赖，**不能设为 optional**。

> **注意**：不同维护者的包可能使用不同的 scope。`nicobailon/pi-subagents` 使用 `@earendil-works`；`baphuongna/pi-crew` 使用的 `@mariozechner` 是**已废弃 namespace**（Pi 团队已重命名并被 npmjs 标记 deprecated），本仓禁用、不得作为合法选项（见 [extension-conventions.md](./extension-conventions.md)「禁止使用已废弃的 Pi SDK namespace」）。开发时一律使用 `@earendil-works/pi-*`。

**[指南]** TUI 和 AI 包按需声明，设为 optional 可降低纯工具扩展的依赖要求。

### 1.5 生产级架构蓝图 🟠

参考 `pi-subagents` 的实际结构（~25k 行源码，70+ 测试文件），复杂扩展采用领域驱动分层：

```
my-extension/
├── package.json              # 包声明 + pi 配置
├── install.mjs               # `pi install` 安装脚本
├── src/
│   ├── extension/
│   │   ├── index.ts          # ★ 扩展入口（default export function）
│   │   ├── config.ts         # 配置加载
│   │   └── schemas.ts        # 工具参数 schema（TypeBox）
│   ├── runs/
│   │   ├── foreground/       # 前台执行逻辑
│   │   │   ├── execution.ts
│   │   │   ├── chain-execution.ts
│   │   │   └── subagent-executor.ts
│   │   ├── background/       # 后台执行逻辑
│   │   │   ├── async-execution.ts
│   │   │   ├── async-job-tracker.ts
│   │   │   └── result-watcher.ts
│   │   └── shared/           # 前后台共享
│   │       ├── pi-spawn.ts
│   │       ├── pi-args.ts
│   │       ├── model-fallback.ts
│   │       └── worktree.ts
│   ├── agents/               # Agent 发现、序列化、管理
│   │   ├── agents.ts
│   │   ├── agent-scope.ts
│   │   ├── agent-management.ts
│   │   ├── frontmatter.ts
│   │   └── skills.ts
│   ├── intercom/             # 跨会话通信
│   │   ├── intercom-bridge.ts
│   │   └── result-intercom.ts
│   ├── slash/                # 斜杠命令桥接
│   │   ├── slash-commands.ts
│   │   ├── slash-bridge.ts
│   │   └── prompt-template-bridge.ts
│   ├── tui/                  # TUI 渲染组件
│   │   ├── render.ts
│   │   └── render-helpers.ts
│   └── shared/               # 公共工具
│       ├── types.ts
│       ├── utils.ts
│       ├── artifacts.ts
│       ├── session-identity.ts
│       └── settings.ts
├── agents/                   # 内置 Agent 定义（Markdown + YAML）
│   ├── scout.md
│   ├── reviewer.md
│   └── worker.md
├── skills/                   # 内置 Skills
│   └── my-extension/SKILL.md
├── prompts/                  # 可复用 Prompt 模板
│   └── parallel-review.md
├── test/
│   ├── unit/                 # 单元测试
│   ├── integration/          # 集成测试
│   └── support/              # 测试辅助
├── README.md
└── CHANGELOG.md
```

> 简单/中等规模扩展的结构见 [附录 A. 模块组织指南（按规模）](#a-模块组织指南按规模指南)。

---

## 2. 入口与工厂模式 **[规范]**

### 2.1 工厂函数签名 🔵

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // 注册 tools、commands、event handlers
}
```

**[规范]** 必须使用 `export default function(pi: ExtensionAPI)` 形式。这是 Pi 运行时识别扩展的入口点。

**[规范]** 函数名用匿名函数或 `extension`，不命名（无调用方）。

### 2.2 模块化入口 🔵

**[规范]** 超过 100 行的工厂函数应按功能委托到子模块：

```typescript
// index.ts — 包入口 re-export
export { default } from "./src/index.ts";

// src/index.ts — 工厂
import { registerTools } from "./tools";
import { registerCommands } from "./commands";
import { setupEventHandlers } from "./events";

export default function (pi: ExtensionAPI): void {
  registerTools(pi);
  registerCommands(pi);
  setupEventHandlers(pi);
}
```

### 2.3 闭包状态隔离 **[核心规范]** 🔵

**[规范]** 所有状态变量必须在工厂函数闭包内声明，禁止模块级 let 变量。

```typescript
// 正确：闭包内
export default function (pi: ExtensionAPI) {
  const state = { count: 0, items: [] as string[] };
  const pendingQueue: Item[] = [];
  let isFlushing = false;

  pi.registerTool({ ... });
}

// 错误：模块级，被所有 session 共享
let globalState = { count: 0 };
export default function (pi: ExtensionAPI) {
  pi.registerTool({ ... });
}
```

> 与 [§7.5 进程级单例](#75-进程级单例必须用-globalthissymbolfor-持有) 的区别：本节管的是**会话级状态**（每个 session 独立、随 session 结束而消亡），用工厂闭包持有；§7.5 管的是**进程级单例**（跨 session 存活）。

---

## 3. 模块职责划分 **[规范]**

### 3.1 各模块职责

| 文件 | 职责 | 必须 |
|------|------|------|
| `src/types.ts` | 类型定义、常量、TypeBox schema | 推荐 |
| `src/state.ts` | 状态机、createInitialState、deserializeState | 有状态时强制 |
| `src/config.ts` | 配置加载/保存/校验 | 有配置时强制 |
| `src/templates.ts` | Steering prompt 模板函数 | 有时用 |
| `src/commands.ts` | /command handler + TUI 渲染 | 有 command 时 |
| `src/widget.ts` | TUI widget 及 renderCall/renderResult | 需要 TUI 时 |

### 3.2 types.ts 规范

**[规范]** 工具参数类型、详情类型、状态类型集中到 `types.ts`，禁止散落各文件。

**[规范]** 跨文件共用类型必须提取到 `types.ts`，禁止多文件重复定义同名 interface。

```typescript
// types.ts
import type { Static } from "typebox";
import { Type } from "@earendil-works/pi-ai"; // StringEnum 等

// ---- 常量 ----
export const WIDGET_KEY = "my-extension-widget";
export const CUSTOM_TYPE_EVENT = "my-extension-event";

// ---- TypeBox Schema ----
export const MyParams = Type.Object({
  action: Type.String({ description: "Action to perform" }),
});
export type MyParamsType = Static<typeof MyParams>;

// ---- 详情类型 (renderResult 数据来源) ----
export interface MyDetails {
  items: string[];
  count: number;
  cancelled: boolean;
}
```

---

## 4. Tool 注册与设计 **[规范]**

> 本节融合规范红线（schema 定义、execute 签名契约）与完整注册模式（TypeBox schema + execute + renderCall/renderResult）。

### 4.1 Schema 定义（TypeBox） 🔵

**[规范]** 参数使用 TypeBox `Type.Object()` 定义，每个字段加 `description`。

```typescript
import { Type } from "typebox";

// ★ Google API 兼容：用 StringEnum 而非 Type.Union
const ActionEnum = Type.String({
  enum: ["list", "get", "create", "execute", "status"],
  description: "Action type"
});

export const MyToolParams = Type.Object({
  action: Type.Optional(ActionEnum),
  target: Type.Optional(Type.String({ description: "Target identifier" })),
  config: Type.Optional(Type.Unsafe({
    anyOf: [
      { type: "object", additionalProperties: true },
      { type: "string" }
    ],
    description: "Configuration object or JSON string"
  })),
  async: Type.Optional(Type.Boolean({ description: "Background execution" })),
  context: Type.Optional(Type.String({
    enum: ["fresh", "fork"],
    description: "Session context mode"
  })),
});
```

### 4.2 注册格式 🔵

```typescript
pi.registerTool({
  name: "my_tool",                              // 蛇形命名
  label: "My Tool",                             // 对人类展示
  description: "What this tool does in detail", // 模型理解用
  promptSnippet: "Brief usage hint for model",   // [指南] AI 摘要
  promptGuidelines: [                           // [指南] 使用禁忌
    "Use this tool when ...",
    "Do NOT use for ...",
  ],
  parameters: Type.Object({ ... }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // 见 4.4
  },
  renderCall: (params, options, theme) => new Text("...", 0, 0),
  renderResult: (details, options, theme) => new Text("...", 0, 0),
});
```

带完整类型的注册范例：

```typescript
const tool: ToolDefinition<typeof MyToolParams, MyDetails> = {
  name: "my_tool",
  label: "My Tool",
  description: `Delegate to sub-processes or manage definitions.

EXECUTION (use exactly ONE mode):
• SINGLE: { target, task? } - one task
• PARALLEL: { tasks: [...] } - concurrent execution

MANAGEMENT:
• { action: "list" } - discover resources
• { action: "get", target: "name" } - inspect detail`,
  parameters: MyToolParams,

  async execute(id, params, signal, onUpdate, ctx) {
    // onUpdate 用于流式进度更新
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }]
    });

    // signal 用于中断支持
    if (signal.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }], isError: true, details: {} };
    }

    // 根据 action 分发
    if (params.action) return handleManagementAction(params, ctx);
    return handleExecution(params, signal, onUpdate, ctx);
  },

  renderCall(args, theme) {
    return new Text(
      `${theme.fg("toolTitle", theme.bold("my_tool "))}${args.action || "execute"}`,
      0, 0
    );
  },

  renderResult(result, options, theme, context) {
    return renderMyResult(result, options, theme);
  },
};

pi.registerTool(tool);
```

### 4.3 关键设计原则 🔵

| 原则 | 实践 |
|------|------|
| **大 Description** | 工具描述就是 LLM 的使用手册，包含所有模式、参数、示例 |
| **Schema 即文档** | 每个 TypeBox 字段都有详细 description |
| **流式更新** | 使用 `onUpdate` 回调实时推送进度 |
| **中断支持** | 检查 `signal.aborted` 并优雅退出 |
| **上下文感知** | 用 `ctx.mode` 区分 TUI/GUI 运行环境（不要用 `ctx.hasUI`，TUI 和 RPC 都 true） |
| **结构化 details** | 返回 `details` 对象供渲染器和会话持久化使用 |

### 4.4 execute 字段名与签名 **[MANDATORY]** 🔵

**[MANDATORY]** Tool 的执行函数字段名**必须**是 `execute`，**禁止**用 `handler` / `fn` / `run` / `callback` 等其他名字。字段名错误时 Pi 内部调 `definition.execute(...)` 拿到 `undefined`，运行时报 `definition.execute is not a function`。

**[MANDATORY]** execute 的真实签名是 SDK 全签名，**不是**只接收 params：

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  //           ↑ 5 个位置参数，params 在第 2 位
}
```

**反模式**：把业务函数（签名 `(params) => ...`）直接当 execute 字段：

```typescript
// 错误：handler 签名只收第一个参数（toolCallId 字符串），params 解构全是 undefined
pi.registerTool({
  name: "my_tool",
  handler: createMyHandler(runtime),  // 字段名错 + 签名错
});
```

**正确模式**：execute 内联闭包做 SDK 适配——从全签名提取 params，转调业务函数：

```typescript
// 正确：字段名 execute + 内联闭包适配签名
pi.registerTool({
  name: "my_tool",
  async execute(_toolCallId, params) {
    return createMyHandler(getRuntime())(params);
  },
});
```

业务函数（`createMyHandler` 返回值）保持纯业务签名 `(params) => ...`，便于单元测试直接调用；SDK 适配逻辑放在 execute 内联闭包里。

### 4.5 Runtime 延迟捕获 **[MANDATORY]** 🔵

**[MANDATORY]** 依赖 session_start 才能初始化的对象（如 Runtime / Store / Registry），**禁止**在 factory 顶层注册 tool/command 时直接传入实例——此时 session_start 尚未触发，对象还是 null。

**反模式**：

```typescript
// 错误：runtime 在 session_start 才赋值，factory 顶层调用时还是 null
// runtime! 非空断言骗过编译器，运行时 execute 内 runtime.xxx() 会 NPE
let runtime: MyRuntime | null = null;

pi.on("session_start", (_e, ctx) => {
  runtime = new MyRuntime(ctx);  // 这里才赋值
});

pi.registerTool({
  name: "my_tool",
  execute: createMyHandler(runtime!),  // 错误：factory 顶层传 null
});

registerMyCommand(pi, runtime!);  // 错误：同样捕获 null
```

**正确模式**：execute / handler 内联闭包，**调用时**才读 runtime 当前值；或通过 getter 显式延迟：

```typescript
// 正确：getter 延迟到 execute 真正被调用时才读 runtime
let runtime: MyRuntime | null = null;
const getRuntime = (): MyRuntime => {
  if (!runtime) throw new Error("Runtime not initialized: session not started");
  return runtime;
};

pi.on("session_start", (_e, ctx) => {
  runtime = new MyRuntime(ctx);
});

pi.registerTool({
  name: "my_tool",
  async execute(_toolCallId, params) {
    return createMyHandler(getRuntime())(params);  // 调用时读
  },
});

registerMyCommand(pi, () => runtime);  // command 也传 getter
```

参考实现：`extensions/universal/ask-user/src/index.ts`（execute 内联 + 闭包变量延迟读）、`extensions/universal/scheduler/src/index.ts`（getter 模式）。

### 4.6 execute 返回值规范 🔵

**[规范]** 返回值格式必须为：

```typescript
{
  content: [{ type: "text", text: string }],
  isError?: boolean,       // 错误时设为 true
  details?: Record<string, unknown>  // renderResult 数据
}
```

**[规范]** 错误处理分两层：**内部实现可以 throw，`execute` 边界必须 catch**，对外返回结构化 `{ isError: true }`。

- 内部辅助函数（`handleExecution` 等）可以 `throw new Error(...)` 表达失败；
- `execute` 是 API/契约边界，不允许异常逃逸——必须 catch 并转为 `{ isError: true }` 返回；
- 错误消息只用 `err.message`（或 `String(err)`），**禁止把 `err.stack` 拼进 content**——堆栈不得外泄到 LLM 上下文与持久化记录，防止错误信息蔓延。

```typescript
async execute(_toolCallId, params, signal, _onUpdate, ctx) {
  // 正确：内部 throw，execute 边界 catch 转 isError，消息不含堆栈
  try {
    const result = await riskyOperation();
    return { content: [{ type: "text", text: `Success: ${result}` }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  // 错误：异常从 execute 逃逸（未 catch），Tool 中断且 Pi 可能崩溃
  async execute(_toolCallId, params) {
    const result = await riskyOperation(); // throw 未捕获
    return { content: [{ type: "text", text: `Success: ${result}` }] };
  }
}
```

**[规范]** execute 内部的异步操作必须透传 `signal` 参数支持取消。

### 4.7 details 与 renderResult 契约 🔵

**[规范]** `details` 是 `renderResult` 的唯一数据来源，renderResult 不能解析 `content` 文本。

```typescript
// types.ts
export interface MyDetails {
  count: number;
  items: string[];
  cancelled: boolean;
}

// render.ts
function renderMyResult(details: MyDetails, options: { expanded: boolean }, theme: Theme): Text {
  if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
  const lines = [theme.fg("success", `${details.count} items found`)];
  if (options.expanded) lines.push(...details.items.map((i) => `  • ${i}`));
  return new Text(lines.join("\n"), 0, 0);
}
```

---

## 5. Command 注册 **[规范]**

```typescript
pi.registerCommand({
  name: "mycommand",
  description: "描述",
  parameters: Type.Optional(Type.Object({ ... })),
  execute: async (params, ctx) => {
    return { content: [{ type: "text", text: "Done" }] };
  },
  renderResult: (details, options, theme) => new Text("...", 0, 0),
});
```

**[规范]** Command 用于用户手动触发的操作。Tool 用于模型调用的操作。两者不互为替代——Tool 有 promptSnippet 提示模型何时调用，Command 没有此机制。

---

## 6. 事件生命周期管理 **[规范]**

> 本节融合规范红线（事件表 + 处理器设计规范）与完整模式（事件链 + 全局状态清理/热重载）。

### 6.1 可用事件

| 事件 | 典型用途 | 注意事项 |
|------|---------|---------|
| `session_start` | 恢复状态、加载配置、注册 widget | 最常用 |
| `session_tree` | 分支导航后重建状态 | 清理旧分支 pending 数据 |
| `before_agent_start` | 注入自定义 system prompt | 返回 `{ systemPrompt }` |
| `turn_end` | 捕获数据做批处理 | 慢操作使用缓存/批处理 |
| `message_end` | 序列化、清理 | — |
| `tool_execution_end` / `tool_result` | 监听特定 Tool 的结果 | 检查 `event.toolName` |
| `context` | 修改/过滤消息 | 返回 `{ messages }` 或 `undefined` |
| `agent_end` | 最后清理 | **不做异步 LLM 调用** |
| `session_shutdown` | 释放资源 | 同步操作为主 |

### 6.2 完整事件链 🔵

```typescript
export default function register(pi: ExtensionAPI): void {
  // 会话开始 —— 初始化状态
  pi.on("session_start", (event, ctx) => {
    resetSessionState(ctx);
  });

  // 工具结果后 —— 更新 UI
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "my_tool") return;
    if (!ctx.hasUI) return;
    updateWidget(ctx, currentState);
    ctx.ui.requestRender?.();
  });

  // 会话结束 —— 清理资源
  pi.on("session_shutdown", () => {
    cleanupTimers();
    cleanupWatchers();
    clearState();
  });
}
```

### 6.3 事件处理器设计规范 🔵

**[规范]** 每个事件处理器不超过 20 行，复杂逻辑提取为命名函数。

**[规范]** `agent_end` 中**禁止**启动新的 LLM 调用，只做同步清理（Pi 可能已开始销毁上下文）。

**[规范]** `session_tree` 中必须丢弃旧分支的 pending 状态：

```typescript
pi.on("session_tree", async (_event, ctx) => {
  indexer.reconstructFromSession(ctx);
  pendingBatches.length = 0; // 丢弃旧分支数据
});
```

### 6.4 全局状态清理（热重载支持） 🔵

Pi 支持扩展热重载，新实例加载时必须先清理旧实例的定时器、监听器和文件监视器。

```typescript
// ★ 关键模式：通过 globalThis 支持扩展热重载
const globalStore = globalThis as Record<string, unknown>;
const CLEANUP_KEY = "__myExtensionCleanup";

const previousCleanup = globalStore[CLEANUP_KEY];
if (typeof previousCleanup === "function") {
  try { previousCleanup(); } catch { /* best effort */ }
}

const runtimeCleanup = () => {
  stopWatchers();
  clearTimers();
  unsubscribeEvents();
};
globalStore[CLEANUP_KEY] = runtimeCleanup;
```

---

## 7. 状态与会话管理 **[规范]**

### 7.1 内存状态

**[规范]** 状态始终在工厂闭包内，通过事件处理器初始化和清理。

### 7.2 持久化模式

使用 Pi Entry 机制实现持久化：

```typescript
// 写入
pi.appendEntry("my-type", { key: "value" });

// 读取（在 session_start 中）
const entries = ctx.sessionManager.getEntries()
  .filter((e): e is CustomEntry<MyData> =>
    e.type === "custom" && e.customType === "my-type"
  );
```

### 7.3 反序列化向后兼容 **[规范]**

> 原因：扩展升级后，旧的 Entry 格式仍存在 Session 中，不兼容的反序列化会导致扩展启动崩溃。

```typescript
function deserializeState(raw: unknown): MyState {
  if (!raw || typeof raw !== "object") return createInitialState();

  const obj = raw as Record<string, unknown>;
  return {
    // 每个字段都提供默认值
    initialized: typeof obj.initialized === "boolean" ? obj.initialized : false,
    items: Array.isArray(obj.items)
      ? obj.items.filter((i): i is string => typeof i === "string")
      : [],
    // 新版本加的字段，旧格式不存在时给默认
    version: typeof obj.version === "number" ? obj.version : 1,
  };
}
```

### 7.4 Entry GC

**[指南]** 长会话中 Entry 不断积累，建议设上限并定期 GC：

```typescript
const MAX_ENTRIES = 1000;
if (entries.length >= MAX_ENTRIES) {
  entries.splice(0, Math.floor(MAX_ENTRIES * 0.2)); // 删除最旧 20%
}
```

### 7.5 进程级单例必须用 `globalThis[Symbol.for]` 持有

> 与 [§2.3 闭包状态隔离](#23-闭包状态隔离核心规范) 的区别：§2.3 管的是**会话级状态**（每个 session 独立、随 session 结束而消亡），用工厂闭包持有；本节管的是**进程级单例**（跨 session 存活、在 `session_start` 时懒创建/重建，如 Hub / Runtime / Registry），这种对象的生命周期长于单个 session，不能放进工厂闭包（闭包随工厂调用结束就丢了），也不能用模块级 `let`（jiti 双路径加载会让单例分裂）。

**[规范]** 跨 session 存活、需在 `session_start` 重建的进程级单例，**必须**用 `globalThis[Symbol.for("包名.角色")]` 持有，**禁止**用模块级 `let` 变量。

**机制**：Pi 的 extension loader 使用 [jiti](https://github.com/unjs/jiti) 加载 TypeScript 扩展。jiti 用**模块路径字符串**（非 `realpath`）做缓存 key。当同一模块被两个不同的路径字符串引用时，jiti 会把它加载成两个独立的 module instance，各自的模块级 `let` 变量互不可见 → `setX` 写 A instance、`getX` 读 B instance 返回 `null`。

**触发场景**：
- 跨扩展 import：扩展 A 写 `import "@scope/pi-ext"`（走 node_modules 软链），同时 Pi host 自己按 `pi.extensions: ["./index.ts"]` 直接加载 `.../extensions/pi-ext/index.ts`——两条路径字符串不同，jiti 缓存 key 不同
- 符号链接 / 相对路径 vs 绝对路径：哪怕同一文件，`./src/hub.ts` 和 `/abs/path/src/hub.ts` 在 jiti 眼里也是两个 key

**正确模式**：

```typescript
// hub.ts
const HUB_SLOT_KEY = Symbol.for("@scope/pi-ext.hub");

type HubSlot = { current: Hub | null };

function getSlot(): HubSlot {
  const record = globalThis as unknown as Record<symbol, unknown>;
  if (!record[HUB_SLOT_KEY]) record[HUB_SLOT_KEY] = { current: null };
  return record[HUB_SLOT_KEY] as HubSlot;
}

export function getHub(): Hub | null {
  return getSlot().current;
}

export function setHub(hub: Hub): void {
  getSlot().current = hub;
}
```

**为什么有效**：`Symbol.for(key)` 跨所有 module instance 返回同一个 symbol（全局 symbol registry），且 `globalThis` 是进程级唯一的。无论 jiti 加载几份 `hub.ts`，它们读写的是同一个 `globalThis[HUB_SLOT_KEY]` 对象。

**[规范]** `Symbol.for` 的 key 必须用**包名 + 角色**的全限定形式（如 `"@zhushanwen/pi-subagents.hub"`），避免与其它扩展的 symbol 冲突。

**纯性能缓存豁免**：TTL 型只读加速缓存（如 session-reader 的 `doctorScanCache` / `metadataCache`）**不强制**本规范——jiti 双路径加载分裂成两份缓存仅多一次 miss 重扫（自愈，无正确性影响），升级 `globalThis` 单例反而引入进程级生命周期管理负担；此类缓存声明处注释引用本豁免即可。需要跨路径共享**状态语义**（写后必须读到）的单例不在豁免内。

---

## 8. 配置管理 **[规范]**

### 8.1 配置路径

```
<agentDir>/config/<extension简名>-ext-config.json
```

**[规范]** 配置路径的权威约定见 [extension-conventions.md「配置路径约定 [强制]」](./extension-conventions.md#配置路径约定强制)，要点：

- 统一放 `<agentDir>/config/`，文件名 `<extension简名>-ext-config.json`；
- `<agentDir>` = pi 的 `getAgentDir()`（`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；xyz-agent 隔离环境 `~/.xyz-agent/pi/agent`）；
- 路径必须经 `@zhushanwen/pi-llm-shared` 的 `getConfigPath(pkgName)` 生成，调用方不自拼文件名，禁止语义名/无后缀简写/`<名>-config.json` 变体。

### 8.2 加载模式 🔵

```typescript
import { existsSync, readFileSync } from "node:fs";
import { getConfigPath } from "@zhushanwen/pi-llm-shared";

export function loadConfig<T extends Record<string, unknown>>(
  defaults: T,
  pkgName: string,  // 扩展包名（如 @zhushanwen/pi-my-extension）
): T {
  const path = getConfigPath(pkgName); // <agentDir>/config/<简名>-ext-config.json
  if (!existsSync(path)) return { ...defaults };

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config for ${pkgName}: ${message}`);
  }
}
```

**[规范]** 配置加载失败必须抛有意义的错误（包含路径和原因），不能静默使用默认值。

### 8.3 配置项示例 🟠

```jsonc
// <agentDir>/config/my-extension-ext-config.json
{
  "asyncByDefault": false,
  "forceTopLevelAsync": false,
  "maxSubagentDepth": 1,
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  },
  "defaultSessionDir": "~/.pi/agent/sessions/subagent/",
  "intercomBridge": {
    "mode": "always",          // always | fork-only | off
    "instructionFile": "./intercom-bridge.md"
  },
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 30000
}
```

---

## 9. 依赖管理 **[规范]**

### 9.1 扩展能否 import 其他 npm 包

> 是的，可以。澄清一个常见误解。

Pi 的 extension loader 使用 [jiti](https://github.com/unjs/jiti) 加载 TypeScript 扩展。jiti 配置了一个 **alias 列表**（或 Bun binary 模式下的 **virtualModules**），但这个 alias 列表的用途是**将 Pi SDK 包重定向到捆绑版本**，而非限制你能 import 什么。

加载流程：

```
扩展源文件 import X
  ├── X 命中了 alias 列表？→ 重定向到 Pi 捆绑的版本（@earendil-works/*、typebox）
  └── X 未命中 alias？→ jiti 走标准 Node.js 模块解析（node_modules 查找）
```

#### Bun binary 模式与 Node.js 模式的差异

| 模式 | 机制 | 对非 SDK 包 import 的支持 |
|------|------|--------------------------|
| **Node.js 模式**（当前上游 pi） | `alias` | 标准 node_modules 查找，能找到依赖就能 import |
| **Bun binary 模式**（上游 pi-mono 的编译产物） | `virtualModules` + `tryNative: false` | 注意：仅 virtualModules 中的包可被解析，其他 import 会失败 |

当前 pi 以 Node.js 脚本运行（`cli.js` 首行为 `#!/usr/bin/env node`），因此扩展的 import 走标准 node_modules 解析。

**[规范]** 如果扩展依赖第三方 npm 包，必须在其 `package.json` 的 `dependencies` 中声明。安装扩展后这些包会被下载到 node_modules，jiti 就能找到。

**[规范]** 禁止依赖 pi 自身的 node_modules 中碰巧存在的包（如 `diff`）。这不是 API 契约——不同版本的 pi 可能增减内部依赖。

### 9.2 依赖类型决策

| 依赖类型 | 适用场景 | 示例 |
|---------|---------|------|
| `peerDependencies` | Pi SDK 包，运行时提供 | `@earendil-works/pi-coding-agent` |
| `peerDependenciesMeta.optional` | 条件依赖 | `@earendil-works/pi-tui`（纯 headless） |
| `dependencies` | 业务逻辑依赖 | `zod`、`diff`、`openai` |
| `devDependencies` | 测试/类型 | `vitest`、`@types/node`、`typescript` |

### 9.3 版本范围

| 场景 | 写法 |
|------|------|
| 兼容任何版本 | `"*"` |
| 兼容大版本内 | `"^0.74.0"` |
| 有最低版本 | `">=0.74.0"` |
| 不支持未来主版本 | `">=0.74.0 <1.0.0"` |

**[指南]** Pi SDK 包建议用 `"*"` 或 `">=0.74.0"`，避免因版本范围过窄导致安装失败。

### 9.4 核心依赖说明

| 包名 | 用途 |
|------|------|
| `@earendil-works/pi-coding-agent` | ExtensionAPI 类型、ExtensionContext、ToolDefinition |
| `@earendil-works/pi-agent-core` | AgentToolResult 类型 |
| `@earendil-works/pi-ai` | StringEnum（Google API 兼容）、Message 类型 |
| `@earendil-works/pi-tui` | Box、Container、Text、Spacer 等 TUI 组件 |
| `typebox` / `@sinclair/typebox` | JSON Schema 构建（参数校验） |
| `jiti` | TypeScript 运行时加载 |

---

## 10. 日志与诊断输出 **[规范]**

Pi Interactive 模式下，extension 的 `console.*` 输出直接写入 pi 主进程 stdout/stderr，会干扰 TUI 渲染并泄漏到用户输入区域，且 pi 既不捕获也不落盘 extension 的 console 输出。**必须严格遵守以下规范。**

> **现行口径 SSOT = [logging-conventions.md](./logging-conventions.md)**（三层通道分类 + `@zhushanwen/pi-extension-logger`）。本节为其摘要——历史版本允许的 `console.warn`/`console.error` 带前缀输出已被收敛为禁止，见该文档迁移指南。

### 10.1 输出通道选择（三层通道）

每条日志按**受众**路由，选择唯一正确的通道：

| 场景 | 正确做法 | 错误做法 |
|------|---------|----------|
| AI 需实时感知（hook block、tool 执行错误） | tool result / `return { block: true, reason }`（pi 原生链路） | 经 logger 转发 |
| 事后排查（内部降级、竞态、IO 清理失败） | `logger.warn` / `logger.error` → `pi.appendEntry` custom entry | `console.warn("[ext] ...")`、`ctx.ui.notify` |
| 开发者调试 | `logger.debug` → 文件日志（`XYZ_AGENT_DEBUG=1` DEBUG 全量 / `XYZ_AGENT_EXT_LOG=1` INFO 级） | 自造 `PI_*_DEBUG` 环境变量 + console |
| 用户操作反馈（用户主动触发命令的结果） | `ctx.ui.notify(msg, "info"/"warning"/"error")` | 诊断信息用 notify（刷屏） |
| Worker 线程 | 拦截 console.* → 收集数组 → postMessage 回传 | 直接 console.* 输出 |

### 10.2 console 方法使用规则

**[规范]** 禁止一切裸 `console.*`（`log` / `info` / `warn` / `error`），无论是否是本次引入的，必须正面修复，统一接 `@zhushanwen/pi-extension-logger`：

1. **禁止 `console.log` / `console.info`** — 输出到 stdout，Interactive 模式下泄漏到用户输入区域，干扰 TUI 渲染
2. **禁止 `console.warn` / `console.error`** — raw stderr 在 TUI alternate-screen 下越过渲染层污染 input 区，且不落盘。历史「带 `[ext-name]` 前缀的 warn/error」方案已废弃（前缀只解决来源区分，不解决污染与不落盘）
3. **不可恢复错误用 `throw`** — 由 Pi 框架的 `ExtensionRunner.onError()` 捕获并渲染到 TUI，比手动 console 输出更规范
4. **生产默认静默** — 正常运行时不输出诊断信息；文件日志双开关：`XYZ_AGENT_DEBUG=1`（DEBUG 全量）与 `XYZ_AGENT_EXT_LOG=1`（INFO 级落盘，xyz 托管环境由 runtime spawn 时注入 + 7 天清理）；禁止新增 per-extension 的 `PI_*_DEBUG` / `<EXT>_DEBUG` 变量
5. **重复警告去重** — 可能反复触发的警告用 `Set` 去重，防止刷屏

### 10.3 ctx.ui.notify() 使用

`ctx.ui.notify(msg, type?)` 是 Pi SDK 提供的唯一正规用户通知 API：

```typescript
ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
ctx.ui.notify("Token budget 90% used — start wrapping up.", "warning");
```

**注意事项：**
- RPC/JSON 模式下为**空操作**（Pi runner 中 `notify: () => {}`）
- Interactive 模式渲染到 TUI chat 区域
- 跨 session 异步使用时，用 `safeNotify()` 包装防止 stale context 错误（参见 [§11.1](#111-stale-context-检测)）

### 10.4 Worker 线程日志拦截

Worker 线程（`worker_threads` / `child_process`）中的 `console.*` 输出直接写 stderr，不受 Pi 管理。必须拦截并回传主线程：

```typescript
// Worker 脚本中拦截 console.*
const _workerLogs: Array<{ level: string; message: string }> = [];
function _pushWorkerLog(level: string, args: unknown[]) {
  if (_workerLogs.length >= 1000) _workerLogs.shift(); // 防无界增长
  try {
    _workerLogs.push({ level, message: args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") });
  } catch { /* swallow */ }
}
console.log = (...args) => _pushWorkerLog("log", args);
console.warn = (...args) => _pushWorkerLog("warn", args);
console.error = (...args) => _pushWorkerLog("error", args);
console.info = (...args) => _pushWorkerLog("info", args);

// 结束时通过 postMessage 回传
parentPort.postMessage({ type: "return", result, workerLogs: _workerLogs });
```

主线程收到后存储到扩展状态，在 TUI widget 内渲染，不泄漏到输入区域。

---

## 11. 错误处理与弹性模式 **[规范]**

### 11.1 Stale Context 检测

> 这是 Pi 扩展开发中最常见的崩溃源。Session 关闭后 ctx 过期，访问它会抛异常。

**[规范]** 所有可能跨越 session 生命周期（特别是异步 await 前后）的 ctx 操作必须加 stale context 保护：

```typescript
function isStaleContextError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("Extension context no longer active");
}

function safeNotify(ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, type);
  } catch (err) {
    if (!isStaleContextError(err)) throw err;
    // Session 已结束，静默忽略
  }
}
```

### 11.2 异步操作的完整安全模式

```typescript
async function flushPending(ctx: any): Promise<void> {
  if (isFlushing) return; // 防重入
  isFlushing = true;

  try {
    const results = await asyncOperation({ signal: abortController.signal });
    // 写入前检查 ctx 是否还活着
    persistResults(results, ctx);
  } catch (err) {
    if (isStaleContextError(err)) {
      pendingBatch = results; // 恢复数据待重试
      return;
    }
    if ((err as Error)?.name === "AbortError") return; // 取消不处理
    throw err; // 无法恢复的异常
  } finally {
    isFlushing = false;
  }
}
```

### 11.3 防重入

**[规范]** 可能被并发触发的异步操作必须有防重入保护：

```typescript
let isProcessing = false;

async function handleTurnEnd(ctx: any) {
  if (isProcessing) return;
  isProcessing = true;
  try {
    await processBatch(ctx);
  } finally {
    isProcessing = false;
  }
}
```

### 11.4 函数内所有可能的控制流路径必须有显式的 return

> 声明了返回类型的函数，遗漏 return 分支会导致 TS2366。

**[规范]**

```typescript
function process(items: string[]): string[] {
  if (items.length === 0) return []; // 必须有
  // ...
}
```

### 11.5 超时契约（plugin-service 超时粒度）🔵

> 插件作者面对的超时 API 面与到期行为。量级裁定原则：**超时按被保护对象的粒度校准**——
> 等插件业务代码跑完的任务级等待 = 30min 兜底 + 作者声明覆盖；等人工的弹窗/审批 = 30min
> + 取消非替答；生命周期握手（activate）= 控制面秒级。设计权威源：
> `docs/design/timeout-plugin-service-granularity.md`。

**onActivate 轻量契约 [规范]**：`onActivate` 的协议语义是生命周期握手（声明注册工具/hooks/
命令清单），控制面超时 30s。`onActivate` 内**禁止**重初始化（拉配置、建连接、预热缓存等
长耗时操作）——把这些移到首个工具调用或命令 handler 内懒执行。宿主装配侧有
`ActivatorOptions.activateTimeoutMs` 覆盖参数（对重初始化类插件的逃生门），但契约优先：
靠声明轻量化而不是靠调大超时。

**工具执行超时（registerTool `timeoutMs` 声明）**：插件工具被 pi agent 调用后，执行超时
按以下取值链裁决（声明值合法性校验在注册入口，非 number 直接抛 `INVALID_TIMEOUT_MS`）：

| 声明 | 生效值 | 语义 |
|------|--------|------|
| 缺省 / 非法值 | 30min（`DEFAULT_TOOL_EXECUTE_TIMEOUT_MS`） | 防挂死兜底，不误杀长工具 |
| `timeoutMs > 0` | 声明值（clamp 到 timer 域上界） | 作者声明的该工具执行上界 |
| `timeoutMs <= 0` 或 `Infinity` | 不限时（显式 opt-out） | 「最了解执行时长的一方」显式接管 |

到期行为：pi agent 收到 `isError` 诚实消息（含等待时长 / 默认还是声明值 / handler 可能
仍在跑且结果将被丢弃 / 调整指引），例如：

```
Plugin tool 'slow-tool' timed out after 30min (default; plugin handler may still be
running, its result will be discarded). Plugin authors: pass timeoutMs in registerTool()
to extend or opt out (<=0 = no limit).
```

pi agent 自行决策重试/换路径；插件侧无感知、不被卸载。

**命令执行超时（命令定义级 `timeoutMs` 声明）**：用户点击 UI（状态栏按钮/命令面板）触发的
插件命令，执行超时取值链与工具 `registerTool` 完全同款（上表适用；校验同在注册入口，
非 number 抛 `INVALID_TIMEOUT_MS`），缺省默认 30min，`<=0` / `Infinity` 显式 opt-out。
命令并发执行有 busy 守卫：同一命令 handler 未返回前重复触发会被拒绝，提示含已等待时长
（命令进度反馈/可取消能力为后续演进项）。到期行为与工具一致（诚实 `isError`，含调整指引
`pass timeoutMs in the command definition`），保留 `code: -32000`。

**UI 弹窗超时（`ctx.ui.showConfirm` / `showSelect` / `showInput` 末位 `opts.timeout`）**：

```typescript
const ok = await ctx.ui.showConfirm("发布", "确认发布 v1.2.0？", { timeout: 10 * 60_000 });
```

- `opts.timeout`（毫秒）= 从调用到拿到结果的**最长全程等待，含串行排队时间**（前面还有
  其他插件的弹窗未关闭时，排队也在计时）。缺省/非法回落默认 30min；无 opt-out（「等人工」
  不允许无界等待——串行队列 head-of-line 阻塞）。`notify` / `updateStatusBarItem` 纯展示
  类无等待语义，不设 `opts`。
- **到期 = 取消非替答**：弹窗在前端被撤回（`plugin:uiRequestExpired` 广播），调用
  reject `Error`（`code: 'UI_TIMEOUT'`）——超时是独立可 catch 的错误类别，与「用户点取消」
  可区分（不再被替答 `false`）。插件 catch 后自行决策：重发提问 / 放弃操作 / 走默认路径。

```typescript
try {
  const ok = await ctx.ui.showConfirm("发布", "确认发布？", { timeout: 600_000 });
} catch (err) {
  if ((err as { code?: string }).code === "UI_TIMEOUT") {
    // 用户 10min 未响应，弹窗已撤回。可重发提问或放弃，按业务默认行为处理
  }
}
```

**权限审批超时（`XYZ_PLUGIN_PERMISSION_TIMEOUT_MS` env）**：插件首次激活弹出的权限审批，
等待超时默认 30min。全局调整用环境变量（合法正数毫秒生效，缺失/非法 warn 回落默认）：

```bash
XYZ_PLUGIN_PERMISSION_TIMEOUT_MS=600000  # 10min
```

到期语义 = **取消非判拒**：本次激活取消（插件置 UNLOADED 未装载态，不写任何「拒绝」记录），
前端撤回审批弹窗；**再次触发激活事件（如重发 slash command）即可重新激活 + 重新弹审批**。
等待窗口内（未超时）重触发不会产生第二个弹窗，原审批继续有效。

**已知限制（pi abort 不传播）**：pi turn 被 abort 后，正在执行的插件工具调用**不会被中断**
——pi 侧 bridge 调用路径无 signal/abort 传播，runtime 是该链路唯一墙钟。默认 30min 窗口内
handler 会继续跑完（结果被丢弃，不阻塞其他 turn/session）。缓解：可能被 abort 的长工具
**声明小的 `timeoutMs`**（如任务合理时长上限）。该缺口的根治（signal 传播）已独立登记，
不在插件作者可解范围内。

---

## 12. 类型安全 **[规范]**

### 12.1 禁止 any

所有 `any` 必须替换为具体类型或 `unknown`。这是品味检查的 P0 违规。

### 12.2 Record<string, unknown> 白名单管理

**[规范]** 除以下白名单场景外，禁止使用 `Record<string, unknown>`：

| 允许场景 | 说明 |
|---------|------|
| 外部接口签名约束 | 如 `FormatConverter.transformRequest(body: Record<string, unknown>)` |
| 输出对象构造 | `const result: Record<string, unknown> = {}`（在退出边界前断言为具体类型） |
| SSE payload 解析 | `JSON.parse(event.data)` 后 |
| Patch 层 | 处理上游响应结构多变的 patch 函数 |
| 错误格式转换 | 错误响应结构不确定 |

不在白名单的 `Record<string, unknown>` 必须改为结构化类型。入口处用 `as unknown as ConcreteType` 断言。

### 12.3 跨文件类型定义

**[规范]** 禁止多文件重复定义同名 interface。共享类型提取到 `types.ts`（见 [§3.2](#32-typests-规范)）。

---

## 13. 路径与配置硬编码 **[规范]**

> 来源：多个 Pi 扩展使用硬编码路径导致在不同环境中不可移植。

### 13.1 禁止硬编码路径

**[规范]** 所有文件系统路径**禁止**硬编码字符串。必须使用 `path.join()` + 基准路径（`homedir()` / `import.meta.url`）构建。

```typescript
// 正确
import { join } from "node:path";
import { homedir } from "node:os";

const configPath = join(homedir(), ".pi", "agent", "config.json");

// 错误
const configPath = "/Users/zhushanwen/.pi/agent/config.json";
```

**[规范]** 扩展内引用的路径优先基于 `import.meta.url` 或 `homedir()` 构造：

```typescript
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 相对于扩展自身目录的路径
const extensionDir = dirname(fileURLToPath(import.meta.url));
const skillDir = join(extensionDir, "skills");

// 相对于用户 home 的路径
const userConfigDir = join(homedir(), ".pi", "agent", "extensions", "my-extension");
```

### 13.2 路径处理工具函数

```typescript
// utils.ts
import { homedir } from "node:os";
import { join } from "node:path";

export function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
```

### 13.3 白名单：允许的硬编码场景

- `"node_modules"` / `".pi"` 等标准目录名（概念名，不是绝对路径）
- 配置文件中的默认路径（用户可覆盖）

---

## 14. 健壮性基础要求 **[规范]**

### 14.1 防崩溃

| 要求 | 说明 |
|------|------|
| 不允许未捕获异常 | 内部可 throw，execute 边界必须 catch 并返回 `{ isError: true }` |
| 不允许模块加载时报错 | 配置加载失败在 session_start 中处理，不在模块顶层 |
| 不允许 process.exit | 扩展无权结束进程 |
| 不允许无限循环 | while(true) 必须有迭代上限 |

### 14.2 资源清理

| 场景 | 要求 |
|------|------|
| 异步操作 | 必须支持 `signal` 取消，finally 块清理 |
| 文件句柄 | 用完关闭 |
| 定时器 | 在 session_shutdown 中清除 |
| AbortController | 组件卸载/操作完成时调用 `.abort()` |

---

# 第二部分：进阶模式（完整范例）

> 本部分来自生产级扩展（`nicobailon/pi-subagents`、`pi-mcp-adapter`、`pi-crew` 等）的深度调研，是构建真正生产级 Pi extension 的「怎么做」范例。🟠 标记的章节为子代理专项，仅 spawn/manage 子进程的复杂扩展需要。

## 15. 系统概述与架构蓝图

Pi 的扩展系统（Extension System）是一个基于 TypeScript 的插件架构，通过 `jiti` 运行时加载 TS 模块，无需编译。扩展可以：

- **注册自定义工具**（LLM 可调用）
- **拦截/修改工具调用与结果**
- **注册命令、快捷键、CLI 标志**
- **自定义 UI 渲染**（TUI 组件、消息渲染器）
- **管理会话状态**
- **替换内置工具**
- **注册自定义模型提供者**
- **跨扩展通信**（事件总线）

### 15.1 架构模式速查 🟠

```
┌─────────────────────────────────────────────────────────┐
│                    Extension Entry                       │
│  src/extension/index.ts                                  │
│  - 环境检测（父/子进程）                                  │
│  - 状态初始化                                            │
│  - 工具/命令/事件注册                                     │
│  - 生命周期钩子                                          │
├─────────────────────────────────────────────────────────┤
│                   Tool Registration                      │
│  - TypeBox Schema (参数校验 + LLM 文档)                  │
│  - execute() (前台/后台分发)                              │
│  - renderCall() / renderResult() (TUI 渲染)             │
├─────────────────────────────────────────────────────────┤
│                  Execution Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Foreground   │  │  Background   │  │    Chain      │  │
│  │  - spawn      │  │  - detached   │  │ - sequential  │  │
│  │  - streaming  │  │  - file watch │  │ - parallel    │  │
│  │  - progress   │  │  - events     │  │ - fanout      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
├─────────────────────────────────────────────────────────┤
│                  Agent System                            │
│  - Markdown + YAML 定义                                  │
│  - 分层发现 (Builtin → User → Project)                   │
│  - 设置覆盖 (不复制文件)                                  │
│  - Skill 注入                                            │
├─────────────────────────────────────────────────────────┤
│                  Infrastructure                          │
│  - Config Loading  - Artifact Management                 │
│  - Session State  - Intercom Bridge                      │
│  - Model Fallback - Control Notices                      │
│  - Worktree Mgmt  - Acceptance Gates                     │
└─────────────────────────────────────────────────────────┘
```

### 15.2 生产级扩展的 10 个必备能力 🟠

| # | 能力 | pi-subagents 的实现方式 |
|---|------|------------------------|
| 1 | **进程隔离** | 通过环境变量区分父/子角色，子进程跳过完整注册 |
| 2 | **热重载安全** | globalThis 存储清理函数，新实例先清理旧资源 |
| 3 | **后台执行** | 文件系统状态文件 + FSWatcher + 事件投递 |
| 4 | **流式进度** | JSONL 事件流解析 + TUI Container 动态渲染 |
| 5 | **错误恢复** | Model Fallback（多模型降级）+ Stale Run Reconciler |
| 6 | **并发控制** | 并行任务数限制 + 并发度控制 + Worktree 隔离 |
| 7 | **验收门控** | 五级验收（attested → checked → verified → reviewed） |
| 8 | **跨会话通信** | Intercom Bridge + 结构化消息投递 |
| 9 | **嵌套安全** | maxSubagentDepth + 子级工具剥离 + 上下文过滤 |
| 10 | **可观测性** | Doctor 诊断 + Artifact 写入 + 结构化元数据 |

### 15.3 安装与分发 🔵

```bash
# 从 npm 安装
pi install npm:my-extension

# 从本地路径安装
pi install ./path/to/my-extension

# 卸载
pi uninstall my-extension
```

安装脚本 (`install.mjs`) 负责将扩展注册到 `~/.pi/agent/extensions/` 目录。（[历史形态] 现行活跃包 0 个含 install.mjs——pi 字段原生发现即注册，无安装脚本环节。）

---

## 16. 子进程保护入口模式 🟠（子代理专项）

> 进阶，子代理扩展才需要。标准入口见 [§2.1](#21-工厂函数签名-)。

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

**设计含义**：扩展必须考虑它在子进程中被加载的场景，通过环境变量区分角色。

---

## 17. Agent 定义系统（Markdown + YAML Frontmatter）🟠（子代理专项）

> 进阶，子代理扩展才需要。多 agent 配置场景使用。

### 17.1 Agent 文件格式

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

### 17.2 Frontmatter 字段参考

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

### 17.3 Agent 发现机制

```
优先级（低→高）：Builtin → User → Project

Builtin: ~/.pi/agent/extensions/subagent/agents/
User:    ~/.pi/agent/agents/**/*.md
Project: .pi/agents/**/*.md

项目名冲突时 Project 胜出
可通过 agentScope: "user" | "project" | "both" 控制
```

### 17.4 Agent 覆盖（不复制整个文件）

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

## 18. 子进程执行模式 🟠（子代理专项）

> 进阶，子代理扩展才需要。

### 18.1 Pi 子进程架构

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

### 18.2 子进程启动参数构建

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

> **为何禁止裸拼 `--model`**：pi CLI 的 `--model` 是 pattern 非精确 ID（toLowerCase / contains 模糊匹配），「扩展层校验通过」不代表「子进程按此名执行」——裸拼曾致静默换模 429（2026-08-27 事故 A 根因 F1），且白名单外的 `"--model"` 字面量会被 `.githooks/check_subagent_channels.py`（pre-commit + CI）拦截。规则全文见 [extension-conventions.md](./extension-conventions.md)「模型引用解析 [MANDATORY]」。

### 18.3 执行与结果收集

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

## 19. 后台异步执行系统 🟠（子代理专项）

> 进阶，子代理扩展才需要。

### 19.1 异步任务追踪

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

### 19.2 文件系统结果观察器

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

### 19.3 异步状态文件格式

```
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json          # 运行状态（running/completed/failed）
  events.jsonl         # 包装事件 + 子 Pi JSON 事件
  output-<n>.log       # 实时人类可读日志
  subagent-log-<id>.md # Markdown 格式日志
```

> 后台任务的**结果语义通知**（完成/终态投递）必须走确认式送达——持久账本 + notifyId 幂等 + settled 边沿 courier，禁依赖 steer/followUp/nextTurn 内存队列的 at-most-once 通道（约束 C-ext-19，设计见 [pi-boundary-reliability.md](../design/pi-boundary-reliability.md)）。

---

## 20. Chain / Pipeline 执行 🟠（子代理专项）

> 进阶，子代理扩展才需要。多步骤工作流编排。

### 20.1 Chain 定义

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

### 20.2 Chain 执行流程

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

### 20.3 动态扇出（Dynamic Fanout）

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

### 20.4 Chain 文件格式

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

## 21. 跨会话通信（Intercom）🟠（子代理专项）

> 进阶，子代理扩展才需要。父↔子跨进程通信。

### 21.1 Intercom Bridge 模式

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

### 21.2 子→父通信

```typescript
// 子代理使用 contact_supervisor 工具
// reason: "need_decision" —— 阻塞型决策请求
// reason: "progress_update" —— 非阻塞进度更新

// 父端监听
pi.events.on(SUBAGENT_CONTROL_INTERCOM_EVENT, (payload) => {
  deliverIntercomMessage(payload);
});
```

### 21.3 结果投递

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

> 结果语义的跨会话投递同样受 C-ext-19 确认式送达约束（账本 + 幂等键 + courier，见 [pi-boundary-reliability.md](../design/pi-boundary-reliability.md)）。

---

## 22. TUI 渲染系统

> 完整的 TUI 渲染避坑指南（渲染管线/shell 策略、ANSI/宽度/截断、键盘交互/overlay、流式更新/性能）见 [Pi TUI 扩展开发避坑指南](./pi-tui-development-guide.md)。该指南基于 `@zhushanwen/pi-subagents` 20+ 个 TUI 修复 commit 的实战总结，对照无 bug 的参考实现 `pi-subagents` 及 Pi 渲染引擎源码交叉验证，专注「场景 → 怎么做」的可操作经验。本节列基础要点与组件系统。

### 22.1 颜色使用 **[指南]**

使用语义 token 着色，不硬编码 ANSI：

```typescript
// 正确
theme.fg("accent", "Title")
theme.fg("success", "Done")
theme.fg("error", "Failed")
theme.fg("warning", "Caution")
theme.fg("muted", "Description")
theme.fg("dim", "Hint text")

// 错误
"\x1b[32mTitle\x1b[0m"
```

### 22.2 渲染缓存 **[指南]**

频繁重新渲染的组件可缓存结果，数据变化时 `invalidate()`：

```typescript
class MyComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedLines = computeLines(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }
}
```

### 22.3 Markdown 渲染安全降级 **[指南]**

`getMarkdownTheme()` 在不同 Pi 版本中行为不同，渲染异常应降级：

```typescript
export function safeMarkdownTheme(): MarkdownTheme | undefined {
  try {
    const md = getMarkdownTheme();
    if (!md) return undefined;
    md.bold(""); // 触发 Proxy 检查
    return md;
  } catch {
    return undefined;
  }
}
```

### 22.4 Component 接口

```typescript
interface Component {
  invalidate(): void;
  render(width: number): string[];
}

class MyResultComponent implements Component {
  constructor(
    private details: MyDetails,
    private theme: ExtensionContext["ui"]["theme"],
  ) {}

  invalidate(): void { /* 标记需要重新渲染 */ }

  render(width: number): string[] {
    const lines: string[] = [];
    // 使用 theme.fg/bg 进行颜色化
    lines.push(`${theme.fg("toolTitle", theme.bold("Result"))}`);
    lines.push(`${theme.fg("dim", details.summary)}`);
    return lines;
  }
}
```

### 22.5 自定义消息渲染器

```typescript
// 注册消息类型渲染器
pi.registerMessageRenderer<MyDetails>("my-message-type",
  (message, options, theme) => {
    const details = message.details as MyDetails;
    if (!details) return undefined;

    // 返回 TUI 组件（实现 Component 接口）
    return new MyResultComponent(details, theme);
  }
);
```

### 22.6 Widget 系统

持久化状态显示推荐使用 `registerWidget` / `setWidget`：

```typescript
ctx.ui.registerWidget(WIDGET_KEY, (theme: Theme) => {
  return new Text(`my-ext: ${status}`, 0, 0);
});

// 更新 widget
ctx.ui.setWidget("my-widget-key", updatedComponent);
ctx.ui.requestRender?.();

// 清除 widget
ctx.ui.setWidget("my-widget-key", undefined);
```

#### Widget 注入点要区分 TUI vs GUI 主进程

当 widget 内容是从外部流（如 subagent 的 streaming）转发来的，注入逻辑必须区分主进程是 TUI 还是 GUI（xyz-agent）。TUI 主进程没有 GUI sidecar，raw streaming text 灌到 widget 会成噪音。

**正确做法**：`ctx.mode === "rpc"` 守卫。**不要**用 `ctx.hasUI`（TUI 和 RPC 都 true）。

```typescript
// session_start 内
const streamSink = ctx.mode === "rpc"
  ? { setWidget: (key, lines) => ctx.ui.setWidget(key, lines) }
  : undefined;
service.initSession({ pi, streamSink });
```

完整章节（含 `ExtensionMode` 字面量定义、进程边界、与 spawn 参数的区别）：见 `./pi-tui-development-guide.md` 第四部分第 8 节。

### 22.7 实时进度渲染 🟠

```typescript
// pi-subagents 的做法：流式更新
function createLiveResultComponent(
  initialResult: AgentToolResult,
  theme: Theme
): Container {
  const container = new Container();
  let lastVersion = -1;

  container.render = (width: number): string[] => {
    const snapshot = getLatestSnapshot();
    if (snapshot.version !== lastVersion || isRunning(snapshot)) {
      lastVersion = snapshot.version;
      rebuildContainer(container, snapshot, theme);
    }
    return Container.prototype.render.call(container, width);
  };

  return container;
}
```

---

## 23. Acceptance Gates（验收门控）🟠（子代理专项）

> 进阶，子代理扩展才需要。多 agent 质量门控。

### 23.1 验收级别

| 级别 | 说明 |
|------|------|
| `auto` | 自动推断（默认） |
| `none` | 无验收 |
| `attested` | 子代理返回结构化验收报告 |
| `checked` | 运行时结构性检查通过 |
| `verified` | 配置的运行时验证命令通过 |
| `reviewed` | 独立 reviewer 结果存在 |

### 23.2 使用模式

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

## 24. Git Worktree 隔离 🟠（子代理专项）

> 进阶，子代理扩展才需要。并行任务文件系统隔离。

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

---

## 25. 测试与 CI/CD

### 25.1 测试框架选择 **[指南]**

| 场景 | 推荐 |
|------|------|
| 单元测试 | `vitest` |
| 快速验证 | `vitest run <file>`（单文件） |
| 集成测试 | `vitest` |

> **本仓红线**：测试框架统一 vitest，禁止 `node --test` / `node:test` / `tsx --test`（配置在子包 `vitest.config.ts`，从子包目录运行；见项目根 AGENTS.md「测试」节）。

### 25.2 测试分层 🟠

```
test/
├── unit/          # 纯逻辑测试（不依赖 Pi 运行时）
│   ├── schemas.test.ts
│   ├── agent-selection.test.ts
│   ├── model-fallback.test.ts
│   └── chain-serializer.test.ts
├── integration/   # 需要 Pi 运行时的测试
│   ├── single-execution.test.ts
│   ├── chain-execution.test.ts
│   └── async-execution.test.ts
└── support/       # 测试辅助
    ├── mock-pi.ts         # Pi API mock
    ├── mock-pi-script.mjs # 子进程 mock
    └── helpers.ts
```

### 25.3 测试覆盖重点

- 配置加载成功/失败路径
- 状态反序列化旧格式兼容性
- Tool execute 的 success/error 路径
- 信号取消行为
- 防重入逻辑
- 空状态处理

```typescript
describe("state", () => {
  it("handles null input", () => {
    expect(deserializeState(null)).toEqual(createInitialState());
  });

  it("handles partial data (backward compat)", () => {
    const state = deserializeState({ initialized: true });
    expect(state.items).toEqual([]);
  });
});
```

### 25.4 运行方式

```jsonc
{
  "scripts": {
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "test:all": "vitest run"
  }
}
```

### 25.5 Mock Pi API

```typescript
// test/support/mock-pi.ts
export function createMockPi(): ExtensionAPI {
  return {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    events: {
      on: vi.fn(() => vi.fn()),
      emit: vi.fn(),
    },
    getSessionName: vi.fn(() => "test-session"),
    sendMessage: vi.fn(),
    getFlag: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
}
```

### 25.6 CI/CD（GitHub Actions）

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test

# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

# 第三部分：附录

## A. 模块组织指南（按规模）**[指南]**

### A.1 简单扩展（1-3 个 Tool）

```
pi-my-extension/
├── index.ts
├── package.json
├── README.md
└── test/
```

### A.2 中等规模扩展

```
pi-my-extension/
├── index.ts          # re-export
├── package.json
├── src/
│   ├── index.ts      # 工厂
│   ├── state.ts      # 状态
│   ├── types.ts      # 类型
│   ├── config.ts     # 配置
│   └── commands.ts   # 命令
└── test/
```

### A.3 复杂扩展

领域驱动结构（完整范例见 [§1.5 生产级架构蓝图](#15-生产级架构蓝图--)），如：

```
src/
├── extension/   — 入口、tools、commands
├── shared/      — 公用类型、工具、常量
├── runs/        — 领域逻辑（foreground/background）
├── tui/         — TUI 渲染组件
└── slash/       — /command 实现
```

---

## B. 性能指南 **[指南]**

| 场景 | 建议做法 |
|------|---------|
| 并行独立 IO | `Promise.allSettled` 而非 `Promise.all` |
| 批量处理 | 攒一批处理一次，不要逐条处理 |
| 组件初始化 | 延迟初始化（lazy init），用 `ensureXxx()` 模式 |
| TUI 渲染 | 缓存 render 结果，invalidate 触发重算 |
| Entry 增长 | 设上限定期 GC |

---

## C. 反模式清单

### C.1 崩溃风险（P0）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 模块级全局变量 | 多 session 共享状态，数据错乱 | 工厂闭包变量（会话级）/ `globalThis[Symbol.for]`（进程级单例，见 §7.5） |
| 未保护的 ctx 访问 | session 关闭后崩溃 | `isStaleContextError()` 检查 |
| Tool execute 异常逃逸 | 未处理异常带崩 Pi | 内部可 throw，execute 边界 catch 返回 `{ isError: true }` |
| 异步操作无信号 | 无法取消，残留资源 | 透传 `signal` |
| 不设防重入 | 并发操作破坏状态 | `isProcessing` 标志 |
| agent_end 中启动 LLM 调用 | 上下文已过期 | 只做同步清理 |
| `pi.setActiveTools(undefined)` | SDK 不支持 undefined 参数，`for...of` 遍历报 "toolNames is not iterable" | 用 `pi.getAllTools().map(t => t.name)` 获取全量工具名列表传入 |
| Tool 执行函数字段名非 `execute`（如 `handler`/`fn`） | Pi 调 `definition.execute(...)` 拿到 undefined，报 `definition.execute is not a function` | 字段名必须 `execute`（见 §4.4） |
| execute 签名只写 `(params)` 而非 SDK 全签名 | SDK 把 toolCallId 传到第 1 位，params 解构全是 undefined，运行时 NPE | execute 用全签名 `(toolCallId, params, signal, onUpdate, ctx)`，业务函数靠 execute 内联闭包适配（见 §4.4） |
| Factory 顶层注册 tool/command 时传 `runtime!`（`session_start` 才赋值的 null 变量） | factory 执行时 session_start 未触发，`runtime!` 实际是 null，非空断言骗编译器，execute/handler 内 NPE | execute 内联闭包或 getter 延迟到调用时读 runtime（见 §4.5） |

### C.2 结构问题（P1）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 单文件 > 500 行 | 认知负担高 | 按职责拆分 |
| 类型定义散落 | 维护困难 | 集中到 `types.ts` |
| details 与 content 不匹配 | renderResult 解析文本 | details 是唯一数据源 |
| 硬编码路径 | 不可移植 | `path.join(homedir(), ...)` |

### C.3 类型问题（P1）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 未约束的 `any` | 类型链断裂 | 精确类型或 `unknown` |
| `Record<string,unknown>` 无校验 | 字段名拼错不报错 | 白名单 + 入口断言 |
| 跨文件重复 interface | 改一处漏一处 | 统一 `types.ts` |
| 必填字段实际不存在 | 运行时 undefined | 如实标注 `?` |

### C.4 依赖问题（P1）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| Pi SDK 放 dependencies | 多版本冲突 | peerDependencies |
| 不必要的强制依赖 | 安装体积大 | peerDependenciesMeta.optional |
| files 不含入口 .ts | publish 后丢失 | 包含 `index.ts` |

### C.5 TUI 问题（P2）

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 硬编码 ANSI 颜色 | 不随主题变化 | `theme.fg("token", text)` |
| Markdown 主题无 fallback | 异常时崩溃 | `safeMarkdownTheme()` |
| 每帧重建组件 | 性能浪费 | 缓存 + invalidate |
| 无 renderResult | 模型看到 raw JSON | 写渲染函数 |

---

## D. 新扩展检查清单

### 启动阶段（阻塞性问题）

- [ ] `package.json` 含 `type: "module"` 和 `pi.extensions`
- [ ] `package.json` 含 `"pi-package"` keyword
- [ ] `package.json` 不含 `private: true`（除非确定不发布到 npm）
- [ ] `peerDependencies` 引用 `@earendil-works/pi-coding-agent`，且 `optional: true`
- [ ] `files` 包含入口 `.ts`，含 `index.ts` + `src/**/*.ts`
- [ ] 入口 `export default function(pi: ExtensionAPI)`
- [ ] 状态在工厂闭包内，非模块级
- [ ] 进程级单例用 `globalThis[Symbol.for]` 持有，非模块级 `let`（见 §7.5）
- [ ] Tool 执行函数字段名为 `execute`，非 `handler`/`fn`/`callback`（见 §4.4）
- [ ] Tool execute 用 SDK 全签名 `(toolCallId, params, signal, onUpdate, ctx)`，业务函数靠内联闭包适配（见 §4.4）
- [ ] Tool/Command 不在 factory 顶层传 `session_start` 才初始化的 runtime/store 实例——用 getter 或 execute 内联闭包延迟读取（见 §4.5）

### 健壮性阶段（必须通过）

- [ ] 所有 execute 边界 catch 异常并返回 `{ isError: true }`（内部可 throw，错误消息不含堆栈）
- [ ] 异步操作支持 `signal` 取消
- [ ] Stale context 检测 + `safeNotify` 保护
- [ ] 防重入标志保护并发操作
- [ ] finally 块确保资源释放
- [ ] 配置加载失败抛有意义错误
- [ ] 反序列化向后兼容旧 Entry 格式
- [ ] 无模块级 global let 变量
- [ ] 无 `console.log` / `console.info` / `console.warn` / `console.error`（`console.*` 全禁，统一接 `@zhushanwen/pi-extension-logger`；用户操作反馈用 `ctx.ui.notify`）
- [ ] Worker 线程拦截 `console.*`（不泄漏到输入区域）
- [ ] 热重载安全：globalThis 存储清理函数，新实例先清理旧资源（见 §6.4）

### 类型阶段（必须通过）

- [ ] 无 `any`（精确类型或 `unknown`）
- [ ] `Record<string, unknown>` 在白名单中或已消除
- [ ] 跨文件类型集中 `types.ts`
- [ ] 先读后写模式（edit 前 read 确认）

### 代码风格阶段（推荐）

- [ ] 单文件 ≤ 500 行
- [ ] 函数 ≤ 80 行
- [ ] 事件处理器 ≤ 20 行
- [ ] 无硬编码路径（`homedir()` + `path.join()`）
- [ ] 语义 token 着色（无 ANSI 硬编码）

### 文档与分发阶段（推荐）

- [ ] TUI 有 renderResult
- [ ] Tool/Command 有 description
- [ ] README.md 含安装和用法
- [ ] CHANGELOG.md（如发布 npm）
- [ ] 安装脚本 `install.mjs`（如需 `pi install`）

### 子代理专项阶段（🟠 仅 spawn 子进程的扩展需要）

- [ ] 子进程隔离：环境变量检测（见 §16）
- [ ] 后台执行：文件系统状态 + watcher（见 §19）
- [ ] Agent 定义：Markdown + YAML frontmatter（见 §17）
- [ ] Skills：SKILL.md 文件
- [ ] 单元测试：`test/unit/*.test.ts`
- [ ] 集成测试：`test/integration/*.test.ts`
- [ ] CI/CD：GitHub Actions（见 §25.6）

---

## E. 术语表

### 分类标签

| 标签 | 含义 |
|------|------|
| **[规范]** | 必须遵守的规则。违反会导致代码审查不通过或有运行时风险 |
| **[MANDATORY]** | [规范] 的强化形式，违反会直接导致运行时崩溃 |
| **[指南]** | 推荐做法，不遵守不视为违规但应有合理理由 |
| **[核心规范]** | [规范] 中最关键的部分，是 Pi 扩展正常工作的基础 |

### 适用层级

| 标记 | 含义 |
|------|------|
| 🔵 通用 | 所有 Pi extension 适用 |
| 🟠 子代理专项 | 仅 spawn/manage 子 Pi 进程的复杂扩展适用 |

### 关键概念

| 术语 | 说明 |
|------|------|
| **工厂闭包状态** | 在 `export default function(pi)` 闭包内声明的变量，每个 session 独立、随 session 结束消亡（§2.3） |
| **进程级单例** | 跨 session 存活的对象，用 `globalThis[Symbol.for]` 持有，在 `session_start` 时懒创建/重建（§7.5） |
| **jiti 双路径加载** | jiti 用模块路径字符串做缓存 key，同一模块被两个路径字符串引用会加载成两个独立 instance（§7.5、§9.1） |
| **Stale Context** | Session 关闭后过期的 ctx，访问它会抛 "Extension context no longer active"（§11.1） |
| **热重载** | Pi 支持扩展热重载，新实例加载时必须先清理旧实例的定时器/监听器/文件监视器（§6.4） |
| **Entry 持久化** | 通过 `pi.appendEntry()` 写入、`ctx.sessionManager.getEntries()` 读取的会话持久化机制（§7.2） |
| **details 契约** | execute 返回的 `details` 是 `renderResult` 的唯一数据来源，不能解析 `content` 文本（§4.7） |

---

## F. 参考仓库列表

| 仓库 | 复杂度 | 核心能力 |
|------|--------|----------|
| `nicobailon/pi-subagents` | ★★★★★ | 子代理系统、Chain/Pipeline、异步执行、Intercom、Worktree |
| `nicobailon/pi-mcp-adapter` | ★★★★ | MCP 协议适配、OAuth、UI Server |
| `baphuongna/pi-crew` | ★★★★ | 团队编排、工作流、并发调度 |
| `pi-interactive-shell` | ★★★ | PTY 会话管理 |
| `pi-skills` | ★★ | Skill 定义示例 |
| `oh-pi/packages/subagents` | ★★★★★ | pi-subagents 的企业 fork（@ifi scope） |

> 本指南亦基于对 Pi 生态社区 15+ 扩展（pi-mono SDK、pi-mcp-adapter、pi-subagents、pi-web-access、pi-context-prune、pi-ask-user、pi-powerline-footer、pi-model-switch、pi-hashline-edit、pi-rtk、pi-interactive-shell、pi-design-deck、pi-coordination、pi-askuserquestion 等）及 xyz-pi-extensions 项目自身实践的逆向分析总结。
