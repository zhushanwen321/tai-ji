# 外部 coding-agent 引擎适配映射

本目录收录六个外部 coding-agent 对 taiji subagent 引擎协议 v1（`packages/subagent-engine-sdk/src/protocol/`）的 **type 级适配映射文档**。协议面权威 = SDK protocol 源码；协议设计决策 = [`../subagent-engine-protocolization.md`](../subagent-engine-protocolization.md)；本文档族回答「每个引擎的细分类型如何映射到协议靶面」。

## 文档索引

| 引擎 | 映射文档 | 证据基准 | 建议接入形态 |
|------|---------|---------|-------------|
| Claude Code | [claude-code-mapping.md](claude-code-mapping.md) | v2.1.88 npm 产物反解快照 | spawn `claude -p --input-format stream-json --output-format stream-json --verbose`（pi 式，双向 stdio 控制协议） |
| Codex | [codex-mapping.md](codex-mapping.md) | openai/codex@a305084（2026-08-24） | 常驻 `codex app-server --listen stdio://`（JSON-RPC）；exec `--json` 降级 |
| opencode | [opencode-mapping.md](opencode-mapping.md) | sst/opencode@70a2469（2026-09-21） | 常驻 `opencode serve` + `@opencode-ai/sdk`（HTTP + SSE） |
| Kimi Code | [kimi-code-mapping.md](kimi-code-mapping.md) | MoonshotAI/kimi-code@d3b27cc（2026-08-24） | 常驻 `kimi acp`（ACP JSON-RPC over stdio） |
| openclaw | [openclaw-mapping.md](openclaw-mapping.md) | openclaw/openclaw@7a8d307（2026-06-02，较旧） | 常驻 gateway（WebSocket RPC：sessions.send/steer/abort/subscribe） |
| hermes-agent | [hermes-mapping.md](hermes-mapping.md) | NousResearch/hermes-agent@fa3b06b（2026-06-01，较旧） | 常驻 `hermes acp`（ACP JSON-RPC over stdio） |

每份文档固定 9 节：接入形态 / run 参数映射 / 事件映射 / 内容块与 tool 调用 / usage / session 记录与 read 重建 / 反向通道 / 能力位 / gap 清单（源有靶无、靶有源无、语义错配三分类）。

## 六引擎能力位矩阵

值取自各映射文档 §8（含逐位 file:line 依据，此处只留结论）。

| 能力位 | claude-code | codex | opencode | kimi | openclaw | hermes |
|--------|------------|-------|----------|------|----------|--------|
| schemaEnforcement | native | native | emulated | emulated | unsupported | emulated |
| steer | native | native | emulated | unsupported（ACP 面） | emulated | emulated |
| conversation | cold | cold | native | cold | native | cold |
| personaInjection | file | prompt | file | file | file | prompt |
| eventGranularity | stream | stream | stream | stream | stream | stream |
| sandbox | none | native | emulated | none | none | emulated |
| sessionRead | full | full | full | full | full | full |
| resume | cold | native | native | cold | native | cold |
| interrupt | native | native | native | native | native | native |
| permissionMode | native | native | native | native | native | native |
| maxTurns | true | false | true* | false | false | true |

\* opencode maxTurns 机制存在但为 agent 级 steps；per-run 达成须适配器为每次 run 生成临时 agent 定义，有并发命名/清理成本，放弃则声明 false 宿主自管 limiter。

**六家全绿位**：eventGranularity=stream、sessionRead=full、interrupt=native、permissionMode=native——协议 9 事件可全部落位，read 重建与优雅取消是普遍能力。

**稀缺位**：steer 仅 claude-code / codex 为 native，其余为 emulated（排队/打断重发/文本命令）或 unsupported（kimi 的 node-sdk 有 `Session.steer` 但 ACP 方法集无对应）；schemaEnforcement native 仅 claude-code（`--json-schema`）与 codex（`output_schema_strict`）。

## 协议面不可达矩阵（六引擎 × engine-protocol v1）

本矩阵汇总六份映射文档的「靶有源无」缺口与各节降级标注，列协议面各能力项在六引擎的可达性。汇总口径：**空格 = 支持**（原生或直接映射，该引擎文档未列为缺口）；⚠️ = 降级可用（emulated / 合成 / 词表折算 / 语义偏差，见括注）；❌ = 不可达（引擎无对应机制，宿主补齐或丢弃）。

引擎多出的能力（源有靶无，协议面无承载）不在此表，见各文档 §9。

### run 入参（run.params.task）

