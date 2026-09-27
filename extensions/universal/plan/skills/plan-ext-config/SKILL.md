---
name: plan-ext-config
description: "使用或排查 @zhushanwen/pi-plan（计划模式 plan mode）时加载。说明 /plan 命令用法（--skills / --template / status / abort）、plan 工具六 action（enter / select-template / register-doc / submit-review / complete / abort）、审阅两键裁决（approve / revise）、执行方式选项集（plan-exec skill 检测 + Execute + 暂不执行）、数据存储模型（session JSONL 的 plan-state entry，无独立配置文件）、reviewState 崩溃恢复语义。触发词：plan mode、计划模式、/plan、plan 工具、submit-review、register-doc、plan-state、计划文档登记、审阅挂起、计划模式排查、plan-ext-config。"
---

# plan 使用与存储指南

> @zhushanwen/pi-plan：轻量计划模式扩展。进入后 agent 限只读工具集（read/bash/grep/find/ls/plan），只读探索并产出计划文档，用户审阅批准后才进入实施——「想清楚再动手」。

**重要前提**：plan **没有独立的配置文件**。计划态以 append-only 方式存储在 session JSONL 的 `plan-state` custom entry 中（见下文「数据存储位置」）。排查「plan 状态存哪 / 重启后为什么还在计划态 / 审阅挂起怎么恢复」都必须基于此模型理解，不要去找独立的 plan 配置文件。

## 如何进入/退出计划模式

### 1. `/plan` slash 命令（用户输入）

| 用法 | 作用 |
|------|------|
| `/plan <需求>` | 进入计划模式（模板流程） |
| `/plan <需求> --skills a,b` | 进入计划模式（挂载技能流程，技能名经 pi 已加载技能枚举校验，未知名不进入并回复可用清单） |
| `/plan <需求> --template <path>` | 进入计划模式（直传任意外部 md 作模板；`~` 前缀展开；与 `--skills` 互斥 fail-fast） |
| `/plan status` | 查看状态、技能与产物清单 |
| `/plan abort` | 取消活跃的 plan mode |

无参 `/plan`：活跃时显示 status；非活跃时扫描 `.tmp/plans/` 下既有 plan 文件，找到则让用户选择继续/实施/新建。

### 2. `plan` tool（AI 调用，六 action）

- **`enter`**：agent 自助进入（无需用户确认——plan mode 只读无害，进入事实经 GUI PlanModeBar 显形，用户随时可退出）。参数 `requirement` + 可选 `skills`。
- **`select-template`**：模板流程选型（`--template` 直传后调用会报错）。返回 content 携带胜者模板全文；错名报错自带可用清单自愈。
- **`register-doc`**：登记一份产物文档（参数 `fileName` 必须是 plan 目录内纯文件名，路径分隔符/`..` 被拒；同 fileName 重登 = version+1 原位覆盖，UI tab 顺序不跳动）。absPath 由扩展从 plan 目录推导，不信任 LLM 申报路径。
- **`submit-review`**：全部文档就绪后请求审阅（docs 为空或已退出计划态返回错误提示，不挂交互）。
- **`complete`**：用户 approve 后退出计划态，先弹执行方式选择（见下节）。
- **`abort`**：直接退出。

退出（complete/abort）恢复完整工具集；`plan-state` 落 isActive=false，docs 清单保留（产物文档跨重开可回看，至下次 /plan 同 slug 覆写）。

## 审阅闭环（submit-review → 两键裁决）

- **taiji rpc 宿主**（`TAIJI_AGENT_EXT_LOG=1` 且 `mode==='rpc'`）：挂 `PLAN_REVIEW_MARKER` select 弹 GUI 审批条，用户两键裁决——**approve**（确认执行，自动走 complete 流程）/ **revise**（提交 `{quote, comment}[]` 评论，注入对话要求修订）。取消（dismiss）非批准：result 明确禁止实施、停止审批循环等用户指示。
- **独立 pi / 非 rpc 形态**：文本软门——result 指示 agent 请用户直接在对话中反馈；用户满意确认后 agent 调 `complete`。
- **修订闭环**：revise 后逐条评论 rewrite 文件 + 重新 `register-doc`（version+1），全部处理完再调 `submit-review` 重挂，循环直至 approve。
- **重提交无变化检测**：上次 submit-review 后无任何 register-doc（docs 指纹相同）再次 submit-review 时，result 末行追加确定性警告，提示必须先 rewrite + re-register。

## 执行方式选项集（complete 时）

选项 = **≤2 个检测到的 plan-exec skill 档**（label `Execute via skill: <name>`）+ **Execute 档** + **暂不执行（Not now）**：

