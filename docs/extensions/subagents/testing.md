# subagent-workflow 测试方法论

> 本文档记录 `@zhushanwen/pi-subagent-workflow` 的测试分层策略与执行方法，指导后续测试编写。
> 源自 2026-07-30 修复「所有内置 workflow 100% 崩溃」时的经验沉淀——两个根因 bug 都是
> 「生成代码从未被真实执行」导致的，光靠字符串断言测不出来。

## 测试分层

subagent-workflow 有三层测试，覆盖度逐层提升，执行成本也逐层上升：

| 层 | 测试文件 | 验证范围 | 真实性 | 成本 |
|----|---------|---------|--------|------|
| **L1 字符串断言** | `worker-script-builder.test.ts` | 生成的 worker 源码**包含**特定子串（函数声明、消息协议字面量） | 最低——只读字符串，从不执行 | 极低（2ms） |
| **L2 Worker 运行时** | `worker-script-builder-runtime.test.ts` | 生成的 worker 源码在**真实 `node:worker_threads` Worker** 里执行正确（return/throw/agent/abort/workflow 链路） | 中——真实 Worker thread，mock 主线程回发消息 | 低（~100ms） |
| **L3 Workflow E2E** | `workflows-e2e.test.ts` | 5 个内置 workflow 通过**完整编排链路**（registry→lint→runWorkflow→真实 Worker→脚本→agent/parallel 编排→outcome 聚合） | 高——唯一 mock 的是 LLM 本身（AgentRunner） | 中（~2s） |

### 为什么需要三层

历史教训：曾长期只有 L1（字符串断言），导致两个严重 bug 长期潜伏：

1. **`_safePost` 作用域 bug**：`_safePost` 定义在 async IIFE 内部，却在 IIFE 外部的 `.then()/.catch()` 里使用。脚本每次 return 都触发 `ReferenceError` → Worker exit 1 → 所有 workflow 失败。L1 只断言"包含 `_safePost`"，测不出它能否被 `.then` 访问到。
2. **`parallel()` Promise 数组 bug**：`parallel([agent({...}), ...])` 传 Promise 数组时，实现把 Promise 当 opts 传给 `agent()` → `DataCloneError`。L1 只断言"包含 `parallel` 函数"，测不出它怎么处理 Promise 项。

两个 bug 都是**生成代码的运行时行为错误**，只有真正执行才能暴露。L2 和 L3 就是为补这个缺口而建。

## L1：字符串断言（快速守护）

文件：`packages/subagent-core/src/orchestration/__tests__/worker-script-builder.test.ts`

**用途**：快速验证生成的 worker 源码结构——注入了哪些全局函数、消息协议字面量、postMessage 防御包装。

**局限**：只能证明"代码包含某子串"，不能证明"代码能正确执行"。**新增功能时 L1 可作为快速反馈，但必须有 L2/L3 兜底。**

**维护要点**：断言应描述**语义**而非具体变量名。例：
```typescript
// 好：描述 postMessage 被包装在 try 里（语义）
expect(script).toMatch(/_safePost[\s\S]*?try \{ _parentPort\.postMessage\(msg\)/);
// 差：绑死行号或易变的内部细节
```

## L2：Worker 运行时执行（核心回归防线）

文件：`packages/subagent-core/src/orchestration/__tests__/worker-script-builder-runtime.test.ts`

**用途**：起真实的 `node:worker_threads.Worker`，执行 `buildWorkerScript(userScript)` 的产物，验证生成的代码在真实 Worker 线程里行为正确。

### 测试 harness 模式

```
测试主线程                          Worker 线程（真实）
─────────────                      ──────────────────
new Worker(buildWorkerScript(   →   执行注入的 infra + 用户脚本
  userScript), {eval:true})
                                   脚本调 agent() → postMessage(agent-call)
收到 agent-call ←─────────────────  
回发 agent-result ─────────────────→  message handler resolve pending
                                   脚本 return → .then → _safePost(return)
收到 return ←──────────────────────  
断言 returnValue / exitCode        
```

核心辅助函数 `runWorker(userScript, opts)`：
- 创建真实 Worker（`new Worker(code, {eval:true, workerData})`）
- 主线程模拟 workflow runtime：收到 `agent-call` 回发 `agent-result`，收到 `workflow-call` 回发 `workflow-result`
- 收集 `return`/`error` 消息 + exit code + worker error 事件
- 超时保护（CI 5s / 本地 2s，防 Worker 卡死挂起测试）
- `afterEach` 兜底 `terminate()` 所有 Worker（防泄漏）

### 必须覆盖的路径

| 路径 | 为什么重要 |
|------|-----------|
| 脚本正常 `return` | 验证 `.then` 里的 `_safePost` 可达（作用域 bug 回归点） |
| 脚本 `throw` | 验证 `.catch` 里的 `_safePost` 可达 + workerLogs 带回（诊断不丢） |
| `agent()` ↔ `result` 链路 | 验证消息协议 + pending Promise resolve |
| `parallel([agent(...)])` **Promise 数组** | 验证 thenable 鸭辨（DataClone bug 回归点）。**注意：必须用 Promise 数组写法，不是函数数组** |
| `parallel([() => agent(...)])` 函数数组 | 验证函数项 `c()` 调用 |
| `abort` 消息 | 验证 pending reject → WorkflowAbortedError |
| `workflow()` 嵌套调用 | 验证 workflow-call ↔ workflow-result（与 agent 共享 `_pendingCalls`） |
| `module.exports.execute()` 入口 | 验证 CC 兼容的另一种脚本入口（也走 `.then`） |

**关键教训**：`parallel()` 的测试必须同时覆盖**函数数组**和 **Promise 数组**两种写法——内置脚本用 Promise 数组，早期测试只用函数数组所以没抓到 bug。

