# btw 线模型/思考档显示态无权威数据通路（renderer 回执近似已落地）

状态：未解决（渲染层近似态已合入，权威通路待裁决排期；2026-10-11 登记）

## 现状

- 旁路线（btw vid）是 hidden 会话（`BtwService` 注册 `hidden: true`，`SessionScanner.listAll` 过滤），不进 renderer sessionStore 列表。因此：
  - `session.state_changed` / `session.thinkingLevelSet` 广播（含 modelId）经 `handleSessionStateChanged` → `sessionStore.applySnapshot(vid, …)` 对列表外 id **静默丢弃**；
  - 无任何按 vid 拉取线模型态的 RPC（`session.getContext` 只覆盖用量）。
- 已落地的渲染层近似（`packages/renderer/src/stores/btw-session-state.ts`）：
  - store 只持「线自身切换回执」真值（useModel switchModel / setThinkingLevel 回执生效值，按 id 类别分流写入）；
  - 显示解析 = 线回执 → 主会话态回退（维度级合并）。回退依据 = fork 继承事实：线 spawn 用 `model: undefined + inheritSessionModel: true`（btw-line-spawn-options.ts），未切换过的维度真值 ≡ 主会话创建线当时值；
  - vid → mainSid 绑定由 BtwPanel loadThreads / createThread 写入。
  - 显示态 store 已按 C-data-02 登记 `docs/architecture/data-source-registry.md` 主表 #63（2026-10-12 dev-merge branch-review 补登）——本条 todo 承载的权威通路缺口状态不变。

## 已知缺口（近似态覆盖不到的形态）

1. **pi 侧静默换模不回显**：pi pattern 引擎运行中把请求模型换成同族条目（事故 A 形态）无 renderer 回执，线显示滞留旧值直到用户再次切换。
2. **重启后冷线分歧不回显**：线切过模型 → 重启（renderer store 清空）→ 重开线，显示回退主会话当前值；若线此前的切换与主会话当前值不同，显示错误（线实际生效值以线会话文件 model_change entry 为准）。

## 长期方向（裁决后实施）

权威通路二选一（拉为主、推补充，ADR-0097 口径）：

- **拉**：`btw.list` 线条目增加 modelId/thinkingLevel（runtime 侧读线 JSONL 最新 model_change entry，与主会话列表 scanSessionMeta 同源；活线可读 replicated states 快照），renderer 拉取时喂 btw-session-state store；
- **推**：线进程的 snapshot 挂钩发布的 `session.state_changed` 打通 renderer 摄入（当前被 applySnapshot 丢弃点改道或 btw 域旁路订阅）。

涉及 shared 协议类型 + runtime + renderer 三层，宜走 tech-design 小设计包，不入 UI 打磨散修。
