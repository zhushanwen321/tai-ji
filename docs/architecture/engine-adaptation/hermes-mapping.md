# hermes 引擎适配映射（engine-protocol v1）

证据基准：NousResearch/hermes-agent@fa3b06b（2026-06-01 快照，较旧，结论按机制存在性采信）。hermes 版本 0.15.1（hermes_cli/__init__.py:17），Python 3.11 + Fire CLI；ACP 依赖 agent-client-protocol==0.9.0（pyproject.toml:132 `[acp]` extra）。源码引用均为该仓库内相对路径（GitHub NousResearch/hermes-agent）。
映射目标 = subagent-engine-sdk 协议 v1（`packages/subagent-engine-sdk/src/protocol/`）。

---

## 1. 接入形态与进程拓扑

推荐 zcode 式常驻接入：spawn `hermes acp`（acp_adapter/entry.py:7-13 用法；hermes_cli/main.py:11559 `_AGENT_COMMANDS = {None, "chat", "acp", "rl"}`）→ `HermesACPAgent` + `asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))`（acp_adapter/entry.py:255-257），ACP stdio JSON-RPC：stdout 独占协议帧，日志全部走 stderr（entry.py:75-88）；AIAgent 的人类可读输出也被重定向到 stderr（acp_adapter/session.py:112-120, :627）。一个常驻进程承载多个 ACP session（每 session 一个 AIAgent，跑在共享 ThreadPoolExecutor worker 线程，`max_workers=4`，acp_adapter/server.py:85, :1502）。ACP 方法面两层：标准方法 initialize / authenticate / new_session / load_session / prompt / cancel / set_session_mode / set_config_option + unstable 扩展 resume_session / fork_session / list_sessions / set_session_model（server.py:821-1953 各实现；`use_unstable_protocol=True` 开启）。session 持久化到 SessionDB SQLite（`<HERMES_HOME>/state.db`），进程重启后可恢复（acp_adapter/session.py:1-7, :417）。

env 与凭据：`HERMES_HOME` 环境变量覆写数据根（默认 `~/.hermes`，hermes_constants.py:43-47 `get_hermes_home()`）——taiji 适配器 spawn 时设独立 HERMES_HOME 即完成数据隔离；启动时自动加载 `<HERMES_HOME>/.env`（entry.py:96-108）。模型凭据无 CLI flag 直注通道，经 `resolve_runtime_provider()` 从配置/env 解析（acp_adapter/session.py:609-619；acp_adapter/auth.py:11-33）——适配器可预写 HERMES_HOME 内配置或注入 env；`base_url`/`api_key`/`provider` 是 AIAgent 构造参数（run_agent.py:319-321），适配器若自建 agent 可直传。

CLI 降级路径（一次性任务形态）：`hermes -q "<query>"`（cli.py:15295-15296 q/query 别名）单轮运行，final_response 打到 stdout（run_agent.py:4793-4796）。局限：无结构化事件流（无 delta/tool 事件 wire 面）、无 per-run schema；续接靠 `--resume <session_id>`（cli.py:15304, :3218-3224）；SIGTERM → `agent.interrupt()` + 1.5s 宽限（HERMES_SIGTERM_GRACE 可覆写）再 KeyboardInterrupt（cli.py:15476-15510）。仅作 ACP 不可用时的回退。

分发成本：hermes 是 Python 仓，常驻进程需要 Python 3.11+ 运行时与依赖安装（uv/pip，acp extra 装 agent-client-protocol），Electron/Node 宿主侧需捆绑 Python 或依赖用户环境——分发成本显著高于 Node 系引擎（codex/zcode），与 opencode（单二进制）同理更重。

## 2. run 参数映射表

run.params.task（AgentCallOpts）/ ctx / resume → ACP `new_session`（server.py:1069-1084）+ `prompt`（server.py:1243-1580）+ hermes AIAgent 构造参数（run_agent.py:317-384，转发 agent/agent_init.py）+ 扩展方法。

