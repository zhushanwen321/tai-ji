---
name: pr-cr-fix
description: >-
  PR 完整生命周期 skill：开 PR → 多维 review → 修 must-fix → pre-merge → 推 PR。
  触发词："review and open PR"、"review 完开 PR"、"把 review 问题修了开 PR"、
  "pr-cr-fix"、"review → PR"、"提交 PR"、"创建 PR"、"push"、"提交代码"、
  "push 前检查"、"pre-push"、"review"、"审查代码"、"code review"、"帮我看看代码"。
  不用于 仅提交/推送不建 PR 的纯 git 操作（直接 git commit + git push）、
  或 push 失败排查/CI 故障诊断。
---

# PR 完整生命周期 Skill

开 PR → 多维 review → 修 must-fix → pre-merge → 推 PR。本 skill 是 PR 工作流的唯一入口，内化了原 pull-request / code-review / pre-push-checks / trim-cot-leakage 四个 skill 的能力。

## 前置条件 [MANDATORY]

- taiji git worktree 中，当前分支相对 main 有 commits（`git log main..HEAD` 非空）
- 有 GitHub CLI（`gh`）认证
- 全局安装 fallow（`npm i -g fallow`，实测 2.88.2）——阶段 1.5 度量门禁依赖
- pi 环境走路径 1（原生 workflow）：完整生命周期 = workflow 工具 `action:"run"` + `name=<repo 根>/.agents/workflows/pr-lifecycle.js 绝对路径>`（按名解析已退役，裸名一律 not_found——从 `<available_workflows>` 清单的 location 取路径；脚本随 git 分发）+ args；只跑 review+fix 循环（不进门禁、不开 PR）时用内置 `review-fix-loop`
- zcode 环境走路径 2（原生 workflow）：完整生命周期 = `CreateWorkflow` 以 `path` 指向本仓自带的 `.agents/skills/pr-cr-fix/workflows/pr-lifecycle.dwf.ts`（随 git 分发）+ args；只跑 review+fix 循环（不进门禁、不开 PR）时用全局 saved workflow `review-fix-loop`（`~/.zcode/workflows/`，无需额外安装）

## 调用约定

- `cwd`：git 根目录绝对路径（`git rev-parse --show-toplevel`）
- 确定性脚本主 agent 直接跑，不派 subagent：阶段 1.1 static gate、1.5 / 1.6 两道 gate、阶段 3a 终局三道 gate
- 阶段 2 由主 agent 直接派 workflow（路径 1 pi 跑 pi 版 pr-lifecycle 单 workflow 全链 / 路径 2 zcode 跑 zcode 版 pr-lifecycle 单 workflow 全链）或 reviewer subagent（路径 3 手工兜底），不经 subagent 封装；修复 / 补测试派 worker subagent。路径 1/2 下阶段 1 → 1.5/1.6 → 2 → simplify → 3a 全部由各自 pr-lifecycle workflow 编排，主 agent 不逐步执行（见「路径 1」「路径 2」节）；路径 3 按下列各阶段手工走。主 agent 全程只做编排 + Gate 校验 + push 前用户授权确认

---

## 阶段 1：开 PR

### 1.1 static gate（typecheck + lint，不跑测试）

主 agent 在当前 feature worktree 内直接跑（不是 main worktree）：

```bash
bash scripts/pr-pre-merge.sh --skip-tests --quiet
```

- 模式语义：typecheck **三处**（extensions + runtime + renderer）+ lint 全仓；测试步全跳过——review 前不以无插桩口径跑测试（review/修复后读数全过期），测试统一由阶段 1.6 coverage-gate 承接（插桩口径）。marker 照写，`result` 反映 typecheck + lint
- 禁止 `--no-verify` / `SKIP_LINT=1` / `SKIP_EXTENSION_LINT=1`；build 默认跳过（`PR_PRE_MERGE_SKIP_BUILD=1`），全量打包由 CI 跑

**Gate-1a**（硬 gate）：exit 0（marker `result=PASS`）才继续。FAIL 按输出中失败步骤派对应工种 worker 修复后重跑（`typecheck:extensions` / `typecheck:runtime` / `typecheck:renderer` / `lint`）。

**Gate-1a.5**（changeset 自动补全）：summary 出现 `WARN changeset-check`（改了 `extensions/**/src/` 但无 changeset，WARN 不 FAIL）→ **主 agent 按 diff 逐包分类后自动处理，不 AskUserQuestion**（判断所需信息全在 diff 里，弹窗把判断推给人的代价高于 PR 内审查；[HISTORICAL] 曾为弹窗模式，用户反馈每次执行都被打断、多数 WARN 是纯注释类噪声，2026-08-23 改为自动分类）：

- **实质行为改动**（逻辑/接口/行为变化）→ 自动起草 `.changeset/<slug>.md`：type 初判按分支 conventional commits（feat→minor / fix→patch / BREAKING→major），body 英文写用户可感变化（进 CHANGELOG，遵守根 AGENTS.md changeset 准则）
- **非发布改动**（纯注释/类型注解/测试/零行为差重构）→ 跳过，在阶段汇报中列明「包名 + 跳过原因 + 证据」
- 已删除的包 checker 自动跳过（package.json 读不到）；WARN 本身不清除（事实记录），只 FAIL 才阻塞

changeset 文件随 PR diff 可审可改；type 终判仍在 merge 阶段人工定（与「PR 阶段初判、merge 人工定」SSOT 一致）。缺失 changeset 的后果：merge 时 `changeset version` 不 bump → publish 不发 → bug fix 静默丢失。已知堆积问题：dev-merge（feature→dev）不跑本检查，负担堆积到 dev→main 最终 PR——前移到 dev-merge 是待办优化。

### 1.2 自动生成 PR title 和 body

**[MANDATORY] 从分支所有 commit 自动生成，英文，无需用户提供。**

1. 收集分支所有 commit：`git log main..HEAD --format="%s%n%b---"` + `git diff main..HEAD --stat`
2. 生成 PR title：conventional commit 风格（`fix(scope): short summary`；多 scope 取最核心的，或省略 scope）
3. 生成 PR body：`## Summary`（改动目的）+ `## Changes`（逐条列各 commit 关键改动，合并相关条目；有 `.changeset/*.md` 一并展示）+ `## Test plan`（typecheck/test/lint 结果）。breaking changes 必须标明

### 1.3 Push 并创建 PR

**bare repo workspace 注意**：`origin` 指向本地 bare repo，GitHub 的 remote 叫 `github`。

```bash
# 方式 A：用 pr-submit.sh（自动检测 PR 是否已存在、仅内容变化时更新）
bash scripts/pr-submit.sh --title "$PR_TITLE" --body "$PR_BODY" --base main

# 方式 B：直接 gh 命令
git push github HEAD
gh pr create --repo zhushanwen321/tai-ji \
  --head "zhushanwen321:$(git branch --show-current)" \
  --title "$PR_TITLE" --body "$PR_BODY"
```

**Gate-1**：`pr_url` 匹配 `^https://github\.com/.+/pull/\d+$`。`force_push=true` 时，阶段 3b 推 PR 加 `--force-with-lease`。

### 1.4 [OPTIONAL] skill YAML 规范校验

修改了 `.agents/skills/` 时，PR 创建前运行本 skill 内置校验脚本：

```bash
# 校验 skill SKILL.md 的 frontmatter（name/description 必填，description 双引号包裹或块标量）
python3 .agents/skills/pr-cr-fix/scripts/validate-skill-yaml.py <skill-paths>
```

## 阶段 1.5：度量快照 + Gate-1.5（硬门禁）[MANDATORY]

