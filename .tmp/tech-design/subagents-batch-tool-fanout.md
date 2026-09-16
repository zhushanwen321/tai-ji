# subagents 批量编排 tool + fan-out 模板 + collect 退役 技术方案

> **一句话结论**：新增独立的 `subagents` 批量 tool（subagent 语义族命名蹭模型训练先验，schema 一跳扁平），底层把参数转译后交给现有 `runWorkflow` 管道执行新增的内置模板 `fan-out.js`；随后完整退役 `subagent` tool 的 `collect` 参数与 sync 批机制——行为接口留在模型爱用的 subagent 形态，执行机制统一收敛到 workflow 单管道。

> **层声明**：当前层 = 技术方案（工具行为面 + 执行机制），下一层 = 可实现接口（tool schema、模板脚本、handler 转译规则、退役清单）。§3 按接口先行 + 错误规格展开，不跨到实现代码层。

> **功能分级与风险**：触及 P0（`docs/FEATURE-PRIORITIES.md`：subagent/workflow 派发面与 subagent-workflow extension 均 P0，2026-09-12 用户裁决）。风险分 = P0 基数 9 + 存量数据兼容修正 1（collect 退役后磁盘上存量 `batchFinalized` entry 的读侧容忍）= **10**。审查分组按 ≥7 独享深度审执行。

---

## 1. 背景目标

**SCQA**：
- **S（情境）**：taiji 的 agent 派发有两个工具面：`subagent` tool 管理单个可持续会话实体（start/message/close/fork-from），`workflow` tool 跑一次性编排 run（内置 chain / parallel / map-reduce / scatter-gather / review-fix-loop 五个模板）。主 agent 需要「N 个独立子任务并行跑、结果收齐一起处理」时，现役手段是 `subagent` 的 `collect:"sync"` 参数。
- **C（复杂化）**：`collect:"sync"` 存在结构性语义缺陷（批协调状态纯内存、批闭合依赖成员集合完整 settle、无聚合、依赖链不可表达），2026-09-16 真实会话中两轮派发全军覆没且批量通知迟到 40 分钟（§2.2 详述）。而能解决这些缺陷的 workflow 管道，实测中 LLM 几乎不会主动使用——模型倾向直接发 N 个 `subagent start`，训练先验里没有「用自定义 workflow 工具派活」这个动作。
- **Q（问题）**：如何在模型**愿意调用**的工具形态下，提供**工程上可靠**的批量编排能力，并让 collect 的缺陷面整体退役？
- **A（答案）**：行为接口与执行机制解耦——新增 `subagents` 批量 tool（模型爱用的 subagent 形态）作为唯一批量入口，底层一行转译到 `runWorkflow("fan-out")`（workflow 可靠管道）；collect 全量退役。

**系统是什么（给不懂内部背景的读者）**：主 agent（LLM）在对话中通过工具调用派发子任务。`subagent` tool 派出的每个子代理是一个**可持续会话实体**：跑完进入 idle，可以继续发消息、可从它 fork 新代理，是「同事」。`workflow` tool 跑的是一个**一次性运行实例**（run）：按模板脚本编排若干一次性的子代理，跑完发一条完成通知即结束，是「批处理作业」。两者底层共享同一套引擎与记录设施，但行为契约不同。

**设计目标**（从使用者体验倒推）：
1. **G1 采纳**：模型在「N 个独立任务并行」场景下会主动选择批量入口——不需要用户点名，行为与今天爱用 `subagent start` 一致。
2. **G2 可靠**：批量运行有一等实体（runId、状态落盘、status/abort），任一成员失败不炸全局、不吞通知；运行结束主 agent 一次性收到全部结果。
3. **G3 收敛**：`collect:"sync"` 语义与实现完整退役，批量编排只有一个执行管道（runWorkflow），不存在第二套批机制。

**In scope**：`subagents` 批量 tool（schema + handler + 注册 + GUI/TUI 渲染接线）、内置模板 `fan-out.js`、注入面导流文案、collect 全量退役（schema/core/config/测试/文档）、存量数据读侧兼容。
**Out of scope**：`subagent` tool 的 action 拆分（schema 文件自带 TODO option-A，独立后续）、workflow 成员可续聊化（一次性语义维持）、跨 restart 的 run 恢复（D-9 废弃裁决维持）、per-task model 覆盖（无已发生需求）、relay 瞬断杀链的 runtime 修复（独立线，非本设计可及）、`workflow` tool 自身改造、**批量 tool 的依赖编排**（步骤间依赖场景由 workflow 门面的 chain/map-reduce/review-fix-loop 承接，批量 tool 只做独立并行——§2.2 缺陷 #6 的显式放弃声明）。

---

## 2. 现状与问题分析

### 2.1 使用者（LLM）视角的现状

模型 today 要并行跑三个文档审查任务，有两条路：

**路 A（模型实际会走的）**——三次 `subagent start` + sync 攒批：

```json
subagent { "action":"start", "task":"对设计文档做主审……", "agent":"/path/td-review.md", "collect":"sync", "slug":"td-review-main" }
subagent { "action":"start", "task":"对设计文档做影响面审……", "agent":"/path/td-impact.md", "collect":"sync", "slug":"td-review-impact" }
subagent { "action":"start", "task":"对设计文档做简洁审……", "agent":"/path/td-simplicity.md", "collect":"sync", "slug":"td-review-simplicity" }
```

**路 B（工程上更可靠但模型不走的）**——workflow tool 跑模板。但五个内置模板没有一个对得上「N 个已知独立任务」语义（`map-reduce` 会归约、`parallel` 是多视角分析同一目标、`chain` 是步骤依赖链），模型还要先读 `<available_workflows>` 清单、学模板参数、做语义转译。

### 2.2 失败模式一：collect:"sync" 的结构性缺陷（2026-09-16 事故实证）

2026-09-16 一次真实会话（对设计文档做三路并行审查）完整暴露了缺陷面。派发三个 `collect:"sync"` 成员后：

