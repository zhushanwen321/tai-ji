# @zhushanwen/pi-plan

轻量级规划模式 pi extension：`/plan [描述]` 触发，只读探索并产出结构化计划文档。与 coding-workflow 的区别：无 gate / review / retrospect，只负责「想清楚再动手」的计划产出（ADR pi-ext-021 prompt-only readonly / pi-ext-022 session-manager state）。

## 用法

```
/plan 修复项目中所有失败的测试                      # 进入 plan mode（模板流程）
/plan 重构 auth 模块 --skills tech-design,dev-flow  # 进入 plan mode（挂载技能流程）
/plan 复盘事故 --template ~/docs/retro.md           # 进入 plan mode（直传模板文件）
/plan status                                       # 查看状态、技能与产物清单
/plan abort                                        # 取消活跃的 plan mode
```

`--skills` 接受逗号分隔的技能名（按逗号原样切分 + 去首尾空格，含中文/内部空格的技能名不丢字符）。技能名经 `pi.getCommands()` 的 `source === "skill"` 枚举校验，不存在则不进入计划模式并回复可用技能清单。未指定 `--skills` 时回落模板流程。

`--template <path>` 直传任意外部 md 文件作模板（与 `--skills` 互斥，同给 fail-fast）：`~` 前缀展开、含空格路径无需引号（flag 后整段即路径）；文件不存在 / 非 .md 分别报错（不进入计划态）。进入后提示词内嵌该文件全文且不注入模板清单段，无需 select-template。

## 计划态生命周期

进入后 agent 限只读工具集（read/bash/grep/find/ls/plan），按注入提示词产出文档：

- **技能流程**（挂载 `--skills`）：按技能 SKILL.md 流程产出文档（AI 自行 read 技能文件）。
- **模板流程**（未挂载）：从三源发现的模板清单中选型后撰写 plan.md（见下节）。

文档全部就绪后调 `submit-review` 提交审阅；taiji 宿主（`TAIJI_AGENT_EXT_LOG=1`）挂 `PLAN_REVIEW_MARKER` select 弹 GUI 审批（确认执行 / 提交评论修订 / 请求进一步解释），独立 pi 返回文本软门（对话中反馈评论，满意后调 `complete`）。

## plan 工具

模型经 `plan` tool 驱动状态流转，actions 五项：`select-template` / `register-doc` / `submit-review` / `complete` / `abort`。

- `register-doc`：登记一份产物文档（同 fileName 重登 = version+1 覆盖），供 GUI 产物 tab 展示与内容刷新。
- `submit-review`：全部文档就绪后请求审阅。docs 为空或计划态已退出时返回错误提示（E6 双守卫）。
- `complete`：先弹执行方式选择（GUI 宿主经统一表单协议单 choice 问题）。选项 = 内置 Develop (auto-parallel)（LLM 自判复杂度：独立任务派 subagent 并行、小步/紧耦合本会话直执）+ 自动检测的 `plan-exec: true` skill + goal 档（能力在场时）+ 两个留在 plan mode 选项（Modify the plan first / Save for later）。headless 无 UI 默认 develop 不弹选择；通道失败（channel-error / non-json）与用户取消同折叠为 complete-cancelled result，留在 plan mode 不炸 turn。
- `abort`：直接退出。两者退出后恢复工具集；状态落 isActive=false + docs 保留（产物跨重开留存）。

## 执行方式与 plan-exec skill

`complete` 选项中的 skill 档来自运行时自动检测：skill 作者在 SKILL.md frontmatter 标记 `plan-exec: true`，该 skill 即被提议为执行方式（label `Execute via skill: <name>`）。检测对过 description 必填门的 skill 二次读 frontmatter 判定；`disable-model-invocation` 与 plan-exec 并存不过滤。

四根扫描（单根枚举复用 pi 公开导出的 `loadSkillsFromDir`，跨根组装同构 pi 本体加载序）：project `.pi/skills` → 祖先链 `.agents/skills`（近→远，git root 级含）→ `<agentDir>/skills` → `~/.agents/skills`；同名 first-writer-wins + realPath 去重；untrusted 项目跳过前两族。complete 时现扫无缓存（技能热装即见）。

检测失败降级为空集，绝不炸 complete 交互闭环：每根 existsSync 守卫 + 整根 try/catch（EACCES 等 fs 错 → 跳过该根 + warn），单 skill frontmatter 读/解析失败跳过该项。

## Plan File

模板流程的产出物，存储在 `.taiji-harness/{slug}/plan.md`（slug 截断 30 字符）。含 YAML frontmatter 与模板章节。进入 plan mode 时自动扫描既有 plan 文件供续写。技能流程的产物文档同写在该目录下，经 `register-doc` 登记。

## 模板

三源发现（同名 last-writer-wins，项目 > 用户 > 内置）：

1. **内置**（包内 `templates/`）：`feature-plan` / `bugfix-plan` / `refactor-plan` / `implementation-plan` / `research-plan`
2. **用户级** `~/.agents/plans/*.md`：个人模板投放点
3. **项目级** `<project>/.agents/plans/*.md`：项目/团队模板投放点（项目级覆盖用户级覆盖内置）

进入计划态时全量清单以 `<available-plans>` 段随提示词一次性注入（name + location），模型自选后调 `select-template`——返回的 content 携带胜者文件全文（章节骨架直达，无需再 read）；错名报错自带可用清单，模型当场自愈。`--template <path>` 直传时跳过选型（见用法节）。

**goal 桥结构建议**：自定义模板（含直传文件）建议包含 `## Implementation Steps` 编号步骤节——`complete` 选 goal 档执行时步骤提取（`extractPlanSteps` 正则）硬依赖该节；无该节会退化到 fallback（扫全部编号项，可能收进其他节噪音）或提取失败（no-steps 启动失败，有恢复文案）。

## 依赖

依赖：`@zhushanwen/extension-protocol`（PLAN_REVIEW_MARKER + PlanReviewRequest/Response 契约 + ui-form（`uiFormInteract` / `FormQuestion`，统一提问表单协议），dependencies）；peer 依赖：`@zhushanwen/pi-goal`（plan 完成后衔接 goal 驱动执行）。
