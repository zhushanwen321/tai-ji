# ADR 0013: sessionData API over pi.appendEntry

- 状态：Accepted（底层持久化实现后被 ADR-0014 演进为本地文件，sessionData API 决策本体仍有效）

## Context

Plugin 需要 per-session 状态持久化（如 goal 的任务进度、todo 的列表）。数据需要随 session 生灭、可被 LLM context 引用、支持 session fork/restore。

## Decision

提供 `api.sessionData` KV API，底层通过 Pi Bridge 调用 `pi.appendEntry()` 持久化在 pi session JSONL 文件中。不使用 PluginStorage（global/workspace scope 的独立 JSON 文件）做 session-scoped 数据。

## Reason

与 PluginStorage + session scope 方案对比：
- sessionData 天然跟随 pi session 生命周期（创建/销毁/fork/restore），无需额外同步逻辑
- LLM 可通过 pi 的 entry 机制直接引用 plugin 数据（如 goal 的 before_agent_start hook 注入 context），零额外 round-trip
- pi session 文件是所有 session 数据的 single source of truth，不引入第二套存储

风险：插件数据格式依赖 pi 的 entry JSON 格式。通过 sessionData 的 KV 抽象层隔离此依赖，未来换 pi 实现只改 bridge。
