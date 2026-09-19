# Composer 任务托盘（Widget Tray）设计

> **层声明**：本文档是技术方案设计——下一层产物是「可实现的接口/数据模型/组件改动」清单（§5），交给 dev-flow 落地。
>
> **P 级与风险分**：触及最高 P 级 = **P0**（subagent/workflow 面板与派发，FEATURE-PRIORITIES §2；Composer 输入面 P0）。风险分 = **10/10** = P0 基数 9 + 协议变更修正 +1（WidgetMeta/tab-bar 扩展，向后兼容小版本）+ 新颖度修正 +1（托盘范式仓内无先例），clamp 10。P0 面在迁移窗口内被重排（观察入口从侧栏迁到 composer），回归风险是本设计最高风险源，验收与拆分按此倾斜资源。
>
> **视觉依据**：`docs/DESIGN.md` §3.5.2 信号编排（常态归零/异常优先）、§3.5.4（去掉只服务于习惯的元素）、§5.6 状态指示、§5.7 图标 scale。产品依据：`docs/PRODUCT.md`「成功标准 = 用户可以在不离开当前工作上下文的情况下，掌控所有并行任务的执行状态」——本设计是该成功标准的直接落地。

---

## §1 背景目标

**SCQA**：用户在 taiji 中让 agent 并行执行多个 subagent / workflow / 后台命令（情境）；但所有任务观察入口都住在左侧栏的独立 tab 里（Agents/Flows/后台命令 L2 视图），看一眼任务状态需要把视线和点击从 composer 工作区搬到侧栏再搬回来（冲突）；如何让用户**不离开当前工作上下文**就掌握全部并行任务状态，并让未来一切任务型 widget 有一致的挂载位置（问题）？在 composer 工具条左簇建一个常驻的任务托盘：进行中的任务以 icon+计数实时可见，hover 即得全量面板，builtin 三类任务可直接操作（答案）。

**系统是什么**：taiji 是 Electron + Vue 3 的 AI Agent 桌面工作台。与本文相关的既有机制：

- **Panel / Composer**：每个 Panel 绑定一个 session，底部是 Composer（输入框 + 工具条）。工具条 `composer-bar` 现有布局：左簇 `[+ 添加]`（AddMenuPopover）+ 任务托盘（`ComposerTray`）+ extension toolbar 挂载点（ViewHost `composer.toolbar`）→ 弹性空隙 → 右簇（生成指标 / 上下文容量 / 模型 / 思考等级 / 发送位）。底栏形态由密度状态机驱动（三簇 + 按序退化 + 溢出兜底，见 D16）。源码 `packages/renderer/src/components/panel/Composer.vue`。
- **任务观察入口（现状）**：左侧栏 segmented tab 五枚（会话/文件/Agents/Flows/Plugins）。Agents tab = SubagentList（三视图筛选：全部活跃/只看正在跑/已收起）、Flows tab = WorkflowList + WorkflowDetail 详情视图；后台命令是 Plugins tab 下的 L2 视图（`BackgroundTaskListView`，经 NATIVE_VIEWS 路由）。任务详情的深度检视归宿是右侧 drawer（subagent / workflow / bashTask 三 tab；现状：subagent 与 bash 卡片/行点击开 drawer，workflow 卡片进 Flows tab 内 detail 视图——本设计将 workflow 详情统一收口 drawer，见 D2 归宿变更）。另有一个消费面：对话流内 WidgetArea pill（todo/goal 状态带，`getViewIds` 唯一现役消费方；L2 tab 走 VIEWS_SOURCE 静态贡献声明，widget 不进 sidebar）。
- **对话流内 subagent/workflow 内联块**：subagent-workflow extension 推的 `details.__gui__`（GuiComponentRenderer 渲染），属对话历史内容（tool call 记录），非观察入口。
- **widget GUI 协议（已存在）**：pi extension 调 `ctx.ui.setWidget(key, [GUI_WIDGET_MARKER + JSON{v, component, meta}])` → taiji runtime event-adapter 解码 → WS 帧 `extension:widgetGui` → core `ViewHostStore.setView(sessionId, viewId=key, {guiTree, meta})`。渲染消费端经 inject `VIEW_HOST_SOURCE_KEY` 取 `getViewIds(sessionId)` / `getView(sessionId, viewId)`，用 `GuiComponentRenderer` 渲染 `GuiComponent` 树（协议原语：list-tree / stats-line / progress-bar / group / card / columns / tab-bar / ansi-text / custom）。**`setWidget(key, undefined)` = 清屏 → invalidate 该 viewId。** 关键概念锚定：**widget key** 就是 extension 调 setWidget 时传的第一个参数（如 todo extension 恒用 `'todo'`、goal 恒用 `'goal'`），在 ViewHostStore 中即 viewId——它是托盘识别一个 widget 的唯一标识。

**设计目标**（从使用者体验倒推）：

1. **视线不离开工作区**：agent 派发了 3 个 subagent + 1 个 workflow + 2 个后台命令时，用户在 composer 工具条上直接看到六个进行中计数；hover 任一 icon 弹出该类任务的完整面板（分桶列表），可就地 kill/cancel/abort（pause/resume 已随 workflow 一次性生命周期退役，见 §4 A2b 修正标注），点行开 drawer 详情。
2. **todo/goal 及未来 widget 统一挂载**：extension 推 setWidget 即在托盘出现（icon + badge + 面板 = 协议渲染），不要求 extension 写任何 taiji 定制代码；未来任何任务型 widget 自动获得挂载位。
3. **常态归零**：无进行中任务、无活跃 widget 时，托盘不制造任何视觉噪音（空闲但有历史 = dim 常驻可查看；彻底无记录 = 隐藏）。
4. **入口唯一化**：同一任务类型只有一个**常驻观察入口**（侧栏任务列表退役，托盘为唯一列表/计数面）——drawer 详情 tab 与对话流内联块属内容呈现（深度检视 / 历史记录），不在此列；消灭「侧栏 tab 数 vs 托盘计数不一致」这类双口径穿帮面。

**设计输入裁决记录**（用户在 demo A/B/C/C2/C3/C4 六轮迭代中逐条裁决，本文机制立于这些记录在案的需求之上）：①托盘挂 Composer 左簇，built-in 三件（后台命令/子代理/工作流）固定最左，todo/goal 作为默认 widget 走 GUI 协议跟后，未来 widget 追加尾部；②goal 单目标；③todo 面板用 tab 形态（待办/已完成切换，非堆叠长列表）；④WidgetArea pill 删除；⑤托盘 icon **允许 extension 自定义形状，但风格由宿主锁死**（「要让 plugin 自己定义，但要符合现在的风格」）；⑥hover 展开 / 点击 pin 两档交互；⑦空态用可行动策略（提示 + 显式切换，不自动跳 tab）。

**in-scope**：composer-bar 左簇托盘组件（built-in 三件 + 协议 widget 两条目）；WidgetMeta / tab-bar 协议小版本扩展；todo buildGui 加 tab-bar；侧栏五 tab 收敛为三 tab 及组件退役；WidgetArea pill 退役；i18n；单测；e2e 影响面对账。

**out-of-scope**：widget 面板内的人写操作（勾选 todo / 完成 goal——需要 UI→extension 写通道，协议无此能力，现状人侧只读，未来另行设计）；drawer 内 subagent/workflow 详情视图（保留现状，不在本次范围）；Plugins tab 的 plugin sidebar view 机制（保留为挂载点，仅退役任务类 native 视图）；通知链（pending-notifications）改动。

---

## §2 现状与问题分析

**结论：四类任务状态链路各自独立且终点都不在 composer——入口位置跟随了组件实现归属而非使用场景；加上侧栏两级导航与多处重复口径，观察成本高（F1）、认知负担重（F2）、穿帮面多（F3）。**

### 2.1 使用者视角的现状（真实例子）

用户正在 composer 里写下一轮指令，同时 agent 跑着 3 个 subagent、1 个 workflow、2 个后台 bash 命令。此刻：

- composer 工具条上**没有任何任务信号**——发送位右侧只有模型/容量/思考等级。
- 想看 subagent 进度：视线左移 300px 到侧栏 → 点 Agents tab（segmented tab 第 3 枚，icon-only + running 计数）→ 在三视图筛选（全部活跃/只看正在跑/已收起）里找 → 点卡片开 drawer subagent tab。
- 想看 workflow：再点 Flows tab（列表 → 点卡片进 Flows 内的 detail 视图）。想看后台命令：点 Plugins tab → L2 tab「后台命令」→ 点行开 drawer bashTask tab。todo/goal：在对话流底部 WidgetArea pill 上（`[● Todo 2/5 …]`）点开 popover。
- **同一 session 的任务状态分散在 4 个不同入口**，其中 3 个在侧栏、1 个在对话流。

### 2.2 真实失败模式