确定性代码度量（圈复杂度 / 循环依赖 / 重复 / 死代码），机器计算、脚本判定，不经 LLM。**未过 Gate-1.5 禁止进入阶段 2。**与 1.6 的执行顺序：**coverage-gate 先跑、metrics-gate 后跑**（理由见 1.6）。

### 执行（主 agent 直接跑）

```bash
python3 .agents/skills/pr-cr-fix/scripts/metrics-gate.py --base main
```

- 产出 `.review/metrics.json`（fail/warn 清单 + 高 CRAP 靶子清单）；exit 1 = fail，exit 2 = 工具错误（中止；fallow 缺失时同样 exit 2 并给出安装命令）
- 阈值 SSOT = 仓库根 `.fallowrc.json` 的 `health` 节；脚本读取该文件，禁止在命令行另传阈值

### Gate-1.5 判定

| verdict | 含义 | 动作 |
|---------|------|------|
| `fail` | 有 fail 级 introduced 问题 | **打回**：派 worker 修复 → 重跑本脚本，上限 3 轮；超限停手上报用户 |
| `warn` | 仅 warn 级 | 放行；`.review/metrics.json` 的 warn + targets 清单由阶段 2 对应 agent 消费 |
| `pass` | 干净 | 放行 |

### 门禁项分级

- **fail**：introduced 函数圈复杂度 > 15；新增循环依赖；新增无法解析的 import（全部）
- **warn**（注入阶段 2 review）：introduced 认知复杂度 > 15 / CRAP ≥ 30 / 死代码等 13 类（完整清单见 scripts/metrics-gate.py 的 `WARN_DEAD_CODE_KINDS`）；新增重复块

设计理由：fallow audit 无 warn 档、无真实覆盖率时 CRAP 是静态估算（噪声大），metrics-gate 用同一份 audit JSON 显式双轨判定——结构性硬指标 fail，覆盖率相关指标 warn 给阶段 2 消费。

## 阶段 1.6：增量覆盖率门禁（Gate-1.6）[MANDATORY]

> **[HISTORICAL 2026-08-21] 曾有稳定假 pass，根因已修复并双向验收**（真实 diff 17 包
> 非空报告全绿 exit 0 + 高阈值探针 fail 方向 exit 1）。主因：OK 路径漏记 `report[pkg] =
> entry`，全部包 OK 时 report 恒空被 `all(空)==True` 判 pass；同批修复 basename 兜底误配、
> hoisting 幻影依赖（改按 package.json 声明判定，24 个 vitest 包已全部声明
> @vitest/coverage-v8）、extensions/shared 三层目录漏切、git diff 瞬态空输出四项加固。
> 完整根因链与守卫见 coverage-gate.py 头部 [HISTORICAL] 段。守卫原则：**记账不闭合
> （迭代数 ≠ 报告条目数）与 all-SKIP 一律 exit 2（工具错误），绝不静默 pass**。

**口径 [MANDATORY]**：**增量覆盖率 ≥ 80% 才达标。**（2026-08-21 用户决策：从 50% 起步值 ratchet 至业界事实标准 80%——Sonar Way 默认「coverage on new code ≥80%」门禁，调研见 `references/coverage-industry-research.md`）与 Gate-1.5 互补：Gate-1.5 是静态结构度量（不跑测试），Gate-1.6 跑测试量「新代码有没有被测到」。与 renderer 全量 thresholds gate（vitest.config 内、CI 强制）互补：全量阈值防整体退化，增量阈值防「新代码不写测试」。TEST-STRATEGY.md §7「以增量覆盖率为准」的工具化落地。

**执行顺序：coverage-gate 先跑，metrics-gate 后跑。** coverage-gate 产出 `.review/coverage.json` 的 `files` 节（全文件级真实 lcov 覆盖率），metrics-gate 消费它把 complexity warn 中**真实文件覆盖 ≥80%** 的条目移入 covered 列表（出 warn、保留证据链），替换 fallow 静态估算。阶段 1 初跑与 3a 复跑均按 **coverage → metrics** 顺序；coverage.json 缺失或 base 不匹配时 metrics-gate 自动降级静态估算（不阻塞，报告标注 `fallow-static`）。两道 gate 都失败时按上下文重合度聚合派发：失败常同文件同源，主 agent 把两份失败明细（uncovered_files + metrics fail 清单）合成一份修复任务派单个 worker（同一文件的多类问题一次修完），修完 commit 后按序重跑两道——对应 zcode 路径 2 gate-suite step 的同款约定。

### 执行（主 agent 直接跑）

```bash
python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base main
# diff 含 packages/shared/**/src/** 时传下游追加（见下方 shared 下游传播）：
python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base main --extra-packages packages/runtime,packages/renderer
```

- 自动检测 base...HEAD 改动过 `src/` 的 vitest 包（含 `extensions/shared/<lib>` 三层目录），逐包跑 `vitest run --coverage`（lcov），解析 lcov DA 行命中 × git diff 新增行号（精确路径匹配），算**可执行新增行覆盖率**
- **判定**：任一被 gate 包增量 < 80%（默认）、**文件级增量门槛违规**（新增可执行行 ≥8 的单文件自身覆盖率 < 60%，防单文件盲区被包百分比稀释——PR #20 组 A 的 A2 形态；可调 `--min-file-incremental` / `--file-gate-min-lines`）或测试失败 → `verdict=fail` exit 1；**登记式豁免**：文件头注释 `coverage-file-gate-exempt: <理由>`（组合根装配面/跨环境分支等单轨不可达形态）退出文件级门槛（包级仍卡），报告 file_gate.exempt 可见不静默；记账不闭合 / all-SKIP / git 瞬态异常 → exit 2（工具错误，修复后重跑）；产出 `.review/coverage.json`（packages 增量口径 + file_gate 违规/豁免清单 + files 全文件级真实覆盖率 + files_without_lcov 盲区清单）。SKIP 语义：按 package.json **声明**判定（非 node 解析），出现 SKIP 即配置漂移，按报告内指引补声明
- **shared 下游传播**：包选择只收自身有 `src/` 改动的包，shared 改动不传播下游；diff 含 `packages/shared/**/src/**` 时传 `--extra-packages packages/runtime,packages/renderer`——实跑两包全量插桩测试，承接「1.1 不再跑全量测试」后的下游兜底。**连带效应**：renderer vitest.config 内的全量 thresholds（CI 强制口径）随之生效，thresholds breach 视同测试失败走 FAIL 路径（与本次改动无关的全量退化同样拦截；该失败输出与 uncovered_files 增量口径不同源，排障注意区分）
- `--packages <pkg>` 是交集过滤器（单包探针用，会以单包产物覆盖 coverage.json，探针后重跑全量恢复）；`--extra-packages` 是追加器，两者语义不同、可共存。**注意**：修复 worker 还在运行时本地读数会被污染——Gate-1.6 必须在干净工作区（全部改动已 commit）跑

**Gate-1.6 判定**：fail → 派测试专项 subagent 补测试 → 重跑（上限 3 轮）。补测试优先级看 `.review/coverage.json` 的 uncovered_files 清单（按可执行新增行缺口排序）。

### 怎么看覆盖率（人工排查）

- 单包全量 + HTML 报告：`cd <pkg> && npx vitest run --coverage`（renderer 已配 thresholds，跌破 exit 非 0；产物 `<pkg>/coverage/index.html` 浏览器逐行看）
- 增量口径（本 PR 新增可执行行的覆盖率）：`python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base main`
- CI 产物：PR checks 页 Test (renderer) job → artifact "coverage-report"（lcov + html）

