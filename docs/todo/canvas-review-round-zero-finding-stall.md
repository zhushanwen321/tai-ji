# 画布审查循环零发现轮永不完成（轮次推进与 max-rounds 停回保护失灵）

状态：已解决（2026-10-23：`ReviewReport` 增 `lastRunRound` 事实字段，随 review-append 主事件落盘（直写 ≡ 重放）；`roundHasReport` 据此对零发现轮成立；扩展侧 `runReviewRound` 零发现（空 entries / 全 dropped）也写回。测试锁定：runtime `canvas-review-loop.test.ts` 零发现轮三用例 + extension `review.test.ts` 全 dropped 用例）

## 现状

四点链条（dev-merge branch-review 聚合裁决员亲读核实）：

1. `REVIEWER_REPORT_SCHEMA` 的 entries 明示空数组合法（`extensions/taiji/canvas/src/review.ts:81` "Empty array when a dimension has no findings"）；
2. `runReviewRound` 零条目跳过写回（`review.ts:220-223` `if (entries.length > 0)`）；
3. `roundHasReport` 按「当前轮存在条目」判完成（`packages/runtime/src/services/canvas/canvas-review-actions.ts:24-26`）；
4. `applyReviewRequest` 的 max-rounds 终态分支（`:53`）与轮次推进分支（`:65-69`）均以 `roundHasReport` 为前置。

reviewer 每轮零发现（全过空 entries）或条目全被 `collectValidEntries` 判畸形丢弃时：轮次永不推进、maxRounds 预算永不消耗、max-rounds 停回保护对该形态失灵——agent 侧发起无轮次熔断，每轮烧一次 reviewer 派发。

## 修复指引

零发现也是审查结论：给 ReviewReport 聚合（`packages/extension-protocol/src/extensions/canvas/state.ts:157`）补「本轮 run 已完成写回」的事实字段（如 `lastRunRound`，随 review-append 事件落盘保持直写 ≡ 重放等价；不要用占位假条目——会污染 entries 全部消费方），`roundHasReport` 据此对零发现轮成立，恢复轮次推进与 max-rounds 终态判定。补测试锁定：reviewer 零发现（空 entries / 全 dropped）后再发起应推进轮次、达 maxRounds 触发 max-rounds 终态。