- **F1 观察成本高（高频操作低效）**：长任务期间「看一眼进度」是分钟级高频动作，但每次都要完成「视线转移 + tab 切换 + 找到目标」三步。PRODUCT.md 的成功标准（不离开当前工作上下文掌控并行任务）在现状下不成立。
- **F2 入口认知负担**：五枚 icon-only segmented tab（会话/文件/Agents/Flows/Plugins）+ Plugins 下再藏 L2 视图（后台命令）——两级导航承载任务观察；「后台命令在 Plugins 里」对新手是反直觉埋藏（Plugins tab 的语义是插件，不是任务）。
- **F3 双口径穿帮面**：SegmentedTab 的 running 计数（useSidebarCounts）与列表内筛选计数、与对话流内 subagent 内联块，是三处独立呈现；todo/goal 的 pill 与（未来的）任何新入口同理。每加一个观察入口就加一处「数字不一致」的风险面。
- **F4 widget 挂载位收敛于对话流**：WidgetArea pill 挂在对话流尾部（Panel.vue composer-band 之前），把「agent 工作记忆状态」（todo/goal）混进对话内容流——用户读对话时被 pill 行打断；且 pill 的信息（首个 running 项预览）与托盘面板高度重叠，是 F3 的一个实例。

### 2.3 根因分析

任务观察入口的**位置**跟随了组件的**实现归属**而非使用场景：subagent/workflow 列表是 renderer sidebar 组件所以进侧栏 tab；后台命令视图是 extension-host native 视图所以进 Plugins L2；todo/goal 是 widget 协议所以进对话流。而使用场景上它们是同一类东西——「这个 session 正在发生什么」——都应在用户注意力所在处（composer）一键可达。缺的不是数据（三套 store/协议链路都现成），是一个**统一的、跟随注意力的挂载点**。

### 2.4 现状数据流（任务状态 → 用户眼前）

```
bash 后台命令:  pi extension(base-tool-enhance) → runtime registry
                 → WS backgroundTask.list / backgroundTask:updated
                 → useBackgroundTasks(per-session 分区) → BackgroundTaskListView(Plugins L2)
subagent:       runtime SUBAGENT_RECORD 广播 → subagentStore.recordsOf(sid)
                 → useSidebarCounts → SegmentedTab 计数 / SubagentList
workflow:       runtime WORKFLOW_RECORD 广播 → workflowStore.recordsOf(sid)
                 → useSidebarCounts → SegmentedTab 计数 / WorkflowList
todo/goal:      extension setWidget → event-adapter → WS extension:widgetGui
                 → ViewHostStore(sessionId, viewId) → WidgetArea pill(对话流) / L2 tab
```

四条链路四个终点，全部不在 composer。

---

## §3 解决方案

**结论：在 composer-bar 左簇建 ComposerTray——built-in 三件（bash/sub/wf）native 直连既有 store，协议 widget（todo/goal/未来一切）作为 ViewHostStore 第三消费端零适配挂载；WidgetMeta 扩展 icon/badge、tab-bar 容器化承载本地切换；侧栏收敛三 tab，WidgetArea pill 与任务列表全部退役。** 终态交互先行，机制决策在后。

### 3.1 终态（使用者视角）

**场景 A（并行任务进行中）**：用户盯着 composer 写指令，工具条左簇（`[+ 添加]` 右侧）是托盘：`[term²] [bot³] [flow¹]`——三枚 icon 各带一个亮着的 mono 计数与呼吸点（accent）。用户 hover `bot³`，160ms 后弹出面板（宽 400px，锚定 icon 上方）：「进行中 3 | 已结束 5」两 tab（默认进行中），每行 = 引擎 icon + slug + task 摘要 + 耗时，行首状态位 streaming spinner（引擎 icon 位，与状态点互斥同位）；**pin 后**行内出现 cancel 按钮（两段式：首击变红确认、再击发令）。点击行 = 开 drawer subagent tab（并排详情，与现状卡片点击同归宿）；kill/abort 同理操作后行状态流转（workflow 行内仅 abort 两段式——pause/resume 已随扩展 D-2 一次性生命周期移除，见 §4 A2b 修正标注）。移开 240ms 收起；点击 icon = pin 固定（Esc 或点外部解除）。用户全程没有离开 composer 视区。

**场景 B（todo/goal widget）**：同一托盘，built-in 三件右侧：`[☑ 2] [◎ 42%]`——todo icon 带 badge「2」（未完成数），goal icon 带 badge「42%」（token 预算百分比）。hover todo icon：面板头部 = title「Todo」+ 状态点 + 进度「2/5」mini bar（`WidgetMeta` 渲染），body = tab-bar 原语（待办 N | 已完成 M）+ 待办 list-tree；用户点「已完成」tab，面板本地切换（不请求 extension）。AI 清空 todo → widget 清屏 → 托盘 icon 消失。goal 终态（complete）→ 同样消失（终态折叠进 status bar 是 goal extension 现状）。

**场景 C（空闲）**：全部任务结束、todo/goal 清空后，托盘只剩 `[term] [bot] [flow] [sess]` 四枚 dim icon（有历史可查，无计数无呼吸点）；彻底无记录的类（如本 session 从未跑过 workflow）icon 隐藏。新 session 冷启动：托盘空，视觉零噪音。

**场景 B2（调度模式：派发的子会话）**：主 agent 在调度模式下派发 3 个子会话——托盘第 4 件 `[sess³]` 亮起 accent 计数 + 呼吸点；hover 弹出面板（400px），每行 = 状态点 + label + cwd 末段 + 时长；pin 后行内出现「打开」与「停止」（两段确认）；点行 = 跳到该子会话。用户不离开当前 composer 即掌握派发进度。

**失败路径与恢复**：

| 失败 | 表现 | 恢复 |
|---|---|---|
| widget guiTree 解码失败 | 该 widget 面板显示协议错误占位（ansi-text 兜底），托盘 icon 不消失 | extension 修复推送后自动恢复；`~/.pi/agent/logs/` 查扩展日志 |
| 后台命令 list RPC 失败 | 保留缓存不虚报（fetchFailed 置位）；断连时面板顶部显示断连提示条（沿用 S6 范式） | WS 重连边沿自动重拉（useBackgroundTasks 既有恢复腿） |
| subagent/workflow 广播丢失或切 session 后未拉取 | 面板数据滞后（计数冻结不虚报） | 托盘挂载即 watch sessionId 触发首拉（useTrayCounts 内，useBackgroundTasks 同范式，见 D13）；面板内 retry 按钮 |
| 自定义 icon paths 非法 | 落 icon fallback 链下一档（内置 widgetKey 映射 → 通用 icon）+ console warn 一次（去重） | extension 修正 paths（白名单字符集见 D4；精确字符集以协议文档 §3.5 为准） |

### 3.2 方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 侧栏内优化**（默认 tab 改「进行中」、tab 排序、计数强化） | 不解决 F1（入口仍在侧栏），F2/F3 原样 | 低（改现有组件） | 4/10（P2 面） | ❌ |
| **B. 右侧 Drawer 收口**（任务面板进 drawer，L1 icon 栏常驻） | drawer 是「针对当前焦点的深度检视」定位，塞入任务观察与其「按需展开」范式冲突；且 drawer 与 composer 分居两侧，F1 只缓解 | 中（drawer 已有 subagent/workflow tab 骨架） | 6/10（P1 drawer 面回归） | ❌ |
| **C. Composer 左簇托盘**（本设计 C4 终态） | 挂载点跟随注意力；协议 widget 获得通用挂载位（第三消费端），未来 widget 零适配进托盘；入口唯一化消灭 F3 | 中高（新组件 + 协议小版本 + 侧栏退役迁移） | 10/10（P0 面迁移窗口回归） | ✅ |

被否方案演算：若用 A，§3.1 场景 A 的用户仍需「视线左移 + tab 切换」，F1 不成立；若用 B，场景 A 变成「点 drawer L1 icon → drawer 展开 → 找 tab」，点击数与现状持平且 drawer 常驻挤占 main 宽度（DESIGN.md §3.1 默认极简冲突）。C 的历史 demo 迭代（A/B/C/C2/C3/C4 六版 HTML demo，用户逐轮裁决）已收敛于 C4：built-in 三件最左 + 协议 widget 其后 + pill 删除。

### 3.3 关键决策与权衡

**D1：托盘挂 composer-bar 左簇，两类条目构成（选定）**
- **采用**：`Composer.vue` 的 `.composer-bar` 在 `AddMenuPopover` 之后插入 `ComposerTray` 组件（`v-if="sessionId"`，landing 态隐藏与 GenStats 同判据）；条目 = built-in **四件**（bash → subagent → workflow → session 子会话，固定序）+ 协议 widget 区（known-order `['todo','goal']` → 未知 key 按 ViewHostStore entry 序号排尾部）。
- **被否**：挂 Panel 顶部状态条（新增横行，占对话流纵向空间）；挂 drawer（方案 B）。
- **证据**：composer-bar 现有左簇锚点 `AddMenuPopover` + `ViewHost composer.toolbar`（Composer.vue L114-122）；demo C4 用户裁决。
- **效果**：§1 目标 1 成立（视线零转移）。

