# 架构决策记录（现行有效）

> 本文档是 taiji 的架构决策 SSOT，浓缩自历史 ADR 体系（2026-09-15 整合，原始文件已删除、git 历史可考）。
> 只收录**现行有效**与**部分有效（核心成立、细节已漂移，按现状表述）**的决策；已过时/被推翻的决策在文末「已否谱系」留一行注记。
> 编号沿用原 ADR 编号——源码注释中的 `[ADR-XXXX]` 回链在本文件内解析（如 `[ADR-0049]` → 下文 §状态管理 ADR-0049 条目）。
> 约束登记号（C-xx-xx）指向 [docs/constraints.json](../constraints.json)；每条决策的「登记」列给出对应约束 id。

## 进程与外部依赖

### ADR-0005 / ADR-0006 pi 供给与打包形态（部分有效）
pi 以独立可执行文件随应用打包（`Resources/pi/pi-<plat>-<arch>`，dev 由 `scripts/prepare-pi-resources.sh` 预置同源产物）。打包态严格 bundled-only：二进制缺失即 throw fatal（`packages/runtime/src/infra/pi/find-pi-executable.ts`），不回退系统 pi——版本一致性、升级随应用走。dev 态允许 PATH/nvm 兜底（仅开发便利）。登记 C-pi-04。

### ADR-0009 数据目录与 pi 完全隔离
应用数据目录 `~/.taiji/` 与 pi 原生目录 `~/.pi/agent/` 完全隔离，扩展/技能/配置互不污染；路径一律从 `packages/shared/src/paths.ts` 的 `getConfigDir()`/`getPiAgentDir()` 动态推导，禁止硬编码（pre-commit 检查）。登记 C-pi-06。

### ADR-0037 pi 协议是真契约，无防御性双读
`packages/runtime/src/infra/pi/pi-protocol.ts` 是 pi 事件协议的类型镜像（PiEvent 联合覆盖全部 AgentSessionEvent），translate 入参用窄类型获得 exhaustive check；禁止 args/input 双读 fallback——pi rpc 序列化无字段改名，双读是死代码。pi 升级时由 pi-semantics 探针族（`scripts/check-pi-semantics.mjs` + `docs/pi-semantics.json`）红灯提示补齐。登记 C-pi-05。

### ADR-0064 pi 语义吸收层四支柱
taiji 与 pi 之间的私有语义适配收敛为四支柱：① 能力注册表——模型/思考档位能力只在 `packages/runtime/src/services/model-capability.ts` 一点进入（离线 pi-ai 同源计算 + 在线 get_available_models 对账），renderer/扩展禁止本地推断；② 生效回执——改状态 RPC reply 必回 pi 实际生效值，禁乐观写；③ 确认式送达——结果语义通知走 session-delivery 持久账本 + 幂等键（at-least-once），禁依赖 pi 内存队列；④ 漂移守卫——pi 语义依赖机器登记 + 探针测试 + 版本门禁。另有轮询精简准则：对方会 push 的信息禁周期 pull 兜底。权威源 [docs/architecture/pi-boundary-reliability.md](../architecture/pi-boundary-reliability.md)，登记 C-pi-12/13、C-ext-19、C-proc-08。

### ADR-0063 session 附着不变量 I1-I5
五条硬不变量防「会话写错文件/丢数据」：I1 runtime 登记路径必须恒等于 pi 实际写目标（`session-attach-assert.ts` 附着后 get_state 对账，不一致即 throw）；I2 对话数据只许存在于 sessions 目录 + 内存（禁入 $TMPDIR）；I3 退出/切换前登记文件须含 pi 已写全部 entry（`__tests__/equivalence/attach-lifecycle.test.ts` 真实 pi 等价测试）；I4 pi 内部行为断言必须带 pi-mono 源码锚点且穷尽全部消费层；I5 会话文件身份是受治理数据。登记 C-data-10。

### ADR-0062 单一数据 owner + 绝对写规则
pi 当前持有的 session JSONL 唯一写方是 pi 进程——taiji 任何代码永不直写，能力缺口由 pi 扩展在 pi 进程内补齐。三类登记在案的合法边界形态：sidecar 家族四后缀（.meta/.preset/.project/.handoff.json，写前 existsSync 守卫）、fork 文件创建型、restore-time 归一化 rename-over（inactive-only、白名单变换、每文件一次）。标量状态复制模式 = 快照拉取 + 事件只做失效（事件永不直写数据）。登记表 SSOT：[docs/architecture/data-source-registry.md](../architecture/data-source-registry.md) + `replicated-states.config.ts`（新数据 = 新配置条目）。登记 C-pi-07、C-data-01。

## 通信与协议

### ADR-0055 MessageBus：per-session 消息分发 SSOT
runtime→renderer 的 per-session 消息分发（`packages/runtime/src/services/message-bus/`）。每 session 维护单调 seq + 1000 条 ring buffer + stateSnapshot；renderer 切 session 时 `session.subscribe` 走「snapshot 回放 + last-value 注入 + lastSeq 基线」，此后 live push 靠 seq gap 检测触发 reconcile。ServerMessage 的 id（RPC reply）与 seq（push 事件）互斥。session 级消息已收敛为 bus.publish 单通道，global 级走 broker.broadcast。登记 C-comm-06。

### ADR-0060 route-inbound 三通道路由
入站消息分发单一真相源在 `packages/core/src/coordination/route-inbound.ts`，三出口：dispatchSession（per-session 消费者）、dispatchGlobal（无 sid 消息）、dispatchCrossSession（带 sid 但全局消费者需收的消息——extension:widget/status/notify/ui_request 等，合法消费者仅 ExtensionHost）。crossSession 不是广播；raw-message-tap 旁路已删除。事件分发面在 `core/src/transport/api/events.ts`。登记 C-comm-05。