renderer 全量阈值（S3-W1 基线-2~3% 重校准：lines 68 / stmts 66 / branches 56 / functions 60）由 CI 强制；其余包 provider 已全部声明（增量口径由 Gate-1.6 覆盖），全量 thresholds 先测量后设阈（见 TEST-STRATEGY §7）。

## [OPTIONAL] Mutation testing 深检

覆盖率证明「代码被跑过」，mutation score 证明「断言真能抓 bug」——覆盖率高但断言弱的测试抓不住回归。**触发条件**：Gate-1.5 靶子函数补测后验证断言强度 / review-test-coverage 报「弱断言」疑点 / 修 bug 后验证回归测试真能拦截。工具选型、定向跑法与判定参考见 `references/mutation-testing.md`。

## 阶段 2：review + fix

### 阶段 1.5 / 1.6 产物消费约定

`.review/metrics.json`（阶段 1.5 必然产出）与 `.review/coverage.json`（阶段 1.6）由以下维度按各自 agent 定义的输入约定消费：review-test-coverage 消费 `targets.high_crap` 靶子清单 + coverage.json 的 `uncovered_files`（实测增量覆盖缺口，优先补测试）+ `files_without_lcov`（未被任何测试加载的新文件——机器盲区定点核查）；review-monorepo-impact 消费 `fail`/`warn` 中的循环依赖条目（不再手工 grep import 链）。其余 6 维不变。

### 阶段 2 前置：约束动态加载（`.review/constraints.md` 产物）

进入阶段 2 前主 agent 先跑（三路径共用，workflow 派的 review agent 与手工派的 subagent 都按 agent 定义内的消费约定自读）：

```bash
node scripts/select-constraints.mjs --base main
```

按 diff 范围从 `docs/constraints.json`（架构约束登记 SSOT）选择命中约束，落盘 `.review/constraints.md`：scope 为 `global` 的核心不变量每次必载，其余按改动路径前缀命中（只改 renderer 不载 extension 约束）。8 个 review agent 定义均含消费约定——清单中 dimensions 含本维度的条目必须逐条核对，`enforcement: review` 的条目是本维度重点；需要完整表述时 Read「权威源」列指向的文档原文（清单里的 summary 仅导航）。

### [MANDATORY] 路径选择

**两版本 + 手工兜底**（2026-09-24 收敛裁决：完整 PR 生命周期 workflow 只留 pi 版与 zcode 原生版两个实现；原 zsw 引擎版 pr-lifecycle.js 已退役，git 可追溯）：

- **pi 主 agent** → 路径 1（pi 版 pr-lifecycle 单 workflow 全链，项目 `.agents/workflows/`）；只跑 review+fix 循环时用内置 `review-fix-loop`
- **zcode 主 agent** → 路径 2（zcode 版 pr-lifecycle 单 workflow 全链）；只跑 review+fix 循环时用全局 saved `review-fix-loop`
- **无 workflow 能力环境** → 路径 3（手工编排，上限 2 轮）

**review-fix-loop 宿主路由（循环本体）**：只跑 review+fix 循环（不进门禁、不开 PR）时按宿主路由——pi 主 agent 用 **pi 内置版** `review-fix-loop`（subagent-workflow extension 的 workflow 工具，`action:"run"`）；zcode 主 agent 用 **zcode 原生 saved workflow `review-fix-loop`**（全局注册 `~/.zcode/workflows/`，经 CreateWorkflow `saved: { name: "review-fix-loop", args: {...} }` 发起；`args.reviewers` = agent .md 绝对路径数组，等价 pi 版 `batch1`；`base` 等价 `target=main`；**`reviewers` 参数同名异义注意**：saved 版 = agent .md 绝对路径数组（必需），pr-lifecycle 版 = 路径子串白名单（可选，缺省全部 8 维））。这两个「只跑循环」实体之间存在分叉（见下方差异登记表）；**完整 PR 生命周期的循环本体不分叉**——两版 pr-lifecycle 的 cr-fix 内联循环（pi 版 + zcode 版 prl 内联）与 zcode saved 版三镜像同语义，改任一侧须同步另两份。

两版 **pr-lifecycle 全链 workflow 语义完全一致**（10 step：preflight / static-gate / pr-meta(含条件 changeset) / skill-yaml / pr-submit / constraints / gate-suite / cr-fix / simplify / final-gates），仅宿主发起形态不同（pi = workflow 工具 action=run + 脚本绝对路径；zcode = CreateWorkflow path 发起）。共用的并行化与数据传递约定（2026-09-20）：review 阶段 **4 个一批分批并行**；聚合（独立 phase）去重合并各维度问题与修复指南（guidance）并按相关性与独立性**分组**；fix 阶段**按组并行派发（同时最多 3 组）**，commit 由循环统一显式路径执行（并行 fixer 不各自 commit）。数据传递 = **文件总线**：各角色产物全部落盘 run 目录（reviewer 报告 / aggregated.md / per-fixer 任务文档 `aggregate-4-fixer-<k>.md`，由循环从聚合分组数据确定性渲染——修复指南随文档直达 fixer），agent 之间不内联传递内容；结构化返回值只承载控制数据（计数/对账/分组 id）。

**循环本体行为差异登记表**（作用域 = pi **内置通用** `review-fix-loop` ↔ zcode 循环镜像——只跑 review+fix 循环场景的两个实体间的已知语义分叉，改任一侧前先查此表。**完整 PR 生命周期的 cr-fix 内联循环不分叉**：pi 版 prl 内联 + zcode 版 prl 内联 + zcode saved 三镜像同语义，共同熔断与复活语义：fixAttempts = 修复失败次数（仅 regressed 申报时 +1）、needs-redesign 要求条目 regressed（修了又坏）、deferred 条目跨轮保留台账且唯一复活入口 = reviewer 对注入清单的结构化 escalate 申报）：

| 差异点 | pi 内置 review-fix-loop（只跑循环） | prl 系循环镜像（zcode saved + 两版 prl 内联） | 备注 |
|---|---|---|---|
| converged 判定 | 新发现率收敛（convergeRounds 轮 ≤N 新问题且无 critical）+ 活跃清零 | 仅活跃清零（R1 全 clean 报 clean） | prl 系无「边修边冒新问题」防护，靠 stuck 兜底 |
| stuck 计数起算 | 对账数据缺失才计数式，R1 不起算 | 恒双轨且 R1 起算 | prl 系早一轮触发 |
| 会话墙钟超时 | reviewer/aggregator 1h | 无超时 | prl 系符合「任务级默认无超时」裁决（AGENTS.md 规则 19） |
| aggregator 失败 fallback | aggregated.md 解析 numeric fallback | fail-closed 无 fallback | prl 系防「结构化丢失→空 issues 假 clean」 |
| fixer prompt 增强 | minimal-fix 纪律 + 防注入 caution 段 | S7 checklist（行号锚点同步 + 依赖 pin） | 各自吸收不同实战教训 |
| pi 内置独有可选参数 | recheckAfterFix / fixAgent / reviewPrompt / fixPrompt / targetType=file\|dir\|text / fallowScan 前置批 / 多批 batch1..N / converge 参数 / rfl 仪表 | 无对应物 | 两版 prl 内联均无对应物；recheckAfterFix 需求出现时按需加 |
| autoCommit 默认 | false | saved 版 true；prl 恒统一 commit | 单跑 saved 不传参即产生 commit 副作用 |
| rawClean+对账残留走向 | 清 clean 名单重派 review 追账 | 进聚合管线多修一轮 | 两种「不假 clean」策略 |
| reviewer 定义投射 | agent .md 作为 systemPrompt（frontmatter model 传播） | 通用 persona + prompt 指示第一步 Read 定义文件 | 平台能力差异 |

