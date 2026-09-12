# GUI 数据多源治理：全量修复与预防机制设计

> **一句话结论**：12 类 GUI 数据多源的病根不是缓存，而是「权威源之外的第二个写入者」与「派生在多个进程独立发生」。终态架构由五条原则构成：① **绝对写规则**——xyz 任何代码永不写 pi 的文件，pi 持有状态的读写只发生在 pi 内部，能力缺口由 pi 扩展在 pi 内补齐（`appendEntry` 是官方通道），runtime 只经 RPC 存取；② **投影只发生一次**——runtime 是唯一投影宿主，renderer 零派生；③ 标量状态走**通用快照复制原语**（快照拉取 + 事件只做失效），日志数据走**单一 reducer 双路喂入**；④ 队列等无 pi 通道的数据**按字段分权威**并登记；⑤ **治理即代码**——登记表是可执行配置，护栏 = 机器检查（pre-commit/lint/等价性测试）+ pr-cr-fix 语义审查 agent 双层。缓存按「是否存在第二写入者」判据分类处置，不整体删除。

> 层声明：本文档是**技术方案设计**（当前层 = 问题诊断 + 目标架构，下一层 = 可实施的接口/数据模型/迁移计划，P0 阶段可直接开工）。层敏感准则 5/6/7（物理数据流 / 错误恢复 / 运行时断言探针）全适用。

---

## §1 背景目标

### SCQA

- **S（情境）**：xyz-agent（Electron + Vue 桌面 AI Agent 工作台）的 GUI 显示 session 列表/标签/模型/思考档位/上下文用量/消息流/队列/subagent/workflow 等 12 类数据，底层权威源只有一个——pi 子进程（持有 session JSONL 文件与 agent 内存态，提供 `get_state` / `get_session_stats` / `get_messages` 等 RPC 快照接口）。
- **C（冲突）**：同一份数据在 runtime 进程与 renderer 进程各建了独立缓存与推导管线，实测 12 类数据平均 3-6 个触点（写入点/缓存/解析管线）；最危险的 session 标签存在**两个互不知情的写方直接写 pi 的 session 文件**，已证实「用户手动命名的 session 会被 auto-rename 静默覆盖」；runtime/renderer 代码注释中记录了至少 4 次同源历史踩坑（inputTokens 竞态、thinkingLevel 恒 undefined、磁盘 modelId 空串覆盖真值、label 旧值覆盖）。
- **Q（问题）**：如何全量修复这 12 类多源问题，并建立机制使未来不会再出现新的多源数据？
- **A（答案）**：不删除缓存层——缓存不是病根，「独立写路径 + 多处独立派生」才是。把系统按本质重新组织为一个**状态复制系统**：pi 是唯一权威源，runtime 是唯一投影宿主（一级副本），renderer 是零派生的视图终端（二级副本）；写路径收敛为「只有 pi 写 pi 的文件」，读模型收敛为「每类数据恰好一份派生代码」；再用机器检查 + skill 语义审查的双层护栏保证结构不回退。

### 系统是什么

xyz-agent 三进程架构：**renderer**（Vue 前端，Pinia store 持 GUI 状态）↔ WebSocket ↔ **runtime**（Node.js 服务，管理 pi 子进程生命周期、翻译 pi 事件为 WS 广播）↔ stdio RPC ↔ **pi 子进程**（每 session 一个进程，唯一持有 session 文件 `<getDataDir>/sessions/**/*.jsonl` 与 agent 内存态）。

这个问题的本质是**状态复制**：pi 是权威源，runtime 与 renderer 是两级副本。可靠副本同步只有两种成熟形态——快照 + 失效信号（权威事件流不可靠时），或带序号的日志复制（权威事件流可靠时）。xyz 当前的畸形在于走了第三条路：把**不可信的事件流当数据载体**，再在两个进程各自拼回状态。

pi 的能力面（本设计调研期已逐一 read 源码核实，见 §3.3 各决策的探针标注；行号对齐 pi-mono main 0.80.3，项目实装 `@earendil-works/pi-coding-agent@0.84.1`，两版行为一致）：

**快照 / 写接口（RPC，命令面是固定 switch，扩展不可注册新命令——rpc-mode.ts:385 起）**：

- `get_state`（rpc-mode.ts:442）：一次返回 model / thinkingLevel / isStreaming / isCompacting / sessionName / pendingMessageCount / messageCount / sessionFile——session 级状态类数据的真值全在此；
- `get_session_stats`（rpc-mode.ts:566）：contextUsage（上下文用量真值）；
- `get_messages`（rpc-mode.ts:645）：消息列表真值（xyz 侧已核实：rpc-client 该方法标 `[DEAD]` 生产零调用，getHistory 实际走 `get_entries` entry 树重建，见 `packages/runtime/src/infra/pi/rpc-client.ts:511`）；
- `get_entries`（rpc-mode.ts:609）：entry 列表，支持 `since=<entryId>` 增量游标；游标失效（entry 不存在）返回错误，调用方退化为全量重拉——**扩展数据的官方增量拉取通道**；
- `set_session_name`（rpc-mode.ts:632）：pi 侧正确落盘（sessionManager.appendSessionInfo，agent-session.ts:2718）并广播 `session_info_changed`。

**扩展在 pi 内的持久化与上报通道（extension-in-pi 的官方机制）**：

- `pi.appendEntry(customType, data)`（core/extensions/types.ts:1261）→ `sessionManager.appendCustomEntry` 把 `type:"custom"` entry **由 pi 自己持久化**进 session JSONL（agent-session.ts:2264-2271）。session-manager.ts:92-95 的注释明言这就是扩展状态重建的官方通道（"scan entries for their customType and reconstruct internal state"）；custom entry 持久化但不进 LLM context（session-manager.ts:377-385）；
- `entry_appended` 事件经 `session.subscribe((event) => output(event))` **全量转发**到 RPC 客户端（rpc-mode.ts:354-356）——扩展数据的实时失效信号已经存在，xyz 当前只是在 event-adapter 的 NULL_EVENTS 里忽略了它（event-adapter.ts:712-716，Set 字面量；r4 核正——前稿 :712-718 尾行偏 2）；
- `pi.sendMessage` 的 custom message（customType）走消息流到达 GUI（event-adapter.ts:517-527 已消费，如 subagent-bg-notify）——适合用户可见通知，不适合状态记录。

**问题在于 xyz 没有以这些快照与官方通道为中心组织数据流**，而是把快照拆成事件流、再在 runtime/renderer 各自拼回状态，每类数据自建「事件驱动缓存 + 专属回写路径 + 专属兜底拉取」。

### 关键术语（首次定义，全文通用）

- **权威源（source of truth）**：某数据唯一正确的最终存储。本文中 = pi 进程（session 文件 + agent 内存态）。subagent/workflow 是例外——pi 没有此概念，权威源是 xyz 扩展经 `appendEntry` 写入 pi 文件的自描述 custom entry（存储由 pi 执行，语义归 xyz 扩展）。
- **绝对写规则**：xyz 的任何代码（runtime / renderer / 脚本）永不写 pi **当前持有**的 session JSONL——对 pi 持有文件的修改只发生在 pi 内部（内置 RPC 或扩展 API）。规则的精确边界含两类**登记在案的合法形态**（非例外，裁定见 D3）：① **sidecar 家族**——`<sessionFile>.meta.json` / `.preset.json` / `.project.json` / `.handoff.json`（第 4 后缀由 W11 迁入，见 D3b）等 pi 体系外的 xyz 自有文件；② **文件创建型**——创建 pi 将来才持有的新 session 文件（创建时目标不存在、无并发写方、写后即移交 pi，fork 是唯一实例）。改写「pi 将来才附着、当前无进程持有」的既有文件（非活跃 rename 的 session_info 直写、restore 的 patchSessionCwd——两者同属该形态，与原则 1 的 legacy 清单对齐）不属前两类，登记为迁移期例外并带移除期限。这条规则的力量在于绝对性——一旦有例外，例外就会衰变（label 双写方就是前车之鉴）。
- **pi 内操作原则**：pi 没有而 xyz 需要的能力，默认解法是开发 pi 扩展在 pi 进程内实现（经 `appendEntry` 持久化、经 `entry_appended`/`get_entries` 上报），runtime 只经 RPC 存取。禁止 runtime 绕过 pi 直接读改 pi 的内部数据。
- **owner（数据所有者）**：xyz 侧某类数据唯一的写入者——一个模块、一个状态容器、一个写入口。所有来源（事件/RPC/文件）都汇入 owner 的单一入口，读方只读 owner。
- **投影宿主**：runtime 是唯一的投影发生地——所有派生（merge/normalize/计数对齐/状态推导）在 runtime（或 core 包的唯一实现）发生一次；**renderer 零派生**，stores 只是视图模型容器，经单一 `applySnapshot` 入口接收 view-ready 数据。
- **纯派生缓存**：只有一个写方（扫描/转换/计算本身）、可随时丢弃并从权威源完整重建的缓存。例：session 目录扫描缓存。
- **影子状态库**：有独立写路径（被多条事件/RPC 回写直写）、承载真值的缓存。它是 12 类问题的载体。例：runtime `sessionMetaCache`（生产写点仅 2 处 `setLabel`，`setThinkingLevel` 生产调用 0 处，`getLabel`/`getThinkingLevel` 无生产读者——接近只写死代码；计数为源码实测，曾误记 3-4 写方）。
- **快照拉取 + 事件失效**：标量状态的复制模式——数据只由 owner 从权威源拉取快照填充；事件到达只做一件事：标 dirty 并触发（防抖后的）重拉。事件永远不直接写数据。
- **单一 reducer 双路喂入**：append-only 日志数据（消息流）的复制模式——renderer 的消息列表是 entry 日志的纯函数，一个 `applyEntry` reducer 同时被实时事件流与文件重放喂入。「live ≡ reload」从构造上成立，而非两个独立实现靠纪律保持等价。
- **按字段分权威**：当权威源对某数据只覆盖部分字段（已核实：队列深度有快照、内容无任何 pi 通道），按字段拆分权威并显式登记，而不是虚构一个单一权威。

### 设计目标（从使用者体验倒推）

- **G1**（用户）：手动命名的 session 永不被 auto-rename 覆盖；断网重连后模型/用量与 pi **当前值**对账一致、队列深度与 `get_state.pendingMessageCount` 对账一致（队列**内容**基于 renderer 本地副本——pi 无队列内容通道，RPC 命令全集与 ExtensionAPI 均已核实，owner 分工与残余风险边界见 §3.3 D6）；重开 session 后对话分组、subagent 状态与重开前一致。
- **G2**（开发者）：动手改任何 GUI 数据前，能在一张登记表里查到该数据的 owner、权威源、唯一写入口与已知例外。
- **G3**（质量）：「实时视图 ≡ 重开视图」「广播状态 ≡ pi 快照」成为 CI 可执行的等价性测试，任何回归（代码偷偷直写状态）会让等价性破功并报警。
- **G4**（预防，双层）：语义层——pr-cr-fix 的 review agent 携带数据治理 checklist，任何 PR 引入第二写路径/绕过 owner/pi 文件直写时在 review 阶段被拦（现状唯一可用的护栏，因为 pre-commit 对该类问题零覆盖）；机器层——pre-commit / lint 落地后拦截模式级违规并指向登记表条目。