**D2：built-in 四件 = native 组件直连既有 store（选定）**
- **采用**：托盘内四枚 icon 与面板由 Vue 原生组件实现，计数/列表/操作直连既有数据链路——bash：`useBackgroundTasks`（per-session 分区，拉取+广播双腿）+ `background-task-bucket` SSOT（二桶 active/ended + all 筛选值；托盘面板两视图「运行中/已结束」由 SSOT 谓词派生）+ kill 两段式；subagent：`subagentStore.recordsOf(sid)` 过滤 `origin!=='workflow'`，**面板两视图（用户裁决 2026-09-16：执行状态对用户只有两态，「已收起」不以第三状态呈现；同日终裁全链路删除该机制）**：进行中 = `isRunningProjection`（running 且无 stopReason）、已结束 = `!isRunningProjection`（含 idle 与死亡纳管态 running+stopReason——「已收起」机制（intent 意愿字段 + 归档原语）已随终裁从 shared 契约至 subagent-core 执行层一并删除，收口记录自然落「已结束」桶，message 续聊语义经 status/revive 链不变）；workflow：`workflowStore.recordsOf(sid)`，进行中 = `status === 'running'`（workflow 一次性生命周期 D-2：'paused' legacy 值已删，判据修正见 §4 A2b），已结束 = 其余；**session 子会话：renderer session store 中 `parentAgentSessionId === 当前 sessionId` 的条目（详见 D15）**。操作 RPC abort 已存在（kill / subagent cancel / workflow abort / **session 用 `chat.abort`**——全仓**无** `session.abort` 帧，详见 D15 实施期修正；pause/resume 已随扩展 D-2 移除，见 §4 A2b 修正标注），cancel 的「迟到收口不发 RPC」防误报逻辑自 `useSidebarSubagentActions` 迁入托盘复用。**行点击归宿矩阵**：subagent 行 → `openSubagent` 开 drawer subagent tab（对齐现状）；bash 行 → 设置 `selectedBackgroundTaskId` 开 drawer bashTask tab（对齐现状）；workflow 行 → `setWorkflowView` 开 drawer workflow tab——**归宿变更**（现状侧栏卡片进 Flows 内 detail 视图 2；改 drawer 后并排不遮侧栏，且 drawer WorkflowTab 已复用其 phase 分组逻辑，变更即收敛）；**session 行 → `useSidebar.selectSession` 跳到该子会话（行内 pin 态另有「停止」= `chat.abort` 两段确认）**。drawer 三 tab 骨架已在（PanelContainer.vue），并排详情范式不变。
- **被否**：三件也走 GUI 协议（把 bash/sub/wf 状态序列化成 GuiComponent 推送）——它们是 taiji core 数据不是 extension widget，反向协议化需要 runtime 侧造一个假 extension 推送链，纯增复杂度；且行内操作（kill 两段式等）协议无交互原语承载。两视图丢「已收起」寻回——**[2026-09-16 用户裁决推翻本段保留结论，同日终裁升级为全链路删除]**：原「已收起」（执行层自动归档 + intent 字段）机制已整体删除——UI 无第三状态，执行层亦无该字段与归档原语（markArchived 语义重表达为 markSettledOut 资源收尾）；收口记录落「已结束」桶，message 续聊经 status/revive 链直接生效。
- **证据**：`useTrayCounts.ts`（计数口径终态宿主；设计期证据指针 `useSidebarCounts.ts` 的计数段已随 D10 迁出，该文件仅存退役说明头注）、~~`BackgroundTaskListView.vue` 头注~~（该文件已随 D10 整体删除，其「分桶/计数/排序全消费 SSOT」纪律由 bash 面板的 `background-task-bucket` 谓词消费实现承接）、FEATURE-PRIORITIES §2（subagent/workflow 面板 = P0，迁移期必须保数据链路不动只换皮）。
- **效果**：§1 目标 1 的操作面成立；P0 数据链路零改动降低迁移风险。

**D3：协议 widget = ViewHostStore 第三消费端，零新注册协议（选定）**
- **采用**：托盘的 widget 区消费 `inject(VIEW_HOST_SOURCE_KEY)` 的 `getViewIds(sessionId)` / `getView(sessionId, viewId)`——**有 entry 即显示、invalidate 即消失**，extension 调 `setWidget` 就是注册、`setWidget(key, undefined)` 就是注销。面板 body = `GuiComponentRenderer` 渲染 `entry.guiTree`（与 WidgetArea popover 现状同渲染器）。托盘不解析 guiTree 语义（除 D5 的 tab-bar 容器约定）。
- **被否**：发明独立 widget 注册 RPC（extension 需新增注册/注销调用）——setWidget 语义已完整覆盖；托盘自建 widget 缓存（与 ViewHostStore 双份真相，必然漂移）。
- **证据**：`view-host-store.ts` IF10 契约（getView/setView/invalidate）；探针 P1/P2（✅ 代码核实，见 §3.6）：todo 清空清屏（`todo/src/index.ts:53`）与 goal 终态清屏（`goal/src/projection/widget.ts:205-218`）——widget 区天然满足常态归零，无需发明隐藏规则。
- **效果**：§1 目标 2/3 成立；未来 widget 零 taiji 适配。

**D4：WidgetMeta 扩展 `icon?` / `badge?`，形状归 extension、风格归宿主（选定）**
- **采用**：协议小版本（向后兼容可选字段）：

```ts
interface WidgetMeta {
  // ... 现有 title / status / progress 不变
  /** 托盘 icon：icon key 字符串（宿主 registry / lucide 名解析）或自定义形状 { paths } */
  icon?: string | { paths: string[] }
  /** 托盘 badge：extension 全权格式化的短文本（'2' / '42%' / '!'），建议 ≤6 字符，宿主超长 truncate */
  badge?: string
}
```

  icon fallback 链：`meta.icon(paths 自定义) → meta.icon(key 解析) → 宿主内置 widgetKey 映射（'todo'→ListChecks、'goal'→Target）→ 通用 widget icon`。badge fallback：`meta.badge → progress.label ?? String(progress.current) → 无`；badge 视觉态（亮/色）归 `meta.status`（running=accent+呼吸点 / done=success / failed=danger / idle=dim），与 built-in 三件计数同视觉语言。**自定义 paths 的风格强制**：宿主渲染统一 `viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="1.75" stroke-linecap/join="round"`——extension 只能定义形状（path d 数组），线宽/颜色/尺寸由宿主锁死，输出必然是太极纯灰体系的细线 icon（与 @lucide 构成同构）。防御：d 字符白名单正则 `^[MLCQAZHVSTmlcqazhvst0-9 ,.\-]+$`（含 S/s/T/t 平滑曲线命令；首版实现遗漏，经 P1 一致性审查实测对 @lucide 全量 d 串约 1% 误拒后放行）、条数 ≤8、单条 ≤512 字符、总数 ≤2048——超限落兜底 icon + warn；渲染经 Vue `<path :d>`（DOM 属性赋值，无 innerHTML 注入面）。兼容性事实（✅ 核实 `helpers.ts:223-227`）：`isGuiRenderResult` 守卫只校验 `v` 与 `component`，不校验 meta 形状——新增可选 meta 字段对旧宿主/旧 extension 双向透明。
- **被否**：受控封闭枚举（extension 不能自定义形状——违反 §1 裁决记录⑤「允许 extension 自定义形状但风格由宿主锁死」，该裁决是记录在案的产品需求非想象未来）；自由 SVG/emoji 字符串（视觉主权失控 + 注入面）；badge 用 number 类型（goal 的 '42%' 证明字符串更通用）。
- **证据**：§1 裁决记录⑤（icon 自定义形状是用户记录在案需求）；`progress.label` 已有「extension 全权格式化」先例（types.ts L123）；lucide 即 24×24 stroke paths 集，混排视觉无缝。
- **效果**：§1 目标 2 成立（extension 两行代码获得风格一致的 icon+badge）。

**D5：tab-bar 原语容器化——本地切换、不回传（选定）**
- **采用**：协议 `tab-bar` props 扩展可选 `sections?: GuiComponent[][]`（与 `tabs` 等长，缺省维持纯展示现状）。渲染器 `TabBar.vue` 升级为容器：渲染 active tab 的对应 section；**active 态归宿主本地**——首次挂载取推送的 `tabs[i].active`，用户点击仅切本地索引（extension 下次推送更新内容但**不重置用户选择**，除非组件重建）。todo 的 buildGui 改为：`tab-bar{ tabs:[待办N,已完成M], sections:[待办 list-tree, 已完成 list-tree] }` + meta 补 icon/badge（**待办段 = 未完成项（pending+in_progress）**，tab 标签计数与 badge 均与该段内容同源；完整清单以两段之并呈现）。
- **被否**：tab 点击回传 extension（协议无 UI→extension 写通道，引入它超出本次 scope 且语义混乱——「用户切了个 tab」不该是 agent 事件）；宿主按行 status 过滤渲染（宿主懂 todo 语义 = 定制逻辑，违背 D3 且对第三方 widget 不可泛化）；堆叠双 section（`group[待办]+list-tree` + `group[已完成]+list-tree`，纯既有原语零协议改动）——被否因 §1 裁决记录③已定 tab 切换形态，且堆叠时已完成段常驻占位，长清单下待办被挤出首屏。
- **证据**：`TabBar.vue` 现状纯展示无 click；todo 面板两桶数据 extension 全知（buildGui 已有 todos 全量）。
- **效果**：todo 两 tab 成立（§1 裁决记录③，真实消费方 = todo 双桶）；extension 一次推送全量、宿主本地切换零往返。运行时断言「后续推送不重置用户本地 tab 选择」⛔ 实施期门（探针 P5，见 §3.6）。

