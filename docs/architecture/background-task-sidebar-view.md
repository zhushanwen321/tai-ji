# background bash 任务侧边栏视图与详情 drawer 技术设计

> **一句话结论**：以 runtime 直读 registry.json（跨进程 SSOT）为数据骨架，新增 per-session 拉取 RPC + 轮询/事件双触发变更广播 + 原生 Vue 视图挂入 plugin 区 L2 tab（contribution 声明 + PluginViewContainer 原生路由），列表带「运行中/已结束/全部」二级状态筛选（对齐 dev-0.9.15 subagent-sidebar-filter 范式），drawer 详情按需 tail 输出文件、kill 回路带 killing-intent 预写（含 base-tool-enhance 一处 enabling 改动：poller 终态化时读回 registry intent，抑制 UI 代杀对 AI 的误唤醒）；不走 extension widget 推送（GuiComponent 零交互、任务列表/详情/kill 均表达不了，见 §3.2）。

**层性质声明**：本文档是**技术方案设计**——下一层产物是可实现的接口/数据模型 + 代码任务（impl-plan）。准则 5/6/7（物理数据流 / 错误恢复 / 运行时探针）全适用。

> **实施状态**：已交付（R1-R4 四轮对抗审查收敛全修：R1 kill 回路两处结构性修复；R2 零感知断言收窄 + intent 读回钉死 + Windows 探测规格；R3 改动地图补 extension 加固；R4 用户裁决升级二级筛选 D10——三桶筛选/分桶 SSOT/行内两段式终止/icon 即状态。审查轨迹 git 可追溯）。

## 1. 背景目标

**SCQA**：
- **S（情境）**：base-tool-enhance extension 让 AI 可把长命令（测试、dev server）转后台执行，任务状态落在 `<piAgentDir>/base-tool-enhance/<sessionId>/registry.json`，输出写 `<task_id>.log`。
- **C（冲突）**：桌面端用户对后台任务**零可见零可控**——任务只在 AI 调 `bash_output` 时被查询；用户唯一感知是对话流里偶尔出现的 `background-bash` custom 消息；任务卡死时用户不知道 pid、看不到输出、无从终止。
- **Q（问题）**：如何在桌面端给用户提供后台任务的实时列表 + 执行详情 + 终止能力，且严格按 session 隔离？
- **A（答案）**：plugin 区新增「后台命令」L2 tab（三桶筛选 + 任务列表，实时状态），点击 item 在 drawer 展示详情（元信息 + 输出尾部 + kill），数据链路走 runtime 读 registry + 变更广播。

**系统是什么**（给不熟悉的读者）：xyz-agent 是 Electron 桌面工作台，进程链 `Electron main → runtime（Node sidecar，WS server，ELECTRON_RUN_AS_NODE）→ N × pi 子进程（每 session 一个）`。base-tool-enhance 是打包 builtin 的 pi extension，跑在 pi 进程内，override bash 工具提供 `background: true` 参数；任务运行时权威是 pi 进程内单例表（`task-store.ts` 模块级 Map，无订阅 API），持久化权威是 per-sessionId 的 registry.json。侧边栏 plugin 区（`Sidebar.vue` activeTab `plugins`）经 `PluginViewContainer` 渲染 L2 二级 tab，绑定焦点 session——**现状恒空态**（见 §2.2）。

**术语裁决（R4）**：视图用户可见命名 = **「后台命令」**——「后台任务」一词已被 Agents tab（subagent）的 i18n 占用（`zh-CN/sidebar.ts:136` `subagentList.empty: '暂无后台任务'`），两者是不同对象（subagent = 后台代理进程；本视图 = 后台 bash 命令），命名必须区分。viewId 保持 `background-tasks`（与实体命名一致：extension-protocol `BackgroundTaskRegistryEntry` / background-task.ts 契约域），仅 title/i18n 文案用「后台命令」。

**设计目标**（从使用者体验倒推）：
1. **G1 可见**：用户切到某 session 的 plugin 区「后台命令」tab，默认只看运行中的任务（运行中/已结束/全部三桶筛选 + 计数预告，对齐 Agents tab 范式），状态实时翻转（running→killing→exited）无需手动刷新；tab 角标与「运行中」桶计数同源（亮 = 有命令在跑 = 默认桶非空）。
2. **G2 可查**：点击任一任务，drawer 展示完整命令、元信息（pid/时间/时长/exitCode/reason）、输出尾部；running 任务输出可跟随刷新。
3. **G3 可控**：running 任务可**行内两段式终止**（第二行右侧 ✕ → ✓ 确认，无需开 drawer），drawer 内亦有一键终止——**且终止不惊扰 AI**（不触发 AI 新 turn、不产生误导性「失败」通知；主路径保证，残余窗口与收窄口径见 D6-en 边界注）。
4. **G4 隔离**：session A 的列表永不含 session B 的任务；切 session 即切数据分区（含筛选桶分区）；无焦点 session 时空态。

**in-scope**：runtime 读 registry 的新 service、WS 消息域（拉取 RPC + 变更广播）、renderer 原生视图（L2 tab + 三桶筛选 + drawer + 行内终止）、kill 回路、plugin 区 tab 贡献声明与 L2 角标、**base-tool-enhance 的 killing-intent 读回（唯一 extension 改动，见 D6-en）**。
**out-of-scope**：不修改 pi；base-tool-enhance 除 D6-en 外的任务执行语义不动（spawn/poller tick 节奏/reaper 触发面均不变）；不做 stdout/stderr 分流展示（output 文件本就混流，见 §2.1）；不做跨 session 聚合视图（G4 明确按发起 session 分区）；不做完整输出查看器（仅尾部预览 + 跟随；tail 语义对齐 `bash_output`，上界 32KB——D3 定案口径，非 bash_output 面向 AI 上下文预算的 50KB；实施期审查修正此处初版误写）。

## 2. 现状与问题分析

### 2.1 使用者视角的现状（真实例子）

AI 在 session X 执行 `pnpm test`（命中 force-test 白名单强制后台）：

```text
AI 调 bash {command:"pnpm test"} → 立即返回 {task_id:"bt-1789...-a1b2c3", pid:53241, ...}
AI 继续干别的；测试在后台跑
[约 4 分钟后] 对话流出现一条 custom 消息（background-bash 类型，SystemNotice 兜底文本行）：
  「后台任务 bt-1789...-a1b2c3 已完成 exitCode=1，tail: Tests: 12 failed, 31 passed...」
```

用户此刻的困境：
- 想看任务列表 → **没有界面**。唯一途径是让 AI 调 `bash_output`（无参 list），得到一段 JSON 文本。
- 想看完整输出/确认还在跑 → 让 AI 调 `bash_output {task_id}`（tail 2000 行）。
- 想杀掉卡死的 dev server → 让 AI 调 `bash_kill`。
- 对话流里那条 custom 消息若被后续消息冲走，任务的存在感完全丢失。

**真实失败模式**：dev server 类长驻任务（force-longrun 白名单）永远不 exit，也就**永远没有完成通知**——用户甚至不知道有个任务在跑、占着端口。

### 2.2 现有数据面与 UI 宿主盘点（调研事实，2026-09 本仓实装；锚点已经对抗审查逐条核实）

| 数据面 | 位置 | 新鲜度 | 缺陷（对 UI 而言） |
|---|---|---|---|
| pi 进程内单例表 | `extensions/universal/base-tool-enhance/src/background/task-store.ts:42`（模块级 Map，无订阅 API；:16-29 为 D6-en 不变量注释块） | 实时 | 不出进程；他进程/重启前的任务不在表内 |
| registry.json | `<piAgentDir>/base-tool-enhance/<sessionId>/registry.json`（extension 侧统一写入口 `registry.ts:179`；runtime reaper 写 orphaned `background-task-reaper.ts:308`；两侧共用 `<registry.json>.lock` proper-lockfile 磁盘协议，跨进程互斥已核实） | 每次状态迁移原子写（tmp+rename，锁内 RMW） | **无变更广播**——reader 需自行发现变化 |
| outputFile | `<...>/<sessionId>/<task_id>.log`（子进程持 fd 直写，`spawn-background.ts:150`） | 实时（可随时 tail；`output-tail.ts:34-74` 字节窗口从文件末尾读） | stdout/stderr 混流无标记 |
| 完成通知 | `pi.sendMessage` customType `background-bash`（`notify.ts:152-155`）→ `message.customStart` → 对话流 SystemNotice | exit 边沿 | 仅对话流展示，非结构化状态；kill 路径不发（`notify.ts:146`） |
| reaper | `packages/runtime/src/services/session/background-task-reaper.ts`（runtime 内；启动 5s + session 删除两触发面） | 事件触发 | 无 WS 广播，观测面只有 console.log |

