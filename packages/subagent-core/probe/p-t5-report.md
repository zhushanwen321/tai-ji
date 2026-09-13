# P-T5 探针报告：alive marker 心跳写盘频率可接受性（T5②门）

- 日期：2026-09-01
- 单元：u-svc（subagent-core-unbounded-wait-audit，T5②实施前⛔门）
- 设计依据：docs/architecture/crash-forensics-and-watchdog.md 附录 E §7.3 P-T5 / §7.2 T5②
- 结论：**PASS——写盘开销可忽略，T5②按主路径实现心跳（每次 keep-alive 期 agent_end 覆盖写 .alive），不降级软超时。**

## 方法（历史回溯）

扫本机两棵 subagent session 树（`~/.pi/agent/subagents/`、`~/.xyz-agent/pi/agent/subagents/`）全部 session JSONL，以 assistant message 条数作为 agent_end 次数的**保守上界代理**（每次 agent_end 至少对应一条 assistant message；多 turn 单 run 时代理高估），统计条数密度；另在本机实测 `.alive` marker 同规格（56 字节单行 JSON）的 `writeFileSync` 覆盖写耗时（2000 次取均值，page-cache 写、无 fsync，与实装 writeAliveMarker 同形态）。

## 数据

| 指标 | 值 |
|------|-----|
| 扫描 session 数 | 4,747 |
| assistant message 总数（agent_end 上界代理） | 118,646 |
| 总时间跨度 | 2,518.8 小时 |
| 全局密度 | 0.785 条/分钟（≈0.013 次/秒） |
| per-session 密度 P50 | 3.49 条/分钟（≈0.058 次/秒） |
| per-session 密度 P95 | 10.08 条/分钟（≈0.17 次/秒） |
| per-session 密度 max | 134.8 条/分钟（伪影：1 条 message / 0.6s 超短 session） |
| 单次 marker 覆盖写耗时 | 0.0315 ms（56 字节，2000 次均值） |

## 裁决推导

1. 心跳只发生在 **keep-alive 等待窗口**（层主有活跃后代期间），是全部 turn 活动的子集——上表密度本身就是高估。
2. 按 P95 极端外推 10 倍（100 条/分钟 ≈ 1.7 次/秒）：写盘开销 ≈ 1.7 × 0.0315ms ≈ 0.05ms/s，占单核 < 0.01%；即便取 max 伪影值 2.25 次/秒也仅 ≈ 0.07ms/s。
3. marker 覆盖写无 fsync（实装 writeAliveMarker 为 `fs.writeFileSync` 单行 JSON），不产生日志刷盘量级 I/O；文件恒定 56 字节，无空间增长。
4. 换得的收益（设计 PS-7a）：keep-alive 数小时（MF-4 合法形态）的活实例不再因 1h 软超时被异进程孤儿恢复误盖 `.finalized` sidecar。

判定：开销与收益相差 4 个数量级以上，**主路径（心跳）成立**。降级路径（软超时对齐 maxTurnsToWatchdogMs，无新写盘）不启用。

## 复跑

探针脚本为一次性统计（未随仓提交，按本单元领地约定仅报告落盘 `probe/`）。复现方式：对两棵 subagents 目录树统计全部 `*.jsonl` 的 assistant message 密度 + 56 字节文件覆盖写基准，方法与阈值见上。
