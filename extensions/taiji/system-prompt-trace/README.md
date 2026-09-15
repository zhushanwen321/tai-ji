# @zhushanwen/pi-system-prompt-trace

Session Trace 单元 1（留痕 extension）。system prompt 在 pi 中每次运行时动态重建、默认不落盘——本包在
system prompt 确立或变化时向 session JSONL 追加留痕 entry，让「resume/reload/换配置前后 prompt 到底是什么」
可追溯。

## 落盘格式

```ts
appendEntry("taiji:system-prompt", {
  version: number;                    // session 内单调递增，首条 1
  hash: string;                       // sha256(fullText) 十六进制
  reason: "initial" | "resume" | "change";
  fullText: string;                   // 完整 system prompt
  charCount: number;                  // fullText.length
  parentVersionDiffSummary?: string;  // 与上一版的行级 diff 摘要（有 parent 全文时）
});
```

## 写入时机（设计 D2 校正）

- **不在 `session_start` 写**：该事件 emit 早于 resources_discover 的 prompt 重建，快照必不完整。
- **首个 `turn_start` 写 initial/resume**：此时 `getSystemPrompt()` 已含 `before_agent_start` 注入，是最终 prompt。
- **后续每个 `turn_start`** 做 hash 对比，变化才写 `change`。

## reason 映射

`SessionStartEvent.reason` 原生 5 值（startup/reload/new/resume/fork）→ 落盘 reason：

| SessionStartEvent.reason | 落盘 reason | 状态 |
|---|---|---|
| startup / new | initial | 定案 |
| resume | resume | 定案 |
| fork / reload | resume | 定案（fork 档读源文件最后留痕，落盘 reason 维持 resume） |

存在 hash 基线（见下）且 prompt 未变时，首个 turn 不写（去重）；需写时（hash 已变）恒写 `resume`（无论 session_start reason）。

## 跨重启 hash 基线三档（优先级从高到低，权威实现见 `src/trace.ts` onSessionStart）

1. **进程内 resume（stash）**：`session_before_switch.targetSessionFile` 直读目标 session 文件，取最后一条留痕
   entry 的 hash/version/fullText。switch 会 teardown 并重建 extension runtime，该基线经模块级 stash 跨 runtime 传递。
2. **fork**：`session_start.previousSessionFile` 直读源 session 文件，取源文件最后一条留痕（常态
   /fork 时点 fork 新文件未落盘，不可直读新文件；源文件缺失/未落盘/读取失败 → 视为无基线）。
3. **直读当前 session 文件**：`ctx.sessionManager.getSessionFile()` 直读 JSONL 最后一条留痕，覆盖 reload /
   重启直 spawn resume / new 兜底等没有 switch 事件的链路（文件不存在或无留痕 → 视为无基线）。

唯一持久化源 = session JSONL 自身。

三档都 miss（无任何基线）时兜底必写：首个 turn 无论 session_start reason 必写一条——
startup/new → `initial`，resume/fork/reload → `resume`（宁可多写不可漏记）。

## 注册状态

已注册进 `packages/shared/src/mandatory-extensions.json`（feature tier，可禁不可卸）。
