# 增量覆盖率（diff/patch coverage）门禁调研报告

> 调研 agent 产出（2026-08-21），供 Gate-1.6 修复设计决策消费。调研方法：WebSearch/WebFetch
> 官方文档 + node_modules vitest@4.1.9 dist 实装源码核验。

## 1. vitest 4 原生能力

**结论：vitest 4.1 有原生 `coverage.changed`（文件粒度），4.1.9 实装可用；可以对 changed
文件应用 thresholds，但分母是「改动文件的全量可执行行」而非「diff 新增行」，因此不能等价
替代自研行号匹配。`changedWhen`/`changes` 选项在 4.1.x 不存在。**（置信度：高）

- `coverage.changed`（config）/ `--coverage.changed <commit/branch>`（CLI），类型
  `boolean | string`，默认 `false`（继承 `test.changed`）。官方文档原文："Collect coverage
  only for files changed since a specified commit or branch. When set to `true`, it uses
  staged and unstaged changes."；CLI 帮助原文："Collect coverage only for files changed since
  a specified commit or branch (e.g. `origin/main` or `HEAD~1`). Inherits value from
  `--changed` by default."（[coverage 配置文档](https://vitest.dev/config/coverage.html)、
  [CLI 文档](https://vitest.dev/guide/cli.html)，当前文档版本 v4.1.11）
- [vitest 4.1 发布博客](https://vitest.dev/blog/vitest-4-1.html)（2026-03-12）原文三句：
  "If you want to get code coverage only for the modified files, you can use
  coverage.changed to limit the file inclusion." / "--coverage.changed allows you to still
  run all test files, but limit the coverage reporting only to the changed files." /
  "This allows you to exclude unchanged files from coverage that --changed would otherwise
  include." —— 即它**不裁剪测试执行**（避免部分重跑导致阈值假算，参见历史 issue
  [#4347](https://github.com/vitest-dev/vitest/issues/4347)），只裁剪报告文件集。
- **thresholds 只作用于 changed 文件：可以**。实装证据（权威源 = node_modules 实装版，
  `node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js`）：`onTestRunStart` 经 VCS 取
  changedFiles → `isIncluded` 中 `if (included && this.changedFiles) included =
  this.changedFiles.includes(filename)` 过滤报告文件集 → `checkThresholds` 在过滤后的
  coverageMap 上计算。配合 `--coverage.thresholds.lines 50` 即得「改动文件行覆盖率 ≥50%
  才过」。
- **粒度差异（关键）**：thresholds 用的是整个文件覆盖率汇总
  （`summary.data[thresholdKey].pct`），vitest 没有任何行级 diff 匹配。动一个历史低覆盖
  文件的一行，vitest 门禁按整文件未达标而 fail（假阴性方向）；diff-cover 类工具只要求
  diff 内新增行被覆盖。
- 变更集语义（dist `GitVCSProvider`）：传 ref 时 = `git diff --name-only <ref>...HEAD`
  （merge-base）+ staged + unstaged（含 untracked）；`true` 时仅 staged+unstaged。
  `experimental.vcsProvider`（4.1.1+，默认 git）为自定义 VCS 入口
  （[experimental 文档](https://vitest.dev/config/experimental.html)）。
- **两个可靠性坑**（均出自实装代码）：① VCS 调用失败被
  `catch { this.changedFiles = void 0 }` 静默吞掉 → 回退为全项目阈值；② `changedWhen`、
  `changes` 在 4.1.9 help/dist/当前官方文档中均不存在（curl 直抓 v4.1.11 CLI 页 0 命中；
  changelog 无记录），如遇此名多为讹传。

## 2. 业界 diff coverage 工具

| 工具 | 分母定义 | 输入格式 | 本地可跑 |
|---|---|---|---|
| [diff-cover](https://github.com/Bachmann1234/diff_cover) | "Diff coverage is the percentage of new or modified lines that are covered by tests"——git diff 中新增/修改行 × 报告中可执行语句；原则"If you touch a line of code, that line should be covered" | Cobertura/Clover/JaCoCo XML 或 **LCOV**（JSON 仅作输出） | 是，纯 CLI（pip 安装），`--compare-branch=origin/main`（默认 origin/main）、`--fail-under=80` 非零退出 |
| [Codecov patch status](https://docs.codecov.com/docs/commit-status) | "only measures lines adjusted in the pull request or single commit"（PR diff 行） | 上传 lcov/xml/json 到托管服务 | 否，托管服务；codecov.yml `patch.target/threshold` 门禁 |
| [SonarQube 新代码覆盖率](https://docs.sonarsource.com/sonarqube-server/10.8/core-concepts/clean-as-you-code/about-new-code) | "New code is code that you've recently added or modified"；"In pull requests, all code changes are considered new code"（另有 previous version / days / specific analysis / reference branch 四种新代码定义） | sonar-scanner 上传 lcov/xml | 需自建 SonarQube Server（Community Build 可自托管但要跑服务端），非轻量本地门禁 |
| GH Actions 生态 | [Diff Cover Action](https://github.com/marketplace/actions/diff-cover-action)（包装 diff-cover、只查 changed lines、PR 评论）；[vitest-coverage-report](https://github.com/marketplace/actions/vitest-coverage-report)（PR 评论含 changes-only 模式）；GitHub 原生 [upload-code-coverage 公测](https://github.com/orgs/community/discussions/194833)（暂 Cobertura） | lcov/xml | action 层面是 CI 内本地计算（diff-cover、vitest-coverage-report 均不上传第三方） |

（置信度：高，除 GitHub 原生公测细节为中等）

## 3. monorepo 惯例

主流三层分工：**执行按包跑（受影响包过滤）+ 报告聚合到根 + 门禁二选一**。（置信度：中高，
属生态共识而非单一规范）

- 执行/报告层：[Turborepo 官方 vitest 指南](https://turborepo.dev/docs/guides/tools/vitest)
  推荐根入口 + vitest projects 天然产出 merged coverage；合并方案社区讨论见
  [vitest #3744](https://github.com/vitest-dev/vitest/discussions/3744)、
  [#256](https://github.com/vitest-dev/vitest/issues/256)。
- 门禁层：按包/按团队门禁派（[Datadog monorepo 覆盖率门禁按 service/code owner
  评估](https://docs.datadoghq.com/code_coverage/monorepo_support/)，避免高覆盖包掩盖
  低覆盖包）vs 单项目聚合派（[SonarCloud 社区权衡讨论]
  (https://community.sonarsource.com/t/monorepo-code-coverage-setup-in-sonarcloud/109132)）。
- 对 diff coverage 特有惯例：分母是「PR diff 行」，业界（Codecov patch status、
  diff-cover）按 **PR 级单一数字**门禁，不按包拆——工具天然支持多报告文件合并计算。

## 4. 阈值惯例

- **新代码/patch 覆盖率事实标准是 80%**：[Sonar Way 默认质量门禁 "coverage on new code
  ≥ 80%"](https://docs.sonarsource.com/sonarqube-server/9.8/user-guide/quality-gates)；
  [Codecov 实践文章](https://about.codecov.io/blog/the-5-levels-of-code-coverage-how-to-build-a-testing-culture-in-your-organization/)
  建议新代码 ≥80%；[Sonar 博文](https://www.sonarsource.com/blog/is-80-of-code-coverage-any-good/)
  讨论 80% 惯例的局限。
- 总覆盖率参考：Google Testing Blog 指引 60% acceptable / 75% commendable / 90%
  exemplary（[原文](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)
  抓取受限，数字由[二手引述](https://www.drizz.dev/post/code-coverage-vs-test-coverage)
  佐证，置信度中）。
- 50% 属宽松起步值，业界正式门禁少见；常见做法是 ratchet 逐步升到 80%。

## 5. 调研方推荐与最终采纳

**调研方推荐 (c)**：保留「按改动包 `vitest run --coverage --coverage.reporter=lcov`」生成层，
把自研 lcov+git diff 解析门禁整体替换为 diff-cover：`diff-cover packages/*/coverage/lcov.info
--compare-branch=<base> --fail-under=50`。理由：语义与自研一致，把出过假 pass 的解析链路换成
成熟工具；本地与 CI 同命令。

**主 agent 采纳决策（2026-08-21，与调研方不同）**：**保留加固后的自研引擎，diff-cover 记为
文档化备选**。理由：

1. 假 pass 根因已实锤为 OK 路径漏记 `report[pkg] = entry` 一行遗漏（非解析层缺陷），已修
   并加记账闭合守卫（不闭合即 exit 2）；解析层薄弱点（basename 兜底）同批改为精确路径匹配。
   调研方推荐时未知此根因（调研与根因排查并行）。
2. 自研引擎产出 diff-cover 不提供的战略产物：`files` 节（全文件级真实覆盖率，1071 文件）
   供 metrics-gate 替换 fallow 静态估算消费——换 diff-cover 则此链路需另写解析，等于保留
   两套解析。
3. diff-cover 引入 pip 环境依赖（skill 自包含性受损），且其自身也有调研方列出的迁移验证点
   （SF 路径形态匹配 / 零分母行为），替换的迁移成本不低于继续持有已验收的加固引擎。
4. vitest 原生 `coverage.changed` 确认不宜作主门禁（分母语义不同 + VCS 失败静默回退全项目
   阈值 = 假 pass 形态），与调研方结论一致。

**阈值决策**：业界事实标准 80%（Sonar Way 默认），50% 为宽松起步。本仓实测 PR #185
全量 17 包增量覆盖率 68%~100%（14/17 ≥90%）。**2026-08-21 用户决策：ratchet 至 80%**
（`MIN_INCREMENTAL_DEFAULT = 80.0`）；当轮把 model-switch 68% / ui 76.9% 两处缺口用
行为测试补到 ≥80%。
