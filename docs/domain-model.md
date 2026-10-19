# taiji 领域模型登记

> **本文件定位**：领域聚合、不变量与状态机的登记处（统一语言词条在 [CONTEXT.md](CONTEXT.md)）。当前登记域：**画布（problem-solve canvas，聚合与不变量，2026-10）**；**状态机基建与五域状态机（run / 画布节点 / plan / goal / permanent-session + 归档单元，2026-10，见下「状态机基建」节）**。
>
## 状态机基建（@zhushanwen/state-machine）

「领域状态必须显式状态机」裁决（2026-09-21）的共享实现载体（[ADR-0152](adr/decisions.md)）：`packages/state-machine`，零运行时依赖，npm 发布（`@zhushanwen` 命名空间，pi 扩展侧可依赖）。新领域立状态机 = 一份声明（状态词表含 terminal 位 + 事件词表 + 行式转移表含 guard 与动作引用 + 每实体错误策略），机器机制由基建统一提供：合法性判定（`transition` 纯函数内核——guard 按行序求值、多命中 = 转移表不变量破坏恒 throw、planned 只计划不执行）、定义期自检（词表外行 / 多行混入无 guard 行即 throw）、转移动作执行（`runTransition` 事务性编排外壳——宿主按名注入实现，全部成功次态才应用，单态 fail-fast）、穷举单测生成（`generateTableTests`）、词表外运行时输入映射（`coerceState`——枚举 includes 白名单，拒原型链键）。

纪律：

- 新状态机一律声明即用，不再手写转移表 + transition 函数 + 穷举单测；穷举由生成器承载，行为级/契约级断言（错误类型、错误码、降级行为）保留域内
- 表外 fail-fast 不静默吞：throw 族错误信息含当前态合法事件清单（`errorFactory` 保形既有错误类型，消费方 instanceof 分类分支不受迁移影响）；result 族返回 `{ok:false}`，调用方义务 = 不落盘、不执行副作用
- 事务外壳边界外域：run 与 canvas 的域内编排（「内存权威先推进 + 动作失败分级容忍」/「权威事件流先行 + 快照与广播失败容忍」）不经外壳事务化，编排上收须按已接受变更单独登记（ADR-0152）

五域迁移登记（2026-10 迁入，只迁表与判定，域内编排留域内）：

| 域 | 状态词表 | 机器声明（实现载体 = 本基建） | 错误策略 / 表外处置 |
|----|---------|------------------------------|---------------------|
| workflow run 生命周期（outcome 四值正交，仅 terminal 产生） | created / running / settling / terminal + interrupted 暂停态（resume 流回 running） | `RUN_MACHINE`（packages/subagent-core/src/orchestration/run-events.ts） | throw——`IllegalTransitionError` 保形（errorFactory 构造既有类实例，消息含合法事件清单） |
| 画布节点生命周期 | draft / under-review / passed（terminal）/ rejected / shelved | `canvasLifecycleMachine`（packages/runtime/src/services/canvas/canvas-foundation.ts） | throw——`CanvasDomainError` 保形（`lifecycle_transition_illegal` 错误码 + recover 指引） |
| plan 计划生命周期 | idle / planning / reviewing / revising / approved / dispatching / completed / exited（终态 + enter 重启出边并存） | `PLAN_MACHINE`（packages/extension-protocol/src/extensions/plan/state-machine.ts） | result——表外 `{ok:false}` 不炸 turn |
| goal 目标状态 | active / paused / blocked / complete / budget_limited / cancelled（后三 terminal） | `GOAL_MACHINE`（extensions/universal/goal/src/engine/goal.ts；`transitionStatus` 保形包装对外） | throw |
| permanent-session 两态 | running / idle（词表与 ExecutionStatus satisfies 双向锁定） | `permanentSessionStatusMachine`（packages/subagent-core/src/execution/domain/record-status-machine.ts） | result——表外拒绝经域内原语转 return false（两态 CAS 语义保形） |
| 归档单元（session 归档子域，基建首个新消费者） | staging / archived / restoring | `archiveEntryMachine`（packages/runtime/src/services/archive/archive-entry-machine.ts） | throw——对外错误码由服务层承载 |

边界登记：session / background-task 两个域尚无转移表（显式化各自独立立项，ADR-0152）；core 的 streaming-state-machine.ts 是消费顺序 factory 深模块、非转移表状态机，不属本基建范畴；归档子域的聚合与不变量登记由 session-archive 设计承接（本节只登记其状态机实现载体）。

