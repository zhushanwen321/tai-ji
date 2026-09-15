# Session Merge 技术设计（graph conversation 第一期）

> **一句话结论**：利用 pi session 家族"fork 复制保留 entry id ⇒ 全家族共享一棵全局 entry 树"的事实，在 runtime 侧对选中的多个会话做 LCA 检测与分段（切链 + 覆盖集），以**结构锚点原子段**为缓存单元逐段生成事实性摘要（可复用、可降级参考），最终以 `createBranchedSession(LCA)` 新建产物分支并按 `marker ← branch_summary` 固定布局挂载；全程不修改任何现有 session 文件，multi-parent 关系只存在于 marker 元数据与画布渲染层。
>
> **层声明**：本文档是功能技术方案设计（当前层 = 功能方案，下一层 = 可实现的接口/数据模型/runtime 模块）。涉及数据流、运行时行为与错误处理，准则 5/6/7 全部 P0 适用。
>
> **状态**：v2（已回填对抗式审查 7 项 must-fix），待复审确认后进 M1。
>
> **修订记录**：v1 → v2 —— ① D3 重写为双层缓存模型（修复缓存键随 LCA/tip 漂移，MF-1）；② D4 固定产物 entry 布局 `marker ← branch_summary`（修复 leaf=marker，MF-2）；③ D6 增加活跃会话预检与 E7（修复快照缺尾静默丢内容，MF-3）；④ 新增 D9 并发互斥与 tmp+rename 原子写（MF-4/MF-5）；⑤ 新增 D10 mergeJob 状态模型（修复长任务进度与 sessionId 规则冲突，MF-6）；⑥ S5 移入探针表标注软观测（runtime 无 cache-stats RPC，MF-7）；⑦ 吸收审查建议：E4 碰撞降级消歧、cacheKey 加 promptVersion、familyRoot 用根 sessionId、TOCTOU 重拍、E5b、spike 扩两条附断言；⑧ 行号修正 constraints :170/:211，补 branch_summary.fromHook 字段说明。

---

## §1 背景目标

### SCQA

- **情境**：taiji 是 Electron + Vue 3 的 AI agent 桌面工作台，会话由 pi（`@earendil-works/pi-coding-agent@0.84.1`）子进程承载。用户已可从任意消息 fork 出新会话探索替代路径（sidebar ForkGroup 分组、trace 溯源跳转均已上线）。
- **冲突**：分叉是单向的——树只会长出更多叶子，没有任何机制把多条分支的进展收敛回来。用户并行试了 B、C 两条路后，想把结论带回主线，唯一手段是肉眼读 B 的对话、手动复制粘贴关键结论到另一个会话。
- **问题**：分支探索成果不可回收，探索越多、散落越广，what-if 工作流断在"收敛"这一步。
- **答案**：提供结构化 merge——选定多个同族会话，自动找最近公共祖先（LCA）、按结构锚点分段去重、逐段生成可缓存复用的摘要、产出一条携带全部结论摘要的新分支，并用机器可读的 marker 记录合并拓扑供后续再合并与画布渲染复用。

### 系统是什么（给不懂内部背景的读者）

pi 把每个会话存为一个 JSONL 文件：首行是 `type:"session"` 的 header（含 `parentSession` 字段记录 fork 源文件**绝对路径**），后续每行是一个 entry，每个 entry 带 `id`（`randomUUID()` 前 8 位 hex）和 `parentId`，构成**文件内的 entry 树**（不是线性日志）。fork 有两种形态：文件内分支（TUI `/tree`，同一文件里长出多叶子）与文件级 fork（RPC `fork` → `createBranchedSession(leafId)`，把 root→leaf 路径拷贝成**新文件**，header 写 `parentSession`）。**关键事实：两种复制都原样保留 entry id**（`createBranchedSession` 对路径 entry 做 `{ ...entry }` 浅拷贝仅重链 label），因此同一家族的所有文件在 entry-id 空间里是同一棵全局树的投影。本文所有算法都建立在这一点上。

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者可观察的行为 |
|---|------|--------------------|
| G1 | 多分支收敛 | 选 2~N 个同族会话执行 merge，得到一条摘要了全部分支进展的新分支，可直接继续对话 |
| G2 | 不丢信息、不改历史 | 被合并的源会话原封不动仍可打开；merge 产物可溯源到每个来源段；活跃/未落盘会话不会静默缺尾 |
| G3 | 增量成本可控 | 结构性共享的内容只摘要一次；再次 merge 时已摘要的原子段直接复用，被新分叉劈开的旧段以参考形式降级复用 |
| G4 | 可视化就绪 | merge 拓扑（谁并进了谁、从哪到哪）机器可读，后续 graph conversation 画布直接消费 |

### Scope

- **In**：同族（parentSession 链连通）会话集合的 merge 编排、锚点分段算法、双层摘要缓存、产物文件写入（含原子性与互斥）、marker schema、mergeJob 状态模型、runtime RPC 与最小 renderer 入口（会话多选 + merge 向导）、`lastMergedAt` 字段回填（由本功能写入，语义 = 该会话作为 parent 参与的最近一次 merge 完成时间）。
- **Out**：graph conversation 画布本体（第二期，但其数据依赖 family index 的 mergeRefs 边在本期产出）；产物级合并（分支各自改动的代码文件走 git）；subagent/workflow 会话参与 merge（v1 排除，见 D8；renderer 侧过滤所需的 subagent 标志通路归实施期确认 SessionSummary 是否携带）；跨家族会话关联；段级溯源跳转的新 UI（本期产物内提供来源清单与目标定位信息，跳转动作复用既有 `useTraceJump` 通路，不做新界面）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状（真实例子）

