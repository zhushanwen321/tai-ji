# 全项目防御机制清查：重试 / 对账 / 超时兜底默认删除

状态：主体清查已实施（2026-10-05 用户裁决 + 同日 4 分区并行清理落地，5 笔提交 64825a1d8 / 835674536 / c40a9969b / ba78ca9f2 / b6c7d402a）；投递域重构批次已实施（同日）；追加裁决残留项已由 Wave 2-C2 批次落地（notify 看门狗重投、startup-sweep 宽限窗、ABORT_STALL 收敛窗、structured-output 兜底硬退——见「已实施终态」末段）；其余跨分区残留项待实施（见文末遗留清单）。

- 第一原则（用户裁决原文归纳，体系化承载 = ADR-0112 事实驱动原则体系）：
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
  - notify 看门狗重投（`subagent-core/execution/notify/notify-ledger.ts`）：NOTIFY_WATCHDOG_MS=120s 看门狗定时器 + NOTIFY_REDELIVERY_MAX_ATTEMPTS=5 重投上限 + abandoned 放弃终态族（生产/消费/compaction 补写/恢复跳过全链）——全删；语义终态 = 通知 sent 后无回执不重投（通知可能丢失是已接受代价），settled 边沿投递、回执销账、notifyId 幂等、重启恢复重放保留。
  - startup-sweep 宽限窗（`subagent-core/orchestration/startup-sweep.ts` + `run-registry.ts`）：STARTUP_SWEEP_GRACE_WINDOW_MS=60s 事件流静止宽限窗（graceWindowMs 选项 / skippedGraceWindow outcome）——删，改创建顺序契约（单实例锁确立 + 扫描先于任何 pi spawn 的事实判定 + 三面证据幂等让位 + fold 保守停帧不崩坏）。
  - ABORT_STALL 收敛窗（`runtime/services/session/event-interpreter.ts` + `event-interpreter-settled-delay.ts`）：ABORT_STALL_CONVERGENCE_WINDOW_MS=3s 静默窗 + ABORT_STALL_MAX_PENDING_GENERATIONS=10 代强制清环 + UserStoppedGate 收敛环（converging Map / timer / beginRestoreConvergence / noteAgentSettled / disposeForEntryRemoval）——全删，改事件顺序契约：userStopped 标记存活期 = 旁路 turn 拦截存续期，标记清除只由显式意图事件驱动（显式投递 / 会话删除 / shutdown）；「settled 永不到达」（pi 收尾挂死）归 PingProbe → onSilentAbort → forceQuit 显式上报链。
  - structured-output 兜底硬退（`extensions/universal/structured-output/src/loop-gate.ts`）：TEARDOWN_FORCE_EXIT_MS=15s 兜底硬退 timer（armForceExitTeardown / process.exit 兜底）——删；同签名 3 次门禁（MAX_CONSECUTIVE_FAILURES）为确定性失败计数非时间机制，判定保留。pi 挂死不 settle 的处置 = 父进程既有失败路径 + 用户重启应用。
- 跳过待裁决项全录见 `.tmp/dev-flow/defense-scan/*-changes.md`（gitignore 产物目录，逐条带理由）：holdEdgeTick、PingProbe、外部网络墙钟族等（ABORT_STALL 收敛窗、trace-sync/background-task/btw-fork 轮询已在本批裁决——前者删、后三者登记退役条件保留）。

## 遗留清单（待实施）

1. 投递域重构批次：已实施（2026-10-05 同批落地——sweepInFlight 退役、命令/技能 started 基终局、断连钩子 + 失败批量显式上报、delivery backoff/settle 兜底/watchdog/退避轮询退役；裁决与实施形态见 delivery-backoff-retry-retirement / command-pi-restart-response-loss / skill-input-marker-pollution 三登记）。
2. 追加裁决 ① 组 2/3/4/5 中依赖跨分区配合的残留：zcode 双 timer、update 停滞检测、event-tail watch 族（推送通道设计已产出 .tmp/tech-design/event-push-channel.md，实施按其 W-P1..W-P4 分波）。（notify 看门狗重投、structured-output 强制退出已由 Wave 2-C2 批次实施。）
3. scheduler 模型切换 tick 对账改 isIdle() 事实查询（scheduler 文件域，待实施）。
4. renderer 死代码 useCrashRecoveryNotice 清理（recovery-policy 删除后的前端残余）。
5. renderer 受理层同步上屏（ADR-0112 ⑨「UI 跟随事实」渲染面：气泡确认呈现——受理回执到达才上屏、无回执不产生等待态气泡）：runtime 侧终局事件链已就绪（session.deliveryHandled 终局通知 / message.error 显式失败 / session.exited 死亡信号，投递域批次 2026-10-05 落地），渲染面改造属 renderer 文件域，投递域批次（session-delivery + runtime/session）不含，归 renderer 批次实施。
