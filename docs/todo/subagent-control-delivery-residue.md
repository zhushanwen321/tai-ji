# subagent control 通道交付残留（relay-spawn-transport 收尾登记）

状态：已交付（4 项残留/承接窗口登记，2026-10-18 收尾；逐项待排期）

## 1 degraded 提示仅拉取可见（DC-8）

- **现状**：runtime `markDegraded()` 只改 tee/查询态，不发布推送帧；`degraded` 只在 `session.getSubagentStreamState` 拉取响应中返回。`useSubagentTabData` 仅在订阅建立与 chunk 失步时拉取。
- **后果**：drawer 已打开、之后无 chunk 时，用户看到 live 流停止但无提示条，直到重开/刷新。
- **候选修法**：runtime 在 markDegraded 时发布 `session.subagentStreamDegraded {sessionId, recordId}`，renderer 经 event-bus 应用到同一 per-(virtualId,recordId) 位（单一事实源不变）。
- **权威登记**：impl-plan §5 DC-8（`.tmp/tech-design/relay-spawn-transport.impl-plan.md`，git 外）。

## 2 非缺省引擎首轮 probe→run 双 spawn（DC-12）

- **现状**：共享 control 客户端按 `(socketPath, rootSessionId)` 复用；探针以 spawn 期 temp 根建立连接，run 以真根建立第二条连接。rebind 不先发 dispose，runtime 侧 3s close grace 会走满。
- **后果**：非缺省引擎（zcode 等）新会话首轮启动延迟增加（双连接 + 一次 grace 等待），无功能错误。
- **候选修法**：把权威 rootSessionId 注入 probe/read/setModel（R2A-N1 选项 a），或 root 变化时 dispose 整条共享连接（选项 c）。
- **权威登记**：impl-plan §5 DC-12。

## 3 真机/混合版本验收窗口（A5 / A11 / A13）

- **A5/A13**：真实 app + 真实模型场景（S1 真机场次、S3 小 prompt、S4 并发 5 实例、S6 主对话半场、S8 真实 pi ack、S10/S13/S15）需有人窗口随 E2E-BATCH 族承接。代码面已有：A1 剧本归档（M1 行为）、A4 真实引擎×假 pi 全链、pi-cli/runtime/core 单测。
- **A11**：新旧版本混合矩阵（旧 runtime × 新 extension 等）未机器化；协议级版本拒绝有单测（hello_reject reason=version → engine_protocol_mismatch）。承接窗口见 DC-14。
- **A6**：Windows 真机未跑；Windows 分支（taskkill /T、child pid 集合、start time 不可得保守跳过）由 mock 用例覆盖。

## 4 已知遗留命名（非缺陷）

- `record.engineHandle.relayChildren` 字段与 crash-forensics 中标注为「当前不生效」的存量描述保留（引擎池抽象退役遗留），未在 relay-spawn-transport 范围内清理。
