# A-summary：验收汇总判定（L4 判断型，汇总 inspect 节点）

承 `_contract.md` 公共契约。deps：全部验收节点（a5-entry-chain / a1-row-nav / a2-lifecycle-ops / a3a4-patrol）——全部终态后本节点才启动，汇总它们的事实锚产物。

## 背景与目标

D3 收口判定：不驱动真机（无新场景），核对全部验收节点产物，判 overall pass/fail，补偿脚本断言盲区，汇入交付口径。compile.md §6 汇总 inspect 节点契约。

## 步骤

1. 读全部上游节点产物（以汇总为准，仅异常读全文）：
   - a5-entry-chain：`<artifactsDir>/verdict.json` + `summary.jsonl` + `e2e-run.log`（playwright 真实进程层，E2E-REAL-01：RE1 入口链/行集归宿、RE2 D11 收起联动、RE3 挂载回归）；
   - a1-row-nav / a2-lifecycle-ops / a3a4-patrol：各自 `<artifactsDir>/verdict.json` + report.md + 关键截图。
2. 逐节点核对：verdict 与 report.md 结论一致；test_evidence 的断言与任务书通过标准逐条对应；deviations/blockers 已记录且分类合理（environment 类才允许 degraded）。
3. 兜底扫描（脚本断言盲区补偿）：扫各节点全页截图（无空面板/骨架形态错漏、无 undefined 字面文案、无错乱标题）；扫 console 错误（各节点 report 或日志中的 console 抓取）；扫各节点 report 的未决项/未覆盖登记，汇入交付口径。
4. fail 归因：任一节点 verdict=fail → 定位到场景与日志行（哪个 V 场景、哪一步、期望 vs 实际），判 spec-bug / product-bug / environment 并写入汇总——供主 agent 裁决，不在本节点修产品代码。

## 通过标准

全部上游节点 verdict=pass（或经引擎修复循环后重验 pass）且兜底扫描无未登记异常 → 本节点 verdict=pass。任一上游 fail 且无合理解释 → verdict=fail + 归因明细。environment 类 degraded 节点不阻塞 overall，但须在 test_evidence 列明影响面。

## 判定与返回

按公共契约返回 `{verdict, test_evidence, deviations, blockers}` 并落 verdict.json 到本节点 artifactsDir。test_evidence 必须含：逐节点 verdict 一览 + 兜底扫描结论 + 未决项/未覆盖登记清单（汇入交付口径用）。