| # | 现象 | 根因（代码锚点） |
|---|---|---|
| 1 | 两个批次的三成员分别在父回合结束（`agent_end`）后 170ms / 16.5s 被 SIGTERM 全灭 | 直接死因是 runtime relay 层「socket 断 → kill-on-disconnect 连坐」（该层修复独立进行）。但它暴露的是脆弱性：成员活性依赖父进程侧链路 |
| 2 | 批量完成通知黑洞：批次全灭后通知未到，40 分钟后才靠 ledger at-least-once 旧账重放迟到 | 批闭合检测依赖「成员集合完整 settle」；成员被杀的失败 settle 无法可靠触发闭合。批协调状态是**纯内存登记态**——`packages/subagent-core/src/execution/service/sync-collect-domain.ts` 头注释自认「随 session 生命周期消亡、崩溃后不恢复」（E1 崩溃恢复面已退役） |
| 3 | 主 agent 无法及时发现异常 | sync 语义 = 等全部成员到齐才一条通知；慢成员/死成员拖住整批，主 agent 无中间信号 |
| 4 | 恢复路径割裂 | sync 成员不可 message（schema 写明），只能 fork-from；批闭合后成员自动归档不可追加 |
| 5 | 结果形态差 | 批通知把 N 份原文按 `perItemChars/totalChars` 预算截断塞一条消息，无结构化、无聚合 |
| 6 | 依赖链不可表达 | schema 自述「dependent tasks 必须跨消息串行，never batched」——collect 只覆盖独立并行这一种形态 |

**判定**：#1 的杀链归 relay 层修（不在本设计），但 #2-#6 是 collect 自身结构性缺陷，与杀链无关——即使 relay 层修复，这些缺陷仍在。这是废弃 collect 的根本理由。

**六条缺陷在 fan-out 终态的归宿**（防「终态全部修复」误读）：

| # | 归宿 | 说明 |
|---|---|---|
| 1 | 范围外 | relay 杀链独立线修复；本设计的职责边界 = 成员死亡不炸 run 收口（D4） |
| 2 | 修复 | run 收口独立于成员集合：成员死亡走 allSettled → partial，通知照发 |
| 3 | 缓解 | 被动通知仍是全批 settle 一次（run 收口即通知，形态不变）；缓解点 = 主 agent 有了主动恢复通道（status/abort + 恢复出口文案，D3/D7），从「完全无信号」变「可主动查询」 |
| 4 | 修复 | 批量成员一次性语义自洽（workflow record 本体），不再有「同是 subagent 两套规则」割裂 |
| 5 | 修复 | agent() schema 结构化输出 + summary/fullReportPath 指针（D4/D5） |
| 6 | 显式放弃 | fan-out 只覆盖独立并行；依赖链场景由 workflow 门面的 chain/map-reduce/review-fix-loop 承接（§1 Out of scope 补充声明：批量 tool 不做依赖编排，有需求的走 workflow 模板） |

### 2.3 失败模式二：workflow tool 采纳率低（模型先验机理）

实测观察：LLM 倾向不用 `workflow` tool，显著偏爱 `subagent`。机理拆解：

1. **训练先验差量级**：「spawn subagent / Task tool」是主流 agent 产品的训练范式，模型分布里「N 个独立任务 → 派 N 个 subagent」概率质量大；「workflow」在 coding 语境的联想是 CI/CD 流水线（预定义流程、特定场景才用），「用自定义 workflow 工具随手派活」的先验接近零。
2. **Schema 形态信号**：`subagent start` 一跳扁平（task 直接给）；`workflow run` 两跳间接（先查有什么模板 → 再把任务转译成模板参数）。项目自己的 schema 注释记载过教训：「弱模型信任 schema 结构信号 > 文本信号」——参数转译正是弱模型事故高发区（args 平铺事故）。
3. **控制感**：subagent 粒度模型自持（每次 start 一个、随时 message/close）；workflow 一次交出控制权，run 黑盒跑到收口。被 RLHF 过的 coding agent 偏好「保持控制、可见推进」。

**推论**：prompt 导流（注入文案、guidelines）只能在先验附近小幅扭转分布，不能对抗先验。任何把批量入口放在 `workflow` tool 上的方案，采纳率都会重蹈覆辙——这是 §3.2 否决「纯 workflow 门面」方案的直接依据。

### 2.4 根因与目标数据流

根因：**批量编排的行为接口（模型看到并调用的工具形态）与执行机制（批的工程实现）耦合在了一个错误的组合上**——行为接口正确（subagent 形态，模型爱用），执行机制错误（内存批缓冲，脆弱）；而执行机制正确的载体（workflow run），行为接口不被模型选择。

目标数据流（vs 现状）：

```
【现状 collect】
模型 ──N 次 subagent start(collect:sync)──▶ SubagentService 内存批缓冲（CollectCoordinator）
   成员各自跑 ──settle──▶ 批闭合检测（依赖成员集合完整）──▶ markBatchFinalized 落标 ──▶ notifyBatch 一条截断通知
                              ↑ 任一成员死/宿主重启 → 批状态随内存消亡，通知链断裂

【目标 fan-out】
模型 ──1 次 subagents{tasks[]}──▶ handler 转译 ──▶ runWorkflow("fan-out") ──▶ worker 跑模板脚本
                                                                    ├─ parallel() allSettled 派 N 个一次性成员（各自 schema 结构化输出）
                                                                    ├─ 状态快照落盘 workflow-state/<runId>.jsonl（status/abort 可查）
                                                                    └─ run 收口 ──▶ notifyDone（scriptResult 摘要+报告路径 + trace）
```

---

## 3. 解决方案

### 3.1 终态（使用者视角先行）

**成功路径**——同一个三路审查场景，模型的行为：

```
用户：从安全/性能/可维护性三个角度并行审这个模块，汇总给我。

模型调用：
subagents { "tasks": [ "从安全角度分析 packages/foo 模块，列出问题清单，报告写入 .tmp/review-security.md",
                       "从性能角度分析 packages/foo 模块，列出问题清单，报告写入 .tmp/review-perf.md",
                       "从可维护性角度分析 packages/foo 模块，列出问题清单，报告写入 .tmp/review-maint.md" ],
            "agents": "/path/security-reviewer.md",
            "slug": "foo-tri-review" }

tool 返回：
Started batch 'foo-tri-review' (wf-17...) as workflow run 'fan-out' — 3 subagents dispatched in parallel (allSettled).
Results arrive as ONE notification when the run settles. Do NOT poll.
If no notification arrives well past the expected duration, make a SINGLE status check: workflow tool with runId wf-17... (recovery exit, not a poll loop).
To abort: workflow tool, action abort, runId wf-17...

（约 N 分钟后）run 收口，notifyDone 注入主对话：
Workflow 'fan-out' done: ok
--- Script Result ---
{ "status": "ok", "results": [
    { "taskIndex": 0, "task": "从安全角度……", "status": "ok", "summary": "发现 3 个问题：……", "fullReportPath": ".tmp/review-security.md" },
    { "taskIndex": 1, ... }, { "taskIndex": 2, ... } ] }
--- Agent Trace ---
[0] fan-out-0: ok   [1] fan-out-1: ok   [2] fan-out-2: ok

模型：读三份 summary，需要细节时按 fullReportPath 读文件，汇总回复用户。
```

