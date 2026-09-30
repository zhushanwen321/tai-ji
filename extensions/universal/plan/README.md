# @zhushanwen/pi-plan

轻量级规划模式 pi extension：`/plan [描述]` 触发，只读探索并产出结构化计划文档。与 coding-workflow 的区别：无 retrospect/回顾环节与自动 gate，只负责「想清楚再动手」的计划产出 + 执行前的用户审批（ADR pi-ext-021 prompt-only readonly / pi-ext-022 session-manager state）。

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

进入后 agent 限只读工具集（read/bash/grep/find/ls/plan/ask_user——ask_user 供探索期向用户提问，D10），按注入提示词产出文档：

- **技能流程**（挂载 `--skills`）：按技能 SKILL.md 流程产出文档（AI 自行 read 技能文件）。
- **模板流程**（未挂载）：从三源发现的模板清单中选型后撰写 plan.md（见下节）。

文档全部就绪后先自审（对照需求逐条核覆盖 / 假设审计 / 章节完整性 / 验收场景可执行，自审发现的问题先修文档），再调 `submit-review`（必带 `selfReview` 自审结论）提交审阅；taiji rpc 宿主（`TAIJI_AGENT_EXT_LOG=1` 且 rpc 模式）挂 `PLAN_REVIEW_MARKER` select 弹 GUI 审批三键（approve 确认执行 / revise 提交评论修订 / dismiss 搁置——非破坏协议级决策，plan 模式保持、进度不变、被搁置的审批不复活），独立 pi / 非 rpc 形态返回文本软门（对话中反馈评论，满意后调 `complete`）。注意区分「dismiss 搁置」（用户第三键决策）与「取消/超时」（选择框被解散，非批准、不丢状态）。

## plan 工具

模型经 `plan` tool 驱动状态流转，actions 六项：`enter` / `select-template` / `register-doc` / `submit-review` / `complete` / `abort`。

- `register-doc`：登记一份产物文档（同 fileName 重登 = version+1 覆盖），供 GUI 产物 tab 展示与内容刷新。
- `submit-review`：全部文档就绪后请求审阅。**必带非空 `selfReview`（自审硬门，无豁免，含修订后重挂）**：缺失/空 → 纠偏错误不挂审批；文档已变而 selfReview 与上次逐字节相同 → 防照抄袭拒收（必须对新版本重做自审）。docs 为空或计划态已退出时返回错误提示（E6 双守卫）。
- `complete`：经审批闸口进入执行方式选择（approve 边 → dispatching；未经审批直调被拒并指回 submit-review）。有 plan-exec 技能时弹执行方式选择（GUI 宿主经统一表单协议单 choice 问题）：选项 = ≤2 个技能档（label `Execute via skill: <name>`）+ Execute 档（goal 跟踪已整合：可用时先建 goal 跟踪，再按复杂度派发 subagent 并行、小步/紧耦合本会话直执）+ 暂不执行（later 边：状态落「已批准」，可再调 `complete` 重新选择）。**无 plan-exec 技能（含检测失败降级）时不弹表单，直通 execute**（工具结果明示「无 plan-exec 技能，直接执行」）。无选择解散归口（dissolvedBy 解散来源直传判别）：外部解散（取消/超时/channel-error/non-json）→ review_aborted 边落「已批准」（批准事实保留，可再调 `complete`）；命令解散（`/plan abort` 等 reset 已介入）→ 归口 no-op 不覆写终态。headless 无 UI 默认 execute 不弹选择。
- `abort`：直接退出。complete/abort 退出后恢复工具集；状态落终态两值 `completed`（批准并派发执行）/ `exited`（主动退出）+ isActive=false，docs 保留（产物跨重开留存），selfReview/resumeHint/指纹快照随退出失效。

## 执行方式与 plan-exec skill

`complete` 选项中的 skill 档来自运行时自动检测：skill 作者在 SKILL.md frontmatter 标记 `plan-exec: true`，该 skill 即被提议为执行方式（label `Execute via skill: <name>`）。检测对过 description 必填门的 skill 二次读 frontmatter 判定；`disable-model-invocation` 与 plan-exec 并存不过滤。

四根扫描（单根枚举复用 pi 公开导出的 `loadSkillsFromDir`，跨根组装同构 pi 本体加载序）：project `.pi/skills` → 祖先链 `.agents/skills`（近→远，git root 级含）→ `<agentDir>/skills` → `~/.agents/skills`；同名 first-writer-wins + realPath 去重；untrusted 项目跳过前两族。complete 时现扫无缓存（技能热装即见）。

检测失败降级为空集，绝不炸 complete 交互闭环：每根 existsSync 守卫 + 整根 try/catch（EACCES 等 fs 错 → 跳过该根 + warn），单 skill frontmatter 读/解析失败跳过该项。检测为空集（含失败降级）时不弹执行方式表单，直通 execute（D7②）。

## Plan File

模板流程的产出物，存储在 `<project>/.tmp/plans/<slug>/plan.md`（slug 截断 30 字符）。含 YAML frontmatter 与模板章节。进入 plan mode 时自动扫描既有 plan 文件供续写。技能流程的产物文档同写在该目录下，经 `register-doc` 登记。

## 模板

三源发现（同名 last-writer-wins，项目 > 用户 > 内置）：

1. **内置**（包内 `templates/`）：`feature-plan` / `bugfix-plan` / `refactor-plan` / `implementation-plan` / `research-plan`
2. **用户级** `~/.agents/plans/*.md`：个人模板投放点
3. **项目级** `<project>/.agents/plans/*.md`：项目/团队模板投放点（项目级覆盖用户级覆盖内置）

进入计划态时全量清单以 `<available-plans>` 段随提示词一次性注入（name + location），模型自选后调 `select-template`——返回的 content 携带胜者文件全文（章节骨架直达，无需再 read）；错名报错自带可用清单，模型当场自愈。`--template <path>` 直传时跳过选型（见用法节）。

**goal 桥结构建议**：自定义模板（含直传文件）建议包含 `## Implementation Steps` 编号步骤节——`complete` 选 Execute 档且 goal 跟踪可用时，步骤提取（`extractPlanSteps` 正则）硬依赖该节；无该节会退化到 fallback（扫全部编号项，可能收进其他节噪音）或提取失败（no-steps 启动失败，有恢复文案）。

## 依赖

依赖：`@zhushanwen/extension-protocol`（PLAN_REVIEW_MARKER + PlanReviewRequest/Response 契约 + plan 生命周期状态机与审阅值域契约（`src/extensions/plan/`：transition/derivePhase + 值域守卫/selfReview 截断）+ ui-form（`uiFormInteract` / `FormQuestion`，统一提问表单协议），dependencies）；`@zhushanwen/pi-exec-skills`（plan-exec 技能发现/执行门禁单源，ADR-0074，dependencies）；peer 依赖：`@zhushanwen/pi-goal`（plan 完成后衔接 goal 驱动执行）。