**plugin 区与 widget 系现状**（关键背景）：
- sidebar plugins tab 的视图清单来自 `ContributionRegistry` 的 `sidebar.tab` 贡献——**只有 builtin 静态声明一条路**（`packages/core/src/extension-host/builtin-contributions.ts`），且 builtin 现无任何 views 声明、`bootstrap.ts:63-71` `loadExternal([])` 恒传空数组 → **plugins tab 现状恒「暂无插件视图」空态**。本设计将是第一个真实 sidebar.tab 视图。
- todo/goal 刻意不进 sidebar：经 `guiSetWidget`（`extension-protocol/src/core/helpers.ts:65-74`，NUL marker 编码）→ pi stdout `extension_ui_request{setWidget}` → EventAdapter（`event-adapter.ts:415-493`）→ WS `extension:widgetGui` → `ViewHostStore`（`view-host-store.ts:95-110`，(sessionId, viewId) 双键分区）→ **对话流 WidgetArea 消费**（`Panel.vue:78`）。
- **GuiComponent 词汇表 9 类型全纯展示零交互**（`extension-protocol/src/core/types.ts`；`ListTree.vue` 0 emit）：无 onClick/onSelect/按钮原语；TreeItem.status 三态（running/done/failed）不含 killing/orphaned；无计时原语。事件回传只有 `extension.ui_request` 阻塞模态（confirm/select/input/editor）——不是列表点击。
- custom 逃生口（`custom` 类型 + `GUI_CUSTOM_REGISTRY_KEY` 编译期注册）机制存在但**生产代码零 provide 者**。
- **drawer 是硬编码 7-tab 机制**：`core/domain/drawer/types.ts` `SideDrawerTab` 联合类型 + `DrawerPanel.vue` tabs 数组 + `PanelContainer.vue:107-143` v-if chain 三处同步；'drawer.tab' 贡献挂载点仅存在于类型注释、零消费者。

**dev-0.9.15 Agents tab 二级筛选先例（R4 对齐目标，本分支未含——在集成分支 dev-0.9.15，设计 `subagent-sidebar-filter.md` + 实装 `SubagentFilterBar.vue`/`SubagentList.vue`/`lib/subagent-bucket.ts`/`useSubagentBucketFilter.ts`）**：列表顶部迷你凹陷槽三桶（进行中/已结束/全部 + 计数，默认进行中）；分桶判据收独立纯函数 SSOT 模块（禁两处各写 status 判定）；筛选状态经 `useSessionScopedState` 工厂 per-session 分区（**reactive 容器契约**——标量需对象包装且必须 reactive，否则切桶 UI 永不更新；挂载期内记忆、切 tab 卸载重置、不跨启动记忆）；空桶自适应（「进行中」空桶给查看全部一键跳转，全量空态不渲染筛选条）；一级 tab badge 口径与桶判据同源函数（badge 亮 = 默认桶非空，防「badge 点亮而默认视图是历史」语义断裂）；运行中卡片行内两段式 cancel（inline 确认不开弹窗）；三行卡片结构（名称行 + mono 元信息行 + 描述行）——**本设计 item 不照搬三行卡片：采用 SessionItem 两行同构（D10 ⑤，用户裁决：行数精简 + 状态徽标移除）**。

**根因**：后台任务的全部数据面都在 pi 进程内或落盘文件里，桌面端（runtime/renderer）从来没有一条「读出来给人看」的链路；而现有面向 UI 的唯一 extension 通道（widget 系）是纯展示词汇表，表达不了「列表点击 + 详情 + kill」这类交互。

### 2.3 物理数据流（现状）

```
pi 进程（每 session 一个）                     runtime（Node sidecar）        renderer（Electron 窗口）
┌─────────────────────────────┐
│ bash execute(background)    │
│  └→ spawn detached 子进程 ────────────(stdio fd 直写)────→ <sid>/<task_id>.log
│  └→ task-store 单例表(内存)  │
│  └→ registry.json 原子写 ──────────────────────────────→ <piAgentDir>/base-tool-enhance/<sid>/registry.json
│ poller 2s tick: exit 边沿   │                （runtime 与 renderer 均无任何消费/监听 ← 问题所在）
│  └→ notify: pi.sendMessage ─┼──pi RPC 事件──→ EventAdapter → message.customStart → 对话流（唯一到达用户的路径）
└─────────────────────────────┘
```

**关键约束（决定方案走向）**：
- **C1**：runtime 读不到 pi 进程内存（只能 RPC / 落盘文件）；但 registry 与 output 文件都在 runtime 可达的 `getPiAgentDir()` 下，可直接读。
- **C2**：registry 是唯一跨进程 SSOT（含终态历史 LRU 50、他进程遗留条目、reaper 收殓的 orphaned）；extension 内事件不出进程。
- **C3**：reaper（runtime）已具备 killProcessTree + pid start-time 防复用校验的成熟范式（`background-task-reaper.ts`，且 `killProcessTree`/`isPidAlive`/`pidStartMatchesRegistered` 从该模块导出可直接复用）。
- **C4**：`外力终止与自然退出在观测上不可区分，reason 记 natural`（base-tool-enhance 设计既有语义，非本设计引入）——**本设计经 D6-en 在「UI 代杀」路径上收窄了该语义（intent 预写 → reason=killed），见 D6**。
- **C5**：session 隔离天然成立——registry 按 sessionId 分目录；任务目录归属**发起** session（fork 后新 session 目录为空，正确反映进程级归属）。
- **C6**：WS 会话时序竞争（AGENTS.md）——session 级状态早于 renderer 订阅到达会丢消息，消费端必须主动拉取兜底（message-bus 的 ring/snapshot 重放可缓解但设计不依赖它，见 D3）。

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**（session X，用户正在看别的 session）：

```text
用户让 AI「跑一下测试」→ AI 把 pnpm test 转后台执行
用户切到 session X → 侧边栏「插件」tab → 「后台命令」二级 tab（L2，与 todo/goal 形态并排；有运行中任务时 tab 角标亮）
列表顶部筛选槽：[ 运行中 1 | 已结束 4 | 全部 5 ]，默认「运行中」——直接看到在跑的命令，历史不干扰
列表第一行：◇ pnpm test  [运行中 00:37]（accent 旋转环 + 实时计时）
  第二行（mono 小字）：pid 53241（hover 时右侧出现 ✕ 终止钮）
用户想看历史 → 点「已结束」→ 4 条终态（icon 语义色区分成败，第二行 pid · exit N，按结束时间倒序）
用户点击运行中的行 → 右侧 drawer 打开「后台命令」tab：
  命令全文（pnpm test --filter @xyz-agent/renderer，可复制）
  元信息：bt-1789...-a1b2c3 · pid 53241 · 开始 14:32:05 · 已运行 00:37
  输出（尾部，等宽滚动块，每 2s 自动跟随增长）：
    ✓ packages/core/src/extension-host/view-host-store.test.ts (18)
    Tests  31 passed | 12 failed
  [终止任务] 按钮
用户不想开 drawer，直接 hover 列表行点 ✕ → 按钮变红色 ✓ 确认态 → 再点一次 → 列表行 ≤5s 内翻转「已终止」
  （killing 即时翻转〔service 自写自检〕；killed 终态无事件源，最坏 = poller 边沿 2s + 轮询检测 2s；reason=killed；对话流**不会**出现「任务失败」通知，AI 不被唤醒——D6/D6-en，主路径口径）
测试全部跑完后再回 tab → 默认「运行中」桶空态：「没有运行中的后台命令」+ [查看全部 (5)] 一键跳转
```

