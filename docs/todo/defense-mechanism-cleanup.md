# 全项目防御机制清查：重试 / 对账 / 超时兜底默认删除

状态：全部批次已实施完毕（2026-10-05 用户裁决 + 同日主体清查 5 笔提交；同日投递域重构、journal 推送通道、Wave 2-C1/C2 残留批次、renderer 受理层上屏全部落地，遗留清单已清零）。本登记转为终态存档：后续新增防御机制前先对照 ADR-0122 原则与本文「例外保留」清单。

- 第一原则（用户裁决原文归纳，体系化承载 = ADR-0122 事实驱动原则体系）：
  1. 本项目绝大部分情况 fail-fast；自动重试只有底层 pi 调 LLM 的地方有（在 pi 内部，非本项目代码）；
  2. 项目不涉及复杂网络环境，底层由 pi 封装了大部分后端保障功能，taiji 主要做 GUI；
  3. 项目里大量重试、对账、超时判断属「没事找事」——都应删除清理，不要做。
- 分类框架：A 自动重试 / B 对账重放 / C 墙钟超时（C1 挂死保护 / C2 显式业务超时 / C3 时间窗猜测）/ D 轮询 / E UI 防抖（交互语义，仅登记）。
- 裁决边界：pi 内部的 LLM 重试不涉及；用户/调用方显式配置传入的超时是功能参数（C2），不在删除范围；产品功能性的重试与机械防御性重试区分，前者保留；与既往权威裁决冲突处（如 crash-forensics 附录 E「回收层统一有界兜底」）由本裁决逐条推翻或豁免（kill 族 grace、idle-pi-reaper、abort-liveness 阶梯、reap-orphan-pi 时序常量已推翻），不静默。
- 例外保留：产品功能定时、C2 显式配置超时、file-lock 锁语义、事件驱动对账（B 类：notify-ledger 回执对账本体、reconcile 事件触发路径、worktree 观察期族）、构建脚本类、PingProbe 无进展检测（ADR-0047 口径）、relay 孤儿收割（无 ChildProcess 引用可挂事件，时间机制为唯一判据）、外部网络端点墙钟（npm/oauth，网络客户端标准防线）。
- 轮询保留登记（现状依据：pi 侧 / 写侧无完成事件信号，轮询是当前唯一可达通道；退役条件：上游提供完成事件即改事件驱动并删轮询）：
  - trace-sync 现取轮询（`trace-sync.ts` FETCH_CURRENT_PROMPT_POLL_MS=250ms / 8s 上限）：`/__taiji_get_system_prompt__` 命令 handler 写 custom entry 后 runtime 轮询 get_entries 拉取；命令 handler 毫秒级完成、无完成事件信号（拉取通道本体承 ADR-0075）。退役条件 = pi 提供「entry 已写」事件边沿或命令 RPC 直返结果。
  - background-task 变更检测轮询（`background-task-service.ts` 2s mtime 轮询）：后台任务状态变更检测的三触发面之一（mtime 轮询 + 事件钩子 + service 自写自检，共享同一 last-seen mtime 判定）；registry 文件写侧无变更事件信号。退役条件 = 写侧变更事件覆盖全部写路径。
  - btw-fork 结果轮询（`btw-fork-exec.ts` 50ms 扫新增 .jsonl / 10s 上界）：fork bootstrap 进程无「执行完成」事件信号，fork 产物文件可见性轮询是唯一判据（文件可见先于内容可读）。退役条件 = pi 提供 fork 完成事件信号。

## 已实施终态（4 分区删除约 150 处机制）

