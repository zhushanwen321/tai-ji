# dev-merge 测试/审查圈定的跨包下游缺口

状态：待流程复盘（2026-10-06 登记，源自 v0.10.14 发布轮 PR #32 合并后的遗留盘点）。dev-merge 现行圈定机制按「分支 diff 直接改动路径」匹配——quality-gates 的增量 coverage、branch-review 的维度触发规则（`TRIGGER_RULES` 路径谓词）、e2e-map 的 scope 匹配（`select-affected-e2e.mjs`）均不推导「上游改动波及的下游包受影响面」。

## 现象（PR #32 / pi 1.0.0 适配线合并轮实抓 4 批）

上游包改动后，下游包的测试与检查需同步跟进，但未被任何圈定环节选中，均在合并后补抓：

1. mobile-renderer 词表测试——上游词表（`packages/subagent-core/src/shared/run-vocabulary.ts`）改动后，mobile-renderer 侧消费词表的测试需同步更新。
2. ui 桥接词表——packages/ui 桥接层的词表测试同上。
3. markdown-sanitize 净化测试——白名单/净化契约测试（`packages/ui/src/features/chat/__tests__/markdown-sanitize.test.ts`）未随上游渲染链改动自动入选。
4. SHUTDOWN_STEP_SEQUENCE——runtime 关机步骤序列（`packages/runtime/src/services/session/rolling-restart.ts` 导出）的序列断言测试（`__tests__/rolling-restart.test.ts`、`terminal-lifecycle-cascade.test.ts`）未随上游生命周期改动入选。

## 问题

跨包下游受影响面（改了上游导出 → 下游消费方测试失效）目前只靠人工经验兜住。漏网的代价随跨包依赖增长而上升：gates 全绿但下游红灯在合并后才暴露，违反「质量门前置到分支边界」的步骤定位。

## 复盘方向（候选，届时评估）

- 机器对账形态：仿 `select-affected-e2e.mjs` 的 rule 登记制——为「上游导出 → 下游必跑测试」登记映射（如词表 → 全部消费包词表测试；生命周期序列常量 → 对应序列断言测试），pre-merge 按改动路径推导必跑集。
- 依赖图推导形态：从 workspace 依赖图 + 导出符号引用推导下游测试集，覆盖面全但维护与误报成本高。
- 两者可叠加：高频已知对（词表/序列常量/净化契约）走登记制，长尾走依赖图。

## 重审触发条件

下次合并轮再出现「合并后才发现下游包测试需跟进」即升级必修；复盘入口 = dev-merge SKILL 第 1.6 步圈定机制评审。