**D6：排序 = known-order + getViewIds 数组序（选定）**
- **采用**：托盘 widget 区排序 = `['todo','goal']` known-order 优先，其余按 `getViewIds(sessionId)` 返回的数组序追加在 goal 之后（Map 迭代序 = 插入序为 ECMAScript 规范语义；session-scoped-map 内部 Map 在 renderer 侧经 reactive 包装（useExtensionHostBridge 实例化），包装不改迭代序语义——✅ 简洁审核实）。顺序语义作为宿主契约在 `getViewIds` JSDoc 固化一行，措辞用「当前插入序」防 seq 复发（P3 顺手修正该函数陈旧头注）。built-in 三件恒在最左（固定序不参与动态排序）。**不新增 seq 字段**。
- **被否**：按 title 字母序（用户不可控）；WidgetMeta 加 sortHint 字段（为排序付协议成本，known-order + 数组序已够用——todo/goal 是仅有的两个现役 widget，YAGNI）；**ViewHostStore entry 加 seq 自增序号**——被否：`getViewIds()` 已按插入序返回数组（平台既有能力，seq 是重建冗余派生态反增「赋值时机」顺序依赖，且 widget 每次重推换 seq → 未知 key 重排抖动，比 Map 原地保位更差）。
- **证据**：`session-scoped-map.ts` 内部 `new Map()`（renderer 侧 reactive 包装不改迭代序）+ `getViewIds` 返回 `[...keys()]`（简洁审核实，ECMAScript 规范保证迭代序）；known-order 锚定 demo C4 用户裁决顺序。
- **效果**：托盘顺序可预期（裁决顺序恒成立）且零 schema 改动。

**D7：生命周期与归零语义（选定）**
- **采用**：托盘条目可见性 = 「有数据」：built-in 三件 = 该 session 该类 running>0（亮：计数+呼吸点）或历史>0（dim 常驻）或全无（隐藏）——计数源同 D2；widget 区 = ViewHostStore entry 存在（guiTree 非空）即显示、invalidate 即摘除，badge 视觉态由 meta.status 驱动（D4）。
- **被否**：widget 加「空闲也常驻」模式（goal/todo 清屏语义已天然归零，再造常驻模式是 §3.5.4 反例——为习惯付费）。
- **证据**：§2.4 数据流 + todo/goal 清屏代码事实（D3 证据同）。
- **效果**：§1 目标 3 成立；与 built-in 归零语义同构。

**D8：hover/pin 交互规格（选定）**
- **采用**：hover icon 160ms 后开面板；指针离开 icon+面板整体 240ms 后收起；期间指针移入面板内不收起。点击 icon = pin（面板常驻，可交互行内操作——hover 态刻意不渲染行内按钮防误触）；再点 icon / Esc / 点面板外 = 解除。同一时刻至多一个面板开着（互斥）。面板锚定 icon 上方（reka Popover 或手写 anchored 浮层，宽 400px，max-height 60vh 内滚动）。
- **被否**：点击即开（无 hover 预览——高频「瞄一眼」场景多一次点击）；多面板并开（视觉打架）。
- **证据**：demo C4 交互原型用户确认；taiji popover 范式（bg-elevated + border-strong + shadow）先例充足。
- **效果**：§1 目标 1 的「hover 即得」成立。

**D9：面板空态 = 可行动空态（选定）**
- **采用**：built-in 面板默认 tab「进行中」；该桶为空时显示一行空态提示 + 「查看已结束 (N)」按钮（点击显式切到已结束 tab）。不自动落已结束 tab。
- **被否**：空闲时自动落「已结束」tab（tab 位置不可预测——用户点开不知道自己在哪个 tab；且刚结束的瞬间会突然跳 tab）。
- **证据**：demo C4 两空态策略对比用户裁决倾向可行动空态。
- **效果**：空态不困惑 + 历史可达。

**D10：侧栏收敛为三 tab + 退役面（选定）**
- **采用**：SegmentedTab 五 tab → 三 tab（会话/文件/Plugins，`SidebarTab` 类型收窄 `'sessions'|'files'|'plugins'`；activeTab 不持久化，无存量值迁移面——✅ 核实 sidebar.ts 头注）。退役清单（行为面）：`SubagentList.vue` / `SubagentFilterBar.vue` / `WorkflowList.vue` / `WorkflowDetail.vue`（Flows tab 内详情视图；其 phase 分组逻辑已在 drawer WorkflowTab 复用——WorkflowTab 头注明示，删除无孤儿）及 `workflowStore.selectWorkflow/getCurrentWorkflow` sidebar 链、`BackgroundTaskListView.vue` L2 视图、`Sidebar.vue` 中上述挂载分支、`useListSync`（首拉腿迁 D13）、`useSidebarSubagentActions` 的列表动作链（cancel 防误报逻辑迁托盘）、`useSubagentBucketFilter` / `useBackgroundTaskBucketFilter`（桶过滤迁托盘面板）、`stores/workflow.ts` 视图 2 簇（selectWorkflow/backToWorkflowList/getCurrentWorkflow/detailRunIdMap/getViewingRunId——**生产**消费面全在退役面内；测试连带面（含 sidebar-mount mock）见机械面名单）、core `builtin-contributions.ts` 的 `background-tasks` view 贡献声明、`useExtensionHostBridge` 的 `NATIVE_VIEWS` 路由与 `L2_TAB_BADGE_SOURCE_KEY` 接线、`useSidebarCounts` 的 subagent/workflow 计数段（迁 useTrayCounts）；机械面：**测试机械面改开放式圈定**（封闭枚举连续两轮有漏）：宽口径 `rg -l "SubagentList|WorkflowList|BackgroundTaskListView|SubagentFilterBar|WorkflowDetail|useListSync|useSidebarSubagentActions|useSubagentBucketFilter|useBackgroundTaskBucketFilter|subagentRunningCount|workflowRunningCount|'subagents'|'workflows'|background-tasks" packages --glob '*.{ts,vue}'`（比 N1 窄口径 from.* 宽——**射程** = 模块名任意位置 + 字面量词元（`'subagents'`/`'workflows'`/`background-tasks`——语义上是 tab id / view id，但同形字符串在任何语境都会命中，无关语境归入「无关命中」桶）+ 被迁移 API 符号名（`subagentRunningCount`/`workflowRunningCount`，「存活模块内容变更型」（存活模块内部 API 变更、命中其测试）的抓手）+ vi.mock 路径串 + 头注；实跑基线 = 76 文件；与 N1 的分工：N1 验「活代码零 import」，本命令圈「测试/注释/字面量连带面」。命中后人工分诊四桶：import 直引 = 删或改 / vi.mock = 删 / 注释 = 清理（注释命中但文件保留）/ **无关命中 = 不动**（两类：① 模块名仅为更长符号名子串（实跑 6 项，见下方碰撞登记）；② id 字面量属无关语境（图标键 / store key / 目录名 / typeKey / 日志标签 / fixture 字符串——实跑 id 模式独有命中 15 文件中，除本设计需处置者（stores/sidebar.ts 类型收窄、core contribution-registry.test / ui PluginViewContainer.test / L2TabBar.test 的 NATIVE_VIEWS 面）外均属此类）））——**命令射程内基线命中**：WorkflowDetail.spec / Sidebar.test.ts / fork-keymap.test / useListSync.test / useSubagentBucketFilter.test / SegmentedTab.spec（id 字面量入集） / workflow.test.ts（视图 2 用例随删除改造） / useExtensionHostBridge.test / **core contribution-registry.test（跨包，id 字面量入集）** / PluginViewContainer.test（id 字面量入集） + 组件测试名单（SubagentList.spec / WorkflowList.spec / SubagentFilterBar.test / sidebar-layout.test / sidebar-list-error-state / sidebar-crud-error-handling / background-task-list-view.test / sidebar-ondeletefolder / sidebar-import-entry / sidebar-assign-project-wiring / useSidebarCounts.test（API 符号入集） / use-background-task-bucket-filter.test）+ `__tests__/helpers/sidebar-mount.ts` + `packages/ui` PluginViewContainer 的 NATIVE_VIEWS 分支本体（其测试由 id 字面量入集）；**射程外人工补充（命令带不到，靠名单兜）**：`Panel.inbound-frame-notice.test.ts` / `Panel.dead-diagnostics-export.test.ts` 的 VIEW_HOST_SOURCE_KEY 范式 provide 清理（内容不含模块名/id/API 符号）+ **碰撞登记（无关符号名碰撞 = 不动，实跑 6 项）**：subagent-core `formatWorkflowList` 定义（shared/injection-render.ts）与其 pi 逐字节等价守卫测试（shared/__tests__/injection-render.test.ts）、`subagent-core/src/index.ts` 导出面、`SubagentListItem` 定义（execution/assembly/types.ts）、`execution/assembly/subagent-actions-core.ts`、runtime `LegacySubagentListItem`（services/session/subagent-extractor.ts）+ 注释命中而文件保留登记（`lib/subagent-bucket.test` L16 注释（文件保留——测 SSOT 谓词，D2 明文不退役） / useSidebar.test / use-context-usage.test / shared/subagent.test）+ useForkActions / useSidebarSessionActions 头注悬空引用顺手清扫 + stores/workflow.ts 头注「保留」句同步修正 + i18n 死键（**共享键排除规则：清理前先 grep 保留面消费（drawer 三 tab / Sidebar / SegmentedTab）为准，实测清单不可手抄——本设计实测 drawer WorkflowTab 消费 `sidebar.workflowDetail.*` 7 键（含 agentsLabel）与子树外兄弟键 `sidebar.workflowOpFailed`，均须保留，误删不报红只能靠清单防护**）。**对话流 subagent/workflow 内联块保留**（定位 = 对话历史内容/tool call 记录，非观察入口；点击开 drawer 与现状同链）。Plugins tab 保留（plugin sidebar view 挂载点，空态自隐藏现状不变）。
- **被否**：侧栏任务 tab 保留双入口（F3 穿帮面正是要消灭的）；Plugins tab 一并删除（plugin sidebar view 机制与本次无关，挂载点保留零成本）；内联块一并退役（它是对话历史的一部分，删它 = 删对话内容）。
- **证据**：`SegmentedTab.vue` tabs 定义 / `builtin-contributions.ts` L45-57 / `useExtensionHostBridge.ts` L386-397 / `WorkflowTab.vue` 头注（phase 分组复用自 WorkflowDetail）/ `useSidebarSubagentActions.ts`（openSubagent = 现状卡片点击归宿，cancel 防误报逻辑）。
- **效果**：§1 目标 4 成立（口径 = 常驻观察入口）。

