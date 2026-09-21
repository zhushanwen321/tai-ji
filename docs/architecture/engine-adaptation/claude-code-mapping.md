# Claude Code → taiji subagent 引擎协议 v1 映射

证据基准：v2.1.88 npm 产物反解快照（claude-code-source-code 知识库）；官方 mirror（GitHub anthropics/claude-code）无源码，只有 CHANGELOG/docs。下文所有 `file:line` 均指该反解快照仓库内路径；上游运行时语义的权威源为 node_modules 实装版。

taiji 靶面类型权威：`packages/subagent-engine-sdk/src/protocol/`（contract-types.ts / methods.ts / reverse-channels.ts / frames.ts / schema.ts）与 `src/ui-types.ts`。

## 1. 接入形态与进程拓扑

claude code 以单进程 CLI 形态被引擎适配器 spawn，双向 stdio NDJSON 承载完整控制协议：stdout 输出 stream-json 消息流（每行一个 JSON），stdin 接收 user 消息与 control_request 控制帧，两条方向均为「消息 + 控制请求」复用同一流（`StructuredIO` 类，src/cli/structuredIO.ts:135；stdin 合集 `StdinMessageSchema`，src/entrypoints/sdk/controlSchemas.ts:655-663）。适配器把该进程整体映射为协议的一个引擎端点：协议 9 正向方法中的 run → 一次 spawn 会话的生命周期，stdout stream-json → event 通知，stdin control_request 应答（control_response）→ 反向通道应答回传。spawn 命令形态：

```
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  [--include-partial-messages] \
  [--output-schema 见 §2 schema 行] \
  [--model <model>] [--max-turns <n>] [--permission-mode <mode>] \
  [--append-system-prompt <text>] [--agent <name> | --agents <json>] \
  [--allowedTools ...] [--disallowedTools ...] \
  [--resume <sessionId> [--fork-session]] \
  [--session-id <uuid>]
```

硬约束：`--output-format=stream-json` 必须搭配 `--verbose`，否则报错退出（src/cli/print.ts:787-789）。`-p/--print` 跳过工作区信任对话框（src/main.tsx:976）。stderr 不承载协议（引擎协议对 stderr 的排空策略与 claude code 侧无冲突）。

## 2. run 参数映射表

协议 run 帧 = `{ runId, task: AgentCallOpts, ctx: RunContextParams, resume?: RunResumeParams }`（src/protocol/methods.ts:141-151）。

