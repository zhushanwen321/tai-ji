# ADR-021: Plan Mode 只读约束采用提示词 + setActiveTools 双重保障

## Status

Accepted

## Context

Plan Mode 需要约束 AI 在规划期间不执行写入操作（编辑代码文件、运行写入类命令）。实现方案有三种：

1. **提示词驱动**：在 plan mode 进入时通过 `sendUserMessage` 告知 AI 禁止写入
2. **tool_call 事件拦截**：通过 `pi.on("before_tool_call", ...)` 拦截 BashTool 和 EditTool，白名单放行 plan 文件操作
3. **工具白名单**：通过 `pi.setActiveTools()` 限制可用工具集为只读工具 + plan tool

## Decision

采用提示词 + `setActiveTools()` 工具白名单双重保障，不做 `tool_call` 事件拦截。

具体实现：
- 进入 plan mode 时调用 `pi.setActiveTools(["read", "bash", "grep", "find", "ls", "plan"])` 限制工具集
- 同时通过 `sendUserMessage` 注入只读约束提示词（提示词提供上下文解释，白名单提供强制约束）
- 退出 plan mode 时调用 `pi.setActiveTools(undefined)` 恢复默认工具集

## Consequences

**正面**：
- 实现简单，无需维护 bash 命令白名单
- 双重保障：即使提示词被忽略，工具白名单也会阻止写入操作
- `setActiveTools(undefined)` 恢复默认，不需要硬编码完整工具列表
- 与 coding-workflow 的只读约束思路一致（提示词驱动），同时增加了工具级强制

**负面**：
- `setActiveTools` 白名单可能过于严格，未来添加新工具时需要同步更新白名单
- `bash` 工具仍在白名单中（只读场景需要），AI 仍可通过 bash 执行写入命令（提示词约束覆盖此场景）

**风险缓解**：
- bash 写入操作通过提示词约束覆盖，违规操作可通过 git diff 发现
- 用户可在 plan mode 中随时 abort
- 白名单集中定义在 command.ts 的 `handleEnterPlanMode` 函数中，维护成本低
