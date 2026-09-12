# pi chat 域协议 v1.x 入引擎进程 与 轮次活性治理 技术设计

> **[HISTORICAL] superseded（2026-09-11）**：本文描述的 chat 域独立协议面——`host/roundLifecycle` 反向通道族（含 active 轮内心跳相位）与 `interact` 控制面方法、`RunParams.chat` 会话形态键、chat 域长驻会话状态机（ChatSessionRegistry / 轮终等待体 / 冷续复活）——已随 [subagent-chat-run-unification.md](subagent-chat-run-unification.md)（H1）整族退役。现行权威形态：续聊轮 = 新 run + resume 锚点（`RunParams.resume`，pi `--session` 续写原 session 文件）、活性 = run 事件 + run 应答驱动、settle 交棒 = Continuation onRunSettled；约束权威已改挂 C-proc-13（authority → subagent-chat-run-unification.md）。本文保留作 v1.x 时代交付史与 ③pending 注册表 / ④goal 熔断 / ⑤abort 阶梯三段机制的设计溯源，正文中的通道族与相位机描述**不再对应当前代码**。

> **一句话结论**：用一次**协议 v1.x 增量扩展**（激活既有 `interact` chat 控制面 + run 会话形态 + 反向通道轮次生命周期载荷）把 pi 引擎最后一块 inproc 豁免面——**chat 续聊域**——迁入 `pi-subagent-cli` 引擎进程并删除 inproc 分支；同批把 2026-09-08 真机事故暴露的「轮次活性」缺口（goal continuation 死循环 / 异常死亡误报 completed / abort 落不了地被宿主误判强杀）收敛为**三层显式语义**：goal 扩展无进展熔断（带正交封顶）、core 编排层轮次活性权威（record 去向单一裁决表 + 注销枚举点 + 对账 sweep）、runtime 强杀前置活性判据（快超时探测×事件窗组合，升级阶梯有终点）。

> 层声明：当前层 = **技术方案设计**（协议 v1.x 载荷语义 + chat 域迁移策略 + 轮次活性治理机制与边界）；
> 下一层 = 可实施单元（impl-plan，走 dev-flow）。本文件不放帧字段级 JSON / 文件级行号级改造步骤——那些归 impl-plan。
>
> 事实基准：2026-09-09，分支 `fix-subagent-zcode-session`，HEAD `bc8108af7`。文中行号以该 HEAD 为准；pi 语义断言以实装版 `@earendil-works/pi-coding-agent@0.84.4` dist 为准。
> 事故事实来源：对 pi session `01a08091`（2026-09-08）的取证分析（下称「事故取证」），本文 §2 自包含复述其结论，无需读原始 session。

> 修订记录：
> - v1（2026-09-09）：首版。
> - v2（2026-09-09，R1 修复——主审 7 must-fix + 影响面审 4 must-fix，全部 suggestion 同批修）：
>   ①**D1 推翻重做**：v1 十正向方法核实为含 `interact`（chat 控制面已预留：message/close/cancel）不含 `steer`（能力位名）——原「新造 chatRound 方法」与 v1 既有面语义重叠，改推荐「扩展 interact + run 会话形态 + 反向载荷增量」，原方案记入被否谱系；
>   ②**D3 重写**：区分两个 cancel（run 域已有 CANCEL_SETTLE_GRACE_MS 等收敛杀链不改；chat 面 HostBridge.cancel 同步布尔才是发完即忘）+ runtime 升级阶梯补终点；
>   ③**D2 加域分类前置**：chat 轮 idle 稳态豁免出 no-progress 判定域；
>   ④**D4 熔断加正交封顶**：连发总次数独立上限为主判据；
>   ⑤**D4-a 注销时机收窄 + 分档对齐**：保持注册仅限「无进程驱动且任务未完成的 resumable record」；subagent/workflow 注册翻 process 档；
>   ⑥验收增补 A8/A9、跨版本 resume、A2 口径改行为断言；W3 补 ui-request-queue 消亡裁决；W1 负向用例方向核正。
> - v3（2026-09-09，R2 修复——主审 5 must-fix + 影响面审 3 must-fix，全部 suggestion 同批修）：
>   ①**D3 判据重写**：abort「受理 ack」在 runtime↔主 pi 面不可达（实装 pi 的 abort RPC 应答即收敛，收敛前无信号）——runtime 判据改 ping 快超时 × bridge 事件窗 × abort-pending 三信号组合；引擎面 ack 仅作协议层收敛语义；
>   ②**record 去向单一裁决表**（§3.2 表 3）：消解「杀引擎 → failed 终态化注销」vs「保持 resumable → 监督器接管」的双重裁决互斥；监督器「该唤醒」语义钉死为**通知主 agent 决策**（resume 或重派，主 agent 唯一决策者）——消双执行竞态；
>   ③**宿主重启分区规则**：in-flight → boot 直断 failed + 注销；already-resumable-idle（非 conversation）→ 重认领接管——消 A5 vs A8③/A9 互斥；
>   ④**chat mid-round bounded 责任落位**：D2 豁免理由改写（idle/GC 管 settled 后稳态，settled-watchdog 两段守护管中段/收尾）；watchdog 生产接线（arm/refresh/kill）随 W3 删件显式重接到协议事件流，认领 W2/W4；
>   ⑤**D4 熔断补验收场景 A10**（封顶停发/停发通知/恢复通道/defer 去重四断言）；
>   ⑥**翻档副作用三面处置**：fork 继承残留 → 读侧过滤（消费端口按 sessionId 排除，机制选型属本设计裁决）；idle-gc 兜底通道扩展（updatedAt 锚 + 归档补注销 + WorkflowRun store 纳入）+ 翻档同批生效约束；死亡窗口投递缺口 → core 注册对账 sweep（差集补发 unregister）+ A5 执行体指定；
>   ⑦「唯一发射点」改合法发射点枚举（5 处）；session 档机器死代码处置登记；normalizePendingType 默认语义偏好显式化；挂账量级与重审条件补齐；cold-resurrect 谓词补非 conversation 形态；D1-A 补关联键（recordId）/priority 落位。
> - v4（2026-09-09，R3 修复——主审 2 must-fix + 影响面审 2 must-fix，全部 suggestion 同批修）：
>   ①**三态判据状态源钉死为 record 级**：引擎 poolKey shared 单进程、`ensureConnected` 被动重建会重填镜像——「镜像整体置死」不能作持续判据（重建即翻转、指引静默不达）；改「resumable 未终态 且 无在途 run/无进程驱动」（run 终态 failed 即驱动死亡证据），镜像置死降为死亡事件触发信号；纳管模型显式化 = 死亡事件纳管、重建不解管；
>   ②**failed 通知与决策指引合并单条** + 监督器送指引前对账（已被新任务替代 → 撤销指引改送终止通知）——消「failed 后立即重派 + 指引送达后 resume」的双执行残径；A2 补该序列断言；
>   ③**读侧过滤端口补全**：registry rebuild（session_start 重建，已随 ext-simplify-12 删除）与 pending_notifications 工具读侧同加 sessionId 过滤（当时该面不走 countActiveFromEntries；终态读侧已改 countActiveFromEntries 对 entries 现算）；A9② 断言补；
>   ④§5 两处 idle-gc 锚残留 updatedAt → startedAt（对齐 D4 本体）；
>   ⑤阶梯统一三级 + 阶梯 1 补「耗尽 → 阶梯 2」迁移；session-pending list 口径（后代补杀）随删件消亡登记（止损语义由监督器该放弃承接，禁按旧语义迁移）；W4 显式认领 watchdog core 侧接线半边；
>   ⑥idle-gc 改「只归档不补注销，注销统一交对账 sweep」（消跨 session 写达域缺口与枚举身份缺口）；sweep 差集判据补全（终态集 ∪ 已归档/不存在——archived record 从内存移除、畸形条目对不上 record 同视同终态）；sweep 写法钉死 appendEntry 权威 + 尽力 emit（照 pending-reconcile 先例）+ rebuild 时序容忍（rebuild 已随 ext-simplify-12 删除，终态无此时序面）。
> - v5（2026-09-09，R4 修复——主审 1 must-fix + 2 suggestion；影响面审 0 must-fix，其 1 suggestion 同批修）：
>   ①**通知对账判定语义显式定义**（R4 击穿：「task/agent 同源引用」在 record 数据模型无承载字段——parentRecordId 是层级语义、rootSessionId 是隔离语义、task 是完整 prompt 非键）：改两级判定——高置信（同 rootSessionId + 同 agent 名 + **同 slug** + 看门狗窗内新建）→ 撤销指引改送终止通知；低置信（仅 agent 同名）→ 不撤销，指引内容自带豁免声明（「若已重新派发或不再需要，忽略本指引，原任务将在看门狗到期后自动终止」）。两失败方向显式登记（漏判 → 残余双执行，概率 = LLM 违约重派 × slug/task 改写致漏判，重审条件 = 实测双执行反馈 ≥1 例 → 升级 supersedes 显式引用方案；误判 → 原任务被错误终态化，危害轻——原任务本已无进程，仅损失 resume 可能）；被否谱系补 supersedes 字段方案（改工具契约面 + 依赖 LLM 合规传递，可靠性不优于启发式）；
>   ②三态表「该等」判据删「且事件流在推进」子句（事件流推进性归 settled-watchdog 中段守护管辖，监督器不重复判定——消两判据并集的第三态缝隙表述）；
>   ③场景三/A3 残留「ping×事件窗」术语 → 「快超时探测×事件窗」（对齐 D3 判据信号名）；
>   ④挂账量化句补精度：「idle-gc 锚窗 + 至下次 sweep 触发点（持续存活 session 内无中途触发点，至 session 重开收口）」；
>   ⑤W6 补 bash 跨 session 可见性断言（读侧过滤一刀同时改变 bash 未翻档类型的既有可见性——子 session goal 不再为父 session bash 任务 defer，钉成显式选择）。
> - v6（2026-09-09，实施期回写——W1-W3 落地 + 一致性审查批 1 收敛后）：正文仅补 D1 两段实施期声明（childSpawned 键语义 / cancel SIGTERM 受理形态，原文决策无一改动）；实施全记录见同名 impl-plan §5 偏差表全量与 §6 状态表。审查批 1（协议链 0 MF + 活性链 3 MF）7 findings 全部修复收口。

