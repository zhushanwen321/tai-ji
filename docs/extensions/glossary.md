# Pi Extension 术语表

> 本术语表整合自 xyz-pi-extensions 项目的 CONTEXT.md。收录 pi 平台通用术语和各 extension 的核心概念。
> 这是 pi extension 开发的必备词汇表。

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

## Extension 专属概念

以下术语属于具体 extension，是该 extension 的核心设计概念。

### Goal（pi-goal）

**Goal**
用户通过 `/goal <objective>` 发起的持久化自主循环。有预算约束、7 态状态机、与 Todo 扩展集成的任务清单。

**GoalStatus**
Goal 的生命周期状态，共 7 种：`active`（驱动 agent 循环）/ `paused`（用户暂停）/ `blocked`（agent 卡住）/ `complete`（终态，任务完成有证据）/ `budget_limited`（终态，token 耗尽）/ `time_limited`（终态，时间耗尽）/ `cancelled`（终态，用户清除）。

**Evidence**
Agent 声明 goal 完成时必须提供的具体验证信息。防止无证据标记完成。

**Budget**
Goal 的资源约束：Token Budget（token 上限）+ Time Budget（时间上限）。

**Verification Todo（验证任务）**
通过提示词引导 AI 为验证步骤（如跑测试 / typecheck）单独添加的 todo 项。无结构化标记字段，验证任务与普通任务在数据模型上无区别。

### Todo（pi-todo）

**Todo**
任务管理扩展。Goal 任务管理的唯一来源。Todo 项四态：`pending` / `in_progress` / `completed` / `cancelled`。

### Subagent（pi-subagent-workflow）

**Subagent**
通过 Pi SDK 在进程内或子进程创建独立 session 执行委派任务。主 agent 与 Subagent 之间通过 task prompt（下行）和事件回调（上行）通信。

**Execution Mode**
Workflow 脚本中 Subagent 的执行模式：Single（单 agent 单 task 阻塞）/ Parallel（多 agent 并发）/ Pipeline（串行链式）。

**Background Job**
`background: true` 模式下的 Subagent 运行实例。结果走**确认式送达**（见上方「确认式送达」词条）：notify-ledger 持久账本 + settled 边沿 courier + notifyId 幂等 at-least-once，内核单通道 `pi.sendMessage({ triggerTurn: true })` 投递——steer/followUp/nextTurn 通道已删除，禁依赖内存队列 at-most-once（C-ext-19）。

**AgentRuntime**
Subagent 执行的底层运行时。提供 agent session 管理、agent 发现、配置合并、模型解析、tool 过滤、并发控制、事件桥接等能力。编排层（workflow）通过 `runAgent()` 或 `createSession()` 调用。

**ManagedSession**
AgentRuntime 提供的可控 agent session。创建后可多次 `prompt()`、`steer()`、`abort()`，不自动销毁。供编排层的多步执行（chain）使用。

**AgentScope**
Agent 定义文件的发现范围：`user`（`~/.pi/agent/agents/`）、`project`（`.pi/agents/`）、`both`。

**TaskComplexity**
任务复杂度等级，用于自动模型选择：`low`（简单快速）、`medium`（中等）、`high`（复杂）。

**ThinkingLevel**
模型的推理深度：`high`（标准推理）或 `max`（最大推理）。按 TaskComplexity 默认：low→high, medium→high, high→max。

### Context Engineering（pi-context-engineering，已删除）

**L0 / L1 / L2**
三级压缩管道：L0 零成本清理 / L1 规则化摘要 / L2 紧急截断。增强（不替代）原生 Compaction。

**Recall**
LLM 通过 `recall_context` 工具按 ID 获取被压缩前的原始内容。压缩的可逆性保障。

**RecallStore**
内存 Map，存储被压缩消息的原始内容。ID 格式 `ctx-{12hex}`。无持久化，`session_start` 时重建。

**Protected Turn**
最近 N 个 Turn Boundary，其中的 toolResult 不被压缩。N 由 `protectRecentTurns` 配置（默认 2）。

**Turn Boundary**
以 user 消息为分界的消息分组，用于判断 Protected Turn 范围。

### Permission（pi-permission）

**Permission Mode**
四档权限模式，按严格等级：`yolo`（放行）/ `auto`（AST+规则+AI 三层管道）/ `approve`（规则+人工）/ `strict`（全审批）。

**Permission Pipeline（三层管道）**
auto 模式的安全检查管道：层 1 AST 结构分析 → 层 2 规则匹配 → 层 3 AI Classifier + 用户审批竞速。任一层 allow 放行，deny 拒绝，ask 流向下游。

**Permission Decision**
checkPermission 的返回值，三态 `action`（allow/deny/ask）+ `reason` + `source`（mode/ast/rule/ai/user）。checkPermission 永不 throw（fail-closed：异常 → ask）。