## 画布域
> 机制纪律：不变量与状态机转移表的实现单点在 runtime CanvasService（`packages/runtime/src/services/canvas/`）——renderer / extension 侧不复制领域规则，全部写操作经唯一入口 `mutate`（契约 = `packages/extension-protocol/src/extensions/canvas/`，agent 工具面 = `extensions/taiji/canvas/`，GUI 写通道 = WS RPC `canvas.mutate`）。


问题解决画布是 tech-design-wf 之前的方向规划层，一个独立限界上下文：与会话上下文经回推 prompt（文本防腐）交互、与 workflow 上下文无直接依赖（审查 subagent 只复用派发基建）、与计划上下文（plan）互不感知；对下游 tech-design-wf 经需求卡（requirement card）防腐对接。状态权威 = runtime CanvasService；持久化 = session 存储树域 8 `<dataDir>/ext-sessions/<ownerSessionId>/canvases/<canvasId>/` 下 `events.jsonl`（append-only 领域事件流，唯一权威）+ `canvas.json`（可由事件流全量重放推导的加速快照，写入顺序恒「先事件后快照」——快照允许滞后、永不超前）。归属即路径：一张画布恒归属创建它的 session（ownerSessionId），一个 session 可有多个画布（1:N）。

单一「问题解决画布」上下文含两个聚合。

### 聚合 1：画布（聚合根）

成员：全部图节点（问题 / 方案 / 论据 / 约束四类；约束类第二版可达——MVP 的 grow 邻接矩阵四条 case 均不产约束节点，无创建通道）、边（六种：decompose / resolve / argue / rebut / constrain / reference，MVP 落地前四种——constrain / reference 第二版，契约词表不预留）、评论（锚定附件）、支撑度（主干边评价值）、方向裁决记录（画布元数据 + 事件留痕，非图节点）、待重审路径集合。

不变量（全部可核对，表外写入 fail-fast 并返回结构化错误码 + 恢复动作文案）：

1. 一张画布有且仅有一个根节点，类型为 question，且带完成判据（可证伪）与范围排除
2. 主干图（decompose + resolve）无环
3. 任一 question 的 resolve 边中，selected 至多一条；selected 变更产生方案选择事件并留对比理由（换选走同一调用事务内的迁移语义）；方案被否决 / 搁置时其 selected 标记同步清除（否决 = 放弃该候选——transition 转移侧清除，事件流重放同函数还原，复活后须重新选定），resolve 路径的「selected 方案」由此恒处于有效生命周期
4. rejected 节点不可删除、不可从 rejected 直接转 passed（必须先复活为 draft）
5. 素材性为 fact 的论据必须携带核实状态（已核实 / 未核实）；未核实论据不得作为 passed 的依据
6. constrain 边的目标必须是画布内存在的节点（子树锚点）——第二版生效：MVP 契约词表无 constrain 边，此不变量暂无校验对象
7. 执行叶子 passed 前完成判据必填；dispatched 前必须 passed 且下游产物指针必填
8. 评论被添加后，响应状态初始为待响应；agent 的采纳 / 反驳留痕前不得转为已响应
9. 用户对节点内容的改动（patch / select / comment）在 mutate 事务内自动计算传播范围进待重审集合：一般改动 = 从该节点上溯到根的路径；换选 = 上溯路径 + 旧选中方案整个子树。dispatch 只在已 passed 的执行叶子上登记下游产物指针、decide-direction 只拍板画布方向元数据，均不改变可审内容，不进传播集
10. 规划收敛终态的前置 = 待重审集合为空 + must-fix 清零 + 执行叶子全部 passed/dispatched（收敛确认与 export 均校验此不变量；export 另要求收敛确认已执行——converged 终态，GUI 与 agent 代执行两条表面同一前置）
11. 唯一入口：图元素增删改、状态转移、评价、派发均经画布聚合根的操作（actor 字段区分 user / agent / review；per-action × actor 合法性矩阵在契约模块，表外组合 fail-fast）
12. 一张画布有且仅有一个归属 session；画布的创建与访问校验归属（GUI 清单与 agent 工具面 canvas_list 按归属过滤，跨会话访问返回 `forbidden` 结构化拒绝）；session 删除级联删除其全部画布（画布落归属 session 的存储树内，随整树回收）

**节点状态机**（生命周期 × 派发二维正交，禁止直写状态字段）：

