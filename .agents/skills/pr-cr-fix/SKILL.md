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
- zcode 环境走路径 2 需 z-subagent-workflow **≥ 1.2.0**（zsw CLI `~/.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/<版本>/bin/zsw.js`，或 zflow MCP 工具）；workflow 脚本 `.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js` 本仓自带（随 git 分发）。**用户脚本不被引擎自动发现，按 .js 绝对路径调用是唯一项目脚本通路**（`script:` 前缀已废弃拒收）；发起前可校验：`node <zsw-cli> workflow --action lint --file <脚本绝对路径>`
- zcode 主 agent 另有**原生 saved workflow `review-fix-loop`**（全局注册 `~/.zcode/workflows/`，无需 zsw）——只跑 review+fix 循环时按下方「review-fix-loop 宿主路由」使用；完整 PR 生命周期仍需 zsw（路径 2 全链）

## 调用约定

- `cwd`：git 根目录绝对路径（`git rev-parse --show-toplevel`）
- 确定性脚本主 agent 直接跑，不派 subagent：阶段 1.1 static gate、1.5 / 1.6 两道 gate、阶段 3a 终局三道 gate
- 阶段 2 由主 agent 直接派 workflow（路径 1 pi 跑内置 review-fix-loop / 路径 2 zcode 跑 **pr-lifecycle 单 workflow 全链**）或 reviewer subagent（路径 3 手工兜底），不经 subagent 封装；修复 / 补测试派 worker subagent。路径 2 下阶段 1 → 1.5/1.6 → 2 → simplify → 3a 全部由 pr-lifecycle 编排，主 agent 不逐步执行（见「路径 2」节）；路径 1/3 仍按下列各阶段手工走。主 agent 全程只做编排 + Gate 校验 + push 前用户授权确认

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

**执行顺序：coverage-gate 先跑，metrics-gate 后跑。** coverage-gate 产出 `.review/coverage.json` 的 `files` 节（全文件级真实 lcov 覆盖率），metrics-gate 消费它把 complexity warn 中**真实文件覆盖 ≥80%** 的条目移入 covered 列表（出 warn、保留证据链），替换 fallow 静态估算。阶段 1 初跑与 3a 复跑均按 **coverage → metrics** 顺序；coverage.json 缺失或 base 不匹配时 metrics-gate 自动降级静态估算（不阻塞，报告标注 `fallow-static`）。

### 执行（主 agent 直接跑）

```bash
python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base main
# diff 含 packages/shared/**/src/** 时传下游追加（见下方 shared 下游传播）：
python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base main --extra-packages packages/runtime,packages/renderer
```

- 自动检测 base...HEAD 改动过 `src/` 的 vitest 包（含 `extensions/shared/<lib>` 三层目录），逐包跑 `vitest run --coverage`（lcov），解析 lcov DA 行命中 × git diff 新增行号（精确路径匹配），算**可执行新增行覆盖率**
- **判定**：任一被 gate 包增量 < 80%（默认）或测试失败 → `verdict=fail` exit 1；记账不闭合 / all-SKIP / git 瞬态异常 → exit 2（工具错误，修复后重跑）；产出 `.review/coverage.json`（packages 增量口径 + files 全文件级真实覆盖率 + files_without_lcov 盲区清单）。SKIP 语义：按 package.json **声明**判定（非 node 解析），出现 SKIP 即配置漂移，按报告内指引补声明
- **shared 下游传播**：包选择只收自身有 `src/` 改动的包，shared 改动不传播下游；diff 含 `packages/shared/**/src/**` 时传 `--extra-packages packages/runtime,packages/renderer`——实跑两包全量插桩测试，承接「1.1 不再跑全量测试」后的下游兜底。**连带效应**：renderer vitest.config 内的全量 thresholds（CI 强制口径）随之生效，thresholds breach 视同测试失败走 FAIL 路径（与本次改动无关的全量退化同样拦截；该失败输出与 uncovered_files 增量口径不同源，排障注意区分）
- `--packages <pkg>` 是交集过滤器（单包探针用，会以单包产物覆盖 coverage.json，探针后重跑全量恢复）；`--extra-packages` 是追加器，两者语义不同、可共存。**注意**：修复 worker 在途时本地读数会被污染——Gate-1.6 必须在干净工作区（全部改动已 commit）跑

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

### [MANDATORY] 三路径选择