### Scope

- **In-scope**：§2 清单中 12 类数据的修复路径；runtime/renderer 的 owner 与投影结构重组；双层预防机制；分五阶段（P0-P4）的迁移计划。
- **Out-of-scope**：修改 pi 源码（项目铁律 [MANDATORY]，pi 没有的能力由 xyz 自实现——自实现的默认形态是 pi 扩展，见「pi 内操作原则」）；消息分组的渲染语义重构（turnId 分组归 `fix-chat-flow-order` 分支的设计，本文只覆盖其数据层前提——entry 级单一来源与单一 reducer）。

---

## §2 现状与问题分析

**结论：12 类数据的病根是同一件事——没有 owner 结构。每类数据有多条写路径（事件直写、RPC 回写、绕过 pi 直写文件、双管线重建），没有「谁是对的」的仲裁；缓存只是这些写路径的载体。**

### 2.1 使用者视角的真实失败模式

**失败模式 A（已证实，label 覆盖）**：用户新建 session 发第一条消息。首个成功 turn 结束后，`rename-session` 扩展（运行在 pi 进程内）用 LLM 生成标题（耗时 2-30s），生成后执行防覆盖守卫：

```ts
// extensions/rename-session/src/index.ts（callRenameLLM .then 分支）
if (pi.getSessionName()) { debugLog("skip: name exists"); return }  // 检查的是 pi 内存态
pi.setSessionName(title)
```

用户在这 2-30s 窗口内手动改名。xyz 的手动 rename 路径（`session-lifecycle.ts renameSession` → `persistSessionName`）**直接 append `session_info` entry 到 session JSONL + 改 runtime 内存，全程不通知 pi 进程**（runtime 的 rpc-client 从未接线 `set_session_name`）。于是 pi 内存里 sessionName 仍为空 → 守卫必过 → `setSessionName(title)` 在文件尾部追加新 entry → last-write-wins **覆盖用户手动名**，且经 `session.renamed` 广播把 UI 也翻回 LLM 标题。

**失败模式 B（已证实，断连/重开后状态漂移）**：现状的重连补偿机制已部分具备快照语义——`session.subscribe` RPC 返回 ring snapshot + state 类话题的 last-value `stateSnapshot`，stream 类溢出（fromSeq 早于 ring 最旧 seq）时 gap=true 触发全量重拉（session-message-handler.ts:314-326；话题三分类见 message-bus.ts TOPIC_TABLE:55 起）。按分类：用量/模型属 state 类（`context.update` / `session.state_changed`），重连由 stateSnapshot last-value 兜底；消息流与 `queue_update` 属 stream 类，受 ring 覆盖窗口限制（core/coordination/subscription-state.ts:293 的「永久丢失」注释讲的是另一件事——W09 删 broadcast 兜底后订阅不重建，`resubscribeAll` 已修——不是 ring 溢出自认）。真正的问题在于：**stateSnapshot 兜底的是 runtime 影子缓存而非 pi 权威**——它回放的是 runtime 内存里事件转发拼出的 last-value，缓存自身的多写方漂移（§2.2 #3/#4/#5）原样进入快照，重连只是把漂移状态再推一遍。这正是 ReplicatedState 直拉 pi 快照的动因（§3.0 原则 4）。重开 app 后 session 列表来自磁盘扫描，`scannedToSummary` 硬编码 `modelId: ''`、`tokenCount: 0`（`session-scanner.ts:81-82`），renderer `setGroups` 全量覆盖曾把真值抹成空串（`packages/core/src/domain/session/store.ts:70` 注释记录的踩坑史）。

**失败模式 C（已证实，双管线解析漂移）**：subagent 后台任务完成后，侧栏状态、主对话注入 turn、重开后的 extractor 解析可能不一致——实时路径（event-interpreter 内存 Map）与磁盘路径（subagent-extractor 重新解析 JSONL）是两条独立管线，各自演进；文件改动展示同样双管线（实时 git baseline diff vs 历史从 toolCall 参数静态解析，`message-converter.ts:44` 注释自认「两条路径实现不同、bash 无法覆盖」）。

### 2.2 12 类多源数据清单

| # | GUI 数据 | 权威源 | xyz 侧触点 | 已踩坑记录 |
|---|---------|--------|-----------|-----------|
| 1 | session 标签 | pi（session_info entry + 内存） | 6：xyz 直写文件 / pi 扩展 setSessionName / metaCache / 磁盘扫描 / renderer 局部更新 / 全量覆盖 | label 旧值覆盖（meta-cache 文件头注释） |
| 2 | session 列表（status/modelId/tokenCount） | pi session 文件 + agent 态 | 内存 Map + 磁盘扫描合并，磁盘侧空值 | modelId '' 覆盖真值（core/src/domain/session/store.ts:70） |
| 3 | 上下文用量 | `get_session_stats` | 5 写点：turn_end / agent_end / compaction 估算 / switchModel 重算 / restore 拉取 | inputTokens 竞态（session-service.ts:461、:837） |
| 4 | thinkingLevel | `get_state` | 事件 + 主动查询 + 双层缓存 + renderer 字段 | 恒 undefined（session-service.ts:450：pi 同档位切换不 emit 事件） |
| 5 | modelId | pi agent 态 | 缓存 + 广播 + 全局默认 + 磁盘空串 | 同 #2 |
| 6 | 消息队列（steer/followUp） | pi `_steering/_followUp` 队列 | pi 快照 + pendingBuffer（`packages/core/src/domain/chat/store.ts`，core 包，renderer 经 ADR-0059 薄壳消费——已核实），文本匹配对接 | 展开失配丢消息（decoupling 文档 P-fifo 风险项） |
| 7 | 消息列表/内容 | session 文件 entries | 事件流累积 + agent_end 权威覆盖 + 文件重放 | 分组错乱（fix-chat-flow-order 分支主题） |
| 8 | subagent 列表/状态 | xyz 扩展 record-store（pi 无概念） | 实时事件 Map + JSONL extractor 双管线；状态 6+ 命名出口 | normalizeSubagentStatus 注释（历史 bug） |
| 9 | workflow 记录 | xyz 扩展 RunStore | 5 环节：内存 → state 文件 → link entry → 信号广播 → extractor | 旧格式 run 静默丢失（orchestration/jsonl-run-store.ts D-5 version guard：snapshotVersion 不匹配 loadAll 跳过，不向后兼容） |
| 10 | 文件改动（FileChanges） | git 工作区 | 实时 baseline diff + 历史静态解析 | 两管线语义不同（message-converter.ts:44） |
| 11 | session 活跃态 | `get_state.isStreaming` | 5 状态源派生（chat 消息态/pendingSend/queue/retry/forceWorking） | — |
| 12 | slash 命令列表 | `get_commands` | 广播 + RPC 拉取 + stateSnapshot | broadcast/订阅时序（AGENTS.md 已修） |

覆盖范围说明：plugin sessionData（插件 per-session KV，含 `plugin:statusBarUpdate` 等 WS 推送）是用户可见 GUI 数据但**不在 12 类多源清单**——现状已是单写路径：权威 = runtime `SessionDataStore`（`packages/runtime/src/services/plugin-service/session-data-store.ts`，WriteBackCache + per-write debounce + 定时 flush + 磁盘恢复，消费者经唯一类入口操作），无第二写方、非多源病灶。登记表（§3.6 第 4 层）将其登记为「已 owner 化声明」条目，维持 G2「任何 GUI 数据可查 owner」的完整性。同形态后续追加：provider 扩展配置（quota/authMethod/modelStates，PR #187，登记表 P2——权威 = `<piAgentDir>/config/providers.json`，唯一写方 = runtime `XyzProviderStore`，pi 零引用该子目录）。

### 2.3 四种多源模式（根因的四种表现）

1. **双写方直写 pi JSONL**（现存实例：#1 label + handoff_marker）：xyz runtime 与 pi 进程互不知情地写同一文件，靠 last-write-wins。最危险——**label 链路现行有一个已证实的覆盖 bug**；`persistHandedOff`（`session-file-utils.ts:464` `openSync('a')` 直写 `handoff_marker`，活跃 session 交接时源 pi 进程在场，真实并发窗口）同属此类（r3 审查补漏）。另有两处触碰 pi JSONL 的写点不构成双写方，按边界形态登记处置（见 D3 裁定）：`patchSessionCwd`（:540，restore 时 pi 未起、无并发窗口的时序安全改写，登记带期限例外）与 `createForkedSessionFile`（`session-fork.ts:175`，创建 pi 将来才持有的新文件，登记「文件创建型」合法形态）。（session 终态 session_end 曾属此类：ADR-0042 原版 append JSONL，后经 ADR-0042 前案 W1（历史 effort 的 sidecar 修订，与子文档 wave 编号 W1 无关——本计划子文档 W1 = 活跃 label 直写切 RPC，见 r4 撞名消歧）改为 runtime 单写 sidecar `.meta.json`，已非双写方——见 §3.3 D3 的重新评估。）
2. **内存态 vs 磁盘扫描双管线**（#2/#7/#8/#10）：live 一套解析、reload 一套解析，语义漂移是常态。
3. **多事件 + 多缓存重组**（#3/#4/#5/#11）：把 pi 单一快照拆成事件流再拼回去，每条事件的丢失/乱序/不发射特例各需一个兜底，兜底之间再竞态。
4. **扩展借 pi 文件当数据库**（#8/#9 + label 的 session_info 直写）：pi 无概念的数据被编码成 pi entry 类型持久化，读取方要逆向理解扩展的编码约定。

### 2.4 根因分析

四种模式指向同一个根因：**xyz 缺少数据治理结构——没有「每类数据必须声明唯一 owner、权威源、唯一写入口」的约束，也没有任何自动化/流程化手段检测「第二写入路径」的出现**。于是每类新数据进来都自然长成多源（事件直写最顺手），每类把同样的时序坑各自踩一遍。这解释了为什么 #12（commands）修过一次时序坑后，同样的坑在 #1-#11 上重复出现——修复是逐点的，结构没有变。

### 2.5 现状物理数据流（以 label 为例，物理位置标注）