> 关联文档：`subagent-engine-protocolization.md`（v1 协议 SSOT；本文称「协议化设计」，其 §1 :121 裁决注记是本文的授权来源）；
> `subagent-engine-protocolization.impl-plan.md` §5/§7.3（keep-alive 偏差与 chat 域例外登记）；
> `engine/__tests__/conformance/H9-test-disposition.md`（H9 三测试处置登记）。

---

## §1 背景目标

**SCQA**

- **S（现状）**：引擎协议化 v1 已交付——NDJSON stdio 协议 **v1 = 10 正向方法（`initialize / probe / run / cancel / interact / read / listModels / validateModel / dispose / ping`，权威源 `packages/subagent-engine-sdk/src/protocol/methods.ts`；`steer` 是能力位名，不是方法）+ 8 反向通道（host/askUser、host/childSpawned、host/childStateChanged、host/handleReady、host/log、host/permission、host/poolResolved、host/streamDelta）**，pi/zcode 双引擎包独立进程化，run/read/probe/cancel 已全部 cli 化。v1 已为 chat 预留了控制面雏形：`interact` 方法（`InteractAction = message(interrupt?)/close(force?)/cancel`，失败码含 `engine_session_not_resumable`）+ run 的会话 gate 位 `conversation`；协议化设计 §5 A2 场景原文即「续聊（`interact message`）/ 冷续轮 resume / abort」。唯一残留：chat 域仍走 core 内建 inproc 直连（`engines/pi/` 残余 11 文件），缺的是**反向载荷面**——8 反向通道未含轮次生命周期事件 / record 状态回写 / 冷续 resume 锚点的承载。协议化设计 :121 裁决注记明确「该豁免非永久内置：协议 v1.x 载荷扩展落地后删除（排期待用户裁决）」——**用户已裁决排期（2026-09-09）**。同时，2026-09-08 真机事故（64 分钟空转 ~320 turn、烧掉 ~2.93M token）暴露了与 chat 域同源的**轮次活性治理**缺口。
- **C（冲突）**：v1 的正向面已够 chat 使用，反向面只有 run 域事件流，没有 chat 域的载荷面（ChatRoundTicket / 长驻轮生命周期 / 冷续 resume）。而已登记的三处偏差（keep-alive 编排留 core、H9 三测试行为面无人承接、HostBridge 消费面待对照）与事故暴露的活性缺口（goal 死循环、死亡误报、abort 落不了地），全部卡在同一片空白区：**「一个轮次（round）是否还该继续 / 是否已经结束 / 死了算什么」没有权威判定语义**。
- **Q（问题）**：如何用一次协议 v1.x 扩展同时 ①收掉 chat 域 inproc 豁免面，②把轮次活性定义成协议与编排的显式语义，使事故类故障（死循环烧 token / 异常死亡误报 completed / abort 落不了地被强杀）**结构性消失**而非逐点打补丁？
- **A（答案）**：协议 v1.x 增量激活既有面（interact + run 会话形态 + 反向载荷，major 不 bump）；chat 域迁入 `pi-subagent-cli`；轮次活性治理按「离问题最近的层」分三个落点——goal 扩展（无进展熔断 + 正交封顶）、core 编排层（轮次活性权威：record 去向单一裁决表 + 注销枚举点 + 对账 sweep）、runtime（abort 超时强杀前置活性判据 + 升级阶梯终点）；`engines/pi` 残余随迁移整体删除（含旧 143 误分类器），其语义由 conformance 新用例在新路径上钉住。

**系统是什么**（给不熟悉内部的读者）：xyz-agent 桌面端里，用户与 AI 的每一场对话（chat session）由一个 pi 进程承载；pi 进程里的扩展可以派「子代理」（subagent）——独立的 pi 子进程去干后台任务。2026-09-08 的引擎协议化把「跑子代理」的引擎从 core 内建模块改成了独立 CLI 进程（协议驱动），但**用户对话本身（chat 域）还在旧的内建直连形态**。本设计做两件事：把 chat 域也搬进独立引擎进程（收尾）；顺带修掉事故暴露的「轮次活性」语义缺口——即系统如何判断「对话/子代理还在干活的吗、卡住了吗、死了的话怎么上报」。

**设计目标**（从使用者体验倒推）

| # | 目标 | 视角 |
|---|------|------|
| G1 | chat 续聊域迁入引擎进程，`engines/pi` inproc 分支与残余 11 文件删除 | 接入者：pi 引擎单一形态（CLI 包），core 壳侧零内建引擎 |
| G2 | abort 落地语义显式化：「停止成功」由引擎上报的轮次终态事件定义；宿主升级阶梯有终点，不存在停不掉的会话 | 使用者：ESC 按下后一个 turn 内停止；极端情况下 GUI 给出显式「强制关闭」出口 |
| G3 | 异常死亡如实上报：引擎进程/轮次异常终止 → failed + 原因，禁止用最后一条文本冒充结果 | 使用者：主 agent 收到的子代理结局可信，「等待」或「重派」基于事实 |
| G4 | 无进展有界且等待有主：goal continuation 有熔断（空转轮数与连发总次数双维度封顶）；后台任务死亡后有监督器负责把决策指引送达人 | 使用者：不再出现 64 分钟空转烧 token；卡住的等待会升级为人可见的告警 |
| G5 | 宿主误判有防：abort 超时强杀前做多信号活性判据（ADR-0047「静默 ≠ 卡死」反向通道版），判据窗口值有实测依据 | 使用者：正常运行中的会话不被运维机制误杀 |
| G6 | 现有能力零回归：run 域协议行为、record/journal 数据、GUI 展示完全不变 | 使用者：迁移无感 |

**in scope**：
① 协议 v1.x 增量（`interact`/`run` 会话形态参数扩展、反向通道轮次生命周期载荷（轮次终态 / record 回写 / resume 锚点）、`conversation` gate 位路由 chat、版本兼容策略）；
② `pi-subagent-cli` 承载 chat 轮次（ChatRoundTicket 语义过协议、冷续轮 resume、idle 定时器归属）；
③ core 删 inproc 分支与 `engines/pi` 残余（含旧 143 分类器消亡处置、ui-request-queue 消费面终态、settled-watchdog 生产接线重接）；
④ keep-alive 编排归属重裁决 + H9 三测试承接回写（含生产面归属）；
⑤ goal 扩展：continuation 无进展熔断（双维度）+ 守卫依赖的注册语义修正（落点在 core，见 D4）；
⑥ runtime：abort 超时强杀前置活性判据 + 升级阶梯终点；
⑦ conformance 增量：引擎中途死亡 → failed 终态用例、chat 轮次 cli 形态场景（恢复协议化设计 §5 A2 blocked 项）、监督器三态用例、跨重启/对账/熔断用例。

**out of scope**（含否决理由与重审条件）：
① **pi 上游任何修改**（abort 不清 followUp 队列是 pi 语义——[MANDATORY] 不改 pi 源、不提 PR、不 fork；本文所有机制均为 xyz-agent 侧绕过实现）；
② **通知账本投递超时升级**：账本按设计跨 60 分钟完成 3 次投递（事故环 5），缺陷在通知**内容**谎报 completed——该根因由 G3 在源头消除。**残余迟滞的闭环依赖**：迟滞窗口内主 agent 的等待不再空转（D4-a 守卫 defer + D2 监督器「等待有主」），代价已被有界化。**重审触发条件**：账本未 ack 积压条目数或首条投递延迟回归超过 15 分钟（实施期落监控口径），则重开「升级投递」议题；
③ **给 agent 增加 `wait` 合法出口工具**（G4 落地后「干等」的前提——通知不可信 + goal 空转——已消除；扩 subagent 工具面收益不抵成本，登记为后续可选项）；
④ zcode 引擎（无 chat 域，不受本设计影响，仅 conformance 回归覆盖）；
⑤ 协议的网络/远程形态（沿协议化设计 out-of-scope 不变）。

---

## §2 现状与问题分析

**本章结论：事故不是单一 bug，而是「轮次活性语义」在三层各自缺失、又互相假设对方拥有它导致的系统性死锁；协议 v1 正向面已为 chat 预留了控制（interact）与能力位（conversation），唯独反向载荷面缺席，使 chat 域无法享受协议化的故障隔离与语义显式化。**

### 2.1 事故取证复述（2026-09-08，session `01a08091`）

一次后台文档同步子代理（下称 u4）被宿主 infra 连带击杀后，主 agent 陷入 64 分钟空转（~320 turn，2.93M token），最终用户手动介入才终止。完整因果链六环：

