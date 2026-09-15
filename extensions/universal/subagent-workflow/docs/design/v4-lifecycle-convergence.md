# Subagent 生命周期终态收敛技术方案（V4）

> **一句话结论**：V3 三层模型的 9 个子方案已落地 8 个（SP-7 按设计 deferred），但「最少副作用」目标尚未达成——残留 7 类问题：L1 `idle` 字面量（存储态与派生态并存）、互斥双保险（CAS + 锁，注释与代码矛盾）、**异步 EPIPE 无 error listener（可崩主进程连坐全部活跃 subagent）**、锁无超时兜底、跨重启 chatMode 恢复语义未定案（两条重建路径处理不一致）、**递归场景跨进程双 activation 风险（SP-8 全树可见后主进程可 message 孙级 record → 双写者窗口）**、文档-代码漂移 6 处。本方案以 dsh 的五条机制原则为对照锚，分两期收敛：**A 期可靠性收口（6 个独立小改，含递归直接父守卫 + 砍注入改 list 拉取）→ B 期状态收敛（L1 两态 + 单互斥源 + L2 两簿记）**，把「复杂状态机 / 并发 / 一致性孤儿 / hack session」四类副作用压到跨进程约束下的最小值。**（审查修订）B-3「单互斥源」的同步单写者不变量设计待补——原「锁内重检 by-construction」论证经源码核实不成立（TOCTOU），B-3 阻塞至方向 a/b 定案，A 期先行；A-6 砍 SP-3 每 loop 注入、改 list 按需拉取（修盲点 + 上下文税）。**

## 层声明

- **当前层**：技术方案设计（生命周期状态收敛 + 可靠性收口）
- **下一层产物**：A/B 两期各自可实现的文件级改动规格（接口/数据模型/错误规格/探针）——属「可实现的接口/数据模型/技术方案」，准则 5/6/7/11 全部 P0 适用
- **性质**：涉及运行时行为（EPIPE 错误路径、锁超时、状态字面量删除、跨重启恢复）→ 设计准则 5（物理数据流）/6（错误恢复指引）/7（运行时断言探针）全部适用
- **与既有文档的关系**：本设计是 `v3-unified-lifecycle-model.md` 的后继收敛设计（V3 的 9 个 SP 为现状基线）；dsh 对照调研见 `dsh-vs-taiji-subagent-architecture.md`（背景材料，本设计自包含、不依赖它）；详见附录。

---

## §1 背景目标

### SCQA

- **S（情境）**：subagent 多轮对话的终态架构已按 V2（进程长驻 + 文件兜底 + 统一投递）与 V3（三层生命周期模型）实现——9 个子方案中 8 个落地（SP-1~6、SP-8/9），多轮热路径（spawn 1 次、每轮 parentId 链连续）已在真实 pi 环境验证稳定；冷路径 resume、跨重启恢复（兜底重建为 idle）、fork/new 级联关闭 + 告知、compact 快照注入、one-shot upgrade、资源策略配置化全部可用。
- **C（冲突）**：但用户最初设定的验收线「尽量少的副作用（复杂状态机 / 并发问题 / 一致性孤儿 / hack session）」尚未达成——对比 dsh（同进程子代理，零存储状态机、单队列、状态全部派生）后，盘点出 7 类残留问题（§2.2 P1~P7）：其中**异步 EPIPE 可崩主进程**是生产级可靠性敞口，**递归场景跨进程双 activation**是 SP-8 可见性引入的双写者窗口，**跨重启 chatMode 恢复语义未定案**是悬置的一致性探针，**idle 字面量**是「存储态漂移」这一历史 bug 模式（hydrateIdleRecord 死路径）的现役载体。
- **Q（问题）**：如何在「子代理必须跑独立 pi 子进程」的硬约束下，把生命周期收敛到最少副作用终态——每一笔为跨进程付出的机制税只交一次、每个状态都可派生不存储、每个失败都有恢复指引——并且每一步都能在真实环境验收？
- **A（答案）**：以 dsh 的五条机制原则为对照锚（状态派生不存储 / 唯一队列 / 准入 cutoff / 结算经理化 / 身份自证），分两期落地：A 期可靠性收口（5 项独立小改，先合小修、再动状态机），B 期状态收敛（删 `idle`/`cancelled` 字面量 → L1 两态 + 派生谓词 + 单互斥源 + L2 两簿记）。本文展开。

### 系统是什么（给不懂内部的人）

`@zhushanwen/pi-subagent-workflow` 让主 pi 进程 spawn 独立子进程跑 subagent（`pi --mode rpc`），父子经 stdin/stdout 管道通信。每个 subagent 有两个持久化物：① 子进程自己的 **session 文件**（JSONL，对话历史，resume 的凭证——**唯一状态源**）；② 主进程侧的 **record**（ExecutionRecord，内存 + manifest，记录逻辑状态/pid/rootSessionId/chatMode 等元数据）。

四个核心概念（本文反复使用，先定义并绑定 §2.1 的例子）：

| 概念 | 定义 | 就是 §2.1 例子里的 |
|---|---|---|
| **record** | 一个 subagent 在主进程侧的身份与元数据（id/slug/status/chatMode/lastResult） | 主 agent 的 `start` 创建的那个 `sa-a1b2` |
| **chatMode** | start 时的声明：允许 running/idle 期间 message（许可）+ 轮次完成后进程保活（hint）；one-shot 首次 message 自动 upgrade 置位 | 例子里 `conversation:true` 的 record |
| **热路径 / 冷路径** | message 时进程活着 → 直接写 stdin（热）；进程死了 → 重新 spawn `--session` 续开（冷） | 例子里第 3 步的分流 |
| **agent_settled** | pi 的真空闲信号（`agent_end` 后 post-run loop 还会跑 retry/compaction，不算空闲） | 例子里触发 idle timer 的信号 |

### 设计目标（从使用者体验倒推）

| # | 目标 | 使用者（主 agent / 用户）体验 |
|---|---|---|
| G1 | **可靠性**：子进程任何时候死亡、主进程高负载并发、递归场景多进程可及同一孙级 record，一次 message 永不崩主进程、永不双写毁文件 | 崩溃时自动冷路径恢复 + 恢复指引，而不是整个应用消失 |
| G2 | **可预测**：任何非 closed 的 subagent 都能被**其直接父** message；「空闲/忙碌」是派生事实，重启后语义不变；跨层 message 被明确拒绝且带恢复指引 | 跨重启后 message 不报 "has ended"，upgrade 后的 record 重启仍可续聊，孙级 message 得到「经直接父转发」的指引 |
| G3 | **最少机制**：L1 两态 + 单互斥源 + L2 两簿记；删的比写的多，每个状态要么可派生、要么有唯一权威源 | （开发者体验）状态机最小，无身兼两职的守卫 |
| G4 | **可验收**：每项改动有真实 pi CLI 场景验收（不是单测/mock） | 实施者知道"做完怎么证明做对了" |

### In-scope / Out-of-scope

**In-scope**：A 期 5 项（EPIPE error listener、锁超时兜底、upgrade 定案、文档回写、**递归直接父守卫**）+ B 期收敛（删 idle/cancelled 字面量、单互斥源、L2 簿记收敛）。

**Out-of-scope**：
- SP-7 孤儿扫描增强（触发条件 = spawn 改 detach，当前 piped stdio 下不实施，V3 已裁决）
- 多 sender mailbox / broker（触发条件 = 第二个 sender 类型出现，V2 §3.5 已裁决；递归的直接父守卫正是让「sender 唯一性」by-construction 成立的手段）
- **跨层 interrupt（祖代 → 孙级）**：dsh 有 ancestor interrupt，taiji 本期不做（A-5 守卫下跨层 message 已拒绝，interrupt 单独放开留到有真实需求时）
- 树级资源总量控制（V3 D8 已裁决 known limitation）
- pi 上游 session 文件锁（非本项目可控，V2 附录 B）
- taiji 应用侧（runtime/前端）编排——应用侧是旁观 + UI 同步层，不编排 pi 行为（项目规则 #17）

---

## §2 现状与问题分析

**本章结论：多轮范式已可用（V3 九 SP 落地 8 个），但可靠性（P1/P2）、表达唯一性（P3/P4/P6）与权限一致性（P7）三个维度未收口，文档漂移（P5，6 处）持续制造认知风险。**

### 2.1 现状：一次 message 的真实旅程（使用者视角 + 物理数据流）

主 agent 用一个真实协作场景驱动 subagent（机制行对主 agent 透明，源码行号均经核实）：