| taiji 字段 | 源对应 | 证据 | 缺省/不可达备注 |
|---|---|---|---|
| task.prompt | 位置参数 prompt（或首条 stdin user 消息） | src/main.tsx:968（`.argument('[prompt]')`） | stream-json 输入下推荐走 stdin 首条 user 帧，避免 ARG_MAX |
| task.schema | `--json-schema <schema>` | src/main.tsx:976；输出回填 `result.structured_output`（src/entrypoints/sdk/coreSchemas.ts:1421；合成工具名 `StructuredOutput`，src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:20） | native 通道；另有 stdin initialize 控制请求的 `jsonSchema` 字段（src/entrypoints/sdk/controlSchemas.ts:65） |
| task.thinkingLevel | `--thinking <enabled\|adaptive\|disabled>`（hideHelp）；`--effort <low\|medium\|high\|max>` | src/main.tsx:976 / src/main.tsx:993 | 词表错配：taiji 是 high/medium/low，claude 侧分 thinking 开关与 effort 档位两轴，适配层需做映射 |
| task.scene | 无对应 | — | 宿主侧模型选择提示，不上引擎 |
| task.maxTurns | `--max-turns <turns>`（hideHelp，仅 print 模式） | src/main.tsx:976；消费 src/query.ts:1705 | 超限产生 `result{subtype:"error_max_turns"}`（src/QueryEngine.ts:851-873） |
| task.graceTurns | 无对应 | — | 适配层忽略（claude 超限即终态，无宽限语义） |
| task.skill / task.skillPath | 无一等 flag；skills 经 `--disable-slash-commands` 反向控制，加载靠 prompt 内引用 | src/main.tsx:1006 | 建议：适配层将 skill 注入 appendSystemPrompt 或 prompt 前缀（emulated） |
| task.description | 无直接 flag；`--agents <json>` 的 agent 定义含 description 字段 | src/main.tsx:1000 | 诊断字段，可不上 wire |
| task.agent（.md 绝对路径） | `--agent <agent>`（按 agentType 名引用）；`--agents <json>`（内联定义）；stdin initialize 的 `agents` 记录 | src/main.tsx:1000 / src/main.tsx:1000 / src/entrypoints/sdk/controlSchemas.ts:68 | 文件系统定义的 agent 由 CLI 自行发现（src/cli/print.ts:4389-4391 注释「filesystem-defined」）；路径注入需保证在 CLI 的 agent 扫描目录内 |
| task.appendSystemPrompt | `--append-system-prompt <prompt>`（单条 string）；stdin initialize 的 `appendSystemPrompt`（规避 ARG_MAX） | src/main.tsx:988 / src/entrypoints/sdk/controlSchemas.ts:67 / 消费 src/cli/print.ts:4369-4375 | taiji 是 string[]，适配层 join 后传入 |
| task.fork | `--fork-session`（与 --resume/--continue 搭配，fork 出新 session id） | src/main.tsx:989 / src/main.tsx:1281-1279 | 无 resume 源时 fork 不可达 |
| task.forkSource | `--resume <sessionId>`（resume 指定源 session 即隐含 fork 语义） | src/main.tsx:989 | 与 task.fork 互斥语义在源侧合流于 --resume + --fork-session |
| task.worktree | 无引擎内建对应；AgentTool 子代理有 worktree 隔离（agent transcript 元数据记 worktreePath） | src/utils/sessionStorage.ts:264-268 | 宿主/适配层自建 worktree 后把 ctx.cwd 指向 worktree 目录（emulated） |
| task.idleTimeoutMs | 无对应（claude 无 idle 回收概念） | — | 适配层自行实现（进程级） |
| task.denyTools | `--disallowedTools <tools...>`（另有 `--allowedTools`、`--tools`） | src/main.tsx:988 | 语法直通（工具名列表） |
| task.permissionMode | `--permission-mode <mode>`；运行时切换走 control_request `set_permission_mode` | src/main.tsx:988 / src/entrypoints/sdk/controlSchemas.ts:124-135 | 词表：default/acceptEdits/bypassPermissions/plan/dontAsk（src/entrypoints/sdk/coreSchemas.ts:337-348；运行集 src/types/permissions.ts:16-38） |
| ctx.cwd | 进程 spawn cwd（CLI 继承）；`--add-dir` 扩展可访问目录 | src/main.tsx:1000 | 引擎协议约定缺省回退进程 cwd |
| ctx.model | `--model <model>`（别名或全名） | src/main.tsx:993 | 运行时切换走 `set_model` 控制请求（src/entrypoints/sdk/controlSchemas.ts:137-144） |
| ctx.schemaEnv | 无对应（claude 走 flag/控制通道，无 env 注入 schema 概念） | — | schemaEnforcement=native 后此降级通道不可达 |
| ctx.ctxModel | 无对应 | — | 不可达 |
| ctx.streamMode | `--include-partial-messages`（开 stream_event 转发）；不开则只有整块 assistant 消息 | src/main.tsx:976 / 消费 src/QueryEngine.ts:818-826 | stream 档需带该 flag；coarse 档 = 不带 |
| ctx.sessionRootId | 无直接对应（session 关联由 `--session-id <uuid>` 承担） | src/main.tsx:1000 | 适配层可令 sessionId = 派生值 |
| ctx.sessionDir | 无对应（claude 自管 `~/.claude/projects/<projectDir>/<sessionId>.jsonl` 布局） | src/utils/sessionStorage.ts:198-205 | transcript 路径引擎侧自推导，不接宿主 sessionDir |
| resume.recordId | stdin 控制流关联键（适配层自维护；claude 无 record 概念） | — | 合成 |
| resume.resume.sessionRef | `--resume <sessionId>`（+ 可选 `--fork-session`、`--resume-session-at <message id>`） | src/main.tsx:989 / src/main.tsx:991 | sessionRef 建议构成见 §6 |

## 3. 事件映射表

