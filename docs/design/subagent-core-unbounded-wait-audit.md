# subagent-core 无界等待家族缺陷普查与修复方向

> **[HISTORICAL] 证据快照注记（2026-09-11，H1 符号清扫批）**：本文 §7 证据链中引用的 `closeChatIdle` / `closeAfterRoundSettled` / `armChatIdleTimer` 等 chat 域符号与对应行号，系审计取证时点（H1 落地前）的源码快照——该批符号已随 [subagent-chat-run-unification.md](subagent-chat-run-unification.md)（H1）chat 域退役而删除；审计结论（「正常路径逐点根修 + 回收层统一有界兜底」两层裁决）不受影响，证据行号不再对应当前代码。

> **一句话结论**：weekly/monthly workflow 并发挂死（RC-1/2/3）不是孤立 bug，而是「默认无界」设计裁决的家族性发作——全仓普查共登记 **32 条同家族独立缺陷**（原始普查 34 条发现经并条归并；13 条可致永久挂起/进程泄漏/宿主崩溃），修复按「正常路径逐点根修 + 回收层统一有界兜底」两层推进，兜底只许出现在回收层。

## 修订记录（2026-09-10 架构分叉后的重放移植）

> **本文档的 §7.2 T8 与 §7.3 P-T1 更新、§11-1 载体声明是线 B（旧架构）的落地回写，已被架构分叉取代。** 2026-09-10 本分支按 [subagent-agent-end-recovery-replay.md](subagent-agent-end-recovery-replay.md)（重放移植权威 SSOT）在 dev-0.9.16 新架构上重新落地：M0 把代码面**整树重置**到 dev-0.9.16（决策 7），**线 B 的旧实现宿主 `packages/subagent-core/src/execution/engine/engines/pi/` 整目录已删除**。下文引用的 `session-runner.ts` / `get-state-handshake.ts` / `session-file-locator.ts` / `session-pending.ts` 等 engines/pi 系文件路径，以及 `locateSessionFileByScan` / `runAgentEndDisposition` / `evaluateDispositionBranches` / `armDispositionRetryWindow` / `exhaustDispositionRetryWindow` / `deriveDescendantCapable` / `PI_SUBAGENT_SELF_RECORD_ID` 等符号，**均为线 B 历史记录，不再对应当前代码**。

**D1-D4 移植判定（以 replay.md §3.2 为准）**：

| 项 | 旧机制（本 audit 关联面） | 判定 | 新落点（当前树） |
|---|---|---|---|
| **D1 握手迟到接受** | 迟到 response 幂等回填 sessionFile | **不移植（等价覆盖且更强）** | 既有 `packages/pi-subagent-cli/src/spawn-run-pump.ts`（零改动） |
| **D2 sessionDir 扫描兜底** | `locateSessionFileByScan`（identity entry 精确匹配；T8/P-T1 回写所引） | **精简重放（匹配键更换为 prompt 头部键）**：identity entry 数据源结构性消亡（决策 6） | M4 `packages/pi-subagent-cli/src/session-file-locator.ts`（新）+ `spawn-run-pump.ts` close finalizer；M2 `spawn-runner.ts` agent_end 惰性 get_state 回补 |
| **D3 处置翻转 + 15s 窗口** | T8 登记的 `descendantCapable` + error 分支 15s 回补窗口 | **不移植（问题域结构性消失）**：新架构 agent_end 无条件 kill，无保守等待分支 | — |
| **D3a descendantCapable 快路径** | 无后代能力工具零判定直接杀 | **不移植（被整体包含）** | — |
| **D4 spawn-channel 门面** | 七件原语归一 | **不移植（目标已由进程边界达成）**：原语住在 pi-subagent-cli + SDK | — |

**本次重放移植的实际落点（M1-M4，均 committed）**：

| 单元 | 关联本 audit 主题 | commit | 落点文件 |
|---|---|---|---|
| M1 S2 契约修复 | RC-1 握手一次性缺陷的契约面防御 | `9578af7f4` | `packages/pi-subagent-cli/src/get-state-handshake.ts` |
| M2 agent_end 惰性回补 | T1 惰性回补在新架构的重放 | `042dccec6` | `packages/pi-subagent-cli/src/spawn-runner.ts` |
| M3 workflow 域守护补挂 | 本 audit §7.2 T2-③ 同原语（`settled-watchdog`）在新域补挂 | `bd4404ddf` | `packages/subagent-core/src/execution/subprocess-agent-runner.ts` |
| M4 close 兜底扫描 | T1 的 LC-4/PS-9 兜底面在新架构的重放（键更换） | `f737baa7a` | `packages/pi-subagent-cli/src/session-file-locator.ts`（新）+ `spawn-run-pump.ts` |

**对本文两处「已闭合」声明的勘误（当前树口径）**：① §7.3 P-T1 降级路径列称「D2 扫描兜底接入 agent_end 决策回补链 + close 收尾反查链两点、LC-4/PS-9 修复面闭合」——该两点接入属线 B；新架构 M4 只在 **close 收尾单点**（LC-4 之后）扫描，agent_end 侧改由 **M2 惰性 get_state 回补**承担（不再扫目录），且匹配键为 prompt 头部而非 identity entry。② §7.2 T8 的 15s 回补窗口在本次重放**不移植**（判定 D3 问题域结构性消失），T8 仅作线 B 历史决策保留。当前实现与排查词条以 replay 设计 + [../troubleshooting.md](../troubleshooting.md) §12 为准。

## 开篇（SCQA）

- **S（情境）**：subagent-core（`packages/subagent-core/`）是 xyz-agent 的子代理执行核心——spawn pi RPC 子进程跑 subagent、worker 线程跑 workflow 编排，承载着 daily/weekly/monthly 等生产调度。
- **C（冲突）**：2026-08 底 carbon 生产机上 weekly/monthly workflow 反复整批卡死（并发批次全部停 `running`，直到 rpc-client 5400s 外层超时被杀）；根因分析实锤了 RC-1/2/3 组合缺陷，但这三条是点状修复对象，背后是同一种设计裁决在全仓的分布。
- **Q（问题）**：这种「一次异常 → 永久挂起/泄漏」的缺陷在全仓还有多少处实例？它们各自的断点在哪？按什么顺序、用什么方向修？
- **A（答案）**：本文登记全部 32 条独立缺陷（原始普查 34 条发现经并条归并，推导见附录 B；每条带 file:line 证据 + 触发→后果→兜底→断点四段式），归纳出 7 类失败模式与 1 个共同根因，给出「正常路径优先、兜底收敛到回收层」的修复方案与验收标准。

## 1. 背景：被设计的系统是什么

**本章结论：subagent-core 提供「spawn 子进程执行 agent + worker 线程编排 workflow」两类能力，本次设计聚焦它的进程/等待/回收生命周期。**

subagent-core 是 pi extension `@zhushanwen/pi-subagent-workflow`（8.7.0）与 zcode zsw CLI 共享的执行内核。它对上暴露两类调用：

1. **subagent 调用**：`runSpawn` spawn 一个 `pi --mode rpc` 子进程执行任务。RPC 模式子进程是长驻的——完成任务后**不会自己退出**，由父进程在 `agent_end` 事件时决策：有活跃后代则 keep-alive 等唤醒，没有则 kill 触发 close、runSpawn 返回。
2. **workflow 编排**：workflow 脚本跑在 worker 线程里，脚本内的 `agent()` 经 IPC 消息投递到主线程 dispatch，结果再 postMessage 回 worker。并发由 concurrency-pool 控槽。

一次 workflow `agent()` 调用的完整控制链（本文反复引用的锚定数据流）：

```
workflow 脚本 agent()
  → worker postMessage {type:"agent-call"}                （worker pending Map 等 agent-result）
  → 主线程 dispatchAgentCall → executeAgentCall → runner.run
  → runSpawn：spawn pi --mode rpc 子进程
      → stdout pump 逐行解析事件
      → get_state 握手（一次性，3×2s+500ms 预算）→ 回填 record.sessionFile
      → agent_end 事件 → readActivePendingFromSessionFile(record.sessionFile)
          → 三分支：有后代 keep-alive / 无后代 final kill / 读不出保守不杀
      → kill → close 事件 → waitForChildExit resolve → runSpawn 返回
  → executeAgentCall finalize → postAgentResult 回 worker
  → worker pending resolve → 脚本继续 → 并发池 release 槽位
```

**这条链上任何一个 await 无界，整链无界**——生产事故正是断在「握手失败 → sessionFile 缺失 → 保守不杀 → 不限时等待 → close 不到 → 池槽不放」。

**当前层 → 下一层声明**：本文档当前层是「缺陷普查 + 修复方向设计」（技术方案层），下一层产物是各修复主题的实施单元（§10）。不设计到函数签名级。

**In-scope**：subagent-core 全仓（execution/ + orchestration/ + engine/）与扩展壳层的同家族缺陷登记、根因归纳、修复方向、验收标准。
**Out-of-scope**：任何代码修改（本文只出方向）；sessions-index 35MB 治理（独立议题）；zsw vendor 侧同步实施；RC-1/2/3 本身的修复细化（已在既有分析中定为方案一+二，本文并入主题 T1）。

## 2. 设计目标

**本章结论：让「一次异常 → 永久挂起」在结构上不可能发生——正常路径不依赖一次性尽力操作，回收路径一律有界。**

1. **登全**：同失败家族缺陷全部在册，每条带可复核证据（file:line）与断点分析，实锤/疑似分级。
2. **修正常路径**：每个 P0 缺陷的修复方向落在「让正常流程不依赖兜底」，而不是加超时把挂死转成降级。
3. **兜底归位**：超时/watchdog 类兜底只允许出现在「回收层」，且默认有界（opt-out 而非 opt-in）。**回收层定义**（全文裁决的边界依据）：处置「执行已不可推进」的全部通道，共四族——① dispose 族（`dispose` / `disposeAllRecords` / `terminateRunningRuns`）；② 上界族（spawn watchdog、keep-alive 默认上限、settled 等待上界、dialog 默认 timeout、通知重投上限）；③ kill 族（`killChildWithEscalation`、`killAllSpawnedChildren`、后代级联 kill）；④ idle timer（`agent_settled` 后的空闲回收）。与之相对，正常路径的判定读取（如 agent_end 现场惰性重试 get_state）是在决策点获取事实，不属于兜底。
4. **可验收**：每个修复主题有真实场景验收标准（非单测非 mock）。

## 3. 现状：一次生产事故的完整解剖

**本章结论：生产事故不是三条 bug 的巧合，而是同一个设计裁决（默认无界 + 一次性承重）在一条调用链上三个环节的连续命中。**