```
[主 agent] start {task:"迭代 review 这个 diff", slug:"review", conversation:true}
           → record sa-a1b2（chatMode=true）→ spawn 子进程（argv 镜像 + 一组 PI_SUBAGENT_* env 贯穿身份，session-runner.ts:818-838）
[子进程]  session_start hook 经 pi.appendEntry 写 subagent-identity custom entry（index.ts:342-381）
[首轮]    agent_settled → onRoundSettled：status="idle" + round+=1 + armIdleTimer(5min)
           （触发点 session-runner.ts:670-686；status/round 写入点 subagent-service.ts:1651 正常轮次 / finalize-record.ts:235 失败轮次）
[主 agent] message {text:"第二轮：修好那 3 个 must-fix"}
           → deliverMessage（subagent-service.ts:848）：
              ├─ disarmIdleTimer → getChildByRecord 判活（session-runner.ts:256）
              ├─ 活 → 热路径：stdin 写 prompt {streamingBehavior:"followUp"}（:859）← pi 权威裁决 busy/idle
              └─ 死 → 冷路径：acquireActivateLock 排队（:894）→ resumeRound 重新 spawn --session（:760）
[轮次完]  agent_settled → 同上（idle + arm timer）→ notifier 经 triggerTurn 唤醒主 agent
[主 agent] close {subagentId} → record 终态 closed{reason:"user-close"} + 进程回收 + worktree 清理
```

物理数据流（从磁盘到主 agent 眼前的完整链路）：

```
磁盘 session 文件（JSONL，子进程单线程顺序 append，唯一状态源）
  ├─ 写者 = 子进程 pi（session_start 写 identity；prompt/tool/message 由 pi 核心写）
  └─ 读者 = ① 子进程自身（resume 时重建 tree）② 主进程 session-reconstructor（reconstructFromFile 扫 identity）
主进程内存：record-store（L1 状态）· spawnedChildren Map（进程句柄）· idleTimers（空闲派生）
主进程磁盘：manifest（终态 record 元数据）· .alive/.finalized/.cancelled 三个 sidecar
主 agent 眼前：/subagents 列表（record-store.ts:312 reconstructAll 四分支重建 + STATUS_PRIORITY 排序）
```

### 2.2 问题清单（7 项，全部经源码核实；P# 与 §3 方案一一对应）

| # | 问题 | 真实失败模式（触发条件 → 现象） | 根因 |
|---|---|---|---|
| P1 | **异步 EPIPE 无 error listener（D12 未闭合）** | 热路径写 stdin 的瞬间子进程死亡（OOM/panic/外部 kill）→ `child.stdin.write()` 的同步抛错被捕获（stdin-writer.ts:170-195），但 **stream 的异步 'error' 事件全仓库无监听**（grep 核实）→ Node 未捕获异常 → **主进程崩溃 → 全部活跃 subagent EOF 自杀 → 用户丢全部活跃上下文** | 可靠性缺口：捕获只做了一半（同步半面 + 异步半面） |
| P2 | **acquireActivateLock 无超时兜底（D3 未闭合）** | msg1 拿锁 spawn 时异常且 release 未覆盖的退出路径被触发 → msg2 永久 await → 该 record 后续 message 全部挂起（无报错无恢复） | 死锁风险：锁只有 finally，无超时兜底 |
| P3 | **跨重启重建的两条路径对 chatMode 的处理不一致 + 恢复语义未定案** | 已核实：message 路径 `getRecordForAction` 磁盘重建**无条件置 `chatMode:true`**（subagent-service.ts:943）→ 重启后 message 恒可续聊（恢复机制已存在）；list 路径 `reconstructAll` 不映射 chatMode（record-store.ts:312-406 无该字段拷贝）→ 列表无法按 chatMode 判断；upgrade 分支（subagent-actions.ts:355-358）只服务进程内 one-shot（跨重启路径上恒被 :943 绕过）。三者分工未文档化、V3 SP-5 探针悬置 | 一致性：恢复语义定案缺失 + 两条路径表达不一（同 R1） |
| P4 | **L1 `idle` 字面量残留（存储态与派生态并存）** | `ExecutionStatus = "running"|"idle"|"cancelled"|"closed"`（types.ts:45）；idle 同时被 status 字段存储、又被 `hasIdleTimer` 派生判定——两处不同步时（如 timer 被异常 disarm）列表显示与真实空闲态漂移 | 存储态漂移：V3 原案 L1 两态被「实现修订」回退成四态，偏离终态 |
| P5 | **文档-代码漂移 6 处** | ① lifecycle-manager.ts:336-343 注释「锁冗余，不接入」与 :894 已接入矛盾；② index.ts:629「防线 iii 接入留 Step 5c」陈旧；③ finalize-record.ts:188 仍写「写 .idle sidecar」（.idle 模块已删，全仓无写/读运行时代码；另有 subagent-actions.ts:284、types.ts:381/444/669、subagent-service.ts:966/998/1646 等 .idle 注释残留）；④ V3 §5.1.1 分期表未随 SP-4/5/8/9 落地回写；⑤ V3 S2 验收「grep 无 idle」与实际保留 idle 矛盾；⑥ notifier.ts:33-36 仍为 `id:round` dedup（V3 §5.3 声称 SP-1 已「回归纯 id」，未落地） | 认知漂移：维护者读到矛盾注释会误删锁或误判状态机 |
| P6 | **L2 探活横跨 4 个半独立簿记** | 判「进程活没活」有 4 个来源：`spawnedChildren` Map（句柄表）、`hasIdleTimer`（空闲派生）、`.alive` sidecar + `isProcessAlive`（跨重启探活）、`acquireActivateLock`（spawning 互斥）——任何一处不同步即误判热/冷路径 | 表达不唯一：同一事实多处簿记（与 P4 同根因） |
| P7 | **递归场景跨进程双 activation 风险（SP-8 可见性引入）** | SP-8 后全树 record 的 `rootSessionId` 都贯穿真 ROOT（session-runner.ts:818-824），而 `getRecordForAction` 只校验 rootSessionId（subagent-service.ts:952）→ **主进程可 message 孙级 record**（A 的 child B、甚至 B 的 child C）。但 B 的子进程句柄只在 A 的进程里——主进程 message B 走冷路径 resume、再 spawn 一个 B 进程 → 若 A 进程里 B 还活着，**两个进程交错写同一 session 文件 = 双写者毁文件**（acquireActivateLock 是进程内锁，跨进程各自独立，救不了） | 权限与所有权脱节：message 权限按 root 级授予，进程句柄却只存在于 spawn 它的进程（根因 R3） |

### 2.3 根因分析：四个缺失

7 个问题归到四个根因（对照 dsh 后归纳；R4 是 B-3 设计缺陷暴露后才识别的并发元根因）：

- **R1（表达不唯一，存储态与派生态并存）**：P4（idle 既存储又派生）、P6（探活四源）、P3（跨重启两条重建路径对 chatMode 处理不一致、恢复语义未定案）同一根因——**同一事实应该只有一个权威表达**。dsh 的对应做法：ActivationState 三态完全派生（`agent.status + accepted + ownedChildren`，continuation.ts:870-873），持久化只有一个 descriptor 事件。taiji 的历史 bug（hydrateIdleRecord 死路径、crashed 兜底错判）全是存储态漂移，P4 是这个模式的现役载体。
- **R2（可靠性修复与状态机重构捆绑，导致只做了一半）**：V3 D12 明确要求「EPIPE 兜底 commit 先于状态机重构独立提交」，实际实施时同步捕获做了、**error listener 没做**；D3 要求 30s 锁超时，实际只有链式 + finally。两个半成品都因为「大改已经合了，细节后补」而漏掉——**可靠性小修必须独立成 commit、独立验收**，不能与大型重构同捆。
- **R3（权限模型与物理所有权脱节）**：P7 的根因——message/close 权限按 root 级（rootSessionId）授予，而子进程句柄只存在于 spawn 它的那个进程。权限交给了「可能没有句柄、只能冷路径再 spawn」的进程，双 activation 窗口由此而来。dsh 的对应做法：followup 要求精确 live 直接父（SessionHeader.parentSession），list 中只有 depth-1 是 send_message 候选、deeper 仅 interrupt 候选——**权限与所有权同一处**，by-construction 无双写者。
- **R4（spawn 异步生命周期使同步单写者不变量不可达）**：resumeRound 是 void 同步方法，却经 kickOffBackground（fire-and-forget，`void this.runAndFinalize`）派发 spawn；runAndFinalize 内 `await this.pool.acquire()`（subagent-service.ts:1238）之后才到 runSpawn 的 `spawn()`（session-runner.ts:875）+ `spawnedChildren.set()`（:892）——**派发点（同步）与注册点（异步微任务）分离**。后果：派发点无法建立「注册即可见」的同步单写者不变量；任何在 resumeRound 同步段能设置的标记，到第二个并发 message 获锁重检时，spawn 注册可能尚未发生。B-3 原「锁内重检 by-construction」论证落空的根因即此（见 §3.3 B-3 承重缺陷）。R4 是 R1/R2 之下更深的并发元根因——它不推翻 R1/R2/R3 的归因，但约束了 B-3 的可行设计：「删 CAS」的替换物必须是**同步可见**的不变量（候选方向 a 的同步标志 / b 的同步注册段），不能用异步才就绪的 `spawnedChildren` 真值。
- （P5 是 R1/R2 的伴随症状：实施与文档不同步，本质是「变更未回写」的纪律缺失，单独列为 A-4 单元。）

### 2.4 dsh 对照锚（为什么这是终态方向）

dsh（deepseek-harness，master @ 47f9438）在同进程约束下把同样的多轮对话做到了「零存储状态机 + 单队列」。五条机制原则（本方案的对照锚，每条附源码证据）：

