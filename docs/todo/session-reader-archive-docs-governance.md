# session-reader 归档文档治理（待裁决）

**状态**：待用户裁决（2026-10-02 workflow-visualization D5 终态同步呈报，contested F4-2/F5-2）

## 问题

`extensions/universal/session-reader/docs/` 下两份日期命名调研归档文档的去留：

1. `2026-08-10-subagent-workflow-reading.md`：定义 RunSnapshot 为「workflow run 的单行 rewrite JSON 快照」并含行号级引用（jsonl-run-store.ts:242/:265 等）——快照写入机制已随 record store 单模式收敛消亡（shared/workflow.ts 头注释「快照文件已删」），行号锚点对现行代码漂移（实数 14 处 RunSnapshot 引用）；但该文档描述的 v1 磁盘形态仍被 session-reader 兼容读消费（对齐磁盘事实）。
2. `2026-08-10-cwd-popup-redesign.md`：session-reader TUI 弹窗设计快照（头标注「设计层性质」），无「不对齐现行代码」免责锚。

## 张力

`docs/extensions/extension-conventions.md`「决策记录与设计文档归属 [MANDATORY]」规定包内历史档案族「不再新建、不再回填；已失效的删除」——「已失效」判定从未对这两份文档执行过；是否追溯执行属纪律解释（日期命名调研快照是否属「docs/adr/、docs/design/ 一类」）。ADR-0095 保留项清理清单未覆盖它们。

## 候选

- A. 删除两份（git 可追溯；session-reader 的 v1 兼容读语义已由现行代码承载）
- B. 保留 + 头部加「不对齐现行代码」免责锚（对齐磁盘事实的调研价值保留）

**裁决记录**：（待填）