### 3.1 真实事故（2026-08-31，carbon 生产机）

weekly/monthly workflow 的确定性形态：**每轮串行第 1 个调用必成功**（9 秒内 finalized），**随后的并发批次（6 路）全部卡死**——calls 停 `running`、`sessionFile=None` 但 session 实际已创建，直至 rpc-client 5400s 外层超时整批被杀。daily workflow 不死只是因为脚本层有个 600s 守卫把挂死转成降级——而最近 5 次 daily 有 3 次命中该守卫（**60% 触发率 = 正常路径 broken 的信号**，不是「有兜底就够」）。

### 3.2 事故根因链（已实锤，作为全仓普查的锚定案例）

| 环节 | 缺陷 | 证据 |
|---|---|---|
| RC-1 触发 | get_state 握手一次性：3×2s+500ms≈7s 预算耗尽后**永不再试**，RPC 模式它是 sessionFile 唯一来源 | `get-state-handshake.ts:20-23`；`session-runner.ts:1734` |
| RC-2 核心 | agent_end 处置读 `record.sessionFile` 判后代，缺失时 error 与「合法有后代」合并进同一**保守不杀**分支 | `session-runner.ts:1365-1375`；`session-pending.ts:90-92` |
| RC-3 放大 | keep-alive 分支的等待超时是 opt-in：maxTurns/env 双缺省 → **不挂任何 timer**，注释明写「等待后代不限时」 | `session-runner.ts:1380-1401`；`resolveSpawnWatchdogMs` `:229-251` |
| 断点加深 | 5 分钟 idle GC 只在 chatMode 的 `agent_settled` arm——one-shot 路径假设「进程活不到 agent_settled」，被 keep-alive 无限期打破后**无任何回收** | `session-runner.ts:996-1028`；`lifecycle-manager.ts:44-45` |

已排除：RC-4（sessions-index 35MB 同步重写致背压）在当前代码不成立——写侧已是异步 `writeAtomicFile` + 60s 节流（`sessions-index.ts:258`），且秒级停顿本就不能解释无限挂起。

### 3.3 失败模式目录（从 RC-1/2/3 抽象出的普查判据）

> **无界等待家族** = 正常路径依赖一次性尽力操作或单一事件通道，异常路径落入无上界的保守等待，且回收层兜底默认关闭的一类缺陷。RC-1/2/3 就是它在「握手→判定→等待」三环节的三个实例。

| 模式 | 定义 | RC 锚定实例 |
|---|---|---|
| A 一次性尽力操作承重 | best-effort 操作失败即永久缺失，后续关键决策依赖它，无惰性回补 | RC-1 |
| B 保守分支无界 | 「读不出/判不出 → 保守等待」把合法等待与记账失败合并，且无超时上界 | RC-2 |
| C opt-in 兜底默认关 | watchdog/超时/回收 opt-in，默认不限时；一次异常 → 永久挂起 | RC-3 |
| D 单通道等待 | await 只认单一事件（close/单条 IPC 消息），事件丢失即永久悬挂 | runSpawn 只认 close |
| E 假设被打破无回收 | 「进程活不到 X」「Y 必先于 Z」被异常路径打破后无清理 | idle GC 仅 chatMode |
| F 资源/timer 泄漏 | error/early-return 路径漏 clearTimeout/漏删 Map 条目 | — |
| G fire-and-forget 静默 | 失败只 debug 日志或吞掉，故障隐形 | — |

## 4. 普查发现登记（32 条独立缺陷）

**本章结论：32 条独立缺陷中 13 条是一级缺陷（可致永久挂起/进程泄漏/宿主崩溃/通知丢失），全部带 file:line 证据；编排域的 OR-1 是全清单唯一「任何现有机制都不可达」的实例。**

编号规则：LC-=进程生命周期域，PS-=记录/通知/持久化域，OR-=编排域。计数口径：原始普查 34 条发现 → 独立缺陷 **32 条**（T0 13 + T1 6 + T2 13），登记表 33 个编号（LC-6 为跨域并条、LC-10 为占位行），完整推导见附录 B。严重度：**T0**=永久挂起/进程泄漏/宿主崩溃/数据丢失；**T1**=数据不一致/无限重投/状态损坏；**T2**=有界泄漏/竞态窗口/可观测性缺失。

### 4.1 T0：永久挂起 / 进程泄漏 / 宿主崩溃

#### OR-1【实锤】runWorkflow 副作用顺序缺陷：budgetTimeMs fail-fast 在 worker 启动之后 → 孤儿 worker + 永不可达 run

- **证据**：`orchestration/lifecycle.ts:226-240`——`workerHost.start`（:226）先启动 worker，`scheduleTimeBudget`（:228-231）后对 `budgetTimeMs > 2^31-1` fail-fast throw（`shared/timer-delay.ts:37-53`），`deps.runs.set(runId, run)`（:240）永远到不了。用户入口无上界校验（`interface/tool-workflow.ts:90` time 字段 Type.Number 直通）。
- **触发**：`action:"run"` 传 `time > 2147483647`（LLM 对「跑久一点」完全可能生成 `1e12`）。
- **后果**：worker 已开始执行脚本但 run 未注册 → `abortRun` 只能抛 not found，**此 run 永远无法 abort**；脚本内 `agent()` 触达 `run.runtime!`（`error-recovery.ts:504`）为 undefined → TypeError → `worker-host.ts:84` 的 `void handlers.onMessage(raw)` → **unhandledRejection 崩宿主**；模型重试 run → 同一 workflow 双跑。
- **兜底/断点**：无任何兜底——runs Map 没有它，连 session 切换的 `terminateRunningRuns` 都够不到。**全清单唯一「所有回收机制都不可达」的实例**。`:237-239` 注释只防了 worker.start 抛错，没防同一窗口内 scheduleTimeBudget 抛错。

#### OR-2【实锤】rebuildRuntime 中 workerHost.start 抛错无兜底 → 重试矩阵断裂，run 卡 running

- **证据**：`error-recovery.ts:285`（rebuildRuntime 全函数无 try）、`:1017`（scheduleRebuild 末尾裸调 rebuildRuntime 无 catch）、`:856-858`/`:965-967`（两个 await scheduleRebuild 无 catch）。
- **触发**：worker 崩溃触发重试，重建时 `new Worker()` 抛错（线程/内存耗尽、eval 编译失败）。
- **后果**：`workerErrorCount` 已计数但既不重建也不转 done,failed；旧 worker 已死、新 worker 未建，**再无任何事件可达该 run** → run 永久 running；rejection 经 `void` 变 unhandledRejection。
- **兜底/断点**：重试矩阵只给「worker 崩溃」计数，「重建动作本身失败」没有回灌矩阵或收敛为 failed——**恢复机制在它自己的恢复路径上开口**。唯一上界是 session 切换的 terminateRunningRuns。

#### OR-3【实锤】worker 侧 agent()/workflow() 的 pending 零超时 + abort 通道是死代码

- **证据**：`worker-script-builder.ts:292-294`（agent() `new Promise` 只等 `agent-result` 消息）、`:381-384`（workflow() 同构）；唯一优雅解阻是 `:183` 的 `{type:"abort"}` 消息分支——**全仓 grep 证实主线程无任何 sender**（仅测试里有一例），生产死分支。主线程侧多条「不回话」路径（`error-recovery.ts:411-419` 畸形消息仅 log return；`:702-705`/`:757-760` postMessage 双重失败）的注释都声称「让 worker timeout 接管」——**worker 侧不存在任何 timeout**。
- **触发**：畸形 IPC 消息 / postMessage 序列化失败 / runner.run 不 settle（RC 家族）。
- **后果**：`await agent()` 永挂 → worker 不退出 → handleWorkerExit 不触发 → run 永久 running → pollRunToResult（无显式 timeout）永挂。**与生产事故同构，只是挂点在 IPC 消息层**。
- **兜底/断点**：per-call timeoutMs 只作用于 runner 子进程侧、RUN_WATCHDOG 只管 run 轮询——挂点所在的「worker pending Map」这一层自身零兜底，两层兜底都够不到挂点。

#### LC-1【实锤】chatMode 首轮 resolveRun 单通道等待 agent_settled，无独立上界

- **证据**：`session-runner.ts:1353-1360`（agent_end 的 chatMode 分支是纯 `continue`，不 kill 不挂 timer）、`:997-1027`（runSpawn 唯一提前 resolve 点 `state.resolveRun?.(0)` 只在 agent_settled 分支）、`:1470-1510`（waitForChildExit 只认 close/error）。
- **触发**：agent_settled 永不到达——(a) 子进程 pi 版本偏斜无此事件（无能力探测）；(b) pi 的 post-run（compact 检查）卡死；(c) stdout 该行损坏被静默丢弃（`:1436`，见 LC-9）。
- **后果**：resolveRun 永不调用 → runSpawn 永挂 → 池槽泄漏；子进程活着但 idle timer 未 arm（arm 只在 agent_settled）→ 进程+槽位双重泄漏。
- **兜底/断点**：比 RC-2 更脆——连「保守分支」都不存在，事件丢失即无任何补偿路径。兜底只有 opt-in spawn watchdog（与 RC-3 同根）。

#### LC-2【实锤】服务侧三条 kill 路径裸 SIGTERM 无 SIGKILL 升级 + dispose 兜底按 killed 标记跳过

- **证据**：`subagent-service.ts:1320`（closeChatIdle）、`:1374`（closeAfterRoundSettled）、`:2034`（cancelBackground）全是 `if (child && !child.killed) child.kill("SIGTERM")`；SIGKILL 升级**只**存在于 `killChildWithEscalation`（`session-runner.ts:918-936`）；dispose 兜底 `killAllSpawnedChildren` 第 `:382` 行 `if (child.killed) continue`——**killed=「发过 kill 请求」而非「已死」**。
- **触发**：chatMode 子进程卡死在不可中断 native 调用或 SIGTERM handler 挂死（`:905-908` race-F4 注释自认存在），随后走上述三条路径之一。
- **后果**：进程不退 → record 已终态归档 → 幽灵进程；dispose 兜底因 killed=true 直接跳过，**连 SIGKILL 都不发**。两道防线在「SIGTERM 被无视」单点上同时失效。

#### LC-3【实锤】dialog 队列全局死锁无上界；协议 timeout 字段解析后无任何消费者

