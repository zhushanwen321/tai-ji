# PHASE_D 散文与 buildExecOptions 选项集无机器防线（plan extension，对齐测试缺失）

状态：未处理；二选一待裁决——补对齐测试，或接受漂移风险显式登记取舍（2026-09-26 登记，源自 code-overdesign-audit「移交：射程外发现」第 4 条；不在 plan-mode-audit-remediation 设计范围内）

## 问题

`extensions/universal/plan/src/prompts.ts:49-56`（行号为 2026-09-25 审计时点）：PHASE_D 散文描述与 `buildExecOptions` 的选项集靠注释人工同步，无机器防线。选项集已经重排过一次，再漂移会直接作用于模型行为（模型按散文理解的选项语义与实际枚举不一致）。

## 修复方向（二选一）

- 补一条对齐测试：断言 PHASE_D 散文中出现的选项字面集合 === `buildExecOptions` 实际产出集合（漂移即红）
- 显式登记取舍：接受纯注释同步，记录理由

## 证据

- 审计报告：`.tmp/code-overdesign-audit/code-overdesign-audit-20260925-1759.md`「移交：射程外发现」第 4 条（留存期至处理完成，条目内容已全文内嵌于上）
- 登记义务来源：`.tmp/tech-design/plan-mode-audit-remediation.md` §1 out of scope 尾段（移交项持久登记 = 批次 1 开工前置步）
