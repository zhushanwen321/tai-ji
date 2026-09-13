# 0008-extension-bridge-for-navigate-tree

- 状态：Superseded

> **Superseded（2026-08-31）**：本 ADR 设计的 `/xyz-navigate` 桥接命令已随 runtime 侧桥接对端（navigate-result 消费端，monorepo 时代删除）一并移除，agent-ext 不再注册该命令。正文保留作历史参考。

## Context

pi 的 RPC 模式不暴露 `get_tree` 和 `navigate_tree` 命令。navigateTree 有 LLM 调用副作用（summarize），且结果通过 `extensionRunner.emit()` 返回而非 `session._emit()`，不会到达 RPC 客户端。

## Decision

通过 pi extension 注册 `/xyz-navigate` slash 命令桥接 navigateTree 能力。Extension handler 调用 `ctx.navigateTree()` 后主动 `ctx.sendMessage()` 将结果包装为 custom message 返回给 RPC 客户端。

不 patch pi 源码，不直接写入 JSONL 文件。

## Reason

三个替代方案各有利弊：
1. **Patch pi RPC**（~60 行）— 需要 fork 并维护 pi 源码，升级成本高
2. **纯读 JSONL**（零改动）— 能读取树结构，但无法执行 navigate（leafId 是内存状态）
3. **Extension 桥接**（~30 行 JS）— 不改 pi 源码，利用已有的 extension command 框架和 `commandContextActions` 绑定

方案 3 在不改 pi 源码的前提下获得了完整的 navigate 能力，且 extension 文件可以随 xyz-agent 版本控制。