- 引擎链（pi-rpc / subagent-core / pi-subagent-cli / subagent-engine-sdk）：workflow agent() 自动重试、worker 重建矩阵、引擎初建自动重建、resume 锁重试、get-state 握手重试、kill 链 grace 阶梯（SIGKILL 直杀）、crash 重建常量——全删；失败单次终态化显式上报。
- runtime 内核（runtime / session-delivery / shared）：RPC pending 墙钟分级、迟到响应丢弃、pi-respawn 自动恢复、abort-liveness 阶梯、idle-pi-reaper 整模块、WS 心跳/认证/linger 墙钟、relay 握手/grace/孤儿时序、watchdog 定时触发、requireCommand 轮询、session-records 15s 定时对账、notify-claims TTL sweep、bg_reconcile 节流、git/file/logger 杂项墙钟、RECLAIM 旋钮与激活超时死常量——全删；reconcile 事件触发路径、pollTimer（ADR-0075 拉取真理通道）保留。
- extensions：cw-tool / rename-session / permission 默认墙钟、session-manager SELECT_TIMEOUT 表、bte 2s 轮询器（改 exit 事件边沿收尾 exit-collector.ts）、scheduler widget 保活帧（唯一理由 = reaper 防御，陪葬退役）——全删。
- 前端/平台（apps/electron / core / renderer）：重启稳定窗、renderer 崩溃自动 reload + 熔断（改静态错误页 + 手动重试）、端口释放猜等、重启延迟猜等——全删。
- Wave 2-C2 批次（追加裁决残留项，2026-10-05 落地）：
  - notify 看门狗重投（`subagent-core/execution/notify/notify-ledger.ts`）：NOTIFY_WATCHDOG_MS=120s 看门狗定时器 + NOTIFY_REDELIVERY_MAX_ATTEMPTS=5 重投上限 + abandoned 放弃终态族（生产/消费/compaction 补写/恢复跳过全链）——全删；语义终态 = 通知 sent 后无回执不重投（通知可能丢失是已接受代价），settled 边沿投递、回执对账、notifyId 幂等、重启恢复重放保留。
  - startup-sweep 宽限窗（`subagent-core/orchestration/startup-sweep.ts` + `run-registry.ts`）：STARTUP_SWEEP_GRACE_WINDOW_MS=60s 事件流静止宽限窗（graceWindowMs 选项 / skippedGraceWindow outcome）——删，改创建顺序契约（单实例锁确立 + 扫描先于任何 pi spawn 的事实判定 + 三面证据幂等让位 + fold 保守停帧不崩坏）。
  - ABORT_STALL 收敛窗（`runtime/services/session/event-interpreter.ts` + `event-interpreter-settled-delay.ts`）：ABORT_STALL_CONVERGENCE_WINDOW_MS=3s 静默窗 + ABORT_STALL_MAX_PENDING_GENERATIONS=10 代强制清环 + UserStoppedGate 收敛环（converging Map / timer / beginRestoreConvergence / noteAgentSettled / disposeForEntryRemoval）——全删，改事件顺序契约：userStopped 标记存活期 = 旁路 turn 拦截存续期，标记清除只由显式意图事件驱动（显式投递 / 会话删除 / shutdown）；「settled 永不到达」（pi 收尾挂死）归 PingProbe → onSilentAbort → forceQuit 显式上报链。
  - structured-output 兜底硬退（`extensions/universal/structured-output/src/loop-gate.ts`）：TEARDOWN_FORCE_EXIT_MS=15s 兜底硬退 timer（armForceExitTeardown / process.exit 兜底）——删；同签名 3 次门禁（MAX_CONSECUTIVE_FAILURES）为确定性失败计数非时间机制，判定保留。pi 挂死不 settle 的处置 = 父进程既有失败路径 + 用户重启应用。
