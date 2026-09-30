---
name: session-manager-ext-config
description: "使用或排查 @zhushanwen/pi-session-manager（agent-managed session 六工具与完成通知）时加载。说明完成通知链（notifyId → watch 长挂通道 → managed-session-notify 送达）、B-ledger 账本存储（session 文件自定义 entry + session_start 重装恢复 + session_compact 补写）、pending 列表 type 'session' 条目的生命周期、willNotify 与 fulfills 合并语义、lifetimeNotifyId 死亡通知、未收到通知与 pending 残留的排查入口。触发词：session-manager、managed session、create_managed_session、send_to_session、完成通知没收到、通知未送达、notifyId、pending 列表有 session 条目、B-ledger、managed-session-notify、willNotify、session-manager-ext-config。"
---

# session-manager 使用与排查指南

> @zhushanwen/pi-session-manager：agent-managed session 扩展。父 session 通过 6 个工具
> （create_managed_session / send_to_session / read_session_history / list_my_sessions /
> get_session_status / abort_session）以子 session 形态并行工作。本指南讲完成通知链、
> 账本存储与排查入口；工具契约细节（marker 通道 / 超时分档）见包 README。

## 重要前提

- 工具应答端是 taiji runtime 的 SessionManagerHandler——**只在 taiji 桌面环境可用**；
  独立 pi CLI 无 handler 应答，所有工具等待至超时后报 `cancelled or timed out`。
  工具失败时先确认运行环境，不要怀疑参数。
- 本扩展不读磁盘配置文件，无 config JSON——通知状态全部存储在 pi session 文件内
  （见 B-ledger 一节），没有「改配置文件」这条路径。

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
4. **record + 送达**：攒批结果经 B-ledger record 落账（见下节），送达为单通道
   `pi.sendMessage({triggerTurn: true})`——只在主 session 空闲时刻投递（agent_settled
   边沿复查 isIdle + 120s 看门狗兜底），送达回执按 notifyId 匹配销账（ack entry）。

通知文案形态：`Managed session "<label>" (<sessionId>) finished with status "<status>"
(exit code: N). (fulfills N request(s))`；stderr 非空时附 Stderr tail（400 字截尾）；
runtime 查得到时附 `Full transcript: <sessionFilePath>` 指针行。

**合并与数量语义**：

- 多条 queued 消息在同一轮消费合并为一次通知（fulfills N = 本批兑现笔数）；
- `create_managed_session` 还返回 `lifetimeNotifyId`：session 终局死亡（exited/deleted）
  恒产出一次死亡通知，与结果通知相互独立；
- 每 notifyId 至多一条通知（record 幂等去重），重放不重复发声。

## B-ledger 账本存储

通知落账与恢复不依赖独立磁盘文件，复用 pi session 文件本身：

- **record = session 文件自定义 entry**：通知落账走 `pi.appendEntry` 写入 session 文件
  （plain custom entry，不进 LLM 上下文），先落盘后投递——进程崩溃后债权不丢。
- **session_start 重装恢复**：每次 session_start 无条件 bind ledger host +
  recoverFromSession——吸收 session 文件全部既有账本/回执条目重建内存态（重启重放），
  按 notifyId 幂等去重：未销账债权重新投递，已销账静默。
- **session_compact 补写**：compaction 清掉账本/回执 entry 时按内存态补写
  （compactionCheck），账本不因压缩丢账。
- ledger 实体在 `@zhushanwen/subagent-core`（Symbol.for 进程级单例槽），与
  subagent-workflow 的通知账本共享同一实体——两个扩展共存时按 bind 收敛语义合并为
  单实例，互不重复投递。

## 排查入口

| 症状 | 排查路径 |
|------|---------|
| 未收到完成通知 | ① 确认 taiji 桌面环境（standalone pi CLI 无 handler，工具本身就会超时）；② 查扩展日志 `<agentDir>/logs/session-manager-YYYY-MM-DD.log`（agentDir = pi `getAgentDir()`，默认 `~/.pi/agent`，taiji 隔离环境 `~/.taiji/agent`）搜 `[session-manager]`——`notify ledger not bound`（session_start 未跑/装配失败，通知丢弃，下次 session_start 重试装配）、`watch select rejected`（watch 通道被拒）、`watch respond unusable/malformed`（runtime 应答不可解析，协议漂移信号）；③ 日志干净则确认子 session 是否真完成（get_session_status） |
| pending 列表残留 type 'session' 条目 | register 由 send/create 带 prompt 的 arm 写入，正常由 watch 应答逐条 unregister。残留 = watch 应答未达（pi 进程被杀 / runtime 重启 / 通道折叠 cancelled）；这些活跃 register 由下次 session_start 收口腿逐条重开 watch（入参 = entry id 即 notifyId），应答到达即静默注销，无需手工处理 |
| 同一完成重复通知 | 不应发生——record 按 notifyId 幂等、死亡槽 (sessionId, deathSeq) 同键只发首条。若复现即协议漂移，查扩展日志 `record failed` / `malformed` 留痕归因 |

## 工具速查

| 工具 | 说明 |
|------|------|
| `create_managed_session` | 创建子 session（cwd 必填；可选 label；可选 prompt 原子 create+send） |
| `send_to_session` | 向子 session 发 prompt（忙时排队，`queued: true` 立即返回） |
| `read_session_history` | 读子 session 对话历史（可选 tailTurns 截尾部 N 个 turn） |
| `list_my_sessions` | 列本 agent 管理的 session（顺带回填 label 缓存，修复重启后的文案 label 降级） |
| `get_session_status` | 查子 session 状态与模型信息 |
| `abort_session` | 中止运行中的子 session（终态 stopped） |
