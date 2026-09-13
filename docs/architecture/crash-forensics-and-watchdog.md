# 崩溃取证闭环与看门狗：E 组剩余项技术方案（台账 E1 + 看门狗/滚动重启 E5 + 诊断导出 E7 + 批次补课）

> **一句话结论**：专项阶段一（根治）与阶段三子集（中短期自愈）已交付，但取证与兜底仍是断链——崩溃归因靠五类日志人工拼接，全部「挂数据驱动重审」触发条件零跟踪，runtime 内存压力无降级/计划重启通道。本设计交付三层闭环：**统一崩溃台账（含触发条件评估器，消解暗债）→ 看门狗 + checkpoint 自动恢复（E5，分档实施数据门裁剪）→ 诊断导出（E7 用户出口）**，并清偿 4 个批次补课小项。

## 开篇（SCQA）

- **S（情境）**：Taiji.app 四层进程（Electron main / runtime / renderer / 每 session 一个 pi）经 2026-09 稳定性专项后，崩溃防线与空闲回收已交付——extension 守卫消灭了最大实锤崩溃源，renderer 崩溃自动 reload 带熔断，pi 崩溃自动 respawn 带 join，空闲 pi 2h 回收。取证生产端也已齐：pi-crash 崩溃上下文、杀链决策日志、水位 5min 打点、renderer-error 落盘、supervisor 重启决策日志。
- **C（冲突）**：但消费端不存在——任何一次崩溃后回答「哪层崩的、为什么、影响了谁」仍要在 `runtime-*.log` / `pi-crash-*.log` / `renderer-error-*.log` / main 日志 / macOS DiagnosticReports 五处人工拼时间线；两份设计文档里登记的 20 条重审触发条件（respawn 周均 >5、截断告警周均 >10、水位曲线……）没有任何统计机制在算，条件触发了也没人知道；runtime 自身内存压力只剩「uncaught 崩溃 → supervisor 盲重启」一条路，无降级、无计划内重启、重启后全部 session 要等用户手动触碰才恢复。
- **Q（问题）**：怎么让「崩溃可归因、自愈可观测、触发条件有人算、内存压力走计划内路径、取证有用户出口」，且与已交付形态（respawn / 熔断 / 回收）正确咬合而不是重造？
- **A（答案）**：三件套——① append-only 双文件崩溃台账承接全部层的死亡/自愈事件（**条件类信号一并事件化**，台账是评估器唯一输入）+ 纯函数触发条件评估器（导出与日评双出口）；② runtime 持续 checkpoint + 看门狗两级阈值 + 优雅滚动重启（经既有完整 shutdown 序退出，supervisor 增计划内分支，relay 推迟带上限与双维硬升级）；③ 设置页一键诊断包导出（台账 + 日志尾部 + 触发状态摘要）。批次补课 4 小项随附（tee size 轮转 / 入站 parse 守卫 / 截断反转 supersession 裁决 / 审计覆盖守卫）。

**层声明（当前层 → 下一层）**：本文承接 [long-run-stability-architecture.md](long-run-stability-architecture.md) §3.3 D1/D3/D6③/D7 的架构决策与 crash-resilience.md / idle-pi-reclamation.md（两份设计文档均已删除，git 可追溯；crash-resilience.md 的独有档案已迁入本文附录 D，正文其余引用均为其已交付形态或触发条件出处）的已交付形态，产出**可实施的技术方案**（接口 / 数据模型 / 机制 / 单元拆分）。下一层产物 = dev-flow 实施单元。本文不设计函数级实现细节。

## 1 背景目标

**本章结论**：三个目标——崩溃取证闭环（G4 兜底）、内存压力计划内通道与崩溃自动恢复（G3 兜底）、重审触发条件有消费方（防掩盖约束兑现）；批次补课 4 小项随附；E3/E4 架构级增量与 base64 剥离显式出 scope（等台账数据）。

### 1.1 系统是什么（受众补足）

四层进程模型与已交付防线（理解本设计的前提）：

| 层 | 进程 | 已交付的死亡/自愈防线 | 已交付的取证生产端 |
|---|---|---|---|
| main | Electron 主进程 | render-process-gone 自动 reload（60s 滑窗 ≤3 次熔断，C-proc-16）；runtime supervisor 崩溃自动重启（1s-16s 退避，MAX 5）+ liveness 假死探针 | main-logger（含 stderr rotation）+ renderer-error-*.log（IPC 落盘）+ 重启决策日志（trigger: process_exit / liveness_unhealthy / restart_failure） |
| runtime | Node WS 服务，托管全部 session | pi respawn（5s 延迟 + 连续 2 次熔断 + join）；空闲回收（2h idle 且 30min 未查看，最小摘除）；孤儿收割（启动 5s 后 spawn marker 清单 + argv + ppid=1 判据，v2 marker 化） | runtime-*.log（date+size 轮转）+ 水位行（5min）+ 杀链决策日志 |
| renderer | Vue GUI | 错误捕获三件套 + 恢复提示条 | （经 IPC 落 main） |
| pi | 每 session 一个 | guardStaleCtx 守卫（C-pi-17，2026-09-13 合并改号——原 C-pi-16 与 dev-0.9.19 重排撞车）；SIGTERM 优雅退出（P1 实测 flush 完整） | pi-crash-*.log（崩溃上下文 + stderr 尾）+ pi-*.jsonl tee（无 size 轮转——本设计 D7 补课） |

关键既有设施（本设计复用不重造）：`restart-policy.ts` 纯逻辑状态机（idle→counting→exhausted，稳定 10s 清零）；`reap-orphan-pi.ts`（误杀防线：spawn marker 清单 + argv + ppid=1 判据【v2 marker 化】+ 单实例锁分工）；respawn 抑制（destroy 先删 `clientToId`/`processes` Map，exit handler 反查无条目即静默——process-manager.ts 源码实证）；`startup-background-init` 编排启动期后台任务；完整 shutdown 序（index.ts，现行 13 步打点序见 rolling-restart.ts `SHUTDOWN_STEP_SEQUENCE`：cancel-rolling-restart → 停水位定时器 → 停 watchdog → 取消 pending respawn → 停 reaper → store flushAll → skillRegistry.dispose → completionBackflow.dispose → relay 杀链 → server.stop → 引擎池 dispose → close-crash-journal → closeLogger 尾部 flush）。

### 1.2 设计目标（从使用者体验倒推）

- **G-A 崩溃归因一键可达**：任何一次崩溃后，用户（或接报障的开发者）导出一个诊断包，里面直接回答「哪层、哪个 session、为什么、影响了谁、最近趋势」——不再人工翻五处日志。
- **G-B 自愈可观测、触发条件有人算**：每次自愈动作（respawn / reload / 回收 / 重启 / 滚动重启）都在台账里可数；两份设计文档登记的全部重审触发条件有一个纯函数评估器周期性/按需计算，越线即出声（摘要行 + 诊断包内状态表）。
- **G-C 内存压力走计划内路径、runtime 死后自动恢复**：水位临界先降级再优雅滚动重启（relay 在途任务推迟但有界可升级）；runtime 崩溃/滚动重启后新 runtime 按 checkpoint 自动恢复崩溃前的活跃 session（不再等用户逐个触碰）。
- **G-D 批次补课清偿**：pi tee 单文件 size 上限（198MB 实证问题收口）、renderer 入站 parse 防御纵深、截断反转的 supersession 裁决、stale-ctx 审计覆盖的机器守卫。

**In-scope**：E1 台账（双文件 writer + schema + 写入点矩阵 + 防漏 + 条件信号事件化）+ 触发条件评估器；E5（checkpoint 持续交接与自动 reattach / 看门狗采样与两级阈值 / 降级 / 优雅滚动重启 / relay 推迟 / supervisor 计划内分支 / renderer 非阻塞横幅）；E7 诊断导出（设置页入口 + 死态页入口 + zip 打包）；批次补课 4 项；新增约束登记义务。
**Out-of-scope**（显式裁决，非静默丢弃）：
- **E3/E4 架构级增量**（崩溃分类差异化 respawn、在途 turn 一键重发、草稿持久化、面板级错误边界、getAppMetrics 联动）——各自带书面重审触发条件，等 E1 台账 + 水位数据积累后按触发条件逐项立项；本设计的评估器（D2）正是这些触发的消费端。
- **base64 剥离**（D15 两步走第二步）——挂数据驱动重审，同上。
- **runtime 多进程隔离**（G1 的终局形态）——架构层已裁 out-of-scope，维持。
- 联网上报 / 崩溃遥测后端——架构 D7 已否。

## 2 现状与问题分析

**本章结论**：信号生产端五类已落地、形态各异且互不知晓；消费端（统一视图 + 统计判断）为零；这是「台账缺位」单一根因的三个投影。

### 2.1 使用者视角的现状（真实例子）

2026-09-09 的 renderer OOM 排查实际过程（本机，取证成本实证）：用户看到白屏自动恢复 + 一条提示条。开发者归因要：① 打开 `~/Library/Logs/DiagnosticReports/` 找 `.ips`（macOS 还会清理旧报告）；② 翻 `~/.xyz-agent/logs/renderer-error-2026-09-09.log` 找崩溃前最后一条 JS 错误；③ 翻 `runtime-*.log` 的水位行确认当时内存；④ 交叉时间戳拼「哪层先崩」。整个过程约 20 分钟，且 `.ips` 可能已被系统清掉。这就是 G4 不成立的直接形态。

### 2.2 信号源盘点（生产端已落地，全部第一手核实）

| 信号 | 位置 | 形态 | 缺什么 |
|---|---|---|---|
| pi 崩溃上下文 | `logs/pi-crash-<date>-<sid>.log`（rpc-client.ts 落盘） | runtime-context 头（lastRpcCommand/uptime/内存快照）+ stderr 全量 ≤1MB | 不进任何统一视图；7 天后随保留期消失 |
| 杀链决策日志 | `runtime-*.log`（reap-orphan-pi.ts / pi-respawn.ts / relay-registry） | 结构化行（schedule/attempt/fail/success 四态、kill decision） | 同上；grep 人工统计 |
| 内存水位 | `runtime-*.log` 每 5min 一行（logger.ts，main-logger.ts 同款） | rss/heap 四指标文本行 | 无 60s 环形采样、无阈值判定、无曲线出口（只在日志里） |
| renderer 错误 | `logs/renderer-error-<date>.log`（IPC 落 main，限流 100/min） | 时间戳 + 栈 + performance.memory | 与 render-process-gone 事件无关联记录 |
| supervisor 重启决策 | main 日志（trigger/退避/计数） | 结构化行 | renderer 崩溃 reload、pi respawn、runtime 重启三类事件无统一计数面 |
| session 恢复广播 | WS `session.restored/restoreFailed`（入 ring 回放） | 运行时事件 | 不落盘，重启后消失 |

### 2.3 根因分析

「台账缺位」一个根因，三个投影：① 归因断链（§2.1——五处拼接）；② 防掩盖约束悬空（20 条触发条件零消费，见附录 A 全量清单——其中「台账显示 X 周均 >N 次」类条件在台账不存在时**永久不可判**）；③ 兜底盲跑（respawn/reload/收割在跑，但「自愈是否在高频触发 = 正常路径 broken」这个信号无人计算——恰是全局规则「兜底被高频触发」的监测缺口）。

### 2.4 物理数据流：一次崩溃事件从产生到消散（现状）

```
pi 崩溃（exit 1）
  ├─ rpc-client exit handler ──▶ pi-crash-*.log（✓ 落盘，7 天后消失）
  ├─ pi-respawn 调度 ──▶ runtime-*.log 决策行（✓）──▶ WS session.restored（✓ 运行时，不落盘）
  └─ 用户看到恢复提示条（✓）
       └─ 三周后想问「最近崩溃频率正常吗」──▶ ① pi-crash 文件已被 7 天保留期清掉
                                                ② 决策行散在已被 size 轮转掉的 runtime-*.log.1 里
                                                ③ 无任何计数面 —— 归因与趋势双丢失
```

台账的存在把这个数据流改为：每个事件在产生点同步 append 一条 JSONL（内嵌 detailDigest 归因最小证据），轮转保留末 3 段 ×10MB——归因能力不再依赖会被清理的细节文件。

## 3 解决方案

### 3.1 终态（使用者视角先行）

**场景一（崩溃归因）**：开发者收到用户报障「今天下午 session 崩了一次」。用户在 设置 → 系统 → 导出诊断包，确认对话框提示「包含本机路径与会话标识信息」，保存 zip。开发者打开 zip 内 `summary.md`：`layer=pi / sessionId=01a06a87 / reason=extension-error / 14:32:05 / detailDigest（stderr 末 10 行）/ respawn 成功 5.4s`，下方是触发条件状态表（全部绿色「未越线」，`auto-respawn 周均 = 0.7 < 5`）。归因完成，零日志翻找。

**场景二（内存临界，计划内重启）**：长跑第 12 天，runtime heap 到 85%。用户看到非阻塞横幅「内存接近上限，将在后台任务完成后自动重启（任务完成时点不可预估，推迟上限 30 分钟；重启执行约 30-60 秒）」；在途 subagent（含本地引擎形态）完成后 runtime 经完整 shutdown 序以专用退出码退出，supervisor 立即重启不计退避，新 runtime 按 checkpoint 恢复了崩溃前的 3 个活跃 session（各 ~600ms），横幅变绿色「已恢复」。全程无白屏、无连坐、无手动操作。若 relay 任务挂住超过 30 分钟推迟上限或 heap 升至 92%——横幅变红「立即重启」，台账记 `rolling-restart-forced`。

**场景三（runtime 意外崩溃，自动恢复）**：runtime 被 OOM kill。supervisor 按既有退避重启；新 runtime 启动发现 `main-running.marker` 残留（上次 unclean）→ checkpoint 可信 → 等孤儿收割完成 → 系统无内存高压 → 按 checkpoint 恢复活跃 session（staleness guard 跳过已被用户删除的，记 `reattach-skipped`）。用户视角：约 10-20 秒的「正在恢复」状态后一切如常（构成：收割宽限 5s + ps 枚举上界 + 分批 reattach，见 D3），事后台账里有完整事件链（crash → restart → reattach N 个）。

**失败路径（恢复指引）**：诊断包导出失败（磁盘满/权限）→ 错误提示含具体路径与重试按钮；checkpoint 损坏 → 记 `checkpoint-corrupt` 退回既有 lazy 恢复（不劣于现状）；评估器读不到台账文件 → 摘要标注「数据缺失」而非静默空白；收割等待超上界 → 该 session 记 `reattach-skipped` 走 lazy（宁 lazy 不双持）。

### 3.2 总体方案对比（准则：≥2 候选）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 按架构 D1/D3/D7 原样全量实施** | 高（架构已论证） | 高：E5 全量（看门狗+滚动重启+relay 推迟）在水位数据尚未证明需要时上线路径，阈值全靠拍 | 中：滚动重启本身是新故障面（重启循环/收割竞态），无数据校准先武装 = 违反「兜底先行会掩盖问题」的同类教训 | ❌ |
| **B. 分档实施 + 数据门（推荐）** | 高：E1/E7（取证+消费端）无条件上——它们是暗债的根修；E5 拆两档——E5a（checkpoint 自动恢复）无条件上（对任何 runtime 崩溃都有收益，与内存趋势无关），E5b/c（看门狗阈值→降级→滚动重启→relay 推迟）实现完整但**武装时机挂 Gate W 水位复审**（V6 soak + 既有水位数据） | 中：单元可独立验收，档间无硬依赖 | 低：先观测后武装，符合架构 E5 行「依水位数据裁剪甚至缓建」的原意——且把该裁决从「无人执行的条款」变成有触发条件的设计内 Gate | ✅ |
| **C. 最小方案：只做 E7（拼现有日志导出 zip）** | 低：不解决统一台账，导出的是五处拼接的自动化版；触发条件消费端仍为零 | 低 | 中：暗债原样保留，下次审计同样结论 | ❌ |