**review-fix-loop 宿主路由（循环本体双版本）**：review+fix 循环本体有两个同源实现，按主 agent 宿主路由——pi 主 agent 用 **pi 内置版**（`pi workflow run review-fix-loop`，路径 1）；zcode 主 agent 用 **zcode 原生 saved workflow `review-fix-loop`**（全局注册 `~/.zcode/workflows/`，经 CreateWorkflow `saved: { name: "review-fix-loop", args: {...} }` 发起；`args.reviewers` = agent .md 绝对路径数组，等价 pi 版 `batch1`；`base` 等价 `target=main`）。zcode 版差异：无 `aggregatorModel`（per-call 模型路由不存在，模型由 run 级 subagent_model 承载）、无嵌套 workflow、断点恢复走引擎原生（AmendWorkflow / ResumeWorkflowRun，无 zsw 版 runId/resumeCommand）、报告落 `reportDir`（默认 `.review/review-fix-loop/`，`round-<n>/` 下 reviewer 报告 + aggregated.md）。适用边界：**只跑 review+fix 循环**（不进门禁、不开 PR）时按宿主路由单跑；**完整 PR 生命周期 zcode 仍走路径 2 全链**（zsw pr-lifecycle 内嵌 zsw 版循环，门禁语义与终态映射见该节）。

#### 路径 1：pi 环境（有 pi workflow 能力）

**适用条件**：当前主 agent 是 pi agent，且能调用内置 workflow（`pi workflow list` 中名为 `review-fix-loop`、无 `.js` 路径后缀的条目即内置版；完整解析顺序见 `extensions/universal/subagent-workflow/src/shared/resource-discovery.ts`，常用为内置 → npm 包 → 项目 `.pi/workflows/`）。

主 agent 直接用 workflow 工具跑内置 `review-fix-loop`（8 维并行 review → 聚合 → fix → 重审直到 clean/converged/stuck）：

> **[MANDATORY] 主 agent 直接派，禁止 subagent 封装**：workflow 工具 `action:"run"` 是异步后台运行 + notifyDone 自动注入结果，主 agent 直接拿 `terminated/rounds/aggregated_file`。workflow 自己会派 review agent + fix agent，subagent 封装只是多一层中转，白耗 context。

```bash
# ⚠️ batch1 必须传 **.md 绝对路径**（/ 或 ~/ 开头），禁止相对路径/裸名：
#   resolveAgentDefs 要求每项 ^/ 或 ^~/ 开头 + .md 结尾，否则抛「无效 agent 引用」
# targetType=git-diff + target=main：审查 git diff main...HEAD（base 启动时锁 hash 防 ref 漂移），含未提交工作区改动
# autoCommit=true：fix 后自动 commit；skipCleanAgents=true：单轮 clean 的 agent 下轮跳过
# recheckAfterFix 默认 false（省 token）；担心 fix 引入回归时传 true 开强回归重审
pi workflow run review-fix-loop --args '{
  targetType: "git-diff",
  target: "main",
  batch1: "<repo>/.agents/skills/pr-cr-fix/agents/review-arch-boundary.md,<repo>/.agents/skills/pr-cr-fix/agents/review-business-logic.md,<repo>/.agents/skills/pr-cr-fix/agents/review-extension-api.md,<repo>/.agents/skills/pr-cr-fix/agents/review-monorepo-impact.md,<repo>/.agents/skills/pr-cr-fix/agents/review-type-safety.md,<repo>/.agents/skills/pr-cr-fix/agents/review-electron-build.md,<repo>/.agents/skills/pr-cr-fix/agents/review-test-coverage.md,<repo>/.agents/skills/pr-cr-fix/agents/review-data-governance.md",
  maxRounds: 10,
  autoCommit: true,
  recheckAfterFix: false,
  skipCleanAgents: true
}'
```

内置行为要点：某 agent `must_fix === 0` 判 clean；连续 3 轮 must_fix 不降 → `terminated=stuck`；问题经 2 次修复未收敛 → `terminated=needs-redesign`；聚合器内置（合并去重为 `aggregated.md` + must_fix 计数）。

**Gate-2**：workflow `terminated` ∈ {`clean`, `converged`, `stuck`} → 进阶段 3。`terminated=needs-redesign` = 结构性问题需人工介入，**停手上报用户**。`terminated ∈ {review-failure, aggregator-failure}` = 结构化失败终态（review agent 调用失败/结果无效、aggregator 失败且 fallback 失败；实装见 review-fix-loop.js）：环境问题，调参重跑一次，再败**停手上报用户**（处置与路径 2 同类问题一致）。

