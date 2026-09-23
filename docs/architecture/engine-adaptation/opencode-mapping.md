# opencode 引擎适配映射（subagent 引擎协议 v1）

证据基准：GitHub sst/opencode@70a2469（2026-09-21 clone）。文中 `file:line` 均为该仓库内相对路径；taiji 侧类型锚定 `packages/subagent-engine-sdk/src/protocol/`（contract-types.ts / methods.ts / reverse-channels.ts）与 `src/ui-types.ts`。

**现行活跃链判定（映射总锚点）**：opencode schema 包并存两套事件族，serve 现行只发布 v1 族——

- **v1 族（现行发布，映射锚）**：`packages/schema/src/v1/session.ts:571-676`（10 事件）+ `packages/schema/src/v1/permission.ts:61-66` + `packages/schema/src/question.ts:78-88` + `packages/schema/src/session-status-event.ts:34-48` + `packages/schema/src/session-compaction-event.ts:5-9` + `packages/schema/src/session-todo.ts:17-21`。发射点实证：`packages/opencode/src/session/session.ts:535,622,631,637,746,857,869,884`、`packages/opencode/src/session/processor.ts:625-638`、`packages/opencode/src/session/status.ts:40-43`、`packages/opencode/src/session/compaction.ts:554`、`packages/opencode/src/permission/index.ts:100,115`。
- **v2 细粒度族（`session.next.*`，已定义未接线）**：`packages/schema/src/session-event.ts:54-512`（32 variant，grep 穷尽）；发射器已写在 `packages/core/src/session/runner/publish-llm-event.ts:57`，但 `packages/opencode/src` 零发布点（grep 证），serve 主 prompt 链（`packages/opencode/src/session/prompt.ts`）不经过 core runner。适配不依赖它；若上游切换再补 delta 直映。
- `permission.v2.asked/replied`（`packages/schema/src/permission.ts:43-51`）同样零发布点，运行时生效的是 v1 `permission.asked/replied`。

## 1. 接入形态与进程拓扑

zcode 式常驻子进程：宿主 spawn `opencode serve`（headless HTTP server，`packages/opencode/src/cli/cmd/serve.ts:7-22`；端口解析显式 4096 优先回落随机，`packages/opencode/src/server/server.ts:117-122`；`OPENCODE_SERVER_PASSWORD` 可选鉴权）。宿主适配器经 `@opencode-ai/sdk`（`packages/sdk/js`，hey-api 生成，`createOpencodeClient` 见 `packages/sdk/js/src/client.ts:42-60`）走 HTTP + SSE；多项目目录经 `x-opencode-directory` header（或 `?directory=` query）路由到 per-directory instance。事件流 = `GET /event`（SSE，`packages/opencode/src/server/routes/instance/httpapi/groups/event.ts:8-27`），帧形状 `{id, type, properties}`（`.../handlers/event.ts:40`），首帧 `server.connected`、10s 心跳 `server.heartbeat`、终止帧 `server.instance.disposed`（`.../handlers/event.ts:42-70`）；SSE 可文档化类型全集 = `EventManifest.Latest` + instance disposed（`.../api.ts:29-43`）。run 形态：`POST /session/{id}/message`（同步，阻塞至 run 终态返回 WithParts）或 `POST /session/{id}/prompt_async`（立即返回，事件全走 SSE）——**适配器必须用 prompt_async + SSE 消费**，否则 permission 挂起会吊住同步 HTTP 连接（见 §7）。

## 2. run 参数映射表

prompt 入口 schema = `SessionPrompt.PromptInput`（`packages/opencode/src/session/prompt.ts:1500-1532`），经 `POST /session/{sessionID}/message` 提交（payload = PromptInput 去 sessionID，`.../groups/session.ts:70,316-328`）。session 预创建 = `POST /session`（`Session.CreateInput`：parentID/title/agent/model/metadata/permission/workspaceID，`packages/opencode/src/session/session.ts:260-271`）。

### task（AgentCallOpts）