| 协议字段 | Claude Code | Codex | opencode | kimi | openclaw | hermes |
|----------|------------|-------|----------|------|----------|--------|
| task.schema（结构化输出） | ✅ native | ✅ native | ⚠️ emulated | ⚠️ emulated | ❌ unsupported | ⚠️ emulated |
| task.schemaEnv（env 降级通道） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| task.maxTurns | ✅ | ❌ 宿主计数 | ⚠️ 临时 agent steps | ❌ ACP 面不可达 | ❌ | ⚠️ 语义 = max_iterations（API 调用次数） |
| task.graceTurns | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| task.idleTimeoutMs | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| task.denyTools | ✅ 直通 | ⚠️ config 变通，语义不对等 | ⚠️ 链路有效但字段 deprecated | ❌ | ⚠️ patch 间接 | ⚠️ 仅 toolset 粒度 |
| task.thinkingLevel | ⚠️ 双轴词表 | ⚠️ effort 词表映射 | ⚠️ variant 部分承载 | ⚠️ off/on/effort 折算 | ⚠️ /think 前缀 + patch 双通道 | ⚠️ effort 词表，构造期注入 |
| task.skill / skillPath | ⚠️ prompt 注入 emulated | ✅ UserInput::Skill | ⚠️ 不可 per-run 注入 | ⚠️ slash 文本触发 | ⚠️ message 注入 | ⚠️ emulated |
| task.agent（.md 绝对路径） | ✅ 文件系统自扫描 | ⚠️ 读文件转内容注入 | ⚠️ 落盘约定目录改名 | ⚠️ --agent-file；ACP 面 prompt 兜底 | ⚠️ 注册 agentId 换算 | ⚠️ ephemeral 不落盘，resume 后需重注入 |

**全部 ❌ 的通用行**：`schemaEnv`（无一家有 env 注入 schema 通道——native 引擎走主通道、emulated 引擎走 prompt 注入）、`graceTurns`、`idleTimeoutMs`（一律宿主侧职责）。

### run 上下文（run.params.ctx）

| 协议字段 | Claude Code | Codex | opencode | kimi | openclaw | hermes |
|----------|------------|-------|----------|------|----------|--------|
| ctx.cwd / ctx.model / ctx.streamMode | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ctx.ctxModel | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| ctx.sessionRootId | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| ctx.sessionDir | ❌ 引擎自管布局 | ❌ | ❌ 归 serve 数据目录 | ⚠️ KIMI_CODE_HOME 数据根粒度 | ❌ gateway 固定布局 | ❌ |

**全部 ❌ 的通用行**：`ctxModel`（无一家有 ctx 模型分离概念）、`sessionRootId`（pi relay 专属键）。

### 事件面（event 通知 9 种）

| 协议事件 | Claude Code | Codex | opencode | kimi | openclaw | hermes |
|----------|------------|-------|----------|------|----------|--------|
| activity（周期活性） | ⚠️ 合成；纯 LLM 长流式期间无帧 | ⚠️ 合成（status/outputDelta） | ✅ server.heartbeat 10s | ⚠️ 合成 | ❌ 适配器周期自产 | ⚠️ 合成（内部 _touch） |
| compaction | ⚠️ 消息流内边界，read 重建需处理 relink | ⚠️ 以 ContextCompaction item 为准（通知已 deprecated） | ✅ | ⚠️ 进度混入正文 chunk，需状态机区分 | ✅ | ⚠️ 引擎/ACP 双轨压缩，落盘形态不同 |
| error（独立事件） | ⚠️ 从 result error_* 帧合成 | ✅ | ✅ | ✅ | ✅ | ✅ |
| turn 边界（turn_end） | ✅ | ✅ | ⚠️ 末端判定需自行合成 | ⚠️ ACP 不透传 step 边界，run 退化为单 turn | ⚠️ loop 内部概念，从 message 序列合成 | ✅ |

### 反向通道（6 条）

| 协议通道 | Claude Code | Codex | opencode | kimi | openclaw | hermes |
|----------|------------|-------|----------|------|----------|--------|
| host/childSpawned / childStateChanged | ⚠️ wait 链合成 | ❌ 不发 | ❌ 不发 | ⚠️ 合成 | ❌ | ⚠️ 合成（pid = 引擎进程） |
| host/streamDelta | ⚠️ 从 text_delta 合成 | ⚠️ delta 双投 | ⚠️ SSE delta 双发 | ⚠️ chunk 双投 | ❌ 从 delta 事件合成 | ⚠️ 从 chunk 合成 |
| host/log | ⚠️ 适配层桥接 | ⚠️ 适配层桥接 | ⚠️ 捕获 stdout/stderr 转译 | ⚠️ 适配层桥接 | ⚠️ 内部日志不回传 | ⚠️ stderr 行合成 |

### UI 交互（host/askUser 的 UiRequest method）

