# subagent chat 域统一进 run 域（resume 锚点续聊）

> **层声明**：技术方案层设计——当前层 = 方案决策与协议/语义规格，下一层 = 可实施的 PR 单元（§5）。问题定义经多轮用户裁定收敛（§3.3 七题决策逐条有用户拍板），无未答疑点。
> **修订状态**：v7（设计就绪，2026-09-11 双审双 0 收敛）。收敛轨迹：主审 6→3→1→3→0、影响面 6→3→3→3→2→1→0 must-fix；关键修正谱系见附录 B（19 条）：D8 回撤（B#6）、收割链进程组论证反转 + 平台分通道（B#9/#15/#16）、one-shot 收口四分支图景（B#12）、成功载体迁移清单（B#13/#17/#19——接管点内部步骤逐项核对纪律四度生效）、settle 交棒 run 应答驱动（B#14）、base 死记账退役（B#18）。行号基线 = commit `64e379a7c` 附近（subagent-service.ts 行号随 H1 实施批次有漂移——「L 批次」指用户并行批次，非 Gate B 修复批次 L；实施期以 grep 锚定符号名为准）。
>
> **一句话结论**：chat 域为「引擎进程跨轮长驻」维持的独立状态机整族退役；续聊轮统一为「新 run + resume 锚点」（pi `--session` 续写原 session 文件——该链路已是设计内降级路径并经真机验收）。代价 = 每轮续聊多一次进程冷启（量级与回退边界见 D2）；收益 = 净删约 2.5-3.5k 行 + 永久消除「每个活性/守护/通知修复都要 chat 域单独再做一遍」的域税。

---

## 1. 背景目标

### 1.1 SCQA

- **S（情境）**：xyz-agent 的 subagent 子系统有两种执行域。**run 域**：一次性任务——派发 → spawn 引擎子进程 → 事件流 → 终态 → 通知 → 回收，全链路一套机制。**chat 域**：GUI 续聊型 subagent（`conversation: true` 派发，record 带 `chatMode` 标记）——引擎侧会话跨轮长驻，续聊经 `interact` 控制面投递，为维护「长驻」存在一整套独立状态机（§2.2）。
- **C（冲突）**：chat 域状态机是持续成本中心——最近一例：工具执行期活性失明修复（F2/F3）在 run 域用协议变体解完后，chat 续聊轮仍需专属修复（PR2 的 `roundLifecycle` active 相位，含 emitPhase 红线、superseded 抑制等专项机制）。
- **Q（问题）**：能否让 chat 域塌缩进 run 域而不损核心体验？
- **A（答案）**：能。每轮续聊 = 新 run + resume 锚点，上下文由 pi session 文件持久承载。用户已裁定接受秒级冷启代价。

### 1.2 系统是什么（受众认知铺垫）

subagent 派发链（三层进程）：宿主 pi 主进程（extension 加载 `subagent-core`）→ 引擎 CLI 子进程（`pi-subagent-cli`，共享池长驻）→ 任务子进程（`pi --mode rpc`，每个 run 一个）。一个 subagent 在宿主侧对应一条 **ExecutionRecord**（状态机 = `running | closed` + 关闭原因；`chatMode` 标记对话容器），GUI 列表/详情/通知从 record 投影。**resume 锚点** = record 的 sessionFile：pi 以 `--session <file>` 启动时**续写原文件**（`spawn-args.ts:71-73`），模型召回全部历史。**round-supervisor**（轮次监督器）是 run 域 record 的崩溃治理主体（三态判定：该等/该唤醒/该放弃），chatMode record 现状豁免——**本设计维持豁免**（见 D8：对话容器的治理者是用户，监督器的判死语义不适用于容器）。

### 1.3 设计目标

- **G1 续聊体验语义保持**：多轮续聊、上下文召回、在途轮可打断插入新消息、每轮完成有通知、GUI 列表仍是一行。
- **G2 chat 域状态机整族退役**：六件套（§2.2）中 chat 专属机制删除；净删约 2.5-3.5k 行（含测试；round-supervisor 为共享机制保留，见 D8）。
- **G3 续聊轮获得 run 域全部既有保障且不削弱 one-shot**：中段守护、活性刷新（PR1 activity 链路经 run 事件通道）、settle 段守护（交棒源改接 run 终态事件，见 D7）、崩溃失败通知（Continuation 单发）；**容器永不自动判死**（监督豁免维持——治理者是用户，30 天 idle-gc 只归档不终态化的窗口语义不变）；one-shot 行为零变化（监督域零改动）。

### 1.4 in / out scope

**in**：core 的 message/close/cancel 编排重写；pi CLI run 路径 resume 参数穿透；SDK 协议面退役（`host/roundLifecycle` 通道、`interact` 方法）；chat 域删除面；约束/文档回写。
**out**：zcode 引擎 chat 支持；`read`/SessionView 读路径；H2/H3/H4（后续设计）；record 持久化收敛。
**`--fork` 派发**：spawn 期参数不经 interact，但其**能力判定**借位 conversation 位（§3.3 D5），属本设计改写面。

---

## 2. 现状与问题分析

### 2.1 使用者视角的现状（真实链路）

用户在 GUI 派 chat subagent，任务完成后追问：主 agent 调 subagent 工具 `action:"message"` → `subagent-actions-core` message handler → `service.chatActions.deliverChatMessage` → `engine.interact(handle, {kind:"message"})`（仅有的三处 interact 调用之一，另两处为 terminateChatSession 的 cancel/close）→ 引擎 CLI 内 `ChatSessionRegistry.deliverMessage` 找长驻 pi 子进程 → stdin 投递 → `host/roundLifecycle` 相位帧回报 → record 轮末收口。首轮经 `kickOffChatRound` 以 `RunParams.chat {recordId}` 发起；跨进程冷续以 `chat {recordId, resume}` 发起。另有 **SP-5 升级链**：one-shot 完成后 record 保持 running（旧 idle），首条 message 将其升级 chatMode（`subagent-actions-core.ts:566-582`）。

### 2.2 chat 域状态机清单

| # | 机制 | 位置 | 判定 |
|---|------|------|------|
| 1 | ChatSessionRegistry（长驻子进程/轮次/firstRoundDone/superseded 抑制） | `pi-subagent-cli/src/chat-session.ts`（609 行） | 删 |
| 2 | roundLifecycle 相位机（4 相位 × 双键 + 宿主处置映射） | SDK `reverse-channels.ts` + core `handleChatRoundPhase` | 删（通道+相位机；PR2 active 随之退役，活性由 PR1 activity 事件经 run 通道接棒） |
| 3 | 轮终等待体 + cancel 收敛宽限 | `chat-session.ts`（emitPhase/roundTerminalWaiters/CANCEL_SETTLE_GRACE_MS） | 删（打断语义改用 run abort，见 D2——「等真轮终再杀」的宽限语义随长驻消亡一并放弃） |
| 4 | 冷续复活（cold-resurrect + resumeColdRound） | `cold-resurrect.ts`（199 行）+ service | 删（标准 store.revive 承载再水合；guard 语义见 D4） |
| 5 | chat 专属 close 三路 + idle timer | `closeChatIdle`/`closeAfterRoundSettled`/`armChatIdleTimer` | 删（替代见 D4） |
| 6 | **round-supervisor**（轮次监督：三态判定 + 2h 决策看门狗 + notify-accounting） | `round-supervisor/{supervisor,domain,notify-accounting}.ts` | **零改动（豁免维持）**——它是 run 域（非 chatMode）record 的治理主体（`domain.ts:27-40`「run 域一次性任务——监督域主体；conversation 形态——豁免」）。v2 曾裁定取消豁免（纳入监督域），被三面击穿回撤（附录 B#6）：①引擎死亡接管链会清 result → 容器落「该唤醒」形态 → 2h 看门狗 giveUp 终态化 closed+gc（连 worktree 一起清），gc ∉ 可重连终态 → 容器永久死亡，与「跨重启可续聊」产品语义（v4 B-1，30 天 idle-gc 只归档不终态化）冲突；②pi 路径运行期崩溃本无纳管接线（adopt 调用点全在非 pi 引擎路径），「豁免取消即接入」不成立，补接线又与 Continuation 失败通知双发；③superseded 强杀（用户新派同 slug 任务）对「重派一次性任务 ≠ 放弃对话上下文」的容器语义错位。`reconcile-sweep`（通用对账）保留；`service-binding` 对 cold-resurrect 的 `COLD_LOOKUP_SCAN_LIMIT` import 随删除清理 |

