# session-dead 结构性修复：忙碌状态单一权威、强制退出完整语义与 turn 进展观测面

> **层声明**：本文档是技术方案层设计——当前层 = 方案决策与语义/状态机规格，下一层 = 可实施的 PR 单元（§5）。问题定义经完整现场实证收敛（§2 时间线每一环都有日志/代码双重证据），两个产品微决策（D3 回草稿、§5 落地顺序）已按推荐落定，阅读时可否决。
>
> **一句话结论**：2026-09-10「会话卡死」事故不是单点 bug，而是三个结构性缺陷的叠加——**忙碌状态写侧分叉**（B1）、**「停止」只有 kill 没有语义**（B2）、**观测体系只有进程死活没有 turn 进展**（C1）。修复为三组相互正交的改动：状态写点收敛到单一转移原语、forceQuit 补齐「防复活」语义、给用户补上 turn 进展判据（观测面，不自动中止）。

---

## 1. 背景目标

### 1.1 SCQA

- **S（情境）**：xyz-agent 主会话是三层结构——renderer（前端）↔ runtime（Node 进程，会话状态的唯一 owner）↔ pi 子进程（每个 session 一个，真正执行 agent turn）。session 的「忙/闲」判定驱动着发送预检、前端排队自动投递、侧栏状态灯、强制退出等全部交互。
- **C（冲突）**：2026-09-10 一个 Stock 项目 session「卡死」约 80 分钟：用户发消息无反应、强制退出后 0.5 秒自动复活、82 次 1 秒重投死循环；fork 出的新 session 却完全正常。逐环实证后确认：session 没坏，pi 也没死——是 runtime 的忙碌判定、停止语义、观测能力三处结构性缺陷在同一时间链上叠加（§2.1）。
- **Q（问题）**：① 忙碌状态到底谁说了算？② 「停止」怎样才能完整表达（杀了进程 ≠ 停了执行）？③ turn 的「有意义进展」如何被用户看见？
- **A（答案）**：三组正交修复——写侧收敛为单一转移原语（三布尔降级为派生存储）、forceQuit 补齐「防复活」三层语义、turn 进展做成观测面交用户裁决。本文档展开。

### 1.2 系统是什么（关键概念铺垫）

以下概念贯穿全文，均取自代码实装（括号为权威位置，行号以分支 `fix-session-dead` HEAD 为参考锚点，实施时以符号名为准）：

- **pi 自发 turn**：不经 runtime 发起、由 pi 自己启动的 agent 执行。两种来源已被实证（全量触发源清单见 §2.2 七条）：① **auto-retry**——pi 遇到 socket error 等可重试错误时按指数退避自动续跑（pi `agent-session.js _prepareRetry`），每轮完整重放 `agent_start → … → agent_end` 生命周期，`agent_settled` 只在整个级联终点发一次；② **extension 通知补投**——subagent-workflow 扩展的 notify-ledger 在 pi `session_start` 时补投未送达的后台子代理完成通知（`sendMessage(triggerTurn:true)`），scheduler 扩展的到期任务同构。二者都会让 pi 在「runtime 没发过 prompt」的情况下开跑。
- **双状态源**：runtime 对同一 session 维护两套忙碌状态——① 三个布尔字段 `isGenerating / isCompacting / isBashRunning`（`ManagedSession` 上，`types.ts`）；② **occupancy 投影**（三维 `{turn: idle|dispatching|generating|settling, compacting, bash}`，`updateSessionOccupancy` 是唯一**转移**写原语，幂等合并 + 全等去重 + 广播 `session.occupancy` 帧）。关键事实：**runtime 内部所有 isIdle 类判定全部读三布尔，occupancy 读点为零**——occupancy 在 runtime 纯对外投影，只有前端消费（发送路由、defer flush 门、chat store 的 `sessionPhase` 分区 → 侧栏 ActivityStrip 活动条与 composer 队列区 defer 行 hover 文案分档）。**既有合法特例（本设计收敛时必须处置，见 D2）**：`registerSession` 的 occupancy idle **宣告帧**（`session-lifecycle.ts`）刻意不走 `updateSessionOccupancy`、直接 publish——对象初值即 idle，全等去重会短路广播，而该帧职责是「宣告」而非「转移」（Gate B V6b④ 反例修复：无宣告帧则 stale occupancy 残留、defer flush 永无触发源；有 occupancy-runtime 测试 Part D 回归守卫）。它不写状态，是投影的第二个广播出口。
- **defer 队列与 D1 占用短路**（前端，`useChat.ts`）：发送被拒的消息进 per-session 队列，收到 occupancy 全 idle 帧自动 flush；flush 失败还有 1 秒定时重投，重投前查 occupancy 投影仍忙则短路不投（D1）。**前端能否刹车，完全取决于 runtime 的 occupancy 投影说不说真话。**
- **ensureActive / restoreSession**：`ensureActive`（`session-service.ts`）在 pi 不在进程表时调 `restoreSession` 拉起——spawn 新 pi → `switch_session` 附着 session 文件 → 注册进 Map。全部 9 个调用方均为 RPC/投递驱动，无定时自动触发。另有 `session.restore` RPC（用户点击 dead session）直连 `restoreSession`，**不经 ensureActive、无并发去重、无专属日志**。
- **forceQuit**：侧栏右键「强制退出」→ `forceQuitSession`（`message-dispatcher.ts`）：detach → SIGTERM 杀 pi → 写 stopped 终态 → **广播 occupancy 三维全复位帧** → 广播 `session.exited` → 删 Map 条目。设计本意是「杀死后重开即可恢复」。

### 1.3 设计目标（从使用者体验倒推）

- **G1 状态不撒谎**：pi 在跑（无论是谁发起的）时，发送门、排队门、侧栏处处显示忙碌；pi 空闲时处处可发。同一件事任何两处显示不得相反。
- **G2 停止即停止**：forceQuit 后，任何机制（前端队列、extension 通知、定时任务、子代理回流）都不得让**被杀的旧执行**自动复活；排队未投的消息不丢失，交还用户处置。边界：子代理回流等**新信息送达**触发的处理 turn 不属于「旧执行复活」（L5 裁定，见 §2.2 表与 D4）。
- **G3 恢复即干净**：重开 dead session 看到完整历史，不自动续跑旧 turn，可立即发新消息（同进程生命周期内；app 重启例外见 D4 被否栏，收敛环残余链例外见 D4 代价登记——例外全清单以 D4 为准）。
- **G4 进展可见**：长 turn 进行中用户能看到「在做什么、多久了、产出了多少」，并可选择中止；等待用户输入（ask_user）时不被误报为停滞。
- **G5 零回归**：正常发消息 / bash / compact / handoff / subagent 投递（session_manager send / completion-backflow）行为不变；live≡reload 等价性测试套件保持全绿。

### 1.4 in / out scope

**in**：runtime 忙碌状态写点收敛（B1）；forceQuit / restore 语义（B2）；前端 defer 队列在 forceQuit 时的处置；turn 进展观测面（C1，两阶段）；kill 路径可观测性。
**out**：A 组三项止血修复（拒绝分型反转 / pi tee 日志轮转 / 前端重投计数边界——已落地于 commit `5637e0088`，本文档把 A1 的结论吸收为 B1 转移表的一行，不重复设计）；pi 本体修改与 provider 稳定性（C2 议题）；subagent 域 record 模型与 chat 域统一（`fix-subagent-no-notification` 分支领地，仅登记对齐点，见 D8）；任何形式的 turn 自动中止（C1 明确否决，见 D6）。

---

## 2. 现状与问题分析

### 2.1 一次真实事故的完整解剖（2026-09-10，UTC 时间，每环有证据）

**本章结论：事故链的每一环都已定位到代码与日志证据，零未解环节；它是三个结构缺陷的叠加，不是任何一个单点 bug。**

