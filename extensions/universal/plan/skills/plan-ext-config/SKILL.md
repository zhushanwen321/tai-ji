---
name: plan-ext-config
description: "使用或排查 @zhushanwen/pi-plan（计划模式 plan mode）时加载。涵盖 /plan 命令用法、plan 工具六 action、审阅三键裁决与自审硬门、执行方式选项集、session JSONL 存储模型（无独立配置文件）与按 state 崩溃恢复——细节见正文各节。触发词：plan mode、计划模式、/plan、plan 工具、submit-review、selfReview、dismiss、搁置、register-doc、plan-state、计划文档登记、审阅挂起、计划模式排查、plan-ext-config。"
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
- **`submit-review`**：全部文档就绪后请求审阅（docs 为空或已退出计划态返回错误提示，不挂交互）。**必带 `selfReview` 参数（自审硬门，无豁免）**：提交前对照需求逐条核覆盖 / 假设审计（[UNVERIFIED] 清零或显式列出）/ 章节完整性对照模板 / 验收场景真实可执行，自审发现的问题先修文档再提交；缺失/空 → tool result 纠偏不挂交互；文档已变而 selfReview 与上次逐字节相同 → 防照抄袭拒收（必须对新版本重做自审）。
- **`complete`**：用户 approve 后退出计划态，先弹执行方式选择（见下节）。未经审批闸口（如 planning 态直调）会被拒并指回 submit-review——「执行前的用户审批」是结构性保证。
- **`abort`**：直接退出。

退出（complete/abort）恢复完整工具集；`plan-state` 落 isActive=false，docs 清单保留（产物文档跨重开可回看，至下次 /plan 同 slug 覆写）。

## 审阅闭环（submit-review → 三键裁决）

- **taiji rpc 宿主**（`TAIJI_AGENT_EXT_LOG=1` 且 `mode==='rpc'`）：挂 `PLAN_REVIEW_MARKER` select 弹 GUI 审批条，payload 携带 docs + selfReview（写侧 4KB 截断），用户三键裁决——**approve**（确认执行，自动走 complete 流程，状态进 dispatching）/ **revise**（提交 `{quote, comment}[]` 评论，注入对话要求修订，状态进 revising）/ **dismiss 搁置**（D3 协议级决策，非破坏：不杀 turn、不丢状态，状态回 planning，被搁置的审批不复活；tool result 指示 agent 告知用户已搁置并询问下一步，不实施改动）。选择框被解散（turn abort / TUI 取消）非批准：按归口判别走 review_aborted 边或 no-op，result 明确禁止实施。
- **独立 pi / 非 rpc 形态**：文本软门——result 指示 agent 请用户直接在对话中反馈；用户满意确认后 agent 调 `complete`。
- **修订闭环**：revise 后逐条评论 rewrite 文件 + 重新 `register-doc`（version+1），**对新版本重做自审**后带新 selfReview 再调 `submit-review` 重挂，循环直至 approve。
- **重提交无变化检测**：上次 submit-review 后无任何 register-doc（docs 指纹相同）再次 submit-review 时，result 末行追加确定性警告，提示必须先 rewrite + re-register。
- **降级恢复（重新提交审批）**：state=reviewing 而无挂起审批（会话重启等）时，宿主降级分支提供「重新提交审批」按钮——点击注入一条固定文案的用户可见消息，agent 收到后**直接** `submit-review` 重挂（提示词已带此纪律）；会话重启时 E3 steer 会携带上轮 selfReview 全文供原样回传（该文档集的自审不重做，但过门义务不豁免）。

## 执行方式选项集（complete 时）

选项 = **≤2 个检测到的 plan-exec skill 档**（label `Execute via skill: <name>`）+ **Execute 档** + **暂不执行（Not now）**：

- **plan-exec skill 档（标记写法）**：skill 作者在 SKILL.md **frontmatter 加一行 `plan-exec: true`**（严格布尔 true，字符串 "true" 不算）即被提议，例如：

  ```yaml
  ---
  name: dev-flow
  description: ...
  plan-exec: true
  ---
  ```

  四根扫描（project `.pi/skills` → 祖先链 `.agents/skills` → `<agentDir>/skills` → `~/.agents/skills`，同构 pi 本体加载序，untrusted 项目跳过前两族），root 序同名 first-writer-wins，取前 2 个。complete 时现扫无缓存（技能热装即见）；检测失败降级为空集，绝不阻断交互。无任何 plan-exec 技能时不弹执行方式表单（无技能时确认执行直通，不弹恒两项的死表单）。
- **Execute 档**：goal 跟踪已整合——goal 扩展可用时先建 goal 跟踪（`/goal`），再按复杂度执行：独立可并行任务派发 subagent、小步/紧耦合在本会话直执；goal 不可用/启动失败降级为直接执行（notify 提示 + result 带恢复动作）。
- **暂不执行**：留在 plan mode，状态落「已批准」（later 边），不派发实施——需要时说『执行』或再调 `complete` 重新选执行方式。

headless（json/print 无 UI）默认 execute 不弹选择；交互框被解散（取消 / 超时 / channel-error / non-json）按「无选择解散」归口：无命令介入时状态落「已批准」（批准事实保留）+ result 可再调 complete；plan abort 等命令已退出时归口 no-op（不覆写终态）。

**goal 桥结构建议**：计划文档建议包含 `## Implementation Steps` 编号步骤节——Execute 档的 goal 步骤提取硬依赖该节；缺失会退化 fallback（扫全部编号项）或提取失败（no-steps，有恢复文案）。

## 数据存储位置（排查必读）

