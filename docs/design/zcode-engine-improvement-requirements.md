# zcode 引擎改造需求（调研整合）

> 定位：zcode 引擎（`packages/zcode-subagent-cli`）与 pi 引擎能力差距的调研结论 + 改造需求清单，作为后续 tech-design 的输入。本文只登记需求与证据，不含实施方案设计。
>
> 调研基线：ZCode app-server bundle（`ZCode.app/Contents/Resources/glm/zcode.cjs`，version `0.13.3`，约 11.4MB minified CJS——下文 `offset N` 均为其字节偏移，可用 `grep -ob` + `dd` 复现）与本仓 `feat-zcode-engine-fix` 分支源码。zcode 版本升级后 bundle 偏移全部失效，结论需按锚点字符串重验。
>
> 断言分级：正文所有结论均标注【事实】（本调研有代码/探针直接证据，锚点随文给出）或【推断】（由已知推导、未核实）。无标注处为【事实】。

## 0. 八问结论总表

| # | 问题 | 结论 | 性质 |
|---|------|------|------|
| Q1 | 凭据为什么要 `~/.zcode/cli/config.json` 读取重定向 | 上游 CLI 硬编码只认该路径，`ZCODE_*` env 白名单无 config 路径覆盖项；GUI 凭据存另一文件且互不回写 → fs 拦截是唯一注入通道，现状有据 |
| Q2 | 续聊（丢早前轮次）是 zcode 内置行为还是我们实现导致 | zcode 有原生 `session/resume` 热装载（全量上下文）；丢轮次是我们 cold 注入 24k token 预算裁剪的实现后果，非上游限制 |
| Q3 | 缺省模型是 engine 写死还是 zcode 内部写死 | 我们写死：taiji 恒显式传 model，压掉了 zcode 用户级 `defaultModelSelection` 配置；不传 model 时 zcode 自行解析缺省 |
| Q4 | worktree 参数应由 subagent-core 统一支持 | 架构判断成立：worktree 重资产（创建/回收/reaper/patch/重建）早已全在 core，仅缺「handle.path → task.cwd」传导与引擎侧 ctx 还原；且发现 pi 侧 worktree 当前实际未生效【推断，证据充分】 |
| Q5 | schemaEnforcement 可否经 plugin/hook/mcp 实现 | 上游无「强制最终输出符合 schema」的原生通道（MCP outputSchema 被引擎信封替换）；可行半原生路径 = MCP 提交工具（inputSchema 透传约束）+ Stop hook 校验兜底（上限 3 次续跑） |
| Q6 | personaInjection 可否单独做 hook 实现 | subagent 场景有原生通道（agent Markdown → "Subagent Agent Prompt" 系统 prompt 段）；hook 的 additionalContext 只进会话历史条目，非 system prompt；独立 create 会话无 systemPrompt RPC 参数 |
| Q7 | zcode 有 fork 能力 | `session/fork` RPC 存在：checkpoint copy-on-write 分叉 + 继承 mode/model/thoughtLevel；限制 = 仅能 fork 当前 app-server 进程内存中的活跃会话 |
| Q8 | thinking 不进直播流是底层限制还是我们没做 | 非底层限制：两引擎产生层都完整产出 thinking 增量；断点在我们中间层——转发载体只承载 text、WS 帧无 thinking 字段、renderer 无消费位；zcode 另缺 GUI 直播帧生产者 |

## 1. 逐问证据

### Q1 凭据：config 路径无 env 覆盖通道【事实】