- **plan-exec skill 档**：skill 作者在 SKILL.md frontmatter 标记 `plan-exec: true` 即被提议。四根扫描（project `.pi/skills` → 祖先链 `.agents/skills` → `<agentDir>/skills` → `~/.agents/skills`，同构 pi 本体加载序，untrusted 项目跳过前两族），root 序同名 first-writer-wins，取前 2 个。complete 时现扫无缓存（技能热装即见）；检测失败降级为空集，绝不阻断交互。
- **Execute 档**：goal 跟踪已整合——goal 扩展可用时先建 goal 跟踪（`/goal`），再按复杂度执行：独立可并行任务派发 subagent、小步/紧耦合在本会话直执；goal 不可用/启动失败降级为直接执行（notify 提示 + result 带恢复动作）。
- **暂不执行**：留在 plan mode，不派发实施。

headless（json/print 无 UI）默认 execute 不弹选择；通道失败（channel-error / non-json）与用户取消同折叠为 complete-cancelled result，留在 plan mode 不炸 turn。

**goal 桥结构建议**：计划文档建议包含 `## Implementation Steps` 编号步骤节——Execute 档的 goal 步骤提取硬依赖该节；缺失会退化 fallback（扫全部编号项）或提取失败（no-steps，有恢复文案）。

## 数据存储位置（排查必读）

**当前版本采用 session JSONL 的 append-only event sourcing，没有独立数据文件。**

- 每次状态变更调 `pi.appendEntry('plan-state', {...})`，customType 固定为 `plan-state`；重建时取 session 内**最后一条** plan-state entry 为当前态（逐字段白名单降级读，旧版 entry 缺字段归一为空/无值）。
- 字段：`isActive` / `planFilePath` / `requirement` / `templateName` / `templateProvidedPath`（--template 直传标记）/ `skills`（挂载技能名）/ `docs`（产物清单 `PlanDocMeta[]`：fileName + absPath + sourceSkill + version）/ `reviewState` / `lastSubmitReviewDocsFingerprint` / `reviewStateSource`。
- **产物文档本体**写在 `<cwd>/.tmp/plans/<slug>/`（slug 截断 30 字符）——文档是普通文件，agent 经 bash 写入；`register-doc` 只登记元数据。未产任何文档即退出会清理空 slug 目录（非空一律保留）。
- **模板三源发现**（同名 last-writer-wins，项目 > 用户 > 内置）：内置（包内 `templates/`，5 个）+ 用户级 `~/.agents/plans/*.md` + 项目级 `<project>/.agents/plans/*.md`。进入时清单以 `<available-plans>` 段一次性注入。

## reviewState 崩溃恢复（E3）

`reviewState` 两值：`awaiting`（submit-review 挂起前落盘）| `revising`（revise 消费后落盘）| 无值 = 进行中。挂起的交互（审批 select / 执行方式 form）随 pi 进程消亡，但持久态经 entry 存活：

- session 重启（session_start）时若 `reviewState='awaiting'`：steer 指示 agent 重调 `submit-review` 重挂审批，并落 `reviewStateSource='resubmit'`（GUI 据此渲染「会话已重启，尚未重新提交」降级态；submit-review 重挂起时清空）。
- `reviewState='revising'`：steer 指示继续按已注入的评论修订文档并重新提交。
- 「approve 后执行方式选择窗口中断」不自动恢复（与探索期在持久态上不可区分，防误报），由用户重发消息自然恢复。

## 排障

- **submit-review 返回「taiji host does not understand the plan review marker」**：taiji 宿主版本过旧（select 回显 payload 的确定性识别）。不要重挂（会同样回显循环），指引升级 taiji 或固定 plan 扩展版本。
- **submit-review 返回 cancelled**：用户 dismiss 或 plan mode 退出——非批准，禁止实施，等用户指示。
- **重提交总带「no documents changed」警告**：必须先 rewrite 文件 + `register-doc`（version+1）再 submit-review，警告按 docs 指纹逐次检测。
- **plan-exec skill 没出现在执行选项里**：确认 frontmatter 有 `plan-exec: true`（严格布尔 true，字符串 "true" 不算）；确认 skill 过了 pi 的 description 必填门且未被 settings overrides（`-`/`!`）禁用；untrusted 项目不扫 `.pi/skills` 与祖先链两族。
- **goal 跟踪未启动（no-steps / plan-unreadable 等）**：result 文本带逐原因恢复动作（如补 `## Implementation Steps` 节后重调 complete）；goal 扩展未装时属正常降级（直接执行）。
- **调试**：`TAIJI_AGENT_DEBUG=1` 后看 `~/.pi/agent/logs/` 下 `[pi-plan]` 前缀日志。

## 备注

- **宿主信号**：taiji runtime 对托管 pi 恒注入 `TAIJI_AGENT_EXT_LOG=1`（引导文案注入 + marker 交互判据之一）；marker 交互另需 `mode==='rpc'`，env 泄漏到独立 pi TUI 时回落文本软门（不挂乱码 select）。
- **计划态工具白名单**：read / bash / grep / find / ls / plan——bash 在白名单内，文件写约束来自注入的计划模式提示词（产物只写 plan 目录）。
- **无配置 schema 可编辑**：plan 的所有状态都由运行时命令/工具产生，没有可手动编辑的配置文件。
