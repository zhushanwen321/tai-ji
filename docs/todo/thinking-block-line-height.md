# thinking 展开区行高跳变待裁决（1.7/1.8 混合）

状态：待裁决（D5 终态同步 contested 裁决：thinking 行高不在 ui-optimize-unified 决策 7「正文行高 1.7→1.8」射程内，两个统一方向均未裁决，本波行为不动）。登记来源：ui-optimize-unified D5 终态同步（2026-10-08）

## 现状（2026-10-08 核实）

决策 7 落地后 `MarkdownRenderer.vue` 的 p/li `line-height: 1.8` 是全局规则（不分 variant），产生三处不一致：

1. thinking 展开区内的 markdown 段落实际行高已随本波从 1.7 变 1.8（全局规则无 variant 覆盖）；
2. `Block.vue` thinking 展开区容器仍 `leading-[1.7]`——working 态直挂文本（非 markdown 段）走 1.7；
3. 同一 thinking 块 streaming 中（`whitespace-pre-wrap` 直挂文本，1.7）与流结束 markdown 化后（p 规则，1.8）存在约 0.1×字号的行高跳变。

## 裁决选项

1. **thinking 容器随 1.8**：`Block.vue` thinking 容器 `leading-[1.7]` → `leading-[1.8]`，直挂文本与 markdown 段一致，消除跳变；thinking 是过程行，行高与正文一致弱化其视觉区分。
2. **variant 覆盖回 1.7**：MarkdownRenderer 增加 thinking variant 的 p/li 行高覆盖，thinking 区整体 1.7（过程行更紧凑的既有节奏）；代价 = variant 机制新增。