- 路径硬编码：bundle 定义 `TZr="~/.zcode/cli"` + `IZr="config.json"`（offset 5779100 附近，`getDefaultConfigPath` 模块）。
- env 白名单穷举：`parseEnvConfig`（offset 5780000 附近）只接受 `ZCODE_` 前缀的这些键——`STORAGE_DIR` / `SESSION_DB_PATH` / `SESSION_DB` / `HTTP_PROXY` / `NO_PROXY` / `AGENT_CA_CERT` / `HTTP_TIMEOUT` / `TIMEOUT` / `LOG_FORMAT` / `MAX_TOOL_CONCURRENCY`。无任何 config 文件路径键。
- 结论：CLI 凭据文件路径不可经 env 重定向；taiji 现行 fs 拦截 launcher（`appserver-launcher.ts` 的「真实文件 + v2 provider 注入」内存合并）是唯一注入通道。GUI 凭据与 CLI 凭据是两套文件、互不回写。
- 附带印证：现行会话库隔离用的 `ZCODE_SESSION_DB_PATH`（及别名键 `ZCODE_SESSION_DB`）恰在该官方白名单内——会话库隔离走的是官方支持通道，而凭据注入不是。

### Q2 续聊：zcode 原生 resume 存在，冷注入是我们的选择【事实】

`session/resume` handler 链（`y9t`，offset 11112826）语义已完全解码：

1. 先查内存 Map（`e.sessions`），命中直接返回；
2. 未命中则从 sqlite sessionStore 读持久化 record，构造 host-kind 活跃 record（`S9t`，**model 传 void 0**）；
3. `e.sessions.set` 热装载回活跃 Map，`app.resume()` 恢复**全量上下文**（可选 `reusePersistedMessages` 复用已装载消息）。

与 -32031 的关系：`-32031` 不是「会话不可续」，而是 `restoreWarning` 门——`session/send`（offset 11121814）与 compact（offset 11003857）在 record 带 restoreWarning 时拒绝。清除条件（offset 10795703 的 `GI`）：非 execution-scope 且 `hasUsableRuntimeModelTarget` 为真即自动清除，而该函数 = `app.listModels().length > 0`（offset 11250591）。即 -32031 的实际语义是「resume 后当前一个可用模型都没有」（典型：凭据失效），模型可用后自动解除。taiji 经 fs 拦截注入凭据，模型目录正常非空，走 resume 路径不构成障碍。restoreWarning 的构造点在 bundle 中无字面量赋值（仅消费/清除可见），【推断】在 app 层 resume 后模型解析失败时设置——未核实，不影响上述消费语义结论。

当前 taiji 的 cold 续聊（读历史 → `ZCODE_RESUME_HISTORY_TOKEN_BUDGET = 24_000` 裁剪 → 注入新会话 prompt）是自实现，丢早前轮次与 sessionId 每轮变更均源于此。

### Q3 缺省模型：我们恒传 model 压掉了用户配置【事实】

- zcode 有用户级 `defaultModelSelection` 配置键（provider 配置服务持久化，bundle 多处引用，offset 8280500 附近 provider 配置写入说明）。
- `session/create` 不传 model 时走 zcode 自身缺省解析（用户 `defaultModelSelection` 优先）。
- taiji 侧 `zcode-engine.ts` 恒显式传 model（缺省硬编码 `builtin:bigmodel-coding-plan/GLM-5.3` 兜底），静默压掉用户在 zcode 里的缺省选择；ctxModel 继承被忽略仅 log warn（`zcode-engine.ts:1008` 附近）。pi 与 zcode 模型命名空间不同（`zai-coding-cn/*` vs `builtin:bigmodel-coding-plan/*`），直接映射有漂移风险。

### Q4 worktree：上提到 core 成立，且 pi 侧当前实际未生效【事实 + 推断】

现状机制（全部【事实】）：

- worktree 的创建/patch 收集/常规回收/chat 收口保留/reaper 对账/续聊重建**全部在 core**（`subagent-core/src/execution/worktree/worktree-manager.ts` 及 `run-orchestration.ts` / `chat-rounds.ts` / `finalize-record.ts` 调用点），引擎零参与（zcode 仅把 handle 投影成诊断字段）。
- 能力 gate：`capability-gate.ts:103-110`——`task.worktree` 为真且 `caps.sandbox === "none"` 时同步拒绝；sandbox 位三处镜像声明（pi 引擎类 + manifest = `emulated`，zcode = `none`）。
- 协议 wire 已具备 cwd 通道：SDK `RunContextParams.cwd` 存在，`remote-engine.ts:374` `ctx.cwd = task.cwd ?? process.cwd()`；两引擎 run 均写 `task.cwd ?? process.cwd()`（`pi-engine.ts:194` / `zcode-engine.ts:310`）。

