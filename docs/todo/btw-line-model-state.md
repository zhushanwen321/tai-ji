# btw 线模型/思考档显示态无权威数据通路（renderer 回执近似已落地）

状态：部分解决（2026-10-23：渲染层状态通路已由「会话运行时状态层」统一接管，权威拉取（`session.getState` 冷读）仍待 W2；2026-10-11 登记）

## 现状

- 旁路线（btw vid）是 hidden 会话（`BtwService` 注册 `hidden: true`，`SessionScanner.listAll` 过滤），不进 renderer sessionStore 列表。
  - 历史（W1 前）：`session.state_changed` / `session.thinkingLevelSet` 广播经
    `handleSessionStateChanged` → `sessionStore.applySnapshot(vid, …)` 对列表外 id 静默丢弃。
  - 现状（W1 后）：状态帧写会话状态层（按 id 寄存），列表成员资格不再是写入判据。
  - 仍无任何按 vid 拉取线模型态的 RPC（`session.getContext` 只覆盖用量）。
- 渲染层状态通路（2026-10-23「会话架构四层分离」W1 已落地）：状态按会话 id 寄存于
  `createSessionLiveState`（core）/ `useSessionLiveStateStore`（renderer 薄壳），
  `session.state_changed` / `session.thinkingLevelSet` 帧与切换回执同走 `applyLiveState`
  ——**不再有 btw 专用 store，也不再「回退主会话当前值」**（缺失即显式未知）。
  原 `btw-session-state` store / `resolveComposerSessionState` / `bindMainSid` 已整体删除
  （数据源登记表 #63 退役、#76 替代）。
- 仍然存在的缺口 = 下面两条（都属「权威拉取」通道，W2 范围）：推送帧只覆盖「本端发生过的
  变更」，进程重启 / 从未切换过的线没有本地缓存，显示显式未知直到下一次状态帧到达。

## 已知缺口（近似态覆盖不到的形态）

1. **pi 侧静默换模不回显**：pi pattern 引擎运行中把请求模型换成同族条目（事故 A 形态）无 renderer 回执，线显示滞留旧值直到用户再次切换。
2. **重启后冷线无缓存**：线切过模型 → 重启（renderer 状态层清空）→ 重开线，状态层无条目 → 显示**显式未知**（W1 语义：不回退猜测）。真实值以线会话文件 model_change entry 为准，需 W2 的 `session.getState` 冷读补上。

## 长期方向（裁决后实施）

权威通路二选一（拉为主、推补充，ADR-0097 口径）：

- **拉**：`session.getState { sessionId }`（活会话读 replicated states 快照 / 冷会话读会话文件最新 model_change entry，不 spawn 进程），renderer 在打开视图 / 缓存缺失 / 重连时拉取并喂会话状态层（`applyLiveState` 同一 reducer）；
- **推**：状态帧通路已在 W1 打通（同一 `applyLiveState` 入口）；剩余工作只是让推送覆盖不到的场景由拉取收敛。

涉及 shared 协议类型 + runtime + renderer 三层，宜走 tech-design 小设计包，不入 UI 打磨散修。
