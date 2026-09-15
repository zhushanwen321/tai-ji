# ADR-002: Goal 7 态状态机（time_limited + cancelled）

Pi 的 Goal 状态机有 7 种状态，比参考对象 Codex（6 态）多了 `time_limited` 和 `cancelled` 两个终态，少了 `usage_limited`。

`time_limited` 让时间预算成为一等公民——Codex 追踪墙钟时间但不强制执行，没有专属终态。Pi 选择在 `agent_end` 中检测并自动转为 `time_limited`，与 `budget_limited`（token 耗尽）对称。

`cancelled` 保留审计痕迹。Codex 的 `/goal clear` 直接从数据库删除；Pi 先将状态标记为 `cancelled` 持久化到 entry，再清理内存。在 Entry-based 持久化模型下，已写入的 entry 无法"删除"，所以需要一个显式的 cancelled 状态。

没有 `usage_limited`（Codex 的 session 级用量上限），因为 Pi 的 Extension 模型不控制 session 级资源配额。