- **证据**：`dialog-queue.ts:267-283`（processNext `await item.handler`，唯一解阻是 settle/close/shutdown）；`ui-request-queue.ts:182`（`out.timeout = req.timeout` 复制后全链无人读）；`spawn-event-adapter.ts:180-194`（timeout 从协议解析）；dialog-queue/ui-request-handler-factory 中零消费。`ui-request-handler-factory.ts:171-196` 的 `await ui.select/confirm/input` 自身也无超时。
- **触发**：host UI promise 挂死（TUI 销毁/rpc 前端 hang），或用户永不回答而 pi 侧本想用协议 timeout 自解（被父进程丢弃）。
- **后果**：L2 `processing` 恒 true → **所有**子进程的 ask_user 全局死锁；该 child 的 L1 队列 head-of-line 阻塞后续全部 fire-and-forget 通知。
- **兜底/断点**：「兜底字段默认不接线」——与 RC-3 同构的 C 模式实例，且影响面是全局而非单进程。

#### PS-1【实锤】disposeAllRecords（/new、/fork 路径）只关 record 不中止执行，cancel 通道永久失效

- **证据**：`subagent-service.ts:467-499`——disposeAllRecords 仅 tryTransition + completeRecord + archive + worktree cleanup，**无 controller.abort、无 child.kill、无 disarmIdleTimer、无 marker 清理**；对照同文件 `dispose()`（:543-549）有 abortRunningControllers + killAllSpawnedChildren——**同文件内双标**。`cancel(id)`（:805-810）只查 `store.getMutable`，archive 后恒 false。
- **触发**：/new 或 /fork 时存在在途 background subagent。
- **后果**：在途子进程继续跑且无任何用户可及的取消通道；若挂死，唯一上界是 opt-in spawn watchdog（RC-3 同款默认关）→ 泄漏至宿主退出。
- **断点**：把「record 已关」当作「执行已处置」，三个回收面（abort/kill/timer）全漏。

#### PS-2【实锤】/new、/fork 后在途 subagent 完成时向新 session 注入 stale triggerTurn 通知

- **证据**：`subagent-service.ts:2003-2009`（kickOffBackground.then 的 notify 门只排除 `closedReason !== "cancelled"`，parent-new/parent-fork 放行）；`:461-463` [v4 A-6] 注释明言「被关 record 的告知改由 list 的 closedReason 表达」（即决策不主动通知）——但 .then 的 notify 门没有同步收紧。
- **后果**：新对话被「Subagent X failed: closed due to parent-new」的僵尸回执 triggerTurn 唤醒——已废弃会话的通知注入新上下文，与 A-6 决策直接矛盾。

#### PS-3【实锤】deliverMessage 热路径非 EPIPE 写失败：idle timer 已 disarm 且永不 re-arm → 保活进程永久泄漏

- **证据**：`subagent-service.ts:994`（进入 deliverMessage **无条件** disarmIdleTimer）；`:1027-1059`（catch 只对 message 含 `"EPIPE"` 走冷路径 resume，其余错误直接 rethrow——**不 re-arm、不杀进程**）；arm 的唯一时机是 agent_settled，而该进程无轮在跑就永远不会有 settled。
- **触发**：热路径 sendPromptCommand 抛非 EPIPE 错误（如 ERR_STREAM_DESTROYED——错误分类只认 "EPIPE" 子串，过窄）。
- **后果**：进程无人回收（无 timer、无轮、record=running）泄漏至宿主退出；若在无 ledger 的内核通知路径，`hasRunningBackground()` 恒真还会把其他完成通知的合并窗口无限顺延。
- **断点**：disarm 提前于一切可失败操作，失败路径没有恢复「timer armed」这个防泄漏前提（D+B 复合）。

#### PS-4【实锤】idleTimeoutMs 非法值致 armIdleTimer 抛错被降级：轮次完成通知静默丢失 + 进程无回收 timer

- **证据**：`lifecycle-manager.ts:111-113`（delay > 2^31-1 时 assertSafeTimerDelay throw）；`session-runner.ts:999-1015`（agent_settled 的 arm 包 try/catch，失败降级「不挂 idle timer」后**继续执行**）；`lifecycle-predicates.ts:47-65`（isIdle=hasIdleTimer=false → toNotifyRecord 不放行 → 轮次完成通知被吞）。
- **触发**：调用方传 `idleTimeoutMs > 2^31-1`（env 巨值同命中——env 校验只挡 <=0，不挡上界）。
- **后果**：每轮完成通知全部静默丢失（父 agent 永远等不到回复）+ 进程活着却无 timer 永久泄漏 + `.alive` marker 被移除致磁盘态失真。
- **断点**：降级只保住了「不崩进程」，没保住 timer 承载的两个下游不变量（通知放行门 + 进程回收）——fail-fast 在异步回调里被 catch 吞成静默语义变更（G+B 复合）。

#### PS-5【实锤】通知丢失三形态：记账落盘窗口 / shutdown flush 被 isIdle 门吞 / ledger 未绑定 at-most-once

- **证据**：`notify-ledger.ts:8-11`（appendEntry 随 pi flush 管线 debounce 非 fsync，强杀窗口账目丢失，代码自述）；`notify-ledger.ts:266-269`（shutdown flush 的 attemptDeliver 被 isIdle 门**静默放弃**，随后 dispose 销毁 ledger，内存 pending 丢失）；`notifier.ts:329-341`（ledger 未绑定退回内核路径，warn 一条，at-most-once）。
- **触发**：notify 后 pi flush 前崩溃 / session_shutdown 瞬间主 agent 非 idle / jiti 单例分裂致 bind 缺失。
- **后果**：完成/轮次通知永久丢失，父 agent 挂等——对 workflow 场景等价于「槽位占用方已死但父永不感知」。
- **断点**：`subagent-service.ts:556` 注释声称「flush 待发通知后 dispose（防丢失）」，但实际 flush 是一次性尽力且被保守门拦——**注释承诺与行为不符**（A+B 复合）。

#### LC-4【实锤】sessionFile 终局兜底查找被 `if (record.sessionFile)` 守卫挡住——只在不需要它时可达

- **证据**：`session-runner.ts:1762-1773`：

```ts
if (record.sessionFile) {              // ← 守卫条件恰等于它要兜底的缺失本身
  if (!fs.existsSync(record.sessionFile)) {
    const lookupId = state.sessionHeader?.id ?? state.handshakeResult?.sessionId;
    if (lookupId) { const actual = findSessionFileByHeaderId(sessionDir, lookupId); ... }
```

- **触发**：握手 settle 为「sessionId 有、sessionFile 无」（两字段独立采集，`get-state-handshake.ts:84-97`）。
- **后果**：后缀扫描兜底在本可成功的形态下不可达 → finalize marker、alive marker、identity 写入全部失去依据（下游放大见 PS-9）。
- **断点**：RC-1 同家族的第二处独立缺陷——结构修复点是把扫描移出守卫。

#### OR-4【实锤】终态三路径的 eventBus.emit/onRunDone 未围栏 → unhandledRejection + done run 淘汰被跳过

- **证据**：`error-recovery.ts:812-815`/`:869-872`/`:978-981` 裸调 `eventBus?.emit` + `onRunDone`；对比同文件 `:585-594` budget 分支有 M12 try 围栏且注释自述「这些是真实副作用，错误不应被静默吞掉」——**同族收尾不对称设防**。
- **触发**：pi.events 任一 listener 同步抛错，或 onRunDone 内的 evictDoneRunsBeyondCap 抛错。
- **后果**：handleWorkerMessage reject → void → unhandledRejection 崩宿主；通知去重窗口失效（重复通知）+ done run 内存淘汰缺失。

### 4.2 T1：数据不一致 / 无限重投 / 状态损坏

| ID | 缺陷（实锤/疑似） | 证据 | 触发 → 后果 | 断点 |
|---|---|---|---|---|
| PS-6 | watchdog 回执永不匹配时重投无上界【实锤结构/疑似触发】 | `notify-ledger.ts:411-434`（超期条目重置 sentAt 重投）；`:132` attempts 只累加无上限；回执依赖 custom_message entry 的 details.notifyId，而 compaction 对其保留行为未验证（`:34-36` 自述） | 消息送达但回执被 compaction 清除 → 同一条「Subagent X completed」每 120s 重复注入并 triggerTurn，session 存活期内无限循环唤醒 LLM | 只设计了「送达保证」下半场，没设计「确认不可达时止损」上半场（B） |
| PS-7 | .alive marker 无心跳 + 1h 软超时 + 写失败仅 debug → 孤儿误判；running 候选冷查无异进程守卫 → 双写者窗口【守卫缺失实锤/完整双写疑似】 | `alive-store.ts:23,109`（1h 软超时）；marker 只在 spawn 时写一次无刷新；`session-runner.ts:837-848` 写失败仅 debug；`record-store.ts:601-648` 超 1h 落分支 4 → recoverOrphanRecords 写 `.finalized("gc")`；`subagent-service.ts:1154-1155` running 候选不查 findForeignLiveInstance | 子进程活过 1h（MF-4 数小时 keep-alive 是设计内可达态）后任意 session_start 扫描 → 活记录被异进程盖 finalized sidecar；或 running 候选绕过守卫 resume spawn → **两个 pi 子进程写同一 session JSONL**（代码自己最忌惮的形态，`:1564-1573`） | 1h 假设「marker 写后进程短命」被 keep-alive 打破且无刷新机制（E）；foreign 守卫只挂 closed 入口（防御不对称） |
| PS-8 | 子进程自身 session_start 也跑孤儿恢复 → 跨进程互写 sidecar，无任何锁【实锤】 | `subagent-service.ts:419`（initSession 末尾无条件 recoverOrphanRecords）；`:395-410`（子进程 sessionRootId 经 env = 与父同值，过滤域 = 整树共享 sessions 目录）；`record-store.ts:640` 直接 writeFinalized，无跨进程锁无 pid 复核 | 递归编排中任一子进程启动时，恰有兄弟记录 marker 缺失或 >1h（hours-long wave 必然命中）→ 活记录被无关进程盖终态 sidecar，closed entry 写进别的进程的文件 | 恢复机制假设「单扫描者」，env 贯穿让每个子进程都成了扫描者（H） |
| PS-9 | finalize 的 marker/alive 清理全部 gated on record.sessionFile【实锤结构】 | `finalize-record.ts:99-119`（tombstone/finalized sidecar）、`:127-133`（removeAliveMarker） | RC-1/LC-4 致 sessionFile 缺失 → closedReason 持久化与 alive 清理全跳过 → 磁盘重建一律落 crashed、终态原因丢失 | 收尾不再尝试从 sessionDir 反查——一次性前置失败污染全部下游持久化（A 家族下游放大） |
| OR-5 | 持久化全量快照 append 无界放大 + 磁盘保留 opt-in 默认关【实锤】 | `file-run-store.ts:89-90`（每次 save append 全量快照）；`jsonl-run-store.ts:507-515`（每次 flush 向 session JSONL append 完整 entry）；`STATE_MAX_RUNS` 默认关 | 长 run（百级 call）：快照体积随 call 数线性涨 × save 次数同步涨 → 单 run 磁盘 **O(n²)**；loadAll 全文件扫描恢复期放大 | 有界设计全是单条目粒度（trace 8000 字符、errorLogs 500 条），聚合粒度无界；保留兜底 opt-in 与 watchdog 同款默认姿势（C） |
| OR-8 | run done 时仍在飞的 agent call：trace 节点永久 "running" 并持久化【实锤】 | `error-recovery.ts:807`（transition done）；`:543`（迟到 completion 被状态守卫丢弃）；`run-snapshot.ts:149`（"running" 原样落盘）；`discardInFlightCalls`（`:194-204`）只服务 rebuild 路径 | 脚本 fire-and-forget `agent()`（不 await）后 return → 快照/GUI 永久显示 running 步骤，done 快照含 running call 的状态不一致 | 终态转换没有对残留 in-flight 节点的收口动作（E） |

