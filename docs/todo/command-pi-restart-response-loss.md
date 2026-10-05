# 命令条目终局凭据事件化：回执驱动 + 断连未确认终局（已实施）

状态：已实施（2026-10-05 用户裁决，推翻 D14①b「显式接受」；原时间窗扫描方案已退役，同日投递域批次落地）。

- 裁决方案：命令/技能条目的终局只由事件驱动，零时间窗、零扫描、零持久化——
  1. **handled 回执到达** → 已执行终局（现状保留）；
  2. **started 回执到达** → pi 未按命令接管、已把输入当普通文本接住（识别假阳性的确定性证据），终局收气泡，回合输出照常流入；
  3. **连接断开事件** → 所有在途的不注标条目（命令/技能）立即按「结果未确认」终局，前端显式提示（如「执行结果未确认，重发前请核对」）。
- 裁决理由：连接正常时回执必达（正常路径无丢失），回执长时间不到的唯一现实成因是底层进程死亡，而死亡有断连事件这个确定性信号——时间窗扫描（原 sweepInFlight 命令分支 10s 宽限）是在用时间猜一件有确定性信号可等的事，属「时间平抑类逻辑红线」判死的形态：删掉后数据仍最终一致。对账持久化同理不需要（用户明示「不需要对账不需要扫描」）。
- 实施形态：sweepInFlight（10s 宽限 + transcript 比对 + 命令条目静默终局 + slotCleared 门禁）整体删除；无标记条目终局 = deliverOne 的 prompt 响应 disposition（handled/queued/started 三值同为「pi 已受理输入」的事实——queued 值由 pi 源码锚定：steer/followUp 队列受理与技能展开后入队；pi 源码中扩展命令在 streaming 中也立即执行，queued 仅出现于假阳性文本/技能展开后入队）+ pi 断连事件（session-service onSessionExit 链 → registry.onPiDisconnected：撤销待收回条目就地兑现 cancelled，其余 in-flight 批量 failed + message.error 逐条上报）；「识别假阳性悬挂」自然消解。disposition 缺失（pi < 1.0 / mock）不产生终局，条目留守 in-flight 由断连事件终局化（pi 1.0 保证 disposition 存在）。
- 不变：runtime 自身重启丢 tombstone 的场景维持既有接受（command-runtime-restart-window 登记，用户明示不需要对账）；前端 30s 空窗是普通消息链路既有语义，不在本次范围（命令条目已豁免）。
- 实施入口：识别集扩展（source=skill 手打形态纳入，started 基终局）已随 skill-input-marker-pollution 同批落地。