| 协议 method | Claude Code | Codex | opencode | kimi | openclaw | hermes |
|----------|------------|-------|----------|------|----------|--------|
| confirm（工具审批） | ✅ can_use_tool | ✅ ServerRequest | ✅ permission.asked | ✅ request_permission | ✅ exec.approvals | ✅ request_permission |
| select | ❌ can_use_tool 仅二元 | ⚠️ ServerRequest 映射 | ✅ question.v2 | ⚠️ elicitation form | ❌ | ❌ |
| input / editor | ❌ | ⚠️ ServerRequest 映射 | ❌ | ⚠️ elicitation form | ❌ | ❌ |
| notify / setStatus / setWidget / setTitle / set_editor_text | ❌ | ❌ | ❌ | ❌ {unsupported} | ❌ | ❌ |

**全部 ❌ 的通用行**：fire-and-forget 五 method（notify/setStatus/setWidget/setTitle/set_editor_text）——六家引擎均无「宿主展示写入」反向推送形态，一律 `{unsupported:true}`。

### 终态字段（AgentOutcome / usage）

| 协议字段 | Claude Code | Codex | opencode | kimi | openclaw | hermes |
|----------|------------|-------|----------|------|----------|--------|
| AgentUsage.cost（单轮成本） | ⚠️ 仅累计级 total_cost_usd | ❌ 仅账户面估计 | ⚠️ 无价模型恒 0 | ❌ ACP 不可达 | ✅ | ❌ 无 wire 槽 |
| usage 单消息增量（cacheWrite 等） | ✅ | ⚠️ last = 单轮非单消息 | ✅ | ❌ usage_update 仅 context 水位 | ✅ | ⚠️ session 累计，需差分 |
| contextTokens | ✅ | ❌ 仅窗口容量/累计吞吐 | ⚠️ 不落盘，input+cache 近似 | ✅ usage_update 水位 | | |
| AgentOutcomeUsage.turns | ⚠️ num_turns 按 user 消息计数，口径偏大 | | | ⚠️ turn ≈ taiji step | ❌ | ⚠️ max_iterations ≠ 用户轮 |
| AgentOutcome.exitCode | ✅ 进程退出码 | | | | ❌ 常驻恒无 | ❌ 常驻形态无意义 |
| AgentOutcome.failureKind | | | ✅ StructuredOutputError 可分诊 schema_deterministic | | ⚠️ 从 stopReason/errorMessage 合成 | |

### 模型面

| 协议方法 | Claude Code | Codex | opencode | kimi | openclaw | hermes |
|----------|------------|-------|----------|------|----------|--------|
| listModels（模型枚举） | ❌ 无公开枚举，适配层自维护目录 | ✅ model/list | ✅ /config/providers | ✅ list_models | ✅ models | ✅ available_models |

### 硬约束备注（不可映射为协议能力的引擎内置行为）

- **openclaw**：无进程退出码语义（常驻）；run 应答是受理 ack 非终态，适配器须桥接 WS 终态事件才能 resolve run。
- **hermes**：hardline 红线不可交互、不可配置绕过（任何 permissionMode 都不改变其行为），GUI 权限承诺须排除该层；工具结果恒字符串，ToolCallResult 结构化需二次 parse；并行工具配对依赖 tool_start/tool_end 不变量。
- **kimi**：session 与 KIMI_CODE_HOME × workspace 双重绑定，resume 锚点必须携带数据根；permissionMode 的 plan 档有只读副作用。
- **codex**：fork 产新 threadId（resume 锚点须切换）；正文 delta 与 completed 全文并存须按 itemId 去重。
- **opencode**：permission ask 挂起会阻塞 run（必须 prompt_async + SSE，宿主不 reply = 永挂，须映射超时/杀链到 reply reject）；session 与创建时 directory 绑定，跨目录续聊必须带路由参数。
- **claude-code**：每会话一进程，协议常驻端点语义（initialize/dispose/ping 多 run 复用）须适配层 wrapper 重构——接入形态最大结构差异。

## 引擎多出能力面（engine-protocol v1 无承载位）

六家引擎普遍携带协议 v1 没有的能力（各文档 §9「源有靶无」汇总）。这些能力**不阻塞接入**——适配器丢弃或仅诊断消费；下表是协议未来扩展的候选面，是否值得进协议按 [`../subagent-engine-protocolization.md`](../subagent-engine-protocolization.md) 的字段归属判据裁决，不在本表展开。

✅ = 该引擎具备此能力面（括注为引擎侧具体形态）；空 = 无此面或未在映射文档中标记。