配套删除：recordId 路由注册（`registerChatRoundRoute`）、`handleChatRoundPhase`、`armChatIdleTimer`、deliverChatMessage/resumeColdRound 编排、kickOffChatRound 的 chat 专属分支（派发主干保留并泛化，见 D6）。

### 2.3 真实成本与失败模式

1. **域税**：F2 活性修复 run 域一处 vs chat 域专项（PR2 全套）。
2. **理解成本**：六件套咬合（相位×键路由、等待体×宽限、firstRoundDone×冷续）。
3. **边界形态多**：settled→idle 间隙、superseded 串扰、EPIPE 兜底、busy 拒绝——每条专项测试。

### 2.4 根因分析

「跨轮状态」的真实需求只有**上下文延续**，而上下文已由 pi session 文件持久承载。长驻的全部增量 = 省一次进程冷启，代价是整个状态机。**根因 = 用「进程长驻」解决「上下文延续」——解错了层。**

### 2.5 已实证的关键事实

- **冷续链路真机验收过**（Gate B V6，2026-09-10）：引擎 SIGKILL → 新进程 + resume → 同文件 2444B→10224B 追加写、模型召回两轮历史。
- **冷续本就是设计内降级路径**：`chat-session.ts` 四处错误恢复指引原文即 "dispatch a new run with ctx chat resume"。
- **spawn 层单写者不变量已有声明**：`spawn-args.ts:53-54`。
- **`interact` 仅 chat 消费**：三处调用全在 chat 路径。
- **conversation 能力位的消费方不止 interact**（影响面审 F1）：①fork 门控 **OR 借位**——`capability-gate.ts:91-99` 在 `steer === "unsupported" && conversation === "unsupported"` 才拒 fork，pi 声明 `steer:"unsupported"` + `conversation:"native"`，**pi 的 fork 放行完全依赖 conversation 位**；②`conversation:true` 派发对 unsupported 引擎的拒绝（zcode）；③manifest/握手 mismatch 判定；④引擎发现与 zcode stub 快照逐位一致要求。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径——三轮对话**：

```
用户: subagent start {task, slug, conversation:true}
→ 首轮 run 派发（无 resume）→ 完成，通知①（dedup key = record:round，见 D7）
用户: subagent message {slug, message:"对比 Y"} → 新 run（resume = record.sessionFile）
→ 完成，通知②；再 message → 通知③；GUI 列表始终一行，详情按轮追加
```

**打断路径**：

```
轮 2 在途（streaming 可见），用户 message "换个角度查 Z"
→ Continuation 触发在途 run 的 abort 信号（RunContext.signal——引擎侧对 pi 子进程
   走取消链，进程退出即 run 收敛；「等真轮终相位」的宽限语义已随 §2.2#3 删除）
→ abort 收敛回调（进程已退出 = 单写者前置满足）→ record 不终态化（保持 running）
→ 新轮以 "换个角度查 Z" 派发（resume 同一文件；被中断轮的部分输出按 pi trap 语义
   flush 进文件，模型下轮可见中断现场——该断言的实证见 S2 检查点⑤）
→ 用户感知：消息即时生效，永不「忙」拒绝
```

**失败路径**：

| 场景 | 行为 | 恢复指引 |
|------|------|---------|
| message 时 record 无 sessionFile 锚点 | 同步拒绝：`no transcript anchor on record <id>; re-dispatch (action:'start')` | 文案即指引 |
| message 时 record 已 closed（user-close/cancelled） | 沿用既有 endedMessageGuard 硬拒（`actions-core:228-237`「cannot be messaged or resumed」→ 引导 start 新的） | 文案即指引 |
| message 时 record closed 但属可重连终态（disconnected/parent-shutdown，`RECONNECTABLE_FINAL_REASONS`） | store.revive 再水合 + Continuation 以 sessionFile 续聊（取代 cold-resurrect） | 无需动作 |
| 轮在途引擎崩溃 | run failed + 失败通知；**chatMode record 不走 run 域终态化短路**（D7 轮末分流）——保持 running-resumable（MF-6 语义由 Continuation 承载） | 用户再 message 自动 resume（S4） |
| cancel 宽限窗内又来消息 | 入 FIFO；abort 收敛后按序派发（多条聚合为一轮输入） | 无需动作 |
| 用户 close（任意状态） | 见 D4：abort 在途 + 清队列 + record 终态化（closed/user-close）+ notifyClosed | — |
| resume 文件被外部删除 | spawn 期 ENOENT，run 失败如实透传（附路径） | 人工核对 |

### 3.2 多方案对比

| 方案 | 长期合理性 | 短期成本 | 风险 | 判定 |
|------|-----------|---------|------|------|
| **A. 每轮新 run + resume 锚点** | 高：单一执行域；chatMode 纳入监督域（保障增强） | 中：建路 2 PR + 删路机械大量 | 低：冷续已实证 | **选定** |
| B. 保留长驻、简化相位机 | 低：状态机与域税仍在 | 低 | 中：简化即改语义 | 否——治标 |
| C. 队列语义（不打断） | 中：消息生效延迟到轮末 | 中 | 低 | 否——用户裁定打断语义（与主 agent composer 四态机生成中=stop 同构） |
| D. 砍 chat 功能 | 中：一轮一 record，列表膨胀 | 中 | 中：UX 倒退 | 否 |

### 3.3 关键决策

- **D1 record 粒度**：一个对话容器、多轮 run 复用；`chatMode` 保留；事件流按轮追加。**被否**：每轮一 record。
- **D2 在途语义 = 打断 + 插入（含代价量化与回退边界）**：message 到达且在途 run 存在 → 触发其 **abort 信号**（非 record 级 cancel——`cancelBackground` 会 `tryTransition closed+cancelled` + completeRecord + archive **销毁 record**，不可用于打断）；run 收敛（进程退出）后 drain 队列。**宽限语义声明放弃**：「等真轮终再杀」随 §2.2#3 删除，打断即杀（这正是打断的本意）。**代价量化**：每轮冷启一次（引擎 CLI 池已长驻，冷启 = pi 子进程 spawn + session 重放，量级待 U4 实测入表）；**回退边界**：U2 与 U6 同文件交错，revert 最小单元 = U1-U6 全链（commit 序即为此设计）；**重审触发条件**：U4 实测 P95 冷启 > 5s，或用户体感明确不可接受 → 重开方案对比（B/C 复评）。
- **D3 resume 参数**：复用 `RunParams.chat` 子对象泛化改名（如 `resume`），载荷 `ResumeAnchor` 不变；**双键过渡**（见 U1）。
- **D4 close/cancel/message 的 record 状态迁移表**：

| 动作 × record 状态 | running（有在途轮） | running（轮间 idle） | closed（user-close/cancelled） | closed（可重连终态） |
|---|---|---|---|---|
| message | abort 在途 → 排队 → 新轮 | 新轮 | 硬拒（guard 原文不变） | revive + 新轮（**非 chatMode 可重连终态的升级语义，v4 显式化**：水合保留持久化 chatMode 后，`chatMode !== true` 的 record 收到 message → 升级置位 chatMode=true 再续聊——语义承接现状 `cold-resurrect.ts:124-127` 的无条件置位（session shutdown 时被 disposeAllRecords 关成 parent-shutdown 的在途 one-shot 正靠此路径保持可续）。升级写点前置 D5 gate（conversation 位检查，gate 不过 → 硬拒 + fork/重派指引），防 unsupported 引擎升级后续聊行为悬空） |
| close（用户） | abort 在途 + **清空队列** + 终态化（closed/user-close：doFinalizeRecord 语义 = `.state` + entry + archive + 注销发射 + notifyClosed；承接现 `closeChatIdle` 的收口职责） | 同左（无在途轮直接终态化） | no-op | no-op（已终态） |
| 引擎崩溃 | run failed + 失败通知 + **record 保持 running-resumable**（轮末分流 D7） | 不适用 | 不适用 | 不适用 |

