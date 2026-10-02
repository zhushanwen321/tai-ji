# 同族 workflow 内容配套类 commit 拦截缺口（review-fix-loop / pr-lifecycle / dev-consistency-loop）

状态：待后续候选（2026-10-02 登记，源自 dev-merge-gates 自愈改造设计决策 6）。dev-merge-gates 已在同日改造中打通 commit 拦截三分类自愈（env 类就地恢复 / content 类补修 fixer 补全后重试 / blocked 类组转待办，实装见 `.agents/workflows/dev-merge-gates.dwf.ts` 头部声明）。同族未同步面按形态分两档：**review-fix-loop 与 pr-lifecycle** 的 cr-fix 循环在 commit 撞「内容配套」类 pre-commit 拦截（如 e2e-map 防漏登记门禁要求补登记文件，恢复动作需要修改仓库内文件）时，环境恢复重试仍败即以 fix-failure 终止 run、人工处置后重发起（行级实据：`~/.zcode/workflows/review-fix-loop.dwf.ts:1094`、`.agents/workflows/pr-lifecycle.js:1356`）；**dev-consistency-loop** 为组级失败隔离（组 commit 失败仅记 WARN、改动留工作区随复审重修，run 不终止），本条登记对它不构成 run 级缺口，详见下方垫底节。

**重审触发条件**：同族任一 workflow 再发 content 类 commit 拦截终止 run 的事故 → 升级必修。

## 现状与垫底（为何低风险、未同批改）

- review-fix-loop：轮级容忍（改动留工作区下轮捡回）+ 重跑廉价（已修复问题不再报出，通常 1-2 轮收敛）——content 类拦截罕见且重跑代价低。
- pr-lifecycle：终态清扫（sweepResidualChanges）垫底——残留不丢，但 content 类拦截本身仍终止 cr-fix 循环。
- dev-consistency-loop：组级失败隔离 + 修复/复审 prompt 显式注入「留工作区」上下文——组 agent 自行 commit 有写权限、仍在会话中，content 类可自行补登记重试，现状天然可自愈，三处中缺口最小。

## 候选方案（届时评估）

照搬 dev-merge-gates 形态：提交 agent 结构化契约加 errorKind（none/env/content/blocked）+ errorDetail 报错原文、content 类后置补修循环（补修 fixer 按报错原文补全 + 相交归属并入组清单重试 + 每组每轮 ≤2 次）、blocked 类转待办。当初不同步改三处的理由 = 一次改动过大、回归测试范围失控（设计决策 6）；逐个改造可收窄单次范围。