**失败路径与恢复指引**（错误规格详见 §3.3 D9）：

| 失败形态 | 模型看到什么 | 恢复动作 |
|---|---|---|
| 缺 tasks / tasks 空数组 | throw：`tasks is required (non-empty string array). Correct: {"tasks":["...","..."]}` | 按示例补参重试 |
| 部分成员失败 | 通知 status `partial`，results 内该成员标 `failed` + error | 只重派失败任务：再调一次 `subagents`，tasks 只含失败项 |
| 全部成员失败 | run failed，通知带「NOT task completion」收尾指引（既有 TERMINAL_REASONS 机制） | 按 error 诊断后重新派发 |
| agents 数量与 tasks 不匹配（>1 且 ≠N） | 模板入口 fail-fast：run failed，error 带 Correct 示例 | 对齐数量后重派（详见 D9） |
| 模型试图 message 批量成员 | messageHandler 拒绝（workflow-origin record）：`batch members are one-shot; re-dispatch via subagents` | 重派或 fork-from |
| 用户要中途停止 | — | `workflow {action:"abort", runId:<批量 tool 返回的 runId>}` |

**使用者体验对照 §1 目标**：G1——模型调用的是一个名字、形态、描述都在其先验内的 subagent 族工具，一跳扁平无转译；G2——结果经 run 实体收口，成员死亡走 allSettled 变 partial，run 照常通知；G3——同一场景不再存在 collect 路径。

### 3.2 方案对比与裁决

| 方案 | 内容 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|---|
| **X：subagent tool 加批量 action** | `subagent {action:"orchestrate", tasks:[...]}` | 差：schema 文件自背 TODO(option-A)（「勿堆 action 条件逻辑，要加就拆 tool」）是明确技术债标记；action 分发 + 条件必填正是弱模型事故高发区，会话实体管理与一次性运行编排两种概念域继续混杂 | 低（一个 handler） | **9**：schema 复杂度叠加，弱模型误用率上升（平铺/漏参事故形态复发） | 否决 |
| **Y：独立批量 tool + runWorkflow 转译（推荐）** | 新 tool `subagents`，扁平 schema，handler 转 `runWorkflow("fan-out")` | 好：行为接口（subagent 先验）与执行机制（run 管道）解耦且各归其位；批量 tool 与单数 tool 形成「单个 vs 批量」自然分工；执行管道唯一 | 中（新 tool 注册 + 转译 + 模板 + 渲染接线 + collect 退役） | **10**：P0 基数 9 + collect 退役存量数据兼容 +1；主要风险 = 采纳率迁移靠描述工程驱动（非结构保证，不达标预案见 §4.1 S6）+ 退役涉及存量 entry 读侧 | **采用（用户已裁决）** |
| **Z：collect 字段保留、底层重实现** | `collect:"sync"` schema 不变，内部改走 run | 机制上不成立：collect 是 N 次独立 start（首批派发时任务集未集齐），run 需要一次拿到完整任务集，两种调用形态无法映射；保留撒谎 schema 制造语义债 | — | — | 否决（机制不可行，非权衡） |
| **C'：不加 tool，纯 workflow 门面导流** | 不新增工具：新增 fan-out 模板后，靠注入文案把模型从 `subagent start` 引导到 `workflow run fan-out` | 好（执行管道唯一，零新增工具面），但隐含前提是「导流文本能让模型改道」 | 最低 | **9**：被实测击穿——导流文本只是文本信号，对抗的是 §2.3 的先验结构信号，采纳率大概率重蹈 workflow tool 覆辙 | 否决——**被否谱系：C'（纯 workflow 门面）—— 击穿证据：2026-09 真实会话实测 LLM 回避 workflow tool、偏爱 subagent（§2.3），导流文案无法对抗训练先验** |

### 3.3 关键设计与权衡

#### D1：tool 命名与集合收录

- **选择**：tool 名 `subagents`（复数）。集合收录裁决：**只收进 `WORKFLOW_TOOL_NAMES`，不进 `SUBAGENT_TOOL_NAMES`**。
- **理由（基于两集合消费方的全量枚举）**：
  1. `packages/runtime/src/services/session/event-interpreter.ts:1011/1014`——tool-call-end 的 record 失效兜底信号按两集合**分类**判定（两个独立 if）：批量 run 的 record 快照是 `workflow-record` entry（`jsonl-run-store.ts` W17 写点），归 `'workflow-record'` 才正确——`subagents` 进 WORKFLOW 集合恰好命中正确分支。
  2. `packages/core/src/domain/chat/message-turns.ts:700`——turn 层 agentgraph kind 判定为 **SUBAGENT ∪ WORKFLOW 并集**：WORKFLOW 收录即放行 agentgraph 归类。
  3. `packages/ui/src/features/chat/Block.vue:434-435`——**组件挂载层按集合分流**（`isSubagent` / `isWorkflow` 两个独立 computed，非 kind 判定）：`subagents` 单收录 WORKFLOW 后批量块走 **workflow 块分支**（单行 icon + slug，点击 `openWorkflowDrawer`），渲染归宿详见 D8。
  - **被否**：双收录（两集合都进）——event-interpreter 双打 `'subagent-record'` 误触发（批量调用不产生 subagent record，多一次无效失效刷新）+ Block.vue 模板中 isSubagent 分支在前，批量块会被误路由进 BlockSubagent 分支；只进 SUBAGENT——`'workflow-record'` 兜底缺失（主信号丢失时双保险失效，W18 机制的存在意义场景）。单收录 WORKFLOW 是零 runtime 改动的唯一全对解。