断链证据（两处，【事实】）：

1. **core 从不把 worktree path 写进 cwd**：全仓 `handle.path` / `worktreeHandle.path` 消费点只有 worktree-manager 自身 git 操作与诊断投影，无任何 `cwd: handle.path` 赋值。
2. **两引擎 server 都不还原 `ctx.cwd`**：`pi-subagent-cli/src/server.ts` 与 `zcode-subagent-cli/src/server.ts` 的 fullTask 还原都只有 `ctx.model`（`...(ctx.model !== undefined ? { model: ctx.model } : {})`）；pi 的 server 测试还显式断言 task 不含 cwd。

【推断】（静态断链推出，证据充分）：pi 协议化后 worktree 任务实际未把子进程放进 worktree——spawn cwd 落回引擎 CLI 进程 cwd（主仓），collectPatch 对空 worktree 恒产出空 patch。即 **pi 的 `sandbox: "emulated"` 声明与实际行为不符，worktree 参数在两引擎上当前都不可用**（pi 静默失效，zcode 被 gate 拒绝）。→ **已定级为确认 bug 并修复**（cwd 传导三跳 + reaper pid 连带缺口，见 R2 进展）。

「上提到 core」的影响面：core 组装点（`run-orchestration.ts` 的 `taskSpecWithModel`，runAndFinalize 与 chat 轮共用单源）解析 handle → `cwd: handle.path`；两引擎 server 各补一行 `ctx.cwd` 还原（+ 对应 server 测试断言翻转）；capability-gate 的 worktree 判据退役或改判「core 层能力恒放行」；manifest/引擎类 sandbox 位统一调整。zcode 常驻进程不受影响：进程 cwd 恒为 engineDataDir 是设计使然，任务级工作区走 `session/create` 的 `workspacePath`（已吃 `task.cwd`，`zcode-engine.ts:1377-1379`），续聊重建每轮 create 新 session 天然跟随新 cwd。残余风险【推断】：同一常驻 app-server 并发多 workspacePath 的服务端隔离行为未验证。

### Q5 schemaEnforcement：上游无原生强制通道，有半原生路径【事实】

否定性证据：

- `session/create`（offset 464300 附近）与 `workspace/generateText`（offset 472219）strict schema 均无 responseFormat / outputSchema 类参数。
- MCP 工具注册时 outputSchema 被硬编码信封常量替换（`GWi`，offset 9377316：统一的 content/structuredContent/isError 信封）——server 自带 outputSchema 不透传给模型、不做输出校验。
- 引擎内部 provider 层存在 `response_format: {type:"json_schema"}` 支持（offset 5377500，OpenAI-compatible adapter），但无 RPC 参数可触达。

可行路径（按推荐度）：

1. **MCP 提交工具**：本地 MCP server 注册 `submit_result` 类工具，inputSchema 即目标 schema（inputSchema 正常透传给模型），工具端校验失败返回纠错信息逼重试。注入通道：`session/create` 的 `mcpServers` 参数（协议形态 stdio/http，`isolation: "session"` 支持会话级隔离）或 plugin 声明。
2. **Stop hook 校验兜底**：Stop hook 收 `last_assistant_message`，校验失败 `decision:"block"` 强制续跑——上游硬上限 **3 次**（`ZJi=3`，offset 9776948），只适合作兜底。

### Q6 personaInjection：subagent 场景有原生通道【事实】