- **D5 协议退役（修订：conversation 位保留）**：删除 = `host/roundLifecycle` 通道 + `interact` 方法（含 zcode `server.ts` dispatch 与 SDK `port-contract`/conformance fixtures）；**manifest `conversation` 位保留、语义收窄为「resume 能力位」**——消费方清单（§2.5 第五条）：fork OR 借位照常工作（pi `conversation:"native"` 维持声明）、`conversation:true` 对 unsupported 引擎的拒绝照常、mismatch/discovery/stub 不动。zcode 同步删除 interact 桩；conversation 位声明 `unsupported` 不变。**SP-5 升级 gate 补口径（v4 扩为双写点协同）**：one-shot→chatMode 升级有两个写点（现场注释 `actions-core.ts:572-574` 原文明示「改动这两处必须协同」）——①进程内热升级（`actions-core:566-582`，现无引擎能力检查）②跨重启冷升级（原 `cold-resurrect` 无条件置位，U6 删除后语义迁入 D4 revive 格）。gate（conversation 位检查）**同时覆盖两写点**：unsupported 引擎（zcode）的 one-shot 收到 message 不升级（含 parent-shutdown 可重连终态经 message 的升级旁路面），guard 文案指引 fork/重派（避免升级后续聊行为悬空）；S8 限定默认引擎。
- **D6 Continuation 复用对象（归因修正）**：pi 轮派发主干 = `kickOffChatRound` 的**共享部分**（它同时是 pi 引擎 background 派发主路径，one-shot 也走）——保留并泛化（chat 专属分支剥离）；**不是** `runEngineTask`（那是非 pi 引擎路径且接 event journal；pi 路径刻意不接 journal——事件仅作活性信号）。
- **D7 轮末处置分流（承载 MF-6 / round 计数 / settle 段交棒）**：chatMode record 的 run 轮末**不走 run 域终态化短路**（否则容器被首轮吞掉），按 outcome 分流（成功与失败**都**到达轮终处理）：
  - **成功**：chat 轮成功的现行收口载体 = `settleChatRoundFromResponse`（`subagent-service.ts:2745` chatMode 分支调用，语义权威自持于其注释 :2895-2898），**统一并入** Continuation onRunSettled 成功分支。**语义迁移清单（v6，逐项）**：① round+1 / 注销发射点② / reportRecordTransition——并入 `doFinalizeRoundToIdle(outcome=success)`（机制本体保留）；② **通知发送步骤显式归属（v6 补——注释五项未列的隐藏副作用）**：现行通知 = `notifyGateAllowsDelivery(record.closedReason)` 门（:2914，拦 parent-new/parent-fork 编排性关闭与 cancelled 的迟到帧，[T4①/PS-2]）通过后 `collectCoordinator.route(record)`（正文源 = `record.result`）——迁移为 onRunSettled 成功分支的显式步骤「门 → route」，**与整体 early-return 正交并存**（early-return 判 status 终态面、gate 判 closedReason 编排面——两闸判据不同源，不互替）；route 时点移至轮终簿记后（现状 notify 先于 reportTransition，两通道独立；新时序由 U2 单测锁定）；③ base 推进——**退役不迁移（v6 改判）**：其消费函数 `getFullTextFrom`/`nextRoundBaseTurnIndex` 生产零调用（唯一调用方 inproc 时代的 onRoundSettled 已删，`execution-record.ts:632-657` 仅存注释考古），现行 base 推进 = 死记账，保留即违反 G2 减法——写点随载体删除，`roundBaseTurnIndex` 字段连带清理（U6）；「notify 失败 base 不推进」防丢文本语义由 record.result 恒写承接；④ closeAfterRound 消费——**chat 域退役**：消费点 = `settleChatRoundFromResponse` 检测标志 → `closeAfterRoundSettled`（:2921-2923 / :1777；归因修正 v6——v5 误记 closeChatIdle，其「无在跑轮」分支从不碰标志），写点 = `closeSubagent` chat 分支 else（:1700，仅轮在途 close 窗口可达；消费点 :2936-2938）；统一后 D4 close 行为 = abort 在途 + 清空队列 + 立即终态化（不等轮终），chat 域不再置该标志，载体随 U6 删除；one-shot 域的 closeAfterRound 照旧（settleOneShotOutcome 不动，见末行）；⑤ 空 content 成功轮兜底（v6 补）：现行 `roundText || (lastError ? "round did not complete: …" : "(no output this round)")` 的 lastError 混入形态不保留——统一为 `(no output this round)`（lastError 语义归 lastError 字段与失败通知，成功轮正文不再混失败文案）。
  - **失败/中断** = 失败通知 + record 保持 running-resumable（MF-6 语义并入，chat 侧失败三调用点 `:1580/:2619/:2886`（watchdog / spawnFailure / roundFailed）的载体 `finalizeChatSpawnFailure`/`onChatRoundFailed` 删除、语义并入）；**round 同样 +1**（round = 轮次序号即 attempt 计数——失败轮不递增会让失败通知与上一轮成功通知同 dedup key，60s 窗内被吞）；**`record.result` 写入规则（v4 载体显式化）**：`doFinalizeRoundToIdle` 增加 outcome 入参（`{kind:"success", content}` | `{kind:"failed", reason}`——v6 补 content 字段：成功正文来源 = `outcomeToAgentResult(outcome).text` 映射产物；命名与协议 `AgentOutcome` 同名不同物，kind 判别联合消歧），轮终簿记（round+1 / 注销发射点② / reportTransition / resumable 置位）两形态照做，差异仅在 result 写入——**成功轮** result = `content`（现行不变；空 content 兜底见成功分支⑤）；**失败轮** result = 前值 ?? 失败摘要（有最后成功正文则保留——GUI record 视图不被失败污染、renderer hasRunning 判据 `result !== undefined` 仍成立；首轮失败无正文可保则写 `"round did not complete: <reason>"`）。**`record.lastError` 写规则（v5 补）**：失败轮写失败原因（承接现行 `onChatRoundFailed` :2874 写点；renderer 在 result 非 undefined 时不显示 error，无视觉影响——仅排障面）。**失败可达性迁移声明**：现行 `[T2-③/LC-1]` 语义（失败原因+恢复指引必须可达宿主，`finalize-record.ts:311-314`）从 `record.result` 字段迁移到**通知 outcome**——失败轮通知正文 = 失败摘要 + 恢复指引（不走 idle 正文 `record.result`），宿主感知失败的通路不消失、载体换位。**投递载体（v6 补）**：失败通知不经 `route(record)`（其正文恒读 `record.result` = 前值，直接复用会以旧正文冒充失败通知）——Continuation 经通知原语独立构造载荷（正文 = 失败摘要 + 恢复指引；dedup key 仍 `record:round`）；**投递门照迁移（v7 补）**：发前仍过 `notifyGateAllowsDelivery(record.closedReason)` 门——拦 `cancelled`（cancelBackground 自行 notify，防双发）与 `parent-new/parent-fork`（防僵尸回执注入已切换 session，NOTIFY_BLOCKED_CLOSED_REASONS）；失败分支从终态守卫到通知发出跨 `doFinalizeRoundToIdle` 的 await 链（比成功分支同步窗更宽），中途关闭窗内终态化后通知必须被门拦下——守卫是入口一次性判定，覆盖不了该窗。**one-shot 共享调用点不动**：`finalizeRoundToIdle` wrapper 的 4 处生产调用中 `:2538`（settleOneShotOutcome 成功分支，SP-5）不在 chat 迁移面——「迁移面 = chat 侧失败三调用点 + 成功载体 settleChatRoundFromResponse」，非「唯一生产调用点转移」（v4 措辞错位，附录 B#13）。
  - **通知 dedup key = `record:round` 不变**（`notifier.ts:65`），round 递增对每个到达轮终的轮生效（成功失败同计，dedup 天然分离）。
  - **续聊轮 run resolve 时点 = `agent_settled`（chat 语义保留，v4 显式定案）**：one-shot 现行 run 在 `agent_end` 即终态 kill（`spawn-runner.ts:340`），chat 域现行等 `agent_settled`（`spawn-runner.ts:108-113`）。统一后续聊轮取 **agent_settled**——settle 窗守护的 `agent_end→agent_settled` compact 收尾在统一后依然存在（pi 的 compact/收尾在 agent_end 后执行），`agent_end` 即 kill 会截断收尾截断 session 文件；run 的 resolve、kill、轮末分流（onRunSettled）均以 agent_settled 为准。one-shot 行为不变（其 `agent_end` 即终态语义照旧，G3）。
  - **settle 段守护交棒改接（v5 轻形态：run 应答驱动，零协议扩展）**：settled-watchdog 的 settle 段（收尾守护）是 **chat 域专属现行**（one-shot 无 settle 交棒——其 onRoundLifecycle 接线本就未挂，`subagent-service.ts:2727-2739` 全在 chatMode 条件内），现以 `host/roundLifecycle` settled 相位为交棒源（`settled-watchdog.ts` 头注释 :46-48 / 函数体 noteRoundSettledFromProtocol :383-385）。通道删除后交棒源改接 **run 应答回调**：续聊轮 run resolve 时点已定 = `agent_settled`（上条），故 Continuation onRunSettled（run 应答回调）内调 `noteRoundSettledFromProtocol(record.id)` 即完成交棒——宿主侧原语实存，**不新增协议事件类型**（v4 的「run 事件通道 agent_settled 终态事件」不成立：AgentEvent 协议仅 9 种无 agent_settled，translator 对 agent_settled 走 onAgentSettled 回调不经 onEvent 事件出口，`contract-types.ts:106-115` / `spawn-event-translator.ts:143-157`——附录 B#14）。settle 段守护保留而非退役（守护对象 compact 收尾窗按上条决策依然存在）。mid 段刷新源 = run 事件通道 9 种既有事件（已定，无需扩展）。
  - **one-shot（非 chatMode）轮末收口 = `settleOneShotOutcome` 四分支原样保留（v5 修正，零改动）**（`subagent-service.ts:2527-2546`）：成功 + closeAfterRound → consumeCloseAfterRound；**成功（无挂起）→ `doFinalizeRoundToIdle` 保持 running-resumable 等首条 message 升级（SP-5 现行语义）**；失败 + closeAfterRound → consumeCloseAfterRound；失败/取消 → `doFinalizeRecord` 终态化。v4 末行「照旧 doFinalizeRecord 终态化」与现状相反（成功轮从不终态化——否则 SP-5 升级链断、S8 自相矛盾，附录 B#12）。分流判据 = `record.chatMode`；`doFinalizeRoundToIdle` 的 outcome 入参对该共享调用点恒传 success（行为零变化）。