- 生命周期维（根节点除外——根不可搁置 / 否决）：`draft（草案）→ under-review（审查中）→ passed（通过）| rejected（否决，灰显保留）`；draft/under-review 均可 `→ shelved（搁置）`；`rejected → draft`（复活须新证据或用户裁决，留理由）；`shelved → draft`。合法转移表之外的写入一律 fail-fast（判定载体 = `canvasLifecycleMachine`，@zhushanwen/state-machine 声明，见「状态机基建」节）；每次转移记录触发者（agent 提案 / 用户裁决 / 审查结论）。
- 派发维（仅执行叶子，与生命周期正交）：`passed 的执行叶子 →（用户拍板）→ dispatched（已派发，登记下游产物指针）`。dispatched 后仍可编辑（patch 无 dispatched 门槛），编辑使该叶子进待重审、门禁红、导出锁定，复审通过后解锁重新导出。
- 状态机不作用于边——边的缺陷经支撑度（有缺口 / 不成立）+ 关联 must-fix 表达，不另建边状态机。

**就绪递归与收敛判据**（自底向上传播，与反向审查同方向）：

- question 就绪 = 该问题被 rejected/shelved（判定范围外），或其完成路径全部成立：resolve 路径（存在 selected 方案且该方案子树就绪）与 decompose 路径（分解子问题全部就绪）并存时须同时成立；两路皆无 = 悬空问题，不就绪
- option 就绪 = 无分解子问题，或子问题全部就绪
- 叶子 = 无分解出边的 selected 方案（结构派生）；执行叶子 = 叶子且被显式标记可派发（规划决策，非结构事实）
- 规划收敛 = 根就绪 + 至少一个执行叶子（防空集 vacuous 收敛——无执行叶子 = 无交付单元，拒绝收敛）+ 全部执行叶子 passed/dispatched + must-fix 清零 + 待重审集合为空（不变量 10）

### 聚合 2：审查报告（ReviewReport，聚合根）

成员：轮次、条目（must-fix / suggestion 两级，经图元素 id 引用）、处置记录（采纳 / 登记后做 / 拒绝留理由，first-writer-wins——已有处置记录的条目再次处置被拒绝并报错误码）、终态（converged / max-rounds / escalated / stuck 四值，除 converged 外全部附停回说明与恢复动作建议）。

**轮次口径（一轮 = 一循环）**：一轮 = 一次完整审查循环（发起 → reviewer 报告写回 → 处置）。当前轮已有报告条目 = 轮次完成；未完成时再发起 = 同一轮重发（GUI 发起链路 user 发起 → 回推 → agent run 再发起两跳计一轮），不推进轮次、不消耗轮次预算。maxRounds 按完成的审查循环计数；达上限后再发起置终态 max-rounds 停回，用户升级裁决放行恰一轮（round+1 且 maxRounds 同步抬升，ReviewEscalated 事件留痕，放行后即回 in-progress——escalated 不驻留 status；stuck 为词表值，MVP 无触发路径）。

不变量：

1. 条目引用的图元素 id 必须存在于画布
2. 终态 converged 必须满足全部 must-fix 条目关闭；max-rounds / escalated / stuck 终态必须附停回说明与恢复动作建议
3. 审查与修复分离：审查聚合只追加条目与结论，不直接改画布聚合（reviewer 只读 + review-append；修复由执行侧按处置表经 mutation 完成后逐条 review-resolve 登记）

**审查产物与图的分界**：论证留图（对结果有持久影响的反对 / 证据成为论据节点），过程留报告（轮次、处置表、终态）——图承载内容，报告承载过程。

### 领域事件

节点历史 = 事件流回放（who / when / why / what）。每个 mutation action 至少产出一个事件（read / list 为查询类不产事件）；事件词表 18 值（全量 SSOT = 契约 `CANVAS_EVENT_TYPES`，`packages/extension-protocol/src/extensions/canvas/state.ts`）：主事件族（14 mutation action 各一，映射 = 契约 `ACTION_EVENT_MAP`）CanvasCreated / GrowthDirectionDecided / NodeCreated / NodeModified / StateTransitioned / OptionSelected / NodeDispatched / CommentAdded / CommentResponded / ReviewRequested / ReviewEntryAppended / ReviewEntryResolved / ConvergenceChecked / CanvasExported，附属事件（不独立对应 action）DirtiedPathMarked（待重审标记）与审查终态族 ReviewConverged / ReviewMaxRoundsReached / ReviewEscalated。`events.jsonl` 是唯一持久权威，`canvas.json` 快照损坏或不一致时从事件流头全量重放重建。