用户在会话 A 的第 10 轮消息上 fork 出 B 试方案一，又从 B fork 出 C、D 分别试两个子方向；同时从 A 直接 fork 了 E。此时 sidebar 上 ForkGroup 显示这四个会话的分组关系。用户的真实诉求："C、D、E 都有结论了，帮我合成一条继续干。"——当前系统对此没有任何支持：

- sidebar 只能逐个打开会话看内容；
- trace 跳转（`useTraceJump.ts`）只能从子会话跳回 fork 源，方向单一；
- 手工搬运结论时，另一条分支的工具过程、失败尝试、未决问题全部丢失，且无任何记录说明"这条结论来自哪个会话的哪一段"。

### 2.2 真实失败模式（手工搬运的三种失败）

| 失败模式 | 触发条件 | 后果 |
|----------|----------|------|
| 上下文截断 | 分支后半段的工具调用链才是结论依据，用户只复制了结论文本 | 新会话里模型对结论缺乏依据，重新追问浪费轮次 |
| 无溯源 | 结论贴进新会话后与原文断链 | 无法核对"这个说法当时是怎么得出的" |
| 重复劳动 | 三条分支都要搬，每条都人工通读 | 用户放弃收敛，分支彻底荒废 |

### 2.3 根因分析

1. **pi 层**：数据模型是单 parent 树，`buildSessionPath` 只定义 root→leaf 单路径的上下文构建；entry 级 DAG（一个节点两个父）不在格式语义内，且项目规则禁止修改 pi 源码。⇒ merge 不可能在 pi 格式层表达，必须由 taiji 在其上编排。
2. **taiji 层**：fork 血缘数据齐备（`SessionSummary` 已有 `parentSession`/`forkEntryId`/`handedOffTo`/`lastMergedAt` 字段，见 `packages/shared/src/session.ts:78-87`，其中 `forkEntryId` 注释即写明"供后续 merge 定位 fork 点"、`lastMergedAt` 标注"痛点2 基础层"占位），但没有 merge 编排器：无 LCA 计算、无分段、无摘要调度、无产物写入。
3. **v3 遗产**：`docs/page-design/archive/v3/fast-merge/spec.md` 曾设计过"B+C+F 三件套（setActiveTools + before_agent_start + turn_end）让活跃会话里的 pi 生成结构化差异摘要 → 注入 composer"。它解决了摘要生成交互，但依赖活跃会话现场操作，无法支撑"离线批量收敛 N 个会话"。

### 2.4 物理数据流（现状：fork 后磁盘上的家族形态）

```
~/.pi/agent/sessions/<encoded-cwd>/
├── A.jsonl   header(id=A) + entries[1..10]                    ← 源会话
├── E.jsonl   header(id=E, parentSession=A.jsonl绝对路径) + entries[1..10, 11e..15e]
├── B.jsonl   header(id=B, parentSession=A.jsonl绝对路径) + entries[1..10, 11b..20b]
├── C.jsonl   header(id=C, parentSession=B.jsonl绝对路径) + entries[1..10, 11b..20b, 21c..30c]
└── D.jsonl   header(id=D, parentSession=B.jsonl绝对路径) + entries[1..10, 11b..20b, 21d..35d]
```

注意 C、D 文件里的 `1..10, 11b..20b` 与 B 文件中的同名 entry **id 完全相同**（复制保留 id）——这就是"全局 entry 树"的物证。家族反查现状：`parentSession` 存绝对路径，family index 靠 sessionId 子串匹配反查（`family.ts:131-133`），匹配不到则跳过不崩溃。全项目写入 `parentSession` 的只有三处（pi `createBranchedSession`、pi `forkFrom`、runtime `session-fork.ts`），全部是 fork 语义——家族判定前提纯净，handoff/compact/rename 均不污染该字段。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**成功路径**（对应 §2.1 例子）：

> 用户在 sidebar 多选 C、D、E，点「合并会话」。向导第一步显示检测结果：「检测到共同起点：A 的第 10 条消息（2026-08-20 14:32）。将分段汇总 3 个会话共 60 条消息。」展开分段明细：`B 主干(10条) — 由 C、D 共享`、`C 增量(10条)`、`D 增量(15条)`、`E 增量(5条)`。用户可在可选输入框填写合并意图（默认留空 = 中性汇总），点「开始合并」，进度条显示 4 个段摘要依次完成（已缓存段直接标「已复用缓存」）。完成后 sidebar 出现新会话「C+D+E 合并」（fork 自 A@10），打开后首屏可见合并摘要与来源清单，末尾每条来源可定位回源会话对应段（跳转复用既有 trace 通路）；点击任一来源段可查看原文。合并期间该家族显示「有合并进行中」徽标，重复发起自动排队。

**失败路径与恢复指引**：