**失败路径与恢复**：
- drawer 打开时 output 文件已被清理/丢失 → 输出区显示「输出不可用（文件已清理）」，元信息正常展示；无恢复动作（终态任务输出本就是尽力保留）。
- 点「终止任务」时任务恰好已自然退出 → toast「任务已结束」（killResult `already-exited`），列表 ~2s 内自然翻转终态；无副作用。
- 点「终止任务」时进程身份无法验证（平台限制，D6 分支 ④）→ toast「无法验证进程身份，已拒绝终止（宁不杀勿误杀）」；用户可重试（start-time 探测恢复后可过）或用系统工具手杀。
- registry 写入失败（kill 的 intent 预写或终态写失败，D6 分支 ⑤）→ toast「操作未生效（数据写入失败），请重试」；条目停留原状态，下次 app 启动的 reaper 扫描是最终兜底。
- registry.json 解析失败（损坏）→ 列表该拍显示空态 + 错误条「任务数据损坏，已忽略（.corrupt 保留现场）」。恢复语义（与实装一致，诚实声明）：自愈触发面有**两侧**——extension 侧在**自身读写路径**（rename `.corrupt` + **空表重建**，`registry.ts:112-135`）；**runtime 读侧** `readRegistryEntriesWithStatus`（提炼于 `background-task-reaper.ts:279-288`，BackgroundTaskService 的 list/变更检测均经它读 registry）解析失败时同样 rename `.corrupt` 隔离 + 空表 + `corrupted:true`——**UI 打开后台命令 tab 即隔离现场，非仅 extension 写路径**（2026-09-07 回写，BG-3 对齐实装）；隔离后下一拍 registry 已不存在，按空表 + corrupted:false 处理（错误条随下一检测拍消失）。「空表重建」由后续写入自然完成（两侧一致，均不立即写空文件）。extension 侧该 session 无 AI 活动时 UI 错误条不再常驻（读侧隔离已收敛现场）。**被损坏隔离的终态历史不自动恢复**（`.corrupt` 文件保留现场，可人工恢复），列表从空表重新累积。
- runtime 重启后 list 拉取失败（WS 断开）→ 列表显示「连接断开，重连后自动刷新」条；WS 重连后自动重拉。

### 3.2 多方案对比

三个候选（数据链路核心分歧 = **谁产生 UI 数据、经什么通道到 renderer**）：

| | 方案 A：extension widget 推送 | 方案 B：runtime 直读 registry + 原生视图（**选**） | 方案 C：extension 事件 + EventAdapter 翻译 + 原生视图 |
|---|---|---|---|
| 机制 | base-tool-enhance 每次 state 迁移 `guiSetWidget('background-tasks', listTree)` 推全量；builtin-contributions 声明 sidebar.tab view | runtime 新增 BackgroundTaskService：读 registry（pull RPC）+ 变更检测（事件触发 + 2s 轮询）→ session 级 WS 广播；renderer 原生 Vue 组件 | extension 在 spawn/exit 边沿 emit 新事件 → EventAdapter 翻译成新 WS 消息 → renderer 原生组件 |
| 长期架构 | 与「插件规范」形式最贴，但把「读持久层做 UI 状态视图」的职责错放进 pi 进程；widget 全量重推模式对列表场景低效（计时需每秒重推） | registry 本就是跨进程 SSOT；runtime 是它的事实消费者（reaper 先例）；UI 状态视图归 runtime/renderer，职责正确；pi 死活不影响数据完整性 | 事件精确但**数据面不全**：reaper 写的 orphaned 不经 extension（需 runtime 补第二路广播）；pi 进程死后无事件（历史/孤儿场景失效，仍需 registry 兜底）→ 事实上退化为 B+C 双源拼接 |
| 短期成本 | 低-中（extension 侧加推送 + builtin 声明） | 中（三层各一块：runtime service + WS 域 + renderer 原生组件与原生路由；**另含 D6-en 一处 extension 小改**） | 中-高（动 base-tool-enhance + EventAdapter 契约 + renderer；且仍要做 B 的 registry 读路径兜底） |
| 风险 | **G2/G3 直接不可达**：GuiComponent 零交互（无点击/按钮/事件回传，§2.2 实证）；killing/orphaned 状态表达不了；他进程遗留任务 extension 不推（无变更可观察） | 新增文件轮询（量级：每 watched session 1 次 mtime stat / 2s，可忽略）；三处同步的 drawer 接入点（既有范式，照做即可） | EventAdapter 是「pi 协议唯一适配点」（架构规则），为 UI 刷新扩契约面，漂移守卫成本上升；双数据源一致性是新问题面 |
| **裁决** | ❌ | ✅ | ❌（作为 B 的可选优化都不必要——B 的事件触发刷新已零成本拿到 exit 边沿时机，见 D2） |

**若用方案 A，§3.1 的例子会变成什么样**：列表能显示（list-tree 近似），但点击行没有任何反应（无点击通道）；「终止任务」按钮不存在（无 button 原语）；计时要么静止（不重推）要么 extension 每秒全量重推 widget（对话流 WidgetArea 同 widgetKey 会被连带重渲）；orphaned/他进程遗留任务不出现。G2/G3 整体失败。
**若用方案 C，§3.1 的例子会变成什么样**：交互能达成（原生组件），但强杀 pi 后该 session 列表冻结在最后一次事件（orphaned 收殓无人广播），除非再补 runtime 侧 registry 广播——即重做 B 的全部内容，C 的事件层变成冗余上叠。

**推荐：方案 B。**「插件规范」的落点在 **view 的贡献声明**（contribution）与 **L2 tab 的宿主机制**沿用，而非渲染载体必须是 GuiComponent（该词汇表为对话流状态展示设计，非交互 UI）；数据链路归 runtime 是 registry SSOT 的自然推论（C1/C2）。

### 3.3 关键决策与权衡

**D1：数据源 = runtime 直读 registry.json / outputFile 文件（不经 pi RPC）（选定）**
- **采用**：runtime 新增 `BackgroundTaskService`，按 sessionId 读 `<piAgentDir>/base-tool-enhance/<sid>/registry.json` 与 `<task_id>.log` 尾部。路径经 `getPiAgentDir()` 动态推导（troubleshooting 规则：禁止写死绝对路径）。
- **被否**：① 经 pi RPC 询问（pi 无「extension 状态查询」RPC 面，需新造；且 pi 死后数据消失）；② extension 侧推送（= 方案 A/C，§3.2 已否）。
- **证据**：C1/C2（§2.3）；registry 契约 SSOT `packages/extension-protocol/src/background-task.ts`（RegistryEntry 字段就是 UI 字段：command/pid/state/exitCode/reason/startedAt/endedAt/durationMs/tailSummary/outputFile/ownerPiPid/sessionId/pidStartTime）；reaper 已是 runtime 读 registry 的先例。
- **效果**：G1 的「全部任务（含历史/他进程遗留/orphaned）」成立；数据形状零新造（复用 RegistryEntry）。

**D2：变更检测 = 三触发面（pi 事件钩子 / 2s mtime 轮询 / service 自写自检），共享同一变更判定（选定）**
- **采用**：BackgroundTaskService 对「watched sessionId 集合」（见 D8 ③）每 2s 轮询：stat 各 registry.json 的 mtime，变化才重读+广播。另挂两个 runtime 内已有事件钩子做即时检查——① EventAdapter 流出的 customType `background-bash` 消息（exit 边沿，零延迟；`event-adapter.ts:657-672` 已透传 customType，挂点确认可行）；② EventAdapter 流出的 pi 原始 `tool_execution_end` 事件且 `toolName==='bash'`（覆盖 spawn 路径；实施期澄清：设计初版文字「message.tool_call bash 工具调用结束」在 pi 事件流中的实际形态即 tool_execution_end，`pi-protocol.ts` toolName 字段已核，挂点位置与语义不变）。**事件钩子触发的是对 watched 集合的一次完整变更检测（与轮询共享同一 last-seen mtime 状态），不是第二广播源**——同一变化至多广播一次，renderer 不双渲染。钩子对整个 watched 集合跑检查（非按消息 sid 定向），规避 session 替换后 customStart 投递新 session 与 registry 目录在旧 session 的错位（该错位只损失定向性，不损失正确性）。**service 自写自检**：service 自身写 registry（kill 的 killing 预写 / 分支②③终态写）成功后自触发一次变更检测——killing 状态即时广播，不占轮询节拍。
- **被否**：① 纯 fs.watch——registry 是 tmp+rename 原子写，watch 文件本体会在 rename 时断链，须 watch 目录；Linux recursive watch 支持不稳，还得自配轮询兜底，复杂度不匹配收益；② extension 主动通知（= 方案 C，双源问题）。
- **证据**：exit 通知链路已经过 runtime（`message.customStart`）；任务状态秒级变化的本源（poller 2s tick，`poller.ts:23`）决定了 2s 轮询不劣化感知；spawn/exit 均**先写 registry 后发通知/返回**（`spawn-background.ts:216-220`、`poller.ts:79-86`），事件到达时 registry 已是最新——即时检查读到的是终值，无双读竞态。
- **效果**：常见路径（exit）零延迟翻转；其余迁移（killing）≤2s；单广播源，无双发。
- **粒度边界（2026-09-07 登记，adversarial-review-fixes BG-8 维持）**：轮询判定源是 `statSync().mtimeMs`（`background-task-service.ts` last-seen mtime 比较）——同一 session 的两次 registry 写恰好落在同一 mtime 毫秒粒度内时轮询判定「无变化」漏检一拍。量级：registry 写频 = 状态迁移（spawn/exit/kill），同毫秒双迁移概率极低；且三触发面中仅轮询受此粒度限制——exit 边沿（钩子①）/ spawn（钩子②）/ kill 自写（service 自写自检）不依赖 mtime，高频路径均有事件面覆盖；漏检后果 = 广播延迟到下一次实际变化（状态最终一致，非永久丢失）。维持不改（事件面已兜，换 content hash 判定徒增全量读开销）。

