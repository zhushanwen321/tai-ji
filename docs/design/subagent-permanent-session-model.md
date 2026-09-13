# subagent 永久会话模型（两态 + 万物可续聊）

> **一句话结论**：把 subagent 从「任务」（有终态、形态枚举决定复活资格）重构为「会话」（无终态、只有占用与意愿两个正交维度）——状态机收敛为 `running | idle` 两态，任何 record 任何时候都能同 id 续聊（含被取消/被关闭/宿主重启后/zcode 引擎），复杂度从「形态枚举 gate」转移到它该在的「资源生命周期」；同时把主 agent 与 subagent 在 pi 进程 RPC 上的 7 处同型实现收敛为公共包 `@zhushanwen/pi-rpc`，subagent 操作逻辑统一收敛到 Continuation + RecordStore 意图原语两条既有主干。
>
> **功能分级**：P0（subagent/workflow 派发，2026-09-12 用户裁决升 P0，docs/feature-priorities.md）。
> **风险分**：10/10 = P0 基数 9 + 可逆性 +1（`.state` 磁盘语义变更 + 状态机词汇对外契约变更）+ 新颖度 +1（仓内无「会话永久化 + 引擎中立 transcript 锚」先例）。
> **代码基线声明**：本设计的事实断言全部基于 **dev-0.9.19 分支**（tip 0bd74b5b2，含 H4「record 持久化收敛」交付形态）；当前 main 尚未含 H4（execution/ 层 132 文件差异），行号引用如无特别说明均指 dev-0.9.19。本分支合并 dev-0.9.19 后行号可能偏移，结构性断言（机制存在性与语义）不受影响。

---

## 0. 实施状态（2026-09-13，dev-flow 全单元落毕）

本设计已按实施计划 `.tmp/dev-flow/subagent-permanent-session-model.impl-plan.md` 全单元交付（U1-U9 + u-foundation + U6b/U8a/U8b 拆分），实施后事实以代码为准；与本文的全部偏差逐条登记在 **impl-plan §5 偏差登记表**（40+ 条，含每条的裁决依据），本文不重复。约束面已回写：C-data-20（原语清单刷新）/ C-data-22（zcode 会话库 TTL 引擎侧 sweep）/ C-proc-13（u7a 挂点注记）；母设计 [subagent-record-persistence-consolidation.md](subagent-record-persistence-consolidation.md) D5/D8 已加演进注记。

| 单元 | commit | 备注 |
|---|---|---|
| u-foundation 类型骨架 | `01d5c8060` | tsc 零错 + vitest 3000 passed |
| U1 pi-rpc 公共包 | `fe0499107` | 第 1 轮速率限制 WIP `8ab4461eb`，第 2 轮续作完成；S7 前置 grep 无双轨（唯一残留 relay-registry killRelayChild，见 impl-plan §7 残留 5） |
| U2 两态状态机 | `0487bbab2` | 部分在制文件被并行 docs 批次 `56898e3cfa` 捎带（不 revert）；遗留收口 `5e30ec77e`（statusGlyph 两态迁移） |
| U3 .state 收条化 + 重建单规则 | `42e3498b4` | 旧 finalized/cancelled 读侧上行映射 |
| U4 准入判据锚化 | `5fda1ef14` | 万物可续矩阵 22 例 |
| U5 意愿动作 + 通知 gate 三元组 | `0563ca632` | cancel/close/编排性关闭/寻回四动作 + worktree 重建三形态 |
| U6 zcode transcript 锚 + TTL sweep | `12f5e972c` | resume 读 + 新 session 注入 + conversation:cold + TTL 引擎侧 sweep |
| U6b 宿主侧 zcode 续聊接线 | `c19fb765c` | B-routing/B-firstround 两 blocker 分流收口 |
| U7 统计口径 binding 单基准 | `0b28b0e39` | zcode 锚键 sidecar 文件族 + 重启水合 |
| U8a 投影契约与 manifest 双写 | `0b1cd73f5` | 8 个 shared/runtime 文件被并行 docs 批次 `340ae8c1f` 捎带（同 U2 期先例，不 revert） |
| U8b GUI 投影 | `c47871d05` | idle 归进行中桶 + 默认可见性翻转 + 已收起过滤器 + GUI 快修批次 #1#3#4 |
| U9 文档同步 | 本 commit | 母设计 D5/D8 注记 / constraints 三条 / explainer / AGENTS.md 术语 |

**上游跟踪项（U6 遗留）**：zcode -32031 `ZCODE_RUNTIME_MODEL_UNAVAILABLE`——resume 后原会话 send 被 restoreWarning 挂起卡死（provider 注入生产形态不解除；协议层 session/setModel 应答成功但不清除），本设计选型绕开（resume 读通道取历史 + `session/create` 新会话注入，§3.2.6 要点 3 / §3.5 P-1）；若 zcode 未来版本打通 restoreWarning 的协议层清除路径，可升级为原地 resume 续聊（机制不变，省 token）。探针存证：`.tmp/probe/zcode-resume-probe*.mjs`（gitignore，不进 git）。

---

## 1. 背景目标

### 1.1 SCQA

- **S**：subagent（主 agent 派生的后台子代理）今天是一个「任务」：跑完就进终态 closed，用七个「关闭原因」（`ClosedReason`：parent-shutdown / parent-fork / parent-new / user-close / cancelled / gc / disconnected）标注怎么结束的；其中只有两个原因（disconnected / parent-shutdown）允许「透明重生」续聊。
- **C**：用户对某个 subagent 追问一句「刚才那个结果再展开讲讲」，会因为它「以错误的方式结束」（比如被取消过、或自然完成后被 GC 分类）而被硬拒，收到「nothing can reattach, start a new subagent」——这与用户对「对话」的直觉（聊天记录在，凭什么不能接着说）直接冲突；同时七个关闭原因、可重连集、「纳管态」这些内部术语对用户完全不可读。
- **Q**：能不能让 subagent 像一个真正的会话——随时停下来、随时接着聊，同时磁盘上的进程/worktree/会话文件等资源仍被有序回收？
- **A**：能。状态机只需要两态（running / idle），「为什么停」降级为纯展示信息；复活资格不再看「以什么形态结束」，只看「transcript 锚（会话记录指针）是否有效 + 是否有别的进程正在写」；资源生命周期独立管理，锚失效时自动降级为「带历史重开」。zcode 引擎补上 transcript 锚后同样获得续聊资格。

### 1.2 系统认知铺垫（首次出现的概念，绑定例子）

读者假设：会用 xyz-agent（派过 subagent、看过侧边栏 subagent 列表），但不懂内部实现。

- **subagent / record**：主 agent 通过 `subagent` 工具派生一个后台子代理去干活（比如「调研 X 并产出报告」）。每个 subagent 在宿主里有一条**档案**叫 record：记着它的 id、任务描述、用了多少 token、第几轮对话、以及——最关键的——**它的对话记录存在哪**。
- **对话记录（transcript）**：subagent 与模型的完整对话存在一个独立的 JSONL 文件里（pi 引擎形态），由子代理进程自己写。「续聊」的本质 = 让一个（新的或还活着的）子代理进程**接着写同一个文件**，历史由 pi 自己从文件加载，xyz 侧不解析内容、只传文件路径。
- **zcode 引擎**：subagent 可以选两种执行引擎之一。pi 引擎有上述独立 transcript 文件；zcode 引擎把对话存在自己的 SQLite 会话库里，宿主侧**没有**独立文件——这就是「zcode 续聊结构性不成立」的根源（见 §2.3）。
- **状态机**：record 的 `status` 字段。现状 `running | closed` 两值，closed 再挂七值 `closedReason`。
- **锚（anchor / transcript ref）**：record 指向 transcript 的指针。pi 形态 = 子 session 文件路径；本设计为 zcode 引入 = 会话库 session id + 库路径。
- **收起（archived）与内存回收（evicted）**：本设计把这两个现状混用的「归档」拆开——**收起** = 用户意愿（close 动作），record 从默认列表隐藏但会话完整可寻回；**内存回收** = 容量管理（idle 超过 30 天，宿主把 record 移出内存，用户不可见，磁盘数据不动）。
- **写权声明（`.alive` marker）**：一个跨进程互斥小文件（内容 = 持有进程 pid），防两个宿主进程同时写同一份 transcript。H4 已把它定义为「跨进程写权声明」（母设计 D3）。

### 1.3 设计目标（从使用者体验倒推）