```
[renderer 进程]                         [runtime 进程]                      [pi 子进程]              [磁盘]
session store.updateLabel  ◄── session.renamed 广播 ◄── event-interpreter ◄── session_info_changed ◀──┤
        ▲                                                              ▲                              │ session.jsonl
        └── setGroups 全量覆盖（来自 RPC list） ◄── SessionScanner ◄── 内存 Map + scanSessions ◀────────┤
                                            （内存 Map label ◄── metaCache.setLabel ◄─ 2 个生产写方）  │
                                                                                                      │
手动 rename（活跃/非活跃两分支）: session-lifecycle.renameSession ──persistSessionName 直写───────────►│ ⚠ xyz 写方 1/2
turn_end/agent_end 兜底: session-service.tryPersistLabel ──persistSessionName 直写（初始 label）─────►│ ⚠ xyz 写方 3
handoff 交接: session-service.markHandedOff ──persistHandedOff 直写 handoff_marker（源 pi 在场）────►│ ⚠ xyz 写方 4
restore cwd 降级: session-lifecycle.restoreSession ──patchSessionCwd 整文件重写（pi 未起）─────────►│ ⚠ xyz 写方 5
fork 截断: session-fork.createForkedSessionFile ──writeFile 新建文件（pi 附着前不存在）────────────►│ ⚠ xyz 写方 6（创建型）
auto-rename: rename-session 扩展 ──pi.setSessionName──► sessionManager.appendSessionInfo ────────────►│ pi 内部写方
```

xyz 指向 pi JSONL 的写点全集共 6 处（r3 审查补漏 handoff / patchCwd / fork 三条，此前各版图均遗漏）：写方 1/2 = 手动 rename 活跃/非活跃两分支（`persistSessionName`，session-lifecycle.ts:296/:302）；写方 3 = `tryPersistLabel` 兜底（turn_end（`handleTurnUsageSideEffects`）/ agent_end（`handleTurnEndSideEffects`）时把未持久化的初始 label 经 `persistSessionName` 直写 JSONL，session-service.ts:1282-1286 → session-file-utils.ts:415-433 `openSync('a')`）；写方 4 = `persistHandedOff`（活跃 session 交接必经，handoff-service.ts:286 → session-service.ts:1074 markHandedOff（体内 :1080 调用 persistHandedOff——r4 锚核正：:1080 是调用行非方法签名行），源 pi 进程在场——真实并发窗口）；写方 5 = `patchSessionCwd`（session-file-utils.ts:518 整文件 atomicWrite 重写，restore 时 pi 未起、无并发窗口，登记带期限例外）；写方 6 = `createForkedSessionFile`（session-fork.ts:175，创建型——目标文件写前不存在、写后即移交 pi，登记合法形态）。写方 1-5 由 W1/W11 全部消灭或迁移，写方 6 登记后保留（裁定见 D3）。另有两类**非内容写**的文件触碰不在「写点」定义内（登记表注明防误问，r4 补）：session 删除链（`pm.destroySession` 先行 + `session-store.trash` → system/trash OS 垃圾桶移动 + sidecar unlink，无并发持有）与 pi-maintenance.ts（infra/pi/）一次性目录布局迁移 `renameSync`。读取方（pi sessionManager / xyz extractSessionName / renderer store）各自取「最后一条 session_info」，谁后写谁赢。

---

## §3 解决方案

### 3.0 终态架构原则（五条，全方案的判断准绳）

1. **绝对写规则**：xyz 代码永不写 pi **当前持有**的文件。pi 持有状态的所有修改发生在 pi 内部——内置 RPC（`set_session_name` 等）或扩展 API（`appendEntry` 等）。对「永不写」的精确边界（两类登记在案的合法形态，裁定与实例见 D3）：**sidecar 家族**（pi 体系外的 xyz 自有文件：`.meta.json` / `.preset.json` / `.project.json` / `.handoff.json`——第 4 后缀由 W11 迁入，家族全集见 D3b）与**文件创建型**（创建 pi 将来才持有的新 session 文件，fork 唯一实例）；迁移期 legacy 例外（非活跃 rename 直写、restore 的 patchSessionCwd）必须登记并带移除期限。无白名单——合法形态是规则边界的一部分，例外是带期限的债务。
2. **pi 内操作原则**：pi 能力缺口由 pi 扩展在 pi 进程内补齐（持久化经 `appendEntry`，上报经 `entry_appended` + `get_entries`），runtime 只经 RPC 存取。runtime 对 pi 数据只有两种动作：调 RPC 命令、订阅事件。
3. **投影只发生一次**：runtime 是唯一投影宿主。所有派生逻辑（merge / normalize / 计数对齐 / 状态推导）在 runtime（或 core 包唯一实现）发生一次；renderer 零派生，stores 是视图模型容器，唯一写入口是 `applySnapshot`。多 pane / 多窗口是 runtime 副本的下游扇出，绝不出现两个消费者各自从 pi 独立推导。
4. **两种复制模式按数据形态分流**：标量 session 状态走通用快照复制原语 `ReplicatedState<T>`（快照拉取 + 事件只做失效 + 周期/重连兜底重拉）；append-only 日志（消息流）走单一 `applyEntry` reducer 双路喂入（实时 feed 与文件重放共用一份派生代码）。不发明第三种模式；权威源能力缺失处（队列内容）降级该通道为对账信号 + 按字段重划权威，而非绕过权威源另起炉灶。
5. **治理即代码**：数据登记表的终态是可执行配置——驱动 `ReplicatedState` 实例、lint/pre-commit 许可表、契约测试参数，人读文档由它生成。护栏是双层：机器检查（模式级）+ pr-cr-fix review agent（语义级，长期存在，因为跨文件语义「第二写方」机器只能拦直呼形态）。

### 3.1 终态（使用者视角）

**终态样例 1（用户改名，成功路径）**：用户右键活跃 session 改名"重构计划"→ renderer 乐观显示新名 → runtime 调 pi RPC `set_session_name` → pi 落盘并广播 `session_info_changed` → renderer 确认显示。此后 auto-rename 的守卫 `pi.getSessionName()` 读到非空 → skip（守卫日志 "skip: name exists"）。用户再发 10 条消息，名字保持"重构计划"。对**非活跃** session（无 pi 进程）改名：runtime 短命拉起一个 pi 进程附着该 session 文件 → 同样走 `set_session_name` → 关闭进程。全程 xyz 代码零次打开 JSONL 写。

**终态样例 2（断连自愈）**：对话中 WiFi 断开 30s 重连（期间 pi 完成一轮回复、队列里一条 followUp 被消费）。renderer 收到重连信号 → 对活跃 session 重拉快照（`get_state` + `get_session_stats`）→ 模型/思考档位/用量/队列深度与 pi **当前值**一致（断连期间被消费的 followUp 正确消失）——不依赖任何「断连期间事件是否补发成功」。（队列项文本显示来自 renderer 本地副本——断连 ≠ renderer 重启，副本存活；深度由 `pendingMessageCount` 对账。**内容对账的残余风险边界**：queue_update 属 stream 类事件——入 ring、可丢失、重连不重发，事件丢失且队列静默期间条目列表可能有界陈旧（深度始终正确），偏差由下一次队列活动的 queue_update 全量数组对账收敛。）

**终态样例 3（开发者新增数据被拦，双层护栏）**：开发者在 feature 分支给 session store 加了第二个写方法调用点（绕过 owner）。第一层：PR 阶段 pr-cr-fix 的 review-data-governance agent 按 checklist 检出「事件直写 store，绕过登记表条目 #5 的唯一写入口」，报 MUST_FIX；第二层（机器检查落地后）：`git commit` 时 pre-commit/taste-lint 报错并指向登记表条目。开发者查登记表，改为经 owner 写入。

**终态样例 4（扩展数据单源）**：后台 subagent 完成 → 扩展在 pi 内 `appendEntry('subagent-record', {...完整自描述记录})` → pi 持久化并广播 `entry_appended` → runtime 收到失效信号，经 `get_entries(since=cursor)` 增量重拉 → 更新纯派生缓存 → 向 renderer 广播 view-ready 快照。重开 session 后走同一份 entry 扫描代码重建——实时与重放是同一条管线。

**失败路径与恢复指引**：

- **快照拉取失败**（pi 忙 / RPC 超时）：owner 保留 dirty 标记不清除，按 1s/5s/15s 退避重试；WS 重连时 `resubscribeAll` 附带全量重拉。UI 显示上一次快照值（可能短暂陈旧但不会错乱）。恢复动作：无需人工干预；若 pi 进程死亡，session 标 dead 态走既有 revive 流程。
- **get_entries 游标失效**（since 指向的 entry 不存在，如文件被外部截断）：RPC 返回错误（rpc-mode.ts:615），owner 退化为全量重拉自愈——游标只是优化，不是正确性依赖。
- **扩展上报失败**（自描述 entry 未到达）：owner 回退读磁盘 entry（既有 extractor 路径降级为兜底），UI 正常但标注数据可能滞后。恢复动作：`session.getSubagents` RPC 手动刷新即自愈。
- **rename RPC 失败**（pi 进程死）：活跃 session rename 失败则 toast 报错保留旧名，用户重试；非活跃 rename 的短命 pi 拉起失败同样报错重试。恢复动作：session revive 后重试 rename。

### 3.2 方案对比

| | 方案 A：全删缓存，全量直读 | 方案 B：绝对写规则 + 投影一次 + 两种复制模式（**推荐 ✅**） | 方案 C：保留多写路径 + 版本号同步协议 |
|---|---|---|---|
| 长期架构 | 差：无本地状态层，事件增量推送失去意义；每次 UI 刷新全量拉取/全量扫描磁盘 | 好：写路径一条（pi 内部）；派生一份（runtime 投影宿主）；事件丢失免疫（重拉自愈）；断连/重连/重开三场景天然一致；「事件只做失效」可被等价性测试证伪；一致性是结构性质而非时序纪律 | 差：多写方依旧存在，只是加了仲裁；版本协议本身成为新 bug 源（分布式里都没便宜解，单体内更不值） |
| 短期成本 | 高：全链路重写 + 性能回退（session 列表每次全量读 JSONL、用量每次 RPC） | 中高：runtime 重组（ReplicatedState 原语）+ renderer 写入口收敛 + 扩展自描述上报；分五阶段可控，P0 一天可交付止血 | 中：每条写路径加版本逻辑 |
| 风险 | UI 闪烁、IO 放大 | 拉取防抖窗口内 UI 滞后百毫秒级；pi RPC 频率上升（快照很小，预期影响可忽略，实施期 P0 量化证实）；非活跃 rename 增加 pi 冷启动延迟（✅ 已量化：中位数 ~500ms，可接受，见 D2 探针） | 时序/时钟问题解决成本高于收益 |

**被否方案的反例推演**：若选 A，§3.1 样例 1 的 rename 在 pi 进程死后无法落盘（无本地状态可写），样例 2 的断连自愈变成「断连期间所有显示冻结」；若选 C，失败模式 A 的两个写方各带版本号，但版本只在「双方都读到对方版本」时有效——rename-session 扩展读不到 xyz 的写（这正是现状 bug 的本质），版本协议无法修复它，等于没修。