| taiji 字段 | 源对应 | 证据（file:line） | 缺省/不可达备注 |
|---|---|---|---|
| task.prompt | ACP `prompt.prompt[]` 文本块抽取（TextContentBlock → str；多模态块转 OpenAI content parts） | server.py:1243-1268, :359-375, :394-442 | 直接。一次 prompt = 一次 run_conversation = 一个 taiji run |
| task.schema | 无原生通道。主对话循环无 response_format/json_schema；`plugin_llm.complete_structured`（prompt 内嵌 schema 文本 + jsonschema 校验）是插件辅助 LLM 通道，不在主 loop | agent/plugin_llm.py:375-427, :465-475 | schemaEnforcement=emulated：适配器把 schema 拼进 prompt + 宿主 ajv 校验（zcode 同法） |
| task.thinkingLevel | `AIAgent(reasoning_config=...)`（OpenRouter reasoning 覆写，如 `{"effort": "none"}`） | run_agent.py:358；agent/agent_init.py:235, :458 | 词表不同需映射（taiji high/medium/low → effort 词表）；经 ACP 无 per-run 参数，须在 SessionManager._make_agent 时注入 |
| task.scene | 无对应 | — | 宿主自持诊断字段 |
| task.maxTurns | `AIAgent.max_iterations`（默认 90）；CLI `--max_turns` → 同字段（env HERMES_MAX_ITERATIONS 兜底） | run_agent.py:328；cli.py:3087-3096, :5014；hermes_cli 配置默认 cli.py:400 | native（能力位 true）。语义粒度 = API 调用次数（工具循环迭代），非 taiji「用户轮」——见 §9 |
| task.graceTurns | 无对应 | — | 引擎无宽限轮概念，超限直接 break（conversation_loop.py:12449 同粒度检查在 CLI 层） |
| task.skill / task.skillPath | CLI `skills` 参数可 preload（cli.py:15298）；agent 内有 skill_view/skill_manage/skills_list 工具自取 | toolsets.py:357-359（hermes-acp toolset 含 skills 三工具） | 无 per-run SKILL.md 注入参数 → emulated：适配器读文件经 ephemeral_system_prompt 注入 |
| task.description | 无对应 | — | 诊断字段，宿主自持 |
| task.agent（.md 绝对路径） | 无 per-agent 文件机制。系统提示三段式 stable/context/volatile：SOUL.md 身份 + cwd 项目上下文（AGENTS.md/.cursorrules 等首个命中）自动装载 | agent/system_prompt.py:61-90；cli.py:3126；hermes_cli/tips.py:219 | personaInjection=prompt 通道：适配器读 .md 传 `AIAgent(ephemeral_system_prompt=...)`（run_agent.py:335；拼接点 agent/conversation_loop.py:1001-1002） |
| task.appendSystemPrompt | 同上：`ephemeral_system_prompt`（string，数组合并 `\n\n` join）；`run_conversation(system_message=)` 为覆盖式替代 | run_agent.py:335；conversation_loop.py:1001-1002, :365 | 语义备注：ephemeral = 只进运行时系统提示、不落 trajectory/DB；无 append 语义的独立槽 |
| task.fork | ACP `fork_session`：deepcopy 原 session history 到新 session_id | server.py:1176-1194；acp_adapter/session.py:253-281 | fork 出新 session（非原地） |
| task.forkSource | fork_session 仅按 session_id 定位源，无 path 形态 | session.py:253-260 | 语义错配：taiji forkSource 是文件路径；适配器需宿主先把路径解析回 sessionId（经 resume.resume.sessionRef 键），见 §9 |
| task.worktree | 无引擎内 worktree。CLI `--worktree/-w` 自动建 git worktree（`.worktrees/` + `.worktreeinclude` 复制）；ACP 路径无对应 | cli.py:15305-15306, :1042-1156 | 宿主侧预建 worktree 后经 ctx.cwd 指向；能力位 sandbox=emulated |
| task.idleTimeoutMs | 无对应 | — | 宿主 idle GC 职责 |
| task.denyTools | `disabled_toolsets`（toolset 粒度做减法，末尾统一 subtraction） | model_tools.py:379-402；toolsets.py:606-627（validate/resolve 按工具集名） | 单工具粒度无原生 deny；`create_custom_toolset`（toolsets.py）可合成单工具集 → emulated |
| task.permissionMode | ACP session modes：default/accept_edits/dont_ask ↔ edit approval policy ask/workspace_session/session（:502-514 映射表）+ 危险命令 approval 交互 | server.py:529-560, :1916-1930；acp_adapter/permissions.py | native 但词表需映射；引擎另有三层自有策略（mode/yolo/hardline，见 §7） |
| ctx.cwd | ACP `new_session.cwd`（粘性，可经 load/resume 的 cwd 更新）；同时注册 terminal 工具 task cwd override | server.py:1069-1076；session.py:210-229, :123-137, :357-366 | 直接 |
| ctx.model | 无 NewSession 参数；经扩展方法 `set_session_model(model_id)`（`provider:model` 复合编码）或适配器直建 agent | server.py:1882-1914, :568-576, :640-657 | 直接（扩展方法）；NewSession 应答 models 字段携带当前 ModelInfo |
| ctx.schemaEnv | 无对应 | — | schema 走 prompt 主通道 |
| ctx.ctxModel / sessionRootId / sessionDir | 无对应 | — | pi 专属键 |
| ctx.streamMode | 引擎恒流式（stream_delta_callback + ACP chunk） | conversation_loop.py:3879-3904 | 恒 stream |
| resume.recordId | 适配器自持关联键 | — | 用于 host/handleReady、host/childStateChanged 回填 |
| resume.resume.sessionRef | ACP `resume_session`/`load_session`（按 session_id 定位 + 全量历史 replay 后应答） | server.py:1130-1160, :1086-1128 | 两者语义近同：missing 时 resume 建新（:1138-1140）、load 返回 None（:1094-1096）；sessionRef 构成建议见 §6 |

