# Pi Extension 术语表

> 本术语表整合自 xyz-pi-extensions 项目的 CONTEXT.md。收录 pi 平台通用术语与 xyz-agent ↔ pi 边界概念。
> 各 extension 的专属概念已迁至对应包 README（goal / todo / permission / plan / subagent-workflow 等）或随包退役删除（2026-09-13 清理）。

---

## Pi 平台层

**Extension**
TypeScript 模块，通过 `export default function(pi: ExtensionAPI)` 注册到 Pi 运行时。可注册 Tool、Command、Event Handler、UI 组件。放置于 `~/.pi/agent/extensions/` 或 `.pi/extensions/`。

**ExtensionAPI**
Pi 传递给 Extension 工厂函数的 API 对象。提供 `registerTool()`、`registerCommand()`、`on()`、`registerMessageRenderer()`、`appendEntry()` 等方法。

**Tool**
Extension 通过 `pi.registerTool()` 注册的能力单元。定义 name、parameters schema、execute handler、renderCall/renderResult。模型通过 function calling 调用。

**Command**
Extension 通过 `pi.registerCommand()` 注册的用户命令，以 `/` 开头。用户在编辑器中输入触发，不由模型调用。

**Event**
Pi 运行时生命周期事件。Extension 通过 `pi.on(event, handler)` 监听。核心事件：`session_start`、`before_agent_start`、`agent_start`、`turn_end`、`message_end`、`agent_end`、`session_shutdown`。

**Session**
一次 Pi 对话的完整生命周期。以 JSONL 文件持久化，支持树状分支。状态通过 `ctx.sessionManager` 访问。

**Entry**
Session 中的单条记录。`ctx.sessionManager.getEntries()` 返回全部，`ctx.sessionManager.getBranch()` 返回当前分支。Extension 通过 `pi.appendEntry(type, data)` 写入自定义记录，通过 `type === "custom" && customType === "..."` 读取。

**CustomEntry**
带 `customType` 字段的 Entry，用于 Extension 持久化私有状态。写入：`pi.appendEntry("my-type", data)`；读取：过滤 `entry.type === "custom" && entry.customType === "my-type"`。

**Theme**
TUI 颜色系统。通过 `ctx.ui.theme.fg(token, text)` 使用语义 token（如 "toolTitle"、"success"、"error"）着色，不硬编码 ANSI。

**Agent**
`.md` 文件定义的 agent 配置，包含 frontmatter（name、description、tools）和 body（systemPrompt）。放置于 `~/.pi/agent/agents/`（user 级）或 `.pi/agents/`（project 级）。

**Context Files**
`AGENTS.md` 或 `CLAUDE.md`，作为系统提示词的一部分加载。从 `~/.pi/agent/`、父目录、当前目录自动发现并拼接。

**Skill**
On-demand 能力包，Markdown 格式。通过 `/skill:name` 触发或由 agent 自动加载。放置于 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`。

**Prompt Template**
可复用的提示词模板，Markdown 格式，支持 `{{variable}}` 插值。通过 `/name` 展开。

**Steering**
Pi 的消息投递机制之一。`deliverAs: "steer"` 在当前 assistant turn 执行完 tool call 后注入，高优先级。用于目标更新、预算警告等需要立即响应的场景。

**Follow-up**
Pi 的消息投递机制之一。`deliverAs: "followUp"` 在 agent 完成所有工作后注入，低优先级。用于常规 continuation。

**Compaction**
长 session 的上下文压缩机制。将旧消息摘要，保留近期消息。有损操作，完整历史保留在 JSONL 中。

**Pi Package**
Extension + Skill + Prompt Template + Theme 的分发单元，通过 npm 或 git 安装。

### pi 边界可靠性（xyz-agent ↔ pi，pi-boundary-reliability 2026-08-28）

**语义吸收层**
xyz-agent 与 pi 之间对 pi 私有语义的统一适配层（ADR-0064）：推断与跨边界承诺只在边界一次吸收（能力注册表 / 生效回执 / 确认式送达 / 漂移守卫四支柱），域内只剩确定性。EventAdapter 只适配传输格式，语义适配归本层。

**能力注册表**
runtime `model-capability.ts` 单点服务面：模型全等 id / reasoning / 支持思考档位等 pi 能力事实唯一进入点（pi-ai 同源计算 + get_available_models 对账），以 supportedLevels 下发；renderer/扩展禁止本地推断档位（C-pi-12）。

**生效回执**
改状态 RPC 的 reply 一律回 pi 实际生效值（钳制时 ≠ 请求值），消费方禁乐观写请求值（C-pi-13）。

**确认式送达**
结果语义通知的送达形态：持久账本 + 幂等键（notifyId）+ settled 边沿 courier（投递员，销账即确认）at-least-once 重放——账本、销账、courier 归并于本条。禁依赖 pi steer/nextTurn 内存队列的 at-most-once 通道（C-ext-19）；交互式注入仅限非结果语义。

---

## Flagged Ambiguities（易混淆点）

**"任务"统一到 Todo**
Goal 不内嵌任务系统，任务管理统一到 Todo 扩展。Goal 通过只读快照接口读取 Todo 进度，验证任务通过提示词引导由 AI 以独立 todo 承载（无结构化标记字段）。