- **D8 chatMode 维持监督豁免（v3 回撤裁定）**：round-supervisor **零改动**——conversation 豁免分支、boot skip、引擎死亡接管 gate（`chatMode !== true`）全部保留。裁定理由：对话容器的**治理者是用户**，监督器的「该唤醒→2h 看门狗→giveUp（closed+gc，含 worktree 清理）」与「superseded 强杀」语义对容器是灾难（v2「纳入=增强」被击穿，证据链见 §2.2#6 与附录 B#6）。chatMode 轮的崩溃处置由 Continuation 独占（D7 失败分支，单发通知——不存在 supervisor merged notice 双发面）；容器长窗语义不变 = 崩溃/重启后 running-resumable 永久等待用户再 message，30 天 idle-gc 只归档不终态化（v4 B-1 产品语义维持）。**附 INFO 级正向变化登记**：goal 拦截面经 pending 注册表消费活跃性，长驻消亡后对容器的覆盖从「整个对话期」收窄为「轮在途期」（轮间主 agent 可自由结束 session，容器仍 30 天可续）。

**红线（单写者不变量，两级声明）**：
- **cancel/正常路径 = 构造性保证**：Continuation 单飞——abort 收敛（进程退出）是派发下一轮的前置事件，编排上不存在并发派发。
- **崩溃路径 = 引擎退出链收割（构造性）+ 宿主重启窗口（经验性，登记）**：①**收割链（v5 修正，取代镜像查询守卫）**：孤儿真因 = 引擎意外死时宿主**未发收割信号**——`teardownProcess` 对已死进程（`alreadyDead=true`，`engine-client.ts:634-637`）跳过 `killProcessTree`，任务子进程留在无主进程组继续写。修复形态（按平台分通道，插入点 = `teardownProcess` 内、`mirror.killAll()` 置死清空**之前**，仅 `!intentionalKill && alreadyDead` 的非主动死亡路径触发——主动 dispose 链已有两层杀（引擎 `killAllActiveChildren` SIGTERM+30s + 宿主 `killAll` 组杀 5s 升级），跳过即不叠加、优雅窗零压缩、pi trap-flush 零截断）：
  - **POSIX**：复用 `killProcessTree(child.pid)` 负 pid 组杀（SIGTERM → 5s grace → SIGKILL 升级链内建，fire-and-forget 不阻塞同步 teardown；组长死后进程组存活到最后一员退出，组杀可达任务子进程；组杀目标 `-child.pid` 不依赖镜像，不受 `mirror.killAll()` 位置约束）；**无外层逐 pid 兜底**（SIGTERM 同步返回后 5s 窗内孤儿必然仍活，同步校验恒命中、立即兜底 = 优雅窗归零——升级链已覆盖残余职责，v5 删除该矛盾规格）。
  - **Windows**：`killProcessTree` 的 win32 分支（`taskkill /PID <引擎pid> /T /F`）以引擎 pid 为树根，树根已死 → not found → 空操作——**不可复用**；Windows 通道 = `mirror.killAll()` 置死前 `mirror.snapshot()` 抓清单，**过滤活孤儿**（`state === "running" && !killed`——镜像对已退出子进程只改 state 不删项、唯一清空点 = killAll，全量快照含引擎一生历史死 pid，共享池长驻寿命内可累积至数百，活孤儿 ≤ 并发数），对过滤后的活 pid 逐个**异步 spawn** `taskkill /PID <任务pid> /T /F` fire-and-forget（树根 = 活着的任务子进程自身，树杀有效；**快照同步抓、杀动作异步发**——与 POSIX fire-and-forget 对称；禁 spawnSync：逐个同步 N×10s 上界会冻结 onEngineExit 同步回调、推迟 pending reject（Continuation 失败通知链源头）与宿主事件循环）。
  - **one-shot 在途 run 结果面零新增影响**（引擎意外死时已随 `engine_crashed` 失败，收割链只清理孤儿进程）。
  ②**派发前兜底**：Continuation 派发前查镜像，活着先 kill 后 spawn（防引擎存活期的状态错配）；③**残余风险（单窗口）**：宿主重启丢镜像 + 极端逃逸进程的窗口——量级 = 引擎意外死频次 × 平台通道失效概率（罕见）；恢复 = 下一轮派发前兜底② + S4 实测；重审触发条件 = session 文件出现交错行证据时升级为文件锁/写者探测。

### 3.4 ConversationContinuation（建议新增命名）——唯一新增组件

