# openclaw → subagent 引擎协议 v1 映射

> 证据基准：GitHub openclaw/openclaw @ 7a8d307（2026-06-02 快照，较旧，结论按机制存在性采信）。
> 靶面 = 本仓 `packages/subagent-engine-sdk/src/protocol/`（协议 v1）。源侧引用一律为该仓库内相对路径（`src/`、`packages/`），不指本仓。

---

## 1. 接入形态与进程拓扑

推荐 zcode 式常驻适配器：适配器常驻 openclaw gateway（`openclaw gateway` 启动，单进程多路复用 WS+HTTP，默认端口 18789，`src/gateway/server.impl.ts:541`），经 WebSocket JSON-RPC 风格帧通信（帧型 `{type:"req"|"res"|"event", ...}`，`packages/gateway-protocol/src/schema/frames.ts:139-163`；req 帧带字符串 id + method + params，res 帧带 `ok/payload/error`，event 帧带 `event/payload`）。核心方法面：`sessions.send` / `sessions.steer` / `sessions.abort` / `sessions.subscribe` / `sessions.messages.subscribe` / `sessions.usage`（`src/gateway/server-methods.ts:462-484,548-550`）、`exec.approvals.get|set|node.get|node.set`（同文件 `:342-345`）+ 运行时审批 `exec.approval.request` / `exec.approval.waitDecision`（`src/gateway/server-aux-methods.ts:4-5`）、`tools.catalog`（`:412`）、`models.list`（`:354`）。`sessions.send` 内部委托 `chat.send`（`src/gateway/server-methods/sessions.ts:916-977`），live 事件经内部 event bus（`src/infra/agent-events.ts`）→ gateway 事件处理器（`src/gateway/server-runtime-subscriptions.ts:104-106`）→ WS `agent` / `chat` 事件推送（`src/gateway/server-chat.ts:794,728`）。

CLI 单次降级路径：`openclaw agent --message "..."`（`src/agents/agent-command.ts:589` 必填校验；入口 `agentCommand()` `:2176`）同步等终态、输出最终 JSON/文本，期间事件只进内部 bus 不外推——无流式，只能喂 taiji `eventGranularity=coarse`，仅作 gateway 不可达时的降级。

ACP 桥接备选：openclaw 自带 ACP 面（`src/acp/`：translator/session-mapper/permission-relay，`src/acp/client.ts:46` 以子进程 `acp` 命令拉起；`packages/acp-core/` 提供 session 助手）。但 ACP 桥 = taiji 协议 → ACP → openclaw 内部双翻译层，事件语义两层损耗且 steer/usage 面收窄，仅作 gateway RPC 不可行时的备选，代价高于直连。

## 2. run 参数映射表

gateway 侧请求参数权威：`SessionsSendParamsSchema`（`packages/gateway-protocol/src/schema/sessions.ts:144-154`：key/agentId/message/thinking/attachments/timeoutMs/idempotencyKey）→ `chat.send` params（`src/gateway/server-methods/chat.ts:2877-2911`）→ 内部 `AgentCommandOpts`（`src/agents/command/types.ts:41-141`）。