### 4.3 T2：有界泄漏 / 竞态窗口 / 可观测性缺失

| ID | 缺陷 | 证据 | 后果与断点 |
|---|---|---|---|
| LC-5 | armIdleTimer 超时回调无条件 delete，可误删后继新 timer 条目【疑似·竞态】 | `lifecycle-manager.ts:137-140`（回调首行 `idleTimers.delete(recordId)` 无身份比对）；同文件 `session-runner.ts:429-433` removeChildRegistration 有按值守卫先例，此处没有 | 旧 timer 到期与 re-arm 同轮交错 → 删错条目 → 新 timer 脱管、disarm 失效 → turn 中途误杀。窗口极窄，需 fake-timer 验证 |
| LC-6 | session-pending 增量游标无界增长【实锤】 | `session-pending.ts:57`（模块级 Map）、`:148`（entries 永不剪枝）、`:163`（每次判定全量重扫 O(n)） | 长寿命 orchestrator 内存随 pending 行总数无界涨；已删文件 cursor 永久滞留。无 TTL/LRU |
| LC-7 | 安全兜底 env 非法值静默失效【实锤】 | `session-runner.ts:209-215`（spawn watchdog：非数字/<=0 → undefined 不挂，**等价关闭**，零日志）；`lifecycle-manager.ts:58-64`（idle timeout：非法值**回落 DEFAULT_IDLE_TIMEOUT_MS** 而非关闭，但同样零日志） | 运维设 `XYZ_SUBAGENT_SPAWN_WATCHDOG_MS="30m"` 本意加兜底实际静默关掉——「以为有兜底、实际裸奔」（C+G）；idle timeout 侧则是「以为设了极长保活、实际回落 5min」的静默语义漂移 |
| LC-8 | branchCache 无界【实锤·轻微】 | `session-runner.ts:630,689`（模块级 Map 永不淘汰） | worktree 路径每次唯一 → 条目按 path 永久累积。低危 |
| LC-9 | stdout invalid 行静默丢弃 + trailing line 只认 event【实锤】 | `session-runner.ts:1436`（invalid 行忽略，无日志无计数）、`:1448-1456`（processTrailingLine 只处理 event 形态） | 事件行损坏完全不可见——LC-1 触发形态 (c) 无法被排查（G） |
| LC-10 | PS 域 F10 并入 LC-6（同一 Map） | — | — |
| PS-10 | orphanJudged 跨 /new 残留：revive() 不清，IO-error 保守形态永不重判【实锤】 | `record-store.ts:605-606`（判定先 add）、`:623-628`（注释承诺「IO 恢复后重开可重判」）、`:749-752`（revive 不复位）；只有 dispose 清 | 同进程内曾经的 IO 失败记录永久停留 resumable 形态，**与注释承诺不符**（B：保守分支无重新评估时机） |
| PS-11 | closeAfterRound 优雅关闭无 deadline【实锤】 | `subagent-service.ts:1291-1295`（置标志后纯等轮 settle） | 轮挂死（RC 复合态）时 record 永不终态；优雅关闭无时限，只能改 force cancel（B 下游实例） |
| PS-12 | worktree 注册表锁降级 + 对账「多对多保守跳过」每周期永跳【实锤】 | `worktree-registry.ts:157-183`（锁重试耗尽 → 无锁 RMW）；`worktree-manager.ts:451-457`（无法建对应 → 跳过 + warn，无升级无老化） | 未注册 worktree（磁盘 checkout + git 分支）无限期滞留，仅周期性 warn——有界资源泄漏缺终局（B） |
| PS-13 | manifest recoverTmpFiles 循环内无 per-file 容错【实锤】 | `manifest-store.ts:186-218`（单文件 ENOENT 即抛，中断整轮，剩余 tmp 本轮不再处理） | tmp 残留顺延下次启动，自愈但不可见（H-lite+G） |
| PS-14 | sessions-index 写失败仅 debug【实锤】 | `record-store.ts:978-983` | 索引反复写失败（权限/磁盘）无 warn 级线索（G） |
| PS-15 | `RecordStore.dropFileCache` 死代码【实锤】 | `record-store.ts:1181-1187` 无调用方 | 顺手清理，无行为影响 |
| OR-6 | worker `log()` 全局消息被主线程静默丢弃【实锤】 | `worker-script-builder.ts:199-201`（协议注释列入消息清单）vs `error-recovery.ts:357-383`（switch 无 "log" case、无 default 留痕） | 脚本 log 静默丢弃；协议文档与实现漂移零可观测（G） |
| OR-7 | runWorkflow 的 signal abort listener 注册后永不移除【实锤】 | `lifecycle.ts:210-221`（`{once:true}` 只在 abort 时自清）；对比 `launcher.ts:450-454` 同族 L-2 修复只落在嵌套路径 | 长生命周期 signal 连续跑多 run → 每 run 泄漏一个 listener（超 11 个触发 MaxListeners 告警）；同族修复漏配顶层路径（F） |

> 注：agent 普查原始编号与本文登记编号的映射见附录 B；LC-10 为并条占位。

## 5. 根因：三条设计裁决的相互作用

**本章结论：32 条独立缺陷归到一个共同根因——「默认无界」设计哲学：正常路径押注一次性尽力操作，异常路径落入保守等待，而回收层兜底默认关闭。**

把 32 条按模式归并后，根因不是 32 个疏忽，而是三条系统性裁决：

1. **「乐观假设承重」**：sessionFile 回填、agent_settled 到达、marker 写盘、shutdown flush——全是「正常情况下会成功」的一次性操作，但它们被当成后续关键决策的永久前提（模式 A/E）。乐观假设本身没错，错在没有惰性回补：决策点不在现场重新获取，而是消费一个可能永久缺失的前置结果。
2. **「保守 = 不限时」**：读不出/判不出时选择保守（不杀/等待/重试）是对的，但保守分支普遍没有上界，且不区分「合法等待（有活跃后代）」与「记账失败（文件读不出）」两种本质不同的处境（模式 B）。RC-2、LC-3、PS-6、PS-10、PS-11、PS-12 全是这一条的实例。
3. **「兜底 opt-in 默认关」**：所有 watchdog/超时/保留策略都是 opt-in（SPAWN_WATCHDOG/RUN_WATCHDOG/STATE_MAX_RUNS/dialog timeout），默认姿势是「不限时、不回收、不接线」（模式 C）。这个裁决对「长任务不被误杀」是合理的，但它把「一次异常 → 永久挂起」变成了默认行为——而 daily 60% 的守卫触发率证明异常不是小概率。

三条裁决单独看都可辩护，叠加在一条链上就是生产事故的形态：**任一环节的一次性失败，都会沿着「保守分支无界 → 兜底默认关」放大成永久挂起**。修复必须两条同时做——正常路径摘掉对一次性操作的依赖（裁决 1/2），回收层把兜底改成默认有界（裁决 3）；只做前者，wedged 进程仍无回收；只做后者，就是把兜底当正常流程（daily 60% 触发率的现状）。

## 6. 终态：使用者眼里将是什么样的

**本章结论：workflow 跑批后每个 call 要么完成、要么在有界时间内以明确错误失败；子进程不泄漏；通知不丢、不重、不串 session。**

### 6.1 成功路径（weekly 批处理为例）

```
[调度] weekly workflow 启动，6 路并发 agent()
[每个子进程] spawn → 任务完成 → agent_end
  → 若 sessionFile 在（常态）：读后代差集 = 0 → final kill → close → 结果回 worker
  → 若 sessionFile 缺（握手失败）：agent_end 现场惰性重试 get_state（子进程 idle，毫秒级应答）
    → 回填后走正常三分支 → final kill
[worker] 全部 agent() resolve → 脚本继续 → run done
[观测] wf state 0 个 call 停 running；最后一笔 call 完成到 .finalized < 5s；600s 守卫触发 0 次
```

### 6.2 失败路径（带恢复指引）

- **子进程 wedged（连 get_state 都答不出）**：keep-alive 无进展上界（静默 30 分钟，stdout 活动刷新）到期 → 复核存活活跃后代（差集 + pid 探测，与 sweep 同源判据）：有存活后代 → 重挂再等一周期（不误杀合法长等待）；无 → SIGTERM → 30s 未退 SIGKILL → 层主确认死亡后采集后代清单（冻结快照）并迭代展开至叶逐个 escalation kill → 终态原因经错误消息携带 watchdog 标记（closedReason 枚举封闭不扩值），workflow 该 call 以明确错误失败。👉 恢复：错误消息含 sessionId 与 `subagents action:"list"` 指引，可人工复查后重跑该 call。
- **chatMode agent_settled 永不到达（LC-1 形态）**：settled 等待窗口固定硬上限（默认 10 分钟，prompt 发出起算）到期 → SIGTERM→30s 未退 SIGKILL。首轮窗口：runSpawn 以错误返回；续聊轮窗口（runSpawn 已返回）：进程被杀 + 该轮以失败通知用户，chatMode record 回退 running-resumable（可冷路径复活）。终态原因经错误消息携带 'settled watchdog' 标记 + 恢复指引（closedReason 枚举封闭不扩值）。👉 恢复：`subagents action:"list"` 复查后重跑。【已被两段式取代（2026-09-05，见 §7.2③ 与 commit 0364b349e）——本行为普查时点历史描述】
- **dialog（ask_user）30 分钟无响应**：settle 为 cancelled（协议响应为封闭联合、无 error 形态），完整错误消息（等待时长 + 重新发起提问指引）落父进程日志 warn → agent 收到 cancelled 可继续推进或重新发起提问；用户事后回来看日志说明而非无限挂起。需要更长等待的调用方显式传合法正数 timeout 覆盖（非法值两层一致回落默认上界）。
- **budgetTimeMs 非法**：runWorkflow 在**首个副作用前** fail-fast：`time 超过上限 2147483647（约 24.8 天）`。👉 恢复：错误消息给出合法范围，修正参数重试。
- **worker 崩溃且重建失败**：计入重试矩阵，耗尽后 run 收敛 `done,failed`（不卡 running）。👉 恢复：`workflow status <runId>` 可查失败原因，重新 run。
- **notify 确认不可达**：watchdog 重投达上限（如 5 次）后放弃并 warn。👉 恢复：warn 日志指向 `subagents action:"list"` 手动核对后代状态。

