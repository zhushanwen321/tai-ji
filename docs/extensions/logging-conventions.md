# Extension 日志规范

> 适用于：`@zhushanwen/pi-*` 全部 extension 包。
> 约束：不改 pi 宿主源码。所有日志行为在 extension 层完成。
>
> **定位声明（现行 SSOT）**：本文档是 extension 日志的唯一权威源。[development-guide.md](./development-guide.md) §10 历史版本允许的「`console.warn`/`console.error` 带前缀」方案已由本文档收敛为禁止（见「关键约束」与迁移指南）。本文档所载约束登记于 [docs/constraints.json](../constraints.json)（架构约束登记 SSOT）。

## 问题背景

pi 宿主层（`ExtensionAPI` / `ExtensionContext`）**不提供 logger 接口**。Extension 跑在 pi 主进程内（in-process，非子进程），其 `console.*` 输出直接进 pi 主进程的 stdout/stderr。在 TUI alternate-screen 模式下，raw stderr **越过渲染层污染 input 区**，且 pi 既不捕获也不落盘 extension 的 console 输出。

历史上各 extension 的日志做法不统一：
- `subagent-workflow`：59 处裸 `console.*`（error 29 / warn 25 / debug 5），直接污染 TUI
- `unified-hooks`：探索出 `ctx.ui.notify` + `pi.appendEntry` 范式，但 notify 用于诊断信息会刷屏

本规范统一收敛到**三层通道分类**。

## 三层通道分类

每条日志按**受众**路由，选择唯一正确的通道：

| 受众 | 通道 | 场景 | TUI 可见 | 进 LLM 上下文 | 持久化 |
|------|------|------|----------|--------------|--------|
| **AI 实时** | tool result / block reason（pi 原生） | hook block、tool 执行错误——AI 据此修正行为 | 对话流内 | 是 | session.jsonl (message entry) |
| **事后排查** | `logger.warn` / `logger.error` → `pi.appendEntry` | 内部降级、竞态、manifest 失败、IO 清理失败 | **否** | **否** | session.jsonl (custom entry) |
| **开发者调试** | `logger.debug` → 文件日志 | 开发期深度排查，默认 no-op | **否** | **否** | `~/.pi/agent/logs/<extName>-YYYY-MM-DD.log` |
| **用户操作反馈** | `ctx.ui.notify`（直接调，不经 logger） | 用户主动触发命令的结果（如 `/workflow list` 执行结果） | 通知区 | 否 | 否 |

### 关键约束

1. **禁止裸 `console.*`**——raw stderr 在 TUI 下污染 input 区，且不落盘
2. **`notify` 只给用户操作反馈**——诊断信息不用 notify（会刷屏），走 `logger.warn`/`error`
3. **tool error 不需要额外 notify**——pi 原生 tool result 已在对话流里显示给用户和 AI，再 notify 是冗余
4. **hook block reason 不走 logger**——直接 `return { block: true, reason }`，pi 自动作为 tool error 回灌 AI

### appendEntry 不进 LLM 上下文的技术依据

pi 的 `session-manager.js` 明确注释（`sessionEntryToContextMessages`）：

> Plain custom entries are display/state entries and do not participate in context.

custom entry 只持久化到 session.jsonl，**不被序列化进 LLM 的 conversation messages**。这使其成为「事后排查」的理想通道——不消耗 token，用户运行时不直接看到，重开 session 后可从 JSONL 复盘。

## `@zhushanwen/pi-extension-logger` 用法

共享 logger 包：`extensions/shared/extension-logger/`。

### 基本用法（extension 初始化层）

```ts
import { createLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";

export default function myExtension(pi: ExtensionAPI): void {
  // 1. 最早期注入 pi handle（让全局 logger 都能走 appendEntry）
  setPiHandle(pi);

  // 2. 创建具名 logger
  const logger = createLogger("my-ext", pi);

  // 3. 使用
  pi.on("session_start", async (_event, ctx) => {
    try {
      await initSomething();
    } catch (err) {
      // 内部降级 → appendEntry 持久化，不显 TUI，不进 LLM
      logger.error("init failed", { reason: String(err) });
    }
  });
}
```

### 深层代码（拿不到 pi 的执行层）

深层代码（worker、orchestration engine、best-effort helper）用 `getLogger` 拿全局 singleton，无需逐层透传 pi：

```ts
import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("subagents");

// best-effort IO 清理失败——降级，不阻断主流程
try {
  fs.unlinkSync(markerFile);
} catch (err) {
  logger.debug(`marker cleanup failed: ${err instanceof Error ? err.message : err}`);
}
```

`getLogger` 返回的 logger 在 `setPiHandle` 注入 pi 后自动生效 appendEntry（闭包读全局实时值，不是创建时的快照）。注入前 `warn`/`error` 降级到文件日志。

### debug 文件日志

默认 no-op。开发期开启：

```bash
XYZ_AGENT_DEBUG=1 pi          # DEBUG 全量：所有用 getLogger 的 extension 都写文件日志
XYZ_AGENT_EXT_LOG=1 pi        # INFO 级落盘：debug() 重标 info 写入（xyz 托管环境由 runtime spawn 时注入此变量 + 7 天保留期清理）
```

日志位置：`~/.pi/agent/logs/<extName>-YYYY-MM-DD.log`（或 `$PI_CODING_AGENT_DIR/logs/`——xyz-agent 隔离环境为 `~/.xyz-agent/pi/agent/logs/`）。