| 时间 | 事件 | 证据 |
|---|---|---|
| 13:19:41 | 用户按 stop，turn aborted | runtime 日志 |
| 13:19:45 | 用户发「卡住了？」→ 该 turn 跑 9 分钟 | session 文件 entry |
| 13:28:23 | turn 以 socket error 收尾（provider 不稳） | session 文件 `stopReason=error` |
| 13:28:33 | **pi auto-retry 自发续跑**巨型 `write`（4 万字台账，~4 字符/秒） | runtime 日志 `bridge event: agent_start` |
| 13:28–14:12 | 45 分钟流式 delta。期间 occupancy=generating（`message_start` 驱动，正确），但 `isGenerating` 恒 false（三个置位点全绑 runtime 主动路径）——**双源漂移** | 代码写点枚举（§2.2 问题一） |
| 14:12:42–14:14:01 | 用户发的「继续」被预检放行（读 `isGenerating`=false）→ pi 拒 `already processing` → 旧 `handlePromptFailure` 无条件写 occupancy=idle → 前端 D1 短路失效 → **82 次 1 秒重投** | runtime 日志 82 行 `prompt failed` |
| 14:14:01.393 | 用户**强制退出** → SIGTERM 杀成功（exit 143） | runtime 日志 |
| 14:14:01.430→01.927 | forceQuit 的 **occupancy 全复位帧**触发前端 defer flush「继续」→ `ensureActive: restoring` → **0.5 秒复活** | 日志时序 |
| 14:14:02.876 | restore 后 pi `session_start` → **subagent-workflow notify replay 补投**（`subagent-bg-notify` custom_message）→ triggerTurn | session 文件 entry |
| 14:14:02.980 | `agent_start`——巨型 write「又跑起来了」（实为通知触发的新 turn 在相同上下文做相同的事） | bridge 事件 |
| 14:14:02.983 | 重投的「继续」再次被拒（already processing） | runtime 日志 |
| 14:14:03.104 | **exit 143，无任何 kill 日志**——用户点击 dead session → `session.restore` RPC → 裸 `restoreSession`（无去重）**清场杀掉 restore #1 刚拉起的 pi** | K3 路径（§2.2 问题二） |
| 14:14:03.107 | 再次 respawn + switch_session；本次无 replay turn（通知已被 #1 消费） | 日志 |
| 14:14:04.330 | 「继续」终于投递成功，新 turn 继续巨型 write | session 文件 entry |
| 14:30:07 | 第二次 socket error → `session_end outcome=error` → pi 再次 auto-retry | session 文件 + meta.json |
| 至 23:37+ | pi 仍在生成（9+ 小时） | pi tee 日志持续增长 |

### 2.2 三个独立问题域

**问题一（B1）：忙碌状态写侧分叉，漂移是结构不是疏忽。**

`isGenerating=true` 的写点全仓只有 3 个，全部绑定「runtime 主动发起」：发送预检通过置位（`message-dispatcher.ts` `markSessionActive`）、delivery 投递受理后置位（`session-delivery-registry.ts` `deliverText`——**它只写布尔不写 occupancy，是第三个漂移写点**）、A1 新增的 processing 拒绝反转。而 occupancy 的 11+ 个写挂点由 pi 事件驱动（`message_start`(assistant) → generating、`agent_end` → settling、`agent_settled` → idle、compaction/bash 各两点、forceQuit/进程退出全复位等）。pi 自发 turn 完整驱动 occupancy 走 `generating→settling→idle`，对三布尔却完全不可见。

两个直接后果：① 发送预检（读三布尔）在 pi 自发 turn 期间放行，把 prompt 送给必然拒绝的 pi；② `agent_end` 时三布尔复位为 false 而 occupancy 处于 settling——** settling 窗口内 runtime 预检认为闲、前端 D1 认为忙，两个门判定相反**（settling 是 pi post-run 收尾段，实测 P95 ≤ 2s）。

另登记：前端 `store.ts` 还有第三套 `isGenerating` 定义（由「存在 streaming 状态 assistant 消息」派生），是刻意的本地派生（驱动 stop 按钮），本次不动它，但三套定义必须显式登记防混淆。

**问题二（B2）：「停止」被建模为「杀进程」，而 turn 的存在性不在进程里。**

forceQuit 能杀死 pi 进程（K1），但「让 session 继续跑下去」的触发源全量 grep 核实有 7 条，kill 一条都管不着。每条标注两路归属——**session_start 腿**（restore 后 pi `session_start` 钩子内补投）与 **settled 补发腿**（abort/turn 结束的 `agent_settled` 边沿把 busy parked 的通知补投，`subagent-core/src/execution/notify-ledger.ts`：同边沿多条 pending 合并为一条注入，发送即乐观销账，重投超限写 abandoned 终态跨重启不复活）：

| # | 触发源 | 机制 | 腿归属 | 本设计裁定 |
|---|---|---|---|---|
| L1 | 前端 defer 队列自动 flush | forceQuit 的 occupancy 全复位帧恰是 flush 触发帧 → 队列里 forceQuit 前入队的消息被自动投递 → ensureActive → restore | 前端投递，经 runtime delivery | **D3 拦截**（队列回草稿，斩断投递权）——本事故主腿 |
| L2 | extension 通知补投（subagent-workflow notify-ledger） | `session_start` 恢复扫描补投未送达通知（`sendMessage(triggerTurn:true)`）；busy parked 的通知在 settled 边沿补投 | 两路都有（session_start 扫描 + settled 边沿补发） | **D4 拦截**（restore-abort + 收敛环） |
| L3 | scheduler 到期任务 | 同构 `triggerTurn`（本事故未命中） | session_start 扫描腿；到期时间驱动在 restore 后独立触发 | session_start 腿归 **D4 拦截**；restore 后正常到期的任务 = 新信息送达，同 L5 放行 |
| L4 | 用户点击 dead session | `session.restore` RPC → 裸 `restoreSession`——合法入口，但 L2/L3 会搭它的车 | 显式动作，意图是「看历史」≠「续跑」 | **D4 拦截**（restore-abort + 收敛环处理搭车形态） |
| L5 | completion-backflow | 子 session 完成/退出 → 回流通知经 runtime delivery 投递父 session → ensureActive 拉起父 pi | 经 runtime delivery（显式投递） | **放行**——新信息送达，语义不同于复活；显式投递同时清 userStopped 标记（见 D4）。代价四要素见 D4 效果栏 |
| L6 | base-tool-enhance 后台 bash 完成唤醒 | `background/notify.ts` `{deliverAs:"steer", triggerTurn:true}` | pi 进程内事件驱动；**forceQuit 杀 pi 后后台 bash 随进程消亡** | 不构成 forceQuit 复活腿（进程存活场景照常，不在本设计范围） |
| L7 | goal 完成唤醒 | `agent-end.ts` `sendMessage({triggerTurn:true})` 唤醒主 agent | 同 L6（pi 进程内，进程死则消亡） | 同 L6 |

附带两个已实证的次生缺陷：① `restoreSession` 无幂等保护——本事故中 restore #2（用户点击）把 restore #1（队列触发）0.6 秒前刚拉起的 pi 杀了重开（14:14:03.104 的「幽灵 exit 143」）；② kill 路径 K2（ping watchdog → abort 超时 → `forceQuitSession`）与 K3 都不打专属日志，导致「谁杀的进程」无法从事后日志定位。

**问题三（C1）：观测体系只有「进程死活」，没有「turn 进展」。**

ADR-0047 的 ping（每 60s get_state，3 连败判死）只能发现「进程死」。本事故的形态是「进程活着、delta 在流（4 字符/秒）、但 45 分钟零结构进展（单个 write 工具调用内）、且因 provider 不稳注定烂尾」——任何现有信号都不会触发，用户只能凭感觉发现「不对劲」，而发现后除了 forceQuit（问题二）没有任何体面的处置面。规则 19（任务级正常路径禁止墙钟超时、「静默 ≠ 卡死」）正确禁止了自动判死——空缺的不是「自动杀」，是「给用户看的判据」。

### 2.3 根因

**本章结论：三个问题域归到三条根因——写侧分叉、停止语义建错层、观测信号分层缺失；它们互为独立，必须各自修复，不存在「修好一个带动三个」的捷径。**

1. **写侧分叉（→B1）**：同一事件多处写、有的路径只写一边（`message_start` 只写 occupancy、`deliverText` 只写布尔、`agent_end` 两边各写一处且非原子）。漂移不是某个挂点写错了，是「允许只写一边」这个结构必然产出漂移。先例：本仓数据治理约束 C-data-04（`docs/constraints.json`，权威源 `docs/architecture/data-source-governance.md` / ADR-0062）「事件只做失效不直写数据、不发明第三种模式」的成功经验，D2 是同一范式在 occupancy 域的实例。
2. **停止语义建错层（→B2）**：「上下文延续」是数据问题（session 文件），「turn 触发」是开放集合（extension 的 `session_start` 钩子是公开 API，任何扩展都能 `triggerTurn`）。把「停止」建模为「杀进程」= 在错误的层解决问题——进程只是执行的载体，不是执行的存在性本身。与 fix-subagent-no-notification 分支 H1 设计的核心洞察（「上下文是数据问题，不是进程问题」）互为印证。
3. **观测信号分层缺失（→C1）**：现有体系有 L0（进程健康，ping）没有 L2（turn 结构进展：tool-call/message 边界）；而 L3（这次生成值不值得等）是语义判断，永远属于人——试图自动化它就是旧 watchdog「事件静默判死」打地鼠事故（ADR-0047 记载）的重演。

### 2.4 物理数据流（现状）

**状态写侧分叉图（问题一）**：

