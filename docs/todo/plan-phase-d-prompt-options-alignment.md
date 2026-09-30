# PHASE_D 散文与 buildExecOptions 选项集对齐防线（plan extension）

状态：已关闭（2026-09-27 裁决落地：能单源的先单源 + 对齐测试锁定散文锚点）。源自 code-overdesign-audit「移交：射程外发现」第 4 条；不在 plan-mode-audit-remediation 设计范围内。

## 现行防线（终态）

- **单源化（结构性消除，能做的部分）**：技能档上限 `MAX_SKILL_OPTIONS` 收敛为 prompts.ts 单一常量——PHASE_D 散文插值与 buildExecOptions 截断同源，改一处散文自动跟随；选项 label 单源 = i18n `exec.*` 词典（en/zh 双侧），散文与选项各自从词典取词。
- **对齐测试（机器锁定，散文无法整体生成的部分）**：`extensions/universal/plan/src/__tests__/exec-options-alignment.test.ts`——数量锚（散文上限 = 截断常量）、截断行为锚（超限只取前 N + 固定尾部 execute/later）、label 字面锚（选项 label 词典渲染 = 散文英文字面）、两分支行为句锚（有技能弹表单 / 无技能直通 D7②）。

## 为什么散文不能整体从选项集生成（裁决时论证）

面向模型的是英文**静态**散文（进入 plan 模式时注入，技能检测发生在 complete 时点，静态散文必须同时描述有/无技能两个分支）；选项是运行时按检测结果**动态**构造，用户侧 label 随 locale 本地化——两种语言、两个受众、静态策略 vs 动态实例。散文还承载行为描述（无技能不弹表单直通）无选项对象对应物。整体生成需要模板引擎，模板内的自由文本仍是手写——漂移被移动而非消除。故取「事实单源 + 锚点测试」混合形态。

## 证据

- 审计报告：`.tmp/code-overdesign-audit/code-overdesign-audit-20260925-1759.md`「移交：射程外发现」第 4 条（留存期至处理完成，条目内容已全文内嵌于上）
- 登记义务来源：`.tmp/tech-design/plan-mode-audit-remediation.md` §1 out of scope 尾段（移交项持久登记 = 批次 1 开工前置步）
