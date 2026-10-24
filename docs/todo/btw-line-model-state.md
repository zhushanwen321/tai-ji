# btw 线模型/思考档显示态（已关闭：权威拉取 + 状态层统一接管）

状态：已解决（2026-10-24 定案：渲染层状态通路由「会话运行时状态层」统一接管〔W1〕，权威拉取 `session.getState` 冷读落地〔W2〕；登记于 2026-10-11）

## 现状（终态）

- btw 线是 `surface: 'btw'` 会话：`BtwService` 注册 `surface: 'btw'`，`SessionScanner.listAll`
  以 `surface === 'sidebar'` 正向谓词过滤（W5 起 `hidden` 字段已完整退场，读取点登记于
  docs/constraints.json C-data-28），线不进 renderer sessionStore 侧栏列表。
- 线的模型/思考档显示走与其他会话同一条状态通路：状态按会话 id 寄存于
  `createSessionLiveState`（core）/ `useSessionLiveStateStore`（renderer 薄壳），
  `session.state_changed` / `session.thinkingLevelSet` 帧与切换回执同走 `applyLiveState`
  ——btw 专用 store 与「回退主会话当前值」的兜底均已删除（缺失即显式未知）。
- 冷线（进程重启 / 从未切换过）的显示值由 `session.getState { sessionId }` 冷读补上：
  活会话读 replicated states 快照，冷会话读线自己的会话文件（`extractLatestModelFromJsonl`，
  activePath 裁剪），全程不 spawn 进程。renderer 在打开视图 / 缓存缺失 / 重连时拉取并喂
  同一 `applyLiveState` reducer——「live ≡ reload」对线成立。

## 关闭理由

原登记的两个缺口均已消除：

1. ~~pi 侧静默换模不回显~~——状态判定锚定事实源（拉取/回执），无本地缓存的线经冷读读到
   会话文件真值；pi 静默换模的下一次拉取即收敛（不回退猜测）。
2. ~~重启后冷线无缓存~~——`session.getState` 冷读即为此形态的权威路径。

原「权威通路二选一」的裁决 = 两条都走且同源：拉为真值通道（ADR-0097），推为性能提示，
两条通路共用同一 reducer，无第二套状态容器。