```
pi 事件流                     runtime 写点                     消费门
─────────────────────────────────────────────────────────────────────
message_start(assistant) ──→ occupancy.turn=generating ──────→ 前端 D1/发送路由（正确判忙）
                        ╲──（无写点）──→ isGenerating 恒 false ─→ 预检/compact门/isIdle（误判闲）

deliverText 受理 ────────→ isGenerating=true ────────────────→ 预检（判忙）
                        ╲──（无写点）──→ occupancy 不变 ─────────→ 前端门（与上相反）

agent_end ───────────────→ occupancy.turn=settling ──────────→ 前端 D1（判忙）
                        ╲→ isGenerating=false ───────────────→ 预检（判闲）← 两个门相反
```

**复活链路图（问题二，本事故实际走通的腿）**：

```
forceQuit → SIGTERM ✓ → occupancy 全复位帧 ──→ 前端 defer flush（L1）
                                              → ensureActive → restoreSession
                                                → spawn pi → switch_session
                                                  → session_start 钩子
                                                    → notify replay triggerTurn（L2，session_start 腿）
                                                    → agent_start（旧上下文续跑）
                                              ⇢ settled 补发腿（L2 另一路）：被 abort 掐掉的 turn
                                                收尾时 agent_settled 边沿 → busy parked 通知
                                                attemptDeliver → restore 返回后自动开新 turn
用户点击 dead session（L4）→ 裸 restoreSession → 清场杀上一个 pi（无日志）→ 重开
```

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**本章结论：修复后，「pi 在跑」处处可见、「停止」点了就真停、「重开」干净可用、长 turn 进展自明。**

**成功路径 A（自发 turn 不再隐形，G1）**：

```
[provider 抖动] pi socket error → auto-retry 自发续跑
→ 侧栏该 session 显示「工作中」（occupancy 单一权威驱动），Composer 停止按钮可用
→ 用户此时发消息 → 发送门判忙 → 消息进 defer 队列（气泡 pending 可见）
→ pi 级联结束（agent_settled）→ occupancy idle 帧 → 队列自动投递 → 正常开跑
（全程零死循环、零误判、零静默）
```

**成功路径 B（forceQuit 完整语义，G2/G3）**：

```
[turn 进行中 + 队列有 1 条消息] 用户侧栏右键「强制退出」→ 两段确认
→ 前端：队列消息回收到 Composer 草稿（可见、可改、可重发）
→ runtime：杀 pi ✓ → 置 userStopped 标记 → occupancy 复位 → session.exited
→ 无任何自动复活（无 ensureActive 日志、无 agent_start）
[用户点击该 dead session]
→ restore：spawn → switch_session → session_start 钩子触发 notify replay turn
→ restoreSession 返回前检测到 userStopped → abort 掐掉 replay turn
→ 若掐掉的 turn 收尾时 settled 边沿补投 parked 通知开新 turn（补发腿）：
   标记存活期内 runtime 观测到 agent_start 一律再 abort，直到一次 turn 收尾
   未引出新 turn（收敛）→ 清标记
   （多通知时用户可能看到断续「跑-停」直至收敛，轮数有限，见 D4 代价登记）
→ 用户看到：完整历史（通知 custom_message 也在其中，内容不丢）+ 输入框可用
   （补发 turn 若被掐，其注入内容已落盘历史，只是不续跑）
→ 用户发新消息 → 正常工作（显式投递清标记，新 turn 是显式意图，不受任何闸门拦截）
```

**成功路径 C（长 turn 观测面，G4）**：

```
[单个 write 工具调用流式 12 分钟]
→ 输入框上方常驻：「本 turn 已 12 分钟 · 当前 write 调用已 11 分钟 · 已生成 32k 字符」
→ 超过提示阈值后渲染为警示色 + 操作项：「[中止此 turn] [继续等待]」（不预置推荐）
→ 用户点「中止」→ 走既有 abort 链路（abort 无响应时 forceQuit 兜底——语义已被路径 B 修好）
[ask_user 等待用户回答期间]
→ 显示「在等待你的输入」，永不显示「停滞/可能卡死」
```

**失败路径（带恢复指引）**：

| 场景 | 行为 | 恢复指引 |
|---|---|---|
| restore-abort（含收敛环内再 abort）失败（pi 无响应） | 按既有 abort 失败链收口：RPC 超时 → `forceQuitSession` 强杀 + 广播（该链路已有；kill 日志补齐后可见）；标记保留，收敛环未完成 | 用户再点一次「强制退出」即达终态；日志含 kill 源 |
| forceQuit 时 pi 已自行退出 | 幂等成功（现状保持），队列照常回草稿 | 无需动作 |
| 转移原语遇到进程退出等异常 | `full-reset` 转移兜底（既有 #10 腿），派生三布尔同步复位——结构上不再有「只复位一边」 | 无需动作 |
| L2 提示帧后 pi 恢复正常推进 | 提示帧只陈述事实不锁状态，结构边界到达即自动消失 | 无需动作 |
| A 组止血与本设计迁移间隙 | A1 的拒绝反转 = 转移表 `reject-processing` 行的提前落地，迁移是改调原语而非改语义 | 无需动作 |

### 3.2 多方案对比

**议题 B1（消灭双状态源）**：

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 纯投影：删三布尔，消费方全改读 occupancy | 最纯净，但 blast radius 最大：6 处读点（预检/bash互斥/compact门/delivery isIdle/summary/reload）每处都要重新裁决「settling 算不算忙」，还牵动 toSummary/wire/前端 | 高 | 高：漏一处就是一个新 bug | ❌ |
| B. 同步双写：保持两源，在 occupancy 回调里同步派生三布尔 | 见效快但治标不治本：回调之外的写点（预检置位、deliverText、agent_end 副作用）不经该回调，依然会漏 | 低 | 中：结构上「允许只写一边」还在 | ❌ |
| **C. 单一写原语 + 派生存储**：所有状态转移经 `applySessionOccupancyTransition`（建议新增）一个入口——内部原子完成「合并 occupancy 三维 → 按转移类型派生三布尔 → 幂等比较 → 广播」；三布尔保留（读侧零改动）但降级为只许经原语写的派生存储 | 好：写侧收敛 = 漂移结构性不可能；读侧不动 = 零行为回归。与本仓数据治理约束 C-data-04「事件只做失效不直写」同一家族 | 中：枚举 14+ 挂点逐一改调 + 转移表定义 + 防回潮守卫 | 中低：派生规则定义错会系统性错（好处是只错一处、一处修全好） | ✅ |

**被否若用**：方案 A 下，每个读点迁移都是一次语义重裁——`deliverText` 的 isIdle 若漏判 settling，session_manager send 在 settling 窗口直投成功、与前端 flush 双投递；方案 B 下，下一个新增挂点（如本次 A1 的拒绝反转）仍要手工记得写两边，漂移只是时间问题。

**议题 B2（forceQuit 语义）**：

| 方案 | 评价 | 裁决 |
|---|---|---|
| 只做第一层（前端清队） | 止血本事故主腿（L1），但 L2/L3 搭 L4 车的形态还在（用户点开 dead session 就可能触发 replay turn） | 短期方案，可作独立 PR 先合 |
| 只做第二层（restore-abort） | 覆盖全但体验差：队列旧消息会先投递、跑起来、再被 abort——用户看到「跑了又死」且浪费 provider 调用 | ❌ 单用 |
| restore-abort 一次性消费（v1 形态：abort 掐掉 replay turn 后即清标记）—— **被 notify-ledger 补发腿击穿（R1 影响面审反例）**：abort 掐掉的 turn 收尾产生 settled 边沿 → busy parked 的下一条通知在该边沿补投开新 turn，此时标记已清无闸，恢复即不干净。改为收敛环（标记存活至收敛，见 D4） | ❌（谱系登记） |
| **三层组合**（前端清队回草稿 + userStopped 标记 restore-abort 收敛环 + kill 日志/restore 幂等） | 各治其层无重叠；时序构造性错开（见 D4） | ✅ |
| extension 层特判（notify replay 前查标记） | 把 runtime 语义泄漏进 extension；且触发源是开放集合（未来新 extension 也能 triggerTurn），打地鼠 | ❌ |
| forceQuit 不发 occupancy 复位帧 | 投影必须说真话——进程死了 occupancy 就是 idle；该砍的是旧消息的自动投递权，不是帧。砍帧还会让前端投影永卡 generating | ❌ |
| ensureActive 读 session_end sidecar 做 restore 门禁 | runtime 无法区分「forceQuit 前入队的旧消息」与「forceQuit 后新打的消息」（都经 sendPrompt → ensureActive），粗门禁误伤合法新发；精确切口只在前端（只有前端知道队列重放 vs 新输入） | ❌ |

**议题 C1（turn 观测面）**：