**被否若用 C**：§2.1 的例子里，开发者拿到的 zip 仍是五类原始日志的堆砌，「哪层先崩」仍要人工对时间戳；场景一的触发状态表不存在。**被否若用 A**：场景二在长跑第 3 天就被触发而水位数据（5min 行）从未被分析过——滚动重启阈值未经校准先武装，E3 类 OOM 背景下的「重启→高水位→再重启」循环风险未被数据排除。

### 3.3 关键决策与权衡

**本章结论**：9 个决策——D1 台账双文件（条件信号事件化）、D2 评估器（暗债根修）、D3 checkpoint 自动恢复、D4 看门狗采样与降级、D5 滚动重启执行链、D6 诊断导出、D7 tee size 轮转、D8 入站 parse 守卫、D9 两个 supersession/守卫裁决。

---

**D1：统一崩溃台账——双文件 append-only JSONL（承接架构 D1，对齐已交付形态）**

- **采用**：`<dataDir>/logs/crashes/main.jsonl`（main 进程写：main 自身 + renderer 事件）与 `runtime.jsonl`（runtime 写：runtime + pi + plugin-worker 事件）。单文件 10MB size 轮转，保留末 3 段（`crashes/runtime.jsonl` → `.jsonl.1` → `.jsonl.2`；主日志现状为单代 `.1`，多段级联 rename 是本设计对既有形态的扩展而非照抄）。清理**只依赖自带轮转**——`crashes/` 是子目录，`cleanExpiredLogs` 与 main 侧 log-retention 均只认顶层平铺前缀、结构性跳过子目录，这与架构 D1 原裁「不得引用既有通道作清理依据」自洽（不修改既有清理器的「跳过目录」语义——它保护 token/缓存等非日志产物）。事件 Schema（继承架构 D1 字段集，`event` 枚举对齐已交付 + 本设计新增，**含条件类信号**——它们是 D2 评估器的数据源）：

  ```json
  { "ts": "2026-09-12T02:57:03Z", "layer": "pi|runtime|renderer|main|plugin-worker",
    "event": "crash|unresponsive|auto-respawn|auto-respawn-failed|reload|rolling-restart|rolling-restart-deferred|rolling-restart-forced|shutdown|deleted|reclaimed|memory-relief|reattach-skipped|checkpoint-corrupt|reaped|inbound-frame-dropped|frame-truncated|registry-miss|watermark-daily|trigger-review",
    "sessionId": "01a06a87-…", "reason": "extension-stale-ctx|sigterm|planned|unclean-exit|warn-tier|trunc-tier|…",
    "exitCode": 1, "rss": 402653184, "heapUsed": 301989888,
    "uptimeSec": 86400, "appVersion": "0.9.16", "piVersion": "0.84.4",
    "memPressure": { "swapUsedMB": 11004, "freeMB": 170 },
    "detailDigest": "末 10 行 stderr 摘要内嵌（≤2KB）", "detailPath": "logs/pi-crash-….log" }
  ```

  字段全可空（对齐 pi-crash 上下文的「不知道 ≠ 没打点」原则）。**写入点矩阵**（与已交付形态的咬合是本决策的核心增量；**deleted 行的挂点是抑制语义下的特殊路径，不能挂在 onSessionExit 链**——用户删除走 lifecycle.delete → destroySession 先删 `clientToId`/`processes` Map → pi exit handler 反查无条目静默返回，不经 onSessionExit，挂错点事件永不产生）：

  | 事件 | 写入点（挂接既有链路，不新建探测） | 文件 |
  |---|---|---|
  | pi crash / auto-respawn 四态 | session-service `onSessionExit` 链 + pi-respawn 状态机（与既有决策日志同点双写——决策日志给 grep，台账给结构化消费） | runtime.jsonl |
  | deleted | `removeSessionEntry` 汇聚点（session-service.ts:1191——lifecycle.delete 主动删与 onSessionExit 异常退的公共收口，能同时覆盖两类路径的台账记录；行号为 2026-09-12 对齐时点，以符号为锚） | runtime.jsonl |
  | reclaimed | reaper `reclaimManagedSession` 摘除步（idle 设计 D7 预登记的「阶段二台账落地后追加」在此兑现） | runtime.jsonl |
  | reaped | reap-orphan-pi 杀链（v2 判据命中处：组合根注入的 spawn marker 清单 `readSpawnMarkers` + argv 匹配 + ppid===1——v1「--session-dir 精确相等」判据已 marker 化，防误杀三重防线语义不变） | runtime.jsonl |
  | plugin-worker crash | plugin-host worker 退出计数器（既有日志点补台账行） | runtime.jsonl |
  | runtime crash / rolling-restart | **main 侧 supervisor** `onRuntimeExit`（含 trigger/退出码/重启决策）——runtime 被 SIGKILL 时自己写不了，supervisor 是唯一在场者；计划内退出码见 D5 | main.jsonl |
  | renderer crash / reload / unresponsive | main 侧 render-process-gone 处理器（C-proc-16 链路）+ 熔断转静态页事件 | main.jsonl |
  | memory-relief / rolling-restart-deferred / rolling-restart-forced / checkpoint-corrupt | D4/D5/D3 各自动作点 | runtime.jsonl |
  | reattach-skipped | **双落点**：runtime 侧 = reattach 编排的三类异常跳过（staleness guard 命中 / restore 失败 / 收割超上界，逐 session 一条；过滤排除路径不落行——Gate B A3 已观察确认，是否补行待裁决）；main 侧 = 冷启动 checkpoint 残留隔离（clean exit 但残留 → 忽略 + 隔离留痕） | runtime.jsonl / main.jsonl |
  | main 自身 crash | **clean-exit marker**（`run/main-running.marker`：启动写【单实例锁判定后——第二实例的 quit 链亦无害】、will-quit 清、下次启动发现残留补记 `layer=main, event=crash, reason=unclean-exit`） | main.jsonl（下次启动补记） |
  | inbound-frame-dropped | D8 守卫命中（renderer 上报，经既有 renderer-log IPC 通道带结构化标记） | main.jsonl |
  | frame-truncated / registry-miss | 出站守卫判定点（message-bus `guardOutboundPushFrame` 的 8MB 告警档与注册表 miss 分支、reply 超限分支（`appendReplyFrameJournal`，outbound-frame-registry.ts——2026-09-12 自 message-broker 下移避免 transport→infra 反向 import））——评估器条件 #1/#2 的数据源 | runtime.jsonl |
  | watermark-daily | 既有水位 5min 定时器处聚合：**自然日窗口**一条，携带当日覆盖时段的 rss/heapUsed min/max/avg + coverage 起止时间戳——趋势类条件 #4/#5 的数据源（明细 5min 行仍只进 runtime-*.log 供深查，不进台账）。**日内重启处置**：聚合态在 runtime 内存、重启即清零——重启后从重启时刻起算当日剩余窗口，coverage 戳随条目落盘；评估器对 coverage 不足 50% 的日降权标注（滚动重启的水位重置会掩盖「不回落」形态，coverage 是判别依据）。**范围声明**：main 侧水位打点不进本事件（评估器现有条件无 main 水位项），如需再扩 | runtime.jsonl |
  | oom | **已裁决删除（2026-09-12，偏差 #32②）**：`oom` 作为独立 event 零生产者，实际形态三轨——① renderer OOM 走 recovery-policy 链记 `event=reload` + Electron `RenderProcessGoneDetails.reason='oom'` 透传（open reason 集承载）；② runtime/watchdog 保守归普通 crash / memory-relief + rolling-restart 事件；③ watchdog critical 只 WS 广播不落行。pi/runtime 层归因声明不变：系统 OOM kill 到达时是 SIGKILL，与其他 SIGKILL 不可区分——保守归普通 crash（#10 计数因此略偏多，已接受偏差）；深归因走 memPressure 时窗关联 + macOS DiagnosticReports（D6 导出附指引）。先例：v8 删除同类孤儿 event 值 unclean-exit | 归因由 main.jsonl（reload+reason=oom）/ runtime.jsonl（crash、memory-relief）既有行承载 |
  | shutdown | 计划内终止收口。**runtime 自身事件由 main 侧写（信号同源不可区分——SIGTERM 为 liveness 强杀/app 退出共用、uncaughtException 共用 shutdown 序，runtime 序里写 shutdown 会把异常死亡误记为计划内，污染 #3/#16 归因）**：app 级正常退出 → main 在 before-quit 上下文写（**runtime.isRunning 在场性 guard**：mock 模式/runtime 已崩/第二实例形态下 runtime 并未「关闭」，无条件写会产生假 shutdown 行——该形态不写，markAppQuitting 标记本身无条件置位；**app 退出的 exit 落在 onRuntimeExit 的 stopping 早退分支，该分支不写任何行**——stopping 被 stop() 的全部调用方置位（app 退出/强杀共用），按 stopping 写 crash 会把每次正常退出也记假 crash）；runtime planned 退出 → main 在 onRuntimeExit 按退出码 86 写；**异常死亡 → 判别式显式化：非 before-quit 上下文 且 退出码≠86 且 stopping=false 才写 crash**；**liveness 强杀 → 第四挂点：forceRestartForLiveness 与 kill decision 同点双写（event=unresponsive，reason=liveness-unhealthy）——其 exit 落 stopping 早退分支无行可写，必须在杀链发起处记**。**pi 计划内终止的挂点 = 杀链发起处**（destroySession/destroyAll 调用点，与杀链决策日志同点双写，类比 reaped 行挂法）——不能挂 pi exit handler：计划内杀全部走 destroySession 先删 Map、exit handler 反查无条目静默跳过，挂 exit handler 事件永不产生（与 deleted 行同机理）——**附录 A #16 以这些 kill 发起事件的时间窗关联排除计划内 SIGTERM** | pi 侧 runtime.jsonl / runtime 自身与 app 级上下文 main.jsonl |

  三个防漏设计（继承架构 D1 并落地）：① detailDigest 内嵌（归因不依赖 7 天后消失的 detailPath）；② main 层死亡自记（marker 机制，E5a 的 unclean 判定复用同一 marker——一份设施两个消费者）；③ renderer 上报过节流（复用已交付的 100/min 限流 + 同签名去重，不新建通道；负面行为验收见 §4 A8）。
- **被否**：① 「复用现有日志 grep」——架构 D1 已否（§2.1 实证），且日志行会被更快轮转、文本行解析是脆弱契约——这也是条件信号事件化（frame-truncated/watermark-daily）而非让评估器解析日志的原因；② 「单一台账文件由 main 统一写」——runtime 崩溃瞬间 main 与 runtime 的死亡顺序不可控，双文件各写各的消除了跨进程写竞争；runtime 侧事件绕道 IPC 会丢「崩溃前最后一条」。
- **证据**：五类信号源已存在（§2.2 表，全部 file:line 实锚）；pi-crash 8 个历史文件证明「崩溃时落盘取证」形态在本机有效；logger.ts 的 size 轮转（写入字节计数 + pendingLines 防丢）是被测过的可复用形态。
- **效果**：G-A 的数据基础成立；D2 评估器的**唯一输入**成立（20 条条件全部有登记归宿，可机器判定者全部从台账判定，见附录 A）。

---

**D2：重审触发条件评估器——纯函数窗口统计 + 双出口（暗债根修，本设计的问题定义核心）**

- **采用**：新增纯函数模块（放 `packages/shared` 或 main 侧独立文件，无 electron 依赖可单测）：输入 = **两本台账 JSONL + 时间窗口（唯一输入，不解析任何日志文本行）**，输出 = 触发条件状态表（每条：条件 / 当前值 / 阈值 / 状态 tripped|ok|no-data）。条件清单 = 附录 A 的 20 条（两份设计文档 + 架构文档 + 本设计新增的全部已登记触发条件，含「用户反馈型」——后者标注 `requires-user-report` 恒 no-data 但显式列出，消灭「触发词散在文档里无人汇总」）。数据源闭合性：计数类（#1/2/3/7/8/9/10/16）直接数事件；趋势类（#4/5）消费 watermark-daily（D1 事件化，coverage 不足 50% 的日降权标注）；#17 降级反弹判据在采样环内存态、不落台账——消费方 = Gate W（u8）人工复审，评估器侧恒 no-data 但入清单显式登记；其余 requires-user-report。评估器消费点（出口）恰两个，不加第三个：
  1. **诊断导出（D6）**：每次导出必算，状态表进 `summary.md`——接报障的开发者第一眼看到；
  2. **main 每日一次低频巡检**（复用 main 已有的每日定时器形态，log-retention 同款）：任一条件 tripped 则在 main 日志写一条 WARN 摘要行 + 台账记 `event=trigger-review`（带条件 id）——「条件触发了有人知道」的最小闭环，不建仪表盘不做推送。
  **平台节流声明**：macOS 后台/不可见时 timer clamping 会拉长每日巡检与 D4 采样环的间隔——巡检延迟数小时可容忍（条件窗口是周/月级）；采样滞后的 errs 方向 = 告警/重启判定推迟（最坏推迟本会发生的动作，OOM 敞口略增）。显式接受、不申请 powerSaveBlocker（长跑桌面应用常驻防休眠与产品定位矛盾）。
- **被否**：① 「设置页实时仪表盘」——过度设计，触发条件的消费频率是周/月级，仪表盘是常驻 UI 成本换低频收益；② 「评估器放 runtime」——两本台账 main 都可读，runtime 侧只能读一本；且 runtime 自身崩溃时评估器随之死——放 main 与 marker 机制同理（在场者负责）；③ 「评估器解析 runtime 日志行」——见 D1 被否①。
- **效果**：G-B 成立；附录 A 的 20 条从「零跟踪暗债」变为「有消费方」（其中 #17 的消费方是 Gate W 人工复审、用户反馈型恒 no-data 但显式列出）；E3/E4 增量与 base64 的数据驱动立项从此有判定入口。
- **代价声明（已接受）**：条件依赖台账自身留存（末 3 段 ×10MB）——超窗历史不可判，状态表如实标 no-data。量级：事件量 KB 级/日 + watermark-daily 1 条/日，3 段足够覆盖数月；恢复路径：tripped 时独立事件已落盘（trigger-review 自身留痕）；重审触发：若 no-data 占比 >1/3 再考虑加大保留段数；显式判定：可接受。

---

**D3：checkpoint 持续交接 + 崩溃后自动 reattach（E5a，无条件档）**