## 7. 修复方案对比与关键决策

**本章结论：推荐方案 C（组合）——P0 缺陷逐点修正常路径 + 回收层统一默认有界兜底；纯逐点修补留家族根因，纯结构收敛风险过大。**

### 7.1 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A. 逐点修补：32 条各修各的 | 差——「默认无界」哲学还在，新代码继续犯同族错误（daily 守卫就是先例：修了一个点，家族还在） | 低（每点独立） | 低；但治标 | ❌ |
| B. 结构性收敛：引入统一「有界等待」原语（一切 await/keep-alive 默认带上限 opt-out）+ 统一 kill 升级 + 全链路惰性回补 | 好——by construction 消除家族 | 高（改动面覆盖全部等待点，行为变更广） | 高：默认上界可能误杀合法长任务（wave 开发数小时 keep-alive 是设计内形态，MF-4 教训） | ❌ 单独采用 |
| **C. 组合：正常路径逐点根修（按主题归并成 7 个修复面）+ 只在回收层引入默认有界兜底** | 好——正常路径不依赖兜底（治本），兜底收敛在回收层单点（家族免疫） | 中 | 中：回收层默认值需按最长合法任务标定 | ✅ |

**被否若用**：方案 A 下，本次修完 32 条后第 33 条仍会以同样形态出现（模式目录无人防守）；方案 B 下，§6.1 里数小时的 wave keep-alive 会被默认上界误杀——kill 会连坐 dispose 的 killAllSpawnedChildren 杀全部子进程，L2 重派丢在途工作（MF-4 注释记载的真实事故形态）。

### 7.2 关键决策（八个修复主题）

#### T1【决策】agent_end 决策链摘掉对一次性握手的依赖（覆盖 RC-1/RC-2/LC-4/PS-9）

- **采用**：双管——①agent_end 判定发现 sessionFile 缺失时**现场惰性重试 get_state**（此刻子进程已完成 turn 处于 idle，应答是毫秒级）⛔探针 P-T1；②close 路径的 `findSessionFileByHeaderId` 兜底移出 `if (record.sessionFile)` 守卫（LC-4），finalize 的 marker 清理增加 sessionDir 反查（PS-9）。
- **被否**：加长/加多 spawn 时握手重试——治标，把 7s 改 30s 只是降低触发率，决策点依赖一次性操作的断点还在。
- **证据**：`session-runner.ts:1365`（决策点）、`:1734`（一次性发起）、`:1762-1773`（守卫缺陷）。
- **效果**：§6.1 成功路径的「若 sessionFile 缺」分支成立；RC-1 后果结构性消除。

#### T2【决策】回收层统一默认有界 + kill 时机/方式双收敛（覆盖 RC-3/LC-1/LC-2/LC-3/PS-1/PS-3/PS-11）

- **采用**（八项）：
  - ①keep-alive 分支在 maxTurns/env 双缺省时挂**保守默认上限**（30 分钟，对齐旧 WATCHDOG_FLOOR 量级），显式 opt-out 而非 opt-in；
  - ②①的上限 kill 的是层主进程，处置分两步：层主确认死亡（close）**后**采集其活跃后代清单——此刻层主 sessionFile 冻结为最终快照、pending entries 最完整，避开「kill 前采集」的垂死窗口漏项；随后对清单内每个后代**迭代展开至叶**（递归读各后代的 pending 差集）并逐个 escalation kill。kill 前先做存活校验 + cmdline 含 `pi`/`--mode rpc` 校验（防层主死后窗口内 pid 被操作系统复用而误杀无关进程）。个别后代 pid 反查失败时兜底为 T5 的 marker 机制（如实标注残余窗口：marker 失真时该后代可能被孤儿恢复误终态）——不押注「SIGTERM 会让 pi 自行级联杀后代」这一未验证断言，⛔探针 P-T2b 实测 pi 级联行为（证实则后代补杀退化为 no-op 一致性校验，证否则补杀即主路径，设计不变）；
  - ③chatMode **任意一轮**等待 `agent_settled` 的窗口挂**固定硬上限**（默认 10 分钟，标定依据见探针 P-T2c；settled 到达、close 即清）。覆盖两个位置：runSpawn 首轮等待窗口（resolve 前，含 resolveRun）与后续轮次热路径（deliverMessage 发出新一轮 prompt 后同挂）——后者现状是「settled 不 arm 则 idle timer 不挂、runSpawn 已在首轮返回、spawn watchdog 默认关」的三无窗口，LC-1 的同族变体，单修首轮护不住。不采用事件刷新语义——该窗口的正常语义是 post-run 收尾（compact 检查等，秒级完成），窗口内的任何输出都不能证明 settled 终将到达，「刷新」反而会让「wedged 但仍有周期性输出」的进程无限续命（LC-9 已证 stdout 可有调试行）；固定上界 by construction 覆盖静默与非静默两种 wedged 形态。多轮会话中每轮窗口独立计时；**两个挂载位置共用同一原语——同一常量、同一挂载/清除 helper，仅两个调用点**（两处各写一套恰是本主题被否的「散布姿势」微缩复发）。与 idle timer 互补：idle timer 管 settled 已到达后的空闲，本上界管 settled 永不到达的 wedged——LC-1 的挂点（连保守分支都没有）由此获得独立回收通道。**【本项旧机制已否并修复，2026-09-05】**「全程固定 10min 窗（prompt 发出起算）」的标定被 2026-09-04 全项目超时普查击穿——P-T2c 探针实测的是 agent_end→settled 收尾段（<2ms），窗口实际罩 prompt→settled 整轮执行，>10min 合法 chatMode 单轮被误杀（普查 ❌4，标定测错对象）；已由两段式重锚定替代（commit 0364b349e，settled-watchdog.ts）：中段 prompt→agent_end 无进展检测（30min，有效协议事件行刷新）+ 收尾段 agent_end→agent_settled 固定硬上限 600s + env `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS`（>0 覆盖收尾段 / ≤0 关闭两段 / 非法回落默认），设计依据 [timeout-zcode-turn-and-settled-watchdog.md](timeout-zcode-turn-and-settled-watchdog.md) §6-D9，边界句已同步改写为两段式语义（§7.3 P-T2c 行保留探针历史结论，其下方 ⚠️ 块为清账锚点）；
  - ④服务侧三条裸 SIGTERM（`subagent-service.ts:1320/1374/2034`）收敛到 escalation kill（实施为 recordId 形态导出 `killRecordChildWithEscalation`——原 `killChildWithEscalation` 签名持 SpawnRunState，服务侧调用方无该状态，语义等价）；
  - ⑤`killAllSpawnedChildren` 的 `child.killed` 跳过改为「killed 且已 close 才跳过」（或对 killed 进程补 escalation 检查）；
  - ⑥disposeAllRecords（/new、/fork 路径）补齐三回收面：controller.abort + kill（同④收敛到 killChildWithEscalation）+ disarmIdleTimer——PS-1 是 kill **时机**遗漏（「record 已关」≠「执行已处置」），④⑤ 只收敛 kill 方式，覆盖不了它；
  - ⑦dialog 队列接线协议已有的 timeout 字段；请求方**未传** timeout 的 dialog 同样挂默认上界（30 分钟），到点 settle 为 cancelled（协议响应为封闭联合、无 error 形态），完整错误消息（等待时长 + 「重新发起提问」恢复指引）落父进程日志 warn——LC-3 的两种形态（host UI 通道挂死 / 用户永不回答）都收敛有界。30 分钟是**裁决值**（产品语义：ask_user 挂起 30 分钟无响应视为放弃），不随 P-T2（keep-alive 分布，等后代）标定——那是无关总体；请求方需要更长等待时显式传合法正数 timeout 覆盖（非法值两层一致回落默认上界）。「等用户无限久」改为默认有界是有意的行为变更；
  - ⑧deliverMessage 非 EPIPE 失败路径 re-arm idle timer 或转 cold close（PS-3）。
- **被否**：给每个等待点各自加 env 开关——继续 C 模式的散布姿势，第 33 条还会犯。
- **证据**：`session-runner.ts:1380-1401`（不限时注释）、`:1353-1360`（chatMode agent_end 纯 continue）、`:997-1027`（idle timer 仅 settled arm）、`dialog-queue.ts:267-283`（无上界 await）、`ui-request-queue.ts:182`（timeout 解析后无人消费）、`subagent-service.ts:467-499` vs `:543-549`（dispose 双标对照）。
- **效果**：§6.2 的 wedged 回收路径成立（含后代级联）；S-B/S-C 验收判据的来源 timer 全部就位（S-B←③、S-C←⑥）；兜底触发率预期趋近零（正常路径已被 T1 修好）。
- **边界**：这是全方案中唯一「默认开启的上界」，默认值按最长合法任务标定——wave keep-alive 数小时是合法形态，故 keep-alive 默认上界只挂在「无 maxTurns 无 env」的裸缺省情形（显式 maxTurns<=0 与 env 设置均为合法 opt-out，不挂任何 timer；⛔探针 P-T2 实测分布否定了固定 30min——96.6% 历史窗口超限，已按其降级路径 B 落地为**无进展检测**：静默阈值 30min，层主 stdout 活动刷新计时，到期时先复核存活活跃后代——有则重挂再等一周期，无则处置，详见 §7.3 P-T2 行）；③为两段式（2026-09-05 重锚定取代本边界句原记述的单段全程固定 10min——旧「窗口从 prompt 发出起算、>10min 单轮被回收」口径的标定错误见 ③ 项内被否谱系与 §7.3 P-T2c 行 ⚠️ 块）：**中段（prompt→agent_end）无进展检测**，连续静默 30min 判 wedged kill，stdout pump 解析出的有效协议事件行刷新计时（invalid 行不刷新，防调试噪音续命）——>10min 合法 chatMode 单轮不再被误杀（工作段输出即进展），残余误杀面为轮内单次 >30min 无 stdout 事件的长工具执行（标定挂 timeout-zcode 设计 ⛔P-Z1）；**收尾段（agent_end→agent_settled）固定硬上限 600s**，事件不刷新（收尾段内输出不能证明 settled 将到达——原头注释固定上界论证归位到本段），P-T2c 定值依据归位到真收尾段（间隔 <2ms、compact 30 万 tokens 40.1s，P99×10=401s<600s）；两段独立计时（agent_end 交棒不继承中段已过时间）。配置通道：env `XYZ_SUBAGENT_SETTLED_WATCHDOG_MS`（>0 覆盖收尾段定值、≤0 关闭两段并 warn 后果、未设/非法回落默认 600s）；落地 commit 0364b349e，设计依据 [timeout-zcode-turn-and-settled-watchdog.md](timeout-zcode-turn-and-settled-watchdog.md) §6-D9。