| 方案 | 评价 | 裁决 |
|---|---|---|
| 一、纯前端 turn 计时条 | renderer 本地算「turn 时长/当前工具时长/已产字符」+ 警示色 + 既有 stop；零协议改动零误杀 | ✅ 短期先做 |
| 二、runtime L2 停滞提示帧 | N 分钟无结构边界（tool-call/message 边界，delta 不算）→ 发 session 级提示帧（独立帧类型）→ 前端渲染事实 + 「[中止][继续等待]」 | ✅ 长期跟进 |
| 三、阈值自动降级/自动中止 | 违反规则 19；「该杀」是事后诸葛亮，事前没有安全判据 | ❌ 明确否决 |
| 四、复用 `message.stream_warn` 通道 | ADR-0047 刚把该通道信号源从「事件静默」矫正为「ping 失败」，语义刚掰直——L2 必须开独立帧类型，否则两个不同语义信号又焊回一个通道 | ❌ |

### 3.3 关键决策（四件套）

#### D1【B1 立场】occupancy 投影为体、pi 拒绝为用

- **采用**：忙碌状态的权威语义源 = occupancy 投影（事件驱动，覆盖 pi 自发 turn——`message_start`(assistant) 驱动 generating，auto-retry 每轮完整重放生命周期）；A1 的「processing 拒绝 → 置 generating」从症状补丁转正为投影的**未观测 turn 探测器**（rejection-driven reconciliation）——pi 的忙闲拒绝是事件链断裂时的权威兜底信号。
- **被否**：「pi 拒绝即唯一权威」——拒绝只在发送时刻发生，预检仍需本地状态，它只能当探测器不能当存储；「另造 turn 存在性探测机制」（原分组讨论的选项二）——occupancy 已经是这个机制，再造一套是三源。
- **证据**：runtime 侧 occupancy 读点为零（全部 isIdle 判定读三布尔）；`isGenerating=true` 写点精确 3 个全绑 runtime 主动路径；事件链经实装 pi 0.84.4 dist 核实（`turn_start` 在 runtime 是 NULL_EVENT，`message_start`(assistant) 才是 turn-start 的物理来源）。
- **效果**：G1 的「pi 在跑处处可见」在自发 turn 场景成立。

#### D2【B1 核心】单一写原语 `applySessionOccupancyTransition`（建议新增）+ 派生存储

- **采用**：引入唯一转移入口，转移类型为**封闭枚举**（转移表即文档）：`dispatching / generating / settling / idle / compacting± / bash± / full-reset / reject-processing / reject-other`，外加为 fix-subagent-no-notification 分支 abort 三级阶梯预留的 `abort-stall-converged / abort-stall-force-kill` 两行（对齐点见 D8）。原语内部原子完成：合并 occupancy 三维 → 按转移类型派生三布尔 → 幂等比较 → 广播。14+ 个现有挂点（interpreter #2-#6、dispatcher #1/#7-#9/#11、forceQuit/onSessionExit 全复位、deliverText 置位——落地走 `dispatching` 行（受理后投影即时广播，消灭「只写布尔不广播」漂移写点）、agent_end 副作用、A1 拒绝反转）逐一改调。**settling 语义裁决**：预检门读 occupancy 后，settling 计为忙（与前端 D1 归一）→ 拒绝转 `send.rejected{busy}` → 消息入队 → `agent_settled` idle 帧自动投递。这是有意的行为变更（原 settling 窗口直发成功的消息现在延迟 ≤2s 投递），消息不丢、顺序不变、双门归一，PR 中显式声明。**既有宣告帧特例的处置（§1.2 登记的 Gate B V6b④）**：`registerSession` 的 idle 宣告帧收编进原语为封闭枚举新行 `announce-idle`——语义 = 「强制广播当前投影，跳过全等去重」（内部合并/派生均为 no-op），原语成为广播的唯一出口，防回潮守卫无需豁免名单。**通路归属**：announce-idle 的广播走原语既有 state-topic 通路——实时广播 + 快照写入/重订阅回放双腿随通路保留（V6b④ 语义完整，实施不得绕过 state topic 裸 publish）；occupancy-runtime 测试 Part D 守卫保持「重订阅回放必达」断言作为收编后的回归锚。**防回潮**：三布尔在类型层改 readonly（或 taste-lint 自定义规则禁直写），绕开原语直写在检查期即红。
- **被否**：方案 A（纯投影删三布尔）、方案 B（回调同步双写）——见 §3.2 B1 表；宣告帧特例保留原状 + 守卫豁免名单——豁免名单是第二个「允许绕开」的口子，未来每个新合法特例都要加名单，且「广播出口唯一」不变量被打破，不如收编为枚举行。
- **证据**：`updateSessionOccupancy` 已是单原语幂等写（本设计是它的挂点侧收敛）；本仓约束 C-data-04「事件只做失效不直写数据」（`docs/constraints.json`）同族先例；deliverText 漂移写点（`session-delivery-registry.ts`）实测确认。
- **效果**：G1 全场景 + G5「读侧零回归」；A1 止血被自然吸收为 `reject-processing` 行（不推翻并行会话的工作）。

#### D3【B2 第一层】forceQuit 点击即清 defer 队列，内容回 Composer 草稿

- **采用**：前端在 forceQuit **RPC 确认成功后**（失败 = 停止未生效，队列保留不清）：清空该 session 的 defer 队列（含已提交未确认的在途条目——pi 已死后确认帧永不再来，一并回收才能把文本交还用户）+ 清 1s 重投 timer，队列文本**回收到 Composer 草稿**（可见、可改、可一键重发），给一条「N 条排队消息已收回草稿」的显式提示。「继续等待」操作项语义 = 抑制本 turn 警示色，事实条照常展示，turn 结束自动复位。
- **被否**：直接丢弃——违背「消息不丢」的一贯纪律，用户打过的字不该因一个停止动作消失；保持队列现状（等 idle 帧自动投）——那正是本事故的复活主腿 L1。
- **证据**：复活链路 L1 的代码闭环（forceQuit 全复位帧 = flush 触发帧，`message-dispatcher.ts` forceQuitSession 第 4 步 + `useChat.ts` flush 门）；前端 `handleSessionExited` 现状只 markDead+toast、不做任何队列处置。
- **效果**：G2 的「队列不自动复活」+「消息不丢」；斩断本事故主腿。

#### D4【B2 第二层】userStopped 标记 + restore-abort 收敛环