源侧 stdout stream-json 消息 type 全集（grep 穷尽自 `SDKMessageSchema` 24 分支 src/entrypoints/sdk/coreSchemas.ts:1854-1881 + streamlined 2 分支 + 控制帧，src/entrypoints/sdk/controlSchemas.ts:642-663）：`assistant` / `user`（含 `isReplay` 变体）/ `result` / `system` / `stream_event` / `tool_progress` / `auth_status` / `tool_use_summary` / `rate_limit_event` / `prompt_suggestion` / `streamlined_text` / `streamlined_tool_use_summary` / `post_turn_summary` / 控制帧 `control_response` / `control_request` / `control_cancel_request` / `keep_alive`；`system` 的 subtype 全集（16）：`init` / `compact_boundary` / `status` / `post_turn_summary` / `api_retry` / `local_command_output` / `hook_started` / `hook_progress` / `hook_response` / `files_persisted` / `task_notification` / `task_started` / `task_progress` / `session_state_changed` / `elicitation_complete`；`result` 的 subtype 全集（5）：`success` / `error_during_execution` / `error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries`（src/entrypoints/sdk/coreSchemas.ts:1407-1455）。

stream_event 内层 `event.type` 全集（Anthropic 流协议，src/services/api/claude.ts:1979-2300）：`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`；content_block type 全集（src/services/api/claude.ts:1995-2049）：`text` / `thinking` / `tool_use` / `server_tool_use` + default 透传（`redacted_thinking`、`web_search_tool_result`、`advisor_tool_result` 等）；delta type 全集（src/services/api/claude.ts:2083-2162）：`text_delta` / `input_json_delta` / `thinking_delta` / `signature_delta` / `citations_delta` / `connector_text_delta`。

### 3.1 stdout 消息 → taiji 9 事件

| 源类型 | taiji 事件 | 映射方式 | 证据 |
|---|---|---|---|
| assistant（message.content[].type=text/thinking/tool_use 整块到达） | text_delta / thinking_delta / tool_start + tool_end | 合成：适配层按 content block 拆解，text block → text_delta（整块单发）、thinking block → thinking_delta、tool_use block → tool_start（args=input 对象）；result 帧后对未闭合 tool 补 tool_end | src/entrypoints/sdk/coreSchemas.ts:1347-1356；content block 组装 src/services/api/claude.ts:2192-2210 |
| stream_event > content_block_delta > text_delta | text_delta | 直接（`--include-partial-messages` 开启时） | src/services/api/claude.ts:2113-2126 |
| stream_event > content_block_delta > thinking_delta | thinking_delta | 直接 | src/services/api/claude.ts:2148-2161 |
| stream_event > content_block_delta > signature_delta / citations_delta / connector_text_delta | （无） | 丢弃（签名/引用/连接文本非 taiji 事件面） | src/services/api/claude.ts:2084-2086, 2127-2147 |
| stream_event > content_block_start(tool_use) | tool_start | 直接（toolName=name, args 待 input_json_delta 累积） | src/services/api/claude.ts:1997-2001 |
| stream_event > content_block_delta > input_json_delta | （tool_start args 累积） | 合成：partial_json 串接，content_block_stop 时 JSON.parse 得 args | src/services/api/claude.ts:2087-2112 |
| stream_event > content_block_stop | （tool args 定稿触发点） | 合成 | src/services/api/claude.ts:2171-2211 |
| user（content[].type=tool_result） | tool_end | 直接映射：toolName 由 tool_use_id 反查 tool_use block 得 name，result.content=tool_result.content 数组，isError=tool_result.is_error | src/entrypoints/sdk/coreSchemas.ts:1273-1288（user 帧）；结构 src/utils/messages.ts:838-850 |
| result subtype=success | message_end + turn_end | 合成：usage/error 从 result 帧（§5）；result 文本经 turn_end.summary 可选携带 | src/QueryEngine.ts:1139-1160, 618-637 |
| result subtype=error_during_execution | message_end{error} + error + turn_end | 合成：errors[] 首条进 message_end.error | src/QueryEngine.ts:1082-1101 |
| result subtype=error_max_turns | message_end{error} + error + turn_end | 合成（同上） | src/QueryEngine.ts:851-873 |
| result subtype=error_max_budget_usd / error_max_structured_output_retries | message_end{error} + error + turn_end | 合成（同上） | src/QueryEngine.ts:981-1001, 1024-1049 |
| system subtype=init | （会话元数据采集，不产事件） | 消费：取 session_id/model/tools/cwd 填 handle；不外发 | src/utils/messages/systemInit.ts:53-104；yield 点 src/QueryEngine.ts:540 |
| system subtype=compact_boundary | compaction | 直接 | src/QueryEngine.ts:597-605, 935-941；schema src/entrypoints/sdk/coreSchemas.ts:1506-1531 |
| system subtype=status（status="compacting"） | compaction | 合成：压缩进行中的前置信号，可映射 compaction 或丢弃 | src/entrypoints/sdk/coreSchemas.ts:1268-1270, 1533-1542 |
| system subtype=api_retry | activity | 合成：重试等待期活性信号（携带 attempt/max_retries 细节丢弃） | src/QueryEngine.ts:943-955 |
| system subtype=session_state_changed | activity | 合成：idle/running/requires_action 状态翻转作活性信号 | src/entrypoints/sdk/coreSchemas.ts:1735-1747 |
| system subtype=task_progress | activity | 合成：后台任务进度节流帧（含 total_tokens/tool_uses/duration_ms，丢弃） | src/entrypoints/sdk/coreSchemas.ts:1750-1767 |
| system subtype=task_started / task_notification | tool_start / tool_end（Task 型工具）或 activity | 合成：后台任务生命周期可投影为对应 tool 事件 | src/entrypoints/sdk/coreSchemas.ts:1694-1733 |
| system subtype=post_turn_summary | turn_end{summary} | 合成：summary 字段入 turn_end.summary（可选增强） | src/entrypoints/sdk/coreSchemas.ts:1544-1570 |
| system subtype=hook_started / hook_progress / hook_response / files_persisted / elicitation_complete | （无） | 丢弃（hook 生命周期/文件持久化回执非事件面） | src/entrypoints/sdk/coreSchemas.ts:1604-1692, 1779-1792 |
| system subtype=local_command_output | text_delta | 合成（content 作正文增量；headless 下少见） | src/entrypoints/sdk/coreSchemas.ts:1590-1602 |
| tool_progress（type=tool_progress） | activity | 直接语义：工具执行中周期心跳（30s 节流，src/utils/queryHelpers.ts:96-100） | src/entrypoints/sdk/coreSchemas.ts:1648-1659 |
| tool_use_summary | activity | 合成（累计工具摘要字符串丢弃） | src/entrypoints/sdk/coreSchemas.ts:1769-1777 |
| auth_status | activity 或 error | 合成：认证中断时 error{message=output}，其余丢弃 | src/entrypoints/sdk/coreSchemas.ts:1661-1670 |
| rate_limit_event / prompt_suggestion / streamlined_text / streamlined_tool_use_summary | （无） | 丢弃（订阅限流状态/提示建议/精简输出模式专属） | src/entrypoints/sdk/coreSchemas.ts:1358-1397, 1795-1806 |
| control_response / control_cancel_request / keep_alive | （无） | 消费：反向通道应答与保活帧，非事件面 | src/entrypoints/sdk/controlSchemas.ts:605-627 |