**推荐 B 的核心理由**：它把「一致性」从运行时时序约定（注释里的「缓存写入先于读取」）变成三个结构性事实——写只有一条路（pi 内部）、派生只有一份码（runtime 投影宿主）、对账通道永远存在（快照重拉 / get_entries 全量）。结构性质可以用等价性测试持续断言，也可以被 review checklist 逐项核对——这是 G3/G4 的前提。

### 3.3 关键决策与权衡

**D1 缓存处置判据（回应「缓存是否先全删」）**：判据一句话——**缓存里是否存在权威源之外的第二个写入者？有 → 收编或删除（影子状态库）；没有 → 保留（纯派生缓存）**。

| 缓存 | 判定 | 处置 |
|---|---|---|
| session 目录扫描缓存 / git-info 缓存 / quota 缓存 / history-rebuild-cache / turn-render-cache | 纯派生（写方=扫描/转换本身） | 保留不动 |
| runtime `sessionMetaCache`（= `packages/runtime/src/services/session/session-meta-cache.ts`，sessionId 键；`infra/pi/session-file-utils.ts` 内同名 filePath 键文件头纯派生缓存属「保留」类不动——已核实） | 影子状态（结构上多写方注入；实际生产写点仅 2 处 `setLabel`——`packages/runtime/src/index.ts:298` / `session-lifecycle.ts:289`，`setThinkingLevel` 生产调用 0 处，`getLabel`/`getThinkingLevel` 无生产读者——接近只写死代码，计数为源码实测） | 纯删除（无生产读者，无收编负担；W9） |
| runtime `session.inputTokens/tokenCount` | 影子状态（5 写点） | 收编；switchModel 重算改在 owner 内部读自己的缓存，竞态从「注释约定」变「结构不可能」 |
| event-interpreter `subagentRecords` Map | 影子状态（双管线之一） | 收编：扩展自描述 entry（经 get_entries 拉取）为唯一源，Map 变纯派生缓存 |
| renderer summary 字段（updateLabel/updateSessionState/setGroups 三路写） | 影子状态 | 收编为单一 `applySnapshot` 入口（合并规则见 D1b） |
| `pendingBuffer`（`packages/core/src/domain/chat/store.ts`，core 包，renderer 经 ADR-0059 薄壳消费——已核实） | 职责错位（承担投递定位） | 保留但改**计数 FIFO**：queue_update 差集已算出被投递条数，按条数顺序取 segments，删除文本相等匹配。queue 的 owner 分工见 D6 |

被否：全删（同方案 A）。「先干掉再重建」的过渡态成本极高且不解决独立写路径问题。

**D1b 快照合并规则（两条规则不可混用 + wire 层归一细则）**：

- **owner 快照合并 = 权威源整字段覆盖，含显式空值**。真实反例（源码核实）：pi `get_state.sessionName` 的合法值为 `string | undefined`——未命名 session 就是 undefined（agent-session.ts:891-892 getter 签名；session-manager.ts:1067-1075 注释明言「Empty names explicitly clear the session title」，空名是显式语义而非占位）——若一刀切「空值不覆盖非空值」，未命名 session 的初始快照为 undefined，owner 将永远保留旧名，影子状态复活，恰是本方案要消灭的东西（注：r2 审查修正反例叙事——「用户清空名字」无法经 RPC 到达 pi，`set_session_name` 显式拒绝空名（rpc-mode.ts:633-637「Session name cannot be empty」）；sessionName 为 undefined 的真实来源是未命名初始态与文件级空 session_info，规则本身不受影响）。（前稿曾以 `thinkingLevel` 为反例，源码核实**不成立**：pi `ThinkingLevel` 是具体字符串联合类型、不含 undefined（`"off"` 或可用档位，不支持思考的模型被 `setThinkingLevel` 钳到具体值）；xyz 侧缓存曾恒 undefined 是缓存自身的踩坑症状，不是 pi 权威值域——恰是「把影子状态当权威」的混淆。）
- **wire 层空值归一**：`get_state` 经 JSON 序列化时值为 undefined 的字段 key 被丢弃——「整字段覆盖含显式空值」在 wire 层实际是「key 缺失」。快照解析必须按字段 schema 归一：缺失 key 按该字段登记的空值语义处理（sessionName 缺失 = 未命名 = 覆盖；thinkingLevel 无空值语义，key 缺失按协议异常处理），禁止把「key 缺失」当「字段不动」。
- **空值守卫仅用于磁盘扫描占位值路径**：`scannedToSummary` 硬编码的 `modelId:''`/`tokenCount:0` 是「无数据」占位符而非权威空值，P2.3 守卫语义是「占位符不覆盖已知真值」。
- 落实到登记表：按字段登记空值语义——sessionName 空 = 合法态（未命名，必须整字段覆盖）；label 与 sessionName 是同一数据链（label 实例 fetch 即 `get_state().sessionName`），空值语义唯一化、**不单独登记**「label 空 = 可守卫」（曾双登记出相反语义，r2 审查并轨修正——「可守卫」语义仅属磁盘扫描占位值语境，已被上一条规则覆盖）；thinkingLevel 无空值语义（永不 guard）。字段空值语义是 `ReplicatedState` 配置的一部分。

**D2 label 写路径——绝对写规则的落地**：

- **活跃 session**：手动 rename → runtime rpc-client 接线 pi `set_session_name` RPC（✅ 已验证存在于 rpc-mode.ts:632，内部 `sessionManager.appendSessionInfo` 落盘 + emit `session_info_changed`，agent-session.ts:2718）；同时删除 `tryPersistLabel` 的 turn_end/agent_end 兜底直写（r2 审查补漏：session-service.ts:1282-1286 经 `persistSessionName` 直写初始 label，与手动 rename 直写同源同性质，P0 同 wave 处置）——label 持久化责任整体移交 pi：显式初始 label 在 create/fork 时经 RPC 写入（pre-flush 期 pi 只做内存缓冲、随首次 `openSync("wx")` flush 落盘——✅ 已核实 session-manager `_persist`，文件只会由 pi 创建，无 EEXIST 风险），未命名 session 的派生初始 label（basename(cwd)）退役为显示派生（显示由内存态与扫描 fallback 承担，重启后显示值不变）。此后 pi 成为活跃 session 该文件 **label 链路**的唯一写方（活跃写点全集中的 `persistHandedOff` 是另一条链路——源 pi 在场时直写 `handoff_marker`，W11 迁 sidecar，裁定见 D3）。
- **非活跃 session**（无 pi 进程）：终态机制 = runtime 短命拉起 pi 进程附着该 session 文件 → `set_session_name` RPC → 关闭。复用既有 spawn/revive 机制，无新子系统。✅ 探针已核实（P0.5，`pi --mode rpc` 真实子进程 spawn，≥5 次采样）：冷启动中位数 ~500ms——场景 A 无 session 附着 481ms（范围 429-558ms）、场景 B 附着 session 534ms（范围 429-586ms）；瓶颈全在 Node 进程冷启动，`set_session_name` RPC 本身 <1ms。端到端（spawn → RPC 就绪 → rename 完成）~500ms，右键改名弹出输入框前最多等 ~600ms，属「即时」体感——**定形态为逐次冷起**，warm 常驻 utility pi 不引入（~80-120MB RSS 常驻成本，仅未来出现批量改名需求再评估）。
- **迁移期 legacy 例外集合**（r3 审查补全为三条）：P0 消灭活跃 session **label 链路**的全部直写（手动 rename + `tryPersistLabel` 兜底，并发危险所在）；以下三条若未能同阶段消灭/迁移，必须在登记表登记为「legacy 例外 + P1（W11）移除期限」，并在 pre-commit R1 的 allowlist 里单独列出——① 非活跃 rename 直写（`persistSessionName` 非活跃分支）；② `persistHandedOff` 直写（活跃交接，W11 迁 sidecar）；③ `patchSessionCwd`（restore 时序安全改写，W11 迁 tmp 读改写管线）。例外是带期限的债务，不是制度；fork 文件创建型与 sidecar 家族不是例外，是规则边界内的登记形态（D3 裁定）。
- 探针：✅ pi RPC 命令存在性与行为（read 源码核实）；⛔ rename-session 守卫日志 "skip: name exists" 在真实链路出现（实施期 P0 用 `pi --mode rpc` 实测，复用 AGENTS.md 的扩展实测流程）。

**D3 session 终态（session_end）存储——维持 sidecar，且在绝对写规则下合法（D3b 补写边界形态裁定）**：现状核实（对抗审查纠错）：ADR-0042 原版决策是 append JSONL，但其后 **ADR-0042 前案 W1 修订已改为 runtime 单写 sidecar `.meta.json`**（前案 W1 = 该历史 effort 的 W1，非子文档 wave 编号）（`persistSessionEnd`，session-file-utils.ts:111-157，注释明言「不污染 JSONL」+ 规则 #6 规避 pi `openSync("wx")` 竞态）。sidecar 是 **xyz 自有文件**，不是 pi 的文件——runtime 单写 sidecar **不违反绝对写规则**（规则管的是 pi 的 JSONL）。裁决：

- **选项 a（维持 sidecar，默认推荐 ✅）**：sidecar 已是单写方、无并发冲突、无 pi 兼容性风险；前案 W1 的两个原始动机依然成立。工作收窄为：sidecar 读写收口到登记表声明的单一 util（现状已是），登记表登记「sidecar 是 pi 体系外 xyz 自有数据的合法形态」。
- **选项 b（改扩展 appendEntry 进 pi 文件）**：技术上已可行（appendEntry 通道已核实，见 D4），动机是「session 导出/迁移时终态随文件走」。若未来因真实需求选 b，必须先补三件迁移设计：① 存量 sidecar 兼容读取（优先级 custom entry > sidecar > 旧直填）；② sidecar 退役时间表；③ 显式修订 ADR-0042 + 前案 W1 并落档。
- 探针：✅ sidecar 实现已 read 核实（原子写 tmpfile+rename + 写后失效 meta 缓存）；⛔ 选项 b 的实际收益场景当前不存在，不做投机改造。

**D3b 写边界形态裁定（r3 审查补漏三条写链路的处置，源码逐一核实）**：