1. **G1 万物可续聊**：对任何**非 workflow-origin** 的 subagent——无论自然完成、被取消、被关闭、宿主重启过、用的哪种引擎——用户（或主 agent）发 message 都能在**同一个 id** 上继续对话；不需要理解任何形态词汇（workflow 编排成员的立即终态化语义维持现状，见 §1.4 out-of-scope）。
2. **G2 状态可读**：用户在 UI 上只需要理解两个词：「正在跑」（running）和「空闲」（idle）。「为什么停」作为一句话解释展示，不参与任何资格判定。
3. **G3 资源有序**：永久会话不等于资源永不释放——进程、worktree、transcript 文件各有明确保留期与回收通道；回收后续聊自动降级为「带历史重开」，用户无感知中断。
4. **G4 意愿语义直白**：cancel = 「暂停这一轮」（可以继续聊）；close = 「收起来」（列表隐藏，可寻回）。两者都不是处决。
5. **G5 架构收敛**：subagent 的操作逻辑统一收敛（一条 message 链、一套意图原语）；主 agent 与 subagent 在 pi 进程 RPC 上的同类操作（追加消息、状态判断、中断、杀进程）提取公共包，消除双轨实现。

### 1.4 in / out scope

**in-scope**：
- 领域模型、统一语言、两态状态机与迁移路径（§3.1–3.2）
- 复活资格判据重定义、资源生命周期与降级规则（§3.2.3/§3.2.5）
- zcode transcript 锚（ref 锚）的领域设计与实施方向（§3.2.6）
- 结算副作用与统计口径简化（§3.2.7）
- RPC 公共包与分层架构（§3.3）
- 三投影面（GUI/runtime/TUI）与对外契约的影响清单（§3.2.8）

**out-of-scope**（另立设计/已另有归属）：
- zcode 引擎外移（`.tmp/zcode-extraction/proposal.md`，与本立项正交）
- GUI 快修批次（gui-quickfix-batch-root-causes 记忆，动同一显示链但正交）
- workflow 域（WorkflowRun）的状态机——本设计只动 record 会话域；workflow origin 的 one-shot 立即终态化行为（run-orchestration.ts:966-971，D7 例外）保持不变
- 主 agent 会话自身的管理（多会话/切换/LRU）——只在 RPC 公共包面与它相交

---

## 2. 现状与问题分析

### 2.1 使用者视角的现状与真实失败模式

**例 A（取消后追问被拒）**：用户派 subagent「调研 abc 库的 API」，跑了 3 分钟用户点了取消（觉得方向不对），随后改主意想让它「只看导出接口部分」——发 message 得到：`deliberately closed by user ... nothing can reattach; start a new subagent`。全部上下文作废，从头再来。

**例 B（自然完成后追问被拒）**：one-shot subagent 完成、结果已交付。宿主重启后用户想追问——该 record 在孤儿恢复时被判 `closed/gc`（「SP-5 完成态」直断，record-store.ts:1476-1480），`gc` 不在可重连集，message 被 endedMessageGuard 用一句**自相矛盾的文案**拒绝：`ended but reconnectable (closedReason: gc) ... Recovery: fork-from`——文案说 reconnectable，但 message 同 id 续聊恰恰不可（actions-core.ts:247-252 文案分支与 types.ts:99 集合定义直接矛盾，源码可证）。

**例 C（zcode subagent 重启即蒸发）**：zcode 引擎的 record 没有子 session 文件（「entry-born」形态）。宿主重启后孤儿恢复直断 `closed/gc` + error「entry-born form has no child session file to resume from」（record-store.ts:1570-1582）——投影为 failed，用户看到「失败」，而其实任务早完成了。追问只剩 start fresh 一条路（fork-from 守卫 6 硬拒，actions-core.ts:752-759）。

**例 D（术语不可读）**：侧边栏 subagent 详情里出现 cancelled / gc / disconnected / parent-shutdown……用户不知道 parent-shutdown 和 disconnected 有什么区别，更不知道为什么前者能续聊后者偶尔不能、cancelled 又永远不能。

### 2.2 状态机现状与 ClosedReason 的三重角色

现状（dev-0.9.19）：

```
ExecutionStatus = "running" | "closed"          (types.ts:59)
ClosedReason = 7 值                              (types.ts:86)
RECONNECTABLE_FINAL_REASONS = ["disconnected","parent-shutdown"]   (types.ts:99)
```

表面上已经是两态，但 **closed + closedReason 联合起来构成了一个 9 值的隐性状态空间**（running × {chatMode, resumable, 纳管态} + closed × 7 reason），而复活资格 gate 消费的是 closedReason。ClosedReason 同时承担三重角色：

1. **展示语义**——GUI 三分色（cancelled 灰 / failed 红 / done 绿，`deriveClosedDisplay`，shared/subagent.ts:209）；
2. **行为分支**——`isReconnectableFinalReason` 决定 message 能否同 id 重生（cold-lookup.ts:87-89）、`endedMessageGuard` 决定给用户什么拒绝文案（actions-core.ts:240-252）、fork-from 守卫 4 拒绝 cancelled/user-close（:732-738）；
3. **磁盘重建锚**——`.state` sidecar 的 reason 字符串就是它（state-marker.ts:50），重建矩阵分支 1/2 按它落 status。

三重角色耦合是复杂度之源：改一个 reason 值要同时核对展示、资格、磁盘三面；「为什么停」（信息）与「能不能续」（资格）本无因果关系——被取消的会话和自然结束的会话，其 transcript 完整性是一样的。

### 2.3 复活资格 gate 矩阵（现状全量）

续聊链现状（message action）：`messageHandler → getRecordForAction({allowReconnect:true})`（唯一开 allowReconnect 的 action，record-access.ts:503-539）→ 冷查 `coldLookupForAction`（cold-lookup.ts:174-202）→ 四守卫 → `markResurrected`（record-store.ts:908-943）→ `Continuation.reviveOrThrow`（conversation-continuation.ts:512-540）→ `dispatchRoundGuarded`（每轮 = 新 run + resume 锚，冷/热分流已在 H1 U6 消亡）。

| 场景 | 现状行为 | gate 位置 | 评价 |
|---|---|---|---|
| 宿主持有期内，one-shot 完成后 message | 可（SP-5 保持 running-resumable 等升级，run-orchestration.ts:984） | — | 已是目标行为，本设计推广到全部形态 |
| 宿主持有期内，chat 轮间 idle | 可（Continuation dispatchRound） | — | 已是目标行为 |
| 宿主重启后，chatMode / 纳管态 | 可（孤儿恢复保留 running，record-store.ts:1443-1447） | — | 已是目标行为 |
| 宿主重启后，one-shot 完成态 | **不可**：直断 closed/gc（:1476-1480），gc 不在可重连集 | 孤儿恢复直断 gate | 例 B 的根源 |
| 宿主重启后，one-shot 在途 | **不可**：直断 closed/gc +「aborted by host restart」 | 同上 | 用户被迫 start fresh |
| parent-shutdown / disconnected | 可（透明重生集） | — | — |
| parent-fork / parent-new | **不可**：isReconnectableClosed 排除（cold-lookup.ts:87-89），fork-from 指引 | 可重连集 gate | 编排性关闭被视为告别 |
| 用户 cancel / close 后 | **不可**：三通道全堵（message 硬拒文案 / fork-from 守卫 4 / .state 权威重建 closed） | 可重连集 + 守卫 4 + 磁盘权威 | 例 A 的根源 |
| zcode（entry-born）任何重启后 | **结构性不可**：无 transcript 锚——fork-from 守卫 6（actions-core.ts:752-759）+ markResurrected 无锚 throw（record-store.ts:910-914）+ dispatchRoundGuarded 锚点守卫（conversation-continuation.ts:260-263）三处硬拒 | 锚缺失 | 例 C 的根源 |

### 2.4 主 agent 与 subagent 的 RPC 重复面

主 agent（runtime 管 pi）与 subagent（subagent-core → pi-subagent-cli 引擎进程 → pi 子代理）是**同一个 pi RPC 协议的两套独立实现**：

| # | 操作 | 主 agent 实现 | subagent 实现 | 同构度 |
|---|---|---|---|---|
| 1 | pi spawn 参数组装 | rpc-client.ts:270-293 `buildPiArgs` | spawn-args.ts:56-106 `buildSpawnArgs` | 高（共同 flag 全同，差异仅在 session 定位方式与 thinking 传递方式） |
| 2 | stdin JSONL prompt 帧 | rpc-client.ts:728 起 `sendCommand`（pending/超时） | stdin-writer.ts:85-101 `sendPromptCommand`（fire-and-forget） | 帧形状相同（`{id?,type:'prompt',message,streamingBehavior?}`） |
| 3 | stdout LF-only 行分帧 | rpc-client.ts:46-74 `attachLfOnlyLineReader` | engine-client.ts:440 同型 | 高 |
| 4 | get_state 握手/身份读回 | rpc-client.ts:1019-1022 | get-state-handshake.ts:54-96 | 高 |
| 5 | 「追加消息」busy 语义 | 三层：occupancy 预检拒绝（message-dispatcher.ts:338-351）→ renderer defer 队列 → pi 拒绝转译 classifyPromptRejection（:180-184） | 引擎侧不预检：streamingBehavior 直传交 pi 裁决（stdin-writer.ts:85-101 上游调用链） | **语义同构、决策点位置相反（刻意差异）** |
| 6 | 杀链 | rpc-client.ts:1079-1115（SIGCONT→SIGTERM→grace→SIGKILL） | spawn-runner.ts / active-children.ts + subagent-core engine/common/kill-chain.ts | 三处同型 |
| 7 | 投递内核（排队/busy gate/重试） | —（GUI 直连 dispatcher） | — | `@xyz-agent/session-delivery` 已存在（agent-managed session 在用），是公共化的现成先例 |

