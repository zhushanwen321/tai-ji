# CJK slug 数据丢失缺陷（plan extension，缺陷 2/3 同族，独立 bug 修复）

状态：未修复；修法已定，待独立立项（2026-09-26 登记，源自 code-overdesign-audit「移交：射程外发现」缺陷 2/3；不在 plan-mode-audit-remediation 设计范围内——该设计只动代码组织，不动业务语义）

## 问题

纯中文需求进入 plan 模式时，slug 生成退化为与需求无关的常量（`extensions/universal/plan/src/enter.ts:64-66`，审计时点行号 :99-101）：纯中文经小写化 + 非法字符折叠 + 去首尾连字符后 slug 为空串，`planDir` 退化为 `<project>/.tmp/plans`（互覆路径 = `<project>/.tmp/plans/plan.md`）；requirement 为空时 slug 为 `"untitled"`。两轮不同中文计划写同一路径后者覆盖前者——数据丢失。README 首个示例即中文需求，主场景必踩。

同族连带（缺陷 3）：`buildPlanSlug` / `buildPlanSuccessCriteria`（`execution-notice.ts:59`/:95，2026-09-27 前位于 compact.ts:108-152）在常量上运转——`planFilePath` 唯一赋值点（`enter.ts:105`）恒为 `plan.md`，slug 恒 `"plan"`，goal 显示名无区分度、successCriteria 首条丢 plan 身份信息。execution-notice.test.ts（原名 compact-handler.test.ts）的 planFilePath fixture 已于批次 3 条目 6（提交 1f7f1ded5）改为生产真实形态（`<project>/.tmp/plans/<slug>/plan.md`），恒等输出已如实暴露；success-criteria-array.test.ts（原名 compact-criteria-array.test.ts）仍用 `/tmp/plan.md` 但仅测数组形态，路径非掩盖面。

## 修复方向（已论证）

- 缺陷 2：slug 无有效 ASCII 片段（空串与 untitled 两种退化形态）时以时间戳/短 hash 保目录唯一（bug 修复，非过度设计议题）
- 缺陷 3：随缺陷 2 一并修——`buildPlanSlug` 改取 `basename(dirname(planFilePath))`（即 enter 期 slug），successCriteria 恢复 plan 身份信息

## 证据

- 审计报告：`.tmp/code-overdesign-audit/code-overdesign-audit-20260925-1759.md`「移交：射程外发现」第 2/3 条（留存期至独立修复完成，条目内容已全文内嵌于上）
- 登记义务来源：`.tmp/tech-design/plan-mode-audit-remediation.md` §1 out of scope 尾段（移交项持久登记 = 批次 1 开工前置步）