## 3. 事件映射表

映射方式标注：直接 / 合成（适配器组装）/ 丢弃。

### 3.1 AIAgent 回调全集（构造参数 11 个，run_agent.py:346-356）

| 源回调与签名 | 触发点 | taiji 事件 | 方式 | 证据 |
|---|---|---|---|---|
| tool_progress_callback("tool.started", name, preview, args) | 每个待执行 tool 调用 fan-out 时（args 为 dict） | tool_start{toolName, args} | 直接 | agent/tool_executor.py:253-256；acp_adapter/events.py:134-181 |
| tool_progress_callback("tool.completed", name, None, None, duration, is_error, result) | 工具执行完成 | tool_end（result/isError 齐全的最精准源） | 直接 | tool_executor.py:460-467 |
| tool_progress_callback("reasoning.available", "_thinking", text, None) | assistant 消息带 reasoning 文本时 | thinking_delta（或丢弃，若 reasoning_callback 已流式） | 合成 | conversation_loop.py:3553-3555 |
| tool_progress_callback("_thinking", first_line) | delegate 子 agent 场景首行 relay | 丢弃 | 丢弃 | conversation_loop.py:3549-3551 |
| tool_start_callback(tc.id, name, args) | fan-out（与 tool.started 同点，带 provider tool_call id） | tool_start | 直接（备用通道，ACP adapter 未接线） | tool_executor.py:261-264 |
| tool_complete_callback(tc.id, name, args, function_result) | 每工具完成（带 id，比 step_callback 配对更可靠） | tool_end{toolName, args, result} | 直接（备用通道，ACP adapter 未接线） | tool_executor.py:490-494 |
| thinking_callback(text) | kawaii 等待语/状态提示（非模型思考流） | 丢弃（ACP adapter 显式置 None，server.py:1392） | 丢弃 | conversation_loop.py:1119, :1277, :1318, :1415, :1996, :2011 |
| reasoning_callback(text) | provider reasoning delta（流式） | thinking_delta{delta} | 直接 | agent/chat_completion_helpers.py:821；acp_adapter/events.py:189-202 |
| clarify_callback(...) | clarify 工具（hermes-acp toolset 不含） | UiRequest select（理论对应） | 丢弃（不装该工具） | tool_executor.py:754-765 |
| step_callback(api_call_count, prev_tools) | 每轮 API 调用后；prev_tools=[{name, result, arguments}]（上一 assistant 的 tool_calls 与配对 tool 结果） | tool_end（逐个 prev_tools 展开）+ turn 进度活性 | 直接 | conversation_loop.py:845-869；acp_adapter/events.py:209-259 |
| stream_delta_callback(text) / (None) | 正文流式 delta；(None) 为流结束哨兵 | text_delta{delta}；None → 适配器关界信号（不开事件） | 直接 | conversation_loop.py:3879-3904；run_agent.py:3570+ |
| interim_assistant_callback(visible, already_streamed) | 中途 assistant 评论消息定稿 | text_delta 或丢弃（与流式去重） | 合成（备用，ACP adapter 未接线） | run_agent.py:3553-3565 |
| tool_gen_callback(tool_name) | 模型开始流式生成 tool 参数 | activity | 合成 | run_agent.py:3633-3641 |
| status_callback("lifecycle"｜"warn", message) | 生命周期/降级/压缩告警文本 | activity；warn 级 → error 或 host/log；压缩类 lifecycle 文本 → compaction（弱信号） | 合成 | run_agent.py:739-752, :755-767；agent/conversation_compression.py:259-267 |

