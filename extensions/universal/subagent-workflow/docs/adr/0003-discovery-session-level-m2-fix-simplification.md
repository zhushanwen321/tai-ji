# ADR-0003: 发现对齐 skill 节奏 + M2 传递链修复 + 机制精简

**状态**: Accepted
**日期**: 2026-08-08
**关联**: ADR-0002（agentRef 路径统一）、agent-ref-v3-refinement（实施计划 /tmp）
**前置**: ADR-0002 确立了「资源引用 = 绝对路径」的终态。本 ADR 不改该决策，只补强其**实现质量**（修一个继承下来的真实 bug）、**对齐发现节奏**（与 pi skill 一致）、并做一轮**减法精简**（删冗余机制）。

## 背景

ADR-0002 实施后，对照 `fix-workflow-input-agent-md` 分支的 v3 设计文档做交叉验证，发现四处实现差距，其中一处是真实运行时 bug：

1. **M2 传递链 bug（真实，继承自 ADR-0002 前）**：`agent-opts-resolver` 把 agent systemPrompt 与 schema SO 指令各写成临时文件，产出 `systemPromptFiles`（**路径数组**）；`execute-options-mapper` 直接赋给 `appendSystemPrompt`；`session-runner.ts:651` `appendParts.push(...opts.appendSystemPrompt)` 把**路径字符串当文本**拼进最终 append 文件。结果：子进程收到的 `--append-system-prompt` 文件含 `/var/folders/.../agent-prompt-xxx.md` 路径垃圾，schema SO 指令正文从未进入子进程（路径被当文本拼接）；agent 人设经 agentConfig 通道本已正常到达，但伴随路径垃圾冗余（双重注入）。`execute-options-mapper.ts:37` 的注释（「M2: ... 需被 session-runner 消费」）承诺了正确行为，但代码未兑现——典型的「读注释就信、没跑探针」。
2. **发现注入每 turn 重扫**：注入器挂 `before_agent_start`，每 turn 调 `discoverResources` 扫 7 源 + 读全部文件解析 frontmatter。与 pi skill 的 session 级发现节奏不一致，且每 turn 无谓 IO。
3. **info action 冗余**：注入段（name/description/location）+ `read <location>` 脚本文件已覆盖全部信息需求，info 是 read 的子集。
4. **review-fix-loop 路径错误延迟暴露**：`parseAgentRefs` 纯字符串解析，路径错误要到 agent-call 时 `loadByPath` 失败才暴露。

ADR-0002 删 AgentRegistry 快照（loadByPath 路径直读）已消除 v3 原始动机「注入可见、执行 miss」矛盾，故本 ADR 的发现节奏对齐是**性能与一致性优化**，非阻塞项；M2 修复才是阻塞性 bug。

## 决策

### D1: M2 修复——appendSystemPrompt 改内容语义，删 agent/schema 临时文件写入

`agent-opts-resolver` 不再为 agent systemPrompt / schema SO 指令写临时文件，改为直接把**内容字符串** push 进 `appendSystemPrompt`（内容数组）。`session-runner` 的 `appendParts.push(...appendSystemPrompt)` 随之正确消费（内容拼接，非路径）。

从根上消除「路径被当内容」的可能（不再产生路径中间态），而非在下游加路径检测兜底。

**实施修正（R1 design-review 发现）**：原设计是「agent systemPrompt + schema SO 指令都内容直传」。design-review 查证发现 `resolveIdentity`（execution 层）经 `getAgentConfig`（=loadByPath，返回完整 AgentConfig 含 systemPrompt/model/tools/thinkingLevel）+ `resolveModel` **已完整覆盖 agent ref 处理**。若 agent 正文也直传 appendSystemPrompt，会与 resolveIdentity 的 `agentConfig.systemPrompt`（session-runner L646 注入）**双重注入**，还会把层 2 `agentConfig.model` 错误提升为层 1 显式 override。

正确实现（已落地）：`resolveAgentOpts` **删除整个 agent 处理块**，agent ref 整体移交 `resolveIdentity`；`resolveAgentOpts` 只处理 schema SO 指令（内容直传修 M2）+ skill。这同时消除双重注入 + model 层级混乱，连带删除 `state.agentRegistry` 透传链（回归单一 registry 源）。

**M2 影响面修正**：非原描述的「agent 人设 + SO 指令都丢」（agent 人设经 `agentConfig` 通道本就正常），实际是「**schema SO 指令丢失**」（schema 指令经路径垃圾从未进入子进程）。

### D2: 临时文件机制精简（M2 修复连带）

M2 修复后，`activeTempFiles` Set / `cleanupAllTempFiles` / `resolveAgentOpts` 的 `sessionDir`+`activeTempFiles` 参数**全部冗余**，删除：
- `resolveAgentOpts` 签名从 `(opts, agentRegistry, sessionDir, activeTempFiles)` 收敛为 `(opts, agentRegistry)`
- `index.ts` 删 `cleanupAllTempFiles` import 与 `session_shutdown` 调用
- `ports.ts` 的 `activeTempFiles?: Set<string>` 字段删除

保留 `temp-prompt.ts`：`session-runner` 拼好最终 append 内容后仍需落一个文件给 `--append-system-prompt <path>`（pi 该参数接受文件路径），这个机制正确且必要。

### D3: AgentCallOpts 字段统一