taiji `activity`（纯活性信号）在 claude 侧无单一原生对应，由 tool_progress / api_retry / session_state_changed / task_progress 四源合成（上表）；长工具执行期 tool_progress 是最稳的判活源。

## 4. 内容块与 tool 调用映射

- **text / thinking block**：assistant 消息的 `message.content[]` 内 `{type:"text", text}` 与 `{type:"thinking", thinking, signature}`（signature 丢弃）。流式路径：`--include-partial-messages` 下 text_delta/thinking_delta 逐段转发；非流式路径：content_block_stop 时整块 yield 为独立 assistant 消息（每 block 一条，src/services/api/claude.ts:2192-2210 注释「claude.ts yields one assistant message per content block」），适配层整块合成对应 delta。
- **tool_use block**：`{type:"tool_use", id, name, input}`。流式下 input 由 input_json_delta 的 partial_json 串接（起始为空串，src/services/api/claude.ts:1997-2001），content_block_stop 时为完整对象 → tool_start{toolName:name, args:input}。
- **tool_result**：到达于 user 消息 `message.content[]` 内 `{type:"tool_result", tool_use_id, content, is_error?}`（src/utils/messages.ts:838-850 的 `ToolUseResultMessage` 判定：content[0].type==='tool_result'）。映射 tool_end{toolName（按 tool_use_id 反查在途 tool_use）, result:{content: Array 视 content 形态装填, details}, isError: is_error}：
  - `ToolCallResult.content: unknown[]` ← tool_result.content。该字段是 Anthropic block 数组（text/image 块）或字符串；适配层归一为数组（字符串包一元素）。结构化旁路：同条 user 消息顶层 `toolUseResult` 字段携带工具完整结构化 Output（注释「Matches tool's `Output` type」，src/utils/messages.ts:481），取其文本/数据面并入 content，整体对象入 `details`。