非回调活性源：`_touch_activity(desc)` 更新 `_last_activity_ts`，在 API 调用完成、工具执行、长命令心跳等处触发（run_agent.py:2376-2391；conversation_loop.py:1988；tool_executor.py:276-278, :407-412, :487）——非回调不可直接挂钩，activity 事件的可靠合成源 = 任一回调触发/任一 ACP session_update 出站时发 activity（taiji 活性判据）。

### 3.2 ACP session/update 出站全集（hermes acp_adapter 实发）

| ACP 更新（session_update 变体） | taiji 事件 | 方式 | 证据 |
|---|---|---|---|
| agent_message_chunk（AgentMessageChunk） | text_delta | 直接 | server.py:929-946, :1311, :1542；events.py:266-279 |
| agent_thought_text_chunk（AgentThoughtChunk） | thinking_delta | 直接 | server.py:948-951；events.py:189-202 |
| user_message_chunk（UserMessageChunk） | —（重放用户历史/队列回显，宿主已知） | 丢弃 | server.py:936-940, :1558-1561 |
| tool_call（ToolCallStart） | tool_start | 直接 | server.py:1041；acp_adapter/tools.py:1017-1242 |
| tool_call_update（ToolCallProgress，status completed/failed） | tool_end | 直接 | events.py:244-251；tools.py:1249-1274 |
| plan（AgentPlanUpdate，todo 工具结果投影） | —（taiji 9 事件无 plan 槽） | 丢弃（或宿主 GUI 自行消费） | events.py:39-84, :252-255 |
| available_commands_update（9 个 slash 命令） | — | 丢弃 | server.py:448-500, :1584-1627 |
| session_info_update（自动标题） | — | 丢弃 | server.py:712-741 |
| usage_update（上下文水位 size/used，非 token 用量） | —（或作 activity） | 丢弃（合成 activity 可选） | server.py:660-710 |
| ServerRequest session/request_permission | host/askUser → UiRequest confirm | 直接 | acp_adapter/permissions.py:107-168；edit_approval.py:234+ |

**usage 是否随 ACP 事件暴露（第一轮未决，本轮结论）**：是——`prompt` RPC 应答 `PromptResponse.usage = Usage{input_tokens, output_tokens, total_tokens, thought_tokens, cached_read_tokens}`（server.py:1567-1580），即 usage 在**turn 终态**到达（PromptResponse），不随中途 chunk 事件走；且值为 session 累计（见 §5）。无 cacheWrite 槽。

### 3.3 9 种 taiji 事件落位小结