- **采用**：`<dataDir>/run/runtime-checkpoint.json` 由 runtime 在 session 生命周期事件（attach/detach/reclaim/respawn 成功）时**持续增量维护**（活跃 session 清单 + 每 session 元数据：piSessionId / 文件路径 / lastActivityAt / lastViewedAt / occupancy；原子写 tmp+rename）。**时效性裁决**：lastActivityAt 不在每次 touch 时刷盘（写风暴），而是**搭 reaper 既有 5min tick 的便车**——reaper 每拍本来就要遍历活跃 session 计算 idleMs，顺带刷新 checkpoint 内该 session 的 lastActivityAt/lastViewedAt。滞后方向的数学事实：checkpoint 值 ≤ 真实值 → 计算 idle = now − checkpoint 值 **≥ 真实 idle**——5min 滞后使过滤**偏「漏恢复」**（刚交互过但跨过阈值边界的 session 被判为更闲置而漏恢复），不是偏「多恢复」。结论仍 errs-safe：漏恢复退化为现状 lazy（用户代价 = 一次手动触碰；频度 = 交互后 5min 内崩溃且恰跨阈值边界，低频），但实施与排查时须按「偏漏恢复」理解行为。**快照布尔的反向形态（诚实声明）**：「偏漏恢复」口径仅对 lastActivityAt 维度成立——任务于 T 时刻结束、T+≤5min 内崩溃时快照仍为 true，会**多恢复**一个真实已 idle、reaper 将回收的 session（新 runtime 的 reaper 后续拍按 checkpoint 时间戳正常回收它，自动收敛、无用户可见损害）。排查口径：持续多恢复且不自收敛 = 公式错误；偶发单次多恢复后自收敛 = 快照滞后。
  新 runtime 启动流程 = 读 checkpoint → 判可信度（main-running.marker 残留 = unclean → 可信走恢复；clean exit 但 checkpoint 残留 = 删除失败/killed 短路边缘 → **忽略并隔离残留文件**、记一次 `reattach-skipped`——删除成功即删；删除失败（权限形态）则**重命名进 checkpoint-failed-\<ts\> 家族**（保留 3 份）而非仅尝试删除——文件存在就可能被后续真 unclean 误配对复活旧 session，重命名隔离使配对不可能；**实施分工（对齐交付）**：可信度判定与残留隔离在 **main 侧启动块**（`consumeResidualRunMarker` 消费 marker 残留补记 unclean-exit → `resolveColdStartTrust` 三态判定【no-checkpoint / trusted-unclean / stale-residual】→ `isolateStaleCheckpoint` 隔离），判定需要 marker 与 main 退出语义的在场景性，归 main（「在场者负责」，D1 防漏 2 同理）；runtime 的 reattach 编排只消费 trusted-unclean 结果走恢复，不重复判定；**rename 同域失败的降级声明（显式）**：隔离 rename 自身失败（ENOENT = 与删除路径并发已不存在，视为已隔离；EACCES = 权限同源，rename 与 unlink 同域失败——接受**原地残留**，幂等静默，不升级不重试风暴）——收敛依赖双通道：下次启动重试隔离（每次启动都跑残留分支）+ 后续某次 unclean 崩溃的覆写接管（checkpoint 持续维护的 tmp+rename 覆写主文件，残留旧文件被正常生命周期接管）；**复合误配对窗口 errs-safe 有界**：残留文件被后续真 unclean 误配对的最坏窗口 = 到下次启动隔离成功或覆写接管为止（有界，非永久），且该窗口内误配对的实际形态 = 复活一个用户已删除的 session（staleness guard 会拦截文件不存在的形态，残余是文件仍存在的边缘）——errs 方向是「多恢复一个可自收敛的 session」（reaper 后续拍回收），与快照滞后的反向形态同判定，非数据损坏；隔离动作 best-effort 异步执行不阻塞启动序，重复启动重试失败不重复记事件（台账只记首次））→ **等孤儿收割完成**（收割从 startup-background-init 的 5s fire-and-forget 定时器改为**暴露完成 promise** 给 reattach 编排，等待上界 = ps 枚举 10s + 每孤儿 2s 优雅宽限；超上界未完成的 session 跳过 reattach 记 `reattach-skipped` 走 lazy——宁 lazy 不双持，架构 P9 的消灭双持瞬态约束）→ **高水位延迟**（**即时系统级查询** swap/物理空闲——memPressure 本质是系统级信号，判定时刻一拍即得；不依赖 D4 采样环历史，新 runtime 冷启动时环零数据，依赖环历史 = 空转；系统高压时延迟 reattach 并横幅告知——崩溃本身由内存高压诱发时，集中 spawn 会诱发二次崩溃，进入「恢复→再崩→退避」循环；阈值随 Gate W 校准）→ 分批 reattach（并发上限 2）→ 全部尝试完删除主文件（逐 session 容错，失败走既有 lazy，不阻断）。**编排挂点**：reattach 编排挂在 WS listen **之后**、与 startup-background-init 串行链**解耦的独立并行任务**（不违背「端口先就绪」原则；也不阻塞 background init 链尾的 reaper 启动——收割等待经 Promise.race 消费，收割 promise 化不破坏定时器 unref 语义，promise 本身不是 loop handle），仅收割等待段推迟 reattach 首批。
  **reattach 过滤门槛 = reaper 回收判定的真补集**（reaper 豁免层实为七类，idle-pi-reaper.ts 豁免查询；其中**长时豁免**是 #1 occupancy（三维 turn/compacting/bash 任一命中即「非 idle」）、#2 backgroundTasks、#3 relayChildren——短瞬态豁免 handoff/queuedDeliveries/restoring 声明忽略）：reattach 当且仅当 `occupancy 非 idle 或 backgroundTasks 活跃 或 relayChildren 在途 或 idleMs ≤ 2h 或 lastViewedAt 距今 ≤ 30min`（任一满足；idle 用 checkpoint 的 lastActivityAt 计算；#2/#3 取 checkpoint 快照布尔——reaper tick 搭车刷新时一并快照，豁免查询本来就要算这两个量，零新增探测）。**术语澄清**：本文 occupancy 指豁免 #1 的三维判定，与 idle-pi-reclamation（已删除，git 可追溯）的 `ReclaimSeat`「占座」互斥原语是两个概念。反例对照：①用户 10min 前刚查看、最后活动在 45min 前的 session——reaper 因 viewed 豁免不会回收它、崩溃前 pi 活着 → 必须恢复（按「idle>30min 就不恢复」的错误门槛会漏）；②idle ∈ (30min, 2h) 的 session 不是「即将回收」对象，是崩溃前的活跃 session → 必须恢复；③3 小时后台任务结束后切走（occupancy idle、idle>2h、40min 未查看）——reaper 因豁免 #2 不回收、崩溃前 pi 活着 → 必须恢复（三维公式会漏，这是 v2→v3 的修正点）；④安静的长 turn（subagent 编排中父 session 无输出）可使 idleMs 超 2h 但 occupancy 非 idle → 必须恢复。**hidden 公共 session**：checkpoint 清单与 reaper 候选同源（`getActiveSessionIds()`，含公共 session）——hidden 不经 session.switch、viewed 恒不豁免，reaper 对其行为与可见 session 相同，reattach 过滤同公式适用；hidden 的恢复不计入用户可见恢复提示（无 UI 面）。
  **与已交付形态的三个咬合裁决**（本决策核心增量——架构写作时 idle 回收与 respawn 尚未交付）：
  1. **过滤语义复用**（如上，补集而非山寨阈值）；
  2. **respawn 抑制通道复用**：滚动重启（D5）与 reattach 的 spawn 走既有抑制语义（process-manager.ts：destroy 先删 `clientToId`/`processes` → exit handler 反查无条目即静默），不新建第二套「计划内标记」——该形态即架构 D2 抑制通道的等价实现；
  3. **respawn pending 状态不进 checkpoint**：runtime 死时 pending respawn 定时器随进程消失（已交付行为），新 runtime 的 reattach 是其超集恢复路径——不双轨。
- **被否**：① 「滚动重启时临时写 checkpoint」——架构 D3 已否（临时写在崩溃场景不存在）；② 「checkpoint 含全部 session（含 detached）」——reattach 面扩大 = 启动期 spawn 风暴，违反 G3；③ 「E5a 也挂 Gate W」——checkpoint 恢复对**任何** runtime 崩溃都有收益（与内存趋势无关），且它统一计划内/非计划内恢复路径，是 supervisor 既有自动重启的补全而非新增兜底。
- **证据**：restore 链路是既有冷启动路径（P7 收益门实测 incremental 535ms / Gate B 544ms）；孤儿收割判据与 5s 时序已交付；marker 机制是 D1 防漏 2 的直接复用。
- **效果**：场景三成立；runtime 崩溃从「全部 session 装死等用户」变为「活跃 session 自动恢复」。**声明行为（main 崩溃路径）**：main 自身崩溃后旧 runtime 因 EPIPE 分级护栏 containment 存活（index.ts「log-continue 不升级整机 shutdown」）、占端口；下次启动 `findAvailablePort` 的 `killStaleProcessOnPort` 清掉旧 runtime → 其名下 pi 成孤儿（ppid=1）→ 新 runtime 等收割后 reattach——app 崩溃自动恢复是 G-C 的自然延伸，且 stale-kill → 收割 → reattach 的顺序保证无双持（验收 A3c）。

---

**D4：看门狗采样与两级阈值 + 降级（E5b，武装挂 Gate W）**

- **采用**：runtime 内建 60s 采样环（`process.memoryUsage()` + `v8.getHeapStatistics().heap_size_limit`，内存环形数组保 24h——对齐「水位打点」既有形态升级，5min 日志行保留不动）→ 两级阈值（相对 heap_size_limit：告警 70% / 临界 85%，具体值 **Gate W 校准**）→ 告警级先降级 → 临界级进入 D5 滚动重启决策。系统级 `memPressure`（swap/物理空闲）作为**第二输入维度**（案例三的真实死法是系统级而非 runtime 自身视角——架构 D3 已论证）。**采样形态裁决**：heap 百分比用 60s 采样环（趋势判定需要历史）；memPressure 用**即时系统级查询**（判定时刻一拍即得、无历史依赖——D3 高水位延迟与 D5 硬升级同源此查询，冷启动不空转）。【修订 2026-09-12，oe-audit C4】24h 采样环已删：运行期趋势判定实际走连续拍计数器（consecutiveAboveWarn）+ 单拍样本，环零读者（无 RPC / 不进诊断包 / 重启即丢），Gate W 复审明细走既有 5min 水位日志行——判定面统一为「即时判定」形态（计数器 + lastSample）；武装后若需分钟级历史，加密水位日志采样即可（落盘可复盘）。
  **memory-relief 降级代价（四要素）**：可回收物清单 × 重建成本——① history-rebuild-cache：清后该 session 下次 getHistory 走全量重建（大 session 数秒级 + 文件量级内存尖峰，idle 设计代价声明 2 的实测形态）；② renderer 侧 LRU 收紧：**通道归属 = runtime 看门狗 → WS 广播 → renderer composable 消费**（runtime 自有信号驱动，不引入 main 侧 getAppMetrics 反向通道——那是 E4 增量的事）。**已交付形态**：renderer `useMemoryPressure` composable 消费（refCount 单物理订阅 + 收紧动作可注入），默认动作 = core `setLruMaxSessions` 可变窗压窗 + chat store `evictIfNeeded` 幂等驱逐（实施期补齐了原设计未落实的运行时压窗 API，偏差 #28②）。**降级反弹风险显式声明**：70% 告警清缓存后用户随即切入大 session，重建尖峰可能把水位直推 85% 临界（降级动作制造升级触发）——缓解：memory-relief 只在告警档**持续存在**（连续 2 个采样周期）且执行后水位未回落时才执行，且 Gate W 校准清单显式纳入「降级反弹」项；重审触发：memory-relief 执行后 10min 内水位不降反升 >5% 的比例周均 >30% → 降级清单重审（已回流附录 A #17——判据依赖采样环内存态，消费方 = Gate W 人工复审而非评估器）。恢复路径：可回收物全部自动重建（用户无感，代价是下次访问延迟）；显式判定：可接受。
- **被否**：① 「固定 RSS 阈值」——架构已否（机器差异）；② 「只靠 GC/不设看门狗」——30 天碎片化与三方库泄漏不可控（架构已否）；③ 「降级动作里加『杀最大 session』」——过度设计，降级只动可回收物，重启才是第二档。
- **效果**：G-C 的观测与第一响应成立；阈值武装前先有 24h 环数据可校准。

---

**D5：优雅滚动重启执行链（E5c，武装挂 Gate W）**

