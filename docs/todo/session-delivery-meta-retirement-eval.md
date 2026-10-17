# session-delivery 内核 msg.meta 透传链退役评估（pi 车道供稿端点已删）

状态：待裁决（pi 车道零供稿已成立；runtime 车道供稿方仍活跃，内核透传链不删；2026-10-17 登记，result-collect 设计 §3.2 存废裁决的登记落点）

## 背景

`DeliveryEnvelope.meta`（pi 车道投递端口的 additive 透传位）已随 result-collect 设计删除：collectKey 改道类型化提交选项 `DeliveryDeliverOptions.collectKey`（端口层读取消费，非无名透传）后，meta 的 pi 侧预期消费方清零。内核包 `@zhushanwen/session-delivery` 的 msg.meta 透传链不在该设计 scope，退役评估登记于本条目。

## 透传链现状（消费方清点）

内核 msg.meta 的机制面（零读取零加工，per-message 原样流转）：

- `DeliveryMessage.meta`（packages/session-delivery/src/types.ts，additive meta 定义）；
- per-message 终态回调 onSettled 原样回传该条消息（合批逐条回调）；
- `persistRecord` 把 `e.msg.meta` 写进 DeliveryStoreRecord.meta（packages/session-delivery/src/delivery.ts）。

供稿方与消费方按车道分野：

| 车道 | 供稿方 | 消费方 | 状态 |
|------|--------|--------|------|
| pi 车道（delivery-port custom 车道） | `DeliveryEnvelope.meta`（已删除） | 无 | **零供稿已成立**（全仓 grep 五处 deliver 调用点均不带 meta） |
| runtime 车道（text 车道） | `session-manager-handler.ts` send 路径 `sendChecked({ meta: { notifyId, parentSid } })`（notify-once D2） | `runtime/src/index.ts` onSettledMessage 读 `msg.meta.notifyId/parentSid` → notify-claims markInjected / disarmDeliveryFailed（armed→injected 受理回执锚） | **活跃**（notify-once D2 状态机组成部分） |

## 删除判据（裁决时点逐条核对）

内核 msg.meta 透传链（DeliveryMessage.meta 字段 / onSettled 原样回传 / persistRecord meta 透传）满足以下全部条件后方可整体退役：

1. notify-once D2 受理回执锚改道：runtime 车道 armed→injected 锚定不再经 `msg.meta.notifyId`（改为独立回执通道或该机制退役——以 notify-once 域设计裁决为准）；
2. `DeliveryStoreRecord.meta` 与 disk-store `t:'meta'` 行中，segments 快照补记（runtime 撤销编排）之外的消费方清零；
3. `packages/session-delivery/tests/delivery-envelope-meta.test.ts`（meta 语义锁定测试）随删除同批退役。

任一条件不满足时维持现状：pi 车道零供稿不构成删除理由——meta 在内核是跨车道共享字段，runtime 车道仍在供稿与消费。
