---
"@zhushanwen/subagent-core": patch
---

review-fix-loop 的 suggestion 进入问题台账：aggregator 返回 suggestion_ids，R1/R2+ 与 must-fix 同源追踪；suggestion>0 但 suggestion_ids 缺失/条数不足视为聚合缺陷（重试一次后 aggregator-failure，不再只 WARN 放行）；fixer 任务文档覆盖 suggestion、ES3 覆盖校验对未处理的 active suggestion 判 fix-failure、R2 对账与终态残留清单覆盖 suggestion——修复 suggestion 只在 markdown 表中、漏修仍可达 clean 终态的问题。