| taiji 字段 | 源对应 | 证据 | 缺省/不可达备注 |
|---|---|---|---|
| task.prompt | sessions.send `message` | schema/sessions.ts:147 | 直接映射 |
| task.schema | 无 | —（grep 全仓无 outputSchema/jsonSchema 输出约束） | **靶有源无**：unsupported |
| task.thinkingLevel | sessions.send `thinking`（字符串）→ 注入 `/think <level> <msg>` 命令前缀 | chat.ts:3306-3308 | 词表不同：源为自由字符串，taiji 为 high/medium/low，适配器做映射 |
| task.scene | 无 | — | **靶有源无**：丢弃 |
| task.maxTurns | 无（grep agent 路径无 maxTurns） | — | **靶有源无**：unsupported |
| task.graceTurns | 无 | — | **靶有源无**：丢弃 |
| task.skill / skillPath | 无一等参数；可经 workspace 文件注入 | — | 降级：把 SKILL.md 内容并入 message 或 extraSystemPrompt |
| task.description | 无（诊断字段，宿主自持即可） | — | 不上 wire |
| task.agent（.md 绝对路径） | `AgentCommandOpts.agentId`（须存在于 config） | command/types.ts:51-52 | 语义错配：源是注册 agent id 不是 .md 路径 |
| task.appendSystemPrompt | `AgentCommandOpts.extraSystemPrompt`（单 string） | command/types.ts:102 | taiji 数组 → join 合成单串 |
| task.fork | `sessions.create` `parentSessionKey` / store row `forkedFromParent` | schema/sessions.ts:128-137；config/sessions/types.ts:227-229 | 经 fork-from 既有会话形态合成 |
| task.forkSource | `parentSessionKey`（sessions.create） | schema/sessions.ts:131 | 同上 |
| task.worktree | 无隔离机制（仅 spawnedWorkspaceDir 继承，无 git worktree 创建） | config/sessions/types.ts:222-226 | **靶有源无**：unsupported |
| task.idleTimeoutMs | store row `queueDebounceMs` 语义不同；无 per-run idle 超时 | — | **靶有源无**：宿主自持 |
| task.denyTools | `AgentCommandOpts.toolsAllow`（allowlist 反向）+ store row `inheritedToolDeny` | command/types.ts:91；config/sessions/types.ts:245 | deny 语义经 per-session patch（sessions.patch `inheritedToolDeny`，schema/sessions.ts:205-207）间接达成 |
| task.permissionMode | ExecMode 五值 `deny\|allowlist\|ask\|auto\|full`（execSecurity+execAsk 两轴组合，store row `execSecurity/execAsk`） | src/infra/exec-approvals.ts:23-26,102-116 | 映射表见 §8 |
| ctx.cwd | `AgentCommandOpts.cwd`（run 级）+ `workspaceDir` | command/types.ts:123-124 | 直接映射 |
| ctx.model | `AgentCommandOpts.model` + `provider` | command/types.ts:54-56 | 直接映射 |
| ctx.schemaEnv | 无 | — | unsupported |
| ctx.ctxModel | 无 | — | 丢弃 |
| ctx.streamMode | bus 推送恒 stream 粒度（assistant/thinking/tool 流） | §3 | 无 coarse 开关，适配器侧自行节流 |
| ctx.sessionRootId | 无对等（源用 sessionKey 归属） | — | 丢弃 |
| ctx.sessionDir | 会话文件由 gateway 按 agentId 固定布局落盘（`<state>/agents/<agentId>/sessions/`） | src/config/sessions/paths.ts:10-18 | 不可指定，忽略 |
| ctx.engineFallback | `AgentCommandResultMetaOverrides.fallbackFrom/fallbackReason` | command/types.ts:20-25 | 诊断回填 |
| resume.recordId | runId 体系：`idempotencyKey` 兼作 clientRunId | chat.ts:2968 | 关联键换成 runId |
| resume.sessionRef | sessions.send `key`（sessionKey 指向既有会话即原地续聊）+ `sessionId` 定位 | schema/sessions.ts:144-146；config/sessions/types.ts:207-209 | 见 §6 |
| resume.journalPath | 无 journal 概念 | — | 缺省 |

## 3. 事件映射表

源侧事件共四层，全集如下。

**层 1：agent loop 事件 union（`packages/agent-core/src/types.ts:481-508`，10 种，穷尽）**
`agent_start` / `agent_end{messages}` / `turn_start` / `turn_end{message,toolResults}` / `message_start{message}` / `message_update{message,assistantMessageEvent}` / `message_end{message}` / `tool_execution_start{toolCallId,toolName,args}` / `tool_execution_update{toolCallId,toolName,args,partialResult}` / `tool_execution_end{toolCallId,toolName,result,isError}`

**层 2：message_update 内嵌 LLM 流事件 AssistantMessageEvent（`packages/llm-core/src/types.ts:333-349`，12 种，穷尽）**
`start{partial}` / `text_start` / `text_delta{delta}` / `text_end{content}` / `thinking_start` / `thinking_delta{delta}` / `thinking_end{content}` / `toolcall_start` / `toolcall_delta{delta}` / `toolcall_end{toolCall}` / `done{reason,message}` / `error{reason,error}`——全部经 `agent-loop.ts:383-436` 包装为 `message_update` 上抛（嵌入点 `:395-413`）。