```
class ConversationContinuation {            // 每 chatMode record 一个实例
  activeRunId?: string                      // 在途轮（单飞）
  queue: string[]                           // FIFO 待发消息
  onMessage(msg):
    record 已终态 → guard 分流（D4 表，closed 硬拒 / 可重连 revive）
    activeRunId 非空 → abort(activeRunId.signal)；enqueue(msg)
    空 → dispatchRound([msg])
  dispatchRound(msgs):
    ① stale-child 兜底：镜像在途子进程活着 → kill 等退出（红线第二级②；
       引擎已死场景的孤儿由引擎退出链收割兜底——红线第二级①，U2 实现件）
    ② 载荷组装（每轮语义载荷，归自 resumeColdRound/kickOffChatRound 现有实现）：
       model 身份重建（splitEngineModelRef → ResolvedIdentity，防多轮模型漂移）
       worktree 句柄 + 绑定丢失守卫（hadWorktree && !worktreeHandle → 拒绝并指引，
         防 resume 静默回落主 repo）
       sessionRootId 注入（协议 ctx 字段——L1 已落地 c1ebd6db5）
       signal（abort 通道）/ priority / pool acquire
    ③ 轮活性守护挂载：armMidRoundNoProgress(record.id, …)（防回归：替代原两处
       chat 专属 arm）——挂载点经泛化派发主干在 pool acquire 之后（实现契约 =
       ContinuationHost.dispatchChatRound，service 侧 kickOffChatRound/resume
       分支实施；排队窗不计入 no-progress 静默）
    ④ 经泛化派发主干发起 run（resume = record.sessionFile）
  onRunSettled(outcome):                        // run 应答回调（resolve = agent_settled，D7）
    【终态守卫 = 整体 early-return，先于一切分支】record 已终态化（close 抢先）
      → 直接返回：不 roundIdle、不通知、不 drain，并清空待发 queue（防 close/cancel
      终态化后残留消息在后续 revive 时重放；doFinalizeRoundToIdle 的机制
      语义就是「覆盖 closed 回滚为 running」（finalize-record.ts:352-359）——若
      守卫只挡 drain 不挡成功分支，close 终态化会被轮末收口回滚 + 追加通知 +
      二次 unregister。配套断言：doFinalizeRoundToIdle 入口 assert status==="running"）
    settle 段交棒：noteRoundSettledFromProtocol(record.id)（run 应答驱动，
      D7 v5 轻形态——先于轮终簿记，watchdog 停表早于状态写）
    成功 → doFinalizeRoundToIdle(outcome=success, content)（round+1、注销点②、
      result = content，空 content 兜底 "(no output this round)"——承接 settleChatRoundFromResponse）
      → 轮终簿记后 disarmRoundWatchdog（两段守护一并清，防已收敛轮残留 armed 守护
        对 drain 新轮资源误发 kill/cancel——settled-watchdog disarmRoundFromProtocol）
      → notifyGateAllowsDelivery(closedReason) 门 → collectCoordinator.route(record)
      （v6 显式迁移：门判 closedReason 编排面、与 early-return 的 status 终态面正交双闸）
    失败/中断 → doFinalizeRoundToIdle(outcome=failed)（轮终簿记同上 + 同样先 disarm
      两段守护；result = 前值 ??
      失败摘要、lastError 写失败原因——见 D7 写入规则）+ 失败通知（独立构造载荷——
      不经 route(record)，正文 = 失败摘要 + 恢复指引；发前过 notifyGate 门，
      同成功分支双闸；可达性迁移自 [T2-③/LC-1]）
      + record 保持 running-resumable
    queue 非空 → dispatchRound(drain)
}
```

### 3.5 终态数据流

```
GUI message → subagent tool(message) → Continuation
  ├─ 无在途轮 → [stale-child 守卫] → [载荷组装] → run(resume=file)
  │     → 引擎 CLI（共享池）→ spawn pi 子进程（--session 续写）
  │     → 事件流（含 activity）→ record 追加 + 守护刷新
  │     → 轮末分流（chatMode → Continuation onRunSettled；one-shot → settleOneShotOutcome 四分支照旧）
  └─ 有在途轮 → abort → 进程退出 → drain 队列 → 上一支
```

---

## 4. 验收（真实场景；每场景回溯 §1 目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| S1 | 多轮续聊 + 通知去重口径 | GUI 派 chat subagent（真实 LLM）完成轮 1 → **60s 内连续** message 两轮 | 每轮完成通知**各自到达**（dedup key=record:round 不被 60s 窗吞掉）；轮 3 复述轮 1 具体事实；列表一行 | G1 |
| S2 | 打断插入 + 中断现场召回 | 轮 2 streaming 时 message 新指令 | 在途轮 abort 收敛后新轮立即执行；新轮输出体现新指令；**检查点⑤**：下一轮追问「上一轮说到哪」能召回中断现场（trap flush 实证） | G1 |
| S3 | 关重开一致性 | S1 后关重开 session | 对话流/record 状态一致（live≡reload 套件绿） | G1/G3 |
| S4 | 崩溃 resume + 并发写检查 + 中断现场 | 轮在途 SIGKILL 引擎 CLI → 立即 message | 失败通知到达（Continuation 单发）；续聊以原文件 resume 且**文件无交错行**（验证红线①收割链：非主动死亡路径组杀/Windows 镜像通道，此刻 pid 可得）+ 孤儿退出时序（非镜像兜底守卫——引擎已死镜像已置死）；**中断现场断言（v5 补，与 S2 检查点⑤同构；判定口径 v6）**：收割后下一轮追问「上一轮说到哪」**能复述崩溃前最后一个已完成工具调用/事实**（内容级判定，不要求逐字节——flush 粒度边界即此口径）——收割链对孤儿的杀法是信号级 SIGTERM（引擎已死无协议取消链），pi 对裸 SIGTERM 做 trap graceful shutdown 有现行一手证据（`subagent-service.ts` 注释：pi 子进程 trap SIGTERM 做 graceful shutdown，窗口几十~几百 ms），本断言即该行为在收割路径的实测验收；若实测不达标 → 升级为已接受代价登记（模板见核验点⑦） | G1/G3 |
| S5 | 删除面回归 | 删路完成 | 四包 + **`pnpm extensions:test`**（extensions 真链路测试：chatmode-first-round-closure / one-shot-upgrade 等已随改写）+ conformance 套件全绿；`grep -rn "roundLifecycle\|engine\.interact\|registerChatRoundRoute" packages/ extensions/ scripts/ --include="*.ts" --include="*.mjs" | grep -v "/dist/"` **零命中**（v5 实测口径：命中全集已逐文件归档处置表与 U5/U6 删除清单——实施期以 grep 实际输出对照复核，命中数随基线小幅漂移属正常）；GUI 默认引擎 one-shot 行为零变化 | G2/G3 |
| S6 | 存量记录续聊 | 取落地前 chatMode record（running-idle）message 之；另取**非 chatMode 可重连终态** record（session shutdown 期在途 one-shot 被 disposeAllRecords 关成 parent-shutdown 后重启）message 之；user-close 终态验证拒绝指引（**场景定义裁决 2026-09-11**：disconnected 变体不进真机表——正常流程不可构造（仅 `.state` reason 异常的重建分支产出），其 revive 链以单测覆盖为准） | **绑定工件前提（UF-1 落地，2026-09-11 补）**：跨重启续聊动作链的数据源前提 = `.record-binding` 绑定 sidecar——宿主在 run 终态应答 `outcome.sessionFile` 回填点写 id→file + rootSessionId（`state-marker.ts` 载体族，close 终态翻转只写 `.state` 不破坏绑定），`cold-lookup.ts` 的 findLightById/collectRecords 经 sidecar 恢复 id→file 映射；UF-1 落地前创建的存量 record 无 sidecar，其跨重启可续性以 Gate B 真机复验签收为准。**布局前提（Gate B 发现，2026-09-11 补）**：引擎写盘目录必须与宿主扫描根同树——W7 引擎 `resolveSessionDir` 三处偏离宿主权威（根/段序/编码）致分裂，修复 = run ctx `sessionDir` 协议化（宿主 `getSubagentSessionDir` 单一权威注入，引擎本地推导降级 [LEGACY]）。真机通过标准：① running-idle（含 sidecar）重启后 message 直接续聊；② parent-shutdown 重启后 revive 续聊 + 升级 chatMode 置位（D4 revive 格；可重连终态集 = `{parent-shutdown, disconnected}`，`types.ts:88`）+ D5 gate 覆盖（pi 放行升级且续聊多轮存活 round 持续 +1 不终态化；zcode 侧 gate 拒绝为单测覆盖）；③ user-close 收到「deliberately closed by user」拒绝指引（非 reconnectable/fork-from 文案） | G1 |
| S7 | close×message 竞态 | 轮在途 → message（入队）→ 立即 close | 在途 abort + 队列清空 + record 终态化 closed/user-close + notifyClosed；**无僵尸轮、无 close 后追加通知** | G1 |
| S8 | one-shot 升级续聊（SP-5） | 派 one-shot 完成 → 首条 message（默认引擎 pi） | 升级 chatMode 照常（`actions-core:566-582` 链经 Continuation + D5 gate），续聊与 S1 同；unsupported 引擎（zcode）的升级被 gate 拒绝并指引（单测覆盖） | G1 |

