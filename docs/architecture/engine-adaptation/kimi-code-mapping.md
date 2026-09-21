# kimi-code → taiji subagent 引擎协议 v1 映射

证据基准：MoonshotAI/kimi-code@d3b27cc7（2026-08-24 快照，TS pnpm monorepo）。源码引用均为该仓库内相对路径（GitHub MoonshotAI/kimi-code）；ACP 标准类型以 `@agentclientprotocol/sdk@1.3.0` schema 为准（acp-server 依赖声明 packages/acp-server/package.json）。
映射目标 = subagent-engine-sdk 协议 v1（`packages/subagent-engine-sdk/src/protocol/`）。

## 1. 接入形态与进程拓扑

推荐 zcode 式常驻接入：spawn `kimi acp`（apps/kimi-code/src/cli/sub/acp-native.ts:30-66，默认路由到 agent-core-v2 引擎；`KIMI_CODE_LEGACY_FLAG` 为真才回 legacy acp-adapter 实现 apps/kimi-code/src/cli/experimental-v2.ts:24-27 与 apps/kimi-code/src/cli/sub/acp.ts:40-44），由 `runAcpServer` 驱动 ACP stdio server（packages/acp-server/src/start.ts:236-239），JSON-RPC over stdio，一个常驻引擎进程承载多个 session。会话生命周期：`session/new`（cwd + mcpServers）→ `session/prompt`（一次一个 turn，streaming `session/update` 通知）→ `session/cancel`；冷续 `session/resume`（不回放）或 `session/load`（先 replayHistory 回放再应答，server.ts:289-303 vs :305-314）。

数据根隔离：`KIMI_CODE_HOME` env 重定向引擎数据根（packages/agent-core-v2/src/app/bootstrap/bootstrap.ts:162-165，`homeDir ?? KIMI_CODE_HOME ?? ~/.kimi-code`）；`kimi acp` 会把该值转发进 `authMethods[0].env`（acp-native.ts:51-56）保证 login 子进程落同一根。会话持久化布局 = `<数据根>/sessions/<workspaceId>/`（bootstrapService.ts:45 + workspaceInstanceManagerService.ts:201），workspaceId 形如 `wd_<slug>_<hash12>` 由 cwd 派生（packages/protocol/src/workspace.ts:5-10）；每 agent journal = `<sessionDir>/agents/<agentId>/wire.jsonl`（packages/node-sdk/src/v2/resume-replay.ts:5-7）。

模型凭据注入：`KIMI_MODEL_NAME`（合成 env provider，别名 `__kimi_env_model__`）+ `KIMI_MODEL_TEMPERATURE` / `TOP_P` / `THINKING_KEEP` / `MAX_COMPLETION_TOKENS`（或 `MAX_TOKENS`）/ `MAX_CONTEXT_SIZE` 等 env overlay（packages/agent-core-v2/src/app/kosongConfig/envOverlay.ts:75-120），spawn 时经 env 传入即可，无需写 config.toml。

CLI `-p` 降级路径：`kimi -p "<prompt>" --output-format stream-json`（apps/kimi-code/src/cli/commands.ts:59-70）。headless 启动强制 permission `'auto'`、结束后恢复（apps/kimi-code/src/cli/v2/run-v2-print.ts:337-342）；轮数上限走 config `task.printMaxTurns`（run-v2-print.ts:482）。局限：coarse 输出、无 ACP 反向交互面（approval/question 无 client 可达），仅作 ACP server 不可用时的回退。

