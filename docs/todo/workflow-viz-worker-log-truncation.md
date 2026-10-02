# workflow 事件流读通道：worker-log 帧消息未入 2KB 截断白名单

**状态**：未解决（minor，随分支带走——dev-merge 横切审查 round 2 残余，终局 PR 期复核）

**登记来源**：workflow-visualization 分支合入前横切审查（2026-10-02，问题编号 dmg-r2-1）

## 问题

`workflow-run-events-reader`（packages/runtime/src/services/session/）的事件流拉取通道对结构化字段做 2KB code point 截断（`WorkflowRunEventEntry` 的 truncatedFields 标注），但截断白名单不覆盖 worker-log 类条目的 `entry.message` 字段——该字段是无上界 string，逐字透传进 RPC reply。

当前唯一上界 = 32MB 文件级全量读预检（`FULL_READ_PRECHECK_BYTES`，packages/shared/src/constants.ts——workflow record 事件流拉取为入口⑥），即单条消息可达 MB 级仍会整体下发。

## 影响

- 正常 run 的 worker-log 行为短文本，实测影响低（判 minor 的依据）
- 异常形态（引擎把大段输出写进单条 log）会放大 reply 体积与 renderer 渲染成本，但 32MB 预检兜底不会 OOM

## 处置方向（终局 PR 期复核时二选一）

1. 把 `entry.message` 纳入截断白名单（对齐结构化字段口径，事件流 UI 已有 truncatedHint 展示形态可复用）
2. 显式登记接受理由（worker-log 原文是排障唯一证据，截断损失大于体积收益）——登记后关闭本条