- **采纳率继承**：模型选工具看 name + description 与任务的语义匹配；批量先验是语义层的（「并行 spawn agents」），不是字面层的，复数名 + "Spawn multiple subagents" 描述可继承大半先验。与单数 `subagent` 形成「一个会话实体 vs 一批一次性成员」的自然分工，互指导流（D5）是在先验分布内部改道，成本远低于跨范式拉人。
- **被否**：`orchestrate` / `batch` 等命名——零先验，重蹈 workflow 覆辙。
- **命名空间说明**：tool 名 `subagents` 与既有 `/subagents` 命令（`interface/subagents.ts`，list overlay + GUI 定向消息通道）同名不同命名空间（tool vs slash command），无冲突；导流文案与行文注意区分两者。

#### D2：subagents tool schema（接口先行）

一跳扁平，无 action 分发、无 args 嵌套（对照 D2 反面：workflow tool 的 `name`+`args` 两跳）：

```text
subagents:
  tasks         required string[]   N 个完整自包含任务描述（每个元素 = 一条可直接派发的 task prompt）
  agents        optional string     逗号分隔 agent .md 绝对路径；1 个应用于全部成员，N 个与 tasks 一一对应
                                    （缺省 = general-purpose，与 subagent start 同规则）。
                                    数量约束：>1 时必须等于 tasks.length，否则模板入口 fail-fast（见 D9）
  aggregate     optional boolean    default false。true 时末尾追加一个聚合成员，把全部结果归约成一份结论
  slug          optional string     批次标签（跟随 SLUG_MAX_LENGTH SSOT，当前 35）。缺省时 handler 自动生成
                                    fan-out-<时间短码>——受益面 = drawer WorkflowTab run header 与 run
                                    投影名的状态面/列表辨识（spec.slug 层）；对话流块面显示的是模型
                                    input.slug（建议模型提供），handler 生成值无 input 回写通路、不到块面
  model         optional string     run 级模型覆盖 "provider/modelId"（全部成员继承；per-task 覆盖不支持，见边界）
  thinkingLevel optional enum       run 级思考深度覆盖
  tokens        optional number     token 预算（仅用户显式要求时设置；缺省无限制——项目超时默认原则）
  time          optional number     时间预算 ms（同上，入口 fail-fast 上界校验同 workflow tool）
```

**设计约束**：必填性由 schema 真实表达（tasks required），不存在「action 条件必填」妥协；`tasks` 用 typebox 数组——「N 个任务 → tasks 数组」零转译映射，结构信号直给弱模型。`tasks` 不设 maxItems：并发由共享配额池兜底（DefaultConcurrencyPool，默认 maxConcurrent=6，超出自动排队不报错——`subagent-core` execution/assembly/config.ts 默认值，实施期以实装为准），大 N 的排队等待语义由返回文案与收口通知承载。不设 `engine` 参数（无已发生需求；workflow agent() 路由已有三层缺省规则兜底）。不设 per-task model/agent 差异化 model——agents 已覆盖「每路不同审查者」主场景，model 差异化无实证需求，不做推测性功能。

#### D3：handler 转译规则（执行机制单管道）

- **落点**：shell 的 `src/interface/` 新增 `tool-subagents.ts`（与 `tool-workflow.ts` 同层），注册 + `renderCall`/`renderResult`（TUI）走既有 tool 惯例。
- **转译**：全部参数确定性映射 → `runWorkflow({ scriptSource: fanOutScript, args: { tasks, agents, aggregate }, budgetTokens: tokens, budgetTimeMs: time, scriptName: "fan-out", slug, model, thinkingLevel }, deps, signal)`；spec 其余字段（scriptPath/description/parameters 等）随 `tool-workflow.ts:456` 先例逐字段对齐组装（parameters 从 script.meta 拷贝供 chokepoint 校验）。
- **返回**：与 workflow run 同款后台启动文案 + runId + 「results arrive as ONE notification / abort 用 workflow tool / 异常超时做单次 status 查询（恢复出口非轮询）」指引（全文见 §3.1）。
- **复用与不复制**：reentry guard 复用 workflow tool 的 `reentryRef`（同一管道同一守卫，避免双 guard 语义漂移）；status/abort **不复制**，直接指路 workflow tool 现有动作（runId 同体系）。⛔实施期门（已闭合，见 §5 终局结论）：`runWorkflow` await 时长实测——若同步段可感知（>数百 ms），guard 必要性成立；若极快，guard 仍保留（无害且防手误连击）。
- **不透传 worktree/fork**：批量成员是独立一次性计算单元，fork（继承父上下文）与 worktree（文件隔离）在批量语义下均无已发生需求；模板 agent() 不带这两项，未来有真实场景再加参数。

#### D4：fan-out.js 模板

- **语义**：`parallel()`（allSettled）对 tasks 逐个派 `agent()` → 全量收集 → 可选 aggregate。`aggregate:false`（默认）= 纯收集（collect:sync 的等价物）；`true` 时末尾一个 `agent()` 把全部 results 归约成一份结论。
- **参数面**（脚本 `@pi-meta parameters`）：`tasks: string[]`（必填，唯一任务集入口）；`agents: string`（复用 `workflows/_shared/agent-refs.cjs` 的 `parseAgentRefs`/`agentRefAt` 共享导出，按 parallel.js 的 `agentFor` 分配模式实现「1 → 全部、N → 一一对应」；**与 parallel 的静默 fallback 不同，本模板对 `agents.length > 1 且 ≠ tasks.length` 入口 fail-fast**——弱模型数量错配高发，静默换 persona 会让失败归因失真）；`aggregate: boolean = false`。
  - **被否谱系：`tasksJson` 参数（文件路径二选一）—— 砍除依据：map-reduce 的 itemsJson 约定服务的是 CLI 直参场景（命令行传大数组不便），LLM tool call 侧已发生需求方为零（§1/§2/§4 全部场景 tasks 均为直接数组）；多一个可选参数即多一分误用面（都传/都缺的歧义形态）。等首个真实场景出现再加，届时一致性论据即转为第二个真实采用者**
- **每成员输出 schema**（agent() 结构化输出，权威 schema 即参数）：