**层 3：内部 event bus 通道（`src/infra/agent-events.ts:5-17`，`AgentEventStream` = 11 具名 + 开放字符串，穷尽）**
`lifecycle` / `tool` / `assistant` / `error` / `item` / `plan` / `approval` / `command_output` / `patch` / `compaction` / `thinking` + `(string & {})`（实走中出现 `acp`，`src/agents/command/attempt-execution.ts:801-830`）。载荷统一 `{runId, seq, stream, ts, data, sessionKey?, sessionId?, agentId?}`（`:102-116`）。各具名通道发射点：lifecycle start/error/end（`src/agents/embedded-agent-subscribe.handlers.lifecycle.ts:32-40,151-196`）、tool start/update/result（`src/agents/embedded-agent-subscribe.handlers.tools.ts:952-963,1070-1080,1292-1303`）、assistant text/delta（`src/agents/embedded-agent-subscribe.handlers.messages.ts:787-797,938-948`）、thinking（`src/agents/embedded-agent-subscribe.ts:1086-1093`）、compaction start/end（`src/agents/embedded-agent-subscribe.handlers.compaction.ts:52-62,144-152`）。

**层 4：gateway WS 推送事件（`src/gateway/server-methods-list.ts:29-56` 广播名全集）**
与本映射相关：`agent`（bus 事件透传，payload = AgentEventPayload + `spawnedBy?`，`src/gateway/server-chat.ts:779-811`）、`chat`（run 状态机 `state:"final"|"error"` + 最终 message，`src/gateway/server-methods/chat.ts:2160-2182,2225-2264`）、`session.message`（落盘后逐条消息，`src/gateway/server-session-events.ts:194-204`）、`sessions.changed`（会话行快照/lifecycle，`server-session-events.ts:201-208,227-241`）、`exec.approval.requested/resolved`。

**映射表（源 → taiji 9 事件）：**

| 源类型 | taiji 事件 | 映射方式 | 证据 |
|---|---|---|---|
| bus `tool` phase=start | tool_start{toolName,args} | 直接（name→toolName，data.args） | handlers.tools.ts:952-963 |
| bus `tool` phase=update | 无对应 | 丢弃（或降级合成 activity） | handlers.tools.ts:1070-1080 |
| bus `tool` phase=result | tool_end{toolName,result,isError} | 直接（result.content/details 见 §4） | handlers.tools.ts:1292-1303 |
| bus `assistant`（text/delta/replace） | text_delta{delta} | 合成（delta 缺失时由前后 text 差分；replace=true 先发清空 delta） | handlers.messages.ts:787-797,495-517 |
| bus `thinking`（text/delta） | thinking_delta{delta} | 直接 | embedded-agent-subscribe.ts:1086-1093 |
| bus `lifecycle` phase=start | 无对应 | 丢弃（可作 run 开始标记） | handlers.lifecycle.ts:32-40 |
| bus `lifecycle` phase=end | turn_end + message_end | 合成（run 终态：taiji 每 turn=「一次 assistant 响应+工具批」，源 turn_end 事件类型层存在但 bus 不单发，需从 assistant message_end 序列合成 turn 边界） | handlers.lifecycle.ts:151-196 |
| bus `lifecycle` phase=error | message_end{error} + error{message} | 合成（data.error→两处） | handlers.lifecycle.ts:151-168 |
| bus `error` | error{message} | 直接（声明通道；观测面） | agent-events.ts:5-17 |
| bus `item` / `plan` / `command_output` / `patch` | 无对应 | 丢弃（UI 呈现面；plan 可选映射 setStatus 类 UiRequest，非事件面） | agent-events.ts:254-317 |
| bus `approval` phase=requested/resolved | activity | 丢弃为事件；走反向通道（§7） | agent-events.ts:280-291 |
| bus `compaction` phase=start/end | compaction{} | 直接（end 到达时发 1 次；start 丢弃） | handlers.compaction.ts:52-62,144-152 |
| LLM `text_delta`/`thinking_delta`/`text_end`/`thinking_end` | 同上 text_delta / thinking_delta | 经 bus 后同上（bus 已消费，适配器只看 bus） | llm-core types.ts:335-340 |
| LLM `toolcall_start/delta/end` | tool_start 前身 | 直接消费点在 loop 内部（生成 content block），bus 侧对应 `tool` 通道 | llm-core types.ts:341-343 |
| LLM `start` | 无对应 | 丢弃 | llm-core types.ts:334 |
| LLM `done{reason,message}` | message_end{usage} | 合成（message.usage → usage，§5；stopReason 丢弃或映射 error） | llm-core types.ts:344-348 |
| LLM `error{reason,error}` | message_end{error} | 合成（error.errorMessage） | llm-core types.ts:349 |
| loop `agent_end{messages}` | message_end 终态判据 | 合成（bus lifecycle end 已覆盖） | types.ts:484 |
| loop `tool_execution_*` 三种 | bus `tool` 通道的源 | 经 handlers.tools.ts 转译后同上 | types.ts:494-508 |
| loop `turn_start` | 无对应 | 丢弃 | types.ts:486 |
| 无源 | activity{} | 合成：适配器按周期自产（源无纯活性信号；lifecycle 非周期） | — |

