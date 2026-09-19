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

## 已否谱系（决策已过时/被推翻，一行注记防重新发现旧坑）

- **ADR-0008** navigate-tree 桥接命令——命令已删，桥接形态被 marker 通道取代。
- **ADR-0019 / ADR-0022** 冷蓝暗色视觉方向——被 ADR-0066 太极纯灰推翻。
- **ADR-0023** Overview 入口 = sidebar 按钮 + ⌘⇧O——v6 D14 nav 重构移除入口按钮，⌘⇧O 未绑；go-overview 仅经 SearchModal 可达。
- **ADR-0045** 自研虚拟滚动不引入库——决策反转：MessageStream 已切 virtua/vue `<Virtualizer>`（cw wave w3）。
- **ADR-0003**（digest）translate 宽类型——被 ADR-0037 真契约窄类型取代。
- **ADR-0007**（digest）git submodule 管理依赖——被 ADR-0011 打包内置取代。
- **ADR-0017**（digest）traffic light safe-zone v2——数值 SSOT 现为 DESIGN.md §11。
- **ADR-0061**（digest）cw store repo 级键控——被 coding-workflow 仓库方案取代。