| # | dsh 原则 | 证据 | taiji 对应/差距 |
|---|---|---|---|
| A1 | **状态派生不存储**：ActivationState = running/waiting/settled 由 Agent 状态 + 所有权集合推导 | continuation.ts:870-873 | taiji P4/P6 违背（idle 存储、探活四源）→ B 期修复 |
| A2 | **唯一队列**：Agent inbox 是唯一 FIFO，消息只有一个可观测顺序 | continuation.ts:12-13 | taiji 已达成（V2 决策 3：pi 权威裁决，父零镜像） |
| A3 | **准入 cutoff**：销毁事务的「存在」即原子事实，交付/释放/dispose 在同一临界区判定 | continuation.ts:220-225, 1244-1250 | taiji 的锁排队已接近，缺超时兜底（P2）→ A 期修复 |
| A4 | **结算经理化**：settlement 是 manager 无条件送达的账，与 child 的报告分离 | continuation.ts:1400-1449 | taiji notifier（挂 agent_settled + triggerTurn）已同构，无需改动 |
| A5 | **身份自证**：descriptor 是 child log 的正式事件，恢复只看「log 有版本匹配的 descriptor + 精确 live 父」 | continuation.ts:883-932 | taiji identity entry 已同构（V2 决策 5），缺 upgrade 落盘（P3）→ A 期修复 |

**边界声明（方案对比的前提）**：dsh 的「同进程」本身不可移植——taiji 的子代理必须跑独立 pi 子进程（沙箱隔离、崩溃隔离、pi 生态兼容是硬约束）。本方案移植的是五条**原则**，不是进程模型；同进程免费获得的东西（事件循环串行、live 对象授权）taiji 必须显式付费，但**每笔税只交一次**（P6 的收敛目标）。

---

## §3 解决方案

**本章结论：A 期 5 个独立小改收口可靠性（含递归直接父守卫，可并行先合），B 期删 idle/cancelled 字面量 + 单互斥源 + 两簿记收敛表达；每一步都在真实 pi 环境验收。**

### 3.1 终态（使用者视角）

**场景 A：子进程中途死亡，message 自动恢复（回溯 G1）**

```
[用户] 对话进行中，subagent 子进程被 OOM 杀掉
[主 agent] message {text:"继续"}
[机制]   热路径写 stdin → 异步 'error' 事件被监听（A-1）→ 进程按 dead 处理
        → 自动冷路径 resume（--session 重开）+ 原消息重放 → 上下文保留（A 期只到「dead 标记 + 防崩主进程」，自动重放随 B-3 一并交付，见 §3.3 A-1）
[主 agent] 无感知（只看到本轮延迟略高）
[失败]   连续 2 次 EPIPE → 报错 👉 "subagent sa-x process unstable; action:'close' and start a new one"
```

**场景 B：并发 message 不双写、不死锁（回溯 G1）**

```
[主 agent] 同一 turn 并发两个 tool call message 同一 record（进程刚死）
[机制]   msg1 拿锁 spawn；msg2 等锁 → 发现进程已活 → 转热路径 prompt（排队语义，session 文件单写者成立）
[失败]   msg1 spawn 异常未正常 release → 30s 锁超时兜底自动释放（A-2）
       → msg2 报错 👉 "subagent activation timed out; retry action:'message'"
```

**场景 C：跨重启 upgrade 续聊（回溯 G2）**

```
[主 agent] one-shot start {task:"摸一下 auth 调用链"} → 完成后 message 追问（触发 upgrade）
[用户]   重启主进程 → message 该 record
[机制]   record 经 reconstructAll 分支 4 重建为 active；message 路径的 getRecordForAction
       磁盘重建无条件置 chatMode=true（subagent-service.ts:943，现状已核实）
       → 冷路径 resume → 引用首轮探索结果继续答（session 文件在，上下文完整）
       → 子进程经 env 重写 identity chatMode=true（此后持久）
[主 agent] 无感知（只看到重启后首次 message 多一次冷启动）
[失败]   理论上无失败路径——恢复机制（:943）与上下文（session 文件）都不依赖内存态
```

**场景 D：列表显示派生的空闲（回溯 G2/G3）**

```
[用户] /subagents
[机制] 「空闲」显示 = isIdle(record) = hasIdleTimer(id)（B-1 派生谓词；timer 仅 agent_settled 后 armed，armed 时进程必活）
[结果] 列表无 "idle" 状态字面量（B 期后），显示由派生谓词驱动，与真实空闲永远一致
```

**场景 E：递归两层多轮 + 跨层 message 拒绝（回溯 G1/G2，A-5）**

```
[主 agent] start {task:"协调 review", conversation:true} → A（chatMode，独立进程）
[A]      start {task:"修 diff 的 3 个 must-fix", conversation:true} → B（A 的 child，A 进程 spawn）
[A]      message B "第二轮：看测试" → A 进程内热路径（B 的句柄在 A 进程）→ B 续聊
[B 完成] B 的 notifier（运行在 A 进程）triggerTurn → A 续跑汇总
[A 完成] A 的 notifier（运行在主进程）triggerTurn → 主 agent 续跑
[主 agent] message B → ❌ 拒绝（直接父守卫：B 的直接父是 A）👉 "subagent sa-B is owned by its
           direct parent; message it through that parent (see /subagents list, parent=<A>)"
[机制]   主进程没有 B 的句柄，若放行只能冷路径再 spawn → 与 A 进程里活着的 B 双写同一 session 文件
```

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 两期收敛（本方案）**：A 期可靠性收口 5 项独立小改（含递归直接父守卫）→ B 期删 idle/cancelled 字面量 + 单互斥源 + L2 两簿记 | ✅ 终态：L1 两态、互斥唯一源、探活两源、message 权限=直接父——表达唯一 + 权限与所有权一致，R1/R3 根治；dsh 五原则全部映射 | 中：A 期 5 项各自 <100 行；B 期中重构（16+ 消费点替代 + 互斥移交） | 低-中：A 期无状态机改动、可独立回滚；B 期有编译期 Record 类型强制全覆盖 | ✅ **推荐** |
| **B 只做 A 期收口，保留 L1 四态** | ⚠️ 修了 P1/P2/P3/P5，但 P4/P6（表达不唯一）留存——idle 字面量继续是「存储态漂移」模式（hydrateIdleRecord 死路径的前身）的载体 | 低：5 项小改 | 低 | ⚠️ 可作 A 期的临时停靠点 |
| **C 点状修复（只修 P1）** | ❌ P2~P6 全部留存；下一个状态漂移 bug 随时出现（V3 对点状修复的裁决：补丁叠补丁） | 极低 | 中（技术债累积） | ❌ 否决 |
| **D 照搬 dsh 同进程模型** | ✅ dsh 架构最合理 | —— | **不可行**：子代理必须独立 pi 子进程（沙箱/崩溃隔离/pi 生态是硬约束） | ❌ 边界外（见 §2.4） |

**被否方案的具体后果**：用方案 C，§3.1 场景 B 会变成「msg2 永久挂起无报错」（P2 未修）；场景 C 会变成「重启后 upgrade 静默回退 one-shot，追问报 has ended」（P3 未修）；§2.2 的 P4 会以「列表显示空闲但实际 timer 已异常 disarm」的形态重现存储态漂移。用方案 B，上述三个场景都修好，但「idle 字面量」继续存在——任何新增消费点（未来 UI/命令）都可能再次引入「读了存储态、没读派生态」的分叉。

**A 与 B 的关系**：A 期 = 方案 B 的全部内容；B 期是 A 之上的状态收敛。A 期独立可合、独立验收；B 期依赖 A 期（锁超时兜底就位后，CAS 删除才安全）。

### 3.3 关键决策与权衡

#### A-1：stdin stream error listener 接入（修 P1，回溯 G1）