- **sidecar 家族全集（终态四后缀，r4 补第 4 成员）**：`.meta.json`（`persistSessionEnd`，session-file-utils.ts:137/:146）之外，sessions 目录内还有同类 xyz 自有 sidecar——`.preset.json`（`persistPresetBinding`，:281）与 `.project.json`（`persistProjectBinding`，:223），读写全部收口在 session-file-utils 单一 util、写前 `existsSync` 守卫（规则 #6）、写后失效 meta 缓存，与 session_end 完全同构；第 4 后缀 `.handoff.json` 由 W11 把 `persistHandedOff` 迁入家族（同构形态：单一 util 收口 + 规则 #6 守卫 + 写后失效缓存，裁定见下条、迁移规格见子文档 W11 步骤 4）。登记表（W19）按「sidecar 家族」整体登记，R1 对 sidecar 后缀内置豁免——豁免清单 = 四后缀（`.meta.json` / `.preset.json` / `.project.json` / `.handoff.json`），与登记条目一一对应（W11 步骤 7 负责迁入后的同步核对）。
- **handoff_marker → 迁 sidecar（W11）**：`persistHandedOff`（:464 `openSync('a')` 直写 `handoff_marker`）在活跃 session 交接时执行——源 pi 进程在场（markHandedOff docstring 自述「handoff 编排保证源 session 在交接时仍 active」；runHandoff 在 agent_end 之后、源进程退出之前调 markHandedOff），是真实并发窗口，属模式 1 双写方。裁决**迁 sidecar（与 persistSessionEnd 同构）而非 appendEntry（D4 通道）**，理由：① `appendEntry` 是扩展 API 不是 RPC 命令（rpc-mode 命令面固定，§1 已核实），runtime 无法直接经 RPC 写 custom entry，走 D4 须为一条 marker 新增「xyz 扩展写通道 + runtime 触发机制」，成本与收益不成比例；② `handedOffTo` 是 xyz 自有语义（pi 无 handoff 概念），现状把它编码成 pi entry 恰是模式 4「借 pi 文件当数据库」的实例；③ 消费方唯一（scanner 尾读 `extractHandedOff` + 内存态），与 session_end（outcome）数据形态完全同构。迁移 = `persistHandedOff` 改写 sidecar（`<sessionFile>.handoff.json`，家族第 4 后缀，见上条全集）+ `extractHandedOff` 优先读 sidecar、fallback 尾读旧 JSONL marker（存量 session 兼容）。
- **patchSessionCwd → 登记带期限例外，W11 迁 restore tmp 读改写管线**：唯一生产调用链 restoreSession（session-lifecycle.ts:405）在 `pm.createSession`（spawn pi）**之前**执行 patch——docstring PRECONDITION（「必须在 pi session 启动之前调用」）由调用链结构保证，目标文件无 pi 进程持有、无并发写方（实现内含 mtime<1s 的并发写防御性警告）。「改经 pi」不可行：pi 无「修改 session header cwd」的 RPC 命令；「先起 pi 再 patch」恰是 docstring 自认的写写竞态（pi `_persist` flush 与 atomicWrite 并发），顺序反转更危险。移除路径 = cwd fallback 并入 restoreSession 既有的 tmp 读改写管线：该流程本就「读源文件 → `stripSessionEndEntries` → 写 tmpdir → pi `switchSession(tmp)`」，header.cwd 的 fallback 改在 tmp 拷贝上应用即可，源文件零写（源文件 header 保持旧 cwd——restore fallback 路径功能等价；header cwd 的扫描侧消费差异〔scanner label fallback / deleteByCwd 按死路径值工作〕为已声明并接受的行为差异，边界与理由见子文档 W11 步骤 5，r4 补）。
- **createForkedSessionFile → 登记「文件创建型」合法形态（零代码改动）**：fork 流程（session-lifecycle.ts forkSession）先 `createForkedSessionFile` 写**新文件**（新 sessionId + 新文件名，写前不存在、无任何进程持有）→ 再 spawn 新 pi 进程 → `switchSession` 附着——写入发生在 pi 附着之前，不属「写 pi 当前持有的文件」。「pi 侧 fork」被否：pi 原生 fork RPC 有语义限制（只支持 user message + position="before"、clone 只能 leaf、当前进程内 rebind 会破坏源 session 活跃状态——session-fork.ts 文件头核实），xyz 的 fork 语义（任意 entryId 截断 + 独立 pi 进程 + 源进程不动）pi 原生能力覆盖不了，走 pi 侧 = 功能阉割。失败分支 `unlink(forkedFilePath)` 清理的是本流程刚创建、pi 未附着成功的孤儿文件（创建者清理，非删 pi 的文件）。边界约束：创建型仅限「目标写前不存在的新文件」，登记表显式登记「fork 文件唯一创建入口 = `createForkedSessionFile`」，禁止演进为「重写既有 session 文件」。
- **R1 检出边界诚实声明（匹配粒度与覆盖差，r4 补定义、r5 补命中/豁免机制）**：R1 的匹配粒度 = **文件级邻近（条件 A）+ 写目标豁免（条件 B）两必要条件**（完整定义见 §3.6 R1）——「文件内含路径推导（含形参间接形态）且写目标无豁免则承诺拦 / 跨文件传入路径诚实声明不拦」两条边界均经源码核实：session-file-utils 的三条 legacy 写点目标路径同为形参（filePath，函数体内无路径字面量），但所在文件含 `getSessionsDir` import（:12）与调用（:735，均代码语境）且写目标无可见豁免通道，文件级粒度**命中**（allowlist 因此有意义；同文件三 sidecar 写点经四后缀写目标豁免）；session-fork.ts:175 的目标路径同样经形参间接（调用点传 `getSessionsDir()`），但 session-fork.ts 整个文件无任何 sessions 路径推导**代码痕迹**（唯一 `sessions` token 在 :63 JSDoc 注释——按条件 A 的代码语境限定，注释不计入），文件级粒度下 R1 仍**不命中**——跨文件数据流静态不可判定。fork 的守卫 = 登记表「创建型唯一写入口」声明 + S1 语义层（机器拦模式、语义归 review，与 §3.6 现状诚实声明同源）。

**D4 subagent/workflow 单一来源——extension-in-pi 官方通道**：pi 无 subagent/workflow 概念，但提供了扩展持久化的官方机制（§1「系统是什么」已核实）：`appendEntry` 由 pi 持久化 custom entry + `entry_appended` 全量转发 + `get_entries(since)` 增量拉取。终态：

- 扩展侧 record-store/RunStore 保持内存权威；**状态变更时扩展 `appendEntry` 一条自描述完整记录**（字段即 SubagentRecord/WorkflowRunRecord，不依赖读取方逆向解析 toolCall/toolResult 编码）——pi 文件成为扩展数据的持久化权威，写方是 pi（符合绝对写规则），语义归扩展；
- runtime 消费：`entry_appended` 作失效信号 → `get_entries(since=cursor)` 增量重拉 → 内存 Map 重建为**纯派生缓存**（唯一写方 = entry 扫描）；实时与重开走同一份扫描代码，模式 2 双管线结构性消亡；
- `subagent-extractor`/`workflow-extractor` 降级为「冷启动旧 session（无自描述 entry）兜底」并标注 legacy；扩展的 state 文件退役或降级为纯性能缓存（可从 entry 完整重建时才允许存在）；
- workflow 现有 link entry 形态向自描述记录收敛（统一 #8/#9 为同一形态）——现状已核实：`workflow-state-link` 指针 appendEntry 已存在（`extensions/subagent-workflow/src/orchestration/jsonl-run-store.ts:455`），record-store 已有 appendEntry 注入通道（`extensions/subagent-workflow/src/execution/record-store.ts:175/223`，现为 manifest-invalid 上报用），P3.1 是形态收敛（指针 → 自描述全量）而非从零接线（子文档附录 A #7/#8）。
- 探针：⛔ 自描述 entry 的大小与 append 频率（长 workflow 的 trace 全量快照可能膨胀——实施期 P3 量化，必要时 trace 增量 append + 状态全量 append 两种 customType 分流）；✅ appendEntry 持久化 / entry_appended 转发 / get_entries since 语义均已 read 源码核实（agent-session.ts:2264-2271、rpc-mode.ts:354-356、:609-619；session-manager.ts:92-95 官方状态重建通道）。

**D5 消息流——单一 reducer 双路喂入**：消息是 append-only 日志，不适合快照重拉（streaming 太重）。终态：

- renderer 消息列表是 entry 日志的纯函数：core 包内单一 `applyEntry(state, entry)` reducer，**实时 feed 与文件重放喂同一个 reducer**——「live ≡ reload」从构造上成立（等价性测试仍保留为哨兵，但断言的是不变量而非两个独立实现的等价）；
- 实时 feed 的数据载体向 pi 的 entry 级通道收敛：`entry_appended` 携带完整 entry 对象（agent-session.ts:140）——扩展 entry 直接走该通道；message entry 无此事件（探针已核实，见下方），由 `message_end` 等事件重构 entry；streaming 中的 partial content（message_update 流）是临时 UI overlay，entry 提交时丢弃，不进权威状态；
- 分组语义（turnId 分组）归 fix-chat-flow-order 分支，本决策只提供其数据层前提：entry 序号稳定、来源单一。
- 探针：✅ 已核实**不发射**——pi 源码唯一发射点是 agent-session.ts:2269（仅扩展 `ctx.appendEntry()` / appendCustomEntry 路径），消息持久化路径 `appendMessage` → `_appendEntry` → `_persist` 全链路无事件（session-manager.ts:963-967）；实测证实：`pi --mode rpc` 真实跑一轮对话，25 个事件中 `entry_appended` 0 条，`message_start` / `message_end` 各 2 条正常发射。因此 D5 实时 feed 形态定为：message 部分由 `message_end` 等事件重构 entry 喂 reducer，reducer 输入的同构性由等价性测试断言；若 pi 上游未来补发射则无缝切换（只换喂入源头，reducer 不动）。

**D6 队列——按字段分权威（已核实为终态，非妥协）**：pi 侧能力面已穷尽核实：RPC 命令全集（rpc-mode.ts:385-653）无队列内容快照，`get_state` 仅 `pendingMessageCount`；完整队列数组只在 `queue_update` 事件（agent-session.ts:503-508）；ExtensionAPI 无队列内容读口（types.ts 仅 `hasPendingMessages()` 布尔），扩展也拿不到内容。因此：

- **深度**权威 = pi：走 `get_state.pendingMessageCount` 快照对账；
- **内容**权威 = renderer 提交日志（它提交过所以它有）：queue_update 差集算被投递条数 → 计数 FIFO 取 segments（删文本匹配）；queue_update 是对账信号而非数据载体；
- **已知例外：扩展注入（对抗审查补漏）**——pi ExtensionAPI 的 `sendUserMessage(content, { deliverAs: "steer" | "followUp" })` 允许扩展直接向 pi 队列注入（core/extensions/types.ts:1482 SendUserMessageHandler），注入条目不在 renderer 提交日志中，会破坏计数差集（提交数 − pi 队列深度 = 已投递数）。规则：**queue 内容唯一提交方 = renderer（经 WS steer/followUp）**，xyz 自研扩展禁止使用 deliverAs 注入队列（S1 checklist 拦截），登记表登记为已知例外条目；第三方扩展注入的残余风险 = 计数 FIFO 有界偏差，深度仍由 `pendingMessageCount` 结构性对账。另核实 pi 入队存**展开后文本**（steer/followUp 入队前先 `_expandSkillCommand` + `expandPromptTemplate`，agent-session.ts:1243-1265）——展开后文本与提交原文对不上，印证删除文本匹配、改计数 FIFO 的必要性；
- 登记表按字段登记该分工，防止后来人误以为「缺一个队列快照接口」而发明新写路径。

