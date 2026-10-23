# scheduler 定时任务结果感知缺口：换通道设计独立立项

状态：现状核实完成（2026-10-23，报告 `.tmp/need-design-batch/scheduler-channel-verification.md`）：

- **统一通道已建成**：delivery-port 是 custom 车道唯一执行者，bash / session-manager / workflow / notifier 四条提交链全部经 `port.deliver` 主投（各带缺席降级）；pending-notifications 是登记/查询/收取层（pending_notifications + collect_results 工具），与投递端口上下游分工。scheduler 不在通道内。
- **结果感知能力边界**：受理回执（deliver 同步三分回执）与送达凭据（message_end + details.deliveryId 命中 → ack 落盘）可感知；pi 实装核实 message_end 发射先于 LLM 请求——命中即证明消息进入 LLM 请求上下文、已写盘、轮次真实起步。「LLM 成功产出响应」无逐条回执（端口不监听 assistant 消息成败）。
- **迁移未落地**：用户所述「已在另一独立会话实施迁移」经实码核实未找到（main HEAD / 全部分支 / 未提交改动 / 兄弟 worktree 均无 scheduler 痕迹），scheduler 现仍裸 `pi.sendMessage` steer 直投（backend.ts / runtime.ts dispatch 段）；compaction 直闯小修（dispatch 前查 isIdle）也未实施。需用户指认迁移真实落点，或确认迁移仍待实施。
- **迁移实施必办项（评估已明确）**：幂等键改每轮唯一（taskId 恒定会被端口判重恒吞，从第二轮起任务永不再提醒）+ 失败语义二选一（port retain 留账重投与 scheduler 既有「failed 记账 + 下个 tick 重试」构成双通道重试，选 forget 则耐久收益打折）。「任务执行结果好坏」不在通道能力内（需 scheduler 域内另行设计）。

原登记（pi1-disposition-chat-flow 设计 D15「登记（不做）」/ 三域扫描 simplify-S1，2026-10-04 登记；与 pi 1.0 升级解耦；2026-10-11 用户裁决保留登记）。

- 现状：scheduler 到期 dispatch 经扩展 API sendMessage 注入 owner session（`extensions/universal/scheduler/src/backend.ts:57`，返回 `Promise<void>`）——该 API 返回空值（pi 1.0 未变），定时任务消息的投递结果无感知通道；pi 1.0 新事件也替代不了（无「消息被消费/执行」的事实事件可听）。
- 影响面：定时任务失败（消息未投递或投递后被拒）静默——用户只能从对话流旁证判断任务是否生效。
- 恢复通道：正位 = 迁移到 session-manager 的 send_to_session + 通知通道（架构级换通道，独立立项设计）；立项前维持现状。
- 重审触发：该换通道设计排期时立项；上游 pi 若给 sendMessage 提供结果回执（现状 void），按新事实重评方案。