```json
{ "type": "object",
  "properties": {
    "summary":   { "type": "string", "description": "结果摘要（数百字内），通知内联展示" },
    "fullReportPath": { "type": "string", "description": "可选：完整产物的落盘路径（报告类任务建议写入文件）" } },
  "required": ["summary"] }
```

- **taskIndex 赋值权威**：结果关联序号由**模板按派发序（`$ARGS.tasks` 下标）赋值**，不采信成员自报（schema 不含 taskIndex 字段，成员无从错报）；`results[].task` 文本同样以 `$ARGS.tasks` 为权威源——「只重派失败任务」的归因不会因成员输出错位而错杀。
- **outcome 形状**（脚本 return，即通知里的 scriptResult）：`{ status: "ok"|"partial", results: [{ task, taskIndex, status: "ok"|"failed", summary?, fullReportPath?, error? }], aggregate? }`——无 "error" 枚举值：全员失败经 throw 表达（run failed，见失败语义行），不以 outcome return。
- **失败语义**：对齐 parallel.js——全部失败 throw（run failed）；部分失败 partial。成员死亡（SIGTERM/引擎崩溃）走 allSettled 的 failed 分支，**不阻断其余成员、不阻断 run 收口**——这是对 collect 批闭合缺陷（§2.2 #2）的构造性修复。aggregate 成员失败（含返回缺 conclusion 字段）同样**不炸 run**——status 降 partial、`outcome.aggregate` 携带 `{error}`（缺 conclusion 时为该形态的兜底），已收集 results 照常收口（G2「成员失败不炸 run」对归约成员的直接延伸；实施 u1 固化，测试锁定于 fan-out-script 单测）。

#### D5：通知体积与注入面导流

- **通知体积**：机制不动（`MAX_RESULT_LENGTH` 8000 字符保持）。体积控制靠 D4 的 schema 约定：summary 内联（数百字）、完整产物落盘走 `fullReportPath` 指针。N 大（>6）时 summary 总量也可能触界——模板在 results 序列化前按序截断保 taskIndex/status 完整，截断行为写入 outcome 顶层 `truncated: true` 标记。⛔实施期门（已闭合，见 §5 终局结论）：以 6 任务 × 500 字 summary 实测通知体积，断言截断发生时 `truncated:true` 存在且 taskIndex/status 字段完整；触界则收紧 summary description 字数指引。
- **注入导流**（三处，全部同 commit）：
  1. 单数 `subagent` tool：start action/task description 与 tool description 加分工句——「2+ independent tasks in one dispatch → use the `subagents` tool」（实施核实：该 tool 无 promptGuidelines 数组，落点为 description 各处）；collect 字段随退役删除，描述同步清理。
  2. `subagents` tool description：明确「one-shot batch members（不可 message/续聊），results arrive as one notification」；slug 参数引导模型提供批次标签（「shown on the conversation block and run list — provide a short label for multi-batch scenarios」，缺省生成值仅作用于状态面不到块面）。
  3. workflow-list 注入器：fan-out 模板条目带 when/notFor（review-fix-loop 已有此元数据先例）。**文案须宿主中立**：fan-out.js 与既有五模板同目录，zsw 宿主清单注入会同样发现它（双宿主共享），「`subagents` tool 的执行体」这类 pi 壳专属表述放附加句，主体用「N 个已知独立任务并行 + 全量收集（可选归约）」的宿主中立描述。

#### D6：collect 退役

| 层 | 退役内容 |
|---|---|
| schema/壳 | `subagent-tool-schema.ts` 删 collect 字段；startHandler 删 collect 解析与路由；`subagent-tool.ts` route 接线清理。（组合根侧 `recoverSyncCollectBatch` 调用点已随 modeless 波5 摘除——`session-lifecycle.ts` 头注核实，仅剩 core 侧 no-op 方法本体随下行动作删除） |
| core | `CollectCoordinator`、`SyncCollectDomain`（域 #5 整体）、E9 `convertPendingSyncBufferToAsync`、`store.markBatchFinalized` 写侧（U3 原语）、`sync-rebuild.ts` 缓冲快照兜底、`notifyBatch` + `BatchBudgetParams` + ledger sync-batch 幂等键写侧、`archiveBatchMembers`、config `collectSync` 节读取与 `DEFAULT_COLLECT_SYNC`，以及全部注入点接线——**实施时以 `grep -rn "collect\|Collect" packages/subagent-core/src` 全量核对**，已核实的注入点：`subagent-service.ts:289-291`（closeMembers → archiveBatchMembers 接线）与 `:355/:390`（两处 getCollectCoordinator getter）、`chat-rounds.ts:625-627`（routeRecord / isCollectMember 失败轮分流判据）、`record-lifecycle.ts:39/84`（getCollectCoordinator 显式接口投影）与 `:419`（archiveBatchMembers 本体）、`run-orchestration.ts:150-151`（公共投影）与 `:498-502`（collect 路由派发落点 registerMember） |
| 存量数据兼容 | **读侧保留**：磁盘上存量 record 的 `batchFinalized` entry、session-reader 反查投影、record-store 重建路径对既有 entry 的容忍解析**不删**（只停写）——旧 session 文件必须可读。⛔实施期门（已闭合，见 §5 终局结论）：用一个含 sync 批历史 record 的真实 session 文件验证重建/读取不炸 |
| 测试 | **随删**：行为测试族（`subagent-schema-collect.test`、`collect-coordinator-service`、`collect-mixed-dispatch` 等）。**随改保留**：读侧守卫测试（`batch-finalized` / `rebuild-indexes` / `permanent-session-legacy-compat`——它们守的是 batchFinalized 审计/透传读侧兼容面，改造断言为「存量 entry 可读」而非删除）。structured-output 侧跨包契约测试对照面同步（schema import 点收敛后跑通） |
| 文档 | `docs/extensions/subagents/architecture.md`（§2.2 sync-collect-domain 行、§4 结果通知行）、`docs/CONTEXT.md` 或 `docs/extensions/glossary.md` 登记「fan-out / 批量派发」词条并移除 sync 批表述、AGENTS.md 及 dev-flow 等 skill 中 sync 批派发提法清扫（`grep -rn "collect" docs/ .agents/` 全文核对） |
| 迁移顺序 | Phase 1 先落 fan-out + 批量 tool + 导流（模型有替代路径）→ Phase 2 删 collect（同一 PR 序列，两个 commit；schema 删除与 core 退役不拆 release，避免「schema 在、机制亡」的中间态）。迁移说明补两句：① `collect:"async"` 显式指定随字段删除消失——其行为（立即逐条通知）即退役后的缺省路径，**无迁移动作、无功能损失**；② 字段删除后旧调用形态的实测行为与误读风险（见 §4.1 S5） |