**D3：WS 协议 = 3 个拉取/操作 RPC + 1 个 session 级广播（选定）**
- **采用**：仿 `session.getCommands` 范式（`session-message-handler.ts:466` 的 handler 注册 + `protocol.ts` 类型登记）：
  - `backgroundTask.list {sessionId}` → 回 `backgroundTask.tasks {sessionId, tasks: RegistryEntry[], corrupted?: boolean}`（读 registry 全量；目录/文件不存在 → 空数组；**该 RPC 同时把 session 加入 watched 集合**，见 D8 ③；`corrupted:true` = 该拍 registry 解析失败、tasks 为安全降级空表——§3.1 失败路径错误条与 S7 断言的信号源，实施期一致性审查补入：R1-R4 未发现 D3 形状与 §3.1/S7 的此矛盾，审查期闭合）
  - `backgroundTask.output {sessionId, taskId, maxBytes?}` → 回 `backgroundTask.outputResult {sessionId, taskId, text, truncated, lost}`（读 `<task_id>.log` 尾部，默认 32KB 上界，对齐 bash_output 的 tail 语义）
  - `backgroundTask.kill {sessionId, taskId}` → 回 `backgroundTask.killResult {sessionId, taskId, killed, reason}`（reason 枚举：`killed` / `already-exited` / `identity-unverifiable` / `registry-write-failed`，见 D6）
  - 广播 `backgroundTask:updated {sessionId, tasks, corrupted?}`（Server→Client 冒号 camelCase，对齐 `plugin:statusBarUpdate`/`extension:widgetGui` 命名规则；经 `IMessageBus.publish(sessionId, msg)` session 级定向推；corrupted 语义同 list 回执，自愈拍 corrupted=false）
  - **所有消息必带 sessionId**（架构规则 7）；renderer 在「切换/激活 session、打开 plugin tab」时主动 `list` 拉取（C6 时序竞争规则——broadcast 只做增量刷新，不做唯一真相）。补充事实（R1 审查核实）：`IMessageBus.subscribe` 返回 `{snapshot, stateSnapshot, lastSeq}`（ring 缓冲重放，`message-bus.ts:182-186`），晚订阅 renderer 对已 publish 的 session 级广播有重放——这是拉取兜底之上的又一层保障，但设计**不依赖**它（snapshot 有限 ring，gap 后仍靠拉取）。
- **被否**：复用 `extension:widgetGui` 通道塞任务数据（污染 widget 语义，ViewHostStore 会把它当 GuiComponent 树缓存）；专设 subscribe/unsubscribe 消息（订阅语义由 list 隐含 + session-destroyed 退订已足够，协议面最小，见 D8 ③）。
- **证据**：RPC 范式锚点（§2.2）；命名规则（AGENTS.md 规则 16 的 plugin 先例）；message-bus session 级 publish。
- **效果**：G1 实时性成立（拉取兜底 + 广播增量 + ring 重放）；协议面收敛在单域、无订阅状态机。

**D4：L2 tab 宿主 = contribution 声明 + PluginViewContainer 原生路由表（选定）**
- **采用**：① `builtin-contributions.ts` 新增 pluginId `base-tool-enhance` 的贡献 `{views: [{id: 'background-tasks', placement: 'sidebar.tab', viewType: 'gui', title: '后台命令'}]}`（viewType 沿用 'gui'，不改 schema；title 用「后台命令」——术语裁决见 §1）；② `PluginViewContainer` 新增模块级 `NATIVE_VIEWS: Record<viewId, Component>` 注册表——`activeView` 命中即渲染原生组件（`BackgroundTaskListView`）替代 ViewHost，不命中走原 GuiComponent 路径（对既有 view 零影响）；③ pluginId `base-tool-enhance` 加入 `BUILTIN_PLUGIN_IDS`（不可关闭，基础设施级）；④ **L2 tab 角标（R4 提为首期）**：`L2TabItem` 加 `badge?: boolean` + L2TabBar 渲染小圆点——点亮条件 = 该 session 「运行中」桶计数 > 0，**与 D10 分桶判据同源函数派生**（subagent D8 同款语义闭环：badge 亮 = 默认桶非空，防「badge 点亮而默认视图是历史」断裂；L1 SegmentedTab badge 视觉范式下沉到 L2）。
- **被否**：① 经 `custom` GuiComponent 类型 + `GUI_CUSTOM_REGISTRY_KEY` 编译期注册（机制存在但零先例，且数据仍须以 widget 树形态从 extension 推——数据链路回退成方案 A）；② 改 contribution schema 加 `viewType: 'native'`（涉及多处类型联合同步，收益仅是语义显式化）。
- **证据**：`PluginViewContainer.vue:37/117-123` 全部 viewId 路由到 ViewHost 的现状（R1 审查实读核实）；BUILTIN_PLUGIN_IDS 先例（tasks）；builtin-contributions 是 sidebar.tab 唯一贡献源（§2.2）。
- **效果**：「插件规范」落点成立（声明 + L2 宿主机制沿用）；渲染载体升级为原生组件，G2/G3 交互可达；角标与桶判据同源（G1 增强，R4 提为首期）。

**D5：drawer 接入 = 照 4 点既有范式加第 8 个 tab（选定）**
- **采用**：① `core/domain/drawer/types.ts` `SideDrawerTab` 加 `'bashTask'` + `DrawerControlState` 加 `selectedBackgroundTaskId?: string`（仿 selectedSubagentId 先例）；② `DrawerPanel.vue` tabs 数组加 TabMeta；③ `PanelContainer.vue:107-143` v-if chain 加 `BackgroundTaskDetailPanel`；④ 列表 item 点击 `openDrawerTab('bashTask', {taskId})`（实施形态：经 `DrawerControlState.selectedBackgroundTaskId` 直写后调 `openDrawerTab('bashTask')`，偏差 #17；OpenDrawerOptions 不扩展 taskId）。
- **被否**：模态对话框/行内展开（详情信息量大，drawer 是本应用重详情的既有范式——subagent/workflow 同款）。
- **证据**：drawer 4 点同步范式（R1 审查逐点核实：SideDrawerTab 恰 7 成员/tabs 数组/v-if/兼容层）；`useSideDrawer.ts:79-106` 兼容层；宽度持久化 `useDrawerSplitWidth` 自动承接。
- **效果**：G2 落点；与 subagent/workflow 详情交互一致，无新学习成本。

**D6：kill 回路 = 完整分支矩阵 + killing-intent 预写（选定；R1 审查后结构性修订）**