- **选择（A 期落地范围，独立可合）**：`session-runner.ts` spawn 后为 `child.stdin` 注册 `on("error")` 监听；错误（EPIPE/ERR_STREAM_DESTROYED）→ 按「进程 dead」处理：移出 `spawnedChildren` 句柄表 + 标记 dead。**A 期的价值边界 = 防崩主进程**（消除 P1 的「unhandled 'error' → 主进程崩溃 → 全部活跃 subagent EOF 自杀」敦口）——这部分独立、不依赖 B-3。
- **重放能力（随 B-3 一并交付，不进 A 期）**：原设计「若该 record 有在途 message，统一经 resumeRound 冷路径重放」依赖三样 A 期不具备的前提：① spawn 互斥由 B-3 锁下沉保证（B-3 阻塞，见 §3.3 B-3）；② 「在途 message」簿记机制（见下）；③ A 期 resumeRound 仍有 idle CAS（:763），异步 error 触发时 status 多为 `running`（turn 进行中进程死），直接调 resumeRound 必 throw——需先复位 `status="idle"`（镜像 deliverMessage 同步 EPIPE 路径 :883）。**故重放部分显式移出「A 期 5 项独立」承诺，随 B-3 一并落地**；A 期 listener 在重放能力就位前，对「写后断裂」的消息表现为「主进程不崩 + 该消息依赖下一轮机制或用户重发」（已比现状的「崩主进程」严格更优）。
- **在途 message 簿记（随重放能力一并设计）**：deliverMessage 写入 stdin 前登记 `pendingDelivery: Map<recordId, text>`，子进程首个 stdout 事件或 agent_settled 后清除；异步 error 触发时从簿记取回 text 重放。该簿记是重放的前提，与重放同属 B-3 期。
- **死循环守卫（A 期即需定义，重放落地时启用）**：异步 error 路径复用同步路径的 `epipeConsecutiveFailures` 计数器（subagent-service.ts:870 区域）——**合并计数**（同一 record 的同步/异步 EPIPE 失败累加），连续 2 次 → throw 不再 resume（与同步路径 :876 一致）。防止「子进程 spawn 即死 → error → resume → spawn → error」无限循环直到 30s 锁超时或 session 损坏。
- **依据**：现状已核实——stdin-writer.ts:170-195 只有 `child.stdin.write()` 同步抛错的捕获，**全仓库无 stream 'error' 监听**（grep 核实）；Node 的 stream 未消费的 'error' 事件会以未捕获异常抛出。V3 D12 已把 listener 列为「SP-1 的第一个 commit」，实际未落地。A 期的 listener + dead 标记是 V3 D12 的最小完整兑现。
- **被否**：只在 deliverMessage 层 catch（现状的半成品）——覆盖不了「非投递时段的进程死亡」与异步错误；error listener 是 stream 契约的标准消费点，必须补全。
- **探针**：⛔ P-epipe（§4 场景 S1：确定性注入点 kill 子进程后立即 write；**A 期断言收窄为「主进程不崩 + 进程按 dead 标记移出句柄表 + 日志记录一次 error」**；S1 的「自动冷路径重放 + 上下文保留」断言移至 B-3 补完后复跑）。

#### A-2：acquireActivateLock 加 30s 超时兜底（修 P2，回溯 G1）

- **选择**：`acquireActivateLock` 返回的 release 不变，锁等待加 30s 超时——超时则抛错（含恢复指引「retry action:'message'」），并确保释放路径正常；同步更新 lifecycle-manager.ts:336-343 与 index.ts:629 的陈旧注释为「已接入，见 V3 D3 / 本文 A-2」。
- **依据**：现状已核实——lifecycle-manager.ts:344-355 是链式 Promise 排队 + finally，**无超时**；V3 D3 明确设计「30s 超时兜底」，未落地。超时上限 30s 承接 V3 D3（锁只在 spawn 窗口持有，30s 远超 spawn 正常耗时）。
- **被否**：无超时纯 finally（现状，P2 死锁风险）；「拒绝」语义替代「排队」（并发 message 静默丢失，主 agent 的 tool call 不会自动重发——V3 D3 已裁决排队）。
- **探针**：⛔ P-lock（§4 场景 S2：注入 spawn 异常，断言 30s 后锁释放、后续 message 不永久挂起、报错含恢复指引）。

#### A-3：upgrade/跨重启恢复语义定案 = 文档化现状机制（修 P3，回溯 G2）

- **选择**：**定案 + 文档化，零新机制**。已核实的两条现状机制构成完整恢复语义：① 跨重启 message 路径——`getRecordForAction` 磁盘重建**无条件置 `chatMode:true`**（subagent-service.ts:943）→ 重启后 message 恒走 deliverMessage 冷路径续聊（「可续聊」事实上已是所有 active record 的默认能力，即 V3 方案 A 方向的先行兑现）；② 进程内 one-shot 首条 message——upgrade 分支（subagent-actions.ts:355-358）置位后走统一投递。A-3 的改动 = 给两处代码补语义注释（① 注明「跨重启恢复入口，改动必须带 S3 回归」；② 注明「进程内 upgrade 入口，与 :943 分工」）+ 关闭 V3 SP-5 悬置探针。list 路径不映射 chatMode 的问题由 B-1 的 `isResumable` 谓词（不依赖 chatMode）消除，无需补映射。
- **依据**：源码已核实——subagent-actions.ts:355-358 的 upgrade 分支在跨重启路径上恒被绕过（:943 已置 true）；「has ended」（:363-371）只在 closed/cancelled 触发（终态 record 已 archive，实际走 not found）。V3 SP-5 探针「实施时定」在此定案：机制已存在，缺的是定案与文档化。
- **被否**：manifest 落盘 + reconstructAll 新增读路径——manifest 现状是终态 best-effort 诊断通道，升格为正确性来源需新增读路径 + 原子性保证，而恢复机制（:943）已不需要它，收益仅「重启后首次 message 前列表显示 chatMode 标记」（cosmetic，且 B-1 后显示由 isResumable 派生、更不需要），成本与收益不匹配（准则 8 减法）；子进程补写 identity——upgrade 时子进程不在场（one-shot 完成后进程已退），不可行。
- **探针**：⛔ P-upgrade（§4 场景 S3：重启后 message 不报 has ended + 上下文连续 + 不产生新 record + 进程内 upgrade 路径不回归）。

#### A-4：文档-代码同步（修 P5，回溯 G3）

- **选择**：6 处漂移逐一回写：①②③④⑤ 归本单元（① lifecycle-manager.ts:336-343、② index.ts:629、③ finalize-record.ts:188 + 全仓 `.idle` 注释残留清零——已核实 subagent-actions.ts:284、types.ts:381/444/669、subagent-service.ts:966/998/1646 等 8+ 处、④ V3 §5.1.1 分期表、⑤ V3 S2 验收改判），⑥（notifier dedup）归 B-1 的裁决修订。与 A-1/A-2 同 commit 或独立 doc commit。
- **依据**：P5 清单经 read/grep 核实。文档是实施者的第二份代码；矛盾注释会诱导维护者误删锁或误判状态机（v0.3.8 PR #61 一 commit 多改动的教训延伸：变更必须回写文档）。
- **探针**：无运行时探针，验收 = §4 场景 S5 的 grep 断言（注释与代码一致）。

#### A-5：递归直接父守卫（修 P7，回溯 G1/G2）

- **选择**：`getRecordForAction`（message/close 的统一入口，subagent-actions.ts:287/:348 共用）在 rootSessionId 校验之后增加**直接父校验**：`record.parentRecordId === (this.execCtxBaseline?.recordId ?? undefined)`——根进程 baseline=null → undefined → 只能操作顶层 record（parentRecordId 缺失者）；子进程 baseline.recordId=自己 → 只能操作自己 spawn 的孩子。校验失败 → 明确错误 + 恢复指引（「owned by its direct parent; message it through that parent (see /subagents list, parent=<id>)」——主进程已可见全树，不构成信息泄露）。**close/cancel 同受此守卫约束**（同一入口）：跨重启后主进程无法直接清理孙级 record，须经父链回弹（message 直接父 → 父进程恢复 → 父内 close 其子），清理成本 = 恢复整条父链，作为语义显式接受（孙级 record 的进程已随父进程死亡，不清理的残留由 session-file-gc 30 天 TTL 兜底）。**边界（审查补）**：父链回弹要求直接父 record 可 message；若父已正常 closed（archived，getRecordForAction 抛 not found），回弹链断裂，孙级 record 在 /subagents 列表只读残留至 30 天 TTL。该场景是否可达取决于级联关闭是否保证「父 closed ⇒ 子孙必 closed」——现状 dispose 级联关闭已覆盖正常退出路径（父主动 closed 时子孙已随之 closed），故回弹链断裂主要发生于父异常死亡且子孙孤儿存活的组合，由 §3.3 B-3 单写者保证 + §4 S6⑤ 孤儿存活验证兜底。
- **依据**：① 物理所有权事实——B 的子进程句柄只在 spawn 它的进程里（`spawnedChildren` 是进程内 Map）；任何非直接父进程 message 活着的 B 只能冷路径再 spawn = 双写者（进程内锁救不了跨进程）。② dsh 同构——followup 要求精确 live 直接父（SessionHeader.parentSession），list_agents 明示只有 depth-1 是 send_message 候选、deeper 仅 interrupt 候选。③ **必须用 `execCtxBaseline` 而非 ALS store**：pi RPC 模式的 stdin JSONL 是事件回调式，ALS store 不贯穿 tool 调用事件（subagent-service.ts:236-245 代码注释记录了 ALS 不贯穿的实测结论——「递归第二层 parentRecordId/depth 丢失而 rootSessionId 正确」），baseline 在 initSession 从 env 读取、是权威回退。④ **回退语义**：身份缺省的旧/异常 record（identity 无 parentRecordId）重建后 parentRecordId=undefined → 视作根层、仅主进程可操作；当前版本 spawn 必写身份（session-runner.ts:818-838），无此现实 record，若需严格归属应重 spawn。
- **被否**：允许跨层 message（双写者回归，G1 禁止）；全局注册表/broker 跨进程锁（V2 §3.5 触发条件未到，复杂度不成比例——准则 8）；冷路径前探测「他进程是否持有活进程」（无通道可探，等于造 broker）。
- **探针**：⛔ P-parent-guard（§4 场景 S6：两层递归多轮全链路 + 跨层 message 拒绝 + 恢复指引 + 双写者零残留）。

#### A-6：砍 SP-3 每 loop 注入 → list 按需拉取（修盲点 + 上下文税，回溯 G3）