- **采用**：`forceQuitSession` 置 per-session `userStopped` 标记，`restoreSession` 返回前与标记存活期内把「无外部意图的 turn」全部掐掉，直到收敛。三个规格点：
  - **标记宿主与生命周期**：标记按 sessionId 键控、存独立于 `ManagedSession` 的模块级 Map（`session-service.ts` 持有）——forceQuit 尾步 `removeSessionEntry` 会删 Map 条目，标记必须独立存活才能被后续 restore 读到。清理路径全列：restore 收敛消费（主路径）/ delete session / destroyAll / runtime 进程退出（内存态整体消亡，天然清理）。
  - **置位点分型（forceQuitSession 加 source 参数）**：仅「用户要停」的调用方置标记——K1（用户强制退出）、K2（用户 abort 无响应的超时强杀收口，`message-dispatcher.ts` abort 失败链）；K3/K5/K6/K7/K8（restore 清场、delete、destroyAll、孤儿收殓、异常退出收敛）不置——pi 崩溃等非用户意图场景不继承「停止」，restore 后 notify replay 属设计内行为照常补投。前端 D3 清队仅挂用户显式强制退出入口（K2 强杀不经前端，队列照常等 idle 帧自动投递——显式投递见下条）。
  - **收敛环**：`restoreSession` 在 switch_session + registerSession 成功、**返回前**检测标记：在 → `await client.abort()`（对 idle pi 是无害 no-op，对 replay turn 是精准中止）；**标记不在此清**——notify-ledger 有两条投递腿（`session_start` 恢复扫描 + **settled 补发腿**：abort 掐掉的 turn 收尾产生 `agent_settled` 边沿，busy parked 的通知在该边沿补投开新 turn），一次性 abort 后清标记会被补发腿击穿（R1 审查反例，见 §3.2 被否谱系）。改为：标记存活期内，runtime 事件流观测到**非显式投递引发的 `agent_start` 一律再 abort**；**收敛判定** = abort 调用完成即起算静默观察窗（初值 3s，实施期按 P-1 实测标定；无论本窗是否实际掐过 turn，restore 无 replay turn 的 idle 场景同样有明确起点），窗内有 turn 被掐则由其 `agent_settled` 边沿重置观察窗（**主 restore-abort 掐掉的 replay turn 其 settled 边沿同样计入重置**——它是「有被掐 turn」的事后信号），窗满**且最后一次被掐 turn 的 `agent_settled` 已到达**（掐而 settled 未到——pi 收尾卡顿超窗——则窗满不清，待 settled 到达后重起算）→ 判收敛 → 清标记。该观察窗是「确认补发源已耗尽」的判定窗，性质不同于 D5 被否的「赌无并发的冷却窗」。**有界性（轮数）**：notify-ledger 实装机制 = 受理即 sent（`sentAt` 置位、attempts 递增）；销账 = 回执判定（session 文件出现 notifyId 匹配的 custom_message entry）后 appendEntry(ack)——sent 条目随后被 abort 不影响销账（注入内容已落盘历史）；重投达上限（`NOTIFY_REDELIVERY_MAX_ATTEMPTS`）写 abandoned 终态跨重启不复活。待补投条目有限 → 收敛环至多 N+1 轮（N = parked 条目数）。**主链收敛论证（三重）**：① 受理即 sent → 判收敛时无「未受理」条目；看门狗转回重投仅作用于「sent 超期无回执」条目，而正常链回执判定秒级完成（custom_message entry 随 sendMessage 同步落盘）；② settled 边沿回调内 isIdle 恒真（notify-ledger 实装：`_emitAgentSettled` 先复位 `_isAgentRunActive` 再发事件）→ settled 边沿投递必成功不挂回；③ 挂回仅发生在「新 run 已启动」竞争，收敛环内 runtime 不投则无竞争源。**异步重投残余链（登记接受）**：挂回 pending、sent 超期由 120s 看门狗转回 pending 的时点均可落在标记清除（3s ≪ 120s）之后，届时补投开的 turn 无闸跑起——定性 = 跑的是通知 turn，新信息送达语义（同 L5 放行），非被杀旧执行复活；attempts 上限 + abandoned 终态兜底有界；前置极窄（需受理失败挂回或回执判定漏观测，正常链秒级 ack）；重审触发条件 = P-1 实测若残余链可观测地出现（非理论推演），即重审收敛窗与看门狗时钟的对齐方案（如标记清理推迟到首个看门狗周期之后，或残余重投的 agent_start 继续纳入拦截）。「恢复即干净」在该窄窗口存在此登记例外。上述论证依赖 pi 内部时序细节，P-1 标定时顺带观测一轮看门狗形态作实证收尾，并声明观察是否覆盖一个完整重投周期（120s）的盲区。**已知窄窗口误伤**：收敛窗内恰逢 scheduler 任务到期触发（extension 直发 pi、不经 runtime、与补发腿对 runtime 不可区分）会被掐——后果 = 该次执行延迟至下一 tick 或丢失（任务历史可查），概率极窄（秒级窗 × 任务到期时刻重合），登记接受。**显式投递清标记**：runtime 经手的投递（delivery/sendPrompt、backflow 回流、用户新消息）= 新意图，投递前清标记正常放行——补发腿不经 runtime 所以不适用，二者的区分点是投递路径本身，无需识别 turn 触发源。用户点开后立即发消息与补发投递的毫秒级竞态：行为 = 补发 turn 先跑到结束（内容为新信息送达）→ idle 帧 → 队列投递用户消息，有界不发散，不加机制。
- **时序论证（修正版）**：session_start 腿的 replay turn 全部发生在 `switch_session` 期间 = restore 返回前——abort 插在 restoreSession 返回前正好卡住左侧；settled 补发腿与 pi 内核 followUp 队列在 restore 返回后开 turn，由收敛环的 agent_start 拦截覆盖；一切外部 prompt（delivery、backflow、用户新消息）经 runtime 显式投递路径，清标记放行——「复活」与「新意图」的分界 = 是否经 runtime 投递。
- **被否**：原 P1-4「ensureActive 闸门拦 restore」——与「重开即可恢复」的产品承诺打架，且拦不住 L4（用户点开看历史是合法需求）；「abort 单用」——对 post-restore 到达的 prompt 无效（explorer 竞态质疑成立），所以必须有 D3 砍掉 L1 后才成立；「abort 一次性消费后清标记」（v1 形态）——被 settled 补发腿击穿，见 §3.2 被否谱系；**标记持久化到 sidecar**——进程重启场景不该继承「停止」意图（重启 = 用户重新打开 app 的显式动作 = 新语义周期）。该裁决的残留代价四要素：形态 = forceQuit → app 重启 → 用户点开该 session 的窗口内 replay turn 无闸跑起（一条通知触发的有限 turn，跑完自然结束，非死循环）；量级 = 低频（需重启恰好插在 forceQuit 与点开之间）且后果有限；恢复路径 = 复活后用户再 forceQuit（本设计修好的语义）或等 turn 跑完；重审触发条件 = 实测出现一例重启窗口复活造成实际困扰，即重审持久化方案。
- **证据**：notify replay 铁证（session 文件 14:14:02.876 `subagent-bg-notify` custom_message → 02.980 agent_start）；settled 补发腿实装（`subagent-core/src/execution/notify-ledger.ts` 头注②：settled 边沿 + 120s 看门狗触发 attemptDeliver，isIdle 二次复查失败挂回 pending；subagent-workflow `session-lifecycle.ts` onAgentSettled 注册）；pi 实装 abort 对无活跃 run 幂等无副作用（`agent-session.js` dispose/abort 路径）；第二次 restore 无 replay turn（通知已被消费）佐证触发源类型。⛔探针 P-1：实测 restore 后 abort 对 `session_start` 内 triggerTurn 已起跑 turn 的中断时序（预期：abort RPC 在 turn streaming 期间到达即中断；若 pi 在 switch_session 完成前不处理 abort RPC，则 abort 排队到 switch 完成后立即生效——两种形态都达成终态，但时序需实测标定）**+ 补发腿场景：≥2 条 pending 通知下完整收敛环的行为标定**（见 §3.5）。
- **效果**：G2「被杀的旧执行不复活」覆盖 L2/L3/L4 搭车形态及其补发腿；G3「恢复即干净」含多通知场景。**已登记代价**：收敛环轮数有界（N+1）但**轮时长无上界**——每轮被掐 turn 从 agent_start 到 abort 生效的已执行时长取决于 turn 自身（任务级无墙钟超时，规则 19；本事故同形态通知 turn 实测跑 9+ 分钟），最坏恢复期 = N 轮 × 无界轮时长，用户感知 = restore 后断续「跑-停」直至收敛；恢复 = 收敛后自然结束；重审 = P-1 实测若轮时长远超预期，评估掐前软化手段。**L5（backflow）放行的代价四要素**：形态发生率 = 父 forceQuit 时仍有在跑子 session 的组合（低频）；恢复路径 = 父被唤醒处理子结果属正常新信息流，用户可再 forceQuit；重审条件 = 实测出现 backflow 唤醒后再次进入异常执行循环，重审把 backflow 并入标记拦截；显式判定 = 本设计裁定放行（V4 子场景 c 固化验收）。

#### D5【B2 第三层 + 配套】kill 路径全量日志 + restoreSession 幂等短路

- **采用**：① 所有 kill/destroy 路径（K1 forceQuit、K2 abort 超时自愈、K3 restore 清场、K5 delete、K6 destroyAll、K7 启动孤儿收殓、K8 异常退出收敛）打 warn 级日志——含调用源与触发信号链（「谁发起、为什么」），与 D4 的 source 参数同源（日志同时区分「用户意图停止」与「runtime 内部收敛」两类）；写入面走既有 `<getDataDir>/logs/` date+size 轮转，kill 为低频事件无速率风险（R1 影响面审核实放行）；② `session.restore` RPC 在 client 已活跃且未退出时短路复用（等价 ensureActive 的既有分支），不再无条件 `restoreSession` 清场重开。
- **被否**：给 restoreSession 加「同文件冷却窗」——时间窗是启发式，短路复用是确定性判断，更直。
- **证据**：本事故「第三条腿」（14:14:03.104 exit 143 无任何 kill 日志）排查耗时一整晚的直接教训；K3 撞车实证（restore #2 杀掉 restore #1 0.6 秒前的新 pi）。
- **效果**：下一次同类事故从日志直接定位 kill 源；restore 撞车形态消除。

#### D6【C1 核心】L2 结构进展观测面，两阶段落地，永不自动中止