先决事实（R1 审查攻击出的两个坑，是本决策形态的成因）：
- **坑 1（AI 误唤醒）**：若 runtime 只发 kill 信号不写 intent，extension poller 边沿终态 reason=natural（C4）≠ killed → `handleTaskExit` 对非 killed reason 一律 `pi.sendMessage(deliverAs:'steer', triggerTurn:true)`（`notify.ts:143-171`）→ **用户终止任务反而唤醒 AI 并告知「任务失败」，AI 可能自行重启刚被用户杀掉的任务**——G3 被系统性削弱。
- **坑 2（悬挂/误杀）**：分支不全的 kill handler 在「pid 已死+属主活（poller 冻结则 registry 永停 running）」「Windows 无 ps → pidStartTime 普遍缺省（照抄 reaper 保守跳过 = Windows kill 系统性失效）」「终态写失败（恢复粒度未定义）」三个分支上被迫临场发明设计。

**采用——kill handler 完整分支矩阵**（前置：读 registry 条目 + 锁内校验，所有写均走 `<registry.json>.lock` RMW，与 extension/reaper 写侧互斥已核实）：

| # | 分支（锁内判定时序） | 动作 | 终态写归属 | 通知 |
|---|---|---|---|---|
| ① | 活跃态 + pid 活 + 身份验证通过 + **属主 pi 活** | 锁内预写 killing（**仅置 `state:'killing'`，不写 reason 字段**——契约规定 reason 仅 exited 语义，`background-task.ts` 字段注释；与 bash_kill 落盘同构，`bash-kill-tool.ts:124-127`）→ `killProcessTree(pid)`（C3 复用） | extension poller ≤2s 边沿终态化：内存 intent 缺省时**读回 registry state killing → reason=killed**（D6-en），exitCode/null + tailSummary | reason=killed → **不发 sendMessage**（`notify.ts:146` 既有语义）→ AI 零感知（主路径，边界注见 D6-en）；pending:unregister 标 cancelled（既有） |
| ② | 活跃态 + pid 活 + 身份验证通过 + **属主 pi 死** | `killProcessTree(pid)` → 锁内写 orphaned 终态（reaper 分支②同款；`writeOrphanedTerminal` 需从 reaper 模块导出/提炼，§5 地图） | runtime（本分支即终态） | 无 extension 通知（属主已死）|
| ③ | 活跃态 + **pid 已死**（任属主） | 不发 kill 信号；锁内 RMW：若条目仍 active → 写终态（属主活：exited/reason natural/exitCode null——poller 若健康会 ≤2s 用真实 exitCode/tailSummary 覆盖；属主死：orphaned，对齐 reaper 分支③）。实现顺序：**判活重查置于锁内重读之后**（writeMerged 范式，防 stale 条目覆盖 poller 已写的新鲜 exitCode/tailSummary）→ 回 `already-exited` | runtime 写过渡值；属主活时 poller 覆盖为权威值（两写均终态、RMW 串行，覆盖无害） | poller 覆盖时按其 reason 语义（natural→可能 sendMessage，见 D6-en 边界注） |
| ④ | **身份验证不可判定**（探测不可得，含 Windows 权限拒绝） | 不发 kill 信号，回 `identity-unverifiable`；UI 提示「宁不杀勿误杀」+ 可重试 | 无 | 无 |
| ④b | **身份比对失败**（有判定结果 = start-time 不匹配 = pid 已被复用） | 不发 kill 信号；按③路径为原条目收尾（原进程已死，pid 归新主）——③锁内判活重查发现复用者存活时拒绝终态化，回 `identity-unverifiable`（宁不杀勿误杀，可重试）。实施期审查确认设计矩阵初版无此行，实现按本行落地（`background-task-service.ts` mismatch → finalizeDeadEntry 路径） | 同③ | 同③（不通知 AI） |
| ⑤ | 任一锁内写失败（intent 预写/终态写） | **中止 kill**（未发信号则不杀；已发信号则条目按①②既有路径收尾），回 `registry-write-failed` | 失败分支：条目停留原状态 | 兜底：下次 app 启动 reaper 全量扫描（触发面 B）；属主活分支由 poller 自然收尾 |

**身份验证两档（分支④的判定）**：① 条目有 `pidStartTime` → 平台 start-time 严格比对（复用 reaper `pidStartMatchesRegistered`，macOS/Linux `ps -o lstart=`）；② 字段缺省（Windows spawn 时普遍读不到，`spawn-background.ts:192/:204`）→ **按需现测**：macOS/Linux `ps` 补测目标 pid start time 后同比对；Windows 按 `Get-Process` `.StartTime`（或 CIM `Win32_Process` CreationDate）取值，**输出格式固化 ISO 8601 / DMTF（locale 无关）**后与条目 startedAt 同口径比对（kill 是用户显式动作，一次性 ~百 ms 探测成本可接受）；探测**异步执行（或短超时 ≤1s），不阻塞 runtime 事件循环**（reaper 的 spawnSync 5s 先例是启动期语境，不照搬到在役 RPC 路径）；③ 现测也不可得（含 Windows 权限拒绝 AccessDenied）→ 分支④拒绝。**被否：照抄 reaper「保守跳过」**——reaper 是无人值守自治扫描（宁漏杀勿误杀），UI kill 是用户显式指令且有人工反馈回路，正确策略是「补全验证材料」而非放弃；否则 Windows 上 G3 系统性失效（R1 M2-ii 反例）。

**D6-en（enabling change，base-tool-enhance 唯一改动）：poller 终态化时合并读回 registry killing 状态**
- **采用**：`poller.ts` exit 边沿 finalize 时，若内存 entry 无 intent，**读回该条目的 registry 条目：`state==='killing'` 且内存 intent 缺省 ↔ reason=killed**（经 registryPath；读失败按无 intent 处理，不阻塞终态化）。信号等价性依据：killing 条目在 registry 中的唯一可读信号就是 state 字段（bash_kill/timeout 落盘同样剥离 intent，`taskToRegistryEntry` 明文剥离；协议零改动，与 D9 一致）。效果：① 分支①的 reason 语义正确（killed 而非 natural，C4 在 UI 代杀路径收窄）；② `handleTaskExit` 对 killed 不 sendMessage（既有语义）→ **主路径 AI 零感知、不被唤醒**。改动与 extension 自身设计自洽（「intent 写入单例表与 registry 两侧」本就是其声明行为，缺的只是读回）。同 app 发布版本内耦合（builtin 打包，mandatory-extensions 同 bundle，无版本漂移面；独立 pi CLI 用户无 UI，不受影响；dev-link 本地开发存在旧 extension × 新 runtime 的临时偏斜，已知可接受）。**配套加固（U6 内，2 行）**：`armBackgroundTimeout` 在 pid 已死（`isRecordedPidStillOriginal` 为假）时跳过 `markKillingIntent('timeout')`——否则 UI kill 与 timeout 到期同秒重叠时，内存 intent 被无条件覆盖为 timeout → reason=timeout ≠ killed → sendMessage 唤醒 AI（R2-S1 残余窗口）。接受语义微移：到期前 ~2s 内自然死亡的任务改标 natural（仅影响 AI 通知文案）；该加固同时**改善既有** AI bash_kill × timeout 交叉行为（原：bash_kill 后 timeout 到点无条件覆盖 intent → 误报「timed out」；加固后保持 killed 无通知）。**不变量登记（U6 注释级）**：intent 不可丢失依赖纪律性约束「extension 对某条目的每次 registry 写都先经该条目的内存状态更新」（已枚举全部 5 个 `writeRegistryEntry` 调用点成立：spawn=新条目 / bash_kill 先 mark / timeout 先 mark / poller=终态 / process-exit-guard reapBackgroundTasksNow=终态；实施期 grep 核实修正，设计初版枚举 4 点漏计第 5 点，两处终态写同序均成立）；runtime 预写的 killing 不会被 stale 内存态冲回即依赖此约束，未来新增写路径（如 maintenance 类）须保持。
- **被否**：① **extension 零改动**（本设计 R0 立场）——**被坑 1 反例击穿**：UI kill 必然触发 AI steer 唤醒 + 「任务失败」误导通知，G3 的「可控」名存实亡；接受该副作用（R1 建议选项 a）不可取——用户终止任务的意图是「停止工作」，AI 被唤醒后自行重启任务是最差结果。② runtime 伪造 bash_kill 工具调用（pi 无工具调用 RPC 面，且语义污染）；③ 只发信号不写 intent（= 被否①的变体，同样触发坑 1）。
- **证据**：`notify.ts:143-171`（非 killed 一律 sendMessage + steer/triggerTurn）；`notify.ts:146`（killed 不发）；`bash-kill-tool.ts:76-87`（跨进程拒绝语义——kill 本就允许非发起方路径存在）；extension 设计 §3.5「kill 路径不 sendMessage」先例。
- **效果**：G3 主路径完整成立（终止 + 不惊扰 AI）；S2/P7 验收断言对话侧零变化（主路径口径）。**边界注（诚实登记，R2 复审后收窄口径）**：① 分支③属主活 + poller 健康的覆盖写仍按 poller 语义（natural → sendMessage）——该场景任务本就自己死了，通知 AI 属既有行为语义，不是 UI kill 引入的；② timeout 交叉残余窗口——kill 与 armed timeout 到期同秒级重叠时，extension 的 `markKillingIntent('timeout')` 无条件覆盖内存 intent（runtime 预写对 pi 内存不可见）→ 该次 kill 的 reason=timeout → 通知「timed out」唤醒 AI。窗口 = 同秒重叠 + poller tick 落在 mark 之后，且同型竞态在 AI bash_kill × timeout 交叉中本就是 extension 既有行为（非本设计新造）；经 U6 配套加固（pid 已死跳过 mark）后**收窄至 SIGKILL 生效前的毫秒级重叠窗**（timeout 到期恰逢已发令未 reap 且身份校验仍匹配时 mark 仍会覆盖——实施期审查修正初版「构造性关闭」的过强措辞），加固未上线的版本组合下窗口仍在（发布面同 bundle 不出现）。