| taiji 字段 | 源对应 | 证据 | 缺省/不可达备注 |
|---|---|---|---|
| prompt | `parts: [{type:"text", text}]`（TextPartInput） | prompt.ts:1516-1531 | 必经 parts 数组，适配器包一层 |
| schema | `format: {type:"json_schema", schema, retryCount}` | prompt.ts:1508-1511；注入 StructuredOutput 工具 prompt.ts:1243-1250、system 提示 :1271、toolChoice:"required" :1285 | emulated 通道（工具注入法）；产出落 assistant.structured（:1288-1292）；模型未调用 → StructuredOutputError（:1309-1316，retries=0 无自动重试） |
| thinkingLevel | 无直接对应；`variant`（模型变体，provider 定义 reasoning 档位）部分承载 | prompt.ts:1509,1514（variant）；createUserMessage variant 解析 :653-659 | 不可靠映射，标不可达；能落到 variant 的 provider 才生效 |
| scene | 无对应 | — | 丢弃 |
| maxTurns | agent 定义 `steps`（PositiveInt，旧名 maxSteps） | `packages/core/src/v1/config/agent.ts:34-37`；消费 prompt.ts:1178-1179（`agent.steps ?? Infinity`） | agent 级参数非 per-run；isLastStep 只注入 MAX_STEPS_PROMPT 软提醒（:1280-1282），非硬中断。per-run 达成须适配器生成临时 agent 定义（§8） |
| graceTurns | 无对应 | — | 丢弃（limiter 语义宿主自持） |
| skill | 无 run 级参数；skill 经 config/markdown 进 system（`sys.skills(agent)` prompt.ts:1257） | prompt.ts:1257-1268 | 不可达；预置进 agent 定义或丢弃 |
| skillPath | 同上 | — | 不可达 |
| description | 无直接字段 | — | 可写入 session metadata（CreateInput.metadata）仅诊断 |
| agent（.md 绝对路径） | `agent: <name>`（按名引用，非路径） | prompt.ts:1505；解析 agents.get(name) :635-649 | **名字→文件的绑定靠约定目录**：`{agent,agents}/**/*.md`（`packages/opencode/src/config/agent.ts:13-31`，cwd=opencode 配置目录）。适配器须先把 taiji agent .md 落盘到该目录再按名引用；内建 build/plan/general（`packages/opencode/src/agent/agent.ts:142-190`）可作缺省 |
| appendSystemPrompt | `system: string` → user.system，逐条追加进 system 数组 | prompt.ts:1512,668；消费 `packages/opencode/src/session/llm/request.ts:61-62` | string 单字段；数组由适配器 join |
| fork | `POST /session/{id}/fork {messageID?}`：复制历史到新 session 再 prompt | `.../groups/session.ts:240-252`；实现 `session.ts` fork（复制 msgs+parts 到新 sessionID） | fork=true（主 session 作源）与 forkSource（显式源）统一映射：源 sessionID 已知时 POST fork；`forkSource` 的「session 文件绝对路径」形态改为 sessionId 锚点（见 §6/§9） |
| forkSource | 同上（fork 的 messageID 可截断分叉点） | ForkInput：session.ts:272-275 | 互斥语义保留：显式源优先 |
| worktree | 无 run 级参数；引擎侧实验性 `POST /experimental/worktree`（创建 git worktree） | `packages/opencode/src/worktree/index.ts:207-240`；`.../groups/experimental.ts:97-98,176-197` | 隔离由**宿主**自建 worktree（WorktreeHandle）后经 ctx.cwd 生效；引擎 API 仅作可选实现细节 |
| idleTimeoutMs | 无对应（Runner onIdle 只置 idle 状态，无空闲杀） | `packages/opencode/src/session/run-state.ts:59-66` | 不可达；宿主侧 idle GC 自持 |
| denyTools | `tools: Record<string, boolean>` → 转换为 session permission rules（allow/deny） | prompt.ts:1061-1067（`{permission: t, action: enabled?"allow":"deny", pattern:"*"}`） | 字段标 deprecated 但链路有效；deny 语法 = 工具名通配 |
| permissionMode | 无 per-run 参数；permission 规则评估（allow/ask/deny，会话级 ruleset） | `packages/opencode/src/permission/index.ts:28-38,67-107` | native=默认规则（ask 时挂起等 reply）；fixed/ignored=适配器预置全 allow ruleset（CreateInput.permission 或 PATCH update） |