- **采用**：观测与裁决彻底分离——系统只陈述事实，中止/继续永远由用户点。信号定义三层：L0 进程健康（ping，已有不动）；**L2 结构进展 = tool-call/message 边界事件流**（delta 不算进展；判据形态借鉴 subagent-core 两段式 watchdog「有效协议事件行刷新」），辅助信号 = 事件窗活跃戳（`lastEventAt` 模式，见 D8）；L3 语义价值（这次生成值不值得等）明确属于人，不自动化。**豁免态**：`extension-ui` pending（ask_user 等用户输入）不是停滞——只改提示文案分型（「在等待你的输入」），不参与停滞计时。与旧 watchdog `pauseWatchdog` 打地鼠的本质区别：那是拿豁免做杀/不杀判据（漏一个 = 误杀），这是拿豁免做文案分型（漏一个 = 措辞不准，零伤害）。落地两阶段：方案一（前端纯本地计时条，renderer 本来就在收全部流式事件）先做；方案二（runtime L2 提示帧，独立帧类型，**ephemeral——仅 live 消息流实时可见，不入持久化通路，reload 后不复活**：停滞是瞬时状态，持久化它违背「状态不撒谎」且撞 live≡reload 构造性等价不变量，见被否栏）跟进。**信号源不依赖 `turnStartedAt` 单点**——其语义已在兄弟分支漂移过一次（genstats-speed-llm-window 改为 LLM 窗口口径），用事件边界流天然免疫此类漂移。**已接受代价登记（C1 否决自动中止的反面）**：pi auto-retry 无限循环 + 无自动中止 = 用户不在线（夜间）时 session 持续消耗 provider 的形态维持现状（本事故实测 9+ 小时）——接受，依据 = 自动中止违反规则 19 且「该杀」是事后判断（ADR-0047 打地鼠教训）；本设计补上的观测面把「发现」交给用户后，此代价的重审挂靠 C2（provider 稳定性议题）。
- **被否**：自动中止/自动降级（违反规则 19，且本事故的「该杀」是事后判断）；复用 `message.stream_warn` 通道（ADR-0047 刚把它的信号源掰直为 ping 失败，L2 开独立帧类型）；**L2 帧入持久化通路**——撞 live≡reload 构造性等价（applyEntry reducer 需扩帧类型 + 等价性测试扩面），且持久化瞬时停滞态 = 重开后历史撒谎，零收益。
- **证据**：ADR-0047 事故复盘（事件静默判死的打地鼠教训）；规则 19 超时默认原则；本事故 45 分钟单工具调用的真实形态（byte 有流、structural 零边界、semantic 无效——三层信号表现各异，正是分层必要性的实证）。
- **效果**：G4 全场景；规则 19 与 ADR-0047 边界不被侵蚀。

#### D7【C1 配套】文案即语义 + 阈值与 P3 实测共用

- **采用**：提示文案纪律——只陈述事实（「仍在执行：write 已 12 分钟，已生成 32k 字符」），禁止判断词（「卡死/无响应/异常/建议中止」），操作项中性不预置推荐。停滞提示阈值初值 10 分钟（与兄弟分支 FROZEN 窗同量级），**定值与 fix-subagent-no-notification 分支的 P3 门（三类会话事件间隔分布实测）共用一次实测**，数据落地前严禁收窄。
- **被否**：两条分支各定各的数——合并后互相矛盾，且同一总体的实测做两遍是纯浪费。
- **证据**：兄弟分支 fix-subagent-no-notification 的 `FROZEN_EVENT_SILENCE_MS_DEFAULT = 600_000`（源码 fix-subagent-no-notification@`packages/runtime/src/services/session/message-dispatcher.ts` 常量定义；决策与 P3 门登记见 fix-subagent-no-notification@`docs/design/chat-domain-v1x-liveness-governance.impl-plan.md` W7 行）的「P3 实测待定，严禁调小」注释（同样保守姿态的先例）。
- **效果**：提示不重新引入「静默=卡死」的暗示；两个分支阈值口径归一。

#### D8【全局】与 fix-subagent-no-notification 分支的三个对齐点

- **采用**：本工作独立落地（不共建——该分支 275 提交未合并，共建绑架合并时序；文件重叠但区域错位：他们动 abort 路径，本设计动预检/挂点族），但登记三个对齐点：① 其 abort 三级阶梯（兄弟分支 `docs/design/chat-domain-v1x-liveness-governance.{md,impl-plan.md}`，决策号 W7）的两路收口（重试收敛/阶梯强杀）写 `isGenerating/occupancy`，B1 转移表预留对应转移行——后合并一方负责接线；② 本设计 D4 使其阶梯 2「移交用户 forceQuit」的语义严格变好（走到那里的用户本来就想要「真停住」），双方文档互登记；③ C1 方案二复用其 `RpcClient.lastEventAt` 模式与 P3 实测——其先合并则去重，先落地则自带约 15 行同模式原语。
- **被否**：站在该分支上开发——止血 PR 不该等架构分支的时间表。
- **证据**：两分支 diff 逐文件核对（message-dispatcher/event-interpreter/types 区域错位确认）；该分支会话治理设计的核心洞察「上下文是数据问题，不是进程问题」（决策号 H1，载体文档随其合并入库时互登记）与 D4 根因互证；其终态 sidecar 单一写权威（决策号 H4）与 D2 同族。
- **效果**：两分支合并无语义冲突；合并顺序自由。

### 3.4 错误规格

| 错误 | 触发 | 形态 | 恢复 |
|---|---|---|---|
| restore-abort 失败 | restore 返回前 abort RPC 超时/断链 | 走既有 abort 失败链：超时 → forceQuitSession 强杀收敛（D5 日志含源，K2 语义置标记）；标记不视为已消费（收敛环未完成，下次 restore 重试） | 用户再点「强制退出」；日志定位 |
| 收敛环内 scheduler 任务恰到期被掐 | 收敛观察窗（秒级）与任务到期时刻重合 | 该次执行被 abort，任务延迟至下一 tick 或丢失 | 任务历史可查；概率极窄，登记接受（D4） |
| 转移原语遇到未知转移类型 | 新挂点未登记转移表 | 编译期类型错误（封闭枚举 + readonly 守卫），运行时不可能到达 | 开发期修复转移表 |
| `session.restore` 短路命中 | client 活跃未退出时点击 dead session | 直接返回现有 summary（等价 ensureActive 短路），不杀进程不重开 | 无需动作 |
| L2 检测在 extension-ui pending 期间 | ask_user 等待 | 不计停滞、不发停滞帧；若发则属 bug，降级为措辞问题零伤害 | 无需动作 |
| L2 帧 reload | 重开 session 后 | ephemeral 语义：停滞提示不复活、历史无残留帧；出现残留即 bug | 修复前端帧生命周期（不入持久通路） |
| 前端草稿回收时 Composer 已有内容 | forceQuit 时输入框非空 | 队列文本追加到现有草稿之后（不覆盖用户正在输入的内容） | 用户手工整理 |

### 3.5 运行时断言与探针清单

| ID | 断言 | 探针 | 状态 | 失败时降级 |
|---|---|---|---|---|
| P-1 | restore 返回前的 abort 能中断 `session_start` 内 triggerTurn 已起跑的 turn（或排队到 switch 完成后立即生效）；**≥2 条 pending 通知下收敛环收敛**：第一条被掐后的 settled 边沿补发第二条 → 收敛环再 abort → 至「abort 起算的静默窗无新 agent_start」清标记，全程无不受闸的 turn；顺带观测一轮 120s 看门狗形态作 D4 主链论证的实证收尾 | 本地 pi RPC 实测：构造含 ≥2 条 pending notify 的 session（ledger 无 ack 条目），forceQuit 置标记 → restore → 观察 abort 链与收敛判定时序 | ⛔实施期门 | 场景 1 降级（abort 被 pi 排队）：改为 restore 前先发 abort（对新 spawn 的 idle pi 无害），或标记延长到「首个 agent_settled 后清」；场景 2 降级（收敛判定不可靠）：静默观察窗按实测延长，或标记清理点推迟到「用户显式投递 / delete / 下次 forceQuit」。**盲区声明**：若观察窗不覆盖一个完整重投周期（120s），异步重投残余链（D4 登记）不被本探针覆盖，以登记例外为准 |
| P-2 | settling 窗口预检拒绝的行为变更不影响正常发送吞吐 | 引用既有 settling 探针门数据（本仓 `docs/design/session-occupancy-send-closure.md` 验收门：P95 ≤ 2s）+ 迁移后真实会话回归（§4 V7 正向 + V3 对照） | ✅已有数据 | 若实测 settling 长尾远超 2s：预检对 settling 放行但转 steer 语义（投递而非拒绝）——语义归一的替代形态 |
| P-3 | L2 提示阈值（10min）覆盖率与误报率 | 与 fix-subagent-no-notification P3 共用：三类会话（正常 turn / 长工具 / ask_user）事件间隔分布实测 | ⛔实施期门（阻塞 C1 方案二，不阻塞方案一） | 数据不足时方案二不落地，方案一（纯本地展示、无阈值判定）不受影响 |
| P-4 | 转移原语迁移后 live≡reload 等价 | 既有 apply-entry-equivalence 等价性测试套件 + 全量 vitest | ⛔实施期门 | 等价性破 = 迁移漏挂点，按测试报告补挂点后重测 |

---

## 4. 验收（真实场景，非单测非 mock）

**本章结论：8 个真实场景覆盖 G1-G5，每个回溯设计目标；B1/B2 的验收在 dev 环境真实 pi + 真实 provider（或故障注入代理）下跑，C1 方案一随 PR-4 验收、方案二随 P-3 实测后验收。**