- **agent Markdown** 是上游原生 systemPrompt 通道：`~/.zcode/agents/` 与 `<project>/.zcode/agents/` 及 plugin `agents/` 目录（offset 10740375 发现逻辑）；frontmatter（name/description/modelSelection/tools/skills/mcpServers 等）+ 正文，**正文即 profile.systemPrompt**（offset 9195183 解析 / 9699400 装配），进系统提示的 "Subagent Agent Prompt" 段（offset 9384874）。调用侧经 `subagent_type` 选 profile，Agent 工具入参不能直接传 systemPrompt。
- hooks（7 事件：SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop）的输出 schema 无 systemPrompt 字段；`additionalContext` 落点是会话历史的 `hook_context` 合成条目（offset 9776300），不是 system prompt。
- 独立 `session/create` 主会话**没有 systemPrompt 参数**（strict schema 穷举核实）。
- plugin 体系为纯声明式（manifest `.zcode-plugin/plugin.json`；可贡献 agent/command/skill/hook/mcp 五类组件；「代码」只能以 MCP server 子进程形态运行，无进程内 JS API）。

结论：taiji 的 subagent 会话若经主会话 Agent 工具派发，persona 可落 agent Markdown 一次声明零运行时代码；taiji 现形态（每任务独立 create）则无严格 system prompt 通道，最接近的是 AGENTS.md（meta-user 指令段）或 SessionStart hook 注入——均非 system prompt 正文。是否切换取决于对「严格 system prompt」的要求程度。

### Q7 fork：RPC 存在，内存态限定【事实】

`session/fork` handler（`z8n`，offset 11126590）：

- `cu(e, sessionId)` 直查内存 Map——**只能 fork 当前 app-server 进程内的活跃会话**，不回源持久层；
- 乐观锁 `expectedRevision` 校验 + 运行中不可 fork（"Cannot fork while a prompt is running"）；
- `forkFromCheckpoint({targetCheckpointId, targetMessageId})` copy-on-write 分叉，继承 mode/model/thoughtLevel；
- 产物为 kind `"inherit"` 的新活跃 record（`sessions.set` 热装载），taskType 继承原值。

read-only 守卫判据是 `taskType === "subagent_child"`（两处：send/snapshot 路径 offset 11121100、sessionStore 层 offset 11261300），**不是 parentSessionId**——host 会话 fork 出的子会话仍可正常 send。

对 taiji 的含义：taiji 的 zcode 会话为顶层 create（非 subagent_child），fork 通道对「从某个 checkpoint 重开」可用；但内存态限定意味着跨 app-server 代（进程重启后）不可 fork，持久化历史只能走 `session/resume`。taiji 现行 forkSource 参数对 zcode 被 fork-from 守卫拒绝（引导 message），引擎本就未接。

### Q8 thinking 直播流：非底层限制，四层断点在中间层【事实】

分层结论（pi / zcode 分别）：

| 层 | pi | zcode |
|---|---|---|
| 产生 | ✓ `spawn-args.ts:160-166` 产出 `thinking_delta`，`event-adapter.ts:158-165` 翻译 | ✓ `session-channel.ts:1011-1013` `reasoning_delta` 分流，`zcode-engine.ts:468` 回调 → `ctx.onEvent({type:"thinking_delta"})` |
| 转发 | ✗ `relay-tee.ts:155-197` message case 只处理 text_delta，thinking 静默落 `return`（无分支无注释）；widget 腿 stream 通道只放行 text（`spawn-event-translator.ts:207` 仅 `text_delta` 进 `onDelta`） | ✗ GUI 直播帧对 zcode 无生产者（app-server 直连不经 relay；widget 腿在 relay 激活时退役）；thinking 只进 journal 落盘（`execution-record.ts:305-308` 流式累积进 turn.thinking） |
| 广播 | ✗ `subagent.stream_delta` 帧 payload 仅 `lines: string[]`（`shared/src/protocol.ts:1535-1538`），无 thinking 位置；无 subagent.thinking 类帧 | 同左 |
| 消费 | ✗ renderer `stores/subagent.ts:315-342` 只消费 lines；主会话 thinking 渲染链完整存在（`registry.ts:574` effect 证明能力在，subagent 分区无数据源） | 同左 |

打通 pi 侧最小改动在转发层 + 帧协议 + 消费层三处（tee 加分支、帧 payload 加 thinking 载荷字段、renderer 补消费）。zcode 侧需先建设 GUI 直播帧生产者（设计文档 `zcode-engine-appserver-resident.md:65` 已登记为「可复制未建设」）；若只要求「能看到 thinking」，最小成本走既有拉取腿（journal 重放投影已含 thinking 位，`session-view-service.ts:336-337`）。

