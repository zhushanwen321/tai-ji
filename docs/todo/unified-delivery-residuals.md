# 统一投递 v3 实施残留（queue-hold 清理波 + port 缺省 genId 精度）

状态：未解决（两项均低优先级登记；2026-10-17 D2 一致性审查回流登记）

## 1. queue-hold 非生产形态的物理删除（清理波立项）

- 位置：`packages/session-delivery/src/delivery.ts:82-89` 头注承诺「留待后续清理波」；`grep queue-hold|dispatchMode` 确认 docs/todo 此前无对应登记（本文件补登记）。
- 内容：v3 缺省值翻转 on-accept（受理即出站）后，queue-hold 投递路径无生产调用方；物理删除 = 删除 queue-hold 分支 + `tests/` 23 个显式传参文件改缺省。
- 触发条件：下一个内核清理波（随统一投递后的首个重构窗口）。
- 关联：`delivery.ts:82-89` 头注与本条互指。

## 2. port 缺省 genId 的毫秒精度理论残余

- 位置：`extensions/shared/delivery-port/src/delivery-port.ts:570-577`（genId 混入 `Date.now().toString(36)` 时间戳段）。
- 性质：同毫秒内新旧实例各自生成同序号 id（如 dp-T-1）仍可能撞——fork/resume 复制历史终局 id 的主场景已消除（时间差远大于 1ms）并被测试锁定（delivery-port.test.ts:238）。
- 触达面：**当前为零**——四条提交链全部显式传 id（bash notify.ts:169 / session-manager notify-delivery.ts:50 / workflow workflow-notify.ts:292 / notifier notifier.ts:396-405），缺省 genId 路径无生产调用方。
- 处置倾向：不修（理论窗口需同毫秒 session_start 重绑叠加缺省提交，不可触达）；若未来出现缺省 id 的生产调用方，改用单调序列源。

## 3. runtime respawn 后旧 session 队列区派生视图失效（D3/a13 观察项，待排查）

- 现象：多次 runtime respawn 的旧 session 队列区派生视图失效——in-flight 条目不显示、乐观气泡不 morph（高频采样恒零）；全新 session 正常。渲染链 7 文件对 main 零 diff（非本次改动范围）。
- 疑点：respawn 恢复后 renderer 重订阅 / topic 快照链缺口（`session-message-handler.ts:830` 附近）。D3 验收者立场未修复，待独立排查。
- 触发：排队排查；复现证据（截图 s0-s10 与 summary.jsonl）为 dev-flow 过程产物，已随 .tmp 清理，复现需按本条现象重新真机构造。

## 4. pi 1.0.0 idle+triggerTurn 注入 entry 双写（pi 上游形态，真伪核实中）

- 现象：pi 1.0.0 空闲 + triggerTurn 注入时同一通知在 transcript 可能落两条 custom_message（port 层 sendMessage 恰一次已实证，pi 内部时序竞态）——非本次改动引入（pi 上游形态）。
- 2026-10-23 用户裁决：先核实该现象是否真实存在（node_modules 实装 + 探针），核实产物 `.tmp/need-design-batch/`；核实为真后再裁决渲染侧是否按 details.deliveryId 判重去重。上游核验归 pi-boundary-reliability 附录 B 登记线。
