# 未激活会话事件投影（SessionEventProjection）缓存：首读建立后磁盘事实变化在激活前不可见

状态：已修复（查询通道 mtime 对账失效已落地于 `session-records.ts` ensureProjection 缓存命中分支 + 两向单测；修复 commit：<待主 agent 提交后回填>）。登记来源：2026-10-24 a3 验收 §3.3.4 清点场景实测发现，D5 design-code-sync 审查定案。

## 现象

会话**未激活**（pi 未 spawn、extension 未运行）时对 `session.getSubagents` 的首读建立事件投影缓存后，磁盘事实的后续变化（如 manifest `completedAt` 补写）在该会话激活前对所有后续读不可见（持续返回陈旧在途态）；激活（session.switch）后自愈——journal 推送与 entry 游标增量通道接管失效。

## 触发来源

启动清点写窗不在触发来源内：`startupSweep` 在 runtime 主链被 await、先于 WS `server.start()`，实例可接受读请求时清点必已落定，新实例不存在「首读早于清点补写」的读窗。真实触发来源 = 未激活期间绕过运行时事实喂入通道（journal 推送 / entry 游标增量）的磁盘写入：

- 旧实例跨写：同一数据目录的前代 runtime 实例（或其 pi 进程）在事件投影建立后继续补写会话文件；
- pi 侧重建路径写入：pi 进程对会话文件的重建 / 补写不经 runtime 事件投影喂入通道；
- 启动清点被跳过形态：startupSweep 未覆盖或部分失败的 record 残留，后续由其他写方补写。

## 机制与修复（终态）

`SessionEventProjection` 双源喂入在未激活期间双双缺席，`ensureProjection` 缓存命中早退无失效判定。修复 = 查询通道（`getSubagents` / `getWorkflows` / `resolveWorkflowRecordPath`）透传扫描 meta，缓存命中时对会话文件 mtime（`scanSessions` 的 `lastModified` = fstat.mtimeMs）核对：变化即旧实例 dispose + 重建（两源齐备，覆盖降级形态迟到升级语义），未变走缓存。职责边界：journal 推送 / entry 拉取通道各有自己的事实喂入链，不透传 meta 即不对账。

对齐 ADR-0097「查询是真理通道：任何查询必须返回当前真值」——缓存命中不是对账豁免；查询通道本就 force 扫描 meta，对账零额外 stat。两向判据有单测锁定（`session-records.test.ts` 的 mtime 失效用例组）：mtime 变 → 重建（次查询可见新事实）；mtime 未变 → 缓存（不重建）。

## 附：登记一项实现事实（非缺陷）

wire `lastRound` 刻意不含 `swept`（`events-projection-last-round.ts` 头注裁决）——swept 附注只经 record 事件帧与 extension 的 list 工具条目可达；任何消费方不得依赖 `getSubagents` 拿到 swept。
