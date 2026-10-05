# 全项目防御机制清查：重试 / 对账 / 超时兜底默认删除

状态：主体清查已实施（2026-10-05 用户裁决 + 同日 4 分区并行清理落地，5 笔提交 64825a1d8 / 835674536 / c40a9969b / ba78ca9f2 / b6c7d402a）；投递域重构批次与追加裁决残留项待实施（见文末遗留清单）。

- 第一原则（用户裁决原文归纳，体系化承载 = ADR-0112 事实驱动原则体系）：
  1. 本项目绝大部分情况 fail-fast；自动重试只有底层 pi 调 LLM 的地方有（在 pi 内部，非本项目代码）；
  2. 项目不涉及复杂网络环境，底层由 pi 封装了大部分后端保障功能，taiji 主要做 GUI；
  3. 项目里大量重试、对账、超时判断属「没事找事」——都应删除清理，不要做。
- 分类框架：A 自动重试 / B 对账重放 / C 墙钟超时（C1 挂死保护 / C2 显式业务超时 / C3 时间窗猜测）/ D 轮询 / E UI 防抖（交互语义，仅登记）。
- 裁决边界：pi 内部的 LLM 重试不涉及；用户/调用方显式配置传入的超时是功能参数（C2），不在删除范围；产品功能性的重试与机械防御性重试区分，前者保留；与既往权威裁决冲突处（如 crash-forensics 附录 E「回收层统一有界兜底」）由本裁决逐条推翻或豁免（kill 族 grace、idle-pi-reaper、abort-liveness 阶梯、reap-orphan-pi 时序常量已推翻），不静默。
- 例外保留：产品功能定时、C2 显式配置超时、file-lock 锁语义、事件驱动对账（B 类：notify-ledger 回执对账本体、reconcile 事件触发路径、worktree 观察期族）、构建脚本类、PingProbe 无进展检测（ADR-0047 口径）、relay 孤儿收割（无 ChildProcess 引用可挂事件，时间机制为唯一判据）、外部网络端点墙钟（npm/oauth，网络客户端标准防线）。

## 已实施终态（4 分区删除约 150 处机制）

- 引擎链（pi-rpc / subagent-core / pi-subagent-cli / subagent-engine-sdk）：workflow agent() 自动重试、worker 重建矩阵、引擎初建自动重建、resume 锁重试、get-state 握手重试、kill 链 grace 阶梯（SIGKILL 直杀）、crash 重建常量——全删；失败单次终态化显式上报。
- runtime 内核（runtime / session-delivery / shared）：RPC pending 墙钟分级、迟到响应丢弃、pi-respawn 自动恢复、abort-liveness 阶梯、idle-pi-reaper 整模块、WS 心跳/认证/linger 墙钟、relay 握手/grace/孤儿时序、watchdog 定时触发、requireCommand 轮询、session-records 15s 定时对账、notify-claims TTL sweep、bg_reconcile 节流、git/file/logger 杂项墙钟、RECLAIM 旋钮与激活超时死常量——全删；reconcile 事件触发路径、pollTimer（ADR-0075 拉取真理通道）保留。
- extensions：cw-tool / rename-session / permission 默认墙钟、session-manager SELECT_TIMEOUT 表、bte 2s 轮询器（改 exit 事件边沿收尾 exit-collector.ts）、scheduler widget 保活帧（唯一理由 = reaper 防御，陪葬退役）——全删。
- 前端/平台（apps/electron / core / renderer）：重启稳定窗、renderer 崩溃自动 reload + 熔断（改静态错误页 + 手动重试）、端口释放猜等、重启延迟猜等——全删。
- 跳过待裁决项全录见 `.tmp/dev-flow/defense-scan/*-changes.md`（gitignore 产物目录，逐条带理由）：holdEdgeTick、ABORT_STALL 收敛窗、PingProbe、trace-sync/background-task/btw-fork 轮询、外部网络墙钟族等。

## 遗留清单（待实施）

1. 投递域重构批次：sweepInFlight 退役、命令/技能 started 终局、断连钩子 + 失败批量显式上报、delivery backoff 退役、受理层同步上屏（裁决见 delivery-backoff-retry-retirement / command-pi-restart-response-loss / skill-input-marker-pollution）。
2. 追加裁决 ① 组 2/3/4/5 中依赖跨分区配合的残留：zcode 双 timer、notify 看门狗重投、update 停滞检测、event-tail watch 族（推送通道设计已产出 .tmp/tech-design/event-push-channel.md，实施按其 W-P1..W-P4 分波）、structured-output 强制退出。
3. scheduler 模型切换 tick 对账改 isIdle() 事实查询；startup-sweep 宽限窗改创建顺序契约（追加裁决 ③④ 配套）。
4. renderer 死代码 useCrashRecoveryNotice 清理（recovery-policy 删除后的前端残余）。