适配层角色：taiji 引擎适配器 = ACP client 侧。正向方法（host→引擎）映射到 ACP agent methods；引擎→host 的 `session/update` 通知与 `session/request_permission` / `elicitation/create` 反向请求映射到协议 event 通知与 host/* 反向通道。引擎方法路由全集见 packages/acp-server/src/server.ts:694-715（`createAcpAgentApp`）。

## 2. run 参数映射表

协议 run 帧 = `{ runId, task: AgentCallOpts, ctx: RunContextParams, resume?: RunResumeParams }`（packages/subagent-engine-sdk/src/protocol/methods.ts:141-151）。

| taiji 字段 | 源对应 | 证据 | 缺省/不可达备注 |
|---|---|---|---|
| task.prompt | `session/prompt` params.prompt（ContentBlock[]，text 块） | server.ts:402-428；ContentBlock→ContentPart convert.ts:26-78 | image 块可传（promptCapabilities.image=true，server.ts:203-207）；audio 丢弃 |
| task.schema | 无对应 | — | ACP prompt 无 schema 参数；kosong provider 层有 `ResponseFormat json_schema`（packages/kosong/src/provider.ts:8-12,151）但 agent/ACP 面不暴露 → 仿真层（schema 放 prompt 文本 + 宿主 ajv 校验） |
| task.thinkingLevel | `session/set_config_option` configId `thinking`（值 `off`/`on`/effort 词表） | server.ts:486-497；session.ts:1075-1100（setThinking，按模型 supportEfforts 校验） | native；词表是 off/on/effort，非 high/medium/low，适配层映射 |
| task.scene | 无对应 | — | 宿主自持，不上 wire |
| task.maxTurns | 无 per-run 参数 | — | 引擎内部有 step 预算（`loop.max_steps_exceeded` 错误码，packages/protocol/src/events.ts:1316）但 ACP 面不可配；CLI 面 config `printMaxTurns`（run-v2-print.ts:482）非 per-run |
| task.graceTurns | 无对应 | — | 适配层忽略 |
| task.skill / task.skillPath | prompt 内 slash 文本 `/skill:<name> <args>` → `agent.activateSkill` | session.ts:487-499（detectSlashIntent）+ :561-566（driveSkillActivation）；slash.ts:42-92 | emulated：适配层把 skill 名拼成 slash 命令文本提交 |
| task.description | 无对应 | — | 诊断字段，宿主自持 |
| task.agent（.md 路径） | CLI `--agent <name>` / `--agent-file <path>`（仅 CLI 新会话） | commands.ts:79-105 | ACP `session/new` 无 agent/persona 参数 → ACP 面不可达；CLI 降级路径可用 |
| task.appendSystemPrompt | 无 ACP 通道；CLI 面经 agent-file 间接承载 | — | emulated：拼接进 prompt 文本首块 |
| task.fork | `session/fork`（UNSTABLE）params.sessionId | server.ts:266-287 | 只能按已知 sessionId fork，无任意源路径 |
| task.forkSource | 同上（sessionId 形态） | server.ts:276 | 「任意 session 文件绝对路径」语义不可达，需 host 把 sessionRef.sessionId 作源 |
| task.worktree | 无对应 | — | 引擎无 worktree 概念；宿主自建 worktree 后把路径放 ctx.cwd |
| task.idleTimeoutMs | 无对应 | — | 引擎无 idle GC 参数；宿主按 ADR-0047 无进展检测 |
| task.denyTools | 无 ACP 参数 | — | 引擎有 `tools.set_active_tools` / `tools.reset_active_tools` wire record（agent/profile/profileOps.ts:96,110）但 ACP 面无方法；不可达 |
| task.permissionMode | `session/set_mode`（default/plan/auto/yolo → permission manual/manual/auto/yolo） | server.ts:447-462；modes.ts:22-43,72-87 | native；taiji 中立词表 yolo/manual/auto 直映 auto/manual/yolo，run 前调用 |
| ctx.cwd | `session/new` params.cwd → workDir | server.ts:242-253 | 仅创建时生效；resume/load/fork 忽略 cwd 类参数（server.ts:290-291 调用 + :648-653 警告实现），session 与 workspace 绑定 → 跨 cwd 续跑不可行 |
| ctx.model | `session/set_model`（扩展方法 {sessionId, modelId}）或 `set_config_option` model 臂 | server.ts:509-524,475-477；session.ts:1048-1063 | native；`,thinking` 后缀合并语法并存（session.ts:1048-1063） |
| ctx.schemaEnv | 无对应 | — | 不可达（kimi env overlay 只承载模型配置，无 schema 通道） |
| ctx.ctxModel | 无独立通道 | — | kimi 无 ctx 模型分离概念；不可达 |
| ctx.streamMode | 恒 stream | events-map.ts:31-42 等 delta 映射 | 引擎恒流式；coarse 请求被忽略 |
| ctx.sessionRootId | 无对应 | — | kimi 无 relay 归属概念；忽略 |
| ctx.sessionDir | `KIMI_CODE_HOME`（引擎数据根粒度，非 per-session） | bootstrap.ts:162-165 | 映射到 spawn env，粒度粗于 taiji 语义 |
| ctx.engineFallback | 无对应 | — | 引擎回填种子，宿主自持 |
| resume.recordId | 无对应 | — | core 预建 record 关联键，适配层自持 |
| resume.resume.sessionRef | `session/resume` / `session/load` params.sessionId | server.ts:305-314,289-303 | 见 §6 sessionRef 构成建议 |

## 3. 事件映射表

源侧三层，逐层穷尽。适配层订阅第②层（ACP 面）只能看到 acp-server 转发的部分；第①层引擎原生事件是语义全集，标注 acp-server 是否透传。

**第①层：引擎事件全集**（`AgentEvent` union 49 成员，packages/protocol/src/events.ts:1006-1059；klient 事件面同源，packages/node-sdk/src/events.ts:1-108）：

| 源事件（type 字面量） | taiji 事件 | 映射方式 | ACP 面可见 | 证据 |
|---|---|---|---|---|
| assistant.delta | text_delta | 直接（event.delta） | 是 | events.ts:764-768；events-map.ts:31-42 |
| thinking.delta | thinking_delta | 直接（event.delta） | 是 | events.ts:778-782；events-map.ts:352-363 |
| tool.call.started | tool_start | 直接（name→toolName, args） | 是（tool_call CREATE/upgrade） | events.ts:792-800；session.ts:747-787 |
| tool.call.delta | （tool_start 前置流） | 丢弃（仅 args 流式预览，无独立 taiji 对应） | 是（tool_call lazy-create/update） | events.ts:784-790；session.ts:789-809 |
| tool.progress | （无独立事件） | 合成 activity（status 文本可作活性信号） | 是（仅 kind=status 且有 text，events-map.ts:332-347） | events.ts:802-807 |
| tool.result | tool_end | 直接（output→result.content[单元素]，isError） | 是 | events.ts:844-851；session.ts:819-848 |
| turn.started | （无） | 丢弃（taiji turn 边界由 run 生命周期承载） | 否 | events.ts:686-695 |
| turn.ended | turn_end + message_end | 合成：reason/error→message_end{error}，turn 闭合→turn_end | 否（仅经 prompt 应答 stopReason 间接表达） | events.ts:697-705；session.ts:907-921 |
| turn.step.started / completed / retrying / interrupted | （无） | 丢弃；completed.usage 见 §5 | 否 | events.ts:707-762 |
| agent.status.updated | activity | 合成（phase/contextTokens 变化即活性） | 否 | events.ts:542-555 |
| compaction.started / completed / cancelled / blocked | compaction | 合成：任一 compaction 事件→一次 compaction{}（acp-server 现行做法是合成文本 chunk） | 是（文本 chunk） | events.ts:903-921；session.ts:882-905 |
| error | error | 直接（KimiErrorPayload.message） | 否（turn.ended failed 才间接可见） | events.ts:676-678 |
| warning | （无） | 合成 host/log（warn） | 否 | events.ts:680-684 |
| prompt.submitted / completed / aborted / steered | （无） | 丢弃 | 否 | events.ts:955-983 |
| subagent.spawned / started / suspended / completed / failed | （无） | 丢弃（kimi 内嵌 subagent 域，taiji 自身即 subagent 宿主，不嵌套消费） | 否 | events.ts:853-901 |
| task.started / terminated（含 legacy background.task.*） | （无） | 丢弃 | 否 | events.ts:923-947 |
| shell.started / output / completed | activity / tool 进度 | 合成 activity | 否 | events.ts:815-842 |
| hook.result | （无） | 丢弃 | 否 | events.ts:770-776 |
| goal.updated / skill.activated / plugin_command.activated / cron.fired | （无） | 丢弃 | 否 | events.ts:651-674,949-953 |
| event.session.created / event.workspace.* / event.session.work_changed / event.session.status_changed / event.config.changed / event.model_catalog.changed / event.plugin.changed / event.capability.changed / session.meta.updated | （无） | 丢弃；metadata.changed(title) acp-server 转 session_info_update | 部分 | events.ts:557-649,1006-1059 |
| tool.list.updated / mcp.server.status | （无） | 丢弃 | 否 | events.ts:985-1004 |

Volatile（不落 journal）事件类别：assistant.delta / thinking.delta / tool.call.delta / tool.progress / shell.* / agent.status.updated / event.capability.changed（events.ts:2026-2039）——journal 重放拿不到这些，read 重建走 durable 消息记录（§6）。

**第②层：ACP `session/update` update variant 全集**（ACP 1.3.0 schema 共 13 variant；kimi 生产点标注）：

| update variant | kimi 生产点 | taiji 事件 | 映射方式 | 证据 |
|---|---|---|---|---|
| user_message_chunk | 仅 session/load 重放（replay.ts:78-86） | （无） | 丢弃 | replay.ts:78-86 |
| agent_message_chunk | assistant.delta、compaction/builtin/unknown-command 本地合成 | text_delta | 直接（content.text→delta）；本地合成 chunk 归 compaction/activity 判定 | events-map.ts:31-42；session.ts:897-905,540-552 |
| agent_thought_chunk | thinking.delta | thinking_delta | 直接 | events-map.ts:352-363 |
| tool_call | tool.call.started（或首个 tool.call.delta lazy-create） | tool_start | 直接（name→toolName，rawInput→args） | events-map.ts:194-226,265-286 |
| tool_call_update | tool.call.delta 累积 / started upgrade / tool.progress 标题 / tool.result 终态 | tool_end（status completed/failed 时） | 直接（rawOutput→result） | events-map.ts:233-253,295-325,332-347,373-389 |
| plan | TodoList display block | （无） | 丢弃（taiji 无 plan 事件面） | events-map.ts:396-415,436-443 |
| plan_update / plan_removed | 无生产点 | （无） | 丢弃 | ACP schema 有、kimi 不产 |
| available_commands_update | 生命周期后置推送 + skills.changed | （无） | 丢弃 | events-map.ts:448-459；session.ts:469-479 |
| current_mode_update | set_mode 后 | （无） | 丢弃 | events-map.ts:468-479 |
| config_option_update | model/thinking/mode 变更后 | （无） | 丢弃 | events-map.ts:486-497 |
| session_info_update | 标题变更 | （无） | 丢弃 | events-map.ts:524-535 |
| usage_update | turn.ended 后一次 | message_end.usage 的唯一 ACP 载体（见 §5 语义差异） | 合成 | events-map.ts:499-518；session.ts:930-944 |

**第③层：`session/prompt` 应答**：`stopReason ∈ {end_turn, max_tokens, max_turn_requests, refusal, cancelled}`（turnEndReasonToStopReason 映射：completed→end_turn、cancelled→cancelled、failed→end_turn（provider.filtered→refusal）、blocked→refusal，events-map.ts:59-74）→ message_end{error?} + turn_end；launch 失败经 JSON-RPC error（-32603 internalError 等，session.ts:118-137）→ error 事件。

## 4. 内容块与 tool 调用映射

ACP `tool_call` / `tool_call_update` 共享同一字段集 `{toolCallId, title, kind, status, content, rawInput, rawOutput, locations, name}`（ACP 1.3.0 schema ToolCall/ToolCallUpdate）→ taiji `ToolCall{toolName, args?, result?, isError?}`（contract-types.ts:71-76）装载：

- toolName ← `name` 字段（create 时由事件携带；acp-server 未显式回填 name 时由 title 兜底，title = description ?? name，events-map.ts:198）。
- args ← `rawInput`（tool.call.started 事件的 args 原样，events-map.ts:221）。
- result.content[] ← `content` 数组投影：`{type:'content'}` 内嵌 text 块逐个入列；`{type:'diff'}`（path/oldText/newText，convert.ts:279-302）与 `{type:'terminal'}`（session.ts:833-843）为非文本形态，适配层序列化为描述性文本或丢入 details。
- result.details ← `rawOutput`（tool.result 的 output 原值，events-map.ts:385）。
- isError ← `status:'failed'`（isError = status==='failed'；ToolCallStatus 全集 = pending/in_progress/completed/failed）。
- kind（ToolKind 10 值 read/edit/delete/move/search/execute/think/fetch/switch_mode/other）与 locations（绝对路径文件位置，events-map.ts:174-188）为 ACP 展示增强，taiji 靶面无对应，丢弃。

tool_call 状态机与 tool_start/tool_end 时序：kimi 引擎先流式吐 args（tool.call.delta），后派发（tool.call.started）——acp-server 对 delta lazy-create `tool_call`(status=pending)（session.ts:789-809）、对 started 视有无先至 delta 发 CREATE 或 upgrade update（status→in_progress，session.ts:747-787）。适配层时序规则：**首个 tool_call/tool_call_update(status∈{pending,in_progress}) → tool_start；tool_call_update(status∈{completed,failed}) → tool_end**；期间仅改标题/内容的中间 update 合成 activity 或丢弃。HideOutputMarker 数组输出被 acp-server 抑制为空 content（convert.ts:333-341，marker.ts），适配层收到空 content 的 completed 终态属正常形态。

ToolCallResult.content 装载口径：ToolResultEvent.output 为 unknown（events.ts:844-851），acp-server 已折叠为 `ToolCallContent[]`（字符串→单 text 块、对象→JSON.stringify，convert.ts:333-356）；适配层把各块 `{type:'content',content:{type:'text',text}}` 的 text 依次推入 result.content[] 即可（与 zcode/claude 引擎的 content 数组形态对齐）。

## 5. usage 映射表

| taiji 字段 | 源对应 | 证据 | 备注 |
|---|---|---|---|
| AgentUsage.input | TokenUsage.inputOther | events.ts:21-26 | 每步增量在 turn.step.completed.usage |
| AgentUsage.output | TokenUsage.output | events.ts:21-26 | 同上 |
| AgentUsage.cacheRead | TokenUsage.inputCacheRead | events.ts:21-26 | 同上 |
| AgentUsage.cacheWrite | TokenUsage.inputCacheCreation | events.ts:21-26 | 同上 |
| AgentUsage.cost? | 无对应 | — | 引擎无成本数据（ACP usage_update 的 cost 恒省略，events-map.ts:505-518）；缺省 |
| AgentOutcomeUsage.cost | 无对应 | — | 恒 0 |
| AgentOutcomeUsage.contextTokens | agent.status.updated.contextTokens / getContext().tokenCount | events.ts:542-555；session.ts:936-937 | 上下文占用水位 |
| AgentOutcomeUsage.turns | 无 per-run 计数 | — | 适配层自计（收到的 turn_end 数或 prompt 次数） |

「turn 后一次非逐消息」语义差异（必须在适配层显式处理）：ACP `usage_update` 是 turn settle 后推送的**上下文水位快照**（used = 当前 context tokenCount，size = 模型 max_context_size，events-map.ts:499-518 + session.ts:930-944），不是本 turn 的 token 消耗增量；且 acp-server 不向 ACP 面转发 turn.step.completed.usage 与 usage.record。**结论：走纯 ACP client 面只能拿到水位，四项细分（input/output/cacheRead/cacheWrite）不可达。** 补齐路径二选一：①适配器直接订阅 klient 事件层（node-sdk `Session.events` / in-memory transport，acp-server 自身即此形态，session.ts:275-330）；②扩展 acp-server 增加转发。usage.record 是 durable wire record（per-model + scope session|turn，agent-core-v2/src/agent/usage/usageOps.ts:11-32），journal 重放可得累计值。

## 6. session 记录与 read 重建

**wire.jsonl record 词表**：WireRecord 是开放形态 `{type: string, time?: number, ...}`（packages/agent-core-v2/src/wire/record.ts:12-22），写入点 = 引擎事件序列化 `wire.appendRecord(event.serialize())`（agent-core-v2/src/state/eventDispatcherService.ts:564）；词表全集 = durable `Event2` 子类静态 type（state/features/agent 各域 ops/events 文件），按域归组：

- 上下文：`context.append_message` / `context.append_loop_event` / `context.clear` / `context.apply_compaction` / `context.undo` / `context.spliced`（agent/contextMemory/contextEvents.ts）
- turn/step：`turn.prompt` / `turn.steer` / `turn.cancel` / `turn.started` / `turn.ended` / `turn.step.started` / `turn.step.completed` / `turn.step.retrying` / `turn.step.interrupted`（agent/loop/）
- 工具：`tool.call.started` / `tool.progress` / `tool.result` / `tool.call.delta` / `tools.update_store` / `tools.set_active_tools` / `tools.reset_active_tools` / `tools.register_user_tool` / `tools.unregister_user_tool`
- usage：`usage.record` / `agent.status.updated` / `token_counting.*`
- 权限/交互：`permission.set_mode` / `permission.approval.requested` / `permission.approval.resolved` / `permission.rules.add` / `permission.record_approval_result` / `interaction.request` / `interaction.resolved`
- compaction：`compaction.started` / `compaction.blocked` / `compaction.cancelled` / `compaction.completed` / `full_compaction.begin` / `full_compaction.cancel` / `full_compaction.complete`
- 计划/目标/技能：`plan_mode.enter/cancel/exit` / `plan.revision` / `goal.create/update/clear/updated` / `skill.activated`
- 会话/配置：`session.meta.updated` / `config.update` / `profile.bind` / `prompt.accepted/completed/aborted/steered/queued` / `subagent.spawned/started/suspended/completed/failed`
- 任务/杂项：`task.started/terminated/notified/waitDelivered` / `shell.started/output/completed` / `mcp.server.status` / `tool.list.updated` / `error` / `warning` / `metadata`

官方 fold 语义（read 重建权威）：resume-replay.ts:20-46 给出 record→replay 映射——`context.append_message`→message（含由 loop event 拼装的 assistant/tool 消息：step.begin 开 assistant 消息、content.part/tool.call 原地变更、tool.result 闭合、中断的 tool 交换合成 interrupted 结果）；`full_compaction.begin`→compaction 记录、`context.apply_compaction` 回填 result；`goal.*`→goal_updated；`plan_mode.*`→plan_updated；`config.update`→config_updated；`permission.set_mode`→permission_updated；`tools.update_store`→工具库 last-wins；`turn.*`/`usage.record` 等只重建状态。

**session/load replayHistory 语义**（ACP 面重建第②通路）：`agent.getContext().history`（ContextMessage[]，role ∈ user/assistant/tool）投影为有序 `session/update` 批（packages/acp-server/src/replay.ts:36-76）——user 文本→user_message_chunk；assistant text/think part→agent_message_chunk/agent_thought_chunk（重放 turnId 合成自增）；assistant.toolCalls→tool_call CREATE（arguments JSON 解析，replay.ts:112-124）；tool 角色消息按 toolCallId 关联→tool_call_update 终态（isError→failed，replay.ts:126-155）；system 等无对应角色跳过。**适配层 read 通路建议**：对已有 sessionId 发 `session/load`，收集重放流聚合出 ReplayedTurn[]（text/thinking/toolCalls/closed=true），source 标 `native`；usage 不随重放供给（delta 类是 volatile，不入 journal 也不入 history），SessionView.usage 缺省或由 journal 的 usage.record 聚合补齐（source 仍标 native/journal 按数据源）。

**ResumeAnchor.sessionRef 构成建议**：`{ sessionId, home }`——sessionId 是引擎 mint 的全局会话 id（session/new 应答，server.ts:252）；home 记录该 session 所属数据根的 KIMI_CODE_HOME 值（数据根隔离部署下同一 sessionId 在不同 home 下不互通，bootstrap.ts:162-165）。resume 执行序列：确保引擎进程以正确 `KIMI_CODE_HOME` 启动 → `session/resume`（冷续，不回放）或 `session/load`（需重建 UI 时）。journalPath 可选填宿主可定位的 `<数据根>/sessions/<workspaceId>/` 下 wire journal 路径，作 read 降级链第②级。

## 7. 反向通道映射

协议 6 反向通道（reverse-channels.ts:24-55）逐条：

| taiji 通道 | 源对应 | 映射方式 | 证据 |
|---|---|---|---|
| host/askUser{runId,request:UiRequest} | `session/request_permission`（RequestPermissionRequest={sessionId, options:PermissionOption[], toolCall?}）+ `elicitation/create`（form 模式） | 引擎 approval 交互→request_permission（options 三档 approve_once/approve_always/reject，kind allow_once/allow_always/reject_once；plan_review 扩展 plan_opt_* 族）→ UiRequest.method=`select`（options=name 列表，title=toolName）；引擎 question 交互→form 能力时 elicitation/create（多问题原生，question.ts:128-162）→ method=`select`/`input` 兜底；响应 outcome{cancelled}/{selected{optionId}}→UiResponse{cancelled:true}/{value:label}。notify/setStatus/setWidget/setTitle/set_editor_text 5 个 method 无 ACP 对应 → {unsupported:true} 降级 | interaction-bridge.ts:95-231；approval.ts:34-73,133-188；question.ts:30-93；acp-client.ts:38-54 |
| host/log{level,component,message,data?} | 无 ACP 标准日志反向通道 | 合成：引擎进程 stderr 排空按行转 host/log（level=warn/error 按内容判别，缺省 debug）；acp-server 自身日志落本地 stderr（log.ts） | start.ts:236-239 |
| host/streamDelta{runId,delta} | 无独立加速通道（agent_message_chunk 即流式主通道） | 合成：text_delta 转 event 通知的同时双发 host/streamDelta | events-map.ts:31-42 |
| host/handleReady{runId,sessionRef} | session id 在 `session/new` 应答即返回 | 合成：session/new/resume 应答落地后立即回填（早于首个事件） | server.ts:252,302,313 |
| host/childSpawned{pid,recordId} | 无 per-task 子进程面（引擎 in-process；Bash 经 client terminal reverse-RPC 时 terminalId 非进程 pid） | 合成：引擎常驻进程 spawn 时上报一次（pid=引擎进程）；不供杀链 | session.ts:858-874 |
| host/childStateChanged{pid,recordId,state,killed,exitCode?} | 无对应 | 合成：宿主进程管理器感知引擎进程退出（exitCode/signal 由 wait 取得）；run 级粒度由 runId 收敛推导 | — |

session/cancel 与 ping 对应物：`session/cancel` 通知（server.ts:430-445）→ 协议 cancel 正向方法（适配层发出后等待该 run 的终态应答）；ACP `session/prompt` 请求级取消走 JSON-RPC `$/cancel_request`（server.ts:402-428 与 session/cancel 汇入同一路径 session.ts:980-1010 `agent.cancel({turnId})`）。**ping 无对应**：ACP 方法集无 ping（server.ts:694-715 全集），健康检查替代 = initialize/version 应答往返或 JSON-RPC 层空请求；静默 ≠ 卡死判据按 ADR-0047 用事件流活性（activity 合成信号）。

## 8. 能力位 11 位表

| 能力位 | 值 | 依据 |
|---|---|---|
| schemaEnforcement | emulated | kosong provider 层有 `ResponseFormat json_schema`（kosong/src/provider.ts:8-12,151）但 agent/ACP prompt 面无 schema 通道；仿真层 prompt 注入 + 宿主 ajv 校验 |
| steer | unsupported（ACP 面） | **缺口显式标注：node-sdk `Session.steer` 存在（packages/node-sdk/src/session.ts:193-196，引擎有 prompt.steered 事件 events.ts:977-983），但 ACP 方法集无 steer 对应方法（server.ts:694-715 全集无）**——纯 ACP 接入不可 steer；如需 steer 须扩展 acp-server 或直连 klient |
| conversation | cold | session/resume + klient.restore 重建（server.ts:305-314,533-547）；非原地续写；gate 判据 `=== "unsupported"` 拒绝，cold 放行 |
| personaInjection | file | CLI `--agent`/`--agent-file`（commands.ts:79-105，.md 定义）；ACP session/new 无 persona 参数——ACP 面走 prompt 通道拼接兜底（emulated 次级） |
| eventGranularity | stream | assistant.delta/thinking.delta/tool.call.delta/tool.progress 全流式转发（session.ts:275-330） |
| sandbox | none | 引擎无 OS 沙箱概念；worktree 文件隔离由宿主 emulated（ctx.cwd 注入 worktree 路径） |
| sessionRead | full | 双通路：①session/load 重放流重建 turns（replay.ts:36-76，text/thinking/toolCalls 全量）；②wire.jsonl 事件溯源 fold（resume-replay.ts:20-46）；usage 不随重放供给（§5） |
| resume | cold | session/resume/load + 进程重启后 klient.restore 可续（server.ts:533-547）；journal 持久于 KIMI_CODE_HOME 树 |
| interrupt | native | session/cancel → agent.cancel({turnId}) 优雅中断（session.ts:980-1010），turn.ended reason=cancelled 收敛；非 kill-only |
| permissionMode | native | session/set_mode 四档 default/plan/auto/yolo，manual/auto/yolo 与 taiji 中立词表直映（modes.ts:72-87）；注意 headless CLI 路径固定 auto（run-v2-print.ts:337-342），常驻 ACP 路径不受此限 |
| maxTurns | false | ACP 常驻面无 per-run 轮数参数；引擎 step 预算不可经 ACP 配置（§2 maxTurns 行） |

## 9. gap 清单

**源有靶无**（kimi 有、taiji 协议面无消费位，适配层丢弃）：

- `plan` / `available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update` 五类展示型 update（§3 第②层）——taiji 无对应事件面；如需 GUI 呈现 todo/命令面板属宿主功能扩展。
- `elicitation/create` form 模式的多问题 + multiSelect 原生形态（question.ts:128-162）——UiRequest 无 multiSelect 字段，只能按单选降级。
- kimi 内嵌 subagent 事件族（subagent.spawned 等 5 类，events.ts:853-901）与 goal/cron/task 域事件——taiji 自身即 subagent 宿主，不消费引擎内嵌嵌套。
- ToolKind / ToolCallLocation / diff content 等 tool 卡片增强形态（§4）。
- session/fork（UNSTABLE）与 session/list 的 cwd 过滤列表（server.ts:266-287,316-323）——协议面 fork 仅锚点语义。

**靶有源无**（taiji 协议要求、kimi ACP 面不可达，标降级策略）：

- task.schema / ctx.schemaEnv → emulated（prompt 注入 + 宿主校验）；kosong 层 json_schema 能力未被任何上层暴露（结构化输出 redesign D1 同型问题）。
- task.maxTurns / graceTurns → ACP 面不可达；长期方向 = 扩展 acp-server 或引擎 loop 参数外露。
- task.denyTools → 不可达（引擎 tools.set_active_tools 无 ACP 方法）。
- steer → 不可达（§8 缺口）。
- 四项细分 usage 的 ACP 通路 → 不可达（§5，需 klient 直连或 acp-server 扩展）。
- host/askUser 的 notify/setStatus/setWidget/setTitle/set_editor_text 五 method → {unsupported:true}。
- ping / host/childSpawned / host/childStateChanged 原生形态 → 合成（§7）。
- ctx.ctxModel / ctx.sessionRootId / task.idleTimeoutMs / task.scene / task.description → 无对应，忽略或宿主自持。

**语义错配**（两侧词表/生命周期不同构，映射时须显式折算）：

- **turn 粒度**：kimi 一个 turn = 一次 session/prompt 的完整循环，内含多个 turn.step（每 step 一次 LLM 调用）；taiji 的 Turn（reducer turns[] 元素）≈ kimi 的 step 而非 turn。纯 ACP 面看不到 turn.step 边界（acp-server 不转发 turn.step.*）→ 一次 run 在 GUI 上退化为单 turn 形态；task.maxTurns 的「轮」若按 taiji 语义折算应映射引擎 step 预算，而该预算 ACP 面不可配。
- **usage 语义**：ACP usage_update 是上下文水位数（context tokenCount）非消耗增量；直接当 message_end.usage 用会系统性偏差（§5）。
- **session ↔ workspace 绑定**：session 定位 = KIMI_CODE_HOME × workspace(cwd 派生) × sessionId；跨 cwd 或跨数据根复用同一 sessionId 不可行，resume 锚点必须携带 home（§6）。
- **permissionMode 语义轴**：kimi 四档 mode 是 plan×permission 正交轴的合并投影（plan 同时改 planMode+permission，modes.ts:61-87）；taiji permissionMode 只管 permission 轴——映射 plan 档时需明确是否接受副作用（进入只读 plan 模式）。
- **thinkingLevel 词表**：kimi = off/on/effort（模型声明 supportEfforts 决定值域，session.ts:1075-1100）；taiji = high/medium/low 类词表，适配层需按模型目录折算，且 always_thinking 模型无 off。
- **compaction 事件形态**：kimi 把 compaction 进度合成为正文文本 chunk（session.ts:882-905）而非结构化事件；taiji compaction{} 事件与 text_delta 流的边界要靠适配层状态机区分，否则压缩提示文本会混入 turn 正文。