> 真机验收环境注意（F7 已修，`19a5401ab` dev 启动恒重建 staged 引擎）：仍需确认副本新鲜度。

---

## 5. 下一层拆分（PR 单元）

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| U1 协议双键过渡 | SDK：新增 `resume` 子对象与 `chat` 并存（载荷同形）+ schema/测试；roundLifecycle/interact 标 deprecated 注释。**读写配对策略（防静默失效）**：U2-U5 期间 core 恒构造旧 `chat` 键（pi 读 `ctx.chat` 现状不变）；**U6 单批同时切换写端（core 构造 `resume`）与读端（pi 改读）并删 `chat` 键**——不存在「写新读旧」窗口（错配 = resume 静默失效、每轮新文件、sessionFile 被覆盖） | 改名破坏范围外两包编译（core 构造 `chat:`、pi 读取 `ctx.chat`），双键过渡保每步 workspace 绿 | SDK 绿 + 兼容负向用例 |
| U2 core 建路 | Continuation（§3.4 全规格：状态迁移表/载荷/守卫/轮末分流 D7 含成功载体 settleChatRoundFromResponse 语义迁移清单）+ message/close 编排改写 + SP-5 升级路由与 gate（双写点，D5）+ **引擎退出链收割**（红线①：非主动死亡路径触发；POSIX 复用 killProcessTree 组杀 + Windows 置死前 mirror.snapshot 逐 pid taskkill 通道；intentionalKill 路径跳过）+ settle 段交棒改 run 应答驱动（onRunSettled 内调 noteRoundSettledFromProtocol，D7）+ doFinalizeRoundToIdle outcome 入参（D7 失败轮载体） | 新语义最小闭环；与 U3 并行 | 单测：D4 表逐格（含非 chatMode 可重连终态两成员升级格）/ abort 不终态化 record / 轮末分流（成功与失败）/ round+1（含失败轮）/ dedup key / close 抢先整体 early-return（无回滚、无追加通知、无二次 unregister）/ 失败轮 result = 前值??失败摘要 + lastError 写入 + 通知正文带失败摘要与恢复指引 / 首轮失败 result 非 undefined / 成功轮 result = content（outcomeToAgentResult text 映射）+ route 晚于轮终簿记（次序断言）/ chat 域 closeAfterRound 退役（close 立即终态化，无挂起标志消费）/ one-shot settleOneShotOutcome 四分支零变化回归（成功轮不终态化）/ 引擎死亡→Continuation 单发通知（监督豁免维持的回归用例）/ 收割链：非主动死亡路径 POSIX 组杀 + intentionalKill 路径跳过 + Windows 通道置死前快照**过滤活孤儿**后逐 pid 异步 taskkill（死 pid 不进清单）+ taskkill 异步不阻塞 teardown（pending reject 时序）+ 无外层逐 pid 兜底（grace 窗不被压缩）/ settle 交棒：onRunSettled 内 noteRoundSettledFromProtocol 调用次序先于轮终簿记 / 成功分支 notifyGate 门 → route 显式步骤 + 编排性关闭（parent-new/parent-fork）迟到应答不注入 / 失败通知过 notifyGate 门：cancelled 竞态窗不双发 + parent-new/parent-fork 竞态窗不注入 / Continuation 成功分支不写 roundBaseTurnIndex（base 退役负向断言）/ 空 content 成功轮 result = "(no output this round)"（lastError 不混入正文）/ stale-child 兜底 |
| U3 pi CLI 建路 | run 路径 resume 参数穿透（spawn-args 已支持 `--session`）+ 首轮不再经 ChatSessionRegistry | 引擎侧独立可测 | e2e：resume run 续写同文件、历史召回 |
| U4 真机验收 | S1-S8 + **冷启耗时实测入表**（D2 量化闭环） | 建路即验收，删路前拿基线 | §4 全表 |
| U5 删路①（引擎侧） | pi：chat-session.ts + 测试 + e2e chat 形态改写；SDK：roundLifecycle 通道族 + interact 方法 + `port-contract.ts`/`engine-protocol.ts` + schema + conformance fixtures（`fake-engine-protocol.mjs`/`smoke-run.fixture.json`）+ probe 脚本；zcode：`server.ts` interact dispatch + `zcode-engine.ts` 桩。**测试处置（v4 逐文件化，见下表前 8 行）** | 引擎侧先行，core 消费点已死 | S5 |
| U6 删路②（core 侧） | **删除**：deliverChatMessage/resumeColdRound/onHotPathSettledWatchdogTimeout、cold-resurrect.ts（含 service-binding 的 `COLD_LOOKUP_SCAN_LIMIT` import 清理；**其 chatMode 无条件置位语义迁入 D4 revive 格 + D5 gate，不是静默消失**）、closeChatIdle/closeAfterRoundSettled、armChatIdleTimer、handleChatRoundPhase、unregisterChatRoundRoute、engine 层承载件（port.ts interact 签名与第 9 通道声明/remote-engine/reverse-router/engine-client/host-bridge 的 roundLifecycle 与 interact 面）、`finalizeChatSpawnFailure`/`onChatRoundFailed`（语义已入 U2）、`settleChatRoundFromResponse`（chat 成功载体——语义按 D7 迁移清单并入 Continuation 后删除）、`getFullTextFrom`/`nextRoundBaseTurnIndex`（base 死记账退役 + `roundBaseTurnIndex` 字段清理，D7 ③）。**core 测试处置**：见上方「S5 grep 门测试处置表」后 4 行（U6 批次）。**保留**：kickOffChatRound 派发主干（泛化改名）、resolveChatEnginePort、releaseRoundResources/resolveWorktreeHandle/consumeCloseAfterRound（one-shot 共用）、doFinalizeRoundToIdle（outcome 入参泛化；chat 侧并入 Continuation，one-shot 共享调用点 settleOneShotOutcome 不动，D7）、**round-supervisor 三件零改动（豁免维持，D8 v3）**、reconcile-sweep、settled-watchdog（mid 刷新源改接 run 事件通道 9 种既有事件 + settle 交棒改 run 应答驱动，D7）；孤儿恢复的 chatMode 分支维持（v4 B-1 语义）。**U6 同批**：`chat`→`resume` 键读写两端切换（U1 配对） | 全部为死代码后再删 | S5（grep 门排除 `dist/` 等产物口径）+ 全量 + 净删统计 |
| U7 文档与约束回写 | C-proc-13 **五段逐段**（①协议面删两通道 ②轮次活性权威：chatMode 豁免维持（D8 v3）、注销发射点②「chatMode 轮末 idle」承载改 Continuation 轮终簿记 ③⑤连带核对 ④不动）；`chat-domain-v1x-liveness-governance(.impl-plan).md` superseded 横幅；protocolization 文档族符号清扫（doc-symbol-drift 守卫全绿）；troubleshooting §12 | C-proc-10 纪律 | 守卫绿 |

**S5 grep 门测试处置表（v4；命中已按 pattern 实测复核，先例 = conformance 目录 `H9-test-disposition.md`）**：

