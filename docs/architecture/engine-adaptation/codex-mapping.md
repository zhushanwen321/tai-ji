# codex 引擎适配映射（engine-protocol v1）

证据基准：openai/codex@a3050847（2026-08-24 快照，Rust 实现 `codex-rs/`）。源码引用均为该仓库内相对路径（GitHub openai/codex）。
映射目标 = subagent-engine-sdk 协议 v1（`packages/subagent-engine-sdk/src/protocol/`）。

---

## 1. 接入形态与进程拓扑

推荐 zcode 式常驻接入：spawn `codex app-server --listen stdio://`（app-server/src/main.rs:29-36，stdio 为默认 transport），JSON-RPC over stdio，一个常驻引擎进程承载多个 thread（codex 的会话单位）。thread 生命周期：`thread/start` 创建 → `turn/start` 提交任务 → 通知流（`item/*`、`turn/completed`）→ `thread/resume`/`thread/fork` 续接；会话落盘 rollout JSONL，进程重启后仍可 `thread/resume`。审批等反向交互走 JSON-RPC ServerRequest（服务端 → 客户端请求，须应答）。

exec 降级路径（一次性任务形态）：`codex exec --json --output-schema <file> "<prompt>"`（exec/src/cli.rs:47-65，`--json` 输出 JSONL 事件流，`--output-schema` 指定终响应 JSON Schema），`--output-last-message <file>` 取最终正文（cli.rs:67-74），`codex exec resume <session-id> --json` / `codex exec fork <session-id>` 续接（cli.rs:148-158）。降级路径事件面窄（无 delta 流），仅作 app-server 不可用时的回退。

## 2. run 参数映射表

run.params.task（AgentCallOpts）/ ctx / resume → app-server `thread/start`（v2/thread.rs:59-156）+ `turn/start`（v2/turn.rs:71-161）或 exec flag。

| taiji 字段 | 源对应 | 证据（file:line） | 缺省/不可达备注 |
|---|---|---|---|
| task.prompt | `turn/start.params.input[0]` = `UserInput::Text{text}` | v2/turn.rs:71-75, :292-298 | 直接；exec 为 positional PROMPT 或 stdin（exec/src/cli.rs:76-80） |
| task.schema | `turn/start.params.output_schema`（turn 级覆盖）；底层 `Prompt.output_schema` + `output_schema_strict`（默认 true，strict 校验） | v2/turn.rs:143-146；core/src/client_common.rs:33-47 | native；exec 为 `--output-schema <FILE>`（exec/src/cli.rs:47-49） |
| task.thinkingLevel | `turn/start.params.effort: ReasoningEffort`（thread/start 无 effort，须随首个 turn 传） | v2/turn.rs:134-136；protocol/src/openai_models.rs:50-62 | 词表 none/minimal/low/medium/high/xhigh/max/ultra/custom(String)，taiji 词表需适配映射 |
| task.scene | 无对应 | — | 宿主自持诊断字段，不上 wire |
| task.maxTurns / task.graceTurns | 无对应参数 | — | 适配器宿主侧计数 `turn/completed` 实现；引擎原生无轮数上限 |
| task.skill / task.skillPath | `UserInput::Skill{name, path}` 输入项（与 Text 并列进 input[]） | v2/turn.rs:317-320 | native 注入通道 |
| task.description | 无对应 | — | 诊断字段，宿主自持 |
| task.agent（.md 绝对路径） | 无原生 agent 文件机制；降级 `thread/start.developer_instructions` 注入内容 | v2/thread.rs:101-103 | personaInjection=prompt 通道；需适配器读 .md 后传内容 |
| task.appendSystemPrompt | `thread/start.base_instructions` / `developer_instructions` | v2/thread.rs:101-103 | 数组合并为一串注入；turn 级无 system prompt 通道 |
| task.fork | `thread/fork`（by thread_id） | common.rs:517-522；v2/thread.rs:516-598 | fork 出新 thread（新 id），非原地 |
| task.forkSource | `thread/fork.params.path`（rollout 文件路径，指定时忽略 thread_id） | v2/thread.rs:532-540 | 对应「宿主点名任意已有 session 文件」 |
| task.worktree | 无引擎内对应 | — | 宿主侧预创建 worktree 后经 ctx.cwd 指向 checkout 目录 |
| task.idleTimeoutMs | 无对应 | — | 宿主侧 idle GC 职责 |
| task.denyTools | 无直接 denylist；变通 = `thread/start.config`（config override map）写工具策略键 | v2/thread.rs:96-97 | 语义不对等，按降级处理；能力声明不计 native |
| task.permissionMode | `thread/start.approval_policy: AskForApproval`（untrusted/on-request/granular/never）+ `sandbox`（read-only/workspace-write/danger-full-access）；turn 级可覆盖 | v2/shared.rs:174-190, :303-307；v2/thread.rs:84-95；v2/turn.rs:106-121 | native；taiji 中立词表需适配映射 |
| ctx.cwd | `thread/start.params.cwd`（thread 粘性）/ `turn/start.params.cwd`（turn 级覆盖） | v2/thread.rs:77-78；v2/turn.rs:98-100 | 直接 |
| ctx.model | `thread/start.params.model` / `turn/start.params.model` | v2/thread.rs:60-61；v2/turn.rs:122-124 | 直接 |
| ctx.schemaEnv | 无对应 | — | schema 走 output_schema 主通道，env 通道无消费者 |
| ctx.ctxModel / streamMode / sessionRootId / sessionDir | 无对应 | — | sessionRootId/sessionDir 为 pi 专属键；streamMode 恒 stream（codex 只有流粒度） |
| resume.recordId | 适配器自持关联键 | — | 用于 host/handleReady、host/childStateChanged 回填 |
| resume.resume.sessionRef | `thread/resume`：`thread_id`（首选）或 `path`（rollout 路径，[UNSTABLE]） | common.rs:511-516；v2/thread.rs:318-352 | sessionRef 构成建议见 §6 |

