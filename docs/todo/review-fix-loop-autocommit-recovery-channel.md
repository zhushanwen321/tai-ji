# review-fix-loop autoCommit 统一 commit 失败的错误通道分流漂移（MF-1-1b）

状态：开放（存量失败，与 2026-10-23 D1 反向依赖收编批无关）。

## 现象

`extensions/universal/subagent-workflow/src/__tests__/review-fix-loop-e2e.test.ts` 的用例 MF-1-1b（「统一 commit 的 git add 失败（index.lock 争用）→ fix-failure 结构化终止 + state.json 落盘」）确定性红：用例注入 index.lock 使 `git add` 失败（exit 128），断言错误信息含「统一 commit 环境恢复重试后仍失败」（环境恢复 agent 重试通道的终态文案）；实际输出走「补修 agent 结构化返回非法」通道终止（mock 补修 agent 响应未通过 structured-output 门禁），UNRESOLVED 文案由两段拼接，不含预期子串。

## 基线证据

分支基线 c2e8183c5（D1 批动工前）以基线 `packages/subagent-core/src` 对照跑同用例同红（2026-10-23 实测，对照验证 differential testing）——非 D1 批引入；main 侧状态未核。同套件其余 30 用例全绿（含 MF-1-1a autoCommit 正常 commit 形态）。

## 影响

该用例是「统一 commit 失败后先经环境恢复 agent 重试、重试仍失败才结构化终止」语义的唯一执法点；实现与用例必有一方漂移（实现的失败分流先走了补修 agent，或用例文案过期）。当前该语义无有效执法。

## 处置建议

归因 review-fix-loop 实现的统一 commit 失败分流逻辑（环境恢复通道 vs 补修通道的触发顺序）与用例预期，修复漂移方后恢复该执法点；修复涉及 subagent-workflow 提交链路时同批复核同套件 autoCommit 两形态用例。

## 关联

- 触发档案：E2E-INTEG-46（`TAIJI_TEST_INTEGRATION=1` 真链层，docs/testing/e2e-map.json）
- 领域：review-fix-loop（2026-10-23 起双平台单源管线，机制源在 `packages/subagent-core/workflows/src/`，改机制经该处重建产物）