- **redacted_thinking / server_tool_use / web_search_tool_result**：default 分支透传块（src/services/api/claude.ts:2039-2049）；redacted_thinking 无 delta，不产事件；server_tool_use（内建服务端工具）同 tool_use 处理（advisor 特判在 src/services/api/claude.ts:2008）。
- **isError 的另一个来源**：SDKAssistantMessageError 枚举（authentication_failed/billing_error/rate_limit/invalid_request/server_error/unknown/max_output_tokens，src/entrypoints/sdk/coreSchemas.ts:1256-1266）出现在 assistant 帧顶层 `error` 字段 → 映射 error 事件。

## 5. usage 映射表

result 帧携带累计 usage（`NonNullableUsage`，零值形态见 src/services/api/emptyUsage.ts:6-20）：

| taiji 字段 | 源字段 | 证据 |
|---|---|---|
| AgentUsage.input | `usage.input_tokens` | src/QueryEngine.ts:629（result 帧 usage）；字段集 src/services/api/emptyUsage.ts:8-11 |
| AgentUsage.output | `usage.output_tokens` | 同上 |
| AgentUsage.cacheRead | `usage.cache_read_input_tokens` | 同上 |
| AgentUsage.cacheWrite | `usage.cache_creation_input_tokens` | 同上 |
| AgentUsage.cost | 无单消息成本；成本仅累计级 `total_cost_usd` | src/QueryEngine.ts:628（getTotalCost()） |
| AgentOutcomeUsage.cost | `total_cost_usd` | src/QueryEngine.ts:628, 860, 990 |
| AgentOutcomeUsage.contextTokens | `modelUsage.<model>.contextWindow`（上限语义）或控制请求 `get_context_usage` 应答 `totalTokens`（当前占用语义） | ModelUsage schema src/entrypoints/sdk/coreSchemas.ts:17-28；控制请求 src/entrypoints/sdk/controlSchemas.ts:175-306 |
| AgentOutcomeUsage.turns | `num_turns` | src/QueryEngine.ts:624（`messages.length - 1`）、857、987（turnCount 按 user 消息计数） |
| AgentOutcome.durationMs | `duration_ms`（另有 API 侧 `duration_api_ms`） | src/QueryEngine.ts:622-623 |

message_end 的单消息增量：流式路径下 `stream_event > message_start/message_delta` 的 usage 经 updateUsage 累积、message_stop 时并入 totalUsage（src/QueryEngine.ts:789-816）；assistant 消息块级 usage 在 `message.message.usage`。分模型明细在 `modelUsage`（record：inputTokens/outputTokens/cacheReadInputTokens/cacheCreationInputTokens/webSearchRequests/costUSD/contextWindow/maxOutputTokens），taiji 靶面无分模型维度，聚合或丢弃。

## 6. session 记录与 read 重建

transcript 为 per-session JSONL：`~/.claude/projects/<projectDir>/<sessionId>.jsonl`（路径推导 src/utils/sessionStorage.ts:198-225；子代理侧链在 `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`，src/utils/sessionStorage.ts:247-258）。写入为追加式（assistant fire-and-forget、其余 await 的排队写，src/QueryEngine.ts:717-732）。

Entry type 全集（grep 穷尽自 `Entry` union，src/types/logs.ts:297-317，19 种）：`TranscriptMessage`（user/assistant/attachment/system 四类判定，src/utils/sessionStorage.ts:139-146）/ `summary` / `custom-title` / `ai-title` / `last-prompt` / `task-summary` / `tag` / `agent-name` / `agent-color` / `agent-setting` / `pr-link` / `file-history-snapshot` / `attribution-snapshot` / QueueOperationMessage / `speculation-accept` / `mode` / `worktree-state` / `content-replacement` / `marble-origami-commit` / `marble-origami-snapshot`。

