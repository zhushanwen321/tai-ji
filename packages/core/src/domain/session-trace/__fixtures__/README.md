# session-trace fixtures

测试输入数据。分两类：**real**（真实 session 复制脱敏）与 **synthetic**（手工构造，结构对齐 pi 0.84.1 源码 `session-manager.ts`）。探针 P4 双边核算（与 pi `buildContextEntries` 输出一致）直接跑这些文件。

## real（真实数据复制脱敏）

| 文件 | 源文件（fixture 为采集时点的真实 session 文件，路径为采集时点的数据目录） | 选择理由 | 脱敏内容 |
|---|---|---|---|
| `real-mixed-kinds.jsonl` | `2026-08-17T12-26-32-445Z_01a00fb0-*.jsonl`（124 行） | 类型最丰富：message（user/assistant/toolResult）×65、custom ×44（`taiji.client-msg-id` / `pending:register` / `subagents:log`）、custom_message ×2、model_change ×2、thinking_level_change ×2、session_info ×8；**7 个无 id 的 session_info 侧支不在 leaf 路径上**（path ≠ 全量 entries 的真实样本）；无 compaction | cwd、message 文本（text/thinking 块正文、toolCall arguments、toolResult content）、custom.data、custom_message.content、session_info.name |
| `real-lifecycle-small.jsonl` | `2026-05-20T05-46-38-409Z_*.jsonl`（10 行） | 小体积含 model_change + thinking_level_change + session_info + toolResult，无 custom | 同上 |
| `real-lifecycle-small.bad-lines.jsonl` | 上行文件的副本 | V7 前置：手工注入 2 行坏 JSON（第 3 行半截 JSON、第 8 行纯文本） | 同上 + 注入坏行 |
| `real-fork-header.jsonl` | `2026-08-20T10-22-02-482Z_*.jsonl`（3 行） | fork header 形态：`parentSession` 为 sessionId fallback（源 session 未落盘，`session-lifecycle.ts:521-527` 两种形态之一） | 无需脱敏（本仓测试产物：cwd 为系统临时目录、id 为合成值） |

脱敏原则：`type` / `id` / `parentId` / `timestamp` / `role` / `provider` / `model` / `usage` / `stopReason` / `isError` / `toolCallId` / `toolName` / `thinkingLevel` / `customType` / `display` / `version` 等结构字段原样保留（保语义可核算）；文本体一律 `<redacted>`。脱敏脚本一次性执行，不随 git 跟踪。

## synthetic（真实数据缺类型的等结构构造）

真实 sessions 目录中无 compaction / branch_summary / label / bashExecution / `taiji:system-prompt` custom / handoff_marker 样本，按 plan.md §3「真实数据不足时手工构造等结构 fixture 并注明」构造。字段结构对齐 pi 源码（`session-manager.ts:46-156` 的 SessionEntry 联合、`messages.ts:22-77` 的 bashExecution/custom message）与 taiji `session-file-utils.ts`（handoff_marker 无 id/parentId、session_end sidecar `.meta.json`）。

| 文件 | 场景 | 关键结构 |
|---|---|---|
| `synthetic-compaction-single.jsonl` | 单次压缩 | `firstKeptEntryId` 指向 model_change（保留区含不可进 context 的 lifecycle entry）；预期 context = `[c1, u3, u4, a3]`，影子化 = `[u1, a1, u2, a2]` |
| `synthetic-compaction-double.jsonl` | 两次压缩 | 第二次 `firstKeptEntryId` 指向第一次 compaction 自身（旧 compaction 进保留区 → 进 context）；预期 context = `[c2, c1, u2, a2, u3, a3]`，影子化 = `[u0, a0, u1, a1]`（含曾是 c1 保留头的 u1——二次压缩后影子化） |
| `synthetic-branch-side.jsonl` | 树形侧支 + branch_summary | leaf = 末行 bs2；侧支 `s1/s2/bs1` 挂 a1 下不在 leaf 路径（树回溯语义样本）；无 compaction → 全 path 进 context |
| `synthetic-full-kinds.jsonl` | 12 种行 kind 全集 | 覆盖 SESSION/SYSTEM/USER/ASSISTANT/TOOL/BASH/NOTICE×2 形态/COMPACTED/BRANCH/LIFECYCLE×4 类型/DATA/BOUNDARY(handoff_marker)；leaf 链 `sp1→…→u4`，测试传 `leafId=u4`（handoff_marker 无 parentId，默认尾 fallback 会断链——该行为另在测试内联验证） |
| `synthetic-full-kinds.jsonl.meta.json` | session_end sidecar | `done` 终态（runtime 读 sidecar 后传入，core 不读文件） |