| # | 环节 | 关键事实 |
|---|------|---------|
| 1 | **goal continuation 死循环** | goal 扩展在每次 turn 结束（agent_end）时发 continuationPrompt（`deliverAs:"followUp"`）拉起新 turn。守卫二道：tokenDelta>0 去抖（任何回复都满足，形同虚设）+ pending 注册表计数>0 时跳过。u4 从注册表注销后计数归零，守卫恒放行 → 每轮注入「Keep working」，主 agent 每轮回一句「等待 u4」→ 循环。**无任何无进展熔断**（stall 自动终态分支已被删除） |
| 2 | **u4 真死因**：宿主重启连带击杀 | runtime 进程当晚反复死亡/重启（boot→9s→SIGTERM 共 6 次）。新 runtime 实例启动时的孤儿扫描把上一实例的 **9 个子代理全部 SIGTERM（exit 143）**；u4 的 resume 又因主 pi 被强杀（见环 6）被 kill-on-disconnect 连带击杀 |
| 3 | **死亡误报 completed** | 旧分类器（`engines/pi/session-runner.ts:2667-2677`）把「被信号终止」一律归入 `success=true`（注释假设信号只来自 maxTurns 达限 kill）→ u4 的中途旁白（以冒号戛然而止的文本）被当成 Result，通知内容谎报 `outcome:"completed"` |
| 4 | **双状态源打架** | pending 注册表（进程活性）说「u4 已结束」（15:16:33 注销），record 存储（running-resumable 逻辑任务）说「还在跑」（`subagent list` 显示 active 直到 16:16:57 finalize）。两层都是刻意设计，但 goal 守卫只消费前者。注册表自身还有两处静默致盲源：session 档注册带 **1h TTL**、跨 session 重建时补注销（`pending-notifications/src/state.ts` 的 1h TTL 常量 + U4 清理）——跑超 1 小时或跨重启的子代理注册会被静默清除，守卫同样失明（该 TTL 机器已随 ext-simplify-12 整体删除） |
| 5 | **通知迟滞但机制无错** | 未 ack 账本跨 60 分钟完成 3 次投递（15:16:33 → 15:42:52 → 16:16:57）——按设计工作；期间主 agent 上下文无 u4 消息，「等待」是其局部理性选择 |
| 6 | **abort 落不了地 → 宿主误判强杀** | pi 的 `abort()` 不清 followUp 队列（上游语义，不可改）。goal 循环中用户 ESC → runtime 向主 pi 发 abort RPC（`CMD_TIMEOUT_MS=60_000`，`rpc-client.ts:133`）→ 60s 无响应 → message-dispatcher 误判「pi event loop frozen」→ **强杀主 pi**（`message-dispatcher.ts:411`）→ u4 resume 被 kill-on-disconnect 连带击杀。事后证实主 pi 并未冻结（循环中 15:41:59、15:42:42 还在正常执行工具调用）——是 abort 语义与 followUp 循环对冲，永不到达 idle。实装 pi dist 印证：abort RPC 的应答即收敛（`rpc-mode.js:329-331` → `session.abort()` = `agent.abort()` + `waitForIdle()`）——**该面上不存在「已受理未收敛」的中间信号**，60s 超时只能区分「收敛了/没收敛」，不能区分「忙/死」 |

**为什么说是缺陷而非正常流程**：四个断层——① goal 守卫存在已知盲区（「等待注册表之外的东西」不被覆盖；注册表自身 TTL/重建还会放大盲区），且注释自己写明了死循环风险却只靠 pending 计数防；② 外部 SIGTERM 与自家 maxTurns kill 共用同一「视为正常完成」分支；③ 进程活性与逻辑任务两层生命周期都合理，但没有一层拥有「这个轮次还该继续吗」的权威答案，且注销发射分散在 ≥3 处（`finalize-record.ts:257/:332`、`subagent-service.ts:761`）、无单点语义；④ 系统提示词禁止轮询（"Do NOT poll — completion is auto-notified"），通知通道失效时 agent 只能原地等待，goal continuation 又强制它 keep working——两个指令对冲，收敛到最小代价行为（每轮回一句「等待」）。

### 2.2 协议与编排现状（代码锚点）

**协议 v1 面**（`packages/subagent-engine-sdk/src/protocol/`）：
- 正向方法 10 个：`initialize / probe / run / cancel / interact / read / listModels / validateModel / dispose / ping`。
- `interact` 契约（`contract-types.ts:207-212`）：`InteractAction = { kind:"message", payload, interrupt? } | { kind:"close", payload?{force} } | { kind:"cancel" }`；失败码含 `engine_session_not_resumable`。interrupt:true = steer（抢占）/缺省 = followUp（排队）。
- `EngineHandleData`（`:117`）：handle 持久化形态，pi 定位键 `{ recordId?, sessionFile? }`——冷续 resume 的锚点载体已存在。
- 反向通道 8 个：`host/askUser`、`host/childSpawned`、`host/childStateChanged`、`host/handleReady`、`host/log`、`host/permission`、`host/poolResolved`、`host/streamDelta`。`host/streamDelta` 载荷含 `runId`（run 域事件关联键）。**无轮次生命周期事件、无 record 状态回写载荷**。
- 版本协商：`ENGINE_PROTOCOL_VERSION = 1`，core 支持 `>=1 <2`，越界报 `engine_protocol_mismatch`（按 major 边界协商，无 minor 位）。
- 错误表已有 `engine_crashed`（进程意外退出 → 在途 run 失败 + stderr 尾 400 字符；下次 run 重建，3 次指数退避）——run 域的「死亡如实上报」协议面**已存在**，chat 域缺同等物。
- **run 域 cancel 已实装等收敛杀链**：`remote-engine.ts:211-225`（cancel 帧 → 等 `CANCEL_SETTLE_GRACE_MS` 收敛 → 未收敛走杀链兜底 `killAll`；SDK 常量 = 3000ms，`engine-client.ts:523-525`）。**chat 面的 cancel 是另一个东西**：`HostBridge.cancel(id): boolean`（`host-bridge.ts:58`）同步布尔签名 = 发完即忘，无收敛等待——这才是「abort 落不了地」在 core 侧的形态。

**chat 域 inproc 现状**（`packages/subagent-core/src/execution/engine/`）：
- `host/host-bridge.ts` 定义 `HostChatRoundTicket`（五字段：`record / opts / signal / priority / stream`），头注裁定：executeAndAwait / ChatRoundTicket / record 状态回写 / **idle+activate lock 定时器**归 HostBridge（core）；sendPromptCommand / EPIPE 兜底 / **冷续轮 resume**（stdin-writer）归 pi 包。
- `engines/pi/` 残余 11 文件 = chat 专用面（`pi-engine.ts` 及其依赖）+ run 域死残留（`session-runner.ts` 等）。生产侧**真实** deep import 仅两处：`host/pi-host-binding.ts:19-20`（chat 改线对象）与 `execution/ui-request-queue.ts:22-24`（type import `SessionRunnerContext`/`ExtensionUiRequest` + **值导入** `respond`）——后者 cli 形态下 UI 请求改走协议 `host/askUser` 反向通道，队列面临消亡/改线裁决（D5/W3）。其中 `session-runner.ts:2667-2677` 即事故环 3 的旧 143 误分类器。
- **settled-watchdog 生产接线现状**：两段守护（中段 no-progress 静默 → kill + 该轮失败终态化；收尾硬顶）的 arm/refresh 事件接线在待删的 `session-runner.ts`（stdout pump 刷新活跃戳），arm 点之一在存留的 `subagent-service.ts` deliverMessage——**删件若不同批重接，中段守护随之失效或误杀**（§3.2 D2/W3 显式处置）。

**活性编排现状**：
- goal 扩展（`extensions/universal/goal/src/adapters/event-handlers/agent-end.ts`）：ESC 守卫（:56，`ctx.signal?.aborted` → 不发 continuation）、tokenDelta 去抖（:163）、pending 守卫（:177，`countActiveFromEntries` 只读 session entries 里的 pending 注册项）；defer 分支每次 agent_end 都 `ctx.ui.notify`「Goal waiting for N background task(s)」（:188，无去重）。**无无进展熔断**——`report_blocked` 只是提示词指引（`goal-control-adapter.ts:342`，靠 LLM 自觉调用）。
- **pending 注册表分档（历史机制，已消亡）**：翻档前由分档常量定义两档——subagent/workflow=session 档、bash=process 档。session 档 = 1h TTL + 跨 session（fork/switch）补注销 + shutdown 标 cancelled；process 档 = 无 TTL、跨 session 续存、shutdown 不动。**subagent 曾被分在 session 档——与后台子代理的真实生命周期（跨 session 存活、可跑超 1h）错位，是守卫盲区的既有潜伏源**（W4 翻档修正；分档常量与 session 档机器已随 ext-simplify-12 整体删除，三类型恒 process 档成为代码自然状态）。翻档前该分档的 U4 补注销承担着第二个承重角色：**子 session fork 继承父级 register 残留的中性化**（子 session 文件复制父 entries，session_start 重建时补注销抵消——`session-pending.ts:13-14` 头注自证）；`countActiveFromEntries` 无 sessionId 过滤（`state.ts:147-177`），消费方均不传 types 过滤。
- core 编排：`settled-watchdog.ts`（中段 no-progress + settled 段双看门狗）与 `session-pending.ts` 的「pending:register 差集判活 + no-progress timer + notifier steer 唤醒」编排**留在 core**（impl-plan §5 W7 行登记的偏差——run 域 cli 化后该编排的协议表达未迁移）。
- H9 三测试（`conformance/H9-test-disposition.md`）：keep-alive-no-progress / settled-watchdog / timeout-integration 行为面随偏差登记，pi 包现无等价测试。
- runtime：`message-dispatcher.ts:411` abort RPC 60s 超时 → 直接 force-destroy（无活性前置检查、无升级阶梯）。

