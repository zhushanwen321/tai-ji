# D5 真机嵌套验收（父→子→孙真实派发）

状态：待执行（验证活动，非代码待办——身份传递链已双向单测锁定，真机验证需真实模型额度窗口）。来源：subagent 体系 2026-09-30 终态演进纲领 D5 + 身份 env 接线的收尾验证项。

## 验收内容

父 → 子 → 孙真实派发一次，核对：

- `/subagents` 树的嵌套层级展示；
- `subagent-identity` 条目（含身份四元组与 D4 已上协议的 identity 信封字段 slug / startedAt / mode）；
- core 三读者（壳侧 fold、runtime 派生视图、session-reader 锚链）对嵌套 run 的读取一致性。

## 执行步骤

1. 确认本机可用模型与 CLI 形态；
2. 空载串行跑（真实 LLM 用例执行纪律见 AGENTS.md e2e 准则；本地 pi CLI 实测命令形态见 AGENTS.md「extension 改动优先在本地 pi CLI 实测」）；
3. 结果登记（含失败形态）。

## 关联

- 身份机制权威文档：[docs/architecture/subagent-identity-and-recursive-visibility.md](../architecture/subagent-identity-and-recursive-visibility.md)。
- 引擎义务：[docs/extensions/subagents/engine-development-guide.md](../extensions/subagents/engine-development-guide.md) §9「子代理身份 env」。
- 终态演进纲领（含 D5 行）：原 subagent-workflow-issues.md §2.0，已随该导航页删除收编，git 可追溯。