#### 路径 1：pi 环境（pi 版 pr-lifecycle 单 workflow 全链）

**适用条件**：当前主 agent 是 pi agent，且有 workflow 工具（subagent-workflow extension 提供）。workflow 按脚本**绝对路径**调起（`name` 参数收 `<available_workflows>` 清单的 location；按名解析已退役，裸名 not_found）；发现扫描按低→高优先序、last-writer-wins 后扫者胜（SSOT = `packages/subagent-core/src/shared/resource-discovery.ts`）：user-pi → user-agents → npm 全局 → 内置（core 包，注入于 npm 槽内末位，低于 npm-dev）→ npm-dev → extension paths → 项目 `.pi/workflows/` → 项目 `.agents/workflows/`（project-agents，最高优先）。

> **[MANDATORY] 主 agent 直接派，禁止 subagent 封装**：workflow 工具 `action:"run"` 是异步后台运行 + notifyDone 自动注入结果，主 agent 直接拿 return 值。workflow 自己会派 review agent + fix agent，subagent 封装只是多一层中转，白耗 context。

**发起（workflow 工具，action:"run"）**：

| 参数 | 说明 |
|---|---|
| `name` | 必填，脚本绝对路径 = `<repo 根>/.agents/workflows/pr-lifecycle.js`（从 `<available_workflows>` 清单的 location 取；按名解析已退役，裸名 not_found） |
| `base` | 可选，门禁/审查基线 ref 名（默认 `main`） |
| `maxRounds` | 可选，cr-fix 轮次上限（1-50，默认 10） |
| `reviewers` | 可选，维度白名单（逗号分隔，对 review-*.md 按路径子串匹配裁剪；缺省全部 8 维） |
| `simplifyMode` | 可选，`apply` \| `report`（默认 apply） |
| `skipSteps` | 可选，人工接管逃生舱（逗号分隔 step id，合法值与语义同路径 2） |

- 与路径 2 的 args 语义一一对应，仅承载形态不同（pi = 对象字段 / zcode = CreateWorkflow args）；`reviewers`/`skipSteps` 为逗号分隔字符串
- workflow 按 `base` 锁 commit hash 后编排全部 10 step，主 agent 一次发起，只做「等终态 → 披露 → 请求 push 授权」

**发起前披露义务 [MANDATORY]**（与路径 2 同款）：告知用户 simplifyMode 默认 **apply**——code-simplify 的「先报告、确认后改」确认断点已被该模式显式覆盖，**A 档（行为不变）高置信简化会在 push 授权之前自动改码并独立 commit**（`refactor: code-simplify — N 项`）；B 档（行为敏感）与低置信项只进报告不落地。用户不接受时传 `simplifyMode: "report"`。

**终态与处置**：return 契约与处置动作与路径 2 完全一致（`status=awaiting-push` 含 `prUrl/terminated/simplify/gates/skippedSteps/nextAction`；`status=failed` 含 `failedStep/error/recovery`，pr-submit 已成功时另含 `prUrl`）——按路径 2「终态映射表」执行：awaiting-push → 逐项披露 skippedSteps + 请求 push 授权；failed → 按 failedStep/error 处置后重新发起（可带 skipSteps 接管已人工裁决的 step）。**断点恢复差异**：pi 无 ResumeWorkflowRun——run 被中断（用户停止/provider 故障/进程退出）与 failed 终态处置后**都重新发起**（cr-fix 重跑 = loop 整体重跑，fix commit 已进 git 历史，已修复问题不再报出，通常 1-2 轮收敛）。中断时若有 gate 子进程在跑（abort 只终止 workflow 线程，不杀 detached 的 gate 子树），重发起前先确认无残留（`pgrep -f "pr-pre-merge|coverage-gate|metrics-gate"`），避免孤儿 gate 与新 run 并发写 `.review/` 读数。

cr-fix 内联循环的熔断语义与路径 2 完全一致：某 agent `mustFix === 0 且 suggestion === 0` 判 clean（修复范围 = 全部等级）；连续 3 轮 must_fix 不降 → `terminated=stuck`；问题经 2 次修复均复发（regressed）→ `terminated=needs-redesign`（fixAttempts 计修复失败次数，not-fixed 由 stuck 防线承接；deferred 条目唯一复活入口 = reviewer 对注入清单的结构化 escalate 申报）；fixer 疑似误报走 `disputed` 申述（file:line 反证，格式非法即 ES3 违规；合法申述豁免 must-fix 记账并随 failed 终态 error 的申述清单带出）；cr-fix `stuck`/`max-rounds`/`needs-redesign`/`needs-human` 一律 failed 人工接管（不放行，语义同路径 2 门禁收紧条款）。

**只跑 review+fix 循环时**（不进门禁、不开 PR）：改用 pi 内置通用 `review-fix-loop`（与 zcode saved 版存在差异，见「循环本体行为差异登记表」）——`targetType=git-diff` + `target=main`（base 启动时锁 hash 防 ref 漂移）；⚠️ `batch1` 必须传 **.md 绝对路径**（/ 或 ~/ 开头）逗号分隔，禁止相对路径/裸名；`autoCommit=true` fix 后自动 commit；`skipCleanAgents=true` 单轮 clean 的 agent 下轮跳过；`recheckAfterFix` 默认 false（省 token），担心 fix 引入回归时传 true 开强回归重审。

#### 路径 2：zcode 环境（原生 pr-lifecycle 单 workflow 全链）

**适用条件**：当前主 agent 是 zcode（有 `CreateWorkflow` 工具）。无需任何插件依赖。

pr-lifecycle（`.agents/skills/pr-cr-fix/workflows/pr-lifecycle.dwf.ts`）把本 skill 的阶段 1（preflight / static gate / pr-meta 含条件 changeset / skill-yaml / pr-submit）→ 阶段 2 前置（constraints）→ 阶段 1.5/1.6（gate-suite：coverage + metrics 聚合门禁）→ 阶段 2（cr-fix：内联循环本体，与全局 saved `review-fix-loop` 及 pi 版 prl 内联三镜像同源，8 维 agent .md）→ code-simplify（simplify step，固化契约见 `agents/simplify-apply.md`）→ 阶段 3a（final-gates 三道联动 + 收尾防线 + e2e 影响面披露）全部编排进单一原生 workflow 脚本（10 step）。**agent 上下文重合度合并约定**（2026-09-24）：两个会话各自必须加载的工作上下文重合高且无独立性要求的合并为一个 agent 一次处理——changeset 与 pr-meta 输入全同（commits + diff stat + changeset 清单）合为一个会话；coverage 与 metrics 失败常同文件同源，gate-suite 每轮聚合两道明细派单个修复会话（同文件多类问题一次修完）。独立视角要求的会话不合并（8 维 reviewer 各自 fresh eyes 读同一份 diff 是 review 的对价）。主 agent 一次发起，只做「等终态 → 披露 → 请求 push 授权」。

**发起（CreateWorkflow）**：

```
CreateWorkflow:
  path: <repo 绝对路径>/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.dwf.ts
  args:
    base: main            # 可选，门禁/审查基线 ref 名
    reviewers: [...]      # 可选，维度白名单（缺省全部 8 维）
    maxRounds: 10         # 可选，cr-fix 轮次上限
    simplifyMode: apply   # 可选，apply | report
    skipSteps: [...]      # 可选，人工接管逃生舱（10 step id）
  name: "PR 生命周期"
```