- Wave 2-C1 批次（独立包组，2026-10-05 落地）：
  - zcode turn 双 timer（`zcode-subagent-cli`）：ZCODE_TURN_IDLE_TIMEOUT_MS=30min + ZCODE_TURN_MAX_TIMEOUT_MS=60min 任务级墙钟族（常量 / env 旋钮 / timer 装配 / TurnTimeoutError 分流 / 超时入口 abort 链 / engine_timeout 文案 / transient:timeout 重试形态 / 预算继承面）——全删（规则 19 红线：任务级正常路径禁止自带墙钟超时）；瞬时重试本体（conn-closed 形态）与 schema 重试保留但不再携带上界。控制面单请求秒级超时（request 15s / read 5s / close 1.5s / stop 3s）与回收层有界兜底（abort grace 3s / kill grace 5s / harvest grace 1s）判定保留。
  - update 下载停滞检测（`apps/electron/main/update/download-asset.ts`）：IDLE_TIMEOUT_MS=30s 无字节进展 abort watchdog——删（追加裁决推翻初scan「唯一保留超时」标注）；断点续传 temp 机制保留；curl 引擎 --speed-time 不在裁决点名范围，保留。
  - renderer 崩溃恢复提示条死链（`useCrashRecoveryNotice` + `CrashRecoveredBar`）：数据源 reloadWindowAfterCrash 随 recovery-policy 删除后无生产者、结构性永不可见——四文件整删 + 3 个死 i18n 键清理。
  - scheduler 模型切换对账（`extensions/universal/scheduler/src/runtime.ts`）：MODEL_SWITCH_RECONCILE_TICKS 2-tick 窗口计数 + phase/ticksOpen 字段 + forceSettleExpiredInFlight——合并为 settlePendingIfIdle 单点（记录存在 + isIdle() 事实查询即恢复）。
- journal 推送通道（event-push-channel W-P1..W-P4，2026-10-05 落地）：run/record 两域落盘提交点经 SUBAGENT_JOURNAL_MARKER select 通道推送 runtime，派生视图改「启动冷读一次 + 推送增量折叠 + seq 缺口本地补读 + 终局条目补读触发」；event-tail watch 族（DirectoryEventTailer / watch 挂载 / 30s 周期复查 / 5s 失败重挂 / 200ms 合并）整体退役，readEventTail 补读原语保留。设计权威源 `.tmp/tech-design/event-push-channel.md`。
- 跳过待裁决项全录见 `.tmp/dev-flow/defense-scan/*-changes.md`（gitignore 产物目录，逐条带理由）：holdEdgeTick、PingProbe、外部网络墙钟族等（ABORT_STALL 收敛窗、trace-sync/background-task/btw-fork 轮询已在本批裁决——前者删、后三者登记退役条件保留）。

## 遗留清单（待实施）

1. 投递域重构批次：已实施（2026-10-05 同批落地——sweepInFlight 退役、命令/技能 started 基终局、断连钩子 + 失败批量显式上报、delivery backoff/settle 兜底/watchdog/退避轮询退役；裁决与实施形态见 delivery-backoff-retry-retirement / command-pi-restart-response-loss / skill-input-marker-pollution 三登记）。
2. 追加裁决 ① 组 2/3/4/5 中依赖跨分区配合的残留：已全部实施——notify 看门狗重投、structured-output 兜底硬退（Wave 2-C2 批次）；zcode 双 timer、update 停滞检测（Wave 2-C1 批次）；event-tail watch 族（journal 推送通道替代，W-P1..W-P4）。
3. scheduler 模型切换 tick 对账：已实施（Wave 2-C1——2-tick 窗口计数对账与 forceSettleExpiredInFlight 合并为 settlePendingIfIdle：记录存在 + isIdle() 同步事实查询即恢复，agent_settled 确定性事件保留为提前触发加速器；tick 心跳本体是产品功能定时，保留）。
4. renderer 死代码 useCrashRecoveryNotice：已实施（Wave 2-C1——数据源 reloadWindowAfterCrash 随 recovery-policy 删除后结构性永不可见的完整死链，四文件整删 + 3 个死 i18n 键清理；app.crashDismiss 键被内存压力提示条复用，保留）。
5. renderer 受理层同步上屏：已实施（2026-10-05——气泡上屏时机后移至 delivery.submit 受理回执 resolve 后；30s pending-send 空窗 timer 族整体退役（PENDING_SEND_TIMEOUT_MS / timer 表 / 命令豁免 / 'timeout' finalize reason），气泡终局全事件驱动；断连「执行结果未确认」终态在真实渲染树可见（content 空 error 气泡补 text 块宿主——既有渲染缺陷顺带修复）；core chat 域按前端/平台分区口径随本批实施）。
