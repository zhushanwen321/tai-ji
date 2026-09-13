# @zhushanwen/pi-plan

轻量级规划模式 pi extension：`/plan [描述]` 触发，产出结构化 plan 文件。与 coding-workflow 的区别：无 gate / review / retrospect，只负责「想清楚再动手」的计划产出（ADR pi-ext-021 prompt-only readonly / pi-ext-022 session-manager state）。

> 本 README 的核心概念词条（Plan Mode / Plan File / Brainstorming）迁自 `docs/extensions/glossary.md`「Extension 专属概念」（2026-09-13）。

## 用法

```
/plan 修复项目中所有失败的测试   # 进入 plan mode（brainstorming 阶段开始）
/plan status                    # 查看当前阶段与 plan 文件路径
/plan abort                     # 取消活跃的 plan mode
```

## 阶段状态机

`idle → brainstorming → writing → complete`（`state.ts` PlanPhase）：

- **brainstorming**：需求探索。固定四步——1. Quick Overview（ls 项目根 / 读 README / package.json，30 秒内建立上下文）→ 2. 渐进式提问澄清需求 → 3. 方案探索 → 4. 假设审计。
- **writing**：选定模板后撰写 plan 文件。
- **complete**：完成时提示选择执行方式，恢复工具，状态重置。

## plan 工具

模型经 `plan` tool 驱动阶段流转，actions：`list-template` / `select-template` / `create-template` / `complete` / `complete-cancelled` / `abort`。

## Plan File

Plan Mode 的产出物，存储在 `.xyz-harness/{slug}/plan.md`（slug 截断 30 字符）。含 YAML frontmatter 与模板章节。进入 plan mode 时自动扫描既有 plan 文件供续写。

## 模板

内置 5 个（`templates/`）：`feature-plan` / `bugfix-plan` / `refactor-plan` / `implementation-plan` / `research-plan`。支持项目自定义模板（`listTemplates` / `loadTemplate` 按 projectDir 发现）。

## 依赖

peer 依赖 `@zhushanwen/pi-goal`（plan 完成后衔接 goal 驱动执行）。
