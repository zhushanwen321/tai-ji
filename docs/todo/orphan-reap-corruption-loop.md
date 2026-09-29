# TODO：无主 run 对账清理的持续损坏计数封顶待裁决

状态：待裁决（2026-09-29 登记；观测面缺口已补——commit 待落，剩计数封顶一项待裁）

## 背景

无主 run 对账清理（workflow-run-resume-revision 设计裁决点 7，`reapOrphanRuns`）用登记状态文件 `orphan-run-reap.json` 承载宽限窗：首判无主的 run 登记后经 7 天宽限窗（env 可调）才删除。评审 round-3 D-3-3 已定死登记文件自身的失效情形——原子写（writeAtomicJson）、损坏按空重登记（宽限窗重起、宁保留方向、禁回退 mtime 锚）、并发丢更新显式接受不设锁。

## 现状

- 一次性损坏会自愈：损坏轮按空表重登记（宽限窗只重起一次），同轮末尾 `writeAtomicJson` 原子重写登记文件；下轮读到正常锚点即可正常删除。
- 持续损坏（每轮读都坏或每轮写都失败，如磁盘坏道）才会宽限窗反复重起 = 孤儿 run 永不删除。该形态可观测：损坏读有 warn 留证（`readOrphanReapRegistry`——ENOENT 静默（首轮无登记的正常空态），其余读失败/损坏 JSON warn，消息含文件路径、空重登记语义与恢复指引）；损坏路径测试覆盖在 `orphan-reap.test.ts`（一次性损坏自愈 / 损坏 warn 出声 / ENOENT 静默）。commit 待落。
- 登记写失败另有 warn（`orphan reap: registry write failed`）。

## 待裁决点

- 是否需要「持续损坏计数封顶」机制：持续损坏计数超过阈值时不再无限制重起宽限窗（改为告警 / 强制删除 / 人工介入，具体形态待裁）。
- 反方向裁决同样成立：登记文件损坏是极低频形态（原子写已消除最常见的半截写成因），为它加计数与封顶可能属重复保险式过度工程——评审原文即以「是否属过度防御待裁」收尾，需裁决而非默认实现。

## 出处

- 评审记录：`.tmp/tech-design/workflow-run-resume-revision/round-3/dispositions.json` D-3-3 条 attackHints 第①点
- 设计文档：`.tmp/tech-design/workflow-run-resume-revision.md` §3.1 裁决点 7 实现落点段
