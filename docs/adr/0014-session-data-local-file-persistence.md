# ADR-0014: SessionData 本地文件持久化

- 状态：Accepted

## 上下文

Plugin 系统的 `api.sessionData` 提供 per-session KV 存储。原始设计（ADR-0013）通过 Pi Bridge 走 `pi.appendEntry()` 将数据持久化在 pi 的 session JSONL 文件中。

当前 `pi.appendEntry()` API 不可用。3 处 flush 调用是 `Promise.resolve()` TODO，数据仅存内存。

## 决策

采用本地文件持久化：`~/.xyz-agent/plugins/session-data/{sessionId}.json`。

- 使用 atomic write（write-to-temp + rename）保证并发安全
- 启动时从文件恢复缓存
- 单文件 10MB 上限

## 原因

1. **独立性**：不依赖 pi bridge API 可用性，插件系统可独立工作
2. **一致性**：与 PluginStorage（globalState/workspaceState 已用 JSON 文件）模式统一
3. **可切换**：后续 bridge 就绪后，只需替换 flush 函数内部实现，不影响上层 API

## 权衡

- 代价：session 删除时需额外清理对应 JSON 文件（pi JSONL 方案天然跟随 session 生灭）
- 收益：零外部依赖，立即可用