- **采用**：临界阈值触发后的序列：① 查在途任务。**「在途」判定谓词 + 求值位置钉死（防 Path A 保活误判 + 跨进程通道）**：pi 侧谓词 = `hasLiveProcessHandle && !hasIdleTimer` 双谓词（活句柄同时覆盖「正在执行」与「Path A 保活」（settled 后等待续聊的进程）——只用活句柄会把全部保活 subagent 误判为在途、推迟恒真、30min 上限从兜底变常态路径；notify-host.ts 的 hasRunningBackground 即此双谓词过滤的既有先例）。**求值位置 = 状态所在的 pi 进程**：spawnedChildren Map 与 idleTimers 是 subagent-workflow extension 的模块级状态（pi 进程内），runtime 无法直查——改为 **extension 聚合上报**：extension 经既有 select 通道推送生命周期事件（plugin-bridge 的 fire-and-forget 事件推送是比 session-manager 更强的先例——非工具上下文自主推送到达 runtime handler 为现役能力），**每条携带该 session 的绝对计数（当前非 idle 句柄数，非增量 delta——任何后续事件都能纠正镜像，单次丢失不累积误差）**；该上报**同时覆盖 pi 引擎进程内与 relay 形态 child 两种宿主**（extension 是两形态派生的共同属主，relay-registry 自身无 idle 语义）。**接线三约束**：① 上报不阻塞生命周期主链（独立微任务 fire-and-forget + pi 侧 select pending 超时清理，**不 await 进 agent_settled handler 链**——该链有时序保护约束 armIdleTimer 先于 notify）；② 事件产生点在 subagent-core、**core 闭包红线（不得 import pi SDK）**——上报出口必须在壳层，新增 core→壳事件出口（RunContext 回调先例）；③ event-adapter 的 marker 路由分支**不得广播前端**（[HISTORICAL] pending 泄漏教训）。**缺席与丢失的语义收敛**：① **per-session 可用性判定**——runtime 是 spawn 执行者、spawn 时刻持有注入列表（getExtensionPaths 结果），按「该 session 实际注入了 subagent-workflow」判定；**不用全局配置快照**（mandatory-extensions.json 是静态打包清单不含禁用状态；disabled-packages.json 是「下次 spawn 生效」语义——mid-session 禁用窗口内已运行 session 的 extension 仍活、在途仍真，全局读法判「无在途」会误杀恰要保护的对象）——未注入 ⇒ 无 pi 引擎 subagent 能力 ⇒ 判「无在途」（正确语义而非 errs）；② **初始上报**：extension 在 session 就绪时上报一次 count=0（**触发时点钉死 = extension 加载完成**——不挂在首个 subagent 调用或其他懒触发上，否则无 subagent 的 session 永不上报，判别失效；此后绝对计数语义不变；**仅在 rpc 模式启动**【2026-09-13 修订——runtime spawn pi 恒 `--mode rpc`，`ctx.mode !== 'rpc'`（裸 pi TUI 等）无 marker 拦截方，select 弹真框超时构成无限闪框事故（2026-09-12 实测），reporter 侧 mode 门控不启动，ask-user 二值判定同款先例】）——使「从未收到任何上报」可判别「缺席/上报链路故障」与「在场且无在途」（否则常态 session 不跑 subagent 就零上报，errs 规则会把每次滚动重启推满 30min 上限——兜底变常态；【2026-09-13 oe-audit 立论改写】原立论「缺席/旧版」的「旧版」形态已被两条事实证伪：builtin extension 与 runtime 同 bundle 同版本发布 + runtime 任何退出路径 destroyAll 杀全部 pi 进程（pi 不跨世代存活）——版本错配组合在发布拓扑里不可达，errs 兜底对象收敛为 reporter 放弃/通道结构性故障）；**runtime 侧镜像条目建立的完整事件集 = 初始上报 ∪ runtime 在全部 spawn 形态（新 session / respawn / reattach / lazy restore / fork）预置 0**——runtime 自己是全部五种形态的 spawn 执行者，spawn 成功即在途镜像为该 session 建条目置 0（此后被 extension 的绝对计数上报覆盖校正）；镜像不依赖初始上报到达（reattach/respawn 后 extension 重新加载自然重发，runtime 置 0 是不依赖任何上报的本地真值），反向也不因 runtime 建条目而豁免初始上报（初始上报失败重试仍独立进行——它服务「下次滚动重启前的 errs 判别」）；**初始上报失败可感知可重试（有界）**（select 失败在 extension 侧折叠——延迟重试累计 30 次后放弃【2026-09-13 oe-audit 修订：原「重试直至成功一次」的无界语义是「旧版 runtime」版本错配立论的产物，随立论证伪一并收敛；60s 重试窗口已覆盖 R2 实证的 attach 竞态（毫秒级自愈），放弃后镜像按 absent-report 走 errs 推迟，errs-safe 兜底不丢】）；③ 镜像挂 session 生命周期对账——pi 崩溃/respawn/reattach/删除时 runtime 重置该 session 条目为 0（这些事件 runtime 自己知道，消灭 stale-high 永久残留）；④ errs 规则：「该 session 已注入且曾收到上报（含初始 0）」→ 按镜像值判；「已注入但从未收到上报」（reporter 放弃/通道结构性故障；原「旧版 extension 组合」立论已证伪，见缺席语义②）→ errs 推迟——推迟有 30min 上限 + 硬升级封顶，最坏一次有界等待；**errs 形态的 deferred 事件字段语义（钉死）**：镜像计数字段取 `null` 而非 0（0 = 在场且无在途的已证事实，null = 计数未知），并以 `reason=absent-report` 独立标记（与正常推迟的 reason 区分）；errs 推迟无完成信号、必然走到 30min 到点，其 forced（reason=defer-limit）**在评估器 #8 占比子句的分子中被排除**（absent-report 形态的 defer-limit 单列观测——errs 推迟本身是上报链路故障的兼容形态，混入占比会把「上报链路问题」误读成「stale-high 镜像漂移」；absent-report 单列数月均 >2 再评估上报链路加固）；relay 兜底 = relay-registry child 存在同样 errs 推迟；⑤ **残余风险双向登记**：偏低方向（个别丢失且无后续事件且对账未命中 → 漏推迟、在途被杀）——重审触发：出现「滚动重启时有在途但未推迟」案例即升级低频全量快照对账（人工观测型，已回流附录 A #18）；偏高方向（最后一条降落事件丢失且 session 无生命周期变化 → stale-high 假推迟，不增重启次数只增等待时长）——观测面 = deferred 事件携带的当时镜像在途计数，重审触发：到点 forced（reason=defer-limit）占 forced 总数 >30% 即升级全量快照对账（与偏低方向对称；**排除 absent-report 形态后的占比**，子句已回流附录 A #8）。zcode 侧快照面已删（【2026-09-13 oe-audit】原设计的 EnginePort 可选成员 `inFlightSnapshot?`（activeSessions 计数、「空闲常驻≠在途」显式排除）自交付起 runtime 进程内零接线——引擎池活在 pi 进程，组合根不可达，属投机预留面；四段零调用链（port 成员 + zcode 实现 + rolling-restart 注入槽 + 求值分支）连同 zcode-engine-inflight 测试一并删除，zcode 引擎子任务由 pi 侧 extension 聚合上报覆盖（引擎子进程是 extension spawn/持有，hasLiveProcessHandle 双谓词可见），引擎宿主迁入 runtime 侧时按 git 历史恢复）——任一在途则推迟（renderer 非阻塞横幅「等待后台任务完成」，用户可强制）→ ② 推迟有界可升级：上限 30 分钟，**双维硬升级** = runtime heap ≥92% **或** memPressure 越限（swap 近耗尽/物理空闲低于下限），任一触发立即执行并记 `rolling-restart-forced`（reason=hard-threshold）；**30min 到点的强制执行同样记 `rolling-restart-forced`（reason=defer-limit，与硬阈值区分——评估器观测 stale-high 的数据源）**；**推迟开始时记 `rolling-restart-deferred`（携带当时镜像在途计数——stale-high 观测面，见缺席语义⑤）**（forced 路径同样走完整 shutdown 序——relay 杀链照跑、在途任务终止，横幅已红牌告知）→ ③ 执行：**执行前 30s 二次广播预告**（内容含「即将重启 + 终端会话将终止」——T0 横幅只覆盖预告时刻的活动终端集合，推迟期内新开的终端靠这次二次预告获得知情窗口；**滚动重启状态机状态【推迟中/预告中/红牌】暴露为只读查询 RPC，renderer 在重连/刷新后主动拉取恢复横幅——「broadcast 时序竞争」教训：需立即消费的持续状态必须可拉取，T-30s 广播只作加速显示而非唯一送达**；横幅是持续态，重启完成时清除）→ **经既有完整 shutdown 序退出**（见下）→ ④ supervisor 识别专用退出码：**立即重启、跳过退避与崩溃计数**（restart-policy 增加 `recordPlanned()` 分支——纯逻辑可单测，状态机加一条 planned 边不进 counting）→ ⑤ 新 runtime 按 D3 reattach，renderer 横幅转「已恢复」。
  **退出链 = 复用既有完整 shutdown 序，专用退出码只改 supervisor 的识别分支，不新增任何退出 shortcut**。继承规则：**以 index.ts 当前实现为准逐行继承**（下列列举仅导航，防文档列举滞后于代码演化）：**取消推迟定时器/使滚动重启状态机失效（本设计新增，非 index.ts 既有——app 级退出时不得继续执行滚动重启）** → 停水位定时器 → 取消 pending respawn timer → 停 reaper → store flushAll → skillRegistry.dispose（chokidar watcher）→ completionBackflow.dispose（退订完成回流）→ relay 杀链（`deinitRelayServer`，在途 relay child 善终）→ server.stop 内 destroyAll + pluginService.shutdown + sessionDataStore.flushAll（plugin 缓存不丢）→ **引擎池 dispose（本设计新增：zcode appserver 杀链；挂点 = server.stop 之后、closeLogger 之前——杀链期间的日志与 stderr tee 要经 logger 落盘，closeLogger 先行则现场丢失。实施现状 = 序列位置与打点占位：引擎物理宿主在 pi 进程内、runtime 进程注册表当前恒空，实际杀链由 server.stop 的 destroyAll 经 pi 侧 extension 收割钩子完成；引擎宿主迁移 runtime 侧时该步骤是杀链接线点——偏差 #29，Gate B A4 挂死缺陷的排查锚点之一）** → closeLogger（tee 尾部 flush——恰是 D7 要保的现场）。照序执行保证「杀完 pi 就 process.exit」这类 shortcut 静默绕过 relay 善终/plugin 缓存/日志尾部的事故形态不发生。**app 级 shutdown 序首先取消推迟定时器、使滚动重启状态机失效**（u7 新增状态机的收口步骤，列入继承清单——推迟等待中的 runtime 收到 app 级 SIGTERM 时不得继续执行滚动重启）。**checkpoint 删除归属 main 侧（v3→v4 修正：runtime 侧「app 级识别信号」不存在）**：runtime 的 shutdown 序被 SIGINT/SIGTERM/uncaughtException 三源共用，app 级退出与 liveness 假死强杀在 supervisor 侧共用同一条 stop 杀链——runtime 无法从信号上区分「app 级退出」（liveness 假死的半活形态下 SIGTERM handler 行为不确定，按 SIGTERM=app 级删文件会让恢复链对该场景失效；uncaughtException 走同一 shutdown 序，会自删自己的恢复依据）。故 runtime 的任何退出路径（planned / uncaught / 被强杀）**一律不删 checkpoint**（删除步骤不进 runtime shutdown 序）；删除只有两个属主——**main 在 app 退出链删除**（确认 runtime 子进程死亡后删文件；liveness 强杀重启与滚动重启时 main 都不删——main 天然知道自己的意图，零新通道）与**新 runtime 的 reattach 编排在全部尝试完后删**（D3 既有语义）。**删除实现语义钉死**：删除 = before-quit 专属 await 链成功段的后续步骤（确认 runtime child 的 **exit 事件**后执行；stop() reject 或 killed 短路 resolve——非 darwin 的 window-all-closed 先调 stop 使 `child.killed` 置位，第二次 stop 的 killed 检查立即 resolve 不等真退出——都跳过删除）。**marker 清除与 checkpoint 删除解耦**：marker 语义 = 「main 存活」，清除挂 will-quit（main 正常走完退出流程即清，与 stop 成败无关）——否则非 darwin killed 短路会**同时跳过 marker 清除与删除**，下次启动「marker 残留」误判 unclean 走 eager 恢复，违反 A3b。跳过删除的残留 checkpoint 交 D3「clean exit 但残留」分支处理（该分支**忽略并删除残留文件**——消灭「陈旧清单 × 后续真 unclean」的误配对窗口）。**不得挂 stop() 内部**（liveness 强杀共用同一 stop——挂错会把 liveness 场景该保留的 checkpoint 删掉）。
  **runtime 子进程家族清单与退出处置**（新增小节，滚动重启把「谁跟宿主走」从隐式变显式）：

  | 子进程 | 退出处置 | 备注 |
  |---|---|---|
  | pi（每 session） | shutdown 杀链 + 抑制语义（不触发 respawn） | 既有 |
  | relay child | `deinitRelayServer` 杀链（kill-on-disconnect 同源） | 既有 |
  | plugin：trusted（Worker Thread） | 随宿主进程消亡 + sessionDataStore.flushAll 先行 | 既有 |
  | plugin：sandbox（独立 fork 子进程） | pluginService.shutdown → processHost.shutdown 的 `killChildGracefully` 显式杀链（**非**「随宿主消亡」——fork 进程不随 Worker Thread 语义死） | 意外孤儿并入 §5 reap 判据扩展检查点（同 appserver） |
  | zcode appserver 常驻子进程 | **现状 shutdown 序本身漏处置**（生命周期归引擎 dispose 但 shutdown 序未调用，connection.ts 注释实证）——本设计新增「引擎池 dispose」步骤，挂点见退出链 | **意外崩溃场景**（无 shutdown 机会）的 appserver 孤儿是现状既有缺口（收割判据只覆盖 pi：spawn marker 清单 + argv + ppid=1）：本设计收编计划内路径，意外路径登记为待验证检查点（reap 判据扩展 argv marker 的可行性），不静默 |
  | **terminal PTY**（terminal-service `pty.spawn`，每活动终端会话一个） | **计划内路径 = 显式接受「终端会话随重启终止」（SIGHUP 语义）**：滚动重启横幅文案预告「终端会话将随重启终止」，正在跑的交互命令（构建/watch/vim）被终止 | **代价声明（已接受）**：量级 = 每次滚动重启终止当时全部活动终端（滚动重启本身是罕见兜底路径）；恢复路径 = 用户重开终端重跑（PTY 会话无持久化语义）；重审触发 = 终端终止抱怨随滚动重启出现即评估「PTY 独立存活（setsid 脱离宿主）」立项（已回流附录 A #19，requires-user-report）；显式判定：可接受。**意外路径**：忽略 SIGHUP 的终端命令残留为孤儿——并入 §5 reap 判据扩展检查点；A4 补「重启后无残留 PTY 进程」检查 |
- **被否**：① 「只重启不降级」——架构已否（假阳性打断用户）；② 「推迟无上限等任务」——subagent 任务级无墙钟超时是既定原则，推迟方必须有界；③ 「滚动重启绕过 checkpoint 直接冷启动」——丢场景三的自动恢复，且统一恢复路径正是 D3 的设计动机；④ 「专用快速退出路径（跳过 flush 直 exit）」——见退出链声明，shortcut 的三类静默损失已列。
- **与已交付形态的咬合**：respawn 抑制复用（D3 裁决 2）；relay 推迟查询点 = relay-registry 既有注册表（kill-on-disconnect 的同一数据源，零新增状态）；横幅**复用 CrashRecoveredBar 的视觉形态但不复用其一次性语义**——推迟等待是持续状态：runtime 暴露滚动重启状态只读查询，renderer 在 WS 重连/刷新后主动拉取恢复横幅（T-30s 广播作加速显示），重启完成后转绿色「已恢复」（数据源 = reattach 编排完成事件，session.restored 同源）30s 自动清除、手动刷新不重现；**终态形态分叉**：renderer 全程在线见绿色确认；重启执行期断连（runtime 死 30-60s）后重连的，新 runtime 状态机无滚动重启状态、拉取后横幅直接消失（不重现）——两种终态都合法；**窗口级横幅互斥**：与 CrashRecoveredBar 同时在场时滚动重启横幅优先（更紧急的全局动作），RespawnNoticeBar 在对话流内不冲突；i18n 双 key（en/zh）随交付。
- **代价声明（已接受）**：滚动重启期间在途 turn 中断 + 推迟窗口内 uncaught OOM 概率上升（由 30min 上限 + 92% 硬阈值封顶，最坏退化为现状崩溃恢复路径——checkpoint 兜底，不新增无兜底损失）+ **退出链时长**：完整 shutdown 序含引擎 dispose / relay 杀链的 SIGTERM→宽限→SIGKILL 链，上界约 10-20s（与收割链同量级），叠加 supervisor 重启与 reattach，端到端恢复约 30-60s（场景二横幅「预计时长」按此口径）。重审触发（滚动重启 >周 1 / 推迟月均 >10 / forced 月均 >3）已入附录 A，评估器消费。
- **Gate W（武装门）**：E5b/c 代码完整交付但阈值触发滚动重启默认不武装（env `XYZ_RUNTIME_WATCHDOG_ARMED` 可开，见 §5 env 命名）——武装条件 = V6 soak（2026-09-18 到期）+ 既有 5min 水位行数据复审后，确认阈值校准值与「重启循环」风险排除。**这把架构 E5 行「届时可依水位数据裁剪甚至缓建」从无人执行的条款变成设计内 Gate**；若数据证明 30 天内存平稳，E5b/c 可长期保持不武装（代码在、观测在、兜底随时可开）——这本身是合法终态。

---

**D6：诊断导出（E7）**

- **采用**：设置页 系统 分区新增「导出诊断包」行 + 死态静态错误页（C-proc-16 熔断后的手动重试页）带同款入口。main 进程打包 zip（用户自选保存位置）：`crashes/main.jsonl` + `crashes/runtime.jsonl`（现档）+ 触发条件状态表（D2 评估器输出）+ 各层日志尾部（runtime-*.log / main 日志 / renderer-error-* 各取末 256KB，非全量）+ 近 24h 水位行摘录 + 版本/平台/pi 版本/marker 状态。zip 内置 `summary.md`（人读首屏：最近 10 条台账事件表格 + 触发状态表 + 各文件清单说明）。
  **隐私判定（逐项）**：detailDigest（stderr 末 10 行——extension 错误栈**含本机绝对路径**）、日志尾部（cwd slug、session 文件绝对路径、杀链决策行）、renderer-error 栈、sessionId。判定：**与 session 历史 JSONL 明文落盘同级敏感度**（本地文件、用户自选位置自管、不联网），**不脱敏**——路径与会话标识正是归因线索，脱敏摧毁诊断价值（对齐 crash-resilience.md（已删，git 可追溯）D4 草稿「草稿明文落盘」的先例判定结构）。补偿：导出确认对话框文案含「包含本机路径与会话标识信息」知情提示。重审触发：用户反馈需要脱敏版时再评估可选项（已回流附录 A #20，requires-user-report）。
- **被否**：① 「联网自动上报」——架构 D7 已否；② 「导出全量日志」——GB 级且含 session 隐私内容，尾部 + 台账已覆盖归因需求（detailDigest 设计的初衷）；③ 「默认脱敏」——见隐私判定。
- **效果**：G-A 的出口成立；场景一完整兑现。

---

**D7：pi tee size 轮转（O2-C 补课，推翻 logger.ts 既有裁决）**