### ctx（RunContextParams）

| taiji 字段 | 源对应 | 证据 | 缺省/不可达备注 |
|---|---|---|---|
| cwd | instance 目录路由：`x-opencode-directory` header / `?directory=` query | `packages/sdk/js/src/client.ts:52-57`；middleware `.../middleware/instance-context.ts` | worktree 隔离 = cwd 指向 worktree 路径 |
| model | `model: {providerID, modelID}`；ref 字符串形态 `"providerID/modelID"` | prompt.ts:1503-1504；格式实证 `.../handlers/session.ts:246` | 缺省 = agent.model → session 当前模型（createUserMessage :651） |
| schemaEnv | 无对应 | — | 不可达（schema 主通道走 format） |
| ctxModel | 无对应 | — | 丢弃 |
| streamMode | 无参数（SSE 恒流式，delta 粒度固定） | §3 | 引擎按能力执行，参数无意义 |
| sessionRootId | 无对应（嵌套关系由 session.parentID 表达，fork 时建立） | `packages/core/src/session/sql.ts:31` | 丢弃 |
| sessionDir | 无对应（数据目录由 serve 进程启动环境决定，无法 per-run 指定） | — | 不可达；数据目录隔离靠多 serve 实例 |
| engineFallback | 无对应（单引擎无 fallback 概念） | — | 引擎不回填 |

### resume（RunResumeParams）

| taiji 字段 | 源对应 | 证据 | 缺省/不可达备注 |
|---|---|---|---|
| recordId | 无 wire 对应（适配器内部关联键自持） | — | 不上 HTTP |
| resume.sessionRef | `sessionId`（ses_ 前缀）：对已存在 session 直接再 POST prompt 即续聊 | §6 sessionRef 构成 | 无 resume 专用 API——续聊就是同 sessionID 再 prompt（消息追加、历史在库） |
| resume.journalPath | 无对应（无 journal 概念） | — | 缺省不携 |

## 3. 事件映射表

SSE 帧通用形状 `{id, type, properties}`。**双轨以 v1 族为锚**（§0 判定）。映射方式三值：直接（type 语义对应）/ 合成（适配器从 part/状态机推导）/ 丢弃。

### 3.1 v1 族全集 → taiji 9 事件（v1/session.ts:571-676 grep 穷尽 10 type）

| 源 type | 载荷要点 | taiji 事件 | 映射方式 | 证据 |
|---|---|---|---|---|
| `message.part.delta` | {sessionID, messageID, partID, field, delta}（field 恒 "text"） | `text_delta` / `thinking_delta` | 合成：按适配器维护的 partID→part.type 分流（text part→text_delta；reasoning part→thinking_delta） | v1/session.ts:632-641；发射 processor.ts:299-305,517-523 |
| `message.part.updated` | {sessionID, part, time}（Part 12 种） | `tool_start` / `tool_end` / compaction 判定 / text|thinking 全量校正 | 合成：tool part 状态机（§4）；text/reasoning part 用于 delta 校正与闭合 | v1/session.ts:612-620；发射 session.ts:637、processor.ts 全部 updatePart |
| `message.updated` | {sessionID, info: User\|Assistant} | `turn_end`（assistant 闭合时） | 合成：assistant message 出现 `time.completed` 且 `finish` 落定 → 一个 taiji turn 闭合；最后一个 turn 闭合即 `message_end` | v1/session.ts:596-603；发射 session.ts:631、processor.ts:470,610 |
| `message.removed` | {sessionID, messageID} | — | 丢弃（revert/delete 面适配不用） | v1/session.ts:604-611 |
| `message.part.removed` | {sessionID, messageID, partID} | — | 丢弃 | v1/session.ts:621-629 |
| `session.created` / `session.updated` / `session.deleted` | {sessionID, info: SessionInfo} | —（handleReady 数据源，§7） | 直接（不进事件流；session.created 用于 handle 回填） | v1/session.ts:572-595；发射 session.ts:535,622,746 |
| `session.diff` | {sessionID, diff: FileDiff[]} | — | 丢弃 | v1/session.ts:643-649 |
| `session.error` | {sessionID?, error: NamedError 8 变体} | `error` | 直接：error.message = 命名错误序列化（name+message）；Assistant error 同帧到达 | v1/session.ts:651-657,385-394；发射 processor.ts:625-638、prompt.ts:318 等 |