**D7 投影一次——renderer 零派生**：runtime 是唯一投影宿主（长寿命进程：后台 subagent/workflow 在窗口关闭后继续存活，副本必须活在这里；session 目录扫描横跨无 pi 进程的历史文件；多 pane 扇出需要去重）。落地形态：

- 所有派生逻辑（merge / normalizeSubagentStatus 类状态归一 / 计数 FIFO / 空值守卫）从 renderer 上移到 runtime 或 core 包唯一实现；renderer stores 退化为视图模型容器，唯一写入口 `applySnapshot`，WS 消息必须是 view-ready DTO；
- `ReplicatedState<T>` 通用原语承载六类标量 session 状态（label/thinkingLevel/modelId/usage/queue 深度/commands）：配置三元组 = `(快照 RPC, 失效触发源, 合并策略含字段空值语义)`。六类同构，不允许各写各的缓存——**新数据 = 新配置条目，不存在「顺手加个缓存」的物理路径**。登记表因此从 markdown 演进为可执行配置（人读文档由配置生成/双向校验）。
  **[2026-08-20 修订消歧]** 本段「六类」是 P1 规划口径；登记表后续修订（PR #185/#186）已撤销 label 与 queue 深度两处 ReplicatedState 实例（`.get()` 生产零消费、属无效 RPC，改事件直达/帧直达形态）。**现行实例口径以 [data-source-registry.md](./data-source-registry.md)「读法消歧」及其「目标」段为准**，勿按本段理解现状；
- modelId 无 pi 事件可依赖（精确核实：pi 有 `model_select` 扩展事件，agent-session.ts:1458-1470 `_emitModelSelect`，但只经 `_extensionRunner.emit` 发给扩展、不经 `session.subscribe` 转发——rpc-mode.ts:354 的订阅转发通道无任何 model 事件，RPC 客户端不可见，即「RPC 层无 model 事件」），其失效源 = switchModel RPC 响应后主动拉快照（RPC 响应驱动）——这是「事件只做失效」的补充合法形态，登记在配置里。
- **现有 subscribe / ring / stateSnapshot 快照通道的去留（对抗审查补漏）**：**复用为推送通道，不退役重写**。这套机制（`session.subscribe` RPC + ring snapshot + state 类 last-value stateSnapshot + gap→全量重拉，session-message-handler.ts:314-326）是 WS 传输层的重连补偿基础设施，与数据源治理正交。改造点只有一个：**5 个 state 类话题（`session.commands` / `context.update` / `session.subagents` / `session.workflowUpdate` / `session.state_changed`，message-bus.ts TOPIC_TABLE:55 起 / STATE_TYPE_KEY_MAP:131）的数据源从「事件直写 runtime 缓存再转发」切换为「runtime 侧 ReplicatedState 实例发布」**——stateSnapshot 回放的 last-value 从影子缓存快照变为 owner 快照，「投影一次」原则不被现有通道架空；stream 类话题（消息流 message.*、`queue_update` 等）维持 ring 语义不动。迁移顺序见 P1.5。
- 被否的更激进选项「runtime 彻底无状态化变纯 WS↔RPC 桥」：不成立——runtime 寿命长于 renderer，必须持有副本；但它的副本从手写缓存变成通用原语的实例。

**D8 预防双层护栏（详见 §3.6）**：语义层（pr-cr-fix review-data-governance agent，本文档配套交付，长期存在）+ 机器层（R1/R2/R3 pre-commit/lint + 等价性测试族 + 登记表即代码 + ADR）。被否：仅靠 ADR 文字约束与 review 人眼——#12 修复后同类坑在别处复发已证明人眼不可靠；也否「等机器检查落地再说」——机器检查对跨文件语义只能拦直呼形态，语义层必须独立存在且先生效。

### 3.4 目标物理数据流（以 label 为例）

```
[renderer 进程]                    [runtime 进程]                              [pi 子进程]              [磁盘]
session store.applySnapshot  ◄── 快照 diff 广播  ◄── ReplicatedState<label> 实例 ◄── RPC get_state
（唯一写入口，零派生）                      ▲  │（owner：配置驱动的原语实例）           │                    │
                                           │  └── session_info_changed 事件 = 仅标 dirty 触发防抖重拉      │
                                           └── 断连重连 / 定时兜底 → 全量快照重拉                         ▼
活跃 rename:    rename 请求 ──────────────► rpc-client.set_session_name ──► sessionManager.appendSessionInfo（唯一写方）[session.jsonl]
非活跃 rename:  rename 请求 ──────────────► 短命 pi 进程附着该文件 → 同上 RPC → 关闭（xyz 零次打开 JSONL 写）
auto-rename:    rename-session 扩展在 pi 内 ──► pi.setSessionName（守卫读到全部写，因为所有写都经 pi）
```

与 §2.5 对比：pi JSONL 本体的写方从 7 条路径（xyz 侧 6 处写点——活跃 rename / 非活跃 rename / `tryPersistLabel` 兜底 / `persistHandedOff` / `patchSessionCwd` / fork 创建——加 pi 侧 1 条，互不知情）变为**恒 1 个**（pi 自己，含扩展经 pi API）；xyz 侧仅保留两类登记在案的边界形态（sidecar 家族写自有文件、fork 创建新文件后即移交 pi，D3/D3b），写入口从「runtime 直写 + metaCache 2 个生产写方 + renderer 3 路写」变为「ReplicatedState 实例 + applySnapshot」两处单入口。

### 3.5 分阶段迁移（概览，详见 §5）

P0 止血 + 护栏先行（活跃 rename 接 RPC 修覆盖 bug + 登记表 + review agent 与 R1/R3 机器检查同期上线）→ P1 runtime owner 收敛（ReplicatedState 原语落地六类（后修订为四类，见 §3.3 D7 消歧标注，现行口径以 [data-source-registry.md](./data-source-registry.md) 为准） + 非活跃 rename 切换短命 pi，绝对写规则全线生效）→ P2 renderer 零派生收敛 → P3 扩展数据单源（自描述 entry）+ 消息流 reducer → P4 等价性测试全量化 + ADR 落档。**护栏在 P0 与止血同期上线**——先立守护再动大刀，重构过程本身被守护。

### 3.6 预防机制双层（对应 G4，本方案的核心增量）

**现状诚实声明**：项目现有 pre-commit（`.bare/hooks/pre-commit` + `.githooks/`）覆盖 lint/类型/边界/打包/i18n 等，但**对「数据多源」这一类零覆盖**；且 R2 类跨文件调用图检查即便落地，对变量拼接路径、间接写、语义级第二写方静态不可判定。因此语义层护栏（review agent）不是机器检查的过渡替代品，而是**长期并存的一层**；机器层拦截模式级违规，把 review agent 的注意力留给语义级违规。下文五层中：第 1 层 = 语义层；第 2-5 层 = 机器/流程层。

**第 1 层 语义审查（PR 阶段，立即生效，长期存在）**

- **S1 review-data-governance agent**：`.agents/skills/pr-cr-fix/agents/review-data-governance.md`（本文档配套交付，已随本文档同提交 c8def4a0c 接入 pr-cr-fix review 维度表，8 维已生效——P0 无需再接入）。checklist 核心：pi 文件直写（含变量拼接路径追形参）/ 第二写入者 / 事件直写状态 / renderer 派生逻辑 / 未登记缓存 / 扩展通道合规 / 登记表同步。登记表落地前以本文档 §2.2 清单为准绳，落地后以登记表为准绳。
- **S2 检出即 MUST_FIX**：数据治理违规等价于架构约束违规（对应 pr-cr-fix 严重度定义的 MUST_FIX 档），不得以 SUGGESTION 降级放过。

**第 2 层 静态拦截（提交前，模式级）**