**D11：WidgetArea pill 退役（选定）**
- **采用**：`Panel.vue` 摘除 WidgetArea 挂载与 `widgetSessionId` 派生；`@taiji/ui` 的 `WidgetArea.vue`、其 barrel 导出（`features/chat/index.ts`）及测试退役（git 可追溯）；**widget 视图消费端**由「WidgetArea」收敛为托盘（措辞注：ViewHost 组件本身仍 inject `VIEW_HOST_SOURCE_KEY` 服务 composer.toolbar 等 mount 点，非零消费）；`GuiComponentRenderer` 保留（托盘面板渲染消费）。
- **被否**：pill 与托盘并存（信息高度重叠 = F4 实例，DESIGN.md §3.5.4「去掉只服务于习惯的元素」）。
- **证据**：`Panel.vue` L79-83 挂载点；demo C4 用户裁决「pill 删除」。
- **效果**：对话流回归纯内容；入口唯一化收口。

**D12：per-Composer 归属（选定）**
- **采用**：托盘随 Composer 实例化，数据按该 Composer 绑定的 sessionId 过滤（ViewHostStore 分区 / `recordsOf(sid)` / useBackgroundTasks 分区本就 per-session）。布局事实：panel 现为恒单 PanelLeaf（split 已于 2026-07-24 移除——✅ 核实 panel store 头注「退化为恒单 panel」），当前即一个 Composer 一个托盘；per-instance 实例化使托盘天然跟随未来任何布局形态演化，无需全局单例态。
- **被否**：全局单托盘（跨 session 混载与「观察本 session」场景错位；引入与 session 解耦的全局态，未来布局演化时要返工）。
- **证据**：既有 per-session 分区范式（ADR-0049）全链路现成；panel store 恒单 panel 事实。
- **效果**：单实例下数据归属正确（切 session 即时跟随）；架构上不预付 split 恢复的返工成本。

**D13：首拉触发迁移——useListSync 退役后拉取腿归托盘（选定）**
- **采用**：现状 subagent/workflow 首拉 RPC（loadSubagents/loadWorkflows）的触发器 = `useListSync`（focusedSessionId 切换 + tab 激活）+ `useSidebar.onConnected` 重连重拉 + 列表 retry 按钮——前者和 retry 全在退役面内。迁移归宿：**托盘挂载即 watch sessionId 触发首拉**（迁入 `useTrayCounts`，范式 = `useBackgroundTasks` 的 watch(sid) 拉取腿）+ WS 重连腿保留（useSidebar.onConnected 不动）+ 托盘面板错误态 retry 按钮。bash 无此问题（useBackgroundTasks 自带拉取腿，随组件消费迁移）。历史 record（已结束桶/dim 常驻判据）依赖首拉——广播腿只覆盖在跑任务，此腿不迁则切 session 后托盘空/滞后。
- **被否**：面板打开时才拉（首开前计数无数据源，dim/隐藏判据失效）；保留 useListSync 挂 Sidebar（tab 没了没有激活语义，且类型收窄后 `Extract<SidebarTab,'subagents'|'workflows'>` = never 编译即断）。
- **证据**：`useListSync.ts:27`（tab 类型槽位）；`Sidebar.vue` 挂载点；`useBackgroundTasks.ts` watch(sid) 范式。
- **效果**：切 session 后托盘计数/历史桶即时可用（A1/A2 验收断言历史桶非空）。

**D14：P2-P3 共存窗口代价（显式量化）**
- **采用**：P2（托盘新增）与 P3（旧入口退役）之间存在双口径共存窗口，四要素：**量级** = P2 合入至 P3 完成间 ≤1 个工作日、不跨 changeset 发版（同 PR 序列或紧邻 PR，不单独发版）；**迁移语义（前提声明）** = P2 阶段「复制不抽走」——被迁移逻辑（cancel 防误报 / 桶过滤 / 首拉触发三族整模块删除 + 计数段第四族——后者原件是 useSidebarCounts 瘦身非删除，不破 revert 链，同适用本语义）以复制件进托盘，旧入口照常 import 原模块不动，故窗口内「旧入口完全可用」成立；P3 阶段才删除原件（纯删除），故 revert P3 即复活完整旧入口（非被抽空的降级版），且删除后与 N1 零 import 门禁不冲突；**恢复路径（分窗口阶段）** = ① P3 合入前：故障可单点处置——Composer.vue 摘除 ComposerTray 挂载一行 v-if，或 revert P2 commit 序列（此阶段 P2 = 新增组件 + 向后兼容改造，revert 零损）；② P3 合入后：不可单 revert P2（旧入口已删，widget 入口会归零；P4 后 todo 面板内容在 sections 内会被旧 TabBar 丢弃）——恢复 = revert P3 commit 序列（退役是删除型，revert 即复活旧入口）+ 修复优先（bugfix PR），禁止窗口后单 revert P2；**重审触发** = 窗口需跨发版、或超 3 天、或共存期出现计数穿帮用户报告；**显式判定** = 可接受——窗口内穿帮面仅「双入口计数口径」（数据链路同源 useSidebarCounts 派生，无数据丢失/错误），旧入口完全可用。
- **被否**：无限期共存（F3 穿帮面受控兑现，不设窗口 = 永久双入口）；P2/P3 合一巨型 PR（不可分步验收/回滚，违背逐组件退役逐 commit 纪律）。
- **证据**：D2 计数同源（两入口读同一 store 派生，口径不漂移）；P2 含三处修改（挂载/TabBar/i18n）但 TabBar 改造向后兼容（缺 sections 时纯展示，旧 widget 不受影响）；P3 删除型 revert 可行。
- **效果**：最高风险窗口受控；P3 迁移回归风险隔离。

**D15：托盘第 4 件「子会话」= native 直连 session store（选定；模式体系设计 D7）**

> **[落地状态]** 已随 u7 落地：`useTrayCounts` 新增 `session`（`TrayBuiltinKind = TrayTaskKind | 'session'`，不并入 `TrayTaskKind`/`TRAY_BUCKETS`——`session` 走独立扁平列表面板 `TraySessionPanel.vue` 而非分桶槽）。