| 文件 | 命中形态 | 处置 | 理由 |
|---|---|---|---|
| `subagent-engine-sdk/src/__tests__/chat-domain-v1x.test.ts` | roundLifecycle 载荷 ×4 | 删 | v1.x chat 域协议测试整体随协议退役 |
| `subagent-engine-sdk/src/__tests__/protocol.test.ts` | 反向通道全集断言 ×3 | 改写 | 共享协议测试：全集断言删 `host/roundLifecycle` 项，其余通道断言保留 |
| `pi-subagent-cli/src/__tests__/chat-protocol.test.ts` | roundLifecycle 帧序列 ×4 | 删 | chat 协议帧序列测试；续聊协议覆盖由下方 e2e 改写承接 |
| `pi-subagent-cli/src/__tests__/pi-engine.test.ts` | `engine.interact` 行为断言 ×14 | 改写 | 引擎核心行为测试 message 投递迁移 run 通道续聊形态；close/cancel/EPIPE 兜底随 interact 面退役删除，覆盖去向 = stdin-writer.test / server.test / run-spawn-once.integration（pi-engine.test.ts 尾注释声明） |
| `pi-subagent-cli/src/__tests__/protocol-chat-e2e.test.ts` | roundLifecycle settled/idle 帧 ×8 | 改写 | 续聊 e2e 价值保留（两轮续聊/冷续聊），断言载体从 roundLifecycle 帧改 run 终态事件 |
| `pi-subagent-cli/src/__tests__/server.test.ts` | interact dispatch / 三分通道注入 ×4 | 改写 | :310 dispatch 断言删；:598-611 三分通道测试删 roundLifecycle 项，其余保留 |
| `zcode-subagent-cli/src/__tests__/server.test.ts` | interact dispatch 断言 ×1（:294） | 改写 | dispatch 断言删，其余保留 |
| `subagent-core/.../conformance/chat-round-protocol.test.ts` | chat round 协议 conformance ×13 | 删 | conformance 随协议退役（fixtures 已在 U5 列） |
| `pi-subagent-cli/src/__tests__/chat-session.test.ts` | roundLifecycle 帧断言 ×1 | 删（U5） | 随 chat-session.ts 整文件删除（U5「+ 测试」逐文件化） |
| `extensions/universal/subagent-workflow/src/__tests__/one-shot-upgrade.test.ts` | `engine.interact` 受理断言 ×2 | 改写（U6 批，依赖 U2 gate） | 升级链测试改 Continuation 形态（热路径 = abort 在途/新轮派发） |
| `extensions/universal/subagent-workflow/src/__tests__/chatmode-first-round-closure-service.test.ts` | roundLifecycle idle 相位注释 ×1 | 改写（U6 批，依赖 U2 轮末分流） | 首轮收口测试改 run 应答回调形态 |
| `subagent-core/.../__tests__/helpers/fake-engine-port.ts` | 模拟面 | 改写（U6） | 去 roundLifecycle/interact 模拟面 |
| `subagent-core/.../__tests__/subagent-service-recovery-bounds.test.ts` | interact 断言 | 改写（U6） | 去 interact 断言 |
| `subagent-core/.../__tests__/chat-round-first-round-watchdog.test.ts` | chat 首轮看门狗 | 删（U6） | chat 域首轮机制随域退役 |
| `subagent-core/.../client/__tests__/remote-engine.test.ts` | 承载件断言 | 改写（U6） | 随 engine 层承载件删除断言改写 |

**文件改动地图**：SDK `protocol/{methods,contract-types,schema,reverse-channels,port-contract,engine-protocol}.ts`；core `execution/{subagent-service,subagent-actions-core}.ts` + 新增 `execution/conversation-continuation.ts` + 删 `execution/cold-resurrect.ts` + `execution/{finalize-record,notifier}.ts`（轮末分流/round 写点）+ `execution/execution-record.ts`（base 两函数与 `roundBaseTurnIndex` 字段清理，U6）+ `execution/types.ts`（字段声明清理）+ `execution/engine/{port.ts,client/{remote-engine,reverse-router,engine-client}.ts,host/host-bridge.ts,common/capability-gate.ts}`（capability-gate 注释更新 + SP-5 升级 gate 错误构造单源 engineConversationUpgradeUnsupportedError——conversation 位保留）+ `execution/settled-watchdog.ts`（刷新源）；pi `pi-engine.ts`/`server.ts`/`spawn-runner.ts` + 删 `chat-session.ts`；zcode `server.ts`/`zcode-engine.ts`；extensions `subagent-workflow/src/__tests__/{chatmode-first-round-closure-service,one-shot-upgrade}.test.ts`（改写）+ interface 面。

**待验证检查点**：① U3 resume 穿透精确点位与首轮 spawn-run 化细节；② U4 冷启耗时分布（D2 量化）；③ gui-mappers 多轮 run 投影兼容（S1/S3 覆盖）；④ capability-gate/conversation 位消费方在 U5-U6 的逐位回归（fork 派发真机一次）；⑤ S2 trap-flush 召回实证；⑥ settle 段交棒接线次序（形态已定 D7：onRunSettled 内调 noteRoundSettledFromProtocol，先于轮终簿记——核验实施期接线与单测断言一致）；⑦（S4 条件触发）收割路径中断现场召回实测不通过时，pi 对裸 SIGTERM 的 flush 行为重查 + 已接受代价登记（**模板三要素前置，v6**：丢失面量级——最坏丢尾部未完成 entry 或整轮 streaming 输出，以实测 flush 粒度定案；恢复路径——无自动恢复、用户重问；重审触发——交错行证据或召回显著低于 S2 同构基线）。

---

## 附录 A：决策溯源

复杂度审查（2026-09-10）→ 用户拍板统一方向 → 七题裁定（D2 打断语义为用户提出，经 composer 四态机核验采纳，否决拒绝式守卫）→ 本 v2 吸收双审查 12 must-fix（关键修正：round-supervisor 定性、打断机制、轮末分流、conversation 位保留、close 竞态）→ v3 吸收第 2 轮 6 must-fix（D8 回撤、守卫整体 early-return、收割链、失败轮规格、双键配对、SP-5 gate）→ v4 吸收第 3 轮 4 must-fix（收割链论证纠错 + 组杀化、失败轮载体显式化、S5 处置表逐文件化、D4 revive 升级语义 + gate 双写点）与 run resolve 时点定案（agent_settled）→ v5 吸收第 4 轮双审 6 must-fix（one-shot 收口四分支图景、成功载体迁移清单、settle 交棒改 run 应答驱动零协议扩展、收割链去兜底矛盾 + Windows 通道、S4 中断现场断言、处置表/判据/S6 补全）→ v6 吸收第 5 轮双审（主审 0 must-fix / 影响面 2 must-fix：Windows 通道活孤儿过滤 + 异步化、通知链 route/gate/顺序三要素显式迁移）+ 4 suggestion（closeAfterRound 归因、outcome 入参 content 字段、base 死记账退役、S4 判定口径 + 检查点⑦模板）→ v7 吸收第 6 轮（主审 0 must-fix 通过；影响面 1 must-fix：失败通知投递门照迁移 + 两竞态窗用例，谱系 #19）+ 主审机械同步（U2 残留 token / route 次序断言 / closeAfterRound 写点可达域精确化 / 文件改动地图补 execution-record.ts 与 types.ts）。

## 附录 B：被否谱系（审查击穿记录）