#### D7：notifyDone 账本化（与 Phase 2 绑定同一交付序列，不设独立延期选项）

collect 退役后，「结果语义通知」只剩 workflow notifyDone 一条通道，而它目前是裸 steer 注入（`helpers.ts` 自注：`g4-allow: 存量待迁移——账本化迁移登记 pi-boundary-reliability 附录 B 待办`）。批量编排的通知可靠性是本设计目标 G2 的组成部分，账本化纳入本设计范围，对齐约束 C-ext-19。

**窗口期代价四要素**（Phase 1 合入起、账本化完成前的投递保障变化，显式裁决）：

| 要素 | 内容 |
|---|---|
| 量级 | collect 批通知走 ledger at-least-once（`sync-batch:` 幂等键写账，§2.2 #2 有 40 分钟后重放实证）；notifyDone 现状 fire-once——窗口期内 relay 瞬断即整批结果通知丢失且无重放。缓解事实：结果本体落盘于 `workflow-state/<runId>.jsonl`，主动 status 可查回，**非永久丢失**，但被动通知通道不可恢复 |
| 恢复通道 | 账本化前：返回文案与通知指引保留「异常超时做单次 status 查询」恢复出口（§3.1/D3 文案已含，抑制「Do NOT poll」对恢复通道的误伤） |
| 重审条件 | relay 修复合入前窗口风险最高（瞬断诱因未除），绑定关系不随 relay 修复松动——账本化是通道语义升级，与 relay 修复独立受益 |
| 显式判定 | **Phase 3 与 Phase 2 绑定同一交付序列**：Phase 2（collect 删除）合入的同一 PR 序列必须含 Phase 3，不允许「collect 已删、账本化未落」的状态跨 release 存在。被否：「独立可延期」——延期窗口 = 批量结果投递保障降级期，且「Do NOT poll」文案会抑制仅存的主动恢复出口，代价不可接受 |

#### D8：GUI/TUI 渲染面

批量调用渲染归宿（`Block.vue` 组件挂载按集合分流，`isWorkflow` 分支）：**唯一形态 = 恒折叠单行**——icon + WORKFLOW 前缀 + `input.slug`（批次标签），点击 `openWorkflowDrawer` 打开 drawer 的 workflow tab。[终态同步修订 2026-09-17] 设计初稿「批量成员以 agent call 形态入列，点 call 切 subagent tab」经终态复审证伪：drawer 选中以 `workflowFields.name` 匹配（`openWorkflow(name)`，`name` 为空仅切 tab 不记录选中——Block.vue:470 注释明载），而批量 schema 无 `name` 入参 → **subagents 批量块点击在结构上只能到达 workflow tab 空态，成员入列不可达**（设计期 u3 只核对了 isWorkflow 分支与点击通路，未核对选中链路的 name 匹配前提——设计盲区）。成员查看的现实路径：workflow tool 直跑 fan-out（input.name="fan-out" 命中选中）或 `subagents action:"list"`。「批量块 → drawer 选中 → 成员入列」通路的补齐（renderer 侧 name 匹配放宽或按 runId 选中）超本设计「零 renderer 改动」边界（D1 单收录裁决的前提），登记为待用户裁决的后续项（实施证据：f4-drawer2.png drawer 空态 + 代码链 Block.vue:461-472）。

- **不构造 `details.__gui__`**：`guiComponent` 的渲染点（`Block.vue:155/195`）位于普通 tool 分支（`v-else`）的展开区内，`isWorkflow` 分支恒折叠无展开路径，不消费 `__gui__`——P1.2 构造 list-tree 是死代码（workflow tool 现状构造 `__gui__` 但块面同样不消费，本设计不复制该漂移；`Block.vue:93` 模板注释「+ list-tree GUI」与实现漂移，实施期顺手登记）。
- **可辨识性规则（分面声明）**：批量 schema 无 `name` 字段。**对话流块面**显示模型 `input.slug`（`workflowFields` 读模型原始 args）——模型传了 slug 才有批次信息，schema description 引导提供；模型未传时块面 = icon + WORKFLOW 前缀零批次信息，登记为可接受形态（runId 在返回文本、drawer 全量列表可定位）。**状态面**：handler 缺省生成 `fan-out-<时间短码>`（spec.slug 层）→ run 投影名 → drawer WorkflowTab run header，多批次并发的状态面辨识由生成值保障——pi 事件流契约无 input 回写通路（hook 只改 output），生成值到不了块面，两面的辨识手段各自独立。**被否谱系**：④「handler 生成值可辨识块面」——被注入时机断层击穿（spec 层生成值无 input 回写通路，恰在要防的「模型未传」场景块面依然零信息）。
- **被否谱系**：① R2 版「两形态：`__gui__` list-tree 主路径 + workflow 块降级」——被 `__gui__` 消费点归属击穿（渲染点在普通分支展开区，isWorkflow 分支不可达）；② R1 版「BlockSubagent.vue 适配 + 点击 no-op」——被组件挂载面击穿（`isSubagent` 集合判定，批量块不进该分支）；③ 组件层补批量专属分支——恒折叠形态已可定位 run，无需求强度；④ 见上条。TUI 侧 `renderCall` 按 shell 既有 tool 惯例落同款信息。

#### D9：错误规格汇总

