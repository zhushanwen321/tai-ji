# ADR-022: Plan Mode 状态存储使用 sessionManager

## Status

Accepted

## Context

Plan Mode 需要持久化 session 状态（active、planFilePath、phase 等）。存储方案有两种：

1. **闭包变量**：在 `session_start` 时重建闭包，状态在闭包内
2. **ctx.sessionManager**：通过 `appendEntry("plan-state", data)` 持久化

## Decision

采用 ctx.sessionManager，不用闭包变量。

## Consequences

**正面**：
- 天然 per-session 隔离，同一 Pi 进程多 session 时互不干扰
- 状态可被 `session_before_compact` 和 `session_before_tree` handler 读取
- 与 coding-workflow 的状态管理方式一致

**负面**：
- 每次状态变更需要调用 `appendEntry`，有 I/O 开销（极小）
- 需要在 `session_start` 时从 entries 重建状态（增加启动时间约 1ms）