#### 路径 2：zcode 环境（z-subagent-workflow ≥1.2.0，pr-lifecycle 单 workflow 全链）

**适用条件**：当前主 agent 是 zcode，且有 zsw CLI（`~/.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/<版本>/bin/zsw.js`）或 `zflow` MCP 工具（z-subagent-workflow ≥1.2.0）。用户脚本不被引擎自动发现——**`.js` 绝对路径调用是唯一项目脚本通路**（`script:` 前缀已废弃拒收）。

pr-lifecycle 把本 skill 的阶段 1（static gate / changeset / pr-meta / skill-yaml / pr-submit）→ 阶段 2 前置（constraints，对应「约束动态加载」节）→ 阶段 1.5/1.6（coverage-1 / metrics-1）→ 阶段 2（cr-fix：嵌套内置 `review-fix-loop`，batch1 = 8 维 agent .md，与路径 1 同源）→ code-simplify（simplify step，固化契约见 `agents/simplify-apply.md`）→ 阶段 3a（final-gates 三道联动 + 收尾防线）全部编排进单一 workflow 脚本，脚本自持断点恢复（`.review/pr-workflow/<runId>/state.json`）。主 agent 一次发起，只做「等终态 → 披露 → 请求 push 授权」。

**发起（fresh）**：

```bash
node <zsw-cli> workflow --workflow <repo>/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js \
  --task "<PR 背景：分支目的+主要改动面+gates 结果，自包含>" \
  --workdir <repo 绝对路径> --repo <repo 绝对路径> --timeout-ms 21600000
```

- **`--repo` 必传**：目标仓库根绝对路径——workdir 是引擎保留键（agent cwd 用），脚本读不到它；缺省回落宿主 cwd 并在日志注明回落事实，非仓库根 fail-fast（error 指引补 `--repo`）。resume 时 `--repo` 必须与原 run 一致（守卫 2 校验）
- CLI run 恒本地同步执行：zcode 下用 Bash `run_in_background` 包裹等待，完成后读输出（scriptResult JSON）
- 可覆盖参数：`--runId prw-...`（断点恢复）、`--skip-steps "cr-fix,simplify"`（人工接管逃生舱，逗号串）、`--max-rounds N`、`--simplify-mode report`、`--base <ref>`、`--reviewers <逗号串白名单>`、`--aggregator-model <provider/model>`（cr-fix 聚合阶段模型；缺省跟随 run 模型，仅当聚合需降档/升档时设置——provider 必须为当前引擎侧存在者）、`--allow-external-changes`（HEAD 外部变更显式放行）

**发起前披露义务 [MANDATORY]**：告知用户 simplifyMode 默认 **apply**——code-simplify 的「先报告、确认后改」确认断点已被该模式显式覆盖（固化契约 `agents/simplify-apply.md`），**A 档（行为不变）高置信简化会在 push 授权之前自动改码并独立 commit**（`refactor: code-simplify — N 项`）；B 档（行为敏感）与低置信项只进报告不落地。用户不接受时传 `--simplify-mode report`（完全不改码，断点语义完整保留）。

**恢复（resume）**：同 fresh 命令（含 `--repo <repo 绝对路径>`，与原 run 同仓）+ `--runId prw-...`。runId 三通道：① failed 终态的 `resumeCommand` 字段（可直接复制执行）；② `cat .review/pr-workflow/latest`（脚本暴毙无通知时的兜底）；③ run 日志首行。

**终态映射表**（scriptResult 必含 `status/runId`；成功另含 `prUrl/terminated/simplify/gates/skippedSteps`；失败另含 `failedStep/error/resumeCommand`）：