## 4. 内容块与 tool 调用映射

- **流式生成段**（LLM 侧）：`toolcall_start/delta/end`（`packages/llm-core/src/types.ts:341-343`）产出的最终块是 `ToolCall{type:"toolCall", id, name, arguments: Record<string,unknown>}`（`:224-231`）——delta 阶段是 arguments JSON 片段累积，`toolcall_end` 才带完整 ToolCall。taiji `tool_start{toolName,args}` 取自执行段的 args，不取流式段。
- **执行段**：loop 事件 `tool_execution_start{toolCallId,toolName,args}` → `update{partialResult}` → `end{result,isError}`（`packages/agent-core/src/types.ts:494-508`）；bus `tool` 通道三相位 `{phase:"start",name,toolCallId,args}` / `{phase:"update",partialResult}` / `{phase:"result",name,toolCallId,meta,isError,result}`（`src/agents/embedded-agent-subscribe.handlers.tools.ts:952-963,1070-1080,1292-1303`）。**taiji tool_start ← phase=start（name/args）；tool_end ← phase=result**。
- **result 装载**：执行产物的类型是 `AgentToolResult{content:(TextContent|ImageContent)[], details, progress?, terminate?}`（`packages/agent-core/src/types.ts:418-430`）；落盘/loop 终态为 `ToolResultMessage{toolCallId,toolName,content,details?,isError}`（`packages/llm-core/src/types.ts:266-273`）。taiji `tool_end.result{content,details}` ← `result.content`（Text/Image 块数组原样）+ `result.details`（unknown 原样）；`isError` ← 事件 `isError` 与结果体错误标记的或（handlers.tools.ts:1162 `isToolError = isError || isToolResultError(result)`）。注意 bus result 相位的 `result` 经 sanitize（`sanitizeToolResult`）且 exec 类命令输出被截断（`capLiveExecResult`）——完整原文以 transcript 为准（§6）。

## 5. usage 映射表

源侧 usage 权威类型 `Usage`（`packages/llm-core/src/types.ts:240-252`）：

```ts
{ input, output, cacheRead, cacheWrite, totalTokens,
  cost: { input, output, cacheRead, cacheWrite, total } }
```

挂在 `AssistantMessage.usage`（`:276`）；每条 assistant 消息终态由订阅侧 `recordAssistantUsage/commitAssistantUsage` 消费（`src/agents/embedded-agent-subscribe.handlers.messages.ts:849-851`），累计进 sessions store 行（`src/config/sessions/types.ts:330-332` inputTokens/outputTokens/totalTokens、`:355-357` estimatedCostUsd/cacheRead/cacheWrite、`:373` contextTokens）与 `sessions.usage` 聚合（`src/gateway/server-methods/usage.ts:942`，聚合字段族 `input/output/cacheRead/cacheWrite/totalTokens/totalCost` `:557`）。