| 能力域 | Claude Code | Codex | opencode | kimi | openclaw | hermes |
|--------|------------|-------|----------|------|----------|--------|
| 内嵌 subagent / 多 agent 协作 | ✅ Task 后台任务事件族 | ✅ collab agents + thread/realtime | ✅ subtask part | ✅ subagent.spawned 等 5 类事件 | | ✅ delegate_task |
| 计划 / todo 展示推送 | | ✅ turn/plan/updated | ✅ todo.updated | ✅ plan update | ✅ bus item/plan | ✅ AgentPlanUpdate |
| 动态工具注册 + 宿主反呼 | | ✅ thread/start.dynamicTools + DynamicToolCall | | | | |
| 运行时参数切换 | ✅ set_model / set_max_thinking_tokens | | | ✅ config_option_update / current_mode_update | | |
| MCP 服务器管理与事件 | ✅ mcp_set_servers / reconnect / toggle / status 族 | | ✅ MCP / LSP / PTY 事件族 | | | ✅ NewSession.mcp_servers 动态注册 |
| 多模态输入 | | | ✅ file part 输入 | | | ✅ image / resource blocks |
| session 树治理（回滚/分叉/搜索） | ✅ rewind_files / --resume-session-at / --fork-session | ✅ archive/delete/rollback/revert/search 等 13 方法 | ✅ fork 树 / revert / 消息删除改写 | ✅ session/fork（UNSTABLE）/ session/list | | ✅ ForkSession + checkpoint 体系 |
| 预算上限治理 | ✅ --max-budget-usd / --task-budget | | | | | |
| 审批流增强 | ✅ permission_denials / fast_mode_state | ✅ guardian 自动审批（autoApprovalReview） | | ✅ mode 推送 | ✅ 结构化审批元数据 + 远程节点审批配置 | ✅ allow_once/session/always 五值细分 |
| 结构化 diff / patch 面 | | ✅ turn/diff/updated | ✅ patch/snapshot parts + session.diff | ✅ ToolKind / diff content | ✅ bus item/patch | |
| 多任务入口（shell/命令/手动压缩） | | | ✅ /shell /command /init /summarize | ✅ available_commands_update | | ✅ available_commands（9 个 slash） |
| 平台生态面（渠道/cron/记忆/市场） | ✅ plugins / marketplace（--plugin-dir） | ✅ hooks / plugins / marketplace / skills 管理面 | ✅ share / provider OAuth | ✅ goal / cron / task 域 | ✅ 多渠道路由 + cron/heartbeat/web | ✅ send_message/kanban/cron + memory/session_search |

三个跨引擎观察：

1. **计划/todo 推送是六家共性缺口里最接近协议化的一条**——五家独立演化出了同构能力（plan/todo 状态推送），协议 9 事件无承载位；若 GUI 要呈现子代理任务清单，这是首选扩展候选。
2. **动态工具注册 + 宿主反呼仅 codex 有**——协议反向面无「宿主执行引擎工具」通道，这是 codex 独有能力中唯一无法用「丢弃」无损处理的（丢弃即功能消失）。
3. **session 树治理五家有、协议只有线性 resume/fork 锚点**——回滚/树形分叉/搜索在 subagent 场景多为宿主职责（taiji 自建 session 模型），维持丢弃是合理默认。

## ResumeAnchor.sessionRef 建议

开放载体按引擎构成（详见各文档 §6）：

| 引擎 | sessionRef 构成 | 数据目录隔离 |
|------|----------------|-------------|
| claude-code | `{sessionId}`（transcript 路径引擎自推导） | 环境变量重定向 `~/.claude` |
| codex | `{threadId, rolloutPath}` | `CODEX_HOME` |
| opencode | `{sessionId, directory}` | `XDG_DATA_HOME` |
| kimi | `{sessionId}` + 数据根 | `KIMI_CODE_HOME` |
| openclaw | `{sessionKey, sessionId}` 双带（路由键 ≠ uuidv7 id） | gateway 配置 |
| hermes | `{sessionId, hermesHome}`（SQLite 库非单文件） | `HERMES_HOME` |

## 横向事实

- **ACP 公共面**：kimi（`kimi acp`）、hermes（`hermes acp`）原生提供 ACP stdio server；openclaw 的 `openclaw acp` 是 gateway 的客户端桥。ACP 语义与协议 v1 同构度高，一个「ACP ↔ engine-protocol 转换层」可覆盖多引擎；但 kimi 实测 ACP 面存在 steer/maxTurns/schema/细分 usage 四项不可达，需扩展 acp-server 或直连引擎层。
- **拓扑两极**：全部六家均可用常驻服务形态承载（zcode 式）；仅 claude-code 推荐每任务 spawn（其常驻形态 daemon/mcp serve 均非会话服务）。
- **usage 字段方言**：各家 token 字段名与归并口径不同（如 codex cached/uncached、opencode reasoning 单列、hermes usage 在 turn 终态一次性给出需差分）；cacheWrite/cost 普遍缺 wire 槽。适配层需逐家按映射文档 §5 落。
- **快照漂移风险**：各文档头部标注证据基准 commit；openclaw/hermes 快照较旧（2026-06），按机制存在性采信，实施前须按当时实装版重验（纪律同 pi 语义断言，见 [pi-boundary-reliability.md](../pi-boundary-reliability.md)）。