| Entry | → ReplayedTurn | 证据 |
|---|---|---|
| TranscriptMessage(user)，content 无 tool_result | 新 turn 的起点标记（用户输入不进 turn 正文） | src/types/logs.ts:221-231 |
| TranscriptMessage(assistant) | 按内容块拆入当前 turn：text→text、thinking→thinking、tool_use→toolCalls[{toolName,args}]（args=input 对象） | 同上；内容块形态同 §4 |
| TranscriptMessage(user) 含 tool_result | 回填最近未闭合 toolCall 的 result/isError（按 tool_use_id 配对） | src/utils/messages.ts:838-850 |
| TranscriptMessage(system, compact_boundary) | 压缩边界：之前 turns 归档、之后开新段（read 重建时保留边界标记或分段） | src/QueryEngine.ts:597-605 |
| TranscriptMessage(attachment) | 丢弃（附件元数据） | src/utils/sessionStorage.ts:139-146 |
| 其余 14 种元数据 Entry | 丢弃（标题/标签/快照/工作树状态等，非对话内容） | src/types/logs.ts:55-295 |

**parentUuid 链重建语义**：每条 TranscriptMessage 带 `parentUuid`（指向前一条链内消息的 uuid；链首为 null）与可选 `logicalParentUuid`（session 断链时保留逻辑父，src/types/logs.ts:221-231）。写入侧 progress 类型不入链（`isChainParticipant = type !== 'progress'`，src/utils/sessionStorage.ts:148-156）。重建 = 按文件序读入 isTranscriptMessage 四类，沿 parentUuid 从叶子回溯出线性主链（叉链 = 子代理 sidechain，`isSidechain:true` + `agentId` 字段隔离，主链重建只取 isSidechain:false）。turn 边界判定：一条 assistant 消息序列（同一次响应的连续 block）+ 其后跟随的 tool_result user 消息构成一个 ReplayedTurn，text/thinking 串接、toolCalls 按序排列，closed 恒 true。

**ResumeAnchor.sessionRef 构成建议**：`{ sessionId: <system init 帧的 session_id 或 result 帧 session_id>, transcriptPath: <getTranscriptPathForSession 推导的 JSONL 绝对路径> }`。resume 即 spawn 时带 `--resume <sessionId>`（src/main.tsx:989；UUID 校验 src/main.tsx:1281-1295）；断点续接可加 `--resume-session-at <message id>`（src/main.tsx:991）。SessionView.source 评级：transcript 可读且链完整 = native（评 full）；读不到文件只剩 outcome = outcome-only。

## 7. 反向通道映射

claude 侧反向协议 = stdout `control_request`（CLI → SDK host，src/entrypoints/sdk/controlSchemas.ts:578-584）+ stdin `control_response` 应答（src/entrypoints/sdk/controlSchemas.ts:605-610）。21 个请求 subtype 全集见 §3 开头。taiji 6 通道逐条：

| taiji 通道 | 源对应物 | 映射方式 |
|---|---|---|
| host/log{level,component,message,data?} | 无原生通道；debug 日志走 stderr（`-d/--debug`、`--debug-to-stderr`，src/main.tsx:971-976） | 合成：适配层消费 stderr 诊断行转 host/log，或适配层自身日志 |
| host/askUser{runId,request:UiRequest} | control_request `can_use_tool`（权限询问，src/cli/structuredIO.ts:586-606）+ `elicitation`（MCP 表单询问，src/cli/structuredIO.ts:694-721）+ `hook_callback`（hook 输入，src/cli/structuredIO.ts:661-689） | 直接映射（详见下表）；应答 control_response 回 `PermissionToolOutput` 形态（allow{behavior:"allow",updatedInput} / deny{behavior:"deny",message,interrupt?}，src/utils/permissions/PermissionPromptToolResultSchema.ts:47-86） |
| host/streamDelta{runId,delta} | 无对应（claude 流式增量在 stdout 事件面，无宿主回推 UI 通道） | 适配层可将 text_delta 同时泵该通道（渲染加速面，纯合成） |
| host/handleReady{runId,sessionRef} | system/init 帧（首帧含 session_id，src/utils/messages/systemInit.ts:53-104） | 合成：收到 init 帧即回填 handle 并发 handleReady |
| host/childSpawned{pid,recordId} | initialize 应答的 `pid` 字段（CLI 进程自身 PID，src/entrypoints/sdk/controlSchemas.ts:86-89） | 合成：适配层 spawn 后即知 pid，主动上报一次（claude 无内嵌孙进程上报） |
| host/childStateChanged{pid,recordId,state,killed,exitCode?,signal?} | 无对应（进程退出由适配层 wait 链感知） | 合成：进程 exit 事件驱动 |