## 2. 缺陷与差距登记

### A. 确认缺陷，可修

| # | 项 | 锚点 |
|---|---|---|
| A1 | `reopenRecord` 硬编码 `engine:"pi"`——zcode record 锚失效后 message 续聊走无世代推进降级；底层 `markReopenedImpl` 已支持 zcode 锚（zcodeAnchorBasePath），宿主闭包没接线 | `chat-rounds.ts:639` / `record-store-terminal.ts:399-404` / `conversation-continuation.ts:899-905` |
| A2 | 死常量 `ZCODE_APPSERVER_TURN_DEFAULT_TIMEOUT_MS`（300s 墙钟修复后无消费方） | `constants.ts:94` |
| A3 | ctxModel 继承被忽略 + 恒显式传 model 压掉用户 `defaultModelSelection`（见 Q3） | `zcode-engine.ts:1008-1018` |
| A4 | fork-from 拒绝文案对 zcode 有事实性偏差（说「never started / transcript collected」不属实） | `subagent-actions-core.ts:703` |
| A5 | ~~**pi worktree 实际未生效**~~：**已修复**——cwd 传导三跳补齐（`withWorktreeCwd` 合流 + wire additive + 两引擎 server 还原）+ reaper pid 连带缺口（create/reconstruct 直接写宿主 pid，见 R2） | `run-orchestration.ts` / `remote-engine.ts` / 两引擎 `server.ts` / `worktree-manager.ts` |
| A6 | thinking 直播流断点（见 Q8）：pi 三层缺口 + zcode 无 GUI 生产者 | 见 Q8 表 |

### B. 设计取舍构成的体验差异（改造需独立立项）

| # | 项 | 现状 |
|---|---|---|
| B1 | cold 续聊 24k token 预算裁剪（保尾丢旧 + sessionId 每轮变更）——可被 native resume 方案整体替换（见 R3） | `ZCODE_RESUME_HISTORY_TOKEN_BUDGET = 24_000` |
| B2 | schemaEnforcement = prompt 约定 + 容错提取（半原生升级路径见 R7） | — |
| B3 | personaInjection = 拼 prompt 正文（原生通道评估见 R8） | — |
| B4 | zcode GUI 直播帧生产者未建设（设计文档已登记） | `zcode-engine-appserver-resident.md:65` |
| B5 | maxTurns=false（上游无 turn 语义，同步拒是正确行为，维持） | — |

### C. 上游约束（本仓修不了）

- steer：send-while-running 恒 -32010。
- 无 taskType RPC、无删除会话 RPC（已由会话库隔离 + TTL sweep 绕开）。
- MCP outputSchema 不透传；独立会话无 systemPrompt 参数。

### D. 已修复（勿重复立项）

300s 墙钟误杀（现为 idle 30min + 总上界 + transient 重试）；GUI 侧边栏污染（会话库隔离 + 白名单 + TTL sweep）；stderr 取证（per-pid tee + 轮转）。

## 3. 改造需求清单

优先级口径：P1 = 正确性/已坏功能修复；P2 = 体验补齐（小中改）；P3 = 立项评估（需独立 tech-design）。

### R1 [P1] reopenRecord 按 engine 分派（A1）

- 动机：zcode 续聊数据一致性——锚失效重开应走世代推进完整链，底层已支持。
- 验收：zcode record 锚失效场景下 message 重开，round 归零 + epoch 推进与 pi 同构；单测覆盖 zcode 锚分支。
- 影响面：`chat-rounds.ts` 单闭包 + 单测（约 30 行）。无依赖。

### R2 [P1] worktree 能力上提 core（A5 + Q4）——**cwd 传导部分已修复**