### ADR-0046 RPC 类型配对 SSOT
协议层单点真相源——`packages/shared/src/protocol.ts` 的 ServerMessageMap + ReplyPayloadMap（K → reply payload 或 void），domain 侧经类型化 `command<K>()` 原语从协议推导，禁止手写泛型与协议脱钩。登记 C-comm-07。

### ADR-0016 ServerMessageType 类型约束（部分有效）
事件/RPC 消息类型受 ServerMessageType 联合约束，emit 拼错编译期报错（原 event-bus 文件已随包重构消失，现形态 = protocol.ts 类型定义 + route-inbound 分发，约束精神不变）。

### ADR-0010 / ADR-0012 Extension UI 独立通道 + plugin bridge（0012 部分有效）
pi extension 的 confirm/select/input 交互走独立 `extension.ui_request`/`extension.ui_timeout` 事件，与 Tool Approval 的 tool_call_pending 语义隔离、错误隔离。plugin-bridge（`extensions/taiji/plugin-bridge`）是插件工具进 pi 的唯一适配层，转发机制现为 select marker 通道（与 session-manager/ask-user 同构）。登记 C-comm-12。

### ADR-0024 FileChanges runtime 解析通道
event-adapter 在 tool_execution_end 按 write/edit 分派提取 FileChange（参数名 path 为契约权威），bash 不解析、由回合边界 git 对账补齐 delete/bash 变更；runtime 只推 accumulating/ready 两态，审查态归前端。登记 C-comm-04。

### ADR-0044 系统提示词双路
替换走 pi 原生 `--system-prompt` CLI 核心段替换（runtime spawn 链透传，仅新会话生效）；追加走 builtin 扩展 `extensions/taiji/system-prompt` 的 before_agent_start hook 每轮读 `<dataDir>/system-prompt.json`（热生效）。配置全局一份，runtime 与 pi 内扩展读同一文件。登记 C-pi-09。

### ADR-0068 扩展消息注入形态：custom message 首选（2026-09-21）
pi extension 向 LLM 注入提示词/通知消息统一走 `pi.sendMessage()` custom message 形态（`display` 控制用户可见性、不伪装用户消息归属）；`pi.sendUserMessage()` 保留给承载真实用户视角语义的消息——提示词类内容伪装用户消息的形态已在四包改造中清除（smart-context/goal/structured-output/plan，merge accb67c37）。关键语义两条：① custom message 经 pi `convertToLlm` 无条件转 LLM user 消息，对 LLM 与 user message 无差别，形态迁移不损失模型可见性（语义登记 [pi-semantics.json](../pi-semantics.json) PS-43，锚 pi `dist/core/messages.js:89-96` case "custom"）；② `sendMessage(triggerTurn:true)` 非 streaming 时直调 `_runAgentPrompt`，跳过 `prompt()` 主路径前置链（compaction 检查 / before_agent_start 事件 / systemPrompt 叠加 / pending nextTurn 消费）——依赖 per-turn 注入的需求不得走该通道。约定载体 [extension-conventions.md](../extensions/extension-conventions.md)「Event handler 消息注入」。

### ADR-0071 引擎协议演进宪法：删改分类学与判据（2026-09-22）
engine-protocol v1 的演进纪律从「头注承诺 + 人工记忆」落为成文宪法。终态条文浓缩于协议四处头注（`packages/subagent-engine-sdk/src/protocol/` 的 engine-protocol.ts / contract-types.ts / reverse-channels.ts / schema.ts——头注只载终态纪律不载删改史）；**本条是 6 次历史破坏性删改与判据 why 的唯一入库权威载体**（协议目录系 fresh import、git 不可追溯，改写前的源码头注是唯一现场记录，随本条收编后同批改写为终态）。约束登记：C-proc-13（存量演进表述对齐）、C-proc-22/23/24（判据 6 行为键必配门 / 四张词表锁 / 宽容语义四行）。

**6 次破坏性删改分类学**（三型纪律不同，不能一刀切 additive 也不能一刀切同批）：
- **A 型同形改名**（1 项）：`run.params.chat` → `run.params.resume`（载荷同形仅键名泛化；架构权威 docs/architecture/subagent-chat-run-unification.md §3.3 D3/D5）。additive 替代（新增 resume 键 + 读端 `params.resume ?? params.chat` 双读 + 旧键 `@deprecated` + major 清除）成本趋零却走读写同批，且双读形态从未被实践——A 型但书由此立：同形改名默认 additive 双读，仅当双读引入语义纠缠时才允许同批。
- **B 型机制替换**（2 项）：`interact` 控制面方法删除（续聊统一为新 run + resume 锚点；双轨 = 两套执行模型在 reducer/journal/conformance/能力门四面长期双维护，本身就是协议债）；`task.conversation` 键删除（per-run 模式开关语义消亡、职责并入 resume，双保留会造成「谁赢」的语义纠缠）。同批切换合法，条件 = 对端同仓 + ADR 登记（即本条）。
- **C 型死成员清理**（3 项）：轮次相位反向通道（新增后从未被消费）、`host/poolResolved` 通道（poolKey 恒 'shared'、回调零信息量——池抽象降级，docs/architecture/zcode-engine-appserver-resident.md）、`host/permission` 通道骨架（双侧零实装占位，「未接线死通道」）。根因不在删除在**新增**——治理 = 新增门槛：无消费方不进协议、占位先行即违宪（与能力位「声明链路实际接通的能力」哲学同源）。