**当前版本采用 session JSONL 的 append-only event sourcing，没有独立数据文件。**

- 每次状态变更调 `pi.appendEntry('plan-state', {...})`，customType 固定为 `plan-state`；重建时取 session 内**最后一条** plan-state entry 为当前态（逐字段白名单降级读，旧版 entry 缺字段归一为空/无值）。
- 字段：`isActive` / `planFilePath` / `requirement` / `templateName` / `templateProvided`（布尔，--template 直传标记；旧字段 `templateProvidedPath` 已停写，读侧映射 readTemplateProvided）/ `skills`（挂载技能名）/ `docs`（产物清单 `PlanDocMeta[]`：fileName + absPath + sourceSkill + version）/ `state`（生命周期状态八值：idle/planning/reviewing/revising/approved/dispatching/completed/exited——取代式演进，旧字段 `reviewState`/`reviewStateSource` 已停写，读侧映射：awaiting→reviewing、revising→revising、无→planning|idle 按 isActive，reviewStateSource:'resubmit'→resumeHint:'resubmit'）/ `selfReview`（上次提交的自审结论，≤4KB——E3 回传源 + 防照抄比较基线）/ `resumeHint`（降级等待原因：`resubmit` 会话重启待重提交，清除点三处，不跨轮残留）/ `lastSubmitReviewDocsFingerprint`。
- **产物文档本体**写在 `<cwd>/.tmp/plans/<slug>/`（slug 截断 30 字符）——文档是普通文件，agent 经 bash 写入；`register-doc` 只登记元数据。未产任何文档即退出会清理空 slug 目录（非空一律保留）。
- **模板三源发现**（同名 last-writer-wins，项目 > 用户 > 内置）：内置（包内 `templates/`，5 个）+ 用户级 `~/.agents/plans/*.md` + 项目级 `<project>/.agents/plans/*.md`。进入时清单以 `<available-plans>` 段一次性注入。

## 崩溃恢复（E3，按 state 查表）

挂起的交互（审批 select / 执行方式 form）随 pi 进程消亡，但持久态经 entry 存活。session 重启（session_start）时按 `state` 查表恢复：

- `state='reviewing'`：steer 指示 agent 重调 `submit-review` 重挂审批（**携带上轮 selfReview 全文**供原样回传——该文档集的自审不重做，过门义务不豁免），并落 `resumeHint='resubmit'`（GUI 据此渲染「会话已重启，尚未重新提交」降级态；submit-review 重挂起时清空）。
- `state='revising'`：steer 指示继续按已注入的评论修订文档并重新提交。
- `state='dispatching'`：执行方式选择窗口中断恢复（D5 E3 新支）——先按 review_aborted 边落 `approved`（批准事实保留），再 steer 指示重调 `complete` 重新发起执行方式选择。
- 其余态（planning/approved/终态）不打扰。
- 旧 entry（无 state 字段）经 reviewState 映射后同样落本表。

## 排障

- **submit-review 返回「taiji host does not understand the plan review marker」**：taiji 宿主版本过旧（select 回显 payload 的确定性识别）。不要重挂（会同样回显循环），指引升级 taiji 或固定 plan 扩展版本。
- **submit-review 返回 no-self-review / stale-self-review**：自审硬门拒收（D9①）——前者补自审后带 selfReview 重调；后者是文档已变而自审照抄，必须对新版本重做自审。
- **submit-review 回传 decision 不在值域（unknown-decision）**：落 bad-response 出口、result 引导重挂（重挂即恢复）；版本错配信号只在日志 warn 留痕——原子发版下生产不可达（唯一窗口 = dev-link 版本错开），生产出现 = 错配组合真实可达的反证，恢复动作 = dev-link 对齐版本后重试。
- **submit-review 返回 cancelled / review-interrupted**：审批选择框被解散——非批准，禁止实施，等用户指示；cancelled = plan mode 已退出（命令解散），review-interrupted = plan 模式保持在规划态（外部解散，可按用户要求重挂）。
- **重提交总带「no documents changed」警告**：必须先 rewrite 文件 + `register-doc`（version+1）再 submit-review，警告按 docs 指纹逐次检测。
- **plan-exec skill 没出现在执行选项里**：确认 frontmatter 有 `plan-exec: true`（严格布尔 true，字符串 "true" 不算）；确认 skill 过了 pi 的 description 必填门且未被 settings overrides（`-`/`!`）禁用；untrusted 项目不扫 `.pi/skills` 与祖先链两族。
- **goal 跟踪未启动（no-steps / plan-unreadable 等）**：result 文本带逐原因恢复动作（如补 `## Implementation Steps` 节后重调 complete）；goal 扩展未装时属正常降级（直接执行）。
- **调试**：`TAIJI_AGENT_DEBUG=1` 后看 `~/.pi/agent/logs/` 下 `[pi-plan]` 前缀日志。

## 备注

- **宿主信号**：taiji runtime 对托管 pi 恒注入 `TAIJI_AGENT_EXT_LOG=1`（扩展日志落盘开关 + marker 交互宿主分流判据）；marker 交互另需 `mode==='rpc'`，env 泄漏到独立 pi TUI 时回落文本软门（不挂乱码 select）。
- **计划态工具白名单**：read / bash / grep / find / ls / plan / ask_user（D10：探索期提问可用；ask-user 扩展被禁时 pi 静默跳过，回退对话流提问）——bash 在白名单内，文件写约束来自注入的计划模式提示词（产物只写 plan 目录）。
- **无配置 schema 可编辑**：plan 的所有状态都由运行时命令/工具产生，没有可手动编辑的配置文件。