- 脚本 args 白名单 fail-fast（拼错键直接报错不静默回落）；`skipSteps` 合法值 = 十 step id（preflight / static-gate / pr-meta / skill-yaml / pr-submit / constraints / gate-suite / cr-fix / simplify / final-gates），被跳过的 step 终态逐项披露（changeset 已并入 pr-meta——跳过 changeset 判定用 skipSteps 含 pr-meta；coverage 与 metrics 合并为 gate-suite，不可单独跳其一）
- run 后台执行，完成通知自动回流（禁止轮询）；中途被停止（用户 / provider 故障 / 进程退出）→ `ResumeWorkflowRun` 续跑（引擎 journal 重放，已完成的 ask 与 world.run 不重付费）

**发起前披露义务 [MANDATORY]**：告知用户 simplifyMode 默认 **apply**——code-simplify 的「先报告、确认后改」确认断点已被该模式显式覆盖（固化契约 `agents/simplify-apply.md`），**A 档（行为不变）高置信简化会在 push 授权之前自动改码并独立 commit**（`refactor: code-simplify — N 项`）；B 档（行为敏感）与低置信项只进报告不落地。用户不接受时传 `simplifyMode: "report"`（完全不改码，断点语义完整保留）。

**终态映射表**（脚本 return 必含 `status`；成功另含 `prUrl/terminated/simplify/gates/skippedSteps/nextAction`；失败另含 `failedStep/error/recovery`）：

| scriptResult.status | 主 agent 动作 |
|---|---|
| `awaiting-push` | ① **逐项披露 skippedSteps**（每项 step + reason——被跳过的门禁必须让用户知情后才谈 push）；② 汇报 prUrl / gates（coverage/metrics/premerge）/ terminated / simplify；③ 请求 push 授权。**push 恒 `git push github HEAD:<branch> --force-with-lease`**（与 workflow 内 pr-submit.sh 同构：无条件 `--force-with-lease`，lease 在快进场景无副作用、远端有新提交时安全拒绝）；push 后验证远端 ref（`git rev-parse HEAD github/<branch>` 一致） |
| `failed` | 按 `failedStep` + `error`（内含恢复指引）处置：gate 修复子循环 3 轮超限 → 人工修复、显式路径 commit 后**重新发起**；gate-suite/final-gates exit 2（工具错误）→ 按输出修复后重新发起；pr-submit exit 2/3/5 → 按 error 指引（远端连通性 / `gh auth status`）后重新发起；cr-fix `stuck`/`max-rounds`/`needs-redesign` → 读 error 中报告路径（`.tmp/review-fix-loop/prl-<hash>/round-N/`）人工判定：**误报 → 重新发起并带 skipSteps 含 `"cr-fix"`（接管，终态逐项披露）；真问题 → 修复 commit 后重新发起**；cr-fix `needs-human` → 按 error 中申述清单（fixer 反证 file:line）逐项裁决（真问题修复 commit 后重新发起，误报带 skipSteps 接管），裁决结论逐项披露 |

**断点恢复语义**：run 被**中断**（非 failed 终态——用户停止 / provider 故障 / 进程退出）→ `ResumeWorkflowRun` 原地续跑（引擎 journal 重放：已完成的确定性 gate 与 ask 零成本重放）；**failed 终态**（gate 超限 / cr-fix 熔断 / 工具错误）→ 处置后**重新发起**（可带 skipSteps 跳过已人工接管的 step）。cr-fix 重跑 = loop 整体重跑（fix commit 已进 git 历史，重跑面向当前 diff，已修复问题不再报出，通常 1-2 轮收敛）。脚本有结构性错误（编译诊断 / 逻辑错）→ 编辑 run 的脚本文件后 `AmendWorkflow`（导入已完成工作为缓存，只重付改动部分）。

**门禁语义映射声明（两版 pr-lifecycle 相对路径 3 手工流程的四处收紧/承接，均非降级）**：

1. **修复范围收紧**：cr-fix 循环修复全部等级（must-fix + suggestion）且 clean 判定要求 suggestion 同为 0——严于路径 3「SUGGESTION 顺手修、INFO 忽略」。
2. **real-pi 移出**（2026-09-15 e2e 执行准则，SSOT = AGENTS.md「测试」节）：final-gates 的 test:runtime 由 pr-pre-merge.sh 内置 `TAIJI_SKIP_REAL_PI=1` 只跑 unit 轨（与 CI test-runtime job 同口径），real-pi 等价性用例不在 PR/merge 承接——移到开发阶段按改动面跑（tech-design e2e 影响面评估 + dev-flow 验收计划表圈定，机器对账入口 = `node scripts/select-affected-e2e.mjs --base <base>`，SSOT = `docs/testing/e2e-map.json`）。final-gates 不设 real-pi 凭证预检、不解析输出 skip 标记：skip 标记是 unit 轨的预期输出，不构成失败。
3. **stuck 收紧为 failed**：`stuck`/`max-rounds`/`needs-redesign`/`needs-human` 一律 failed 人工接管（两版 pr-lifecycle 同语义）。对照「只跑循环」实体（pi 内置 review-fix-loop / zcode saved）的放行语义（`terminated ∈ {clean, converged, stuck}` 均可进阶段 3，stuck 的「误报可人工 ack」处置见失败恢复表只跑循环行）——全链路径下该放行语义不存在：接管必须经 skipSteps 逃生舱，且终态逐项披露保证知情。
4. **Gate-3 三分量承接**：`pr_exists` = pr-submit step done；`premerge.result == "PASS"` = final-gates step done；`local_ahead_of_origin == 0` 由 push 动作本身达成（push 后验证远端 ref）。

#### 路径 3：无 workflow 能力环境（手工编排，上限 2 轮）

**适用条件**：既非 pi 环境也非 zcode 环境（无 workflow 工具 / 无 CreateWorkflow 时的兜底）。

##### 派发前：按 diff 选维度（主 agent 自己跑）

按**路径匹配**（不做语义判断——不可审计、漏派无解释），`git diff main...HEAD --name-only` 对照下表。**默认全集、只写明确排除条件**：

| 排除条件（路径匹配，全部不满足才跳过） | 跳过的维度 |
|---|---|
| 不含 `packages/runtime/**`、`apps/electron/**`、runtime `package.json` 依赖变更 | electron-build |
| 不含 `extensions/**` | extension-api |

其余 6 维（arch-boundary / business-logic / type-safety / test-coverage / monorepo-impact / data-governance）恒派。electron-build 排除条件刻意收得很紧：`packages/runtime/**` 任何改动（不只打包配置）都保留该维度——runtime 源码的 CJS 兼容违规（`import.meta.url`）是其重要检查项（AGENTS.md 关键规则 12「事故最高发」）。映射表保守取向：宁可多派不漏派。

##### 第 1 轮

**Step 1 — 确认变更范围**（主 agent 自己跑）：
```bash
git diff main...HEAD --stat
node scripts/select-constraints.mjs --base main   # 产出 .review/constraints.md（命中约束清单，reviewer 消费）
```

**Step 2 — 并行派 reviewer subagent**：选中维度全派。**并行上限 ≤5**（全局 AGENTS.md subagent 约束），按维度子集数分批（8 维分两批 5+3；不足 5 个一批派完；或按全局规则「一般用 3 个」分三批）。每个 subagent 的 task 必须包含：