### 4.1 改动规模

大改动（状态机收敛 + 行为变更 + 新观测面）——按多场景真实验收执行。**断言归属**：V1①② 是 D3+D5①（PR-1）的效果，V1③④ 依赖 D4（PR-2）；PR-1 独立验收时只跑 V1①② + V6（V1③④ 在 PR-1 状态下不可满足——L2 闸门未落地），PR-2 起跑 V1 全量。

### 4.2 验收场景

| # | 场景 | 回溯 | 真实流程（谁、什么上下文、做什么、看到什么） | 通过标准 |
|---|---|---|---|---|
| V1 | forceQuit 完整语义（本事故复现形态） | G2/G3 | dev 环境：构造「pi turn 进行中 + 队列有 1 条消息」（可用慢速 provider 或故障注入让一个长 write 在跑，期间发一条消息使其入队）；**前置条件：该 session 无在跑子 session、无 pending 后台通知**（此两形态分别由 V4 子场景覆盖）→ 侧栏右键强制退出 → 观察 60 秒 → 点击该 dead session → 发新消息 | ① 60 秒内无 ensureActive 日志、无 agent_start（不复活）② 队列文本出现在 Composer 草稿且有提示 ③ 点击后历史完整可见、无 replay turn（occupancy 恒 idle）④ 新消息正常开跑 |
| V2 | pi 自发 turn 不再隐形（B1 主场景） | G1 | dev 环境：故障注入代理对 provider 请求注入一次 socket error → pi auto-retry 自发续跑 → 期间观察侧栏 + 发一条消息 | ① 自发 turn 期间侧栏显示工作中（不再幽灵空闲）② 消息被拒进队列（气泡 pending 可见），无 1 秒重投死循环（日志无连续 prompt failed）③ pi 级联结束后队列自动投递成功 |
| V3 | 正常链路零回归（除已声明行为变更） | G5 | dev 真实会话全链路：发消息 / bash / 手动 compact / handoff / subagent 派发 + session_manager send / 切模型；覆盖侧栏 ActivityStrip 活动条与 composer 队列区 defer 行展示 | **除 D2 已声明的行为变更（settling 窗口预检拒绝入队、reject-processing 转移帧，其正向验收见 V7）外**，全部行为与迁移前一致；展示族（ActivityStrip / composer 队列区 defer 行）随帧序列变化的显示正确；live≡reload 等价性套件全绿；四包全量测试绿 |
| V4 | restore 后通知/回流处置 | G2/G3 | dev 环境，四个子场景：(a) session 有 1 条 pending 的后台子代理完成通知（ledger 无 ack）→ forceQuit → 点击 restore；(b) 同 (a) 但 ≥2 条 pending（收敛环场景）；(c) **放行对照**：父 forceQuit 时其子 session 仍在跑 → 等子完成回流（**Gate B 实测：该形态物理不存在——子代理生命周期绑定父 pi 进程，父 forceQuit 时子代理被 cancel 随父亡（session 文件 pending:unregister status=cancelled 实锤），backflow 复活形态不可构造；父存活时的回流正向已由 V3 验证覆盖，验收结论以 impl-plan Gate B 记录为准**）；(d) **重启变体**：forceQuit 置标记后**不点击 restore**（session 保留 ≥1 条 pending 通知，内容控制为短任务使 turn 短）→ **重启前 grep session 文件确认 ledger entry 已落盘**（强杀落在 flush debounce 窗口时账目丢失属 notify-ledger PS-17 已知真丢失面，此时目标行为不可观测，需重新构造）→ 直接重启 app → 点击该 session | (a) ① 无 replay turn（agent_start 不出现或被 abort 终止，occupancy 回 idle）② 通知 custom_message 在历史中可见（内容不丢）③ 可立即发新消息；(b) 补发腿开的 turn 被收敛环 abort，收敛后标记清，通知内容全部在历史、无不受闸的 turn；(c) 父被回流唤醒处理子结果（裁定放行的正向成立），无死循环；(d) 标记因重启消亡、通知未消费 → replay turn 无闸跑起（D4 已裁决例外）→ 跑完自然结束，用户可再 forceQuit 停止（语义自洽）——验证例外行为与 D4 被否栏描述一致 |
| V5 | 长 turn 观测面 + ask_user 豁免 | G4 | ① 慢速流式 provider 下单个 write 跑 12+ 分钟：用户看到「本 turn 已 N 分钟 · write 已 M 分钟 · 已生成 X 字符」，超阈值出现中性操作项；点「中止」turn 终止 ② 触发 ask_user：等待期间显示「在等待你的输入」，永不出现停滞提示 | 两条各自成立；文案无「卡死/无响应/异常」判断词 |
| V6 | kill 源可追溯 + restore 短路 | G2 配套 | 分别触发 forceQuit / abort 超时自愈（K2）/ 删除活跃 session / destroyAll；另验：client 活跃未退出时点击该 session（D5② 短路命中） | 每次 kill 在 runtime 日志有一条 warn 含调用源与信号链；`grep` 任一 exit 143 都能定位到来源行；短路命中时不产生 kill 日志、不重开进程、直接返回现有 summary |
| V7 | settling 窗口双门归一（D2 行为变更正向验收） | G1/G5 | dev 环境：**runtime 侧 dev-only 事件流延迟注入**（环境开关如 `XYZ_AGENT_DEV_SETTLING_DELAY_MS`，在 runtime 事件解释链上延迟处理真实 `agent_settled` 事件 2s）使 settling 窗口可复现。**注入点时点约束**：延迟必须作用于事件解释处理之前（settling→idle 转移发生前）——若落在转移之后仅延迟广播，窗口构造会静默失败且难与「注入无效」区分。**真实链路定性**：pi 与 provider 交互完全真实（settling 窗口是 pi 进程内本地收尾段、无 provider 往返，provider 层注入物理不可行——R2 审查证伪）；注入不替换任何依赖（非 mock），是时间维度的 chaos 延迟手法；被测对象（预检读 occupancy、defer 队列、D1 门、自动投递链）全部运行在真实数据路径上 → turn 收尾进入拉长后的 settling 窗口 → 窗口内发消息；对照组：窗口结束后发消息。**开关保留策略**：纯内存延迟、不落盘、不带默认值进 prod（未设开关 = 零行为差异）；V7 验收后开关是否保留为长期观测工具由实施期定，默认移除。**实施期裁决（Gate B 后）**：保留——理由：① V7 是 D2 行为变更的正向验收手段，后续任何触碰 settling/预检的改动需重跑 V7，开关是可复用验收基建；② 已带收敛窗耦合守卫（delay ≥ 收敛窗拒绝生效）与 dispose 生命周期，是受维护设施非临时代码；③ 未设开关零运行时差异，保留成本仅注释与一个纯函数。偏离「默认移除」的登记见 impl-plan 偏差登记表 | ① 窗口内消息被拒（`send.rejected{busy}`）进 defer 队列，气泡 pending 可见，无 1 秒重投死循环 ② agent_settled idle 帧到达后自动投递成功 ③ 连发多条场景下不丢、顺序不变 ④ 对照组直发成功不受影响 |
| V8 | 反复操作 + 重启无残留（宿主表面反向场景） | G3/G5 | dev 环境：对同一 session 连续 ≥3 轮「turn 进行中 forceQuit → 点击 restore」循环，然后重启 app 再检查 | ① session 列表无重复/幽灵条目 ② pi session 文件历史完整合法（无半截 entry）③ occupancy 无残留卡态（各维度与实际一致）④ live≡reload 一致（重开后对话流与关闭前一致）⑤ 日志 grep 每条 exit 143 都有 kill 源行（与 V6 呼应） |

---

## 5. 下一层拆分（PR 单元）

**本章结论：5 个 PR 按「止血优先、依赖前置、独立可验」排序；PR-1/2 为 B2，PR-3 为 B1，PR-4/5 为 C1；除 PR-5 被 P-3 实测阻塞外均可立即开工。**