tool_start ← tool.started/ToolCallStart；tool_end ← tool.completed/step_callback/ToolCallProgress；text_delta ← stream_delta/agent_message_chunk；thinking_delta ← reasoning_callback/agent_thought_text_chunk；turn_end ← 合成（PromptResponse 应答到达即关界，stop_reason end_turn/cancelled，server.py:1579-1580）；message_end ← 合成（usage 取自 PromptResponse.usage 差分）；compaction ← 弱信号合成（status_callback 压缩 lifecycle 文本 conversation_loop.py:645-660 + usage_update 水位跳水；/compact slash 命令 server.py:1796-1847 无回调信号）；activity ← 合成（任一回调/session_update + tool_gen_callback）；error ← 合成（run_conversation 结果 failed/partial/error 键，conversation_loop.py:4642-4660；ACP 侧异常 server.py:1463-1465）。

## 4. 内容块与 tool 调用映射

| hermes 侧 | taiji 装载 | 说明 |
|---|---|---|
| tool_progress_callback("tool.started", name, preview, args)（args: dict；字符串形式会 JSON parse，失败包 {"raw": s}） | tool_start{toolName: name, args} | events.py:134-145；id 由适配器生成 `tc-<uuid>`（acp_adapter/tools.py:86-88），同名并行调用按 per-name FIFO 队列配对（events.py:146-154） |
| tool_complete_callback(tc.id, name, args, function_result)（推荐主源）/ step_callback prev_tools[].result | tool_end{toolName, args, result:{content:[function_result]}, isError} | hermes 工具结果恒为字符串（OpenAI tool role content）→ content 数组装单元素字符串；若 result 是结构化 JSON（多数核心工具如此），可 parse 后放 details、原文放 content[0] |
| isError 判定 | isError | 双源：执行器 is_error（异常包装前缀 `Error executing tool '<name>': ...`，tool_executor.py:306-308）；ACP 展示层保守判定 `_tool_result_failed`——前缀命中 / `success`/`ok` 为 false / exit_code≠0 / 核心工具带 error 键（acp_adapter/tools.py:205-240） |
| ToolKind 映射（TOOL_KIND_MAP 27 工具：read/edit/execute/search/fetch/think 等） | 无槽（taiji 无 kind） | 丢弃；acp_adapter/tools.py:21-56 |
| ACP 5000 字符截断（_truncate_text） | 不采用 | 展示层行为，适配器透传完整 result（tools.py:243-246） |
| reasoning 文本（canonical: `reasoning_content`，兼容: `reasoning`） | ReplayedTurn.thinking | server.py:911-926（两键并存、双活路径） |
| assistant content | ReplayedTurn.text | 含 `<think>` 块剥离逻辑（conversation_loop.py:3542-3545 同族） |

## 5. usage 映射表

归一化源：每次 API 调用响应 usage 经 `normalize_usage(usage, provider, api_mode)` 得 canonical_usage（agent/usage_pricing.py:700；conversation_loop.py:1834-1857），累计到 agent.session_* 计数器（conversation_loop.py:1871-1879）；run_conversation 终态返回累计值 + 成本（conversation_loop.py:4646-4675）。ACP PromptResponse.usage 即从这组累计值构建（server.py:1567-1575）。

| taiji 字段 | 源字段 | 证据 | 备注 |
|---|---|---|---|
| AgentUsage.input | canonical_usage.input_tokens（兼容 prompt_tokens） | conversation_loop.py:1852, :1875 | **session 累计，非单条增量**——适配器须按 PromptResponse 间差分得 message_end 增量 |
| AgentUsage.output | output_tokens（兼容 completion_tokens） | conversation_loop.py:1853, :1876 | 同上 |
| AgentUsage.cacheRead | cache_read_tokens | conversation_loop.py:1854, :1877 | ACP 槽名 cached_read_tokens（server.py:1574） |
| AgentUsage.cacheWrite | cache_write_tokens | conversation_loop.py:1855, :1878 | **ACP Usage schema 无此槽**——适配器若在 ACP 之上则丢失；in-process 直连 AIAgent 才可取 |
| AgentUsage.cost | estimated_cost_usd（estimate_usage_cost 估价，带 cost_status/cost_source 修饰） | conversation_loop.py:1892-1902, :4671-4673 | 有（估价非账单）；累计值，ACP 槽同样缺失 |
| OutcomeUsage.contextTokens | 无精确值；近似 = last_prompt_tokens（compressor 侧最后请求 prompt 数）或 estimate_request_tokens_rough | conversation_loop.py:4670；server.py:676-685 | 近似合成 |
| OutcomeUsage.turns | api_calls | conversation_loop.py:4645 | 粒度 = API 调用次数 |
| reasoning_tokens 归属 | canonical_usage.reasoning_tokens 单列 | conversation_loop.py:1856, :1879 | 归一化后单列字段；ACP 侧承载于 Usage.thought_tokens（server.py:1573）；taiji 无槽，丢弃（是否已含于 output 取决于 provider 归一化，未逐 provider 核实） |

