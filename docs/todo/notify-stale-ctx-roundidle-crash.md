# A1：轮终收口遇 stale extension ctx 崩溃 runtime 进程（P1，间歇性）

状态：待裁决（2026-09-22 登记，源自 B1/B2 修复真机复验）

## 症状

GUI 派发 subagent，轮终收口时 runtime 进程崩溃（exit 1），当轮 record 丢失、manifest 投影（簿记⑫）未执行；随后 runtime supervisor 重启循环约 6 分钟（liveness probe force-kill half-alive 后恢复）。间歇性：复验 3 轮派发仅第 1 轮触发，run2/3 未复现。

## 根因（已核实的部分）

轮终簿记⑧ `emitPendingUnregister`（`packages/subagent-core/src/execution/persistence/record-store-rounds.ts:207`）→ `packages/subagent-core/src/execution/notify/notify-host.ts` 的 `emitPendingUnregister` 用 `pi?.events.emit("pending:unregister", …)` 发通知。`pi?.` 只挡 null/undefined，不挡「非空但已失效」的 stale 适配器对象——extension ctx 过期后其 `events`（或内部 handler 表）不可用，emit 抛错沿 `markRoundIdle` 调用链未捕获，进程死亡。

未核实：stale extension ctx 的产生机制（适配器何时失效、为何未随重启换新）——修复前需先排查这条。

## 影响面

- 崩溃点在簿记⑧（notify 面），位于 B2 修复新增的簿记⑫（manifest 轮终投影，commit `d4f702e36`）**之前**——崩溃会吞掉当轮 manifest 落盘，但 entry 兜底读链仍可达（session_read 功能不断，走慢路径）。
- 属既有缺陷：簿记⑧是 U4 保留簿记，B1/B2 修复未改变其时序。同族风险：notify-host 的其他 emit 面（register 等）共用同一 `pi?.events.emit` 形态。

## 修复方向（建议，未裁决）

1. 先排查 stale ctx 产生机制（getPi 返回失效对象的来源）。
2. 防御面：notify-host 各 emit 面与簿记⑨（reportRecordTransition，已是 best-effort 定位）对齐——通知/过程面失败不应崩进程（try/catch + 结构化日志留痕），根治仍以第 1 条为准。

## 证据

- 复验产物（含崩溃日志、重启截图）：`.tmp/dev-flow/b1b2-verify/`（`evidence-pi-crash-run1.log`、`evidence-crashes-*.jsonl`、`anomaly-run1-runtime-restarting.png`）
- 台账：`.tmp/dev-flow/session-reader-shared-core.impl-plan.md` 变更历史第 10 笔
