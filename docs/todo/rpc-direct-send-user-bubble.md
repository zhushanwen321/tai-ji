# 协议直发 user 消息 live 气泡间歇缺失（非渲染进程发起路径）

- 状态：待复现归因（2026-10-24 chat-flow-consistency D3 验收 A3 块序组登记；a3-final/a3-final2 连续缺失、a3-run2/run3 在场、独立探针复现，间歇性）
- 现象：协议通道 delivery.submit（非 composer）发送后，message_end(user) 回执帧带内核标记，但 renderer 的 session.delivery 派生视图未含该条目（订阅/状态帧时序竞态）时，标记匹配未命中 → inflight=0（乐观气泡仅 composer 路径创建）→ hasKernelDeliveryMarker 守卫静默消费（packages/core/src/domain/chat/effects/registry.ts:134），消息不入对话流；切回/刷新经 history 重放恢复可见
- 影响边界：UI 路径不受影响（composer 乐观气泡 + inflight 记账双保险）；verify-taiji 协议直发剧本（p0 系）断言不查 user 原文故未暴露；真实用户路径无已知命中
- 排查入口：packages/core/src/domain/chat/effects/registry.ts:134 守卫 + session.delivery 派生视图的条目完备性（帧序契约）；可能方向 = 标记匹配未命中时降级为按原文显示而非静默消费
- 复现步骤：faux 实例协议直发含哨兵消息后读 body innerHTML 查哨兵（多次重试观察间歇）