### 3.2 会话辅族（现行发布）

| 源 type | 载荷 | taiji 事件 | 映射方式 | 证据 |
|---|---|---|---|---|
| `session.status` | {sessionID, status: idle\|retry{attempt,message,action?,next}\|busy} | `activity`（busy/retry）+ `message_end` 判据（idle） | 直接：busy/retry→activity；idle→run 终态辅助判定 | session-status-event.ts:8-48；发射 status.ts:40-43 |
| `session.idle` | {sessionID}（deprecated） | —（与 status idle 重复） | 丢弃 | session-status-event.ts:42-46 |
| `session.compacted` | {sessionID} | `compaction` | 直接 | session-compaction-event.ts:5-9；发射 compaction.ts:554 |
| `todo.updated` | {sessionID, todos} | — | 丢弃 | session-todo.ts:17-21 |
| `permission.asked` / `permission.replied` | Request / {sessionID, requestID, reply} | 反向通道 askUser（§7） | 直接（不进 9 事件） | v1/permission.ts:61-66；发射 permission/index.ts:100,115 |
| `question.v2.asked` / `replied` / `rejected` | Request / {answers} / {sessionID, requestID} | 反向通道 askUser（§7） | 直接（不进 9 事件） | question.ts:78-88；发射 question/index.ts |
| `server.heartbeat` | {} | `activity` | 直接（10s 恒发，最简活性信号） | handlers/event.ts:63-66 |
| `server.connected` / `server.instance.disposed` | {} / {directory} | —（流生命周期） | 直接（连接建立/终止判定） | handlers/event.ts:61-70；`src/server/event.ts:6-10` |
| `file.edited`、`file.watcher.updated`、`pty.*`、`lsp.updated`、`mcp.*`、`installation.*`、`catalog.updated`、`models-dev.refreshed`、`integration.*`、`plugin.added`、`project.*`、`reference.updated`、`worktree.*`、`vcs.branch.updated`、`workspace.*`、`tui.*`、`global.disposed` | — | — | 丢弃（非 session 域） | EventManifest.Definitions 各族文件（grep `type: "` 穷尽 76 type） |

### 3.3 v2 细粒度族 `session.next.*`（32 variant grep 穷尽；已定义未接线，全部标「丢弃/预留」）

`packages/schema/src/session-event.ts`：DurableDefinitions 28（:448-477）+ live delta 4（Text.Delta/Reasoning.Delta/Tool.Input.Delta/Compaction.Delta）。全集：agent.switched、model.switched、moved、prompted、prompt.admitted、context.updated、synthetic、shell.started、shell.ended、step.started、step.ended、step.failed、text.started/delta/ended、reasoning.started/delta/ended、tool.input.started/delta/ended、tool.called、tool.progress、tool.success、tool.failed、retried、compaction.started/delta/ended、revert.staged/cleared/committed。**现行 serve 零发布**；若上游切到 core runner，text.delta/reasoning.delta 可直映 text_delta/thinking_delta，tool.called/success/failed 直映 tool_start/tool_end，compaction.started 直映 compaction——届时本表 v1 合成行可退役。

### 3.4 引擎内部 LLM 流事件（不跨进程，仅 part 生命周期的事实源）

`packages/llm/src/schema/events.ts`（Schema.tag grep 穷尽 16 种）：step-start、text-start/delta/end、reasoning-start/delta/end、tool-input-start/delta/end、tool-call、tool-result、tool-error、provider-error、step-finish、finish。消费点 = `packages/opencode/src/session/processor.ts:278-551`（switch 全覆盖）。这些不出现在 SSE；对 taiji 的可见效果只有 part 事件（§4）。

## 4. 内容块与 tool 调用映射

### 4.1 Part 类型全集（v1/session.ts:357-370 union，grep 穷尽 12 种）