- **采用**：`useTrayCounts` 增加第 4 个 kind（`session`），数据 = renderer session store 中 `parentAgentSessionId === 当前 sessionId` 的条目（该字段 live 从内存透传、reload 从 `.agent.json` 读，两条读取链齐备），**零新协议**。三态沿用既有契约：有进行中 → accent 计数 + 呼吸点；仅历史 → dim；全无 → 不渲染。面板 400px、行 = 7px 状态点（**色源 = 进程级 `SessionSummary.status` 经 `DOT_CLASS` 映射**；**实施期修正**：初稿写的 `useSessionDerivations.derivedStatus` 对 `status='active'` 又无消息的未 hydrate 子会话会兜底 `done`，无法表达运行中，故改用进程级 status）+ label + cwd 末段 + 状态 + 时长；pin 态行内「打开」（`useSidebar.selectSession`）与「停止」（既有 **`chat.abort`** RPC，两段确认）；行点击 = 打开该子会话。**徽标计数口径** = 子会话**总数**（对齐 demo 的「● 3」与面板头「3 个 · 1 运行中」；与其他三件的「运行中数」口径不同，属登记在案的形态）。固定序位于 built-in 四件末位（bash → subagent → workflow → session）。
- **被否**：**走 widget 协议**（会话管理扩展推 GUI widget）——宿主无法承载「行点击跳转」（协议无 UI→extension 写通道，且 widget 面板内写操作是既有 out-of-scope），而跳转正是该入口的核心价值。
- **证据**：`SessionSummary` 已含 `spawnSource` / `parentAgentSessionId`；托盘三态契约见 D7。
- **落地形态**：`TraySessionPanel.vue`（扁平列表，非分桶槽）——行 = `tray-session-dot`（状态点）+ label + `tray-session-meta`（cwd 末段 · 时长）；空态 `tray-session-empty`；`useTrayCounts` 的 `session` 计数 = 子会话行集长度（running = `status === 'active'`）。
- **效果**：调度模式（主 agent 只派发、子会话执行）的「一键查看我派发的子会话」成立；托盘与侧栏形成互补（托盘 = 我派发的，侧栏 = 全部会话）。
- **子会话 project 归属（模式体系设计 D8）**：`SessionManagerHandler.handleCreate` 读父会话 summary 的 `projectId` 并透传给 `sessionService.create(..., { projectId })`（**不新增工具参数**——归属决策不给 LLM 可控面）；父 summary 不可得时不写 `.project.json`（落默认项目），侧栏右键「归入项目」可补。

**D16：composer 底栏密度 = 三簇结构 + 按序退化 + 溢出兜底（选定；模式体系设计 D6）**

- **采用**：底栏改为**三簇**——左簇（`+` / 托盘 / 插件 toolbar，`shrink-0`）、中簇（可压缩区，`min-w-0 overflow-hidden`）、右簇（容量 / 模型 / 发送位，`shrink-0` 且发送位右锚）；容器 `flex-nowrap`（**永不换行**）。按序退化（宽度不足时从上往下生效，累计叠加）：

  | 序 | 退化对象 | 退化形态 | 再入路径 |
  |---|---|---|---|
  | 0 | 发送位 / `+` | 不退化（右锚位置稳定） | — |
  | 1 | 容量 + 生成指标 | 合流为一个 chip（`41%`；流式中追加 `62 t/s`），细节进 hover 浮层 | 浮层（hover/点） |
  | 2 | 模型 + 思考档位 | 合体为一个 chip（`模型 · 档位 ⌄`，popover 内两段）；窄档用模型短名 | popover |
  | 3 | 插件 toolbar 贡献（`composer.toolbar` 挂载点） | 收进 `»` 溢出菜单（**默认安装零贡献 → 菜单不渲染**，不留死入口） | `»` 菜单 |
  | 4 | 托盘整体 | 聚合为单入口（**层叠图标 + 运行数**）→ 面板内分段展示全部类别（含第 4 件 session） | 托盘聚合面板 |

- **落地断点**（实测推导，非硬编码）：**≥640px 全展开；520–640px 用序 1–3；<520px 用序 1–4**。实施以 `ResizeObserver` 实测 `.composer-bar` 内容宽驱动档位（模型名长短 / 插件贡献数量会改变实宽）；阈值与退化序全在纯状态机 `packages/renderer/src/components/panel/composer-density.ts`，接线在 `use-composer-bar-density.ts`，消费方只做「形态 → DOM」映射。
- **图标语义硬约束**：**聚合入口 = 层叠图标 + 运行数**，**溢出入口 = 省略号**——两个不同语义不得共用同一图标。
- **被否**：**允许换行**（现状）——发送位位置随模型名长度与插件数量漂移，用户每次都要重新找；**全部收进溢出菜单**——生成指标在长任务期间是「正在发生的事」，全藏会让用户失去实时反馈（故序 1 保留百分比在触发器上）。
- **托盘三态与 hover/pin 契约（D7/D8）不变**：密度层只新增退化层，不引入「隐藏 dim 常驻条目」这类改契约的退化层。
- **效果**：最小窗口下底栏单行、无横向溢出，被收起入口都经聚合入口或溢出菜单重新到达。

### 3.4 终态数据流

```
built-in（native 直连，无协议变化）:
  bash:  useBackgroundTasks(sid) ─┐
  sub:   subagentStore.recordsOf(sid) + isRunningProjection ─┤→ ComposerTray 计数/呼吸点
  wf:    workflowStore.recordsOf(sid) ─┤
  sess:  session store 中 parentAgentSessionId === sid（D15） ─┘    → native 面板（分桶列表+操作，RPC 既有）

协议 widget（既有链路 + 第三消费端）:
  ext: setWidget(key, {v, component, meta+icon+badge})
    → event-adapter → WS extension:widgetGui
    → ViewHostStore.setView(sid, key, {guiTree, meta})   （顺序 = Map 插入序，无新字段）
    → ComposerTray widget 区: getViewIds 数组序 + known-order 排序
       icon(fallback 链) + badge(fallback 链) + status 视觉
    → 面板 = GuiComponentRenderer(guiTree)（tab-bar sections 容器化渲染）
  清屏: setWidget(key, undefined) → invalidate → 托盘条目消失

首拉触发（D13）: 托盘挂载 watch sessionId → loadSubagents/loadWorkflows（useBackgroundTasks 范式）
                 + WS 重连腿（useSidebar.onConnected 保留）+ 面板 retry
```

### 3.5 错误规格

| 错误边界 | 行为 | 恢复指引 |
|---|---|---|
| meta.icon 未知 key / paths 超限 | 落兜底 icon，console warn 一次（去重） | extension 修正 icon 值（探针 P6 门） |
| meta.badge 超长 | truncate 至 6 字符 + title 全文 | extension 收敛 badge 长度 |
| guiTree 含未知原语 type | GuiComponentRenderer 现状：该节点渲染降级占位 | 协议版本对齐后自愈 |
| tab-bar sections 与 tabs 长度不等 | 忽略 sections 退化为纯展示 tab-bar + warn（同形态去重：同 (原因, tabs 数, sections 数) 只出声一次，恢复合法后重置） | extension 修正结构 |
| tab-bar 无渲染器上下文（PRIMITIVE_RENDER_KEY 未 provide，仅 standalone 挂载触发） | 忽略 sections 退化为纯展示 + 可操作 warn（应用内消费路径均经 GuiComponentRenderer provide 渲染器，不触发） | 消费方经 GuiComponentRenderer 渲染（或显式 provide 渲染器） |
| ViewHostStore 推送频次高 | 托盘只读 meta 派生 badge/status（O(1)），guiTree 仅面板打开时渲染 | —（性能面：todo/goal 推送频率 = tool call 级，远低于渲染预算） |
| WS 断连 | 计数冻结（不虚报不闪烁）；bash 面板顶部断连提示条 | 重连自动重拉（既有恢复腿） |

---

### 3.6 探针清单

> 运行时行为断言的验证探针（准则 7）：✅ = 设计期已核实（代码/实测），⛔ = 实施期门禁（落地时必须先过探针再继续）。