「追加信息」是用户点名的样板操作：主 agent 侧 = `sendPrompt → 预检 → client.prompt → busy 转译/defer`；subagent 侧 = `deliverChatMessage → Continuation → engine.interact → streamingBehavior`。两侧都在回答同一个问题——「这个会话现在能不能接这条消息，不能的话排队、抢占还是拒绝」——但词汇、判定位置、兜底路径完全独立演化。

### 2.5 根因分析

1. **「任务」隐喻把「结束」建模成了状态，又用「结束方式」做资格 gate。** record 的生命周期被建模为「跑→终态」，终态一旦写入（`.state` 权威）就不可逆，于是「还能不能聊」只能从「怎么结束的」倒推——七值 reason、可重连集、纳管态这些词汇全是这个模型的衍生物。而「transcript 还在不在、有没有人在写」才是续聊资格的真实物理判据。
2. **用户意愿（取消/关闭）与会话活性（可续聊）耦合。** cancel/close 被实现为终态化动作（写 `.state`、清资源），「用户说停下」直接变成「会话死亡」。
3. **zcode 无锚 → 结构性排除。** 续聊链三个硬拒点全部锚定「子 session 文件」这一个载体形态，zcode 的会话库指针从未被建模为锚。
4. **两套 pi RPC 客户端独立演化。** 主 agent 与 subagent 各写一遍协议层，busy 语义、杀链、分帧三处已出现同型不同实现；无共享词汇导致行为漂移（如超时分级一边有一边无）。

### 2.6 物理数据流（record 状态落盘，现状）

```
内存 record (RecordStore)
  │  意图原语: markFinalized / markCancelled / markResurrected / markIdleArchived / markRoundIdle ...
  │  （C-data-20：store 唯一写入口，eslint + pre-commit 守卫）
  ▼
磁盘（子 session 文件旁）                     其他面
  .state      {status: finalized|cancelled, reason}   ← 终态权威（H4 D8）
  .alive      {pid}                                  ← 跨进程写权声明
  .record-binding  身份 + usage 快照                  ← light 重建源
  manifest (records/<id>.json)                        ← 外部读者投影（session-reader）
主 session JSONL 里的 subagent-record entry           ← 过程记录（best-effort）
```

---

## 3. 解决方案

### 3.1 终态（使用者视角，先于机制）

**场景 1：取消后续聊**
> 用户取消跑偏的调研 subagent → 列表显示「空闲（上一轮：已中断）」。
> 用户发 message「只看导出接口」→ subagent 原地继续（同一对话历史），列表回到「正在跑」。

**场景 2：重启后追问（pi / zcode 同）**
> 宿主重启后，用户对昨天完成的 subagent 发 message「结果再展开讲讲」→ 直接续聊。pi 从 transcript 文件恢复历史；zcode 从自己会话库恢复。列表不出现「失败」。

**场景 3：归档后寻回**
> 用户 close 一个告一段落的 subagent → 从默认列表消失。三周后想起它 → 「已收起」过滤视图里找到，发 message → 自动回到默认列表并继续聊（worktree 已按保留期回收 → 自动重建 + 恢复未提交改动）。

**场景 4：会话记忆过期（降级）**
> 30 天后再 message → transcript 已被 GC → 同 id「带历史重开」：新对话文件，第一轮 prompt 自动注入摘要（原任务、完成结论、用量），subagent 回答「我记得之前做过 X，结论是 Y，现在继续」。列表仍是一条连续记录。

**失败路径与恢复指引**：续聊被拒只剩一种真实原因——**另一个活进程正在写这个会话**（多宿主双开）。错误文案：`another process (pid N) is writing this session; close it or wait for it to exit, then retry`（错误 → 权威源 → 重试闭环）。其余昔日的拒绝形态全部转为可续聊或自动降级。

### 3.2 领域模型与统一语言

#### 3.2.1 领域模型

```
┌────────────────────────── Session 会话（永生概念，直到主 session 消亡）──────────────────────────┐
│                                                                                                  │
│  record（档案：id、task、agent、round、usage、意愿位、资源锚）                                     │
│    │                                                                                              │
│    ├─ status: running | idle          ← 占用维度（本轮是否有任务在飞）                             │
│    ├─ intent: active | archived       ← 意愿维度（用户是否把它收起来了，列表可见性）                │
    │    ├─ stopReason?: StopReason         ← 展示维度（上一轮为什么停：旧 7 值沿用 + 新增                              │
    │    │        interrupted / interrupted-by-restart / interrupted-by-parent / reopened，仅展示+排障）      │
    │    ├─ lastAbandonedRound?: {epoch, round} ← 放弃轮标记（通知 gate ②判据，随 binding 持久化，见 §3.2.7） │
│    │                                                                                              │
│    ├─ transcriptRef: TranscriptRef    ← 资源维度①：对话记录指针                                    │
│    │     pi:    { engine:"pi",    sessionFile }                                                   │
│    │     zcode: { engine:"zcode", sessionId, dbPath }                                             │
    │    ├─ 资源组（各自独立生命周期）：                                                                  │
    │    │     进程（引擎子代理）    ← idle 超时回收（现状 5min，保留）                                  │
    │    │     worktree + patch     ← 收起（close）即回收（patch 落盘）；续聊时按需重建                    │
    │    │     transcript 文件/库   ← 30 天 TTL（现状保留）；回收后降级为「带历史重开」                    │
    │    │     .alive 写权声明      ← 随会话持有（跨轮保留；release 于收起/内存回收，见 §3.2.4）           │
│    └─ 统计: turns / totalTokens / round  ← 单一口径（见 3.3.7）                                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

三个维度正交分解，替代现状的「status × closedReason × chatMode × resumable」联合空间：

| 维度 | 回答的问题 | 取值 | 谁改它 |
|---|---|---|---|
| **占用 status** | 现在有一轮任务在飞吗？ | `running` / `idle` | 轮次生命周期（dispatch / settle） |
| **意愿 intent** | 用户把它收起来了吗？ | `active` / `archived` | 用户动作（close 收起；寻回为隐含——message 自动翻回） |
| **资源** | 会话的物理载体还在吗？ | 在 / 被回收（由 transcriptRef 可解析性表达，无独立字段） | 各资源自己的生命周期管理器 |

**统一语言表**（对外文档/UI/错误文案一律用左列词；右列是它替代的内部旧词）：

| 统一语言 | 定义 | 替代的旧词 |
|---|---|---|
| 会话 Session | 一个 subagent 的完整对话生命，同 id 永续 | 任务/execution |
| 正在跑 running | 有一轮任务在执行 | running（含 resumable/纳管态/SP-5 缓冲等隐性子态） |
| 空闲 idle | 没有任务在飞，随时可接下一条消息 | closed、resumable、idle-resumable、纳管态 |
| 上一轮为什么停 stopReason | 展示用的一句话解释 | closedReason（资格角色） |
| 暂停 cancel | 用户动作：中断当前轮，回 idle | cancel = 终态化 cancelled |
| 收起 close | 用户动作：归档隐藏，可寻回 | close = 终态化 user-close |
| 寻回 | archived 会话回到默认列表——**无需显式动作**：message 到 archived record 自动翻回 active | — |
| 内存回收 evicted | 容量管理：idle record 超 30 天移出宿主内存（磁盘不动、可重建），用户不可见 | markIdleArchived 的「归档」义 |
| 对话记录指针 transcriptRef | 会话历史的物理定位（文件路径或库指针）。与 SDK 协议层 `ResumeAnchor.sessionRef` 是同一概念的两层投影：传输层弱类型 `Record<string,string>`，领域层强类型判别联合 | sessionFile 锚、entry-born |
| 带历史重开 reopen | 锚失效后同 id 开新 transcript，注入摘要 | fork-from（该场景下） |
| 回收 collect | 资源被 GC 删除（不可逆） | gc（同时是 closedReason 值的歧义消除） |

> 展示层词汇进一步收敛：`stopReason` 7 值只在详情/排障面板出现，列表主展示用派生 outcome（completed / interrupted / failed——`deriveOutcome` 已有，execution-record.ts:833-856）。

#### 3.2.2 状态机（两态 + 事件表）

```
              dispatchRound（message / start / reopen 降级后首轮）
        ┌─────────────────────────────────────────────────┐
        │                                                 ▼
   ┌────────┐      settle（轮完成 / 失败 / 中断收口）   ┌─────────┐
   │  idle  │ ◄────────────────────────────────────────  │ running │
   └────────┘                                              └─────────┘
        ▲                                                     │
        └───── abort（用户 cancel / 宿主 shutdown / 引擎死亡）─┘