| scriptResult.status | 主 agent 动作 |
|---|---|
| `awaiting-push` | ① **逐项披露 skippedSteps**（每项 step + reason——被跳过的门禁必须让用户知情后才谈 push）；② 汇报 prUrl / gates（coverage/metrics/premerge）/ terminated / simplify；③ 请求 push 授权。**3b 恒 `git push github HEAD:<branch> --force-with-lease`**（与 workflow 内 pr-submit.sh 同构：无条件 `--force-with-lease`，`force_push` 判定链在本路径不存在）；push 后验证远端 ref（`git rev-parse HEAD github/<branch>` 一致） |
| `failed` | 按 `failedStep` + `error`（内含恢复指引）+ `resumeCommand` 处置后 resume：gate 修复子循环 3 轮超限 → 人工修复、显式路径 commit 后续跑；coverage/metrics exit 2（工具错误）→ 按输出修复后 resume；pr-submit exit 2/3/5 → 按 error 指引（远端连通性 / `gh auth status` / 检查 runId 目录 title-body 产物）后 resume；cr-fix `stuck`/`max-rounds`/`needs-redesign` → 读 error 中 aggregated 路径（嵌套产物 `~/.review-fix-loop/<repo-slug>/<wf-id>/`，报告在 `batch-N/round-M/` 子目录）人工判定：**误报 → resume 带 `--skip-steps cr-fix`（接管，终态逐项披露）；真问题 → 修复 commit 后 resume** |

**断点恢复语义摘要**：恢复最小单位 = step（done/skipped 一律跳过；failed/in_progress 整体重跑）；resume 入口六道守卫依次执行——state 存在性与版本 / repo 一致 / 分支一致 / 活性双通道（引擎 state 主通道 + pid 降级，未知值视为 running）/ 工作区干净（`.review/` 除外）/ HEAD 外部变更需显式 `--allow-external-changes`；`--skip-steps` 命中的未完成 step 落 `skippedSteps` 披露；全 step done 且 HEAD 未变时幂等回放同一终态，HEAD 已变则 fail-fast 指引起新 run。cr-fix 重跑 = loop 整体重跑（fix commit 已进 git 历史，重跑面向当前 diff，已修复问题不再报出，通常 1-2 轮收敛）。

**门禁语义映射声明（相对路径 1/3 手工流程的四处收紧/承接，均非降级）**：

1. **修复范围收紧**：嵌套 review-fix-loop 修复全部等级（must-fix + suggestion）且 clean 判定要求 suggestion 同为 0——严于路径 3「SUGGESTION 顺手修、INFO 忽略」。
2. **real-pi 移出**（2026-09-15 e2e 执行准则，SSOT = AGENTS.md「测试」节）：3a 的 test:runtime 以 `TAIJI_SKIP_REAL_PI=1` 只跑 unit 轨（与 CI test-runtime job 同口径），real-pi 等价性用例不在 PR/merge 承接——移到开发阶段按改动面跑（tech-design e2e 影响面评估 + dev-flow 验收计划表圈定，机器对账入口 = `node scripts/select-affected-e2e.mjs --base <base>`，SSOT = `docs/testing/e2e-map.json`）。final-gates 不设 real-pi 凭证预检、不解析输出 skip 标记：skip 标记是 unit 轨的预期输出，不构成失败。
3. **stuck 收紧为 failed**：`stuck`/`max-rounds`/`needs-redesign` 一律 failed 人工接管。对照路径 1 Gate-2 原语义（`terminated ∈ {clean, converged, stuck}` 均可进阶段 3，`stuck` 的「误报可人工 ack」处置见失败恢复表 pi 行）——本路径该放行语义不存在：接管必须经 `--skip-steps` 逃生舱，且终态逐项披露保证知情。
4. **Gate-3 三分量承接**：`pr_exists` = pr-submit step done；`premerge.result == "PASS"` = final-gates step done；`local_ahead_of_origin == 0` 由 3b push 动作本身达成（push 后验证远端 ref）。

#### 路径 3：无 workflow 能力环境（手工编排，上限 2 轮）

**适用条件**：既无 pi workflow 也无 zflow（其他 agent 框架 / 插件不可用时的兜底）。

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