## 6. session 记录与 read 重建

存储：SessionDB SQLite，路径 = `<HERMES_HOME>/state.db`（acp_adapter/session.py:417；hermes_constants.py:43-47）。ACP session 全量替换式持久化：`db.replace_messages(session_id, history)`（session.py:472；hermes_state.py:1937）。

sessions 表（hermes_state.py:234-269，33 列）：id, source('acp'), user_id, model, model_config(JSON: cwd/provider/base_url/api_mode), system_prompt, parent_session_id, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cwd, billing_provider, billing_base_url, billing_mode, estimated_cost_usd, actual_cost_usd, cost_status, cost_source, pricing_version, title, api_call_count, handoff_state, handoff_platform, handoff_error, rewind_count, archived。
messages 表（hermes_state.py:271-290）：id, session_id, role, content, tool_call_id, tool_calls(JSON), tool_name, timestamp, token_count, finish_reason, reasoning, reasoning_content, reasoning_details, codex_reasoning_items, codex_message_items, platform_message_id, observed, active(软删)。FTS5 全文索引双表（unicode61 + trigram，hermes_state.py:320-367）。

重建源：`get_messages_as_conversation(session_id, include_ancestors, include_inactive)` → OpenAI 格式 `[{role, content, tool_call_id?, tool_name?, tool_calls?[], reasoning?/reasoning_content?, finish_reason?}]`，只取 active=1、按 id 序（hermes_state.py:2321-2407）。→ ReplayedTurn 映射：按序遍历，assistant.content → text；assistant.reasoning(_content) → thinking；assistant.tool_calls[]（OpenAI 形态：id/function.name/function.arguments JSON 字符串）→ toolCalls[]（arguments parse → args）；后续 role="tool" 消息按 tool_call_id 配对 → result.content（isError 无 DB 列，从 finish_reason/内容弱判）；role="user" 不进 turn。source = **native**。

ResumeSession/ForkSession 语义：resume_session = 内存缺失时从 DB 恢复（仅 source=="acp" 行，session.py:476-548）+ cwd 更新 + 全量历史 replay 到客户端后应答（server.py:1130-1160, :979-1067）；fork_session = deepcopy history → 新 session_id（session.py:253-281）。压缩分叉：引擎自动压缩会在 SQLite 分裂出 parent_session_id 链（compress_context，agent/conversation_compression.py:275+）；read 全量需 `include_ancestors=True` 沿 lineage root→tip 遍历（hermes_state.py:2335-2337, :2409-2429）；ACP `/compact` 特意绕开分裂（临时置空 agent._session_db，server.py:1819-1829）——两条压缩路径的落盘形态不同，read 重建必须处理祖先链。

ResumeAnchor.sessionRef 构成建议：`{sessionId: <uuid>, hermesHome: <get_hermes_home() 绝对路径>}`——hermes 无单文件 session 概念，库定位必须连 HERMES_HOME 一起钉死（多实例隔离）；journalPath 缺省。outcome.sessionId = ACP session_id（uuid4，session.py:215）；sessionFile 无对应（填 state.db 路径仅作诊断，语义登记见 §9）。

## 7. 反向通道映射

