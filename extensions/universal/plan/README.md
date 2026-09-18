# @zhushanwen/pi-plan

轻量级规划模式 pi extension：`/plan [描述]` 触发，产出结构化 plan 文件。与 coding-workflow 的区别：无 gate / review / retrospect，只负责「想清楚再动手」的计划产出。

## 用法

```
/plan 修复项目中所有失败的测试   # 进入 plan mode（brainstorming 阶段开始）
/plan status                    # 查看 plan mode 状态与 plan 文件路径
/plan abort                     # 取消活跃的 plan mode
```

## 阶段流转

状态只有 active / idle 两态（`state.ts` `PlanState.isActive`，经 `plan-state` custom entry 持久化，session 重开时重建）；阶段流转由进入 plan mode 时注入的 prompt 指令驱动：

- **brainstorming**：需求探索。固定五步——1. Quick Overview（ls 项目根 / 读 README / package.json，30 秒内建立上下文）→ 2. 先探索后提问（grep/read 代码优先，只问用户偏好）→ 3. 渐进式提问（每次 2-3 个问题）→ 4. 方案探索（提出 2-3 个方案与取舍建议）→ 5. 假设审计（grep 验证接口/类型存在，无法验证的标 [UNVERIFIED]）。
- **writing**：选定模板后撰写 plan 文件。
- **complete**：完成时经对话框选择执行方式（subagent / goal / single-agent），恢复工具集，状态重置。

进入 plan mode 时工具集收紧为 `read` / `bash` / `grep` / `find` / `ls` / `plan`（只读约束由注入 prompt 声明），abort / complete 时恢复全量工具。

## plan 工具

模型经 `plan` tool 驱动阶段流转，actions：`list-template` / `select-template` / `complete` / `abort`。`complete` 可带 `isolation`（`compact` / `direct`，默认 `direct`）选择执行隔离方式；用户取消时返回 `complete-cancelled` 详情、留在 plan mode。plan 内容本身不经该工具写入——统一经 bash 写 plan.md。

## Plan File

Plan Mode 的产出物，存储在 `.taiji-harness/{slug}/plan.md`（slug 截断 30 字符）。含 YAML frontmatter 与模板章节。`/plan` 不带参数时自动扫描 `.taiji-harness/` 下既有 plan 文件，提供续写 / 执行 / 新建选项；无既有 plan 文件时直接进入 plan mode（slug 为 `untitled`）。

## 模板

内置 5 个（`templates/`）：`feature-plan` / `bugfix-plan` / `refactor-plan` / `implementation-plan` / `research-plan`（`listTemplates` / `loadTemplate` 扫描内置模板目录发现）。

## 依赖

optional peer 依赖 `@zhushanwen/pi-goal`（plan 完成后衔接 goal 驱动执行；未加载时 complete 对话框不提供 goal 选项）。