## L3：Workflow E2E（完整编排链路）

文件：`extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts`

**用途**：验证 5 个内置 workflow（parallel/chain/map-reduce/scatter-gather/review-fix-loop）通过真实的 `runAndWait()` 编排链路执行成功。

### 设计：真实一切，除 LLM

调用真实的 `runAndWait(name, args, deps)`（`launcher.ts`），它内部完整执行：
1. `deps.registry.get(name)` — 加载真实 `.js` 脚本
2. `script.validate()` — lintScript 校验
3. `runWorkflow(spec, deps)` — 起真实 `WorkerHostImpl`（`node:worker_threads`）
4. 脚本内 `agent()`/`parallel()` → worker `postMessage(agent-call)` → 主线程 `deps.runner.run()`
5. 脚本聚合 → `return outcome` → `runAndWait` 返回 `WorkflowRunResult`

**唯一 mock：`deps.runner`（AgentRunner 接口）**。真实 runner 会经引擎 CLI 进程（pi-subagent-cli）按协议执行 run——引擎再 spawn pi rpc 任务子进程调 LLM（两层进程嵌套），这在 CI 里不可控（需 API key + 模型 provider）。mock runner 根据 `opts.schema` 用 `generateFromSchema()` 生成符合 schema 的占位数据。

```
真实组件                          mock 组件
────────                          ────────
WorkerHostImpl (worker thread)    AgentRunner.run() ← 根据 schema 生成假数据
JsonlRunStore (真实持久化, 临时目录)  
WorkflowScript (真实 .js 脚本)     
runAndWait → runWorkflow 链路      
```

### 断言标准

每个 workflow 必须满足：
- `result.status === "done"`（runAndWait 恒返回 done）
- `result.reason === "completed"`（脚本正常 return，非 failed/aborted/time_limited）
- `result.scriptResult.status` 匹配 `/^(ok|partial)$/`（脚本层 outcome，**不是** `"error"`）
- `result.error` 为 undefined

### 为什么 registry 要绕过

`WorkflowScriptRegistryImpl` 扫描固定约定目录（`.pi/workflows/`、`~/.pi/agent/workflows/`），无法指向 `packages/subagent-core/workflows/`。测试用 `loadWorkflowsFromDir()` 直接读 `.js` 文件 + 手动构造 `WorkflowScript` 对象，包装为满足 `WorkflowScriptRegistry` 接口的自定义 registry。**不修改源码。**

### mock runner 的 schema 驱动数据生成

`generateFromSchema(schema)` 递归遍历 JSON schema，按 type 生成占位值：
- `string` → `"mock"`
- `number`/`integer` → `7`
- `boolean` → `true`
- `array` → 对象 items 给 2 项（scatter-gather 的 subtasks 需 ≥1 项才能进 process 段），基本类型给 1 项
- `object` → 按 properties 递归

这让 mock runner 对任意 schema 都能返回合规数据，无需为每个 workflow 硬编码。

## 新增 workflow 时的测试检查清单

1. **L2 运行时覆盖**：新 workflow 若用了新的全局函数组合（如新的 `pipeline()` 模式），在 `worker-script-builder-runtime.test.ts` 加对应路径
2. **L3 E2E**：新内置 workflow 必须在 `workflows-e2e.test.ts` 加一个 `it`，调用 `runAndWait` 验证 `reason=completed` + `outcome.status != error`
3. **参数校验**：E2E 测试传真实必需参数（参考各 workflow 的 `$ARGS` 校验逻辑）
4. **mock 数据合规**：若新 workflow 的 agent schema 有特殊字段，确认 `generateFromSchema` 能生成合规值（否则脚本聚合时出错）

## 运行命令

```bash
# 单独跑三层测试（L1/L2 在 subagent-core，L3 在 shell 包）
cd packages/subagent-core
npx vitest run src/orchestration/__tests__/worker-script-builder.test.ts           # L1
npx vitest run src/orchestration/__tests__/worker-script-builder-runtime.test.ts   # L2
cd extensions/universal/subagent-workflow
npx vitest run src/__tests__/workflows-e2e.test.ts                                  # L3

# 全量
pnpm test

# 全量 typecheck（测试文件不在 tsc 覆盖范围，靠 vitest 暴露类型错误）
pnpm typecheck
```

## 为什么不做「真实 pi 子进程」E2E

理论上最真实的 E2E 是 spawn 真实 `pi` 进程跑完整 workflow（含真实 LLM 调用）。但：

1. **必须调 LLM**：workflow 内部 `agent()` → `executeAgentCall` → spawn pi 子进程 → 调 model provider API。无法绕过（无"不调 LLM"的钩子）。
2. **需要 API key + 扩展安装 + provider 配置**：CI 环境不可控。
3. **本仓库无先例**：整个 monorepo 没有任何测试起真实 pi 子进程。现有的 `.xyz-harness/subagent-e2e-test-prompt.md` 是人工手动执行的 E2E，非自动化。

L3（mock LLM runner）是最佳平衡：验证除 LLM 本身外的**全部**编排链路（含真实 worker thread、真实脚本执行、真实 runWorkflow 生命周期），唯一 mock 的是不可控的 LLM 调用。两个历史 bug（作用域 + Promise）都能被 L3 抓到——它们都是编排层 bug，不是 LLM bug。

如需真实 LLM 的端到端验证，走人工 E2E（`.xyz-harness/subagent-e2e-test-prompt.md` 范式），不放进自动化 CI。

## 标记说明

| 标记 | 含义 |
|------|------|
| L1/L2/L3 | 测试分层（字符串断言 / Worker 运行时 / Workflow E2E） |