| taiji 通道 | 源对应物 / 合成方式 | 证据 |
|---|---|---|
| host/log{level,component,message,data?} | hermes 日志恒走 stderr（entry.py:75-88）；适配器捕 stderr 行合成 | 直接对应物 |
| host/askUser{runId, request} | ACP ServerRequest `session/request_permission`：危险命令 approval（options: allow_once/allow_session/allow_always/deny/deny_always，60s 超时 auto-deny）→ UiRequest{method:"confirm", title, message, options, timeout}；文件编辑 approval（edit_approval，diff 展示，policy ask/workspace_session/session 三档，敏感路径恒问）→ 同 confirm | permissions.py:21-27, :41-70, :107-168（timeout :112, :153-157）；edit_approval.py:148-183, :234+ |
| host/streamDelta{runId, delta} | ACP 无独立 UI 加速通道；适配器从 text_delta 同源复制（合成双通道） | 合成 |
| host/handleReady{runId, sessionRef} | 合成：NewSession/resume 应答后即发（session_id 此刻已知） | server.py:1080-1084, :1157-1160 |
| host/childSpawned{pid, recordId} | 常驻形态无 per-run 子进程；合成 pid = hermes 进程 pid（仅诊断）；CLI 降级形态为真实子进程 pid | 合成 |
| host/childStateChanged{pid, recordId, state, killed, exitCode?, signal?} | 同上合成（进程退出时）；run 级 exitCode 在常驻形态无意义（协议 null = 被杀语义保留给杀链合成） | 合成 |

**approval 三层与 UiRequest 对齐度**（tools/approval.py）：
- `approvals.mode` 策略（config.yaml 是 SSOT，写 config.yaml/`.env` 的命令本身被拦截防自改，approval.py:131-140）+ yolo（`--yolo`/`/yolo`）→ 映射 taiji permissionMode 词表可覆盖（fixed auto = yolo/dont_ask）。
- 危险命令检测（DANGEROUS_PATTERNS，approval.py:517+ 模式库）→ 走 request_permission 交互 = UiRequest confirm 可映射。
- **hardline 无条件拦截不可映射**：detect_hardline_command（approval.py:289-297）命中的命令（rm -rf /、块设备覆写、shutdown 等）直接返回 BLOCKED 结果、不产生任何交互请求，`--yolo`/`approvals.mode=off` 均不可绕过（approval.py:178-197, :299-312）——这是引擎内置红线，语义 = taiji denyTools 之外的下限，适配层只能透传失败结果，UiRequest 无对应。容器化执行环境（docker/modal 等）天然绕过 dangerous 层（approval.py:186-189），permissionMode 声明时须按执行环境区分。

## 8. 能力位 11 位表

| 位 | 值 | 依据 |
|---|---|---|
| schemaEnforcement | emulated | 主循环无 response_format/json_schema；plugin_llm.complete_structured 仅插件辅助通道（agent/plugin_llm.py:375-475） |
| steer | emulated | ACP 标准面无 steer 方法；经 prompt 通道 `/steer` 文本命令（server.py:1282-1301, :1849-1866）。引擎内建原生 steer() API（run_agent.py:2063-2097，注入下个 tool result 不中断）与 interrupt(message)（run_agent.py:1962-1987，中断+消息进上下文）——适配器若 in-process 直调可升 native，经 ACP 文本协议即 emulated |
| conversation | cold | ResumeSession 冷恢复（DB 重建 history + replay，跨进程重启可续）；非原地续写 |
| personaInjection | prompt | ephemeral_system_prompt 内容注入；无 per-agent 文件装载机制（.md 需适配器自读） |
| eventGranularity | stream | delta 流 + per-tool 事件齐备 |
| sandbox | emulated | 无 OS sandbox；文件隔离 = CLI `-w` worktree（cli.py:1042-1156）；执行隔离 = 六种执行环境 local/docker/ssh/singularity/modal/daytona（tools/terminal_tool.py:1143-1156；tools/environments/ 目录） |
| sessionRead | full | get_messages_as_conversation 完整历史含 tool_calls/reasoning（hermes_state.py:2321-2407）；压缩分叉经 include_ancestors lineage 遍历补全（:2409-2429） |
| resume | cold | ResumeSession + state.db 持久化（server.py:1130-1160；session.py:476-548） |
| interrupt | native | cancel → cancel_event.set() + agent.interrupt() 优雅中断（server.py:1162-1174；run_agent.py:1962-2028，含工具线程/子 agent 扇出）；SIGTERM 1.5s 宽限杀链（cli.py:15489-15501） |
| permissionMode | native | ACP modes 三档 + request_permission 交互 + 自有 mode/yolo/hardline 层（server.py:502-560；permissions.py） |
| maxTurns | true | AIAgent max_iterations（默认 90，run_agent.py:328；cli.py:3087-3096） |