**Permission Rule**
层 2 规则匹配单元，字段含 `id`/`tool`（wildcard）/`pattern`/`action`（allow/deny/ask）/`source`（builtin-safe/builtin-danger/user）。last-match-wins 语义（user 可覆盖 builtin）。

**AST Structure Analysis（层 1）**
bash 命令的 tree-sitter-bash 结构分析。非白名单节点（command_substitution/subshell 等）→ 流向下游审批。fail-closed：解析异常 → ask。

**AI Classifier（层 3）**
auto 模式的 LLM 风险分类器，输出 `risk_level`（low/medium/high）+ `outcome`（allow/deny/ask）。与用户审批 UI 并行竞速。

### Workflow（pi-subagent-workflow）

**External State Pointer**
session JSONL 中指向外部 state 文件的轻量 entry（`customType === "workflow-state-link"`）。解决主 JSONL 膨胀问题。

**Approval Memory**
session-level 持久化已确认 workflow 名称集合，跨 session_start 重建。`workflow-run` tool 的 auto 模式走此 cache 避免重复弹 confirm。

**State-Lost**
workflow 终态，表示外部 state 文件不可读（删除/损坏/权限拒绝），无法 rehydrate。属 TERMINAL_STATUSES，无 outgoing transitions。

**Verification Strategy**
workflow 节点验证模式分类，可选值 `internal` / `follow-up` / `none`。是 debug 辅助，不强制 AI 标注。

### Goal（pi-goal）补充术语

**Steering Template**
Goal 扩展的四种提示词模板：Continuation（每 turn 注入驱动下一轮）/ Budget Limit（90% 时收尾）/ Objective Updated（目标变更时）/ Context Injection（before_agent_start 注入上下文）。

**Budget Warning**
预算消耗的两阶段预警：70% 提示注意，90% 提示收尾。token 和时间预算共享预警 flag。

**Stall（已废弃概念）**
V2 重构删除了 stallCount/maxStallTurns 自动终态机制。停滞检测退化为基于单任务级 `lastUpdatedTurn` 的提示词提醒，不再自动转 blocked。

### Evolve 自进化系统（pi-evolve-daily，已删除）

**Detector**
被动观测器。监听 Pi 事件 → match() → appendEntry() 写入数据，不解入 AI 行为。适用于纯统计场景。AI 不知道自己在被追踪。

**Tracker**
主动引导器。监听 Pi 事件 → steering 注入 → AI 调用 tool 汇报状态 → 状态机流转。适用于需要 AI 自我汇报的场景。

**TrackedItem**
Tracker 状态机中的单个实例。包含 id、name、status（loaded/completed/error/recorded）、metadata、anchor。

**Anchor**
TrackedItem 中的数据锚点字段（triggerType/triggerTurn/triggerSummary），记录触发事件的时间位置和摘要。供 L3 extractor 在 session JSONL 中定位原始上下文。

**Sample**
L3 extractor 从 session JSONL 提取的叙事级上下文片段。供 L4 /evolve LLM 进行具体分析。

### Plan Mode（pi-plan）

**Plan Mode**
用户通过 `/plan [描述]` 触发的轻量级规划模式。融合 brainstorming + writing-plans 能力，产出 plan 文件。与 Coding Workflow 的区别：无 gate/review/retrospect。

**Plan File**
Plan Mode 的产出物，存储在 `.xyz-harness/{slug}/plan.md`。含 YAML frontmatter（template, created, status）和模板章节。

**Brainstorming**
Plan Mode 的需求探索阶段。包含 Quick Overview、渐进式提问、方案探索、假设审计四个步骤。

---

## Flagged Ambiguities（易混淆点）

**"压缩"同时存在于 Pi 原生（Compaction）和 Context Engineering（L0/L1/L2）**
Compaction 在 agent loop 外做 token 级 LLM 摘要（不可逆），Context Engineering 在 agent loop 内做消息级规则化处理（可逆 Recall）。两者互补不冲突。

**"ManagedSession"（pi-subagent-workflow）≠ "agent-managed session"（pi-session-manager）**
前者是 AgentRuntime 进程内可控 session（subagent-workflow 的内存管理对象）；后者是经 runtime SessionManagerHandler 创建的**独立 pi 进程 session**（spawnSource='agent'，血缘记 .agent.json sidecar）。两者都归"agent 管理的 session"语义域，但生命周期、进程模型、持久化完全不同。

**"任务"统一到 Todo**
Goal 不内嵌任务系统，任务管理统一到 Todo 扩展。Goal 通过只读快照接口读取 Todo 进度，验证任务通过提示词引导由 AI 以独立 todo 承载（无结构化标记字段）。