### 2.3 根因综合

**「轮次活性」的判定权分散且互相假设**：

```
 goal 扩展            core 编排层                  runtime
┌──────────────┐   ┌────────────────────┐   ┌──────────────────┐
│ 该继续催吗？   │   │ 任务活着吗？          │   │ 会话冻结了吗？      │
│ 看 pending 计数│   │ 进程活性→pending(有TTL)│   │ 等 abort RPC 60s   │
│ + tokenDelta  │   │ 逻辑任务→record       │   │ 超时=frozen→强杀    │
│ （无熔断）     │   │ 注销发射分散 ≥3 处     │   │ （无活性检查；       │
└──────┬───────┘   └─────────┬──────────┘   │  应答即收敛，       │
       │ 消费了进程活性层，      │ 两层都对，但无一层回答   │  无中间信号可判）    │
       │ 看不到 resumable；     │ 「该等 / 该唤醒 / 该放弃」│──────────────────┘
       │ TTL/重建再削一刀        │                        ▼
       ▼                     ▼                     误杀 + 连带击杀
   死循环驱动源            守卫盲区 + 误报 completed
```

协议 v1 正向面已为 chat 预留控制面（interact）与能力位（conversation），唯独**反向载荷面**（轮次生命周期 / record 回写 / resume）缺席——chat 域因此留在 inproc，享受不到协议化的故障隔离（协议化 G4）、错误表（`engine_crashed`）与语义显式化；而事故的六环全部发生在「轮次」这个协议盲区里。

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**场景一（正常续聊，迁移无感）**：用户在 GUI 与 AI 对话 → 消息经 runtime → core 经协议 `run`（首轮/冷续）与 `interact`（续聊/插话/关断）把轮次交给 `pi-subagent-cli` 引擎进程 → 流式回复经 `host/streamDelta` 回流 → 轮次终态经新增反向载荷回写 record → GUI 照常展示。用户看不到任何变化（G6）；引擎进程崩溃时该会话报错可重开，不拖死其他会话（G1 带来协议化 G4 的故障隔离红利）。

**场景二（事故重演——子代理被杀）**：后台子代理 u4 在 LLM 请求中途被杀 → 引擎如实上报 run 终态 `failed`（原因：进程被信号终止）→ record **保持 resumable**（§3.2 表 3：宿主存活 × 进程死亡 → 保持 + 监督器接管）→ 主 agent 收到**单条合并通知**（failed 如实 + 「已接管，指引稍后，在此之前勿对该任务重派」契约）→ 监督器在窗口内送达决策指引（resume 原任务或重派；若主 agent 已提前重派了承接任务，对账撤销指引改送终止通知）→ 主 agent 执行其一，同一任务语义全生命周期只有一份在执行。goal 守卫看到的注册状态诚实，不进入空转循环；即使主 agent 仍选择等待，goal 熔断在空转轮数或连发总次数任一封顶后退避、停发并通知用户（G3+G4）。

**场景三（ESC 落地，含极端）**：用户在 goal 驱动的长任务中按 ESC → 当前 turn 中断 → goal ESC 守卫不再排队 → pi 到达 idle → abort RPC 在秒级返回「已落地」（以引擎上报的轮次终态事件为准）→ 无强杀（G2）。若 pi 活跃但 abort 迟滞（如卡在长工具调用）：runtime 按快超时探测×事件窗判据判定「活着」→ 有界重试 + 上报迟滞；仍不收敛 → GUI 弹出显式「强制关闭」→ 用户确认后 force-kill + record 如实 failed（阶梯有终点，不存在永久停不掉）。若 pi 真冻结（快超时探测无响应 + 事件窗静默且超探针窗口）：runtime 强杀是正确行为，record 如实标 failed（G5 的判据只放行「活着」的会话）。

**场景四（宿主重启）**：runtime 崩溃/重启 → 引擎进程 stdin EOF → 自灭（进程组收割兜底）→ boot 分区扫描（§3.2 表 3）：重启时 in-flight 的 record 直断终态化 failed 并注销（经对账 sweep 保证注销落盘），重启前已 idle-resumable 的存量任务由监督器重认领继续管辖 → 下次 run 冷启动重建 → pidfile 三条件清扫防误杀 → 注册表无「指向已终态 record」的残留挂账。

### 3.2 多方案对比

#### D1：chat 轮次的协议表达

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|------------|------|
| **A（推荐）：激活既有面 + 反向载荷增量，major 不 bump**。首轮/冷续 = `run` 会话形态（gate 位 `conversation` 已存在，core 路由 chat 前同步 gate）；续聊/插话/关断 = 既有 `interact`（message/close/cancel 语义与 chat 轮次一一对应）；**v1.x 真正的新增 = 反向通道载荷扩展**：轮次生命周期事件（round settled/idle——D3 落地语义与 record 回写的载体）+ resume 锚点载荷（`EngineHandleData` 已有 pi 形态） | 与 v1 既有哲学完全同构——控制面 v1 已预留（A2 场景原文），本方案只是补齐它等待的反向载荷；旧引擎包共存语义清晰（无 `conversation` 位 → chat 请求 gate 同步拒 + 既有恢复指引文案）；第三方引擎按需实现 | 中：反向载荷帧设计 + interact/run 参数扩展 + conformance 增量 | 轮次生命周期事件的帧边界需仔细——放 impl-plan |
| B（被否，v1 原方案）：新造 `chatRound` 正向方法 | —— | —— | **否**：v1 已为 chat 预留 `interact` 控制面与 `conversation` gate 位，再造方法 = 形式新造、语义重复（假差异）；且上游 A2 验收场景已围绕 `interact message` 写定。**被击穿记录**：v1 版基于错误的十方法清单（把 `steer` 当方法、漏 `interact`）设计——事实核正后原推荐不成立 |
| C（被否）：major bump 到 v2（chat 域作为 v2 专属面） | 版本语义粗暴但清晰 | 低 | **否**：run 域协议零变化却被连带升版本，所有引擎包（含 zcode）被迫同发；共存语义反而变差 |
| D（被否）：不加控制面，复用 `run`+`resume` 参数模拟长驻轮 | 零协议增量 | 低 | **否**：chat 轮与 run 轮生命周期语义根本不同（长驻 / 多轮 / idle 定时器 / 冷续），塞进 run 语义会搅浑 run 域错误表与终态语义——「形式同构、语义不同构」的假差异 |

**推荐 A**。被否谱系：B（语义重复 + 与上游 A2 场景冲突——R1 击穿）、C（连带升版本伤及无关引擎）、D（语义假同构）。

**五字段过协议映射（R2 补齐）**：`HostChatRoundTicket` 五字段中——`record` 随 run/interact 参数承载（resume 锚点 = `EngineHandleData.sessionRef`，pi = `{recordId?, sessionFile?}`）；`opts`/`signal` 映射为 run/interact 参数与 cancel/interact close 语义；`stream` 经既有 `host/streamDelta`（载荷含 `runId`，runId 由 core 分配，跨域分帧天然隔离，无通道碰撞）；**关联键裁定**：`interact` 发起的续聊轮无独立 runId（`InteractParams/InteractResult` 均不含），其流式 delta 与生命周期事件统一以 `recordId`（经 `handle.sessionRef`）关联——W1 帧设计以此为准，不再临场选择；**`priority` 不进协议**（run 域先例：wire 上不承载，留 core 侧调度）。**实施期补充声明（v6）**：既有通道 `host/childSpawned` 对 chat 形态同样以 `recordId` 键上报（`recordId: chatRecordId ?? runId`，`chatRecordId` 缺省回落 runId 兼容 run 域）——record 锚定回写所需，镜像记账按 record 归属。

**cancel 受理形态声明（v6，审查 1a-S7）**：chat 轮 cancel 的「受理」= 直接 SIGTERM（manifest `interrupt: "kill-only"` 位不变），非 inproc abort 的「轮中断、进程存活」形态——cancel 后续聊经 run chat+resume 冷续续接（session 文件锚点不丢）。D3「record 如实标 failed」语义不变（failed 相位 `engine_round_aborted` 分诊）。rpc abort 收敛形态登记为可选演进，重审触发 = 用户反馈 cancel 后会话体验问题。

#### D2：keep-alive / no-progress 编排的归属（已登记偏差的裁决）

背景：旧 runSpawn 的「pending:register 差集判活 + no-progress timer + notifier steer 唤醒」留在 core 未随 cli 化迁移；chat 域迁移后该编排覆盖面必须重裁。

**前置 1：轮次域分类**（判定域先收窄，再谈三态）——监督器的判定域 = **run 域一次性任务（resumable 且无进程驱动）+ workflow 域 resumable run**。**chat 域长驻轮明确豁免出 no-progress 判定域**。chat 域活性的管辖分层（R2 精确化，豁免 ≠ 无人管）：
- **settled 之后**（轮已收敛、等用户输入的稳态）：既有 idle+activate lock 定时器与 GC 判据管辖（host-bridge 头注裁定的 core 职责）；
- **中段/收尾**（轮进行中、进程活但无产出）：**settled-watchdog 两段守护**管辖（中段 no-progress 静默 → kill + 该轮失败终态化；收尾硬顶）。其生产接线现状在待删的 `session-runner.ts`——W3 删件时**必须同批重接到协议事件流**（arm 点 = 轮开始；refresh 源 = streamDelta/轮次生命周期事件；kill/终态路径 = `interact close force` 或对齐 run 域杀链），认领单元 W2+W4（§5）。豁免只意味着「监督器不重复管」，不意味着无界。