`AgentCallOpts.systemPromptFiles: string[]`（路径语义）→ 改为 `appendSystemPrompt: string[]`（内容语义），与 `ExecuteOptions.appendSystemPrompt` 同名同义。`execute-options-mapper` 的「改名映射」降为透传，消除「systemPromptFiles（路径）与 appendSystemPrompt（内容）同义但异名异质」的认知陷阱（M2 bug 的温床正是这个异名异质）。

### D4: 发现注入对齐 skill 节奏（session 级缓存）

`discoverResources`（agents + workflows）从 `before_agent_start` 移到 `session_start`，发现结果按 session 缓存；`before_agent_start` 仅透传缓存内容渲染注入段；`session_shutdown` 清缓存。刷新节奏与 pi skill 一致（新 session / reload 重新发现）。

实现约束：pi 扩展 API 无 base system-prompt 构建事件，`resources_discover` 只承载 skill/prompt/theme 路径——扩展唯一 system prompt 注入通道是 `before_agent_start`。故「对齐 skill」落点 = **内容层 session 级**（发现一次、session 内稳定），注入通道仍走 `before_agent_start` 透传缓存。

### D5: 砍 info action（减法）

删除 `workflow info` action。理由（修正 v3 前提）：
- v3 砍 info 的前提是「workflow 无结构化参数声明」——**对我们不成立**，内置 workflow 有 `@pi-meta parameters` 结构化声明
- 但 `read <location>` 脚本文件能获取 parameters + usage + phases **全集**，info 的结构化 parameters 是 read 的子集
- 注入段 description 已让模型判断「要不要用」；要用时 read 一次脚本头（几十行）获取完整说明，比 info 结构化返回更全
- 维护成本（actionInfo + gui details + 引导文案 + 测试）> 增量价值

连带删除：`actionInfo` 函数、`WORKFLOW_ACTIONS` 的 `"info"`、`ToolWorkflowDetails` 的 info 分支、tool schema 的 `run/info` 描述、promptGuidelines 的 `workflow info <ref>` 引导（改「参数细节 read `<location>` 脚本文件」）。

### D6: review-fix-loop 启动期 stat fail-fast

review-fix-loop 启动时对每个 batchN/fixAgent 路径做 `fs.stat` 校验，不存在立即 fail-fast 报错（带「check `<available_subagents>` `<location>`」恢复指引）。错误前置到启动期，而非跑到 agent-call 中段才暴露。

### D7: 错误规格三态精确化

统一三类路径错误文案（均带 `<location>` 恢复指引），承载位置与实际文案以代码为准：
- 非绝对路径（agent）→ 承载于 `agent-registry.ts` `loadByPath`（require 时抛）：「`Invalid agent ref: <ref>. Agent refs must be absolute paths to .md files (use <location> from <available_subagents>).`」；`agent-ref.ts` `normalizeRef` 非绝对路径静默返回 null（文案由上层调用方渲染）
- agent 路径不存在/不可读 → 承载于 `agent-registry.ts` `loadByPath`（require 时抛）：「`Agent file not found or unreadable: <path>. Use an absolute path from <available_subagents> <location>.`」
- workflow 路径不存在 → 承载于 `tool-workflow.ts`（run action）：「`Workflow '<name>' not found. Available:\n<suggestions>. Use <location> from <available_workflows> for the absolute .js path.`」；`config-loader.getWorkflowByPath` 不存在静默返回 undefined（文案由上层调用方渲染）

### D8: 文档工艺

ADR-0003 与 `/tmp/agent-ref-v3-refinement.md` 实施计划含：物理数据流图（现状 bug vs 修复后）、待验证检查点用 ⛔（未测）/ ✅（已测）诚实标注、精简清单单列。后续 ADR/设计文档沿用此工艺。

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| M2 在下游加「路径检测」兜底（session-runner 判断 appendSystemPrompt 项是否为路径） | 治标——根因是路径作为中间态存在；D1 删中间态才是治本 |
| 保留 info，增强它返回 parameters + usage | read 已覆盖全集；增强 info 反而增加维护面，与减法方向相悖 |
| 发现缓存用 TTL（如 60s）而非 session 级 | skill 是 session 级，对齐 skill 更一致；TTL 引入「同 session 内不同 turn 看到不同列表」的不一致 |
| D3 保留 systemPromptFiles 名字只改语义 | 异名（systemPromptFiles vs appendSystemPrompt）是 M2 bug 的认知温床，同名同义才根治 |

## 影响

- **删除**：`cleanupAllTempFiles`、`activeTempFiles` 相关接线、`AgentCallOpts.systemPromptFiles` 字段、`actionInfo` + info 整条 action、resolveAgentOpts 的 sessionDir/activeTempFiles 参数
- **修改**：agent-opts-resolver（内容直传）、execute-options-mapper（透传）、session-runner（消费不变，但输入语义正确）、两个注入器（session 级缓存）、review-fix-loop（启动期 stat）、tool-workflow（删 info + 引导文案）、错误文案统一
- **破坏性**：`workflow info` action 移除（模型若仍调用会报 unknown action）；appendSystemPrompt 语义从路径变内容（内部接口，无外部消费者）
- **验证门槛**：M2 必须有探针测试（复刻 v3 的 m2-chain-probe 思路）断言 append 内容无路径残留；session 级发现必须有「同 session 多 turn 不重扫」断言