| part type | 关键字段 | taiji 去向 | 证据 |
|---|---|---|---|
| text | text, synthetic?, ignored?, time{start,end?} | ReplayedTurn.text（拼接；synthetic/ignored 标记的入 context 不入正文展示，按 adapter 策略） | v1/session.ts:102-116 |
| reasoning | text, time | ReplayedTurn.thinking | v1/session.ts:118-128 |
| tool | callID, tool, state(4 态) | ReplayedTurn.toolCalls[]（§4.2） | v1/session.ts:315-325 |
| step-start | snapshot? | —（turn 边界噪声）丢弃 | v1/session.ts:233-238 |
| step-finish | reason, cost, tokens{total?,input,output,reasoning,cache{read,write}} | usageDelta 来源（§5） | v1/session.ts:240-257 |
| file | mime, filename?, url, source? | 无对应（多模态输入 part，subagent 链路不用；工具 attachments 出现在 tool state 内）丢弃 | v1/session.ts:171-179 |
| agent | name | —（@提及注入标记）丢弃 | v1/session.ts:181-193 |
| subtask | prompt, description, agent, model?, command? | —（内部子任务派发标记）丢弃 | v1/session.ts:204-218 |
| snapshot | snapshot | 丢弃 | v1/session.ts:87-92 |
| patch | hash, files | 丢弃（diff 面不进对话流） | v1/session.ts:94-100 |
| retry | attempt, error(APIError), time.created | `error` 可选来源（重试提示） | v1/session.ts:220-231 |
| compaction | auto, overflow?, tail_start_id? | `compaction`（与 session.compacted 事件并用的持久佐证） | v1/session.ts:195-202 |

### 4.2 tool part 状态机 → tool_start/tool_end 时序

ToolState 4 态（v1/session.ts:259-313）：`pending`（input:{}, raw:""）→ `running`（input 落定, title?, metadata?, time.start）→ `completed`（output, title, metadata, time{start,end}, attachments?）| `error`（error, metadata?, time{start,end}）。

实际发射时序（processor.ts）：tool-input-start 建 part（pending，:236-245）→ tool-call 转 running（:331-351）→ tool-result 转 completed（:160-184,383-413）或 tool-error 转 error（:186-205,416-419）；run 被 abort 时 running 未决的 tool 在 cleanup 强转 error（error:"Tool execution aborted"，metadata.interrupted，:591-607）。

taiji 映射（合成）：
- `tool_start{toolName: part.tool, args: state.input}` ← part.updated 出现 `state.status === "running"`（每 callID 恰一次）。
- `tool_end{toolName, args: state.input, result, isError}` ← `status === "completed"`（isError 省略/false）或 `"error"`（isError: true）。
- **ToolCallResult 装填**：`content: [state.output]`（completed.output 是字符串，装成单元素数组）；`details: state.metadata`（Record，含结构化进度/统计）；attachments（FilePart[]）不入 content（taiji 无对应位，丢弃）。

### 4.3 层级对齐

opencode 两层 message/part（user message → N 个 assistant message，各含 parts[]；一次 prompt 的 while 循环每轮新建一个 assistant message，prompt.ts:1088-1336）对齐 taiji 两层 run/turn：**run = 一次 POST prompt 至循环 break；turn = 一个 assistant message**（text parts 拼接 → text，reasoning parts 拼接 → thinking，tool parts → toolCalls）。step-start/step-finish 是 message 内 per-LLM-call 结算标记，不构成 taiji turn 边界。v2 存储形态 SessionMessage（8 种 type：agent-switched/model-switched/user/synthetic/system/shell/assistant/compaction，`packages/core/src/session/sql.ts:119-138` 的 session_message 表）属未接线新架构，read 链不经过。

## 5. usage 映射表

权威口径 = `Session.getUsage`（`packages/opencode/src/session/session.ts:338-383`）。LLM Usage 语义：inputTokens **含**缓存读写、outputTokens **含** reasoning（`packages/llm/src/schema/events.ts:7-56`）；getUsage 换算为不重叠分解。