1. **「round-supervisor 是 chat 分区，随 U6 删除」**——被主审#1/影响面 F2 击穿：它是 run 域治理主体（chatMode 豁免），删除即断 one-shot 崩溃接管链、S4/S5 自相矛盾。修正为保留（零改动）。
2. **「打断复用 run 域 cancel 链（SIGTERM→等轮终→宽限→升级）」**——被主审#2 击穿：那是引擎侧 chat 链（U5 删除对象）；record 级 cancelBackground 会销毁 record。修正为 abort 信号 + record 不终态化。
3. **「conversation gate 位随 interact 一并删除」**——被影响面 F1 击穿：fork 门控 OR 借位依赖该位（pi fork 放行完全依赖它）。修正为 D5（位保留、语义收窄）。
4. **「复用 runEngineTask 全链」**——被主审#5 击穿：那是非 pi 引擎路径且接 journal。修正为 D6（kickOffChatRound 共享主干泛化）。
5. **「单写者红线构造性保证（无条件）」**——被主审#4 击穿：崩溃路径无 cancel 前置。修正为两级声明 + 收割链 + 残余风险登记。
6. **「chatMode 纳入监督域（D8 v2：豁免取消即接入 = G3 增强）」**——被主审 MF-1/影响面 F-1/F-2 三面击穿：①引擎死亡接管链清 result → 容器落「该唤醒」形态 → 2h 看门狗 giveUp 终态化 closed+gc（含 worktree 清理），gc ∉ 可重连终态 → 容器永久死亡，与「跨重启可续聊」产品语义（30 天 idle-gc 只归档不终态化）冲突；②pi 路径运行期崩溃本无 adopt 接线（调用点全在非 pi 引擎路径），「豁免取消即接入」不成立，补接线又与 Continuation 失败通知双发；③superseded 强杀（同 slug 重派即放弃旧容器）对「重派一次性任务 ≠ 放弃对话上下文」语义错位。修正为 D8 v3：豁免维持、supervisor 零改动、容器治理者 = 用户。
7. **「stale-child 守卫 = 派发前查镜像 kill（v2 红线第二级）」**——被主审 MF-3 击穿：镜像在引擎 exit 时整体置死清空，守卫在其主目标场景（引擎死亡留孤儿）查不到 pid——有效域（引擎存活且镜像未置死）与风险域（死亡留孤儿）几乎不相交。修正为「引擎退出链收割（置死前逐 pid kill，pid 此刻可得）+ 派发前兜底（防引擎存活期错配）+ 宿主重启单窗口经验性登记」。
8. **「onRunSettled 终态守卫 = 不派发（字面仅挡 drain）」**——被主审 MF-2 击穿：成功分支 doFinalizeRoundToIdle 的机制语义就是「覆盖 closed 回滚为 running + 清 closedReason」（finalize-record.ts:352-359 原文），只挡 drain 则 close 终态化被回滚 + 追加通知 + 二次 unregister，精确违反 S7。修正为整体 early-return（先于一切分支）+ doFinalizeRoundToIdle 入口 status==="running" 断言。
9. **「pi 任务子进程自立进程组，宿主组杀收不到它（v3 红线①论证）」**——被第 3 轮双审同点击穿：`spawn.ts:63` 任务子进程硬编码 `detached:false`、与引擎 CLI 同进程组（引擎为组长），组杀本可达——孤儿真因是 `teardownProcess` 的 alreadyDead 分支**跳过** killProcessTree（宿主未发信号，`engine-client.ts:634-637`）。v3 还因此漏析 dispose 路径三层杀链叠加面。修正为：非主动死亡路径补发组杀（复用 killProcessTree，生效域跳过 intentionalKill）+ 信号语义声明 + dispose 优雅窗零压缩。
10. **「失败轮 result 不覆盖（v3 一句话规格）」**——被主审 SUG-1 击穿：唯一现成载体 doFinalizeRoundToIdle 内部**无条件** `record.result = nextResult`（`finalize-record.ts:335`），一句话规格无法实施——不经它则 round+1/注销发射/迁移上报缺载体，经它则 result 被兜底文本覆盖。修正为 outcome 入参：轮终簿记两形态照做、result = 前值??失败摘要、失败可达性从 result 字段迁移到通知 outcome（[T2-③/LC-1] 语义保活）。
11. **「D4 revive 格 = 复活+新轮（v3 未声明非 chatMode 升级语义）」**——被影响面 MF-3 击穿：现状跨重启 message 靠 cold-resurrect **无条件置 chatMode=true**（`cold-resurrect.ts:124-127`，parent-shutdown 终态 one-shot 的续聊正依赖它），U6 删该文件后升级写点静默消失——若水合保留 chatMode=false，续聊轮按 one-shot 走终态化，「续聊」一轮即死；且该升级旁路面在 v3 的 D5 gate（单点 actions-core）之外。修正为：升级语义显式入 D4 revive 格 + D5 gate 扩为双写点协同（呼应 `actions-core.ts:572-574`「改动这两处必须协同」原文）+ S6 第三例用例。
12. **「one-shot（非 chatMode）轮末照旧 doFinalizeRecord 终态化（v4 D7 末行）」**——被主审 MF-A 击穿：与现状相反——one-shot **成功轮**走 settleOneShotOutcome 成功分支 → doFinalizeRoundToIdle 保持 running-resumable 等首条 message 升级（SP-5，`subagent-service.ts:2536-2538`）；仅失败/取消/closeAfterRound 才终态化。照字面实施 = one-shot 完成即终态 → SP-5 升级链断（endedMessageGuard 硬拒）→ S8 自相矛盾。修正为 settleOneShotOutcome 四分支原样保留（零改动）。
13. **「doFinalizeRoundToIdle 唯一生产调用点转移 + 成功分支即其本体（v4 D7）」**——被主审 MF-B 击穿：①wrapper 4 处生产调用中 one-shot 成功点（:2538）不在 chat 迁移面，「唯一调用点转移」字面实施会断共享面；②chat 轮成功的现行载体是 settleChatRoundFromResponse（:2745/:2895-2898），其语义（增量通知正文源 outcome.content / base 推进 / closeAfterRound 消费）不在 doFinalizeRoundToIdle 内——不列迁移清单会静默丢失（B#10 同模式在成功侧复发）。修正为：迁移面 = chat 失败三调用点 + 成功载体 settleChatRoundFromResponse，附逐项迁移清单（含 chat 域 closeAfterRound 随 D4 close 立即终态化而退役）。
14. **「settle 交棒源 = run 事件通道的 agent_settled 终态事件（v4）」**——被主审 MF-C 击穿：AgentEvent 协议仅 9 种无 agent_settled（`contract-types.ts:106-115`），translator 对 agent_settled 走 onAgentSettled 回调不经 onEvent（`spawn-event-translator.ts:143-157`）——「事件实存」不成立，字面实施需新增协议事件类型（五包 schema/translator/fixtures 连锁）。修正为 run 应答驱动轻形态：onRunSettled（run 应答回调，resolve = agent_settled 已定）内调 noteRoundSettledFromProtocol，零协议扩展。
15. **「组杀后镜像逐 pid 校验残余再兜底 kill（v4 收割链）」**——被第 4 轮双审交叉击穿：SIGTERM 同步返回后 5s 优雅窗内孤儿必然仍活（reaper 升级链 setTimeout+unref），同步校验恒全命中、立即兜底 = 优雅窗归零截断 trap-flush，与红线自身目标相冲；且 killProcessTree Windows 分支以引擎 pid 为树根、树根已死 = 空操作，Windows 收割结构性失效未声明。修正为：POSIX 复用 killProcessTree 组杀无外层兜底（升级链内建覆盖）+ Windows 置死前 mirror.snapshot 逐 pid taskkill 通道 + S4 补中断现场断言（影响面 MF-3）。
16. **「Windows 通道 = 快照全量清单逐个 spawnSync taskkill（v5 初版）」**——被第 5 轮影响面 MF-1 击穿：镜像对已退出子进程只改 state 不删项（唯一清空点 = killAll），全量快照含引擎一生历史死 pid（长驻可数百，活孤儿 ≤ 并发数），不过滤 = 死 pid 放大；逐个 spawnSync（单次上界 10s）同步冻结 onEngineExit、推迟 pending reject 与宿主事件循环，与 POSIX fire-and-forget 不对称。修正为：快照过滤活孤儿（`state==="running" && !killed`）+ 杀动作异步 spawn（快照同步抓、杀异步发）。
17. **「成功分支通知细节随载体自动继承（v5 隐含）」**——被第 5 轮影响面 MF-2 击穿：settleChatRoundFromResponse 通知链三要素不在其注释所列五项内（route 发送步骤 / notifyGateAllowsDelivery closedReason 门 / notify→base 顺序约束），不显式迁移即静默丢失，且只在编排性关闭竞态窗与通知失败场景显形（S1 正常路径全绿抓不到）——B#10/B#13 同模式第三发。修正为：迁移清单②显式归属「门 → route」双闸（gate 与 early-return 判据不同源、正交并存）+ ③改判 + U2 补迟到应答不注入用例。
18. **「base 推进保留（多轮增量锚点，v5 迁移清单③）」**——被第 5 轮主审 SUG-C 证伪：消费函数 `getFullTextFrom`/`nextRoundBaseTurnIndex` 生产零调用（唯一调用方 inproc 时代 onRoundSettled 已删），现行 base 推进 = 死记账，通知正文权威 = record.result（buildLlmContent 不读 turns 切片）。修正为退役不迁移（G2 减法），写点与字段随 U6 清理。
19. **「失败通知只声明载荷独立（v6 失败分支）」**——被第 6 轮影响面 MF 击穿：失败链的**投递门**（notifyGateAllowsDelivery，拦 cancelled 防双发 / parent-new/parent-fork 防僵尸回执）未声明承接——「不经 route」只独立了载荷，门随 onChatRoundFailed 接管删除即静默丢失；且失败分支从守卫到通知跨 await 链，中途关闭窗内终态化后通知仍发出 = S7 违反。B#10/B#13/B#17 同模式第四发（接管点内部步骤逐项核对纪律再次生效）。修正为投递门照迁移 + U2 两竞态窗用例。
