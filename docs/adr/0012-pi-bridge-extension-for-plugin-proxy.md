# ADR 0012: Pi Bridge Extension for Plugin Tool Proxy

- 状态：Accepted

## Context

xyz-agent plugin 运行在 sidecar 的 Worker Thread 中，但 LLM 的 tool call 决策和执行在 pi 进程内。需要一个机制让 pi 能调用 Worker Thread 中的 plugin tool handler。

## Decision

采用 Pi Bridge Extension 方案：一个特殊的 pi extension 作为唯一适配层，向 pi 注册"代理 tool"，收到 execute 请求后通过 extension_ui_request 协议转发到 sidecar，sidecar 路由到 Worker Thread 执行。

## Reason

与 RPC 拦截方案（在 sidecar 事件流中拦截 tool call）对比：
- Bridge 方案解耦了插件系统与 pi 内部实现，pi 升级只改 bridge 一个文件
- Bridge 可以主动发请求（tool execute、appendEntry），RPC 拦截只能被动监听
- 插件开发者完全不感知 pi，只学 agentAPI

Bridge 复用了已有的 extension_ui_request/response 协议，不发明新的跨进程通信方式。