#### T3【决策】workflow run/worker 生命周期闭合（覆盖 OR-1/OR-2/OR-3/OR-4/OR-7/OR-8）

- **采用**：①runWorkflow 的 `scheduleTimeBudget` 移到 `workerHost.start` **之前**（fail-fast 在首个副作用前，OR-1）；②rebuildRuntime 的 start 抛错回灌重试矩阵、耗尽收敛 `done,failed`（OR-2）；③worker pending Map 接线 per-call timeoutMs（消息层自己的超时，不再只押 runner 侧）+ 接通 `{type:"abort"}` 广播（abortRun/terminate 时优雅拒绝全部 pending，OR-3）；④终态三路径的 emit/onRunDone 补 M12 同款围栏（OR-4）；⑤run done 时 calls Map 残留 in-flight 节点收口为 cancelled（OR-8）；⑥abort listener 在 run 终态移除（OR-7，对齐嵌套路径 L-2 修复）。
- **证据**：`lifecycle.ts:226-240`（顺序缺陷）；`error-recovery.ts:285`/`:1017`（无兜底）；`worker-script-builder.ts:183`（死通道）。
- **效果**：§6.2 的 budgetTimeMs 与 worker 重建失败路径成立。

#### T4【决策】通知可靠性：止损上界 + 门语义修复（覆盖 PS-2/PS-4/PS-5/PS-6）

- **采用**：①notify 门按 closedReason 白名单放行（parent-new/parent-fork 不注入新 session，落实 A-6 决策，PS-2）；②PS-4 分两手：idleTimeoutMs 非法值（>2^31-1）在 spawn 入口**同步校验 fail-fast**（错误含合法范围）——对齐 `timer-delay.ts:10-13`「不静默 clamp」既有裁决，配置错误显式暴露而非静默替换语义；armIdleTimer 异步回调内的 catch 降级改为「挂 DEFAULT_IDLE_TIMEOUT_MS 并 **warn 留痕**」而非「不挂」（此处非配置替换，属防御性兜底，保住通知放行门与进程回收两个不变量且可见）；③notify-ledger 重投加 attempts 上限 + 放弃语义（PS-6）；④shutdown flush 被 isIdle 门拦时落盘 pending 供重启 replay（修复 `subagent-service.ts:556` 注释承诺与行为的差距，PS-5）。
- **被否**：「重投无限但幂等」现状——幂等只防重复入账，不防重复**投递**唤醒 LLM。
- **证据**：`subagent-service.ts:2003-2009`；`notify-ledger.ts:132,411-434`。
- **效果**：通知不丢（PS-5）、不重（PS-6）、不串 session（PS-2）。

#### T5【决策】多进程共享文件：孤儿恢复收窄到主进程 + marker 心跳（覆盖 PS-7/PS-8/PS-13）

- **采用**：①子进程 initSession 跳过 recoverOrphanRecords（实施判据：`PI_SUBAGENT_SELF_RECORD_ID` env 存在性——仅被父 spawn 的子进程持有，与「只有根进程做扫描者」语义等价）；②alive marker 增加心跳刷新（keep-alive 期间每次 agent_end 重触）或软超时与 maxTurnsToWatchdogMs 对齐（PS-7a，⛔探针 P-T5 实测心跳主路径）；③running 候选冷查补 findForeignLiveInstance 探针（PS-7b）；④recoverTmpFiles 循环内 per-file try（PS-13）。
- **被否**：跨进程文件锁——引入锁等于新的运行时断言面（准则 8：减法优先），「只有根进程扫描」by construction 消除互写。
- **证据**：`subagent-service.ts:395-419`（env 贯穿使子进程成扫描者）；`alive-store.ts:23`（1h 无刷新）。
- **效果**：双写者窗口与活记录误终态消除。
- **边界**：心跳刷新涉及「子进程每次 agent_end 多一次写盘」⛔探针 P-T5 验证写盘频率可接受；若不可接受，降级为软超时对齐估算值（无新写盘）。

#### T6【决策】有界化与竞态收口（覆盖 LC-5/LC-6/LC-8/PS-10/PS-12/OR-5）

- **采用**：①armIdleTimer 回调加身份比对（对齐 removeChildRegistration 按值守卫先例，LC-5）；②session-pending cursors 按「文件删除/进程 close」剪枝 + entries 只留 register/unregister 差集（保留活跃 entry 本体供端口差集计数消费，上界随活跃后代数，LC-6）；③branchCache 加 LRU 上限（LC-8）；④orphanJudged 在 revive() 复位（落实 `record-store.ts:623-628` 注释承诺，PS-10）；⑤worktree 对账「保守跳过」加老化处置（连续 N 周期无对应 → 升级 warn 级并给人工清理指引，PS-12）；⑥OR-5 的两个**正交**子缺陷各配各的修法，不可互替：**单 run 快照 O(n²)**（每次 append 全量）主修 60s 节流（FileRunStore 与生产面 JsonlRunStore 两实现面一致，终态强制落盘；实施期先验证节流是否已足够，见 §11-4）；**跨 run 保留无界**（STATE_MAX_RUNS 默认关）给默认值 50（数值待 §11 统计标定复核）。
- **证据**：各条目 file:line 见 §4.2/§4.3。
- **效果**：长寿命进程内存有界；保守分支都有重新评估时机。

#### T7【决策】可观测性补齐（覆盖 LC-7/LC-9/PS-14/PS-15/OR-6）

- **采用**：①env 非法值 warn 级留痕（「以为有兜底、实际裸奔」必须可见，LC-7）；②stdout invalid 行计数 + debug 留痕（LC-9）；③sessions-index 写失败升 warn（PS-14）；④worker 消息 switch 加 default 留痕 + `log()` 消息接入 workerLogs 通道（OR-6）；⑤删 dropFileCache 死代码（PS-15）。
- **效果**：本家族下一实例出现时，日志层面可直接定位，不再依赖 5400s 超时后的间接证据。

#### T8【决策】agent_end「读不出」处置翻转：无限保守等待 → 15s 回补重试窗口（2026-09-10 登记）

> **[架构分叉后勘误 2026-09-10]** 本条是**线 B 历史决策**：本次重放移植判定 D3「问题域结构性消失」（新架构 agent_end 无条件 kill），**15s 回补窗口不移植**；下述 `descendantCapable` / `runAgentEndDisposition` / `locateSessionFileByScan` 均为已删的 engines/pi 实现。当前树落点见头部「修订记录」节与 [subagent-agent-end-recovery-replay.md](subagent-agent-end-recovery-replay.md)。

- **来源**：[subagent-agent-end-recovery.md](subagent-agent-end-recovery.md) D3——本文 T1-T7 之后的后续设计。其 §0 与本文的关系声明：T1 交付惰性回补基础设施（8.8.0），该设计在其上补齐失败路径（D1 迟到接受 + D2 扫描兜底，见 P-T1 行更新）并新增本文未建模的处置翻转架构决策。
- **采用**：`descendantCapable === true` 且 sessionFile 读不出（error）时不再进入无限 keep-alive（RC-2 的保守分支，本清单裁决 2 的头号实例），改为 **15s 回补重试窗口**：每 5s 一轮交替「get_state 单查 / sessionDir 扫描」（轮 3 纯判定轮），任一路径拿到真实 sessionFile 即以真实路径重走三分支；窗口内 tick 重判仍 error 则续窗不清已排定轮次（保证单次 arm 的耗尽点确定 = arm + 15s）；多轮 agent_end 重入 error 分支按幂等 arm 语义 disarm 旧窗口 + 重挂重计（重置仅由真实新事件触发，活动停止后窗口必然耗尽，不构成退化回无限等待）；窗口耗尽仍读不出 → kill（SIGTERM→30s→SIGKILL 升级链）→ runSpawn 以成功语义返回，结果内容来自 stdout 事件累积，不依赖 sessionFile。「读不出」触发率由两路配套打到近零：D1 迟到接受（握手 resolve 后迟到应答幂等回填，消除「永久缺失」）+ D2 扫描兜底（P-T1 行已登记落地）。`count > 0`（证实有后代）分支与 keep-alive 全部原样保留（G2 不回归——翻转只动「读不出」，不动「证实有」）；无后代能力 agent（tools 白名单非空且不含派生/记账工具，[Gate B P3 勘误后真实注册名] subagent/workflow/workflow-script/bash）走零判定快路径。
- **收口**：§5 裁决 2「保守 = 不限时」——保守不杀是对的，但「合法等待（有活跃后代）」与「记账失败（文件读不出）」必须分家：前者保留现有等待，后者给 15s 秒级上界。裁决 2 的实例清单（RC-2/LC-3/PS-6/PS-10/PS-11/PS-12）中 RC-2（含 LC-4/PS-9 放大链的入口）由本决策直接收口，并把「记账失败终有一杀」的量级从 30min no-progress 兜底的错误量级中解放（该兜底保留为「证实有后代但后代集体挂死」场景的最后防线，与本决策正交）。
- **被否**：①维持无限保守等（翻转前现状）——§5 裁决 2 已论证；②读不出立即杀（零宽限）——极端慢盘/高负载下扫描合理需要多轮，零宽限推高误杀率，15s 是「误杀代价 ≈ 0 且总收敛有界」的平衡点；③窗口耗尽置 sweepDescendantsOnClose——结构性空转：sweep 入口 `sweepDescendantsOfSession` 首行 `if (!rootSessionFile) return`，窗口耗尽 = sessionFile 恒 undefined，置位是无效安慰剂；后代清理不靠 sweep（[Gate B S5/P5 实测勘误 2026-09-10] 层主被 kill 时后代连带终止——SIGTERM 形态由层主 shutdown 链收殓、SIGKILL 形态后代死于 stdout EPIPE；原「SIGTERM 不级联」依据 P-T2b 裸形态探针，与层主持有 SubagentService 活跃记录的实际形态不符，详见设计文档 D3b 勘误）。
- **证据**：`session-runner.ts`（`runAgentEndDisposition` / `evaluateDispositionBranches` / `armDispositionRetryWindow` / `exhaustDispositionRetryWindow`）；`session-file-locator.ts`（`locateSessionFileByScan`）；`get-state-handshake.ts`（迟到接受）。
- **效果**：记账失败最坏等待从 30min / 无限收敛到 15s + 入口惰性回补段 1s（绝对上界 16s）。误杀形态（三路获取全失败 ∧ 真有后代）为显式残余风险——代价有界、行为可见（日志链完整）、**[Gate B S5 勘误] 误杀为连带终局：后代任务中断、未产出成果丢失（已产出部分可经 session-reader 查出），非原声明的「成果不丢」**；外部回收通道（kill/abort/dispose/外层墙钟）对残余 keep-alive 有效；四要素代价分析（含勘误）、重审触发条件（生产出现「15s 窗口耗尽」日志即触发）见设计文档 D3b 误杀代价分析与 S5。
- **排查入口**：特征串词条见 [../troubleshooting.md](../troubleshooting.md) §12（迟到回填 / 扫描兜底 / 窗口耗尽三特征串判读）。