- **R1 pi 文件直写检查**（新增 `.githooks/check_pi_direct_write.py` + pre-commit 接入，复用现有 checker 同体系；已核实 pre-commit 本体不在 git 跟踪——由 `.githooks/install-hooks.sh` heredoc 生成到 commondir（`--git-common-dir`）hooks，改 checker 接入必须改 install-hooks.sh 并重跑，见子文档附录 A #6）：runtime/scripts 代码对 pi session JSONL 本体的写操作（`openSync('a'/'w')` / `appendFile(StorageSync)` / `writeFile(StorageSync)` / `atomicWrite`（已知 util 形态——patchSessionCwd 经它整文件重写）指向 sessions 目录）一律报错；sidecar 家族后缀（`.meta.json` / `.preset.json` / `.project.json` / `.handoff.json`——第 4 后缀随 W11 的 handoff 迁移启用，豁免清单与登记表 sidecar 家族条目一一对应，见 D3b）为规则内置豁免（登记形态，非 allowlist 条目）；迁移期 legacy 例外（非活跃 rename、persistHandedOff、patchSessionCwd——D2 补全）显式 allowlist + 期限注释，P1（W11）删除/迁移直写代码后 allowlist 清空，规则变为无条件（sidecar 内置豁免与 fork 登记除外）。**检出边界（匹配粒度，r4 落文件级定义、r5 补全命中/豁免机制为两必要条件）**：命中 = 满足条件 A（文件级邻近，圈定候选）且条件 B（写目标不落入内置豁免）。**条件 A**：写调用所在文件内含 sessions 路径推导痕迹，痕迹限定**代码语境**——`getSessionsDir` 的 import/调用，或 `sessions` 出现在路径构造语境（`join(…, 'sessions', …)`、`'sessions/'` 路径段拼接）；注释、普通标识符（如 `sessions` Map 字段名）、字符串文案中的普通提及**不计入**。该条件覆盖目标路径为形参、函数体内无路径字面量的间接形态（session-file-utils 的三条 legacy 写点即以此命中）；调用参数或所在函数体直接含路径推导的更近形态当然也命中。**条件 B（内置豁免，均在写目标路径层级判定）**：① **sidecar 家族四后缀**——写目标表达式含后缀字面量（`filePath + '.meta.json'` 内联形态），或目标经含后缀拼接的 sidecar 路径 helper（`projectSidecarPath(filePath)` 间接形态，后缀在 helper 定义处）——两种形态均豁免，文件内任意位置的后缀提及不豁免无关写点；② **非 sessions 目标目录**（调用点可见性规则）——写目标表达式（含同函数内直接赋值链）可见地经 `tmpdir()` 或 xyz 自有目录推导函数（`getAttachmentsDir` / `getConfigDir` 等，检查脚本内维护枚举清单）构造，目标不指向 sessions 目录即天然豁免（session-lifecycle 的 restore/fork tmpdir 拷贝写即此通道）。**扫描范围排除测试文件**：`__tests__/` 目录、`*.test.ts`、`test/` 目录不进扫描（测试构造数据的写点非生产写路径）。**承诺拦**：两条件联合命中的全部已知写形态（字面量直写 + `atomicWrite` 已知 util 形态）；**诚实声明不拦**：目标路径经形参间接且**整个文件**无任何 sessions 路径推导痕迹（代码语境）的写点——跨文件数据流静态不可判定（fork 写点即此形态，由登记声明 + S1 守卫，见 D3b 诚实声明）；拦模式，不承诺拦刻意绕过的语义（语义归 S1）。该机制下 W11「归零」验收的语义 = 条件 A 命中且不落入豁免/allowlist 的写点为 0，即检查脚本 exit 0（可达性已按新机制全仓归位自查：命中集 = session-file-utils 三 legacy 写点（W3 期 allowlist 覆盖、W11 删除）；sidecar 写点经四后缀豁免（W3 期三既有，W11 时点 = 三既有 + 迁入的 `.handoff.json` 写点 = 四——r6 计数核正）、session-lifecycle 两 tmpdir 写（:435/:594）经目标豁免、session-service 的附件/配置写所在文件零代码语境痕迹不进候选、测试文件不进扫描——无「必命中且无豁免」残留）。
- **R2 store 写入口检查**（taste-lint 自定义规则，项目已有 no-native-html 等先例；R2/R3 规则落点 = 仓库根 `taste-lint/rules/*.mjs`，不在 packages 内——已核实）：每个 store 的 mutation 方法只能被其 owner 文件调用，许可表来自登记表。**实现路线**：跨文件调用图分析（复用 check-domain-boundaries 的 import 边分析思路）；首版降级为「拦直呼形态」（import 目标 store 后直调 mutation），登记表条目驱动逐步收紧。
- **R3 新缓存强制注解**：新增模块级 Map/ref 缓存必须带 `@data-owner <登记表条目>` 注解，lint 校验注解存在且条目真实。没有「顺手加个缓存」这回事。ReplicatedState 原语落地后（P1），标量状态缓存的合法形态收敛为原语实例，R3 检查「原语之外不得新建 session 状态缓存」。
- **误报豁免闭环**：R1/R2/R3 拦到合法写入时，豁免路径 = 先在登记表补条目/例外 + 豁免 allowlist 登记（对齐 check-domain-boundaries 既有 allowlist + 注释先例），禁止在代码里静默绕过——预防机制自身不能成为无出口的阻塞源。

**第 3 层 动态断言（CI 等价性测试族）**——对「事件只做失效」「单一 reducer」的可证伪断言，任何回归会让等价性破功：

- `live ≡ reload`：真实 pi 子进程跑操作序列（steer/followup/bash/后台 subagent 完成），断言实时 store 快照 == 文件重放快照；
- `broadcast ≡ get_state`：事件风暴后断言 renderer 状态 == pi 快照；
- 混沌注入：事件乱序/丢失/重放 → owner 状态必须收敛到权威快照（拉取自愈的结构性验证）。

**第 4 层 数据登记表**：`docs/architecture/data-source-registry.md`，12 类数据的 owner / 权威源 / 唯一写入口 / 字段空值语义 / 已知例外（含 legacy 例外的移除期限），是 S1/R2/R3 许可表的依据 + review 时的对照 SSOT（对齐 ADR-0049 checklist 先例）；另含「已 owner 化声明」条目——plugin sessionData（P1）：权威 = runtime `SessionDataStore`（`packages/runtime/src/services/plugin-service/session-data-store.ts`，WriteBackCache 单写路径 + per-write debounce + 定时 flush + 磁盘恢复，消费者经唯一类入口操作）；provider 扩展配置（P2，PR #187）：权威 = `<piAgentDir>/config/providers.json`、唯一写方 = runtime `XyzProviderStore`（pi 零引用该子目录，锚点 + 契约测试守卫）——均非多源病灶、不进 12 类清单，登记以维持 G2「任何 GUI 数据可查 owner」的完整性。P1 起演进为可执行配置（ReplicatedState 配置即登记表条目），markdown 由配置生成或双向校验。

**第 5 层 ADR + review checklist**：新 ADR（编号顺延，当前最高 0061）「单一数据 owner + 绝对写规则」：判据、事件只做失效、pi JSONL 唯一写方 = pi 进程（含扩展经 pi API）、sidecar 家族是登记在案的 xyz 自有合法形态（D3）、文件创建型（fork）登记在案（D3b）、队列按字段分权威（D6）。pi 升级时跑 pi-protocol 契约测试（ADR-0037 联合类型 exhaustive 检查已有），防止上游事件语义漂移悄悄制造新分叉。

---

## §4 验收

**结论：五个真实场景验收（全部真实 pi 子进程 / 真实文件，无 mock），分别回溯 G1-G4；P0/P1/P2/P3 各阶段有对应可先行验收的场景。**

### 场景 1：手动命名不被覆盖 + 绝对写规则生效（P0/P1，回溯 G1）

- **步骤**：`pnpm dev` 起真实环境 → 新建 session 发首条消息 → 等自动命名出现（观察 rename-session 扩展日志 `renamed to`；日志查看方式：`XYZ_AGENT_DEBUG=1` 起环境后看 `~/.pi/agent/logs/`，AGENTS.md 扩展调试约定）→ 侧栏右键手动改名「重构计划」→ 继续对话 3 轮 → 检查侧栏名与 `get_state.sessionName`。再对另一个**非活跃** session 执行右键改名（P1 验收）。
- **通过标准**：3 轮对话后侧栏名仍为「重构计划」；扩展日志出现 `skip: name exists`；session JSONL 尾部无新增 auto 标题的 session_info entry；`get_state` 返回「重构计划」。非活跃改名后 JSONL 尾部出现改名 entry（由短命 pi 进程写入）。代码断言（P1）：`git grep -nE "openSync\('(a|w)'|appendFile|writeFile|atomicWrite" packages/runtime/src/` 的命中逐条核对，**不存在指向 pi JSONL 本体的写路径**；允许命中 = sidecar 家族（`.meta.json`/`.preset.json`/`.project.json`/`.handoff.json`——第 4 后缀 W11 迁入，xyz 自有，D3/D3b）与 `session-fork.ts:175` 文件创建型（登记在案，D3b）。（R1 检查脚本 exit 0：allowlist 为空；按 §3.6 R1 两必要条件机制，sidecar 四后缀（写目标层级豁免）与 tmpdir 等非 sessions 目标（调用点可见豁免）为规则内置豁免、fork 为登记形态、测试文件不进扫描——exit 0 可达。）

### 场景 2：断连自愈（P1/P2，回溯 G1/G3）

- **步骤**：对话进行中（已切过模型、有用量、队列里压一条 followUp）→ 杀掉 WS 连接模拟断网 30s（期间 pi 完成一轮回复）→ 重连。
- **通过标准**：重连 5s 内模型/思考档位/用量百分比/队列深度与 pi `get_state` + `get_session_stats` 逐字段一致（人工对照 RPC 返回），全程无错误 toast；对话流不缺消息（live ≡ reload 断言脚本输出一致）。

### 场景 3：重开一致性（P3，回溯 G1/G3）

- **步骤**：一个 session 内依次执行：steer 一次、`!` bash 一次、启动一个后台 subagent 并等其完成注入 → 重启 app 重新打开该 session。
- **通过标准**：重开后消息分组、subagent 侧栏状态、用量显示与重开前一致（截图对照）；CI 等价性测试 `live ≡ reload` 对该 session 通过。

### 场景 4：预防拦截（P0，回溯 G4）

- **步骤**：在测试分支故意制造三个违规：① 在 owner 文件外调用某 store 的 mutation；② 在 runtime 新增一段直写 session JSONL 的 `appendFileSync`；③ 新增一个事件 handler 直写 store 字段（语义级，绕过形态上不违反 R1/R2 直呼模式）。对①②执行 `git commit`；对③跑 pr-cr-fix review（review-data-governance 维度）。
- **通过标准**：①②被 pre-commit/taste-lint 拦截，报错指向登记表条目；③被 review agent 检出为 MUST_FIX（证明语义层覆盖机器层盲区）；按指引修正后提交通过。

### 场景 5：subagent 单源一致（P3，回溯 G1/G3）

- **步骤**：后台 subagent 完成后，对照侧栏 SubagentList 状态、主对话注入的完成 turn、`session.getSubagents` RPC 返回三者；再重开 session 后对照第四次（entry 扫描路径）；检查 session JSONL 中存在自描述 custom entry。
- **通过标准**：四处状态一致（closed + 相同 result 摘要）；混沌测试（丢失 entry_appended 广播）后 `get_entries` 重拉能收敛到正确状态。

---

## §5 下一层拆分

> 实施计划（单元 → wave 拆分与执行规格）原见子文档 data-source-governance-plan.md（已删除，git 可追溯）；本节单元表保留为概览。

**结论：五阶段递进，每阶段独立可验收可回滚；P0 把唯一的已证实 bug 修掉并立起双层护栏，P1-P3 在守护下逐域收敛，P4 固化为长期回归基线。**

**回滚通则**：每阶段保持独立 commit 序列；回滚 = revert 该阶段全部 commit + 等价性测试基线随 commit 一并回退（测试与代码同 commit，revert 即同步）。各阶段特殊回退验证见阶段表后「回滚」行。

### P0 止血 + 护栏先行（1-2 天；验收：场景 1 前半、4）