模型面（靶面 H）补充：

| taiji 面 | 源对应 | 证据（file:line） | 备注 |
|---|---|---|---|
| listModels → ModelCatalogEntry{id,aliases?,canonicalRef?} | `model/list` → `ModelListResponse{data:Vec\<Model\>}`；`Model{id, model, displayName, …}` | common.rs:1020-1024；v2/model.rs:53-63, :92-121, :147-152 | 投影：ModelCatalogEntry.id←Model.id；canonicalRef←Model.model（真实模型 ref）；aliases 无对应（缺省）。无枚举面时返回 null 的协议语义不受影响（方法恒可调） |
| validateModel → canonicalRef | 无独立校验方法 | — | 合成：以 model/list 全集匹配；不命中时 thread/start 实际验证（ModelRerouted 通知为替换信号，v2/model.rs:157-163） |

## 3. 事件映射表

映射方式标注：直接 / 合成（适配器组装）/ 丢弃。

### 3.1 app-server 通知全集（ServerNotification，common.rs:1818-1933，56 变体）

| 源通知（wire method） | taiji 事件 | 方式 | 证据/备注 |
|---|---|---|---|
| error | error | 直接 | v2 ErrorNotification |
| thread/started | — | 丢弃 | 生命周期通知 |
| thread/status/changed | activity | 合成 | ThreadStatus 变化时刷新判活（可选降级为丢弃） |
| thread/archived / deleted / unarchived / closed / reverted | — | 丢弃 | 管理面 |
| thread/name/updated / goal/updated / goal/cleared / queue/changed | — | 丢弃 | 管理面 |
| thread/project/updated / settings/updated / environment/connected / disconnected | — | 丢弃 | 管理面 |
| skills/changed / project/changed | — | 丢弃 | 全局面 |
| turn/started | — | 合成开界 | 适配器开新 turn（不开 taiji 事件） |
| turn/completed | turn_end | 直接 | Turn{id,items,status,error,…}（v2/thread_data.rs:353-373）；turn 级 usage 不在此载荷，经 tokenUsage/updated |
| turn/diff/updated | — | 丢弃 | turn 级聚合 diff，taiji 无槽 |
| turn/plan/updated | — | 丢弃 | plan 工具面，taiji 无槽 |
| item/started | tool_start（tool 类 item）/ — | 直接 | CommandExecution/McpToolCall/DynamicToolCall/WebSearch 等 → tool_start{toolName,args}；AgentMessage/Reasoning/UserMessage/ContextCompaction 等非 tool 类不产 tool_start |
| item/completed | tool_end（tool 类）/ message_end（AgentMessage）/ compaction（ContextCompaction）/ — | 直接 | 同上分派；AgentMessage 完成即正文定稿（不含 usage） |
| item/autoApprovalReview/started / completed、autoApprovalReview/strictReviewRequired | — | 丢弃 | guardian 自动审批内部面 |
| rawResponseItem/completed | — | 丢弃 | Codex Cloud 内部 |
| rawResponse/completed | message_end.usage（可选精确通道） | 合成 | 上游单次响应精确 usage（v2/thread.rs:1761-1769），内部通道 |
| item/agentMessage/delta | text_delta | 直接 | {threadId,turnId,itemId,delta}（v2/item.rs:1350-1355） |
| item/plan/delta | — | 丢弃 | plan item 流 |
| command/exec/outputDelta、process/outputDelta、process/exited | — | 丢弃 | 独立 exec/process 面（非 thread turn） |
| item/commandExecution/outputDelta | activity | 合成 | 长命令输出流，作活性信号；也可累积进 tool_end result |
| item/commandExecution/terminalInteraction | — | 丢弃 | PTY stdin 交互面 |
| item/fileChange/outputDelta | — | 丢弃 | 已废弃，服务端不再发（v2/item.rs:1425-1427） |
| item/fileChange/patchUpdated | — | 丢弃（或累积） | FileUpdateChange 增量，tool_end 时以 item/completed 全量为准 |
| item/reasoning/summaryTextDelta | thinking_delta | 直接 | {…,delta,summaryIndex}（v2/item.rs:1372-1379） |
| item/reasoning/summaryPartAdded | — | 丢弃 | 分节边界 |
| item/reasoning/textDelta | thinking_delta | 直接 | {…,delta,contentIndex}（v2/item.rs:1395-1402）；与 summaryTextDelta 并存时按 contentIndex 分槽拼接 |
| thread/compacted | compaction | 直接 | [Deprecated] 改用 ContextCompaction item（common.rs:1894-1895） |
| serverRequest/resolved | — | 丢弃 | 反向请求生命周期 |
| item/mcpToolCall/progress | activity | 合成 | MCP 执行中活性 |
| mcpServer/oauthLogin/completed、startupStatus/updated、event/stream/notification | — | 丢弃 | MCP 管理面 |
| account/*（updated / rateLimits / login/completed） | — | 丢弃 | 账户面 |
| app/list/updated、remoteControl/status/changed、externalAgentConfig/import/* | — | 丢弃 | 外围面 |
| fs/changed | — | 丢弃 | fs watch 面 |
| model/rerouted | error（warn 级） | 合成 | 模型被替换，宿主须感知（v2/model.rs:157-163） |
| model/verification、model/safetyBuffering/updated、turn/moderationMetadata | — | 丢弃 | 平台安全面 |
| warning / guardianWarning / deprecationNotice / configWarning | error（或 host/log） | 合成 | 非致命告知；taiji 9 事件无 warn 槽，投影 error 或降 host/log |
| fuzzyFileSearch/sessionUpdated / sessionCompleted | — | 丢弃 | 搜索面 |
| thread/realtime/*（9 个） | — | 丢弃 | 语音实时面 |
| windows/worldWritableWarning、windowsSandbox/setupCompleted | — | 丢弃 | Windows 沙箱面 |

### 3.2 item 类型全集（ThreadItem，v2/item.rs:231-404，19 变体）

item/started 与 item/completed 携带完整 ThreadItem。tool 类（产 tool_start/tool_end）：CommandExecution（:276-304）、FileChange（:307-311）、McpToolCall（:314-332）、DynamicToolCall（:335-346）、CollabAgentToolCall（:349-369）、WebSearch（:378）。非 tool 类：UserMessage（:234-238）、HookPrompt（:241-244）、AgentMessage（:247-256，正文槽）、Plan（:259-264）、Reasoning（:267-273，思考槽）、SubAgentActivity（:372-377）、ImageView（:381-384）、Sleep（:385）、ImageGeneration（:386）、EnteredReviewMode / ExitedReviewMode（:389-398）、ContextCompaction（:401-403，产 compaction）。

### 3.3 exec JSONL 事件全集（ThreadEvent，exec/src/exec_events.rs:11-37，8 变体）

thread.started（:40-43，携 thread_id）/ turn.started（:47）/ turn.completed{usage}（:50-52）/ turn.failed{error}（:55-57）/ item.started{item}（:76-78）/ item.updated{item}（:86-88）/ item.completed{item}（:81-83）/ error{message}（:92-94）。映射同 §3.1 对应行；item 载荷为简化版 ThreadItemDetails（:107-133）：AgentMessage / Reasoning / CommandExecution / FileChange / McpToolCall / CollabToolCall / WebSearch / TodoList / Error 九种（snake_case tag）。无 delta 流事件（eventGranularity=coarse 形态）。

## 4. 内容块与 tool 调用映射

| codex 内容块 | taiji 装载 | 说明 |
|---|---|---|
| AgentMessage.delta（item/agentMessage/delta.delta） | text_delta.delta | 流式；AgentMessage item 完成态字段 {id,text,phase,memoryCitation,delivery}（v2/item.rs:247-256），text 为全文——适配器须按 itemId 去重（已 delta 累积则丢弃 completed 全文或重置累积） |
| Reasoning.summary[i] / content[i]（summaryTextDelta / textDelta.delta） | thinking_delta.delta | 完成态 Reasoning{id,summary:Vec\<String\>,content:Vec\<String\>}（v2/item.rs:267-273）；summary 与 content 两路 delta 都投 thinking_delta，按 summaryIndex/contentIndex 分节拼接 |
| CommandExecution{command,cwd,status,aggregatedOutput,exitCode,durationMs}（v2/item.rs:276-304） | ToolCall{toolName:"shell",args:{command,cwd,commandActions},result:{content:[aggregatedOutput]},isError:status∈{Failed,Declined}} | started→tool_start{args}；completed→tool_end{result,isError}；exit_code 并入 details。status 枚举 InProgress/Completed/Failed/Declined（v2/item.rs:1006-1011） |
| McpToolCall{server,tool,arguments,status,result,error,durationMs}（v2/item.rs:314-332） | ToolCall{toolName:"mcp__\<server\>__\<tool\>",args:arguments,result:{content:[…],details:structuredContent},isError:status=="failed"} | result:McpToolCallResult{content:Vec\<JsonValue\>,structuredContent,meta}（v2/mcp.rs:202-215）——**content 数组与 taiji ToolCallResult.content: unknown[] 直接对位**；error:McpToolCallError{message}（v2/mcp.rs:218-221）并入 details |
| DynamicToolCall{namespace,tool,arguments,status,contentItems,success}（v2/item.rs:335-346） | ToolCall{toolName, args:arguments, result:{content:contentItems 文本化}, isError:!success} | 宿主侧动态工具反呼见 §7 |
| FileChange{changes:[{path,kind,diff}],status}（v2/item.rs:307-311, :1065-1089） | 合成 ToolCall{toolName:"apply_patch",args:{changes},result:{content:[diffs join]},isError:status∈{Failed,Declined}} | codex 无 per-file tool 调用流，整个 patch 为一个 item |
| WebSearch{id,query,action,results} | ToolCall{toolName:"web_search",args:{query},result:{content:[results]}} | WebSearchItem 定义于 codex-extension-items（v2/item.rs:378, :918-923） |
| CollabAgentToolCall / SubAgentActivity | 丢弃（或合成 activity） | codex 内建多 agent 协作面，taiji 无对应槽 |
| TodoList / Plan / ImageView / Sleep / ImageGeneration / ReviewMode items | 丢弃（或 GUI 自行消费） | taiji 9 事件无槽 |
| exec 版 CommandExecutionItem{command,aggregatedOutput,exitCode,status}（exec/src/exec_events.rs:161-166） | 同上 shell 装载 | exec_events McpToolCallItemResult{content:Vec\<JsonValue\>,meta,structuredContent}（:263-276）同 v2 对位 |

## 5. usage 映射表

权威来源：`thread/tokenUsage/updated` 通知（v2/thread.rs:1753-1757）：`ThreadTokenUsage{total:TokenUsageBreakdown, last:TokenUsageBreakdown, modelContextWindow}`。

| taiji 字段 | 源字段 | 证据（file:line） | 备注 |
|---|---|---|---|
| AgentUsage.input | TokenUsageBreakdown.inputTokens | v2/thread.rs:1795-1809 | last（单轮增量）投影 message_end.usage；total 投影累计 |
| AgentUsage.output | TokenUsageBreakdown.outputTokens | 同上 | 含 reasoning 输出 |
| AgentUsage.cacheRead | TokenUsageBreakdown.cachedInputTokens | 同上 | 直接 |
| AgentUsage.cacheWrite | TokenUsageBreakdown.cacheWriteInputTokens | 同上 | serde default（:1802-1804），旧上游可能缺省 |
| AgentUsage.cost | 无 turn 级成本 | — | 缺省（taiji 语义：无成本数据时缺省）；账户面仅有估计值 ThreadUsage.estimatedUsageUsdMicros（v2/thread_usage.rs:9-14），非精确、不投 |
| AgentOutcomeUsage.contextTokens | ThreadTokenUsage.modelContextWindow（窗口容量） | v2/thread.rs:1777-1779 | 语义错配：taiji contextTokens = 当前上下文占用，codex 只给窗口容量与 totalTokens（累计吞吐，含历史轮，非占用快照）。近似取 modelContextWindow 可判「接近上限」，取 totalTokens 会单调膨胀——建议投 modelContextWindow 并标注未核实精确占用 |
| AgentOutcomeUsage.turns | turn/completed 到达计数 | common.rs:1848 | 适配器累计 |
| （reasoningOutputTokens / totalTokens） | 无 taiji 槽 | v2/thread.rs:1806-1808 | reasoning 输出已含于 output；totalTokens 不投 |
| exec Usage{inputTokens,cachedInputTokens,cacheWriteInputTokens,outputTokens,reasoningOutputTokens} | turn.completed.usage（exec 轨） | exec/src/exec_events.rs:61-73 | 字段同名对位，无 context 窗口字段 |
| 精确上游 usage（可选） | rawResponse/completed.usage | v2/thread.rs:1761-1769 | 内部通道，core TokenUsage 同构（protocol/src/protocol.rs:2079-2098） |

## 6. session 记录与 read 重建

### 6.1 rollout JSONL line type 全集（RolloutItemWire，history/src/rollout_payload.rs:22-52，9 种）

`session_meta`（首行：session/thread 元数据）/ `response_item`（Responses API 原始 item，含 harness metadata）/ `inter_agent_communication` / `inter_agent_communication_metadata` / `compacted`（CompactedItem{message,replacementHistory,windowId…}，history/src/lib.rs:142-150）/ `turn_context`（cwd/model 等轮上下文）/ `world_state` / `security_risk_score` / `event_msg`（core EventMsg 全量透写，protocol/src/protocol.rs:1296-1506，约 60 变体）。枚举宿主：history/src/lib.rs:95-105。

文件名 `rollout-\<timestamp\>-\<threadId\>[_\<rolloutId\>].jsonl`（rollout/src/rollout_file_name.rs:66-78 render），revert/fork 产 `_\<rolloutId\>` 后缀变体；目录约定 `~/.codex/sessions/` 按日期分层（rollout/src/recorder.rs:79-84 doc 示例）。写入入口 `RolloutRecorder`（recorder.rs:85-136：Create/Resume params，AddItems 命令）。

### 6.2 read 重建（app-server 原生路径 = read 降级链第①级，source:"native"）

- `thread/read{threadId, includeTurns:true}` → `ThreadReadResponse{thread}`（v2/thread.rs:1647-1659）；`Thread.turns: Vec\<Turn\>`（v2/thread_data.rs:267-271，仅 read/resume/rollback/fork 且 includeTurns 时填充）。
- `Turn{id, items: Vec\<ThreadItem\>, itemsView, status, error, startedAt, completedAt, durationMs}`（thread_data.rs:353-373）。
- 大历史分页：`thread/turns/list`（v2/thread.rs:1678-1707，cursor/limit/sortDirection/itemsView）与 `thread/items/list`（:1712-1748，返回 `ThreadItemEntry{turnId,item}`）。

ReplayedTurn 映射（Turn.items 投影）：

| ReplayedTurn 槽 | 源 | 备注 |
|---|---|---|
| text | items 中全部 AgentMessage.text 依序拼接 | v2/item.rs:247-256 |
| thinking | items 中全部 Reasoning（summary + content 依序 join） | :267-273 |
| toolCalls | CommandExecution / McpToolCall / DynamicToolCall / FileChange / WebSearch 依序 → ToolCall（§4 装载） | userMessage 等非工具项跳过 |
| closed | 恒 true | Turn.status ∈ {completed,interrupted,failed} 即闭合；inProgress 不应出现在 read 结果 |

SessionView：engineId="codex"；sessionId=thread.id；usage=read 面不可得（rollout 不存汇总 usage，缺省）；source="native"（thread/read 成功）/ "outcome-only"（仅 run 终态可用时）。exec 轨 read：`codex exec resume --json` 重放（exec/src/cli.rs:150-151），能力受限。

### 6.3 ResumeAnchor.sessionRef 构成建议

`sessionRef = { threadId: string, rolloutPath: string }`。threadId 对应 `thread/resume.params.threadId`（首选通道，v2/thread.rs:332-352 注释：running thread 则 rejoin）；rolloutPath 对应 `thread/resume.params.path`（[UNSTABLE]，非运行 thread 时忽略 threadId、按路径加载；running thread 时作一致性校验）。journalPath 仍按协议通用约定承载宿主 event journal。

## 7. 反向通道映射（6 通道）

codex 反向面 = ServerRequest（服务端→客户端 JSON-RPC 请求，common.rs:1663-1734，11 方法全集：item/commandExecution/requestApproval、item/fileChange/requestApproval、item/tool/requestUserInput、mcpServer/elicitation/request、item/permissions/requestApproval、item/tool/call、account/chatgptAuthTokens/refresh、attestation/generate、currentTime/read、[deprecated] applyPatchApproval、execCommandApproval）。

| taiji 通道 | 源对应物 | 映射方式 |
|---|---|---|
| host/log{level,component,message,data?} | 无专用通道；warning/guardianWarning/configWarning/deprecationNotice 通知 | 合成：适配器把这些通知转 host/log（level=warn）；引擎内部日志自记 |
| host/askUser{runId,request:UiRequest} | ①item/commandExecution/requestApproval（v2/item.rs:1451-1525：command/cwd/commandActions/reason/availableDecisions，响应 CommandExecutionApprovalDecision accept/acceptForSession/acceptWithExecpolicyAmendment/applyNetworkPolicyAmendment/decline/cancel，:61-80）→ UiRequest method=confirm（title=command、message=reason），acceptForSession 与 decline→confirm 的 {confirmed} 语义对齐，cancel 需追加 turn/interrupt 合成；②item/fileChange/requestApproval（:1530-1550，decision accept/acceptForSession/decline/cancel）→ confirm 同上；③item/tool/requestUserInput（:1647-1701，questions[]{id,header,question,options[{label,description}],isOther,isSecret}）→ method=select（options 扁平化）；④mcpServer/elicitation/request（common.rs:1686-1689）→ input 或 confirm 按 elicitation 模式；⑤item/permissions/requestApproval（common.rs:1692-1695）→ confirm（message=reason）；⑥item/tool/call DynamicToolCall（common.rs:1698-1701）→ 无 UiRequest 对应（宿主工具执行反呼，taiji 反向面无此通道——**语义缺口**，见 §9） | ①-⑤ 可映射；ack 两阶段：先回 {ack:true}，JSON-RPC response 异步到达 |
| host/streamDelta{runId,delta} | item/agentMessage/delta / item/reasoning/*Delta | 合成双投：事件映射（§3.1）同时转发 UI 实时通道 |
| host/handleReady{runId,sessionRef} | thread/start（或 thread/resume）应答 | 合成：应答到达即发 {threadId, rolloutPath}（早于 run 终态） |
| host/childSpawned{pid,recordId} | 无对应 | 不发：codex 常驻形态无一次性引擎子进程（collab spawn 的 SubAgentActivity 是 thread 内 item，非宿主 record 语义） |
| host/childStateChanged{pid,recordId,state,killed,exitCode?,signal?} | 无对应 | 不发；turn/interrupt + thread/status/changed 可合成 thread 级运行态镜像（可选增强，非必需） |

UiRequest 9 method 对齐度：select（← requestUserInput）✅、confirm（← 三类 requestApproval + permissions）✅、input（← mcp elicitation 文本型）✅、editor ❌ 无对应（丢弃/unsupported）、notify ❌、setStatus ❌、setWidget ❌、setTitle ❌、set_editor_text ❌（codex 无宿主 UI 推送通道；thread/name/set 是客户端主动改名的正向方法，非反向推送）。

## 8. 能力位 11 位表

| 能力位 | 值 | 依据 |
|---|---|---|
| schemaEnforcement | native | turn/start.output_schema（v2/turn.rs:143-146）+ output_schema_strict 默认 true（core/src/client_common.rs:36-47）；exec --output-schema（exec/src/cli.rs:47-49） |
| steer | native | turn/steer（common.rs:967-972；v2/turn.rs:175-197，expected_turn_id 前置校验；NonSteerableTurnKind 仅 review/compact，v2/shared.rs:160-167） |
| conversation | cold | thread/resume 从磁盘 rollout 重建上下文（v2/thread.rs:318-329 注释「load the thread from disk and resume」）；非进程内原地热续，符合 cold（冷恢复重建 + 新 run + resume 锚点）定义 |
| personaInjection | prompt | 无 agent 文件 flag；base_instructions/developer_instructions 内容注入（v2/thread.rs:101-103），task.agent 需适配器读文件转内容 |
| eventGranularity | stream | item/agentMessage/delta、reasoning delta、commandExecution/outputDelta 全套流事件（common.rs:1862-1876） |
| sandbox | native | SandboxMode read-only/workspace-write/danger-full-access（v2/shared.rs:303-307）+ 平台沙箱实现（windowsSandbox 面、seatbelt 等） |
| sessionRead | full | thread/read includeTurns + thread/turns/list + thread/items/list 全量重放（v2/thread.rs:1647-1748） |
| resume | native | thread/resume RPC 原生续接（common.rs:511-516），by threadId 或 path；进程重启后同链路可续（会话落盘） |
| interrupt | native | turn/interrupt（common.rs:973-977；v2/turn.rs:209-217），TurnStatus.Interrupted 终态 |
| permissionMode | native | approval_policy（AskForApproval 四值 + granular 细分开关，v2/shared.rs:174-190）+ sandbox/permissions profile，thread/turn 双级覆盖 |
| maxTurns | false | 全协议无轮数上限参数（thread/start / turn/start / config 均无）；宿主侧计数实现 |

## 9. gap 清单

### 9.1 源有靶无（codex 有、taiji 协议无槽——适配器丢弃，不阻塞接入）

- thread 管理面：archive/delete/unarchive/name/goal/queue/section/project/settings/rollback/revert/inject_items/search（common.rs:523-802）。
- collab agents（codex 内建多 agent 子线程：CollabAgentToolCall item、thread/realtime 语音面）——taiji subagent 编排归宿主，引擎内多 agent 不投影。
- command/exec、process/* 独立进程面与 fs/* 远程文件面（common.rs:899-945, :1247-1299）。
- dynamic tools 注册（thread/start.dynamicTools，v2/thread.rs:135-141）与 DynamicToolCall 宿主反呼（item/tool/call）——taiji 反向面无「宿主执行引擎工具」通道，此能力不可用（除非扩展协议）。
- hooks / plugins / marketplace / skills 管理面（common.rs:803-878）。
- guardian 自动审批（item/autoApprovalReview/*）与 attestation/remoteControl/environment 面。
- turn/plan/updated、turn/diff/updated（plan 工具与 turn 级聚合 diff）。

### 9.2 靶有源无（taiji 要求、codex 缺失——宿主侧补齐）

- maxTurns / graceTurns 轮数限制（宿主计数 turn/completed 强停）。
- task.idleTimeoutMs（宿主 idle GC 职责）。
- 精确 cost：turn 级无成本，仅账户面估计 credits/usd micros（v2/thread_usage.rs:9-14）；AgentUsage.cost 恒缺省。
- contextTokens 精确上下文占用（只有窗口容量与累计吞吐，见 §5 语义错配）。
- denyTools 工具黑名单（仅 config override 变通，语义不对等）。
- UiRequest 的 notify/setStatus/setWidget/setTitle/set_editor_text 反向推送（codex 无此形态）。
- exec 降级轨：无 delta 流事件（eventGranularity 降 coarse）、无 reasoning delta。

### 9.3 语义错配（映射时须显式裁决）

1. **thread ≠ taiji session**：codex thread 是会话单位（Thread.session_id 是「session tree 共享 id」，thread_data.rs:205-206），一个引擎进程多 thread；taiji session≈record+sessionFile 一对一。映射取 threadId 为 sessionId，thread.session_id 不投。
2. **turn/item 层级 vs taiji turn/message 两层**：codex 一个 turn 内 items 交错（AgentMessage、Reasoning、CommandExecution…），taiji ReplayedTurn 只有 text/thinking/toolCalls 三槽——**item 顺序与交错信息丢失**（多段正文/思考被合并拼接）；中途 error item 无槽（并入 turn error 或丢弃）。
3. **usage 增量语义**：taiji message_end.usage 是「单条消息增量」；codex tokenUsage/updated 给 {total,last}，last 是「单轮」而非「单消息」——一 turn 多次模型调用时增量粒度粗于 pi；message_end 投影点建议绑 turn/completed 而非 item/completed(AgentMessage)。
4. **compaction 双形态**：thread/compacted 通知已标 deprecated（common.rs:1894-1895），现行 = ContextCompaction item（v2/item.rs:401-403）随 item/started|completed 出现；rollout 侧另有 compacted line（replacementHistory 重建历史）。适配器以 item 形态为准。
5. **正文完成去重**：AgentMessage delta 累积与 item/completed 全文并存，须按 itemId 去重（§4）；Plan delta 注释明示「completed 权威、delta 拼接可能不等」（v2/item.rs:1357-1361），若投 text_delta 需同规则。
6. **fork 语义**：codex thread/fork 产新 threadId（v2/thread.rs:503-514），taiji fork 概念是「继承父 session 上下文的新 run」——resume 锚点须切换为新 fork 的 threadId，宿主 record 的 handle 需更新。
7. **AskForApproval 与 taiji permissionMode 词表**：untrusted/on-request/granular/never 与 taiji 中立模式非一一对应（granular 五开关最细），适配层维护映射表并在 capabilities.permissionMode=native 下做词表翻译。
