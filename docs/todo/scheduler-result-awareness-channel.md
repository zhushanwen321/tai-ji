# scheduler 定时任务结果感知缺口：换通道设计独立立项

状态：独立立项待设计（pi1-disposition-chat-flow 设计 D15「登记（不做）」/ 三域扫描 simplify-S1，2026-10-04 登记；与 pi 1.0 升级解耦）。

- 现状：scheduler 到期 dispatch 经扩展 API sendMessage 注入 owner session（`extensions/universal/scheduler/src/backend.ts:57`，返回 `Promise<void>`）——该 API 返回空值（pi 1.0 未变），定时任务消息的投递结果无感知通道；pi 1.0 新事件也替代不了（无「消息被消费/执行」的事实事件可听）。
- 影响面：定时任务失败（消息未投递或投递后被拒）静默——用户只能从对话流旁证判断任务是否生效。
- 恢复通道：正位 = 迁移到 session-manager 的 send_to_session + 通知通道（架构级换通道，独立立项设计）；立项前维持现状。
- 重审触发：该换通道设计排期时立项；上游 pi 若给 sendMessage 提供结果回执（现状 void），按新事实重评方案。
