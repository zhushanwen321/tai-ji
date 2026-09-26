# CJK slug 数据丢失缺陷（plan extension，独立 bug 修复）

状态：缺陷 2 待修（修法已定，待独立立项）；缺陷 3（goal 展示名恒常量）已于 2026-09-27 独立修复——`buildPlanSlug` 改取计划目录名（requirement slug 段），successCriteria 总述恢复计划身份，同批提交。源自 code-overdesign-audit「移交：射程外发现」缺陷 2/3；不在 plan-mode-audit-remediation 设计范围内——该设计只动代码组织，不动业务语义

## 问题（缺陷 2）

纯中文需求进入 plan 模式时，slug 生成退化为与需求无关的常量（`extensions/universal/plan/src/enter.ts:64-66`，审计时点行号 :99-101）：纯中文经小写化 + 非法字符折叠 + 去首尾连字符后 slug 为空串，`planDir` 退化为 `<project>/.tmp/plans`（互覆路径 = `<project>/.tmp/plans/plan.md`）；requirement 为空时 slug 为 `"untitled"`。两轮不同中文计划写同一路径后者覆盖前者——数据丢失。README 首个示例即中文需求，主场景必踩。

连带（缺陷 2 未修窗口内）：`extensions/universal/plan/src/execution-notice.ts` 的 `buildPlanSlug` 以目录名为 goal 展示名，中文需求场景（plan.md 直落 `.tmp/plans`）会取到骨架名 `"plans"`——随缺陷 2 修复（目录名保唯一 slug）自然消除，无需独立处理。

## 修复方向（已论证）

缺陷 2：slug 无有效 ASCII 片段（空串与 untitled 两种退化形态）时以时间戳/短 hash 保目录唯一（bug 修复，非过度设计议题）。

## 证据

- 审计报告：`.tmp/code-overdesign-audit/code-overdesign-audit-20260925-1759.md`「移交：射程外发现」第 2 条（留存期至独立修复完成，条目内容已全文内嵌于上）
- 登记义务来源：`.tmp/tech-design/plan-mode-audit-remediation.md` §1 out of scope 尾段（移交项持久登记 = 批次 1 开工前置步）