**前置 2：record 去向单一裁决表**（消解 R2 指出的双重裁决互斥——同一触发「failed 终态化注销」与「保持 resumable 接管」只能有一个答案）：

| 触发 | record 处置 | pending 注册处置 | 通知与决策权 |
|------|------------|----------------|------------|
| **引擎/子进程死亡，宿主（core）存活**（in-flight 任务） | run 终态 **failed**（如实上报，禁止 completed 谎报），record **保持 resumable**（session 文件在盘，逻辑任务可续） | one-shot/workflow 形态**保持注册** → 监督器接管 | **failed 通知与决策指引合并为单条通知**（内容 = failed 如实 + 「已接管，将送达 resume/重派决策指引；指引到达前勿对该任务重派」显式契约——消除双通知时序窗口，R3）——**主 agent 是唯一决策者，监督器不自动复活任务**；看门狗到期仍无决策/无收敛 → failed 终态 + 注销 + 终止通知（此时可重派） |
| **宿主重启，boot 分区扫描：in-flight**（重启时有进程在跑或有活跃事件流） | **boot 直断 failed**（会话上下文已断，复活无主） | 注销（经对账 sweep 保证落盘，见后） | GUI/主 agent 明确报「任务因重启中断」 |
| **宿主重启，boot 分区扫描：already-resumable-idle**（重启前已 resumable 无进程，**非 conversation 形态**） | **保持 resumable**，监督器重认领继续管辖 | 注册存续（process 档） | 监督器三态继续 |
| **conversation/chatMode 形态**（任何触发） | 轮终 idle（现状不变） | 进程退出即注销（现状不变） | 不入监督域 |

**判定域内的三态判定**（对表 3 中「保持注册 → 监督器接管」的每一笔）。**判据状态源钉死为 record 级**（R3 核正：pi 引擎 poolKey 恒 'shared' 单进程服务所有会话，`ensureConnected` 被动重建——任一会话的下个请求即触发、退避 1s/2s/4s——会把「镜像整体置死」重填；若以镜像为持续判据，重建即翻转、决策指引静默不达）：

| 态 | 判据（record 级状态源） | 动作 |
|----|------|------|
| 该等 | 该 record 有在途 run / 有进程驱动（事件流推进性归 settled-watchdog 中段守护管辖——重接后轮覆盖含监督器域 resume 轮，impl-plan 显式化；监督器不重复判定） | 不干预 |
| 该唤醒 | **resumable 未终态 且 无在途 run / 无进程驱动**——run 终态 failed 即「驱动死亡」的证据，不随引擎进程重建翻转（镜像置死仅作死亡事件的触发信号，不作持续判据） | **通知主 agent 决策**（见下「通知对账」；经 notifier steer 通道——与原 keep-alive「唤醒」语义同源：唤醒的是主 agent 的注意力，不是自动复活任务） |
| 该放弃 | 看门狗到期（决策指引无响应且无收敛信号） | record 终态化 failed + 注销（走合法发射点枚举）+ 终止通知 |

**纳管模型**：死亡事件纳管（run failed / 引擎 exited 事件把 record 纳入监督域）——**重建不解管**（引擎进程重建不解除已纳管 record 的监督，监督器按 record 级状态持续判定直至终态或放弃）。

**通知对账（送指引前查替代——R3 增补，R4 钉死判定语义）**：即使合并单条通知，主 agent 仍可能在收到指引前合法地重派了新任务（它是唯一决策者，重派不被禁止）。record 数据模型**不存在**重派关联字段（`parentRecordId` 是 subagent 层级语义、`rootSessionId` 是 session 隔离语义、`task` 是完整 prompt 非关联键）——对账判定为显式定义的两级启发式：
- **高置信替代**：同 `rootSessionId` + 同 agent 名 + **同 slug**（≤35 字符短标签，重派同任务大概率同 slug）+ 决策指引看门狗窗内新建 → 撤销指引，改送「原任务已被新任务替代」终止通知 + 对原 record 走该放弃路径（终态化 + 注销）；
- **低置信**（仅 agent 同名）：不撤销指引，但指引内容自带豁免声明（「若你已重新派发或不再需要此任务，忽略本指引；原任务将在看门狗到期后自动终止」）——把残余决策交还唯一决策者，且不诱导冲突动作。
**两失败方向登记**（四要素）：①漏判（重派改写 slug/task 致高置信不命中）→ 残余双执行；概率 = P(LLM 违约无视契约重派) × P(改写致漏判)，危害有界（双执行最坏 = 一份任务的重复执行成本 + goal 熔断限损空转方向）；重审触发 = 实测双执行反馈 ≥1 例 → 升级「supersedes 显式引用」方案（subagent 工具参数/record 增显式替代关系字段）。②误判（无关任务撞 slug）→ 原任务被错误终态化——危害轻（原任务本已无进程驱动，仅损失 resume 可能），通知称「已被替代」失实为可接受文案瑕疵。**被否**：supersedes 显式引用作为主方案（改 subagent 工具契约面 + 依赖 LLM 合规传递，可靠性不优于启发式，登记为升级路径而非首发）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 |
|------|--------------|------------|------|
| **A（推荐）：core 编排层持有「轮次活性权威」** | 活性判定需要跨源信息（record 状态 + 引擎进程镜像 + 事件流），只有 core 同时看得到三者；协议化设计的「镜像失效语义」（引擎退出 → spawnedChildren 镜像整体置死）已是 core 侧事实；域分类后判定域收窄、机制更薄 | 中：监督器改造 + 协议事件订阅面 | 监督器自身成为新复杂度点——用 A8 三态验收场景钉住 |
| B（被否）：下沉引擎包 | 引擎自治，core 更薄 | 高 | **否**：引擎看不到 record 全局与宿主进程拓扑；且引擎死亡时监督器随葬——恰好监督不了最重要的场景（自亡上报） |
| C（被否）：删除（维持 W7 现状：agent_end 即终态，不判活） | 最薄 | 低 | **否**：事故环 1/4 证明「无判活」正是死循环与误报的土壤；resumable 形态下 agent_end ≠ 任务终态，删除判活 = 把缺口固化 |

**推荐 A**。被否谱系：B（监督者随葬悖论）、C（固化事故缺口）、v2 版「无 record 去向裁决表的双轨处置」（同一触发两套验收互斥——R2 击穿）、v1 版「无域分类的三态全域判定」（把 chat idle 稳态误判死——R1 击穿）。

**注销的合法发射点枚举**（R2 核正——「唯一单点」与两处现状合法发射点冲突，改枚举制；原则 = **进程退出本身永远不是注销理由，注销必须随下列语义点触发**）：
1. subagent record 终态化（finalizeRecord 路径，含监督器放弃）；
2. chatMode 轮末 idle（`doFinalizeRoundToIdle`，现状保留——record 非终态但轮已收口）；
3. workflow run 终态迁移（transition("done") 路径，现状保留）；
4. 监督器显式放弃（终态化 + 注销同批）；
5. **注册对账 sweep 补发**（见下）。
impl-plan 盘点现存 ≥3 处发射点并按此枚举收敛。

**注册对账 sweep（死亡窗口投递缺口的补发通道——R2 增补，R3 钉死判据与写法）**：注销经进程内 pi.events appendEntry 落盘，进程死亡时发射源消失（`notify-host.ts:80-88` `getPi()` 为 null），注销 entry 可能永久缺位 → goal 守卫幻 defer、`pending_notifications` 工具虚报活跃。补发机制：**core 侧对账 sweep**——session reattach / session_start / 监督器启动时，对「本 session 的 register entry × 对应 record 状态 ∈ 终态集 ∪ record 已归档/不存在」的差集补发 unregister（idle-gc 归档后 record 从内存移除 `record-store.ts:464`，照「查不到即补注销」判据兜底链才闭合；畸形条目对不上任何 record 同样视同终态补注销）。**写法钉死**：直接 appendEntry 权威落盘 + 尽力 emit 作幂等兜底（双保险）——不经 bus emit 作权威（`base-tool-enhance/src/background/pending-reconcile.ts:10-16` 已完整论证扩展加载顺序无保障；该段论证的 listener registry 前提已随 ext-simplify-12 删除——pending-notifications 无内存视图，emit 到达 listener 后按 entries 现算发现已注销即幂等跳过，appendEntry 权威结论仍成立，现依据：appendEntry 不依赖 listener 存活、同步入账）。终态无内存视图、无 registry rebuild：appendEntry 同步入账即无不一致窗口，进程死亡窗口的注销缺位由本 sweep（session_start 等触发点）补发收口。与 cold-resurrect 扩展同面实施（扩展自身不能 import core，必须在 core 侧做）。

#### D3：abort 落地语义（协议 + runtime 双落点）

**事实澄清（R1 核正）**：存在两个 cancel——① run 域 `cancel` **已实装**「受理 → 等 `CANCEL_SETTLE_GRACE_MS`（3s）收敛 → 杀链兜底」分级（`remote-engine.ts:211-225`），本设计**不改它**；② chat 面经 `HostBridge.cancel(id): boolean` 同步布尔 = 发完即忘，无收敛等待——这才是缺口。