- **无公共祖先**（选中了不同族的 X、Y）：向导第一步红字提示「X（祖先是 A）与 Y 没有共同的 fork 来源，无法合并」。恢复：取消选择 Y，或单独对 X 所在族重试；不产生任何副作用。
- **祖先-后代退化**（选中的 A 是 B 的祖先且 A 无独有增量）：提示「A 是 B 的祖先，直接继续使用 B 即可」，不执行 merge。
- **选中会话仍在生成中 / 尾部未落盘**：提示「C 正在生成回复，请等待完成后再合并」（见 D6 预检）；源文件尚不存在（首次 flush 前）同样阻止并点名。
- **摘要服务失败**（短命 pi 进程超时/报错）：进度停在对应段并标红「第 2 段摘要失败：LLM 超时」。恢复：点「重试该段」（仅重跑失败段，已完成段走缓存）；或「取消」整体放弃——因为全程未修改源文件、产物走 tmp+rename 原子落盘，放弃零残留。
- **快照后源会话又推进**（TOCTOU）：执行时刻重新拍快照并与检测时刻比对，若入选会话 tip 变化，弹「C 自检测后有新消息，将按最新内容合并」二次确认。

### 3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|------|----------------|--------------|------|------|
| **A. runtime 编排的分段摘要式 merge（本设计）** | 好：真相全在 append-only entry 里，pi 无感知；锚点分段天然支撑缓存复用与画布拓扑（G3/G4 直接成立） | 中：需实现建树/切段纯函数 + ephemeral pi 摘要调度 + 原子产物写入 + job 状态模型 | 摘要有损（靠"源会话不动 + 段级溯源"兜底）；多代 merge 上下文语义衰减（见 §3.7 已知限制） | ✅ 推荐 |
| B. v3 fast-merge（活跃会话三件套现场生成差异摘要进 composer） | 差：绑定单活跃会话，N>2 或离线场景不成立；摘要结果是一次性文本，无结构留存，G3/G4 不成立 | 低（v3 已有完整 spec 与部分基建） | 若用它，§3.1 的成功路径变成"用户得先把三个会话轮流打开、手动触发、手动拼贴"——批量收敛不成立 | ❌ 否（其 composer 预览编辑交互吸收进 A 的确认步骤） |
| C. 文件级拼接（把各分支 entry 线性 append 进一个新文件） | 差：多分支 toolCall/toolResult 序列交错后配对断裂；prompt cache 全灭；语义上两分支对同一问题的不同回答直接相邻互相污染 | 低 | 若用它，§3.1 例子里 60 条消息全量进上下文，token 与混乱度双爆炸 | ❌ 否 |

### 3.3 关键决策

**D0（术语，先行定义）**
- **entry 树 / 全局树**：单文件内 entry 经 parentId 构成的树；同家族文件因复制保 id，在 id 空间拼合为一棵全局树。
- **LCA**：N 条 root→tip 路径的最长公共前缀末端节点。N>2 时逐层求 pairwise LCA 收敛（树的 pairwise-LCA 满足结合律）。LCA 节点本身归入"共同前缀拷贝区"，不参与摘要。
- **结构锚点**：全局树中孩子数 ≥2 的节点（分叉点）、compaction entry 所在节点、根节点。锚点是**树结构的函数，与任何一次 merge 的参与方无关**——这是缓存稳定性的根基。
- **原子段**：相邻结构锚点之间的极大 entry 链。merge 段（展示与产物引用单位）= 连续原子段的并。
- **familyRoot**：家族根 session 的 **sessionId**（uuidv7，全局唯一、无路径依赖；禁止用文件路径充当——迁移/跨目录场景路径不可靠，且 parentSession 反查本就走子串匹配）。

**D1：merge 输入粒度 = (sessionFile, leafId)，不是 sessionFile**
- **采用**：每个入选会话解析为「root→指定叶」的 entry id 路径。pi 支持文件内分支（TUI `/tree`），同一文件可有多个叶子且 leafId 不持久化（重开时取文件最后一行）；用户想合并的可能不是"最后一行那个叶子"。
- **被否**：仅以 session 为粒度——文件内多叶时语义歧义（Case 6，见 §3.5）。
- **证据**：`dist/core/session-manager.js` `_buildIndex()`（`:671-680`）leaf 取最后一条 entry；slash-commands 含 `{ name: "tree", description: "Navigate session tree (switch branches)" }`。
- **效果**：G1 在任意家族形态下语义确定。

**D2：分段算法 = 并集树切链 + 覆盖集（两步式定义消除循环）**
- **采用**：第一步，对每个入选会话独立解析 root→leafId 路径，按 id 去重合并为全局树 T（同 id 必校验 contentHash，见 E4）；第二步，在 T 上求 N 条路径的全局 LCA，取 LCA 之下的受限子树 U；U 中按结构锚点切成原子段，merge 段 = 连续原子段的并，coverage(merge 段) = 路径经过它的 tip 集合。三条推论保证正确性：(1) 展示段与覆盖集一一对应；(2) 覆盖集自 LCA 向下层叠分裂、永不交叉；(3) 段沿树边连续，toolCall/toolResult 父子节点永不分居两侧，摘要输入恒为合法消息序列（段首若是"没有提问的回答"——从 assistant 消息 fork 所致——摘要 prompt 附带分叉点上下文语境，语境不参与 contentHash）。
- **被否**：按分支整条摘要——共享主干被重复计费且多次摘要可能互相不一致，污染最终综合。
- **证据**：树路径在 LCA 之后永不重逢（树的定义）；fork 复制保 id 使跨文件建树退化为 id 去重（✅ 已核 `session-manager.js:1091` `{...entry}` 浅拷贝仅重链）。
- **效果**：G3 的去重基础；§3.1 成功路径中「B 主干由 C、D 共享」的展示即来自 coverage。

