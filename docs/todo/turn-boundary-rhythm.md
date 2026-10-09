# 轮次边界节奏档（单值 20px）

状态：已落地（M3a 对话流轮次骨架复刻，按 demo 实测值取裁决选项 2；登记来源：ui-optimize-unified D5 终态同步 2026-10-08，落地 2026-10-10）

## 现行机制

轮次边界 = Turn 根 `pb-5`（20px，`--blk-gap`）单值承载，与 demo workbench.css `.blk { margin-bottom: var(--blk-gap) }` 对齐。trace 容器无 margin-bottom；TurnSummary 悬浮化（根 `h-0` + hover-actions 绝对定位悬浮于本 turn 尾部，默认 `pointer-events-none`、悬停/焦点可命中），不占流内高度。trace 容器内两档节奏不变（`Turn.vue` 尾部相邻选择器：过程行之后 12px、正文块之后 20px）。