> **审查讨论新增范围**：V4 原把 SP-3（before_agent_start 每 loop 注入活跃 subagent 快照）当作已落地基线继承，P1~P7 未质疑。审查暴露「注入全树范围与 A-5 直接父权限不一致」+「每 loop display:true message 持续占上下文」两个问题后，决定转变实现方式：从「hook 被动推送」改为「agent 按需调 list 工具拉取」。

- **选择**：删除 `index.ts` 的 before_agent_start subagent-status 注入 hook（SP-3 产物）；活跃 subagent 清单改由 agent 按需调 `action:"list"` 获取。配套三处增强：
  1. **list 输出补字段**（`recordToListItem`，subagent-actions.ts:150）：新增 `parent`（parentRecordId 派生，配合 A-5 直接父守卫——agent 一眼看出「哪些我能直接 message / 哪些要走父链」）+ `resumable`（isResumable 派生，B-1 后「可续聊」的对外表达，不依赖 chatMode 字面量）。现状 list 输出只有 subagentId/agent/slug/state/status/mode/duration/model/totalTokens/sessionFile——缺这两个 A-5/B-1 后决策必需的字段。
  2. **tool description 补引导**（subagent-tool.ts）：start 前先 list 看有无可复用的活跃 subagent（对冲 compact 吞引用导致的重复 start）；这是砍掉被动注入后对抗 compact 的主动机制。现状 description 只说「use list only when you concretely need state」，无「start 前先查」引导。
  3. **list 输出含 closed record + closedReason**（承接 SP-4 级联关闭告知，见代价/风险）。

- **依据**：
  1. **盲点根治**：原 SP-3 注入的 collectRecords 按 rootSessionId 过滤（SP-8 后全树贯穿），注入的是全树 record（含主 agent 够不到的孙级），与 A-5 直接父权限不一致——主 agent 看到孙级却 message 被拒。砍注入 + list 补 parent 后，agent 调 list 时看到 parent 字段自然知道操作边界，不一致消失。
  2. **上下文税消除**：原每 loop 注入 `display:true` 的 `[subagent-status]` message 持续占用 LLM 上下文（长对话累积，compact 摘要后又重来——每 loop 重注入正是为了对抗摘要，形成「注入→累积→摘要→再注入」循环）。砍掉后上下文干净，符合 G3 最少机制。
  3. **V4 收敛后状态足够清晰**：A-5（直接父守卫）+ B-1（isResumable 派生）+ list 补 parent/resumable 后，agent 按需调 list 即得完整决策信息（谁能操作、能否续聊、谁是父），无需被动塞快照。模式转变：push → pull，符合 agent 自主性。
  4. **compact 对冲**：compact 吞引用风险仍在，但对冲从「被动每 loop 提醒」转为「agent 在决策点主动查」——tool description 引导「start 前先 list」。agent 不操作 subagent 时不需要清单（不发现遗漏的活跃 subagent 也无害，因为不操作就不会重复 start）；打算 start 时先 list 自然发现可复用的。

- **代价/风险（诚实）**：
  - compact 后 agent 若完全不触发「要用 subagent」的意图，不会调 list → 不发现遗漏的活跃 subagent。该场景下「不发现」无害（不操作即不重复 start）。真正风险 = agent 打算 start 做某事，但已有活跃 subagent 在做类似的事（compact 吞掉了其引用）→ 重复 start；由 tool description「start 前先 list」引导对冲，实测若发现引导力不够再加强。
  - **级联关闭告知（SP-4）连带**：SP-4 的 recentlyCascaded → before_agent_start 注入 `[subagent-closed]` 告知，依赖被砍掉的 hook 通道。替代：list 输出含 closed record + closedReason（fork/new 级联关闭后，agent 调 list 时能看到「N 个因 parent-fork 关闭」），是按需拉取的自然延伸。**若实测发现 agent 在 fork/new 后不够主动调 list**，可补一个极轻量的一次性提醒（不含完整快照，仅一行「fork 关闭了 N 个 subagent，用 list 查看」），作为 push 的最小残留——默认先走纯 pull，实测驱动是否加。

- **被否**：保留每 loop 注入——上下文税 + A-5 不一致（盲点 1）；改 systemPrompt 注入（before_agent_start 可返回 systemPrompt，不进对话流）——仍占 systemPrompt 空间且每 loop 刷新，不如按需拉取干净；保留注入但收窄到直接子范围——治标不治本（仍是每 loop 推送）。

- **探针**：⛔ P-list-pull（① compact 后 agent 调 list 能看到活跃 subagent + parent + resumable 字段；② tool description 含「start 前先 list」引导；③ 砍注入后日志无 before_agent_start subagent-status 注入；④ fork/new 后 list 输出含 closed record + closedReason）。

#### B-1：删 `idle` 字面量 → 派生谓词（修 P4，回溯 G2/G3）

- **选择**：`ExecutionStatus` 收敛为 `"running" | "closed"`（running 语义 = active/可交互；「是否在跑 turn / 是否空闲 / 是否可恢复」全部是派生态，父进程不维护 busy 镜像——V2 决策 3）。**L1 只在三处转换：start → running；close/取消/级联关闭 → closed**——热路径的 `record.status="running"`（subagent-service.ts:855）、各写入点的 `record.status="idle"`（:883/:946/:1651、finalize-record.ts:235）、getRecordForAction 磁盘重建的 idle 过滤（:930 过滤条件改 running）全部删除。16+ 处 idle 消费点分类替代：路由分流（messageHandler 的 idle 分支是防御性兜底，chatMode 已优先分流，删除）、resumeRound 守卫（改锁 + 进程死活，见 B-3）、列表排序/UI 显示（改派生谓词，STATUS_PRIORITY 删 idle 键）、notifier 文案（按 closedReason/lastResult 表达）；**idle record GC 判据（subagent-service.ts:485 `status === "idle" && idleSince`）改写**——删 idle 后该条件恒 false、GC 不再触发；改写为 `isResumable(record) && record.idleSince && age > 30d`（isResumable = running && 无句柄），或 idleSince 时间戳独立保留为「最后空闲时刻」不依赖 status 字面量（实施时定，关键是 GC 不能因删字面量而失效——否则 idle record 永驻内存）。
- **审查 MF-4 补的两处 idle 消费点**：index.ts:186（before_agent_start 活跃态过滤，**随 A-6 删除整个 hook 而消失，不再归 B-1**）、bg-notify-render.ts:56/:286（本地 union + 渲染守卫）——后者归 B-1 收敛（原 16+ 清单遗漏，已补入 §5.2 地图）。
- **显示派生态（非字面量，覆盖跨重启）**：
  - `isIdle(record) = hasIdleTimer(record.id)` —— 进程内空闲（timer 仅 agent_settled 后 armed，armed 时进程必活；只有 chatMode record 会 arm timer）；
  - `isResumable(record) = L1=running && 无活进程句柄` —— 跨重启 / idle 超时回收后，冷路径可 resume。**列表显示策略**：`isIdle`（进程活+空闲，无需冷启动）与 `isResumable`（进程死+可恢复，需冷启动）在列表视图统一标为可交互态——冷/热路径差异对用户透明（用户只关心「能不能继续聊」，不关心底层是否需要 respawn）；UI 可选附加标签区分（如「空闲」vs「可恢复」），但核心判定逻辑统一由派生谓词驱动，不回退字面量。**idle timer 超时行为定案（审查补）**：timer 超时 → SIGTERM kill 进程，record **不转 closed**、留 running（isResumable=true）——续聊走冷路径 resume（S4 步骤④覆盖）；timer 超时 ≠ close（前者性能回收仍可续聊，后者终态）；**不依赖 chatMode**——message 路径的磁盘重建已无条件置 chatMode=true（subagent-service.ts:943，现状已核实），「可续聊」是所有 active record 的默认能力（V3 方案 A 方向的现状兑现）；list 路径（reconstructAll）不映射 chatMode 的缺口由本谓词消除（显示不再按 chatMode 判断）；
  - **reconstructAll 分支 4（record-store.ts:403）重建映射改为 L1=running（active）、L2=absent**，列表对「无句柄的 running record」显示 resumable（isResumable 派生）——跨重启的「可续聊态」落点明确，G2 的「重启后语义不变」闭环（当前分支 4 写 `idle` 字面量，删除后无落点的问题随之消除）。
- **round 与 dedup 修订（P5⑥ 的裁决）**：`round` 是**记账字段不是状态字面量**，其递增点 onRoundSettled（agent_settled handler）在 B-1 后保留，故 round 继续可用；notifier 的 `id:round` dedup（notifier.ts:33-36）语义正确（同一轮的双发通知被去重、不同轮的通过，60s 窗口内多轮不被吞），**维持现状不动**。此裁决修订 v2-step5 决策 4 与 V3 §5.3 的「回归纯 id」——该决策的前提「删 idle 后 round 无来源」不成立（round 来源与 idle 字面量无关），且回归纯 id 反而会在 60s 窗口内吞掉第二轮完成通知（V2 决策 6 语义退化）。
- **依据**：V3 原案 L1 两态（「实现修订」以实施便利回退为四态）；dsh A1 原则（派生不存储）；v2-step5 决策 2 已定义派生谓词且 hasIdleTimer 的 arm/disarm 语义（agent_settled arm / 新 turn disarm）精确对应空闲/忙碌。存储态漂移的历史代价：hydrateIdleRecord 死路径、crashed 兜底错判（V2 Step 5 已论证）。
- **被否**：保留 idle 字面量（方案 B）——表达不唯一（P4/P6 根因）留存；dedup 回归纯 id——吞多轮通知（见上）。
- **探针**：⛔ P-idle（§4 场景 S4/S5：多轮热路径不回归 + grep 无 idle 字面量 + 列表显示与真实空闲一致）。