**判据 1-7 证据锚点**（条文终态见 engine-protocol.ts 头注）：判据 1（引擎不消费→宿主自持）→ `task.idleTimeoutMs` 错位（六引擎映射全部不支持，实为宿主 idle GC 参数）；判据 2/3（what→task / 推导分叉→ctx）→ schemaEnv 三次搬家与 sessionRootId 事故补丁（文字判据靠人执行必然漏的两次实证）；判据 4（task/ctx 双写禁令）→ schemaEnv 双源事故——**H1b 收口未完成**：`packages/subagent-core/src/execution/engine/client/remote-engine.ts:382` 仍 `ctx.schemaEnv ?? task.schemaEnv`——wire 层禁令断言现状纯 never、无豁免（AgentCallOpts 已单侧排除 schemaEnv，键集交集为空），双源现状登记于断言注释（wire-field-locks.test.ts）待收口回看；判据 5（能力位双向回指）→ 先例 streamMode↔eventGranularity；判据 6（键三分类 + behavior 键必配门）→ resume↔conversation gate（error-codes.ts `assertChatConversationSupported`）与 forkSource 注释双先例，判别式 =「旧引擎静默忽略此键，宿主会发现吗？该降级是设计内吗？」（三案例归档唯一：resume→behavior、streamMode→degradable、description→advisory）；判据 7（能力位消费点/载体登记）→ steer 首个登记条目（capability-gate.ts 联合判据消费、pi-host-binding.ts 声明 unsupported，无独立 wire 执行通道——缺失如实登记，不设计）。

**演进政策三条**：① additive 面——新增可选字段/事件变体/方法/反向通道不 bump 版本，旧端忽略或 no-op 安全落空；新增须过门槛：消费方 + 降级路径 + 能力位绑定三件齐才进协议，无消费方不进协议。② 删除面——A 型同形改名默认「新增新键 + 旧键 deprecated 双读 + major 清除」；B 型机制替换/语义收窄同批切换合法（条件 = 对端同仓 + ADR 登记）；对端独立节奏出现时删除一律走 major。③ major bump——core 支持区间平移 `[1,2)→[2,3)`，遗留清单届时清理。存量不搬家（搬家本身是删改），遗留清单 = idleTimeoutMs（明确错位）/ scene、description（弱错位待核）/ schemaEnv（待 H1b 收口，未收口）/ steer 执行通道缺失；**重审触发条件** = 遗留清单 >5 项或任一错位引发实际派发事故 → 提前清理裁决，不等 major。