**D7：输出详情 = 按需 tail RPC + running 时 2s 自动跟随（选定）**
- **采用**：drawer 打开/切任务时拉一次 `backgroundTask.output`；任务 running 且 drawer 保持打开时每 2s 重拉（renderer 侧 interval，drawer 关闭/任务终态/组件卸载即停——停止条件依赖 store 的终态感知，广播/轮询送达后自动停，C6 拉取兜底覆盖断连窗口）。算法 = 从文件末尾按字节窗口读（`output-tail.ts:34-74` 同语义，runtime 侧独立实现，不 import extension 代码）。
- **被否**：WS 流式推送输出（增量拼接、断线补齐、背压全要做，收益仅省 2s 轮询；输出观感本就是日志滚动）。
- **证据**：子进程持 fd 直写、随时可 tail（§2.2 表）；bash_output 工具同款 tail 语义先例（2000 行/50KB 上界）。
- **效果**：G2 的输出跟随成立；实现面一个 RPC + 一个 interval。

**D8：session 隔离与生命周期（选定）**
- **采用**：① renderer 侧任务状态用 `useSessionScopedState` 工厂建 per-session Map 分区（ADR-0049 范式，`core/src/foundation/use-session-scoped-state.ts:103`），WS handler 一律 `updateFor(capturedSid)`；**WS 消息 listener 收敛为模块级单例注册（refCount 或应用生命周期持有），消费组件（列表视图 + split mode 下 per-pane 多实例的 DetailPanel）只读写分区状态，不各自挂 listener**（AGENTS.md 规则 2：Event bus listener 防重复注册）；**筛选桶状态同样经 `useBackgroundTaskBucketFilter`（D10）按 session 分区，组件纯读，禁 watch(sessionId) 清空**；② 轮询/广播域严格以 sessionId 为键（registry 目录、message-bus publish、store 分区三层同键）；③ **watched 集合生命周期**：session 首次 `backgroundTask.list` RPC 即加入 watched（D3），退订挂 session 销毁汇聚点（session-service `removeSessionEntry`，与 reaper 触发面 A 同挂点，R1 审查建议采纳）——watched 集合上界 = 运行期内被查看过的 session 数，每 session 成本 = 1 次 stat/2s，可忽略；垃圾 sessionId（renderer 传错）同样入集合但 stat ENOENT 按空表静默处理（不告警刷屏，R2 I4）；split mode 双 pane 双 session 并存时 watched 自然是两 pane session 的并集（各自 list 过）；④ `session-destroyed` → renderer 分区清理（`useSidebar.deleteSession` 统一编排既有链路）+ runtime 侧移出 watched；⑤ fork/新 session 的 registry 目录为空 → 空态（C5，正确语义）。
- **被否**：全局单列表 + 过滤（违背 ADR-0049，切 session 竞态面大）；专设 subscribe/unsubscribe 协议消息（D3 已否）。
- **证据**：ADR-0049（架构规则 8）+ 规则 2；message-bus per-session seq（`message-bus.ts:180-186`）；ViewHostStore 双键分区同款先例（§2.2）；`removeSessionEntry` 汇聚点先例（reaper 触发面 A）。
- **效果**：G4 构造性成立（三层同键隔离）；listener 无重复注册面。

**D9：数据契约零新造（选定）**
- **采用**：renderer/runtime 间任务形状直接用 `BackgroundTaskRegistryEntry`（`@xyz-agent/extension-protocol` background-task.ts），字段名/枚举零改名（与 bash_output 工具返回的 snake_case 不同——那是 AI 工具面契约，UI 走 extension-protocol 契约，两者各自稳定）。
- **被否**：为 UI 单独造 DTO（两份形状漂移风险；bash_output 的 80 字符截断是 AI 上下文预算考量，UI 不需要）。
- **证据**：extension-protocol 是跨层 SSOT 的既有定位（background-task.ts 文件头）。
- **效果**：§5 拆分中无「契约设计」单元，协议层只登记 WS 消息形状。

**D10：列表二级状态筛选 + 行内终止（R4 新增，对齐 dev-0.9.15 subagent-sidebar-filter 范式）（选定）**
- **采用**：列表顶部迷你凹陷槽三桶筛选——**运行中 / 已结束 / 全部**（带计数预告，默认「运行中」），视觉照搬 Agents tab 二级筛选范式（`bg-bg-input` 凹陷底 + active `bg-bg-elevated` 浮起，h-6，SegmentedTab/L2TabBar 同源）。四个子决策：
  - **① 分桶判据与状态展示 SSOT**：新建 `renderer/src/lib/background-task-bucket.ts` 纯函数模块（导出 `backgroundTaskBucket / filterBackgroundTasks / countBackgroundTasks / backgroundTaskStatusIcon`），分桶直接复用契约谓词 `isActiveBackgroundTaskState`（`@xyz-agent/extension-protocol`，D9 同源）——**运行中 = running + killing（killing 是「已发令待确认」的活跃瞬态，用户视角仍在终止流程中）；已结束 = exited（含 natural/timeout/killed）+ orphaned**。比 subagent 分桶更干净：无投影微妙性（subagent 的 done 投影陷阱不存在——契约 state 机显式、无「轮终回写 running」形态）。列表过滤、FilterBar 计数、L2 角标（D4 ④）、item icon 色档（⑤，`backgroundTaskStatusIcon(entry)` 返回 IconKind）**四方同源消费，禁两处各写判定**（subagent D3 同款纪律）。
  - **② 筛选状态分区**：新建 `useBackgroundTaskBucketFilter(sessionId)` composable——`useSessionScopedState<{ value: FilterValue }>(sessionId, () => reactive({ value: 'active' }))`，**标量必须对象包装且必须 reactive 容器**（工厂响应式契约，subagent MF-A 同款死锁级坑：plain object 的 mutate 不触发下游重算）；挂载期内跨 session 切换分区记忆、切 tab 卸载重置默认「运行中」；不跨启动记忆（运行态时间敏感，重启后旧选择大概率过期）。组件纯读，禁 watch 清空（ADR-0049）。
  - **③ 空态三分**：全量空态（registry 空）不渲染筛选条（0 计数槽是纯噪音，subagent D6 同款）；「运行中」空桶 → 自适应空态「没有运行中的后台命令」+ **[查看全部 (N)]** 一键跳转（高频：跑完回来看一眼 → 一键看历史）；「已结束」空桶 → 仅文案。全部桶内：运行中置顶 + 分隔线 + 历史倒序（保留分组可读性）。
  - **④ 行内两段式终止**：运行中行第二行右侧 hover 出现 ✕ 按钮（仅 running 行；killing 行已发令不重复发）→ 第一次点击变红色 ✓ 确认态 → 再点一次才真正发 `backgroundTask.kill` RPC（与 Agents tab cancel 同交互语言，inline 确认不开弹窗）。G3 快路径：无需开 drawer 即可终止；drawer 内完整「终止任务」按钮保留（两段式同款）。
  - **⑤ item 两行式（SessionItem 同构，用户裁决）**：第一行 = 7px 状态 icon + 命令（truncate）+ 右侧耗时；第二行 = mono 小字（text-3xs dim）`pid N`（终态附 `· exit C`，**C=null（timeout/外部手杀 natural——SIGKILL 终止 exitCode 为 null，`poller.ts:79`）时显示 `exit —`**，对齐 notify「unknown」先例）+ 右侧 hover 终止钮（④）。**状态文字徽标不进列表——icon 即状态**，色档由 `backgroundTaskStatusIcon`（① SSOT）统一导出，**判定顺序固定：state 先分流（running→accent 旋转环 / killing→warn 点 / orphaned→info 点）→ exited 内 reason==='killed' 优先分流 dim 点（killed 的 exitCode 也是 null，若先判 exitCode 会误入 danger）→ 其余 exitCode===0 ? success 点 : danger 点（`exitCode !== 0` 吸收 null——timeout 与非零失败同为 danger 档，色档不区分 reason=timeout，差异由 drawer reason 行与 icon 文字后备承载）**；文字后备双轨：根元素 aria-label（无障碍，SessionItem ariaLabel 同构）+ icon title（视觉 hover）。「成功/失败」徽标与 exit 码信息重复，只留 exit 码。结构锚点：`SessionItem.vue`（7px icon + mt-6px + label/sub 两行 + hover ghost 操作范式）。**被否：① 三行式 subagent 卡片同构（R4 初稿）——命令列表场景信息密度过高（行数冗余，tailSummary 摘要行价值低——输出细节归 drawer）；② 状态文字徽标——icon 已可辨别，徽标冗余且与 exit 码语义重复（用户裁决）；③ 终态时刻进列表第二行——终态时刻归 drawer 元信息，第二行只留 pid + exit。**
