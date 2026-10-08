/* zcode-workflow
description: dev-merge 的前置两步 workflow（gates + branch-review）。①gates——存在性检查：
  scripts/quality-gates.mjs / scripts/changeset-check.mjs 缺失（feature 分支未含 U1 commit，
  脚本随 git 分支传播而 skill 实体经 symlink 即时生效的介质错速）→ 显式披露跳过、不崩溃、
  继续后续步骤；在盘则跑 quality-gates.mjs --side dev-merge（分支增量口径）FAIL 派 fixer
  修复重跑 ≤3 轮；pi extension 启动冒烟（skill 实体脚本 pi-extension-smoke.mjs，全
  extension 源码入口经 pi 真实加载，零 LLM 调用）FAIL 同款修复子循环 ≤3 轮、宿主无 pi 时
  skip 披露不阻塞；changeset-check.mjs WARN 走同款「检查 → 起草 agent 修复 → 重跑检查」
  循环 ≤3 轮（起草漏包由下轮以剩余 missing 补上一轮；已判定跳过的非发布包视同处置完成，
  因 changeset-check 只认声明不懂跳过语义）。②branch-review——恒派 3 维 business-logic
  （含降级策略红线）/ arch-boundary / data-governance + 触发 3 维 electron-build /
  monorepo-impact / extension-api（diff 路径判定），触及非测试源码才跑，must-fix 全修循环
  收敛（fixer 申述 finding 不成立 = disputed，由下一轮 reviewer 对账亲自读码核实：维持→
  回 open 修复、反证成立→撤销关闭 no-fix，同一问题至多两轮核实——两轮均维持或轮次耗尽
  未核实才随 needs-human 终态升人工）；reviewer/聚合/fixer 强结构化返回，校验失败由同一
  agent 回注失败原因重试一次、仍败
  才 review-failure / aggregator-failure / fix-failure 终态（对齐 dev-merge SKILL 1.7
  CR 门 fail-fast 语义——无降级完成形态不变）；修复提交由提交 agent（dmg-committer）串行
  统一执行，撞提交前自动检查（pre-commit）拦截按三分类处置：env 类（报错写明环境恢复命令）
  committer 自行执行后重试；content 类（恢复需改仓库内文件且报错写明动作）后置补修循环——
  派补修 fixer（dmg-commit-fix）按报错原文补全、文件并入组提交清单重试（每组每轮 ≤2 次，
  超限转 blocked）；blocked 类组转提交待办（deferredCommits）不终止 run（红线不变：不改
  文件内容、不跳过检查、不提交清单外文件）。fixer 未申报残留 WARN 留工作区（reviewer 审查
  范围两路覆盖可见后处置）；收敛出口终态清扫（排除待办组文件 + 归属对账两条过滤）后随
  sweptFiles 披露；deferredCommits 非空时收敛终态改判 needs-human；问题清单每轮落盘
  {runDir}/ledger.json。merge/cleanup 机械步骤不进本 workflow
  （走 dev-merge.sh）；传播检查与兄弟线交集呈报在 dev-merge SKILL 第 1.8 步编排。pi 宿主无
  本 workflow——按 dev-merge SKILL.md 手工编排（node 跑 gates 脚本 + changeset WARN 起草 +
  branch-review 走 review-fix-loop）。
whenToUse: zcode 主 agent 执行 dev-merge skill 第 1.6/1.7 步时发起（CreateWorkflow path
  指向本文件 + args）。发起前 cwd 必须已在待合并 feat worktree 根（对齐 dev-merge SKILL
  调用约束——gates 脚本存在性、审查 diff 口径、fixer commit 全部以该检出为对象）。
args:
  base:
    type: string
    description: 分支增量基线 ref 名。缺省取 git merge-base github/main HEAD（fallback main，
      与 quality-gates.mjs --side dev-merge 的自解析口径一致）；显式传值时同步用于
      branch-review 的 diff，保证门禁与审查同口径
  maxRounds:
    type: number
    description: branch-review review→fix 循环轮次上限
    default: 10
*/
@@STITCH@@