**未知成员宽容语义四行**（与编译期词表锁互补的运行时半边；词表头注与 engine-development-guide.md 引擎实装义务落地随之推进）：①未知 event.type → 旧宿主 reducer default no-op 安全落空（逐变体 noop-safe 论证标记）；②未知正向 method → 引擎回 error 帧 `engine_method_unsupported`（engine_ 前缀透传面新码，旧宿主收到不崩；引擎实装义务绑定下一引擎适配层立项随批带上 + conformance 用例，当前无消费方不实装）；③未知 host/* 反向通道 → 宿主回 `{unsupported:true}`（由 askUser 语境泛化到全通道），发送方引擎走自身降级路径；④未知可选键 → advisory 忽略、behavior 键必有门（判据 6），不存在无门依赖。配套机器锁 = **四张词表锁**（事件/方法/通道/能力位键集统一为常量 SSOT 派生或键集互锁，编译期红灯堵 schema enum 缺值与缺键 undefined 透传洞）。

**minor 协商触发条件（任一命中重开裁决；条件不到不加协商位）**：① 出现本仓之外发布的引擎适配层（第三方作者或独立 npm 分发/版本节奏）；② 单宿主需同时挂载跨协议代差引擎且无法同批升级；③ 出现「需宿主确认才可启用」的运行时可变能力（能力位从静态 manifest 变动态协商的真实需求）。

判据 1-5 是宿主→引擎字段归属判据，不适用于引擎→宿主上报（引擎→宿主新增帧/事件按上述演进政策与反向通道关联键总纲裁决）。权威源 [subagent-engine-protocolization.md](../architecture/subagent-engine-protocolization.md) §3.3「协议演进宪法」。

### ADR-0074 workflow run 显式状态机：转移表裁决 + 事件流权威投影（2026-09-21）
workflow run 生命周期治理（`packages/subagent-core/src/orchestration/run-events.ts`）四件套：① `RunLifecycle` 6 态显式状态机（`created/dispatched/running/settling/terminal/interrupted`），`transition` 纯函数 + `RUN_TRANSITIONS` 转移表是唯一裁决面——表外转移 fail-fast（`IllegalTransitionError` 让位 + debug 留痕），禁止直写状态字段；约束由 API 形态结构性承载（对外只暴露 query + transition 唯一入口），非 grep 守卫型、不设独立约束登记。② 事件流 journal（`RunEventJournal`，`<agentDir>/workflow-state/<runId>.events.jsonl`）是 run 态权威投影源——注册表投影 = journal fold 四相（missing/active/terminal/interrupted），文件 mtime 推导退役；abandon 是终局化动作（中断的 run 留痕后归入 terminal 相），非静默丢失。③ 终局诊断引用（stderrTeePath）随 ask-settled 落账事件流、终局投影从事件流读回——不引入第二写点、不扩 run-settled 载荷。④ run 级恢复场景的杀伤半径收窄（D9-2）：watchdog no-progress 与 cancel 收敛兜底两类调用面从全量组杀 `killAll` 收窄为 `killRunTopology` 定点收割（只杀该 run 锚定的引擎孙进程，引擎宿主与同引擎并发 run 存活；零拓扑引擎降级为 stall 出声不杀——ADR-0047 静默 ≠ 卡死）；dispose（停机全灭）/ stdout-wedge（引擎级腿楔死）/ failEngine（引擎级故障，反向通道楔死）三调用面豁免保留组杀——故障定位在引擎级而非 run 级，本无 run 级目标。排障姿势见 [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) §21。

### ADR-0075 workflow 域四支柱平移与 schema 通道终态（2026-09-21）
workflow/subagent 域对 pi 边界四支柱（ADR-0064）的同构落地与 schema 传输终态：① **确认式送达平移**——注册操作的终局通知必达，workflow run 成功/失败/取消一律出终局通知（持久账本 + 幂等键，C-ext-19 在 workflow 域的细化）；② **生效回执平移**——schema 强制武装回执：`armed` 事件是引擎自查断言之外的独立信号源（监控信号不与施控同源），宿主等待窗内未收到即 fail-fast；仅 native 引擎、仅 schema 任务上报，emulated 引擎恒不上报（契约义务权威源 [engine-development-guide](../extensions/subagents/engine-development-guide.md) §6 `armed` 行）；③ **契约显式化**——schema 跨进程只经 wire `task.schema` 单字段传输（env 预编码形态 `schemaEnv` 已退役，env 由引擎宿主从 task.schema 派生，resolver 产出侧负断言锁防回流）；扩展加载显式化（`ctx.extensionPaths` 白名单收窄落壳侧 pi-host，argv 镜像机制退役）。**schema 通道终态**：native schema 链保留直传（宿主对 parsedOutput 不做二次校验）、emulated 仿真为退出通道，由 `schemaEnforcement` 能力位声明分流。登记 C-ext-24 / C-ext-25 / C-ext-26。

## 状态管理范式（renderer/core）

### ADR-0049 per-session Map 分区范式（最高频引用）
任何持有 per-session 状态的 composable/组件必须用 `useSessionScopedState` 工厂（`packages/core/src/foundation/use-session-scoped-state.ts`，内部 Map<sessionId,T> 分区）；禁止实例级状态依赖组件树隔离、禁止 watch(sessionId) 手动清空。WS handler 必须用 `updateFor(capturedSid)` 显式分区（结构性消除切换竞态）；cleanup 统一挂 `useSidebar.deleteSession → triggerSessionCleanups` 销毁编排，纯加状态不接线清理的 PR 打回。例外清单显式登记（useSessionEvents 订阅编排层、全局 sid 协调器类模块级 Map、Pinia factory 体内 Map、useTerminal 混合形态、TurnRenderCache shallowRef 容器）。机器防线：taste-lint `no-instance-level-session-state`（error 级）。登记 C-state-01、C-state-08。

### ADR-0043 消息模型 Segment[]
user message content 为 Segment 判别联合（text/skill/file/mention），badge 信息从 composer DOM（getSegmentsFromEl）结构化传递到渲染层；序列化/反序列化各只一处（segmentsToPrompt / parsePiUserContent）；归一化函数在 `packages/shared/src/segments.ts`。assistant/system 仍为纯 string。登记 C-state-02。

### ADR-0040 统一 file chip 通道
`#` 输入与 drawer 注入共用 insertFileChip（`packages/dom-core/src/composer/input/chip-commands.ts`），dataset 承载 path/lineRange；Segment file 类型为唯一结构化载体。

### ADR-0048 display 字段三路透传
pi CustomMessage 的 `display:false`（如 goal/todo context 提醒）三路透传（实时 effect / get_messages converter / JSONL apply-entry），渲染层 filterDisplayableMessages 统一按 `display === false` 过滤（仅 false 隐藏），store 保留完整消息供 fork/compact/replay。无黑名单。登记 C-state-03。

### ADR-0039 / ADR-0041 shallowRef 不可变更新 + 派生状态（0041 部分有效）
chat messages 用 shallowRef(Map)（`core/domain/chat/store.ts`），所有更新必须「新对象 → 新数组 → Map.set」不可变写法——直接 mutate 字段不触发响应式，属反模式。isGenerating 从 messages 派生（单一真相源 + 增量跟踪缓存）。

### ADR-0065 mutation reply 生效值契约
改状态 RPC 先判「后端会不会变换请求值」：经 pi（model.switch/setThinkingLevel）→ 禁乐观写，reply 生效值是唯一写 store 路径，协议 reply 生效字段类型必需；本地存储（preset CRUD）→ 允许乐观写 + reply 权威覆盖 + 失败回滚。机器强制两层：协议具名 XxxMutationReply interface + `mutation-reply-contract.test.ts` MUTATION_RPC_REGISTRY（新 mutation 不登记即测试红）。登记 C-pi-15。

## 包拓扑与分层

### ADR-0036 Monorepo 结构终态
pnpm-workspace.yaml 三组：packages/*（@taiji/* 16 包）+ apps/*（electron）+ extensions/*（taiji/universal/shared 三分组，@zhushanwen/pi-* 25 包）。renderer 依赖链单向：shared ← core ← dom-core ← ui ← renderer。单一 pnpm-lock.yaml，禁 npm。登记 C-build-03/05。

### ADR-0058 dom-core 包：DOM-bound 逻辑独立
「需要 DOM API、无 electron 耦合、跨 DOM renderer 复用」的前端逻辑归 `@taiji/dom-core`（现主要承载 composer/input：contenteditable/chip-commands/dragdrop）；`@taiji/core` 保持真 headless（零 DOM 零 jsdom，node/worker 可跑）。登记 C-state-04。

### ADR-0059 core factory + pinia 集成范式
createXxxStore factory（core headless）+ createUseXxx 编排 factory 的集成范式 =「store 封装（经公开接口访问）+ renderer 薄壳 defineStore + getXxxStore 处集中 cast（pinia unwrap ref 的固有类型鸿沟）」；禁止 raw createXxxStore() 双轨 + 桥接同步。chat 为范式标杆（`core/domain/chat/useChat.ts`）。

### ADR-0027 / ADR-0026 / ADR-0025 文件域三层 + 懒加载 + File View 语义（0027 部分有效）
FileService 三层：transport(FileMessageHandler) → services(FileService 编排：cwd 守门/懒加载/ignore/readFile 截断) → infra(FsExecutor)，IO 经 IFileExecutor port 不直连 node:fs；ignore 匹配为纯函数（`runtime/src/infra/fs/ignore-parser.ts`）。文件树懒加载：listTree 返回顶层 + 一级子，expandDir 单层按需，前端 5 态节点状态机（loaded 复用/inFlight 幂等/error 重试/invalidated 重拉）。File View = session cwd 完整目录树 + git.status 现在态角标，与消息流 ChangeSetCard（历史态）正交。

### ADR-0004 / ADR-0035 配置写入原子性 + write-back 模式
所有 JSON 持久化经 `atomicWrite`（writeFileSync(tmp) + renameSync）落盘——崩溃不留损坏中间态（`packages/runtime/src/utils/fs-utils.ts`）。「dirty + debounce flush + flushAll」write-back 为各持久化域统一模式（recent-workspaces-store 为范例）。登记 C-data-11。

### ADR-0001 / ADR-0002（digest）runtime 分层与手动 DI
runtime 为 transport → services → infra 三层，组装在 index.ts 手动 new（无 IoC 容器）；SessionPool 上帝类已拆为 SessionService + message-converter 纯函数。登记 C-comm-01。

### ADR-0011（部分有效）builtin 扩展打包内置
`@zhushanwen/pi-*` 扩展 esbuild bundle 后 staged 到 `apps/electron/resources/extensions/` 随应用打包，不走 npm 安装；清单 SSOT = `packages/shared/src/mandatory-extensions.json`。「随应用内置、版本随应用」核心决策延续（实现从源码拷贝演进为 bundle）。登记 C-build-02。

### plan 模式重设计的决策承载（2026-09-18，显式裁决：不另立 ADR 编号条目）
plan 模式重设计（GUI 投影 + skill 挂载 + 文档审阅闭环）的全部关键决策由 pi-ext ADR 家族（pi-ext-021 prompt-only readonly / pi-ext-022 session-manager state 等既有条目）与 `extensions/universal/plan/` 源码注释 + [CONTEXT.md](../CONTEXT.md) 的「计划模式 / plan-state entry / PLAN_REVIEW_MARKER / record 投影链」词条承载，不另立 ADR 编号条目。理由：决策密度已由设计期对抗式审查收敛，核心机制（marker select 通道 = Marker RPC 词条、投影链 = 既有 subagent/workflow 机制的参数化扩容）均复用已登记决策，新编号只增检索成本不增信息。本条目即「为何检索 plan 相关决策不到 ADR-XXXX 编号」的权威解释。

## 可靠性与看护

### ADR-0047 watchdog 用进程健康探测
pi 卡死检测用「进程健康探测」（每 60s ping get_state）替代「事件静默时长」——静默 ≠ 卡死（ask_user 等待/慢工具都会静默），连续 2 次失败广播 WARN、3 次（180s）才 onSilentAbort。实装 `event-interpreter-ping.ts`（PingProbe）。与「runtime watchdog 滚动重启」（默认不武装，TAIJI_RUNTIME_WATCHDOG_ARMED）是两套机制。登记 C-comm-09。

### ADR-0069 内存活性治理审计裁决（2026-09-14，维持不治为默认）
全仓内存活性审计后的用户裁决：登记不治点位「维持不治」是默认，翻案需新实测压力数据（原审计文档 docs/design/memory-leak-remediation.md 已删除、git 可追溯，各点位量级锚与重审条件见其 §2.5；裁决注释已写入各源码处）。不治 8 项：sessionMetaCache / externalMetaCache / notRepoCache / usage-stats shards（语料有界）、pi-respawn 熔断计数（熔断语义优先）、clearedSessions tombstone（有意无界防迟到写）、executingBash 断连残留（两害相权残留更轻）、session-file-utils 32MB 全量读（协议合法载荷有硬上界）。已治理面：G2 活性无界组（openPiStreams close 摘除、ws-client sweepExpiredInFlightSubscribes 挂重连路径）与 G4 杂项组（prematureTimeoutIds/deferFlushFailureCounts 纳入 disposeSession、skill-registry projectWatchers LRU(8)、ImportSessionDialog close 清扫描结果、quota fetch body cancel）。系统性防护（纯加状态不接线清理打回）已并入 ADR-0049 checklist。

### ADR-0018 extension 安装临时目录
Collection 安装先完整落 `tmp/ext-scan-{timestamp}/`（clone/cp + npm install），用户确认后拷入正式目录——取消/失败只清理临时目录，不污染 extensions/。

### ADR-0038 subagent 只 cancel 无 pause/resume
subagent 是 single-shot 子进程，控制只支持 cancel（现扩展 message/start），不实现 pause/resume——底层无长驻进程，不做假对称。

### ADR-0067 subagent「已收起」第三状态全链路清除（2026-09-16 用户裁决）
subagent 对用户的可见状态只有两桶：进行中 / 已结束（判据 = `isRunningProjection` 及其取反）——「已收起」（archived）不以第三状态呈现，全链路清除不残留：renderer 三桶视图与「已收起」过滤器删除；shared/runtime 投影链的 Intent 类型与 ExecutionRecord.intent / SubagentRecord.intent 字段删除；subagent-core markArchived 原语删除，close 的资源收尾职责由 `markSettledOut` 承接（close 收口落账：幂等、worktreeHandle 清句、`.alive` release、manifest 投影，不写任何意愿字段）；markReactivated 删除（message 续聊无翻位发生，万物可续判据不变）；通知 gate ①（archived 静默守卫）删除，close 注销 reason 词 `archived` → `completed`。机制权威 [docs/architecture/subagent-permanent-session-model.md](../architecture/subagent-permanent-session-model.md)（§3.2.5/§3.2.7 已按删除后现状改写）。登记 C-data-20、C-proc-13。

### ADR-0015 statusline plugin 封装
plugin 中转渲染 statusline（`plugin:statusBarUpdate` 通道），plugin 不直写 UI。

### ADR-0013 / ADR-0014（digest）sessionData 本地文件持久化（0013 部分有效）
plugin 的 per-session KV API 保留；底层为本地文件持久化（`plugin-service/session-data-store.ts`，atomic write + 启动恢复 + debounce flush），不依赖 pi.appendEntry。

### ADR-0034 / ADR-0033（digest）recent-workspaces pull-only + 三层
pull-only RPC（workspace.listRecent，无 broadcast——规避订阅时序竞争）+ 三层（handler 零业务路由 → workspace-service 编排守卫 → recent-workspaces-store LRU 纯算法）。登记 C-comm-08。

### ADR-0021（部分有效）资源加载策略
config 层 skill/agent 加载 = 强制目录（桥接层硬编码注入，不可关）∪ discovery.json v2 可选目录（project/global 拆分、可排序）；目录级粒度无文件级开关。agent/workflow 的资源发现已改 `subagent-core/src/shared/resource-discovery.ts` 7 源代码推导（last-writer-wins 遮蔽语义），discovery.json 在该链路废弃。

### ADR-0051 项目 skill 目录 .agents/skills
skill 路径按 cwd 解析（getSkillPaths(cwd)），项目自用 skill 归 `.agents/skills/`，跨项目通用归 `~/.agents/`。

## 前端交互结构

### ADR-0056 / ADR-0057 Composer Staging 双层
模型暂存层（stagingModel/stagingThinking 快照，enter 快照/exit 恢复，getStagingConfig 供 fork/handoff 创建新 session 传 override；优先级 Staging > preset > 默认）+ 行为策略层（StagingAction 接口收敛 enter/exit/send/abort/visual，Composer 经 activeStaging 路由）。落点 `core/domain/composer/dispatch/staging-mode.ts` / `handoff-mode.ts`。

### ADR-0053 SideDrawer per-session 控制态
isOpen/activeTab/docked 三控制态经 useSessionScopedState 按 focusedSessionId 分区；事件驱动的打开对非聚焦 session 只置 pendingOpen 标记，切回时消费——区分「用户手动关闭」与「未看过待提示」。

### ADR-0032 thinkingLevelMap key/value 语义
key = UI 档位（含 max），value = 发 pi 的实际 level（max → xhigh）；可用档位按 key 判定，传 pi 必经 resolveThinkingValue 映射（pi 不认识 max 会 clamp）。实装 `core/domain/composer/thinking-levels.ts`。

### ADR-0050 slash/skill 候选源按 variant 分支（skill 段与 slash 段 skill 项均 = taiji registry）
skill 候选两态统一 taiji 源：globalSkills ∪ projectSkills（location 取 `SkillInfo.sourcePath`），新鲜度由 `config.skillCacheInvalidated` 广播链即时驱动，不依赖 pi reload 往返；panel 态 project skill 的 cwd = sessionStore 投影的 session cwd（landing 维持 `flow.currentCwd`）。slash 段仍走 registry 声明 ∪ pi 真源合并（panel 另注入 compact），panel 态 slash 段的 skill 项**换源保留**（0.10.1 首版「过滤 skill 项、panel 的 skill 段是唯一 skill 入口」的双入口消除二次修订推翻）：pi 真源 skill 命令（reload 才刷新的滞后快照）仍剔除，registry 源 skill 项以 `/skill:<name>` 形态补入（与 landing 单列形态同构、同一追加函数）。行首 `/` 与行中 `/` skill 段双入口共存——跨入口防双插由 selectedSkillNames 已选标记（S-2）承担，不依赖入口裁剪。用户可感知后果两条：①panel `/` 浮层 slash 段列 registry 源 skill 项（首版不列致行首 `/` 肌肉记忆下 session 发起后 skill 不可见，属回归）；②taiji 独有目录（taiji 扫描集含、pi 扫描集不含，如 `~/.taiji/skills`）的 skill 进面板候选与注入，但 pi `/skill:` 命令注册表与 system prompt skills 段不含——模型不可自主调用 taiji 独有 skill（pi 只认自己扫的目录）。扫描集语义差：pi 扫 `cwd/.pi/skills`（taiji project 扫描集已补齐对齐）；taiji 独有目录不反向追齐，属既定语义差。

### ADR-0028 / ADR-0029 / ADR-0030（digest）搜索域内聚（0028/0029 部分有效）
多源聚合（命令/文件/会话/recents）收敛于 `core/src/domain/new-task-search/`（search.ts 编排 + match-engine + file-match 单一管线复用于 composer # 与 SearchModal）；mock 反向依赖生产类型，生产类型归 domain types.ts。登记 C-state-07。

### ADR-0054 Browser Drawer 用 WebContentsView
内嵌网页用 WebContentsView（任意 URL + 独立 preload + CDP target），排除 iframe（X-Frame-Options 硬伤）与 webview tag（官方 discouraged）。实装 `apps/electron/main/browser/browser-view-manager.ts`。登记 C-build-06。

### ADR-0066 太极·玄纯灰 V3（唯一现行视觉 ADR）
全族去冷蓝换纯灰（bg/surface/neutral/border 同步），accent 中亮灰 #cfcfd4，状态色保留极弱色相（M/A/D badge 语义辨识下限）。值权威 = `packages/renderer/src/style.css`（暗色默认，亮色 [data-theme=light] 镜像）。视觉演化史见 [docs/design-evolution.md](../design-evolution.md)。

### ADR-0067 Overview 视图整体移除
用户裁决 Overview（多会话鸟瞰）不应在任何地方存在，全链路删除（组件/路由 view/入口链/i18n/测试）。背景：入口早已收敛（v6 D14 移除 sidebar 按钮，仅 ⌘K 命令面板 go-overview 可达），实态为 v1 骨架无真实用户价值。替代形态：会话切换与统筹由 Sidebar Session List + ⌘K 搜索满足；后台任务可见性由侧栏 Agents/Flows 视图 + 通知体系承担。连带删除唯一消费者 sessionDigest 派生（useSessionDerivations）。

### ADR-0070 scheduler widget 推送减频与帧双职责显式接管（2026-09-21 设计裁决）
widget 推送从「每 30s 无条件全量」改为**任务集指纹跳推**（稳定字段 id/name/schedule/kind/enabled/nextRunAt/locale 序列化对比，不变不推；维护不变量：指纹字段集 ⊇ widget 显示决定因素全集）。显示面**时间投影整体移除**（用户裁决全砍倒计时/时间投影）：widget 行文本只含任务名与静态调度描述，TUI 逾期标记、GUI status 逾期翻牌删除，TUI 最近任务选择按 nextRunAt 升序不用 now 过滤；连带清理 = widget 专用 i18n 词条 + widgetStatus 逾期分支（`formatRelativeTime` **保留**——`task.list`/`task.created`/`service.list` 命令层仍消费，`renderTaskLine` 拆分为 widget 静态变体 / 命令变体）；`task.list` 人侧渲染补执行状态摘要补偿失败可见性——widget 显示 = f(稳定字段, locale)，时间流逝不是状态变化，不得触发推送。widget 帧曾意外承载的两个隐藏职责显式接管：①**空闲保活心跳**（入站全帧 touch `lastActivityAt`，30s 帧掩护下 scheduler 会话永不 idle）→ 显式化为「有任务且距上次推送 >10min」的保活底线帧（方案不变量：保活间隔 ≪ idle 回收阈值 ≥3 倍余量；空任务不发——pi 清屏帧同样 touch 心跳，空任务保活 = 空会话永不回收）；②**reload 恢复时机**（现状靠 per-session ring 概率性回放，忙会话冲刷后失源）→ message-bus 中 `extension:widget`/`extension:widgetGui` 改登记 **state 类**（typeKey 载荷派生 per-widgetKey），重订阅经既有 stateSnapshot 段构造性恢复（清屏帧 gui:null 即 last-value；session 销毁随 bus.clearSession 清理；曾考虑 runtime 新建帧缓存 + sendInitialState 补发段，因与 stateSnapshot 重复建设且重连场景被 seqGate drop 而否决）。设计文档 `.tmp/tech-design/scheduler-widget-push.md`（过程产物），实施落点 = u1 extension 侧闭环（静态化+清理+跳推+保活，挂既有 onAfterTick）→ u2 runtime message-bus widget 帧 state 类化 → u3 回归面。

### ADR-0072 pendingSend 分型清除锚点与 composer 发送布尔契约（2026-09-22 设计裁决，expectTurn 相关边界已由 ADR-0073 交付收敛）
表单假忙修复的语义裁决：`isActive ≡ isGenerating ∨ pendingSend` 的 pendingSend 桥接清除收敛为**分型锚点**——form 通路 ui_response 送达（delivered=true）后仅 cancel 型（result===null：Esc/取消按钮）即时清除；提交型（result≠null）不清，桥接「respond 完成 → message_start」窗口由 turn 事件正常清除（无 turn 期待型经 ADR-0073 expectTurn 声明即时清除）；`requests-invalidated` 广播按 sid 清除（reclaimed/plan-aborted/turn-aborted/session-destroyed 四源）；30s timeout 纯兜底（可观测三要素：上界/自愈/warn——timeout 分支 warn 已去 dev 门（ADR-0073 U5），生产 attach 可见含 sid）。原登记已知边界「无 turn 提交型每提交必命中 30s 兜底 + 源元数据通路未打通（后续候选）」已由 ADR-0073 交付解决（scheduler 提交 91ms 即时清）；剩余常态命中面 = plain dialog 提交面已由通路级即时收尾解决（sendPiResponse 应答终局无条件清 pendingSend，生产者穷尽论证：command handler 源结构性无 turn / turn 内源 pendingSend 恒空；落地 98e2aa8b5）；已知失真登记：多步链悬挂期插发直发会被误清（构造上无从区分直发与命令链置位的 pendingSend）——实测 pi 命令 dispatch 即返（void run()），直发被并行处理、message_start 即时到达覆盖，无可见假闲窗口（2026-09-23 验收 O-5）；重审触发 = 用户报告误导操作（保留）。occ-idle 不可作锚的裁决维持（会破坏 ask-user 桥接制造 isActive=false 空窗）。composer 发送布尔契约：`send()` 返回 true = 已投递或输入已可见保留（直发失败乐观气泡亦 true），false = 输入未消费须恢复（仅 B 策略专用）；steer 三早退（空段 / 空白文本 / session 非活跃——非 busy：busy 时 steer 是合法投递路径）返回 false 并 warn（60 字符截断），主链三个 clearInput-first 落点（routeSteer/sendActiveMessage/sendLandingFirstMessage；onSteer 死代码防御对齐为同范式第四落点）统一「快照空 + hasInput 短路不变量」（快照非空失败走 restoreSegments 恢复）。设计文档 `.tmp/tech-design/form-hang-fix.md`（过程产物），实施 = U1 respond 分型锚点 + invalidated 清除 / U2 steer 输入保留三落点。

### ADR-0073 expectTurn 源元数据通路与直发门终态通道（2026-09-22 设计裁决）
表单提交型「是否有 turn 跟随」的判别权归扩展作者显式声明：`uiFormInteract` options 增 `expectTurn?: boolean`（缺省 true 全兼容存量），五段通路 = 声明（scheduler 命令路径传 `expectTurn:false`）→ marker select options JSON 携带 → event-adapter `tryTranslateFormSelect` 单点**条件落键**（仅显式 false 落键、undefined 省键；legacy 归一分支不透传——旧 npm 包结构上不可能携带）→ `ExtensionUIRequest` 加员（`toExtensionUIRequest` typeof 守卫）→ respond 分型严格双条件 `result≠null && expectTurn===false → clearPendingSend`（`=== false` 显式判定禁 truthy，undefined 走桥接 = fail-safe；双侧类型守卫把脏值挡在帧外走桥接）。效果：/schedule 提交即时收尾（真机 91ms/48ms 两轮实测，不再命中 30s 兜底）；ask-user/plan 桥接零改动。连带裁决：D4a——plain dialog 应答收尾锚点落壳层 transport `sendPiResponse`（**先于 delivered 检查**即 clearPendingSend，cancel/提交/断连三型应答终局统一收尾（ADR-0072 收口条目）；**两通路相位分叉属有意设计**——form 通路分型锚点在 delivered 之后（`useExtensionUI.respond` 未送达即 return，锚点不可达，未送达期间维持 busy），plain 恒清在 delivered 之前（「意图先于送达」），重审 = 两通路收尾语义统一化提案出现时整体重审，勿单独判其一为 bug；原 ui 队列落点结构性不可达 store，chat-view-deps 反向依赖禁令）；D5——timeout warn 去 dev 门（store timeout 分支恒发；该残余已由 renderer console 落盘管道解决（renderer-console-<date>.log，落地 4f85d2964/7dfe760bf；重开 = 用户 2026-09-22 裁决，30s 兜底 warn 生产可取证——warn/error 级经 main 侧 console-message 监听落盘，排障取 <dataDir>/logs/ 即得））；30s 兜底 timer 保留（语义收窄为真异常回收层）。已知边界：plain dialog 提交面（/permission 命令族）pi select API 无元数据通道、每次提交命中 30s 兜底的挂账已由通路级即时收尾解决（sendPiResponse 应答终局无条件清 pendingSend——pi select 无元数据位的缺口由通路默认值「无 turn 收尾」绕开，非交互形态迁移：CompanionBand → FormOverlay 方案已否（错层反例：用交互形态重构解决收尾语义缺陷）；论证与已知失真登记见 ADR-0072 收口条目）；/session-pick 系 tui 注册门源 RPC 模式不可触发。同批终态通道：composer 直发门读 ShellInputInstance expose 的 `getInputElement()`（禁回退 `$el`——dev 构建模板首注释使 `$el` 为注释节点、门恒 false 的 W1 F-1 教训，[HISTORICAL] 钉死于 command-popover-keyboard.ts）。实施 = form-submit-busy-convergence 七单元（43ca4df7b…0f1ac2dce）+ F-1 修复 3227df0bd；设计文档 `.tmp/tech-design/form-submit-busy-convergence.md`（过程产物）。

## 已否谱系（决策已过时/被推翻，一行注记防重新发现旧坑）

- **ADR-0008** navigate-tree 桥接命令——命令已删，桥接形态被 marker 通道取代。
- **ADR-0019 / ADR-0022** 冷蓝暗色视觉方向——被 ADR-0066 太极纯灰推翻。
- **ADR-0023** Overview 入口 = sidebar 按钮 + ⌘⇧O——v6 D14 nav 重构移除入口按钮，⌘⇧O 未绑；go-overview 仅经 SearchModal 可达。
- **ADR-0045** 自研虚拟滚动不引入库——决策反转：MessageStream 已切 virtua/vue `<Virtualizer>`（cw wave w3）。
- **ADR-0003**（digest）translate 宽类型——被 ADR-0037 真契约窄类型取代。
- **ADR-0007**（digest）git submodule 管理依赖——被 ADR-0011 打包内置取代。
- **ADR-0017**（digest）traffic light safe-zone v2——数值 SSOT 现为 DESIGN.md §11。
- **ADR-0061**（digest）cw store repo 级键控——被 coding-workflow 仓库方案取代。
