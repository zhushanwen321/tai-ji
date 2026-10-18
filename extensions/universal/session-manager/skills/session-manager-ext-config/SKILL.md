---
name: session-manager-ext-config
description: "使用或排查 @zhushanwen/pi-session-manager（agent-managed session 六工具与完成通知）时加载。说明完成通知链（notifyId → watch 长挂通道 → managed-session-notify 送达）、投递日志存储（delivery-port outbox/ack entry + session_start 差集重放）、pending 列表 type 'session' 条目的生命周期、willNotify 与 fulfills 合并语义、lifetimeNotifyId 死亡通知、未收到通知与 pending 残留的排查入口。触发词：session-manager、managed session、create_managed_session、send_to_session、完成通知没收到、通知未送达、notifyId、pending 列表有 session 条目、投递日志、delivery-port、managed-session-notify、willNotify、session-manager-ext-config。"
---

# session-manager 使用与排查指南

> @zhushanwen/pi-session-manager：agent-managed session 扩展。父 session 通过 6 个工具
> （create_managed_session / send_to_session / read_session_history / list_my_sessions /
> get_session_status / abort_session）以子 session 形态并行工作。本指南讲完成通知链、
> 投递日志与排查入口；工具契约细节（marker 通道 / 超时分档）见包 README。

## 重要前提

- 工具应答端是 taiji runtime 的 SessionManagerHandler——**只在 taiji 桌面环境可用**；
  独立 pi CLI 无 handler 应答，所有工具等待至超时后报 `cancelled or timed out`。
  工具失败时先确认运行环境，不要怀疑参数。
- 本扩展不读磁盘配置文件，无 config JSON——通知状态全部存储在 pi session 文件内
  （见投递日志一节），没有「改配置文件」这条路径。

## 完成通知链（notifyId → watch → managed-session-notify）

一次带完成通知的工作流分四步：

1. **生成债权**：`create_managed_session` 带 `prompt` 时（或每次 `send_to_session`）生成一个
   notifyId（`sm-` 前缀 + UUID）。runtime 返回 `willNotify: true` 表示该次调用已受理一笔
   完成通知债权；`willNotify: false`（create 不带 prompt）不产生通知。
2. **arm**：工具结果成功后扩展做两件事——emit `pending:register`（{id = notifyId,
   type: 'session', name = label}，由 pending-notifications 扩展消费落 pending 列表）+
   开 watch（fire-and-forget，不传 timeout，长挂等待 runtime 应答）。
3. **watch 应答**：子 session 完成/死亡后 runtime 经 watch 通道回一条应答，reason 词表：
   `completed` / `failed` / `stopped`（结果新闻）、`exited` / `deleted`（死亡新闻）、
   `cancelled` / `orphaned`（静默注销，不产出通知）。应答经 50ms trailing debounce 攒批：
   分拣键 (sessionId, reason)，批身份 settleSeq/deathSeq——同一批合并为一条通知。
4. **入账投递**：攒批结果经 `recordManagedNotify` → delivery-port 的 `port.deliver`
   提交（见下节），注入直达 pi 唯一队列（steer 档 + `triggerTurn: true`，pi 忙时入队
   不拒、轮边界注入），送达回执按 notifyId 的 details-id 凭据匹配逐条处理完毕（ack entry）。

通知文案形态：`Managed session "<label>" (<sessionId>) finished with status "<status>"
(exit code: N). (fulfills N request(s))`；stderr 非空时附 Stderr tail（400 字截尾）；
runtime 查得到时附 `Full transcript: <sessionFilePath>` 指针行。

**合并与数量语义**：

- 多条 queued 消息在同一轮消费合并为一次通知（fulfills N = 本批兑现笔数）；
- `create_managed_session` 还返回 `lifetimeNotifyId`：session 终局死亡（exited/deleted）
  恒产出一次死亡通知，与结果通知相互独立；
- 每 notifyId 至多一条通知（投递日志按 id 幂等判重），重放不重复发声。

## 投递日志（delivery-port）

通知记录与恢复不依赖独立磁盘文件，复用 pi session 文件本身（pi session append-only
契约：entry 只追加不删改，compaction 不清 entry）：

- **outbox entry = session 文件自定义 entry**：通知经 `@zhushanwen/pi-delivery-port`
  的 `port.deliver` 提交（id = notifyId 幂等键，managed-session-notify 外部通道逐条），
  受理前先 `pi.appendEntry` 写 outbox entry（delivery-port-outbox，plain custom entry
  不进 LLM 上下文）——先落盘后投递，进程崩溃后债权不丢。
- **送达回执处理完毕**：注入后 pi 侧出现携带该 id 的 custom_message，port 订阅
  message_end 按 details-id 凭据命中 → 写 ack entry（delivery-port-ack）终局。
- **session_start 差集重放**：每次 session_start 扫投递日志 −（对话记录已送达 ∪ ack）
  差集——未处理的债权重新投递，已处理完毕的静默；按 notifyId 幂等去重，重放不重复发声。
- 投递端口装配在 `@zhushanwen/pi-base-tool-enhance` 的 session_start（infrastructure
  档必载），本扩展零装配义务——port 恒可用；缺席仅覆盖装配异常窗口（warn + 弃投该条，
  下次 session_start 重试装配）。

## 排查入口

| 症状 | 排查路径 |
|------|---------|
| 未收到完成通知 | ① 确认 taiji 桌面环境（standalone pi CLI 无 handler，工具本身就会超时）；② 查扩展日志 `<agentDir>/logs/session-manager-YYYY-MM-DD.log`（agentDir = pi `getAgentDir()`，默认 `~/.pi/agent`，taiji 隔离环境 `~/.taiji/agent`）搜 `[session-manager]`——`delivery port not bound`（base-tool-enhance session_start 未跑/装配失败，通知丢弃，下次 session_start 重试装配）、`delivery port rejected notification`（受理被拒：幂等键未登记，watch 重试合法）、`watch select rejected`（watch 通道被拒）、`watch respond unusable/malformed`（runtime 应答不可解析，协议漂移信号）；③ 日志干净则确认子 session 是否真完成（get_session_status） |
| pending 列表残留 type 'session' 条目 | register 由 send/create 带 prompt 的 arm 写入，正常由 watch 应答逐条 unregister。残留 = watch 应答未达（pi 进程被杀 / runtime 重启 / 通道折叠 cancelled）；这些活跃 register 由下次 session_start 收尾路径逐条重开 watch（入参 = entry id 即 notifyId），应答到达即静默注销，无需手工处理 |
| 同一完成重复通知 | 不应发生——投递日志按 notifyId 判重、死亡槽 (sessionId, deathSeq) 同键只发首条。若复现即协议漂移，查扩展日志 `delivery port rejected notification` / `notify delivery failed` 留痕归因 |

## 工具速查

| 工具 | 说明 |
|------|------|
| `create_managed_session` | 创建子 session（cwd 必填；可选 label；可选 prompt 原子 create+send） |
| `send_to_session` | 向子 session 发 prompt（忙时排队，`queued: true` 立即返回） |
| `read_session_history` | 读子 session 对话历史（可选 tailTurns 截尾部 N 个 turn） |
| `list_my_sessions` | 列本 agent 管理的 session（顺带回填 label 缓存，修复重启后的文案 label 降级） |
| `get_session_status` | 查子 session 状态与模型信息 |
| `abort_session` | 中止运行中的子 session（终态 stopped） |