- worktree cwd（绝对路径，避免 multi-worktree cwd 陷阱）+ 审查 `git diff main...HEAD` 的全部变更
- focus（见下方「维度 → Agent 映射」表对应审查焦点）
- agent 定义文件路径（`<repo>/.agents/skills/pr-cr-fix/agents/review-<维度>.md`，subagent 须复读原文获得完整 checklist）
- `.review/constraints.md` 命中约束清单（存在时必须消费：dimensions 含本维度的条目逐条核对，`enforcement: review` 的条目是重点；权威源文档按需 Read 原文）
- `output 路径：<绝对路径>` + `Write report to: <绝对路径>`（双措辞兼容 agent 约定）
- 「输出格式：YAML frontmatter（verdict/must_fix）+ Findings 表格（优先级 | 文件 | 行号 | 类别 | 描述 | 修复方向），优先级用 MUST_FIX/SUGGESTION/INFO」
- 「完成后用 structured-output 返回 `{report_file, must_fix, suggestion}`」

**Step 3 — 主 agent 手工聚合**：收集各 subagent 结构化结果 → 按 (file, line, description) 三元组去重 → 按优先级排序（MUST_FIX → SUGGESTION → INFO）→ 写 `aggregated.md`（含 `## Summary` + `- Must-fix: N` + `- Suggestions: N` 行，便于核对）

**Step 4 — 修复 MUST_FIX**（条件触发，`must_fix > 0` 时）：

- 按文件归属分组，每组派 1 个 `worker` subagent 并行修复（≤5）。worker task 含：review 报告原文路径（worker 必须复读）+ 本组问题清单 + 「全部修复，不分严重等级」+ 「修复后 `pnpm -r typecheck` 通过」；完成后 commit `fix: review round 1 — N must-fix`
- **每条先验证真实性再修**：worker 逐条读代码证实 review 断言；不成立的（误报）在报告列「已验证不成立 + 证据（file:line + 逻辑）」，不盲改
- **测试类问题派独立测试 subagent**，与修复 worker 分离：补测试 / 验证修复有效性（bug 类修复要求「修前红修后绿」——回归测试在旧代码上必须 fail、新代码上 pass，证明测试真能抓 bug 而非凑数）

##### 第 2 轮（条件触发）

**全部选中维度 clean（`must_fix=0`）且无 fix commit → 跳过第 2 轮，直接进阶段 3**（代码零改动，复验无对象）。否则**只重派「上轮 `must_fix > 0` 的维度」**，上轮 clean 的维度不重审——对齐路径 1 `skipCleanAgents: true` 语义，两路径行为一致；重派维度天然复验自己报的问题已修。重复第 1 轮 Step 2-4。第 2 轮结束即终止；残留 MUST_FIX 上报用户决策。

> 为什么上限 2 轮 + 条件跳过：第 1 轮发现问题、第 2 轮验证修复，是手工编排下回归防护的最小完整单元；全 clean 零修复时该动机不成立，条件跳过。更多轮需要自动化编排支撑（即路径 1 的 workflow）。用户对某次修复不放心时可手动要求重派全部维度（等价路径 1 `recheckAfterFix=true`），不进默认流程。

### 维度 → Agent 映射（三路径共用）

Agent 定义位于本 skill 目录 `agents/review-<维度>.md`（不全局暴露，仅本 skill 内部引用）。