| taiji 字段 | 源对应 | 证据 |
|---|---|---|
| AgentUsage.input | Usage.input | llm-core types.ts:241 |
| AgentUsage.output | Usage.output | :242 |
| AgentUsage.cacheRead | Usage.cacheRead | :243 |
| AgentUsage.cacheWrite | Usage.cacheWrite | :244 |
| AgentUsage.cost? | Usage.cost.total | :246-252 |
| AgentOutcomeUsage.contextTokens | store row `contextTokens`（最近一次 API 快照派生） | config/sessions/types.ts:373 |
| AgentOutcomeUsage.turns | 无源（无轮次计数器；可由 transcript assistant 消息数合成） | — **靶有源无** |

## 6. session 记录与 read 重建

**存储布局**：索引文件 `<state>/agents/<agentId>/sessions/sessions.json`（`src/config/sessions/paths.ts:35-37`），行类型 `SessionEntry`（`src/config/sessions/types.ts:203`，含 `sessionId/updatedAt/sessionFile?` `:207-209`、usage 字段、`spawnedBy/parentSessionKey` 等）；transcript 为逐行 JSONL `<sessionId>.jsonl`（`paths.ts:240-257`，id 校验 `SAFE_SESSION_ID_RE` `:62`）。

**entry 类型全集（9 种 + 文件头，`src/agents/embedded-agent-runner/transcript-file-state.ts:14-34` 别名表；union 权威 `src/agents/sessions/session-manager.ts:140-150`）**：
`message`（AgentMessage 载荷，`:68-71`）/ `thinking_level_change` / `model_change` / `compaction{summary,firstKeptEntryId,tokensBefore}`（`:87-96`）/ `branch_summary` / `custom`（不进 LLM 上下文）/ `custom_message`（进上下文）/ `label` / `session_info`。文件头 `session`（FileEntry 含 header，`session-manager.ts:152-153`）。

**重建语义**：`parseSessionEntries`（`session-manager.ts:294-313`）逐行 JSON.parse、静默跳过坏行；`buildSessionContext`（`:327-366`）按 id/parentId 树从 leaf 走到 root 产出消息序列，途中展开 compaction/branch_summary。**工具调用修复还原**：读取侧 `transcript-file-state.ts` 对内容块做修复——把异构 provider 的 toolcall 块（`functionCall/function_call/toolCall/toolUse/tool_call/tool_use`，`:39-46`，id 字段别名 `:77-86`）归一为标准 toolCall 块，并修复断链 parentId/compaction.firstKeptEntryId（`:337-360`）。

**ReplayedTurn 映射**：沿树路径顺序扫 `message` entry；role=assistant → 开新 turn（text←TextContent 块拼接、thinking←ThinkingContent 块拼接、usage←message.usage）；role=toolResult → 追加到当前 turn.toolCalls（toolName/toolCallId 关联、content/details/isError）；user → 关闭上一 turn（closed=true）；compaction → taiji compaction 语义（重放元数据）。`session` 头 id 即 sessionId。

**sessionKey 定位与 ResumeAnchor 建议**：sessionKey 是路由键 `agent:<agentId>:<rest>`（`src/routing/session-key.ts:121,124-127`），指向 store 行，≠ 语义 session id（`sessionId`，uuidv7，`session-manager.ts:242-244`；store 行可经 reset 轮换 sessionId）。建议 `ResumeAnchor.sessionRef = { sessionKey, sessionId, sessionFile, agentId }`——send/steer 以 sessionKey 定位（`schema/sessions.ts:144-146`），sessionFile 兜底直读 transcript（`paths.ts:267-282` resolveSessionFilePath）。

## 7. 反向通道映射