**can_use_tool → UiRequest 对齐度**（UiRequest 9 method，src/ui-types.ts:19-29；请求结构 src/entrypoints/sdk/controlSchemas.ts:106-122）：

| UiRequest method | 可映射 | 说明 |
|---|---|---|
| confirm | 能 | can_use_tool 是「允许/拒绝」二元询问 → {confirmed:true/false} ↔ behavior allow/deny；title/display_name/description/decision_reason → title/message |
| select | 部分 | can_use_tool 无选项列表；permission_suggestions（权限规则建议，数组）语义不同，可投影为附加选项但语义错配，建议降级 confirm |
| input | 无 | can_use_tool 无自由文本输入形态；elicitation 的 form 模式（requested_schema）最接近，可映射为多条 input 或降级 |
| editor | 无 | 无对应 |
| notify | 部分 | hook_callback / elicitation url 模式的单向提示可合成 notify；无原生 fire-and-forget UI 请求 |
| setStatus / setWidget / setTitle / set_editor_text | 无 | claude 无宿主 UI 状态回写通道（requires_action 状态只经 session_state_changed 事件外流） |
| （开放字符串兜底） | — | 未知 method 经 (string & {}) 兜底接收，host 回 {unsupported:true} 即降级 |

deny 应答的 `interrupt:true`（src/utils/permissions/PermissionPromptToolResultSchema.ts:82-86 附近 Deny 分支）即「拒绝并中断」——与 taiji cancel 语义部分重叠，适配层可转译。

## 8. 能力位 11 位表

| 能力位 | 值 | 依据 |
|---|---|---|
| schemaEnforcement | native | `--json-schema` flag（src/main.tsx:976）+ result 帧 `structured_output` 回填（src/entrypoints/sdk/coreSchemas.ts:1421；合成工具 src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:20；重试上限 error_max_structured_output_retries src/QueryEngine.ts:1024） |
| steer | native | stdin stream-json 双向流运行中可持续注入 user 消息（queued_command attachment 注入主循环，src/QueryEngine.ts:876-892） |
| conversation | cold | 续聊 = 新进程 + `--resume <sessionId>` 冷恢复（src/main.tsx:989；transcript 链重建 src/utils/sessionStorage.ts:139-156），无驻留 interact 面 |
| personaInjection | file | `--agent <name>` 引用文件系统定义的 agent（.md，CLI 自扫描，src/cli/print.ts:4389-4391）；`--agents <json>` 为 flag 内联旁路；system prompt 走 initialize 控制请求（file 通道为主，flag/prompt 兜底均在） |
| eventGranularity | stream | `--include-partial-messages` 开启 stream_event 全量转发（src/main.tsx:976；src/QueryEngine.ts:818-826）；不开为 coarse |
| sandbox | none | CLI 无内建 OS sandbox（权限系统是准入层非隔离层）；`--dangerously-skip-permissions` 语义提示隔离靠外部（src/main.tsx:976）；worktree 隔离可由适配层 emulated（AgentTool 先例 src/utils/sessionStorage.ts:264-268） |
| sessionRead | full | transcript JSONL 四类链内消息完整记录对话（user/assistant/attachment/system，src/utils/sessionStorage.ts:139-146）+ parentUuid 主链回溯（§6） |
| resume | cold | `--resume <sessionId>`（src/main.tsx:989）+ `--fork-session` / `--resume-session-at` 细化（src/main.tsx:989, 991） |
| interrupt | native | control_request `interrupt` → abortController.abort()（src/entrypoints/sdk/controlSchemas.ts:97-103；src/cli/print.ts:2831, 1861；src/QueryEngine.ts:1153-1155） |
| permissionMode | native | `--permission-mode` 5 档（src/main.tsx:988；词表 src/entrypoints/sdk/coreSchemas.ts:337-348）+ 运行时 set_permission_mode（src/entrypoints/sdk/controlSchemas.ts:124-135）+ can_use_tool 询问回路 |
| maxTurns | true | `--max-turns`（src/main.tsx:976）执行且超限产 error_max_turns 终态（src/QueryEngine.ts:841-873；预算执行点 src/query.ts:1705） |

## 9. gap 清单