**D3：双层缓存模型——原子段为缓存单元，劈开降级为参考**
- **采用**：缓存键 = `(startAnchorEntryId, endAnchorEntryId, contentHash, summaryPromptVersion)`，单元是**原子段**（结构锚点间），不是任意 merge 段——锚点由树结构决定，与 merge 参与方无关，因此跨 merge 稳定。匹配规则三级：① **精确命中**：merge 段覆盖的全部原子段均有缓存 → 直接聚合复用；② **参考复用（降级）**：某原子段因后续 fork 制造了新分叉点而被劈开（例：Case 2 后从 D 第 28 条消息 fork 出 F，原原子段 `(21d,35d)` 被劈成 `(21d,28d)`+(`28d,35d)`），旧条目按 id 区间包含关系匹配为"参考摘要"，仅供 combine 引用并在 UI 标注「基于旧边界」，不计入命中率统计；③ **miss**：fresh 摘要。意图相关的取舍综合只在最后一次 fresh 的 combine 调用做；段摘要 prompt 保持事实性（做了什么/结论/产物/未决问题），prompt 版本号进键防新旧口径混排。缓存存储于 sidecar `<getDataDir()>/merge-cache/<familyRoot>.json`（路径动态推导），加载时剔除源文件已删的死条目、LRU 上限淘汰，写入经 file-lock + tmp+rename 原子替换。
- **被否**：缓存键含 merge 意图/参与方——泄漏偏置且命中率大降；单层 merge 段粒度（v1 设计）——LCA/tip 随每次 merge 变化，「从任意消息 fork」系统性击穿命中（审查 MF-1 反例：F 从 D@28 fork 后 `(21d,28d)` ≠ 缓存中的 `(21d,35d)`）。
- **证据**：append-only 文件一旦 tip 固定内容不可变；锚点稳定性源于树结构不变性（已有分叉点永不消失，新 fork 只会增加锚点/劈开旧段，两种演化都有对应的缓存策略）。
- **效果**：G3 的完整承诺——结构性共享必命中、演化场景优雅降级；Case 3 与"从任意位置 fork"两个剧本都有确定性答案。

**D4：产物 = createBranchedSession(LCA) 新文件 + 固定布局 `marker ← branch_summary`**
- **采用**：产物分支挂在 LCA 下（与被合并分支成兄弟）。LCA 之后固定追加两个 entry，顺序不可变：先 `custom("taiji.branch-merge")` marker（parentId=LCA，承载 `{schemaVersion, familyRoot, parents:[{file,tipEntryId}], lcaEntryId, segments:[{from,to,coverage,atomicRefs}], intent?, createdAt, usage}`），后 `branch_summary`（parentId=marker.id，fromId=LCA、summary=综合摘要正文、details=段级引用数组）。**布局理由：文件最后一行必须是 branch_summary**——pi 的 leaf=最后一条 entry，若 marker 收尾则 leaf=marker，用户续聊会挂到 marker 上、TUI /tree 与渲染层都会把 marker 当叶子。custom entry 被 pi 明确"不参与 context"（dist 源码注释，未知类型静默跳过），故 marker 安全嵌入而 branch_summary 独占 leaf 承载 LLM 可见摘要。marker 是 merge 拓扑的唯一真相源，随文件走。
- **被否**：marker 收尾（leaf 错位，审查 MF-2）；挂某个 tip（git 双亲风格）——pi 单 parent 表达不了；自造全新 entry 类型——绕开 pi 校验面无收益。
- **证据**：`_buildIndex` leaf 取最后 entry（`:671-680`）；`branch_summary` 字段 fromId/summary/details/usage/fromHook（`:1053-1066`），进 context 条件 = 位于 root→leaf 路径且 summary 非空（`:182-183`）；taiji 渲染三层消费链完备（`session-entry-mapper.ts:89-94` → `apply-entry.ts:264-285` → `effects/registry.ts:565-583`）；runtime 直写 JSONL 先例 `session-fork.ts:74-180`（命名 `<ISO时间戳>_<uuid>.jsonl`，产物命名与其对齐）。
- **效果**：G1（新分支可继续对话且摘要进 context）、G2（源不动）、G4（marker 即画布边数据）；Case 8 的"merge 再 merge"中 marker/summary 天然落在 LCA 之后的独立区域，切段规则见 Case 8 更新。

**D5：multi-parent 反向索引 = 扫描时构建，不加第二真相源**
- **采用**：SessionScanner 扫描时解析各文件的 marker entry（解析失败降级为"无边"并 log，永不因 marker 异常中断扫描），构建 family index 扩展边（`mergeRefs: Array<{mergeFile, familyRoot, parents[]}>`）。画布要的"merge 多父边"从索引派生。
- **被否**：把 multi-parent 写进 `.meta.json` sidecar——制造第二真相源，与 marker 可能失同步。
- **证据**：family index 已有同构先例（`extensions/universal/session-reader/src/core/family.ts` 的 `buildFamilyIndex` 从 header 构建，parentSession 子串反查）。
- **效果**：G4 且满足"元数据与会话分离但不分裂"。

**D6：merge 对现有家族严格只读 + 三道入口预检；摘要计算走 withEphemeralPi（session-dir 指向临时目录）**
- **采用**：入口预检三连——① 活跃/生成中会话拒绝（pi session 延迟写入约束下，磁盘尾部可能落后内存态，只读磁盘会静默丢最新内容，违反 G2）；② 源文件不存在（首次 flush 前的 ENOENT 态）拒绝并点名；③ 快照 TOCTOU 防护——执行时刻重拍快照，tip 有变化则二次确认。摘要计算用短命 pi 进程一段一轮，**其 session-dir 显式指向临时目录**（防止 ephemeral 会话落进真实 sessions 目录被 scanner 收录成幽灵会话）。唯一写动作 = 新建产物文件（tmp 目录组装 + rename 到位，见 D9）。
- **被否**：复用某个活跃会话发 prompt 做摘要——污染上下文且有并发风险；直连 LLM API——runtime 无此通路；"读到什么算什么"的裸快照——丢尾部内容无提示。
- **证据**：constraints C-pi-08（constraints.json :170，v1 误写 :212）登记短命 pi 进程模式；C-pi-10（:211，v1 误写 :171）延迟写入约束；scanner 内存 Map 合并显式补偿延迟写入窗口（`session-scanner.ts:41-53`）——证明"磁盘≠全量"是现实而非假设。
- **效果**：G2 的"不静默缺尾"；E5 失败可重试（D3 缓存使重试零重复）；E6/E7 边界清晰。

**D7：compaction 边界作为结构锚点（软切段点）**
- **采用**：compaction entry 所在节点是结构锚点，原子段在此强制断开（该 entry 归入前段结尾）。摘要 prompt 对 compaction 之后的内容不再展开已被压缩的历史；产物若从该区续接，与源的活跃 KV 前缀对齐更好。
- **被否**：无视 compaction 一刀切——摘要重新细述源会话自己都已压缩掉的内容。
- **证据**：compaction entry 带 `firstKeptEntryId`（dist `:803-813`），压缩发生在 turn 边界（`:202-217`）——锚点处切链不破坏 turn 完整性。
- **效果**：G3 的 cache 维度收益；避免摘要与源会话自我认知矛盾。

**D8：subagent/workflow 会话 v1 不参与 merge**
- **采用**：merge 输入过滤掉 subagent 会话（identity entry 的 rootSessionId/slug 判定），UI 中灰显并注明。
- **被否**：允许 subagent 会话入库——其家族边是执行嵌套（rootSessionId/parentRecordId），与 fork 边语义不同，混入破坏 coverage 层叠性假设。
- **证据**：`execution-tree.ts:42-44` 三类节点与 fork 家族是两套边；全项目 parentSession 写入方仅三处且全为 fork 语义（审查证实），过滤域清晰。
- **效果**：G1 输入域清晰；画布二期区分两类边后再放开。

**D9：同族串行互斥 + 产物 tmp+rename 原子写**
- **采用**：runtime 按 familyRoot 维度串行化 merge 任务（同族排队、异族并行），排队态通过 D10 job 模型暴露（UI 显示「该家族有合并进行中」）；sidecar 与缓存写入一律 file-lock + tmp+rename；**产物文件在临时目录完整组装（header + 全部 entry + marker + branch_summary），一次 rename 到 sessions 目录**，scanner 与 glob 模式天然忽略 .tmp 后缀；应用启动时清理遗留 tmp 半成品。
- **被否**：放任并发——同族双 merge 会产生 sidecar 读改写竞态、重叠段双倍 LLM 成本、ephemeral 进程翻倍触发限流；产物逐步 append 写入——中途崩溃留下"header 有效 + 部分行"的幽灵会话，且 marker（merge 身份的唯一标志）恰是最后写入的，半成品无法事后识别（session-fork.ts 先例亦无原子写，不能照抄规避）。
- **证据**：split mode 双 pane 组件多实例是项目现实（AGENTS.md 关键规则 2 的立规前提）；`extensions/shared/file-lock` 已有共享库可直接复用。
- **效果**：G2 的"放弃零残留"；E6 从"撞名兜底"升级为"结构性不可能"。

**D10：mergeJob 是一等标识，进度走主动拉取**
- **采用**：每次 merge 创建 `mergeJobId` 作为进度广播与查询的主键（进行中时产物 sessionId 尚不存在，不能拿会话 id 当主键）；broadcast 事件带 `mergeJobId` + 发起源 pane 的 sessionId（仅作路由提示，非归属）；renderer 除订阅外必须支持 `getMergeJobs` RPC 主动拉取（对齐项目「广播早于订阅须主动拉取」的既有解法，如 session.getCommands 先例）。job 状态机：`detecting → segmented → summarizing(per-segment progress) → combining → writing → done | failed(cancelled)`，携带每段 fresh/hit/reference 分类计数。
- **被否**：进度挂在发起 pane 的 active session 广播上——切走即丢，且违反 per-session 隔离精神（ADR-0049）；纯推送无拉取——广播时序竞争下首帧丢失。
- **证据**：AGENTS.md 关键规则 7（runtime→前端消息必须带 sessionId）与架构约定「Runtime broadcast 时序竞争 [HISTORICAL]」；merge 是分钟级任务，进度即交付物（S2 直接断言进度文案）。
- **效果**：G1 的进度可见性在任何 pane 状态下成立；S2 验收有了可断言的事件载体。

**运行时行为断言与探针**

| 断言 | 状态 | 探针 |
|------|------|------|
| fork 复制保留 entry id（跨文件同 id 同内容） | ✅ 已测 | dist `createBranchedSession`/`forkFrom` 源码 + 真实家族文件比对（前置调研完成，审查复核 `:1091` 证实） |
| custom entry 不进 LLM context、未知类型静默跳过 | ✅ 已核 | pi dist 源码注释（`:164`）+ 跳过逻辑（`:185-187`）；M3 spike 附带 round-trip 断言兜底 |
| 直写的 `branch_summary`/`custom` entry 被 pi open + `get_entries` 正常解析，且固定布局下树 UI 正确（leaf=branch_summary） | ⛔ 实施期门 | M3 spike：手写最小产物文件 → withEphemeralPi open → get_entries 比对 round-trip + 树形态断言；另比对直写产物与 pi 原生 fork 产物在 SessionScanner/family index 中行为一致 |
| `branch_summary` 进入后续轮次的 LLM context | ⛔ 实施期门 | 同 spike：open 产物后发一条 "summarize what you know"，检查请求 messages 是否含摘要文本 |
| 产物续聊命中源会话前缀 KV cache | ⛔ 软观测（非门禁） | **runtime 现无 cache-stats/cachedTokens 查询通路**（审查证伪 v1 的 S5 前置依赖），需先实现观测口再采集；数值仅作优化线索 |

### 3.4 错误规格

| 错误 | 检测时机 | 用户可见表现 | 恢复指引 | 内部处理 |
|------|----------|--------------|----------|----------|
| E1 无公共祖先 | 步骤 1 建树时 | 「X 与 Y 没有共同的 fork 来源」；N>2 部分连通时按连通分量分组提示 | 取消选择不相干会话后重试 | 逐对 parents 链回溯定位不连通组，错误信息点名具体会话 |
| E2 祖先-后代退化 | 步骤 1 LCA==某输入 tip 且该输入增量为空 | 「A 是 B 的祖先，直接继续 B 即可」 | 打开 B 继续 | 拒绝执行，零副作用 |
| E3 单段超长（>阈值如 200 条） | 切段后 | 该段标「较长，正在分段归纳」 | 等待或取消 | map-reduce 二次切块；切块边界避开结构锚点，**子块键 = 父段键 + 块序号 + contentHash**，父级摘要缓存不受影响 |
| E4 entry id 碰撞（同 id 不同 contentHash） | 建树去重时 | 同一路径内碰撞：「会话数据异常，已中止」（fail-fast）；跨路径碰撞：UI 黄条警告「检测到罕见 id 重复，已按文件消歧」继续 | 导出诊断信息反馈 | 默认按 (id, 所在文件) 二元组建树消歧（8-hex 随机 id 家族万条级碰撞概率约百分位，审查核实生成方式为 randomUUID 前 8 位均匀随机）；仅碰撞落在同一切段路径上才拒绝该 merge |
| E5 段摘要 LLM 失败 | 摘要阶段 | 该段标红「LLM 超时」 | 重试该段 / 整体取消 | 已完成原子段已在缓存，重试零重复 |
| E5b combine 失败 | 综合阶段 | 「汇总生成失败」 | 仅重试 combine（段缓存完好，秒级重试） | combine 不写段缓存 |
| E6 产物落盘失败 | rename 报错 | 「合并结果创建失败，请重试」 | 重试 | tmp 组装 + rename 结构性消除撞名与半成品；启动清理遗留 tmp |
| E7 源会话不可用 | 入口预检 | 「C 正在生成中，请稍后再合并」/「C 尚未有持久化记录」 | 等待生成完成 / 向该会话发送一条消息促使其落盘后再试 | 活跃态与 ENOENT 态分别点名；不阻塞其他入选会话的检测展示 |
| E8 TOCTOU tip 变化 | 执行时刻重拍快照 | 「C 自检测后有新消息，将按最新内容合并」确认框 | 确认继续 / 取消重检 | 以执行时刻快照为准，marker 记录实际使用的 tipEntryId |

### 3.5 Case 对照表（算法行为规格，兼作 §4 验收蓝本）

| Case | 场景 | 算法行为 |
|------|------|----------|
| 1 基线两分支 | A@10 fork 出 B、C | LCA=10；两段各 coverage={B}/{C}；无去重收益但正确性无损（树性质：LCA 后路径不重逢，N=2 必然无共享） |
| 2 三分支嵌套 | A→B→{C,D}，A→E，merge(C,D,E) | LCA=10；段 `11b-20b`(coverage {C,D})、`21c-30c`({C})、`21d-35d`({D})、`11e-15e`({E})；共享主干只摘要一次 |
| 3 二次 merge 复用 | Case 2 后 F 从 D 的 tip@35 fork 并推进，merge(F,C) | LCA=20；`21c-30c` 精确命中；F 路径中 `21d-35d` 精确命中（coverage 变化不影响键）；仅 F 新增量 fresh 摘要 |
| 3b 劈开降级 | Case 2 后 F 从 D 的**中间**第 28 条 fork，merge(F,C) | 原子段 `(21d,35d)` 被新分叉点 28d 劈成 `(21d,28d)`+`(28d,35d)`，双双 miss；旧条目按区间包含匹配为「参考摘要」进 combine（UI 标注基于旧边界）；仅 `(28d,...)` 之后的真正新增 fresh |
| 4 无 LCA | 不同族 X、Y | E1，拒绝 |
| 5 fast-forward | A 停在 10，B 从 A@10 fork，merge(A,B) | E2，拒绝（A 增量为空） |
| 6 文件内多叶 | A 内 `/tree` 分叉出 15a/13b 两叶，C 从 13b fork | 按 D1 要求指定 leaf；默认值=文件最后一行并在 UI 明示 |
| 7 compaction | B 中途压缩过 | compaction 节点为结构锚点强制切段（D7） |
| 8 merge 再 merge | merge(M1(C,D), E) | 产物文件的 marker+branch_summary 区域是 LCA 之后的固有结构；切段规则：**遇 `taiji.branch-merge` marker 强制切出独立"merge 遗产段"**，透传其 segments 元数据给 combine prompt（"这是 C+D 的合并结果及其段清单"），不做盲目的摘要套娃；M1 若在 summary 之后继续了新对话，新对话部分按普通原子段处理 |
| 9 同族并发 | 双 pane 同时对 {C,D,E} 发起 merge | 后到者进入排队态（D9），UI 显示「该家族有合并进行中」；先到者完成后队列自动执行，此时其检测结果基于重拍快照（E8 兜底） |

### 3.6 merge 执行物理数据流

```
[磁盘] A/B/C/D/E.jsonl ──预检(D6)+只读快照──▶ runtime merge orchestrator (job=D10)
                                        │ 1. 解析 root→leaf 路径（D1）
                                        │ 2. id 去重建全局树（E4 消歧）→ LCA
                                        │ 3. 结构锚点切原子段 → merge 段 + coverage（D2/D7）
                                        ▼
                  [原子段列表] ──查──▶ [sidecar 缓存] 三级匹配（D3：精确/参考/miss）
                                        │ miss 段
                                        ▼
              withEphemeralPi × k（并行、临时 session-dir，D6）──段摘要──▶ file-lock 写回缓存
                                        ▼
              combine（fresh 一次；intent 来自可选输入框；消化参考摘要）
                                        ▼
        [tmp 目录] 组装完整产物文件：header(parentSession=源绝对路径,与 pi 格式对齐)
                   + entries[1..LCA 拷贝] + custom taiji.branch-merge(marker)
                   + branch_summary(summary, fromId=LCA)   ← 收尾，leaf=summary（D4 布局）
                                        ▼
        rename → sessions 目录（D9 原子到位）；lastMergedAt 回填；job=done
                                        ▼
        SessionScanner 下轮扫描 → family index mergeRefs（D5）→ renderer sidebar/未来画布
```

### 3.7 已知限制（诚实声明）

1. **多代 merge 语义衰减**：M2 = merge(M1, X) 的产物 context 里只有 M1 的摘要而非 C/D 原文；物理上始终可溯源（marker 链），但上下文细节逐代衰减。缓解：marker 透传段清单给 combine（Case 8），必要时用户可打开源会话 cherry-pick 原文（二期）。
2. **摘要有损**：段摘要必然丢弃部分细节；G2 的"不丢信息"指源文件不动与可溯源，不指产物上下文保真。
3. **参考复用的陈旧风险**：3b 场景的旧边界摘要有过期可能，UI 明示「基于旧边界」并由 combine 消化，不保证与 fresh 摘要同等新鲜。

---

## §4 验收（真实场景，非 mock）

以下场景在真实 taiji dev 环境（`pnpm dev`）+ 真实 pi 会话家族上执行；测试家族用真实对话跑出来（每分支 ≥8 轮、含工具调用），不用手工伪造 JSONL。

| # | 场景（谁/做什么/看到什么） | 通过标准 | 回溯 |
|----|------------------------------|----------|------|
| S1 | 用户按 §2.4 家族（A→B→{C,D}，A→E，各分支真实对话含 bash 工具调用）多选 C、D、E 执行 merge；打开产物会话继续问「目前哪些事还没做完？」 | ① 产物 sidebar 显示且 fork 源为 A；② 首屏可见合并摘要与来源清单；③ 模型回答引用了 C/D/E 三方各自的未决项（证明三方内容进入 context）；④ marker 的 segments 与**建库时录制的 golden snapshot** 一致（段数/边界/coverage；不用硬编码"恰为 4 段"以防真实数据插入 compaction）；⑤ 关闭重开产物会话，对话流一致（AGENTS.md 关键规则 9，branch_summary 自动走 live+reload 双通路）；⑥ 产物文件最后一行为 branch_summary，get_tree 中 leaf 指向它 | G1 G2 |
| S2 | 在 S1 完成后，从 D 继续对话若干轮、fork 出 F，再 merge(F, C)；随后重复发起第二次同族 merge | 第一次：进度事件（mergeJobId 标识）中段计数显示 `21c-30c` 与 `21d-35d` 为 hit、仅 F 新增量为 fresh；第二次：整单排队提示后正常执行。断言对象是 job 进度事件中的 fresh/hit/reference 计数字段（可观测），不数进程 | G3 |
| S2b | Case 3b 剧本：F 从 D 中间第 28 条消息 fork，merge(F, C) | 进度显示旧 `(21d,35d)` 段为 reference（UI 标注「基于旧边界」），新增量 fresh；产物 marker 中该段 atomicRefs 含降级标记 | G3（降级路径） |
| S3 | 多选两个各自 `/new` 出来的无关会话执行 merge | 立即出现 E1 文案并点名两个会话；确认无任何新文件产生（目录 diff 为空，含无 tmp 残留） | G2（负路径） |
| S4 | 多选 A（停在 fork 点未继续）与其子 B 执行 merge | 出现 E2 文案引导直接用 B；无产物产生 | G2（负路径） |
| S5 | S1 的产物会话续聊 3 轮，用 KV cache 观测口（需先实现 cached tokens 查询，见探针表⛔）对比源会话同前缀 | 产物首轮 cached tokens 显著高于零；记录基线数值。**软观测项：不达标不阻断发布，只立优化项** | G3（软观测） |
| S6（反向） | 只选 1 个会话、或重复勾选同一会话两次执行 merge | 入口禁用/去重，不产生空 merge 产物 | G1（防过激） |
| S7 | split mode 双 pane同时对同族发起 merge；同时在 merge 进行中对源会话 C 追问一轮 | 后到 pane 显示排队态；产物 marker 记录的 tipEntryId 与执行时刻快照一致（C 的新追问不在本次合并范围，E8 生效）；无 sidecar 写坏（file-lock 生效） | G2（并发与 TOCTOU） |
| S8 | merge 进行中 kill runtime 进程（模拟崩溃），重启后检查 | sessions 目录无半成品产物（tmp 清理生效）；sidebar 无幽灵会话；重新发起 merge 正常 | G2（崩溃安全） |

---

## §5 下一层拆分

**实施路径**：M1→M2→M3 串行（M3 内含 spike 门禁），M4/M5 在 M3 过门禁后并行。每步可独立验收：M1 纯函数全单测；M2 缓存逻辑单测 + 假 LLM 注入；M3 过 §3.3 spike 门禁后接 S1；M4 过 S1-S8；M5 过 S1 的 UI 路径。

| 单元 | 内容 | 为什么这么拆 |
|------|------|--------------|
| M1 纯函数核心 | 全局树构建（id 消歧+E4）、LCA、结构锚点切原子段、merge 段聚合、coverage、cacheKey 生成、三级缓存匹配判定。零 IO、零 pi 依赖 | 算法正确性是命根，隔离成纯函数可用 Case 1-9 全量单测，不被 IO/LLM 噪声干扰 |
| M2 摘要编排 | withEphemeralPi 调度（并行/重试/临时 session-dir）、段与 combine prompt 组装、缓存读写（file-lock+LRU+死条目清理）、job 状态机 | LLM 交互与长任务状态是唯二不确定源，单独成单元便于注入假摘要做确定性测试 |
| M3 产物写入 + spike | tmp 组装 + rename、固定布局写入、spike 验证 ⛔ 断言（round-trip、树形态、context 含摘要、与 pi 原生 fork 产物 scanner/family 行为一致） | 直写 JSONL 与 pi 的兼容性是最大未知数，设为早期门禁；失败切换 extension 写入通道不影响 M1/M2 |
| M4 service/RPC + scanner 扩展 | `session.merge` RPC（错误码 E1-E8）、`getMergeJobs` RPC 与 mergeJob 广播、SessionScanner 解析 marker 建 mergeRefs、lastMergedAt 回填 | 复用既有 service 分层；scanner 扩展独立于 merge 执行，画布二期直接吃这份数据 |
| M5 renderer 最小入口 | sidebar 会话多选 + merge 向导（检测/分段 coverage 展示/意图输入/进度/结果/失败文案，吸收 v3 fast-merge 的 composer 预览编辑姿势）、排队与「有合并进行中」徽标 | 交付闭环的最小 UI；画布本体留二期，本期 UI 只服务验收路径 |

**文件改动地图**（新增为主，改动收敛）：

```
packages/shared/src/session-merge.ts                       [新] marker/cacheKey/job/错误码类型
packages/runtime/src/services/session/merge/tree-builder.ts [新] M1 纯函数
packages/runtime/src/services/session/merge/orchestrator.ts [新] M2+M3 编排（file-lock/tmp+rename）
packages/runtime/src/services/session/session-scanner.ts    [改] marker 解析 → mergeRefs；忽略 .tmp
packages/runtime/src/interfaces.ts                          [改] mergeSession/getMergeJobs RPC 声明
packages/renderer/src/composables/features/merge/*          [新] M5
packages/runtime/src/__tests__/session-merge-*.test.ts      [新] M1/M2 单测（Case 1-9 全覆盖）
```

**待验证检查点**（诚实标注，实施期回答）：

1. ⛔ 直写 `branch_summary`/`custom` entry 的 pi round-trip 与固定布局树形态（M3 spike）
2. ⛔ `branch_summary` 进入 LLM context 的呈现形态（决定摘要措辞是否需要前缀引导语）
3. ⛔ ephemeral pi 单段摘要延迟分布 → 决定并行度与 UI 超时阈值；withEphemeralPi 模型选择与 token 成本归因口径（段用量 vs combine 用量在 job 与 marker.usage 中分开记录）
4. ⛔ 大家族（>50 文件）建树耗时 → 决定 scanner 常驻索引 vs merge 时现算
5. ⛔ SessionSummary 是否携带 subagent 标志（决定 D8 过滤在 renderer 侧的数据通路）