**协议层（改造点仅 chat 面）**：chat 轮次的收敛对齐 run 域既有分级——abort 受理后等待目标轮次的终态事件（D1-A 新增的轮次生命周期载荷），超 `CANCEL_SETTLE_GRACE_MS` 未收敛走与 run 域同构的杀链升级；record 如实标 failed。引擎面存在受理确认（`InteractResult{delivered}` / cancel 应答），但它活在主 pi 内 subagent-core 面，**runtime 不可观测**——只作协议层收敛语义，不作 runtime 判据（R2 核正：runtime↔主 pi 面的 abort RPC 应答即收敛，无中间信号）。**不改 pi**——followUp 循环治理归 goal 扩展（D4）。

**runtime 层（abort RPC 超时路径，`message-dispatcher.ts:411`）——三信号判据 + 三级阶梯**（每级都有终点、级间迁移闭合，不存在无界分支）：

判据信号（全部为该面可观测，R2 核正后）：
- **轻量 RPC 快超时探测**：RPC 事件循环活性——复用既有 `FAST_TIMEOUT_MS`（10s，`rpc-client.ts:136`）快超时模式发毫秒级内存快照类命令（如 `get_state`；该面无名为 ping 的方法，不新造）；pi 忙于 turn 时 RPC 循环仍应答，事件循环真冻结时超时无响应；
- **bridge 事件窗产出**：会话事件流近窗是否有产出（窗值不由本设计拍定——实施期门 P3 实测三类会话分布后定窗；bridge 事件只在 delta/tool 调用边沿产生，LLM 请求等待期可长静默，裸事件新鲜度单独使用会误杀）；
- **abort-RPC pending 状态**：当前 abort 是否仍在等收敛。

阶梯：
1. **快超时探测有响应**（无论事件窗）→ pi 活、abort 在收敛中或排队 → 有界重试（建议 2 次）+ 上报「abort 迟滞」；**重试耗尽仍不收敛 → 进入第 2 级**；
2. **探测无响应 + 事件窗有产出** → pi 活但 RPC 层饿死（事故形态：循环中工具调用正常、abort RPC 饿死）→ 走用户显式强制关闭：GUI 呈「会话无法响应停止请求」+ 显式动作 → 用户确认后 force-kill + record 如实 failed + 明示后果；
3. **探测无响应 + 事件窗静默超窗（P3 定值）** → 真冻结 → 直达强杀（现状行为的收窄保留，对真冻结仍秒级生效）。

**被否谱系**：仅 runtime 检查不改协议（治标）；仅协议不做 runtime 层（漏真冻结场景）；v1 版「活跃 → 无界二次 abort」（无终点——R1 击穿）；v2 版「abort 受理 ack」判据（该面不可达，活跃但 LLM 静默的会话会被误路由到直杀——R2 击穿）。

#### D4：goal 熔断与守卫依赖的注册语义修正

两个互补机制（非二选一，职责不同）：

**熔断（goal 本地，治理「空转无界」）——双维度封顶**：

- **主判据：continuation 连发总次数独立上限**（单个 goal 激活周期内，continuation 累计发出次数封顶，默认 50、可配置）——封顶必停发 + 显式通知用户（复用现有 notify 通道）+ goal 保持 active（不擅自终态）。该维度**与「是否调工具」正交**，不可被任何目标行为绕过（R1 击穿记录：v1 版「任何一轮有工具调用即清零」可被「每轮调一次 `subagents list` + 回一句等待」打成永不熔断）。
- **辅判据：无进展退避**——连续 N 轮（默认 5）无工具调用且 tokenDelta 低于阈值 → continuation 间隔 ×2 递增；恢复条件 = 出现真实工具调用或 tokenDelta 越阈值（清零退避计数，但**不重置主判据总次数**）。
- **误伤量化**：纯文本迭代型 goal 任务（长文起草/润色）每轮合法无工具调用 → 受辅判据退避拖慢（第 5 轮起间隔翻倍）、受主判据总量约束（50 次 ≈ 正常长任务轮数量级；超限停发后恢复通道 = 用户 `/goal resume` 或通知内指引）。参数均可配置；登记重审条件：真实使用中合法任务被主判据截停的反馈出现 ≥2 例 → 重校准上限或引入内容增量判据。
- **defer 通知去重**：守卫 defer 分支的「Goal waiting for N…」通知改为状态变化才发（计数集合变化或首次进入 defer），消除重复通知量（现状每轮 agent_end 都发 :188）。

**守卫依赖的注册语义修正（落点在 core，goal 扩展零改动）——收窄 + 分档对齐 + 枚举发射 + 对账**：

- **保持注册的范围收窄**：按 §3.2 表 3 执行（one-shot/workflow resumable 未终态 → 保持注册交监督器；conversation → 进程退出即注销现状不变）。
- **分档对齐**：`subagent`/`workflow` 从 `session` 档翻 `process` 档（对齐真实生命周期；顺带修复既有潜伏缺陷——session 档 1h TTL 与跨 session 补注销会把长任务/重启后的注册静默清除 → 守卫失明，正是事故环 4 的放大器。驱动翻档的分档常量已随 ext-simplify-12 删除，翻档后语义成为无条件代码自然状态）。**翻档的三个连带面（R2 处置）**：
  1. **fork 继承残留 → 读侧过滤**（机制选型属本设计裁决）：子 session fork 继承父级 register，现状靠 U4 补注销中性化，翻档后残留永久留存。**受影响读取路径共三条，统一按「register entry 的 sessionId ≠ 当前 session → 跳过」过滤**（`PendingEntry` 已携带 sessionId 字段；R3 核正端口全集）：①`countActiveFromEntries` 差集口径（goal 守卫消费）；②subagent-workflow 后代判定口径；③**pending-notifications 的 registry rebuild（session_start 重建路径）与 `pending_notifications` 工具读侧**——原状态：该路径不走 `countActiveFromEntries` 而读内存 registry（`index.ts:264`），跨 session 检测仅 session 档生效（`state.ts:236-249`），翻档后 fork 残留会直接入 registry → LLM 投影面永久虚报活跃。**registry/rebuild 已随 ext-simplify-12 整体删除**：工具读侧改 `countActiveFromEntries` 对 getEntries() 现算（`pending-notifications/src/index.ts:219-222`），process 档同样按 sessionId 基准过滤，投影虚报随删除消亡。一刀三口同时修复守卫幻 defer、后代判定污染与投影虚报，无特殊清理路径。
  2. **U3/U4 清理职能移交**：替代通道 = ①正常路径：合法发射点枚举（含对账 sweep）；②监督器重启重认领（cold-resurrect 扩展：启动扫描「resumable 且无进程驱动**且非 conversation 形态**」record 重新接管——谓词与表 3 同源）；③**idle-gc 扩展兜底**（R2 核正：现 idle-gc 判据 `idleSince` 仅 chatMode 轮末赋值、命中仅 archive 不发注销、workflow 不在其 store——对翻档类型不成立，必须扩展）：无 `idleSince` 的 resumable record 以 `startedAt`（创建时确定，`types.ts:438`）为锚——兜底定位为 30 天量级终态归档，创建时锚的精度损失在该量级可接受；**只归档不补注销**（R3：归档跨 session record 时 appendEntry 只达当前 session entries，补注销写达域无效；且 archive 不走 finalizeRecord，无发射枚举身份）——被归档 record 的注册由对账 sweep 统一收口（判据含「已归档 = 视同终态」，见下）；WorkflowRun store 同批纳入（其自有时间锚 impl-plan 对照定）。**W4 翻档与兜底扩展同批生效**（先行期 = 无兜底挂账窗口，禁止拆批）。挂账方向代价量化：每孤儿任务 1 条注册、最坏存续 = idle-gc 锚窗（30 天量级）**+ 至下次 sweep 触发点**（持续存活、永不重开的 session 内无中途触发点，至 session 重开由 rebuild + sweep 收口；危害仅静态 defer/工具虚报，有通知去重与熔断限损，无空转驱动源——R4 精度补正）；重审触发条件：误 defer 反馈 ≥2 例或单 session 幻活跃计数 >5 → 重审注册语义。
  3. **session 档机器死代码处置（原处置已被 ext-simplify-12 D2 推翻）**：翻档后 TTL 常量与 U3/U4/U11 全体无消费类型（三类型全 process 档）——原处置「机制本体保留（registry 通用能力），留存待未来类型，代码处显式注释勿误认清理仍在工作」已被 ext-simplify-12 D2 推翻并执行：session 档机器（TTL 常量、分档常量、session_start 重建与 shutdown handler）整体删除，process 档语义成为无条件代码自然状态。`normalizePendingType` 对缺失/未知 type 默认归 workflow 的偏好保留——**显式登记该偏好**：畸形条目宁挂账不失明；其清理通道 = 对账 sweep（判据含「record 不存在 → 视同终态补注销」，R3 修正——原「有 sweep + idle-gc 兜底」声明对对不上 record 的畸形条目失实，判据补全后闭合）。U11（shutdown cancelled 标注）随翻档对后台任务不再发生——已接受（process 档语义本就跨 shutdown 存活；清理痕迹由对账 sweep 兜底）。
