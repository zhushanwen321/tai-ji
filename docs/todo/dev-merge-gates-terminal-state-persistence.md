# dev-merge-gates 终态 JSON 落盘 runDir（改进候选）

状态：待后续候选（2026-10-02 登记，源自 dev-merge-gates 自愈改造 D3 验收 inspect-a3 判定建议）

## 现状

dev-merge-gates workflow 的终态对象（status / terminated / disclosures / deferredCommits / sweptFiles / remaining / error / recovery 等字段）只存在于两个载体：zcode 引擎会话库（`dwf_run.result_json`，需会话内 GetWorkflowRun 读取）与完成通知（主 agent 会话内快照）。run 产物目录（`.tmp/dev-merge-review/<topic>/`）只有 ledger.json 与 round-N 审查产物，无终态对象落盘。

## 问题

验收判定、事后审计、跨会话追查三类消费者要读终态对象时，都依赖「发起 run 的那个会话还活着且记得转述」——inspect 判定 agent 只能拿主 agent 的转述做交叉核对，独立复核缺一块原始证据（inspect-a3 判定中已实际发生：判定员因 GetWorkflowRun 不可用而无法独立读取终态原文）。

## 改进候选

workflow 终态出口（terminal 汇聚点）把终态对象 JSON 原文写入 runDir（如 `<runDir>/terminal.json`），与 ledger.json 同层。实现成本低（一处 `world.run` 写文件或既有落盘通道复用），收益是终态审计的原始证据自包含。

## 重审触发条件

下次需要对 dev-merge-gates（或同族 review-fix-loop）做 inspect 判定、且判定员无法读到终态原文时，升级为必修。
