# u3 渲染归宿核对记录（P1.3）

日期：2026-09-16 | 结论：**预期零代码改动成立，三处消费点零改 + 行为推演全部通过**

## 核对项

### 1. `packages/core/src/domain/chat/message-turns.ts:699-701` —— 零改 ✓

```ts
function isAgentgraphToolName(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName) || WORKFLOW_TOOL_NAMES.has(toolName)
}
```

推演：`'subagents' ∈ WORKFLOW_TOOL_NAMES`（u2 已收录，constants.ts:32 核实）→ 并集为 true → toolCall 块归 `agentgraph` kind（主路径/降级路径共用 toolBlockOf）。✓

### 2. `packages/runtime/src/services/session/event-interpreter.ts:1011-1016` —— 零改 ✓

```ts
if (SUBAGENT_TOOL_NAMES.has(toolName)) { this.opts.onRecordEntriesInvalidated?.(this.sessionId, 'subagent-record') }
if (WORKFLOW_TOOL_NAMES.has(toolName))  { this.opts.onRecordEntriesInvalidated?.(this.sessionId, 'workflow-record') }
```

推演：两个独立 if，`subagents` 只命中第二个 → 失效兜底信号打 `'workflow-record'`，与批量 run 的 record 快照实际形态（`jsonl-run-store.ts` W17 写的 workflow-record entry）一致；不会误打 `'subagent-record'`（双收录被否的核心理由）。✓

### 3. `packages/ui/src/features/chat/Block.vue` —— 零改 ✓

- L434-435：`isSubagent` / `isWorkflow` 两个独立 computed（集合判定，非 kind 判定）
- 模板分支：L99 `<BlockSubagent v-if="isSubagent">` → L102 `<div v-else-if="isWorkflow" class="trace-workflow" data-testid="workflow-block">` → L121 `<div v-else>`（普通 tool）
- L102-120 workflow 块分支 = 单行：icon + WORKFLOW 前缀 + 状态 + `workflowFields`（读 `input.slug`，模型 args）+ L106 `@click="openWorkflowDrawer"`；**无展开区**（展开区仅在 L183 普通 tool 分支的 `<template v-else>` 内——D8「__gui__ 构造是死代码」裁决的源码依据）
- 推演：`subagents` → `isSubagent=false`、`isWorkflow=true` → 走 L102 恒折叠单行块，点击开 drawer workflow tab（批量成员以 agent call 形态入列）。模型未传 slug 时 `workflowFields.slug=''` → 块面 = icon + WORKFLOW 前缀零批次信息（D8 登记的可接受形态，runId 在返回文本可定位）。✓

### 4. 三包零 diff 佐证 ✓

本流水线 commit（672f0e6c3 / fce282acf / 计划 commit）文件清单不含 `packages/ui`、`packages/core`、`packages/runtime` 任何文件；`git status --short` 核对时同步确认无这三个包的 diff。

## 附带发现（非本单元职责，按 D8 登记项）

- `Block.vue:96` 模板注释「workflow（pi-workflow 的 "workflow" tool）：list-checks ICON + WORKFLOW. prefix + **list-tree GUI**」与实际实现（恒折叠单行，无 list-tree）漂移——设计 D8 已登记此漂移「实施期顺手登记」，本单元记录留档；注释修正不在本流水线领地（packages/ui 零改动裁决），列入阶段 3 一致性审查的合理偏差（docs/注释类遗留）。

## 阶段 5 补验项

- GUI 真机截图（taiji dev app + `TAIJI_DEV_BACKGROUND=1`）：批量调用块恒折叠单行显示 + 点击开 drawer workflow tab + 成员 agent call 入列——并入 A8。