| 错误 | 触发点 | 形态 | 恢复指引 |
|---|---|---|---|
| tasks 缺失/空 | handler 入口 | throw + Correct 示例 | 补参重试 |
| tasks 元素非字符串/空白 | 模板入口（args-validator 后脚本内校验） | run 即失败，通知 error 带用法 | 修正 tasks 重派 |
| agents 路径无法解析 | 引擎路由层（既有 identity 解析拒绝） | run failed，error 带清单建议（与 workflow tool not_found 同款「available + location」自救指引形态） | 按清单修正 agents |
| fan-out 执行体缺席（registry 解析失败） | handler 入口（`registry.get("fan-out")` unavailable） | throw + Recovery 指引 + 当前可用模板清单（「Workflows currently available: …」） | 修复/重装 @zhushanwen/subagent-core 后重试 |
| agents 数量与 tasks 不匹配（>1 且 ≠N） | 模板入口 fail-fast | run failed，error 带 Correct 示例（如 `agents must have 1 entry or exactly tasks.length=3 entries, got 2`） | 对齐数量后重派（对照：parallel 的静默 fallback 换 persona 语义被有意排除，防失败归因失真） |
| 成员失败（任意原因） | allSettled 捕获 | 不炸 run；results 标 failed；run status partial | 只重派失败任务 |
| 全员失败 | 模板 throw | run failed + NOT task completion 指引 | 诊断 error 后重派 |
| 预算耗尽（tokens/time） | run 生命周期（既有） | 通知 status + reason（budget_limited/time_limited）| 缩任务或加预算重派 |
| 通知体积触界 | 模板序列化前截断 | `truncated: true` + status/路径保完整 | 按 fullReportPath 读文件 |

---

## 4. 验收

> 按 dev-flow 准则：e2e / 真实 LLM 用例只在开发阶段按改动面空载串行跑，PR/merge/CI 门禁不跑（`TAIJI_SKIP_REAL_PI=1` unit 轨同口径）。

### 4.1 真实场景验收（每场景回溯 §1 目标）

| # | 场景（谁、在什么上下文、做什么、看到什么） | 通过标准（可证伪） | 回溯 |
|---|---|---|---|
| S1 | **pi CLI 真机基本链**：`pi -ne --mode rpc --extension <shell 构建产物绝对路径>` 起 RPC 会话，stdin JSONL 发 prompt「用 subagents 工具并行执行两个任务：分别数出 <测试目录> 下的 .ts 文件数与 .md 文件数」；等 run 收口通知 | 收到一条 notifyDone：scriptResult.status=ok 且 results.length=2、两条 summary 均含正确计数（人工核对目录实际文件数）；Agent Trace 2 条均 ok | G1/G2 |
| S2 | **三审场景复现（真实工作负载）**：对本仓库任一 tech-design 文档，prompt 模型走 `subagents` 三路审查（main/impact/simplicity 三个 agent），期间父会话正常 idle | **通过标准（G2 口径，本设计可归因）**：三份报告落盘、notifyDone 一次收齐三路 summary；若期间有成员失败，run 收口 status=partial 且通知照达（对照 collect 时代的通知黑洞——成员死亡不吞通知即本设计职责内的通过）。**观察项（非通过判据）**：父回合结束后成员是否持续推进——其依赖前提（run 管道派发链路不经 kill-on-disconnect 连坐）属范围外 relay 线；若实测成员仍被分钟级全灭，回 relay 线联动定位，不判本设计失败，但 partial+通知照达仍须成立 | G1/G2 |
| S3 | **部分失败 + 反向断言**：tasks 三条，其中一条 agent 路径故意写不存在的文件；另派一批发起后对其中一个成员发起 `subagent {action:"message"}` | run 收口 status=partial；通知 results 中失败条标 failed + error、另两条 ok；模型能按恢复指引只重派失败条。反向：message 被拒绝，拒绝文案可达且带重派指引（`re-dispatch via subagents`）；agents 数量错配（3 tasks 配 2 agents）→ run failed 带 Correct 示例（fail-fast 生效，非静默换 persona） | G2 |
| S4 | **中途停止**：S1 派发后立即 `workflow {action:"abort", runId:<返回值>}` | run 终态 aborted；通知到达（非静默）；无孤儿 pi 子进程残留（`ps` 核对） | G2/G3 |
| S5 | **collect 退役回归**：同一 CLI 环境发「collect:sync」式存量调用（带 collect 字段的 subagent start） | 字段被忽略或显式报错（⛔实施期门（已闭合，见 §5 终局结论）实测，**裁决偏好「显式报错」**——错误信息指向 `subagents`，消除「期待聚合通知却收 N 条独立通知」的静默语义误读；若实测为忽略分支，迁移期在 start description 留一句「collect removed → use subagents」，并把该误读后果写入迁移说明）。不产生批缓冲副作用；存量含 batchFinalized entry 的旧 session 文件可正常打开/读取（加载历史会话核对渲染） | G3 |
| S7 | **断连重放（Phase 3 账本化验收）**：S1 派发后、run 收口通知送达前切断 relay 连接（模拟瞬断），恢复连接 | 通知经 ledger 重放最终可达（at-least-once 语义，对照 collect 时代 sync-batch 重放）；重放不双投递（幂等键去重） | G2 |
| S6 | **采纳率实测**：S1/S2 落地后一周内，grep 真实会话 jsonl 统计「N 任务并行」场景的工具选择分布 | **达标线**：批量场景中 `subagents` 成为模型首选（命中次数 > 「N 次 start + collect 残留习惯」与「workflow 直跑」之和）。**不达标预案（阶梯）**：① 加强单数 tool 导流文案与注入措辞，复测一周；② 仍不达标 → 复审 schema/description 形态（对照 §2.3 机理逐条检查结构信号）。**不可采纳的终局处置（显式裁决）**：不 revert collect 退役——G3 的依据是 collect 自身语义缺陷（§2.2 #2-#6），独立于 G1 采纳率成立；此时批量需求回落 workflow 门面（`workflow run fan-out` 仍可用），并在 docs 登记采纳率失败事实 | G1 |

### 4.2 e2e 影响面评估（按改动面圈定，开发阶段空载串行跑）