| # | 断言 | 探针 | 状态 |
|---|---|---|---|
| P1 | todo 清单清空 → widget 清屏（invalidate） | 读 `todo/src/index.ts:53` `todos.length===0 → setWidgetDual(ctx,'todo',undefined)`；gui:null → ViewHostStore invalidate 链（view-host-store.ts L13/L90） | ✅ 代码核实 |
| P2 | goal 终态 → widget 清屏（折叠 status bar） | 读 `goal/src/projection/widget.ts:205-218`（isTerminalStatus → setWidget('goal', undefined)） | ✅ 代码核实 |
| P3 | getViewIds() 返回数组已按插入序（Map 迭代序 = 插入序，ECMAScript 规范语义；reactive 包装不改迭代序）——托盘排序可直接消费数组序，无需 seq 字段 | 读 `view-host-store.ts` getViewIds 实现 + `session-scoped-map.ts`（内部 `new Map()`） | ✅ 代码核实 |
| P4 | tab-bar 原语现无交互（无 click/emit），active 由推送值单方决定 | 读 `packages/ui/src/rendering-protocol/primitives/TabBar.vue`（纯展示组件） | ✅ 代码核实 |
| P5 | TabBar 容器化后，用户本地 active 选择在后续 widget 推送（guiTree 更新）时不被重置 | 实施期：组件 key 稳定性验证 + vitest 行为测试（推新 tabs/sections 断言 active 索引保持） | ✅ 实施期关闭（TabBar 16 用例含 setProps 推送后 DOM 元素同一性 + 本地 active 保持；降级路径未启用——组件被 patch 非重建） |
| P6 | 自定义 icon paths 白名单正则拒非法输入且渲染不崩 | 实施期：协议层单测（白名单 + 条数/长度上限 + 越限落兜底）+ 渲染快照 | ✅ 实施期关闭（协议层四边界单测 + S/T 放行后回归；渲染侧四档 fallback 由 tray-widget.test.ts 锁定） |
| P7 | composer 底部向上弹出面板无裁剪/翻转异常（溢出行为） | 实施期：真机 CDP 截图（browser-automation）窗口最小宽度下验证 | ✅ 已关闭（2026-09-16 真机：CDP Emulation 压视口 760 宽，bash 面板 398px 打开、右缘 759≤760 贴边收窄不越界、无翻转丢失；reka Popover collision 处理生效，无需降级） |

---

## §4 验收

> 真机验收载体：`TAIJI_DEV_BACKGROUND=1 pnpm dev`（browser-automation 连 CDP 截图/DOM 断言）；单测覆盖组件逻辑，此处只列真实场景验收。每场景标注回溯的 §1 目标。

| # | 场景 | 步骤 | 通过标准 |
|---|---|---|---|
| A1 | 并行任务可见性（目标 1） | 真机 session 里让 agent 派发 ≥2 subagent + 启 1 个 workflow + 后台 1 个 bash（`sleep 300 &` 类）；等 5s；再切走 session 切回 | composer-bar 左簇出现 `[termⁿ][botⁿ][flowⁿ]`，三计数与实际进行中数量一致、accent 亮 + 呼吸点；切回后历史桶（已结束/dim 常驻）非空（D13 首拉腿生效）；截图比对太极纯灰风格（无彩色溢出） |
| A2 | hover 面板与操作（目标 1） | hover bot icon ≥160ms；pin；对一行执行 cancel 两段式；点一行 | 面板 400px 锚定 icon 上方，「进行中/已结束」两 tab 默认进行中；hover 态无行内按钮，pin 后出现；cancel 首击变红确认态、再击后该行状态流转，计数 -1；点击行 → drawer subagent tab 打开（并排详情，与现状卡片点击同归宿） |
| A2b | workflow 面板与操作（目标 1） | hover flow icon；pin；对 running 行执行 abort 两段式；点行。**[2026-09-16 真机验收修正]** 原判据含 pause → resume，实机发现 subagent-workflow 扩展已随 D-2 一次性生命周期移除 pause/resume（slash command 对 pause 只回 warning），托盘/抽屉的 Pause/Resume 按钮链是迁移复制件带过来的死链——已修复（宿主全链收窄为 abort-only，见 impl-plan 偏差 D51），判据同步改为 abort-only | 面板两 tab 与计数正确；**无 pause/resume 按钮（D-2 一次性生命周期）**；abort 首击确认、再击后行进入终止态、计数 -1（真机实测 1→0，终止翻转有秒级延迟）；点击行 → drawer workflow tab（phase 分组 agent call 列表） |
| A3 | widget 挂载（目标 2） | 同 session 让 agent 用 todo tool 建清单、用 goal_control 建带预算目标 | 托盘出现 todo 条目（badge=未完成数）与 goal 条目（**badge 条件式**：仅当目标带 token 预算时由宿主 fallback 链自 `progress.label` 派生百分比，偏差 D1 裁决 extension 不补推；无预算目标无 badge）；hover 面板 = meta head + tab-bar（待办/已完成）+ list-tree；点 tab 本地切换不卡顿；再次 tool call 后内容刷新且**用户所在 tab 不被重置** |
| A4 | 常态归零（目标 3） | A1/A3 任务全部结束：todo 清空、goal complete、bash 结束、subagent 完成 | 计数与呼吸点消失；有历史的三件 dim 常驻（无计数）；widget icon 消失（todo 清屏/goal 终态清屏）；冷启动新 session 托盘零条目 |
| A5 | 入口唯一（目标 4） | 检查侧栏与 drawer | SegmentedTab 仅 会话/文件/Plugins 三枚；Agents/Flows tab 不存在；Plugins 下无「后台命令」L2 视图；对话流无 WidgetArea pill；**drawer subagent/workflow/bashTask tab 行为不变**（点托盘行打开后内容/返回链路正常——邻居不变量）；对话流内联块保留且点击开 drawer（现状不变） |
| A6 | 切 session 跟随（目标 1） | 单实例下切到另一 session（各有任务）再切回 | 托盘计数/面板数据随 sessionId 即时切换，不残留旧 session 任务（per-session 过滤；注：panel 现为恒单 PanelLeaf，split 已移除，本场景验证单实例数据归属） |
| A7 | 协议兼容性（目标 2） | 不升级的第三方 widget extension 推 setWidget（无 icon/badge 字段） | 托盘出现该 widget：通用兜底 icon + badge 从 progress 派生或无 badge；面板正常渲染；无 warn 刷屏 |
| N1 | 负面：不可达入口（目标 4） | 断言退役面（import/组件引用级，非注释命中） | `rg -l "from.*(SubagentList|WorkflowList|BackgroundTaskListView|SubagentFilterBar|WorkflowDetail|useListSync|useSidebarSubagentActions|useSubagentBucketFilter|useBackgroundTaskBucketFilter)" packages/renderer/src` 活代码零命中（窄口径验 import 直引；vi.mock 路径串 / 含模块名或 id 字面量的形态由 D10 宽口径圈定补齐（双引号日志名/目录名等语义无关字符串不在其射程），不在本断言射程；漏删时 tsc 不报错，机器断言是唯一门禁；保留文件的头注提及不计——**本次实施头注豁免未被使用**（保留文件亦零标识符命中，注释一律去标识符保语义）；NATIVE_VIEWS 路由表为空/移除；相关 i18n 死键按共享键排除规则清理 |
| N2 | 负面：归零不虚亮（目标 3） | 全空闲态截图 + DOM 断言 | 托盘无任何 accent/呼吸点元素；`data-testid` 层面计数元素不存在而非 opacity:0 |

**e2e 影响面评估**（SSOT：`node scripts/select-affected-e2e.mjs --base main`，登记 `docs/testing/e2e-map.json`）：

| 受影响资产 | 影响 | 开发阶段动作 |
|---|---|---|
| `e2e/visual/composer.spec.ts`（E2E-VISUAL-01 轨） | composer 区域像素 diff——托盘进 composer-bar 必然触发 baseline 变更 | 改动后更新基线 + 本轨跑一遍 |
| `e2e/composer.spec.ts`（MOCK 轨） | composer 行为断言可能涉及工具条结构 | 本轨跑一遍，断言随结构更新 |
| `e2e/workflow-sidebar-sync.spec.ts`（MOCK 轨） | 断言 Flows/Agents tab 与列表——侧栏收敛直接击中 | **改写为托盘断言**（workflow 计数/面板同步 + drawer workflow tab 不回归），单测化路径：列表渲染断言沉淀为 ComposerTray 组件测试 |
| `e2e/gui-components.spec.ts`（E2E-MOCK-01 轨） | `__gui__` 对话流内联块渲染链（保留面） | 本轨跑一遍；**widget→托盘消费端断言改挂 real 轨** `tasks-drawer-real.spec.ts` R2——mock 轨不可达（mock `pushSession` 只走 session 通道、缺 route-inbound 的 crossSession 分发腿，`extension:widgetGui` 帧到不了 ExtensionHost bridge；缺口在该 spec 头注登记，属 mock 基础设施债务） |
| E2E-ELECTRON-01 P0 smoke（v6-shell-baseline 等） | shell 布局含侧栏 tab 数 | CI 自带（L1 always），本地改动后跑 p0-smoke 子集 |
| `WidgetArea.test.ts` / `Panel.widget-area.test.ts` | 组件退役 | 随 D11 删除；fallback 链断言迁托盘组件测试（`tray-widget.test.ts`）；firstRunning 预览断言无承接对象——托盘以 badge fallback + status 视觉替代该 UI，断言随 `activePreview` computed 一同消亡（实施期核实，守护对象消亡） |
| `e2e/tasks-drawer-real.spec.ts`（E2E-REAL-01 轨，faux 演员——真 Electron/pi 进程 + 真 WS 帧 + 真 route-inbound，零 token 凭证无关） | todo `__gui__` 根形态 list-tree → tab-bar（D5 改造）击中 R2/R3 断言（实测 5 处引用陈旧）；同时承担**托盘 widget 消费端断言**（icon/badge/面板 tab-bar 双段渲染） | 断言改写 + 新增托盘 UI 段（R2）；**开发期已实跑通过（3 例）**；加 bundle 构建模式 pre-flight（mock 产物在场时 fail-fast 并给重建恢复动作）；E2E-REAL-01 scope 补 `extensions/universal/**`（原 scope 不含 extensions → 机器选择器抓不到该改动面） |