### 7.3 运行时断言与探针清单

| ID | 验证的行为断言 | 探针 | 状态 | 失败时降级路径 |
|---|---|---|---|---|
| P-T1 | agent_end 时子进程（已完成 turn、idle）对 get_state 毫秒级应答 | 受控复现：并发 6 路 spawn + 人为抑制首次握手，断言惰性重试 < 1s 返回 sessionFile | **已执行 PASS**：6 路 0.3-0.4ms（预算 1s，2500 倍余量），T1 惰性回补主路径成立 | **扫描兜底已落地（2026-09-10，本行原备注「sessionDir 后缀扫描未启用，保留为 LC-4/PS-9 修复面」就此关闭）**：locateSessionFileByScan（`session-file-locator.ts`，identity 精确匹配 + mtime 降序 + 整文件前向读）接入两点——agent_end 决策回补链（含 15s 重试窗口轮 2）与 close 收尾反查链 lookupId 缺失分支，LC-4/PS-9 修复面闭合；翻转决策见 §7.2 T8，设计依据 [subagent-agent-end-recovery.md](subagent-agent-end-recovery.md) D2。**[架构分叉后勘误 2026-09-10]** 本单元格描述的是线 B（engines/pi 已删）落地形态；当前树口径（M4 仅 close 单点 + prompt 头部键 / agent_end 侧由 M2 惰性 get_state 回补承担）见头部「修订记录」节与 replay 设计 |
| P-T2 | 30min keep-alive 固定默认上限不误杀真实 wave 场景（数小时 keep-alive 合法） | 真实数据回溯：扫历史 subagent session/record 中 keep-alive 窗口分布（89 个有效 closed 样本） | **已执行**：96.6% 样本 >30min（P50=24.5min/P95=71.6min/max≈95.5h）→ 固定 30min 被否定，**按降级路径 B 落地**：无进展检测（静默阈值 30min + stdout 活动刷新 + 到期复核存活活跃后代，有则重挂再等一周期，无则处置）——「直接后代长跑、层主静默」形态由复核节奏覆盖，不误杀 | 降级 A（P95×2 固定上限）保留为后备；复核判据与 sweep 同源（差集 + pid 探测），探不出 pid 的形态与 sweep 同盲区、归 T5 marker 兜底 |
| P-T2b | pi 子进程收 SIGTERM 后是否自行级联 kill 其活跃后代（session_shutdown → killAllSpawnedChildren 链是否存在） | 本地起嵌套 subagent（父 keep-alive 且有活跃后代），向父进程发 SIGTERM，观察后代进程存活与终态 | **已执行**：后台孤儿后代形态三跑稳定 NO-CASCADE（仅 bash 前台窗口 CASCADE） | 裁决：后代补杀为主路径（设计已按此形态，无方案变更） |
| P-T2c | chatMode post-run（agent_end → agent_settled）真实时长分布——T2-③ 的 10min 默认硬上限标定依据 | 真实 pi 会话多轮对话（3 短 + 60KB/120KB/400KB），统计每轮 agent_end→settled 间隔；附显式 compact 30 万 tokens 实验 | **已执行**：6 轮间隔全部 <2ms（同 chunk）；compact 40.1s | 10min 硬上限维持（4 个数量级余量） |

> **⚠️ 2026-09-04 普查标定实锤（被否谱系登记，已清账 2026-09-05）**：本决策的窗口标定被全项目超时普查击穿——P-T2c 探针测的是 agent_end→settled 收尾段（<2ms），窗口实际罩 prompt→settled 整轮执行，「余量」建立在错误被测对象上；>10min 合法 chatMode 单轮被误杀登记为普查 ❌4。修复设计见 [timeout-zcode-turn-and-settled-watchdog.md](timeout-zcode-turn-and-settled-watchdog.md) D9（两段式重锚定 + env 通道，含本决策的被否谱系与 U7 回写义务）——已按 C-proc-10 清账：代码修复 commit 0364b349e（settled-watchdog 两段式 + 双挂载点），本节改写（T2-③ 被否谱系 + 边界句两段式语义）与 impl-plan §5「T2③ 窗口起算口径裁决」行清账已完成。
| P-SD | S-D 子场景②的注入手段可行：测试钩子 env（`XYZ_SUBAGENT_TEST_INJECT_REBUILD_FAILURE=1`）使 rebuildRuntime 第 N 次抛错，配合脚本内 `process.exit` 制造 worker 崩溃。**安全约束**：钩子仅显式设置时激活、激活即在启动日志 warn 留痕（对齐 T7① 可见性原则），杜绝静默生效 | 真实 pi 环境 + 注入 env 跑一个先崩后重建的 workflow | ⛔ S-D 验收前 | 失败 → 该子场景降级为集成级验证，验收记录如实标注缺口（ulimit 方案已否：user 级限制同时约束主进程/子进程/首个 worker，无法精确制造「首轮成功、重建失败」时序） |
| P-T3 | 主线程 → worker 的 `{type:"abort"}` 广播在 terminate 竞态下不产 unhandledRejection | fake-worker 测试：abort 广播与 worker 自然退出交错 | ⛔ T3 实施期 | 失败 → 退化为 terminate 杀线程（现状），pending 条目随 worker 死亡清理 |
| P-T5 | marker 心跳（每次 agent_end 写盘）在真实分布下写盘开销可接受 | 历史回溯 4747 个 subagent session 的 agent_end 密度（P95≈10 次/分钟上界）+ 单次 56 字节覆盖写基准 | **已执行**：0.0315ms/次，开销可忽略 4 个数量级 | 心跳主路径落地；软超时降级未启用 |
| P-RC1 | RC-1 触发条件实锤：并发 6 路 spawn 时 pi 子进程 7s 内答不出 get_state 的原因（机器负载 vs 协议缺陷） | 受控并发复现 + 子进程侧日志时间戳对比 | ⛔ 修复验收时 | 无论结论如何 T1 方案都成立（惰性回补不依赖触发条件成立），仅影响是否需要额外的 spawn 限速 |

## 8. 验收（真实场景，非单测非 mock）

**本章结论：用 6 个真实场景（S-A~S-F）验证——核心判据是「兜底触发率归零」（正常路径修好）与「挂死有界」（回收层兜底就位）。**

### 8.1 改动规模

大改动（多模块行为变更 + 默认语义调整），按多场景真实验收投入。

### 8.2 验收场景

| 场景 | 回溯 §2 目标 | 真实流程（具体业务例子） | 通过标准 |
|---|---|---|---|
| S-A 生产复跑 | 目标 2（修正常路径） | carbon 上真实跑 weekly + monthly 各一轮（真实 LLM、真实 6 路并发、真实数据）。**观测预检**：正式验收前先注入一个挂死 call 手动触发一次 600s 守卫，确认其降级痕迹实际落在哪（errorLogs / call 终态 / 守卫自身日志）——「守卫必落 call 级记录」未经验证，以预检确认的位置为准。**观测点**：call 清单与终态从 `workflow status <runId>` 及 run store 持久化文件读取（file-run-store 快照 + session JSONL append） | wf state 0 个 call 停 `running`；最后一笔 call 完成到 run `.finalized` < 5s（时间戳取 run store 持久化条目）；**守卫降级条目计数 = 0**（按预检确认的位置计数）；全程无 rpc-client 5400s 外层超时 |
| S-B 故障注入挂死有界 | 目标 3（兜底归位） | 真实 pi 环境跑一个 chatMode subagent。**注入方式**：spawn 命令包一层 stdout 过滤 wrapper（`node filter.js -- pi --mode rpc`，filter.js 丢弃 `agent_settled` 事件行、其余透传）——子进程与其余链路全真实，仅事件行被滤。**两个子场景**：①首轮窗口（spawn 后即滤）；②热路径窗口（先正常跑完一轮使 wrapper 透传 settled、续聊第二轮起再滤）——覆盖 T2③ 的两个挂载点。观察 settled 等待硬上限的回收 | 默认上限内进程被 SIGTERM→SIGKILL 回收，错误消息携带 'settled watchdog' 标记与恢复指引（closedReason 枚举封闭不扩值）；子场景①runSpawn 以错误返回，子场景②该轮以失败通知用户且 record 回退 resumable；错误消息均含恢复指引 |
| S-C /new 在途处置 | 目标 2/3 | pi CLI 真实会话：起 2 个 background subagent，执行中 /new | 旧 session 子进程被 abort+kill（非仅 record 关闭）；新 session **不收到**「closed due to parent-new」的 triggerTurn 注入；`ps` 无孤儿 pi 进程 |
| S-D workflow 故障注入 | 目标 3 | 真实 run 两个子场景：①`time: 1e12`（非法预算）；②「worker 崩溃后重建失败」用测试钩子注入（`XYZ_SUBAGENT_TEST_INJECT_REBUILD_FAILURE=1` 使 rebuildRuntime 抛错；worker 崩溃用脚本内 `process.exit` 制造；钩子安全约束见 P-SD——仅显式设置激活 + 激活 warn 留痕），注入可行性先经探针 P-SD 验证——ulimit 方案已否（见 P-SD 行） | 前者在 worker 启动前 fail-fast 且错误含合法范围；后者 run 收敛 done,failed 而非卡 running（`workflow status` 可查失败原因）；宿主进程全程不崩（无 unhandledRejection） |
| S-E 通知止损 | 目标 2 | 真实双 agent 场景：让回执 entry 不可匹配（模拟 compaction 清除），观察 watchdog 重投 | 重投达上限后放弃 + warn 日志（extension 日志 `~/.pi/agent/logs/` 可查，`XYZ_AGENT_DEBUG=1`）；同一条完成通知不无限重复注入（修复前是每 120s 一次无限循环） |
| S-F 非法配置与 shutdown 竞态（T4） | 目标 2 | 真实 pi 会话两个子场景：①以非法 `idleTimeoutMs`（> 2^31-1）spawn 一个 background subagent，观察入口处置；②在主 agent 非 idle 瞬间触发 session_shutdown（起一个长任务占住主 agent 后关闭会话），重启观察 pending 通知 | ①spawn 被入口 fail-fast 拒绝且错误含合法范围（无静默降级、无静默不挂 timer）；②重启后完成通知送达（shutdown flush 被门拦时落盘的 pending 经 replay 补投，不丢） |