| 单元 | 内容 | justification | 可独立验收 |
|---|---|---|---|
| PR-1 | D3（前端 forceQuit 清 defer 队列回草稿 + 提示）+ D5①（kill 路径全量日志） | 斩断本事故主腿 L1，全部在前端 + 日志点，与 runtime 状态机零耦合；最小 blast radius 先合 | V1①② + V6（断言子集划分见 §4.1——V1③④ 是 PR-2 效果，本阶段不可满足） |
| PR-2 | D4（userStopped 标记独立宿主 + 置位点分型 source 参数 + restoreSession 返回前 abort + 收敛环）+ D5②（session.restore 短路复用）+ P-1 探针实测（单通知时序 + ≥2 条通知收敛环） | 依赖 PR-1（L1 已断，abort 时序才构造性成立——先合 PR-1 避免「投了又被 abort」的中间态） | V1 全量 + V4（四子场景）+ P-1 |
| PR-3 | D1/D2（`applySessionOccupancyTransition` 原语 + 转移表含 `announce-idle` 收编行 + 14+ 挂点迁移 + 三布尔 readonly 派生 + settling 预检裁决）+ 同步 `session-occupancy-send-closure` 设计文档（C-proc-10）+ constraints.json 登记「session 忙闲状态单写原语」新约束并重渲染 | 改动面集中 runtime、读侧零改动；依赖 PR-2 先合（forceQuit 全复位也是挂点之一，语义先稳定再收敛） | V2 + V3 + V7 + P-4 |
| PR-4 | C1 方案一（前端 turn 计时条 + 警示 + ask_user 豁免文案） | 纯 renderer，零协议改动，与 PR-3 无文件冲突可并行 | V5① |
| PR-5 | C1 方案二（runtime L2 停滞提示帧，**ephemeral 生命周期：仅 live 帧不入持久通路** + 前端渲染 + P-3 实测定值） | 被 P-3 实测阻塞；D7 文案纪律随此 PR 落；验收含 reload 反向断言（重开后无停滞提示残留） | V5② + P-3 + reload 反向断言 |

**文件改动地图**：

| PR | 主要文件 |
|---|---|
| PR-1 | `packages/core/src/domain/chat/useChat.ts`（队列处置）、`packages/renderer/src/composables/features/sidebar/useSidebarSessionActions.ts`（forceQuit 编排）、`useCompactQueue`、i18n 两locale、`message-dispatcher.ts`/`session-lifecycle.ts`/`process-manager.ts`/`reap-orphan-pi.ts`（kill 日志点） |
| PR-2 | `message-dispatcher.ts`（forceQuitSession source 参数 + 置标记）、`session-lifecycle.ts`（restoreSession 返回前 abort + 短路复用）、`session-service.ts`（标记独立 Map 存取）、`event-interpreter.ts`（收敛环 agent_start 拦截 + settled 静默观察窗） |
| PR-3 | `event-interpreter.ts`（新原语宿主 + #2-#6 挂点）、`message-dispatcher.ts`（#1/#7-#9/#11 + 预检改读）、`session-delivery-registry.ts`（deliverText 改调）、`session-state-projection.ts`（agent_end 副作用改调）、`session-lifecycle.ts`（registerSession 宣告帧改调 `announce-idle`）、`session-service.ts`（onSessionExit 全复位）、`types.ts`（readonly）、`docs/design/session-occupancy-send-closure*`（同步）、`docs/constraints.json`（登记） |
| PR-4 | `packages/renderer/` Composer 展示族 + `packages/core` 计时派生（复用 ADR-0049 分区范式） |
| PR-5 | `event-interpreter.ts`（L2 检测）、shared 协议（新帧类型）、`effects/registry.ts`（帧入流，ephemeral 不入 applyEntry 持久通路） |

**待验证检查点（实施期门，设计期不编造）**：① P-1 两场景实测（单通知 abort 时序 + ≥2 条通知收敛环标定，含收敛观察窗初值 3s 的实测校准，备选降级见 §3.5）；② settling 预检拒绝在真实会话的延迟感知（P-2 引用数据复核）；③ 转移表迁移的挂点枚举以实施期 grep 全量复核为准（本文档 14+ 为设计期计数；grep 时须命中 `registerSession` 宣告帧并按 `announce-idle` 行处置）；④ 前端草稿回收与 Composer 既有草稿的合并交互细节（追加 vs 分行）实施期定稿；⑤ L2 帧 wire 协议字段形状（生命周期已裁定 ephemeral——不入持久通路，reload 不复活；字段形状方案二开工时定，注意与兄弟分支 activity 帧词汇对齐）。

---

## 附录：决策溯源

本设计的问题定义与证据链经以下过程收敛：事故 handoff（/tmp/handoff-session-dead-01a08a6e-0d26.md，2026-09-10 晚）→ 分组核实会话（修正 3 处判断偏差：ensureActive 无自动触发、恢复即续跑另有其因、P0-1 效果描述）→ 本会话两路并行代码侦查（B1 写读点全枚举 / B2 五条链路 + kill 路径 K1-K8）+ 一手日志实证（notify replay 铁证、K3 撞车、第三条腿定案）→ fix-subagent-no-notification 分支相关性核查（D8 三个对齐点）。A 组三项止血（拒绝分型反转 / pi tee 日志轮转 / 前端重投计数边界）已由并行会话落地（commit `5637e0088`），本设计将其结论吸收为转移表行（D2），不重复设计。

- v1（2026-09-11）：初版。按用户裁定跳过对抗式审查循环，直接交付；D3 回草稿与 §5 落地顺序按推荐落定，阅读时可否决。
- v2（2026-09-11）：R1 对抗式审查（主审 2 must-fix + 5 suggestion / 影响面审 3 must-fix + 4 suggestion，报告 `.review/design-review-session-dead-r1*.md`）全修后的修订。关键变更：① **D4 机制升级**——「一次性 abort 后清标记」被 notify-ledger settled 补发腿击穿（多通知场景恢复后仍自动开新 turn），改为收敛环（标记存活期内非显投 agent_start 一律 abort + settled 后静默观察窗收敛判定 + 有界性论证），被否形态记入 §3.2 谱系；② **L5 backflow 显式裁定放行**（新信息送达 ≠ 复活），G2 措辞收窄，显式投递清标记规则落地，代价四要素入 D4；③ **L2 提示帧裁定 ephemeral**（不入持久通路，reload 不复活），消除「持久可见 vs 自动消失」的语义相反；④ registerSession idle 宣告帧特例（Gate B V6b④）登记并收编为转移表 `announce-idle` 行；⑤ 触发源表补全至 7 条（L6 base-tool-enhance / L7 goal）并标注腿归属与裁定；⑥ userStopped 标记宿主规格化（独立 Map，独立于 ManagedSession 生命周期）+ 置位点分型（仅 K1/K2 置标记）；⑦ 验收集 V1/V3/V4/V6 修订 + 新增 V7（settling 双门归一）/V8（反复操作+重启无残留）；⑧ 悬空外部编号引用（W10/FROZEN/P3/V8）改为可定位载体（C-data-04 / 兄弟分支具体路径）。
- v3（2026-09-11）：R2 聚焦复审（主审 1 must-fix + 3 suggestion，报告 `.review/design-review-session-dead-r2.md`；影响面审 0 must-fix + 3 suggestion，报告 `.review/design-review-session-dead-r2-impact.md`）全修后的修订。关键变更：① **V7 注入手段重定义**——pi 0.84.4 dist 核实 settling 窗口为进程内本地收尾段（`_runAgentPrompt` finally，无 provider HTTP 往返），provider 层故障注入物理不可行；改为 runtime 侧 dev-only 事件流延迟注入（延迟真实 agent_settled 事件，chaos 手法非 mock，定性论证入文档）；② **V4(d) 前置修正**——原「(a) 完成后重启」形态下标记已清、通知已 ack，目标行为不可观测；改为「forceQuit 后不 restore、保留 pending、直接重启再点开」；③ **收敛环销账措辞修正 + 异步重投残余链登记**——实装核实为「受理即 sent（sentAt 置位）+ 回执判定后 ack 销账」而非「发送即销账」（修正影响面审 R1 表述，两审冲突经实装裁决）；挂回 pending / 120s 看门狗转回重投可落在标记清除后，登记为新信息语义的窄窗口例外（attempts 上限 + abandoned 兜底）；P-1 补 120s 周期盲区声明；④ **announce-idle 通路归属声明**——广播走原语既有 state-topic 通路，快照/重订阅回放双腿保留，Part D 守卫保持回放断言；⑤ 收敛判定起点补全（abort 完成即起算静默窗，idle 场景不再悬空）、轮时长无上界代价登记、§1.2 全量清单消歧、兄弟分支路径加分支名前缀。
- v4（2026-09-11）：R3 聚焦复审（主审 0 must-fix + 4 suggestion，报告 `.review/design-review-session-dead-r3.md`；影响面审 0 must-fix + 1 suggestion，报告 `.review/design-review-session-dead-r3-impact.md`）加固后的终版：① V7 补注入点时点约束（延迟须作用于 settling→idle 转移前，防窗口构造静默失败）；② V4(d) 补重启前 ledger entry 落盘前置检查（notify-ledger PS-17 真丢失面防不可观测）；③ 收敛判定补「最后一次被掐 turn 的 settled 已到达」前置（闭合掐而 settled 未到时窗满误清的边界缝）；④ G3 补例外清单指针；⑤ 残余链四要素补显式重审触发条件、V7 开关保留策略登记。两份报告均 0 must-fix，循环收敛。