| taiji 字段 | 源字段 | 证据 | 备注 |
|---|---|---|---|
| AgentUsage.input | tokens.input = nonCachedInputTokens = inputTokens − cacheRead − cacheWrite（clamp ≥0） | session.ts:354-360,367 | 已是净输入，与 taiji 语义直接对齐 |
| AgentUsage.output | tokens.output = outputTokens − reasoningTokens | session.ts:368 | 可见输出 |
| AgentUsage.cacheRead | tokens.cache.read = cacheReadInputTokens | session.ts:347,369-372 | |
| AgentUsage.cacheWrite | tokens.cache.write = cacheWriteInputTokens（provider metadata 兜底 anthropic/vertex/bedrock/venice） | session.ts:348-354,373 | |
| AgentUsage.cost | step-finish part.cost / assistant.cost（按 model.cost tiers 阶梯计价，无价模型 = 0） | processor.ts:452-469；v1/session.ts:245-256,471 | 无成本数据时缺省 |
| contextTokens | getUsage 内 `contextTokens = inputTokens`（原始含缓存），**不落盘** | session.ts:374 | 重建近似 = tokens.input + cache.read + cache.write；标 §9 gap |
| turns | assistant message 计数（适配器从 message.updated 自数） | §4.3 | 引擎无现成字段 |
| 数据载体 | per-turn 增量 = step-finish part（每 assistant message 汇总其 step）+ assistant.tokens（message 级）；session 级累计 = SessionInfo.cost/tokens（sqlite session 表列） | v1/session.ts:472-481,552-553；sql.ts:43-48 | message_end.usage ← 最后 assistant message 的 tokens/cost |

## 6. session 记录与 read 重建

**存储 = sqlite（opencode.db，drizzle）**，非 JSON：session/message/part/todo 表（`packages/core/src/session/sql.ts:22-138`：message/part 的 data 列存 V1MessageData/V1PartData JSON）+ 事件表 event/event_sequence（`packages/core/src/event/sql.ts`，durable 事件溯源）。`storage/storage.ts` 的 JSON 布局（`<data>/storage/session/<projectID>/*.json` 等）是遗留迁移层（storage.ts:64,122-169,196,225），现行读写全走 Database（session/session.ts:541-1001、message-v2.ts:30,98,434）。

**read 重建链**：`GET /session/{id}/message` → `SessionV1.WithParts[]`（{info: User|Assistant, parts: Part[]}，v1/session.ts:493-500）；分页 `limit`+`before` 游标（Link/X-Next-Cursor header，handlers/session.ts:106-145）；有效历史经 compacted 过滤（MessageV2.filterCompacted，prompt.ts:1092 同源）。SessionView 构成：

- `turns[]`：按 assistant message 分组（§4.3）；组内 text/reasoning/tool part 按序归位；`closed: true` 恒置（重放物无进行时）。
- `usage`：各 turn 的 assistant.tokens（或其 step-finish parts）聚合为 AgentUsageTotal（total = 四项和；cost 累加）。
- `source`：native（sqlite + GET messages 可达）。

**ResumeAnchor.sessionRef 构成建议**：`{ sessionId: "<ses_...>", directory: "<创建时 instance 目录>" }`——sessionId 定 session 行，directory 定 serve 实例（session.directory 列 + per-directory 路由，sql.ts:33；跨目录访问必须带 `?directory=`，否则路由不到实例）。journalPath 缺省（无 journal）。

**session 与目录绑定语义**：session 创建即绑定 project/directory/path（CreateInput + ctx）；目录是实例路由键也是 worktree 锚。taiji ctx.sessionDir（宿主权威目录）不可达——数据目录归属 serve 进程（§9）。

## 7. 反向通道映射（HTTP/SSE 形态下全部重解释）

