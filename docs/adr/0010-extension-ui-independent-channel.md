# ADR-0010: Extension UI 使用独立事件通道

- 状态：Accepted

## 上下文

pi extension 通过 `ctx.ui.confirm/select` 发起的 UI 交互请求，当前在 EventAdapter 中被翻译为 `message.tool_call_pending`（与 Tool Approval 共用通道）。但两者语义完全不同：Extension UI 是交互请求，Tool Approval 是权限控制。

## 决策

为 Extension UI 建立独立的事件通道（`extension.ui_request` / `extension.ui_response`），不复用 Tool Approval 的 `message.tool_call_pending`。前端有独立的 `useExtensionUI` composable 处理。

## 理由

1. 语义隔离：extension 交互（confirm/select/input/notify）vs 权限控制（allow/deny/always allow），UI 模式和数据模型完全不同
2. 扩展性：pi extension 未来可能有更多 UI method，不应受 Tool Approval 的 binary 模型限制
3. 错误隔离：Tool Approval 的超时/默认行为不应影响 extension UI，反之亦然
