# edit/write 工具行 basename chip 的 diff 统计（+N −N）数据层任务

- 状态：未解决（待排期——UI 形态已预留，缺数据层供给）
- 来源：ui-optimize-unified 决策 8 N1（设计文档 §3.3）；UI 侧由 U8 落地，登记动作随 U19 收尾执行

## 现状

- edit/write 类工具行已渲染 basename chip（`packages/ui/src/features/chat/Block.vue:229-243`：工具名 + 文件 basename chip，点击开右侧 drawer 文件详情，完整路径在 title）。chip 内预留统计段插位（Block.vue:242 预留注释），当前无统计内容。
- diff 统计（`+N −N`）本波未做：`ToolCall` 契约（`packages/shared/src/message.ts:236-267`）无 per-file 增删行数字段；`details?: Record<string, unknown>`（pi tool_execution_end result.details 结构化扩展）现行不携带 diff 统计。
- 既有 `additions/deletions` 字段（`packages/shared/src/git.ts:41-43`）属 git 面板域（来源 `git diff --numstat HEAD` per-file），语义是「工作区相对 HEAD 的未提交改动」，与「单次工具调用的改动量」不同源不同义，不可直接挪用。

## 实现要点（数据层）

1. **数据来源裁决**（两候选，需先裁决）：① pi 侧结构化供给——edit/write 工具 result.details 增补增删行数（依赖 pi 上游格式，受 pi 语义边界约束，须核对 pi 实装版是否有该数据）；② taiji 自算——core/chat 域在工具结果归一化时对 diff 文本（result 内 unified diff）解析出行数统计写入 ToolCall 新字段（如 `diffStat?: { additions: number; deletions: number }`）。方向 ② 不依赖 pi 上游、口径自控，优先评估。
2. 供给字段落地后，UI 消费点 = Block.vue chip 统计段预留位（`+N −N` mono dim 形态，与工具行耗时槽同档灰阶）；`@taiji/ui` 与 core 的既有测试随批补断言。
3. 缺省语义：字段缺省（历史会话 reload / 不支持该数据的引擎）= 不渲染统计段，形态回退现状，不留空占位。
