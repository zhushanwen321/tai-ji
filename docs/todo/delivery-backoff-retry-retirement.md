# 内核自动重试退役：首败即停 + 失败显式上报，重试决策权归消费方（已实施）

状态：已实施（2026-10-05 用户裁决 + 同日投递域批次落地；推广 command-unchecked-path-first-failure-stop 的首败即停语义至全部条目）。

- 裁决方案：投递内核删除 backoff 自动重试链——所有条目（普通消息与命令/技能）首败即停；失败后内核只做事实上报，不做重试干预：
  1. **人类发起的消息**：失败 → 前端页面 notification 显式提示发送失败，用户自己决定重发；
  2. **agent 发给 agent 的消息**（session-manager send_to_session 等通路）：失败 → 失败回执上抛给调用方 agent，由它决定重试。
- 裁决理由：重试是补偿决策，前提是知道「重试是否安全」——命令不能重试（可能重复执行）、普通文本可以。这个语义知识在消费方手里，不在内核手里；原「普通条目自动重试 + 命令条目首败即停」的双轨制正是知识错位产生的补丁。统一不重试后，内核回归忠实投递 + 事实上报（与「计算器/裁判分层」架构偏好同构），重试决策全部上交知道语义的一方。
- 实施形态（ADR-0122 首败即停统一语义）：`packages/session-delivery` 内核 onSendFail 一次失败即终局——checked 条目 reject + 移除（不产 tombstone），非 checked 条目 onSettled('rejected') 逐条上报 + 移除；backoff 参数与重试 timer 删除；随批退役：port.send settle 挂死兜底（60s，ADR-0122 范围纪律「信任边界内不设防」，推翻本登记原「保留 settle 兜底」条款）、watchdog 30s 定时复核、无订阅装配 busy 退避轮询（busy 留守归 settled 边沿与外部触发）。内核新增 failInFlight（断连事件驱动的显式失败终局，in-flight → failed，消费 command-pi-restart-response-loss 登记的断连路径）。
- 保留（与失败重试正交）：断线重连 resync 对账重投（拉取对账通道）、reconcile 事件触发路径、requeue/resync 用户重试状态机。
- 关联登记：command-unchecked-path-first-failure-stop.md（行为差异消失，状态已合并）、command-pi-restart-response-loss.md（终局凭据事件化，同一重构的另一面）。