- **被否**：① 平铺全量列表 + 分组分隔线（v1 形态）——被 subagent 设计的同类问题分析击穿：「现在谁在跑」是最高频关注点，历史单调累积（LRU 50）后运行态被流没，关注路径 O(n) 肉眼扫描；筛选默认「运行中」把高频视图变成默认视图；② 筛选下拉/搜索框——单维度二桶语义用不上搜索，且与两级 tab 体系视觉语言异质；③ 排序/按 reason 筛选——无需求证据，不提前抽象（subagent D7 同款克制：Flows tab 不接同一筛选，两处消费才抽象）。
- **证据**：dev-0.9.15 `docs/design/subagent-sidebar-filter.md`（三轮审查收敛的同问题域设计：O(n) 扫描分析 / badge↔列表断裂 / 空桶自适应 / reactive 容器契约）+ 实装锚点（`SubagentFilterBar.vue` 凹陷槽参数、`subagent-bucket.ts` SSOT 形态、`useSubagentBucketFilter.ts` 分区语义、`SubagentList.vue` 三行卡片与 inline 两段式 cancel）；i18n 术语冲突（`zh-CN/sidebar.ts:136`）。
- **效果**：G1 增强（默认视图 = 高频关注点 + 计数预告 + badge 语义闭环）；G3 快路径（行内终止）；视觉语言与 Agents tab 一致（两级 tab + 凹陷槽体系零新增形态）。

### 3.4 运行时断言与探针

| # | 断言 | 探针 | 状态 | 失败时的降级/调整路径 |
|---|---|---|---|---|
| P1 | registry 每次 tmp+rename 原子写，runtime 无锁读永不读到半截 JSON | runtime 单测：并发写（循环 rename 新文件）× 并发读 1000 次，parse 成功率 100% | ⛔ 实施期门 | 失败 → 读侧按解析失败跳过本拍（§3.1 corrupt 路径），下拍重读；不阻塞方案 |
| P2 | exit 边沿 → renderer 列表翻转 ≤1s（事件触发路径） | dev 环境：AI 跑 `sleep 3`（显式 background）→ 观察 plugin tab 状态翻转耗时 | ⛔ 实施期门 | 失败 → 事件钩子本就是纯优化（D2），2s 轮询兜底，≤3s 达标即放行 |
| P3 | 无事件路径（killing 迁移）→ 列表翻转 ≤2s+轮询周期 | dev 环境：bash_kill 一个任务 → 计时列表「终止中」出现时刻 | ⛔ 实施期门 | 失败 → 检查轮询周期配置；轮询是自持机制无替代，此探针失败 = D2 需重审 |
| P4 | kill 后任务进程树真死（不只父进程） | dev 环境：UI 杀 `sh -c 'sleep 300 & sleep 300'` → `ps aux \| grep sleep` 确认子进程同殁 | ⛔ 实施期门 | 失败 → killProcessTree 平台分支 bug（C3 复用件），修 bug 而非改设计 |
| P5 | 属主死分支：kill 孤儿 → registry 锁内写 orphaned，列表 ≤3s 翻转 | dev 环境：强杀 pi 进程后 UI kill 遗留任务 | ⛔ 实施期门 | 写失败 → 分支⑤语义（registry-write-failed + 启动期 reaper 兜底），探针失败仅延迟恢复，不破坏正确性 |
| P6 | session A 广播不进 session B 分区 | vitest：双 session store 分区，publish(sid=A) 后断言 B 分区无变化 | ⛔ 实施期门 | 失败 = D8 分区实现 bug，修实现；无设计降级 |
| P7 | UI kill 后对话流**无**新增 background-bash 消息、AI 无被唤醒的新 turn | dev 环境：UI 杀 AI 发起的 dev server → 观察对话流与会话状态（R1 M1 新增；主路径口径，timeout 交叉窗口经 U6 加固收窄至 SIGKILL 生效前的毫秒级重叠窗，见 D6-en 边界注②） | ⛔ 实施期门 | 失败 → D6-en intent 读回未生效（extension 侧），属实现 bug 非设计降级；不接受唤醒副作用上线 |

## 4. 验收（真实场景）

前置：`pnpm dev` 真实环境（非 mock；runtime/extension 改动后须重启 dev——runtime 不热重载）。

| # | 场景（回溯目标） | 步骤 | 通过标准 |
|---|---|---|---|
| S1 | 后台任务全程可见（G1/G2） | 让 AI「后台跑 pnpm test」→ 切该 session 的插件→后台命令 tab：验证筛选槽三桶计数与切换（运行中→已结束→全部），守到测试结束 | 默认「运行中」桶只含运行中任务、计数正确；结束 ≤3s icon 翻转为 exited 语义色（成功=success 点 / 失败=danger 点，色档由 bucket SSOT `backgroundTaskStatusIcon` 派生）并自动归入「已结束」桶（计数 +1 / 运行中 -1，角标随消）；「全部」桶运行中置顶 + 分隔线 + 历史倒序；点击行 drawer 显示 exitCode 与输出尾部（`backgroundTask.output` 按需拉取，D7——实施期审查修正初版误写的「tailSummary」展示位，该字段是 RegistryEntry 数据字段、无 UI 展示位）与对话流 background-bash 消息内容一致 |
| S2 | 长驻任务可控且不惊扰 AI（G3） | 让 AI 起 `pnpm dev`（force-longrun 自动后台）→ 列表行内两段式终止（✕→✓），再起一个用 drawer「终止任务」→ 持续观察对话流 30s | 两条路径均 ≤5s 变终态（killing 翻转即时；killed 终态最坏 ~4s，P3 同框口径；reason=killed）；`lsof -i :1420` 确认端口释放、`ps aux \| grep vite` 无残留；**对话流无新增 background-bash 消息、会话无新 turn（AI 未被唤醒）、pending 通知标 cancelled** |
| S3 | session 隔离（G4） | session A 起后台任务 → 切 session B 看插件 tab → 切回 A | B 的列表不含 A 的任务（空态或仅 B 自己的历史）；切回 A 立即见 running 行（拉取兜底生效，不依赖广播） |
| S4 | 历史与孤儿（G1） | 跑完几个任务后完全退出 app 再启动；再模拟强杀 pi（kill -9 pi 进程）后重启 app | 重启后终态历史仍在（registry 持久）；孤儿任务显示 orphaned（info 色 icon），不悬挂 running——**Gate B 实测修正**：孤儿收殓实际由 runtime 在运行期 ~1.5s 内自动完成——收殓链路是 pi 进程退出收敛（pm.onSessionExit → session-service removeSessionEntry 收殓挂点 reapSessionBackgroundTasks，即 §2.2 已登记的 reaper「session 删除」触发面；强杀 pi 当拍即殁、无遗留可杀），启动收殓仅作兜底；D2 事件钩子无收殓能力（强杀 pi 后事件流终止，钩子不可能触发）；最终态与设计一致 |
| S5 | 输出跟随（G2） | drawer 打开 running 任务（如 `pnpm test`），观察输出区 | 尾部输出持续滚动增长（2s 节拍）；终态后停止轮询（DevTools network 无持续请求） |
| S6 | 负面行为（G4/稳定性/筛选边界） | 无任务 session 打开 tab（全量空态）；全部已结束 session 的默认视图（运行中空桶）；只有运行中时切「已结束」（已结束空桶）；对终态任务开 drawer；断开 WS（杀 runtime 再自动重启） | 全量空态不渲染筛选条；运行中空桶显示「查看全部 (N)」且点击跳转正确；已结束空桶仅文案；终态 drawer 无 kill 按钮；WS 重连后列表自动重拉恢复（筛选桶选择保留），无白屏/报错 |
| S7 | 数据损坏降级（G1 稳健性，R1 新增） | 手工把 registry.json 改成非法 JSON → 打开后台任务 tab；再让 AI 发起一个新后台任务 | 损坏拍显示空态 + 「任务数据损坏」错误条；AI 发起新任务后（extension 自愈空表重建）错误条消失、新任务正常出现；`.corrupt` 现场文件存在 |