| taiji 通道 | 源对应物 | 合成方式 | 证据 |
|---|---|---|---|
| host/log | 无事件对应（Effect.log 走 server stdout/stderr） | 适配器捕获子进程 stdout/stderr 转译 level/component；非必须 | `packages/opencode/src/cli/cmd/serve.ts:17-19` |
| host/askUser | **permission.asked** + **question.v2.asked** 两路（SSE） | 见下表 UiRequest 对齐 | permission/index.ts:100；question/index.ts |
| host/streamDelta | 无独立通道（SSE delta 即渲染流） | 不需要；如宿主要双通道，从 message.part.delta 转发即可 | §3.1 |
| host/handleReady | `POST /session` 同步应答（SessionInfo 含 id） | 创建即得 sessionId → 立即回填 sessionRef={sessionId, directory}（等价 handleReady 语义） | groups/session.ts:203-214；handlers/session.ts:155-176 |
| host/childSpawned | 无对应（opencode 无子进程任务模型；BackgroundJob 无 pid 上报 API） | 不发（宿主 isResumable 镜像退化由 dispose/abort 驱动） | run-state.ts:111-143（仅 cancel 面） |
| host/childStateChanged | 无对应；abort/进程退出时由适配器合成 `exited`（killed=true） | 合成 | handlers/session.ts:232-235 |

**permission.asked → UiRequest 对齐**（Request：{id, sessionID, permission, patterns, metadata, always[], tool?{messageID,callID}}，v1/permission.ts:27-35）：

- `method: "confirm"`：title=permission 名，message=patterns.join，channelPayload={patterns, always, tool}；应答 `POST /permission/{requestID}/reply {reply: "once"|"always"|"reject", message?}` → UiResponse `{confirmed: true}`（once/always）/`{cancelled: true}`（reject）。reject 会级联拒绝同 session 其余 pending（permission/index.ts:121-140）。
- **permission 值域**：字段为自由 string（规则通配匹配），实际发射来源 = 工具名（edit 组归一 "edit"，bash 等原名）+ `doom_loop`（processor.ts:373）+ `question`/`plan_enter`/`plan_exit`/`task`/`external_directory`（agent.ts 内建规则）；无封闭枚举，适配器按 confirm 透传。
- evaluation 语义：ruleset 逐 pattern last-match（allow 跳过 / deny 直接拒（不产生 UI 请求）/ ask 挂起 Deferred 直到 reply，LLM 流阻塞中）（permission/index.ts:67-107）。

**question.v2.asked → UiRequest 对齐**（Request：{id, sessionID, questions: Info[{question, header, options[{label,description}], multiple?, custom?}], tool?}，question.ts:25-60）：

- `method: "select"`：title=header，message=question，options=labels；应答 `POST /question/{requestID}/reply {answers: string[][]}` → `{value: <label>}`；`POST /question/{requestID}/reject` → `{cancelled: true}`（工具侧收 Question.RejectedError，processor.ts:200）。

**UiRequest 9 method 对齐度**：select←question.v2；confirm←permission.asked；**input/editor/notify/setStatus/setWidget/setTitle/set_editor_text 无对应**——opencode 无文本输入/展示写入类交互面，一律 `{unsupported:true}` 或适配器本地降级（记日志丢弃）。

## 8. 能力位 11 位表

| 位 | 值 | 依据 |
|---|---|---|
| schemaEnforcement | `emulated` | StructuredOutput 工具注入 + toolChoice:"required" + system 提示（prompt.ts:1243-1250,1271,1285,1565-1598）；未调用 → StructuredOutputError（schema_deterministic 分诊可用） |
| steer | `emulated` | busy 期间 POST prompt **不拒绝**：Runner.ensureRunning 排队（`packages/opencode/src/effect/runner.ts:109-116` 等待当前 run done），新 user message 已先行落库，活跃 run 下一轮迭代读到并继续处理（prompt.ts:1092,1096-1098）——语义 = 消息并入当前 run 的后续 turn，非即时注入；空闲时起新 run。BusyError 仅 shell/revert/deleteMessage 路径（run-state.ts:71-75,96-105,145-147） |
| conversation | `native` | serve 常驻 + session 持久 sqlite；续聊 = 同 sessionID 再 POST prompt，无冷恢复成本（§2 resume 行） |
| personaInjection | `file` | agent 按名引用约定目录 .md（config/agent.ts:13-31）；适配器负责把 taiji agent .md 落盘到该目录 |
| eventGranularity | `stream` | SSE message.part.delta 流式（§3.1） |
| sandbox | `emulated` | 引擎无 OS sandbox；隔离 = 宿主 worktree（WorktreeHandle）+ ctx.cwd/directory 路由；引擎侧 /experimental/worktree 仅可选辅助（§2） |
| sessionRead | `full` | GET /session/{id}/message 全量 WithParts（delta 全量校正事件齐备，§6） |
| resume | `native` | sessionId 锚点直接续聊（§2/§6）；无需 journal |
| interrupt | `native` | POST /session/{id}/abort → runner.cancel → Effect interrupt；未决 tool 强转 error+interrupted（handlers/session.ts:232-235；processor.ts:591-607） |
| permissionMode | `native` | ruleset allow/ask/deny 评估 + asked/replied 双向（permission/index.ts:28-167）；fixed/ignored 由适配器预置 ruleset 模拟 |
| maxTurns | `true` | 机制存在但为 agent 级 steps（prompt.ts:1178）；per-run 达成须适配器为每次 run 生成临时 agent 定义（.md steps=N）——有并发命名/清理成本，若放弃则声明 false 并宿主自管 limiter |