> **统一开关**：所有 extension 的 debug 开关统一使用 `XYZ_AGENT_DEBUG=1`（DEBUG 全量）/ `XYZ_AGENT_EXT_LOG=1`（INFO 级观测档），不要新增 `PI_*_DEBUG` / `PENDING_DEBUG` 这类 per-extension 变量；未接入共享 logger 的 extension 也应读取同一个变量。

### best-effort 清理失败默认静默 [IMPORTANT]

`bestEffort` helper（`subagent-workflow/src/execution/best-effort.ts`）默认用 `logger.debug` 记录 sidecar 写入 / worktree remove / alive marker 删除等次要 IO 的失败。`logger.debug` 默认是 no-op——**生产默认配置下这些清理失败完全静默**（既不显 TUI，也不进 appendEntry）。

这是**预期设计**：best-effort 清理失败属预期路径（session 已完成或正在收尾），失败不影响主流程，故不刷屏、不持久化。代价是生产排障看不到这些失败。

**排障方法**：怀疑清理未生效时，用 `XYZ_AGENT_DEBUG=1` 重启 pi，相关失败会写入 `~/.pi/agent/logs/subagents-YYYY-MM-DD.log`，grep `best-effort` 即可定位（如 `best-effort sidecar teardown failed` / `best-effort worktree cleanup failed`）。

> 迁移注记：历史上 `bestEffort` 用 `console.debug`（始终可见），迁移到共享 logger 后改为 `logger.debug`（默认 no-op）。这是 logging-conventions 收敛的副作用——次要清理噪音不再默认可见，换取 TUI 不被污染。

### notify（不经过 logger）

用户操作反馈直接调 `ctx.ui.notify`，logger 刻意不封装（它是 UI 决策）：

```ts
pi.registerCommand("my-cmd", async (_args, ctx) => {
  const result = await doWork();
  // 用户主动触发的命令结果 → notify（通知区可见）
  ctx.ui?.notify(`Done: ${result.count} items`, "info");
});
```

### session-delivery / notify-ledger 的 warn 出口（确认式送达可观测性）

`@zhushanwen/pi-session-delivery` 内核的投递失败警告默认 `console.warn`（stderr tee 不到日志盘、排查无痕）——接入方必须参数化接到 extensionLogger（先例：subagent-workflow notifier 的 `warn: (msg, err) => notifyLogger.warn(msg, err)`，pi-boundary-reliability U4 对接点）。notify-ledger 的投递计数三桶（`settleRejected` / `watchdogReplays` / `recoveryReplays`）增量同样经 `logger.warn` 落 extensionLogger（`notify delivery bucket [<bucket>]`）——排查「结果语义通知没送到」（C-ext-19 账本通道）先 grep 这两类 warn。

## 迁移指南（从裸 console 收敛）

| 旧代码 | 新代码 | 说明 |
|--------|--------|------|
| `console.error("[subagents] X failed:", err)` | `logger.error("X failed", { reason: String(err) })` | appendEntry 持久化 |
| `console.warn("[subagents] skip Y:", id)` | `logger.warn("skip Y", { id })` | appendEntry 持久化 |
| `console.debug("[subagents] Z intermediate", detail)` | `logger.debug("Z intermediate", detail)` | 默认 no-op，开发期文件日志 |
| `ctx.ui.notify("[ext] internal error", "warning")` | `logger.error("internal error")` | 诊断信息不刷屏 |
| `return { block: true, reason: "..." }` | 不变 | hook block 是给 AI 的正确通道 |
| `ctx.ui.notify("Command done", "info")` | 不变 | 用户操作反馈保留 notify |

## 事故教训 [HISTORICAL]

### streaming renderCall 噪音（2026-08-01）

`subagentRenderCall` 在 LLM 流式生成 tool arguments 时，对部分 JSON 做 model 解析。每个 token delta 到达时 pi 核心调 `parseStreamingJson(累积部分字符串)`，产出截断的 model 值（如 `"deep"` / `"deepseek-router/d"`）→ `renderCall` 报 `Model "deep" not found` → `console.debug` 打印。

根因：`renderCall` 是 TUI 渲染回调，`message_update`（流式）每次 invalidate 都触发。streaming 中间态的解析失败是**预期行为**（注释写了"降级不显示 model 是设计意图"），但 `console.debug` 把它打成了看似错误的信息。

修复：`console.debug` → `logger.debug`（默认 no-op）。streaming 中间态不是真实错误，不需要 appendEntry。

### tool-error-handler notify 冗余（2026-08-01）

`tool-error-handler.ts` 对每个 `tool_execution_end`（isError=true）调 `ctx.ui.notify(msg, "warning")`。但 tool 执行错误已通过 pi 原生 tool result 链路在对话流里显示——notify 是冗余的二次通知，且措辞"bash error"误导（实际可能是 hook 的 block reason）。

修复：移除 notify，保留 `appendEntry`（事后排查价值）。

### raw stderr 污染 TUI input 区

原 unified-hooks 包（2026-09 已删除，`git log --follow` 可查）的调试教训明确记录：

> 禁止用 console.warn（raw stderr 在 TUI alternate screen 下会越过渲染层污染 input 区）

这是 unified-hooks 经过 painful 调试后总结的教训，固化为本规范的核心约束。
