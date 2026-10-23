# 统一投递 v3 实施残留登记

状态：项 1 已解决（2026-10-23 just-do-it 条目 68 queue-hold 清理批次执行，见下）；项 2-4 未解决（低优先级登记；2026-10-17 D2 一致性审查回流登记）

## 1. queue-hold 非生产形态的物理删除（已关闭：清理波执行完毕）

状态：已解决（2026-10-23 just-do-it 条目 68 执行）。

### 落地内容

- `packages/session-delivery/src/delivery.ts`：queue-hold 投递路径整体删除——busy gate（isIdle + 在途内查双条件）、合批窗口（merge timer 三函数 + send 的 useMerge 判定）、出站模式分支；受理即出站为唯一出站形态。与模式无关的共用机制保留：settled 边沿订阅与 flush（retain 留守条目的重投触发）、in-flight 防重、doSend 积累队列成批、判重三级链、dispose 语义。
- `packages/session-delivery/src/types.ts`：`dispatchMode` / `mergeWindowMs` / `mergeHoldActive` 配置位与 `DeliveryHandle.send` 的 `merge` 选项删除（无消费方的配置项不留存）；`DeliveryPort.isIdle` 保留（port 契约与诊断用成员，内核不读）。
- 生产装配显式传参同步删：`extensions/shared/delivery-port/src/delivery-port.ts`（kernelConfig）与 `packages/runtime/src/services/session/session-delivery-registry.ts`（createDelivery config）。
- 测试改造（登记原文「`tests/` 23 个显式传参文件」与实测不符——实际仅 delivery-dispatch-mode.test.ts 显式传 `dispatchMode`，改造面实为消费缺省 queue-hold 行为的测试）：测 busy 排队 / settled 边沿忙闲复核 / 合批窗口语义本体的用例删除（各文件带 [已不可达用例删除登记] 注记）；借道用例改以受理即出站下的等价构造保留（in-flight 防重挂起 / deferred 设计内等待 / retain 失败留守）。`delivery-merge.test.ts` 删除（depth 诊断用例迁入 ownership-view 套件）；`delivery-dispatch-mode.test.ts` 更名 `delivery-dispatch.test.ts`。

### 原登记背景

v3 把投递缺省从 queue-hold（busy gate 排队 + settled 边沿 flush + 合批窗口）翻转为 on-accept（受理即出站）后，queue-hold 代码路径无生产调用方（`delivery.ts` 头注「留待后续清理波」承诺与本条互指）。触发条件「随统一投递后的首个重构窗口」于 2026-10-23 满足，本登记关闭。

## 2. port 缺省 genId 的毫秒精度理论残余

- 位置：`extensions/shared/delivery-port/src/delivery-port.ts:570-577`（genId 混入 `Date.now().toString(36)` 时间戳段）。
- 性质：同毫秒内新旧实例各自生成同序号 id（如 dp-T-1）仍可能撞——fork/resume 复制历史终局 id 的主场景已消除（时间差远大于 1ms）并被测试锁定（delivery-port.test.ts:238）。
- 触达面：**当前为零**——四条提交链全部显式传 id（bash notify.ts:169 / session-manager notify-delivery.ts:50 / workflow workflow-notify.ts:292 / notifier notifier.ts:396-405），缺省 genId 路径无生产调用方。
- 处置倾向：不修（理论窗口需同毫秒 session_start 重绑叠加缺省提交，不可触达）；若未来出现缺省 id 的生产调用方，改用单调序列源。

## 3. runtime respawn 后旧 session 队列区派生视图失效（D3/a13 观察项，待排查）

- 现象：多次 runtime respawn 的旧 session 队列区派生视图失效——in-flight 条目不显示、乐观气泡不 morph（高频采样恒零）；全新 session 正常。渲染链 7 文件对 main 零 diff（非本次改动范围）。
- 疑点：respawn 恢复后 renderer 重订阅 / topic 快照链缺口（`session-message-handler.ts:830` 附近）。D3 验收者立场未修复，待独立排查。
- 触发：排队排查；复现证据（截图 s0-s10 与 summary.jsonl）为 dev-flow 过程产物，已随 .tmp 清理，复现需按本条现象重新真机构造。

## 4. pi 1.0.0 idle+triggerTurn 注入 entry 双写（pi 上游已证伪，成因为 taiji 侧候选、待复现归因）

- 原现象：pi 1.0.0 空闲 + triggerTurn 注入时同一通知在 transcript 可能落两条 custom_message（port 层 sendMessage 恰一次已实证，疑 pi 内部时序竞态）。
- 核实结论（2026-10-23，已核实：代码级写点穷尽 + 四时点零 token 探针——settled 边界同步注入 / 纯 idle 延迟注入 / 流式中 steer 注入 / settled 边界同 tick 双注入，全部恰 1 条 entry）：**pi 1.0.0 单次 sendMessage({triggerTurn:true}) 在 idle 态不产生双写**，custom_message 写点穷尽三处（agent-session.js :743 / :1786 / boundary draft taiji 场景不经）且五分支互斥单次调用不可达两次——「pi 内部时序竞态」假设作废。核实报告与探针产物 = `.tmp/need-design-batch/`（会话产物，git 外）。
- 候选成因（推断，未复现实证）：若「同一通知落两条」真实出现，成因在 taiji delivery-port 侧——①重放差集判重源是扫描 entries 的 deliveryId，而 pi 存在「sendMessage 已返回但 entry 未写盘」的合法窗口（settled 边界 deferred / 流式中入队），窗口内触发重放会对同一 deliveryId 第二次 sendMessage；②同一通知两次投递生成了不同 deliveryId。判别法 = 数重复条目的 `details.deliveryId` 是否相同。
- 处置：渲染侧按 details.deliveryId 判重去重的方向保留；再复现时先记录重复条目的 deliveryId 与当时 settled/流式状态，在上述两候选间定论后处置。