- **受影响测试面**：subagent-workflow shell 测试族（tool 注册/schema 契约/注入器）、subagent-core orchestration 族（script 注册/args 校验）、structured-output 跨包契约测试（schema import 对照面）、`packages/shared` constants 契约（`WORKFLOW_TOOL_NAMES`——随 D1 收录裁决同步）。
- **圈定执行**：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test`（改动包全量）+ subagent-core 内 orchestration/assembly 相关 vitest 子集。S1-S5 属开发阶段手测链，不入 CI 门禁。
- **单测化路径**：S3/S5 的行为断言（partial 语义、collect 字段行为、message 批量成员拒绝文案、agents 数量 fail-fast）可在 mock 轨沉淀为壳层单测，随 Phase 2 一并落；S1/S2 依赖真实 LLM，维持人工验收形态。**S1-S5、S7 按 R2/R3 态登记 `docs/testing/e2e-map.json`（S7 随 Phase 3 登记，触发条件随迁移说明落），过 `scripts/select-affected-e2e.mjs --check` 防漏门禁——登记动作列入 P2.4 与 Phase 3**。

---

## 5. 下一层拆分

### Phase 1：批量能力（独立可验收）

| 单元 | 内容 | 文件改动地图 | 为什么独立 |
|---|---|---|---|
| P1.1 fan-out 模板 | 脚本 + @pi-meta 参数面（tasks/agents/aggregate，无 tasksJson——被否谱系见 D4）+ agents 数量 fail-fast + taskIndex 派发序赋值 + lintScript 约束自查（含 parallel() 入口、禁 bare IIFE） | `packages/subagent-core/workflows/fan-out.js`（新增） | 纯新增脚本，可单独用 workflow run 验收 |
| P1.2 subagents tool | schema + handler 转译 + 注册 + reentry 共用 + TUI renderCall/Result；slug 缺省时 handler 生成 `fan-out-<时间短码>` 直传 runWorkflow spec.slug（D8 状态面辨识规则——受益面 = drawer run header，无 input 回写通路不到块面）；**不构造 `details.__gui__`**（isWorkflow 块不消费，防死代码——D8）；`WORKFLOW_TOOL_NAMES` 收录（失效兜底正确归类 workflow-record，渲染走 workflow 块分支——D1/D8 裁决）；实施期顺带核对 `run-spec.ts`「≤20 字符」注释与 `SLUG_MAX_LENGTH=35` 的既有不一致（仅登记不扩大处理）；文件头注释与 `interface/subagents.ts`（/subagents 命令壳）互指防混淆 | `extensions/universal/subagent-workflow/src/interface/tool-subagents.ts`（新增）、`index.ts`（注册）、`packages/shared/src/constants.ts`（`WORKFLOW_TOOL_NAMES` 收录） | 行为面主体 |
| P1.3 渲染归宿核对（预期零代码改动） | 核对 workflow 块单行渲染（WORKFLOW 前缀 · slug）、点击 openWorkflowDrawer 开 drawer workflow tab；确认 `message-turns.ts` 并集判定与 `event-interpreter.ts` WORKFLOW 分支两处零改（P1.2 收录裁决的验证点）。~~成员 agent call 入列可见~~（终态同步修订：批量块选中链路结构性不可达，见 D8 修订与待裁决项） | 预期零代码改动（`packages/ui`、`packages/core`、`packages/runtime` 均不动），纯核对 + 截图留档 | 渲染归宿靠既有分支，核对独立于编码 |
| P1.4 导流文案 | 单数 tool description/guidelines、workflow-list 注入器（宿主中立文案） | `subagent-tool-schema.ts`、`injectors/` | 采纳率工程，与 P1.2 同 commit |

Phase 1 验收 = S1/S2/S4 通过。

### Phase 2：collect 退役（依赖 Phase 1 合入）

| 单元 | 内容 | 文件改动地图 |
|---|---|---|
| P2.1 schema/壳退役 | 删 collect 字段 + startHandler 路由（extension 侧 `recoverSyncCollectBatch` 调用点已随 modeless 波5 摘除，本单元仅删 core 侧 no-op 方法本体） | `subagent-tool-schema.ts`、`subagent-tool.ts`、core `subagent-service.ts` |
| P2.2 core 退役 | §3.3 D6 core 行全部条目（写侧 + 注入点接线，含 chat-rounds/record-lifecycle/run-orchestration/subagent-service 注入点） | `subagent-core` execution/service、assembly、persistence、notify 对应文件 |
| P2.3 存量读侧兼容验证 | 含批历史的真实 session 重建/读取 | 只验证不改；若读侧有强耦合再评估最小保留面 |
| P2.4 测试、文档与登记 | 行为测试族随删 + 读侧守卫测试随改保留（batch-finalized/rebuild-indexes/permanent-session-legacy-compat 改断言「存量 entry 可读」）；architecture.md/CONTEXT/glossary/AGENTS.md 清扫；迁移说明（collect 字段实测行为 + async 无迁移动作 + 忽略分支误读后果若实测为忽略）；`docs/testing/e2e-map.json` 登记 S1-S5（R2/R3 态 + 触发条件；S7 随 Phase 3 登记），过 `--check` 门禁；core 源码 `grep -rn "collect\|Collect"` 终扫归零核对 | 对应文件 |

Phase 2 验收 = S3/S5 通过 + extensions 三连绿。

### Phase 3：notifyDone 账本化（与 Phase 2 绑定同一交付序列，见 D7 四要素裁决）

ledger 记账 + courier 送达改造 notifyDone 路径，对齐 C-ext-19；验收 = S7 断连重放场景（通知最终可达 + 幂等去重）。**不再标注「可延期」**：Phase 2 合入的同一 PR 序列必须含本 Phase；S7 随本 Phase 登记 e2e-map。

### 待验证检查点（设计期无法确定，实施期门）——✅ 四项已全部闭合（2026-09-16/17，终局结论）

- ~~⛔ pi 对 tool schema 未知字段的实际校验行为（S5）~~ **实测 = 静默忽略分支**（typebox 1.3.7 无 additionalProperties 约束即透传，u4 证据链 + A5 真机确认）；缓解动作①②已落地（subagent-tool.ts 迁移提示句 + CONTEXT.md 迁移说明）
- ~~⛔ runWorkflow 同步段时长（reentry guard 必要性）~~ **实测 = 毫秒级（唯一 await = store.save），guard 保留**（并发/重复投递防护语义，u2 结论 + A1 基本链）
- ~~⛔ 通知体积 6×500 字实测~~ **截断保序落地**：truncated:true 标记 + taskIndex/status 恒完整（fan-out.js 单测锁定 + A1 通知实测）
- ~~⛔ 存量 batchFinalized entry 读侧容忍面（P2.3）~~ **u6 mock 轨 24/24 通过 + A5 真机**——D6 兼容策略无需回改