| 单元 | 内容 | justification |
|---|---|---|
| P0.1 | rpc-client 接线 `set_session_name`；`renameSession` 活跃分支改走 RPC；删除活跃 session 的**全部** `persistSessionName` 直写（rename 分支 + `tryPersistLabel` turn_end/agent_end 兜底——label 持久化责任整体移交 pi：显式初始 label 经 RPC、派生初始 label 退役为显示派生）；非活跃分支若暂留直写，登记为 legacy 例外 + P1 移除期限（例外集合见 D2：非活跃 rename / persistHandedOff / patchSessionCwd 三条） | 唯一已证实 bug，pi API 现成（✅ 已核实），改动面最小 |
| P0.2 | 数据登记表初版（12 条 + 字段空值语义 + legacy 例外登记） | 护栏的 SSOT 依据，先于一切重构 |
| P0.3 | R1 pre-commit 直写检查 + R3 缓存注解规则 + R2 骨架（拦直呼形态）。S1 已随本文档（c8def4a0c）接入 pr-cr-fix（8 维已生效），P0 剩余 = R1/R2/R3 机器检查三件 | 先立守护再动大刀；语义层（S1）已上线，机器层（R1-R3）P0 补齐，P1-P3 每步重构被双层覆盖 |
| P0.4 | 等价性测试骨架（真实 pi 子进程 fixture + `live ≡ reload` 断言脚本雏形） | 后续阶段的验收工具，P0 就绪 |
| P0.5 | 探针：① pi 冷启动延迟 ✅ 已完成——中位数 ~500ms（无 session 481ms / 附着 534ms，瓶颈在 Node 冷启动，`set_session_name` RPC 本身 <1ms），P1.4 据此定「逐次冷起」；② RPC 快照频率影响量化（P1 量化项）。失败预案：若量化超阈值，降级选项按序评估——防抖窗口拉长（dirty 合并窗口上调）/ 批量快照（多字段一次 RPC、多 session 合并拉取）/ 仅活跃 session 拉取（后台 session 降级为事件 + 低频兜底重拉） | D2/§3.2 风险栏的待验证项 |

回滚：revert 即回到现状（label 双写方 bug 回归但不劣于现状）；回退验证 = 场景 1 前半在回退后行为与修复前一致。

### P1 runtime owner 收敛（3-5 天；验收：场景 1 后半、2 前半）

| 单元 | 内容 | justification |
|---|---|---|
| P1.1 | `ReplicatedState<T>` 原语 + label/thinkingLevel/modelId/usage/queue 深度/commands 六个配置实例（合并策略含字段空值语义，规则见 D1b）——[后修订：label/queue 深度两实例撤销，见 §3.3 D7 消歧，现行以 data-source-registry.md 为准]；登记表条目演进为配置 | §2 模式 3 的收敛点，六类数据同构；配置即登记表 |
| P1.2 | 事件改失效信号：session_info_changed/thinking_level_changed/queue_update/context 相关事件 → dirty + 防抖重拉。modelId 失效源 = switchModel RPC 响应后主动拉快照（已核实 RPC 层无 model 事件，见 D7） | 「事件只做失效」落地的第一步 |
| P1.3 | 删除 sessionMetaCache（= `packages/runtime/src/services/session/session-meta-cache.ts`，sessionId 键；`infra/pi/session-file-utils.ts` 内同名 filePath 键纯派生缓存不在删除范围——已核实）；applyContextUpdate 五写点收编为单入口；switchModel 重算移入 owner | 影子状态库退场 |
| P1.4 | 非活跃 rename 切换短命 pi 进程——形态已定「逐次冷起」（P0.5 冷启动探针已核实 ~500ms 中位数可接受；与 RPC 频率探针为软依赖，不阻塞本单元）；删除 persistSessionName 全部直写代码；persistHandedOff 迁 sidecar 与 patchSessionCwd 迁 restore tmp 读改写管线（r3 补漏的两条直写链路，同为绝对写规则全线生效的条件）；fork 文件创建型零代码改动（登记确认）；R1 allowlist 清空 | 绝对写规则全线生效 |
| P1.5 | 现有 subscribe/ring/stateSnapshot 快照通道收编（D7 处置决定）：5 个 state 类话题（session.commands / context.update / session.subagents / session.workflowUpdate / session.state_changed）的数据源从事件直写 runtime 缓存切换为对应 ReplicatedState 实例发布，stateSnapshot last-value 从影子缓存快照变为 owner 快照；stream 类话题维持 ring 语义不动。迁移顺序 = P1.1 六实例落地后逐话题切换，每话题独立 commit + 等价性测试断言切换前后 stateSnapshot 内容一致，全部切完后删除 state 话题旧直写路径 | D7「投影一次」的衔接单元——不收编则 renderer 重连仍从 stateSnapshot 收到影子缓存快照，恰是设计要消灭的通道 |

回滚：P1.3 删除 sessionMetaCache 属删除性变更——revert 该 commit 即从 git 历史完整恢复 cache 文件与其全部写方；回退验证 = 场景 1 全量 + `live ≡ reload` 基线（P0.4 骨架）在回退后仍绿。P1.5 逐话题独立 commit，可单话题回退（stateSnapshot 内容一致性断言守护）。

### P2 renderer 零派生收敛（3-4 天；验收：场景 2 后半）

| 单元 | 内容 | justification |
|---|---|---|
| P2.1 | 每个 store 单一 `applySnapshot` 入口，setGroups/updateLabel/updateSessionState 收敛；派生逻辑（merge/normalize/推导）上移 runtime/core 唯一实现，WS 消息改 view-ready DTO | D7 投影一次的 renderer 侧落地 |
| P2.2 | pendingBuffer 计数 FIFO（删除文本匹配）——已核实计数差集 `countDrained` 已存在（`packages/core/src/domain/chat/effects/registry.ts:65-84`），实际改动面 = `drainPending` 删文本匹配改按条数取 | #6 失联即丢消息的修复，改动小收益确定 |
| P2.3 | scannedToSummary 空值守卫全量路径核查 | #2 空串覆盖的最后防线 |

回滚：P2.1 写入口收敛是删除性变更（旧写入口删除）——revert 该阶段 commit 即整体回退，等价性测试基线随 commit 回退到上一阶段版本；回退验证 = 重跑场景 2 确认无残留（`applySnapshot` 入口与旧写入口不共存，revert 后不得出现双入口并存）。

### P3 扩展数据单源 + 消息流（1-2 周；验收：场景 3、5）

| 单元 | 内容 | justification |
|---|---|---|
| P3.1 | subagent/workflow 扩展 `appendEntry` 自描述上报 + runtime `entry_appended`（移出 NULL_EVENTS）+ `get_entries(since)` 消费 + 内存 Map 改纯派生缓存 + extractor 降级 legacy + workflow link entry 形态收敛 | 模式 2/4 的收敛，D4；pi 官方通道，已核实 |
| P3.2 | session_end 维持 sidecar 单写方（D3 裁决选项 a）：读写收口 + 登记表登记 sidecar 为 xyz 自有合法形态；appendEntry 改造（选项 b）仅在出现真实需求时启动，并按 D3 的迁移三件套执行 | ADR-0042 前案 W1 的 sidecar 修订已消除双写方，重造无净收益 |
| P3.3 | 消息流单一 reducer：core 包 `applyEntry` 双路喂入（实时 feed + 文件重放）；实时 feed 形态已定（D5 探针已核实 message entry 不发射 `entry_appended`）——message 部分由 `message_end` 等事件重构 entry 喂 reducer，扩展 entry 直接走 `entry_appended`；若 pi 上游补发射则无缝切换（换喂入源头，reducer 不动） | #7 的根治，与 fix-chat-flow-order 分组修复协同 |

回滚：自描述 entry 是新增 custom entry 类型，旧代码不解析即忽略且不进 LLM context（session-manager.ts:377-385）——revert 后存量自描述 entry 留在 JSONL 中无害；回退验证 = extractor legacy 路径（P3.1 保留为兜底）仍能重建 subagent/workflow 列表，场景 3/5 通过。

### P4 预防固化（2-3 天；验收：全部场景回归）

| 单元 | 内容 | justification |
|---|---|---|
| P4.1 | 等价性测试族全量化（broadcast ≡ get_state / 混沌注入）入 CI | G3 的长期回归基线 |
| P4.2 | ADR-0062 落档 + 修订 ADR-0042 落档（ADR-0042 前案 W1 的 sidecar 修订——历史 effort 的 W1，非子文档 wave 编号：正文「append JSONL」原决策更新为「runtime 单写 sidecar」，消除正文与实现矛盾，对齐项目「推翻 ADR 需显式落档」惯例）+ review checklist（对齐 ADR-0049 先例）；R2 从直呼形态收紧到调用图 | 流程层固化 |
| P4.3 | pi 升级契约测试接线（ADR-0037 exhaustive 检查复用） | 上游漂移防线 |

回滚：纯测试与文档（ADR/checklist），无生产行为，revert 即回退；等价性测试族与 CI 接线随 commit 一并回退。

### 文件改动地图（核心，非穷举）

- **新增**：`docs/architecture/data-source-registry.md`（P0 起为 SSOT，P1 起由配置生成）；`.agents/skills/pr-cr-fix/agents/review-data-governance.md`（S1，本文档配套交付）；`packages/runtime/src/services/session/replicated-state.ts`（原语）+ 配置实例；`.githooks/check_pi_direct_write.py`（R1）；taste-lint 规则 2 条（R2/R3）；等价性测试 `packages/runtime/src/__tests__/equivalence/`；core 包 `applyEntry` reducer。
- **收敛**：`packages/runtime/src/infra/pi/rpc-client.ts`（+setSessionName）；`session-lifecycle.ts` / `packages/runtime/src/infra/pi/session-file-utils.ts`（直写收口 → P1 删除/迁移：persistSessionName 删除、persistHandedOff 迁 sidecar、patchSessionCwd 迁 restore tmp 读改写；rpc-client 与 session-file-utils 实际在 infra/pi/ 不在 services/session/——已核实，见子文档附录 A #1）；`packages/runtime/src/services/session/session-fork.ts`（零代码改动——文件创建型登记确认，D3b）；`session-meta-cache.ts` 删除；`session-service.ts` applyContextUpdate 收编；`event-interpreter.ts` 事件改失效；renderer/core 两侧 store 写入口（含 `packages/core/src/domain/session/store.ts` 等 core 包真实位置——renderer `stores/session.ts` 是 ADR-0059 薄壳）；`effects/registry.ts` queue_update 计数 FIFO。
- **扩展**：`extensions/subagent-workflow`（自描述 appendEntry 上报）。session_end 按 D3 裁决 a 维持 sidecar，不新增 appendEntry 扩展。
- **skill**：`pr-cr-fix/SKILL.md` 维度表 7 → 8（S1 接入）——已随本文档同提交（c8def4a0c）落地，P0 无需再改。

### 待验证检查点（诚实标注：✅ 已核实 / ⛔ 仍开放）

- ✅ pi 冷启动延迟对非活跃 rename 交互的感知——已核实（中位数 ~500ms，逐次冷起定型，见 D2 探针与 P0.5）。
- ⛔ 快照拉取的 RPC 频率与延迟对 UI 的实际感知（P1 量化，必要时事件做乐观提示、快照为准；失败预案见 P0.5）。
- ⛔ 自描述 entry 的体积/频率（D4 探针，P3 量化；必要时 trace 增量 + 状态全量两种 customType 分流）。
- ✅ `entry_appended` 对 message entry（非扩展 entry）是否发射——已核实不发射（源码 + 实测，见 D5 探针），reducer 实时 feed 形态已定。
- ⛔ 非 xyz 创建的历史 session（无自描述 entry）在新代码下的降级表现（P3 回归）。