> 单测/集成测试照常作为回归辅助（现有 2805 测试套件必须保持绿），但不计入验收——验收只认上述真实场景。
> 明示的验证缺口：OR-3 的 pending timeout 半边（worker pending Map 接线 per-call timeoutMs）无独立真实场景——「真实 run 中让主线程对某 agent-call 永不回话」的注入手段成本高于收益，该半边以集成测试（fake-timer 交错）+ P-T3 探针（abort 半边）覆盖，如实标注不冒充真实场景验收。

## 9. 实施

**本章结论：按「先止血可达性最差的、再修正常路径、最后收口」三阶段交付。**

| 阶段 | 内容 | 交付终态的什么 |
|---|---|---|
| M0 | T3 的 OR-1 顺序修复（scheduleTimeBudget 前移）——一行级改动消除唯一「所有机制不可达」实例；T7 全量（纯可观测性，零行为风险，让后续修复可被观测） | §6.2 budgetTimeMs 失败路径；排障可见性 |
| M1 | T1（agent_end 惰性回补）+ T2（回收层默认有界 + kill 时机/方式双收敛）——RC 家族根修 | §6.1 成功路径；验收 S-A/S-B |
| M2 | T3 剩余（worker 生命周期）+ T4（通知） | 验收 S-C/S-D/S-E |
| M3 | T5（多进程）+ T6（有界化） | 长跑稳定性 |

**依赖说明**：M1 是生产事故的根修，优先级最高，但 M0 先行是因为 OR-1 是一行级修复且当前无任何机制可达；T2 的两个默认上限值分别依赖 P-T2（keep-alive 30min）与 P-T2c（settled 窗口 10min）探针结果，探针不过则按各自降级路径调整，不阻塞其余主题。

## 10. 下一层拆分

**本章结论：7 个修复主题即 7 个实施单元，单元间依赖仅 T2 依赖 P-T2/P-T2c 探针。**

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| U-T1 | agent_end 惰性回补 + LC-4 守卫修复 + PS-9 反查 | 同一决策点（agent_end/finalize）的同一依赖（sessionFile），一次改动闭合 |
| U-T2 | 回收层默认有界（keep-alive/settled/dialog 三上界）+ kill 方式收敛 + kill 时机补齐（disposeAllRecords 三回收面）+ 后代级联 + deliverMessage re-arm | 全是 §2「回收层定义」四族通道的同一语义层，需统一标定默认值，拆开会留下口径不一的上界 |
| U-T3 | run/worker 生命周期六条 | 同文件群（lifecycle.ts/error-recovery.ts/worker-script-builder.ts）且共享「worker pending」心智模型 |
| U-T4 | 通知可靠性四条 | 同子系统（notifier/notify-ledger/subagent-service 通知门），门语义需一致设计 |
| U-T5 | 多进程共享文件四条 | 共用「谁是扫描者」裁决，必须一起改否则互相矛盾 |
| U-T6 | 有界化与竞态六条 | 独立小修集合，彼此无依赖，可并行或随手带 |
| U-T7 | 可观测性五条 | 零行为风险，先行落地让 M1-M3 的验收有据可查 |

**文件改动地图**（按单元汇总）：`session-runner.ts`（U-T1/T2/T6/T7）、`get-state-handshake.ts`（U-T1）、`subagent-service.ts`（U-T2/T4/T5）、`lifecycle-manager.ts`（U-T2/T6）、`dialog-queue.ts` + `ui-request-queue.ts` + `ui-request-handler-factory.ts`（U-T2）、`lifecycle.ts`（U-T3）、`error-recovery.ts`（U-T3）、`worker-script-builder.ts`（U-T3/T7）、`notify-ledger.ts` + `notifier.ts`（U-T4）、`record-store.ts` + `alive-store.ts` + `manifest-store.ts`（U-T5/T6/T7）、`worktree-manager.ts`（U-T6）、`session-pending.ts`（U-T6）、`interface/tool-workflow.ts`（U-T3 入口校验）。

## 11. 待验证检查点

设计阶段无法确定、留给实施期验证的点（诚实标注，不编）：

1. **RC-1 触发条件实锤**（探针 P-RC1）：并发握手失败是机器负载还是协议缺陷——不影响 T1 方案成立，但影响是否需要 spawn 限速。**执行载体（2026-09-10 登记）**：[subagent-agent-end-recovery.md](subagent-agent-end-recovery.md) S1 场景（6 路并发冷启动压力 + wrapper 注入）兼作本探针执行载体（该设计 §1 已声明），随其 Gate B 真实场景验收一并执行。
2. **LC-5 竞态窗口**：armIdleTimer 误删需 fake-timer 精确交错验证后才定修复（若窗口证伪则降级为防御性身份比对，成本一行）。
3. **PS-6 触发前提**：compaction 对 custom_message entry 的保留行为未验证（`notify-ledger.ts:34-36` 自述）——重投上限照加，但若 compaction 实际保留回执，则该缺陷触发率可能为零。
4. **OR-5 默认值**：STATE_MAX_RUNS 若给默认值，具体数值需统计真实 run 体积分布后标定。
5. **PS-9 同源性问题**：marker 缺失是否本就与 sessionFile 缺失同生同灭（若同源，反查增益有限，优先级降）。
6. **zsw vendor 同步面**：core 修复后需同步 zcode-plugin-workspace 的 vendor 副本（跨仓段，随 core 0.4.0 发版节奏）。

## 附录 A：已排除项（普查中核实不成立的候选，防误报沉淀）

- session-pending 游标 offset 疑似 off-by-one：手工推演确认无害（不丢行不延迟）。
- chatMode 首轮后 abort listener 移除：`cancelBackground`/closeChatIdle/closeAfterRoundSettled 已显式补偿，兜底闭合。
- waitForChildExit 与 resolveRun 装配时序：spawn→pump→handshake→wait 全程同步无 yield，无窗口。
- lifecycle activate 锁链：acquired 标记 + settleCurrent 放行 + 对称自清，未发现新洞。
- concurrency-pool 本体：abort 清理、release 防下溢、listener 移除闭环完整；生产槽位泄漏根因在 runSpawn 挂死（RC 家族），池本体无泄漏。
- engine/ 层（registry/routing/pool-manager/schema-emulation/task-spec-mapper/zcode-preparer）：未发现本家族实例。
- jsonl-run-store 去抖/dispose/串行链：已经多轮评审加固（ES3/ES9/DS5），到位。
- chatMode 活进程数无上界（ceiling）：登记过的 documented deferred，非隐蔽缺陷。

## 附录 B：普查原始编号映射与计数推导

- 本文 RC-1/2/3/4 = sess_dc2333c9 生产事故分析的同名录根因（已实锤，本文仅作锚定引用）。
- LC-1..LC-10 = 生命周期域普查 F1..F10；PS-1..PS-15 = 持久化/通知域普查 F1..F16；OR-1..OR-8 = 编排域普查 S1..S8。
- **计数推导（34 → 32）**：原始普查 34 条 = LC 10 + PS 16 + OR 8。LC-F6 与 PS-F10 为同一发现（session-pending Map 游标无界），并条为登记条 LC-6（2→1）；LC-F10 为该发现的跨域重复登记，不另设登记条，LC-10 编号保留为占位行标记此归并。故登记表 33 个编号、独立缺陷 **32 条**。此推导以登记表实数为准（T0 13 + T1 6 + T2 13）；若与普查原始记录有出入，以表格实数为准。

## 附录 C：修复前的运营缓解（止血，非修复）

在代码修复落地前，生产环境可设 `XYZ_SUBAGENT_SPAWN_WATCHDOG_MS=1800000`（30 分钟）把「永久挂起」降级为「有界挂起」——注意这是兜底不是修复：daily 守卫 60% 触发率的教训表明，兜底的高触发率本身就是正常路径 broken 的信号，缓解期间应同步推进 M1。**已知副作用**：该 env 挂在 spawn 起点且覆盖**全部** spawn（`session-runner.ts:1700-1707`），不只 keep-alive——超过 30 分钟的合法长 one-shot 任务也会被误杀；止血期若存在此类任务，放宽手段是**显式传 maxTurns**（按任务轮数估算，优先级高于 env，见 `resolveSpawnWatchdogMs` `:229-251`）或**调大 env 值**，或接受误杀风险。

## 变更历史

| 日期 | 事件 |
|------|------|
| 2026-09-10 | agent-end 完成回收根修落地回写（C-proc-10；设计 [subagent-agent-end-recovery.md](subagent-agent-end-recovery.md)，实施单元 u1-u5 已全部 committed，u6 即本次回写）：①P-T1 降级路径列原备注「sessionDir 后缀扫描未启用，保留为 LC-4/PS-9 修复面」关闭——D2 扫描兜底（locateSessionFileByScan）已落地，接入 agent_end 决策回补链与 close 收尾反查链两点，LC-4/PS-9 修复面闭合；②新登记 §7.2 T8 翻转决策（agent_end error 分支 15s 回补重试窗口，收口 §5 裁决 2「保守 = 不限时」）；③§11 P-RC1 补执行载体声明（S1 场景兼作探针执行载体）。本文此前无集中变更历史节（历史登记以 §7.2/§7.3 内联清账形态存在），本节自本行起建 |
| 2026-09-10 | **架构分叉后的重放移植修订（C-proc-10；权威 SSOT [subagent-agent-end-recovery-replay.md](subagent-agent-end-recovery-replay.md)）**：M0 整树重置到 dev-0.9.16 后，线 B 实现宿主（engines/pi 整目录）删除。①新增「修订记录」节（D1-D4 移植判定 + M1-M4 新落点 + 已删文件/符号清单）；②对上两行（P-T1 降级路径列 / §7.2 T8）作当前树口径勘误：D2 扫描在本次重放只在 close 收尾单点接入、匹配键改为 prompt 头部（M4），agent_end 侧由 M2 惰性 get_state 回补承担，15s 窗口不移植（D3 问题域结构性消失）；③本 audit 层面的既有修复（T1-T7 / 32 条登记）不受影响，仍为 dev-0.9.16 基线的现行事实 |