- **采用**：`createPiStreamWriter` 增加 per-writer size 轮转——写入字节计数触发，阈值与主日志共用 `MAX_FILE_BYTES`（`XYZ_LOG_MAX_BYTES` env 单旋钮，默认 50MB；无独立 tee 阈值常量）。**旋段形态（交付对齐，2026-09-12 dev-0.9.17 合并裁决）**：达阈值 → end 旧流等待 flush → zlib 流式 gzip 归档为 `<file>.1.gz`（**gzip 单代**，tmp→rename 原子覆盖，gzip 兜底超时防挂死；gzip/IO 失败 best-effort 保留原文件）→ 新流截断续写原路径（tee 核心价值是「卡死时尾部现场」，主档保真即达成；压缩只改存储形态、不改内容形态——主档与旋段都是逐行 valid JSONL）。**复刻点显式列出**（「对齐主日志形态」的具体含义）：① 轮转窗口写入队列防丢（rotationInFlight 窗口内到达的行入队，新流就绪后按序回放；窗口内重复触发复用同一 promise）；② **openPiStreams 注册表的 stream/file 引用在轮转后更新**（退出 flush 找到的是新流不是旧 fd）；③ `pi-relay-*` 同款（与 session tee 共用同一 writer 工厂，轮转自动覆盖两形态）。**段文件必须保持 `pi-` 前缀**（架构 D6③ 不变量：否则旋段文件逃出 cleanExpiredLogs 的 7 天清理白名单，变成新的无清理写入面）——此不变量随交付登记约束（§5 义务⑤）。**显式登记推翻** logger.ts 既有注释裁决「不轮转：单 session 事件量可控」——198MB 实测已证伪其前提（架构 D6③ 原文要求此登记）。idle 回收已让长闲置 session 的 writer 在摘除时 end（天然分段），本补课收口的是**持续活跃** session 的单文件无界（30 天长跑常态）。**交付偏差注记（两则）**：① 初版实现（单代 `.1` 平面文件 + 独立阈值注入面 opts.maxBytes 与 PI_TEE_MAX_FILE_BYTES 常量，均已删除）随 dev-0.9.17 合并被对方的 gzip `.1.gz` 实现取代，阈值收敛为 `XYZ_LOG_MAX_BYTES` 单旋钮；② 「打开时预滚」（writer 打开时 stat 盘上文件、超阈值先滚动，封顶跨重启同 date 文件）随 ① 失去宿主一并删除——字节计数起点 = writer 创建时 0，reattach 重开同 date 大文件最坏可约 2× 阈值才轮转；跨重启 size 封顶属后续独立工作（偏差 #32④ 登记接受）。
- **被否**：「按天分文件就够」——writer 创建时日期固定，跨天持续活跃的 session 仍写同一文件（现状代码事实：`createPiSessionLog` 的 date 在创建时求值一次）。
- **效果**：198MB 实证问题收口；取证文件互相挤兑风险消除。

---

**D8：renderer 入站 parse 前置大小守卫（O3-D 补课，防御纵深）**

- **采用**：ws-client 消息处理器在 `JSON.parse` 前检查数据大小（text 帧按 `string.length` code units 计，Blob 帧按 `byteLength`——两种到达形态实施期以实际为主）：**string.length > 40,000,000 code units（≈80MB UTF-16）** 整条丢弃 + console error + 计数上报（经 renderer-log IPC 带 `inbound-frame-dropped` 结构化标记进台账，D1 矩阵已列）。阈值换算论证（按出站守卫的**真实模型**）：守卫度量单位是**整帧 UTF-8 字节**，截断成功的硬条件是「字段替换为 KB 级占位载荷后重测 ≤32MB」（否则 drop）——故合法帧（passthrough 与 replaced 两形态）恒 ≤32MiB UTF-8 字节；UTF-8 字节数 ≥ code units 数，text 帧 `string.length` 恒 ≤ 32M code units。40M 阈值 = 对该上界留 25% 余量 + 覆盖 JSON 转义等实现细节，只拦「显著超界」形态（守卫失效/协议漂移，含守卫零抛错放行的路径——此时哨兵语义仍成立）——响亮失败优于静默 parse 一个巨型字符串（UTF-16 放大 + 对象图再放大，正是 E3 类 OOM 形态）。
  **循环防护（终止阀，三点钉死）**：丢弃 → seq gap → 重订阅全量拉取，若拉取响应同样超界 → 再丢 → 再 gap 的死循环（与 crash-resilience.md（已删，git 可追溯）D3 被否方案④同构的环）。终止阀：**连续 3 次** inbound-frame-dropped 后暂停**该 session** 的自动重订阅——**作用域 = 单 session 订阅隔离**（既有 `resubscribeAll` 是 WS 重连后恢复全部 session 订阅的全局机制，不得暂停它，否则单个坏 session 连坐全部 session 的流恢复）。**恢复触发器 = 用户动作重试**：暂停后用户切走再切回该 session 时重试一次订阅（可判定的用户信号；「对端自行恢复」无观测信号，不承诺）；应用重启是兜底路径。**死态呈现复用既有机制**：不新建第三套死态——session 级静态提示复用 C-proc-16 熔断静态页形态 + D6 导出诊断包入口。台账计数照记——出站守卫失效是该守卫存在的唯一前提，此形态下静默循环不可接受，响亮降级是正解。
- **被否**：「8MB 对齐告警档也拦」——入站侧无截断降级形态（截断的 JSON 不再可 parse），只能丢；丢 8-32MB 区间正常帧会误伤合法大帧（出站守卫允许 ≤32MB 通过）。80MB 只拦「守卫已失效」的形态。
- **效果**：O3-D 承诺的 renderer 本地防线建立；同时它是出站守卫失效的**哨兵**（inbound-frame-dropped 出现 = C-comm-14 被绕过，评估器把它列为高频敏感条件，附录 A #2 关联）。

---

**D9：两个 supersession / 守卫裁决（O3-C + O1-2 补课）**

- **O3-C 截断反转 —— 裁决：被已交付形态 superseded，不实施**。原承诺「六工具白名单反转为默认截断 + 豁免名单」针对的「白名单外工具在 renderer 无界」问题，已被 crash-resilience.md（已删，git 可追溯）u7 交付的 **entryStates 64KB 条目截断**（apply-entry-utils.ts，live/reload 共用同一截断层）结构性覆盖——所有工具的 entry 累积态恒有界。再反转 display 层白名单（truncate-tool-output 4KB 投影）只是显示层一致性收益，引入双截断体系的维护成本。**登记 supersession 而非静默放弃**：对账动作已执行——prevention-deep-dive.md §5 总表 O3-C 行已加注 superseded-by（该文档已删除，git 可追溯；其 O3-C 行注记与本条裁决一致）。
- **O1-2 审计覆盖机器守卫 —— 采用 B 方案（清单完备性检查）而非 AST lint**：新增检查脚本（挂 extensions 三连或 pre-commit）：解析 `stale-ctx-audit.md` **§3 全仓普查清单**（权威表——不是 §2 接入清单）vs `extensions/{taiji,universal,shared}/` **三组目录**的实际包列表——任何新增 extension 包未在普查表出现即红（forcing 新包接入时填写 stale 静默语义判定）。**合并行解析规则**：普查表存在一行多包斜杠分隔的合并行（如「rename-session / msg-id-mapper / …」），按 `/` 拆分后逐一比对。被否 A 方案（taste-lint AST 规则识别「未守卫的异步 ctx 调用」）：过匹配/漏匹配不可靠（回调形态发散：timer/事件/Promise/闭包传递），误报噪音会教人绕过；清单完备性是可机器判定的强不变量，语义判定交回人（普查表）+ 行为兜底交回守卫（guardStaleCtx 已交付）。

### 3.4 探针清单（运行时断言，准则 7）

| # | 断言 | 状态 | 失败降级 |
|---|---|---|---|
| P-A1 | 台账事件在崩溃瞬间落盘（kill -9 runtime 后 main.jsonl 仍有该事件——supervisor 在场性） | 实施期门 | main 侧补记链路重审（在场性论证错 = 架构级返工） |
| P-A2 | marker 补记：强杀 main 进程后下次启动 main.jsonl 出现 `event=crash, reason=unclean-exit` 补记行（unclean-exit 是 reason 值非 event 值——按 reason 找，勿按 event 找） | 实施期门 | marker 生命周期重审（启动写/正常清的竞态） |
| P-A3 | checkpoint reattach × 孤儿收割时序（P9 继承）：制造 live 孤儿 + checkpoint 恢复，无双持；**冷启动高水位断言**：系统模拟高压下新 runtime 启动，reattach 被延迟（即时 memPressure 查询生效，不依赖采样环历史） | 实施期门（真机） | 继承架构 P9 降级：先 reap 后 reattach 强串行化 / 双方集合求交；高压断言失败 = 即时查询挂点错 |
| P-A4 | 滚动重启端到端：临界阈值注入 → 推迟 → 退出码 → supervisor 零退避重启 → reattach → 横幅链 | 实施期门（env 注入阈值，真机） | Gate W 保持不武装（D5 已有该语义——观测继续、兜底不上线） |
| P-A5 | tee 轮转：灌 50MB+ stdout，`.1.gz` 旋段生成（gunzip 可解压、逐行 valid JSON）、主档保全尾部行、退出 flush 走新流 | 实施期门 | 阈值/复刻点形态重审（openPiStreams 引用更新缺失 = flush 丢尾部） |
| P-A6 | 评估器：构造历史台账数据使某条件越线，导出 summary.md 与 WARN 行出现 | 实施期门 | 条件→事件映射重审（附录 A 数据源错位） |
| P-A7 | 入站守卫：注入超界帧，丢弃 + 台账 inbound-frame-dropped + 连续 3 次后转静态错误（终止阀生效） | 实施期门 | 阈值换算重审（误伤合法截断帧 = 余量不足） |

## 4 验收（真实场景，非单测非 mock）

| # | 场景（回溯 §1 目标） | 步骤 | 通过标准 |
|---|---|---|---|
| A1 崩溃归因闭环（G-A） | dev app 长跑中手动 kill 一个 pi（真实 session）→ 触发 respawn → 设置页导出诊断包 | zip 内 summary.md 首屏表格含该 crash + auto-respawn 事件对（时间/sessionId/detailDigest）；台账文件可在 crashes/ 直读 |
| A2 触发条件消费（G-B） | 预置台账数据（构造 frame-truncated 事件序列）→ 导出或等每日巡检 | 状态表 20 条全列出（含 requires-user-report 项的显式标注与 #17 的 Gate W 消费方标注）；构造越线项时 WARN 摘要行 + trigger-review 事件出现 |
| A3 runtime 崩溃自动恢复（G-C） | dev app 三个 session：①刚交互过（idle 3min）②闲置 3h 且 40min 未查看（崩溃前 reaper 下一拍就会回收的形态）③在途 turn——kill -9 runtime | supervisor 重启后：①自动恢复（消息流可用）；②不复活（reattach 过滤 = reaper 回收判定补集）；③恢复且在途丢失有告知（复用既有 restore 提示形态——reattach 对 renderer 呈现为 restore，respawnPending/提示条既有链路覆盖）；台账含 crash→restart→reattach 链。**执行口径（Gate B 2026-09-11，SCALED）**：两处已观察确认偏差——③ 在途丢失无显式告知文案条（A1 的 pi-crash respawn 提示在 reattach 场景不出现，仅中断 turn 静态痕迹）；过滤排除（excluded）路径不写 reattach-skipped 台账事件（appendSkip 只覆盖 staleness/restore-failed/reap-timeout 三 reason）——是否补告知文案待裁决（verdict 表见 impl-plan §6 A3 行） |
| **A3b clean shutdown 冷启动维持 lazy（G-C 反向）** | 正常退出 app（走完整 shutdown）→ 重启 | **零 eager spawn**（进程表无 pi，全部 lazy）；`run/runtime-checkpoint.json` 不存在；对照架构 V3 反向验收① |
| **A3c liveness 强杀 / main 崩溃恢复（G-C）** | dev app 活跃 session：①`kill -STOP <runtime pid>` 造半活（探针 fetch 无显式超时，undici 默认 headersTimeout 300s × 3 次失败阈值——**最坏判死时窗约 10-15 分钟**，AbortSignal.timeout 落地前该用例等待上界按此口径；探针超时收口与 liveness dev 旋钮未随本期落地——Gate B 实测 SIGSTOP 场景判死时窗约 6.3min，在最坏上界内，留待后续）触发强杀重启 ②直接 kill main 进程 → 重启 app | ①checkpoint 未被误删（main 不在 liveness 路径删）、活跃 session 重启后自动恢复、台账含 `unresponsive/liveness-unhealthy` 事件；②marker 残留 → checkpoint 判可信 → stale-kill 旧 runtime → 收割 → 活跃 session reattach；进程表无同 session 双 pi（无双持）；台账含完整事件链 |
| A4 滚动重启计划内路径（G-C，武装后） | env 注入低阈值 + 在途 relay 任务 | 横幅出现（含终端会话预告，执行前 30s 有二次预告）→ 任务完成后重启（supervisor 日志确认零退避零计数）→ session 恢复 → 台账 rolling-restart 事件；强制路径注入硬阈值 → rolling-restart-forced；relay 子进程、sandbox plugin 进程与 plugin sessionData 在重启前后无孤儿/无丢失（退出链完整性）；**进程表无残留 PTY**（终端孤儿检查）；**保活 subagent 反向用例**：存在 Path A 保活（settled 无在途）进程时不触发推迟（`!hasIdleTimer` 谓词生效）；**runtime 日志含完整 shutdown 步骤打点序列**（继承完整性的机械验证）；**横幅终态断言**（重启完成后转「已恢复」30s 自动清除；断连重连后横幅经拉取恢复；**重启完成窗口内重连的横幅消失不重现**）；**推迟链路事件断言**：在途任务存在时推迟路径产生 `rolling-restart-deferred` 事件且携带镜像在途计数字段（在场形态为数字、errs 形态为 null + absent-report——两形态分别注入验证）；**30min 到点路径断言**：经 `XYZ_ROLLING_RESTART_DEFER_LIMIT_MS` 注入短上限（如 30s），任务不完成到点后 forced 事件 `reason=defer-limit` 出现（不靠硬阈值）；**镜像重建断言**：滚动重启→reattach→镜像条目重建（runtime 预置 0 + extension 重载初始上报）→再次触发滚动重启判定**无 errs**（errs 不因 reattach 永久残留——对账机制的行为验证）。**执行口径（Gate B 2026-09-11 首轮）**：FAIL——armed 注入下 rolling-restart 事件与 shutdown 步骤打点前 10 步正常，但退出链挂死在 engine-pool-dispose 前（退出码 86 不可达），被 LivenessMonitor 按 liveness_unhealthy 强杀走崩溃退避路径；Gate W 默认 off 生产休眠，缺陷修复后须复验全部子断言（verdict 表见 impl-plan §6） |
| A5 tee 有界（G-D） | 单 session 持续高流量对话至超 50MB stdout | `pi-*.jsonl` 主档 ≤~50MB + `.1.gz` 旋段存在（gunzip 解压逐行 valid JSON）；尾部最新行完整（现场保全）；正常退出后 tee 尾部行全部落盘（flush 走新流）。**执行口径（Gate B 2026-09-11，SCALED）**：`XYZ_LOG_MAX_BYTES=262144` 注入 256KB 替代 50MB 全量灌入——主档多次轮转保持 ≤~256KB + `.1.gz` 段存在且 gunzip 后全 valid JSON + 任意时刻主档尾部行 valid + 正常退出前后行数一致（同轮次主日志 `runtime-*.log.1` 轮转同证） |
| A6 入站防御（G-D） | 测试钩子注入超界单帧 ×4 | 帧被丢弃、renderer 不崩、台账 inbound-frame-dropped ×4、第 3 次后**该 session** 静态错误提示出现（终止阀单 session 作用域，其余 session 流不受连坐）；用户切走再切回该 session 触发一次重试订阅（恢复触发器）。**执行口径（Gate B 2026-09-11）**：BLOCKED——生产无注入钩子（守卫本体无测试钩子），运行态不可达；单元级覆盖 core 11 + main 9 + renderer 9 用例；renderer 应用级装配（`installInboundFrameGuard` 挂载）随 u-init 收口后可复验 |
| A7 守卫与 supersession（G-D） | `extensions/` 三组任一目录新建空包（临时）跑检查；核对 O3-C supersession 注记（原登记于 prevention-deep-dive.md §5 表，该文档已删除，git 可追溯；注记内容见本文 D9） | 检查红（未在普查表）；O3-C superseded-by 注记在案（本文 D9） |
| **A8 错误风暴限流（G-B 负面行为）** | renderer 注入同签名错误 500 次/min（测试钩子） | renderer-error 文件该分钟 ≤100 行 + 超限合并为一条汇总行（D1 防漏 3 的反向验证——风暴不会压垮 IPC 与磁盘）。**执行口径（Gate B 2026-09-11，替代口径）**：注入判据同样无钩子不可达（限流本体复用 crash-resilience.md（已删，git 可追溯）交付的 100/min 节流 + 同签名去重，有既有单测）——改用 CDP 采集器全程监听剧烈恢复场景（kill pi / kill main / kill runtime / 退出重启），零 console.error 零 exception（仅 2 条启动期 Vue warning）——真实崩溃恢复无错误风暴 |