**源有靶无**（claude 有、taiji 协议面无承载，适配层丢弃或仅诊断消费）：
- 事件流：rate_limit_event、auth_status、prompt_suggestion、post_turn_summary（作 turn_end.summary 增强除外）、task_started/task_progress/task_notification（非 Task 投影时）、hook_started/hook_progress/hook_response、files_persisted、elicitation_complete、local_command_output、streamlined_text/streamlined_tool_use_summary（精简输出模式专属）、tool_use_summary、keep_alive、update_environment_variables
- result 帧字段：modelUsage（分模型明细）、permission_denials、fast_mode_state、stop_reason、duration_api_ms
- 控制请求：rewind_files、cancel_async_message、seed_read_state、mcp_message/mcp_set_servers/mcp_reconnect/mcp_toggle/mcp_status、stop_task、apply_flag_settings/get_settings、set_model/set_max_thinking_tokens（运行时切换，taiji 无对应方法）、elicitation、hook_callback（taiji 无 hook 面）
- flag 面：`--max-budget-usd`、`--task-budget`、`--fallback-model`、`--betas`、`--settings`、`--add-dir`、`--mcp-config`、`--plugin-dir`、`--workload`、`--no-session-persistence`、`--tools`（工具白名单，denyTools 之外的另一半）

**靶有源无**（taiji 协议要求、claude 无原生对应，需适配层合成或降级）：
- host/childSpawned / host/childStateChanged：无子进程上报协议，spawn/exit 由适配层 wait 链合成（initialize 应答 pid 可作一次 childSpawned）
- activity 周期活性：无原生心跳，由 tool_progress（30s 节流）/ api_retry / session_state_changed 合成；纯 LLM 长流式期间无活性帧（stream_event 本身可充当）
- AgentEvent.error：无独立 error 事件帧，从 result error_* 帧与 assistant 帧 error 字段合成
- task.graceTurns / idleTimeoutMs / scene / ctx.ctxModel / ctx.schemaEnv / ctx.sessionDir：无对应 flag 或概念（§2 备注列）
- host/askUser 的 select/input/editor/setStatus/setWidget/setTitle/set_editor_text 多数 method：can_use_tool 只有二元允许/拒绝（§7 对齐度表）
- AgentUsage.cost 单消息成本：成本只在累计级（total_cost_usd）
- host/streamDelta：无宿主 UI 回推通道

**语义错配**（同名不同义，映射时需显式转译）：
- **turn 定义**：taiji turn = assistant 响应回合（turn_end 闭合）；claude num_turns 按 user 消息计数（`messages.length - 1` 或每 user 消息 turnCount++，src/QueryEngine.ts:624, 753-755）——工具往返各计一 turn，数值口径不同，AgentOutcomeUsage.turns 直接透传 num_turns 会在 UI 呈现偏大
- **session 概念**：taiji sessionRef 是引擎自定义定位键值对；claude session = `~/.claude/projects/<dir>/<uuid>.jsonl` 单文件 + session_id，且 `--continue`（最近会话）与 `--resume`（指定会话）并存（src/main.tsx:989），锚点必须显式落 sessionId 不能依赖 continue
- **compaction 时机**：taiji compaction 是离散事件；claude 的 compact_boundary 是消息流内边界（带 trigger manual/auto + pre_tokens + preserved_segment 重链元数据，src/entrypoints/sdk/coreSchemas.ts:1506-1531），且压缩前后 transcript 通过 relink 拼接——read 重建需处理边界分割语义
- **tool result 双载体**：tool_result block（content 数组，对话流载体）与 toolUseResult 顶层字段（结构化 Output，诊断/展示载体）并存（src/utils/messages.ts:481），ToolCallResult.content/details 的装填需二选一约定（§4 建议）
- **thinkingLevel 词表**：taiji high/medium/low vs claude `--thinking enabled/adaptive/disabled` × `--effort low/medium/high/max` 双轴（src/main.tsx:976, 993）
- **permissionMode 词表**：taiji 中立模式 vs claude default/acceptEdits/bypassPermissions/plan/dontAsk（src/entrypoints/sdk/coreSchemas.ts:337-348），映射表需在适配层定死
- **进程生命周期**：taiji 引擎端点常驻（9 正向方法多 run 复用一进程）；claude 每会话一进程（-p 模式 run 结束即退出），协议 initialize/listModels/dispose/ping 需映射为「每次 spawn 内的首轮控制握手 + 进程退出即 dispose」或适配层常驻 wrapper 重构——这是接入形态最大的结构差异
