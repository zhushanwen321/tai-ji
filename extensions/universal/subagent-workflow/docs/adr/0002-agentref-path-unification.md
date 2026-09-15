# ADR-0002: agentRef/workflowRef 统一为绝对路径引用

**状态**: Accepted
**日期**: 2026-08-08
**关联**: ADR-0001（资源暴露重构）、ADR-031（统一资源发现）、agent-ref-path-redesign（设计文档 /tmp）

## 背景

ADR-0001 重构后，agent 指定仍存在「内置模板名」与「外部 md 路径」二元区分：
- 内置 agent（`reviewer`/`worker` 等）经 AgentRegistry 按名查找（cache Map<name>）
- 自定义 agent 经 review-fix-loop 的 `loadAgentMd` 脚本层 fs 读文件（绕开 registry）

workflow 同理：内置 workflow 按名注册，任意路径 .js 无执行通道。

**二元区分是假抽象**：内置模板就是包内 `agents/*.md` 物理文件，只是被注册表按文件名映射成短名。映射引入三处成本：
- 解析特判（resolveAgentDefs 三态：名/路径/fallow 常量）
- 查错兜底（`review-` 前缀重试机制）
- 维护同步（新增内置 agent 多处登记）

## 决策

**资源引用唯一形态 = 绝对路径**（`.md` for agent，`.js` for workflow），名字仅作注入段展示标签：

1. **注入段对齐 pi skill 的 `<location>` 格式**：`<agent>/<workflow>` 每项带完整路径，模型直接引用，无需名字查找
2. **subagent tool `agent` 参数 / workflow tool `run|info` 的 `name` 参数 = 路径引用**，执行任意完整地址的 agent.md / workflow.js
3. **AgentRegistry 收敛为 `loadByPath`**（mtime 缓存 + W4 lint）；删按名 cache、`discoverAll`、`BuiltinAgentRegistry` 合并（内置文件由统一发现层 npm 源覆盖，注入段数据源与执行解析分离）
4. **WorkflowScriptRegistry 新增 `getPath`**：任意路径 .js 读文件 + lint + 执行；`get(name)` 仅保留给 workflow-script tool 的 tmp 脚本管理
5. **agent 内容加载收敛到主线程** `resolveAgentOpts`（agent-call 时按路径读 md → systemPrompt 临时文件 + frontmatter model/tools/thinkingLevel 传播）；worker 脚本不再 fs 读 agent 文件（review-fix-loop 的 `loadAgentMd`/`parseAgentMd` 退役，def 只含 path/name/report/title 标识）
6. **内置编排 workflow 阶段执行者参数化**：chain/parallel/scatter-gather/map-reduce 新增 `agents` 参数（逗号分隔 agentRef，按阶段映射；缺省 = 默认执行者）；review-fix-loop 的 `batchN`/`fixAgent` 值域 = agentRef 路径，`fallow-scan` 移出 batchN 改独立 `fallowScan: boolean` 参数（fallow 是工具不是 agent，脚本内部保留字前置插入首批）

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 保留名字查找 + 路径特判并存 | 二元区分的假抽象继续存在，解析/兜底/维护三处成本不减 |
| 相对路径引用 | 相对谁无定义；注入段给绝对路径，模型照抄零歧义 |
| fallow-scan 保留在 batchN 值域 | 破坏「batchN 全部为路径」的统一性；工具与 agent 混用一值域 |

## 取舍边界

1. **阶段 schema 不开放**：chain/parallel 等阶段间数据传递依赖固定 schema，agents 参数只换执行者，不换输出契约（自定义 agent 收到 structured-output schema 要求，输出不匹配 soft-fail 可见）
2. **名字保留为展示标签**：注入段 `<name>`、report 文件名派生（路径 basename）、record 显示
3. **安全**：任意路径执行是需求（用户明确）；保留文件存在性校验 + workflow lintScript；不做路径白名单
4. **eval worker 的 require 锚定**：沙箱 eval 模式下相对 require 以 cwd 为基准，内置 workflow 的共享模块（`workflows/_shared/agent-refs.cjs`）必须用 `workerData.scriptPath` 锚定脚本目录

## 影响

- **删除**：`AgentRegistry.get/discoverAll/list`、`BuiltinAgentRegistry`、`createPackageBuiltinRegistry`、review-fix-loop 的 `loadAgentMd`/`parseAgentMd`/`shouldRetryWithReviewPrefix`/`validateFallowScan`
- **新增**：`shared/agent-ref.ts`（normalizeRef）、`workflows/_shared/agent-refs.cjs`（worker 侧解析）、`WorkflowScriptRegistry.getPath`
- **语义变更**：subagent/workflow 工具参数值域从名字变为路径；注入段加 `<location>`
- **破坏性**：存量以名字调用的模型会话需改用注入段 location（用户明确不考虑兼容）

---

**实施完善**：见 [ADR-0003](0003-discovery-session-level-m2-fix-simplification.md)（发现对齐 skill 节奏 + M2 传递链修复 + 临时文件机制精简 + info 减法）。ADR-0002 确立的「路径统一」决策不变，ADR-0003 补强其实现质量并做减法精简。