## 9. gap 清单

**源有靶无**（opencode 有、taiji 协议面无承载，适配器丢弃）：
- session 树操作：children、fork 树（parentID）、revert/unrevert、消息/part 删除与改写 API（groups/session.ts:144-155,369-394,409-444）。
- 多模态与富 part：file part 输入、subtask part（内部子任务派发）、patch/snapshot parts、session.diff、todo.updated（§3.2/§4.1）。
- 入口变体：`POST /session/{id}/command`（斜杠命令模板）、`/shell`（直跑 shell）、`/init`、`/summarize`（手动压缩）、`prompt_async` 之外的 share/init 面（groups/session.ts:343-315）。
- provider OAuth（/provider/auth/authorize|callback）、LSP/MCP/PTY 事件族、/experimental/worktree 创建 API（§2）。

**靶有源无**（taiji 要、opencode 无，不可达项）：`scene`、`ctxModel`、`schemaEnv`、`sessionRootId`、`sessionDir`（per-run 数据目录）、`idleTimeoutMs`（引擎侧无空闲回收）、`graceTurns`、`thinkingLevel` 独立词表（仅 variant 部分承载）、`host/log` 事件化、`childSpawned/childStateChanged`、UiRequest 的 input/editor/notify/setStatus/setWidget/setTitle/set_editor_text、`forkSource` 的「session 文件路径」形态（改 sessionId+fork 实现）。

**语义错配**（可达但需适配裁决）：
1. **层级**：run→turn 对 message→part 两层（§4.3）；turn_end 与 message_end 都源自 message.updated，末端 turn 判定需「无后续 tool-calls + finish ∉ {tool-calls,unknown}」（prompt.ts:1111-1130 同判据）或 session.status=idle 兜底。
2. **delta field 单值**：message.part.delta 的 field 恒 "text"，text/reasoning 共用，分流靠 partID→part.type 映射（part.updated 先行建立；part 顺序内乱序到达需容忍）。
3. **tool 无专用事件**：tool_start/tool_end 从 part.updated 状态机合成，running 期间 metadata 更新会重复发 part.updated（幂等消费）。
4. **contextTokens 不落盘**：getUsage 有但不持久化，重建 = input+cacheRead+cacheWrite 近似（§5）。
5. **busy=排队非拒绝**：steer 走 emulated 消息合并（§8），与「busy 抛错」的直觉相反；适配器不能把重复 prompt 当错误。
6. **permission 挂起阻塞 run**：ask 的 Deferred 挂起在 LLM 流内，同步 POST 会吊死连接——run 必须 prompt_async + SSE；宿主不 reply = run 永挂（须映射宿主超时/杀链到 POST reply reject 或 abort）。
7. **agent 按名不按路径**：taiji agent(.md 绝对路径) 需落盘改名注入约定目录，存在名字冲突与清理义务；skill 同理不可 per-run 注入。
8. **session 目录绑定**：session 归属创建时 directory/project，跨目录续聊必须带 directory 路由参数；taiji「sessionDir 宿主权威」模型不成立，数据目录归 serve 进程（多实例隔离替代）。
9. **cost 可能为 0**：无价模型（tiers 缺失）cost=0，AgentUsage.cost 缺省语义要保真。