源侧方向说明：openclaw 的 `sessions.steer` 是**宿主→引擎的正向消息注入**（排队语义，§8），与 taiji host/* 反向通道（引擎→宿主）方向相反，不构成对应物。6 通道逐条：

| taiji 反向通道 | 源对应物 | 映射方式 |
|---|---|---|
| host/log{level,component,message,data?} | 无 RPC 对应；gateway 日志面 `logs.tail` 是宿主拉取 gateway 自身日志 | 合成：适配器自身日志桥接，openclaw 内部日志不回传 |
| host/askUser{runId,request:UiRequest} | exec 审批流：`exec.approval.request` 两相注册（`src/agents/bash-tools.exec-approval-request.ts:128-153`）+ `exec.approval.waitDecision`（`:155-170`）+ WS `exec.approval.requested/resolved` 广播（server-methods-list.ts:58-59）+ `/approve` 命令裁决；方法注册 `src/gateway/server-aux-methods.ts:4-5`、scope `operator.approvals`（`src/gateway/methods/core-descriptors.ts:59`） | **可映射部分**：confirm（approve/deny 二值 → UiResponse {confirmed}），select（含 allowlist-always 等 >2 选项时）。**降级部分**：input/editor/notify/setStatus/setWidget/setTitle/set_editor_text 无源对应（消息渠道本位系统无交互 UI 请求面）；适配器对未支持 method 回 {unsupported:true} |
| host/streamDelta{runId,delta} | 无对应（源是引擎正向推 `agent`/`chat` 事件给订阅端，无引擎→宿主的流加速通道需求） | 无对应：适配器空实现 |
| host/handleReady{runId,sessionRef} | 无显式对应；runId 在 `sessions.send` 应答即返回（chat.send payload `runId`，sessions.ts:958-966），store 行随即含 sessionId/sessionFile | 合成：适配器在 run 受理后从应答 + store 行组装 sessionRef 上报 |
| host/childSpawned{pid,recordId} | 无对应：`sessions_spawn` 产出的是子会话（store 行 `spawnedBy/spawnDepth`，config/sessions/types.ts:220-233）不是子进程，无 pid | 无对应：能力性缺失（taiji 侧 isResumable 镜像退化） |
| host/childStateChanged{pid,recordId,state,killed,...} | 无对应（同上；终态以 `chat` 事件 state=final/error 与 store 行 status 为准） | 无对应 |

exec.approvals.*（get/set 配置面，`src/gateway/server-methods/exec-approvals.ts:126-190`，乐观锁 baseHash `:27-72`）映射 taiji permissionMode 配置读写，不属运行时审批。审批事件结构 `AgentApprovalEventData{phase,kind,status,command,host,scope,...}`（`src/infra/agent-events.ts:57-75`）→ UiRequest confirm 所需的 title/message 可由 `command+reason` 合成。

## 8. 能力位 11 位表

| 能力位 | 值 | 依据 |
|---|---|---|
| schemaEnforcement | unsupported | 全仓无输出 schema 约束机制（grep 无 outputSchema/jsonSchema 类参数） |
| steer | emulated | `sessions.steer` = 队列注入：interrupt 当前活跃 run 后重发（sessions.ts:852 `method:"sessions.send"\|"sessions.steer"` + `:1998 interruptIfActive:true`；`src/agents/sessions/agent-session.ts:1325,1362` steeringMessages.push → `agent.steer`）；非流中原地注入（agent-core 的 getSteeringMessages 队列在工具批间排空，`packages/agent-core/src/types.ts:218-228`、`agent-session.ts:1517`） |
| conversation | native | 既有 sessionKey 原地续聊（send 到既有会话即续写，无冷重建），resume 语义 = 同 key 再 send |
| personaInjection | file | persona 走 workspace 文件（SOUL.md persona/tone，`src/agents/system-prompt.ts:219`；AGENTS.md/TOOLS.md 引导 `:219,1016`），非 CLI flag |
| eventGranularity | stream | assistant/thinking/tool 全流式 bus 推送（§3）；无 coarse 开关（适配器可自行降采样） |
| sandbox | none | 无 OS sandbox；exec 执行面为宿主/gateway/node 直接执行（`src/infra/exec-approvals.ts:22` ExecHost 三值），文件隔离仅有 spawn workspace 继承 |
| sessionRead | full | transcript JSONL 全量可读（9 类 entry + 工具块修复还原，§6） |
| resume | native | 原地续（同 conversation） |
| interrupt | native | 进程内 AbortController 协作中止：`Agent.abort()`（`packages/agent-core/src/agent.ts:343-345`，ActiveRun.abortController `:188-191`）← sessions.abort/chat.abort 链（sessions.ts:829 `abortEmbeddedAgentRun` + `:833` 清队列 + `:836` waitForEmbeddedAgentRunEnd 15s） |
| permissionMode | native | ExecMode 五态 + exec.approvals 读写 + 运行时审批（§7）；映射：deny→security=deny、allowlist→security=allowlist+ask=off、ask→ask=on-miss/always、auto→security=full+ask=off、full→security=full（组合权威 `src/infra/exec-approvals.ts:102-116` resolveExecModeFromPolicy） |
| maxTurns | false | 无轮次上限机制（§2 grep 证据）；仅 run 级 `timeoutMs` 墙钟（chat.ts:3035） |

## 9. gap 清单

**源有靶无**（引擎多出、taiji 协议面不承载——适配器丢弃或自持）：
- bus `item/plan/command_output/patch` 四个 UI 呈现通道；`exec.approval.requested` 之外的结构化审批元数据（approvalId/allowlist 项）。
- 多渠道路由面（channel/account/thread/replyTo，`AgentCommandOpts` :57-98）与消息渠道本位的会话拓扑（group/DM sessionKey 族）。
- cron/heartbeat/skills/web 等平台方法族；ACP 双面。
- `exec.approvals.node.get/set` 远程节点审批配置。

**靶有源无**（taiji 协议要求、引擎缺位——需降级或 unsupported）：
- task.schema / ctx.schemaEnv（结构化输出）→ schemaEnforcement=unsupported。
- task.maxTurns / graceTurns → maxTurns=false，graceTurns 丢弃。
- task.worktree（文件隔离）→ 无；task.denyTools 仅经 inheritedToolDeny patch 间接达成。
- AgentOutcomeUsage.turns、AgentOutcome.exitCode（无进程退出码语义，常驻形态恒无）、AgentOutcome.failureKind（需适配器从 stopReason/errorMessage 分类合成）、activity（源无纯活性信号，适配器自产）。
- host/streamDelta、host/childSpawned、host/childStateChanged 三反向通道；UiRequest 的 input/editor/notify/setStatus/setWidget/setTitle/set_editor_text。
- task.skill/skillPath 一等参数、ctx.sessionDir/sessionRootId、idleTimeoutMs。

**语义错配**（名字近似但语义不同，映射时必须显式换算）：
- sessionKey ≠ sessionId：sessionKey 是 `agent:<id>:<rest>` 路由键（可轮换指向新 sessionId），sessionId 是 uuidv7 transcript 身份——ResumeAnchor 必须双带（§6）。
- steer 排队 vs 原地注入：源 steer = 打断当前 run + 重发消息（interruptIfActive:true）或排空队列注入；taiji steer 语义（turn 间注入）粒度更细，适配器只能保证「下个排空点前生效」，非流中实时。
- 消息渠道本位的 persona：persona 由 workspace 文件（SOUL.md/AGENTS.md）按 agentId 解析，非 per-run .md 路径参数；task.agent 需做「路径 → 预注册 agentId」的注册表换算。
- thinkingLevel 传参形态：源是 message 前缀命令 `/think`（chat.ts:3306-3308）不是结构化参数，且 per-session patch（sessions.patch thinkingLevel）另一条路——双通道并存。
- run 生命周期：源 run 状态机由 `chat` 事件 state(final/error) + lifecycle phase(end/error) 双面表达，与 taiji「run 应答即终态」单点不同；`sessions.send` 的应答是受理 ack（runId）而非终态，适配器须把 WS 终态事件桥接为 run 应答 resolve。
- turn 边界：taiji turn_end 语义锚定「一次 assistant 响应闭合」，源的 turn 是 loop 内部概念（bus 不直接发 turn 事件），需从 assistant message 序列合成 turn 边界。
