# 轮次边界节奏档（单值 20px）待裁决

状态：待裁决增强项（ui-optimize-unified 决策 4 实施期核实：压到单值须重构 TurnSummary 占位结构，属交互形态变更超设计射程，D5 终态同步登记承接）。登记来源：ui-optimize-unified D5 终态同步（2026-10-08）

## 现状

决策 4 的块间两档节奏中「正文↔正文、轮次边界 20px」的轮次边界档未以单值落地。轮次边界实际由合成链承担：Turn 根 `pb-5`（20px）+ trace 容器 `mb-1`（4px）+ TurnSummary `pt-3`（12px 常驻占位，承载 hover-actions）+ 外层列表容器 gap——轮次间视觉距离 ≈ 82px，其中 TurnSummary 的 `opacity-0` hover 操作区常驻占位约 42px 是主要构成。

trace 容器内的两档已按方向差口径落地（`Turn.vue:610-620` 相邻选择器：过程行之后任意块 12px、正文块之后任意块 20px）。

## 裁决选项

1. **维持合成链现状**：轮次边界距离由 TurnSummary 占位结构自然形成，视觉上已与 zcode 同档（D3 真机对照未报过挤）。
2. **重构 TurnSummary 占位**：hover-actions 改绝对定位/悬浮不占流式空间，轮次边界压到目标值——收益：轮次边界精确 20px 档；代价：hover 操作的命中区域与流式布局交互需重新设计（属交互形态变更）。