- 动机：① 修复 pi worktree 静默失效（当前是「假支持」）；② zcode 解锁 worktree；③ 能力位收敛为 core 层单一事实。
- **已落地（pi worktree 断链修复）**：core 侧 `run-orchestration.ts` 新增 `withWorktreeCwd`（taskSpecWithModel 单源合流——`WorktreeHandle.path` → `task.cwd`，worktree 优先于显式 cwd）；wire 收敛为「有值才上 `ctx.cwd`」（`remote-engine.ts` additive，`RunContextParams.cwd` 改 optional）；pi/zcode 两引擎 server 补 `ctx.cwd` additive 还原；连带修复 reaper 误删缺口——worktree 注册表条目 pid 从「0 占位 + 子进程补全（补全链已随 inproc 引擎删除）」改为直接写宿主进程 pid（create 与 reconstruct 两处），孤儿判据锚定宿主死活。端到端锚点：protocol-e2e 的 fake-pi cwd 探针（wire ctx.cwd → 引擎还原 → 子进程 spawn cwd 三跳互证）。
- **剩余（gate 位调整）**：capability-gate 的 worktree 判据退役/改判、manifest 与引擎类 sandbox 位统一（zcode 从 none 升 emulated 或摘除判据）、pi 真机 `worktree: true` 任务验证 patch 非空。
- 验收（剩余部分）：zcode 任务带 worktree 不再被 gate 拒且 `session/create` workspacePath = worktree 路径；worktree 清理链（finalize/reaper/reconstruct）行为不变。
- 影响面（剩余部分）：`capability-gate.ts` + 测试 / 两引擎类与 manifest 的 sandbox 位 / 本文档与 `docs/architecture/subagent-engine-protocolization.md` 能力位表（cwd 行已补）。

### R3 [P1→P3] zcode 续聊升 native（session/resume 替换 cold 注入）（B1 + Q2）

- 动机：消除 24k 裁剪丢轮次 + sessionId 每轮变更两个体验差距；上游 resume 全量热装载已核实可行，-32031 不构成障碍（模型可用自动解除）。
- 关键设计点（tech-design 需覆盖）：续聊时序（record 锚 → 隔离库 sessionId → resume RPC）；app-server 代际变更（进程重启后 resume 跨代——resume 从 sqlite 回源，可恢复）；与 R1 的锚生命周期衔接；cold 路径保留为降级通道（resume 失败/记录缺失时）还是整体退役；journal/entry 投影兼容（resume 后 read 的事件回流）。
- 验收：长对话（超 24k token）续聊不丢早前轮次；重开详情页历史完整；app-server 重启后续聊仍可恢复。
- 影响面：`zcode-engine.ts` 续聊链 / `session-channel.ts`（resume RPC 接线）/ 锚与 record 持久化。量级大，需独立设计。

### R4 [P2] 缺省模型尊重用户配置（A3 轻量版）

- 动机：用户在 zcode 配置的 `defaultModelSelection` 应被尊重；ctxModel 降档应可见。
- 内容：create 不传 model（让 zcode 走自身缺省解析），或在 taiji 侧读用户配置映射；ctxModel 忽略时的 warn 升级为 GUI 可见提示（模型 id 同名匹配探测命中才继承为可选增强）。
- 验收：zcode 侧配置过缺省模型的用户，subagent 模型与之相符；ctxModel 不被继承时 GUI 有可见提示。
- 影响面：`zcode-engine.ts` 模型解析段。涉产品决策（是否做 pi↔zcode 模型映射）。

### R5 [P2] 清理三小项（A2 + A4）

- 删死常量 `ZCODE_APPSERVER_TURN_DEFAULT_TIMEOUT_MS`（核对 launcher 双源注释）；fork-from 拒绝文案按 `record.engine` 分流（对有 sqlite 历史的 zcode record 给准确理由）。
- 验收：全仓无该常量引用；zcode record fork-from 拒绝文案描述与事实相符。

### R6 [P2] subagent thinking 直播流打通——pi 侧（A6 前半）