真实 LLM e2e 其余 spec（`workspace-real` / `ask-user-real` / `workflow-thinkinglevel-real`）不在本次影响面（无 runtime/pi 协议行为变化；extension-protocol 为 renderer/ui/core 消费的纯类型+守卫扩展）；`tasks-drawer-real` 见上表（断言级受影响，属开发期实施漏项修复后的登记）。

---

## §5 下一层拆分

**实施路径**（四阶段，每阶段独立可验收/可回滚）：

| 阶段 | 单元 | 内容 | justification / 验收挂钩 |
|---|---|---|---|
| P1 协议层 | `packages/extension-protocol`：types（WidgetMeta +icon/badge、tab-bar +sections）+ helpers（icon paths 白名单校验函数）+ 单测；**同步 `packages/plugin-sdk/src/types.ts`**（手维护的 GuiComponentProps/GuiRenderResult/WidgetMeta 平行副本，头注「修改契约：直接编辑本文件」）——**extension-protocol 独立 changeset 小版本发布；plugin-sdk 为 private 工作区包（`.changeset/config.json` ignore 名单内、经 runtime bundle 内联），副本随同 commit 同步、不单独发版** | 先立契约，宿主与 extension 并行开发有 SSOT；plugin-sdk 副本漏同步 = taiji Plugin 系统类型双源漂移 | 独立 changeset 小版本（extension-protocol）；A7 兼容性由可选字段保证 |
| P2 宿主层（新增） | `packages/renderer`：`ComposerTray.vue`（挂载+排序+互斥+hover/pin）+ `TrayWidgetButton.vue` + `TrayWidgetPanel.vue` + `tray-order.ts`（widget 区：ViewHostStore 消费、排序、icon/badge fallback 链；原拟名 TrayWidgetItems 落地时拆为按钮/面板/排序纯函数三件）+ `TrayNativePanel` 三件（bash/sub/wf 面板，逻辑自 SubagentList/WorkflowList/BackgroundTaskListView 迁移）+ `useTrayCounts.ts`（三件计数 + **D13 首拉触发迁移：watch sessionId 拉取**，自 useSidebarCounts/useListSync 迁移收口）+ `packages/ui` TabBar.vue 容器化 + i18n + 组件测试（vitest，三视角）。**实施注意**：widget 区必须复刻 WidgetArea 的响应式依赖追踪模式——getViewIds 与 getView 在同一 computed 调用路径内触碰 reactive Map 才能建链（拆开即断链、推送后不重算，WidgetArea.vue entries computed 头注）。共存窗口代价 = D14 四要素 | 托盘本体；先并行于旧入口共存（侧栏暂不删），真机可阶段性验收 A1-A4/A6/A2b | 与旧入口共存期 = 双口径穿帮风险窗口（D14 受控：≤1 工作日不跨发版） |
| P3 退役层 | 侧栏收敛：SegmentedTab 三 tab + SidebarTab 类型收窄 + D10 全部退役清单（行为面：四组件 + WorkflowDetail 链 + Sidebar.vue 挂载分支 + useListSync + useSidebarSubagentActions 列表动作链 + 两个 bucket filter + builtin-contributions 声明 + NATIVE_VIEWS/L2_TAB_BADGE 接线 + useSidebarCounts 瘦身；机械面：sidebar 测试群 + sidebar-mount helper + PluginViewContainer NATIVE_VIEWS 分支 + Panel 两测试的范式 provide 清理 + i18n 死键）+ WidgetArea 退役（Panel.vue 摘挂 + @taiji/ui 组件/barrel 导出/测试删除）+ `getViewIds` 陈旧头注顺手修正（顺序契约 JSDoc）+ e2e-map 登记 | 入口唯一化（A5/N1/N2）；放在托盘可用之后，每一步 git 可回滚 | 逐组件退役逐 commit（打包约束经验：大面改动小步验证） |
| P4 extension 层 | `extensions/universal/todo`：buildGui 加 tab-bar sections（待办/已完成两段）+ meta 推 icon/badge；`extensions/universal/goal`：meta 推 icon（badge 用现有 progress.label 推导即可，可选补推）；两包各补 changeset；`pnpm extensions:typecheck && lint && test` + 本地 pi CLI 实测（`pi -ne --mode rpc` 推送 JSONL 验证 meta 字段真机到达）；**文档同步**：`docs/architecture/extension-gui-protocol.md`（tab-bar/WidgetMeta 字段节，plugin-sdk @see 指向它）+ DESIGN.md composer 工具条节（资产登记表触发条件命中）+ FEATURE-PRIORITIES.md P0 用例组「subagent 列表/运行计数」入口迁移 | **合入顺序约束**：meta 字段（icon/badge）additive 可在 P1 后先行；**tab-bar sections 改造依赖 P2 的 TabBar 容器化**（旧 TabBar 纯展示会丢弃 sections，先行即产出可发布破坏态——todo 列表只存在于 sections 内）；C-proc-10 文档同步纪律 | A3 验收 |

**文件改动地图**：

- 新增：`packages/renderer/src/components/panel/tray/ComposerTray.vue`、`TrayWidgetButton.vue`、`TrayWidgetPanel.vue`、`TrayNativePanel.vue`（bash/sub/wf 三面板或合一文件内分区）、`tray-order.ts`（known-order + 数组序排序纯函数）、`useTrayCounts.ts`（三件计数 + 首拉触发，自 useSidebarCounts/useListSync 迁移收口）
- 修改：`Composer.vue`（左簇挂载）、`packages/ui/src/rendering-protocol/primitives/TabBar.vue`（sections 容器化）、`view-host-store.ts`（仅 getViewIds 头注顺序契约修正，零 schema 改动）、`SegmentedTab.vue` + `stores/sidebar.ts`（类型收窄）+ `Sidebar.vue`（退役挂载分支摘除）、`useExtensionHostBridge.ts`（退役 NATIVE_VIEWS 接线）、`builtin-contributions.ts`、todo/goal 两 extension 的 gui 构造、i18n locale 文件
- 同步：`packages/plugin-sdk/src/types.ts`（GuiComponentProps/GuiRenderResult/WidgetMeta 平行副本，随 extension-protocol 同 commit）
- 删除：`SubagentList.vue`、`SubagentFilterBar.vue`、`WorkflowList.vue`、`WorkflowDetail.vue`、`BackgroundTaskListView.vue`、`useListSync.ts`、`useSidebarSubagentActions.ts`（列表动作链；cancel 防误报逻辑复制迁托盘，P3 删原件——见 D14 迁移语义）、`useSubagentBucketFilter.ts`、`useBackgroundTaskBucketFilter.ts`（桶过滤同语义复制迁托盘）、`stores/workflow.ts` 视图 2 簇（selectWorkflow/backToWorkflowList/getCurrentWorkflow/detailRunIdMap/getViewingRunId）、`@taiji/ui WidgetArea.vue` + barrel 导出 + 两者测试、`useSidebarCounts` 的 subagent/workflow 段、受影响测试（以 D10 宽口径 rg 圈定 + 名单为准，含跨包 core contribution-registry.test）+ sidebar-mount helper
- 文档：`docs/architecture/extension-gui-protocol.md`（协议字段节）、`docs/DESIGN.md`（composer 工具条节）、`docs/FEATURE-PRIORITIES.md`（P0 用例组入口迁移）——同 commit 更新（资产登记表触发条件 + C-proc-10）
- e2e-map：workflow-sidebar-sync 条目 scope 更新 + gui-components 条目复核 + 新增 ComposerTray 相关条目（`--check` 防漏登记）

**待验证检查点**（设计期无法确定，留实施期；与 §3.6 ⛔ 探针门对应）：

1. reka Popover vs 手写 anchored 浮层在 composer-bar 内的溢出/翻转行为（= 探针 P7）——✅ 已关闭（真机 760 宽实测 collision 收窄不越界，见 §3.6 P7 回填）
2. todo 高频推送（连续 add）下 TabBar 本地 active 保持的实现细节（= 探针 P5：组件不重建路径 vue key 稳定性）——✅ 已关闭（实施期行为测试证明，§3.6 P5 回填）
3. `composer.toolbar` ViewHost 与托盘的布局挤压（flex-wrap 换行边界）——✅ 已关闭（2026-09-16 真机：760 宽 + 满托盘条目（三 native + 两 widget）下 composer.toolbar 单行不换行，条目按固定序收缩正常，无溢出折行）
4. WidgetArea 响应式依赖追踪模式在托盘 widget 区的复刻（getViewIds + getView 同 computed 路径建链）——✅ 已关闭（P2 实施首验通过 + 契约测试锁定）
