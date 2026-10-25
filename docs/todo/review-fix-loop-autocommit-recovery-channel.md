# review-fix-loop autoCommit 统一 commit 失败的错误通道分流漂移（MF-1-1b）

状态：已修复（2026-10-25，用例漂移方向）。归因结论：实现无漂移——pi 产物（e2e 实际加载 `subagent-core/workflows/review-fix-loop.js`）的统一 commit 失败分流完好：`git add`/`commit` 失败 → 环境恢复 agent → 重试仍败 → 补修子循环（contentRepairLoop）→ 仍败才 fix-failure 结构化终止。用例三处过期：① 终态文案「统一 commit 环境恢复重试后仍失败」是 2ef5cad7e（2026-10-01）引入的直接终态文案，2e6876e75（2026-10-23）引入补修子循环后已被 buildRepairFailureMessage 文案替代，用例断言未随迁；② reason 预期 `completed` 未随引擎 run 终局吸收失败成员（subagent-observability §3.3.8）演进为 `partially_succeeded`；③ mock 未给补修 agent 配剧本（补修调用按 schema 被分类为 review，返回 R1 剧本）→ 终止原因落在 invalid-return 分支而非恢复链走完。修复：用例断言迁至现语义（补修链终态文案全集 + env-fix 派发锁定 + 补修恰 1 次 + index.lock 报错原文进终态），mock 基建扩 repair 剧本类（classifyCall 按 commitRepairSchema 识别）。

## 现象（修复前）

`extensions/universal/subagent-workflow/src/__tests__/review-fix-loop-e2e.test.ts` 的用例 MF-1-1b（「统一 commit 的 git add 失败（index.lock 争用）→ fix-failure 结构化终止 + state.json 落盘」）确定性红：用例注入 index.lock 使 `git add` 失败（exit 128），断言错误信息含「统一 commit 环境恢复重试后仍失败」（环境恢复 agent 重试通道的终态文案）；实际输出走「补修 agent 结构化返回非法」通道终止（mock 补修 agent 响应未通过 structured-output 门禁），UNRESOLVED 文案由两段拼接，不含预期子串。

## 基线证据

分支基线 c2e8183c5（D1 批动工前）以基线 `packages/subagent-core/src` 对照跑同用例同红（2026-10-23 实测，对照验证 differential testing）——非 D1 批引入；main 侧状态未核。同套件其余 30 用例全绿（含 MF-1-1a autoCommit 正常 commit 形态）。

## 关联

- 触发档案：E2E-INTEG-46（`TAIJI_TEST_INTEGRATION=1` 真链层，docs/testing/e2e-map.json）
- 领域：review-fix-loop（2026-10-23 起双平台单源管线，机制源在 `packages/subagent-core/workflows/src/`，改机制经该处重建产物）
