# 对话发送与流式渲染

> **补充（2026-10-21）**：逐能力的断言与失败信号见 `capabilities/chat.md`（`chat.send/stream/wait/abort/steer/revoke/reload-equiv`）。本文件是 UI 叙事版。

用户发消息后看到完整回合：user 气泡 → assistant 流式回复（thinking 块 / 工具调用块 / 文本块）→ 变更集卡 → 收尾；流式中可 steer 追加、可停止中断。这是 taiji 的核心高频路径。

## Sub-features

- `cs-send` 发送（⏎ 或发送按钮）→ user 气泡立即入流。
- `cs-thinking` thinking 块出现（流式中展开，完成后收起只剩 header 与预览）。
- `cs-tool` 工具调用块（工具名 + 输入输出；running/failed 强制展开）。
- `cs-text` 文本逐字追加（streaming 光标）。
- `cs-changeset` 变更集卡（ accumulating → ready，列文件与状态）。
- `cs-abort` 流式中停止按钮中断回合，isGenerating 复位、UI 不卡死。
- `cs-steer` 流式中输入 + ⏎ 追加消息（不打断当前回合）。
- `cs-complete` 回合完成：turn-meta 转完成态、usage 回填、停止按钮回发送按钮。

## How to get to it (user POV)

- 活跃 session 的 composer 输入区：输入文本 → ⏎ 或点「发送」；流式中按钮变「停止」；流式中再输入 → ⏎ 走 steer 投递路径。

## Driving it with browser-automation (CDP)

Preconditions:

- doctor 全绿；**faux 装配实例**（本功能全部子项都吃 LLM 轮次）。
- faux 响应脚本示例（两轮，覆盖 thinking/工具/文本/变更集可用多 step 编排）：

```json
[
  { "thinking": "分析请求", "toolCalls": [{ "name": "read", "args": { "path": "README.md" } }], "stopReason": "toolUse" },
  { "text": "已完成读取，结论如下。", "stopReason": "stop" }
]
```

  拉长流式窗口加 env `TAIJI_FAUX_TPS=5`。

- **建 session 进对话流。** 按 new-task 剧本首发提交，等 `turn-0` 出现。
- **发送与流式。** `getByRole('textbox')` `pressSequentially('第二问')` + Enter。观察：user 气泡可见；流式中发送按钮 title 变「停止」；thinking 块 header（「思考」文本）出现；工具块 header `tool-block-header` 含工具名；文本在 `block-text` 逐字增长（`TAIJI_FAUX_TPS` 低速时中途截图一次）。
- **完成态。** 等 `message.complete`：停止按钮消失、发送按钮回归；turn-meta 出现完成态（badge 计思考/工具次数）。
- **中断。** 再发一轮（脚本里给一个长回复 step，配合低 tps），流式中点 `getByTitle('停止')` → 回合转中断态，isGenerating 复位（可再发新消息验证未卡死）。
- **steer。** 流式中输入追加文本 + Enter → 不打断当前回合，队列指示出现、回合继续完成后有响应。
- **副作用取证。** `<dataDir>/ext-sessions/<sessionId>/logs/pi-<date>.jsonl` 有该轮 tool call 与回复记录；`agent/` 下 session jsonl 落盘（首 assistant 后）。
- **Proof。** 截图（流式中 + 完成态 + 中断态）+ DOM 断言输出 + pi jsonl 的 grep 行。

## Gotchas

- thinking 全文在完成后收起（v-if 不在 DOM）：断言 thinking **header 恒显**，不断言全文；展开全文要先点 header。
- 工具块 header 是两个独立 span（「工具」+ 工具名），跨 span 的 getByText 不可靠：限定 `.trace-tool` 容器后断言工具名文本。
- user 输入文本会回显进部分回复形态造成 getByText 双匹配：断言用 assistant 独有文本（faux 脚本里让回复 ≠ 输入）。
- faux 脚本是**队列逐轮出队**：每发一轮消息消耗一个 step；step 耗尽后无回复（不是挂死）。多轮验收要排足 step。
- `TAIJI_FAUX_TPS` 只在有该 env 时生效；没设时回复瞬时到达，断言「流式中」类中途态会错过窗口。
- 中断后 pi session 文件与 GUI 状态最终一致（live ≡ reload）：需要时重开 session 复核对话流一致。
