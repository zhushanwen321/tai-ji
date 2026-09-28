# TODO：无主 run 对账清理的登记文件损坏循环风险待裁决

状态：待裁决（2026-09-29 登记；评审遗留 attackHint，提出后未处置）

## 背景

无主 run 对账清理（workflow-run-resume-revision 设计裁决点 7，`reapOrphanRuns`）用登记状态文件承载宽限窗：首判无主的 run 登记后经 7 天宽限窗（env 可调）才删除。评审 round-3 D-3-3 已定死登记文件自身的失效情形——原子写（writeAtomicFile）、损坏按空重登记（宽限窗重起、宁保留方向、禁回退 mtime 锚）、并发丢更新显式接受不设锁。

## 现状

D-3-3 的处置留下一个未闭环的边角（该条 attackHints 第①点，后续轮次未处置）：登记文件损坏后按空重登记，同轮引用集重算会把全部孤儿重新登记，同轮末尾原子写回（`run-state-evidence.ts` `writeAtomicJson`）——一次性损坏只重起一窗，下轮读到正常锚点即可正常删除；**持续损坏**（每轮读都坏或每轮写都失败，如磁盘坏道）才会宽限窗反复重起 = 孤儿 run 永不删除。且损坏读本身静默（`readOrphanReapRegistry` 内部 catch 无日志，仅写失败有 warn），损坏路径无测试覆盖（`orphan-reap.test.ts` 无损坏场景用例），当前无任何观测面能看到这个循环在发生。

## 待裁决点

- 是否需要「损坏事件日志 + 连续损坏计数封顶」机制：损坏读补 warn 日志（当前静默）；持续损坏计数超过阈值时不再无限制重起宽限窗（改为告警 / 强制删除 / 人工介入，具体形态待裁）。
- 是否补损坏路径测试用例（当前零覆盖，一次性损坏自愈行为无回归防线）。
- 反方向裁决同样成立：登记文件损坏是极低频形态（原子写已消除最常见的半截写成因），为它加计数与封顶可能属重复保险式过度工程——评审原文即以「是否属过度防御待裁」收尾，需裁决而非默认实现。

## 出处

- 评审记录：`.tmp/tech-design/workflow-run-resume-revision/round-3/dispositions.json` D-3-3 条 attackHints 第①点
- 设计文档：`.tmp/tech-design/workflow-run-resume-revision.md` §3.1 裁决点 7 实现落点段