#### B-2：删 `cancelled` 字面量 → closed{reason:"cancelled"}

- **选择**：`cancelled` 并入 `closed`，ClosedReason 已有 `cancelled` 值（types.ts:58）。消费点（列表过滤、文案）按 closedReason 分支。
- **依据**：V3 原案；closedReason 枚举已就位（SP-1 产物），迁移是删除而非新增。
- **被否**：保留独立 cancelled 态——「实现修订」的理由（消费点分支复杂度）在终态收敛时已被 closedReason 覆盖。
- **探针**：并入 P-idle（S5 grep 断言）。

#### B-3：单互斥源 + L2 两簿记收敛（修 P6，回溯 G3）⚠️ 设计待补

> **设计状态：未闭合——实施前必须先定同步单写者不变量方案（二选一，见下「候选方向」）**。本节原「锁内重检 by-construction 单写者」论证经源码核实**不成立**（TOCTOU，详见「⚠️ 承重缺陷」）。B-3 的**方向**（锁下沉 resumeRound 作唯一 spawn 入口、删 idle CAS、探活收敛两簿记）仍然成立且是终态目标；未闭合的是「删 CAS 后单写者不变量如何同步建立」这一具体机制。B-3 **阻塞**，不与 A 期同合；A 期（含 A-1 收窄版）先行，保留现有 CAS 作为单写者守卫。

- **选择（方向，待补机制）**：锁下沉进 resumeRound 内部（唯一 **respawn** 入口——start 是新 record 首次 spawn，不经锁，不走本路径）；resumeRound 的全部调用方（deliverMessage 冷路径 subagent-service.ts:896、EPIPE 环回 :884、redeliverPendingMessages 补投 :1512、A-1 异步 error 路径）以后不再自带锁包装。同时删除 resumeRound 的 idle CAS（`status!=="idle"` 检查 + 同步翻 running，:763/:803，随 idle 字面量一起删除）。**但「锁内重检进程死活」不能直接用 `getChildByRecord`/`spawnedChildren` 作为判据**——见承重缺陷。

- **⚠️ 承重缺陷（TOCTOU，源码核实，原论证不成立）**：原文称「锁下沉后，锁内重检 `spawnedChildren` 即可保证单写者 by-construction」。该因果链经源码核实**不成立**：`kickOffBackground`（subagent-service.ts:1369）是 fire-and-forget（`void this.runAndFinalize`，:751-753 注释自述「不 await，runAndFinalize 在 background 跑」）；`runAndFinalize`（:1221 async）→ `await this.pool.acquire()`（:1238）→ 之后才到 `runSpawn` 的 `spawn()`（session-runner.ts:875）+ `spawnedChildren.set()`（:892）。即 **child 注册是异步阶段**。若按原设计把锁移入 resumeRound，`finally releaseLock()` 在 kickOffBackground 返回的**当前 tick** 执行——**早于** child 注册。并发 msg2 获锁后「锁内重检 `spawnedChildren`」仍为空 → 判定「死」→ msg2 也 spawn → **双写者**（G1 承诺关闭的窗口被重新打开）。当前真正防双 spawn 的是 resumeRound 的**同步**状态翻转（:803 `record.status="running"`，在 kickOffBackground:818 之前同步执行）+ CAS（:763 `status!=="idle"` throw，第二个等锁者看到 running 即被拦）；lifecycle-manager.ts:336 注释亦自认「单 activation 不变量已由同步状态 CAS 覆盖」。**B-3 删除 CAS + 同步翻转，替换为 TOCTOU 异步重检，净效果是消灭唯一真守卫**。

- **候选方向（实施前二选一，补完同步单写者不变量）**：
  - **(a) 同步 spawning 标志**：resumeRound 在 kickOffBackground **之前**同步置一个「spawning」标志（record 字段或 `spawnedChildren` 预占位，如先 set 一个 sentinel/占位 Promise），锁内重检该**同步标志**而非异步才就绪的 `spawnedChildren` 真值。改动局部，不重构 runSpawn；缺点是引入一个中间态标志（与「状态派生不存储」理念有张力，需论证该标志是 L2 物理态而非新 L1 状态）。
  - **(b) 重构 runSpawn 拆同步注册段 + 异步泵段**：将 runSpawn 拆为「同步 spawn-and-register（spawn + spawnedChildren.set，返回 child）」+「异步 pump（stdout/stderr listener、prompt 投递、await pool.acquire 移入泵段或前置）」两段，锁覆盖到注册完成（需重构 kickOffBackground 使 resumeRound 能 await 到注册点，resumeRound 由 void 改为 await 注册点后返回）。改动较大但消除中间态标志，单写者 by-construction 真正成立。
  - 两方向均需在实施期补探针：并发双 message 下，msg2 拿锁后的重检点能看到 msg1 的占位/注册（方向 a 的标志 / 方向 b 的注册），从而转热路径而非双 spawn。

- **探活收敛为两簿记（与单写者机制正交，可先行定案）**：进程内 = `spawnedChildren` Map（唯一权威句柄表），跨重启 = `.alive` sidecar（只判定「热路径可行否」）；`hasIdleTimer` 是空闲派生（非探活）。

- **依据（修订）**：EPIPE 环回路径（:882-884）当前不拿锁，其双写防护完全依赖 CAS——这条核实仍然成立，且恰恰证明「删 CAS 必须先补等价的同步单写者不变量」。dsh A3 原则（准入判定在同一临界区）是对的方向，但 dsh 是同进程（临界区内对象注册同步可见），taiji 的 spawn 是跨进程异步——「锁内重检」要达到 by-construction，必须解决「注册点晚于锁释放」的时序（即候选方向 a/b 要解决的问题）。原文「锁下沉后该出口消失」的论断**错误**，已由本节承重缺陷更正。

- **被否**：CAS + 锁双保险常驻——语义重复 + 注释矛盾（P5），维护者不知道哪个是权威；锁保持在调用方（resumeRound 外）——未来新调用方忘记拿锁即回归双写者，by-construction 优于纪律（该理由仍成立，但前提是 a/b 之一真正建立同步不变量）。

- **探针**：⛔ P-mutex（§4 场景 S2 复跑：并发双 message 只 spawn 一次、无双写；spawn 异常注入下锁超时兜底生效）。**注意：S2 的「spawn 次数 = 1」断言依赖 B-3 补完同步不变量后才成立；B-3 未补完前，单写者由 A 期保留的 CAS 保证（A 期 S2 验收仍以 CAS 守卫为前提，不预先删 CAS）。**

### 3.4 问题 → 方案映射（因果链自证）

| 问题 | 措施 | 验收 |
|---|---|---|
| P1 异步 EPIPE | A-1 | S1 |
| P2 锁无超时 | A-2 | S2 |
| P3 跨重启 chatMode 恢复语义未定案 | A-3（现状机制定案 + 文档化） | S3 |
| P4 idle 字面量 | B-1 | S4/S5 |
| P5 文档漂移 | A-4 | S5 |
| P6 探活四源 | B-3（⚠️ 阻塞，同步不变量待补，见 §3.3 B-3） | S2/S5（S2 单写者断言分期，见 §4） |
| P7 递归跨进程双 activation | A-5 | S6 |

---

## §4 验收（真实场景，非单测非 mock）

**本章结论：6 个真实 pi CLI 场景逐一回溯 G1~G4，机制侧断言（spawn 次数 / parentId 链 / grep / 进程存活 / 拒绝信息）优先于 LLM 表现。**

**验收环境**：本地 pi CLI 实测（项目规范 [MANDATORY]：pi extension 优先在本地 pi 实测，不优先在 taiji 验证）——`pi --mode rpc --session-dir <dir> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <ext-path>`，stdin JSONL 发 prompt，检查 session 文件 + `PI_EXT_DEBUG=1` 日志。测试模型用 `xiaomi-token-plan-cn/mimo-v2.5-pro`（禁止 kimi）。**改动规模：大（A 期 5 项 + B 期状态机重构）**；单测仅作回归辅助，不计入验收。**注入点声明**：S1/S2 的测试后门/注入只负责**制造竞态窗口**（真实的并发竞态与进程死亡无法天然编排），被验证的代码路径是真实 pi 子进程、真实锁、真实 session 文件——不是整体 mock；另以「自然发生（非注入）的长跑观察」（S1 步骤 ④、S2 步骤 ④）作为补充，避免验收被注入点局限。

### S1：子进程死亡 → message 自动冷路径恢复（回溯 G1，A-1）

