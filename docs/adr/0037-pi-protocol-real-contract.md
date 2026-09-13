# 0037: pi-protocol 深化为真契约

## 状态

已接受

## 上下文

[ADR-0003](archive-digest.md#adr-0003)（已推翻，摘要见 archive-digest）决定 `event-adapter.ts` 的 `translate()` 入参用 `Record<string, unknown>` 宽类型，
理由是「pi 发送 PiEvent 联合之外的事件」。当时 `pi-protocol.ts` 的 PiEvent 联合只覆盖 13 个
事件类型，而 event-adapter 运行时确实接收到 `compaction_*`、`auto_retry_*`、`extension_error`
等「联合外」事件，于是把整个 translate 入参放宽、并在多处防御性双读 fallback（`args ?? input`、
`result ?? output`）。

经核对 pi 0.80.3+ 源码：

- `AgentEvent`（pi-mono packages/agent/src/types.ts:415-430）+ `AgentSessionEvent`
  （packages/coding-agent/src/core/agent-session.ts:127-153）是完整的强类型联合，
  覆盖所有 pi 运行时会发送的事件类型。
- 序列化路径（rpc-mode.ts:354-355）直接 `JSON.stringify` 事件对象，**无字段重命名**——
  pi 发到 stdio 的字段名就是源码里的字段名。
- `AgentToolResult<T>`（types.ts:350-362）形状固定：
  `{ content: (TextContent|ImageContent)[]; details: T; addedToolNames?: string[]; terminate?: boolean }`。

结论：pi 事件协议是完整的强类型契约，「联合之外的事件」实际是 xyz-agent 的
`pi-protocol.ts` 类型定义滞后，**非 pi 协议不稳定**。防御性双读 fallback（input/output）
是死代码——pi 从不发这些字段。

## 决策

`pi-protocol.ts` 作为 pi 协议的**真契约**维护：

1. **PiEvent 联合覆盖全部 AgentSessionEvent 事件类型**。新增 10 个此前缺失的事件：
   `compaction_start`/`compaction_end`/`auto_retry_start`/`auto_retry_end`/
   `thinking_level_changed`/`queue_update`/`entry_appended`/`session_info_changed`/
   `agent_settled`/`extension_error`。
2. **translate 入参用 PiEvent 联合窄类型**（W2 落地），switch 内 default 分支兜底未知事件
   （pi 升级可能新增类型，default 仍保留运行时安全）。
3. **字段类型镜像 pi 源码**：
   - `PiToolExecutionResult` 镜像 `AgentToolResult`：content 含 text+image 块、details、
     addedToolNames、terminate。
   - `PiToolExecutionEndEvent.isError` 改为必填（pi 始终发送）。
   - `PiTurnEndEvent` 补 `message` + `toolResults`（pi 0.80.3 每 turn 带 usage）。
4. **删除防御性双读 fallback**：pi 用 `args`/`result` 是规范字段名（非漂移），
   `args ?? input`、`result ?? output` 是死代码（W2 在 event-adapter 落地删除）。

## 理由

- pi 协议稳定：已逐字段核对 0.80.3 源码，事件类型与字段均有强类型定义。
- 类型变更编译期传导：PiEvent 联合一收紧，所有消费方的窄化错误立刻浮现。
- 双读 fallback 是死代码：pi 的 rpc-mode 直接 JSON.stringify 源码对象，不可能出现
  「pi 历史用 input、现版本用 args」的漂移——字段名就是源码字段名。

## 后果

- pi 升级时 `pi-protocol.ts` 需同步维护新增事件类型。编译器 exhaustive check
  （switch over PiEvent）会提示缺失分支，这是期望的维护成本（leverage），
  而非 ADR-0003 担忧的「不可控漂移」。
- event-adapter（W2）可移除本地 `type PiEvent = Record<string, unknown>` shadow，
  改 import 真契约联合，获得编译期 exhaustive check。
- 推翻 ADR-0003 的「translate 入参用宽类型」决策（ADR-0003 状态改为「已推翻」）。