（revive 不是状态迁移：idle record 的冷查重建 / 接管，发生在 message 进入时）
```

事件表（全部经 store 意图原语，C-data-20 不变）：
  idle   --message/start-->        running   （锚有效：原地续聊；锚失效：reopen 降级路径）
  running--settle(成功/失败)-->    idle      （stopReason=completed/failed；进程按 idle timer 回收）
  running--abort(用户 cancel)-->   idle      （stopReason=interrupted；不写任何「终态」）
  running--engine death-->         idle      （纳管语义保留：交 round-supervisor 或等 revive）
  running--host shutdown-->        idle      （stopReason=interrupted-by-restart；进程亡，锚在）
  archived+message-->              running+active（**message 隐含寻回**：intent 自动翻回 active——寻回不需要显式动作）
  idle+active--close-->            idle+archived（意愿位翻转；worktree 回收+patch 落盘；顺序约束见 §3.2.5）
  running+active--编排性关闭-->     idle+archived（宿主 session fork/new：**立即打断**在飞轮（进程随宿主回收），不挂起——
                                          在飞轮按 gate ②被打断轮阻断，不适用 gate ③收口轮豁免；stopReason=
                                          interrupted-by-parent，见 §3.2.5 编排性关闭行）
  （无 closed 事件——终态概念删除；workflow-origin one-shot 的立即终态化例外维持，见 §1.4 out-of-scope）

**与现状状态机的对照**：`closed` 整体删除；旧 closed 的 7 个 reason 全部变为 idle 上的 `stopReason` 展示信息；旧 running 的隐性子态（resumable / chatMode / 纳管态）由「idle + transcriptRef 在」统一表达——`resumable` 字段不再需要（idle 本身就 resumable），`chatMode` 保留为「会话形态」配置（首轮 message 升级机制不变，actions-core 升级 gate 保留）。

**不变量**（沿用 H4 已确立的，全部保留）：
- pi / zcode 是 transcript 的唯一写者，xyz 侧只传指针（两侧现状一致，runtime session-store.ts:9-10 与 spawn-args.ts:53-55）；
- 跨进程单写权由 `.alive` 探针保证（findForeignLiveInstance，pid 单判据 + self 排除）；
- record 持久化写面唯一入口 RecordStore（C-data-20）。

#### 3.2.3 复活资格判据（核心简化）

> **旧判据**：closedReason ∈ {disconnected, parent-shutdown}（形态枚举 gate）
> **新判据**：`transcriptRef 可解析 && 无异进程活实例 && 归属匹配`（物理判据）

| 判据 | 实现 | 现状对应 |
|---|---|---|
| transcriptRef 可解析 | pi：sessionFile 存在可读；zcode：sessionId+dbPath 库中存在 | 新增（统一三处锚硬拒点） |
| 无异进程活实例 | `.alive` 探针（findForeignLiveInstance） | 已有（cold-lookup 双守卫），保留 |
| 归属匹配 | rootSessionId + 直接父校验（P7 防双写） | 已有（cold-lookup.ts:189-200），保留 |

删除的判据：`isReconnectableFinalReason` 集合、fork-from 守卫 4（cancelled/user-close 拒绝）、endedMessageGuard 的形态分流文案、孤儿恢复的「SP-5 完成态直断 closed/gc」分支（record-store.ts:1476-1480 改为保留 idle）、`finalizeEntryOnlyOrphan` 直断分支（:1570-1582 改为保留 idle 等 ref 锚续聊）。

**降级规则**（判据一失败时）：transcriptRef 不可解析（文件被 GC / zcode 库条目过期）→ **同 id 带历史重开**：
- record 不换 id（GUI 列表、通知 id:epoch:round 连续性保持）；
- 新 transcript（pi：新 sessionFile；zcode：新 sessionId）；
- 第一轮 prompt 自动注入历史摘要，来源 = `.record-binding` 快照（task / agent / round / totalTokens / turns）+ 主 session entry 末条（含上一轮 result）；
- round 重置为 0，`epoch` +1（见下），stopReason 置 `reopened`（新增展示值）；
- 触发方式：仅用户显式 message（不自动重开）。

**epoch 防撞**：record 新增单调递增 `epoch` 字段（常态 0，reopen 时 +1），**随 `.record-binding` 持久化**（binding 增字段），重启经 binding 重建恢复——防撞依赖跨重启单调，丢 epoch 会被二次 reopen 击穿，故持久化是硬要求。通知账本 notifyId 从 `id:round` 扩为 `id:epoch:round`（epoch=0 时保持 `id:round` 旧格式不变，磁盘账本零迁移）——reopen 后 round 归零不会与历史轮撞 notifyId 去重键（同 key 撞车吞通知是该代码库已发生并修复过的事故类：notify-host C-1 终态/轮次同 key 被 60s dedup 吞，靠 round 置 undefined 修复——epoch 是同族防御的构造性根治）。

> 为什么同 id 而非 fork-from 新 id：fork-from 的语义是「从某 transcript 分叉新会话」，transcript 没了它语义空洞（守卫 6 硬拒的对象正是这个形态）；用户心智里「这还是那个 subagent」，同 id 免去列表出现父子两条的困惑；通知账本经 epoch 防撞后同 id 前提下单调连续。

#### 3.2.4 状态机的持久化语义变更（`.state` 降权）

H4 确立的 `.state` 是「终态权威」。终态删除后，磁盘需要表达的只剩：

| 新 `.state` 内容 | 语义 | 兼容 |
|---|---|---|
| `{status:"idle", stopReason?, endedAt?}` | 上一轮已收口 + 为什么停（round/usage 的真相源在 binding，`.state` 不再冗余承载） | 读侧：旧 `finalized/cancelled` 映射为 `idle` + stopReason=reason/`cancelled→interrupted`；写侧不再产旧值 |
| （文件不存在） | 在途中断（崩溃）或尚未收口 | 与现状分支 4 一致：重建为 idle（原来是 running 兜底，两态下 running 只在轮次在飞时有意义，崩溃后必然空闲） |

**双向兼容**：①新版读旧值 = 上行映射（finalized/cancelled → idle + stopReason）；②**旧版读新值（回滚场景）**：旧版 `readNewStateMarker` 对未知 status（"idle"）落入 `{status:"finalized"}` 存在性降级（state-marker.ts:246），reason 缺失兜底 `disconnected` → **closed 终态投影**——但 disconnected ∈ 旧版可重连集，回滚后 message 同 id 续聊仍可达，回滚方向行为良性；回滚验证断言必须按「投影 closed/disconnected（可重连）」写，不得按「投影 running」写（实施期易错点，特此登记）。manifest 的 executionStatus 新词（idle）被旧版 session-reader 忽略（RecordManifest 接口无该字段，未知字段跳过），旧 status 字段继续按下行映射写（见 §3.2.8），无破坏。

重建矩阵从四分支收敛为一条规则：**重建一律得 idle，stopReason 取自 `.state`（无则视为 interrupted-by-restart）**。这是本设计对崩溃恢复复杂度的最大削减——不再需要区分「终态不可逆 / 纳管可保留 / 直断 gc」，因为不存在不可逆终态。

写时机：轮次 settle / abort / 引擎死亡 / 宿主 shutdown 时由对应意图原语写入（markRoundIdle 已有，扩 stopReason 字段）；**不再是「死亡证明」，只是「上一轮收条」**。manifest 与 entry 同步投影（写序沿用 D8：`.state` 先、manifest 后）。

**`.alive` 写权声明生命周期（挂载点迁移，语义不变）**：跨轮保留策略不变（settle 不删——idle record 随时可能续写同一 transcript）。release 出口从「终态原语」迁移为：①**close（收起）**——intent=archived 即放弃写权（用户已收纳，归档即释放，worktree 同点回收）；②**内存回收（30 天）**——原 markIdleArchived 出口保留（原语随统一语言更名 markIdleEvicted，语义不变）；③宿主进程退出（marker pid 失效，findForeignLiveInstance pid 单判据自愈）。下游两个消费方行为核对：worktree 孤儿 reaper / D5b 双向对账（worktree-manager.ts:139）与 session-file-gc 探活保护（:99）——archived 后 marker 删除 → reaper 可回收 worktree、GC 可删 transcript，与「收起即释放资源」语义一致，无回归。

#### 3.2.5 意愿动作重定义（cancel / close / 寻回）

| 动作 | 旧语义（终态化） | 新语义 | 资源处置 | pending-notifications 注销 |
|---|---|---|---|---|
| **cancel**（取消） | CAS closed+cancelled + `.state` cancelled tombstone + worktree cleanup + manifest cancelled | abort 当前轮（轮级 signal，沿用 Continuation D2 打断编排）→ settle 为 idle，stopReason=interrupted；**置放弃轮标记**（lastAbandonedRound = 在飞轮，通知 gate ②判据，见 §3.2.7） | 进程按 idle timer 回收；worktree 不动 | settle 簿记既有承接（markRoundIdle 轮次通知链，run-orchestration.ts:984 注释）——取消轮不产生完成通知，无需额外注销 |
| **close**（收起） | doFinalizeRecord("user-close") 全套终态化 | intent=archived；在飞轮优雅收口后归档（沿用 closeAfterRound 挂起消费机制）。**顺序约束 [写死]**：收口轮 settle → 轮次通知送达 → intent 翻转 + 归档注销——intent 翻转必须在通知链之后，否则吞掉收口轮通知 | worktree 立即回收（patch 落盘进 `<sessionsDir>/<branch>.patch`，现状 collectPatch 机制前移到归档点）；transcript 保留期不变（30 天）；`.alive` release | **归档点补发注销**（承接原 emitUnregister 语义，新挂载点 = 归档原语内——原主发射点 finalize-record.ts:222 随终态化退役；workflow 域与对账 sweep 的发射点不受影响） |
| **编排性关闭**（宿主 session fork/new 时，原 disposeAllRecords parent-fork/parent-new） | CAS closed+parent-* 终态化 + error 合成 | **自动收起**：intent=archived + stopReason=interrupted-by-parent（回 idle 不终态化）——**立即打断在飞轮（不挂起、不等待收口**，进程随宿主回收；在飞轮置放弃轮标记，其迟到回注按 gate ②丢弃，不适用 gate ③收口轮豁免）——主 session 已分叉/新建，旧 record 不出现在新 session 活跃列表；迟到回注通知按 gate ①静默（承接原 parent-* 阻断防僵尸回执，v4 A-6 事故防御不回退）；旧 session 树内仍可 message 寻回 | 进程回收；worktree 按收起同款回收；transcript 保留期不变 | 归档点补发注销（同 close） |
| **寻回**（隐含，无独立动作） | — | message 到 archived record → intent 自动翻回 active（见事件表）——纯列表寻回（不续聊只回列表）无场景证据，不设独立动作 | 无 | 无（归档后迟到轮次通知静默——见 §3.2.7） |
| 显式 delete | （无此动作） | **不新增**——回收交给资源保留期 | — | — |

**通知词表对齐**：pending-notifications 扩展侧的 `mapReasonToStatus`（extensions/universal/pending-notifications/src/index.ts:338-349）词表现值 completed/failed/cancelled/expired/time_limited/budget_limited/aborted——新 stopReason 词映射：`interrupted / interrupted-by-restart / interrupted-by-parent → aborted`、`reopened → completed`（词表扩展或映射声明在 U8 实施，防止新词落 default 被记为 completed）。

> cancel 与 close 的产品边界（写死在语义层，不靠技术 gate 兜底）：cancel 回答「这一轮先停下」——秒级、可立即续聊、资源不动；close 回答「这件事告一段落」——列表隐藏、worktree 释放、可寻回。两者的会话记忆（transcript）保留期完全相同。

**worktree 续聊重建**：归档续聊时 worktree 已回收 → 自动重建（worktree-manager 现有能力：worktree add + checkout 记录的分支）+ apply patch（恢复未提交改动）→ 原地续聊（transcript 还在）。三种失败形态的处置：①patch 丢失或分支不存在 → 降级为带历史重开（同 3.2.3）；②**patch apply 冲突**（归档期间分支已有新提交）→ worktree 重建为干净基线 + 原地续聊（transcript 仍有效，续聊资格判据不受工作区影响）+ 用户可见提示「归档时有 N 处未提交改动无法自动恢复，patch 备份在 <path>」——不降级 reopen；③重建自身失败（磁盘满等 IO 错）→ 响亮报错重试，不静默回落。**防御不变**：hadWorktree && !worktreeHandle 的「防回落主 repo」守卫保留（conversation-continuation.ts:264-272），只是拒绝动作改为自动重建。

#### 3.2.6 zcode transcript 锚（ref 锚）

领域层抽象：**每个 record 都有一个 transcriptRef**，引擎中立。实施要点：

1. **锚的来源**：pi = run 应答回填的 sessionFile（现状已有）；zcode = create 应答的 `sessionRef.{sessionId, dbPath}`（zcode-engine.ts:455-465，onHandleReady 已回传——**数据已在，只是续聊链从不消费它**）。
2. **锚的承载**：内存 record 的 `transcriptRef` 字段（替代裸 sessionFile 的引擎专属性）；磁盘 = `.record-binding` 增 `transcriptRef` 块 + 主 session entry 的 engineHandle.sessionRef（已有，record-entry.ts:99）。
3. **锚的消费**：续聊链三处硬拒点（conversation-continuation.ts:260-263 锚点守卫 / record-store.ts:910-914 markResurrected 无锚 throw / actions-core.ts:752-759 fork-from 守卫 6）统一改为「按 transcriptRef.engine 分派」：
   - pi → 现状路径（`--session <file>` 续写原文件）；
   - zcode → **P-1 探针已测（2026-09-13，zcode 0.16.5 真机 6 轮）**：`session/resume {sessionId}` 原生存在（strict 键集）且**应答自带完整双向 messages 历史**（user/assistant 全量、tokens、parts、timeline 事件、会话快照）——读通道完全成立；但 **resume 后原会话 send 被 -32031 `ZCODE_RUNTIME_MODEL_UNAVAILABLE` 卡死**（restoreWarning 挂起；provider 注入生产形态不解除；协议层 session/setModel 应答成功但不清除——bundle 内部 setModel 路径有清除逻辑、协议 handler 未接通）；CLI `--resume` flag 对 app-server 子命令不生效（create 返回新 id 无预绑定）；`session/fork` 需 workspace checkpoint 非轻量通道。**选型结论：zcode 续聊 = resume 读通道取结构化历史 + `session/create` 新会话注入首轮**——与 §3.2.3 reopen 机制同构（每次续聊换新 sessionId，record.transcriptRef 更新新锚，旧 sessionId 历史仍可经读通道回溯，round/epoch 不变），零依赖 -32031 修复，token 成本经 resume 应答自带的 tokens 数据做裁剪预算。探针脚本：`.tmp/probe/zcode-resume-probe*.mjs` + `fs-patch.cjs`（复刻 launcher 注入）。
4. **zcode conversation 能力位**：`capabilities.conversation` 从 `unsupported` 升为 `cold`（新值：冷恢复会话——resume 读 + 新 session 注入，无热 steering）——capability-gate 的 message 升级 gate（run-orchestration canUpgradeToConversation :1394-1401）自动放行 zcode record 的 chat 升级。`steer` 维持 unsupported（interrupt=true 的 message 对 zcode 先做「等轮结束再投」降级，映射 followUp 语义，capabilities 声明如实）。
5. **entry-born 形态消亡**：zcode record 有了 transcriptRef，`finalizeEntryOnlyOrphan` 直断分支删除（见 3.2.3 删除清单）——Gate B F2（缓存重建缺员）与 F3（纳管态误结案）随 anchor 统一自动消解。

**zcode 会话库资源生命周期（风险登记，四要素）**：万物可续聊后，zcode 隔离库（`<engineDataDir>/engines/zcode/session-db/db.sqlite`，含每会话全量 turns）成为单调累积写入面——每 subagent 每轮追加、reopen 再开新 sessionId 继续追加。要素登记：①**量级** = 会话数 × 轮均体积（sqlite 全量 turns，量级与 pi 侧 jsonl transcript 同源同阶；实施期以真实库采样校准，设计期上界假设 <1MB/会话）；②**清理通道（本设计锁定的约束）** = zcode 库条目 TTL **必须与 pi transcript 同窗 30 天**——通道二选一在实施设计定：引擎侧 sweep（协议加清理方法，宿主周期调）或宿主侧清库（写库并发/锁窗口评估）；通道落地前不得发布「zcode 万物可续聊」；③**恢复路径** = 条目被清 = 锚失效 → 自动走 reopen 降级（§3.2.3），无需人工恢复；④**重审条件** = 库体积 >100MB 或活跃条目 >1000（数字实施期校准）触发 TTL 窗口复审。**执行锚**（防纯文本承诺静默失效）：本约束随 U6 落地时登记进 constraints.json（C-data 系新条目，pre-commit / CI 检查按路径触发），S3 验收补通道存在性断言（zcode 库条目超窗被清 + 清后 message 走 reopen 降级）；**约束登记与 TTL 通道属同一发布单元，不拆分发布**（防「锚先合、通道后合」的裸奔窗口）。

#### 3.2.7 结算副作用与统计口径

**结算概念大幅缩水**（无终态化 → 无终态结算）：

| 副作用面 | 现状 | 新模型 |
|---|---|---|
| 归档投影翻回 | 复活 closed record 需翻内存/entry/.state/.alive 等多面——现状 resurrectClosed 三件套只覆盖 `.alive` acquire + 删 `.state`/旧名 + 内存翻回，worktree/patchFile/pending-register/manifest 面不补偿（state-marker 与 cold-lookup 现状实现可证） | 无翻回——从未终态化，intent 位翻转即可 |
| 通知 | notifyId=id:round 按轮次（notifier.ts:510）+ 终态通知 key 回退裸 id（notify-host.ts:186-198）+ 迟到回注 gate 三分支（notifyGateAllowsDelivery，notifier.ts:49-55：closed 终态放行 / cancelled 阻断防双发 / parent-new+parent-fork 阻断防僵尸回执——v4 A-6 事故防御） | 轮次通知不变（notifyId 扩 `id:epoch:round`，epoch=0 保持旧格式，见 §3.2.3）；**终态通知消亡**（notifyClosed 仅保留归档时一条「已收起」提示）；迟到回注 gate 判据从 closedReason 集合改为三元组，**三个阻断分支逐一承接**：①`intent=archived` → 静默（承接原 parent-new/parent-fork 阻断——编排性关闭在新模型即自动收起，见 §3.2.5；用户 close 后迟到回注不再打扰）；②`放弃轮标记命中`（迟到回注的 per-round 判据）→ 阻断（承接原 cancelled 阻断防双发）。**机制**：record 持有放弃轮标记 `lastAbandonedRound: {epoch, round} | null`（单槽，随 binding 持久化）——abort（用户 cancel / 编排性关闭打断）时置为在飞轮 `{epoch, round}`；reopen（epoch+1）时标记不迁移、自然失效（reopen 只由 idle record 的 message 触发，reopen 前最后一轮必然已 settle 且通知已同步入账，其晚到回注必为重复帧——跨 epoch 丢弃是去重语义的正确执行而非误吞）。迟到回注（settle 流程之外到达的引擎帧/监督器回注，携带轮身份）判定序列**显式两步**（比较基准 = record 当前 epoch，非标记槽 epoch——reopen 后标记残留旧 epoch，若按标记槽比较会把新世代全部正常轮通知吞掉）：**第一步**回注 epoch ≠ record 当前 epoch → 丢弃；**第二步**（同 epoch）标记非空且回注轮 ≤ 标记轮 → 丢弃；否则放行。**为何单槽够**：早于标记轮的回注必然是过期轮（其正常通知在各自 settle 流程内已同步发过、不走本 gate，迟到的是重复帧，notifyId 去重兜底——晚到回注与 settle 通知须构造同一 dedupKey 走同一账本，ledger 的 record() 对同 key 在账/已销账均拒绝、账本跨重启 replay 幂等）。**为何不能只比轮号不记放弃**：正常轮 N settle 后用户立即续聊轮 N+1，轮 N 的异步回注排队晚到时轮号已落后——但它是正常通知路径，不该吞；只有「被显式放弃的轮」才进标记。stopReason 单值会被新轮覆盖，无法承载 per-round 终局——标记是 gate ②的最小持久化载体（r3 影响面审查反例：K10 打断轮 3 → 寻回 → 轮 4 settle 覆盖 stopReason → 轮 3 回注三支全漏 → 本机制堵死）；③**收口轮豁免**：close 挂起等待的最后一轮（closeAfterRound 消费）通知正常送达——用户专门等的那轮不是打扰，归档静默只作用于收口轮**之后**新产生的回注 |
| 统计 | 内存增量（updateFromEvent 累加）vs 磁盘全量（reconstructFromFile）vs binding 快照三口径并存；冷复活丢前轮 | **统一口径：binding 快照为基准 + 内存增量覆盖**——settle 时把累计值落 binding（现状 markFinalized 已做，改为 markRoundIdle 也做）；revive/重开时从 binding 恢复基线，新轮增量继续累加。单一真相源 = binding，磁盘全量重建仅用于校验 |
| round 基线 | roundBaseTurnIndex 冷复活丢失 | binding 增 roundBaseTurnIndex 字段，revive 恢复 |
| manifest | 透明重生不写 manifest（陈旧） | 每次 settle/归档写（D8 写序不变），manifest 永远只是投影 |

#### 3.2.8 三投影面与对外契约

| 投影面 | 现状 | 改动 |
|---|---|---|
| GUI（renderer） | `SubagentStatus` 六值（shared/subagent.ts:26）+ deriveClosedDisplay 三分色 + legacy 分支 | 契约改 `running \| idle` + `intent` + `stopReason?`；列表三色改「正在跑/空闲/已收起」；legacy done/failed/crashed/cancelled 状态值保留只读兼容（旧 session 显示）。**同步三处判据**（行为回归高发点，U8 逐一点名）：subagent-bucket.ts:41 反向白名单 `status !== 'running' → ended 桶`（idle 必须归「进行中类」桶）、SUBAGENT_STATUS_ALL 编译锁元组（shared/subagent.ts:44-62，扩值漏改 = tsc 红）、SubagentTab.vue:278 同判据 |
| **默认列表可见性** | closed 默认隐藏（includeFinished:true 才显示）——终态化副产物 | **默认列表 = running + idle(active) 全显**，附「只看正在跑」「已收起」过滤器。已接受的交互代价（四要素）：量级 = 用户 active 会话数，单 session 内 subagent 典型 <20（实施期以真实用户数据校准）；恢复路径 = 用户用 close（收起）自主收纳——这是 close 成为「收纳动作」的产品定位（G4），不引入时间窗过滤等新机制；显式判定 = 接受「用户手动收纳」交互成本换取「永不丢失、无需理解形态」；重审条件 = 默认列表 active idle record >50 条时复审默认可见性策略（候选方向「最近活跃 N 天」过滤，届时按实测分布定） |
| runtime（session-records / subagent-extractor） | closedReason 参与 diff 基线（session-records.ts:553-569） | diff 基线改 {status, intent, stopReason}；W18 entry_appended 失效链不变 |
| TUI（subagent-workflow） | mapExternalState closed→ended（actions-core.ts:298-308）+ endedMessageGuard 形态文案 + bg-notify-render | mapExternalState：running→active / idle→idle；endedMessageGuard 缩为单形态（活实例占用）；bg-notify 渲染改 stopReason 派生词 |
| **session-reader（外部 npm 包）** | manifest.status 三态（running/closed/cancelled）+ executionStatus 永久双写是与仓外已发布包的兼容契约（manifest-store.ts:26-40，无版本磁盘 schema 不做破坏性变更） | **旧三态继续派生投影下行**（idle→running「活跃会话」、archived→closed「已收起」）+ executionStatus 双写新词（idle）——沿用既有「永久双写」过渡契约，旧版 session-reader 读旧 status 字段照常工作、新词被忽略；rebuildIndexes 重建路径（`.state` 新格式 → derivedManifestRecord）的映射进 U8。**行为变化声明**：idle→running 下行映射使 session-reader 家族视图把可续聊 record 视为活跃成员（符合新语义）；archived→closed 使其按既有 closed 语义归入已完成分区——两向均落在 session-reader 既有词汇的行为域内，无未知值、无缺员 |
| 错误文案 | 七种拒绝文案 + 自相矛盾的 gc reconnectable | 一种占用拒绝 + 降级自动发生（无需用户理解） |

### 3.3 RPC 公共包与分层架构

#### 3.3.1 终态分层

```
┌────────────────────────── 编排层（各宿主业务，不公共化）──────────────────────────┐
│  主 agent: message-dispatcher / session-lifecycle（GUI 实时交互编排）              │
│  subagent: Continuation + run-orchestration（chat 轮编排）                        │
├────────────────────────── 投递语义层（公共内核，已存在，扩展复用）────────────────┤
│  @xyz-agent/session-delivery：busy gate / 排队 dedupe 合批 / 退避重试 / watchdog   │
│  新增「会话占用词汇」共享：IdleProbe + Intent(streamingBehavior) 映射             │
├────────────────────────── 引擎中立契约层（已存在，不变）─────────────────────────┤
│  subagent-engine-sdk：EnginePort / EngineHandleData(sessionRef) / 反向通道         │
│  pi-subagent-cli / zcode-subagent-cli：引擎实现（zcode 增 interact/resume）        │
├────────────────────────── NEW: pi 进程协议公共包 ────────────────────────────────┤
│  @zhushanwen/pi-rpc：spawn args 构造 / NDJSON 帧协议 / prompt·steer·followUp·     │
│  abort·getState·switchSession 命令面 / 超时分级 / 杀链 / LF 行分帧                │
│  消费者：runtime（主 agent rpc-client 重构为薄壳）+ pi-subagent-cli（stdin-writer  │
│  归并）——zcode 不经过此层（app-server 是另一协议，仅在语义层对齐）                 │
├────────────────────────── pi 本体（上游，不可改）────────────────────────────────┤
```

#### 3.3.2 `@zhushanwen/pi-rpc` 公共包设计

包位置 `packages/pi-rpc`（workspace 内，pi-subagent-cli 与 runtime 共同依赖；**不进 subagent-engine-sdk**——SDK 是引擎中立协议层，pi 进程细节放进去会让 zcode 引擎背上 pi 依赖）。

公共面（按 §2.4 重复表逐项收敛）：

| 模块 | 收敛内容 | 来源 |
|---|---|---|
| `spawn-args` | pi argv 构造器（参数化差异点：session 定位 none/file/dir、thinking 传递 flag/模型后缀、extensions/skills 注入、mirror 规则） | buildPiArgs ∪ buildSpawnArgs |
| `frame` | LF-only 行分帧、pending 表、超时分级（FAST/CMD/SLOW）、迟到响应丢弃、早期帧缓冲 | rpc-client :46-74 / :728 起（sendCommand） |
| `commands` | prompt（含 streamingBehavior 语义词汇）/ steer / followUp / abort / get_state / switch_session / extension_ui_response（switch_session 仅主 agent 消费——spawn 时 `--session` 直续是 subagent 侧路径；包 README 注明单侧消费，防误认为双侧契约） | rpc-client :983-1119 区 + stdin-writer |
| `kill-chain` | SIGCONT→SIGTERM→grace→SIGKILL 阶梯（grace 可参） | rpc-client :1079-1115 + spawn-runner/engine kill-chain（三处同型收敛） |
| `env` | buildPiOutboundEnv / buildOutboundChildEnv 组装（已有共享惯例，归位本包） | process-manager / spawn-runner |

**刻意不统一的**（写进包 README 防后人「顺手统一」）：
- **busy 判定位置**：主 agent 前置预检（GUI 要用户可见反馈 + renderer defer 队列）vs subagent 后置交 pi 裁决（agent 驱动不阻塞）——这是**真差异**（消费方不同），公共包只提供 `classifyPromptRejection`（pi 错误原文 → busy/compacting 分类）这一个共享判读器；
- **投递策略**：排队/重试归 session-delivery，按消费方注入（GUI 不排队直拒、subagent 排队续投）。

#### 3.3.3 subagent 操作逻辑的统一收敛点

现状已收敛（H4 遗产，本设计沿用不重造）：
- **写面**：RecordStore 意图原语唯一入口（C-data-20）；
- **轮编排**：Continuation（message → revive/dispatch/drain 单链）+ run-orchestration（每轮新 run + resume 锚）。

本设计新增收敛：
- **准入**：复活资格判据三件套（3.2.3）成为唯一 gate，删除全部形态枚举 gate——`coldLookupForAction` 守卫段与 `Continuation.reviveOrThrow` 的非可重连硬拒分支（conversation-continuation.ts:514-521）合并为单点；
- **资源**：worktree 回收/重建归 worktree-manager 单点（归档回收 + 续聊重建对称）；transcript TTL 归 session-file-gc 单点（zcode 库条目 TTL 同窗，由 zcode 引擎侧 sweep 或宿主侧清库实现——实施设计定）；
- **降级**：reopen（带历史重开）作为 store 意图原语（`markReopened`：新 transcriptRef + 摘要注入标记 + round 归零），所有锚失效场景共用。

### 3.4 多方案对比

**方案对比 1：状态机建模**

| 方案 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **A. 会话模型：两态 + 意愿位 + 锚判据（推荐）** | 高：与主会话（永生 + 资源惰性恢复）同构，词汇对用户零学习成本；终态/纳管/可重连集等 9 值隐性空间全部消亡 | 中：状态机词汇 + `.state` 语义 + 三投影面 + 孤儿恢复重写，但每处都在做减法 | 8/10：对外契约（SubagentStatus）变更波及面已枚举——GUI 列表/详情/分桶 ~4 文件 + runtime diff 基线 1 处 + TUI 渲染 2 文件 + session-reader 1 外部包（§3.2.8 表全列）；恢复路径 = 领域词汇 additive + 旧值只读兼容，单 commit 可 revert；重审触发 = S7 全量回归出现白名单外行为差异即回 §3.4 复审 |
| B. 保留 closed，扩可重连集至全集 | 低：只是把 gate 门拆了，closedReason 三重角色依旧，七个词汇依旧看不懂，孤儿恢复分支依旧 | 低：改 1 个常量数组 + 若干守卫 | 4/10：但 §2.1 例 A/B/C 的用户体验问题一个都没解（文案矛盾、zcode 结构性不可续依旧） |
| C. closed 拆为 paused/archived/… 多终态 | 低：换一批新词汇做多路 gate，复杂度回家 | 高：状态空间更大 | 7/10：重蹈「形态枚举」覆辙 |

**方案对比 2：RPC 公共包提取**

| 方案 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **A. 新包 @zhushanwen/pi-rpc（推荐）** | 高：协议单点，pi 升级时一处适配；runtime 与 pi-subagent-cli 行为对齐有构造性保证 | 中：两侧重构为薄壳 + 迁移期双轨测试 | 5/10：runtime rpc-client 是主链路（P0）。迁移分步（U1 先并存后切换）；**切回通道** = U1 期间旧路径保持单 commit 可恢复（薄壳层 revert 即回旧客户端直连），S7 「grep 无双轨」是切换完成的门；重审触发 = 双轨期主会话发消息/中断链路出现回归信号（P99 时延劣化 / abort 阶梯行为差异） |
| B. 只沉淀共享常量/类型不提实现 | 低：重复实现继续漂移（超时分级已有分叉） | 低 | 3/10：治标 |
| C. 塞进 subagent-engine-sdk | 低：引擎中立层被 pi 细节污染，zcode 引擎背上 pi 依赖 | 中 | 6/10：违反 SDK 分层定位（两引擎 package.json 明文只依赖 SDK 的纪律） |

**方案对比 3：锚失效降级**

| 方案 | 长期合理性 | 短期成本 | 风险 |
|---|---|---|---|
| **A. 同 id 带历史重开（推荐）** | 高：用户心智连续、通知连续、列表连续 | 中：markReopened 原语 + 摘要注入 | 4/10：摘要质量依赖 binding 快照完整度（快照已有，fail-soft） |
| B. fork-from 新 id | 低：transcript 没了 fork 语义空洞（守卫 6 硬拒的对象）；列表出父子两条 | 低 | 4/10 |
| C. 硬拒 + start fresh 指引 | 低：用户体验断崖（30 天前聊得很好，现在让我重新描述任务？） | 低 | 2/10 |

### 3.5 关键决策与权衡（汇总）

| # | 决策 | 被否 | 证据 |
|---|---|---|---|
| K1 | 状态 = 占用（running/idle），意愿 = intent 位，资源 = 锚可解析性——三维正交 | 保留 closed / 多终态拆分 | §2.2 三重角色耦合是复杂度之源；终态不可逆性与「transcript 还在」无因果关系 |
| K2 | 复活资格 = 锚 + 单写权 + 归属（物理判据） | closedReason 枚举 gate | §2.3 矩阵：形态 gate 制造了全部四个失败模式 |
| K3 | 锚失效 → 同 id 带历史重开（reopen） | fork-from 新 id / 硬拒 | 方案对比 3 |
| K4 | cancel=暂停 / close=归档+worktree 回收 / 无显式 delete | cancel/close 终态化（现状） | handoff 共识（用户已接受分界）；worktree 占磁盘大，30 天保留不成立（git-cwt worktree 含 node_modules） |
| K5 | `.state` 降权为「上一轮收条」，重建矩阵收敛为「一律 idle」 | 保留终态权威语义 | 无终态后死亡证明无对象；崩溃恢复分支数 4→1 |
| K6 | transcriptRef 引擎中立（pi=sessionFile / zcode=sessionId+dbPath），承载 binding + entry；zcode 续聊 = resume 读通道取历史 + 新 session 注入（P-1 已测） | pi 专用的 sessionFile 字段继续扩张；原地 resume 续聊（被 -32031 卡死，P-1 探针） | zcode sessionId 已在 onHandleReady 回传（zcode-engine.ts:455-465），缺的只是消费链；resume 应答自带全量双向历史（P-1），注入形态与 reopen 机制同构 |
| K7 | 公共包 @zhushanwen/pi-rpc 独立新包 | 进 SDK / 只提类型 | 方案对比 2；两引擎 SDK 依赖纪律 |
| K8 | busy 判定位置保留两侧差异，公共化判读器与词汇 | 强行统一前置预检或后置裁决 | §2.4 #5：GUI 与 agent 消费方不同，真差异 |
| K9 | zcode conversation 能力 = cold（冷恢复，无 steer）；interrupt 降级 followUp | 等待 zcode 热会话能力 | session/send busy 时 -32010 硬错是结构保证（zcode-engine.ts:1174-1180），不越权改引擎 |
| K10 | 编排性关闭（宿主 session fork/new）= 自动收起（intent=archived + interrupted-by-parent，回 idle 不终态化）；迟到回注按归档静默承接（v4 A-6 僵尸回执防御不回退） | 维持终态化（旧 disposeAllRecords 语义） | 主 session 已分叉，旧 record 不属新活跃列表；终态化会剥夺旧 session 树内的寻回（§2.3 矩阵「被视为告别」失败模式） |
| K11 | 迟到回注通知 gate 从 closedReason 集合改为三元组：intent=archived 静默 / 放弃轮标记命中阻断（per-round 单槽 {epoch, round}，防双发）/ 收口轮豁免 | 「归档后一律静默」单判据；纯轮号比较（吞快速续聊正常通知） | 单判据吞收口轮通知（用户专门等的最后一轮）；cancelled/parent-* 两阻断分支是已修复事故的防御，必须逐一承接（r2 影响面审查 MF）；纯轮号判据的反例 = 轮 N 正常 settle 后立即续聊 N+1，轮 N 异步回注排队晚到不该被吞（r3 影响面审查） |

**运行时行为断言与探针**：
- P-1 ✅**已测（2026-09-13，zcode 0.16.5 真机 6 轮）**：`session/resume` 读通道成立（应答自带全量双向历史）；resume 后原会话 send 被 -32031 卡死（restoreWarning 不清除，provider 注入/setModel/等待三路均不通）；CLI `--resume` 对 app-server 不生效；**选型 = resume 读 + 新 session 注入**（§3.2.6 要点 3）。-32031 修复路径登记为 U6 上游跟踪项（若未来版本修复，可升级为原地 resume 续聊）；
- P-2：「reopen 摘要注入后 subagent 第一轮能正确引用历史结论」真机场景验收（§4 S4）——zcode 侧由 resume 结构化历史注入覆盖（比摘要更强）；
- P-3：「idle record 30 天归档 + 锚 GC 后 message 触发 reopen」fake-clock 单测 + 真机降级路径采样。

---

## 4. 验收（真实场景；每场景回溯 §1 目标）

| # | 场景 | 步骤（真实环境） | 通过标准 | 回溯 |
|---|---|---|---|---|
| S1 | 取消后续聊 | 真机派 subagent 调研任务 → 跑步中点 cancel → 列表「空闲（已中断）」→ 发 message「只看导出接口」 | 同 id 继续（GUI 点开详情可见完整历史含被中断轮）；无新 record 出现；token 统计连续累加 | G1/G2/G4 |
| S2 | 重启后追问（pi） | 完成一个 one-shot → 完全退出宿主 → 重启 → 对该 record 发 message | 直接续聊（不出现 closed/failed，不出现 start fresh 指引）；`.state` 重建为 idle+stopReason | G1 |
| S3 | 重启后追问（zcode） | 用 zcode 引擎跑完 subagent → 重启宿主 → 发 message | zcode 从自身会话库恢复历史续聊；列表不出现「entry-born ... start a fresh subagent」错误；**zcode 库 TTL 通道存在性**：fake clock 推进超窗 → 库条目被清 → message 走 reopen 降级（§3.2.6 风险登记的验收面） | G1/G3（K6） |
| S4 | 带历史重开 | idle record 超过 transcript TTL（fake clock 推进 + 手动触发 GC）→ 发 message | 同 id 收到响应且第一轮回答能引用原任务与结论（摘要注入生效）；round 归零、stopReason=reopened 展示 | G1/G3（K3） |
| S5 | 归档寻回 + worktree 重建 | 带 worktree 的 subagent → close 归档（确认 worktree 已回收、patch 落盘）→ 在「已收起」过滤视图对其发 message | worktree 自动重建 + patch 恢复；续聊写同一 transcript；不回落主 repo；record 自动回到默认列表（intent 翻回 active） | G3/G4 |
| S6 | 双宿主占用拒绝 | 两个宿主进程开同一 dataDir → A 持有 record 在飞 → B 对同一 record 发 message | B 收到含 pid 的占用错误（含等待/关闭指引），A 不受影响 | G3（单写权不变） |
| S7 | 主/从 RPC 收敛回归 | 全量回归：主会话发消息/中断/steer/followUp + subagent message/取消/重启恢复 + 四包 + extensions 测试 | 除「closed 消亡白名单」外行为不劣化；runtime 与 pi-subagent-cli 的 pi-rpc 层共用单实现（grep 无双轨） | G5 |
| S8 | 旧数据兼容 | 打开含旧 closed record 的历史 session | 旧状态只读映射正确（closed→idle+stopReason、cancelled→interrupted），无渲染错误 | K5 兼容行 |
| S9 | 负面行为反向验收 | ①idle record 超过 transcript TTL 且**用户不发 message**（观察 1 个 GC 周期）②归档后引擎迟到轮次完成回注 + **cancel 后该轮迟到回注**（先 cancel 再等引擎迟到结果帧到达）③长期累积 20+ active idle record 后看默认列表 | ①无自动重开副作用（reopen 仅由显式 message 触发）②无新通知打扰——gate ①归档静默 + **gate ②放弃轮标记阻断（防双发事故防御的回归门：被 cancel 的轮不弹完成通知，即便其结果帧晚于新轮 settle 到达）**③列表可见规模符合 §3.2.8 默认可见性裁决，用户可用 close 收纳 | G3（降级不越权）/ §3.2.8 / K11 |

---

## 5. 下一层拆分（实施单元）

| 单元 | 内容 | justification | 验收挂钩 |
|---|---|---|---|
| U1 pi-rpc 公共包 | 新包 + runtime rpc-client 薄壳化 + pi-subagent-cli stdin-writer 归并（先并存后切换；旧路径保持单 commit 可恢复） | 独立于状态机改造，先行落地降后续风险；P0 主链路分步迁移 | S7 |
| U2 领域词汇与状态机 | types.ts 两态 + intent/stopReason/epoch/lastAbandonedRound + transcriptRef 类型；store 原语扩展（markRoundIdle 扩 stopReason、markReopened 新增、markFinalized/markCancelled 退役为 markSettled、markIdleArchived 更名 markIdleEvicted——统一语言「内存回收」义） | 类型先行，后续单元按图施工 | S8 |
| U3 `.state` 语义切换与重建矩阵 | state-marker 写/读新格式 + 双向兼容映射（新版读旧值/旧版读新值均声明）；buildRecord 收敛为单规则；孤儿恢复简化（删直断分支）；`.alive` release 出口迁移（close 收起点 + 内存回收点）；binding 增字段（transcriptRef / epoch / lastAbandonedRound） | 磁盘面先稳，行为面随后 | S2/S8 |
| U4 准入判据切换 | cold-lookup 守卫段 + reviveOrThrow 合并为锚判据单点；endedMessageGuard 缩型；fork-from 守卫 4/6 调整 | 删 gate 是本设计核心交付 | S1/S2 |
| U5 意愿动作 | cancel=abort+settle+置放弃轮标记、close=归档（intent 翻转 + worktree 回收 + patch 前移 + `.alive` release + pending 注销补发 + 顺序约束）、编排性关闭（disposeAllRecords 改造：自动收起 + 立即打断 + 置放弃轮标记）、message 隐含寻回（archived→active）；worktree 重建链（含 apply 冲突三形态） | 用户可感知语义变化，独立可验 | S5/S9 |
| U6 zcode transcript 锚 | binding/entry 承载 + interact(resume) 实现 + conversation=cold + entry-born 分支删除；**会话库 TTL 清理通道（§3.2.6 风险登记，通道未落地不发布）** | 依赖 U2 类型；zcode 协议探针（P-1）前置 | S3 |
| U7 统计口径统一 | binding 基准 + settle 落快照 + revive 恢复（含 epoch / lastAbandonedRound / roundBaseTurnIndex 随 binding 恢复） | 依赖 U2/U3 | S1（统计连续）/ S9② |
| U8 投影面与契约 | shared SubagentStatus 契约 + GUI 列表/详情/**subagent-bucket 反向白名单 + SUBAGENT_STATUS_ALL 元组 + SubagentTab 判据三处同步** + 默认列表可见性/过滤器 + runtime diff 基线 + TUI 文案 + **session-reader manifest 双写映射（idle→running / archived→closed 下行 + executionStatus 新词上行）+ mapReasonToStatus 词表对齐** + 通知简化 | 最后做，消费已稳定的领域面 | S1/S2/S7/S9 |
| U9 文档同步 | 母设计 D5/D8 注记演进、constraints 更新（C-data-20 原语清单 + zcode 库 TTL 通道新条目——§3.2.6 执行锚）、explainer 更新、`check-doc-symbol-drift` 绿 | C-proc-10 设计文档同步纪律 | — |

**待验证检查点**（设计期无法确定，实施期第一批任务）：
1. ~~zcode app-server session/create 对 resume/sessionId 的接受性~~ **P-1 已测（§3.5）**：resume 读通道成立、写通道 -32031 卡死、选型定为「历史注入新会话」；残留上游跟踪项 = zcode 未来版本是否打通 restoreWarning 的协议层清除路径（打通则升级为原地 resume 续聊，机制不变只省 token）；
2. reopen 摘要的 token 成本与格式（binding 快照 → prompt 模板；zcode 侧用 resume 结构化历史注入，裁剪预算取自应答自带 tokens 数据）；
3. transcriptRef 进 binding 后旧 binding（无该字段）的读侧默认行为；
4. zcode 会话库 TTL 清理通道选型（引擎侧 sweep vs 宿主侧清库）——已升格为 §3.2.6 风险登记条目，选型在 U6 实施设计内定。

**依赖顺序**：U1 独立并行；U2 → (U3, U4, U6) → (U5, U7) → U8 → U9。