- **步骤**：① chatMode 起 subagent，首轮完成（进程空闲）；② `kill -9 <pid>` 模拟死亡；③ 立即 `message` 续聊（覆盖「写 stdin 瞬间进程死」的竞态；若概率性不命中，用测试后门在「判活后、写 stdin 前」注入点 kill——V2 场景 H 的测试后门先例，仅测试构建开启）；④ 补一条自然发生观察：多轮协作跑 30 分钟以上，**判据 = 该时段日志零 unhandled 'error'**（非注入，长跑兜底观察；不作为 S1 硬门禁，作为 A-1 listener 长效性的补充证据）。
- **通过标准**：主进程不崩（unhandled 'error' 已被监听，A-1）；进程按 dead 标记移出 `spawnedChildren` 句柄表；日志记录一次 stdin error。**「自动冷路径 resume + 原消息重放 + 上下文保留」断言移至 B-3 补完后复跑**（A 期重放能力未交付，见 §3.3 A-1）；连续 2 次 EPIPE（同步路径）报错含 `action:'close' and start a new one` 恢复指引。

### S2：并发双 message 单写者 + 锁超时兜底（回溯 G1/G3，A-2/B-3）

- **步骤**：① chatMode record 空闲（进程活）→ `kill <pid>` 让进程死；② 经测试后门并发触发两条 message（都走冷路径竞争锁）；③ 注入 spawn 异常 mock，复验锁释放与超时；④ 补一条自然发生观察：主 agent 同 turn 并发多个 message tool call 的真实运行中，观察单写者与锁行为（非注入，长跑兜底观察）。
- **通过标准**：spawn 次数 = 1（单写者成立）；session 文件 parentId 链完整（无双写交错）；第二条等锁后走热路径；spawn 异常后锁在 30s 内释放（超时兜底），后续 message 不永久挂起，报错含 `retry action:'message'`。**分期说明**：A 期（CAS 仍在）的「spawn=1」由 resumeRound 同步 CAS（:763）+ 状态翻转（:803）保证；B-3 删 CAS 后该断言依赖 B-3 补完同步不变量（方向 a/b）才成立——B-3 未补完前 S2 验收的是「CAS 守卫有效」，补完后复跑验收「锁内同步重检有效」。

### S3：upgrade 跨重启续聊（回溯 G2，A-3）

- **步骤**：① one-shot start（task="列出 extensions/ 下所有包名"）；② 完成后 message 追问（触发 upgrade）；③ `kill -9` 主进程；④ 同 session-dir 重启；⑤ message 继续追问。
- **通过标准**：⑤不报 "has ended"（:943 无条件 chatMode=true 机制生效，A-3 已核实）；重启后 message 路径磁盘重建置 chatMode=true 且冷路径 resume 后回复引用首轮与第二轮内容（parentId 链连续）；不产生新 record（同一 sa-id 续聊）；进程内 one-shot 首条 message 的 upgrade 分支（:355-358）不回归（进程内用例单独验证 chatMode 翻转）。**list 显示「可续聊态」断言移至 B 期 S4**（isResumable 是 B-1 派生谓词，A 期不存在；A 期 S3 只验「机制可续聊」，不验「列表显示」）。

### S4：B 期后多轮热路径不回归（回溯 G2/G3，B-1）

- **步骤**：① conversation:true 起 reviewer subagent；② 连发 3 轮 message；③ `/subagents list` 观察；④ 等 idle timer 超时（配短 timeout）后再 message。
- **通过标准**：spawn 次数 = 1（热路径无新进程）；parentId 链连续；每轮 notify 到达（dedup 不吞）；列表「空闲」显示由派生谓词驱动、与真实空闲一致（timer armed ↔ 显示空闲）；超时回收后 message 走冷路径恢复，上下文保留；**list 显示「可续聊态」由 isResumable 派生（running && 无活进程句柄），跨重启/超时回收的 record 显示一致**（从 S3 移入，B-1 isResumable 谓词就位后验收）。

### S5：机制审计 grep 断言（回溯 G3，A-4/B-1/B-2/B-3）

- **步骤**：全量 grep 断言（编译期 + 运行时双重）——**同时提交为 CI check**（与项目现有 pre-commit check 体系一致，纯文本 grep 不依赖 LLM，防止回归；运行时验收在 pi CLI 手动执行）：**全仓 `idle`/`cancelled` 字面量零残留**（不只 ExecutionStatus 定义处——含本地重声明 union，如 bg-notify-render.ts:56 `status: "closed" | "cancelled" | "idle"`；tsc 对 union 超集不报错，死分支需人工审计）；`child.stdin` 有 `on("error")` 监听；**互斥断言（分期）**：A 期 = resumeRound 仍持 CAS（:763）+ 同步翻转（:803）、deliverMessage 冷路径锁在调用方（:894）、EPIPE 环回（:884）不拿锁依赖 CAS——单写者由 CAS 保证；B-3 补完后 = `acquireActivateLock` 下沉 resumeRound 内 + 同步不变量（方向 a/b，见 §3.3 B-3）+ 全部调用方无独立锁/无直接 spawn；`.idle` 引用与注释残留为零（以全量 grep 清零为准，实际约 13 处，见 §2.2 P5③）；P5 的 6 处漂移（①-⑥）均已回写或裁决（⑥ 归 B-1）。
- **通过标准**：上述 grep 全部零违例；tsc 通过（Record<ExecutionStatus, T> 强制全覆盖）；**全仓 union 字面量人工审计零残留**（tsc 不覆盖本地重声明 union，MF-4）；全测试通过（回归辅助）。

### S6：递归两层多轮 + 跨层 message 拒绝（回溯 G1/G2，A-5）

- **步骤**：① 主进程 chatMode 起 A（task 含「起一个 chatMode B 并与其多轮协作」）；② A 起 B（conversation:true）→ 首轮完成后 A message B 第二轮（断言 A 进程内热路径、spawn 次数观察）；③ B 完成 → B 的 notifier triggerTurn 使 A 续跑 → A 汇总完成 → A 的 notifier triggerTurn 使主 agent 续跑（两层接力 notify 都到达）；④ **负例**：主进程先 `/subagents` 列出树（可见 B 及其 parent=<A>）取得 B 的 id，然后直接 message B → 断言被拒 + 错误含「direct parent」恢复指引；⑤ `kill -9` 主进程 → 同 session-dir 重启 → 主进程 message A（冷恢复）→ A message B（冷恢复）→ 两级上下文连续。**前提验证（实施期门）**：kill 主进程后须先确认 A/B 子进程是否随 stdin EOF 连坐死亡（pi 子进程有独立事件循环，孤儿存活与否需实测）——若孤儿存活，重启后 message A 走冷路径再 spawn 会与存活老 A 双写同一 session 文件（P7 双 activation 作用于 A 自身）；该路径单写者保证依赖 B-3 补完后同步不变量（MF-1），B-3 未补完前以「A/B 连坐死亡」为前提（实施时 ps 验证无存活老进程）；⑥ 跨重启清理：重启后主进程直接 close B → 断言被拒（同守约束），改走父链（message A 让其 close B）→ B 被正常清理。⑦ **（A-6）list 拉取验证**：agent 调 `action:"list"` → 断言输出含 A、B 两条 + 每条 `parent` 字段正确（B.parent=A，A.parent 缺省/根）+ `resumable` 字段（chatMode record 为 true）；砍注入后日志无 before_agent_start subagent-status 注入。
- **通过标准**：② A→B 多轮 spawn 次数 = 1（A 进程内热路径，无重复 spawn）；B 的 session 文件 parentId 链完整；③ 两层 notify 接力到达（B→A→主）；④ 拒绝信息含恢复指引且双写者零残留（ps 断言同一时刻只有一个 B 进程；:⑤ 后同样断言）；⑤ 两级冷恢复后上下文连续、无 "has ended"、无孤儿残留；⑥ close 跨层被拒 + 父链回弹清理成功。LLM 侧（A 是否真的 message B 第二轮）为观察项，机制侧断言为主（V2 §4 原则）。

> **每场景回溯**：S1→G1、S2→G1/G3、S3→G2、S4→G2/G3、S5→G3、S6→G1/G2。G4（可验收）由本章自身满足。

---

## §5 下一层拆分

**本章结论：A 期 6 单元互相无依赖、可并行先合；B 期中 B-1/B-2 依赖 A-2 可独立推进，B-3 ⚠️ 阻塞（单写者同步不变量未闭合，见 §3.3 B-3 承重缺陷，实施前须二选一定方向 a/b）；每单元独立 commit + 独立验收。**

### 5.1 实施路径（分两期，每单元独立 commit + 独立验收）

**A 期（可靠性收口，6 单元，可并行，先于 B 期全部合入）**