- **与 D2 的闭环论证**：保持注册的每一笔都有监督器三态盯着（该等/该唤醒=通知主 agent 决策/该放弃=终态+注销），叠加对账 sweep 与 idle-gc 兜底——无「空转死循环」方向，也无「静默永等」方向。

**被否谱系**：仅做熔断不修注册语义（等待依然无主）；仅修注册语义不做熔断（未来未知盲区再次无界）；「工具调用清零」作为主判据（可被击穿——R1）；goal 扩展跨包消费 subagent record（依赖方向禁止 + 双状态通道漂移）；v2 版「注销时机均匀翻转」（conversation record 永久挂账——R1 击穿）；「保留窄版 U4 抵消 fork 残留」（多一条特殊清理路径，读侧过滤一刀更简——R2 选型）；「idle-gc 现状直接当兜底声明」（判据/行为/覆盖三重不成立——R2 击穿）。

#### D5：旧分类器、ui-request-queue、settled-watchdog 接线与 H9 测试的消亡/重接处置

- `engines/pi/session-runner.ts:2667-2677` 的旧 143 误分类器**不单独修正——随 inproc 分支删除整体消亡**。前提条件（顺序约束）：其语义先在新路径被钉住——conformance 新增「引擎进程/子代理中途被 SIGTERM → run 终态 failed + 原因含信号信息」用例（新 pi 包 `spawn-runner.ts:408` 已是「signal 退出 = 异常路径」语义，用例把语义钉成契约）。
- **`ui-request-queue` 终态裁决**：生产侧仅存的两处 engines/pi 真实 import 之一（type×2 + 值导入 `respond`）。cli 形态下 extension UI 请求改走协议 `host/askUser` 反向通道（v1 已有），inproc 队列**随删除消亡**；其「run 生命周期内闭包队列」语义由引擎包内等价物或协议应答路径承接——impl-plan 对照现消费点定承接形态，禁止临场发明。
- **settled-watchdog 生产接线重接**（R2 增补，防「删件即失守」）：两段守护的 arm/refresh/kill 接线随 W3 删件**同批重接**到协议事件流（arm 点 = 轮开始；refresh 源 = streamDelta/轮次生命周期事件；kill/终态 = `interact close force` 或对齐 run 域杀链），认领 W2+W4；接线未重接完成前 W3 不得删除 `session-runner.ts`。
- **session-pending list 口径消亡登记**（R3 增补）：`session-pending.ts` 的 `listActivePendingFromSessionFile`（后代补杀清单，:296-299 刻意绕过端口、不套跨 session 过期语义）消费方全在待删的 `session-runner.ts`——随 W3 删件**消亡**；其「层主死后孤儿后代止损」语义由监督器逐 record 三态（该放弃）承接，**禁止按旧「不过滤跨 session」语义把补杀迁入新路径**（翻档后 fork 残留会进补杀清单，误杀父 session 活跃后代）。
- H9 三测试按处置表回写：keep-alive-no-progress → D2 监督器协议黑盒用例；settled-watchdog → 既有 core 套件对齐协议事件面（**含生产接线归属行**——R2 增补）；timeout-integration → live conformance 门。4 个 W10 阻塞测试文件同批改写，替身符号来源（runSpawn/getChildByRecord 的引擎侧对应物）impl-plan 逐文件列出。

### 3.3 关键决策与权衡汇总

| 决策 | 选择 | 一句话理由 | 被否 |
|------|------|-----------|------|
| D1 协议表达 | A：激活 interact + run 会话形态 + 反向载荷增量，major 不 bump；关联键 = recordId；priority 留 core | 控制面 v1 已预留（A2 场景原文），只补它等待的反向载荷 | B 语义重复（R1 击穿原推荐）；C 连带升版本；D 假同构 |
| D2 判活归属 | A：core 权威 + 域分类前置 + record 去向单一裁决表 + 注销枚举点 + 对账 sweep | 只有 core 同时看得到 record×镜像×事件流；裁决表消双重处置；监督器唤醒 = 通知主 agent 决策（无双执行） | B 随葬悖论；C 固化缺口；无域分类版（R1 击穿）；双轨处置版（R2 击穿） |
| D3 abort 落地 | chat 面对齐 run 域既有分级 + runtime 三信号判据（快超时探测×事件窗×pending）+ 三级阶梯 | 分治：协议管语义、runtime 管误判、每级有终点、判据全部该面可观测 | 单层方案；无终点阶梯（R1）；受理 ack 判据（R2 击穿） |
| D4 goal 治理 | 双维度熔断 + 注册收窄/翻 process 档/读侧过滤/idle-gc 扩展/对账 sweep | 熔断治「空转无界」且不可绕过；注册五件套治「等待无主」全链 | 工具调用清零主判据（R1）；均匀翻转（R1）；窄版 U4（R2 选型否）；idle-gc 现状兜底声明（R2 击穿） |
| D5 消亡/重接处置 | 旧分类器/队列随删消亡；watchdog 接线同批重接；conformance 先钉新语义 | 修正死代码是负价值；删件不同批重接 = 失守 | 单独修正旧文件 |

**运行时断言与探针（实施期门）**：
- ⛔ **实施期门 P1**：「当前源码 ESC 守卫下，ESC 在 goal 循环中一个 turn 内落地」——事故时装机版本与当前源码的守卫完备性存在不确定性（事故取证针对已安装 dist；当前源码 ESC 守卫 :56 已存在）。实施首日跑真实探针：本地 pi CLI + goal 扩展构造连续 continuation 循环 → 发 ESC → 计测 idle 到达时间。探针通过 → D3 runtime 侧按「防御纵深」定位；探针失败（仍 >1 turn 落地）→ abort 迟滞根因升级为设计变更（回本设计 §3.2 D3 重做方案对比）。
- ⛔ **实施期门 P2**：「engine_crashed 语义在 chat 轮次上成立」——chat 轮进行中杀引擎进程 → core 收 `exited` → record failed + stderr 尾。conformance 用例承载。
- ⛔ **实施期门 P3**：abort 观察窗三类会话事件间隔分布实测（正常 turn / abort 落地 / 真冻结）→ 数据定窗 + 登记重审触发条件。窗值未实测前 D3 第 3 级（真冻结直达）不得启用裸事件新鲜度判据。
- ✅ **已测**：协议 v1 run 域全量行为（协议化 Gate A/B 已验收，不在本设计重验范围，仅回归）。

**物理数据流（终态）**：

```
GUI ──WS──> runtime ──RPC──> 主 pi 进程（扩展宿主）
                               │ subagent-core（协议客户端）
                               │   ├─ run 域：run/read/probe/cancel ──NDJSON stdio──┐
                               │   ├─ chat 域（v1.x）：run(会话形态/冷续) +              │
                               │   │    interact(message/close/cancel) ──────────────┤
                               │   ├─ 反向载荷（v1.x 新增）：轮次终态/record 回写 ────────┤
                               │   ├─ 轮次活性监督器（D2：域分类+裁决表+对账sweep）<──────┤
                               │   └─ settled-watchdog 接线重接（refresh=协议事件）──────┤
                               ▼                                                     ▼
                          goal 扩展（双维度熔断/守卫+读侧过滤计数）            pi-subagent-cli 引擎进程
                                                                         └─ chat pi 会话 / run 子代理
runtime（D3）：abort 超时 → 三信号判据（快超时探测×事件窗×pending）→ 阶梯：有界重试 → 用户显式强关 / 真冻结直杀
```

---

## §4 验收（真实场景）

