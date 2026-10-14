# taiji 领域模型登记

> **本文件定位**：领域聚合、不变量与状态机的登记处（统一语言词条在 [CONTEXT.md](CONTEXT.md)）。当前登记域：**画布（problem-solve canvas，2026-10）**。
>
> 机制纪律：不变量与状态机转移表的实现单点在 runtime CanvasService（`packages/runtime/src/services/canvas/`）——renderer / extension 侧不复制领域规则，全部写操作经唯一入口 `mutate`（契约 = `packages/extension-protocol/src/extensions/canvas/`，agent 工具面 = `extensions/taiji/canvas/`，GUI 写通道 = WS RPC `canvas.mutate`）。

## 画布域

问题解决画布是 tech-design-wf 之前的方向规划层，一个独立限界上下文：与会话上下文经回推 prompt（文本防腐）交互、与 workflow 上下文无直接依赖（审查 subagent 只复用派发基建）、与计划上下文（plan）互不感知；对下游 tech-design-wf 经需求卡（requirement card）防腐对接。状态权威 = runtime CanvasService；持久化 = `<dataDir>/canvases/<canvasId>/` 下 `events.jsonl`（append-only 领域事件流，唯一权威）+ `canvas.json`（可由事件流全量重放推导的加速快照，写入顺序恒「先事件后快照」——快照允许滞后、永不超前）。

单一「问题解决画布」上下文含两个聚合。

### 聚合 1：画布（聚合根）

成员：全部图节点（问题 / 方案 / 论据 / 约束四类）、边（六种：decompose / resolve / argue / rebut / constrain / reference，MVP 含前四种 + constrain）、评论（锚定附件）、支撑度（主干边评价值）、方向裁决记录（画布元数据 + 事件留痕，非图节点）、待重审路径集合。

不变量（全部可核对，表外写入 fail-fast 并返回结构化错误码 + 恢复动作文案）：

1. 一张画布有且仅有一个根节点，类型为 question，且带完成判据（可证伪）与范围排除
2. 主干图（decompose + resolve）无环
3. 任一 question 的 resolve 边中，selected 至多一条；selected 变更产生方案选择事件并留对比理由（换选走同一调用事务内的迁移语义）
4. rejected 节点不可删除、不可从 rejected 直接转 passed（必须先复活为 draft）
5. 素材性为 fact 的论据必须携带核实状态（已核实 / 未核实）；未核实论据不得作为 passed 的依据
6. constrain 边的目标必须是画布内存在的节点（子树锚点）
7. 执行叶子 passed 前完成判据必填；dispatched 前必须 passed 且下游产物指针必填
8. 评论被添加后，响应状态初始为待响应；agent 的采纳 / 反驳留痕前不得转为已响应
9. 用户改动节点后，从该节点到根的路径必须进入待重审集合（mutate 事务内自动计算传播范围；换选 = 上溯路径 + 旧选中方案整个子树）
10. 规划收敛终态的前置 = 待重审集合为空 + must-fix 清零 + 执行叶子全部 passed/dispatched（收敛确认与 export 均校验此不变量）
11. 唯一入口：图元素增删改、状态转移、评价、派发均经画布聚合根的操作（actor 字段区分 user / agent / review；per-action × actor 合法性矩阵在契约模块，表外组合 fail-fast）

**节点状态机**（生命周期 × 派发二维正交，禁止直写状态字段）：

- 生命周期维（根节点除外——根不可搁置 / 否决）：`draft（草案）→ under-review（审查中）→ passed（通过）| rejected（否决，灰显保留）`；draft/under-review 均可 `→ shelved（搁置）`；`rejected → draft`（复活须新证据或用户裁决，留理由）；`shelved → draft`。合法转移表之外的写入一律 fail-fast；每次转移记录触发者（agent 提案 / 用户裁决 / 审查结论）。
- 派发维（仅执行叶子，与生命周期正交）：`passed 的执行叶子 →（用户拍板）→ dispatched（已派发，登记下游产物指针）`。dispatched 后仍可编辑（patch 无 dispatched 门槛），编辑使该叶子进待重审、门禁红、导出锁定，复审通过后解锁重新导出。
- 状态机不作用于边——边的缺陷经支撑度（有缺口 / 不成立）+ 关联 must-fix 表达，不另建边状态机。

**就绪递归与收敛判据**（自底向上传播，与反向审查同方向）：

- question 就绪 = 存在 selected 方案且该方案子树就绪；或该问题被 rejected/shelved（判定范围外）
- option 就绪 = 无分解子问题，或子问题全部就绪
- 叶子 = 无分解出边的 selected 方案（结构派生）；执行叶子 = 叶子且被显式标记可派发（规划决策，非结构事实）
- 规划收敛 = 根就绪 + 全部执行叶子 passed/dispatched + must-fix 清零 + 待重审集合为空（不变量 10）

### 聚合 2：审查报告（ReviewReport，聚合根）

成员：轮次、条目（must-fix / suggestion 两级，经图元素 id 引用）、处置记录（采纳 / 登记后做 / 拒绝留理由，first-writer-wins——已有处置记录的条目再次处置被拒绝并报错误码）、终态（converged / max-rounds / escalated / stuck 四值，除 converged 外全部附停回说明与恢复动作建议）。

不变量：

1. 条目引用的图元素 id 必须存在于画布
2. 终态 converged 必须满足全部 must-fix 条目关闭；max-rounds / escalated / stuck 终态必须附停回说明与恢复动作建议
3. 审查与修复分离：审查聚合只追加条目与结论，不直接改画布聚合（reviewer 只读 + review-append；修复由执行侧按处置表经 mutation 完成后逐条 review-resolve 登记）

**审查产物与图的分界**：论证留图（对结果有持久影响的反对 / 证据成为论据节点），过程留报告（轮次、处置表、终态）——图承载内容，报告承载过程。

### 领域事件

节点历史 = 事件流回放（who / when / why / what）。每个 mutation action 至少产出一个事件（read / list 为查询类不产事件）；事件类型含 CanvasCreated / GrowthDirectionDecided / NodeCreated / NodeModified / StateTransitioned / OptionSelected / NodeDispatched / CommentAdded / CommentResponded / DirtiedPathMarked / ReviewConverged / ReviewMaxRoundsReached / ReviewEscalated。`events.jsonl` 是唯一持久权威，`canvas.json` 快照损坏或不一致时从事件流头全量重放重建。