## 9. gap 清单

**源有靶无**（hermes 有、taiji 协议无槽，丢弃或宿主自行消费）：
- ACP plan 更新（todo 工具 → AgentPlanUpdate，events.py:39-84）；available_commands（9 个 slash 命令，server.py:448-500）；session_info_update 自动标题（server.py:712-741）；usage_update 上下文水位（server.py:660-710）
- 多模态输入（image/resource blocks → OpenAI content parts，server.py:378-442）；MCP server 动态注册（NewSession.mcp_servers，server.py:750-817）
- 工具面：delegate_task 子 agent、execute_code、browser_* 11 工具、send_message/kanban/cron 等平台工具、memory/session_search 跨会话记忆（toolsets.py:347-364 hermes-acp 29 工具）
- SOUL.md 身份 / AGENTS.md/.cursorrules 项目上下文自动装载（system_prompt.py:61-90）；skills 三工具；checkpoint 体系；六种执行环境；interim_assistant 中途评论；clarify 工具（hermes-acp 不装）

**靶有源无**（taiji 需要、hermes 无原生）：
- task.schema native 通道 / ctx.schemaEnv；graceTurns；idleTimeoutMs；per-run exitCode（常驻形态）；UiRequest 的 input/editor/setStatus/setWidget/setTitle 等 fire-and-forget 面（ACP 仅 request_permission 一族）；host/streamDelta 独立加速通道；denyTools 单工具粒度；cacheWrite/cost 的 ACP wire 槽（in-process 才可取）

**语义错配**（同名不同义，适配层必须显式处置并登记）：
- session 概念：hermes session = SQLite 库中一行 + messages 表记录集（state.db，session.py:1-7）；taiji sessionFile = 单文件。ResumeAnchor 用 {sessionId, hermesHome}；outcome.sessionFile 字段只能空缺或填 state.db 路径（仅诊断），不得假装是可独立回放的 session 文件
- maxTurns 粒度：hermes max_iterations = 工具循环内 API 调用次数（run_agent.py:328），非 taiji「用户轮」——宿主 turn 计数器不能直接拿它当等价物
- usage 累计 vs 增量：PromptResponse.usage / run_conversation 返回值均为 session 累计（conversation_loop.py:1871-1879, :4646-4657），taiji message_end.usage 需差分
- fork 键形态：fork_session 按 session_id（server.py:1176），taiji forkSource 是文件路径——需宿主把 forkSource 解析回 sessionRef 键
- persona 载体：ephemeral_system_prompt 是运行时注入且不落盘（run_agent.py:335；agent_init.py:220 注释），与 taiji agent .md 文件身份锚点不同源——身份不持久化，resume 后需重新注入
- tool result 形态：hermes 结果恒字符串（OpenAI content string），taiji ToolCallResult.content 数组 + details 结构化需适配器二次 parse（部分工具结果为内嵌提示的 JSON，需 raw_decode 容错，tools.py:187-202）
- 压缩双轨：引擎自动压缩分裂 SQLite session（lineage 链，需 include_ancestors）vs ACP /compact 防分裂（server.py:1819-1829）——同引擎两条压缩路径落盘形态不同，read 重建与 sessionRef 稳定性都要按最坏情况设计
- 并行工具配对：一轮可多工具并发执行，step_callback/prev_tools 与 per-name FIFO 队列（events.py:146-154）是结果配对的关键路径；taiji 逐 tool_start/tool_end 事件流必须保持配对不变量，丢一个 tool_end 会错位整轮
- hardline 红线：不可交互、不可配置绕过的引擎内置拦截（approval.py:178-197），permissionMode=任何值都不改变其行为——GUI 权限承诺须排除该层