- 按文件归属分组，每组派 1 个 `worker` subagent 并行修复（≤5）。worker task 含：review 报告原文路径（worker 必须复读）+ 本组问题清单 + 「全部修复，不挑 level」+ 「修复后 `pnpm -r typecheck` 通过」；完成后 commit `fix: review round 1 — N must-fix`
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
- **任一 gate FAIL 仍走完 ③ 写 marker**（pr-status.sh 可见终态），Gate-3a 拦截不 push；按失败输出派 worker / 测试 subagent 修复后**从 ① 头部重跑**

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
| 软 gate | 阶段 2 `terminated` 非 `needs-redesign` + 阶段 3a PASS |

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
| zcode 有 zsw 却手工编排 review subagent 分批（应走 pr-lifecycle 单 workflow） | 复现 workflow 已有能力，聚合/轮次/熔断/断点恢复全靠手写，漂移风险 |
| zcode 下走完整 PR 生命周期时绕过 pr-lifecycle 直接裸调 review-fix-loop（pi 版或 zcode 版） | 丢失 PR 阶段门禁 / 断点恢复 / code-simplify 编排（1.2.0 vendored 内置已是 batch1 agent .md 路径驱动，与路径 1 同源——旧「焦点名」排除理由已失效，现排除理由是编排完整性）；仅 review+fix 循环（不进门禁、不开 PR）按宿主路由单跑对应版本是合法场景 |
| 阶段 2 派 subagent 封装 workflow | 多一层无增益中转 |
| zflow run 后轮询 status/list 等结果 | 违反插件纪律，通知自动回流 |
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
| Gate-2 `terminated=needs-redesign` | 结构性问题，上报用户决策（不自动重试） |
| Gate-2（pi）`terminated=stuck` | 看 aggregated.md 判断是 reviewer 误报还是真问题；误报可人工 ack 后进阶段 3，真问题上报用户（zcode 路径 2 的 stuck 一律 failed，处置见本表 pr-lifecycle 行——不适用本行 ack 语义） |
| Gate-2（pi）`terminated ∈ {review-failure, aggregator-failure}` | 环境问题：调参重跑一次；再败上报用户（处置与路径 2 同类问题一致） |
| Gate-2（zcode 路径 2）cr-fix 环境类失败（review-failure / aggregator-failure / fix-failure） | pr-lifecycle 已自动重试 1 次；failed 终态按 `resumeCommand` 处置（检查 pi 凭证 / 模型配额后 resume，cr-fix 整体重跑） |
| Gate-2（zcode 路径 2）cr-fix 终态 `stuck` / `max-rounds` / `needs-redesign` | failedStep=cr-fix：读 error 中 aggregated 路径人工判定——误报 resume 带 `--skip-steps cr-fix`，真问题修复 commit 后 resume（`fixed-unverified` 为旧 pr-review-fix 终态，已随其退役） |
| 3a coverage-gate exit 1 | 注入 `--test-result FAIL` 写 marker 后拦截：增量不足派测试 subagent 补测试、测试失败按失败用例派 worker；从 3a ① 重跑 |
| 3a pre-merge exit 2（coverage.json 缺失 / base 不一致） | 工具错误：重跑 3a ① coverage-gate 后再 ③ |
| Gate-3a pre-merge FAIL | 按 `failed_step` 重派 worker 修复后从 3a ① 重跑 |
| 阶段 3b push 冲突 | `git fetch && git rebase` 后重试；重写历史后重审未解决的 review 线程 |
| （zcode 路径 2）pr-lifecycle failed（任意 failedStep） | 一律先读 scriptResult 的 `error`（内含恢复指引）与 `resumeCommand`；暴毙无通知时 `cat .review/pr-workflow/latest` 拿 runId 续跑（详见路径 2 终态映射表） |

## 本 skill 目录结构

```
.agents/skills/pr-cr-fix/
├── SKILL.md              # 本文件
├── agents/               # 8 个 review agent 定义 review-<维度>.md + simplify-apply.md（pr-lifecycle simplify step 的 code-simplify 固化契约：覆盖声明 / 引用锚点 / 维护义务；不全局暴露）
├── references/           # 触发场景才 read：coverage-industry-research.md（覆盖率调研）/ cot-leakage.md（CoT Leakage）/ mutation-testing.md（Mutation 深检）
└── scripts/              # metrics-gate.py / coverage-gate.py（含 --extra-packages）/ validate-skill-yaml.py

├── workflows/            # 路径 2（zcode）workflow 脚本（自包含随 skill 分发；.js 绝对路径调用）
│   ├── pr-lifecycle.js   # PR 全生命周期单 workflow 入口（@pi-meta 块 + io 适配层）
│   ├── pr-lifecycle/
│   │   ├── lib.cjs       # 状态核心：state/守卫/walker/lockfile + 全部 12 step 实现（依赖注入 io，node 直测）
│   │   └── test/run-tests.js # lib 单测 runner（mock io 注入；node 直跑，exit 非 0 = 失败）
│   └── package.json      # 标记 CJS：仓库根 type:module 下保障上述 .js/.cjs 走 CommonJS（require 可用）
（旧 .agents/workflows/pr-review-fix.js 已删除——被 pr-lifecycle 取代，git 历史保留；改动 pr-lifecycle 后校验：node <zsw-cli> workflow --action lint --file <绝对路径>）
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据实际情况决定 |
