# @zhushanwen/pi-plan

轻量级规划模式 pi extension：`/plan [描述]` 触发，只读探索并产出结构化计划文档。与 coding-workflow 的区别：无 gate / review / retrospect，只负责「想清楚再动手」的计划产出（ADR pi-ext-021 prompt-only readonly / pi-ext-022 session-manager state）。

## 用法

```
/plan 修复项目中所有失败的测试                      # 进入 plan mode（模板流程）
/plan 重构 auth 模块 --skills tech-design,dev-flow  # 进入 plan mode（挂载技能流程）
/plan status                                       # 查看状态、技能与产物清单
/plan abort                                        # 取消活跃的 plan mode
```

`--skills` 接受逗号分隔的技能名（按逗号原样切分 + 去首尾空格，含中文/内部空格的技能名不丢字符）。技能名经 `pi.getCommands()` 的 `source === "skill"` 枚举校验，不存在则不进入计划模式并回复可用技能清单。未指定 `--skills` 时回落内置模板流程。

## 计划态生命周期

进入后 agent 限只读工具集（read/bash/grep/find/ls/plan），按注入提示词产出文档：

- **技能流程**（挂载 `--skills`）：按技能 SKILL.md 流程产出文档（AI 自行 read 技能文件）。
- **模板流程**（未挂载）：内置 5 模板选型后撰写 plan.md。

文档全部就绪后调 `submit-review` 提交审阅；taiji 宿主（`TAIJI_AGENT_EXT_LOG=1`）挂 `PLAN_REVIEW_MARKER` select 弹 GUI 审批（确认执行 / 提交评论修订 / 请求进一步解释），独立 pi 返回文本软门（对话中反馈评论，满意后调 `complete`）。

## plan 工具

模型经 `plan` tool 驱动状态流转，actions 六项：`list-template` / `select-template` / `register-doc` / `submit-review` / `complete` / `abort`。

- `register-doc`：登记一份产物文档（同 fileName 重登 = version+1 覆盖），供 GUI 产物 tab 展示与内容刷新。
- `submit-review`：全部文档就绪后请求审阅。docs 为空或计划态已退出时返回错误提示（E6 双守卫）。
- `complete` / `abort`：退出计划态，恢复工具集；状态落 isActive=false + docs 保留（产物跨重开留存）。

## Plan File

模板流程的产出物，存储在 `.taiji-harness/{slug}/plan.md`（slug 截断 30 字符）。含 YAML frontmatter 与模板章节。进入 plan mode 时自动扫描既有 plan 文件供续写。技能流程的产物文档同写在该目录下，经 `register-doc` 登记。

## 模板

内置 5 个（`templates/`）：`feature-plan` / `bugfix-plan` / `refactor-plan` / `implementation-plan` / `research-plan`。支持项目自定义模板（`listTemplates` / `loadTemplate` 按 projectDir 发现）。

## 依赖

peer 依赖 `@zhushanwen/pi-goal`（plan 完成后衔接 goal 驱动执行）；`@zhushanwen/extension-protocol`（PLAN_REVIEW_MARKER + PlanReviewRequest/Response 契约）。