## 5. 下一层拆分

实施路径：runtime → 协议 → renderer 列表 → drawer → 验收，每单元可独立验证（impl-plan 细化）。

| 单元 | 内容 | justification（为什么这么拆） | 独立验收 |
|---|---|---|---|
| U1 runtime BackgroundTaskService | 读 registry（契约复用 RegistryEntry）+ 2s mtime 轮询 + 事件钩子即时检查（共享变更判定）+ service 自写自检 + kill 分支矩阵（D6 五分支 + 身份验证两档）+ output tail；watched 集合生命周期（list 加入 / removeSessionEntry 退订 / 垃圾 sid ENOENT 静默空表） | 数据链路根，纯 runtime 内可单测（vitest，tmp 目录 mkdtempSync 自建自删——测试红线：禁触真实数据目录） | P1/P5 单测 + P4 dev 手测（P4 杀真实进程树，不可单测——测试红线精神） |
| U2 WS 协议域 | `packages/shared/src/protocol.ts` 登记双向消息类型 + renderer api domain（仿 session.ts） | 协议先行，U3/U4 的消费面契约；单独改动面小、review 快 | 类型检查 + U3 handler 单测 |
| U3 runtime RPC handler + 广播 | session-message-handler 注册 3 RPC + message-bus session 级 publish + session-service removeSessionEntry 退订挂点 | 传输层与 service 分离（service 不感知 WS）；仿 getCommands 范式 | P2/P3/P6 |
| U4 renderer 列表视图 | builtin-contributions 声明 + PluginViewContainer NATIVE_VIEWS + L2TabBar badge 扩展 + BackgroundTaskListView（两行式 SessionItem 同构 item + 筛选槽 + 空态三分 + 行内两段式终止）+ background-task-bucket.ts（分桶 SSOT）+ useBackgroundTaskBucketFilter（reactive 容器分区）+ useBackgroundTasks（useSessionScopedState + 模块级单 listener refCount） | UI 消费面闭环（G1 + D10）；「插件规范」落点在本单元 | S1/S3 前半/S6 筛选边界 |
| U5 drawer 详情 | SideDrawerTab 加成员 + DetailPanel（元信息/输出跟随/kill 按钮 + 分支④⑤ toast 文案）+ 4 点接线 | G2/G3 交互闭环；依赖 U2 的 output/kill RPC | S1 后半/S2/S5 |
| U6 base-tool-enhance intent 读回（D6-en） | `poller.ts` finalize 合并 registry state killing → reason=killed + `armBackgroundTimeout` pid 已死跳过 markKillingIntent（R2-S1 加固，2 行）+ 不变量注释登记（extension 写 registry 必先内存更新）+ 既有 extensions:test 三连回归 | S2 的 reason=killed + AI 零唤醒依赖它；独立于 runtime/renderer 可先行合入（对 AI bash_kill 路径是幂等增强——内存 intent 优先，读回仅在缺省时生效） | P7 + extensions:test |
| U7 i18n + testid + 文档 | zh-CN/en-US 文案、data-testid 清单登记、feature-map 更新 | 交付完整性；TEST-STRATEGY 的 testid SSOT 纪律 | lint + 测试三视角用例 |

**文件改动地图**：
- `packages/shared/src/protocol.ts`（+消息类型）
- `packages/runtime/src/services/background-task/`（新：service + tail 读取 + 终态写工具）
- `packages/runtime/src/services/session/background-task-reaper.ts`（`writeOrphanedTerminal` 等终态写提炼/导出为可复用——R1 M2 指出其为模块私有）
- `packages/runtime/src/transport/session-message-handler.ts`（+3 case）
- `packages/runtime/src/infra/pi/event-adapter.ts`（+2 个事件钩子转发，纯旁路不改既有翻译）
- `packages/runtime/src/services/session/session-service.ts`（removeSessionEntry + watched 退订挂点）
- `packages/core/src/extension-host/builtin-contributions.ts`（+view 声明）
- `packages/ui/src/extension-host/PluginViewContainer.vue`（+NATIVE_VIEWS）
- `packages/core/src/domain/drawer/types.ts`、`packages/ui/src/features/drawer/DrawerPanel.vue`、`packages/renderer/src/components/workspace/PanelContainer.vue`（drawer 4 点）
- `packages/renderer/src/lib/background-task-bucket.ts`（新，D10 分桶 SSOT）、`packages/renderer/src/composables/features/sidebar/useBackgroundTasks.ts` + `useBackgroundTaskBucketFilter.ts`、`packages/renderer/src/components/extension/BackgroundTaskListView.vue`（含内联 BackgroundTaskFilterBar，形态对齐 SubagentFilterBar）、`.../BackgroundTaskDetailPanel.vue`（新）
- `packages/ui/src/extension-host/L2TabBar.vue` + `l2-tab-item.ts`（badge 支持，D4 ④）
- `extensions/universal/base-tool-enhance/src/background/poller.ts`（D6-en intent 读回）、`.../background/spawn-background.ts`（armBackgroundTimeout 加固，R3-S1）、`.../background/task-store.ts`（不变量注释登记落点）
- i18n locales、`docs/feature-map/`

**待验证检查点（设计阶段无法确定，留实施期）**：
- dev-0.9.15 合入时序：本设计落地的分支若早于 subagent-sidebar-filter 合入 main，BackgroundTaskFilterBar 按 dev-0.9.15 设计参数独立实现（凹陷槽参数一致）；若已合入则评估直接复用组件形态（两处消费才抽象，本设计不提前假设其可复用性）
- ~~message-bus snapshot 补发~~（R1 审查已用源码关闭：subscribe 返回 snapshot 重放，写入 D3 事实）
- ~~customType 透传~~（R1 审查已用源码关闭：`event-adapter.ts:657-672` 已透传，钩子挂 EventAdapter 旁路定案）
- Windows `Get-Process` 身份探测的实际延迟与失败率（D6 分支④③档；影响的是 kill 可用性回退文案，不影响架构）

## 附：关键事实源（调研锚点）

- 本仓两份 explorer 调研报告（2026-09-04，已固化入库；原文件已删除，git 可追溯）：`background-task-sidebar-view.research-data.md`（数据源全景）、`background-task-sidebar-view.research-view-flow.md`（view/drawer/widget 链路；原始落盘 /tmp/bg-bash-design/ 与 /tmp/view-flow-research.md）
- 原 `docs/design/base-tool-enhance.md` §3.5（任务生命周期数据流、两层存储分工、跨进程边界；已删除，git 可追溯，决策沉淀在 base-tool-enhance 包内源码注释）
- `packages/extension-protocol/src/background-task.ts`（registry 契约 SSOT）
- R1 对抗审查报告：`background-task-sidebar-view.review.md`（已删除，git 可追溯；20+ 锚点核实记录 + 攻击面核验）