| 单元 | 改动 | 验收 | justification |
|---|---|---|---|
| A-1 | `session-runner.ts`：spawn 后注册 `child.stdin.on("error")` + dead 标记（移出句柄表）；`stdin-writer.ts`：错误语义注释。**重放 + 在途 message 簿记随 B-3**（见 §3.3 A-1） | S1（A 期断言收窄） | 生产级可靠性敞口，最小改动独立合（V3 D12 教训：可靠性小修不得与状态机重构同捆） |
| A-2 | `lifecycle-manager.ts`：锁 30s 超时 + 陈旧注释回写；`index.ts:629` 注释回写 | S2（spawn 异常注入部分） | 死锁兜底，同时消除 P5 ①② 漂移 |
| A-3 | `subagent-service.ts`/`subagent-actions.ts`：两处恢复入口补语义注释（:943 跨重启入口 / :355-358 进程内 upgrade 入口 + 协同守护说明），零新机制；探针验证 | S3 | 消除悬置探针，定案现状机制（准则 8 减法：manifest 升格被否，见 §3.3 A-3） |
| A-4 | 文档回写 6 处（P5 清单：①②③④⑤ 归本单元，⑥ 归 B-1 裁决） | S5（grep 部分） | 纪律：变更必回写文档 |
| A-5 | `subagent-service.ts`：getRecordForAction 增加直接父校验（execCtxBaseline）；`subagent-actions.ts`：跨层拒绝错误文案 + 恢复指引 | S6 | 递归双写者 by-construction 消除（权限与所有权同一处，dsh 同构）。**中间态安全性**：A-5 先合、B-3 后合的中间态（守卫阻止跨层 message，但锁仍在调用方、EPIPE 环回仍依赖 CAS）是安全的——A-5 的直接父守卫独立消除双写者窗口（主进程无法 message 孙级 record → 无法冷路径再 spawn 孙级），与锁位置正交；B-3 延迟合入不回退 A-5 的安全收益 |
| A-6 | `index.ts`：删除 before_agent_start subagent-status 注入 hook（SP-3 产物）；`subagent-actions.ts`：recordToListItem 加 `parent` + `resumable` 字段；`subagent-tool.ts`：description 补「start 前先 list」引导 | S6（list 探针部分） | 修盲点（注入全树 vs A-5 权限不一致）+ 消除每 loop 上下文税；与 A-5 协同（list 补 parent 后 agent 知道操作边界）；compact 对冲靠 tool description 引导 |

**B 期（状态收敛，B-1/B-2 依赖 A-2 可独立推进；B-3 ⚠️ 阻塞待补设计）**

| 单元 | 改动 | 验收 | justification |
|---|---|---|---|
| B-1 | `types.ts`：ExecutionStatus 收敛两态 + 新增 isIdle / isResumable 派生谓词；16+ 处消费点替代（record-store STATUS_PRIORITY / subagent-actions 分流 / gui-mappers / notifier 文案）；reconstructAll 分支 4 映射改 L1=running | S4 | P4 根治，编译期 Record 类型强制全覆盖 |
| B-2 | `types.ts`/消费点：cancelled 并入 closed{reason} | S5 | 与 B-1 同 commit（同类型变更），删除而非新增 |
| B-3 ⚠️ 阻塞 | `subagent-service.ts`：锁下沉 resumeRound（唯一 respawn 入口）+ 删 CAS + 三调用方删外层锁；L2 簿记收敛。**单写者同步不变量待补**（原「锁内重检 by-construction」论证不成立，见 §3.3 B-3 TOCTOU）——实施前必须二选一：(a) 同步 spawning 标志 / (b) 重构 runSpawn 拆同步注册段 | S2（复跑，**依赖 B-3 补完**） | P6 根治；依赖 A-2 超时兜底；⚠️ 未补完前不得删 CAS（A 期 CAS 是唯一单写者守卫） |

### 5.2 文件改动地图

| 文件 | 单元 | 改动 |
|---|---|---|
| `execution/session-runner.ts` | A-1/B-3 | stdin error listener + dead 标记（移出句柄表）；（B-3）在途 message 簿记 + 重放衔接 |
| `execution/stdin-writer.ts` | A-1 | 错误语义注释（同步/异步两半面的契约说明） |
| `execution/lifecycle-manager.ts` | A-2/B-3 | 锁超时；注释回写；（B-3）互斥唯一源（锁在 resumeRound 内部）的契约注释 |
| `src/index.ts` | A-2/A-4/A-6 | :629 注释回写；文档一致性；**（A-6）删除 before_agent_start subagent-status 注入 hook**（SP-3 产物，含 :186 活跃态过滤随之删除） |
| `execution/record-store.ts` | B-1/B-2 | STATUS_PRIORITY 收敛；reconstructAll 分支 4 重建映射改 L1=running；消费点替代 |
| `execution/types.ts` | B-1/B-2 | ExecutionStatus 两态 + 派生谓词类型（isIdle / isResumable） |
| `execution/subagent-service.ts` | A-3/A-5/B-1/B-3 | 恢复入口语义注释；getRecordForAction 直接父校验；L1 只在三处转换（删 4 个 status 赋值点）；锁下沉 resumeRound + 全部调用方删外层锁 + 删 CAS（⚠️ B-3 单写者同步不变量待补，见 §3.3）；簿记收敛；**（B-1）:485 idle record GC 判据改写 + idleSince 语义定案** |
| `interface/subagent-actions.ts` | A-3/A-5/A-6/B-1 | upgrade 幂等语义注释；跨层拒绝错误文案；**（A-6）recordToListItem 加 `parent` + `resumable` 字段**；idle 分支删除 |
| `interface/subagent-tool.ts` | A-6 | **tool description 补「start 前先 list 看有无可复用」引导**（砍注入后对冲 compact 的主动机制） |
| `interface/gui-mappers.ts` / `format.ts` / `execution/notifier.ts` | B-1 | 显示/文案改派生谓词 |
| `interface/bg-notify-render.ts` | B-1/B-2 | **本地重声明 union `status: "closed" \| "cancelled" \| "idle"`（:56）收敛** + 渲染守卫（:286）删 idle/cancelled 分支（审查 MF-4 补：原地图遗漏该文件） |
| `docs/design/v3-unified-lifecycle-model.md` | A-4 | §5.1.1 分期表回写、S2 验收改判 |

### 5.3 待验证检查点（实施期门）

1. **hasIdleTimer 与 busy 的同步性**（B-1 承重前提）：idle timer 的 disarm 时机（新 turn 开始）是否与「进程开始忙」完全同步——若 disarm 晚于实际 turn 开始，窗口期派生谓词误报空闲。⛔ S4 步骤 ③ 观察列表与真实空闲一致性。
2. **锁超时时长与 spawn 耗时关系**（A-2）：30s 是否在「spawn 正常耗时」与「用户可感知挂起」之间取到合理点——S2 步骤 ③ 实测 spawn 异常场景的兜底时延。
3. **:943 无条件 chatMode=true 的语义边界**（A-3）：该机制把「任何可重建 active record」视为可续聊——与 V3 方案 A 终态语义一致；若未来引入「不可续聊的 active 中间态」会与之冲突，不做额外护栏，由 S3 + 代码注释守护。
4. **跨重启与进程内两条升级路径的协同守护**（A-3）：跨重启 = getRecordForAction :943 无条件置位；进程内 = upgrade 分支 :355-358。任何改动这两处的 PR 必须带 S3 类回归场景——该守护写进两处代码注释（A-3 的落点）。
5. **存量测试对跨层 message 的依赖**（A-5）：A-5 收紧守卫后，若现有测试/用例断言「主进程可 message 孙级 record」需同步改——实施时 grep `message` 相关测试确认；不改则行为回归（S6 步骤 ④ 覆盖该行为的正确形态）。
6. **B-3 单写者同步不变量方案决策**（B-3 承重，阻塞项）：删 CAS 后单写者由什么同步机制保证——必须在方向 (a) 同步 spawning 标志 / (b) 重构 runSpawn 拆同步注册段 之间二选一并补探针（并发双 message 下 msg2 重检点能看到 msg1 的占位/注册），否则不得删 CAS。详见 §3.3 B-3 承重缺陷与候选方向。
7. **A-6 compact 对冲实测**（A-6）：砍掉每 loop 注入后，compact 吞引用的对冲完全依赖 tool description「start 前先 list」引导 + agent 自主调 list。实测重点：compact 后 agent 打算 start 新 subagent 时，是否会先 list 发现已有的可复用 record（而非重复 start）。若引导力不足（agent 不主动 list → 重复 start），按 §3.3 A-6 代价/风险节补极轻量一次性提醒。

---

## 附录：与既有文档的关系

- **`v3-unified-lifecycle-model.md`**：本设计的现状基线（其 9 个 SP 的落地状态即 §2 前提）；B-1/B-2 是其「方案 A 终态」的兑现，A-1/A-2 是其 D12/D3 两个未闭合承诺的补完。
- **`subagent-continuous-chat-v2.md`**：进程长驻 + 文件兜底 + 统一投递 + 归属守卫的范式来源，全部保留不动。
- **`v2-step5-idle-state-removal.md`**：B-1 的消费点清单与派生谓词直接承接其决策 2/方案 B。
- **`v2-defense-ii-iii-resolution.md`**：其「CAS 已覆盖互斥」的裁决在 B-1 删除 idle 后失效，互斥职责移交锁——本文 B-3 承接该移交，但「锁下沉即 by-construction 单写者」的论证经审查核实不成立（TOCTOU），B-3 阻塞至同步不变量方案（方向 a/b）定案（见 §3.3 B-3），未兑现 v3 D3 的更新承诺。
- **`dsh-vs-taiji-subagent-architecture.md`**：dsh 对照调研（背景材料，§2.4 的五原则锚即其结论）。