- 动机：thinking 已产出但三层丢弃；主会话渲染能力已存在，只缺 subagent 分区数据链。
- 内容：`relay-tee.ts` consumeEvent 加 `message.thinking_delta` 分支；`subagent.stream_delta` payload 增 thinking 载荷字段（additive，`shared/protocol.ts` + outbound 帧注册表同步）；renderer `stores/subagent.ts` 补 thinking 应用（复用主会话 thinking block effect 路线）。
- 验收：pi subagent 运行中 GUI 直播视图可见 thinking 流；终态/重开与 live 一致（live ≡ reload 口径）。
- 影响面：runtime relay 层 / shared 协议 / renderer subagent store。帧协议变更为 additive，向后兼容。

### R7 [P3] schemaEnforcement 升级：MCP 提交工具 + Stop hook 兜底（B2 + Q5）

- 动机：prompt 约定的结构化输出可靠性低；上游虽无强制通道，但 MCP inputSchema 透传 + Stop hook 3 次续跑可组成高可靠方案。
- 关键设计点：本地 MCP server 形态与 `isolation:"session"` 生命周期；工具端校验/纠错重试协议；与现有 ajv 容错提取的衔接（先兜底后切换）。
- 验收：结构化任务的成功率相对 prompt 约定显著提升（用既有 structured-output 测试口径对比）；失败路径有明确错误。
- 影响面：新 MCP server 组件 + zcode 引擎 create 参数注入。

### R8 [P3] personaInjection 通道评估（B3 + Q6）

- 动机：persona 拼 prompt 正文占用用户上下文且权重弱。
- 关键设计点：taiji subagent 形态（独立 create）下 agent Markdown 不可直达（subagent_type 属于主会话 Agent 工具语义）——评估切换价值：① 维持拼 prompt；② AGENTS.md meta-user 段；③ SessionStart hook 注入。若未来 taiji 改经主会话 Agent 工具派发，则 agent Markdown 一次声明零代码。
- 验收：决策记录（选型 + 理由）即可，本项为评估不强制落地。

### R9 [P3] zcode GUI 直播帧生产者建设（B4 + A6 后半）

- 动机：zcode subagent 在 GUI 无逐字直播（设计文档已登记「可复制未建设」）。
- 关键设计点：launcher/通道层复制 pi relay 模式，或撤 widget 腿退役条件的引擎无关化；与 R6 的帧扩展协同（thinking 载荷一次到位）。
- 验收：zcode subagent 运行中 GUI 直播视图有逐字流（text + thinking）。
- 依赖：建议与 R6 同一设计文档内统筹（帧协议一次定形）。

### R10 [P3] fork 通道接入评估（Q7）

- 动机：`session/fork` 的 checkpoint 分叉能力可支撑「从某轮重开」场景；但内存态限定使跨代不可 fork。
- 关键设计点：与 R3（native resume）的分工——resume 管跨代恢复、fork 管进程内 checkpoint 分叉；持久化历史无 fork 通道时 forkSource 对 zcode 维持拒绝（文案由 R5 修正）。
- 验收：决策记录即可。

## 4. 实施顺序建议

1. **R5 + R1**（小改，先行清账：死常量/文案/reopen 分派）；
2. **R2**（cwd 传导已落地；剩余 = gate 位调整 + pi 真机 patch 非空验证——修复「假支持」是正确性问题）；
3. **R4**（轻量体验补齐）；
4. **R6 + R9 合并设计**（帧协议一次定形，pi 落地先行、zcode 生产者随后）；
5. **R3**（大改，独立 tech-design；与 R1 锚生命周期衔接）；
6. **R7 / R8 / R10**（评估与立项，按产品优先级排期）。

## 5. 未核实清单（诚实边界）

- ~~A5「pi worktree 实际未生效」~~：已确认 bug 并修复（静态断链 + 修复后全测试绿 + protocol-e2e cwd 探针端到端锚定）；pi 真机 `worktree: true` 任务的 patch 非空验证仍待做（R2 剩余）。
- restoreWarning 的构造点未定位（消费/清除语义已核实；推断为 resume 后模型解析失败时设置）。
- 同一常驻 app-server 并发多 workspacePath 的服务端隔离行为未验证（R2 残余风险）。
- zcode 版本升级（bundle 偏移失效）后，Q1/Q2/Q5/Q6/Q7 的上游结论需按锚点字符串重验。