每场景均回溯 §1：A1/A2/A8→G-A/G-B、A3/A3b/A4→G-C、A5/A6/A7→G-D。全部场景在 dev app + 真实 pi 上执行（对齐 TEST-STRATEGY 真实依赖要求）；A4 阈值注入用 env 旋钮（§5 命名）不 mock 判定逻辑本身。

## 5 下一层拆分

**本章结论**：10 个单元、3 个可独立验收的批次（取证链 → 恢复链 → 武装链）；Gate W 是 E5b/c 的武装门；新增约束 5 条 + 文档同步义务。

| 批次 | 单元 | 内容 | 验收对应 | justification |
|---|---|---|---|---|
| 一（取证链） | u1 | 台账 writer 双文件 + schema + 多段轮转（runtime 侧 + main 侧）+ 写入点矩阵接线（含 marker、deleted 挂 removeSessionEntry、reclaimed/reaped、frame-truncated/registry-miss/watermark-daily）+ 风暴限流复用 | A1/A8 | E1 是其余一切的数据基础；writer 先行让后续单元的事件随做随记 |
| | u2 | 评估器纯函数 + 每日巡检 + 附录 A 清单落地 | A2 | 暗债根修优先于出口（导出只是它的第二个消费者） |
| | u3 | 诊断导出（设置页 + 死态页入口 + zip + summary.md + 知情提示） | A1/A2 | 用户出口收尾取证链 |
| 二（恢复链） | u4 | checkpoint 持续维护 + 启动可信度判定（marker 复用）+ reaper tick 刷新搭车 + **main 侧属主**（app 退出链删除【挂 before-quit 专属 await 链成功段，stop() reject/killed 短路跳过】+ marker 启动写/正常退清——落 `apps/electron/main/main.ts`）+ **残留隔离 rename 的同域失败幂等处理（ENOENT 视为已隔离 / EACCES 原地残留静默，见 D3 降级声明）** | A3 前半 / A3b | E5a 无条件档；先有 checkpoint 才谈恢复；main 侧删除属主在此落地 |
| | u5 | reattach 编排（收割 promise 暴露 + 高水位延迟【即时系统级查询，不依赖 u6 采样环】+ 真补集过滤【occupancy/backgroundTasks/relayChildren 三长时豁免 + idle/viewed】+ 分批容错 + staleness guard + listen 后独立并行挂点） | A3 | 恢复语义核心；与 reaper/抑制通道的咬合裁决在此落地 |
| 三（武装链，代码完整交付） | u6 | 看门狗 60s 采样环 + 两级阈值 + memory-relief 降级（含 renderer LRU 通知通道） | A4 前半 | 观测先行——即使永不武装，采样环补全水位数据 |
| | u7 | 滚动重启执行链（完整 shutdown 序逐行继承 + **shutdown 步骤打点**（A4 机械验证继承完整性）+ 引擎 dispose 步骤【server.stop 后 closeLogger 前】+ 推迟判定源【**pi 侧 extension 聚合上报通道 + `hasLiveProcessHandle && !hasIdleTimer` 谓词（覆盖 pi 引擎与 relay 两形态；zcode 侧快照面已删 2026-09-13 oe-audit，见 §3.3 D5）**】/硬升级/退出码/supervisor planned 分支/app 级 shutdown 取消推迟状态机/**滚动重启状态只读查询 RPC + T-30s 二次预告 + 终端会话预告横幅（持续态拉取恢复）**） | A4 | 与 u6 同批但武装互斥（见 Gate W） |
| | u8 | Gate W 复审（水位数据 + V6 结论 → 校准阈值 + 降级反弹校准 + 武装裁决） | — | 把架构的条件缓建条款变成有触发条件的执行动作 |
| 补课 | u9 | tee size 轮转（含 pi-relay、openPiStreams 复刻点）+ logger.ts 裁决推翻登记 | A5 | 独立零依赖，可先行 |
| | u10 | 入站 parse 守卫（含终止阀）+ 审计覆盖检查（三组目录）+ O3-C supersession 注记 | A6/A7 | 三个小守卫一批 |

**文件改动地图**：新增 `packages/runtime/src/infra/crash-journal.ts`（writer + 轮转）、`packages/shared/src/crash-journal-schema.ts`（schema 与 event 枚举 SSOT）、main 侧 `apps/electron/main/logs/crash-journal.ts`（双胞胎 writer）、`apps/electron/main/diagnostics/export-diagnostic-bundle.ts`（zip 打包）、评估器纯函数模块、`packages/runtime/src/services/session/runtime-checkpoint.ts`（持续维护）、看门狗模块（含 **memPressure 即时系统级查询共享模块——u5 交付、u7 消费**）；改写：`session-service.ts` / `pi-respawn.ts` / `reap-orphan-pi.ts` / `idle-pi-reaper.ts`（台账写入点 + tick 刷新搭车）、`startup-background-init.ts`（收割 promise 暴露）、`runtime-supervisor.ts` + `restart-policy.ts`（planned 分支）、index.ts shutdown 序（引擎池 dispose 步骤）、出站守卫判定点（frame-truncated/registry-miss 事件）、水位定时器（watermark-daily）、`logger.ts`（tee 轮转）、`ws-client`（入站守卫 + 终止阀）、设置页系统分区 + 死态页（导出入口）、`apps/electron/main/main.ts`（app 退出链：checkpoint 删除（成功段）+ marker 清除（will-quit））、`extensions/universal/subagent-workflow/`（聚合上报出口，过 extensions 三连校验）、`packages/subagent-core/`（core→壳事件出口，core 闭包红线内）、`@xyz-agent/extension-protocol`（新 marker 常量 + 上报 schema SSOT，SESSION_MANAGER_MARKER 同款惯例）、`packages/runtime/src/infra/pi/event-adapter.ts`（marker 路由分支，不广播前端）、runtime 侧在途镜像模块（新）、`packages/shared/src/protocol.ts`（rollingRestart.status 请求/响应联合，RequestMap/ResponseMap 先例）、renderer 横幅组件 + composable + i18n 双 key（滚动重启编排模块并入看门狗模块）。
**env 旋钮命名（钉死 `XYZ_` 前缀——ENV_WHITELIST_PREFIXES 只放行 XYZ_ 前缀进打包版 runtime，对齐 idle D4 先例）**：`XYZ_RUNTIME_WATCHDOG_ARMED / _WARN_PCT / _CRIT_PCT / _FORCE_PCT / _SAMPLE_MS`（E5b/c）+ `XYZ_ROLLING_RESTART_DEFER_LIMIT_MS`（推迟上限——A4 注入短上限端到端验证 defer-limit 到点路径与 stale-high 观测面，对齐 idle D4 旋钮先例）+ `XYZ_LOG_MAX_BYTES`（主日志与 pi tee 共用的 size 轮转阈值单旋钮，D7/Gate B A5 scaled 注入用）；reattach 过滤只读 reaper 既有常量（shared constants SSOT），不另开旋钮；A4 验收注入同前缀。liveness 探针的超时收口（AbortSignal.timeout）与对应 dev 旋钮未随本期交付（A3c 执行口径按默认时窗），旋钮化留待后续——未实施前不占 env 命名。
**清理声明**：台账与 checkpoint 自带生命周期（10MB×3 段轮转 / **main 侧 app 退出链删除** + checkpoint-failed 保留最近 3 份新失败覆盖最旧），**不修改 cleanExpiredLogs 与 log-retention 的「跳过目录」现状语义**（它保护非日志产物）；诊断 zip 用户自管。
**checkpoint 五契约**（名对齐架构 D3 原文「风暴防护与收割时序」全条）：**删除属主双轨**——main 侧在 app 退出链删除（确认 runtime 死亡后；liveness 强杀重启与滚动重启都不删）/ 新 runtime reattach 编排在全部尝试完后删（**runtime 自身任何退出路径一律不删**——「app 级识别信号」不存在，见 D5 退出链论证）；staleness guard（reattach 前校验文件存在）/ 完整性降级（tmp+rename，解析失败记 checkpoint-corrupt 退 lazy）/ 失败现场（checkpoint-failed-\<ts\> 保留最近 3 份）/ **风暴防护与收割时序（分批并发 2 + 高水位延迟【即时系统级查询，冷启动不空转】+ live 孤儿必须等收割后再 spawn）**。
**待验证检查点**：退出码 86 的跨平台/信号语义冲突核对；zcode appserver、sandbox plugin fork、忽略 SIGHUP 的终端命令**三者意外孤儿**（无 shutdown 机会）的 reap 判据扩展可行性；reattach 并发上限的 spawn 峰值实测（2 起步）；memPressure 即时系统级查询的实现层（os 级 swap/空闲内存的跨平台 API 差异）；收割等待上界（ps 10s + 每孤儿 2s）实测。
**约束登记义务**（对齐 crash-resilience.md（已删，git 可追溯）§5 先例，五项随交付登记 constraints.json）：① 台账双文件 schema 与写入点矩阵；② checkpoint 五契约；③ 滚动重启退出码与 supervisor planned 分支语义；④ 入站 parse 守卫（C-comm-14 的对偶：80MB 阈值 + 哨兵语义 + 连续 3 次终止阀）；⑤ tee 段文件 `pi-` 前缀不变量（架构 D6③）。**文档同步义务**：AGENTS.md 关键规则（runtime 生命周期新机制条目）、`docs/feature-map/` 更新、TEST-STRATEGY / docs-testing 同步、**EnginePort 扩展的权威源同步（`docs/architecture/subagent-engine-protocolization.md`（原 subagent-engine-abstraction.md 已删，git 可追溯）+ port.ts 扩展登记注释——port.ts 头部纪律：字段级变更须先改设计文档）**、subagent-core core→壳事件出口的设计文档同步、renderer i18n 双 key——对齐 crash-resilience.md（已删，git 可追溯）§5 实施期义务先例。

## 附录 A：重审触发条件汇总（评估器的条件清单 SSOT，20 条）

| # | 条件 | 来源 | 评估形态（数据源全部在台账） |
|---|---|---|---|
| 1 | 出站截断告警周均 >10 次 | crash-resilience.md（已删，git 可追溯）§3.3 D3 代价 A | frame-truncated（reason=warn-tier）事件窗口计数 |
| 2 | 出站注册表 miss（任何一次） | 同上 D3 代价 B | registry-miss 事件出现即 tripped；inbound-frame-dropped 关联佐证 |
| 3 | supervisor 重启频率显著上升 | 同上 D7 代价 B | main.jsonl runtime-crash 窗口计数 |
| 4 | 回收态存量致水位长期不回落 | idle-pi-reclamation.md（已删除，git 可追溯）代价声明 1 | watermark-daily 趋势（coverage <50% 的日降权标注——滚动重启的水位重置会掩盖不回落形态；明细 5min 行在日志供深查） |
| 5 | base64 证明为主要压力源（水位归因） | crash-resilience.md（已删，git 可追溯）v9 两步走 | 人工归因型（watermark-daily 数据就绪标注） |
| 6 | 活跃态 Trace 降级重审 | crash-resilience.md（已删，git 可追溯）§3.4 | requires-user-report |
| 7 | auto-respawn 周均 >5 次 | architecture D2 代价 | auto-respawn 事件窗口计数 |
| 8 | 滚动重启 >周 1 / 推迟月均 >10 / forced 月均 >3 / defer-limit 占 forced >30%（stale-high 假推迟占比——排除 reason=absent-report 形态后计） | architecture D3 代价 + 本文 D5 缺席语义⑤ | rolling-restart / rolling-restart-deferred / rolling-restart-forced 事件计数与 reason 分类（武装后生效） |
| 9 | renderer reload 月均 >4 | architecture D4 代价 | main.jsonl reload 事件计数 |
| 10 | 第三方扩展崩溃月均 >2 | architecture D5 代价 | crash 事件 reason 分类计数 |
| 11 | 白屏但两侧日志无记录 → crashReporter 立项 | crash-resilience.md（已删，git 可追溯）D2 代价 A | requires-user-report |
| 12 | reload 丢草稿反馈 → 草稿持久化立项 | 同上 D2 代价 B | requires-user-report |
| 13 | live/reload 大文本可见差异反馈 | 同上 D3 代价 C | requires-user-report |
| 14 | 「加载更早」翻页高频抱怨 | 同上 D4 | requires-user-report |
| 15 | Trace 首个真实命中 / cache size 帽占位真实出现 | 同上 D5/D6 | requires-user-report |
| 16 | E2 型连坐复发 → dev/prod 隔离升级立项（datadir pin 已在 main 缩小残余面） | 同上 D6 代价 | 同秒多 SIGTERM 形态检测（窗口内 ≥3 session 同秒 exit 且非计划内——计划内以 destroyAll/destroySession **杀链发起事件**（D1 矩阵 shutdown 行挂点，连坐死亡的 pi 侧事件同样产自发起处）时间窗关联排除 |
| 17 | 降级反弹：memory-relief 执行后 10min 内水位不降反升 >5% 的比例周均 >30% → 降级清单重审 | 本文 D4 降级代价 | **消费方 = Gate W（u8）人工复审**（判据需 memory-relief 前后水位对比——60s 采样环内存态不落台账，评估器不可算；水位 5min 明细行在 runtime 日志供人工深查） |
| 18 | 漏推迟首案例：滚动重启时有在途但未推迟（在途被杀） → 升级低频全量快照对账 | 本文 D5 缺席语义⑤偏低方向 | requires-user-report（漏推迟形态 = deferred 缺席，台账无「应有而未defer」的直接信号——用户报告在途任务被杀后按台账滚动重启时序人工归因） |
| 19 | 终端终止抱怨随滚动重启出现 → 「PTY 独立存活（setsid）」立项评估 | 本文 D5 家族表 terminal PTY 行 | requires-user-report |
| 20 | 用户反馈需要脱敏版诊断导出 → 可选项评估 | 本文 D6 隐私判定 | requires-user-report |

## 附录 B：与架构文档的形态对账（本文承接时显式修订的三处）

| 架构原文 | 已交付现实 | 本文裁决 |
|---|---|---|
| D2 respawn 1s/4s/16s 退避 + 3 次熔断 + intentional-kill 集合四契约 | crash-resilience.md（已删，git 可追溯）交付 5s 延迟 + 2 次熔断 + Map 存在性抑制（意图等价，process-manager.ts 源码实证） | 台账与滚动重启按已交付形态咬合；架构 D2 增量（OOM 分类差异化等）留在 E3 增量清单 |
| D4 renderer 5min/3 次 reload 熔断 | 交付 60s/3 次（C-proc-16） | 按已交付形态记录事件 |
| E5「依水位数据裁剪甚至缓建」条款 | 水位打点多日无人回头裁决 | 转化为设计内 Gate W（u8），有触发条件有产物 |

## 附录 C：版本与审查记录

- v1（2026-09-11）：初版。双审并行：主审 5 must-fix / 5 suggestion，影响面审 2 must-fix / 8 suggestion。
- v2（2026-09-11）：一轮全修（7 must-fix + 13 suggestion 全部当轮清偿，无遗留）。要点：D1 条件信号事件化（frame-truncated/registry-miss/watermark-daily，评估器输入闭合）+ deleted 写入点改挂 removeSessionEntry 汇聚点（抑制语义下 onSessionExit 永不产生该事件）；D3 reattach 过滤改 reaper 补集语义（30min 是 viewed 豁免窗非 idle 阈值）+ errs-safe 方向修正（偏漏恢复）+ 高水位延迟承接（架构风暴防护全条）+ 收割 promise 暴露；D5 退出链改完整 shutdown 序继承 + 子进程家族清单（zcode appserver 现状漏处置显式收编）；D8 阈值换算修正（40M code units，防误伤合法截断帧）+ 连续 3 次终止阀；D4 降级代价四要素 + 降级反弹风险；D6 隐私判定；D9 检查范围扩 shared + 权威表指定；验收增 A3b（clean shutdown 维持 lazy）与 A8（风暴限流负面行为）；探针表补失败降级列；约束义务 3→5 + 文档同步义务；env 旋钮钉死 XYZ_ 前缀；清理声明修正（不纳管白名单，自洽于「跳过目录」现状）。
- v3（2026-09-11）：二轮全修（主审 5 must-fix / 4 suggestion + 影响面 4 must-fix / 3 suggestion，全部当轮清偿）。要点：**checkpoint 删除时机双轨**（app 级退出删 / runtime 级滚动重启 planned 路径保留——修复 v2 引入的「A4 要恢复 vs A3b 要删除」方案级自相矛盾）；reattach 过滤扩为**真补集**（补 #2 backgroundTasks / #3 relayChildren 两长时豁免 + checkpoint 快照布尔；术语澄清 occupancy ≠ ReclaimSeat 占座）+ hidden 公共 session 同源纳入；高水位延迟改**即时系统级查询**（不依赖 D4 采样环——修批次依赖倒置与冷启动空转）+ reattach 编排挂点（listen 后独立并行）；D5 推迟判定源扩「relay ∪ 引擎池在途」+ 家族表补 terminal PTY（终端随重启终止的代价声明）+ sandbox plugin fork 拆行 + 引擎 dispose 挂点（server.stop 后 closeLogger 前）+ 继承步骤补三项非进程步骤与「以 index.ts 为准逐行继承」规则 + 退出链时长入代价；D8 阈值论证按出站守卫真实模型重写（整帧 UTF-8 字节重测上限 → code units ≤32M 恒成立，40M = 25% 余量）+ 终止阀三点钉死（单 session 作用域 / 用户动作重试触发器 / 复用既有死态）；watermark-daily 自然日窗口 + coverage 戳（评估器降权，滚动重启掩盖「不回落」形态的判别）+ oom/shutdown 矩阵行（枚举无孤儿值）+ #16 计划内排除依据；场景三时长改 10-20s（收割链量级对齐）；A4 补 PTY 检查、A6 改单 session 作用域 + 重试触发器；P-A3 补冷启动高压断言；待验证检查点扩三类意外孤儿 reap 判据。
- v4（2026-09-11）：三轮全修（主审 2 must-fix / 4 suggestion + 影响面 1 must-fix / 2 suggestion，全部当轮清偿）。要点：**checkpoint 删除属主改 main 侧**（runtime 的 shutdown 序被 SIGINT/SIGTERM/uncaughtException 三源共用、app 级退出与 liveness 强杀共用 supervisor 同一杀链——「app 级识别信号」不存在，v3 的 planned 跳过删除分支会让 uncaughtException 自删恢复依据；runtime 任何退出路径一律不删，删除属主 = main app 退出链 + 新 runtime reattach 编排）；**pi 计划内 SIGTERM 事件挂点改杀链发起处**（destroySession 先删 Map 使 exit handler 静默跳过——挂 exit handler 事件永不产生，与 deleted 行同机理）；推迟判定谓词钉死（pi 侧 `hasLiveProcessHandle && !isIdle` 双谓词防 Path A 保活恒真；zcode 侧登记 EnginePort 新增只读快照面——「复用既有能力」经核实不成立）；快照布尔反向形态诚实声明（多恢复自收敛 vs 公式错误的排查口径）；T-30s 二次预告（覆盖推迟期内新开终端）；shutdown 步骤打点（A4 机械验证继承完整性）+ app 级 shutdown 取消推迟状态机；oom 行 pi/runtime 层归因声明（SIGKILL 不可区分，保守归 crash + #10 偏差已接受）；场景二横幅口径拆分（任务等待不可预估/重启执行 30-60s）；memPressure 共享模块归属（u5 交付 u7 消费）。
- v5（2026-09-11）：四轮全修（主审 2 must-fix / 3 suggestion + 影响面 2 must-fix / 2 suggestion，全部当轮清偿）。要点：**D1 shutdown 行补 runtime 自身事件的三挂点**（信号同源不可区分的洞察传导：app 级退出由 main 在 before-quit 写、planned 由 main 按退出码 86 写、异常死亡按 stopping 上下文记 crash——runtime 序不写 shutdown，防 liveness 强杀/uncaught 被误记计划内污染 #3/#16）；**推迟判定补跨进程通道**（pi 侧谓词的求值位置 = pi 进程内：extension 聚合上报 delta 事件经 select 通道、runtime 镜像非 idle 句柄数，同时覆盖 pi 引擎与 relay 两形态——「先例可复用的是语义不是执行环境」；失败兜底 errs 推迟（有界等待无持久退化）；zcode 侧钉可选成员 `inFlightSnapshot?` + pi 不实现的缺省语义）；**滚动重启状态改可拉取**（只读查询 RPC + renderer 重连/刷新拉取恢复横幅——遵守「broadcast 时序竞争」教训，T-30s 广播降级为加速显示；横幅复用 CrashRecoveredBar 视觉形态不复用一次性语义）；**删除实现语义钉死**（before-quit 专属 await 链成功段确认 child exit 后执行，reject/killed 短路跳过交 D3 兜底，不得挂 stop() 内部）；u4 扩 main 侧属主 + 文件改动地图补 main.ts；导航列举补「取消推迟定时器（新增）」；main 崩溃恢复路径声明 + A3c 验收（liveness 强杀/main 崩溃两形态）；文档同步义务补 EnginePort 权威源（subagent-engine-abstraction.md §3.3.5 + port.ts 注释纪律）。
- v6（2026-09-11）：五轮全修（主审 1 must-fix / 4 suggestion + 影响面 2 must-fix / 5 suggestion，全部当轮清偿）。要点：**D1 补第四挂点**（liveness 强杀在 forceRestartForLiveness 与 kill decision 同点双写 event=unresponsive/reason=liveness-unhealthy——其 exit 落 stopping 早退分支无行可写；第三挂点判别式显式化「非 before-quit 且 ≠86 且 stopping=false」；app 退出的 stopping 分支不写行——stopping 被 stop() 全部调用方置位，按 stopping 写 crash 会记假 crash 污染 #3）；**marker 清除与 checkpoint 删除解耦**（marker = 「main 存活」语义挂 will-quit 无条件清——否则非 darwin killed 短路同时跳过两者，marker 残留误判 unclean 走 eager 违反 A3b）；**D3 残留分支改「忽略并删除」**（消灭陈旧清单 × 后续真 unclean 误配对）；**上报改绝对计数 + 缺席语义收敛**（每条携带绝对计数非增量；extension 可用性判定——禁用 ⇒ 无在途是正确语义非 errs，防恒等 30min；镜像挂 session 生命周期对账消灭 stale-high 残留；「有活 pi 但从未收到上报」errs 推迟；残余风险 + 重审触发显式登记；接线三约束：不阻塞 agent_settled 链 / core 闭包红线出口在壳层 / marker 路由不广播前端）；横幅终态钉死（reattach 完成事件承接转绿 30s 清除 + 窗口级互斥 + i18n 义务）；A3c 注入手段（kill -STOP + 判死时窗口径 + LivenessMonitor AbortSignal.timeout/dev 旋钮）；A4 补横幅终态断言；文件改动地图补 extension-protocol/event-adapter/在途镜像/protocol.ts/renderer 横幅等 8 处；谓词命名统一 `!hasIdleTimer`。
- v7（2026-09-11）：六轮全修（主审 1 must-fix / 1 suggestion + 影响面 3 must-fix / 1 suggestion，全部当轮清偿）。要点：**errs 判别域补初始上报**（extension 在 session 就绪时上报 count=0——否则「从未收到上报」含常态无 subagent session，errs 规则把每次滚动重启推满 30min，必现级兜底变常态）；**可用性判定改 per-session 事实**（runtime spawn 时刻的注入列表 getExtensionPaths——全局快照在 mid-session 禁用窗口会误杀在途：disabled-packages.json 是「下次 spawn 生效」语义）；**D3 残留分支改「隔离」**（删除失败重命名进 checkpoint-failed 家族——文件存在就可能被后续真 unclean 误配对，重命名使配对不可能；best-effort 不阻塞启动、重复失败不重复记事件）；**补 rolling-restart-deferred 事件**（推迟开始记一条、携带镜像在途计数——附录 A #8「推迟月均 >10」子句的数据源 + stale-high 观测面）；**30min 到点强制执行记 forced（reason=defer-limit）**与硬阈值区分；**残余风险双向登记**（偏低：漏推迟首案例升级；偏高：defer-limit 占 forced >30% 升级全量快照对账——对称触发）；横幅终态形态分叉（在线见绿确认 / 断连重连见消失）；A3c 判死时窗改最坏 10-15 分钟口径（undici 300s × 3）；marker 启动写时点钉单实例锁后。
- v8（2026-09-11）：七轮收尾，**双审 0 must-fix 终止**（主审 0 M / 3 S / 1 INFO + 影响面 0 M / 2 S，双报告显式判定「设计就绪」，全部 suggestion + INFO 当轮清偿）。要点：**event 枚举删 unclean-exit 孤儿值**（实际生产形态 = event=crash + reason=unclean-exit，枚举内无生产者；P-A2 探针措辞同步按 reason 找）；**附录 A 16→20 条**（v3-v7 新增触发回流 SSOT：#8 扩第四子句 defer-limit 占 forced >30%【机器可判，排除 absent-report 形态】；#17 降级反弹——判据在采样环内存态不落台账，消费方 = Gate W 人工复审、评估器恒 no-data 但入清单；#18 漏推迟首案例 / #19 终端终止抱怨 / #20 脱敏反馈按 requires-user-report 先例入清单；计数 6 处同步 + 正文四处回流标注闭环）；**errs 形态 deferred 字段语义钉死**（镜像计数取 null 非 0 + reason=absent-report 独立标记；评估器 #8 占比子句分子排除 absent-report——errs 推迟是旧版兼容形态，混入会把上报链路问题误读为 stale-high 镜像漂移；absent-report 月均 >2 再评估上报链路加固）；**初始上报触发时点钉死**（extension 加载完成，不挂懒触发）+ **镜像条目完整事件集 = 初始上报 ∪ 五种 spawn 形态（新 session/respawn/reattach/lazy restore/fork）runtime 预置 0**（互不依赖：runtime 置 0 是本地真值不依赖上报到达，初始上报独立重试服务下次 errs 判别）；**rename 同域失败降级声明**（ENOENT = 并发删除视为已隔离 / EACCES = 权限同源原地残留幂等静默；收敛双通道 = 下次启动重试隔离 + 后续 unclean 覆写接管；复合误配对窗口 errs-safe 有界——最坏多恢复一个可自收敛 session，非数据损坏）；**A4 补三断言**（推迟链路事件在场/errs 两形态字段分别验证 / defer-limit 到点经旋钮注入短上限端到端验证 / 滚动重启→reattach→镜像重建→再次判定无 errs）+ §5 旋钮清单增 `XYZ_ROLLING_RESTART_DEFER_LIMIT_MS` + u4 补 rename 幂等实施注意。
- v9（2026-09-12）：**阶段 6 design-code-sync（交付现实回写，全部为文档措辞对齐、零设计裁决变更）**。要点：**D7 旋段形态改写**（`.1.gz` gzip 单代 + `XYZ_LOG_MAX_BYTES` 单旋钮——dev-0.9.17 合并裁决回写；初版 `.1` 平面实现与打开时预滚的被取代事实落交付偏差注记两则）；**D1 矩阵对齐交付**（reaped 判据 v2 marker 化【spawn marker 清单 + argv + ppid=1】/ deleted 行号锚定 session-service.ts:1191 / reattach-skipped 拆双落点【runtime 编排三类 skip + main 侧冷启动残留隔离】/ shutdown 行补 `runtime.isRunning` 在场性 guard——偏差 #17 措辞回写）；**D3 补可信度判定 main 侧实施分工**（consumeResidualRunMarker → resolveColdStartTrust → isolateStaleCheckpoint，runtime 编排只消费 trusted-unclean）；**D4 补 LRU 已交付形态**（useMemoryPressure 可注入收紧动作 + core setLruMaxSessions 可变窗——偏差 #28②）；**D5 补引擎池 dispose 打点占位注记**（runtime 注册表恒空、实际杀链经 pi 侧 extension 收割钩子——偏差 #29，Gate B A4 挂死排查锚点）；**§4 补执行口径注记不删原判据**（A4 首轮 FAIL 退出链挂死复验中 / A5 SCALED 256KB / A6 BLOCKED 无注入钩子 / A8 CDP 替代口径；A3c 探针超时收口未落地事实化）；**§5 env 清单**补 `XYZ_LOG_MAX_BYTES`、移除未实施的 liveness 旋钮占位；**约束引用对齐登记面现状**（renderer 熔断 C-proc-12→C-proc-16、stale ctx 守卫 C-pi-15→C-pi-16——v5 合并对侧重写 constraints.json 致编号撞车与三条登记丢失【原 C-comm-14 出站守卫 / 原 C-pi-15 stale ctx / C-state-12】，恢复登记见 constraints.json 同批变更）；**§5 约束登记义务五项兑现**（台账双文件与写入点矩阵 / checkpoint 五契约 / 滚动重启退出码与 planned 分支及推迟有界 / 入站 parse 守卫 / tee `pi-` 前缀与 gzip 单代有界轮转）+ 看门狗武装门控默认 off + reap 判据 v2 marker 化，同批登记 constraints.json（C-data-20 / C-proc-17~20 / C-comm-15 / C-build-08）。
- v10（2026-09-13）：文档整合 Batch 4-I1——吸收 crash-resilience.md（v11）独有档案为新附录 D，该文档与 crash-resilience.impl-plan.md 删除（git 可追溯），正文引用逐处挂溯源标注。
- v11（2026-09-13）：**D5 在途上报通道 oe-audit 坍缩（裸 TUI 闪框事故触发）**。审计报告 `.tmp/over-engineering-audit/over-engineering-audit-20260913-095736.md`（用户裁决全量执行）。要点：**送达可靠层立论改写**（原「旧版 extension/runtime 版本错配」被同 bundle 发布 + pi 随 runtime 退出销毁两条事实证伪——erss 兜底对象收敛为 reporter 放弃/通道结构性故障，缺席语义②④ 同步改写）；**重试改有界**（初始上报失败重试「直至成功一次」→ 累计 30 次放弃，对齐 plugin-bridge MAX_SYNC_ATTEMPTS 形态；60s 窗口覆盖 R2 attach 竞态，放弃走 absent-report errs 推迟）；**mode 门控**（inflight-reporter 与 plugin-bridge 的 marker-select 通道仅 rpc 模式启动——裸 pi TUI 下 marker select 无拦截方弹真框，2026-09-12 无限闪框事故根因；ask-user `ctx.mode === "rpc"` 二值判定同款先例，plugin-bridge 门控点收敛在 callBridge 入口兼覆盖 observe 转发）；**协议面坍缩**（删 `kind: initial/delta` 死字段——runtime 侧 applyReport 不读、reporter 自认等价，连同 INFLIGHT_REPORT_KINDS / InFlightReportKind / initialAcked 状态机 / isSubagentInFlightReport 的 kind 值域分支）；**死代码清除**（inflight-mirror.resetFor 孪生方法——与 presetZero 逐字同款且生产零调用；lastReportAt 死字段——生产零读者；InFlightListener 死参数——签名改无参）；**引擎槽删除**（EnginePort.inFlightSnapshot? 四段零调用链：port 可选成员 + zcode 实现 + rolling-restart 注入槽 + 求值分支 + zcode-engine-inflight.test，见 §3.3 D5 zcode 侧注记）。估算净删 ~150 行 + 1 协议常量 + 2 API + 1 状态机。**A4 验收影响注记**：镜像重建断言（reattach 后 extension 重载初始上报）行为不变——mode 门控不影响 rpc 模式（runtime 恒 rpc spawn），有界重试不影响正常路径（attach 竞态毫秒级自愈远早于 60s 窗口）。

## 附录 D：崩溃韧性防线档案（迁自 crash-resilience.md，该文档已删除 git 可追溯）

> **迁移声明（2026-09-13 文档整合）**：crash-resilience.md（v11，371 行，「崩溃韧性：Taiji.app 中短期崩溃防治技术方案」）的五道防线已全部交付（13 单元，双 Gate 绿 + design-code-sync 收敛），其正文 D1-D7 决策、探针清单、验收记录、单元拆分属过程内容不迁，本附录只收独有档案（防线框架 / 错误规格表 / 崩溃证据增量 / 数据流档案 / 术语锚定）。该文档与 crash-resilience.impl-plan.md 均已删除，git 可追溯；本附录及正文引用的「impl-plan 偏差 Dx」「u 系单元号」「T 系场景号（T4 = pi 崩溃自动恢复场景）」均指该文档族。触发条件的运行时机器实装（常量与文案）见 `apps/electron/main/diagnostics/trigger-evaluator.ts`（与附录 A 编号一一对应）。

### D.1 五道防线框架（交付形态总览）

原文按崩溃面设五道防线，与本文 §1.1 按进程层组织的已交付防线表视角互补：

| 防线 | 原决策 | 消灭的崩溃面 | 现役锚点 |
|---|---|---|---|
| ① extension 异步回调守卫 | D1 | stale ctx 异步回调炸死 pi 进程（9/3 实锤） | `extensions/shared/ext-guards` guardStaleCtx（接入终态 SSOT = stale-ctx-audit.md §2；C-pi-17） |
| ② renderer 错误边界 + 自动恢复 | D2 | renderer 白屏无痕、崩溃 reload 循环 | `window-factory.ts` render-process-gone 链 + `recovery-policy.ts` 熔断（C-proc-16）+ renderer-log 落盘 |
| ③ server→client 传输预算（含历史治理面） | D3/D4/D5 | 出站巨帧打穿 renderer；大历史加载/传输/附着无界（字节预算、分页协议、全量读预检） | `outbound-frame-registry.ts` 穷举表（SSOT）+ guardOutboundPushFrame（C-comm-14）；预算化读取与游标分页在 runtime session 链 |
| ④ 内存观测与取证打点 | D6 | 崩溃取证盲区、内存无水位、日志清理只在启动跑一次 | main/runtime 水位 5min 打点 + `log-retention.ts` 每日复扫 + pi-crash 上下文头 + 杀链决策日志 |
| ⑤ pi 崩溃自动恢复 | D7 | session 无声死亡、恢复不可见 | `pi-respawn.ts`（5s 延迟 + 连续 2 次熔断 + join 语义）；本文 D1 台账承接其事件 |

### D.2 错误规格表（每个失败给出路）

原文 §3.4 整表迁入，行为均为现役交付形态；runtime 整机死亡与 renderer 进程死亡的恢复链细节见本文 D1 写入点矩阵与附录 B 对账。

| 失败 | 检测点 | 用户所见 | 恢复指引 |
|---|---|---|---|
| extension 回调 stale ctx | ext-guards 守卫 catch | 无感知（对话照常） | 无需恢复；debug 日志供排查 |
| extension 回调非 stale 错误 | 守卫原样上抛 → pi 崩溃链路 | T4 恢复提示条 | 自动 respawn；反复失败 → 提示重试/新建会话 |
| renderer JS 渲染错误 | errorHandler/onerror | 不白屏；错误现场自动落盘（renderer-error log），App 其余功能可用 | 日志自动落盘；影响持续 → 重启窗口 |
| renderer 进程死亡 | main render-process-gone | 1s 内自动 reload + 恢复提示条 | 60s 滑窗内前 3 次自动 reload、第 4 次熔断 → 静态错误页：「请重启应用，日志在 ~/.xyz-agent/logs/」 |
| 出站 reply 超 32MB | 出站帧守卫（reply 通路=message-broker.reply 内联） | 错误提示「内容过大无法传输」 | 提示含「加载更早」分页入口与 session 文件路径 |
| 出站 push 超 32MB | 出站帧守卫（push 通路=guardOutboundPushFrame@publish 入口，契约保持式截断；实现为 seq 预写 + drop 时 rollbackSeq，可观察等价于 seq 分配前判定——见 impl-plan 偏差 D2） | 该条消息显示占位文案，其余消息照常 | 占位文案含 session 文件路径 |
| push 注册表 miss / 截断后仍超限（病态兜底） | publish 入口兜底整条丢弃 + rollbackSeq 回滚（**miss 不占 seq**，等价于 seq 分配前丢弃） | 该条消息不出现 | error 日志含消息类型与体积 → 补注册表后同类消息恢复；8MB 告警档前置暴露 miss |
| 历史文件超 32MB | statSync 预检 | 最近窗口正常显示 + truncated 标记 | 「加载更早」翻页；Trace 视图降级为「文件过大，源文件：<路径>」（④档降级文案在离线/file 通路生效；**活跃态** Trace 走 RPC get_entries 通路，超限被 reply 守卫拦截为错误 envelope——错误提示同样携带路径指引；活跃态协议级降级为已知限制，挂数据驱动重审） |
| restore 附着超 32MB（最小规范化） | statSync 预检（⑤档） | 尾部 session_end 被流式 strip、首行 cwd 死路径被 fallback 修复 → session 正常附着可用（失忆防由 strip 保证、cwd 防由首行修复保证）；显式失败仅在文件头损坏等极端形态触发 | cwd 死路径的根治：在原 worktree 路径重建目录（推荐）；或手工编辑 session 文件首行 header 的 cwd 字段指向现存目录——**pi 按 header 的 cwd 判定而非文件所在目录，只移动文件不改 header 无效** |
| pi 进程死亡 | ProcessManager onSessionExit 链 | T4 恢复提示条（含在途回合与后台任务丢失说明） | 自动 respawn（5s 延迟，2 次熔断）→ 手动重试按钮 |
| pi 恢复后 subagent/后台任务缺失 | 崩溃时已连坐终止（relay kill/reap） | T4 提示条明示「不会自动恢复」 | 用户重新发起子代理/后台任务 |
| 用户手动强制退出 session | forceQuitSession（不经 onSessionExit） | 现状 UI（dead 标记） | 不自动恢复（设计意图）；下次交互（点击 session 即惰性附着恢复，实测口径） |
| runtime 整机死亡 | supervisor（既有） | 「重启中…」过渡屏（既有） | 退避重启（既有）；5 次用尽 → 手动重试（既有）；重启后 dead session 等用户交互惰性恢复 |

### D.3 真实崩溃证据档案（2026-09 取证增量）

E1（9/3 pi 进程被 extension 炸死）/ E2（9/5 七 session 同秒连坐）/ E3（9/9 renderer OOM）三案的主干叙事、堆栈与系统状态见 [long-run-stability-architecture.md](long-run-stability-architecture.md) §2.1/§2.2（该文档在册），此处只记彼处未覆盖的增量细节：

- **E1 增量**：崩溃日志形态 `pi-crash-2026-09-03-835c6577-*.log`（打包版 pi exit 1）；同构现场除 smart-context 外还有 plan/compact.ts 的 `onComplete`/`onError` 裸调 `pi.sendUserMessage`（u1 接入守卫时一并收口）。stale ctx 机制与「pi 单独用不崩、套 GUI 就崩」的差异解释见 architecture §2.2。
- **E2 增量**：同秒 7 pi exit 143 期间，dev worktree（fix-zcode-subagent-failed）的 runtime 实例在用 **prod 数据目录** `~/.xyz-agent` 运行（fallback 到系统 PATH 的 pi）——归因为「dev 实例与打包版共享数据目录 + 重启/收割级联」的混合事件，确切触发者不可定论——这本身是当时取证缺口的证据（无内存水位、无收割决策日志、无主谋记录；水位打点与决策日志后由防线④补齐）。残余面已由 datadir pin 缩小，复发即升级立项的重审触发见本文附录 A #16。
- **E3 增量**：renderer 启动 0.31 秒后在 libuv `uv__malloc` 帧 SIGTRAP（V8 对分配失败立即 crash）。
- **背景噪音（9/9 同日佐证，非崩溃）**：`plugin-host worker trusted-1 exited with code 1` 出现 13 次（当时 worker 有重建机制但无崩溃取证落盘——plugin-crash log 后由防线④补齐）；runtime stderr 大量 `relay connection lost, killing child`（主 pi 死亡后 relay kill-on-disconnect 连坐杀 subagent 子进程，relay-registry.ts，属预期内级联）。

### D.4 session 历史数据流档案（磁盘到用户眼前，v1 基线快照）

原文 §2.4 与本文 §2.4 是两个对象：本文 §2.4 画的是「崩溃事件信号流」，此处存档的是「session 历史的内存放大流」——它是现役预算机制（640KB 尾读窗、分页游标、entryStates 64KB 截断、restore 最小规范化）的设计动机。图中无界点①-⑥均已治理（映射见表后注）。

```
磁盘 ~/.xyz-agent/pi/agent/sessions/<cwd-slug>/<ts>_<sid>.jsonl（实测最大 6MB；
pi-*.jsonl tee 累计流量达 198MB = 长会话高频大 entry 真实流入的证据；
单条工具结果体积受 pi 工具上游约束：read/bash 类工具自截输出 50KB/2000 行、图片 ≤16MB）
│
├─【活跃 session】pi 进程内存 entry 树
│    → RPC get_entries（不截断）
│    → history-rebuild-cache doGetHistory 全量重建 Message[]，truncated:false
│
└─【离线 session】session-history.ts 尾读窗口 640KB
     → 窗口内凑不够 20 个 user turn → fallback readFile 全量 + parseJsonl
     →「加载更早」（设计时点为 getFullHistory 全量读全量传；u6 后全量通路退役改游标翻页）
     →【restore 附着】normalizeInactiveSessionFileIfNeeded 每次附着无条件 readFileSync 全量读
       ★ 自动 respawn 使附着变成崩溃后 5 秒自动触发的内存尖峰（恢复侧恶性循环）
     → 每次 pi 退出时 extractSessionOutcome 的 findLastEntryField
       32KB 尾读未命中 → fallback readFileSync 全量同步读
       ★ 崩溃收尾动作本身变成内存尖峰触发器（退出侧恶性循环）
│
→ session.history 单条 JSON reply（设计时点无大小限制）
→ renderer ws-client JSON.parse（V8 内 UTF-16 双倍膨胀 + 对象图数倍放大，峰值可达文件体积 4-8 倍）
→ ChatStore.hydrate 全量进 messages Map + entryStates 全量累积（LRU=8 是唯一总量帽）
→ Virtualizer 虚拟滚动渲染（DOM 侧已窗口化，健康；瓶颈在内存对象图，不在 DOM）
```

**无界点治理映射（均已交付）**：① 活跃路径全量不截断 → u4 双预算截断；② 离线 fallback 全量 → u4 分块扩窗；③ 出站帧无上限 → u4 出站帧守卫（C-comm-14）；④ 入站 parse 无守卫 → 入站帧守卫（本文 D8）；⑤ entryStates 无截断 → u7 累积态 64KB 截断 + 图片落盘（data-source-registry #35）；⑥ restore 附着无条件全量读 → u4 最小规范化（session-file-streaming.ts）。图中行为与命名以代码符号为锚。

### D.5 术语锚定（读现役崩溃链路代码的前提）

- **stale ctx（失效上下文）**：pi 的 extension API 对象（`pi` / `ctx`）在 session 替换（`ctx.newSession()` / `fork()` / `switchSession()` / `reload()`）后被 pi 标记失效，再调用其方法会**同步抛错**（`assertActive` 检查，错误文案含 `stale after session replacement`——PS-30 语义断言随 C-proc-08 版本门禁自动重验）。GUI 的每次切 session/新建/重载都在制造失效窗口；CLI 用户几乎不触发——这是「pi 单独用不崩、套 GUI 就崩」的核心机制差异。
- **出站帧**：runtime 经 WebSocket 发往 renderer 的单条消息。session 级 push 帧形态 `{type, payload: {sessionId, entry}}`——大内容藏在 entry 内部字段（工具结果在 `entry.message.content`，工具参数在 `entry.arguments`，图片是 content 数组内的 Image block，entry 无独立 images 字段）。
- **ring 回放与 seq gap 检测**：MessageBus 为每 session 消息分配单调递增 seq；stream 类写容量 1000 环形缓冲，state 类更新订阅快照；WS 重连后按 seq 回放，客户端发现跳号（gap）即触发重订阅全量拉取。**seq 连续性是断连恢复机制的正确性前提**——任何「分配了 seq 但客户端没收到」的消息都会被判为丢帧（本文 D3/D8 与 C-comm-14 的 seq 语义约束均源于此）。
- **单条消息体积 vs 累计流量**：单 session pi stdout tee 累计流量实测 198MB，但单条工具结果体积受 pi 工具上游约束（read/bash 类自截 50KB/2000 行、图片 ≤16MB）——累计大 ≠ 单帧大。传输预算防单帧超限，读取预算防文件级与累计级无界，两者对象不同。

## 附录 E：subagent-core 无界等待家族裁决索引（2026-09-13 收编自 subagent-core-unbounded-wait-audit.md，原文档删除 git 可追溯）

**两层裁决（AGENTS.md「超时默认原则」规则的出处）**：weekly/monthly workflow 并发挂死（RC-1/2/3）不是孤立 bug，而是「默认无界」设计裁决的家族性发作——全仓普查登记 **32 条同家族独立缺陷**（原始 34 条并条归并；13 条可致永久挂起/进程泄漏/宿主崩溃），修复按两层推进：

1. **正常路径逐点根修**——任务执行正常路径不引入墙钟超时（用户显式指定才生效；静默 ≠ 卡死，活跃产出不得判死，ADR-0047）；逐个消灭无界等待点。
2. **回收层统一有界兜底**——dispose / kill / 上界 / idle timer 四族回收机制允许默认有界（opt-out）；**兜底只许出现在回收层**，兜底被高频触发 = 正常路径 broken 的信号。

约束登记：C-proc-19（看门狗默认不武装）、AGENTS.md 规则 19。原文档 § 编号（§4.1 OR-1、§7.2 T 系列、§7.3 P-T 探针族等）随收编不再对应本文结构，原编号上下文 git 可追溯；探针族现存于 `packages/subagent-core/probe/`（p-t1~p-t5），其报告头的设计依据指针已改指本附录。