> 全部场景在真实环境执行（打包态或 dev 实机 + 真实模型），非单测非 mock。单测/conformance 用例是实施期回归网（§5 各单元自带），不替代本章。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| A1 | chat 域 cli 形态全链（恢复协议化 §5 A2 blocked 场景） | dev 实机新建会话 → 首轮对话 → 关闭重开会话续聊 → 断网重连后 resume → ESC 中断 → 检查 record 回写与 GUI 展示 → **追加：构造升级前 inproc 期创建的 chatMode record → 升级形态下 resume 续聊** | 全部步骤正常；对话流「live ≡ reload」；record/journal 形态与迁移前逐字段一致；跨版本 resume 走通（sessionFile 锚点经协议携带不漂移）——若裁决不支持则显式报 `engine_session_not_resumable` 类错误并给指引，不得静默起新会话；engines/pi 目录已删除且 core 测试全绿 | G1、G6 |
| A2 | 事故重演：子代理被杀后主 agent 行为 | 实机派后台子代理（长任务）→ 任务进行中手动杀引擎进程 → 观察通知内容与主 agent 行为 → 静置观察；**追加：指引到达前主 agent 已重派新任务 → 观察监督器对账行为** | 通知为单条合并形态（failed 如实 + 接管契约，非 completed 谎报）；**行为断言**：通知到达后 session entries 无新 goal followUp 注入、空转 turn 数 = 0；监督器窗口内送达决策指引，主 agent 执行其一且**仅执行其一**；追加序列：对账生效——原 record 收到「已被替代」终止通知并终态化注销，新任务不受干扰，无双执行 | G3、G4 |
| A3 | ESC 落地（含阶梯终点） | 构造 goal 驱动的多轮任务 → 任务进行中按 ESC → 计测停止时间 → 查 runtime 日志；**追加：构造「活跃但不可中断」（长工具调用中 ESC）→ 观察阶梯 → 走到用户显式强制关闭 → 确认** | 正常路径：一个 turn 内（秒级）到达 idle，无「abort RPC timed out」与「force-destroying」日志；极端路径：快超时探测×事件窗判据判活 → 有界重试 → GUI 呈显式「强制关闭」→ 确认后强杀、record 标 failed、GUI 明示后果；**不存在无限重试分支** | G2 |
| A4 | 真冻结仍可杀（G5 反向） | 用调试手段挂起引擎进程（SIGSTOP）→ 发 ESC → 等 60s+ | 判据「快超时探测无响应 + 事件窗静默超窗」→ 直达强杀 → record 标 failed + 原因；GUI 收到明确错误 | G5 |
| A5 | 宿主重启分区（boot 直断 vs 重认领） | 多会话各派子代理（含 in-flight 与已 idle-resumable 两态）→ 重启 runtime → 观察 boot 分区扫描、孤儿清扫日志与幸存会话 | 引擎经 stdin EOF 自灭或进程组收割；in-flight record boot 直断 failed **且注销落盘可查**（对账 sweep 补发——断言：终态 record 所属 session 重开后守卫计数归零、`pending_notifications` 工具不虚报）；已 idle-resumable（非 conversation）由监督器重认领；**无任何「指向已终态 record 的残留注册」**；pidfile 清扫含 cmdline 校验；**无「活宿主的子代理被误扫描击杀」**（对照事故环 2 的 9 连杀） | G3、G5 |
| A6 | 协议兼容负向 | 构造 manifest 无 `conversation` gate 位的旧形态引擎包 + 新 core → 发起 chat → 再发起 run | chat 请求 gate 同步拒（含「升级引擎包」恢复指引，同 `engine_capability_unsupported` 文案契约）；run 域完全正常 | G1、G6 |
| A7 | live conformance 门 | `ENGINE_CONFORMANCE_LIVE=1 PI_LIVE_MODEL=<模型>` 全量 + 不变量 3a | 全绿；新增 chat 轮次、引擎死亡、监督器、熔断用例纳入 golden/live 套件 | G1–G4 |
| A8 | 监督器三态 | ①派后台子代理 → 杀引擎进程（record 保持 resumable）→ 静置观察；②构造无收敛信号轮次 → 等看门狗到期 | ①监督器在判定窗口内送达决策指引（主 agent 收到 resume/重派指引——必有其一，不许静默挂账）；②到期 → record failed + 注销 + 终止通知；全程守卫状态正确（不误 defer、不失明） | G4 |
| A9 | 跨重启/跨 session 注册不断链 | ①派后台子代理运行 >1h（无重启）→ 观察 goal 守卫状态；②fork 出子 session（继承父级注册残留）→ 观察子内守卫、后代判定与 `pending_notifications` 工具投影；③重启 runtime → 对照 A5 分区 | ①process 档注册跨时长存续（旧 1h TTL 致盲标记点不复现）；②读侧过滤三口生效：子 session 内守卫计数只数本 session 注册、后代判定差集不被污染、子进程正常 kill 到终态、**`pending_notifications` 工具 count/list 不含继承残留**；③分区处置符合表 3 | G4 |
| A10 | goal 熔断（R2 增补——事故环 1 主封堵机制的直接验收） | 构造纯文本迭代型 goal 任务（每轮无工具调用）持续运行 → 观察 continuation 间隔与数量；构造「每轮调一次 `subagents list` + 回等待」序列 → 观察；触发停发后走 `/goal resume`；观察 defer 通知 | 辅判据退避生效（第 5 轮起间隔翻倍）；主判据 50 次封顶**必停发**（「每轮调工具」序列同样被封顶拦截）；停发通知到达用户；`/goal resume` 恢复通道可用；defer 通知去重生效（pending 集合不变的连续 defer 轮中通知条数不增长） | G4 |

**验收前置（DoR）**：A2/A4/A5/A8 的「杀进程/挂起/重启」操作需可脚本化（测试辅助钩子或调试命令），实施期设计 impl-plan 时确认手段，不以「手工难操作」降级为 mock。

---

## §5 下一层拆分（impl-plan 输入）

| 单元 | 内容 | 领地 | 依赖 |
|------|------|------|------|
| W1 协议 SDK 增量 | 反向通道轮次生命周期载荷帧（关联键 = recordId，续聊轮无 runId 的映射按 D1-A 裁定）+ `interact`/`run` 会话形态参数扩展（resume 锚点对照 `EngineHandleData` 现有形态；priority 不进协议）+ `conversation` gate 位路由 chat 核对 + 版本兼容语义（major 不 bump；负向面 = 新 core 对无 gate 位引擎，即 A6 方向——版本协商按 major 边界，不存在「1.x 新引擎对旧 core」的独立负向场景） | `packages/subagent-engine-sdk/` | — |
| W2 pi 包承载 chat 轮次 | run 会话形态/interact 承载 chat 轮次（首轮/续聊/冷续 resume/关断）；HostChatRoundTicket 语义过协议的载荷映射；轮次终态事件上报（D3 落地语义的引擎侧）；**settled-watchdog 引擎侧事件面**（refresh 源 = 协议事件，W3 重接的引擎半边） | `packages/pi-subagent-cli/` | W1 |
| W3 core 改线 + 删 inproc | chat 路由切协议客户端；HostBridge 消费面适配（含 `HostBridge.cancel` 同步布尔 → 终态事件等待，D3）；**settled-watchdog 生产接线同批重接**（arm/refresh/kill 三点，D5——接线未重接完成前不得删 `session-runner.ts`）；**删 `engines/pi` 残余 11 文件**（旧分类器随之消亡，D5 顺序约束：W6 用例先行）；**`ui-request-queue` 消亡裁决落地**（`host/askUser` 通道承接，消费点逐个改线）；注销发射点按枚举收敛（D2）；4 个 W10 阻塞测试文件同批改写（替身符号来源逐文件列出） | `packages/subagent-core/` | W2 |
| W4 轮次活性监督器 | D2 域分类 + record 去向裁决表 + 三态判定（record 级状态源 + 纳管模型 + 通知对账）+ **读侧过滤三口**（count/后代判定/registry rebuild+工具读侧，按 sessionId 过滤；rebuild 已随 ext-simplify-12 删除，工具读侧改 entries 现算）+ 分档常量翻档（subagent/workflow → process 档；该常量已随 ext-simplify-12 删除）**与 idle-gc 扩展（startedAt 锚 + 只归档不补注销 + WorkflowRun store 纳入）同批生效** + 注册对账 sweep（appendEntry 权威写法）+ cold-resurrect 重认领（谓词含非 conversation）+ keep-alive 编排迁移收口 + **settled-watchdog core 侧接线半边**（W3 删件重接的 core 半边）+ session 档死代码注释处置 | `packages/subagent-core/` | W2（事件面）；翻档+兜底+对账为同批原子改动 |
| W5 goal 熔断 | 双维度熔断（总次数封顶 + 无进展退避）+ defer 通知去重 + 参数可配置 | `extensions/universal/goal/` | 独立，可先行 |
| W6 conformance 增量 | 引擎中途死亡 → failed 用例（D5 前置钉语义）；chat 轮次 golden/live 用例；监督器三态用例；跨重启/对账/fork 过滤用例（**含 bash 跨 session 可见性断言**——读侧过滤使子 session goal 不再为父 session bash 任务 defer，R4 指认的一刀语义变更，钉成显式选择）；熔断用例；H9 三测试回写处置表（含 settled-watchdog 生产接线归属行） | `packages/subagent-core/` + 双引擎包 | W2/W4 |
| W7 runtime 活性判据 + 阶梯 | abort RPC 超时路径：三信号判据（FAST_TIMEOUT_MS 快超时探测 × bridge 事件窗 × abort-pending）+ 三级阶梯（有界重试→耗尽升级 / 用户显式强关 / 真冻结直杀；复用 runtime 既有 get_state 健康探测先例 `runtime/src/index.ts:424` ADR-0047）；P3 探针定窗 | `packages/runtime/` | 独立，可先行（窗值定稿依赖 P3） |
| W8 文档同批 | 协议化设计裁决注记 :121 状态更新（豁免已收）；约束登记（协议版本/C-proc 系列）回写；H9 处置表终态；`XYZ_AGENT_ENGINE_ROOTS` 自装旧引擎的发现优先级与 chat 错误路径说明 | `docs/` | 全部 |

**拆分理由**：W1→W2→W3 是协议依赖链（串行主干）；W4/W5/W7 各自离问题最近且可独立验收（并行支线；W4 的翻档+兜底+对账是同批原子改动，不可拆分先行）；W6 是语义钉住层（先于 W3 的删除动作）；W8 是 design-code-sync 纪律（同批回写，不留悬空引用）。

**待验证项（实施期确认，不预编造）**：
- 反向载荷帧的边界（轮次终态/record 回写/resume 锚点的最小字段集）——W1 设计时定，对照 `pi-engine.ChatRoundTicket` 现有字段实测；
- abort 观察窗值与快超时探测的命令选型——P3 探针实测定（§3.2 D3）；
- 熔断参数（总次数上限 50 / 退避 N=5）实机校准——重审条件见 D4 误伤量化；
- goal 扩展在引擎进程内（chat 域 cli 化后）的加载形态是否引入新的 extension 打包面——W2 实施时核（builtin 打包清单 SSOT 在 `packages/shared/src/mandatory-extensions.json`，预期无新增，因 goal 本就在会话扩展加载路径）；
- idle-gc 扩展的锚窗值（startedAt 距今阈值）与 WorkflowRun store 纳入的判定字段——W4 实施时对照现存 store 形态定。