| 维度 | Agent 实体 | 审查焦点 |
|------|-----------|---------|
| 架构边界 | `agents/review-arch-boundary.md` | Electron 分层（main/preload/renderer/shared）、runtime 三层（transport/services/infra）、WS session 隔离、IPC/emit 规范、数据目录隔离、路径白名单动态化、ENV SSOT、Extension vs Plugin 边界、v3 视图拓扑 |
| 业务逻辑 | `agents/review-business-logic.md` | 逻辑正确性、边界条件、异常路径、回归风险、错误状态重置（isGenerating/streamingMessage）、emit 单 payload、Promise.allSettled、streaming 生命周期、session 双状态、文件持久化与 Store 同步 |
| 类型安全 | `agents/review-type-safety.md` | 完整类型标注、禁止 any（显式/隐式）、类型守卫、tsc/vue-tsc、Pi* 类型分层约束（仅 infra 层可见） |
| Electron 打包 | `agents/review-electron-build.md` | tsup 配置（noExternal/Worker entry/CJS 兼容）、electron-builder（files/asarUnpack/symlink）、子进程启动、打包验证三阶段 |
| 测试覆盖 | `agents/review-test-coverage.md` | 新增逻辑有测试、边缘情况覆盖、vitest 合规（禁 node:test）、领域测试点（session 双状态/Extension vs Plugin/ports 接口） |
| 扩展接口 | `agents/review-extension-api.md` | Pi 扩展 tool/command schema 完整性、向后兼容性、扩展规范合规（docs/extensions/extension-conventions.md + development-guide.md） |
| Monorepo 影响 | `agents/review-monorepo-impact.md` | workspace 包间依赖（packages/* + apps/* + extensions/* + extensions/shared/*）、循环依赖、公共 API 变更对下游影响 |
| 数据治理 | `agents/review-data-governance.md` | pi 文件直写（绝对写规则）、第二写入者、事件直写状态、renderer 零派生、未登记缓存、扩展数据通道（appendEntry/get_entries）、登记表同步。准绳：docs/architecture/data-source-governance.md + data-source-registry.md |

Pi Extension 接口契约 checklist（SDK 签名核对 / spec 偏差记录 / schema 一致性 / 类型断言守卫）已并入 `agents/review-extension-api.md`，该 agent 审查时自动覆盖，主 agent 不另行逐条核对。

### 严重度分级

- **MUST_FIX** — 必须修复，阻塞合并。对应架构约束违规、会导致 bug、违反 [HISTORICAL] 规则的问题
- **SUGGESTION** — 强烈建议修复。不阻塞但影响代码质量、可维护性
- **INFO** — 可选改进。代码风格、文档、轻微品味问题。每条条目格式：`[SEVERITY] file:line — 问题描述` + `→ 建议修复方式`

### [OPTIONAL] 文档/prompt 质量审查（CoT Leakage）

**触发条件**：diff 触及 `.agents/skills/`、`.agents/agents/`、AGENTS.md、`docs/`、`.cw/` 中的 prompt 文本（排除 node_modules/构建产物/记录的模型输出与 fixture）。唯一测试（只读 HEAD、无会话记录的读者能否解析每个引用、验证每个断言）、泄漏分类法、非 leakage 白名单与过度修剪陷阱见 `references/cot-leakage.md`。

---

## 阶段 3：pre-merge + push

### 3a — 终局三道 gate（主 agent 直接按序跑）

阶段 2 修复会改代码，1.5/1.6 初跑读数已过期。**顺序固定 coverage → metrics → pre-merge**（coverage 的 files 节供 metrics 分流，见 1.6；pre-merge 注入值来自 coverage-gate 测试判定）：

```bash
# ① coverage-gate：测试第 2 遍（插桩口径）+ 覆盖率终值；diff 含 shared src 时同样传 --extra-packages（见 1.6）
python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base main
# ② metrics-gate：结构度量终值
python3 .agents/skills/pr-cr-fix/scripts/metrics-gate.py --base main
# ③ pre-merge 终局：typecheck 三处 + lint 实跑；test:runtime 实跑；test:extensions/renderer 以注入值计
bash scripts/pr-pre-merge.sh --test-result <PASS|FAIL> --quiet
```

- ③ 注入值 = ① 的测试判定（任一被 gate 包测试失败 → 注入 FAIL）。脚本校验 `.review/coverage.json` 存在且 base 与当前一致（防注入过期读数），不一致 exit 2 → 恢复：重跑 ① 后再 ③
- **任一 gate FAIL 仍走完 ③ 写 marker**（pr-status.sh 可见终态），Gate-3a 拦截不 push；按失败输出派 worker / 测试 subagent 修复后**从 ① 头部重跑**。路径 2 例外：pr-lifecycle 的 final-gates 在 coverage 失败时短路返回（不跑 metrics/pre-merge、marker 不写），直接进修复子循环——省时且语义等价（修复轮从 ① 头部重跑覆盖全部三道）

**Gate-3a**（硬 gate）：三道 gate 全部 exit 0 且 marker `result=PASS` 才继续。coverage-gate exit 1 → 增量不足派测试 subagent 补测试 / 测试失败按失败用例派 worker；metrics-gate fail → 派 worker 修复；pre-merge FAIL → 按失败步骤对应工种修复。

**e2e 影响面披露（非门禁）**：Gate-3a 通过后跑 `node scripts/select-affected-e2e.mjs --base <base>`，向用户披露本次 diff 影响的 e2e 资产（受影响 rule 清单 + 各自运行命令，SSOT = `docs/testing/e2e-map.json`）。PR/merge 门禁不跑真实 LLM e2e（见下方「real-pi 测试分工」），此披露只保证「哪些 e2e 面被本次改动触及、由开发阶段承接」对用户可见，不阻塞流程。

**real-pi 测试分工 [MANDATORY]**：CI 不跑 real-pi 测试（ci.yml test-runtime 显式设 `TAIJI_SKIP_REAL_PI=1`，只跑凭证无关子集）；**PR/merge 门禁同样不跑**（2026-09-15 e2e 执行准则，SSOT = AGENTS.md「测试」节）——3a 的 `test:runtime` 以 `TAIJI_SKIP_REAL_PI=1` 只跑 unit 轨，与 CI 完全同口径（skip 标记属预期输出，不是验收缺口）。真实 pi 等价性用例（live ≡ reload 基线，SSOT 见 TEST-STRATEGY.md「等价性测试双轨」）在**开发阶段按改动面**执行：清单由 tech-design 设计文档的 e2e 影响面评估圈定、dev-flow 验收计划表承接，空载串行跑（跨包并发会饱和 CPU 使真实 LLM 轮次延迟越过事件预算）；涉及 pi 协议链路 / entry reducer / replicated-states 失效收敛的改动，开发期跑对应子集，不进 PR/merge。

### 本地验证缩窄声明（CI 承接）

本流程下**未被 diff 触及的包本地测试 0 遍**（原「1.1/3a 无条件三线全量」已取消）。承接证据：CI 四个 test job 覆盖全部测试线——test-runtime / test-renderer（含全量 thresholds）/ test-main / test-extensions（`pnpm extensions:test` 跑全部 pi-* 包）。**real-pi 无例外承接方**：CI skip、本地 3a 也以 `TAIJI_SKIP_REAL_PI=1` 只跑 unit 轨——real-pi 由开发阶段按改动面承接（见「real-pi 测试分工」）。被 diff 触及的包测试恰 2 遍（1.6 插桩 + 3a 插桩终值；runtime 线 = 1.6 插桩 + 3a 无插桩专项，物理不可合并）。

### 3b — push（需用户授权）

**[MANDATORY] push 前必须获得用户明确授权。** pre-merge 通过后，告知用户结果，等待用户确认后再 push。

```bash
git push github HEAD:<branch>
# force_push=true 时
git push github HEAD:<branch> --force-with-lease
```

**路径 2（pr-lifecycle）**：3b 恒 `git push github HEAD:<branch> --force-with-lease`——workflow 内 pr-submit.sh 即无条件 `--force-with-lease`（两者同构：lease 在快进场景无副作用、远端有新提交时安全拒绝），`force_push` 判定链在本路径不存在。

PR 已在阶段 1 开好，同分支 push 即自动更新 PR。push 后验证远端 ref 等于本地 HEAD（`git rev-parse HEAD github/<branch>`），可选跑 `scripts/pr-status.sh` 确认 PR 健康，已有 PR 时 `gh pr checks` 看 CI。

push 了发布 tag（`v*`/`npm-*`）时必须等 CI 构建完成并验证产物存在，不能 push 后直接宣布完成（见根 AGENTS.md「发布与 CI 验证」）。

### 按包路径选择测试范围（日常 push 场景）

当用户只需要 push 到已有 PR 分支（不走完整 PR 流程），按 `git diff` 定位改动包，只跑相关证据，拒绝反射性跑全量套件（CI 拥有穷尽覆盖；本地是「我的改动是否把对应包弄挂了」的最小证据）：

- **packages/<pkg>/** → 进该 workspace 跑 `npx vitest run`（可 `-t <name>` 聚焦）+ 改动文件的 eslint
- **extensions/** → `pnpm run extensions:typecheck && pnpm run extensions:lint && pnpm run extensions:test`
- **apps/electron/** → `pnpm run build` + 改动文件的 eslint
- **docs/、.agents/、*.md** → 文档检查（`git diff --check` + 通读 + SSOT 一致性核对）
- **共享包**（packages/shared 等）→ 该包测试 + 依赖它的包测试；共享契约改动才加相邻包
- **跨包横跨全仓** → 全量本地预演的正当理由

同一 diff 刚跑过的检查不重复跑。push 前相关检查失败：停下修复或说明，不要 push 后指望 CI 兜底。仅当用户明确要求、诊断 CI 失败、或改动横跨全仓时才跑完整本地预演（`pnpm run lint` + 各 workspace vitest + `pnpm run extensions:test` + `pnpm run build`）。

### Gate-3 双层判定

| 层 | 判定 |
|----|------|
| 硬 gate | `pr_exists && local_ahead_of_origin == 0 && premerge.result == "PASS"` |
| 软 gate | 阶段 2 `terminated` 非 `needs-redesign`（`needs-human` 须已按 disputed 申述裁决——内置版 = `result.disputed`，prl 版 = failed 终态 error 中的申述清单）+ 阶段 3a PASS |

---

## 关键约束 [MANDATORY]

1. **阶段顺序不可调换**：1（PR + static gate）→ 1.5（度量门禁）→ 1.6（增量覆盖率门禁；执行时 coverage 先于 metrics）→ 2（review+fix）→ 3（pre-merge + push）；Gate-1.5 fail 时禁止进入阶段 2，Gate-1.6 fail 时补测试后重跑（上限 3 轮）
2. **主 agent 不跑 review/fix 实现命令**：review 委托 workflow（路径 1 pi / 路径 2 zcode）或 subagent（路径 3）。确定性脚本（gate 脚本 / commit / push / pr-status.sh / pr-submit.sh）主 agent 可直接跑
3. **push 必须用户授权**：任何 push 操作前必须告知用户结果并获得确认
4. **force-push 决策传递**：阶段 1 `force_push=true` → 阶段 3b 必须用 `--force-with-lease`；裸 `--force` 禁止。（路径 2 pr-lifecycle 下无此判定链：3b 恒 `--force-with-lease`，见 3b 节）
5. **禁止 skip 开关**：`SKIP_LINT=1` / `SKIP_EXTENSION_LINT=1` / `--no-verify` / `eslint-disable` 静默。检查不通过 = 流程中止，唯一出路是修复代码让检查通过
6. **pr-pre-merge.sh 是 stage marker 唯一写入方**：阶段 1.1（`--skip-tests`）与 3a（`--test-result PASS|FAIL`，注入值取自刚跑的 coverage-gate 测试判定）必须调它，不能直接跑 `npx vitest run` 替代（marker 不写则 Gate-3 恒 not_run）。无参全量模式仅供手动预演，流程内禁用——1.1 应 `--skip-tests`、3a 应 `--test-result`（两模式互斥，传错 exit 2）

## 反模式

| 反模式 | 后果 |
|--------|------|
| 主 agent 自己跑 review 代码 | 越权，review 应委托 |
| pi 环境下阶段 2 手写 review subagent 并行/分批（绕过 workflow） | 复现 review-fix-loop 已有能力，漂移风险 |
| zcode 环境手工编排 review subagent 分批（应走 pr-lifecycle 单 workflow） | 复现 workflow 已有能力，聚合/轮次/熔断/断点恢复全靠手写，漂移风险 |
| zcode 环境走完整 PR 生命周期却绕过 pr-lifecycle 直接裸调 saved review-fix-loop | 丢失 PR 阶段门禁 / 断点恢复 / code-simplify 编排；仅 review+fix 循环（不进门禁、不开 PR）单跑 saved 版为合法场景 |
| pi 环境走完整 PR 生命周期却绕过 pr-lifecycle 直接裸调内置 review-fix-loop | 丢失 PR 阶段门禁 / code-simplify 编排；仅 review+fix 循环（不进门禁、不开 PR）单跑内置版为合法场景 |
| 阶段 2 派 subagent 封装 workflow | 多一层无增益中转 |
| workflow 后台 run 后轮询 status/list 等结果（pi / zcode 通用） | 通知自动回流（pi notifyDone / zcode 完成通知），轮询白耗 |
| 阶段 1.1 跑无参全量 pre-merge（应 `--skip-tests`） | review 前空跑一遍无插桩全量测试，review/修复后读数全部过期作废 |
| 阶段 3a 跑无参全量 pre-merge（应 `--test-result`） | extensions/renderer 线与 coverage-gate 同批测试背靠背重复执行 |
| 第 1 轮全 clean 且无 fix commit 仍派第 2 轮 | 纯空转 subagent（新规则：条件跳过） |
| 派发前凭语义判断跳过维度（不查路径映射表） | 不可审计、漏派无解释 |
| 阶段 3a 直接跑 vitest 替代 pr-pre-merge.sh | marker 不写 |
| 未获用户授权就 push | 违反 push 授权约束 |
| 删/改 pr-cr-fix/agents/ 下的 review agent | 破坏 review 维度完整性 |

## 失败恢复

| 失败 | 动作 |
|------|------|
| Gate-1 拿不到 URL | 重试阶段 1；gh 认证问题先 `gh auth login` |
| Gate-1a static gate FAIL | 按失败步骤（typecheck 三处 / lint）派对应工种 worker 修复后重跑 |
| Gate-1.5 fail 超 3 轮 | 上报用户决策（不自动继续，不进阶段 2） |
| Gate-1.6 增量覆盖率 <80% | 派测试专项 subagent 按 coverage.json uncovered_files 补测试 → 重跑（上限 3 轮；超限上报用户） |
| Gate-2（只跑循环）`terminated=needs-redesign` | 结构性问题，上报用户决策（不自动重试） |
| Gate-2（只跑循环）`terminated=needs-human` | fixer 误报申述转人工：按 `result.disputed` 反证逐项裁决——真问题修复后进阶段 3，误报 ack 后进阶段 3；裁决结论逐项披露（disputed 条目格式非法仍会 fix-failure，见 fix-failure 行） |
| Gate-2（只跑循环）`terminated=stuck` | 看 aggregated.md 判断是 reviewer 误报还是真问题；误报可人工 ack 后进阶段 3，真问题上报用户（两版 pr-lifecycle 全链的 stuck 一律 failed，处置见下行 pr-lifecycle 行——不适用本行 ack 语义） |
| Gate-2（路径 1/2）cr-fix 环境类失败（review-failure / aggregator-failure / fix-failure） | pr-lifecycle 已自动重试 1 次（fix-failure 且工作区有未提交残留时不重试直接 failed——error 文案自带说明）；failed 终态按 `error` 恢复指引处置（检查引擎凭证 / 模型配额后重新发起，cr-fix 整体重跑） |
| Gate-2（路径 1/2）cr-fix 终态 `stuck` / `max-rounds` / `needs-redesign` | failedStep=cr-fix：读 error 中报告路径（`.tmp/review-fix-loop/prl-<hash>/`）人工判定——误报重新发起并带 skipSteps 含 `"cr-fix"`，真问题修复 commit 后重新发起（`fixed-unverified` 为旧 pr-review-fix 终态，已随其退役） |
| Gate-2（路径 1/2）cr-fix 终态 `needs-human` | failedStep=cr-fix：按 error 中申述清单（fixer 反证 file:line）逐项裁决——真问题修复 commit 后重新发起，误报带 skipSteps 含 `"cr-fix"` 接管，裁决结论逐项披露 |
| 3a coverage-gate exit 1 | 注入 `--test-result FAIL` 写 marker 后拦截：增量不足派测试 subagent 补测试、测试失败按失败用例派 worker；从 3a ① 重跑 |
| 3a pre-merge exit 2（coverage.json 缺失 / base 不一致） | 工具错误：重跑 3a ① coverage-gate 后再 ③ |
| Gate-3a pre-merge FAIL | 按 `failed_step` 重派 worker 修复后从 3a ① 重跑 |
| 阶段 3b push 冲突 | `git fetch && git rebase` 后重试；重写历史后重审未解决的 review 线程 |
| （路径 1/2）pr-lifecycle failed（任意 failedStep） | 一律先读 return 的 `error`（内含恢复指引）与 `recovery` 字段（pr-submit 已成功时 return 另含 `prUrl`，重跑幂等更新既有 PR）；处置（修复 commit / 环境修复）后重新发起，已人工接管的 step 经 skipSteps（pi）/ args.skipSteps（zcode）跳过（详见路径 2 终态映射表） |
| （zcode 路径 2）run 被中断（用户停止 / provider 故障 / 进程退出，非 failed） | `ResumeWorkflowRun` 原地续跑（引擎 journal 重放，已完成 ask 与 world.run 零成本）；脚本本身有结构性错误时编辑 run 脚本文件后 `AmendWorkflow` |

## 本 skill 目录结构

```
.agents/skills/pr-cr-fix/
├── SKILL.md              # 本文件
├── agents/               # 8 个 review agent 定义 review-<维度>.md + simplify-apply.md（pr-lifecycle simplify step 的 code-simplify 固化契约：覆盖声明 / 引用锚点 / 维护义务；不全局暴露）
├── references/           # 触发场景才 read：coverage-industry-research.md（覆盖率调研）/ cot-leakage.md（CoT Leakage）/ mutation-testing.md（Mutation 深检）
└── scripts/              # metrics-gate.py / coverage-gate.py（含 --extra-packages）/ validate-skill-yaml.py

└── workflows/
    └── pr-lifecycle.dwf.ts  # 路径 2（zcode 原生）PR 全生命周期单 workflow（/* zcode-workflow */ 块声明 args；CreateWorkflow path 调用）
（演进：zsw 引擎版 pr-lifecycle.js/lib.cjs 已退役（2026-09-24 两版本收敛裁决，git 可追溯）；
路径 1 的 pi 版全链 workflow 在项目级 `.agents/workflows/pr-lifecycle.js`（pi workflow discovery
的 project-agents 源，随 git 分发）——其 cr-fix 内联循环与 zcode 版 prl 内联 + 全局 saved
review-fix-loop.dwf.ts 三镜像同源，改任一侧须同步另两份循环语义）
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据实际情况决定 |
